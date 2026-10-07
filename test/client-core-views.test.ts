/**
 * 阶段轨道与时间轴的测试。
 *
 * 重点锁定三条**关于判断**的规则——放在纯函数里才可能穷举验证：
 *   1. **只画有证据的边**（§6.2）：结构边必须有字段支撑，指针悬空时**不画**
 *   2. **回环与回补必须区分**（§5.4）：loop 递增迭代、rollback 不递增
 *   3. **孤儿会话必须可见**（§15.2）：未收尾的会话要标注，不隐藏
 *
 * 视图渲染用 `renderToStaticMarkup`（不需要 jsdom）。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { buildPhaseTrack, buildEdges, phaseTone } from '../src/client/phase-track.ts';
import { buildMinimap, filterSessions, orphanInfo, buildTimeTicks } from '../src/client/timeline.ts';
import { truncate } from '../src/client/format.ts';
import { PhaseTrack } from '../src/client/views/PhaseTrack.tsx';
import { SessionTimeline } from '../src/client/views/SessionTimeline.tsx';
import { RunHeader } from '../src/client/views/RunHeader.tsx';
import type { Phase, SessionStatus, WorkerSessionSummary } from '../src/contracts.ts';

/** 造一个会话摘要，只覆盖测试关心的字段。 */
function session(over: Partial<WorkerSessionSummary> & { readonly id: string }): WorkerSessionSummary {
  return {
    dshSessionId: `dsh-${over.id}`,
    phase: 'intelligence-gathering' as Phase,
    status: 'active' as SessionStatus,
    attempt: 1,
    iteration: 1,
    scopeVersion: 1,
    previousAgentSessionId: null,
    retryOfSessionId: null,
    transitionId: null,
    statusNote: null,
    statusNoteSource: null,
    statusNoteAt: null,
    startedAt: '2026-01-01T00:00:00Z',
    endedAt: null,
    createdAt: '2026-01-01T00:00:00Z',
    ...over,
  };
}

// ─────────────── 阶段轨道：节点聚合 ───────────────

test('五个阶段恒定存在，未到过的标记为未访问', () => {
  const track = buildPhaseTrack([session({ id: 'a' })]);
  assert.equal(track.nodes.length, 5, '五个阶段始终显示——轨道是状态机的全貌');
  assert.equal(track.nodes.find((n) => n.phase === 'intelligence-gathering')?.visited, true);
  assert.equal(track.nodes.find((n) => n.phase === 'exploitation')?.visited, false);
});

test('节点聚合：会话数、执行次数、最新便签', () => {
  const sessions = [
    session({ id: 'a', attempt: 1, status: 'closed', endedAt: '2026-01-01T01:00:00Z', statusNote: '第一次', statusNoteAt: '2026-01-01T00:30:00Z', statusNoteSource: 'agent' }),
    session({ id: 'b', attempt: 2, statusNote: '第二次的便签', statusNoteAt: '2026-01-01T02:00:00Z', statusNoteSource: 'derived' }),
  ];
  const node = buildPhaseTrack(sessions).nodes.find((n) => n.phase === 'intelligence-gathering');
  assert.ok(node !== undefined);
  assert.equal(node.sessionCount, 2);
  assert.equal(node.maxAttempt, 2);
  assert.equal(node.latestNote, '第二次的便签', '取时间最新的那条');
  assert.equal(node.latestNoteSource, 'derived', '便签来源必须透出——界面据此标注「自动摘要」');
  assert.equal(node.running, true, '有存活会话即为工作中');
});

test('节点 tone：工作中 → active；未访问 → neutral；已结束 → done', () => {
  const running = buildPhaseTrack([session({ id: 'a', status: 'active' })]).nodes[0]!;
  assert.equal(phaseTone(running), 'active');
  const untouched = buildPhaseTrack([]).nodes[0]!;
  assert.equal(phaseTone(untouched), 'neutral');
  const closed = buildPhaseTrack([session({ id: 'a', status: 'closed', endedAt: '2026-01-01T01:00:00Z' })]).nodes[0]!;
  assert.equal(phaseTone(closed), 'done');
});

test('同一阶段的多轮迭代被列出（回环后该阶段会出现在多轮里）', () => {
  const sessions = [
    session({ id: 'a', iteration: 1 }),
    session({ id: 'b', iteration: 2, status: 'closed', endedAt: '2026-01-01T01:00:00Z' }),
  ];
  const node = buildPhaseTrack(sessions).nodes[0]!;
  assert.deepEqual([...node.iterations], [1, 2]);
});

