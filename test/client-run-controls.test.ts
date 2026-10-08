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
    assert.equal(a.canResume, false, '终态不得被恢复——那是僵尸作业的入口');
  }
  // 但「阻塞」仍要能终止与恢复：一个卡住的 engagement 若无出口，只能靠改库收场。
  const blocked = runActionAvailability(workflowState({ runMarker: 'blocked' }));
  assert.equal(blocked.canAbort, true);
  assert.equal(blocked.canResume, true, '阻塞必须有受支持的出口：恢复（处置完继续）');
});

test('runActionAvailability：已签字导出的作业不再接受运行期动作', () => {
  // 主状态 complete 之后标记仍是 running（签字只改主状态），若只看标记，
  // 界面会在一个已结束的作业上继续提供暂停/终止按钮。
  const complete = runActionAvailability(
    workflowState({ mainStatus: 'complete', runMarker: 'running', activeWorkerSessionId: 'w1' }),
  );
  assert.equal(complete.canPause, false);
  assert.equal(complete.canAbort, false);
  assert.equal(complete.canResume, false);
  assert.equal(complete.canInterject, false);
  assert.equal(complete.canFinishTesting, false);
  assert.equal(complete.canExtendBudget, false);
  assert.match(String(complete.pauseReason), /签字导出/, '理由要说清是 complete 而非标记');
  // 禁用理由不得自相矛盾：complete 下标记可能还是 running，说「已经是终态（运行中）」是假话。
  assert.match(String(complete.abortReason), /签字导出/);
  assert.doesNotMatch(String(complete.abortReason), /已经是终态/);
  // 「complete + paused」可达（在 report_ready 暂停，再签字导出）：恢复与追加预算都要拒。
  const completePaused = runActionAvailability(workflowState({ mainStatus: 'complete', runMarker: 'paused' }));
  assert.equal(completePaused.canExtendBudget, false);
  assert.match(String(completePaused.resumeReason), /签字导出/);
});

test('runActionAvailability：追加预算只对运行中/已暂停开放', () => {
  assert.equal(runActionAvailability(workflowState({ runMarker: 'running' })).canExtendBudget, true);
  assert.equal(runActionAvailability(workflowState({ runMarker: 'paused' })).canExtendBudget, true);
  for (const runMarker of ['blocked', 'aborted', 'failed'] as const) {
    assert.equal(
      runActionAvailability(workflowState({ runMarker })).canExtendBudget,
      false,
      `${runMarker} 时不得追加预算：先恢复或终止`,
    );
  }
});

test('runActionAvailability：插话需要在跑的会话，且只在运行标记为 running 时', () => {
  const noSession = runActionAvailability(workflowState({ runMarker: 'running', activeWorkerSessionId: null }));
  assert.equal(noSession.canInterject, false, '没有活动会话就没有投递对象');

  const paused = runActionAvailability(workflowState({ runMarker: 'paused', activeWorkerSessionId: 'w1' }));
  assert.equal(paused.canInterject, false, '暂停时投递无人消费');

  const ok = runActionAvailability(workflowState({ runMarker: 'running', activeWorkerSessionId: 'w1' }));
  assert.equal(ok.canInterject, true);
});

