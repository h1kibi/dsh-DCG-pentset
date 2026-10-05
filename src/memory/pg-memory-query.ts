/**
 * 控制台面向的记忆检索面（设计文档 §8.6 混合检索 / §8.7 Agent 主动检索 /
 * §8.3 思考链与访问审计 / §8.4 索引水位 / §9.2 数据模型）。
 *
 * ── 与 `PgWorkerTools`（`src/memory/pg-worker-tools.ts`）的关系：换入口语义，不换判定逻辑 ──
 *
 * - Worker 面的 engagement 从**当前会话**解析，Agent 不能指定别的 engagement；控制台没有
 *   会话上下文，engagement 由操作者显式给出（§8.7「控制台可按 engagement 检索」）。
 * - 因此范围过滤的版本来源不同：会话用**冻结的** `worker_sessions.scope_version`（那是
 *   「这次会话当时能看什么」），控制台用该 engagement 的**当前**范围版本（`max(version)`，
 *   即 §5.4 范围修订后的最新版本）——控制台要回答的是「现在这个 engagement 能看到什么」。
 *   两者共用同一份 §8.6 谓词，只是代入的 v 不同。
 * - 排序与范围过滤**不在这里重写**：`searchMemory` / `resolveScopeSets` /
 *   `isChunkVisibleInScope` / `buildRetrievalSql` 都来自 `src/memory/retrieval.ts`；
 *   本模块只做「范围版本 → 集合」解析、真实 SQL 取数、结果映射，以及审计。
 *
 * ── `includeReasoning` 是筛选开关，不是权限门禁（§8.3） ──
 *
 * 思考链对本 engagement 的全部 Worker 与控制台开放。不传时思考链与其他类型一同参与检索；
 * 传 `false` 只表示「本次只要非思考链条目」。本模块**不做任何权限判定**，原样交给纯逻辑，
 * 由 `retrieval.ts` 的 `includeReasoning === false` 分支筛选（SQL 下推 + 融合层复核各一次）。
 *
 * ── 会话隔离（§2.2 的同一条原则在此处的形态） ──
 *
 * 已创建的会话冻结了自己的 `scope_version` 与 `skill_ids` 快照；控制台改范围、读记忆、
 * 调水位都**不回溯**改写那些会话看到过的内容。本模块是**只读的**——唯一的写入是
 * `memory.access` 审计事件，从不 UPDATE 任何既有行（范围修订属于工作流面，不在这里）。
 *
 * ── 两处明确的设计取舍 ──
 *
 * 1. **检索不写 `retrieval_queries`**（§8.7「写入检索记录」）。该表对 `origin='console'`
 *    有 `CHECK (origin <> 'console' OR operator_id IS NOT NULL)`，而契约的
 *    `MemorySearchRequest` 没有操作者字段（`readMemory` 有 `reason`，`searchMemory` 没有）。
 *    用占位操作者名落库等于伪造审计主体，比不落更糟，因此控制台检索暂不落检索记录；
 *    等契约补上操作者标识后再接。水位仍随结果返回（§8.4 要求）。
 * 2. **读取只接受 `memory:<chunkId>` 与 `event:<eventId>` 两种引用**。`searchMemory`
 *    产出的 `citation` 永远是 `memory:<分块标识>`，因此控制台不存在「条目标识」来源；
 *    而 `memory_items` 没有资产归属列（§9.2），Worker 面对条目引用的读取因此绕不过
 *    §8.6 的排除边界。控制台面**不提供**这条路径：不可见的引用一律拒绝，fail-closed。
 *    `event:<eventId>` 同理：事件正文**只**由可见分块拼成，一个可见分块都没有时不回退到
 *    `context_events.payload_json`（那是未脱敏原文，且「索引滞后」与「被排除」在返回值上
 *    无法区分）。见 `#eventRecord` 里的说明。
 */

import { randomUUID } from 'node:crypto';

import type {
  Classification,
  ErrorCode,
  MemoryLedgerService,
  MemoryReadRequest,
  MemoryRecord,
  MemorySearchHit,
  MemorySearchRequest,
  MemorySearchResultSet,
  MemoryWatermark,
  PentestMemoryQueryService,
  LedgerVerificationView,
  Phase,
  TrustLevel,
} from '../contracts.ts';
import { isPhase } from '../contracts.ts';
import {
  CHUNKABLE_EVENT_TYPES,
  CHUNK_KINDS,
  REPORT_EVENT_TYPES,
  deriveChunkKind,
  isChunkKind,
  planChunks,
  sha256Hex,
  type ChunkKind,
  type ChunkSourceEvent,
} from './chunks.ts';
import { CLASSIFICATIONS, TRUST_LEVELS } from './hash.ts';
import type { DbClient } from './ledger.ts';
import { currentScopeVersion, scopeSetsForVersion } from './session-context.ts';
import {
  DEFAULT_RETRIEVAL_LIMIT,
  MAX_RETRIEVAL_LIMIT,
  buildRetrievalSql,
  isChunkVisibleInScope,
  scopeFilterInput,
  searchMemory,
  type MemoryQuery,
  type RetrievalCandidate,
  type ScopeSets,
} from './retrieval.ts';

// ───────────────────────────── 检索参数常量 ─────────────────────────────

/**
 * 每路候选取回条数相对请求上限的倍数，以及下界与上界。
 *
 * 与 `pg-worker-tools.ts` 的取值**必须一致**：三路到底取多深决定了 RRF 融合的名次，
 * 两个入口若取值不同，同一个问题在控制台与 Worker 上会给出不同排序——那是产品不一致，
 * 不是实现细节。数字相同是刻意的（常量无法跨模块共享：`retrieval.ts` 不在本次改动范围内）。
 */
const ROUTE_CANDIDATE_FACTOR = 4;
const ROUTE_CANDIDATE_MIN = 32;
const ROUTE_CANDIDATE_MAX = 200;

