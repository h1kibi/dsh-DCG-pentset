/**
 * 记忆分块与检索测试（设计文档 §8.3 / §8.5 / §8.6 / §8.7）。
 *
 * 本文件必须显式证明三条安全关键结论：
 *   1. 同时含已纳入与已排除资产的分块被排除（排除优先）；
 *   2. 空 asset_ids 的分块被放行（否则思考链与压缩摘要整批消失）；
 *   3. 范围版本升级后，原先被排除的分块重新可见（无需重建索引）。
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  CHUNK_KIND_EVENT_TYPES,
  REASONING_EVENT_TYPES,
  checkChunkAssetObligation,
  checkChunkBatchWritable,
  deriveChunkId,
  planChunks,
  sha256Hex,
  splitFixedWindow,
  type ChunkDraft,
  type ChunkSourceEvent,
} from '../src/memory/chunks.ts';
import {
  DEFAULT_EXCERPT_CHARS,
  PROVISIONAL_PENALTY,
  REASONING_LABEL,
  RRF_UNIT,
  SOURCE_AUTHORITY_BONUS,
  buildRetrievalSql,
  fuseRrf,
  isChunkVisibleInScope,
  recencyBonus,
  resolveScopeSets,
  scoreCandidate,
  screenCandidate,
  searchMemory,
  truncateExcerpt,
  type AssetScopeDecisionRow,
  type MemoryQuery,
  type RetrievalCandidate,
} from '../src/memory/retrieval.ts';

// ───────────────────────────── 测试夹具 ─────────────────────────────

const NOW = new Date('2026-09-19T00:00:00.000Z');
const FRESH = '2026-09-19T00:00:00.000Z';
const OLD = '2026-08-01T00:00:00.000Z';

function sets(included: readonly string[], excluded: readonly string[]) {
  return { includedAssetIds: new Set(included), excludedAssetIds: new Set(excluded) };
}

/** 会话绑定范围版本解析出的 (I(v), X(v))。 */
function scopeOf(included: readonly string[], excluded: readonly string[] = []) {
  return { included: new Set(included), excluded: new Set(excluded) };
}

function visibility(chunkAssetIds: readonly string[], included: readonly string[], excluded: readonly string[]) {
  return isChunkVisibleInScope({ chunkAssetIds, ...sets(included, excluded) });
}

function candidate(overrides: Partial<RetrievalCandidate> & { chunkId: string }): RetrievalCandidate {
  return {
    kind: 'tool_observation',
    engagementId: 'eng-1',
    trustLevel: 'tool_observation',
    classification: 'engagement',
    assetIds: [],
    findingIds: [],
    phase: 'vulnerability-analysis',
    workerSessionId: 'sess-1',
    sourceEventId: 'evt-1',
    occurredAt: FRESH,
    provisional: false,
    humanAccepted: false,
    indexable: true,
    excerpt: 'excerpt',
    semanticRank: 1,
    lexicalRank: null,
    trigramRank: null,
    ...overrides,
  };
}

function search(
  candidates: readonly RetrievalCandidate[],
  query: Partial<MemoryQuery> = {},
  scope = scopeOf([]),
) {
  return searchMemory({
    boundEngagementId: 'eng-1',
    query: { query: 'q', ...query },
    scope,
    candidates,
    now: NOW,
  });
}

function sourceEvent(overrides: Partial<ChunkSourceEvent> = {}): ChunkSourceEvent {
  return {
    eventId: 'evt-1',
    engagementId: 'eng-1',
    eventType: 'human.input',
    workerSessionId: 'sess-1',
    phase: 'intelligence-gathering',
    trustLevel: 'human_decision',
    classification: 'engagement',
    occurredAt: NOW,
    payload: { text: '把 10.0.0.5 加进目标' },
    ...overrides,
  };
}

// ───────────────────────────── §8.6 范围过滤真值表 ─────────────────────────────

test('谓词：空 asset_ids 在任何范围集合下都可见（否则思考链与压缩摘要整批消失）', () => {
  assert.equal(visibility([], [], []), true);
  assert.equal(visibility([], ['a'], []), true);
  assert.equal(visibility([], [], ['a']), true);
  assert.equal(visibility([], ['a', 'b'], ['c']), true);
});

test('谓词：含已纳入资产且无排除资产 → 可见', () => {
  assert.equal(visibility(['a'], ['a'], []), true);
  assert.equal(visibility(['a', 'b'], ['a'], []), true);
  assert.equal(visibility(['a', 'b'], ['a', 'b'], []), true);
});

test('谓词：含被排除资产 → 不可见', () => {
  assert.equal(visibility(['x'], [], ['x']), false);
  assert.equal(visibility(['a', 'x'], ['a'], ['x']), false);
});

test('谓词：同时含已纳入与已排除资产 → 不可见（排除优先，宁可连带屏蔽）', () => {
  assert.equal(visibility(['included-asset', 'excluded-asset'], ['included-asset'], ['excluded-asset']), false);
  assert.equal(
    visibility(['i1', 'i2', 'i3', 'x'], ['i1', 'i2', 'i3'], ['x']),
    false,
    '三个已纳入资产也压不过一个被排除资产',
  );
});

