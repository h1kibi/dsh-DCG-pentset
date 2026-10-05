/**
 * 记忆检索（设计文档 §8.3 思考链 / §8.6 混合检索 / §8.7 Agent 主动检索）。
 *
 * 三件事：
 * 1. 范围过滤谓词（§8.6）——本模块最关键的部分，同时决定「被排除资产的内容不能泄露」
 *    与「无资产归属的内容不能被误伤」：
 *      可见 ⟺ NOT (chunk.asset_ids ∩ X(v) ≠ ∅)
 *            ∧ (chunk.asset_ids ∩ I(v) ≠ ∅ ∨ chunk.asset_ids = ∅)
 *    排除优先（含任一被排除资产即不可见），空 asset_ids 放行（否则思考链与压缩摘要整批消失），
 *    pending 与 excluded 同等处理，范围版本升级后原先被排除的分块自动重新可见——无需重建索引。
 * 2. 倒数排名融合三路信号（向量近邻 / 全文检索 / 三元组相似），再叠加来源权威度、时效性与暂定惩罚。
 *    思考链与其他记忆类型共用同一套排序规则，不额外加分也不额外降权（§8.6）。
 * 3. 可下推到 PostgreSQL 的 WHERE 子句（§8.6：检索在 PostgreSQL 内完成）。
 *
 * `include_reasoning` 是筛选开关而非权限门禁（§8.3）：本 engagement 内任意阶段 Agent
 * 都可以检索与阅读思考链；传 false 只表示「本次只要非思考链条目」。
 */

import type {
  Classification,
  Phase,
  ScopeDecision,
  ScopeFilterInput,
  TrustLevel,
} from '../contracts.ts';
import { CHUNK_KIND_EVENT_TYPES, REASONING_EVENT_TYPES, type ChunkKind } from './chunks.ts';

// ───────────────────────────── 范围过滤谓词（§8.6） ─────────────────────────────

/**
 * 分块可见性判定。严格按 §8.6 的公式，三项含义都体现在代码里：
 * 排除优先、已纳入放行、空 asset_ids 放行。
 *
 * 注意调用方传入的 `excludedAssetIds` 必须已经把 `pending` 并入（见 {@link resolveScopeSets}）。
 */
export function isChunkVisibleInScope(input: ScopeFilterInput): boolean {
  // NOT (chunk.asset_ids ∩ X(v) ≠ ∅)：含任一被排除资产即不可见，排除是硬边界。
  if (input.chunkAssetIds.some((assetId) => input.excludedAssetIds.has(assetId))) return false;
  // chunk.asset_ids = ∅：人工决策、插话、压缩摘要、思考链本就没有资产归属，必须放行。
  if (input.chunkAssetIds.length === 0) return true;
  // chunk.asset_ids ∩ I(v) ≠ ∅：含已纳入资产则可见。
  return input.chunkAssetIds.some((assetId) => input.includedAssetIds.has(assetId));
}

/** asset_scope_versions 的一行（§9 数据模型）。 */
export interface AssetScopeDecisionRow {
  readonly assetId: string;
  readonly scopeVersion: number;
  readonly decision: ScopeDecision;
}

export interface ScopeSets {
  readonly included: ReadonlySet<string>;
  readonly excluded: ReadonlySet<string>;
}

/**
 * 由范围版本 v 的决策行解析出 I(v) 与 X(v)。
 * 只有恰好属于该版本的行参与；`pending` 与 `excluded` 合并进 X(v)（§8.6：未纳入即不可见）。
 * 决议缺席的资产既不进 I 也不进 X，因此不会被任何分块「带入可见」——fail-closed。
 */
export function resolveScopeSets(
  rows: readonly AssetScopeDecisionRow[],
  scopeVersion: number,
): ScopeSets {
  const included = new Set<string>();
  const excluded = new Set<string>();
  for (const row of rows) {
    if (row.scopeVersion !== scopeVersion) continue;
    if (row.decision === 'included') included.add(row.assetId);
    else excluded.add(row.assetId);
  }
  return { included, excluded };
}

/** 用范围集合构造谓词输入。 */
export function scopeFilterInput(
  chunkAssetIds: readonly string[],
  sets: ScopeSets,
): ScopeFilterInput {
  return { chunkAssetIds, includedAssetIds: sets.included, excludedAssetIds: sets.excluded };
}

