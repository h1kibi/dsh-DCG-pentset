/**
 * 状态机与转移规则测试（设计文档 §1.2、§1.3、§5.2–§5.6）。
 *
 * 覆盖重点：
 *   - §5.3 推荐边的完整枚举；
 *   - 回补不递增迭代 vs 回环递增迭代（本切片最关键的一条区分）；
 *   - 强制跳转的理由与二次确认；
 *   - §5.2 边 ↔ §5.4 取值的可记账性（含四条人工边）；
 *   - 暂停不改写主状态；
 *   - 分派表逐行对照与不变量。
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  HANDOFF_TRANSITION_TYPES,
  MAIN_STATUSES,
  PHASES,
  RUN_MARKERS,
  TRANSITION_TYPES,
} from '../src/contracts.ts';
import type { MainStatus, Phase, TransitionType } from '../src/contracts.ts';
import {
  PHASE_DEFINITIONS,
  PHASE_ORDER,
  RECOMMENDED_MOVES,
  REQUIRED_ACCOUNTED_EDGES,
  RUNTIME_MARKER_TRANSITION_TYPES,
  STATE_EDGES,
  applyRunMarker,
  assertGraph,
  clearRunMarker,
  isLegalStatusEdge,
  isRecommendedMove,
  legalTransitionTypes,
  moveKindFor,
  planPhaseMove,
  skippedPhasesBetween,
  statusEdgesFor,
  validateGraph,
} from '../src/workflow/phases.ts';
import type { StateEdge } from '../src/workflow/phases.ts';
import {
  FORCEABLE_TRANSITION_TYPES,
  TRANSITION_DISPATCH,
  WorkflowTransitionError,
  assertDispatchTable,
  handoffTransitionTypeOf,
  planTransition,
  validateDispatchTable,
} from '../src/workflow/transition-table.ts';

// ───────────────────────────── §1.2 五阶段定义 ─────────────────────────────

describe('五阶段定义（§1.2）', () => {
  it('阶段集合与契约完全一致，且序号 1..5 连续', () => {
    assert.deepEqual(PHASE_ORDER, [...PHASES]);
    assert.deepEqual(
      PHASES.map((phase) => PHASE_DEFINITIONS[phase].ordinal),
      [1, 2, 3, 4, 5],
    );
    assert.deepEqual(
      PHASES.map((phase) => PHASE_DEFINITIONS[phase].id),
      [...PHASES],
    );
  });

  it('阶段与 Agent 严格 1:1：五个阶段对应五个互不相同的 Agent', () => {
    const agents = PHASES.map((phase) => PHASE_DEFINITIONS[phase].agentName);
    assert.equal(agents.length, 5);
    assert.equal(new Set(agents).size, 5);
    for (const name of agents) assert.ok(name.trim().length > 0);
  });

  it('每阶段的显示名、目标与交付物非空（§1.2）', () => {
    for (const phase of PHASES) {
      const definition = PHASE_DEFINITIONS[phase];
      assert.ok(definition.displayName.length > 0, phase);
      assert.ok(definition.shortName.length > 0, phase);
      assert.ok(definition.goal.length > 0, phase);
      assert.ok(definition.deliverables.length > 0, phase);
    }
  });

  it('退出条件逐阶段对应 §5.6 表格', () => {
    const expected: Record<Phase, { reports: string[]; humanJudgment: string[] }> = {
      'intelligence-gathering': {
        reports: ['资产', '服务', '入口', '来源', '覆盖范围', '工具限制', '未决线索'],
        humanJudgment: ['覆盖是否足够', '进入威胁建模还是继续补情报'],
      },
      'threat-modeling': {
        reports: ['资产图', '信任边界', '攻击路径', '业务影响', '假设与优先级'],
        humanJudgment: ['是否存在可测试路径', '是否需要补充情报'],
      },
      'vulnerability-analysis': {
        reports: ['候选漏洞', '受影响资产', '评级', '证据', '去重结果', '验证计划'],
        humanJudgment: ['哪些候选值得验证', '是否进入利用验证'],
      },
      exploitation: {
        reports: ['每次放行的动作', '目标', '复现结果', '影响', '原始证据', '清理记录'],
        humanJudgment: ['是否接受结果', '是否补验证', '是否进入后渗透'],
      },
      'post-exploitation': {
        reports: [
          '已获得访问权的影响边界',
          '内部可见资产清单（含发现来源）',
          '清理核查',
          '残留与未覆盖项',
          '回环或结束的建议',
        ],
        humanJudgment: ['是否开启新一轮迭代（需先完成范围修订）', '是否结束技术测试'],
      },
    };
    for (const phase of PHASES) {
      assert.deepEqual(PHASE_DEFINITIONS[phase].exit.reports, expected[phase].reports, phase);
      assert.deepEqual(PHASE_DEFINITIONS[phase].exit.humanJudgment, expected[phase].humanJudgment, phase);
    }
  });
});

// ───────────────────────────── §5.3 推荐边 ─────────────────────────────

describe('§5.3 推荐下一阶段', () => {
  it('每个当前阶段的推荐后继与设计文档表格逐项一致', () => {
    const expected: Record<Phase, readonly { toPhase: Phase | null; transitionType: TransitionType | null }[]> = {
      'intelligence-gathering': [
        { toPhase: 'intelligence-gathering', transitionType: 'retry' },
        { toPhase: 'threat-modeling', transitionType: 'advance' },
      ],
      'threat-modeling': [
        { toPhase: 'intelligence-gathering', transitionType: 'rollback' },
        { toPhase: 'threat-modeling', transitionType: 'retry' },
        { toPhase: 'vulnerability-analysis', transitionType: 'advance' },
      ],
      'vulnerability-analysis': [
        { toPhase: 'threat-modeling', transitionType: 'rollback' },
        { toPhase: 'vulnerability-analysis', transitionType: 'retry' },
        { toPhase: 'exploitation', transitionType: 'advance' },
        { toPhase: 'post-exploitation', transitionType: 'advance' },
      ],
      exploitation: [
        { toPhase: 'vulnerability-analysis', transitionType: 'rollback' },
        { toPhase: 'exploitation', transitionType: 'retry' },
        { toPhase: 'post-exploitation', transitionType: 'advance' },
      ],
      'post-exploitation': [
        { toPhase: 'intelligence-gathering', transitionType: 'loop' },
        { toPhase: 'vulnerability-analysis', transitionType: 'rollback' },
        { toPhase: 'exploitation', transitionType: 'rollback' },
        { toPhase: 'post-exploitation', transitionType: 'retry' },
        { toPhase: null, transitionType: null },
      ],
    };
    for (const phase of PHASES) {
      assert.deepEqual(
        RECOMMENDED_MOVES[phase].map((move) => ({ toPhase: move.toPhase, transitionType: move.transitionType })),
        expected[phase],
        phase,
      );
    }
  });

  it('推荐边的类别判定与括注语义一致：重做 / 回补 / 前向 / 回环', () => {
    for (const phase of PHASES) {
      for (const move of RECOMMENDED_MOVES[phase]) {
        if (move.kind === 'end_testing') continue;
        assert.ok(move.toPhase !== null);
        assert.equal(move.kind, moveKindFor(phase, move.toPhase), `${phase} → ${move.toPhase}`);
        assert.equal(move.transitionType, move.kind);
      }
    }
  });

  it('每个阶段都推荐重做自己，且这是唯一指向自身的推荐边', () => {
    for (const phase of PHASES) {
      const selfMoves = RECOMMENDED_MOVES[phase].filter((move) => move.toPhase === phase);
      assert.equal(selfMoves.length, 1, phase);
      assert.equal(selfMoves[0]?.transitionType, 'retry');
    }
  });

  it('任意阶段组合的移动类别与推荐表一致（完整枚举 5×5）', () => {
    const expectedKind: Record<string, string> = {
      'intelligence-gathering→intelligence-gathering': 'retry',
      'intelligence-gathering→threat-modeling': 'advance',
      'intelligence-gathering→vulnerability-analysis': 'advance',
      'intelligence-gathering→exploitation': 'advance',
      'intelligence-gathering→post-exploitation': 'advance',
      'threat-modeling→intelligence-gathering': 'rollback',
      'threat-modeling→threat-modeling': 'retry',
      'threat-modeling→vulnerability-analysis': 'advance',
      'threat-modeling→exploitation': 'advance',
      'threat-modeling→post-exploitation': 'advance',
      'vulnerability-analysis→intelligence-gathering': 'rollback',
      'vulnerability-analysis→threat-modeling': 'rollback',
      'vulnerability-analysis→vulnerability-analysis': 'retry',
      'vulnerability-analysis→exploitation': 'advance',
      'vulnerability-analysis→post-exploitation': 'advance',
      'exploitation→intelligence-gathering': 'rollback',
      'exploitation→threat-modeling': 'rollback',
      'exploitation→vulnerability-analysis': 'rollback',
      'exploitation→exploitation': 'retry',
      'exploitation→post-exploitation': 'advance',
      'post-exploitation→intelligence-gathering': 'loop',
      'post-exploitation→threat-modeling': 'rollback',
      'post-exploitation→vulnerability-analysis': 'rollback',
      'post-exploitation→exploitation': 'rollback',
      'post-exploitation→post-exploitation': 'retry',
    };
    for (const from of PHASES) {
      for (const to of PHASES) {
        assert.equal(moveKindFor(from, to), expectedKind[`${from}→${to}`], `${from}→${to}`);
      }
    }
  });

  it('推荐关系与跨出推荐路径的判定互为补集，且回环边在推荐表内', () => {
    assert.equal(isRecommendedMove('vulnerability-analysis', 'post-exploitation'), true, '确认无需验证时属推荐边');
    assert.equal(isRecommendedMove('intelligence-gathering', 'exploitation'), false, '跨出推荐路径');
    assert.equal(isRecommendedMove('post-exploitation', 'intelligence-gathering'), true, '回环是首选路径');
    assert.equal(isRecommendedMove('post-exploitation', 'threat-modeling'), false);
  });
});

// ───────────────────────────── §5.3 强制跳转 ─────────────────────────────

describe('§5.3 强制跳转', () => {
  it('推荐边不需要强制标记', () => {
    const outcome = planPhaseMove({ from: 'intelligence-gathering', to: 'threat-modeling' });
    assert.equal(outcome.ok, true);
    if (!outcome.ok) return;
    assert.equal(outcome.plan.forced, false);
    assert.equal(outcome.plan.reason, null);
    assert.deepEqual(outcome.plan.skippedPhases, []);
  });

  it('跨出推荐路径但未显式选择强制跳转 → forced_reason_required', () => {
    const outcome = planPhaseMove({ from: 'intelligence-gathering', to: 'exploitation' });
    assert.deepEqual(outcome, {
      ok: false,
      code: 'forced_reason_required',
      message: 'intelligence-gathering → exploitation 不在推荐路径内，必须在弹窗中显式选择强制跳转（§5.3 条件 1）',
    });
  });

  it('强制跳转缺非空理由 → forced_reason_required', () => {
    const outcome = planPhaseMove({
      from: 'intelligence-gathering',
      to: 'exploitation',
      forced: true,
      reason: '   ',
      doubleConfirmed: true,
    });
    assert.equal(outcome.ok, false);
    if (outcome.ok) return;
    assert.equal(outcome.code, 'forced_reason_required');
  });

  it('强制跳转缺二次确认 → forced_reason_required', () => {
    const outcome = planPhaseMove({
      from: 'intelligence-gathering',
      to: 'exploitation',
      forced: true,
      reason: '快速验证入口是否存在未授权访问',
    });
    assert.equal(outcome.ok, false);
    if (outcome.ok) return;
    assert.equal(outcome.code, 'forced_reason_required');
  });

  it('强制跳转标记 + 理由 + 二次确认 → 通过并标记 forced，列出被跳过的阶段与缺失证据', () => {
    const outcome = planPhaseMove({
      from: 'intelligence-gathering',
      to: 'exploitation',
      forced: true,
      reason: '已知入口，先做最小验证',
      doubleConfirmed: true,
    });
    assert.equal(outcome.ok, true);
    if (!outcome.ok) return;
    assert.equal(outcome.plan.forced, true);
    assert.equal(outcome.plan.transitionType, 'advance');
    assert.equal(outcome.plan.reason, '已知入口，先做最小验证');
    assert.deepEqual(outcome.plan.skippedPhases, ['threat-modeling', 'vulnerability-analysis']);
    assert.deepEqual(
      outcome.plan.missingEvidence.map((entry) => entry.phase),
      ['threat-modeling', 'vulnerability-analysis'],
    );
    assert.deepEqual(outcome.plan.missingEvidence[0]?.deliverables, ['资产图', '信任边界', '攻击路径', '假设与优先级']);
  });

  it('强制跳转不改变任何计数器：迭代与范围版本都不动', () => {
    const outcome = planPhaseMove({
      from: 'intelligence-gathering',
      to: 'post-exploitation',
      forced: true,
      reason: '已确认无需逐阶段推进',
      doubleConfirmed: true,
    });
    assert.equal(outcome.ok, true);
    if (!outcome.ok) return;
    assert.deepEqual(outcome.plan.skippedPhases, ['threat-modeling', 'vulnerability-analysis', 'exploitation']);
    assert.equal(outcome.plan.scopeVersion, null);
    const plan = planTransition({
      type: 'advance',
      fromStatus: 'transition_confirmation',
      toStatus: 'worker_running',
      forced: true,
    });
    assert.equal(plan.ok, true);
    if (!plan.ok) return;
    assert.equal(plan.plan.iterationDelta, 0);
    assert.equal(plan.plan.scopeVersionDelta, 0);
  });

  it('对推荐边错误标记强制 → handoff_transition_illegal（避免污染时间线与审计导出）', () => {
    const outcome = planPhaseMove({
      from: 'threat-modeling',
      to: 'vulnerability-analysis',
      forced: true,
      reason: '其实是推荐边',
      doubleConfirmed: true,
    });
    assert.equal(outcome.ok, false);
    if (outcome.ok) return;
    assert.equal(outcome.code, 'handoff_transition_illegal');
  });

  it('跳级时被跳过的阶段逐段枚举（回补与回环不产生被跳过的阶段）', () => {
    assert.deepEqual(skippedPhasesBetween('intelligence-gathering', 'vulnerability-analysis'), ['threat-modeling']);
    assert.deepEqual(skippedPhasesBetween('exploitation', 'post-exploitation'), []);
    assert.deepEqual(skippedPhasesBetween('post-exploitation', 'intelligence-gathering'), []);
    assert.deepEqual(skippedPhasesBetween('exploitation', 'vulnerability-analysis'), []);
  });
});

// ───────────────────────────── §5.4 回补 vs 回环 ─────────────────────────────

describe('§5.4 回补与回环的区分', () => {
  it('回补（威胁建模 → 情报收集）不递增迭代与范围版本，但产生交接记录', () => {
    const outcome = planPhaseMove({ from: 'threat-modeling', to: 'intelligence-gathering' });
    assert.equal(outcome.ok, true);
    if (!outcome.ok) return;
    assert.equal(outcome.plan.transitionType, 'rollback');
    assert.equal(outcome.plan.requiresScopeAmendment, false);

    const plan = planTransition({ type: 'rollback', fromStatus: 'transition_confirmation', toStatus: 'worker_running' });
    assert.equal(plan.ok, true);
    if (!plan.ok) return;
    assert.equal(plan.plan.iterationDelta, 0, '回补不改变攻击深度');
    assert.equal(plan.plan.scopeVersionDelta, 0, '回补不产生新范围版本');
    assert.equal(plan.plan.writesHandoff, true);
    assert.equal(plan.plan.handoffTransitionType, 'rollback');
  });

  it('回环（后渗透 → 情报收集）递增迭代与范围版本，也产生交接记录', () => {
    const outcome = planPhaseMove({
      from: 'post-exploitation',
      to: 'intelligence-gathering',
      scopeAmendment: { completed: true, newVersion: 2 },
    });
    assert.equal(outcome.ok, true);
    if (!outcome.ok) return;
    assert.equal(outcome.plan.transitionType, 'loop');
    assert.equal(outcome.plan.requiresScopeAmendment, true);
    assert.equal(outcome.plan.scopeVersion, 2);

    const plan = planTransition({ type: 'loop', fromStatus: 'transition_confirmation', toStatus: 'worker_running' });
    assert.equal(plan.ok, true);
    if (!plan.ok) return;
    assert.equal(plan.plan.iterationDelta, 1);
    assert.equal(plan.plan.scopeVersionDelta, 1);
    assert.equal(plan.plan.writesHandoff, true);
    assert.equal(plan.plan.handoffTransitionType, 'loop');
  });

  it('回补与回环互为反例：只有 loop 递增计数（显式断言而非注释）', () => {
    const rollback = TRANSITION_DISPATCH.rollback;
    const loop = TRANSITION_DISPATCH.loop;
    assert.notDeepEqual(
      [rollback.iterationDelta, rollback.scopeVersionDelta],
      [loop.iterationDelta, loop.scopeVersionDelta],
      '回补与回环必须在计数上可区分',
    );
    assert.equal(rollback.iterationDelta, 0);
    assert.equal(loop.iterationDelta, 1);
    assert.equal(
      TRANSITION_TYPES.filter((type) => TRANSITION_DISPATCH[type].iterationDelta > 0).join(','),
      'loop',
    );
    assert.equal(
      TRANSITION_TYPES.filter((type) => TRANSITION_DISPATCH[type].scopeVersionDelta > 0).join(','),
      'loop',
    );
  });

  it('后渗透的向后推荐边都是回补：补验证与回补漏洞分析都不递增迭代', () => {
    for (const to of ['vulnerability-analysis', 'exploitation'] as const) {
      const outcome = planPhaseMove({ from: 'post-exploitation', to });
      assert.equal(outcome.ok, true);
      if (!outcome.ok) return;
      assert.equal(outcome.plan.transitionType, 'rollback', `后渗透 → ${to}`);
    }
  });

  it('回环未完成范围修订被拒 → scope_amendment_required（范围修订是硬性前置）', () => {
    assert.equal(planPhaseMove({ from: 'post-exploitation', to: 'intelligence-gathering' }).ok, false);
    assert.deepEqual(planPhaseMove({ from: 'post-exploitation', to: 'intelligence-gathering' }), {
      ok: false,
      code: 'scope_amendment_required',
      message: '回环到情报收集前必须完成范围修订并生成新的范围版本（§5.4 步骤 4、§13.7）',
    });
    const halfDone = planPhaseMove({
      from: 'post-exploitation',
      to: 'intelligence-gathering',
      scopeAmendment: { completed: true, newVersion: null },
    });
    assert.equal(halfDone.ok, false);
    if (halfDone.ok) return;
    assert.equal(halfDone.code, 'scope_amendment_required');
  });

  it('漏洞分析 → 后渗透是推荐的前向边（确认无需验证），不是强制跳转', () => {
    const outcome = planPhaseMove({ from: 'vulnerability-analysis', to: 'post-exploitation' });
    assert.equal(outcome.ok, true);
    if (!outcome.ok) return;
    assert.equal(outcome.plan.transitionType, 'advance');
    assert.equal(outcome.plan.forced, false);
    assert.deepEqual(outcome.plan.skippedPhases, ['exploitation']);
  });
});

// ───────────────────────────── §5.4 转移分派表 ─────────────────────────────

describe('§5.4 转移分派表', () => {
  it('逐行对照：取值、迭代、范围版本与交接记录', () => {
    const expected: Record<TransitionType, { iteration: 0 | 1; scope: 0 | 1; handoff: boolean }> = {
      start: { iteration: 0, scope: 0, handoff: false },
      advance: { iteration: 0, scope: 0, handoff: true },
      retry: { iteration: 0, scope: 0, handoff: true },
      rollback: { iteration: 0, scope: 0, handoff: true },
      loop: { iteration: 1, scope: 1, handoff: true },
      interject_wake: { iteration: 0, scope: 0, handoff: false },
      handoff_cancel: { iteration: 0, scope: 0, handoff: false },
      handoff_regen: { iteration: 0, scope: 0, handoff: false },
      report_reopen: { iteration: 0, scope: 0, handoff: false },
      pause: { iteration: 0, scope: 0, handoff: false },
      resume: { iteration: 0, scope: 0, handoff: false },
      abort: { iteration: 0, scope: 0, handoff: false },
      complete: { iteration: 0, scope: 0, handoff: false },
    };
    assert.deepEqual(Object.keys(TRANSITION_DISPATCH).sort(), [...TRANSITION_TYPES].sort());
    for (const type of TRANSITION_TYPES) {
      const row = TRANSITION_DISPATCH[type];
      assert.equal(row.type, type);
      assert.ok(row.operation.length > 0, type);
      assert.equal(row.iterationDelta, expected[type].iteration, type);
      assert.equal(row.scopeVersionDelta, expected[type].scope, type);
      assert.equal(row.writesHandoff, expected[type].handoff, type);
      assert.equal(row.stateVersionDelta, 1, `${type} 必须推进状态版本`);
    }
  });

  it('只有 advance / retry / loop / rollback 产生交接记录', () => {
    // 比较集合而非顺序：TRANSITION_TYPES 的排列顺序与 HANDOFF_TRANSITION_TYPES
    // 无关（前者按分派表分组，后者按语义分组），顺序差异不代表行为差异。
    const writing = TRANSITION_TYPES.filter((type) => TRANSITION_DISPATCH[type].writesHandoff);
    assert.deepEqual([...writing].sort(), [...HANDOFF_TRANSITION_TYPES].sort());
  });

  it('interject_wake / handoff_cancel / handoff_regen / report_reopen 不产生交接记录', () => {
    for (const type of ['interject_wake', 'handoff_cancel', 'handoff_regen', 'report_reopen'] as const) {
      assert.equal(TRANSITION_DISPATCH[type].writesHandoff, false, type);
      const handoffType = handoffTransitionTypeOf(type);
      assert.equal(handoffType.ok, false);
      if (handoffType.ok) return;
      assert.equal(handoffType.code, 'handoff_transition_illegal');
    }
  });

  it('重做默认复用当前会话，新建会话时仍是 retry 且计数不变', () => {
    const reused = planTransition({
      type: 'retry',
      fromStatus: 'waiting_human_review',
      toStatus: 'worker_running',
    });
    assert.equal(reused.ok, true);
    if (!reused.ok) return;
    assert.equal(reused.plan.sessionReused, true, '默认复用（§13.5）');
    assert.equal(reused.plan.iterationDelta, 0);
    assert.equal(reused.plan.scopeVersionDelta, 0);
    assert.equal(reused.plan.writesHandoff, true);

    const fresh = planTransition({
      type: 'retry',
      fromStatus: 'waiting_human_review',
      toStatus: 'worker_running',
      reuseSession: false,
    });
    assert.equal(fresh.ok, true);
    if (!fresh.ok) return;
    assert.equal(fresh.plan.type, 'retry');
    assert.equal(fresh.plan.sessionReused, false);
    assert.equal(fresh.plan.iterationDelta, 0);
    assert.equal(fresh.plan.writesHandoff, true);
  });

  it('插话唤醒复用当前会话、无交接记录、计数不变', () => {
    const plan = planTransition({
      type: 'interject_wake',
      fromStatus: 'waiting_human_review',
      toStatus: 'worker_running',
    });
    assert.equal(plan.ok, true);
    if (!plan.ok) return;
    assert.equal(plan.plan.sessionReused, true);
    assert.equal(plan.plan.writesHandoff, false);
    assert.equal(plan.plan.handoffTransitionType, null);
    assert.equal(plan.plan.iterationDelta, 0);
    assert.equal(plan.plan.scopeVersionDelta, 0);
  });

  it('分派表不变量自检通过；注入被改坏的表会逐条报错', () => {
    assertDispatchTable();
    assert.deepEqual(validateDispatchTable(), []);

    const rollbackAdvances = {
      ...TRANSITION_DISPATCH,
      rollback: { ...TRANSITION_DISPATCH.rollback, iterationDelta: 1 as const },
    };
    const handoffLeak = {
      ...TRANSITION_DISPATCH,
      interject_wake: { ...TRANSITION_DISPATCH.interject_wake, writesHandoff: true },
    };
    const missing = { ...TRANSITION_DISPATCH } as Record<string, (typeof TRANSITION_DISPATCH)[TransitionType]>;
    delete missing.loop;

    assert.deepEqual(validateDispatchTable(rollbackAdvances).map((problem) => problem.kind), [
      'iteration_not_only_loop',
      'scope_not_only_loop',
    ]);
    assert.deepEqual(validateDispatchTable(handoffLeak).map((problem) => problem.kind), ['handoff_set_mismatch']);
    assert.deepEqual(validateDispatchTable(missing).map((problem) => problem.kind), ['missing_type']);
    assert.throws(() => assertDispatchTable(rollbackAdvances), WorkflowTransitionError);
  });

  it('非法状态边与非法强制标记返回稳定错误码，未知取值抛协议错误', () => {
    const wrongEdge = planTransition({
      type: 'advance',
      fromStatus: 'ready',
      toStatus: 'worker_running',
    });
    assert.equal(wrongEdge.ok, false);
    if (wrongEdge.ok) return;
    assert.equal(wrongEdge.code, 'handoff_transition_illegal');

    // 运行标记类（pause/resume/abort）在状态图上没有边，因此不能用边校验。
    // 正确的约束是「不得改变主状态」——主状态相同时它合法（§5.1 两层状态表）。
    const markerOk = planTransition({ type: 'pause', fromStatus: 'ready', toStatus: 'ready' });
    assert.equal(markerOk.ok, true, '运行标记类不参与状态边校验');

    const markerChangesStatus = planTransition({
      type: 'pause',
      fromStatus: 'ready',
      toStatus: 'worker_running',
    });
    assert.equal(markerChangesStatus.ok, false, '运行标记不得改变主状态');
    if (markerChangesStatus.ok) return;
    assert.equal(markerChangesStatus.code, 'handoff_transition_illegal');
    assert.match(markerChangesStatus.message, /不得改变主状态/);

    const illegalForced = planTransition({
      type: 'interject_wake',
      fromStatus: 'waiting_human_review',
      toStatus: 'worker_running',
      forced: true,
    });
    assert.equal(illegalForced.ok, false);
    if (illegalForced.ok) return;
    assert.equal(illegalForced.code, 'handoff_transition_illegal');

    assert.deepEqual([...FORCEABLE_TRANSITION_TYPES], ['advance', 'rollback', 'loop']);
    assert.throws(
      () =>
        planTransition({
          type: 'not_a_type' as TransitionType,
          fromStatus: 'ready',
          toStatus: 'worker_running',
        }),
      WorkflowTransitionError,
    );
  });
});

// ───────────────────────────── §5.2 状态图 ↔ §5.4 取值 ─────────────────────────────

describe('§5.2 状态图与可记账性', () => {
  it('validateGraph() 通过，并给出图报告', () => {
    const validation = validateGraph();
    assert.equal(validation.ok, true);
    if (!validation.ok) return;
    const report = validation.report;
    assert.equal(report.edgeCount, 14);
    assert.equal(report.recordedEdgeCount + report.unrecordedEdges.length, 14);
    assert.deepEqual(report.unrecordedEdges.map((edge) => `${edge.from}→${edge.to}`), [
      'auth_pending→ready',
      'worker_running→waiting_human_review',
      'handoff_drafting→transition_confirmation',
      'worker_running→report_ready',
      'waiting_human_review→report_ready',
    ]);
    assert.deepEqual(report.derivedEdges.map((edge) => `${edge.from}→${edge.to}`), [
      'waiting_human_review→handoff_drafting',
    ]);
    assert.deepEqual(report.coveredTypes, [
      'start',
      'advance',
      'retry',
      'rollback',
      'loop',
      'interject_wake',
      'handoff_cancel',
      'handoff_regen',
      'report_reopen',
      'complete',
    ]);
    assert.deepEqual(report.typesWithoutEdge, [...RUNTIME_MARKER_TRANSITION_TYPES]);
    assert.deepEqual(assertGraph(), report);
  });

  it('§5.2 的每条边都有记账：已记账持有契约内取值，未记账给出书面理由', () => {
    for (const edge of STATE_EDGES) {
      const label = `${edge.from}→${edge.to}`;
      if (edge.recorded) {
        assert.ok(edge.transitionTypes.length > 0, `${label} 已记账却没有取值`);
      } else {
        assert.equal(edge.transitionTypes.length, 0, `${label} 未记账却有取值`);
        assert.ok(edge.note.trim().length > 0, `${label} 未记账必须给出理由，不接受静默`);
      }
      for (const type of edge.transitionTypes) {
        assert.ok((TRANSITION_TYPES as readonly string[]).includes(type), `${label} 的取值 ${type}`);
      }
    }
  });

  it('§5.4 四条人工边必须可记账，且映射到指定取值', () => {
    assert.equal(REQUIRED_ACCOUNTED_EDGES.length, 4);
    for (const required of REQUIRED_ACCOUNTED_EDGES) {
      const edge = STATE_EDGES.find((candidate) => candidate.from === required.from && candidate.to === required.to);
      assert.ok(edge !== undefined, `${required.from}→${required.to} 必须存在于图上`);
      if (edge === undefined) return;
      assert.equal(edge.recorded, true, `${required.label} 必须写 state_transitions`);
      assert.ok(edge.transitionTypes.includes(required.transitionType), required.label);
    }
    // 反向：取消交接的两条边、重新生成、报告回到运行，各自都有对应取值
    assert.deepEqual(legalTransitionTypes('handoff_drafting', 'waiting_human_review'), ['handoff_cancel']);
    assert.deepEqual(legalTransitionTypes('transition_confirmation', 'waiting_human_review'), ['handoff_cancel']);
    assert.deepEqual(legalTransitionTypes('transition_confirmation', 'handoff_drafting'), ['handoff_regen']);
    assert.deepEqual(legalTransitionTypes('report_ready', 'worker_running'), ['report_reopen']);
  });

  it('§5.2 边与取值是多对一：重做与插话唤醒共用一条边，推进/回补/回环共用一条边', () => {
    assert.deepEqual(legalTransitionTypes('waiting_human_review', 'worker_running'), ['retry', 'interject_wake']);
    assert.deepEqual(legalTransitionTypes('transition_confirmation', 'worker_running'), [
      'advance',
      'rollback',
      'loop',
    ]);
    assert.deepEqual(statusEdgesFor('retry'), [{ from: 'waiting_human_review', to: 'worker_running' }]);
    assert.deepEqual(statusEdgesFor('rollback'), [{ from: 'transition_confirmation', to: 'worker_running' }]);
    assert.deepEqual(statusEdgesFor('loop'), [{ from: 'transition_confirmation', to: 'worker_running' }]);
    assert.deepEqual(statusEdgesFor('start'), [{ from: 'ready', to: 'worker_running' }]);
  });

  it('运行标记类取值只改 runMarker，在状态图上没有边（§5.1）', () => {
    for (const type of RUNTIME_MARKER_TRANSITION_TYPES) {
      assert.deepEqual(statusEdgesFor(type), [], type);
    }
    assert.deepEqual([...RUNTIME_MARKER_TRANSITION_TYPES], ['pause', 'resume', 'abort']);
    assert.equal(isLegalStatusEdge('pause', 'worker_running', 'worker_running'), false);
  });

  it('八个主状态都从 AUTH_PENDING 可达，且终态是 COMPLETE', () => {
    const validation = validateGraph();
    assert.equal(validation.ok, true);
    const reachable = new Set<MainStatus>(['auth_pending']);
    let grew = true;
    while (grew) {
      grew = false;
      for (const edge of STATE_EDGES) {
        if (reachable.has(edge.from) && !reachable.has(edge.to)) {
          reachable.add(edge.to);
          grew = true;
        }
      }
    }
    assert.deepEqual([...reachable].sort(), [...MAIN_STATUSES].sort());
    assert.deepEqual(legalTransitionTypes('report_ready', 'complete'), ['complete']);
    assert.equal(
      STATE_EDGES.some((edge) => edge.from === 'complete'),
      false,
      'COMPLETE 是终态，没有出边',
    );
  });

  it('图被改坏时不静默：重复边、未知取值、缺必需边、缺理由都报错', () => {
    const duplicate: StateEdge[] = [
      ...STATE_EDGES,
      { ...STATE_EDGES[1]!, note: '' },
    ];
    const duplicateValidation = validateGraph(duplicate);
    assert.equal(duplicateValidation.ok, false);
    if (duplicateValidation.ok) return;
    assert.equal(duplicateValidation.code, 'handoff_transition_illegal');
    assert.deepEqual(duplicateValidation.problems.map((problem) => problem.kind), ['duplicate_edge']);

    const bogusType: StateEdge[] = STATE_EDGES.map((edge) =>
      edge.from === 'report_ready' && edge.to === 'complete'
        ? { ...edge, transitionTypes: [...edge.transitionTypes, 'not_a_type' as TransitionType] }
        : edge,
    );
    const bogusValidation = validateGraph(bogusType);
    assert.equal(bogusValidation.ok, false);
    if (bogusValidation.ok) return;
    assert.deepEqual(bogusValidation.problems.map((problem) => problem.kind), ['unknown_transition_type']);

    const missingReportReopen = STATE_EDGES.filter(
      (edge) => !(edge.from === 'report_ready' && edge.to === 'worker_running'),
    );
    const missingValidation = validateGraph(missingReportReopen);
    assert.equal(missingValidation.ok, false);
    if (missingValidation.ok) return;
    // 移除该边后 worker_running 仍可从别处到达（ready / waiting_human_review），
    // 因此不会产生 unreachable_status；真正暴露的是两件事：
    //   1. §5.4 点名的人工边缺失
    //   2. report_reopen 这个转移类型不再有任何边承载
    assert.deepEqual(missingValidation.problems.map((problem) => problem.kind), [
      'missing_required_edge',
      'unexpected_type_without_edge',
    ]);

    const silentGap: StateEdge[] = STATE_EDGES.map((edge) =>
      !edge.recorded && edge.from === 'auth_pending' ? { ...edge, note: '  ' } : edge,
    );
    const silentValidation = validateGraph(silentGap);
    assert.equal(silentValidation.ok, false);
    if (silentValidation.ok) return;
    assert.deepEqual(silentValidation.problems.map((problem) => problem.kind), ['unrecorded_edge_without_note']);

    assert.throws(() => assertGraph(duplicate), /状态图校验失败/);
  });
});

// ───────────────────────────── §5.1 两层状态 ─────────────────────────────

describe('§5.1 主状态与运行标记分离', () => {
  it('暂停不改写主状态与阶段', () => {
    const running = { mainStatus: 'worker_running', runMarker: 'running', currentPhase: 'exploitation' } as const;
    const paused = applyRunMarker(running, 'paused');
    assert.equal(paused.runMarker, 'paused');
    assert.equal(paused.mainStatus, 'worker_running');
    assert.equal(paused.currentPhase, 'exploitation');
  });

  it('暂停后恢复回到原先的主状态', () => {
    const original = { mainStatus: 'waiting_human_review', runMarker: 'running', currentPhase: 'exploitation' } as const;
    const resumed = clearRunMarker(applyRunMarker(original, 'paused'));
    assert.equal(resumed.mainStatus, original.mainStatus);
    assert.equal(resumed.currentPhase, original.currentPhase);
    assert.equal(resumed.runMarker, 'running');
    assert.deepEqual(resumed, original);
  });

  it('五种运行标记都不触碰主状态', () => {
    const base = { mainStatus: 'transition_confirmation', runMarker: 'running', currentPhase: 'threat-modeling' } as const;
    for (const marker of RUN_MARKERS) {
      const marked = applyRunMarker(base, marker);
      assert.equal(marked.mainStatus, 'transition_confirmation', marker);
      assert.equal(marked.currentPhase, 'threat-modeling', marker);
      assert.equal(clearRunMarker(marked).runMarker, 'running', marker);
    }
  });

  it('八个主状态都能在恢复后保持（暂停与主状态无关）', () => {
    for (const mainStatus of MAIN_STATUSES) {
      const state = { mainStatus, runMarker: 'paused' } as const;
      assert.deepEqual(clearRunMarker(state), { mainStatus, runMarker: 'running' });
    }
  });

  it('运行标记写操作不修改原对象（纯函数）', () => {
    const state = { mainStatus: 'worker_running', runMarker: 'running' } as const;
    const paused = applyRunMarker(state, 'paused');
    assert.notEqual(paused, state);
    assert.equal(state.runMarker, 'running');
    assert.equal(paused.runMarker, 'paused');
  });
});
