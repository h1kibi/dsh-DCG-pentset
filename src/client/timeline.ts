/**
 * 会话时间轴的纯逻辑：过滤、孤儿判定、迷你地图色块。
 *
 * 设计依据：docs/dsh-pentest-plugin-design.md §6.2、§15.2
 *
 * ── 为什么单独一个纯逻辑文件 ──
 *
 * 三条规则都是**关于判断的**，放在组件里就只能靠肉眼验证：
 *
 * 1. **孤儿会话必须可见**（§6.2 原话：「被中断、被取代、崩溃遗留或未正常收尾的
 *    会话，在时间轴上明确标注为未收尾，不隐藏、不静默清理」）。渗透测试可能留下
 *    未清理的现场，隐藏它们等于让人忘记去清理。
 * 2. **搜索要跨字段**（阶段、会话、便签、错误），而不是只匹配标题。
 * 3. **迷你地图按迭代分组**——长链 engagement 的第一屏答案。
 */

import type { Phase, SessionStatus, WorkerSessionSummary } from '../contracts.ts';
import { phaseLabel as sessionPhaseLabel, sessionStatusLabel, sessionStatusTone, type Tone } from './format.ts';

/**
 * 一个会话为什么被标为「需要留意」。
 *
 * 返回 `null` 表示它是正常终态或正在正常工作的会话。
 *
 * 判定基于**字段事实**，不是猜测：
 *   - 终态却 `endedAt` 为空 → 结束当时没记录下来，很可能是崩溃遗留；
 *   - `superseded` → 被重做/切换取代（正常流程，但人类需要知道）；
 *   - `failed` → 失败/中断（若同时无结束时间，原因归到「未收尾」）。
 */
interface OrphanInfo {
  readonly reason: string;
  /** 是否需要人类清理或确认（用于界面上的显式提醒）。 */
  readonly needsAttention: boolean;
}

export function orphanInfo(session: WorkerSessionSummary): OrphanInfo | null {
  const terminal = session.status === 'closed'
    || session.status === 'superseded'
    || session.status === 'failed';

  // 终态却没有结束时间：结束当时没记录，最可能是进程崩溃遗留
  if (terminal && session.endedAt === null) {
    return {
      reason: `未收尾：状态为 ${session.status} 但没有结束时间，可能是进程中断遗留`,
      needsAttention: true,
    };
  }

  if (session.status === 'superseded') {
    return { reason: '已被后续会话取代（重做或切换阶段）', needsAttention: false };
  }
  if (session.status === 'failed') {
    return { reason: '失败或已中断', needsAttention: false };
  }
  // 阻塞态：等人类处置，本身不是孤儿但需要留意
  if (session.status === 'blocked') {
    return { reason: '阻塞中：等待人类处置', needsAttention: true };
  }
  return null;
}

/** 时间轴的过滤条件（由搜索框与筛选器填充）。 */
export interface TimelineFilter {
  readonly text?: string;
  readonly phases?: readonly Phase[];
  readonly statuses?: readonly SessionStatus[];
  /** 只看需要留意的（孤儿 + 阻塞）。 */
  readonly onlyAttention?: boolean;
}

/**
 * 跨字段搜索。
 *
 * 匹配范围刻意放宽，因为人类在长链里找的往往是「那次说端口不通的会话」，
 * 而不是会话 id。三处刻意的设计：
 *
 * 1. **纳入展示标签**（中文阶段名、状态名）。存储的是英文 id（`exploitation`），
 *    而人类会输入「利用」——只匹配原始字段会让搜索形同虚设。这是实测发现的：
 *    一条搜索「利用」的用例在只匹配 `phase` 时返回 0 结果。
 * 2. **纳入便签**：列表扫描的主要线索（§6.2.2）。
 * 3. **纳入历史指针**：人类可能按「谁交接来的」找。
 */
