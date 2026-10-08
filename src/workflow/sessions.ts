/**
 * Worker 会话的启动、重做、运行标记、插话与预算（§10.6/§5.1/§6.7/§10.5）
 *
 * 从 `pg-workflow.ts` 机械搬运（拆分目标：组合器只做装配与委托，流程各自成类）。
 * 方法体与拆分前逐字一致；共享原语经构造注入的 {@link WorkflowCore} 使用。
 */

import type { BudgetExtension, HumanAbort, HumanPause, HumanResume, Interjection, InterjectionResult, RetryRequest, StartWorkerInput, StartedWorker, SystemPauseRequest, TransitionResult, WorkflowSnapshot } from '../contracts.ts';
import { isPhase, runActionAvailability } from '../contracts.ts';
import { planTransition } from './transition-table.ts';
import { issueLease, reissueLease, revokeLease } from './lease.ts';
import { DEFAULTS } from '../contracts.ts';
import { SYSTEM_OPERATOR_ID, WorkflowRejection, toInt } from './model.ts';
import type { WorkflowCore } from './core.ts';

export class SessionFlow {
  readonly #core: WorkflowCore;

  constructor(core: WorkflowCore) {
    this.#core = core;
  }

  // ───────────────────────── 启动首个 Worker ─────────────────────────

