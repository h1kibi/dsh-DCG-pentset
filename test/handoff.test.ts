/**
 * 交接必需键校验测试（设计文档 §7.2、§7.3）。
 *
 * 重点证明三件事：
 *   - 必需键**从上下文解析**，不是交接结构里的独立字段（逐条来源都要被覆盖）；
 *   - 校验是纯函数：不派发、不改状态、不调用模型，因此输入可以冻结；
 *   - 非法转移类型（如 `interject_wake`）与"必需键缺失"是两个不同的失败。
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { seedHandoffContent } from '../src/workflow/handoff-flow.ts';

import type { HandoffPackage, Phase, RequiredHandoffKey } from '../src/contracts.ts';
import { HANDOFF_AUTO_CONTEXT_REFS, HANDOFF_TRANSITION_TYPES, REQUIRED_HANDOFF_KEYS } from '../src/contracts.ts';
import type {
  BoundScopeVersion,
  HandoffResolutionContext,
  ResolvedContextChunk,
} from '../src/workflow/handoff.ts';
import {
  assertHandoffTransitionType,
  capContextRefs,
  HANDOFF_MAX_CONTEXT_REFS,
  computeHandoffHash,
  computeDraftHash,
  isHandoffTransitionType,
  resolveHandoffKeys,
  validateHandoff,
  validateHandoffForConfirmation,
  HandoffProtocolError,
} from '../src/workflow/handoff.ts';

// ───────────────────────────── 夹具 ─────────────────────────────

function makePackage(overrides: Partial<HandoffPackage> = {}): HandoffPackage {
  return {
    handoffId: 'handoff-1',
    transitionType: 'advance',
    forced: false,
    approvedToPhase: 'vulnerability-analysis',
    approvedPrompt: '对已确认的 Web 入口做漏洞分析',
    objective: '确认 Web 入口的可利用性',
    excludedRefs: [],
    approvedContextRefs: ['memory:asset-1', 'memory:finding-1'],
    approvedSkillIds: ['web-vuln'],
    approvedToolFilter: { allow: ['memory_search', 'memory_read'] },
    approvedApprovalRequired: ['exploit_validation'],
    truncatedRefs: [],
    humanDecisionRef: 'decision-1',
    contentHash: 'pending',
    ...overrides,
  };
}

const ASSET_CHUNK: ResolvedContextChunk = {
  memoryId: 'memory:asset-1',
  kind: 'asset',
  assetIds: ['asset-a', 'asset-b'],
};
const FINDING_CHUNK: ResolvedContextChunk = {
  memoryId: 'memory:finding-1',
  kind: 'finding',
  findingIds: ['finding-x'],
};

function makeContext(chunks: readonly ResolvedContextChunk[] = [ASSET_CHUNK, FINDING_CHUNK]) {
  return { resolvedChunks: chunks } satisfies HandoffResolutionContext;
}

function makeScope(included: readonly string[] = ['asset-c']): BoundScopeVersion {
  return { version: 7, includedAssetIds: new Set(included) };
}

/** 递归冻结：任何写入尝试在严格模式下直接抛错，用于证明校验的纯粹性。 */
function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== 'object') return value;
  Object.freeze(value);
  for (const nested of Object.values(value as Record<string, unknown>)) deepFreeze(nested);
  return value;
}

// ───────────────────────────── 必需键的解析来源 ─────────────────────────────

test('五个必需键各按 §7.2 的来源表解析', () => {
  const resolved = resolveHandoffKeys(makePackage(), makeScope(), makeContext());
  assert.deepEqual(resolved, {
    // approved_context_refs 中资产分块的 asset_ids ⊕ 绑定范围版本的纳入集合
    asset_refs: ['asset-a', 'asset-b', 'asset-c'],
    // 新会话绑定的范围版本
    scope_version: ['7'],
    // approved_context_refs 中结论分块的 finding_ids
    finding_refs: ['finding-x'],
    // 交接包的 approved_approval_required
    approval_scope: ['exploit_validation'],
    // approved_skill_ids
    skill_ids: ['web-vuln'],
  });
});

