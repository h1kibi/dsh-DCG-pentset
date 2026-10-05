/**
 * 会话内「待你确认」卡片（槽位 `conversation.chat.turnTail`，画在**最新一轮 AI 消息的末尾**）。
 *
 * ── 为什么要有这张卡片 ──
 *
 * 之前 Agent 在聊天里说「请到控制台点击确认」，而人类所在的界面**没有任何可点的东西**——
 * 只有侧栏一个入口，还要自己找进去。§13.1 的人类闸门要求「人类看得到并同意」，
 * 一个需要去别的界面里自己找的确认，实质上是「把闸门做成了免责声明」。
 *
 * 这张卡片把**待办本身**放回人类正在打字的位置：谁、要确认什么、勾选、确认/驳回。
 * 选项都是写操作，仍走控制台控制器（同一套 RPC、理由与幂等键），卡片不另开第二条路径。
 *
 * ── 两条纪律 ──
 *
 * 1. **只显示服务端给的事实**：目标、协议、端口、动作类别都来自 `IntakeStatus`，
 *    卡片不重新规范化也不算哈希——只有服务端算出的规范化结果才有意义。
 * 2. **没有待办就不画**：常驻一张空卡片是噪音；状态读不到时同样不画，
 *    但绝不能把「读不到」画成「没有待办」——两者对人的含义相反。
 */

