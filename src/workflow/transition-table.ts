/**
 * 转移分派表（设计文档 §5.4）。
 *
 * 这张表是「哪个操作产生哪种转移、以及它改哪些计数器」的唯一权威。它逐行对应
 * §5.4 的分派表，容易做错的地方按文档强调的方式写成**显式不变量**而不是注释：
 *
 *   - **回补 ≠ 回环**：只有 `loop` 递增 `graphIteration` 与范围版本。回补是同一迭代内的
 *     向后调整，不改变攻击深度；回环开启新一层迭代，改变深度。这条区分直接决定时间线上
 *     「第几层网络」的显示，必须按表执行而不是按字面理解。
 *   - **交接记录的取值域**：`handoffs.transition_type` 只取 `advance` / `retry` / `loop` /
 *     `rollback` 四种；`interject_wake`、`handoff_cancel`、`handoff_regen`、`report_reopen`
 *     与运行标记类转移不产生交接记录。
 *   - **每次转移都推进状态版本**：§5.4 步骤 7 在转移事务里更新状态版本；§6.7 进一步说明
 *     插话唤醒（`interject_wake`）虽然不产生交接记录，也要「`state_version` 正常推进」，
 *     否则账本会出现无法解释的版本跳跃。
 *
 * 纯逻辑：不碰数据库、不创建会话、不调用模型。
 */

import { HANDOFF_TRANSITION_TYPES, TRANSITION_TYPES, advancesIteration } from '../contracts.ts';
import type { ErrorCode, HandoffTransitionType, MainStatus, TransitionType } from '../contracts.ts';
import { RUNTIME_MARKER_TRANSITION_TYPES, isLegalStatusEdge, statusEdgesFor } from './phases.ts';

/**
 * 会话处置：
 *   - `true` / `false`：由该操作本身决定（例如插话唤醒必然复用当前会话）；
 *   - `'from-input'`：由人类在弹窗里选择——重做默认复用当前会话（§13.5）；
 *   - `null`：该操作不涉及会话复用判定（取消交接、运行标记等）。
 */
export type SessionReuse = boolean | 'from-input' | null;

export interface TransitionDispatch {
  readonly type: TransitionType;
  /** §5.4 分派表的「操作」列。 */
  readonly operation: string;
  /** 迭代计数变化（`graphIteration`）：只有回环为 1。 */
  readonly iterationDelta: 0 | 1;
  /** 范围版本变化：只有回环为 1。 */
  readonly scopeVersionDelta: 0 | 1;
  /** 是否写 `state_transitions`（所有取值都写）；字段存在是为了让不变量可断言。 */
  readonly stateVersionDelta: 1;
  /** 是否产生交接记录（`handoffs.transition_type` 的取值域）。 */
  readonly writesHandoff: boolean;
  readonly sessionReused: SessionReuse;
}

