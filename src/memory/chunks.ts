/**
 * 记忆分块（设计文档 §8.4 Streaming RAG 管线 / §8.5 分块策略 / §8.10 上下文压缩）。
 *
 * 分块边界严格按 §8.5 的「分块来源」表：
 *   - 人类输入、人工决策、交接 → 一条事件一个逻辑块；
 *   - Agent 报告 → 按摘要、事实、假设、结论、限制分段，保留报告父级；
 *   - 工具输出 → 按命令、标准输出、错误输出、退出码、目标与时间分组；超长按固定窗口重叠切分；
 *   - HTTP 与 JSON → 保留请求与响应元数据、状态码、路径、关键头部与正文摘要，原始正文只关联为加密证据；
 *   - 流量与二进制 → 只保存证据元数据、协议解析摘要与哈希，不直接做全文嵌入；
 *   - 思考链 → 单独记忆类型，正常建立索引并参与检索。
 * 另按 §8.4「组装完成的思考内容、助手消息与工具结果单独保存」补「助手消息」一类，
 * 按 §8.10「压缩后的摘要作为记忆条目入库」补「压缩摘要」一类。
 *
 * 写入侧的资产归属义务（§8.6）由 {@link checkChunkAssetObligation} 守住：
 * 来源事件里已明确出现目标、却未填 asset_ids 的分块会被拒绝，
 * 否则攻击者可以通过省略资产标注绕开范围排除。
 */

import { createHash } from 'node:crypto';

import type {
  Classification,
  DomainEventType,
  ErrorCode,
  Phase,
  TrustLevel,
} from '../contracts.ts';

// ───────────────────────────── 记忆类型 ─────────────────────────────

export const CHUNK_KINDS = [
  'human_input',
  'decision',
  'handoff',
  'compaction_summary',
  'report_summary',
  'fact',
  'hypothesis',
  'finding',
  'limitation',
  'tool_observation',
  'http_exchange',
  'binary_evidence',
  'assistant_message',
  'reasoning',
] as const;
export type ChunkKind = (typeof CHUNK_KINDS)[number];

export function isChunkKind(v: unknown): v is ChunkKind {
  return typeof v === 'string' && (CHUNK_KINDS as readonly string[]).includes(v);
}

/** 分块在来源内部的角色：报告分段名与工具输出分组标签。 */
export const CHUNK_PARTS = [
  'summary',
  'facts',
  'hypotheses',
  'findings',
  'limitations',
  'command',
  'stdout',
  'stderr',
  'exit',
  'http_metadata',
  'binary_metadata',
] as const;
type ChunkPart = (typeof CHUNK_PARTS)[number];

/** 报告分段顺序（§8.5：按摘要、事实、假设、结论、限制分段）。 */
export const REPORT_SECTIONS = [
  'summary',
  'facts',
  'hypotheses',
  'findings',
  'limitations',
] as const;
export type ReportSection = (typeof REPORT_SECTIONS)[number];

const REPORT_SECTION_KIND: Readonly<Record<ReportSection, ChunkKind>> = {
  summary: 'report_summary',
  facts: 'fact',
  hypotheses: 'hypothesis',
  findings: 'finding',
  limitations: 'limitation',
};

/** 报告类事件（§8.5「Agent 报告」）。 */
export const REPORT_EVENT_TYPES = [
  'worker.report',
  'report.draft.generated',
  'report.edited',
] as const satisfies readonly DomainEventType[];

/** 工具输出类事件（§8.5「工具输出」「HTTP 与 JSON」「流量与二进制」共用这些来源）。 */
const TOOL_EVENT_TYPES = ['tool.call', 'tool.result', 'tool.artifact'] as const satisfies
  readonly DomainEventType[];

/** 可留空 asset_ids 的记忆类型（§8.6：解析不出归属的事件类型才允许留空）。 */
export const ASSET_OPTIONAL_KINDS = [
  'human_input',
  'decision',
  'handoff',
  'compaction_summary',
  'reasoning',
] as const satisfies readonly ChunkKind[];

/**
 * 记忆类型 → 来源事件类型（单向多对多）。
 *
 * 检索 SQL 的下推过滤（§8.6「kinds 过滤」）靠这张表生成事件类型集合，
 * 因为 memory_chunks 表没有 kind 列（§9 数据模型）；报告各段共享来源事件类型，
 * 因此 kinds 过滤对报告是「同一报告的其他分段也可能命中」的粗粒度下推，
 * 精确到分段的过滤在返回行上按分块自身的 kind 复核。
 */
export const CHUNK_KIND_EVENT_TYPES: Readonly<Record<ChunkKind, readonly DomainEventType[]>> = {
  human_input: ['human.input', 'human.interjection'],
  decision: ['human.decision'],
  handoff: ['handoff.draft.generated', 'handoff.edited', 'handoff.confirmed'],
  compaction_summary: ['context.compacted'],
  report_summary: REPORT_EVENT_TYPES,
  fact: REPORT_EVENT_TYPES,
  hypothesis: REPORT_EVENT_TYPES,
  finding: REPORT_EVENT_TYPES,
  limitation: REPORT_EVENT_TYPES,
  tool_observation: TOOL_EVENT_TYPES,
  http_exchange: TOOL_EVENT_TYPES,
  binary_evidence: TOOL_EVENT_TYPES,
  assistant_message: ['llm.assistant.message'],
  reasoning: ['llm.reasoning'],
};

