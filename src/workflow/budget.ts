/**
 * 资源预算与进度活性（设计文档 §10.5；对照 §10.6 租约、§15.1 数据库不可用）。
 *
 * 两个概念必须分开，文档原话：
 *   - **预算**（`BudgetMeter`）回答「还能用多少」：token / 执行步数 / 挂钟时长三条总量上限，
 *     创建会话时冻结，达到上限即暂停交人判断；
 *   - **健康信号**（`LivenessMonitor`）回答「是否还在有效推进」：检查点、工具连续失败、
 *     队列压力、上下文压力四条活性信号。
 * 两者都进账本、都在控制台显示，且**都不自动终止会话**（§10.5 末段）。
 *
 * **token 维度的唯一来源是 dsh-budget 的官方计量结果**（§10.5「计数来源」）。
 * 这一点在接口层面成立，不是靠注释约定：本模块不提供任何写入 token 数的入口
 * （没有 `noteTokens` / `addTokens` / `setTokens` 之类的方法），token 只能经
 * `DshBudgetPort.readUsage` 读进来，且读数对象自带 `source: 'dsh-budget'` 的
 * 来源标记与 dsh 会话日志水位，随 `BudgetReading` 一起传播给控制台与审计。
 * `worker_sessions.consumed_*` 只是**投影读模型**（由计量结果写回），不是独立计数源；
 * 两者不一致时以 dsh-budget 为准并产出诊断事件（`BudgetDiagnostic`）。
 *
 * 步数与挂钟时长不属于 token 计量，由本模块自行统计：步数来自步骤事件
 * （`noteStep`），时长来自会话时间戳（`startedAt` / `endedAt`）。终止与失败状态
 * 不再消耗预算——终态一旦落地，步数与时长都冻结。
 */

import { DEFAULTS, LIVE_SESSION_STATUSES, SESSION_STATUSES } from '../contracts.ts';
import type { BudgetExtension, BudgetLimits, SessionStatus } from '../contracts.ts';

// ───────────────────────────── 取值域 ─────────────────────────────

/** 预算的三个维度；顺序固定，读数、理由与暂停请求都按这个顺序呈现。 */
export const BUDGET_DIMENSIONS = ['tokens', 'steps', 'seconds'] as const;
export type BudgetDimension = (typeof BUDGET_DIMENSIONS)[number];

/** 软阈值（80%）记 `warning`，达到上限记 `exhausted`，其余 `ok`。 */
export const BUDGET_VERDICTS = ['ok', 'warning', 'exhausted'] as const;
export type BudgetVerdict = (typeof BUDGET_VERDICTS)[number];

/**
 * 触顶之后的动作取值域：只有「继续」与「暂停」——**没有终止**。
 * §10.5 的硬阈值只把会话交给人类（追加预算继续 / 重做 / 切换），
 * 插件不代人做终止决定。取值域里没有终止成员，调用方也就拿不到终止。
 */
export const BUDGET_ACTIONS = ['continue', 'pause'] as const;
export type BudgetAction = (typeof BUDGET_ACTIONS)[number];

/** 人类在预算暂停后的三条路由（§10.5）；本模块只呈现，不代选。 */
export const HUMAN_BUDGET_OPTIONS = ['extend_budget', 'retry', 'transition'] as const;
export type HumanBudgetOption = (typeof HUMAN_BUDGET_OPTIONS)[number];

/**
 * 终止与失败状态：不再消耗预算（§10.5「终止与失败状态不再消耗预算」）。
 * 由 `SESSION_STATUSES − LIVE_SESSION_STATUSES` 推出，而不是另写一份取值域——
 * 终态定义与 §9.3 的存活会话索引说的是同一件事，两处各写一份必然漂移。
 */
export const BUDGET_TERMINAL_STATUSES: readonly SessionStatus[] = SESSION_STATUSES.filter(
  (status) => !(LIVE_SESSION_STATUSES as readonly SessionStatus[]).includes(status),
);

/** 是否属于「终止与失败」状态。 */
export function isBudgetTerminalStatus(status: SessionStatus): boolean {
  return BUDGET_TERMINAL_STATUSES.includes(status);
}

// ───────────────────────────── dsh-budget 计量端口 ─────────────────────────────

/**
 * dsh-budget 的官方计量结果（§10.5「用量数值直接取 dsh-budget 的官方计量结果」）。
 *
 * `source` 是字面量类型且随读数一路传播：数字是谁给的，控制台与审计都看得见。
 * `sessionSeq` 是读取时的 dsh 会话日志水位，用于说明「读的是哪一刻的聚合值」。
 */
