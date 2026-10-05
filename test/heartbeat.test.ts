/**
 * 租约心跳测试。
 *
 * 最重要的是**第一条**：默认 TTL 是 600 秒，而执行闸门在过期时拒绝。
 * `renewLease` 曾被实现却无人调用，后果是「任何运行超过 10 分钟的会话，
 * 其每一次动作都被拒绝」——实际渗透远超 10 分钟，因此这是必然发生的正确性问题。
 *
 * 全部用假实现，不需要数据库。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  LeaseHeartbeat,
  DEFAULT_HEARTBEAT_SECONDS,
  DEFAULT_RENEW_AHEAD_SECONDS,
} from '../src/workflow/heartbeat.ts';
import type { TimerHandle } from '../src/workflow/heartbeat.ts';
import type { DbClient } from '../src/db/port.ts';
import type { LeaseStore } from '../src/workflow/lease.ts';
import { DEFAULTS } from '../src/contracts.ts';
import type { SessionLease } from '../src/contracts.ts';

const NOW = new Date('2026-01-01T00:00:00Z');

/** 可控定时器。 */
function fakeTimer(): {
  readonly created: Array<{ fn: () => void; ms: number }>;
  readonly cleared: TimerHandle[];
  readonly setIntervalFn: (fn: () => void, ms: number) => TimerHandle;
  readonly clearIntervalFn: (h: TimerHandle) => void;
  fire(index?: number): void;
  unrefCalled(): boolean;
} {
  const created: Array<{ fn: () => void; ms: number }> = [];
  const cleared: TimerHandle[] = [];
  const slots: Array<{ unrefed: boolean }> = [];
  return {
    created,
    cleared,
    setIntervalFn(fn, ms) {
      const slot = { unrefed: false };
      slots.push(slot);
      created.push({ fn, ms });
      return { unref: () => { slot.unrefed = true; } } as unknown as TimerHandle;
    },
    clearIntervalFn(h) { cleared.push(h); },
    fire(index = 0) { created[index]?.fn(); },
    unrefCalled() { return slots.length > 0 && slots.every((s) => s.unrefed); },
  };
}

interface LeaseRow {
  readonly worker_session_id: string;
  readonly generation: number;
  readonly expires_at: string;
}

/** 假 db：返回预置的活跃租约行；可注入读取失败。 */
function fakeDb(rows: readonly LeaseRow[], over: { throws?: string; delayMs?: number } = {}): DbClient {
  return {
    async query() {
      if (over.delayMs !== undefined) await new Promise((r) => { setTimeout(r, over.delayMs); });
      if (over.throws !== undefined) throw new Error(over.throws);
      return { rows: [...rows], rowCount: rows.length };
    },
  } as unknown as DbClient;
}

/** 生成一行「剩余 N 秒到期」的活跃租约。 */
function leaseRow(workerSessionId: string, remainingSeconds: number, generation = 1): LeaseRow {
  return {
    worker_session_id: workerSessionId,
    generation,
    expires_at: new Date(NOW.getTime() + remainingSeconds * 1000).toISOString(),
  };
}

/**
 * 可配置的假 LeaseStore。
 *
 * `renewLease` 会走 `store.transaction(tx => ...)`，并在 tx 上依次调用
 * `selectActiveLease` / `touchHeartbeat`。这里只实现那条路径需要的方法；
 * 其余方法给出不抛错的空实现（它们不会被这条路径调用）。
 *
 * `behavior` 决定每次续租事务的行为：
 *   - `'ok'`：活跃租约存在且世代相符 → 续租成功
 *   - `'stale'`：活跃租约存在但世代不符 → `lease_generation_stale`
 *   - `'no_lease'`：没有活跃租约 → `lease_required`
 *   - `'throw'`：事务直接抛错（模拟数据库故障）
 */
