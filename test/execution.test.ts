/**
 * 执行管线测试（设计文档 §10.2、§10.2.1、§10.3、§10.3.1）。
 *
 * 覆盖：模板注册与参数白名单、受限载荷、动作类别判定与复算、范围校验、
 * 幂等键派生、一次性放行消费、执行前重裁决、在途终止。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { PER_ACTION_APPROVAL_CLASSES } from '../src/contracts.ts';
import { MECHANISM_FIXTURES } from './helpers/template-fixtures.ts';

import type {
  ActionClass,
  ActionIntent,
  ActionPacing,
  AdmissionDecision,
  ApprovalRecord,
  ErrorCode,
  ExecutionPlan,
  ExecutionService,
  NormalizedTarget,
  PolicyService,
  Protocol,
  ScopeVerdict,
  SessionLease,
  ToolError,
  ToolRunResult,
} from '../src/contracts.ts';
import {
  DEFAULT_TEMPLATES,
  buildDisplayCommand,
  createRegistry,
  findForbiddenPayload,
  portForScope,
  validateParams,
  type ParamBag,
  type ActionTemplateSpec,
  type TemplateRegistry,
} from '../src/execution/templates.ts';
import {
  canonicalTargetString,
  canonicalizeCommand,
  deriveIdempotencyKey,
  derivePlanHash,
  targetLiteral,
} from '../src/execution/idempotency.ts';
import {
  createExecutionService,
  type ActionPolicySnapshot,
  type ActionPolicySource,
  type ApprovalRequest,
  type ExecutionAuditSink,
  type ExecutionStore,
  type GateFailureSink,
  type SandboxExecutor,
  type SandboxRunRequest,
  type SessionBinding,
  type SessionDirectory,
  type ToolRunRecord,
} from '../src/execution/service.ts';

// ───────────────────────────── 夹具 ─────────────────────────────

const ENGAGEMENT = 'eng-1';
const SESSION = 'sess-1';
const HOST = 'app.example.com';
const HTTP_TARGET = `http://${HOST}:80`;
const HTTP_COMMAND = `http_get target=${HTTP_TARGET} method=GET path=/ follow_redirects=false`;

/**
 * 计划摘要现在**要求**策略元数据显式在场（未知时写 `null`，而不是省略）。
 * 大多数用例不关心它们，因此统一在这里补齐——而不是在每个断言里重复 `?? null`。
 */
function hashInput<T extends {
  readonly policyVersion?: number;
  readonly pacing?: ActionPacing | null;
}>(plan: T): T & { readonly policyVersion: number | null; readonly pacing: ActionPacing | null } {
  return { ...plan, policyVersion: plan.policyVersion ?? null, pacing: plan.pacing ?? null };
}

/** 测试专用：利用验证类模板（生产默认集不含高风险模板，需人工注册）。 */
const EXPLOIT_TEMPLATE: ActionTemplateSpec = {
  template: {
    id: 'http_payload_probe',
    actionClass: 'exploit_validation',
    tool: 'http_probe',
    parameters: [{ name: 'payload_id', kind: 'enum', values: ['xss-1', 'sqli-1'] }],
    targetPlaceholder: 'target',
    timeoutMs: 20_000,
    maxOutputBytes: 32 * 1024,
  },
  protocol: 'tcp',
  portSource: { kind: 'target' },
  carries: { payload_id: '受信模板中登记的最小验证载荷标识，不接受自由载荷文本' },
  commandTemplate: 'http_probe target={target} payload_id={payload_id}',
};

/** 测试专用：默认禁用类别模板。 */
const DESTRUCTIVE_TEMPLATE: ActionTemplateSpec = {
  template: {
    id: 'destructive_probe',
    actionClass: 'destructive',
    tool: 'destructive_probe',
    parameters: [{ name: 'mode', kind: 'enum', values: ['dry-run'] }],
    targetPlaceholder: 'target',
    timeoutMs: 5_000,
    maxOutputBytes: 4 * 1024,
  },
  protocol: 'tcp',
  portSource: { kind: 'target' },
  carries: { mode: '仅 dry-run：默认禁用类别需显式开启' },
  commandTemplate: 'destructive_probe target={target} mode={mode}',
};

/** 测试专用：宽松字符串参数，用于验证受限载荷黑名单（而非模式）拦截。 */
const RAW_STRING_TEMPLATE: ActionTemplateSpec = {
  template: {
    id: 'raw_query',
    actionClass: 'passive_collection',
    tool: 'raw_query',
    parameters: [{ name: 'q', kind: 'string', pattern: '.{1,200}' }],
    targetPlaceholder: 'target',
    timeoutMs: 3_000,
    maxOutputBytes: 4 * 1024,
  },
  protocol: 'tcp',
  portSource: { kind: 'target' },
  carries: { q: '仅测试用：任意字符串，用于验证受限载荷黑名单' },
  commandTemplate: 'raw_query target={target} q={q}',
};

/**
 * 夹具模板：**不依赖出厂注册表**。
 *
 * 出厂注册表 2026-10-05 起只剩一张直连命令模板（`direct_command`），而本文件的用例考的是
 * 注册表不变量、参数白名单、端口来源这些**机制**——用显式夹具更稳，也更能说明"这些规则
 * 对任意模板都成立"，而不是"恰好对这五个模板成立"。
 */
const REGISTRY: TemplateRegistry = createRegistry([
  // 出厂就这一张（2026-10-05 清理后），用到它的用例考的正是它本体，所以照搬出厂定义。
  ...DEFAULT_TEMPLATES,
  // 五个机制夹具见 helpers/template-fixtures.ts（policy 侧也用同一份，避免两份定义漂移）。
  ...MECHANISM_FIXTURES,
  EXPLOIT_TEMPLATE,
  DESTRUCTIVE_TEMPLATE,
  RAW_STRING_TEMPLATE,
]);

function specOf(id: string): ActionTemplateSpec {
  const spec = REGISTRY.get(id);
  if (spec === undefined) throw new Error(`夹具缺少模板：${id}`);
  return spec;
}

type ClassifyResult = { ok: true; actionClass: ActionClass } | { ok: false; code: ErrorCode; detail: string };
type ValidateResult = { ok: true; params: ParamBag } | { ok: false; error: ToolError };

interface PolicyState {
  classify?: (input: { templateId: string }) => Promise<ClassifyResult>;
  validate?: (plan: ExecutionPlan) => Promise<ValidateResult>;
  scope?: (input: { target: string; protocol: Protocol; port?: number }) => Promise<ScopeVerdict>;
  scopeCalls: Array<{ target: string; protocol: Protocol; port?: number; scopeVersion: number }>;
  includedHosts: Set<string>;
  excludedHosts: Set<string>;
  unresolvedHosts: Set<string>;
  /** 授权有效期（§11.1）。`null`/未设置 = 未声明到期。 */
  authorizationExpiresAt?: Date | null;
}

interface StoreState {
  approvals: Map<string, ApprovalRecord>;
  requests: ApprovalRequest[];
  finished: Map<string, ToolRunRecord>;
}

interface SandboxState {
  executor: SandboxExecutor;
  calls: SandboxRunRequest[];
  mode: 'immediate' | 'hang' | 'throw';
  result: ToolRunResult;
}

interface SessionsState {
  directory: SessionDirectory;
  binding: SessionBinding | undefined;
}

interface Harness {
  readonly service: ExecutionService;
  readonly policy: PolicyState;
  readonly store: StoreState;
  readonly sandbox: SandboxState;
  readonly sessions: SessionsState;
  readonly now: () => Date;
  advance(ms: number): void;
  setPolicy(policy: ActionPolicySnapshot): void;
  admit(overrides?: Partial<ActionIntent>): Promise<AdmissionDecision>;
  /** 等到沙箱真的被调用：此时 execute 已完成在途登记。 */
  waitForSandboxCall(): Promise<void>;
}

/** 故障/窗口注入点（只为 GAP-3 / GAP-5 这类「时序窗口」回归测试存在）。 */
interface HarnessHooks {
  /** `commitRun` 成功之后、`execute` 继续之前调用（模拟等待窗口内的外部状态变化）。 */
  readonly afterCommit?: () => void;
  /** 返回 true 表示本次 `finishRun` 抛错。 */
  readonly failFinishRun?: () => boolean;
}

function lease(overrides: Partial<SessionLease> = {}): SessionLease {
  return {
    id: 'lease-1',
    workerSessionId: SESSION,
    taskRef: null,
    generation: 3,
    expiresAt: new Date(Date.parse('2026-01-01T01:00:00Z')),
    revokedAt: null,
    revokedReason: null,
    ...overrides,
  };
}

function binding(overrides: Partial<SessionBinding> = {}): SessionBinding {
  return {
    engagementId: ENGAGEMENT,
    status: 'active',
    // 默认 running：绝大多数用例测的是别的闸门，不该被 engagement 状态拦住
    engagementStatus: 'running',
    // 同上：默认工作态（主状态是闸门的另一半）。
    mainStatus: 'worker_running',
    scopeVersion: 1,
    policyEpoch: 1,
    lease: lease(),
    ...overrides,
  };
}

function defaultIntent(overrides: Partial<ActionIntent> = {}): ActionIntent {
  return {
    workerSessionId: SESSION,
    templateId: 'http_read',
    targetSelector: `http://${HOST}/`,
    params: { method: 'GET', path: '/', follow_redirects: 'false' },
    purpose: '被动读取首页以确认服务标识',
    ...overrides,
  };
}

