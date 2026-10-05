/**
 * 控制台的**额外落点**（§6.2 的槽位表）与阶段轨道样式的回归锁。
 *
 * 这一层此前完全不存在：控制台只有一个落点——设置页的插件标签页，而它是个弹窗。
 * 后果是**状态机与各阶段 Agent 事实上不可见**：人类在聊天界面工作时看不到当前阶段，
 * 也看不到有 Agent 在等自己判断。本文件锁住补上的三个落点里最容易写错的部分。
 *
 * 三件事必须钉住：
 *
 *   1. **状态条的文案**：它是常驻可见的，算错了会一直误导人（例如把「在跑」和
 *      「等你判断」混在一起，人就看不出到底该不该介入）。
 *   2. **没有作业时不画**：常驻 UI 空着只是噪音，还会挡住下面的按钮。
 *   3. **样式表必须带行内布局**：阶段轨道的 DOM 是「节点—边—节点—边…」加回环弧线，
 *      缺 `display:flex` 会退化成竖向文字列表——那正是「状态机没显示出来」的原因。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import type { EngagementSummary, WorkerSessionSummary } from '../src/contracts.ts';
import type { ConsoleSnapshot } from '../src/client/controller.ts';
import { PentestPanelFrame, PentestStatusPill, statusPillFacts } from '../src/client/surfaces.tsx';
import { SessionChat } from '../src/client/views/SessionChat.tsx';
import { PENTEST_CSS } from '../src/client/styles.ts';
import { PALETTE, TOKEN_ROOT_SELECTOR, contrastRatio, definedTokens, tokenCss } from '../src/client/design.ts';
import type { PaletteKey } from '../src/client/design.ts';
import { FONT_BYTES, FONT_SRC } from '../src/client/fontAssets.ts';

test('主面板为常驻状态条留出底部空间（否则最后几行会被 fixed 状态条压住）', () => {
  // 回归锁：实测在 24px 留白下，确认面板的最后一段（执行约束、版本与快照哈希）
  // 被 `shell.overlay` 的固定状态条压住 475px——那几行正是「确认前必须看到的东西」。
  // 这类缺陷在 jsdom/静态标记里看不出来，只能在真实浏览器里量，因此用数值把它钉住。
  const html = renderToStaticMarkup(createElement(PentestPanelFrame, null, createElement('div', null, 'x')));
  const padding = /padding:\s*([^;"]+)/.exec(html)?.[1] ?? '';
  const bottom = Number(/(\d+)px$/.exec(padding.trim())?.[1] ?? '0');
  assert.ok(bottom >= 88, `底部留白必须 ≥88px 才能让开状态条，实际 ${padding}`);
  assert.match(html, /overflow:\s*auto/, '主面板必须自己滚动，否则内容会被裁掉');
});

/** 会话摘要的最小构造：这些断言只看 status 与 iteration。 */
function session(id: string, status: WorkerSessionSummary['status']): WorkerSessionSummary {
  return {
    id,
    dshSessionId: `dsh-${id}`,
    phase: 'intelligence-gathering',
    status,
    attempt: 1,
    iteration: 1,
    scopeVersion: 1,
    previousAgentSessionId: null,
    retryOfSessionId: null,
    transitionId: null,
    statusNote: null,
    statusNoteSource: null,
    statusNoteAt: null,
    startedAt: null,
    endedAt: null,
    createdAt: '2026-09-19T10:00:00.000Z',
  };
}

function engagement(id: string, name: string): EngagementSummary {
  return {
    id,
    name,
    runMarker: 'running',
    mainStatus: 'worker_running',
    currentPhase: 'intelligence-gathering',
    stateVersion: 1,
    graphIteration: 1,
    activeWorkerSessionId: null,
    scopeEntryProfile: 'custom',
    behaviorProfile: 'stealth',
    approvalMode: 'human',
    policyVersion: 1,
    policySnapshotHash: 'sha256:test',
    createdAt: '2026-09-19T10:00:00.000Z',
    updatedAt: '2026-09-19T10:00:00.000Z',
  };
}

