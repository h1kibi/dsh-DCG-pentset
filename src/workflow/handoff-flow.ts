/**
 * 交接草稿、编辑、取消与阶段切换（§7.2/§5.4）
 *
 * 从 `pg-workflow.ts` 机械搬运（拆分目标：组合器只做装配与委托，流程各自成类）。
 * 方法体与拆分前逐字一致；共享原语经构造注入的 {@link WorkflowCore} 使用。
 */

import type { ActionClass, ContextRef, HandoffDraft, HumanCancel, Phase, TransitionConfirmation, TransitionResult, WorkflowSnapshot } from '../contracts.ts';
import { ACTION_CLASSES, HANDOFF_AUTO_CONTEXT_REFS, HANDOFF_REPORT_SUMMARY_MAX_CHARS, isPhase } from '../contracts.ts';
import { planTransition } from './transition-table.ts';
import { PHASE_DEFINITIONS, planPhaseMove } from './phases.ts';
import { SKILL_PACKS } from '../skills/skill-pack.ts';
import { DEFAULT_PHASE_TOOL_ALLOW } from './model.ts';
import { capContextRefs, computeDraftHash, computeHandoffHash, validateHandoff } from './handoff.ts';
import type { HandoffPackage } from '../contracts.ts';
import { issueLease, revokeLease } from './lease.ts';
import { DEFAULTS } from '../contracts.ts';
import { WorkflowRejection, recommendedNextPhase, toInt } from './model.ts';
import type { WorkflowCore } from './core.ts';

export class HandoffFlow {
  readonly #core: WorkflowCore;

  constructor(core: WorkflowCore) {
    this.#core = core;
  }

  // ───────────────────────── 交接草稿与切换 ─────────────────────────

