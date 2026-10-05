/**
 * Worker 工具面的 PostgreSQL 装配层：记忆检索、按标识读取、证据读取、报告提交、状态便签
 * （设计文档 §8.6 混合检索 / §8.7 Agent 主动检索 / §7.1 报告 / §6.2.2 状态便签 / §10.3 放行 / §9 数据模型）。
 *
 * 边界：
 * - 只实现 `WorkerToolDeps` 里**不含 `execute`** 的六个方法。`execute` 由执行服务承担（§10.2
 *   「强制点位于服务内部，不在工具适配器」），组合层单独填；本类只把 `requestApproval` 委托给
 *   注入的执行服务。
 * - 检索的融合排序与范围过滤谓词**不在这里重写**：`searchMemory` / `resolveScopeSets` /
 *   `buildRetrievalSql` 是 `src/memory/retrieval.ts` 已实现的纯逻辑，本模块只负责
 *   「会话 → engagement / 范围版本」解析与真实 SQL 取数。
 * - engagement 一律从当前会话解析（§8.7），不接受调用方传入 engagement 标识。
 * - `writeStatusNote` 在同一个事务里写 `worker_sessions` 的便签列并追加 `worker.status_note`
 *   领域事件（§6.2.2 的「落点」要求两者都写）。它此前只写列、不写事件，仍在注释里把事件
 *   归给「账本层职责」——而契约注册了该事件类型、文档要求写、实现里没有调用点。
 * - 读取路径（search / read / artifact_read）与写入路径一样要过租约与存活状态准入，
 *   见 `#session`：租约是「这个会话现在还被允许代表本作业工作」的唯一凭证。
 *
 * 事务约定：报告取代（§7.1 + §9.2 的两个延迟自引用外键）必须「先让位、后插入」且同处一个事务，
 * 因此注入的事务客户端 `txDb` 必须是**同一条连接**（`pg` 部署时传 `pool.connect()` 的结果或
 * 一个单连接客户端）。默认回落到 `db`，与 `MemoryLedger`（`src/memory/ledger.ts` 的 `txDb`）同约定。
 */

import { randomUUID } from 'node:crypto';

import type {
  ActionIntent,
  AppendEventInput,
  Classification,
  ErrorCode,
  ExecutionService,
  Phase,
  ScopeProposal,
  ToolError,
  TrustLevel,
  WorkerReportInput,
} from '../contracts.ts';
import { DEFAULTS, LIVE_SESSION_STATUSES, isPhase, ACTION_CLASSES } from '../contracts.ts';
import type { SkillFreezeEntry } from '../contracts.ts';
import type {
  ArtifactRecord,
  MemoryRecord,
  MemorySearchResult as WorkerMemorySearchResult,
  WorkerToolDeps,
} from '../tools/worker.ts';
import {
  CHUNK_KINDS,
  REPORT_EVENT_TYPES,
  deriveChunkKind,
  isChunkKind,
  sha256Hex,
  type ChunkKind,
} from './chunks.ts';
import { TRUST_LEVELS } from './hash.ts';
import { transactionRunnerFor, type DbClient, type DbResult, type DbTransactionRunner, type TransactionalLedger, type RlsAwareDbClient } from './ledger.ts';
import {
  DEFAULT_RETRIEVAL_LIMIT,
  MAX_RETRIEVAL_LIMIT,
  REASONING_LABEL,
  buildRetrievalSql,
  isChunkVisibleInScope,
  resolveScopeSets,
  scopeFilterInput,
  searchMemory,
  type MemoryQuery,
  type RetrievalCandidate,
  type ScopeSets,
} from './retrieval.ts';
import { normalizeScopeEntry } from '../policy/scope.ts';

// ───────────────────────────── 检索参数常量 ─────────────────────────────

/**
 * 每路候选取回条数相对请求上限的倍数，以及取回条数的下界与上界。
 * 三路融合（RRF）需要足够深度：只取 `limit` 条会让「另一路的第一名」因为本路第 61 名以后
 * 而整体缺席。取 4 倍并至少 32 条，再按最终分截断回 `limit`。
 */
const ROUTE_CANDIDATE_FACTOR = 4;
const ROUTE_CANDIDATE_MIN = 32;
const ROUTE_CANDIDATE_MAX = 200;

/**
 * 三元组路（`word_similarity`）阈值。
 * 显式给出而不依赖 `pg_trgm.word_similarity_threshold` GUC：GUC 是部署可变的，会让同一输入
 * 在不同部署上返回不同结果。代价是这一路不走 `memory_chunks_content_trgm` 索引（§9.3）；
 * 数据量增长到需要该索引时，应把阈值写进部署约定并改用 `<%` 运算符。
 */
const TRIGRAM_WORD_SIMILARITY_THRESHOLD = 0.3;

/** 单次读取的引用上限（§8.7：读取范围限定在单次数量上限内，工具面同样是 20）。 */
const MAX_READ_REFS = 20;

/** 引用不可用时的统一措辞：三种原因不区分，避免泄露存在性（§18.4）。 */
const UNAVAILABLE_REFS_MESSAGE =
  '引用不可用：不存在、不属于本会话的 engagement、或已被范围排除（§8.6）。三者不区分，避免泄露存在性';

/** 002 的会话转移表里能走到 `waiting_human` 的存活状态；`starting` 与终态都不能。 */
const REPORT_SUBMIT_ALLOWED_FROM: readonly string[] = [
  'active',
  'waiting_human',
  'handoff_drafting',
  'transition_confirmation',
  'paused',
  'blocked',
];

// ───────────────────────────── 拒绝路径 ─────────────────────────────

/**
 * Worker 工具面的拒绝。
 *
 * `WorkerToolDeps` 的返回类型没有错误分支（见 `src/tools/worker.ts`），因此拒绝必须抛出；
 * `payload` 是 §16.5 的稳定错误载荷，调用方（组合层与后续工具适配器）可原样渲染给模型，
 * 不需要解析 `message` 文本。
 */
export class PgWorkerToolRefusal extends Error {
  override readonly name = 'PgWorkerToolRefusal';
  readonly code: ErrorCode;
  readonly payload: ToolError;

  constructor(payload: ToolError) {
    super(`${payload.code}: ${payload.message}`);
    this.code = payload.code;
    this.payload = payload;
  }
}

function refuse(code: ErrorCode, message: string, nextAction: string): PgWorkerToolRefusal {
  return new PgWorkerToolRefusal({ status: 'blocked', code, message, next_action: nextAction });
}

// ───────────────────────────── 构造依赖 ─────────────────────────────

export interface PgWorkerToolsOptions {
  /** 执行服务：只用于 `requestApproval`（`admit` 的 `needs_approval` 分支）。 */
  readonly executor: Pick<ExecutionService, 'admit'>;
  /** 账本服务；报告状态、engagement 状态与两条领域事件必须同一事务提交。 */
  readonly ledger?: TransactionalLedger;
  /** 事务内客户端；报告取代与账本追加必须落在同一条连接。 */
  readonly txDb?: DbClient;
  /** 查询向量化。未注入时检索跳过向量路。 */
  readonly embedQuery?: (text: string) => Promise<readonly number[]>;
  /** RLS 租户上下文；engagement 一律按会话反查，不再是进程级值。 */
  readonly rlsContext?: { readonly tenantId: string };
  /** 通过 SECURITY DEFINER 反查 worker session 所属 engagement。 */
  readonly resolveRlsEngagement?: (workerSessionId: string) => Promise<string | null>;
}

interface SessionRow {
  readonly engagement_id: string;
  readonly scope_version: number;
  readonly phase: string | null;
  readonly status: string;
  readonly session_kind: 'intake' | 'phase';
  readonly attempt: number;
  readonly iteration: number;
  readonly state_version: number | string;
}
interface ScopeDecisionRow {
  readonly asset_id: string;
  readonly scope_version: number;
  readonly decision: string;
}

/** 检索候选行：三路排名 + 还原分块种类所需的分块元数据。 */
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
  readonly asset_ids: readonly string[];
  readonly finding_ids: readonly string[];
  readonly indexable: boolean;
  readonly event_type: string | null;
  readonly occurred_at: Date | string;
  readonly item_kind: string | null;
  readonly item_source_event_ids: readonly string[] | null;
  readonly report_payload: unknown;
  readonly human_accepted: boolean;
  /** `row_number()` 返回 bigint，`pg` 把它解析为字符串：转换责任在映射层，不能类型谎报。 */
  readonly lexical_rank: number | string | null;
  readonly trigram_rank: number | string | null;
  readonly semantic_rank: number | string | null;
}

interface ChunkReadRow {
  readonly id: string;
  readonly content: string;
  readonly content_hash: string;
  readonly worker_session_id: string | null;
  readonly source_event_id: string | null;
  readonly trust_level: string;
  readonly classification: string;
  readonly provisional: boolean;
  readonly asset_ids: readonly string[];
  readonly occurred_at: Date | string;
  readonly item_source_event_ids: readonly string[] | null;
}

interface ItemReadRow {
  readonly id: string;
  readonly content: string;
  readonly kind: string;
  readonly trust_level: string;
  readonly source_event_ids: readonly string[];
  readonly asset_ids: readonly string[];
  readonly occurred_at: Date | string;
}

interface EventReadRow {
  readonly event_id: string;
  readonly worker_session_id: string | null;
  readonly trust_level: string;
  readonly classification: string;
  readonly provisional: boolean;
  readonly occurred_at: Date | string;
  readonly payload_json: unknown;
}

interface EventChunkRow {
  readonly source_event_id: string;
  readonly ordinal: number;
  readonly content: string;
  readonly content_hash: string;
  readonly asset_ids: readonly string[];
}

interface ArtifactRow {
  readonly id: string;
  readonly media_type: string;
  readonly byte_size: number | string;
  readonly content_hash: string;
  readonly storage_kind: string;
  readonly storage_path: string | null;
  readonly inline_content: Uint8Array | null;
  readonly encrypted: boolean;
  readonly truncated: boolean;
  readonly asset_ids: readonly string[];
  readonly metadata: unknown;
}

// ───────────────────────────── 分块种类还原 ─────────────────────────────

// 还原规则**只有一份**：`chunks.ts` 的 `deriveChunkKind`（已导入）。
// 从前这里与 `pg-memory-query.ts` 各有一份私有副本（各自的逆索引、各自的分段匹配与兜底），
// 漂移的表现是「同一个 kinds 过滤在控制台与 Worker 上给出不同结果」——`kinds` 是精确过滤，
// 不是提示。共享实现里已经包含：信封拆解 + 分段别名 + 对象条目渲染（与分块器同源）。