// ─────────────── 边：只画有证据的 ───────────────

test('序列边：相邻阶段被访问时才画（没到过就不画箭头）', () => {
  // 到过威胁建模 → 情报收集→威胁建模 应有序列边
  const edges = buildEdges([
    session({ id: 'a', phase: 'intelligence-gathering' }),
    session({ id: 'b', phase: 'threat-modeling' }),
  ]);
  const seq = edges.filter((e) => e.kind === 'sequence');
  assert.equal(seq.length, 1);
  assert.equal(seq[0]!.from, 'intelligence-gathering');
  assert.equal(seq[0]!.to, 'threat-modeling');

  // 只到过情报收集 → 无边
  const only = buildEdges([session({ id: 'a', phase: 'intelligence-gathering' })]);
  assert.equal(only.filter((e) => e.kind === 'sequence').length, 0);
});

test('交接边：必须有 previousAgentSessionId 且指向另一阶段的**已知**会话', () => {
  const prev = session({ id: 'prev', phase: 'intelligence-gathering', status: 'closed', endedAt: '2026-01-01T01:00:00Z' });
  const next = session({ id: 'next', phase: 'threat-modeling', previousAgentSessionId: 'prev' });
  const edges = buildEdges([prev, next]);
  const handoff = edges.filter((e) => e.kind === 'handoff');
  assert.equal(handoff.length, 1);
  assert.equal(handoff[0]!.from, 'intelligence-gathering');
  assert.equal(handoff[0]!.to, 'threat-modeling');
  assert.ok(handoff[0]!.evidence.length > 0, '必须带证据（供悬浮显示依据）');
});

test('交接边：指针悬空时不画（没有对端就没有证据，这正是「不发明箭头」）', () => {
  const orphanPointer = session({ id: 'next', phase: 'threat-modeling', previousAgentSessionId: 'not-in-list' });
  const edges = buildEdges([orphanPointer]);
  assert.equal(
    edges.filter((e) => e.kind === 'handoff').length,
    0,
    '指针指向不在列表里的会话（被清理或超出 limit）时不得画边',
  );
});

test('重做边：retryOfSessionId 指向同阶段会话（自环，供显示重做次数）', () => {
  const first = session({ id: 'first', status: 'closed', endedAt: '2026-01-01T01:00:00Z' });
  const retry = session({ id: 'retry', attempt: 2, retryOfSessionId: 'first' });
  const retryEdges = buildEdges([first, retry]).filter((e) => e.kind === 'retry');
  assert.equal(retryEdges.length, 1);
  assert.equal(retryEdges[0]!.from, retryEdges[0]!.to, '同阶段重做是自环');
});

test('回环边：判据是**迭代递增**，不是时间顺序（§5.4 区分 loop 与 rollback）', () => {
  const post = session({ id: 'post', phase: 'post-exploitation', iteration: 1, status: 'closed', endedAt: '2026-01-01T01:00:00Z' });
  const intelNext = session({ id: 'intel2', phase: 'intelligence-gathering', iteration: 2 });
  const loop = buildEdges([post, intelNext]).filter((e) => e.kind === 'loop');
  assert.equal(loop.length, 1, '迭代 2 的情报收集相对迭代 1 的后渗透 → 回环');
  assert.deepEqual([...loop[0]!.iterations], [2]);
});

test('回补不会被误判为回环（同迭代内往后走不产生 loop 边）', () => {
  // 时间上后渗透之后又出现了情报收集，但迭代号相同 → 这是回补，不是回环
  const intel = session({ id: 'intel', iteration: 1, status: 'closed', endedAt: '2026-01-01T02:00:00Z' });
  const post = session({ id: 'post', phase: 'post-exploitation', iteration: 1, status: 'closed', endedAt: '2026-01-01T01:00:00Z' });
  const loop = buildEdges([post, intel]).filter((e) => e.kind === 'loop');
  assert.equal(loop.length, 0, '同迭代内的回补不递增迭代，因此不是回环');
});

// ─────────────── 孤儿判定 ───────────────

test('孤儿：终态却没有结束时间 → 未收尾且需要留意', () => {
  const info = orphanInfo(session({ id: 'a', status: 'failed', endedAt: null }));
  assert.ok(info !== null);
  assert.equal(info.needsAttention, true);
  assert.match(info.reason, /未收尾/);
});

