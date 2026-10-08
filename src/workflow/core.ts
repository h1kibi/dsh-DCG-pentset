/**
 * 工作流域的**共享核心**：事务原语、审计写入、行装载器与策略展开。
 *
 * 从 `pg-workflow.ts` 机械搬运（拆分目标：服务类只做组合、各流程类只做流程）。
 * 成员对流程类可见——这是刻意的：流程类与核心同属一个模块家族，核心的职责是
 * 「把与数据库/审计/租约的原语收进一处」，而不是再包一层接口。
 *
 * 两个读投影（`getState` / `getScopeProposal`）也在核心：它们被多个流程内部调用
 * （重做、交接确认、重新打开……），放流程类会制造流程间依赖环。
 *
 * ── 与拆分前的关系 ──
 *
 * 成员名与拆分前的私有方法一一对应（`#tx` → `tx`，`#d` → `deps`）；
 * 方法体未改动，仅引用改写。任何行为差异都应是缺陷，而不是「拆分顺手改进」。
 */

import { transactionRunnerFor, DbTransactionRunner } from '../memory/ledger.ts';
import type { ActionClass, ApprovalMode, ApprovalRecord, BehaviorProfile, BudgetLimits, MainStatus, Phase, RetryRequest, RunMarker, ScopeEntryProfile, ScopeProposal, SessionKind, SkillFreezeEntry, TransitionType, WorkflowSnapshot } from '../contracts.ts';
import { ACTION_CLASSES, EXEC_TOOL_NAME, BEHAVIOR_PROFILES, SCOPE_ENTRY_PROFILES, TERMINAL_SESSION_STATUSES, runActionAvailability } from '../contracts.ts';
import { expandBehaviorProfile, policyContentHash, unknownPolicyOverrideKeys } from '../policy/behavior-profile.ts';
import type { ExpandedBehaviorProfile } from '../policy/behavior-profile.ts';
import { normalizeScope } from '../policy/scope-snapshot.ts';
import type { NormalizedScope } from '../policy/scope-snapshot.ts';
import type { ScopeTarget } from '../contracts.ts';
import type { DbRlsContext, RlsAwareDbClient } from '../db/port.ts';
import { isPhase } from '../contracts.ts';
import { planTransition } from './transition-table.ts';
import type { TransitionPlan, TransitionPlanOutcome } from './transition-table.ts';
import { RUNTIME_MARKER_TRANSITION_TYPES, isLegalStatusEdge } from './phases.ts';
import type { FrozenSessionInput, ActionTemplateBrief } from './session-port.ts';
import type { BehaviorBrief } from '../policy/behavior-prompts.ts';
import { SessionFactoryError } from './session-port.ts';
import { applySessionStatusChange } from './lease.ts';
import { DEFAULTS } from '../contracts.ts';
import type { AppendEventInput } from '../contracts.ts';
import { SYSTEM_OPERATOR_ID, WorkflowRejection, asPlainRecord, asRecord, defaultCapabilities, readAuthorizationExpiry, readNumber, toInt, toScopeProposal } from './model.ts';
import type { CapabilityResolver, ConfirmationExpansion, EngagementRow, ScopeProposalRow, SessionRow, WorkflowServiceDeps } from './model.ts';

export class WorkflowCore {
  readonly deps: Required<Pick<WorkflowServiceDeps, 'db' | 'txDb' | 'sessions' | 'leases' | 'ledger'>> &
    WorkflowServiceDeps;
  readonly #txRunner: DbTransactionRunner;
  #fallbackCapabilities: CapabilityResolver | null = null;

  constructor(deps: WorkflowServiceDeps) {
    this.deps = deps;
    this.#txRunner = transactionRunnerFor(deps.txDb);
  }

  now(): Date {
    return this.deps.clock?.() ?? new Date();
  }

  id(): string {
    return this.deps.newId?.() ?? crypto.randomUUID();
  }

  /**
   * 本实例的租户标识。
   *
   * 与 `createEngagement` 写入时用的是**同一个来源**（`rlsContext?.tenantId ?? 'local'`）——
   * 两处必须一致，否则新建的作业在列表里看不见。
   */
  tenantId(): string {
    return this.deps.rlsContext?.tenantId ?? 'local';
  }

  assertRlsEngagement(engagementId: string): void {
    // 判据从「进程锁」换成「当前异步作用域」：engagement 不再是进程级状态，
    // 因此并发作业之间不会互相顶掉。作用域里已有另一个作业时仍然响亮失败——
    // 调用方在自己不知道的作用域里操作，放行就是静默读到另一个作业的数据。
    const active = this.deps.rlsScope?.current();
    if (active?.engagementId != null && active.engagementId !== engagementId) {
      throw new WorkflowRejection(
        'classification_rejected',
        `当前作用域是 engagement ${active.engagementId}，与本次操作的 ${engagementId} 不符。` +
          '每个作业的操作必须在其自己的作用域内运行；不要跨作业复用同一个调用上下文',
      );
    }
  }

  capabilities(): CapabilityResolver {
    return this.deps.capabilities ?? this.defaultCapabilities();
  }

  /** 受信动作模板目录；未注入即空（模型会被告知「没有可用模板」而不是去猜）。 */
  actionTemplates(): readonly ActionTemplateBrief[] {
    return this.deps.actionTemplates?.() ?? [];
  }

  /** 懒建一次：内置解析器只读 `modelRoute`，每次调用都新建对象纯属浪费。 */
  defaultCapabilities(): CapabilityResolver {
    this.#fallbackCapabilities ??= defaultCapabilities(this.deps.modelRoute);
    return this.#fallbackCapabilities;
  }

  /** dsh 会话标识：确定性派生，使「先写库再建会话」可行（见文件头时序纪律 1）。 */
  dshSessionIdOf(workerSessionId: string): string {
    return `dsh-${workerSessionId}`;
  }

  // ───────────────────────── 事务原语 ─────────────────────────

  /**
   * 在一个事务里跑 `work`。
   *
   * `engagementId` 给出时，本事务在该作业的作用域里运行；省略时**沿用当前作用域**
   * （由控制台入口或后台循环建立）。两者都没有则为租户级——engagement 作用域的
   * 读写在 RLS 下全部落空，是 fail closed，不是越权。
   */
  async tx<T>(work: () => Promise<T>, engagementId?: string): Promise<T> {
    const scopes = this.deps.rlsScope;
    const active = scopes?.current()?.engagementId ?? null;
    const contextEngagementId = engagementId ?? active;
    if (engagementId !== undefined) this.assertRlsEngagement(engagementId);

    const runTx = (): Promise<T> => this.#txRunner.run(
      async () => work(),
      this.deps.rlsContext === undefined || contextEngagementId === null
        ? undefined
        : async (tx) => {
            await tx.query('select pentest.set_rls_context($1, $2::uuid, $3::uuid)', [
              this.deps.rlsContext!.tenantId,
              contextEngagementId,
              null,
            ]);
          },
    );