function fakeLeases(
  behavior: 'ok' | 'stale' | 'no_lease' | 'throw',
  calls?: Array<{ workerSessionId: string; generation: number }>,
  activeGeneration = 1,
): LeaseStore {
  return {
    async transaction<T>(work: (tx: unknown) => Promise<T>): Promise<T> {
      if (behavior === 'throw') throw new Error('数据库瞬断');
      const tx = {
        async selectActiveLease(workerSessionId: string): Promise<SessionLease | null> {
          if (behavior === 'no_lease') return null;
          return {
            id: 'lease-1',
            workerSessionId,
            taskRef: null,
            // 'stale' 返回一个与请求世代不同的世代，触发 lease_generation_stale。
            // 注意：`selectActiveLease` **不接收** generation——比对发生在
            // `rejectionForLeaseState(active, generation, ...)` 里，因此这里只能
            // 给一个值，由中间层去比对。
            generation: behavior === 'stale' ? 99 : activeGeneration,
            expiresAt: new Date(NOW.getTime() + 600_000),
            revokedAt: null,
            revokedReason: null,
          };
        },
        async selectLease(): Promise<SessionLease | null> { return null; },
        async maxGeneration(): Promise<number> { return 0; },
        async touchHeartbeat(input: { leaseId: string; expiresAt: Date; heartbeatAt: Date }): Promise<void> {
          calls?.push({ workerSessionId: input.leaseId, generation: input.expiresAt.getTime() });
        },
        async lockWorkerSession() { return null; },
        async insertLease() {},
        async revokeActiveLeases() { return []; },
        async revokeExpiredLeases() { return []; },
      };
      return work(tx);
    },
  } as unknown as LeaseStore;
}

/**
 * 世代匹配假存储：只有心跳传对了世代，续租才会成功。
 *
 * 这是个**间接**捕获：`selectActiveLease` 不接收世代，世代比对由
 * `rejectionForLeaseState` 做（比较活跃租约的世代与请求世代）。因此这里
 * 返回一个固定世代的活跃租约——心跳若传错世代，中间层会判 `stale`，
 * 测试就能从 `renewed` 是否包含该会话看出结果。
 */
function generationMatchingLeases(expectedGeneration: number): LeaseStore {
  return {
    async transaction<T>(work: (tx: unknown) => Promise<T>): Promise<T> {
      const tx = {
        async selectActiveLease(workerSessionId: string): Promise<SessionLease | null> {
          return {
            id: 'l', workerSessionId, taskRef: null, generation: expectedGeneration,
            expiresAt: new Date(NOW.getTime() + 600_000), revokedAt: null, revokedReason: null,
          };
        },
        async selectLease(): Promise<SessionLease | null> { return null; },
        async maxGeneration(): Promise<number> { return 0; },
        async touchHeartbeat(): Promise<void> {},
        async lockWorkerSession() { return null; },
        async insertLease() {},
        async revokeActiveLeases() { return []; },
        async revokeExpiredLeases() { return []; },
      };
      return work(tx);
    },
  } as unknown as LeaseStore;
}

function makeHeartbeat(over: {
  rows?: readonly LeaseRow[];
  dbThrows?: string;
  dbDelayMs?: number;
  behavior?: 'ok' | 'stale' | 'no_lease' | 'throw';
  clock?: () => Date;
  onRenewed?: (e: { workerSessionId: string; generation: number; expiresAt: Date }) => void;
  onExpiredFound?: (e: { workerSessionId: string; expiresAt: Date }) => void;
  onError?: (e: unknown, ctx: { workerSessionId: string | null }) => void;
  onTick?: (r: { scanned: number; sweptExpired: readonly string[] }) => void;
  intervalSeconds?: number;
} = {}): { hb: LeaseHeartbeat; timer: ReturnType<typeof fakeTimer> } { 
  const timer = fakeTimer();
  const hb = new LeaseHeartbeat(
    {
      db: fakeDb(over.rows ?? [], {
        ...(over.dbThrows === undefined ? {} : { throws: over.dbThrows }),
        ...(over.dbDelayMs === undefined ? {} : { delayMs: over.dbDelayMs }),
      }),
      leases: over.behavior === undefined || over.behavior === 'ok'
        ? fakeLeases('ok')
        : fakeLeases(over.behavior),
      clock: over.clock ?? (() => NOW),
      ...(over.onRenewed === undefined ? {} : { onRenewed: over.onRenewed }),
      ...(over.onExpiredFound === undefined ? {} : { onExpiredFound: over.onExpiredFound }),
      ...(over.onError === undefined ? {} : { onError: over.onError }),
      ...(over.onTick === undefined ? {} : { onTick: over.onTick }),
    },
    { intervalSeconds: over.intervalSeconds ?? 60, setIntervalFn: timer.setIntervalFn, clearIntervalFn: timer.clearIntervalFn },
  );
  return { hb, timer };
}