export interface DshBudgetUsage {
  readonly source: 'dsh-budget';
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens?: number;
  readonly cacheWriteTokens?: number;
  /** 官方聚合值，包含缓存读写 token。 */
  readonly totalTokens: number;
  /** dsh 会话日志水位；由官方 aggregator 的当前 session 事件计数映射。 */
  readonly sessionSeq: number;
}

/** 官方 dsh-budget 读取面；由装配层从宿主 aggregator 构造。 */
export interface DshBudgetPort {
  readUsage(dshSessionId: string): DshBudgetUsage;
}

/** dsh-budget 官方聚合器所需的最小同步读取面。 */
export interface OfficialBudgetAggregator {
  sessionUsage(sessionId: string): {
    readonly inputTokens: number;
    readonly outputTokens: number;
    readonly cacheReadTokens: number;
    readonly cacheWriteTokens: number;
  };
  /** 可选；官方 aggregator 没有日志序号时由适配器保持 0。 */
  readonly sessionSequence?: (sessionId: string) => number;
}

// ───────────────────────────── 预算：修订与读数 ─────────────────────────────

/** 任一维度的追加量；三个字段都允许为 0，但不能同时为 0。 */
export interface BudgetDelta {
  readonly tokens: number;
  readonly steps: number;
  readonly seconds: number;
}

/**
 * 预算修订：创建时冻结第一版，追加预算产生新的一版并写入审计（§10.5：
 * 「追加预算产生新的修订并写入审计，不静默放大」）。
 */
export interface BudgetRevision {
  /** 从 1 开始，单调递增。 */
  readonly revision: number;
  /** 该修订生效后的上限。 */
  readonly limits: BudgetLimits;
  readonly reason: 'initial' | 'human_extension';
  readonly operatorId: string | null;
  /** 人类给出的追加理由；首版为 null。 */
  readonly note: string | null;
  readonly additional: BudgetDelta | null;
  readonly at: Date;
}

/** 单维度读数。`limit <= 0` 视为无额度，比率记 1（任何消耗即触顶）。 */
export interface BudgetDimensionReading {
  readonly dimension: BudgetDimension;
  readonly used: number;
  readonly limit: number;
  readonly remaining: number;
  readonly ratio: number;
  readonly verdict: BudgetVerdict;
  /**
   * 该维度是否有权威来源。token 维度在会话已终止且从未取到官方读数时为 false——
   * 本模块不猜数字，也不会因此改用自建计数。
   */
  readonly metered: boolean;
}

/** 软阈值告警（达到上限的 80%）：写入告警事件后会话继续运行。 */
export interface BudgetWarning {
  readonly dimension: BudgetDimension;
  readonly used: number;
  readonly limit: number;
  readonly ratio: number;
  readonly message: string;
}

/** `worker_sessions.consumed_*` 投影读模型；**不是**计数源（§10.5）。 */
export interface BudgetProjection {
  readonly consumedTokens: number;
  readonly consumedSteps: number;
}

export type BudgetDiagnosticKind = 'projection_mismatch_tokens' | 'projection_mismatch_steps';

/**
 * 诊断事件：投影与计量不一致时不静默，写明分歧与以谁为准。
 * token 以 dsh-budget 为准，步数以步骤事件为准（投影由它写回）。
 */
export interface BudgetDiagnostic {
  readonly kind: BudgetDiagnosticKind;
  readonly projectionValue: number;
  readonly meteredValue: number;
  readonly authoritative: 'dsh-budget' | 'step_events';
  readonly message: string;
}

/** 硬阈值后的暂停请求；人类三条路由见 `humanOptions`。 */
export interface BudgetPauseRequest {
  readonly action: 'pause';
  readonly reason: 'budget_exhausted';
  /** 触顶的维度，按 `BUDGET_DIMENSIONS` 顺序。 */
  readonly dimensions: readonly BudgetDimension[];
  readonly message: string;
  readonly humanOptions: readonly HumanBudgetOption[];
}

export interface BudgetReading {
  readonly at: Date;
  readonly revision: number;
  readonly limits: BudgetLimits;
  readonly tokens: BudgetDimensionReading;
  readonly steps: BudgetDimensionReading;
  readonly seconds: BudgetDimensionReading;
  /** 三个维度里的最高严重度。 */
  readonly verdict: BudgetVerdict;
  /** 取值域只有 continue / pause：预算耗尽不终止会话。 */
  readonly action: BudgetAction;
  /** 仅当 `action === 'pause'` 时非空。 */
  readonly pauseRequest: BudgetPauseRequest | null;
  /** 达到软阈值的维度（按 `BUDGET_DIMENSIONS` 顺序），写入告警事件后会话继续运行。 */
  readonly warnings: readonly BudgetWarning[];
  /** token 读数的来源，恒为 `'dsh-budget'`；随读数一起传播，便于控制台标注。 */
  readonly tokenSource: 'dsh-budget';
  /** 官方读数在 dsh 会话日志上的水位。 */
  readonly tokenSeq: number;
  /** 会话是否仍在消耗预算；终态（closed / superseded / failed）后为 false。 */
  readonly consuming: boolean;
  readonly diagnostics: readonly BudgetDiagnostic[];
}