function makeHarness(
  audit?: { available(): Promise<{ writable: boolean; detail: string }> },
  gateFailures?: GateFailureSink,
  executionAudit?: ExecutionAuditSink,
  hooks?: HarnessHooks,
): Harness {
  let nowMs = Date.parse('2026-01-01T00:00:00Z');
  let actionPolicy: ActionPolicySnapshot = {
    perActionApprovalClasses: ['exploit_validation', 'lateral_movement'],
  };

  const policy: PolicyState = {
    scopeCalls: [],
    includedHosts: new Set([HOST, '10.0.0.5', 'evil.example.com']),
    excludedHosts: new Set(['evil.example.com']),
    unresolvedHosts: new Set(['nx.example.com']),
  };

  const normalize = (target: string, port?: number): NormalizedTarget | undefined => {
    const url = /^(https?):\/\/([^/\s]+)(\/\S*)?$/.exec(target);
    if (url !== null) {
      const scheme = url[1] as string;
      const authority = url[2] as string;
      const colon = authority.lastIndexOf(':');
      const host = (colon === -1 ? authority : authority.slice(0, colon)).toLowerCase();
      const explicit = colon === -1 ? undefined : Number(authority.slice(colon + 1));
      return {
        kind: 'url',
        host,
        port: port ?? explicit ?? (scheme === 'https' ? 443 : 80),
        scheme,
        resolvedAddresses: ['93.184.216.34'],
      };
    }
    const host = target.trim().toLowerCase().replace(/\.$/, '');
    if (!/^[a-z0-9.-]+$/.test(host)) return undefined;
    const kind = /^\d+\.\d+\.\d+\.\d+$/.test(host) ? 'ip' : 'domain';
    return {
      kind,
      host,
      ...(port === undefined ? {} : { port }),
      ...(kind === 'ip' ? { resolvedAddresses: [host] } : { resolvedAddresses: ['93.184.216.34'] }),
    };
  };

  const policyService: PolicyService = {
    evaluateScope: async ({ target, protocol, port, scopeVersion }) => {
      policy.scopeCalls.push({ target, protocol, ...(port === undefined ? {} : { port }), scopeVersion });
      if (policy.scope !== undefined) return policy.scope({ target, protocol, ...(port === undefined ? {} : { port }) });
      const normalized = normalize(target, port);
      if (normalized === undefined) return { ok: false, code: 'malformed_target', detail: '无法规范化' };
      if (policy.unresolvedHosts.has(normalized.host)) {
        return { ok: false, code: 'dns_unresolved', detail: '未解析出地址' };
      }
      if (policy.excludedHosts.has(normalized.host)) {
        return { ok: false, code: 'excluded', detail: '命中排除项' };
      }
      if (!policy.includedHosts.has(normalized.host)) {
        return { ok: false, code: 'out_of_scope', detail: '不在范围内' };
      }
      return { ok: true, normalized };
    },
    classifyAction: async (input) => {
      if (policy.classify !== undefined) return policy.classify(input);
      const spec = REGISTRY.get(input.templateId);
      if (spec === undefined) return { ok: false, code: 'classification_rejected', detail: '未注册模板' };
      return { ok: true, actionClass: spec.template.actionClass };
    },
    validateExecution: async (plan) => {
      if (policy.validate !== undefined) return policy.validate(plan);
      return { ok: true };
    },
    authorizationValidity: async () => ({ ok: true, expiresAt: policy.authorizationExpiresAt ?? null }),
  };

  const approvals = new Map<string, ApprovalRecord>();
  const requests: ApprovalRequest[] = [];
  const finished = new Map<string, ToolRunRecord>();
  const pending = new Map<string, { planHash: string; idempotencyKey: string }>();
  let approvalSeq = 0;

  const store: ExecutionStore = {
    findRunByIdempotencyKey: async (key) => finished.get(key),
    requestApproval: async (input) => {
      requests.push(input);
      approvalSeq += 1;
      const approvalId = `appr-${approvalSeq}`;
      approvals.set(approvalId, {
        id: approvalId,
        workerSessionId: input.workerSessionId,
        actionClass: input.actionClass,
        planHash: input.planHash,
        leaseGeneration: input.leaseGeneration,
        // 与真实存储同形：高权限模式的自放行凭证落库时就是 approved。
        decision: input.selfApproval === undefined ? 'pending' : 'approved',
        expiresAt: input.expiresAt,
        consumedAt: null,
      });
      return { approvalId };
    },
    getApproval: async (approvalId) => approvals.get(approvalId),
    consumeApproval: async (approvalId) => {
      const record = approvals.get(approvalId);
      if (record === undefined || record.consumedAt !== null) return false;
      approvals.set(approvalId, { ...record, consumedAt: new Date(nowMs) });
      return true;
    },
    commitRun: async (input) => {
      if (finished.has(input.idempotencyKey)) return { ok: false, reason: 'idempotent_replay' };
      if (input.approvalId !== null) {
        const record = approvals.get(input.approvalId);
        if (record === undefined) return { ok: false, reason: 'approval_not_found' };
        if (record.consumedAt !== null) return { ok: false, reason: 'approval_consumed' };
        approvals.set(input.approvalId, { ...record, consumedAt: new Date(nowMs) });
      }
      pending.set(input.toolRunId, { planHash: input.planHash, idempotencyKey: input.idempotencyKey });
      // 窗口注入点：commitRun 与 sandbox.run 之间（GAP-3 的等待窗口回归测试用）。
      hooks?.afterCommit?.();
      return { ok: true };
    },
    finishRun: async (toolRunId, result) => {
      // 故障注入点：结算回写失败（GAP-5 回归测试用）。
      if (hooks?.failFinishRun?.() === true) throw new Error('模拟结算回写失败（测试注入）');
      const entry = pending.get(toolRunId);
      if (entry === undefined) throw new Error(`未登记的运行：${toolRunId}`);
      finished.set(entry.idempotencyKey, {
        toolRunId,
        idempotencyKey: entry.idempotencyKey,
        planHash: entry.planHash,
        result,
      });
    },
  };

  const sandbox: SandboxState = {
    calls: [],
    mode: 'immediate',
    result: { status: 'completed', exitCode: 0, stdout: 'HTTP/1.1 200 OK' },
    executor: {
      run: async (request, signal) => {
        sandbox.calls.push(request);
        if (sandbox.mode === 'throw') throw new Error('沙箱不可达');
        if (sandbox.mode === 'hang') {
          return await new Promise<ToolRunResult>((resolve) => {
            if (signal.aborted) {
              resolve({ status: 'cancelled' });
              return;
            }
            signal.addEventListener('abort', () => resolve({ status: 'cancelled' }), { once: true });
          });
        }
        return sandbox.result;
      },
    },
  };

  const sessions: SessionsState = {
    binding: binding(),
    directory: {
      // 夹具里所有会话共用一份绑定；未绑定的场景通过把 binding 设为 undefined 表达。
      binding: async () => sessions.binding,
    },
  };

  const actions: ActionPolicySource = { forSession: async () => actionPolicy };

  let idSeq = 0;
  const service = createExecutionService({
    ...(audit === undefined ? {} : { audit }),
    ...(gateFailures === undefined ? {} : { gateFailures }),
    ...(executionAudit === undefined ? {} : { executionAudit }),
    policy: policyService,
    sandbox: sandbox.executor,
    store,
    sessions: sessions.directory,
    registry: REGISTRY,
    actions,
    clock: () => new Date(nowMs),
    newId: (prefix) => {
      idSeq += 1;
      return `${prefix}-${idSeq}`;
    },
    approvalTtlSeconds: 900,
  });

  return {
    service,
    policy,
    store: { approvals, requests, finished },
    sandbox,
    sessions,
    now: () => new Date(nowMs),
    advance(ms) {
      nowMs += ms;
    },
    setPolicy(next) {
      actionPolicy = next;
    },
    admit: (overrides = {}) => service.admit(defaultIntent(overrides)),
    waitForSandboxCall: async () => {
      while (sandbox.calls.length === 0) await new Promise((resolve) => setImmediate(resolve));
    },
  };
}

function rejectCode(decision: AdmissionDecision): ErrorCode | undefined {
  return decision.kind === 'rejected' ? decision.error.code : undefined;
}

function requireRecord(h: Harness, approvalId: string): ApprovalRecord {
  const record = h.store.approvals.get(approvalId);
  if (record === undefined) throw new Error(`夹具缺少放行记录：${approvalId}`);
  return record;
}

/** 走完「申请 → 人类放行 → 携带凭证重新准入」的路径，返回已放行的计划。 */
async function admitApproved(
  h: Harness,
  overrides: Partial<ActionIntent> = {},
): Promise<{ plan: ExecutionPlan; approvalId: string }> {
  const ask = await h.admit({ templateId: 'http_payload_probe', params: { payload_id: 'xss-1' }, ...overrides });
  if (ask.kind !== 'needs_approval') throw new Error(`预期 needs_approval，实际 ${ask.kind}`);
  const approvalId = ask.approvalId;
  h.store.approvals.set(approvalId, {
    ...requireRecord(h, approvalId),
    decision: 'approved',
    expiresAt: new Date(h.now().getTime() + 60_000),
  });
  const decision = await h.admit({
    templateId: 'http_payload_probe',
    params: { payload_id: 'xss-1' },
    approvalId,
    ...overrides,
  });
  if (decision.kind !== 'admitted') {
    throw new Error(`预期 admitted，实际 ${decision.kind}: ${JSON.stringify(decision)}`);
  }
  return { plan: decision.plan, approvalId };
}

// ───────────────────────────── 模板注册表 ─────────────────────────────

test('出厂注册表：一张直连命令 + 两族结构化模板（侦察 / 核验）', () => {
  const registry = createRegistry(DEFAULT_TEMPLATES);
  assert.ok(registry.get('direct_command'), '直连命令：逐条人批的那条通路');
  // 旧示例模板已删：镜像里有真工具（curl/nmap/nc/dig…），Agent 直接写命令，不必先猜模板名。
  for (const gone of ['http_read', 'tcp_connect', 'udp_probe', 'icmp_ping', 'dns_lookup', 'free_command']) {
    assert.equal(registry.get(gone), undefined, `${gone} 应已随清理删除`);
  }
  assert.equal(registry.get('sh_c'), undefined);
  // 2026-10-06 新增两族结构化模板：12 张 `recon_*`（情报收集）+ 4 张 `vuln_*`（漏洞分析），
  // 类别都是 passive_collection/active_probing（不触发逐次放行）+ 那张直连命令 = 17。
  // 数量断言在这里是**刻意的**：模板集变化必须同时改这一行与 test/action-templates.test.ts 的目录断言，
  // 逼人解释新增了什么、以及它落在哪个类别上（类别决定要不要人批）。
  assert.equal(registry.list().length, 17);
});

test('注册表拒绝重复模板 id', () => {
  const spec = specOf('http_read');
  assert.throws(() => createRegistry([spec, spec]), /重复注册/);
});

test('注册表拒绝命令中引用未声明的参数', () => {
  const bad: ActionTemplateSpec = {
    ...specOf('http_read'),
    commandTemplate: 'http_get target={target} method={method} path={path} flags={undeclared}',
  };
  assert.throws(() => createRegistry([bad]), /未声明的参数/);
});

test('注册表要求命令必须且只能引用一次目标占位符', () => {
  const bad: ActionTemplateSpec = {
    ...specOf('http_read'),
    commandTemplate: 'http_get method={method} path={path} follow_redirects={follow_redirects}',
  };
  assert.throws(() => createRegistry([bad]), /目标占位符/);
});

test('注册表要求为每个参数显式声明可携带什么', () => {
  const bad: ActionTemplateSpec = { ...specOf('http_read'), carries: { method: 'HTTP 方法' } };
  assert.throws(() => createRegistry([bad]), /carries/);
});

test('注册表要求 ICMP 模板显式声明无端口维度', () => {
  const bad: ActionTemplateSpec = { ...specOf('icmp_ping'), portSource: { kind: 'param', param: 'count' } };
  assert.throws(() => createRegistry([bad]), /ICMP/);
});

test('注册表拒绝端口来源指向未声明或非整数参数', () => {
  const bad: ActionTemplateSpec = { ...specOf('tcp_connect'), portSource: { kind: 'param', param: 'nope' } };
  assert.throws(() => createRegistry([bad]), /端口来源参数/);
});

// ───────────────────────────── 参数白名单 ─────────────────────────────

