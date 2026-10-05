/**
 * 五阶段定义、合法转移图与两层状态（设计文档 §1.2、§1.3、§5.1–§5.3、§5.6）。
 *
 * 纯逻辑：不碰数据库、不创建会话、不调用模型。它回答三个问题：
 *   1. 阶段是什么（id、显示名、目标、交付物、退出条件）；
 *   2. 从当前阶段可以走到哪里（§5.3 推荐边 + 强制跳转）；
 *   3. 某个 `transition_type` 允许出现在哪条主状态边上（§5.2 边 ↔ §5.4 取值）。
 *
 * §5.2 的边与 §5.4 的取值是**多对一**：
 *   - 重做（retry）与插话唤醒（interject_wake）共用
 *     `WAITING_HUMAN_REVIEW → WORKER_RUNNING`；
 *   - 推进、回补与回环（advance / rollback / loop）共用
 *     `TRANSITION_CONFIRMATION → WORKER_RUNNING`——§5.2 末段：「阶段之间的推进与回环
 *     走同一套机制」；
 *   - 运行标记类取值（pause / resume / abort）不进图：§5.1 规定它们不改写主状态。
 *
 * 图上仍有三条边在 §5.4 的分派表里没有对应取值（授权确认、Agent 提交报告、结束技术测试
 * 的两条边）。它们不属于 Worker 转移：授权与范围界定、报告产出是 §1.3 明确的控制台职责。
 * 本模块**不静默**处理这一事实——`validateGraph()` 会把它们列进报告的 `unrecordedEdges`，
 * 每条边都带文档引用的理由，评审一眼能看见缺口。
 */

import { MAIN_STATUSES, PHASES, TRANSITION_TYPES } from '../contracts.ts';
import type { ErrorCode, MainStatus, Phase, RunMarker, TransitionType } from '../contracts.ts';

// ───────────────────────────── 阶段定义（§1.2） ─────────────────────────────

/** 阶段结束条件（§5.6）：Agent 报告什么、人类判断什么。 */
export interface PhaseExitCriteria {
  /** Agent 需要报告的内容（§5.6 左列）。 */
  readonly reports: readonly string[];
  /** 人类判断重点（§5.6 右列）。 */
  readonly humanJudgment: readonly string[];
}

export interface PhaseDefinition {
  readonly id: Phase;
  /** 阶段轨道序号，1..5（§6.2 阶段轨道）。 */
  readonly ordinal: number;
  /** 显示名（§1.2 阶段列）。 */
  readonly displayName: string;
  /** 轨道短名（§6.2：①情报 ─ ②威胁 ─ ③漏洞 ─ ④利用 ─ ⑤后渗透）。 */
  readonly shortName: string;
  /** 与该阶段严格 1:1 的 Agent 名（§1.2 Agent 列）。 */
  readonly agentName: string;
  /** 主要交付物（§1.2）。 */
  readonly deliverables: readonly string[];
  /** 阶段重点（§1.2）。 */
  readonly goal: string;
  /** 结束条件（§5.6）。 */
  readonly exit: PhaseExitCriteria;
}

export const PHASE_ORDER: readonly Phase[] = PHASES;

