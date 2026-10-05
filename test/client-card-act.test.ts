/**
 * 聊天卡片的确认/驳回：版本号必须来自**服务端刚给的那份状态**。
 *
 * ── 回归的是哪一个实测缺陷 ──
 *
 * 卡片用的是**会话级**控制器（`conversation.chat.turnTail` 槽位注入的那个），
 * 它从未 `select()` 过作业，`#snapshot.state` 恒为 null。而 `mutate()` 取
 * `#snapshot.state?.stateVersion ?? 0` —— 于是卡片恒定发 `expectedStateVersion: 0`，
 * 而作业在方案提交后早已是 1。人类的体感是：点「确认」永远得到
 * 「状态版本不匹配：期望 0，实际 1。请刷新后重试。」
 *
 * 因此这里锁两件事：
 *   1. 第一次确认用的是**调用方（卡片）给的服务端版本**，不是快照兜底的 0；
 *   2. 版本真的过期时，**重读状态再试一次**——且这一次重试复用同一个幂等键
 *      （它是「同一次点击的重试」，不是新操作）。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { ConsoleController } from '../src/client/controller.ts';
import type { HostRpcResult } from '../src/console/rpc.ts';

const NOW = new Date('2026-10-03T00:00:00.000Z');

interface SentCall {
  readonly method: string;
  readonly version: unknown;
  readonly key: unknown;
}

/** 记录每次请求的方法/版本/幂等键，并按需伪造 stale 与状态读。 */
function makeController(handlers: {
  readonly onConfirm?: (attempt: number) => HostRpcResult;
  readonly status?: HostRpcResult;
  readonly getState?: HostRpcResult;
  readonly listWorkerSessions?: HostRpcResult;
}): { controller: ConsoleController; sent: SentCall[] } {
  const sent: SentCall[] = [];
  const invoke = async (_channel: string, endpoint: string, payload: unknown): Promise<HostRpcResult> => {
    const request = (payload as {
      args: { request: { method: string; expectedStateVersion?: unknown; idempotencyKey?: unknown } };
    }).args.request;
    const method = endpoint.split('/').at(-1) ?? request.method;
    sent.push({ method, version: request.expectedStateVersion, key: request.idempotencyKey });
    if (method === 'confirmScopeProposal') {
      const attempt = sent.filter((s) => s.method === 'confirmScopeProposal').length;
      return (handlers.onConfirm ?? (() => ({ ok: true, value: { engagementId: 'e-1' } })))(attempt);
    }
    if (method === 'getIntakeStatus') {
      return handlers.status ?? { ok: true, value: null };
    }
    if (method === 'getState') {
      return handlers.getState ?? { ok: true, value: { activeWorkerSessionId: null, mainStatus: 'ready', currentPhase: null } };
    }
    if (method === 'listWorkerSessions') {
      return handlers.listWorkerSessions ?? { ok: true, value: [] };
    }
    return { ok: true, value: {} };
  };
  return { controller: new ConsoleController({ invoke, clock: () => NOW }), sent };
}

function stale(message = '状态版本不匹配：期望 0，实际 1。请刷新后重试。'): HostRpcResult {
  return { ok: false, error: { code: 'stale_state_version', message, details: {} } };
}

function statusWithVersion(stateVersion: number): HostRpcResult {
  return {
    ok: true,
    value: {
      engagementId: 'e-1',
      engagementName: '47.109.76.66:3002 授权渗透测试',
      workerSessionId: 'w-1',
      sessionKind: 'intake',
      mainStatus: 'auth_pending',
      pendingProposal: { id: 'p-1' },
      pendingApprovalCount: 0,
      stateVersion,
    },
  };
}

const CONFIRM_INPUT = {
  engagementId: 'e-1',
  proposalId: 'p-1',
  objective: '对 3002 做授权测试',
  targets: [],
  exclusions: [],
  allowedActions: [],
  authorizationNote: '资产所有人授权',
  // 行为预设与审批模式都是必选项（2026-10-05 起）：卡片必须把它们一起发出去。
  behaviorProfile: 'stealth',
  approvalMode: 'human',
  reason: '在会话内确认范围方案（§13.1 人类闸门）',
} as const;

test('卡片确认用服务端给的版本号（不是快照兜底的 0）', async () => {
  const { controller, sent } = makeController({});
  const result = await controller.confirmScopeProposalFromCard({
    ...CONFIRM_INPUT,
    dshSessionId: 'session-x',
    expectedStateVersion: 3,
  });
  assert.equal(result.ok, true);
  const confirms = sent.filter((s) => s.method === 'confirmScopeProposal');
  assert.equal(confirms.length, 1, '版本没变时不该重试');
  assert.equal(confirms[0]?.version, 3, '必须原样使用调用方（卡片）给的服务端版本');
});

