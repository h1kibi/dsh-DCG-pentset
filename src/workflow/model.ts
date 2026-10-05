/**
 * 工作流域的**纯层**：契约之外的领域类型、常量与纯函数。
 *
 * 从 `pg-workflow.ts` 机械搬运而来（拆分目标：该文件只留组合与服务类）。
 * 本模块不持有状态、不碰数据库；服务类与各流程类从这里取类型与领域判定。
 * 为便于同域引用，搬运时统一加 `export`（模块本身不出现在包的公开导出面）。
 */

import type { ActionClass, ApprovalPlanValidator, BehaviorProfile, ErrorCode, MainStatus, Phase, RunMarker, ScopeDecision, ScopeEntryProfile, ScopePreviewEntry, ScopeProposal, ScopeVersionDetail, SessionKind } from '../contracts.ts';
import { EXEC_TOOL_NAME, HUMAN_QUESTION_TOOL } from '../contracts.ts';
import { normalizeScopeEntry } from '../policy/scope.ts';
import type { NormalizedScope } from '../policy/scope-snapshot.ts';
import { SKILL_PACKS } from '../skills/skill-pack.ts';
import type { NormalizedScopeEntry } from '../policy/scope.ts';
import type { ScopeTarget } from '../contracts.ts';
import type { DbClient } from '../memory/ledger.ts';
import { RECOMMENDED_MOVES } from './phases.ts';
import type { SessionFactory, ModelRoute, ActionTemplateBrief } from './session-port.ts';
import type { LeaseStore } from './lease.ts';
import type { MemoryLedgerService, PentestReportService, ReportSignatureService, RequiredHandoffKey } from '../contracts.ts';

export /** 公共记忆的长度上限（字符）。见 `updateEngagementMemory` 的说明。 */
const PUBLIC_MEMORY_MAX_CHARS = 8000;

export /**
 * 公共记忆的长度闸门。
 *
 * 抽成函数是因为它必须在**两个入口**（创建与更新）都生效：那段文本会被整段拼进
 * 该作业每一次会话的系统提示词，因此「有多长」是这条面上唯一的上下文占用闸门。
 * 两处各写一遍必然漂移——实测就漂了：创建路径曾经完全没有检查。
 */
function assertPublicMemorySize(content: string): void {
  if (content.length > PUBLIC_MEMORY_MAX_CHARS) {
    throw new WorkflowRejection(
      'classification_rejected',
      `公共记忆超出上限（${String(content.length)} > ${String(PUBLIC_MEMORY_MAX_CHARS)} 字符）。` +
        '它会被注入每一次会话的提示词，过长会挤掉任务本身需要的上下文。',
    );
  }
}

export /**
 * 确认路径的展开结果。
 *
 * 具名类型而不是 `ReturnType<typeof …>`：预览与确认两侧都要引用它，
 * 而 `typeof` 会把两个调用点都钉在实现细节上（改一次签名，报错指向内部而不是契约）。
 */
interface ConfirmationExpansion {
  readonly scope: NormalizedScope;
  readonly scopeEntryProfile: ScopeEntryProfile;
  readonly behaviorProfile: BehaviorProfile;
  readonly policySnapshot: Readonly<Record<string, unknown>>;
  readonly policyHash: string;
}

export /**
 * 工作流服务依赖。全部注入，便于测试与替换。 */
/**
 * `policy.snapshot.previewed` 的风险摘要：只从**展开后的**动作策略里取。
 *
 * 输入是服务端的展开结果，不是浏览器提交的字段——预览摘要必须能被用来核对
 * 「人类看到的风险」与「实际冻结的风险」，读客户端输入会让这个核对失去意义。
 */
function actionPolicyRiskSummary(
  snapshot: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  const policy = snapshot['action_policy'];
  const list = (key: string): readonly string[] => {
    if (typeof policy !== 'object' || policy === null) return [];
    const value = (policy as Record<string, unknown>)[key];
    return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
  };
  return {
    enabled: list('enabled'),
    disabled: list('disabled'),
    perActionApprovalClasses: list('perActionApprovalClasses'),
    credentialMode: typeof snapshot['credential_mode'] === 'string' ? snapshot['credential_mode'] : null,
  };
}