test('谓词：资产未出现在该范围版本（未裁决）→ 不可见（fail-closed）', () => {
  assert.equal(visibility(['unknown'], ['a'], ['x']), false);
  assert.equal(visibility(['a', 'unknown'], ['a'], []), true, '混有已纳入资产时未知资产不额外致盲');
  assert.equal(visibility(['unknown'], ['a'], ['unknown']), false, 'pending 与 excluded 同等处理');
});

test('谓词：同一资产同时被标记纳入与排除（冲突决策）→ 不可见', () => {
  assert.equal(visibility(['conflict'], ['conflict'], ['conflict']), false);
});

test('谓词：重复的 asset_ids 不改变判定', () => {
  assert.equal(visibility(['a', 'a'], ['a'], []), true);
  assert.equal(visibility(['x', 'x'], [], ['x']), false);
});

test('resolveScopeSets：pending 并入 X(v)，只有指定版本的行参与', () => {
  const rows: readonly AssetScopeDecisionRow[] = [
    { assetId: 'a', scopeVersion: 1, decision: 'included' },
    { assetId: 'b', scopeVersion: 1, decision: 'excluded' },
    { assetId: 'c', scopeVersion: 1, decision: 'pending' },
    { assetId: 'd', scopeVersion: 2, decision: 'included' },
  ];
  const v1 = resolveScopeSets(rows, 1);
  assert.deepEqual([...v1.included], ['a']);
  assert.deepEqual([...v1.excluded].sort(), ['b', 'c']);
  assert.equal(visibility(['c'], [...v1.included], [...v1.excluded]), false, 'pending 不可见');
  const v2 = resolveScopeSets(rows, 2);
  assert.deepEqual([...v2.included], ['d']);
  assert.equal(visibility(['a'], [...v2.included], [...v2.excluded]), false, '旧版本纳入的资产在新版本未裁决 → 不可见');
});

test('范围版本升级后原先被排除的分块重新可见（无需重建索引）', () => {
  const chunk = ['internal-db'];
  const v1 = resolveScopeSets([{ assetId: 'internal-db', scopeVersion: 1, decision: 'excluded' }], 1);
  assert.equal(visibility(chunk, [...v1.included], [...v1.excluded]), false);

  const v2 = resolveScopeSets(
    [
      { assetId: 'internal-db', scopeVersion: 1, decision: 'excluded' },
      { assetId: 'internal-db', scopeVersion: 2, decision: 'included' },
    ],
    2,
  );
  assert.equal(visibility(chunk, [...v2.included], [...v2.excluded]), true, '范围升级后重新可见');
});

test('范围版本升级：pending → included 后重新可见；多重归属挡住部分升级', () => {
  const rows: readonly AssetScopeDecisionRow[] = [
    { assetId: 'a', scopeVersion: 1, decision: 'pending' },
    { assetId: 'b', scopeVersion: 1, decision: 'included' },
    { assetId: 'a', scopeVersion: 2, decision: 'included' },
    { assetId: 'b', scopeVersion: 2, decision: 'included' },
  ];
  const v1 = resolveScopeSets(rows, 1);
  assert.equal(visibility(['a', 'b'], [...v1.included], [...v1.excluded]), false, 'a 为 pending → 整块不可见');
  const v2 = resolveScopeSets(rows, 2);
  assert.equal(visibility(['a', 'b'], [...v2.included], [...v2.excluded]), true);
});

// ───────────────────────────── 融合排序 ─────────────────────────────

test('fuseRrf：单路按排名降序，多路命中优于单路命中', () => {
  const fused = fuseRrf({
    semantic: [
      { chunkId: 'c1', rank: 1 },
      { chunkId: 'c2', rank: 2 },
    ],
    lexical: [{ chunkId: 'c2', rank: 1 }],
  });
  assert.equal(fused.get('c1')!.score, 1 / 61);
  assert.equal(fused.get('c2')!.score, 1 / 62 + 1 / 61);
  assert.deepEqual(fused.get('c2')!.routes, ['semantic', 'lexical']);
  assert.deepEqual(fused.get('c1')!.routes, ['semantic']);
});

test('fuseRrf：rank <= 0 或缺席视为该路未命中', () => {
  const fused = fuseRrf({
    semantic: [
      { chunkId: 'c1', rank: 0 },
      { chunkId: 'c2', rank: 3 },
    ],
  });
  assert.equal(fused.has('c1'), false);
  assert.equal(fused.get('c2')!.score, 1 / 63);
  assert.equal(fuseRrf({ semantic: [] }).size, 0);
});

test('fuseRrf：同一路内重复出现只算最好排名一次', () => {
  const fused = fuseRrf({
    semantic: [
      { chunkId: 'c1', rank: 5 },
      { chunkId: 'c1', rank: 2 },
    ],
  });
  assert.equal(fused.get('c1')!.score, 1 / 62);
  assert.deepEqual(fused.get('c1')!.routes, ['semantic']);
});

test('思考链与其他类型共用同一套排序规则：不加分也不降权', () => {
  const reasoning = candidate({ chunkId: 'aaa-reasoning', kind: 'reasoning', trustLevel: 'model_reasoning' });
  const other = candidate({ chunkId: 'bbb-other', kind: 'tool_observation', trustLevel: 'model_reasoning' });
  const screenContext = { query: { query: 'q' }, scope: scopeOf([]), now: NOW };
  const a = screenCandidate(reasoning, screenContext);
  const b = screenCandidate(other, screenContext);
  assert.equal(a, null);
  assert.equal(b, null);

  const result = search([reasoning, other]);
  assert.equal(result.hits.length, 2);
  assert.equal(result.hits[0]!.score, result.hits[1]!.score, '类型不进入评分');
  assert.deepEqual(result.hits.map((h) => h.chunkId), ['aaa-reasoning', 'bbb-other'], '同分按分块标识稳定决胜');
  assert.equal(result.hits[0]!.reasoningLabel, REASONING_LABEL, '思考链只加标注，不改相关性');
  assert.equal(result.hits[1]!.reasoningLabel, null);
});

