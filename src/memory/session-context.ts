/**
 * Worker 会话上下文（设计文档 §8.7；2026-10-05 复核 C3 的落点）。
 *
 * ── 这个模块存在的理由 ──
 *
 * 「会话准入 + 范围集合 + RLS 上下文 + 事务」这四件事此前散在 `PgWorkerTools` 的私有方法里
 * （`#session` / `#scopeSets` / `#withSessionRlsContext` / `#queryWithRlsContext` /
 * `#withTransaction`），而范围集合的解析逻辑在 `pg-memory-query.ts` 里**还有第二份**
 * （两张表的读 + 行映射 + 判定，各写一遍）。后果不是「代码多一点」，而是：
 *
 *   - 租约语义（到期/吊销/存活状态的判定顺序与豁免）只有读过那一处的人知道，
 *     改动时容易只改一边（`allowExpiredLease` 的豁免就被评审抓到过一次「半修」）；
 *   - 范围解析的两份实现会漂移，而范围是安全边界——漂移即越权或漏读。
 *
 * 现在两处都走这里：`enterWorkerSession()` 是唯一入口，返回
 * `{ engagementId, session, scopeSets, query(), withTx() }`——
 * **拿不到会话就什么都拿不到**，因此不存在「忘了过租约就读」的路径。
 *
 * ── 版本口径的差别是**刻意的**（不要合并）──
 *
 * | 调用方 | 用哪个范围版本 | 依据 |
 * |---|---|---|
 * | Worker 工具（检索/读取/提交） | 会话**冻结**的 `scope_version` | §8.6：Agent 只能看它被授权时的那条边界 |
 * | 控制台查询（`pg-memory-query`） | 当前生效版本（`max(version)`） | §5.4：人类看到的是**现在**的边界 |
 *
 * 本模块提供 `scopeSetsForVersion(db, engagementId, version)` 与 `currentScopeVersion(db, engagementId)`
 * 两个原语，让调用方各自选口径——**共用机制，不共用策略**。
 */

import type { DbClient } from './ledger.ts';
import { LIVE_SESSION_STATUSES, SCOPE_DECISIONS, type ScopeDecision } from '../contracts.ts';
import { resolveScopeSets, type ScopeSets } from './retrieval.ts';

// ── 行取值收窄（与本仓既有约定一致：`indexer.ts` 的 `toSafeSeq`、`pg-memory-query.ts`
// 的 `toSafeCount`/`narrow` 是同形的本地副本；这三个模块都直接读库列，各自保留一份，
// 避免为一个 10 行函数引入新的共享层。语义必须一致：**响亮拒绝**非法值。）──

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
 * 枚举列的运行时窄化：库里的 `decision` 是 text 列，取值域由写入侧保证，
 * 这里**响亮拒绝**非法值——绝不落到「最宽松的那个」（那会把一条脏数据当成已纳入放行）。
 */
function narrow<T extends string>(value: string, allowed: readonly T[], what: string): T {
  if (!(allowed as readonly string[]).includes(value)) {
    throw new Error(`${what} 取值非法：${value}`);
  }
  return value as T;
}

/** 带 RLS 上下文的查询能力（`compose` 的运行时连接包装提供；单测里可缺省）。 */
interface RlsAwareDbClient {
  queryWithRlsContext<Row>(
    context: {
      readonly tenantId: string;
      readonly engagementId: string | null;
      readonly workerSessionId: string | null;
    },
    sql: string,
    params?: readonly unknown[],
  ): Promise<{ readonly rows: readonly Row[] }>;
}

/**
 * 会话行：读取路径与提交路径都从它取身份与冻结版本。
 *
 * 字段类型与工具层原本的私有声明**逐字一致**（`phase` 可空、`session_kind` 是两个字面量、
 * `state_version` 可能是字符串 bigint）——搬进本模块时不许「顺手加严」，那会改变
 * 工具方法的类型判定（例如 `session_kind === 'intake'` 的分支）。
 */
export interface SessionRow {
  readonly engagement_id: string;
  readonly scope_version: number;
  readonly phase: string | null;
  readonly status: string;
  readonly session_kind: 'intake' | 'phase';
  readonly attempt: number;
  readonly iteration: number;
  readonly state_version: number | string;
}

/** 存活会话状态（与数据库存活索引同源；来自契约，不在本地重写过滤）。 */
const LIVE_STATUSES: readonly string[] = LIVE_SESSION_STATUSES;

