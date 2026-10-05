/**
 * 控制台在 Web 外壳里的**额外落点**（§6.2 的槽位表）。
 *
 * ── 为什么需要这个文件 ──
 *
 * 此前控制台只有一个落点：设置页的插件标签页（`settings.plugins.tab`）。那是个弹窗，
 * 高度有限，而且要点「设置 → 插件 → 渗透作业」三步才看得到——结果是**状态机与各阶段
 * Agent 事实上不可见**：人类在聊天界面工作时，看不到当前阶段、看不到谁在等自己判断、
 * 也不知道 Agent 正在做什么。
 *
 * §6.2 的槽位表其实已经指定了四个落点，这里补上其中三个可在本版本实现的：
 *
 * | 槽位 | 本文件里的组件 | 作用 |
 * |---|---|---|
 * | `main`（keyed） | {@link PentestPanelFrame} | **全高主面板**：控制台不再挤在弹窗里 |
 * | `sidebar.panellist`（list） | {@link PentestSidebarGlyph} | 侧栏入口：一键进入主面板 |
 * | `shell.overlay`（list） | {@link PentestStatusPill} | **常驻状态条**：不打开任何东西也能看见阶段与待办 |
 *
 * ── 两个必须记住的契约（实测自实装包）──
 *
 * 1. **`sidebar.panellist` 的 `id` 必须同时是 `main` 槽的 key**。侧栏行点击走
 *    `ctx.layout.selectPanel(id)`，而 `LayoutController.selectPanel` 对未注册的主面板
 *    **直接抛错**（`layout.selectPanel: main panel "…" is not registered`）。
 *    因此 {@link PENTEST_PANEL_ID} 是两处共用的**单一来源**，不能各写一份。
 *
 * 2. **`rightbar` 不能用**。它是 `single` 槽且已被官方 `ui-sidebar-right` 以 priority 0
 *    占据；同优先级再注册会抛 `single slot "rightbar" already has a registration`，
 *    换优先级则意味着**整体顶掉官方右栏**（连它声明的 `rightbar.session` 一起消失）。
 *    §6.2 把「常驻助手」放在 `rightbar`，本版本改用 `shell.overlay` —— 官方注释原话是
 *    「the additive seat for a frame-wide surface of your own: a fresh id is added beside
 *    the shipped entries instead of replacing them」，正是这里需要的语义。
 *
 * ── 布局为什么用内联样式 ──
 *
 * 本仓没有 CSS 文件，`pentest-*` 类名是语义标记。约束是**不硬编码颜色**（颜色走
 * `tone`/`className`，由官方设计令牌决定深浅色），而 `height`/`overflow`/`pointerEvents`
 * 这类结构性样式没有语义类可用，只能内联。这不是破例：内联里没有任何颜色值。
 */

import { createElement, useEffect, useState } from 'react';
import type { ReactNode } from 'react';

import type { ConsoleController, ConsoleSnapshot } from './controller.ts';
import type { ApprovalMode } from '../contracts.ts';
import { stripControlSequences } from './session-chat.ts';
import { APPROVAL_MODE_LABELS } from './presets.ts';
import { useConsoleSnapshot } from './hooks.ts';
import { phaseLabel, runMarkerLabel } from './format.ts';
import { Badge, toneClass } from './ui.tsx';

/**
 * 主面板与侧栏行共用的标识。
 *
 * 两处必须一致（见文件头契约 1），因此只有这一个常量。
 */
export const PENTEST_PANEL_ID = 'pentest';

// ───────────────────────────── 侧栏入口 ─────────────────────────────

/**
 * 侧栏行的图标。
 *
 * 侧栏只渲染这个 glyph（`renderSlot('sidebar.panellist', {size, active}, {only: id})`），
 * 行标题由 `label` 单独渲染。**用 `currentColor` 而不是具体颜色**：侧栏的选中态与
 * 深浅色主题都由官方样式驱动，写死颜色会让图标在深色模式下不可读。
 */
