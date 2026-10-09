/**
 * 控制台外壳：把核心屏组装成页面。
 *
 * 设计依据：docs/dsh-pentest-plugin-design.md §6.2
 *
 * ── 结构 ──
 *
 * ```
 * ⓪ engagement 入口 选择 / 筛选 / 新建——进入任何作业的唯一入口，始终可见
 * ① 运行总览条      始终可见
 * ② 阶段轨道        状态机的空间表达
 * ③ 会话时间轴      长链任务的主视图
* ④ 主面板          控制台 / 日志记录 / 放行队列 / Skill库 / 范围管理 / 公共记忆（按需切换）
 * ```
 *
 * ⓪ 在总览条**之前**：总览条说的是「当前这个作业怎么样了」，而入口决定「当前是哪个
 * 作业」。把入口放在它上面，屏幕上的阅读顺序就与因果顺序一致。它也**不随选中状态隐藏**
 * ——未选中时正是最需要它的时候（否则人类没有别的办法进入任何作业）。
 * 它由外层构造（要调 `controller.select`/创建向导，外壳刻意没有这些能力）。
 *
 * ── 受控设计 ──
 *
 * 本组件**不持有状态**，全部经 props 传入并由回调上报意图：
 *   - `controller` 与 `snapshot` 由外层注入（而非组件内部订阅）——这样它可以被
 *     服务端渲染测试，也让「谁负责拉数据」这件事有唯一答案（外层）。
 *   - 筛选条件、跟随开关、当前高亮项都是受控 props（§6.2.3 允许本地保留这类纯展示
 *     状态，但受控化让它们可测、也能与 URL/快捷键联动）。
 *
 * ── 面板切换为什么用受控的 `activePanel` ──
 *
 * 面板切换是纯展示状态，但它决定「主面板渲染谁」。受控化让外层能在跳转时
 * 直接指定面板（例如从报告里的某条 finding 跳到放行队列），而不必让子组件
 * 之间互相通信。
 */

import type { ReactNode } from 'react';
import type { EngagementSummary, WorkerSessionSummary, WorkflowSnapshot } from '../../contracts.ts';
import type { ConsoleController } from '../controller.ts';
import type { TimelineFilter } from '../timeline.ts';
import { PhaseTrack } from './PhaseTrack.tsx';
import { SessionTimeline } from './SessionTimeline.tsx';
import { RunHeader } from './RunHeader.tsx';
import { Badge, Card, Empty, ErrorBar } from '../ui.tsx';

/** 主面板可显示的视图。 */
export const CONSOLE_PANELS = [
  'console',
  'logs',
  'approvals',
  'vulnerabilities',
  'assets',
  'skills',
  'scope',
  'publicmemory',
] as const;
export type ConsolePanel = (typeof CONSOLE_PANELS)[number];

const PANEL_LABELS: Readonly<Record<ConsolePanel, string>> = {
  console: '控制台',
  logs: '日志记录',
  approvals: '放行队列',
  vulnerabilities: '漏洞列表',
  assets: '资产清单',
  skills: 'Skill 库',
  scope: '范围管理',
  publicmemory: '公共记忆',
};

export interface ConsoleShellProps {
  readonly controller: ConsoleController;
  readonly snapshot: {
    readonly engagements: readonly EngagementSummary[];
    readonly selectedEngagementId: string | null;
    readonly state: WorkflowSnapshot | null;
    readonly sessions: readonly WorkerSessionSummary[];
    readonly intake?: unknown;
    readonly scopeProposal?: unknown;
    readonly loading: boolean;
    readonly lastError: { readonly code: string; readonly message: string } | null;
    readonly conflict: boolean;
  };
  readonly engagementName?: string;
  readonly scopeVersion?: number | null;
  readonly authorizationExpiresAt?: string | null;
  readonly indexLagEvents?: number | null;
  readonly activePanel?: ConsolePanel;
  readonly onPanelChange?: (panel: ConsolePanel) => void;
  readonly timelineFilter?: TimelineFilter;
  readonly onTimelineFilterChange?: (next: TimelineFilter) => void;
  /**
   * 「当前 Agent 轨迹」：正在工作的 Worker 会话的思维链与工具输出（只读）。
   *
   * 由装配层按快照里的**活动会话**构造；没有活动会话时不传（外壳就不画这一栏）。
   */
  readonly agentTrace?: ReactNode;
  readonly highlightedSessionId?: string | null;
  readonly onSelectSession?: (sessionId: string) => void;
  /** 进入某个会话的对话界面（各阶段会话的入口，§6.2 时间轴）。 */
  readonly onEnterSession?: (dshSessionId: string) => void;
  readonly following?: boolean;
  readonly onToggleFollowing?: () => void;
  readonly panels?: Partial<Readonly<Record<ConsolePanel, ReactNode>>>;
  readonly engagementList?: ReactNode;
  readonly runControls?: ReactNode;
  /** 运行诊断卡（§15.5）：总览页的只读快照，由装配层构造。 */
  readonly diagnosticsCard?: ReactNode;
  readonly wizard?: ReactNode;
  readonly intakeChat?: ReactNode;
  readonly now?: Date;
}