export const PHASE_DEFINITIONS: Readonly<Record<Phase, PhaseDefinition>> = {
  'intelligence-gathering': {
    id: 'intelligence-gathering',
    ordinal: 1,
    displayName: '情报收集',
    shortName: '情报',
    agentName: '情报收集 Agent',
    deliverables: ['资产', '服务', '入口', '技术指纹', '来源证据'],
    goal: '被动与受控主动情报收集',
    exit: {
      reports: ['资产', '服务', '入口', '来源', '覆盖范围', '工具限制', '未决线索'],
      humanJudgment: ['覆盖是否足够', '进入威胁建模还是继续补情报'],
    },
  },
  'threat-modeling': {
    id: 'threat-modeling',
    ordinal: 2,
    displayName: '威胁建模',
    shortName: '威胁',
    agentName: '威胁建模 Agent',
    deliverables: ['资产图', '信任边界', '攻击路径', '假设与优先级'],
    goal: '建立攻击面与业务影响模型',
    exit: {
      reports: ['资产图', '信任边界', '攻击路径', '业务影响', '假设与优先级'],
      humanJudgment: ['是否存在可测试路径', '是否需要补充情报'],
    },
  },
  'vulnerability-analysis': {
    id: 'vulnerability-analysis',
    ordinal: 3,
    displayName: '漏洞分析',
    shortName: '漏洞',
    agentName: '漏洞分析 Agent',
    deliverables: ['候选漏洞', '去重结果', '评级', '验证计划'],
    goal: '分析与候选发现',
    exit: {
      reports: ['候选漏洞', '受影响资产', '评级', '证据', '去重结果', '验证计划'],
      humanJudgment: ['哪些候选值得验证', '是否进入利用验证'],
    },
  },
  'exploitation': {
    id: 'exploitation',
    ordinal: 4,
    displayName: '利用验证',
    shortName: '利用',
    agentName: '利用验证 Agent',
    deliverables: ['最小化验证结果', '复现证据', '影响边界'],
    goal: '在人工放行下验证可利用性',
    exit: {
      reports: ['每次放行的动作', '目标', '复现结果', '影响', '原始证据', '清理记录'],
      humanJudgment: ['是否接受结果', '是否补验证', '是否进入后渗透'],
    },
  },
  'post-exploitation': {
    id: 'post-exploitation',
    ordinal: 5,
    displayName: '后渗透',
    shortName: '后渗透',
    agentName: '后渗透 Agent',
    deliverables: ['影响核查', '内部可见面清单', '清理记录', '回环建议'],
    goal: '作为回环网关，交接给下一轮',
    exit: {
      reports: [
        '已获得访问权的影响边界',
        '内部可见资产清单（含发现来源）',
        '清理核查',
        '残留与未覆盖项',
        '回环或结束的建议',
      ],
      humanJudgment: ['是否开启新一轮迭代（需先完成范围修订）', '是否结束技术测试'],
    },
  },
};

// ───────────────────────────── 合法转移图（§5.3） ─────────────────────────────

/** 阶段间移动的语义类别：与 §5.4 的进度类取值同构。 */
export type PhaseMoveKind = 'retry' | 'advance' | 'rollback' | 'loop';

export interface RecommendedMove {
  /** null = 「结束技术测试」：不产生新阶段，进入控制台报告产出（§1.3、§13.8）。 */
  readonly toPhase: Phase | null;
  readonly kind: PhaseMoveKind | 'end_testing';
  /** 「结束技术测试」没有 `transition_type`：见 `STATE_EDGES` 中对应边的理由。 */
  readonly transitionType: TransitionType | null;
  /** 控制台高亮用的括注（§5.3 推荐表原文）。 */
  readonly label: string;
}

/**
 * §5.3 推荐边表。控制台默认高亮这些项，跨出此表必须走强制跳转（§5.3）。
 * 回补与回环的区分是同一迭代内的向后调整与开启新一层迭代：只有 loop 递增迭代与范围版本。
 */
export const RECOMMENDED_MOVES: Readonly<Record<Phase, readonly RecommendedMove[]>> = {
  'intelligence-gathering': [
    { toPhase: 'intelligence-gathering', kind: 'retry', transitionType: 'retry', label: '重做' },
    { toPhase: 'threat-modeling', kind: 'advance', transitionType: 'advance', label: '进入威胁建模' },
  ],
  'threat-modeling': [
    { toPhase: 'intelligence-gathering', kind: 'rollback', transitionType: 'rollback', label: '回补情报' },
    { toPhase: 'threat-modeling', kind: 'retry', transitionType: 'retry', label: '重做' },
    { toPhase: 'vulnerability-analysis', kind: 'advance', transitionType: 'advance', label: '进入漏洞分析' },
  ],
  'vulnerability-analysis': [
    { toPhase: 'threat-modeling', kind: 'rollback', transitionType: 'rollback', label: '回补威胁建模' },
    { toPhase: 'vulnerability-analysis', kind: 'retry', transitionType: 'retry', label: '重做' },
    { toPhase: 'exploitation', kind: 'advance', transitionType: 'advance', label: '进入利用验证' },
    {
      toPhase: 'post-exploitation',
      kind: 'advance',
      transitionType: 'advance',
      label: '确认无需验证时进入后渗透',
    },
  ],
  'exploitation': [
    {
      toPhase: 'vulnerability-analysis',
      kind: 'rollback',
      transitionType: 'rollback',
      label: '发现新线索时回补漏洞分析',
    },
    { toPhase: 'exploitation', kind: 'retry', transitionType: 'retry', label: '重做' },
    { toPhase: 'post-exploitation', kind: 'advance', transitionType: 'advance', label: '进入后渗透' },
  ],
  'post-exploitation': [
    {
      toPhase: 'intelligence-gathering',
      kind: 'loop',
      transitionType: 'loop',
      label: '回环进入新一轮',
    },
    { toPhase: 'vulnerability-analysis', kind: 'rollback', transitionType: 'rollback', label: '回补漏洞分析' },
    { toPhase: 'exploitation', kind: 'rollback', transitionType: 'rollback', label: '补验证' },
    { toPhase: 'post-exploitation', kind: 'retry', transitionType: 'retry', label: '重做' },
    { toPhase: null, kind: 'end_testing', transitionType: null, label: '结束技术测试' },
  ],
};