export function PentestSidebarGlyph(props: {
  readonly size: number;
  readonly active: boolean;
}): ReactNode {
  return createElement(
    'svg',
    {
      width: props.size,
      height: props.size,
      viewBox: '0 0 24 24',
      fill: 'none',
      stroke: 'currentColor',
      // 选中态加粗：侧栏的 other rows 用官方样式表达选中，这里只有 glyph，因此自己表达。
      strokeWidth: props.active ? 2 : 1.6,
      strokeLinecap: 'round',
      strokeLinejoin: 'round',
      'aria-hidden': 'true',
      focusable: 'false',
    },
    // 盾牌 + 准星：本设计的语义是「在授权边界内瞄准」，不是「武器」。
    createElement('path', { d: 'M12 3 5 6v5.5c0 4.2 2.9 8 7 9.5 4.1-1.5 7-5.3 7-9.5V6l-7-3Z' }),
    createElement('circle', { cx: 12, cy: 11, r: 2.4 }),
    createElement('path', { d: 'M12 7.4v1.1M12 13.5v1.1M8.4 11h1.1M14.5 11h1.1' }),
  );
}

// ───────────────────────────── 主面板 ─────────────────────────────

/**
 * 底部留白：常驻状态条（`shell.overlay`）由宿主渲染为 **fixed** 元素，会盖住滚动内容的末尾。
 *
 * 数字不是"看起来差不多"：实测在 24px 时，确认面板的最后一段（执行约束、版本与快照哈希）
 * 被状态条压住 475px——那几行恰好是「人类确认前必须看到的东西」，被盖住等于没展示。
 * 状态条高度约 56px，这里再留一点余量。
 */
const OVERLAY_CLEARANCE_PX = 96;

/**
 * 主面板外框：让控制台占满中央列并可滚动。
 *
 * 中央列的高度由外壳的布局求解给出，因此这里只需 `height: 100%` + `overflow: auto`。
 * 不设 `width`：横向由布局决定，自己设宽会在侧栏折叠/展开时错位。
 */
export function PentestPanelFrame(props: { readonly children: ReactNode }): ReactNode {
  return createElement(
    'div',
    {
      className: 'pentest-mainpanel',
      style: {
        height: '100%',
        overflow: 'auto',
        padding: `12px 16px ${String(OVERLAY_CLEARANCE_PX)}px`,
      },
    },
    props.children,
  );
}

// ───────────────────────────── 常驻状态条 ─────────────────────────────

/**
 * 从快照里摘出「人类现在需要知道什么」。
 *
 * 纯函数：状态条的**全部**内容都由它决定，因此可以脱离 React 断言
 * （哪些情况显示什么，是这一屏最容易出错、也最该被锁住的部分）。
 */
export interface StatusPillFacts {
  /** 一行主文本：作业名，或「未选择作业」。 */
  readonly title: string;
  /** 阶段名（没有阶段时不显示）。 */
  readonly phase: string | null;
  readonly runMarker: string;
  /** 等待人工判断的会话数。 */
  readonly waiting: number;
  /** 正在跑的会话数。 */
  readonly running: number;
  /** 有活动作业时为 true（决定状态条是否值得画）。 */
  readonly engaged: boolean;
  /** 当前审批模式（未选中作业时为 null）——状态条上可直接切换。 */
  readonly approvalMode: ApprovalMode | null;
}

export function statusPillFacts(snapshot: ConsoleSnapshot): StatusPillFacts {
  const selected = snapshot.selectedEngagementId;
  const engagement =
    selected === null ? undefined : snapshot.engagements.find((e) => e.id === selected);
  const state = snapshot.state;

  // 会话状态是「谁在等我」的唯一来源：`waiting_human` 就是 Agent 交了报告、人类还没处理。
  // 刻意**不**显示审批队列计数——那要额外拉 `listApprovals`，而状态条是常驻的，
  // 让它在页面上一直发请求不值得；等待人工的会话数已经足以提示「该去看一眼了」。
  let waiting = 0;
  let running = 0;
  for (const session of snapshot.sessions) {
    if (session.status === 'waiting_human') waiting += 1;
    else if (session.status === 'active') running += 1;
  }

  return {
    // 控制序列（从终端粘进来的 ANSI / 丢了 ESC 的裸坐标标记）在渲染前剥掉：
    // 作业名与便签都可能带进来，而它们会直接显示在这一行里。
    title: stripControlSequences(engagement === undefined ? '未选择作业' : engagement.name),
    approvalMode: engagement?.approvalMode ?? null,
    phase: state?.currentPhase == null ? null : phaseLabel(state.currentPhase),
    runMarker: runMarkerLabel(state?.runMarker ?? 'running'),
    waiting,
    running,
    engaged: engagement !== undefined,
  };
}