test('孤儿：superseded 是正常流程，但人类需要知道', () => {
  const info = orphanInfo(session({ id: 'a', status: 'superseded', endedAt: '2026-01-01T01:00:00Z' }));
  assert.ok(info !== null);
  assert.equal(info.needsAttention, false);
  assert.match(info.reason, /取代/);
});

test('孤儿：阻塞态需要留意但不标为未收尾', () => {
  const info = orphanInfo(session({ id: 'a', status: 'blocked' }));
  assert.ok(info !== null);
  assert.equal(info.needsAttention, true);
  assert.match(info.reason, /等待人类处置/);
});

test('正常终态与工作中的会话不标孤儿', () => {
  assert.equal(orphanInfo(session({ id: 'a', status: 'active' })), null);
  assert.equal(orphanInfo(session({ id: 'b', status: 'closed', endedAt: '2026-01-01T01:00:00Z' })), null);
  assert.equal(orphanInfo(session({ id: 'c', status: 'waiting_human' })), null);
});

// ─────────────── 过滤与迷你地图 ───────────────

test('搜索跨字段匹配（阶段 / 状态 / 便签 / 历史指针）', () => {
  const s = session({
    id: 'sess-abc123',
    phase: 'exploitation',
    statusNote: '端口 8080 不通',
    previousAgentSessionId: 'prev-xyz',
  });
  assert.equal(filterSessions([s], { text: '利用' }).length, 1, '阶段中文名');
  assert.equal(filterSessions([s], { text: '8080' }).length, 1, '便签内容');
  assert.equal(filterSessions([s], { text: 'prev-xyz' }).length, 1, '历史指针');
  assert.equal(filterSessions([s], { text: '不存在的词' }).length, 0);
});

test('onlyAttention 只留需要留意的会话', () => {
  const ok = session({ id: 'ok', status: 'active' });
  const stuck = session({ id: 'stuck', status: 'failed', endedAt: null });
  assert.deepEqual(
    filterSessions([ok, stuck], { onlyAttention: true }).map((s) => s.id),
    ['stuck'],
  );
});

test('迷你地图按迭代分组，并标出该轮是否有需留意的', () => {
  const groups = buildMinimap([
    session({ id: 'a', iteration: 1 }),
    session({ id: 'b', iteration: 1, status: 'closed', endedAt: '2026-01-01T01:00:00Z' }),
    session({ id: 'c', iteration: 2, status: 'failed', endedAt: null }),
  ]);
  assert.equal(groups.length, 2);
  assert.equal(groups[0]!.iteration, 1);
  assert.equal(groups[0]!.blocks.length, 2);
  assert.equal(groups[0]!.hasAttention, false);
  assert.equal(groups[1]!.hasAttention, true, '孤儿块必须让该轮标出告警');
});

test('时钟轴：单会话也能给出刻度，且不重复同一时刻', () => {
  assert.equal(buildTimeTicks([]).length, 0);
  assert.equal(buildTimeTicks([session({ id: 'a' })]).length, 1);
  const ticks = buildTimeTicks([
    session({ id: 'a', createdAt: '2026-01-01T00:00:00Z' }),
    session({ id: 'b', createdAt: '2026-01-01T06:00:00Z' }),
  ]);
  assert.ok(ticks.length >= 2);
  assert.equal(new Set(ticks.map((t) => t.at)).size, ticks.length, '刻度不重复');
});

// ─────────────── 视图渲染 ───────────────

test('阶段轨道视图：五阶段名出现，空数据不崩溃', () => {
  const html = renderToStaticMarkup(
    createElement(PhaseTrack, { sessions: [] }),
  );
  assert.match(html, /阶段轨道/);
  assert.match(html, /尚未开始任何阶段/, '空态要说明为什么空');

  const withData = renderToStaticMarkup(
    createElement(PhaseTrack, {
      sessions: [session({ id: 'a', statusNote: '正在收集子域' })],
      noteMaxChars: 40,
    }),
  );
  for (const label of ['情报收集', '威胁建模', '漏洞分析', '利用验证', '后渗透']) {
    assert.match(withData, new RegExp(label), `阶段 ${label} 必须出现`);
  }
  assert.match(withData, /正在收集子域/, '便签要显示在节点上');
});