/** 思考链来源事件类型（§8.3 / §8.6：检索默认纳入，include_reasoning=false 时排除）。 */
export const REASONING_EVENT_TYPES: readonly DomainEventType[] =
  CHUNK_KIND_EVENT_TYPES.reasoning;

/**
 * **能产生分块**的事件类型（{@link CHUNK_KIND_EVENT_TYPES} 的并集，去重排序）。
 *
 * 「索引水位 / 滞后量」这类读数按**分块**衡量，因此必须用这个集合划界：
 * 控制面事件（`state.transition`、`worker.waiting_human`、`budget.*`、`lease.*`、
 * `engagement.created`…）永远落不了块，把它们算进「遗漏」会让控制台永久显示
 * 「滞后 N 条」（实测：每次状态推进尾部都至少有一个不可分块事件）。
 */
export const CHUNKABLE_EVENT_TYPES: readonly string[] = [
  ...new Set(Object.values(CHUNK_KIND_EVENT_TYPES).flat()),
].sort();

// ───────────────────────────── 分块窗口 ─────────────────────────────

const CHUNK_WINDOW_DEFAULTS = {
  /** 固定切分窗口（UTF-16 码元）。 */
  windowChars: 2_000,
  /** 相邻窗口重叠，保证跨窗口的标识符与命令不被截断丢证。 */
  overlapChars: 200,
} as const;

interface WindowOptions {
  readonly windowChars?: number;
  readonly overlapChars?: number;
}

interface TextWindow {
  /** 窗口在原文中的序号（从 0 起）。 */
  readonly ordinal: number;
  readonly start: number;
  readonly end: number;
  readonly text: string;
}

function resolveWindow(options: WindowOptions): { windowChars: number; overlapChars: number } {
  const windowChars = options.windowChars ?? CHUNK_WINDOW_DEFAULTS.windowChars;
  const overlapChars = options.overlapChars ?? CHUNK_WINDOW_DEFAULTS.overlapChars;
  if (!Number.isInteger(windowChars) || windowChars < 1) {
    throw new RangeError('windowChars 必须是 >= 1 的整数');
  }
  if (!Number.isInteger(overlapChars) || overlapChars < 0 || overlapChars >= windowChars) {
    throw new RangeError('overlapChars 必须是 0 <= overlap < windowChars 的整数');
  }
  return { windowChars, overlapChars };
}

/** 固定窗口重叠切分（§8.5：超长输出按固定窗口重叠切分）。偏移是 UTF-16 码元下标。 */
export function splitFixedWindow(text: string, options: WindowOptions = {}): readonly TextWindow[] {
  const { windowChars, overlapChars } = resolveWindow(options);
  if (text.length <= windowChars) {
    return [{ ordinal: 0, start: 0, end: text.length, text }];
  }
  const step = windowChars - overlapChars;
  const windows: TextWindow[] = [];
  let start = 0;
  for (let ordinal = 0; start < text.length; ordinal += 1) {
    const end = Math.min(start + windowChars, text.length);
    windows.push({ ordinal, start, end, text: text.slice(start, end) });
    if (end >= text.length) break;
    start += step;
  }
  return windows;
}

// ───────────────────────────── 分块草稿 ─────────────────────────────

interface ChunkRange {
  readonly start: number;
  readonly end: number;
}

/**
 * 分块草稿。字段集对应 §8.5 末段：
 * 分块标识、父事件、序号、范围、内容哈希、来源可信度、分类、阶段、会话、关联资产与结论、时间与嵌入版本。
 */
export interface ChunkDraft {
  /** 分块标识。由（来源事件、序号、嵌入版本）确定性派生，重跑不产生重复分块（§8.4 幂等）。 */
  readonly chunkId: string;
  readonly dedupeKey: string;
  readonly kind: ChunkKind;
  readonly part: ChunkPart | null;
  readonly ordinal: number;
  readonly content: string;
  readonly contentHash: string;
  /** 窗口在来源原文中的范围；无窗口切分时为整段。 */
  readonly range: ChunkRange;
  /** 父事件（账本事件标识），即「父事件 + 序号」的唯一性依据。 */
  readonly sourceEventId: string;
  /** 报告父级 / 工具运行标识等组内父引用。 */
  readonly parentRef: string | null;
  readonly engagementId: string;
  readonly workerSessionId: string | null;
  readonly phase: Phase | null;
  readonly trustLevel: TrustLevel;
  readonly classification: Classification;
  readonly assetIds: readonly string[];
  readonly findingIds: readonly string[];
  readonly evidenceRefs: readonly string[];
  readonly provisional: boolean;
  readonly embeddingRevision: string | null;
  /** false 表示只存元数据、不建全文与向量索引（§8.5「流量与二进制」）。 */
  readonly indexable: boolean;
  readonly createdAt: string;
}

