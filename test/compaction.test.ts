/**
 * 上下文压缩测试（设计文档 §8.1 / §8.5 / §8.10）。
 *
 * 纯逻辑，不需要数据库。必须显式证明以下安全关键结论：
 *   1. 触发只在回合边界发生（工具执行中途绝不压缩）；
 *   2. 最近 6 轮（含推理）完整保留，更早回合连同推理一起进压缩；
 *   3. 全部人工决策与插话即使在最早回合也永不被压缩；
 *   4. 超大工具输出先被截断（保留首尾与证据引用），再压缩早期回合；
 *   5. 摘要可信度降级为 Agent 陈述、携带原事件引用、不含原文没有的结论；
 *   6. 逐级压缩的漂移链可追溯；
 *   7. 违反不变量时抛错，而不是静默丢弃人类意志。
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { DEFAULTS } from '../src/contracts.ts';
import {
  COMPACTION_STEPS,
  COMPACTION_STRATEGY_VERSION,
  COMPACTION_TRUNCATION_DEFAULTS,
  assertCompactionInvariants,
  buildCompactionSummary,
  checkCompactionPlan,
  checkCompactionSummary,
  compactionLinkFromPlan,
  appendCompactionLink,
  contextPressure,
  emptyCompactionChain,
  estimateTokens,
  planCompaction,
  renderCompactionSummary,
  requiresVerbatimPreservation,
  shouldCompact,
  toCompactionEventPayload,
  traceCompactionLineage,
  truncateToolOutput,
  verbatimCategories,
  type CompactionPlan,
  type CompactionSummary,
  type HistoryEntry,
  type HistoryEntryKind,
  type SummaryItemInput,
} from '../src/memory/compaction.ts';

// ───────────────────────────── 测试夹具 ─────────────────────────────

const WINDOW = 100_000;

function entry(
  overrides: Partial<HistoryEntry> & { readonly entryId: string; readonly kind: HistoryEntryKind },
): HistoryEntry {
  return { eventRef: `evt-${overrides.entryId}`, turn: null, ...overrides };
}

/** 恒定存在的非回合类条目，全部属于 §8.10「完整保留」。 */
const ALWAYS_KEPT: readonly HistoryEntry[] = [
  entry({ entryId: 'identity', kind: 'system_identity', content: '渗透测试 Worker 身份与职责说明' }),
  entry({ entryId: 'skills', kind: 'skill_instructions', content: '已装载 skill：nmap 使用规范' }),
  entry({ entryId: 'prompt', kind: 'task_prompt', content: '人类确认的任务提示词' }),
  entry({ entryId: 'handoff', kind: 'handoff', content: '人类确认的交接内容；被截断项：历史报告附录' }),
];

/** 人类决策与插话刻意放在最早的第 1 回合，验证「永不被压缩」。 */
const HUMAN_ENTRIES: readonly HistoryEntry[] = [
  entry({ entryId: 'decision-1', kind: 'human_decision', turn: 1, content: '人类决策：允许对 10.0.0.12 做弱口令探测' }),
  entry({ entryId: 'interjection-1', kind: 'human_interjection', turn: 1, content: '人类插话：避开生产库 5432 端口' }),
];

function history(turnCount: number, extra: readonly HistoryEntry[] = []): readonly HistoryEntry[] {
  const entries: HistoryEntry[] = [...ALWAYS_KEPT, ...HUMAN_ENTRIES];
  for (let turn = 1; turn <= turnCount; turn += 1) {
    entries.push(
      entry({ entryId: `a${turn}`, kind: 'assistant_message', turn, content: `第 ${turn} 轮正文`, tokens: 100 }),
      entry({ entryId: `r${turn}`, kind: 'reasoning', turn, content: `第 ${turn} 轮推理`, tokens: 50 }),
      entry({
        entryId: `t${turn}`,
        kind: 'tool_observation',
        turn,
        toolName: 'nmap',
        content: `第 ${turn} 轮工具输出`,
        tokens: 200,
        evidenceRefs: [`ev-${turn}`],
      }),
    );
  }
  return [...entries, ...extra];
}