export function ConsoleShell(props: ConsoleShellProps): ReactNode {
  const panel = props.activePanel ?? 'console';
  const { snapshot } = props;

  /**
   * 范围是否已被服务端冻结（`scopeVersion` 存在）。
   *
   * `undefined`（快照还没到）与 `null`（确认过、但**没有**范围版本）必须分开：
   * 前者不该锁任何面板——那会让人在加载期间看到一堆莫名其妙的禁用；
   * 后者才是真正的「范围未确认」闸门（§13.1 的 AUTH_PENDING → READY 那条边）。
   */
  const scopePending = snapshot.state?.scopeVersion === null;
  const lockReasonOf = (candidate: ConsolePanel): string | null => {
    if (!scopePending) return null;
    // 公共记忆是作业级的（与范围无关），范围确认前也允许改。
    if (candidate === 'publicmemory') return null;
    return '范围尚未确认：先在下方「授权范围 intake」里确认范围方案，或点上方「新建 engagement」走授权向导';
  };
  const enabledPanels = CONSOLE_PANELS.filter((candidate) => lockReasonOf(candidate) === null);

  /**
   * WAI-ARIA 的 tab 键盘约定：左右箭头在**可用**面板之间移动，Home/End 到两端。
   * 不实现的话，键盘用户按 Tab 只能落在当前 tab 上——八个面板等于不可达。
   */
  const onTabsKeyDown = (event: { key: string; preventDefault: () => void }): void => {
    if (props.onPanelChange === undefined) return;
    const index = enabledPanels.indexOf(panel);
    const step = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0;
    let next: ConsolePanel | undefined;
    if (step !== 0) {
      const base = index === -1 ? (step > 0 ? -1 : 0) : index;
      next = enabledPanels[(base + step + enabledPanels.length) % enabledPanels.length];
    } else if (event.key === 'Home') next = enabledPanels[0];
    else if (event.key === 'End') next = enabledPanels[enabledPanels.length - 1];
    if (next === undefined || next === panel) return;
    event.preventDefault();
    props.onPanelChange(next);
  };

  return (
    <div className={`pentest-console${snapshot.loading ? ' pentest-console--busy' : ''}`}>
      {/*
        ⓪ engagement 入口。**必须真的渲染**：列表、选择、筛选与「新建」都在这个节点里，
        它缺席就等于人类进不了任何作业（此前它只存在于 `shellProps`，从未出现在返回结构里）。
        无条件渲染，包括没选中任何作业时——那正是需要它的时机。
      */}
      {props.engagementList}

      {/* ① 运行总览：始终可见——它决定当前屏幕上的一切是否还可信 */}
      <RunHeader
        engagementName={resolveEngagementName(props.engagementName, snapshot)}
        state={snapshot.state}
        scopeVersion={props.scopeVersion ?? null}
        authorizationExpiresAt={props.authorizationExpiresAt ?? null}
        indexLagEvents={props.indexLagEvents ?? null}
        lastError={snapshot.lastError}
        conflict={snapshot.conflict}
        {...(props.now === undefined ? {} : { now: props.now })}
      />

      {/* 面板切换：WAI-ARIA tablist。锁定的面板**显式禁用并给出原因**，而不是点了不动。 */}
      <nav className="pentest-console__tabs" role="tablist" aria-label="控制台视图" onKeyDown={onTabsKeyDown}>
        {CONSOLE_PANELS.map((candidate) => {
          const reason = lockReasonOf(candidate);
          const active = candidate === panel;
          return (
            <button
              key={candidate}
              type="button"
              role="tab"
              id={`pentest-tab-${candidate}`}
              aria-controls={`pentest-panel-${candidate}`}
              aria-selected={active}
              tabIndex={active ? 0 : -1}
              className={`pentest-console__tab${active ? ' is-active' : ''}`}
              disabled={reason !== null}
              title={reason ?? PANEL_LABELS[candidate]}
              onClick={props.onPanelChange === undefined ? undefined : () => { props.onPanelChange?.(candidate); }}
            >
              {PANEL_LABELS[candidate]}
            </button>
          );
        })}
      </nav>

      {snapshot.loading ? <Badge text="正在加载…" tone="neutral" /> : null}

      <div className="pentest-panelbody" role="tabpanel" id={`pentest-panel-${panel}`} aria-labelledby={`pentest-tab-${panel}`}>
        {snapshot.selectedEngagementId === null ? (
          /*
            未选中作业时渲染什么，取决于**为什么**没有选中：

              - 有 intake 会话（真实应用总是给）→ 渲染它：那是授权范围的人机对话，
                它自己就是「下一步」。
              - 没有 intake 会话（测试或宿主未装配）→ 按列表是否为空分两种空态：
                空列表要去**授权向导**（还没有作业可进），非空列表只需在**上方入口**里点一下。
                两者混成一句「等待 intake」，人类既看不出缺什么，也不知道该做什么。
          */
          props.intakeChat ?? (
            <Card title="尚未进入任何作业">
              {snapshot.engagements.length === 0 ? (
                <Empty
                  title="还没有任何 engagement"
                  reason="先在上方点「新建」运行授权向导：它会创建作业，并确定授权范围与授权期限。"
                />
              ) : (
                <Empty
                  title="尚未选中 engagement"
                  reason="请从上方选择一个 engagement：选中后才会加载它的阶段轨道与会话时间轴。"
                />
              )}
            </Card>
          )
        ) : lockReasonOf(panel) !== null && props.intakeChat !== undefined ? (
          /*
            范围未确认：这张卡片就是人类此刻唯一要做的事（确认范围），因此它在**任何**被锁的
            面板下都显示——但绝不让 tab 装作可用（上面已禁用）。这正是原来「点了 tab 有高亮、
            内容却不动」的修法：把静默变成说明。
          */
          <>
            {props.intakeChat}
            <Card title="范围未确认时被锁的面板">
              <Empty
                title={`${CONSOLE_PANELS.filter((c) => lockReasonOf(c) !== null).map((c) => PANEL_LABELS[c]).join(' / ')} 暂不可用`}
                reason={CONSOLE_PANELS.map((candidate) => lockReasonOf(candidate)).find((r) => r !== null) ?? ''}
              />
            </Card>
          </>
        ) : panel === 'console' ? (
          <>
            {props.runControls}
            <PhaseTrack
              sessions={snapshot.sessions}
              {...(props.now === undefined ? {} : { now: props.now })}
            />
            {props.diagnosticsCard}
          </>
        ) : panel === 'logs' ? (
          <>
            {props.agentTrace}
            <SessionTimeline
              sessions={snapshot.sessions}
              filter={props.timelineFilter ?? {}}
              {...(props.onTimelineFilterChange === undefined ? {} : { onFilterChange: props.onTimelineFilterChange })}
              highlightedSessionId={props.highlightedSessionId ?? null}
              {...(props.onSelectSession === undefined ? {} : { onSelectSession: props.onSelectSession })}
              {...(props.onEnterSession === undefined ? {} : { onEnterSession: props.onEnterSession })}
              following={props.following === true}
              {...(props.onToggleFollowing === undefined ? {} : { onToggleFollowing: props.onToggleFollowing })}
              {...(props.now === undefined ? {} : { now: props.now })}
            />
          </>
        ) : (
          props.panels?.[panel] ??
          /*
            到这里的只有两种情形，都必须**分别说清**（§6.2.3 的 P16）：
              - 数据还没读到（面板节点由数据驱动，读到才生成）；
              - 读到失败（快照里带着稳定错误码）。
            笼统写「尚未接入」会把「正在读」说成「没做」，那是撒谎。
          */
          (snapshot.lastError !== null ? (
            <Card title={PANEL_LABELS[panel]}>
              <ErrorBar code={snapshot.lastError.code} message={snapshot.lastError.message} />
              <Empty
                title="该面板的数据没有读到"
                reason="失败原因见上方的稳定错误码；修好后切走再切回即可重读。"
              />
            </Card>
          ) : (
            <Card title={PANEL_LABELS[panel]}>
              <Empty
                title="正在读取该面板的数据…"
                reason="面板按需加载：切到它时才向 Host 取数。若取数失败，这里会显示稳定错误码而不是空白。"
              />
            </Card>
          ))
        )}
      </div>
      {props.wizard}
    </div>
  );
}

/**
 * 取显示用的 engagement 名。
 *
 * `WorkflowSnapshot` 只有 id（它服务状态机，不是展示对象），因此名字要从列表里找。
 * 找不到（例如列表还没加载）时回落到 id 的前八位——显示一个截断 id 比显示空白好，
 * 至少能确认「当前上下文是哪一个」。
 *
 * 调用方显式传入的名字优先：某些场景（新建 engagement 后立刻选中）列表还没刷新，
 * 但调用方已经知道名字。
 */
function resolveEngagementName(
  explicit: string | undefined,
  snapshot: ConsoleShellProps['snapshot'],
): string {
  if (explicit !== undefined && explicit !== '') return explicit;
  const id = snapshot.selectedEngagementId;
  if (id === null) return '—';
  const found = snapshot.engagements.find((e) => e.id === id);
  return found?.name ?? id.slice(0, 8);
}
