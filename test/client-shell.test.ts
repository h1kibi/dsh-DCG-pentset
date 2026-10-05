/**
 * 控制台外壳的测试。
 *
 * 重点锁定外壳的**分工边界**（§6.2、§6.2.3）：
 *   1. **未选中 engagement 时不渲染轨道与时间轴**——渲染空壳会让人以为数据丢了
 *   2. **未装配的面板显示明确说明**而不是空白
 *   3. **受控**：面板与筛选由 props 决定，组件自身不持状态
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { ConsoleShell, CONSOLE_PANELS } from '../src/client/views/ConsoleShell.tsx';
import type { ConsoleShellProps } from '../src/client/views/ConsoleShell.tsx';
import type { ConsoleController } from '../src/client/controller.ts';
import type { EngagementSummary, Phase, SessionStatus, WorkerSessionSummary, WorkflowSnapshot } from '../src/contracts.ts';

/** 外壳只读 `controller`（本测试不需要它做事），给一个最小桩。 */
const controller = {} as ConsoleController;

function engagement(id: string, name: string): EngagementSummary {
  return {
    id,
    name,
    runMarker: 'running',
    mainStatus: 'worker_running',
    currentPhase: 'intelligence-gathering' as Phase,
    stateVersion: 3,
    graphIteration: 1,
    activeWorkerSessionId: 'w1',
    scopeEntryProfile: 'custom',
    behaviorProfile: 'stealth',
    approvalMode: 'human',
    policyVersion: 1,
    policySnapshotHash: 'sha256:test',
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T01:00:00Z',
  };
}

function session(id: string, phase: Phase): WorkerSessionSummary {
  return {
    id,
    dshSessionId: `dsh-${id}`,
    phase,
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
  };
}

const STATE: WorkflowSnapshot = {
  engagementId: 'e1',
  mainStatus: 'worker_running',
  runMarker: 'running',
  currentPhase: 'intelligence-gathering',
  stateVersion: 3,
  graphIteration: 1,
  activeWorkerSessionId: 'w1',
  scopeVersion: 1,
  authorizationExpiresAt: null,
};

function shellProps(over: Partial<ConsoleShellProps> = {}): ConsoleShellProps {
  return {
    controller,
    snapshot: {
      engagements: [engagement('e1', '内网靶场')],
      selectedEngagementId: 'e1',
      state: STATE,
      sessions: [session('s1', 'intelligence-gathering')],
      loading: false,
      lastError: null,
      conflict: false,
    },
    ...over,
  };
}

function render(over: Partial<ConsoleShellProps> = {}): string {
  return renderToStaticMarkup(createElement(ConsoleShell, shellProps(over)));
}

// ─────────────── 结构 ───────────────

test('外壳渲染总览条与两个核心屏', () => {
  const html = render();
  assert.match(html, /运行总览/, '① 运行总览条');
  assert.match(html, /阶段轨道/, '② 阶段轨道');
  assert.match(html, /会话时间轴/, '③ 会话时间轴');
});

test('每个面板标签都出现在切换条里（受控切换的基础）', () => {
  const html = render();
  const labels = ['总览与时间轴', '报告审阅', '记忆浏览器', '放行队列', '交接编辑', 'Skill 库', '范围管理', '公共记忆'];
  for (const label of labels) {
    assert.match(html, new RegExp(label), `面板 ${label} 应在切换条里`);
  }
  // 断言的是「标签数 = 面板数」这个**关系**，而不是某个具体数字：
  // 写死 7 会在每次加面板时要求人回来改数字，而那种维护动作会训练人「见红灯改数字」。
  assert.equal(labels.length, CONSOLE_PANELS.length, '每个 ConsolePanel 都要有一个可见标签');
});

test('面板切换是 WAI-ARIA tablist：选中态、roving tabindex 与 tabpanel（可访问性）', () => {
  const html = render({ activePanel: 'approvals' });
  assert.match(html, /role="tablist"/);
  assert.match(html, /role="tab"/);
  assert.match(html, /aria-selected="true"/);
  // 只有当前 tab 进 Tab 序列，其余靠左右箭头到达（否则八个面板要按八次 Tab）
  assert.match(html, /tabindex="0"/);
  assert.match(html, /tabindex="-1"/);
  assert.match(html, /role="tabpanel"/);
  assert.match(html, /aria-controls="pentest-panel-approvals"/);
});