/**
 * 常驻状态条（`shell.overlay`）。
 *
 * 存在的理由：**不打开任何界面也能看见渗透的状态**。此前人类必须点进设置弹窗才知道
 * 有没有 Agent 在等自己，而「等人工判断」正是这套设计里最需要被及时看到的信号。
 *
 * 点击进入主面板。那个动作走 `ctx.layout.selectPanel`，而 `layout` **不放进 `inject`**：
 * `inject` 是**等待**语义（服务不出现会让整个插件永不 apply 且不报错），一个可选的
 * 跳转能力不值得那个风险。改为点击时容错读取，失败只记日志。
 */
export function PentestStatusPill(props: {
  readonly facts: StatusPillFacts;
  readonly onOpen: () => void;
  /** 点击切换审批模式（人工审批 ⇄ 高权限）；缺省即不显示该按钮。 */
  readonly onToggleMode?: (() => void) | undefined;
  /** 正在切换（禁用按钮并显示过渡文案）。 */
  readonly modeBusy?: boolean;
  /** 切换失败的原因（有值时显示在状态条里——不能静默：按钮看着没反应最费人）。 */
  readonly modeError?: string | null;
}): ReactNode {
  const { facts } = props;
  // 没有选中作业时不占屏幕：状态条的价值在于「有东西在跑或有人等你」，
  // 空着一条常驻 UI 只是噪音。
  if (!facts.engaged) return null;

  const tone = facts.waiting > 0 ? 'attention' : facts.running > 0 ? 'active' : 'neutral';
  const otherMode = facts.approvalMode === null ? null : facts.approvalMode === 'auto' ? 'human' : 'auto';

  return createElement(
    'div',
    {
      className: toneClass('pentest-statusbar', tone),
      // 2026-10-05 起挂在 `conversation.header`（会话上栏，宿主「渗透模式」那一行）：
      // 之前是屏幕下方居中的常驻胶囊，会压住宿主输入区与提问卡（人类报的重叠）。
      // 这里是文档流内的一行，不再需要浮层那套「让位/穿透」技巧。
      style: {
        display: 'inline-flex',
        alignItems: 'center',
        gap: '8px',
        maxWidth: '100%',
        padding: '2px 6px',
        cursor: 'pointer',
      },
      role: 'button',
      tabIndex: 0,
      title: '打开渗透作业控制台',
      onClick: props.onOpen,
      onKeyDown: (event: { readonly key: string }) => {
        if (event.key === 'Enter' || event.key === ' ') props.onOpen();
      },
    },
    createElement('strong', { className: 'pentest-statusbar__title' }, facts.title),
    facts.phase === null ? null : createElement(Badge, { text: facts.phase, tone: 'active' }),
    createElement(Badge, { text: facts.runMarker, tone: 'neutral' }),
    facts.running > 0 ? createElement(Badge, { text: `${String(facts.running)} 在跑`, tone: 'active' }) : null,
    // 待办用 attention：这是状态条存在的首要理由，视觉上必须最先被看到。
    facts.waiting > 0
      ? createElement(Badge, {
          text: `${String(facts.waiting)} 待你判断`,
          tone: 'attention',
          hint: '这些会话已经交了报告或明确阻塞，在等你决定下一步',
        })
      : null,
    // 审批模式：一键切换（人类是主人——不要求理由）。切换写新策略版本并推进 policy epoch，
    // 旧放行凭证与在途计划当场失效，所以不需要确认弹窗：点击即生效，账本里看得见。
    facts.approvalMode === null || otherMode === null || props.onToggleMode === undefined
      ? null
      : createElement(
          'button',
          {
            type: 'button',
            className: 'pentest-statusbar__mode',
            disabled: props.modeBusy === true,
            title:
              `当前审批模式：${APPROVAL_MODE_LABELS[facts.approvalMode]}。` +
              `点击切到「${APPROVAL_MODE_LABELS[otherMode]}」——运行中随时可切、不需要理由；` +
              '切换会写新策略版本并推进 policy epoch（旧放行凭证与在途计划当场失效）。',
            onClick: (event: { readonly stopPropagation: () => void }) => {
              // 状态条整体点击是「打开控制台」，这个按钮必须拦住冒泡。
              event.stopPropagation();
              props.onToggleMode?.();
            },
          },
          props.modeBusy === true ? '切换中…' : `审批：${APPROVAL_MODE_LABELS[facts.approvalMode]} ⇄`,
        ),
    props.modeError == null
      ? null
      : createElement('span', { className: 'pentest-statusbar__mode-error', role: 'alert' }, props.modeError),
    createElement('span', { className: 'pentest-statusbar__hint' }, '打开控制台 →'),
  );
}