/** 前置条件被违反（调用方协议错误），不是工具可见的拒绝路径。 */
export class BudgetProtocolError extends Error {
  override readonly name = 'BudgetProtocolError';
}

// ───────────────────────────── 预算计量器 ─────────────────────────────

export interface BudgetMeterInput {
  /** dsh-budget 端口：token 维度的唯一来源。 */
  readonly dshBudget: DshBudgetPort;
  readonly dshSessionId: string;
  /** 创建会话时冻结的预算（§10.5「每个会话在创建时冻结一份预算」）。 */
  readonly limits: BudgetLimits;
  /** 会话时间戳的起点；挂钟时长由它算起。 */
  readonly startedAt: Date;
  /** 已提交的步骤投影；用于进程重启后恢复本会话的步骤水位。 */
  readonly initialSteps?: number;
  readonly status?: SessionStatus;
  /** 软阈值比率；默认取 `DEFAULTS.budgetSoftThresholdRatio`（0.8）。 */
  readonly softThresholdRatio?: number;
}


function validateLimits(limits: BudgetLimits): void {
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new BudgetProtocolError(`预算上限非法：${name}=${String(value)}`);
    }
  }
}

const VERDICT_RANK: Record<BudgetVerdict, number> = { ok: 0, warning: 1, exhausted: 2 };

/**
 * 预算计量与闸门（§10.5）。
 *
 * 本类是**闸门**，不是计数器：把 dsh-budget 的官方计量结果与冻结的预算上限比较，
 * 产生告警（软阈值）与暂停请求（硬阈值）。因此它没有任何写入 token 的 API，
 * 步数是它唯一自增的东西（步数不属于 token 计量）。
 * 硬阈值返回 `pause`，**绝不返回终止**——人类的三个选择在 `pauseRequest` 里。
 */
export class BudgetMeter {
  readonly #dshBudget: DshBudgetPort;
  readonly #dshSessionId: string;
  readonly #softThresholdRatio: number;
  readonly #startedAt: Date;
  #status: SessionStatus;
  #limits: BudgetLimits;
  readonly #revisions: BudgetRevision[];
  #steps = 0;
  #endedAt: Date | null = null;
  /** 最近一次官方读数，原样缓存；从不自增、从不由别处写入。 */
  #lastUsage: DshBudgetUsage | null = null;

  constructor(input: BudgetMeterInput) {
    const softThresholdRatio = input.softThresholdRatio ?? DEFAULTS.budgetSoftThresholdRatio;
    if (softThresholdRatio <= 0 || softThresholdRatio > 1) {
      throw new BudgetProtocolError(`软阈值比率必须在 (0, 1] 内，收到 ${softThresholdRatio}`);
    }
    this.#dshBudget = input.dshBudget;
    this.#dshSessionId = input.dshSessionId;
    this.#softThresholdRatio = softThresholdRatio;
    this.#startedAt = input.startedAt;
    this.#status = input.status ?? 'active';
    this.#limits = { ...input.limits };
    this.#revisions = [
      {
        revision: 1,
        limits: this.#limits,
        reason: 'initial',
        operatorId: null,
        note: null,
        additional: null,
        at: input.startedAt,
      },
    ];
    if (!Number.isSafeInteger(input.initialSteps ?? 0) || (input.initialSteps ?? 0) < 0) {
      throw new BudgetProtocolError(`初始步骤投影非法：${String(input.initialSteps)}`);
    }
    this.#steps = input.initialSteps ?? 0;
    if (isBudgetTerminalStatus(this.#status)) {
      // 会话一创建就处于终态（复用旧会话的行）：不消耗预算，时长即 0。
      this.#endedAt = input.startedAt;
    }
  }


  get dshSessionId(): string {
    return this.#dshSessionId;
  }

