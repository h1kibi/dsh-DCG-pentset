/**
 * 「进入下一阶段」的测试：它只做**一件事**——请求交接草稿，然后交还人类。
 *
 * 关键不变量（第 1 条就是这次改动的理由）：
 *   1. **绝不自动确认**：注入下一阶段会话是人类的决定，草稿必须经「交接编辑」审计修改后才提交。
 *      从前这里会按草稿原样确认——人类没有机会审计（2026-10-05 人类明确要求改掉）。
 *   2. 载荷走窄化：形状不符就报错，绝不猜半个对象（半个对象喂给确认端点会带着残缺内容切阶段）。
 *   3. 失败原因原样上屏，不吞成「点了没反应」。
 *   4. 非推荐路径不由这里放行：草稿原样交出去，走不走、怎么走由「交接编辑」里的人类决定。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { ConsoleController } from '../src/client/controller.ts';
import type { HostRpcResult } from '../src/console/rpc.ts';
import { requestAdvanceDraft } from '../src/client/advance-phase.ts';

const NOW = new Date('2026-10-03T00:00:00.000Z');

/** 从控制器信封里取出方法与参数（窄化，不做内联断言）。 */
function requestOf(payload: unknown): {
  readonly method: string;
  readonly params: Record<string, unknown>;
  readonly reason: string;
  readonly expectedStateVersion: number | null;
} | null {
  if (payload === null || typeof payload !== 'object' || !('args' in payload)) return null;
  const args = payload.args;
  if (args === null || typeof args !== 'object' || !('request' in args)) return null;
  const request = args.request;
  if (request === null || typeof request !== 'object' || !('method' in request)) return null;
  if (typeof request.method !== 'string') return null;
  const params = 'params' in request && request.params !== null && typeof request.params === 'object'
    ? (request.params as Record<string, unknown>)
    : {};
  const reason = 'reason' in request && typeof request.reason === 'string' ? request.reason : '';
  const expectedStateVersion = 'expectedStateVersion' in request && typeof request.expectedStateVersion === 'number'
    ? request.expectedStateVersion
    : null;
  return { method: request.method, params, reason, expectedStateVersion };
}

function draftOf(overrides: Readonly<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    draftId: 'd-1',
    fromWorkerSessionId: 'ws-1',
    fromPhase: 'intelligence-gathering',
    suggestedToPhase: 'threat-modeling',
    objective: '建立威胁模型',
    prompt: '按情报产出建立威胁模型',
    suggestedSkillIds: ['s-1'],
    contextRefs: [],
    excludedRefs: ['r-1'],
    toolCapabilitySuggestion: { allowed: ['read'], approvalRequired: ['exploit_validation'] },
    limitations: [],
    revision: 1,
    ...overrides,
  };
}

function harness(handlers: { readonly draft?: HostRpcResult; readonly throwOnDraft?: boolean }): {
  readonly controller: ConsoleController;
  readonly sent: { method: string; params: Record<string, unknown>; reason: string; expectedStateVersion: number | null }[];
} {
  const sent: { method: string; params: Record<string, unknown>; reason: string; expectedStateVersion: number | null }[] = [];
  const invoke = async (_channel: string, endpoint: string, payload: unknown): Promise<HostRpcResult> => {
    const request = requestOf(payload);
    const method = request?.method ?? endpoint.split('/').at(-1) ?? '';
    if (request !== null) {
      sent.push({
        method,
        params: request.params,
        reason: request.reason,
        expectedStateVersion: request.expectedStateVersion,
      });
    }
    if (method === 'beginHandoff') {
      if (handlers.throwOnDraft === true) throw new Error('连接中断');
      return handlers.draft ?? { ok: true, value: draftOf() };
    }
    return { ok: true, value: {} };
  };
  return { controller: new ConsoleController({ invoke, clock: () => NOW }), sent };
}

const INPUT = {
  activeSession: { workerSessionId: 'ws-1' },
  suggestedToPhase: 'threat-modeling' as const,
};