export interface ToolResultPayload {
  readonly toolRunId?: string;
  readonly command?: string;
  readonly target?: string;
  readonly startedAt?: string;
  readonly stdout?: string;
  readonly stderr?: string;
  readonly exitCode?: number;
  readonly status?: string;
  readonly contentType?: 'text' | 'json' | 'http' | 'binary';
  readonly http?: HttpExchangePayload;
  readonly binary?: BinaryEvidencePayload;
  readonly evidenceRefs?: readonly string[];
}

interface HttpExchangePayload {
  readonly method?: string;
  readonly url?: string;
  readonly path?: string;
  readonly statusCode?: number;
  readonly headers?: Readonly<Record<string, string>>;
  /** 正文摘要（参与索引）。 */
  readonly bodySummary?: string;
  /** 原始正文哈希；正文本身只作为加密证据关联。 */
  readonly bodyDigest?: string;
  /** 加密证据引用（原始正文）。 */
  readonly rawBodyRef?: string;
}

interface BinaryEvidencePayload {
  readonly mimeType?: string;
  readonly byteLength?: number;
  /** 证据哈希。 */
  readonly sha256?: string;
  readonly protocolSummary?: string;
  /** 按需提取文本的引用：不内联、不嵌入。 */
  readonly extractedTextRef?: string;
}

/**
 * 报告条目。设计 §13.4 规定事实/假设是**对象**（`{statement, confidence, source_refs}`），
 * 但历史载荷与模型都可能写成纯字符串——两种都要能落块。**形状不匹配不能表现为静默丢弃**：
 * 丢掉的正是「事实」，那等于报告在记忆面不存在（QA 2026-10-04 实测：facts 全丢，只剩摘要）。
 */
export interface ReportItemObject {
  /** 主文本。设计用 `statement`；`fact`/`title`/`text` 是实测中模型写过的同义字段。 */
  readonly statement?: string;
  readonly fact?: string;
  readonly title?: string;
  readonly text?: string;
  /** 0–1 的置信度（可选）。 */
  readonly confidence?: number;
  readonly severity?: string;
  readonly source_refs?: readonly string[];
  readonly evidence_refs?: readonly string[];
  readonly missing_evidence?: readonly string[];
  readonly affected_assets?: readonly string[];
  /**
   * 下面四个来自 `pentest_submit_report` 的 `reportFindingSchema`（工具 schema 明确要求
   * 模型写它们），因此 `candidate_findings` 里**一定会**出现——类型不收就等于让消费方去猜。
   */
  readonly reproduction_plan?: readonly string[];
  readonly reproduction_steps?: readonly string[];
  readonly validation_required?: boolean;
  readonly impact?: string;
  readonly remediation?: string;
}

/** 报告分段里的一条：字符串（旧载荷）或对象（设计 schema）。 */
export type ReportItem = string | ReportItemObject;

export interface ReportPayload {
  readonly revision?: number;
  readonly summary?: string;
  readonly facts?: readonly ReportItem[];
  readonly hypotheses?: readonly ReportItem[];
  readonly findings?: readonly ReportItem[];
  /** 设计 §13.4 的字段名；与 `findings` 是同一分段（两个名字都收，见 {@link REPORT_SECTION_ALIASES}）。 */
  readonly candidate_findings?: readonly ReportItem[];
  readonly limitations?: readonly ReportItem[];
}

export interface CompactionPayload {
  readonly summary?: string;
  readonly compactedThroughTurn?: number;
  readonly sourceEventRefs?: readonly string[];
}

/** 待索引的来源事件（账本事件 + 写入侧已解析的归属）。 */
export interface ChunkSourceEvent {
  readonly eventId: string;
  readonly engagementId: string;
  readonly eventType: DomainEventType;
  readonly workerSessionId?: string | null;
  readonly phase?: Phase | null;
  readonly trustLevel: TrustLevel;
  readonly classification: Classification;
  readonly occurredAt: Date | string;
  readonly provisional?: boolean;
  /** 事件负载；结构随事件类型而定。 */
  readonly payload?: unknown;
  /** 可检索文本投影（账本 text_projection，§8.2）。 */
  readonly textProjection?: string | null;
  /** 写入侧从来源事件与工具调用解析出的关联资产。 */
  readonly assetIds?: readonly string[];
  readonly findingIds?: readonly string[];
  readonly evidenceRefs?: readonly string[];
  readonly embeddingRevision?: string | null;
  /**
   * 来源事件里明确出现的目标（命令、URL、资产名…）。
   * 用于 §8.6 的写入侧义务校验，不参与内容生成。
   */
  readonly targetHints?: readonly string[];
}

export interface ChunkingOptions extends WindowOptions {
  /** HTTP 关键头部白名单；未列入的头部不进投影。 */
  readonly httpHeaderAllowList?: readonly string[];
}

/**
 * 默认纳入投影的关键头部；未列入的头部不写入分块。
 * `set-cookie` / `authorization` 属于关键头部（「有没有下发会话」本身就是证据），
 * 但值一律经 {@link SENSITIVE_HEADER} 脱敏，只保留头部名。
 */
