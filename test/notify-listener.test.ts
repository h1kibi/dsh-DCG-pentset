/**
 * NOTIFY 唤醒适配器测试（**纯逻辑**：假连接 + 假定时器，不需要数据库）。
 *
 * 重点锁定四条纪律（不是「函数返回什么」）：
 *   1. **通知只是延迟优化**：收到就唤醒，负载不看；丢了靠周期扫描兜底
 *   2. **断线不是终态**：断开后按指数退避重连，退避有上限
 *   3. **幂等与安全**：start 不装两条连接、stop 等关闭完成且幂等、停止不可重启
 *   4. **不阻止宿主退出**：重连定时器必须 unref
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Client } from 'pg';

import {
  NotifyListener,
  NOTIFY_CHANNEL,
  DEFAULT_NOTIFY_BACKOFF,
  createPgNotifyConnection,
} from '../src/memory/notify-listener.ts';
import type {
  NotifyConnection,
  NotifyErrorPhase,
  NotifyTarget,
} from '../src/memory/notify-listener.ts';
import type { TimerHandle } from '../src/memory/scheduler.ts';

/**
 * 让出一个事件循环轮次：后台的连接循环全在微任务里推进，`setImmediate` 足够，
 * 而且不消耗真实时间（本仓 `lib` 是 es2023，没有 `Promise.withResolvers`，
 * 与 `docker-sandbox.ts` 的取舍一致）。
 */
const flush = (): Promise<void> =>
  new Promise((resolve) => {
    setImmediate(resolve);
  });

/** 可控的假定时器：捕获重连回调，由测试决定何时触发。 */
interface FakeTimer {
  readonly fn: () => void;
  readonly ms: number;
  unrefed: boolean;
  cleared: boolean;
  fired: boolean;
  unref(): void;
}

function fakeTimers(): {
  readonly entries: FakeTimer[];
  readonly setTimerFn: (fn: () => void, ms: number) => TimerHandle;
  readonly clearTimerFn: (handle: TimerHandle) => void;
  firePending(): void;
} {
  const entries: FakeTimer[] = [];
  const byHandle = new Map<TimerHandle, FakeTimer>();
  return {
    entries,
    setTimerFn(fn, ms) {
      const entry: FakeTimer = {
        fn,
        ms,
        unrefed: false,
        cleared: false,
        fired: false,
        unref() { this.unrefed = true; },
      };
      entries.push(entry);
      // 假句柄只需满足 `TimerHandle` 的不透明形状：它在运行时没有可校验的结构
      const handle = entry as unknown as TimerHandle;
      byHandle.set(handle, entry);
      return handle;
    },
    clearTimerFn(handle) {
      const entry = byHandle.get(handle);
      if (entry !== undefined) entry.cleared = true;
    },
    firePending() {
      const entry = entries.find((e) => !e.cleared && !e.fired);
      if (entry === undefined) throw new Error('没有待触发的重连定时器');
      entry.fired = true;
      entry.fn();
    },
  };
}

/** 一个可放行的闸门，用来观察「等待中」的中间态。 */
function gate(): { promise: Promise<void>; release: () => void } {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release };
}

/** 假唤醒目标：记录调用次数，可按需抛错。 */
function fakeTarget(throwOnWake?: Error): { target: NotifyTarget; calls: { count: number } } {
  const calls = { count: 0 };
  return {
    calls,
    target: {
      wakeNow() {
        calls.count += 1;
        if (throwOnWake !== undefined) throw throwOnWake;
      },
    },
  };
}

/**
 * 假连接：`listen()` 的 Promise 表示连接寿命（端口契约），由测试决定何时结算。
 */
class FakeConnection implements NotifyConnection {
  /** 每次 `listen` 收到的通道名，按调用顺序。 */
  readonly channels: string[] = [];
  /** `close()` 的调用次数（含幂等重复调用）。 */
  closeCount = 0;
  closed = false;
  /** 设好之后 `close()` 会挂起，直到测试放行——用来观察「stop 等关闭完成」。 */
  closeGate: { promise: Promise<void>; release: () => void } | null = null;
  /** 非 null 时 `close()` 在结算寿命之后抛这个错。 */
  closeError: Error | null = null;

  #handler: ((payload: string) => void) | null = null;
  #lastHandler: ((payload: string) => void) | null = null;
  #settle: ((error: Error | null) => void) | null = null;

