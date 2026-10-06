import type { HostRpcResult } from '../console/rpc.ts';
import type { WorkerSessionSummary, WorkflowSnapshot } from '../contracts.ts';

export interface SessionRecord {
  readonly type: string;
  readonly event: { readonly seq: number; readonly time: number; readonly type: string; readonly data: unknown };
}

interface SessionPageResult {
  readonly records: readonly SessionRecord[];
  readonly hasMore: boolean;
}

export interface SessionChatRpc {
  call(channel: string, endpoint: string, payload: unknown, signal?: AbortSignal): Promise<unknown>;
}

/** 一次读取的结果：**尾部**那一页，外加定位到的游标。 */
interface SessionTranscript {
  readonly records: readonly SessionRecord[];
  /**
   * 会话日志的最后一个 seq；`-1` 表示会话还没有任何事件。
   *
   * 它同时是下一次读取的起点（见 {@link SessionChatClient} 的游标发现说明），
   * 也是「载入更早」的切点来源。
   */
  readonly cursor: number;
  /** 尾部这一页之前是否还有更早的消息。 */
  readonly hasMore: boolean;
}

interface SessionChatClientOptions {
  readonly rpc: SessionChatRpc;
  readonly channel?: string;
  readonly maxMessages?: number;
}

const DEFAULT_MAX_MESSAGES = 50;

/**
 * 倍增探测的上限：2 的这么多次方条事件。
 *
 * 它不是「事件数的上限」，而是**探测次数**的上限——每次探测都是一次 HTTP 往返，
 * 所以必须有界。真实会话远达不到这个量级（一个会话几百条事件已经很长）。
 */
const MAX_GROWTH_PROBES = 24;

/** 单次 `read` 的请求预算；超过即判定探测不收敛，抛错而不是无限打服务端。 */
const MAX_PROBES_PER_READ = 64;

/** 会话读取/投递失败，保留宿主的稳定错误码供调用方分支。 */
class SessionChatError extends Error {
  readonly code: string | null;
  constructor(code: string | null, message: string) {
    super(message);
    this.name = 'SessionChatError';
    this.code = code;
  }
}

/**
 * 会话读取与投递：控制台看见 Agent 在说什么、并向它回话的唯一通道。
 *
 * ── 为什么读取需要「游标发现」──
 *
 * dsh 的 `session/page` 需要一个**含端**切点 `throughSeq`，而服务端有两条硬校验
 * （`dsh-api-session-controller` 的 `history.page`）：
 *
 *   1. `throughSeq` 不得超过日志最后一个 seq，否则 `gateway/bad-request`
 *      （`session page through seq X is past cursor Y`）；
 *   2. `throughSeq >= 0` 时必须是日志里**真实存在**的 seq。
 *
 * 因此「读最新一页」的前提是**先知道尾部游标**，而取得它的正规途径是 `session/follow`
 * ——一个走 WebSocket（`/api/remote.mux`）的流。本插件用的是同一宿主上的普通 JSON RPC
 * 通道（`ctx.connection.rpc.call`），拿不到流，所以这里用**探测**确定尾部。
 *
 * 探测之所以成立：事件 seq 是**稠密零基前缀**（0,1,2,…），于是「≤ 尾部的任意值都可读，
 * 超出即报 past cursor」构成一个单调谓词——先倍增找上界，再二分收敛。
 *
 * 实测（8 条事件的会话）：首次读取 7 次请求；游标已知且**无新事件**时 1 次请求。
 *
 * ── 曾经错在哪里 ──
 *
 * 这里固定传 `throughSeq: -1`。服务端把 `-1` 当作字面值算切点（`min(-1+1, …) = 0`），
 * 于是**每次都返回空页**，界面永远停在「等待 Agent 首条消息…」——而会话里其实已经有内容。
 * 空页与「超出尾部」是两种完全不同的结果，前者不是「没有数据」。
 */
export class SessionChatClient {
  readonly #rpc: SessionChatRpc;
  readonly #channel: string;
  readonly #maxMessages: number;
  /**
   * 已确认的尾部游标（按会话缓存）。
   *
   * 缓存它把「轮询没有新内容」从 O(log n) 次请求降到 **1 次**：先探 `cursor + 1`，
   * 被拒即说明没有新事件。
   */
  readonly #cursors = new Map<string, number>();