test('runActionAvailability：结束技术测试只在「运行中 + 两个起点主状态」可用（§5.2 的两条边）', () => {
  // §5.2 有两条边指向 report_ready：worker_running（人类决定收工）与 waiting_human_review。
  for (const mainStatus of ['worker_running', 'waiting_human_review'] as const) {
    const a = runActionAvailability(workflowState({ mainStatus, runMarker: 'running' }));
    assert.equal(a.canFinishTesting, true, `${mainStatus} + running 必须能结束技术测试`);
    assert.equal(a.finishTestingReason, null);
  }
  // 暂停/阻塞/终态：先恢复或终止，别把「停止工作」混进中间态。
  for (const runMarker of ['paused', 'blocked', 'aborted', 'failed'] as const) {
    const a = runActionAvailability(workflowState({ mainStatus: 'waiting_human_review', runMarker }));
    assert.equal(a.canFinishTesting, false, `${runMarker} 时不得结束技术测试`);
    assert.match(String(a.finishTestingReason), /结束技术测试/, '不可用时必须说明原因');
  }
  // 起点主状态之外的（例如授权向导、报告已就绪、已完成）同样不可用。
  for (const mainStatus of ['auth_pending', 'ready', 'report_ready', 'complete'] as const) {
    assert.equal(
      runActionAvailability(workflowState({ mainStatus, runMarker: 'running' })).canFinishTesting,
      false,
      `${mainStatus} 不是结束技术测试的合法起点`,
    );
  }
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
      // 这三个是外部审计 P0-3 补上的动作：此前**判定有、按钮没有**，于是"不可用给理由"
      // 这条纪律根本没机会覆盖它们。列表必须跟着动作一起长，否则它们会再次溜出去。
      ['extendBudget', a.extendBudgetReason],
      ['retryWorker', a.retryWorkerReason],
      ['reopenTechnicalWork', a.reopenTechnicalWorkReason],
    ] as const) {
      if (a[`can${action.charAt(0).toUpperCase()}${action.slice(1)}` as 'canPause'] === false) {
        assert.notEqual(reason, null, `${action} 不可用时必须说明原因`);
        assert.notEqual(String(reason).trim(), '', `${action} 的原因不能是空串`);
      }
    }
  }
});

// ───────────────────── 外部审计 P0-3 补上的三个动作 ─────────────────────

test('runActionAvailability：重做只对「等待人工判断」开放（§5.4 的 retry 边）', () => {
  assert.equal(
    runActionAvailability(workflowState({ mainStatus: 'waiting_human_review', runMarker: 'running' })).canRetryWorker,
    true,
  );
  // 其余主状态都不行——尤其 `worker_running`（Agent 还在跑，"重做"该走插话）与 `report_ready`
  // （人类已宣布收工，回去补动作是 `reopenTechnicalWork` 的事）。
  for (const mainStatus of ['ready', 'worker_running', 'report_ready', 'complete'] as const) {
    assert.equal(
      runActionAvailability(workflowState({ mainStatus, runMarker: 'running' })).canRetryWorker,
      false,
      `${mainStatus} 不是重做的合法起点`,
    );
  }
});

test('runActionAvailability：重开技术工作只对「报告就绪且非终态」开放（report_reopen 边）', () => {
  assert.equal(
    runActionAvailability(workflowState({ mainStatus: 'report_ready', runMarker: 'running' })).canReopenTechnicalWork,
    true,
  );
  assert.equal(
    runActionAvailability(workflowState({ mainStatus: 'report_ready', runMarker: 'paused' })).canReopenTechnicalWork,
    true,
  );
  for (const runMarker of ['aborted', 'failed'] as const) {
    assert.equal(
      runActionAvailability(workflowState({ mainStatus: 'report_ready', runMarker })).canReopenTechnicalWork,
      false,
      `运行标记 ${runMarker} 下重开没有意义`,
    );
  }
  assert.equal(
    runActionAvailability(workflowState({ mainStatus: 'waiting_human_review', runMarker: 'running' })).canReopenTechnicalWork,
    false,
  );
});

