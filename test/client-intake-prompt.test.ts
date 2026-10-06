/**
 * 会话内「待你确认」卡片的推导逻辑（§6.2.0.5、§13.1）。
 *
 * 这张卡片此前不存在：Agent 在聊天里说「到控制台确认」，而人类所在的界面没有可点的东西。
 * 锁住的是**什么时候该画、画什么**——这两件事错了都会让人类闸门失效：
 *
 *   - 没有待办却画卡片（噪音）；
 *   - 状态读不到却画成「没有待办」（把失败说成事实）；
 *   - 目标/动作显示成别的东西（人类会照着它确认）。
 *
 * 渲染与交互本身不做断言（那由 `verify:client` 的 bundle 校验兜底）。
 */

import { test } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import assert from 'node:assert/strict';

import type { IntakeStatus, ScopeProposal, ScopeTarget } from '../src/contracts.ts';
import {
  AdvanceAction,
  PhaseStrip,
  followPlan,
  followUntilSettled,
  intakePromptFacts,
  lastTurnOf,
  markSessionFollowed,
  shouldFollowActiveSession,
  turnTailVisible,
  IntakePrompt,
} from '../src/client/views/IntakePrompt.tsx';

const TARGET: ScopeTarget = {
  kind: 'ip',
  value: '47.109.76.66',
  protocols: ['tcp'],
  ports: [{ from: 3002, to: 3002 }],
};
const EXCLUSION: ScopeTarget = {
  kind: 'cidr',
  value: '10.0.0.0/24',
  protocols: ['tcp'],
  ports: [],
};
const PROPOSAL: ScopeProposal = {
  id: 'p-1',
  engagementId: 'e-1',
  workerSessionId: 'w-1',
  objective: '对 3002 端口做授权安全测试',
  targets: [TARGET],
  exclusions: [EXCLUSION],
  allowedActions: ['passive_collection', 'active_probing'],
  authorizationNote: '用户在会话中声明该资产属于自己并授权测试',
  status: 'pending',
  createdAt: '2026-10-03T00:00:00.000Z',
  decidedAt: null,
};

function status(over: Partial<IntakeStatus> = {}): IntakeStatus {
  return {
    engagementId: 'e-1',
    engagementName: '47.109.76.66 授权测试',
    workerSessionId: 'w-1',
    sessionKind: 'intake',
    mainStatus: 'auth_pending',
    pendingProposal: PROPOSAL,
    pendingApprovalCount: 0,
    stateVersion: 1,
    ...over,
  };
}

test('读不到状态时不画卡片（不能把失败说成「没有待办」）', () => {
  assert.equal(intakePromptFacts(null), null);
  assert.equal(intakePromptFacts(status({ engagementId: null })), null, '会话不归属本作业时不画');
});

test('没有待办时不画卡片（常驻空卡片是噪音）', () => {
  assert.equal(intakePromptFacts(status({ pendingProposal: null, pendingApprovalCount: 0 })), null);
});

test('有方案时给出服务端事实：目标行、允许动作、授权说明', () => {
  const facts = intakePromptFacts(status());
  assert.ok(facts !== null);
  assert.equal(facts.hasProposal, true);
  assert.equal(facts.hasApprovals, false);
  // 目标行必须由**服务端给的结构**直接翻译（人类可读的形状，不是裸字段清单），
  // 不做二次规范化：客户端没有范围引擎，任何"顺手规范一下"都会与服务端分叉。
  assert.deepEqual(facts.targetLines, ['IP 47.109.76.66 · TCP 3002']);
  assert.deepEqual(facts.exclusionLines, ['网段 10.0.0.0/24 · TCP 默认端口']);
  // 动作类别按人类标签展示（`Passive Collection`），不是契约里的枚举名——这行字是给人核对的。
  // 标签的唯一出处是 `policy/action-class-labels.ts`（客户端与提示词共用同一份）。
  assert.deepEqual(facts.allowedActions, ['Passive Collection', 'Active Probing']);
  assert.equal(facts.engagementName, '47.109.76.66 授权测试');
  assert.equal(facts.proposal?.id, 'p-1');
});