test('来源权威度：人工决策与工具观测优先，模型推理与 Agent 陈述不被降权', () => {
  assert.equal(SOURCE_AUTHORITY_BONUS.human_decision, RRF_UNIT);
  assert.equal(SOURCE_AUTHORITY_BONUS.tool_observation, RRF_UNIT);
  assert.equal(SOURCE_AUTHORITY_BONUS.agent_claim, 0);
  assert.equal(SOURCE_AUTHORITY_BONUS.model_reasoning, 0);
  assert.equal(SOURCE_AUTHORITY_BONUS.external_untrusted, 0);

  const result = search([
    candidate({ chunkId: 'c-agent', trustLevel: 'agent_claim' }),
    candidate({ chunkId: 'c-human', trustLevel: 'human_decision' }),
    candidate({ chunkId: 'c-model', trustLevel: 'model_reasoning' }),
    candidate({ chunkId: 'c-tool', trustLevel: 'tool_observation' }),
  ]);
  assert.deepEqual(
    result.hits.map((h) => h.chunkId),
    ['c-human', 'c-tool', 'c-agent', 'c-model'],
  );
  assert.equal(
    result.hits[2]!.score,
    result.hits[3]!.score,
    'agent_claim 与 model_reasoning 同分：来源可信度不改变相关性',
  );
});

test('时效性：新近内容优先，衰减单调', () => {
  const fresh = recencyBonus('2026-09-19T00:00:00.000Z', NOW);
  const week = recencyBonus('2026-09-12T00:00:00.000Z', NOW);
  const month = recencyBonus('2026-08-20T00:00:00.000Z', NOW);
  assert.ok(fresh > week && week > month && month > 0);
  assert.ok(Math.abs(week - fresh / 2) < 1e-12, '半衰期 7 天');

  const result = search([
    candidate({ chunkId: 'c-old', occurredAt: OLD }),
    candidate({ chunkId: 'c-fresh', occurredAt: FRESH }),
  ]);
  assert.deepEqual(
    result.hits.map((h) => h.chunkId),
    ['c-fresh', 'c-old'],
  );
});

test('暂定惩罚：暂定分块排在结算分块之后，但仍在候选内', () => {
  const result = search([
    candidate({ chunkId: 'c-provisional', provisional: true }),
    candidate({ chunkId: 'c-settled', provisional: false }),
  ]);
  assert.deepEqual(
    result.hits.map((h) => h.chunkId),
    ['c-settled', 'c-provisional'],
  );
  assert.equal(result.hits[1]!.breakdown.provisionalPenalty, -PROVISIONAL_PENALTY);
  assert.equal(result.hits[0]!.breakdown.provisionalPenalty, 0);
});

test('排序稳定：完全相同的两条按分块标识升序，重复调用顺序一致', () => {
  const candidates = [
    candidate({ chunkId: 'zzz' }),
    candidate({ chunkId: 'aaa' }),
    candidate({ chunkId: 'mmm' }),
  ];
  const first = search(candidates).hits.map((h) => h.chunkId);
  const second = search([...candidates].reverse()).hits.map((h) => h.chunkId);
  assert.deepEqual(first, ['aaa', 'mmm', 'zzz']);
  assert.deepEqual(second, first);
});

test('scoreCandidate：最终分 = RRF + 权威度 + 时效性 − 暂定惩罚', () => {
  const breakdown = scoreCandidate({
    rrf: 1 / 61,
    trustLevel: 'tool_observation',
    occurredAt: FRESH,
    provisional: true,
    now: NOW,
  });
  assert.equal(breakdown.rrf, 1 / 61);
  assert.equal(breakdown.authority, RRF_UNIT);
  assert.equal(breakdown.recency, recencyBonus(FRESH, NOW));
  assert.equal(breakdown.provisionalPenalty, -PROVISIONAL_PENALTY);
  assert.equal(
    breakdown.final,
    breakdown.rrf + breakdown.authority + breakdown.recency + breakdown.provisionalPenalty,
  );
});

// ───────────────────────────── 检索语义（§8.3 / §8.7） ─────────────────────────────

test('include_reasoning 是筛选开关：不传时思考链参与，false 时只要非思考链条目', () => {
  const candidates = [
    candidate({ chunkId: 'c-reasoning', kind: 'reasoning', trustLevel: 'model_reasoning' }),
    candidate({ chunkId: 'c-fact', kind: 'fact' }),
  ];
  const byDefault = search(candidates);
  assert.equal(byDefault.includeReasoning, true);
  assert.deepEqual(byDefault.hits.map((h) => h.chunkId).sort(), ['c-fact', 'c-reasoning']);

  const excluded = search(candidates, { includeReasoning: false });
  assert.deepEqual(excluded.hits.map((h) => h.chunkId), ['c-fact']);
  assert.equal(excluded.rejected.filter, 1);

  const explicit = search(candidates, { includeReasoning: true });
  assert.deepEqual(explicit.hits.map((h) => h.chunkId).sort(), ['c-fact', 'c-reasoning']);
});

