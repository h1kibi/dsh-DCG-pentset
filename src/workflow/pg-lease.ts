/**
 * 会话租约存储的 PostgreSQL 装配层（设计文档 §10.6；表结构 §9.2；结算触发器 §9.5）。
 *
 * 分工：`lease.ts` 是端口与纯判定（准入顺序、吊销理由取值域、世代推进、TTL 计算），
 * 本文件只做 SQL 装配与行映射，不重复任何一条判定——规则写两遍必然漂移。
 *
 * 与真实库强相关的四条约定：
 *   1. **串行化点在 `pentest.worker_sessions` 行上**（`SELECT ... FOR UPDATE`），不在租约行上。
 *      新会话首次签发时 `session_leases` 里还没有行可锁，而"同一会话的签发与吊销必须串行"
 *      需要一个在该会话整个生命周期内都存在的锁对象——会话行是唯一符合条件的落点
 *      （`worker_sessions` 是一行一会话，签发与吊销都必然触及它）。
 *   2. **不把唯一冲突改写成 `ON CONFLICT`**：`session_leases_one_active`
 *      （部分唯一索引，`WHERE revoked_at IS NULL`）是并发签发的最终防线；
 *      `ON CONFLICT DO NOTHING` 会把"并发签发被拦"静默变成"没签发"，
 *      调用方拿到的返回值就与库里的事实不符了。
 *   3. **一个事务 = 一条连接**：`BEGIN`/`COMMIT` 只对同一条连接有效。因此本类识别连接池
 *      （`pg.Pool`）并借出连接；已借出的 `PoolClient`、专用 `pg.Client` 直接使用
 *      （与 `ledger.ts` 的 `txDb` 约定一致：事务客户端由调用方保证是专用连接）。
 *   4. **RLS**（§9.4）：`session_leases` 与 `worker_sessions` 都 FORCE ROW LEVEL SECURITY，
 *      非所有者运行时角色（`pentest_app`）在未设 `pentest.engagement_id` 时看不见任何行。
 *      可选注入 `rlsContext`：给定后每个事务在 `BEGIN` 之后调用 `pentest.set_rls_context`，
 *      使读写落在正确 engagement 上；省略则不设置（超级用户/迁移连接本就绕过 RLS）。
 *      作业上下文来自事务的**显式作用域**（`workerSessionId` 反查，或直接给 `engagementId`）——
 *      没有作用域时不再从闭包源码里猜（见 `transaction`）。
 */

import type { LeaseRevocationReason, SessionLease } from '../contracts.ts';
import type { DbClient } from '../db/port.ts';
import type { LeaseLifecycleEvent } from './lease.ts';
import {
  LeaseProtocolError,
  isLeaseRevocationReason,
  type ExpiredLeaseRef,
  type LeaseStore,
  type LeaseTransactionScope,
  type LeaseTx,
  type NewLeaseRow,
  type RevokeActiveLeasesInput,
  type WorkerSessionRow,
} from './lease.ts';

// ───────────────────────────── SQL ─────────────────────────────
//
// 列名与 001_init.sql 逐字一致、不做别名缩写：出问题时能直接与 DDL 对照。

/**
 * §10.6 的串行化点：取 `worker_sessions` 的行锁。
 * 签发（issueLease / reissueLease）与吊销都先走它，因此"同一会话的并发签发"被排队，
 * 后到者会在拿到锁之后看到前者的未吊销租约，得到明确的协议错误而不是唯一索引异常。
 */
const SQL_LOCK_WORKER_SESSION = `
select id, engagement_id
  from pentest.worker_sessions
 where id = $1
   for update`;

/**
 * 未吊销的最新租约（`session_leases_one_active` 保证至多一行，§9.3）。
 * 判定顺序（世代 → 吊销 → 跨任务 → 到期）由 `lease.ts` 负责，这里只按端口语义取行。
 */
const SQL_SELECT_ACTIVE_LEASE = `
select id, worker_session_id, task_ref, generation, expires_at, revoked_at, revoked_reason
  from pentest.session_leases
 where worker_session_id = $1
   and revoked_at is null`;

/** 指定世代的租约行，含已吊销的（滞后提交要按行判定，§10.6）。 */
const SQL_SELECT_LEASE = `
select id, worker_session_id, task_ref, generation, expires_at, revoked_at, revoked_reason
  from pentest.session_leases
 where worker_session_id = $1
   and generation = $2`;

/** 已签发过的最大世代（§10.6 世代号随复用递增）；无租约时 coalesce 给 0。 */
const SQL_MAX_GENERATION = `
select coalesce(max(generation), 0) as generation
  from pentest.session_leases
 where worker_session_id = $1`;

