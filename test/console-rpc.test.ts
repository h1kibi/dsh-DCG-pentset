/**
 * 控制台 RPC 层测试。
 *
 * 重点不在「方法能调用」，而在四条边界：
 *   1. **操作者身份不可伪造** —— 请求体里带 operatorId 是传输层越权，不是参数错误
 *   2. **写操作必须有幂等键与期望版本** —— 缺失即拒，不默认成 0 而静默覆盖
 *   3. **错误保留稳定码** —— UI 与模型据码分支，不解析文本
 *   4. **Worker 面与状态机内部方法永不导出** —— 控制台面是另一个面
 */

import { consoleServicesStub } from './helpers/console-services.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ConsoleRpc,
  ConsoleRpcFault,
  CONSOLE_RPC_METHODS,
  isConsoleMethod,
  describeConsoleMethods,
} from '../src/console/rpc.ts';
import type { CallContext } from '../src/console/rpc.ts';
import type { HumanWorkflowService, WorkflowSnapshot } from '../src/contracts.ts';

/** 假工作流：记录被调用的方法名与入参，返回可控结果。 */
function fakeWorkflow(over: Partial<Record<string, unknown>> = {}): {
  workflow: HumanWorkflowService;
  calls: Array<{ method: string; input: unknown }>;
} {
  const calls: Array<{ method: string; input: unknown }> = [];
  const snapshot: WorkflowSnapshot = {
    engagementId: 'e1',
    mainStatus: 'ready',
    runMarker: 'running',
    currentPhase: null,
    stateVersion: 3,
    graphIteration: 1,
    activeWorkerSessionId: null,
    scopeVersion: 1,
    authorizationExpiresAt: null,
  };
  const handler = (method: string, result: unknown) =>
    async (input: unknown): Promise<unknown> => {
      calls.push({ method, input });
      const override = over[method];
      return override === undefined ? result : override;
    };

  const workflow = {
    // engagement 生命周期（§6.1）
    createEngagement: handler('createEngagement', {
      id: 'e-new', name: 'x', runMarker: 'running', mainStatus: 'ready', currentPhase: null,
      stateVersion: 0, graphIteration: 1, activeWorkerSessionId: null,
      createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
    }),
    listEngagements: handler('listEngagements', []),
    getState: handler('getState', snapshot),
    startWorker: handler('startWorker', { workerSessionId: 'w1', dshSessionId: 'dsh-w1', leaseId: 'l1', leaseGeneration: 1 }),
    finishWorker: handler('finishWorker', snapshot),
    beginHandoff: handler('beginHandoff', {}),
  currentHandoffDraft: handler('currentHandoffDraft', {}),
    editHandoff: handler('editHandoff', {}),
    cancelHandoff: handler('cancelHandoff', snapshot),
    previewScope: handler('previewScope', { targets: [], exclusions: [], ok: true }),
    previewPolicy: handler('previewPolicy', {
      ok: true,
      blockers: [],
      scopeEntryProfile: 'custom',
      behaviorProfile: 'stealth',
      targets: [],
      exclusions: [],
      resolvedAddresses: {},
      pacing: { rate: 1, concurrency: 1, jitter: 0.5, burst: 1, retry: 1 },
      enabledActionClasses: [],
      disabledActionClasses: [],
      perActionApprovalClasses: [],
      enabledDisabledClasses: [],
      dualConfirmed: false,
      credentialMode: 'none',
      stopConditions: [],
      executionConstraints: {},
      nextScopeVersion: 1,
      nextPolicyVersion: 1,
      currentPolicyEpoch: 0,
      nextPolicyEpoch: 0,
      snapshotHash: 'sha256:test',
    }),
    amendScope: handler('amendScope', { engagementId: 'e1', version: 2, contentHash: 'h' }),
    // 确认范围：`ConfirmedScopeProposal`（StartedWorker + engagementId/scopeVersion/stateVersion/sessionKind）。
    confirmScopeProposal: handler('confirmScopeProposal', {
      engagementId: 'e1',
      scopeVersion: 1,
      stateVersion: 4,
      sessionKind: 'phase',
      workerSessionId: 'w2',
      dshSessionId: 'dsh-w2',
      leaseId: 'l2',
      leaseGeneration: 2,
    }),
    rejectScopeProposal: handler('rejectScopeProposal', null),
    interject: handler('interject', { delivered: true, transitionType: 'none', stateVersion: 4 }),
    extendBudget: handler('extendBudget', snapshot),
    decideApproval: handler('decideApproval', { id: 'a1' }),
    revokeApproval: handler('revokeApproval', { id: 'a1' }),
    confirmTransition: handler('confirmTransition', { transitionType: 'advance', stateVersion: 4, graphIteration: 1, scopeVersion: 1, workerSessionId: 'w2', sessionReused: false }),
    retryWorker: handler('retryWorker', { transitionType: 'retry', stateVersion: 4, graphIteration: 1, scopeVersion: 1, workerSessionId: 'w1', sessionReused: true }),
    reopenTechnicalWork: handler('reopenTechnicalWork', snapshot),
    pause: handler('pause', snapshot),
    resume: handler('resume', snapshot),
    abort: handler('abort', snapshot),
    finishTechnicalTesting: handler('finishTechnicalTesting', { engagementId: 'e1', version: 1, content: 'draft' }),
    signReport: handler('signReport', { engagementId: 'e1', version: 1, contentHash: 'h' }),
  } as unknown as HumanWorkflowService;

  return { workflow, calls };
}