const DEFAULT_HTTP_HEADER_ALLOW_LIST = [
  'content-type',
  'content-length',
  'location',
  'server',
  'allow',
  'www-authenticate',
  'cache-control',
  'x-powered-by',
  'set-cookie',
  'authorization',
] as const;

/** 敏感头部名：即便在白名单里也脱敏（写侧投影不落凭据值）。 */
const SENSITIVE_HEADER = /cookie|authorization|auth|token|secret|api[-_]?key|session/i;

// ───────────────────────────── 通用工具 ─────────────────────────────

export function sha256Hex(input: string | Uint8Array): string {
  return createHash('sha256').update(input).digest('hex');
}

/** 由（来源事件、序号、嵌入版本）确定性派生 UUID 形式的分块标识。 */
export function deriveChunkId(input: {
  readonly engagementId: string;
  readonly sourceEventId: string;
  readonly ordinal: number;
  readonly embeddingRevision: string | null;
}): string {
  const seed = [
    'dsh-pentest/memory-chunk/v1',
    input.engagementId,
    input.sourceEventId,
    String(input.ordinal),
    input.embeddingRevision ?? '',
  ].join('|');
  const bytes = Buffer.from(createHash('sha256').update(seed).digest().subarray(0, 16));
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20, 32),
  ].join('-');
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
}