const flush = (): Promise<void> => new Promise((r) => { setTimeout(r, 0); });

// ─────────────── 核心：防住「10 分钟后全部失败」 ───────────────

test('默认参数与契约一致，且续租窗口小于 TTL', () => {
  assert.equal(DEFAULT_HEARTBEAT_SECONDS, DEFAULTS.leaseHeartbeatSeconds);
  assert.equal(DEFAULT_HEARTBEAT_SECONDS, 60);
  assert.equal(DEFAULT_RENEW_AHEAD_SECONDS, 180, '3 × 心跳间隔 = 三次续租机会');
  assert.ok(
    DEFAULT_RENEW_AHEAD_SECONDS < DEFAULTS.leaseTtlSeconds,
    '续租窗口必须小于 TTL，否则每次心跳都会续（无意义写入）',
  );
});

test('临界租约被续租（这是本模块存在的理由）', async () => {
  const { hb } = makeHeartbeat({ rows: [leaseRow('s1', 100)] });
  const result = await hb.tick();
  assert.deepEqual(result.renewed, ['s1'], '剩余 100 秒的租约必须被续——否则 TTL 一到所有动作都失败');
  assert.equal(result.expired.length, 0);
  assert.equal(result.failed.length, 0);
});

test('剩余充足的租约被跳过（避免无意义写入）', async () => {
  const { hb } = makeHeartbeat({ rows: [leaseRow('s1', 500)] });
  const result = await hb.tick();
  assert.deepEqual(result.skipped, ['s1']);
  assert.equal(result.renewed.length, 0, '剩余 500 秒 > 窗口 180 秒，不该发起续租');
});
test('已过期租约清扫失败不阻止续租轮次', async () => {
  const errors: string[] = [];
  const { hb } = makeHeartbeat({
    rows: [leaseRow('s1', 50), leaseRow('s2', 50)],
    behavior: 'throw',
    onError: (e) => errors.push((e as Error).message),
  });
  const result = await hb.tick();
  assert.equal(result.scanned, 2);
  assert.equal(result.failed.length, 2);
  assert.deepEqual(errors, ['数据库瞬断', '数据库瞬断', '数据库瞬断']);
});

test('已过期租约回调携带原始到期时间而非清扫时刻', async () => {
  const expiredSeen: Array<{ workerSessionId: string; expiresAt: Date }> = [];
  const { hb } = makeHeartbeat({
    rows: [leaseRow('s1', -5)],
    onExpiredFound: (e) => expiredSeen.push(e),
  });
  const result = await hb.tick();
  assert.deepEqual(result.expired, ['s1']);
  assert.equal(expiredSeen.length, 1);
  assert.equal(expiredSeen[0]?.workerSessionId, 's1');
  assert.equal(expiredSeen[0]?.expiresAt.getTime(), NOW.getTime() - 5_000);
  assert.equal(result.renewed.length, 0, '不得自动复活');
});

test('恰好到期（剩余 0）按已过期处理', async () => {
  const { hb } = makeHeartbeat({ rows: [leaseRow('s1', 0)] });
  const result = await hb.tick();
  assert.deepEqual(result.expired, ['s1'], '闭区间：等于到期时刻即失效');
});

// ─────────────── 多实例安全 ───────────────