test('validateParams 拒绝未声明的参数（不忽略未知字段）', () => {
  const result = validateParams(specOf('http_read').template, {
    method: 'GET',
    path: '/',
    follow_redirects: 'false',
    verbose: 'true',
  });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.error.code, 'classification_rejected');
  assert.match(result.error.message, /未声明的参数 verbose/);
});

test('validateParams 拒绝缺少模板声明的参数（声明即必填）', () => {
  const result = validateParams(specOf('tcp_connect').template, {});
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.match(result.error.message, /缺少参数 port/);
});

test('整数字段接受规范数字串并归一化（宿主链路实测会把 JSON 整数转成字符串）', () => {
  // 现场：模型传 3002，校验看到 "3002" → 报「参数 port 必须是整数」。
  // 后果是所有必填 port 的模板（直连命令 / tcp_connect / udp_probe）全部不可用——
  // 也就是"沙箱里那套真工具完全用不上"。
  const template = specOf('tcp_connect').template;

  const stringified = validateParams(template, { port: '3002' });
  assert.equal(stringified.ok, true, '字符串形式的整数必须接受');
  if (stringified.ok) {
    assert.equal(stringified.params['port'], 3002, '必须归一化成数字——下游按类型处理（范围判定/命令拼装/计划摘要）');
    assert.notEqual(typeof stringified.params['port'], 'string');
  }

  // 数字仍照旧
  assert.equal(validateParams(template, { port: 3002 }).ok, true);

  // 拒的面**不变**：只有规范十进制整数串被接受，别的写法一律拒绝（不 trim、不猜）。
  for (const bad of ['3.5', 'abc', '', ' 3002 ', '3002.0', '1e3', '+3002', '0x10']) {
    assert.equal(validateParams(template, { port: bad }).ok, false, `${JSON.stringify(bad)} 不应被接受`);
  }
});

test('validateParams 拒绝枚举越界与类型不符', () => {
  const template = specOf('http_read').template;
  assert.equal(validateParams(template, { method: 'POST', path: '/', follow_redirects: 'false' }).ok, false);
  assert.equal(validateParams(template, { method: 'GET', path: 42, follow_redirects: 'false' }).ok, false);
});

test('validateParams 拒绝整数越界与小数', () => {
  const template = specOf('tcp_connect').template;
  assert.equal(validateParams(template, { port: 0 }).ok, false);
  assert.equal(validateParams(template, { port: 65536 }).ok, false);
  assert.equal(validateParams(template, { port: 443.5 }).ok, false);
  assert.equal(validateParams(template, { port: 443 }).ok, true);
});

test('validateParams 拒绝违反模板模式的字符串', () => {
  const result = validateParams(specOf('http_read').template, {
    method: 'GET',
    path: '/index.html?debug=1',
    follow_redirects: 'false',
  });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.match(result.error.message, /模式/);
});

test('受限载荷黑名单命中自由形式解释器调用', () => {
  for (const value of [
    'sh -c id',
    'bash -lc "id"',
    'python -c print(1)',
    'python3 -c "import os"',
    'cmd /c whoami',
    'powershell -Command Get-Process',
  ]) {
    assert.ok(findForbiddenPayload(value), `应命中：${value}`);
  }
});

test('受限载荷黑名单命中外部脚本与模板引用', () => {
  for (const value of ['--script /tmp/x.sh', '--template=foo', 'https://evil.example.com/payload.sh']) {
    assert.ok(findForbiddenPayload(value), `应命中：${value}`);
  }
});

test('受限载荷黑名单命中编码载荷与命令替换', () => {
  for (const value of [
    '%2e%2e%2f',
    'YWRtaW46YWRtaW5zZWNyZXQ=',
    'QWxhZGRpbjpvcGVuc2VzYW1lMTIz',
    '\\x41\\x42\\x43',
    '\\u0041\\u0042',
    '$(id)',
    '${IFS}',
    '`id`',
  ]) {
    assert.ok(findForbiddenPayload(value), `应命中：${value}`);
  }
  assert.equal(findForbiddenPayload('/index.html'), undefined);
  assert.equal(findForbiddenPayload('GET'), undefined);
});

test('validateParams 用黑名单拦截宽松字符串参数里的受限载荷', () => {
  const template = specOf('raw_query').template;
  const result = validateParams(template, { q: 'sh -c whoami' });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.match(result.error.message, /受限载荷形态/);
  assert.equal(validateParams(template, { q: 'status' }).ok, true);
});

// ───────────────────────────── 展示形态（放行卡明文命令，C1） ─────────────────────────────
//
// 放行卡是放开权限后唯一的**内容闸门**：把 `command_b64=<base64>` 摆给人类看等于让他盲批。
// `buildDisplayCommand` 负责把 `*_b64` 参数解码成人类可读原文，解码失败则回落（返回 undefined，
// 由调用方回落到 `normalizedCommand`）。

test('buildDisplayCommand 把 *_b64 参数解码为人类可读原文', () => {
  const command = 'id && whoami';
  const b64 = Buffer.from(command, 'utf8').toString('base64');
  assert.equal(buildDisplayCommand(specOf('direct_command'), { port: 443, command_b64: b64 }), command);
});

test('buildDisplayCommand 对非法 base64 返回 undefined（不抛错、不取半截）', () => {
  const spec = specOf('direct_command');
  for (const bad of ['!!!', 'aWQ', 'not-base64!']) {
    assert.equal(buildDisplayCommand(spec, { port: 443, command_b64: bad }), undefined, bad);
  }
});

test('buildDisplayCommand 对非 *_b64 模板返回 undefined（无展示形态，由调用方回落）', () => {
  assert.equal(
    buildDisplayCommand(specOf('http_read'), { method: 'GET', path: '/', follow_redirects: 'false' }),
    undefined,
  );
});

test('free_command 的 command_b64 在入口就校验 base64 形状（非法值进不了放行队列）', () => {
  const template = specOf('direct_command').template;
  const param = template.parameters.find((p) => p.name === 'command_b64');
  assert.ok(param !== undefined);
  assert.equal(param.kind, 'string');
  if (param.kind !== 'string') return;
  assert.equal(param.pattern, '^[A-Za-z0-9+/]+={0,2}$', 'base64 形状必须在参数声明里卡住');

  const rejected = validateParams(template, { port: 443, command_b64: '!!!' });
  assert.equal(rejected.ok, false);
  if (!rejected.ok) assert.match(rejected.error.message, /模式/);
  assert.equal(
    validateParams(template, { port: 443, command_b64: Buffer.from('id', 'utf8').toString('base64') }).ok,
    true,
  );
});

test('portForScope 解析四种端口来源', () => {
  assert.equal(portForScope(specOf('http_read'), { method: 'GET', path: '/', follow_redirects: 'false' }), undefined);
  assert.equal(portForScope(specOf('tcp_connect'), { port: 8443 }), 8443);
  assert.equal(portForScope(specOf('icmp_ping'), { count: 1, size: 32 }), undefined);
  assert.equal(portForScope(specOf('dns_lookup'), { record_type: 'A' }), 53);
});

// ───────────────────────────── 幂等键与摘要 ─────────────────────────────

test('幂等键在参数微调后变化，在排版差异下不变', () => {
  const base = {
    workerSessionId: SESSION,
    actionClass: 'passive_collection' as ActionClass,
    normalizedTarget: HTTP_TARGET,
    normalizedCommand: HTTP_COMMAND,
    approvalId: '',
  };
  const key = deriveIdempotencyKey(base);
  assert.notEqual(key, deriveIdempotencyKey({ ...base, normalizedCommand: `${HTTP_COMMAND}/` }));
  assert.notEqual(
    key,
    deriveIdempotencyKey({ ...base, normalizedCommand: 'http_get target=app.example.com:80 method=GET path=/index.html follow_redirects=false' }),
  );
  assert.equal(
    key,
    deriveIdempotencyKey({
      ...base,
      normalizedCommand: `  http_get   target=${HTTP_TARGET}  method=GET  path=/   follow_redirects=false  `,
    }),
  );
  assert.equal(canonicalizeCommand(' a  b '), 'a b');
});

test('幂等键区分未放行与已放行同一动作、以及不同会话', () => {
  const base = {
    workerSessionId: SESSION,
    actionClass: 'exploit_validation' as ActionClass,
    normalizedTarget: HTTP_TARGET,
    normalizedCommand: `http_probe target=${HTTP_TARGET} payload_id=xss-1`,
    approvalId: '',
  };
  const unapproved = deriveIdempotencyKey(base);
  const approved = deriveIdempotencyKey({ ...base, approvalId: 'appr-1' });
  const otherSession = deriveIdempotencyKey({ ...base, workerSessionId: 'sess-2' });
  assert.notEqual(unapproved, approved);
  assert.notEqual(unapproved, otherSession);
  assert.notEqual(approved, otherSession);
});

test('计划摘要覆盖范围版本、策略 epoch 与命令内容', () => {
  const plan: ExecutionPlan = {
    workerSessionId: SESSION,
    templateId: 'http_read',
    actionClass: 'passive_collection',
    normalizedTarget: HTTP_TARGET,
    resolvedAddresses: ['93.184.216.34'],
    normalizedCommand: HTTP_COMMAND,
    planHash: '',
    idempotencyKey: '',
    scopeVersion: 1,
    policyEpoch: 1,
    leaseGeneration: 3,
    approvalId: null,
    timeoutMs: 15_000,
    maxOutputBytes: 262_144,
  };
  const hash = derivePlanHash(hashInput(plan));
  assert.equal(hash, derivePlanHash(hashInput(plan)));
  assert.notEqual(hash, derivePlanHash({ ...hashInput(plan), scopeVersion: 2 }));
  assert.notEqual(hash, derivePlanHash({ ...hashInput(plan), policyEpoch: 2 }));
  assert.notEqual(hash, derivePlanHash({ ...hashInput(plan), normalizedCommand: `${HTTP_COMMAND} extra=1` }));
  assert.notEqual(hash, derivePlanHash({ ...hashInput(plan), normalizedTarget: 'http://other.example.com:80' }));
  assert.notEqual(hash, derivePlanHash({ ...hashInput(plan), maxOutputBytes: 1024 }));
});

test('规范化目标文本包含 scheme 与已裁决地址集合', () => {
  assert.equal(targetLiteral({ kind: 'domain', host: HOST }), HOST);
  assert.equal(targetLiteral({ kind: 'domain', host: HOST, port: 8443 }), `${HOST}:8443`);
  assert.equal(targetLiteral({ kind: 'url', host: HOST, port: 8443, scheme: 'https' }), `https://${HOST}:8443`);
  assert.equal(
    canonicalTargetString({ kind: 'domain', host: HOST, resolvedAddresses: ['10.0.0.5', '10.0.0.6'] }),
    `${HOST} [10.0.0.5,10.0.0.6]`,
  );
});

// ───────────────────────────── 准入 ─────────────────────────────

