/**
 * 阶段轨道：状态机的空间表达。
 *
 * 设计依据：docs/dsh-pentest-plugin-design.md §6.2、§6.2.2
 *
 * ── 这一屏的核心 ──
 *
 * 五阶段横向排列，节点间画**两种边**，回环另画一条弧线。边的推导在
 * `phase-track.ts`（纯函数），本组件只负责渲染——因为「只画有证据的边」
 * 是一条关于数据的规则，不是关于视觉的规则。
 *
 * 节点上显示：状态色 / 会话数 / 重做次数 / 最新便签（§6.2.2 的列表扫描用途）。
 * 便签来源为 `derived` 时标注「（自动摘要）」——人类需要知道那不是 Agent 写的。
 */

import { Fragment } from 'react';
import type { ReactNode } from 'react';
import type { WorkerSessionSummary } from '../../contracts.ts';
import { buildPhaseTrack, phaseTone } from '../phase-track.ts';
import type { PhaseEdge, PhaseNode } from '../phase-track.ts';
import { formatCount, formatTimestamp, truncate } from '../format.ts';
import { Badge, Card, Empty, toneClass } from '../ui.tsx';

interface PhaseTrackProps {
  readonly sessions: readonly WorkerSessionSummary[];
  /** 便签在节点上显示的最大字符数。默认 40——轨道是横向布局，空间有限。 */
  readonly noteMaxChars?: number;
  /** 点击某个阶段时的回调（人类想切到那个阶段看详情）。 */
  readonly onSelectPhase?: (phase: string) => void;
  /** 注入的「现在」，便于渲染确定性（测试用）。 */
  readonly now?: Date;
}

export function PhaseTrack(props: PhaseTrackProps): ReactNode {
  const track = buildPhaseTrack(props.sessions);
  const noteMax = props.noteMaxChars ?? 40;

  if (props.sessions.length === 0) {
    return (
      <Card title="阶段轨道">
        <Empty
          title="尚未开始任何阶段"
          reason="在控制台选择首个阶段并启动 Agent 后，这里显示五个节点的进度"
        />
      </Card>
    );
  }

  // 边按 (from,to) 索引：渲染时每对相邻节点查一次，避免在 map 里二次遍历
  const edgeOf = new Map<string, PhaseEdge>();
  for (const edge of track.edges) {
    // 同一对节点可能同时有 sequence 与 handoff/retry 边——保留全部，渲染时都画
    const key = `${edge.from}->${edge.to}`;
    const existing = edgeOf.get(key);
    if (existing === undefined) edgeOf.set(key, edge);
    else edgeOf.set(key, mergeEdges(existing, edge));
  }
  const loopEdge = track.edges.find((e) => e.kind === 'loop') ?? null;

  return (
    <Card title={`阶段轨道 · 第 ${String(track.currentIteration)} 轮迭代`}>
      <div className="pentest-track" role="list">
        {track.nodes.map((node, index) => (
          <Fragment key={node.phase}>
            {index > 0 ? (
              <EdgeConnector
                edge={edgeOf.get(`${track.nodes[index - 1]!.phase}->${node.phase}`) ?? null}
                reached={node.visited}
              />
            ) : null}
            <PhaseNodeView
              node={node}
              noteMaxChars={noteMax}
              {...(props.onSelectPhase === undefined ? {} : { onSelect: props.onSelectPhase })}
              {...(props.now === undefined ? {} : { now: props.now })}
            />
          </Fragment>
        ))}
      </div>

      {loopEdge === null ? null : <LoopArc edge={loopEdge} />}
    </Card>
  );
}

/**
 * 合并同一对节点上的多条边。
 *
 * 例如「情报收集 → 威胁建模」既可能是普通推进（sequence），也可能由交接包
 * 证明（handoff）——它们是**不同的事实**，视觉上都要表达，因此合并成一条
 * 携带多个 kind 的边而不是丢掉一条。
 */
function mergeEdges(a: PhaseEdge, b: PhaseEdge): PhaseEdge {
  const kinds = [...new Set([a.kind, b.kind])];
  // sequence 优先级最低：有结构证据时，主视觉用结构边（那才是「被证明的关系」）
  const primary = kinds.find((k) => k !== 'sequence') ?? 'sequence';
  return {
    from: a.from,
    to: b.to,
    kind: primary,
    iterations: [...new Set([...a.iterations, ...b.iterations])].sort((x, y) => x - y),
    evidence: [...a.evidence, ...b.evidence],
  };
}

