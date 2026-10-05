/**
 * 报告阶段的人工动作（§8.9：结束测试、签字、重新打开）
 *
 * 从 `pg-workflow.ts` 机械搬运（拆分目标：组合器只做装配与委托，流程各自成类）。
 * 方法体与拆分前逐字一致；共享原语经构造注入的 {@link WorkflowCore} 使用。
 */

import type { HumanFinishTesting, HumanReopen, HumanReportSignature, ReportDraft, ReportVersionRef, WorkflowSnapshot } from '../contracts.ts';
import { planTransition } from './transition-table.ts';
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
    await this.#core.tx(async () => {
      const engagement = await this.#core.lockEngagement(input.engagementId, input.expectedStateVersion);
      if (engagement.current_status !== 'waiting_human_review') {
        throw new WorkflowRejection(
          'classification_rejected',
          `只有等待人工判断时可以结束技术测试（当前 ${engagement.current_status}）`,
        );
      }
      const decisionId = await this.#core.recordDecision({
        engagementId: input.engagementId,
        operatorId: input.operatorId,
        decisionType: 'finish_technical_testing',
        subjectId: input.engagementId,
        decision: 'finish',
        reason: input.reason,
      });
      await this.#core.recordTransition({
        engagementId: input.engagementId,
        fromPhase: engagement.current_phase,
        toPhase: engagement.current_phase,
        fromStatus: 'waiting_human_review',
        toStatus: 'report_ready',
        type: 'complete',
        forced: false,
        sessionReused: true,
        graphIteration: toInt(engagement.graph_iteration, 'graph_iteration'),
        fromScopeVersion: null,
        toScopeVersion: null,
        fromSessionId: engagement.active_agent_session_id,
        toSessionId: null,
        expectedVersion: input.expectedStateVersion,
        humanDecisionId: decisionId,
        handoffId: null,
        reason: input.reason,
      });
      await this.#core.updateEngagement({
        engagementId: input.engagementId,
        expectedVersion: input.expectedStateVersion,
        currentStatus: 'report_ready',
        activeSessionId: null,
      });
      await this.#core.audit(input.engagementId, null, 'report.draft.generated', {});
    });
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
      await this.#core.recordTransition({
        engagementId: input.engagementId,
        fromPhase: engagement.current_phase,
        toPhase: engagement.current_phase,
        fromStatus: 'report_ready',
        toStatus: 'complete',
        type: 'complete',
        forced: false,
        sessionReused: true,
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
      if (!planned.ok) throw new WorkflowRejection(planned.code, planned.message);
      const decisionId = await this.#core.recordDecision({
        engagementId: input.engagementId,
        operatorId: input.operatorId,
        decisionType: 'reopen_technical_work',
        subjectId: input.engagementId,
        decision: 'reopen',
        reason: input.reason,
      });
      await this.#core.recordTransition({
        engagementId: input.engagementId,
        fromPhase: engagement.current_phase,
        toPhase: engagement.current_phase,
        fromStatus: 'report_ready',
        toStatus: 'worker_running',
        type: 'report_reopen',
        forced: false,
        sessionReused: true,
        graphIteration: toInt(engagement.graph_iteration, 'graph_iteration'),
        fromScopeVersion: null,
        toScopeVersion: null,
        fromSessionId: null,
        toSessionId: engagement.active_agent_session_id,
        expectedVersion: input.expectedStateVersion,
        humanDecisionId: decisionId,
        handoffId: null,
        reason: input.reason,
      });
      await this.#core.updateEngagement({
        engagementId: input.engagementId,
        expectedVersion: input.expectedStateVersion,
        currentStatus: 'worker_running',
      });
    });
    return this.#core.getState(input.engagementId);
  }
}
