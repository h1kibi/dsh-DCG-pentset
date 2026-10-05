/**
 * 执行服务（设计文档 §10.2、§10.3、§10.3.1）。
 *
 * **强制点位于服务内部，不在工具适配器。** `pentest_exec` 工具只是薄封装：
 * 它只做参数形状校验与调用转发，不承担任何判断。任何新增入口（批处理、子工具、
 * 代码执行内的子调用）都必须调用本服务的同一方法，不得自行实现检查——闸门只写在
 * 工具层时会被「延迟工具注入」绕过。
 *
 * 准入顺序（§10.2）：
 *   模板解析 → 参数白名单校验 → 动作类别判定与复算 → 范围校验 → 会话准入（租约）
 *   → 幂等键派生 → 是否需要人工放行 → 凭证校验
 * 其中「无法归类即拒绝」：未注册模板、参数越界、类别无法确定一律拒绝，
 * **绝不降级为低风险放行**。
 *
 * 执行前重新裁决（§10.3.1）：人类放行可能在数分钟后才到达，因此真正执行前
 * 重新复核计划摘要、策略判定、范围版本、策略 epoch 与租约，任一项不通过即拒绝。
 * 原子性由沙箱在连接时刻提供：host 侧在同一事务内消费凭证并签发一次性执行令牌。
 *
 * 全部依赖（PolicyService、沙箱执行器、DB、会话目录）通过构造函数注入，
 * 因此强制点可被独立测试，且不存在绕开服务直连沙箱的路径。
 */

import { randomUUID } from 'node:crypto';
import { setTimeout as delayMs } from 'node:timers/promises';
import type {
  ActionClass,
  ActionPacing,
  NormalizedTarget,
  ActionIntent,
  AdmissionDecision,
  ApprovalMode,
  ApprovalRecord,
  ExecutionPlan,
  ExecutionService,
  PolicyService,
  RunMarker,
  SessionLease,
  SessionStatus,
  ToolError,
  ToolRunResult,
} from '../contracts.ts';
import { shouldSelfApprove } from '../policy/behavior-profile.ts';
import {
  DEFAULTS,
  DEFAULT_DISABLED_CLASSES,
  EXEC_TOOL_NAME,
  PER_ACTION_APPROVAL_CLASSES,
} from '../contracts.ts';
import {
  canonicalTargetString,
  deriveIdempotencyKey,
  derivePlanHash,
} from './idempotency.ts';
// 受理闸门管线（C1）：具名、有序、只读的阶段数组；会话级校验与错误构造也在那里，
// 由受理与执行前复核共用（不再各写一份）。
import {
  AdmissionState,
  blocked,
  engagementViolation,
  leaseViolation,
  runAdmissionGates,
} from './admission.ts';
import {
  buildDisplayCommand,
  buildNormalizedCommand,
  defaultRegistry,
  type TemplateRegistry,
} from './templates.ts';

/** 默认禁用类别（§10.3）：需在 engagement 策略中显式开启并双人确认。 */
const DISABLED_BY_DEFAULT: readonly ActionClass[] = DEFAULT_DISABLED_CLASSES;

/** 放行凭证默认有效期（秒）。放行记录保存完整执行内容，人类在放行队列中处理。 */
const DEFAULT_APPROVAL_TTL_SECONDS = 900;

// ───────────────────────────── 注入依赖 ─────────────────────────────

/** 会话绑定：范围版本、策略 epoch 与租约是执行准入的上下文。 */
export interface SessionBinding {
  readonly engagementId: string;
  readonly status: SessionStatus;
  /**
   * 所属 engagement 的**运行标记**（§5.1 的两层状态之一）。
   *
   * 必须带来执行闸门：运行标记只落库而不拦动作时，`pause` 与恢复对账的
   * `blocked` 对目标动作**毫无约束力**——那正是「人类闸门」失效的一种形态。
   */
  readonly engagementStatus: RunMarker;
  /** 会话冻结的范围版本（§10.2.2：判断用冻结版本，撤销用最新版本）。 */
  readonly scopeVersion: number;
  readonly policyEpoch: number;
  readonly lease: SessionLease | null;
}

export interface SessionDirectory {
  binding(workerSessionId: string): Promise<SessionBinding | undefined>;
}

export interface ToolRunRecord {
  readonly toolRunId: string;
  readonly idempotencyKey: string;
  readonly planHash: string;
  /** 已完成运行的结果；幂等重放直接返回它，不重复执行。 */
  readonly result: ToolRunResult;
}

/** 放行申请：携带完整执行内容（人类批准的是「将要执行」的模板实例，§10.3.1）。 */
export interface ApprovalRequest {
  readonly workerSessionId: string;
  readonly leaseGeneration: number;
  readonly actionClass: ActionClass;
  /** 服务端注册的模板；生产调用点必须提供。 */
  readonly templateId?: string;
  readonly params?: Readonly<Record<string, string | number>>;
  /** Agent 原始选择器；用于修改审批时重新裁决，不能用规范化目标替代。 */
  readonly targetSelector: string;
  readonly planHash: string;
  readonly normalizedTarget: string;
  readonly normalizedCommand: string;
  /**
   * 高权限模式的**服务端自行放行**：凭证以 `approved` 直接落库（人类没看过这条命令）。
   *
   * 只由 `shouldSelfApprove` 判定通过时给出；审计里必须留痕，
   * 控制台的放行列表会把它显示成「由服务端自行放行」而不是人类决定。
   */
  readonly selfApproval?: { readonly decidedBy: string; readonly reason: string };
  /**
   * 为什么这条要人批（写进 `approvals.risk_summary`，放行卡直接展示）。
   *
   * 人类看到一条申请时第一个问题是「凭什么问我」——把判据写进记录里，
   * 而不是让他去猜是哪条规则拦下的（2026-10-05 实测：高权限档下仍被逐条询问，
   * 而界面没写「该类别不在预设启用集合里」，人类只能得出「AI 审批没生效」的结论）。
   */
  readonly approvalReason?: string;
  /**
   * 人类可读的命令文本（放行卡与审计展示用）。
   *
   * `normalizedCommand` 是给容器读的形态；自由命令把正文放在 `command_b64` 里，
   * 不给这个字段人类就得对着 base64 点「批准」——那等于没有内容闸门。
   */
  readonly displayCommand?: string;
  readonly scopeVersion: number;
  readonly policyEpoch: number;
  readonly timeoutMs: number;
  readonly maxOutputBytes: number;
  readonly purpose: string;
  readonly expiresAt: Date;
}

/**
 * `commitRun` 的输入。
 *
 * 除幂等与凭证绑定的字段外，还带**登记运行所需的审计字段**：
 * `tool_runs` 表的 `tool_name` / `action_class` / `target_selector` /
 * `normalized_command` / `arguments_json` 都是 NOT NULL，而这些值只在
 * `ExecutionPlan` 与调用点可得。若不在输入里传，适配器只能写哨兵值
 * （如 `action_class='unspecified'`），审计就失去了最关键的「这是什么动作」。
 *
 * 调用点（`service.ts` 的 `admit`/`execute`）本就持有 plan，因此传这些字段
 * 不增加任何额外查询。
 */