export interface WorkflowServiceDeps {
  /**
   * 本部署可用的记忆检索通道（装配方按是否配置嵌入端点决定）。
   * 缺省按"无向量"处理——这是当前部署的真实状态，宁可少报也不谎报语义可用。
   */
  readonly retrievalChannels?: readonly string[];
  /** 读路径。 */
  readonly db: DbClient;
  /**
   * 写路径：**独占连接**。转移事务的 BEGIN/COMMIT 必须落在同一连接上，
   * 用连接池会让事务静默失效。由组合根提供。
   */
  readonly txDb: DbClient;
  readonly sessions: SessionFactory;
  readonly leases: LeaseStore;
  /** 审计事件落点。领域事件只进数据库，绝不进会话日志（§8.2）。 */
  readonly ledger: MemoryLedgerService;
  /** 报告服务；`finishTechnicalTesting` 需要它。 */
  readonly report?: PentestReportService;
  /** 报告签字的内部事务读面；不暴露为控制台端点。 */
  readonly reportSignature?: ReportSignatureService;
  /** 阶段 → 该阶段 Agent 的冻结能力来源。省略则用内置默认。 */
  readonly capabilities?: CapabilityResolver;
  /**
   * 内置默认能力使用的模型路由；省略即 {@link DEFAULT_MODEL_ROUTE}。
   *
   * 只有**没有**自定义 `capabilities` 时才生效：自定义解析器自带路由。
   */
  readonly modelRoute?: ModelRoute | (() => ModelRoute | undefined);
  /** 目标阶段的 Profile 声明了哪些必需键（§7.2）。 */
  readonly requiredHandoffKeys?: (phase: Phase) => readonly RequiredHandoffKey[];
  /** 受信动作模板目录（装配层从策略服务的注册表取）。 */
  readonly actionTemplates?: () => readonly ActionTemplateBrief[];
  readonly approvalPlanValidator?: ApprovalPlanValidator;
  readonly clock?: () => Date;
  readonly newId?: () => string;
  readonly rlsContext?: { readonly tenantId: string };
  /**
   * RLS 作用域运行器。每个触及 engagement 数据的操作都必须在正确的作业作用域里
   * 运行——engagement 不再是进程级状态，因此**这里没有可以兜底的全局值**。
   *
   * 省略即不做作用域管理（迁移连接、测试替身那些本就绕过 RLS 的部署）。
   */
  readonly leaseRlsContextForSession?: (workerSessionId: string) => Promise<{ readonly tenantId: string; readonly engagementId: string } | null>;
  /**
   * DNS 裁决钩子（§10.2.2 地址固定）：与策略服务用的是**同一个**函数。
   *
   * 预览要在人类确认前显示「动作会拨到哪个地址」，而该判定必须与执行期一致——
   * 两处各配一份解析器会让预览显示 A、执行拨到 B。
   */
  readonly resolveAddresses?: (host: string) => Promise<readonly string[] | undefined>;
  readonly rlsScope?: RlsScopePort;
  /**
   * 策略 epoch 前进后（**事务已提交**）终止旧 epoch 的在途动作（§10.3.1）。
   *
   * 放在提交之后是刻意的：中止失败不能把已经提交的策略变更回滚掉——回滚会让
   * 「库里是旧边界、内存里是新边界」变成两套事实。因此错误显式向上抛，由调用方看到。
   *
   * 返回**实际终止的动作数**：调用方据此写 `execution.stopped` 审计——只说
   * 「epoch 前进了」而不说「终止了几个动作」，事后无法回答那次变更的真实影响。
   */
  readonly onPolicyEpochAdvanced?: (input: {
    readonly engagementId: string;
    readonly newPolicyEpoch: number;
    readonly cause: 'scope_amended' | 'policy_amended';
  }) => Promise<number>;
}

/**
 * RLS 作用域端口。
 *
 * `run` 建立作用域；`current` 读当前作用域（用于断言调用方与作用域一致，
 * 以及在既有的 `#tx(work, engagementId)` 调用点上校验）。
 */
export interface RlsScopePort {
  run<T>(
    scope: { readonly engagementId?: string | null; readonly workerSessionId?: string | null },
    work: () => Promise<T>,
  ): Promise<T>;
  current(): { readonly tenantId: string; readonly engagementId: string | null; readonly workerSessionId: string | null } | undefined;
}