// ───────────────────────────── 数据接入 ─────────────────────────────

export function StatusPillSurface(props: {
  readonly controller: ConsoleController;
  readonly onOpen: () => void;
}): ReactNode {
  const snapshot = useConsoleSnapshot(props.controller);
  const [modeBusy, setModeBusy] = useState(false);
  const [modeError, setModeError] = useState<string | null>(null);
  const selected = snapshot.selectedEngagementId;
  const toggleMode = (): void => {
    if (selected === null || modeBusy) return;
    const current = snapshot.engagements.find((entry) => entry.id === selected)?.approvalMode ?? 'human';
    setModeBusy(true);
    setModeError(null);
    // 不要求理由：人类是主人。`mutate` 的第三参传空串（服务端对该端点不校验理由）；
    // 账本里照样记下操作者、from/to 与时间。
    void props.controller
      .mutate('setApprovalMode', { engagementId: selected, approvalMode: current === 'auto' ? 'human' : 'auto' }, '')
      .then(async (result) => {
        if (!result.ok) {
          setModeError(`${result.code}：${result.message}`);
          return;
        }
        // 档位显示来自**作业列表**（`EngagementSummary.approvalMode`）：不重拉列表，
        // 按钮会停在旧档位——实测点完看着「没反应」，而库里其实已经切了。
        await props.controller.refreshEngagements();
      })
      .catch((cause: unknown) => {
        setModeError(cause instanceof Error ? cause.message : String(cause));
      })
      .finally(() => { setModeBusy(false); });
  };
  return createElement(PentestStatusPill, {
    facts: statusPillFacts(snapshot),
    onOpen: props.onOpen,
    onToggleMode: toggleMode,
    modeBusy,
    modeError,
  });
}

/**
 * 页面级共享的控制器。
 *
 * ── 为什么共享 ──
 *
 * 控制台现在有多个挂载面（设置页标签、全高主面板、常驻状态条）。各自 `new` 一个控制器会让
 * 同一屏里存在多份快照——状态条说「2 待你判断」而主面板说「1」；而且每个实例都会各自拉
 * 一遍 engagement 列表。
 *
 * 共享是安全的：控制器**不持有权威状态**（§6.2.3），它只是 Host 事实的只读投影，外加一个
 * 「当前选中作业」的界面状态——后者本来就该全局一致。
 *
 * ── 为什么按 rpc 身份重建 ──
 *
 * `connection` 服务在重连时会换 generation，旧句柄就此失效。把控制器钉死在第一次拿到的
 * 句柄上，重连后所有读写都会失败。因此记住创建时的 rpc 身份，变了就换一个新的控制器。
 */
const shared: {
  rpc: unknown;
  controller: ConsoleController | undefined;
} = { rpc: undefined, controller: undefined };

export function useSharedController<R>(
  getRpc: () => R | undefined,
  create: (rpc: R) => ConsoleController,
): ConsoleController | undefined {
  const [controller, setController] = useState<ConsoleController | undefined>(() => {
    const rpc = getRpc();
    if (rpc === undefined) return undefined;
    if (shared.controller === undefined || shared.rpc !== rpc) {
      shared.rpc = rpc;
      shared.controller = create(rpc);
    }
    return shared.controller;
  });

  // 依赖数组为空是**有意的**：这里要做的是「每次渲染后校对一次」，而不是「随某个值变化」。
  // 校对本身极便宜（一次函数调用 + 身份比较），且收敛——`getRpc()` 不换身份时返回同一实例，
  // 不会触发重渲染，因此不会循环。
  useEffect(() => {
    const rpc = getRpc();
    if (rpc === undefined) return;
    if (shared.controller === undefined || shared.rpc !== rpc) {
      shared.rpc = rpc;
      shared.controller = create(rpc);
      setController(shared.controller);
    }
  });

  return controller;
}