test('准入成功：计划由模板注册信息与服务端派生字段构成', async () => {
  const h = makeHarness();
  const decision = await h.admit();
  assert.equal(decision.kind, 'admitted');
  if (decision.kind !== 'admitted') return;
  const plan = decision.plan;
  assert.equal(plan.workerSessionId, SESSION);
  assert.equal(plan.templateId, 'http_read');
  assert.equal(plan.normalizedTarget, `${HTTP_TARGET} [93.184.216.34]`);
  assert.equal(plan.normalizedCommand, `http_get target=${HTTP_TARGET} method=GET path=/ follow_redirects=false`);
  assert.equal(plan.timeoutMs, 15_000);
  assert.equal(plan.maxOutputBytes, 262_144);
  assert.equal(plan.scopeVersion, 1);
  assert.equal(plan.policyEpoch, 1);
  assert.equal(plan.leaseGeneration, 3);
  assert.equal(plan.approvalId, null);
  assert.equal(plan.planHash, derivePlanHash(hashInput(plan)));
  assert.equal(
    plan.idempotencyKey,
    deriveIdempotencyKey({
      workerSessionId: SESSION,
      actionClass: 'passive_collection',
      normalizedTarget: plan.normalizedTarget,
      normalizedCommand: plan.normalizedCommand,
      approvalId: '',
    }),
  );
});

test('准入把模板注册的协议与端口来源交给范围判定', async () => {
  const h = makeHarness();
  await h.admit({ templateId: 'tcp_connect', targetSelector: HOST, params: { port: 8443 } });
  await h.admit({ templateId: 'icmp_ping', targetSelector: HOST, params: { count: 2, size: 64 } });
  await h.admit({ templateId: 'dns_lookup', targetSelector: HOST, params: { record_type: 'A' } });
  assert.deepEqual(h.policy.scopeCalls[0], { target: HOST, protocol: 'tcp', port: 8443, scopeVersion: 1 });
  assert.deepEqual(h.policy.scopeCalls[1], { target: HOST, protocol: 'icmp', scopeVersion: 1 });
  assert.deepEqual(h.policy.scopeCalls[2], { target: HOST, protocol: 'udp', port: 53, scopeVersion: 1 });
});

test('未注册模板被拒绝，绝不降级为低风险放行', async () => {
  const h = makeHarness();
  const decision = await h.admit({ templateId: 'sh_c', params: {} });
  assert.equal(rejectCode(decision), 'classification_rejected');
  assert.equal(h.sandbox.calls.length, 0);
});

test('未声明参数被拒绝（完整准入路径）', async () => {
  const h = makeHarness();
  const decision = await h.admit({
    params: { method: 'GET', path: '/', follow_redirects: 'false', timeout: 1 },
  });
  assert.equal(rejectCode(decision), 'classification_rejected');
});

test('缺少声明参数被拒绝（完整准入路径）', async () => {
  const h = makeHarness();
  const decision = await h.admit({ params: { method: 'GET', follow_redirects: 'false' } });
  assert.equal(rejectCode(decision), 'classification_rejected');
});

test('缺少目的说明被拒绝', async () => {
  const h = makeHarness();
  assert.equal(rejectCode(await h.admit({ purpose: '   ' })), 'classification_rejected');
});

test('无法归类即拒绝，码来自策略判定', async () => {
  const h = makeHarness();
  h.policy.classify = async () => ({ ok: false, code: 'classification_rejected', detail: '无法确定动作类别' });
  assert.equal(rejectCode(await h.admit()), 'classification_rejected');
});

test('类别复算不一致即拒绝（模板注册与策略判定漂移）', async () => {
  const h = makeHarness();
  h.policy.classify = async () => ({ ok: true, actionClass: 'passive_collection' });
  const decision = await h.admit({ templateId: 'tcp_connect', targetSelector: HOST, params: { port: 443 } });
  assert.equal(rejectCode(decision), 'classification_rejected');
  assert.match(decision.kind === 'rejected' ? decision.error.message : '', /一致/);
});

// ─────────────────── 范围违规处置（§10.2.2 / §18.1 验收项） ───────────────────

test('范围违规：记录事件（原始目标 + 规范化结果 + 命中规则 + 发起会话）', async () => {
  // §10.2.2：任何范围校验失败都记录事件，含这四项——缺任何一项，
  // 事后都无法回答「Agent 当时想打哪里、为什么被拒」。
  const recorded: unknown[] = [];
  const sink: GateFailureSink = {
    async record(input) {
      recorded.push(input);
      return 1;
    },
  };
  const h = makeHarness(undefined, sink);

  assert.equal(rejectCode(await h.admit({ targetSelector: 'http://outside.example.org/' })), 'scope_violation');

  assert.equal(recorded.length, 1, '每次范围校验失败都要记一条');
  const entry = recorded[0] as {
    eventType: string; rawTarget: string; rule: string; workerSessionId: string;
  };
  assert.equal(entry.eventType, 'scope.violation');
  assert.equal(entry.rawTarget, 'http://outside.example.org/', '原始目标必须是 Agent 提交的那个');
  assert.notEqual(entry.rule, '', '必须记下命中的规则（范围拒绝码）');
  assert.notEqual(entry.workerSessionId, '', '必须记下发起会话——否则无法归因到哪一轮');
});

test('范围违规：连续三次自动暂停（§10.2.2）', async () => {
  // 文档给的理由值得注意：**这通常意味着任务描述有歧义，而不是偶发失误**——
  // 所以处置是交人类判断，而不是让它重试。
  const counts: number[] = [];
  let paused: { count: number } | null = null;
  const sink: GateFailureSink = {
    async record() {
      const n = counts.length + 1;
      counts.push(n);
      return n;
    },
    async pauseForScopeViolations(input) {
      paused = { count: input.count };
    },
  };
  const h = makeHarness(undefined, sink);

  await h.admit({ targetSelector: 'http://outside.example.org/' });
  assert.equal(paused, null, '第 1 次不该暂停');
  await h.admit({ targetSelector: 'http://outside.example.org/' });
  assert.equal(paused, null, '第 2 次不该暂停');
  await h.admit({ targetSelector: 'http://outside.example.org/' });
  assert.deepEqual(paused, { count: 3 }, '第 3 次（阈值）必须自动暂停');
});

test('分类失败记 classification.rejected，且不触发自动暂停', async () => {
  // 与范围违规分开：§10.2.2 的自动暂停**只针对范围违规**。
  // 把它们混在一起会让「Agent 拼错模板名」也把会话停掉。
  const recorded: { eventType: string }[] = [];
  let pausedCount = 0;
  const sink: GateFailureSink = {
    async record(input) {
      recorded.push({ eventType: input.eventType });
      return 99; // 故意给一个大数：分类失败也不该暂停
    },
    async pauseForScopeViolations() {
      pausedCount += 1;
    },
  };
  const h = makeHarness(undefined, sink);

  assert.equal(rejectCode(await h.admit({ templateId: 'no-such-template' })), 'classification_rejected');

  assert.deepEqual(recorded, [{ eventType: 'classification.rejected' }]);
  assert.equal(pausedCount, 0, '分类失败不累计、不暂停');
});

test('省略 sink 时不记录：拒绝结论照常返回（记账失败不影响安全结论）', async () => {
  // 记账是附加要求，不是拒绝的前提。反过来「记不进去就不拒绝」才是危险的方向。
  const h = makeHarness();
  assert.equal(rejectCode(await h.admit({ targetSelector: 'http://outside.example.org/' })), 'scope_violation');
});

// ─────────────────── 审计闸门（§15.1 的硬约束） ───────────────────

test('审计不可写：所有触及目标的动作一律停止（不按风险分类挑拣）', async () => {
  // §15.1 的原话是「审计写入不可用 → **所有**触及目标的动作一律停止（不按风险分类
  // 挑拣——分类准确度不足以支撑"只停高风险"的降级）」。
  //
  // 此前 `executionGateForAudit` 只有定义与单测，**没有任何生产调用点**：
  // 执行管线里没有这道闸门，间接保护只有「写 tool_runs 本身需要 DB」——
  // 而那是在动作**之后**才生效的，这里要的是「根本不受理」。
  const h = makeHarness({
    async available() {
      return { writable: false, detail: '独占写连接已断开' };
    },
  });

  const decision = await h.admit({ targetSelector: `http://${HOST}:8443/` });

  assert.equal(rejectCode(decision), 'audit_unavailable');
  assert.equal(h.store.requests.length, 0, '审计不可写时不该产生放行申请');
  assert.equal(h.sandbox.calls.length, 0, '更不该触碰沙箱');
});

test('审计不可写时连低风险动作也停：判据不看动作类别', async () => {
  // 挑一个明确不需要逐次放行的类别（`passive_collection`），确认它同样被拦。
  // 「只停高风险」的降级正是 §15.1 点名反对的。
  const h = makeHarness({
    async available() {
      return { writable: false, detail: '连接池耗尽' };
    },
  });
  assert.equal(
    rejectCode(await h.admit({ targetSelector: `http://${HOST}:8443/`, templateId: 'http_get' })),
    'audit_unavailable',
  );
});

test('审计可写：照常受理（闸门不是「永远拒绝」）', async () => {
  // 反向断言。缺了它，这道闸门可能被「永远拒绝」地修错——那同样破坏功能，
  // 只是表现从「静默越权」变成「什么都做不了」。
  const h = makeHarness({
    async available() {
      return { writable: true, detail: '' };
    },
  });
  assert.notEqual(rejectCode(await h.admit({ targetSelector: `http://${HOST}:8443/` })), 'audit_unavailable');
});

test('省略探针即视为可写：headless 与单元测试不需要它', async () => {
  // 默认「可写」而不是「不可写」：默认拒绝会让所有未配置探针的部署整体停摆，
  // 那比漏一道闸门更坏。生产装配由 compose 显式提供，不存在「忘了配」的静默降级。
  const h = makeHarness(); // 不传 audit
  const decision = await h.admit({ targetSelector: `http://${HOST}:8443/` });
  assert.notEqual(rejectCode(decision), 'audit_unavailable', '没有探针时不该因审计而拒绝');
  // 并且它确实走到了范围判定——证明没有被闸门提前拦下。
  assert.equal(h.policy.scopeCalls.length, 1);
});

// ─────────────────── 授权有效期（§11.1 的硬边） ───────────────────

test('授权未过期：照常受理', async () => {
  const h = makeHarness();
  // 时钟从 2026-01-01 起算；到期在之后。
  h.policy.authorizationExpiresAt = new Date('2026-06-01T00:00:00Z');
  const decision = await h.admit({ targetSelector: `http://${HOST}:8443/` });
  assert.notEqual(rejectCode(decision), 'authorization_expired');
});