  /**
   * 「给我一份能直接改的交接包」：**不经过 Agent**，由服务端按阶段定义与当前状态起草。
   *
   * ── 为什么改掉「先让 Agent 起草」 ──
   *
   * 那条路要往会话里续跑一个回合：人类在对话里看到的是一堵机器格式的 JSON（定界符 + 原始字段），
   * 还得等它跑完；而人类真正要的只是**一份可直接编辑的提示词与上下文**（2026-10-05 人类要求：
   * 「直接把写好的提示词和上下文给我，让我直接可以修改」）。
   *
   * 现在：点一下 → 服务端把初始内容写进草稿行 → 编辑器就地展开 → 人类逐项改写 → 确认注入。
   * 状态机一个字没变（`waiting_human_review → handoff_drafting → transition_confirmation`），
   * 审计与确认路径照旧。
   */
  async beginHandoff(input: {
    readonly workerSessionId: string;
    readonly operatorId: string;
    readonly toPhase?: Phase;
  }): Promise<HandoffDraft> {
    const session = await this.#core.loadSession(input.workerSessionId);
    if (session === null) throw new WorkflowRejection('lease_required', '会话不存在');
    const toPhase = input.toPhase ?? recommendedNextPhase(session.phase);
    if (toPhase === null) {
      throw new WorkflowRejection(
        'handoff_transition_illegal',
        `阶段「${session.phase}」没有推荐的下一阶段：请显式指定目标阶段（回补/跳级属于强制移动）`,
      );
    }
    const context = (
      await this.#core.deps.db.query<{
        status_note: string | null;
        approval_required: unknown;
        engagement_id: string;
      }>(
        // 键名是 `perActionApprovalClasses`（策略快照的实际形状；写成想当然的
        // `approval_required` 会读到 null，于是编辑器里默认「无需放行」——那会误导人类）。
        `select s.status_note,
                e.policy_snapshot -> 'action_policy' -> 'perActionApprovalClasses' as approval_required,
                s.engagement_id
           from pentest.worker_sessions s
           join pentest.engagements e on e.id = s.engagement_id
          where s.id = $1::uuid`,
        [session.id],
      )
    ).rows[0];
    // 上一阶段最后一份**未被取代**的报告：便签上限 600 字符，报告是结构化产出（判据/证据/未决），
    // 两者叠加才是可靠的「上一阶段要点」（2026-10-07；此前只拼便签，压缩比高到丢信息）。
    const reportRow = (
      await this.#core.deps.db.query<{ id: string; summary: string }>(
        `select id, summary
           from pentest.worker_reports
          where worker_session_id = $1::uuid and superseded_by is null and btrim(summary) <> ''
          order by created_at desc
          limit 1`,
        [session.id],
      )
    ).rows[0];
    // 自动引用候选：本作业最近的记忆条目，新→旧。排除 `compaction_summary`——那是宿主做
    // 上下文压缩的产物，不是这一阶段的结论。条数由 `HANDOFF_AUTO_CONTEXT_REFS` 收口
    // （人类不再逐条编辑引用，因此这里取保守值）。
    const refRows =
      context === undefined
        ? []
        : (
            await this.#core.deps.db.query<{ id: string; title: string }>(
              `select id, coalesce(nullif(btrim(title), ''), kind) as title
                 from pentest.memory_items
                where engagement_id = $1::uuid and kind <> 'compaction_summary'
                order by created_at desc
                limit $2`,
              [context.engagement_id, HANDOFF_AUTO_CONTEXT_REFS],
            )
          ).rows;
    const seeded = seedHandoffContent({
      fromPhase: session.phase,
      toPhase,
      statusNote: context?.status_note ?? null,
      previousReport:
        reportRow === undefined ? null : { summary: reportRow.summary, reportId: reportRow.id },
      candidateRefs: refRows.map((row) => ({
        memoryId: `memory:${row.id}`,
        reason: `上一阶段记忆：${row.title}`,
      })),
      approvalRequired: Array.isArray(context?.approval_required)
        ? (context.approval_required as readonly string[])
            .filter((value) => (ACTION_CLASSES as readonly string[]).includes(value)) as readonly ActionClass[]
        : [],
    });

    const handoffId = this.#core.id();
    // 草稿哈希 = 对落库 `draft_json` 的真摘要（REQ-9）：此前是 base64url 前缀——可逆，
    // 等于把草稿正文（含提示词）编码后放回哈希列。人类确认页显示的「内容哈希」必须是
    // 能自证来源的指纹，可逆前缀做不到（见 `computeDraftHash` 的说明）。
    const contentHash = computeDraftHash(seeded.draftJson);
    await this.#core.tx(async () => {
      const engagement = await this.#core.lockEngagement(
        session.engagement_id,
        await this.#core.stateVersion(session.engagement_id),
      );
      if (engagement.current_status !== 'waiting_human_review') {
        throw new WorkflowRejection(
          'handoff_transition_illegal',
          `只有等待人工判断时可以进入交接（当前 ${engagement.current_status}）`,
        );
      }
      const planned = planTransition({
        type: 'handoff_regen',
        fromStatus: 'waiting_human_review',
        toStatus: 'handoff_drafting',
      });
      this.#core.assertPlan(planned);
      const decisionId = await this.#core.recordDecision({
        engagementId: session.engagement_id,
        operatorId: input.operatorId,
        decisionType: 'request_handoff_draft',
        subjectId: session.id,
        decision: toPhase,
        reason: '人类点「进入下一阶段」：服务端起稿（不经 Agent）',
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
        reason: '请求交接草稿（服务端起稿）',
      });
      await this.#core.deps.txDb.query(
        `insert into pentest.handoffs
           (id, engagement_id, from_worker_session_id, transition_type, forced,
            suggested_to_phase, suggested_skill_ids, draft_json, context_refs, excluded_refs,
            content_hash, status)
         values ($1::uuid,$2::uuid,$3::uuid,'advance',false,$4,$5::jsonb,$6::jsonb,'[]'::jsonb,'[]'::jsonb,$7,'draft')`,
        [
          handoffId,
          session.engagement_id,
          session.id,
          toPhase,
          JSON.stringify(seeded.suggestedSkillIds),
          JSON.stringify(seeded.draftJson),
          contentHash,
        ],
      );
      await this.#core.updateEngagement({
        engagementId: session.engagement_id,
        expectedVersion: toInt(engagement.state_version, 'state_version'),
        currentStatus: 'transition_confirmation',
      });
      await this.#core.audit(session.engagement_id, session.id, 'handoff.draft.generated', {
        handoffId,
        toPhase,
        seeded: true,
        objective: seeded.objective,
        prompt: seeded.prompt,
      });
    }, session.engagement_id);

    return {
      draftId: handoffId,
      fromWorkerSessionId: session.id,
      fromPhase: session.phase,
      suggestedToPhase: toPhase,
      objective: seeded.objective,
      prompt: seeded.prompt,
      suggestedSkillIds: seeded.suggestedSkillIds,
      contextRefs: [],
      excludedRefs: [],
      toolCapabilitySuggestion: { allowed: seeded.allowed, approvalRequired: seeded.approvalRequired },
      limitations: seeded.limitations,
      revision: 1,
      // 与刚写进库里那一行是同一个值：人类拿到草稿的同时就能看到权威哈希（REQ-9）。
      contentHash,
    };
  }

  /**
   * 读回**当前待确认的交接内容**（§7.2）；没有则 `null`。
   *
   * 界面据此渲染编辑器：它不能只活在「请求它的那次调用」的返回值里——那一轮新消息会让会话尾部
   * 组件重新挂载，内容随之消失（人类看得到正文却找不到确认按钮，2026-10-05 报障）。
   */
  async currentHandoffDraft(input: { readonly workerSessionId: string }): Promise<HandoffDraft | null> {
    const session = await this.#core.loadSession(input.workerSessionId);
    if (session === null) return null;
    const result = await this.#core.deps.db.query<{
      id: string;
      from_worker_session_id: string;
      suggested_to_phase: string | null;
      suggested_skill_ids: readonly string[];
      draft_json: unknown;
      context_refs: readonly ContextRef[];
      excluded_refs: readonly string[];
      revision: number | string;
      current_status: string;
      content_hash: string;
    }>(
      // **必须联合作业状态判定**：草稿行可能"孤儿复活"——交接被取消后作业回到
      // `waiting_human_review`，而那行 `status='draft'` 还在库里（取消会标 rejected，
      // 但历史数据、并发路径都可能留下漏网的一份）。只看行状态的话，界面会为一个**已经结束**
      // 的交接重新摆出编辑器，人类点下去只会被服务端拒（2026-10-05 真机实测）。
      `select h.id, h.from_worker_session_id, h.suggested_to_phase, h.suggested_skill_ids,
              h.draft_json, h.context_refs, h.excluded_refs, h.revision, e.current_status,
              h.content_hash
         from pentest.handoffs h
         join pentest.engagements e on e.id = h.engagement_id
        where h.engagement_id = $1::uuid
          and h.status in ('draft', 'editing')
          and e.current_status in ('handoff_drafting', 'transition_confirmation')
        order by h.created_at desc
        limit 1`,
      [session.engagement_id],
    );
    const row = result.rows[0];
    if (row === undefined) return null;
    const stored = narrowStoredDraft(row.draft_json);
    if (stored === null) return null;
    const toPhase = row.suggested_to_phase !== null && isPhase(row.suggested_to_phase)
      ? row.suggested_to_phase
      : stored.suggestedToPhase ?? session.phase;
    return {
      draftId: row.id,
      fromWorkerSessionId: row.from_worker_session_id,
      fromPhase: session.phase,
      suggestedToPhase: toPhase,
      objective: stored.objective,
      prompt: stored.prompt,
      suggestedSkillIds: row.suggested_skill_ids.length > 0 ? row.suggested_skill_ids : stored.suggestedSkillIds,
      // 引用取**冻结列**（`draft_json` 里是未富化的原始版）。
      contextRefs: row.context_refs.length > 0 ? row.context_refs : stored.contextRefs,
      excludedRefs: row.excluded_refs.length > 0 ? row.excluded_refs : stored.excludedRefs,
      toolCapabilitySuggestion: stored.toolCapabilitySuggestion,
      limitations: stored.limitations,
      revision: toInt(row.revision, 'revision'),
      // 库里那一行的哈希（草稿期由 `computeDraftHash` 写入）——UI 展示的必须是它。
      contentHash: row.content_hash,
    };
  }

  async cancelHandoff(input: HumanCancel): Promise<WorkflowSnapshot> {
    await this.#core.tx(async () => {
      const engagement = await this.#core.lockEngagement(input.engagementId, input.expectedStateVersion);
      if (engagement.current_status !== 'handoff_drafting' && engagement.current_status !== 'transition_confirmation') {
        throw new WorkflowRejection(
          'handoff_transition_illegal',
          `当前状态没有可取消的交接（${engagement.current_status}）`,
        );
      }
      const planned = planTransition({
        type: 'handoff_cancel',
        fromStatus: engagement.current_status,
        toStatus: 'waiting_human_review',
      });
      this.#core.assertPlan(planned);

      // 取消意味着那份草稿不再是「当前待确认」：不标它，读端点会继续把它交回界面，
      // 人类会对着已经作废的草稿再点一次确认（2026-10-05：读端点接上后立刻被测试逮到）。
      // 只动 `status`（可变列），冻结列一个都不碰。
      await this.#core.deps.txDb.query(
        `update pentest.handoffs set status = 'rejected'
          where engagement_id = $1::uuid and status in ('draft', 'editing')`,
        [input.engagementId],
      );
      const decisionId = await this.#core.recordDecision({
        engagementId: input.engagementId,
        operatorId: input.operatorId,
        decisionType: 'handoff_cancel',
        subjectId: engagement.active_agent_session_id ?? 'none',
        decision: 'cancel',
        reason: input.reason,
      });
      await this.#core.recordPlannedTransition({
        plan: planned.plan,
        engagementId: input.engagementId,
        fromPhase: engagement.current_phase,
        toPhase: engagement.current_phase,
        graphIteration: toInt(engagement.graph_iteration, 'graph_iteration'),
        fromScopeVersion: null,
        toScopeVersion: null,
        fromSessionId: engagement.active_agent_session_id,
        toSessionId: engagement.active_agent_session_id,
        expectedVersion: input.expectedStateVersion,
        humanDecisionId: decisionId,
        handoffId: null,
        reason: input.reason,
      });
      await this.#core.updateEngagement({
        engagementId: input.engagementId,
        expectedVersion: input.expectedStateVersion,
        currentStatus: 'waiting_human_review',
      });
    });
    return this.#core.getState(input.engagementId);
  }

  // ───────────────────────── 阶段切换 ─────────────────────────

  /**
   * 确认阶段切换：人类编辑后的交接内容在此落地，并创建目标阶段的新顶层会话。
   *
   * 前置：交接必需键必须齐备（§7.2 的纯函数校验），否则**阻止确认**。
   */
  async confirmTransition(input: TransitionConfirmation): Promise<TransitionResult> {
    // 事务内加锁（见 startWorker 的说明）
    const staged = await this.#core.tx(async () => {
    const engagement = await this.#core.lockEngagement(input.engagementId, input.expectedStateVersion);
    if (engagement.current_status !== 'transition_confirmation') {
      throw new WorkflowRejection(
        'handoff_transition_illegal',
        `只有交接确认阶段可以确认切换（当前 ${engagement.current_status}）`,
      );
    }
    const fromPhase = isPhase(engagement.current_phase) ? engagement.current_phase : null;
    if (fromPhase === null) {
      throw new WorkflowRejection('classification_rejected', '当前阶段未知，无法切换');
    }

    // 阶段移动校验：推荐边 / 强制跳转（理由+二次确认）/ 回环前置（范围修订）
    //
    // ── 回环前置必须**真判**，不能写死 ──
    //
    // `planPhaseMove` 对「后渗透 → 情报收集」要求范围修订已完成（§5.4 步骤 4、§13.7）。
    // 这里曾硬编码 `{ completed: true }`，于是那条闸门虽然写着、却永远通过——回环可以在
    // 未做任何范围修订的情况下发生，而回环的全部意义就是「带着新纳入的内部资产重新侦察」
    // （§5.5），没有修订就等于用旧范围跑新一轮。
    //
    // 判据（可从数据推出，不需要额外状态位）：**存在比来源会话绑定版本更新的范围版本**。
    //   - 来源会话是后渗透那个会话，它的 `scope_version` 是回环的起点；
    //   - `amendScope` 会递增版本，所以「已修订」== 当前版本 > 起点版本。
    // 用「起点」而不是「版本号大于 1」之类的绝对条件：范围在更早的阶段就可能被修订过，
    // 绝对条件会把「早就改过、但本轮没改」误判为已修订。
    const fromSessionId = engagement.active_agent_session_id;
    const fromSession = fromSessionId === null ? null : await this.#core.loadSession(fromSessionId);
    const currentScopeVersion = await this.#core.currentScopeVersion(input.engagementId);
    const loopScopeReady =
      fromSession !== null &&
      currentScopeVersion > toInt(fromSession.scope_version, 'scope_version');
    const move = planPhaseMove({
      from: fromPhase,
      to: input.approvedToPhase,
      forced: input.forced,
      reason: input.reason,
      doubleConfirmed: input.forcedAcknowledged,
      scopeAmendment: {
        completed: loopScopeReady,
        newVersion: loopScopeReady ? currentScopeVersion : null,
      },
    });
    if (!move.ok) throw new WorkflowRejection(move.code, move.message);

    // REQ-8c（2026-10-05 复核）：同阶段重做走 retryWorker，**不得**借「交接确认」这条边。
    // 此前这里直写 `move.plan.transitionType`：同阶段确认会写下图上不存在的 `retry` 边
    // （该边只允许 advance / rollback / loop），而 `handoffs.transition_type` 又把它强写成
    // `advance`——同一操作两处记录不一致。
    if (move.plan.transitionType === 'retry') {
      throw new WorkflowRejection(
        'handoff_transition_illegal',
        '同阶段重做不走交接确认：请用「重做本阶段」（retryWorker），它不会伪造阶段推进',
      );
    }
    const planned = planTransition({
      type: move.plan.transitionType,
      fromStatus: 'transition_confirmation',
      toStatus: 'worker_running',
      forced: move.plan.forced === true,
    });
    this.#core.assertPlan(planned);

    // 交接必需键校验（纯函数；缺键阻止确认）
    const approvedRefs = input.contextRefs.filter((ref) => !input.excludedRefs.includes(ref.memoryId));
    // 引用条数按预算切分：溢出的写进交接包（设计 §8.10.1），下一 Agent 据此主动检索补齐。
    const cappedRefs = capContextRefs(approvedRefs.map((ref) => ref.memoryId));
    const handoffPackage: HandoffPackage = {
      handoffId: input.draftId,
      // 交接记录里的类型取**计划算出的** handoffTransitionType（同一条边只记一个事实），
      // 不再手写三元映射（2026-10-05 复核 REQ-8c）。
      transitionType: planned.plan.handoffTransitionType ?? 'advance',
      forced: input.forced,
      approvedToPhase: input.approvedToPhase,
      approvedPrompt: input.approvedPrompt,
      objective: input.objective,
      excludedRefs: input.excludedRefs,
      approvedContextRefs: cappedRefs.kept,
      approvedSkillIds: input.approvedSkillIds,
      approvedToolFilter: { allow: input.approvedToolAllow },
      approvedApprovalRequired: input.approvedApprovalRequired,
      truncatedRefs: cappedRefs.truncated,
      humanDecisionRef: 'pending',
      contentHash: 'pending',
    };
    const requiredKeys = this.#core.deps.requiredHandoffKeys?.(input.approvedToPhase) ?? ['scope_version'];
    // 绑定的范围版本只取一次：既用于必需键校验，也进确认哈希——两处必须是同一个版本，
    // 分开读会给出「校验用一个版本、哈希另一个版本」的窗口。
    const boundScopeVersion = await this.#core.boundScopeVersion(engagement.id);
    const validation = validateHandoff(handoffPackage, requiredKeys, boundScopeVersion);
    if (!validation.ok) {
      throw new WorkflowRejection(
        'handoff_incomplete',
        `交接必需键未齐备：${validation.missing.join('、')}。请补齐后再确认。`,
      );
    }

    const currentId = engagement.active_agent_session_id;
    const decisionId = await this.#core.recordDecision({
      engagementId: input.engagementId,
      operatorId: input.operatorId,
      decisionType: 'confirm_transition',
      subjectId: input.draftId,
      decision: input.approvedToPhase,
      reason: input.reason,
      editedPayload: handoffPackage,
    });

    // 交接转 approved（人类编辑后的内容在此固化）。内容哈希取**最终批准包**的真摘要
    // （§6.5 第 6 块）：人类决策 id 已在上一行落库，因此这里重建一次包、把
    // `humanDecisionRef` 指向它自己——摘要于是覆盖「谁、以什么内容、在哪个范围版本下」
    // 批准了这次交接，回放与定责都得据此判定。
    // 此前写的是提示词的可逆 base64 前缀（2026-10-05 复核 REQ-9）。
    const approvedPackage: HandoffPackage = { ...handoffPackage, humanDecisionRef: decisionId };
    const approvedContentHash = computeHandoffHash(approvedPackage, boundScopeVersion);
    await this.#core.deps.txDb.query(
      `update pentest.handoffs
          set approved_json = $2::jsonb, approved_to_phase = $3, approved_skill_ids = $4::jsonb,
              human_decision_id = $5::uuid,
              forced = $6, transition_type = $7, status = 'approved', content_hash = $8
        where id = $1::uuid`,
      [
        input.draftId,
        // 批准包内也写上自己的哈希：落库列与包内字段指向同一份事实，读哪一处都一致。
        JSON.stringify({ ...approvedPackage, contentHash: approvedContentHash }),
        input.approvedToPhase,
        JSON.stringify(input.approvedSkillIds),
        decisionId,
        input.forced,
        approvedPackage.transitionType,
        approvedContentHash,
      ],
    );

    // 关闭旧会话（其租约吊销在事务外——见下）
    if (currentId !== null) {
      await this.#core.deps.txDb.query(
        `update pentest.worker_sessions set status = 'closed', ended_at = now() where id = $1::uuid`,
        [currentId],
      );
    }

    // 创建目标阶段的新顶层会话
    const caps = await this.#core.capabilities().resolve(input.approvedToPhase);
    const newSessionId = this.#core.id();
    const scopeVersion = move.plan.scopeVersion ?? (await this.#core.currentScopeVersion(input.engagementId));
    await this.#core.insertWorkerSession({
      id: newSessionId,
      engagementId: input.engagementId,
      // 血缘指针：时间轴靠它画「交接」边（`previous_agent_session_id`）。
      previousAgentSessionId: currentId,
      dshSessionId: this.#core.dshSessionIdOf(newSessionId),
      phase: input.approvedToPhase,
      caps,
      skillIds: input.approvedSkillIds,
      toolAllow: input.approvedToolAllow,
      taskPrompt: input.approvedPrompt,
      scopeVersion,
      iteration:
        toInt(engagement.graph_iteration, 'graph_iteration') +
        (move.plan.transitionType === 'loop' ? 1 : 0),
    });

    await this.#core.recordPlannedTransition({
      plan: planned.plan,
      engagementId: input.engagementId,
      fromPhase,
      toPhase: input.approvedToPhase,
      graphIteration:
        toInt(engagement.graph_iteration, 'graph_iteration') + (move.plan.transitionType === 'loop' ? 1 : 0),
      fromScopeVersion: await this.#core.currentScopeVersion(input.engagementId),
      toScopeVersion: scopeVersion,
      fromSessionId: currentId,
      toSessionId: newSessionId,
      expectedVersion: input.expectedStateVersion,
      humanDecisionId: decisionId,
      handoffId: input.draftId,
      reason: move.plan.reason ?? input.reason,
    });

    await this.#core.updateEngagement({
      engagementId: input.engagementId,
      expectedVersion: input.expectedStateVersion,
      currentStatus: 'worker_running',
      currentPhase: input.approvedToPhase,
      activeSessionId: newSessionId,
      graphIteration:
        toInt(engagement.graph_iteration, 'graph_iteration') + (move.plan.transitionType === 'loop' ? 1 : 0),
    });

    await this.#core.audit(input.engagementId, newSessionId, 'handoff.confirmed', {
      handoffId: input.draftId,
      toPhase: input.approvedToPhase,
      forced: move.plan.forced,
      // 与 `handoff.draft.generated` 同理：这一类记忆要能落块，事件必须带正文（§8.5「交接」）。
      text: `交接已确认 → ${input.approvedToPhase}`,
    });

    return { engagement, newSessionId, caps, scopeVersion, move, currentId };
    });

    // ── 事务已提交。租约与 dsh 会话都在事务外处理 ──
    //
    // 原因同 retryWorker：租约端口用自己的连接锁 `worker_sessions` 行，
    // 在事务内调用会与我们持有的未提交改动互相等待（自锁死）。
    const { engagement, newSessionId, caps, scopeVersion, move, currentId } = staged;
    const approvedRefs = input.contextRefs.filter((ref) => !input.excludedRefs.includes(ref.memoryId));

    // 旧会话的租约吊销 → 其下放行凭证一并失效（新会话需重新申请，§10.3）
    if (currentId !== null) {
      await revokeLease(this.#core.deps.leases, { workerSessionId: currentId, reason: 'closed', now: this.#core.now() });
    }
    await issueLease(this.#core.deps.leases, {
      workerSessionId: newSessionId,
      ttlSeconds: DEFAULTS.leaseTtlSeconds,
      now: this.#core.now(),
    });
    // 信封里的引用同样按预算切分（与交接包用同一个纯函数，保证两处一致）。
    const cappedRefs = capContextRefs(approvedRefs.map((ref) => ref.memoryId));
    const approvedHandoffContext = JSON.stringify({
      handoffId: input.draftId,
      objective: input.objective,
      approvedPrompt: input.approvedPrompt,
      contextRefs: cappedRefs.kept,
      excludedRefs: input.excludedRefs,
      truncatedRefs: cappedRefs.truncated,
      // 下一 Agent 看得到「有哪些没带过来」还不够，得告诉它去哪儿取——信封里放一句可执行的指引。
      truncatedHint:
        cappedRefs.truncated.length === 0
          ? null
          : '以下引用未随交接包注入；需要时用 memory_search / memory_read 按 id 取回',
    });
    await this.#core.createDshSessionOrMarkFailed({
      sessionKind: 'phase',
      engagementId: input.engagementId,
      workerSessionId: newSessionId,
      dshSessionId: this.#core.dshSessionIdOf(newSessionId),
      phase: input.approvedToPhase,
      profileId: caps.profileId,
      profileRevision: caps.profileRevision,
      modelRoute: caps.modelRoute,
      skillIds: input.approvedSkillIds,
      skillBriefs: await this.#core.skillBriefsOf(input.approvedSkillIds),
      retrievalChannels: this.#core.retrievalChannelsOf(),
      enforcedApprovalClasses: await this.#core.enforcedApprovalClassesOf(input.engagementId),
      actionTemplates: this.#core.actionTemplates(),
      behavior: await this.#core.behaviorBriefOf(input.engagementId),
      publicMemory: await this.#core.publicMemoryOf(input.engagementId),
      toolAllow: input.approvedToolAllow,
      taskPrompt: input.approvedPrompt,
      budget: undefined,
      approvalRequired: input.approvedApprovalRequired,
      handoffContext: approvedHandoffContext,
    });

    return {
      transitionType: move.plan.transitionType,
      stateVersion: input.expectedStateVersion + 1,
      graphIteration:
        toInt(engagement.graph_iteration, 'graph_iteration') + (move.plan.transitionType === 'loop' ? 1 : 0),
      scopeVersion,
      workerSessionId: newSessionId,
      sessionReused: false,
    };
  }
}

