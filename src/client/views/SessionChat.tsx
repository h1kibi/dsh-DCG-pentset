/**
 * 授权范围 intake：**范围确认前**唯一的人机对话面。
 *
 * 设计依据：docs/dsh-pentest-plugin-design.md §6.2、§13.1
 *
 * ── 为什么这一屏必须真的能读会话 ──
 *
 * intake 阶段的目标动作能力为零（没有 `pentest_exec`），Agent 唯一能做的事就是**问**
 * 与**提范围方案**。因此「人类看得见 Agent 问了什么、并且能回话」就是这一阶段的全部
 * 功能；读不到会话时这一屏不是「少一点装饰」，而是**整个 intake 不成立**。
 *
 * ── 三个曾经错的地方（都会让这一屏看起来是「坏的」）──
 *
 *   1. 读取固定传 `throughSeq: -1`，而服务端把 -1 当作「切点在第 0 条之前」→ 永远空页。
 *      界面因此恒显示「等待 Agent 首条消息…」，而会话里其实已经有内容。修法见
 *      {@link SessionChatClient} 的游标发现。
 *   2. 事件原样倾倒（`JSON.stringify` 整段 `data`）：系统提示词一次几 KB，
 *      真正的对话被挤到屏幕外。现在按 {@link projectTranscript} 投影成人读的对话。
 *   3. 发送后不重读：人类投递了授权信息，看不到 Agent 的回应，只能怀疑「没发出去」。
 *      现在发送成功后自动重读一次。
 *
 * ── 会话从哪来 ──
 *
 * 优先用 `openTask` 的结果；**页面重载后 openTask 会因运行时已锁定别的作业而被拒**
 * （每次重载都会换 `clientSessionKey`），此时退回会话列表里活动的 intake 会话——
 * 否则人类一刷新就看不到自己刚建立的授权会话。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import type { BehaviorProfile, PolicyPreview, ScopeProposal } from '../../contracts.ts';
import { APPROVAL_MODES, BEHAVIOR_PROFILES, CUSTOM_GUIDANCE_MAX_CHARS } from '../../contracts.ts';
import type { ApprovalMode } from '../../contracts.ts';
import { APPROVAL_MODE_HINTS, APPROVAL_MODE_LABELS, BEHAVIOR_PROFILE_HINTS, BEHAVIOR_PROFILE_LABELS } from '../presets.ts';
import type { ConsoleController, ConsoleSnapshot } from '../controller.ts';
import type { SessionChatRpc, SessionRecord } from '../session-chat.ts';
import { SessionChatClient, projectTranscript } from '../session-chat.ts';
import { actionClassLabel } from '../format.ts';
import { Badge, Button, Card, Empty, Field, List, Stat, Table, TextArea, TextInput } from '../ui.tsx';

interface SessionChatProps {
  readonly controller: ConsoleController;
  readonly snapshot: ConsoleSnapshot;
  readonly rpc?: SessionChatRpc;
  readonly proposal?: ScopeProposal | null;
}

/** 发送后等一会儿再重读：Agent 的首字通常在这之后出现。 */
const REREAD_AFTER_SEND_MS = 1_500;

/** 授权说明变化后刷新服务端预览的防抖窗口（见 `ScopeProposalCard` 的预览 effect）。 */
const PREVIEW_DEBOUNCE_MS = 400;

/** 活动中的 intake 会话状态。`starting` 也要算——会话行先落库，dsh 会话随后才建起来。 */
const LIVE_INTAKE_STATUSES: readonly string[] = ['starting', 'active', 'waiting_human'];

/** 当前该显示哪个 intake 会话（见文件头）。 */
function intakeSessionId(snapshot: ConsoleSnapshot): string | null {
  if (snapshot.intake !== null && snapshot.intake !== undefined) return snapshot.intake.dshSessionId;
  const live = snapshot.sessions.find(
    (session) => session.sessionKind === 'intake' && LIVE_INTAKE_STATUSES.includes(session.status),
  );
  return live?.dshSessionId ?? null;
}