  async listen(channel: string, handler: (payload: string) => void): Promise<void> {
    this.channels.push(channel);
    this.#handler = handler;
    this.#lastHandler = handler;
    await new Promise<void>((resolve, reject) => {
      this.#settle = (error) => {
        if (error === null) resolve();
        else reject(error);
      };
    });
  }

  async close(): Promise<void> {
    this.closeCount += 1;
    if (this.closed) return;
    this.closed = true;
    if (this.closeGate !== null) await this.closeGate.promise;
    this.#handler = null;
    this.#release(null);
    if (this.closeError !== null) throw this.closeError;
  }

  /** 模拟服务端正常关闭（维护、重启前排水）。 */
  end(): void {
    this.#handler = null;
    this.#release(null);
  }

  /** 模拟异常断开。 */
  fail(error: Error): void {
    this.#handler = null;
    this.#release(error);
  }

  /** 模拟收到一条通知；已断开则丢弃（与真实 socket 行为一致）。 */
  notify(payload = ''): void {
    this.#handler?.(payload);
  }

  /** 模拟**陈旧连接**的残余回调：连接已废弃也照样投递。 */
  deliverRaw(payload = ''): void {
    this.#lastHandler?.(payload);
  }

  #release(error: Error | null): void {
    const settle = this.#settle;
    this.#settle = null;
    settle?.(error);
  }
}

/** 假连接工厂：每次 `connect()` 给一条新连接。 */
function fakeConnect(): {
  readonly connect: () => Promise<NotifyConnection>;
  readonly created: FakeConnection[];
  readonly attempts: { count: number };
  failNext(count: number, error?: Error): void;
  holdNextConnect(): () => void;
} {
  const created: FakeConnection[] = [];
  const failures: Error[] = [];
  const attempts = { count: 0 };
  let held: { promise: Promise<void>; release: () => void } | null = null;
  return {
    created,
    attempts,
    async connect() {
      attempts.count += 1;
      if (held !== null) {
        const waiting = held;
        held = null;
        await waiting.promise;
      }
      const failure = failures.shift();
      if (failure !== undefined) throw failure;
      const connection = new FakeConnection();
      created.push(connection);
      return connection;
    },
    failNext(count, error = new Error('连接失败')) {
      for (let i = 0; i < count; i += 1) failures.push(error);
    },
    holdNextConnect() {
      const waiting = gate();
      held = waiting;
      return waiting.release;
    },
  };
}

/** 标准装配：假连接 + 假定时器 + 假目标，并记录观测回调。 */
function harness(options: {
  channel?: string;
  backoff?: { initialDelayMs?: number; maxDelayMs?: number };
  target?: NotifyTarget;
} = {}): {
  readonly listener: NotifyListener;
  readonly connections: ReturnType<typeof fakeConnect>;
  readonly timers: ReturnType<typeof fakeTimers>;
  readonly errors: Array<{ error: unknown; phase: NotifyErrorPhase }>;
  readonly connected: { count: number };
  readonly disconnected: unknown[];
} {
  const connections = fakeConnect();
  const timers = fakeTimers();
  const errors: Array<{ error: unknown; phase: NotifyErrorPhase }> = [];
  const connected = { count: 0 };
  const disconnected: unknown[] = [];
  const target = options.target ?? fakeTarget().target;
  const listener = new NotifyListener({
    target,
    connect: connections.connect,
    setTimerFn: timers.setTimerFn,
    clearTimerFn: timers.clearTimerFn,
    onError: (error, phase) => { errors.push({ error, phase }); },
    onConnected: () => { connected.count += 1; },
    onDisconnected: (error) => { disconnected.push(error); },
    ...(options.channel === undefined ? {} : { channel: options.channel }),
    ...(options.backoff === undefined ? {} : { backoff: options.backoff }),
  });
  return { listener, connections, timers, errors, connected, disconnected };
}

// ───────────────── 契约常量 ─────────────────