test('asset_refs 并入范围版本的纳入集合并去重', () => {
  const chunks: readonly ResolvedContextChunk[] = [
    { memoryId: 'memory:asset-1', kind: 'asset', assetIds: ['asset-a', 'asset-b'] },
  ];
  const resolved = resolveHandoffKeys(
    makePackage({ approvedContextRefs: ['memory:asset-1', 'memory:asset-1'] }),
    makeScope(['asset-b', 'asset-c']),
    makeContext(chunks),
  );
  assert.deepEqual(resolved.asset_refs, ['asset-a', 'asset-b', 'asset-c']);
});

test('asset_refs 只取指向资产的分块，忽略其它 kind', () => {
  const chunks: readonly ResolvedContextChunk[] = [
    { memoryId: 'memory:e1', kind: 'evidence', assetIds: ['asset-should-not-leak'] },
    { memoryId: 'memory:m1', kind: null, assetIds: ['asset-unknown-kind'] },
    { memoryId: 'memory:f1', kind: 'finding', assetIds: ['asset-from-finding'], findingIds: ['f1'] },
  ];
  const resolved = resolveHandoffKeys(
    makePackage({ approvedContextRefs: ['memory:e1', 'memory:m1', 'memory:f1'] }),
    makeScope([]),
    makeContext(chunks),
  );
  assert.deepEqual(resolved.asset_refs, [], '证据分块与未知 kind 都不贡献资产引用');
  assert.deepEqual(resolved.finding_refs, ['f1'], '结论分块仍贡献结论引用');
});

test('asset_refs 忽略未被解析出的引用，并过滤空串', () => {
  const chunks: readonly ResolvedContextChunk[] = [
    { memoryId: 'memory:asset-1', kind: 'asset', assetIds: ['', 'asset-a'] },
  ];
  const resolved = resolveHandoffKeys(
    makePackage({ approvedContextRefs: ['memory:asset-1', 'memory:missing'] }),
    makeScope([]),
    makeContext(chunks),
  );
  assert.deepEqual(resolved.asset_refs, ['asset-a']);
});

test('finding_refs 只取指向结论的分块', () => {
  const chunks: readonly ResolvedContextChunk[] = [
    { memoryId: 'memory:asset-1', kind: 'asset', findingIds: ['finding-should-not-leak'] },
    { memoryId: 'memory:finding-1', kind: 'finding', findingIds: ['finding-x', 'finding-y'] },
  ];
  const resolved = resolveHandoffKeys(makePackage(), makeScope(), makeContext(chunks));
  assert.deepEqual(resolved.finding_refs, ['finding-x', 'finding-y']);
});

test('scope_version 取自新会话绑定的版本，省略解析上下文照样可解析', () => {
  const resolved = resolveHandoffKeys(makePackage(), makeScope(), {});
  assert.deepEqual(resolved.scope_version, ['7']);

  const validation = validateHandoff(makePackage(), ['scope_version'], makeScope());
  assert.deepEqual(validation, { ok: true }, 'context 只承担 asset_refs / finding_refs 的解析');
});

test('scope_version 未被绑定或版本号非法时解析为空', () => {
  const unbound = validateHandoff(makePackage(), ['scope_version'], null);
  assert.deepEqual(unbound, { ok: false, missing: ['scope_version'] });

  const zero = validateHandoff(makePackage(), ['scope_version'], { version: 0 });
  assert.deepEqual(zero, { ok: false, missing: ['scope_version'] });
});

test('approval_scope 与 skill_ids 各自取自交接包的已确认字段', () => {
  const resolved = resolveHandoffKeys(
    makePackage({
      approvedApprovalRequired: ['exploit_validation', 'lateral_movement', 'exploit_validation'],
      approvedSkillIds: ['web-vuln', 'exploit-safety'],
    }),
    makeScope(),
    makeContext(),
  );
  assert.deepEqual(resolved.approval_scope, ['exploit_validation', 'lateral_movement']);
  assert.deepEqual(resolved.skill_ids, ['web-vuln', 'exploit-safety']);
});

test('人类清空 skill 勾选会让 skill_ids 解析为空', () => {
  const validation = validateHandoff(
    makePackage({ approvedSkillIds: [] }),
    ['skill_ids'],
    makeScope(),
    makeContext(),
  );
  assert.deepEqual(validation, { ok: false, missing: ['skill_ids'] });
});

// ───────────────────────────── 缺键 → 阻止确认 ─────────────────────────────