export interface CommitRunInput {
  readonly toolRunId: string;
  readonly workerSessionId: string;
  readonly idempotencyKey: string;
  readonly planHash: string;
  readonly approvalId: string | null;
  /** 批准与执行必须在同一租约世代；存储层最终 CTE 也按此值复核。 */
  readonly leaseGeneration: number;
  /** 本插件的唯一目标类工具名；登记到 `tool_runs.tool_name`。 */
  readonly toolName: string;
  /** 真实动作类别——审计与风险统计靠它，不得用哨兵值。 */
  readonly actionClass: ActionClass;
  /** 模板标识（动作来源，便于回溯是哪个受信模板）。 */
  readonly templateId: string;
  /** 规范化目标；写入 `target_selector`。 */
  readonly normalizedTarget: string;
  /** 规范化命令文本；写入 `normalized_command`。 */
  readonly normalizedCommand: string;
  /** 记录本次裁决依据（范围版本、策略 epoch、幂等键），写入 `policy_decision`。 */
  readonly scopeVersion: number;
  readonly policyEpoch: number;
  /** 动作类别是否来自放行（决定 policy_decision 的 outcome）。 */
  readonly approvalRequired: boolean;
}

/**
 * host 侧原子提交的结果：凭证消费 + 运行登记必须在同一事务内完成（§10.3.1）。
 *
 * 这里**不再**签发一次性执行令牌（2026-10-05 复核 REQ-4）：签发过、注入过、检查过非空，
 * 但没有任何消费方校验它——代理只看 `EGRESS_ALLOW`，容器内包装器只是打印它是否存在。
 * 不可验证的凭证不是闸门；「只有已准入的执行会跑」由调用结构承担
 * （`SandboxExecutor.run` 的唯一调用点在 `commitRun` 成功之后）。
 */
export type CommitRunResult =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly reason:
        | 'approval_not_found'
        | 'approval_consumed'
        | 'idempotent_replay'
        | 'lease_required'
        | 'lease_expired'
        | 'lease_revoked'
        | 'lease_generation_stale'
        | 'engagement_halted'
        | 'stale_state_version';
    };

export interface ExecutionStore {
  /**
   * 按幂等键查已完成的运行；命中即返回原结果，不重复执行。
   *
   * 语义约定：**凡已执行并回写过结果的运行都参与幂等重放，包括被沙箱拒绝或运行失败
   * 的结果**——同一动作因此不会被重复执行（防的是「重放放大」，不是「重试成功」）。
   * 尚未回写结果的运行不参与，调用方据 null 继续走执行前重裁决。
   */
  findRunByIdempotencyKey(idempotencyKey: string): Promise<ToolRunRecord | undefined>;
  requestApproval(input: ApprovalRequest): Promise<{ readonly approvalId: string }>;
  getApproval(approvalId: string): Promise<ApprovalRecord | undefined>;
  /** 一次性消费凭证；已消费或不存在返回 false。 */
  consumeApproval(approvalId: string, toolRunId: string): Promise<boolean>;
  commitRun(input: CommitRunInput): Promise<CommitRunResult>;
  finishRun(toolRunId: string, result: ToolRunResult): Promise<void>;
}

export interface SandboxRunRequest {
  readonly plan: ExecutionPlan;
}

export interface SandboxExecutor {
  run(request: SandboxRunRequest, signal: AbortSignal): Promise<ToolRunResult>;
}

/** 会话绑定的动作策略：哪些类别需要逐次放行、哪些默认禁用类别已被显式开启。 */
export interface ActionPolicySnapshot {
  readonly perActionApprovalClasses: readonly ActionClass[];
  /** 在 engagement 策略中显式开启的默认禁用类别。 */
  readonly enabledDisabledClasses?: readonly ActionClass[];
  /** 开启默认禁用类别要求双人确认（§10.3）。 */
  readonly dualConfirmed?: boolean;
  /**
   * 策略显式启用的动作类别（§6.2.0.5 展开结果）。
   *
   * 缺省表示「不额外限制」——旧快照没有这一支，而那正是契约基线
   * （默认严格：逐次放行类别照旧，默认禁用类别照旧关闭）。
   * 提供时它是**上界**：不在其中的类别直接被拒，而不是去找一条更松的路径。
   */
  readonly enabledActionClasses?: readonly ActionClass[];
  /**
   * 审批模式（§10.3.1）；缺省 `human`。
   *
   * `auto`（高权限）时，`perActionApprovalClasses` 里**属于预设内且非默认禁用类别**的动作
   * 由服务端自行放行：凭证直接建成 approved、落库并记审计，Agent 不必等人类。
   * 超出预设的动作与 persistence/destructive/exfiltration 永远转人工。
   */
  readonly approvalMode?: ApprovalMode;
  /** 服务端展开的 pacing（§6.2.0.5）；缺省表示该会话不施加 pacing。 */
  readonly pacing?: ActionPacing;
  /** 冻结策略的版本号（§6.2.0.5）；缺省按 0 记账（旧快照没有这一列）。 */
  readonly policyVersion?: number;
}

export interface ActionPolicySource {
  forSession(workerSessionId: string): Promise<ActionPolicySnapshot>;
}

/** 默认动作策略：逐次放行类别取契约常量；默认禁用类别未开启。 */
export const DEFAULT_ACTION_POLICY: ActionPolicySnapshot = Object.freeze({
  perActionApprovalClasses: PER_ACTION_APPROVAL_CLASSES,
});

export const defaultActionPolicySource: ActionPolicySource = Object.freeze({
  forSession: async (): Promise<ActionPolicySnapshot> => DEFAULT_ACTION_POLICY,
});

/**
 * 策略/执行事件的审计落点（§9.5 的主体归因）。
 *
 * 为什么是窄端口而不是让执行服务直接依赖账本：执行服务的强制点必须能被独立测试，
 * 而「写事件」只是它的一个副作用。生产由 `compose.ts` 注入账本实现，
 * 测试注入收集器或省略。
 *
 * **写失败必须让调用方看到**：§15.1 的纪律是「审计不可用时所有触及目标的动作停止」，
 * 因此 `admit` 在审计写入失败时拒绝该动作，而不是吞掉错误继续放行。
 */
export interface ExecutionAuditSink {
  record(input: {
    readonly eventType:
      | 'execution.policy.checked'
      | 'execution.pacing.applied'
      | 'execution.detection_signal'
      | 'execution.stopped';
    readonly engagementId: string;
    readonly workerSessionId: string;
    readonly payload: Readonly<Record<string, unknown>>;
  }): Promise<void>;
}

/**
 * 审计可用性探针（§15.1）。
 *
 * 「审计写入不可用时所有触及目标的动作一律停止」是 §15.1 的硬约束，而它的判据
 * 不在动作类别上——分类准确度不足以支撑「只停高风险」的降级。
 *
 * 由一个**探针**而不是一个布尔量：审计能不能写是会变的（连接池耗尽、独占写连接断开、
 * 表被撤权），一个装配期取一次的布尔量会在故障发生后继续放行动作。
 */
export interface AuditProbe {
  available(): Promise<{ readonly writable: boolean; readonly detail: string }>;
}

/**
 * 一次闸门失败的记录（§10.2.2）。
 *
 * 文档要求事件里含**原始目标、规范化结果、命中的规则、发起会话**——
 * 缺任何一项，事后都无法回答「Agent 当时想打哪里、为什么被拒」。
 */
export interface GateFailureRecord {
  readonly eventType: 'scope.violation' | 'classification.rejected';
  readonly engagementId: string;
  readonly workerSessionId: string;
  /** 发起会话提交的原始目标（Agent 写的是什么）。 */
  readonly rawTarget: string;
  /**
   * 服务端规范化后的结果；无法规范化时为 `null`。
   *
   * 用契约的结构化形式而不是「稳定键字符串」：规范形式含 kind/host/port/protocol，
   * 拼成字符串再拆回来会丢信息，而事件进的是 jsonb（本来就能存结构）。
   */
  readonly normalized: NormalizedTarget | null;
  /** 命中的规则：范围拒绝码，或分类拒绝的错误码。 */
  readonly rule: string;
  readonly detail: string;
}

