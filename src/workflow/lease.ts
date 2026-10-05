/**
 * 会话租约与提交准入（设计文档 §10.6）。
 *
 * 租约是所有提交类操作的准入凭证。与数据库打交道的入口只依赖注入的
 * `LeaseStore` 端口，因此本模块可以脱离真实 dsh 运行时与真实 PostgreSQL 测试。
 *
 * 约定：
 *   - 运行期可达的拒绝路径（过期、被吊销、世代滞后、无租约、跨任务）返回契约里的
 *     稳定错误码 `ErrorCode`；
 *   - 调用方违反前置条件（对已有未吊销租约的会话重复签发、非法吊销理由、非持租约操作）
 *     抛 `LeaseProtocolError`——那是 bug 或并发冲突，不降级成工具可见的普通拒绝；
 *   - 世代 → 吊销 → 跨任务 → 到期的判定顺序固定。世代先于吊销是有意的：重做复用会
 *     同时吊销旧租约并推进世代，滞后请求的准确诊断是"世代已过期"，而不是"租约被吊销"。
 */

import { randomUUID } from 'node:crypto';

import type {
  ErrorCode,
  LeaseRequiredOperation,
  LeaseRevocationReason,
  SessionLease,
  SessionStatus,
} from '../contracts.ts';
import { DEFAULTS, LEASE_REQUIRED_OPERATIONS, LIVE_SESSION_STATUSES } from '../contracts.ts';
import type { DbClient } from '../db/port.ts';

// ───────────────────────────── 结果与错误 ─────────────────────────────

/** 拒绝路径：带稳定错误码，调用方据码分支，不解析 message（设计文档 §16.5）。 */
type LeaseResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly code: ErrorCode; readonly message: string };

type LeaseRejection = Extract<LeaseResult<never>, { readonly ok: false }>;

function leaseFailure(code: ErrorCode, message: string): LeaseRejection {
  return { ok: false, code, message };
}

/** 租约状态的人读描述，用于错误上下文与诊断信息。 */
export function describeLease(lease: SessionLease | null): string {
  if (lease === null) return '无租约';
  if (lease.revokedAt !== null) {
    return `世代 ${lease.generation} 已于 ${lease.revokedAt.toISOString()} 吊销（${lease.revokedReason ?? '未知理由'}）`;
  }
  return `世代 ${lease.generation} 生效至 ${lease.expiresAt.toISOString()}`;
}

interface LeaseViolationContext {
  /** 触发违规的操作名。 */
  readonly operation?: string;
  readonly workerSessionId?: string;
  /** 违规发生时该会话的租约状态；`null` 表示确认无租约。 */
  readonly leaseState?: SessionLease | null;
}

/** 前置条件被违反（bug 或并发冲突），不是工具可见的拒绝路径。 */
export class LeaseProtocolError extends Error {
  readonly operation: string | null;
  readonly workerSessionId: string | null;
  readonly leaseState: string | null;

  constructor(message: string, context: LeaseViolationContext = {}) {
    const leaseState = context.leaseState === undefined ? null : describeLease(context.leaseState);
    const detail = [
      context.operation === undefined ? null : `操作=${context.operation}`,
      context.workerSessionId === undefined ? null : `会话=${context.workerSessionId}`,
      leaseState === null ? null : `租约=${leaseState}`,
    ]
      .filter((part): part is string => part !== null)
      .join('，');
    super(detail === '' ? message : `${message}（${detail}）`);
    this.name = 'LeaseProtocolError';
    this.operation = context.operation ?? null;
    this.workerSessionId = context.workerSessionId ?? null;
    this.leaseState = leaseState;
  }
}

// ───────────────────────────── 存储端口 ─────────────────────────────

export interface WorkerSessionRow {
  readonly id: string;
  /** 租约继承会话的 engagement（`session_leases.engagement_id` 非空）。 */
  readonly engagementId: string;
  /** 会话绑定的任务；跨任务提交据此拒绝（§10.6 跨任务提权）。 */
  readonly taskRef: string | null;
}

