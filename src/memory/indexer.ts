/**
 * Streaming RAG 索引器：把事件账本增量投影为可分块、可嵌入、可检索的索引。
 *
 * 设计依据：docs/dsh-pentest-plugin-design.md §8.4（Streaming RAG 管线）、
 * §8.5（分块策略）、§9.1（嵌入版本）、§15.5（索引滞后）
 *
 * ── 位置与职责 ──
 *
 * 它是**账本的下游**：只读 `context_events`，只写 `memory_chunks` 与
 * `index_watermarks`。原始账本永远是唯一事实源，索引是可丢弃、可重建的派生数据
 * （§8.4「索引失败不影响原始账本」）。因此本模块的失败语义是「标记滞后」，
 * 绝不是「阻断写入」。
 *
 * ── 四条实现纪律 ──
 *
 * 1. **幂等**。分块标识由（来源事件、序号、嵌入版本）确定性派生，重跑不产生
 *    重复分块（`ON CONFLICT ... DO NOTHING`）。索引器崩溃后重扫是安全的。
 *
 * 2. **非暂定分块必须有嵌入版本**。这是 DDL 级约束
 *    （`CHECK (provisional OR embedding_revision IS NOT NULL)`）。`indexable=false`
 *    的分块（流量、二进制）也要有版本——它们只置版本、向量与全文索引留空，
 *    保留在库里供溯源但不参与检索（§8.5）。
 *
 * 3. **暂定分块不进索引**。流式未结算的片段（`provisional=true`）以最小行落库，
 *    不带向量、不带全文索引、不带版本；结算块产出后把它们标记为
 *    `superseded_by_revision`。这样「同一段回答」不会以多份帧分块加一份结算分块
 *    同时出现在召回里。
 *
 * 4. **嵌入失败即抛**。不返回零向量、不静默跳过。零向量会污染检索结果
 *    （与任何内容都"相似"）且极难发现；索引滞后是可观测的，静默降级不是。
 *
 * 5. **归属与阶段在写入侧解析，解析不出就拒绝**。账本事件不带阶段（阶段是会话属性，
 *    §5.1），也不带资产归属，两者都在这里补齐：阶段来自 `worker_sessions` 的 join，
 *    资产由事件里**明确出现**的目标线索等值匹配 `pentest.assets` 得到（§8.6）。
 *    空 `asset_ids` 在 §8.6 的可见性公式里是**放行**的，所以「不填资产」等于绕过
 *    范围过滤；写入侧义务校验（`checkChunkBatchWritable`）拒绝「事件明确含目标、
 *    却没有任何已登记资产」的分块，让坏事件成为可见的失败而不是静默的无归属索引。
 */

import { isPhase } from '../contracts.ts';
import type {
  Classification,
  ErrorCode,
  Phase,
  TrustLevel,
} from '../contracts.ts';
import type { DbClient } from '../db/port.ts';
import { checkChunkBatchWritable, planChunks } from './chunks.ts';
import type { ChunkDraft, ChunkSourceEvent, ChunkingOptions } from './chunks.ts';
import type { EmbeddingDescriptor, EmbeddingProvider } from './embedding.ts';
import { assertDimensions, MEMORY_EMBEDDING_DIMENSIONS } from './embedding.ts';

/**
 * `memory_chunks.embedding` 的固定维度（DDL 是 `vector(1024)`）。
 *
 * 这是 `embedding.ts` 常量的**再导出**，不是第二份定义——维度只能有一个来源，
 * 否则「哪份是权威」会在迁移向量列时变成真实分歧。
 */
export { MEMORY_EMBEDDING_DIMENSIONS as CHUNK_VECTOR_DIMENSIONS } from './embedding.ts';

/** 索引策略版本。分块方式或脱敏规则变更时应递增，并在水位里区分。 */
export const INDEX_STRATEGY_VERSION = 'index-v1';

/**
 * 索引器错误码。
 *
 * `target_not_adjudicated` 是契约里的稳定码（§8.6 写入侧义务）：它的处置不是
 * 「等基础设施恢复」而是「去登记资产」，因此必须与网络/嵌入故障区分开。
 * `invalid_session_phase` 是索引器自身的完整性故障（见 {@link toPhase}）。
 * `embedding_revision_inactive` 见 {@link MemoryIndexer} 的版本登记：写出检索面
 * 看不见的分块等于静默丢失，必须响亮拒绝。
 */
type IndexerErrorCode = ErrorCode | 'invalid_session_phase' | 'embedding_revision_inactive';

/**
 * 索引器故障：携带稳定码，供调度器与观测分支，而不是靠解析文本。
 *
 * 与 `EmbeddingError` / `OutboxError` 同形；消息里带上错误码文本，因为
 * `index_watermarks.last_error` 与死信只留字符串，码丢了就只剩人读的描述。
 */
export class IndexerError extends Error {
  readonly code: IndexerErrorCode;
  readonly detail: string;

  constructor(code: IndexerErrorCode, message: string, detail = '') {
    super(detail === '' ? message : `${message}；${detail}`);
    this.name = 'IndexerError';
    this.code = code;
    this.detail = detail;
  }
}

