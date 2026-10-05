/**
 * 人类工作流服务（组合器）：把各流程类接到一个实例上，保持公开 API 与拆分前**逐字一致**。
 *
 * 实现分布：
 *   - 领域类型与纯函数 → `model.ts`
 *   - 事务原语 / 审计 / 装载器 / 策略展开 → `core.ts` 的 `WorkflowCore`
 *   - 各流程 → `intake.ts` / `engagement.ts` / `sessions.ts` / `handoff.ts` /
 *     `scope.ts` / `approvals.ts` / `report.ts`
 *   - 读投影 `getState` / `getScopeProposal` 在核心（多流程内部调用）
 *
 * 本文件不再包含任何业务判定；一切行为应与拆分前逐字等价。
 *
 * **方法级文档在流程文件里**（本文件的每个方法只做一行委托）：需要了解某个动作的语义、
 * 顺序约束或不变量，去 `intake.ts` / `engagement.ts` / `sessions.ts` / `handoff-flow.ts` /
 * `scope.ts` / `approvals.ts` / `report.ts` 找同名方法——此前本文件把那些 JSDoc 抄了一遍
 * （102 行逐字重复，2026-10-05 复核删除），两处漂移过就没人知道该信哪份。
 */

import type { ApprovalModeChange, ApprovalModeChangeRef, ArchiveEngagementInput, PurgeEngagementInput, PurgePreview, PurgeResult, ApprovalDetail, ApprovalRecord, BootstrapIntakeInput, BootstrapIntakeResult, BudgetExtension, CandidateAsset, ConfirmScopeProposalInput, ConfirmedScopeProposal, CreateEngagementInput, EngagementMemory, EngagementSummary, GetEngagementMemoryInput, GetScopeInput, HandoffDraft, HumanAbort, HumanApprovalDecision, HumanApprovalRevocation, HumanCancel, HumanFinishTesting, HumanPause, HumanReopen, HumanResume, HumanReportSignature, HumanWorkflowService, IntakeStatus, IntakeStatusInput, Interjection, InterjectionResult, ListApprovalsInput, ListCandidateAssetsInput, ListEngagementsInput, ListWorkerSessionsInput, OpenTaskInput, OpenTaskResult, PolicyPreview, PolicyPreviewInput, PreviewScopeInput, ReportDraft, ReportVersionRef, RejectScopeProposalInput, RetryRequest, ScopeAmendment, ScopeDetail, ScopePreview, ScopeProposal, ScopeVersionRef, StartWorkerInput, StartedWorker, SystemPauseRequest, SystemWorkflowService, TransitionConfirmation, TransitionResult, UpdateEngagementMemoryInput, WorkerReportInput, WorkerSessionSummary, WorkflowSnapshot,
  Phase,
} from '../contracts.ts';
import type { WorkflowServiceDeps } from './model.ts';
import { WorkflowCore } from './core.ts';
import { IntakeFlow } from './intake.ts';
import { EngagementFlow } from './engagement.ts';
import { SessionFlow } from './sessions.ts';
import { HandoffFlow } from './handoff-flow.ts';
import { ScopeAmendmentFlow } from './scope.ts';
import { ApprovalFlow } from './approvals.ts';
import { ReportFlow } from './report.ts';

export class PgWorkflowService implements HumanWorkflowService, SystemWorkflowService {
  readonly #core: WorkflowCore;
  readonly #intakeFlow: IntakeFlow;
  readonly #engagementFlow: EngagementFlow;
  readonly #sessionFlow: SessionFlow;
  readonly #handoffFlow: HandoffFlow;
  readonly #scopeAmendmentFlow: ScopeAmendmentFlow;
  readonly #approvalFlow: ApprovalFlow;
  readonly #reportFlow: ReportFlow;

  constructor(deps: WorkflowServiceDeps) {
    const core = new WorkflowCore(deps);
    this.#core = core;
    this.#intakeFlow = new IntakeFlow(core);
    this.#engagementFlow = new EngagementFlow(core);
    this.#sessionFlow = new SessionFlow(core);
    this.#handoffFlow = new HandoffFlow(core);
    this.#scopeAmendmentFlow = new ScopeAmendmentFlow(core);
    this.#approvalFlow = new ApprovalFlow(core);
    this.#reportFlow = new ReportFlow(core);
  }

