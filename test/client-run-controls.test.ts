/**
 * 运行控制与交接面板的测试。
 *
 * 这两个组件补的是**主线入口**：在此之前，控制器的 `startWorker` / `pause` / `resume` /
 * `interrupt` / `requestHandoffDraft` 都能用，但**没有任何视图调用它们**——
 * 也就是说，界面能建 engagement、能看报告，却无法让 Agent 开始工作、无法让它停下、
 * 也走不到阶段切换。这层接线因此必须被钉住，否则一次重构就能把它悄悄拆掉。
 *
 * 断言聚焦三件事：
 *
 *   1. **正交状态的两个字段各自决定什么**（§5.1）：`mainStatus` 管「能否启动」，
 *      `runMarker` 管「运行期动作」，不能互相折叠成一个 switch。
 *   2. **禁用必须说明原因**：每个不可用动作都要有非空理由，且理由要指出怎么才能可用。
 *   3. **不可撤销的动作有二次确认**：终止要么被勾选拦住，要么被理由拦住——不能一路直通。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import type { RunMarker } from '../src/contracts.ts';
import { ConsoleController } from '../src/client/controller.ts';
import type { ConsoleSnapshot } from '../src/client/controller.ts';
import { RunControls, parseLimit, runActionAvailability, startBlockers } from '../src/client/views/RunControls.tsx';
import { HandoffPanel, draftRequestBlockers } from '../src/client/views/HandoffPanel.tsx';

const NOW = new Date('2026-09-19T12:00:00Z');

/** 只会抛错的 invoker：这些测试只走渲染与纯判定，不该有任何 RPC。 */
function inertController(): ConsoleController {
  return new ConsoleController({
    invoke: () => {
      throw new Error('渲染与纯判定不应发出 RPC');
    },
    clock: () => NOW,
  });
}

function snapshotWith(state: ConsoleSnapshot['state']): ConsoleSnapshot {
  return {
    engagements: [],
    selectedEngagementId: state === null ? null : 'e1',
    state,
    sessions: [],
    loading: false,
    lastError: null,
    conflict: false,
    loadedAt: null,
  };
}

function workflowState(
  over: Partial<NonNullable<ConsoleSnapshot['state']>> = {},
): NonNullable<ConsoleSnapshot['state']> {
  return {
    engagementId: 'e1',
    mainStatus: 'ready',
    runMarker: 'running',
    currentPhase: 'intelligence-gathering',
    stateVersion: 3,
    graphIteration: 1,
    activeWorkerSessionId: null,
    scopeVersion: 1,
    authorizationExpiresAt: null,
    ...over,
  };
}

// ───────────────────── 正交状态：两个字段各自决定什么 ─────────────────────

test('runActionAvailability：运行标记独立决定运行期动作，不被主状态折叠', () => {
  // 「等待人工判断 + 运行中」是真实组合（Agent 交了报告但人类还没处理），
  // 把它折叠成「在等人类 → 什么都停下」会让暂停/恢复失去意义。
  const running = runActionAvailability(workflowState({ mainStatus: 'waiting_human_review', runMarker: 'running' }));
  assert.equal(running.canPause, true, '运行中就能暂停，与主状态无关');
  assert.equal(running.canResume, false);

  const paused = runActionAvailability(workflowState({ mainStatus: 'waiting_human_review', runMarker: 'paused' }));
  assert.equal(paused.canPause, false);
  assert.equal(paused.canResume, true, '已暂停就能恢复，同样与主状态无关');
});

test('runActionAvailability：终态不再允许终止（避免制造噪音记录）', () => {
  for (const marker of ['aborted', 'failed'] as readonly RunMarker[]) {
    const a = runActionAvailability(workflowState({ runMarker: marker }));
    assert.equal(a.canAbort, false, `${marker} 已是终态`);
    assert.equal(a.canPause, false);
    assert.equal(a.canResume, false);
  }
  // 但「阻塞」仍要能终止：一个卡住的 engagement 若无终止入口，只能靠改库收场。
  assert.equal(runActionAvailability(workflowState({ runMarker: 'blocked' })).canAbort, true);
});

test('runActionAvailability：插话需要在跑的会话，且只在运行标记为 running 时', () => {
  const noSession = runActionAvailability(workflowState({ runMarker: 'running', activeWorkerSessionId: null }));
  assert.equal(noSession.canInterject, false, '没有活动会话就没有投递对象');

  const paused = runActionAvailability(workflowState({ runMarker: 'paused', activeWorkerSessionId: 'w1' }));
  assert.equal(paused.canInterject, false, '暂停时投递无人消费');

  const ok = runActionAvailability(workflowState({ runMarker: 'running', activeWorkerSessionId: 'w1' }));
  assert.equal(ok.canInterject, true);
});