export interface NewLeaseRow {
  readonly id: string;
  readonly engagementId: string;
  readonly workerSessionId: string;
  readonly taskRef: string | null;
  readonly generation: number;
  readonly issuedAt: Date;
  readonly expiresAt: Date;
  readonly lastHeartbeatAt: Date;
}

export interface RevokeActiveLeasesInput {
  readonly workerSessionId: string;
  readonly reason: LeaseRevocationReason;
  readonly revokedAt: Date;
  /** 期望吊销的世代；给出且与当前生效租约不符时影响 0 行（防误吊销新世代）。 */
  readonly expectGeneration?: number;
}

export interface LeaseTx {
  /** SELECT ... FOR UPDATE：同一会话的签发与吊销串行化，避免并发签发撞部分唯一索引。 */
  lockWorkerSession(workerSessionId: string): Promise<WorkerSessionRow | null>;
  /** 未吊销的最新租约（`session_leases_one_active` 保证至多一行）。 */
  selectActiveLease(workerSessionId: string): Promise<SessionLease | null>;
  selectLease(workerSessionId: string, generation: number): Promise<SessionLease | null>;
  /** 已签发过的最大世代；无租约时为 0。 */
  maxGeneration(workerSessionId: string): Promise<number>;
  insertLease(row: NewLeaseRow): Promise<void>;
  revokeActiveLeases(input: RevokeActiveLeasesInput): Promise<readonly string[]>;
  /** 到期清扫：标记 `expires_at <= now()` 的未吊销行并释放槽位。 */
  revokeExpiredLeases(now: Date): Promise<readonly ExpiredLeaseRef[]>;
  touchHeartbeat(input: {
    readonly leaseId: string;
    readonly expiresAt: Date;
    readonly heartbeatAt: Date;
  }): Promise<void>;
  /** PostgreSQL 实现提供事务绑定连接；内存替身可省略。 */
  readonly db?: DbClient;
}

export interface ExpiredLeaseRef {
  readonly leaseId: string;
  readonly workerSessionId: string;
  /** 被清扫行原本的到期时间；不是清扫时刻。 */
  readonly expiresAt: Date;
}

/**
 * 租约事务的 RLS 作用域（§9.4）。
 *
 * 两种维度二选一：
 *   - `workerSessionId`：由实现反查所属作业（会话优先的调用路径）；
 *   - `engagementId`：已知作业时直接落上下文（跨会话操作，如到期清扫）。
 *
 * 两者都没有时用实现的静态上下文——只在「超级用户/单作业」部署成立，
 * FORCE RLS + 运行时角色下会影响 0 行且不报错。
 */
export interface LeaseTransactionScope {
  readonly workerSessionId?: string;
  readonly engagementId?: string;
}

export interface LeaseStore {
  /** 吊销旧世代与签发新租约必须在同一事务内（§10.6）。 */
  /**
   * 在一个租约事务里执行 `work`。
   *
   * `scope` 决定事务的 RLS 上下文：给 `workerSessionId` 时由实现反查所属作业，
   * 给 `engagementId` 时直接落该作业（`string` 形式等价于只给 `workerSessionId`）。
   * **涉及 engagement 作用域表的读写没有作用域就会被 RLS 静默挡下**——调用点必须
   * 显式给出能定位作业的那一个。
   */
  transaction<T>(work: (tx: LeaseTx) => Promise<T>, scope?: string | LeaseTransactionScope): Promise<T>;
  /** 非 PostgreSQL 存储的提交后观测；事务内 hook 存在时不再调用它。 */
  readonly onLifecycle?: (event: LeaseLifecycleEvent) => Promise<void> | void;
  /** 在数据库事务提交前写入同一事务；失败会使租约变更整体回滚。 */
  readonly onLifecycleInTransaction?: (tx: LeaseTx, event: LeaseLifecycleEvent) => Promise<void>;
}