test('默认通道名与退避常量（装配层与入队侧共用同一个名字）', () => {
  assert.equal(NOTIFY_CHANNEL, 'pentest_outbox');
  // 全小写标识符：`LISTEN <标识符>` 会折叠大小写，而 `pg_notify(<字符串>)` 不会
  assert.match(NOTIFY_CHANNEL, /^[a-z][a-z0-9_]*$/);
  assert.ok(Buffer.byteLength(NOTIFY_CHANNEL, 'utf8') <= 63);
  assert.deepEqual(DEFAULT_NOTIFY_BACKOFF, { initialDelayMs: 1_000, maxDelayMs: 30_000 });
});

// ───────────────── start / 订阅 ─────────────────

test('start 之前：connected 为 false，且不建立连接', async () => {
  const h = harness();
  assert.equal(h.listener.connected, false);
  await flush();
  assert.equal(h.connections.attempts.count, 0);
  await h.listener.stop();
});

test('start：建立连接并按固定通道订阅', async () => {
  const h = harness();
  h.listener.start();
  await flush();
  assert.equal(h.connections.created.length, 1);
  assert.deepEqual(h.connections.created[0]?.channels, [NOTIFY_CHANNEL]);
});

test('start：连接就绪后 connected 为 true，并回调 onConnected', async () => {
  const h = harness();
  h.listener.start();
  assert.equal(h.listener.connected, false, '连接是后台建立的，start 同步返回');
  await flush();
  assert.equal(h.listener.connected, true);
  assert.equal(h.connected.count, 1);
  await h.listener.stop();
});

test('自定义通道名覆盖默认常量', async () => {
  const h = harness({ channel: 'pentest_custom' });
  h.listener.start();
  await flush();
  assert.deepEqual(h.connections.created[0]?.channels, ['pentest_custom']);
  await h.listener.stop();
});

test('空通道名：构造即抛（空通道既订阅不到也发不出）', () => {
  const connections = fakeConnect();
  assert.throws(
    () => new NotifyListener({ target: fakeTarget().target, connect: connections.connect, channel: '' }),
    /通道名不能为空/,
  );
});

// ───────────────── 唤醒 ─────────────────

test('收到通知 → 调用 wakeNow（负载内容一概不看）', async () => {
  const target = fakeTarget();
  const h = harness({ target: target.target });
  h.listener.start();
  await flush();
  h.connections.created[0]?.notify('{"job_id":"42"}');
  assert.equal(target.calls.count, 1);
  // 空负载同样算唤醒信号：通知只是「去队列看一眼」，不是事实来源
  h.connections.created[0]?.notify('');
  assert.equal(target.calls.count, 2);
  await h.listener.stop();
});

test('连续多条通知 → 每次都调用 wakeNow（去重交给调度器的不重叠纪律）', async () => {
  const target = fakeTarget();
  const h = harness({ target: target.target });
  h.listener.start();
  await flush();
  const connection = h.connections.created[0];
  connection?.notify('a');
  connection?.notify('b');
  connection?.notify('c');
  assert.equal(target.calls.count, 3);
  await h.listener.stop();
});

test('wakeNow 抛错：onError(notify)，连接循环不受影响且后续通知仍送达', async () => {
  const boom = new Error('tick 崩了');
  const target = fakeTarget(boom);
  const h = harness({ target: target.target });
  h.listener.start();
  await flush();
  const connection = h.connections.created[0];
  connection?.notify('a');
  connection?.notify('b');
  assert.equal(target.calls.count, 2);
  assert.deepEqual(h.errors.map((e) => e.phase), ['notify', 'notify']);
  assert.equal(h.listener.connected, true, '唤醒目标的事故不能把连接循环带走');
  assert.equal(h.timers.entries.length, 0, '不应因此安排重连');
  await h.listener.stop();
});

// ───────────────── start / stop 幂等 ─────────────────

test('start 幂等：重复调用只建立一条连接', async () => {
  const h = harness();
  h.listener.start();
  h.listener.start();
  h.listener.start();
  await flush();
  assert.equal(h.connections.attempts.count, 1);
  assert.equal(h.connections.created.length, 1);
  await h.listener.stop();
});

test('stop：关闭连接并置 connected 为 false', async () => {
  const h = harness();
  h.listener.start();
  await flush();
  await h.listener.stop();
  assert.equal(h.listener.connected, false);
  assert.equal(h.connections.created[0]?.closed, true);
});

