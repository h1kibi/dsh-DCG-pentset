/**
 * 客户端控制器：控制台的状态来源与动作入口。
 *
 * 设计依据：docs/dsh-pentest-plugin-design.md §6.2.3、§15.3、§15.4
 *
 * ── 三个设计约束 ──
 *
 * 1. **不持有权威状态**。UI 展示的一切都来自 Host RPC 返回的快照；控制器只缓存
 *    最近一次读到的结果供渲染。§4.1 已定「客户端不持有独立状态」——本地只保留
 *    纯展示状态（展开项、跟随开关这类，放在组件里，不在这里）。
 *
 * 2. **订阅形状取 uSES 惯例**（`getSnapshot` + `subscribe`）。React 的
 *    `useSyncExternalStore` 直接吃这个形状，无需额外适配；也让控制器能在没有
 *    React 的环境里被测试。
 *
 * 3. **写操作带乐观锁与幂等键**（§15.3、§15.4）。控制器负责**生成并复用**幂等键：
 *    一次新点击生成新键，同一操作的重试复用旧键——这个区分只有控制器知道
 *    （它知道「这是用户又点了一次」还是「上一次没收到响应」）。视图只管调用。
 */

import type { ConsoleCallResult, ConsoleCallInput } from '../console/client.ts';
import { ConsoleClient } from '../console/client.ts';
import type { HostInvoker } from '../console/client.ts';
import type { ConsoleMethodName } from '../console/method-names.ts';
import type { WorkerReportView, PurgePreview,
  ApprovalModeChange,
  ArchiveEngagementInput,
  PurgeEngagementInput,
  StartWorkerInput,
  TransitionConfirmation,
  RetryRequest,
  BudgetExtension,
  HumanApprovalDecision,
  HumanApprovalRevocation,
  HandoffDraft,
  EngagementMemory,
  ScopeAmendment,
  UpdateEngagementMemoryInput,
  EngagementSummary,
  Finding,
  IntakeStatus,
  ApprovalDetail,
  MainStatus,
  CandidateAsset,
  DiagnosticsSnapshot,
  MemoryRecord,
  LedgerVerificationView,
  MemorySearchResultSet,
  MemoryWatermark,
  ReportDraft,
  ExportRequest,
  ExportResult,
  FindingDisposition,
  SkillAddRequest,
  SkillRemoveRequest,
  SkillUpdateRequest,
  Phase,
  PolicyPreview,
  PolicyPreviewInput,
  PreviewScopeInput,
  ScopeDetail,
  ScopePreview,
  SkillSummary,
  TrustLevel,
  WorkflowSnapshot,
  WorkerSessionSummary,
  CreateEngagementInput,
  ScopeProposal,
  ConfirmScopeProposalInput,
  RejectScopeProposalInput,
  OpenTaskResult,
  NetworkAsset,
} from '../contracts.ts';

/** 控制器对外暴露的只读快照。 */
export interface ConsoleSnapshot {
  readonly engagements: readonly EngagementSummary[];
  readonly selectedEngagementId: string | null;
  readonly state: WorkflowSnapshot | null;
  readonly sessions: readonly WorkerSessionSummary[];
  readonly intake?: OpenTaskResult | null;
  readonly scopeProposal?: ScopeProposal | null;
  readonly loading: boolean;
  readonly lastError: { readonly code: string; readonly message: string } | null;
  readonly conflict: boolean;
  readonly loadedAt: string | null;
}

/** 控制器内部使用的枚举函数：返回 uSES 兼容的 `{getSnapshot, subscribe}` 形状。 */
interface Readable<T> {
  getSnapshot(): T;
  subscribe(listener: () => void): () => void;
}

const EMPTY: ConsoleSnapshot = {
  engagements: [],
  selectedEngagementId: null,
  state: null,
  sessions: [],
  intake: null,
  scopeProposal: null,
  loading: false,
  lastError: null,
  conflict: false,
  loadedAt: null,
};

export interface ConsoleControllerDeps {
  /** 调用 Host 的函数（真实实现包 `ctx.connection.rpc.call`）。 */
  readonly invoke: HostInvoker;
  readonly channel?: string;
  readonly clock?: () => Date;
  /**
   * intake 会话键。省略时按 {@link loadClientSessionKey} 从浏览器存储恢复或新建。
   *
   * 存在的意义是**嵌入方与测试**可以钉住这个身份：键一变，`openTask` 就会指向另一个
   * 作业（新建而非恢复），那是对审计有影响的行为，不该只能靠副作用观察。
   */
  readonly clientSessionKey?: string;
}

/**
 * intake 会话键在浏览器存储里的位置。
 *
 * ── 为什么必须持久化 ──
 *
 * `openTask` 以 `(tenant_id, client_session_key)` 查重：命中即**恢复**该 intake
 * （`resumed: true`），未命中才 INSERT 一条新 engagement。此前这个键在
 * `ConsoleController` 构造时每次重新随机生成，于是浏览器每次刷新都换键、每次都新建作业：
 * 实测刷新几次就把库从 5 条推到 8 条 `auth_pending`，**每条都挂着活动 Worker 会话与租约**，
 * 而运行时只锁定其中一条，其余的既用不上又要一直维护——「服务用不了」的观感有一半来自这里。
 *
 * ── 为什么按浏览器共享，而不是按标签页 ──
 *
 * 运行时是单 engagement 锁定：两个标签页各自建 intake 只会把对方挤成不可用。
 * `localStorage` 的作用域正是「同源的这台浏览器」，与这个语义一致。
 */
const CLIENT_SESSION_KEY_STORAGE = 'dsh-pentest.client-session-key';

/**
 * 取本浏览器的 intake 会话键：已有则复用，没有则新建并记住。
 *
 * 读不到 `localStorage`（隐私模式、存储被禁用、非浏览器环境）时**退回旧行为**——
 * 每次新建、刷新会多留一个 intake——而不是抛错：控制台仍然可用，代价只是没有幂等收敛。
 * 这条降级路径必须有，因为测试环境（Node，无存储）与真实浏览器共用这个构造函数。
 */
