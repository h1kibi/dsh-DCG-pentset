/**
 * 上下文压缩（设计文档 §8.10；配合 §8.1 记忆分层、§8.5 分块策略、§8.8 上下文组装）。
 *
 * 本模块是**纯逻辑**：不访问数据库、不调用模型、不改状态机与权限。
 * 它只回答四个问题——何时压缩、压缩什么、摘要长什么样、漂移怎么追溯。
 *
 * §8.10 的三条硬约束在这里逐条落地：
 *   1. 触发在**回合边界**评估，不在工具执行中途（否则会切断正在进行的工具调用）；
 *   2. 顺序固定为**先截断超大工具输出、再压缩早期回合**（工具输出通常是体积主因，
 *      先处理它往往已足够，避免过早丢失推理链条）；
 *   3. 压缩**必须连同推理内容一起处理**——DeepSeek 思考模式在请求带工具时要求把
 *      此前各轮的 `reasoning_content` 一并回传，只压正文会直接报错。
 *
 * §8.10 末尾给出的「永不压缩」清单按事件类型落到 {@link PINNED_ENTRY_KINDS}：
 *   > **完整保留**：- Agent 身份、职责说明与已装载 skill 的说明 - 人类确认的任务提示词
 *   > - 人类确认的交接内容与被截断项说明 - 全部人工决策与插话 - 最近若干回合（默认 6 轮）的完整内容，含推理
 *   > **不改变语义**：压缩只影响活跃上下文，不改变状态机、权限、放行要求或审计完整性。
 *   > 人类决策与交接内容永不被压缩。
 *
 * 压缩之所以**自动执行、不等人批准**（§8.10「为什么压缩自动执行、不等人批准」）：
 * 原始事件是权威副本且永久保留，摘要只是活跃上下文的可丢弃衍生品——风险由三条约束控制，
 * 而不是由人工逐次批准控制：
 *   > 因此压缩自动执行，风险由三条约束控制：摘要可信度降级为 Agent 陈述、
 *   > 必须携带原事件引用、记录压缩链。
 * 这三条分别由 {@link buildCompactionSummary}（可信度固定为 `agent_claim` 且强制带引用）、
 * {@link checkCompactionSummary} 与 {@link CompactionChain} 承载。
 */

import type { TrustLevel } from '../contracts.ts';
import { DEFAULTS } from '../contracts.ts';
import { sha256Hex, type CompactionPayload } from './chunks.ts';

/** 压缩策略版本。进入 `context.compacted` 事件的负载，便于回溯摘要由哪版策略产出。 */
export const COMPACTION_STRATEGY_VERSION = 'compaction-v1';

// ───────────────────────────── 会话历史条目 ─────────────────────────────

/**
 * 模型可见历史的条目类别。
 *
 * 与 §8.5 的分块类型（`ChunkKind`）是两个范畴：分块是**检索**用的记忆单元，
 * 这里是**活跃上下文**里被保留/截断/摘要化的单元。二者的对应关系：
 *   - `reasoning` ↔ `llm.reasoning` 事件（思考链，§8.3）；
 *   - `tool_observation` ↔ `tool.result` / `tool.artifact`；
 *   - `compaction_summary` ↔ `context.compacted`；
 *   - 人工类条目 ↔ `human.input` / `human.interjection` / `human.decision`。
 */
export const HISTORY_ENTRY_KINDS = [
  /** Agent 身份与职责说明（§8.8 第 1 项）。 */
  'system_identity',
  /** 已装载 skill 的说明（§8.8 第 2 项）。 */
  'skill_instructions',
  /** 人类确认的任务提示词（§8.8 第 5 项）。 */
  'task_prompt',
  /** 人类确认的交接内容与被截断项说明（§8.8 第 6 项）。 */
  'handoff',
  'human_input',
  'human_interjection',
  'human_decision',
  'assistant_message',
  /** 推理内容（`reasoning_content`）。 */
  'reasoning',
  'tool_call',
  'tool_observation',
  /** 早前压缩产出的摘要（会被逐级压缩）。 */
  'compaction_summary',
] as const;
export type HistoryEntryKind = (typeof HISTORY_ENTRY_KINDS)[number];

/**
 * **永不压缩**的条目类别，逐条对应 §8.10「完整保留」的四条与「不改变语义」末句
 * （人类决策与交接内容永不被压缩）。这些条目既不被摘要化，也不被截断：
 * 截断同样是有损处理，对人工决策与人类交接做有损处理等于改写人的意志。
 */
export const PINNED_ENTRY_KINDS = [
  'system_identity',
  'skill_instructions',
  'task_prompt',
  'handoff',
  'human_input',
  'human_interjection',
  'human_decision',
] as const satisfies readonly HistoryEntryKind[];
type PinnedEntryKind = (typeof PINNED_ENTRY_KINDS)[number];

const PINNED_KIND: Readonly<Partial<Record<HistoryEntryKind, true>>> = {
  system_identity: true,
  skill_instructions: true,
  task_prompt: true,
  handoff: true,
  human_input: true,
  human_interjection: true,
  human_decision: true,
};

/**
 * 该类别是否「永不压缩」。命名即契约：§8.10「人类决策与交接内容永不被压缩」，
 * 以及「完整保留」清单里的身份、skill、任务提示词。
 */
function isNeverCompacted(kind: HistoryEntryKind): boolean {
  return PINNED_KIND[kind] === true;
}

/** 可被截断的条目类别（§8.10「先截断超大工具输出」）。 */
export const TOOL_OUTPUT_ENTRY_KINDS = ['tool_call', 'tool_observation'] as const satisfies
  readonly HistoryEntryKind[];
type ToolOutputEntryKind = (typeof TOOL_OUTPUT_ENTRY_KINDS)[number];

const TOOL_OUTPUT_KIND: Readonly<Partial<Record<HistoryEntryKind, true>>> = {
  tool_call: true,
  tool_observation: true,
};

/**
 * 模型可见历史中的一条条目。
 *
 * `eventRef` 是账本事件引用，压缩摘要的引用集合由它构成——§8.10 要求
 * 「原始事件仍完整保留在账本与索引中，可以随时检索回来」，引用的锚点就是事件标识。
 */