/**
 * `draft_json` → 存储形状的窄化：形状不符返回 `null`，**绝不猜**。
 *
 * 存的是会话工厂返回的那一版（`HandoffDraftResult`）：**没有** `draftId`，也没有富化过的引用。
 * 半个对象喂给编辑器，人类会拿一份残件去确认切换（§7.2 的可空键正是为这种事设的）。
 */
function narrowStoredDraft(value: unknown): {
  readonly suggestedToPhase: Phase | null;
  readonly suggestedSkillIds: readonly string[];
  readonly objective: string;
  readonly prompt: string;
  readonly contextRefs: readonly ContextRef[];
  readonly excludedRefs: readonly string[];
  readonly toolCapabilitySuggestion: { readonly allowed: readonly string[]; readonly approvalRequired: readonly ActionClass[] };
  readonly limitations: readonly string[];
} | null {
  if (value === null || typeof value !== 'object') return null;
  const draft = value as Record<string, unknown>;
  if (typeof draft['objective'] !== 'string') return null;
  if (typeof draft['prompt'] !== 'string') return null;
  if (typeof draft['suggestedToPhase'] !== 'string' && draft['suggestedToPhase'] !== null) return null;
  if (!Array.isArray(draft['suggestedSkillIds'])) return null;
  if (!Array.isArray(draft['contextRefs'])) return null;
  if (!Array.isArray(draft['excludedRefs'])) return null;
  if (!Array.isArray(draft['limitations'])) return null;
  if (typeof draft['toolCapabilitySuggestion'] !== 'object' || draft['toolCapabilitySuggestion'] === null) return null;
  return {
    suggestedToPhase: draft['suggestedToPhase'] as Phase | null,
    suggestedSkillIds: draft['suggestedSkillIds'] as readonly string[],
    objective: draft['objective'],
    prompt: draft['prompt'],
    contextRefs: draft['contextRefs'] as readonly ContextRef[],
    excludedRefs: draft['excludedRefs'] as readonly string[],
    toolCapabilitySuggestion: draft['toolCapabilitySuggestion'] as { readonly allowed: readonly string[]; readonly approvalRequired: readonly ActionClass[] },
    limitations: draft['limitations'] as readonly string[],
  };
}