interface IndexerDeps {
  /** 读路径与单语句写。 */
  readonly db: DbClient;
  /** 事务用途（版本切换、水位推进）。省略则用 `db`——但连接池下事务会静默失效。 */
  readonly txDb?: DbClient;
  /** 嵌入提供方。省略则**只做词法索引**（不写向量），并在结果里标明。 */
  readonly embeddings?: EmbeddingProvider;
  /**
   * 嵌入版本登记（§9.1）。首次索引某个版本时登记它，使检索侧的「只取生效版本」
   * 过滤真正生效；不接时那道过滤是空转（没有活跃版本 → 不过滤），跨版本混比防护不存在。
   *
   * 必须回报 `isActive`：生效版本决定检索面读哪些分块，因此「本次要写的这个版本
   * 是不是生效版本」是索引能不能落库的前提（见 {@link #registerRevision}）。
   */
  readonly ensureEmbeddingRevision?: (
    engagementId: string,
    descriptor: EmbeddingDescriptor,
  ) => Promise<{ readonly isActive: boolean }>;
  readonly chunking?: ChunkingOptions;
  /**
   * 检索文本投影（§8.6「中文内容在应用层做分词与双字词投影，不把特定扩展
   * 作为部署前提」）。省略即用原文。
   */
  readonly projectForSearch?: (content: string) => string;
  readonly clock?: () => Date;
}

/** 单次索引的结果。 */
export interface IndexEventResult {
  readonly inserted: number;
  readonly skipped: number;
  readonly supersededProvisional: number;
  /** 因 `indexable=false` 只落元数据的分块数。 */
  readonly metadataOnly: number;
  /** 真表示本次没写向量（未配嵌入提供方）。 */
  readonly lexicalOnly: boolean;
}

interface IndexRunResult {
  readonly engagementId: string;
  readonly fromChainSeq: number;
  readonly toChainSeq: number;
  readonly eventsProcessed: number;
  readonly chunksInserted: number;
  readonly status: 'ready' | 'lagging' | 'failed';
  /** 状态非 ready 时的原因，供控制台展示（§15.5）。 */
  readonly detail: string | null;
}

interface EventRow {
  readonly event_id: string;
  readonly worker_session_id: string | null;
  readonly event_type: string;
  readonly chain_seq: number | string;
  readonly occurred_at: string;
  readonly provisional: boolean;
  readonly classification: Classification;
  readonly trust_level: TrustLevel;
  readonly payload_json: unknown;
  readonly text_projection: string | null;
  /**
   * 会话阶段，由 `left join pentest.worker_sessions` 得到。
   *
   * 账本事件本身不带阶段（§5.1：阶段是会话属性），所以它只能从会话读；
   * `worker_session_id` 为空（人类输入、系统事件）时这一列就是 null。
   */
  readonly session_phase: string | null;
}

interface WatermarkRow {
  /** pg 的 `bigint` 以字符串返回（超出 JS 安全整数范围时不能丢精度）。 */
  readonly last_chain_seq: number | string;
  readonly strategy_version: string;
}

/** 把 pg 的 bigint 列转成 number 并校验范围。 */
function toSafeSeq(value: number | string | null | undefined, what: string): number {
  if (value === null || value === undefined) return 0;
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n) || !Number.isSafeInteger(n) || n < 0) {
    throw new Error(`${what} 不是合法的链序号：${String(value)}`);
  }
  return n;
}

/**
 * 把浮点数组序列化为 pgvector 字面量 `[a,b,c]`。
 *
 * pgvector 不接受 JS 数组作为参数——必须传字符串形式的向量字面量。
 * 这里逐项校验有限性：`NaN` / `Infinity` 写进去会让该行永远无法被检索到，
 * 且不会报错（pgvector 接受它们），因此必须在这里拦住。
 */
export function toVectorLiteral(embedding: readonly number[]): string {
  const parts: string[] = [];
  for (const v of embedding) {
    if (!Number.isFinite(v)) {
      throw new Error(
        `嵌入含非有限值（${String(v)}）：写入后该分块将永远无法被检索，且不报错。拒绝写入。`,
      );
    }
    parts.push(String(v));
  }
  return `[${parts.join(',')}]`;
}

/** 判断某个分块是否产出暂定行（流式未结算）。 */
export function isProvisionalChunk(draft: ChunkDraft): boolean {
  return draft.provisional;
}

// ─────────────────── 目标线索提取与阶段收窄（§8.6 写入侧） ───────────────────

/**
 * 结构化目标字段。**只读工具负载里声明为字段的目标，不读正文**
 * （`stdout` / `stderr` / `bodySummary` / 报告各段落都是内容，不是目标）：
 * 从报告正文里挖 URL 会把文档链接、CVE 链接、上游仓库地址变成"目标"，
 * 让每个报告分段都带着一堆错归属——进而在那些资产被排除时被连带屏蔽。
 */
const TARGET_VALUE_FIELDS = ['target', 'url'] as const;

/**
 * 命令里被**显式标注**为目标参数的开关。
 *
 * 只收无歧义的形式：长名（`--target` / `--host` / `--url`）自带语义，
 * `-u` 在主流 Web 工具（curl / sqlmap / gobuster）里固定是 URL。
 * `-t` 故意不收——它在 sqlmap 等工具里是线程数，收进来只会制造噪声线索。
 */
const TARGET_FLAGS = ['--target', '--targets', '--host', '--hosts', '--url', '--urls', '-u'] as const;

/** 带 scheme 的 URL 串（`http://x/y`、`ldap://x`）。 */
const SCHEME_URL = /^[a-z][a-z0-9+.-]*:\/\/\S+$/iu;
/** IPv4，可选 CIDR 前缀。 */
const IPV4_CIDR = /^(\d{1,3}(?:\.\d{1,3}){3})(?:\/(\d{1,2}))?$/u;
/** IPv6（可带方括号与 CIDR 前缀；方括号可省略）。 */
const IPV6_CIDR = /^\[?([0-9a-f]{0,4}(?::[0-9a-f]{0,4}){2,})\]?(?:\/(\d{1,3}))?$/iu;
/**
 * 域名形态。只在**已经确认这是目标**的上下文里使用（URL 的主机、显式开关的值），
 * 绝不用于命令的裸 token——`report.txt` 与 `victim.com` 在那里完全同形。
 */
const DOMAIN = /^(?:\*\.)?(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/iu;

/** 读对象负载的一个字段；非对象（字符串、数组、null）一律当空负载。 */
function readField(payload: unknown, key: string): unknown {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) return undefined;
  return Reflect.get(payload, key);
}