function snapshot(over: Partial<ConsoleSnapshot> = {}): ConsoleSnapshot {
  return {
    engagements: [],
    selectedEngagementId: null,
    state: null,
    sessions: [],
    loading: false,
    lastError: null,
    conflict: false,
    loadedAt: null,
    ...over,
  };
}

// ─────────────────── 状态条的内容 ───────────────────

test('未选择作业时状态条不engaged（常驻 UI 空着只是噪音）', () => {
  const facts = statusPillFacts(snapshot());
  assert.equal(facts.engaged, false);
  // 没选中作业就不该画——否则会在页面上常驻一条「未选择作业」，还挡着下面的按钮。
  const html = renderToStaticMarkup(
    createElement(PentestStatusPill, { facts, onOpen: () => undefined }),
  );
  assert.equal(html, '');
});

test('选中作业时状态条给出作业名、阶段与运行标记', () => {
  const facts = statusPillFacts(
    snapshot({
      engagements: [engagement('e1', '内部靶场 A 轮')],
      selectedEngagementId: 'e1',
      state: {
        engagementId: 'e1',
        mainStatus: 'worker_running',
        runMarker: 'paused',
        currentPhase: 'threat-modeling',
        stateVersion: 3,
        graphIteration: 1,
        activeWorkerSessionId: null,
        scopeVersion: 1,
        authorizationExpiresAt: null,
      },
    }),
  );

  assert.equal(facts.engaged, true);
  assert.equal(facts.title, '内部靶场 A 轮');
  assert.equal(facts.phase, '威胁建模', '阶段名必须走 phaseLabel，不能把内部标识直接显示给人');
  assert.equal(facts.runMarker, '已暂停');
});

test('「等你判断」与「在跑」分开计数——这是状态条存在的首要理由', () => {
  // 两者混在一起，人就分不出「Agent 正在干活，别打扰」和「它在等我，我该去看」。
  // 前者的正确动作是等待，后者是不等就会一直卡住。
  const facts = statusPillFacts(
    snapshot({
      engagements: [engagement('e1', '作业')],
      selectedEngagementId: 'e1',
      sessions: [
        session('s1', 'active'),
        session('s2', 'active'),
        session('s3', 'waiting_human'),
        // 已结束的会话两种都不算（真实取值见 SessionStatus）。
        session('s4', 'closed'),
        session('s5', 'failed'),
      ],
    }),
  );

  assert.equal(facts.running, 2);
  assert.equal(facts.waiting, 1);
});

test('有待你判断时用 attention 语气并写明数量', () => {
  const facts = statusPillFacts(
    snapshot({
      engagements: [engagement('e1', '作业')],
      selectedEngagementId: 'e1',
      sessions: [session('s1', 'waiting_human')],
    }),
  );
  const html = renderToStaticMarkup(
    createElement(PentestStatusPill, { facts, onOpen: () => undefined }),
  );
  assert.match(html, /1 待你判断/, '数量必须写出来，只说「有待办」人不知道该急到什么程度');
  assert.match(html, /pentest-statusbar--attention/);
});

test('只有 Agent 在跑时不用 attention（那不需要人类介入）', () => {
  const facts = statusPillFacts(
    snapshot({
      engagements: [engagement('e1', '作业')],
      selectedEngagementId: 'e1',
      sessions: [session('s1', 'active')],
    }),
  );
  const html = renderToStaticMarkup(
    createElement(PentestStatusPill, { facts, onOpen: () => undefined }),
  );
  assert.match(html, /1 在跑/);
  assert.doesNotMatch(html, /待你判断/);
  assert.doesNotMatch(html, /pentest-statusbar--attention/);
});