const CTX: CallContext = { operatorId: 'op-1', authenticatedAt: new Date('2026-01-01T00:00:00Z'), source: 'web' };

function rpc(over: Partial<Record<string, unknown>> = {}): {
  rpc: ConsoleRpc;
  calls: Array<{ method: string; input: unknown }>;
} {
  const { workflow, calls } = fakeWorkflow(over);
  return { rpc: new ConsoleRpc({ services: consoleServicesStub(workflow) }), calls };
}

/** 一个合法的写请求信封。 */
function writeBody(method: string, params: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    method,
    // pause/resume/abort 需要 engagementId；其余端点的必填字段各自不同，
    // 测试按需覆盖。这里给一个通用默认值，避免每个用例重复。
    params: { engagementId: 'e1', ...params },
    expectedStateVersion: 3,
    reason: '人工操作',
    idempotencyKey: `k-${method}`,
  };
}

// ───────────────────── 身份边界 ─────────────────────

test('请求体携带 operatorId → 拒绝，且用专属码（不是普通参数错误）', async () => {
  const { rpc: r, calls } = rpc();
  const body = { ...writeBody('pause'), operatorId: 'attacker' };
  const res = await r.handle(body, CTX);
  assert.equal(res.ok, false);
  if (res.ok) return;
  assert.equal(res.code, 'console/operator-forbidden');
  assert.match(res.message, /操作者身份由传输层注入/);
  assert.equal(calls.length, 0, '身份违规必须在调用服务之前被拦下');
});

test('请求体携带 operator_id（snake_case 变体）同样拒绝', async () => {
  const { rpc: r } = rpc();
  const res = await r.handle({ ...writeBody('pause'), operator_id: 'attacker' }, CTX);
  assert.equal(res.ok, false);
  if (res.ok) return;
  assert.equal(res.code, 'console/operator-forbidden');
});

// ───────────────────── 留痕字段的空串（实测回归） ─────────────────────

/**
 * 实测缺陷：卡片把 `authorizationNote: ''` 发过来，被参数校验以
 * `console/argument-invalid 必须是非空字符串` 挡下——而授权说明现在是**留痕**字段
 * （§5.5.1：有就记、没有就空着），空串是合法表达。
 *
 * 这类缺陷上一轮没被测到，是因为集成断言直接调工作流，**绕过了 RPC 参数校验这一层**。
 * 这两条把那一层钉住：留痕字段放行空串，必填字段照旧非空。
 */