/**
 * 签发一行；`revoked_at` / `revoked_reason` 留空（未吊销）。
 * 冲突（`session_leases_one_active` 或 `UNIQUE (worker_session_id, generation)`）必须原样抛出，
 * 见文件头第 2 条。
 */
const SQL_INSERT_LEASE = `
insert into pentest.session_leases
       (id, engagement_id, worker_session_id, task_ref, generation,
        issued_at, expires_at, last_heartbeat_at)
values ($1, $2, $3, $4, $5, $6, $7, $8)`;

/**
 * 吊销当前生效租约，返回被吊销的 id 列表（调用方据此做审计，§10.6）。
 * 只动 `revoked_at is null` 的行，且 `revoked_reason` 与 `revoked_at` 成对写入
 * —— 002 的 `session_leases_settlement` 触发器要求二者成对。
 *
 * `expectGeneration` 用「$4 为空即不设限」单条语句表达，不做条件拼串：
 * 拼串要保证子句落在 WHERE 与 RETURNING 之间，写错位置会得到
 * `returning id and generation = $4` 这种把 uuid 当布尔用的荒唐错误；
 * 单条语句只有一种绑定顺序，参数错位同样不可能发生。
 */
const SQL_REVOKE_ACTIVE_LEASES = `
update pentest.session_leases
   set revoked_at = $2,
       revoked_reason = $3
 where worker_session_id = $1
   and revoked_at is null
   and ($4::integer is null or generation = $4)
returning id`;

/**
 * 到期清扫（§10.6）：`expires_at <= $1 AND revoked_at IS NULL`（闭区间，恰好到期即失效）。
 * 理由**由端口固定写入 `'expired'`**，不接受调用方传入：过期（会话失联）与有意替换
 * （`superseded`）在审计上是两件事。写成字面量而非参数，使"不接受的传入"在 SQL 层就不可表达。
 * 扫描走 `session_leases_expiry` 局部索引。
 */
const SQL_REVOKE_EXPIRED_LEASES = `
update pentest.session_leases
   set revoked_at = $1,
       revoked_reason = 'expired'
 where revoked_at is null
   and expires_at <= $1
returning id, worker_session_id, expires_at`;

/**
 * 心跳续租（§10.6）：只前推 `expires_at` 与 `last_heartbeat_at`。
 * 不触碰冻结列（`issued_at` 等），002 的触发器会拒绝任何回退。
 */
const SQL_TOUCH_HEARTBEAT = `
update pentest.session_leases
   set expires_at = $2,
       last_heartbeat_at = $3
 where id = $1
   and revoked_at is null
returning id`;

// ───────────────────────────── 连接借还 ─────────────────────────────

/** 从池里借出的连接：用完必须归还（`pg.PoolClient`）。 */
interface PooledClient extends DbClient {
  release?(error?: unknown): void;
}

/**
 * 连接池（`pg.Pool`）。
 * 判别必须同时看 `connect`、`totalCount` 与"没有 `release`"：
 * `pg.PoolClient` 与 `pg.Client` 也都有 `connect`（前者还带 `release`），
 * 把已连接的客户端误判成池会去再连一次并抛错；把池误判成客户端则**静默失去原子性**。
 */
interface ConnectionPool extends DbClient {
  connect(): Promise<PooledClient>;
  readonly totalCount?: number;
  readonly release?: unknown;
}

function isConnectionPool(db: DbClient): db is ConnectionPool {
  const candidate = db as ConnectionPool;
  return (
    typeof candidate.connect === 'function' &&
    typeof candidate.release !== 'function' &&
    typeof candidate.totalCount === 'number'
  );
}

// ───────────────────────────── 行映射 ─────────────────────────────

interface LeaseRow {
  readonly id: string;
  readonly worker_session_id: string;
  readonly task_ref: string | null;
  readonly generation: number | string;
  readonly expires_at: Date | string;
  readonly revoked_at: Date | string | null;
  readonly revoked_reason: string | null;
}

interface WorkerSessionKeyRow {
  readonly id: string;
  readonly engagement_id: string;
}

/**
 * 会话 id 是 `uuid` 列（001）：非 uuid 串喂给 PostgreSQL 会得到 22P02
 * `invalid input syntax for type uuid`，把模型可控的入参变成穿透到工具层的内部异常。
 * 格式非法与"库里没有这一行"在语义上是同一件事——都不可能有行被命中，
 * 因此按"会话不存在"处理，让调用方（如 `issueLease`）走既有路径。
 */
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function toDate(value: Date | string, column: string): Date {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new LeaseProtocolError(
      `session_leases.${column} 不是可解析的时间戳：${String(value)}；数据被越权改写或驱动行为异常`,
      { operation: 'lease_store' },
    );
  }
  return date;
}