function compressedIds(plan: CompactionPlan): readonly string[] {
  return plan.compress.flatMap((decision) => decision.entryIds);
}

function summaryInput(entries: readonly HistoryEntry[]): Parameters<typeof buildCompactionSummary>[0] {
  return {
    engagementId: 'eng-1',
    workerSessionId: 'sess-1',
    fromTurn: 1,
    compactedThroughTurn: 4,
    sourceEntries: entries,
    actions: [{ text: '对目标主机做了端口扫描', sourceEventRef: entries[0]!.eventRef }],
    observations: [{ text: '目标 10.0.0.12:443 开放', sourceEventRef: entries[0]!.eventRef }],
    conclusions: [{ text: '存在暴露的 HTTPS 服务', confidence: 0.7, sourceEventRef: entries[0]!.eventRef }],
    failures: [{ text: '半开扫描被限速中断', sourceEventRef: entries[0]!.eventRef }],
    generatedAt: '2026-09-19T00:00:00.000Z',
  };
}

// ───────────────────────────── 触发判定 ─────────────────────────────

test('触发：估算量未到窗口的 60% 不触发', () => {
  assert.equal(
    shouldCompact({ contextWindowTokens: WINDOW, estimatedRequestTokens: WINDOW * 0.59, atTurnBoundary: true }),
    false,
  );
});

test('触发：估算量超过窗口的 60% 触发', () => {
  assert.equal(
    shouldCompact({ contextWindowTokens: WINDOW, estimatedRequestTokens: WINDOW * 0.61, atTurnBoundary: true }),
    true,
  );
});

test('触发：恰好等于阈值不触发（「超过」是严格大于）', () => {
  assert.equal(
    shouldCompact({ contextWindowTokens: WINDOW, estimatedRequestTokens: WINDOW * 0.6, atTurnBoundary: true }),
    false,
  );
  assert.equal(DEFAULTS.compactionTriggerRatio, 0.6);
});

test('触发：不在回合边界一律不压缩，即使已逼近窗口上限', () => {
  assert.equal(
    shouldCompact({ contextWindowTokens: WINDOW, estimatedRequestTokens: WINDOW * 0.99, atTurnBoundary: false }),
    false,
  );
});

test('触发：阈值可被调用方覆盖，窗口大小不硬编码', () => {
  assert.equal(
    shouldCompact({
      contextWindowTokens: 1_000,
      estimatedRequestTokens: 400,
      atTurnBoundary: true,
      triggerRatio: 0.3,
    }),
    true,
  );
  assert.equal(
    shouldCompact({
      contextWindowTokens: 4_096,
      estimatedRequestTokens: 400,
      atTurnBoundary: true,
      triggerRatio: 0.3,
    }),
    false,
  );
});

test('触发：非法窗口/比例抛 RangeError，不静默返回', () => {
  assert.throws(
    () => shouldCompact({ contextWindowTokens: 0, estimatedRequestTokens: 1, atTurnBoundary: true }),
    RangeError,
  );
  assert.throws(
    () => shouldCompact({ contextWindowTokens: 10, estimatedRequestTokens: -1, atTurnBoundary: true }),
    RangeError,
  );
  assert.throws(
    () => shouldCompact({ contextWindowTokens: 10, estimatedRequestTokens: 1, atTurnBoundary: true, triggerRatio: 0 }),
    RangeError,
  );
});

test('触发：contextPressure 即估算量与窗口之比', () => {
  assert.equal(contextPressure({ contextWindowTokens: 1_000, estimatedRequestTokens: 250, atTurnBoundary: true }), 0.25);
});

test('规模估算：CJK 按字计，ASCII 按 4 字符/token 计', () => {
  assert.equal(estimateTokens(''), 0);
  assert.equal(estimateTokens('中文'), 2);
  assert.equal(estimateTokens('abcdefgh'), 2);
  assert.equal(estimateTokens('中文abcd'), 3);
});

// ───────────────────────────── 保留窗口 ─────────────────────────────

