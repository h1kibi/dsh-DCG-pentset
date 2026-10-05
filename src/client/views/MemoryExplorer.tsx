/**
 * 记忆浏览器：混合检索（§8.6）、引用追溯（§8.7）、思考链标注（§8.3）、索引水位（§8.4）。
 *
 * 设计依据：docs/dsh-pentest-plugin-design.md §8.3、§8.4、§8.6、§8.7、§6.2.1
 *
 * ── 本视图的三条硬要求（都不是装饰）──
 *
 * 1. **`include_reasoning` 是筛选开关，不是权限门禁**（§8.3）。文档写明「检索接口的过滤
 *    参数只是可选筛选，不是访问门槛」「本 engagement 内的任意阶段 Agent 都可以检索与阅读
 *    思考链」。不把这句写进界面，人类会以为勾上它「解锁」了什么东西，或者以为关掉它
 *    就限制了谁——两种误会都会影响他做判断。
 * 2. **思考链条目必须标注「模型内部推理，不等同于事实」**（§8.3）。阅读思考链是协作与审计
 *    能力，不改变其证据等级；标注是让人类不把它当事实用的唯一手段。
 * 3. **渲染不得自动展开原文**（§8.3「每次读取写入访问审计」）。若渲染时就取回原文，审计
 *    记录的是「谁打开了页面」而不是「谁读了这条推理」，审计随之失去意义。因此取原文只有
 *    一个入口：显式的「展开原文」按钮，点击时回调调用方（由调用方写审计并取内容）。
 *
 * ── 端点缺口（重要）──
 *
 * 检索与读取的能力在契约上属于 **Agent 工具面**（`memory_search` / `memory_read`，
 * `src/tools/worker.ts`）与检索服务面（`src/memory/retrieval.ts`），而**控制台 RPC 方法表**
 * （`src/console/rpc.ts` ⊆ `HumanWorkflowService`）里没有任何记忆端点。因此本组件**不自己发
 * 请求**：`onSearch` / `onExpand` 是意图出口，由调用方决定接到哪个面；缺回调时按钮禁用并
 * 说明缺什么（`Button` 的约定：禁用的按钮必须给出理由）。
 *
 * 需要的端点（当前缺失，详见交付报告）：
 *   - `memory.search`    —— §8.7 的检索入口（入参见 {@link toSearchParams}）
 *   - `memory.read`      —— §8.7 的「按标识读取某条记忆的完整内容」
 *   - `memory.watermark` —— §8.4 的索引水位（`src/memory/indexer.ts` 的 `watermark()`）
 *
 * ── 为什么结果行用「视图类型」而不是服务端类型 ──
 *
 * 字段名与 `src/memory/retrieval.ts` 的 `MemoryHit` **逐字段对齐**，因此调用方可以把 Host
 * 返回的命中直接传进来，不需要中间映射层。但本文件不 import 那个模块的值：它经
 * `memory/chunks.ts` 依赖 `node:crypto`，客户端 bundle 不能引它（`import type` 会被
 * `verbatimModuleSyntax` 抹掉，因此类型仍然可以引用）。
 *
 * ── 服务端渲染 ──
 *
 * 纯函数组件、纯 props：不调 `useConsoleSnapshot`、不碰 `window`/`document`、
 * 不在渲染期发请求。唯一的状态是表单本身的本地展示状态（`useState`），它在服务端
 * 渲染时只取初值。
 */

import { useState } from 'react';
import type { ReactNode } from 'react';
import { PHASES, isPhase } from '../../contracts.ts';
import type { Classification, LedgerVerificationView, Phase, TrustLevel } from '../../contracts.ts';
import type { ChunkKind } from '../../memory/chunks.ts';
import type { RetrievalRoute } from '../../memory/retrieval.ts';
import type { ConsoleController, ConsoleSnapshot } from '../controller.ts';
import { formatCount, formatTimestamp, phaseLabel, trustLabel, truncate } from '../format.ts';
import type { Tone } from '../format.ts';
import { Badge, Button, Card, Empty, ErrorBar, Field, List, Stat, TextInput } from '../ui.tsx';

// ───────────────────────── 文案（§6.2.3 要求文案可经 locale 覆盖；本仓暂无完整 locale 表，先集中在此） ─────────────────────────

/**
 * §8.3 的统一标注。**与 `src/memory/retrieval.ts` 的 `REASONING_LABEL` 必须同文**：
 * 界面与服务端各说一句不同的「这是推理」，会让人以为是两个不同的东西。之所以不 import
 * 那个常量，是因为该模块经 `memory/chunks.ts` 依赖 `node:crypto`，客户端 bundle 引不了。
 * 测试锁定了这段文本。
 */
export const REASONING_NOTE = '模型内部推理，不等同于事实';