/** §5.4 分派表，逐行对照。 */
export const TRANSITION_DISPATCH: Readonly<Record<TransitionType, TransitionDispatch>> = {
  start: {
    type: 'start',
    operation: '首个会话启动',
    iterationDelta: 0,
    scopeVersionDelta: 0,
    stateVersionDelta: 1,
    writesHandoff: false,
    sessionReused: false,
  },
  advance: {
    type: 'advance',
    operation: '推进到下一阶段',
    iterationDelta: 0,
    scopeVersionDelta: 0,
    stateVersionDelta: 1,
    writesHandoff: true,
    sessionReused: false,
  },
  retry: {
    type: 'retry',
    operation: '重做（复用会话 / 新建会话）',
    iterationDelta: 0,
    scopeVersionDelta: 0,
    stateVersionDelta: 1,
    writesHandoff: true,
    sessionReused: 'from-input',
  },
  rollback: {
    type: 'rollback',
    operation: '回补到更早阶段',
    iterationDelta: 0,
    scopeVersionDelta: 0,
    stateVersionDelta: 1,
    writesHandoff: true,
    sessionReused: false,
  },
  loop: {
    type: 'loop',
    operation: '回环到情报收集（完成范围修订）',
    iterationDelta: 1,
    scopeVersionDelta: 1,
    stateVersionDelta: 1,
    writesHandoff: true,
    sessionReused: false,
  },
  interject_wake: {
    type: 'interject_wake',
    operation: '插话唤醒等待中的会话',
    iterationDelta: 0,
    scopeVersionDelta: 0,
    stateVersionDelta: 1,
    writesHandoff: false,
    sessionReused: true,
  },
  handoff_cancel: {
    type: 'handoff_cancel',
    operation: '取消交接（草稿阶段或确认阶段放弃切换）',
    iterationDelta: 0,
    scopeVersionDelta: 0,
    stateVersionDelta: 1,
    writesHandoff: false,
    sessionReused: null,
  },
  handoff_regen: {
    type: 'handoff_regen',
    operation: '要求重新生成交接草稿',
    iterationDelta: 0,
    scopeVersionDelta: 0,
    stateVersionDelta: 1,
    writesHandoff: false,
    sessionReused: null,
  },
  report_reopen: {
    type: 'report_reopen',
    operation: '从报告阶段返回补充技术动作',
    iterationDelta: 0,
    scopeVersionDelta: 0,
    stateVersionDelta: 1,
    writesHandoff: false,
    sessionReused: null,
  },
  pause: {
    type: 'pause',
    operation: '暂停',
    iterationDelta: 0,
    scopeVersionDelta: 0,
    stateVersionDelta: 1,
    writesHandoff: false,
    sessionReused: null,
  },
  resume: {
    type: 'resume',
    operation: '恢复',
    iterationDelta: 0,
    scopeVersionDelta: 0,
    stateVersionDelta: 1,
    writesHandoff: false,
    sessionReused: null,
  },
  abort: {
    type: 'abort',
    operation: '终止',
    iterationDelta: 0,
    scopeVersionDelta: 0,
    stateVersionDelta: 1,
    writesHandoff: false,
    sessionReused: null,
  },
  complete: {
    type: 'complete',
    operation: '完成',
    iterationDelta: 0,
    scopeVersionDelta: 0,
    stateVersionDelta: 1,
    writesHandoff: false,
    sessionReused: null,
  },
};

// ───────────────────────────── 不变量 ─────────────────────────────

export type DispatchProblemKind =
  | 'unknown_type'
  | 'missing_type'
  | 'type_field_mismatch'
  | 'iteration_not_only_loop'
  | 'scope_not_only_loop'
  | 'handoff_set_mismatch'
  | 'state_version_not_advanced'
  | 'session_reuse_mismatch'
  | 'status_edge_mismatch';

export interface DispatchProblem {
  readonly kind: DispatchProblemKind;
  readonly type: TransitionType | null;
  readonly detail: string;
}

/** 允许携带强制跳转标记的取值：§5.3 的强制入口只对阶段切换/回补/回环开放。 */
export const FORCEABLE_TRANSITION_TYPES: readonly TransitionType[] = ['advance', 'rollback', 'loop'];

/** 该取值是否产生交接记录，且是否为 `handoffs.transition_type` 的合法取值。 */
export function handoffTransitionTypeOf(
  type: TransitionType,
): { readonly ok: true; readonly type: HandoffTransitionType } | { readonly ok: false; readonly code: ErrorCode; readonly message: string } {
  const found = HANDOFF_TRANSITION_TYPES.find((candidate) => candidate === type);
  if (found === undefined) {
    return {
      ok: false,
      code: 'handoff_transition_illegal',
      message: `${type} 不产生交接记录，handoffs.transition_type 只取 ${HANDOFF_TRANSITION_TYPES.join(' / ')}`,
    };
  }
  return { ok: true, type: found };
}

/**
 * 校验分派表的不变量。默认校验内置表；测试可注入被改坏的表，验证每条不变量都真的会报错。
 */