test('阶段轨道视图：派生便签标注「自动摘要」', () => {
  const html = renderToStaticMarkup(
    createElement(PhaseTrack, {
      sessions: [session({ id: 'a', statusNote: '派生的', statusNoteSource: 'derived' })],
    }),
  );
  assert.match(html, /自动摘要/, '人类需要知道那不是 Agent 写的（§6.2.2）');
});

test('时间轴视图：孤儿会话被显式标注（不隐藏）', () => {
  const html = renderToStaticMarkup(
    createElement(SessionTimeline, {
      sessions: [session({ id: 'lost', status: 'failed', endedAt: null })],
    }),
  );
  assert.match(html, /未收尾/, '§15.2：未收尾的会话必须标注，不隐藏');
});

test('时间轴视图：每条会话都有「进入会话」（各阶段会话的入口），没给回调就不画', () => {
  // 人类报障：不同阶段开的会话只能在时间轴上**看**，进不去——要看 Agent 的对话得自己去侧栏找。
  // 这条锁两件事：入口有没有画（带 dsh 会话标识）、以及拿不到导航能力时 fail-closed。
  const withEnter = renderToStaticMarkup(
    createElement(SessionTimeline, {
      sessions: [session({ id: 'a1', status: 'active' }), session({ id: 'b2', status: 'waiting_human' })],
      onEnterSession: () => undefined,
    }),
  );
  assert.equal(
    (withEnter.match(/进入会话/g) ?? []).length,
    2,
    '每条会话都要有入口：人类要能直接进到那一阶段的 Agent 对话',
  );

  const withoutEnter = renderToStaticMarkup(
    createElement(SessionTimeline, { sessions: [session({ id: 'a1' })] }),
  );
  assert.equal(/进入会话/.test(withoutEnter), false, '没有导航能力时不得画这个按钮（fail-closed）');
});

test('时间轴视图：空态与无匹配空态用不同文案', () => {
  const empty = renderToStaticMarkup(createElement(SessionTimeline, { sessions: [] }));
  assert.match(empty, /还没有任何 Worker 会话/);

  const noMatch = renderToStaticMarkup(
    createElement(SessionTimeline, {
      sessions: [session({ id: 'a' })],
      filter: { text: '绝不匹配的词' },
    }),
  );
  assert.match(noMatch, /没有匹配的会话/, '要区分「没有数据」与「筛选后没有」');
});

test('时间轴视图：交接与重做来源被标注', () => {
  const html = renderToStaticMarkup(
    createElement(SessionTimeline, {
      sessions: [
        session({ id: 'first', status: 'closed', endedAt: '2026-01-01T01:00:00Z' }),
        session({ id: 'retry', attempt: 2, retryOfSessionId: 'first', previousAgentSessionId: null }),
      ],
    }),
  );
  assert.match(html, /由重做创建/);
});

test('运行总览：状态标签、迭代、索引水位告警', () => {
  const html = renderToStaticMarkup(
    createElement(RunHeader, {
      engagementName: '内网靶场',
      state: {
        engagementId: 'e1',
        mainStatus: 'waiting_human_review',
        runMarker: 'running',
        currentPhase: 'vulnerability-analysis',
        stateVersion: 7,
        graphIteration: 2,
        activeWorkerSessionId: 'w1', scopeVersion: 1, authorizationExpiresAt: null,
      },
      scopeVersion: 3,
      indexLagEvents: 12,
      authorizationExpiresAt: '2026-12-31T00:00:00Z',
    }),
  );
  assert.match(html, /等待你判断/, '主状态用动作提示而不是名词');
  assert.match(html, /漏洞分析/);
  assert.match(html, /第 2 轮/, '迭代次数');
  assert.match(html, /滞后 12 条/, '索引滞后必须可见（§8.4）');
});

test('运行总览：未选择 engagement 时不渲染状态字段，且不崩溃', () => {
  const html = renderToStaticMarkup(
    createElement(RunHeader, { engagementName: '—', state: null }),
  );
  assert.match(html, /未选择/);
});

test('运行总览：版本冲突与错误各自呈现', () => {
  const conflict = renderToStaticMarkup(
    createElement(RunHeader, {
      engagementName: 'e', state: null, conflict: true,
    }),
  );
  assert.match(conflict, /stale_state_version/);
  assert.match(conflict, /已重新读取最新状态/, '冲突要说明界面已跟上，而不是留一个卡住的旧界面');

  const error = renderToStaticMarkup(
    createElement(RunHeader, {
      engagementName: 'e', state: null,
      lastError: { code: 'engagement_halted', message: '该 engagement 已暂停' },
    }),
  );
  assert.match(error, /engagement_halted/, '保留稳定错误码——UI 据码分支');
});