test('本 engagement 的任意阶段都能检索到思考链（不是权限门禁）', () => {
  const result = search([
    candidate({ chunkId: 'c-reasoning', kind: 'reasoning', phase: 'post-exploitation', trustLevel: 'model_reasoning' }),
  ]);
  assert.equal(result.hits.length, 1);
  assert.equal(result.hits[0]!.reasoningLabel, REASONING_LABEL);
  assert.equal(result.hits[0]!.citation, 'memory:c-reasoning');
});

test('跨 engagement 候选被拒绝且不泄露：直接丢弃并按原因计数', () => {
  const result = search([
    candidate({ chunkId: 'c-own' }),
    candidate({ chunkId: 'c-foreign', engagementId: 'eng-2' }),
  ]);
  assert.deepEqual(result.hits.map((h) => h.chunkId), ['c-own']);
  assert.equal(result.rejected.foreign_engagement, 1);
});

test('检索范围过滤：被排除资产的分块不出现在结果中，同时含纳入与排除的也被挡下', () => {
  const scope = scopeOf(['a'], ['x']);
  const result = search(
    [
      candidate({ chunkId: 'c-included', assetIds: ['a'] }),
      candidate({ chunkId: 'c-excluded', assetIds: ['x'] }),
      candidate({ chunkId: 'c-mixed', assetIds: ['a', 'x'] }),
      candidate({ chunkId: 'c-orphan', assetIds: [] }),
    ],
    {},
    scope,
  );
  assert.deepEqual(result.hits.map((h) => h.chunkId).sort(), ['c-included', 'c-orphan']);
  assert.equal(result.rejected.scope, 2);
});

test('二进制等只存元数据的分块不进入检索', () => {
  const result = search([candidate({ chunkId: 'c-binary', kind: 'binary_evidence', indexable: false })]);
  assert.equal(result.hits.length, 0);
  assert.equal(result.rejected.not_indexable, 1);
});

test('无任何一路命中的候选不返回', () => {
  const result = search([
    candidate({ chunkId: 'c-none', semanticRank: null, lexicalRank: null, trigramRank: null }),
  ]);
  assert.equal(result.hits.length, 0);
  assert.equal(result.rejected.no_route_hit, 1);
});

test('过滤维度：阶段、类型、可信度、分类、资产、结论、会话、时间、暂定、已人工接受', () => {
  const rich = candidate({
    chunkId: 'c-rich',
    kind: 'finding',
    trustLevel: 'agent_claim',
    classification: 'secret-like',
    assetIds: ['a1'],
    findingIds: ['f1'],
    workerSessionId: 'sess-9',
    occurredAt: '2026-09-10T00:00:00.000Z',
    provisional: true,
    humanAccepted: true,
    phase: 'vulnerability-analysis',
  });
  const other = candidate({ chunkId: 'c-other', occurredAt: FRESH });

  const pass: Partial<MemoryQuery> = {
    phase: 'vulnerability-analysis',
    kinds: ['finding'],
    trustLevels: ['agent_claim'],
    classifications: ['secret-like'],
    assetIds: ['a1'],
    findingIds: ['f1'],
    workerSessionIds: ['sess-9'],
    from: '2026-09-01T00:00:00.000Z',
    to: '2026-09-15T00:00:00.000Z',
    includeProvisional: true,
    onlyHumanAccepted: true,
  };
  const scope = scopeOf(['a1', 'a2']);
  assert.deepEqual(search([rich, other], pass, scope).hits.map((h) => h.chunkId), ['c-rich']);

  const rejectCases: readonly (readonly [string, Partial<MemoryQuery>])[] = [
    ['phase', { phase: 'exploitation' }],
    ['kinds', { kinds: ['fact'] }],
    ['trustLevels', { trustLevels: ['tool_observation'] }],
    ['classifications', { classifications: ['public'] }],
    ['assetIds', { assetIds: ['a2'] }],
    ['findingIds', { findingIds: ['f2'] }],
    ['workerSessionIds', { workerSessionIds: ['sess-other'] }],
    ['from', { from: '2026-09-11T00:00:00.000Z' }],
    ['to', { to: '2026-09-09T00:00:00.000Z' }],
    ['includeProvisional', { includeProvisional: false }],
  ];
  for (const [label, override] of rejectCases) {
    assert.equal(
      search([rich], { ...pass, ...override }, scope).hits.length,
      0,
      `${label} 不匹配时被拒（对照组是同 scope 下的 pass）`,
    );
  }

  assert.equal(
    search([candidate({ chunkId: 'c-unaccepted', humanAccepted: false })], { onlyHumanAccepted: true }).hits.length,
    0,
    '未人工接受的条目在 onlyHumanAccepted 下被拒',
  );
});

test('limit 截断与计数：matched 是截断前命中数，limit 上限受 MAX_RETRIEVAL_LIMIT 约束', () => {
  const candidates = Array.from({ length: 12 }, (_, i) =>
    candidate({ chunkId: `c-${String(i).padStart(2, '0')}` }),
  );
  const limited = search(candidates, { limit: 3 });
  assert.equal(limited.hits.length, 3);
  assert.equal(limited.matched, 12);
  assert.equal(limited.evaluated, 12);
  assert.equal(limited.limit, 3);

  const uncapped = search(candidates, { limit: 999 });
  assert.equal(uncapped.limit, 50);
  assert.equal(uncapped.hits.length, 12);
});