export interface HistoryEntry {
  readonly entryId: string;
  /** 账本事件引用：摘要引用的落点。 */
  readonly eventRef: string;
  readonly kind: HistoryEntryKind;
  /**
   * 所属回合号（从 1 开始）。回合是压缩的最小单位。
   * 非回合类条目（身份、skill、任务提示词、交接）留空。
   */
  readonly turn: number | null;
  /** 已知用量；缺省时按 {@link estimateEntryTokens} 估算。 */
  readonly tokens?: number;
  readonly content?: string;
  readonly toolName?: string;
  /** 证据引用（§8.10：截断时保留首尾与证据引用）。 */
  readonly evidenceRefs?: readonly string[];
  readonly trustLevel?: TrustLevel;
  /** `kind === 'compaction_summary'` 时指向摘要本体。 */
  readonly summaryId?: string;
  /** `kind === 'compaction_summary'` 时该摘要覆盖到的回合号。 */
  readonly compactedThroughTurn?: number;
}

// ───────────────────────────── 规模估算 ─────────────────────────────

/**
 * 粗略 token 估算：CJK 按 1 token/字，其余按 4 字符/token，向上取整。
 *
 * 估算只用于**阈值判定**（§8.10 的 60% 触发线），不用于计费。
 * 窗口大小由调用方传入，本模块不硬编码任何模型（§8.10：默认值只是默认值）。
 */
export function estimateTokens(text: string): number {
  if (text.length === 0) return 0;
  let cjk = 0;
  let other = 0;
  for (const ch of text) {
    const cp = ch.codePointAt(0) ?? 0;
    if (isCjkCodePoint(cp)) cjk += 1;
    else other += 1;
  }
  return Math.ceil(cjk + other / 4);
}

function isCjkCodePoint(cp: number): boolean {
  return (
    (cp >= 0x2e80 && cp <= 0x9fff) || // CJK 部首、假名、统一表意文字
    (cp >= 0xf900 && cp <= 0xfaff) || // 兼容表意文字
    (cp >= 0xff00 && cp <= 0xff60) || // 全角形式
    (cp >= 0x20000 && cp <= 0x3ffff) // 扩展 B 及以上
  );
}

function estimateEntryTokens(entry: HistoryEntry): number {
  if (typeof entry.tokens === 'number') return entry.tokens;
  return estimateTokens(entry.content ?? '');
}

function estimateHistoryTokens(entries: readonly HistoryEntry[]): number {
  let total = 0;
  for (const entry of entries) total += estimateEntryTokens(entry);
  return total;
}

// ───────────────────────────── 触发判定 ─────────────────────────────

interface CompactionTriggerInput {
  /** 模型上下文窗口大小（由调用方按模型路由给出，不在本模块硬编码）。 */
  readonly contextWindowTokens: number;
  /** 当前请求的估算规模（历史 + 提示词 + 工具输出）。 */
  readonly estimatedRequestTokens: number;
  /**
   * 是否处于回合边界。§8.10：
   * 「触发时机：在回合边界评估，不在工具执行中途……回合边界保证压缩不会切断正在进行的工具调用。」
   */
  readonly atTurnBoundary: boolean;
  /** 触发比例，默认 {@link DEFAULTS.compactionTriggerRatio}（0.6）。 */
  readonly triggerRatio?: number;
}

function resolveTriggerRatio(input: CompactionTriggerInput): number {
  const ratio = input.triggerRatio ?? DEFAULTS.compactionTriggerRatio;
  if (!Number.isFinite(ratio) || ratio <= 0) {
    throw new RangeError('triggerRatio 必须是 > 0 的有限数');
  }
  return ratio;
}

/** 当前上下文压力（估算请求量 / 窗口大小）。 */
export function contextPressure(input: CompactionTriggerInput): number {
  if (!Number.isFinite(input.contextWindowTokens) || input.contextWindowTokens <= 0) {
    throw new RangeError('contextWindowTokens 必须是 > 0 的有限数');
  }
  if (!Number.isFinite(input.estimatedRequestTokens) || input.estimatedRequestTokens < 0) {
    throw new RangeError('estimatedRequestTokens 必须是 >= 0 的有限数');
  }
  return input.estimatedRequestTokens / input.contextWindowTokens;
}

/**
 * 是否应当压缩。
 *
 * 两个条件同时成立才返回 true：
 *   1. 处于回合边界（工具执行中途一律不压缩，即使已经超限）；
 *   2. 估算请求量**超过**「窗口 × 触发比例」（恰好等于阈值不触发）。
 */
export function shouldCompact(input: CompactionTriggerInput): boolean {
  const ratio = resolveTriggerRatio(input);
  const pressure = contextPressure(input);
  if (!input.atTurnBoundary) return false;
  return pressure > ratio;
}

// ───────────────────────────── 工具输出截断 ─────────────────────────────

export const COMPACTION_TRUNCATION_DEFAULTS = {
  /** 超过该规模的工具输出参与截断。 */
  toolOutputTokenLimit: 2_048,
  /** 保留的首部字符数。 */
  headChars: 1_600,
  /** 保留的尾部字符数。 */
  tailChars: 600,
} as const;

interface ToolOutputTruncationInput {
  readonly text: string;
  /** 账本事件引用：省略标记里必须写清完整内容去哪儿取。 */
  readonly eventRef: string;
  readonly evidenceRefs?: readonly string[];
  readonly headChars?: number;
  readonly tailChars?: number;
}

interface ToolOutputTruncation {
  readonly text: string;
  readonly headChars: number;
  readonly tailChars: number;
  readonly omittedChars: number;
  readonly evidenceRefs: readonly string[];
  readonly marker: string;
}

/**
 * 截断超大工具输出：保留首尾与证据引用，中间标注被省略（§8.10「顺序」）。
 *
 * 省略标记显式写出「完整输出见账本事件/证据引用」，使模型知道自己少了什么，
 * 而不是把一段被砍过的输出当作完整观测（否则截断本身就成了静默的信息丢失）。
 */