  constructor(options: SessionChatClientOptions) {
    this.#rpc = options.rpc;
    this.#channel = options.channel ?? '/api';
    this.#maxMessages = options.maxMessages ?? DEFAULT_MAX_MESSAGES;
  }

  /** 作废某个会话的游标缓存（会话被重建或需要强制重读时用）。 */
  forget(sessionId: string): void {
    this.#cursors.delete(sessionId);
  }

  /**
   * 读**最新一页**。返回尾部页面、尾部游标与「是否还有更早的消息」。
   *
   * 会话没有任何事件时返回空页与 `cursor: -1`（这是「确实是空的」，不是「读失败了」；
   * 读失败一律抛错）。
   */
  async read(sessionId: string, signal = new AbortController().signal): Promise<SessionTranscript> {
    const known = this.#cursors.get(sessionId);
    let budget = MAX_PROBES_PER_READ;

    const probe = async (
      throughSeq: number,
    ): Promise<{ readonly ok: true; readonly page: SessionPageResult } | { readonly ok: false; readonly pastCursor: boolean }> => {
      if (budget <= 0) throw new SessionChatError(null, '会话读取探测未收敛：请求预算已用尽');
      budget -= 1;
      return this.#page(sessionId, throughSeq, signal);
    };

    // ── 起点：已知游标就从一个更高的值开始探，否则从 0（空会话的第一个候选）开始 ──
    let lastGood: { readonly cursor: number; readonly page: SessionPageResult } | null = null;
    let tooHigh: number | null = null;
    let candidate = known === undefined ? 0 : known + 1;

    // 快速路径：已知游标且没有新事件 —— 一次请求就返回。
    if (known !== undefined) {
      const first = await probe(candidate);
      if (first.ok) {
        lastGood = { cursor: candidate, page: first.page };
      } else if (first.pastCursor) {
        // 没有新事件：用缓存游标再读一次尾部页，把内容刷新到最新（内容本身不会变，
        // 但这一步让调用方拿到 records，而不是只有游标）。
        const tail = await probe(known);
        if (!tail.ok) throw new SessionChatError(null, '会话尾部页读取失败：游标已确认存在却被拒');
        return { records: tail.page.records, cursor: known, hasMore: tail.page.hasMore };
      } else {
        throw new SessionChatError(null, '会话读取失败');
      }
      candidate = candidate === 0 ? 1 : candidate * 2;
    }

    // ── 倍增找上界 ──
    for (let i = 0; i < MAX_GROWTH_PROBES && tooHigh === null; i++) {
      const result = await probe(candidate);
      if (result.ok) {
        lastGood = { cursor: candidate, page: result.page };
        candidate = candidate === 0 ? 1 : candidate * 2;
        continue;
      }
      if (result.pastCursor) {
        tooHigh = candidate;
        break;
      }
      throw new SessionChatError(null, '会话读取失败');
    }

    if (lastGood === null) {
      // 连 seq 0 都不存在 —— 空会话。这是确定的事实，不是失败。
      if (tooHigh === 0) return { records: [], cursor: -1, hasMore: false };
      throw new SessionChatError(null, '会话读取探测未收敛：找不到可读的尾部页');
    }

    // ── 二分收敛到真正的尾部 ──
    if (tooHigh !== null) {
      let low = lastGood.cursor;
      let high = tooHigh;
      while (high - low > 1) {
        const mid = Math.floor((low + high) / 2);
        const result = await probe(mid);
        if (result.ok) {
          lastGood = { cursor: mid, page: result.page };
          low = mid;
          continue;
        }
        if (result.pastCursor) {
          high = mid;
          continue;
        }
        throw new SessionChatError(null, '会话读取失败');
      }
    }

    this.#cursors.set(sessionId, lastGood.cursor);
    return { records: lastGood.page.records, cursor: lastGood.cursor, hasMore: lastGood.page.hasMore };
  }