export type LeaseLifecycleEvent =
  | { readonly type: 'lease.issued'; readonly lease: SessionLease }
  | { readonly type: 'lease.renewed'; readonly lease: SessionLease }
  | { readonly type: 'lease.revoked'; readonly lease: SessionLease; readonly reason: LeaseRevocationReason }
  | { readonly type: 'lease.expired'; readonly lease: ExpiredLeaseRef };

// ───────────────────────────── 基础谓词 ─────────────────────────────

/**
 * §10.6 的吊销理由取值域：没有 `budget_exhausted`——暂停保留租约，不吊销。
 * `expired` 由清扫驱动的 `expireLeases` 写入，与 `superseded`（有意替换）在审计上不可混用。
 */
export function isLeaseRevocationReason(v: unknown): v is LeaseRevocationReason {
  return (
    v === 'superseded' || v === 'closed' || v === 'failed' || v === 'human_revoke' || v === 'expired'
  );
}

/** 需要持租约的操作由契约固定：提交报告、申请放行、执行动作、生成交接草稿。 */
export function isLeaseRequiredOperation(v: unknown): v is LeaseRequiredOperation {
  return typeof v === 'string' && (LEASE_REQUIRED_OPERATIONS as readonly string[]).includes(v);
}

/** 到期即失效；到期未续的租约不可续，只能由人工重新签发。 */
export function isLeaseExpired(lease: SessionLease, now: Date): boolean {
  return now.getTime() >= lease.expiresAt.getTime();
}

/** §5.1：会话状态到租约处置的对应关系；存活态一律保留。 */
type LeaseDisposition =
  | { readonly action: 'keep' }
  | { readonly action: 'revoke'; readonly reason: LeaseRevocationReason };

export function leaseDispositionForSessionStatus(status: SessionStatus): LeaseDisposition {
  if ((LIVE_SESSION_STATUSES as readonly string[]).includes(status)) {
    return { action: 'keep' };
  }
  switch (status) {
    case 'superseded':
      return { action: 'revoke', reason: 'superseded' };
    case 'closed':
      return { action: 'revoke', reason: 'closed' };
    case 'failed':
      return { action: 'revoke', reason: 'failed' };
    default:
      throw new LeaseProtocolError(`未知会话状态：${String(status)}`, {
        operation: 'lease_disposition_for_session_status',
      });
  }
}

// ───────────────────────────── 准入判定 ─────────────────────────────

/** 无生效租约的拒绝消息：`assertLeaseValid` 与存储解析共用同一文本，避免漂移。 */
const NO_ACTIVE_LEASE_MESSAGE = '该会话没有生效租约，需要持租约的操作被拒绝';

/**
 * 租约准入的判定核心，纯函数：不查库、不改状态。
 * 顺序固定为 世代 → 吊销 → 跨任务 → 到期，返回 `null` 表示准入（此时 `lease` 必非空）。
 */
function rejectionForLeaseState(
  lease: SessionLease | null,
  generation: number,
  now: Date,
  taskRef: string | null,
): LeaseRejection | null {
  if (lease === null) {
    return leaseFailure('lease_required', NO_ACTIVE_LEASE_MESSAGE);
  }
  if (lease.generation !== generation) {
    return leaseFailure(
      'lease_generation_stale',
      `租约世代已推进：当前世代 ${lease.generation}，请求世代 ${generation}；在途的旧世代请求被拒绝`,
    );
  }
  if (lease.revokedAt !== null) {
    return leaseFailure('lease_revoked', `租约已吊销，旧会话的提交被拒绝：${describeLease(lease)}`);
  }
  if (taskRef !== null && lease.taskRef !== null && lease.taskRef !== taskRef) {
    return leaseFailure('lease_required', `租约绑定任务 ${lease.taskRef}，不能用于任务 ${taskRef}`);
  }
  if (isLeaseExpired(lease, now)) {
    return leaseFailure('lease_expired', `租约已到期：${describeLease(lease)}`);
  }
  return null;
}