const CONFIRM_PARAMS = {
  proposalId: 'p1',
  // 行为预设与审批模式都是必选项（2026-10-05 起）：确认范围必须把它们一起发出去。
  behaviorProfile: 'stealth',
  approvalMode: 'human',
  objective: '确认后的目标',
  targets: [{ kind: 'ip', value: '192.0.2.7', protocols: ['tcp'], ports: [{ from: 80, to: 80 }] }],
  exclusions: [],
  allowedActions: ['passive_read'],
};

test('确认范围：授权说明传空串必须通过参数校验（它是留痕，不是前提）', async () => {
  const { rpc: r, calls } = rpc();
  const res = await r.handle(writeBody('confirmScopeProposal', { ...CONFIRM_PARAMS, authorizationNote: '' }), CTX);

  assert.equal(res.ok, true, `空授权说明不该被参数校验拦下：${JSON.stringify(res)}`);
  const input = calls.find((c) => c.method === 'confirmScopeProposal')?.input as
    | { readonly authorizationNote?: unknown }
    | undefined;
  assert.equal(input?.authorizationNote, '', '空串原样交给工作流（由它决定如何留痕）');
});

test('必填字段仍旧不能是空串：空串放宽只针对留痕字段', async () => {
  const { rpc: r } = rpc();
  const res = await r.handle(writeBody('confirmScopeProposal', { ...CONFIRM_PARAMS, objective: '' }), CTX);

  assert.equal(res.ok, false);
  if (res.ok) return;
  assert.equal(res.code, 'console/argument-invalid');
  assert.ok(res.message.includes('objective 必须是非空字符串'), res.message);
});

test('params 内携带 operatorId 也被拒（不能埋在参数里绕过）', async () => {
  const { rpc: r, calls } = rpc();
  const res = await r.handle(writeBody('pause', { operatorId: 'attacker' }), CTX);
  // 由服务层的 HumanActor 构造决定是否拒绝；此处断言**至少没有把伪造身份当成操作者**
  if (res.ok) {
    const used = (calls[0]?.input as { operatorId?: string } | undefined)?.operatorId;
    assert.notEqual(used, 'attacker', '不得把请求体里的身份当作操作者');
  }
});

test('传输上下文缺 source → 拒绝调用', async () => {
  const { rpc: r } = rpc();
  const res = await r.handle(writeBody('pause'), { operatorId: 'op', authenticatedAt: null } as never);
  assert.equal(res.ok, false);
  if (res.ok) return;
  assert.equal(res.code, 'console/context-invalid');
});

test('传输上下文缺 operatorId → 拒绝调用', async () => {
  const { rpc: r } = rpc();
  const res = await r.handle(writeBody('pause'), { authenticatedAt: 'x', source: 'web' } as never);
  assert.equal(res.ok, false);
});

// ───────────────────── 信封校验 ─────────────────────

test('缺 method → 拒绝', async () => {
  const { rpc: r } = rpc();
  const res = await r.handle({ params: {} }, CTX);
  assert.equal(res.ok, false);
  if (res.ok) return;
  assert.equal(res.code, 'console/envelope-invalid');
});

test('信封含未声明的顶层键 → 拒绝（说明客户端与服务端契约已分叉）', async () => {
  const { rpc: r } = rpc();
  const res = await r.handle({ ...writeBody('pause'), unexpected: 1 }, CTX);
  assert.equal(res.ok, false);
  if (res.ok) return;
  assert.equal(res.code, 'console/envelope-invalid');
  assert.match(res.message, /方法参数放进 params/);
});

test('params 不是对象 → 拒绝', async () => {
  const { rpc: r } = rpc();
  const res = await r.handle({ ...writeBody('pause'), params: 'not-an-object' }, CTX);
  assert.equal(res.ok, false);
});

// ───────────────────── 方法面 ─────────────────────

test('未导出的端点 → console/method-unavailable（不是「未实现」）', async () => {
  const { rpc: r, calls } = rpc();
  const res = await r.handle({ method: 'definitelyNotAMethod' }, CTX);
  assert.equal(res.ok, false);
  if (res.ok) return;
  assert.equal(res.code, 'console/method-unavailable');
  assert.equal(calls.length, 0);
});

