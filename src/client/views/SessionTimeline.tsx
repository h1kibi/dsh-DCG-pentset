/**
 * 会话时间轴：长链任务会话的主视图。
 *
 * 设计依据：docs/dsh-pentest-plugin-design.md §6.2、§6.2.2、§15.2
 *
 * ── 四个必需能力（§6.2）──
 *
 * 1. **迷你地图按迭代分组**：长链的第一屏答案——跑了几轮、每轮几个会话、
 *    哪一轮有需要留意的。
 * 2. **真实时钟轴**：标真实时间而不是序号，人类才能对上「那次扫描是几点做的」。
 * 3. **搜索**：跨字段（阶段、状态、便签、历史指针），见 `timeline.ts`。
 * 4. **孤儿会话可见**：被中断、崩溃遗留、未收尾的会话**必须显示出来并标注**，
 *    不隐藏、不静默清理（§15.2）。渗透测试可能留下未清理的现场。
 *
 * ── 受控而非自持状态 ──
 *
 * 搜索词、跟随开关、当前高亮项都由调用方传入（`props`），组件本身不存状态。
 * 理由：这些是**纯展示状态**（§6.2.3 允许本地保留），但受控化让它们可被
 * 服务端渲染测试，也便于调用方与 URL/快捷键联动。
 */

import type { ReactNode } from 'react';
import type { WorkerSessionSummary } from '../../contracts.ts';
import {
  buildMinimap,
  buildTimeTicks,
  filterSessions,
  orphanInfo,
} from '../timeline.ts';
import type { TimelineFilter } from '../timeline.ts';
import {
  formatTimestamp,
  phaseLabel,
  sessionStatusTone,
  truncate,
} from '../format.ts';
import { Badge, Button, Card, Empty, TextInput, toneClass } from '../ui.tsx';

interface SessionTimelineProps {
  readonly sessions: readonly WorkerSessionSummary[];
  /**
   * 「进入会话」：切到该会话的对话界面（人类报障：各阶段的会话只能看，进不去）。
   * 与 `onSelectSession`（高亮/联动筛选）**不是一件事**，因此各自一个入口。
   */
  readonly onEnterSession?: (dshSessionId: string) => void;
  /** 当前搜索/筛选条件（受控）。 */
  readonly filter?: TimelineFilter;
  readonly onFilterChange?: (next: TimelineFilter) => void;
  /** 当前高亮的会话（跟随模式的落点）。 */
  readonly highlightedSessionId?: string | null;
  readonly onSelectSession?: (sessionId: string) => void;
  /** 跟随模式：工作时自动把最新会话纳入视野。 */
  readonly following?: boolean;
  readonly onToggleFollowing?: () => void;
  readonly noteMaxChars?: number;
  readonly now?: Date;
}

export function SessionTimeline(props: SessionTimelineProps): ReactNode {
  const filter = props.filter ?? {};
  const visible = filterSessions(props.sessions, filter);
  const minimap = buildMinimap(props.sessions);
  const ticks = buildTimeTicks(props.sessions);
  const noteMax = props.noteMaxChars ?? 80;
  const hiddenCount = props.sessions.length - visible.length;

  return (
    <Card title="会话时间轴">
      {/* 迷你地图：长链的第一屏答案（§6.2） */}
      {minimap.length === 0 ? null : (
        <div className="pentest-minimap" aria-label="会话迷你地图 · 按迭代分组">
          {minimap.map((group) => (
            <div key={String(group.iteration)} className="pentest-minimap__group" data-iteration={group.iteration}>
              <span className="pentest-minimap__label">
                第 {group.iteration} 轮
                {group.hasAttention ? <em className="pentest-minimap__alert">有需留意</em> : null}
              </span>
              <span className="pentest-minimap__blocks">
                {group.blocks.map((block) => (
                  <button
                    key={block.sessionId}
                    type="button"
                    className={toneClass('pentest-minimap__block', block.tone)}
                    title={block.title}
                    data-session-id={block.sessionId}
                    onClick={props.onSelectSession === undefined
                      ? undefined
                      : () => { props.onSelectSession?.(block.sessionId); }}
                  />
                ))}
              </span>
            </div>
          ))}
        </div>
      )}

      {/* 搜索与跟随 */}
      <div className="pentest-timeline__controls">
        <TextInput
          value={filter.text ?? ''}
          onChange={(next) => { props.onFilterChange?.({ ...filter, text: next }); }}
          placeholder="搜索：阶段 / 状态 / 便签 / 会话标识"
        />
        <label className="pentest-timeline__follow">
          <input
            type="checkbox"
            checked={props.following === true}
            onChange={props.onToggleFollowing === undefined ? undefined : props.onToggleFollowing}
          />
          <span>跟随最新会话</span>
        </label>
        {hiddenCount === 0 ? null : (
          <span className="pentest-timeline__filtered">
            已按条件隐藏 {String(hiddenCount)} 个会话
          </span>
        )}
      </div>

      {/* 时钟轴刻度：真实时间，不是序号 */}
      {ticks.length <= 1 ? null : (
        <div className="pentest-timeline__axis" aria-hidden="true">
          {ticks.map((tick) => (
            <span key={tick.at} className="pentest-timeline__tick">{tick.label}</span>
          ))}
        </div>
      )}

      {props.sessions.length === 0 ? (
        <Empty
          title="还没有任何 Worker 会话"
          reason="人类在控制台启动首个 Agent 后，这里会显示每个会话的起止、状态与便签"
        />
      ) : visible.length === 0 ? (
        <Empty
          title="没有匹配的会话"
          reason="换一个搜索词，或清空筛选条件"
        />
      ) : (
        <ol className="pentest-timeline" role="list">
          {visible.map((session) => (
            <SessionRow
              key={session.id}
              session={session}
              noteMaxChars={noteMax}
              highlighted={props.highlightedSessionId === session.id}
              {...(props.onSelectSession === undefined ? {} : { onSelect: props.onSelectSession })}
              {...(props.onEnterSession === undefined ? {} : { onEnter: props.onEnterSession })}
              {...(props.now === undefined ? {} : { now: props.now })}
            />
          ))}
        </ol>
      )}
    </Card>
  );
}

