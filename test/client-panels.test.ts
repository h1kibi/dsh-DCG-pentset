/**
 * 面板装配层的测试（`src/client/panels.ts`）。
 *
 * 装配层是「契约数据 → 九个面板节点」的接缝。它的两类危险：
 *
 *   1. **字段名翻译错**（契约叫 `memoryId`、视图叫 `chunkId`）——静默错位会让界面
 *      显示另一个条目的内容，而不是报错。
 *   2. **把「不知道」渲染成「没有」**——`null`（尚未读到）与 `[]`（确实没有）
 *      混同后，人类会把「读取失败」当成「Agent 没在请求放行」。
 *
 * 因此这里的断言针对这两点，而不是「渲染没抛异常」。
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { renderToStaticMarkup } from 'react-dom/server';

import type {
  ApprovalDetail,
  CandidateAsset,
  Finding,
  MemorySearchHit,
  ScopeDetail,
  SkillSummary,
  WorkerSessionSummary,
} from '../src/contracts.ts';
import { ConsoleController } from '../src/client/controller.ts';
import type { ConsoleSnapshot } from '../src/client/controller.ts';
import { buildPanels, toCandidateAssets, toMemoryHits } from '../src/client/panels.ts';
import type { BuildPanelsInput } from '../src/client/panels.ts';
import type { HostRpcResult } from '../src/console/rpc.ts';

const NOW = new Date('2026-09-19T12:00:00Z');

function emptySnapshot(): ConsoleSnapshot {
  return {
    engagements: [],
    selectedEngagementId: null,
    state: null,
    sessions: [],
    loading: false,
    lastError: null,
    conflict: false,
    loadedAt: null,
  };
}

function loadedSnapshot(): ConsoleSnapshot {
  return {
    ...emptySnapshot(),
    selectedEngagementId: 'e1',
    state: {
      engagementId: 'e1',
      mainStatus: 'waiting_human_review',
      runMarker: 'running',
      currentPhase: 'exploitation',
      stateVersion: 7,
      graphIteration: 1,
      activeWorkerSessionId: 's1', scopeVersion: 1, authorizationExpiresAt: null,
    },
    sessions: [] as readonly WorkerSessionSummary[],
  };
}

/** 一个只会抛错的 invoker：这些测试只走渲染路径，不该有任何 RPC 发生。 */
function inertController(): ConsoleController {
  return new ConsoleController({
    invoke: () => {
      throw new Error('装配与渲染不应发出 RPC');
    },
    clock: () => NOW,
  });
}

function finding(over: Partial<Finding> = {}): Finding {
  return {
    id: 'f1',
    engagementId: 'e1',
    title: 'HSTS 缺失',
    severity: 'low',
    status: 'candidate',
    affectedAssetIds: [],
    evidenceRefs: [],
    reproductionSteps: [],
    impact: null,
    remediation: null,
    confidence: null,
    acceptedBy: null,
    acceptedAt: null,
    ...over,
  };
}

function approvalDetail(over: Partial<ApprovalDetail> = {}): ApprovalDetail {
  return {
    id: 'a1',
    engagementId: 'e1',
    workerSessionId: 's1',
    actionClass: 'exploit_validation',
    decision: 'pending',
    normalizedTarget: 'app.example.com:443',
    normalizedCommand: 'nuclei -u https://app.example.com',
    purpose: '验证入口',
    timeoutMs: 30_000,
    maxOutputBytes: 262_144,
    scopeVersion: 3,
    policyEpoch: 4,
    targetSnapshot: {},
    riskSummary: '低风险',
    planHash: 'h1',
    leaseGeneration: null,
    decidedBy: null,
    decisionReason: null,
    expiresAt: '2026-09-19T12:30:00Z',
    consumedAt: null,
    createdAt: '2026-09-19T11:55:00Z',
    canResolve: true,
    commandPlan: {
      template_id: 'http_payload_probe',
      params: { payload_id: 'xss-1' },
      target_selector: 'app.example.com',
    },
    ...over,
  } as ApprovalDetail;
}

