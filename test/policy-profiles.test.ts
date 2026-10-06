/**
 * 行为预设、范围入口、策略哈希与 plan_hash 的纯逻辑回归（§6.2.0.5、§10.2）。
 *
 * 这一组用例锁的是四条硬要求，任何一条退化都会让「隐蔽性测试」变成一句标签：
 *
 *   1. 四个预设的展开结果稳定，且 stealth 确实比 deep 慢；
 *   2. 覆盖不能突破硬上限（只能收紧，不能放宽）；
 *   3. 默认禁用类别只有**显式确认**才被开启，并因此带上 dualConfirmed；
 *   4. 哈希覆盖完整输入：只改排除项、授权引用或版本都会产生不同哈希；
 *      展开后的 pacing 进入 `plan_hash`（否则改节奏不会让旧凭证失效）。
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ACTION_CLASSES, BEHAVIOR_PROFILES, CUSTOM_GUIDANCE_MAX_CHARS, SCOPE_ENTRY_PROFILES, type ScopeTarget } from '../src/contracts.ts';
import {
  canonicalPolicyJson,
  expandBehaviorProfile,
  policyContentHash,
  requireApprovalMode,
  requireBehaviorSelection,
  shouldSelfApprove,
  unknownPolicyOverrideKeys,
} from '../src/policy/behavior-profile.ts';
import { renderBehaviorSection } from '../src/policy/behavior-prompts.ts';
import { normalizeScope, scopeContentHash } from '../src/policy/scope-snapshot.ts';
import { actionPolicyFromSnapshot } from '../src/policy/pg-policy.ts';
import { derivePlanHash } from '../src/execution/idempotency.ts';

const TARGETS: readonly ScopeTarget[] = [
  { kind: 'domain', value: 'Target.Example.', protocols: ['tcp'], ports: [{ from: 443, to: 443 }] },
];
const EXCLUSIONS: readonly ScopeTarget[] = [
  { kind: 'ip', value: '10.0.0.9', protocols: ['tcp'], ports: [{ from: 443, to: 443 }] },
];

function expand(
  overrides: Readonly<Record<string, unknown>> = {},
  exclusions: readonly ScopeTarget[] = EXCLUSIONS,
) {
  return expandBehaviorProfile({
    scopeEntry: 'domain',
    behaviorProfile: 'stealth',
    targets: TARGETS,
    exclusions,
    overrides,
    constraints: { authorization_ref: 'AUTH-1' },
  });
}

describe('行为预设展开（§6.2.0.5）', () => {
  it('四个预设都有稳定默认节奏，且 stealth 严格慢于 deep', () => {
    const pacingOf = (profile: (typeof BEHAVIOR_PROFILES)[number]) =>
      expandBehaviorProfile({ behaviorProfile: profile, targets: TARGETS, exclusions: [] }).pacing;

    for (const profile of BEHAVIOR_PROFILES) {
      const pacing = pacingOf(profile);
      assert.ok(pacing.rate > 0, `${profile} 的 rate 必须为正`);
      assert.ok(pacing.concurrency >= 1, `${profile} 的 concurrency 至少为 1`);
      assert.ok(pacing.jitter >= 0 && pacing.burst >= 1 && pacing.retry >= 0);
    }
    assert.ok(pacingOf('stealth').rate < pacingOf('deep').rate, 'stealth 必须比 deep 慢');
    assert.ok(pacingOf('stealth').concurrency < pacingOf('deep').concurrency);
    assert.ok(pacingOf('stealth').rate <= pacingOf('standard').rate);
  });

  it('范围入口原样进入快照；未知入口被拒绝而不是静默退回推断', () => {
    for (const entry of SCOPE_ENTRY_PROFILES) {
      assert.equal(
        expandBehaviorProfile({ scopeEntry: entry, targets: TARGETS, exclusions: [] }).scope_entry,
        entry,
      );
    }
    assert.throws(
      () => expandBehaviorProfile({ scopeEntry: 'everything' as never, targets: TARGETS }),
      /Unknown scope entry profile/,
    );
    assert.throws(
      () => expandBehaviorProfile({ behaviorProfile: 'aggressive' as never, targets: TARGETS }),
      /Unknown behavior profile/,
    );
  });

  it('自定义覆盖只能收紧，不能突破硬上限', () => {
    const pacing = expand({ rate: 9999, concurrency: 9999, burst: 9999, retry: 9999, jitter: 99 }).pacing;
    assert.ok(pacing.rate <= 10, `rate 必须被硬上限压住，实际 ${String(pacing.rate)}`);
    assert.ok(pacing.concurrency <= 4);
    assert.ok(pacing.burst <= 2);
    assert.ok(pacing.retry <= 2);
    assert.ok(pacing.jitter <= 1);
  });

  it('默认禁用类别：没有显式确认就不开启，有确认才开启并带 dualConfirmed', () => {
    const silent = expand({ enabledActionClasses: ['persistence'] });
    assert.ok(!silent.action_policy.enabled.includes('persistence'), '未确认的类别不得被开启');
    assert.notEqual(silent.action_policy.dualConfirmed, true);
    assert.equal(actionPolicyFromSnapshot(silent.snapshot).enabledDisabledClasses, undefined);

    const confirmed = expand({ enabledActionClasses: ['persistence'], enable_persistence: true });
    assert.ok(confirmed.action_policy.enabled.includes('persistence'), '显式确认后必须开启');
    assert.equal(confirmed.action_policy.dualConfirmed, true, '开启默认禁用类别必须带双确认标记');

    // 经过存储面（策略源）读回时双确认必须还在，否则执行侧会重新拒绝。
    const reparsed = actionPolicyFromSnapshot(confirmed.snapshot);
    assert.deepEqual(reparsed.enabledDisabledClasses, ['persistence']);
    assert.equal(reparsed.dualConfirmed, true);
    assert.ok(reparsed.pacing !== undefined, '展开的 pacing 必须能被策略源读回');
  });

  it('确认必须**逐类别**：一次确认不得连带放行同批里的其它默认禁用类别', () => {
    // 回归锁（对抗性审查发现）：`allowedActions` 曾绕过确认闸门，而 `dualConfirmed`
    // 是全局布尔——于是 `{allowedActions:['persistence','destructive'], confirmations:{destructive:true}}`
    // 会把**从未被确认**的 persistence 一起放行。
    const mixed = expand({
      allowedActions: ['persistence', 'destructive'],
      confirmations: { destructive: true },
    });
    assert.ok(mixed.action_policy.enabled.includes('destructive'), '被确认的类别必须开启');
    assert.ok(
      !mixed.action_policy.enabled.includes('persistence'),
      '同批里未被确认的类别绝不能被连带开启',
    );
    assert.deepEqual(mixed.action_policy.enabledDisabledClasses, ['destructive']);
    // 执行侧读回后也只能看到被确认的那一个：这是真正拦住动作的地方。
    assert.deepEqual(actionPolicyFromSnapshot(mixed.snapshot).enabledDisabledClasses, ['destructive']);
  });

  it('开启的默认禁用类别与认证读取都进入逐动作放行集合（§10.3 风险分级表）', () => {
    const enabled = expand({
      allowedActions: ['passive_collection', 'credentialed_access', 'lateral_movement', 'destructive'],
      enable_destructive: true,
    });
    const approvals = enabled.action_policy.perActionApprovalClasses;
    for (const required of ['exploit_validation', 'lateral_movement', 'credentialed_access', 'destructive']) {
      assert.ok(approvals.includes(required as never), `${required} 必须逐动作放行`);
    }
    // 契约基线下界不可被移除
    const narrowed = expand({ allowedActions: ['passive_collection'] });
    assert.deepEqual(
      narrowed.action_policy.perActionApprovalClasses,
      ['exploit_validation', 'lateral_movement'],
      '基线类别无论如何都必须在集合里',
    );
  });

  it('allowedActions 是上界：显式给出时只保留其中类别', () => {
    const narrowed = expand({ allowedActions: ['passive_collection'] });
    assert.deepEqual(narrowed.action_policy.enabled, ['passive_collection']);
    assert.ok(narrowed.action_policy.disabled.includes('active_probing'));
    assert.deepEqual(actionPolicyFromSnapshot(narrowed.snapshot).enabledActionClasses, ['passive_collection']);
  });

  it('自由命令（free_command 的 exploit_validation）随模式变可用性，逐动作放行的下限不随模式下调', () => {
    // §10.2.1 + §10.3：**模式决定「这一类在不在启用集合里」，契约基线决定「要不要逐次放行」**。
    // stealth/standard 只做被动读取与主动发现；deep 纳入 exploit_validation；custom 默认同 stealth，
    // 只有人类显式 `allowedActions` 才开。自由度随模式变，下限不随模式变。
    const enabledByProfile: Readonly<Record<(typeof BEHAVIOR_PROFILES)[number], boolean>> = {
      stealth: false,
      standard: false,
      deep: true,
      custom: false,
    };
    for (const profile of BEHAVIOR_PROFILES) {
      const policy = actionPolicyFromSnapshot(
        expandBehaviorProfile({ behaviorProfile: profile, targets: TARGETS, exclusions: [] }).snapshot,
      );
      assert.ok(
        policy.perActionApprovalClasses.includes('exploit_validation'),
        `${profile}：利用验证（自由命令所属类别）必须始终要人类逐次放行——这是不可下调的下限`,
      );
      assert.equal(
        (policy.enabledActionClasses ?? []).includes('exploit_validation'),
        enabledByProfile[profile],
        `${profile}：自由命令的可用性只由启用集合决定`,
      );
    }

    // custom + 显式启用：可用性打开，逐次放行照旧——下限不能靠换模式绕过。
    const custom = actionPolicyFromSnapshot(
      expandBehaviorProfile({
        behaviorProfile: 'custom',
        targets: TARGETS,
        exclusions: [],
        overrides: { allowedActions: [...ACTION_CLASSES] },
      }).snapshot,
    );
    assert.ok((custom.enabledActionClasses ?? []).includes('exploit_validation'), 'custom 显式启用后应当可用');
    assert.ok(custom.perActionApprovalClasses.includes('exploit_validation'), '启用不等于免放行');
  });

  it('行为预设注入的是**提示词**：每个预设有自己的行为指引，且都写明「超出预设先请放行」', () => {
    // 2026-10-04 决定：预设不再是硬纪律，只注入提示词；边界由人类放行把守。
    // 这一条钉两件事：① 四档各有各的姿态，不是同一段话换名字；
    // ② 每一段都必须出现「超出预设 → 先请人类放行」这条升级规则（缺了它，Approve 就没有出口）。
    const sections = BEHAVIOR_PROFILES.map((profile) =>
      renderBehaviorSection({ profile, pacing: { rate: 5, concurrency: 2 } }),
    );
    for (const [index, profile] of BEHAVIOR_PROFILES.entries()) {
      const text = sections[index]!;
      // 分节头在 2026-10-05 起带场景名（`【行为预设：stealth｜红队 / 隐蔽测试】`），因此按前缀断言。
      assert.ok(text.includes(`【行为预设：${profile}｜`), `${profile} 的分节必须点名预设与场景`);
      assert.ok(
        text.includes('pentest_request_action_approval'),
        `${profile}: 升级规则必须点名放行工具（否则「请人类放行」没有出口）`,
      );
      assert.ok(text.includes('不得先做后报'), `${profile}: 必须明确禁止先做后报`);
    }
    assert.notEqual(sections[0], sections[2], 'stealth 与 deep 的姿态不能是同一段话');
    // 场景差异的锚点（文案即产品）：隐蔽档强调"少发请求"，深挖档强调"穷尽并记录"。
    assert.ok(sections[0]!.includes('少发一个请求') && sections[2]!.includes('穷尽尝试并记录'));
    assert.ok(sections[1]!.includes('速率 5/s'), '节奏上限必须写进提示词');
    assert.ok(
      !renderBehaviorSection({ profile: 'custom' }).includes('速率'),
      '未给 pacing 时不得凭空编造节奏',
    );
  });

  it('未声明的覆盖键被点名（不静默忽略）', () => {
    assert.deepEqual(unknownPolicyOverrideKeys({ rate: 1, enable_persistence: true }), []);
    assert.deepEqual(unknownPolicyOverrideKeys({ rateLimit: 1 }), ['rateLimit']);
    assert.deepEqual(unknownPolicyOverrideKeys({ enable_read_only: true }), ['enable_read_only']);
  });
});

describe('计划摘要与策略绑定（§10.2）', () => {
  const base = {
    policyVersion: 1 as number | null,
    pacing: null,
    templateId: 'http_read',
    actionClass: 'passive_collection' as const,
    normalizedTarget: 'target.example:443',
    normalizedCommand: 'http_get target=target.example:443 method=GET',
    timeoutMs: 15_000,
    maxOutputBytes: 262_144,
    scopeVersion: 1,
    policyEpoch: 0,
  };
  const stealth = expandBehaviorProfile({ behaviorProfile: 'stealth', targets: TARGETS, exclusions: [] }).pacing;
  const deep = expandBehaviorProfile({ behaviorProfile: 'deep', targets: TARGETS, exclusions: [] }).pacing;

  it('pacing 进 plan_hash：只改节奏就得到不同摘要', () => {
    assert.notEqual(
      derivePlanHash({ ...base, policyVersion: 1, pacing: stealth }),
      derivePlanHash({ ...base, policyVersion: 1, pacing: deep }),
    );
  });

  it('策略版本进 plan_hash；同一份 pacing 派生同一摘要', () => {
    assert.notEqual(
      derivePlanHash({ ...base, policyVersion: 1, pacing: stealth }),
      derivePlanHash({ ...base, policyVersion: 2, pacing: stealth }),
      '策略版本变化必须改变计划摘要',
    );
    assert.equal(
      derivePlanHash({ ...base, policyVersion: 1, pacing: stealth }),
      derivePlanHash({ ...base, policyVersion: 1, pacing: { ...stealth } }),
    );
  });

  it('无 pacing 的旧计划与「显式 null」派生同一摘要（向后兼容）', () => {
    assert.equal(derivePlanHash(base), derivePlanHash({ ...base, pacing: null }));
  });
});

describe('策略快照哈希（§6.2.0.5）', () => {
  it('同一输入得到同一哈希，且哈希可复核：存的即哈希的', () => {
    const first = expand();
    const second = expand();
    assert.equal(first.snapshotHash, second.snapshotHash);
    assert.equal(policyContentHash(first.snapshot), first.snapshotHash);
    assert.equal(first.canonicalJson, JSON.stringify(JSON.parse(first.canonicalJson)));
  });

  it('只改排除项就得到不同哈希（此前截断哈希丢掉的判别力）', () => {
    const other = expand({}, [{ kind: 'ip', value: '10.0.0.10', protocols: ['tcp'], ports: [] }]);
    assert.notEqual(expand().snapshotHash, other.snapshotHash);
  });

  it('授权约束变化产生不同哈希（授权引用、时间窗、预算都在覆盖内）', () => {
    const withWindow = expandBehaviorProfile({
      scopeEntry: 'domain',
      behaviorProfile: 'stealth',
      targets: TARGETS,
      exclusions: EXCLUSIONS,
      overrides: {},
      constraints: { authorization_ref: 'AUTH-1', timeWindow: { from: '09:00', to: '18:00' }, budget: null },
    });
    assert.notEqual(expand().snapshotHash, withWindow.snapshotHash);
  });

  it('规范 JSON 与键序无关', () => {
    assert.equal(canonicalPolicyJson({ b: 1, a: [true, null] }), canonicalPolicyJson({ a: [true, null], b: 1 }));
  });
});

describe('范围规范化与内容哈希（§10.2.2）', () => {
  it('规范化：大小写、尾点、IDN 与端口顺序都收敛到同一形式', () => {
    const result = normalizeScope({
      targets: [{ kind: 'domain', value: 'Target.Example.', protocols: ['udp', 'tcp'], ports: [{ from: 443, to: 443 }, { from: 80, to: 80 }] }],
      exclusions: [],
    });
    assert.ok(result.ok, result.ok ? '' : result.detail);
    const target = result.value.targets[0];
    assert.equal(target?.value, 'target.example');
    assert.deepEqual(target?.protocols, ['tcp', 'udp'], '协议集合必须按稳定顺序落库');
    assert.deepEqual(target?.ports, [{ from: 80, to: 80 }, { from: 443, to: 443 }], '端口必须按稳定顺序落库');
  });

  it('通配与网段保留其判定语义', () => {
    const result = normalizeScope({
      targets: [
        { kind: 'domain', value: '*.target.example', protocols: ['tcp'], ports: [] },
        { kind: 'cidr', value: '10.20.1.7/24', protocols: ['tcp'], ports: [{ from: 8080, to: 8080 }] },
      ],
      exclusions: [],
    });
    assert.ok(result.ok, result.ok ? '' : result.detail);
    assert.equal(result.value.targets[0]?.value, '*.target.example');
    assert.equal(result.value.targets[0]?.wildcardSubdomain, true);
    assert.equal(result.value.targets[1]?.value, '10.20.1.0/24', '网段必须清零主机位');
  });

  it('非法条目整体拒绝，不部分放行', () => {
    const result = normalizeScope({
      targets: [{ kind: 'ip', value: '999.1.1.1', protocols: ['tcp'], ports: [] }],
      exclusions: [],
    });
    assert.equal(result.ok, false);
    if (!result.ok) assert.match(result.detail, /目标\[0\]/);
  });

  it('资产标签在创建/确认阶段不展开（此时还没有本作业的资产登记表）', () => {
    const result = normalizeScope({
      targets: [{ kind: 'asset-label', value: '@web', protocols: ['tcp'], ports: [{ from: 80, to: 80 }] }],
      exclusions: [],
    });
    assert.ok(result.ok, result.ok ? '' : result.detail);
    assert.equal(result.value.targets[0]?.value, '@web');
  });

  it('内容哈希覆盖排除项、授权引用与版本号', () => {
    const base = { targets: TARGETS, exclusions: EXCLUSIONS, authorizationRef: 'AUTH-1', version: 1 };
    const hash = scopeContentHash(base);
    assert.equal(scopeContentHash({ ...base }), hash, '同一输入必须得到同一哈希');
    assert.notEqual(scopeContentHash({ ...base, exclusions: [] }), hash, '排除项必须参与哈希');
    assert.notEqual(scopeContentHash({ ...base, authorizationRef: 'AUTH-2' }), hash, '授权引用必须参与哈希');
    assert.notEqual(scopeContentHash({ ...base, version: 2 }), hash, '版本号必须参与哈希');
    assert.match(hash, /^sha256:[0-9a-f]{64}$/, '必须是完整 SHA-256，而不是截断形态');
  });
});

/** `custom` 展开助手：指引进 overrides（这就是 API 层的形状）。 */
function expandCustom(guidance: string) {
  return expandBehaviorProfile({
    scopeEntry: 'domain',
    behaviorProfile: 'custom',
    targets: TARGETS,
    exclusions: [],
    overrides: { customGuidance: guidance },
  });
}