  /** 克隆一次观测候选；事务失败时丢弃候选，不污染已提交的计量状态。 */
  fork(): BudgetMeter {
    const copy = new BudgetMeter({
      dshBudget: this.#dshBudget,
      dshSessionId: this.#dshSessionId,
      limits: this.#limits,
      startedAt: this.#startedAt,
      initialSteps: this.#steps,
      status: this.#status,
      softThresholdRatio: this.#softThresholdRatio,
    });
    copy.#limits = { ...this.#limits };
    copy.#revisions.splice(0, copy.#revisions.length, ...this.#revisions.map((revision) => ({
      ...revision,
      limits: { ...revision.limits },
      additional: revision.additional === null ? null : { ...revision.additional },
    })));
    copy.#endedAt = this.#endedAt === null ? null : new Date(this.#endedAt);
    copy.#lastUsage = this.#lastUsage === null ? null : { ...this.#lastUsage };
    return copy;
  }

  /**
   * 把已提交的 worker_sessions 上限同步到观测候选。
   * 上限只能前进；修订号因此在进程重启后仍不承担幂等身份，事件 id 使用上限快照。
   */
  synchronizeCommittedLimits(limits: BudgetLimits, at: Date = new Date()): void {
    validateLimits(limits);
    if (limits.maxTokens < this.#limits.maxTokens
      || limits.maxSteps < this.#limits.maxSteps
      || limits.maxSeconds < this.#limits.maxSeconds) {
      throw new BudgetProtocolError('已提交预算上限不可回退');
    }
    if (limits.maxTokens === this.#limits.maxTokens
      && limits.maxSteps === this.#limits.maxSteps
      && limits.maxSeconds === this.#limits.maxSeconds) return;
    const additional: BudgetDelta = {
      tokens: limits.maxTokens - this.#limits.maxTokens,
      steps: limits.maxSteps - this.#limits.maxSteps,
      seconds: limits.maxSeconds - this.#limits.maxSeconds,
    };
    this.#limits = { ...limits };
    this.#revisions.push({
      revision: this.#revisions.length + 1,
      limits: this.#limits,
      reason: 'human_extension',
      operatorId: null,
      note: '从已提交 worker_sessions 预算快照同步',
      additional,
      at,
    });
  }

  get status(): SessionStatus {
    return this.#status;
  }

  /** 会话是否仍在消耗预算；终态（终止与失败）后为 false。 */
  get consuming(): boolean {
    return this.#endedAt === null;
  }

  get revision(): number {
    return this.#revisions.length;
  }

  /** 修订历史（审计用）：首版 + 每次人类追加。 */
  get revisions(): readonly BudgetRevision[] {
    return this.#revisions;
  }

  get limits(): BudgetLimits {
    return this.#limits;
  }

  get startedAt(): Date {
    return this.#startedAt;
  }

  /** 停止消耗的时刻；仍在消耗时为 null。 */
  get endedAt(): Date | null {
    return this.#endedAt;
  }

  /** 步骤事件累计出的步数（本插件自建，不属于 token 计量）。 */
  get steps(): number {
    return this.#steps;
  }

  /** 最近一次官方读数；尚未取过时为 null（不猜、不补零）。 */
  get lastUsage(): DshBudgetUsage | null {
    return this.#lastUsage;
  }

  /**
   * 记一步（来自步骤事件）。终止与失败的会话不再消耗预算，因此返回 false 且不计数。
   */
  noteStep(): boolean {
    if (!this.consuming) return false;
    this.#steps += 1;
    return true;
  }

  /**
   * 会话状态变化。进入终态（closed / superseded / failed）即冻结预算：
   * 记下结束时刻，此后的步数、时长与 dsh-budget 取数全部停止。
   * 终态不可逆，因此已冻结后收到存活态不改写（数据库触发器同样不允许回退）。
   */
  setStatus(status: SessionStatus, at: Date = new Date()): void {
    this.#status = status;
    if (!this.consuming) return;
    if (isBudgetTerminalStatus(status)) this.#endedAt = at;
  }

  /**
   * 追加预算：产生**新的修订**并记入审计，不静默放大（§10.5）。
   * 终态会话不再消耗预算，也不接受追加；增量必须至少有一项为正。
   */
  extend(input: BudgetExtension, at: Date = new Date()): BudgetRevision {
    if (!this.consuming) {
      throw new BudgetProtocolError(`会话已处于终态（${this.#status}），预算不再消耗，也不接受追加`);
    }
    const additional: BudgetDelta = {
      tokens: input.additionalTokens ?? 0,
      steps: input.additionalSteps ?? 0,
      seconds: input.additionalSeconds ?? 0,
    };
    if (additional.tokens < 0 || additional.steps < 0 || additional.seconds < 0) {
      throw new BudgetProtocolError('追加预算的增量不能为负');
    }
    if (additional.tokens === 0 && additional.steps === 0 && additional.seconds === 0) {
      throw new BudgetProtocolError('追加预算必须至少给出一项正增量');
    }

    this.#limits = {
      maxTokens: this.#limits.maxTokens + additional.tokens,
      maxSteps: this.#limits.maxSteps + additional.steps,
      maxSeconds: this.#limits.maxSeconds + additional.seconds,
    };
    const revision: BudgetRevision = {
      revision: this.#revisions.length + 1,
      limits: this.#limits,
      reason: 'human_extension',
      operatorId: input.operatorId,
      note: input.reason ?? null,
      additional,
      at,
    };
    this.#revisions.push(revision);
    return revision;
  }

  /**
   * 读一次预算状态。`at` 是判定时刻（默认现在），`projection` 是可选的
   * `worker_sessions.consumed_*` 投影——只用于对账，永不覆盖计量结果。
   */
  evaluate(at: Date = new Date(), projection: BudgetProjection | null = null): BudgetReading {
    const usage = this.#readUsage();
    const seconds = Math.max(0, Math.floor(secondsBetween(this.#startedAt, this.#endedAt ?? at)));

    const tokens = this.#dimension('tokens', usage === null ? 0 : usage.totalTokens, this.#limits.maxTokens, usage !== null);
    const steps = this.#dimension('steps', this.#steps, this.#limits.maxSteps, true);
    const secondsReading = this.#dimension('seconds', seconds, this.#limits.maxSeconds, true);
    const readings = [tokens, steps, secondsReading];

    const verdict = readings.reduce<BudgetVerdict>(
      (worst, reading) => (VERDICT_RANK[reading.verdict] > VERDICT_RANK[worst] ? reading.verdict : worst),
      'ok',
    );
    const exhausted = readings.filter((reading) => reading.verdict === 'exhausted');
    const warnings = readings
      .filter((reading) => reading.verdict === 'warning')
      .map<BudgetWarning>((reading) => ({
        dimension: reading.dimension,
        used: reading.used,
        limit: reading.limit,
        ratio: reading.ratio,
        message: `预算达到上限的 ${Math.round(reading.ratio * 100)}%：${reading.dimension} ${reading.used}/${reading.limit}，会话继续运行（§10.5 软阈值告警）`,
      }));

    return {
      at,
      revision: this.#revisions.length,
      limits: this.#limits,
      tokens,
      steps,
      seconds: secondsReading,
      verdict,
      action: exhausted.length > 0 ? 'pause' : 'continue',
      pauseRequest:
        exhausted.length > 0
          ? {
              action: 'pause',
              reason: 'budget_exhausted',
              dimensions: exhausted.map((reading) => reading.dimension),
              message: `预算耗尽，会话暂停等待人工判断：${exhausted
                .map((reading) => `${reading.dimension} ${reading.used}/${reading.limit}`)
                .join('、')}（§10.5；会话仍存活，租约保留）`,
              humanOptions: HUMAN_BUDGET_OPTIONS,
            }
          : null,
      warnings,
      tokenSource: 'dsh-budget',
      tokenSeq: usage === null ? 0 : usage.sessionSeq,
      consuming: this.consuming,
      diagnostics: projection === null ? [] : this.#compareProjection(projection, tokens, steps),
    };
  }

  // ───────────────────────── 内部 ─────────────────────────

  /**
   * 取官方计量结果：**只读**。仍在消耗时每次都向 dsh-budget 取当前聚合值并原样缓存；
   * 已终止或失败则不再取数（终止即停止消耗），返回冻结前的最后一次官方读数。
   */
  #readUsage(): DshBudgetUsage | null {
    if (!this.consuming) return this.#lastUsage;
    const usage = this.#dshBudget.readUsage(this.#dshSessionId);
    this.#lastUsage = usage;
    return usage;
  }

  #dimension(
    dimension: BudgetDimension,
    used: number,
    limit: number,
    metered: boolean,
  ): BudgetDimensionReading {
    const ratio = limit > 0 ? used / limit : 1;
    return {
      dimension,
      used,
      limit,
      remaining: Math.max(0, limit - used),
      ratio,
      // 达到上限即 exhausted（要人判断），达到上限的软阈值比率即 warning（只告警）。
      verdict: ratio >= 1 ? 'exhausted' : ratio >= this.#softThresholdRatio ? 'warning' : 'ok',
      metered,
    };
  }

  /** 投影与计量对账：不一致产出诊断事件，且**不改写**计量结果（§10.5）。 */
  #compareProjection(
    projection: BudgetProjection,
    tokens: BudgetDimensionReading,
    steps: BudgetDimensionReading,
  ): readonly BudgetDiagnostic[] {
    const diagnostics: BudgetDiagnostic[] = [];
    if (projection.consumedTokens !== tokens.used) {
      diagnostics.push({
        kind: 'projection_mismatch_tokens',
        projectionValue: projection.consumedTokens,
        meteredValue: tokens.used,
        authoritative: 'dsh-budget',
        message: `consumed_tokens（${projection.consumedTokens}）与 dsh-budget 官方计量（${tokens.used}）不一致，以 dsh-budget 为准`,
      });
    }
    if (projection.consumedSteps !== steps.used) {
      diagnostics.push({
        kind: 'projection_mismatch_steps',
        projectionValue: projection.consumedSteps,
        meteredValue: steps.used,
        authoritative: 'step_events',
        message: `consumed_steps（${projection.consumedSteps}）与步骤事件计量（${steps.used}）不一致，以步骤事件为准`,
      });
    }
    return diagnostics;
  }
}