test('授权已过期：拒绝受理，且不创建放行记录、不触碰沙箱', async () => {
  // §11.1 的原话是「到期后新动作应被拒」。此前的实现只在界面显示到期时间，
  // 服务端准入完全不读它——过期之后动作照旧受理、照旧能被执行。
  // 这条测试把「硬边」钉在受理路径上。
  const h = makeHarness();
  h.policy.authorizationExpiresAt = new Date('2025-12-31T23:59:59Z'); // 早于夹具时钟（2026-01-01）

  const decision = await h.admit({ targetSelector: `http://${HOST}:8443/` });

  assert.equal(rejectCode(decision), 'authorization_expired');
  assert.equal(h.store.requests.length, 0, '过期的授权不该产生放行申请——人类无权批准它');
  assert.equal(h.sandbox.calls.length, 0, '更不该触碰沙箱');
});

test('授权恰好在此刻到期：按已过期处理（边界是闭区间）', async () => {
  // `<=` 而不是 `<`：到期时间表示「到这一刻为止有效」，所以该时刻本身已失效。
  // 边界写反会让授权在最后一刻多出一个可乘窗口。
  const h = makeHarness();
  h.policy.authorizationExpiresAt = h.now();
  assert.equal(rejectCode(await h.admit({ targetSelector: `http://${HOST}:8443/` })), 'authorization_expired');
});

test('未声明到期时间：不因缺失而拒绝（那是创建时的向导闸门）', async () => {
  // 缺到期时间由建 engagement 时的必填闸门挡住（§11.1）。把它当「已过期」会
  // 一次性拒掉所有未声明到期的历史数据，而那是另一种 fail-closed 的误伤。
  const h = makeHarness();
  h.policy.authorizationExpiresAt = null;
  assert.notEqual(rejectCode(await h.admit({ targetSelector: `http://${HOST}:8443/` })), 'authorization_expired');
});

test('范围外目标被拒绝', async () => {
  const h = makeHarness();
  assert.equal(rejectCode(await h.admit({ targetSelector: 'http://outside.example.org/' })), 'scope_violation');
  assert.equal(h.sandbox.calls.length, 0);
});

test('排除项优先于包含项', async () => {
  const h = makeHarness();
  const decision = await h.admit({ targetSelector: 'http://evil.example.com/' });
  assert.equal(rejectCode(decision), 'scope_violation');
  assert.match(decision.kind === 'rejected' ? decision.error.message : '', /excluded/);
});

test('DNS 未裁决出地址被拒绝，不退化按域名拨号', async () => {
  const h = makeHarness();
  h.policy.includedHosts.add('nx.example.com');
  assert.equal(rejectCode(await h.admit({ targetSelector: 'http://nx.example.com/' })), 'target_not_adjudicated');
});

test('协议无法确定被拒绝', async () => {
  const h = makeHarness();
  h.policy.scope = async () => ({ ok: false, code: 'protocol_undetermined', detail: '选择器未携带协议' });
  assert.equal(rejectCode(await h.admit()), 'protocol_undetermined');
});

test('非法目标形态被拒绝', async () => {
  const h = makeHarness();
  assert.equal(rejectCode(await h.admit({ targetSelector: `https://${HOST}@evil.example.org/` })), 'scope_violation');
});

test('无会话绑定被拒绝', async () => {
  const h = makeHarness();
  h.sessions.binding = undefined;
  assert.equal(rejectCode(await h.admit()), 'lease_required');
});

test('租约被撤销被拒绝', async () => {
  const h = makeHarness();
  h.sessions.binding = binding({
    lease: lease({ revokedAt: new Date('2025-12-31T23:00:00Z'), revokedReason: 'human_revoke' }),
  });
  assert.equal(rejectCode(await h.admit()), 'lease_revoked');
});

test('租约过期被拒绝', async () => {
  const h = makeHarness();
  h.advance(3_600_000);
  assert.equal(rejectCode(await h.admit()), 'lease_expired');
});

test('会话处于终态被拒绝', async () => {
  const h = makeHarness();
  h.sessions.binding = binding({ status: 'closed' });
  assert.equal(rejectCode(await h.admit()), 'lease_revoked');
});

// ─────────────── engagement 运行标记闸门（§5.1、§15.1、§15.2） ───────────────
//
// 这一组防的是「人类闸门沦为装饰」：运行标记只落库而不拦动作时，
// `pause` 与恢复对账的 `blocked` 对目标动作毫无约束力。

test('engagement 暂停 → 动作被拒（pause 必须真的拦住目标动作）', async () => {
  const h = makeHarness();
  h.sessions.binding = binding({ engagementStatus: 'paused' });
  assert.equal(rejectCode(await h.admit()), 'engagement_halted');
});

test('engagement 阻塞 → 动作被拒（恢复对账的 blocked 必须有效）', async () => {
  const h = makeHarness();
  h.sessions.binding = binding({ engagementStatus: 'blocked' });
  assert.equal(rejectCode(await h.admit()), 'engagement_halted');
});

test('engagement 终止/失败 → 动作被拒', async () => {
  for (const marker of ['aborted', 'failed'] as const) {
    const h = makeHarness();
    h.sessions.binding = binding({ engagementStatus: marker });
    assert.equal(rejectCode(await h.admit()), 'engagement_halted', marker);
  }
});

test('engagement 运行时正常放行（闸门不得误拦）', async () => {
  const h = makeHarness();
  h.sessions.binding = binding({ engagementStatus: 'running' });
  const decision = await h.admit();
  assert.notEqual(decision.kind, 'rejected');
});

test('运行标记闸门先于租约判定：已停时告知「整个 engagement 停了」而非「缺租约」', async () => {
  // 顺序很重要：若先报 lease_required，模型的下一动作是去续租——而那在
  // engagement 已停的状态下毫无意义，会白费一轮。
  const h = makeHarness();
  h.sessions.binding = binding({ engagementStatus: 'paused', lease: null });
  assert.equal(rejectCode(await h.admit()), 'engagement_halted');
});

test('拒绝信息包含恢复指引，且明确「不要换个动作重试」', async () => {
  const h = makeHarness();
  h.sessions.binding = binding({ engagementStatus: 'paused' });
  const decision = await h.admit();
  assert.equal(decision.kind, 'rejected');
  if (decision.kind !== 'rejected') return;
  assert.match(decision.error.message, /不在运行状态/);
  assert.match(decision.error.next_action, /不要换个动作重试/);
  assert.match(decision.error.next_action, /等待人类/);
});

test('默认禁用类别被拒绝，显式开启并双人确认后才进入放行流程', async () => {
  const h = makeHarness();
  const destructive = { templateId: 'destructive_probe', params: { mode: 'dry-run' } };
  assert.equal(rejectCode(await h.admit(destructive)), 'classification_rejected');

  h.setPolicy({
    perActionApprovalClasses: ['exploit_validation'],
    enabledDisabledClasses: ['destructive'],
  });
  assert.equal(rejectCode(await h.admit(destructive)), 'classification_rejected');

  h.setPolicy({
    perActionApprovalClasses: ['exploit_validation', 'destructive'],
    enabledDisabledClasses: ['destructive'],
    dualConfirmed: true,
  });
  assert.equal((await h.admit(destructive)).kind, 'needs_approval');
});

test('超出行为预设不再是拒绝理由：不在启用集合里的类别强制走人工放行', async () => {
  // 回归锁（2026-10-04 语义变更）：`enabledActionClasses` 曾是硬拒闸门（规则
  // `not_enabled_by_policy`）——Agent 一越出预设就被弹回，只能反复试探或干脆放弃。
  // 现在它只表示「超出当前行为预设」，结论是**把人拉进回路**（needs_approval），不是拒绝。
  //
  // 关键构造：把逐次放行集合清空，让 `exploit_validation` **只可能**因为「超出预设」
  // 才被拦下——否则 `perActionApprovalClasses` 的契约下限会掩盖这条新语义（两者是「或」）。
  const checked: Array<Record<string, unknown>> = [];
  const h = makeHarness(undefined, undefined, {
    record: async (input) => {
      if (input.eventType === 'execution.policy.checked') checked.push(input.payload);
    },
  });
  h.setPolicy({
    perActionApprovalClasses: [],
    enabledActionClasses: ['passive_collection', 'active_probing'],
  });

  // `id` 的 base64：自由命令最直接地落在 exploit_validation 类。
  const commandB64 = Buffer.from('id', 'utf8').toString('base64');
  const decision = await h.admit({
    templateId: 'direct_command',
    targetSelector: `https://${HOST}/`,
    params: { port: 443, command_b64: commandB64 },
    purpose: '验证超出预设的动作转入人工放行而非被拒',
  });

  assert.notEqual(decision.kind, 'rejected', '超出预设不再是拒绝理由');
  assert.equal(decision.kind, 'needs_approval');
  if (decision.kind !== 'needs_approval') return;
  assert.ok(decision.approvalId.length > 0, '超出预设必须拿到放行凭证');
  assert.equal(h.store.requests.length, 1);
  assert.equal(h.store.requests[0]?.actionClass, 'exploit_validation');
  assert.equal(
    checked.some((p) => p['decision'] === 'needs_approval' && p['rule'] === 'beyond_behavior_preset'),
    true,
    '必须记下 beyond_behavior_preset：否则「为什么被拦」在审计里无从追溯',
  );
});

test('超出行为预设时审计写不进去：停止受理且不创建放行凭证（§11.5）', async () => {
  // 纪律一致性（2026-10-04 追加）：预设放行与逐次放行是同一条「审计不可用即停止」，
  // 不能因为「反正还要人批」就放它过去——人要批的是服务端记录在案的动作。
  const h = makeHarness(undefined, undefined, {
    record: async (input) => {
      if (input.eventType === 'execution.policy.checked' && input.payload['rule'] === 'beyond_behavior_preset') {
        throw new Error('账本不可写');
      }
    },
  });
  h.setPolicy({
    perActionApprovalClasses: [],
    enabledActionClasses: ['passive_collection', 'active_probing'],
  });
  const intent = {
    templateId: 'direct_command',
    targetSelector: `https://${HOST}/`,
    params: { port: 443, command_b64: Buffer.from('id', 'utf8').toString('base64') },
    purpose: '审计不可用时超出预设的动作必须停止受理',
  } as const;

  const decision = await h.admit(intent);
  assert.equal(decision.kind, 'rejected', '审计写不进去时必须停止受理，而不是返回 needs_approval');
  assert.equal(rejectCode(decision), 'audit_unavailable');
  if (decision.kind === 'rejected') {
    assert.match(decision.error.message, /超出行为预设的动作已停止受理/);
  }
  assert.equal(h.store.requests.length, 0, '审计写不进去时不得创建放行凭证');

  // 对照组：同一夹具、审计正常时仍是 needs_approval。
  const control = makeHarness();
  control.setPolicy({
    perActionApprovalClasses: [],
    enabledActionClasses: ['passive_collection', 'active_probing'],
  });
  assert.equal((await control.admit(intent)).kind, 'needs_approval');
});

test('启用集合内的类别照常受理：超出预设机制不得误拦', async () => {
  const h = makeHarness();
  h.setPolicy({
    perActionApprovalClasses: [],
    enabledActionClasses: ['passive_collection', 'active_probing'],
  });
  const decision = await h.admit(); // 默认 http_read，属 passive_collection
  assert.equal(decision.kind, 'admitted');
  assert.equal(h.store.requests.length, 0, '预设内且无需逐次放行的动作不应进入放行队列');
});