describe('行为预设：必选、场景差异与自定义指引（2026-10-05）', () => {
  it('四档指引两两不同，且各自带本场景的行为特征', () => {
    const sections = BEHAVIOR_PROFILES.map((profile) => renderBehaviorSection({ profile }));
    assert.equal(new Set(sections).size, BEHAVIOR_PROFILES.length, '四档的注入文本必须两两不同（场景差异就在这里）');
    for (const section of sections) {
      assert.ok(section.length > 200, '每档都要给出成段的指引，而不是一句标签');
    }
    // 差异化的锚点：每档必须写出自己那条最关键的纪律（文案是产品本体，锁它是有意的）。
    assert.match(renderBehaviorSection({ profile: 'stealth' }), /少发一个请求/);
    assert.match(renderBehaviorSection({ profile: 'standard' }), /失败也要记录/);
    assert.match(renderBehaviorSection({ profile: 'deep' }), /穷尽尝试并记录/);
  });

  it('custom 逐字注入人类写的指引；没有指引时给出可执行的兜底而不是空白', () => {
    const guidance = '只发只读请求；任何写方法先请我放行。每条结论都要给证据行。';
    const rendered = renderBehaviorSection({ profile: 'custom', customGuidance: guidance });
    assert.ok(rendered.includes(guidance), '人类写的指引必须逐字出现');
    assert.match(renderBehaviorSection({ profile: 'custom' }), /没有写入自定义指引/);
  });

  it('必选项：缺预设 / 未知预设 / custom 缺指引都拒绝；自定义指引只配 custom', () => {
    assert.throws(() => requireBehaviorSelection({}), /必选项/);
    assert.throws(() => requireBehaviorSelection({ behaviorProfile: 'aggressive' }), /必选项/);
    assert.throws(() => requireBehaviorSelection({ behaviorProfile: 'custom' }), /必须给出自定义指引/);
    assert.deepEqual(requireBehaviorSelection({ behaviorProfile: 'stealth' }), { behaviorProfile: 'stealth' });
    assert.deepEqual(requireBehaviorSelection({ behaviorProfile: 'custom', customGuidance: ' 只读。 ' }), {
      behaviorProfile: 'custom',
      customGuidance: '只读。',
    });
    assert.throws(() => requireBehaviorSelection({ behaviorProfile: 'deep', customGuidance: 'x' }), /只能配 custom/);
    assert.throws(
      () => expandBehaviorProfile({ behaviorProfile: 'stealth', targets: TARGETS, overrides: { customGuidance: 'x' } }),
      /只能配 custom/,
    );
  });

  it('自定义指引进快照与哈希：改指引即改策略；非 custom 不得出现该键', () => {
    const withGuidance = expandCustom('只读。');
    assert.equal(withGuidance.snapshot['custom_guidance'], '只读。');
    const changed = expandCustom('只读；每条结论给证据行。');
    assert.notEqual(
      withGuidance.snapshotHash,
      changed.snapshotHash,
      '改自定义指引必须改变快照哈希（于是旧放行凭证失效）',
    );
    const stealth = expandBehaviorProfile({
      scopeEntry: 'domain',
      behaviorProfile: 'stealth',
      targets: TARGETS,
      exclusions: [],
    });
    assert.equal(Object.hasOwn(stealth.snapshot, 'custom_guidance'), false, '非 custom 不得出现该键（否则旧快照哈希全变）');
    assert.throws(() => expandCustom('x'.repeat(CUSTOM_GUIDANCE_MAX_CHARS + 1)), /过长/);
  });
});