/** 思考链开关的标签。写全 `include_reasoning`，让它与文档/接口参数一一对上。 */
export const REASONING_SWITCH_LABEL = '纳入思考链（include_reasoning 筛选开关）';

/** 开关的说明：这是本视图最容易被误读的一处（见文件头第 1 条）。 */
export const REASONING_SWITCH_HINT =
  '这是筛选开关，不是权限门禁：思考链对本 engagement 的全部 Worker 都开放检索与阅读（§8.3）。'
  + '勾选与否只决定本次检索是否返回思考链条目，不代表获得了或失去了任何权限。';

export const REASONING_SWITCH_ON_NOTE =
  '思考链与其他记忆类型使用完全相同的排序规则：既不额外加分也不降权，只多一个「模型内部推理」标注（§8.6）。';

export const REASONING_SWITCH_OFF_NOTE =
  '本次检索不返回思考链条目——仅筛选，不改变任何人的读取权限（§8.3）。';

const AUDIT_NOTE =
  '读取原文会写入访问审计（§8.3：记录会话、查询与命中的条目）。因此本页渲染不会自动展开：'
  + '只有点击「展开原文」才触发读取。';

// ───────────────────────── 取值域与标签 ─────────────────────────

/**
 * 记忆类型（§8.5 的分块来源）的中文标签。
 *
 * 用 `Record<ChunkKind, string>` 而不是数组：契约新增一种分块类型而这里漏配时，
 * **编译期**就会失败，而不是等到界面上少一个筛选框才被发现。展示顺序 = 本表的声明顺序。
 */
const KIND_LABELS: Readonly<Record<ChunkKind, string>> = {
  human_input: '人类输入',
  decision: '人工决策',
  handoff: '交接材料',
  compaction_summary: '压缩摘要',
  report_summary: '报告摘要',
  fact: '观测事实',
  hypothesis: '假设',
  finding: '结论',
  limitation: '限制条件',
  tool_observation: '工具观测',
  http_exchange: 'HTTP 交换',
  binary_evidence: '二进制证据',
  assistant_message: '助手消息',
  reasoning: '思考链',
};

/**
 * 分块类型的展示标签。
 *
 * 查表用 `Record<ChunkKind, string>`（新增类型漏配标签会编译失败），
 * 但入参是 `string`——服务端可能返回客户端还不认识的类型，此时显示原始标识符。
 */
function kindLabelOf(kind: string): string {
  return Object.hasOwn(KIND_LABELS, kind) ? KIND_LABELS[kind as ChunkKind] : kind;
}

/** 运行时窄化：把 `Object.keys` 出来的字符串收回契约类型，不写类型断言。 */
function isMemoryKind(value: string): value is ChunkKind {
  return Object.hasOwn(KIND_LABELS, value);
}

/** 可勾选的记忆类型，顺序即 §8.5 的分块来源顺序。 */
export const MEMORY_KIND_OPTIONS: readonly { readonly value: ChunkKind; readonly label: string }[] =
  Object.entries(KIND_LABELS).flatMap(([value, label]) => (isMemoryKind(value) ? [{ value, label }] : []));

/**
 * 来源可信度的筛选顺序：从「已经过验证」到「不可信」。
 *
 * 契约只有 `TrustLevel` 类型、没有取值数组，因此这里的顺序只能由本表给出。
 */
const TRUST_FILTER_ORDER: readonly TrustLevel[] = [
  'human_decision',
  'tool_observation',
  'agent_claim',
  'model_reasoning',
  'external_untrusted',
];

/**
 * 编译期穷尽检查：契约新增可信度档位而这里没跟上时，下面这行的类型不是 `true`，编译失败。
 *
 * 用类型而不是运行时断言，是因为需要在**构建时**拦住漏配（界面上少一个筛选档位是很难
 * 被注意到的缺陷），而不是在浏览器里报错。运行时无用途，故以下划线起名。
 */
const _TRUST_FILTER_COVERS_CONTRACT: Exclude<TrustLevel, (typeof TRUST_FILTER_ORDER)[number]> extends never
  ? true
  : false = true;

/** 三路检索信号（§8.6）。标签由契约的可选值域约束：漏一路同样编译失败。 */
const ROUTE_LABELS: Readonly<Record<RetrievalRoute, string>> = {
  semantic: '语义近邻',
  lexical: '全文检索',
  trigram: '三元组相似',
};

const WATERMARK_STATUS_LABELS: Readonly<Record<IndexWatermarkView['status'], string>> = {
  ready: '就绪',
  lagging: '滞后',
  failed: '失败',
};

/** 摘录的展示上限。服务端已经截断过（§8.5 摘录策略），这里只是防止异常长的行撑爆列表。 */
const EXCERPT_DISPLAY_CHARS = 320;

// ───────────────────────── 视图类型 ─────────────────────────

