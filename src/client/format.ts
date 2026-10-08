/**
 * 客户端展示格式化：把契约里的机器值转成人类可读的标签与文本。
 *
 * 设计依据：docs/dsh-pentest-plugin-design.md §6.2
 *
 * ── 为什么集中在这里 ──
 *
 * 阶段名、状态名、风险等级的中文标签会在多个视图里出现（轨道、时间轴、报告、
 * 放行队列）。散落各处会让「同一个状态在两个页面显示成不同词」成为必然，
 * 而那对人类判断是实打实的干扰——他会以为那是两件事。
 *
 * 因此所有标签只在这里定义一处；视图只调用 `phaseLabel()` 这类函数，
 * 不自己拼字符串。
 */

import type {
  MainStatus,
  Phase,
  RunMarker,
  SessionStatus,
  TrustLevel,
} from '../contracts.ts';
import { Fragment, createElement, type ReactNode } from 'react';

/** 五个阶段的中文名。键与契约的 `Phase` 对齐，缺项会在类型层暴露。 */
const PHASE_LABELS: Readonly<Record<Phase, string>> = {
  'intelligence-gathering': '情报收集',
  'threat-modeling': '威胁建模',
  'vulnerability-analysis': '漏洞分析',
  exploitation: '利用验证',
  'post-exploitation': '后渗透',
};

export function phaseLabel(phase: Phase): string {
  return PHASE_LABELS[phase];
}

/**
 * 主状态的中文名。
 *
 * 与阶段不同，主状态在界面上通常显示为「动作提示」而不是名词——例如
 * `waiting_human_review` 显示为「等待你判断」。因为这一屏的核心信息是
 * 「现在该谁动」，名词式状态需要人类多做一次转换。
 */
const MAIN_STATUS_LABELS: Readonly<Record<MainStatus, string>> = {
  auth_pending: '授权确认中',
  ready: '可以启动 Agent',
  worker_running: 'Agent 工作中',
  waiting_human_review: '等待你判断',
  handoff_drafting: '准备交接',
  transition_confirmation: '等待你确认交接',
  report_ready: '报告待签字',
  complete: '已完成',
};

export function mainStatusLabel(status: MainStatus): string {
  return MAIN_STATUS_LABELS[status];
}

/** 正交运行标记。 */
const RUN_MARKER_LABELS: Readonly<Record<RunMarker, string>> = {
  running: '运行中',
  paused: '已暂停',
  blocked: '已阻塞',
  aborted: '已终止',
  failed: '已失败',
};

export function runMarkerLabel(marker: RunMarker): string {
  return RUN_MARKER_LABELS[marker];
}

/**
 * 运行标记的语义色名（不是色值）。
 *
 * 回 `tone` 而不是 CSS 颜色：颜色由官方设计令牌决定（§6.2.3「不硬编码颜色」），
 * 这里只表达**语义**——哪些标记需要人类注意。
 */
export type Tone = 'neutral' | 'active' | 'attention' | 'danger' | 'done';

export function runMarkerTone(marker: RunMarker): Tone {
  switch (marker) {
    case 'running':
      return 'active';
    case 'paused':
      return 'neutral';
    case 'blocked':
      return 'attention';
    case 'aborted':
    case 'failed':
      return 'danger';
  }
}

export function sessionStatusTone(status: SessionStatus): Tone {
  switch (status) {
    case 'starting':
    case 'active':
      return 'active';
    case 'waiting_human':
    case 'handoff_drafting':
    case 'transition_confirmation':
      return 'attention';
    case 'paused':
      return 'neutral';
    case 'failed':
      return 'danger';
    case 'blocked':
      return 'attention';
    case 'closed':
    case 'superseded':
      return 'done';
  }
}

/**
 * 会话状态的中文名（`worker_sessions.status`，§9.2）。
 *
 * 与 engagement 级主状态是**两套枚举**（§5.1 的两层状态），不能借用 `mainStatusLabel`——
 * 那会把 `waiting_human` 显示成主状态的措辞。
 *
 * **单源**：此前时间轴（`timeline.ts`）与 AgentTrace 各写了一份私有表，措辞已经分叉
 * （`active`：'工作中' vs '运行中'；`blocked`：'阻塞' vs '已阻塞'……第六轮质检实测）。
 * 这里取与 `runMarkerLabel` 同一套 house style（存活态用「…中/准备…」，终态用「已…」）
 * 并以设计文档的用词为准（doc 里「运行中」出现 24 次、「工作中」0 次）。
 */