test('engagement 入口真的渲染：它是进入作业的唯一入口，选中与否都必须可见', () => {
  // 这条断言防的是「props 里有、返回结构里没有」这类漏接线：外壳曾经构造了
  // `engagementList`（选择 / 筛选 / 新建都在里面）却从未渲染它，于是人类进不了任何作业。
  // 按结构标记断言，不按文案——文案属于 `EngagementList` 自己的测试。
  const entry = createElement('div', { className: 'injected-engagement-list' }, '作业入口占位');
  assert.match(render({ engagementList: entry }), /injected-engagement-list/);

  const unselected = render({
    engagementList: entry,
    snapshot: {
      engagements: [engagement('e1', '内网靶场')],
      selectedEngagementId: null,
      state: null,
      sessions: [],
      loading: false,
      lastError: null,
      conflict: false,
    },
  });
  assert.match(
    unselected,
    /injected-engagement-list/,
    '未选中时入口仍然要在——那正是最需要它的时机（列表为空时更是唯一的下一步）',
  );
});

test('入口显示在运行总览条之前（阅读顺序与因果顺序一致）', () => {
  const html = render({
    engagementList: createElement('div', { className: 'injected-engagement-list' }, '作业入口占位'),
  });
  // 用**结构标记**定位总览条（`pentest-runheader`），不用它的中文标题「运行总览」——
  // 改标题是与节点顺序无关的改动，却会让按文案锚定的断言变红（误报）。
  // 同文件下面几条断言（轨道 / 时间轴）已经确立了这条约定。
  const overviewAt = html.indexOf('pentest-runheader');
  assert.ok(overviewAt >= 0, '总览条的结构标记必须存在（否则下面的比较是假的）');
  assert.ok(
    html.indexOf('injected-engagement-list') < overviewAt,
    '入口决定「当前是哪个作业」，总览条说的是「它怎么样了」——入口在上面',
  );
});

// ─────────────── 未选中 engagement ───────────────

test('未选中 engagement：只渲染入口，不渲染轨道与时间轴', () => {
  const html = render({
    snapshot: {
      engagements: [engagement('e1', '内网靶场')],
      selectedEngagementId: null,
      state: null,
      sessions: [],
      loading: false,
      lastError: null,
      conflict: false,
    },
  });
  assert.match(html, /请从上方选择一个 engagement/);
  // 按**结构标记**断言，不按文案：空态的解释文字里本身就提到「阶段轨道」，
  // 用 `includes('阶段轨道')` 会误判（这是本断言最初的错误）。
  assert.equal(
    html.includes('pentest-track__node'),
    false,
    '未选中时渲染空轨道会让人以为数据丢了——轨道依赖具体 engagement 作上下文',
  );
  assert.equal(html.includes('pentest-timeline__row'), false, '同理不渲染空时间轴');
});

test('未选中且列表为空：空态说明下一步做什么', () => {
  const html = render({
    snapshot: {
      engagements: [],
      selectedEngagementId: null,
      state: null,
      sessions: [],
      loading: false,
      lastError: null,
      conflict: false,
    },
  });
  assert.match(html, /还没有任何 engagement/);
  assert.match(html, /授权向导/, '空态要指向下一步动作，而不是干说「空」');
});

// ─────────────── 面板装配 ───────────────

test('数据未到的面板说明「正在读取」；读失败时给出稳定错误码——不空白，也不撒谎', () => {
  // 面板节点由数据驱动（读到才生成），所以「没有节点」有两种原因：
  // 正在读，或读失败。原来一律说「视图组件还没有装配到这个外壳上」——把「正在读」
  // 说成「没做」，那是撒谎（§6.2.3 的 P16：空/未加载/失败必须分别表达）。
  const html = render({ activePanel: 'memory' });
  assert.match(html, /正在读取该面板的数据/);
  assert.match(html, /记忆浏览器/, '要说明是哪个面板');

  const failed = render({
    activePanel: 'memory',
    snapshot: { ...shellProps().snapshot, lastError: { code: 'console/internal', message: 'boom' } },
  });
  assert.match(failed, /该面板的数据没有读到/);
  assert.match(failed, /console\/internal/, '失败必须带稳定错误码，界面据码分支');
});