test('必需键解析为空即失败，缺失项按契约规范序排列', () => {
  const validation = validateHandoff(
    makePackage({ approvedApprovalRequired: [], approvedContextRefs: [] }),
    ['skill_ids', 'approval_scope', 'asset_refs'],
    makeScope([]),
    makeContext([]),
  );
  assert.deepEqual(validation, { ok: false, missing: ['asset_refs', 'approval_scope'] });
  assert.deepEqual(
    REQUIRED_HANDOFF_KEYS,
    ['asset_refs', 'scope_version', 'finding_refs', 'approval_scope', 'skill_ids'],
    '缺失项顺序跟随契约，而不是调用方给的顺序',
  );
});

test('未声明的必需键即使解析为空也不阻止确认', () => {
  const validation = validateHandoff(
    makePackage({ approvedSkillIds: [], approvedApprovalRequired: [] }),
    ['asset_refs'],
    makeScope(),
    makeContext(),
  );
  assert.deepEqual(validation, { ok: true });
});

test('目标阶段声明的必需键全部可解析时通过', () => {
  const validation = validateHandoff(
    makePackage(),
    ['asset_refs', 'scope_version', 'finding_refs', 'approval_scope', 'skill_ids'],
    makeScope(),
    makeContext(),
  );
  assert.deepEqual(validation, { ok: true });
});

test('利用验证阶段缺 finding_refs 时被阻止（§7.2 的例子）', () => {
  const validation = validateHandoff(
    makePackage({ approvedContextRefs: ['memory:asset-1'] }),
    ['finding_refs', 'approval_scope'],
    makeScope(),
    makeContext(),
  );
  assert.deepEqual(validation, { ok: false, missing: ['finding_refs'] });
});

test('校验是纯函数：冻结的交接包与上下文都不被改写', () => {
  const pkg = deepFreeze(makePackage());
  const context = deepFreeze(makeContext());
  const scope = makeScope();
  const before = JSON.stringify({ pkg, context, scopeVersion: scope.version });
  const scopeSize = scope.includedAssetIds?.size;

  const first = validateHandoff(pkg, [...REQUIRED_HANDOFF_KEYS], scope, context);
  const resolved = resolveHandoffKeys(pkg, scope, context);
  const second = validateHandoff(pkg, [...REQUIRED_HANDOFF_KEYS], scope, context);

  assert.deepEqual(first, { ok: true });
  assert.deepEqual(second, first, '重复校验结果一致');
  assert.deepEqual(JSON.stringify({ pkg, context, scopeVersion: scope.version }), before);
  assert.equal(scope.includedAssetIds?.size, scopeSize);
  assert.deepEqual(resolved.skill_ids, ['web-vuln']);
  assert.equal(pkg.contentHash, 'pending', '校验不写回 content_hash');
});

// ───────────────────────────── 转移类型 ─────────────────────────────

test('只有产生交接记录的四种转移类型属于交接包', () => {
  for (const type of HANDOFF_TRANSITION_TYPES) assert.equal(isHandoffTransitionType(type), true, type);
  for (const type of [
    'start',
    'interject_wake',
    'handoff_cancel',
    'handoff_regen',
    'report_reopen',
    'pause',
    'resume',
    'abort',
    'complete',
    undefined,
    null,
    7,
  ]) {
    assert.equal(isHandoffTransitionType(type), false, String(type));
  }
});

test('interject_wake 不得出现在交接包里：校验直接抛协议错误', () => {
  assert.throws(
    () =>
      validateHandoff(
        makePackage({ transitionType: 'interject_wake' as never }),
        ['skill_ids'],
        makeScope(),
        makeContext(),
      ),
    (error: unknown) => {
      assert.ok(error instanceof HandoffProtocolError);
      assert.equal(error.transitionType, 'interject_wake');
      assert.match(error.message, /不产生交接记录/);
      return true;
    },
  );
});

test('其它不产生交接记录的转移同样被拒，四种合法转移通过', () => {
  for (const type of ['handoff_cancel', 'handoff_regen', 'report_reopen', 'pause']) {
    assert.throws(
      () =>
        validateHandoff(makePackage({ transitionType: type as never }), [], makeScope(), makeContext()),
      HandoffProtocolError,
      type,
    );
    assert.throws(() => assertHandoffTransitionType(type), HandoffProtocolError, type);
  }
  for (const type of HANDOFF_TRANSITION_TYPES) {
    assert.equal(assertHandoffTransitionType(type), type);
  }
});