export function truncateToolOutput(input: ToolOutputTruncationInput): ToolOutputTruncation {
  const headChars = input.headChars ?? COMPACTION_TRUNCATION_DEFAULTS.headChars;
  const tailChars = input.tailChars ?? COMPACTION_TRUNCATION_DEFAULTS.tailChars;
  if (!Number.isInteger(headChars) || headChars < 0) throw new RangeError('headChars 必须是 >= 0 的整数');
  if (!Number.isInteger(tailChars) || tailChars < 0) throw new RangeError('tailChars 必须是 >= 0 的整数');

  const evidenceRefs = uniqueStrings(input.evidenceRefs ?? []);
  if (headChars + tailChars >= input.text.length) {
    return {
      text: input.text,
      headChars,
      tailChars,
      omittedChars: 0,
      evidenceRefs,
      marker: '',
    };
  }
  const omittedChars = input.text.length - headChars - tailChars;
  const marker = truncationMarker(omittedChars, input.eventRef, evidenceRefs);
  return {
    text: `${input.text.slice(0, headChars)}${marker}${tailChars === 0 ? '' : input.text.slice(-tailChars)}`,
    headChars,
    tailChars,
    omittedChars,
    evidenceRefs,
    marker,
  };
}

function truncationMarker(
  omittedChars: number,
  eventRef: string,
  evidenceRefs: readonly string[],
): string {
  const evidence = evidenceRefs.length > 0 ? `，证据引用 ${evidenceRefs.join(', ')}` : '';
  return `\n…[已省略 ${omittedChars} 字符；完整输出见账本事件 ${eventRef}${evidence}]…\n`;
}

// ───────────────────────────── 压缩计划 ─────────────────────────────

/** 保留理由。`human_content` 覆盖人工决策与插话（§8.10「全部人工决策与插话」）。 */
type KeepReason =
  | 'identity'
  | 'skill_instructions'
  | 'task_prompt'
  | 'handoff'
  | 'human_content'
  | 'protected_turn'
  | 'unattributed';

const KEEP_REASON_BY_KIND: Readonly<Partial<Record<PinnedEntryKind, KeepReason>>> = {
  system_identity: 'identity',
  skill_instructions: 'skill_instructions',
  task_prompt: 'task_prompt',
  handoff: 'handoff',
  human_input: 'human_content',
  human_interjection: 'human_content',
  human_decision: 'human_content',
};

interface KeepDecision {
  readonly entryId: string;
  readonly turn: number | null;
  readonly kind: HistoryEntryKind;
  readonly reason: KeepReason;
}

/** 截断发生在保留窗口内还是压缩范围内。 */
type TruncationScope = 'protected' | 'compressed';

interface TruncationDecision {
  readonly entryId: string;
  readonly turn: number | null;
  readonly kind: ToolOutputEntryKind;
  readonly toolName: string | null;
  readonly scope: TruncationScope;
  readonly tokensBefore: number;
  readonly tokensAfter: number;
  readonly headChars: number;
  readonly tailChars: number;
  readonly omittedChars: number;
  readonly marker: string;
  readonly eventRef: string;
  readonly evidenceRefs: readonly string[];
}

interface CompressDecision {
  readonly turn: number;
  readonly entryIds: readonly string[];
  /** 该回合被压缩的推理条目（§8.10：压缩必须连同推理内容一起处理）。 */
  readonly reasoningEntryIds: readonly string[];
  readonly tokens: number;
  readonly reasoningTokens: number;
}

/** §8.10「顺序」的固定步骤：先截断超大工具输出，再压缩早期回合。 */
export const COMPACTION_STEPS = ['truncate_tool_outputs', 'compress_early_turns'] as const;
type CompactionStep = (typeof COMPACTION_STEPS)[number];

interface CompactionPlanOptions {
  /** 完整保留的最近回合数，默认 {@link DEFAULTS.compactionKeepRecentTurns}（6 轮）。 */
  readonly keepRecentTurns?: number;
  /** 触发截断的工具输出规模阈值。 */
  readonly toolOutputTokenLimit?: number;
  readonly headChars?: number;
  readonly tailChars?: number;
}

export interface CompactionPlan {
  readonly strategyVersion: string;
  readonly keepRecentTurns: number;
  /** 受保护的回合号（最多 keepRecentTurns 个，升序）。 */
  readonly protectedTurns: readonly number[];
  /** 不被摘要化的条目（超大工具输出可能已按 §8.10 先行截断）。 */
  readonly keep: readonly KeepDecision[];
  readonly truncate: readonly TruncationDecision[];
  readonly compress: readonly CompressDecision[];
  /** 固定步骤顺序（§8.10）。执行者据此排序，不自行决定先压后截。 */
  readonly steps: readonly CompactionStep[];
  /**
   * 本次压缩的输入是否包含更早的摘要（§8.10「逐级压缩」）。
   * 非空即表示这是至少第二代压缩，漂移链由 {@link appendCompactionLink} 记录。
   */
  readonly baseSummaryIds: readonly string[];
  /** 会话应写入 `compacted_through_turn` 的值；无压缩时为 null。 */
  readonly compactedThroughTurn: number | null;
  readonly fromTurn: number | null;
  readonly estimatedTokensBefore: number;
  /** 仅执行截断步骤后的估算规模：用于判断「先截断往往已足够」。 */
  readonly estimatedTokensAfterTruncation: number;
  /**
   * 执行完整计划后活跃上下文的估算规模（保留条目 + 截断后文本）。
   * 被压缩回合改写为摘要，摘要自身规模在 {@link buildCompactionSummary} 产出后回填，
   * 因此这里给出的不含摘要，是**下界**。
   */
  readonly estimatedRetainedTokens: number;
}

interface CompactionPlanInput {
  readonly entries: readonly HistoryEntry[];
  readonly options?: CompactionPlanOptions;
}

/**
 * 产出压缩计划：完整保留 / 截断 / 压缩三类划分。
 *
 * 划分规则（§8.10）：
 *   - 永不压缩的条目按 {@link PINNED_ENTRY_KINDS} 逐条保留；
 *   - 最近 `keepRecentTurns` 个回合整体保留（含推理）；
 *   - 更早回合整体进压缩，**连同其中的推理内容**；
 *   - 超大工具输出无论落在哪个区间都先截断（§8.10 未对截断限定回合范围，
 *     且它只处理工具输出的中间段，不触碰推理链条）。
 */