test('stop 等待关闭完成（close 未结算前 stop 不返回）', async () => {
  const h = harness();
  h.listener.start();
  await flush();
  const connection = h.connections.created[0];
  assert.ok(connection !== undefined);
  connection.closeGate = gate();

  const settled = { value: false };
  const stopping = h.listener.stop().then(() => { settled.value = true; });
  await flush();
  assert.equal(settled.value, false, '关闭还没结算，stop 不能提前返回');

  connection.closeGate.release();
  await stopping;
  assert.equal(settled.value, true);
});

test('stop 幂等：连调两次不抛，第二次不再触发关闭', async () => {
  const h = harness();
  h.listener.start();
  await flush();
  await h.listener.stop();
  const closes = h.connections.created[0]?.closeCount;
  await h.listener.stop();
  assert.equal(h.connections.created[0]?.closeCount, closes);
});

test('stop 未 start 时也完成，但之后不可再 start', async () => {
  const h = harness();
  await h.listener.stop();
  assert.throws(() => h.listener.start(), /已停止/);
});

test('stop 后 start 抛错（停止的实例不可重启，避免悬挂状态）', async () => {
  const h = harness();
  h.listener.start();
  await flush();
  await h.listener.stop();
  assert.throws(() => h.listener.start(), /已停止/);
});

test('stop 后到达的通知不再唤醒（陈旧连接的残余回调被丢弃）', async () => {
  const target = fakeTarget();
  const h = harness({ target: target.target });
  h.listener.start();
  await flush();
  const connection = h.connections.created[0];
  connection?.notify('before');
  await h.listener.stop();
  connection?.deliverRaw('after');
  assert.equal(target.calls.count, 1);
});

// ───────────────── 断开与重连 ─────────────────

test('连接正常结束 → 调度一次重连（退避起点）', async () => {
  const h = harness();
  h.listener.start();
  await flush();
  h.connections.created[0]?.end();
  await flush();
  assert.equal(h.listener.connected, false);
  assert.equal(h.connections.created.length, 1, '重连要走退避，不是立刻打转');
  assert.deepEqual(h.timers.entries.map((t) => t.ms), [DEFAULT_NOTIFY_BACKOFF.initialDelayMs]);
  assert.deepEqual(h.disconnected, [null], '正常结束的断开原因记为 null');

  h.timers.firePending();
  await flush();
  assert.equal(h.connections.created.length, 2);
  assert.equal(h.listener.connected, true);
  await h.listener.stop();
});

test('连接异常断开 → onError(listen) 与 onDisconnected(原始错误)', async () => {
  const h = harness();
  h.listener.start();
  await flush();
  const boom = new Error('server closed the connection unexpectedly');
  h.connections.created[0]?.fail(boom);
  await flush();
  assert.deepEqual(h.errors.map((e) => e.phase), ['listen']);
  assert.equal(h.errors[0]?.error, boom);
  assert.deepEqual(h.disconnected, [boom]);
  assert.equal(h.timers.entries.length, 1, '异常断开同样要重连');
  await h.listener.stop();
});

test('陈旧连接的回调被丢弃：重连后旧连接上的通知不再唤醒', async () => {
  const target = fakeTarget();
  const h = harness({ target: target.target });
  h.listener.start();
  await flush();
  const stale = h.connections.created[0];
  stale?.end();
  await flush();
  h.timers.firePending();
  await flush();

  stale?.deliverRaw('stale');
  assert.equal(target.calls.count, 0, '废弃连接上的残余回调必须被身份检查挡住');
  h.connections.created[1]?.notify('fresh');
  assert.equal(target.calls.count, 1);
  await h.listener.stop();
});

test('重连成功后通知仍能送达（新连接是有效订阅）', async () => {
  const target = fakeTarget();
  const h = harness({ target: target.target });
  h.listener.start();
  await flush();
  h.connections.created[0]?.fail(new Error('断了'));
  await flush();
  h.timers.firePending();
  await flush();
  assert.equal(h.connections.created.length, 2);
  assert.equal(h.listener.connected, true);
  assert.deepEqual(h.connections.created[1]?.channels, [NOTIFY_CHANNEL]);
  assert.equal(h.connected.count, 2, '每次连上（含重连）都要能被观测到');
  h.connections.created[1]?.notify('work');
  assert.equal(target.calls.count, 1);
  await h.listener.stop();
});

// ───────────────── 退避 ─────────────────