test('范围未确认时：锁定的面板显式禁用并给出原因，公共记忆仍可用', () => {
  // 这一条修的是实测缺陷：原来八个 tab 都能点、高亮也跟着走，但内容永远停在
  // intake 卡片上——点得动、内容不动，人只会以为坏了。
  const snapshot = { ...shellProps().snapshot, state: { ...STATE, scopeVersion: null } };
  const html = render({ snapshot, activePanel: 'report' });
  assert.match(html, /范围尚未确认/, '必须说明为什么锁着');
  const buttons = [...html.matchAll(/<button[^>]*role="tab"[^>]*>/g)].map((match) => match[0]);
  assert.equal(buttons.length, CONSOLE_PANELS.length);
  assert.equal(buttons.filter((button) => button.includes('disabled')).length, buttons.length - 1,
    '除公共记忆外全部禁用');
  const memory = buttons.find((button) => button.includes('公共记忆'));
  assert.ok(memory !== undefined && !memory.includes('disabled'), '公共记忆与范围无关，不能被锁');
});

test('已装配的面板渲染注入的内容', () => {
  const html = render({
    activePanel: 'report',
    panels: { report: createElement('div', { className: 'injected-report' }, '报告内容占位') },
  });
  assert.match(html, /报告审阅/, '面板标题仍在切换条里');
  assert.match(html, /injected-report/);
  assert.match(html, /报告内容占位/);
});

test('切到功能面板时不再渲染轨道与时间轴（它们属于总览面板）', () => {
  const html = render({ activePanel: 'approvals', panels: { approvals: createElement('div', null, '放行') } });
  assert.equal(html.includes('pentest-track__node'), false, '按结构标记断言，不按文案');
  assert.match(html, /放行/);
});

// ─────────────── 受控性 ───────────────

test('受控：面板由 props 决定，点击不自行改状态（服务端渲染下无状态）', () => {
  // 两次渲染同一 props 应完全相同——组件不持状态
  const a = render({ activePanel: 'overview' });
  const b = render({ activePanel: 'overview' });
  assert.equal(a, b, '相同 props 必须渲染出相同结果（受控组件的基本性质）');
});

test('受控：时间轴筛选由 props 传入并生效', () => {
  const html = render({ timelineFilter: { text: '绝不匹配' } });
  assert.match(html, /没有匹配的会话/, '筛选要真的生效，而不是外壳自己忽略它');
});

test('运行总览透传索引滞后与授权到期', () => {
  const html = render({ indexLagEvents: 5, scopeVersion: 2, authorizationExpiresAt: '2027-01-01T00:00:00Z' });
  assert.match(html, /滞后 5 条/);
  assert.match(html, /v2/);
});

test('冲突与错误经外壳透传到总览条', () => {
  const html = render({
    snapshot: {
      engagements: [engagement('e1', '内网靶场')],
      selectedEngagementId: 'e1',
      state: STATE,
      sessions: [],
      loading: false,
      lastError: { code: 'stale_state_version', message: '版本冲突' },
      conflict: true,
    },
  });
  assert.match(html, /stale_state_version/);
});

test('加载中显示提示（但不阻塞渲染已有内容）', () => {
  const html = render({
    snapshot: {
      engagements: [engagement('e1', '内网靶场')],
      selectedEngagementId: 'e1',
      state: STATE,
      sessions: [session('s1', 'intelligence-gathering')],
      loading: true,
      lastError: null,
      conflict: false,
    },
  });
  assert.match(html, /正在加载/);
  assert.match(html, /阶段轨道/, '加载时仍显示已有内容，不闪成空白');
});

test('engagement 名从列表解析；列表未加载时回落为 id 前缀', () => {
  const named = render();
  assert.match(named, /内网靶场/);

  const fallback = render({
    snapshot: {
      engagements: [],
      selectedEngagementId: 'abcdefgh-1234',
      state: STATE,
      sessions: [],
      loading: false,
      lastError: null,
      conflict: false,
    },
  });
  assert.match(fallback, /abcdefgh/, '显示截断 id 比空白好——至少能确认上下文是哪一个');
});
