/**
 * 客户端插件入口：把「渗透作业」标签页注册进官方的设置页插件区。
 *
 * 设计依据：docs/dsh-pentest-plugin-design.md §6.2、§6.2.3
 *
 * ── 落点选择的依据（实测自官方源码 dsh 0.1.5-rc.2）──
 *
 * 用 `settings.plugins.tab` 而不是 `conversation.view`：
 *
 *   - `conversation.view` 的 `ConversationViewDefinition.create()` 返回增量构建器，
 *     其输入节点的唯一来源是 `ConversationMatch`——**包着 `SessionEvent` 的会话事件**。
 *     本设计的状态机数据在 PostgreSQL，且 §8.2 禁止写自定义会话事件，两者不可调和。
 *   - `settings.plugins.tab` 是 `scope: 'root'` 且 owner props 为空（官方注释：
 *     「tab owner props are intentionally empty」），注册方自由渲染、自选数据源。
 *     `root` 作用域还正好对应「跨会话管理长链任务」。
 *
 * ── 三条客户端纪律（§6.2.3）──
 *
 * 1. **绝不从 apply 抛异常**：Web 外壳在插件 apply 抛错时会让整个启动失败。
 *    挂载问题一律记录并降级。
 * 2. **防重复挂载**：模块工厂在同一页面生命周期内可能被执行两次，直接注册会挂出
 *    第二个标签。用一次性认领标志守住。
 * 3. **卸载要释放**：用 `ctx.effect()` 释放认领与槽位注册，使热重载后能重新认领。
 */