export function isRecommendedMove(from: Phase, to: Phase): boolean {
  return RECOMMENDED_MOVES[from].some((move) => move.toPhase === to);
}

/**
 * 阶段间移动的类别。判定顺序有实质作用：`后渗透 → 情报收集` 的序号是下降的，
 * 但它改变攻击深度（新一层网络），因此必须先判回环，再判回补。
 * 返回值就是 §5.4 分派表里的进度类 `transition_type`（start 只用于首个会话）。
 */
export function moveKindFor(from: Phase, to: Phase): PhaseMoveKind {
  if (from === to) return 'retry';
  if (from === 'post-exploitation' && to === 'intelligence-gathering') return 'loop';
  return PHASE_DEFINITIONS[to].ordinal < PHASE_DEFINITIONS[from].ordinal ? 'rollback' : 'advance';
}

/** 前向跳级时被越过的阶段；回补、回环与重做不产生被跳过的阶段。 */
export function skippedPhasesBetween(from: Phase, to: Phase): readonly Phase[] {
  const fromOrdinal = PHASE_DEFINITIONS[from].ordinal;
  const toOrdinal = PHASE_DEFINITIONS[to].ordinal;
  if (toOrdinal <= fromOrdinal + 1) return [];
  return PHASE_ORDER.filter((phase) => {
    const ordinal = PHASE_DEFINITIONS[phase].ordinal;
    return ordinal > fromOrdinal && ordinal < toOrdinal;
  });
}

// ───────────────────────────── 阶段移动计划（§5.3 + §5.4） ─────────────────────────────

/** 回环前置：范围修订的完成状态（§5.4 步骤 4、§13.7）。 */
export interface ScopeAmendmentState {
  readonly completed: boolean;
  /** 新范围版本号；未生成时为 null。 */
  readonly newVersion: number | null;
}

export interface MissingEvidence {
  readonly phase: Phase;
  /** 被跳过阶段本应产出的交付物（§1.2）——也就是强制跳转后缺失的证据基础。 */
  readonly deliverables: readonly string[];
}

export interface PhaseMoveRequest {
  readonly from: Phase;
  readonly to: Phase;
  /** 在弹窗中显式选择强制跳转，而不是误点默认项（§5.3 条件 1）。 */
  readonly forced?: boolean;
  /** 强制跳转理由，必须非空并写入决策记录（§5.3 条件 2）。 */
  readonly reason?: string;
  /** 二次确认已完成（§5.3 条件 3：被跳过的阶段、缺失的证据、仍生效的范围限制）。 */
  readonly doubleConfirmed?: boolean;
  /** 回环时必填：范围修订是否已完成并生成新版本。 */
  readonly scopeAmendment?: ScopeAmendmentState;
}

export interface PhaseMovePlan {
  readonly from: Phase;
  readonly to: Phase;
  readonly transitionType: TransitionType;
  readonly forced: boolean;
  readonly reason: string | null;
  readonly skippedPhases: readonly Phase[];
  readonly missingEvidence: readonly MissingEvidence[];
  /** 后渗透 → 情报收集：回环的硬性前置是完成范围修订（§5.5、§13.7）。 */
  readonly requiresScopeAmendment: boolean;
  /** 回环携带的新范围版本号；其它移动为 null（范围版本不变）。 */
  readonly scopeVersion: number | null;
}

