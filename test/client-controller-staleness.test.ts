/**
 * 控制器在「快速切换作业」与「读失败」下的**快照归属**（2026-10-05 复核 REQ-13b）。
 *
 * 症状（复核报告 §3.4-2）：`select()` 只 emit 选中 id，读失败时旧 `state`/`sessions`
 * 原样留着——状态条于是显示「B 的名字 + A 的阶段与在跑数」；并发切换时迟到的响应
 * 还会覆盖新作业的快照。
 *
 * 这里用一个**手动结算**的 invoker：每次读都挂起，由用例逐条 resolve。响应何时回来
 * 因此是显式动作——「迟到」这种时序只能在可控时钟下测。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate as flushImmediate } from 'node:timers/promises';

import { ConsoleController } from '../src/client/controller.ts';
import type { HostRpcResult } from '../src/console/rpc.ts';

const NOW = new Date('2026-01-01T00:00:00Z');

interface Deferred {
  readonly method: string;
  readonly engagementId: string | undefined;
  readonly resolve: (result: HostRpcResult) => void;
}

const ok = (value: unknown): HostRpcResult => ({ ok: true, value });
const fail = (code: string, message: string): HostRpcResult => ({
  ok: false,
  error: { code, message, details: {} },
});

/**
 * 从宿主 RPC 载荷里取出信封（测试边界的一次性窄化）。
 *
 * 载荷由本仓的 `ConsoleClient` 构造、形状固定，但测试不该靠内联断言去取成员——
 * 那样读错字段会静默得到 undefined。这里显式检查，读不到即用例写错。
 */
function requestOf(payload: unknown): { readonly method: string; readonly params: Record<string, unknown> } {
  if (typeof payload !== 'object' || payload === null) throw new Error('RPC 载荷不是对象');
  const args = Reflect.get(payload, 'args');
  if (typeof args !== 'object' || args === null) throw new Error('RPC 载荷缺少 args');
  const request = Reflect.get(args, 'request');
  if (typeof request !== 'object' || request === null) throw new Error('RPC 载荷缺少 request');
  const method = Reflect.get(request, 'method');
  if (typeof method !== 'string') throw new Error('RPC 信封缺少 method');
  const rawParams = Reflect.get(request, 'params');
  // 具名常量而不是内联断言取成员：参数集合本来就是控制器构造的普通对象。
  const params: Record<string, unknown> =
    typeof rawParams === 'object' && rawParams !== null ? { ...rawParams } : {};
  return { method, params };
}

function deferredController(): { controller: ConsoleController; pending: Deferred[] } {
  const pending: Deferred[] = [];
  const invoke = (_channel: string, endpoint: string, payload: unknown): Promise<HostRpcResult> => {
    const { method: envelopeMethod, params } = requestOf(payload);
    const method = endpoint.split('/').at(-1) ?? envelopeMethod;
    // 本仓 lib 是 es2023（没有 `Promise.withResolvers`，见 docker-sandbox.ts 的同类注释），
    // 因此用 executor 形式：`resolve` 在构造期同步捕获，随同待决条目一起交出。
    return new Promise<HostRpcResult>((resolve) => {
      pending.push({
        method,
        engagementId: typeof params['engagementId'] === 'string' ? params['engagementId'] : undefined,
        resolve,
      });
    });
  };
  return { controller: new ConsoleController({ invoke, clock: () => NOW }), pending };
}

/** 取出（并移除）某作业待决的那一条调用：控制器是串行发的，取错即用例写错。 */
function take(pending: Deferred[], method: string, engagementId?: string): Deferred {
  const index = pending.findIndex(
    (entry) => entry.method === method && (engagementId === undefined || entry.engagementId === engagementId),
  );
  const found = pending[index];
  if (found === undefined) {
    throw new Error(
      `没有待决的 ${method}（${engagementId ?? '任意'}）；当前待决：` +
        pending.map((entry) => `${entry.method}:${entry.engagementId ?? '-'}`).join(', '),
    );
  }
  pending.splice(index, 1);
  return found;
}

