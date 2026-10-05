/**
 * 租约心跳：周期性续租，让活动会话的租约不因 TTL 到期而失效。
 *
 * 设计依据：docs/dsh-pentest-plugin-design.md §10.6（租约）、§10.5（资源与活性）、
 * §14.3（多实例）
 *
 * ── 这个模块补的是什么缺陷 ──
 *
 * `renewLease` 早已实现，但**没有任何调用者**。而执行闸门在租约过期时拒绝
 * （`lease_expired`），默认 TTL 是 600 秒。后果是：
 *
 *   任何运行超过 10 分钟的会话，其每一次动作都会被拒绝。
 *
 * 实际渗透任务远超 10 分钟，因此这是**必然发生的正确性问题**——不是「少了个
 * 优化」。会话看起来还活着（状态 active、报告还能提交），却一个动作都执行不了。
 *
 * ── 为什么续租只续「还没过期」的 ──
 *
 * `renewLease` 对已过期租约返回 `lease_expired`，心跳**不绕过这一点**。
 * 区分两种情形：
 *
 *   - **快到期的租约**：会话正常工作，心跳续上——这是常态。
 *   - **已经过期的租约**：说明进程停了超过 TTL（或心跳连续失败多次）。
 *     那是一个**信号**，不该被自动治好：本模块只报告它（`expired`），
 *     由 §15.2 的启动对账或人类处置。自动复活会掩盖「我们失联了多久」这件事。
 *
 * ── 提前续租的窗口 ──
 *
 * 不在租约刚签发时就续，而是等剩余时间少于 `renewAheadSeconds`（默认
 * 3 × 心跳间隔）时才续。理由：给连续失败留出 3 次机会，同时把写放大压到最低
 * （每次续租是一次 UPDATE）。剩余时间充足时跳过，不是「偷懒」而是避免无意义写入。
 *
 * ── 多实例安全 ──
 *
 * 心跳**跨实例安全**：它读取会话当前的活跃租约（含世代），带着该世代去续；
 * 若期间世代已被另一实例推进（重做复用），`renewLease` 返回
 * `lease_generation_stale`——本模块把它记为「跳过」而不是错误，因为那表示
 * 「这个会话已由别人接手」，我方的续租请求本就不该生效。
 */

import type { DbClient } from '../db/port.ts';
import type { ExpiredLeaseRef, LeaseStore } from '../workflow/lease.ts';
import { expireLeases, renewLease } from '../workflow/lease.ts';
import { DEFAULTS } from '../contracts.ts';
import { LIVE_SESSION_STATUSES } from '../contracts.ts';

/** 默认心跳间隔（秒），与 `DEFAULTS.leaseHeartbeatSeconds` 一致。 */
export const DEFAULT_HEARTBEAT_SECONDS = DEFAULTS.leaseHeartbeatSeconds;

/**
 * 提前多久开始续租（秒）。
 *
 * 3 × 心跳间隔 = 180 秒，即在租约到期前给三次续租机会。心跳间隔 60 秒、
 * TTL 600 秒时，租约在剩 180 秒时开始被续，此后每次心跳都续——足够容忍两次失败。
 */
export const DEFAULT_RENEW_AHEAD_SECONDS = DEFAULT_HEARTBEAT_SECONDS * 3;

export interface LeaseHeartbeatDeps {
  readonly db: DbClient;
  readonly leases: LeaseStore;
  readonly clock?: () => Date;
  readonly onRenewed?: (event: { readonly workerSessionId: string; readonly generation: number; readonly expiresAt: Date }) => void;
  /**
   * 发现**已过期**租约时的回调。清扫先把租约标为 expired，再通知观测层；
   * 回调收到的是已经释放准入槽位的会话。
   */
  readonly onExpiredFound?: (event: { readonly workerSessionId: string; readonly expiresAt: Date }) => void;
  readonly onError?: (error: unknown, context: { readonly workerSessionId: string | null }) => void;
  readonly onTick?: (result: HeartbeatResult) => void;
  /**
   * RLS 作用域。
   *
   * **必须有**：租约扫描读 `session_leases`，而那张表没有租户级放行。没有作用域时
   * 它扫到零行——心跳会静默停止续租，任何运行超过 TTL 的会话都会在执行闸门处被判过期。
   */
  readonly rlsScope?: {
    run<T>(
      scope: { readonly engagementId?: string | null; readonly workerSessionId?: string | null },
      work: () => Promise<T>,
    ): Promise<T>;
    listEngagementIds: () => Promise<readonly string[]>;
  };
}