/**
 * 一条检索结果。
 *
 * 必填字段是 §6.2.1 / §8.6 要求「检索结果必须返回」的那几项：记忆标识（`chunkId`）、
 * 摘录、评分、来源信息（事件、会话、阶段、时间）、来源可信度与引用标识。可选字段
 * 是那些能让人判断得更准的信息，缺了就少显示一格。
 */
export interface MemoryHitView {
  readonly chunkId: string;
  /**
   * 分块类型。
   *
   * 类型是 `string` 而不是 `ChunkKind` 是**有意的**：服务端可能返回客户端还不认识的
   * 新类型。把它断言成 `ChunkKind` 会让那个值静默走进 `KIND_LABELS` 的查表并得到
   * `undefined`；留成 `string` 时渲染层必须显式兜底，人类会看到原始标识符——
   * 「有个叫 xxx 的类型」远好过一片空白。
   */
  readonly kind: string;
  readonly excerpt: string;
  /** 倒数排名融合分（§8.6）。只在同一次检索内可比较，绝对值无意义。 */
  readonly score: number;
  readonly trustLevel: TrustLevel;
  /** 引用标识（形如 `memory:<id>`），Agent 侧引用同一条记忆时用它。 */
  readonly citation: string;
  readonly occurredAt: string;
  /**
   * 思考链的标注（§8.3）。服务端已给出时直接用它；为 `null` 且 `kind === 'reasoning'`
   * 时本视图用 {@link REASONING_NOTE} 兜底——标注不能因为上游漏传就消失。
   */
  readonly reasoningLabel?: string | null;
  readonly sourceEventId?: string | null;
  readonly workerSessionId?: string | null;
  readonly phase?: Phase | null;
  readonly classification?: Classification;
  readonly assetIds?: readonly string[];
  readonly findingIds?: readonly string[];
  /** 暂定分块（来自未完成的流式片段，§8.4）。 */
  readonly provisional?: boolean;
  /** 已被人工接受（§8.6 的过滤维度之一）。 */
  readonly humanAccepted?: boolean;
  readonly routes?: readonly RetrievalRoute[];
}

/** 索引水位（§8.4）。字段与 `src/memory/indexer.ts` 的 `watermark()` 返回一致。 */
export interface IndexWatermarkView {
  readonly lastChainSeq: number;
  readonly occurredAt: string | null;
  readonly status: 'ready' | 'lagging' | 'failed';
  readonly detail?: string | null;
  /** 与账本最大序号之差，即「可能遗漏多少条」（§8.4）。 */
  readonly lagEvents: number;
}

/** 展开原文的引用。`idempotencyKey` 由视图在点击时生成（§15.3：控制台写操作必须带幂等键）。 */
export interface MemoryExpandRef {
  readonly memoryId: string;
  readonly citation: string;
  readonly idempotencyKey: string;
}

// ───────────────────────── 检索表单与入参（§8.7） ─────────────────────────

/** 表单的本地模型。输入框一律以字符串承载，解析在 {@link toSearchParams} 里做一次。 */
export interface MemoryQueryForm {
  readonly query: string;
  readonly phase: Phase | null;
  readonly kinds: readonly ChunkKind[];
  readonly trustLevels: readonly TrustLevel[];
  /** 资产标识，逗号或空白分隔。 */
  readonly assetIdsText: string;
  readonly includeReasoning: boolean;
  readonly limitText: string;
}

/** §8.7 的默认条数。 */
export const DEFAULT_MEMORY_LIMIT = 8;

/** 上限。人工检索是同步阅读，几十条以上就不是「看结果」而是「搬数据」了。 */
export const MAX_MEMORY_LIMIT = 50;

/**
 * 初值。
 *
 * `includeReasoning: true` 是有依据的默认值：§8.7「不传时思考链与其他类型一同参与检索」，
 * 关掉它是一个**有意的收窄**，不该是默认行为。
 */
export const EMPTY_MEMORY_FORM: MemoryQueryForm = {
  query: '',
  phase: null,
  kinds: [],
  trustLevels: [],
  assetIdsText: '',
  includeReasoning: true,
  limitText: String(DEFAULT_MEMORY_LIMIT),
};

/**
 * §8.7 的检索入参。字段名与设计文档的 JSON 一致（snake_case），因此这份类型可以直接
 * 作为端点参数使用，不需要在调用方再映射一次。
 */
export interface MemorySearchParams {
  readonly query: string;
  readonly include_reasoning: boolean;
  readonly limit: number;
  readonly phase?: Phase;
  readonly kinds?: readonly ChunkKind[];
  readonly trust_levels?: readonly TrustLevel[];
  readonly asset_ids?: readonly string[];
}