function loadClientSessionKey(clock: () => Date): string {
  // 先算好「新建时该用什么」：它没有副作用（纯时间戳 + 随机），因此即便下面走的是
  // 「复用已有键」的分支，多算一次也不改变任何可观察行为。
  const created = `web-${String(clock().getTime())}-${Math.random().toString(36).slice(2, 10)}`;
  try {
    const storage = globalThis.localStorage;
    if (storage === undefined) return created;
    const existing = storage.getItem(CLIENT_SESSION_KEY_STORAGE);
    if (existing !== null && existing.trim() !== '') return existing;
    storage.setItem(CLIENT_SESSION_KEY_STORAGE, created);
    return created;
  } catch {
    return created;
  }
}

export class ConsoleController implements Readable<ConsoleSnapshot> {
  readonly #client: ConsoleClient;
  readonly #clock: () => Date;
  readonly #clientSessionKey: string;
  #openTaskInFlight: Promise<ConsoleCallResult> | null = null;
  readonly #listeners = new Set<() => void>();
  #snapshot: ConsoleSnapshot = EMPTY;
  #counter = 0;

  constructor(deps: ConsoleControllerDeps) {
    this.#client = new ConsoleClient(
      deps.channel === undefined ? { invoke: deps.invoke } : { invoke: deps.invoke, channel: deps.channel },
    );
    this.#clock = deps.clock ?? (() => new Date());
    this.#clientSessionKey = deps.clientSessionKey ?? loadClientSessionKey(this.#clock);
  }

  getSnapshot(): ConsoleSnapshot {
    return this.#snapshot;
  }

  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  #emit(next: Partial<ConsoleSnapshot>): void {
    this.#snapshot = { ...this.#snapshot, ...next };
    for (const listener of this.#listeners) listener();
  }

  /**
   * 生成一个新的幂等键。
   *
   * 用时间戳 + 计数器而不是 `crypto.randomUUID`：后者只在**安全上下文**可用，
   * 而本地 `http://localhost` 开发环境不是安全上下文——那会让本地调试时所有
   * 写操作抛错。计数器保证同一毫秒内的多次调用也不重复。
   */
  newKey(prefix = 'ui'): string {
    this.#counter += 1;
    return `${prefix}-${String(this.#clock().getTime())}-${String(this.#counter)}`;
  }

  // ───────────────────────── 读 ─────────────────────────

  /**
   * 拉取 engagement 列表。
   *
   * **连归档一起读**：控制台的「显示已归档」开关在本地过滤（一次请求拿到全量，
   * 切换开关不再往返）；服务端的默认仍是隐藏归档，脚本/API 侧不受影响。
   */
  async refreshEngagements(): Promise<void> {
    // **必须显式给全部运行标记**：服务端省略 `statuses` 时默认只返回 running/paused/blocked，
    // 于是「终止」过的作业会从列表里凭空消失——人类既看不到也点不到它（2026-10-05 实测报障：
    // 「终止后似乎就清理了，找不到了」）。列表要展示历史，隐藏由「显示已归档」开关负责。
    await this.#read(
      'listEngagements',
      { includeArchived: true, statuses: ['running', 'paused', 'blocked', 'aborted', 'failed'] },
      (result) => ({
      engagements: Array.isArray(result) ? (result as readonly EngagementSummary[]) : [],
    }));
  }

  /** 挂载即打开或恢复隐藏 intake；同一 controller 生命周期内共享一个请求。 */
  async openTask(): Promise<ConsoleCallResult> {
    if (this.#openTaskInFlight !== null) return this.#openTaskInFlight;
    const promise = this.#call({
      method: 'openTask',
      params: { clientSessionKey: this.#clientSessionKey },
      reason: '打开渗透作业并进入授权范围 intake',
      idempotencyKey: this.newKey('open-task'),
      expectedStateVersion: 0,
    }).then(async (result) => {
      if (result.ok) {
        const intake = result.value as OpenTaskResult;
        this.#emit({ intake, selectedEngagementId: intake.engagementId });
        await this.refreshState();
        await this.refreshScopeProposal();
      }
      // **两种结果都要读列表。**
      //
      // `openTask` 会因「本实例已锁定另一个 engagement」被拒——会话键已跨刷新持久化
      // （见 `loadClientSessionKey`），所以正常刷新会走到**恢复**而不是这条拒绝；
      // 但换浏览器、清掉存储，或另一个 profile 先占了运行时的情形依然会命中它。
      // 而拒绝**不等于库是空的**：列表缺席的表现是首屏恒显示「还没有 engagement /
      // 共 0 个」，人类于是既看不到自己的作业，也无从选择继续。列表必须照读。
      await this.refreshEngagements();
      if (!result.ok) {
        // 放在列表之后：`refreshEngagements` 成功会清掉 `lastError`，而这条拒绝
        // 是人类**必须看到**的事实（它解释了为什么没有自动进入作业）。
        this.#emit({ lastError: { code: result.code, message: draftRejectionMessage(result.code, result.message) } });
      }
      return result;
    }).finally(() => {
      this.#openTaskInFlight = null;
    });
    this.#openTaskInFlight = promise;
    return promise;
  }

  /**
   * 读该 dsh 会话当前需要人类做什么（聊天内的「待你确认」卡片用它）。
   *
   * 失败返回 `null`（面板显示「读不到」而不是伪造「没有待办」）——两者对人类的含义相反。
   */
  async intakeStatus(dshSessionId: string): Promise<IntakeStatus | null> {
    return this.#fetch<IntakeStatus>('getIntakeStatus', { dshSessionId });
  }

  /**
   * 「进入下一阶段」：服务端起稿（不经 Agent），返回可直接编辑的交接包。
   *
   * 不填理由：人类点它就是在推进自己的作业（操作者与时间照记）。
   */
  async beginHandoff(input: {
    readonly workerSessionId: string;
    readonly toPhase?: Phase;
    /** 会话卡片必须显式给版本（它没有 `state`；见 `mutate` 的说明）。 */
    readonly expectedStateVersion?: number;
  }): Promise<ConsoleCallResult> {
    const { expectedStateVersion, ...params } = input;
    return this.mutate('beginHandoff', { ...params }, '', {
      ...(expectedStateVersion === undefined ? {} : { expectedStateVersion }),
    });
  }

  /**
   * 读回当前待确认的交接草稿（§7.2）。界面据此渲染编辑器。
   *
   * 只读、不改状态：拿到 `null` 就是「现在没有待确认的草稿」。
   */
  async currentHandoffDraft(workerSessionId: string): Promise<HandoffDraft | null> {
    return this.#fetch<HandoffDraft | null>('currentHandoffDraft', { workerSessionId });
  }

  async refreshScopeProposal(engagementId?: string): Promise<ScopeProposal | null> {
    // 显式给出作业时按它读（`refreshState` 会把发起时的 id 传进来）：读的归属由
    // **发起方**决定，而不是「await 回来时的选中项」（2026-10-05 复核 REQ-13b）。
    const id = engagementId ?? this.#snapshot.selectedEngagementId;
    if (id === null) return null;
    const result = await this.#fetch<ScopeProposal | null>('getScopeProposal', { engagementId: id });
    // 迟到的方案不得污染刚切换到的作业。
    if (this.#snapshot.selectedEngagementId !== id) return null;
    this.#emit({ scopeProposal: result });
    return result;
  }

  /**
   * 聊天卡片的确认/驳回：版本号由**卡片刚读到的那份状态**提供（`IntakeStatus.stateVersion`）。
   *
   * ── 为什么不能复用 `mutate()` ──
   *
   * `mutate()` 取 `#snapshot.state?.stateVersion ?? 0`。但聊天卡片用的是**会话级**控制器：
   * 它从未 `select()` 过作业，`state` 恒为 null，于是恒定发 0——而作业的版本在方案提交后
   * 早已是 1。实测表现是：人类在卡片上点「确认」，永远得到
   * `stale_state_version`（期望 0，实际 1），只能看到「请刷新后重试」。
   *
   * ── 并发由乐观锁照旧兜底，但不把人类挡在门外 ──
   *
   * 若期间版本又被推进（另一个界面/另一个操作），**重读一次状态再试一次**：
   * 人类点的是「这份方案」，不是「这个版本号」；方案还在就继续，方案没了就如实返回失败。
   */
  async #fromCard(
    method: 'confirmScopeProposal' | 'rejectScopeProposal',
    params: Readonly<Record<string, unknown>>,
    reason: string,
    dshSessionId: string,
    expectedStateVersion: number,
  ): Promise<ConsoleCallResult> {
    let version = expectedStateVersion;
    // **幂等键在循环外生成**：重试是「同一次点击的重试」，不是新的一次操作。
    // 复用同一个键，服务端才可能把「已提交但没收到结果」的那一次识别为原结果（§15.3）。
    const idempotencyKey = this.newKey('card-act');
    for (let attempt = 0; ; attempt += 1) {
      const result = await this.#call({
        method,
        params,
        reason,
        idempotencyKey,
        expectedStateVersion: version,
      });
      // 只对**版本过期**这一种失败重来；其余失败（分类拒绝、方案已处理……）原样交给人类。
      if (result.ok || result.code !== 'stale_state_version' || attempt >= 1) return result;
      const fresh = await this.intakeStatus(dshSessionId);
      if (fresh === null || fresh.pendingProposal === null) return result;
      version = fresh.stateVersion;
    }
  }

  /** 聊天卡片确认（见 `#fromCard` 的版本语义）。 */
  confirmScopeProposalFromCard(
    input: Omit<ConfirmScopeProposalInput, 'operatorId' | 'expectedStateVersion'> & {
      readonly dshSessionId: string;
      readonly expectedStateVersion: number;
    },
  ): Promise<ConsoleCallResult> {
    const { dshSessionId, expectedStateVersion, ...rest } = input;
    const { params, reason } = this.#splitActor(rest);
    return this.#fromCard('confirmScopeProposal', params, reason, dshSessionId, expectedStateVersion).then(async (result) => {
      if (result.ok) {
        this.#emit({ scopeProposal: null, intake: null });
        await this.refreshEngagements();
      }
      return result;
    });
  }

  /** 聊天卡片驳回（与确认同一条版本语义）。 */
  rejectScopeProposalFromCard(
    input: Omit<RejectScopeProposalInput, 'operatorId' | 'expectedStateVersion'> & {
      readonly dshSessionId: string;
      readonly expectedStateVersion: number;
    },
  ): Promise<ConsoleCallResult> {
    const { dshSessionId, expectedStateVersion, ...rest } = input;
    const { params, reason } = this.#splitActor(rest);
    return this.#fromCard('rejectScopeProposal', params, reason, dshSessionId, expectedStateVersion).then(async (result) => {
      if (result.ok) await this.refreshScopeProposal();
      return result;
    });
  }

  confirmScopeProposal(input: Omit<ConfirmScopeProposalInput, 'operatorId' | 'expectedStateVersion'>): Promise<ConsoleCallResult> {
    const { params, reason } = this.#splitActor(input);
    return this.mutate('confirmScopeProposal', params, reason).then(async (result) => {
      if (result.ok) {
        this.#emit({ scopeProposal: null, intake: null });
        await this.refreshEngagements();
      }
      return result;
    });
  }

  rejectScopeProposal(input: Omit<RejectScopeProposalInput, 'operatorId' | 'expectedStateVersion'>): Promise<ConsoleCallResult> {
    const { params, reason } = this.#splitActor(input);
    return this.mutate('rejectScopeProposal', params, reason).then(async (result) => {
      if (result.ok) await this.refreshScopeProposal();
      return result;
    });
  }

  /**
   * 选中一个 engagement 并读取它的状态。
   *
   * 两步分开（列表 + 状态）而不是一个聚合端点：列表页不需要每个 engagement 的
   * 完整状态，而状态页需要刷新单个 engagement 的高频数据。
   */
  async select(engagementId: string): Promise<void> {
    // 切换作业时**先清空**上一条快照（2026-10-05 复核 REQ-13b）：读失败时界面会显示
    // 「B 的名字 + A 的阶段/在跑数」，比空白更误导人。清空后失败即呈现空态 + 错误。
    this.#emit({
      selectedEngagementId: engagementId,
      state: null,
      sessions: [],
      scopeProposal: null,
    });
    await this.refreshState();
  }

  /**
   * 一次面板读操作：取一个端点、返回它的值，**不进状态机快照**。
   *
   * 为什么与 `#read` 分开：`#read` 写的是 `getState` 那份权威快照（阶段、迭代、
   * `stateVersion`），它参与乐观锁与阶段轨道。面板数据（结论列表、放行队列、范围历史、
   * skill 库）是完全不同的东西——把它们塞进快照会让每一次点击都重传一遍大列表，
   * 而且会让「快照」这个概念失去单一含义。
   *
   * 失败时返回 null 并把错误置入快照：面板显示「读取失败」而不是假装空列表
   * （空列表与「读不到」对人类的含义截然不同）。
   */
  async #fetch<T>(
    method: ConsoleMethodName,
    params: Readonly<Record<string, unknown>>,
    // 有些读端点**要求理由**（读取记忆要进访问审计，§8.3）。默认值覆盖大多数不要求理由的端点。
    reason = '读取面板数据',
  ): Promise<T | null> {
    this.#emit({ loading: true });
    const result = await this.#call({
      method,
      params,
      reason,
      idempotencyKey: this.newKey('read'),
      expectedStateVersion: this.#snapshot.state?.stateVersion ?? 0,
    });
    if (result.ok) {
      this.#emit({ loading: false, lastError: null, conflict: false });
      return result.value as T;
    }
    this.#emit({
      loading: false,
      lastError: { code: result.code, message: result.message },
      conflict: result.conflict,
    });
    return null;
  }

  /**
   * 范围预校验（授权向导的「校验范围」）。
   *
   * 这是**创建 engagement 之前**的调用，因此没有 `engagementId` 可用——它是唯一
   * 不按 engagement 取值的读端点。校验的判定完全来自服务端：客户端不复制规范化规则
   * （§10.2.2 的安全边界只有一份实现）。
   *
   * 失败返回 null：调用方据此显示「尚未校验」，而不是伪造一个通过的结论。
   */
  async previewScope(input: PreviewScopeInput): Promise<ScopePreview | null> {
    return this.#fetch<ScopePreview>('previewScope', {
      targets: input.targets,
      exclusions: input.exclusions,
    });
  }

  /**
   * 策略与范围预览（§6.2.0.5）：**确认之前**取服务端将冻结的全部事实。
   *
   * 失败返回 `null`：界面据此显示「尚未预览」并**禁用确认**——而不是伪造一份通过的结论。
   * 与服务端同源是硬要求：这里绝不重算规范化结果或哈希，只显示服务端给的值。
   */
  async previewPolicy(input: PolicyPreviewInput): Promise<PolicyPreview | null> {
    return this.#fetch<PolicyPreview>('previewPolicy', { ...input });
  }

  /** 全部结论（报告审阅页）。失败返回 null（区别于「确实没有结论」的空数组）。 */
  async refreshFindings(): Promise<readonly Finding[] | null> {
    const id = this.#snapshot.selectedEngagementId;
    if (id === null) return null;
    const value = await this.#fetch<readonly Finding[]>('listFindings', { engagementId: id });
    return Array.isArray(value) ? value : null;
  }

  /**
   * 报告草稿（签字与导出的输入）。
   *
   * 服务端对**尚无版本**的 engagement 会现落一版草稿，因此这里通常能拿到值；
   * `null` 仍表示「没读到」，与「读到一份空草稿」不同（后者 `findings` 为空数组）。
   */
  async refreshReportDraft(): Promise<ReportDraft | null> {
    const id = this.#snapshot.selectedEngagementId;
    if (id === null) return null;
    return this.#fetch<ReportDraft>('getReportDraft', { engagementId: id });
  }

  /**
   * 某会话**最新未取代**报告的正文（报告审阅的"Agent 本轮报告"区，外部审计 P0-2）。
   *
   * 与 `refreshReportDraft` 不是一回事：草稿是**人类的**报告（签字与导出用），
   * 这里取的是 **Agent 交的**那一份。该会话还没交过报告时返回 `null`。
   */
  async workerReport(workerSessionId: string): Promise<WorkerReportView | null> {
    return this.#fetch<WorkerReportView | null>('getWorkerReport', { workerSessionId });
  }

  /**
   * 未处置结论**条数**（签字硬前置的判据，§8.9）。
   *
   * 返回条数而不是列表：这个数字的唯一用途是判定「能不能签字」，而签字是硬前置——
   * 界面**不得**从已加载的结论推算它（未加载完时会给出错误的「可以签字」）。
   * 因此直接问 Host 要结论、在客户端只保留计数。
   *
   * 空数组返回 `0`（确定的事实：一条未处置都没有）；读失败返回 `null`（「不知道」）。
   */
  async refreshUndisposedCount(): Promise<number | null> {
    const id = this.#snapshot.selectedEngagementId;
    if (id === null) return null;
    const value = await this.#fetch<readonly Finding[]>('listUndisposed', { engagementId: id });
    return Array.isArray(value) ? value.length : null;
  }

  /**
   * 会话卡片用的放行读取：`engagementId` 由**服务端刚给的状态**提供。
   *
   * `refreshApprovals()` 走 `#snapshot.selectedEngagementId`，而聊天卡片用的是会话级控制器
   * ——它从未 `select()` 过作业，那条路径恒返回 null（与 `confirmScopeProposal` 的版本问题同源）。
   * 这里只读 `pending`：已裁决的历史在放行队列里看，卡片不该重复一份会腐烂的副本。
   */
  async approvalsFor(engagementId: string): Promise<readonly ApprovalDetail[] | null> {
    const value = await this.#fetch<readonly ApprovalDetail[]>('listApprovals', {
      engagementId,
      decisions: ['pending'],
      limit: 5,
    });
    return Array.isArray(value) ? value : null;
  }

  /**
   * 会话卡片用的「作业运行快照」：主状态、当前阶段、**当前活动会话**。
   *
   * ── 为什么走这两个已有端点，而不是新字段 ──
   *
   * 「哪个会话正在跑」这件事 `getState.activeWorkerSessionId` + `listWorkerSessions`
   * 早就答得出来（都已发布）。同一事实只留一处来源：`IntakeStatus` 不再重复携带它，
   * 免得出现两个可能不一致的答案——阶段切换后界面要**跟着切会话**，而那个决定必须
   * 依据唯一的事实。
   *
   * @returns 读失败给 `null`（卡片据此不画状态、也不切会话），不抛。
   */
  async runningSnapshotFor(engagementId: string): Promise<{
    readonly mainStatus: MainStatus;
    readonly currentPhase: Phase | null;
    readonly active: WorkerSessionSummary | null;
  } | null> {
    const state = await this.#fetch<WorkflowSnapshot>('getState', { engagementId });
    if (state === null) return null;
    const sessions = await this.#fetch<readonly WorkerSessionSummary[]>('listWorkerSessions', { engagementId });
    const active = !Array.isArray(sessions) || state.activeWorkerSessionId === null
      ? null
      : sessions.find((session) => session.id === state.activeWorkerSessionId) ?? null;
    return { mainStatus: state.mainStatus, currentPhase: state.currentPhase, active };
  }

  /** 彻底删除前的只读预览（要删多少行、有没有拦路的东西）。 */
  async previewEngagementPurge(engagementId: string): Promise<PurgePreview | null> {
    return await this.#fetch<PurgePreview>('previewEngagementPurge', { engagementId });
  }

  /** 待处理的放行记录（放行队列页）。 */
  async refreshApprovals(): Promise<readonly ApprovalDetail[] | null> {
    const id = this.#snapshot.selectedEngagementId;
    if (id === null) return null;
    const value = await this.#fetch<readonly ApprovalDetail[]>('listApprovals', { engagementId: id });
    return Array.isArray(value) ? value : null;
  }

  /**
   * 范围版本。`includeHistory` 为真时顺带拉历史（只有范围管理页需要）。
   *
   * 默认不拉历史：历史版本可能很长，而大部分操作后只需要当前版本。
   */
  async refreshScope(includeHistory = false): Promise<ScopeDetail | null> {
    const id = this.#snapshot.selectedEngagementId;
    if (id === null) return null;
    return this.#fetch<ScopeDetail>('getScope', { engagementId: id, includeHistory });
  }

  /** 待裁决的候选内部资产（§5.5）。 */
  async refreshCandidateAssets(): Promise<readonly CandidateAsset[] | null> {
    const id = this.#snapshot.selectedEngagementId;
    if (id === null) return null;
    const value = await this.#fetch<readonly CandidateAsset[]>('listCandidateAssets', { engagementId: id });
    return Array.isArray(value) ? value : null;
  }

  /**
   * 读公共记忆；未选中作业时返回 null（不发明一个空对象让界面以为读到了）。
   *
   * 与 `refreshSkills` 的差别：那个不要求选中作业（skill 是全局库），
   * 而公共记忆**属于** engagement，没有选中时无从读起。
   */
  async refreshPublicMemory(): Promise<EngagementMemory | null> {
    const id = this.getSnapshot().selectedEngagementId;
    if (id === null) return null;
    return this.getEngagementMemory(id);
  }

  /** skill 库。`enabledOnly` 为真时只要未停用的。 */
  async refreshSkills(enabledOnly = false): Promise<readonly SkillSummary[] | null> {
    // **不要求选中 engagement**：skill 是全局库（不绑定 engagement，§16.2），
    // 端点的唯一参数是 `enabledOnly`。此前这里多带了一个 `engagementId`，
    // 被「未声明的键一律拒绝」判掉，整个 Skill 库面板恒为空；同时那个
    // `id === null → return null` 的守卫还让它在未选中时直接不发请求——
    // 两条都源于把「全局库」误当成 engagement 局部资源。
    const value = await this.#fetch<readonly SkillSummary[]>('listSkills', { enabledOnly });
    return Array.isArray(value) ? value : null;
  }

  /** 资产清单（控制台「资产」面板）。 */
  async refreshAssets(): Promise<readonly NetworkAsset[] | null> {
    const id = this.#snapshot.selectedEngagementId;
    if (id === null) return null;
    const value = await this.#fetch<readonly NetworkAsset[]>('listAssets', { engagementId: id });
    return Array.isArray(value) ? value : null;
  }

  /**
   * 检索记忆（§8.6）。
   *
   * 与上面几个不同：这里带**查询**，因此由人类动作触发，而不是切面板时自动跑。
   */
  async searchMemory(input: {
    readonly query: string;
    readonly kinds?: readonly string[];
    readonly trustLevels?: readonly TrustLevel[];
    readonly includeReasoning?: boolean;
    readonly limit?: number;
    readonly phase?: Phase | null;
    readonly assetIds?: readonly string[];
  }): Promise<MemorySearchResultSet | null> {
    const id = this.#snapshot.selectedEngagementId;
    if (id === null) return null;
    return this.#fetch<MemorySearchResultSet>('searchMemory', {
      engagementId: id,
      query: input.query,
      kinds: input.kinds,
      trustLevels: input.trustLevels,
      includeReasoning: input.includeReasoning,
      limit: input.limit,
      phase: input.phase,
      assetIds: input.assetIds,
    });
  }

  /**
   * 读取命中的完整原文（§8.3）。
   *
   * 这是**带审计的读**：每次读取都要写明理由并记入访问审计，因此理由由调用方给出，
   * 不能套用 `#fetch` 的默认值。
   */
  async readMemory(refs: readonly string[], reason: string): Promise<readonly MemoryRecord[] | null> {
    const id = this.#snapshot.selectedEngagementId;
    if (id === null) return null;
    // `reason` **只进信封**，不进 params：方法表把 readMemory 声明为 `reason: true`
    // （§8.3 要求读取写访问审计），信封的 reason 会被合并进服务输入；
    // 而 `params` 里未声明的键一律拒绝——两处都放会被判 `console/argument-invalid`，
    // 消息是「readMemory 不认识参数 reason」，读原文功能整体不可用。
    const value = await this.#fetch<readonly MemoryRecord[]>(
      'readMemory',
      { engagementId: id, refs },
      reason,
    );
    return Array.isArray(value) ? value : null;
  }

  /**
   * 读取索引水位（§8.4）。
   *
   * 独立于检索：水位要能单独刷新，且检索返回的水位是**那次检索时**的，
   * 两者含义不同。
   */
  async readMemoryWatermark(): Promise<MemoryWatermark | null> {
    const id = this.#snapshot.selectedEngagementId;
    if (id === null) return null;
    return this.#fetch<MemoryWatermark>('memoryWatermark', { engagementId: id });
  }

  /**
   * 校验账本完整性（只读）。
   *
   * 失败返回 `null`（与 `intakeStatus` 同约定：读不到 ≠ 账本是好的），
   * 具体错误经 `lastError` 快照呈现。
   */
  async verifyLedger(engagementId: string): Promise<LedgerVerificationView | null> {
    return this.#fetch<LedgerVerificationView>('verifyLedger', { engagementId });
  }

  /**
   * 运行诊断（只读）：连接池、审计探针 + 选中作业的索引队列与水位。
   *
   * 失败返回 `null`（与其它读端点同约定）；未选作业时也照读——实例级事实
   * （连接池、审计探针）不依赖作业。
   */
  async diagnostics(): Promise<DiagnosticsSnapshot | null> {
    const id = this.#snapshot.selectedEngagementId;
    return this.#fetch<DiagnosticsSnapshot>('getDiagnostics', id === null ? {} : { engagementId: id });
  }

  /**
   * 重读当前 engagement 的状态与会话列表。冲突后自动调用它（§15.4）。
   */
  async refreshState(): Promise<void> {
    const id = this.#snapshot.selectedEngagementId;
    if (id === null) return;
    // 归属守卫：本次读属于 `id`；响应回来时若选中项已变，`#read` 会丢弃它
    // （2026-10-05 复核 REQ-13b：快速切换时迟到的响应会用旧作业的状态覆盖新作业）。
    await this.#read('getState', { engagementId: id }, (result) => ({ state: result as WorkflowSnapshot }), id);
    await this.#read('listWorkerSessions', { engagementId: id }, (result) => ({
      sessions: Array.isArray(result) ? (result as readonly WorkerSessionSummary[]) : [],
    }), id);
    // 方案读同样按**发起时的**作业取，而不是「读到这里时的选中项」。
    await this.refreshScopeProposal(id);
  }

  /** 一次通用读操作：置 loading、清错误、必要时清冲突标记。 */
  async #read(
    method: ConsoleMethodName,
    params: Readonly<Record<string, unknown>>,
    project: (value: unknown) => Partial<ConsoleSnapshot>,
    /** 归属守卫：这次读属于哪个作业；响应回来时选中项已变则**丢弃**（REQ-13b）。 */
    forEngagement?: string,
  ): Promise<void> {
    this.#emit({ loading: true });
    const result = await this.#call({ method, params, reason: '读操作', idempotencyKey: this.newKey('read'), expectedStateVersion: 0 });
    if (forEngagement !== undefined && this.#snapshot.selectedEngagementId !== forEngagement) {
      // 迟到的响应：不写快照，也不写错误——它描述的是另一个作业。
      return;
    }
    if (result.ok) {
      // 成功的读会清掉冲突标记——冲突的处置就是「重读并重渲染」（§15.4）
      this.#emit({ ...project(result.value), loading: false, lastError: null, conflict: false, loadedAt: this.#clock().toISOString() });
      return;
    }
    this.#emit({
      loading: false,
      lastError: { code: result.code, message: result.message },
      conflict: result.conflict,
    });
  }

  // ───────────────────────── 写 ─────────────────────────

  /**
   * 一次人类写操作。
   *
   * 视图传入**方法、参数与理由**；控制器负责：
   *   - 取当前 `stateVersion` 作为乐观锁（§15.4）；
   *   - 生成幂等键（§15.3）；
   *   - 成功后重读状态（因为服务端已经改变了事实，界面必须跟上）；
   *   - 冲突时**自动重读**并把冲突告诉 UI——用户看到的是最新状态加一条提示，
   *     而不是一个卡住的旧界面。
   *
   * **视图不得直接调用**：每个端点都应有类型化的具体动作（见下方「具体动作」小节——
   * 参数形状钉在一处，字段名写错在编译期就暴露）。`mutate` 只留给控制器内部与
   * 尚无包装的端点；后者出现时应补包装，而不是把 `Record<string, unknown>` 漏到视图层。
   */
  async mutate(
    method: ConsoleMethodName,
    params: Readonly<Record<string, unknown>>,
    /** 备注（可为空串）：人类动作不要求理由（操作者与时间照记进 human_decisions 与审计）。 */
    reason: string,
    /**
     * `expectedStateVersion` 只在**会话卡片**路径需要显式给出：卡片用的是会话级控制器，
     * 它从未 `select()` 过作业，`state` 恒为 null，于是默认值恒为 0——服务端一律回
     * `stale_state_version`（实测：期望 0，实际 4）。卡片手上有版本（`facts.stateVersion`）。
     */
    options: { readonly refreshState?: boolean; readonly expectedStateVersion?: number } = {},
  ): Promise<ConsoleCallResult> {
    const version = options.expectedStateVersion ?? this.#snapshot.state?.stateVersion ?? 0;
    this.#emit({ loading: true });
    const result = await this.#call({
      method,
      params,
      reason,
      idempotencyKey: this.newKey('act'),
      expectedStateVersion: version,
    });

    if (result.ok) {
      this.#emit({ loading: false, lastError: null, conflict: false });
      if (options.refreshState !== false) await this.refreshState();
      return result;
    }

    this.#emit({
      loading: false,
      lastError: { code: result.code, message: result.message },
      conflict: result.conflict,
    });
    // 冲突的唯一正确处置是重读（§15.4「另一个返回冲突与最新状态」）。
    // 服务端把最新状态一并带回了，但这里仍重读一次：界面依赖的是完整快照，
    // 而冲突响应里的 state 可能只覆盖 getState 的一部分。
    if (result.conflict) await this.refreshState();
    return result;
  }

  /** 走客户端层（它负责信封构造与结果分类）。 */
  #call(input: ConsoleCallInput): Promise<ConsoleCallResult> {
    return this.#client.call(input, new AbortController().signal);
  }

  // ───────────────────────── 具体动作 ─────────────────────────
  //
  // 这些薄封装的意义不是省字符，而是**把参数形状钉在一处**：视图不该各自
  // 拼 params 对象——那样字段名写错只会在运行时被服务端以「信封不允许键」
  // 含糊地拒绝。

  createEngagement(input: Omit<CreateEngagementInput, 'operatorId' | 'reason'> & { reason: string }): Promise<ConsoleCallResult> {
    const { reason, ...params } = input;
    return this.mutate('createEngagement', params, reason, { refreshState: false }).then(async (r) => {
      if (r.ok) await this.refreshEngagements();
      return r;
    });
  }

  startWorker(input: Omit<StartWorkerInput, 'operatorId' | 'expectedStateVersion'>): Promise<ConsoleCallResult> {
    const { params, reason } = this.#splitActor(input);
    return this.mutate('startWorker', params, reason);
  }

  pause(reason: string): Promise<ConsoleCallResult> {
    return this.mutate('pause', { engagementId: this.#requireEngagement() }, reason);
  }

  resume(reason: string): Promise<ConsoleCallResult> {
    return this.mutate('resume', { engagementId: this.#requireEngagement() }, reason);
  }

  abort(reason: string): Promise<ConsoleCallResult> {
    return this.mutate('abort', { engagementId: this.#requireEngagement() }, reason);
  }

  interject(workerSessionId: string, message: string): Promise<ConsoleCallResult> {
    return this.mutate('interject', { workerSessionId, message }, '运行中插话纠偏');
  }

  /**
   * 切换审批模式（人工审批 ⇄ 高权限）。
   *
   * **运行中可切、不要求理由**（§6.4「人类是主人」）：写新一版策略并推进 policy epoch，
   * 旧放行凭证与在途计划当场失效。
   *
   * 与下面两条一起，是 2026-10-05 复核补上的「类型化表面缺口」：此前视图直接调
   * `mutate()`（返回 `Record<string, unknown>` 形状的 params），字段名写错只会在运行时
   * 被服务端以「信封不允许键」含糊拒绝。补齐后 `mutate()` 回到控制器内部工具的定位。
   */
  setApprovalMode(input: Omit<ApprovalModeChange, 'operatorId' | 'expectedStateVersion'>): Promise<ConsoleCallResult> {
    const { reason, ...params } = input;
    return this.mutate('setApprovalMode', params, reason ?? '');
  }

  /** 归档 / 取消归档作业：归档是默认的「清理」，数据保留（对比 `purgeEngagement`）。 */
  archiveEngagement(input: Omit<ArchiveEngagementInput, 'operatorId'>): Promise<ConsoleCallResult> {
    const { reason, ...params } = input;
    return this.mutate('archiveEngagement', params, reason ?? '');
  }

  /** 彻底删除作业内容（不可恢复）。`confirmName` 必须与作业名完全一致——人类防手滑的栏杆。 */
  purgeEngagement(input: Omit<PurgeEngagementInput, 'operatorId' | 'expectedStateVersion'>): Promise<ConsoleCallResult> {
    const { params, reason } = this.#splitActor(input);
    // 从 engagement 列表中查出该作业的版本（列表页点清理时，该作业可能未被 select）
    const engagement = this.#snapshot.engagements.find((e) => e.id === input.engagementId);
    const version = engagement?.stateVersion ?? this.#snapshot.state?.stateVersion ?? 0;
    return this.mutate('purgeEngagement', params, reason, { expectedStateVersion: version });
  }

  /**
   * 确认阶段切换。
   *
   * `expectedStateVersion` 由控制器从当前快照取——视图不该关心并发保护，
   * 但**必须**能提供交接内容（那是人类的编辑成果）。
   */
  confirmTransition(
    input: Omit<TransitionConfirmation, 'operatorId' | 'expectedStateVersion'> & {
      /** 会话卡片必须显式给版本（它没有 `state`）。 */
      readonly expectedStateVersion?: number;
    },
  ): Promise<ConsoleCallResult> {
    const { expectedStateVersion, ...rest } = input;
    const { params, reason } = this.#splitActor(rest);
    return this.mutate('confirmTransition', params, reason, {
      ...(expectedStateVersion === undefined ? {} : { expectedStateVersion }),
    });
  }

  retryWorker(input: Omit<RetryRequest, 'operatorId' | 'expectedStateVersion'>): Promise<ConsoleCallResult> {
    const { params, reason } = this.#splitActor(input);
    return this.mutate('retryWorker', params, reason);
  }

  /** 读公共记忆（控制台「公共记忆」面板的数据源）。 */
  getEngagementMemory(engagementId?: string): Promise<EngagementMemory | null> {
    const id = engagementId ?? this.#requireEngagement();
    return this.#fetch<EngagementMemory>('getEngagementMemory', { engagementId: id });
  }

  /**
   * 改写公共记忆。
   *
   * 与其余写封装同形：身份与版本由控制器注入，调用方只给内容与理由。
   */
  updateEngagementMemory(input: Omit<UpdateEngagementMemoryInput, 'operatorId' | 'expectedStateVersion'>): Promise<ConsoleCallResult> {
    const { params, reason } = this.#splitActor(input);
    return this.mutate('updateEngagementMemory', params, reason);
  }

  amendScope(input: Omit<ScopeAmendment, 'operatorId' | 'expectedStateVersion'>): Promise<ConsoleCallResult> {
    const { params, reason } = this.#splitActor(input);
    return this.mutate('amendScope', params, reason);
  }

  decideApproval(input: Omit<HumanApprovalDecision, 'operatorId'>): Promise<ConsoleCallResult> {
    const { params, reason } = this.#splitActor(input);
    return this.mutate('decideApproval', params, reason);
  }

  revokeApproval(input: Omit<HumanApprovalRevocation, 'operatorId'>): Promise<ConsoleCallResult> {
    const { params, reason } = this.#splitActor(input);
    return this.mutate('revokeApproval', params, reason);
  }

  cancelHandoff(reason: string, expectedStateVersion?: number): Promise<ConsoleCallResult> {
    return this.mutate(
      'cancelHandoff',
      { engagementId: this.#requireEngagement() },
      reason,
      { ...(expectedStateVersion === undefined ? {} : { expectedStateVersion }) },
    );
  }

  extendBudget(input: Omit<BudgetExtension, 'operatorId' | 'expectedStateVersion'>): Promise<ConsoleCallResult> {
    const { params, reason } = this.#splitActor(input);
    return this.mutate('extendBudget', params, reason);
  }

  reopenTechnicalWork(reason: string): Promise<ConsoleCallResult> {
    return this.mutate('reopenTechnicalWork', { engagementId: this.#requireEngagement() }, reason);
  }

  finishTechnicalTesting(reason: string): Promise<ConsoleCallResult> {
    return this.mutate('finishTechnicalTesting', { engagementId: this.#requireEngagement() }, reason);
  }

  // ── skill 库的写路径 ──
  //
  // §2.2 要求控制台能增/改/删 skill，端点（`addSkill`/`updateSkill`/`removeSkill`）也早在
  // 方法表里，但**客户端一直没有封装**——于是 Skill 库面板的增改删全部不可用。
  // 三个封装与其余写操作同形：理由由 controller 统一给（skill 改动的理由写进审计，
  // 因为正文是 Agent 会遵循的指令文本，改它等于改 Agent 行为）。

  addSkill(input: Omit<SkillAddRequest, 'operatorId' | 'reason'>): Promise<ConsoleCallResult> {
    return this.mutate('addSkill', { ...input }, '在控制台新增 skill');
  }

  updateSkill(input: Omit<SkillUpdateRequest, 'operatorId' | 'reason'>): Promise<ConsoleCallResult> {
    return this.mutate('updateSkill', { ...input }, '在控制台修改 skill');
  }

  removeSkill(input: Omit<SkillRemoveRequest, 'operatorId' | 'reason'>): Promise<ConsoleCallResult> {
    return this.mutate('removeSkill', { ...input }, '在控制台停用 skill，软删可恢复');
  }

  /**
   * 处置一条结论（§8.9 的三选一：接受/拒绝/暂缓）。
   *
   * 与其余写操作同形；`severity` 由人类确认（模型不能单方面定风险等级），
   * 因此它随输入一起进服务端。
   */
  dispositionFinding(input: Omit<FindingDisposition, 'operatorId'>): Promise<ConsoleCallResult> {
    // `reason` 是信封字段，不能随 params 发送；否则闭合参数表会拒绝整个处置请求。
    const { params, reason } = this.#splitActor(input);
    return this.mutate('dispositionFinding', params, reason);
  }

  signReport(contentHash: string, operatorReason: string): Promise<ConsoleCallResult> {
    return this.mutate('signReport', { engagementId: this.#requireEngagement(), contentHash }, operatorReason);
  }

  /**
   * 导出报告（§8.9）。
   *
   * `exportReport` 在方法表里的声明是 `kind: 'read'`、`operator: true`、`reason: false`：
   *   - 身份不能来自 params（`assertAllowedEnvelopeKeys` 对 params 里的身份键直接抛
   *     `console/operator-forbidden`），由控制台的信封注入——因此这里**只**传
   *     `engagementId` 与 `format`；
   *   - 导出不要求人类写自由文本理由，但信封一律要有非空理由（§16.1 审计），
   *     所以走 `#fetch` 的默认理由，不吃调用方的额外参数。
   *
   * 走读路径（`#fetch`）而不是 `mutate`：它不改状态机版本，也不该让每次导出都触发一次
   * 状态重读。`engagementId` 与 `signReport` 同源：从当前选中的作业取。
   *
   * 返回 `null` = 没导出成功（`#fetch` 已把稳定错误码记进快照的 `lastError`），
   * 与「导出成功但结果为空」不会混淆——契约的 `ExportResult` 永远是对象。
   */
  exportReport(format: ExportRequest['format']): Promise<ExportResult | null> {
    return this.#fetch<ExportResult>('exportReport', {
      engagementId: this.#requireEngagement(),
      format,
    });
  }

  /**
   * 把带 `reason` 的输入拆成「方法参数」与「审计理由」。
   *
   * **不能把整个 input 当 params 传**：`reason` 是信封字段（服务端从信封读它），
   * 不在任何端点的参数声明里，因此会被「未声明的键一律拒绝」挡下——写操作
   * 永远到不了服务层，而报错只说 `不认识参数 "reason"`，看不出是调用方式错了。
   *
   * 这是实测踩到的：六个封装方法都曾这样传，导致 approve / amendScope /
   * startWorker / confirmTransition / retryWorker / extendBudget 全部无法工作。
   *
   * `expectedStateVersion` 与 `operatorId` 由类型层排除（调用方不该传），
   * 因此这里只需处理 `reason`；但为了稳妥，一并把它们剥离——
   * 万一有调用方绕过类型（JS 调用、`as any`），也不该把信封字段混进参数。
   */
  #splitActor<T extends { readonly reason?: string }>(
    input: T,
  ): { readonly params: Record<string, unknown>; readonly reason: string } {
    const { reason, ...rest } = input as T & Record<string, unknown>;
    delete rest['expectedStateVersion'];
    delete rest['operatorId'];
    // 理由**可选**：缺省落空串。人类动作不要求理由（操作者与时间照记进 human_decisions 与审计）；
    // 填了则全程留痕——它是备注，不是闸门。
    return { params: rest, reason: reason ?? '' };
  }

  #requireEngagement(): string {
    const id = this.#snapshot.selectedEngagementId;
    if (id === null) {
      throw new Error('未选中 engagement：调用方应先 select()，或先判断 selectedEngagementId 非空');
    }
    return id;
  }
}

/**
 * 自动建单被拒时的**人话**。
 *
 * `openTask` 对「本会话已经离开 intake」的会话会以 `classification_rejected` 拒绝，
 * 服务端原文是「该客户端任务已离开 intake 阶段，不能重新创建 intake」——事实正确，
 * 但挂在红色错误条里对人类是惊吓（看起来像坏了），而此刻该做的是从列表选中已有作业
 * （列表已经在同一屏里读好了）。
 *
 * 只翻译这一种；**其它拒绝码原样透出**——不认识就不要替服务端改写事实。
 */
export function draftRejectionMessage(code: string, message: string): string {
  // 只在**这一句服务端文案**上改写。`classification_rejected` 是通用码：任何含 'intake'
  // 的拒绝（「intake 提案已被取代」「intake 会话不活跃」…）都不该被套上「已离开 intake 阶段」
  // 这个结论——替换后服务端原文就看不见了（只留错误码）。因此要求两句稳定记号同时命中。
  if (code === 'classification_rejected' && message.includes('intake') && message.includes('离开')) {
    return (
      '本会话的作业已经离开 intake 阶段：范围已确认或已结束，不会重复建单。' +
      '从上方列表选中它继续；要另开一份作业，用「新建 engagement」授权向导。'
    );
  }
  return message;
}
