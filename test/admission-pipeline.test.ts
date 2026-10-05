/**
 * 受理闸门管线的结构测试（2026-10-05 复核 C1）。
 *
 * 这个文件钉的是**结构**，不是某一条闸门的业务正确性（那些在 `execution.test.ts` 里，
 * 端到端、不打桩）。结构有四件事值得锁：
 *
 *   1. **顺序**：`ADMISSION_GATE_ORDER` 就是 §10.2 的优先级——「模板未注册」必须早于
 *      「缺租约」报出，短路语义不允许实现成「全跑一遍再挑一个」；
 *   2. **单阶段可测**：每道闸门只依赖 `AdmissionState`（端口 + 已解析事实），
 *      因此可以在没有数据库、没有账本的情况下单独调用并断言结论；
 *   3. **只读**：闸门把「该记什么事件」当数据返回，自己不写任何东西——因此这里能断言
 *      `gateFailure` 的内容，而不用假装有一个账本；
 *   4. **顺序破坏会响亮失败**：状态访问器在事实未解析时抛错（那是编程错误），
 *      而不是悄悄放行或返回 undefined。
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  ADMISSION_GATES,
  ADMISSION_GATE_ORDER,
  AdmissionState,
  adjudicatedAddressesGate,
  auditGate,
  bindingGate,
  classificationGate,
  engagementHaltGate,
  leaseGate,
  paramsGate,
  purposeGate,
  runAdmissionGates,
  scopeGate,
  authorizationGate,
  templateGate,
  type AdmissionPorts,
} from '../src/execution/admission.ts';
import { defaultRegistry } from '../src/execution/templates.ts';
import type { ActionIntent, NormalizedTarget, ScopeVerdict, SessionLease } from '../src/contracts.ts';
import type { SessionBinding } from '../src/execution/service.ts';

// ───────────────────────────── 夹具 ─────────────────────────────

const TEMPLATE_ID = 'direct_command';
/** 默认注册表里 `direct_command` 的类别（类别复算闸门据此比对）。 */
const ACTION_CLASS = 'exploit_validation';

/** 意图：用默认注册表里**真实存在**的那张模板，参数与目的都合规。 */
function intent(over: Partial<ActionIntent> = {}): ActionIntent {
  return {
    workerSessionId: 'w1',
    templateId: TEMPLATE_ID,
    params: {
      port: '80',
      command_b64: Buffer.from('curl -sS http://10.0.0.5/').toString('base64'),
    },
    targetSelector: '10.0.0.5',
    purpose: '确认目标可达性',
    ...over,
  };
}

const TARGET: NormalizedTarget = {
  kind: 'ip',
  host: '10.0.0.5',
  port: 80,
  resolvedAddresses: ['10.0.0.5'],
};

function lease(over: Partial<SessionLease> = {}): SessionLease {
  return {
    id: 'l1',
    workerSessionId: 'w1',
    taskRef: null,
    generation: 1,
    expiresAt: new Date(Date.now() + 600_000),
    revokedAt: null,
    revokedReason: null,
    ...over,
  };
}

function binding(over: Partial<SessionBinding> = {}): SessionBinding {
  return {
    engagementId: 'e1',
    status: 'active',
    engagementStatus: 'running',
    scopeVersion: 1,
    policyEpoch: 1,
    lease: lease(),
    ...over,
  };
}

/** 放行端口面：默认全部通过；每个用例只覆盖自己要触发的那一项。 */
function policyPorts(over: Partial<AdmissionPorts['policy']> = {}): AdmissionPorts['policy'] {
  return {
    async classifyAction() {
      return { ok: true, actionClass: ACTION_CLASS } as const;
    },
    async authorizationValidity() {
      return { ok: true, expiresAt: null } as const;
    },
    async evaluateScope() {
      return { ok: true, normalized: TARGET } as const;
    },
    ...over,
  };
}

function ports(over: Partial<AdmissionPorts> = {}): AdmissionPorts {
  return {
    registry: defaultRegistry(),
    policy: policyPorts(),
    ...over,
  };
}

/**
 * 跑到「模板已解析 + 参数已归一化」那一步的状态。
 *
 * 单阶段用例大多需要这个前置（`paramsGate` 之后的闸门都要读 `state.spec`），
 * 而状态访问器在事实缺失时会抛错——**每次 `state()` 都是新对象**，
 * 因此前置必须在同一个状态上跑完（这里收口，免得每个用例各写一遍、写错一处就抛）。
 */
async function stateThroughParams(over: Parameters<typeof state>[0] = {}): Promise<AdmissionState> {
  const st = state(over);
  const template = await templateGate.check(st);
  assert.equal(template.kind, 'pass', '前置：模板必须已注册');
  const params = await paramsGate.check(st);
  assert.equal(params.kind, 'pass', '前置：参数必须合规');
  return st;
}