/** 把表单转成检索入参。空筛选**省略**而不是传空数组：省略的语义是「不限」，语义更明确。 */
export function toSearchParams(form: MemoryQueryForm): MemorySearchParams {
  const params: {
    query: string;
    include_reasoning: boolean;
    limit: number;
    phase?: Phase;
    kinds?: readonly ChunkKind[];
    trust_levels?: readonly TrustLevel[];
    asset_ids?: readonly string[];
  } = {
    query: form.query.trim(),
    include_reasoning: form.includeReasoning,
    limit: parseLimit(form.limitText),
  };
  if (form.phase !== null) params.phase = form.phase;
  if (form.kinds.length > 0) params.kinds = form.kinds;
  if (form.trustLevels.length > 0) params.trust_levels = form.trustLevels;
  const assetIds = parseIdList(form.assetIdsText);
  if (assetIds.length > 0) params.asset_ids = assetIds;
  return params;
}

/** 条数解析：非法值回落到默认值（不回落到 1——那会让一次手滑变成「只看一条」）。 */
export function parseLimit(text: string): number {
  const parsed = Number.parseInt(text.trim(), 10);
  if (!Number.isFinite(parsed) || parsed < 1) return DEFAULT_MEMORY_LIMIT;
  return Math.min(parsed, MAX_MEMORY_LIMIT);
}

/** 标识列表解析：逗号（中英文）、分号、空白都算分隔符；去重且保序。 */
export function parseIdList(text: string): readonly string[] {
  const parts = text
    .split(/[\s,，、;；]+/u)
    .map((part) => part.trim())
    .filter((part) => part !== '');
  return [...new Set(parts)];
}

/** 多选开关的纯函数：勾选/取消一个值，保序。 */
export function toggleValue<T extends string>(
  list: readonly T[],
  value: T,
  next: boolean,
): readonly T[] {
  if (next) return list.includes(value) ? list : [...list, value];
  return list.filter((item) => item !== value);
}

// ───────────────────────── 展示辅助 ─────────────────────────

/**
 * 融合分的展示。RRF 分在 1e-2 量级（§8.6 的 `RRF_UNIT = 1/(60+1)`），固定 4 位小数才能
 * 看出两行的差别；`toFixed` 对非有限数会得到 `"NaN"`，因此先判一次。
 */
export function formatScore(score: number): string {
  if (!Number.isFinite(score)) return '—';
  return score.toFixed(4);
}

/**
 * 来源可信度的语义色。
 *
 * **它只表达证据等级，不表达相关性**（§8.6：`trust_level` 不参与排序评分，除人工决策与
 * 工具观测各加 1 个 RRF 单位的权威度加成外）。因此「外部不可信」用危险色表示「别当事实用」，
 * 而不是表示「排得靠后」。
 */
export function trustTone(trust: TrustLevel): Tone {
  switch (trust) {
    case 'human_decision':
      return 'done';
    case 'tool_observation':
      return 'active';
    case 'model_reasoning':
      return 'attention';
    case 'agent_claim':
      return 'neutral';
    case 'external_untrusted':
      return 'danger';
  }
}

/**
 * 一行的思考链标注（§8.3）。优先用上游给的标注文本；上游漏传但类型是思考链时兜底，
 * 保证标注**不可能**因上游疏忽而消失。
 */
export function reasoningNoteOf(hit: MemoryHitView): string | null {
  if (hit.reasoningLabel !== undefined && hit.reasoningLabel !== null && hit.reasoningLabel !== '') {
    return hit.reasoningLabel;
  }
  return hit.kind === 'reasoning' ? REASONING_NOTE : null;
}

// ───────────────────────── 组件 ─────────────────────────

export interface MemoryExplorerProps {
  /**
   * 控制台控制器。按控制台视图的统一 props 契约接收（调用方总是同时给 controller +
   * snapshot）。本视图**不订阅**它，只用 `newKey()` 为「展开原文」的审计写入生成幂等键
   * （§15.3：幂等键由控制器按「一次新点击」生成）。
   */
  readonly controller: ConsoleController;
  readonly snapshot: ConsoleSnapshot;
  /** 最近一次检索的命中。由调用方传入——渲染期不发请求（服务端渲染的前提）。 */
  readonly hits: readonly MemoryHitView[];
  readonly watermark?: IndexWatermarkView | null;
  readonly loading?: boolean;
  readonly error?: { readonly code: string; readonly message: string } | null;
  /** 是否已经检索过：区分「尚未检索」与「筛选后没有匹配」两种空态（§6.2.1）。 */
  readonly searched?: boolean;
  readonly initialForm?: MemoryQueryForm;
  readonly onSearch?: (params: MemorySearchParams) => void;
  readonly onExpand?: (ref: MemoryExpandRef) => void;
  /** 已取回的原文（键为记忆标识）。缺省即未展开——渲染**不会**自动取原文（§8.3 审计）。 */
  readonly details?: Readonly<Record<string, string>>;
  readonly now?: Date;
}