test('runActionAvailability：每个不可用动作都给出非空原因（禁用不能没有解释）', () => {
  const cases = [
    runActionAvailability(null),
    runActionAvailability(workflowState({ runMarker: 'paused', activeWorkerSessionId: null })),
    runActionAvailability(workflowState({ runMarker: 'aborted' })),
  ];
  for (const a of cases) {
    for (const [action, reason] of [
      ['pause', a.pauseReason], ['resume', a.resumeReason],
      ['abort', a.abortReason], ['interject', a.interjectReason],
    ] as const) {
      if (a[`can${action.charAt(0).toUpperCase()}${action.slice(1)}` as 'canPause'] === false) {
        assert.notEqual(reason, null, `${action} 不可用时必须说明原因`);
        assert.notEqual(String(reason).trim(), '', `${action} 的原因不能是空串`);
      }
    }
  }
});

// ───────────────────── 启动闸门 ─────────────────────

test('startBlockers：只有 ready 可以启动（auth_pending 是向导刚建完、授权未就位）', () => {
  const base = { taskPrompt: '做事', reason: '因为', budgetFields: ['', '', ''] };
  assert.deepEqual(startBlockers({ ...base, mainStatus: 'ready' }), []);
  for (const status of ['auth_pending', 'worker_running', 'report_ready', 'complete', null]) {
    const gates = startBlockers({ ...base, mainStatus: status });
    assert.equal(gates.length > 0, true, `主状态 ${String(status)} 不该允许启动`);
  }
});

test('startBlockers：任务提示词必填；**理由不再是闸门**（2026-10-05 人类要求）', () => {
  const base = { mainStatus: 'ready', budgetFields: ['', '', ''] };
  assert.equal(startBlockers({ ...base, taskPrompt: '   ' }).length > 0, true, '空白提示词不算填');
  assert.deepEqual(startBlockers({ ...base, taskPrompt: 'p' }), [], '提示词有内容即可启动，不要求理由');
});

test('startBlockers：预算三项要么都填、要么都不填（半填会被服务端整体拒绝）', () => {
  const base = { mainStatus: 'ready', taskPrompt: 'p' };
  assert.deepEqual(startBlockers({ ...base, budgetFields: ['', '', ''] }), [], '都不填 = 用默认上限');
  assert.deepEqual(startBlockers({ ...base, budgetFields: ['1', '2', '3'] }), [], '都填 = 完整上限');
  const half = startBlockers({ ...base, budgetFields: ['1', '', ''] });
  assert.equal(half.length > 0, true, '只填一项必须被界面拦下，而不是提交后才被拒');
  assert.equal(half.some((g) => g.includes('要么')), true, '理由要说清「要么都填要么都不填」');
});

test('parseLimit：非法值回落到「不设限」，而不是回落到 1', () => {
  // 回落到 1 会让一次手滑把会话预算压到一步——那是比「不设限」危险得多的默认。
  assert.equal(parseLimit(''), undefined);
  assert.equal(parseLimit('abc'), undefined);
  assert.equal(parseLimit('0'), undefined);
  assert.equal(parseLimit('-5'), undefined);
  assert.equal(parseLimit('200'), 200);
  assert.equal(parseLimit(' 42 '), 42);
});

// ───────────────────── 渲染 ─────────────────────

test('RunControls：未选中 engagement 时整块不渲染（不摆一排永远禁用的按钮）', () => {
  const html = renderToStaticMarkup(
    createElement(RunControls, { controller: inertController(), snapshot: snapshotWith(null), now: NOW }),
  );
  assert.equal(html, '');
});

test('RunControls：运行中渲染五个动作；**暂停不需要填理由**（2026-10-05 人类要求）', () => {
  const html = renderToStaticMarkup(
    createElement(RunControls, {
      controller: inertController(),
      snapshot: snapshotWith(workflowState({ mainStatus: 'ready', runMarker: 'running' })),
      now: NOW,
    }),
  );
  for (const label of ['启动 Agent', '暂停', '恢复', '发送插话', '终止']) {
    assert.ok(html.includes(label), `应渲染「${label}」`);
  }
  // 理由输入框已按人类要求移除：不再有任何「必须填写…理由」的闸门。
  assert.ok(!html.includes('必须填写暂停理由'), '不该再要求填暂停理由');
  assert.ok(!html.includes('暂停理由'), '理由输入框必须删除');
  assert.ok(!html.includes('终止理由'), '理由输入框必须删除');
  // 恢复在运行中不可用，且说明为什么（可用性说明保留——那是状态，不是要人写作文）
  assert.ok(html.includes('只有已暂停才能恢复'), '恢复的禁用原因必须出现');
});