export type PhaseMoveOutcome =
  | { readonly ok: true; readonly plan: PhaseMovePlan }
  | { readonly ok: false; readonly code: ErrorCode; readonly message: string };

/**
 * 校验一次阶段移动并产出计划。拒绝路径返回契约里的稳定错误码：
 *   - `scope_amendment_required`：回环未完成范围修订；
 *   - `forced_reason_required`：跨出推荐路径但缺显式强制标记、理由或二次确认；
 *   - `handoff_transition_illegal`：对推荐边错误地标记强制（§5.3 的强制入口只对
 *     「跨出推荐路径」开放，误标会污染时间线、报告与审计导出）。
 */
export function planPhaseMove(request: PhaseMoveRequest): PhaseMoveOutcome {
  const { from, to } = request;
  const requiresScopeAmendment = from === 'post-exploitation' && to === 'intelligence-gathering';

  if (requiresScopeAmendment) {
    const amendment = request.scopeAmendment;
    if (amendment === undefined || !amendment.completed || amendment.newVersion === null) {
      return {
        ok: false,
        code: 'scope_amendment_required',
        message: '回环到情报收集前必须完成范围修订并生成新的范围版本（§5.4 步骤 4、§13.7）',
      };
    }
  }

  const recommended = isRecommendedMove(from, to);
  const forced = request.forced === true;

  if (!recommended) {
    if (!forced) {
      return {
        ok: false,
        code: 'forced_reason_required',
        message: `${from} → ${to} 不在推荐路径内，必须在弹窗中显式选择强制跳转（§5.3 条件 1）`,
      };
    }
    if ((request.reason ?? '').trim().length === 0) {
      return {
        ok: false,
        code: 'forced_reason_required',
        message: '强制跳转必须填写非空理由并写入决策记录（§5.3 条件 2）',
      };
    }
    if (request.doubleConfirmed !== true) {
      return {
        ok: false,
        code: 'forced_reason_required',
        message: '强制跳转必须二次确认被跳过的阶段、缺失的证据基础与仍生效的范围限制（§5.3 条件 3）',
      };
    }
  } else if (forced) {
    return {
      ok: false,
      code: 'handoff_transition_illegal',
      message: `${from} → ${to} 是推荐边，不应标记为强制跳转（§5.3）`,
    };
  }

  const skipped = skippedPhasesBetween(from, to);
  return {
    ok: true,
    plan: {
      from,
      to,
      transitionType: moveKindFor(from, to),
      forced,
      reason: forced ? (request.reason ?? '').trim() : null,
      skippedPhases: skipped,
      missingEvidence: skipped.map((phase) => ({
        phase,
        deliverables: PHASE_DEFINITIONS[phase].deliverables,
      })),
      requiresScopeAmendment,
      scopeVersion: requiresScopeAmendment ? (request.scopeAmendment?.newVersion ?? null) : null,
    },
  };
}

// ───────────────────────────── 主状态图（§5.2） ─────────────────────────────

/** 边由谁触发：人类操作（走 §5.4 转移事务）或 Agent 侧动作。 */
export type EdgeCause = 'human' | 'agent';

export interface StateEdge {
  readonly from: MainStatus;
  readonly to: MainStatus;
  /** §5.2 图上的边标签。 */
  readonly label: string;
  readonly cause: EdgeCause;
  /** §5.4 分派表为该边指定的取值；空数组表示文档未指定（见 `note`）。 */
  readonly transitionTypes: readonly TransitionType[];
  /** true：该边的状态变化写 `state_transitions`；false：由 `note` 说明它记在哪里。 */
  readonly recorded: boolean;
  /** 设计文档是否直接指定了取值；false = 本实现按 §5.2/§5.4 补全，需评审确认。 */
  readonly designAssigned: boolean;
  /** 未记账边的理由（必须非空）；补全边也在此说明依据。 */
  readonly note: string;
}