export function MemoryExplorer(props: MemoryExplorerProps): ReactNode {
  const [form, setForm] = useState<MemoryQueryForm>(() => props.initialForm ?? EMPTY_MEMORY_FORM);
  const patch = (next: Partial<MemoryQueryForm>): void => {
    setForm((current) => ({ ...current, ...next }));
  };

  const engagementId = props.snapshot.selectedEngagementId;
  const blockers = searchBlockers({
    query: form.query,
    engagementId,
    provided: props.onSearch !== undefined,
    loading: props.loading === true,
  });

  return (
    <div className="pentest-memory-explorer">
      <Card title="记忆检索（§8.7 混合检索）">
        <Field
          label="查询"
          hint="自然语言问题或标识符（域名、命令、函数名、哈希都走全文与三元组信号，§8.6）"
        >
          <TextInput
            value={form.query}
            onChange={(next) => {
              patch({ query: next });
            }}
            placeholder="例如：认证接口的异常响应"
          />
        </Field>

        <Field label="阶段" hint="按事件所属阶段过滤；「不限」表示不过滤（§8.6 过滤维度）">
          <select
            className="pentest-select"
            value={form.phase ?? ''}
            onChange={(event: { readonly target: { readonly value: string } }) => {
              const next = event.target.value;
              patch({ phase: isPhase(next) ? next : null });
            }}
          >
            <option value="">不限</option>
            {PHASES.map((phase) => (
              <option key={phase} value={phase}>
                {phaseLabel(phase)}
              </option>
            ))}
          </select>
        </Field>

        <CheckboxGroup
          legend="记忆类型（kinds）"
          hint="不勾选即全部类型；思考链是其中一类（14 类见 §8.5 的分块来源表）"
          options={MEMORY_KIND_OPTIONS}
          selected={form.kinds}
          onToggle={(value, next) => {
            patch({ kinds: toggleValue(form.kinds, value, next) });
          }}
        />

        <CheckboxGroup
          legend="来源可信度（trust_levels）"
          hint="可过滤、可展示，但不进排序评分（§8.6）；不勾选即不限"
          options={TRUST_FILTER_ORDER.map((value) => ({ value, label: trustLabel(value) }))}
          selected={form.trustLevels}
          onToggle={(value, next) => {
            patch({ trustLevels: toggleValue(form.trustLevels, value, next) });
          }}
        />

        <Field label="资产" hint="资产标识，逗号或空格分隔；留空即不限（§8.6）。被排除资产的内容不会返回">
          <TextInput
            value={form.assetIdsText}
            onChange={(next) => {
              patch({ assetIdsText: next });
            }}
            placeholder="asset-a, asset-b"
          />
        </Field>

        {/* 没有时间区间字段：§8.7 的检索入参只有 query/phase/kinds/trust_levels/
            asset_ids/include_reasoning/limit。收了服务端不接受的输入，等于让人类
            白填一遍——时间范围由结果里的水位与事件时间自己说明（§8.4）。 */}
        <div className="pentest-memory-explorer__times">
          <Field label="结果上限" hint={`1–${String(MAX_MEMORY_LIMIT)}；§8.7 的默认值是 ${String(DEFAULT_MEMORY_LIMIT)}`}>
            <TextInput
              type="number"
              value={form.limitText}
              onChange={(next) => {
                patch({ limitText: next });
              }}
            />
          </Field>
        </div>

        <label className="pentest-check">
          <input
            type="checkbox"
            checked={form.includeReasoning}
            onChange={(event: { readonly target: { readonly checked: boolean } }) => {
              patch({ includeReasoning: event.target.checked });
            }}
          />
          <span>{REASONING_SWITCH_LABEL}</span>
        </label>
        <p className="pentest-memory-explorer__hint" role="note">
          {REASONING_SWITCH_HINT}
        </p>
        <p className="pentest-memory-explorer__hint">
          {form.includeReasoning ? REASONING_SWITCH_ON_NOTE : REASONING_SWITCH_OFF_NOTE}
        </p>

        <Button
          label="检索"
          kind="primary"
          disabled={blockers.length > 0}
          reason={blockers[0]}
          onClick={() => {
            props.onSearch?.(toSearchParams(form));
          }}
        />
        {props.loading === true ? <Badge text="检索中" tone="active" /> : null}
        {props.onSearch === undefined ? (
          <p className="pentest-memory-explorer__gap" role="note">
            端点缺口：控制台方法表未导出记忆检索端点（memory.search），本页只渲染表单、不提交检索。
            {' '}检索能力目前在 Agent 工具面（memory_search / memory_read，`src/tools/worker.ts`）与检索服务面（§8.6/§8.7）。
          </p>
        ) : null}
      </Card>

      <Card title={`检索结果（${formatCount(props.hits.length)} 条）`}>
        <WatermarkBlock watermark={props.watermark ?? null} now={props.now} />
        <LedgerVerifyBlock controller={props.controller} engagementId={engagementId} now={props.now} />

        {props.error === null || props.error === undefined ? null : (
          <ErrorBar code={props.error.code} message={props.error.message} />
        )}
        {props.snapshot.conflict ? (
          <ErrorBar
            code="stale_state_version"
            message="另一个界面先提交了改动；本页显示的可能不是最新状态（§15.4）。"
            tone="attention"
          />
        ) : null}

        <p className="pentest-memory-explorer__hint" role="note">
          {AUDIT_NOTE}
        </p>

        <List
          items={props.hits}
          keyOf={(hit) => hit.chunkId}
          empty={emptyState(props.searched === true, props.error ?? null)}
          render={(hit) => (
            <MemoryHitRow
              hit={hit}
              controller={props.controller}
              detail={props.details?.[hit.chunkId]}
              now={props.now}
              {...(props.onExpand === undefined ? {} : { onExpand: props.onExpand })}
            />
          )}
        />
      </Card>
    </div>
  );
}