describe('审批模式：高权限的自我放行边界（2026-10-05）', () => {
  const deepAuto = {
    approvalMode: 'auto' as const,
    enabledActionClasses: ['passive_collection', 'active_probing', 'exploit_validation', 'persistence'] as const,
  };

  it('auto 档放行集合 = 预设启用 ∪ {命令类}，再减去默认禁用类别', () => {
    assert.equal(shouldSelfApprove(deepAuto, 'passive_collection'), true);
    assert.equal(shouldSelfApprove(deepAuto, 'exploit_validation'), true, '预设内的利用验证自行放行');
    // 默认禁用类别**即使人类逐类别确认开启过**也不自放行：后果不可逆，必须有人看过命令。
    assert.equal(shouldSelfApprove(deepAuto, 'persistence'), false);
    assert.equal(shouldSelfApprove(deepAuto, 'exfiltration'), false);
    // 横向移动跨主机：不在任何预设的启用集合里 ⇒ 永远转人工。
    assert.equal(shouldSelfApprove(deepAuto, 'lateral_movement'), false);

    // **命令类特例**（2026-10-05）：本部署只有 `direct_command` 一张动手模板，若严格要求
    // 「只在预设内」，stealth/standard 下每条命令都算越界 ⇒ 高权限退化成「每条都问人」。
    const stealthAuto = { approvalMode: 'auto' as const, enabledActionClasses: ['passive_collection', 'active_probing'] as const };
    assert.equal(shouldSelfApprove(stealthAuto, 'exploit_validation'), true, '命令类在 auto 档也算预设内');
    assert.equal(shouldSelfApprove({ approvalMode: 'auto' as const }, 'exploit_validation'), true, '旧快照缺启用集合时，命令类仍放行');
    assert.equal(shouldSelfApprove({ approvalMode: 'auto' as const }, 'active_probing'), false, '缺启用集合时其它类别保守转人工');
  });

  it('人工审批档与「没有冻结动作集合」都不自放行（保守缺省）', () => {
    assert.equal(shouldSelfApprove({ approvalMode: 'human', enabledActionClasses: ['passive_collection'] }, 'passive_collection'), false);
    assert.equal(shouldSelfApprove({ approvalMode: 'auto' }, 'passive_collection'), false, '没有启用集合就无从判断「预设内」');
    assert.equal(shouldSelfApprove({}, 'passive_collection'), false, '旧快照缺模式 = human');
  });

  it('模式进快照可读回；缺键的旧快照按 human；值不认识即拒绝', () => {
    const auto = expandBehaviorProfile({ behaviorProfile: 'deep', approvalMode: 'auto', targets: TARGETS, exclusions: [] });
    assert.equal((auto.snapshot['action_policy'] as Record<string, unknown>)['approval_mode'], 'auto');
    assert.equal(actionPolicyFromSnapshot(auto.snapshot).approvalMode, 'auto');
    const legacy = expandBehaviorProfile({ behaviorProfile: 'deep', targets: TARGETS, exclusions: [] });
    assert.equal((legacy.snapshot['action_policy'] as Record<string, unknown>)['approval_mode'], 'human', '缺省必须是最保守的一档');
    assert.equal(actionPolicyFromSnapshot({ action_policy: {} }).approvalMode, undefined);
    assert.throws(() => requireApprovalMode('yolo'), /必须显式选择审批模式/);
    assert.throws(() => requireApprovalMode(undefined), /没有默认值/);
    assert.equal(requireApprovalMode('auto'), 'auto');
  });
});