function toGeneration(value: number | string): number {
  const generation = typeof value === 'number' ? value : Number(value);
  if (!Number.isInteger(generation) || generation < 1) {
    throw new LeaseProtocolError(
      `session_leases.generation 越出契约范围（应为 >=1 的整数）：${String(value)}`,
      { operation: 'lease_store' },
    );
  }
  return generation;
}

function toRevocationReason(value: string | null): LeaseRevocationReason | null {
  if (value === null) return null;
  if (!isLeaseRevocationReason(value)) {
    // 取值域由 001 的 CHECK 保证；走到这里说明库被绕过约束改写，必须响亮失败
    throw new LeaseProtocolError(
      `session_leases.revoked_reason 越出契约取值域：${value}；CHECK 约束应已拦住它`,
      { operation: 'lease_store' },
    );
  }
  return value;
}

function toLease(row: LeaseRow): SessionLease {
  return {
    id: row.id,
    workerSessionId: row.worker_session_id,
    taskRef: row.task_ref,
    generation: toGeneration(row.generation),
    expiresAt: toDate(row.expires_at, 'expires_at'),
    revokedAt: row.revoked_at === null ? null : toDate(row.revoked_at, 'revoked_at'),
    revokedReason: toRevocationReason(row.revoked_reason),
  };
}

// ───────────────────────────── 事务内端口实现 ─────────────────────────────

/**
 * 绑定到**单条连接**的 `LeaseTx`：所有语句都跑在 `PgLeaseStore.transaction` 开的事务里。
 * 不持有连接的所有权——借还由 `PgLeaseStore.transaction` 统一负责。
 */
class PgLeaseTx implements LeaseTx {
  readonly #db: DbClient;

  constructor(db: DbClient) {
    this.#db = db;
  }

  get db(): DbClient {
    return this.#db;
  }