/** 检索按钮的禁用理由。空数组表示可以提交。 */
function searchBlockers(input: {
  readonly query: string;
  readonly engagementId: string | null;
  readonly provided: boolean;
  readonly loading: boolean;
}): readonly string[] {
  const blockers: string[] = [];
  if (input.query.trim() === '') {
    blockers.push('查询不能为空：空查询会把整库按时间近远铺开，不构成检索');
  }
  if (input.engagementId === null) {
    blockers.push('尚未选中 engagement：检索范围绑定当前 engagement，Agent 也不能指定别的（§8.6/§8.7）');
  }
  if (!input.provided) {
    blockers.push('控制台方法表未导出记忆检索端点（memory.search）：检索无法提交');
  }
  if (input.loading) {
    blockers.push('上一次检索尚未返回');
  }
  return blockers;
}

/** 空态。三种含义完全不同，必须分开说（§6.2.1）：还没检索 / 检索失败 / 真的没有匹配。 */
function emptyState(
  searched: boolean,
  failure: { readonly code: string; readonly message: string } | null,
): ReactNode {
  if (!searched) {
    return (
      <Empty
        title="尚未检索"
        reason="填好条件后点「检索」。检索范围受当前范围版本约束：未纳入范围的资产内容不会返回（§8.6）。"
      />
    );
  }
  if (failure !== null) {
    // 实测踩过：检索被审计闸门拒绝（`audit_unavailable`）时，这条卡片同时渲染了
    // 「没有匹配的记忆条目」——空态说的是「库里没有」，而事实是「这次根本没查到」。
    // 两者混在一起让人以为记忆是空的，于是不会去看上方那条错误码。
    return (
      <Empty
        title="检索未完成，不是没有匹配"
        reason={`这次检索以 ${failure.code} 结束（原因见上方错误码），因此这里不显示结果集。修好后重新点「检索」即可。`}
      />
    );
  }
  return (
    <Empty
      title="没有匹配的记忆条目"
      reason="可放宽时间范围、记忆类型或来源可信度筛选。两点固定约束：被排除资产的内容不会返回（§8.6），尚未索引的事件也不在结果里（§8.4）。"
    />
  );
}

/** 索引水位与滞后量（§8.4）。 */
function WatermarkBlock(props: { readonly watermark: IndexWatermarkView | null; readonly now?: Date }): ReactNode {
  const watermark = props.watermark;
  if (watermark === null) {
    return (
      <div className="pentest-memory-explorer__watermark">
        <Stat
          label="索引水位"
          value="—"
          tone="attention"
          hint="调用方未提供水位：无法判断结果是否遗漏了尚未索引的事件（§8.4）"
        />
      </div>
    );
  }

  const lagging = watermark.lagEvents > 0 || watermark.status !== 'ready';
  return (
    <div className="pentest-memory-explorer__watermark">
      <Stat
        label="索引水位"
        value={`链序 ${formatCount(watermark.lastChainSeq)}`}
        hint="已建索引的事件链序。原始账本才是唯一事实源，索引是可重建的派生数据（§8.4）"
      />
      <Stat
        label="滞后量"
        value={watermark.lagEvents === 0 ? '已追平' : `滞后 ${formatCount(watermark.lagEvents)} 条`}
        tone={watermark.lagEvents === 0 ? 'done' : 'attention'}
        hint="与账本最大序号之差，即可能遗漏的未索引事件数"
      />
      <Stat
        label="索引状态"
        value={WATERMARK_STATUS_LABELS[watermark.status]}
        tone={watermark.status === 'ready' ? 'done' : watermark.status === 'failed' ? 'danger' : 'attention'}
        hint={watermark.detail ?? '索引任务队列状态'}
      />
      <Stat label="索引至" value={formatTimestamp(watermark.occurredAt, props.now)} />
      {lagging ? (
        <p className="pentest-memory-explorer__lag" role="note">
          {`索引滞后：本次结果可能遗漏尚未索引的事件，正在工作的 Agent 也因此可能看不到它们（§8.4）。`}
        </p>
      ) : null}
    </div>
  );
}