/**
 * 阶段能力的解析结果（冻结进会话前的那一份）。
 *
 * 具名导出而不是内联在 {@link CapabilityResolver.resolve} 的返回位置：它是**跨模块的契约面**
 * （会话工厂、intake staging 都要传递它），内联形状会让下游只能用
 * `Awaited<ReturnType<...>>` 这类「跟着实现走」的写法表达类型——那是耦合，不是契约。
 */
export interface ResolvedCapabilities {
  readonly profileId: string;
  readonly profileRevision: string;
  readonly defaultSkillIds: readonly string[];
  readonly defaultToolAllow: readonly string[];
  readonly modelRoute: { readonly provider: string; readonly model: string };
}

/** 阶段的默认能力来源。真实部署由 Profile 目录提供。 */
export interface CapabilityResolver {
  resolve(phase: Phase): Promise<ResolvedCapabilities>;
}

export /**
 * 会话即 intake 的作业名。
 *
 * 人类在对话里给了名字就用它；没给就用会话标识派生一个占位名——
 * 一个没有名字的作业在控制台列表里无法辨认，而这里正是「人类还没提供信息」的常态。
 */
function normalizeEngagementName(name: string | undefined, dshSessionId: string): string {
  const trimmed = (name ?? '').trim();
  if (trimmed.length > 0) return trimmed.slice(0, 120);
  return `未命名任务 ${dshSessionId.slice(0, 12)}`;
}

export /**
 * `bootstrapIntake` 成功后交给模型转述的下一步。
 *
 * 写成「人该做什么」而不是「服务做了什么」：这段文字唯一的用途是被原样念给人类听。
 * 它同时钉住那条边界——**确认只能由人类本人点**（会话里的「待你确认」卡片，或控制台的
 * 「渗透作业 → 待人类确认的范围方案」），Agent 不能让人类在聊天里用一句「我确认」代替。
 *
 * 位置写「会话卡片或控制台」而不是只写控制台：卡片上确实有「确认并建立 engagement」
 * 按钮，只写控制台会把人类指到并不必须去的地方（阶段推进同理——卡片上有「进入下一阶段」）。
 */
const BOOTSTRAP_NEXT_STEP =
  '已为本会话建立作业（范围待确认，范围版本 0，此时没有任何目标动作能力）。' +
  '请继续向人类收集：目标、排除项、协议、端口、允许动作、时间窗。' +
  '收集到可提交的程度后调用 pentest_request_scope_confirmation 提交**待确认**方案。' +
  '最终确认由**人类本人**在本会话的「待你确认」卡片上点「确认并建立 engagement」' +
  '（控制台的「渗透作业 → 待人类确认的范围方案」是同一件事的另一个入口）；' +
  '聊天里的一句同意不构成确认，也不要替人类确认。';

export /**
 * 状态机给出的**推荐下一阶段**（`null` = 该阶段没有「推进」这条路，只有回补/重做/回环）。
 *
 * 人类说「进入下一阶段」时不需要回答「哪个阶段」：阶段是预设状态机，下一阶段由当前阶段
 * 唯一确定。这条函数就是那个「唯一确定」的定义处（与控制台阶段轨道、卡片按钮同源）。
 */
function recommendedNextPhase(from: Phase): Phase | null {
  const move = RECOMMENDED_MOVES[from].find((candidate) => candidate.kind === 'advance');
  return move === undefined ? null : move.toPhase;
}

/** 工作流拒绝：带契约里的稳定错误码。 */
export class WorkflowRejection extends Error {
  override readonly name = 'WorkflowRejection';
  readonly code: ErrorCode;