test('默认禁用类别先于「超出预设」判定：即便超出预设也无条件硬拒（未双确认）', async () => {
  const h = makeHarness();
  h.setPolicy({
    perActionApprovalClasses: [],
    enabledActionClasses: ['passive_collection', 'active_probing'],
  });
  const decision = await h.admit({ templateId: 'destructive_probe', params: { mode: 'dry-run' } });
  assert.equal(decision.kind, 'rejected');
  assert.equal(rejectCode(decision), 'classification_rejected');
  assert.equal(h.store.requests.length, 0, '默认禁用类别不得因「超出预设」而落到放行队列');
});

test('需放行类别返回 needs_approval，放行记录携带完整执行内容', async () => {
  const h = makeHarness();
  const decision = await h.admit({
    templateId: 'http_payload_probe',
    params: { payload_id: 'xss-1' },
    targetSelector: `http://${HOST}/search`,
    purpose: '验证反射型 XSS 的最小载荷',
  });
  assert.equal(decision.kind, 'needs_approval');
  if (decision.kind !== 'needs_approval') return;
  const request = h.store.requests[0];
  assert.ok(request);
  if (request === undefined) return;
  assert.equal(request.actionClass, 'exploit_validation');
  assert.equal(request.normalizedTarget, `${HTTP_TARGET} [93.184.216.34]`);
  assert.equal(request.normalizedCommand, `http_probe target=${HTTP_TARGET} payload_id=xss-1`);
  assert.equal(request.timeoutMs, 20_000);
  assert.equal(request.maxOutputBytes, 32 * 1024);
  assert.equal(request.purpose, '验证反射型 XSS 的最小载荷');
  assert.equal(request.planHash, decision.planHash);
  assert.equal(request.leaseGeneration, 3, '放行申请必须冻结当前租约世代');
  assert.equal(request.expiresAt.getTime(), h.now().getTime() + 900_000);
});

test('放行通过的凭证放行同一计划，幂等键与未放行版本不同', async () => {
  const h = makeHarness();
  const { plan, approvalId } = await admitApproved(h);
  assert.equal(plan.approvalId, approvalId);
  assert.equal(plan.actionClass, 'exploit_validation');

  const withApproval = deriveIdempotencyKey({
    workerSessionId: SESSION,
    actionClass: 'exploit_validation',
    normalizedTarget: plan.normalizedTarget,
    normalizedCommand: plan.normalizedCommand,
    approvalId,
  });
  const withoutApproval = deriveIdempotencyKey({
    workerSessionId: SESSION,
    actionClass: 'exploit_validation',
    normalizedTarget: plan.normalizedTarget,
    normalizedCommand: plan.normalizedCommand,
    approvalId: '',
  });
  assert.equal(plan.idempotencyKey, withApproval);
  assert.notEqual(withApproval, withoutApproval);
});

test('凭证仍待人类处理时被拒绝，并回带凭证标识', async () => {
  const h = makeHarness();
  const ask = await h.admit({ templateId: 'http_payload_probe', params: { payload_id: 'xss-1' } });
  if (ask.kind !== 'needs_approval') throw new Error(`预期 needs_approval，实际 ${ask.kind}`);
  const decision = await h.admit({
    templateId: 'http_payload_probe',
    params: { payload_id: 'xss-1' },
    approvalId: ask.approvalId,
  });
  assert.equal(rejectCode(decision), 'approval_required');
  assert.equal(decision.kind === 'rejected' ? decision.error.approval_id : undefined, ask.approvalId);
});

test('凭证被拒绝、撤销或被取代时被拒绝', async () => {
  const h = makeHarness();
  for (const state of ['rejected', 'revoked', 'superseded'] as const) {
    const ask = await h.admit({ templateId: 'http_payload_probe', params: { payload_id: 'xss-1' } });
    if (ask.kind !== 'needs_approval') throw new Error('unreachable');
    h.store.approvals.set(ask.approvalId, { ...requireRecord(h, ask.approvalId), decision: state });
    const decision = await h.admit({
      templateId: 'http_payload_probe',
      params: { payload_id: 'xss-1' },
      approvalId: ask.approvalId,
    });
    assert.equal(rejectCode(decision), 'approval_revoked', state);
  }
});

test('凭证过期（时效已过）时被拒绝', async () => {
  const h = makeHarness();
  const ask = await h.admit({ templateId: 'http_payload_probe', params: { payload_id: 'xss-1' } });
  if (ask.kind !== 'needs_approval') throw new Error('unreachable');
  h.store.approvals.set(ask.approvalId, { ...requireRecord(h, ask.approvalId), decision: 'approved' });
  h.advance(901_000);
  const decision = await h.admit({
    templateId: 'http_payload_probe',
    params: { payload_id: 'xss-1' },
    approvalId: ask.approvalId,
  });
  assert.equal(rejectCode(decision), 'approval_expired');
});

test('凭证被消费后不能再用', async () => {
  const h = makeHarness();
  const { approvalId } = await admitApproved(h);
  assert.equal(await h.service.consumeApproval(approvalId, 'run-x'), true);
  const decision = await h.admit({
    templateId: 'http_payload_probe',
    params: { payload_id: 'xss-1' },
    approvalId,
  });
  assert.equal(rejectCode(decision), 'approval_consumed');
});

test('凭证不跨会话沿用', async () => {
  const h = makeHarness();
  const { approvalId } = await admitApproved(h);
  const decision = await h.service.admit({
    workerSessionId: 'sess-2',
    templateId: 'http_payload_probe',
    targetSelector: `http://${HOST}/`,
    params: { payload_id: 'xss-1' },
    purpose: '另一个会话尝试复用凭证',
    approvalId,
  });
  assert.equal(rejectCode(decision), 'approval_required');
});

test('范围版本变化使已放行凭证失效', async () => {
  const h = makeHarness();
  const { approvalId } = await admitApproved(h);
  h.sessions.binding = binding({ scopeVersion: 2 });
  const decision = await h.admit({
    templateId: 'http_payload_probe',
    params: { payload_id: 'xss-1' },
    approvalId,
  });
  assert.equal(rejectCode(decision), 'approval_required');
});

test('pacing 审计写入失败：动作被拒且槽位释放（后续动作不被卡死）', async () => {
  // 回归锁（一致性审查发现）：`execution.pacing.applied` 曾写在取得槽位之后、
  // 受保护的 try 之外——审计写失败会带着槽位一起抛出，release 永不执行。
  // 后果不是「这次动作失败」，而是**该作业后续所有动作在并发等待里无限卡死**（无自愈）。
  //
  // 这里用 `rate: 0`（只留并发上限）：并发是这条缺陷的判据，速率只会给用例引入真实等待。
  const recorded: string[] = [];
  let failPacingAudit = true;
  const h = makeHarness(undefined, undefined, {
    record: async (input) => {
      recorded.push(input.eventType);
      if (input.eventType === 'execution.pacing.applied' && failPacingAudit) {
        throw new Error('账本不可写');
      }
    },
  });
  h.setPolicy({
    perActionApprovalClasses: [],
    policyVersion: 3,
    pacing: { rate: 0, concurrency: 1, jitter: 0, burst: 1, retry: 0 },
  });

  const first = await h.admit();
  if (first.kind !== 'admitted') throw new Error(`应当受理：${JSON.stringify(first)}`);
  const blocked = await h.service.execute(first.plan, new AbortController().signal);
  assert.equal(blocked.status, 'blocked');
  assert.equal(blocked.error?.code, 'audit_unavailable', '审计失败必须报 audit_unavailable，而不是沙箱故障');
  assert.equal(h.sandbox.calls.length, 0, '审计写不进去时不得进入沙箱');

  // 槽位必须已释放：换一个动作（幂等键不同）应当能跑到沙箱。
  // 判据用**有界的宏任务轮次**而不是真实计时器：槽位泄漏时第二次执行会停在等待循环里，
  // 轮次耗尽即判定「没到沙箱」，既不引入固定延迟，也不靠「睡够久」猜竞态。
  failPacingAudit = false;
  const second = await h.admit({ params: { method: 'GET', path: '/second', follow_redirects: 'false' } });
  if (second.kind !== 'admitted') throw new Error(`应当受理：${JSON.stringify(second)}`);
  const controller = new AbortController();
  const running = h.service.execute(second.plan, controller.signal);
  let reachedSandbox = false;
  for (let turn = 0; turn < 64 && !reachedSandbox; turn += 1) {
    await new Promise((resolve) => setImmediate(resolve));
    reachedSandbox = h.sandbox.calls.length > 0;
  }
  if (!reachedSandbox) controller.abort(); // 让挂住的那次执行以 cancelled 收尾，不留悬空 Promise
  const result = await running;
  assert.ok(reachedSandbox, '第二次动作必须进入沙箱；停在等待循环说明槽位没被释放');
  assert.equal(result.status, 'completed');
  assert.ok(recorded.includes('execution.pacing.applied'));
});

test('策略 epoch 前进使已放行凭证失效', async () => {
  const h = makeHarness();
  const { approvalId } = await admitApproved(h);
  h.sessions.binding = binding({ policyEpoch: 2 });
  const decision = await h.admit({
    templateId: 'http_payload_probe',
    params: { payload_id: 'xss-1' },
    approvalId,
  });
  assert.equal(rejectCode(decision), 'approval_required');
});

test('租约世代变化使已放行凭证失效', async () => {
  const h = makeHarness();
  const { approvalId } = await admitApproved(h);
  h.sessions.binding = binding({ lease: lease({ generation: 4 }) });
  const decision = await h.admit({
    templateId: 'http_payload_probe',
    params: { payload_id: 'xss-1' },
    approvalId,
  });
  assert.equal(rejectCode(decision), 'lease_generation_stale');
});

test('凭证与动作类别不符时被拒绝', async () => {
  const h = makeHarness();
  const { approvalId } = await admitApproved(h);
  h.store.approvals.set(approvalId, { ...requireRecord(h, approvalId), actionClass: 'lateral_movement' });
  const decision = await h.admit({
    templateId: 'http_payload_probe',
    params: { payload_id: 'xss-1' },
    approvalId,
  });
  assert.equal(rejectCode(decision), 'approval_required');
});

test('凭证指向不存在的记录时被拒绝', async () => {
  const h = makeHarness();
  const decision = await h.admit({
    templateId: 'http_payload_probe',
    params: { payload_id: 'xss-1' },
    approvalId: 'appr-does-not-exist',
  });
  assert.equal(rejectCode(decision), 'approval_required');
});

// ───────────────────────────── 一次消费 ─────────────────────────────

test('放行凭证二次消费失败', async () => {
  const h = makeHarness();
  const { approvalId } = await admitApproved(h);
  assert.equal(await h.service.consumeApproval(approvalId, 'run-1'), true);
  assert.equal(await h.service.consumeApproval(approvalId, 'run-2'), false);
  assert.equal(await h.service.consumeApproval('appr-missing', 'run-3'), false);
});