// ───────────────────────────── 融合排序（§8.6） ─────────────────────────────

const RETRIEVAL_ROUTES = ['semantic', 'lexical', 'trigram'] as const;
export type RetrievalRoute = (typeof RETRIEVAL_ROUTES)[number];

/** 倒数排名融合常数。 */
export const RRF_K = 60;

/** 单路第一名在融合分中的贡献，作为叠加项（权威度、时效性、暂定惩罚）的计量单位。 */
export const RRF_UNIT = 1 / (RRF_K + 1);

/**
 * 来源权威度叠加（§8.6「人工决策与工具观测优先」）。
 * 只给这两档加成，其余层级不加也不减——来源可信度本身是过滤字段与展示标签，
 * 不额外降权，思考链因此不会因为「模型推理」这一标签被系统性压低。
 */
export const SOURCE_AUTHORITY_BONUS: Readonly<Record<TrustLevel, number>> = {
  human_decision: RRF_UNIT,
  tool_observation: RRF_UNIT,
  agent_claim: 0,
  model_reasoning: 0,
  external_untrusted: 0,
};

/** 时效性：新近内容最多加成半个 RRF 单位，按半衰期衰减。 */
const RECENCY_MAX_BONUS = RRF_UNIT / 2;
const RECENCY_HALF_LIFE_DAYS = 7;

/** 暂定惩罚（§8.4：未完成的流式片段标记为暂定）。 */
export const PROVISIONAL_PENALTY = RRF_UNIT;

interface RouteRank {
  /** 1 起的排名；<= 0 或缺失表示该路没有命中。 */
  readonly chunkId: string;
  readonly rank: number;
}

type RouteRankings = Readonly<Partial<Record<RetrievalRoute, readonly RouteRank[]>>>;

interface RrfContribution {
  readonly chunkId: string;
  readonly score: number;
  /** 命中的路数，按 canonical 顺序。 */
  readonly routes: readonly RetrievalRoute[];
}

/**
 * 倒数排名融合：score = Σ w(route) / (k + rank)。
 * 命中多路的分块天然排在只命中单路的前面；同分由调用方按分块标识稳定决胜。
 */
export function fuseRrf(
  rankings: RouteRankings,
  options: { readonly k?: number; readonly weights?: Partial<Record<RetrievalRoute, number>> } = {},
): ReadonlyMap<string, RrfContribution> {
  const k = options.k ?? RRF_K;
  if (!Number.isInteger(k) || k < 0) throw new RangeError('k 必须是 >= 0 的整数');
  const contributions = new Map<string, { score: number; routes: RetrievalRoute[] }>();
  for (const route of RETRIEVAL_ROUTES) {
    const weight = options.weights?.[route] ?? 1;
    if (weight === 0) continue;
    // 同一路内同一分块重复出现时只取最好排名，避免把一次命中算成两次。
    const bestRank = new Map<string, number>();
    for (const entry of rankings[route] ?? []) {
      if (!Number.isInteger(entry.rank) || entry.rank < 1) continue;
      const known = bestRank.get(entry.chunkId);
      if (known === undefined || entry.rank < known) bestRank.set(entry.chunkId, entry.rank);
    }
    for (const [chunkId, rank] of bestRank) {
      const current = contributions.get(chunkId) ?? { score: 0, routes: [] };
      current.score += weight / (k + rank);
      current.routes.push(route);
      contributions.set(chunkId, current);
    }
  }
  const fused = new Map<string, RrfContribution>();
  for (const [chunkId, value] of contributions) {
    fused.set(chunkId, { chunkId, score: value.score, routes: value.routes });
  }
  return fused;
}

/** 时效性加成：按「距今天数的半衰期衰减」，不引入与记忆类型相关的任何项。 */
export function recencyBonus(
  occurredAt: string,
  now: Date,
  halfLifeDays: number = RECENCY_HALF_LIFE_DAYS,
): number {
  const ageMs = now.getTime() - new Date(occurredAt).getTime();
  const ageDays = ageMs <= 0 ? 0 : ageMs / 86_400_000;
  return RECENCY_MAX_BONUS * 0.5 ** (ageDays / halfLifeDays);
}

