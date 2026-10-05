/**
 * 索引调度器测试。
 *
 * 重点锁定四条纪律（不是「函数返回什么」）：
 *   1. **启动必须先扫一遍**（§14.3：不依赖启动前收到的通知）
 *   2. **不重叠**：上一次还在跑时下一次跳过，而不是堆叠
 *   3. **错误不杀循环**：一次失败不能让索引静默停止到进程重启
 *   4. **不阻止宿主退出**：定时器必须 unref
 *
 * 全部用假实现，不需要数据库——调度逻辑与存储无关。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { IndexScheduler, DEFAULT_SCHEDULER_INTERVAL_MS } from '../src/memory/scheduler.ts';
import type { TimerHandle } from '../src/memory/scheduler.ts';
import type { IndexDispatcher, DrainResult } from '../src/memory/dispatcher.ts';
import type { OutboxQueue, OutboxJob } from '../src/memory/outbox.ts';

/** 可控的假定时器：捕获回调，由测试决定何时触发。 */
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
  const handles: Array<{ unrefed: boolean }> = [];
  return {
    created,
    cleared,
    setIntervalFn(fn, ms) {
      const slot = { unrefed: false };
      handles.push(slot);
      const handle = {
        unref: () => { slot.unrefed = true; },
        // 用一个带标记的对象冒充 Timeout：只需满足 TimerHandle 的形状
        [Symbol.toPrimitive]: () => handles.length,
      } as unknown as TimerHandle;
      created.push({ fn, ms });
      return handle;
    },
    clearIntervalFn(h) {
      cleared.push(h);
    },
    fire(index = 0) {
      created[index]?.fn();
    },
    unrefCalled() {
      return handles.length > 0 && handles.every((h) => h.unrefed);
    },
  };
}

/** 假 outbox：记录 sweepExpired 调用。 */
function fakeOutbox(over: {
  sweepThrows?: string;
  sweptCount?: number;
  calls?: { sweeps: number };
} = {}): OutboxQueue {
  const sweptJob = {
    id: '1', engagementId: 'e1', jobType: 'index_event', entityId: 'x',
    idempotencyKey: 'k1', status: 'pending', attempts: 1,
    availableAt: new Date(), leaseUntil: null, lastError: null, createdAt: new Date(),
  } as unknown as OutboxJob;
  return {
    async enqueue() { throw new Error('not used'); },
    async enqueueInTransaction() { throw new Error('not used'); },
    async claim() { return []; },
    async complete() { return false; },
    async fail() { return null; },
    async sweepExpired() {
      if (over.calls !== undefined) over.calls.sweeps += 1;
      if (over.sweepThrows !== undefined) throw new Error(over.sweepThrows);
      const n = over.sweptCount ?? 0;
      return Array.from({ length: n }, () => sweptJob);
    },
    async stats() { throw new Error('not used'); },
  } as unknown as OutboxQueue;
}

/** 假调度器：可控的 drainAll 行为。 */
function fakeDispatcher(over: {
  drainThrows?: string;
  drainThrowsOnce?: boolean;
  perEngagement?: readonly DrainResult[];
  delayMs?: number;
  calls?: { drains: number };
} = {}): IndexDispatcher {
  let thrown = false;
  return {
    async drainAll() {
      if (over.calls !== undefined) over.calls.drains += 1;
      if (over.delayMs !== undefined) {
        await new Promise((r) => setTimeout(r, over.delayMs));
      }
      if (over.drainThrows !== undefined && !(over.drainThrowsOnce === true && thrown)) {
        thrown = true;
        throw new Error(over.drainThrows);
      }
      return over.perEngagement ?? [];
    },
  } as unknown as IndexDispatcher;
}

function drainResult(engagementId: string, over: Partial<DrainResult> = {}): DrainResult {
  return {
    engagementId,
    batches: 1,
    claimed: 1,
    completed: 1,
    failed: 0,
    exhaustedBudget: false,
    ...over,
  };
}

