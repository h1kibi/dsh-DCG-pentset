/**
 * 对账与恢复的测试。
 *
 * 重点锁定三条纪律（不是测「函数返回什么」）：
 *   1. 副作用未知的动作**不自动重放** —— 幻想式重试在渗透场景等于再打一次目标
 *   2. 过期凭证**不复活** —— 否则把过期授权当有效授权
 *   3. 高危阶段的崩溃恢复**必须人类重新确认** —— 可能已在目标上留下痕迹
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  reconcileSession,
  reconcileEngagement,
  reconcileApproval,
  executionGateForAudit,
  isHighRiskPhase,
  HIGH_RISK_PHASES,
} from '../src/workflow/reconcile.ts';
import type { SessionReconciliationInput, ApprovalReconciliationInput } from '../src/workflow/reconcile.ts';
import type { Phase } from '../src/contracts.ts';

function session(over: Partial<SessionReconciliationInput> = {}): SessionReconciliationInput {
  return {
    workerSessionId: 's1',
    dshSessionId: 'dsh-s1',
    phase: 'intelligence-gathering',
    status: 'active',
    attempt: 1,
    hasActiveLease: true,
    leaseExpired: false,
    dshSessionReachable: true,
    hasUnfinishedToolRuns: false,
    startedAt: '2026-01-01T00:00:00Z',
    ...over,
  };
}

// ───────────────────── 创建窗口内崩溃 ─────────────────────

test('停在 starting：按已中断对账，不假装已完成', () => {
  const r = reconcileSession(session({ status: 'starting', dshSessionReachable: false }));
  assert.equal(r.action.kind, 'mark_interrupted');
  assert.equal(r.blocksProgress, true);
  if (r.action.kind !== 'mark_interrupted') return;
  assert.match(r.action.reason, /按已中断对账/);
});

test('停在 starting 但 dsh 会话存在：仍按已中断，因为无法证明它开始了工作', () => {
  const r = reconcileSession(session({ status: 'starting', dshSessionReachable: true }));
  assert.equal(r.action.kind, 'mark_interrupted');
  if (r.action.kind !== 'mark_interrupted') return;
  assert.match(r.action.reason, /回写未完成/);
});

test('停在 starting 且有未结束的工具执行：仍判已中断，但必须点明未知副作用', () => {
  // 会话从没创建成功就是死的，留着它不动正是本模块要消除的「半空状态」。
  // 未结算的工具执行是**另一个独立问题**（副作用未知），由工具执行自己的
  // 规则处理：标记 unknown 并阻塞 engagement。
  const r = reconcileSession(
    session({ status: 'starting', hasUnfinishedToolRuns: true, dshSessionReachable: true }),
  );
  assert.equal(r.action.kind, 'mark_interrupted', '死会话必须被对账，不被别的信号掩盖');
  if (r.action.kind !== 'mark_interrupted') return;
  assert.match(r.action.reason, /按已中断对账/);
  assert.match(r.action.reason, /副作用是否已作用于目标未知/, '未知副作用必须点明，不能吞掉');
});

// ───────────────────── 不自动重放有副作用的动作 ─────────────────────

test('存在未结束的工具执行：标记为需人工核查，且理由点名不自动重放', () => {
  const r = reconcileSession(session({ status: 'active', hasUnfinishedToolRuns: true }));
  assert.equal(r.action.kind, 'requires_human_reconfirmation');
  if (r.action.kind !== 'requires_human_reconfirmation') return;
  assert.match(r.action.reason, /不自动重放有副作用的动作/);
  assert.match(r.action.reason, /intro|interrupted|unknown/i);
});

test('未结束工具执行优先于租约过期判定（副作用风险更高）', () => {
  const r = reconcileSession(
    session({ status: 'active', hasUnfinishedToolRuns: true, leaseExpired: true }),
  );
  assert.equal(
    r.action.kind,
    'requires_human_reconfirmation',
    '有未知副作用时必须先人工核查，不能只当作过期处理',
  );
});

// ───────────────────── 高危阶段的重新确认 ─────────────────────

test('高危阶段集合只含利用验证与后渗透', () => {
  assert.deepEqual([...HIGH_RISK_PHASES], ['exploitation', 'post-exploitation']);
  for (const p of ['intelligence-gathering', 'threat-modeling', 'vulnerability-analysis'] as Phase[]) {
    assert.equal(isHighRiskPhase(p), false, `${p} 是只读或分析阶段，崩溃后重跑不改变目标状态`);
  }
});

test('高危阶段 + 存活会话：必须人类重新确认，不自动继续', () => {
  for (const phase of HIGH_RISK_PHASES) {
    const r = reconcileSession(session({ phase, status: 'active' }));
    assert.equal(r.action.kind, 'requires_human_reconfirmation', phase);
    assert.equal(r.blocksProgress, true);
    if (r.action.kind !== 'requires_human_reconfirmation') continue;
    assert.match(r.action.reason, /可能在目标上留下痕迹/);
    assert.match(r.action.reason, /不得在状态未知的旧会话上继续/);
  }
});

test('高危阶段 + blocked 同样需要重新确认', () => {
  const r = reconcileSession(session({ phase: 'post-exploitation', status: 'blocked' }));
  assert.equal(r.action.kind, 'requires_human_reconfirmation');
});

// ───────────────────── 等待人工判断不受崩溃影响 ─────────────────────

test('等待人工判断的会话：崩溃不改变它，人类可照常决策', () => {
  const r = reconcileSession(session({ status: 'waiting_human' }));
  assert.equal(r.action.kind, 'resume');
  assert.equal(r.blocksProgress, false);
  if (r.action.kind !== 'resume') return;
  assert.match(r.action.reason, /本来就在等人|不改变该状态/);
});

test('等待人工判断 + 有未结束工具执行：不阻塞，但理由必须点明未知副作用', () => {
  const r = reconcileSession(session({ status: 'waiting_human', hasUnfinishedToolRuns: true }));
  assert.equal(r.action.kind, 'resume', '他本来就要决策，不必额外阻塞');
  assert.equal(r.blocksProgress, false);
  if (r.action.kind !== 'resume') return;
  // 但不能静默隐藏——人类看报告时正是告知的时机
  assert.match(r.action.reason, /副作用未知/);
  assert.match(r.action.reason, /请人工核查/);
});

// ───────────────────── 过期凭证不复活 ─────────────────────

test('租约过期 + 会话可达：不终止会话，但必须点明放行凭证已失效', () => {
  // 这条顺序是刻意的：§15.2 的恢复路径第一句就是「dsh 会恢复顶层会话」，
  // 而重启后租约很可能已过期。若让租约过期先胜出，正常的恢复会被误判为终止。
  const r = reconcileSession(session({ leaseExpired: true, dshSessionReachable: true }));
  assert.equal(r.action.kind, 'resume', '会话可用，不该被终止');
  assert.equal(r.blocksProgress, false, '这是常规决策点，不是安全闸门');
  if (r.action.kind !== 'resume') return;
  assert.match(r.action.reason, /过期凭证不复活/, '过期凭证仍不得复活');
  assert.match(r.action.reason, /放行凭证已一并失效/);
  assert.match(r.action.reason, /重新申请/);
});

test('不自动续签租约：恢复不复活过期凭证（§15.2）', () => {
  const r = reconcileSession(session({ leaseExpired: true }));
  assert.equal(r.action.kind, 'resume');
  if (r.action.kind !== 'resume') return;
  assert.match(
    r.action.reason,
    /请人工决定/,
    '恢复只报告事实，续签决定权在人类——自动续签等于让过期凭证复活',
  );
});

test('dsh 侧不可达：按已中断对账（库里有记录但实际不存在）', () => {
  const r = reconcileSession(session({ dshSessionReachable: false }));
  assert.equal(r.action.kind, 'mark_interrupted');
  if (r.action.kind !== 'mark_interrupted') return;
  assert.match(r.action.reason, /库里有记录但实际不存在/);
});

test('不可达优先于租约过期（会话真没了才是终止理由）', () => {
  const r = reconcileSession(session({ dshSessionReachable: false, leaseExpired: true }));
  assert.equal(r.action.kind, 'mark_interrupted');
  if (r.action.kind !== 'mark_interrupted') return;
  assert.match(r.action.reason, /不可达/);
});

test('存活且可达：对账通过，不阻塞推进', () => {
  const r = reconcileSession(session());
  assert.equal(r.action.kind, 'resume');
  assert.equal(r.blocksProgress, false);
});

// ───────────────────── 整段 engagement 的结论 ─────────────────────

test('任一结论需人工处置即阻塞推进，且列出待确认的会话', () => {
  const result = reconcileEngagement('e1', [
    session({ workerSessionId: 'ok' }),
    session({ workerSessionId: 'risky', phase: 'exploitation' }),
    session({ workerSessionId: 'stuck', status: 'starting', dshSessionReachable: false }),
  ]);
  assert.equal(result.engagementId, 'e1');
  assert.equal(result.blocksProgress, true);
  assert.deepEqual(result.requiresHumanReconfirmation, ['risky']);
  assert.equal(result.sessions.length, 3);
});

test('全部正常时不阻塞', () => {
  const result = reconcileEngagement('e2', [session(), session({ workerSessionId: 's2', status: 'waiting_human' })]);
  assert.equal(result.blocksProgress, false);
  assert.deepEqual(result.requiresHumanReconfirmation, []);
});

// ───────────────────── 放行凭证对账 ─────────────────────

function approval(over: Partial<ApprovalReconciliationInput> = {}): ApprovalReconciliationInput {
  return {
    approvalId: 'a1',
    decision: 'approved',
    consumedAt: null,
    expiresAt: '2026-01-01T01:00:00Z',
    leaseActive: true,
    now: '2026-01-01T00:30:00Z',
    ...over,
  };
}

test('已消费的凭证保持不动（幂等重放依赖它）', () => {
  const r = reconcileApproval(approval({ consumedAt: '2026-01-01T00:10:00Z' }));
  assert.equal(r.kind, 'already_consumed');
});

test('已消费优先于过期与租约判定：终态不再被改写', () => {
  const r = reconcileApproval(
    approval({ consumedAt: '2026-01-01T00:10:00Z', leaseActive: false, expiresAt: '2026-01-01T00:05:00Z' }),
  );
  assert.equal(r.kind, 'already_consumed');
});

test('租约失效 → 吊销（其下凭证一并失效）', () => {
  const r = reconcileApproval(approval({ leaseActive: false }));
  assert.equal(r.kind, 'revoke');
  if (r.kind !== 'revoke') return;
  assert.match(r.reason, /租约已失效/);
});

test('租约吊销优先于「还没过期」：吊销的语义更强', () => {
  const r = reconcileApproval(approval({ leaseActive: false, expiresAt: '2026-01-01T23:00:00Z' }));
  assert.equal(r.kind, 'revoke');
});

test('已过期 → 标记 expired，不复活', () => {
  const r = reconcileApproval(approval({ expiresAt: '2026-01-01T00:00:00Z' }));
  assert.equal(r.kind, 'expire');
  if (r.kind !== 'expire') return;
  assert.match(r.reason, /过期凭证不复活/);
});

test('过期判定含边界：expiresAt === now 即已过期', () => {
  const r = reconcileApproval(approval({ expiresAt: '2026-01-01T00:30:00Z' }));
  assert.equal(r.kind, 'expire', '闭区间：等于到期时刻即失效');
});

test('租约有效且未过期 → 保持可用', () => {
  assert.equal(reconcileApproval(approval()).kind, 'keep');
});

test('无到期时间的凭证在有租约时保持可用', () => {
  assert.equal(reconcileApproval(approval({ expiresAt: null })).kind, 'keep');
});

// ───────────────────── 审计不可用时的门槛 ─────────────────────

test('审计不可写：所有触及目标的动作一律停止，不按风险分类挑拣', () => {
  const gate = executionGateForAudit({ writable: false, detail: '连接池耗尽' });
  assert.equal(gate.allowed, false);
  assert.match(gate.reason, /所有触及目标的动作一律停止/);
  assert.match(gate.reason, /不按风险分类挑拣/);
  assert.match(gate.reason, /连接池耗尽/, '理由带具体原因，便于运维定位');
});

test('审计可写：放行', () => {
  assert.equal(executionGateForAudit({ writable: true, detail: '' }).allowed, true);
});