/**
 * 闸门失败的记录与处置（§10.2.2）。
 *
 * 为什么要一个端口而不是在这里直接写：执行服务不持有账本（见 `#audit` 在
 * `pg-workflow` 里），而这些事件必须进**同一个**账本才有回放价值。
 */
export interface GateFailureSink {
  /**
   * 记录一次闸门失败，返回该会话**自上次成功执行以来**累计的**范围违规**次数。
   *
   * 返回计数而不是让执行服务自己查：「自上次成功执行以来」的判据要与事件写入同源
   * （都在账本与 tool_runs 上），分两处算会漂移。
   *
   * `classification.rejected` 不累计：§10.2.2 的自动暂停只针对范围违规。
   */
  record(input: GateFailureRecord): Promise<number>;
  /**
   * 生产装配可把事件追加、阈值计数和系统暂停放进同一 PostgreSQL 事务。
   * 未提供时由执行服务退回 `record` + `pauseForScopeViolations` 两步兼容路径。
   */
  recordAndPause?(input: GateFailureRecord & { readonly threshold: number }): Promise<number>;
  /**
   * 范围违规达到阈值：暂停会话交人类判断（§10.2.2）。
   *
   * 文档给的理由值得留在这里：**这通常意味着任务描述有歧义，而不是偶发失误**——
   * 所以处置是「交人类」而不是「重试」。
   */
  pauseForScopeViolations?(input: {
    readonly engagementId: string;
    readonly workerSessionId: string;
    readonly count: number;
  }): Promise<void>;
}

export interface ExecutionServiceDeps {
  readonly policy: PolicyService;
  readonly sandbox: SandboxExecutor;
  readonly store: ExecutionStore;
  readonly sessions: SessionDirectory;
  /** 默认使用服务端默认模板集；高风险模板必须人工注册。 */
  readonly registry?: TemplateRegistry;
  readonly actions?: ActionPolicySource;
  readonly clock?: () => Date;
  readonly newId?: (prefix: string) => string;
  readonly approvalTtlSeconds?: number;
  /**
   * 审计可用性探针（§15.1）。**省略即视为总是可写**——只读装配与单元测试不需要它，
   * 但生产装配必须给（`compose.ts` 会给）。
   *
   * 为什么默认「可写」而不是默认「不可写」：默认拒绝会让所有未配置探针的部署
   * 整体停摆，那是比漏一道闸门更坏的失败方式；而生产路径由 compose 显式提供，
   * 不存在「忘了配」的静默降级。
   */
  readonly audit?: AuditProbe;
  /**
   * 闸门失败的记录与处置（§10.2.2）。省略即**不记录**这些事件——
   * 单测与只读装配不需要它，生产由 `compose.ts` 提供。
   */
  readonly gateFailures?: GateFailureSink;
  /**
   * 策略与执行事件的审计落点（§6.2.0.5、§10.2）。省略即不写这些事件——
   * 单测与只读装配不需要它，生产由 `compose.ts` 提供。
   */
  readonly executionAudit?: ExecutionAuditSink;
  /**
   * 范围违规自动暂停的阈值（§10.2.2）。默认取 {@link DEFAULTS.scopeViolationPauseThreshold}。
   *
   * 可配是为了让部署方按误报率调它（§19 Q5 把它列为「先用默认值观察」的待定项）。
   */
  readonly scopeViolationPauseThreshold?: number;
}

// ───────────────────────────── 执行 pacing（§6.2.0.5） ─────────────────────────────

function abortError(): Error {
  return new DOMException('策略 pacing 等待已中止', 'AbortError');
}

/**
 * 可中止的等待。等待期间 `signal` 触发即拒绝——在途动作的终止不能等一个定时器。
 *
 * 注：不用 `Promise.withResolvers`——它需要 lib es2024，而本仓 lib 是 es2023
 * （与 `docker-sandbox.ts` 的 `spawnRunner` 同一约束）。
 */