test('退避序列递增：1s、2s、4s、8s…', async () => {
  const h = harness();
  h.connections.failNext(3);
  h.listener.start();
  await flush();
  for (let i = 0; i < 3; i += 1) {
    h.timers.firePending();
    await flush();
  }
  assert.deepEqual(h.timers.entries.map((t) => t.ms), [1_000, 2_000, 4_000]);
  await h.listener.stop();
});

test('退避封顶：达到 maxDelayMs 后不再增长', async () => {
  const h = harness();
  h.connections.failNext(8);
  h.listener.start();
  await flush();
  for (let i = 0; i < 7; i += 1) {
    h.timers.firePending();
    await flush();
  }
  const delays = h.timers.entries.map((t) => t.ms);
  assert.deepEqual(delays.slice(0, 5), [1_000, 2_000, 4_000, 8_000, 16_000]);
  assert.equal(delays[delays.length - 1], DEFAULT_NOTIFY_BACKOFF.maxDelayMs);
  assert.ok(delays.every((ms, i) => i === 0 || ms >= (delays[i - 1] ?? 0)), '不得回退');
  await h.listener.stop();
});

test('自定义退避参数生效（起点与上限）', async () => {
  const h = harness({ backoff: { initialDelayMs: 5, maxDelayMs: 20 } });
  h.connections.failNext(3);
  h.listener.start();
  await flush();
  for (let i = 0; i < 3; i += 1) {
    h.timers.firePending();
    await flush();
  }
  assert.deepEqual(h.timers.entries.map((t) => t.ms), [5, 10, 20]);
  await h.listener.stop();
});

test('退避参数非法：构造即抛（封顶小于起点会让序列无法收敛）', () => {
  const connections = fakeConnect();
  const target = fakeTarget().target;
  assert.throws(
    () => new NotifyListener({ target, connect: connections.connect, backoff: { initialDelayMs: 100, maxDelayMs: 50 } }),
    /退避上限不合法/,
  );
  assert.throws(
    () => new NotifyListener({ target, connect: connections.connect, backoff: { initialDelayMs: 0 } }),
    /退避起点不合法/,
  );
});

test('连接成功后退避重置：下一次断开回到起点', async () => {
  const h = harness();
  h.listener.start();
  await flush();
  h.connections.created[0]?.end();
  await flush();
  h.timers.firePending();
  await flush();
  h.connections.created[1]?.end();
  await flush();
  assert.deepEqual(h.timers.entries.map((t) => t.ms), [1_000, 1_000]);
  await h.listener.stop();
});

test('重连定时器必须 unref：否则退避期间宿主退不出去', async () => {
  const h = harness();
  h.listener.start();
  await flush();
  h.connections.created[0]?.fail(new Error('断了'));
  await flush();
  assert.equal(h.timers.entries.length, 1);
  assert.equal(h.timers.entries[0]?.unrefed, true);
  await h.listener.stop();
});

// ───────────────── 连接失败不是致命错误 ─────────────────

test('connect 失败：onError(connect)，不抛，且持续重试直到连上', async () => {
  const refused = new Error('ECONNREFUSED 127.0.0.1:5432');
  const h = harness();
  h.connections.failNext(2, refused);
  h.listener.start();
  await flush();
  assert.deepEqual(h.errors.map((e) => e.phase), ['connect']);
  assert.equal(h.errors[0]?.error, refused);
  assert.deepEqual(h.timers.entries.map((t) => t.ms), [1_000]);

  h.timers.firePending();
  await flush();
  assert.deepEqual(h.errors.map((e) => e.phase), ['connect', 'connect']);
  assert.deepEqual(h.timers.entries.map((t) => t.ms), [1_000, 2_000]);

  h.timers.firePending();
  await flush();
  assert.equal(h.listener.connected, true, '数据库回来了，通知面必须自己恢复');
  assert.equal(h.connections.created.length, 1);
  await h.listener.stop();
});

test('start 不因连接失败抛错（通知只是延迟优化，不能拖垮插件加载）', async () => {
  const h = harness();
  h.connections.failNext(1);
  assert.doesNotThrow(() => h.listener.start());
  await flush();
  assert.equal(h.listener.connected, false);
  assert.deepEqual(h.errors.map((e) => e.phase), ['connect']);
  await h.listener.stop();
});