/** 等一次微任务队列排空，让后台的 `void this.tick()` 有机会跑。 */
const flush = (): Promise<void> => new Promise((r) => { setTimeout(r, 0); });

// ───────────────── 启动重扫 ─────────────────

test('start：立即执行一次启动重扫，不等第一个间隔', async () => {
  const calls = { sweeps: 0, drains: 0 };
  const startupRuns: number[] = [];
  const timer = fakeTimer();
  const scheduler = new IndexScheduler(
    {
      dispatcher: fakeDispatcher({ calls }),
      outbox: fakeOutbox({ calls, sweptCount: 2 }),
      onStartup: (r) => startupRuns.push(r.sweptJobs),
    },
    { intervalMs: 60_000, setIntervalFn: timer.setIntervalFn, clearIntervalFn: timer.clearIntervalFn },
  );

  scheduler.start();
  await flush();
  assert.equal(startupRuns.length, 1, '启动必须触发一次重扫');
  assert.equal(startupRuns[0], 2, '应报告回收的租约数');
  assert.equal(calls.drains, 1, '启动重扫要排空队列——不依赖启动前的通知');
  assert.equal(calls.sweeps, 1, '启动时也要清扫过期租约');
});

test('启动重扫把过期租约回收数报告给回调', async () => {
  let swept = -1;
  const scheduler = new IndexScheduler(
    {
      dispatcher: fakeDispatcher(),
      outbox: fakeOutbox({ sweptCount: 3 }),
      onStartup: (r) => { swept = r.sweptJobs; },
    },
    { intervalMs: 60_000, setIntervalFn: fakeTimer().setIntervalFn, clearIntervalFn: fakeTimer().clearIntervalFn },
  );
  scheduler.start();
  await flush();
  assert.equal(swept, 3);
});

test('先清扫、再排空（顺序影响本轮是否白跑）', async () => {
  const order: string[] = [];
  const outbox = fakeOutbox();
  const original = outbox.sweepExpired.bind(outbox);
  (outbox as { sweepExpired: () => Promise<readonly OutboxJob[]> }).sweepExpired = async () => {
    order.push('sweep');
    return original();
  };
  const dispatcher = fakeDispatcher();
  (dispatcher as unknown as { drainAll: () => Promise<readonly DrainResult[]> }).drainAll = async () => {
    order.push('drain');
    return [];
  };

  const scheduler = new IndexScheduler(
    { dispatcher, outbox },
    { intervalMs: 60_000, setIntervalFn: fakeTimer().setIntervalFn, clearIntervalFn: fakeTimer().clearIntervalFn },
  );
  scheduler.start();
  await flush();
  assert.deepEqual(order, ['sweep', 'drain'], '清扫必须在排空之前');
});

// ───────────────── 周期 ─────────────────

test('周期 tick 按配置的间隔触发', async () => {
  const calls = { drains: 0 };
  const timer = fakeTimer();
  const scheduler = new IndexScheduler(
    { dispatcher: fakeDispatcher({ calls }), outbox: fakeOutbox() },
    { intervalMs: 1234, setIntervalFn: timer.setIntervalFn, clearIntervalFn: timer.clearIntervalFn },
  );
  scheduler.start();
  await flush();
  assert.equal(timer.created.length, 1);
  assert.equal(timer.created[0]!.ms, 1234, '间隔必须与配置一致');

  const before = calls.drains;
  timer.fire(0);
  await flush();
  assert.ok(calls.drains > before, '定时器触发应执行一次 tick');
});

test('intervalMs 为 null：只做启动重扫，不装定时器（外部触发的部署形态）', async () => {
  const timer = fakeTimer();
  const calls = { drains: 0 };
  const scheduler = new IndexScheduler(
    { dispatcher: fakeDispatcher({ calls }), outbox: fakeOutbox() },
    { intervalMs: null, setIntervalFn: timer.setIntervalFn, clearIntervalFn: timer.clearIntervalFn },
  );
  scheduler.start();
  await flush();
  assert.equal(timer.created.length, 0, 'null 表示不启用周期');
  assert.equal(calls.drains, 1, '但启动重扫仍必须执行——那不依赖周期');

  // 之后仍可手动驱动
  await scheduler.tick();
  assert.equal(calls.drains, 2);
});