test('进入下一阶段：服务端起稿并把可编辑内容交还人类——**绝不**自动确认、不经过 Agent', async () => {
  const { controller, sent } = harness({});
  const outcome = await requestAdvanceDraft({ controller, ...INPUT });

  assert.deepEqual(
    sent.map((s) => s.method),
    ['beginHandoff'],
    '只有一步：请求草稿。确认属于「交接编辑」里的人类动作，这里发出去就等于删掉了审计',
  );
  assert.deepEqual(sent[0]?.params, {
    workerSessionId: 'ws-1',
    toPhase: 'threat-modeling',
  }, '起稿只带会话与目标阶段——**不经过 Agent**（服务端按阶段定义直接起草）');

  assert.equal(outcome.ok, true);
  if (outcome.ok) {
    assert.equal(outcome.draft.draftId, 'd-1');
    assert.equal(outcome.draft.suggestedToPhase, 'threat-modeling');
    assert.equal(outcome.draft.prompt, '按情报产出建立威胁模型', '提示词原样带回，一个字段都不改');
    assert.deepEqual([...outcome.draft.excludedRefs], ['r-1'], '要排除的上下文也原样交出去');
  }
});

test('进入下一阶段：非推荐路径的草稿也原样交出去（该不该走由交接编辑里的人类决定）', async () => {
  const { controller, sent } = harness({
    draft: { ok: true, value: draftOf({ suggestedToPhase: 'post-exploitation' }) },
  });
  const outcome = await requestAdvanceDraft({ controller, ...INPUT });

  assert.equal(outcome.ok, true, '非推荐路径不是这里的拒绝理由：编辑器里才有 forced 与二次确认');
  if (outcome.ok) assert.equal(outcome.draft.suggestedToPhase, 'post-exploitation');
  assert.deepEqual(sent.map((s) => s.method), ['beginHandoff'], '不得发出确认');
});

test('进入下一阶段：草稿形状不符时拒绝（不猜半个对象）', async () => {
  const { controller, sent } = harness({ draft: { ok: true, value: { draftId: 'd-1' } } });
  const outcome = await requestAdvanceDraft({ controller, ...INPUT });
  assert.equal(outcome.ok, false);
  if (!outcome.ok) assert.match(outcome.message, /形状不符合契约/);
  assert.deepEqual(sent.map((s) => s.method), ['beginHandoff']);
});

test('进入下一阶段：服务端拒绝的原因原样带回（不吞成「点了没反应」）', async () => {
  const { controller } = harness({
    draft: { ok: false, error: { code: 'classification_rejected', message: '只有等待人工判断时可以请求交接草稿', details: {} } },
  });
  const outcome = await requestAdvanceDraft({ controller, ...INPUT });
  assert.equal(outcome.ok, false);
  if (!outcome.ok) {
    assert.match(outcome.message, /classification_rejected/);
    assert.match(outcome.message, /只有等待人工判断时/);
  }
});

test('进入下一阶段：调用抛错时如实上屏', async () => {
  const { controller } = harness({ throwOnDraft: true });
  const outcome = await requestAdvanceDraft({ controller, ...INPUT });
  assert.equal(outcome.ok, false);
  if (!outcome.ok) assert.match(outcome.message, /连接中断/);
});

test('会话卡片必须显式给状态版本：不传就恒定发 0——那正是「点了没反应」的成因', async () => {
  // 我犯过的错：只验了类型与渲染就把按钮发出去，人类点下去只看到
  // `stale_state_version：期望 0，实际 4`。原因：会话卡片用的是**会话级**控制器，
  // 它从未 select() 过作业，`state` 恒为 null，于是 mutate 的默认版本恒为 0。
  // 这条锁逼着调用方把版本带下来——以后改这一层，测试会先红。
  const { controller, sent } = harness({});
  await requestAdvanceDraft({
    controller,
    activeSession: { workerSessionId: 'ws-1' },
    expectedStateVersion: 42,
  });
  assert.equal(sent[0]?.expectedStateVersion, 42, '卡片给的版本必须原样进信封');

  const bare = harness({});
  await requestAdvanceDraft({ controller: bare.controller, activeSession: { workerSessionId: 'ws-1' } });
  assert.equal(bare.sent[0]?.expectedStateVersion, 0, '不传就是 0：所以卡片**必须**传，否则服务端必拒');
});