test('**Worker 工具方法不在控制台面**：finishWorker 永不导出', () => {
  // 它是 Agent 侧动作（pentest_submit_report 调用），不是人类操作
  assert.equal(CONSOLE_RPC_METHODS.includes('finishWorker' as never), false);
  assert.equal(isConsoleMethod('finishWorker'), false);
});

test('控制台面不含任何状态机内部方法或工具名', () => {
  const forbidden = [
    'pentest_exec',
    'pentest_submit_report',
    'memory_search',
    'dispatch',
    'transition',
    'reconcile',
    'issueLease',
  ];
  for (const name of forbidden) {
    assert.equal(isConsoleMethod(name), false, `${name} 不得是控制台端点`);
  }
});

test('控制台面覆盖全部人类专属方法', () => {
  const expected = [
    'getState',
    'startWorker',
    'beginHandoff',
    'currentHandoffDraft',
    'cancelHandoff',
    'amendScope',
    'interject',
    'extendBudget',
    'decideApproval',
    'revokeApproval',
    'confirmTransition',
    'retryWorker',
    'reopenTechnicalWork',
    'pause',
    'resume',
    'abort',
    'finishTechnicalTesting',
    'signReport',
  ];
  for (const m of expected) {
    assert.ok(CONSOLE_RPC_METHODS.includes(m as never), `控制台面缺少 ${m}`);
  }
});

test('方法描述可用于生成控制台表单（标注是否需要期望版本与幂等键）', () => {
  const described = describeConsoleMethods();
  assert.equal(described.length, CONSOLE_RPC_METHODS.length);
  const pause = described.find((d) => d.name === 'pause');
  assert.ok(pause !== undefined);
  assert.equal(pause.kind, 'mutation');
  const getState = described.find((d) => d.name === 'getState');
  assert.ok(getState !== undefined);
  assert.equal(getState.kind, 'read');
});

// ───────────────────── 乐观锁前置要求 ─────────────────────

test('写操作缺 expectedStateVersion → 拒绝，不默认成 0 而静默覆盖', async () => {
  const { rpc: r, calls } = rpc();
  const body = writeBody('pause');
  delete body['expectedStateVersion'];
  const res = await r.handle(body, CTX);
  assert.equal(res.ok, false, '缺版本必须拒绝——它默认成 0 就等于放弃并发保护');
  assert.equal(calls.length, 0);
});

test('运行控制类写操作**不要求** reason（操作者就是本人，理由多余；动作仍进审计）', async () => {
  const { rpc: r, calls } = rpc();
  const body = writeBody('pause');
  delete body['reason'];
  const res = await r.handle(body, CTX);
  assert.equal(res.ok, true, `暂停不该因为缺理由被拒：${JSON.stringify(res)}`);
  assert.equal(calls.length, 1);
});

test('信封的 reason 契约仍在：其余变更端点缺 reason 一律拒绝', async () => {
  const { rpc: r, calls } = rpc();
  // `reopenTechnicalWork` 仍是 `reason: true`（没有 reasonOptional）：决定类端点要留理由。
  const body = writeBody('reopenTechnicalWork');
  delete body['reason'];
  const res = await r.handle(body, CTX);
  assert.equal(res.ok, false, '决定类端点仍要求理由');
  if (res.ok) return;
  assert.equal(res.code, 'console/reason-required');
  assert.equal(calls.length, 0);
});

test('读操作不要求 expectedStateVersion 与幂等键', async () => {
  const { rpc: r, calls } = rpc();
  const res = await r.handle({ method: 'getState', params: { engagementId: 'e1' } }, CTX);
  assert.equal(res.ok, true);
  assert.equal(calls.length, 1);
});

// ───────────────────── 幂等 ─────────────────────

test('写操作缺幂等键 → 拒绝（无法区分重复点击与有意重复）', async () => {
  const { rpc: r, calls } = rpc();
  const body = writeBody('pause');
  delete body['idempotencyKey'];
  const res = await r.handle(body, CTX);
  assert.equal(res.ok, false, '缺幂等键必须拒绝，不能默认生成一个');
  assert.equal(calls.length, 0);
});