test('只有放行待办时也要给入口（但不展示方案）', () => {
  const facts = intakePromptFacts(status({ pendingProposal: null, pendingApprovalCount: 3 }));
  assert.ok(facts !== null);
  assert.equal(facts.hasProposal, false, '没有方案就不能画「待确认方案」');
  assert.equal(facts.hasApprovals, true);
  assert.equal(facts.approvalCount, 3);
  assert.deepEqual(facts.targetLines, [], '没有方案就没有目标行');
});

test('跟随会话：落定就停手、被切回就重试、一直不落定也只试有限次', () => {
  // 实测背景：导航调用确实改到了活 store，但 ~1 秒后会被应用侧切回旧会话。
  // 这个机制用**渲染器报告的当前会话**判断是否落定，未落定才补下一次。
  const run = (settleWhen: (attempt: number) => boolean, attempts = 3): { opens: number; scheduled: number } => {
    let opens = 0;
    let scheduled = 0;
    let attempt = 0;
    let settled = false;
    followUntilSettled({
      target: 'dsh-target',
      open: (target) => {
        opens += 1;
        attempt += 1;
        settled = settleWhen(attempt) && target === 'dsh-target';
      },
      current: () => (settled ? 'dsh-target' : 'session-old'),
      delayMs: 700,
      attempts,
      schedule: (work) => {
        scheduled += 1;
        work(); // 立即执行：测试里不需要真实等待
      },
    });
    return { opens, scheduled };
  };

  // `scheduled` 数的是**检查次数**（每次打开后排一次核对），不是重试次数。
  assert.deepEqual(run(() => true), { opens: 1, scheduled: 1 }, '第一次就落定 ⇒ 只排一次核对，不再打开');
  assert.deepEqual(run((attempt) => attempt >= 2), { opens: 2, scheduled: 2 }, '被切回一次 ⇒ 再打开一次后落定');
  assert.deepEqual(
    run(() => false),
    { opens: 3, scheduled: 2 },
    '一直不落定 ⇒ 恰好 attempts 次（有限、不无限重试）',
  );
  assert.deepEqual(
    run(() => false, 1),
    { opens: 1, scheduled: 0 },
    'attempts=1 也不能变成死循环',
  );
});

test('跟随计划：目标会话住在别的（未连上的）工作区时，必须先连工作区', () => {
  // 实测踩过：Worker 会话在独立工作区（`sessionCwd`），那个工作区没被连上时
  // 它的会话不在客户端列表里，`sessions.select` 抛 `unknown session`，
  // 于是跟随变成静默空操作——界面纹丝不动，看起来像「没实现」。
  const workspaces = [
    { workspaceId: 'ws-main', sessionIds: ['session-a'] },
    { workspaceId: 'ws-pentest', sessionIds: ['dsh-phase-1', 'dsh-phase-2'] },
  ];

  assert.deepEqual(
    followPlan({ target: 'dsh-phase-1', workspaces }),
    { workspaceId: 'ws-pentest' },
    '在某个工作区名下 ⇒ 先连它，再选中（否则 select 不认）',
  );
  assert.deepEqual(
    followPlan({ target: 'session-a', workspaces }),
    { workspaceId: 'ws-main' },
    '已连上的工作区同样走这条路：幂等且顺序正确',
  );
  assert.deepEqual(
    followPlan({ target: 'session-unknown', workspaces }),
    { workspaceId: null },
    '列表里找不到归属 ⇒ 直接选中（可能它本来就在已加载的工作区里）',
  );
  assert.equal(followPlan({ target: '', workspaces }), null, '空目标什么都不做');
});