test('运行总览：授权过期时显示告警色', () => {
  const html = renderToStaticMarkup(
    createElement(RunHeader, {
      engagementName: 'e',
      state: null,
      authorizationExpiresAt: '2020-01-01T00:00:00Z',
      now: new Date('2026-01-01T00:00:00Z'),
    }),
  );
  assert.match(html, /pentest-stat--danger/, '过期授权必须显著提示');
});

// ─────────────── 跨视图约定 ───────────────
//
// 这两条是**每一轮新视图都容易再犯**的同类错误，因此在这里集中锁住。

test('渲染输出不含字面 markdown（React 不会渲染 `**粗体**`，那会原样显示两个星号）', () => {
  // 这是实测踩到的：视图里写 `<span>**注意**</span>` 时浏览器显示的是两个星号。
  // 这类缺陷在纯逻辑测试里看不出来（字符串确实包含「注意」），只有看渲染输出才发现。
  //
  // 2026-10-07 评审的变异实验指出：**夹具不带标记时这条锁对"渲染器接线"永真**
  // （把 renderInlineMarkdown 换回裸插值它照样绿）。现在夹具里放真标记，并同时断言
  // 「有 <strong>」且「无 **」——两边一起钉。
  const outputs = [
    renderToStaticMarkup(createElement(PhaseTrack, { sessions: [session({ id: 'a', statusNote: '**A**' })] })),
    renderToStaticMarkup(createElement(SessionTimeline, { sessions: [session({ id: 'b', statusNote: '**B**' })] })),
    renderToStaticMarkup(
      createElement(RunHeader, {
        engagementName: 'e',
        state: {
          engagementId: 'e1', mainStatus: 'ready', runMarker: 'running', currentPhase: null,
          stateVersion: 0, graphIteration: 1, activeWorkerSessionId: null, scopeVersion: 1, authorizationExpiresAt: null,
        },
        conflict: true,
        indexLagEvents: 3,
      }),
    ),
  ];
  // 这两处是**截断站点**：写法是 strip → truncate → render，因此**没有加粗是对的**
  // （星号不占字数、截断位置才正确）；真正必须成立的是"标记不泄漏"：title 无星号、输出无 `**`。
  assert.ok(outputs[0]?.includes('title="A"'), 'title 属性只能是纯文本：strip 后不带星号');
  assert.ok(outputs[1]?.includes('title="B"'), 'title 属性只能是纯文本：strip 后不带星号');
  // 带标记的夹具让下面的扫荡**真的**能抓到"M16 回退"（把 renderInlineMarkdown/strip 换回裸插值
  // 会让字面 `**A**` 出现在输出里 ⇒ 必红），而不是像原来那样永真。
  assert.ok(outputs[0]?.includes('>A<'), '便签正文应只剩去掉标记后的可见文本');
  assert.ok(outputs[1]?.includes('>B<'), '便签正文应只剩去掉标记后的可见文本');
  for (const html of outputs) {
    assert.equal(
      html.includes('**'),
      false,
      `渲染输出含字面 ** —— React 不解析 markdown，它会原样显示。用 <strong> 或去掉标记。片段：${
        truncate(html.slice(Math.max(0, html.indexOf('**') - 60), html.indexOf('**') + 40), 100)
      }`,
    );
  }
});

test('渲染输出不含硬编码颜色（§6.2.3：颜色走官方设计令牌，深浅色自动适配）', () => {
  const html = renderToStaticMarkup(
    createElement(RunHeader, {
      engagementName: 'e',
      state: null,
      lastError: { code: 'x', message: 'y' },
      authorizationExpiresAt: '2020-01-01T00:00:00Z',
    }),
  );
  // `style="color:#f00"` 一类写法会让界面在深色模式下不可读。
  // 断言没有任何内联 color/background 样式。
  assert.equal(/#[0-9a-fA-F]{3,8}\b/.test(html), false, '出现十六进制色值');
  assert.equal(/rgb\(|rgba\(|hsl\(/.test(html), false, '出现 rgb/hsl 色值');
  assert.equal(/style="[^"]*color/.test(html), false, '出现内联 color 样式');
});