export function planCompaction(input: CompactionPlanInput): CompactionPlan {
  const options = input.options ?? {};
  const keepRecentTurns = options.keepRecentTurns ?? DEFAULTS.compactionKeepRecentTurns;
  if (!Number.isInteger(keepRecentTurns) || keepRecentTurns < 1) {
    throw new RangeError('keepRecentTurns 必须是 >= 1 的整数');
  }
  const toolOutputTokenLimit =
    options.toolOutputTokenLimit ?? COMPACTION_TRUNCATION_DEFAULTS.toolOutputTokenLimit;

  const entries = input.entries;
  const turns = orderedTurns(entries);
  const protectedTurns = turns.slice(Math.max(0, turns.length - keepRecentTurns));
  const protectedSet = new Set(protectedTurns);

  const keep: KeepDecision[] = [];
  const truncate: TruncationDecision[] = [];
  const byTurn = new Map<number, HistoryEntry[]>();
  const baseSummaryIds: string[] = [];

  for (const entry of entries) {
    if (isNeverCompacted(entry.kind)) {
      keep.push({
        entryId: entry.entryId,
        turn: entry.turn,
        kind: entry.kind,
        reason: KEEP_REASON_BY_KIND[entry.kind as PinnedEntryKind] ?? 'human_content',
      });
      continue;
    }
    if (entry.turn === null) {
      // 压缩以回合为最小单位；无回合归属的条目不进压缩范围。
      keep.push({
        entryId: entry.entryId,
        turn: null,
        kind: entry.kind,
        reason: 'unattributed',
      });
      continue;
    }
    if (protectedSet.has(entry.turn)) {
      keep.push({
        entryId: entry.entryId,
        turn: entry.turn,
        kind: entry.kind,
        reason: 'protected_turn',
      });
      continue;
    }
    const group = byTurn.get(entry.turn);
    if (group === undefined) byTurn.set(entry.turn, [entry]);
    else group.push(entry);
    if (entry.kind === 'compaction_summary' && entry.summaryId !== undefined) {
      baseSummaryIds.push(entry.summaryId);
    }
  }

  // 步骤一：截断超大工具输出（保留首尾与证据引用）。
  for (const entry of entries) {
    if (TOOL_OUTPUT_KIND[entry.kind] !== true) continue;
    const tokensBefore = estimateEntryTokens(entry);
    if (tokensBefore <= toolOutputTokenLimit) continue;
    const truncated = truncateToolOutput({
      text: entry.content ?? '',
      eventRef: entry.eventRef,
      evidenceRefs: entry.evidenceRefs ?? [],
      headChars: options.headChars,
      tailChars: options.tailChars,
    });
    if (truncated.omittedChars === 0) continue;
    truncate.push({
      entryId: entry.entryId,
      turn: entry.turn,
      kind: entry.kind as ToolOutputEntryKind,
      toolName: entry.toolName ?? null,
      scope: entry.turn !== null && protectedSet.has(entry.turn) ? 'protected' : 'compressed',
      tokensBefore,
      tokensAfter: estimateTokens(truncated.text),
      headChars: truncated.headChars,
      tailChars: truncated.tailChars,
      omittedChars: truncated.omittedChars,
      marker: truncated.marker,
      eventRef: entry.eventRef,
      evidenceRefs: truncated.evidenceRefs,
    });
  }

  // 步骤二：早期回合连同推理一起压缩。
  const compress: CompressDecision[] = [];
  for (const turn of [...byTurn.keys()].sort((a, b) => a - b)) {
    const group = byTurn.get(turn) ?? [];
    const reasoningEntries = group.filter((e) => e.kind === 'reasoning');
    let tokens = 0;
    let reasoningTokens = 0;
    for (const entry of group) {
      const size = estimateEntryTokens(entry);
      tokens += size;
      if (entry.kind === 'reasoning') reasoningTokens += size;
    }
    compress.push({
      turn,
      entryIds: group.map((e) => e.entryId),
      reasoningEntryIds: reasoningEntries.map((e) => e.entryId),
      tokens,
      reasoningTokens,
    });
  }

  const truncatedById = new Map(truncate.map((t) => [t.entryId, t]));
  const keptEntryTokens = keep.reduce((sum, decision) => {
    const entry = entries.find((e) => e.entryId === decision.entryId);
    if (entry === undefined) return sum;
    const truncated = truncatedById.get(decision.entryId);
    return sum + (truncated === undefined ? estimateEntryTokens(entry) : truncated.tokensAfter);
  }, 0);

  const estimatedTokensBefore = estimateHistoryTokens(entries);
  let truncationSavings = 0;
  for (const decision of truncate) truncationSavings += decision.tokensBefore - decision.tokensAfter;
  const compressedTokens = compress.reduce((sum, c) => sum + c.tokens, 0);

  return {
    strategyVersion: COMPACTION_STRATEGY_VERSION,
    keepRecentTurns,
    protectedTurns,
    keep,
    truncate,
    compress,
    steps: COMPACTION_STEPS,
    baseSummaryIds: uniqueStrings(baseSummaryIds),
    compactedThroughTurn: compress.length === 0 ? null : Math.max(...compress.map((c) => c.turn)),
    fromTurn: compress.length === 0 ? null : compress[0]!.turn,
    estimatedTokensBefore,
    estimatedTokensAfterTruncation: Math.max(
      0,
      estimatedTokensBefore - Math.max(0, truncationSavings - compressedTokens),
    ),
    estimatedRetainedTokens: keptEntryTokens,
  };
}

/** 历史中出现的回合号，升序去重。回合号稀疏时按出现顺序取「最近 N 个」。 */
function orderedTurns(entries: readonly HistoryEntry[]): readonly number[] {
  const seen = new Set<number>();
  const turns: number[] = [];
  for (const entry of entries) {
    if (entry.turn === null) continue;
    if (seen.has(entry.turn)) continue;
    seen.add(entry.turn);
    turns.push(entry.turn);
  }
  return turns.sort((a, b) => a - b);
}

// ───────────────────────────── 计划不变量 ─────────────────────────────

export const COMPACTION_VIOLATION_CODES = [
  'pinned_entry_compressed',
  'pinned_entry_truncated',
  'protected_turn_compressed',
  'turn_partially_compressed',
  'reasoning_not_compressed',
  'turn_split',
  'non_tool_output_truncated',
  'over_window_without_recourse',
  'summary_trust_level_inherited',
  'summary_asset_attribution_present',
  'summary_missing_source_event_ref',
  'summary_unsourced_reference',
  'summary_verbatim_rewritten',
  'summary_unverified_marked_established',
  'chain_unknown_base_summary',
  'chain_duplicate_summary',
] as const;
type CompactionViolationCode = (typeof COMPACTION_VIOLATION_CODES)[number];

interface CompactionViolation {
  readonly code: CompactionViolationCode;
  readonly detail: string;
}