test('阶段推进要跟着切会话：单次跟随、不抢焦点、不往死会话跳', () => {
  // 一阶段一会话：范围确认与每次阶段交接，Agent 都在新会话里跑。
  // 不跟随 = 人类看到的永远是一片空白（这条是用户明确提出的要求）。
  const at = (active: { dshSessionId: string; status: string } | null, current = 'session-old', engagementId = 'e-follow-1') =>
    shouldFollowActiveSession({
      engagementId,
      currentSessionId: current,
      active: active as { dshSessionId: string; status: never } | null,
    });

  assert.equal(at(null), null, '没有活动会话时无处可跟');
  assert.equal(
    at({ dshSessionId: 'session-old', status: 'active' }),
    null,
    '已经在这个会话里就不动（否则自己切自己）',
  );
  assert.equal(
    at({ dshSessionId: 'dsh-dead', status: 'closed' }),
    null,
    '目标会话已结束：切过去只会得到空页面',
  );
  assert.equal(at({ dshSessionId: 'dsh-dead2', status: 'failed' }), null);

  // 正常推进：跟随一次。
  assert.equal(at({ dshSessionId: 'dsh-phase-1', status: 'active' }), 'dsh-phase-1');
  markSessionFollowed('e-follow-1', 'dsh-phase-1');
  assert.equal(
    at({ dshSessionId: 'dsh-phase-1', status: 'active' }),
    null,
    '同一段工作只跟随一次：人类手动翻回旧会话时不该被反复拽走',
  );

  // 下一次阶段交接（新会话）必须再跟随。
  assert.equal(
    at({ dshSessionId: 'dsh-phase-2', status: 'waiting_human' }, 'dsh-phase-1'),
    'dsh-phase-2',
    '换到下一个 Agent 会话时要再跟一次',
  );
});

test('范围确认之后：没有待办也要给状态（否则 intake 页一片空白，像「没启动」）', () => {
  // 实测现象：人类点完确认后仍停在 intake 会话页，而工作在**另一个 dsh 会话**里进行，
  // 那一页什么都不画 → 被当成「我提交了但 Agent 没启动」。
  const running = intakePromptFacts(status({
    pendingProposal: null,
    pendingApprovalCount: 0,
    mainStatus: 'worker_running',
  }));
  assert.ok(running !== null, '作业已推进时必须给出状态卡的事实，而不是 null（null = 不画任何东西）');
  assert.equal(running.hasProposal, false);
  assert.equal(running.mainStatus, 'worker_running', '主状态决定卡片标题说「运行中」还是「等你判断」');

  // 仍在等范围提交/确认 ⇒ 确实没有可做的事，不画（避免常驻噪音）。
  const waiting = intakePromptFacts(status({ pendingProposal: null, pendingApprovalCount: 0, mainStatus: 'auth_pending' }));
  assert.equal(waiting, null, '还在等范围时不该画卡片');

  // 读不到状态 ⇒ 同样不画（那是「不知道」，不是「运行中」）。
  assert.equal(intakePromptFacts(null), null);
});

test('卡片事实必须带上服务端的 state_version（否则确认必然以 stale 失败）', () => {
  // 会话级控制器没有控制台那份作业快照，版本只能由服务端随状态给。
  // 实测回归：卡片恒发 expectedStateVersion 0，而作业早已是 1 → 人类点「确认」只看到
  // 「状态版本不匹配：期望 0，实际 1。请刷新后重试。」
  const facts = intakePromptFacts(status({ stateVersion: 7 }));
  assert.ok(facts !== null);
  assert.equal(facts.stateVersion, 7, '版本号必须原样透传，不能回落到 0');

  const withoutProposal = intakePromptFacts(status({ pendingProposal: null, pendingApprovalCount: 2, stateVersion: 3 }));
  assert.equal(withoutProposal?.stateVersion, 3, '只有放行待办时同样要带上版本号');
});

test('待办只挂在最新一轮 AI 消息后面（每个完成轮次都会跑一次链）', () => {
  // chain 槽位按轮次逐个调用：不做这个限定，同一条待办会在历史每一轮后面都出现一份。
  assert.equal(lastTurnOf([]), null, '没有轮次就没有落点');
  assert.equal(lastTurnOf([{ turn: 1 }, { turn: 2 }, { turn: 7 }]), 7, '取时间序最后一轮');
  assert.equal(lastTurnOf([{ turn: 7 }]), 7);

  // 落点判定按 `TurnLocation` **对象**取轮次号（裸 number 说明把契约读错了）。
  assert.equal(turnTailVisible({ turn: 7 }, 's-1', 7), true, '最新一轮 + 有会话 → 画');
  assert.equal(turnTailVisible({ turn: 6 }, 's-1', 7), false, '历史轮次 → 不画（否则历史里每轮都重复一份）');
  assert.equal(turnTailVisible(7, 's-1', 7), false, '裸 number 不是 TurnLocation 形态 → 不画');
  assert.equal(turnTailVisible({ turn: 7 }, 's-1', null), false, '取不到最后一轮 → 不画');
  assert.equal(turnTailVisible({ turn: 7 }, '', 7), false, '没有会话标识就无从读状态 → 不画');
  assert.equal(turnTailVisible(undefined, 's-1', 7), false, '缺少 owner → 不画');
});