function state(over: {
  readonly intent?: Partial<ActionIntent>;
  readonly binding?: SessionBinding | undefined;
  readonly ports?: AdmissionPorts;
} = {}): AdmissionState {
  return new AdmissionState({
    intent: intent(over.intent ?? {}),
    now: new Date('2026-10-05T00:00:00Z'),
    // 用 `in` 判定而不是 `=== undefined`：本组需要能表达「**没有**会话绑定」这个输入
    // （bindingGate 的拒绝路径），而 `undefined` 恰好是「不覆盖」的默认值。
    binding: 'binding' in over ? over.binding : binding(),
    ports: over.ports ?? ports(),
  });
}

// ───────────────────────────── 结构 ─────────────────────────────

describe('受理闸门管线（结构）', () => {
  test('闸门顺序就是 §10.2 的优先级（短路顺序有语义）', () => {
    assert.deepEqual(ADMISSION_GATE_ORDER, [
      'audit_available',
      'template_registered',
      'params_whitelisted',
      'purpose_present',
      'action_class_recomputed',
      'session_bound',
      'authorization_valid',
      'scope_adjudicated',
      'engagement_running',
      'lease_valid',
      'addresses_adjudicated',
    ]);
    // 每道闸门的名字必须非空且唯一——名字是审计与测试里的指认点，重名会让「是谁拒的」失焦。
    const names = ADMISSION_GATES.map((gate) => gate.name);
    assert.equal(new Set(names).size, names.length, '闸门名不得重复');
    assert.ok(names.every((name) => name.trim().length > 0));
  });

  test('短路：第一道闸门拒绝后，后面的闸门不再执行', async () => {
    const ran: string[] = [];
    const st = state({ ports: ports({ audit: { available: async () => ({ writable: false, detail: '账本只读' }) } }) });
    const verdict = await runAdmissionGates(st, [
      auditGate,
      { name: 'should_not_run', async check() { ran.push('second'); return { kind: 'pass' }; } },
    ]);
    assert.equal(verdict.kind, 'rejected');
    assert.equal(verdict.kind === 'rejected' ? verdict.gate : '', 'audit_available');
    assert.deepEqual(ran, [], '拒绝之后不得继续跑后面的闸门');
  });

  test('状态访问器在事实缺失时抛错：那是顺序被破坏，不是输入问题', () => {
    const st = state({ binding: undefined });
    assert.throws(() => st.spec, /受理闸门顺序被破坏/);
    assert.throws(() => st.requireBinding(), /受理闸门顺序被破坏/);
  });
});

// ───────────────────────────── 单阶段 ─────────────────────────────