interface ScoreBreakdown {
  /** 三路融合分。 */
  readonly rrf: number;
  readonly authority: number;
  readonly recency: number;
  /** 暂定惩罚，取负值。 */
  readonly provisionalPenalty: number;
  readonly final: number;
}

/**
 * 最终分 = RRF + 权威度 + 时效性 − 暂定惩罚。
 * 入参只有排名、来源可信度、时间与暂定标记——**没有与记忆类型相关的项**，
 * 因此思考链与其他类型走同一套排序规则（§8.6）。
 */
export function scoreCandidate(input: {
  readonly rrf: number;
  readonly trustLevel: TrustLevel;
  readonly occurredAt: string;
  readonly provisional: boolean;
  readonly now: Date;
}): ScoreBreakdown {
  const authority = SOURCE_AUTHORITY_BONUS[input.trustLevel] ?? 0;
  const recency = recencyBonus(input.occurredAt, input.now);
  const penalty = input.provisional ? -PROVISIONAL_PENALTY : 0;
  return {
    rrf: input.rrf,
    authority,
    recency,
    provisionalPenalty: penalty,
    final: input.rrf + authority + recency + penalty,
  };
}

// ───────────────────────────── 检索（§8.7） ─────────────────────────────

export const DEFAULT_RETRIEVAL_LIMIT = 8;
export const MAX_RETRIEVAL_LIMIT = 50;
export const DEFAULT_EXCERPT_CHARS = 400;

/** §8.3：检索结果与界面统一标注，不把推理等同于事实。 */
export const REASONING_LABEL = '模型内部推理，不等同于事实';

/** 检索候选（SQL 三路检索的产物 + 分块元数据）。 */
export interface RetrievalCandidate {
  readonly chunkId: string;
  readonly kind: ChunkKind;
  readonly engagementId: string;
  readonly trustLevel: TrustLevel;
  readonly classification: Classification;
  readonly assetIds: readonly string[];
  readonly findingIds: readonly string[];
  readonly phase: Phase | null;
  readonly workerSessionId: string | null;
  readonly sourceEventId: string | null;
  readonly occurredAt: string;
  readonly provisional: boolean;
  readonly humanAccepted: boolean;
  /** false 表示二进制等「只存元数据」的分块，不进入检索（§8.5）。 */
  readonly indexable: boolean;
  readonly excerpt: string;
  readonly semanticRank?: number | null;
  readonly lexicalRank?: number | null;
  readonly trigramRank?: number | null;
}

/** §8.7 检索入参（字段名与设计文档一致；服务端补 engagement 与范围版本）。 */
export interface MemoryQuery {
  readonly query: string;
  readonly phase?: Phase | null;
  readonly kinds?: readonly ChunkKind[];
  readonly trustLevels?: readonly TrustLevel[];
  readonly classifications?: readonly Classification[];
  readonly assetIds?: readonly string[];
  readonly findingIds?: readonly string[];
  readonly workerSessionIds?: readonly string[];
  readonly from?: string | Date;
  readonly to?: string | Date;
  /** 是否纳入暂定分块；不传时纳入（但带惩罚）。§8.6 过滤维度「是否暂定」。 */
  readonly includeProvisional?: boolean;
  /** 只看已人工接受的结论（§8.6 过滤维度「是否已人工接受」）。 */
  readonly onlyHumanAccepted?: boolean;
  /** §8.3 筛选开关，不是权限门禁：不传时思考链与其他类型一同参与检索。 */
  readonly includeReasoning?: boolean;
  readonly limit?: number;
}

type CandidateRejection =
  | 'foreign_engagement'
  | 'not_indexable'
  | 'scope'
  | 'filter'
  | 'no_route_hit';

interface ScreenContext {
  readonly query: MemoryQuery;
  readonly scope: ScopeSets;
  readonly now: Date;
}

function withinTimeRange(occurredAt: string, from?: string | Date, to?: string | Date): boolean {
  const at = new Date(occurredAt).getTime();
  if (from !== undefined && at < new Date(from).getTime()) return false;
  if (to !== undefined && at > new Date(to).getTime()) return false;
  return true;
}

function overlaps(candidate: readonly string[], requested: readonly string[]): boolean {
  return candidate.some((id) => requested.includes(id));
}