test('世代替换视为跳过而非错误（另一实例已接手）', async () => {
  const errors: unknown[] = [];
  const { hb } = makeHeartbeat({
    rows: [leaseRow('s1', 50)],
    behavior: 'stale',
    onError: (e) => errors.push(e),
  });
  const result = await hb.tick();
  assert.deepEqual(result.skipped, ['s1']);
  assert.equal(result.failed.length, 0, '世代推进是正常结论，不是故障');
  assert.equal(errors.length, 0, '不该当作错误上报——那会产生噪音告警');
});

test('续租时带回读到的世代（不是猜的）', async () => {
  // 行里的世代是 7；假存储的活跃租约也是世代 7。心跳若传别的值，
  // 中间层会判 `lease_generation_stale`，续租就不会出现在 `renewed` 里。
  const timer = fakeTimer();
  const hb = new LeaseHeartbeat(
    { db: fakeDb([leaseRow('s1', 50, 7)]), leases: generationMatchingLeases(7), clock: () => NOW },
    { intervalSeconds: 60, setIntervalFn: timer.setIntervalFn, clearIntervalFn: timer.clearIntervalFn },
  );
  const result = await hb.tick();
  assert.deepEqual(result.renewed, ['s1'], '必须用读到的世代，否则会一直得到 generation_stale');
  assert.equal(result.skipped.length, 0);
});

// ─────────────── 失败处理 ───────────────

test('续租返回拒绝码（非预期）进 failed，且原始错误交给回调', async () => {
  const errors: Array<{ id: string | null; message: string }> = [];
  const { hb } = makeHeartbeat({
    rows: [leaseRow('s1', 50)],
    behavior: 'no_lease',
    onError: (e, ctx) => errors.push({ id: ctx.workerSessionId, message: (e as Error).message }),
  });
  const result = await hb.tick();
  assert.equal(result.failed.length, 1);
  assert.equal(result.failed[0]!.workerSessionId, 's1');
  assert.equal(errors.length, 1);
  assert.equal(errors[0]!.id, 's1');
});

test('续租**抛异常**（数据库故障）被逐条捕获，不中止整轮', async () => {
  // 这条回归同时覆盖新增的过期清扫：清扫失败不能阻断后续两条续租尝试。
  const errors: string[] = [];
  const { hb } = makeHeartbeat({
    rows: [leaseRow('s1', 50), leaseRow('s2', 50)],
    behavior: 'throw',
    onError: (e) => errors.push((e as Error).message),
  });

  const result = await hb.tick(); // 不该抛
  assert.equal(result.scanned, 2, '两个会话都被扫到');
  assert.equal(result.failed.length, 2, '两次失败都被记录，而不是整轮中止');
  assert.deepEqual(errors, ['数据库瞬断', '数据库瞬断', '数据库瞬断']);
});

test('读取失败：报告错误但不抛（心跳失败不该让进程崩）', async () => {
  const errors: string[] = [];
  const { hb } = makeHeartbeat({
    dbThrows: '连接池耗尽',
    onError: (e) => errors.push((e as Error).message),
  });
  const result = await hb.tick();
  assert.equal(result.scanned, 0);
  assert.deepEqual(errors, ['连接池耗尽']);
});

test('单个会话失败不影响其余（可配置假存储：交替成功/失败）', async () => {
  // 「一个失败不影响其余」是后台循环的基本要求：否则一次故障会让剩余会话
  // 的租约全部过期，而那正是本模块要防的事。
  let call = 0;
  const alternating = {
    async transaction<T>(work: (tx: unknown) => Promise<T>): Promise<T> {
      call += 1;
      const succeed = call % 2 === 0;
      const tx = {
        async selectActiveLease(workerSessionId: string): Promise<SessionLease | null> {
          if (!succeed) return null; // 奇数轮：失败
          return {
            id: 'l', workerSessionId, taskRef: null, generation: 1,
            expiresAt: new Date(NOW.getTime() + 600_000), revokedAt: null, revokedReason: null,
          };
        },
        async selectLease(): Promise<SessionLease | null> { return null; },
        async maxGeneration(): Promise<number> { return 0; },
        async touchHeartbeat(): Promise<void> {},
        async lockWorkerSession() { return null; },
        async insertLease() {},
        async revokeActiveLeases() { return []; },
        async revokeExpiredLeases() { return []; },
      };
      return work(tx);
    },
  } as unknown as LeaseStore;

  const timer = fakeTimer();
  const hb = new LeaseHeartbeat(
    { db: fakeDb([leaseRow('a', 50), leaseRow('b', 50), leaseRow('c', 50), leaseRow('d', 50)]), leases: alternating, clock: () => NOW },
    { intervalSeconds: 60, setIntervalFn: timer.setIntervalFn, clearIntervalFn: timer.clearIntervalFn },
  );
  const result = await hb.tick();
  assert.equal(result.renewed.length, 2, '偶数轮成功');
  assert.equal(result.failed.length, 2, '奇数轮失败');
  assert.equal(result.renewed.length + result.failed.length, 4, '四个都被处理，无一被跳过');
});