function scopeDetail(): ScopeDetail {
  return {
    current: {
      version: 3,
      iteration: 1,
      targets: [],
      exclusions: [],
      authorizationRef: 'SOW-1',
      amendmentReason: null,
      changedBy: 'op-1',
      contentHash: 'c1',
      createdAt: '2026-09-19T10:00:00Z',
    },
    history: [],
  };
}

function skill(over: Partial<SkillSummary> = {}): SkillSummary {
  return {
    id: 'sk1',
    name: 'hsts-check',
    description: '检查 HSTS',
    body: '步骤一……',
    revision: 2,
    disabled: false,
    contentHash: 'c2',
    addedBy: 'op-1',
    createdAt: '2026-09-19T09:00:00Z',
    updatedAt: '2026-09-19T09:30:00Z',
    ...over,
  };
}

// ───────────────────────── 字段名翻译 ─────────────────────────

test('toMemoryHits：契约的 memoryId 映射到视图的 chunkId，引用与时间原样传递', () => {
  const hits: readonly MemorySearchHit[] = [
    {
      memoryId: 'chunk-42',
      excerpt: '……',
      score: 0.75,
      kind: 'fact',
      trustLevel: 'tool_observation',
      phase: 'intelligence-gathering',
      workerSessionId: 's1',
      occurredAt: '2026-09-19T11:00:00Z',
      citation: 'memory:chunk-42',
      reasoningNote: '模型推理，不等同于事实',
    },
  ];

  const [view] = toMemoryHits(hits);
  assert.ok(view !== undefined, '应映射出一条命中');

  assert.equal(view.chunkId, 'chunk-42', 'chunkId 必须来自 memoryId——错位会显示另一条记忆的内容');
  assert.equal(view.citation, 'memory:chunk-42', '引用原样传递，它同时是 readMemory 的入参');
  assert.equal(view.reasoningLabel, '模型推理，不等同于事实', '思考链标注走独立字段');
  assert.equal(view.score, 0.75);
  assert.equal(view.occurredAt, '2026-09-19T11:00:00Z');
});

test('toMemoryHits：未识别的分块类型原样传递，不伪装成已知类型', () => {
  // 服务端可能先于客户端新增类型。把它断言成已知类型会让视图显示一个**错的**标签。
  const hits = [{
    memoryId: 'chunk-1',
    excerpt: 'x',
    score: 0.1,
    kind: 'quantum_observation',
    trustLevel: 'tool_observation',
    phase: null,
    workerSessionId: null,
    occurredAt: '2026-09-19T11:00:00Z',
    citation: 'memory:chunk-1',
  }] as readonly MemorySearchHit[];

  const [unknown] = toMemoryHits(hits);
  assert.ok(unknown !== undefined);
  assert.equal(unknown.kind, 'quantum_observation');
});

test('toMemoryHits：没有思考链标注时为 null，而不是缺键', () => {
  const hits = [{
    memoryId: 'chunk-1',
    excerpt: 'x',
    score: 0.1,
    kind: 'fact',
    trustLevel: 'tool_observation',
    phase: null,
    workerSessionId: null,
    occurredAt: '2026-09-19T11:00:00Z',
    citation: 'memory:chunk-1',
  }] as readonly MemorySearchHit[];

  const [plain] = toMemoryHits(hits);
  assert.ok(plain !== undefined);
  assert.equal(plain.reasoningLabel, null);
});

test('toCandidateAssets：拆开契约的发现来源两列，并说出「来源未记录」', () => {
  const base: CandidateAsset = {
    id: 'asset-1',
    canonicalTarget: 'domain:new.example.com',
    kind: 'domain',
    labels: ['internal'],
    firstSeenIteration: 2,
    discoveredFromSessionId: null,
    discoveredFromAssetId: null,
    evidenceRefs: [],
    currentDecision: null,
  };

  const [fromAsset] = toCandidateAssets([{ ...base, discoveredFromAssetId: 'asset-9' }]);
  assert.ok(fromAsset !== undefined);
  assert.equal(fromAsset.assetId, 'asset-1', '视图的 assetId 来自契约的 id');
  assert.ok(fromAsset.discoveredFrom.includes('asset-9'), '来源要能读出是谁发现的');

  const [fromSession] = toCandidateAssets([{ ...base, discoveredFromSessionId: 's7' }]);
  assert.ok(fromSession !== undefined);
  assert.ok(fromSession.discoveredFrom.includes('s7'));
  assert.equal(fromSession.discoveredInSessionId, 's7');

  // 两个来源列都为空时也必须给出说明：空字符串会让人以为界面坏了
  const [orphan] = toCandidateAssets([base]);
  assert.ok(orphan !== undefined);
  assert.notEqual(orphan.discoveredFrom.trim(), '', '来源未知也要有一句话');
});