test('省略 intervalMs：用默认间隔（与 null 的区别是「缺省」不是「禁用」）', async () => {
  const timer = fakeTimer();
  const scheduler = new IndexScheduler(
    { dispatcher: fakeDispatcher(), outbox: fakeOutbox() },
    { setIntervalFn: timer.setIntervalFn, clearIntervalFn: timer.clearIntervalFn },
  );
  scheduler.start();
  await flush();
  assert.equal(timer.created.length, 1, '省略时必须装上周期——这是默认行为');
  assert.equal(timer.created[0]!.ms, DEFAULT_SCHEDULER_INTERVAL_MS);
});

test('默认间隔是常量值', () => {
  assert.equal(DEFAULT_SCHEDULER_INTERVAL_MS, 15_000);
});

// ───────────────── 不重叠 ─────────────────

test('不重叠：在途 tick 未结束时，下一次直接返回同一个 Promise', async () => {
  const calls = { drains: 0 };
  const scheduler = new IndexScheduler(
    {
      // 让 drainAll 慢一点，制造在途窗口
      dispatcher: fakeDispatcher({ calls, delayMs: 30 }),
      outbox: fakeOutbox(),
    },
    { intervalMs: 60_000, setIntervalFn: fakeTimer().setIntervalFn, clearIntervalFn: fakeTimer().clearIntervalFn },
  );

  const first = scheduler.tick();
  const second = scheduler.tick();
  assert.equal(first, second, '在途时必须复用在途 Promise，不得起第二次');
  await first;
  assert.equal(calls.drains, 1, '只应执行一次 drainAll');
});

test('不重叠：定时器连续触发也只跑一次', async () => {
  const calls = { drains: 0 };
  const timer = fakeTimer();
  const scheduler = new IndexScheduler(
    { dispatcher: fakeDispatcher({ calls, delayMs: 30 }), outbox: fakeOutbox() },
    { intervalMs: 10, setIntervalFn: timer.setIntervalFn, clearIntervalFn: timer.clearIntervalFn },
  );
  scheduler.tick();
  timer.fire(0);
  timer.fire(0);
  await flush();
  assert.equal(calls.drains, 1, '堆叠的触发不得导致多次 drainAll');
});

// ───────────────── 错误不杀循环 ─────────────────

test('排空失败：回调收到错误，且不抛出（循环继续）', async () => {
  const errors: Array<{ phase: string; message: string }> = [];
  const scheduler = new IndexScheduler(
    {
      dispatcher: fakeDispatcher({ drainThrows: '数据库瞬断' }),
      outbox: fakeOutbox(),
      onError: (e, phase) => errors.push({ phase, message: (e as Error).message }),
    },
    { intervalMs: 60_000, setIntervalFn: fakeTimer().setIntervalFn, clearIntervalFn: fakeTimer().clearIntervalFn },
  );

  const result = await scheduler.tick();
  assert.equal(result.errors, 1);
  assert.deepEqual(errors, [{ phase: 'drain', message: '数据库瞬断' }]);
});

test('清扫失败不阻止排空（claim 本身也会领取过期租约的任务）', async () => {
  const calls = { drains: 0 };
  const errors: string[] = [];
  const scheduler = new IndexScheduler(
    {
      dispatcher: fakeDispatcher({ calls }),
      outbox: fakeOutbox({ sweepThrows: 'sweep 失败' }),
      onError: (_e, phase) => errors.push(phase),
    },
    { intervalMs: 60_000, setIntervalFn: fakeTimer().setIntervalFn, clearIntervalFn: fakeTimer().clearIntervalFn },
  );

  await scheduler.tick();
  assert.deepEqual(errors, ['sweep']);
  assert.equal(calls.drains, 1, '清扫失败后仍须排空');
});