  /**
   * `SELECT ... FOR UPDATE` 锁会话行（§10.6）。
   *
   * 返回的 `taskRef` 恒为 **null**：会话行不携带任务引用——真实 schema 里没有这一列，
   * 且 `task_prompt`（每轮冻结的提示词，是内容不是标识）、`handoff_id`（只存在于有交接的轮次）、
   * `transition_id`（重做轮次可能为空）三者都不是任务标识，硬塞任何一个都会凭空造出语义
   * （比如没有交接的首轮会话与有交接的会话会得到不同的提权判定，而这两者本该等价）。
   * 跨任务提权防护要求调用方显式传入 `taskRef`（写进 `session_leases.task_ref`，该列存在）。
   */
  async lockWorkerSession(workerSessionId: string): Promise<WorkerSessionRow | null> {
    if (!UUID_PATTERN.test(workerSessionId)) return null;
    const result = await this.#db.query<WorkerSessionKeyRow>(SQL_LOCK_WORKER_SESSION, [
      workerSessionId,
    ]);
    const row = result.rows[0];
    if (row === undefined) return null;
    return { id: row.id, engagementId: row.engagement_id, taskRef: null };
  }

  async selectActiveLease(workerSessionId: string): Promise<SessionLease | null> {
    if (!UUID_PATTERN.test(workerSessionId)) return null;
    const result = await this.#db.query<LeaseRow>(SQL_SELECT_ACTIVE_LEASE, [workerSessionId]);
    const row = result.rows[0];
    return row === undefined ? null : toLease(row);
  }

  async selectLease(workerSessionId: string, generation: number): Promise<SessionLease | null> {
    if (!UUID_PATTERN.test(workerSessionId)) return null;
    const result = await this.#db.query<LeaseRow>(SQL_SELECT_LEASE, [workerSessionId, generation]);
    const row = result.rows[0];
    return row === undefined ? null : toLease(row);
  }

  async maxGeneration(workerSessionId: string): Promise<number> {
    if (!UUID_PATTERN.test(workerSessionId)) return 0;
    const result = await this.#db.query<{ generation: number | string }>(SQL_MAX_GENERATION, [
      workerSessionId,
    ]);
    const row = result.rows[0];
    // coalesce 保证无租约时是 0（世代号从 1 起，0 表示"从未签发"）
    const generation = row === undefined ? 0 : Number(row.generation);
    if (!Number.isInteger(generation) || generation < 0) {
      throw new LeaseProtocolError(
        `session_leases.generation 越出契约范围（应为 >=0 的整数）：${String(row?.generation)}`,
        { operation: 'lease_store' },
      );
    }
    return generation;
  }

  async insertLease(row: NewLeaseRow): Promise<void> {
    await this.#db.query(SQL_INSERT_LEASE, [
      row.id,
      row.engagementId,
      row.workerSessionId,
      row.taskRef,
      row.generation,
      row.issuedAt,
      row.expiresAt,
      row.lastHeartbeatAt,
    ]);
  }

  async revokeActiveLeases(input: RevokeActiveLeasesInput): Promise<readonly string[]> {
    // 取值域校验（§10.6：superseded / closed / failed / human_revoke / expired，**无**
    // budget_exhausted——暂停保留租约）。在发 SQL 之前拒绝，因为这属于调用方的协议错误，
    // 库里没有任何行该被触碰；数据库一侧的 CHECK 是第二道闸。
    if (!isLeaseRevocationReason(input.reason)) {
      throw new LeaseProtocolError(
        `非法吊销理由：${String(input.reason)}；§10.6 的取值域为 superseded/closed/failed/human_revoke/expired（暂停不吊销，故无 budget_exhausted）`,
        { operation: 'revoke_active_leases', workerSessionId: input.workerSessionId },
      );
    }
    const result = await this.#db.query<{ id: string }>(SQL_REVOKE_ACTIVE_LEASES, [
      input.workerSessionId,
      input.revokedAt,
      input.reason,
      input.expectGeneration ?? null,
    ]);
    return result.rows.map((r) => r.id);
  }

  async revokeExpiredLeases(now: Date): Promise<readonly ExpiredLeaseRef[]> {
    const result = await this.#db.query<{ id: string; worker_session_id: string; expires_at: Date | string }>(
      SQL_REVOKE_EXPIRED_LEASES,
      [now],
    );
    return result.rows.map((row) => ({
      leaseId: row.id,
      workerSessionId: row.worker_session_id,
      expiresAt: new Date(row.expires_at),
    }));
  }

  async touchHeartbeat(input: {
    readonly leaseId: string;
    readonly expiresAt: Date;
    readonly heartbeatAt: Date;
  }): Promise<void> {
    const result = await this.#db.query<{ id: string }>(SQL_TOUCH_HEARTBEAT, [
      input.leaseId,
      input.expiresAt,
      input.heartbeatAt,
    ]);
    if (result.rows.length !== 1) {
      // 走到这里意味着"刚通过准入的租约"在本次事务的 SELECT 与 UPDATE 之间被吊销了，
      // 或者 leaseId 根本不存在。两种情况都不能假装续租成功——那会让调用方持有
      // 一个库里并不成立的到期时间。
      throw new LeaseProtocolError(
        `心跳续租未命中任何行：租约 ${input.leaseId} 不存在或已被吊销；续租不能凭空成立`,
        { operation: 'touch_heartbeat' },
      );
    }
  }
}

// ───────────────────────────── 存储 ─────────────────────────────

/**
 * §9.4 的事务上下文：RLS 策略据此过滤行（`pentest.set_rls_context`）。
 *
 * `engagementId` 为 `null` 表示**租户级**作用域（`listEngagements` 这类只按租户
 * 定界的操作）。engagement 作用域的读写在租户级下查不到行，是 fail closed。
 */
interface PgLeaseRlsContext {
  readonly tenantId: string;
  readonly engagementId: string | null;
}

interface PgLeaseStoreOptions {
  /** 静态 RLS 事务上下文；session-first 调用可通过 `rlsContextForSession` 动态解析。 */
  readonly rlsContext?: PgLeaseRlsContext;
  readonly rlsContextForSession?: (workerSessionId: string) => Promise<PgLeaseRlsContext | null>;
  /** 生命周期事件的账本归属；未配置则不写事件。 */
  readonly auditEngagementId?: string;
  readonly auditLifecycle?: (tx: DbClient, event: LeaseLifecycleEvent, engagementId: string) => Promise<void>;
}

const SQL_SET_RLS_CONTEXT = 'select pentest.set_rls_context($1, $2::uuid, null)';

/**
 * `LeaseStore` 的 PostgreSQL 实现：一个事务 = 一条连接，`BEGIN`/`COMMIT`/`ROLLBACK` 显式控制。
 */
export class PgLeaseStore implements LeaseStore {
  readonly #db: DbClient;
  readonly #pool: ConnectionPool | null;
  readonly #rlsContext: PgLeaseRlsContext | null;
  readonly #rlsContextForSession: PgLeaseStoreOptions['rlsContextForSession'];
  readonly #auditEngagementId: string | null;
  readonly #auditLifecycle: PgLeaseStoreOptions['auditLifecycle'];