/**
 * `buildPanels` 的入参夹具。
 *
 * 把**结构性缺省**（未读到的面板数据、回调、草稿）集中一处：`BuildPanelsInput`
 * 每加一个必需字段，只有这里要改——否则四个调用点各改一遍，必然漏一个。
 *
 * 缺省刻意是「全部未读到」（`null`），因为那是最安全的状态：面板不渲染总好过
 * 用假数据显示出一个错误结论。
 */
function panelInput(over: Partial<BuildPanelsInput> = {}): BuildPanelsInput {
  return {
    controller: inertController(),
    snapshot: loadedSnapshot(),
    now: NOW,
    findings: null,
    approvals: null,
    scope: null,
    candidateAssets: null,
    skills: null,
    handoffDraft: null,
    onHandoffDraft: () => {},
    scopeAmendment: { completed: false, newVersion: null },
    dispositions: {},
    onDispose: () => {},
    onAddSkill: () => {},
    onUpdateSkill: () => {},
    onRemoveSkill: () => {},
    reportDraft: null,
    undisposedCount: null,
    memoryHits: null,
    memoryWatermark: null,
    publicMemory: null,
    onSavePublicMemory: () => undefined,
    memorySearched: false,
    memoryInitialForm: null,
    memoryDetails: {},
    onMemorySearch: () => {},
    onMemoryExpand: () => {},
    ...over,
  };
}

// ───────────────────────── 三态区分 ─────────────────────────

test('buildPanels：尚未读取（null）时不渲染该面板，交由外壳说明', () => {
  const panels = buildPanels(panelInput({
  findings: null,
  approvals: null,
  scope: null,
  candidateAssets: null,
  skills: null,
  memoryHits: null,
  memoryWatermark: null,
  memorySearched: false,
  memoryInitialForm: null,
  memoryDetails: {},
  onMemorySearch: () => {},
  onMemoryExpand: () => {},
}));

  // 键不存在 → 外壳渲染「该面板尚未接入」，而不是一个看起来「没有数据」的空列表
  assert.equal(panels.report, undefined);
  assert.equal(panels.approvals, undefined);
  assert.equal(panels.scope, undefined);
  assert.equal(panels.skills, undefined);
  // 记忆面板例外：它自带表单，没数据时仍要能让人**发起**检索
  assert.notEqual(panels.memory, undefined);
});

test('buildPanels：确切读到空集合时渲染该面板（「确实没有」与「读不到」不同）', () => {
  const panels = buildPanels(panelInput({
  findings: [],
  approvals: [],
  scope: scopeDetail(),
  candidateAssets: [],
  skills: [],
  memoryHits: [],
  memoryWatermark: null,
  memorySearched: true,
  memoryInitialForm: null,
  memoryDetails: {},
  onMemorySearch: () => {},
  onMemoryExpand: () => {},
}));

  assert.notEqual(panels.report, undefined);
  assert.notEqual(panels.approvals, undefined);
  assert.notEqual(panels.scope, undefined);
  assert.notEqual(panels.skills, undefined);
});

// ───────────────────────── 端到端渲染 ─────────────────────────