export interface HeartbeatResult {
  /** 扫到的活跃租约数。 */
  readonly scanned: number;
  /** 本轮先被 expireLeases 标记 expired 的租约数。 */
  readonly sweptExpired: readonly string[];
  readonly renewed: readonly string[];
  /** 剩余时间充足，本次不续（不是错误）。 */
  readonly skipped: readonly string[];
  /** 已过期：本模块不复活它们，只报告。 */
  readonly expired: readonly string[];
  readonly failed: readonly { readonly workerSessionId: string; readonly message: string }[];
}


export interface LeaseHeartbeatOptions {
  readonly intervalSeconds?: number;
  readonly renewAheadSeconds?: number;
  /** 每次续租的 TTL；省略即用 `DEFAULTS.leaseTtlSeconds`。 */
  readonly ttlSeconds?: number;
  readonly setIntervalFn?: (fn: () => void, ms: number) => TimerHandle;
  readonly clearIntervalFn?: (handle: TimerHandle) => void;
}

export type TimerHandle = ReturnType<typeof setInterval>;

interface ActiveLeaseRow {
  readonly worker_session_id: string;
  readonly generation: number | string;
  readonly expires_at: string;
}

export class LeaseHeartbeat {
  readonly #db: DbClient;
  readonly #leases: LeaseStore;
  readonly #clock: () => Date;
  readonly #onRenewed: LeaseHeartbeatDeps['onRenewed'];
  readonly #scopes: LeaseHeartbeatDeps['rlsScope'];
  readonly #onExpiredFound: LeaseHeartbeatDeps['onExpiredFound'];
  readonly #onError: LeaseHeartbeatDeps['onError'];
  readonly #onTick: LeaseHeartbeatDeps['onTick'];
  readonly #intervalSeconds: number;
  readonly #renewAheadSeconds: number;
  readonly #ttlSeconds: number;
  readonly #setInterval: (fn: () => void, ms: number) => TimerHandle;
  readonly #clearInterval: (handle: TimerHandle) => void;

  #timer: TimerHandle | null = null;
  #inFlight: Promise<HeartbeatResult> | null = null;
  #stopped = false;