/**
 * 账本校验结论（纯展示）：把「链失败 / 未锚定 / 锚点不一致」三种失败分开说。
 *
 * 三者处置不同、混成一句「未通过」会让人无从下手：链失败=行被改过（查谁写的）；
 * 未锚定=无法证明未被整段替换（补锚点）；锚点不一致=典型尾部截断（核对归档与截断策略）。
 */
export function LedgerVerifyResult(props: {
  readonly result: LedgerVerificationView;
  readonly now?: Date;
}): ReactNode {
  const { result } = props;
  const problems: string[] = [];
  if (result.failures.length > 0) {
    const first = result.failures[0];
    problems.push(
      `哈希链校验失败 ${formatCount(result.failures.length)} 处` +
        (first === undefined ? '' : `（首个：链序 ${formatCount(first.chainSeq)}，${first.detail}）`),
    );
  }
  if (!result.anchored) {
    problems.push('没有锚点可比：链自洽只说明行内没被改，无法证明整段未被替换或截断（§9.5）');
  } else if (result.mismatches.length > 0) {
    problems.push(`与最近锚点不一致：${result.mismatches.join('、')}（典型表现是尾部截断）`);
  }
  return (
    <div className="pentest-memory-explorer__ledger-result">
      <Stat
        label="账本完整性"
        value={result.ok ? '校验通过' : '未通过'}
        tone={result.ok ? 'done' : 'danger'}
        hint="链自洽且与锚点一致才判通过；「未锚定」按未通过处理（无法证明未被截断）"
      />
      <Stat
        label="事件数"
        value={formatCount(result.eventCount)}
        hint="实时重算的链上事件数（原始账本是唯一事实源，§8.4）"
      />
      <Stat
        label="锚点"
        value={result.anchored ? '已锚定' : '无锚点'}
        tone={result.anchored ? 'done' : 'attention'}
        hint="锚点把链头与事件数固定到独立记录，用于发现整段替换与尾部截断（§9.5）"
      />
      <Stat label="校验时间" value={formatTimestamp(result.checkedAt, props.now)} />
      {problems.length === 0 ? null : (
        <ul className="pentest-memory-explorer__ledger-problems" role="alert">
          {problems.map((text) => (
            <li key={text}>{text}</li>
          ))}
        </ul>
      )}
      <p className="pentest-memory-explorer__hint pentest-memory-explorer__ledger-head">
        {`链头：${result.chainHead}`}
      </p>
    </div>
  );
}

/**
 * 账本完整性校验入口（§8.4 / P7）：人工按需触发的一次性只读动作。
 *
 * 结果状态放在组件内部（与 IntakePrompt 的会话卡片同一先例）：它是一次点击的结果，
 * 不属于面板级常驻数据。跨作业切换后旧结论可能与新作业无关，因此按 `engagementId`
 * 比对，不匹配时不显示（旧结论不伪装成当前作业的结论）。
 */
function LedgerVerifyBlock(props: {
  readonly controller: ConsoleController;
  readonly engagementId: string | null;
  readonly now?: Date;
}): ReactNode {
  const [state, setState] = useState<{
    readonly loading: boolean;
    readonly result: LedgerVerificationView | null;
    readonly failed: boolean;
  }>({ loading: false, result: null, failed: false });

  const result =
    state.result !== null && state.result.engagementId === props.engagementId ? state.result : null;

  const run = (): void => {
    const id = props.engagementId;
    if (id === null || state.loading) return;
    setState({ loading: true, result: null, failed: false });
    const settle = (next: LedgerVerificationView | null): void => {
      setState(next === null ? { loading: false, result: null, failed: true } : { loading: false, result: next, failed: false });
    };
    void props.controller.verifyLedger(id).then(settle, () => {
      settle(null);
    });
  };

  return (
    <div className="pentest-memory-explorer__ledger">
      <Button
        label="校验账本完整性"
        disabled={props.engagementId === null || state.loading}
        reason={props.engagementId === null ? '尚未选中 engagement：校验范围绑定当前作业' : undefined}
        onClick={run}
      />
      {state.loading ? <Badge text="校验中" tone="active" /> : null}
      {state.failed ? (
        <ErrorBar
          code="ledger_verify_unavailable"
          message="校验请求失败（读不到结果）。这既不代表账本有问题，也不代表没问题——原因见错误码。"
        />
      ) : null}
      {result === null ? null : <LedgerVerifyResult result={result} now={props.now} />}
    </div>
  );
}