test('buildPanels：数据确实抵达面板（结论、放行命令、skill 名与范围版本都渲染出来）', () => {
  const panels = buildPanels(panelInput({
  findings: [finding({ title: 'HSTS 缺失' })],
  approvals: [approvalDetail()],
  scope: scopeDetail(),
  candidateAssets: [],
  skills: [skill()],
  memoryHits: null,
  memoryWatermark: null,
  memorySearched: false,
  memoryInitialForm: null,
  memoryDetails: {},
  onMemorySearch: () => {},
  onMemoryExpand: () => {},
}));

  const report = renderToStaticMarkup(panels.report as never);
  assert.ok(report.includes('HSTS 缺失'), '结论标题必须抵达报告面板');

  const approvals = renderToStaticMarkup(panels.approvals as never);
  assert.ok(
    approvals.includes('nuclei -u https://app.example.com'),
    '完整命令必须抵达放行面板——人类批准的就是它（§10.3.1）',
  );

  const skills = renderToStaticMarkup(panels.skills as never);
  assert.ok(skills.includes('hsts-check'), 'skill 名必须抵达技能面板');

  const scope = renderToStaticMarkup(panels.scope as never);
  assert.ok(scope.includes('3'), '当前范围版本号必须抵达范围面板');
});

test('buildPanels：范围规划的入参是「当前范围 + 本轮裁决」，且不做规范化', () => {
  // 这是装配层承担的唯一一条规则：新范围 = 当前范围 + 本轮纳入/排除的候选。
  // 规范化（协议、端口、是否允许）全部交给服务端（§10.2.2），客户端不复制。
  const controller = inertController();
  const scope = scopeDetail();

  const withTargets: ScopeDetail = {
    ...scope,
    current: {
      ...scope.current!,
      targets: [{ kind: 'domain', value: 'lab.example.com', protocols: ['tcp'], ports: [] }],
      exclusions: [],
    },
  };

  const panels = buildPanels(panelInput({
  controller,
  findings: null,
  approvals: null,
  scope: withTargets,
  candidateAssets: null,
  skills: null,
  memoryHits: null,
  memoryWatermark: null,
  memorySearched: false,
  memoryInitialForm: null,
  memoryDetails: {},
  onMemorySearch: () => {},
  onMemoryExpand: () => {},
}));

  // 从渲染出的节点里取出回调：面板把 `planAmendment` 存在 props 上。
  const element = panels.scope as { props: { planAmendment: (d: readonly unknown[]) => unknown } };
  assert.equal(typeof element.props.planAmendment, 'function');

  const plan = element.props.planAmendment([
    { assetId: 'domain:new.example.com', decision: 'included' },
    { assetId: '10.20.3.0/24', decision: 'excluded' },
  ]) as { targets: readonly unknown[]; exclusions: readonly unknown[] };

  assert.equal(plan.targets.length, 2, '当前目标 + 本轮纳入');
  assert.equal(plan.exclusions.length, 1, '当前排除 + 本轮排除');
  // 拆不出来的稳定键保留整串并交给服务端裁决，而不是丢掉这条候选
  assert.deepEqual(
    plan.exclusions[0],
    { kind: 'asset-label', value: '10.20.3.0/24', protocols: [], ports: [] },
  );
  // 协议与端口留空：这是人类的意图，客户端不猜
  assert.deepEqual(plan.targets[1], {
    kind: 'domain',
    value: 'new.example.com',
    protocols: [],
    ports: [],
  });
});

// ───────────────────────── 装配层不吞掉读失败 ─────────────────────────

test('装配层不吞错误：读失败由控制器记入快照，面板不伪造空数据', async () => {
  // 先让选中操作成功，再翻转为失败——这样 `lastError` 一定来自本次读，
  // 而不是 `select` 顺带写下的。
  let failing = false;
  const invoke = async (): Promise<HostRpcResult> =>
    failing
      ? { ok: false, error: { code: 'db/unavailable', message: '数据库不可用', details: {} } }
      : { ok: true, value: {} };
  const controller = new ConsoleController({ invoke, clock: () => NOW });
  await controller.select('e1');
  assert.equal(controller.getSnapshot().lastError, null, '选中成功时不该有错误');
  failing = true;

  const value = await controller.refreshApprovals();

  assert.equal(value, null, '读失败必须返回 null——不是空数组（空数组的语义是「确实没有待放行」）');
  assert.equal(controller.getSnapshot().lastError?.code, 'db/unavailable', '失败原因要进快照，供外壳显示');
});