  constructor(code: ErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}

export interface EngagementRow {
  readonly id: string;
  /** 作业名（销毁确认要靠它逐字比对）。 */
  readonly name: string;
  readonly status: RunMarker;
  readonly current_status: MainStatus;
  readonly current_phase: string | null;
  readonly state_version: number | string;
  readonly graph_iteration: number | string;
  readonly active_agent_session_id: string | null;
  readonly policy_epoch: number | string;
  readonly scope_snapshot: unknown;
  /** 当前策略投影（§6.2.0.5）：`policy_versions` 的历史行不在行内，按需另读。 */
  readonly scope_entry_profile: ScopeEntryProfile;
  readonly behavior_profile: BehaviorProfile;
  readonly policy_version: number | string;
  readonly policy_snapshot: unknown;
  readonly policy_snapshot_hash: string;
  /** 归档时间（非空即从默认列表隐藏）；清理的第一级，不删任何数据。 */
  readonly archived_at: Date | null;
  /** 内容清空时间（非空即已清理，不可逆；审计骨架按 §9.5 保留）。 */
  readonly purged_at: Date | null;
}

export interface SessionRow {
  readonly id: string;
  readonly dsh_session_id: string;
  readonly phase: Phase;
  readonly status: string;
  readonly session_kind: SessionKind;
  readonly attempt: number | string;
  readonly iteration: number | string;
  readonly scope_version: number | string;
  readonly task_prompt: string;
}

export interface ScopeProposalRow {
  readonly id: string;
  readonly engagement_id: string;
  readonly worker_session_id: string;
  readonly objective: string;
  readonly proposed_targets: unknown;
  readonly proposed_exclusions: unknown;
  readonly proposed_allowed_actions: unknown;
  readonly authorization_note: string;
  readonly status: ScopeProposal['status'];
  readonly created_at: string;
  readonly decided_at: string | null;
}

export function toInt(v: number | string | null | undefined, what: string): number {
  if (typeof v === 'number') return v;
  if (typeof v === 'string') {
    const n = Number.parseInt(v, 10);
    if (Number.isFinite(n)) return n;
  }
  throw new WorkflowRejection('stale_state_version', `字段 ${what} 不是整数：${String(v)}`);
}

export /**
 * 读一个**平凡对象**；其余形态（null、数组、class 实例）返回 `undefined`。
 *
 * 用途是把 `jsonb` 读回的当前策略快照喂给展开器：展开器只接受平凡对象，
 * 而驱动层返回的形状在类型上就是 `unknown`。
 */
function asPlainRecord(value: unknown): Readonly<Record<string, unknown>> | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null
    ? (value as Readonly<Record<string, unknown>>)
    : undefined;
}

export /**
 * 从 `scope_snapshot` 里读授权到期（§11.1）。读不到即 `null`（= 未声明）。
 *
 * 不抛错：这是**展示**用途，原样把字符串交给界面，由界面区分「空」、「合法时间」与
 * 「非空但读不懂」三种形态。判定层 `PgPolicyService.authorizationValidity` 对第三种形态
 * 是**拒绝**（fail-closed），因此界面对它也不能装作「未声明到期」——那会让操作者看到一个
 * 看起来正常的总览条，而每个目标动作都被以 `authorization_expired` 拒绝。
 */
function readAuthorizationExpiry(scopeSnapshot: unknown): string | null {
  if (scopeSnapshot === null || typeof scopeSnapshot !== 'object') return null;
  const raw = (scopeSnapshot as { authorizationExpiresAt?: unknown }).authorizationExpiresAt;
  return typeof raw === 'string' && raw !== '' ? raw : null;
}

export /**
 * 内置默认模型路由。
 *
 * 路由名必须是宿主**已注册**的 provider 名。写错的代价不是创建期报错，而是第一个回合
 * 直接失败（`no adapter registered for provider ...`）——那时会话已经建起来、库里也已是
 * active，表现为「Agent 起来了但永远不产出」，而插件侧看不到任何错误。
 *
 * 取值与 harness 基础 bundle 的 `agent-default-model` 一致。换模型用 `config.modelRoute`
 * 覆盖（`ComposeConfig.modelRoute` → 这里），不要改这个常量。
 */
const DEFAULT_MODEL_ROUTE: ModelRoute = { provider: 'deepseek-official', model: 'deepseek-flash' };

/**
 * 阶段 Worker 的默认工具白名单（五个阶段共用一份）。
 *
 * 抽成模块常量是因为它现在有**两个消费者**：会话创建（注入 `toolAllow`）与
 * 「进入下一阶段」的**服务端起稿**（`beginHandoff` 用它填草稿的工具建议）。
 * 两处各写一份必然漂移——而漂移的后果是「人类在编辑器里看到的工具面」与
 * 「Agent 实际拿到的工具面」不一致。
 */