  /**
   * 从 READY 启动首个 Worker。
   *
   * 时序：先写库（status='starting'）→ 提交 → 创建 dsh 会话 → 回写 'active'。
   */
  async startWorker(input: StartWorkerInput): Promise<StartedWorker> {
    const caps = await this.#core.capabilities().resolve(input.phase);
    // 「省略」与「显式给空数组」是两回事：前者用阶段能力的默认装载，后者是真的要空。
    // 合并成一种会让「按 Profile 默认启动」在界面上无法表达。
    const skillIds = input.skillIds ?? caps.defaultSkillIds;
    const toolAllow = input.toolAllow ?? caps.defaultToolAllow;
    const workerSessionId = this.#core.id();
    const dshSessionId = this.#core.dshSessionIdOf(workerSessionId);

    // ── 事务：加锁、校验、写库 ──
    //
    // **必须在事务内加锁**：`SELECT ... FOR UPDATE` 在自动提交模式下语句结束即释放，
    // 锁形同虚设，乐观锁校验也不再原子——两个浏览器同时点「启动」会双双通过校验。
    await this.#core.tx(async () => {
      const engagement = await this.#core.lockEngagement(input.engagementId, input.expectedStateVersion);
      if (engagement.current_status !== 'ready') {
        throw new WorkflowRejection(
          'classification_rejected',
          `只有 READY 状态可以启动首个 Worker（当前 ${engagement.current_status}）`,
        );
      }
      if (engagement.active_agent_session_id !== null) {
        throw new WorkflowRejection('lease_required', '已有活动会话；请先关闭它再启动新的');
      }
      const planned = planTransition({ type: 'start', fromStatus: 'ready', toStatus: 'worker_running' });
      this.#core.assertPlan(planned);

      const scopeVersion = await this.#core.currentScopeVersion(input.engagementId);
      const decisionId = await this.#core.recordDecision({
        engagementId: input.engagementId,
        operatorId: input.operatorId,
        decisionType: 'start_worker',
        subjectId: workerSessionId,
        decision: input.phase,
        reason: input.reason,
        editedPayload: { taskPrompt: input.taskPrompt, skillIds, toolAllow },
      });

      await this.#core.insertWorkerSession({
        id: workerSessionId,
        engagementId: input.engagementId,
        dshSessionId,
        phase: input.phase,
        caps,
        skillIds,
        toolAllow,
        taskPrompt: input.taskPrompt,
        scopeVersion,
        iteration: toInt(engagement.graph_iteration, 'graph_iteration'),
        budget: input.budget,
      });

      await this.#core.recordPlannedTransition({
        plan: planned.plan,
        engagementId: input.engagementId,
        fromPhase: null,
        toPhase: input.phase,
        graphIteration: toInt(engagement.graph_iteration, 'graph_iteration'),
        fromScopeVersion: scopeVersion,
        toScopeVersion: scopeVersion,
        fromSessionId: null,
        toSessionId: workerSessionId,
        expectedVersion: input.expectedStateVersion,
        humanDecisionId: decisionId,
        handoffId: null,
        reason: input.reason,
      });

      await this.#core.updateEngagement({
        engagementId: input.engagementId,
        expectedVersion: input.expectedStateVersion,
        currentStatus: 'worker_running',
        currentPhase: input.phase,
        activeSessionId: workerSessionId,
      });

      await this.#core.audit(input.engagementId, workerSessionId, 'worker.session.created', {
        phase: input.phase,
        dshSessionId,
      });
    });

    // ── 事务已提交。以下两步都在事务外，各有原因 ──
    //
    // 1) 租约有**独立的事务边界**（由 lease 端口管理），不能嵌进状态事务：
    //    它的 `lockWorkerSession` 会用**另一条连接**去 `SELECT ... FOR UPDATE`
    //    我们刚插入、尚未提交的那行 `worker_sessions`，于是它等我们提交、
    //    我们等它返回——**自锁死**。移植到事务外同时更符合聚合边界。
    const lease = await issueLease(this.#core.deps.leases, {
      workerSessionId,
      ttlSeconds: DEFAULTS.leaseTtlSeconds,
      now: this.#core.now(),
    });

    // 2) 创建 dsh 会话是异步副作用，同样不能进事务。
    //    若这一步失败，库里留有 status='starting' 的行——那正是 §17.2 对账的依据。
    await this.#core.createDshSessionOrMarkFailed({
      sessionKind: 'phase',
      engagementId: input.engagementId,
      workerSessionId,
      dshSessionId,
      phase: input.phase,
      profileId: caps.profileId,
      profileRevision: caps.profileRevision,
      modelRoute: caps.modelRoute,
      skillIds,
      skillBriefs: await this.#core.skillBriefsOf(skillIds),
      retrievalChannels: this.#core.retrievalChannelsOf(),
      enforcedApprovalClasses: await this.#core.enforcedApprovalClassesOf(input.engagementId),
      toolAllow,
      taskPrompt: input.taskPrompt,
      budget: input.budget,
      approvalRequired: [],
      handoffContext: null,
      actionTemplates: this.#core.actionTemplates(),
      behavior: await this.#core.behaviorBriefOf(input.engagementId),
      scope: await this.#core.scopeEntriesOf(input.engagementId, await this.#core.currentScopeVersion(input.engagementId)),
      publicMemory: await this.#core.publicMemoryOf(input.engagementId),
    });

    return {
      workerSessionId,
      dshSessionId,
      leaseId: lease.id,
      leaseGeneration: lease.generation,
    };
  }

  // ───────────────────────── Worker 自报成果 ─────────────────────────

  /**
   * 「Worker 提交报告」只有**一份实现**：`PgWorkerTools.submitReport`
   * （`src/memory/pg-worker-tools.ts`，由 `pentest_submit_report` 工具调用）。
   *
   * 这里曾有一份 `finishWorker`：语义相同但校验更少（不校验租约世代、允许 intake 提交），
   * 生产零调用、只有测试在跑——于是 `pg-workflow.test.ts` 里那批断言证明的是一条
   * 线上不会执行的路径，而两份实现的语义还在继续分叉（2026-10-05 复核 F3）。
   * 现已删除：报告准入的断言一律以生产实现为准（`pg-worker-tools.test.ts`）。
   */

  // ───────────────────────── 重做 ─────────────────────────

  /**
   * 重做：默认**复用当前会话**（保留推理链与前缀缓存），人类可勾选新建。
   *
   * 这是本设计与「每次重做都新建会话」的关键差别，也是成本差别（缓存命中
   * 与未命中相差数十倍）。因此默认复用，人类显式选择才新建。
   */
  async retryWorker(input: RetryRequest): Promise<TransitionResult> {
    // 事务内加锁：`FOR UPDATE` 在自动提交模式下语句结束即释放，锁形同虚设，
    // 乐观锁校验也不再原子（见 startWorker 的说明）。
    const staged = await this.#core.tx(async () => {
    const engagement = await this.#core.lockEngagement(input.engagementId, input.expectedStateVersion);
    if (engagement.current_status !== 'waiting_human_review') {
      throw new WorkflowRejection(
        'handoff_transition_illegal',
        `只有等待人工判断时可以重做（当前 ${engagement.current_status}）`,
      );
    }
    const planned = planTransition({
      type: 'retry',
      fromStatus: 'waiting_human_review',
      toStatus: 'worker_running',
      reuseSession: input.reuseSession,
    });
    this.#core.assertPlan(planned);

    const currentId = engagement.active_agent_session_id;
    if (currentId === null) {
      throw new WorkflowRejection('lease_required', '没有活动会话可以重做；请从控制台启动新 Worker');
    }

    const reuse = input.reuseSession;
    const decisionId = await this.#core.recordDecision({
      engagementId: input.engagementId,
      operatorId: input.operatorId,
      decisionType: 'retry',
      subjectId: currentId,
      decision: reuse ? 'reuse_session' : 'new_session',
      reason: input.reason,
      editedPayload: { taskPrompt: input.taskPrompt, contextRefs: input.contextRefs ?? [] },
    });

    let targetSessionId = currentId;
    if (!reuse) {
      // 新建会话：关闭旧会话。租约吊销在**事务外**做——见下。
      await this.#core.deps.txDb.query(
        `update pentest.worker_sessions set status = 'superseded', ended_at = now()
          where id = $1::uuid`,
        [currentId],
      );
      targetSessionId = await this.#core.insertRetrySession(engagement, input, currentId);
    } else {
      // 复用：只递增执行次数、把状态置回 active。
      //
      // **不更新 `task_prompt`**：它是创建时冻结的能力快照的一部分（§2.4），
      // 002 的触发器把它列为冻结列（首次写入后不可修改，违反即 23001）。
      // 重做的新提示词不是「修改冻结快照」，而是一次新的投递——它已经记在
      // `human_decisions.editedPayload.taskPrompt`（上面 #recordDecision 写的），
      // 并经 `deliver` 送进会话。库里保留原提示词，审计里保留每轮的新提示词，
      // 两者各司其职。
      //
      // 状态回 `active` 而非 `starting`：会话一直在活着，`starting` 的语义是
      // 「刚创建、dsh 会话尚未建立」。002 的合法迁移图里 `waiting_human → active`
      // 是合法边，`→ starting` 不是。
      await this.#core.deps.txDb.query(
        `update pentest.worker_sessions set attempt = attempt + 1, status = 'active'
          where id = $1::uuid`,
        [currentId],
      );
    }

    await this.#core.recordPlannedTransition({
      plan: planned.plan,
      engagementId: input.engagementId,
      fromPhase: engagement.current_phase,
      toPhase: engagement.current_phase,
      graphIteration: toInt(engagement.graph_iteration, 'graph_iteration'),
      fromScopeVersion: null,
      toScopeVersion: null,
      fromSessionId: currentId,
      toSessionId: targetSessionId,
      expectedVersion: input.expectedStateVersion,
      humanDecisionId: decisionId,
      handoffId: null,
      reason: input.reason,
    });
    await this.#core.updateEngagement({
      engagementId: input.engagementId,
      expectedVersion: input.expectedStateVersion,
      currentStatus: 'worker_running',
      activeSessionId: targetSessionId,
    });
    return { engagement, targetSessionId, reuse, currentId };
    });

    // ── 事务已提交。租约与 dsh 会话都在事务外处理 ──
    //
    // 租约端口用**自己的连接**去 `SELECT ... FOR UPDATE` 那行 `worker_sessions`，
    // 而我们的事务刚刚改过它且尚未提交。若把租约调用放在事务内，它等我们提交、
    // 我们等它返回——**自锁死**。因此所有租约操作必须在事务外。
    const { engagement, targetSessionId, reuse, currentId } = staged;
    if (reuse) {
      // 世代推进：旧世代的在途请求被拒（lease_generation_stale）
      await reissueLease(this.#core.deps.leases, { workerSessionId: currentId, now: this.#core.now() });
    } else {
      await revokeLease(this.#core.deps.leases, {
        workerSessionId: currentId,
        reason: 'superseded',
        now: this.#core.now(),
      });
      await issueLease(this.#core.deps.leases, {
        workerSessionId: targetSessionId,
        ttlSeconds: DEFAULTS.leaseTtlSeconds,
        now: this.#core.now(),
      });
    }

    if (reuse) {
      const session = await this.#core.loadSession(targetSessionId);
      if (session !== null) {
        // 状态已在事务内置为 active（触发器只允许 waiting_human → active）
        try {
          await this.#core.deliverOrFail(session.dsh_session_id, input.taskPrompt, targetSessionId);
        } catch (error) {
          // 转移已提交、消息没送到：不能只抛异常把作业留在「运行中」（§5.4 的失败语义）。
          await this.#core.markDeliveryFailure({
            engagementId: input.engagementId,
            workerSessionId: targetSessionId,
            detail: error instanceof Error ? error.message : String(error),
          });
          throw error;
        }
      }
    } else {
      const targetPhase = isPhase(engagement.current_phase) ? engagement.current_phase : 'intelligence-gathering';
      const caps = await this.#core.capabilities().resolve(targetPhase);
      // 沿用**被取代会话**的工具集与 skill，而不是空数组。
      //
      // 空数组在 dsh 里等于「该会话没有任何全局工具」——连 `pentest_exec` 都没有，
      // 而且 dsh 不报错（静默给出一个无法工作的会话）。人类之前确认过的工具集
      // 应当在同阶段重做时延续；要改能力应走切换阶段或从控制台显式指定。
      const inherited = await this.#core.loadSessionTooling(currentId);
      await this.#core.createDshSessionOrMarkFailed({
        sessionKind: 'phase',
        engagementId: input.engagementId,
        workerSessionId: targetSessionId,
        dshSessionId: this.#core.dshSessionIdOf(targetSessionId),
        phase: targetPhase,
        profileId: caps.profileId,
        profileRevision: caps.profileRevision,
        modelRoute: caps.modelRoute,
        actionTemplates: this.#core.actionTemplates(),
        behavior: await this.#core.behaviorBriefOf(input.engagementId),
        scope: await this.#core.scopeEntriesOf(input.engagementId, await this.#core.currentScopeVersion(input.engagementId)),
        publicMemory: await this.#core.publicMemoryOf(input.engagementId),
        toolAllow: inherited.toolAllow,
        skillIds: inherited.skillIds,
        skillBriefs: await this.#core.skillBriefsOf(inherited.skillIds),
        retrievalChannels: this.#core.retrievalChannelsOf(),
        enforcedApprovalClasses: await this.#core.enforcedApprovalClassesOf(input.engagementId),
        taskPrompt: input.taskPrompt,
        budget: undefined,
        approvalRequired: [],
        handoffContext: null,
      });
    }

    return {
      transitionType: 'retry',
      stateVersion: input.expectedStateVersion + 1,
      graphIteration: toInt(engagement.graph_iteration, 'graph_iteration'),
      scopeVersion: await this.#core.currentScopeVersion(input.engagementId),
      workerSessionId: targetSessionId,
      sessionReused: reuse,
    };
  }

  // ───────────────────────── 运行标记（不改主状态） ─────────────────────────

  async pause(input: HumanPause): Promise<WorkflowSnapshot> {
    return this.#core.setRunMarker(input, 'pause', 'paused');
  }

  /**
   * 系统自动暂停（§10.2.2 的范围违规阈值、§10.5 的预算硬阈值）。
   *
   * 复用人类暂停的**转移逻辑**（同一 `pause` 转移、同样不改主状态、不吊销租约），
   * 但决策记录的主体与类型都不同——见 `SystemWorkflowService` 的说明。
   */
  async pauseForSystem(input: SystemPauseRequest): Promise<WorkflowSnapshot> {
    return this.#core.setRunMarker(
      {
        engagementId: input.engagementId,
        operatorId: SYSTEM_OPERATOR_ID,
        expectedStateVersion: input.expectedStateVersion,
        reason: `系统自动暂停（${input.cause}）：${input.detail}`,
      },
      'pause',
      'paused',
      `system_auto_pause:${input.cause}`,
    );
  }

  async resume(input: HumanResume): Promise<WorkflowSnapshot> {
    const engagement = await this.#core.loadEngagement(input.engagementId);
    // 恢复的**单源判定**在契约层（`runActionAvailability`）：`paused` 与 `blocked` 都可以
    // 恢复，客户端按同一函数启用按钮。`blocked` 由启动对账（§15.2）与会话创建失败写入，
    // 语义是「等人类处置」——处置完必须有受支持的出口，否则堵塞的作业只能靠改库收场。
    const availability = runActionAvailability({
      mainStatus: engagement.current_status,
      runMarker: engagement.status,
      activeWorkerSessionId: engagement.active_agent_session_id,
    });
    if (!availability.canResume) {
      throw new WorkflowRejection(
        'classification_rejected',
        engagement.current_status === 'complete'
          ? '作业已签字导出（complete），运行期动作不再有意义'
          : `只有已暂停（paused）或已阻塞（blocked）可以恢复（当前运行标记 ${engagement.status}）`,
      );
    }
    // 恢复：只把运行标记置回 running，**主状态从未改变**（§5.1 两层状态表）。
    // 租约保留不吊销——暂停若吊销，会连带作废该会话全部放行凭证（§10.6）。
    await this.#core.tx(async () => {
      const row = await this.#core.lockEngagement(input.engagementId, input.expectedStateVersion);
      const planned = planTransition({
        type: 'resume',
        fromStatus: row.current_status,
        toStatus: row.current_status,
      });
      this.#core.assertPlan(planned);
      const decisionId = await this.#core.recordDecision({
        engagementId: input.engagementId,
        operatorId: input.operatorId,
        decisionType: 'resume',
        subjectId: row.active_agent_session_id ?? 'none',
        decision: 'resume',
        reason: input.reason,
      });
      await this.#core.recordPlannedTransition({
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
      await this.#core.deps.txDb.query(
        // version-bump-sanctioned:transition —— 与同一事务里的 `resume` 转移行成对。
        `update pentest.engagements set status = 'running', state_version = $2, updated_at = now()
          where id = $1::uuid`,
        [input.engagementId, input.expectedStateVersion + 1],
      );
    });
    return this.#core.getState(input.engagementId);
  }

  async abort(input: HumanAbort): Promise<WorkflowSnapshot> {
    return this.#core.setRunMarker(input, 'abort', 'aborted');
  }

  // ───────────────────────── 插话 ─────────────────────────

  /**
   * 运行中插话纠偏（§6.7）。
   *
   * - 会话**运行中** → 只投递消息，**不产生状态转移**（执行次数不递增）
   * - 会话**等待人工判断** → 唤醒：写 `interject_wake` 转移，主状态回到 worker_running
   */
  async interject(input: Interjection): Promise<InterjectionResult> {
    const session = await this.#core.loadSession(input.workerSessionId);
    if (session === null) throw new WorkflowRejection('lease_required', '会话不存在');

    if (session.status === 'active') {
      // 运行中投递不产生状态转移，但**仍要核对人类读到的那一版**：插话是投进模型上下文的
      // 消息，双击或重放会把同一条指令送进会话两次（对模型可见的副作用）。
      // 前置判定与唤醒路径共用契约层的 `runActionAvailability`。
      await this.#core.tx(async () => {
        const engagement = await this.#core.lockEngagement(session.engagement_id, input.expectedStateVersion);
        if (
          !runActionAvailability({
            mainStatus: engagement.current_status,
            runMarker: engagement.status,
            activeWorkerSessionId: engagement.active_agent_session_id,
          }).canInterject
        ) {
          throw new WorkflowRejection(
            'classification_rejected',
            `插话只在运行中送达（当前运行标记 ${engagement.status}）：暂停或阻塞期间投递无人消费`,
          );
        }
      });
      await this.#core.deliverOrFail(session.dsh_session_id, input.message, session.id);
      await this.#core.audit(
        session.engagement_id,
        session.id,
        'human.interjection',
        interjectionEventPayload({ message: input.message, woke: false }),
      );
      return {
        delivered: true,
        transitionType: 'none',
        stateVersion: await this.#core.stateVersion(session.engagement_id),
      };
    }

    if (session.status !== 'waiting_human') {
      throw new WorkflowRejection(
        'classification_rejected',
        `当前会话状态不接受插话（${session.status}）；交接草稿与确认期间插话会污染草稿`,
      );
    }

    // 唤醒：等待人工 → 运行中，写 interject_wake 转移（不递增迭代、无交接记录）
    let stateVersion = 0;
    await this.#core.tx(async () => {
      // 乐观锁用**人类读到的那一版**。此前是 `await stateVersion(...)`——拿数据库当前版本
      // 当期望值，比对必然通过，等于没有加锁（控制台那层的方法表注释自己写着
      // 「这是服务契约的缺口」）。现在 `expectedStateVersion` 进了 `Interjection` 契约，
      // 端点也改成 `lock: 'actor'`，这条比对才是真的。
      const engagement = await this.#core.lockEngagement(session.engagement_id, input.expectedStateVersion);
      // 唤醒同时要求运行标记为 running：暂停或阻塞时把主状态扳回 worker_running，
      // 会造出「标记暂停、会话却在跑」的两个事实（§5.1 两层状态必须并存不矛盾）。
      if (engagement.status !== 'running') {
        throw new WorkflowRejection(
          'classification_rejected',
          `插话唤醒要求运行标记为 running（当前 ${engagement.status}）：请先恢复作业`,
        );
      }
      // REQ-8b（2026-10-05 复核）：唤醒必须读**真实主状态**并在其上判定。
      // 此前硬编码 `fromStatus: 'waiting_human_review'`——于是 `beginHandoff` 把作业置为
      // `transition_confirmation`（会话仍是 waiting_human）时，插话会把作业扳回
      // `worker_running`、把未确认的交接草稿变成孤儿，账本还写下与实际不符的 from_status。
      const fromStatus = engagement.current_status;
      if (fromStatus !== 'waiting_human_review') {
        const guidance =
          fromStatus === 'handoff_drafting' || fromStatus === 'transition_confirmation'
            ? '交接草稿/确认期间插话会污染草稿：请先确认或取消交接，再插话'
            : fromStatus === 'auth_pending'
              ? '范围提案确认期间插话会与确认流程竞争：请先确认或驳回范围提案'
              : '只有等待人工判断（waiting_human_review）时才可以唤醒会话';
        throw new WorkflowRejection(
          'classification_rejected',
          `当前主状态不接受插话唤醒（${fromStatus}）：${guidance}`,
        );
      }
      const planned = planTransition({
        type: 'interject_wake',
        fromStatus,
        toStatus: 'worker_running',
      });
      this.#core.assertPlan(planned);

      const decisionId = await this.#core.recordDecision({
        engagementId: session.engagement_id,
        operatorId: input.operatorId ?? SYSTEM_OPERATOR_ID,
        decisionType: 'interject',
        subjectId: session.id,
        decision: 'wake',
        reason: '运行中插话纠偏',
      });
      await this.#core.recordPlannedTransition({
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
        reason: '运行中插话纠偏',
      });
      await this.#core.deps.txDb.query(
        `update pentest.worker_sessions set status = 'active' where id = $1::uuid`,
        [session.id],
      );
      await this.#core.updateEngagement({
        engagementId: session.engagement_id,
        expectedVersion: toInt(engagement.state_version, 'state_version'),
        currentStatus: 'worker_running',
      });
      stateVersion = toInt(engagement.state_version, 'state_version') + 1;
    });

    try {
      await this.#core.deliverOrFail(session.dsh_session_id, input.message, session.id);
    } catch (error) {
      // 与重做复用同一条处置：转移已提交、消息没送到 → 会话置 failed（吊销租约）、
      // 作业置 blocked，人类用 resume 或 abort 决定下一步。
      await this.#core.markDeliveryFailure({
        engagementId: session.engagement_id,
        workerSessionId: session.id,
        detail: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
    await this.#core.audit(
      session.engagement_id,
      session.id,
      'human.interjection',
      interjectionEventPayload({ message: input.message, woke: true }),
    );

    return { delivered: true, transitionType: 'interject_wake', stateVersion };
  }

  // ───────────────────────── 预算 ─────────────────────────

  /**
   * 追加预算并恢复会话（§10.5）。
   *
   * **不吊销租约**——暂停保留租约，否则一次预算追加会静默作废该会话全部放行凭证。
   *
   * **不改主状态**：追加预算是「给得起更多」，不是「回到运行中」。此前这里写死
   * `currentStatus: 'worker_running'`——于是在「等待人工判断」时追加预算会把主状态从
   * `waiting_human_review` 扳回 `worker_running`，等于替人类点了「重做」；在 `complete`
   * 之后追加甚至能把已签字导出的作业拉回运行中（2026-10-05 复核 F1 的连带项）。
   */
  async extendBudget(input: BudgetExtension): Promise<WorkflowSnapshot> {
    const session = await this.#core.loadSession(input.workerSessionId);
    if (session === null) throw new WorkflowRejection('lease_required', '会话不存在');

    await this.#core.tx(async () => {
      // 用人类提供的期望版本做乐观锁（BudgetExtension 是 HumanActor）
      const engagement = await this.#core.lockEngagement(session.engagement_id, input.expectedStateVersion);
      // 适用范围由契约层单源判定给出：运行中或已暂停，且作业未签字导出。
      // （早先这里是现拼的 `!canPause && status !== 'paused'`，漏掉了 `complete`——
      // 在 report_ready 暂停、再签字导出的作业会停在「complete + paused」而被放行，
      // 于是一次追加预算把已经结束的作业复活成 running。2026-10-05 质检发现。）
      const availability = runActionAvailability({
        mainStatus: engagement.current_status,
        runMarker: engagement.status,
        activeWorkerSessionId: engagement.active_agent_session_id,
      });
      if (!availability.canExtendBudget) {
        throw new WorkflowRejection(
          'classification_rejected',
          engagement.current_status === 'complete'
            ? '作业已签字导出（complete），不再接受预算追加'
            : `只有运行中或已暂停的作业可以追加预算（当前运行标记 ${engagement.status}）：请先恢复或终止`,
        );
      }
      await this.#core.recordDecision({
        engagementId: session.engagement_id,
        operatorId: input.operatorId,
        decisionType: 'extend_budget',
        subjectId: session.id,
        decision: 'extended',
        reason: input.reason,
        editedPayload: {
          additionalTokens: input.additionalTokens ?? null,
          additionalSteps: input.additionalSteps ?? null,
          additionalSeconds: input.additionalSeconds ?? null,
        },
      });

      // 预算累加到会话行；已终结的会话不接受追加
      await this.#core.deps.txDb.query(
        `update pentest.worker_sessions
            set budget_max_tokens = coalesce(budget_max_tokens, 0) + coalesce($2, 0),
                budget_max_steps = coalesce(budget_max_steps, 0) + coalesce($3, 0),
                budget_max_seconds = coalesce(budget_max_seconds, 0) + coalesce($4, 0),
                status = case when status = 'paused' then 'active' else status end
          where id = $1::uuid and status not in ('closed','superseded','failed')`,
        [session.id, input.additionalTokens ?? null, input.additionalSteps ?? null, input.additionalSeconds ?? null],
      );
      await this.#core.deps.txDb.query(
        `update pentest.engagements
            set status = 'running', updated_at = now()
          where id = $1::uuid and status = 'paused'`,
        [session.engagement_id],
      );
      await this.#core.updateEngagement({
        engagementId: session.engagement_id,
        expectedVersion: toInt(engagement.state_version, 'state_version'),
        // 只推进版本：主状态由 `resume` / 各转移单独负责（见方法头部的说明）。
      });
      await this.#core.audit(session.engagement_id, session.id, 'budget.extended', {
        additionalTokens: input.additionalTokens ?? 0,
      });
    });
    return this.#core.getState(session.engagement_id);
  }
}

/**
 * `human.interjection` 的账本载荷。
 *
 * **正文必须进账本**：分块器按 `payload.text` 取内容（`chunks.ts` 的 `chunkAtomic`），
 * 只写 `{delivered, woke}` 会让人类指令在检索面与审计里都不存在——实测踩过
 * （QA 2026-10-04：插话提到的端口在 `memory_chunks` 里查不到）。设计 §8.5 把
 * 「人类输入」列为一等记忆来源，这里就是那条来源的写入侧。
 *
 * 导出供契约测试使用：测试调用的是写入侧的同一个函数，不手抄载荷形状。
 */
export function interjectionEventPayload(input: {
  readonly message: string;
  readonly woke: boolean;
}): Readonly<Record<string, unknown>> {
  return {
    delivered: true,
    text: input.message,
    // 只有唤醒路径才带 woke：运行中投递若写成 woke:false，审计会把它读成「试图唤醒但没成功」。
    ...(input.woke ? { woke: true } : {}),
  };
}