test('RunControls：三个动作在界面上有落点（此前判定有、按钮没有）', () => {
  const html = renderToStaticMarkup(
    createElement(RunControls, {
      controller: inertController(),
      snapshot: snapshotWith(workflowState({ mainStatus: 'waiting_human_review', runMarker: 'running' })),
      now: NOW,
    }),
  );
  // 断言能真正在 HTML 里出现的东西：按钮文案与分区标题（`Field` 的 label 渲染成属性，
  // 不在文本里——上一版断言 `追加预算：tokens` 就是因为这个假阴性）。
  for (const label of ['重做', '重开技术工作', '阶段', '追加预算', '不可撤销'] as const) {
    assert.ok(html.includes(label), `界面上必须有「${label}」这个入口`);
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

test('parseLimit：只认纯十进制正整数（科学计数法/小数/千分位一律拒绝，REQ-13a 回归锁）', () => {
  // 事故：`Number.parseInt('1e5')` 得 1——想设 10 万、实际按 1 步执行；`'2,5'` 得 2。
  // 这些值此前既不是「空」也不是「可解析」，于是调用方把它们当「没填」静默丢掉整份预算。
  assert.equal(parseLimit('1e5'), undefined, '科学计数法不得被截断解析');
  assert.equal(parseLimit('1.5'), undefined);
  assert.equal(parseLimit('2,5'), undefined, '千分位不得被截断解析');
  assert.equal(parseLimit('+5'), undefined);
  assert.equal(parseLimit('9007199254740993'), undefined, '超出安全整数即拒绝');
  assert.equal(parseLimit('007'), 7, '前导零合法（值本身就是正整数）');
});

test('startBlockers：填了但解析不了的预算必须拦下，而不是静默回落到阶段默认值（REQ-13a 回归锁）', () => {
  const base = { mainStatus: 'ready', taskPrompt: 'p' };
  const invalid = startBlockers({ ...base, budgetFields: ['1e5', '2', '3'] });
  assert.equal(invalid.length, 1, '只该报预算这一条');
  assert.match(invalid[0] ?? '', /正整数/, '理由要说明必须是正整数');
  assert.match(invalid[0] ?? '', /tokens/, '要指出是哪一项手滑');
  assert.deepEqual(
    startBlockers({ ...base, budgetFields: ['10', '20', '30'] }),
    [],
    '合法输入不得被拦（防「恒拦」的假通过）',
  );
});

// ───────────────────── 渲染 ─────────────────────

test('RunControls：未选中 engagement 时整块不渲染（不摆一排永远禁用的按钮）', () => {
  const html = renderToStaticMarkup(
    createElement(RunControls, { controller: inertController(), snapshot: snapshotWith(null), now: NOW }),
  );
  assert.equal(html, '');
});

test('RunControls：运行中渲染六个动作；**暂停不需要填理由**（2026-10-05 人类要求）', () => {
  const html = renderToStaticMarkup(
    createElement(RunControls, {
      controller: inertController(),
      snapshot: snapshotWith(workflowState({ mainStatus: 'ready', runMarker: 'running' })),
      now: NOW,
    }),
  );
  for (const label of ['启动 Agent', '暂停', '恢复', '发送插话', '终止', '结束技术测试']) {
    assert.ok(html.includes(label), `应渲染「${label}」`);
  }
  // 理由输入框已按人类要求移除：不再有任何「必须填写…理由」的闸门。
  assert.ok(!html.includes('必须填写暂停理由'), '不该再要求填暂停理由');
  assert.ok(!html.includes('暂停理由'), '理由输入框必须删除');
  assert.ok(!html.includes('终止理由'), '理由输入框必须删除');
  // 恢复在运行中不可用，且说明为什么（可用性说明保留——那是状态，不是要人写作文）
  assert.ok(html.includes('仅已暂停或已阻塞可恢复'), '恢复的禁用原因必须出现');
  // 「结束技术测试」必须在界面上有入口：服务端早就实现了这条边，但没有视图调用它，
  // 人类只能看到报告面板提示「先完成技术测试」却点不到任何按钮。
  assert.ok(html.includes('结束技术测试'), '结束技术测试必须渲染出按钮');
  // 这个快照是主状态 ready（还没启动任何 Worker）：按钮存在但不可用，且说明原因。
  assert.ok(
    html.includes('仅主状态为「Agent 正在运行」或「等待人工判断」且运行标记为 running 时可结束技术测试；当前主状态：'),
    '非法起点必须给出禁用原因（按钮存在 ≠ 可用）',
  );
});

test('RunControls：等待人工判断时「结束技术测试」可用（§5.2 的边有界面入口）', () => {
  const html = renderToStaticMarkup(
    createElement(RunControls, {
      controller: inertController(),
      snapshot: snapshotWith(workflowState({ mainStatus: 'waiting_human_review', runMarker: 'running' })),
      now: NOW,
    }),
  );
  assert.ok(html.includes('结束技术测试'));
  assert.ok(
    !html.includes('可结束技术测试；当前主状态：'),
    '合法起点不得显示禁用原因——否则按钮永远点不动，等于没有入口',
  );
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
  assert.ok(blocked.includes('我确认终止（不可撤销）'), '二次确认必须可见——它不可撤销');
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
  assert.ok(html.includes('服务端按阶段定义起草'), '要说清内容从哪来（服务端起稿，不经 Agent 的草稿回合）');
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
  assert.ok(html.includes('先选择一个作业'));
  assert.ok(!html.includes('进入下一阶段'), '没有 engagement 就不该给出入口');
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
        contentHash: 'f'.repeat(64),
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