/**
 * 逐候选判定：先判可索引性与思考链开关，再判范围，再判过滤维度。
 * engagement 归属先于本函数在 searchMemory 中判定。
 * 返回的拒绝原因用于审计计数（只计数，不回流内容）。
 */
export function screenCandidate(
  candidate: RetrievalCandidate,
  context: ScreenContext,
): CandidateRejection | null {
  const { query, scope } = context;
  if (!candidate.indexable) return 'not_indexable';
  if (query.includeReasoning === false && candidate.kind === 'reasoning') return 'filter';
  if (
    !isChunkVisibleInScope({
      chunkAssetIds: candidate.assetIds,
      includedAssetIds: scope.included,
      excludedAssetIds: scope.excluded,
    })
  ) {
    return 'scope';
  }
  if (query.phase !== undefined && query.phase !== null && candidate.phase !== query.phase) {
    return 'filter';
  }
  if (query.kinds !== undefined && query.kinds.length > 0 && !query.kinds.includes(candidate.kind)) {
    return 'filter';
  }
  if (
    query.trustLevels !== undefined &&
    query.trustLevels.length > 0 &&
    !query.trustLevels.includes(candidate.trustLevel)
  ) {
    return 'filter';
  }
  if (
    query.classifications !== undefined &&
    query.classifications.length > 0 &&
    !query.classifications.includes(candidate.classification)
  ) {
    return 'filter';
  }
  if (query.assetIds !== undefined && query.assetIds.length > 0 && !overlaps(candidate.assetIds, query.assetIds)) {
    return 'filter';
  }
  if (
    query.findingIds !== undefined &&
    query.findingIds.length > 0 &&
    !overlaps(candidate.findingIds, query.findingIds)
  ) {
    return 'filter';
  }
  if (
    query.workerSessionIds !== undefined &&
    query.workerSessionIds.length > 0 &&
    (candidate.workerSessionId === null || !query.workerSessionIds.includes(candidate.workerSessionId))
  ) {
    return 'filter';
  }
  if (!withinTimeRange(candidate.occurredAt, query.from, query.to)) return 'filter';
  if (query.includeProvisional === false && candidate.provisional) return 'filter';
  if (query.onlyHumanAccepted === true && !candidate.humanAccepted) return 'filter';
  const ranks = [candidate.semanticRank, candidate.lexicalRank, candidate.trigramRank];
  if (!ranks.some((rank) => typeof rank === 'number' && rank >= 1)) return 'no_route_hit';
  return null;
}

export interface MemoryHit {
  readonly chunkId: string;
  readonly kind: ChunkKind;
  readonly excerpt: string;
  readonly score: number;
  readonly breakdown: ScoreBreakdown;
  readonly routes: readonly RetrievalRoute[];
  readonly trustLevel: TrustLevel;
  readonly classification: Classification;
  readonly assetIds: readonly string[];
  readonly findingIds: readonly string[];
  readonly sourceEventId: string | null;
  readonly workerSessionId: string | null;
  readonly phase: Phase | null;
  readonly occurredAt: string;
  readonly provisional: boolean;
  /** 引用标识（§7.x / §8.6：`memory:<id>`）。 */
  readonly citation: string;
  /** 思考链条目必须带标注（§8.3）。 */
  readonly reasoningLabel: string | null;
}

interface MemorySearchInput {
  /** 服务端从会话解析出的 engagement；Agent 无法指定其他 engagement（§8.6 / §8.7）。 */
  readonly boundEngagementId: string;
  readonly query: MemoryQuery;
  /** 会话绑定的范围版本解析出的 I(v) 与 X(v)。 */
  readonly scope: ScopeSets;
  readonly candidates: readonly RetrievalCandidate[];
  readonly now?: Date;
}

export interface MemorySearchResult {
  readonly hits: readonly MemoryHit[];
  /** 参与融合排序的候选数。 */
  readonly evaluated: number;
  readonly rejected: Readonly<Record<CandidateRejection, number>>;
  /** 命中的总数（截断前）。 */
  readonly matched: number;
  readonly limit: number;
  readonly includeReasoning: boolean;
}

export function truncateExcerpt(text: string, maxChars: number = DEFAULT_EXCERPT_CHARS): string {
  const collapsed = text.replace(/\s+/gu, ' ').trim();
  if (collapsed.length <= maxChars) return collapsed;
  return `${collapsed.slice(0, maxChars)}…`;
}