import { createElement, useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import type {
  HandoffDraft,
  IntakeStatus,
  MainStatus,
  Phase,
  ScopeProposal,
  ScopeTarget,
  SessionStatus,
} from '../../contracts.ts';
import { PHASE_DEFINITIONS, PHASE_ORDER, RECOMMENDED_MOVES } from '../../workflow/phases.ts';
import { requestAdvanceDraft } from '../advance-phase.ts';
import { HandoffEditor } from './HandoffEditor.tsx';
import type { BehaviorProfile } from '../../contracts.ts';
import type { ConsoleCallResult } from '../../console/client.ts';
import type { ConsoleController } from '../controller.ts';
import { approvalItemOf, approvalGateOf, formatBytes, type ApprovalItem } from './ApprovalQueue.tsx';
import { actionClassLabel, formatDuration, formatTimestamp, mainStatusLabel, phaseLabel } from '../format.ts';
import { Badge, Button, Card, ErrorBar, Field, TextArea, TextInput } from '../ui.tsx';
import { APPROVAL_MODES, BEHAVIOR_PROFILES, CUSTOM_GUIDANCE_MAX_CHARS } from '../../contracts.ts';
import type { ApprovalMode } from '../../contracts.ts';
import { APPROVAL_MODE_HINTS, APPROVAL_MODE_LABELS, BEHAVIOR_PROFILE_HINTS, BEHAVIOR_PROFILE_LABELS } from '../presets.ts';

/** `conversation.chat` 快照里轮次判定只依赖的那一部分（其余字段不进类型）。 */
export interface ChatSnapshotLike {
  readonly navigation: { items(): readonly { readonly turn: number }[] };
}

/**
 * 轮尾落点判定：只有**最新一轮** AI 消息才挂确认卡片。
 *
 * `turn` 是 `TurnLocation` **对象**（`turn.turn` 才是轮次号，见
 * `dsh-client-ui-conversation` 的契约）。按裸 number 写会让守卫永远为真、
 * 卡片一次都不画——这是实测踩过的坑，因此形态判定单独成函数并上断言：
 * 形态不对 / 不是最新一轮 / 没有会话，一律不画（false 即让链继续）。
 */
export function turnTailVisible(turn: unknown, sessionId: unknown, lastTurn: number | null): boolean {
  if (typeof sessionId !== 'string' || sessionId === '') return false;
  if (lastTurn === null) return false;
  const number = (turn as { turn?: unknown } | null | undefined)?.turn;
  return typeof number === 'number' && number === lastTurn;
}

/**
 * 取「最新一轮」的轮次号；空列表返回 null。
 *
 * 收 `items` 而不是收 `useChat`：**钩子不能在辅助函数里被条件调用**，
 * 组件必须先无条件把 hook 调完再判定，否则 hook 次数一变 React 就抛错、
 * 整条链什么都不画（实测踩过）。因此这里只留下纯的部分。
 */
export function lastTurnOf(items: readonly { readonly turn: number }[]): number | null {
  if (items.length === 0) return null;
  return items[items.length - 1]!.turn;
}

/** 每个作业「上一次自动跟随过的会话」——避免人类手动翻回去后又被拽走。 */
const followedSessions = new Map<string, string>();

/**
 * 阶段推进后该不该把界面切到**正在工作的那个 Agent 会话**。
 *
 * ── 为什么需要它 ──
 *
 * 一阶段一会话：范围确认、以及每一次阶段交接，Agent 都跑在**新的 dsh 会话**里。
 * 界面若不跟着切，人类还停在旧会话上，看到的是「什么都没有」——思维链、工具调用、输出
 * 全在另一个会话里。实测的误解正是「我提交了但没启动 Agent」。
 *
 * ── 三条不切的情形（都要有，否则会变成「抢焦点」） ──
 *
 * 1. **已经在这个会话里**（当前页就是那个 Agent）；
 * 2. **同一段工作已经跟随过一次**——人类手动翻回旧会话时不该被反复拽走；
 * 3. **目标会话已经结束**（closed/failed/superseded）：往死会话上跳只会得到空页面。
 *
 * @returns 要打开的会话标识；`null` 表示保持当前页面。
 */
export function shouldFollowActiveSession(input: {
  readonly engagementId: string;
  readonly currentSessionId: string;
  readonly active: { readonly dshSessionId: string; readonly status: SessionStatus } | null;
}): string | null {
  const active = input.active;
  if (active === null) return null;
  if (active.dshSessionId === input.currentSessionId) return null;
  if (active.status === 'closed' || active.status === 'failed' || active.status === 'superseded') return null;
  if (followedSessions.get(input.engagementId) === active.dshSessionId) return null;
  return active.dshSessionId;
}

/** 记下「已跟随」，供 {@link shouldFollowActiveSession} 去重。 */
export function markSessionFollowed(engagementId: string, dshSessionId: string): void {
  followedSessions.set(engagementId, dshSessionId);
}

/** 工作区行里本模块只用到这两项（其余字段不进类型）。 */
export interface WorkspaceItemLike {
  readonly workspaceId: string;
  readonly sessionIds: readonly string[];
}

/**
 * 跟随计划：目标会话要不要**先连工作区**。
 *
 * ── 为什么不能直接 `openSession` ──
 *
 * Worker 会话住在独立工作区（配置里的 `sessionCwd`）。那个工作区没被连上时，
 * 它的会话不在客户端列表里，而 `sessions.select` 对未知会话**抛错**
 * （`sessions.select: unknown session …`）——跟随于是变成静默空操作。
 * 实测表现：界面在 intake 页纹丝不动，看起来像「跟随没实现」。
 *
 * 因此先在宿主权威的工作区行里按 `sessionIds` 定位归属：找得到就先 `connectWorkspace`
 * （连上之后该工作区的会话才可寻址）再选中；找不到才直接选（可能它本来就在已加载的
 * 工作区里）。`null` = 目标为空，什么都不做。
 */
export function followPlan(input: {
  readonly target: string;
  readonly workspaces: readonly WorkspaceItemLike[];
}): { readonly workspaceId: string | null } | null {
  if (input.target === '') return null;
  const owner = input.workspaces.find((workspace) => workspace.sessionIds.includes(input.target));
  return { workspaceId: owner?.workspaceId ?? null };
}

/**
 * 跟随会话的「确认 + 重试」：打开目标会话，并在**渲染器的当前会话**落定前补几次尝试。
 *
 * ── 为什么需要它（实测）──
 *
 * 我们的导航调用确实改到了活 store（渲染器的 `useSessions` 能看到目标），但约 1 秒后
 * 会被应用侧某个调用者切回旧会话（同一条正规路径；调用者未定位）。因此在落定前补几次，
 * 一旦落定立即停手——跟随是增强，不做无限重试。
 *
 * 全部依赖（打开、读当前、排期）由调用方注入：这样它可以在测试里被完整断言，
 * 而组件里只负责把真实实现接上。
 *
 * @returns 实际尝试的次数（含第一次）。
 */
export function followUntilSettled(input: {
  readonly target: string;
  readonly open: (target: string) => void;
  readonly current: () => string | null;
  /** 每次重试前的等待（毫秒）。 */
  readonly delayMs: number;
  /** 最多尝试几次（含第一次）。 */
  readonly attempts: number;
  readonly schedule: (work: () => void, delayMs: number) => void;
}): number {
  const attempt = (tried: number): void => {
    input.open(input.target);
    if (tried >= input.attempts) return;
    input.schedule(() => {
      if (input.current() === input.target) return;
      attempt(tried + 1);
    }, input.delayMs);
  };
  attempt(1);
  return 1;
}

/** 卡片轮询间隔：提交方案与放行凭证都是低频事件，10 秒足够，不必为它开推送通道。 */
const POLL_INTERVAL_MS = 10_000;

/** 目标行：给人看的形状（`IP 47.109.76.66 · TCP 3002`），不是给解析器看的字段清单。 */
function targetLine(target: ScopeTarget): string {
  const kind =
    target.kind === 'ip' ? 'IP' : target.kind === 'domain' ? '域名' : target.kind === 'cidr' ? '网段' : target.kind;
  const ports =
    target.ports.length === 0
      ? '默认端口'
      : target.ports
          .map((port) => (port.from === port.to ? String(port.from) : `${String(port.from)}–${String(port.to)}`))
          .join('、');
  return `${kind} ${target.value} · ${target.protocols.join('/').toUpperCase()} ${ports}`;
}

/** 卡片要展示的、由服务端事实推导出的结构（纯函数，便于脱离 React 断言）。 */
export interface IntakePromptFacts {
  readonly engagementId: string;
  readonly engagementName: string | null;
  /** 有范围方案要确认时为 true。 */
  readonly hasProposal: boolean;
  /** 有放行凭证待处理时为 true。 */
  readonly hasApprovals: boolean;
  readonly approvalCount: number;
  readonly proposal: ScopeProposal | null;
  readonly targetLines: readonly string[];
  readonly exclusionLines: readonly string[];
  readonly allowedActions: readonly string[];
  /** 作业主状态（状态卡据此说明「已推进到哪一步」）；读不到时为 null。 */
  readonly mainStatus: MainStatus | null;
  /**
   * 服务端当前的 `state_version`：确认/驳回要用它做乐观锁。
   *
   * 会话级控制器没有控制台那份作业快照（它从未 `select()` 过作业），因此版本必须
   * 由服务端随状态一起给——否则卡片只能发 0，而那是必然失败（见 `#fromCard`）。
   */
  readonly stateVersion: number;
}

/**
 * 把 `IntakeStatus` 翻译成「人类要不要行动、行动什么」。
 *
 * 返回 null = 没有可执行的待办（含状态读不到）；界面据此完全不渲染。
 */
export function intakePromptFacts(status: IntakeStatus | null): IntakePromptFacts | null {
  if (status === null || status.engagementId === null) return null;
  const proposal = status.pendingProposal;
  const approvalCount = status.pendingApprovalCount;
  // 没有待办分两种，含义相反：
  //   - `auth_pending`：作业还在等范围提交/确认，卡片没有可做的事 → 不画（避免常驻噪音）；
  //   - 其它状态：范围已经过了这一关，工作转到**另一个会话**里去了 → 必须画一张状态卡，
  //     否则人类停在这个页面上只会看到一片空白（实测：被当成「提交了但没启动 Agent」）。
  if (proposal === null && approvalCount === 0 && (status.mainStatus ?? 'auth_pending') === 'auth_pending') {
    return null;
  }
  return {
    engagementId: status.engagementId,
    engagementName: status.engagementName,
    hasProposal: proposal !== null,
    hasApprovals: approvalCount > 0,
    approvalCount,
    proposal,
    targetLines: proposal === null ? [] : proposal.targets.map(targetLine),
    exclusionLines: proposal === null ? [] : proposal.exclusions.map(targetLine),
    // 动作类别按**人类标签**展示（`被动读取` 而不是 `passive_read`）：这行字是给人核对用的。
    allowedActions: proposal === null ? [] : proposal.allowedActions.map(actionClassLabel),
    mainStatus: status.mainStatus,
    stateVersion: status.stateVersion,
  };
}

/**
 * 会话内的放行区（§10.3.1「人类批准的是**那条即将执行的命令**」）。
 *
 * ── 为什么放在这里，而不是只留一个「去放行队列」的入口 ──
 *
 * 逐动作放行是这条产品线里**最频繁**的人类闸门：一次作业里会有很多次。
 * 把入口留在别的界面，等于让人类在「正在对话的地方」和「能看见命令的地方」之间来回切。
 *
 * ── 两条纪律 ──
 *
 * 1. **证据行与放行队列共用同一份映射与同一套闸门**（`approvalItemOf` / `approvalGateOf`）：
 *    判据只有一处，否则会出现「队列里能批、聊天里批不了」或者更糟的反向不一致。
 * 2. **原样展示完整命令，不做摘要**：摘要会把「批准你看到的东西」变成「批准聊天里的转述」。
 */
export interface PendingApprovalsProps {
  readonly items: readonly ApprovalItem[];
  readonly now: Date;
  readonly busyId: string | null;
  readonly failure: { readonly id: string; readonly message: string } | null;
  /** 卡片只列前几条；多于这些的部分必须在界面上说清楚（不能让人以为就这么多）。 */
  readonly hiddenCount?: number;
  readonly onDecide: (id: string, decision: 'approved' | 'rejected', reason: string) => void;
  readonly onOpenConsole: () => void;
}

export function PendingApprovals(props: PendingApprovalsProps): ReactNode {
  const [reasons, setReasons] = useState<Readonly<Record<string, string>>>({});
  if (props.items.length === 0) return null;
  return (
    <Card title={`${String(props.items.length)} 项动作放行等待你判断`}>
      <p className="pentest-proposal__note">
        批准的是**即将执行的那条命令**本身：逐条看清下面的完整命令再决定。
        放行只对这一次执行有效——执行完即被消费，同一条命令不会被执行第二次。
      </p>
      {props.items.map((item) => {
        const reason = reasons[item.id] ?? '';
        const gate = approvalGateOf(item, reason, props.now);
        const busy = props.busyId === item.id;
        return (
          <div key={item.id} className="pentest-approval__row">
            <div className="pentest-approval__head">
              <Badge text={actionClassLabel(item.actionClass)} tone="danger" hint={item.actionClass} />
              <code className="pentest-approval__target">{item.normalizedTarget ?? '（记录缺失：规范化目标）'}</code>
            </div>
            {/* §10.3.1：原样展示，不截断成摘要。 */}
            {/* 与队列同一规则：优先显示服务端解码后的 `display_command`——放开权限后这张卡是
                唯一的内容闸门，把 `command_b64=<base64>` 摆给人类看等于让他盲批。 */}
            <pre className="pentest-approval__command">
              {item.displayCommand ?? item.normalizedCommand ?? '（记录缺失：完整命令）'}
            </pre>
            <span className="pentest-approval__limits">
              {item.timeoutMs === null || item.maxOutputBytes === null
                ? '（记录缺失：超时 / 输出上限）'
                : `超时 ${formatDuration(item.timeoutMs / 1000)} · 输出上限 ${formatBytes(item.maxOutputBytes)}`}
            </span>
            {item.riskSummary === null ? null : (
              <p className="pentest-proposal__note">影响评估：{item.riskSummary}</p>
            )}
            {item.purpose === null ? null : <p className="pentest-proposal__note">申请理由：{item.purpose}</p>}
            <p className="pentest-proposal__note">
              {item.expiresAt === null
                ? '到期时间：未声明（按已过期处理，不得放行）'
                : `到期时间：${formatTimestamp(item.expiresAt, props.now)}`}
            </p>
            {gate.interactive ? (
              <Field label="补充（选填）" hint="填了会随决定进审计，并投递给 Agent 作为上下文补充">
                <TextInput
                  value={reason}
                  placeholder="例如：核对了命令与目标，确认属于本次授权范围内的被动读取"
                  onChange={(next) => {
                    setReasons((prev) => ({ ...prev, [item.id]: next }));
                  }}
                />
              </Field>
            ) : null}
            <p className="pentest-proposal__note">
              {gate.note ?? ''}
              {gate.guidance === null ? '' : ` ${gate.guidance}`}
            </p>
            {props.failure !== null && props.failure.id === item.id ? (
              <p className="pentest-proposal__error">{props.failure.message}</p>
            ) : null}
            <div className="pentest-proposal__actions">
              <Button
                label="批准这一次执行"
                kind="primary"
                disabled={busy || !gate.canApprove}
                {...(gate.approveDisabledReason === null ? {} : { reason: gate.approveDisabledReason })}
                onClick={() => {
                  props.onDecide(item.id, 'approved', reason.trim());
                }}
              />
              <Button
                label="驳回"
                disabled={busy || !gate.canReject}
                {...(gate.rejectDisabledReason === null ? {} : { reason: gate.rejectDisabledReason })}
                onClick={() => {
                  props.onDecide(item.id, 'rejected', reason.trim());
                }}
              />
            </div>
          </div>
        );
      })}
      {props.hiddenCount === undefined || props.hiddenCount <= 0 ? null : (
        <p className="pentest-proposal__note">
          {`另有 ${String(props.hiddenCount)} 条未在此列出——完整队列（含历史与撤销）在放行队列页。`}
        </p>
      )}
      <Button label="去放行队列（历史与撤销）" onClick={props.onOpenConsole} />
    </Card>
  );
}

/**
 * 「范围已确认、Agent 在别处工作」的状态卡（纯展示，便于断言）。
 *
 * 它存在的唯一理由：范围确认之后工作会转到**另一个 dsh 会话**，而人类往往还停在
 * intake 会话页上——没有这张卡，那页就是一片空白，实测被当成「我提交了但没启动 Agent」。
 * 因此这里必须给三件事：Agent 在哪个会话、它在做什么（状态便签）、以及去控制台的路。
 */
/** 状态卡要展示的「当前活动会话」（来源：`getState` + `listWorkerSessions`）。 */
export interface ActiveSessionView {
  readonly dshSessionId: string;
  /** 会话行 id：`requestHandoffDraft` 要的是它（`dshSessionId` 是会话**内容**的标识，两者不可互换）。 */
  readonly workerSessionId: string;
  readonly status: SessionStatus;
  readonly statusNote: string | null;
  readonly phase: Phase;
}

/**
 * 当前阶段横条：**人类所在的这一页**就能看到自己走到哪一阶段了。
 *
 * 为什么需要它（人类报障）：Agent 会话里原本什么都不画（「思维链就在眼前」），
 * 于是推进到下一阶段之后，人类必须进「渗透作业」才能确认当前阶段——而这一页
 * 才是他正在看的地方。这条横条只回答一个问题：**现在是哪一阶段、跑完了哪些**。
 *
 * 横条**自身**只读：它不判断任何动作条件。但**下一步动作要由调用方以 `children` 注入**——
 * 人类待在这个 Agent 会话里时，那张运行卡是不画的（「Agent 在别处工作」在这里是假的），
 * 没有 children 就一个能点的东西都没有（2026-10-05 人类报障：Agent 自己在报告里写
 * 「建议下一步…」，屏幕上却没有按钮）。
 */
export function PhaseStrip(props: {
  readonly engagementName: string | null;
  readonly mainStatus: MainStatus | null;
  readonly currentPhase: Phase | null;
  readonly statusNote: string | null;
  /** 调用方注入的下一步动作（渲染在卡片内、便签之下）。省略即没有动作区。 */
  readonly children?: ReactNode;
}): ReactNode {
  const phase = props.currentPhase;
  const ordinal = phase === null ? null : PHASE_DEFINITIONS[phase].ordinal;
  const title = phase === null || ordinal === null
    ? '当前阶段：读不到（服务端未给出阶段）'
    : `当前阶段 ${String(ordinal)}/${String(PHASE_ORDER.length)} · ${PHASE_DEFINITIONS[phase].displayName}`;
  return (
    <Card title={title}>
      <div className="pentest-proposal__meta">
        <Badge text={props.engagementName ?? '未命名作业'} tone="neutral" />
        {props.mainStatus === null ? null : (
          <Badge text={mainStatusLabel(props.mainStatus)} tone="neutral" hint={props.mainStatus} />
        )}
      </div>
      <ol className="pentest-phase-strip" role="list">
        {PHASE_ORDER.map((id) => {
          const definition = PHASE_DEFINITIONS[id];
          const tone = ordinal === null
            ? 'pending'
            : definition.ordinal < ordinal
              ? 'done'
              : definition.ordinal === ordinal
                ? 'current'
                : 'pending';
          return (
            <li
              key={id}
              className={`pentest-phase-strip__step pentest-phase-strip__step--${tone}`}
              title={`${String(definition.ordinal)}. ${definition.displayName}（${definition.agentName}）`}
              aria-current={tone === 'current' ? 'step' : undefined}
            >
              {definition.shortName}
            </li>
          );
        })}
      </ol>
      {props.statusNote === null ? null : (
        <p className="pentest-proposal__note">最新状态便签：{props.statusNote}</p>
      )}
      {props.children}
    </Card>
  );
}

/**
 * 当前阶段**推荐**的下一个「推进」阶段（`null` = 这张表里没有，说明该用交接编辑手选）。
 *
 * 只取 `kind === 'advance'`：重做/回补/回环都不是「进入下一阶段」，把它们塞进
 * 一键按钮会让人类以为自己只是在往前走。
 */
export function nextAdvancePhase(from: Phase): Phase | null {
  const move = RECOMMENDED_MOVES[from].find((candidate) => candidate.kind === 'advance');
  return move === undefined ? null : move.toPhase;
}

/**
 * 「进入下一阶段」的动作块：按钮 + 失败说明。
 *
 * 抽出来是因为它现在有**两个落点**：别的会话里的运行卡，以及人类正待在其中的那个
 * Agent 会话（那里只画 `PhaseStrip`）。判定只写一份，两个落点不会走偏：
 *   · 只有 Agent 已交报告（`waiting_human_review`）才给按钮——服务端的草稿闸门也只看这一态；
 *   · 拿不到回调就**不画**：省略的意思是「不画这个按钮」，不是画一个点了没反应的；
 *   · 草稿已经在手时调用方也不传回调：此刻要做的是**审计**，不是再生成一份。
 */
export function AdvanceAction(props: {
  readonly mainStatus: MainStatus | null;
  readonly currentPhase: Phase | null;
  readonly onAdvancePhase?: () => void;
  readonly advanceBusy?: boolean;
  readonly advanceError?: string | null;
}): ReactNode {
  if (props.mainStatus !== 'waiting_human_review' || props.onAdvancePhase === undefined) return null;
  const nextPhase = props.currentPhase === null ? null : nextAdvancePhase(props.currentPhase);
  return (
    <>
      <Button
        label={nextPhase === null ? '进入下一阶段' : `进入下一阶段（${phaseLabel(nextPhase)}）`}
        kind="primary"
        disabled={props.advanceBusy === true}
        onClick={props.onAdvancePhase}
      />
      {props.advanceError === null || props.advanceError === undefined ? null : (
        <p className="pentest-proposal__note">进入下一阶段失败：{props.advanceError}</p>
      )}
    </>
  );
}

export interface IntakeRunningCardProps {
  readonly engagementName: string | null;
  readonly mainStatus: MainStatus | null;
  readonly currentPhase: Phase | null;
  readonly activeSession: ActiveSessionView | null;
  /**
   * 「进入下一阶段」：请求当前 Worker 生成交接草稿，再交给人类审计（调用方打开「交接编辑」）。
   *
   * 只在 Agent 已交报告（`waiting_human_review`）时提供——服务端的草稿请求闸门也只看这一态。
   * 拿不到时省略：省略的意思是「不画这个按钮」，不是画一个点了没反应的按钮。
   */
  readonly onAdvancePhase?: () => void;
  readonly advanceBusy?: boolean;
  readonly advanceError?: string | null;
  /**
   * 切到正在工作的那个 Agent 会话（人点）。
   *
   * 与自动跟随是**同一份能力**（落定判据与重试都在 `followSessionTo`），所以复用同一个 prop：
   * 取不到导航能力时省略——省略的意思是「不画这个按钮」，不是画一个点了没反应的按钮。
   */
  readonly onFollowSession?: (dshSessionId: string) => void;
}

export function IntakeRunningCard(props: IntakeRunningCardProps): ReactNode {
  const active = props.activeSession;
  const nextPhase = props.currentPhase === null ? null : nextAdvancePhase(props.currentPhase);
  // 标题按**真实状态**分档：写死「正在运行」会在 Agent 已经交完报告等你判断时撒谎。
  const headline =
    props.mainStatus === 'waiting_human_review'
      ? '范围已确认：第一阶段 Agent 已交报告，等你判断'
      : props.mainStatus === 'worker_running'
        ? '范围已确认：第一阶段 Agent 正在运行'
        : '范围已确认';
  return (
    <Card title={headline}>
      <div className="pentest-proposal__meta">
        <Badge text={props.engagementName ?? '未命名作业'} tone="neutral" />
        {props.mainStatus === null ? null : (
          <Badge text={mainStatusLabel(props.mainStatus)} tone="neutral" hint={props.mainStatus} />
        )}
        {props.currentPhase === null ? null : (
          <Badge text={`阶段：${phaseLabel(props.currentPhase)}`} tone="neutral" />
        )}
      </div>
      <p className="pentest-proposal__note">
        {active === null
          ? '作业已推进到运行阶段。Agent 的对话在另一个会话里进行——进度、状态便签，以及启动/重试都在控制台的「运行控制 · 时间轴」里。'
          : `本阶段的 Agent 在另一个会话里工作（${active.dshSessionId}），这个 intake 会话不再承载对话。`}
      </p>
      {active === null || active.statusNote === null ? null : (
        <p className="pentest-proposal__note">最新状态便签：{active.statusNote}</p>
      )}
      {/* 动作入口随**真实状态**变化，标签不说谎：
          - Agent 已交报告（waiting_human_review）：给人「进入下一阶段」——它请求**交接草稿**
            （下一阶段的提示词 + 要交接的上下文），随后由调用方打开「交接编辑」交人类审计修改；
            注入下一阶段是那一步的人类决定，这里不做；
          - Agent 还在跑：给「去看 Agent 的会话」——此刻没有下一阶段可进，能做的只有跟过去。
          两者都**不再打开控制台**：人类要的是会话切换，控制台由侧栏与常驻状态条提供。 */}
      {props.mainStatus === 'waiting_human_review' && props.onAdvancePhase !== undefined ? null : (
        active === null || props.onFollowSession === undefined ? null : (
          <Button
            label={`去看 Agent 的会话（${active.dshSessionId}）`}
            kind="primary"
            onClick={() => { props.onFollowSession?.(active.dshSessionId); }}
          />
        )
      )}
      <AdvanceAction
        mainStatus={props.mainStatus}
        currentPhase={props.currentPhase}
        {...(props.onAdvancePhase === undefined ? {} : { onAdvancePhase: props.onAdvancePhase })}
        {...(props.advanceBusy === undefined ? {} : { advanceBusy: props.advanceBusy })}
        {...(props.advanceError === undefined ? {} : { advanceError: props.advanceError })}
      />
    </Card>
  );
}

export interface IntakePromptProps {
  readonly controller: ConsoleController;
  /** 当前 dsh 会话标识（会话级槽位的标准 props）。 */
  readonly dshSessionId: string;
  /** 跳到控制台（看服务端将冻结的事实 / 去放行队列）。 */
  readonly onOpenConsole: () => void;
  /**
   * 把界面切到另一个 dsh 会话（`ctx.uiWorkspace.openSession` / `ctx.sessions.open`）。
   * 省略 = 本部署没有客户端导航能力，此时不跟随、也不报错。
   */
  readonly onFollowSession?: (dshSessionId: string) => void;
  /**
   * 阶段推进时**自动**跟随（人没点任何东西）。
   *
   * 与「能力」分开是因为两者风险不同：人类点击时切一下是显然对的；自动切页面则可能
   * 与人类正在看的东西打架（实测还有一次把会话切回去的宿主侧调用，见 §6.5.4）。
   * 默认关闭：只提供能力，不主动切。
   */
  readonly autoFollowSession?: boolean;
}

function IntakePromptBody(props: IntakePromptProps): ReactNode {
  const [facts, setFacts] = useState<IntakePromptFacts | null>(null);
  const [error, setError] = useState<{ readonly code: string; readonly message: string } | null>(null);
  const [busy, setBusy] = useState<'confirm' | 'reject' | null>(null);
  const [acknowledged, setAcknowledged] = useState(false);
  /**
   * 行为预设：**必选项**。
   *
   * agent 引导路径建作业时预设是数据库的隐式默认（没人选过），而确认范围正是人类
   * 决定「这次作业按哪一档打」的唯一时刻——所以这里不给预选，必须显式选。
   */
  const [behaviorProfile, setBehaviorProfile] = useState<BehaviorProfile | ''>('');
  /** `custom` 的自定义指引（人类自己写的行为提示词）。 */
  const [customGuidance, setCustomGuidance] = useState('');
  /** 审批模式：**必选项**（不给预选）。 */
  const [approvalMode, setApprovalMode] = useState<ApprovalMode | ''>('');
  /** 待放行的证据行（`null` = 读不到；空数组 = 确定没有）。 */
  const [approvals, setApprovals] = useState<readonly ApprovalItem[] | null>(null);
  /**
   * 作业运行快照（主状态 / 当前阶段 / 当前活动会话）。
   *
   * 只在**没有待办**时才去读：那时唯一要回答的问题就是「Agent 在哪、在做什么」。
   */
  const [running, setRunning] = useState<{
    readonly mainStatus: MainStatus;
    readonly currentPhase: Phase | null;
    readonly active: ActiveSessionView | null;
  } | null>(null);
  const [advanceBusy, setAdvanceBusy] = useState(false);
  const [advanceError, setAdvanceError] = useState<string | null>(null);
  /**
   * 已生成的交接草稿（§7.2）。
   *
   * 生成后**立刻**在本页把编辑器和盘托出：人类要能审计每一行、改掉不想交接的上下文，
   * 才谈得上确认注入。草稿留在本组件里（不往控制台塞），因为人是在这里点的按钮。
   */
  const [handoffDraft, setHandoffDraft] = useState<HandoffDraft | null>(null);
  /** 交接编辑器关闭后要立刻重读一次快照：`+1` 即触发下面的读效应。 */
  const [refreshTick, setRefreshTick] = useState(0);
  const [busyApprovalId, setBusyApprovalId] = useState<string | null>(null);
  const [approvalFailure, setApprovalFailure] = useState<{ readonly id: string; readonly message: string } | null>(null);
  const { controller, dshSessionId } = props;

  useEffect(() => {
    let cancelled = false;
    const refresh = (): void => {
      void controller
        .intakeStatus(dshSessionId)
        .then(async (status) => {
          if (cancelled) return;
          const next = intakePromptFacts(status);
          setFacts(next);
          // 条目只在**确实有放行待办**时读：没有待办就没有证据要展示，
          // 而这类读端点在 FORCE RLS 下也是真查询，别让常驻卡片每次轮询都白打一发。
          // 没有待办时读一次运行快照：它同时回答「Agent 在哪」与「要不要把界面切过去」。
          const withTodo = next !== null && (next.hasProposal || next.hasApprovals);
          const snapshot = next === null || withTodo
            ? null
            : await controller.runningSnapshotFor(next.engagementId).catch(() => null);
          if (cancelled) return;
          setRunning(snapshot === null
            ? null
            : {
                mainStatus: snapshot.mainStatus,
                currentPhase: snapshot.currentPhase,
                active: snapshot.active === null
                  ? null
                  : {
                      dshSessionId: snapshot.active.dshSessionId,
                      workerSessionId: snapshot.active.id,
                      status: snapshot.active.status,
                      statusNote: snapshot.active.statusNote,
                      phase: snapshot.active.phase,
                    },
              });
          // 交接草稿从**服务端**取回（§7.2）。草稿不能只活在「请求它的那次调用」的返回值里：
          // 草稿那一轮的新消息会让本组件重新挂载，局部状态随之丢失——人类看得见草稿正文，
          // 却找不到确认按钮、也改不了字段（2026-10-05 人类报障）。服务端是唯一事实来源。
          if (snapshot !== null && snapshot.active !== null
              && (snapshot.mainStatus === 'handoff_drafting' || snapshot.mainStatus === 'transition_confirmation')) {
            const draft = await controller.currentHandoffDraft(snapshot.active.id).catch(() => null);
            if (cancelled) return;
            setHandoffDraft(draft);
          }

          // 阶段推进（含首次启动）→ 把界面切到当前正在工作的 Agent 会话：
          // 思维链、工具调用与输出都在那一侧，不跟随就只能看到「什么都没有」。
          const follow = next === null
            ? null
            : shouldFollowActiveSession({
                engagementId: next.engagementId,
                currentSessionId: dshSessionId,
                active: snapshot?.active ?? null,
              });
          if (follow !== null && next !== null && props.autoFollowSession === true) {
            markSessionFollowed(next.engagementId, follow);
            props.onFollowSession?.(follow);
          }
          if (next === null || !next.hasApprovals) {
            setApprovals(null);
            return;
          }
          const details = await controller.approvalsFor(next.engagementId).catch(() => null);
          if (!cancelled) setApprovals(details === null ? null : details.map(approvalItemOf));
        })
        .catch((cause: unknown) => {
          if (!cancelled) {
            setFacts(null);
            setError({ code: 'client_call_failed', message: cause instanceof Error ? cause.message : String(cause) });
          }
        });
    };
    refresh();
    const timer = setInterval(refresh, POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [controller, dshSessionId, refreshTick]);

  // 换了方案就要求重新勾选：勾选针对的是**这一份**方案。
  const proposalId = facts?.proposal?.id ?? null;
  useEffect(() => {
    setAcknowledged(false);
  }, [proposalId]);

  // 换阶段（或换作业）就清掉上一次的推进失败提示：那条红字针对的是**上一份状态**，
  // 留着会让人类以为刚点的那次也失败了（同 `acknowledged` 的道理）。
  useEffect(() => {
    setAdvanceError(null);
  }, [running?.currentPhase ?? null]);

  /**
   * 「进入下一阶段」：请求当前 Worker 生成交接草稿（下一阶段的提示词 + 要交接的上下文），
   * 然后把草稿**交给人类审计**——调用方会打开「交接编辑」，注入与否由那里显式确认。
   *
   * 为什么不再一步到位：服务端只认「草稿 → 确认」这条链路（§5.2 的状态图与 §7.2 的可空键表决），
   * 而确认是**人类的决定**；一键替人类按那个键，等于把审计这一步删掉。
   * 人类明确要求「先生成、给我改、再注入」（2026-10-05）。
   *
   * 三条硬边界（每一步失败都说明原因，不静默）：
   *   1. 只有 `waiting_human_review` 能请求草稿（服务端闸门，这里提前显示）；
   *   2. 目标阶段由推荐表给出；表里没有就直说，让人类去「交接编辑」手选；
   *   3. 草稿**原样**交出去，本函数一个字段都不改——改是人类的活。
   */
  const advance = (): void => {
    const activeSession = running?.active ?? null;
    const fromPhase = running?.currentPhase ?? null;
    if (activeSession === null || fromPhase === null) {
      setAdvanceError('读不到当前会话或阶段：稍后重试（或让 Agent 先提交报告）');
      return;
    }
    const suggestedToPhase = nextAdvancePhase(fromPhase);
    if (suggestedToPhase === null) {
      setAdvanceError(
        `阶段「${phaseLabel(fromPhase)}」没有推荐的下一阶段：请用控制台的「交接编辑」显式选择目标阶段`,
      );
      return;
    }
    setAdvanceBusy(true);
    setAdvanceError(null);
    void requestAdvanceDraft({ controller, activeSession, suggestedToPhase })
      .then((outcome) => {
        if (!outcome.ok) {
          setAdvanceError(outcome.message);
          return;
        }
        setHandoffDraft(outcome.draft);
        // 草稿出来就落定：清掉上一次的失败红字，免得和刚生成的成功状态打架。
        setAdvanceError(null);
        // **必须立刻重读一次**：起稿是一次写操作，它把状态版本推进了一格。而编辑器里的
        // 「确认 / 取消」带的版本来自 `facts.stateVersion`——不刷新就会带着**起稿前**的版本，
        // 人类点下去只会看到 `stale_state_version`（2026-10-05 实测：我在真机上点取消，
        // 服务端果然没落账，草稿一直停在 draft）。
        void controller.intakeStatus(dshSessionId).then((status) => {
          setFacts(intakePromptFacts(status));
        }).catch(() => undefined);
      })
      .finally(() => { setAdvanceBusy(false); });
  };

  /**
   * 一次放行决定。补充是**选填**（`approvalGateOf` 不再拦空值）：填了会随决定投递给 Agent，
   * 这里只负责发请求与**决定后立刻重读**——条目消失本身就是结果的一部分。
   */
  const decide = (approvalId: string, decision: 'approved' | 'rejected', reason: string): void => {
    setBusyApprovalId(approvalId);
    setApprovalFailure(null);
    void controller
      .decideApproval({ approvalId, decision, reason })
      .then(async (result) => {
        if (!result.ok) {
          setApprovalFailure({ id: approvalId, message: `${result.code}：${result.message}` });
        }
        const status = await controller.intakeStatus(dshSessionId).catch(() => null);
        const next = intakePromptFacts(status);
        setFacts(next);
        const details =
          next !== null && next.hasApprovals
            ? await controller.approvalsFor(next.engagementId).catch(() => null)
            : null;
        setApprovals(details === null ? null : details.map(approvalItemOf));
        setBusyApprovalId(null);
      })
      .catch((cause: unknown) => {
        setApprovalFailure({
          id: approvalId,
          message: cause instanceof Error ? cause.message : String(cause),
        });
        setBusyApprovalId(null);
      });
  };

  if (facts === null) return null;

  const approvalItems: readonly ApprovalItem[] = approvals ?? [];
  const approvalsCard: ReactNode = (
    <PendingApprovals
      // **一次只呈现一条**（2026-10-05 人类要求）：Agent 会连着提几条，人一次只能认真看一条
      // 命令；并排出现时他只会批其中一条，其余全悬着。服务端也据此强制「一次只有一条待处理」，
      // 这里做同样的收敛——其余条目降级成「还有 N 条」。
      items={approvalItems.slice(0, 1)}
      now={new Date()}
      busyId={busyApprovalId}
      failure={approvalFailure}
      hiddenCount={approvals === null ? 0 : Math.max(0, facts.approvalCount - 1)}
      onDecide={decide}
      onOpenConsole={props.onOpenConsole}
    />
  );

  if (facts.proposal === null) {
    // 有放行待办但条目读不到（或还没读回来）：退回入口卡片——**不能**画成「没有待办」。
    if (approvalItems.length > 0) return approvalsCard;
    if (!facts.hasApprovals) {
      // 当前页**就是**那个正在工作的 Agent 会话：不画「Agent 在别处」的卡（那是假的），
      // 但必须画**当前阶段**——否则人类推进到下一阶段后，只能进「渗透作业」才知道走到哪了。
      if (running?.active?.dshSessionId === dshSessionId) {
        // 人类**就在**这个 Agent 会话里：画阶段横条，并把「进入下一阶段」挂进同一张卡。
        // 草稿在手时上面还有编辑器——两者一起构成「生成 → 审计 → 提交」的完整落点。
        return (
          <>
            {handoffDraft === null ? null : (
              <HandoffEditor
                controller={controller}
                engagementId={facts.engagementId}
                draft={handoffDraft}
                expectedStateVersion={facts.stateVersion}
                onClose={() => {
                  setHandoffDraft(null);
                  setRefreshTick((value) => value + 1);
                }}
              />
            )}
            <PhaseStrip
              engagementName={facts.engagementName}
              mainStatus={running.mainStatus}
              currentPhase={running.currentPhase}
              statusNote={running.active.statusNote}
            >
              <AdvanceAction
                mainStatus={running.mainStatus}
                currentPhase={running.currentPhase}
                {...(handoffDraft === null ? { onAdvancePhase: advance } : {})}
                advanceBusy={advanceBusy}
                advanceError={advanceError}
              />
            </PhaseStrip>
          </>
        );
      }
      // 没有待办、也没有放行：范围已经过了这一关。告诉人类**Agent 在哪、在做什么**——
      // 工作跑在另一个 dsh 会话里，这一页本身不会再出现对话。
      return (
        <>
          {/* 「进入下一阶段」生成草稿后，**就地**把交接编辑器摆出来：人类要能逐行审计
              提示词与要交接的上下文、改掉不想带过去的部分，确认后才注入下一阶段会话（§7.2）。
              编辑器带自己的确认/取消：确认走 `confirmTransition`（服务端据此创建新会话），
              关闭后重读一次快照——卡片的动作入口会随真实状态换成「去看 Agent 的会话」。 */}
          {handoffDraft === null ? null : (
            <HandoffEditor
              controller={controller}
              engagementId={facts.engagementId}
              draft={handoffDraft}
              expectedStateVersion={facts.stateVersion}
              onClose={() => {
                setHandoffDraft(null);
                // 确认或取消都要重读：卡片的动作入口得跟着真实状态换（确认后是「去看新会话」）。
                setRefreshTick((value) => value + 1);
              }}
            />
          )}
          <IntakeRunningCard
            engagementName={facts.engagementName}
            mainStatus={running?.mainStatus ?? facts.mainStatus}
            currentPhase={running?.currentPhase ?? null}
            activeSession={running?.active ?? null}
            // 导航能力由外层注入（宿主有没有会话导航只有它知道）；推进动作在组件内部实现
            // （它要用控制器与本卡片刚读到的会话/阶段）。
            {...(props.onFollowSession === undefined ? {} : { onFollowSession: props.onFollowSession })}
            // 草稿已经在手（编辑器就在上面）：不再画「进入下一阶段」——此刻要做的是**审计**，
            // 而不是再生成一份。按卡片既有约定，省略 prop 就是「不画这个按钮」。
            {...(handoffDraft === null ? { onAdvancePhase: advance } : {})}
            advanceBusy={advanceBusy}
            advanceError={advanceError}
          />
        </>
      );
    }
    return (
      <Card title={`有 ${String(facts.approvalCount)} 项动作放行等待你处理`}>
        <p>放行条目暂时读不到（连接或权限问题）。放行队列里有等待你判断的动作。</p>
        <Button label="去放行队列" kind="primary" onClick={props.onOpenConsole} />
      </Card>
    );
  }

  const proposal = facts.proposal;
  const presetMissing = behaviorProfile === '';
  const guidanceMissing = behaviorProfile === 'custom' && customGuidance.trim() === '';
  const modeMissing = approvalMode === '';
  const confirmDisabled = busy !== null || !acknowledged || presetMissing || guidanceMissing || modeMissing;

  const act = (kind: 'confirm' | 'reject'): void => {
    // 闸门之外再拦一次：按钮的 disabled 不是安全边界（键盘回车、脚本点击都能绕过）。
    let call: Promise<ConsoleCallResult>;
    if (kind === 'confirm') {
      if (behaviorProfile === '') {
        setError({ code: 'behavior_profile_required', message: '请先选择行为预设（必选项，没有默认值）' });
        return;
      }
      if (approvalMode === '') {
        setError({ code: 'approval_mode_required', message: '请先选择审批模式（必选项，没有默认值）' });
        return;
      }
      const guidance = customGuidance.trim();
      setBusy(kind);
      setError(null);
      call = controller.confirmScopeProposalFromCard({
        dshSessionId,
        expectedStateVersion: facts.stateVersion,
        engagementId: facts.engagementId,
        proposalId: proposal.id,
        objective: proposal.objective,
        targets: proposal.targets,
        exclusions: proposal.exclusions,
        allowedActions: proposal.allowedActions,
        authorizationNote: proposal.authorizationNote,
        behaviorProfile,
        ...(guidance === '' ? {} : { customGuidance: guidance }),
        approvalMode,
        reason: '在会话内确认范围方案（§13.1 人类闸门）',
      });
    } else {
      setBusy(kind);
      setError(null);
      call = controller.rejectScopeProposalFromCard({
        dshSessionId,
        expectedStateVersion: facts.stateVersion,
        engagementId: facts.engagementId,
        proposalId: proposal.id,
        reason: '在会话内驳回范围方案',
      });
    }
    void call
      .then(async (result) => {
        if (!result.ok) setError({ code: result.code, message: result.message });
        // 成功后立刻重读：卡片是否消失本身就是结果的一部分。
        const status = await controller.intakeStatus(dshSessionId).catch(() => null);
        setFacts(intakePromptFacts(status));
        setBusy(null);
        if (result.ok) setAcknowledged(false);
      })
      .catch((cause: unknown) => {
        setError({ code: 'client_call_failed', message: cause instanceof Error ? cause.message : String(cause) });
        setBusy(null);
      });
  };

  return (
    <>
      <Card title="Agent 提交了范围方案，等待你确认">
      <div className="pentest-proposal__meta">
        <Badge text={facts.engagementName ?? '未命名作业'} tone="neutral" />
        <span className="pentest-proposal__summary">
          {`${String(proposal.targets.length)} 个目标 · ${String(proposal.allowedActions.length)} 类动作` +
            (proposal.exclusions.length === 0 ? '' : ` · ${String(proposal.exclusions.length)} 项排除`)}
        </span>
        {facts.hasApprovals ? <Badge text={`放行待处理 ${String(facts.approvalCount)}`} tone="attention" /> : null}
      </div>

      <ul className="pentest-intake__targets">
        {facts.targetLines.map((line) => <li key={`t-${line}`}>{line}</li>)}
        {facts.exclusionLines.map((line) => <li key={`x-${line}`}>排除：{line}</li>)}
      </ul>

      <p className="pentest-intake__actions">
        <span className="pentest-intake__actions-label">允许动作</span>
        {facts.allowedActions.length === 0
          ? '（空——确认后将没有可执行的动作类别）'
          : facts.allowedActions.map((label) => (
              <span key={label} className="pentest-intake__action">{label}</span>
            ))}
      </p>
      {/* 授权说明是可选留痕：没有就不渲染这一行，别让人以为「漏了一项」。 */}
      {proposal.authorizationNote.trim() === '' ? null : (
        <p className="pentest-intake__note" title={proposal.authorizationNote}>
          {`授权说明：${proposal.authorizationNote}`}
        </p>
      )}

      {/* 行为预设：**必选项**（这条路径建作业时用的是隐式默认，必须由人在这里定）。 */}
      <Field
        label="行为预设（必选）"
        hint="没有默认值。它决定注入 Agent 的行为指引（四档场景差异都在这里）与宿主侧速率/并发；确认后随策略快照冻结、进哈希。"
      >
        <select
          className="pentest-select"
          value={behaviorProfile}
          disabled={busy !== null}
          onChange={(event) => {
            const next = event.target.value;
            if ((BEHAVIOR_PROFILES as readonly string[]).includes(next)) {
              setBehaviorProfile(next as BehaviorProfile);
            }
          }}
        >
          <option value="" disabled>请选择本作业的场景（必选）</option>
          {BEHAVIOR_PROFILES.map((profile) => (
            <option key={profile} value={profile}>{BEHAVIOR_PROFILE_LABELS[profile]}</option>
          ))}
        </select>
      </Field>
      {behaviorProfile === '' ? null : (
        <p className="pentest-intake__note">{BEHAVIOR_PROFILE_HINTS[behaviorProfile]}</p>
      )}
      <Field
        label="审批模式（必选）"
        hint="没有默认值。人工审批：逐条人批；高权限：预设内且非默认禁用类别的动作由服务端自行放行，只有越界申请才找你。"
      >
        <select
          className="pentest-select"
          value={approvalMode}
          disabled={busy !== null}
          onChange={(event) => {
            const next = event.target.value;
            if ((APPROVAL_MODES as readonly string[]).includes(next)) {
              setApprovalMode(next as ApprovalMode);
            }
          }}
        >
          <option value="" disabled>请选择审批模式（必选）</option>
          {APPROVAL_MODES.map((mode) => (
            <option key={mode} value={mode}>{APPROVAL_MODE_LABELS[mode]}</option>
          ))}
        </select>
      </Field>
      {approvalMode === '' ? null : (
        <p className="pentest-intake__note">{APPROVAL_MODE_HINTS[approvalMode]}</p>
      )}
      {behaviorProfile === 'custom' ? (
        <>
          <p className="pentest-intake__note">
            {`自定义指引会逐字注入该作业下每一次会话，并随策略快照冻结、进哈希。上限 ${String(CUSTOM_GUIDANCE_MAX_CHARS)} 字。`}
          </p>
          <TextArea
            value={customGuidance}
            onChange={setCustomGuidance}
            rows={5}
            placeholder={'例如：\n- 只发不改变远端状态的只读请求；任何 POST 前先请我放行。\n- 每个发现都要带证据行与下一步。'}
          />
          <p className="pentest-intake__note">{`${String(customGuidance.trim().length)} / ${String(CUSTOM_GUIDANCE_MAX_CHARS)} 字`}</p>
        </>
      ) : null}

      {/* §13.1 的人类闸门：不勾选不能确认；勾选针对的是这一份方案。 */}
      <label className="pentest-proposal__ack">
        <input
          type="checkbox"
          checked={acknowledged}
          disabled={busy !== null}
          onChange={() => { setAcknowledged((value) => !value); }}
        />
        <span>我已核对目标、排除项与允许动作；确认后会产生指向上述地址的主动动作。</span>
      </label>

      {error === null ? null : <ErrorBar code={error.code} message={error.message} />}

      <div className="pentest-intake__buttons">
        <Button label="查看服务端将冻结的事实" onClick={props.onOpenConsole} />
        <Button
          label={busy === 'reject' ? '驳回中…' : '驳回'}
          disabled={busy !== null}
          onClick={() => { act('reject'); }}
        />
        <Button
          label={busy === 'confirm' ? '确认中…' : '确认范围并启动第一阶段 Agent'}
          kind="primary"
          disabled={confirmDisabled}
          onClick={() => { act('confirm'); }}
        />
        </div>
        {/* 主按钮为什么点不动：把原因写在按钮**下面**，而不是留一个灰按钮让人猜。 */}
        {acknowledged || busy !== null ? null : (
          <p className="pentest-intake__gatehint">勾选上方「我已核对」后即可确认并启动第一阶段 Agent。</p>
        )}
        {behaviorProfile === '' ? (
          <p className="pentest-intake__gatehint">先选择**行为预设**（必选项）：它决定注入 Agent 的行为指引与宿主节奏。</p>
        ) : null}
        {guidanceMissing ? (
          <p className="pentest-intake__gatehint">custom 预设需要写一段自定义指引（它就是注入会话的行为指引本体）。</p>
        ) : null}
        {modeMissing ? (
          <p className="pentest-intake__gatehint">先选择**审批模式**（必选项）：人工审批逐条人批，高权限让服务端自行放行预设内的动作。</p>
        ) : null}
      </Card>
      {/* 方案与放行可以同时在等（Agent 一边等确认范围、一边申请了动作放行）：两张都要在场。 */}
      {approvalsCard}
    </>
  );
}

/**
 * 聊天里的「渗透卡片」入口。
 *
 * 令牌根（`.pentest-chat-card`）**必须包住所有分支**：它是 `TOKEN_ROOT_SELECTOR` 的成员，
 * 没有根就没有 `--pt-*`——边框、底色、配色、勾选行的 wash 全部落空，卡片看起来像没上样式的
 * 裸 HTML（2026-10-04 实机报障的成因）。此前只在「有方案」那条分支里包了一层，其余四条
 * 分支（放行卡、阶段条、运行卡、放行读不到）仍是无令牌的裸块——评审在复核时抓到。
 *
 * 因此这里只做一件事：把根包在**所有**分支外面。
 */
export function IntakePrompt(props: IntakePromptProps): ReactNode {
  return createElement('div', { className: 'pentest-chat-card' }, createElement(IntakePromptBody, props));
}