test('装配层读方法：没有选中 engagement 时不发请求', async () => {
  let calls = 0;
  const controller = new ConsoleController({
    invoke: async () => {
      calls += 1;
      return { ok: true, value: [] } satisfies HostRpcResult;
    },
    clock: () => NOW,
  });

  // 按 engagement 取值的读方法：未选中时**不发请求**，并如实返回 null
  // （null 表示「未读到」，与「确实没有」的空数组不同——见该模块的三态说明）。
  assert.equal(await controller.refreshFindings(), null);
  assert.equal(await controller.refreshApprovals(), null);
  assert.equal(await controller.refreshCandidateAssets(), null);
  assert.equal(await controller.refreshScope(), null);
  assert.equal(await controller.readMemoryWatermark(), null);
  assert.equal(calls, 0, '未选中 engagement 时不该发 RPC');

  // `refreshSkills` **不在此列**：skill 是全局库（§16.2 不绑定 engagement），
  // 端点的唯一参数是 `enabledOnly`。它曾跟着一起「未选中就不发请求」，
  // 后果是 Skill 库面板在没有选中 engagement 时永远为空——而那正是它该能用的场景。
  const skills = await controller.refreshSkills();
  assert.deepEqual(skills, [], '未选中 engagement 也应能读到全局 skill 库');
  assert.equal(calls, 1, 'refreshSkills 必须真的发出请求');
});

// ─────────────── 写回调必须真的接进面板（否则按钮静默禁用） ───────────────

test('skill 库拿到三个写回调：增/改/删不再是「未接线」', () => {
  // 端点（`addSkill`/`updateSkill`/`removeSkill`）一直在方法表里，但客户端曾**既无封装
  // 也无接线**——面板因此把三个按钮全部禁用，而界面只显示「未接线」。
  // 这类缺口的表现是「功能静默消失」，没有编译错误、没有测试失败。
  //
  // 断言方式：给 buildPanels 明显的桩回调，然后到渲染出的节点上把它们取回来比对
  // ——等于验证「装配层确实把回调透传下去了」，而不是验证它「调用了什么」。
  const added: string[] = [];
  const panels = buildPanels(panelInput({
    skills: [{
      id: 's1', name: 'n', description: 'd', body: 'b', contentHash: 'h',
      addedBy: 'op', revision: 1, disabled: false,
      createdAt: '2026-09-19T00:00:00Z', updatedAt: '2026-09-19T00:00:00Z',
    }],
    onAddSkill: () => { added.push('add'); },
    onUpdateSkill: () => { added.push('update'); },
    onRemoveSkill: () => { added.push('remove'); },
  }));
  const element = panels.skills as { props: Record<string, unknown> } | undefined;
  assert.ok(element !== undefined, 'skill 面板应已渲染');
  for (const key of ['onAddSkill', 'onUpdateSkill', 'onRemoveSkill']) {
    assert.equal(typeof element.props[key], 'function', `${key} 必须透传到面板`);
  }
  // 三个回调各自独立：接错（例如都指向同一个）会让某个动作做错事。
  const html = renderToStaticMarkup(element as never);
  assert.ok(!html.includes('未接线'), '接线后不该再出现「未接线」的提示');
});

test('报告审阅拿到处置回调与处置表：结论处置不再是「从未处置」', () => {
  // §8.9 的三选一是报告的核心人类动作。`onDispose` 没接时三个按钮全禁用，
  // 而四节分节因为拿不到处置记录会把所有结论都算成「未处置」。
  const panels = buildPanels(panelInput({
    findings: [finding({ id: 'f1' })],
    dispositions: { f1: 'accept' },
    onDispose: () => {},
  }));
  const element = panels.report as { props: { children?: unknown } } | undefined;
  assert.ok(element !== undefined, '报告面板应已渲染');
  const html = renderToStaticMarkup(element as never);
  assert.ok(html.includes('已验证结论'), '已接受（accept）的结论应落入「已验证结论」一节');
});