describe('闸门可独立测试（每道闸门只依赖状态）', () => {
  test('audit_available：审计不可写即拒绝（不看动作类别）', async () => {
    const st = state({ ports: ports({ audit: { available: async () => ({ writable: false, detail: '只读' }) } }) });
    const outcome = await auditGate.check(st);
    assert.equal(outcome.kind, 'rejected');
    assert.equal(outcome.kind === 'rejected' ? outcome.error.code : '', 'audit_unavailable');
    assert.match(outcome.kind === 'rejected' ? outcome.error.message : '', /§15\.1/);
  });

  test('audit_available：未注入探针时通过（单测/只读装配）', async () => {
    assert.deepEqual(await auditGate.check(state()), { kind: 'pass' });
  });

  test('template_registered：未注册模板拒绝，并把「该记什么事件」当数据返回', async () => {
    const st = state({ intent: { templateId: 'no_such_template' } });
    const outcome = await templateGate.check(st);
    assert.equal(outcome.kind, 'rejected');
    if (outcome.kind !== 'rejected') return;
    assert.equal(outcome.error.code, 'classification_rejected');
    assert.deepEqual(outcome.gateFailure, {
      eventType: 'classification.rejected',
      rule: 'template_unregistered',
      detail: '动作模板 no_such_template 未注册',
      normalized: null,
    });
  });

  test('params_whitelisted：未声明的参数被拒（形状校验，不产生闸门事件）', async () => {
    const st = state({ intent: { params: { port: '80', command_b64: 'AAAA', evil: 'x' } } });
    await templateGate.check(st);
    const outcome = await paramsGate.check(st);
    assert.equal(outcome.kind, 'rejected');
    assert.equal(outcome.kind === 'rejected' ? outcome.gateFailure : undefined, undefined, '参数校验不记闸门失败');
  });

  test('purpose_present：空目的与超长目的都拒绝', async () => {
    for (const bad of ['', '   ', 'x'.repeat(501)]) {
      const st = await stateThroughParams({ intent: { purpose: bad } });
      const outcome = await purposeGate.check(st);
      assert.equal(outcome.kind, 'rejected', `目的 ${JSON.stringify(bad.slice(0, 8))} 应被拒`);
      assert.equal(outcome.kind === 'rejected' ? outcome.gateFailure?.rule : '', 'purpose_invalid');
    }
  });

  test('action_class_recomputed：策略判定与注册模板不一致即拒绝（不降级）', async () => {
    const st = await stateThroughParams({
      ports: ports({
        policy: policyPorts({
          async classifyAction() {
            return { ok: true, actionClass: 'active_discovery' } as const;
          },
        }),
      }),
    });
    const outcome = await classificationGate.check(st);
    assert.equal(outcome.kind, 'rejected');
    assert.equal(outcome.kind === 'rejected' ? outcome.gateFailure?.rule : '', 'classification_mismatch');
  });

  test('session_bound / authorization_valid：缺绑定与授权过期各自的码', async () => {
    const noBinding = state({ binding: undefined });
    const boundOutcome = await bindingGate.check(noBinding);
    assert.equal(boundOutcome.kind === 'rejected' ? boundOutcome.error.code : '', 'lease_required');

    const expired = await stateThroughParams({
      ports: ports({
        policy: policyPorts({
          async authorizationValidity() {
            return { ok: true, expiresAt: new Date('2026-10-04T00:00:00Z') } as const;
          },
        }),
      }),
    });
    const authOutcome = await authorizationGate.check(expired);
    assert.equal(authOutcome.kind === 'rejected' ? authOutcome.error.code : '', 'authorization_expired');
  });

  test('scope_adjudicated：范围拒绝映射成稳定码，并把 scope_violation 事件当数据返回', async () => {
    const st = await stateThroughParams({
      ports: ports({
        policy: policyPorts({
          async evaluateScope(): Promise<ScopeVerdict> {
            return { ok: false, code: 'out_of_scope', detail: '不在当前范围版本内', normalized: TARGET };
          },
        }),
      }),
    });
    const outcome = await scopeGate.check(st);
    assert.equal(outcome.kind === 'rejected' ? outcome.error.code : '', 'scope_violation');
    assert.equal(outcome.kind === 'rejected' ? outcome.gateFailure?.eventType : '', 'scope.violation');
    assert.equal(outcome.kind === 'rejected' ? outcome.gateFailure?.rule : '', 'out_of_scope');
  });

  test('addresses_adjudicated：没有已裁决地址即拒绝（绝不退化为容器内 DNS）', async () => {
    const noAddresses: NormalizedTarget = { kind: 'ip', host: '10.0.0.5', port: 80, resolvedAddresses: [] };
    const st = await stateThroughParams({
      ports: ports({
        policy: policyPorts({
          async evaluateScope() {
            return { ok: true, normalized: noAddresses } as const;
          },
        }),
      }),
    });
    await scopeGate.check(st);
    const outcome = await adjudicatedAddressesGate.check(st);
    assert.equal(outcome.kind === 'rejected' ? outcome.error.code : '', 'target_not_adjudicated');
    assert.equal(outcome.kind === 'rejected' ? outcome.gateFailure?.rule : '', 'dns_unresolved');
  });

  test('engagement_running / lease_valid：停机的作业与被撤销的租约各自的码', async () => {
    const halted = state({ binding: binding({ engagementStatus: 'paused' }) });
    const haltOutcome = await engagementHaltGate.check(halted);
    assert.equal(haltOutcome.kind === 'rejected' ? haltOutcome.error.code : '', 'engagement_halted');
    assert.match(haltOutcome.kind === 'rejected' ? haltOutcome.error.next_action : '', /不要换个动作重试/);

    const revoked = state({
      binding: binding({ lease: lease({ revokedAt: new Date('2026-10-04T00:00:00Z'), revokedReason: 'human_revoke' }) }),
    });
    const leaseOutcome = await leaseGate.check(revoked);
    assert.equal(leaseOutcome.kind === 'rejected' ? leaseOutcome.error.code : '', 'lease_revoked');
  });

  test('全部通过：管线给出 passed，且事实都已在状态里可读', async () => {
    const st = state();
    const verdict = await runAdmissionGates(st);
    assert.equal(verdict.kind, 'passed');
    assert.equal(st.spec.template.id, TEMPLATE_ID);
    assert.equal(st.actionClass, ACTION_CLASS);
    assert.equal(st.purpose, '确认目标可达性');
    assert.deepEqual(st.resolvedAddresses, ['10.0.0.5']);
    assert.equal(st.requireBinding().engagementId, 'e1');
  });
});