/**
 * 服务端起稿：按**阶段定义**与当前状态拼出一份可直接编辑的初始交接内容。
 *
 * 纯函数（无 IO），因此能穷举断言：提示词里必须出现阶段目标、应产出物、上一阶段要点与边界；
 * 工具建议必须来自默认白名单——人类在编辑器里改的就是这些字段。
 */
export function seedHandoffContent(input: {
  readonly fromPhase: Phase;
  readonly toPhase: Phase;
  readonly statusNote: string | null;
  /**
   * 上一阶段最后一份报告的要点（`worker_reports.summary`，未取代的那份）。
   *
   * 2026-10-07 加：便签上限只有 600 字符，而报告是**结构化**产出（判据、证据、未决），
   * 两者叠加才是可靠的「上一阶段要点」——只靠便签时，压缩比高到丢信息。
   */
  readonly previousReport?: { readonly summary: string; readonly reportId: string } | null;
  /**
   * 自动带入的引用候选（上一阶段写下的记忆条目，按新→旧）。
   *
   * 人类不再逐条编辑引用，因此这里必须保守：上限 `HANDOFF_AUTO_CONTEXT_REFS`，
   * 取太多只是给下一阶段塞噪声线索。
   */
  readonly candidateRefs?: readonly { readonly memoryId: string; readonly reason: string }[];
  readonly approvalRequired: readonly ActionClass[];
}): {
  readonly objective: string;
  readonly prompt: string;
  readonly suggestedSkillIds: readonly string[];
  readonly allowed: readonly string[];
  readonly approvalRequired: readonly ActionClass[];
  readonly limitations: readonly string[];
  readonly contextRefs: readonly { readonly memoryId: string; readonly reason: string }[];
  readonly draftJson: Record<string, unknown>;
} {
  const def = PHASE_DEFINITIONS[input.toPhase];
  const objective = `进入${def.displayName}：${def.goal}`;
  const noteText = (input.statusNote ?? '').trim();
  const reportText = (input.previousReport?.summary ?? '').trim();
  const handover = [
    noteText === '' ? null : `（状态便签）\n${noteText.slice(0, DEFAULTS.statusNoteMaxChars)}`,
    reportText === '' || input.previousReport == null
      ? null
      : `（报告要点 ${input.previousReport.reportId}）\n${reportText.slice(0, HANDOFF_REPORT_SUMMARY_MAX_CHARS)}`,
  ].filter((part): part is string => part !== null);
  const contextRefs = (input.candidateRefs ?? []).slice(0, HANDOFF_AUTO_CONTEXT_REFS);
  const sections = [
    `# 阶段目标（${def.displayName}）\n${def.goal}`,
    `# 本阶段应产出\n${def.deliverables.join('、')}`,
    handover.length === 0
      ? null
      : `# 上一阶段要点（来自状态便签与上一份报告，请核对后保留或改写）\n${handover.join('\n\n')}`,
    `# 完成判据（离开本阶段前应当能回答）\n${def.exit.reports.join('、')}；人类判断：${def.exit.humanJudgment.join('、')}`,
    '# 边界\n范围以冻结的范围版本为准；越界动作不要执行。需要人工放行的动作先申请，不要绕过。',
  ].filter((section): section is string => section !== null);
  const prompt = sections.join('\n\n');
  const suggestedSkillIds = [...SKILL_PACKS[input.toPhase]];
  const allowed = [...DEFAULT_PHASE_TOOL_ALLOW[input.toPhase]];
  const limitations = [
    '初始内容由服务端按阶段定义与当前状态生成（没有 Agent 起草）：请逐项核对、按需改写后再确认。',
    ...(contextRefs.length === 0
      ? []
      : [`已自动带入 ${String(contextRefs.length)} 条上一阶段的记忆引用（下一阶段按 id 取回详情，不必逐条编辑）。`]),
  ];
  return {
    objective,
    prompt,
    suggestedSkillIds,
    allowed,
    approvalRequired: input.approvalRequired,
    limitations,
    contextRefs,
    // 落库形状与会话工厂返回的那一版保持一致（它才是 `draft_json` 的既有形状）。
    draftJson: {
      suggestedToPhase: input.toPhase,
      suggestedSkillIds,
      objective,
      prompt,
      contextRefs,
      excludedRefs: [],
      toolCapabilitySuggestion: { allowed, approvalRequired: input.approvalRequired },
      limitations,
    },
  };
}