test('结果带来源信息、引用标识与摘录截断', () => {
  const long = 'A'.repeat(DEFAULT_EXCERPT_CHARS + 50);
  const result = search([
    candidate({
      chunkId: 'c-1',
      excerpt: long,
      sourceEventId: 'evt-9',
      workerSessionId: 'sess-3',
      phase: 'post-exploitation',
    }),
  ]);
  const hit = result.hits[0]!;
  assert.equal(hit.sourceEventId, 'evt-9');
  assert.equal(hit.workerSessionId, 'sess-3');
  assert.equal(hit.phase, 'post-exploitation');
  assert.equal(hit.citation, 'memory:c-1');
  assert.equal(hit.excerpt.length, DEFAULT_EXCERPT_CHARS + 1);
  assert.ok(hit.excerpt.endsWith('…'));
  assert.equal(truncateExcerpt('a\n\n  b'), 'a b');
});

// ───────────────────────────── SQL 下推 ─────────────────────────────

test('buildRetrievalSql：范围谓词是反连接 + 半连接，参数携带 I(v) 与 X(v)', () => {
  const sql = buildRetrievalSql({
    engagementId: 'eng-1',
    query: { query: 'q' },
    includedAssetIds: ['a'],
    excludedAssetIds: ['x', 'y'],
  });
  assert.match(sql.where, /NOT \(mc\.asset_ids && \$2::uuid\[\]\)/);
  assert.match(sql.where, /mc\.asset_ids && \$3::uuid\[\] OR mc\.asset_ids = '\{\}'/);
  assert.equal(sql.params[0], 'eng-1');
  assert.deepEqual(sql.params[1], ['x', 'y']);
  assert.deepEqual(sql.params[2], ['a']);
  assert.match(sql.where, /mc\.engagement_id = \$1::uuid/);
  assert.match(sql.where, /mc\.superseded_by_revision IS NULL/);
  assert.match(sql.where, /SELECT revision FROM pentest\.embedding_revisions/);
});

test('buildRetrievalSql：占位符与参数一一对应', () => {
  const sql = buildRetrievalSql({
    engagementId: 'eng-1',
    query: {
      query: 'q',
      phase: 'vulnerability-analysis',
      kinds: ['fact', 'reasoning'],
      trustLevels: ['tool_observation'],
      classifications: ['engagement'],
      assetIds: ['a1'],
      findingIds: ['f1'],
      workerSessionIds: ['s1'],
      from: '2026-09-01T00:00:00.000Z',
      to: '2026-09-19T00:00:00.000Z',
      includeProvisional: false,
      onlyHumanAccepted: true,
      includeReasoning: false,
    },
    includedAssetIds: ['a1'],
    excludedAssetIds: [],
  });
  const indices = [...sql.where.matchAll(/\$(\d+)/gu)].map((m) => Number(m[1]));
  assert.ok(indices.length >= 10);
  assert.equal(Math.max(...indices), sql.params.length, '最大占位符等于参数个数');
  assert.deepEqual(
    [...new Set(indices)].sort((a, b) => a - b),
    Array.from({ length: sql.params.length }, (_, i) => i + 1),
    '占位符连续无空洞',
  );
});

test('buildRetrievalSql：空范围集合仍保留两条谓词（缺一即泄露或误伤）', () => {
  const sql = buildRetrievalSql({
    engagementId: 'eng-1',
    query: { query: 'q' },
    includedAssetIds: [],
    excludedAssetIds: [],
  });
  assert.deepEqual(sql.params[1], []);
  assert.deepEqual(sql.params[2], []);
  assert.match(sql.where, /NOT \(mc\.asset_ids && \$2::uuid\[\]\) AND \(mc\.asset_ids && \$3::uuid\[\] OR mc\.asset_ids = '\{\}'\)/);
});

test('buildRetrievalSql：include_reasoning=false 的事件类型排除对非事件来源分块保持 NULL 安全', () => {
  const sql = buildRetrievalSql({
    engagementId: 'eng-1',
    query: { query: 'q', includeReasoning: false },
    includedAssetIds: [],
    excludedAssetIds: [],
  });
  assert.ok(sql.joins.some((j) => j.includes('pentest.context_events e')));
  assert.match(sql.where, /e\.event_type IS NULL OR e\.event_type <> ALL\(\$\d+::text\[\]\)/);
  const reasoningParam = sql.params.find((p) => Array.isArray(p) && p.includes('llm.reasoning'));
  assert.deepEqual(reasoningParam, [...REASONING_EVENT_TYPES]);
});

test('buildRetrievalSql：kinds 过滤下推为记忆条目 kind 或来源事件类型', () => {
  const sql = buildRetrievalSql({
    engagementId: 'eng-1',
    query: { query: 'q', kinds: ['finding'] },
    includedAssetIds: [],
    excludedAssetIds: [],
  });
  assert.ok(sql.joins.some((j) => j.includes('pentest.memory_items mi')));
  assert.ok(sql.joins.some((j) => j.includes('pentest.context_events e')));
  const kindsParam = sql.params.find((p) => Array.isArray(p) && p.includes('finding'));
  assert.deepEqual(kindsParam, ['finding']);
  const eventParam = sql.params.find((p) => Array.isArray(p) && p.includes('worker.report'));
  assert.deepEqual(eventParam, [...CHUNK_KIND_EVENT_TYPES.finding]);
  assert.match(sql.where, /mi\.kind = ANY\(\$\d+::text\[\]\) OR e\.event_type = ANY\(\$\d+::text\[\]\)/);
});