  constructor(db: DbClient, options: PgLeaseStoreOptions = {}) {
    this.#db = db;
    this.#pool = isConnectionPool(db) ? db : null;
    this.#rlsContext = options.rlsContext ?? null;
    this.#rlsContextForSession = options.rlsContextForSession;
    this.#auditEngagementId = options.auditEngagementId ?? null;
    this.#auditLifecycle = options.auditLifecycle;
  }

  get onLifecycleInTransaction(): LeaseStore['onLifecycleInTransaction'] {
    if (this.#auditLifecycle === undefined || this.#auditEngagementId === null) return undefined;
    return async (tx, event) => {
      const db = (tx as LeaseTx).db;
      if (db === undefined) throw new Error('PgLeaseStore 生命周期审计需要事务连接');
      await this.#auditLifecycle!(db, event, this.#auditEngagementId!);
    };
  }
  /** 借出一条连接；`release` 只在连接是**本类借出的**时候才需要调用（归还给池）。 */
  async #acquire(): Promise<{ client: DbClient; release: (error?: unknown) => void }> {
    if (this.#pool === null) return { client: this.#db, release: () => {} };
    const client = await this.#pool.connect();
    return {
      client,
      release: (error?: unknown) => {
        if (client.release === undefined) return;
        // 事务以异常收尾时把错误交给池：pg 会销毁这条连接，而不是把状态可疑的连接
        // 放回池里给下一个借出者
        client.release(error);
      },
    };
  }

  /**
   * 在租约事务里执行 `work`。
   *
   * ── 作用域为什么必须显式给 ──
   *
   * RLS 上下文是**事务级**的，而 `session_leases` / `worker_sessions` 没有租户级放行。
   * 因此事务开始前就得知道「这是哪个会话/作业」，才能把上下文设到正确的作用域上。
   * （历史：曾从回调的**闭包源码文本**里正则捞会话 id。那在把 id 放在变量里的调用上
   * 恒失败，于是回落到静态租户级上下文——多作业部署下表现为「工作会话不存在」，
   * 在过期清扫上表现为 UPDATE 影响 0 行且不报错。源码解析不是契约，已删除。）
   */
  async transaction<T>(work: (tx: LeaseTx) => Promise<T>, scope?: string | LeaseTransactionScope): Promise<T> {
    const { client, release } = await this.#acquire();
    let failure: unknown = null;
    try {
      await client.query('begin');
      const context = await this.#resolveRlsContext(scope);
      if (context !== null && context !== undefined) {
        await client.query(SQL_SET_RLS_CONTEXT, [context.tenantId, context.engagementId]);
      }
      const result = await work(new PgLeaseTx(client));
      await client.query('commit');
      return result;
    } catch (error: unknown) {
      failure = error;
      await client.query('rollback').catch(() => undefined);
      throw error;
    } finally {
      release(failure);
    }
  }

  /**
   * 作用域 → RLS 上下文（§9.4）。
   *
   * 优先级：显式会话（逐会话反查所属作业）→ 显式作业（静态租户 + 该作业）
   * → 静态上下文。配置了逐会话反查却两个作用域都没给，说明调用点漏了作用域——
   * **响亮失败**，而不是落回租户级让 FORCE RLS 把一切静默挡成 0 行。
   */
  async #resolveRlsContext(
    scope: string | LeaseTransactionScope | undefined,
  ): Promise<PgLeaseRlsContext | null | undefined> {
    const normalized: LeaseTransactionScope =
      typeof scope === 'string' ? { workerSessionId: scope } : scope ?? {};
    if (normalized.workerSessionId !== undefined && this.#rlsContextForSession !== undefined) {
      const resolved = await this.#rlsContextForSession(normalized.workerSessionId);
      // 会话不存在 → 退回静态租户级上下文：显式把作业维度设成 NULL，
      // 而不是沿用连接上可能残留的旧作业上下文。
      return resolved ?? this.#rlsContext;
    }
    if (normalized.engagementId !== undefined) {
      return this.#rlsContext === null
        ? null
        : { tenantId: this.#rlsContext.tenantId, engagementId: normalized.engagementId };
    }
    if (this.#rlsContextForSession !== undefined) {
      throw new LeaseProtocolError(
        '租约事务缺少 RLS 作用域：必须给出 workerSessionId 或 engagementId（§9.4）',
        { operation: 'lease_store_transaction' },
      );
    }
    return this.#rlsContext;
  }
}