interface LeaseAdmissionOptions {
  /** 判定时刻；省略则取当前时刻。测试显式传入以获得确定性。 */
  readonly now?: Date;
  /** 本次提交所属任务；与租约绑定任务不一致即跨任务提权，拒绝。 */
  readonly taskRef?: string | null;
}

/** 对持有的租约对象做准入判定；见 `rejectionForLeaseState` 的判定顺序。 */
export function assertLeaseValid(
  lease: SessionLease | null,
  operation: LeaseRequiredOperation,
  generation: number,
  options: LeaseAdmissionOptions = {},
): LeaseResult<SessionLease> {
  if (!isLeaseRequiredOperation(operation)) {
    throw new LeaseProtocolError(`非持租约操作，不应走租约准入：${String(operation)}`, {
      operation: String(operation),
    });
  }
  if (!Number.isInteger(generation) || generation < 1) {
    throw new LeaseProtocolError(`非法租约世代：${String(generation)}`, {
      operation: String(operation),
      leaseState: lease,
    });
  }
  const rejection = rejectionForLeaseState(
    lease,
    generation,
    options.now ?? new Date(),
    options.taskRef ?? null,
  );
  if (rejection !== null) return rejection;
  return { ok: true, value: lease as SessionLease };
}

/**
 * 从存储解析"请求世代"的租约状态：
 *   1. 有生效租约 → 直接与请求世代比对（滞后 → `lease_generation_stale`）；
 *   2. 无生效租约 → 请求世代小于已签发的最大世代即滞后；
 *   3. 否则按该世代行本身判定（已吊销 → `lease_revoked`；无行 → `lease_required`）。
 *
 * 第 1 步的对象必须是**当前生效租约**：重做复用后旧世代行仍在表里（只是已吊销），
 * 只按行比对会把滞后提交误判成"租约被吊销"。
 */
async function resolveGenerationAdmission(
  tx: LeaseTx,
  workerSessionId: string,
  generation: number,
  now: Date,
  taskRef: string | null,
): Promise<LeaseResult<SessionLease>> {
  const active = await tx.selectActiveLease(workerSessionId);
  if (active !== null) {
    const rejection = rejectionForLeaseState(active, generation, now, taskRef);
    return rejection ?? { ok: true, value: active };
  }
  const max = await tx.maxGeneration(workerSessionId);
  if (max > generation) {
    return leaseFailure(
      'lease_generation_stale',
      `租约世代已推进：已签发到世代 ${max}，请求世代 ${generation}；在途的旧世代请求被拒绝`,
    );
  }
  const requested = await tx.selectLease(workerSessionId, generation);
  if (requested === null) {
    return leaseFailure('lease_required', NO_ACTIVE_LEASE_MESSAGE);
  }
  const rejection = rejectionForLeaseState(requested, generation, now, taskRef);
  return rejection ?? { ok: true, value: requested };
}
async function emitLifecycleInTransaction(
  store: LeaseStore,
  tx: LeaseTx,
  event: LeaseLifecycleEvent,
): Promise<boolean> {
  if (store.onLifecycleInTransaction === undefined) return false;
  await store.onLifecycleInTransaction(tx, event);
  return true;
}

async function emitPostCommit(
  store: LeaseStore,
  events: readonly LeaseLifecycleEvent[],
): Promise<void> {
  // 事务内 callback 与普通 callback 是二选一：同一事件不能在提交前后各发一次。
  if (store.onLifecycleInTransaction !== undefined) return;
  for (const event of events) await store.onLifecycle?.(event);
}

// ───────────────────────────── 签发 ─────────────────────────────


interface IssueLeaseInput {
  readonly workerSessionId: string;
  /** 省略时取会话行绑定的任务。 */
  readonly taskRef?: string;
  readonly now: Date;
  readonly ttlSeconds?: number;
  readonly leaseId?: string;
}