export interface SessionContextDeps {
  readonly db: DbClient;
  /** `compose` 注入的租户上下文；缺省＝不设 RLS（单测与只读装配）。 */
  readonly rlsContext?: { readonly tenantId: string };
  /** dsh 会话 → 作业的反查（受租户约束的 SECURITY DEFINER 函数，见 016）。 */
  readonly resolveRlsEngagement?: (workerSessionId: string) => Promise<string | null>;
  /**
   * 拒绝的构造方式。工具层注入它自己的拒绝类型（`PgWorkerToolRefusal`），
   * 于是准入失败在调用方眼里仍是**同一种错误**，不必在工具层再翻译一层；
   * 缺省时用本模块的 `SessionContextRefusal`（单测与只读装配）。
   */
  readonly refuse?: (code: string, message: string, nextAction: string) => Error;
  /** 事务运行器（串行化独占写连接）。缺省时 `withTx` 直接用 `db`。 */
  readonly txRunner?: {
    run<T>(work: (tx: DbClient) => Promise<T>, before?: (tx: DbClient) => Promise<void>): Promise<T>;
  };
}

/** 会话准入的拒绝：与工具层同形的稳定码 + 可执行处置。 */
export class SessionContextRefusal extends Error {
  readonly code: string;
  readonly nextAction: string;

  constructor(code: string, message: string, nextAction: string) {
    super(message);
    this.name = 'SessionContextRefusal';
    this.code = code;
    this.nextAction = nextAction;
  }
}

/** 抛出一次拒绝：走调用方注入的构造方式（见 `SessionContextDeps.refuse`）。 */
function fail(
  deps: SessionContextDeps,
  code: string,
  message: string,
  nextAction: string,
): never {
  throw deps.refuse === undefined
    ? new SessionContextRefusal(code, message, nextAction)
    : deps.refuse(code, message, nextAction);
}

/**
 * 解析会话所属作业（§8.7：engagement 由服务端从当前会话解析，**不接受调用方传值**）。
 *
 * 未配置 RLS 时返回空串（裸查询路径；调用方随后自行取 `session.engagement_id`）。
 */
export async function resolveEngagementForSession(
  deps: SessionContextDeps,
  workerSessionId: string,
): Promise<string> {
  if (deps.rlsContext === undefined) return '';
  const resolved = deps.resolveRlsEngagement === undefined
    ? null
    : await deps.resolveRlsEngagement(workerSessionId);
  if (deps.resolveRlsEngagement !== undefined && resolved === null) {
    fail(
      deps,
      'lease_required',
      `会话 ${workerSessionId} 不属于当前租户或不存在，拒绝建立 RLS 上下文`,
      '由当前控制台创建并签发租约的 Worker 会话调用工具',
    );
  }
  // 此前这里会回退到 `rlsContext.engagementId`（进程级的那个）。多作业下它已不存在，
  // 而且那个回退本身就是错的：会话解析不出作业时，拿别的作业的上下文继续读，
  // 会把「这个会话不属于任何作业」伪装成正常结果。宁可拒绝。
  if (resolved === null) {
    fail(
      deps,
      'lease_required',
      `会话 ${workerSessionId} 没有可解析的 engagement，拒绝建立 RLS 上下文`,
      '由控制台创建 Worker 会话并签发租约后再调用',
    );
  }
  return resolved;
}

/** 在会话所属作业的 RLS 上下文里查（读路径的默认通道）。 */
export async function queryWithRlsContext<Row = Record<string, unknown>>(
  deps: SessionContextDeps,
  workerSessionId: string,
  engagementId: string,
  sql: string,
  params?: readonly unknown[],
): Promise<{ readonly rows: readonly Row[] }> {
  const rlsDb = deps.db as Partial<RlsAwareDbClient>;
  if (deps.rlsContext !== undefined && typeof rlsDb.queryWithRlsContext === 'function') {
    return rlsDb.queryWithRlsContext<Row>(
      { tenantId: deps.rlsContext.tenantId, engagementId, workerSessionId },
      sql,
      params,
    );
  }
  return deps.db.query<Row>(sql, params);
}