test('保留窗口：10 轮历史只压缩前 4 轮，最近 6 轮完整保留', () => {
  const plan = planCompaction({ entries: history(10) });
  assert.equal(plan.keepRecentTurns, DEFAULTS.compactionKeepRecentTurns);
  assert.deepEqual(plan.protectedTurns, [5, 6, 7, 8, 9, 10]);
  assert.deepEqual(
    plan.compress.map((decision) => decision.turn),
    [1, 2, 3, 4],
  );
  assert.equal(plan.compactedThroughTurn, 4);
  assert.equal(plan.fromTurn, 1);
});

test('保留窗口：最近 6 轮的每一条（含推理）都在保留集合里', () => {
  const entries = history(10);
  const plan = planCompaction({ entries });
  const kept = new Set(plan.keep.map((decision) => decision.entryId));
  for (let turn = 5; turn <= 10; turn += 1) {
    for (const id of [`a${turn}`, `r${turn}`, `t${turn}`]) assert.equal(kept.has(id), true, `${id} 应被完整保留`);
  }
});

test('保留窗口：回合数不足 6 轮时全部保留，不产生压缩区间', () => {
  const plan = planCompaction({ entries: history(3) });
  assert.deepEqual(plan.compress, []);
  assert.equal(plan.compactedThroughTurn, null);
  assert.equal(plan.fromTurn, null);
  assert.equal(plan.estimatedRetainedTokens, plan.estimatedTokensBefore);
});

test('保留窗口：keepRecentTurns 可覆盖', () => {
  const plan = planCompaction({ entries: history(10), options: { keepRecentTurns: 2 } });
  assert.deepEqual(plan.protectedTurns, [9, 10]);
  assert.deepEqual(
    plan.compress.map((decision) => decision.turn),
    [1, 2, 3, 4, 5, 6, 7, 8],
  );
});

test('保留窗口：回合号稀疏时按出现的最近 6 个回合判定', () => {
  const entries: HistoryEntry[] = [3, 8, 12, 30, 31, 44, 45].map((turn) =>
    entry({ entryId: `a${turn}`, kind: 'assistant_message', turn, content: `第 ${turn} 轮`, tokens: 10 }),
  );
  const plan = planCompaction({ entries });
  assert.deepEqual(plan.protectedTurns, [8, 12, 30, 31, 44, 45]);
  assert.deepEqual(
    plan.compress.map((decision) => decision.turn),
    [3],
  );
});

test('保留窗口：非法 keepRecentTurns 抛 RangeError', () => {
  assert.throws(() => planCompaction({ entries: history(2), options: { keepRecentTurns: 0 } }), RangeError);
});

// ───────────────────────────── 推理必须一并压缩 ─────────────────────────────

test('推理：更早回合的推理随正文一起进压缩，不能只压正文', () => {
  const plan = planCompaction({ entries: history(10) });
  for (const decision of plan.compress) {
    assert.deepEqual(decision.reasoningEntryIds, [`r${decision.turn}`]);
    assert.equal(decision.entryIds.includes(`r${decision.turn}`), true);
    assert.equal(decision.tokens > 0, true);
    assert.equal(decision.reasoningTokens > 0, true);
  }
});

test('推理：压缩区间记录了推理的规模（reasoningTokens 不为 0）', () => {
  const plan = planCompaction({ entries: history(10) });
  const totalReasoning = plan.compress.reduce((sum, decision) => sum + decision.reasoningTokens, 0);
  assert.equal(totalReasoning, 4 * 50);
});

test('推理：被压缩回合的每一条都进入压缩集合，不漏项', () => {
  const entries = history(10);
  const plan = planCompaction({ entries });
  const ids = new Set(compressedIds(plan));
  for (let turn = 1; turn <= 4; turn += 1) {
    for (const id of [`a${turn}`, `r${turn}`, `t${turn}`]) assert.equal(ids.has(id), true, `${id} 应被压缩`);
  }
});

// ───────────────────────────── 永不压缩的条目 ─────────────────────────────

test('永不压缩：最早回合（第 1 轮）的人工决策不被压缩', () => {
  const plan = planCompaction({ entries: history(10) });
  assert.equal(compressedIds(plan).includes('decision-1'), false);
  const keep = plan.keep.find((decision) => decision.entryId === 'decision-1');
  assert.equal(keep?.reason, 'human_content');
});