    // 作用域尚未建立时补上，使 `work()` 内部的 `this.db.query(...)` 也落在同一作业上。
    if (scopes === undefined || this.deps.rlsContext === undefined || contextEngagementId === null) {
      return runTx();
    }
    if (active === contextEngagementId) return runTx();
    return scopes.run({ engagementId: contextEngagementId }, runTx);
  }

  /** 断言一次转移计划合法；不合法即抛。替代 `void plan` 那种把失败丢掉的写法。 */
  assertPlan(
    outcome: TransitionPlanOutcome,
  ): asserts outcome is { readonly ok: true; readonly plan: TransitionPlan } {
    if (!outcome.ok) throw new WorkflowRejection(outcome.code, outcome.message);
  }

  /**
   * 锁定 engagement 并返回当前行，**不校验期望版本**。
   *
   * 用于 **Agent 侧**动作：它们没有人类提供的 `expectedStateVersion`，
   * 因此靠行锁串行化「是否还能提交」的判定与写入本身。**必须在事务内调用**——
   * 自动提交模式下 `FOR UPDATE` 语句结束即释放。
   */
  async lockEngagementCurrent(engagementId: string): Promise<EngagementRow> {
    const r = await this.deps.txDb.query<EngagementRow>(
      `select id, status, current_status, current_phase, state_version, graph_iteration,
              active_agent_session_id, policy_epoch, scope_snapshot,
              scope_entry_profile, behavior_profile, policy_version, policy_snapshot, policy_snapshot_hash, name, archived_at, purged_at
         from pentest.engagements where id = $1::uuid for update`,
      [engagementId],
    );
    const row = r.rows[0];
    if (row === undefined) {
      throw new WorkflowRejection('classification_rejected', `engagement 不存在：${engagementId}`);
    }
    return row;
  }

  /** 锁定 engagement 并校验期望版本。返回当前行。 */
  async lockEngagement(engagementId: string, expected: number): Promise<EngagementRow> {
    const r = await this.deps.txDb.query<EngagementRow>(
      `select id, status, current_status, current_phase, state_version, graph_iteration,
              active_agent_session_id, policy_epoch, scope_snapshot,
              scope_entry_profile, behavior_profile, policy_version, policy_snapshot, policy_snapshot_hash, name, archived_at, purged_at
         from pentest.engagements where id = $1::uuid for update`,
      [engagementId],
    );
    const row = r.rows[0];
    if (row === undefined) {
      throw new WorkflowRejection('classification_rejected', `engagement 不存在：${engagementId}`);
    }
    const actual = toInt(row.state_version, 'state_version');
    if (actual !== expected) {
      // 乐观锁：两个浏览器同时点「下一阶段」时只有一个成功（§15.4）
      throw new WorkflowRejection(
        'stale_state_version',
        `状态版本不匹配：期望 ${expected}，实际 ${actual}。请刷新后重试。`,
      );
    }
    return row;
  }

  /** 写一条人工决策记录。返回其 id。 */
  async recordDecision(input: {
    engagementId: string;
    operatorId: string;
    decisionType: string;
    subjectId: string;
    decision: string;
    /** 备注，可选：缺省落空串（人类动作不要求理由）。 */
    reason?: string;
    editedPayload?: unknown;
    authContext?: unknown;
  }): Promise<string> {
    const id = this.id();
    await this.deps.txDb.query(
      `insert into pentest.human_decisions
         (id, engagement_id, operator_id, decision_type, subject_id, decision, reason, edited_payload, auth_context)
       values ($1::uuid, $2::uuid, $3, $4, $5, $6, $7, $8::jsonb, $9::jsonb)`,
      [
        id,
        input.engagementId,
        input.operatorId,
        input.decisionType,
        input.subjectId,
        input.decision,
        // 列为 NOT NULL：信封在 `reason: false` 的端点上会**丢掉**该字段，
        // 工作流必须把它归一成空串（2026-10-05 实测：abort 因为写 null 直接 500）。
        input.reason ?? '',
        input.editedPayload === undefined ? null : JSON.stringify(input.editedPayload),
        JSON.stringify(input.authContext ?? {}),
      ],
    );
    return id;
  }

  /**
   * 写入一条**已计划**的转移——状态推进的唯一写入点（2026-10-05 复核 REQ-8/AD-2/AD-3）。
   *
   * 为什么需要它：`recordTransition` 是裸 INSERT，`type` / `sessionReused` / `from_status`
   * 全靠调用方手写，而手写的后果已经进过账本——图上不存在的边（`complete` 写在
   * `waiting_human_review → report_ready` 上、`start` 写在 `auth_pending → worker_running` 上）、
   * 同一操作两处记录不一致（`state_transitions` 记 `retry`、`handoffs` 记 `advance`）、
   * 以及 `session_reused` 与分派表相反。因此：
   *
   *   - 计划必须由 `planTransition` 产出（它已做取值域、边与强制标记的校验）；
   *   - 这里**再独立复核一次**边合法性（防止手工构造的计划绕过），非法即拒绝写入；
   *   - 行的 `type` / `forced` / `sessionReused` 一律取计划字段，调用方不得手写。
   */
  async recordPlannedTransition(input: {
    readonly plan: TransitionPlan;
    /** 可选的行 id（见 `recordTransition` 的说明）。 */
    readonly id?: string;
    readonly engagementId: string;
    readonly fromPhase: string | null;
    readonly toPhase: string | null;
    readonly graphIteration: number;
    readonly fromScopeVersion: number | null;
    readonly toScopeVersion: number | null;
    readonly fromSessionId: string | null;
    readonly toSessionId: string | null;
    readonly expectedVersion: number;
    readonly humanDecisionId: string;
    readonly handoffId: string | null;
    readonly reason?: string;
  }): Promise<void> {
    const plan = input.plan;
    const runtimeMarker = (RUNTIME_MARKER_TRANSITION_TYPES as readonly string[]).includes(plan.type);
    if (runtimeMarker) {
      if (plan.fromStatus !== plan.toStatus) {
        throw new WorkflowRejection(
          'classification_rejected',
          `运行标记类转移不得改变主状态：${plan.type} ${plan.fromStatus} → ${plan.toStatus}（§5.1）`,
        );
      }
    } else if (!isLegalStatusEdge(plan.type, plan.fromStatus, plan.toStatus)) {
      throw new WorkflowRejection(
        'classification_rejected',
        `账本拒绝写入图上不存在的边：${plan.type} ${plan.fromStatus} → ${plan.toStatus}。` +
          '状态迁移必须经 planTransition 产出的计划（2026-10-05 复核 REQ-8）',
      );
    }
    await this.#recordTransition({
      ...(input.id === undefined ? {} : { id: input.id }),
      engagementId: input.engagementId,
      fromPhase: input.fromPhase,
      toPhase: input.toPhase,
      fromStatus: plan.fromStatus,
      toStatus: plan.toStatus,
      type: plan.type,
      forced: plan.forced,
      // 会话处置取**分派表算出的**值：手写 `true` 曾是账本与分派表相反的来源（AD-3）。
      sessionReused: plan.sessionReused,
      graphIteration: input.graphIteration,
      fromScopeVersion: input.fromScopeVersion,
      toScopeVersion: input.toScopeVersion,
      fromSessionId: input.fromSessionId,
      toSessionId: input.toSessionId,
      expectedVersion: input.expectedVersion,
      humanDecisionId: input.humanDecisionId,
      handoffId: input.handoffId,
      ...(input.reason === undefined ? {} : { reason: input.reason }),
    });
  }

  /**
   * 裸写入：**只允许** `recordPlannedTransition` 调用（私有即封死旁路）。
   *
   * 它不做任何校验，行字段全凭入参——这正是历史上账本出现图上不存在边的原因。
   * `UNIQUE (engagement_id, resulting_version)` 是并发保护的一部分。
   */
  async #recordTransition(input: {
    /**
     * 行 id。可由调用方预生成：范围确认那条路径要在写 `worker_sessions.transition_id`
     * 时引用同一个 id（会话行与迁移行互相引用，预生成 uuid 是打破这个环的方式）。
     * 省略即用数据库默认值。
     */
    id?: string;
    engagementId: string;
    fromPhase: string | null;
    toPhase: string | null;
    fromStatus: MainStatus;
    toStatus: MainStatus;
    type: TransitionType;
    forced: boolean;
    sessionReused: boolean;
    graphIteration: number;
    fromScopeVersion: number | null;
    toScopeVersion: number | null;
    fromSessionId: string | null;
    toSessionId: string | null;
    expectedVersion: number;
    humanDecisionId: string;
    handoffId: string | null;
    /** 备注，可选：缺省落空串（人类动作不要求理由）。 */
    reason?: string;
  }): Promise<void> {
    await this.deps.txDb.query(
      `insert into pentest.state_transitions
         (id, engagement_id, from_phase, to_phase, from_status, to_status, transition_type,
          forced, session_reused, graph_iteration, from_scope_version, to_scope_version,
          from_worker_session_id, to_worker_session_id, expected_version, resulting_version,
          human_decision_id, handoff_id, reason)
       values (coalesce($19::uuid, gen_random_uuid()), $1::uuid,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::uuid,$13::uuid,$14,$15,$16::uuid,$17::uuid,$18)`,
      [
        input.engagementId,
        input.fromPhase,
        input.toPhase,
        input.fromStatus,
        input.toStatus,
        input.type,
        input.forced,
        input.sessionReused,
        input.graphIteration,
        input.fromScopeVersion,
        input.toScopeVersion,
        input.fromSessionId,
        input.toSessionId,
        input.expectedVersion,
        input.expectedVersion + 1,
        input.humanDecisionId,
        input.handoffId,
        // 同样归一：`state_transitions.reason` 也是 NOT NULL，而信封会丢掉该字段
        // （2026-10-05 实测：终止动作在这条语句上第二次撞 500）。
        input.reason ?? '',
        input.id ?? null,
      ],
    );
  }

  /** 更新 engagement 的主状态/阶段/活动会话/迭代/策略 epoch。`status` 单独由运行标记方法改。 */
  async updateEngagement(input: {
    engagementId: string;
    expectedVersion: number;
    currentStatus?: MainStatus;
    currentPhase?: string | null;
    activeSessionId?: string | null;
    graphIteration?: number;
    policyEpoch?: number;
  }): Promise<void> {
    await this.deps.txDb.query(
      // version-bump-sanctioned:transition —— §5.4 步骤 7：转移事务内的状态版本推进。
      `update pentest.engagements
          set current_status = coalesce($3, current_status),
              current_phase = case when $4::boolean then $5 else current_phase end,
              active_agent_session_id = case when $6::boolean then $7::uuid else active_agent_session_id end,
              graph_iteration = coalesce($8, graph_iteration),
              policy_epoch = coalesce($9, policy_epoch),
              state_version = $10,
              updated_at = now()
        where id = $1::uuid and state_version = $2`,
      [
        input.engagementId,
        input.expectedVersion,
        input.currentStatus ?? null,
        input.currentPhase !== undefined,
        input.currentPhase ?? null,
        input.activeSessionId !== undefined,
        input.activeSessionId ?? null,
        input.graphIteration ?? null,
        input.policyEpoch ?? null,
        input.expectedVersion + 1,
      ],
    );
  }

  /** 追加一条领域事件到审计账本。失败即抛——审计不可用时状态不得静默推进（§15.1）。 */
  async audit(engagementId: string, workerSessionId: string | null, eventType: AppendEventInput['eventType'], payload: unknown): Promise<void> {
    await this.deps.ledger.appendEvent({
      engagementId,
      workerSessionId,
      eventType,
      sourceSystem: 'pentest-workflow',
      sourceId: `${eventType}:${this.id()}`,
      sourceSeq: 1,
      occurredAt: this.now(),
      payload,
      rawPayload: new TextEncoder().encode(JSON.stringify(payload)),
      classification: 'engagement',
      trustLevel: 'human_decision',
    } as AppendEventInput);
  }

  // ───────────────────────── 策略快照（§6.2.0.5） ─────────────────────────

  /**
   * 服务端策略展开：创建、确认、修订三条路径共用。
   *
   * 三条纪律，缺一条这里的返回值就不成立：
   *
   * 1. **范围先规范化再进入快照**（含排除项）。此前只哈希原始 `targets`，于是
   *    「只改排除项」会复用同一个内容哈希——那正是「哪些不能打」这条边界的判别力。
   * 2. **存的就是哈希过的对象**：`policySnapshot` 与 `policyContentHash(policySnapshot)`
   *    必须一致，否则事后无法复核快照有没有被改过。
   * 3. **未知覆盖键一律拒绝**：静默忽略会让调用方以为它生效了（§10.2.1 的同一纪律）。
   */
  expandPolicy(input: {
    readonly scopeEntryProfile: ScopeEntryProfile;
    readonly behaviorProfile: BehaviorProfile;
    readonly approvalMode: ApprovalMode;
    readonly policyOverrides: Readonly<Record<string, unknown>>;
    readonly targets: readonly ScopeTarget[];
    readonly exclusions: readonly ScopeTarget[];
    readonly constraints: Readonly<Record<string, unknown>>;
    /** 修订路径：以当前快照为基础，只替换范围部分（保留人类此前的选择）。 */
    readonly base?: Readonly<Record<string, unknown>>;
  }): {
    readonly scope: NormalizedScope;
    readonly scopeEntryProfile: ScopeEntryProfile;
    readonly behaviorProfile: BehaviorProfile;
    readonly policySnapshot: Readonly<Record<string, unknown>>;
    readonly policyHash: string;
  } {
    if (!(SCOPE_ENTRY_PROFILES as readonly string[]).includes(input.scopeEntryProfile)) {
      throw new WorkflowRejection('classification_rejected', `未知范围入口：${String(input.scopeEntryProfile)}`);
    }
    if (!(BEHAVIOR_PROFILES as readonly string[]).includes(input.behaviorProfile)) {
      throw new WorkflowRejection('classification_rejected', `未知行为预设：${String(input.behaviorProfile)}`);
    }
    const unknown = unknownPolicyOverrideKeys(input.policyOverrides);
    if (unknown.length > 0) {
      throw new WorkflowRejection(
        'classification_rejected',
        `策略覆盖含未声明的键：${unknown.join(', ')}。未声明的键一律拒绝，静默忽略会让调用方以为它生效了。`,
      );
    }
    const normalized = normalizeScope({ targets: input.targets, exclusions: input.exclusions });
    if (!normalized.ok) {
      throw new WorkflowRejection('classification_rejected', `${normalized.code}：${normalized.detail}`);
    }
    const scope = normalized.value;

    if (input.base !== undefined) {
      // 只替换范围与本次修订涉及的约束：预设、pacing、动作集合、停止条件都保持
      // 人类当初确认的那一份，因此修订后的快照与上一个版本的差异**仅限边界本身**。
      const previousConstraints = asPlainRecord(input.base['execution_constraints']);
      if (previousConstraints === undefined) {
        // 重建一份形状相近的快照会让「人类批准过的策略」在无人察觉时被改掉。
        // 宁可拒绝，也不要静默换一份策略。
        throw new WorkflowRejection(
          'stale_state_version',
          '当前策略快照缺少 execution_constraints，无法在不丢失原有约束的前提下修订范围',
        );
      }
      const policySnapshot = {
        ...input.base,
        execution_constraints: { ...previousConstraints, ...input.constraints },
        normalized_scope: { targets: scope.targets, exclusions: scope.exclusions },
      };
      return {
        scope,
        scopeEntryProfile: input.scopeEntryProfile,
        behaviorProfile: input.behaviorProfile,
        policySnapshot,
        policyHash: policyContentHash(policySnapshot),
      };
    }

    let expanded: ExpandedBehaviorProfile;
    try {
      expanded = expandBehaviorProfile({
        scopeEntry: input.scopeEntryProfile,
        behaviorProfile: input.behaviorProfile,
        approvalMode: input.approvalMode,
        normalizedTargets: scope.targets,
        normalizedExclusions: scope.exclusions,
        targets: input.targets,
        exclusions: input.exclusions,
        overrides: input.policyOverrides,
        constraints: input.constraints,
      });
    } catch (error) {
      throw new WorkflowRejection(
        'classification_rejected',
        `策略展开失败：${error instanceof Error ? error.message : String(error)}`,
      );
    }
    return {
      scope,
      scopeEntryProfile: input.scopeEntryProfile,
      behaviorProfile: input.behaviorProfile,
      policySnapshot: expanded.snapshot,
      policyHash: expanded.snapshotHash,
    };
  }

  /**
   * 确认范围提案时使用的策略展开（§6.2.0.5）。
   *
   * **预览与确认共用它**，这是「预览不说谎」的唯一保证：两边各自拼一份参数迟早会漂移，
   * 而漂移的表现是「预览里的哈希 ≠ 确认后写的哈希」——那等于让人确认了一件没发生的事。
   */
  expandForConfirmation(input: {
    readonly scopeEntryProfile: ScopeEntryProfile;
    readonly behaviorProfile: BehaviorProfile;
    readonly approvalMode: ApprovalMode;
    readonly policyOverrides: Readonly<Record<string, unknown>>;
    readonly allowedActions: readonly ActionClass[];
    readonly targets: readonly ScopeTarget[];
    readonly exclusions: readonly ScopeTarget[];
    readonly authorizationNote: string;
    readonly authorizationExpiresAt: string;
    readonly roe: Readonly<Record<string, unknown>>;
    readonly timeWindow: Readonly<Record<string, unknown>>;
  }): ConfirmationExpansion {
    return this.expandPolicy({
      scopeEntryProfile: input.scopeEntryProfile,
      behaviorProfile: input.behaviorProfile,
      approvalMode: input.approvalMode,
      policyOverrides: {
        ...input.policyOverrides,
        // **不要把「允许的类别」当成「逐次放行的类别」。**
        //
        // 这里曾经写成 `perActionApprovalClasses: [...input.allowedActions]`，后果是：
        // 人类勾了 `passive_collection` + `active_probing`（都是低风险类），冻结出来的策略
        // 就要求**每一次动作都人工放行**——实战里每个 HTTP GET 都要人点一次，作业根本跑不动。
        //
        // §10.3 的分级表才是逐次放行的**下界与正解**：契约基线（利用验证、横向移动）、
        // 认证读取，以及默认禁用类别被开启后的每一次动作。这些由展开器自己算
        // （见 `expandBehaviorProfile` 的 `perActionApprovalClasses` 组装），本处不再注入。
      },
      targets: input.targets,
      exclusions: input.exclusions,
      constraints: {
        authorizationRef: input.authorizationNote,
        authorizationExpiresAt: input.authorizationExpiresAt,
        roe: input.roe,
        timeWindow: input.timeWindow,
        budget: null,
        credential_mode: 'none',
      },
    });
  }

  /**
   * 下一个策略版本号（**只读路径**）。
   *
   * 预览在事务外运行：它读的是当前投影，不该借写连接——那会平白占用独占连接，
   * 也让「只读预览」与「写事务」在同一连接上交错。
   */
  async nextPolicyVersionReadOnly(engagementId: string): Promise<number> {
    const result = await this.deps.db.query<{ next: number | string }>(
      `select coalesce(max(version), 0) + 1 as next
         from pentest.policy_versions
        where engagement_id = $1::uuid`,
      [engagementId],
    );
    return toInt(result.rows[0]?.next ?? 1, 'policy_version');
  }

  /**
   * 下一个策略版本号（只追加：版本号从 `policy_versions` 的实际最大值推进）。 */
  async nextPolicyVersion(engagementId: string): Promise<number> {
    const result = await this.deps.txDb.query<{ next: number | string }>(
      `select coalesce(max(version), 0) + 1 as next
         from pentest.policy_versions
        where engagement_id = $1::uuid`,
      [engagementId],
    );
    return toInt(result.rows[0]?.next ?? 1, 'policy_version');
  }

  /**
   * 本作业**实际强制逐次放行**的动作类别（读冻结策略的 `action_policy.perActionApprovalClasses`）。
   *
   * 为什么必须读策略、而不是沿用调用方传来的列表：那条列表在不同调用点语义不同
   * （intake 传的是「允许的动作类别」，交接传的是「审批时的放行类别」），而**执行器只认这份策略**。
   * 用别的来源写提示词就会出现实测到的矛盾：快照写着「passive_collection 需逐次放行」，
   * 真去申请却被告知「该动作不需要人工放行」——模型据此以为自己在等审批，实际能直接跑。
   */
  async enforcedApprovalClassesOf(engagementId: string): Promise<readonly ActionClass[]> {
    const result = await this.deps.db.query<{ per_action: unknown }>(
      `select policy_snapshot -> 'action_policy' -> 'perActionApprovalClasses' as per_action
         from pentest.policy_versions
        where engagement_id = $1::uuid
        order by version desc
        limit 1`,
      [engagementId],
    );
    const raw = result.rows[0]?.per_action;
    if (!Array.isArray(raw)) return [];
    const known = new Set<string>(ACTION_CLASSES);
    return raw.filter((item): item is ActionClass => typeof item === 'string' && known.has(item));
  }

  /** 本部署可用的记忆检索通道（缺省按无向量处理：宁可少报，不谎报）。 */
  retrievalChannelsOf(): readonly string[] {
    return this.deps.retrievalChannels ?? ['lexical', 'trigram'];
  }

  /**
   * skill 目录（名字 + 描述），供会话提示词注入。
   *
   * 读不到的名字**原样保留、描述留空**：会话照常创建，只是那一行没有描述——
   * 反过来静默丢掉会让「我勾了它却没出现在快照里」变成不可解释的现象。
   */
  async skillBriefsOf(names: readonly string[]): Promise<readonly { id: string; description: string }[]> {
    if (names.length === 0) return [];
    const result = await this.deps.db.query<{ name: string; description: string }>(
      `select name, description from pentest.skills where name = any($1::text[])`,
      [names],
    );
    const described = new Map(result.rows.map((row) => [row.name, row.description]));
    return names.map((id) => ({ id, description: described.get(id) ?? '' }));
  }

  /**
   * 冻结范围的**条目**（当前版本）——只读范围视图的数据源。
   *
   * 2026-10-08 操作者实测 P2：「没有工具能读『当前生效的范围』」，于是他们靠**试错**才知道
   * CIDR 选择器不行、哪个段被放行；一次 `/16` 普查因此被拆成 283 台逐 IP，扫描预算大头花在这里。
   *
   * 只给**规范化后**的 `kind/value/protocols/ports`：那既是判定真正读取的字段，
   * 也是让人能做**数值**判断的形态——排除项与 CIDR 的包含关系是数值的，不是文本的
   * （实测那次误判：`172.0.0.0/12` 看着"覆盖" `172.16.204.0/24`，数值上并不覆盖）。
   */
  async scopeEntriesOf(
    engagementId: string,
  ): Promise<{ readonly targets: readonly ScopeTarget[]; readonly exclusions: readonly ScopeTarget[] }> {
    const toTargets = (value: unknown): readonly ScopeTarget[] =>
      Array.isArray(value)
        ? value.filter(
            (entry): entry is ScopeTarget =>
              typeof entry === 'object' &&
              entry !== null &&
              typeof (entry as ScopeTarget).kind === 'string' &&
              typeof (entry as ScopeTarget).value === 'string',
          )
        : [];
    const r = await this.deps.db.query<{ targets: unknown; exclusions: unknown }>(
      `select targets, exclusions from pentest.scope_versions
        where engagement_id = $1::uuid
        order by version desc
        limit 1`,
      [engagementId],
    );
    const row = r.rows[0];
    if (row === undefined) return { targets: [], exclusions: [] };
    return { targets: toTargets(row.targets), exclusions: toTargets(row.exclusions) };
  }

  /**
   * 该作业当前冻结的行为预设与节奏（供会话提示词注入）。
   *
   * 读最新一版策略快照。预设现在是**提示词**而不是硬闸，所以这里只取展示所需的最小事实；
   * 作业还没有确认过策略（没有 policy_versions 行）时返回 undefined——会话照常创建，
   * 只是没有这一段行为指引。
   */
  async behaviorBriefOf(engagementId: string): Promise<BehaviorBrief | undefined> {
    const result = await this.deps.db.query<{
      behavior_profile: string | null;
      pacing: unknown;
      guidance: unknown;
      approval_mode: unknown;
    }>(
      `select behavior_profile,
              policy_snapshot -> 'pacing' as pacing,
              policy_snapshot -> 'custom_guidance' as guidance,
              policy_snapshot -> 'action_policy' -> 'approval_mode' as approval_mode
         from pentest.policy_versions
        where engagement_id = $1::uuid
        order by version desc
        limit 1`,
      [engagementId],
    );
    const row = result.rows[0];
    if (row === undefined) return undefined;
    const profile = row.behavior_profile;
    if (profile !== 'stealth' && profile !== 'standard' && profile !== 'deep' && profile !== 'custom') {
      return undefined;
    }
    const raw = row.pacing;
    const pacing =
      typeof raw === 'object' && raw !== null && !Array.isArray(raw)
        ? Object.fromEntries(
            Object.entries(raw as Record<string, unknown>).filter(
              (entry): entry is [string, number] => typeof entry[1] === 'number',
            ),
          )
        : undefined;
    // 自定义指引随快照冻结：注入时原样取回（只有 custom 会有它）。
    const guidance = typeof row.guidance === 'string' && row.guidance.trim() !== '' ? row.guidance.trim() : undefined;
    // 显式收窄一次：条件展开的对象字面量会让 TS 丢掉字面量联合类型（`profile` 被放宽成 string）。
    const selected: BehaviorProfile = profile;
    // 审批模式随快照冻结；旧快照缺键即 human（保守）。
    const mode = row.approval_mode === 'auto' ? ('auto' as const) : ('human' as const);
    const brief: BehaviorBrief = {
      profile: selected,
      approvalMode: mode,
      ...(pacing === undefined ? {} : { pacing }),
      ...(guidance === undefined ? {} : { customGuidance: guidance }),
    };
    return brief;
  }

  /** 已记录的策略版本数（判断「有没有人类确认过的策略历史」）。 */
  async policyVersionCount(engagementId: string): Promise<number> {
    const result = await this.deps.txDb.query<{ n: number | string }>(
      `select count(*)::int as n from pentest.policy_versions where engagement_id = $1::uuid`,
      [engagementId],
    );
    return toInt(result.rows[0]?.n ?? 0, 'policy_version_count');
  }

  /**
   * 「现在能不能确认这份 intake 范围」的**唯一**判据：预览的 blocker 与确认的守卫共用它。
   *
   * 判据读的是**会话事实**，不是单一的主状态值：
   *   - 活动会话必须存在、属于本作业、且是 `intake` 会话；
   *   - 该会话的状态 ∈ {`active`, `waiting_human`}：`waiting_human` 是**正常**状态——
   *     intake Agent 提交报告后就把自己置为等人类，人类正是在**那一刻之后**才看到方案；
   *   - 主状态 ∈ {`auth_pending`, `waiting_human_review`}：`auth_pending` 是 §13.1
   *     「人类确认授权与范围」那条边的前置；`waiting_human_review` 是历史数据里
   *     intake 报告误推主状态留下的状态（写入点已修：报告路径现在直接拒绝 intake 会话，
   *     见 `PgWorkerTools.submitReport`），不认它等于让那些作业**永远确认不了**。
   *
   * 两处各写一份判据必然漂移——实战里已经漂移过：守卫只认 `auth_pending` +
   * 会话 `active`，而正常流程走完就是 `waiting_human_review` + `waiting_human`，
   * 于是人类点确认永远收到「当前任务没有可确认的 intake 范围」，建作业流程走不完。
   */
  async intakeConfirmBlock(input: {
    readonly engagementId: string;
    readonly currentStatus: string;
    readonly activeSessionId: string | null;
  }): Promise<{ readonly kind: 'status' | 'session'; readonly detail: string } | null> {
    const INTAKE_SESSION_STATUSES: readonly string[] = ['active', 'waiting_human'];
    const CONFIRMABLE_MAIN_STATUSES: readonly string[] = ['auth_pending', 'waiting_human_review'];
    if (input.activeSessionId === null) {
      return { kind: 'session', detail: '没有活动会话（intake 会话已被取代或关闭）' };
    }
    const intake = await this.loadSession(input.activeSessionId);
    if (
      intake === null ||
      intake.engagement_id !== input.engagementId ||
      intake.session_kind !== 'intake' ||
      !INTAKE_SESSION_STATUSES.includes(intake.status)
    ) {
      return { kind: 'session', detail: '活动 intake 会话已不可用' };
    }
    if (!CONFIRMABLE_MAIN_STATUSES.includes(input.currentStatus)) {
      return { kind: 'status', detail: `状态 ${input.currentStatus}` };
    }
    return null;
  }

  /**
   * 把 `handoff_drafting` 退回 `waiting_human_review`（§15.6 的失败回退）。
   *
   * 用 `handoff_cancel` 而不是静默改列：这是 `handoff_drafting → waiting_human_review`
   * 的那条边（§5.2 边 #7），要写转移记录并推进状态版本——否则账本上会出现
   * 「状态变了但没有对应的迁移」，那种账本是没法用来回放的。
   *
   * 回退本身失败时**不掩盖原始错误**：只记一条警告并继续抛原异常。
   * 原始错误（会话不可达、超时）才是人需要看到的；回退失败是次生问题。
   */
  async revertHandoffDrafting(
    session: SessionRow & { engagement_id: string },
    cause: unknown,
  ): Promise<void> {
    const detail = cause instanceof Error ? cause.message : String(cause);
    try {
      await this.tx(async () => {
        const engagement = await this.lockEngagementCurrent(session.engagement_id);
        // 只在仍是 `handoff_drafting` 时回退：期间可能已有人取消或状态已推进，
        // 那时再改列会覆盖掉别人的合法迁移。
        if (engagement.current_status !== 'handoff_drafting') return;

        const decisionId = await this.recordDecision({
          engagementId: session.engagement_id,
          // 这不是人类决定：草稿生成失败后由服务端回退（§15.6），
          // 因此记固定系统主体——审计里一眼能看出「没人点过这个」。
          operatorId: SYSTEM_OPERATOR_ID,
          decisionType: 'handoff_draft_failed',
          subjectId: session.id,
          decision: 'revert_to_waiting_human_review',
          reason: `交接草稿生成失败，按 §15.6 保持等待人工判断：${detail}`,
        });
        const planned = planTransition({
          type: 'handoff_cancel',
          fromStatus: 'handoff_drafting',
          toStatus: 'waiting_human_review',
        });
        this.assertPlan(planned);
        await this.recordPlannedTransition({
          plan: planned.plan,
          engagementId: session.engagement_id,
          fromPhase: session.phase,
          toPhase: session.phase,
          graphIteration: toInt(engagement.graph_iteration, 'graph_iteration'),
          fromScopeVersion: null,
          toScopeVersion: null,
          fromSessionId: session.id,
          toSessionId: session.id,
          expectedVersion: toInt(engagement.state_version, 'state_version'),
          humanDecisionId: decisionId,
          handoffId: null,
          reason: '交接草稿生成失败',
        });
        await this.updateEngagement({
          engagementId: session.engagement_id,
          expectedVersion: toInt(engagement.state_version, 'state_version'),
          currentStatus: 'waiting_human_review',
        });
        await this.audit(session.engagement_id, session.id, 'handoff.draft.failed', { detail });
      });
    } catch (revertError) {
      // 回退失败不掩盖原始错误——见本方法的说明。
      //
      // 打到 console 而不是某个 logger：本模块没有日志设施，而 `compose.ts` 对同类
      // 「装配/回退期的次生失败」也用 console.warn（宿主的环境里那是可见的出口）。
      // 静默吞掉更糟：那会让人以为状态已经退回去了。
      console.warn(
        `[dsh-pentest] 交接草稿失败后的状态回退也失败了（engagement ${session.engagement_id}）：` +
          `${revertError instanceof Error ? revertError.message : String(revertError)}。` +
          'engagement 可能停在 handoff_drafting，需要人工 cancelHandoff。',
      );
    }
  }

  /**
   * 运行标记变更的公共实现（§5.1：只改标记，**不改主状态**、不吊销租约）。
   *
   * 参数从 `HumanPause | HumanAbort` 泛化成「一个做事的主体」，因为系统暂停
   * （§10.2.2 / §10.5）走同一条路径但主体不是人。`decisionType` 也由调用方给：
   * 审计要能区分「人按暂停」与「系统因阈值暂停」。
   */
  async setRunMarker(
    input: {
      readonly engagementId: string;
      readonly operatorId: string;
      readonly expectedStateVersion: number;
      /** 备注，可选：缺省落空串。 */
      readonly reason?: string;
    },
    type: 'pause' | 'abort',
    marker: RunMarker,
    decisionType: string = type,
  ): Promise<WorkflowSnapshot> {
    await this.tx(async () => {
      const row = await this.lockEngagement(input.engagementId, input.expectedStateVersion);
      // 前置：运行标记可用性的**单源判定**在契约层（`runActionAvailability`），
      // 客户端按同一函数禁用按钮。此前只有客户端挡、服务端不挡，实测后果是
      // 「终止 → 暂停 → 恢复」能把已终结的作业复活成僵尸（见契约里的说明）。
      const availability = runActionAvailability({
        mainStatus: row.current_status,
        runMarker: row.status,
        activeWorkerSessionId: row.active_agent_session_id,
      });
      if (type === 'pause' && !availability.canPause) {
        throw new WorkflowRejection('classification_rejected', runMarkerRejection('pause', row));
      }
      if (type === 'abort' && !availability.canAbort) {
        throw new WorkflowRejection('classification_rejected', runMarkerRejection('abort', row));
      }
      const planned = planTransition({ type, fromStatus: row.current_status, toStatus: row.current_status });
      this.assertPlan(planned);

      const decisionId = await this.recordDecision({
        engagementId: input.engagementId,
        operatorId: input.operatorId,
        decisionType,
        subjectId: row.active_agent_session_id ?? 'none',
        decision: marker,
        reason: input.reason,
      });
      await this.recordPlannedTransition({
        plan: planned.plan,
        engagementId: input.engagementId,
        fromPhase: row.current_phase,
        toPhase: row.current_phase,
        graphIteration: toInt(row.graph_iteration, 'graph_iteration'),
        fromScopeVersion: null,
        toScopeVersion: null,
        fromSessionId: row.active_agent_session_id,
        toSessionId: row.active_agent_session_id,
        expectedVersion: input.expectedStateVersion,
        humanDecisionId: decisionId,
        handoffId: null,
        reason: input.reason,
      });
      // 运行标记与主状态分列：current_status 保持不变
      await this.deps.txDb.query(
        // version-bump-sanctioned:transition —— 与同一事务里的 `pause` / `abort` 转移行成对。
        `update pentest.engagements set status = $2, state_version = $3, updated_at = now()
          where id = $1::uuid`,
        [input.engagementId, marker, input.expectedStateVersion + 1],
      );
      if (type === 'abort') {
        // 终止是**整体**的。过去只处理 `active_agent_session_id` 那一个会话，于是
        // 「等待人工判断」的 worker 与 intake 会话会以非终态留在库里，清空被
        // 「仍有 N 个未终结的会话」**永久**拦住（2026-10-05 实测：人类怎么点都清不掉，
        // 而且界面上没有任何按钮能结束这些会话）。这里把所有非终态会话一并结束，
        // 逐个吊销租约——与 handoff / intake 流程对自己会话的处理保持一致。
        const live = await this.deps.txDb.query<{ id: string }>(
          `select id from pentest.worker_sessions
            where engagement_id = $1::uuid and not (status = any($2::text[]))
            order by created_at`,
          [input.engagementId, [...TERMINAL_SESSION_STATUSES]],
        );
        for (const session of live.rows) {
          await applySessionStatusChange(this.deps.leases, {
            workerSessionId: session.id,
            status: 'closed',
            now: this.now(),
          });
          await this.deps.txDb.query(
            `update pentest.worker_sessions set status = 'closed', ended_at = now() where id = $1::uuid`,
            [session.id],
          );
        }
        // 会话落了终态，租约却可能还是**有效**的（正常收尾只关会话、不吊销租约）。
        // 这种死凭证会拦住清空（「仍有 N 份有效租约：等它过期或先吊销」，界面上没有吊销按钮）。
        // 终止是人类的「此事到此为止」，所以把该作业下所有未吊销未过期的租约一并吊销。
        const validLeases = await this.deps.txDb.query<{ worker_session_id: string }>(
          `select worker_session_id from pentest.session_leases
            where engagement_id = $1::uuid and revoked_at is null and expires_at > now()`,
          [input.engagementId],
        );
        for (const lease of validLeases.rows) {
          await applySessionStatusChange(this.deps.leases, {
            workerSessionId: lease.worker_session_id,
            status: 'closed',
            now: this.now(),
          });
        }
      }
    });
    return this.getState(input.engagementId);
  }

  /**
   * 放行决策的**送达**（§10.3 验收：会话运行中按插话路径送达、等待中唤醒送达）。
   *
   * ── 为什么它是必需品，而不是贴心提示 ──
   *
   * Agent 提交放行申请后就结束了自己的回合（它不能一直挂着等）。人类批准时若不唤醒它，
   * 作业就停在那里不动——「点了批准没反应」是实战里最容易被误判成「插件坏了」的现象。
   * 撤销同理：它手里可能正攥着这张凭证。
   *
   * ── 事务已经提交 ──
   *
   * 凭证此刻起已生效/失效，**与通知是否成功无关**。因此通知失败既不回滚、也不把结果
   * 包装成「批准失败」，只记一条 `tool.approval.notice_failed` 审计：人类据此决定是否
   * 用「插话」手动唤醒。会话已关闭时不投递（设计原话：会话失效时凭证失效且不投递）。
   */
  async deliverApprovalNotice(
    engagementId: string,
    record: ApprovalRecord,
    reason: string,
  ): Promise<boolean> {
    // 无需投递的情形（没有会话 / 会话已关闭）算"不必送达"，返回 true——
    // 只有**尝试过且失败**才返回 false，界面据此告警。
    if (record.workerSessionId === '') return true;
    const session = await this.loadSession(record.workerSessionId).catch(() => null);
    if (session === null || session.status === 'closed') return true;
    const head =
      record.decision === 'approved'
        ? `【动作放行已批准】approval_id=${record.id}（${record.actionClass}）`
        : record.decision === 'revoked'
          ? `【动作放行已被撤销】approval_id=${record.id}（${record.actionClass}）`
          : `【动作放行被驳回】approval_id=${record.id}（${record.actionClass}）`;
    const tail =
      record.decision === 'approved'
        ? `现在可以带这个 approval_id 调用 ${EXEC_TOOL_NAME} 执行申请过的那条命令；执行会消费这张凭证，同一条命令不会执行第二次。`
        : `人类补充：${(reason ?? '').trim() === '' ? '（未填写）' : reason}。不要重试同一动作；要继续，先向人类说明新的方案。`;
    try {
      await this.deps.sessions.deliver(session.dsh_session_id, `${head}。${tail}`);
      await this.audit(engagementId, session.id, 'tool.approval.notified', {
        approvalId: record.id,
        decision: record.decision,
      });
      return true;
    } catch (error) {
      await this.audit(engagementId, session.id, 'tool.approval.notice_failed', {
        approvalId: record.id,
        decision: record.decision,
        error: error instanceof Error ? error.message : String(error),
      }).catch(() => undefined);
      return false;
    }
  }

  /**
   * 人类放行决策的**唯一入口**。
   *
   * 放行决策是状态写入，因此与其它状态写入同处一条路径：policy 服务保持只读，
   * 避免「只有人类可放行」失去统一入口与审计锚点（§4.2 末段）。
   */
  async resolveApproval(
    approvalId: string,
    operatorId: string,
    decision: 'approved' | 'rejected' | 'revoked',
    reason: string,
    modifiedCommandPlan?: unknown,
  ): Promise<{ readonly record: ApprovalRecord; readonly engagementId: string }> {
    return this.tx(async () => {
      const engagementLock = await this.deps.txDb.query<{ id: string }>(
        `select id from pentest.engagements where id = (select engagement_id from pentest.approvals where id = $1::uuid) for update`,
        [approvalId],
      );
      if (engagementLock.rows[0] === undefined) {
        throw new WorkflowRejection('classification_rejected', `放行记录不存在：${approvalId}`);
      }
      const r = await this.deps.txDb.query<{
        id: string; engagement_id: string; requested_by_worker: string | null;
        action_class: ActionClass; plan_hash: string; lease_generation: number | string | null;
        decision: string; expires_at: string | null; consumed_at: string | null;
        command_plan: unknown; target_snapshot: unknown; risk_summary: string | null;
      }>(
        `select id, engagement_id, requested_by_worker, action_class, plan_hash, lease_generation,
                decision, expires_at, consumed_at, command_plan, target_snapshot, risk_summary
           from pentest.approvals where id = $1::uuid for update`,
        [approvalId],
      );
      const row = r.rows[0];
      if (row === undefined) {
        throw new WorkflowRejection('classification_rejected', `放行记录不存在：${approvalId}`);
      }
      if (row.consumed_at !== null) {
        throw new WorkflowRejection('approval_consumed', '该放行凭证已被消费，不能再次决策');
      }
      if (row.expires_at !== null && new Date(row.expires_at).getTime() <= this.now().getTime()) {
        throw new WorkflowRejection('approval_expired', `放行记录已过期：${approvalId}`);
      }
      // 撤回一张**尚未消费**的已批准凭证：这是人类对自己刚放行、Agent 还没用的
      // 凭证唯一的补救通道（§10.3.1「放行队列可撤销」）。其它非 pending 状态
      // 一律拒绝；已消费由上面的 `consumed_at` 闸先行拦截。
      const revokingApproved =
        decision === 'revoked' && row.decision === 'approved' && row.consumed_at === null;
      if (row.decision !== 'pending' && !revokingApproved) {
        throw new WorkflowRejection(
          'classification_rejected',
          `该放行已被处理过（${row.decision}）；修改请生成新的放行记录`,
        );
      }

      if (modifiedCommandPlan !== undefined) {
        if (decision !== 'approved' || this.deps.approvalPlanValidator === undefined) {
          throw new WorkflowRejection('classification_rejected', '修改审批计划必须由受信验证器验证，且只能随 approved 提交');
        }
        const originalPlan = asRecord(row.command_plan);
        const validated = await this.deps.approvalPlanValidator.validate(
          {
            approvalId: row.id,
            engagementId: row.engagement_id,
            workerSessionId: row.requested_by_worker,
            actionClass: row.action_class,
            originalPlanHash: row.plan_hash,
            originalCommandPlan: row.command_plan,
            originalTargetSnapshot: row.target_snapshot,
            scopeVersion: readNumber(originalPlan, 'scope_version'),
            policyEpoch: readNumber(originalPlan, 'policy_epoch'),
            leaseGeneration: row.lease_generation === null ? null : toInt(row.lease_generation, 'lease_generation'),
          },
          modifiedCommandPlan,
        );
        if (validated === undefined || validated.actionClass !== row.action_class) {
          throw new WorkflowRejection('classification_rejected', '修改审批计划未通过服务端模板、范围或绑定校验');
        }
        const inserted = await this.deps.txDb.query<{ id: string; expires_at: string | null }>(
          `insert into pentest.approvals
             (engagement_id, requested_by_worker, action_class, target_snapshot, command_plan,
              plan_hash, risk_summary, decision, lease_generation, expires_at)
           values ($1::uuid, $2::uuid, $3, $4::jsonb, $5::jsonb, $6, $7, 'pending', $8::integer, $9)
           returning id, expires_at`,
          [
            row.engagement_id, row.requested_by_worker, validated.actionClass,
            JSON.stringify(validated.targetSnapshot), JSON.stringify({
              template_id: validated.templateId, target_selector: validated.targetSelector, params: validated.params,
              normalized_target: validated.normalizedTarget, normalized_command: validated.normalizedCommand,
              scope_version: validated.scopeVersion, policy_epoch: validated.policyEpoch,
              lease_generation: validated.leaseGeneration, timeout_ms: validated.timeoutMs,
              max_output_bytes: validated.maxOutputBytes, purpose: validated.purpose,
            }), validated.planHash, validated.riskSummary, validated.leaseGeneration, row.expires_at,
          ],
        );
        const replacement = inserted.rows[0];
        if (replacement === undefined) throw new Error('修改审批计划插入未返回 id');
        await this.recordDecision({
          engagementId: row.engagement_id, operatorId, decisionType: 'approval_plan_modified',
          subjectId: row.id, decision: 'approved', reason,
          editedPayload: { before: row.command_plan, after: validated, replacementApprovalId: replacement.id },
        });
        await this.deps.txDb.query(
          `select pentest.supersede_approval($1::uuid, $2::uuid, $3, $4)`,
          [row.id, replacement.id, operatorId, reason],
        );
        // The replacement is created as pending because the insert guard forbids
        // forged decisions. Resolve it through the same protected human resolver
        // before returning: modified-and-approved means the new credential is usable.
        await this.deps.txDb.query(
          `select pentest.resolve_approval($1::uuid, 'approved', $2, $3)`,
          [replacement.id, operatorId, reason],
        );
        await this.audit(row.engagement_id, row.requested_by_worker, 'tool.approval.resolved', {
          approvalId: row.id, decision: 'superseded', replacementApprovalId: replacement.id,
          replacementDecision: 'approved',
        });
        return {
          engagementId: row.engagement_id,
          record: {
            id: replacement.id, workerSessionId: row.requested_by_worker ?? '',
            actionClass: validated.actionClass, planHash: validated.planHash,
            leaseGeneration: validated.leaseGeneration, decision: 'approved',
            expiresAt: replacement.expires_at === null ? new Date(0) : new Date(replacement.expires_at),
            consumedAt: null,
          },
        };
      }

      await this.recordDecision({
        engagementId: row.engagement_id,
        operatorId,
        decisionType: 'approval',
        subjectId: approvalId,
        decision,
        reason,
      });

      await this.deps.txDb.query(
        `select pentest.resolve_approval($1::uuid, $2, $3, $4)`,
        [approvalId, decision, operatorId, reason],
      );
      await this.audit(row.engagement_id, row.requested_by_worker, 'tool.approval.resolved', {
        approvalId,
        decision,
      });

      return {
        engagementId: row.engagement_id,
        record: {
          id: row.id,
          workerSessionId: row.requested_by_worker ?? '',
          actionClass: row.action_class,
          planHash: row.plan_hash,
          leaseGeneration: row.lease_generation === null ? null : toInt(row.lease_generation, 'lease_generation'),
          decision,
          expiresAt: row.expires_at === null ? new Date(0) : new Date(row.expires_at),
          consumedAt: null,
        },
      };
    });
  }

  // ───────────────────────── 内部辅助 ─────────────────────────

  async loadEngagement(engagementId: string): Promise<EngagementRow> {
    const r = await this.deps.db.query<EngagementRow>(
      `select id, status, current_status, current_phase, state_version, graph_iteration,
              active_agent_session_id, policy_epoch, scope_snapshot,
              scope_entry_profile, behavior_profile, policy_version, policy_snapshot, policy_snapshot_hash, name, archived_at, purged_at
         from pentest.engagements where id = $1::uuid`,
      [engagementId],
    );
    const row = r.rows[0];
    if (row === undefined) throw new WorkflowRejection('classification_rejected', `engagement 不存在：${engagementId}`);
    return row;
  }

  /** 作业名：卡片上要写清「哪个作业在等你」，否则人类得自己去比对。 */
  async engagementName(engagementId: string): Promise<string | null> {
    const result = await this.deps.db.query<{ name: string }>(
      `select name from pentest.engagements where id = $1::uuid`,
      [engagementId],
    ).catch(() => ({ rows: [] as { name: string }[] }));
    return result.rows[0]?.name ?? null;
  }

  async stateVersion(engagementId: string): Promise<number> {
    return toInt((await this.loadEngagement(engagementId)).state_version, 'state_version');
  }

  async loadSession(workerSessionId: string): Promise<(SessionRow & { engagement_id: string }) | null> {
    const r = await this.deps.db.query<SessionRow & { engagement_id: string }>(
      `select id, engagement_id, dsh_session_id, phase, status, session_kind, attempt, iteration, scope_version, task_prompt
         from pentest.worker_sessions where id = $1::uuid`,
      [workerSessionId],
    );
    return r.rows[0] ?? null;
  }

  async loadHandoff(draftId: string): Promise<{
    readonly engagement_id: string;
    readonly from_worker_session_id: string;
    readonly draft_json: unknown;
  } | null> {
    const r = await this.deps.db.query<{
      engagement_id: string;
      from_worker_session_id: string;
      draft_json: unknown;
    }>(
      `select engagement_id, from_worker_session_id, draft_json
         from pentest.handoffs where id = $1::uuid`,
      [draftId],
    );
    return r.rows[0] ?? null;
  }

  /**
   * 读某个会话当前生效的租约。
   *
   * `session_leases` 没有任何租户级放行（015 拆掉了 013 的那条），因此「知道会话 id、
   * 还不知道 engagement」的路径必须先经受约束的反查拿到 engagement，再带上上下文读。
   * 否则在 FORCE RLS 下这里恒为零行——失败表现是「租约不可用」，
   * 而真实原因是上下文没设，两者极难区分。
   *
   * 未配置 RLS 上下文的部署（本地与集成测试）直连读：那种连接上策略不构成约束。
   */
  async activeLeaseOf(workerSessionId: string): Promise<{ readonly id: string; readonly generation: number } | null> {
    const sql = `select id, generation from pentest.session_leases
                  where worker_session_id = $1::uuid and revoked_at is null and expires_at > now()
                  order by generation desc limit 1`;
    type LeaseRow = { readonly id: string; readonly generation: number | string };

    const rls = this.deps.rlsContext;
    let result: { readonly rows: readonly LeaseRow[]; readonly rowCount: number | null };
    if (rls === undefined) {
      result = await this.deps.db.query<LeaseRow>(sql, [workerSessionId]);
    } else {
      const lookup = await this.deps.db.query<{ engagement_id: string | null }>(
        `select pentest.engagement_for_worker_session($1::uuid) as engagement_id`,
        [workerSessionId],
      );
      const engagementId = lookup.rows[0]?.engagement_id ?? null;
      if (engagementId === null) return null;
      const rlsDb = this.deps.db as Partial<RlsAwareDbClient>;
      const context: DbRlsContext = { tenantId: rls.tenantId, engagementId, workerSessionId };
      result = typeof rlsDb.queryWithRlsContext === 'function'
        ? await rlsDb.queryWithRlsContext<LeaseRow>(context, sql, [workerSessionId])
        : await this.deps.db.query<LeaseRow>(sql, [workerSessionId]);
    }
    const row = result.rows[0];
    return row === undefined ? null : { id: row.id, generation: toInt(row.generation, 'lease_generation') };
  }

  async proposalForUpdate(engagementId: string, proposalId: string): Promise<ScopeProposalRow | null> {
    const result = await this.deps.txDb.query<ScopeProposalRow>(
      `select id, engagement_id, worker_session_id, objective, proposed_targets,
              proposed_exclusions, proposed_allowed_actions, authorization_note, status,
              created_at, decided_at
         from pentest.scope_intake_proposals
        where id = $1::uuid and engagement_id = $2::uuid
        for update`,
      [proposalId, engagementId],
    );
    return result.rows[0] ?? null;
  }

  /**
   * 读公共记忆正文。
   *
   * 单独一个私有方法而不是复用公开的 `getEngagementMemory`：后者会抛「engagement 不存在」，
   * 而这三处调用点都在**已经确认** engagement 存在的路径上，多一次存在性判断只是噪音。
   */
  async publicMemoryOf(engagementId: string): Promise<string> {
    const r = await this.deps.db.query<{ public_memory: string | null }>(
      `select public_memory from pentest.engagements where id = $1::uuid`,
      [engagementId],
    );
    // 列是 NOT NULL DEFAULT ''；null 只可能来自迁移前的旧行，一律当空串。
    return r.rows[0]?.public_memory ?? '';
  }

  async currentScopeVersion(engagementId: string): Promise<number> {
    const r = await this.deps.db.query<{ v: number | string | null }>(
      `select max(version) as v from pentest.scope_versions where engagement_id = $1::uuid`,
      [engagementId],
    );
    return toInt(r.rows[0]?.v ?? 0, 'scope_version');
  }

  async boundScopeVersion(engagementId: string): Promise<{ version: number; includedAssetIds: Set<string> } | null> {
    const version = await this.currentScopeVersion(engagementId);
    if (version === 0) return null;
    const r = await this.deps.db.query<{ asset_id: string }>(
      `select asset_id from pentest.asset_scope_versions
        where engagement_id = $1::uuid and scope_version = $2 and decision = 'included'`,
      [engagementId, version],
    );
    return { version, includedAssetIds: new Set(r.rows.map((x) => x.asset_id)) };
  }

  async insertWorkerSession(input: {
    id: string;
    engagementId: string;
    dshSessionId: string;
    sessionKind?: SessionKind;
    phase: Phase;
    caps: { profileId: string; profileRevision: string; modelRoute: { provider: string; model: string } };
    skillIds: readonly string[];
    toolAllow: readonly string[];
    taskPrompt: string;
    scopeVersion: number;
    iteration: number;
    budget?: BudgetLimits;
    previousAgentSessionId?: string | null;
    retryOfSessionId?: string | null;
    transitionId?: string | null;
    handoffId?: string | null;
  }): Promise<void> {
    const budget: BudgetLimits = input.budget ?? {
      maxTokens: DEFAULTS.budgetMaxTokens,
      maxSteps: DEFAULTS.budgetMaxSteps,
      maxSeconds: DEFAULTS.budgetMaxSeconds,
    };
    const skillFreeze = await this.#freezeSkills(input.skillIds);
    await this.deps.txDb.query(
      `insert into pentest.worker_sessions
         (id, engagement_id, dsh_session_id, previous_agent_session_id, retry_of_session_id,
          transition_id, phase, profile_id, profile_revision, attempt, iteration, scope_version,
          task_prompt, handoff_id, tool_filter, skill_ids, skill_freeze, model_route, status,
          session_kind, budget_max_tokens, budget_max_steps, budget_max_seconds)
       values ($1::uuid,$2::uuid,$3,$4::uuid,$5::uuid,$6::uuid,$7,$8,$9,1,$10,$11,$12,
               $13::uuid,$14::jsonb,$15::jsonb,$16::jsonb,$21::jsonb,'starting',$17,$18,$19,$20)`,
      [
        input.id,
        input.engagementId,
        input.dshSessionId,
        input.previousAgentSessionId ?? null,
        input.retryOfSessionId ?? null,
        input.transitionId ?? null,
        input.phase,
        input.caps.profileId,
        input.caps.profileRevision,
        input.iteration,
        input.scopeVersion,
        input.taskPrompt,
        input.handoffId ?? null,
        JSON.stringify({ allow: input.toolAllow }),
        JSON.stringify(input.skillIds),
        JSON.stringify(input.caps.modelRoute),
        input.sessionKind ?? 'phase',
        budget.maxTokens,
        budget.maxSteps,
        budget.maxSeconds,
        JSON.stringify(skillFreeze),
      ],
    );
  }

  /**
   * 冻结装载集合的**内容**（事故 2026-10-05：只冻名字，正文可在会话运行中被换掉）。
   *
   * 名单里每个名字都必须有一条冻结记录：库里缺行时写 `revision/contentHash = null`，
   * 读取侧据此**拒绝**，而不是把「名字在集合里」当成「拿得到正文」。
   * 冻结的是内容身份（revision + hash），启停不写入：读取侧按当前状态判定——
   * 停用即拒绝，恢复启用且内容未变时可再加载。
   */
  async #freezeSkills(names: readonly string[]): Promise<readonly SkillFreezeEntry[]> {
    if (names.length === 0) return [];
    const rows = await this.deps.txDb.query<{
      name: string; revision: number | string; content_hash: string;
    }>(
      `select name, revision, content_hash from pentest.skills where name = any($1::text[])`,
      [names],
    );
    const byName = new Map(rows.rows.map((row) => [row.name, row]));
    return names.map((name) => {
      const row = byName.get(name);
      return row === undefined
        ? { name, revision: null, contentHash: null }
        : { name, revision: toInt(row.revision, 'skills.revision'), contentHash: row.content_hash };
    });
  }

  async insertRetrySession(engagement: EngagementRow, input: RetryRequest, sourceSessionId: string): Promise<string> {
    const phase = isPhase(engagement.current_phase) ? engagement.current_phase : 'intelligence-gathering';
    const caps = await this.capabilities().resolve(phase);
    const inherited = await this.loadSessionTooling(sourceSessionId);
    const id = this.id();
    await this.insertWorkerSession({
      id,
      engagementId: input.engagementId,
      // 血缘指针：阶段轨道靠它画「重做」边（`retry_of_session_id`）。
      retryOfSessionId: sourceSessionId,
      dshSessionId: this.dshSessionIdOf(id),
      phase,
      caps,
      skillIds: inherited.skillIds,
      toolAllow: inherited.toolAllow,
      taskPrompt: input.taskPrompt,
      scopeVersion: await this.currentScopeVersion(input.engagementId),
      iteration: toInt(engagement.graph_iteration, 'graph_iteration'),
    });
    return id;
  }

  /**
   * 重新挂回作业的最后一个非终态会话，并把它置回 `active`（§15.6 的「补充技术动作」）。
   *
   * 事故（AD-1，2026-10-05 复核）：`finishTechnicalTesting` 清空了
   * `active_agent_session_id`，而 `reopenTechnicalWork` 不写回——作业停在 `worker_running`
   * 且没有活动会话，`startWorker` / `retryWorker` / `beginHandoff` / `confirmTransition`
   * 的闸门全部不满足，承诺的「补充技术动作」永远无法开始。
   * 会话状态迁移 `waiting_human → active` 是 004 触发器允许的边。
   */
  async reopenLastSession(engagementId: string): Promise<{ readonly sessionId: string } | null> {
    const found = await this.deps.txDb.query<{ id: string; status: string }>(
      `select id, status from pentest.worker_sessions
        where engagement_id = $1::uuid
          and not (status = any($2::text[]))
        order by created_at desc
        limit 1`,
      [engagementId, [...TERMINAL_SESSION_STATUSES]],
    );
    const row = found.rows[0];
    if (row === undefined) return null;
    if (row.status !== 'active') {
      await this.deps.txDb.query(
        `update pentest.worker_sessions set status = 'active' where id = $1::uuid`,
        [row.id],
      );
    }
    return { sessionId: row.id };
  }

  /**
   * 读一个会话已冻结的工具集与 skill。
   *
   * 用于同阶段重做时**沿用**人类此前确认过的能力，而不是给出空集——
   * 空集在 dsh 里等于一个连 `pentest_exec` 都没有的会话，且不报错。
   */
  async loadSessionTooling(workerSessionId: string): Promise<{
    readonly toolAllow: readonly string[];
    readonly skillIds: readonly string[];
  }> {
    const r = await this.deps.db.query<{ tool_filter: unknown; skill_ids: unknown }>(
      `select tool_filter, skill_ids from pentest.worker_sessions where id = $1::uuid`,
      [workerSessionId],
    );
    const row = r.rows[0];
    const allow =
      row !== undefined && row.tool_filter !== null && typeof row.tool_filter === 'object'
        && 'allow' in row.tool_filter && Array.isArray((row.tool_filter as { allow: unknown }).allow)
        ? ((row.tool_filter as { allow: unknown[] }).allow.filter((x): x is string => typeof x === 'string'))
        : [];
    const skills =
      row !== undefined && Array.isArray(row.skill_ids)
        ? (row.skill_ids.filter((x): x is string => typeof x === 'string'))
        : [];
    return { toolAllow: allow, skillIds: skills };
  }

  /**
   * 提交之后创建 dsh 会话；失败则把会话行标记为 `failed` 并把 engagement 置为阻塞。
   *
   * **不吞异常**：创建失败必须可见。库里那条 `starting` 行是唯一能证明
   * 「我们意图创建过这个会话」的记录，它必须被更新成明确的失败，而不是留在
   * 半空状态让人误以为会话还活着（§17.2 的对账依据）。
   */
  async createDshSessionOrMarkFailed(input: FrozenSessionInput): Promise<void> {
    try {
      const created = await this.deps.sessions.create(input);
      // 工厂必须原样使用我们派生的 dsh 会话标识（端口契约如此规定）。
      // 不一致会导致库里指向的 id 与实际会话对不上，因此 fail loud。
      if (created.dshSessionId !== input.dshSessionId) {
        throw new SessionFactoryError(
          `会话工厂返回的 dshSessionId 与请求不一致：期望 ${input.dshSessionId}，实际 ${created.dshSessionId}`,
          { dshSessionId: created.dshSessionId },
        );
      }
      await this.deps.db.query(
        `update pentest.worker_sessions set status = 'active', started_at = now() where id = $1::uuid`,
        [input.workerSessionId],
      );
    } catch (error) {
      const detail = error instanceof SessionFactoryError ? error.message : String(error);
      await this.deps.db
        .query(
          `update pentest.worker_sessions
              set status = 'failed', status_reason = $2, ended_at = now()
            where id = $1::uuid`,
          [input.workerSessionId, `创建 dsh 会话失败：${detail}`],
        )
        .catch(() => undefined);
      await this.deps.db
        .query(
          `update pentest.engagements set status = 'blocked', updated_at = now()
            where id = $1::uuid`,
          [input.engagementId],
        )
        .catch(() => undefined);
      throw new WorkflowRejection(
        'classification_rejected',
        `创建 dsh 会话失败，engagement 已置为阻塞等待人类处置：${detail}`,
      );
    }
  }

  async deliverOrFail(dshSessionId: string, message: string, workerSessionId: string): Promise<void> {
    try {
      await this.deps.sessions.deliver(dshSessionId, message);
    } catch (error) {
      // 会话已关闭或被取代：投递失败即意味着该会话不再可用，调用方据此
      // 判定放行凭证失效（§10.3.1），而不是静默丢弃消息。
      throw new WorkflowRejection(
        'lease_revoked',
        `投递失败（会话 ${workerSessionId} 可能已关闭或被取代）：${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  /**
   * 投递失败后的处置：会话置 `failed`（吊销租约）+ 作业置 `blocked` + 记一条事件。
   *
   * ── 为什么需要它 ──
   *
   * 人类动作（插话唤醒、重做复用）是**先提交转移、再投递消息**：转移在事务里落库，
   * 投递在事务外。此前投递失败只把异常抛出去，于是库里停在「主状态 worker_running、
   * 会话 active」，而消息根本没送到——人类看到报错、界面显示运行中，两处事实相反，
   * 也没有任何补偿动作（对照 `revertHandoffDrafting` 是有显式回退的）。
   *
   * ── 为什么不回退主状态 ──
   *
   * `worker_running → waiting_human_review` 在状态图上**没有可记账的取值**
   * （那是 Agent 侧动作、`recorded: false`）。硬改列会在账本里留下读不出来的跳跃，
   * 回放时看到的状态与实际不符。因此这里走「交给人类」（§15.2）的形态：
   * 置 `blocked`，人类的出口是 `resume`（blocked → running）或 `abort`。
   *
   * ── 失败面 ──
   *
   * 本方法**不抛**：它是在错误路径上执行的补偿，掩盖原始错误（会话不可达）比补偿
   * 本身失败更糟。补偿失败只记警告——与原错误一起出现在日志里，人能看到全貌。
   */
  async markDeliveryFailure(input: {
    readonly engagementId: string;
    readonly workerSessionId: string;
    readonly detail: string;
  }): Promise<void> {
    try {
      // 会话转终态要连租约一起吊销：留着有效租约会让「谁还能提交」有第二个答案。
      await this.closeSession(input.workerSessionId, 'failed', `投递失败：${input.detail}`);
    } catch (error) {
      console.warn(
        `[dsh-pentest] 投递失败后终结会话也失败了（会话 ${input.workerSessionId}）：${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
    // 与 `createDshSessionOrMarkFailed` 同一处置形态：状态行写失败不掩盖主因（原错误由调用方抛）。
    await this.deps.db
      .query(
        `update pentest.worker_sessions
            set status = 'failed', status_reason = $2, ended_at = now()
          where id = $1::uuid`,
        [input.workerSessionId, `投递失败：${input.detail}`],
      )
      .catch(() => undefined);
    await this.deps.db
      .query(
        // **不覆盖终态标记**：人类可能在投递失败的同时按下终止（abort 是终态）。
        // 无条件写 `blocked` 会把「已终止」改成「可恢复的阻塞」——那是把人类的决定
        // 弹回去，而且 blocked 有恢复出口，等于凭空开了一条复活路径。
        `update pentest.engagements set status = 'blocked', updated_at = now()
          where id = $1::uuid and status not in ('aborted', 'failed')`,
        [input.engagementId],
      )
      .catch(() => undefined);
    try {
      await this.audit(input.engagementId, input.workerSessionId, 'workflow.delivery_failed', {
        detail: input.detail,
      });
    } catch (error) {
      console.warn(
        `[dsh-pentest] 投递失败事件未写入账本（会话 ${input.workerSessionId}）：${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  /**
   * 把一条会话收进终态并吊销它的租约（§5.1「会话状态 → 租约处置」表）。
   *
   * 两件事必须一起做：会话状态落终态、租约吊销。只做前者会留下**有效租约**——
   * 该租约仍能通过准入（表现为「已结束的会话还能提交」），终止流程里就踩过这一条
   * （2026-10-05 实测：会话已关闭、租约仍有效，清空作业被「仍有 N 份有效租约」拦住）。
   *
   * **必须在事务外调用**：租约端口用自己那条连接去锁 `worker_sessions`，
   * 嵌进调用方的事务会自锁死（与 `startWorker` 的说明同因）。
   * 幂等：已经是终态的会话再收一次不会重复吊销（租约端口按行判定）。
   */
  async closeSession(workerSessionId: string, status: 'closed' | 'failed', reason: string): Promise<void> {
    await applySessionStatusChange(this.deps.leases, {
      workerSessionId,
      status,
      now: this.now(),
    });
    await this.deps.db.query(
      // 只收**非终态**的行：并发场景下人类可能已经终止（abort 会把所有会话置 `closed`），
      // 那时把 `closed` 改写成 `failed` 是在别人的合法收尾上盖一个更糟的结论。
      `update pentest.worker_sessions
          set status = $2, status_reason = $3, ended_at = now()
        where id = $1::uuid and status not in ('closed', 'superseded', 'failed')`,
      [workerSessionId, status, reason],
    );
  }

  async getScopeProposal(engagementId: string): Promise<ScopeProposal | null> {
    const result = await this.deps.db.query<ScopeProposalRow>(
      `select id, engagement_id, worker_session_id, objective, proposed_targets,
              proposed_exclusions, proposed_allowed_actions, authorization_note, status,
              created_at, decided_at
         from pentest.scope_intake_proposals
        where engagement_id = $1::uuid and status = 'pending'
        order by created_at desc limit 1`,
      [engagementId],
    );
    const row = result.rows[0];
    return row === undefined ? null : toScopeProposal(row);
  }

  async getState(engagementId: string): Promise<WorkflowSnapshot> {
    const r = await this.deps.db.query<EngagementRow>(
      `select id, status, current_status, current_phase, state_version, graph_iteration,
              active_agent_session_id, policy_epoch, scope_snapshot,
              scope_entry_profile, behavior_profile, policy_version, policy_snapshot, policy_snapshot_hash, name, archived_at, purged_at
         from pentest.engagements where id = $1::uuid`,
      [engagementId],
    );
    const row = r.rows[0];
    if (row === undefined) {
      throw new WorkflowRejection('classification_rejected', `engagement 不存在：${engagementId}`);
    }
    const scopeVersion = await this.currentScopeVersion(engagementId);
    return {
      engagementId,
      mainStatus: row.current_status,
      runMarker: row.status,
      currentPhase: isPhase(row.current_phase) ? row.current_phase : null,
      stateVersion: toInt(row.state_version, 'state_version'),
      graphIteration: toInt(row.graph_iteration, 'graph_iteration'),
      activeWorkerSessionId: row.active_agent_session_id,
      // `max(version)` 为 0 表示还没有范围版本——显示成「尚无」而不是 `v0`：
      // v0 会被读成「有一个版本叫 v0」。
      scopeVersion: scopeVersion === 0 ? null : scopeVersion,
      authorizationExpiresAt: readAuthorizationExpiry(row.scope_snapshot),
    };
  }
}

/**
 * 运行标记前置失败时的拒绝文案：**两个正交字段都要报出来**（运行标记 + 主状态）。
 *
 * 只说「不行」会让人分不清是「已经终止了」还是「作业已签字导出」——那两者的处置
 * 完全不同（前者无事可做，后者本就不该再动）。规则本身在契约层
 * （`runActionAvailability`），这里只负责把事实讲清楚。
 */
function runMarkerRejection(
  action: 'pause' | 'abort',
  row: { readonly status: RunMarker; readonly current_status: MainStatus },
): string {
  const what = action === 'pause' ? '暂停' : '终止';
  const requirement = action === 'pause' ? '运行中（running）' : '未终止（非 aborted / failed）';
  const why =
    row.current_status === 'complete'
      ? '；作业已签字导出（complete），运行期动作不再有意义'
      : `；当前运行标记 ${row.status}、主状态 ${row.current_status}`;
  return `只有${requirement}才能${what}${why}`;
}