/** 计量结果写回投影的值：投影永远是计量结果的投影，不是另一个计数器。 */
export function projectionOf(reading: BudgetReading): BudgetProjection {
  return { consumedTokens: reading.tokens.used, consumedSteps: reading.steps.used };
}

function secondsBetween(from: Date, to: Date): number {
  return Math.max(0, (to.getTime() - from.getTime()) / 1000);
}

// ───────────────────────────── 进度活性 ─────────────────────────────

/**
 * 健康信号取值域（§10.5 表）。它们是「是否还在有效推进」的信号，
 * **不是**预算：既不产生暂停，更不产生终止。
 */
export const HEALTH_SIGNAL_KINDS = [
  'stalled',
  'tool_failure_streak',
  'queue_pressure',
  'context_pressure',
] as const;
export type HealthSignalKind = (typeof HEALTH_SIGNAL_KINDS)[number];

/**
 * 上下文「持续高于」判定窗的默认值（秒）。
 * 文档只给了比率 0.85 与「持续」二字、未给时间窗；此处取与队列压力同量级的 60 秒，
 * 理由：一次瞬时冲高（例如压缩前的单个回合）就写健康信号的话，信号会退化成噪声。
 * 调用方可经 `LivenessMonitorInput.contextPressureSeconds` 覆盖。
 */