test('未知转移类型同样是协议错误', () => {
  assert.throws(
    () => assertHandoffTransitionType('teleport'),
    (error: unknown) => {
      assert.ok(error instanceof HandoffProtocolError);
      assert.match(error.message, /未知转移类型/);
      return true;
    },
  );
});

test('Profile 声明来源表之外的必需键时 fail loud', () => {
  assert.throws(
    () =>
      validateHandoff(
        makePackage(),
        ['asset_refs', 'evidence_refs'] as unknown as readonly RequiredHandoffKey[],
        makeScope(),
        makeContext(),
      ),
    (error: unknown) => {
      assert.ok(error instanceof HandoffProtocolError);
      assert.deepEqual(error.requiredKeys, ['evidence_refs']);
      return true;
    },
  );
});

// ───────────────────────────── 确认前检查 ─────────────────────────────

test('确认前检查：interject_wake 报 handoff_transition_illegal，不是缺键', () => {
  const check = validateHandoffForConfirmation({
    pkg: makePackage({ transitionType: 'interject_wake' as never }),
    requiredKeys: ['skill_ids'],
    boundScopeVersion: makeScope(),
    context: makeContext(),
  });

  assert.equal(check.ok, false);
  assert.equal(check.ok === false ? check.missing.length : -1, 0);
  assert.equal(check.ok === false ? check.error.status : null, 'blocked');
  assert.equal(check.ok === false ? check.error.code : null, 'handoff_transition_illegal');
  assert.ok(check.ok === false && check.error.message.length > 0);
  assert.ok(check.ok === false && check.error.next_action.length > 0);
});

test('确认前检查：缺必需键报 handoff_incomplete 并列出缺失项', () => {
  const check = validateHandoffForConfirmation({
    pkg: makePackage({ approvedContextRefs: [], approvedSkillIds: [] }),
    requiredKeys: ['asset_refs', 'skill_ids'],
    boundScopeVersion: { version: 3 },
    context: makeContext([]),
  });

  assert.equal(check.ok, false);
  assert.equal(check.ok === false ? check.error.code : null, 'handoff_incomplete');
  assert.deepEqual(check.ok === false ? check.missing : null, ['asset_refs', 'skill_ids']);
  assert.match(check.ok === false ? check.error.message : '', /asset_refs、skill_ids/);
});

test('确认前检查：完整交接包通过，且不产生任何工具错误', () => {
  const check = validateHandoffForConfirmation({
    pkg: makePackage(),
    requiredKeys: [...REQUIRED_HANDOFF_KEYS],
    boundScopeVersion: makeScope(),
    context: makeContext(),
  });
  assert.deepEqual(check, { ok: true });
});

// ───────────────────────────── 内容哈希 ─────────────────────────────

test('内容哈希：同一输入稳定复现，且为 sha256 十六进制', () => {
  const first = computeHandoffHash(makePackage(), makeScope());
  const second = computeHandoffHash(makePackage(), makeScope());
  assert.equal(first, second);
  assert.match(first, /^[0-9a-f]{64}$/);
});

test('内容哈希：内容、引用顺序、范围版本变化都改变哈希', () => {
  const base = computeHandoffHash(makePackage(), makeScope());
  assert.notEqual(base, computeHandoffHash(makePackage({ approvedPrompt: '改写过的提示词' }), makeScope()));
  assert.notEqual(base, computeHandoffHash(makePackage(), { version: 8 }));
  assert.notEqual(
    base,
    computeHandoffHash(makePackage({ approvedContextRefs: ['memory:finding-1', 'memory:asset-1'] }), makeScope()),
    '引用顺序有语义（§7.4 按优先级截断），顺序不同即不同内容',
  );
  assert.notEqual(
    base,
    computeHandoffHash(makePackage({ truncatedRefs: ['memory:asset-1'] }), makeScope()),
  );
});

test('内容哈希不覆盖 content_hash 自身，算法可切换', () => {
  const base = computeHandoffHash(makePackage(), makeScope());
  assert.equal(computeHandoffHash(makePackage({ contentHash: 'whatever' }), makeScope()), base);

  const sha512 = computeHandoffHash(makePackage(), makeScope(), 'sha512');
  assert.match(sha512, /^[0-9a-f]{128}$/);
  assert.notEqual(sha512, base);
});