import { createElement, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import type { Context } from '@deepseek-ai/cordis';

import { logWarn } from './log.ts';
import { describeError } from '../contracts.ts';
import { onPanelRequest, requestPanel, selectPentestPanel } from './panel-jump.ts';

import type {
  ApprovalDetail,
  HandoffDraft,
  ReportDraft,
  PreviewScopeInput,
  ScopePreview,
  CandidateAsset,
  EngagementMemory,
  Finding,
  MemoryWatermark,
  DiagnosticsSnapshot,
  ScopeDetail,
  SkillSummary,
} from '../contracts.ts';
import type { HostRpcResult } from '../console/rpc.ts';
import { ConsoleController } from './controller.ts';
import type { ConsoleSnapshot } from './controller.ts';
import { useConsoleSnapshot, useInitialLoad } from './hooks.ts';
import { buildPanels, toMemoryHits } from './panels.ts';
import { ConsoleShell } from './views/ConsoleShell.tsx';
import { ErrorBar } from './ui.tsx';
import type { ConsolePanel } from './views/ConsoleShell.tsx';
import { SessionChat } from './views/SessionChat.tsx';
import { AgentTrace } from './views/AgentTrace.tsx';
import { DiagnosticsCard } from './views/DiagnosticsCard.tsx';
import { RunControls } from './views/RunControls.tsx';
import { activeWorkerSessionOf } from './session-chat.ts';
import {
  IntakePrompt,
  followPlan,
  followUntilSettled,
  lastTurnOf,
  turnTailVisible,
  type ChatSnapshotLike,
  type WorkspaceItemLike,
} from './views/IntakePrompt.tsx';
import { EngagementList } from './views/EngagementList.tsx';
import { EngagementWizard } from './views/EngagementWizard.tsx';
import type { MemoryHitView, MemorySearchParams } from './views/MemoryExplorer.tsx';
import type { DispositionAction, DispositionInput } from './views/ReportReview.tsx';
import type { ExportFormat, ExportOutcome } from './views/ReportExport.tsx';
import type { SkillAddInput, SkillRemoveInput, SkillUpdateInput } from './views/SkillLibrary.tsx';
import { installConsoleStyles } from './styles.ts';
import {
  PENTEST_PANEL_ID,
  PentestPanelFrame,
  PentestSidebarGlyph,
  StatusPillSurface,
  useSharedController,
} from './surfaces.tsx';
import type { TimelineFilter } from './timeline.ts';

export const name = 'dsh-pentest-client';

/**
 * 客户端依赖：**cordis 服务名**，不是包名。
 *
 * `slots` 由官方 `ui-renderer` 提供（槽位注册面）；`locale` 由 `dsh-client-locale`
 * 提供（文案字典）。
 *
 * `connection` 由 `dsh-client-connection` 提供：它的客户端入口 `ctx.provide("connection", handle)`，
 * 而 `handle.rpc.call(channel, endpoint, payload, signal)` 正是控制台调 Host 的唯一通路
 * （见 {@link connectionRpcOf}）。这三项与官方 `ui-settings-general` 的声明一致。
 *
 * ── 一处曾经写错的地方（留档，因为后果很隐蔽）──
 *
 * 曾把 `connection` 从 `inject` 里删掉，理由是「它的 `inject = []` 说明浏览器侧没有这个
 * 服务」。**那是读反了**：一个包的 `inject = []` 表示「它不需要别的服务」，与「它提供什么」
 * 无关；该包同文件里就写着 `ctx.provide("connection", handle)`。
 *
 * 删掉之后的行为是：`apply` 照样跑（`slots`/`locale` 满足），但控制台拿不到 RPC 句柄，
 * 界面渲染成「需要宿主的 Connection 服务」——功能整体不可用，而**启动毫无错误**。
 * cordis 的 `inject` 是**等待语义**，这里的每一行都该是「本插件真的会用到的服务」。
 */
export const inject = [
  'slots',
  'locale',
  'connection',
  // 客户端导航：阶段推进后把界面切到正在工作的 Agent 会话（`uiWorkspace.openSession`）。
  //
  // **必须声明**：不声明时 `ctx.get('uiWorkspace')` 拿到的服务调用**静默无效**——
  // 实测表现是 `openSession(id)` 不抛错、但界面的选中项 before/+1.5s/+4s 完全不变，
  // 而同样的调用经侧栏点击（同一 API）却能切。声明之后拿到的才是被接线的那一份。
  // 它由 `@deepseek-ai/dsh-client-ui-workspace` 提供，随 web app bundle 恒在。
  'uiWorkspace',
  // 会话控制器客户端服务：**官方 `ui-workflow-run` 就是用它跳会话的**
  // （`inject: ['uiConversation','slots','sessions','locale']` + `ctx.sessions.open(id)`）。
  'sessions',
];

/** 标签页在插件区内的标识与排序。 */
const TAB_ID = 'pentest';
const TAB_ORDER = 20;

/** 本插件的文案命名空间（`ctx.locale` 的字典按命名空间注册）。 */
const LOCALE_NS = 'dsh-pentest';

/**
 * 本插件注册给宿主的文案。
 *
 * 两种语言都注册是**契约要求**而不是锦上添花：官方 `locale.register` 的形态是
 * `Record<BuiltInLocaleId, LocaleDict>`（`zh` 与 `en` 都是必需键），且英文是兜底语言
 * ——浏览器没声明语言时界面开在英文。只注册中文会让英文用户在标签上看到原始 key。
 */
const TAB_LABELS = { zh: '渗透作业', en: 'Pentest' } as const;

/**
 * 插件 apply。
 *
 * 签名是 `(ctx)`：客户端插件不需要 config（人类操作经 Host RPC，配置在 Host 侧）。
 *
 * **返回 Promise 是允许的**，但这里保持同步：注册是纯内存操作，不需要等待任何 I/O；
 * 让启动路径尽早返回，失败也更容易定位。
 */
export function apply(ctx: Context): void {
  try {
    // ── 样式先注入 ──
    //
    // **必须在注册组件之前**：这些组件只带类名，而类名的定义就在这份样式里。
    // 缺了它，阶段轨道那张状态机图会退化成竖向的文字列表（`display: flex` 没了，
    // 「节点—边—节点」的顺序堆叠）——设计想传达的阶段、关系与回环全部看不见。
    //
    // 注入按标记幂等；没有 `document` 的环境（服务端渲染、单测）返回 null，不抛。
    const styleDispose = installConsoleStyles(
      typeof document === 'undefined' ? undefined : document,
    );
    if (styleDispose !== null) {
      ctx.effect(() => styleDispose, 'pentest-client: console styles');
    }

    const slots = slotsOf(ctx);
    if (slots === undefined) {
      // 缺 `ctx.slots` 说明宿主没装客户端 UI 槽位渲染器。记日志并降级——**不抛**（纪律 1）。
      logWarn(ctx, '未提供 ctx.slots：渗透作业标签未注册（宿主可能未装客户端 UI 槽位）');
      return;
    }

    // ── 必须等槽位被声明，不能直接 register ──
    //
    // `settings.plugins.tab` 由官方的 `ui-settings-plugins` 在**它的** apply 里声明
    // （`settings.section` 的 children 表声明了它）。客户端插件之间的**激活顺序不受约束**
    // ——官方的 `ui-settings-general` 在源码注释里把这条纪律写死了：
    //
    //   > The target slots are declared by ui-settings' apply, whose activation order
    //   > relative to this one is NOT constrained; registrations depend on their slots
    //   > through `slots.inject()`.
    //
    // 直接 `register` 一个尚未声明的槽位会抛 `slot "..." is not declared`
    // （`SlotCore.register` 的硬检查）。官方两个在 `settings.plugins.tab` 上的注册方
    // （`ui-settings-plugins` 的 configurable 标签、`ui-settings-plugin-inventory` 的
    // all 标签）**都用 `slots.inject`**，没有一个裸 register。
    //
    // `slots.inject(key, cb)` 的语义（`ui-renderer` 实现）：声明已存在则**同步**调用 cb；
    // 否则在声明 register 提交后调用；声明塌缩（如 HMR 重挂设置区）会先 dispose 再重跑。
    //
    // 因此这里**不需要**「一次性认领」标志——重复注册是由这把缝自己防住的，而一次性标志
    // 反而会破坏「声明塌缩后重新注册」这条路径（第二次不再注册，标签就消失了）。
    // 文案字典：注册在插件自己的生命周期里，卸载时随 `ctx.effect` 释放。
    // 必须在标签注册**之前**——`label` 是 thunk，宿主读到它时字典可能已被清理，
    // 那时 `t('tab')` 会回落到 key（界面上出现 `dsh-pentest.tab` 这种原始串）。
    const locale = localeOf(ctx);
    let bound: ((key: string) => string) | undefined;
    if (locale !== undefined) {
      // 注册经 `ctx.effect`，卸载时字典随插件一起释放。
      ctx.effect(
        () =>
          locale.register(LOCALE_NS, {
            zh: { tab: TAB_LABELS.zh },
            en: { tab: TAB_LABELS.en },
          }),
        'pentest-client: locale dictionary',
      );
      bound = locale.bind(LOCALE_NS);
    }

    // 缺 locale 服务时回落到内置文案——界面绝不能显示 `dsh-pentest.tab` 这种原始 key。
    const label = (): string => (bound === undefined ? TAB_LABELS.zh : bound('tab'));

    slots.inject('settings.plugins.tab', () =>
      slots.register(
        {
          name: 'settings.plugins.tab',
          id: TAB_ID,
          order: TAB_ORDER,
          // label 用 thunk：官方契约里 `SlotLabel = string | (() => string)`，thunk 每次
          // 读取时重新求值，因此 locale 切换无需重新注册（此前文档写成"重新注册"，已更正）。
          label,
          // 官方两个注册方都带这项：让宿主的槽位机械在语言切换时重新读取 label，
          // 而不必等本插件重注册。
          locale: LOCALE_NS,
        },
        // 传给槽位组件的是一个**取 RPC 的 thunk**，不是当场取到的句柄：
      // `connection` 服务可能在插件生命周期内被替换（重连会换 generation），
      // 当场取值会把句柄钉死在第一次注册的那一刻。
      () => renderConsole(() => connectionRpcOf(ctx), ctx),
      ),
    );

    registerSurfaces(slots, ctx, label);
  } catch (error) {
    // 兜底：绝不让异常冒泡到外壳的启动路径（那会让整页「Failed to load plugins」）。
    //
    // **同时打到 console**：`ctx.logger` 默认只写内存环形缓冲、没有 console 出口，
    // 因此只走 logger 的失败在浏览器里是**完全静默**的——「标签消失且零错误」正是这样
    // 拼出来的。降级可以，但必须留下可见的痕迹。
    logWarn(ctx, `渗透作业标签注册失败（已降级，不影响宿主启动）：${describeError(error)}`);
  }
}

/**
 * 槽位注册面。
 *
 * 用运行时窄化而非类型断言：`ctx.slots` 由另一个插件提供，形状不由本插件的
 * 类型定义保证；未装该插件时它就是 `undefined`。
 */
interface SlotRegistryLike {
  register(options: Record<string, unknown>, component: (props: never) => unknown): () => void;
  /**
   * 等目标槽位被声明后再执行注册。
   *
   * 语义（`ui-renderer` 的实现）：声明已存在则同步执行；否则在声明的 `register()` 提交后
   * 执行；声明塌缩会 dispose 上一次的效果并在重新声明后重跑。回调的返回值被当作 disposer
   * 收集，因此回调里 `register` 返回的注销函数会被正确接管。
   */
  inject(key: string, callback: () => unknown): () => void;
}

function slotsOf(ctx: Context): SlotRegistryLike | undefined {
  if (!('slots' in ctx)) return undefined;
  const slots: unknown = ctx.slots;
  if (slots === null || typeof slots !== 'object') return undefined;
  if (!('register' in slots) || typeof slots.register !== 'function') return undefined;
  if (!('inject' in slots) || typeof slots.inject !== 'function') return undefined;
  return slots as SlotRegistryLike;
}

/**
 * 宿主 locale 服务的最小面。
 *
 * 运行时窄化而非断言：`ctx.locale` 由另一个插件提供，形状不由本插件的类型定义保证。
 *
 * 用 `register` + `bind` 而不是某个 `t(key)` 快捷方法：官方 API 是
 * 「先按命名空间注册字典，再 `bind(ns)` 拿到该命名空间的 translate 函数」
 * （`register(ns, {zh, en})` / `bind(ns)`）。注册与绑定分开是有意义的——字典可以在
 * 语言切换后重新注册，而 `bind` 返回的函数保持稳定。
 */
interface LocaleDictionaries {
  readonly zh: Record<string, string>;
  readonly en: Record<string, string>;
}

interface LocaleLike {
  register(ns: string, dicts: LocaleDictionaries): () => void;
  /** 绑定命名空间，返回该命名空间的 translate 函数。 */
  bind(ns: string): (key: string) => string;
}

/**
 * 取 locale 服务。
 *
 * 拿不到时返回 `undefined`，调用方回落到内置的默认文案（中文）——界面不能因为缺服务
 * 就显示 `dsh-pentest.tab` 这种原始 key。
 */
function localeOf(ctx: Context): LocaleLike | undefined {
  if (!('locale' in ctx)) return undefined;
  const locale: unknown = ctx.locale;
  if (locale === null || typeof locale !== 'object') return undefined;
  if (!('register' in locale) || typeof locale.register !== 'function') return undefined;
  if (!('bind' in locale) || typeof locale.bind !== 'function') return undefined;
  return locale as unknown as LocaleLike;
}

/**
 * 「这份作业是自动建的吗」的提示文案。
 *
 * ── 为什么需要 ──
 *
 * 控制台一挂载就会调 `openTask()`：它把「浏览器会话 → 作业」的绑定建起来，没有匹配
 * 的作业时服务端会**新建**一个（名字形如「未命名任务 web-…」，主状态 `auth_pending`）。
 * 这是 intake 流程的前提，但界面上原本一个字都没说——人类第一次点开侧栏就发现自己
 * 多了一份作业，而旁边还摆着「新建 engagement」向导，于是不知道哪条才是正规路径。
 *
 * 识别用**服务端已经下发的两个事实**（主状态 + 名字前缀），不猜：名字前缀由
 * `pg-workflow.ts` 的自动命名规则产生，只有自动建的那份会命中。
 */
function intakeNotice(snapshot: ConsoleSnapshot): string | null {
  if (snapshot.selectedEngagementId === null) return null;
  if (snapshot.state?.mainStatus !== 'auth_pending') return null;
  const selected = snapshot.engagements.find((entry) => entry.id === snapshot.selectedEngagementId);
  if (selected === undefined || !selected.name.startsWith('未命名任务')) return null;
  return (
    '这份作业是打开控制台时自动建立的，名字形如「未命名任务 …」：它绑定当前会话，用来承载授权范围对话。' +
    '确认范围后它才成为可启动 Agent 的正式作业；想另建一份就用上方的「新建 engagement」授权向导。'
  );
}

/**
 * 渲染渗透作业控制台。
 *
 * ── 谁负责拉数据 ──
 *
 * 外层（本组件）持有 `ConsoleController` 并在挂载时拉一次数据；内层视图全部是
 * 纯 props 的受控组件。这个分工让视图可以被服务端渲染测试（它们不依赖
 * `useSyncExternalStore` 或 `useEffect`），而数据获取与刷新策略只有一处实现。
 *
 * ── 受控的展示状态 ──
 *
 * 当前面板、时间轴筛选、跟随开关、高亮会话都是本组件的 `useState`——它们只影响
 * 渲染，与 Host 的事实无关，因此**不该进控制器**（§6.2.3：客户端不持有权威状态）。
 */
function ConsoleApp(props: {
  readonly controller: ConsoleController;
  readonly rpc: HostRpcLike;
  /** 插件上下文：面板内的会话导航要用 `ctx.sessions` / `ctx.uiWorkspace`（root 槽位没有会话级 props）。 */
  readonly ctx: Context;
}): ReactNode {
  const snapshot = useConsoleSnapshot(props.controller);
  const [panel, setPanel] = useState<ConsolePanel>('overview');
  // 状态条（会话上栏）跳进来时**落到指定标签**：它够不到这里的 state，只能经登记点请求。
  // 卸载时注销，免得面板已不在却还留着回调。
  useEffect(() => onPanelRequest((next) => { setPanel(next as ConsolePanel); }), []);
  const [filter, setFilter] = useState<TimelineFilter>({});
  const [following, setFollowing] = useState(true);
  const [highlighted, setHighlighted] = useState<string | null>(null);
  /** 进入会话失败的原因（root 级槽位拿不到工作区列表，失败必须说出来而不是静默）。 */
  const [navFailure, setNavFailure] = useState<string | null>(null);
  const [wizardOpen, setWizardOpen] = useState(false);
  const [engagementFilter, setEngagementFilter] = useState('');
  const [scopePreview, setScopePreview] = useState<ScopePreview | undefined>(undefined);
  // 每个面板的数据独立持有、**按需加载**：切到某个面板才拉它要的数据。
  // 首屏只拉 engagement 列表，因此打开控制台不会顺带拉结论、放行队列与 skill 库。
  //
  // `null` 一律表示「尚未成功读取」。它与空数组是两件事：空数组是「确实没有」，
  // `null` 是「不知道」——把后者显示成前者会让人类误判。
  const [findings, setFindings] = useState<readonly Finding[] | null>(null);
  const [approvals, setApprovals] = useState<readonly ApprovalDetail[] | null>(null);
  const [scope, setScope] = useState<ScopeDetail | null>(null);
  const [candidateAssets, setCandidateAssets] = useState<readonly CandidateAsset[] | null>(null);
  const [skills, setSkills] = useState<readonly SkillSummary[] | null>(null);
  /** 公共记忆；`null` = 尚未成功读取（与「读到空串」是两件事）。 */
  const [publicMemory, setPublicMemory] = useState<EngagementMemory | null>(null);
  const [memoryHits, setMemoryHits] = useState<readonly MemoryHitView[] | null>(null);
  const [memoryWatermark, setMemoryWatermark] = useState<MemoryWatermark | null>(null);
  const [memorySearched, setMemorySearched] = useState(false);
  /**
   * 最近一次检索的失败（`null` = 没有失败）。
   *
   * 与 `memoryHits` 分开：命中为空有两种原因（真的没有匹配 / 这次没查成），
   * 而界面对它们的表达必须不同（§6.2.1）。它驱动面板的空态文案。
   */
  const [memoryError, setMemoryError] = useState<{ readonly code: string; readonly message: string } | null>(null);
  const [memoryDetails, setMemoryDetails] = useState<Readonly<Record<string, string>>>({});
  /** 交接草稿：人类请求生成后由 App 持有（它是写操作的结果，且编辑中要跨渲染保留）。 */
  const [handoffDraft, setHandoffDraft] = useState<HandoffDraft | null>(null);
  /** 报告草稿与未处置数：签字/导出的输入，也是签字硬前置的判据（§8.9）。 */
  const [reportDraft, setReportDraft] = useState<ReportDraft | null>(null);
  const [undisposedCount, setUndisposedCount] = useState<number | null>(null);
  /**
   * `findingId` → 最近一次处置动作（§8.9）。
   *
   * 由 App 持有而不是等 Host 回传：处置成功后要立刻反映到四节分节与未处置计数，
   * 否则人要手动刷新才知道自己刚做的处置生效了。
   */
  const [dispositions, setDispositions] = useState<Readonly<Record<string, DispositionAction>>>({});

  const engagementId = snapshot.selectedEngagementId;

  // ── engagement 列表与授权向导 ──
  //
  // 两者都由本组件构造后经 props 交给外壳：列表要调 `controller.select`，向导要调
  // `controller.createEngagement`，而这些能力在外壳（纯布局）里刻意不存在。
  const onSelectEngagement = useCallback(
    (id: string) => {
      void props.controller.select(id);
    },
    [props.controller],
  );

  const onRequestPreview = useCallback(
    (input: PreviewScopeInput) => {
      void props.controller.previewScope(input).then(
        (result) => {
          setScopePreview(result ?? undefined);
        },
        () => {
          // 预校验失败：不写入结论。界面显示「尚未校验」而不是伪造一个通过。
          setScopePreview(undefined);
        },
      );
    },
    [props.controller],
  );

  const engagementList = useMemo(
    () =>
      createElement(EngagementList, {
        engagements: snapshot.engagements,
        selectedId: engagementId,
        onSelect: onSelectEngagement,
        // 清理动作（归档 / 清空内容）的唯一写入路径。**漏传会让那一列全灰**——
        // 按钮的禁用原因会写「调用方未接入控制器」，实测如此（2026-10-05 人类报障）。
        controller: props.controller,
        filter: engagementFilter,
        onFilterChange: setEngagementFilter,
        loading: snapshot.loading,
        now: new Date(),
        // 「新建」意图只在这里给出：列表本身是纯展示 + 选择。
        onRequestCreate: () => {
          setScopePreview(undefined);
          setWizardOpen(true);
        },
      }),
    [snapshot.engagements, engagementId, engagementFilter, snapshot.loading, onSelectEngagement, props.controller],
  );

  const wizard = wizardOpen
    ? createElement(EngagementWizard, {
        controller: props.controller,
        now: new Date(),
        scopePreview,
        onRequestPreview,
        onCreated: (id: string) => {
          setWizardOpen(false);
          // 建完就选中它：人类刚填了一整张表，不该还要去列表里找。
          void props.controller.select(id);
        },
        onCancel: () => {
          setWizardOpen(false);
        },
      })
    : null;

  const load = useCallback(
    () => props.controller.openTask().then(() => undefined),
    [props.controller],
  );
  useInitialLoad(load);

  useEffect(() => {
    if (snapshot.intake !== null || snapshot.selectedEngagementId !== null) return;
    void props.controller.openTask();
  }, [props.controller, snapshot.intake, snapshot.selectedEngagementId]);

  const lastEngagement = useRef<string | null>(null);
  useEffect(() => {
    if (lastEngagement.current === engagementId) return;
    lastEngagement.current = engagementId;
    setFindings(null);
    setApprovals(null);
    setScope(null);
    setCandidateAssets(null);
    setSkills(null);
    setPublicMemory(null);
    setMemoryHits(null);
    setMemoryWatermark(null);
    setMemorySearched(false);
    setMemoryDetails({});
    setHandoffDraft(null);
    setReportDraft(null);
    setUndisposedCount(null);
    setDispositions({});
  }, [engagementId]);

  /** 运行诊断（§15.5）：总览页的只读快照；「读取失败」与「尚未读取」分开说（P16）。 */
  const [diagnostics, setDiagnostics] = useState<DiagnosticsSnapshot | null>(null);
  const [diagnosticsError, setDiagnosticsError] = useState<{ readonly code: string; readonly message: string } | null>(null);
  const onRefreshDiagnostics = useCallback(() => {
    setDiagnosticsError(null);
    void props.controller.diagnostics().then(
      (value) => {
        setDiagnostics(value);
        if (value === null) {
          setDiagnosticsError(
            props.controller.getSnapshot().lastError ?? {
              code: 'console/internal',
              message: '诊断请求失败，且未拿到稳定错误码',
            },
          );
        }
      },
      () => {
        setDiagnosticsError({ code: 'console/internal', message: '诊断请求未能发出' });
      },
    );
  }, [props.controller]);

  // 按需加载。依赖 `panel` 与 `engagementId`：切面板拉一次，换 engagement 重拉一次。
  // `cancelled` 防止人类快速切面板时，先发的请求回来覆盖后发的面板数据。
  useEffect(() => {
    if (engagementId === null) return;
    let cancelled = false;
    const settle = <T,>(setter: (value: T | null) => void, work: Promise<T | null>): void => {
      void work.then(
        (value) => {
          if (!cancelled) setter(value);
        },
        // 抛出的异常（传输层断开、信封构造失败）不进快照，这里接住并记为「未读到」。
        () => {
          if (!cancelled) setter(null);
        },
      );
    };

    switch (panel) {
      case 'overview':
        // 打开总览时拉一次诊断（失败与空由卡片分开呈现）。
        onRefreshDiagnostics();
        break;
      case 'report':
        settle(setFindings, props.controller.refreshFindings());
        // 签字前置的两个输入：报告草稿与**Host 侧的**未处置数（§8.9）。
        settle(setReportDraft, props.controller.refreshReportDraft());
        settle(setUndisposedCount, props.controller.refreshUndisposedCount());
        break;
      case 'approvals':
        settle(setApprovals, props.controller.refreshApprovals());
        break;
      case 'handoff':
        // 交接面板需要范围版本：回环的硬前置是「已做范围修订」（§5.4 步骤 4），
        // 而判据是「当前范围版本 > 来源会话绑定的版本」——两者都在这两个端点里。
        settle(setScope, props.controller.refreshScope(false));
        break;
      case 'scope':
        // 范围管理页要看历史版本，因此这里显式带历史（其他页面不要）。
        settle(setScope, props.controller.refreshScope(true));
        settle(setCandidateAssets, props.controller.refreshCandidateAssets());
        break;
      case 'skills':
        settle(setSkills, props.controller.refreshSkills());
        break;
      case 'publicmemory':
        settle(setPublicMemory, props.controller.refreshPublicMemory());
        break;
      case 'memory':
        // 水位单独拉：检索返回的水位是**那次检索时**的，与当前水位含义不同（§8.4）。
        settle(setMemoryWatermark, props.controller.readMemoryWatermark());
        break;
      default:
        break;
    }

    return () => {
      cancelled = true;
    };
  }, [panel, engagementId, props.controller, onRefreshDiagnostics]);

  // ── 意图出口 ──

  const onMemorySearch = useCallback(
    (params: MemorySearchParams) => {
      setMemorySearched(true);
      setMemoryError(null);
      void props.controller
        .searchMemory({
          query: params.query,
          kinds: params.kinds,
          trustLevels: params.trust_levels,
          includeReasoning: params.include_reasoning,
          limit: params.limit,
          phase: params.phase,
          assetIds: params.asset_ids,
        })
        .then(
          (result) => {
            setMemoryHits(result === null ? null : toMemoryHits(result.hits));
            if (result === null) {
              /*
               * `null` = **这次没拿到结果集**。失败与「空结果」必须分开表达（§6.2.1）：
               * 原来只把命中置空，于是面板说的是「没有匹配的记忆条目」——而事实是这次
               * 检索根本没执行（实测：审计闸门拒绝，`audit_unavailable`）。
               *
               * 注意控制器**不抛**失败：`#fetch` 把错误写进快照的 `lastError` 后返回 `null`
               * （见 `controller.ts` 的 `#fetch`）。所以这里读快照，而不是等 catch。
               */
              setMemoryError(
                props.controller.getSnapshot().lastError ?? {
                  code: 'console/internal',
                  message: '检索请求失败，且未拿到稳定错误码',
                },
              );
              return;
            }
            setMemoryError(null);
            setMemoryWatermark(result.watermark);
          },
          () => {
            // 传输层异常（信封构造失败、连接断开）走这条：同样记成检索失败。
            setMemoryHits(null);
            setMemoryError(
              props.controller.getSnapshot().lastError ?? {
                code: 'console/internal',
                message: '检索请求未能送达，且未拿到稳定错误码',
              },
            );
          },
        );
    },
    [props.controller],
  );

  /**
   * 处置结论（§8.9）。成功后**就地更新**本地处置表与未处置计数，
   * 让分节与签字前置立刻反映这次动作。
   *
   * 未处置计数的权威值仍在 Host（`listUndisposed`）；这里只做一次乐观的减一，
   * 并由后续重读纠正——不重读会让「还差几条才能签字」停在旧数字。
   */
  const onDispose = useCallback(
    (input: DispositionInput) => {
      void props.controller.dispositionFinding({
        findingId: input.findingId,
        action: input.action,
        reason: input.reason,
        // 视图用 `null` 表示「沿用原值」，而契约的同义表达是**省略该字段**（`severity?`）。
        // 传 null 会被 `console/argument-invalid` 拒掉（它的取值域只有五个严重度）。
        ...(input.severity === null ? {} : { severity: input.severity }),
      }).then(
        (result) => {
          if (!result.ok) return;
          setDispositions((current) => ({ ...current, [input.findingId]: input.action }));
          void props.controller.refreshUndisposedCount().then((count) => {
            if (count !== null) setUndisposedCount(count);
          });
        },
        () => {
          // 传输层失败不入快照（见 ConsoleController 的说明）：这里不谎报成功，
          // 处置表保持不变——界面继续显示「未处置」，那与事实一致。
        },
      );
    },
    [props.controller],
  );

  /**
   * 导出报告（§8.9）。
   *
   * `ReportExport` 不直接发 RPC（它保持纯 props、可服务端渲染），导出经这条回调走
   * 控制器的方法表入口。端点 `exportReport` 一直是挂着的，此前缺的正是这个调用方接线
   * ——没有它，视图如实报出 `wiring-missing`，两个导出按钮恒禁用。
   *
   * **它不提供签字哈希**：签字绑定的是报告**版本**的哈希（`ReportDraft.contentHash`，
   * 由 `getReportDraft` 从 `pentest.reports.content_hash` 带来）。导出产物另有一个哈希，
   * 用途是核对「你导出的这一份是不是签字的那一版」——两者混用会让
   * `human_decisions.subject_id` 指不到被审阅的版本（同一版本导出 markdown 与 json
   * 得到的哈希不同）。
   */
  const onExport = useCallback(
    async (format: ExportFormat): Promise<ExportOutcome> => {
      const result = await props.controller.exportReport(format);
      if (result === null) {
        // 失败原因由控制器记进快照（稳定错误码），这里原样冒泡给视图显示。
        const failure = props.controller.getSnapshot().lastError;
        return {
          ok: false,
          code: failure?.code ?? 'client/export-failed',
          message: failure?.message ?? '导出未返回结果',
        };
      }
      return { ok: true, result };
    },
    [props.controller],
  );

  const onAddSkill = useCallback(
    (input: SkillAddInput) => {
      void props.controller.addSkill({
        name: input.name,
        description: input.description,
        body: input.body,
      }).then(() => { void props.controller.refreshSkills().then((next) => { if (next !== null) setSkills(next); }); });
    },
    [props.controller],
  );

  const onUpdateSkill = useCallback(
    (input: SkillUpdateInput) => {
      void props.controller.updateSkill({
        skillId: input.skillId,
        name: input.name,
        description: input.description,
        body: input.body,
      }).then(() => { void props.controller.refreshSkills().then((next) => { if (next !== null) setSkills(next); }); });
    },
    [props.controller],
  );

  const onRemoveSkill = useCallback(
    (input: SkillRemoveInput) => {
      void props.controller.removeSkill({ skillId: input.skillId }).then(
        () => { void props.controller.refreshSkills().then((next) => { if (next !== null) setSkills(next); }); },
      );
    },
    [props.controller],
  );

  const onMemoryExpand = useCallback(
    (ref: { readonly memoryId: string; readonly citation: string }) => {
      // 传 `citation`（`memory:<分块标识>`）而**不是** `memoryId`。
      //
      // `readMemory` 只接受带前缀的引用（`parseRef` 要求 `memory:` / `event:`），
      // 而 `memoryId` 是裸 uuid ——把裸 uuid 传过去会被判 `classification_rejected`，
      // 于是「展开原文」在界面上**永远停在未展开**（失败被下面的空回调吞掉，
      // 不显示任何原因）。`citation` 本来就是为这条闭环而存在的字段。
      void props.controller.readMemory([ref.citation], '人类在控制台查看命中原文').then(
        (rows) => {
          const detail = rows?.find((row) => row.memoryId === ref.memoryId);
          if (detail === undefined) return;
          setMemoryDetails((current) => ({ ...current, [ref.memoryId]: detail.content }));
        },
        () => {
          // 读取原文失败：不写入 details，界面保持「未展开」——不伪造内容。
        },
      );
    },
    [props.controller],
  );

  /**
   * 回环前置状态（§5.4 步骤 4）：**当前范围版本 > 来源会话绑定的范围版本** 即为「已修订」。
   *
   * 与服务端 `confirmTransition` 用同一条件（那里是权威，这里是提前显示）。
   * 判不出来时（未读范围、没有活动会话）保守给 `completed: false`——
   * 回环因此会被界面拦下并说明原因；那比放行一次未修订的回环安全。
   */
  const scopeAmendmentState = useMemo(() => {
    const active = snapshot.sessions.find((s) => s.id === snapshot.state?.activeWorkerSessionId);
    const current = scope?.current?.version ?? null;
    const bound = active?.scopeVersion ?? null;
    const completed = current !== null && bound !== null && current > bound;
    return { completed, newVersion: completed ? current : null };
  }, [snapshot.sessions, snapshot.state?.activeWorkerSessionId, scope]);

  // 运行控制：主线入口（启动 Agent / 暂停 / 恢复 / 插话 / 终止）。
  // 它不进 `panels`——那是「可切换的面板」的表，而运行控制属于总览面板内部。
  /**
   * 保存公共记忆。
   *
   * 与其余写回调同形：调控制器 → 成功后重新读取（不乐观更新）。
   * **为什么要重读而不是直接把草稿当结果**：服务端可能对内容做归一化，且
   * `updatedAt`/`updatedBy` 只有服务端知道。乐观更新会让界面显示一个「看起来
   * 已保存」的状态，而它可能与库里的实际值不同。
   */
  const onSavePublicMemory = useCallback(
    async (content: string, reason: string): Promise<void> => {
      await props.controller.updateEngagementMemory({ content, engagementId: engagementId ?? '', reason });
      const next = await props.controller.refreshPublicMemory();
      if (next !== null) setPublicMemory(next);
    },
    [props.controller, engagementId],
  );

  const runControls = useMemo(
    () => createElement(RunControls, { controller: props.controller, snapshot, now: new Date() }),
    [props.controller, snapshot],
  );

  const diagnosticsCard = useMemo(
    () => createElement(DiagnosticsCard, {
      diagnostics,
      error: diagnosticsError,
      onRefresh: onRefreshDiagnostics,
      now: new Date(),
    }),
    [diagnostics, diagnosticsError, onRefreshDiagnostics],
  );

  const panels = useMemo(
    () =>
      buildPanels({
        controller: props.controller,
        snapshot,
        now: new Date(),
        findings,
        approvals,
        scope,
        candidateAssets,
        skills,
        publicMemory,
        onSavePublicMemory,
        memoryHits,
        memoryWatermark,
        memorySearched,
        memoryError,
        memoryInitialForm: null,
        memoryDetails,
        handoffDraft,
        onHandoffDraft: setHandoffDraft,
        scopeAmendment: scopeAmendmentState,
        dispositions,
        onDispose,
        onAddSkill,
        onUpdateSkill,
        onRemoveSkill,
        reportDraft,
        undisposedCount,
        reportContentHash: reportDraft?.contentHash ?? null,
        onExport,
        onMemorySearch,
        onMemoryExpand,
      }),
    [
      props.controller,
      snapshot,
      findings,
      approvals,
      scope,
      candidateAssets,
      skills,
      publicMemory,
      onSavePublicMemory,
      memoryHits,
      memoryWatermark,
      memorySearched,
      // 漏了这个依赖的后果实测过：检索失败后 `error` 永远传不进去，
      // 面板一直显示上一次的「没有匹配」——入参写了、依赖没写是这类 bug 的固定形状。
      memoryError,
      memoryDetails,
      handoffDraft,
      scopeAmendmentState,
      dispositions,
      onDispose,
      onAddSkill,
      onUpdateSkill,
      onRemoveSkill,
      reportDraft,
      undisposedCount,
      onExport,
      onMemorySearch,
      onMemoryExpand,
    ],
  );

  // 「当前 Agent 轨迹」：活动 Worker 会话的思维链与工具输出。自动跟随会话页在本部署里
  // 不生效（见 RUNBOOK §6.5.4），因此控制台里必须自己给一栏只读轨迹。
  const activeWorkerSession = activeWorkerSessionOf(snapshot);
  const agentTrace = activeWorkerSession === null || props.rpc === undefined
    ? undefined
    : createElement(AgentTrace, { rpc: props.rpc, session: activeWorkerSession });
  const intakeChat = createElement(
    'div',
    { className: 'pentest-intake' },
    intakeNotice(snapshot) === null
      ? null
      : createElement(ErrorBar, { code: 'client/auto_draft', message: intakeNotice(snapshot) ?? '', tone: 'attention' }),
    createElement(SessionChat, {
      controller: props.controller,
      snapshot,
      rpc: props.rpc,
      proposal: snapshot.scopeProposal,
    }),
  );

  /**
   * 进入某个会话（时间轴上每条会话的「进入会话」）。
   *
   * 控制台面板是 **root 级**槽位：拿不到 `useWorkspaces` / `useSessions` 这些会话级标准 props，
   * 因此这里只用 `ctx.sessions` / `ctx.uiWorkspace` 两个服务直连，也**不做工作区定位**。
   * 目标会话属于尚未打开的工作区时会失败——那就如实说，并给出下一步（在左侧栏打开它），
   * 而不是让人类以为「点了没反应」。
   */
  const enterSession = useCallback((dshSessionId: string): void => {
    const workspace = workspaceConnectorOf(props.ctx);
    const sessions = sessionNavigationOf(props.ctx);
    try {
      if (workspace !== undefined) workspace.openSession(dshSessionId);
      else if (sessions !== undefined) sessions.open(dshSessionId);
      else throw new Error('宿主未提供会话导航（ctx.sessions / ctx.uiWorkspace 都不可用）');
      setNavFailure(null);
    } catch (cause: unknown) {
      setNavFailure(`${describeError(cause)}｜若该会话属于尚未打开的工作区，请先在左侧栏打开它`);
    }
  }, [props.ctx]);

  const shellProps = useMemo(
    () => ({
      controller: props.controller,
      snapshot,
      scopeVersion: snapshot.state?.scopeVersion ?? null,
      authorizationExpiresAt: snapshot.state?.authorizationExpiresAt ?? null,
      panels,
      runControls,
      diagnosticsCard,
      engagementList,
      wizard,
      intakeChat,
      ...(agentTrace === undefined ? {} : { agentTrace }),
      activePanel: panel,
      onPanelChange: setPanel,
      timelineFilter: filter,
      onTimelineFilterChange: setFilter,
      following,
      onToggleFollowing: () => { setFollowing((v) => !v); },
      highlightedSessionId: highlighted,
      onSelectSession: setHighlighted,
      onEnterSession: enterSession,
    }),
    // `agentTrace` 必须进依赖：它由快照的活动会话派生，漏掉会一直用旧值（实测踩过：
    // 选中作业后轨迹栏始终不出现）。
    [props.controller, snapshot, panels, runControls, diagnosticsCard, engagementList, wizard, intakeChat, agentTrace, panel, filter, following, highlighted, enterSession],
  );

  return createElement(
    'div',
    null,
    navFailure === null
      ? null
      : createElement(ErrorBar, { code: 'client/nav_failed', message: navFailure }),
    createElement(ConsoleShell, shellProps),
  );
}

/**
 * 槽位组件：把控制器创建与渲染分开。
 *
 * 为什么要一个包装：`ConsoleController` 必须在**组件的生命周期内**创建一次并保持
 * 稳定——若在 render 里 `new ConsoleController(...)`，每次渲染都会换一个实例，
 * 订阅会不断重建、状态会丢失。`useState` 的惰性初始化正好表达「一次创建、此后复用」。
 *
 * 若拿不到 `ctx.connection`（headless 或未装 Connection），渲染一个说明块而不是
 * 抛错——纪律 1：绝不从 apply 抛异常。
 */
function renderConsole(getRpc: () => HostRpcLike | undefined, ctx: Context): ReactNode {
  const rpc = getRpc();
  if (rpc === undefined) {
    return createElement(
      'div',
      { className: 'dsh-pentest-console', 'data-stage': 'unavailable' },
      '渗透作业控制台需要宿主的 Connection 服务才能读取数据。',
    );
  }
  return createElement(ConnectedConsole, { rpc, ctx });
}

/** 已连上 Host 的控制台（控制器在页面级共享，见 `surfaces.tsx` 的 `useSharedController`）。 */
function ConnectedConsole(props: { readonly rpc: HostRpcLike; readonly ctx: Context }): ReactNode {
  const controller = useSharedController(
    () => props.rpc,
    (rpc: HostRpcLike) => makeController(rpc),
  );
  if (controller === undefined) return renderUnavailable();
  return createElement(ConsoleApp, { controller, rpc: props.rpc, ctx: props.ctx });
}

/**
 * 造一个控制器。
 *
 * 抽成函数是为了让多个挂载面共享同一个实例。
 */
function makeController(rpc: HostRpcLike): ConsoleController {
  return new ConsoleController({
    invoke: async (channel, endpoint, payload, signal) => {
      // 宿主的 `call` 返回的是 `ConnectionRpcResult`（与我们的 `HostRpcResult` 同形），
      // 但它的类型对我们是 `unknown`——做一次**运行时窄化**而不是断言：
      // 形状不符时抛错比让 undefined 流进下游更好定位。
      const result: unknown = await rpc.call(channel, endpoint, payload, signal);
      if (!isHostRpcResult(result)) {
        throw new Error(
          '宿主 RPC 返回的形状不符合 ConnectionRpcResult（期望 {ok:true,value} 或 {ok:false,error}）',
        );
      }
      return result;
    },
  });
}

/** 拿不到 Connection 时的降级渲染（说明原因，而不是一片空白）。 */
function renderUnavailable(): ReactNode {
  return createElement(
    'div',
    { className: 'dsh-pentest-console', 'data-stage': 'unavailable' },
    '渗透作业控制台需要宿主的 Connection 服务才能读取数据。',
  );
}

/**
 * 注册控制台的**三个额外落点**（§6.2 的槽位表）。
 *
 * 为什么需要：`settings.plugins.tab` 是设计指定的主入口，但它是个**弹窗**——要点三步才
 * 打开、高度有限、且只在这一屏存在。结果是状态机与各阶段 Agent 事实上不可见：人类在聊天
 * 界面工作时看不到当前阶段，也看不到有 Agent 在等自己判断。
 *
 * 三个落点各自的职责：
 *
 * | 槽位 | 作用 | 关键契约 |
 * |---|---|---|
 * | `main`（keyed） | 全高主面板 | key 必须与侧栏行 id 一致，否则点击抛错 |
 * | `sidebar.panellist`（list） | 侧栏入口 | 同上——`selectPanel` 会校验主面板已注册 |
 * | `shell.overlay`（list） | 常驻状态条 | `rightbar` 已被官方占用，此槽是官方的追加位 |
 *
 * 三处都用 `slots.inject` 而不是裸 `register`：这些槽位由**别的插件**在它们的 apply 里
 * 声明，而客户端插件之间的激活顺序不受约束。裸注册一个尚未声明的槽位会抛
 * `slot "…" is not declared`。
 */
/** 空轮次列表（常量引用：`useChat` 缺失时的兜底，不参与相等比较）。 */
const EMPTY_TURNS: readonly { readonly turn: number }[] = [];

/**
 * 渲染器报告的「当前会话」（`useSessions` 钩子，与侧栏同一个 store）。
 *
 * 跟随要用它判断**是否落定**：实测我们的导航调用确实改到了活 store，但 ~1 秒后会被
 * 应用侧某个调用者切回旧会话（调用者未定位）。因此在落定前补几次尝试（见 `onFollowSession`）。
 */
const liveSessionRef: { current: string | null } = { current: null };

/**
 * 阶段推进后是否把**会话界面**切到当前正在工作的 Agent 会话。
 *
 * **默认关闭**：实测（RUNBOOK §6.5.4）我们的导航调用确实改到了活 store，但约 1 秒后会被
 * 应用侧某个调用者切回旧会话——净效果只是让视图闪一下。判据与重试机制保留且有断言
 * （`shouldFollowActiveSession` / `followPlan` / `followUntilSettled`），等那侧的问题定位后
 * 把这里改成 `true` 即可，不需要再动别处。
 */
const FOLLOW_ACTIVE_SESSION = false;

/** 空工作区列表（同上：`useWorkspaces` 缺失时的兜底）。 */
const EMPTY_WORKSPACES: readonly WorkspaceItemLike[] = [];


/**
 * 客户端导航能力（`@deepseek-ai/dsh-client-ui-workspace` 的 `uiWorkspace`）：
 * `openSession(id)` 是「选中某个会话并把它的对话显示出来」的正规入口。
 *
 * 取不到就返回 undefined——**跟随会话是增强，不是前提**：少了它插件照常工作，
 * 只是阶段推进后不会自动切页面。绝不因为一个可选服务把整个插件拖挂（同
 * `slotsOf` / `localeOf` 的写法）。
 */
/**
 * 会话导航：**照官方 `ui-workflow-run` 的写法**用会话控制器服务 `ctx.sessions.open(id)`。
 *
 * ── 实测边界（写在这里，免得下一个人重复踩）──
 *
 * 本插件从**自己的插件上下文**取到的这两份客户端服务（`sessions`、`uiWorkspace`）都没接线：
 *   * `sessions.open(id)` 不抛错，但界面选中项 before/+1.5s/+4s 完全不变；
 *   * 更直接的证据：`sessions.list.getSnapshot().current` 在这份实例上恒为 `<none>`
 *     （连界面正在显示的会话 id 都读不到），调用后它自己的 store 也没变。
 *
 * 官方 `ui-workflow-run` 与社区 `@kt11/dsh-session-manager` 都是 `inject: [... 'sessions']`
 * + `sessions.open(id)`（我们已照抄）——差别只在**插件的上下文**。外部插件（本插件经 profile
 * 的 `dsh-plugin` 装载）能否驱动内置 UI 的会话导航，目前是未解问题；在解开之前，这段跟随
 * 调用是 inert 的（不会报错，也不会切页面）。`test/client-intake-prompt.test.ts` 锁的是
 * 「决策」这一层（它是对的），导航那一步见 RUNBOOK §6.5.4 的说明。
 */
interface SessionNavigation {
  open(dshSessionId: string): void;
}

function sessionNavigationOf(ctx: Context): SessionNavigation | undefined {
  // **属性访问，不是 `ctx.get`**：`sessions` 已在本插件的 `inject` 里声明，于是这里拿到的是
  // 被接线的那一份；`ctx.get(name)` 那条路取到的实例调用无效（实测：不抛错、界面不动）。
  // 声明过的服务在提供前读到 `undefined`（不抛，见 `connectionRpcOf` 的说明），因此是安全的。
  //
  // 反过来也成立，而且是**另一条**规矩：**未声明**的服务里，属性访问是 inert stub
  // （不抛错、调用落空、连日志都没有），只有 `ctx.get(name)` 拿到的是实现本身。
  // 两个方向都实测过，详见 RUNBOOK §6.5.7 与 `panel-jump.ts` 的说明——
  // 「打开控制台」按钮曾因此变成死键。
  const direct: unknown = (ctx as unknown as { sessions?: unknown }).sessions;
  // 属性访问拿不到（未接线或用别的作用域）时回退 `ctx.get`：两者在宿主里可能给到
  // **不同**的实例（§6.5.4 / §6.5.7 的两个方向都实测过），取得到哪个就用哪个。
  const service: unknown = direct === null || direct === undefined || typeof direct !== 'object'
    ? ctx.get('sessions')
    : direct;
  if (service === null || service === undefined || typeof service !== 'object') return undefined;
  const open = (service as { open?: unknown }).open;
  if (typeof open !== 'function') return undefined;
  return {
    open: (dshSessionId: string): void => {
      (open as (this: unknown, id: string) => void).call(service, dshSessionId);
    },
  };
}

/**
 * 工作区连接（只用来**让目标会话可寻址**）：Worker 会话住在独立工作区，那个工作区没被连上时
 * 它的会话不在客户端列表里，`sessions.open` 会抛 `unknown session`。
 */
interface WorkspaceConnector {
  connectWorkspace(workspaceId: string): Promise<unknown>;
  /** 正规导航：选中会话并清掉面板态（`uiWorkspace.openSession`）。 */
  openSession(dshSessionId: string): void;
}

function workspaceConnectorOf(ctx: Context): WorkspaceConnector | undefined {
  // 同上：声明过的服务用属性访问。
  const service: unknown = (ctx as unknown as { uiWorkspace?: unknown }).uiWorkspace;
  if (service === null || typeof service !== 'object') return undefined;
  const connect = (service as { connectWorkspace?: unknown }).connectWorkspace;
  const open = (service as { openSession?: unknown }).openSession;
  if (typeof connect !== 'function' || typeof open !== 'function') return undefined;
  return {
    connectWorkspace: (workspaceId: string): Promise<unknown> =>
      (connect as (this: unknown, id: string) => Promise<unknown>).call(service, workspaceId),
    openSession: (dshSessionId: string): void => {
      (open as (this: unknown, id: string) => void).call(service, dshSessionId);
    },
  };
}

function registerSurfaces(slots: SlotRegistryLike, ctx: Context, label: () => string): void {
  /**
   * 打开插件主面板，并**落到指定标签**（外部审计建议⑦）。
   *
   * 状态条是唯一常驻面，"下一步该看哪"就不该再让人类自己找：有会话在等人工判断时，
   * 直接落「报告审阅」（Agent 交的报告与结论都在那里）；其余情况落总览。
   */
  const openPanel = (panel?: ConsolePanel): void => {
    if (panel !== undefined) requestPanel(panel);
    selectPentestPanel(ctx, PENTEST_PANEL_ID);
  };
  const consoleOf = (): ReactNode => renderConsole(() => connectionRpcOf(ctx), ctx);

  // ① 全高主面板。
  slots.inject('main', () =>
    slots.register({ name: 'main', key: PENTEST_PANEL_ID }, () =>
      createElement(PentestPanelFrame, null, consoleOf()),
    ),
  );

  // ② 侧栏入口（glyph 只有图标；行标题由 `label` 单独渲染）。
  slots.inject('sidebar.panellist', () =>
    slots.register(
      {
        name: 'sidebar.panellist',
        id: PENTEST_PANEL_ID,
        // 排在官方入口之后：这是加速入口，不是主入口（§6.2.3 末段）。
        order: SURFACE_ORDER.sidebar,
        label,
        locale: LOCALE_NS,
      },
      PentestSidebarGlyph,
    ),
  );

  // ④ 「待你确认」挂在**最新一轮 AI 消息的末尾**（`conversation.chat.turnTail`）。
  //
  // 为什么不是输入框下方：人类要求「由 AI 主动询问并提供选项」——AI 的那句
  // 「请确认范围」必须自己带着可点的选项，否则就成了「AI 让你去别处找入口」
  // （§13.1 的人类闸门：看得到才叫闸门）。
  //
  // 只挂在**最新一轮**：这是 chain 语义（每个完成的轮次都会跑一遍这条链），
  // 不加限定会把同一条待办在历史里每一轮后面都重复一份；返回 null 即让链继续。
  slots.inject('conversation.chat.turnTail', () =>
    slots.register(
      {
        name: 'conversation.chat.turnTail',
        id: `${PENTEST_PANEL_ID}-turn-tail`,
        order: SURFACE_ORDER.overlay,
        // chain 槽位**必须**给 `select`（不给会让整条链注册直接抛错，什么都不画）。
        // 语义：返回非 `null` 即被选中（返回值会作为 `matched` 并入组件 props），
        // 返回 `null` 才让链继续。这里对所有完成的轮次都接受——「只挂最新一轮」
        // 需要会话快照，只能在组件里用 `useChat` 判定。
        select: () => ({}),
      },
      function PentestTurnTailPrompt(props: {
        /** `TurnLocation` 对象（`turn.turn` 才是轮次号），不是裸 number。 */
        readonly turn?: unknown;
        readonly sessionId?: string;
        readonly useChat?: (select: (snapshot: ChatSnapshotLike) => readonly { readonly turn: number }[]) => readonly { readonly turn: number }[];
        readonly useWorkspaces?: (
          select: (state: { readonly items: readonly WorkspaceItemLike[] }) => readonly WorkspaceItemLike[],
        ) => readonly WorkspaceItemLike[];
        readonly useSessions?: (select: (state: { readonly current?: string | undefined }) => string | undefined) => string | undefined;
      }): ReactNode {
        // **先把 hook 调完再判定**：chain 在每个完成的轮尾都会渲染一次本组件，
        // 任何早退只要改变了 hook 调用次数，React 就抛错——整条链直接什么都不画。
        const controller = useSharedController(
          () => connectionRpcOf(ctx),
          (rpc: HostRpcLike) => makeController(rpc),
        );
        // `useChat` / `useWorkspaces` 都是会话级标准 props（恒在）；常量兜底只为让 hook
        // 调用不落在三元结果上。工作区列表是宿主权威的（含每个工作区的 `sessionIds`），
        // 用来把目标会话定位到某个工作区（见 `followPlan`）。
        const turns = props.useChat === undefined ? EMPTY_TURNS : props.useChat((snapshot) => snapshot.navigation.items());
        const workspaces = props.useWorkspaces === undefined
          ? EMPTY_WORKSPACES
          : props.useWorkspaces((state) => state.items);
        // 钩子必须无条件调用（hooks 规则）；这段是跟随「落定判定」的唯一事实来源。
        const liveSession = props.useSessions === undefined
          ? null
          : (props.useSessions((state) => state.current ?? '') ?? null);
        liveSessionRef.current = liveSession === '' ? null : liveSession;
        if (typeof props.sessionId !== 'string') return null;
        if (!turnTailVisible(props.turn, props.sessionId, lastTurnOf(turns))) return null;
        // 取不到连接就不画：这是动作入口，画一个点了没反应的入口比不画更糟。
        if (controller === undefined) return null;
        const sessions = sessionNavigationOf(ctx);
        const workspace = workspaceConnectorOf(ctx);
        const connector = workspace;
        return createElement(IntakePrompt, {
          controller,
          dshSessionId: props.sessionId,
          onOpenConsole: openPanel,
          // 阶段推进后跟随到当前正在工作的 Agent 会话：思维链与输出都在那一侧。
          //
          // **必须先让目标会话可寻址**：Worker 会话住在独立工作区（`sessionCwd`），
          // 那个工作区没被连上时它的会话不在客户端列表里，`select(id)` 会抛
          // `sessions.select: unknown session …`——跟随于是变成静默空操作。
          // 定位与「先连后开」的判定在纯函数 `followPlan` 里（可断言）。
          // 会话导航**能力**：人类点「去看 Agent 的会话」时用它切过去。
          // 自动跟随另由 `autoFollowSession` 触发（默认关）——能力与触发分开，
          // 因为自动切页面可能与人类正在看的东西打架。
          ...(sessions === undefined
            ? {}
            : {
                onFollowSession: (target: string): void => {
                  followSessionTo({
                    target,
                    workspaces,
                    workspace,
                    connector,
                    sessions,
                    current: () => liveSessionRef.current,
                    schedule: (work, delayMs) => { window.setTimeout(work, delayMs); },
                  });
                },
              }),
          autoFollowSession: FOLLOW_ACTIVE_SESSION,
        });
      },
    ),
  );

  // ③ 常驻状态条。
  //
  // 组件写成具名函数而不是内联箭头：它要用 hooks，而 React 靠组件身份决定是否复用实例。
  // 2026-10-05 起挂到**会话上栏的右侧动作区**（`conversation.session.header.actions`）：
  // 之前挂 `shell.overlay` 是屏幕下方居中的常驻胶囊，会压住宿主输入区与提问卡。
  // 插槽名是从宿主客户端包里核对出来的（`conversation.header` 那个键宿主根本没有——
  // 注册会静默失效，状态条直接消失；同名不存在的槽不报错，所以只能靠核对）。
  slots.inject('conversation.session.header.actions', () =>
    slots.register(
      { name: 'conversation.session.header.actions', id: `${PENTEST_PANEL_ID}-status`, order: SURFACE_ORDER.overlay },
      function PentestStatusSurface(): ReactNode {
        const controller = useSharedController(
          () => connectionRpcOf(ctx),
          (rpc: HostRpcLike) => makeController(rpc),
        );
        // 取不到连接就不画：状态条是常驻 UI，画一个「无连接」的常驻错误比不画更烦人
        // （主面板里已经有完整的说明）。
        if (controller === undefined) return null;
        return createElement(StatusPillSurface, { controller, onOpen: openPanel });
      },
    ),
  );
}

/**
 * 把界面切到目标会话，并在**落定**前重试。
 *
 * 为什么需要重试（§6.5.4 实测）：我们的导航调用确实改到了活 store，但宿主侧还有一次
 * 「把会话切回去」的动作（调用者未定位），净效果可能是切完 ~1 秒又弹回。因此打开之后
 * 用**渲染器报告的当前会话**核对，没落定就再试（最多 3 次、间隔 700ms）。
 *
 * 人类点击触发的跳转走这里；自动跟随（`FOLLOW_ACTIVE_SESSION`）也走这里——两者的差别
 * 只在「谁触发」，不在机制。
 */
function followSessionTo(input: {
  readonly target: string;
  readonly workspaces: readonly WorkspaceItemLike[];
  readonly workspace: { openSession(id: string): void } | undefined;
  readonly connector: { connectWorkspace(id: string): Promise<unknown> } | undefined;
  readonly sessions: { open(id: string): void };
  readonly current: () => string | null;
  readonly schedule: (work: () => void, delayMs: number) => void;
}): void {
  const plan = followPlan({ target: input.target, workspaces: input.workspaces });
  if (plan === null) return;
  const follow = (): void => {
    followUntilSettled({
      target: input.target,
      open: (id: string): void => {
        try {
          // **正规路径优先**：`uiWorkspace.openSession` 除了选中会话，还会清掉侧栏的面板态；
          // 会话服务作为回退。
          if (input.workspace !== undefined) input.workspace.openSession(id);
          else input.sessions.open(id);
        } catch {
          // 目标不可寻址（工作区没连上/已归档）：放弃——增强不该带崩调用方。
        }
      },
      current: input.current,
      delayMs: 700,
      attempts: 3,
      schedule: input.schedule,
    });
  };
  if (plan.workspaceId === null || input.connector === undefined) {
    follow();
    return;
  }
  // 先连工作区（幂等）让目标可寻址，再打开；连接失败也照样试一次。
  void input.connector
    .connectWorkspace(plan.workspaceId)
    .then(follow)
    .catch(follow);
}

/** 各落点的排序。集中在一处，便于对照着调。 */
const SURFACE_ORDER = { sidebar: 40, overlay: 30 } as const;

/**
 * 宿主 Connection RPC 的结果形状（与 `src/console/rpc.ts` 的 {@link HostRpcResult} 同源）。
 */
interface HostRpcLike {
  call(channel: string, endpoint: string, payload: unknown, signal?: AbortSignal): Promise<unknown>;
}

/** 窄化宿主的 RPC 结果为我们的结果形状。 */
function isHostRpcResult(value: unknown): value is HostRpcResult {
  if (value === null || typeof value !== 'object') return false;
  if (!('ok' in value) || typeof value.ok !== 'boolean') return false;
  if (value.ok) return 'value' in value;
  if (!('error' in value)) return false;
  const error: unknown = value.error;
  if (error === null || typeof error !== 'object') return false;
  return 'code' in error && typeof error.code === 'string';
}

/**
 * 从 `ctx.connection` 取 RPC 调用面。
 *
 * ── 为什么不从槽位 props 取 ──
 *
 * 曾按「槽位会把宿主服务作为 props 传给组件」的假设从 props 里找 `rpc` / `connection`
 * ——实测不成立：`settings.plugins.tab` 的 owner props 是**刻意留空**的
 * （官方契约：`SettingsPluginsTabOwnerProps` 只有一个 `children?: never` 标记），
 * 组件收到的是标准 kit，里面没有 RPC 句柄。结果是控制台渲染出「需要宿主的 Connection
 * 服务」这句话，而服务其实一直在。
 *
 * 正确的来源是插件的 cordis 上下文：`connection` 是一个服务
 * （`dsh-client-connection` 的 `ctx.provide("connection", handle)`），`handle.rpc` 就是
 * `call(channel, endpoint, payload, signal)`。
 *
 * 逐层运行时窄化而不是断言：`ctx.connection` 由另一个插件提供，形状不由本插件的类型
 * 定义保证。
 */
function connectionRpcOf(ctx: Context): HostRpcLike | undefined {
  // `ctx` 是 cordis 的 Proxy：`ctx.connection` 在服务提供前读取得到 undefined，
  // 因此这里不做 `'connection' in ctx` 的前置判断（那在服务迟到时会误判为缺服务）。
  const connection: unknown = (ctx as unknown as Record<string, unknown>)['connection'];
  if (connection === null || typeof connection !== 'object') return undefined;
  if (!('rpc' in connection)) return undefined;
  const rpc: unknown = connection.rpc;
  return isRpcLike(rpc) ? rpc : undefined;
}

function isRpcLike(value: unknown): value is HostRpcLike {
  if (value === null || typeof value !== 'object') return false;
  if (!('call' in value)) return false;
  return typeof value.call === 'function';
}