// ─────────────── 定时器与生命周期 ───────────────

test('start：立即跑一次（上次进程留下的临近过期租约不该等一个间隔）', async () => {
  const timer = fakeTimer();
  const calls: Array<{ workerSessionId: string; generation: number }> = [];
  const hb = new LeaseHeartbeat(
    { db: fakeDb([leaseRow('s1', 50)]), leases: fakeLeases('ok', calls), clock: () => NOW },
    { intervalSeconds: 60, setIntervalFn: timer.setIntervalFn, clearIntervalFn: timer.clearIntervalFn },
  );
  hb.start();
  await flush();
  assert.equal(calls.length, 1, '启动时必须立即跑一次');
});

test('定时器间隔与配置一致，且必须 unref', async () => {
  const { hb, timer } = makeHeartbeat({ intervalSeconds: 45 });
  hb.start();
  await flush();
  assert.equal(timer.created.length, 1);
  assert.equal(timer.created[0]!.ms, 45_000);
  assert.equal(timer.unrefCalled(), true, '不 unref 会让 dsh 进程无法正常退出');
});

test('start 幂等：重复调用不装两个定时器', async () => {
  const { hb, timer } = makeHeartbeat();
  hb.start();
  hb.start();
  await flush();
  assert.equal(timer.created.length, 1);
});

test('不重叠：在途时复用同一次心跳', async () => {
  const timer = fakeTimer();
  let queries = 0;
  const db = {
    async query() {
      queries += 1;
      await new Promise((r) => { setTimeout(r, 20); });
      return { rows: [], rowCount: 0 };
    },
  } as unknown as DbClient;
  const hb = new LeaseHeartbeat(
    { db, leases: fakeLeases('ok') },
    { intervalSeconds: 60, setIntervalFn: timer.setIntervalFn, clearIntervalFn: timer.clearIntervalFn },
  );
  const a = hb.tick();
  const b = hb.tick();
  assert.equal(a, b, '在途时必须复用在途 Promise');
  await a;
  assert.equal(queries, 1);
});

test('stop：清定时器并等在途结束；幂等', async () => {
  const timer = fakeTimer();
  const hb = new LeaseHeartbeat(
    { db: fakeDb([], { delayMs: 20 }), leases: fakeLeases('ok') },
    { intervalSeconds: 60, setIntervalFn: timer.setIntervalFn, clearIntervalFn: timer.clearIntervalFn },
  );
  hb.start();
  void hb.tick();
  await flush();
  assert.equal(hb.running, true, '在途心跳仍在跑');
  await hb.stop();
  assert.equal(hb.running, false, 'stop 必须等在途心跳结束——否则会留下悬挂的写操作');
  assert.equal(timer.cleared.length, 1);
  await assert.doesNotReject(() => hb.stop());
});

test('stop 后 start 抛错（停止的实例不可重启）', async () => {
  const { hb } = makeHeartbeat();
  await hb.stop();
  assert.throws(() => { hb.start(); }, /已停止/);
});

