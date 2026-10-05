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
 */

import type { ApprovalModeChange, ApprovalModeChangeRef, ArchiveEngagementInput, PurgeEngagementInput, PurgePreview, PurgeResult, ApprovalDetail, ApprovalRecord, BootstrapIntakeInput, BootstrapIntakeResult, BudgetExtension, CandidateAsset, ConfirmScopeProposalInput, ConfirmedScopeProposal, CreateEngagementInput, EngagementMemory, EngagementSummary, GetEngagementMemoryInput, GetScopeInput, HandoffDraft, HandoffDraftRequest, HandoffEdit, HumanAbort, HumanApprovalDecision, HumanApprovalRevocation, HumanCancel, HumanFinishTesting, HumanPause, HumanReopen, HumanResume, HumanReportSignature, HumanWorkflowService, IntakeStatus, IntakeStatusInput, Interjection, InterjectionResult, ListApprovalsInput, ListCandidateAssetsInput, ListEngagementsInput, ListWorkerSessionsInput, OpenTaskInput, OpenTaskResult, PolicyPreview, PolicyPreviewInput, PreviewScopeInput, ReportDraft, ReportVersionRef, RejectScopeProposalInput, RetryRequest, ScopeAmendment, ScopeDetail, ScopePreview, ScopeProposal, ScopeVersionRef, StartWorkerInput, StartedWorker, SystemPauseRequest, SystemWorkflowService, TransitionConfirmation, TransitionResult, UpdateEngagementMemoryInput, WorkerReportInput, WorkerSessionSummary, WorkflowSnapshot,
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

  /**
   * 策略/范围预览（§6.2.0.5）：把「现在点确认会冻结什么」完整摊给人类看。
   *
   * 三件事必须为真，否则这个端点就是在误导人：
   *   1. **同源**：与确认共用 {@link #expandForConfirmation}，因此哈希逐位相同；
   *   2. **只读**：不写库、不推进版本，可以反复刷新；
   *   3. **诚实**：解析不到的域名、非法的预设、未知的覆盖键都以 blocker 呈现，
   *      而不是「预览通过、确认时被拒」。
   *
   * 主动动作的**地址裁决**只在这里展示（`resolvedAddresses`）：真实拨号仍发生在沙箱内，
   * 服务端不做任何指向目标的连接——预览不是探测。
   */
  async previewPolicy(input: PolicyPreviewInput): Promise<PolicyPreview> {
    return this.#engagementFlow.previewPolicy(input);
  }

  // ───────────────────────── 读取 ─────────────────────────

  // ───────────────────────── 会话优先 intake ─────────────────────────

  /**
   * 打开或恢复一个隐藏 engagement 的 intake Worker。
   *
   * 该路径不写 scope_versions，也不把未确认输入当成授权；唯一可见的 Worker 能力是
   * 只读/报告/范围提案。相同租户与 clientSessionKey 通过唯一索引幂等恢复。
   */
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

  /**
   * 会话状态：这个 dsh 会话当前需要人类做什么（聊天里的「待你确认」卡片用它）。
   *
   * 反查走 `pentest.worker_session_binding_by_dsh`——与 `PgWorkerTools` 解析会话身份
   * **同一条路径**（SECURITY DEFINER、租户内自校验）。没有绑定就返回全 null：
   * 那不是错误，而是「这个会话不属于渗透作业」。
   *
   * 该函数要求租户上下文已设置（函数体里 `current_tenant_id() IS NOT NULL`），
   * 这里用的 `#d.db` 正是组合根按 `config.rlsContext` 包装的读连接——**每条查询自动带租户**。
   * 裸连接直查会拿到 0 行（实测），所以这里刻意不加"再直查一次"的兜底：
   * 两条路径要么都成要么都不成，兜底只会把失败时机推后。
   *
   * 只读：不推进任何状态，因此聊天面板可以反复轮询。
   */
  async getIntakeStatus(input: IntakeStatusInput): Promise<IntakeStatus> {
    return this.#intakeFlow.getIntakeStatus(input);
  }

  async rejectScopeProposal(input: RejectScopeProposalInput): Promise<ScopeProposal | null> {
    return this.#intakeFlow.rejectScopeProposal(input);
  }

  async confirmScopeProposal(input: ConfirmScopeProposalInput): Promise<ConfirmedScopeProposal> {
    return this.#intakeFlow.confirmScopeProposal(input);
  }

  /**
   * 创建 engagement（授权向导的落点）。
   *
   * 两步合一：写 engagement 行 + 写范围版本 1。**不创建任何会话**——
   * 设计里授权向导只建立能力边界，首个 Worker 由人类随后显式启动（§1.2）。
   *
   * 初始状态是 `READY` 而非 `AUTH_PENDING`：向导在调用本方法之前已完成授权确认
   * （它是弹窗的最后一步），因此到这里时授权已成立。`AUTH_PENDING` 是向导
   * **进行中**的界面状态，不是数据库里等待被创建的中间态——让数据库里存在一个
   * 「授权未完成」的 engagement 会引入「未授权但已存在」的窗口。
   */
  async createEngagement(input: CreateEngagementInput): Promise<EngagementSummary> {
    return this.#engagementFlow.createEngagement(input);
  }

  /**
   * 列出可管理的 engagement。
   *
   * 排序按 `updated_at` 倒序：控制台首页要优先显示最近动过的那些。
   * 默认不含 `aborted` / `failed`——它们仍在库里（审计要求），但列在首页会让
   * 列表噪声变大；需要时用 `statuses` 显式索取。
   */
  async listEngagements(input: ListEngagementsInput): Promise<readonly EngagementSummary[]> {
    return this.#engagementFlow.listEngagements(input);
  }

  /**
   * 列出某 engagement 的 Worker 会话（阶段轨道与时间轴的数据源）。
   *
   * 带全部历史指针（`previous_agent_session_id` / `retry_of_session_id` /
   * `transition_id`）：轨道要按阶段聚合、时间轴要画重做链与交接链——没有这些
   * 指针，界面只能平铺一串会话，看不出谁是谁的后继（§6.2「只画有证据的边」的
   * 前提是证据本身可得）。
   *
   * 排序按 `created_at` 升序：时间轴与轨道都按发生顺序阅读，倒序会让「回环」
   * 看起来像往回走。
   */
  async listWorkerSessions(input: ListWorkerSessionsInput): Promise<readonly WorkerSessionSummary[]> {
    return this.#engagementFlow.listWorkerSessions(input);
  }

  /**
   * 逐条预校验范围条目（授权向导的 dry-run，§13.1）。
   *
   * 用与 `loadScopeRuleSet` **同一份** `normalizeScopeEntry`：这是「同源」的
   * 唯一可靠保证——客户端若自己复制一份（或打包服务端策略模块），两份迟早漂移，
   * 表现为「界面说没问题、服务端整体拒绝」或更糟的反向情况。
   *
   * 刻意**不做整体校验**（不调 `loadScopeRuleSet`）：向导需要的是**逐行**结论，
   * 好把失败对回具体那一行让人类改。整体校验只给一个错误，人类无从下手。
   */
  async previewScope(input: PreviewScopeInput): Promise<ScopePreview> {
    return this.#engagementFlow.previewScope(input);
  }

  /**
   * 列出放行记录（放行队列的数据源，§10.3.1）。
   *
   * **必须读出完整执行内容**：`command_plan` 里的规范化目标与命令文本、
   * `target_snapshot`、`risk_summary`。§10.3.1 的 approve-what-you-see 要求
   * 人类批准的是「即将执行的那条命令」——只给状态列的读取端点无法支撑那个界面
   * （这正是此前 `getApproval` 的局限：它服务执行侧校验，只选 7 列）。
   *
   * `canResolve` 由服务端算：判据是「`pending` 且未过期且未消费」三条同时成立。
   * 让界面自己推会让过期判定的时间基准落在浏览器上，那既不一致也不可审计。
   */
  async listApprovals(input: ListApprovalsInput): Promise<readonly ApprovalDetail[]> {
    return this.#approvalFlow.listApprovals(input);
  }

  /**
   * 读公共记忆（控制台面板的数据源）。
   *
   * 未写过时返回空串而不是 null：调用方（面板的 textarea、提示词分节）都按字符串处理，
   * 多一个 null 分支就多一处可能忘记处理。
   */
  async getEngagementMemory(input: GetEngagementMemoryInput): Promise<EngagementMemory> {
    return this.#engagementFlow.getEngagementMemory(input);
  }

  /**
   * 改写公共记忆。
   *
   * 走与其它人类写操作**同一条路径**：加锁 → 记录决策 → 写库 → 推进 state_version → 审计。
   * 为什么它也算「状态推进」：这段文本会被注入之后每一个会话的提示词，因此它改变的是
   * 作业的行为边界——和切换阶段属于同一类事情，必须留下决策记录与版本印记。
   */
  async updateEngagementMemory(input: UpdateEngagementMemoryInput): Promise<EngagementMemory> {
    return this.#engagementFlow.updateEngagementMemory(input);
  }

  /**
   * 读取当前范围与历史版本（范围管理页的数据源，§5.5）。
   *
   * `getState` 只给状态机字段，不含范围——而范围管理页要显示版本、目标清单、
   * 排除项、授权依据与历史。
   */
  async getScope(input: GetScopeInput): Promise<ScopeDetail> {
    return this.#engagementFlow.getScope(input);
  }

  /**
   * 列出待裁决的候选资产（回环范围修订的输入，§5.5）。
   *
   * 带**发现来源**（`discovered_in_session_id` / `discovered_from_asset_id`）：
   * 人类需要知道每个候选是怎么来的（从哪个入口、哪次访问发现）才能判断是否纳入。
   * 只给一个主机名列表等于让人凭空决定。
   */
  async listCandidateAssets(input: ListCandidateAssetsInput): Promise<readonly CandidateAsset[]> {
    return this.#engagementFlow.listCandidateAssets(input);
  }

  // ───────────────────────── 启动首个 Worker ─────────────────────────

  /**
   * 从 READY 启动首个 Worker。
   *
   * 时序：先写库（status='starting'）→ 提交 → 创建 dsh 会话 → 回写 'active'。
   */
  async startWorker(input: StartWorkerInput): Promise<StartedWorker> {
    return this.#sessionFlow.startWorker(input);
  }

  // ───────────────────────── Worker 自报成果（工具调用，非人类） ─────────────────────────

  /**
   * Worker 提交报告：只把会话推进到等待人工，**不改阶段、不创建会话**（§1.1 P1、§7.1）。
   *
   * 这个方法由 `pentest_submit_report` 工具调用，不是人类 RPC。
   */
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

  /**
   * 重做：默认**复用当前会话**（保留推理链与前缀缓存），人类可勾选新建。
   *
   * 这是本设计与「每次重做都新建会话」的关键差别，也是成本差别（缓存命中
   * 与未命中相差数十倍）。因此默认复用，人类显式选择才新建。
   */
  async retryWorker(input: RetryRequest): Promise<TransitionResult> {
    return this.#sessionFlow.retryWorker(input);
  }

  // ───────────────────────── 阶段切换 ─────────────────────────

  /**
   * 确认阶段切换：人类编辑后的交接内容在此落地，并创建目标阶段的新顶层会话。
   *
   * 前置：交接必需键必须齐备（§7.2 的纯函数校验），否则**阻止确认**。
   */
  async confirmTransition(input: TransitionConfirmation): Promise<TransitionResult> {
    return this.#handoffFlow.confirmTransition(input);
  }

  // ───────────────────────── 运行标记（不改主状态） ─────────────────────────

  async pause(input: HumanPause): Promise<WorkflowSnapshot> {
    return this.#sessionFlow.pause(input);
  }

  /**
   * 系统自动暂停（§10.2.2 的范围违规阈值、§10.5 的预算硬阈值）。
   *
   * 复用人类暂停的**转移逻辑**（同一 `pause` 转移、同样不改主状态、不吊销租约），
   * 但决策记录的主体与类型都不同——见 `SystemWorkflowService` 的说明。
   */
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

  /**
   * 运行中插话纠偏（§6.7）。
   *
   * - 会话**运行中** → 只投递消息，**不产生状态转移**（执行次数不递增）
   * - 会话**等待人工判断** → 唤醒：写 `interject_wake` 转移，主状态回到 worker_running
   */
  async interject(input: Interjection): Promise<InterjectionResult> {
    return this.#sessionFlow.interject(input);
  }

  // ───────────────────────── 预算 ─────────────────────────

  /**
   * 追加预算并恢复会话（§10.5）。
   *
   * **不吊销租约**——暂停保留租约，否则一次预算追加会静默作废该会话全部放行凭证。
   */
  async extendBudget(input: BudgetExtension): Promise<WorkflowSnapshot> {
    return this.#sessionFlow.extendBudget(input);
  }

  // ───────────────────────── 范围修订与策略 epoch ─────────────────────────

  /**
   * 范围修订（§5.5、§6.2.0.5）：产生新范围版本与**新策略版本**，递增 `policy_epoch`，
   * 撤销仍待处理的旧凭证，并在提交后终止旧 epoch 的在途动作。
   *
   * 为什么修订必须带着策略一起走：范围是**策略快照的一部分**（`normalized_scope`），
   * 只改范围版本而不产生新策略版本，会让「策略哈希」继续描述一个已经不存在的边界。
   *
   * `policy_epoch` 与 `state_version` 分开：后者被所有人类操作推进（含暂停），
   * 拿它当策略 epoch 会让暂停作废全部放行凭证。
   */
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

  /**
   * 报告签字（§8.9）。
   *
   * **前置条件**：所有候选结论都已处置。带着未处置条目不允许出报告——
   * 这是「每条正式结论都有人工接受」这条验收点的运行时落点。
   */
  async signReport(input: HumanReportSignature): Promise<ReportVersionRef> {
    return this.#reportFlow.signReport(input);
  }

  async reopenTechnicalWork(input: HumanReopen): Promise<WorkflowSnapshot> {
    return this.#reportFlow.reopenTechnicalWork(input);
  }
}