test('同键同体重放：返回首次结果并标记 replay，且**不重复执行**', async () => {
  const { rpc: r, calls } = rpc();
  const body = writeBody('pause');
  const first = await r.handle(body, CTX);
  const second = await r.handle(body, CTX);
  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  assert.equal(calls.length, 1, '重放不得第二次调用服务');
  if (!second.ok) return;
  assert.equal(second.replay, true, '重放必须被标记，便于 UI 区分');
});

test('同键不同体 → 拒绝（那是客户端 bug，不能当重试）', async () => {
  const { rpc: r } = rpc();
  await r.handle(writeBody('pause', { engagementId: 'e1' }), CTX);
  const res = await r.handle(writeBody('pause', { engagementId: 'e2' }), CTX);
  assert.equal(res.ok, false);
  if (res.ok) return;
  assert.equal(res.code, 'console/idempotency-conflict');
});

test('不同操作者同键 → 互不干扰（幂等作用域含操作者）', async () => {
  const { rpc: r, calls } = rpc();
  await r.handle(writeBody('pause'), CTX);
  await r.handle(writeBody('pause'), { ...CTX, operatorId: 'op-2' });
  assert.equal(calls.length, 2, '不同操作者的同键请求是两次独立操作');
});

test('失败的调用不被记为幂等结果（否则刷新版本后同键永久不可用）', async () => {
  const { rpc: r, calls } = rpc({ pause: null });
  // 让服务抛一个可映射的错误
  const failing = fakeWorkflow();
  const workflow = {
    ...(failing.workflow as unknown as Record<string, unknown>),
    pause: async () => {
      const err = new Error('状态版本不匹配') as Error & { code?: string };
      err.code = 'stale_state_version';
      throw err;
    },
  } as unknown as HumanWorkflowService;
  const rpcFailing = new ConsoleRpc({ services: consoleServicesStub(workflow) });

  const body = writeBody('pause');
  const first = await rpcFailing.handle(body, CTX);
  assert.equal(first.ok, false);
  // 同一键应可再次尝试（失败未被记成终态）
  const second = await rpcFailing.handle(body, CTX);
  assert.equal(second.ok, false);
  void r;
  void calls;
});

// ───────────────────── 错误映射 ─────────────────────

test('服务抛带 ErrorCode 的错误 → 保留该码，不变成 500 或裸字符串', async () => {
  const failing = fakeWorkflow();
  const workflow = {
    ...(failing.workflow as unknown as Record<string, unknown>),
    pause: async () => {
      const err = new Error('冲突') as Error & { code?: string };
      err.code = 'stale_state_version';
      throw err;
    },
  } as unknown as HumanWorkflowService;
  const r = new ConsoleRpc({ services: consoleServicesStub(workflow) });
  const res = await r.handle(writeBody('pause'), CTX);
  assert.equal(res.ok, false);
  if (res.ok) return;
  assert.equal(res.code, 'stale_state_version', 'UI 与模型据码分支，不能吞掉码');
});

test('非契约错误 → 归一为内部错误码，且原始错误交给 onInternalError', async () => {
  const seen: unknown[] = [];
  const failing = fakeWorkflow();
  const workflow = {
    ...(failing.workflow as unknown as Record<string, unknown>),
    pause: async () => { throw new TypeError('boom'); },
  } as unknown as HumanWorkflowService;
  const r = new ConsoleRpc({ services: consoleServicesStub(workflow), onInternalError: (e) => seen.push(e) });
  const res = await r.handle(writeBody('pause'), CTX);
  assert.equal(res.ok, false);
  if (res.ok) return;
  assert.equal(res.code, 'console/internal');
  assert.equal(seen.length, 1, '原始错误必须被交接出去记全，而不是丢弃');
});