/**
 * 回归锁：令牌根必须包住**所有**分支。
 *
 * 这段组件的数据靠 effect 取（首帧 `facts === null`，body 什么都画不出来）。**根仍然必须在**——
 * 那正是「根包在分支外面」的证明：此前只在「有方案」那条 return 里包了一层，
 * 其余四条分支（放行卡、阶段条、运行卡、放行读不到）仍是无令牌的裸块（评审抓到）。
 */
test('聊天卡片入口带令牌根，且与分支无关（首帧没有数据时也在）', () => {
  const html = renderToStaticMarkup(
    createElement(IntakePrompt, {
      controller: {} as never,
      dshSessionId: 'dsh-root-probe',
      onOpenConsole: () => undefined,
    } as never),
  );
  assert.match(html, /class="pentest-chat-card"/, '令牌根必须出现在入口输出里');
});

test('Agent 会话里的阶段横条也必须能推进：人类就在这一页，动作不能只画在别处', () => {
  // 人类报障的原话：「那是 AI 的输出，我根本没有可以点击的按钮」——他正待在**正在工作的
  // 那个 Agent 会话**里，而那条分支过去只画只读横条，运行卡是不画的（「Agent 在别处」在这里是假的）。
  // 于是 Agent 自己在报告里写「建议下一步…」，屏幕上却没有任何能点的东西（2026-10-05）。
  const html = renderToStaticMarkup(
    createElement(
      PhaseStrip,
      {
        engagementName: '内部靶场 A 轮',
        mainStatus: 'waiting_human_review',
        currentPhase: 'intelligence-gathering',
        statusNote: null,
      },
      createElement(AdvanceAction, {
        mainStatus: 'waiting_human_review',
        currentPhase: 'intelligence-gathering',
        onAdvancePhase: () => undefined,
      }),
    ),
  );
  assert.ok(html.includes('进入下一阶段：威胁建模'), `横条卡里必须出现推进按钮：${html.slice(0, 300)}`);
  assert.ok(!html.includes('disabled=""'), '闸门都成立时按钮必须可点');
});

test('动作块的三条判定：非等待人工判断不画、没有回调不画、无推荐下一阶段时去掉括号', () => {
  const render = (props: Parameters<typeof AdvanceAction>[0]): string =>
    renderToStaticMarkup(createElement(AdvanceAction, props));

  // ① Agent 还在跑：此刻没有下一阶段可进，能做的只是跟过去（不画按钮）。
  assert.equal(
    render({ mainStatus: 'worker_running', currentPhase: 'intelligence-gathering', onAdvancePhase: () => undefined }),
    '',
  );
  // ② 拿不到回调就不画——「省略」的意思是「不画这个按钮」，不是画一个点了没反应的。
  //    「草稿已经在手」也走这条路：调用方此刻不传回调（要做的是审计，不是再生成一份）。
  assert.equal(render({ mainStatus: 'waiting_human_review', currentPhase: 'intelligence-gathering' }), '');
  // ③ 推荐表里没有下一步（后渗透之后是回环，不是推进）：标签不带括号，由人类去交接编辑手选。
  const tail = render({ mainStatus: 'waiting_human_review', currentPhase: 'post-exploitation', onAdvancePhase: () => undefined });
  assert.ok(tail.includes('进入下一阶段'), tail);
  assert.ok(!tail.includes('（'), '没有推荐下一阶段时不该编一个出来');
});