/** 一行检索结果。 */
function MemoryHitRow(props: {
  readonly hit: MemoryHitView;
  readonly controller: ConsoleController;
  readonly detail?: string;
  readonly onExpand?: (ref: MemoryExpandRef) => void;
  readonly now?: Date;
}): ReactNode {
  const { hit } = props;
  const reasoning = reasoningNoteOf(hit);
  const expandable = props.onExpand !== undefined;

  return (
    <div className="pentest-memory-hit" data-memory-id={hit.chunkId}>
      <div className="pentest-memory-hit__head">
        <Badge
          // 未识别的类型显示原始标识符（服务端可能先于客户端新增类型）。
          // 不回落到某个已知标签：那会把新类型伪装成旧类型。
          text={kindLabelOf(hit.kind)}
          tone={reasoning === null ? 'neutral' : 'attention'}
          hint={hit.kind}
        />
        <Badge
          text={trustLabel(hit.trustLevel)}
          tone={trustTone(hit.trustLevel)}
          hint="来源可信度：可过滤、可展示，但不进排序评分（§8.6 只给人工决策与工具观测 1 个 RRF 单位的权威度加成）"
        />
        {hit.provisional === true ? (
          <Badge
            text="暂定"
            tone="attention"
            hint="来自未完成的流式片段：只有收到完整块或工具结果后，才允许从中派生候选事实（§8.4）"
          />
        ) : null}
        {hit.humanAccepted === true ? (
          <Badge text="已人工接受" tone="done" hint="已被人类接受（§8.6 的过滤维度之一）" />
        ) : null}
        <Stat
          label="评分"
          value={formatScore(hit.score)}
          hint="倒数排名融合分（§8.6）：只在同一次检索内做相对比较，绝对值没有意义"
        />
      </div>

      {reasoning === null ? null : (
        <p className="pentest-memory-hit__reasoning" role="note">
          {reasoning}
        </p>
      )}

      <p className="pentest-memory-hit__excerpt">{truncate(hit.excerpt, EXCERPT_DISPLAY_CHARS)}</p>

      <div className="pentest-memory-hit__meta">
        <Stat
          label="来源事件"
          value={hit.sourceEventId === undefined || hit.sourceEventId === null ? '—' : truncate(hit.sourceEventId, 18)}
          hint={hit.sourceEventId ?? '无来源事件'}
        />
        <Stat
          label="会话"
          value={hit.workerSessionId === undefined || hit.workerSessionId === null ? '—' : truncate(hit.workerSessionId, 18)}
          hint={hit.workerSessionId ?? '无来源会话（如人工决策）'}
        />
        <Stat
          label="阶段"
          value={hit.phase === undefined || hit.phase === null ? '—' : phaseLabel(hit.phase)}
          hint="事件所属阶段；人工决策、压缩摘要、思考链没有阶段归属，该格显示「—」是正常的（§8.6）"
        />
        <Stat label="时间" value={formatTimestamp(hit.occurredAt, props.now)} />
      </div>

      {hit.routes === undefined || hit.routes.length === 0 ? null : (
        <p className="pentest-memory-hit__routes">
          {hit.routes.map((route) => (
            <Badge key={route} text={ROUTE_LABELS[route]} hint="命中的检索信号（§8.6 三路融合）" />
          ))}
        </p>
      )}

      <Field label="引用标识" hint="Agent 侧引用同一条记忆时用的就是它（§8.7）">
        <code className="pentest-memory-hit__citation">{hit.citation}</code>
      </Field>

      <Button
        label="展开原文（写入访问审计）"
        disabled={!expandable}
        reason="调用方未提供 onExpand：控制台未导出记忆读取端点（memory.read）"
        onClick={() => {
          props.onExpand?.({
            memoryId: hit.chunkId,
            citation: hit.citation,
            // 点击时才生成键：幂等键标识「这一次读取」，渲染期生成会把它变成「这一屏」
            idempotencyKey: props.controller.newKey('memory-access'),
          });
        }}
      />
      {props.detail === undefined ? null : (
        <pre className="pentest-memory-hit__detail">{props.detail}</pre>
      )}
    </div>
  );
}

/** 多选筛选组。用 `fieldset`/`legend` 而不是 `Field`：一个 `label` 包住多个控件时标签语义会失效。 */
function CheckboxGroup<T extends string>(props: {
  readonly legend: string;
  readonly hint: string;
  readonly options: readonly { readonly value: T; readonly label: string }[];
  readonly selected: readonly T[];
  readonly onToggle: (value: T, next: boolean) => void;
}): ReactNode {
  return (
    <fieldset className="pentest-fieldgroup">
      <legend className="pentest-field__label">{props.legend}</legend>
      <p className="pentest-field__hint">{props.hint}</p>
      <div className="pentest-fieldgroup__options">
        {props.options.map((option) => (
          <label key={option.value} className="pentest-check">
            <input
              type="checkbox"
              value={option.value}
              checked={props.selected.includes(option.value)}
              onChange={(event: { readonly target: { readonly checked: boolean } }) => {
                props.onToggle(option.value, event.target.checked);
              }}
            />
            <span>{option.label}</span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}