/**
 * 三元组路（`word_similarity`）阈值。显式给出而不依赖 `pg_trgm.word_similarity_threshold`
 * GUC：GUC 是部署可变的，会让同一输入在不同部署上返回不同结果。同 `pg-worker-tools.ts`。
 */
const TRIGRAM_WORD_SIMILARITY_THRESHOLD = 0.3;

/** 单次读取的引用上限（§8.7：读取范围限定在单次数量上限内，工具面同样是 20）。 */
const MAX_READ_REFS = 20;

/** 引用不可用时的统一措辞：三种原因不区分，避免泄露存在性（§18.4）。 */
const UNAVAILABLE_REFS_MESSAGE =
  '引用不可用：不存在、不属于该 engagement、或已被范围排除（§8.6）。三者不区分，避免泄露存在性';

/** 审计事件来源系统标识（幂等键的组成部分之一）。 */
const AUDIT_SOURCE_SYSTEM = 'pentest-console';

const UUID_PATTERN = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

// ───────────────────────────── 拒绝路径 ─────────────────────────────

/**
 * 控制台记忆面的拒绝：携带契约里的稳定错误码（`ErrorCode`），调用方据码分支，
 * 不解析 `message` 文本（§16.5）。与 `WorkflowRejection` / `PgWorkerToolRefusal` 同族。
 */
export class MemoryQueryRejection extends Error {
  override readonly name = 'MemoryQueryRejection';
  readonly code: ErrorCode;

  constructor(code: ErrorCode, message: string) {
    super(`${code}: ${message}`);
    this.code = code;
  }
}

// ───────────────────────────── 构造依赖 ─────────────────────────────

export interface PgMemoryQueryOptions {
  /**
   * 审计账本。**省略即不写访问审计**——这是明确的降级，不是等价形态：
   * §8.3 要求「每次读取记入访问审计」，缺了它 `readMemory` 就只剩读取、没有留痕。
   * 生产装配必须注入；只在只读探查（如控制台的纯浏览模式）等场景才允许省略。
   *
   * 注入的动作面只要求 `appendEvent`（本模块只需要追加单条事件）。
   */
  readonly ledger?: Pick<MemoryLedgerService, 'appendEvent'>;
  /**
   * 查询向量化。未注入时检索跳过向量路（**不伪造向量**），全文与三元组两路照常——
   * 与 `PgWorkerToolsOptions.embedQuery` 同约定。维度必须与 `memory_chunks.embedding`
   * 一致（1024，§9.2），否则数据库拒绝比较。
   */
  readonly embedQuery?: (text: string) => Promise<readonly number[]>;
  /**
   * 账本校验端口（§8.4 链校验 + 锚点核对）。省略即 `verifyLedger` 以明确错误拒绝——
   * 不返回「通过」：没有能力校验时把结论说成「没问题」比拒绝更危险。
   * `MemoryLedger` 结构性满足本端口（装配处直接传它）。
   */
  readonly ledgerVerifier?: LedgerVerifierPort;
}

/**
 * 账本校验端口：只要求两个只读方法，且只取校验结论中界面真正需要的字段。
 *
 * 刻意不 `Pick<MemoryLedger, …>`：`MemoryLedger.verifyChain` 的返回类型含内部结构
 * （`ChainFailure.kind` 等），端口越窄，替换实现（如未来的远端审计器）越容易。
 */
export interface LedgerVerifierPort {
  verifyChain(engagementId: string): Promise<{
    readonly ok: boolean;
    readonly eventCount: number;
    readonly chainHead: string;
    readonly failures: readonly { readonly chainSeq: number; readonly detail: string }[];
  }>;
  verifyAnchor(engagementId: string): Promise<{
    readonly ok: boolean;
    readonly anchored: unknown;
    readonly mismatches: readonly string[];
  }>;
}

// ───────────────────────────── 行形状 ─────────────────────────────


/** 检索候选行：三路排名 + 还原分块种类与事件时间所需的分块元数据。 */
interface CandidateRow {
  readonly id: string;
  readonly content: string;
  readonly memory_item_id: string | null;
  readonly source_event_id: string | null;
  readonly worker_session_id: string | null;
  readonly phase: string | null;
  readonly trust_level: string;
  readonly classification: string;
  readonly provisional: boolean;
  readonly asset_ids: readonly string[] | null;
  readonly finding_ids: readonly string[] | null;
  readonly indexable: boolean;
  readonly occurred_at: Date | string;
  readonly event_type: string | null;
  readonly item_kind: string | null;
  readonly item_source_event_ids: readonly string[] | null;
  readonly report_payload: unknown;
  readonly human_accepted: boolean;
  readonly semantic_rank: number | string | null;
  readonly lexical_rank: number | string | null;
  readonly trigram_rank: number | string | null;
}

/** 按标识读取时的分块行。 */
interface ChunkReadRow {
  readonly id: string;
  readonly content: string;
  readonly content_hash: string;
  readonly worker_session_id: string | null;
  readonly source_event_id: string | null;
  readonly trust_level: string;
  readonly classification: string;
  readonly asset_ids: readonly string[] | null;
  readonly occurred_at: Date | string;
  readonly event_type: string | null;
  readonly item_kind: string | null;
  readonly item_source_event_ids: readonly string[] | null;
  readonly report_payload: unknown;
}

/** 按标识读取时的事件行。 */
interface EventReadRow {
  readonly event_id: string;
  readonly worker_session_id: string | null;
  readonly trust_level: string;
  readonly classification: string;
  readonly occurred_at: Date | string;
  readonly event_type: string;
  readonly payload_json: unknown;
}

/** 事件的可见分块（按序拼接即事件正文，§8.2：可检索文本只存在于 `memory_chunks.content`）。 */
interface EventChunkRow {
  readonly source_event_id: string;
  readonly ordinal: number;
  readonly content: string;
  readonly content_hash: string;
  readonly asset_ids: readonly string[] | null;
}