export async function issueLease(store: LeaseStore, input: IssueLeaseInput): Promise<SessionLease> {
  const lease = await store.transaction(async (tx) => {
    const session = await tx.lockWorkerSession(input.workerSessionId);
    if (session === null) {
      throw new LeaseProtocolError(`工作会话不存在：${input.workerSessionId}`, {
        operation: 'issue_lease',
        workerSessionId: input.workerSessionId,
      });
    }
    const active = await tx.selectActiveLease(input.workerSessionId);
    if (active !== null) {
      throw new LeaseProtocolError(
        isLeaseExpired(active, input.now)
          ? '会话的租约已到期但仍占用 session_leases_one_active；先由 expireLeases 清扫释放槽位（吊销理由 expired），再签发'
          : '会话已持有未吊销租约，重做复用必须走 reissueLease',
        { operation: 'issue_lease', workerSessionId: input.workerSessionId, leaseState: active },
      );
    }
    const lease = await insertLease(tx, {
      workerSessionId: input.workerSessionId,
      engagementId: session.engagementId,
      taskRef: input.taskRef ?? session.taskRef,
      now: input.now,
      ttlSeconds: input.ttlSeconds,
      leaseId: input.leaseId,
      generation: (await tx.maxGeneration(input.workerSessionId)) + 1,
    });
    await emitLifecycleInTransaction(store, tx, { type: 'lease.issued', lease });
    return lease;
  }, input.workerSessionId);
  if (store.onLifecycleInTransaction === undefined) {
    await store.onLifecycle?.({ type: 'lease.issued', lease });
  }
  return lease;
}

interface ReissueLeaseInput {
  readonly workerSessionId: string;
  /** 省略时沿用当前生效租约绑定的任务，其次回落到会话行。 */
  readonly taskRef?: string;
  readonly now: Date;
  readonly ttlSeconds?: number;
  readonly leaseId?: string;
}

interface ReissueLeaseOutcome {
  readonly lease: SessionLease;
  readonly revokedLeaseIds: readonly string[];
}

/**
 * 重做复用：**有意替换**当前生效租约，吊销理由固定 `superseded`（§10.6）。
 *
 * 顺序固定为「先吊销旧世代，再签发新世代」，两者同一事务：
 *   UPDATE session_leases SET revoked_at = now(), revoked_reason = 'superseded'
 *     WHERE worker_session_id = ? AND revoked_at IS NULL
 *   INSERT session_leases (..., generation = 旧世代 + 1)
 * 反过来会撞 `session_leases_one_active`——重做复用不改变 `worker_sessions` 行、
 * 状态仍是 `active`，因此不会触发"被取代/关闭/失败"的自动吊销。
 *
 * 生效租约**已到期**时抛出：给它盖上 `superseded` 会把"会话失联"记成"有意替换"，
 * 审计上就是错的。此时应先 `expireLeases` 清扫（理由 `expired`），再 `issueLease`。
 */
