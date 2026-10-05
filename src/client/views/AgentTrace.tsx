/**
 * 「当前 Agent 轨迹」：在控制台里直接看**正在工作的那个 Worker 会话**在做什么。
 *
 * ── 为什么要有它（而不再依赖会话页自动跟随）──
 *
 * 一阶段一会话，Agent 的思维链与工具输出都在它自己的会话里。会话页的自动跟随目前在
 * 本部署里**不生效**（外部插件取到的客户端导航服务没接线，见 RUNBOOK §6.5.4），
 * 于是人类在控制台看不到任何过程。这个视图绕开客户端导航：它走 dsh 自己的 `session/page`
 * 端点（与 `SessionChat` 同一个调用面）读任意会话的事件，把**工具调用 / 结果 / 思考 / 回复**
 * 原样铺开——这条通道只依赖服务端，必定可用。
 *
 * 只读：这里不发消息、不做决策；要插话/纠偏仍走会话页或运行控制的插话入口。
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';

import type { WorkerSessionSummary } from '../../contracts.ts';
import type { SessionChatRpc } from '../session-chat.ts';
import { SessionChatClient, traceTranscript, type TraceRow } from '../session-chat.ts';
import { phaseLabel, sessionStatusLabel, sessionStatusTone } from '../format.ts';
import { Badge, Button, Card, Empty, ErrorBar } from '../ui.tsx';

/** 运行中的会话读得勤一点；已结束的会话没有再读的必要，给一个慢周期。 */
const ACTIVE_POLL_MS = 5_000;
const IDLE_POLL_MS = 15_000;

const LIVE_STATUSES: readonly WorkerSessionSummary['status'][] = ['starting', 'active', 'waiting_human', 'handoff_drafting', 'transition_confirmation', 'paused', 'blocked'];

/** 会话状态的中文标签来自 `format.ts` 的**单源**（`sessionStatusLabel`）——此前本文件与时间轴各一份，措辞已分叉。 */

export interface AgentTraceProps {
  /** 与 `SessionChat` 同一个调用面（走 dsh 的 `session/page`）。 */
  readonly rpc: SessionChatRpc | undefined;
  /** 要看的 Worker 会话（通常是当前活动的那一个）。 */
  readonly session: WorkerSessionSummary;
}

export function AgentTrace(props: AgentTraceProps): ReactNode {
  const { rpc, session } = props;
  const sessionId = session.dshSessionId;
  const [client, setClient] = useState<SessionChatClient | null>(null);
  const [rows, setRows] = useState<readonly TraceRow[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [readAt, setReadAt] = useState<string | null>(null);

  // 换成另一个会话（换阶段/重试）就换一个客户端：游标缓存属于会话。
  useEffect(() => {
    setClient(rpc === undefined ? null : new SessionChatClient({ rpc }));
  }, [rpc]);

  const read = useCallback(async (): Promise<void> => {
    if (client === null) return;
    setBusy(true);
    try {
      const page = await client.read(sessionId, new AbortController().signal);
      setRows(traceTranscript(page.records));
      setReadAt(new Date().toLocaleTimeString());
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }, [client, sessionId]);

  // 换会话立刻读一次。
  useEffect(() => {
    setRows(null);
    void read();
  }, [read]);

  // 轮询：运行中的会话更勤一些（人类看着的就是「它现在做到哪了」）。
  const live = LIVE_STATUSES.includes(session.status);
  useEffect(() => {
    const handle = setInterval(() => { void read(); }, live ? ACTIVE_POLL_MS : IDLE_POLL_MS);
    return () => { clearInterval(handle); };
  }, [read, live]);

  const counts = useMemo(() => {
    const source = rows ?? [];
    return {
      tool: source.filter((row) => row.kind === 'tool-call').length,
      thinking: source.filter((row) => row.kind === 'thinking').length,
      reply: source.filter((row) => row.kind === 'reply').length,
    };
  }, [rows]);

  return (
    <Card title={`当前 Agent 轨迹（${phaseLabel(session.phase)}）`}>
      <div className="pentest-session-chat__bar">
        <Badge text={sessionStatusLabel(session.status)} tone={sessionStatusTone(session.status)} hint={session.status} />
        <Badge text={`工具 ${String(counts.tool)}`} tone="neutral" />
        <Badge text={`思考 ${String(counts.thinking)}`} tone="neutral" />
        <Badge text={`回复 ${String(counts.reply)}`} tone="neutral" />
        <Button label={busy ? '读取中…' : '刷新轨迹'} onClick={() => { void read(); }} disabled={busy} />
        {readAt === null ? null : <span className="pentest-session-chat__stamp">{`最后读取 ${readAt}`}</span>}
      </div>

      <p className="pentest-session-chat__intro">
        {`会话 ${sessionId.slice(0, 20)}。这一栏读的是**该 Agent 自己会话**的事件流：工具调用、结果、思考与回复都原样铺开。`}
        {live ? '（运行中，每 5 秒自动刷新）' : '（已结束，不再频繁刷新）'}
      </p>

      {session.statusNote === null ? null : (
        <p className="pentest-intake__note" title={session.statusNote}>{`状态便签：${session.statusNote}`}</p>
      )}

      {error === null ? null : <ErrorBar code="session-read-failed" message={error} />}

      <div className="pentest-session-chat" aria-live="polite" aria-label="当前 Agent 轨迹">
        {rows === null ? (
          <Empty title="尚未读取该会话" reason="正在读取该 Agent 会话的事件流。" />
        ) : rows.length === 0 ? (
          <Empty
            title="该会话还没有可显示的事件"
            reason="会话已建立但还没有工具调用或回复；等它开始工作后这里会出现轨迹。"
          />
        ) : (
          rows.map((row) => (
            <div key={row.key} className={`pentest-msg pentest-msg--${msgRole(row.kind)}`} data-seq={row.seq}>
              <span className="pentest-msg__label">{row.label}</span>
              <pre className="pentest-msg__body">{row.text}</pre>
            </div>
          ))
        )}
      </div>
    </Card>
  );
}

/** 轨迹种类 → 既有消息样式（不新增 CSS，避免「类名没有样式」那类历史坑）。 */
function msgRole(kind: TraceRow['kind']): 'agent' | 'system' | 'tool' {
  switch (kind) {
    case 'reply':
      return 'agent';
    case 'tool-call':
    case 'tool-result':
      return 'tool';
    default:
      return 'system';
  }
}