/**
 * 去掉命令行里常见的包裹与尾随标点：`<http://x/y>,` → `http://x/y`。
 *
 * 不去方括号——`[::1]:443` 里的方括号是 IPv6 地址的一部分，剥掉就解析不出来了。
 */
function trimToken(token: string): string {
  return token
    .trim()
    .replace(/^["'`(<]+/u, '')
    .replace(/["'`)>.,;]+$/u, '');
}

/** IP（含 CIDR 前缀）字面量：结构上不可能是文件名、路径或正文片段。 */
function isAddressLiteral(token: string): boolean {
  const v4 = IPV4_CIDR.exec(token);
  if (v4 !== null) {
    const octets = v4[1]!.split('.').map((part) => Number(part));
    if (octets.some((octet) => octet > 255)) return false;
    return v4[2] === undefined || Number(v4[2]) <= 32;
  }
  const v6 = IPV6_CIDR.exec(token);
  if (v6 === null) return false;
  const body = v6[1]!;
  // 必须出现 `::` 压缩或凑满 8 组，否则 `1:2:3` 这类端口/版本串会被当成地址。
  if (!body.includes('::') && body.split(':').length < 8) return false;
  return v6[2] === undefined || Number(v6[2]) <= 128;
}

/**
 * 一个目标值 → 候选线索。
 *
 * 除值本身外还确定性地拆出主机部分：资产按 `(engagement_id, canonical_target, kind)`
 * 登记，同一目标可能以 `10.0.0.5`（ip）与 `10.0.0.5:443`（service）两种形态各占一行，
 * 多给一种形态只是多一次等值匹配。**不做模糊匹配、不自动创建资产**——猜错归属会把
 * 内容带进或带出范围过滤，那比解析不到严重得多。
 */
function expandTargetValue(value: string): readonly string[] {
  const token = trimToken(value);
  if (token.length === 0) return [];
  if (SCHEME_URL.test(token)) {
    const out = [token];
    try {
      const url = new URL(token);
      if (url.host.length > 0) out.push(url.host.toLowerCase());
      if (url.hostname.length > 0) out.push(url.hostname.toLowerCase());
    } catch {
      // 不可解析的 `scheme://` 串：保留原样，不猜主机（猜比不解更糟）。
    }
    return out;
  }
  const colon = token.lastIndexOf(':');
  if (colon > 0 && /^\d{1,5}$/u.test(token.slice(colon + 1))) {
    const host = token.slice(0, colon);
    if (isAddressLiteral(host) || DOMAIN.test(host)) return [token, host];
  }
  return [token];
}

/** 命令行的目标线索：只认 URL、IP/CIDR 字面量与显式目标开关的值。 */
function commandTargetHints(command: string): readonly string[] {
  const tokens = command
    .split(/\s+/u)
    .map(trimToken)
    .filter((token) => token.length > 0);
  const out: string[] = [];
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i]!;
    if (SCHEME_URL.test(token) || isAddressLiteral(token)) {
      out.push(...expandTargetValue(token));
      continue;
    }
    const lower = token.toLowerCase();
    const inline = TARGET_FLAGS.find((flag) => lower.startsWith(`${flag}=`));
    if (inline !== undefined) {
      out.push(...expandTargetValue(token.slice(inline.length + 1)));
      continue;
    }
    if ((TARGET_FLAGS as readonly string[]).includes(lower)) {
      const next = tokens[i + 1];
      if (next !== undefined && !next.startsWith('-')) out.push(...expandTargetValue(next));
    }
  }
  return out;
}

/** 保序去重。 */
function dedupe(values: readonly string[]): readonly string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    if (value.length === 0 || seen.has(value)) continue;
    seen.add(value);
    out.push(value);
  }
  return out;
}

/**
 * 从来源事件的结构化字段提取目标线索（§8.6「来源事件里**明确出现**的目标」）。
 *
 * 三条规矩，每条都是为了不产生误报：
 *
 * 1. **只读字段，不从正文里挖**。`stdout`、`bodySummary`、报告段落里的 URL 是内容：
 *    文档链接、CVE 链接、上游仓库都会变成"目标"，接着触发下面的写入侧义务校验，
 *    把正常报告变成死信。
 * 2. **命令里只认结构上确定的目标**：`scheme://` URL、IP/CIDR 字面量、显式目标开关
 *    的值。裸主机名不收——`report.txt` 与 `victim.com` 在命令行里同形，收进来会让
 *    「本来没有任何目标」的命令（`cat report.txt`）也失败。工具运行的目标本来就该写在
 *    `payload.target`（§8.5 的工具输出分组也渲染它）。
 * 3. **线索只用于校验，不参与内容生成**。多一条线索只在**全部**线索都解析不到已登记
 *    资产时才会让索引失败（见 `checkChunkAssetObligation`），因此宁可多提一点。
 *
 * 这里只回答「事件里明确提到了什么」；「提到的是不是本 engagement 的资产」
 * 由索引器查 `pentest.assets` 回答，且**只认已登记资产，绝不自动创建**。
 */
export function extractTargetHints(payload: unknown): readonly string[] {
  const hints: string[] = [];
  for (const field of TARGET_VALUE_FIELDS) {
    const value = readField(payload, field);
    if (typeof value === 'string') hints.push(...expandTargetValue(value));
  }
  const httpUrl = readField(readField(payload, 'http'), 'url');
  if (typeof httpUrl === 'string') hints.push(...expandTargetValue(httpUrl));
  const command = readField(payload, 'command');
  if (typeof command === 'string') hints.push(...commandTargetHints(command));
  return dedupe(hints);
}