/** `index_watermarks` 行（只列本模块读到的列）。 */
interface WatermarkRow {
  /** pg 的 `bigint` 以字符串返回，超出 JS 安全整数范围时不能丢精度。 */
  readonly last_chain_seq: number | string;
  readonly indexed_through_occurred_at: Date | string | null;
  readonly status: string;
  readonly last_error: string | null;
}

// ───────────────────────────── 分块种类还原 ─────────────────────────────

// 分块种类的还原规则**只有一份**：`chunks.ts` 的 `deriveChunkKind`（已导入）。
// 从前这里与 `pg-worker-tools.ts` 各有一份私有副本（含各自的逆索引与匹配兜底），两侧漂移的表现是
// 「同一个 kinds 过滤在控制台与 Worker 上给出不同结果」。

// ───────────────────────────── 窄化辅助 ─────────────────────────────

function toIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function asIdArray(value: readonly string[] | null | undefined): readonly string[] {
  return value ?? [];
}

/** 路由名次：`pg` 把 `row_number()` 的 bigint 解析为字符串，融合层要的是数字。 */
function toRank(value: number | string | null): number | null {
  return value === null ? null : Number(value);
}

/** pg 的 `bigint` / `numeric` 可能以字符串返回；转数字并校验可表示范围。 */
function toSafeCount(value: number | string | null | undefined, what: string): number {
  if (value === null || value === undefined) return 0;
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new Error(`${what} 不是安全整数：${String(value)}`);
  }
  return parsed;
}

/**
 * 枚举列的运行时窄化。库里的 `trust_level` / `classification` / `decision` 都是 text 列，
 * 取值域由写入侧（`ledger.ts` / `indexer.ts`）保证；这里**响亮拒绝**非法值，
 * 绝不落到「最宽松的那个」（那会让一条脏数据被当成可信标注展示）。
 */
function narrow<T extends string>(
  value: string,
  allowed: readonly T[],
  what: string,
): T {
  if (!(allowed as readonly string[]).includes(value)) {
    throw new Error(`${what} 取值非法：${value}`);
  }
  return value as T;
}

/** 阶段列没有 CHECK 约束，非法值一律响亮拒绝（与 `indexer.ts` 的 toPhase 同约定）。 */
function narrowPhase(value: string, what: string): Phase {
  if (!isPhase(value)) throw new Error(`${what} 取值非法：${value}`);
  return value;
}

/** 引用：`memory:<chunkId>`（检索结果给出的形态）或 `event:<eventId>`。 */
interface ParsedRef {
  readonly raw: string;
  readonly kind: 'memory' | 'event';
  readonly id: string;
}

function parseRef(raw: string): ParsedRef {
  const separator = raw.indexOf(':');
  const prefix = separator < 0 ? '' : raw.slice(0, separator);
  const id = separator < 0 ? '' : raw.slice(separator + 1);
  if ((prefix !== 'memory' && prefix !== 'event') || !UUID_PATTERN.test(id)) {
    throw new MemoryQueryRejection(
      'classification_rejected',
      `引用 ${raw} 无法归类：只接受 memory:<uuid> 或 event:<uuid>；不要自行构造引用`,
    );
  }
  return { raw, kind: prefix, id };
}

/** 引用（`memory:` / `event:`）→ 供 `sourceRefs` 使用的引用标识。 */
function eventRef(eventId: string): string {
  return `event:${eventId}`;
}

// ───────────────────────────── 实现 ─────────────────────────────

/**
 * 控制台记忆检索面的 PostgreSQL 实现。
 *
 * 构造：`new PgMemoryQueryService(db, { ledger?, embedQuery? })`；
 * `db` 用 `src/memory/ledger.ts` 的 `DbClient`（`{ query(sql, params) }`），不持有连接池。
 */
export class PgMemoryQueryService implements PentestMemoryQueryService {
  readonly #db: DbClient;
  readonly #ledger: Pick<MemoryLedgerService, 'appendEvent'> | null;
  readonly #ledgerVerifier: LedgerVerifierPort | null;
  readonly #embedQuery: ((text: string) => Promise<readonly number[]>) | undefined;

  constructor(db: DbClient, options: PgMemoryQueryOptions = {}) {
    this.#db = db;
    this.#ledger = options.ledger ?? null;
    this.#ledgerVerifier = options.ledgerVerifier ?? null;
    this.#embedQuery = options.embedQuery;
  }

  // ── 1. 混合检索（§8.6 / §8.7） ──