function readString(source: Record<string, unknown>, key: string): string | undefined {
  const v = source[key];
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

function readNumber(source: Record<string, unknown>, key: string): number | undefined {
  const v = source[key];
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

function readStringArray(source: Record<string, unknown>, key: string): readonly string[] {
  const v = source[key];
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
}

function toIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function joinLines(lines: readonly (string | undefined)[]): string {
  return lines.filter((l): l is string => typeof l !== 'undefined' && l.length > 0).join('\n');
}

interface DraftSeed {
  readonly kind: ChunkKind;
  readonly part: ChunkPart | null;
  readonly ordinal: number;
  readonly content: string;
  readonly range: ChunkRange;
  readonly parentRef: string | null;
  readonly indexable: boolean;
}

// ───────────────────────────── 分块计划 ─────────────────────────────

/**
 * 把一条账本事件切成若干分块草稿（§8.5）。
 *
 * 不覆盖的事件类型返回空数组：控制面事件（租约、预算、状态转移等）没有可检索的领域内容，
 * 不属于 §8.5 的分块来源。
 */
export function planChunks(
  event: ChunkSourceEvent,
  options: ChunkingOptions = {},
): readonly ChunkDraft[] {
  if ((REPORT_EVENT_TYPES as readonly string[]).includes(event.eventType)) {
    return chunkReport(event, options);
  }
  if ((TOOL_EVENT_TYPES as readonly string[]).includes(event.eventType)) {
    return chunkToolEvent(event, options);
  }
  const atomicKind = ATOMIC_EVENT_KIND[event.eventType];
  if (atomicKind) {
    return chunkAtomic(event, atomicKind, options);
  }
  return [];
}

const ATOMIC_EVENT_KIND: Partial<Record<DomainEventType, ChunkKind>> = {
  'human.input': 'human_input',
  'human.interjection': 'human_input',
  'human.decision': 'decision',
  'handoff.draft.generated': 'handoff',
  'handoff.edited': 'handoff',
  'handoff.confirmed': 'handoff',
  'context.compacted': 'compaction_summary',
  'llm.reasoning': 'reasoning',
  'llm.assistant.message': 'assistant_message',
};

/** 人类输入、人工决策、交接、压缩摘要、思考链、助手消息：一条事件一个逻辑块。 */
function chunkAtomic(
  event: ChunkSourceEvent,
  kind: ChunkKind,
  options: ChunkingOptions,
): readonly ChunkDraft[] {
  const payload = asRecord(event.payload);
  const content =
    kind === 'compaction_summary'
      ? compactionText(payload)
      : (readString(payload, 'text') ?? readString(payload, 'content') ?? event.textProjection ?? '');
  if (content.length === 0) return [];
  return buildDrafts(event, options, [{ kind, part: null, content, parentRef: null, indexable: true }]);
}

function compactionText(payload: Record<string, unknown>): string {
  const sourceRefs = readStringArray(payload, 'sourceEventRefs');
  const through = readNumber(payload, 'compactedThroughTurn');
  return joinLines([
    `压缩摘要（截至回合 ${through ?? '?'} 的早期回合）`,
    readString(payload, 'summary') ?? '',
    sourceRefs.length > 0 ? `原事件引用: ${sourceRefs.join(', ')}` : '',
  ]);
}

/**
 * 报告分段 → 载荷字段名。
 *
 * `findings` 与 `candidate_findings` 是同一分段：分块器读前者（`ReportSection`），
 * 设计 §13.4 写后者。两个都收，别让命名差异吃掉候选结论。
 */
const REPORT_SECTION_ALIASES: Readonly<Record<ReportSection, readonly string[]>> = {
  summary: ['summary'],
  facts: ['facts'],
  hypotheses: ['hypotheses'],
  findings: ['findings', 'candidate_findings'],
  limitations: ['limitations'],
};

/** 取第一个非空字符串：`??` 会把 `''` 当有值，于是「空 statement + 有 fact」的条目会被静默丢掉。 */
function firstNonEmpty(values: readonly (string | undefined)[]): string {
  for (const value of values) {
    if (value !== undefined && value.length > 0) return value;
  }
  return '';
}

/**
 * 报告条目 → 可嵌入文本。
 *
 * 对象条目渲染成一行 `陈述（置信度 0.9；来源: memory:…）`：置信度、来源与受影响资产
 * 是检索时判断可信度与归属的关键，不能只留正文。
 *
 * **正文为空的对象条目按空处理**（调用方跳过，不产生分块）：它没有可嵌入的内容，
 * 而账本原文仍在事件里——这不是静默丢失。工具 schema 会先一步拒掉这种条目，这里兜的是
 * 历史/手写事件。
 */
function renderReportItem(item: unknown): string {
  if (typeof item === 'string') return item.trim();
  const record = asRecord(item);
  const main = firstNonEmpty([
    readString(record, 'statement'),
    readString(record, 'fact'),
    readString(record, 'title'),
    readString(record, 'text'),
  ]);
  if (main.length === 0) return '';
  const annotations: string[] = [];
  const confidence = record.confidence;
  if (typeof confidence === 'number' && Number.isFinite(confidence)) {
    annotations.push(`置信度 ${String(confidence)}`);
  } else if (typeof confidence === 'string' && confidence.length > 0) {
    // 旧形状把置信度写成 'high'/'medium' 这类标签（实测出现过）。
    annotations.push(`置信度 ${confidence}`);
  }
  const severity = readString(record, 'severity');
  if (severity !== undefined && severity.length > 0) annotations.push(`严重度 ${severity}`);
  // 受影响资产进文本：检索「某主机的某结论」时这是关键线索（评审指出它此前被裁掉）。
  const assets = readStringArray(record, 'affected_assets');
  if (assets.length > 0) annotations.push(`受影响: ${assets.join('、')}`);
  const singleSource = readString(record, 'source');
  const refs = [
    ...readStringArray(record, 'source_refs'),
    ...readStringArray(record, 'evidence_refs'),
    // 旧形状用单数 `source`（一句来源描述）而不是引用数组。
    ...(singleSource === undefined || singleSource.length === 0 ? [] : [singleSource]),
  ];
  if (refs.length > 0) annotations.push(`来源: ${refs.join('、')}`);
  const missing = readStringArray(record, 'missing_evidence');
  if (missing.length > 0) annotations.push(`缺失证据: ${missing.join('、')}`);
  return annotations.length === 0 ? main : `${main}（${annotations.join('；')}）`;
}

/** 读取一个报告分段的所有条目（含别名键），逐条渲染成文本。非数组键按空处理；重复条目只留一份。 */
function readReportItems(source: Record<string, unknown>, section: ReportSection): readonly string[] {
  const out: string[] = [];
  // `findings` 与 `candidate_findings` 是同一分段的两个名字：**同时出现时不去重会成块两遍**，
  // 检索面于是把同一批候选结论各存一份（不是崩溃，但是脏数据）。
  const seen = new Set<string>();
  for (const key of REPORT_SECTION_ALIASES[section]) {
    const value = source[key];
    if (!Array.isArray(value)) continue;
    for (const item of value) {
      const text = renderReportItem(item);
      if (text.length === 0 || seen.has(text)) continue;
      seen.add(text);
      out.push(text);
    }
  }
  return out;
}

/**
 * 报告载荷 → 各分段的**可嵌入文本**（顺序与 {@link REPORT_SECTIONS} 一致）。
 *
 * 这是报告载荷的**唯一读取器**：分块（{@link chunkReport}）与检索侧「按内容回推分块种类」
 * （`pg-memory-query.ts` / `pg-worker-tools.ts` 的 `deriveChunkKind`）都走它。
 *
 * 为什么必须共用：回推侧此前各写一份私有实现，只读**顶层**键、只认**字符串**条目，
 * 于是信封形状（`{…, payload:{facts:[{statement,…}]}}`）的报告在回推时全部落回父种类
 * `report_summary`——而 `MemorySearchRequest.kinds` 是精确过滤，
 * `kinds:['fact']` 于是取不到刚写进去的事实块（外形是「检索不到」，根因是两侧读取规则不同）。
 *
 * 取值规则：逐分段**先嵌套后顶层**回退（两种纯形状都收；混合形状也不丢顶层分段）。
 */
export function reportSectionTexts(payload: unknown): readonly string[] {
  const envelope = asRecord(payload);
  const nested = asRecord(envelope.payload);
  const body = Object.keys(nested).length > 0 ? nested : envelope;
  return REPORT_SECTIONS.map((section) => {
    if (section === 'summary') {
      return readString(body, 'summary') ?? readString(envelope, 'summary') ?? '';
    }
    const items = readReportItems(body, section);
    return (items.length > 0 ? items : readReportItems(envelope, section)).join('\n');
  });
}

/** 无法归类时的兜底种类（§8.9：观察经规范化后即为事实）。显式兜底，不静默丢弃内容。 */
const UNCLASSIFIED_CHUNK_KIND: ChunkKind = 'fact';

/** 事件类型 → 可能的分块种类（{@link CHUNK_KIND_EVENT_TYPES} 的逆索引，按 `CHUNK_KINDS` 顺序）。 */
const KINDS_BY_EVENT_TYPE: Readonly<Record<string, readonly ChunkKind[]>> = (() => {
  const index: Record<string, ChunkKind[]> = {};
  for (const kind of CHUNK_KINDS) {
    for (const eventType of CHUNK_KIND_EVENT_TYPES[kind]) {
      const list = (index[eventType] ??= []);
      if (!list.includes(kind)) list.push(kind);
    }
  }
  return index;
})();

/** 报告类分段对应的分块种类，按 {@link REPORT_SECTIONS} 的声明顺序。 */
const REPORT_SECTION_KINDS: readonly ChunkKind[] = CHUNK_KINDS.filter(
  (kind) => CHUNK_KIND_EVENT_TYPES[kind] === REPORT_EVENT_TYPES,
);

/**
 * 从数据库行还原分块种类（§8.5 的分块类型）。
 *
 * `memory_chunks` 没有 kind 列（§9.2），只能按来源回推：
 * - 条目来源（`memory_item_id`）：条目自身声明的种类；
 * - 事件类型只对应一个种类：直接取；
 * - 报告类事件：按分块内容落在哪个分段的原文里定位分段，再取该分段对应的种类——
 *   分段原文来自 {@link reportSectionTexts}，**与分块器同一份读取规则**；
 * - 工具类事件：只能还原到父种类 `tool_observation`——HTTP 交换与二进制证据的细分在
 *   `memory_chunks` 上没有落点（§8.5 对「流量与二进制」的特殊处理由 `indexable` 承担）；
 * - 无法归类：落到 {@link UNCLASSIFIED_CHUNK_KIND}。
 *
 * **只有这一份实现**（控制台读路径与 Worker 工具读路径都导入它）：`MemorySearchRequest.kinds`
 * 是**精确**过滤，两侧若各写一份还原规则，同一个 kinds 过滤会在控制台与 Worker 上给出不同结果
 * ——此前正是如此（两份私有副本各自漂移，信封形状的报告全部被回推成父种类）。
 *
 * `report_payload` 必须是**账本里的 `payload_json` 原样**（信封形状也要原样传进来，
 * 读取规则里已经拆信封）：再包一层或先取 `.payload` 都会让分段定位失效。
 */
export function deriveChunkKind(row: {
  readonly item_kind: string | null;
  readonly event_type: string | null;
  readonly content: string;
  readonly report_payload: unknown;
}): ChunkKind {
  if (row.item_kind !== null && isChunkKind(row.item_kind)) return row.item_kind;
  const eventType = row.event_type;
  if (eventType === null) return UNCLASSIFIED_CHUNK_KIND;

  const candidates = KINDS_BY_EVENT_TYPE[eventType] ?? [];
  const only = candidates[0];
  if (candidates.length === 1 && only !== undefined) return only;
  if (candidates.length === 0) return UNCLASSIFIED_CHUNK_KIND;

  if ((REPORT_EVENT_TYPES as readonly string[]).includes(eventType)) {
    const texts = reportSectionTexts(row.report_payload);
    const matched = texts
      .map((text, index) => (text.length > 0 && text.includes(row.content) ? index : -1))
      .filter((index) => index >= 0);
    // 多段同时包含（分段文本互相重合）时不做猜测：退回报告父种类。
    const onlyIndex = matched[0];
    if (
      REPORT_SECTION_KINDS.length === REPORT_SECTIONS.length &&
      matched.length === 1 &&
      onlyIndex !== undefined
    ) {
      return REPORT_SECTION_KINDS[onlyIndex] ?? 'report_summary';
    }
    return 'report_summary';
  }

  if ((TOOL_EVENT_TYPES as readonly string[]).includes(eventType)) return 'tool_observation';
  return UNCLASSIFIED_CHUNK_KIND;
}

function chunkReport(event: ChunkSourceEvent, options: ChunkingOptions): readonly ChunkDraft[] {
  // 报告正文可能整体落在信封里：写入侧写的是
  // `{reportId, status, objective, summary, payload: <报告>}`（`pg-worker-tools.ts`），
  // 而设计 §7.1 的 schema 描述的是 `payload` 本身。取值规则在 `reportSectionTexts` 里
  // ——**与检索侧的回推共用同一份**，两侧不一致会让 kinds 过滤取不到内容。
  const texts = reportSectionTexts(event.payload);
  const seeds: Omit<DraftSeed, 'ordinal' | 'range'>[] = [];
  for (const [index, section] of REPORT_SECTIONS.entries()) {
    const text = texts[index] ?? '';
    if (text.length === 0) continue;
    seeds.push({
      kind: REPORT_SECTION_KIND[section],
      part: section,
      content: text,
      parentRef: event.eventId,
      indexable: true,
    });
  }
  return buildDrafts(event, options, seeds);
}

/** 工具事件：按内容类型分流到 HTTP/JSON 元数据、二进制元数据或工具输出分组。 */
function chunkToolEvent(event: ChunkSourceEvent, options: ChunkingOptions): readonly ChunkDraft[] {
  const payload = asRecord(event.payload);
  const contentType = readString(payload, 'contentType');
  const http = asRecord(payload['http']);
  if (
    contentType === 'http' ||
    contentType === 'json' ||
    http['statusCode'] !== undefined ||
    http['bodySummary'] !== undefined
  ) {
    return chunkHttpExchange(event, options);
  }
  if (contentType === 'binary' || asRecord(payload['binary'])['sha256'] !== undefined) {
    return chunkBinaryEvidence(event, options);
  }
  return chunkToolOutput(event, options);
}

/** 工具输出：命令、标准输出、错误输出、退出码分组；超长按固定窗口重叠切分。 */
function chunkToolOutput(event: ChunkSourceEvent, options: ChunkingOptions): readonly ChunkDraft[] {
  const payload = asRecord(event.payload);
  const parentRef = readString(payload, 'toolRunId') ?? null;
  const seeds: Omit<DraftSeed, 'ordinal' | 'range'>[] = [];

  const command = readString(payload, 'command');
  const target = readString(payload, 'target');
  const startedAt = readString(payload, 'startedAt');
  if (command !== undefined || target !== undefined || startedAt !== undefined) {
    seeds.push({
      kind: 'tool_observation',
      part: 'command',
      content: joinLines([
        '工具调用',
        target ? `目标: ${target}` : undefined,
        command ? `命令: ${command}` : undefined,
        startedAt ? `开始: ${startedAt}` : undefined,
      ]),
      parentRef,
      indexable: true,
    });
  }

  const stdout = readString(payload, 'stdout');
  if (stdout) {
    seeds.push({ kind: 'tool_observation', part: 'stdout', content: stdout, parentRef, indexable: true });
  }
  const stderr = readString(payload, 'stderr');
  if (stderr) {
    seeds.push({ kind: 'tool_observation', part: 'stderr', content: stderr, parentRef, indexable: true });
  }

  const exitCode = readNumber(payload, 'exitCode');
  const status = readString(payload, 'status');
  const exitLine = joinLines([
    '执行结果',
    typeof exitCode === 'number' ? `退出码: ${exitCode}` : undefined,
    status ? `状态: ${status}` : undefined,
  ]);
  if (exitCode !== undefined || status !== undefined) {
    seeds.push({ kind: 'tool_observation', part: 'exit', content: exitLine, parentRef, indexable: true });
  }

  return buildDrafts(event, options, seeds);
}

/** HTTP 与 JSON：元数据、状态码、路径、关键头部与正文摘要；原始正文只作加密证据关联。 */
function chunkHttpExchange(event: ChunkSourceEvent, options: ChunkingOptions): readonly ChunkDraft[] {
  const payload = asRecord(event.payload);
  const nested = asRecord(payload['http']);
  const http = Object.keys(nested).length > 0 ? nested : payload;
  const allowList = options.httpHeaderAllowList ?? DEFAULT_HTTP_HEADER_ALLOW_LIST;
  const headers = asRecord(http['headers']);

  const headerLines: string[] = [];
  for (const [name, value] of Object.entries(headers)) {
    const key = name.toLowerCase();
    if (!allowList.includes(key)) continue;
    const rendered = SENSITIVE_HEADER.test(key) ? '«redacted»' : String(value);
    headerLines.push(`  ${key}: ${rendered}`);
  }

  const evidenceRefs: string[] = [];
  const rawBodyRef = readString(http, 'rawBodyRef');
  if (rawBodyRef) evidenceRefs.push(rawBodyRef);

  const content = joinLines([
    'HTTP 交换',
    readString(http, 'method') ? `方法: ${readString(http, 'method')}` : undefined,
    readString(http, 'path') ?? readString(http, 'url')
      ? `路径: ${readString(http, 'path') ?? readString(http, 'url')}`
      : undefined,
    readNumber(http, 'statusCode') !== undefined ? `状态码: ${readNumber(http, 'statusCode')}` : undefined,
    headerLines.length > 0 ? joinLines(['关键头部:', ...headerLines]) : undefined,
    readString(http, 'bodySummary') ? `正文摘要: ${readString(http, 'bodySummary')}` : undefined,
    readString(http, 'bodyDigest') ? `正文 SHA-256: ${readString(http, 'bodyDigest')}` : undefined,
    rawBodyRef ? `原始正文: 加密证据 ${rawBodyRef}` : undefined,
  ]);
  if (content.length === 0) return [];

  return buildDrafts(event, options, [
    { kind: 'http_exchange', part: 'http_metadata', content, parentRef: null, indexable: true, evidenceRefs },
  ]);
}

/** 流量与二进制：只存证据元数据、协议解析摘要与哈希，不直接做全文嵌入。 */
function chunkBinaryEvidence(event: ChunkSourceEvent, options: ChunkingOptions): readonly ChunkDraft[] {
  const payload = asRecord(event.payload);
  const binary = asRecord(payload['binary']);
  const extractedTextRef = readString(binary, 'extractedTextRef');
  const evidenceRefs = extractedTextRef ? [extractedTextRef] : [];

  const content = joinLines([
    '二进制证据元数据',
    readString(binary, 'mimeType') ? `MIME: ${readString(binary, 'mimeType')}` : undefined,
    readNumber(binary, 'byteLength') !== undefined ? `字节数: ${readNumber(binary, 'byteLength')}` : undefined,
    readString(binary, 'sha256') ? `SHA-256: ${readString(binary, 'sha256')}` : undefined,
    readString(binary, 'protocolSummary') ? `协议解析摘要: ${readString(binary, 'protocolSummary')}` : undefined,
    extractedTextRef ? `按需提取文本: 证据 ${extractedTextRef}（不内联、不嵌入）` : undefined,
  ]);
  if (content.length === 0) return [];

  return buildDrafts(event, options, [
    {
      kind: 'binary_evidence',
      part: 'binary_metadata',
      content,
      parentRef: null,
      indexable: false,
      evidenceRefs,
    },
  ]);
}

/**
 * 把组内分段统一编号、按窗口切分、补齐确定性标识与哈希。
 * 序号在一条来源事件内连续（数据库唯一索引 (source_event_id, ordinal, embedding_revision)）。
 */
function buildDrafts(
  event: ChunkSourceEvent,
  options: ChunkingOptions,
  seeds: readonly (Omit<DraftSeed, 'ordinal' | 'range'> & {
    readonly evidenceRefs?: readonly string[];
  })[],
): readonly ChunkDraft[] {
  const createdAt = toIso(event.occurredAt);
  const embeddingRevision = event.embeddingRevision ?? null;
  const provisional = event.provisional === true;
  const drafts: ChunkDraft[] = [];
  let ordinal = 0;

  for (const seed of seeds) {
    for (const window of splitFixedWindow(seed.content, options)) {
      drafts.push({
        chunkId: deriveChunkId({
          engagementId: event.engagementId,
          sourceEventId: event.eventId,
          ordinal,
          embeddingRevision,
        }),
        dedupeKey: `${event.eventId}|${ordinal}|${embeddingRevision ?? ''}`,
        kind: seed.kind,
        part: seed.part,
        ordinal,
        content: window.text,
        contentHash: sha256Hex(window.text),
        range: { start: window.start, end: window.end },
        sourceEventId: event.eventId,
        parentRef: seed.parentRef,
        engagementId: event.engagementId,
        workerSessionId: event.workerSessionId ?? null,
        phase: event.phase ?? null,
        trustLevel: event.trustLevel,
        classification: event.classification,
        assetIds: [...(event.assetIds ?? [])],
        findingIds: [...(event.findingIds ?? [])],
        evidenceRefs: [...(event.evidenceRefs ?? []), ...(seed.evidenceRefs ?? [])],
        provisional,
        embeddingRevision,
        indexable: seed.indexable,
        createdAt,
      });
      ordinal += 1;
    }
  }
  return drafts;
}

// ───────────────────────────── 写入侧义务校验（§8.6） ─────────────────────────────

type ChunkWriteCheck =
  | { readonly ok: true }
  | { readonly ok: false; readonly code: ErrorCode; readonly detail: string };

interface ChunkAssetObligationInput {
  readonly kind: ChunkKind;
  readonly assetIds: readonly string[];
  readonly sourceEventId: string;
  /** 来源事件里明确出现的目标；为空表示解析不出归属。 */
  readonly targetHints: readonly string[];
}

/**
 * §8.6 写入侧义务：凡是能确定资产归属的分块，写入时必须填齐 asset_ids。
 *
 * 只在「来源事件明确含目标」且「可归属的记忆类型」时才拒绝；
 * 人类输入、决策、交接、压缩摘要、思考链本来就无资产归属，允许留空。
 */
export function checkChunkAssetObligation(input: ChunkAssetObligationInput): ChunkWriteCheck {
  if (input.kind === undefined || !isChunkKind(input.kind)) {
    return { ok: false, code: 'classification_rejected', detail: `未知记忆类型: ${String(input.kind)}` };
  }
  if (input.assetIds.length > 0) return { ok: true };
  if (input.targetHints.length === 0) return { ok: true };
  if ((ASSET_OPTIONAL_KINDS as readonly string[]).includes(input.kind)) return { ok: true };
  return {
    ok: false,
    code: 'target_not_adjudicated',
    detail:
      `来源事件 ${input.sourceEventId} 明确含目标（${input.targetHints.join(', ')}），` +
      `但 ${input.kind} 分块未填 asset_ids，拒绝写入`,
  };
}

/** 批量校验：任何一个分块不满足写入义务即整体拒绝。 */
export function checkChunkBatchWritable(
  input: {
    readonly chunks: readonly Pick<ChunkDraft, 'kind' | 'assetIds' | 'sourceEventId'>[];
    readonly targetHints: readonly string[];
  },
): ChunkWriteCheck {
  for (const chunk of input.chunks) {
    const verdict = checkChunkAssetObligation({
      kind: chunk.kind,
      assetIds: chunk.assetIds,
      sourceEventId: chunk.sourceEventId,
      targetHints: input.targetHints,
    });
    if (!verdict.ok) return verdict;
  }
  return { ok: true };
}