test('永不压缩：最早回合的人类插话不被压缩', () => {
  const plan = planCompaction({ entries: history(10) });
  assert.equal(compressedIds(plan).includes('interjection-1'), false);
  assert.equal(plan.keep.find((decision) => decision.entryId === 'interjection-1')?.reason, 'human_content');
});

test('永不压缩：身份、skill、任务提示词、交接内容全部保留且理由各自可辨', () => {
  const plan = planCompaction({ entries: history(10) });
  const reasonOf = (id: string) => plan.keep.find((decision) => decision.entryId === id)?.reason;
  assert.equal(reasonOf('identity'), 'identity');
  assert.equal(reasonOf('skills'), 'skill_instructions');
  assert.equal(reasonOf('prompt'), 'task_prompt');
  assert.equal(reasonOf('handoff'), 'handoff');
  const ids = new Set(compressedIds(plan));
  for (const id of ['identity', 'skills', 'prompt', 'handoff']) assert.equal(ids.has(id), false);
});

test('永不压缩：人工条目在 keepRecentTurns=1 的极端设置下仍然保留', () => {
  const plan = planCompaction({ entries: history(10), options: { keepRecentTurns: 1 } });
  const kept = new Set(plan.keep.map((decision) => decision.entryId));
  assert.equal(kept.has('decision-1'), true);
  assert.equal(kept.has('interjection-1'), true);
  assert.equal(kept.has('handoff'), true);
});

// ───────────────────────────── 超大工具输出优先截断 ─────────────────────────────

function withHugeOutput(turn: number): readonly HistoryEntry[] {
  const huge = 'A'.repeat(40_000);
  return history(10, [
    entry({
      entryId: 'huge',
      kind: 'tool_observation',
      turn,
      toolName: 'ffuf',
      content: `${huge}TAIL-MARKER`,
      evidenceRefs: ['artifact-77'],
    }),
  ]);
}

test('截断顺序：计划固定「先截断工具输出，再压缩早期回合」', () => {
  assert.deepEqual(COMPACTION_STEPS, ['truncate_tool_outputs', 'compress_early_turns']);
  const plan = planCompaction({ entries: withHugeOutput(1) });
  assert.deepEqual(plan.steps, COMPACTION_STEPS);
  assert.equal(plan.steps[0], 'truncate_tool_outputs');
});

test('截断：超大工具输出保留首尾、中间标注省略、并带证据引用与账本事件引用', () => {
  const plan = planCompaction({ entries: withHugeOutput(1) });
  const decision = plan.truncate.find((item) => item.entryId === 'huge');
  assert.ok(decision, '超大工具输出必须进入截断集合');
  assert.equal(decision.omittedChars > 0, true);
  assert.equal(decision.headChars, COMPACTION_TRUNCATION_DEFAULTS.headChars);
  assert.equal(decision.tailChars, COMPACTION_TRUNCATION_DEFAULTS.tailChars);
  assert.match(decision.marker, /已省略 \d+ 字符/);
  assert.match(decision.marker, /evt-huge/);
  assert.match(decision.marker, /artifact-77/);
  assert.deepEqual(decision.evidenceRefs, ['artifact-77']);
  assert.equal(decision.tokensAfter < decision.tokensBefore, true);
});

test('截断：落在保留窗口内的超大输出同样先被截断（scope=protected）', () => {
  const plan = planCompaction({ entries: withHugeOutput(9) });
  const decision = plan.truncate.find((item) => item.entryId === 'huge');
  assert.equal(decision?.scope, 'protected');
});

test('截断：未超限的工具输出不参与截断', () => {
  const plan = planCompaction({ entries: history(10) });
  assert.deepEqual(plan.truncate, []);
});

test('截断：阈值可调，调高后不再截断', () => {
  const plan = planCompaction({ entries: withHugeOutput(1), options: { toolOutputTokenLimit: 1_000_000 } });
  assert.deepEqual(plan.truncate, []);
});

test('截断：截断使估算规模下降（先处理体积主因）', () => {
  const entries = withHugeOutput(9);
  const plan = planCompaction({ entries });
  assert.equal(plan.estimatedTokensAfterTruncation < plan.estimatedTokensBefore, true);
  assert.equal(plan.truncate.length > 0, true);
});

