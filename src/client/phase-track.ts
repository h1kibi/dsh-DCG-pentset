/**
 * 阶段轨道的聚合与边的推导（纯函数，不依赖 React）。
 *
 * 设计依据：docs/dsh-pentest-plugin-design.md §6.2、§5.3、§5.5
 *
 * ── 为什么单独一个纯逻辑文件 ──
 *
 * 轨道的两条关键规则都是**关于证据的**，而它们最容易写错、也最值得测：
 *
 * 1. **只画有证据的边**（§6.2 原话：「数据无法证明因果关系时只保留序列边，
 *    不发明箭头」）。序列边（时间顺序）总是画；结构边（交接血缘、重做、回环）
 *    只在字段真的证明关系时才画。
 * 2. **回环与回补不是一回事**（§5.4）：回环递增迭代（进入新一层网络），
 *    回补只在同一迭代内往回退。图上必须能区分——否则人类会以为攻击深度变了。
 *
 * 放在纯函数里，这两条才能被穷举测试；放在组件里就只能靠肉眼。
 */

import { PHASES } from '../contracts.ts';
import type { Phase, WorkerSessionSummary } from '../contracts.ts';

/** 一个阶段节点上要显示的信息。 */
export interface PhaseNode {
  readonly phase: Phase;
  readonly label: string;
  /** 该阶段的会话数（含被取代的历史会话）。 */
  readonly sessionCount: number;
  /** 当前存活会话的 id（若有）。 */
  readonly activeSessionId: string | null;
  /** 该阶段的最大执行次数（重做次数 = 它减一，若大于零）。 */
  readonly maxAttempt: number;
  /** 最新一条状态便签（§6.2.2）。 */
  readonly latestNote: string | null;
  readonly latestNoteSource: 'agent' | 'derived' | null;
  readonly latestNoteAt: string | null;
  /** 该阶段是否已经历过。 */
  readonly visited: boolean;
  /** 该阶段当前是否正在工作。 */
  readonly running: boolean;
  /** 出现在该阶段的所有迭代编号（回环后会有多个）。 */
  readonly iterations: readonly number[];
}

/** 边的种类。视觉上必须能区分——这是「只画有证据的边」的落点。 */
export type EdgeKind =
  /** 阶段推进的时间顺序。总是画。 */
  | 'sequence'
  /** 交接血缘：下一阶段的会话带 `previousAgentSessionId` 指向上一阶段的会话。 */
  | 'handoff'
  /** 同阶段重做：会话带 `retryOfSessionId`。 */
  | 'retry'
  /** 回环：从后渗透回到情报收集，且迭代递增。 */
  | 'loop';

export interface PhaseEdge {
  readonly from: Phase;
  readonly to: Phase;
  readonly kind: EdgeKind;
  /** 该边出现在哪些迭代（回环边会有多个）。 */
  readonly iterations: readonly number[];
  /** 结构边才有：支撑它的会话标识（供悬浮显示「依据是什么」）。 */
  readonly evidence: readonly string[];
}

/** 轨道整体。 */
export interface PhaseTrack {
  readonly nodes: readonly PhaseNode[];
  readonly edges: readonly PhaseEdge[];
  /** 迭代总数（至少 1）。 */
  readonly iterationCount: number;
  /** 当前迭代（最大迭代号）。 */
  readonly currentIteration: number;
}

/** 阶段的中文名。与 `format.ts` 的 `phaseLabel` 同源，这里内联以避免循环依赖。 */
const PHASE_LABELS: Readonly<Record<Phase, string>> = {
  'intelligence-gathering': '情报收集',
  'threat-modeling': '威胁建模',
  'vulnerability-analysis': '漏洞分析',
  exploitation: '利用验证',
  'post-exploitation': '后渗透',
};

/**
 * 由会话列表构建轨道。
 *
 * 输入是 `listWorkerSessions` 的结果（按 `createdAt` 升序），因此这里的聚合是
 * 确定性的、与渲染无关。
 */
export function buildPhaseTrack(sessions: readonly WorkerSessionSummary[]): PhaseTrack {
  const nodes: PhaseNode[] = PHASES.map((phase) => {
    const mine = sessions.filter((s) => s.phase === phase);
    const latest = latestNoteOf(mine);
    const active = mine.find((s) => isLive(s.status)) ?? null;
    const iterations = [...new Set(mine.map((s) => s.iteration))].sort((a, b) => a - b);
    return {
      phase,
      label: PHASE_LABELS[phase],
      sessionCount: mine.length,
      activeSessionId: active?.id ?? null,
      maxAttempt: mine.reduce((max, s) => Math.max(max, s.attempt), 0),
      latestNote: latest?.statusNote ?? null,
      latestNoteSource: latest?.statusNoteSource ?? null,
      latestNoteAt: latest?.statusNoteAt ?? null,
      visited: mine.length > 0,
      running: active !== null,
      iterations,
    };
  });

  const iterationCount = Math.max(1, ...sessions.map((s) => s.iteration));
  return {
    nodes,
    edges: buildEdges(sessions),
    iterationCount,
    currentIteration: iterationCount,
  };
}

/**
 * 推导边。
 *
 * 顺序有讲究：
 *   1. 序列边**总是**画——相邻阶段之间的推进是时间事实，不需要字段证明。
 *   2. 回环边**替代**最后一对相邻边（后渗透 → 情报收集），因为它表达的正是
 *      「循环回去了」；两者都画会让图上出现两套互相矛盾的箭头。
 *   3. 结构边（交接、重做）只在字段证明时追加。
 */