test('状态条在上栏且可点击（2026-10-05 起不再用底部浮层）', () => {
  const facts = statusPillFacts(
    snapshot({ engagements: [engagement('e1', '作业')], selectedEngagementId: 'e1' }),
  );
  const html = renderToStaticMarkup(
    createElement(PentestStatusPill, { facts, onOpen: () => undefined }),
  );
  // **位置回归锁**：底部浮层会压住宿主输入区/提问卡（人类报的重叠）。
  // 现在挂在 `conversation.header` 的文档流里，因此不得再出现 fixed 定位。
  assert.ok(!html.includes('position:fixed'), '不得再用浮动定位');
  assert.match(html, /role="button"/);
  assert.match(html, /打开控制台/);
});

// ─────────────────── 样式表 ───────────────────

test('阶段轨道必须横向排列：缺 flex 会退化成竖向文字列表（状态机就看不见了）', () => {
  // 这是「状态机没显示出来」的根因：DOM 结构本来就是「节点—边—节点—边…」，
  // 但没有任何样式文件定义 `.pentest-track`，浏览器按默认的块级流逐行堆叠，
  // 五个节点与四条边各占一行——一张状态机图看起来就是五条文字。
  assert.match(PENTEST_CSS, /\.pentest-track\{[^}]*display:flex/);
  // 节点要定宽：否则长便签会把某一列撑开，整排错位。
  assert.match(PENTEST_CSS, /\.pentest-track__node\{[^}]*flex:0 0 \d+px/);
  // 边要有可见的线：只有标签没有线，人看不出节点之间是什么关系。
  assert.match(PENTEST_CSS, /\.pentest-track__edge::before\{[^}]*border-top/);
  // 回环用弧线单独表达（§5.5：回环意味着攻击深度变了，不能与序列边混为一谈）。
  assert.match(PENTEST_CSS, /\.pentest-track__loop\{[^}]*border-radius/);
});

test('有结构证据的边与仅有时间顺序的边必须视觉可区分（§6.2 ②）', () => {
  // 只有序列边是虚线；交接/重做/回环是实线加语义色——「被证明的关系」在视觉上
  // 必须区别于「时间顺序」，否则人类无法据这张图判断因果关系是否成立。
  assert.match(PENTEST_CSS, /\.pentest-track__edge--pending::before\{[^}]*dotted/);
  assert.match(PENTEST_CSS, /\.pentest-track__edge--active::before\{[^}]*border-top-style:solid/);
});