const CONSOLE_REPORTING_NOTE =
  '§13.8：写报告草稿与领域事件 report.draft.generated；§1.3 把「报告产出」划归控制台（不设 Agent）。' +
  '§5.4 的分派表未给该边取值，且 TRANSITION_TYPES 里 complete 已被 REPORT_READY → COMPLETE（签字导出）占用。';

/**
 * §5.2 状态图的全部边。
 *
 * 记账规则来自 §5.4：「四条人工边必须可记账」，因为它们是人类操作引起的真实状态变化，
 * 且该表为它们各自指定了取值，避免实现者把它们塞进语义不符的既有值。
 * 图上剩余的边分两类：
 *   - 补全边（`designAssigned: false` 且 `recorded: true`）：取值按同一操作家族沿用，
 *     使状态变化不至于无记账；
 *   - 未记账边（`recorded: false`）：不在 Worker 转移事务内的控制台/Agent 侧步骤。
 */
export const STATE_EDGES: readonly StateEdge[] = [
  {
    from: 'auth_pending',
    to: 'ready',
    label: '人类确认授权与范围',
    cause: 'human',
    transitionTypes: [],
    recorded: false,
    designAssigned: false,
    note:
      '§13.1：确认授权写范围/规则/策略快照与 human_decisions，此时尚无 Worker 会话；' +
      '§1.3 把「授权与范围界定」划归控制台。§5.4 分派表未给该边取值，' +
      'TRANSITION_TYPES 中也没有语义相符的值。',
  },
  {
    from: 'ready',
    to: 'worker_running',
    label: '启动首个阶段 Agent',
    cause: 'human',
    transitionTypes: ['start'],
    recorded: true,
    designAssigned: true,
    note: '§5.4「首个会话启动」。',
  },
  {
    from: 'worker_running',
    to: 'waiting_human_review',
    label: 'Agent 提交报告',
    cause: 'agent',
    transitionTypes: [],
    recorded: false,
    designAssigned: false,
    note:
      '§13.4：Agent 侧事务保存报告与引用、把会话标记为等待人工，并写领域事件 worker.report / ' +
      'worker.waiting_human；§5.4 只规范人类操作，TRANSITION_TYPES 中没有「提交报告」。',
  },
  {
    from: 'waiting_human_review',
    to: 'worker_running',
    label: '重做（默认复用当前会话）/ 插话唤醒',
    cause: 'human',
    transitionTypes: ['retry', 'interject_wake'],
    recorded: true,
    designAssigned: true,
    note: '§5.4「重做（复用会话 / 新建会话）」与 §6.7「插话唤醒」。',
  },
  {
    from: 'waiting_human_review',
    to: 'handoff_drafting',
    label: '切换阶段，请求交接草稿',
    cause: 'human',
    transitionTypes: ['handoff_regen'],
    recorded: true,
    designAssigned: false,
    note:
      '【补全】§5.4 只为 TRANSITION_CONFIRMATION → HANDOFF_DRAFTING 指定了 handoff_regen；' +
      '首次请求草稿与「要求重新生成」是同一操作（向当前会话请求草稿、不产生交接记录），沿用该取值。',
  },
  {
    from: 'handoff_drafting',
    to: 'transition_confirmation',
    label: '草稿生成',
    cause: 'agent',
    transitionTypes: [],
    recorded: false,
    designAssigned: false,
    note:
      'Agent 侧续跑的结果（§16.1：requestHandoffDraft 不创建会话、不授予任何状态或工具权限）；' +
      '记 worker_sessions.status 与领域事件 handoff.draft.generated。',
  },
  {
    from: 'handoff_drafting',
    to: 'waiting_human_review',
    label: '草稿失败或人类取消',
    cause: 'human',
    transitionTypes: ['handoff_cancel'],
    recorded: true,
    designAssigned: true,
    note: '§5.4 四条人工边之一（§15.6：草稿失败保持等待人工判断，不自动切换）。',
  },
  {
    from: 'transition_confirmation',
    to: 'worker_running',
    label: '人类确认，创建目标阶段新会话',
    cause: 'human',
    transitionTypes: ['advance', 'rollback', 'loop'],
    recorded: true,
    designAssigned: true,
    note: '§5.2 末段：阶段之间的推进与回环走同一套机制，故 advance / rollback / loop 共用此边。',
  },
  {
    from: 'transition_confirmation',
    to: 'handoff_drafting',
    label: '要求重新生成',
    cause: 'human',
    transitionTypes: ['handoff_regen'],
    recorded: true,
    designAssigned: true,
    note: '§5.4 四条人工边之一。',
  },
  {
    from: 'transition_confirmation',
    to: 'waiting_human_review',
    label: '人类取消切换',
    cause: 'human',
    transitionTypes: ['handoff_cancel'],
    recorded: true,
    designAssigned: true,
    note: '§5.4 四条人工边之一；取消不创建会话（§13.6）。',
  },
  {
    from: 'worker_running',
    to: 'report_ready',
    label: '人类结束技术测试',
    cause: 'human',
    transitionTypes: [],
    recorded: false,
    designAssigned: false,
    note: CONSOLE_REPORTING_NOTE,
  },
  {
    from: 'waiting_human_review',
    to: 'report_ready',
    label: '人类结束技术测试',
    cause: 'human',
    transitionTypes: [],
    recorded: false,
    designAssigned: false,
    note: CONSOLE_REPORTING_NOTE,
  },
  {
    from: 'report_ready',
    to: 'worker_running',
    label: '人类要求补充技术动作',
    cause: 'human',
    transitionTypes: ['report_reopen'],
    recorded: true,
    designAssigned: true,
    note: '§5.4 四条人工边之一（避免用 resume 表示从报告回到运行）。',
  },
  {
    from: 'report_ready',
    to: 'complete',
    label: '审阅、签字与导出',
    cause: 'human',
    transitionTypes: ['complete'],
    recorded: true,
    designAssigned: true,
    note: '§5.4「完成」；REPORT_READY → COMPLETE 是状态机的终态边。',
  },
];