export function buildEdges(sessions: readonly WorkerSessionSummary[]): readonly PhaseEdge[] {
  const byPhase = new Map<Phase, WorkerSessionSummary[]>();
  for (const phase of PHASES) byPhase.set(phase, []);
  for (const s of sessions) byPhase.get(s.phase)?.push(s);

  const edges: PhaseEdge[] = [];

  // ── 序列边：相邻阶段的推进（时间顺序，总是画）──
  for (let i = 0; i < PHASES.length - 1; i += 1) {
    const from = PHASES[i]!;
    const to = PHASES[i + 1]!;
    if ((byPhase.get(to)?.length ?? 0) === 0) continue; // 没到过那一阶段就不画箭头
    edges.push({ from, to, kind: 'sequence', iterations: iterationsOf(byPhase.get(to)!), evidence: [] });
  }

  // ── 回环边：后渗透 → 情报收集，且情报收集出现在更大的迭代里 ──
  //
  // 判据不是「后渗透之后有时序更晚的情报收集会话」——那是**时间顺序**，回补也能
  // 满足。回环的判据是**迭代递增**：§5.4 明确 loop 递增 graph_iteration、
  // rollback 不递增。因此这里比较两者的迭代号。
  const intel = byPhase.get('intelligence-gathering') ?? [];
  const post = byPhase.get('post-exploitation') ?? [];
  const loopPairs = new Map<number, string[]>();
  for (const p of post) {
    for (const i of intel) {
      if (i.iteration > p.iteration) {
        const existing = loopPairs.get(i.iteration) ?? [];
        existing.push(`${p.id}->${i.id}`);
        loopPairs.set(i.iteration, existing);
      }
    }
  }
  if (loopPairs.size > 0) {
    edges.push({
      from: 'post-exploitation',
      to: 'intelligence-gathering',
      kind: 'loop',
      iterations: [...loopPairs.keys()].sort((a, b) => a - b),
      evidence: [...loopPairs.values()].flat(),
    });
    // 回环时移除「利用验证 → 后渗透」之后的序列边会把图割断，因此保留序列边，
    // 但界面对 loop 边用不同视觉（弧线），两者语义不冲突：序列边表达
    // 「后渗透发生过」，loop 边表达「循环回去了」。
  }

  // ── 交接边：会话带 previousAgentSessionId，且它指向**另一个阶段**的会话 ──
  const byId = new Map(sessions.map((s) => [s.id, s]));
  const handoffEvidence: string[] = [];
  const handoffPairs = new Set<string>();
  for (const s of sessions) {
    if (s.previousAgentSessionId === null) continue;
    const prev = byId.get(s.previousAgentSessionId);
    // 指针指向不在列表里的会话（被清理、或超出 limit）时**不画边**——
    // 没有对端就没有证据，这正是「不发明箭头」的含义。
    if (prev === undefined || prev.phase === s.phase) continue;
    handoffPairs.add(`${prev.phase}->${s.phase}`);
    handoffEvidence.push(`${prev.id}->${s.id}`);
  }
  for (const pair of handoffPairs) {
    const [from, to] = pair.split('->') as [Phase, Phase];
    edges.push({
      from,
      to,
      kind: 'handoff',
      iterations: uniqueIterations(sessions.filter((s) => s.phase === to)),
      evidence: handoffEvidence.filter((e) => {
        const src = byId.get(e.split('->')[0]!);
        return src?.phase === from;
      }),
    });
  }

  // ── 重做边：同阶段内 `retryOfSessionId` 非空（自环，供节点上显示重做次数）──
  const retryEvidence: string[] = [];
  for (const s of sessions) {
    if (s.retryOfSessionId === null || !byId.has(s.retryOfSessionId)) continue;
    retryEvidence.push(`${s.retryOfSessionId}->${s.id}`);
  }
  if (retryEvidence.length > 0) {
    for (const phase of PHASES) {
      const mine = retryEvidence.filter((e) => byId.get(e.split('->')[1]!)?.phase === phase);
      if (mine.length === 0) continue;
      edges.push({
        from: phase,
        to: phase,
        kind: 'retry',
        iterations: uniqueIterations(sessions.filter((s) => s.phase === phase)),
        evidence: mine,
      });
    }
  }

  return edges;
}

/** 存活态判断（与契约的 `LIVE_SESSION_STATUSES` 对齐）。 */
function isLive(status: WorkerSessionSummary['status']): boolean {
  return status === 'starting' || status === 'active' || status === 'waiting_human'
    || status === 'handoff_drafting' || status === 'transition_confirmation'
    || status === 'paused' || status === 'blocked';
}

/** 取最新一条**有内容**的便签。 */
function latestNoteOf(sessions: readonly WorkerSessionSummary[]): WorkerSessionSummary | null {
  let best: WorkerSessionSummary | null = null;
  for (const s of sessions) {
    if (s.statusNote === null || s.statusNote === '') continue;
    if (best === null || (s.statusNoteAt ?? s.createdAt) > (best.statusNoteAt ?? best.createdAt)) best = s;
  }
  return best;
}

function iterationsOf(sessions: readonly WorkerSessionSummary[]): readonly number[] {
  return uniqueIterations(sessions);
}

function uniqueIterations(sessions: readonly WorkerSessionSummary[]): readonly number[] {
  return [...new Set(sessions.map((s) => s.iteration))].sort((a, b) => a - b);
}

/**
 * 把一个阶段的状态归纳成 tone。
 *
 * 优先看**活动会话**：一个阶段可能有多个历史会话（重做、回补），但屏幕上
 * 只应该有一个状态——人类关心的是「这个阶段现在怎么了」。
 */
export function phaseTone(node: PhaseNode): 'neutral' | 'active' | 'attention' | 'danger' | 'done' {
  if (node.running) return 'active';
  if (node.sessionCount === 0) return 'neutral';
  return 'done';
}