/**
 * 会话阶段 → 分块阶段（§2.1：阶段、Agent、会话是同一枚标识的三种视角）。
 *
 * 账本事件不带阶段（§5.1：阶段是会话属性），所以只能从 join 到的会话取；
 * `worker_session_id` 为空（人类输入、系统事件）时**就是 null**，不猜、不继承上下文。
 *
 * `worker_sessions.phase` 上有 CHECK 约束限定五阶段取值，所以非空值必然是合法阶段。
 * 若将来 DDL 放宽而 `PHASES` 没有同步，抛错而不是写入脏阶段：阶段过滤只做等值匹配
 * （§8.6），脏值会让这些分块在「按阶段检索」里静默消失。
 */
function toPhase(value: string | null, eventId: string): Phase | null {
  if (value === null) return null;
  if (!isPhase(value)) {
    throw new IndexerError(
      'invalid_session_phase',
      `事件 ${eventId} 的会话阶段不在 PHASES 内：${value}`,
      '阶段是 §8.6 的过滤维度，写入未知值会让该分块按阶段检索不到；' +
        '请同步 contracts.ts 的 PHASES 与 worker_sessions.phase 的 CHECK 约束',
    );
  }
  return value;
}

/**
 * 一条待落库的分块（`indexEvent` 的中间产物）。
 *
 * 与 `ChunkDraft` 分开是刻意的：草稿描述「内容长什么样」，本形状描述「这一行
 * 将以什么索引身份落库」（版本、模型、向量、全文投影都已定值）。
 */
interface ChunkInsert {
  readonly engagementId: string;
  readonly draft: ChunkDraft;
  readonly revision: string | null;
  readonly model: string | null;
  readonly embedding: readonly number[] | null;
  readonly searchText: string | null;
}

export class MemoryIndexer {
  readonly #db: DbClient;
  readonly #txDb: DbClient;
  readonly #embeddings: EmbeddingProvider | undefined;
  readonly #ensureEmbeddingRevision: IndexerDeps['ensureEmbeddingRevision'];
  /** 每个 engagement 只登记一次；登记本身幂等，这里只为省掉每事件的重复查询。 */
  readonly #registeredRevisions = new Set<string>();
  readonly #chunking: ChunkingOptions;
  readonly #project: (content: string) => string;
  readonly #clock: () => Date;

  constructor(deps: IndexerDeps) {
    this.#db = deps.db;
    this.#txDb = deps.txDb ?? deps.db;
    this.#embeddings = deps.embeddings;
    this.#ensureEmbeddingRevision = deps.ensureEmbeddingRevision;
    this.#chunking = deps.chunking ?? {};
    this.#project = deps.projectForSearch ?? ((c) => c);
    this.#clock = deps.clock ?? (() => new Date());
  }