/** §5.4：只改运行标记、不改写主状态的取值，因此没有状态边（§5.1）。 */
export const RUNTIME_MARKER_TRANSITION_TYPES: readonly TransitionType[] = ['pause', 'resume', 'abort'];

/** §5.4 点名的四条人工边及各自必须映射到的取值。 */
export const REQUIRED_ACCOUNTED_EDGES = [
  {
    from: 'handoff_drafting',
    to: 'waiting_human_review',
    transitionType: 'handoff_cancel',
    label: '草稿失败或取消',
  },
  {
    from: 'transition_confirmation',
    to: 'handoff_drafting',
    transitionType: 'handoff_regen',
    label: '要求重新生成',
  },
  {
    from: 'transition_confirmation',
    to: 'waiting_human_review',
    transitionType: 'handoff_cancel',
    label: '取消切换',
  },
  {
    from: 'report_ready',
    to: 'worker_running',
    transitionType: 'report_reopen',
    label: '要求补充技术动作',
  },
] as const satisfies readonly {
  readonly from: MainStatus;
  readonly to: MainStatus;
  readonly transitionType: TransitionType;
  readonly label: string;
}[];

export interface StatusEdgeRef {
  readonly from: MainStatus;
  readonly to: MainStatus;
}

/**
 * 某个 `transition_type` 允许出现的主状态边。多对一是常态，见文件头注释。
 * pause / resume / abort 返回空数组：它们只改运行标记（§5.1）。
 */
export function statusEdgesFor(
  type: TransitionType,
  edges: readonly StateEdge[] = STATE_EDGES,
): readonly StatusEdgeRef[] {
  return edges
    .filter((edge) => edge.transitionTypes.includes(type))
    .map((edge) => ({ from: edge.from, to: edge.to }));
}

export function isLegalStatusEdge(
  type: TransitionType,
  from: MainStatus,
  to: MainStatus,
  edges: readonly StateEdge[] = STATE_EDGES,
): boolean {
  return edges.some((edge) => edge.from === from && edge.to === to && edge.transitionTypes.includes(type));
}

/** 给定主状态边上允许的取值（控制台据此决定呈现哪些操作）。 */
export function legalTransitionTypes(
  from: MainStatus,
  to: MainStatus,
  edges: readonly StateEdge[] = STATE_EDGES,
): readonly TransitionType[] {
  return edges
    .filter((edge) => edge.from === from && edge.to === to)
    .flatMap((edge) => edge.transitionTypes);
}