test('样式不硬编码颜色：颜色只在设计系统里定义一次，组件规则只引用令牌', () => {
  // 方向已由人类显式决定：**深色单主题的磷光终端**（2026-10-04）。于是「深浅色自动
  // 跟随」不再是这条约定的目标，取而代之的是两条更硬的规则：
  //   1. 颜色只在 `design.ts` 的令牌块里出现字面值（那是唯一允许的地方）；
  //   2. 组件规则（外壳/面板/会话）只允许 `var(--pt-*)`。
  // 把令牌块摘掉再检查字面颜色，就同时锁住了这两条。
  const tokenBlock = new RegExp(
    `${TOKEN_ROOT_SELECTOR.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\{[^}]*\\}`,
  );
  const componentCss = PENTEST_CSS.replace(tokenBlock, '');
  assert.ok(componentCss.length < PENTEST_CSS.length, '令牌块必须真的存在（根元素选择器清单 + 一块规则）');
  const literals = componentCss.match(/(#[0-9a-fA-F]{3,8}\b|\brgba?\(|\bhsla?\()/g);
  assert.equal(literals, null, `组件规则里出现了字面颜色：${String(literals)}`);
  // 反向：确认组件真的用了令牌——否则上面那条也可能是因为压根没写颜色。
  assert.ok(componentCss.includes('var(--pt-accent)'), '颜色必须来自设计令牌');
});

test('字体随包内联：Cascadia Mono（OFL）与设计系统声明的一致', () => {
  // 离线环境取不到 webfont；族名也不能用真名 "Cascadia Mono"，否则本机装了同名字体时
  // 会命中那份而不是随包的这一份（不同机器渲染不一致）。
  assert.match(PENTEST_CSS, /@font-face\{font-family:"Pentest Cascadia Mono"/);
  assert.ok(FONT_SRC.startsWith('data:font/ttf;base64,'), '字体必须内联成 data URI');
  assert.equal(
    Buffer.from(FONT_SRC.slice(FONT_SRC.indexOf(',') + 1), 'base64').length,
    FONT_BYTES,
    '内联字节数必须与 assets/fonts 里的源文件一致（生成物过期会在这里失败）',
  );
});

test('引用的每个令牌都已定义（写错的令牌不报错，只会静默变成空值）', () => {
  const defined = new Set(definedTokens());
  const used = new Set(
    [...PENTEST_CSS.matchAll(/var\((--pt-[a-z0-9-]+)/g)].map((match) => match[1]!),
  );
  const unknown = [...used].filter((token) => !defined.has(token));
  assert.deepEqual(
    unknown,
    [],
    '这些令牌没有定义，引用它们会静默变成空值/透明：' + unknown.join(', '),
  );
});

test('深色单主题的对比度达标：对**最不利背景**复核（改色会在这里失败）', () => {
  // 上一版只对 `bg` 算，漏了更亮的 module 表面与四种语义底纹——实测线上抓到
  // `inkFaint` 在 module 上只有 4.36:1（标签、提示文字都在那儿）。所以这里把
  // 背景集合补全，并且**从 design.ts 实际写的 rgba 值**推底纹，避免两处漂移。
  const rgbOf = (hex: string): readonly [number, number, number] => {
    const v = hex.replace('#', '');
    return [0, 2, 4].map((o) => Number.parseInt(v.slice(o, o + 2), 16)) as unknown as readonly [number, number, number];
  };
  const mixOn = (fg: string, alpha: number, bg: string): string => {
    const [r1, g1, b1] = rgbOf(fg);
    const [r2, g2, b2] = rgbOf(bg);
    const blend = (a: number, b: number): number => Math.round(a * alpha + b * (1 - alpha));
    return `#${[blend(r1, r2), blend(g1, g2), blend(b1, b2)]
      .map((n) => n.toString(16).padStart(2, '0'))
      .join('')}`;
  };
  const css = tokenCss();
  const wash = (name: string): string => {
    const m = new RegExp(`--pt-${name}:rgba\\((\\d+),(\\d+),(\\d+),([0-9.]+)\\)`).exec(css);
    assert.ok(m !== null, `design.ts 里必须有 --pt-${name} 的 rgba 定义`);
    const hex = `#${[m[1]!, m[2]!, m[3]!].map((n) => Number(n).toString(16).padStart(2, '0')).join('')}`;
    return mixOn(hex, Number(m[4]), PALETTE.raise);
  };
  const surfaces: readonly string[] = [
    PALETTE.void,
    PALETTE.bg,
    PALETTE.raise,
    PALETTE.inset,
    wash('accent-wash'),
    wash('wait-wash'),
    wash('danger-wash'),
    wash('info-wash'),
  ];
  const textTokens: readonly PaletteKey[] = ['ink', 'inkDim', 'inkFaint', 'sky', 'skyDim', 'amber', 'red', 'info'];
  for (const token of textTokens) {
    for (const surface of surfaces) {
      const ratio = contrastRatio(PALETTE[token], surface);
      assert.ok(
        ratio >= 4.5,
        `${token} (${PALETTE[token]}) 在 ${surface} 上的对比度只有 ${ratio.toFixed(2)}:1（阈值 4.5）`,
      );
    }
  }
  // 主按钮：void 文字落在 accent 实底上。
  assert.ok(contrastRatio(PALETTE.void, PALETTE.sky) >= 4.5, '主按钮文字对比度不足（void 文字落在天蓝实底上）');
});

test('令牌块挂在每个渲染入口上（漏一个，那块界面就静默无样式）', () => {
  // 插件的渲染入口不止一个：全高主面板、常驻状态条、会话卡片、只读轨迹。
  // 令牌块只挂在 `.pentest-console` 上的话，其它入口拿不到任何颜色/字体令牌。
  for (const root of [
    '.pentest-console',
    '.pentest-mainpanel',
    '.pentest-statusbar',
    '.pentest-intake',
    '.pentest-chat-card',
    '.pentest-trace',
  ]) {
    assert.ok(TOKEN_ROOT_SELECTOR.includes(root), `令牌选择器清单缺少 ${root}`);
    assert.ok(PENTEST_CSS.includes(TOKEN_ROOT_SELECTOR), '令牌块必须真的注入');
  }
});

test('根元素清单只能整体当选择器用（加后代前缀会把声明落到根元素自己身上）', () => {
  // 实测踩过：`${ROOTS} ::selection` 这种写法里，逗号清单只有**最后一项**带上了
  // 后面那段，前面的根元素自己拿到声明——滚动条规则里的 `width:10px` 因此把
  // 主面板压成 35px 宽，界面看起来一片空白而源码毫无异常。
  // 修法是包一层 `:is(...)`；这条断言锁住它不被写回去。
  const raw = TOKEN_ROOT_SELECTOR.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  for (const match of PENTEST_CSS.matchAll(new RegExp(raw, 'g'))) {
    const next = PENTEST_CSS[match.index + match[0].length] ?? '';
    assert.ok(
      next === '{' || next === ')' || next === ',',
      `根元素清单后面只能跟 {、) 或 ,，实际是 ${JSON.stringify(next)}：` +
        PENTEST_CSS.slice(Math.max(0, match.index - 30), match.index + match[0].length + 20),
    );
  }
  // `:where()` 里不能放伪元素（Chromium 序列化成空选择器，规则永不生效）。
  assert.equal(/:where\(::/.test(PENTEST_CSS), false, '伪元素不能放进 :where()');
});

// ─────────────────── 授权会话：输入区不吸附 ───────────────────

test('会话输入区在记录流之后且不吸附——否则它会随主面板滚动在记录之间穿梭', () => {
  // 注释要先剥掉：`([^{}]+)\{` 会把规则前的注释块一起吞进「选择器」里，匹配必然失手。
  const css = PENTEST_CSS.replace(/\/\*[\s\S]*?\*\//g, '');
  const ruleBodies = (selector: string): string => {
    const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return [...css.matchAll(/([^{}]+)\{([^}]*)\}/g)]
      .filter((match) => new RegExp(`(^|,)\\s*${escaped}\\s*(,|$)`).test(match[1]!.trim()))
      .map((match) => match[2]!)
      .join('');
  };

  // 曾经的形状：`position:sticky;bottom:0`。它的最近滚动祖先是**外层主面板**（记录流是兄弟、
  // 不是祖先），于是输入区脱离原位、悬在面板底部随滚动在记录之间穿梭（人类报障，2026-10-04）。
  const composer = ruleBodies('.pentest-session-chat__composer');
  assert.ok(composer.length > 0, '必须存在 .pentest-session-chat__composer 规则');
  assert.ok(
    !/position\s*:\s*(sticky|fixed|absolute)/.test(composer),
    '输入区必须留在正常文档流：任何吸附都会以**外层主面板**为参照（记录流不是它的祖先）',
  );

  // 记录流自己滚：翻记录只动它内部，输入区原地不动。
  const transcript = ruleBodies('.pentest-session-chat');
  assert.match(transcript, /overflow-y\s*:\s*auto/, '记录流必须自己滚动');
  assert.match(transcript, /max-height\s*:/, '记录流必须有高度上限，否则整屏一起滚');

  // 结构：输入区必须是记录流的**兄弟**（在其闭合标签之后），不是它的子元素。
  const html = renderToStaticMarkup(
    createElement(SessionChat, {
      controller: {} as never,
      snapshot: { intake: { dshSessionId: 'dsh-layout-probe' } } as never,
      rpc: undefined,
      proposal: null,
    } as never),
  );
  const open = html.indexOf('<div class="pentest-session-chat"');
  assert.ok(open >= 0, '记录流必须渲染出来');
  const composerIndex = html.indexOf('pentest-session-chat__composer');
  assert.ok(composerIndex > open, '输入区必须出现在记录流之后');

  // 按 div 深度找到记录流的闭合位置：输入区必须在它**之后**（嵌进去就又会被浏览器裁切/跟随滚动）。
  let depth = 0;
  let closedAt = -1;
  const tag = /<div\b|<\/div>/g;
  tag.lastIndex = open;
  for (let match = tag.exec(html); match !== null; match = tag.exec(html)) {
    depth += match[0] === '</div>' ? -1 : 1;
    if (depth === 0) {
      closedAt = match.index;
      break;
    }
  }
  assert.ok(closedAt > 0, '记录流的 div 必须闭合');
  assert.ok(composerIndex > closedAt, '输入区必须在记录流的闭合标签之后（不能嵌在记录流里面）');
});

test('「弱背景」用的是设计系统里的 wash 令牌，而不是某个未定义的色名', () => {
  // 直接钉死踩过一次的那个失败模式：令牌未定义时 `var()` 不报错、只是变透明。
  // 关键闸门（我已核对范围）必须有可见的背景块。
  const bodies = [...PENTEST_CSS.matchAll(/([^{}]+)\{([^}]*)\}/g)]
    .filter((match) => /(^|,)\s*\.pentest-wizard__ack\s*(,|$)/.test(match[1]!.trim()))
    .map((match) => match[2]!)
    .join('');
  assert.ok(bodies.length > 0, '必须存在 .pentest-wizard__ack 的规则');
  assert.ok(
    /background:var\(--pt-[a-z-]*wash\)/.test(bodies),
    '关键闸门（我已核对范围）必须有可见的背景块',
  );
});

// 宿主令牌清单（`--dsw-alias-*`）已随视觉方向变更一并移除：深色单主题不再依赖宿主
// 颜色令牌，「引用了未定义令牌」这条断言改由 `definedTokens()` 对照设计系统做（见上）。


test('状态条：作业名里的控制序列在渲染前剥掉（终端里粘出来的名字不该把乱码带进上栏）', () => {
  const facts = statusPillFacts(
    snapshot({
      engagements: [engagement('e1', '47.109.76.66:3002 渗透测试\u001b[13;28;13;1;0;1_')],
      selectedEngagementId: 'e1',
    }),
  );
  assert.equal(facts.title, '47.109.76.66:3002 渗透测试', 'ANSI 与丢失 ESC 的裸坐标标记都必须剥掉');
  const html = renderToStaticMarkup(createElement(PentestStatusPill, { facts, onOpen: () => undefined }));
  assert.ok(!html.includes('13;28'), '渲染结果里不得出现那串乱码');
});

test('状态条：审批模式一键切换按钮（当前档位可见；缺回调时不画）', () => {
  const facts = statusPillFacts(
    snapshot({
      engagements: [{ ...engagement('e1', '内部靶场 A 轮'), approvalMode: 'auto' }],
      selectedEngagementId: 'e1',
    }),
  );
  assert.equal(facts.approvalMode, 'auto');

  const html = renderToStaticMarkup(
    createElement(PentestStatusPill, { facts, onOpen: () => undefined, onToggleMode: () => undefined }),
  );
  assert.match(html, /pentest-statusbar__mode/, '要有切换按钮');
  assert.match(html, /审批：高权限（Agent 自行放行）/, '当前档位必须直接显示在按钮上');
  assert.match(html, /切到「人工审批」/, 'tooltip 要说清点一下会切到哪一档');
  assert.match(html, /不需要理由/, 'tooltip 里写明不需要理由（人类是主人）');

  const bare = renderToStaticMarkup(createElement(PentestStatusPill, { facts, onOpen: () => undefined }));
  assert.ok(!bare.includes('pentest-statusbar__mode'), '没有切换回调时不画按钮（避免死键）');
});