export function validateDispatchTable(
  table: Readonly<Record<string, TransitionDispatch>> = TRANSITION_DISPATCH,
): readonly DispatchProblem[] {
  const problems: DispatchProblem[] = [];

  for (const type of TRANSITION_TYPES) {
    if (table[type] === undefined) {
      problems.push({ kind: 'missing_type', type, detail: `分派表缺少取值 ${type}` });
    }
  }
  for (const [key, row] of Object.entries(table)) {
    if (!(TRANSITION_TYPES as readonly string[]).includes(key)) {
      problems.push({ kind: 'unknown_type', type: null, detail: `分派表出现契约外的取值 ${key}` });
    }
    if (row.type !== key) {
      problems.push({ kind: 'type_field_mismatch', type: row.type, detail: `${key} 行的 type 字段是 ${row.type}` });
    }

    const advances = row.iterationDelta > 0;
    // 规则的单源在 `contracts.ts` 的 `advancesIteration()`（「只有回环递增迭代」）：
    // 这里改为**消费它**而不是再写一遍字面量，避免两处对「哪个转移递增」产生分歧。
    if (advances !== advancesIteration(row.type)) {
      problems.push({
        kind: 'iteration_not_only_loop',
        type: row.type,
        detail: `只有回环递增迭代计数；${key} 的 iterationDelta 是 ${row.iterationDelta}`,
      });
    }
    if ((row.scopeVersionDelta > 0) !== advances) {
      problems.push({
        kind: 'scope_not_only_loop',
        type: row.type,
        detail: `迭代与范围版本必须一起递增；${key} 的 scopeVersionDelta 是 ${row.scopeVersionDelta}`,
      });
    }
    if (row.writesHandoff !== (HANDOFF_TRANSITION_TYPES as readonly string[]).includes(key)) {
      problems.push({
        kind: 'handoff_set_mismatch',
        type: row.type,
        detail: `${key} 的交接记录处置与 handoffs.transition_type 的取值域不一致`,
      });
    }
    if (row.stateVersionDelta !== 1) {
      problems.push({
        kind: 'state_version_not_advanced',
        type: row.type,
        detail: `${key} 必须推进状态版本（§5.4 步骤 7、§6.7）`,
      });
    }
    const reuseRule =
      key === 'retry'
        ? row.sessionReused === 'from-input'
        : key === 'interject_wake'
          ? row.sessionReused === true
          : row.sessionReused === false || row.sessionReused === null;
    if (!reuseRule) {
      problems.push({
        kind: 'session_reuse_mismatch',
        type: row.type,
        detail: `${key} 的会话复用处置与 §5.4 / §6.7 不符：${String(row.sessionReused)}`,
      });
    }
    if (statusEdgesFor(row.type).length === 0 && !(RUNTIME_MARKER_TRANSITION_TYPES as readonly string[]).includes(key)) {
      problems.push({
        kind: 'status_edge_mismatch',
        type: row.type,
        detail: `${key} 在 §5.2 的状态图上没有对应的边（运行标记类取值不受此约束）`,
      });
    }
  }

  return problems;
}

export class WorkflowTransitionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WorkflowTransitionError';
  }
}

/**
 * 启动自检：分派表与契约、状态图三者必须一致。不一致就拒绝启动，
 * 而不是带着一张会写坏账本的表上线。
 */
export function assertDispatchTable(
  table: Readonly<Record<string, TransitionDispatch>> = TRANSITION_DISPATCH,
): void {
  const problems = validateDispatchTable(table);
  if (problems.length > 0) {
    throw new WorkflowTransitionError(
      `转移分派表校验失败（${problems.length} 项）：${problems.map((p) => p.detail).join('；')}`,
    );
  }
}

assertDispatchTable();

// ───────────────────────────── 转移计划 ─────────────────────────────

export interface TransitionRequest {
  readonly type: TransitionType;
  readonly fromStatus: MainStatus;
  readonly toStatus: MainStatus;
  /** 重做时人类的会话选择；缺省复用当前会话（§5.4、§13.5）。 */
  readonly reuseSession?: boolean;
  /** 跨出推荐路径时的强制跳转标记（§5.3）。只有 advance / rollback / loop 可以携带。 */
  readonly forced?: boolean;
}