test('截断：文本短于首尾预算时原样返回，不产生省略标记', () => {
  const result = truncateToolOutput({ text: 'short output', eventRef: 'evt-1', evidenceRefs: ['ev-1'] });
  assert.equal(result.text, 'short output');
  assert.equal(result.omittedChars, 0);
  assert.equal(result.marker, '');
  assert.deepEqual(result.evidenceRefs, ['ev-1']);
});

// ───────────────────────────── 摘要契约 ─────────────────────────────

test('摘要：可信度降级为 Agent 陈述，不继承被压缩事件的更高可信度', () => {
  const source = [
    entry({
      entryId: 'obs',
      kind: 'tool_observation',
      turn: 1,
      content: 'nmap 输出',
      trustLevel: 'tool_observation',
    }),
  ];
  const summary = buildCompactionSummary({ ...summaryInput(source) });
  assert.equal(summary.trustLevel, 'agent_claim');
  assert.equal(source[0]!.trustLevel, 'tool_observation');
});

test('摘要：资产归属留空，且携带全部被压缩事件的引用', () => {
  const source = [
    entry({ entryId: 'a1', kind: 'assistant_message', turn: 1, content: '正文' }),
    entry({ entryId: 'r1', kind: 'reasoning', turn: 1, content: '推理' }),
  ];
  const summary = buildCompactionSummary({
    ...summaryInput(source),
    observations: [],
    conclusions: [],
    failures: [],
    actions: [],
  });
  assert.deepEqual(summary.assetIds, []);
  assert.deepEqual(summary.sourceEventRefs, ['evt-a1', 'evt-r1']);
  assert.equal(summary.compactedThroughTurn, 4);
  assert.equal(summary.strategyVersion, COMPACTION_STRATEGY_VERSION);
});

test('摘要：结论无原文证据时标为待验证，有原文证据时才成立', () => {
  const source = [
    entry({ entryId: 'a1', kind: 'assistant_message', turn: 1, content: '正文' }),
    entry({ entryId: 't1', kind: 'tool_observation', turn: 1, content: '工具观测' }),
  ];
  const summary = buildCompactionSummary({
    ...summaryInput(source),
    conclusions: [
      { text: '端口 443 开放（有工具观测支撑）', confidence: 0.9, evidenceRefs: ['evt-t1'], sourceEventRef: 'evt-t1' },
      { text: '该主机还可能存在未授权管理面', confidence: 0.4, sourceEventRef: 'evt-a1' },
      { text: '引用了区间外证据的推断', confidence: 0.5, evidenceRefs: ['evt-elsewhere'], sourceEventRef: 'evt-a1' },
    ],
  });
  assert.deepEqual(
    summary.conclusions.map((conclusion) => conclusion.status),
    ['established', 'unverified', 'unverified'],
  );
});

test('摘要：关键观测保留原文引用而非改写（目标地址/凭据名称/版本号/精确错误信息）', () => {
  const source = [entry({ entryId: 't1', kind: 'tool_observation', turn: 1, content: '工具输出' })];
  const ref = 'evt-t1';
  const summary = buildCompactionSummary({
    ...summaryInput(source),
    observations: [
      { text: '目标 10.0.0.12:443 开放', sourceEventRef: ref },
      { text: '配置中暴露凭据名 DB_PASSWORD', sourceEventRef: ref },
      { text: '目标服务版本 OpenSSL 3.0.11', sourceEventRef: ref },
      { text: '精确错误：errno 111 connection refused', sourceEventRef: ref },
      { text: '整体来看暴露面偏大', sourceEventRef: ref },
    ],
  });
  assert.deepEqual(
    summary.observations.map((item) => item.verbatim),
    [true, true, true, true, false],
  );
  assert.equal(summary.observations[0]!.verbatimCategories.includes('target_address'), true);
  assert.equal(summary.observations[1]!.verbatimCategories.includes('credential_name'), true);
  assert.equal(summary.observations[2]!.verbatimCategories.includes('version'), true);
  assert.equal(summary.observations[3]!.verbatimCategories.includes('error_detail'), true);
  assert.deepEqual(summary.observations[4]!.verbatimCategories, []);
  assert.equal(requiresVerbatimPreservation('整体来看暴露面偏大'), false);
  assert.deepEqual(verbatimCategories('目标 10.0.0.12 开放').includes('target_address'), true);
});