// ───────────────────────────── 执行与执行前重裁决 ─────────────────────────────

test('执行成功：沙箱收到计划与一次性执行令牌，结果回写', async () => {
  const h = makeHarness();
  const decision = await h.admit();
  if (decision.kind !== 'admitted') throw new Error('unreachable');
  const result = await h.service.execute(decision.plan, new AbortController().signal);
  assert.equal(result.status, 'completed');
  assert.equal(result.stdout, 'HTTP/1.1 200 OK');
  assert.equal(h.sandbox.calls.length, 1);
  assert.equal(h.sandbox.calls[0]?.plan.idempotencyKey, decision.plan.idempotencyKey);
  assert.equal(h.store.finished.get(decision.plan.idempotencyKey)?.result.status, 'completed');
});

test('幂等重放：同一动作第二次执行命中已有结果，不重复执行', async () => {
  const h = makeHarness();
  const decision = await h.admit();
  if (decision.kind !== 'admitted') throw new Error('unreachable');
  const signal = new AbortController().signal;
  const first = await h.service.execute(decision.plan, signal);
  h.sandbox.result = { status: 'completed', exitCode: 1, stdout: '已经变了' };
  const second = await h.service.execute(decision.plan, signal);
  assert.equal(h.sandbox.calls.length, 1);
  assert.deepEqual(second, first);
});

test('幂等键命中但计划摘要不同时拒绝复用', async () => {
  const h = makeHarness();
  const decision = await h.admit();
  if (decision.kind !== 'admitted') throw new Error('unreachable');
  const signal = new AbortController().signal;
  await h.service.execute(decision.plan, signal);
  // 同一幂等键（会话/类别/目标/命令/凭证均未变）但范围版本已变：摘要不同，不得复用旧结果。
  const rebound = { ...decision.plan, scopeVersion: 2 };
  const result = await h.service.execute({ ...rebound, planHash: derivePlanHash(hashInput(rebound)) }, signal);
  assert.equal(result.status, 'blocked');
  assert.equal(result.error?.code, 'idempotent_replay');
  assert.equal(h.sandbox.calls.length, 1);
});

test('执行前重裁决：范围版本变化时拒绝执行', async () => {
  const h = makeHarness();
  const decision = await h.admit();
  if (decision.kind !== 'admitted') throw new Error('unreachable');
  h.sessions.binding = binding({ scopeVersion: 2 });
  const result = await h.service.execute(decision.plan, new AbortController().signal);
  assert.equal(result.status, 'blocked');
  assert.equal(result.error?.code, 'stale_state_version');
  assert.match(result.error?.message ?? '', /范围版本/);
  assert.equal(h.sandbox.calls.length, 0);
});

test('执行前重裁决：策略 epoch 前进时拒绝执行', async () => {
  const h = makeHarness();
  const decision = await h.admit();
  if (decision.kind !== 'admitted') throw new Error('unreachable');
  h.sessions.binding = binding({ policyEpoch: 2 });
  const result = await h.service.execute(decision.plan, new AbortController().signal);
  assert.equal(result.status, 'blocked');
  assert.equal(result.error?.code, 'stale_state_version');
  assert.match(result.error?.message ?? '', /策略 epoch/);
  assert.equal(h.sandbox.calls.length, 0);
});

test('执行前重裁决：计划被改动时拒绝执行', async () => {
  const h = makeHarness();
  const decision = await h.admit();
  if (decision.kind !== 'admitted') throw new Error('unreachable');
  const result = await h.service.execute(
    { ...decision.plan, normalizedCommand: `${decision.plan.normalizedCommand} extra=1` },
    new AbortController().signal,
  );
  assert.equal(result.error?.code, 'stale_state_version');
  assert.equal(h.sandbox.calls.length, 0);
});

test('执行前重裁决：租约世代滞后时拒绝执行', async () => {
  const h = makeHarness();
  const decision = await h.admit();
  if (decision.kind !== 'admitted') throw new Error('unreachable');
  h.sessions.binding = binding({ lease: lease({ generation: 4 }) });
  const result = await h.service.execute(decision.plan, new AbortController().signal);
  assert.equal(result.error?.code, 'lease_generation_stale');
});

test('执行前重裁决：租约过期或会话被取代时拒绝执行', async () => {
  const h = makeHarness();
  const decision = await h.admit();
  if (decision.kind !== 'admitted') throw new Error('unreachable');
  h.advance(3_600_000);
  const expired = await h.service.execute(decision.plan, new AbortController().signal);
  assert.equal(expired.error?.code, 'lease_expired');

  h.sessions.binding = binding({ status: 'superseded' });
  const closed = await h.service.execute(decision.plan, new AbortController().signal);
  assert.equal(closed.error?.code, 'lease_revoked');
  assert.equal(h.sandbox.calls.length, 0);
});
test('执行前重裁决：engagement 暂停或终止后拒绝旧计划', async () => {
  for (const marker of ['paused', 'aborted'] as const) {
    const h = makeHarness();
    const decision = await h.admit();
    if (decision.kind !== 'admitted') throw new Error('unreachable');
    h.sessions.binding = binding({ engagementStatus: marker });
    const result = await h.service.execute(decision.plan, new AbortController().signal);
    assert.equal(result.status, 'blocked');
    assert.equal(result.error?.code, 'engagement_halted');
    assert.equal(h.sandbox.calls.length, 0);
  }
});

test('执行前重裁决：策略否决时透传稳定错误码', async () => {
  const h = makeHarness();
  const decision = await h.admit();
  if (decision.kind !== 'admitted') throw new Error('unreachable');
  h.policy.validate = async () => ({
    ok: false,
    error: {
      status: 'blocked',
      code: 'scope_violation',
      message: '目标已被移出范围',
      next_action: '重新申请放行',
    },
  });
  const result = await h.service.execute(decision.plan, new AbortController().signal);
  assert.equal(result.error?.code, 'scope_violation');
  assert.equal(h.sandbox.calls.length, 0);
});

test('执行前重裁决：模板已下线时拒绝执行', async () => {
  const h = makeHarness();
  const decision = await h.admit();
  if (decision.kind !== 'admitted') throw new Error('unreachable');
  const result = await h.service.execute(
    { ...decision.plan, templateId: 'retired_template' },
    new AbortController().signal,
  );
  assert.equal(result.error?.code, 'classification_rejected');
});

test('沙箱不可用时返回 sandbox_unavailable，不伪装成功', async () => {
  const h = makeHarness();
  const decision = await h.admit();
  if (decision.kind !== 'admitted') throw new Error('unreachable');
  h.sandbox.mode = 'throw';
  const result = await h.service.execute(decision.plan, new AbortController().signal);
  assert.equal(result.status, 'blocked');
  assert.equal(result.error?.code, 'sandbox_unavailable');
});

test('凭证已消费时执行被拒绝', async () => {
  const h = makeHarness();
  const { plan, approvalId } = await admitApproved(h);
  assert.equal(await h.service.consumeApproval(approvalId, 'run-x'), true);
  const result = await h.service.execute(plan, new AbortController().signal);
  assert.equal(result.status, 'blocked');
  assert.equal(result.error?.code, 'approval_consumed');
  assert.equal(h.sandbox.calls.length, 0);
});

test('已放行计划执行时消费凭证', async () => {
  const h = makeHarness();
  const { plan, approvalId } = await admitApproved(h);
  const result = await h.service.execute(plan, new AbortController().signal);
  assert.equal(result.status, 'completed');
  assert.notEqual(requireRecord(h, approvalId).consumedAt, null);
});

test('调用方信号已中止时不进入执行', async () => {
  const h = makeHarness();
  const decision = await h.admit();
  if (decision.kind !== 'admitted') throw new Error('unreachable');
  const controller = new AbortController();
  controller.abort();
  const result = await h.service.execute(decision.plan, controller.signal);
  assert.equal(result.status, 'cancelled');
  assert.equal(h.sandbox.calls.length, 0);
});

// ───────────────────────────── 在途终止 ─────────────────────────────

test('策略 epoch 前进时终止该 engagement 的在途动作', async () => {
  const h = makeHarness();
  const decision = await h.admit();
  if (decision.kind !== 'admitted') throw new Error('unreachable');
  h.sandbox.mode = 'hang';
  const running = h.service.execute(decision.plan, new AbortController().signal);
  await h.waitForSandboxCall();

  assert.equal(await h.service.abortInFlight(ENGAGEMENT, 1), 0);
  assert.equal(await h.service.abortInFlight('eng-other', 9), 0);
  assert.equal(await h.service.abortInFlight(ENGAGEMENT, 2), 1);
  assert.equal((await running).status, 'cancelled');
  assert.equal(await h.service.abortInFlight(ENGAGEMENT, 3), 0);
});

test('在途动作按计划绑定的 engagement 隔离', async () => {
  const h = makeHarness();
  const decision = await h.admit();
  if (decision.kind !== 'admitted') throw new Error('unreachable');
  h.sessions.binding = binding({ engagementId: 'eng-2' });
  h.sandbox.mode = 'hang';
  const running = h.service.execute(decision.plan, new AbortController().signal);
  await h.waitForSandboxCall();

  assert.equal(await h.service.abortInFlight(ENGAGEMENT, 5), 0);
  assert.equal(await h.service.abortInFlight('eng-2', 5), 1);
  assert.equal((await running).status, 'cancelled');
});

test('在途动作结束后不再计入终止范围', async () => {
  const h = makeHarness();
  const decision = await h.admit();
  if (decision.kind !== 'admitted') throw new Error('unreachable');
  await h.service.execute(decision.plan, new AbortController().signal);
  assert.equal(await h.service.abortInFlight(ENGAGEMENT, 2), 0);
});

// ─────────────────── 直连命令模板（direct_command，唯一一张） ───────────────────

/**
 * 这是「放开命令权限」的**唯一**入口（出厂注册表里唯一打开 `allowFreeForm` 的模板）。
 * 它用三条约束换自由：类别是 `exploit_validation`（本部署强制逐次人工放行）、仍然只跑在
 * 加固过的沙箱里、文本/超时/输出都有上限。下面四条断言就是这三条的机器表示。
 */