interface AssertCompactionOptions {
  /**
   * 提供窗口大小时，计划执行后仍超出窗口即抛错——「超限时抛错而不是静默丢」。
   * 此时唯一能继续压缩的只剩人工决策与交接内容，而那两条被 §8.10 明令禁止，
   * 所以正确的动作是把问题交给人类（暂停或交接），不是悄悄丢掉它们。
   */
  readonly contextWindowTokens?: number;
  readonly entries?: readonly HistoryEntry[];
}

/** 校验计划的不变量，返回全部违规项（不抛错，供测试与诊断使用）。 */
export function checkCompactionPlan(
  plan: CompactionPlan,
  options: AssertCompactionOptions = {},
): readonly CompactionViolation[] {
  const violations: CompactionViolation[] = [];
  const kindById = new Map<string, HistoryEntryKind>();
  for (const entry of options.entries ?? []) kindById.set(entry.entryId, entry.kind);

  const compressedIds = new Set<string>();
  const compressedTurns = new Set<number>();
  for (const decision of plan.compress) {
    compressedTurns.add(decision.turn);
    for (const id of decision.entryIds) compressedIds.add(id);
  }

  for (const decision of plan.keep) {
    if (decision.turn !== null && compressedTurns.has(decision.turn) && !isNeverCompacted(decision.kind)) {
      violations.push({
        code: 'turn_split',
        detail: `条目 ${decision.entryId}（回合 ${decision.turn}）被保留，但同回合已被压缩`,
      });
    }
  }

  const keptById = new Map(plan.keep.map((decision) => [decision.entryId, decision]));
  for (const decision of plan.compress) {
    for (const id of decision.entryIds) {
      const kept = keptById.get(id);
      if (kept !== undefined) {
        violations.push({
          code:
            kept.reason === 'protected_turn' || kept.reason === 'unattributed'
              ? 'turn_split'
              : 'pinned_entry_compressed',
          detail: `条目 ${id}（保留理由 ${kept.reason}）同时出现在压缩范围内`,
        });
        continue;
      }
      const kind = kindById.get(id);
      if (kind !== undefined && isNeverCompacted(kind)) {
        violations.push({
          code: 'pinned_entry_compressed',
          detail: `条目 ${id}（${kind}）属于 §8.10「完整保留」，永不压缩`,
        });
      }
    }
    if (plan.protectedTurns.includes(decision.turn)) {
      violations.push({
        code: 'protected_turn_compressed',
        detail: `回合 ${decision.turn} 在完整保留窗口（最近 ${plan.keepRecentTurns} 轮）内`,
      });
    }
  }

  for (const decision of plan.truncate) {
    const kind = kindById.get(decision.entryId);
    if (kind !== undefined && isNeverCompacted(kind)) {
      violations.push({
        code: 'pinned_entry_truncated',
        detail: `条目 ${decision.entryId}（${kind}）属于 §8.10「完整保留」，不做有损截断`,
      });
    }
    if (kind !== undefined && TOOL_OUTPUT_KIND[kind] !== true) {
      violations.push({
        code: 'non_tool_output_truncated',
        detail: `条目 ${decision.entryId}（${kind}）不是工具输出，§8.10 只允许截断超大工具输出`,
      });
    }
  }

  if (options.entries !== undefined && options.entries.length > 0) {
    const byTurn = new Map<number, readonly HistoryEntry[]>();
    const groups = new Map<number, HistoryEntry[]>();
    for (const entry of options.entries) {
      if (entry.turn === null) continue;
      const list = groups.get(entry.turn);
      if (list === undefined) groups.set(entry.turn, [entry]);
      else list.push(entry);
    }
    for (const [turn, list] of groups) byTurn.set(turn, list);

    for (const decision of plan.compress) {
      const list = byTurn.get(decision.turn) ?? [];
      const missingReasoning = list.filter(
        (e) => e.kind === 'reasoning' && !compressedIds.has(e.entryId),
      );
      if (missingReasoning.length > 0) {
        violations.push({
          code: 'reasoning_not_compressed',
          detail: `回合 ${decision.turn} 的推理条目未随正文一起压缩：${missingReasoning
            .map((e) => e.entryId)
            .join(', ')}`,
        });
      }
      const missing = list.filter((e) => !isNeverCompacted(e.kind) && !compressedIds.has(e.entryId));
      if (missing.length > 0) {
        violations.push({
          code: 'turn_partially_compressed',
          detail: `回合 ${decision.turn} 有条目既未保留也未压缩：${missing
            .map((e) => e.entryId)
            .join(', ')}`,
        });
      }
    }
  }

  if (
    options.contextWindowTokens !== undefined &&
    plan.estimatedRetainedTokens > options.contextWindowTokens
  ) {
    violations.push({
      code: 'over_window_without_recourse',
      detail: `计划执行后仍有约 ${plan.estimatedRetainedTokens} token，超出窗口 ${options.contextWindowTokens}；` +
        '剩余内容只有人工决策与交接内容，按 §8.10「人类决策与交接内容永不被压缩」不得继续丢弃',
    });
  }

  return violations;
}

/**
 * 断言计划不变量，违规即抛错。
 *
 * 这里刻意抛错而不是静默丢：压缩自动执行（不等人工批准）的前提正是这些不变量成立；
 * 一旦它们被破坏，摘要就不再是可丢弃的衍生品，而是唯一副本——那正是本设计要避免的处境。
 */
export function assertCompactionInvariants(
  plan: CompactionPlan,
  options: AssertCompactionOptions = {},
): void {
  const violations = checkCompactionPlan(plan, options);
  if (violations.length === 0) return;
  throw new Error(
    `压缩计划违反不变量（设计文档 §8.10）：\n${violations
      .map((v) => `  - [${v.code}] ${v.detail}`)
      .join('\n')}`,
  );
}

// ───────────────────────────── 摘要产出契约 ─────────────────────────────

const VERBATIM_CATEGORIES = [
  'target_address',
  'credential_name',
  'version',
  'error_detail',
] as const;
type VerbatimCategory = (typeof VERBATIM_CATEGORIES)[number];