  constructor(deps: LeaseHeartbeatDeps, options: LeaseHeartbeatOptions = {}) {
    this.#db = deps.db;
    this.#leases = deps.leases;
    this.#clock = deps.clock ?? (() => new Date());
    this.#onRenewed = deps.onRenewed;
    this.#scopes = deps.rlsScope;
    this.#onExpiredFound = deps.onExpiredFound;
    this.#onError = deps.onError;
    this.#onTick = deps.onTick;
    this.#intervalSeconds = positive(options.intervalSeconds ?? DEFAULT_HEARTBEAT_SECONDS, 'intervalSeconds');
    this.#renewAheadSeconds = positive(
      options.renewAheadSeconds ?? DEFAULT_RENEW_AHEAD_SECONDS,
      'renewAheadSeconds',
    );
    this.#ttlSeconds = positive(options.ttlSeconds ?? DEFAULTS.leaseTtlSeconds, 'ttlSeconds');
    this.#setInterval = options.setIntervalFn ?? ((fn, ms) => setInterval(fn, ms));
    this.#clearInterval = options.clearIntervalFn ?? ((handle) => { clearInterval(handle); });
  }

  get intervalSeconds(): number {
    return this.#intervalSeconds;
  }

  get running(): boolean {
    return this.#inFlight !== null;
  }

  /**
   * 启动周期心跳。
   *
   * 立即跑一次：启动时可能已有租约临近过期（上次进程刚重启，而租约是在
   * 上一次运行中签发的），等一个间隔会让它们在这期间过期。
   */
  start(): void {
    if (this.#stopped) {
      throw new Error('租约心跳已停止：停止后的实例不可重启，请新建一个');
    }
    if (this.#timer !== null) return;

    void this.tick();

    const handle = this.#setInterval(() => { void this.tick(); }, this.#intervalSeconds * 1000);
    // 不阻止宿主退出——与索引调度器同一要求。
    (handle as { unref?: () => void }).unref?.();
    this.#timer = handle;
  }

  /** 停止并等待在途心跳结束。幂等。 */
  async stop(): Promise<void> {
    if (this.#timer !== null) {
      this.#clearInterval(this.#timer);
      this.#timer = null;
    }
    this.#stopped = true;
    if (this.#inFlight !== null) {
      await this.#inFlight.catch(() => undefined);
    }
  }

  /** 一次心跳。不重叠：在途时复用同一次。 */
  tick(): Promise<HeartbeatResult> {
    if (this.#inFlight !== null) return this.#inFlight;
    const run = this.#run().finally(() => { this.#inFlight = null; });
    this.#inFlight = run;
    return run;
  }

  async #run(): Promise<HeartbeatResult> {
    const now = this.#clock();
    const renewed: string[] = [];
    const skipped: string[] = [];
    const expired = new Set<string>();
    const reportedExpired = new Set<string>();
    const failed: { workerSessionId: string; message: string }[] = [];

    let sweptExpired: readonly string[] = [];
    try {
      const swept = await this.#sweepExpired(now);
      sweptExpired = swept.map((lease) => lease.workerSessionId);
      for (const lease of swept) {
        const workerSessionId = lease.workerSessionId;
        expired.add(workerSessionId);
        reportedExpired.add(workerSessionId);
        this.#onExpiredFound?.({ workerSessionId, expiresAt: lease.expiresAt });
      }
    } catch (error) {
      // 清扫失败不能阻止本轮继续续租；否则一个临时写故障会同时阻断所有会话。
      this.#onError?.(error, { workerSessionId: null });
    }

    let rows: readonly ActiveLeaseRow[];
    try {
      rows = await this.#activeLeases();
    } catch (error) {
      // 读失败不影响后续（本就没有后续）——报告出去，不抛
      this.#onError?.(error, { workerSessionId: null });
      return { scanned: 0, sweptExpired, renewed, skipped, expired: [...expired], failed };
    }

    for (const row of rows) {
      const expiresAt = new Date(row.expires_at);
      const remainingMs = expiresAt.getTime() - now.getTime();

      if (remainingMs <= 0) {
        // 已过期：清扫成功时已报告；清扫失败或竞争到期时仍需报告。
        expired.add(row.worker_session_id);
        if (!reportedExpired.has(row.worker_session_id)) {
          reportedExpired.add(row.worker_session_id);
          this.#onExpiredFound?.({ workerSessionId: row.worker_session_id, expiresAt });
        }
        continue;
      }
      if (remainingMs > this.#renewAheadSeconds * 1000) {
        // 剩余充足：不续（避免无意义写入）
        skipped.push(row.worker_session_id);
        continue;
      }

      // **逐条 try/catch 是必需的**：`renewLease` 在存储故障时**抛异常**（不是返回
      // 拒绝码）。没有这一层，一次抛异常的续租会中止整轮心跳，而定时器里的
      // `void this.tick()` 会变成未处理的 rejection——其余会话的租约因此不再被续，
      // 最终全部过期。心跳这种后台循环必须做到「一个失败不影响其余」。
      let outcome: Awaited<ReturnType<typeof renewLease>>;
      try {
        outcome = await renewLease(this.#leases, {
          workerSessionId: row.worker_session_id,
          generation: toGeneration(row.generation),
          now,
          ttlSeconds: this.#ttlSeconds,
        });
      } catch (error) {
        failed.push({
          workerSessionId: row.worker_session_id,
          message: error instanceof Error ? error.message : String(error),
        });
        this.#onError?.(error, { workerSessionId: row.worker_session_id });
        continue;
      }
      if (outcome.ok) {
        renewed.push(row.worker_session_id);
        this.#onRenewed?.({
          workerSessionId: row.worker_session_id,
          generation: outcome.value.generation,
          expiresAt: outcome.value.expiresAt,
        });
        continue;
      }
      // 世代替换与已过期都是「本次不该续」的正常结论，不是故障：
      //   - generation_stale → 另一实例已接手，我方的续租请求本就不该生效
      //   - expired → 上面已单独处理；这里再遇到说明读取与续租之间刚刚过期
      if (outcome.code === 'lease_generation_stale' || outcome.code === 'lease_expired') {
        skipped.push(row.worker_session_id);
        if (outcome.code === 'lease_expired') {
          expired.add(row.worker_session_id);
          if (!reportedExpired.has(row.worker_session_id)) {
            reportedExpired.add(row.worker_session_id);
            this.#onExpiredFound?.({ workerSessionId: row.worker_session_id, expiresAt });
          }
        }
        continue;
      }
      failed.push({ workerSessionId: row.worker_session_id, message: outcome.message });
      this.#onError?.(new Error(outcome.message), { workerSessionId: row.worker_session_id });
    }

    const result: HeartbeatResult = {
      scanned: rows.length,
      sweptExpired,
      renewed,
      skipped,
      expired: [...expired],
      failed,
    };
    this.#onTick?.(result);
    return result;
  }

  /**
   * 到期清扫（§10.6）。
   *
   * **必须逐作业**：`session_leases` 没有租户级放行，租户级上下文下的 UPDATE
   * 影响 0 行且不报错——过期行永久占着 `session_leases_one_active` 槽位，
   * 而 `reissueLease` 的恢复指引「先由 expireLeases 清扫」永远失败
   * （事故 2026-10-05）。与 `#activeLeases` 同构。
   */
  async #sweepExpired(now: Date): Promise<readonly ExpiredLeaseRef[]> {
    const scopes = this.#scopes;
    if (scopes === undefined) {
      const swept = await expireLeases(this.#leases, { now });
      return swept.expiredLeases;
    }
    const engagementIds = await scopes.listEngagementIds();
    const found: ExpiredLeaseRef[] = [];
    for (const engagementId of engagementIds) {
      const swept = await expireLeases(this.#leases, { now, engagementId });
      found.push(...swept.expiredLeases);
    }
    return found;
  }

  /**
   * 活跃租约 = **存活会话**的未吊销租约。
   *
   * 只取存活会话：终态会话（closed / superseded / failed）的租约本该已被吊销，
   * 若还有残留，续它等于让一个已结束的会话继续保持准入能力——那是错的，
   * 应当由 §15.2 的对账清理，而不是被心跳续命。
   */
  async #activeLeases(): Promise<readonly ActiveLeaseRow[]> {
    // 逐作业扫描，理由与 `StartupRecovery.findUnownedSessions` 相同：
    // `session_leases` 与 `worker_sessions` 没有租户级放行，全库一次查询在租户级
    // 作用域下返回零行——那会让心跳**静默不续租**，任何运行超过 TTL 的会话
    // 都会在执行闸门处被判过期。
    const scopes = this.#scopes;
    if (scopes === undefined) return this.#queryActiveLeases();
    const engagementIds = await scopes.listEngagementIds();
    const found: ActiveLeaseRow[] = [];
    for (const engagementId of engagementIds) {
      found.push(...await scopes.run({ engagementId }, () => this.#queryActiveLeases()));
    }
    return found;
  }

  /** 单个作业内的活跃租约查询；调用方负责给出正确作用域。 */
  async #queryActiveLeases(): Promise<readonly ActiveLeaseRow[]> {
    const r = await this.#db.query<ActiveLeaseRow>(
      `select l.worker_session_id, l.generation, l.expires_at
         from pentest.session_leases l
         join pentest.worker_sessions s on s.id = l.worker_session_id
        where l.revoked_at is null
          and s.status = any($1::text[])
        order by l.expires_at`,
      [[...LIVE_SESSION_STATUSES]],
    );
    return r.rows;
  }
}

function positive(value: number, what: string): number {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${what} 必须是正数：${String(value)}`);
  }
  return value;
}

/** pg 的 `integer` 列可能以字符串返回（`int8` 一定如此），统一转换并校验。 */
function toGeneration(value: number | string): number {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isSafeInteger(n) || n <= 0) {
    throw new Error(`租约世代不是正整数：${String(value)}`);
  }
  return n;
}