test('直连命令模板：注册在册、可跑任意文本、但被逐次放行与其它约束圈住', () => {
  const spec = specOf('direct_command');
  // ① 类别必须落在「逐次人工放行」的集合里——这是它唯一的内容闸门之外的控制。
  assert.ok(
    (PER_ACTION_APPROVAL_CLASSES as readonly string[]).includes(spec.template.actionClass),
    '自由命令必须属于逐次放行类别，否则机器可以自己批准任意命令',
  );
  assert.deepEqual(spec.template.parameters.map((p) => p.name), ['port', 'command_b64']);
  assert.equal(spec.allowFreeForm, true, '黑名单对它不生效是**显式**开关，不是默认');

  // ② 任意文本可以通过（含 shell 元字符——其它模板会因此被拒）。
  const arbitrary = btoaish('curl -sS -X POST http://t:3002/ --data "a=1&b=2" | head -c 200');
  assert.equal(
    validateParams(spec.template, { port: 3002, command_b64: arbitrary }, { allowFreeForm: true }).ok,
    true,
  );
  // ③ 不开开关时，同一段文本会被黑名单挡住（说明豁免是按模板显式打开的，不是全局放宽）。
  assert.equal(
    validateParams(spec.template, { port: 3002, command_b64: arbitrary }, {}).ok,
    false,
    '不开 allowFreeForm 时黑名单照旧生效',
  );
  // ④ 端口仍然要合法整数（范围闸门按它记账）。
  assert.equal(validateParams(spec.template, { port: 70000, command_b64: arbitrary }, { allowFreeForm: true }).ok, false);
});

test('夹具模板一律不带 allowFreeForm（豁免不许扩散）', () => {
  for (const id of ['http_read', 'tcp_connect', 'udp_probe', 'icmp_ping', 'dns_lookup'] as const) {
    assert.notEqual(specOf(id).allowFreeForm, true, `${id} 不得打开自由形式豁免`);
  }
});

/** 与工具脚本同一套编码：命令走 base64（宿主侧命令是单个按空格切分的字符串）。 */
function btoaish(text: string): string {
  return Buffer.from(text, 'utf8').toString('base64');
}

test('高权限模式（approval_mode=auto）：预设内的动作由服务端自行放行；越界与人工档仍转人类', async () => {
  const h = makeHarness();
  const command = { templateId: 'direct_command', params: { port: 3002, command_b64: Buffer.from('id', 'utf8').toString('base64') } };
  const basePolicy = { perActionApprovalClasses: ['exploit_validation', 'lateral_movement'] as const };

  // ① 预设内（启用集合里有 exploit_validation）+ auto ⇒ 服务端自行放行，Agent 不必等。
  h.setPolicy({ ...basePolicy, approvalMode: 'auto', enabledActionClasses: ['passive_collection', 'active_probing', 'exploit_validation'] });
  const selfApproved = await h.admit(command);
  assert.equal(selfApproved.kind, 'self_approved', '预设内的动作在 auto 档不应停在等待人类');
  if (selfApproved.kind !== 'self_approved') return;
  assert.ok(selfApproved.approvalId.length > 0, '自放行也要留下凭证：审计与一次性消费都靠它');
  const recorded = h.store.requests.at(-1);
  assert.equal(recorded?.selfApproval?.decidedBy, 'server:auto-approval', '审计必须写明是服务端自行放行，而不是人类');

  // ② 命令类在 auto 档**即使不在预设启用集合里**也自行放行（本部署唯一的动手模板；
  //    严格要求「预设内」会让 stealth/standard 下每条命令都要人批，高权限等于失效）。
  h.setPolicy({ ...basePolicy, approvalMode: 'auto', enabledActionClasses: ['passive_collection'] });
  const commandBeyondPreset = await h.admit(command);
  assert.equal(commandBeyondPreset.kind, 'self_approved', '命令类在 auto 档自行放行');

  // ③ 人工审批档：同样的动作必须等人。
  h.setPolicy({ ...basePolicy, approvalMode: 'human', enabledActionClasses: ['exploit_validation'] });
  const human = await h.admit(command);
  assert.equal(human.kind, 'needs_approval', 'human 档下预设内的动作也逐条人批');

  // ④ 旧快照没有 approval_mode ⇒ 按 human（保守缺省）。
  h.setPolicy({ ...basePolicy, enabledActionClasses: ['exploit_validation'] });
  const legacy = await h.admit(command);
  assert.equal(legacy.kind, 'needs_approval', '缺键的旧策略绝不能被当成高权限');
});

test('高权限自放行下的幂等：同一条命令重发得到同一键与同一结果，不二次执行（事故 2026-10-05）', async () => {
  // 事故：自放行每次受理都新建一张 approved 凭证，而凭证进了幂等键——同一条命令重发
  // 得到新键，唯一约束与重放同时失效，模型超时重发 = 目标被同一条命令打两次。
  const h = makeHarness();
  const command = {
    templateId: 'direct_command',
    params: { port: 3002, command_b64: Buffer.from('id', 'utf8').toString('base64') },
  };
  h.setPolicy({ perActionApprovalClasses: ['exploit_validation'], approvalMode: 'auto' });

  const first = await h.admit(command);
  const resent = await h.admit(command);
  assert.equal(first.kind, 'self_approved');
  assert.equal(resent.kind, 'self_approved');
  if (first.kind !== 'self_approved' || resent.kind !== 'self_approved') return;
  assert.notEqual(first.approvalId, resent.approvalId, '每次受理仍各留一张凭证（审计），但不参与幂等身份');
  assert.equal(first.plan.idempotencyKey, resent.plan.idempotencyKey, '自铸凭证不得进入幂等键，否则重发=二次执行');
  assert.equal(
    first.plan.idempotencyKey,
    deriveIdempotencyKey({
      workerSessionId: SESSION,
      actionClass: 'exploit_validation',
      normalizedTarget: first.plan.normalizedTarget,
      normalizedCommand: first.plan.normalizedCommand,
      approvalId: '',
    }),
  );
  assert.equal(first.plan.planHash, resent.plan.planHash);

  const signal = new AbortController().signal;
  const done = await h.service.execute(first.plan, signal);
  const replay = await h.service.execute(resent.plan, signal);
  assert.equal(h.sandbox.calls.length, 1, '同一条命令只允许真正执行一次');
  assert.deepEqual(replay, done);
});

test('沙箱启动前必写第二条 execution.policy.checked（带 toolRunId）；写不进去绝不启动沙箱（事故 2026-10-05）', async () => {
  const events: Array<{ eventType: string; payload: Record<string, unknown> }> = [];
  const h = makeHarness(undefined, undefined, {
    record: async (input) => {
      events.push(input);
    },
  });
  const decision = await h.admit();
  if (decision.kind !== 'admitted') throw new Error('unreachable');
  const result = await h.service.execute(decision.plan, new AbortController().signal);
  assert.equal(result.status, 'completed');
  assert.equal(h.sandbox.calls.length, 1);
  const pre = events.filter(
    (event) => event.eventType === 'execution.policy.checked' && event.payload['rule'] === 'pre_sandbox_recheck',
  );
  assert.equal(pre.length, 1, '受理一次 + 沙箱启动前一次：两次审计必须都落下（设计 §8.2）');
  assert.equal(pre[0]?.payload['toolRunId'], 'run-1', '审计必须能对齐到同一次运行');
  assert.equal(pre[0]?.payload['planHash'], decision.plan.planHash);
  assert.equal(pre[0]?.payload['decision'], 'admitted');

  // 失败路径：这条审计写不进去 ⇒ 不启动沙箱，且运行结算为 blocked（不得停在 running）。
  const failing = makeHarness(undefined, undefined, {
    record: async (input) => {
      if (input.eventType === 'execution.policy.checked' && input.payload['rule'] === 'pre_sandbox_recheck') {
        throw new Error('账本不可写');
      }
    },
  });
  const second = await failing.admit();
  if (second.kind !== 'admitted') throw new Error('unreachable');
  const blockedResult = await failing.service.execute(second.plan, new AbortController().signal);
  assert.equal(blockedResult.status, 'blocked');
  assert.equal(blockedResult.error?.code, 'audit_unavailable');
  assert.equal(failing.sandbox.calls.length, 0, '审计不可用时不得触及目标（§15.1）');
  assert.equal(failing.store.finished.get(second.plan.idempotencyKey)?.result.status, 'blocked');
});

// ─────────────── 等待窗口（GAP-3）与结算回写（GAP-5）的回归锁 ───────────────

test('等待窗口后复核：commitRun 之后租约被吊销，绝不启动沙箱（GAP-3 回归锁）', async () => {
  const h = makeHarness(undefined, undefined, undefined, {
    afterCommit: () => {
      // 模拟「等待窗口内租约被吊销」：commit 已成功、沙箱尚未启动。
      h.sessions.binding = binding({
        lease: lease({ revokedAt: h.now(), revokedReason: 'human_revoke' }),
      });
    },
  });
  const decision = await h.admit();
  if (decision.kind !== 'admitted') throw new Error('unreachable');
  const result = await h.service.execute(decision.plan, new AbortController().signal);
  assert.equal(result.status, 'blocked');
  assert.equal(result.error?.code, 'lease_revoked', '第二次复核必须看到被吊销的租约');
  assert.equal(h.sandbox.calls.length, 0, '租约已失效就不得接触目标');
  assert.equal(
    h.store.finished.get(decision.plan.idempotencyKey)?.result.status,
    'blocked',
    '运行必须结算为 blocked，而不是停在 running',
  );
});

test('等待窗口后复核：作业在窗口内被暂停，同样不启动沙箱（GAP-3 回归锁）', async () => {
  const h = makeHarness(undefined, undefined, undefined, {
    afterCommit: () => {
      h.sessions.binding = binding({ engagementStatus: 'paused' });
    },
  });
  const decision = await h.admit();
  if (decision.kind !== 'admitted') throw new Error('unreachable');
  const result = await h.service.execute(decision.plan, new AbortController().signal);
  assert.equal(result.status, 'blocked');
  assert.equal(result.error?.code, 'engagement_halted');
  assert.equal(h.sandbox.calls.length, 0, '作业已暂停就不得接触目标');
});

test('结算回写瞬时失败：重试成功即照常返回沙箱结果（GAP-5 回归锁）', async () => {
  let failedOnce = false;
  const h = makeHarness(undefined, undefined, undefined, {
    failFinishRun: () => {
      const fail = !failedOnce;
      failedOnce = true;
      return fail;
    },
  });
  const decision = await h.admit();
  if (decision.kind !== 'admitted') throw new Error('unreachable');
  const result = await h.service.execute(decision.plan, new AbortController().signal);
  assert.equal(result.status, 'completed', '瞬时失败必须靠重试救回来');
  assert.equal(h.sandbox.calls.length, 1);
});

test('结算回写持续失败：有限重试后返回带运行 id 的结构化 blocked，而不是抛错（GAP-5 回归锁）', async () => {
  let attempts = 0;
  const h = makeHarness(undefined, undefined, undefined, {
    failFinishRun: () => {
      attempts += 1;
      return attempts <= 3;
    },
  });
  const decision = await h.admit();
  if (decision.kind !== 'admitted') throw new Error('unreachable');
  const result = await h.service.execute(decision.plan, new AbortController().signal);
  assert.equal(attempts, 3, '必须恰好重试三次');
  assert.equal(result.status, 'blocked');
  assert.match(result.error?.message ?? '', /已执行/, '必须说清动作已执行，避免被误当成「没跑」');
  assert.match(result.error?.message ?? '', /run-1/, '必须带上运行 id 供人工核查');
});