test('stop 取消待重连的定时器（不必等完退避，最长 30 秒）', async () => {
  const h = harness();
  h.listener.start();
  await flush();
  h.connections.created[0]?.end();
  await flush();
  assert.equal(h.timers.entries.length, 1);
  await h.listener.stop();
  assert.equal(h.timers.entries[0]?.cleared, true);
  assert.equal(h.connections.created.length, 1, '停止后不得再重连');
});

test('stop 期间在途的 connect 完成后立即关闭（不泄漏一条无人订阅的连接）', async () => {
  const h = harness();
  const release = h.connections.holdNextConnect();
  h.listener.start();
  await flush();
  assert.equal(h.connections.attempts.count, 1);

  const stopping = h.listener.stop();
  release();
  await stopping;
  assert.equal(h.connections.created.length, 1);
  assert.equal(h.connections.created[0]?.closed, true);
  assert.equal(h.listener.connected, false);
});

test('close 失败：onError(close) 但 stop 仍然完成（坏掉的连接不该卡住停止）', async () => {
  const h = harness();
  h.listener.start();
  await flush();
  const connection = h.connections.created[0];
  assert.ok(connection !== undefined);
  connection.closeError = new Error('end 失败');
  await h.listener.stop();
  assert.deepEqual(h.errors.map((e) => e.phase), ['close']);
  assert.equal(h.listener.connected, false);
});

test('观测回调自己抛错不会杀掉监听循环', async () => {
  const connections = fakeConnect();
  const timers = fakeTimers();
  const target = fakeTarget();
  const listener = new NotifyListener({
    target: target.target,
    connect: connections.connect,
    setTimerFn: timers.setTimerFn,
    clearTimerFn: timers.clearTimerFn,
    onError: () => { throw new Error('指标钩子崩了'); },
    onConnected: () => { throw new Error('指标钩子崩了'); },
    onDisconnected: () => { throw new Error('指标钩子崩了'); },
  });
  listener.start();
  await flush();
  assert.equal(listener.connected, true);
  connections.created[0]?.notify('a');
  assert.equal(target.calls.count, 1);
  await listener.stop();
  assert.equal(listener.connected, false);
});

// ───────────────── 集成：真实 PostgreSQL ─────────────────
//
// 只在设置了 `PENTEST_DATABASE_URL` 时才跑（与 test/recovery.test.ts 同一约定）。
// 这一段是**唯一**能验证 `createPgNotifyConnection` 的地方：假连接替不了
// 「`LISTEN` 真的登记在会话上」「`pg_notify` 真的在提交时才投递」这两件事，
// 也替不了「后端被掐断时 `pg` 到底发什么信号」。
//
// 它需要真实的等待（PostgreSQL 的投递没有可 await 的信号），因此本段是全文件
// 唯一使用真实定时器的地方。

const DATABASE_URL = process.env.PENTEST_DATABASE_URL;
/** 只给监听连接打的应用名：重连用例靠它精确定位要掐断的后端。 */
const NOTIFY_APP_NAME = 'dsh_pentest_notify_test';