  /**
   * 当前嵌入版本标识。
   *
   * 未配嵌入提供方时返回 `null`，此时**只做词法索引**：分块仍有版本号
   * （满足 DDL 的 CHECK），但向量与全文索引按 `indexable` 决定。
   * 用 `lexical-only` 这个固定值而不是 UUID，便于事后识别「这批分块没向量」。
   */
  #revision(): string {
    return this.#embeddings === undefined ? 'lexical-only' : this.#embeddings.revision;
  }

  /**
   * 首次索引某个嵌入版本时登记它（§9.1）。
   *
   * 不登记时检索侧的「只取活跃版本」过滤是空转的（没有活跃行就不加过滤），
   * 跨版本混比防护从未生效（事故 2026-10-05：登记器生产零调用）。
   * 每个 engagement 只在进程内登记一次；登记器本身也是幂等的。
   *
   * **非生效版本必须拒绝索引**（2026-10-05 复核 REQ-11 后半）：检索侧只读生效
   * 版本的分块，因此「登记成功但未生效」时继续写分块 = 写出谁也看不见的内容，
   * 而且**没有任何地方会报错**——索引状态看着正常，检索面悄悄少内容。
   * 换提供方/换模型后必须先重建索引、再切换生效版本（§15.5「切换版本后触发
   * 全量重建」，设计 §3850），因此这里的失败消息直接给出这两步。
   */
  async #registerRevision(engagementId: string): Promise<void> {
    const register = this.#ensureEmbeddingRevision;
    const provider = this.#embeddings;
    if (register === undefined || provider === undefined) return;
    if (this.#registeredRevisions.has(engagementId)) return;
    const record = await register(engagementId, {
      model: provider.model,
      dimensions: provider.dimensions,
      revision: provider.revision,
    });
    this.#registeredRevisions.add(engagementId);
    if (!record.isActive) {
      throw new IndexerError(
        'embedding_revision_inactive',
        `嵌入版本 ${provider.revision} 已登记但不是本 engagement 的生效版本`,
        '继续索引会写出检索面（只读生效版本）看不见的分块，因此拒绝；' +
          '处置：先用当前提供方重建索引（reindex_engagement），重建完成后再把生效版本切到 ' +
          `${provider.revision}；在那之前请把提供方配置回退到原版本`,
      );
    }
  }

  /**
   * 索引一个事件。
   *
   * 步骤：分块 → 写入侧义务校验（§8.6）→ 批量嵌入（可索引的）→ **一次批量落库** →
   * 标记同源暂定块被取代。全程幂等：重复调用同一事件不会产生重复分块。
   *
   * **可能抛 `IndexerError('target_not_adjudicated')`**：事件里明确出现目标
   * （`targetHints` 非空，由 {@link extractTargetHints} 从结构化字段提取）却没有任何
   * 已登记资产可归属时拒绝写入。这是刻意的 fail-closed：§8.6 的可见性公式对空
   * `asset_ids` **放行**，若在这里放行，被排除资产的内容只要不标资产就能留在检索面。
   * 抛错让坏事件在调度器上重试直至死信，从而**可见**（有人去登记资产），
   * 而不是静默地以「无归属」形态进入索引——后者永远不会被发现。
   *
   * 校验放在嵌入**之前**：这批分块注定写不进去时，不必先花掉一次嵌入调用。
   */
  async indexEvent(
    engagementId: string,
    event: ChunkSourceEvent,
  ): Promise<IndexEventResult> {
    const drafts = planChunks(event, this.#chunking);
    if (drafts.length === 0) {
      return { inserted: 0, skipped: 0, supersededProvisional: 0, metadataOnly: 0, lexicalOnly: this.#embeddings === undefined };
    }

    // §8.6 写入侧义务：能确定归属的分块必须填齐 asset_ids。
    // 线索来自事件（`targetHints`）而不是分块内容——分块内容是从正文派生的，
    // 拿它去校验等于让正文决定自己的归属。
    const writable = checkChunkBatchWritable({
      chunks: drafts,
      targetHints: event.targetHints ?? [],
    });
    if (!writable.ok) {
      throw new IndexerError(
        writable.code,
        `写入侧义务校验（§8.6）拒绝索引：${writable.detail}`,
        `错误码 ${writable.code}：来源事件明确含目标，但没有任何线索匹配到已登记资产。` +
          `处置是**登记资产**（情报收集阶段的产出）后重试，不是跳过该事件；` +
          `在登记前它会一直失败并最终进入死信，这是刻意的 fail-closed`,
      );
    }

    if (this.#embeddings !== undefined) {
      assertDimensions(this.#embeddings, MEMORY_EMBEDDING_DIMENSIONS);
      // 先登记版本再写向量：检索侧的生效版本过滤依赖这一行存在。
      await this.#registerRevision(engagementId);
    }

    const revision = this.#revision();
    const indexable = drafts.filter((d) => d.indexable && !d.provisional);

    // 批量嵌入：一次请求覆盖本事件的全部可索引分块。
    // 嵌入不可用即抛——不返回零向量、不静默跳过（见文件头纪律 4）。
    let vectors: readonly (readonly number[])[] = [];
    let model: string | null = null;
    if (this.#embeddings !== undefined && indexable.length > 0) {
      vectors = await this.#embeddings.embed(indexable.map((d) => d.content));
      model = this.#embeddings.model;
      if (vectors.length !== indexable.length) {
        throw new Error(
          `嵌入提供方返回 ${vectors.length} 个向量，期望 ${indexable.length} 个。` +
            `数量不符会导致分块与向量错位，拒绝写入。`,
        );
      }
    }

    let metadataOnly = 0;
    let superseded = 0;

    // 索引 → 分块位置映射，用于取回对应向量
    const vectorOf = new Map<string, readonly number[]>();
    indexable.forEach((d, i) => {
      const v = vectors[i];
      if (v !== undefined) vectorOf.set(d.chunkId, v);
    });

    const pending: ChunkInsert[] = [];
    for (const draft of drafts) {
      if (!draft.indexable && !draft.provisional) metadataOnly += 1;
      const vector = vectorOf.get(draft.chunkId);
      pending.push({
        engagementId,
        draft,
        // 暂定块不带版本；非暂定块必须有版本（DDL CHECK）
        revision: draft.provisional ? null : revision,
        model: vector === undefined ? null : model,
        embedding: vector ?? null,
        // 暂定块与 metadata-only 块都不建全文索引（§8.5）
        searchText: draft.provisional || !draft.indexable ? null : this.#project(draft.content),
      });
    }

    const inserted = await this.#insertChunks(pending);
    const skipped = pending.length - inserted;

    // 结算块产出后，把同源暂定块标记为被该版本取代
    if (!event.provisional && drafts.some((d) => !d.provisional)) {
      superseded = await this.#supersedeProvisional(engagementId, event, revision);
    }

    return {
      inserted,
      skipped,
      supersededProvisional: superseded,
      metadataOnly,
      lexicalOnly: this.#embeddings === undefined,
    };
  }

  /**
   * 批量插入分块：同一事件的全部草稿一条语句落库，返回**真的插入了多少行**。
   *
   * ── 为什么不是逐条插入 ──
   *
   * 逐条 INSERT 意味着**每行一个隐含事务**：提交/WAL 与语句解析的固定开销按行支付。
   * 实测（316KB 工具输出 → 178 个分块，本机 PostgreSQL）：逐条 720ms，单语句批量
   * 91ms（约 8×）；而行级工作（`to_tsvector`、HNSW 维护）两者相同。大输出事件是
   * 索引器的常态输入（nmap/ffuf 类的 stdout），队列积压时这个差值线性叠加。
   *
   * 幂等语义与逐条版完全一致：靠部分唯一索引
   * `(source_event_id, ordinal, embedding_revision) WHERE source_event_id IS NOT NULL`
   * + `DO NOTHING`；返回行数即「真的插入了多少」。
   *
   * **记忆项来源（`memory_item_id`）不在本语句里**：它属于另一条部分唯一索引，
   * `ON CONFLICT` 的推断只对指定索引生效，混用会把那条冲突变成报错。当前
   * `ChunkDraft` 没有该字段、`planChunks` 也不产出该来源；将来引入时必须另起一条
   * 语句（与逐条版在这里留下的注意事项相同）。
   */
  async #insertChunks(inputs: readonly ChunkInsert[]): Promise<number> {
    if (inputs.length === 0) return 0;
    const engagementId = inputs[0]!.engagementId;
    // 同一事件的全部草稿共用一个提交时刻：逐条版里每行各自取一次时钟，
    // 结果是同一事件的分块时间戳彼此相差几毫秒——那是实现的偶然，不是语义。
    const createdAt = this.#clock().toISOString();
    // 行数组经 jsonb 传递而不是「每列一个 Postgres 数组」：`asset_ids` / `finding_ids`
    // 是**每行一个数组**，而 Postgres 的多维数组不允许空子数组（空归属的行会直接
    // 构造失败）。jsonb 对逐行可空、嵌套数组都是自然表示，SQL 端逐字段显式转型。
    const rows = inputs.map((input) => ({
      sourceEventId: input.draft.sourceEventId,
      ordinal: input.draft.ordinal,
      content: input.draft.content,
      contentHash: input.draft.contentHash,
      searchText: input.searchText,
      embeddingModel: input.model,
      embeddingRevision: input.revision,
      embedding: input.embedding === null ? null : toVectorLiteral(input.embedding),
      phase: input.draft.phase,
      workerSessionId: input.draft.workerSessionId,
      assetIds: input.draft.assetIds,
      findingIds: input.draft.findingIds,
      trustLevel: input.draft.trustLevel,
      classification: input.draft.classification,
      provisional: input.draft.provisional,
    }));
    const result = await this.#db.query<{ id: string }>(
      `insert into pentest.memory_chunks
         (engagement_id, source_event_id, ordinal, content, content_hash,
          search_vector, embedding_model, embedding_revision, embedding,
          phase, worker_session_id, asset_ids, finding_ids,
          trust_level, classification, provisional, created_at)
       select $1::uuid,
              (r->>'sourceEventId')::uuid,
              (r->>'ordinal')::int,
              r->>'content',
              r->>'contentHash',
              case when r->>'searchText' is null then null else to_tsvector('simple', r->>'searchText') end,
              r->>'embeddingModel',
              r->>'embeddingRevision',
              (r->>'embedding')::vector,
              r->>'phase',
              (r->>'workerSessionId')::uuid,
              coalesce(
                (select array_agg(v::uuid) from jsonb_array_elements_text(coalesce(r->'assetIds', '[]'::jsonb)) as v),
                '{}'::uuid[]
              ),
              coalesce(
                (select array_agg(v::uuid) from jsonb_array_elements_text(coalesce(r->'findingIds', '[]'::jsonb)) as v),
                '{}'::uuid[]
              ),
              r->>'trustLevel',
              r->>'classification',
              (r->>'provisional')::boolean,
              $2::timestamptz
         from jsonb_array_elements($3::jsonb) as r
       on conflict (source_event_id, ordinal, embedding_revision)
         where source_event_id is not null
         do nothing
       returning id`,
      [engagementId, createdAt, JSON.stringify(rows)],
    );
    return result.rowCount ?? result.rows.length;
  }

  /**
   * 把同源的暂定分块标记为被当前版本取代。
   *
   * 「同源」的判定是 `worker_session_id` + 分块种类相同 + 时间早于本次结算事件。
   * 为什么不用事件标识：暂定帧与它的结算消息是**两条不同的账本事件**
   * （账本只追加），它们之间没有直接引用；会话 + 种类 + 时序是唯一可用的关联。
   *
   * 这一步失败不抛错——它只是清理动作，留着暂定块不会污染检索（暂定块没有
   * 全文索引与向量，本就不可检索）。记入返回值供观测。
   */
  async #supersedeProvisional(
    engagementId: string,
    event: ChunkSourceEvent,
    revision: string,
  ): Promise<number> {
    const kinds = [...new Set(planChunks(event, this.#chunking).filter((d) => !d.provisional).map((d) => d.kind))];
    if (kinds.length === 0) return 0;
    const occurredAt =
      event.occurredAt instanceof Date ? event.occurredAt.toISOString() : String(event.occurredAt);

    const result = await this.#db.query<{ id: string }>(
      `update pentest.memory_chunks
          set superseded_by_revision = $4
        where engagement_id = $1::uuid
          and worker_session_id = $2::uuid
          and provisional = true
          and superseded_by_revision is null
          and created_at <= $3::timestamptz
          and content_hash in (
            select content_hash from pentest.memory_chunks mc
             where mc.engagement_id = $1::uuid and mc.source_event_id = $5::uuid
          )
        returning id`,
      [engagementId, event.workerSessionId ?? null, occurredAt, revision, event.eventId],
    );
    return result.rowCount ?? result.rows.length;
  }

  /**
   * 按事件标识索引**单个**事件（供 outbox 调度器使用）。
   *
   * 与 `runOnce` 的分工：
   *   - `runOnce` 是**水位驱动**的重扫路径，用于全量重建（`reindex_engagement`）；
   *   - 本方法是**任务驱动**路径，一个 outbox 任务对应一个事件，
   *     因此失败与退避按事件粒度计——一个坏事件不会拖住同批的其它事件。
   *
   * 事件不存在或不属于该 engagement 时**抛错**，不返回「索引了 0 条」。
   * 那种情况意味着队列里有个不该存在的任务（数据错乱或跨 engagement 的越权），
   * 静默完成它会让问题消失得无影无踪；抛错会让任务走重试直至死信，从而可见。
   */
  async indexEventById(engagementId: string, eventId: string): Promise<IndexEventResult> {
    const row = await this.#loadEvent(engagementId, eventId);
    if (row === undefined) {
      throw new Error(
        `事件 ${eventId} 不属于 engagement ${engagementId}（或不存在）。` +
          `索引任务与事件应当同事务入队，出现该情况说明队列里有一条不该存在的任务；` +
          `拒绝静默完成，让它走重试直至死信以便人工核查。`,
      );
    }
    return this.indexEvent(engagementId, await this.#toSourceEvent(engagementId, row));
  }

  /**
   * 读单个事件行（连带它的会话阶段），并校验它属于该 engagement。
   *
   * 阶段必须 join 出来：`context_events` 没有该列，阶段是**会话**的属性（§5.1）。
   * `left join` 而不是 `join`：`worker_session_id` 为空是人类输入与系统事件的正常形态
   * （索引器不该因此丢掉这些事件），此时 `session_phase` 为 null，分块阶段也就为 null。
   */
  async #loadEvent(engagementId: string, eventId: string): Promise<EventRow | undefined> {
    const r = await this.#db.query<EventRow>(
      `select e.event_id, e.worker_session_id, e.event_type, e.chain_seq, e.occurred_at,
              e.provisional, e.classification, e.trust_level, e.payload_json, e.text_projection,
              ws.phase as session_phase
         from pentest.context_events e
         left join pentest.worker_sessions ws on ws.id = e.worker_session_id
        where e.engagement_id = $1::uuid and e.event_id = $2::uuid`,
      [engagementId, eventId],
    );
    return r.rows[0];
  }

  /**
   * 把水位重置到起点，供全量重建使用（§15.5「可按事件水位重建分块与嵌入」）。
   *
   * **只重置水位，不删除已有分块**。为什么不删：
   *   - 分块的写入是幂等的（标识由事件、序号、嵌入版本派生），重建时命中幂等会跳过；
   *   - 先删后建会让检索面在重建期间**完全为空**，而保留旧分块的降级是「内容略旧」
   *     ——后者对正在进行的渗透任务显然更可接受；
   *   - 真正需要清掉旧向量时，那是「切换嵌入版本」的动作，由
   *     `EmbeddingRevisionRegistry.activate` + 检索侧的 active 版本过滤完成，
   *     不是重置水位该干的事。
   */
  async resetWatermark(engagementId: string): Promise<void> {
    await this.#txDb.query(
      `update pentest.index_watermarks
          set last_chain_seq = 0,
              indexed_through_occurred_at = null,
              status = 'lagging',
              last_error = null,
              updated_at = now()
        where engagement_id = $1::uuid`,
      [engagementId],
    );
  }

  /**
   * 从水位推进一次：读账本 → 逐事件索引 → 推水位。
   *
   * **水位只在成功后推进**，且每次推进都记录状态。失败时水位不动（下次重扫同一批），
   * 状态标 `lagging` 并把原因写进水位行——这样控制台能显示「索引落后了多少」
   * （§15.5），而不是让失败静默消失。
   *
   * 注意：这条路径**整批失败**就整批不推进，因此一个归属解析不出的事件会让水位
   * 停在那里（状态 `failed` + 原因可读）。日常索引走调度器的按事件路径
   * （`indexEventById`），失败按事件隔离；这里是为重建准备的粗粒度路径。
   */
  async runOnce(
    engagementId: string,
    options: { readonly maxEvents?: number } = {},
  ): Promise<IndexRunResult> {
    const limit = options.maxEvents ?? 100;
    const watermark = await this.#readWatermark(engagementId);
    const from = toSafeSeq(watermark?.last_chain_seq, 'last_chain_seq');

    const rows = await this.#db.query<EventRow>(
      `select e.event_id, e.worker_session_id, e.event_type, e.chain_seq, e.occurred_at,
              e.provisional, e.classification, e.trust_level, e.payload_json, e.text_projection,
              ws.phase as session_phase
         from pentest.context_events e
         left join pentest.worker_sessions ws on ws.id = e.worker_session_id
        where e.engagement_id = $1::uuid and e.chain_seq > $2
        order by e.chain_seq
        limit $3`,
      [engagementId, from, limit],
    );

    let chunksInserted = 0;
    let to = from;
    let processed = 0;

    try {
      for (const row of rows.rows) {
        const event = await this.#toSourceEvent(engagementId, row);
        const result = await this.indexEvent(engagementId, event);
        chunksInserted += result.inserted;
        to = toSafeSeq(row.chain_seq, 'chain_seq');
        processed += 1;
      }
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      // 失败：水位不动（下次重扫同一批），只更新状态与原因。
      // 已成功索引的事件因幂等不会被重复插入，所以重扫是安全的。
      await this.#writeWatermark({
        engagementId,
        lastChainSeq: to,
        occurredAt: null,
        status: 'failed',
        detail,
        strategyVersion: INDEX_STRATEGY_VERSION,
      });
      return {
        engagementId,
        fromChainSeq: from,
        toChainSeq: to,
        eventsProcessed: processed,
        chunksInserted,
        status: 'failed',
        detail,
      };
    }

    const more = rows.rows.length === limit;
    const status = more ? 'lagging' : 'ready';
    await this.#writeWatermark({
      engagementId,
      lastChainSeq: to,
      occurredAt: this.#clock(),
      status,
      detail: more ? `本批已满 ${limit} 条，仍有未索引事件` : null,
      strategyVersion: INDEX_STRATEGY_VERSION,
    });

    return {
      engagementId,
      fromChainSeq: from,
      toChainSeq: to,
      eventsProcessed: processed,
      chunksInserted,
      status,
      detail: more ? `本批已满 ${limit} 条` : null,
    };
  }

  /** 读水位。不存在时返回 null（尚未索引任何事件）。 */
  async #readWatermark(engagementId: string): Promise<WatermarkRow | null> {
    const r = await this.#db.query<WatermarkRow>(
      `select last_chain_seq, strategy_version from pentest.index_watermarks where engagement_id = $1::uuid`,
      [engagementId],
    );
    return r.rows[0] ?? null;
  }

  /** 写水位（upsert）。策略版本不一致时记入——那意味着索引需重建。 */
  async #writeWatermark(input: {
    readonly engagementId: string;
    readonly lastChainSeq: number;
    readonly occurredAt: Date | null;
    readonly status: 'ready' | 'lagging' | 'failed';
    readonly detail: string | null;
    readonly strategyVersion: string;
  }): Promise<void> {
    await this.#txDb.query(
      `insert into pentest.index_watermarks
         (engagement_id, last_chain_seq, indexed_through_occurred_at, status, last_error, strategy_version, updated_at)
       values ($1::uuid, $2, $3::timestamptz, $4, $5, $6, now())
       on conflict (engagement_id) do update
         set last_chain_seq = greatest(pentest.index_watermarks.last_chain_seq, excluded.last_chain_seq),
             indexed_through_occurred_at = coalesce(excluded.indexed_through_occurred_at, pentest.index_watermarks.indexed_through_occurred_at),
             status = excluded.status,
             last_error = excluded.last_error,
             strategy_version = excluded.strategy_version,
             updated_at = now()`,
      [
        input.engagementId,
        input.lastChainSeq,
        input.occurredAt === null ? null : input.occurredAt.toISOString(),
        input.status,
        input.detail,
        input.strategyVersion,
      ],
    );
  }

  /**
   * 账本行 → 分块来源事件（§8.6 的写入侧解析就在这里）。
   *
   * `engagementId` 必须传入而不是从行里读：`context_events` 有该列，但调用方
   * 已在手上，重复读一列是多余的；更重要的是分块的 `chunkId` 由它参与派生，
   * 传空串会产出一个与真实归属不符的标识。
   *
   * 三件事在这里补齐，缺任何一件 §8.6 的范围过滤都会失真：
   *   - `phase`：从 join 到的会话取（账本事件不带阶段），无会话即 null；
   *   - `targetHints`：从结构化字段保守提取的"事件里明确出现的目标"；
   *   - `assetIds`：线索等值匹配 `pentest.assets` 得到的**已登记**资产标识。
   *
   * `findingIds` 仍留空：结论归属由 §8.10 的结论落库路径写，不在账本事件里，
   * 本模块无从派生（没有线索可查，不是没做）。
   */
  async #toSourceEvent(engagementId: string, row: EventRow): Promise<ChunkSourceEvent> {
    const targetHints = extractTargetHints(row.payload_json);
    return {
      eventId: row.event_id,
      engagementId,
      eventType: row.event_type as ChunkSourceEvent['eventType'],
      workerSessionId: row.worker_session_id,
      phase: toPhase(row.session_phase, row.event_id),
      trustLevel: row.trust_level,
      classification: row.classification,
      occurredAt: row.occurred_at,
      provisional: row.provisional,
      payload: row.payload_json,
      textProjection: row.text_projection,
      assetIds: await this.#resolveAssetIds(engagementId, targetHints),
      findingIds: [],
      targetHints,
    };
  }

  /**
   * 目标线索 → **已登记**资产标识（§8.6）。
   *
   * 只认已登记资产，**绝不自动创建**：登记资产是情报收集阶段的产出（人工程序），
   * 不是索引器的职权。索引器替 engagement 追加攻击面会让「范围外扫描」这件事
   * 在数据层先变成既成事实——那是越权，不是便利。
   *
   * 匹配是 `canonical_target` 的等值匹配（`assets` 上有
   * `UNIQUE (engagement_id, canonical_target, kind)`），同一目标可能有多种 kind
   * 各占一行，因此结果是**集合**而不是单值。不做大小写折叠、不做 LIKE/模糊匹配：
   * 归一化是登记资产那一侧的事，这里放宽会猜错归属，而归属错会把内容带进或带出
   * 范围过滤（§8.6 的三条判定），比解析不到严重得多。
   *
   * 线索为空时不查库——绝大多数事件（人类输入、系统事件）走到这里都是空。
   */
  async #resolveAssetIds(
    engagementId: string,
    targetHints: readonly string[],
  ): Promise<readonly string[]> {
    if (targetHints.length === 0) return [];
    const r = await this.#db.query<{ id: string }>(
      `select id from pentest.assets
        where engagement_id = $1::uuid and canonical_target = any($2::text[])
        order by canonical_target, id`,
      [engagementId, [...targetHints]],
    );
    return [...new Set(r.rows.map((row) => row.id))];
  }

  /**
   * 读取索引水位快照，供控制台与 Agent 提示词使用（§8.4「检索结果返回索引水位
   * 与时间范围」「Agent 提示词说明可能遗漏尚未索引的事件」）。
   */
  async watermark(engagementId: string): Promise<{
    readonly lastChainSeq: number;
    readonly occurredAt: string | null;
    readonly status: 'ready' | 'lagging' | 'failed';
    readonly detail: string | null;
    /** 与账本最大序号之差，即「可能遗漏多少条」。 */
    readonly lagEvents: number;
    /**
     * 记录在案的索引策略版本（§9.1 版本分离）。与 {@link INDEX_STRATEGY_VERSION}
     * 不一致即「这份索引由旧策略生成」，需要重建——调度器据此入队重建任务。
     */
    readonly strategyVersion: string;
  }> {
    const r = await this.#db.query<WatermarkRow & { indexed_through_occurred_at: string | null; status: 'ready' | 'lagging' | 'failed'; last_error: string | null }>(
      `select last_chain_seq, indexed_through_occurred_at, status, last_error, strategy_version
         from pentest.index_watermarks where engagement_id = $1::uuid`,
      [engagementId],
    );
    const head = await this.#db.query<{ head: number | string | null }>(
      `select max(chain_seq) as head from pentest.context_events where engagement_id = $1::uuid`,
      [engagementId],
    );
    const row = r.rows[0];
    const last = toSafeSeq(row?.last_chain_seq, 'last_chain_seq');
    const max = toSafeSeq(head.rows[0]?.head, 'chain head');
    return {
      lastChainSeq: last,
      occurredAt: row?.indexed_through_occurred_at ?? null,
      status: row?.status ?? 'ready',
      detail: row?.last_error ?? null,
      lagEvents: Math.max(0, max - last),
      // 没有水位行时给出当前常量：那表示「还没建过索引」，不是「按旧策略建的」。
      strategyVersion: row?.strategy_version ?? INDEX_STRATEGY_VERSION,
    };
  }
}