const VERBATIM_PATTERNS: Readonly<Record<VerbatimCategory, readonly RegExp[]>> = {
  target_address: [
    /\b\d{1,3}(?:\.\d{1,3}){3}(?:\/\d{1,2})?\b/, // IPv4 / CIDR
    /\bhttps?:\/\/\S+/i,
    /\b[a-z0-9][a-z0-9_-]*(?:\.[a-z0-9][a-z0-9_-]*)*\.[a-z]{2,}\b/i,
    /\b(?:[0-9a-f]{0,4}:){2,7}[0-9a-f]{1,4}\b/i, // IPv6（宽松匹配）
  ],
  credential_name: [
    /[A-Za-z0-9_.-]*(?:password|passwd|passphrase|credential|secret|token|api[-_ ]?key|private[-_ ]?key)/i,
    /\b(?:id_rsa|id_ed25519)\b/,
    /\.(?:pem|pfx|p12|key)\b/i,
    /\b\.env\b/,
    /\bAKIA[0-9A-Z]{16}\b/,
    /\bgh[pousr]_[A-Za-z0-9]{16,}\b/,
  ],
  version: [/\bv?\d+\.\d+(?:\.\d+)*(?:[-+][0-9a-z.-]+)?\b/i],
  error_detail: [
    /\b(?:error|err|exception|traceback|panic|fatal|denied|refused|unauthorized|forbidden|timeout|timed out|not permitted)\b/i,
    /\b(?:errno|sqlstate|ora-\d+)\b/i,
    /\b[A-Z][A-Z0-9_]{3,}_ERROR\b/,
    /\b0x[0-9a-f]{8}\b/i,
    /\bexit (?:code|status)\s*\d+\b/i,
  ],
};

/** 文本命中的「必须保留原文引用」类别。 */
export function verbatimCategories(text: string): readonly VerbatimCategory[] {
  const hits: VerbatimCategory[] = [];
  for (const category of VERBATIM_CATEGORIES) {
    if (VERBATIM_PATTERNS[category].some((pattern) => pattern.test(text))) hits.push(category);
  }
  return hits;
}

/**
 * §8.10：「关键观测在压缩时优先保留原文引用而非改写措辞——
 * 目标地址、凭据名称、版本号、精确错误信息这类内容不适合摘要化。」
 */
export function requiresVerbatimPreservation(text: string): boolean {
  return verbatimCategories(text).length > 0;
}

/** 摘要中的一个条目（动作、观测或失败项）。 */
interface SummaryItem {
  readonly text: string;
  /** 指向原事件的引用：原文可顺着引用取回。 */
  readonly sourceEventRef: string;
  /** true 表示该条目必须作为原文引用呈现，而不是模型改写的一句话。 */
  readonly verbatim: boolean;
  readonly verbatimCategories: readonly VerbatimCategory[];
}

interface SummaryConclusion {
  readonly text: string;
  readonly confidence: number;
  /** `established` 仅在原文已有证据时成立；否则标为待验证（§8.10）。 */
  readonly status: 'established' | 'unverified';
  readonly evidenceRefs: readonly string[];
  readonly sourceEventRef: string;
}

/**
 * 压缩摘要（§8.10 / §8.5「压缩摘要」分块）。
 *
 * 字段不可协商：可信度固定为 `agent_claim`（不继承原始事件的更高可信度）、
 * 资产归属留空、必须携带指向原事件的引用。
 */
export interface CompactionSummary {
  readonly summaryId: string;
  readonly strategyVersion: string;
  /** §8.10：压缩是一次有损改写，可信度是 Agent 陈述，不是工具观测。 */
  readonly trustLevel: 'agent_claim';
  /** §8.5：压缩摘要资产归属留空。 */
  readonly assetIds: readonly [];
  readonly engagementId: string;
  readonly workerSessionId: string | null;
  /** 压缩区间。 */
  readonly fromTurn: number;
  readonly compactedThroughTurn: number;
  readonly sourceEventRefs: readonly string[];
  readonly actions: readonly SummaryItem[];
  readonly observations: readonly SummaryItem[];
  readonly conclusions: readonly SummaryConclusion[];
  readonly failures: readonly SummaryItem[];
  readonly estimatedTokensBefore: number;
  readonly estimatedTokensAfter: number;
  readonly generatedAt: string;
}

export interface SummaryItemInput {
  readonly text: string;
  /** 引用必须落在被压缩区间内的事件上，否则摘要（b）条不成立。 */
  readonly sourceEventRef: string;
}

interface SummaryConclusionInput {
  readonly text: string;
  readonly confidence: number;
  /** 原文中的证据引用；为空或引用越界时摘要标注为待验证。 */
  readonly evidenceRefs?: readonly string[];
  readonly sourceEventRef: string;
}

interface CompactionSummaryInput {
  readonly engagementId: string;
  readonly workerSessionId?: string | null;
  readonly fromTurn: number;
  readonly compactedThroughTurn: number;
  /** 被压缩的条目：提供引用集合与「压缩前规模」。 */
  readonly sourceEntries: readonly HistoryEntry[];
  readonly actions: readonly SummaryItemInput[];
  readonly observations: readonly SummaryItemInput[];
  readonly conclusions: readonly SummaryConclusionInput[];
  readonly failures: readonly SummaryItemInput[];
  readonly generatedAt: Date | string;
  readonly strategyVersion?: string;
  readonly summaryId?: string;
}

/**
 * 由被压缩条目构建摘要。
 *
 * 三条硬性保证：
 *   (a) `trustLevel` 恒为 `agent_claim`，无论被压缩事件原本是 `tool_observation` 还是 `human_decision`；
 *   (b) `sourceEventRefs` 覆盖全部被压缩条目，且每个条目/结论的引用都必须落在其中；
 *   (c) 原文没有证据的结论一律标 `unverified`（不得给出原文没有的结论）。
 * 关键观测（目标地址、凭据名称、版本号、精确错误信息）被标记为 `verbatim`，
 * 渲染时以「原文引用」呈现而非改写措辞。
 */