test('失败后循环继续：第二次 tick 仍会执行', async () => {
  const calls = { drains: 0 };
  const scheduler = new IndexScheduler(
    { dispatcher: fakeDispatcher({ calls, drainThrows: '第一次失败', drainThrowsOnce: true }), outbox: fakeOutbox() },
    { intervalMs: 60_000, setIntervalFn: fakeTimer().setIntervalFn, clearIntervalFn: fakeTimer().clearIntervalFn },
  );

  const first = await scheduler.tick();
  assert.equal(first.errors, 1);
  const second = await scheduler.tick();
  assert.equal(second.errors, 0, '第二次应正常执行——循环没被杀掉');
  assert.equal(calls.drains, 2);
});

test('启动重扫失败不影响 start（后台任务，错误进回调）', async () => {
  const errors: string[] = [];
  const timer = fakeTimer();
  const scheduler = new IndexScheduler(
    {
      dispatcher: fakeDispatcher({ drainThrows: '启动时数据库不可用' }),
      outbox: fakeOutbox(),
      onError: (_e, phase) => errors.push(phase),
    },
    { intervalMs: 60_000, setIntervalFn: timer.setIntervalFn, clearIntervalFn: timer.clearIntervalFn },
  );

  assert.doesNotThrow(() => { scheduler.start(); });
  await flush();
  assert.deepEqual(errors, ['drain'], '错误应被报告');
  assert.equal(timer.created.length, 1, '即使启动重扫失败，周期仍应装上');
});

// ───────────────── 停止 ─────────────────

test('stop：清定时器并等待在途 tick 结束', async () => {
  const timer = fakeTimer();
  const scheduler = new IndexScheduler(
    {
      dispatcher: fakeDispatcher({ delayMs: 30 }),
      outbox: fakeOutbox(),
    },
    { intervalMs: 60_000, setIntervalFn: timer.setIntervalFn, clearIntervalFn: timer.clearIntervalFn },
  );
  scheduler.start();
  await flush();
  assert.equal(scheduler.running, false, '启动重扫已结束');

  // 起一次慢 tick，然后在它结束前 stop
  void scheduler.tick();
  assert.equal(scheduler.running, true);
  await scheduler.stop();
  assert.equal(scheduler.running, false, 'stop 必须等它结束——否则会留下悬挂的写操作');
  assert.equal(timer.cleared.length, 1, '定时器必须被清掉');
});

test('stop 幂等：连调两次不抛', async () => {
  const timer = fakeTimer();
  const scheduler = new IndexScheduler(
    { dispatcher: fakeDispatcher(), outbox: fakeOutbox() },
    { intervalMs: 60_000, setIntervalFn: timer.setIntervalFn, clearIntervalFn: timer.clearIntervalFn },
  );
  scheduler.start();
  await flush();
  await scheduler.stop();
  await assert.doesNotReject(() => scheduler.stop());
});

test('stop 后 start 抛错（停止的实例不可重启，避免悬挂状态）', async () => {
  const scheduler = new IndexScheduler(
    { dispatcher: fakeDispatcher(), outbox: fakeOutbox() },
    { intervalMs: 60_000, setIntervalFn: fakeTimer().setIntervalFn, clearIntervalFn: fakeTimer().clearIntervalFn },
  );
  await scheduler.stop();
  assert.throws(() => { scheduler.start(); }, /已停止/);
});

test('start 幂等：重复调用不创建第二个定时器', async () => {
  const timer = fakeTimer();
  const scheduler = new IndexScheduler(
    { dispatcher: fakeDispatcher(), outbox: fakeOutbox() },
    { intervalMs: 60_000, setIntervalFn: timer.setIntervalFn, clearIntervalFn: timer.clearIntervalFn },
  );
  scheduler.start();
  scheduler.start();
  await flush();
  assert.equal(timer.created.length, 1, '重复 start 不得装上两个定时器');
});

// ───────────────── 不阻止宿主退出 ─────────────────