test('内容哈希区分阶段与任务提示词', () => {
  const base = computeHandoffHash(makePackage(), makeScope());
  assert.notEqual(
    base,
    computeHandoffHash(makePackage({ approvedToPhase: 'post-exploitation' as Phase }), makeScope()),
  );
  assert.notEqual(base, computeHandoffHash(makePackage({ forced: true }), makeScope()));
});

/**
 * 递归反转对象的键序——模拟 `jsonb` 读回时的「另一种键序」。
 *
 * PostgreSQL 的 jsonb **不保留对象键序**（按「长度 + 字节序」重排，还会去重），
 * 因此写入时的 JS 插入顺序与读回时的顺序必然可能不同。这里只要求「不同」，不要求
 * 复刻 PG 的具体排法。
 */
function withReversedKeys<T>(value: T): T {
  if (Array.isArray(value)) return value.map((item) => withReversedKeys(item)) as unknown as T;
  if (value === null || typeof value !== 'object') return value;
  const source = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(source).reverse()) out[key] = withReversedKeys(source[key]);
  return out as T;
}

test('内容哈希只取决于值，不取决于键序（jsonb 会重排键：2026-10-05 实测）', () => {
  // 这条性质是「哈希可自证」的全部理由：写入时按 JS 键序序列化、读回时按 jsonb 键序
  // 序列化，若把键序算进摘要，同一份内容就会有**两个**合法哈希——人类看到的、
  // 库里存的、事后复算的三者永远对不上（首版正是这样，实测 stored ≠ recomputed）。
  assert.equal(
    computeDraftHash(withReversedKeys({ prompt: 'p', objective: 'o', skills: ['s1', 's2'] })),
    computeDraftHash({ prompt: 'p', objective: 'o', skills: ['s1', 's2'] }),
    '草稿哈希不随键序变（draft_json 是 jsonb 列）',
  );
  assert.equal(
    computeHandoffHash(withReversedKeys(makePackage()), makeScope()),
    computeHandoffHash(makePackage(), makeScope()),
    '确认哈希不随键序变（approved_json 是 jsonb 列）',
  );
  // 数组顺序**有**语义（§7.4 按引用优先级截断）：排序反而会抹掉事实，必须仍然敏感。
  assert.notEqual(computeDraftHash({ skills: ['s1', 's2'] }), computeDraftHash({ skills: ['s2', 's1'] }));
});

// ─────────────────────── 可空键 vs 内容必需键（§2.2 与 §7.2 的调和） ───────────────────────

test('内容必需键解析为空一律阻止确认，无论是否表决为空', () => {
  // asset_refs = 资产分块 asset_ids ⊕ 范围版本纳入集合，因此要让它在两种来源上都为空：
  // 无资产引用分块 + 范围版本没有任何纳入资产。
  const pkg = makePackage({ approvedContextRefs: [] });
  const emptyScope = makeScope([]);
  const withVote = validateHandoff(pkg, ['asset_refs'], emptyScope, {}, ['asset_refs']);
  assert.equal(withVote.ok, false, '内容必需键即使被表决为空也仍算缺失');
  if (withVote.ok) return;
  assert.deepEqual(withVote.missing, ['asset_refs']);

  const noVote = validateHandoff(pkg, ['asset_refs'], emptyScope);
  assert.equal(noVote.ok, false);
});

test('内容必需键 scope_version：范围未绑定即缺失', () => {
  const pkg = makePackage();
  const validation = validateHandoff(pkg, ['scope_version'], null);
  assert.equal(validation.ok, false);
  if (validation.ok) return;
  assert.deepEqual(validation.missing, ['scope_version']);
});

test('可空键：人类表决为空则通过（§2.2 允许不装载 skill）', () => {
  const pkg = makePackage({ approvedSkillIds: [], approvedApprovalRequired: [] });

  // 未表决 → 视为"漏了"，阻止
  const unvoted = validateHandoff(pkg, ['skill_ids', 'approval_scope'], makeScope());
  assert.equal(unvoted.ok, false, '未表决的空集合必须被拦住');
  if (unvoted.ok) return;
  assert.deepEqual([...unvoted.missing].sort(), ['approval_scope', 'skill_ids']);

  // 表决为空 → 视为"有意为空"，放行
  const voted = validateHandoff(
    pkg,
    ['skill_ids', 'approval_scope'],
    makeScope(),
    {},
    ['skill_ids', 'approval_scope'],
  );
  assert.equal(voted.ok, true, '人类显式选择不装载 skill 是合法状态');
});