// ───────────────────────────── 状态可达性校验（§5.2 边 ↔ §5.4 取值） ─────────────────────────────

export type GraphProblemKind =
  | 'unknown_main_status'
  | 'unknown_transition_type'
  | 'duplicate_edge'
  | 'recorded_edge_without_type'
  | 'unrecorded_edge_without_note'
  | 'missing_required_edge'
  | 'unreachable_status'
  | 'unexpected_type_without_edge';

export interface GraphProblem {
  readonly kind: GraphProblemKind;
  readonly from: MainStatus | null;
  readonly to: MainStatus | null;
  readonly detail: string;
}

export interface GraphReport {
  readonly edgeCount: number;
  readonly recordedEdgeCount: number;
  /** §5.4 未指定取值、因此不写 `state_transitions` 的边：列出而不是静默。 */
  readonly unrecordedEdges: readonly StateEdge[];
  /** 文档未指定取值、由本实现补全的边：需评审确认。 */
  readonly derivedEdges: readonly StateEdge[];
  /** 图上出现过的取值。 */
  readonly coveredTypes: readonly TransitionType[];
  /** 图上没有状态边的取值；预期恰为 pause / resume / abort（§5.1 运行标记）。 */
  readonly typesWithoutEdge: readonly TransitionType[];
}

export type GraphValidation =
  | { readonly ok: true; readonly report: GraphReport }
  | { readonly ok: false; readonly code: ErrorCode; readonly problems: readonly GraphProblem[] };

/**
 * 断言状态图的每条边都有记账（§18.1「§5.2 的每一条边都有对应的 transition_type，无遗漏」）：
 *   - 已记账的边必须持有 TRANSITION_TYPES 内的取值；
 *   - 未记账的边必须给出书面理由，不接受静默跳过；
 *   - §5.4 点名的四条人工边必须存在且映射到指定取值；
 *   - 八个主状态都必须从 AUTH_PENDING 可达；
 *   - 除 pause / resume / abort 外，每个取值都必须至少有一条状态边。
 *
 * 校验失败返回 `handoff_transition_illegal`，具体原因逐条放在 `problems` 里（kind 区分）。
 * 该函数是启动自检的一部分：图被改坏时插件应当拒绝启动，而不是带着缺口的账本上线。
 */