export async function reissueLease(
  store: LeaseStore,
  input: ReissueLeaseInput,
): Promise<ReissueLeaseOutcome> {
  const outcome = await store.transaction(async (tx) => {
    const session = await tx.lockWorkerSession(input.workerSessionId);
    if (session === null) {
      throw new LeaseProtocolError(`工作会话不存在：${input.workerSessionId}`, {
        operation: 'reissue_lease',
        workerSessionId: input.workerSessionId,
      });
    }
    const active = await tx.selectActiveLease(input.workerSessionId);
    if (active !== null && isLeaseExpired(active, input.now)) {
      throw new LeaseProtocolError(
        '生效租约已到期，不能按 superseded 记录；先由 expireLeases 清扫（吊销理由 expired），再 issueLease',
        { operation: 'reissue_lease', workerSessionId: input.workerSessionId, leaseState: active },
      );
    }
    const revokedLeaseIds = await tx.revokeActiveLeases({
      workerSessionId: input.workerSessionId,
      reason: 'superseded',
      revokedAt: input.now,
    });
    const revokedLease = active === null || revokedLeaseIds.length === 0
      ? null
      : { ...active, revokedAt: input.now, revokedReason: 'superseded' as const };
    // 审计顺序必须与重做语义一致：旧世代先 revoked，新世代后 issued。
    if (revokedLease !== null) {
      await emitLifecycleInTransaction(store, tx, {
        type: 'lease.revoked',
        lease: revokedLease,
        reason: 'superseded',
      });
    }
    const generation = (await tx.maxGeneration(input.workerSessionId)) + 1;
    const lease = await insertLease(tx, {
      workerSessionId: input.workerSessionId,
      engagementId: session.engagementId,
      taskRef: input.taskRef ?? active?.taskRef ?? session.taskRef,
      now: input.now,
      ttlSeconds: input.ttlSeconds,
      leaseId: input.leaseId,
      generation,
    });
    await emitLifecycleInTransaction(store, tx, { type: 'lease.issued', lease });
    return { lease, revokedLeaseIds, revokedLease };
  }, input.workerSessionId);
  if (store.onLifecycleInTransaction === undefined) {
    const postCommit: LeaseLifecycleEvent[] = [];
    if (outcome.revokedLease !== null) {
      postCommit.push({ type: 'lease.revoked', lease: outcome.revokedLease, reason: 'superseded' });
    }
    postCommit.push({ type: 'lease.issued', lease: outcome.lease });
    await emitPostCommit(store, postCommit);
  }
  return { lease: outcome.lease, revokedLeaseIds: outcome.revokedLeaseIds };
}

async function insertLease(
  tx: LeaseTx,
  input: {
    readonly workerSessionId: string;
    readonly engagementId: string;
    readonly taskRef: string | null;
    readonly now: Date;
    readonly ttlSeconds?: number;
    readonly leaseId?: string;
    readonly generation: number;
  },
): Promise<SessionLease> {
  const ttlSeconds = input.ttlSeconds ?? DEFAULTS.leaseTtlSeconds;
  if (!Number.isFinite(ttlSeconds) || ttlSeconds <= 0) {
    throw new LeaseProtocolError(`非法租约 TTL：${String(ttlSeconds)}`, {
      operation: 'issue_lease',
      workerSessionId: input.workerSessionId,
    });
  }
  const lease: SessionLease = {
    id: input.leaseId ?? randomUUID(),
    workerSessionId: input.workerSessionId,
    taskRef: input.taskRef,
    generation: input.generation,
    expiresAt: new Date(input.now.getTime() + ttlSeconds * 1000),
    revokedAt: null,
    revokedReason: null,
  };
  await tx.insertLease({
    id: lease.id,
    engagementId: input.engagementId,
    workerSessionId: lease.workerSessionId,
    taskRef: lease.taskRef,
    generation: lease.generation,
    issuedAt: input.now,
    expiresAt: lease.expiresAt,
    lastHeartbeatAt: input.now,
  });
  return lease;
}

// ───────────────────────────── 续租 ─────────────────────────────

interface RenewLeaseInput {
  readonly workerSessionId: string;
  readonly generation: number;
  readonly now: Date;
  readonly ttlSeconds?: number;
}

/**
 * 心跳续租：活动会话的租约自动延长。
 * 暂停中的会话仍属存活态，心跳可继续——因此续租不看会话状态，只看租约自身。
 */
export async function renewLease(
  store: LeaseStore,
  input: RenewLeaseInput,
): Promise<LeaseResult<SessionLease>> {
  const ttlSeconds = input.ttlSeconds ?? DEFAULTS.leaseTtlSeconds;
  if (!Number.isFinite(ttlSeconds) || ttlSeconds <= 0) {
    throw new LeaseProtocolError(`非法租约 TTL：${String(ttlSeconds)}`, {
      operation: 'renew_lease',
      workerSessionId: input.workerSessionId,
    });
  }
  const outcome = await store.transaction(async (tx) => {
    const admitted = await resolveGenerationAdmission(
      tx,
      input.workerSessionId,
      input.generation,
      input.now,
      null,
    );
    if (!admitted.ok) return admitted;
    const expiresAt = new Date(input.now.getTime() + ttlSeconds * 1000);
    await tx.touchHeartbeat({
      leaseId: admitted.value.id,
      expiresAt,
      heartbeatAt: input.now,
    });
    const lease = { ...admitted.value, expiresAt };
    await emitLifecycleInTransaction(store, tx, { type: 'lease.renewed', lease });
    return { ok: true as const, value: lease };
  }, input.workerSessionId);
  if (outcome.ok && store.onLifecycleInTransaction === undefined) {
    await store.onLifecycle?.({ type: 'lease.renewed', lease: outcome.value });
  }
  return outcome;
}