test('非法参数在构造时拒绝', () => {
  const deps = { db: fakeDb([]), leases: fakeLeases('ok') };
  const timer = fakeTimer();
  const timers = { setIntervalFn: timer.setIntervalFn, clearIntervalFn: timer.clearIntervalFn };
  assert.throws(() => new LeaseHeartbeat(deps, { ...timers, intervalSeconds: 0 }), /正数/);
  assert.throws(() => new LeaseHeartbeat(deps, { ...timers, intervalSeconds: -1 }), /正数/);
  assert.throws(() => new LeaseHeartbeat(deps, { ...timers, renewAheadSeconds: 0 }), /正数/);
  assert.throws(() => new LeaseHeartbeat(deps, { ...timers, ttlSeconds: 0 }), /正数/);
});

test('onTick 每次回调（便于接指标）', async () => {
  const seen: number[] = [];
  const { hb } = makeHeartbeat({
    rows: [leaseRow('s1', 500)],
    onTick: (r) => seen.push(r.scanned),
  });
  await hb.tick();
  await hb.tick();
  assert.deepEqual(seen, [1, 1]);
});

test('onRenewed 报告新到期时间与世代', async () => {
  const events: Array<{ generation: number; expiresAt: Date }> = [];
  const timer = fakeTimer();
  const hb = new LeaseHeartbeat(
    {
      db: fakeDb([leaseRow('s1', 50, 3)]),
      leases: generationMatchingLeases(3),
      clock: () => NOW,
      onRenewed: (e) => events.push(e),
    },
    { intervalSeconds: 60, setIntervalFn: timer.setIntervalFn, clearIntervalFn: timer.clearIntervalFn },
  );
  await hb.tick();
  assert.equal(events.length, 1);
  assert.equal(events[0]!.generation, 3, '报告的是续租后活跃租约的世代');
  assert.ok(events[0]!.expiresAt.getTime() > NOW.getTime());
});

test('intervalSeconds getter 暴露生效值（供装配层日志）', () => {
  const { hb } = makeHeartbeat({ intervalSeconds: 42 });
  assert.equal(hb.intervalSeconds, 42);
});

// ─────────────── 到期清扫必须逐作业（事故 2026-10-05） ───────────────

test('到期清扫逐作业执行：租户级上下文下的清扫影响 0 行，过期行永久占槽（事故 2026-10-05）', async () => {
  // 事故：心跳在租户级上下文里跑 `expireLeases`，而 `session_leases` 没有租户级放行——
  // UPDATE 影响 0 行且不报错。过期行因此永久占据 `session_leases_one_active` 槽位，
  // `reissueLease` 的恢复指引「先由 expireLeases 清扫」永远失败。
  const scopesSeen: Array<string | undefined> = [];
  const expiredOne = { leaseId: 'l-1', workerSessionId: 'w-1', expiresAt: NOW };
  let sweepCalls = 0;
  const leases = {
    async transaction<T>(
      work: (tx: unknown) => Promise<T>,
      scope?: string | { engagementId?: string },
    ): Promise<T> {
      scopesSeen.push(typeof scope === 'string' ? scope : scope?.engagementId);
      sweepCalls += 1;
      const call = sweepCalls;
      const tx = {
        async revokeExpiredLeases() { return call === 1 ? [expiredOne] : []; },
        async lockWorkerSession() { return null; },
        async selectActiveLease() { return null; },
        async selectLease() { return null; },
        async maxGeneration() { return 0; },
        async insertLease() {},
        async revokeActiveLeases() { return []; },
        async touchHeartbeat() {},
      };
      return work(tx);
    },
  } as unknown as LeaseStore;
  const timer = fakeTimer();
  const hb = new LeaseHeartbeat(
    {
      db: fakeDb([]),
      leases,
      clock: () => NOW,
      rlsScope: {
        run: async (_scope, work) => work(),
        listEngagementIds: async () => ['eng-1', 'eng-2'],
      },
    },
    { intervalSeconds: 60, setIntervalFn: timer.setIntervalFn, clearIntervalFn: timer.clearIntervalFn },
  );

  const result = await hb.tick();
  assert.deepEqual(scopesSeen, ['eng-1', 'eng-2'], '清扫必须逐作业给出 RLS 作用域');
  assert.deepEqual(result.sweptExpired, ['w-1'], '清扫结果按作业聚合');
});