  async getScopeProposal(engagementId: string): Promise<ScopeProposal | null> {
    return this.#core.getScopeProposal(engagementId);
  }

  async getState(engagementId: string): Promise<WorkflowSnapshot> {
    return this.#core.getState(engagementId);
  }

  async previewPolicy(input: PolicyPreviewInput): Promise<PolicyPreview> {
    return this.#engagementFlow.previewPolicy(input);
  }

  // ───────────────────────── 读取 ─────────────────────────

  // ───────────────────────── 会话优先 intake ─────────────────────────

  async openTask(input: OpenTaskInput): Promise<OpenTaskResult> {
    return this.#intakeFlow.openTask(input);
  }

  /**
   * 把**当前会话**登记为某作业的 intake（「会话即 intake」）。
   *
   * ── 与 `openTask` 的区别 ──
   *
   * `openTask` 由控制台调用：它派生 `dsh-<workerSessionId>` 并**新建**一个 dsh 会话。
   * 本方法由**正在对话的那个会话里的 Agent** 调用，会话已经存在，因此：
   *   - `dsh_session_id` 记录**调用方的真实标识**（不派生、不新建）；
   *   - 不做 `ctx.agents.create`——那会再起一个会话，而人正在跟眼前这个说话。
   *
   * 这解决的正是那个死角：聊天里发起渗透任务时，工具面看得见却没有作业可归属，
   * 而旧实现只能让人类去控制台手动建（见 `workerSessionIdOf` 的长注释）。
   *
   * ── 安全边界没有放松 ──
   *
   * 只创建 **`auth_pending` + 范围版本 0** 的作业。**不接受**任何「已确认」入参，
   * 也不写范围版本——确认必须由人类在控制台点（`confirmScopeProposal`）。
   * 因此 Agent 自建作业**拿不到任何执行能力**：执行仍要范围版本 + 逐次放行 + 沙箱三道。
   *
   * ── 幂等 ──
   *
   * 客户端键由 dsh 会话标识派生（`session:<id>`），同一会话反复调用收敛到同一个作业；
   * 与 `openTask` 用浏览器键收敛是同一条机制（含同一条 advisory 锁与部分唯一索引）。
   */
  async bootstrapIntake(input: BootstrapIntakeInput): Promise<BootstrapIntakeResult> {
    return this.#intakeFlow.bootstrapIntake(input);
  }

  async getIntakeStatus(input: IntakeStatusInput): Promise<IntakeStatus> {
    return this.#intakeFlow.getIntakeStatus(input);
  }

  async rejectScopeProposal(input: RejectScopeProposalInput): Promise<ScopeProposal | null> {
    return this.#intakeFlow.rejectScopeProposal(input);
  }

  async confirmScopeProposal(input: ConfirmScopeProposalInput): Promise<ConfirmedScopeProposal> {
    return this.#intakeFlow.confirmScopeProposal(input);
  }

  async createEngagement(input: CreateEngagementInput): Promise<EngagementSummary> {
    return this.#engagementFlow.createEngagement(input);
  }

  async listEngagements(input: ListEngagementsInput): Promise<readonly EngagementSummary[]> {
    return this.#engagementFlow.listEngagements(input);
  }

  async listWorkerSessions(input: ListWorkerSessionsInput): Promise<readonly WorkerSessionSummary[]> {
    return this.#engagementFlow.listWorkerSessions(input);
  }

  async previewScope(input: PreviewScopeInput): Promise<ScopePreview> {
    return this.#engagementFlow.previewScope(input);
  }

  async listApprovals(input: ListApprovalsInput): Promise<readonly ApprovalDetail[]> {
    return this.#approvalFlow.listApprovals(input);
  }

  async getEngagementMemory(input: GetEngagementMemoryInput): Promise<EngagementMemory> {
    return this.#engagementFlow.getEngagementMemory(input);
  }

  async updateEngagementMemory(input: UpdateEngagementMemoryInput): Promise<EngagementMemory> {
    return this.#engagementFlow.updateEngagementMemory(input);
  }

  async getScope(input: GetScopeInput): Promise<ScopeDetail> {
    return this.#engagementFlow.getScope(input);
  }

  async listCandidateAssets(input: ListCandidateAssetsInput): Promise<readonly CandidateAsset[]> {
    return this.#engagementFlow.listCandidateAssets(input);
  }

