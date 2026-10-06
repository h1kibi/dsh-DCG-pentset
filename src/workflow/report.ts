/**
 * 报告阶段的人工动作（§8.9：结束测试、签字、重新打开）
 *
 * 从 `pg-workflow.ts` 机械搬运（拆分目标：组合器只做装配与委托，流程各自成类）。
 * 方法体与拆分前逐字一致；共享原语经构造注入的 {@link WorkflowCore} 使用。
 */

import type { HumanFinishTesting, HumanReopen, HumanReportSignature, ReportDraft, ReportVersionRef, WorkflowSnapshot } from '../contracts.ts';
import { planTransition } from './transition-table.ts';
import { runActionAvailability } from '../contracts.ts';
import { WorkflowRejection, toInt } from './model.ts';
import type { WorkflowCore } from './core.ts';

export class ReportFlow {
  readonly #core: WorkflowCore;

  constructor(core: WorkflowCore) {
    this.#core = core;
  }

  // ───────────────────────── 报告 ─────────────────────────

  async finishTechnicalTesting(input: HumanFinishTesting): Promise<ReportDraft> {
    if (this.#core.deps.report === undefined) {
      throw new WorkflowRejection('classification_rejected', '未配置报告服务，无法生成报告草稿');
    }
    // 需要关闭的活动会话（worker_running 那条边才有）。必须在事务提交后处理：
    // 租约端口用**自己的连接**去锁 `worker_sessions`，嵌进事务会自锁死（与 startWorker 同因）。
    let sessionToClose: string | null = null;
    await this.#core.tx(async () => {
      const engagement = await this.#core.lockEngagement(input.engagementId, input.expectedStateVersion);
      // §5.2 有**两条**边指向 report_ready：`waiting_human_review`（Agent 已交报告）与
      // `worker_running`（Agent 还在跑，人类决定就此收工）。后者此前在图上有边、代码里
      // 无实现（`validateGraph` 查得出「有边但没实现」却查不出反过来），这里是它的落点。
      // 判定与客户端**共用**契约层的单源（`runActionAvailability.canFinishTesting`）：
      // 暂停 / 阻塞 / 终止 / 失败 / 已签字导出的作业都不能从这里离开当前状态。
      const availability = runActionAvailability({
        mainStatus: engagement.current_status,
        runMarker: engagement.status,
        activeWorkerSessionId: engagement.active_agent_session_id,
      });
      if (!availability.canFinishTesting) {
        throw new WorkflowRejection(
          'classification_rejected',
          engagement.current_status === 'complete'
            ? '作业已签字导出（complete），不能再次结束技术测试'
            : `只有「Agent 正在运行」或「等待人工判断」（且运行标记为 running）时可以结束技术测试` +
              `（当前主状态 ${engagement.current_status}、运行标记 ${engagement.status}）`,
        );
      }
      // §13.8 的第二步：**确认没有运行中的动作与待决的高风险放行**。
      // 放行也不行：在途工具跑着的时候把作业推进 `report_ready`，会把那条执行留在半空
      // （沙箱还在跑、工具运行行永远停在 running），而这份作业已经宣布「技术测试结束」。
      // 待决与已批未消费的凭证同理——它们是**还没有兑现的人类授权**，人类得先处置它们。
      const pending = await this.#core.deps.txDb.query<{
        running_tool_runs: number;
        pending_approvals: number;
        live_approvals: number;
      }>(
        // `pending` 这一道必须**带过期过滤**：过期的待决凭证谁也处置不了——人类入口
        // （`resolveApproval` / `revokeApproval`）对已过期一律抛 `approval_expired`，
        // 界面把它置为不可交互，而唯一会写 `decision='expired'` 的对账判定
        // （`reconcileApproval`）没有生产调用方。少了这个过滤，「Agent 申请放行 → 人类
        // 忘了处理 → 过期」会让**结束技术测试永久被拒**（2026-10-05 质检发现）。
        // 与第三道查询（approved 未消费）同一口径：只算**还能被处置或兑现**的凭证。
        `select
           (select count(*)::int from pentest.tool_runs
             where engagement_id = $1::uuid and status = 'running') as running_tool_runs,
           (select count(*)::int from pentest.approvals
             where engagement_id = $1::uuid and decision = 'pending'
               and (expires_at is null or expires_at > now())) as pending_approvals,
           (select count(*)::int from pentest.approvals
             where engagement_id = $1::uuid and decision = 'approved' and consumed_at is null
               and (expires_at is null or expires_at > now())) as live_approvals`,
        [input.engagementId],
      );
      const row = pending.rows[0];
      const blockers: string[] = [];
      if ((row?.running_tool_runs ?? 0) > 0) blockers.push(`${row?.running_tool_runs} 个运行中的工具执行`);
      if ((row?.pending_approvals ?? 0) > 0) blockers.push(`${row?.pending_approvals} 条待决放行`);
      if ((row?.live_approvals ?? 0) > 0) blockers.push(`${row?.live_approvals} 条已批准未消费的放行凭证`);
      if (blockers.length > 0) {
        throw new WorkflowRejection(
          'classification_rejected',
          `还不能结束技术测试（§13.8）：${blockers.join('、')}。` +
            '在放行队列里处置或撤销那些凭证；工具执行则等它结束。' +
            '若一条执行**已经不可能结束**（例如宿主在它运行中途重启过，而会话租约仍被心跳续着），' +
            '受支持的出口是终止该作业——对账只结算超过 16 分钟的执行，且要求该作业进入扫描集合。',
        );
      }
      if (engagement.current_status === 'worker_running') {
        const activeId = engagement.active_agent_session_id;
        if (activeId !== null) {
          const session = await this.#core.loadSession(activeId);
          if (session !== null) sessionToClose = session.id;
        }
      }
      await this.#core.recordDecision({
        engagementId: input.engagementId,
        operatorId: input.operatorId,
        decisionType: 'finish_technical_testing',
        subjectId: input.engagementId,
        decision: 'finish',
        reason: input.reason,
      });
      // 该边在状态图上标记为 `recorded: false`（§5.4 / §13.8）：**不写** `state_transitions`
      // 行。此前这里写的是 `type: 'complete'`——那属于 `report_ready → complete`（签字导出），
      // 于是账本里出现图上不存在的组合，且「结束测试」与「签字导出」按 transition_type
      // 不可区分（2026-10-05 复核 REQ-8a）。本步的留痕由 human_decisions 与领域事件
      // `report.draft.generated` 承担。
      await this.#core.updateEngagement({
        engagementId: input.engagementId,
        expectedVersion: input.expectedStateVersion,
        currentStatus: 'report_ready',
        activeSessionId: null,
      });
      await this.#core.audit(input.engagementId, null, 'report.draft.generated', {});
    });
    // 事务已提交：把仍在运行的会话收进终态（`closed`）并吊销它的租约。
    // 不这样做的话，人类「结束技术测试」之后 Agent 还会继续烧预算，而它的提交
    // 会在 `active_agent_session_id` 已被清空时被拒——现场表现为「Agent 还在说话，
    // 但交上来的东西一律被拒」。
    //
    // **收尾失败不回滚、也不抛**：主状态已经是 `report_ready`，把它包装成「结束测试失败」
    // 会让人以为要重试，而重试会撞在 `report_ready` 上（已不是合法起点）——两处事实相反。
    // 处置与 `deliverApprovalNotice` 同形：副作用失败只留痕，事实不因它改变。
    // 遗留的存活会话由启动对账（§17.2）与诊断卡片可见。
    if (sessionToClose !== null) {
      try {
        await this.#core.closeSession(sessionToClose, 'closed', '人类结束技术测试');
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        console.warn(
          `[dsh-pentest] 结束技术测试后收掉在跑的会话失败（会话 ${sessionToClose}）：${detail}。` +
            '状态已是 report_ready；该会话仍是存活态，按 §17.2 需要人工或对账处置。',
        );
        try {
          await this.#core.audit(input.engagementId, sessionToClose, 'workflow.close_session_failed', { detail });
        } catch {
          // 连审计都写不进：上面的 console.warn 已经把事实说全，不掩盖「动作其实已完成」。
        }
      }
    }
    return this.#core.deps.report.getReportDraft(input.engagementId);
  }

  /**
   * 报告签字（§8.9）。
   *
   * **前置条件**：所有候选结论都已处置。带着未处置条目不允许出报告——
   * 这是「每条正式结论都有人工接受」这条验收点的运行时落点。
   */
  async signReport(input: HumanReportSignature): Promise<ReportVersionRef> {
    const reportSignature = this.#core.deps.reportSignature;
    if (reportSignature === undefined) {
      throw new WorkflowRejection('classification_rejected', '未配置报告签字服务，无法签字');
    }

    let version = 0;
    let hash = '';
    await this.#core.tx(async () => {
      // 工作流状态写入先锁 engagement；报告服务随后取得同一 engagement 的 advisory lock。
      // 报告编辑/结论处置只取得 advisory lock，不反向持有 engagement 行锁，避免死锁环。
      const engagement = await this.#core.lockEngagement(input.engagementId, input.expectedStateVersion);
      const snapshot = await reportSignature.getSignatureSnapshot(input.engagementId);
      if (engagement.current_status !== 'report_ready') {
        throw new WorkflowRejection(
          'classification_rejected',
          `只有报告就绪状态可以签字（当前 ${engagement.current_status}）`,
        );
      }
      if (snapshot.undisposed.length > 0) {
        throw new WorkflowRejection(
          'handoff_incomplete',
          `还有 ${snapshot.undisposed.length} 条候选结论未处置，不能签字：${snapshot.undisposed
            .slice(0, 5)
            .map((finding) => finding.title)
            .join('、')}`,
        );
      }
      if (snapshot.report === null) {
        throw new WorkflowRejection('classification_rejected', '没有可签字的报告版本，拒绝使用客户端哈希代替报告事实');
      }
      if (input.contentHash !== snapshot.report.contentHash) {
        throw new WorkflowRejection(
          'stale_state_version',
          `报告版本已变化或签字哈希不匹配：客户端 ${input.contentHash}，服务端 ${snapshot.report.contentHash}。请刷新报告后重试。`,
        );
      }

      const signed = await reportSignature.signReportVersion({
        engagementId: input.engagementId,
        version: snapshot.report.version,
        contentHash: snapshot.report.contentHash,
        operatorId: input.operatorId,
      });

      const decisionId = await this.#core.recordDecision({
        engagementId: input.engagementId,
        operatorId: input.operatorId,
        decisionType: 'sign_report',
        subjectId: signed.contentHash,
        decision: 'signed',
        reason: '报告签字并导出',
      });
      const planned = planTransition({
        type: 'complete',
        fromStatus: 'report_ready',
        toStatus: 'complete',
      });
      this.#core.assertPlan(planned);
      await this.#core.recordPlannedTransition({
        plan: planned.plan,
        engagementId: input.engagementId,
        fromPhase: engagement.current_phase,
        toPhase: engagement.current_phase,
        graphIteration: toInt(engagement.graph_iteration, 'graph_iteration'),
        fromScopeVersion: null,
        toScopeVersion: null,
        fromSessionId: null,
        toSessionId: null,
        expectedVersion: input.expectedStateVersion,
        humanDecisionId: decisionId,
        handoffId: null,
        reason: '报告签字并导出',
      });
      await this.#core.updateEngagement({
        engagementId: input.engagementId,
        expectedVersion: input.expectedStateVersion,
        currentStatus: 'complete',
      });
      await this.#core.audit(input.engagementId, null, 'report.signed', { by: input.operatorId });
      version = snapshot.report.version;
      hash = snapshot.report.contentHash;
    });
    return { engagementId: input.engagementId, version, contentHash: hash };
  }

  async reopenTechnicalWork(input: HumanReopen): Promise<WorkflowSnapshot> {
    await this.#core.tx(async () => {
      const engagement = await this.#core.lockEngagement(input.engagementId, input.expectedStateVersion);
      if (engagement.current_status !== 'report_ready') {
        throw new WorkflowRejection(
          'classification_rejected',
          `只有报告就绪状态可以返回补充技术动作（当前 ${engagement.current_status}）`,
        );
      }
      const planned = planTransition({
        type: 'report_reopen',
        fromStatus: 'report_ready',
        toStatus: 'worker_running',
      });
      this.#core.assertPlan(planned);
      // AD-1（2026-10-05 复核）：重新挂回最后一个非终态会话并置回 active——
      // 否则作业停在 worker_running 却没有活动会话，补充技术动作无法开始。
      const session = await this.#core.reopenLastSession(input.engagementId);
      if (session === null) {
        throw new WorkflowRejection(
          'classification_rejected',
          '没有可复用的会话：本作业的非终态会话都已终结，无法回到补充技术动作。' +
            '常见原因：结束技术测试时 Agent 还在跑——那条会话会被收起（避免它继续烧预算与接触目标）。' +
            '此时请签字导出，或先终止本作业再另开一个。',
        );
      }
      const decisionId = await this.#core.recordDecision({
        engagementId: input.engagementId,
        operatorId: input.operatorId,
        decisionType: 'reopen_technical_work',
        subjectId: input.engagementId,
        decision: 'reopen',
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
        toSessionId: session.sessionId,
        expectedVersion: input.expectedStateVersion,
        humanDecisionId: decisionId,
        handoffId: null,
        reason: input.reason,
      });
      await this.#core.updateEngagement({
        engagementId: input.engagementId,
        expectedVersion: input.expectedStateVersion,
        currentStatus: 'worker_running',
        activeSessionId: session.sessionId,
      });
    });
    return this.#core.getState(input.engagementId);
  }
}