export const DEFAULT_CONTEXT_PRESSURE_SECONDS = 60;

/**
 * 活性检查后的动作取值域：只有「继续」与「记信号」——**没有终止**。
 * §10.5 原话「停滞不等于自动终止：会话继续运行，人类据此判断是继续等、
 * 插话纠偏还是中断重做」。取值域里没有终止成员，调用方也就拿不到终止。
 */
export const LIVENESS_ACTIONS = ['continue', 'signal'] as const;
export type LivenessAction = (typeof LIVENESS_ACTIONS)[number];

export interface HealthSignal {
  readonly kind: HealthSignalKind;
  readonly at: Date;
  /** 触发阈值与实测值，控制台据此标注；账本里也据此复核。 */
  readonly threshold: number;
  readonly observed: number;
  /** 人读描述，写账本与提示条共用。 */
  readonly detail: string;
}

export interface LivenessSnapshot {
  readonly at: Date;
  /** 连续错过的检查点数（一次检查点到达即清零）。 */
  readonly missedCheckpoints: number;
  readonly consecutiveToolFailures: number;
  /** 队首待执行动作已等待的秒数；队列空时为 null。 */
  readonly queuePendingSeconds: number | null;
  /** 最近一次上报的上下文估算用量。 */
  readonly contextRatio: number | null;
  /** 上下文估算用量已持续高于阈值的秒数；未高于时为 null。 */
  readonly contextHighSeconds: number | null;
  readonly stalled: boolean;
  /** 取值域只有 continue / signal：停滞与压力信号都不终止会话。 */
  readonly action: LivenessAction;
  /** 本轮新产生的信号（边沿触发：同一段压力只写一次账本）。 */
  readonly raised: readonly HealthSignal[];
  /** 当前仍然成立的信号（按 `HEALTH_SIGNAL_KINDS` 顺序）。 */
  readonly active: readonly HealthSignalKind[];
  /** 迄今写出的全部信号（按产生顺序）。 */
  readonly issued: readonly HealthSignal[];
}

export interface LivenessMonitorInput {
  readonly startedAt: Date;
  /** 检查点间隔（秒）；默认 `DEFAULTS.checkpointIntervalSeconds`（180）。 */
  readonly checkpointIntervalSeconds?: number;
  /** 连续错过多少次判定停滞；默认 `DEFAULTS.maxMissedCheckpoints`（2）。 */
  readonly maxMissedCheckpoints?: number;
  /** 工具连续失败阈值；默认 `DEFAULTS.maxConsecutiveToolFailures`（5）。 */
  readonly maxConsecutiveToolFailures?: number;
  /** 队首待执行动作的压力阈值（秒）；默认 `DEFAULTS.queuePressureSeconds`（60）。 */
  readonly queuePressureSeconds?: number;
  /** 上下文压力比率；默认 `DEFAULTS.contextPressureRatio`（0.85）。 */
  readonly contextPressureRatio?: number;
  /**
   * 上下文「**持续**高于」判定窗（秒）；见 `DEFAULT_CONTEXT_PRESSURE_SECONDS`。
   */
  readonly contextPressureSeconds?: number;
}