describe(
  '集成：真实 PostgreSQL（LISTEN/NOTIFY）',
  { skip: DATABASE_URL === undefined ? '未设置 PENTEST_DATABASE_URL' : false },
  () => {
    const listenerUrl = ((): string | null => {
      if (DATABASE_URL === undefined) return null;
      try {
        const parsed = new URL(DATABASE_URL);
        parsed.searchParams.set('application_name', NOTIFY_APP_NAME);
        return parsed.toString();
      } catch {
        // 连接串不是 URL 形式（例如 key=value）：原样使用；掐断用例会自行跳过
        return DATABASE_URL;
      }
    })();

    /**
     * 集成用例用**每次运行唯一的通道**，不用全局的 `NOTIFY_CHANNEL`。
     *
     * 理由：那些用例断言「收到的载荷精确等于某几个值」，而全局通道同时被
     * 生产代码使用（outbox 入队会发通知、apply 会启动监听），全量测试并行跑时
     * 会收到兄弟测试的通知而产生假失败。改用唯一通道后它们互不干扰。
     */
    const TEST_CHANNEL = `pentest_outbox_test_${randomUUID().replace(/-/g, '')}`;
    const url = (): string => {
      if (listenerUrl === null) throw new Error('本组用例只在设置 PENTEST_DATABASE_URL 时运行');
      return listenerUrl;
    };

    /** 真实轮询：投递没有可 await 的信号，只能定时看。 */
    const pollUntil = async (
      condition: () => boolean,
      what: string,
      timeoutMs = 8_000,
    ): Promise<void> => {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        if (condition()) return;
        await new Promise<void>((resolve) => {
          setTimeout(resolve, 25);
        });
      }
      throw new Error(`等待超时（${String(timeoutMs)}ms）：${what}`);
    };

    /**
     * `listen()` 的 Promise 要等到断开才结算，所以「订阅语句已下发」没有可 await
     * 的就绪信号；给它一点时间再发通知。
     */
    const settleSubscription = async (): Promise<void> => {
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 200);
      });
    };

    /**
     * 后台连接：用来发通知、以及掐断监听连接的后端。
     *
     * 刻意**不**带 `application_name`（它是掐断操作的筛选键，管理员自己不该命中），
     * 并显式接住连接级 `error`——pg 的 `Client` 没有监听器时会把事件抛成未捕获异常，
     * 那是测试进程里最难看的一种失败。
     */
    const connectAdmin = async (): Promise<Client> => {
      if (DATABASE_URL === undefined) throw new Error('本组用例只在设置 PENTEST_DATABASE_URL 时运行');
      const admin = new Client({ connectionString: DATABASE_URL });
      admin.on('error', () => undefined);
      await admin.connect();
      return admin;
    };

    /**
     * 故意「脱离」一个长生命周期 promise：`connection.listen(...)` 返回的循环 promise
     * 会一直挂着，直到测试收尾时连接被关闭——那一刻它的拒绝**没有接收者**，会变成
     * unhandled rejection 让整个测试进程报错。这里显式接收并丢弃：它描述的是收尾路径，
     * 不是断言对象（断言走 `received` 数组与 `settleSubscription`）。
     *
     * 这个包装存在的意义就是把「有意的脱离」与「吞掉清理失败」区分开——
     * 后者是本轮复核（REQ-12）专门要清掉的东西。
     */
    const detach = (promise: Promise<unknown>): void => {
      void promise.catch(() => undefined);
    };

    test('订阅后收到 pg_notify：事务内发送，提交时才投递', async () => {
      const admin = await connectAdmin();
      const connection = await createPgNotifyConnection(url());
      const received: string[] = [];
      const lifetime = connection.listen(TEST_CHANNEL, (payload) => { received.push(payload); });
      detach(lifetime);
      try {
        await settleSubscription();

        await admin.query('begin');
        await admin.query('select pg_notify($1, $2)', [TEST_CHANNEL, 'tx-job']);
        await new Promise<void>((resolve) => {
          setTimeout(resolve, 250);
        });
        assert.deepEqual(received, [], '事务未提交：事务性通知不得提前投递');

        await admin.query('commit');
        await pollUntil(() => received.length > 0, '提交后的通知送达');
        assert.deepEqual(received, ['tx-job']);
      } finally {
        await connection.close();
        await admin.end();
      }
    });

    test('事务回滚 → 通知不投递（「与入队同事务」的语义成立）', async () => {
      const admin = await connectAdmin();
      const connection = await createPgNotifyConnection(url());
      const received: string[] = [];
      const lifetime = connection.listen(TEST_CHANNEL, (payload) => { received.push(payload); });
      detach(lifetime);
      try {
        await settleSubscription();

        await admin.query('begin');
        await admin.query('select pg_notify($1, $2)', [TEST_CHANNEL, 'rolled-back']);
        await admin.query('rollback');
        await new Promise<void>((resolve) => {
          setTimeout(resolve, 250);
        });
        assert.deepEqual(received, [], '回滚的事务不得投递通知');

        // 反证订阅仍然活着：此后提交的一条就该到
        await admin.query('select pg_notify($1, $2)', [TEST_CHANNEL, 'alive']);
        await pollUntil(() => received.length > 0, '订阅仍然有效');
        assert.deepEqual(received, ['alive']);
      } finally {
        await connection.close();
        await admin.end();
      }
    });

    test('同一事务内相同负载折叠为一条（PostgreSQL 的投递语义）', async () => {
      const admin = await connectAdmin();
      const connection = await createPgNotifyConnection(url());
      const received: string[] = [];
      const lifetime = connection.listen(TEST_CHANNEL, (payload) => { received.push(payload); });
      detach(lifetime);
      try {
        await settleSubscription();

        await admin.query('begin');
        await admin.query('select pg_notify($1, $2)', [TEST_CHANNEL, 'same']);
        await admin.query('select pg_notify($1, $2)', [TEST_CHANNEL, 'same']);
        await admin.query('commit');
        await pollUntil(() => received.length > 0, '提交后的通知送达');
        await new Promise<void>((resolve) => {
          setTimeout(resolve, 250);
        });
        assert.deepEqual(received, ['same'], '同事务相同负载折叠：重复入队不会放大唤醒');
      } finally {
        await connection.close();
        await admin.end();
      }
    });

    test('close() 让 listen() 的 Promise 结算（端口契约）', async () => {
      const connection = await createPgNotifyConnection(url());
      const state = { settled: false };
      const lifetime = connection.listen(TEST_CHANNEL, () => undefined);
      void lifetime.then(
        () => { state.settled = true; },
        () => { state.settled = true; },
      );
      await settleSubscription();
      assert.equal(state.settled, false, '订阅期间 Promise 保持 pending');
      await connection.close();
      await pollUntil(() => state.settled, '关闭后 listen 的 Promise 结算');
    });

    test('后端被掐断（数据库重启/防火墙切断）→ 自动重连并继续收到通知', async (t) => {
      const admin = await connectAdmin();
      const target = fakeTarget();
      const connected = { count: 0 };
      const disconnects: unknown[] = [];
      const listener = new NotifyListener({
        target: target.target,
        connect: () => createPgNotifyConnection(url()),
        // **必须显式传 channel**：本段的断言用 TEST_CHANNEL（每次运行唯一），
        // 若这里用默认通道，监听器会订阅一个通道而用例在另一个通道上发通知——
        // 表现为「永远收不到」而没有任何报错。
        channel: TEST_CHANNEL,
        // 集成用例把退避调小，免得为等一次重连白等 1 秒起步
        backoff: { initialDelayMs: 200, maxDelayMs: 500 },
        onConnected: () => { connected.count += 1; },
        onDisconnected: (error) => { disconnects.push(error); },
      });
      listener.start();
      try {
        await pollUntil(() => connected.count >= 1, '首次连上');
        await settleSubscription();

        let killed = 0;
        try {
          // 筛选与终止分两层：PostgreSQL 不保证 `and` 的求值顺序，把易变的
          // `pg_terminate_backend` 放进同一个 WHERE 里时它可能先于 `pid <>` 求值，
          // 于是把自己的后端也掐了（本用例实测踩到过）。放进子查询的 SELECT
          // 列表后，WHERE 先筛完再逐行终止。
          const result = await admin.query<{ count: number }>(
            'select count(*)::int as count from (' +
              'select pg_terminate_backend(pid) from pg_stat_activity ' +
              'where application_name = $1 and pid <> pg_backend_pid()) as terminated',
            [NOTIFY_APP_NAME],
          );
          killed = result.rows[0]?.count ?? 0;
        } catch (error) {
          t.diagnostic(
            `跳过重连断言：当前角色无法终止后端（${error instanceof Error ? error.message : String(error)}）`,
          );
          return;
        }
        if (killed === 0) {
          t.diagnostic('跳过重连断言：没有匹配的监听后端');
          return;
        }

        await pollUntil(() => disconnects.length >= 1, '断开被观测到');
        await pollUntil(() => connected.count >= 2, '断开后自动重连');

        // 重连后的新连接必须真的订阅上了：发一条通知，调度器要被唤醒。
        //
        // **这里必须再 settle 一次**：`onConnected` 表示「TCP 已连接」，而 `LISTEN`
        // 是在 `listen()` 内部完成的——两者之间有个小窗口，窗口内的通知会丢。
        // 第一次连上时已 settle 过（上面的调用），重连后同样需要。
        await settleSubscription();
        await admin.query('select pg_notify($1, $2)', [TEST_CHANNEL, 'after-reconnect']);
        await pollUntil(() => target.calls.count >= 1, '重连后通知仍能唤醒调度器');
      } finally {
        await listener.stop();
        await admin.end();
      }
    });
  },
);