/**
 * 检索主入口：跨 engagement 拒绝（丢弃并计数）→ 范围过滤 → 过滤维度 → 三路融合 → 叠加排序 → 截断。
 * 排序在最终分相同时按分块标识升序决胜，保证同一输入的结果顺序稳定可复现。
 */
export function searchMemory(input: MemorySearchInput): MemorySearchResult {
  const now = input.now ?? new Date();
  const includeReasoning = input.query.includeReasoning !== false;
  const limit = Math.min(
    Math.max(input.query.limit ?? DEFAULT_RETRIEVAL_LIMIT, 0),
    MAX_RETRIEVAL_LIMIT,
  );

  const rejected: Record<CandidateRejection, number> = {
    foreign_engagement: 0,
    not_indexable: 0,
    scope: 0,
    filter: 0,
    no_route_hit: 0,
  };

  const screenContext: ScreenContext = { query: input.query, scope: input.scope, now };

  const admitted: RetrievalCandidate[] = [];
  for (const candidate of input.candidates) {
    if (candidate.engagementId !== input.boundEngagementId) {
      rejected.foreign_engagement += 1;
      continue;
    }
    const verdict = screenCandidate(candidate, screenContext);
    if (verdict !== null) {
      rejected[verdict] += 1;
      continue;
    }
    admitted.push(candidate);
  }

  const fused = fuseRrf({
    semantic: admitted
      .filter((c) => typeof c.semanticRank === 'number')
      .map((c) => ({ chunkId: c.chunkId, rank: c.semanticRank as number })),
    lexical: admitted
      .filter((c) => typeof c.lexicalRank === 'number')
      .map((c) => ({ chunkId: c.chunkId, rank: c.lexicalRank as number })),
    trigram: admitted
      .filter((c) => typeof c.trigramRank === 'number')
      .map((c) => ({ chunkId: c.chunkId, rank: c.trigramRank as number })),
  });

  const scored = admitted
    .filter((candidate) => fused.has(candidate.chunkId))
    .map((candidate) => {
      const contribution = fused.get(candidate.chunkId)!;
      const breakdown = scoreCandidate({
        rrf: contribution.score,
        trustLevel: candidate.trustLevel,
        occurredAt: candidate.occurredAt,
        provisional: candidate.provisional,
        now,
      });
      return { candidate, contribution, breakdown };
    });

  scored.sort((a, b) => {
    if (b.breakdown.final !== a.breakdown.final) return b.breakdown.final - a.breakdown.final;
    return a.candidate.chunkId < b.candidate.chunkId ? -1 : a.candidate.chunkId > b.candidate.chunkId ? 1 : 0;
  });

  const hits: MemoryHit[] = scored.slice(0, limit).map(({ candidate, contribution, breakdown }) => ({
    chunkId: candidate.chunkId,
    kind: candidate.kind,
    excerpt: truncateExcerpt(candidate.excerpt),
    score: breakdown.final,
    breakdown,
    routes: contribution.routes,
    trustLevel: candidate.trustLevel,
    classification: candidate.classification,
    assetIds: candidate.assetIds,
    findingIds: candidate.findingIds,
    sourceEventId: candidate.sourceEventId,
    workerSessionId: candidate.workerSessionId,
    phase: candidate.phase,
    occurredAt: candidate.occurredAt,
    provisional: candidate.provisional,
    citation: `memory:${candidate.chunkId}`,
    reasoningLabel: candidate.kind === 'reasoning' ? REASONING_LABEL : null,
  }));

  return {
    hits,
    evaluated: scored.length,
    rejected,
    matched: scored.length,
    limit,
    includeReasoning,
  };
}

// ───────────────────────────── SQL 下推（§8.6） ─────────────────────────────