/** 在事务连接上设出该会话的 RLS 上下文（写路径的入口）。 */
export async function withSessionRlsContext(
  deps: SessionContextDeps,
  tx: DbClient,
  workerSessionId: string,
): Promise<void> {
  if (deps.rlsContext === undefined) return;
  const engagementId = await resolveEngagementForSession(deps, workerSessionId);
  await tx.query('select pentest.set_rls_context($1, $2::uuid, $3::uuid)', [
    deps.rlsContext.tenantId,
    engagementId,
    workerSessionId,
  ]);
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
export async function admitWorkerSession(
  deps: SessionContextDeps,
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
  const engagementId = await resolveEngagementForSession(deps, workerSessionId);
  const result = await queryWithRlsContext<
    SessionRow & {
      readonly lease_generation: number | string | null;
      readonly lease_expired: boolean | null;
      readonly lease_revoked_reason: string | null;
    }
  >(
    deps,
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
    fail(
      deps,
      'lease_required',
      `会话 ${workerSessionId} 不存在或没有 engagement 绑定，无法确定检索与提交范围`,
      '由控制台创建 Worker 会话并签发租约后再调用',
    );
  }
  if (row.lease_generation === null) {
    fail(
      deps,
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
      fail(
        deps,
        'lease_expired',
        `会话 ${workerSessionId} 的租约已到期，读取被拒绝`,
        '由控制台重新签发租约后再调用；到期未续的租约不会自动复活',
      );
    }
  }
  // 非到期的吊销（superseded / closed / failed / human_revoke）一律拒绝，豁免不覆盖它们。
  if (row.lease_revoked_reason !== null && !leaseExpired) {
    fail(
      deps,
      'lease_revoked',
      `会话 ${workerSessionId} 的租约已被吊销（${row.lease_revoked_reason}），读取被拒绝`,
      '由控制台重新签发租约后再调用；被吊销的租约不会自动恢复',
    );
  }
  if (!LIVE_STATUSES.includes(row.status)) {
    fail(
      deps,
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

/**
 * 由**指定**范围版本解析 I(v) 与 X(v)（§8.6）。
 *
 * 版本由调用方给：Worker 工具传会话**冻结**的版本，控制台查询传当前生效版本（见文件头）。
 * v=0（尚无范围版本）返回空集 —— 于是「有资产归属的分块一律不可见、无归属的分块可见」，
 * fail-closed，与 §8.6 同向。
 */
export async function scopeSetsForVersion(
  db: DbClient,
  engagementId: string,
  scopeVersion: number,
): Promise<ScopeSets> {
  if (scopeVersion === 0) return { included: new Set(), excluded: new Set() };
  const rows = await db.query<{ asset_id: string; scope_version: number | string; decision: string }>(
    `select asset_id, scope_version, decision
       from pentest.asset_scope_versions
      where engagement_id = $1::uuid and scope_version = $2::int`,
    [engagementId, scopeVersion],
  );
  const decisions = rows.rows.map((row) => ({
    assetId: row.asset_id,
    scopeVersion: toSafeCount(row.scope_version, 'scope_version'),
    // 用与写入侧同一张取值表收窄：非法取值在这里响亮失败，而不是被当成 included 放行。
    decision: narrow<ScopeDecision>(row.decision, SCOPE_DECISIONS, 'asset_scope_versions.decision'),
  }));
  return resolveScopeSets(decisions, scopeVersion);
}

/** 当前生效的范围版本（`max(version)`；尚无版本时为 0）。控制台口径，见文件头。 */
export async function currentScopeVersion(db: DbClient, engagementId: string): Promise<number> {
  const row = await db.query<{ v: number | string | null }>(
    `select max(version) as v from pentest.scope_versions where engagement_id = $1::uuid`,
    [engagementId],
  );
  return toSafeCount(row.rows[0]?.v, 'scope_version');
}

/** 一次会话准入的全部结果：身份、冻结版本、范围集合，以及两个受控通道。 */
export interface WorkerSessionContext {
  readonly engagementId: string;
  readonly session: SessionRow;
  /** 会话冻结版本下的 I(v)/X(v)（§8.6：Agent 只能看它被授权时的那条边界）。 */
  readonly scopeSets: ScopeSets;
  /** 在本会话的 RLS 上下文里查（读路径）。 */
  query<Row = Record<string, unknown>>(sql: string, params?: readonly unknown[]): Promise<{ readonly rows: readonly Row[] }>;
  /** 在本会话的 RLS 上下文里开事务（写路径）。 */
  withTx<T>(run: (tx: DbClient) => Promise<T>): Promise<T>;
}

/**
 * **唯一**的会话准入入口：拿不到上下文就什么都拿不到。
 *
 * 调用方因此不必（也不能）自己拼「先查会话、再查范围、再设 RLS」的顺序——
 * 那个顺序曾经在每个工具方法里各写一遍。
 */
export async function enterWorkerSession(
  deps: SessionContextDeps,
  workerSessionId: string,
  options: { readonly allowExpiredLease?: boolean } = {},
): Promise<WorkerSessionContext> {
  const session = await admitWorkerSession(deps, workerSessionId, options);
  const scopeSets = await scopeSetsForVersion(deps.db, session.engagement_id, session.scope_version);
  return {
    engagementId: session.engagement_id,
    session,
    scopeSets,
    query: <Row>(sql: string, params?: readonly unknown[]) =>
      queryWithRlsContext<Row>(deps, workerSessionId, session.engagement_id, sql, params),
    withTx: <T>(run: (tx: DbClient) => Promise<T>): Promise<T> => {
      const runner = deps.txRunner;
      if (runner === undefined) {
        return run(deps.db);
      }
      return runner.run(run, async (tx) => {
        await withSessionRlsContext(deps, tx, workerSessionId);
      });
    },
  };
}