export function buildCompactionSummary(input: CompactionSummaryInput): CompactionSummary {
  const sourceEventRefs = uniqueStrings(input.sourceEntries.map((e) => e.eventRef));
  const allowed = new Set(sourceEventRefs);
  const generatedAt = input.generatedAt instanceof Date
    ? input.generatedAt.toISOString()
    : new Date(input.generatedAt).toISOString();

  const guard = (item: SummaryItemInput, section: string): void => {
    if (!allowed.has(item.sourceEventRef)) {
      throw new Error(
        `摘要不得包含原文没有的内容：${section} 条目引用的 ${item.sourceEventRef} 不在压缩区间内`,
      );
    }
  };

  const toItem = (item: SummaryItemInput, section: string): SummaryItem => {
    guard(item, section);
    const categories = verbatimCategories(item.text);
    return {
      text: item.text,
      sourceEventRef: item.sourceEventRef,
      verbatim: categories.length > 0,
      verbatimCategories: categories,
    };
  };

  const conclusions: SummaryConclusion[] = input.conclusions.map((conclusion) => {
    guard(conclusion, '结论');
    const evidenceRefs = uniqueStrings(conclusion.evidenceRefs ?? []);
    const grounded = evidenceRefs.length > 0 && evidenceRefs.every((ref) => allowed.has(ref));
    return {
      text: conclusion.text,
      confidence: conclusion.confidence,
      status: grounded ? 'established' : 'unverified',
      evidenceRefs,
      sourceEventRef: conclusion.sourceEventRef,
    };
  });

  const summary: CompactionSummary = {
    summaryId:
      input.summaryId ??
      deriveSummaryId({
        engagementId: input.engagementId,
        compactedThroughTurn: input.compactedThroughTurn,
        strategyVersion: input.strategyVersion ?? COMPACTION_STRATEGY_VERSION,
        sourceEventRefs,
      }),
    strategyVersion: input.strategyVersion ?? COMPACTION_STRATEGY_VERSION,
    trustLevel: 'agent_claim',
    assetIds: [],
    engagementId: input.engagementId,
    workerSessionId: input.workerSessionId ?? null,
    fromTurn: input.fromTurn,
    compactedThroughTurn: input.compactedThroughTurn,
    sourceEventRefs,
    actions: input.actions.map((item) => toItem(item, '动作')),
    observations: input.observations.map((item) => toItem(item, '观测')),
    conclusions,
    failures: input.failures.map((item) => toItem(item, '失败项')),
    estimatedTokensBefore: estimateHistoryTokens(input.sourceEntries),
    estimatedTokensAfter: 0,
    generatedAt,
  };
  return { ...summary, estimatedTokensAfter: estimateTokens(renderCompactionSummary(summary)) };
}

/** 摘要的模型可见渲染；引用与「不等同事实」标注都在正文里。 */
export function renderCompactionSummary(summary: CompactionSummary): string {
  const lines: string[] = [
    `【上下文压缩摘要（${summary.strategyVersion}）】覆盖回合 ${summary.fromTurn}–${summary.compactedThroughTurn}`,
    '来源可信度：Agent 陈述（有损改写，不等同于事实；关键观测以原文引用呈现，可顺引用取回原文）',
  ];
  const section = (title: string, items: readonly SummaryItem[]): void => {
    if (items.length === 0) return;
    lines.push(`${title}：`);
    for (const item of items) {
      lines.push(
        item.verbatim
          ? `- ${item.text}（原文引用：${item.sourceEventRef}；关键项 ${item.verbatimCategories.join('/')}）`
          : `- ${item.text}（引用：${item.sourceEventRef}）`,
      );
    }
  };
  section('做过的动作与目标', summary.actions);
  section('关键观测', summary.observations);
  if (summary.conclusions.length > 0) {
    lines.push('结论与置信度：');
    for (const conclusion of summary.conclusions) {
      const status = conclusion.status === 'established' ? '原文已有证据' : '待验证（原文未证实）';
      const evidence = conclusion.evidenceRefs.length > 0 ? `；证据 ${conclusion.evidenceRefs.join(', ')}` : '';
      lines.push(`- ${conclusion.text}（置信度 ${conclusion.confidence}；${status}${evidence}）`);
    }
  }
  section('失败与未完成项', summary.failures);
  lines.push(`原事件引用：${summary.sourceEventRefs.join(', ')}`);
  return lines.join('\n');
}

/** `context.compacted` 事件的负载（§8.5：压缩摘要单独成类，可检索回来）。 */
export function toCompactionEventPayload(summary: CompactionSummary): CompactionPayload {
  return {
    summary: renderCompactionSummary(summary),
    compactedThroughTurn: summary.compactedThroughTurn,
    sourceEventRefs: summary.sourceEventRefs,
  };
}

/**
 * 校验摘要是否满足 §8.10 的四条约束（不抛错，返回全部违规项）。
 * 手工拼装或跨进程回传的摘要都可能失真，因此校验不能只依赖构建器。
 */
export function checkCompactionSummary(
  summary: CompactionSummary,
  sourceEntries: readonly HistoryEntry[],
): readonly CompactionViolation[] {
  const violations: CompactionViolation[] = [];
  const allowed = new Set(summary.sourceEventRefs);
  const entryRefs = new Set(sourceEntries.map((e) => e.eventRef));

  if (summary.trustLevel !== 'agent_claim') {
    violations.push({
      code: 'summary_trust_level_inherited',
      detail: `摘要可信度为 ${summary.trustLevel}；§8.10 要求固定为 Agent 陈述，不继承原始事件的更高可信度`,
    });
  }
  if (summary.assetIds.length > 0) {
    violations.push({
      code: 'summary_asset_attribution_present',
      detail: '§8.5 要求压缩摘要资产归属留空',
    });
  }
  if (sourceEntries.length > 0 && summary.sourceEventRefs.length === 0) {
    violations.push({
      code: 'summary_missing_source_event_ref',
      detail: '摘要缺少指向原事件的引用，原文无法顺引用取回',
    });
  }
  for (const ref of entryRefs) {
    if (!allowed.has(ref)) {
      violations.push({
        code: 'summary_missing_source_event_ref',
        detail: `被压缩事件 ${ref} 未进入摘要引用集合`,
      });
    }
  }

  const checkItem = (item: SummaryItem, section: string): void => {
    if (item.sourceEventRef.length === 0 || !allowed.has(item.sourceEventRef)) {
      violations.push({
        code: 'summary_unsourced_reference',
        detail: `${section}条目「${item.text}」的引用 ${item.sourceEventRef || '(空)'} 不在压缩区间内`,
      });
    }
    if (requiresVerbatimPreservation(item.text) && !item.verbatim) {
      violations.push({
        code: 'summary_verbatim_rewritten',
        detail: `${section}条目「${item.text}」属于关键观测，必须保留原文引用而非改写措辞`,
      });
    }
  };
  for (const item of summary.actions) checkItem(item, '动作');
  for (const item of summary.observations) checkItem(item, '观测');
  for (const item of summary.failures) checkItem(item, '失败项');

  for (const conclusion of summary.conclusions) {
    if (conclusion.sourceEventRef.length === 0 || !allowed.has(conclusion.sourceEventRef)) {
      violations.push({
        code: 'summary_unsourced_reference',
        detail: `结论「${conclusion.text}」的引用 ${conclusion.sourceEventRef || '(空)'} 不在压缩区间内`,
      });
    }
    for (const ref of conclusion.evidenceRefs) {
      if (!allowed.has(ref)) {
        violations.push({
          code: 'summary_unsourced_reference',
          detail: `结论「${conclusion.text}」的证据引用 ${ref} 不在原文中`,
        });
      }
    }
    if (conclusion.status === 'established' && conclusion.evidenceRefs.length === 0) {
      violations.push({
        code: 'summary_unverified_marked_established',
        detail: `结论「${conclusion.text}」无原文证据却标为已验证`,
      });
    }
  }
  return violations;
}