test('RunControls：终止只要二次确认（不可撤销的防手滑），不再要求理由', () => {
  const blocked = renderToStaticMarkup(
    createElement(RunControls, {
      controller: inertController(),
      snapshot: snapshotWith(workflowState()),
      now: NOW,
    }),
  );
  assert.ok(!blocked.includes('必须填写终止理由'), '不该再要求填终止理由');
  assert.ok(blocked.includes('我确认要终止'), '二次确认必须可见——它不可撤销');
  assert.ok(blocked.includes('需勾选二次确认'), '未勾选时的禁用原因必须写出来');
});

// ───────────────────── 交接草稿前置 ─────────────────────

test('draftRequestBlockers：只有等待人工判断时可以请求交接草稿', () => {
  const base = { selected: true, hasActiveSession: true, reason: 'r' };
  assert.deepEqual(draftRequestBlockers({ ...base, mainStatus: 'waiting_human_review' }), []);
  for (const status of ['ready', 'worker_running', 'report_ready', null]) {
    assert.equal(
      draftRequestBlockers({ ...base, mainStatus: status }).length > 0,
      true,
      `主状态 ${String(status)} 不该允许请求草稿`,
    );
  }
});

test('draftRequestBlockers：没有活动会话时拒绝，并说明「交接是从某个会话交出去」', () => {
  const gates = draftRequestBlockers({
    selected: true, mainStatus: 'waiting_human_review', hasActiveSession: false, reason: 'r',
  });
  assert.equal(gates.length, 1);
  assert.ok(gates[0]?.includes('没有活动 Worker 会话'));
});

test('HandoffPanel：没有待确认内容时给出「进入下一阶段」入口，并说明内容从哪来', () => {
  const html = renderToStaticMarkup(
    createElement(HandoffPanel, {
      controller: inertController(),
      snapshot: snapshotWith(workflowState({ mainStatus: 'waiting_human_review' })),
      draft: null,
      onDraft: () => {},
    }),
  );
  assert.ok(html.includes('进入下一阶段'), '必须有入口，否则阶段切换在界面上走不通');
  assert.ok(html.includes('服务端会按阶段定义和当前状态'), '要说清内容从哪来（服务端起稿，不经 Agent 的草稿回合）');
  assert.ok(!html.includes('草稿'), '界面上不该再有草稿措辞');
});

test('HandoffPanel：未选中 engagement 时显示空态而不是请求入口', () => {
  const html = renderToStaticMarkup(
    createElement(HandoffPanel, {
      controller: inertController(),
      snapshot: snapshotWith(null),
      draft: null,
      onDraft: () => {},
    }),
  );
  assert.ok(html.includes('先选择一个 engagement'));
  assert.ok(!html.includes('进入下一阶段（生成可编辑内容）'), '没有 engagement 就不该给出入口');
});

// ───────────────────── 回环状态透传 ─────────────────────

test('HandoffPanel：把回环前置状态透传给编辑器（界面闸门与服务端判据同源）', () => {
  // 未完成范围修订时，编辑器必须显示「回环前必须完成范围修订」并禁用确认——
  // 这是界面对 §5.4 步骤 4 的表达，服务端用同一条件复核。
  const html = renderToStaticMarkup(
    createElement(HandoffPanel, {
      controller: inertController(),
      snapshot: snapshotWith(workflowState({ mainStatus: 'report_ready' })),
      draft: {
        draftId: 'd1',
        fromWorkerSessionId: 'w1',
        fromPhase: 'post-exploitation',
        suggestedToPhase: 'intelligence-gathering',
        objective: '回环侦察',
        prompt: 'p',
        suggestedSkillIds: [],
        contextRefs: [],
        excludedRefs: [],
        toolCapabilitySuggestion: { allowed: [], approvalRequired: [] },
        limitations: [],
        revision: 1,
      },
      onDraft: () => {},
      scopeAmendment: { completed: false, newVersion: null },
    }),
  );
  assert.ok(html.includes('范围修订'), '未完成范围修订时必须说出来');
});

test('交接面板不发出 RPC：渲染是纯的（挂载期无写入是硬约束）', () => {
  // `inertController` 的 invoker 会抛错——能渲染出内容就证明渲染期没有调用发生。
  // 这条锁住「点击才写、渲染不写」：渲染期发请求会让服务端渲染无法进行，
  // 也会让「打开面板」变成一次隐式写操作。
  const html = renderToStaticMarkup(
    createElement(HandoffPanel, {
      controller: inertController(),
      snapshot: snapshotWith(workflowState()),
      draft: null,
      onDraft: () => {},
      scopeAmendment: { completed: false, newVersion: null },
    }),
  );
  assert.ok(html.length > 0);
});