/** 一个会话卡片。 */
function SessionRow(props: {
  readonly session: WorkerSessionSummary;
  readonly noteMaxChars: number;
  readonly highlighted: boolean;
  readonly onSelect?: (sessionId: string) => void;
  readonly onEnter?: (dshSessionId: string) => void;
  readonly now?: Date;
}): ReactNode {
  const { session } = props;
  const orphan = orphanInfo(session);
  const interactive = props.onSelect !== undefined;

  return (
    <li
      className={`pentest-timeline__row${props.highlighted ? ' is-highlighted' : ''}`}
      data-session-id={session.id}
      data-status={session.status}
    >
      <button
        type="button"
        className={toneClass('pentest-timeline__card', sessionStatusTone(session.status))}
        disabled={!interactive}
        onClick={interactive ? () => { props.onSelect?.(session.id); } : undefined}
      >
        <span className="pentest-timeline__head">
          <Badge text={phaseLabel(session.phase)} tone={sessionStatusTone(session.status)} />
          <span className="pentest-timeline__status">{session.status}</span>
          <span className="pentest-timeline__time">{formatTimestamp(session.createdAt, props.now)}</span>
          {session.attempt > 1 ? <Badge text={`第 ${String(session.attempt)} 次执行`} tone="attention" /> : null}
          {session.iteration > 1 ? <Badge text={`第 ${String(session.iteration)} 轮`} tone="neutral" /> : null}
        </span>

        {/* 便签：列表扫描的主要线索（§6.2.2） */}
        {session.statusNote === null || session.statusNote === '' ? null : (
          <span className="pentest-timeline__note" title={session.statusNote}>
            {truncate(session.statusNote, props.noteMaxChars)}
            {session.statusNoteSource === 'derived' ? (
              <em className="pentest-timeline__note-source">自动摘要</em>
            ) : null}
          </span>
        )}

        {/*
          孤儿与会话来源必须显示——这正是 §15.2「不隐藏、不静默清理」的落点。
          未收尾的会话很可能意味着目标上留下了未清理的东西。
        */}
        {orphan === null ? null : (
          <span
            className={toneClass('pentest-timeline__orphan', orphan.needsAttention ? 'attention' : 'neutral')}
          >
            {orphan.reason}
          </span>
        )}

        {session.previousAgentSessionId === null ? null : (
          <span className="pentest-timeline__origin" title={session.previousAgentSessionId}>
            由交接创建
          </span>
        )}
        {session.retryOfSessionId === null ? null : (
          <span className="pentest-timeline__origin" title={session.retryOfSessionId}>
            由重做创建
          </span>
        )}

        <span className="pentest-timeline__foot">
          <span className="pentest-timeline__id" title={session.dshSessionId}>
            {truncate(session.id, 8)}
          </span>
          <span className="pentest-timeline__range">
            {formatTimestamp(session.startedAt, props.now)} → {formatTimestamp(session.endedAt, props.now)}
          </span>
        </span>
      </button>
      {/* 与行按钮**同级**：整行已经是 `<button>`，再嵌一个按钮是非法结构（浏览器会拆开它）。 */}
      {props.onEnter === undefined ? null : (
        <Button
          label="进入会话"
          kind="secondary"
          onClick={() => { props.onEnter?.(session.dshSessionId); }}
        />
      )}
    </li>
  );
}