test('可空键非空时无需表决即通过', () => {
  const pkg = makePackage({ approvedSkillIds: ['web-vuln'] });
  const validation = validateHandoff(pkg, ['skill_ids'], makeScope());
  assert.equal(validation.ok, true);
});

test('混合场景：内容键为空仍阻止，可空键已表决放行', () => {
  const pkg = makePackage({ approvedSkillIds: [], approvedContextRefs: [] });
  const emptyScope = makeScope([]);
  const validation = validateHandoff(
    pkg,
    ['skill_ids', 'asset_refs'],
    emptyScope,
    {},
    ['skill_ids'],
  );
  assert.equal(validation.ok, false);
  if (validation.ok) return;
  assert.deepEqual(validation.missing, ['asset_refs'], '只有内容键被列为缺失');
});

// ───────────── 引用预算：溢出的进 truncatedRefs（设计 §8.10.1） ─────────────

test('引用数在预算内：原样保留、顺序不变，没有截断', () => {
  const refs = ['memory:a', 'memory:b', 'memory:c'];
  assert.deepEqual(capContextRefs(refs), { kept: refs, truncated: [] });
});

test('引用数超预算：前 N 条进交接包，其余进 truncatedRefs——两份不重叠、并集是原集合、顺序保持', () => {
  const refs = Array.from({ length: HANDOFF_MAX_CONTEXT_REFS + 7 }, (_, i) => `memory:${i}`);
  const { kept, truncated } = capContextRefs(refs);
  assert.equal(kept.length, HANDOFF_MAX_CONTEXT_REFS);
  assert.equal(truncated.length, 7);
  assert.deepEqual(kept, refs.slice(0, HANDOFF_MAX_CONTEXT_REFS), '必须按人类排的顺序截，不能重排');
  assert.deepEqual(truncated, refs.slice(HANDOFF_MAX_CONTEXT_REFS));
  assert.equal(kept.some((id) => truncated.includes(id)), false, '两份不得重叠');
  assert.deepEqual([...kept, ...truncated], refs, '并集必须等于原集合（不能悄悄丢条目）');
});

test('重复引用会被折叠：同一 memoryId 只算一条，避免预算被重复项吃掉', () => {
  assert.deepEqual(capContextRefs(['memory:a', 'memory:a', 'memory:b']), {
    kept: ['memory:a', 'memory:b'],
    truncated: [],
  });
});

test('非法上限直接抛错：不猜、不静默退化成"全放行"', () => {
  assert.throws(() => capContextRefs(['memory:a'], 0), HandoffProtocolError);
  assert.throws(() => capContextRefs(['memory:a'], 1.5), HandoffProtocolError);
});