export const DEFAULT_PHASE_TOOL_ALLOW: readonly string[] = [
  'memory_search',
  'memory_read',
  'artifact_read',
  // 阶段 Agent 同样要能「停下来问并让人点选」：歧义与岔路口都发生在这里。
  HUMAN_QUESTION_TOOL,
  'pentest_submit_report',
  'pentest_write_status_note',
  'pentest_request_action_approval',
  // 交接指路：人类说「进入下一阶段」时，Agent 用它拿到「该去哪儿点」并转告人类。
  // 它**不产出草稿**（§6.3：草稿是人类的写操作）。
  'pentest_prepare_handoff',
  EXEC_TOOL_NAME,
];

export /** 内置默认能力：五个阶段共用一份声明（真实部署由 Profile 目录覆盖）。 */
function defaultCapabilities(
  /**
   * 显式配置的模型路由，或一个**解析函数**。
   *
   * 为什么允许函数：模型是**人类在聊天界面里选的**，而它不是常量——今天选了 Flash，
   * 明天换成 Pro。插件加载时取一次快照，之后每个新会话都会用那个旧值，
   * 表现为「我明明换了模型，Agent 还是拿老模型跑」。函数形式让每次创建会话都现取一次。
   */
  modelRoute: ModelRoute | (() => ModelRoute | undefined) | undefined,
): CapabilityResolver {
  const resolveRoute = (): ModelRoute =>
    (typeof modelRoute === 'function' ? modelRoute() : modelRoute) ?? DEFAULT_MODEL_ROUTE;
  return {
    async resolve(phase) {

      // 默认能力：五个阶段各一个 Profile，无默认 skill（§2.2 允许空装载），
      // 工具允许列表只含不触及目标的只读面 + 目标出口。
      return {
        profileId: phase,
        profileRevision: 'builtin-v1',
        // 出厂默认装载：每个阶段一套差异化 skill（源文件在仓库 `skills/`，
        // 由 `scripts/seed-skills.ts` 播种进库）。人类在控制台仍可改勾选——这里只是默认值；
        // 库中没有的名字不会让会话创建失败（`skill_load` 只认已装载且在库的）。
        defaultSkillIds: SKILL_PACKS[phase],
        defaultToolAllow: [...DEFAULT_PHASE_TOOL_ALLOW],
        // 现取：同一份 resolver 在不同时刻会给出不同的模型（人类换模型后立刻生效）。
        modelRoute: resolveRoute(),
      };
    },
  };
}

/** 内置的后渗透 → 情报收集回环需要范围修订。 */
/**
 * 系统操作者的标识。
 *
 * 用带前缀的常量而不是裸 `'system'`：审计里扫 `operator_id` 时一眼能看出
 * 「这不是人」，而且与任何真实的操作者 id 都不会撞。
 */
export const SYSTEM_OPERATOR_ID = 'system:dsh-pentest';

export /**
 * 预校验一条范围条目。
 *
 * 直接调服务端的纯函数 `normalizeScopeEntry`，不做任何客户端可见的复制。
 * 返回结构**逐字段对齐契约的 `ScopePreviewEntry`**——界面按 `index` 把结论对回
 * 具体那一行，因此这个下标必须稳定（与输入同序）。
 */
function previewOne(entry: ScopeTarget, index: number): ScopePreviewEntry {
  // 与写入路径（`normalizeScope`）**同一选项**：资产标签在创建/确认阶段不展开，
  // 因此预览也必须按「不展开」判定，否则一个确认时会被接受的条目会在预览里被误报为非法。
  const result = normalizeScopeEntry(entry, { staticAssetLabels: true });
  if (!result.ok) {
    return {
      index,
      kind: entry.kind,
      canonical: null,
      protocols: [],
      portSummary: describePorts(entry),
      rejectionCode: result.code,
      detail: result.detail,
    };
  }
  const normalized: NormalizedScopeEntry = result.value;
  return {
    index,
    kind: entry.kind,
    canonical: `${entry.kind}:${normalized.host}`,
    protocols: normalized.protocols,
    portSummary: describePorts(entry),
    rejectionCode: null,
    detail: null,
  };
}