interface RevokeLeaseInput {
  readonly workerSessionId: string;
  readonly reason: LeaseRevocationReason;
  readonly now: Date;
  /** 期望吊销的世代；给出且与当前生效租约不符时返回 `lease_generation_stale`。 */
  readonly expectGeneration?: number;
}

interface RevokeLeaseOutcome {
  readonly revokedLeaseIds: readonly string[];
  readonly reason: LeaseRevocationReason;
}

/**
 * 显式吊销当前生效租约。已无生效租约时幂等返回空集合——重复吊销不报错，
 * 也不会因此产生多余写入（§18.1「吊销后可签发新租约」）。
 */
export async function revokeLease(
  store: LeaseStore,
  input: RevokeLeaseInput,
): Promise<LeaseResult<RevokeLeaseOutcome>> {
  if (!isLeaseRevocationReason(input.reason)) {
    throw new LeaseProtocolError(
      `非法吊销理由：${String(input.reason)}；§10.6 的取值域为 superseded/closed/failed/human_revoke（暂停不吊销）`,
      { operation: 'revoke_lease', workerSessionId: input.workerSessionId },
    );
  }
  const outcome = await store.transaction(async (tx) => {
    let active: SessionLease | null;
    if (input.expectGeneration !== undefined) {
      active = await tx.selectActiveLease(input.workerSessionId);
      if (active === null) return { ok: true as const, value: { revokedLeaseIds: [], reason: input.reason, active } };
      if (active.generation !== input.expectGeneration) {
        return leaseFailure(
          'lease_generation_stale',
          `租约世代已推进：请求吊销世代 ${input.expectGeneration}，当前活跃租约：${describeLease(active)}`,
        );
      }
    } else if (store.onLifecycleInTransaction !== undefined || store.onLifecycle !== undefined) {
      active = await tx.selectActiveLease(input.workerSessionId);
    } else {
      // 无观测回调时直接让 UPDATE 决定是否命中；幂等重放不需要额外 SELECT。
      active = null;
    }
    const revokedLeaseIds = await tx.revokeActiveLeases({
      workerSessionId: input.workerSessionId,
      reason: input.reason,
      revokedAt: input.now,
      expectGeneration: input.expectGeneration,
    });
    const revokedLease = active === null || revokedLeaseIds.length === 0
      ? null
      : { ...active, revokedAt: input.now, revokedReason: input.reason };
    if (revokedLease !== null) {
      await emitLifecycleInTransaction(store, tx, { type: 'lease.revoked', lease: revokedLease, reason: input.reason });
    }
    return { ok: true as const, value: { revokedLeaseIds, reason: input.reason, active: revokedLease } };
  }, input.workerSessionId);
  if (!outcome.ok) return outcome;
  if (outcome.value.active !== null && store.onLifecycleInTransaction === undefined) {
    await store.onLifecycle?.({ type: 'lease.revoked', lease: outcome.value.active, reason: input.reason });
  }
  return { ok: true, value: { revokedLeaseIds: outcome.value.revokedLeaseIds, reason: outcome.value.reason } };
}

// ───────────────────────────── 到期清扫 ─────────────────────────────