function matchesFilter(session: WorkerSessionSummary, filter: TimelineFilter): boolean {
  if (filter.phases !== undefined && filter.phases.length > 0) {
    if (!filter.phases.includes(session.phase)) return false;
  }
  if (filter.statuses !== undefined && filter.statuses.length > 0) {
    if (!filter.statuses.includes(session.status)) return false;
  }
  if (filter.onlyAttention === true && orphanInfo(session) === null) return false;

  const text = filter.text?.trim().toLowerCase() ?? '';
  if (text === '') return true;
  const haystack = [
    session.id,
    session.dshSessionId,
    // 原始字段（英文 id）
    session.phase,
    session.status,
    // 展示标签（中文）——人类输入的是这个
    sessionPhaseLabel(session.phase),
    sessionStatusLabel(session.status),
    session.statusNote ?? '',
    String(session.attempt),
    String(session.iteration),
    session.previousAgentSessionId ?? '',
    session.retryOfSessionId ?? '',
  ].join(' ').toLowerCase();
  return haystack.includes(text);
}

/**
 * 会话状态的中文标签来自 `format.ts` 的**单源**（`sessionStatusLabel`）：
 * 会话级状态与 engagement 级主状态是两套枚举（§5.1），不能借用 `mainStatusLabel`。
 *
 * 它也是搜索的一部分：人类会输入「等待人工」，而存储的是英文 id（`waiting_human`），
 * 因此 haystack 需要两者都有。
 */

export function filterSessions(
  sessions: readonly WorkerSessionSummary[],
  filter: TimelineFilter,
): readonly WorkerSessionSummary[] {
  return sessions.filter((s) => matchesFilter(s, filter));
}

/** 迷你地图的一个色块。 */
interface MinimapBlock {
  readonly sessionId: string;
  readonly tone: Tone;
  readonly title: string;
  /** 该块属于哪个迭代（迷你地图按迭代分组显示）。 */
  readonly iteration: number;
  readonly phase: Phase;
}

/** 迷你地图分组：一个迭代一组。 */
interface MinimapGroup {
  readonly iteration: number;
  readonly blocks: readonly MinimapBlock[];
  /** 该迭代里是否至少有一个需要留意。 */
  readonly hasAttention: boolean;
}

/**
 * 构造迷你地图。
 *
 * 按迭代分组而不是平铺：长链 engagement 会有多轮迭代，平铺后人类看到的是一长串
 * 色块，而分组能立刻回答「一共跑了几轮、每轮几个会话」（§6.2 的「迭代间跳转」）。
 */
export function buildMinimap(sessions: readonly WorkerSessionSummary[]): readonly MinimapGroup[] {
  const byIteration = new Map<number, MinimapBlock[]>();
  for (const s of sessions) {
    const orphan = orphanInfo(s);
    const tone = orphan?.needsAttention === true ? 'attention' : sessionStatusTone(s.status);
    const block: MinimapBlock = {
      sessionId: s.id,
      tone,
      iteration: s.iteration,
      phase: s.phase,
      title: `${s.phase} · ${s.status}${s.statusNote === null ? '' : ` · ${s.statusNote}`}`,
    };
    const list = byIteration.get(s.iteration);
    if (list === undefined) byIteration.set(s.iteration, [block]);
    else list.push(block);
  }

  return [...byIteration.entries()]
    .sort(([a], [b]) => a - b)
    .map(([iteration, blocks]) => ({
      iteration,
      blocks,
      hasAttention: blocks.some((b) => b.tone === 'attention' || b.tone === 'danger'),
    }));
}

/** 时间轴的时钟轴刻度：按真实时间而不是序号（§6.2「按真实时钟时间标注」）。 */
interface TimeTick {
  readonly at: string;
  readonly label: string;
}

export function buildTimeTicks(
  sessions: readonly WorkerSessionSummary[],
  maxTicks = 6,
): readonly TimeTick[] {
  if (sessions.length === 0) return [];
  const times = sessions
    .map((s) => Date.parse(s.createdAt))
    .filter((t) => Number.isFinite(t))
    .sort((a, b) => a - b);
  if (times.length === 0) return [];

  const first = times[0]!;
  const last = times[times.length - 1]!;
  if (first === last) {
    return [{ at: new Date(first).toISOString(), label: clockLabel(first) }];
  }

  const count = Math.min(maxTicks, times.length);
  const step = (last - first) / (count - 1);
  const ticks: TimeTick[] = [];
  for (let i = 0; i < count; i += 1) {
    const at = Math.round(first + step * i);
    ticks.push({ at: new Date(at).toISOString(), label: clockLabel(at) });
  }
  return ticks;
}

function clockLabel(ms: number): string {
  const d = new Date(ms);
  return `${String(d.getMonth() + 1)}-${String(d.getDate())} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}
