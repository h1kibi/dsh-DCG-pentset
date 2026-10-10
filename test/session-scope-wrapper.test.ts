/**
 * 会话作用域包装器的**形态锁**（2026-10-11 操作者实测 P0）。
 *
 * **为什么必须在这里锁**：`WorkerToolDeps` 里有两种函数依赖——工具方法和解析器。
 * 包装器早先把**每个**函数依赖都包成 `async`，于是解析器的同步返回值变成 Promise。
 * 第一个因此坏掉的是 `evidenceRootFor`：`pentest_exec` 的 `save_stdout_as_evidence`
 * 拿它当路径 ⇒ `The "path" argument must be of type string. Received an instance of Promise`
 * ⇒ 证据**静默不落盘**（而那是"忘了 tee"的唯一安全网）。
 *
 * 工具层自己的单测**测不出**这一条：它们直接把依赖对象喂给 `createWorkerTools`，
 * 恰好绕过装配层的包装（2026-10-07 的 `access.list is not a function` 也是这么漏过去的）。
 * 所以锁要打在包装器这一层：**入参不是 `{workerSessionId}` ⇒ 返回值形态不得改变**。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { scopeWorkerToolsBySession } from '../src/compose.ts';
import type { WorkerToolDeps } from '../src/tools/worker.ts';

test('包装器只包工具方法：解析器的返回值不得被 async 化，对象依赖原样透传', async () => {
  const scoped: string[] = [];
  const workdir = { list: async () => ({ entries: [] }) };
  const deps = {
    // 工具方法：入参是 `{workerSessionId}`，必须进会话作用域
    async execute(input: { readonly workerSessionId: string }) {
      return { ran: input.workerSessionId };
    },
    // 解析器：入参是**字符串**，返回值是**字符串**（不得变 Promise）
    evidenceRootFor: (workerSessionId: string) => `/roots/${workerSessionId}`,
    // 对象依赖（`workdir` 这种形状）：必须原样透传
    workdir,
  } as unknown as WorkerToolDeps;

  const wrapped = scopeWorkerToolsBySession(deps, async (workerSessionId, work) => {
    scoped.push(workerSessionId);
    return work();
  });

  // ① 解析器：同步值就是值
  const root = wrapped.evidenceRootFor!('ws-1');
  assert.equal(typeof root, 'string', '解析器的返回值不得变成 Promise（那正是证据静默不落盘的根因）');
  assert.equal(root, '/roots/ws-1');
  assert.equal(scoped.length, 0, '解析器不该被当成工具方法套作用域');

  // ② 工具方法：照旧进作用域。
  // 这里的调用形状是**故意**只有 `{workerSessionId}`：本文件测的是包装器的判别规则，
  // 不是 `execute` 的完整入参（真实入参另有 intent/signal，测试替身不需要它们）。
  const callExecute = wrapped.execute as unknown as (input: {
    readonly workerSessionId: string;
  }) => Promise<unknown>;
  assert.deepEqual(await callExecute({ workerSessionId: 'ws-1' }), { ran: 'ws-1' });
  assert.deepEqual(scoped, ['ws-1'], '工具方法必须进作用域（否则租户级查询一行都读不到）');

  // ③ 对象依赖原样保留（同一个对象，不是包装后的函数）
  assert.equal(wrapped.workdir, workdir);
});

test('包装器：工具方法的同步抛错照旧冒泡，且异步边界不变', async () => {
  const attempts: string[] = [];
  const deps = {
    async execute(input: { readonly workerSessionId: string }) {
      attempts.push('executed');
      if (input.workerSessionId === 'boom') throw new Error('下游拒绝');
      return { ok: true };
    },
    async resolveWorkerSessionId(dshSessionId: string) {
      attempts.push(`resolve:${dshSessionId}`);
      return dshSessionId.slice(4);
    },
  } as unknown as WorkerToolDeps;
  const wrapped = scopeWorkerToolsBySession(deps, async (_workerSessionId, work) => work());

  const callExecute = wrapped.execute as unknown as (input: {
    readonly workerSessionId: string;
  }) => Promise<unknown>;
  await assert.rejects(() => callExecute({ workerSessionId: 'boom' }), /下游拒绝/);
  // 解析器（字符串入参）：Promise 形态不变，签名语义保持
  assert.equal(await wrapped.resolveWorkerSessionId('dsh-ws-1'), 'ws-1');
  assert.deepEqual(attempts, ['executed', 'resolve:dsh-ws-1']);
});