const SESSION_STATUS_LABELS: Readonly<Record<SessionStatus, string>> = {
  starting: '启动中',
  active: '运行中',
  waiting_human: '等待人工',
  handoff_drafting: '准备交接',
  transition_confirmation: '等待确认交接',
  paused: '已暂停',
  blocked: '已阻塞',
  failed: '已失败',
  closed: '已关闭',
  superseded: '已被取代',
};

export function sessionStatusLabel(status: SessionStatus): string {
  return SESSION_STATUS_LABELS[status];
}

/**
 * 任务报告状态的界面标签（`worker_reports.status`，列上只有 `report_ready` / `blocked` 两个取值）。
 *
 * 与 `sessionStatusLabel` 同一个道理：机器枚举不进界面。未知值回落原样，不隐藏。
 */
export function reportStatusLabel(status: string): string {
  const labels: Record<string, string> = {
    report_ready: '报告就绪',
    blocked: '已阻塞',
  };
  return labels[status] ?? status;
}

/**
 * 来源可信度的语义色。
 *
 * **它只表达证据等级，不表达相关性**（§8.6：`trust_level` 不参与排序评分，除人工决策与
 * 工具观测各加 1 个 RRF 单位的权威度加成外）。因此「外部不可信」用危险色表示「别当事实用」，
 * 而不是表示「排得靠后」。与 `trustLabel` 同处（原先在 `views/MemoryExplorer.tsx` 里自建）。
 */
export function trustTone(trust: TrustLevel): Tone {
  switch (trust) {
    case 'human_decision':
      return 'done';
    case 'tool_observation':
      return 'active';
    case 'model_reasoning':
      return 'attention';
    case 'agent_claim':
      return 'neutral';
    case 'external_untrusted':
      return 'danger';
  }
}

/**
 * 动作类别（风险分级）的显示名：**唯一出处**在 `policy/action-class-labels.ts`，
 * 这里是转出（控制台与提示词必须同名，见那边的说明）。本地不再抄一份。
 */
export { actionClassLabel, needsPerActionApproval } from '../policy/action-class-labels.ts';

/** 记忆来源可信度。 */
const TRUST_LABELS: Readonly<Record<TrustLevel, string>> = {
  human_decision: '人工决策',
  tool_observation: '工具观测',
  agent_claim: 'Agent 陈述',
  model_reasoning: '模型推理',
  external_untrusted: '外部不可信',
};

export function trustLabel(trust: TrustLevel): string {
  return TRUST_LABELS[trust];
}

/**
 * 时间戳的展示形式。
 *
 * 只显示到分钟：秒级精度在运维以外没有决策价值，而多出来的字符会挤占
 * 时间轴的横向空间。`now` 可注入以便测试稳定。
 */
export function formatTimestamp(value: string | null | undefined, now?: Date): string {
  if (value === null || value === undefined || value === '') return '—';
  const ts = Date.parse(value);
  if (!Number.isFinite(ts)) return '—';
  const at = new Date(ts);
  const base = `${String(at.getFullYear())}-${pad(at.getMonth() + 1)}-${pad(at.getDate())} ${pad(at.getHours())}:${pad(at.getMinutes())}`;
  const reference = now ?? new Date();
  const deltaMs = reference.getTime() - ts;
  // 一小时内的用相对时间：运维看的是「多久之前」，而不是具体时刻
  if (deltaMs >= 0 && deltaMs < 60 * 60 * 1000) return `${base} · ${relative(deltaMs)}前`;
  return base;
}