export /**
 * 端口语义的人读描述。
 *
 * 两种情形：
 *   - 留空 → 按默认 80/443 匹配（**对所有 kind 一致**，见 `effectivePorts`）
 *   - 明确区间 → 原样显示
 */
function describePorts(entry: ScopeTarget): string {
  if (entry.ports.length === 0) {
    if (entry.kind === 'url') return '取自 URL 的端口，缺省 80/443';
    return '默认 80/443';
  }
  return entry.ports.map((r) => (r.from === r.to ? String(r.from) : `${String(r.from)}-${String(r.to)}`)).join('、');
}

export /**
 * 把 `scope_versions` 行映射成契约的 `ScopeVersionDetail`。
 *
 * `targets` / `exclusions` 是 jsonb，pg 可能返回数组、字符串或 null——三种都要处理，
 * 且**不认识的形状不能静默当成空数组**：那会让「范围看起来是空的」这种假象出现，
 * 而范围为空意味着什么都不该执行。
 */
function toScopeVersionDetail(row: {
  readonly version: number | string;
  readonly iteration: number | string;
  readonly targets: unknown;
  readonly exclusions: unknown;
  readonly authorization_ref: string | null;
  readonly amendment_reason: string | null;
  readonly changed_by: string;
  readonly content_hash: string;
  readonly created_at: string;
}): ScopeVersionDetail {
  return {
    version: toInt(row.version, 'version'),
    iteration: toInt(row.iteration, 'iteration'),
    targets: asScopeTargets(row.targets),
    exclusions: asScopeTargets(row.exclusions),
    authorizationRef: row.authorization_ref,
    amendmentReason: row.amendment_reason,
    changedBy: row.changed_by,
    contentHash: row.content_hash,
    createdAt: row.created_at,
  };
}

export function toScopeProposal(row: ScopeProposalRow): ScopeProposal {
  return {
    id: row.id,
    engagementId: row.engagement_id,
    workerSessionId: row.worker_session_id,
    objective: row.objective,
    targets: asScopeTargets(row.proposed_targets),
    exclusions: asScopeTargets(row.proposed_exclusions),
    allowedActions: asStringArray(row.proposed_allowed_actions) as readonly ActionClass[],
    authorizationNote: row.authorization_note,
    status: row.status,
    createdAt: new Date(row.created_at).toISOString(),
    decidedAt: row.decided_at === null ? null : new Date(row.decided_at).toISOString(),
  };
}

export /** 把 jsonb 值收窄成对象；字符串形式（pg 有时如此）尝试解析一次。 */
function asRecord(value: unknown): Record<string, unknown> {
  if (value === null || value === undefined) return {};
  if (typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>;
  if (typeof value === 'string') {
    try {
      const parsed: unknown = JSON.parse(value);
      if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      // 解析失败即视为空对象——调用方读到 null 字段，不会拿到半个错误值
    }
  }
  return {};
}

export function readString(source: Record<string, unknown>, key: string): string | null {
  const value = source[key];
  return typeof value === 'string' ? value : null;
}

export function readNumber(source: Record<string, unknown>, key: string): number | null {
  const value = source[key];
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

export /** 收窄成字符串数组（jsonb 的 text[] 与 jsonb 数组两种来源都要处理）。 */
function asStringArray(value: unknown): readonly string[] {
  if (Array.isArray(value)) return value.filter((x): x is string => typeof x === 'string');
  const record = asRecord(value);
  const nested = record['value'];
  if (Array.isArray(nested)) return nested.filter((x): x is string => typeof x === 'string');
  return [];
}

export /** 收窄成范围条目数组。形状不符的条目**丢弃**但计数可观测（不静默改变语义）。 */
function asScopeTargets(value: unknown): readonly ScopeTarget[] {
  const items = asStringArray(value).length > 0 ? [] : (Array.isArray(value) ? value : []);
  const out: ScopeTarget[] = [];
  for (const item of items) {
    if (item === null || typeof item !== 'object') continue;
    const candidate = item as Record<string, unknown>;
    if (typeof candidate['kind'] !== 'string' || typeof candidate['value'] !== 'string') continue;
    out.push(item as ScopeTarget);
  }
  return out;
}

export function isScopeDecision(value: unknown): value is ScopeDecision {
  return value === 'included' || value === 'excluded' || value === 'pending';
}