/** 由（engagement、覆盖回合、策略版本、引用集合）确定性派生摘要标识。 */
function deriveSummaryId(input: {
  readonly engagementId: string;
  readonly compactedThroughTurn: number;
  readonly strategyVersion: string;
  readonly sourceEventRefs: readonly string[];
}): string {
  return deriveUuid('dsh-pentest/compaction-summary/v1', [
    input.engagementId,
    String(input.compactedThroughTurn),
    input.strategyVersion,
    uniqueStrings(input.sourceEventRefs).join(','),
  ]);
}

// ───────────────────────────── 压缩链（漂移可追溯） ─────────────────────────────

/**
 * 一次压缩的记录（§8.10）：
 * > 每次压缩写入事件，包含压缩区间、策略版本、摘要引用与压缩前后的估算规模。
 * > **逐级压缩的记录**：同一段历史被压缩两次时，第二次的输入是第一次的摘要。
 * > 插件记录压缩链（哪次压缩基于哪次摘要），使漂移可追溯。
 */
interface CompactionChainLink {
  readonly producedSummaryId: string;
  /** 本次压缩的输入摘要；空表示直接作用于原始回合。 */
  readonly baseSummaryIds: readonly string[];
  readonly fromTurn: number;
  readonly throughTurn: number;
  readonly strategyVersion: string;
  readonly estimatedTokensBefore: number;
  readonly estimatedTokensAfter: number;
  readonly compactedAt: string;
}

interface CompactionChain {
  readonly engagementId: string;
  readonly workerSessionId: string | null;
  readonly links: readonly CompactionChainLink[];
}

type CompactionChainUpdate =
  | { readonly ok: true; readonly chain: CompactionChain }
  | { readonly ok: false; readonly code: CompactionViolationCode; readonly detail: string };

export function emptyCompactionChain(
  engagementId: string,
  workerSessionId: string | null = null,
): CompactionChain {
  return { engagementId, workerSessionId, links: [] };
}

/** 由计划与摘要构造链记录：`baseSummaryIds` 直接取自计划的逐级压缩输入。 */
export function compactionLinkFromPlan(input: {
  readonly plan: CompactionPlan;
  readonly summary: CompactionSummary;
  readonly compactedAt: Date | string;
}): CompactionChainLink {
  const { plan, summary } = input;
  if (plan.fromTurn === null || plan.compactedThroughTurn === null) {
    throw new Error('计划没有压缩区间，不能据此记录压缩链');
  }
  return {
    producedSummaryId: summary.summaryId,
    baseSummaryIds: plan.baseSummaryIds,
    fromTurn: plan.fromTurn,
    throughTurn: plan.compactedThroughTurn,
    strategyVersion: plan.strategyVersion,
    estimatedTokensBefore: summary.estimatedTokensBefore,
    estimatedTokensAfter: summary.estimatedTokensAfter,
    compactedAt:
      input.compactedAt instanceof Date ? input.compactedAt.toISOString() : new Date(input.compactedAt).toISOString(),
  };
}

/**
 * 追加一条压缩链记录。基摘要必须已知——否则「哪次压缩基于哪次摘要」无从追溯，
 * 漂移链在记录层面就断了。
 */
export function appendCompactionLink(
  chain: CompactionChain,
  link: CompactionChainLink,
): CompactionChainUpdate {
  if (chain.links.some((existing) => existing.producedSummaryId === link.producedSummaryId)) {
    return {
      ok: false,
      code: 'chain_duplicate_summary',
      detail: `摘要 ${link.producedSummaryId} 已有压缩记录`,
    };
  }
  const known = new Set(chain.links.map((existing) => existing.producedSummaryId));
  for (const base of link.baseSummaryIds) {
    if (!known.has(base)) {
      return {
        ok: false,
        code: 'chain_unknown_base_summary',
        detail: `基摘要 ${base} 不在压缩链中，逐级压缩关系无法追溯`,
      };
    }
  }
  return { ok: true, chain: { ...chain, links: [...chain.links, link] } };
}

/**
 * 追溯到某份摘要的血统（从最早一代到该摘要，含自身）。
 * 链上找不到该摘要时返回空数组——调用方据此知道这份摘要是外来输入。
 */
export function traceCompactionLineage(
  chain: CompactionChain,
  summaryId: string,
): readonly string[] {
  const byId = new Map(chain.links.map((link) => [link.producedSummaryId, link]));
  if (!byId.has(summaryId)) return [];
  const ordered: string[] = [];
  const seen = new Set<string>();
  const visit = (id: string): void => {
    if (seen.has(id)) return;
    seen.add(id);
    const link = byId.get(id);
    for (const base of link?.baseSummaryIds ?? []) visit(base);
    ordered.push(id);
  };
  visit(summaryId);
  return ordered;
}

// ───────────────────────────── 通用工具 ─────────────────────────────

function uniqueStrings(values: readonly string[]): readonly string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    if (seen.has(value)) continue;
    seen.add(value);
    out.push(value);
  }
  return out;
}

/** 确定性 UUID（与 `deriveChunkId` 同法：sha256 前 16 字节，置版本位）。 */
function deriveUuid(namespace: string, parts: readonly string[]): string {
  const bytes = Buffer.from(sha256Hex([namespace, ...parts].join('|')), 'hex').subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