function delay(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(abortError());
  return new Promise((resolve, reject) => {
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(abortError());
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * 服务端 pacing 闸门：把策略快照里的节奏真正施加到动作上（§10.2）。
 *
 * 两条强制：
 *   - **速率**：同一 engagement 相邻两次动作起始至少间隔 `1000/rate` 毫秒；
 *   - **并发**：同一 engagement 同时执行的沙箱动作不超过 `concurrency`。
 * 外加 `jitter` 抖动（每次动作前 0..jitter 秒的随机等待）——固定间隔本身就是
 * 可被检测的指纹，抖动是「隐蔽性」里唯一让节奏不规则的机制。
 *
 * 状态是**按 engagement 的内存态**：它约束的是本进程发起的动作。多进程部署需要
 * 共享限速器（设计里属共享部署范畴），此处不假装已经做到——单操作者本机部署
 * 就是当前产品画像。
 */
class PacingGate {
  readonly #state = new Map<string, { active: number; nextStartAt: number }>();

  /** 取得一个执行槽位；期间若被中止抛出 `AbortError`。 */
  async acquire(engagementId: string, pacing: ActionPacing, signal: AbortSignal): Promise<void> {
    for (;;) {
      if (signal.aborted) throw abortError();
      const state = this.#state.get(engagementId) ?? { active: 0, nextStartAt: 0 };
      if (state.active >= pacing.concurrency) {
        await delay(25, signal);
        continue;
      }
      const now = Date.now();
      const interval = pacing.rate > 0 ? 1000 / pacing.rate : 0;
      const scheduled = Math.max(now, state.nextStartAt);
      this.#state.set(engagementId, { active: state.active + 1, nextStartAt: scheduled + interval });
      const jitterMs = pacing.jitter > 0 ? Math.random() * pacing.jitter * 1000 : 0;
      const waitMs = scheduled - now + jitterMs;
      if (waitMs <= 0) return;
      try {
        await delay(waitMs, signal);
        return;
      } catch (error) {
        this.release(engagementId);
        throw error;
      }
    }
  }

  release(engagementId: string): void {
    const state = this.#state.get(engagementId);
    if (state === undefined) return;
    state.active = Math.max(0, state.active - 1);
  }
}

/** pacing 是否需要真正等待：全零/全默认的配置不引入延迟，也不产生「已应用」的假象。 */
function pacingImposesWait(pacing: ActionPacing): boolean {
  return pacing.rate > 0 || pacing.jitter > 0 || pacing.concurrency > 0;
}

/**
 * 从工具输出里识别**目标侧的检测迹象**（§6.2.0.5 的 `execution.detection_signal`）。
 *
 * 只认可机器判定的形态（HTTP 429/503、显式限速头），不做「像不像被封」的猜测：
 * 误报会把「目标在限速」变成噪声，而审计里的噪声会让人不再读它。
 */
function detectionSignalOf(result: ToolRunResult): string | null {
  const text = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
  if (/(^|\D)429(\D|$)/.test(text)) return 'http_429';
  if (/(^|\D)503(\D|$)/.test(text)) return 'http_503';
  if (/retry-after/i.test(text)) return 'retry_after_header';
  if (/rate.?limit/i.test(text)) return 'rate_limit_marker';
  return null;
}

// ───────────────────────────── 服务实现 ─────────────────────────────

export function createExecutionService(deps: ExecutionServiceDeps): ExecutionService {
  const registry = deps.registry ?? defaultRegistry();
  const actions = deps.actions ?? defaultActionPolicySource;
  const clock = deps.clock ?? ((): Date => new Date());
  const scopeViolationPauseThreshold =
    deps.scopeViolationPauseThreshold ?? DEFAULTS.scopeViolationPauseThreshold;
  const approvalTtlSeconds = deps.approvalTtlSeconds ?? DEFAULT_APPROVAL_TTL_SECONDS;
  const newId = deps.newId ?? ((prefix: string): string => `${prefix}-${randomUUID()}`);

  /** 在途动作：策略 epoch 前进时按 engagement 终止（§10.3.1）。 */
  const inFlight = new Map<
    string,
    { readonly engagementId: string; readonly policyEpoch: number; readonly controller: AbortController }
  >();

  /** 服务端 pacing 闸门（§6.2.0.5）：把冻结策略里的速率/并发/抖动真正施加到执行上。 */
  const pacingGate = new PacingGate();

  // `engagementViolation` / `leaseViolation` 已移到 `admission.ts`：受理闸门
  // （`engagement_running` / `lease_valid`）与执行前复核（`revalidateBeforeTarget`）
  // 现在读的是**同一份实现**——两处各写一遍必然漂移，而漂移的后果是某条拒绝路径
  // 悄悄放宽（2026-10-05 复核 C1 顺手收掉这处重复）。

  /** 凭证校验：绑定关系（会话、类别、计划摘要）与状态（一次性、时效）任一不符即拒绝。 */
  function approvalViolation(
    record: ApprovalRecord | undefined,
    approvalId: string,
    expected: {
      readonly workerSessionId: string;
      readonly actionClass: ActionClass;
      readonly planHash: string;
      readonly leaseGeneration: number;
    },
    now: Date,
  ): ToolError | undefined {
    if (record === undefined) {
      return blocked(
        'approval_required',
        `放行凭证 ${approvalId} 不存在`,
        '重新申请放行',
        approvalId,
      );
    }
    if (record.workerSessionId !== expected.workerSessionId) {
      return blocked(
        'approval_required',
        `放行凭证 ${approvalId} 绑定的是另一个会话，不跨会话沿用`,
        '在申请凭证的同一会话内使用，或重新申请放行',
        approvalId,
      );
    }
    if (record.leaseGeneration !== expected.leaseGeneration) {
      return blocked(
        'lease_generation_stale',
        `放行凭证 ${approvalId} 绑定的是租约世代 ${String(record.leaseGeneration)}，当前计划世代为 ${String(expected.leaseGeneration)}`,
        '租约世代已变化，重新申请放行',
        approvalId,
      );
    }
    if (record.consumedAt !== null) {
      return blocked(
        'approval_consumed',
        `放行凭证 ${approvalId} 已被消费（一次性授权）`,
        '重新申请放行',
        approvalId,
      );
    }
    switch (record.decision) {
      case 'approved':
        break;
      case 'pending':
        return blocked(
          'approval_required',
          `放行凭证 ${approvalId} 仍在等待人类处理`,
          '等待人类放行后再调用',
          approvalId,
        );
      case 'expired':
        return blocked('approval_expired', `放行凭证 ${approvalId} 已过期`, '重新申请放行', approvalId);
      case 'rejected':
      case 'revoked':
      case 'superseded':
        return blocked(
          'approval_revoked',
          `放行凭证 ${approvalId} 处于 ${record.decision} 状态`,
          '重新申请放行',
          approvalId,
        );
      default:
        return blocked(
          'approval_revoked',
          `放行凭证 ${approvalId} 的判定状态未知，按拒绝处理`,
          '重新申请放行',
          approvalId,
        );
    }
    if (record.expiresAt.getTime() <= now.getTime()) {
      return blocked(
        'approval_expired',
        `放行凭证 ${approvalId} 已过有效期（${record.expiresAt.toISOString()}）`,
        '重新申请放行',
        approvalId,
      );
    }
    // 目标、规范化命令、范围版本、策略版本任一变化都会改变计划摘要，因此这里一并覆盖。
    if (record.actionClass !== expected.actionClass || record.planHash !== expected.planHash) {
      return blocked(
        'approval_required',
        `放行凭证 ${approvalId} 与当前计划不一致（动作类别或计划摘要已变化），旧凭证失效`,
        '按当前计划重新申请放行，不静默降级为未放行执行',
        approvalId,
      );
    }
    return undefined;
  }

  /** 准入（§10.2）。返回结构化判定，拒绝路径一律给出稳定错误码。 */
  async function admit(input: ActionIntent): Promise<AdmissionDecision> {
    const now = clock();

    // 提前取一次会话绑定：闸门失败的记录要 engagementId（账本是 engagement 级的），
    // 而**分类失败发生在会话准入之前**（§10.2 的顺序：类别判定 → 会话能力校验）。
    //
    // 只取一次、后面复用，因此**不改变既有报错优先级**——模板未注册仍然报
    // `classification_rejected` 而不是 `lease_required`。取不到时后续的会话准入
    // 检查照旧按原顺序拒绝，只是那次失败无法记账（没有 engagementId 可归）。
    const earlyBinding = await deps.sessions.binding(input.workerSessionId);

    /**
     * 记录一次闸门失败（§10.2.2），并在范围违规累计到阈值时请求暂停会话。
     *
     * 失败**不阻断**受理路径的拒绝结论：事件写不进去是审计问题，而拒绝是安全结论，
     * 后者必须照常返回。但也不静默——打到 console 让人能看到（与 compose 对同类
     * 次生失败的处理一致）。
     */
    const recordGateFailure = async (record: {
      readonly eventType: GateFailureRecord['eventType'];
      readonly rule: string;
      readonly detail: string;
      readonly normalized: NormalizedTarget | null;
    }): Promise<void> => {
      const sink = deps.gateFailures;
      if (sink === undefined || earlyBinding === undefined) return;
      try {
        const payload = {
          ...record,
          engagementId: earlyBinding.engagementId,
          workerSessionId: input.workerSessionId,
          rawTarget: input.targetSelector,
        };
        if (record.eventType === 'scope.violation' && sink.recordAndPause !== undefined) {
          await sink.recordAndPause({ ...payload, threshold: scopeViolationPauseThreshold });
          return;
        }
        const count = await sink.record(payload);
        if (
          record.eventType === 'scope.violation' &&
          count >= scopeViolationPauseThreshold &&
          sink.pauseForScopeViolations !== undefined
        ) {
          await sink.pauseForScopeViolations({
            engagementId: earlyBinding.engagementId,
            workerSessionId: input.workerSessionId,
            count,
          });
        }
      } catch (error) {
        console.warn(
          `[dsh-pentest] 记录闸门失败（${record.eventType}）时出错：` +
            `${error instanceof Error ? error.message : String(error)}。拒绝结论不受影响。`,
        );
      }
    };

    // 1–7. 受理闸门（§10.2）：**具名、有序、只读**的阶段数组，顺序即 `ADMISSION_GATES`
    // 的数组顺序（见 `admission.ts`）。此前这些判定顺序写在本函数里、顺序藏进行号，
    // 新增一道闸门要在两千行文件的中段插代码——2026-10-05 复核 C1 把它结构化为管线：
    //
    //   audit_available → template_registered → params_whitelisted → purpose_present →
    //   action_class_recomputed → session_bound → authorization_valid → scope_adjudicated →
    //   engagement_running → lease_valid → addresses_adjudicated
    //
    // 短路是语义的一部分（`runAdmissionGates` 第一个非 pass 即返回）：顺序承载 §10.2 的
    // 优先级——模板未注册必须报 `classification_rejected`，而不是「你缺租约」。
    const state = new AdmissionState({
      intent: input,
      now,
      binding: earlyBinding,
      ports: {
        registry,
        policy: deps.policy,
        ...(deps.audit === undefined ? {} : { audit: deps.audit }),
      },
    });
    const verdict = await runAdmissionGates(state);
    if (verdict.kind === 'rejected') {
      // 闸门只返回「该记一条什么事件」，写事件是**这里**的事：管线因此保持只读，
      // 单道闸门也不依赖账本/门铃/控制台是否存在。
      if (verdict.gateFailure !== undefined) await recordGateFailure(verdict.gateFailure);
      return { kind: 'rejected', error: verdict.error };
    }
    // 闸门通过后，装配阶段从状态里取事实。访问器在事实缺失时抛错——那表示闸门顺序
    // 被破坏（编程错误，测试会当场发现），而不是输入问题：后者已经在上面变成了拒绝。
    const { spec, params, purpose, actionClass, scope, resolvedAddresses } = state;
    const binding = state.requireBinding();


    // 8. 幂等键与计划摘要：服务端派生，不采信 Agent 传值。
    //
    // 策略读取（第 9 步的判断）提前到这里：`policyVersion` 与展开后的 `pacing`
    // **必须进入计划摘要**（§10.2 的第二条硬要求），否则改 pacing 不会让旧凭证失效。
    // 判定顺序不变——读取本身不产生结论，结论仍在下面按原顺序给出。
    const actionPolicy = await actions.forSession(input.workerSessionId);
    const normalizedTarget = canonicalTargetString(scope.normalized);
    const normalizedCommand = buildNormalizedCommand(spec, scope.normalized, params);
    // 给人类看的形态：把 `*_b64` 参数解码（放行卡是唯一内容闸门，不能让人类对着 base64 点批准）。
    const displayCommand = buildDisplayCommand(spec, params);
    const pacing = actionPolicy.pacing ?? null;
    const planHash = derivePlanHash({
      templateId: spec.template.id,
      actionClass,
      normalizedTarget,
      normalizedCommand,
      timeoutMs: spec.template.timeoutMs,
      maxOutputBytes: spec.template.maxOutputBytes,
      scopeVersion: binding.scopeVersion,
      policyEpoch: binding.policyEpoch,
      policyVersion: actionPolicy.policyVersion ?? null,
      pacing,
    });

    // 9. 是否需要人工放行。
    if (
      DISABLED_BY_DEFAULT.includes(actionClass) &&
      !(
        actionPolicy.dualConfirmed === true &&
        (actionPolicy.enabledDisabledClasses ?? []).includes(actionClass)
      )
    ) {
      await recordPolicyCheck({
        engagementId: binding.engagementId,
        workerSessionId: input.workerSessionId,
        decision: 'rejected',
        rule: 'disabled_by_default',
        actionClass,
        planHash,
        binding,
        actionPolicy,
      });
      return {
        kind: 'rejected',
        error: blocked(
          'classification_rejected',
          `类别 ${actionClass} 默认不启用，且未在 engagement 策略中显式开启（需双人确认）`,
          '由人类在 engagement 策略中显式开启该类别并双人确认',
        ),
      };
    }
    // 行为预设**不再是被拒的理由**（2026-10-04 决定）：预设是提示词，不是硬闸。
    // 不在启用集合里 = 「超出当前预设」→ **强制走人工放行**，而不是拒绝：
    // 拒绝只会让 Agent 反复试探、或干脆放弃本来合理的动作；把人留在回路里才是真正的边界。
    const beyondPreset =
      actionPolicy.enabledActionClasses !== undefined && !actionPolicy.enabledActionClasses.includes(actionClass);
    if (beyondPreset) {
      const presetCheckError = await recordPolicyCheck({
        engagementId: binding.engagementId,
        workerSessionId: input.workerSessionId,
        decision: 'needs_approval',
        rule: 'beyond_behavior_preset',
        actionClass,
        planHash,
        binding,
        actionPolicy,
      });
      // 审计写不进去就**停止**（§11.5：审计不可用时所有触及目标的动作一律停止）。
      // 与下面逐次放行路径同一条纪律——不能因为「反正还要人批」就放它过去：
      // 人要批的是「服务端记录在案的动作」，记录不下来的动作不该出现在放行队列里。
      if (presetCheckError !== undefined) {
        return {
          kind: 'rejected',
          error: blocked(
            presetCheckError.code,
            `${presetCheckError.message}（超出行为预设的动作已停止受理）`,
            '恢复审计写入后重新提交；审计不可用时不要执行触及目标的动作',
          ),
        };
      }
    }
    let approvalId =
      input.approvalId !== undefined && input.approvalId.length > 0 ? input.approvalId : null;
    // 超出预设的动作一律走放行；逐次放行的契约下限照旧（两者是「或」的关系）。
    const requiresApproval = beyondPreset || actionPolicy.perActionApprovalClasses.includes(actionClass);

    // 标记：本次受理是否由服务端自行放行（决定最终返回的决策态）。
    let selfApprovedNow = false;
    if (requiresApproval && approvalId === null) {
      // 高权限模式：预设内、且非默认禁用类别的动作由服务端自行放行（凭证直接 approved）。
      // 判定是纯函数、只有一处实现（`shouldSelfApprove`），因此「申请放行」与「直接执行」
      // 两条路径的结论必然一致。
      const selfApprove = shouldSelfApprove(actionPolicy, actionClass);
      // 人类要能看出「凭什么问我」：把拦下的那条规则原样写进放行记录。
      const approvalReason = selfApprove
        ? undefined
        : beyondPreset
          ? `超出行为预设：${actionClass} 不在本作业预设的启用集合里`
          : `${actionClass} 属于逐次放行类别（当前审批模式：${actionPolicy.approvalMode ?? 'human'}）`;
      const created = await deps.store.requestApproval({
        workerSessionId: input.workerSessionId,
        leaseGeneration: binding.lease === null ? 0 : binding.lease.generation,
        actionClass,
        templateId: spec.template.id,
        params,
        targetSelector: input.targetSelector,
        planHash,
        normalizedTarget,
        normalizedCommand,
        displayCommand,
        scopeVersion: binding.scopeVersion,
        policyEpoch: binding.policyEpoch,
        timeoutMs: spec.template.timeoutMs,
        maxOutputBytes: spec.template.maxOutputBytes,
        purpose,
        expiresAt: new Date(now.getTime() + approvalTtlSeconds * 1000),
        ...(approvalReason === undefined ? {} : { approvalReason }),
        ...(selfApprove
          ? {
              selfApproval: {
                decidedBy: 'server:auto-approval',
                reason:
                  `高权限模式（approval_mode=auto）：${actionClass} 在行为预设的启用集合内且非默认禁用类别，` +
                  '服务端自行放行；超出预设与 persistence/destructive/exfiltration 仍需人类',
              },
            }
          : {}),
      });
      const checkError = await recordPolicyCheck({
        engagementId: binding.engagementId,
        workerSessionId: input.workerSessionId,
        decision: selfApprove ? 'admitted' : 'needs_approval',
        rule: selfApprove ? 'self_approved_in_auto_mode' : 'per_action_approval',
        actionClass,
        planHash,
        binding,
        actionPolicy,
        approvalId: created.approvalId,
      });
      // 审计写不进去时**不静默**：凭证已经落库，但这次受理没有被记录。
      // 因此把凭证一并交给调用方，并明确它不作为可用放行依据——
      // 静默丢弃会让队列里出现一条谁也解释不清的待处理凭证。
      if (checkError !== undefined) {
        return {
          kind: 'rejected',
          error: blocked(
            checkError.code,
            `${checkError.message}（放行凭证 ${created.approvalId} 已创建但不作为可用放行依据）`,
            '恢复审计写入后重新提交；不要在审计不可用时使用该凭证',
            created.approvalId,
          ),
        };
      }
      if (selfApprove) {
        // 不放行返回：把凭证带进计划继续装配——人类已经在建作业时选了「高权限」，
        // 这一步不该再让他点一次「同意」。
        approvalId = created.approvalId;
        selfApprovedNow = true;
      } else {
        return { kind: 'needs_approval', approvalId: created.approvalId, planHash };
      }
    }

    if (approvalId !== null) {
      // 携带凭证：无论类别是否需要逐次放行，都按绑定关系复核，不匹配即拒绝。
      const record = await deps.store.getApproval(approvalId);
      const violation = approvalViolation(
        record,
        approvalId,
        {
          workerSessionId: input.workerSessionId,
          actionClass,
          planHash,
          leaseGeneration: binding.lease === null ? 0 : binding.lease.generation,
        },
        now,
      );
      if (violation !== undefined) return { kind: 'rejected', error: violation };
    }

    // 自铸凭证（auto 档）**不参与**幂等身份：每次受理都会新建一张 approved 凭证，
    // 把它带进键会让同一条命令的重发得到新键——唯一约束与重放同时失效，命令真的执行
    // 两次（事故 2026-10-05，auto 档幂等失效）。人类凭证仍进键：那是一张一次性授权的身份，
    // 换凭证 = 新动作，必须换键。
    const idempotencyKey = deriveIdempotencyKey({
      workerSessionId: input.workerSessionId,
      actionClass,
      normalizedTarget,
      normalizedCommand,
      approvalId: selfApprovedNow ? '' : (approvalId ?? ''),
    });
    const plan: ExecutionPlan = {
      workerSessionId: input.workerSessionId,
      templateId: spec.template.id,
      actionClass,
      normalizedTarget,
      resolvedAddresses,
      normalizedCommand,
      ...(displayCommand === undefined ? {} : { displayCommand }),
      planHash,
      idempotencyKey,
      scopeVersion: binding.scopeVersion,
      policyEpoch: binding.policyEpoch,
      ...(actionPolicy.policyVersion === undefined ? {} : { policyVersion: actionPolicy.policyVersion }),
      pacing,
      leaseGeneration: binding.lease === null ? 0 : binding.lease.generation,
      approvalId,
      timeoutMs: spec.template.timeoutMs,
      maxOutputBytes: spec.template.maxOutputBytes,
    };
    const auditError = await recordPolicyCheck({
      engagementId: binding.engagementId,
      workerSessionId: input.workerSessionId,
      decision: 'admitted',
      rule: approvalId === null ? 'policy_allow' : 'approval_verified',
      actionClass,
      planHash,
      binding,
      actionPolicy,
      ...(approvalId === null ? {} : { approvalId }),
    });
    // 审计写不进去时**不放行**（§15.1）：已经决定的动作也不能带着一条写不进去的痕迹跑起来。
    if (auditError !== undefined) return { kind: 'rejected', error: auditError };
    return selfApprovedNow
      ? { kind: 'self_approved', approvalId: approvalId ?? '', planHash, plan }
      : { kind: 'admitted', plan };
  }

  /**
   * 记一条 `execution.policy.checked`（§6.2.0.5、§10.2）。
   *
   * 返回错误而不是抛：**受理路径要把审计失败翻译成拒绝**（§15.1 的硬约束），
   * 而拒绝的形状是 `ToolError`。省略端口时返回 `undefined`（只读装配与单测）。
   */
  async function recordPolicyCheck(input: {
    readonly engagementId: string;
    readonly workerSessionId: string;
    readonly decision: 'admitted' | 'needs_approval' | 'rejected';
    readonly rule: string;
    readonly actionClass: ActionClass;
    readonly planHash: string;
    readonly binding: SessionBinding;
    readonly actionPolicy: ActionPolicySnapshot;
    readonly approvalId?: string;
    /** 执行侧的第二条审计（沙箱启动前）带上它，使策略判定与具体运行可对齐回放（设计 §8.2）。 */
    readonly toolRunId?: string;
  }): Promise<ToolError | undefined> {
    const sink = deps.executionAudit;
    if (sink === undefined) return undefined;
    const payload = {
      decision: input.decision,
      rule: input.rule,
      actionClass: input.actionClass,
      planHash: input.planHash,
      scopeVersion: input.binding.scopeVersion,
      policyEpoch: input.binding.policyEpoch,
      policyVersion: input.actionPolicy.policyVersion ?? null,
      pacing: input.actionPolicy.pacing ?? null,
      perActionApprovalClasses: input.actionPolicy.perActionApprovalClasses,
      ...(input.approvalId === undefined ? {} : { approvalId: input.approvalId }),
      ...(input.toolRunId === undefined ? {} : { toolRunId: input.toolRunId }),
    };
    try {
      await sink.record({
        eventType: 'execution.policy.checked',
        engagementId: input.engagementId,
        workerSessionId: input.workerSessionId,
        payload,
      });
      return undefined;
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      return blocked(
        'audit_unavailable',
        `策略审计写入失败（${input.decision}）：${detail}`,
        '恢复审计写入后重新提交；在此之前不要重试',
      );
    }
  }

  /** 执行侧事件（pacing / 停止 / 检测迹象）。记录失败即抛出——这些事实不能被静默丢弃。 */
  async function recordExecutionEvent(input: {
    readonly eventType: 'execution.pacing.applied' | 'execution.detection_signal' | 'execution.stopped';
    readonly engagementId: string;
    readonly workerSessionId: string;
    readonly payload: Readonly<Record<string, unknown>>;
  }): Promise<void> {
    const sink = deps.executionAudit;
    if (sink === undefined) return;
    await sink.record(input);
  }

  /**
   * 结算回写：有限重试。`SQL_FINISH_RUN` 是 `update ... where id = $1`，running → 终态
   * 是合法边，因此重试幂等。返回失败详情而不是抛出——调用方要把它翻译成**结构化
   * blocked**（2026-10-05 复核 GAP-5：抛错会让结果只存在于内存、行停在 running，
   * 同键重试被 `idempotent_replay` 死锁到对账窗口之后）。
   */
  async function finishRunWithRetry(
    toolRunId: string,
    result: ToolRunResult,
  ): Promise<{ readonly ok: true } | { readonly ok: false; readonly detail: string }> {
    let detail = '';
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        await deps.store.finishRun(toolRunId, result);
        return { ok: true };
      } catch (error) {
        detail = error instanceof Error ? error.message : String(error);
        if (attempt < 3) {
          // 线性退避：给瞬时故障（连接被回收、网络抖动）一次机会，又不拖长调用链。
          await delayMs(attempt * 50);
        }
      }
    }
    return { ok: false, detail };
  }

  /**
   * 执行前对**外部状态**的重裁决：策略/授权时效（`validateExecution`）、会话绑定、
   * engagement 状态、租约、范围版本、策略 epoch。
   *
   * 返回拒绝原因或当前绑定。**不含凭证复核**——`commitRun` 之后凭证已被消费，
   * 复核它必然报「已消费」；凭证只在 commit 前那一次由调用方另做。
   *
   * 调用点有两处：`commitRun` 之前，以及**取得 pacing 槽位之后**（2026-10-05 复核 GAP-3：
   * 等待可能是分钟级，期间租约吊销/到期、作业暂停/终止、授权到期都不经过
   * 「策略 epoch 前进」这条线，`abortInFlight` 看不到在途动作）。
   */
  async function revalidateBeforeTarget(
    plan: ExecutionPlan,
    now: Date,
  ): Promise<{ readonly ok: true; readonly binding: SessionBinding } | { readonly ok: false; readonly error: ToolError }> {
    const policyCheck = await deps.policy.validateExecution(plan);
    if (!policyCheck.ok) return { ok: false, error: policyCheck.error };

    const binding = await deps.sessions.binding(plan.workerSessionId);
    if (binding === undefined) {
      return {
        ok: false,
        error: blocked(
          'lease_required',
          `执行前复核失败：会话 ${plan.workerSessionId} 没有会话绑定`,
          '重新申请会话与放行凭证',
        ),
      };
    }
    const engagementError = engagementViolation(binding, plan.workerSessionId);
    if (engagementError !== undefined) return { ok: false, error: engagementError };
    const leaseError = leaseViolation(binding, plan.leaseGeneration, now, plan.workerSessionId);
    if (leaseError !== undefined) return { ok: false, error: leaseError };
    if (binding.scopeVersion !== plan.scopeVersion) {
      return {
        ok: false,
        error: blocked(
          'stale_state_version',
          `执行前复核失败：会话绑定的范围版本已变化（计划 ${plan.scopeVersion}，当前 ${binding.scopeVersion}）`,
          '范围修订后旧凭证与旧计划失效，重新申请放行',
        ),
      };
    }
    if (binding.policyEpoch !== plan.policyEpoch) {
      return {
        ok: false,
        error: blocked(
          'stale_state_version',
          `执行前复核失败：策略 epoch 已前进（计划 ${plan.policyEpoch}，当前 ${binding.policyEpoch}）`,
          '策略或范围变更后在途动作必须停止，重新申请放行',
        ),
      };
    }
    return { ok: true, binding };
  }

  /**
   * 执行（§10.3.1）：先幂等重放判定，再执行前重新裁决，最后原子消费凭证并下发令牌。 */
  async function execute(plan: ExecutionPlan, signal: AbortSignal): Promise<ToolRunResult> {
    const now = clock();
    if (signal.aborted) return { status: 'cancelled' };

    // A. 幂等重放：同一会话内重复提交同一动作命中已有运行并返回原结果，不重复执行。
    const existing = await deps.store.findRunByIdempotencyKey(plan.idempotencyKey);
    if (existing !== undefined) {
      if (existing.planHash !== plan.planHash) {
        return {
          status: 'blocked',
          error: blocked(
            'idempotent_replay',
            '幂等键命中已有运行但计划摘要不同：拒绝复用他人结果',
            '以一致的 (模板, 目标, 参数, 放行凭证) 重新构造计划',
          ),
        };
      }
      return existing.result;
    }

    // B. 执行前重新裁决。
    if (registry.get(plan.templateId) === undefined) {
      return {
        status: 'blocked',
        error: blocked(
          'classification_rejected',
          `执行前复核失败：动作模板 ${plan.templateId} 已不在注册表中`,
          '重新构造计划',
        ),
      };
    }
    // 复核必须使用计划里**携带的**策略元数据（缺失即视为无策略版本/无 pacing），
    // 而不是重新读一遍会话策略：复核对的是「人类批准的那份计划有没有被动过」。
    const recomputedHash = derivePlanHash({
      ...plan,
      policyVersion: plan.policyVersion ?? null,
      pacing: plan.pacing ?? null,
    });
    if (recomputedHash !== plan.planHash) {
      return {
        status: 'blocked',
        error: blocked(
          'stale_state_version',
          '执行前复核失败：计划内容与计划摘要不一致（计划被改动）',
          '重新走 admit 生成计划',
        ),
      };
    }
    const preTarget = await revalidateBeforeTarget(plan, now);
    if (!preTarget.ok) return { status: 'blocked', error: preTarget.error };
    const binding = preTarget.binding;

    // C. 凭证复核（若该计划绑定凭证）。
    const approvalId = plan.approvalId;
    if (approvalId !== null) {
      const record = await deps.store.getApproval(approvalId);
      const violation = approvalViolation(
        record,
        approvalId,
        {
          workerSessionId: plan.workerSessionId,
          actionClass: plan.actionClass,
          planHash: plan.planHash,
          leaseGeneration: plan.leaseGeneration,
        },
        now,
      );
      if (violation !== undefined) return { status: 'blocked', error: violation };
    }

    const toolRunId = newId('run');
    const commit = await deps.store.commitRun({
      toolRunId,
      workerSessionId: plan.workerSessionId,
      idempotencyKey: plan.idempotencyKey,
      planHash: plan.planHash,
      approvalId,
      leaseGeneration: plan.leaseGeneration,
      toolName: EXEC_TOOL_NAME,
      actionClass: plan.actionClass,
      templateId: plan.templateId,
      normalizedTarget: plan.normalizedTarget,
      normalizedCommand: plan.normalizedCommand,
      scopeVersion: plan.scopeVersion,
      policyEpoch: plan.policyEpoch,
      approvalRequired: approvalId !== null,
    });
    if (!commit.ok) {
      const approvalRef = approvalId === null ? undefined : approvalId;
      switch (commit.reason) {
        case 'approval_consumed':
          return {
            status: 'blocked',
            error: blocked(
              'approval_consumed',
              '放行凭证已被消费：一次性授权不得重复使用',
              '重新申请放行',
              approvalRef,
            ),
          };
        case 'approval_not_found':
          return {
            status: 'blocked',
            error: blocked('approval_required', '放行凭证不存在', '重新申请放行', approvalRef),
          };
        case 'stale_state_version':
          return {
            status: 'blocked',
            error: blocked(
              'stale_state_version',
              '最终提交复核发现范围版本或策略 epoch 已前进；动作未登记且未执行（凭证未被消费）',
              '范围/策略变更后在途动作必须停止，重新构造计划；不要重试旧计划',
              approvalRef,
            ),
          };
        case 'lease_required':
        case 'lease_expired':
        case 'lease_revoked':
        case 'lease_generation_stale':
        case 'engagement_halted':
          return {
            status: 'blocked',
            error: blocked(
              commit.reason,
              '最终提交复核发现会话、租约或 engagement 状态已变化；动作未登记且未执行',
              '等待控制台恢复当前会话/租约后重新构造计划；不要重试旧计划',
              approvalRef,
            ),
          };
        default:
          return {
            status: 'blocked',
            error: blocked(
              'idempotent_replay',
              '同一幂等键的运行已存在，事务拒绝重复登记',
              '查询既有运行结果，不重复执行',
            ),
          };
      }
    }

    // 沙箱启动前的**第二条**策略审计（设计 §8.2 硬要求：动作受理时一次、沙箱/代理启动前
    // 一次，两次必须带同一 tool_run；任一次失败都不得启动目标连接）。
    // 无条件写：pacing 为 null 或无需等待时也必须有这条记录——否则 commitRun 与目标接触
    // 之间可能没有任何审计写入（事故 2026-10-05）。读策略或写审计失败一律不启动沙箱（§15.1）。
    let preSandboxError: ToolError | undefined;
    try {
      const sandboxPolicy = await actions.forSession(plan.workerSessionId);
      preSandboxError = await recordPolicyCheck({
        engagementId: binding.engagementId,
        workerSessionId: plan.workerSessionId,
        decision: 'admitted',
        rule: 'pre_sandbox_recheck',
        actionClass: plan.actionClass,
        planHash: plan.planHash,
        binding,
        actionPolicy: sandboxPolicy,
        toolRunId,
        ...(approvalId === null ? {} : { approvalId }),
      });
    } catch (error) {
      preSandboxError = blocked(
        'audit_unavailable',
        `沙箱启动前复核失败：${error instanceof Error ? error.message : String(error)}`,
        '恢复后重新提交；同一动作的已登记结果会按幂等键命中，不会重复执行',
      );
    }
    if (preSandboxError !== undefined) {
      const failure: ToolRunResult = { status: 'blocked', error: preSandboxError };
      await deps.store.finishRun(toolRunId, failure);
      return failure;
    }

    // E. 沙箱执行；在途动作登记后，策略 epoch 前进时可被终止。
    const controller = new AbortController();
    const combined = AbortSignal.any([signal, controller.signal]);
    inFlight.set(toolRunId, {
      engagementId: binding.engagementId,
      policyEpoch: plan.policyEpoch,
      controller,
    });
    // pacing 槽位：取得即意味着「本动作按冻结策略的节奏开始」。取得失败（被中止）
    // 不进入沙箱——那正是策略 epoch 前进要终止的对象。
    const pacing = plan.pacing ?? null;
    let slotHeld = false;
    if (pacing !== null) {
      try {
        await pacingGate.acquire(binding.engagementId, pacing, combined);
        slotHeld = true;
      } catch {
        inFlight.delete(toolRunId);
        const stopped = { status: 'cancelled' } as const;
        await deps.store.finishRun(toolRunId, stopped);
        await recordExecutionEvent({
          eventType: 'execution.stopped',
          engagementId: binding.engagementId,
          workerSessionId: plan.workerSessionId,
          payload: {
            reason: 'aborted_during_pacing_wait',
            phase: 'pacing',
            planHash: plan.planHash,
            policyEpoch: plan.policyEpoch,
          },
        });
        return stopped;
      }
    }
    let result: ToolRunResult;
    // 是否因「取得槽位后的第二次复核」被拦下：用于停止审计的 reason（见下）。
    let rejectedAfterWait = false;
    // 从**取得槽位之后**的全部步骤（含第二次复核、pacing 审计、沙箱运行）都必须落在这一个
    // try/finally 里：否则任何一步抛错都会让槽位永不释放，该作业后续动作会在
    // 并发等待循环里无限卡住（无自愈路径）。
    try {
      // 取得槽位后、接触目标前的**第二次**复核（2026-10-05 复核 GAP-3）：
      // pacing 等待可能是分钟级，而等待期间租约吊销/到期、作业暂停/终止、授权到期
      // 都不会经过「策略 epoch 前进」这条线（`abortInFlight` 只认它），因此必须重读
      // 外部状态。凭证已在 commitRun 被消费，这一步**不复核凭证**。
      const postWait = await revalidateBeforeTarget(plan, clock());
      if (!postWait.ok) {
        rejectedAfterWait = true;
        result = { status: 'blocked', error: postWait.error };
      } else {
        let auditFailure: string | null = null;
        if (pacing !== null && pacingImposesWait(pacing)) {
          try {
            await recordExecutionEvent({
              eventType: 'execution.pacing.applied',
              engagementId: binding.engagementId,
              workerSessionId: plan.workerSessionId,
              payload: {
                phase: 'admit_before_sandbox',
                planHash: plan.planHash,
                scopeVersion: plan.scopeVersion,
                policyEpoch: plan.policyEpoch,
                policyVersion: plan.policyVersion ?? null,
                pacing,
              },
            });
          } catch (error) {
            auditFailure = error instanceof Error ? error.message : String(error);
          }
        }
        if (auditFailure !== null) {
          // 审计写不进去就**不执行**（§15.1）：一条记录不下来的节奏事实，
          // 等于这次动作的约束没有留下可回放的证据。处置是恢复审计，而不是查沙箱。
          result = {
            status: 'blocked',
            error: blocked(
              'audit_unavailable',
              `策略节奏审计写入失败：${auditFailure}`,
              '恢复审计写入后重新提交；在此之前不要重试',
            ),
          };
        } else {
          result = await deps.sandbox.run({ plan }, combined);
        }
      }
    } catch (error) {
      if (combined.aborted) {
        result = { status: 'cancelled' };
      } else {
        const detail = error instanceof Error ? error.message : String(error);
        result = {
          status: 'blocked',
          error: blocked(
            'sandbox_unavailable',
            `沙箱执行失败：${detail}`,
            '确认沙箱可用后重试；同一动作的已登记结果会按幂等键命中，不会重复执行',
          ),
        };
      }
    } finally {
      inFlight.delete(toolRunId);
      if (slotHeld) pacingGate.release(binding.engagementId);
    }
    // 结算回写必须**稳定**（2026-10-05 复核 GAP-5）：抛错会让结果只存在于内存、行停在
    // running，而同键重试会被 `idempotent_replay` 死锁到对账窗口（>16 分钟）之后。
    const sandboxOutcome = result;
    const settlement = await finishRunWithRetry(toolRunId, result);
    if (!settlement.ok) {
      result = {
        status: 'blocked',
        error: blocked(
          'audit_unavailable',
          `运行结果回写失败：${settlement.detail}。动作**已执行**（运行 ${toolRunId}），但结果未能入库`,
          '人工核查该运行的实际情况后再决定是否重试；不要直接重跑同一动作',
        ),
      };
    }
    // 停止与检测迹象进审计（§6.2.0.5）：不记这两个事实，事后无法回答
    // 「动作是被谁停的」与「目标是否已经在限速我们」。
    if (sandboxOutcome.status === 'cancelled' || sandboxOutcome.status === 'timed_out' || rejectedAfterWait) {
      const stopReason = rejectedAfterWait
        ? 'rejected_after_wait'
        : sandboxOutcome.status === 'timed_out' ? 'timeout' : 'aborted';
      await recordExecutionEvent({
        eventType: 'execution.stopped',
        engagementId: binding.engagementId,
        workerSessionId: plan.workerSessionId,
        payload: {
          reason: stopReason,
          phase: 'sandbox',
          planHash: plan.planHash,
          policyEpoch: plan.policyEpoch,
          actionClass: plan.actionClass,
        },
      });
    }
    const detected = detectionSignalOf(result);
    if (detected !== null) {
      await recordExecutionEvent({
        eventType: 'execution.detection_signal',
        engagementId: binding.engagementId,
        workerSessionId: plan.workerSessionId,
        payload: {
          signal: detected,
          actionClass: plan.actionClass,
          planHash: plan.planHash,
          action: 'record_only',
        },
      });
    }
    return result;
  }

  return {
    admit,
    execute,

    /** 一次性消费：第二次必须返回 false（由存储层事务保证）。 */
    async consumeApproval(approvalId: string, toolRunId: string): Promise<boolean> {
      return deps.store.consumeApproval(approvalId, toolRunId);
    },

    /** 策略 epoch 前进：终止该 engagement 下按旧 epoch 签发的在途动作（§10.3.1）。 */
    async abortInFlight(engagementId: string, newPolicyEpoch: number): Promise<number> {
      let aborted = 0;
      for (const entry of inFlight.values()) {
        if (entry.engagementId !== engagementId) continue;
        if (entry.policyEpoch >= newPolicyEpoch) continue;
        aborted += 1;
        entry.controller.abort(new Error(`策略 epoch 已前进到 ${newPolicyEpoch}，在途动作终止`));
      }
      return aborted;
    },
  };
}