interface RetrievalSqlInput {
  readonly engagementId: string;
  readonly query: MemoryQuery;
  readonly includedAssetIds: readonly string[];
  readonly excludedAssetIds: readonly string[];
  /**
   * 范围过滤的下推形态：
   * - `precomputed`（默认）：应用层已按会话范围版本解析出 I(v)/X(v)，用 `asset_ids` 的数组重叠谓词，
   *   由 `memory_chunks_asset_ids` 的 GIN 索引承担；
   * - `version-join`：把 §8.6 的公式直接按 `NOT EXISTS` 反连接 + `EXISTS` 半连接下推到
   *   `asset_scope_versions`，需要同时给出 `scopeVersion`。两者语义相同，`pending` 与 `excluded` 同等处理。
   */
  readonly scopeResolution?: 'precomputed' | 'version-join';
  /** 会话绑定的范围版本；`version-join` 形态必填。 */
  readonly scopeVersion?: number;
  /** 强制按当前生效嵌入版本过滤，避免跨版本向量比较（§9）。默认开启。 */
  readonly activeEmbeddingRevisionOnly?: boolean;
  /** 是否返回已被新嵌入版本取代的分块。默认不返回。 */
  readonly includeSuperseded?: boolean;
  /** memory_chunks 的别名，默认 `mc`。 */
  readonly alias?: string;
}

interface RetrievalSql {
  /** 追加到 FROM 之后的 JOIN 片段（kinds / include_reasoning 过滤需要）。 */
  readonly joins: readonly string[];
  /** WHERE 子句，不含 `WHERE` 关键字，占位符为 `$1…$n`。 */
  readonly where: string;
  /** 与占位符一一对应的参数，可直接交给 pg。 */
  readonly params: readonly unknown[];
}

/**
 * 生成可下推到 PostgreSQL 的过滤子句。
 *
 * 范围过滤是半连接/反连接的形态：`NOT (asset_ids && X) AND (asset_ids && I OR asset_ids = '{}')`，
 * 由 `memory_chunks_asset_ids` 的 GIN 索引承担（§9 索引清单）。
 * kinds / include_reasoning 需要 `context_events`（`memory_chunks` 没有 kind 列），
 * 用事件类型集合近似，报告各段共享来源事件类型因而可能多命中同报告的其他分段——
 * 恰好不违反范围约束，返回行仍按分块自身的 kind 复核。
 */