test('摘要：渲染文本标注可信度与原文引用，压缩后规模可估算', () => {
  const source = [entry({ entryId: 't1', kind: 'tool_observation', turn: 1, content: '工具输出' })];
  const summary = buildCompactionSummary(summaryInput(source));
  const rendered = renderCompactionSummary(summary);
  assert.match(rendered, /Agent 陈述/);
  assert.match(rendered, /原文引用：evt-t1/);
  assert.match(rendered, /原事件引用：/);
  assert.match(rendered, /待验证/);
  assert.equal(summary.estimatedTokensAfter, estimateTokens(rendered));
  assert.equal(summary.estimatedTokensAfter > 0, true);
});

test('摘要：引用越界即抛错，杜绝「原文没有的结论」', () => {
  const source = [entry({ entryId: 't1', kind: 'tool_observation', turn: 1, content: '工具输出' })];
  assert.throws(
    () =>
      buildCompactionSummary({
        ...summaryInput(source),
        observations: [{ text: '凭空出现的观测', sourceEventRef: 'evt-not-in-range' }],
      }),
    /不在压缩区间内/,
  );
});

test('摘要：校验器能检出继承可信度、资产归属、改写关键观测、无证据标已验证、引用越界', () => {
  const source = [
    entry({ entryId: 't1', kind: 'tool_observation', turn: 1, content: '工具输出' }),
    entry({ entryId: 'a1', kind: 'assistant_message', turn: 1, content: '正文' }),
  ];
  const good = buildCompactionSummary(summaryInput(source));
  assert.deepEqual(checkCompactionSummary(good, source), []);

  const broken = {
    ...good,
    trustLevel: 'tool_observation',
    assetIds: ['asset-1'],
    observations: [
      { text: '目标 10.0.0.12 开放', sourceEventRef: 'evt-t1' },
    ] satisfies readonly SummaryItemInput[] as unknown as CompactionSummary['observations'],
    conclusions: [
      { text: '无证据却标已验证', confidence: 1, status: 'established', evidenceRefs: [], sourceEventRef: 'evt-a1' },
      { text: '引用越界', confidence: 1, status: 'unverified', evidenceRefs: ['evt-nope'], sourceEventRef: 'evt-a1' },
    ],
  } as unknown as CompactionSummary;

  const codes = checkCompactionSummary(broken, source).map((violation) => violation.code);
  assert.equal(codes.includes('summary_trust_level_inherited'), true);
  assert.equal(codes.includes('summary_asset_attribution_present'), true);
  assert.equal(codes.includes('summary_verbatim_rewritten'), true);
  assert.equal(codes.includes('summary_unverified_marked_established'), true);
  assert.equal(codes.includes('summary_unsourced_reference'), true);
});

test('摘要：可序列化为 context.compacted 事件负载，并带上覆盖回合', () => {
  const source = [entry({ entryId: 't1', kind: 'tool_observation', turn: 1, content: '工具输出' })];
  const summary = buildCompactionSummary(summaryInput(source));
  const payload = toCompactionEventPayload(summary);
  assert.equal(payload.compactedThroughTurn, 4);
  assert.match(payload.summary ?? '', /上下文压缩摘要/);
  assert.deepEqual(payload.sourceEventRefs, summary.sourceEventRefs);
});

// ───────────────────────────── 压缩链（漂移可追溯） ─────────────────────────────