  async searchMemory(input: MemorySearchRequest): Promise<MemorySearchResultSet> {
    const query = this.#memoryQuery(input);
    const scope = await this.#scopeSets(input.engagementId);
    const candidates = await this.#candidates(input.engagementId, scope, query);
    const fused = searchMemory({
      boundEngagementId: input.engagementId,
      query,
      scope,
      candidates,
      now: new Date(),
    });

    const hits: MemorySearchHit[] = fused.hits.map((hit) => ({
      memoryId: hit.chunkId,
      excerpt: hit.excerpt,
      score: hit.score,
      kind: hit.kind,
      trustLevel: hit.trustLevel,
      phase: hit.phase,
      workerSessionId: hit.workerSessionId,
      occurredAt: hit.occurredAt,
      // `citation` 是**给模型与人类看的引用标识**（§8.6 / §8.7）：形状 `memory:<分块标识>`，
      // 与 `readMemory` 接受的引用语法同源，因此「检索 → 点开原文」是一条可闭环的路径。
      citation: hit.citation,
      // 思考链的标注走独立字段（§8.3「不把推理等同于事实」），不污染 excerpt。
      ...(hit.reasoningLabel === null ? {} : { reasoningNote: hit.reasoningLabel }),
    }));

    // 检索同样是一次访问：§9.5 要求控制台的检索、读取、思考链展开与导出
    // 都由传输层注入的 `operator_id` 归因，不得使用固定值。
    // **结果返回之前**落审计：返回了内容却没有留痕，等于把访问审计变成可选项
    // （与 `readMemory` 同一约定）。
    await this.#auditAccess(input.engagementId, 'memory_search', input.operatorId, input.reason ?? '', {
      query: input.query,
      limit: query.limit,
      hitCount: hits.length,
    });

    // 水位与结果同时返回（§8.4「检索结果返回索引水位与时间范围」）：调用方据此知道
    // 本次结果可能遗漏尚未索引的事件，而不是把「没检索到」当成「不存在」。
    const watermark = await this.memoryWatermark(input.engagementId);
    return { hits, watermark };
  }

  /** 契约入参 → 检索层入参（§8.7 的字段名）。越界取值一律拒绝，不做静默忽略（§10.2.1）。 */
  #memoryQuery(input: MemorySearchRequest): MemoryQuery {
    const kinds = input.kinds ?? [];
    for (const kind of kinds) {
      if (!isChunkKind(kind)) {
        throw new MemoryQueryRejection(
          'classification_rejected',
          `kinds 含无法归类的记忆类型 ${kind}；改用 ${CHUNK_KINDS.join(' / ')} 之一`,
        );
      }
    }
    const trustLevels = input.trustLevels ?? [];
    for (const level of trustLevels) {
      if (!(TRUST_LEVELS as readonly string[]).includes(level)) {
        throw new MemoryQueryRejection(
          'classification_rejected',
          `trustLevels 含无法归类的来源可信度 ${level}；改用 ${TRUST_LEVELS.join(' / ')} 之一`,
        );
      }
    }
    // `phase` 在类型上已是 `Phase | null`，但控制台是运行时入口：仍然校验。
    if (input.phase !== undefined && input.phase !== null && !isPhase(input.phase)) {
      throw new MemoryQueryRejection(
        'classification_rejected',
        `phase 无法归类：${String(input.phase)}`,
      );
    }

    const limit = Math.min(
      Math.max(Math.trunc(input.limit ?? DEFAULT_RETRIEVAL_LIMIT), 1),
      MAX_RETRIEVAL_LIMIT,
    );
    return {
      query: input.query,
      limit,
      ...(input.phase === undefined || input.phase === null ? {} : { phase: input.phase }),
      ...(kinds.length === 0 ? {} : { kinds: kinds as readonly ChunkKind[] }),
      ...(trustLevels.length === 0 ? {} : { trustLevels: trustLevels as readonly TrustLevel[] }),
      ...(input.assetIds === undefined || input.assetIds.length === 0
        ? {}
        : { assetIds: input.assetIds }),
      ...(input.includeReasoning === undefined
        ? {}
        : { includeReasoning: input.includeReasoning }),
    };
  }

  /**
   * 当前范围版本解析出的 I(v) 与 X(v)（§8.6）。
   *
   * 版本取 `max(version)`：与 §5.4 的范围修订一致——控制台看到的是**现在生效**的边界，
   * 不是某个历史会话冻结的边界（Worker 工具走的是冻结版本，见 `session-context.ts` 的口径表）。
   * 尚无范围版本（v=0）时返回空集，于是「有资产归属的分块一律不可见、无归属的分块可见」
   * ——fail-closed，与 §8.6 同向。
   *
   * 取数与判定走共享原语（C3）：两侧各写一份解析逻辑时，第 3 次改动只会改到一边。
   */
  async #scopeSets(engagementId: string): Promise<ScopeSets> {
    const version = await currentScopeVersion(this.#db, engagementId);
    return scopeSetsForVersion(this.#db, engagementId, version);
  }

  /**
   * 三路候选取回（§8.6：检索在 PostgreSQL 内完成）。
   *
   * 范围过滤全部下推：`buildRetrievalSql` 用当前范围版本解析出的 I(v)/X(v) 生成
   * 「排除优先 + 空归属放行」的子句；融合层再用同一组集合复核一次——同一份纯逻辑用两处，
   * 下推负责效率、复核负责不变量。
   *
   * 显式选择（与 `PgWorkerTools.#candidates` 一致）：
   * - JOIN 别名用自己的 `mit` / `ev`：`buildRetrievalSql` 可能按需占用 `mi` / `e`，
   *   用同名别名会直接得到 `table name "e" specified more than once`。
   * - 契约的检索入参没有 `from` / `to`（控制台按阶段与类型筛选，不按时间区间），
   *   因此不存在「分块写入时间」与「事件发生时间」两套时间混用的问题。
   * - `report_payload` 只对报告类事件取回：工具结果的 payload 可能是大块输出，
   *   为还原种类把它们整批读进内存不值得。
   */
  async #candidates(
    engagementId: string,
    scope: ScopeSets,
    query: MemoryQuery,
  ): Promise<readonly RetrievalCandidate[]> {
    const sql = buildRetrievalSql({
      engagementId,
      query,
      includedAssetIds: [...scope.included],
      excludedAssetIds: [...scope.excluded],
      scopeResolution: 'precomputed',
    });

    const params = [...sql.params];
    const bind = (value: unknown): string => {
      params.push(value);
      return `$${params.length}`;
    };
    const limit = query.limit ?? DEFAULT_RETRIEVAL_LIMIT;
    const routeLimit = Math.min(
      Math.max(limit * ROUTE_CANDIDATE_FACTOR, ROUTE_CANDIDATE_MIN),
      ROUTE_CANDIDATE_MAX,
    );
    const qParam = bind(query.query);
    const thresholdParam = bind(TRIGRAM_WORD_SIMILARITY_THRESHOLD);
    const routeLimitParam = bind(routeLimit);
    const reportTypesParam = bind([...REPORT_EVENT_TYPES]);

    // 查询向量化失败**不吞**：伪造向量或悄悄降级都会让「语义检索坏了」看起来像
    // 「语义检索没结果」（§15.1 的失败可见原则）。语义路缺席时另两路照常。
    const embedded = this.#embedQuery === undefined ? undefined : await this.#embedQuery(query.query);
    const vectorParam =
      embedded === undefined ? undefined : bind(`[${embedded.map((v) => Number(v)).join(',')}]`);

    const semanticCte =
      vectorParam === undefined
        ? ''
        : `,
semantic AS (
  SELECT s.id, row_number() OVER (ORDER BY s.embedding <=> ${vectorParam}::vector, s.id) AS rank
    FROM scoped s
   WHERE s.embedding IS NOT NULL
   ORDER BY s.embedding <=> ${vectorParam}::vector, s.id
   LIMIT ${routeLimitParam}
)`;

    const text = `
WITH scoped AS (
  SELECT mc.id, mc.content, mc.memory_item_id, mc.source_event_id, mc.worker_session_id,
         mc.phase, mc.trust_level::text AS trust_level,
         mc.classification::text AS classification, mc.provisional,
         mc.asset_ids::text[] AS asset_ids, mc.finding_ids::text[] AS finding_ids,
         mc.search_vector, mc.embedding,
         (mc.search_vector IS NOT NULL) AS indexable,
         COALESCE(ev.occurred_at, mit.created_at, mc.created_at) AS occurred_at,
         ev.event_type::text AS event_type,
         mit.kind::text AS item_kind,
         mit.source_event_ids::text[] AS item_source_event_ids,
         CASE WHEN ev.event_type = ANY(${reportTypesParam}::text[]) THEN ev.payload_json END AS report_payload,
         EXISTS (
           SELECT 1 FROM pentest.findings f
            WHERE f.id = ANY(mc.finding_ids) AND f.status = 'human_accepted'
         ) AS human_accepted
    FROM pentest.memory_chunks mc
${sql.joins.join('\n')}
    LEFT JOIN pentest.context_events ev ON ev.event_id = mc.source_event_id
    LEFT JOIN pentest.memory_items mit ON mit.id = mc.memory_item_id
   WHERE ${sql.where}
),
params AS (SELECT ${qParam}::text AS qtext, plainto_tsquery('simple', ${qParam}::text) AS tsq),
lexical AS (
  SELECT s.id, row_number() OVER (ORDER BY ts_rank_cd(s.search_vector, p.tsq) DESC, s.id) AS rank
    FROM scoped s, params p
   WHERE s.search_vector @@ p.tsq
   ORDER BY ts_rank_cd(s.search_vector, p.tsq) DESC, s.id
   LIMIT ${routeLimitParam}
),
trigram AS (
  SELECT s.id, row_number() OVER (ORDER BY word_similarity(p.qtext, s.content) DESC, s.id) AS rank
    FROM scoped s, params p
   WHERE word_similarity(p.qtext, s.content) >= ${thresholdParam}::real
   ORDER BY word_similarity(p.qtext, s.content) DESC, s.id
   LIMIT ${routeLimitParam}
)${semanticCte},
hits AS (
  SELECT id FROM lexical UNION SELECT id FROM trigram${vectorParam === undefined ? '' : ' UNION SELECT id FROM semantic'}
)
SELECT s.id, s.content, s.memory_item_id, s.source_event_id, s.worker_session_id, s.phase,
       s.trust_level, s.classification, s.provisional, s.asset_ids, s.finding_ids,
       s.indexable, s.occurred_at, s.event_type, s.item_kind, s.item_source_event_ids,
       s.report_payload, s.human_accepted,
       l.rank AS lexical_rank, t.rank AS trigram_rank,
       ${vectorParam === undefined ? 'NULL::bigint' : 'se.rank'} AS semantic_rank
  FROM hits h
  JOIN scoped s ON s.id = h.id
  LEFT JOIN lexical l ON l.id = h.id
  LEFT JOIN trigram t ON t.id = h.id${vectorParam === undefined ? '' : '\n  LEFT JOIN semantic se ON se.id = h.id'}
 ORDER BY s.id`;

    const result = await this.#db.query<CandidateRow>(text, params);
    return result.rows.map((row) => this.#candidate(row, engagementId));
  }

  #candidate(row: CandidateRow, engagementId: string): RetrievalCandidate {
    return {
      chunkId: row.id,
      engagementId,
      kind: deriveChunkKind(row),
      trustLevel: narrow<TrustLevel>(row.trust_level, TRUST_LEVELS, 'memory_chunks.trust_level'),
      classification: narrow<Classification>(
        row.classification,
        CLASSIFICATIONS,
        'memory_chunks.classification',
      ),
      assetIds: asIdArray(row.asset_ids),
      findingIds: asIdArray(row.finding_ids),
      workerSessionId: row.worker_session_id,
      sourceEventId: row.source_event_id ?? asIdArray(row.item_source_event_ids)[0] ?? null,
      phase: row.phase === null ? null : narrowPhase(row.phase, 'memory_chunks.phase'),
      occurredAt: toIso(row.occurred_at),
      provisional: row.provisional,
      humanAccepted: row.human_accepted,
      // §8.5「流量与二进制」只存元数据、不建全文索引：写入侧只对可索引分块写全文向量（§8.4），
      // 因此 search_vector 为空即不可检索。索引滞后（§15.5）的分块同样落在这一侧，
      // 与「检索结果可能遗漏尚未索引的事件」一致。
      indexable: row.indexable,
      excerpt: row.content,
      semanticRank: toRank(row.semantic_rank),
      lexicalRank: toRank(row.lexical_rank),
      trigramRank: toRank(row.trigram_rank),
    };
  }

  // ── 2. 按标识读取（§8.7） ──

  async readMemory(input: MemoryReadRequest): Promise<readonly MemoryRecord[]> {
    const refs = input.refs.map(parseRef);
    if (refs.length === 0) {
      // 空集不是错误，也没有读任何东西——因此**不写访问审计**（写了就是凭空造痕迹）。
      return [];
    }
    if (refs.length > MAX_READ_REFS) {
      // 显式拒绝而不是静默截断：截断会返回少于请求的记录，而审计记的是「实际读到的」，
      // 调用方无法察觉自己的后半段引用从未被处理。
      throw new MemoryQueryRejection(
        'classification_rejected',
        `单次最多读取 ${MAX_READ_REFS} 条引用，收到 ${refs.length} 条`,
      );
    }

    const scope = await this.#scopeSets(input.engagementId);
    const memoryIds = refs.filter((ref) => ref.kind === 'memory').map((ref) => ref.id);
    const eventIds = refs.filter((ref) => ref.kind === 'event').map((ref) => ref.id);

    const chunks = await this.#readChunks(input.engagementId, memoryIds);
    const events = await this.#readEvents(input.engagementId, eventIds);
    const eventChunks = await this.#readEventChunks(input.engagementId, eventIds);

    const records: MemoryRecord[] = [];
    const unavailable: string[] = [];
    for (const ref of refs) {
      const record =
        ref.kind === 'memory'
          ? this.#chunkRecord(chunks.get(ref.id), scope)
          : this.#eventRecord(events.get(ref.id), eventChunks.get(ref.id) ?? [], scope);
      if (record === undefined) unavailable.push(ref.raw);
      else records.push(record);
    }

    if (unavailable.length > 0) {
      // 三种原因不区分（不存在 / 别的 engagement / 被范围排除），避免泄露存在性（§18.4）；
      // 但**本次全部引用一起拒绝**：部分返回会让调用方以为未列出的引用已被读过。
      throw new MemoryQueryRejection(
        'scope_violation',
        `${UNAVAILABLE_REFS_MESSAGE}：${unavailable.join(', ')}`,
      );
    }

    await this.#auditAccess(input.engagementId, 'memory_read', input.operatorId, input.reason, {
      refs: refs.map((ref) => ref.raw),
      memoryIds: refs.filter((ref) => ref.kind === 'memory').map((ref) => ref.id),
      eventIds: refs.filter((ref) => ref.kind === 'event').map((ref) => ref.id),
    });
    return records;
  }

  #chunkRecord(row: ChunkReadRow | undefined, scope: ScopeSets): MemoryRecord | undefined {
    if (row === undefined) return undefined;
    // 范围过滤与检索共用同一条谓词（§8.6）：被排除资产的分块即便凭标识直读也不可见。
    if (!isChunkVisibleInScope(scopeFilterInput(asIdArray(row.asset_ids), scope))) return undefined;
    const sourceEventId = row.source_event_id ?? asIdArray(row.item_source_event_ids)[0];
    return {
      memoryId: row.id,
      content: row.content,
      kind: deriveChunkKind(row),
      trustLevel: narrow<TrustLevel>(row.trust_level, TRUST_LEVELS, 'memory_chunks.trust_level'),
      classification: narrow<Classification>(
        row.classification,
        CLASSIFICATIONS,
        'memory_chunks.classification',
      ),
      occurredAt: toIso(row.occurred_at),
      contentHash: row.content_hash,
      sourceRefs: sourceEventId === undefined ? [] : [eventRef(sourceEventId)],
    };
  }

  #eventRecord(
    row: EventReadRow | undefined,
    chunks: readonly EventChunkRow[],
    scope: ScopeSets,
  ): MemoryRecord | undefined {
    if (row === undefined) return undefined;
    // 事件正文就是它的分块投影（§8.2：可检索文本只存在于 `memory_chunks.content`），
    // 因此按序号拼接**可见**分块；范围排除的分块在这里同样不参与拼接（排除是硬边界）。
    const visible = chunks.filter((chunk) =>
      isChunkVisibleInScope(scopeFilterInput(asIdArray(chunk.asset_ids), scope)),
    );
    // 没有任何可见分块 = 这条引用不可用，返回 `undefined` 让 `readMemory` 走统一的
    // 「引用不可用」拒绝路径。
    //
    // **这里曾回退为 `JSON.stringify(row.payload_json)`**，理由是「索引滞后的事件还没有分块，
    // 不放行就什么都读不到」。那条回退是个真实的越权通道：一个**全部**分块都被范围排除的事件
    // （被排除资产的工具输出）走的是同一条 `visible.length === 0` 分支，于是把整个原始
    // `payload_json` 原样返回给调用方——脱敏只在分块上做了，payload 是未脱敏的原文。
    // 「索引滞后」与「被范围排除」在返回值上无法区分，而两者都不该给出正文：
    // Worker 面对同一情形（`pg-worker-tools.ts` 的 read）明确拒绝，控制台面必须同口径。
    if (visible.length === 0) return undefined;
    const content = visible.map((chunk) => chunk.content).join('\n');
    const single = visible.length === 1 ? visible[0] : undefined;
    return {
      memoryId: row.event_id,
      content,
      kind: deriveChunkKind({
        item_kind: null,
        event_type: row.event_type,
        content,
        report_payload: row.payload_json,
      }),
      trustLevel: narrow<TrustLevel>(row.trust_level, TRUST_LEVELS, 'context_events.trust_level'),
      classification: narrow<Classification>(
        row.classification,
        CLASSIFICATIONS,
        'context_events.classification',
      ),
      occurredAt: toIso(row.occurred_at),
      // 单块沿用存储的内容哈希；多块拼接与原始载荷回退时按返回内容重新计算。
      contentHash: single === undefined ? sha256Hex(content) : single.content_hash,
      sourceRefs: [eventRef(row.event_id)],
    };
  }

  async #readChunks(
    engagementId: string,
    ids: readonly string[],
  ): Promise<Map<string, ChunkReadRow>> {
    const map = new Map<string, ChunkReadRow>();
    if (ids.length === 0) return map;
    const result = await this.#db.query<ChunkReadRow>(
      `SELECT mc.id, mc.content, mc.content_hash, mc.worker_session_id, mc.source_event_id,
              mc.trust_level::text AS trust_level, mc.classification::text AS classification,
              mc.asset_ids::text[] AS asset_ids,
              COALESCE(ev.occurred_at, mit.created_at, mc.created_at) AS occurred_at,
              ev.event_type::text AS event_type,
              mit.kind::text AS item_kind,
              mit.source_event_ids::text[] AS item_source_event_ids,
              ev.payload_json AS report_payload
         FROM pentest.memory_chunks mc
         LEFT JOIN pentest.context_events ev ON ev.event_id = mc.source_event_id
         LEFT JOIN pentest.memory_items mit ON mit.id = mc.memory_item_id
        WHERE mc.id = ANY($1::uuid[]) AND mc.engagement_id = $2::uuid`,
      [ids, engagementId],
    );
    for (const row of result.rows) map.set(row.id, row);
    return map;
  }

  async #readEvents(
    engagementId: string,
    ids: readonly string[],
  ): Promise<Map<string, EventReadRow>> {
    const map = new Map<string, EventReadRow>();
    if (ids.length === 0) return map;
    const result = await this.#db.query<EventReadRow>(
      `SELECT e.event_id, e.worker_session_id, e.trust_level::text AS trust_level,
              e.classification::text AS classification, e.occurred_at,
              e.event_type::text AS event_type, e.payload_json
         FROM pentest.context_events e
        WHERE e.event_id = ANY($1::uuid[]) AND e.engagement_id = $2::uuid`,
      [ids, engagementId],
    );
    for (const row of result.rows) map.set(row.event_id, row);
    return map;
  }

  async #readEventChunks(
    engagementId: string,
    ids: readonly string[],
  ): Promise<Map<string, readonly EventChunkRow[]>> {
    const map = new Map<string, EventChunkRow[]>();
    if (ids.length === 0) return map;
    const result = await this.#db.query<EventChunkRow>(
      `SELECT mc.source_event_id, mc.ordinal, mc.content, mc.content_hash,
              mc.asset_ids::text[] AS asset_ids
         FROM pentest.memory_chunks mc
        WHERE mc.source_event_id = ANY($1::uuid[]) AND mc.engagement_id = $2::uuid
        ORDER BY mc.source_event_id, mc.ordinal`,
      [ids, engagementId],
    );
    for (const row of result.rows) {
      const list = map.get(row.source_event_id);
      if (list === undefined) map.set(row.source_event_id, [row]);
      else list.push(row);
    }
    return map;
  }

  /**
   * 访问审计（§8.3「每次读取记入访问审计」）：`memory.access` 领域事件落账本。
   *
   * 为什么是账本而不是 `memory_access_log` 表：账本事件带链式哈希与签名（§9.5），
   * 是不可事后改写的事后证据；`memory.access` 本就是为此存在的领域事件类型。
   * 检索与按标识读取共用它——两者都是「有人看了这些内容」，只是粒度不同，
   * 因此 `accessKind` 区分（`memory_search` / `memory_read`），归因字段一致。
   *
   * `operatorId` 由**传输层**注入（`CallContext.operatorId` 经 RPC 的 `operator: true`
   * 写入请求输入），绝不能是请求体里的普通参数，也不是固定的 `console`
   * （§9.5：不得使用固定值）。缺失时写 `null` 而不是编一个身份。
   *
   * `sourceId` 用一次性随机标识：每次访问都是**独立的一次访问**，不能复用幂等键——
   * 复用会让第二次访问被账本当成重放而静默不留痕。
   *
   * 审计写不进去就**不返回内容**（异常向上抛）：返回了原文却没有留痕，
   * 等于把 §8.3 的访问审计变成可选项（与 `PgWorkerTools` 的读取同约定）。
   * `ledger` 未注入时整个方法不存在（见 {@link PgMemoryQueryOptions.ledger} 的降级说明）。
   */
  async #auditAccess(
    engagementId: string,
    accessKind: 'memory_search' | 'memory_read',
    operatorId: string | undefined,
    reason: string,
    detail: Readonly<Record<string, unknown>>,
  ): Promise<void> {
    const ledger = this.#ledger;
    if (ledger === null) return;
    const payload = {
      engagementId,
      accessKind,
      // 调用方给出的理由原样落审计：这是人类解释「为什么看了这些」的唯一入口。
      reason,
      operatorId: operatorId ?? null,
      ...detail,
    };
    await ledger.appendEvent({
      engagementId,
      // 控制台不是 Worker 会话：§9.2 的访问主体在控制台侧是操作者，不是会话。
      workerSessionId: null,
      eventType: 'memory.access',
      sourceSystem: AUDIT_SOURCE_SYSTEM,
      sourceId: `memory.access:${randomUUID()}`,
      sourceSeq: 1,
      occurredAt: new Date(),
      payload,
      rawPayload: new TextEncoder().encode(JSON.stringify(payload)),
      classification: 'engagement',
      // 访问由控制台操作者发起：这条记录描述的是人的动作，不是模型推理也不来自工具。
      trustLevel: 'human_decision',
    });
  }

  // ── 3. 索引水位（§8.4 / §15.5） ──

  /**
   * 索引水位与滞后量（§8.4 / §15.5）。
   *
   * `lastChainSeq` = **已落成分块的事件里最大的链序号**（`context_events ⋈ memory_chunks`），
   * 与 worker 工具的 `memory_search` 用同一口径——「检索面覆盖到哪里」只由分块决定。
   *
   * ── 为什么不是 `index_watermarks.last_chain_seq` ──
   *
   * 那张表是**重建进度**：只有 `reindex_engagement` 的推进路径会写它，事件驱动的索引
   * （`index_event` 任务）不写——见 `dispatcher.ts` 顶部对「水位只在重建期有意义」的说明。
   * 拿它当显示值，实测结果是「索引队列 完成 20 / 索引水位 链序 0」并列出现，
   * 人类读到的是「索引没动」，而搜索其实是好的（QA 2026-10-04）。
   *
   * `status` / `detail` 仍取水位行（缺行按 `ready`）：那是索引器的**健康**字段，不是进度。
   * `occurredAt` 取已索引事件里最晚的发生时间：与 `lastChainSeq` 同源，才不会有
   * 「水位 0 但时间戳非空」这类自相矛盾的组合。
   *
   * `lagEvents` = **水位之后、能落块却还没落块**的事件条数。判据是**规划器**
   * （{@link planChunks}，与索引器同一份），不是「事件类型在不在可分块集合里」：
   * 后者是近似，而且会长期说谎——`handoff.draft.generated` / `handoff.confirmed` 的类型
   * 属于「交接」这个记忆种类，但它们的载荷里没有正文（`{handoffId}` / `{handoffId,toPhase}`），
   * 永远算不出分块。按类型判定时这两类事件每次阶段交接都留在尾部，
   * 于是控制台永久显示 attention 报警「滞后 N 条」（评审抓到的真实形状）。
   */
  async memoryWatermark(engagementId: string): Promise<MemoryWatermark> {
    const indexed = await this.#db.query<{ last_chain_seq: number | string | null; occurred_at: Date | string | null }>(
      `select max(e.chain_seq) as last_chain_seq, max(e.occurred_at) as occurred_at
         from pentest.context_events e
         join pentest.memory_chunks mc on mc.source_event_id = e.event_id
        where e.engagement_id = $1::uuid`,
      [engagementId],
    );
    const health = await this.#db.query<Pick<WatermarkRow, 'status' | 'last_error'>>(
      `select status, last_error from pentest.index_watermarks where engagement_id = $1::uuid`,
      [engagementId],
    );
    const last = toSafeCount(indexed.rows[0]?.last_chain_seq, 'last_chain_seq');
    const occurredAt = indexed.rows[0]?.occurred_at ?? null;
    const row = health.rows[0];
    const lag = await this.#lagAfter(engagementId, last);
    return {
      lastChainSeq: last,
      occurredAt: occurredAt === null ? null : toIso(occurredAt),
      status: row === undefined ? 'ready' : narrowWatermarkStatus(row.status),
      detail: row?.last_error ?? null,
      lagEvents: lag,
    };
  }

  /**
   * 水位之后**真正待索引**的事件条数（`planChunks` 判定）。
   *
   * 尾部通常只有个位数事件（水位是「已落块的最大链序号」），因此这条扫描很便宜；
   * 事件再多也只扫尾部——这正是水位存在的意义。
   */
  async #lagAfter(engagementId: string, lastChainSeq: number): Promise<number> {
    const tail = await this.#db.query<{
      event_id: string;
      event_type: string;
      payload_json: unknown;
      text_projection: string | null;
      trust_level: string;
      classification: string;
      occurred_at: Date | string;
      worker_session_id: string | null;
    }>(
      `select event_id, event_type, payload_json, text_projection, trust_level, classification,
              occurred_at, worker_session_id
         from pentest.context_events
        where engagement_id = $1::uuid and chain_seq > $2 and event_type = any($3::text[])
        order by chain_seq`,
      [engagementId, lastChainSeq, [...CHUNKABLE_EVENT_TYPES]],
    );
    let lag = 0;
    for (const event of tail.rows) {
      const drafts = planChunks({
        eventId: event.event_id,
        engagementId,
        eventType: event.event_type as ChunkSourceEvent['eventType'],
        workerSessionId: event.worker_session_id,
        phase: null,
        trustLevel: event.trust_level as ChunkSourceEvent['trustLevel'],
        classification: event.classification as ChunkSourceEvent['classification'],
        occurredAt: event.occurred_at,
        payload: event.payload_json,
        textProjection: event.text_projection,
      });
      if (drafts.length > 0) lag += 1;
    }
    return lag;
  }

  // ── 3. 账本完整性校验（§8.4 · 只读） ──

  /**
   * 人工触发的账本校验：链自洽 + 锚点一致。**只读**，不写访问审计——它不改动任何事实，
   * 也不读取记忆正文。
   *
   * 两项判定分开取再合成：`ok` 只有在「链自洽 **且** 有锚点且与锚点一致」时为真。
   * 无锚点是**未证明**，不是「已证明完好」，因此不能当作通过（`verifyAnchor` 的语义）。
   */
  async verifyLedger(engagementId: string): Promise<LedgerVerificationView> {
    const verifier = this.#ledgerVerifier;
    if (verifier === null) {
      throw new MemoryQueryRejection(
        'audit_unavailable',
        '未装配账本校验端口（ledgerVerifier），无法校验完整性',
      );
    }
    const chain = await verifier.verifyChain(engagementId);
    const anchor = await verifier.verifyAnchor(engagementId);
    return {
      engagementId,
      ok: chain.ok && anchor.ok,
      eventCount: chain.eventCount,
      chainHead: chain.chainHead,
      failures: chain.failures.map((failure) => ({ chainSeq: failure.chainSeq, detail: failure.detail })),
      anchored: anchor.anchored !== null,
      mismatches: [...anchor.mismatches],
      checkedAt: new Date().toISOString(),
    };
  }
}


/** 水位状态取值域（`index_watermarks.status` 的 CHECK，§15.5）。 */
function narrowWatermarkStatus(value: string): MemoryWatermark['status'] {
  if (value === 'ready' || value === 'lagging' || value === 'failed') return value;
  throw new Error(`index_watermarks.status 取值非法：${value}`);
}