export function validateGraph(edges: readonly StateEdge[] = STATE_EDGES): GraphValidation {
  const problems: GraphProblem[] = [];

  const seen = new Set<string>();
  for (const edge of edges) {
    if (
      !(MAIN_STATUSES as readonly string[]).includes(edge.from) ||
      !(MAIN_STATUSES as readonly string[]).includes(edge.to)
    ) {
      problems.push({
        kind: 'unknown_main_status',
        from: edge.from,
        to: edge.to,
        detail: `状态不在 MAIN_STATUSES 内：${String(edge.from)} → ${String(edge.to)}`,
      });
    }
    const key = `${edge.from}→${edge.to}`;
    if (seen.has(key)) {
      problems.push({
        kind: 'duplicate_edge',
        from: edge.from,
        to: edge.to,
        detail: `重复的边：${key}`,
      });
    }
    seen.add(key);

    for (const type of edge.transitionTypes) {
      if (!(TRANSITION_TYPES as readonly string[]).includes(type)) {
        problems.push({
          kind: 'unknown_transition_type',
          from: edge.from,
          to: edge.to,
          detail: `${key} 使用了 TRANSITION_TYPES 之外的取值：${String(type)}`,
        });
      }
    }
    if (edge.recorded && edge.transitionTypes.length === 0) {
      problems.push({
        kind: 'recorded_edge_without_type',
        from: edge.from,
        to: edge.to,
        detail: `${key} 标为已记账，却没有 transition_type`,
      });
    }
    if (!edge.recorded && edge.note.trim().length === 0) {
      problems.push({
        kind: 'unrecorded_edge_without_note',
        from: edge.from,
        to: edge.to,
        detail: `${key} 未记账且没有给出理由——不接受静默`,
      });
    }
  }

  for (const required of REQUIRED_ACCOUNTED_EDGES) {
    const edge = edges.find((candidate) => candidate.from === required.from && candidate.to === required.to);
    if (edge === undefined || !edge.transitionTypes.includes(required.transitionType)) {
      problems.push({
        kind: 'missing_required_edge',
        from: required.from,
        to: required.to,
        detail: `§5.4 点名的人工边「${required.label}」必须映射到 ${required.transitionType}`,
      });
    }
  }

  const reachable = reachableStatuses(edges);
  for (const status of MAIN_STATUSES) {
    if (!reachable.has(status)) {
      problems.push({
        kind: 'unreachable_status',
        from: null,
        to: status,
        detail: `主状态 ${status} 从 auth_pending 不可达`,
      });
    }
  }

  const typesWithEdge = new Set<string>();
  for (const edge of edges) for (const type of edge.transitionTypes) typesWithEdge.add(type);
  const typesWithoutEdge = TRANSITION_TYPES.filter((type) => !typesWithEdge.has(type));
  for (const type of typesWithoutEdge) {
    if (!RUNTIME_MARKER_TRANSITION_TYPES.includes(type)) {
      problems.push({
        kind: 'unexpected_type_without_edge',
        from: null,
        to: null,
        detail: `${type} 既没有状态边，也不属于运行标记类取值（pause / resume / abort）`,
      });
    }
  }

  if (problems.length > 0) {
    return { ok: false, code: 'handoff_transition_illegal', problems };
  }

  return {
    ok: true,
    report: {
      edgeCount: edges.length,
      recordedEdgeCount: edges.filter((edge) => edge.recorded).length,
      unrecordedEdges: edges.filter((edge) => !edge.recorded),
      derivedEdges: edges.filter((edge) => edge.recorded && !edge.designAssigned),
      coveredTypes: TRANSITION_TYPES.filter((type) => typesWithEdge.has(type)),
      typesWithoutEdge,
    },
  };
}

function reachableStatuses(edges: readonly StateEdge[]): ReadonlySet<MainStatus> {
  const reachable = new Set<MainStatus>(['auth_pending']);
  let grew = true;
  while (grew) {
    grew = false;
    for (const edge of edges) {
      if (reachable.has(edge.from) && !reachable.has(edge.to)) {
        reachable.add(edge.to);
        grew = true;
      }
    }
  }
  return reachable;
}

/** 校验失败（图被改坏）时抛出：这是启动自检，不是工具可见的拒绝路径。 */
export class WorkflowGraphError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WorkflowGraphError';
  }
}

export function assertGraph(edges: readonly StateEdge[] = STATE_EDGES): GraphReport {
  const validation = validateGraph(edges);
  if (!validation.ok) {
    throw new WorkflowGraphError(
      `状态图校验失败（${validation.problems.length} 项）：${validation.problems.map((p) => p.detail).join('；')}`,
    );
  }
  return validation.report;
}

// ───────────────────────────── 两层状态（§5.1） ─────────────────────────────

/** 主状态与运行标记并存的最小结构；`WorkflowSnapshot` 结构上满足它。 */
export interface TwoLayerState {
  readonly mainStatus: MainStatus;
  readonly runMarker: RunMarker;
}

/** 恢复后运行标记回到 running；主状态从未改变。 */
export const RUNNING_MARKER: RunMarker = 'running';

/**
 * 写运行标记。§5.1：`status` 只在暂停、恢复、阻塞、终止、失败时改写，
 * 且**不改写主状态**——暂停不覆盖主状态，恢复时回到暂停前的位置因此是数据结构的直接结果，
 * 而不是需要推断的规则。本函数不触碰 `stateVersion`：状态的推进由转移事务负责（§5.4 步骤 7），
 * 运行标记本身不是一次转移。
 */
export function applyRunMarker<T extends TwoLayerState>(current: T, marker: RunMarker): T {
  return { ...current, runMarker: marker };
}

/** 从暂停/阻塞恢复：把运行标记置回 `running`，主状态与阶段保持原值。 */
export function clearRunMarker<T extends TwoLayerState>(current: T): T {
  return applyRunMarker(current, RUNNING_MARKER);
}
