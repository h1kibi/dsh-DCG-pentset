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
  planHashGate,
  planPolicyGate,
  planSessionGate,
  planTemplateGate,
  purposeGate,
  REVALIDATION_GATE_ORDER,
  RevalidationState,
  runAdmissionGates,
  runRevalidationGates,
  scopeGate,
  authorizationGate,
  templateGate,
  type AdmissionPorts,
  type RevalidationPorts,
} from '../src/execution/admission.ts';
import { defaultRegistry } from '../src/execution/templates.ts';
import { derivePlanHash } from '../src/execution/idempotency.ts';
import type {
  ActionIntent,
  ExecutionPlan,
  NormalizedTarget,
  ScopeVerdict,
  SessionLease,
} from '../src/contracts.ts';
import { PURPOSE_MAX_CHARS } from '../src/contracts.ts';
import type { SessionBinding } from '../src/execution/service.ts';

// ───────────────────────────── 夹具 ─────────────────────────────

const TEMPLATE_ID = 'direct_command';
/** 默认注册表里 `direct_command` 的类别（类别复算闸门据此比对）。2026-10-07 起该模板免批 ⇒ `active_probing`。 */
const ACTION_CLASS = 'active_probing';

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
    // 默认工作态：绝大多数用例测的是别的闸门，不该被主状态拦住。
    mainStatus: 'worker_running',
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
  /** 覆盖绑定读取源（惰性语义的用例用它数调用次数）。 */
  readonly bindingSource?: () => Promise<SessionBinding | undefined>;
} = {}): AdmissionState {
  // 用 `in` 判定而不是 `=== undefined`：本组需要能表达「**没有**会话绑定」这个输入
  // （bindingGate 的拒绝路径），而 `undefined` 恰好是「不覆盖」的默认值。
  const value = 'binding' in over ? over.binding : binding();
  const source = over.bindingSource ?? (async () => value);
  const st = new AdmissionState({
    intent: intent(over.intent ?? {}),
    now: new Date('2026-10-05T00:00:00Z'),
    bindingSource: source,
    ports: over.ports ?? ports(),
  });
  // 夹具直接给出「绑定已解析」的状态（除显式覆盖读取源者）：单阶段用例不必先跑一遍
  // `session_bound` 闸门；**惰性语义**由专门那条用例（数调用次数）钉住。
  if (over.bindingSource === undefined) st.resolveBinding(value);
  return st;
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

  test('绑定读取是惰性的：审计闸门先拒绝时**一次会话读都不发生**（2026-10-05 独立评审的 P2）', async () => {
    // 背景：`admit` 曾把 `sessions.binding()` 提到审计闸门之前。读路径若同时故障
    // （连接池耗尽、语句超时），异常会逃逸成「内部错误」，而 §15.1 要的是结构化的
    // `audit_unavailable`。惰性化之后，审计闸门拒绝 → 读取源根本不被调用。
    let reads = 0;
    const st = state({
      bindingSource: async () => { reads += 1; return binding(); },
      ports: ports({ audit: { available: async () => ({ writable: false, detail: '账本只读' }) } }),
    });
    const verdict = await runAdmissionGates(st);
    assert.equal(verdict.kind, 'rejected');
    assert.equal(verdict.kind === 'rejected' ? verdict.gate : '', 'audit_available');
    assert.equal(reads, 0, '审计拒绝必须在任何会话读之前生效');
  });

  test('绑定读取是惰性的：走到会话闸门时**只读一次**（失败记账与闸门共用同一次读）', async () => {
    let reads = 0;
    const st = state({ bindingSource: async () => { reads += 1; return binding(); } });
    const verdict = await runAdmissionGates(st);
    assert.equal(verdict.kind, 'passed');
    assert.equal(reads, 1, '同一状态实例里绑定只读一次（记忆化由调用方保证）');
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

  test('purpose_present：空目的拒绝；长度按 PURPOSE_MAX_CHARS 计，话术要给出实际字数', async () => {
    for (const bad of ['', '   ']) {
      const st = await stateThroughParams({ intent: { purpose: bad } });
      const outcome = await purposeGate.check(st);
      assert.equal(outcome.kind, 'rejected', '空目的应被拒');
      assert.equal(outcome.kind === 'rejected' ? outcome.gateFailure?.rule : '', 'purpose_invalid');
      assert.match(outcome.kind === 'rejected' ? outcome.error.message : '', /为空/, '话术要说清是"没写"');
    }
    // 501 字符**现在合法**：上限提到 4000，因为 `exploit-approval-request` 要求五段（影响面四问 /
    // 停止条件 / 预期证据 / 最小化自查），500 字符装不下——技能与闸门曾经互相打架（2026-10-07 实测）。
    const withinCap = await stateThroughParams({ intent: { purpose: 'x'.repeat(501) } });
    assert.equal((await purposeGate.check(withinCap)).kind, 'pass', '501 字符在上限内，应放行');
    // 超限时报"过长 + 实际字数"，而不是含混的"缺少"
    const tooLong = await stateThroughParams({ intent: { purpose: 'x'.repeat(PURPOSE_MAX_CHARS + 1) } });
    const rejected = await purposeGate.check(tooLong);
    assert.equal(rejected.kind, 'rejected');
    assert.match(
      rejected.kind === 'rejected' ? rejected.error.message : '',
      new RegExp(`当前 ${String(PURPOSE_MAX_CHARS + 1)} 字符，上限 ${String(PURPOSE_MAX_CHARS)}`),
      '超长必须给出实际字数（实测：写超了却被报"缺少"，第一反应是字段没传对）',
    );
  });

  test('action_class_recomputed：策略判定与注册模板不一致即拒绝（不降级）', async () => {
    const st = await stateThroughParams({
      ports: ports({
        policy: policyPorts({
          async classifyAction() {
            // 本用例要的是**故意不一致**（策略说 A、注册表说 B ⇒ 必须拒绝）。
            // 2026-10-07：`direct_command` 自己改成了 `active_probing`，这个夹具若还写同一个值就
            // 变成"一致"了 —— 用例会静默失去意义（实测就是它以 `'pass' !== 'rejected'` 报出来的）。
            return { ok: true, actionClass: 'passive_collection' } as const;
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

  test('engagement 闸门的另一半：主状态不在工作态时也拒（运行标记是 running 也没用）', async () => {
    // 场景：人类按下「结束技术测试」→ 主状态 report_ready，而运行标记仍是 running。
    // 只看标记的话这个闸门会放行，动作于是落在「技术测试已结束」之后
    // （2026-10-05 质检发现的窗口；提交语句的原子条件与此处同源）。
    const finished = state({ binding: binding({ mainStatus: 'report_ready' }) });
    const outcome = await engagementHaltGate.check(finished);
    assert.equal(outcome.kind === 'rejected' ? outcome.error.code : '', 'engagement_halted');
    assert.match(outcome.kind === 'rejected' ? outcome.error.message : '', /report_ready/);
    assert.match(outcome.kind === 'rejected' ? outcome.error.message : '', /worker_running \/ waiting_human_review/);

    // 等待人工判断是**允许**的：人类批准放行后要唤醒 Agent 继续干活。
    const waiting = state({ binding: binding({ mainStatus: 'waiting_human_review' }) });
    const waitingOutcome = await engagementHaltGate.check(waiting);
    assert.equal(waitingOutcome.kind, 'pass');
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

// ───────────────────────────── 执行前复核（plan 形态） ─────────────────────────────

describe('执行前复核闸门（结构）', () => {
  function plan(over: Partial<ExecutionPlan> = {}): ExecutionPlan {
    const base: ExecutionPlan = {
      workerSessionId: 'w1',
      templateId: TEMPLATE_ID,
      actionClass: ACTION_CLASS,
      normalizedTarget: 'ip://10.0.0.5',
      resolvedAddresses: ['10.0.0.5'],
      normalizedCommand: 'shell_exec target=10.0.0.5 port=80 command_b64=AAAA',
      planHash: 'hash-1',
      idempotencyKey: 'key-1',
      scopeVersion: 1,
      policyEpoch: 1,
      policyVersion: 1,
      pacing: null,
      leaseGeneration: 1,
      approvalId: null,
      timeoutMs: 30_000,
      maxOutputBytes: 64 * 1024,
      ...over,
    };
    return base;
  }

  function ports(over: Partial<RevalidationPorts> = {}): RevalidationPorts {
    return {
      registry: defaultRegistry(),
      policy: {
        async validateExecution() {
          return { ok: true } as const;
        },
      },
      sessions: {
        async binding() {
          return binding();
        },
      },
      ...over,
    };
  }

  function rstate(over: {
    readonly plan?: Partial<ExecutionPlan>;
    readonly ports?: RevalidationPorts;
  } = {}): RevalidationState {
    return new RevalidationState({
      plan: plan(over.plan ?? {}),
      now: new Date('2026-10-05T00:00:00Z'),
      ports: over.ports ?? ports(),
    });
  }

  test('复核顺序：先答「形状」（模板/摘要），再答「策略」，最后答「时序」（会话/租约/版本）', () => {
    assert.deepEqual(REVALIDATION_GATE_ORDER, [
      'plan_template_registered',
      'plan_hash_intact',
      'plan_policy_valid',
      'plan_session_bound',
      'plan_engagement_running',
      'plan_lease_valid',
      'plan_scope_version_current',
      'plan_policy_epoch_current',
    ]);
    assert.equal(new Set(REVALIDATION_GATE_ORDER).size, REVALIDATION_GATE_ORDER.length, '名字不得重复');
  });

  test('受理与复核共用同一个短路运行器（第一个非 pass 胜出）', async () => {
    const st = rstate({ plan: { templateId: 'gone' } });
    const verdict = await runRevalidationGates(st);
    assert.equal(verdict.kind === 'rejected' ? verdict.gate : '', 'plan_template_registered');
    // 模板不存在 → 后面的闸门（含读 binding 的那些）不得执行：状态访问器会抛错，这里不抛即证明短路。
  });

  test('plan_hash_intact：计划被改动即使 code=stale_state_version', async () => {
    const st = rstate();
    await planTemplateGate.check(st);
    const verdict = await runRevalidationGates(st);
    assert.equal(verdict.kind === 'rejected' ? verdict.gate : '', 'plan_hash_intact');
    assert.equal(verdict.kind === 'rejected' ? verdict.error.code : '', 'stale_state_version');
  });

  test('plan_session_bound：没有会话绑定即拒绝，且状态记下「已解析为缺失」', async () => {
    const st = rstate({
      plan: { planHash: derivePlanHash({ ...plan(), policyVersion: 1, pacing: null }) },
      ports: ports({
        sessions: {
          async binding() {
            return undefined;
          },
        },
      }),
    });
    await planTemplateGate.check(st);
    await planHashGate.check(st);
    await planPolicyGate.check(st);
    const outcome = await planSessionGate.check(st);
    assert.equal(outcome.kind === 'rejected' ? outcome.error.code : '', 'lease_required');
    assert.equal(st.bindingOrUndefined, undefined, '已解析为「没有绑定」');
    assert.throws(() => st.binding, /会话绑定不存在/);
  });

  test('plan_scope_version_current / plan_policy_epoch_current：都映射到 stale_state_version', async () => {
    for (const [over, gateName] of [
      [{ scopeVersion: 2 }, 'plan_scope_version_current'],
      [{ policyEpoch: 2 }, 'plan_policy_epoch_current'],
    ] as const) {
      const st = rstate({
        plan: { planHash: derivePlanHash({ ...plan(), ...over, policyVersion: 1, pacing: null }), ...over },
      });
      const verdict = await runRevalidationGates(st);
      assert.equal(verdict.kind === 'rejected' ? verdict.gate : '', gateName);
      assert.equal(verdict.kind === 'rejected' ? verdict.error.code : '', 'stale_state_version');
      // 复核失败的消息统一带前缀，便于与受理路径的拒绝区分。
      assert.match(verdict.kind === 'rejected' ? verdict.error.message : '', /执行前复核失败/);
    }
  });
});