test('压缩链：首次压缩无基摘要；第二次压缩基于第一次的摘要', () => {
  const firstEntries = history(10);
  const first = planCompaction({ entries: firstEntries });
  const firstSource = firstEntries.filter((item) => item.turn !== null && item.turn <= first.compactedThroughTurn!);
  const firstSummary = buildCompactionSummary({
    ...summaryInput(firstSource),
    fromTurn: first.fromTurn!,
    compactedThroughTurn: first.compactedThroughTurn!,
  });
  assert.deepEqual(first.baseSummaryIds, []);
  const chain0 = emptyCompactionChain('eng-1', 'sess-1');
  const r1 = appendCompactionLink(
    chain0,
    compactionLinkFromPlan({ plan: first, summary: firstSummary, compactedAt: '2026-09-19T00:00:00.000Z' }),
  );
  assert.equal(r1.ok, true);
  if (!r1.ok) return;

  // 第二次压缩：输入里含有第一次的摘要条目（逐级压缩）。
  const secondEntries = history(10, [
    entry({
      entryId: 'summary-1',
      kind: 'compaction_summary',
      turn: 1,
      content: renderCompactionSummary(firstSummary),
      summaryId: firstSummary.summaryId,
      compactedThroughTurn: first.compactedThroughTurn ?? undefined,
    }),
  ]);
  const second = planCompaction({ entries: secondEntries });
  assert.deepEqual(second.baseSummaryIds, [firstSummary.summaryId]);

  const secondSource = secondEntries.filter(
    (item) => item.turn !== null && item.turn <= (second.compactedThroughTurn ?? 0),
  );
  const secondSummary = buildCompactionSummary({
    ...summaryInput(secondSource),
    fromTurn: second.fromTurn!,
    compactedThroughTurn: second.compactedThroughTurn!,
  });
  assert.notEqual(secondSummary.summaryId, firstSummary.summaryId);
  const r2 = appendCompactionLink(
    r1.chain,
    compactionLinkFromPlan({ plan: second, summary: secondSummary, compactedAt: '2026-09-19T01:00:00.000Z' }),
  );
  assert.equal(r2.ok, true);
  if (!r2.ok) return;

  assert.deepEqual(traceCompactionLineage(r2.chain, secondSummary.summaryId), [
    firstSummary.summaryId,
    secondSummary.summaryId,
  ]);
});

test('压缩链：基摘要未知即拒绝记录（漂移链不允许断链）', () => {
  const result = appendCompactionLink(emptyCompactionChain('eng-1'), {
    producedSummaryId: 's2',
    baseSummaryIds: ['s1'],
    fromTurn: 1,
    throughTurn: 4,
    strategyVersion: COMPACTION_STRATEGY_VERSION,
    estimatedTokensBefore: 100,
    estimatedTokensAfter: 20,
    compactedAt: '2026-09-19T00:00:00.000Z',
  });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.code, 'chain_unknown_base_summary');
});

test('压缩链：同一摘要不允许重复记录', () => {
  const link = {
    producedSummaryId: 's1',
    baseSummaryIds: [],
    fromTurn: 1,
    throughTurn: 4,
    strategyVersion: COMPACTION_STRATEGY_VERSION,
    estimatedTokensBefore: 100,
    estimatedTokensAfter: 20,
    compactedAt: '2026-09-19T00:00:00.000Z',
  };
  const first = appendCompactionLink(emptyCompactionChain('eng-1'), link);
  assert.equal(first.ok, true);
  if (!first.ok) return;
  const again = appendCompactionLink(first.chain, link);
  assert.equal(again.ok, false);
  if (again.ok) return;
  assert.equal(again.code, 'chain_duplicate_summary');
});

test('压缩链：未知摘要的血统为空，已知摘要可回溯到最早一代', () => {
  const chain = emptyCompactionChain('eng-1');
  const s1 = appendCompactionLink(chain, {
    producedSummaryId: 's1',
    baseSummaryIds: [],
    fromTurn: 1,
    throughTurn: 4,
    strategyVersion: COMPACTION_STRATEGY_VERSION,
    estimatedTokensBefore: 100,
    estimatedTokensAfter: 20,
    compactedAt: '2026-09-19T00:00:00.000Z',
  });
  assert.equal(s1.ok, true);
  if (!s1.ok) return;
  const s2 = appendCompactionLink(s1.chain, {
    producedSummaryId: 's2',
    baseSummaryIds: ['s1'],
    fromTurn: 5,
    throughTurn: 8,
    strategyVersion: COMPACTION_STRATEGY_VERSION,
    estimatedTokensBefore: 80,
    estimatedTokensAfter: 15,
    compactedAt: '2026-09-19T01:00:00.000Z',
  });
  assert.equal(s2.ok, true);
  if (!s2.ok) return;
  assert.deepEqual(traceCompactionLineage(s2.chain, 's1'), ['s1']);
  assert.deepEqual(traceCompactionLineage(s2.chain, 'nope'), []);
});