interface ExpireLeasesInput {
  readonly now: Date;
  /**
   * 作业作用域。给出时清扫落在该作业的 RLS 上下文里（心跳逐作业调用）；
   * 省略时用实现的静态上下文——FORCE RLS + 运行时角色下那会影响 0 行且不报错，
   * 过期行于是永久占着 `session_leases_one_active` 槽位（事故 2026-10-05）。
   */
  readonly engagementId?: string;
}

interface ExpireLeasesOutcome {
  readonly expiredLeases: readonly ExpiredLeaseRef[];
  readonly clearedBefore: Date;
}

/**
 * 到期清扫（§10.6「到期未续 → 租约失效」）。
 * 清扫把 `expires_at <= now()` 的行标记为 `revoked_reason='expired'` 并释放槽位。
 *
 * 它扫描的是 `session_leases_expiry` 索引，与单个会话无关；调用方（工作流服务或定时任务）
 * 据返回的会话清单去对账那些失联的会话。
 */
export async function expireLeases(
  store: LeaseStore,
  input: ExpireLeasesInput,
): Promise<ExpireLeasesOutcome> {
  const outcome = await store.transaction(async (tx) => {
    const expiredLeases = await tx.revokeExpiredLeases(input.now);
    for (const lease of expiredLeases) {
      await emitLifecycleInTransaction(store, tx, { type: 'lease.expired', lease });
    }
    return { expiredLeases, clearedBefore: input.now };
  }, input.engagementId === undefined ? undefined : { engagementId: input.engagementId });
  if (store.onLifecycleInTransaction === undefined) {
    await emitPostCommit(store, outcome.expiredLeases.map((lease) => ({ type: 'lease.expired', lease })));
  }
  return outcome;
}

// ───────────────────────────── 会话状态联动 ─────────────────────────────

interface SessionStatusChangeInput {
  readonly workerSessionId: string;
  readonly status: SessionStatus;
  readonly now: Date;
}

interface SessionStatusChangeOutcome {
  readonly disposition: LeaseDisposition;
  readonly revokedLeaseIds: readonly string[];
}

/**
 * 会话状态变化时的租约处置（§5.1 表）。
 * 存活态（含 `paused`）保留租约且不产生任何写入——暂停若吊销租约，会连带作废该会话
 * 全部放行凭证，"追加预算继续"就得重新签发，这个连锁后果不可接受（§10.6）。
 */
export async function applySessionStatusChange(
  store: LeaseStore,
  input: SessionStatusChangeInput,
): Promise<LeaseResult<SessionStatusChangeOutcome>> {
  const disposition = leaseDispositionForSessionStatus(input.status);
  if (disposition.action === 'keep') {
    return { ok: true, value: { disposition, revokedLeaseIds: [] } };
  }
  const revoked = await revokeLease(store, {
    workerSessionId: input.workerSessionId,
    reason: disposition.reason,
    now: input.now,
  });
  if (!revoked.ok) return revoked;
  return { ok: true, value: { disposition, revokedLeaseIds: revoked.value.revokedLeaseIds } };
}

// ───────────────────────────── 提交准入 ─────────────────────────────

interface LeaseAdmissionInput {
  readonly workerSessionId: string;
  readonly generation: number;
  readonly operation: LeaseRequiredOperation;
  readonly now: Date;
  readonly taskRef?: string | null;
}

/** 提交类操作的准入检查；判定顺序见 `resolveGenerationAdmission`。 */
export async function validateLeaseForOperation(
  store: LeaseStore,
  input: LeaseAdmissionInput,
): Promise<LeaseResult<SessionLease>> {
  if (!isLeaseRequiredOperation(input.operation)) {
    throw new LeaseProtocolError(`非持租约操作，不应走租约准入：${String(input.operation)}`, {
      operation: String(input.operation),
      workerSessionId: input.workerSessionId,
    });
  }
  return store.transaction((tx) =>
    resolveGenerationAdmission(
      tx,
      input.workerSessionId,
      input.generation,
      input.now,
      input.taskRef ?? null,
    ),
    input.workerSessionId,
  );
}