export interface TransitionPlan {
  readonly type: TransitionType;
  readonly operation: string;
  readonly fromStatus: MainStatus;
  readonly toStatus: MainStatus;
  readonly forced: boolean;
  readonly iterationDelta: 0 | 1;
  readonly scopeVersionDelta: 0 | 1;
  readonly writesHandoff: boolean;
  /** 写交接记录时的 `handoffs.transition_type`；不写则为 null。 */
  readonly handoffTransitionType: HandoffTransitionType | null;
  readonly sessionReused: boolean;
}

export type TransitionPlanOutcome =
  | { readonly ok: true; readonly plan: TransitionPlan }
  | { readonly ok: false; readonly code: ErrorCode; readonly message: string };

/**
 * 产出一次转移的计数与会话处置。非法输入不静默：
 *   - 取值不在 `TRANSITION_TYPES` 内 → 抛 `WorkflowTransitionError`（调用方 bug）；
 *   - 取值不允许出现在该状态边上 → `handoff_transition_illegal`；
 *   - 不可强制的取值带了强制标记 → `handoff_transition_illegal`（会污染时间线与审计导出）。
 */
export function planTransition(request: TransitionRequest): TransitionPlanOutcome {
  const dispatch: TransitionDispatch | undefined = (
    TRANSITION_DISPATCH as Readonly<Record<string, TransitionDispatch>>
  )[request.type];
  if (dispatch === undefined) {
    throw new WorkflowTransitionError(`未知转移类型：${String(request.type)}`);
  }

  // 运行标记类（pause / resume / abort）在 §5.2 的状态图上**没有边**：
  // 它们只改 engagements.status，不改 current_status。因此不能用边校验，
  // 改为断言「主状态不变」——那正是 §5.1 两层状态表要求的语义。
  const isRuntimeMarker = (RUNTIME_MARKER_TRANSITION_TYPES as readonly string[]).includes(request.type);
  if (isRuntimeMarker) {
    if (request.fromStatus !== request.toStatus) {
      return {
        ok: false,
        code: 'handoff_transition_illegal',
        message:
          `${request.type} 是运行标记类，不得改变主状态（${request.fromStatus} → ${request.toStatus}）。` +
          `运行标记与主状态分列，见 §5.1`,
      };
    }
  } else if (!isLegalStatusEdge(request.type, request.fromStatus, request.toStatus)) {
    const edges = statusEdgesFor(request.type)
      .map((edge) => `${edge.from} → ${edge.to}`)
      .join('、');
    return {
      ok: false,
      code: 'handoff_transition_illegal',
      message:
        edges.length === 0
          ? `${request.type} 不产生主状态变化（运行标记类取值只改 runMarker，§5.1）`
          : `${request.type} 不允许出现在 ${request.fromStatus} → ${request.toStatus}，合法状态边是：${edges}`,
    };
  }

  const forced = request.forced === true;
  if (forced && !FORCEABLE_TRANSITION_TYPES.includes(request.type)) {
    return {
      ok: false,
      code: 'handoff_transition_illegal',
      message: `${request.type} 不支持强制跳转标记；只有 ${FORCEABLE_TRANSITION_TYPES.join(' / ')} 可以（§5.3）`,
    };
  }

  const handoff = handoffTransitionTypeOf(request.type);
  return {
    ok: true,
    plan: {
      type: request.type,
      operation: dispatch.operation,
      fromStatus: request.fromStatus,
      toStatus: request.toStatus,
      forced,
      iterationDelta: dispatch.iterationDelta,
      scopeVersionDelta: dispatch.scopeVersionDelta,
      writesHandoff: dispatch.writesHandoff,
      handoffTransitionType: handoff.ok ? handoff.type : null,
      sessionReused:
        dispatch.sessionReused === 'from-input' ? (request.reuseSession ?? true) : dispatch.sessionReused === true,
    },
  };
}