/** 完成一次 `select`：按控制器的串行顺序喂它发出的三个读端点。 */
async function completeSelect(
  pending: Deferred[],
  selectPromise: Promise<void>,
  engagementId: string,
  results: { readonly state: HostRpcResult; readonly sessions: HostRpcResult; readonly proposal: HostRpcResult },
): Promise<void> {
  await flushImmediate();
  take(pending, 'getState', engagementId).resolve(results.state);
  await flushImmediate();
  take(pending, 'listWorkerSessions', engagementId).resolve(results.sessions);
  await flushImmediate();
  take(pending, 'getScopeProposal', engagementId).resolve(results.proposal);
  await selectPromise;
}

test('切换作业时先清空旧快照；读失败也不得回落到上一个作业（REQ-13b）', async () => {
  const { controller, pending } = deferredController();
  await completeSelect(pending, controller.select('a'), 'a', {
    state: ok({ mainStatus: 'worker_running', stateVersion: 3 }),
    sessions: ok([{ id: 'session-a' }]),
    proposal: ok(null),
  });
  assert.equal(controller.getSnapshot().state?.stateVersion, 3, '前置条件：A 的状态已就位');

  const switchToB = controller.select('b');
  // 切换的**瞬间**旧快照必须消失：这是「B 的名字 + A 的状态」这条缺陷的根。
  assert.equal(controller.getSnapshot().state, null, '切换时必须清空旧状态');
  assert.deepEqual(controller.getSnapshot().sessions, [], '切换时必须清空旧会话列表');

  // 两个读都失败。**在方案读之前断言**：方案读成功会按设计清掉 lastError
  // （成功的读清错误是既有语义），因此失败可见性要在那一刻之前看。
  await flushImmediate();
  take(pending, 'getState', 'b').resolve(fail('db/unavailable', '读取失败'));
  await flushImmediate();
  take(pending, 'listWorkerSessions', 'b').resolve(fail('db/unavailable', '读取失败'));
  await flushImmediate();
  const failedSnapshot = controller.getSnapshot();
  assert.equal(failedSnapshot.selectedEngagementId, 'b');
  assert.equal(failedSnapshot.state, null, '读失败不得把 A 的快照留成 B 的状态');
  assert.deepEqual(failedSnapshot.sessions, [], '读失败不得把 A 的会话留成 B 的');
  assert.equal(failedSnapshot.lastError?.code, 'db/unavailable', '失败本身仍要可见');

  take(pending, 'getScopeProposal', 'b').resolve(ok(null));
  await switchToB;
  assert.equal(controller.getSnapshot().state, null, '完成后仍是空态（B 读不到状态）');
  assert.deepEqual(controller.getSnapshot().sessions, []);
});

test('迟到的读响应不得覆盖新作业的快照（REQ-13b）', async () => {
  const { controller, pending } = deferredController();
  const selectA = controller.select('a');
  await flushImmediate();
  const stateA = take(pending, 'getState', 'a'); // A 的读挂起，不结算

  // A 还没回来，就切到 B 并读完。
  await completeSelect(pending, controller.select('b'), 'b', {
    state: ok({ mainStatus: 'report_ready', stateVersion: 9 }),
    sessions: ok([{ id: 'session-b' }]),
    proposal: ok(null),
  });
  assert.equal(controller.getSnapshot().state?.stateVersion, 9, '前置条件：B 的状态已就位');

  // 现在 A 的响应才回来：它必须被丢弃，否则界面会退回 A 的阶段。
  stateA.resolve(ok({ mainStatus: 'worker_running', stateVersion: 3 }));
  await flushImmediate();
  take(pending, 'listWorkerSessions', 'a').resolve(ok([{ id: 'session-a' }]));
  await flushImmediate();
  take(pending, 'getScopeProposal', 'a').resolve(ok(null));
  await selectA;

  const snapshot = controller.getSnapshot();
  assert.equal(snapshot.selectedEngagementId, 'b');
  assert.equal(snapshot.state?.stateVersion, 9, '迟到的 A 响应不得覆盖 B 的状态');
  assert.deepEqual(snapshot.sessions, [{ id: 'session-b' }], '迟到的会话列表同样要丢弃');
});