test('buildRetrievalSql：已人工接受用半连接，暂定与取代版本可显式放开', () => {
  const sql = buildRetrievalSql({
    engagementId: 'eng-1',
    query: { query: 'q', onlyHumanAccepted: true, includeProvisional: false },
    includedAssetIds: [],
    excludedAssetIds: [],
    includeSuperseded: true,
  });
  assert.match(sql.where, /EXISTS \(SELECT 1 FROM pentest\.findings f/);
  assert.match(sql.where, /f\.status = 'human_accepted'/);
  assert.match(sql.where, /mc\.provisional = false/);
  assert.doesNotMatch(sql.where, /superseded_by_revision IS NULL/);
});

test('buildRetrievalSql：version-join 形态把范围公式下推为 NOT EXISTS 反连接 + EXISTS 半连接', () => {
  const sql = buildRetrievalSql({
    engagementId: 'eng-1',
    query: { query: 'q' },
    includedAssetIds: ['ignored'],
    excludedAssetIds: ['ignored'],
    scopeResolution: 'version-join',
    scopeVersion: 4,
  });
  assert.match(sql.where, /NOT EXISTS \(SELECT 1 FROM pentest\.asset_scope_versions x/);
  assert.match(sql.where, /x\.decision <> 'included' AND x\.asset_id = ANY\(mc\.asset_ids\)/);
  assert.match(sql.where, /mc\.asset_ids = '\{\}' OR EXISTS \(SELECT 1 FROM pentest\.asset_scope_versions i/);
  assert.match(sql.where, /i\.decision = 'included' AND i\.asset_id = ANY\(mc\.asset_ids\)/);
  assert.ok(sql.params.includes(4), '范围版本作为参数下推');
  assert.equal(
    sql.params.some((p) => Array.isArray(p)),
    false,
    'version-join 形态不再需要应用层预解析出的资产集合',
  );
});

test('buildRetrievalSql：version-join 缺少 scopeVersion 直接拒绝', () => {
  assert.throws(
    () =>
      buildRetrievalSql({
        engagementId: 'eng-1',
        query: { query: 'q' },
        includedAssetIds: [],
        excludedAssetIds: [],
        scopeResolution: 'version-join',
      }),
    RangeError,
  );
});

// ───────────────────────────── §8.5 分块边界 ─────────────────────────────

test('分块：人类输入、人工决策、交接、思考链各一条事件一块', () => {
  const human = planChunks(sourceEvent());
  assert.equal(human.length, 1);
  assert.equal(human[0]!.kind, 'human_input');
  assert.equal(human[0]!.part, null);
  assert.equal(human[0]!.content, '把 10.0.0.5 加进目标');

  const decision = planChunks(
    sourceEvent({ eventType: 'human.decision', payload: { text: '同意越权测试' }, assetIds: ['a'] }),
  );
  assert.equal(decision[0]!.kind, 'decision');
  assert.deepEqual(decision[0]!.assetIds, ['a']);

  const handoff = planChunks(
    sourceEvent({ eventType: 'handoff.confirmed', payload: { text: '交给利用阶段' } }),
  );
  assert.equal(handoff[0]!.kind, 'handoff');

  const reasoning = planChunks(
    sourceEvent({
      eventType: 'llm.reasoning',
      trustLevel: 'model_reasoning',
      classification: 'reasoning',
      payload: { text: '先探测 8080' },
    }),
  );
  assert.equal(reasoning.length, 1);
  assert.equal(reasoning[0]!.kind, 'reasoning');
  assert.equal(reasoning[0]!.classification, 'reasoning');
});

test('分块：压缩摘要作为记忆条目入库，资产留空且保留原事件引用', () => {
  const chunks = planChunks(
    sourceEvent({
      eventType: 'context.compacted',
      trustLevel: 'agent_claim',
      payload: { summary: '前 12 轮：完成端口扫描', compactedThroughTurn: 12, sourceEventRefs: ['e1', 'e2'] },
    }),
  );
  assert.equal(chunks.length, 1);
  assert.equal(chunks[0]!.kind, 'compaction_summary');
  assert.deepEqual(chunks[0]!.assetIds, []);
  assert.match(chunks[0]!.content, /前 12 轮/);
  assert.match(chunks[0]!.content, /e1, e2/);
});

test('分块：报告按摘要、事实、假设、结论、限制分段并保留报告父级', () => {
  const chunks = planChunks(
    sourceEvent({
      eventType: 'worker.report',
      trustLevel: 'agent_claim',
      payload: {
        summary: '本轮完成纵向探测',
        facts: ['8080 开放', 'nmap 版本 7.94'],
        hypotheses: ['可能存在未打补丁的中间件'],
        findings: ['CVE-2021-1234 未修补'],
        limitations: ['未测试 UDP'],
      },
      assetIds: ['a1'],
    }),
  );
  assert.deepEqual(
    chunks.map((c) => [c.part, c.kind]),
    [
      ['summary', 'report_summary'],
      ['facts', 'fact'],
      ['hypotheses', 'hypothesis'],
      ['findings', 'finding'],
      ['limitations', 'limitation'],
    ],
  );
  assert.deepEqual(chunks.map((c) => c.ordinal), [0, 1, 2, 3, 4]);
  assert.ok(chunks.every((c) => c.parentRef === 'evt-1'), '保留报告父级');
  assert.ok(chunks.every((c) => c.sourceEventId === 'evt-1'));
  assert.match(chunks[1]!.content, /8080 开放\nnmap 版本 7\.94/);
});

test('分块：报告空段跳过，不产生空分块', () => {
  const chunks = planChunks(
    sourceEvent({ eventType: 'worker.report', payload: { summary: '只有摘要', facts: [], findings: [''] } }),
  );
  assert.deepEqual(chunks.map((c) => c.part), ['summary']);
});

test('分块：工具输出按命令、标准输出、错误输出、退出码分组，序号连续', () => {
  const chunks = planChunks(
    sourceEvent({
      eventType: 'tool.result',
      trustLevel: 'tool_observation',
      payload: {
        toolRunId: 'run-7',
        command: 'nmap -sV 10.0.0.5',
        target: '10.0.0.5',
        startedAt: '2026-09-19T00:00:00.000Z',
        stdout: 'PORT   STATE SERVICE',
        stderr: 'warning: slow scan',
        exitCode: 0,
        status: 'completed',
      },
      assetIds: ['a1'],
    }),
  );
  assert.deepEqual(chunks.map((c) => c.part), ['command', 'stdout', 'stderr', 'exit']);
  assert.deepEqual(chunks.map((c) => c.ordinal), [0, 1, 2, 3]);
  assert.match(chunks[0]!.content, /命令: nmap -sV 10\.0\.0\.5/);
  assert.match(chunks[3]!.content, /退出码: 0/);
  assert.ok(chunks.every((c) => c.parentRef === 'run-7'));
  assert.ok(chunks.every((c) => c.kind === 'tool_observation'));
});

test('分块：超长输出按固定窗口重叠切分，窗口重叠且序号续排', () => {
  const stdout = 'x'.repeat(5_000);
  const windows = splitFixedWindow(stdout, { windowChars: 2_000, overlapChars: 200 });
  assert.deepEqual(windows.map((w) => [w.start, w.end]), [
    [0, 2000],
    [1800, 3800],
    [3600, 5000],
  ]);
  assert.equal(windows[0]!.text.length, 2000);
  assert.equal(windows[2]!.text.length, 1400);

  const chunks = planChunks(
    sourceEvent({
      eventType: 'tool.result',
      payload: { toolRunId: 'run-8', stdout },
    }),
    { windowChars: 2_000, overlapChars: 200 },
  );
  assert.equal(chunks.length, 3);
  assert.deepEqual(chunks.map((c) => c.ordinal), [0, 1, 2]);
  assert.deepEqual(chunks.map((c) => c.range), [
    { start: 0, end: 2000 },
    { start: 1800, end: 3800 },
    { start: 3600, end: 5000 },
  ]);
  assert.equal(chunks[1]!.content.slice(0, 200), chunks[0]!.content.slice(-200), '相邻窗口重叠 200 字符');
  assert.equal(chunks[0]!.contentHash, sha256Hex(chunks[0]!.content));
});

test('分块：非法窗口参数直接拒绝（不是静默退化）', () => {
  assert.throws(() => splitFixedWindow('abc', { windowChars: 0 }), RangeError);
  assert.throws(() => splitFixedWindow('abc', { windowChars: 10, overlapChars: 10 }), RangeError);
  assert.throws(() => splitFixedWindow('abc', { windowChars: 10, overlapChars: -1 }), RangeError);
});

test('分块：HTTP 交换只留元数据与正文摘要，凭据类头部脱敏，原始正文仅作证据引用', () => {
  const chunks = planChunks(
    sourceEvent({
      eventType: 'tool.result',
      trustLevel: 'tool_observation',
      payload: {
        toolRunId: 'run-9',
        contentType: 'http',
        http: {
          method: 'GET',
          path: '/admin',
          statusCode: 200,
          headers: {
            'content-type': 'application/json',
            'x-powered-by': 'Express',
            'set-cookie': 'session=deadbeef',
            'x-internal-trace': 'abc',
          },
          bodySummary: '返回用户列表，含 12 条记录',
          bodyDigest: 'f'.repeat(64),
          rawBodyRef: 'artifact:raw-body',
        },
      },
    }),
  );
  assert.equal(chunks.length, 1);
  assert.equal(chunks[0]!.kind, 'http_exchange');
  assert.equal(chunks[0]!.part, 'http_metadata');
  assert.match(chunks[0]!.content, /状态码: 200/);
  assert.match(chunks[0]!.content, /路径: \/admin/);
  assert.match(chunks[0]!.content, /content-type: application\/json/);
  assert.match(chunks[0]!.content, /set-cookie: «redacted»/, '凭据类头部脱敏');
  assert.doesNotMatch(chunks[0]!.content, /deadbeef/);
  assert.doesNotMatch(chunks[0]!.content, /x-internal-trace/, '白名单外的头部不进投影');
  assert.match(chunks[0]!.content, /正文摘要: 返回用户列表/);
  assert.match(chunks[0]!.content, /正文 SHA-256: f{64}/);
  assert.deepEqual(chunks[0]!.evidenceRefs, ['artifact:raw-body']);
});

test('分块：JSON 正文同样只存摘要（原始正文关联为加密证据）', () => {
  const chunks = planChunks(
    sourceEvent({
      eventType: 'tool.result',
      payload: {
        contentType: 'json',
        bodySummary: '包含 3 个用户对象',
        bodyDigest: 'a'.repeat(64),
        rawBodyRef: 'artifact:json-body',
      },
    }),
  );
  assert.equal(chunks[0]!.kind, 'http_exchange');
  assert.match(chunks[0]!.content, /正文摘要: 包含 3 个用户对象/);
  assert.deepEqual(chunks[0]!.evidenceRefs, ['artifact:json-body']);
});

test('分块：二进制只存元数据与哈希，不建立索引', () => {
  const chunks = planChunks(
    sourceEvent({
      eventType: 'tool.artifact',
      trustLevel: 'tool_observation',
      payload: {
        contentType: 'binary',
        binary: {
          mimeType: 'application/x-elf',
          byteLength: 8_192,
          sha256: 'b'.repeat(64),
          protocolSummary: 'ELF 64-bit LSB executable',
          extractedTextRef: 'artifact:strings-out',
        },
      },
    }),
  );
  assert.equal(chunks.length, 1);
  assert.equal(chunks[0]!.kind, 'binary_evidence');
  assert.equal(chunks[0]!.indexable, false);
  assert.match(chunks[0]!.content, /SHA-256: b{64}/);
  assert.match(chunks[0]!.content, /不内联、不嵌入/);
  assert.deepEqual(chunks[0]!.evidenceRefs, ['artifact:strings-out']);
});

test('分块：不属于 §8.5 来源的控制面事件不产生分块', () => {
  assert.deepEqual(planChunks(sourceEvent({ eventType: 'lease.issued', payload: {} })), []);
  assert.deepEqual(planChunks(sourceEvent({ eventType: 'phase.transition', payload: {} })), []);
  assert.deepEqual(planChunks(sourceEvent({ eventType: 'human.input', payload: { text: '' } })), []);
});

test('分块：标识与去重键确定性派生（重跑不产生重复分块）', () => {
  const first = planChunks(sourceEvent({ embeddingRevision: 'rev-1' }));
  const second = planChunks(sourceEvent({ embeddingRevision: 'rev-1' }));
  assert.equal(first[0]!.chunkId, second[0]!.chunkId);
  assert.equal(first[0]!.dedupeKey, second[0]!.dedupeKey);

  const otherRevision = planChunks(sourceEvent({ embeddingRevision: 'rev-2' }));
  assert.notEqual(first[0]!.chunkId, otherRevision[0]!.chunkId, '嵌入版本是唯一键的一部分');

  const otherOrdinal = deriveChunkId({
    engagementId: 'eng-1',
    sourceEventId: 'evt-1',
    ordinal: 1,
    embeddingRevision: 'rev-1',
  });
  assert.notEqual(first[0]!.chunkId, otherOrdinal);
  assert.match(first[0]!.chunkId, /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u);
});

test('写入侧义务：来源含目标却未填资产的分块被拒绝，无归属类型允许留空', () => {
  const rejected = checkChunkAssetObligation({
    kind: 'tool_observation',
    assetIds: [],
    sourceEventId: 'evt-1',
    targetHints: ['10.0.0.5'],
  });
  assert.equal(rejected.ok, false);
  assert.equal(rejected.ok === false && rejected.code, 'target_not_adjudicated');

  assert.equal(
    checkChunkAssetObligation({
      kind: 'tool_observation',
      assetIds: ['a1'],
      sourceEventId: 'evt-1',
      targetHints: ['10.0.0.5'],
    }).ok,
    true,
  );
  assert.equal(
    checkChunkAssetObligation({
      kind: 'tool_observation',
      assetIds: [],
      sourceEventId: 'evt-1',
      targetHints: [],
    }).ok,
    true,
    '解析不出归属时允许留空',
  );
  for (const kind of ['human_input', 'decision', 'handoff', 'compaction_summary', 'reasoning'] as const) {
    assert.equal(
      checkChunkAssetObligation({ kind, assetIds: [], sourceEventId: 'evt-1', targetHints: ['x'] }).ok,
      true,
      `${kind} 本来就无资产归属`,
    );
  }
  assert.equal(
    checkChunkAssetObligation({
      kind: 'fact',
      assetIds: [],
      sourceEventId: 'evt-report',
      targetHints: ['10.0.0.5'],
    }).ok,
    false,
    '报告分段若来源含目标也必须填资产',
  );
});

test('写入侧义务：批量校验任一不满足即整体拒绝（含真实分块草稿）', () => {
  const chunks: readonly ChunkDraft[] = planChunks(
    sourceEvent({
      eventType: 'tool.result',
      payload: { toolRunId: 'run-1', command: 'curl http://10.0.0.5/admin' },
    }),
  );
  assert.equal(checkChunkBatchWritable({ chunks, targetHints: ['10.0.0.5'] }).ok, false);
  const withAssets = planChunks(
    sourceEvent({
      eventType: 'tool.result',
      payload: { toolRunId: 'run-1', command: 'curl http://10.0.0.5/admin' },
      assetIds: ['a1'],
    }),
  );
  assert.equal(checkChunkBatchWritable({ chunks: withAssets, targetHints: ['10.0.0.5'] }).ok, true);
});