function relative(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${String(seconds)} 秒`;
  return `${String(Math.floor(seconds / 60))} 分钟`;
}

function pad(value: number): string {
  return String(value).padStart(2, '0');
}

/** 持续时长（秒 → 人类可读）。 */
export function formatDuration(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds) || seconds < 0) return '—';
  if (seconds < 60) return `${String(Math.floor(seconds))} 秒`;
  if (seconds < 3600) return `${String(Math.floor(seconds / 60))} 分钟`;
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  return minutes === 0 ? `${String(hours)} 小时` : `${String(hours)} 小时 ${String(minutes)} 分`;
}

/** 置信度（0..1 → 百分比）。`null` 显示为未评估，而不是 0%——两者的含义完全不同。 */
export function formatConfidence(confidence: number | null | undefined): string {
  if (confidence === null || confidence === undefined || !Number.isFinite(confidence)) return '未评估';
  const clamped = Math.min(Math.max(confidence, 0), 1);
  return `${String(Math.round(clamped * 100))}%`;
}

/**
 * 截断长文本用于列表展示。
 *
 * 用码点而不是 UTF-16 单元计数：中文与 emoji 的代理对会被切坏，产生乱码。
 */
export function truncate(text: string, maxChars: number): string {
  const points = [...text];
  if (points.length <= maxChars) return text;
  return `${points.slice(0, maxChars).join('')}…`;
}

/** 计数展示：`0` 显示为 `0`，`null` 显示为 `—`（未知与零不是一回事）。 */
export function formatCount(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  return String(value);
}

/**
 * 行内 Markdown → **React 节点**（`**粗体**`、`` `代码` ``、`*斜体*`）。
 *
 * 为什么要它：模型写的便签/摘要/结论天然带 Markdown 标记，而视图是**当纯文本插值**渲染的
 * ⇒ 界面上出现字面的 `**零目标动作**`（2026-10-07 人类反馈 + 截图）。产出侧改不动：
 * 同一段文本还要给模型与交接用（那里标记有用），且产出点很多——所以修在**渲染边界**。
 *
 * 三条硬约束：
 *  1. **返回节点，不拼 HTML 字符串** ⇒ 不用 `dangerouslySetInnerHTML`：模型产出的文本不可信；
 *  2. **只用原生 `strong`/`code`/`em`** ⇒ 零新样式类，不需要动样式表与 `verify:styles`；
 *  3. **只认行内语法**：块级（标题/列表/表格）原样显示——这些文本块本来就该是行内的，
 *     真出现块级标记说明内容放错了地方，原样显示反而是信号。
 */
export function renderInlineMarkdown(text: string): ReactNode {
  const parts: ReactNode[] = [];
  const pattern = INLINE_MARKDOWN;
  let last = 0;
  let key = 0;
  for (let match = pattern.exec(text); match !== null; match = pattern.exec(text)) {
    if (match.index > last) parts.push(text.slice(last, match.index));
    const [bold, code, italic] = [match[1], match[2], match[3]];
    if (bold !== undefined) parts.push(createElement('strong', { key: key++ }, bold));
    else if (code !== undefined) parts.push(createElement('code', { key: key++ }, code));
    else if (italic !== undefined) parts.push(createElement('em', { key: key++ }, italic));
    last = match.index + match[0].length;
  }
  if (parts.length === 0) return text;
  if (last < text.length) parts.push(text.slice(last));
  return createElement(Fragment, null, ...parts);
}

/**
 * 去掉行内标记，供**只能是纯文本**的地方：`title=` 提示、日志行、导出文件名。
 * **不要**拿它去洗给模型/交接的内容——那里标记是有用的。
 */
export function stripInlineMarkdown(text: string): string {
  return text.replace(INLINE_MARKDOWN, (_whole, bold, code, italic) => String(bold ?? code ?? italic ?? ''));
}

/**
 * 行内标记的**单源**模式串（渲染与 strip 共用一份，避免两边口径分叉）。
 *
 * 收紧的理由（2026-10-07 评审实测，都是**会改坏原文**的方向）：
 *  - 首版 `\*([^*]+)\*` 只看"两个星号之间没有星号"，于是 `2 * 3 * 4` 被吃成斜体、
 *    `rm -rf /tmp/* 与 /var/*` 的 glob 星号**凭空消失**（便签/影响评估恰恰最爱写命令与路径，
 *    而 strip 还用在 `title=` 与截断前测量上 ⇒ 人类读到的命令会被改写）；
 *  - 现在：内容不得跨行、不得以空白开头/结尾，定界符前后不得紧贴词字符或星号。
 * 已知残留：**紧贴引号/点号的 glob 对**（`"*.log" 与 "*.conf"`）仍会配对（CommonMark 亦如此）；
 * 遇到就把它当"命令文本不要用单星号斜体"的信号。
 */
const INLINE_MARKDOWN = /\*\*([^*\n]+)\*\*|`([^`\n]+)`|(?<![\w*])\*(?!\s)([^*\n]+?)(?<!\s)\*(?![\w*])/g;