export function SessionChat(props: SessionChatProps): ReactNode {
  const sessionId = intakeSessionId(props.snapshot);
  const [client, setClient] = useState<SessionChatClient | null>(null);
  const [records, setRecords] = useState<readonly SessionRecord[]>([]);
  const [cursor, setCursor] = useState<number | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [busy, setBusy] = useState(false);
  const [readAt, setReadAt] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  /** 递增即触发一次「稍后重读」；用 state 而不是自己存定时器句柄（清理交给 effect）。 */
  const [rereadTick, setRereadTick] = useState(0);

  // 每次连接换代都换一个客户端：游标缓存属于会话，而游标是**连接的事实**。
  useEffect(() => {
    setClient(props.rpc === undefined ? null : new SessionChatClient({ rpc: props.rpc }));
  }, [props.rpc]);

  useEffect(() => () => { abortRef.current?.abort(); }, []);

  const read = useCallback(async (): Promise<void> => {
    if (client === null || sessionId === null) return;
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setBusy(true);
    try {
      const page = await client.read(sessionId, controller.signal);
      setRecords(page.records);
      setCursor(page.cursor);
      setHasMore(page.hasMore);
      setReadAt(new Date().toLocaleTimeString());
      setError(null);
    } catch (cause) {
      if (controller.signal.aborted) return;
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      if (!controller.signal.aborted) setBusy(false);
    }
  }, [client, sessionId]);

  // 会话一确定就读一次；换会话（含重载后从列表里找回）也重读。
  useEffect(() => {
    void read();
  }, [read]);

  // 发送成功后的延迟重读（见 `send`）。`rereadTick` 从 0 起，所以首渲染不排定时器。
  useEffect(() => {
    if (rereadTick === 0) return undefined;
    const handle = setTimeout(() => { void read(); }, REREAD_AFTER_SEND_MS);
    return () => { clearTimeout(handle); };
  }, [rereadTick, read]);

  const loadOlder = useCallback(async (): Promise<void> => {
    const first = records[0]?.event.seq;
    if (client === null || sessionId === null || first === undefined) return;
    setBusy(true);
    try {
      const older = await client.loadOlder(sessionId, first);
      setRecords((current) => [...older.records, ...current]);
      setHasMore(older.hasMore);
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }, [client, records, sessionId]);

  const send = useCallback((): void => {
    if (client === null || sessionId === null || text.trim() === '') return;
    const outgoing = text.trim();
    setSending(true);
    void client
      .send(sessionId, outgoing, 'queue')
      .then(() => {
        setText('');
        setError(null);
        // 稍后重读一次：人类的这条消息会以 `agent/inbox/spliced` 出现，Agent 的首字
        // 通常也在这之后。定时器由 effect 持有，卸载时自动清理。
        setRereadTick((tick) => tick + 1);
      })
      .catch((cause: unknown) => {
        setError(cause instanceof Error ? cause.message : String(cause));
      })
      .finally(() => {
        setSending(false);
      });
  }, [client, sessionId, text]);

  const projection = useMemo(() => projectTranscript(records), [records]);
  const transcriptRef = useRef<HTMLDivElement | null>(null);

  // 新消息到达时滚到底部：跟随最新是这一屏的默认期望。
  useEffect(() => {
    const node = transcriptRef.current;
    if (node === null) return;
    node.scrollTop = node.scrollHeight;
  }, [projection.messages.length]);

  if (sessionId === null) {
    return (
      <Card title="授权范围 intake">
        <Empty
          title="正在打开授权会话"
          reason="控制台会自动创建或恢复 intake；范围确认前不会显示目标执行能力。若列表里已有作业，也可以直接选中它进入。"
        />
      </Card>
    );
  }

  return (
    <Card title="授权范围 intake">
      <div className="pentest-session-chat__bar">
        <Badge text={`会话 ${sessionId.slice(0, 16)}`} tone="neutral" hint={sessionId} />
        <Badge
          text={cursor === null ? '尚未读取' : cursor < 0 ? '会话还没有事件' : `已读到 #${String(cursor)}`}
          tone={cursor !== null && cursor < 0 ? 'attention' : 'done'}
          hint="会话事件是稠密递增的；这个序号是读取的截止点"
        />
        {projection.hiddenEvents > 0 ? (
          <Badge
            text={`折叠 ${String(projection.hiddenEvents)} 条运行事件`}
            tone="neutral"
            hint="preset / sandbox / policy / turn / step 这类运行事件不进入对话视图"
          />
        ) : null}
        <Button label={busy ? '读取中…' : '刷新对话'} onClick={() => { void read(); }} disabled={busy} />
        {hasMore ? (
          <Button
            label="载入更早"
            onClick={() => { void loadOlder(); }}
            disabled={busy}
            reason={busy ? '正在读取' : undefined}
          />
        ) : null}
        {readAt === null ? null : <span className="pentest-session-chat__stamp">{`最后读取 ${readAt}`}</span>}
      </div>

      <p className="pentest-session-chat__intro">
        Agent 会主动询问目标、排除项、协议、端口、允许动作、时间窗；收集完整后它会提交一份
        <strong>待人类确认的范围方案</strong>。范围确认前它不能执行任何目标动作。
      </p>

      <div className="pentest-session-chat" ref={transcriptRef} aria-live="polite" aria-label="授权会话记录">
        {projection.messages.length === 0 ? (
          <Empty
            title={cursor === null ? '尚未读取会话' : cursor < 0 ? '会话还没有任何事件' : '还没有可显示的对话'}
            reason={
              cursor === null
                ? '点「刷新对话」读取。'
                : cursor < 0
                  ? '会话已建立但还没有事件——投递任务后应立刻出现一条。请确认 dsh 会话创建成功。'
                  : `已读到 ${String(records.length)} 条运行事件，但其中没有人类或 Agent 的正文。可以在下方补充一条授权信息来启动对话。`
            }
          />
        ) : (
          projection.messages.map((message) => (
            <div
              key={message.key}
              className={`pentest-msg pentest-msg--${message.role}`}
              data-seq={message.seq}
            >
              <span className="pentest-msg__label">{message.label}</span>
              <pre className="pentest-msg__body">{message.text}</pre>
            </div>
          ))
        )}
      </div>

      <div className="pentest-session-chat__composer">
        <Field
          label="向 Agent 补充授权或范围信息"
          hint="例如：目标 http://172.17.0.4:8000/，仅 HTTP GET，不跟随重定向，实验室环境已书面授权"
        >
          <TextArea
            value={text}
            onChange={setText}
            rows={4}
            placeholder="目标、排除项、允许的动作类别、授权依据与有效期……"
          />
        </Field>
        <Button
          label={sending ? '发送中…' : '发送给 Agent'}
          kind="primary"
          onClick={send}
          disabled={sending || text.trim() === '' || client === null}
          reason={
            client === null
              ? '未取得宿主 Connection 服务：无法投递消息'
              : text.trim() === ''
                ? '先写点内容再发送'
                : undefined
          }
        />
      </div>

      {error === null ? null : (
        <p className="pentest-session-chat__error" role="alert">{`会话操作失败：${error}`}</p>
      )}

      {props.proposal === undefined || props.proposal === null ? null : (
        <ScopeProposalCard
          // 换作业/换提案即**重挂载**：授权说明、目标说明、勾选与预览都是「针对某一份方案」的
          // 本地状态，靠 effect 复位总会漏一个（实测漏的是勾选），key 是结构性的保证。
          key={`${props.snapshot.selectedEngagementId ?? 'none'}:${props.proposal.id}`}
          proposal={props.proposal}
          controller={props.controller}
          snapshot={props.snapshot}
        />
      )}
    </Card>
  );
}

/**
 * 待人类确认的范围方案。
 *
 * 人类在这里**编辑并确认**的是「服务端将要写进范围版本 1 的那一份」：目标、排除项、
 * 允许动作类别与授权说明。因此它显示的是结构化表格而不是一段文字——人类要逐行核对
 * 自己即将授权的东西。
 */
function ScopeProposalCard(props: {
  readonly proposal: ScopeProposal;
  readonly controller: ConsoleController;
  readonly snapshot: ConsoleSnapshot;
}): ReactNode {
  const [busy, setBusy] = useState(false);
  const [authorizationNote, setAuthorizationNote] = useState(props.proposal.authorizationNote);
  const [objective, setObjective] = useState(props.proposal.objective);
  const [taskPrompt, setTaskPrompt] = useState('');
  /** 行为预设：**必选项**（不给预选；它决定注入 Agent 的行为指引与宿主节奏）。 */
  const [behaviorProfile, setBehaviorProfile] = useState<BehaviorProfile | ''>('');
  /** `custom` 的自定义指引（人类自己写的行为提示词）。 */
  const [customGuidance, setCustomGuidance] = useState('');
  /** 审批模式：**必选项**（不给预选）。 */
  const [approvalMode, setApprovalMode] = useState<ApprovalMode | ''>('');
  const [error, setError] = useState<string | null>(null);
  /**
   * §13.1 的人类闸门：不勾选就不能确认——光有一个按钮不构成「人看过并同意」。
   *
   * 勾选绑定的是**具体那一份快照哈希**（而不是一个布尔）：策略一改哈希就变，
   * 于是「看过 A 却确认了 B」在结构上不可能。
   */
  const [acknowledgedHash, setAcknowledgedHash] = useState<string | null>(null);
  /**
   * 服务端将冻结的事实（只读端点）。
   *
   * `null` 表示「尚未取得」——包括请求失败。界面**不**替服务端推导任何结论：
   * 取不到就显示未预览并禁用确认（§6.2.0.5）。
   */
  const [preview, setPreview] = useState<PolicyPreview | null>(null);

  const engagementId = props.snapshot.selectedEngagementId;
  /**
   * 授权依据的**归一化形式**：确认用 `authorizationNote.trim()` 作为范围依据并写入策略约束，
   * 因此预览必须用同一个值——否则「说明后面多一个空格」就会让预览的哈希与冻结的哈希不一致。
   */
  const authorizationRef = authorizationNote.trim();

  useEffect(() => {
    // 没选预设就**不预览**：服务端只能拿作业行的旧值，那份预览与随后冻结的
    // 不是同一份策略（人类会对着它勾选）——宁可不给，也不给错的。
    if (engagementId === null || behaviorProfile === '' || approvalMode === '') {
      setPreview(null);
      return;
    }
    let cancelled = false;
    // 输入一变就**立刻作废**旧预览与旧勾选：防抖窗口 + 一次往返之间，界面上的
    // 「服务端将冻结的事实」属于**上一次输入**，而人类可能正好在这个窗口里点确认。
    // 作废是这里唯一安全的动作——留着旧的等于让人确认了另一份策略。
    setPreview(null);
    setAcknowledgedHash(null);
    // 防抖：授权说明是自由文本，逐字重发只读请求没有收益；但**必须**在它变化后刷新，
    // 因为它进哈希。
    const timer = setTimeout(() => {
      void props.controller
        .previewPolicy({
          engagementId,
          proposalId: props.proposal.id,
          targets: props.proposal.targets,
          exclusions: props.proposal.exclusions,
          allowedActions: props.proposal.allowedActions,
          authorizationRef,
          behaviorProfile,
          ...(customGuidance.trim() === '' ? {} : { customGuidance: customGuidance.trim() }),
          approvalMode,
        })
        .then((result) => {
          if (!cancelled) setPreview(result);
        })
        .catch(() => {
          if (!cancelled) setPreview(null);
        });
    }, PREVIEW_DEBOUNCE_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [
    engagementId,
    props.proposal.id,
    props.proposal.targets,
    props.proposal.exclusions,
    props.proposal.allowedActions,
    props.controller,
    authorizationRef,
    behaviorProfile,
    customGuidance,
    approvalMode,
  ]);

  const submit = (): void => {
    if (engagementId === null) return;
    if (behaviorProfile === '') {
      setError('请先选择行为预设：必选项，没有默认值');
      return;
    }
    if (approvalMode === '') {
      setError('请先选择审批模式：必选项，没有默认值');
      return;
    }
    const chosenProfile: BehaviorProfile = behaviorProfile;
    const chosenMode: ApprovalMode = approvalMode;
    // 闸门之外再拦一次：`gates` 只驱动按钮的 disabled，而 disabled 不是安全边界
    // （键盘回车、脚本点击、React 状态竞态都能绕过它）。
    if (preview === null || !preview.ok) {
      setError('尚未取得可用的服务端预览：没有服务端冻结的事实就不能确认');
      return;
    }
    if (acknowledgedHash !== preview.snapshotHash) {
      setError('预览已变化：请重新核对服务端将冻结的事实并重新勾选');
      return;
    }
    setBusy(true);
    void props.controller
      // **先刷新一次状态再确认**：Agent 提交方案时服务端会推进 `state_version`，
      // 而控制台不轮询快照——直接用旧版本会以 `stale_state_version` 失败，
      // 人类的体感是「明明核对过了，点确认却让我刷新」（与聊天卡片同一类缺陷）。
      .refreshState()
      .then(() => props.controller.confirmScopeProposal({
        engagementId,
        proposalId: props.proposal.id,
        objective: objective.trim(),
        targets: props.proposal.targets,
        exclusions: props.proposal.exclusions,
        allowedActions: props.proposal.allowedActions,
        authorizationNote: authorizationRef,
        behaviorProfile: chosenProfile,
        ...(customGuidance.trim() === '' ? {} : { customGuidance: customGuidance.trim() }),
        approvalMode: chosenMode,
        ...(taskPrompt.trim() === '' ? {} : { taskPrompt: taskPrompt.trim() }),
        reason: '人类审核并确认 intake 范围',
      }))
      .then((result) => {
        if (!result.ok) setError(result.message);
        setBusy(false);
      })
      .catch((cause: unknown) => {
        setError(cause instanceof Error ? cause.message : String(cause));
        setBusy(false);
      });
  };

  const gates: string[] = [];
  if (engagementId === null) gates.push('尚未选中 engagement：请先在上方列表里选中这个作业');
  if (objective.trim() === '') gates.push('目标说明不能为空');
  if (authorizationNote.trim() === '') gates.push('授权说明不能为空');
  // 「取不到预览」与「预览被拦」是两回事：前者是还没问服务端，后者是问了但服务端不让过。
  if (behaviorProfile === '') {
    gates.push('必须选择行为预设：它决定注入 Agent 的行为指引与宿主侧节奏');
  }
  if (behaviorProfile === 'custom' && customGuidance.trim() === '') {
    gates.push('custom 预设必须写自定义指引：那段文字就是注入会话的行为指引本体');
  }
  if (approvalMode === '') {
    gates.push('必须选择审批模式：人工审批逐条人批，高权限让服务端自行放行预设内的动作');
  }
  if (preview === null) gates.push('尚未取得服务端预览：没有服务端冻结的事实就不能确认');
  else if (!preview.ok) gates.push(`服务端预览被拦下：${String(preview.blockers.length)} 条原因，未解决前不能确认`);
  const acknowledged = preview !== null && acknowledgedHash === preview.snapshotHash;
  if (!acknowledged) {
    gates.push('需勾选确认已核对服务端规范化的目标、地址裁决、节奏与动作权限；策略任何变化都会要求重新勾选');
  }

  return (
    <Card title="待人类确认的范围方案">
      <div className="pentest-proposal__meta">
        <Badge text={props.proposal.status === 'pending' ? '待确认' : props.proposal.status} tone="attention" />
        <Badge text={`目标 ${String(props.proposal.targets.length)} 条`} tone="neutral" />
        <Badge text={`排除 ${String(props.proposal.exclusions.length)} 条`} tone="neutral" />
        <Badge text={`允许动作 ${String(props.proposal.allowedActions.length)} 类`} tone="neutral" />
      </div>

      <Table
        columns={[
          { key: 'kind', header: '类型' },
          { key: 'value', header: '值' },
          { key: 'protocols', header: '协议' },
          { key: 'ports', header: '端口' },
        ]}
        rows={[...props.proposal.targets]}
        keyOf={(target) => `t:${target.kind}:${target.value}`}
        empty={<Empty title="提案里没有目标" reason="没有目标就没有可授权的范围，无法确认" />}
        renderCell={(target, column) => {
          switch (column) {
            case 'kind':
              return target.kind;
            case 'value':
              return <code className="pentest-proposal__value">{target.value}</code>;
            case 'protocols':
              return target.protocols.join('、');
            case 'ports':
              return target.ports.length === 0
                ? '默认 80/443'
                : target.ports.map((range) => (range.from === range.to ? String(range.from) : `${String(range.from)}-${String(range.to)}`)).join('、');
            default:
              return null;
          }
        }}
      />

      {props.proposal.exclusions.length === 0 ? null : (
        <p className="pentest-proposal__exclusions">
          {`排除项：${props.proposal.exclusions.map((target) => `${target.kind}:${target.value}`).join('、')}`}
        </p>
      )}

      <p className="pentest-proposal__actions">
        {`允许的动作类别：${props.proposal.allowedActions.map(actionClassLabel).join('、') || '空：确认后将没有可执行的动作类别'}`}
      </p>

      {/* ── 服务端将冻结的事实（§6.2.0.5）──
          人类确认的是这一份，而不是 Agent 提案的文本。因此每一项都直接来自 preview：
          客户端不重算哈希、不自行规范化范围、也不推导动作权限。 */}
      <Card title="服务端将冻结的事实">
        {preview === null ? (
          <Empty
            title="尚未取得服务端预览"
            reason="预览请求尚未返回或已失败；取不到服务端结论就不能确认"
          />
        ) : (
          <>
            <p className="pentest-proposal__preview-meta">
              {`范围入口 ${preview.scopeEntryProfile} · 行为预设 ${BEHAVIOR_PROFILE_LABELS[preview.behaviorProfile]}` +
                ` · 审批模式 ${APPROVAL_MODE_LABELS[preview.approvalMode]}`}
            </p>

            {preview.ok ? null : (
              <div className="pentest-proposal__preview-blockers" role="alert">
                <p>{`服务端预览被拦下：${String(preview.blockers.length)} 条原因，未解决前不能确认：`}</p>
                <ul>
                  {preview.blockers.map((blocker) => (
                    <li key={blocker}>{blocker}</li>
                  ))}
                </ul>
              </div>
            )}

            <Table
              columns={[
                { key: 'section', header: '分区' },
                { key: 'kind', header: '类型' },
                { key: 'canonical', header: '规范化' },
                { key: 'protocols', header: '协议' },
                { key: 'ports', header: '端口' },
                { key: 'verdict', header: '判定' },
              ]}
              rows={[
                ...preview.targets.map((entry) => ({ ...entry, section: '目标' })),
                ...preview.exclusions.map((entry) => ({ ...entry, section: '排除' })),
              ]}
              keyOf={(entry) => `${entry.section}:${String(entry.index)}`}
              empty={<Empty title="服务端未返回任何范围条目" reason="没有条目就没有可冻结的范围" />}
              renderCell={(entry, column) => {
                switch (column) {
                  case 'section':
                    return entry.section;
                  case 'kind':
                    return entry.kind;
                  case 'canonical':
                    return <code>{entry.canonical ?? '—'}</code>;
                  case 'protocols':
                    return entry.protocols.join('/');
                  case 'ports':
                    return entry.portSummary;
                  case 'verdict':
                    return entry.rejectionCode === null ? (
                      <Badge text="通过" tone="done" />
                    ) : (
                      <span>
                        <Badge text={entry.rejectionCode} tone="attention" />
                        {entry.detail === null ? null : ` ${entry.detail}`}
                      </span>
                    );
                  default:
                    return null;
                }
              }}
            />

            <h4>地址裁决</h4>
            <List
              items={Object.entries(preview.resolvedAddresses)}
              keyOf={([host]) => host}
              empty={<p>服务端未返回地址裁决</p>}
              render={([host, addresses]) =>
                addresses.length === 0 ? (
                  <span>
                    <code>{host}</code> → <Badge text="解析不到地址：指向它的动作会被拒" tone="danger" />
                  </span>
                ) : (
                  <span>
                    <code>{host}</code> → {addresses.join('、')}
                  </span>
                )
              }
            />

            <h4>执行节奏</h4>
            <div className="pentest-proposal__pacing">
              <Stat label="速率" value={`${String(preview.pacing.rate)} 动作/秒`} />
              <Stat label="并发" value={String(preview.pacing.concurrency)} />
              <Stat label="抖动上限" value={`${String(preview.pacing.jitter)} 秒`} />
              <Stat label="突发桶容量" value={String(preview.pacing.burst)} />
              <Stat label="重试上限" value={String(preview.pacing.retry)} />
            </div>

            <h4>
              {'动作权限 '}
              {preview.dualConfirmed ? <Badge text="已二次确认" tone="done" /> : null}
            </h4>
            <p>{`启用：${preview.enabledActionClasses.join('、') || '无'}`}</p>
            <p>{`禁用：${preview.disabledActionClasses.join('、') || '无'}`}</p>
            <p>{`逐动作放行：${preview.perActionApprovalClasses.join('、') || '无'}`}</p>
            {preview.enabledDisabledClasses.length === 0 ? null : (
              <p>{`默认禁用类别：${preview.enabledDisabledClasses.join('、')}`}</p>
            )}

            <h4>停止条件与凭据</h4>
            <p>{`凭据模式：${preview.credentialMode}`}</p>
            <List
              items={preview.stopConditions}
              keyOf={(condition) => condition}
              empty={<p>服务端未给出停止条件</p>}
              render={(condition) => <span>{condition}</span>}
            />

            <h4>执行约束 · 将进入哈希</h4>
            <List
              items={Object.entries(preview.executionConstraints)}
              keyOf={([key]) => key}
              empty={<p>服务端未给出执行约束</p>}
              render={([key, value]) => (
                <span>
                  <code>{key}</code>：{typeof value === 'string' ? value : JSON.stringify(value)}
                </span>
              )}
            />

            <h4>版本与哈希</h4>
            <p>
              {`确认后：范围 v${String(preview.nextScopeVersion)} · 策略 v${String(preview.nextPolicyVersion)} · ` +
                (preview.nextPolicyEpoch === preview.currentPolicyEpoch
                  ? `epoch 保持 ${String(preview.currentPolicyEpoch)}：首次确认没有在途动作可撤销，后续修订会推进它`
                  : `epoch ${String(preview.currentPolicyEpoch)} → ${String(preview.nextPolicyEpoch)}`)}
            </p>
            <p>
              快照哈希：
              <code title={preview.snapshotHash}>
                {preview.snapshotHash.length > 16 ? `${preview.snapshotHash.slice(0, 16)}…` : preview.snapshotHash}
              </code>
            </p>
          </>
        )}
      </Card>

      <Field
        label="行为预设 · 必选"
        hint="没有默认值。四档对应四种作业场景，决定注入 Agent 的行为指引与宿主侧节奏；确认后随策略快照冻结、进哈希。"
      >
        <select
          className="pentest-select"
          value={behaviorProfile}
          disabled={busy}
          onChange={(event) => {
            const next = event.target.value;
            if ((BEHAVIOR_PROFILES as readonly string[]).includes(next)) {
              setBehaviorProfile(next as BehaviorProfile);
            }
          }}
        >
          <option value="" disabled>请选择本作业的场景</option>
          {BEHAVIOR_PROFILES.map((profile) => (
            <option key={profile} value={profile}>{BEHAVIOR_PROFILE_LABELS[profile]}</option>
          ))}
        </select>
      </Field>
      {behaviorProfile === '' ? (
        <ul className="pentest-proposal__gates">
          {BEHAVIOR_PROFILES.map((profile) => (
            <li key={profile}>{`${BEHAVIOR_PROFILE_LABELS[profile]}：${BEHAVIOR_PROFILE_HINTS[profile]}`}</li>
          ))}
        </ul>
      ) : (
        <p className="pentest-proposal__preview-meta">{BEHAVIOR_PROFILE_HINTS[behaviorProfile]}</p>
      )}
      <Field
        label="审批模式 · 必选"
        hint="没有默认值。人工审批：逐条人批；高权限：预设内且非默认禁用类别的动作由服务端自行放行，只有越界申请才找你。"
      >
        <select
          className="pentest-select"
          value={approvalMode}
          disabled={busy}
          onChange={(event) => {
            const next = event.target.value;
            if ((APPROVAL_MODES as readonly string[]).includes(next)) {
              setApprovalMode(next as ApprovalMode);
            }
          }}
        >
          <option value="" disabled>请选择审批模式</option>
          {APPROVAL_MODES.map((mode) => (
            <option key={mode} value={mode}>{APPROVAL_MODE_LABELS[mode]}</option>
          ))}
        </select>
      </Field>
      {approvalMode === '' ? null : (
        <p className="pentest-proposal__preview-meta">{APPROVAL_MODE_HINTS[approvalMode]}</p>
      )}
      {behaviorProfile === 'custom' ? (
        <>
          <p className="pentest-proposal__preview-meta">
            {`自定义指引会逐字注入该作业下每一次会话，并随策略快照冻结、进哈希。上限 ${String(CUSTOM_GUIDANCE_MAX_CHARS)} 字。`}
          </p>
          <TextArea
            value={customGuidance}
            onChange={setCustomGuidance}
            rows={5}
            placeholder={'例如：\n- 只发只读请求；任何写方法先请我放行。\n- 每条结论都要给证据行。'}
          />
        </>
      ) : null}

      <Field label="目标说明" hint="写给人看的作业目标；会写进决策记录">
        <TextInput value={objective} onChange={setObjective} placeholder="例如：对本地实验室 HTTP 服务做一次被动读取" />
      </Field>

      <Field
        label="授权说明"
        hint={
          // 判据用**本地输入**（不是 `props.proposal.authorizationNote`）：服务端提交提案时
          // 这一项恒为空且被从回显里剥掉，用 props 判断会让这个分支永远走第一条——
          // 人类输入之后提示还停在「这里由你填写」，等于误导。
          authorizationNote.trim() === ''
            ? // Agent 提交方案时不会填这一项（工具只提交目标与动作范围，见 requestScopeConfirmation）：
              // 说清「这里为什么是空的、谁来填」，否则人类会以为界面丢了他的输入。
              'Agent 提交方案时没有提供授权说明，它只提交目标与动作范围；这里由你填写，确认后写进范围版本 1 的 authorization_ref'
            : '授权依据与有效期来源；确认后写进范围版本 1 的 authorization_ref'
        }
      >
        <TextArea
          value={authorizationNote}
          onChange={setAuthorizationNote}
          rows={3}
          placeholder="例如：本人所有、隔离实验室环境，仅本次只读验证，2026-09-29 授权"
        />
      </Field>

      <Field
        label="第一阶段任务提示词 · 可选"
        hint="留空则用目标说明。这一段会作为情报收集阶段 Agent 的任务简报"
      >
        <TextArea
          value={taskPrompt}
          onChange={setTaskPrompt}
          rows={3}
          placeholder="例如：只做一次被动 HTTP GET，不跟随重定向，不使用主动探测模板"
        />
      </Field>

      {/* 人类闸门：勾选的是**这一份**快照（策略一变哈希就变，勾选随之失效），
          与「预览通过」是两件事，缺一不可（§13.1）。 */}
      <label className="pentest-proposal__ack">
        <input
          type="checkbox"
          checked={acknowledged}
          disabled={preview === null || !preview.ok}
          onChange={() => {
            setAcknowledgedHash(acknowledged ? null : (preview?.snapshotHash ?? null));
          }}
        />
        <span>我已核对服务端规范化的目标、地址裁决、节奏与动作权限；确认后会产生指向上述地址的主动动作。</span>
      </label>

      {gates.length === 0 ? null : (
        <ul className="pentest-proposal__gates">
          {gates.map((gate) => (
            <li key={gate}>{gate}</li>
          ))}
        </ul>
      )}

      <div className="pentest-proposal__actions-bar">
        <Button
          label={busy ? '确认中…' : '确认范围并创建第一阶段 Agent'}
          kind="primary"
          onClick={submit}
          disabled={busy || gates.length > 0}
          reason={gates.length > 0 ? gates[0] : busy ? '正在提交' : undefined}
        />
        <Button
          label="驳回这份提案"
          onClick={() => {
            if (engagementId === null) return;
            setBusy(true);
            void props.controller
              .rejectScopeProposal({
                engagementId,
                proposalId: props.proposal.id,
                reason: '人类认为该范围方案需要重新收集',
              })
              .then((result) => {
                if (!result.ok) setError(result.message);
                setBusy(false);
              })
              .catch((cause: unknown) => {
                setError(cause instanceof Error ? cause.message : String(cause));
                setBusy(false);
              });
          }}
          disabled={busy || engagementId === null}
          reason={engagementId === null ? '尚未选中 engagement' : busy ? '正在提交' : undefined}
        />
      </div>

      {error === null ? null : (
        <p className="pentest-session-chat__error" role="alert">{`范围确认失败：${error}`}</p>
      )}
    </Card>
  );
}