test('服务端起稿：提示词里必须有阶段目标、应产出物、上一阶段要点与边界', () => {
  // 2026-10-05 人类要求：别再让 Agent 起草（对话里会刷一堵机器格式的 JSON），
  // 直接给一份**可编辑**的初始内容。这份内容由纯函数拼装，因此可以逐项断言。
  const seeded = seedHandoffContent({
    fromPhase: 'intelligence-gathering',
    toPhase: 'threat-modeling',
    statusNote: '指纹完成：nginx + Next.js；/api/submissions 未认证可读。',
    approvalRequired: ['active_probing'],
  });
  assert.equal(seeded.objective, '进入威胁建模：建立攻击面与业务影响模型');
  assert.match(seeded.prompt, /# 阶段目标/);
  assert.match(seeded.prompt, /建立攻击面与业务影响模型/);
  assert.match(seeded.prompt, /# 本阶段应产出/);
  assert.match(seeded.prompt, /资产图/);
  assert.match(seeded.prompt, /# 上一阶段要点/);
  assert.match(seeded.prompt, /指纹完成/, '状态便签必须带过去，人类才不用自己回忆');
  assert.match(seeded.prompt, /# 完成判据/);
  assert.match(seeded.prompt, /# 边界/);
  assert.deepEqual(seeded.approvalRequired, ['active_probing'], '放行类别跟随作业当前策略');
  assert.ok(seeded.allowed.includes('pentest_exec'), '工具建议来自默认白名单（与创建会话同源）');
  assert.ok(seeded.limitations.length > 0, '必须说明这是服务端起稿、未经 Agent');

  // 既没有便签也没有报告时不该留一个空的「上一阶段要点」小标题。
  const bare = seedHandoffContent({
    fromPhase: 'threat-modeling',
    toPhase: 'vulnerability-analysis',
    statusNote: null,
    approvalRequired: [],
  });
  assert.ok(!bare.prompt.includes('# 上一阶段要点'), '两样都没有就不该出现空标题');
  assert.match(bare.objective, /^进入漏洞分析：/, '目标写着目标阶段的名字（人类一眼能看出要去哪）');
});

test('上一阶段要点由**便签与报告**两个来源拼成（2026-10-07：此前只有便签）', () => {
  // 便签上限只有 600 字符，报告是结构化产出（判据/证据/未决），信息更全。
  // 只拼便签时压缩比高到丢信息——这是"交接到底复用了什么"的核心一环。
  const seeded = seedHandoffContent({
    fromPhase: 'vulnerability-analysis',
    toPhase: 'exploitation',
    statusNote: '确认了两条候选：/api/submissions 未认证可读、旧版编辑器 XSS。',
    previousReport: { reportId: 'report-77', summary: '候选漏洞 2 条，去重后 2 条；证据 4 份；建议先验证越权读取。' },
    approvalRequired: ['exploit_validation'],
  });
  assert.match(seeded.prompt, /# 上一阶段要点/);
  assert.match(seeded.prompt, /（状态便签）/, '便签要标明来源');
  assert.match(seeded.prompt, /（报告要点 report-77）/, '报告要点要标明来源与报告 id（可回溯）');
  assert.match(seeded.prompt, /建议先验证越权读取/, '报告的处置建议必须带过去');

  // 只有报告、没有便签：这一节仍然要出现（不能因为便签为空就整节丢掉）
  const reportOnly = seedHandoffContent({
    fromPhase: 'vulnerability-analysis',
    toPhase: 'exploitation',
    statusNote: '   ',
    previousReport: { reportId: 'report-78', summary: '只有报告没有便签。' },
    approvalRequired: [],
  });
  assert.match(reportOnly.prompt, /# 上一阶段要点/);
  assert.match(reportOnly.prompt, /只有报告没有便签/);
  assert.ok(!reportOnly.prompt.includes('（状态便签）'), '空便签不占位');
});

test('引用由起草者自动带入：上限收口、写进草稿 JSON（信封不再永远是空的）', () => {
  // 真实数据（18 次交接）里 `context_refs` 全是空数组：不是代理不用记忆（它自己搜了 77 次），
  // 而是从来没人往里放。引用编辑器撤下后，这条通路只能靠起草者自动填。
  const many = Array.from({ length: HANDOFF_AUTO_CONTEXT_REFS + 3 }, (_, i) => ({
    memoryId: `memory:r${String(i)}`,
    reason: `上一阶段记忆：条目 ${String(i)}`,
  }));
  const seeded = seedHandoffContent({
    fromPhase: 'threat-modeling',
    toPhase: 'vulnerability-analysis',
    statusNote: '便签',
    candidateRefs: many,
    approvalRequired: [],
  });
  assert.equal(seeded.contextRefs.length, HANDOFF_AUTO_CONTEXT_REFS, '条数按常量收口');
  assert.deepEqual(
    seeded.draftJson.contextRefs,
    seeded.contextRefs,
    '落库的草稿 JSON 必须带上同一份（信封从它派生）',
  );
  assert.ok(
    seeded.limitations.some((line) => line.includes('自动带入')),
    '人类不再逐条编辑引用，因此必须如实说明"是我自动带的"',
  );

  // 没有候选时不写空话、也不留空标题
  const none = seedHandoffContent({
    fromPhase: 'threat-modeling',
    toPhase: 'vulnerability-analysis',
    statusNote: '便签',
    candidateRefs: [],
    approvalRequired: [],
  });
  assert.deepEqual(none.contextRefs, []);
  assert.ok(!none.limitations.some((line) => line.includes('自动带入')));
});