  /**
   * 读更早的一页（时间轴向上翻）。
   *
   * `beforeSeq` 取当前窗口的首条 seq——它是**排他**切点，与 `session/page` 的语义一致。
   */
  async loadOlder(
    sessionId: string,
    beforeSeq: number,
    signal = new AbortController().signal,
  ): Promise<{ readonly records: readonly SessionRecord[]; readonly hasMore: boolean }> {
    const cursor = this.#cursors.get(sessionId);
    if (cursor === undefined) {
      // 没有游标就没有合法的 `throughSeq`：先做一次尾部读取把它发现出来。
      await this.read(sessionId, signal);
    }
    const throughSeq = this.#cursors.get(sessionId);
    if (throughSeq === undefined || throughSeq < 0) return { records: [], hasMore: false };
    const page = await this.#page(sessionId, throughSeq, signal, beforeSeq);
    if (!page.ok) throw new SessionChatError(null, '更早的消息读取失败');
    return { records: page.page.records, hasMore: page.page.hasMore };
  }

  /**
   * 向会话投递一条人类消息。
   *
   * `mode: 'queue'` 排入独立回合，`'steer'` 在下个步骤边界送达（§6.7 插话用后者）。
   */
  async send(
    sessionId: string,
    text: string,
    mode: 'queue' | 'steer' = 'queue',
    signal = new AbortController().signal,
  ): Promise<unknown> {
    const content = text.trim();
    if (content.length === 0) throw new Error('消息不能为空');
    const value = unwrap<unknown>(
      await this.#rpc.call(
        this.#channel,
        'session/prompt',
        {
          args: {
            request: {
              sessionId,
              requestId: `pentest-request-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
              mode,
              content: [{ type: 'text', text: content }],
            },
          },
        },
        signal,
      ),
    );
    return value;
  }

  /** 一次 `session/page`：把「超出尾部」这一种拒绝与其它失败分开。 */
  async #page(
    sessionId: string,
    throughSeq: number,
    signal: AbortSignal,
    beforeSeq?: number,
  ): Promise<{ readonly ok: true; readonly page: SessionPageResult } | { readonly ok: false; readonly pastCursor: boolean }> {
    try {
      const page = unwrap<SessionPageResult>(
        await this.#rpc.call(
          this.#channel,
          'session/page',
          {
            args: {
              request: {
                address: { kind: 'session', sessionId },
                throughSeq,
                ...(beforeSeq === undefined ? {} : { beforeSeq }),
                maxMessages: this.#maxMessages,
              },
            },
          },
          signal,
        ),
      );
      return {
        ok: true,
        page: {
          records: Array.isArray(page?.records) ? page.records : [],
          hasMore: page?.hasMore === true,
        },
      };
    } catch (cause) {
      // 「超出尾部」是**探测信号**，不是故障。判据同时要求稳定错误码与那句固定的
      // 措辞：只看码会把「地址不合法」这类真实故障误判成「读到了空会话」。
      if (cause instanceof SessionChatError && cause.code === 'gateway/bad-request' && /past cursor/.test(cause.message)) {
        return { ok: false, pastCursor: true };
      }
      throw cause;
    }
  }
}

/**
 * 解一层宿主 RPC 结果。
 *
 * 这里**不写内联类型断言**：`value` 是跨进程来的外部输入，断言的字段不存在时读出来
 * 是 `undefined`，而那个 `undefined` 会一路流到渲染层。逐层 `in` / `typeof` 收窄，
 * 读到的东西都经过检查。
 */
function unwrap<T>(value: unknown): T {
  if (isHostRpcResult(value)) {
    if (value.ok) return value.value as T;
    throw new SessionChatError(value.error.code, value.error.message);
  }
  // 宿主已解包 `value` 的形态（与 `ConsoleClient` 的宽容处理一致）。
  if (value !== null && typeof value === 'object' && 'ok' in value && value.ok === true && 'value' in value) {
    return value.value as T;
  }
  return value as T;
}

function isHostRpcResult(value: unknown): value is HostRpcResult {
  if (value === null || typeof value !== 'object' || !('ok' in value)) return false;
  if (value.ok === true) return 'value' in value;
  if (value.ok !== false || !('error' in value)) return false;
  const error = value.error;
  return error !== null && typeof error === 'object' && 'message' in error;
}

// ───────────────────────────── 事件 → 人类可读的消息 ─────────────────────────────

/** 一条要在授权会话里显示的消息。 */
interface TranscriptMessage {
  /** 稳定键：`seq` + 组内下标（一条事件可能携带多条消息）。 */
  readonly key: string;
  readonly seq: number;
  readonly role: 'human' | 'agent' | 'system' | 'tool';
  /** 显示用的来源标签（「你」/「插件转投」/「系统」/工具名）。 */
  readonly label: string;
  readonly text: string;
}

interface TranscriptProjection {
  readonly messages: readonly TranscriptMessage[];
  /**
   * 被折叠的**运行事件**条数（preset/sandbox/policy/turn/step 这类）。
   *
   * 显示它是为了让「只有运行事件、还没有 Agent 回复」与「什么都没有」可区分——
   * 前者说明会话在跑，后者说明投递没到。把两者都渲染成空白会让人以为界面坏了。
   */
  readonly hiddenEvents: number;
}

/**
 * 去掉文本里的**控制序列**：CSI（`ESC [ … m`）、其它 ESC 序列、以及**丢了 ESC 的裸坐标标记**
 * （宿主把它自己的内联进度/锚点标记写进了消息文本，实测人类复制出来的是
 * `…的话。所以我会用 [13;28;13;1;0;1_[13;28;13;0;0;1_http://…` 这种）。
 *
 * 只剥控制序列，不动正文；C0 里除 `\n`/`\t` 之外一律删（`\x07` 响铃、`\x08` 退格
 * 会在 `pre` 里变成可见垃圾）。裸标记的模式要求 ≥2 段分号分隔的数字（或经典 SGR 结尾），
 * 以免误伤 `[1]`、`[2026-10-04]`、`[note]` 这类正常写法。
 */
export function stripControlSequences(text: string): string {
  return text
    // CSI：ESC [ 参数字节 中间字节 最终字节（0x40–0x7E）
    .replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, '')
    // 其它 ESC 序列（APC/OSC/DCS/PM/SOS 以 ST 结束，以及两字节 ESC x）
    .replace(/\u001b(?:[PX^_][^\u001b]*\u001b\\|[ -/]*[@-~])/g, '')
    // 丢了 ESC 的裸坐标标记：`13;28;13;1;0;1_`——**要求 ≥2 个分号且后面跟字母/下划线**，
    // 这样 `[1;2]`（正常的编号/区间写法）不会被吃掉尾巴。
    .replace(/\[(?:\d+;){2,}\d*[_A-Za-z]/g, '')
    // 经典 SGR 形状：`[31;1m` / `[0m`
    .replace(/\[\d+(?:;\d+)*m/g, '')
    // 其余 C0 控制字符（保留换行与制表）
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '');
}

/**
 * 把原始会话事件投影成人类能读的对话。
 *
 * 投影规则（依据实测的线上事件形状）：
 *   - `agent/inbox/spliced`：`data.inserted[]` 是**投递给 Agent 的消息**——
 *     人类在控制台写的、以及插件转投的任务简报都在这里；
 *   - `assistant/message`：`data.message.content[]` 的 text 块是 Agent 的回复，
 *     tool-call 块折成一行（工具名），reasoning 不进正文；
 *   - `system/message`：系统提示词，**只留一行标记**——它每次都有几 KB，
 *     原样铺开会把真正的对话挤出屏幕；
 *   - `turn/end`：只在带 `aborted` / `error` 时显示（正常结束不需要一条噪声）；
 *   - 其余（preset / sandbox / policy / turn/start / step/start …）计入 `hiddenEvents`。
 */
export function projectTranscript(records: readonly SessionRecord[]): TranscriptProjection {
  const messages: TranscriptMessage[] = [];
  let hiddenEvents = 0;

  for (const record of records) {
    const seq = record.event.seq;
    const data = asRecord(record.event.data);
    switch (record.event.type) {
      case 'agent/inbox/spliced': {
        const rawInserted = data?.['inserted'];
        const inserted: readonly unknown[] = Array.isArray(rawInserted) ? rawInserted : [];
        let showed = false;
        inserted.forEach((raw, index) => {
          const message = asRecord(raw);
          if (message === undefined) return;
          const role = message['role'] === 'user' ? 'human' : 'system';
          const source = asRecord(message['source']);
          messages.push({
            key: `${seq}:${index}`,
            seq,
            role,
            label: role === 'human'
              ? (source?.['kind'] === 'plugin' ? `插件转投 · ${String(source['plugin'] ?? '未知')}` : '你')
              : `系统 · ${String(role)}`,
            text: blocksToText(message['content']).text,
          });
          showed = true;
        });
        if (!showed) hiddenEvents += 1;
        break;
      }
      case 'user/message': {
        const message = asRecord(data?.['message']) ?? data;
        messages.push({ key: `${seq}`, seq, role: 'human', label: '你', text: blocksToText(message?.['content']).text });
        break;
      }
      case 'assistant/message': {
        const message = asRecord(data?.['message']) ?? data;
        const blocks = blocksToText(message?.['content']);
        const parts: string[] = [];
        if (blocks.text !== '') parts.push(blocks.text);
        for (const tool of blocks.tools) parts.push(`〔调用工具 ${tool}〕`);
        messages.push({
          key: `${seq}`,
          seq,
          role: 'agent',
          label: 'Agent',
          text: parts.join('\n'),
        });
        break;
      }
      case 'system/message': {
        const message = asRecord(data?.['message']);
        const text = blocksToText(message?.['content']).text;
        messages.push({
          key: `${seq}`,
          seq,
          role: 'system',
          label: '系统提示词',
          text: text === '' ? '无内容' : `已注入 ${formatChars(text.length)} · 此处折叠，完整内容见会话事件`,
        });
        break;
      }
      case 'turn/end': {
        const aborted = asRecord(data?.['aborted']);
        const error = data?.['error'];
        if (aborted === undefined && error === undefined) {
          hiddenEvents += 1;
          break;
        }
        const detail = aborted !== undefined
          ? `回合被中止：${typeof aborted['reason'] === 'string' ? aborted['reason'] : '未给理由'}`
          : `回合失败：${typeof error === 'string' ? error : JSON.stringify(error)}`;
        messages.push({ key: `${seq}`, seq, role: 'system', label: '回合结束', text: detail });
        break;
      }
      default:
        hiddenEvents += 1;
        break;
    }
  }

  return { messages, hiddenEvents };
}

// ───────────────────────────── 事件 → Agent 轨迹（只读视图） ─────────────────────────────

/**
 * 轨迹行：**工具调用、结果、思考、回复**都保留。
 *
 * 与 {@link projectTranscript} 的分工不同：那个投影服务「授权对话」，会把运行事件折叠掉
 * （人类此时关心的是「Agent 问我什么」）；这个投影服务「看 Agent 到底在干什么」——
 * 思维链与工具调用正是主体，折叠掉就什么都没了。
 */
export interface TraceRow {
  readonly key: string;
  readonly seq: number;
  readonly kind: 'thinking' | 'reply' | 'tool-call' | 'tool-result' | 'note';
  readonly label: string;
  readonly text: string;
}

/**
 * 单条轨迹文本的展示上限。
 *
 * 实测：工具结果动辄几 KB，几十条铺开会让面板本身变得很重（截图/重绘都变慢）。
 * 展示层只留这么长——**完整内容仍在会话事件里**，轨迹栏的职责是「看它在做什么」，
 * 不是「替代日志」。
 */
const TRACE_TEXT_LIMIT = 600;

export function traceTranscript(records: readonly SessionRecord[]): readonly TraceRow[] {
  const rows: TraceRow[] = [];
  const push = (row: Omit<TraceRow, 'text'> & { readonly text: string }): void => {
    rows.push({ ...row, text: clip(row.text) });
  };

  for (const record of records) {
    const seq = record.event.seq;
    const data = asRecord(record.event.data);
    switch (record.event.type) {
      case 'assistant/message': {
        const message = asRecord(data?.['message']) ?? data;
        const content = message?.['content'];
        if (!Array.isArray(content)) break;
        content.forEach((raw, index) => {
          const block = asRecord(raw);
          if (block === undefined) return;
          const type = block['type'];
          if (type === 'reasoning' && typeof block['text'] === 'string') {
            push({ key: `${seq}:r${index}`, seq, kind: 'thinking', label: '思考', text: block['text'] });
            return;
          }
          if (type === 'text' && typeof block['text'] === 'string') {
            push({ key: `${seq}:t${index}`, seq, kind: 'reply', label: 'Agent', text: block['text'] });
            return;
          }
          // 助手消息里的 `tool-call` 块**不再单独成行**：同一调用在事件流里还有一条
          // `tool/call`（带完整参数），两条都画会让「工具 58」这类计数直接翻倍。
          // 这里只取 reasoning 与 text —— 调用与结果由事件驱动的那两条负责。
        });
        break;
      }
      case 'tool/call': {
        const name = typeof data?.['name'] === 'string' ? data['name'] : '未命名工具';
        push({ key: `${seq}`, seq, kind: 'tool-call', label: `调用 ${name}`, text: stringifyArgs(data?.['arguments']) });
        break;
      }
      case 'tool/result': {
        const message = asRecord(data?.['message']);
        const blocks = message?.['content'];
        const first = Array.isArray(blocks) ? asRecord(blocks[0]) : undefined;
        const inner = first?.['content'];
        const textBlock = Array.isArray(inner) ? asRecord(inner[0]) : undefined;
        const text = typeof textBlock?.['text'] === 'string' ? textBlock['text'] : '';
        push({
          key: `${seq}`,
          seq,
          kind: 'tool-result',
          label: first?.['isError'] === true ? '工具失败' : '工具结果',
          text,
        });
        break;
      }
      case 'turn/end': {
        const error = data?.['error'];
        if (error === undefined) break;
        push({
          key: `${seq}`,
          seq,
          kind: 'note',
          label: '回合结束',
          text: typeof error === 'string' ? error : JSON.stringify(error),
        });
        break;
      }
      default:
        break;
    }
  }
  return rows;
}

/** 参数是 JSON 字符串（线上形状）或对象；两种都读得懂，读不懂就原样给。 */
function stringifyArgs(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value === undefined) return '';
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/**
 * 截断超长正文。
 *
 * **先剥控制序列再截断**：`traceTranscript` 是会话文本的**第二条出口**（思维链、工具结果、
 * 回合错误），宿主写进正文的裸坐标标记会在这里照旧显示；先剥后截也避免截断把一条序列切成
 * 半条（半条上正则匹配不到，反而留在正文里）。
 */
function clip(text: string): string {
  const clean = stripControlSequences(text);
  return clean.length <= TRACE_TEXT_LIMIT ? clean : `${clean.slice(0, TRACE_TEXT_LIMIT)}\n…已截断，完整内容见会话事件`;
}

/**
 * 「当前该看哪个 Worker 会话」：以**活动指针**为准，指针缺失时退回最新的未结束会话。
 *
 * 为什么要有兜底：换阶段/重试时指针会移动，而面板每 10 秒才读一次状态——指针短暂为空时
 * 面板不该整块消失（那会让人类以为 Agent 停了）。
 */
export function activeWorkerSessionOf(snapshot: {
  readonly state: WorkflowSnapshot | null;
  readonly sessions: readonly WorkerSessionSummary[];
}): WorkerSessionSummary | null {
  const pointer = snapshot.state?.activeWorkerSessionId ?? null;
  if (pointer !== null) {
    const found = snapshot.sessions.find((session) => session.id === pointer);
    if (found !== undefined) return found;
  }
  const live = snapshot.sessions.filter(
    (session) => session.status !== 'closed' && session.status !== 'failed' && session.status !== 'superseded',
  );
  if (live.length === 0) return null;
  return [...live].sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))[0] ?? null;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

/**
 * 取内容块里的文本与工具名；未知块类型忽略（不猜、不原样倾倒 JSON）。
 *
 * 出口统一过一次 {@link stripControlSequences}：宿主会把内联进度/锚点标记写进消息文本，
 * 直接渲染/复制就是人类看到的那串 `[13;28;13;1;0;1_` 垃圾。
 */
function blocksToText(content: unknown): { readonly text: string; readonly tools: readonly string[] } {
  if (!Array.isArray(content)) {
    return { text: typeof content === 'string' ? stripControlSequences(content) : '', tools: [] };
  }
  const texts: string[] = [];
  const tools: string[] = [];
  for (const raw of content) {
    const block = asRecord(raw);
    if (block === undefined) {
      if (typeof raw === 'string') texts.push(stripControlSequences(raw));
      continue;
    }
    if (block['type'] === 'text' && typeof block['text'] === 'string') {
      texts.push(stripControlSequences(block['text']));
      continue;
    }
    if (block['type'] === 'tool-call') {
      tools.push(typeof block['name'] === 'string' ? block['name'] : '未命名工具');
    }
  }
  return { text: texts.join('\n').trim(), tools };
}

function formatChars(count: number): string {
  return count >= 1000 ? `${(count / 1000).toFixed(1)}k 字符` : `${String(count)} 字符`;
}