  // ───────────────────────── 启动首个 Worker ─────────────────────────

  async startWorker(input: StartWorkerInput): Promise<StartedWorker> {
    return this.#sessionFlow.startWorker(input);
  }

  // ───────────────────────── Worker 自报成果（工具调用，非人类） ─────────────────────────

  async finishWorker(input: { workerSessionId: string; report: WorkerReportInput }): Promise<WorkflowSnapshot> {
    return this.#sessionFlow.finishWorker(input);
  }

  // ───────────────────────── 交接草稿与切换 ─────────────────────────

  async beginHandoff(input: {
    readonly workerSessionId: string;
    readonly operatorId: string;
    readonly toPhase?: Phase;
  }): Promise<HandoffDraft> {
    return this.#handoffFlow.beginHandoff(input);
  }

  async currentHandoffDraft(input: { readonly workerSessionId: string }): Promise<HandoffDraft | null> {
    return this.#handoffFlow.currentHandoffDraft(input);
  }

  async cancelHandoff(input: HumanCancel): Promise<WorkflowSnapshot> {
    return this.#handoffFlow.cancelHandoff(input);
  }

  // ───────────────────────── 重做 ─────────────────────────

  async retryWorker(input: RetryRequest): Promise<TransitionResult> {
    return this.#sessionFlow.retryWorker(input);
  }

  // ───────────────────────── 阶段切换 ─────────────────────────

  async confirmTransition(input: TransitionConfirmation): Promise<TransitionResult> {
    return this.#handoffFlow.confirmTransition(input);
  }

  // ───────────────────────── 运行标记（不改主状态） ─────────────────────────

  async pause(input: HumanPause): Promise<WorkflowSnapshot> {
    return this.#sessionFlow.pause(input);
  }

  async pauseForSystem(input: SystemPauseRequest): Promise<WorkflowSnapshot> {
    return this.#sessionFlow.pauseForSystem(input);
  }

  async resume(input: HumanResume): Promise<WorkflowSnapshot> {
    return this.#sessionFlow.resume(input);
  }

  async abort(input: HumanAbort): Promise<WorkflowSnapshot> {
    return this.#sessionFlow.abort(input);
  }

  // ───────────────────────── 插话 ─────────────────────────

  async interject(input: Interjection): Promise<InterjectionResult> {
    return this.#sessionFlow.interject(input);
  }

  // ───────────────────────── 预算 ─────────────────────────

  async extendBudget(input: BudgetExtension): Promise<WorkflowSnapshot> {
    return this.#sessionFlow.extendBudget(input);
  }

  // ───────────────────────── 范围修订与策略 epoch ─────────────────────────

  async amendScope(input: ScopeAmendment): Promise<ScopeVersionRef> {
    return this.#scopeAmendmentFlow.amendScope(input);
  }

  async setApprovalMode(input: ApprovalModeChange): Promise<ApprovalModeChangeRef> {
    return this.#engagementFlow.setApprovalMode(input);
  }

  async archiveEngagement(input: ArchiveEngagementInput): Promise<EngagementSummary> {
    return this.#engagementFlow.archiveEngagement(input);
  }

  async previewEngagementPurge(input: { readonly engagementId: string }): Promise<PurgePreview> {
    return this.#engagementFlow.previewEngagementPurge(input);
  }

  async purgeEngagement(input: PurgeEngagementInput): Promise<PurgeResult> {
    return this.#engagementFlow.purgeEngagement(input);
  }

  async decideApproval(input: HumanApprovalDecision): Promise<ApprovalRecord> {
    return this.#approvalFlow.decideApproval(input);
  }

  async revokeApproval(input: HumanApprovalRevocation): Promise<ApprovalRecord> {
    return this.#approvalFlow.revokeApproval(input);
  }

  // ───────────────────────── 报告 ─────────────────────────

  async finishTechnicalTesting(input: HumanFinishTesting): Promise<ReportDraft> {
    return this.#reportFlow.finishTechnicalTesting(input);
  }

  async signReport(input: HumanReportSignature): Promise<ReportVersionRef> {
    return this.#reportFlow.signReport(input);
  }

  async reopenTechnicalWork(input: HumanReopen): Promise<WorkflowSnapshot> {
    return this.#reportFlow.reopenTechnicalWork(input);
  }
}