export function buildRetrievalSql(input: RetrievalSqlInput): RetrievalSql {
  const alias = input.alias ?? 'mc';
  const params: unknown[] = [];
  const bind = (value: unknown): string => {
    params.push(value);
    return `$${params.length}`;
  };
  const where: string[] = [];
  const joins: string[] = [];

  const engagementParam = bind(input.engagementId);
  where.push(`${alias}.engagement_id = ${engagementParam}::uuid`);

  if (input.activeEmbeddingRevisionOnly !== false) {
    // 只在**该 engagement 登记了活跃嵌入版本**时按版本过滤。
    //
    // 为什么需要那个 `NOT EXISTS` 守卫：lexical-only 部署（没有嵌入器）会把分块写成
    // `embedding_revision = 'lexical-only'` 而**不登记任何** `embedding_revisions` 行，
    // 于是 `mc.embedding_revision = (SELECT revision … WHERE is_active)` 右侧是 NULL、
    // 恒不相等——每一次检索都返回 0 条，而索引、水位、队列全都显示正常
    //（实测：个人档活体检索「事实」类内容 0 命中，而分块就在库里）。
    //
    // 过滤的**本意**是「不原地解释旧向量」（§9.1：换模型后旧版本分块不再返回）。
    // 没有活跃版本时不存在「旧版本」可谈，放行词法分块才是正确语义；
    // 一旦登记了活跃版本，过滤照原样生效（新版本激活后旧的 lexical-only 分块会被挡在外面，
    // 与「换模型不混用」一致）。
    where.push(
      `(NOT EXISTS (SELECT 1 FROM pentest.embedding_revisions r ` +
        `WHERE r.engagement_id = ${engagementParam}::uuid AND r.is_active) ` +
        `OR ${alias}.embedding_revision = (SELECT revision FROM pentest.embedding_revisions ` +
        `WHERE engagement_id = ${engagementParam}::uuid AND is_active))`,
    );
  }
  if (input.includeSuperseded !== true) {
    where.push(`${alias}.superseded_by_revision IS NULL`);
  }

  // 范围过滤谓词：排除优先 + 空归属放行（§8.6）。两条都必须存在，缺一条就会泄露或误伤。
  if (input.scopeResolution === 'version-join') {
    if (!Number.isInteger(input.scopeVersion)) {
      throw new RangeError('scopeResolution=version-join 必须提供整数 scopeVersion');
    }
    const versionParam = bind(input.scopeVersion);
    where.push(
      `NOT EXISTS (SELECT 1 FROM pentest.asset_scope_versions x ` +
        `WHERE x.engagement_id = ${engagementParam}::uuid AND x.scope_version = ${versionParam}::int ` +
        `AND x.decision <> 'included' AND x.asset_id = ANY(${alias}.asset_ids)) ` +
        `AND (${alias}.asset_ids = '{}' OR EXISTS (SELECT 1 FROM pentest.asset_scope_versions i ` +
        `WHERE i.engagement_id = ${engagementParam}::uuid AND i.scope_version = ${versionParam}::int ` +
        `AND i.decision = 'included' AND i.asset_id = ANY(${alias}.asset_ids)))`,
    );
  } else {
    const excludedParam = bind([...input.excludedAssetIds]);
    const includedParam = bind([...input.includedAssetIds]);
    where.push(
      `NOT (${alias}.asset_ids && ${excludedParam}::uuid[]) ` +
        `AND (${alias}.asset_ids && ${includedParam}::uuid[] OR ${alias}.asset_ids = '{}')`,
    );
  }

  const query = input.query;
  if (query.phase !== undefined && query.phase !== null) {
    where.push(`${alias}.phase = ${bind(query.phase)}::text`);
  }
  if (query.workerSessionIds !== undefined && query.workerSessionIds.length > 0) {
    where.push(`${alias}.worker_session_id = ANY(${bind([...query.workerSessionIds])}::uuid[])`);
  }
  if (query.trustLevels !== undefined && query.trustLevels.length > 0) {
    where.push(`${alias}.trust_level = ANY(${bind([...query.trustLevels])}::text[])`);
  }
  if (query.classifications !== undefined && query.classifications.length > 0) {
    where.push(`${alias}.classification = ANY(${bind([...query.classifications])}::text[])`);
  }
  if (query.assetIds !== undefined && query.assetIds.length > 0) {
    where.push(`${alias}.asset_ids && ${bind([...query.assetIds])}::uuid[]`);
  }
  if (query.findingIds !== undefined && query.findingIds.length > 0) {
    where.push(`${alias}.finding_ids && ${bind([...query.findingIds])}::uuid[]`);
  }
  if (query.from !== undefined) {
    where.push(`${alias}.created_at >= ${bind(new Date(query.from).toISOString())}::timestamptz`);
  }
  if (query.to !== undefined) {
    where.push(`${alias}.created_at <= ${bind(new Date(query.to).toISOString())}::timestamptz`);
  }
  if (query.includeProvisional === false) {
    where.push(`${alias}.provisional = false`);
  }
  if (query.onlyHumanAccepted === true) {
    where.push(
      `(${alias}.finding_ids <> '{}' AND EXISTS (SELECT 1 FROM pentest.findings f ` +
        `WHERE f.id = ANY(${alias}.finding_ids) AND f.status = 'human_accepted'))`,
    );
  }

  const needsEvents =
    query.includeReasoning === false || (query.kinds !== undefined && query.kinds.length > 0);
  if (query.kinds !== undefined && query.kinds.length > 0) {
    joins.push(`LEFT JOIN pentest.memory_items mi ON mi.id = ${alias}.memory_item_id`);
  }
  if (needsEvents) {
    joins.push(`LEFT JOIN pentest.context_events e ON e.event_id = ${alias}.source_event_id`);
  }
  if (query.kinds !== undefined && query.kinds.length > 0) {
    const eventTypes = [
      ...new Set(query.kinds.flatMap((kind) => CHUNK_KIND_EVENT_TYPES[kind] ?? [])),
    ];
    where.push(
      `(mi.kind = ANY(${bind([...query.kinds])}::text[]) ` +
        `OR e.event_type = ANY(${bind(eventTypes)}::text[]))`,
    );
  }
  if (query.includeReasoning === false) {
    // 非事件来源的分块（memory_item_id 来源）event_type 为 NULL，必须一并保留。
    where.push(
      `(e.event_type IS NULL OR e.event_type <> ALL(${bind([...REASONING_EVENT_TYPES])}::text[]))`,
    );
  }

  return { joins, where: where.join('\n  AND '), params };
}