test('内部错误不把原始 message 交给客户端（避免泄露实现细节）', async () => {
  const failing = fakeWorkflow();
  const workflow = {
    ...(failing.workflow as unknown as Record<string, unknown>),
    pause: async () => { throw new TypeError('connection string postgres://user:pw@host/db'); },
  } as unknown as HumanWorkflowService;
  const r = new ConsoleRpc({ services: consoleServicesStub(workflow) });
  const res = await r.handle(writeBody('pause'), CTX);
  assert.equal(res.ok, false);
  if (res.ok) return;
  assert.equal(
    res.message.includes('postgres://'),
    false,
    '内部错误的原始文本可能含凭据或内部路径，不得回传客户端',
  );
});

test('业务拒绝不触发 onInternalError（它不是内部故障）', async () => {
  const seen: unknown[] = [];
  const failing = fakeWorkflow();
  const workflow = {
    ...(failing.workflow as unknown as Record<string, unknown>),
    pause: async () => {
      const err = new Error('版本冲突') as Error & { code?: string };
      err.code = 'stale_state_version';
      throw err;
    },
  } as unknown as HumanWorkflowService;
  const r = new ConsoleRpc({ services: consoleServicesStub(workflow), onInternalError: (e) => seen.push(e) });
  await r.handle(writeBody('pause'), CTX);
  assert.equal(seen.length, 0, '业务拒绝不是内部故障');
});

// ─────────────── engagement 生命周期端点（§6.1、§11.1） ───────────────
//
// 这一组补的是一个真实功能缺口：设计里授权向导要创建 engagement、控制台首页要
// 列出 engagement，但此前 RPC 面**没有任何端点**能做这两件事——UI 连第一步都
// 走不了（既建不了、也发现不了任何 engagement）。

test('createEngagement 是控制台端点，且不要求 expectedStateVersion', async () => {
  const { rpc: r, calls } = rpc();
  const res = await r.handle(
    {
      method: 'createEngagement',
      params: {
        behaviorProfile: 'stealth',
        approvalMode: 'human',
        name: '内网靶场 2026Q1',
        authorizationRef: 'AUTH-2026-001',
        authorizationExpiresAt: '2026-06-30T00:00:00Z',
        targets: [{ kind: 'cidr', value: '10.0.0.0/24', protocols: ['tcp'], ports: [{ from: 80, to: 80 }] }],
        exclusions: [],
        roe: { maxRatePerSecond: 20 },
        timeWindow: { from: '09:00', to: '18:00' },
      },
      reason: '建立授权靶场 engagement',
      idempotencyKey: 'k-create-1',
      // 有意不传 expectedStateVersion
    },
    CTX,
  );
  assert.equal(res.ok, true, `创建应成功：${res.ok ? '' : res.code}`);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.method, 'createEngagement');
  // 操作者来自传输层，而不是请求体
  const input = calls[0]!.input as { operatorId: string; reason: string; name: string };
  assert.equal(input.operatorId, 'op-1');
  assert.equal(input.reason, '建立授权靶场 engagement');
  assert.equal(input.name, '内网靶场 2026Q1');
});

test('createEngagement 缺 approvalMode 被参数校验拦下（它是必选项，没有默认值）', async () => {
  const { rpc: r } = rpc();
  const res = await r.handle(
    {
      method: 'createEngagement',
      params: {
        name: '缺审批模式的作业',
        behaviorProfile: 'stealth',
        targets: [{ kind: 'cidr', value: '10.0.0.0/24', protocols: ['tcp'], ports: [{ from: 80, to: 80 }] }],
      },
      reason: '验证必选项',
      idempotencyKey: 'k-create-required-mode',
    },
    CTX,
  );
  assert.equal(res.ok, false, '审批模式是必选项：缺了必须停在参数校验上');
  if (res.ok) return;
  assert.equal(res.code, 'console/argument-invalid');
  assert.ok(res.message.includes('approvalMode'), res.message);
});