/** 节点之间的连接。`edge === null` 表示「没有证据画这条边」。 */
function EdgeConnector(props: { readonly edge: PhaseEdge | null; readonly reached: boolean }): ReactNode {
  const { edge } = props;
  if (edge === null) {
    // 没到过那一阶段：画一条**空心虚线**表示「路径存在但尚未走过」，
    // 而不是干脆不画——不画会让轨道看起来断了，而实际上只是还没到。
    return <div className="pentest-track__edge pentest-track__edge--pending" aria-hidden="true" />;
  }
  const label = EDGE_LABELS[edge.kind];
  return (
    <div
      className={toneClass('pentest-track__edge', edgeTone(edge.kind))}
      data-edge-kind={edge.kind}
      title={edge.evidence.length === 0 ? label : `${label} · 依据 ${String(edge.evidence.length)} 条会话关联`}
      aria-hidden="true"
    >
      <span className="pentest-track__edge-label">{label}</span>
    </div>
  );
}

const EDGE_LABELS: Readonly<Record<PhaseEdge['kind'], string>> = {
  sequence: '推进',
  handoff: '交接',
  retry: '重做',
  loop: '回环',
};

function edgeTone(kind: PhaseEdge['kind']): 'neutral' | 'active' | 'attention' | 'done' {
  switch (kind) {
    case 'sequence':
      // 序列边用中性色：它是时间顺序，不是被证明的因果
      return 'neutral';
    case 'handoff':
      return 'active';
    case 'retry':
      return 'attention';
    case 'loop':
      return 'done';
  }
}

/** 单个阶段节点。 */
function PhaseNodeView(props: {
  readonly node: PhaseNode;
  readonly noteMaxChars: number;
  readonly onSelect?: (phase: string) => void;
  readonly now?: Date;
}): ReactNode {
  const { node } = props;
  const tone = phaseTone(node);
  const redos = node.maxAttempt > 1 ? node.maxAttempt - 1 : 0;
  const interactive = props.onSelect !== undefined;

  return (
    <button
      type="button"
      role="listitem"
      className={toneClass('pentest-track__node', tone)}
      data-phase={node.phase}
      data-visited={node.visited}
      disabled={!interactive}
      onClick={interactive ? () => { props.onSelect?.(node.phase); } : undefined}
    >
      <span className="pentest-track__node-label">{node.label}</span>

      <span className="pentest-track__node-meta">
        <Badge text={`${formatCount(node.sessionCount)} 个会话`} tone={tone} />
        {redos === 0 ? null : <Badge text={`重做 ${String(redos)} 次`} tone="attention" />}
        {node.iterations.length <= 1 ? null : (
          <Badge text={`第 ${node.iterations.join('、')} 轮`} tone="neutral" hint="回环后同一阶段可能出现在多轮迭代" />
        )}
      </span>

      {node.latestNote === null ? null : (
        <span className="pentest-track__node-note" title={node.latestNote}>
          {truncate(node.latestNote, props.noteMaxChars)}
          {/* 派生便签必须标注：人类需要知道那不是 Agent 写的（§6.2.2） */}
          {node.latestNoteSource === 'derived' ? (
            <em className="pentest-track__node-note-source">自动摘要</em>
          ) : null}
          {node.latestNoteAt === null ? null : (
            <em className="pentest-track__node-note-time">
              {formatTimestamp(node.latestNoteAt, props.now)}
            </em>
          )}
        </span>
      )}

      {node.running ? <span className="pentest-track__node-live">工作中</span> : null}
    </button>
  );
}

/**
 * 回环弧线。
 *
 * 与序列边分开画：序列边表达「后渗透发生过」，弧线表达「循环回到了情报收集」。
 * 两者语义不同，合成一条会让人类看不出发生过回环——而回环意味着**攻击深度变了**，
 * 那是判断进展的关键信息（§5.5）。
 */
function LoopArc(props: { readonly edge: PhaseEdge }): ReactNode {
  return (
    <div
      className="pentest-track__loop"
      data-edge-kind="loop"
      title={`回环 ${String(props.edge.iterations.length)} 次 · 迭代 ${props.edge.iterations.join('、')}：范围已修订、新一轮开始`}
    >
      <span className="pentest-track__loop-label">
        回环 → 情报收集
        {props.edge.iterations.length === 0 ? null : ` · 第 ${props.edge.iterations.join('、')} 轮`}
      </span>
    </div>
  );
}