/**
 * 进度活性监视器（纯状态机）：不查库、不改状态、不终止任何东西。
 *
 * 它只做两件事：判定四条健康信号、把信号写进账本（`drain`）。
 * 「停滞」是**结论**而不是**动作**——判出停滞之后会话照常运行（§10.5）。
 * 会话继续运行也意味着可恢复：检查点到达、工具恢复成功、队列被调度、
 * 上下文回落，信号即解除并重新武装（同一段压力解除了，下一次是新的一回事）。
 */
export class LivenessMonitor {
  readonly #checkpointIntervalSeconds: number;
  readonly #maxMissedCheckpoints: number;
  readonly #maxConsecutiveToolFailures: number;
  readonly #queuePressureSeconds: number;
  readonly #contextPressureRatio: number;
  readonly #contextPressureSeconds: number;
  #lastCheckpointAt: Date;
  #missedCheckpoints = 0;
  #consecutiveToolFailures = 0;
  #queuePendingAt: Date | null = null;
  #contextRatio: number | null = null;
  #contextHighSince: Date | null = null;
  readonly #active = new Set<HealthSignalKind>();
  readonly #pending: HealthSignal[] = [];
  readonly #issued: HealthSignal[] = [];

  constructor(input: LivenessMonitorInput) {
    this.#checkpointIntervalSeconds = positive(
      'checkpointIntervalSeconds',
      input.checkpointIntervalSeconds ?? DEFAULTS.checkpointIntervalSeconds,
    );
    this.#maxMissedCheckpoints = positive(
      'maxMissedCheckpoints',
      input.maxMissedCheckpoints ?? DEFAULTS.maxMissedCheckpoints,
    );
    this.#maxConsecutiveToolFailures = positive(
      'maxConsecutiveToolFailures',
      input.maxConsecutiveToolFailures ?? DEFAULTS.maxConsecutiveToolFailures,
    );
    this.#queuePressureSeconds = positive(
      'queuePressureSeconds',
      input.queuePressureSeconds ?? DEFAULTS.queuePressureSeconds,
    );
    this.#contextPressureRatio = input.contextPressureRatio ?? DEFAULTS.contextPressureRatio;
    this.#contextPressureSeconds = positive(
      'contextPressureSeconds',
      input.contextPressureSeconds ?? DEFAULT_CONTEXT_PRESSURE_SECONDS,
    );
    this.#lastCheckpointAt = input.startedAt;
  }

  get checkpointIntervalSeconds(): number {
    return this.#checkpointIntervalSeconds;
  }

  /** 当前仍然成立的信号。 */
  get active(): readonly HealthSignalKind[] {
    return HEALTH_SIGNAL_KINDS.filter((kind) => this.#active.has(kind));
  }

  /** 迄今写出的全部信号（按产生顺序）。 */
  get issued(): readonly HealthSignal[] {
    return this.#issued;
  }

  /**
   * 观察到一个检查点：清零错过计数、解除停滞判定（会话继续运行）。
   * 一次检查点只证明「此刻还在推进」，之后仍需周期上报。
   */
  checkpoint(at: Date = new Date()): LivenessSnapshot {
    this.#lastCheckpointAt = at;
    this.#missedCheckpoints = 0;
    this.#clear('stalled');
    return this.#evaluate(at);
  }

  /** 定时扫描：只跑与时间有关的三条规则（检查点、队列压力、上下文压力）。 */
  observe(at: Date = new Date()): LivenessSnapshot {
    return this.#evaluate(at);
  }

  /** 工具结果：连续失败达到阈值写健康信号，一次成功即清零并解除信号。 */
  noteToolResult(ok: boolean, at: Date = new Date()): LivenessSnapshot {
    if (ok) {
      this.#consecutiveToolFailures = 0;
      this.#clear('tool_failure_streak');
    } else {
      this.#consecutiveToolFailures += 1;
    }
    return this.#evaluate(at);
  }

  /**
   * 有待执行动作：只在这条**队首**首次进入队列时记下等待起点。
   * 后续再有动作入队不重置计时——压力衡量的是「最久的那个还没被调度」。
   */
  noteQueuePending(at: Date = new Date()): LivenessSnapshot {
    if (this.#queuePendingAt === null) this.#queuePendingAt = at;
    return this.#evaluate(at);
  }

  /** 队列已排空（全部被调度）：清除等待计时并解除队列压力信号。 */
  noteQueueDrained(at: Date = new Date()): LivenessSnapshot {
    this.#queuePendingAt = null;
    this.#clear('queue_pressure');
    return this.#evaluate(at);
  }

  /** 上报表决器估算的上下文用量比率（0–1]。高于阈值开始计时，回落即清零。 */
  noteContextUsage(ratio: number, at: Date = new Date()): LivenessSnapshot {
    this.#contextRatio = ratio;
    if (ratio > this.#contextPressureRatio) {
      if (this.#contextHighSince === null) this.#contextHighSince = at;
    } else {
      this.#contextHighSince = null;
      this.#clear('context_pressure');
    }
    return this.#evaluate(at);
  }

  /**
   * 取走尚未写入账本的信号；取走后清空，避免同一段压力重复记账。
   * 解除后再次出现是**新的一回事**，会再次入队（`#clear` 重新武装）。
   */
  drain(): readonly HealthSignal[] {
    return this.#pending.splice(0, this.#pending.length);
  }

  // ───────────────────────── 内部 ─────────────────────────

  #evaluate(at: Date): LivenessSnapshot {
    const raised: HealthSignal[] = [];

    // 检查点：每超出一个整间隔记一次错过；错过计数是「连续」量，检查点到达即清零。
    const sinceCheckpoint = secondsBetween(this.#lastCheckpointAt, at);
    const missedNow = Math.floor(sinceCheckpoint / this.#checkpointIntervalSeconds);
    if (missedNow > 0) {
      this.#missedCheckpoints += missedNow;
      this.#lastCheckpointAt = new Date(
        this.#lastCheckpointAt.getTime() + missedNow * this.#checkpointIntervalSeconds * 1000,
      );
      if (this.#missedCheckpoints >= this.#maxMissedCheckpoints) {
        const signal = this.#raise(
          'stalled',
          at,
          this.#maxMissedCheckpoints,
          this.#missedCheckpoints,
          `连续错过 ${this.#missedCheckpoints} 次检查点（间隔 ${this.#checkpointIntervalSeconds} 秒）：判定进度停滞；会话继续运行，由人类判断继续等、插话纠偏还是中断重做（§10.5）`,
        );
        if (signal !== null) raised.push(signal);
      }
    }

    if (this.#consecutiveToolFailures >= this.#maxConsecutiveToolFailures) {
      const signal = this.#raise(
        'tool_failure_streak',
        at,
        this.#maxConsecutiveToolFailures,
        this.#consecutiveToolFailures,
        `工具连续失败 ${this.#consecutiveToolFailures} 次：提示可能需要人工介入（§10.5）`,
      );
      if (signal !== null) raised.push(signal);
    }

    const queuePendingSeconds =
      this.#queuePendingAt === null ? null : secondsBetween(this.#queuePendingAt, at);
    if (queuePendingSeconds !== null && queuePendingSeconds >= this.#queuePressureSeconds) {
      const signal = this.#raise(
        'queue_pressure',
        at,
        this.#queuePressureSeconds,
        queuePendingSeconds,
        `待执行动作已等待 ${Math.floor(queuePendingSeconds)} 秒未被调度（阈值 ${this.#queuePressureSeconds} 秒）：写入健康信号（§10.5）`,
      );
      if (signal !== null) raised.push(signal);
    }

    const contextHighSeconds =
      this.#contextHighSince === null ? null : secondsBetween(this.#contextHighSince, at);
    if (contextHighSeconds !== null && contextHighSeconds >= this.#contextPressureSeconds) {
      const signal = this.#raise(
        'context_pressure',
        at,
        this.#contextPressureRatio,
        this.#contextRatio ?? 0,
        `上下文估算用量已持续 ${Math.floor(contextHighSeconds)} 秒高于 ${this.#contextPressureRatio}：写入健康信号（§10.5）`,
      );
      if (signal !== null) raised.push(signal);
    }

    return {
      at,
      missedCheckpoints: this.#missedCheckpoints,
      consecutiveToolFailures: this.#consecutiveToolFailures,
      queuePendingSeconds,
      contextRatio: this.#contextRatio,
      contextHighSeconds,
      stalled: this.#missedCheckpoints >= this.#maxMissedCheckpoints,
      action: this.#active.size > 0 ? 'signal' : 'continue',
      raised,
      active: this.active,
      issued: this.#issued,
    };
  }

  /** 边沿触发：同一段压力只产出一个信号，解除后才重新武装。 */
  #raise(
    kind: HealthSignalKind,
    at: Date,
    threshold: number,
    observed: number,
    detail: string,
  ): HealthSignal | null {
    if (this.#active.has(kind)) return null;
    this.#active.add(kind);
    const signal: HealthSignal = { kind, at, threshold, observed, detail };
    this.#pending.push(signal);
    this.#issued.push(signal);
    return signal;
  }

  /** 压力解除：清除生效标记，使同一信号在下次出现时能再次写入。 */
  #clear(kind: HealthSignalKind): void {
    this.#active.delete(kind);
  }
}

function positive(field: string, value: number): number {
  if (!(value > 0)) throw new BudgetProtocolError(`活性阈值 ${field} 必须为正数，收到 ${value}`);
  return value;
}