test('版本过期时重读状态再试一次，且复用同一个幂等键', async () => {
  const { controller, sent } = makeController({
    // 第一次以过期版本被拒，第二次成功——正是并发人类操作下的真实序列。
    onConfirm: (attempt) => (attempt === 1 ? stale() : { ok: true, value: { engagementId: 'e-1' } }),
    status: statusWithVersion(9),
  });
  const result = await controller.confirmScopeProposalFromCard({
    ...CONFIRM_INPUT,
    dshSessionId: 'session-x',
    expectedStateVersion: 1,
  });

  assert.equal(result.ok, true, '重读拿到新版本后必须成功，而不是把人类挡在「请刷新后重试」');
  const confirms = sent.filter((s) => s.method === 'confirmScopeProposal');
  assert.equal(confirms.length, 2, '必须恰好重试一次');
  assert.equal(confirms[0]?.version, 1);
  assert.equal(confirms[1]?.version, 9, '第二次必须用重读到的版本');
  assert.equal(
    confirms[0]?.key,
    confirms[1]?.key,
    '同一次点击的重试必须复用幂等键（§15.3）——换了键就等于新操作',
  );
  assert.equal(sent.filter((s) => s.method === 'getIntakeStatus').length, 1, '只重读一次状态');
});

test('运行快照认的是**活动指针**指向的那个会话（不是列表里随便一个）', async () => {
  // 这张快照决定「阶段推进后界面跟到哪个会话」。挑错了会话 = 人类被切到一个无关的会话，
  // 或者根本切不动——两者都比不切更糟。
  const { controller } = makeController({
    getState: {
      ok: true,
      value: { activeWorkerSessionId: 'w-phase', mainStatus: 'worker_running', currentPhase: 'exploitation' },
    },
    listWorkerSessions: {
      ok: true,
      value: [
        { id: 'w-intake', dshSessionId: 'dsh-intake', status: 'closed', phase: 'intelligence-gathering', statusNote: null },
        { id: 'w-phase', dshSessionId: 'dsh-phase', status: 'active', phase: 'exploitation', statusNote: '正在做被动指纹识别' },
      ],
    },
  });

  const snapshot = await controller.runningSnapshotFor('e-1');
  assert.equal(snapshot?.mainStatus, 'worker_running');
  assert.equal(snapshot?.currentPhase, 'exploitation');
  assert.equal(snapshot?.active?.dshSessionId, 'dsh-phase', '必须挑活动指针指向的那个会话');
  assert.equal(snapshot?.active?.statusNote, '正在做被动指纹识别', '状态便签是「它确实在干活」的证据');

  // 指针为空 = 没有活动会话（而不是「列表里第一个」）。
  const idle = makeController({
    getState: { ok: true, value: { activeWorkerSessionId: null, mainStatus: 'ready', currentPhase: null } },
    listWorkerSessions: { ok: true, value: [{ id: 'w-old', dshSessionId: 'dsh-old', status: 'closed', phase: 'intelligence-gathering', statusNote: null }] },
  });
  assert.equal((await idle.controller.runningSnapshotFor('e-1'))?.active, null, '没有活动指针时不得挑一个凑数');

  // 读失败 → null（不跟随、也不画状态卡）。
  const broken = makeController({ getState: { ok: false, error: { code: 'console/internal', message: 'boom', details: {} } } });
  assert.equal(await broken.controller.runningSnapshotFor('e-1'), null);
});

test('非版本类失败不重试（分类拒绝、方案已处理等原样交给人类）', async () => {
  const { controller, sent } = makeController({
    onConfirm: () => ({ ok: false, error: { code: 'classification_rejected', message: '方案已被处理', details: {} } }),
    status: statusWithVersion(9),
  });
  const result = await controller.confirmScopeProposalFromCard({
    ...CONFIRM_INPUT,
    dshSessionId: 'session-x',
    expectedStateVersion: 1,
  });

  assert.equal(result.ok, false);
  assert.equal(result.ok ? null : result.code, 'classification_rejected');
  assert.equal(sent.filter((s) => s.method === 'confirmScopeProposal').length, 1, '不该重试非版本类失败');
  assert.equal(sent.filter((s) => s.method === 'getIntakeStatus').length, 0, '更不该白读一次状态');
});

test('过期后方案已不在：不再重试，如实返回失败', async () => {
  const { controller, sent } = makeController({
    onConfirm: () => stale(),
    status: {
      ok: true,
      value: {
        engagementId: 'e-1',
        engagementName: 'x',
        workerSessionId: 'w-1',
        sessionKind: 'intake',
        mainStatus: 'ready',
        pendingProposal: null,
        pendingApprovalCount: 0,
        stateVersion: 9,
      },
    },
  });
  const result = await controller.confirmScopeProposalFromCard({
    ...CONFIRM_INPUT,
    dshSessionId: 'session-x',
    expectedStateVersion: 1,
  });

  assert.equal(result.ok, false, '方案没了就必须失败（不能拿旧参数去确认别的东西）');
  assert.equal(sent.filter((s) => s.method === 'confirmScopeProposal').length, 1);
});