// ───────────────────────────── 辅助 ─────────────────────────────

/**
 * 解析 `worker_sessions.skill_freeze`（026）。
 *
 * 空数组 = 旧会话（列缺省）→ 读取侧回退到既有语义。逐项校验形状：整列非数组或
 * 含非法项时返回空数组（同样走旧语义）——026 之前的行只可能是 `[]`，其它形状
 * 说明写入侧出了问题；此时回退到旧语义不会比它更糟，而误读成「已冻结」会错误地
 * 拒绝合法加载。
 */
function parseSkillFreeze(raw: unknown): readonly SkillFreezeEntry[] {
  if (!Array.isArray(raw)) return [];
  const entries: SkillFreezeEntry[] = [];
  for (const item of raw) {
    if (item === null || typeof item !== 'object') return [];
    const record = item as Record<string, unknown>;
    const name = record['name'];
    if (typeof name !== 'string' || name === '') return [];
    const revision = record['revision'];
    const contentHash = record['contentHash'];
    entries.push({
      name,
      revision: typeof revision === 'number' ? revision : null,
      contentHash: typeof contentHash === 'string' ? contentHash : null,
    });
  }
  return entries;
}

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

/** `memory:<id>` / `event:<id>` 引用（§8.6 的引用标识）。 */
interface ParsedRef {
  readonly raw: string;
  readonly kind: 'memory' | 'event';
  readonly id: string;
}

const UUID_PATTERN = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

function parseRef(raw: string): ParsedRef {
  const separator = raw.indexOf(':');
  const prefix = separator < 0 ? '' : raw.slice(0, separator);
  const id = separator < 0 ? '' : raw.slice(separator + 1);
  if ((prefix !== 'memory' && prefix !== 'event') || !UUID_PATTERN.test(id)) {
    throw refuse(
      'classification_rejected',
      `引用 ${raw} 无法归类：只接受 memory:<uuid> 或 event:<uuid>`,
      '改用 memory_search / memory_read 返回的引用标识；不要自行构造引用',
    );
  }
  return { raw, kind: prefix, id };
}

// ───────────────────────────── 实现 ─────────────────────────────

/**
 * 租约世代号校验：`null` 表示「没有未吊销租约」，否则必须是 >= 1 的整数。
 *
 * 提成函数而不是在两处各写一遍：两条解析路径（无 RLS 的裸查询、有 RLS 的作用域查询）
 * 共用同一份判据，分叉时不会一处校验一处漏。
 */
function toLeaseGeneration(raw: number | string | null): number | null {
  if (raw === null) return null;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`session_leases.generation 不是正整数：${String(raw)}`);
  }
  return value;
}

/**
 * PostgreSQL 实现：记忆检索、读取、报告、状态便签、范围提案、放行申请。
 *
 * 两个端口**不在本类**，因为它们不属于「记忆装配层」：
 *   - `execute`：由 `ExecutionService` 承担（§10.2「强制点位于服务内部」）；
 *   - `bootstrapIntake`：要创建作业与签发租约，属工作流服务，由组合根直接接线。
 */
export class PgWorkerTools implements Omit<WorkerToolDeps, 'execute' | 'bootstrapIntake' | 'requestHandoffDraft'> {
  readonly #db: DbClient;
  readonly #txDb: DbClient;
  readonly #txRunner: DbTransactionRunner;
  readonly #executor: Pick<ExecutionService, 'admit'>;
  readonly #embedQuery: PgWorkerToolsOptions['embedQuery'];
  readonly #ledger: TransactionalLedger | undefined;
  readonly #rlsContext: PgWorkerToolsOptions['rlsContext'];
  readonly #resolveRlsEngagement: PgWorkerToolsOptions['resolveRlsEngagement'];
  constructor(db: DbClient, options: PgWorkerToolsOptions) {
    this.#db = db;
    this.#txDb = options.txDb ?? db;
    this.#txRunner = transactionRunnerFor(this.#txDb);
    this.#executor = options.executor;
    this.#embedQuery = options.embedQuery;
    this.#ledger = options.ledger;
    this.#rlsContext = options.rlsContext;
    this.#resolveRlsEngagement = options.resolveRlsEngagement;
  }