// ───────────────────────────── 不变量断言 ─────────────────────────────

test('不变量：合法计划通过断言', () => {
  const entries = history(10);
  const plan = planCompaction({ entries });
  assert.deepEqual(checkCompactionPlan(plan, { entries }), []);
  assert.doesNotThrow(() => assertCompactionInvariants(plan, { entries }));
});

test('不变量：人工决策被划入压缩范围即抛错', () => {
  const entries = history(10);
  const plan = planCompaction({ entries });
  const broken: CompactionPlan = {
    ...plan,
    compress: plan.compress.map((decision, index) =>
      index === 0 ? { ...decision, entryIds: [...decision.entryIds, 'decision-1'] } : decision,
    ),
  };
  assert.throws(() => assertCompactionInvariants(broken, { entries }), /pinned_entry_compressed/);
});

test('不变量：推理未随正文一起压缩即抛错', () => {
  const entries = history(10);
  const plan = planCompaction({ entries });
  const first = plan.compress[0]!;
  const broken: CompactionPlan = {
    ...plan,
    compress: [
      { ...first, entryIds: first.entryIds.filter((id) => id !== first.reasoningEntryIds[0]) },
      ...plan.compress.slice(1),
    ],
  };
  assert.throws(() => assertCompactionInvariants(broken, { entries }), /reasoning_not_compressed/);
});

test('不变量：同一条目既保留又压缩即抛错（回合被切开）', () => {
  const entries = history(10);
  const plan = planCompaction({ entries });
  const broken: CompactionPlan = {
    ...plan,
    keep: [...plan.keep, { entryId: 'a1', turn: 1, kind: 'assistant_message', reason: 'protected_turn' }],
  };
  assert.throws(() => assertCompactionInvariants(broken, { entries }), /turn_split/);
});

test('不变量：保留窗口内的回合被压缩即抛错', () => {
  const entries = history(10);
  const plan = planCompaction({ entries, options: { keepRecentTurns: 2 } });
  const broken: CompactionPlan = { ...plan, protectedTurns: [9, 10, 1] };
  assert.throws(() => assertCompactionInvariants(broken, { entries }), /protected_turn_compressed/);
});

test('不变量：截断非工具输出即抛错（§8.10 只允许截断超大工具输出）', () => {
  const entries = history(10);
  const plan = planCompaction({ entries });
  const broken: CompactionPlan = {
    ...plan,
    truncate: [
      {
        entryId: 'a1',
        turn: 1,
        kind: 'tool_observation',
        toolName: null,
        scope: 'compressed',
        tokensBefore: 9_000,
        tokensAfter: 100,
        headChars: 10,
        tailChars: 10,
        omittedChars: 5_000,
        marker: '…',
        eventRef: 'evt-a1',
        evidenceRefs: [],
      },
    ],
  };
  assert.throws(() => assertCompactionInvariants(broken, { entries }), /non_tool_output_truncated/);
});

test('不变量：执行后仍超出窗口即抛错，不静默丢弃人工决策与交接内容', () => {
  const entries = history(10);
  const plan = planCompaction({ entries });
  assert.throws(
    () => assertCompactionInvariants(plan, { contextWindowTokens: 1 }),
    /over_window_without_recourse/,
  );
});

test('不变量：超限判定以保留条目的估算规模为准', () => {
  const entries = history(10);
  const plan = planCompaction({ entries });
  assert.equal(plan.estimatedRetainedTokens > 0, true);
  assert.equal(plan.estimatedRetainedTokens < plan.estimatedTokensBefore, true);
  assert.doesNotThrow(() =>
    assertCompactionInvariants(plan, { contextWindowTokens: plan.estimatedRetainedTokens }),
  );
});