test('定时器必须 unref：否则插件会让 dsh 进程无法正常退出', async () => {
  const timer = fakeTimer();
  const scheduler = new IndexScheduler(
    { dispatcher: fakeDispatcher(), outbox: fakeOutbox() },
    { intervalMs: 60_000, setIntervalFn: timer.setIntervalFn, clearIntervalFn: timer.clearIntervalFn },
  );
  scheduler.start();
  await flush();
  assert.equal(timer.unrefCalled(), true, 'unref 是必需项，不是优化');
});

// ───────────────── 唤醒 ─────────────────

test('wakeNow：立即触发一次 tick（延迟优化，不是可靠性来源）', async () => {
  const calls = { drains: 0 };
  const scheduler = new IndexScheduler(
    { dispatcher: fakeDispatcher({ calls }), outbox: fakeOutbox() },
    { intervalMs: 600_000, setIntervalFn: fakeTimer().setIntervalFn, clearIntervalFn: fakeTimer().clearIntervalFn },
  );
  scheduler.start();
  await flush();
  const before = calls.drains;
  scheduler.wakeNow();
  await flush();
  assert.equal(calls.drains, before + 1, '唤醒应立即多跑一轮');
});

test('stop 后 wakeNow 无效（不在已停止的实例上起新工作）', async () => {
  const calls = { drains: 0 };
  const scheduler = new IndexScheduler(
    { dispatcher: fakeDispatcher({ calls }), outbox: fakeOutbox() },
    { intervalMs: 600_000, setIntervalFn: fakeTimer().setIntervalFn, clearIntervalFn: fakeTimer().clearIntervalFn },
  );
  await scheduler.stop();
  scheduler.wakeNow();
  await flush();
  assert.equal(calls.drains, 0);
});

// ───────────────── tick 结果 ─────────────────

test('tick 结果包含排空明细与错误计数', async () => {
  const scheduler = new IndexScheduler(
    {
      dispatcher: fakeDispatcher({
        perEngagement: [drainResult('e1', { completed: 3 }), drainResult('e2', { failed: 1 })],
      }),
      outbox: fakeOutbox({ sweptCount: 1 }),
    },
    { intervalMs: 60_000, setIntervalFn: fakeTimer().setIntervalFn, clearIntervalFn: fakeTimer().clearIntervalFn },
  );
  const result = await scheduler.tick();
  assert.equal(result.sweptJobs, 1);
  assert.equal(result.errors, 0);
  assert.equal(result.drained.length, 2);
  assert.equal(result.drained[0]!.completed, 3);
  assert.equal(result.drained[1]!.failed, 1);
});

test('onTick 在每次 tick 后回调（含启动那次，便于接指标）', async () => {
  const seen: number[] = [];
  const timer = fakeTimer();
  const scheduler = new IndexScheduler(
    {
      dispatcher: fakeDispatcher({ perEngagement: [drainResult('e1')] }),
      outbox: fakeOutbox(),
      onTick: (r) => seen.push(r.drained.length),
    },
    { intervalMs: 10, setIntervalFn: timer.setIntervalFn, clearIntervalFn: timer.clearIntervalFn },
  );

  scheduler.start();
  await flush();
  assert.equal(seen.length, 1, '启动那次 tick 也必须回调——否则指标漏统计');

  timer.fire(0);
  await flush();
  assert.equal(seen.length, 2, '周期 tick 同样回调');
});

test('onTick 覆盖手动 tick（不只周期路径）', async () => {
  const seen: number[] = [];
  const scheduler = new IndexScheduler(
    {
      dispatcher: fakeDispatcher({ perEngagement: [drainResult('e1')] }),
      outbox: fakeOutbox(),
      onTick: (r) => seen.push(r.drained.length),
    },
    { intervalMs: null, setIntervalFn: fakeTimer().setIntervalFn, clearIntervalFn: fakeTimer().clearIntervalFn },
  );
  await scheduler.tick();
  assert.deepEqual(seen, [1]);
});