  async #queryWithRlsContext<Row = Record<string, unknown>>(
    workerSessionId: string,
    engagementId: string,
    sql: string,
    params?: readonly unknown[],
  ): Promise<DbResult<Row>> {
    const rlsDb = this.#db as Partial<RlsAwareDbClient>;
    if (this.#rlsContext !== undefined && typeof rlsDb.queryWithRlsContext === 'function') {
      return rlsDb.queryWithRlsContext<Row>(
        { tenantId: this.#rlsContext.tenantId, engagementId, workerSessionId },
        sql,
        params,
      );
    }
    return this.#db.query<Row>(sql, params);
  }

  async #engagementForSession(workerSessionId: string): Promise<string> {
    if (this.#rlsContext === undefined) return '';
    const resolved = this.#resolveRlsEngagement === undefined
      ? null
      : await this.#resolveRlsEngagement(workerSessionId);
    if (this.#resolveRlsEngagement !== undefined && resolved === null) {
      throw refuse(
        'lease_required',
        `会话 ${workerSessionId} 不属于当前租户或不存在，拒绝建立 RLS 上下文`,
        '由当前控制台创建并签发租约的 Worker 会话调用工具',
      );
    }
    // 此前这里会回退到 `rlsContext.engagementId`（进程级的那个）。多作业下它已不存在，
    // 而且那个回退本身就是错的：会话解析不出作业时，拿别的作业的上下文继续读，
    // 会把「这个会话不属于任何作业」伪装成正常结果。宁可拒绝。
    if (resolved === null) {
      throw refuse(
        'lease_required',
        `会话 ${workerSessionId} 没有可解析的 engagement，拒绝建立 RLS 上下文`,
        '由控制台创建 Worker 会话并签发租约后再调用',
      );
    }
    return resolved;
  }

  /**
   * 读取本会话**已装载** skill 的正文。
   *
   * 两步都在 RLS 上下文里：先读会话冻结的 `skill_ids`，**命中才**去读库里的正文。
   * 顺序不能反——先查库再比对集合，等于给「未装载也能拿到正文」留了一条路
   * （查询出错、或未来有人把集合判断挪走，都会静默放行）。返回集合是为了让拒绝可解释。
   */
  async loadSkill(input: { readonly workerSessionId: string; readonly skillName: string }): Promise<{
    readonly skill: {
      readonly name: string;
      readonly description: string;
      readonly body: string;
      readonly contentHash: string;
      readonly revision: number;
    } | null;
    readonly loadedNames: readonly string[];
    /**
     * 明确的拒绝原因（内容漂移/被删除/被停用）。给出时 `skill` 必为 null，
     * 且调用方必须原样呈现——它比「不在装载集合里」准确得多。
     */
    readonly refusal?: { readonly message: string; readonly nextAction: string };
  }> {
    const engagementId = await this.#engagementForSession(input.workerSessionId);
    const session = await this.#queryWithRlsContext<{ skill_ids: unknown; skill_freeze: unknown }>(
      input.workerSessionId,
      engagementId,
      `select skill_ids, skill_freeze from pentest.worker_sessions where id = $1::uuid`,
      [input.workerSessionId],
    );
    const raw = session.rows[0]?.skill_ids;
    const loadedNames = Array.isArray(raw) ? raw.filter((item): item is string => typeof item === 'string') : [];
    if (!loadedNames.includes(input.skillName)) return { skill: null, loadedNames };

    // 内容冻结（事故 2026-10-05）：名字在集合里不等于正文还是人类看过的那一份。
    // 旧会话（026 之前）skill_freeze 为空数组 → 回退到既有语义（只按启用状态可读）。
    const freeze = parseSkillFreeze(session.rows[0]?.skill_freeze);
    const frozen = freeze.find((entry) => entry.name === input.skillName);

    const rows = await this.#queryWithRlsContext<{
      name: string;
      description: string;
      body: string;
      content_hash: string;
      revision: number;
      disabled: boolean;
    }>(
      input.workerSessionId,
      engagementId,
      `select name, description, body, content_hash, revision, disabled
         from pentest.skills
        where name = $1`,
      [input.skillName],
    );
    const row = rows.rows[0];
    if (frozen !== undefined) {
      if (frozen.revision === null || frozen.contentHash === null) {
        return {
          skill: null,
          loadedNames,
          refusal: {
            message: `skill ${input.skillName} 在创建会话时就不存在于库里（冻结值为空）`,
            nextAction: '由人类确认技能库后新建会话；不要用其它来源的正文代替',
          },
        };
      }
      if (row === undefined) {
        return {
          skill: null,
          loadedNames,
          refusal: {
            message: `skill ${input.skillName} 在会话创建后被删除；冻结的是 revision ${String(frozen.revision)}`,
            nextAction: '由人类恢复该技能或新建会话',
          },
        };
      }
      if (row.disabled) {
        return {
          skill: null,
          loadedNames,
          refusal: {
            message: `skill ${input.skillName} 已被停用；恢复启用且内容未变时可再加载`,
            nextAction: '由人类确认是否恢复启用，或新建会话选用其它技能',
          },
        };
      }
      if (row.revision !== frozen.revision || row.content_hash !== frozen.contentHash) {
        return {
          skill: null,
          loadedNames,
          refusal: {
            message:
              `skill ${input.skillName} 的正文在会话创建后被修改（冻结 revision ${String(frozen.revision)}，` +
              `当前 ${String(row.revision)}）；拒绝加载，防止执行与人类确认时不同的指令`,
            nextAction: '由人类确认改动并新建会话，或回滚该技能到此前的 revision',
          },
        };
      }
    } else if (row === undefined || row.disabled) {
      // 旧会话：与既有语义一致（库侧决定可读性）。
      return { skill: null, loadedNames };
    }
    if (row === undefined) return { skill: null, loadedNames };
    return {
      skill: {
        name: row.name,
        description: row.description,
        body: row.body,
        contentHash: row.content_hash,
        revision: row.revision,
      },
      loadedNames,
    };
  }

  async #withSessionRlsContext(tx: DbClient, workerSessionId: string): Promise<void> {
    if (this.#rlsContext === undefined) return;
    const engagementId = await this.#engagementForSession(workerSessionId);
    await tx.query('select pentest.set_rls_context($1, $2::uuid, $3::uuid)', [
      this.#rlsContext.tenantId,
      engagementId,
      workerSessionId,
    ]);
  }


  // ── 会话与范围解析（§8.7：engagement 由服务端从当前会话解析，不接受调用方传值） ──

  /**
   * dsh 会话标识 → worker 会话标识。
   *
   * 工具层拿到的执行身份是 dsh 会话标识（`session-<uuid>` 或 `dsh-<uuid>`），
   * 服务方法要的是 `worker_sessions.id`（裸 uuid）。两者混用会让每个工具都以
   * uuid 语法错误失败。
   *
   * ── 为什么走函数而不是直接查表 ──
   *
   * 这一步正是「先有鸡后有蛋」：要先知道这是哪个会话，才能设出它所属 engagement 的
   * RLS 上下文；而在设好之前，`worker_sessions` 的租户级放行已被 015 拆掉，裸查询
   * 一行都看不见。于是它恒返回 null，工具层报「本会话不是渗透控制台创建的」——
   * 把「查不到」说成了「不存在」，且在**已成功绑定**的会话上照样这么说。
   *
   * `worker_session_binding_by_dsh` 是受租户约束的 SECURITY DEFINER 函数（016），
   * 与 `engagement_for_worker_session` 同一模式：只回答「这个键归谁」，不返回任何目标数据。
   */
  async resolveWorkerSessionId(dshSessionId: string): Promise<string | null> {
    if (dshSessionId.length === 0) return null;
    // 未配置 RLS 的部署（迁移连接、测试）没有策略要绕过，裸查询就是对的；
    // 函数体要求 `current_tenant_id()` 非空，套上它反而恒返回 0 行。
    if (this.#rlsContext === undefined) {
      const direct = await this.#db.query<{ id: string }>(
        `select id from pentest.worker_sessions where dsh_session_id = $1`,
        [dshSessionId],
      );
      return direct.rows[0]?.id ?? null;
    }
    const r = await this.#db.query<{ worker_session_id: string | null }>(
      `select worker_session_id from pentest.worker_session_binding_by_dsh($1)`,
      [dshSessionId],
    );
    return r.rows[0]?.worker_session_id ?? null;
  }

  /**
   * dsh 会话 → worker 会话 + 调用开始时的当前租约世代。
   * 查询只读当前未吊销租约；提交时仍会在写事务内重新验证世代与到期时间。
   *
   * ── 为什么走函数而不是直接查表 ──
   *
   * 与 {@link resolveWorkerSessionId} 同因：这一步在**没有任何 engagement 上下文**时
   * 执行（它就是用来找出上下文的），裸查询在 015 之后恒返回 0 行，于是工具报
   * 「本会话不是渗透控制台创建的」。函数是受租户约束的单点反查（016）。
   *
   * 租约世代在同一事务语义里由 `session_leases` 读取——那一次读取发生在拿回
   * worker 会话标识**之后**，调用方（工具层）那时已经可以建立作用域。
   */
  async resolveWorkerSessionContext(
    dshSessionId: string,
  ): Promise<{ readonly workerSessionId: string; readonly leaseGeneration: number | null } | null> {
    if (dshSessionId.length === 0) return null;
    // 未配置 RLS 时走裸查询（同 `resolveWorkerSessionId` 的理由）。
    if (this.#rlsContext === undefined) {
      const direct = await this.#db.query<{ id: string; generation: number | string | null }>(
        `select ws.id, l.generation
           from pentest.worker_sessions ws
           left join lateral (
             select generation from pentest.session_leases
              where worker_session_id = ws.id and revoked_at is null
              order by generation desc limit 1
           ) l on true
          where ws.dsh_session_id = $1`,
        [dshSessionId],
      );
      const found = direct.rows[0];
      if (found === undefined) return null;
      return { workerSessionId: found.id, leaseGeneration: toLeaseGeneration(found.generation) };
    }
    const binding = await this.#db.query<{ worker_session_id: string | null; engagement_id: string | null }>(
      `select worker_session_id, engagement_id from pentest.worker_session_binding_by_dsh($1)`,
      [dshSessionId],
    );
    const bound = binding.rows[0];
    if (bound === undefined || bound.worker_session_id === null || bound.engagement_id === null) return null;
    // 拿到绑定之后就有了作业，可以在正确作用域里读租约。
    const result = await this.#queryWithRlsContext<{ generation: number | string | null }>(
      bound.worker_session_id,
      bound.engagement_id,
      `select generation
         from pentest.session_leases
        where worker_session_id = $1::uuid and revoked_at is null
        order by generation desc
        limit 1`,
      [bound.worker_session_id],
    );
    return {
      workerSessionId: bound.worker_session_id,
      leaseGeneration: toLeaseGeneration(result.rows[0]?.generation ?? null),
    };
  }

  /**
   * 解析会话及其**当前生效租约**，并据此做读取准入。
   *
   * ── 为什么读取也要过租约 ──
   *
   * 此前这里只查 `worker_sessions` + `engagements`，于是 `search` / `read` / `readArtifact`
   * 三条读取路径对「租约已被吊销」「租约已到期」完全无感：一个已被人工吊销租约、或租约到期
   * 未续（§10.6）的会话，只要它的 dsh Agent 还活着就仍能读整个 engagement 的记忆与证据。
   * 租约是「这个会话现在还被允许代表本作业工作」的唯一凭证，读取属于「代表作业工作」的一部分，
   * 因此与 `submitReport` / `requestScopeConfirmation` 同口径。
   *
   * 三条判定按「越基础越先判」排序，返回的错误码各自可被调用方分支（§16.5）：
   *   1. 会话不存在 / 没有生效租约 → `lease_required`；
   *   2. 租约已到期 → `lease_expired`；
   *   3. 会话状态已不在存活集合内 → `lease_revoked`。
   *
   * 第 3 条看着与第 1 条重复（终态转移会顺带吊销租约），但两者防的是不同的事：租约吊销由
   * 状态转移驱动，一旦某次转移漏了吊销，第 3 条就是那道兜底；读的是状态，不是租约痕迹。
   * 反过来，`human_revoke` 与到期清扫会吊销租约而**不**改会话状态，那种情况下只有第 1/2 条能拦住。
   */
  async #session(
    workerSessionId: string,
    options: { readonly allowExpiredLease?: boolean } = {},
  ): Promise<SessionRow> {
    // engagement 由当前 worker session 通过受约束反查解析；锁定后的单实例拒绝第二个 engagement。
    // 所有读取都把解析出的 engagement 传给 queryWithRlsContext，避免使用 bootstrap 值访问真实作业。
    //
    // ── 租约取「最新一行」而不是「最新未吊销行」 ──
    //
    // 到期清扫（`PgLeaseStore.revokeExpiredLeases`）会把过期租约写成
    // `revoked_at = now(), revoked_reason = 'expired'`。若 LATERAL 里过滤 `revoked_at is null`，
    // 被清扫过的会话看起来就像「从未签发租约」，于是一次**授权到期**会被报成
    // `lease_required`（文案「已吊销或从未签发」）——调用方与人都被指向错误的处置。
    // 取最新一行再按 `revoked_reason` 分流，才能把「到期」与「人为吊销」分开。
    const engagementId = await this.#engagementForSession(workerSessionId);
    const result = await this.#queryWithRlsContext<
      SessionRow & {
        readonly lease_generation: number | string | null;
        readonly lease_expired: boolean | null;
        readonly lease_revoked_reason: string | null;
      }
    >(
      workerSessionId,
      engagementId,
      `SELECT ws.engagement_id, ws.scope_version, ws.phase, ws.status, ws.session_kind,
              ws.attempt, ws.iteration, e.state_version,
              l.generation AS lease_generation,
              (l.revoked_at IS NULL AND l.expires_at <= now()) AS lease_expired,
              l.revoked_reason AS lease_revoked_reason
         FROM pentest.worker_sessions ws
         JOIN pentest.engagements e ON e.id = ws.engagement_id
         LEFT JOIN LATERAL (
           SELECT generation, revoked_at, revoked_reason, expires_at
             FROM pentest.session_leases
            WHERE worker_session_id = ws.id
            ORDER BY generation DESC
            LIMIT 1
         ) l ON true
        WHERE ws.id = $1::uuid`,
      [workerSessionId],
    );
    const row = result.rows[0];
    if (row === undefined) {
      throw refuse(
        'lease_required',
        `会话 ${workerSessionId} 不存在或没有 engagement 绑定，无法确定检索与提交范围`,
        '由控制台创建 Worker 会话并签发租约后再调用',
      );
    }
    if (row.lease_generation === null) {
      throw refuse(
        'lease_required',
        `会话 ${workerSessionId} 从未签发租约，读取被拒绝`,
        '由控制台签发租约后再调用；不要改用其它会话读取同一份记忆',
      );
    }
    // 到期清扫把过期租约写成 `revoked_at`（reason `expired`），因此「到期」有两种形态：
    // 尚未被清扫（`lease_expired` 为真）与已被清扫（`lease_revoked_reason = 'expired'`）。
    // 两者对调用方的处置**相同**（等控制台重新签发），必须报同一个码——
    // 否则一次授权到期会随机地显示成「没有租约」，把排错方向引到「为什么没签发」上。
    const leaseExpired =
      row.lease_revoked_reason === 'expired'
      || (row.lease_expired === true && row.lease_revoked_reason === null);
    if (leaseExpired) {
      // ── intake 的两个**只写提案**的工具豁免到期（`allowExpiredLease`）──
      //
      // 事实依据（2026-10-04 实机）：intake 会话靠人类逐题回答推进，而人的思考时间不受
      // 10 分钟 TTL 约束——人类答复慢于 TTL 是**常态**，不是异常。租约一到期，
      // `pentest_request_scope_confirmation` 就会被拒，于是「人类想改口径、Agent 重新提交方案」
      // 这条唯一路径被锁死，会话卡在 waiting_human 且无法自救（实测：用户遇到的就是这个）。
      //
      // **两种「到期」形态都要豁免**：未清扫（`lease_expired`）与**已被心跳清扫**
      //（`revoked_at=now(), revoked_reason='expired'`）。只豁免前者等于「推迟一个心跳 tick
      // 再卡死」——评审在 2026-10-04 的改动里抓到过这个半修。
      //
      // 豁免的边界必须说清：intake 会话**不做任何目标动作**（它连动作模板都没有），
      // 它的产出是「待人类确认的方案」——闸门是人类的确认，不是租约。真正的目标动作
      // （`pentest_exec`）走的是执行服务的租约闸门，那里**没有**任何豁免。
      if (options.allowExpiredLease !== true) {
        throw refuse(
          'lease_expired',
          `会话 ${workerSessionId} 的租约已到期，读取被拒绝`,
          '由控制台重新签发租约后再调用；到期未续的租约不会自动复活',
        );
      }
    }
    // 非到期的吊销（superseded / closed / failed / human_revoke）一律拒绝，豁免不覆盖它们。
    if (row.lease_revoked_reason !== null && !leaseExpired) {
      throw refuse(
        'lease_revoked',
        `会话 ${workerSessionId} 的租约已被吊销（${row.lease_revoked_reason}），读取被拒绝`,
        '由控制台重新签发租约后再调用；被吊销的租约不会自动恢复',
      );
    }
    if (!(LIVE_SESSION_STATUSES as readonly string[]).includes(row.status)) {
      throw refuse(
        'lease_revoked',
        `会话 ${workerSessionId} 的状态 ${row.status} 已不在存活集合内，读取被拒绝`,
        '本会话已被取代、关闭或失败；等待当前活动 Worker 接手',
      );
    }
    return {
      engagement_id: row.engagement_id,
      scope_version: row.scope_version,
      phase: row.phase,
      status: row.status,
      session_kind: row.session_kind,
      attempt: row.attempt,
      iteration: row.iteration,
      state_version: row.state_version,
    };
  }

  /** 由会话绑定的范围版本解析出 I(v) 与 X(v)（§8.6）。 */
  async #scopeSets(session: SessionRow): Promise<ScopeSets> {
    const result = await this.#db.query<ScopeDecisionRow>(
      `SELECT asset_id, scope_version, decision
         FROM pentest.asset_scope_versions
        WHERE engagement_id = $1::uuid AND scope_version = $2::int`,
      [session.engagement_id, session.scope_version],
    );
    return resolveScopeSets(
      result.rows.map((row) => ({
        assetId: row.asset_id,
        scopeVersion: row.scope_version,
        decision: row.decision as 'included' | 'excluded' | 'pending',
      })),
      session.scope_version,
    );
  }

  // ── 1. 混合检索（§8.6 / §8.7） ──

  async search(input: Parameters<WorkerToolDeps['search']>[0]): Promise<WorkerMemorySearchResult> {
    const session = await this.#session(input.workerSessionId);
    const scope = await this.#scopeSets(session);
    const limit = Math.min(
      Math.max(Math.trunc(input.limit ?? DEFAULT_RETRIEVAL_LIMIT), 1),
      MAX_RETRIEVAL_LIMIT,
    );
    const query = this.#memoryQuery(input, limit);

    const candidates = await this.#candidates(session, scope, query, limit);
    const fused = searchMemory({
      boundEngagementId: session.engagement_id,
      query,
      scope,
      candidates,
      now: new Date(),
    });

    const hits: WorkerMemorySearchResult['hits'] = fused.hits.map((hit) => ({
      memoryId: hit.chunkId,
      // 思考链必须带「模型内部推理」标注（§8.3）：命中的形状里没有独立标注字段，
      // 因此写在唯一的文本字段前，模型不可能把它当成事实。
      excerpt: hit.reasoningLabel === null ? hit.excerpt : `[${REASONING_LABEL}] ${hit.excerpt}`,
      score: hit.score,
      source: {
        // 空串表示该分块没有可引用的来源事件（条目来源且条目也没有来源事件）。
        eventId: hit.sourceEventId ?? '',
        workerSessionId: hit.workerSessionId ?? '',
        phase: hit.phase ?? '',
        occurredAt: hit.occurredAt,
      },
      trust: hit.trustLevel,
      citation: hit.citation,
    }));

    const indexWatermark = await this.#indexWatermark(session.engagement_id);
    await this.#auditQuery(session, input, fused);
    return { hits, indexWatermark };
  }

  /** 工具入参 → 检索层入参（§8.7 的字段名）。越界取值一律拒绝，不做静默忽略（§10.2.1）。 */
  #memoryQuery(input: Parameters<WorkerToolDeps['search']>[0], limit: number): MemoryQuery {
    const kinds = input.kinds ?? [];
    for (const kind of kinds) {
      if (!isChunkKind(kind)) {
        throw refuse(
          'classification_rejected',
          `kinds 含无法归类的记忆类型 ${kind}`,
          `改用 ${CHUNK_KINDS.join(' / ')} 之一`,
        );
      }
    }
    const trustLevels = input.trustLevels ?? [];
    for (const level of trustLevels) {
      if (!(TRUST_LEVELS as readonly string[]).includes(level)) {
        throw refuse(
          'classification_rejected',
          `trust_levels 含无法归类的来源可信度 ${level}`,
          `改用 ${TRUST_LEVELS.join(' / ')} 之一`,
        );
      }
    }
    if (input.phase !== undefined && !isPhase(input.phase)) {
      throw refuse(
        'classification_rejected',
        `phase 含无法归类的阶段 ${input.phase}`,
        '改用五个技术阶段之一（intelligence-gathering / threat-modeling / vulnerability-analysis / exploitation / post-exploitation）',
      );
    }
    return {
      query: input.query,
      limit,
      ...(input.phase === undefined ? {} : { phase: input.phase as Phase }),
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
   * 三路候选取回（§8.6：检索在 PostgreSQL 内完成）。
   *
   * 范围过滤全部下推：`buildRetrievalSql` 用会话范围版本解析出的 I(v)/X(v) 生成
   * 「排除优先 + 空归属放行」的子句。融合层还会用同一组集合复核一次——同一份纯逻辑用两处，
   * 下推负责效率、复核负责不变量。
   *
   * 两处显式选择：
   * - 时间范围（`from`/`to`）**不**下推：`buildRetrievalSql` 用 `memory_chunks.created_at`
   *   （分块写入时间），融合层按 `RetrievalCandidate.occurredAt`（事件发生时间）判定。
   *   两者不是同一个时间，同时施加会悄悄收窄结果，因此统一由融合层按事件发生时间判定。
   * - JOIN 别名与生成器不同（它按需占用 `mi`/`e`，本查询用自己的 `mit`/`ev`）：本查询为了还原
   *   种类与事件时间**总是**需要这两张表，重复的 `LEFT JOIN ... ON 主键相等` 是对同一主键的
   *   两次索引查找，语义不受影响（用同名别名会直接得到
   *   `table name "e" specified more than once`）。
   */
  async #candidates(
    session: SessionRow,
    scope: ScopeSets,
    query: MemoryQuery,
    limit: number,
  ): Promise<readonly RetrievalCandidate[]> {
    const sql = buildRetrievalSql({
      engagementId: session.engagement_id,
      query: { ...query, from: undefined, to: undefined },
      includedAssetIds: [...scope.included],
      excludedAssetIds: [...scope.excluded],
      scopeResolution: 'precomputed',
    });

    const params = [...sql.params];
    const bind = (value: unknown): string => {
      params.push(value);
      return `$${params.length}`;
    };
    const qParam = bind(query.query);
    const thresholdParam = bind(TRIGRAM_WORD_SIMILARITY_THRESHOLD);
    const routeLimitParam = bind(
      Math.min(Math.max(limit * ROUTE_CANDIDATE_FACTOR, ROUTE_CANDIDATE_MIN), ROUTE_CANDIDATE_MAX),
    );
    const reportTypesParam = bind([...REPORT_EVENT_TYPES]);

    const embedded =
      this.#embedQuery === undefined ? undefined : await this.#embedQuery(query.query);
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
    return result.rows.map((row) => this.#candidate(row, session.engagement_id));
  }

  #candidate(row: CandidateRow, engagementId: string): RetrievalCandidate {
    return {
      chunkId: row.id,
      engagementId,
      kind: deriveChunkKind(row),
      trustLevel: row.trust_level as TrustLevel,
      classification: row.classification as Classification,
      assetIds: asIdArray(row.asset_ids),
      findingIds: asIdArray(row.finding_ids),
      workerSessionId: row.worker_session_id,
      sourceEventId: row.source_event_id ?? asIdArray(row.item_source_event_ids)[0] ?? null,
      phase: row.phase === null ? null : (row.phase as Phase),
      occurredAt: toIso(row.occurred_at),
      provisional: row.provisional,
      humanAccepted: row.human_accepted,
      // §8.5「流量与二进制」只存元数据、不建全文与向量索引：写入侧只对可索引分块写全文向量
      // （§8.4），因此 search_vector 为空即不可检索。索引滞后（§15.5）的分块同样落在这一侧，
      // 与「检索结果可能遗漏尚未索引的事件」一致。
      indexable: row.indexable,
      excerpt: row.content,
      semanticRank: toRank(row.semantic_rank),
      lexicalRank: toRank(row.lexical_rank),
      trigramRank: toRank(row.trigram_rank),
    };
  }

  /** 索引水位（§8.4「更新索引水位」、§15.5）：已索引事件里最大的账本链序号；0 表示尚未索引。 */
  async #indexWatermark(engagementId: string): Promise<number> {
    const result = await this.#db.query<{ watermark: number | string }>(
      `SELECT COALESCE(MAX(e.chain_seq), 0) AS watermark
         FROM pentest.context_events e
         JOIN pentest.memory_chunks mc ON mc.source_event_id = e.event_id
        WHERE e.engagement_id = $1::uuid`,
      [engagementId],
    );
    return Number(result.rows[0]?.watermark ?? 0);
  }

  /** 检索审计（§8.7「写入检索记录」）：查询与命中同事务落库；审计写不进去就不返回结果。 */
  async #auditQuery(
    session: SessionRow,
    input: Parameters<WorkerToolDeps['search']>[0],
    fused: ReturnType<typeof searchMemory>,
  ): Promise<void> {
    const queryId = randomUUID();
    const filters = {
      phase: input.phase ?? null,
      kinds: input.kinds ?? [],
      trust_levels: input.trustLevels ?? [],
      asset_ids: input.assetIds ?? [],
      include_reasoning: fused.includeReasoning,
      applied_scope_version: session.scope_version,
      matched_before_limit: fused.matched,
      rejected: fused.rejected,
    };
    await this.#withTransaction(input.workerSessionId, async (tx) => {
      await tx.query(
        `INSERT INTO pentest.retrieval_queries
           (id, engagement_id, worker_session_id, origin, query_text, filters,
            include_reasoning, limit_requested)
         VALUES ($1::uuid, $2::uuid, $3::uuid, 'worker', $4, $5::jsonb, $6, $7::int)`,
        [
          queryId,
          session.engagement_id,
          input.workerSessionId,
          input.query,
          JSON.stringify(filters),
          fused.includeReasoning,
          Math.max(1, Math.trunc(input.limit ?? DEFAULT_RETRIEVAL_LIMIT)),
        ],
      );
      if (fused.hits.length === 0) return;

      // semantic_score / lexical_score 有意留空：三路只以**名次**参与 RRF 融合（§8.6），
      // 原始分（ts_rank_cd / word_similarity / 余弦距离）量纲互不相同、也不参与任何判断，
      // 落库只会让审计误以为它们可比较。final_score 是唯一可比较的分。
      await tx.query(
        `INSERT INTO pentest.retrieval_hits
           (query_id, rank, chunk_id, semantic_score, lexical_score, final_score, returned_excerpt)
         SELECT $1::uuid, t.ord, t.chunk_id, NULL, NULL, t.fin, t.excerpt
           FROM unnest($2::int[], $3::uuid[], $4::numeric[], $5::text[])
             AS t(ord, chunk_id, fin, excerpt)`,
        [
          queryId,
          fused.hits.map((_, index) => index + 1),
          fused.hits.map((hit) => hit.chunkId),
          fused.hits.map((hit) => hit.score),
          fused.hits.map((hit) => hit.excerpt),
        ],
      );
    });
  }

  // ── 2. 按标识读取（§8.7） ──

  async read(input: Parameters<WorkerToolDeps['read']>[0]): Promise<readonly MemoryRecord[]> {
    const session = await this.#session(input.workerSessionId);
    const scope = await this.#scopeSets(session);
    const refs = input.refs.slice(0, MAX_READ_REFS).map(parseRef);
    const memoryIds = refs.filter((ref) => ref.kind === 'memory').map((ref) => ref.id);
    const eventIds = refs.filter((ref) => ref.kind === 'event').map((ref) => ref.id);

    const chunks = await this.#readChunks(session.engagement_id, memoryIds);
    const items = await this.#readItems(session.engagement_id, memoryIds);
    const events = await this.#readEvents(session.engagement_id, eventIds);
    const eventChunks = await this.#readEventChunks(session.engagement_id, eventIds);

    const records: MemoryRecord[] = [];
    const unavailable: string[] = [];
    for (const ref of refs) {
      let record: MemoryRecord | undefined;
      if (ref.kind === 'memory') {
        const chunk = chunks.get(ref.id);
        const item = items.get(ref.id);
        if (chunk !== undefined && isChunkVisibleInScope(scopeFilterInput(chunk.asset_ids, scope))) {
          record = {
            memoryId: chunk.id,
            content: chunk.content,
            contentHash: chunk.content_hash,
            occurredAt: toIso(chunk.occurred_at),
            originWorkerSessionId: chunk.worker_session_id,
            trust: chunk.trust_level,
            classification: chunk.classification,
            provisional: chunk.provisional,
            relatedEventIds:
              chunk.source_event_id !== null
                ? [chunk.source_event_id]
                : asIdArray(chunk.item_source_event_ids),
          };
        } else if (item !== undefined) {
          // §8.6 的范围谓词同样适用于条目正文。`memory_items.asset_ids` 由迁移 014
          // 补上：在它之前，条目读取只做 engagement 边界，于是「知道条目 UUID」就能
          // 越过资产排除——分块那侧的过滤做得再严也没用，因为这条引用根本不经过分块。
          //
          // 空归属仍然放行（与分块同口径）：人工决策、交接、压缩摘要本就解析不出资产，
          // 要求「必须归属某资产」会让它们整批从可读面消失。与它配套的是**写入侧义务**
          // （§8.6）：能确定归属的条目在写入时必须填齐 `asset_ids`。
          if (!isChunkVisibleInScope(scopeFilterInput(asIdArray(item.asset_ids), scope))) {
            unavailable.push(ref.raw);
            continue;
          }
          // classification 取 engagement 级：`memory_items` 没有分类列，该表按
          // engagement 隔离，这是唯一不靠猜的取值。
          record = {
            memoryId: item.id,
            content: item.content,
            contentHash: sha256Hex(item.content),
            occurredAt: toIso(item.occurred_at),
            originWorkerSessionId: null,
            trust: item.trust_level,
            classification: 'engagement',
            provisional: false,
            relatedEventIds: asIdArray(item.source_event_ids),
          };
        }
      } else {
        const event = events.get(ref.id);
        if (event !== undefined) {
          const visible = (eventChunks.get(ref.id) ?? []).filter((chunk) =>
            isChunkVisibleInScope(scopeFilterInput(chunk.asset_ids, scope)),
          );
          if (visible.length === 0) {
            unavailable.push(ref.raw);
            continue;
          }
          const content = visible.map((chunk) => chunk.content).join('\n');
          record = {
            memoryId: event.event_id,
            content,
            // 单块沿用存储的内容哈希；多块拼接按返回内容重新计算。
            contentHash: visible.length === 1 ? visible[0]!.content_hash : sha256Hex(content),
            occurredAt: toIso(event.occurred_at),
            originWorkerSessionId: event.worker_session_id,
            trust: event.trust_level,
            classification: event.classification,
            provisional: event.provisional,
            relatedEventIds: [event.event_id],
          };
        }
      }
      if (record === undefined) unavailable.push(ref.raw);
      else records.push(record);
    }

    if (unavailable.length > 0) {
      throw refuse(
        'scope_violation',
        `${UNAVAILABLE_REFS_MESSAGE}：${unavailable.join(', ')}`,
        '改用检索结果里的引用；确认引用属于本会话的 engagement 且未被范围排除',
      );
    }

    await this.#auditAccess(
      input.workerSessionId,
      session.engagement_id,
      'memory_read',
      refs.map((ref) => ref.id),
      input.refs.length,
    );
    return records;
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
              mc.provisional, mc.asset_ids::text[] AS asset_ids,
              COALESCE(e.occurred_at, mc.created_at) AS occurred_at,
              mi.source_event_ids::text[] AS item_source_event_ids
         FROM pentest.memory_chunks mc
         LEFT JOIN pentest.context_events e ON e.event_id = mc.source_event_id
         LEFT JOIN pentest.memory_items mi ON mi.id = mc.memory_item_id
        WHERE mc.id = ANY($1::uuid[]) AND mc.engagement_id = $2::uuid`,
      [ids, engagementId],
    );
    for (const row of result.rows) map.set(row.id, row);
    return map;
  }

  async #readItems(engagementId: string, ids: readonly string[]): Promise<Map<string, ItemReadRow>> {
    const map = new Map<string, ItemReadRow>();
    if (ids.length === 0) return map;
    const result = await this.#db.query<ItemReadRow>(
      `SELECT mi.id, mi.content, mi.kind::text AS kind, mi.trust_level::text AS trust_level,
              mi.source_event_ids::text[] AS source_event_ids,
              mi.asset_ids::text[] AS asset_ids,
              COALESCE(mi.valid_at, mi.created_at) AS occurred_at
         FROM pentest.memory_items mi
        WHERE mi.id = ANY($1::uuid[]) AND mi.engagement_id = $2::uuid`,
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
              e.classification::text AS classification, e.provisional, e.occurred_at,
              e.payload_json
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

  // ── 3. 读取证据（§9.2 artifacts / §8.7） ──

  async readArtifact(input: Parameters<WorkerToolDeps['readArtifact']>[0]): Promise<ArtifactRecord> {
    const session = await this.#session(input.workerSessionId);
    const scope = await this.#scopeSets(session);
    if (!UUID_PATTERN.test(input.artifactId)) {
      throw refuse(
        'classification_rejected',
        `证据标识 ${input.artifactId} 不是有效标识`,
        '改用扫描或工具结果返回的 evidence 引用',
      );
    }
    const result = await this.#db.query<ArtifactRow>(
      `SELECT id, media_type, byte_size, content_hash, storage_kind, storage_path,
              inline_content, encrypted, truncated, asset_ids::text[] AS asset_ids, metadata
         FROM pentest.artifacts
        WHERE id = $1::uuid AND engagement_id = $2::uuid`,
      [input.artifactId, session.engagement_id],
    );
    const row = result.rows[0];
    // 三种不可用不区分（不存在 / 别的 engagement / 被范围排除），避免泄露存在性（§18.4）。
    //
    // 范围判定复用 §8.6 的谓词（迁移 014 给 `artifacts` 补了 `asset_ids`）。此前这里只看
    // `id + engagement_id`，于是与被排除资产关联的证据在范围修订之后**仍然**可以按 UUID
    // 直读——范围修订只改了 `asset_scope_versions`，而这条查询根本不看范围。
    if (
      row === undefined
      || !isChunkVisibleInScope(scopeFilterInput(asIdArray(row.asset_ids), scope))
    ) {
      throw refuse(
        'scope_violation',
        `证据 ${input.artifactId}：${UNAVAILABLE_REFS_MESSAGE}`,
        '改用本会话 engagement 内的证据引用；不要用历史引用猜测当前范围',
      );
    }

    const byteSize = Number(row.byte_size);
    // 原始字节一律不发模型（§11.3）：只有「未加密 + 内联 + 文本类 + 未超内联上限」才给内容，
    // 其余给受控引用（文件路径，或 `artifact:<id>` 这一需要授权解密才能取到内容的引用）。

    const textLike = /^(text\/|application\/(json|xml|x-ndjson|yaml)|application\/(x-)?yaml)/iu.test(
      row.media_type,
    );
    const inlineEligible =
      !row.encrypted
      && row.storage_kind === 'inline'
      && row.inline_content !== null
      && textLike
      && byteSize <= DEFAULTS.artifactFileThresholdBytes;
    const inline = inlineEligible
      ? Buffer.from(row.inline_content as Uint8Array).toString('utf8')
      : undefined;

    await this.#auditAccess(input.workerSessionId, session.engagement_id, 'artifact_read', [row.id], 1);
    return {
      artifactId: row.id,
      mediaType: row.media_type,
      byteSize,
      contentHash: row.content_hash,
      ...(inline === undefined ? {} : { inline }),
      ...(inline === undefined ? { storageRef: row.storage_path ?? `artifact:${row.id}` } : {}),
      truncated: row.truncated || inline === undefined,
      metadata: row.metadata,
    };
  }

  // ── 4. 提交报告（§7.1 / §13.4 / §9.2） ──

  async submitReport(
    input: Parameters<WorkerToolDeps['submitReport']>[0],
  ): Promise<{ reportId: string; stateVersion: number }> {
    const report = input.report;
    return this.#withTransaction(input.workerSessionId, async (tx) => {
      const locked = await tx.query<SessionRow & {
        lease_generation: number | string | null;
        current_status: string;
        active_agent_session_id: string | null;
      }>(
        `SELECT ws.engagement_id, ws.scope_version, ws.phase, ws.status, ws.attempt, ws.iteration,
                ws.session_kind,
                e.state_version, e.current_status, e.active_agent_session_id,
                l.generation as lease_generation
           FROM pentest.worker_sessions ws
           JOIN pentest.engagements e ON e.id = ws.engagement_id
           LEFT JOIN LATERAL (
             SELECT generation
               FROM pentest.session_leases
              WHERE worker_session_id = ws.id AND revoked_at IS NULL
              ORDER BY generation DESC
              LIMIT 1
           ) l ON true
          WHERE ws.id = $1::uuid
          FOR UPDATE OF ws, e`,
        [input.workerSessionId],
      );
      const session = locked.rows[0];
      if (session === undefined) {
        throw refuse(
          'lease_required',
          `会话 ${input.workerSessionId} 不存在或没有 engagement 绑定`,
          '由控制台创建 Worker 会话并签发租约后再提交',
        );
      }
      // ── intake 会话的产出是**范围方案**，不是报告 ──
      //
      // 为什么必须有这条服务端闸门（而不是只靠工具面）：聊天路径的 intake 会话接管的是
      // **人类已有的 dsh 会话**，插件无法在那个会话上补 `tools.restrict`——实测（2026-10-04）
      // 那个会话的工具面是全部 Worker 工具，于是模型「顺手把这一轮收尾」调用了
      // `pentest_submit_report`。后果不是文案问题：报告把会话推进到等待人工，
      // 而 intake 的唯一出口（`pentest_request_scope_confirmation`）随后被租约/状态挡住，
      // 整个 intake 卡死（人类看到的正是那句 `lease_revoked`）。
      if (session.session_kind === 'intake') {
        throw refuse(
          'classification_rejected',
          'intake 会话不能提交任务报告：它的产出是**待人类确认的范围方案**',
          '用 pentest_request_scope_confirmation 提交/更新范围方案；报告属于范围确认之后的阶段会话',
        );
      }
      if (session.active_agent_session_id !== input.workerSessionId) {
        throw refuse(
          'lease_revoked',
          '只有 engagement 当前活动会话可以提交报告；本会话已被取代或关闭',
          '等待当前活动 Worker 提交，或由人类重新启动会话',
        );
      }
      if (!REPORT_SUBMIT_ALLOWED_FROM.includes(session.status)) {
        throw refuse(
          session.status === 'starting' ? 'lease_required' : 'lease_revoked',
          `会话状态 ${session.status} 不能提交报告`,
          '由人类在工作流里推进会话状态；报告只在运行中的会话提交',
        );
      }
      const currentGeneration = session.lease_generation === null ? null : Number(session.lease_generation);
      if (input.leaseGeneration === null || currentGeneration === null) {
        throw refuse('lease_required', '提交报告需要当前会话持有未吊销租约', '由控制台重新签发租约后再提交');
      }
      if (!Number.isSafeInteger(currentGeneration) || input.leaseGeneration !== currentGeneration) {
        throw refuse(
          'lease_generation_stale',
          `报告来自旧租约世代（请求 ${String(input.leaseGeneration)}，当前 ${String(currentGeneration)}）`,
          '丢弃本轮旧报告，等待当前 Worker 重新提交',
        );
      }
      const lease = await tx.query<{ expires_at: Date | string; expired: boolean }>(
        `select expires_at, expires_at <= now() as expired
           from pentest.session_leases
          where worker_session_id = $1::uuid and generation = $2::int and revoked_at is null`,
        [input.workerSessionId, currentGeneration],
      );
      const leaseRow = lease.rows[0];
      if (leaseRow === undefined) {
        throw refuse('lease_revoked', '提交报告所需的租约已吊销', '由控制台重新签发租约后再提交');
      }
      if (leaseRow.expired) {
        throw refuse('lease_expired', '提交报告所需的租约已过期', '由控制台重新签发租约后再提交');
      }

      const newId = randomUUID();
      const payloadJson = JSON.stringify(report.payload ?? {}) ?? '{}';
      const contentHash = sha256Hex(
        JSON.stringify({
          status: report.status,
          objective: report.objective,
          summary: report.summary,
          payload: report.payload ?? {},
        }),
      );
      // 未提供便签时用报告摘要兜底，保证等待人工列表始终有扫描线索；显式空白仍视为
      // 「没有便签」，同样回落摘要，而不是写入空字符串。
      const suppliedNote = report.statusNote?.trim() ?? '';
      const note = (suppliedNote === '' ? report.summary : suppliedNote).slice(0, DEFAULTS.statusNoteMaxChars);
      const noteSource: 'agent' | 'derived' = suppliedNote === '' ? 'derived' : 'agent';

      // 先让位、后插入：两个自引用外键是延迟约束，提交时校验取代关系。
      const superseded = await tx.query<{ id: string }>(
        `UPDATE pentest.worker_reports
            SET superseded_by = $1::uuid
          WHERE worker_session_id = $2::uuid AND attempt = $3::int AND superseded_by IS NULL
        RETURNING id`,
        [newId, input.workerSessionId, session.attempt],
      );
      const supersedesId = superseded.rows[0]?.id ?? null;

      await tx.query(
        `INSERT INTO pentest.worker_reports
           (id, engagement_id, worker_session_id, attempt, iteration, status, objective,
            summary, payload_json, content_hash, supersedes_id)
         VALUES ($1::uuid, $2::uuid, $3::uuid, $4::int, $5::int, $6, $7, $8, $9::jsonb, $10, $11::uuid)`,
        [
          newId,
          session.engagement_id,
          input.workerSessionId,
          session.attempt,
          session.iteration,
          report.status,
          report.objective,
          report.summary,
          payloadJson,
          contentHash,
          supersedesId,
        ],
      );

      await tx.query(
        `UPDATE pentest.worker_sessions
            SET status = 'waiting_human',
                status_note = $1::text,
                status_note_at = now(),
                status_note_source = $2
          WHERE id = $3::uuid`,
        [note, noteSource, input.workerSessionId],
      );

      const engagementUpdate = await tx.query<{ state_version: number | string }>(
        `UPDATE pentest.engagements
            SET current_status = 'waiting_human_review',
                state_version = state_version + 1,
                updated_at = now()
          WHERE id = $1::uuid
        RETURNING state_version`,
        [session.engagement_id],
      );
      if (engagementUpdate.rows[0] === undefined) {
        throw refuse('classification_rejected', '报告所属 engagement 不存在，拒绝提交', '刷新会话后重试');
      }
      const version = engagementUpdate.rows[0].state_version;
      if (this.#ledger !== undefined) {
        const reportedAt = new Date();
        const reportEventPayload = workerReportEventPayload({ reportId: newId, report });
        const noteEventPayload = {
          note,
          noteAt: reportedAt.toISOString(),
          source: noteSource,
          reportId: newId,
        };
        await this.#ledger.appendBatchInTransaction(tx, [
          {
            engagementId: session.engagement_id,
            workerSessionId: input.workerSessionId,
            eventType: 'worker.report',
            sourceSystem: 'pentest-worker',
            sourceId: `worker.report:${newId}`,
            sourceSeq: 1,
            occurredAt: reportedAt,
            payload: reportEventPayload,
            rawPayload: new TextEncoder().encode(JSON.stringify(reportEventPayload)),
            classification: 'engagement',
            trustLevel: 'agent_claim',
          },
          {
            engagementId: session.engagement_id,
            workerSessionId: input.workerSessionId,
            eventType: 'worker.status_note',
            sourceSystem: 'pentest-worker',
            sourceId: `worker.status_note:report:${newId}`,
            sourceSeq: 1,
            occurredAt: reportedAt,
            payload: noteEventPayload,
            rawPayload: new TextEncoder().encode(JSON.stringify(noteEventPayload)),
            classification: 'engagement',
            trustLevel: 'agent_claim',
          },
          {
            engagementId: session.engagement_id,
            workerSessionId: input.workerSessionId,
            eventType: 'worker.waiting_human',
            sourceSystem: 'pentest-worker',
            sourceId: `worker.waiting_human:${newId}`,
            sourceSeq: 1,
            occurredAt: reportedAt,
            payload: { reportId: newId },
            rawPayload: new TextEncoder().encode(JSON.stringify({ reportId: newId })),
            classification: 'engagement',
            trustLevel: 'agent_claim',
          },
        ]);
      }
      return { reportId: newId, stateVersion: Number(version) };
    });
  }

  /** intake Worker 只能提交待人类确认的范围方案；不创建范围版本，不改变主状态。 */
  async requestScopeConfirmation(
    input: Parameters<WorkerToolDeps['requestScopeConfirmation']>[0],
  ): Promise<ScopeProposal> {
    // `allowExpiredLease`：人类回答 intake 问题的时间不受 TTL 约束（见 `#session` 的说明）。
    // 提案本身不做目标动作，闸门是人类的确认；这里不接受「租约过期 ⇒ 会话卡死」。
    const session = await this.#session(input.workerSessionId, { allowExpiredLease: true });
    if (session.session_kind !== 'intake' || session.scope_version !== 0) {
      throw refuse(
        'classification_rejected',
        '只有尚未确认范围的 intake 会话可以提交范围方案',
        '继续收集授权信息，或等待人类确认当前范围方案',
      );
    }
    if (
      typeof input.objective !== 'string' ||
      !Array.isArray(input.targets) ||
      !Array.isArray(input.exclusions) ||
      !Array.isArray(input.allowedActions)
    ) {
      throw refuse(
        'classification_rejected',
        '范围方案字段类型无效：objective 必须是字符串，targets/exclusions/allowedActions 必须是数组',
        '按 ScopeTarget 契约提交完整范围条目，并为每项提供 kind、value、protocols 与 ports',
      );
    }
    // 留痕字段：模型侧不提供，缺失即按空串处理（它只进审计与策略快照，不参与判定）。
    const authorizationNote = typeof input.authorizationNote === 'string' ? input.authorizationNote : '';
    // 授权说明**可留空**：本部署不要求授权凭据（见 `confirmScopeProposal` 的同名说明）。
    // 目标不能为空——没有目标的「范围方案」没有意义。
    if (input.objective.trim().length === 0) {
      throw refuse('classification_rejected', '目标不能为空', '补齐 objective 与范围条目后重新提交');
    }
    if (input.targets.length === 0) {
      throw refuse('classification_rejected', '范围方案至少需要一个目标', '先向人类询问目标、协议和端口');
    }
    for (const entry of [...input.targets, ...input.exclusions]) {
      const normalized = normalizeScopeEntry(entry);
      if (!normalized.ok) {
        throw refuse('classification_rejected', `范围方案包含非法条目：${normalized.detail}`, '修正条目后重新提交');
      }
    }
    const allowedActions = [...new Set(input.allowedActions)];
    for (const action of allowedActions) {
      if (!ACTION_CLASSES.includes(action)) {
        throw refuse('classification_rejected', `未知动作类别：${String(action)}`, '只提交契约允许的动作类别');
      }
    }
    const now = new Date();
    return this.#withTransaction(input.workerSessionId, async (tx) => {
      const locked = await tx.query<{
        engagement_id: string;
        status: string;
        session_kind: 'intake' | 'phase';
        scope_version: number | string;
        active_agent_session_id: string | null;
        current_status: string;
        lease_generation: number | string | null;
        lease_expires_at: Date | string | null;
        lease_revoked_reason: string | null;
      }>(
        `select ws.engagement_id, ws.status, ws.session_kind, ws.scope_version,
                e.active_agent_session_id, e.current_status,
                l.generation as lease_generation, l.expires_at as lease_expires_at
           from pentest.worker_sessions ws
           join pentest.engagements e on e.id = ws.engagement_id
           left join lateral (
             -- **不过滤 revoked_at**：到期清扫会把过期租约写成
             -- revoked_at=now() / revoked_reason='expired'，滤掉它等于「清扫一到就再也提不了方案」
             -- （评审抓到的半修：豁免只推迟了一个心跳 tick）。非到期的吊销在这里也要能看见，
             -- 由下面的 revoked_reason 判定拒绝。
             select generation, expires_at, revoked_reason
               from pentest.session_leases
              where worker_session_id = ws.id
              order by generation desc limit 1
           ) l on true
          where ws.id = $1::uuid and ws.engagement_id = $2::uuid
          for update of ws, e`,
        [input.workerSessionId, session.engagement_id],
      );
      const row = locked.rows[0];
      // 判据必须与 intake 的**真实状态集**对齐（对齐 `core.intakeConfirmBlock` 的取值）：
      //   - 会话：`active`/`paused`/`waiting_human`——intake 会坐下来等人类回答，那是它的常态；
      //   - 主状态：`auth_pending` 或 `waiting_human_review`——范围确认前的 intake 都算数
      //     （后者是「intake 会话提交过报告」留下的状态，2026-10-04 的实机事故就是它：
      //     旧代码在这里拒绝，人类既提不了新方案、也只能靠 confirm 那条路出去）；
      //   - 租约：**只要求存在**（generation 非空），不要求未过期；
      //   - 非到期吊销（superseded/closed/failed/human_revoke）：拒绝。
      const leaseSwept = row?.lease_revoked_reason === 'expired';
      const leaseRevokedForOtherReason = row?.lease_revoked_reason != null && !leaseSwept;
      if (
        row === undefined
        || row.engagement_id !== session.engagement_id
        || row.session_kind !== 'intake'
        || Number(row.scope_version) !== 0
        || row.active_agent_session_id !== input.workerSessionId
        || !['auth_pending', 'waiting_human_review'].includes(row.current_status)
        || !['active', 'paused', 'waiting_human'].includes(row.status)
        || row.lease_generation === null
        || leaseRevokedForOtherReason
      ) {
        throw refuse('lease_revoked', 'intake 会话或租约已不可用', '刷新控制台并重新打开任务');
      }
      const pending = await tx.query<{ id: string }>(
        `update pentest.scope_intake_proposals
            set status = 'superseded', decided_at = $2
          where engagement_id = $1::uuid and status = 'pending'
        returning id`,
        [session.engagement_id, now],
      );
      const proposalId = randomUUID();
      await tx.query(
        `insert into pentest.scope_intake_proposals
           (id, engagement_id, worker_session_id, objective, proposed_targets,
            proposed_exclusions, proposed_allowed_actions, authorization_note, status)
         values ($1::uuid,$2::uuid,$3::uuid,$4,$5::jsonb,$6::jsonb,$7::jsonb,$8,'pending')`,
        [
          proposalId,
          session.engagement_id,
          input.workerSessionId,
          input.objective,
          JSON.stringify(input.targets),
          JSON.stringify(input.exclusions),
          JSON.stringify(allowedActions),
          authorizationNote,
        ],
      );
      if (this.#ledger !== undefined) {
        const events: AppendEventInput[] = [];
        for (const superseded of pending.rows) {
          const payload = { proposalId: superseded.id, replacementProposalId: proposalId };
          events.push({
            engagementId: session.engagement_id,
            workerSessionId: input.workerSessionId,
            eventType: 'scope.proposal.superseded',
            sourceSystem: 'pentest-worker',
            sourceId: `scope.proposal.superseded:${superseded.id}`,
            sourceSeq: 1,
            occurredAt: now,
            payload,
            rawPayload: new TextEncoder().encode(JSON.stringify(payload)),
            classification: 'engagement',
            trustLevel: 'agent_claim',
          });
        }
        const payload = {
          proposalId,
          supersededProposalIds: pending.rows.map((item) => item.id),
          objective: input.objective,
          targets: input.targets,
          exclusions: input.exclusions,
          allowedActions,
          authorizationNote,
        };
        events.push({
          engagementId: session.engagement_id,
          workerSessionId: input.workerSessionId,
          eventType: 'scope.proposal.created',
          sourceSystem: 'pentest-worker',
          sourceId: `scope.proposal.created:${proposalId}`,
          sourceSeq: 1,
          occurredAt: now,
          payload,
          rawPayload: new TextEncoder().encode(JSON.stringify(payload)),
          classification: 'engagement',
          trustLevel: 'agent_claim',
        });
        await this.#ledger.appendBatchInTransaction(tx, events);
      }
      return {
        id: proposalId,
        engagementId: session.engagement_id,
        workerSessionId: input.workerSessionId,
        objective: input.objective,
        targets: input.targets,
        exclusions: input.exclusions,
        allowedActions,
        authorizationNote,
        status: 'pending',
        createdAt: now.toISOString(),
        decidedAt: null,
      };
    });
  }

  /**
   * 写入本轮状态便签（§6.2.2）。
   *
   * ── 为什么它必须和提交报告同口径 ──
   *
   * 此前这里是一条 `UPDATE ... WHERE id = $1 AND status NOT IN (...)`：只看会话 id 与
   * 「不是终态」。租约世代、到期、吊销、以及「本会话是否仍是当前活动会话」一概不看。
   * 后果是旧世代 Agent 在租约吊销或会话被替换之后，仍能覆盖便签——而便签是控制台列表上
   * 人类读到的第一句话，被替换掉的会话回来改写它，等于让人按过期信息做判断。
   *
   * 因此这里按 `submitReport` 的同一条纪律校验：锁住会话与 engagement、取当前未吊销租约，
   * 再依次判「是当前活动会话」「状态可写」「世代一致」「未到期」。
   *
   * ── 与 `submitReport` 的唯一差别：不推进状态 ──
   *
   * 便签只是扫描线索（§6.2.2「逐轮的扫描线索」），它**不**改变会话状态，也不推进
   * engagement 的 `state_version`。`submitReport` 才把会话置为 `waiting_human` 并推进状态机。
   *
   * ── 账本事件是设计要求的，不是可选装饰 ──
   *
   * §6.2.2 的「落点」一节写明：便签写入 `worker_sessions.status_note` 与 `status_note_at`，
   * **同时写一条领域事件进账本**，供时间线与列表渲染。类头此前声明这件事「不在本类职责内」，
   * 于是 `worker.status_note` 这个已注册的领域事件类型**从未被写入过**——类型在契约里、
   * 语义在文档里、实现里没有。账本缺失时这里与 `submitReport` 一样降级（不写事件、仍写便签），
   * 但生产装配必须注入 ledger（`compose()` 会注入）。
   */
  async writeStatusNote(
    input: Parameters<WorkerToolDeps['writeStatusNote']>[0],
  ): Promise<{ stored: boolean; source: 'agent' | 'derived' }> {
    const note = input.note.trim();
    // 空便签不是错误也不是写入：直接返回「没存」，不校验租约（什么都没改）。
    if (note.length === 0) return { stored: false, source: 'agent' };
    // 超长截断（§6.2.2 上限 200 字符）：工具层已先行截断，这里再截一次，因为 deps 也会被
    // 组合层之外的调用方直接使用。
    const text = note.slice(0, DEFAULTS.statusNoteMaxChars);
    const now = new Date();

    const stored = await this.#withTransaction(input.workerSessionId, async (tx) => {
      const locked = await tx.query<{
        engagement_id: string;
        status: string;
        active_agent_session_id: string | null;
        lease_generation: number | string | null;
        lease_expired: boolean | null;
        lease_revoked_reason: string | null;
      }>(
        // 与 `#session` 同口径：取**最新一行**而不是「最新未吊销行」，并按 `revoked_reason`
        // 分流。只看 `revoked_at IS NULL` 会把「到期被清扫」与「被吊销」一起变成
        // 「没有租约」，调用方因此拿不到正确的处置方向。
        `SELECT ws.engagement_id, ws.status, e.active_agent_session_id,
                l.generation AS lease_generation,
                (l.revoked_at IS NULL AND l.expires_at <= now()) AS lease_expired,
                l.revoked_reason AS lease_revoked_reason
           FROM pentest.worker_sessions ws
           JOIN pentest.engagements e ON e.id = ws.engagement_id
           LEFT JOIN LATERAL (
             SELECT generation, revoked_at, revoked_reason, expires_at
               FROM pentest.session_leases
              WHERE worker_session_id = ws.id
              ORDER BY generation DESC
              LIMIT 1
           ) l ON true
          WHERE ws.id = $1::uuid
          FOR UPDATE OF ws, e`,
        [input.workerSessionId],
      );
      const session = locked.rows[0];
      if (session === undefined) {
        throw refuse(
          'lease_required',
          `会话 ${input.workerSessionId} 不存在或没有 engagement 绑定，拒绝写入便签`,
          '由控制台创建 Worker 会话并签发租约后再写入',
        );
      }
      // 只有 engagement 当前的活动会话可以写：被取代的会话即便租约还没被清掉，
      // 它写的便签也已经不代表任何人。
      if (session.active_agent_session_id !== input.workerSessionId) {
        throw refuse(
          'lease_revoked',
          '只有 engagement 当前活动会话可以写状态便签；本会话已被取代或关闭',
          '等待当前活动 Worker 写入；不要用旧会话覆盖列表上的便签',
        );
      }
      if (!(LIVE_SESSION_STATUSES as readonly string[]).includes(session.status)) {
        throw refuse(
          'lease_revoked',
          `会话状态 ${session.status} 已不在存活集合内，拒绝写入便签`,
          '由人类在工作流里推进会话状态；终态会话不再接收便签',
        );
      }
      if (session.lease_revoked_reason === 'expired' || session.lease_expired === true) {
        throw refuse(
          'lease_expired',
          '写入状态便签所需的租约已到期',
          '由控制台重新签发租约后再写入；到期未续的租约不会自动复活',
        );
      }
      if (session.lease_revoked_reason !== null) {
        throw refuse(
          'lease_revoked',
          `写入状态便签所需的租约已被吊销（${session.lease_revoked_reason}）`,
          '由控制台重新签发租约后再写入；被吊销的租约不会自动恢复',
        );
      }
      const currentGeneration =
        session.lease_generation === null ? null : Number(session.lease_generation);
      // `undefined`（调用方省略）与 `null`（明确表示「我没有世代」）都归 `lease_required`：
      // 两者都是「这次调用没有携带世代」，而不是「携带了一个过期的世代」。
      // 把它们报成 `lease_generation_stale` 会让调用方去「重新构造计划」，
      // 而正确动作是「先解析当前世代」。接口上该字段可选是给旧替身留的缝
      // （见 `WorkerToolDeps.writeStatusNote` 注释），真实工具路径总是带上它。
      if (input.leaseGeneration === null || input.leaseGeneration === undefined || currentGeneration === null) {
        throw refuse(
          'lease_required',
          '写入状态便签需要当前会话持有未吊销租约，且调用必须携带当前的租约世代',
          '由控制台重新签发租约后再写入',
        );
      }
      if (!Number.isSafeInteger(currentGeneration) || input.leaseGeneration !== currentGeneration) {
        throw refuse(
          'lease_generation_stale',
          `便签来自旧租约世代（请求 ${String(input.leaseGeneration)}，当前 ${String(currentGeneration)}）`,
          '丢弃本轮的滞后便签，等待当前 Worker 重新写入',
        );
      }
      await tx.query(
        `UPDATE pentest.worker_sessions
            SET status_note = $1, status_note_at = $2, status_note_source = 'agent'
          WHERE id = $3::uuid`,
        [text, now, input.workerSessionId],
      );

      if (this.#ledger !== undefined) {
        // 与 `submitReport` 同形：领域事件与状态写入同一事务，写不进去就整体回滚。
        // `sourceId` 带时间戳而不是纯会话标识：便签是**逐轮**的，同一会话会写很多次，
        // 用固定幂等键会让第二次写入被账本当成重放而静默不留痕。
        const payload = { note: text, noteAt: now.toISOString(), source: 'agent' as const };
        await this.#ledger.appendBatchInTransaction(tx, [
          {
            engagementId: session.engagement_id,
            workerSessionId: input.workerSessionId,
            eventType: 'worker.status_note',
            sourceSystem: 'pentest-worker',
            sourceId: `worker.status_note:${input.workerSessionId}:${String(now.getTime())}`,
            sourceSeq: 1,
            occurredAt: now,
            payload,
            rawPayload: new TextEncoder().encode(JSON.stringify(payload)),
            classification: 'engagement',
            trustLevel: 'agent_claim',
          },
        ]);
      }
      return true;
    });

    // 报告提交路径负责摘要兜底并标注 `derived`；独立便签工具始终是 Agent 来源。
    return { stored, source: 'agent' };
  }

  // ── 6. 申请放行（§10.3 / §10.3.1） ──

  async requestApproval(
    input: Parameters<WorkerToolDeps['requestApproval']>[0],
  ): Promise<{ approvalId: string; planHash: string; expiresAt: string; selfApproved?: boolean }> {
    // 会话标识以本方法收到的为准，不信 intent 里的副本（服务端权威绑定）。
    const intent: ActionIntent = { ...input.intent, workerSessionId: input.workerSessionId };
    // **一次只允许一条待处理申请**（2026-10-05 人类要求）：Agent 会连着提好几条，
    // 而人一次只能认真看一条命令——多条并排出现时他只会批其中一条，其余全悬着。
    // 判据放在 admit **之前**：admit 会真的建凭证，建完再拦就晚了。
    const pending = await this.#db.query<{
      id: string;
      display_command: string | null;
      expires_at: Date | string | null;
    }>(
      `select a.id, a.command_plan->>'display_command' as display_command, a.expires_at
         from pentest.approvals a
        where a.requested_by_worker = $1::uuid
          and a.decision = 'pending'
          and a.consumed_at is null
          and a.expires_at > now()
        order by a.created_at
        limit 1`,
      [input.workerSessionId],
    );
    const pendingRow = pending.rows[0];
    if (pendingRow !== undefined) {
      throw refuse(
        'approval_required',
        `本会话已有一条待人类处理的放行申请（approval_id=${pendingRow.id}，` +
          `命令：${(pendingRow.display_command ?? '').slice(0, 120)}）。一次只提一条：等人类处理完再提下一个。`,
        '等待控制台处理那条申请；不要重复提交，也不要在它之前再提别的命令',
      );
    }
    const decision = await this.#executor.admit(intent);
    if (decision.kind === 'rejected') throw new PgWorkerToolRefusal(decision.error);
    if (decision.kind === 'self_approved') {
      // 高权限模式：服务端已自行放行。凭证照常返回，但明确告诉 Agent「不必等人类」。
      const selfResult = await this.#db.query<{ expires_at: Date | string | null }>(
        `SELECT expires_at FROM pentest.approvals WHERE id = $1::uuid`,
        [decision.approvalId],
      );
      const selfExpiresAt = selfResult.rows[0]?.expires_at ?? null;
      if (selfExpiresAt === null) {
        throw refuse(
          'audit_unavailable',
          `放行记录 ${decision.approvalId} 尚未落库，无法给出有效期，拒绝返回不可投递的凭证`,
          '不要重试同一申请；由人类确认放行队列与审计写入的可用性',
        );
      }
      return {
        approvalId: decision.approvalId,
        planHash: decision.planHash,
        expiresAt: toIso(selfExpiresAt),
        selfApproved: true,
      };
    }
    if (decision.kind === 'admitted') {
      throw refuse(
        'classification_rejected',
        '该动作不需要人工放行，无需申请',
        '直接调用 pentest_exec；只有逐次放行类别的动作才需要 approval_id',
      );
    }

    // 有效期以落库的放行记录为准（执行服务在 admit 里写入 approvals.expires_at）：
    // 这里不重算 TTL，避免出现第二份有效期约定。
    const result = await this.#db.query<{ expires_at: Date | string | null }>(
      `SELECT expires_at FROM pentest.approvals WHERE id = $1::uuid`,
      [decision.approvalId],
    );
    const expiresAt = result.rows[0]?.expires_at ?? null;
    if (expiresAt === null) {
      throw refuse(
        'audit_unavailable',
        `放行记录 ${decision.approvalId} 尚未落库，无法给出有效期，拒绝返回不可投递的凭证`,
        '不要重试同一申请；由人类确认放行队列与审计写入的可用性',
      );
    }
    return {
      approvalId: decision.approvalId,
      planHash: decision.planHash,
      expiresAt: toIso(expiresAt),
    };
  }

  // ── 审计与事务 ──

  /** 读取审计（§9.2 memory_access_log）：读取类操作的落点，写不进去就不返回内容。 */
  async #auditAccess(
    workerSessionId: string,
    engagementId: string,
    accessKind: string,
    subjectRefs: readonly string[],
    requested: number,
  ): Promise<void> {
    await this.#queryWithRlsContext(
      workerSessionId,
      engagementId,
      `INSERT INTO pentest.memory_access_log
         (engagement_id, worker_session_id, access_kind, subject_refs, reason)
       VALUES ($1::uuid, $2::uuid, $3, $4::uuid[], $5)`,
      [engagementId, workerSessionId, accessKind, subjectRefs, `requested=${requested}`],
    );
  }

  /**
   * 事务边界：提交/回滚只包住写路径，异常不吞。
   * 与 `MemoryLedger` 的同名私有方法同形；`txDb` 必须是同一条连接（见文件头注释）。
   */
  async #withTransaction<T>(workerSessionId: string, run: (tx: DbClient) => Promise<T>): Promise<T> {
    return this.#txRunner.run(run, async (tx) => {
      await this.#withSessionRlsContext(tx, workerSessionId);
    });
  }
}

/**
 * `worker.report` 的账本载荷。
 *
 * 形状不是自由选择——分块器按它取内容（`chunks.ts` 的 `chunkReport`）：
 *   - 顶层 `summary`：报告摘要分段；
 *   - `payload`：设计 §13.4 的报告正文（`facts`/`hypotheses`/`candidate_findings`/…），
 *     分块器会拆信封读它。
 *
 * 改这里的字段名等于改检索面。**导出**是为了让契约测试用写入侧的同一个函数，
 * 而不是在测试里手抄一份形状（QA 2026-10-04：测试手抄的载荷与生产写入侧不一致，
 * 于是「事实不进检索面」这类漂移在 1511 个用例全绿的情况下发生了）。
 */
export function workerReportEventPayload(input: {
  readonly reportId: string;
  readonly report: WorkerReportInput;
}): Readonly<Record<string, unknown>> {
  return {
    reportId: input.reportId,
    status: input.report.status,
    objective: input.report.objective,
    summary: input.report.summary,
    payload: input.report.payload ?? {},
  };
}