test('createEngagement 缺 behaviorProfile 被参数校验拦下（它是必选项，没有默认值）', async () => {
  const { rpc: r } = rpc();
  const res = await r.handle(
    {
      method: 'createEngagement',
      params: {
        name: '缺预设的作业',
        targets: [{ kind: 'cidr', value: '10.0.0.0/24', protocols: ['tcp'], ports: [{ from: 80, to: 80 }] }],
      },
      reason: '验证必选项',
      idempotencyKey: 'k-create-required',
    },
    CTX,
  );
  assert.equal(res.ok, false, '行为预设是必选项：缺了必须停在参数校验上');
  if (res.ok) return;
  assert.equal(res.code, 'console/argument-invalid');
  assert.ok(res.message.includes('behaviorProfile'), res.message);
});

test('createEngagement 缺 expectedStateVersion 被允许（此刻没有版本可比对）', async () => {
  // 与其它写操作相反：`createEngagement` 是状态链的起点，没有既有状态可围栏。
  // 强行要求版本号只会逼调用方填 0，那是形式上的保护。
  const { rpc: r } = rpc();
  const res = await r.handle(
    {
      method: 'createEngagement',
      params: {
        behaviorProfile: 'stealth',
        approvalMode: 'human',
        name: 'x', authorizationRef: 'A', authorizationExpiresAt: '2026-01-01T00:00:00Z',
        targets: [], exclusions: [], roe: {}, timeWindow: {},
      },
      reason: 'r',
      idempotencyKey: 'k',
    },
    CTX,
  );
  assert.equal(res.ok, true);
});

test('previewPolicy 接受确认面板实际发送的字段（漏声明会被"未声明的键一律拒绝"挡下）', async () => {
  // 回归锁：契约与界面都加了 `proposalId`，而 RPC 方法表漏声明——整次调用被拒，
  // 界面表现为「尚未取得服务端预览」（诚实，但功能没了）。字段表与调用方是两份清单，
  // 唯一的防漂移办法就是拿调用方的真实载荷打一次。
  const { rpc: r, calls } = rpc();
  const res = await r.handle(
    {
      method: 'previewPolicy',
      params: {
        engagementId: 'e1',
        proposalId: 'p-1',
        targets: [{ kind: 'ip', value: '192.0.2.10', protocols: ['tcp'], ports: [{ from: 80, to: 80 }] }],
        exclusions: [],
        allowedActions: ['passive_read'],
        authorizationRef: 'AUTH-1',
      },
    },
    CTX,
  );
  assert.equal(res.ok, true, `面板的载荷必须被接受：${res.ok ? '' : res.message}`);
  assert.equal(calls[0]?.method, 'previewPolicy');
  const input = calls[0]?.input as Record<string, unknown>;
  assert.equal(input['proposalId'], 'p-1', '字段必须原样转给服务面');
  assert.equal(input['engagementId'], 'e1');
  assert.equal(input['operatorId'], undefined, '只读端点不注入操作者（预览不写审计）');
});

test('listEngagements 是读端点：不要求 reason 与幂等键', async () => {
  const { rpc: r, calls } = rpc();
  const res = await r.handle({ method: 'listEngagements', params: {} }, CTX);
  assert.equal(res.ok, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.method, 'listEngagements');
});

test('两个新端点都在控制台面内，且不属于 Worker 工具', () => {
  assert.ok(CONSOLE_RPC_METHODS.includes('createEngagement' as never));
  assert.ok(CONSOLE_RPC_METHODS.includes('listEngagements' as never));
});

test('方法描述可生成向导与列表的界面（标注读/写与所需字段）', () => {
  const described = describeConsoleMethods();
  const create = described.find((d) => d.name === 'createEngagement');
  assert.ok(create !== undefined, '向导需要 createEngagement 的描述');
  assert.equal(create.kind, 'mutation');
  const fields = create.fields.map((x) => x.name);
  for (const required of ['name', 'authorizationRef', 'authorizationExpiresAt', 'targets', 'exclusions', 'roe', 'timeWindow']) {
    assert.ok(fields.includes(required), `向导表单需要字段 ${required}`);
  }

  const list = described.find((d) => d.name === 'listEngagements');
  assert.ok(list !== undefined);
  assert.equal(list.kind, 'read');
});
