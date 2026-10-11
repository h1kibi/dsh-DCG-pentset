/**
 * Worker 工具面（设计文档 §10.1）。
 *
 * Worker 可见十个工具：
 *   memory_search / memory_read / artifact_read
 *   pentest_submit_report / pentest_write_status_note
 *   pentest_request_scope_confirmation
 *   pentest_request_action_approval / pentest_prepare_handoff / pentest_exec
 *
 * （`WORKER_TOOL_NAMES` 是唯一权威清单，含 intake 会话专用的范围方案提交工具；
 *   上面这段注释曾经写「七个」，那是 intake 工具加入之前的数字。）
 *
 * 三条纪律：
 *   1. **工具返回机器状态**（§16.5）：异常、超时、拒绝与空结果不渲染为成功消息；
 *      模型据 code 分支，而不是解析 message 文本。
 *   2. **工具层是薄封装**（§10.2）：所有判定在注入的服务内部完成，工具只做
 *      参数形状转发。目标类工具必须携带执行准入令牌，由全局守卫复核。
 *   3. **Worker 不可见**状态机类工具（阶段切换、会话创建、放行确认、报告签字）——
 *      这些只经控制台的人类 RPC。
 */

import { defineTool } from '@deepseek-ai/dsh-tools';
import type { DefineToolOptions, ParameterSchemaSpec, ToolDefinition, ValueSchemaSpec } from '@deepseek-ai/dsh-tools';
// JsonValue 由 dsh-tools 从 dsh-util-values 引入但未再导出，因此直接从来源导入。
import type { JsonValue } from '@deepseek-ai/dsh-util-values';
import type {
  ActionClass,
  ActionIntent,
  BootstrapIntakeResult,
  ExecutionPlan,
  RequestScopeConfirmationInput,
  ScopeProposal,
  ToolError,
  WorkerReportInput,
  ToolRunResult,
} from '../contracts.ts';
import { DEFAULTS, ERROR_CODES } from '../contracts.ts';
import type { ErrorCode } from '../contracts.ts';
import { evidenceRelPath, writeEvidence, writesIntoMount } from './evidence-sink.ts';
import {
  approvalView,
  artifactView,
  intakeView,
  memoryRecordsView,
  memorySearchView,
  planView,
  reportResultView,
  scopeProposalView,
  skillView,
  toolRunResultView,
  workdirFileView,
  workdirListingView,
  workdirSearchView,
  workdirWriteView,
} from './result-view.ts';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { DEFAULT_MOUNT_CONTAINER_PATH } from '../execution/docker-sandbox.ts';
// 结构化动作的技巧表搬到了 execution/techniques.ts（提示词与测试共用同一份），
// 这里再导出一次，既有调用点不必改。
export {
  STRUCTURED_TECHNIQUES,
  RECON_TECHNIQUES,
  VULN_TECHNIQUES,
  buildStructuredIntent,
} from '../execution/techniques.ts';
export type { ReconTechniqueSpec, StructuredFamily, ReconIntentInput, ReconIntentOutcome } from '../execution/techniques.ts';
import { buildStructuredIntent } from '../execution/techniques.ts';
import { WorkdirError, WORKDIR_READ_LIMIT_BYTES } from '../execution/workdir.ts';
import type { WorkdirFile, WorkdirListing, WorkdirSearchResult, WorkdirWriteResult } from '../execution/workdir.ts';

/** 工具实现依赖的服务面（全部由宿主注入，便于测试）。 */
/**
 * 把"拒绝"统一变成**载荷**交给模型（规范 §6，2026-10-11）。
 *
 * 起因（质检 §三 3.1）：`PgWorkerToolRefusal` 带着完整的 `payload`（`blocked` + `code` +
 * `next_action` + `expected_values`），但**没有任何一层把它渲染出来**——它以异常形式穿过工具边界，
 * 而错误的 `message` 只是 `${code}: ${message}`。于是模型既看不到"下一步该做什么"，
 * 也看不到"合法取值是哪些"（合法取值恰恰写在 `next_action` 里）。实测形态：模型照阶段档案传
 * `kinds: asset` 被拒后，只能猜 14 个合法值。
 *
 * 两类拒绝都覆盖：
 *   - 带 `payload` 的（`PgWorkerToolRefusal`）⇒ 原样透传（含 `expected_values`）；
 *   - 只有 `code` + `message` 的（`WorkflowRejection`）⇒ 补一句诚实的下一步（状态机类拒绝
 *     **重发无效**，要么改输入要么等人类，这一点必须说出来）。
 */
function blockedPayloadOf(error: unknown): ToolError | null {
  if (typeof error !== 'object' || error === null) return null;
  const payload: unknown = (error as { readonly payload?: unknown }).payload;
  if (isToolErrorPayload(payload)) return payload;
  const code: unknown = (error as { readonly code?: unknown }).code;
  const message: unknown = (error as { readonly message?: unknown }).message;
  if (
    typeof code === 'string' &&
    typeof message === 'string' &&
    (ERROR_CODES as readonly string[]).includes(code)
  ) {
    return {
      status: 'blocked',
      code: code as ErrorCode,
      message,
      next_action: '这是状态/流程类拒绝：按 message 处理；**不要原样重发**（重发不会改变结论）',
    };
  }
  return null;
}

function isToolErrorPayload(value: unknown): value is ToolError {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    record['status'] === 'blocked' &&
    typeof record['code'] === 'string' &&
    typeof record['message'] === 'string' &&
    typeof record['next_action'] === 'string'
  );
}

/**
 * Worker 工具的统一入口：比 `defineTool` 多**一个** catch 点（规范 §6）。
 *
 * 为什么是包装而不是每个工具各写一遍 try/catch：14 个工具里任何一个漏写，就会出现
 * "这一个工具的拒绝没有 next_action"——那正是本次质检发现的形状。包装让这条不变量只写一遍。
 * 非拒绝类异常照旧抛出（那是 bug，不该被伪装成载荷）。
 */
function defineWorkerTool<const S extends ParameterSchemaSpec, const O extends ValueSchemaSpec>(
  options: DefineToolOptions<S, O>,
): ToolDefinition {
  return defineTool<S, O>({
    ...options,
    async execute(args, exec) {
      try {
        return await options.execute(args, exec);
      } catch (error) {
        const blocked = blockedPayloadOf(error);
        if (blocked === null) throw error;
        // 所有 Worker 工具的 `output.schema` 都是 `{ type: 'json' }` ⇒ 载荷是合法的输出值。
        // 断成 `never` 是**必要**的：写出输出类型（`InferValue<O>`）会让 TS 去比较泛型标量
        // （TS2321 "Excessive stack depth"）——这里表达的是"输出面是 json"这一已知事实。
        return toJson(blocked) as never;
      }
    },
  });
}

export interface WorkerToolDeps {
  /**
   * 证据落盘的宿主根（挂载目录的宿主侧路径；沙箱里对应 `/work`）。
   *
   * 缺省 = 没挂载 ⇒ `pentest_exec` 的 `save_stdout_as_evidence` 只回一句说明，**不报错**
   * （没挂载时连 `pentest_workdir` 都是 `no_roots`，那是同一个事实）。
   */
  readonly evidenceRoot?: string;
  /**
   * 把刚落盘的证据**登记为 artifact**（2026-10-11 操作者诉求 #5）。
   *
   * 为什么必须有写入方：报告的 `source_refs` 认 `artifact:<uuid>`，而在此之前
   * `pentest.artifacts` **全仓没有任何 INSERT**（与"findings 全仓没有写入方"同一类缺口）——
   * 模型永远拿不到 artifact id，只能把文件路径当纯文本写进报告，人复核得自己翻目录。
   *
   * 省略该端口 = 不登记（工具照常返回落盘路径；返回到字段里会如实说明没有 artifact id）。
   */
  readonly recordEvidenceArtifact?: (input: {
    readonly workerSessionId: string;
    /** 宿主上的绝对路径（人复核用；也是 `readArtifact` 的 storageRef）。 */
    readonly storagePath: string;
    /** 容器里的对应路径（模型写命令时用）。 */
    readonly containerPath: string;
    readonly mediaType: string;
    readonly byteSize: number;
    readonly contentHash: string;
    readonly purpose: string;
    readonly targetSelector: string;
    /** 归属解析用的目标线索（**精确等值**匹配 `assets.canonical_target`，不做模糊匹配）。 */
    readonly targetHints: readonly string[];
    readonly toolRunId?: string;
  }) => Promise<{ readonly artifactId: string }>;
  /**
   * **按会话**的证据落盘根（2026-10-11）。与容器 argv / 简报 / `pentest_workdir` **同源**：
   * 会话 cwd 覆盖 `/work` 时，证据也必须落到同一处——否则 `.txt`（宿主侧写）与 `.xml/.json`
   * （容器内写）会分居两个目录（实测症状：工具里只看到 .txt，看似"证据不存在"）。
   */
  readonly evidenceRootFor?: (workerSessionId: string) => string | undefined;
  /**
   * 该会话生效的**容器侧挂载根**（`/work`、被 cwd 覆盖时的其他路径……）。
   *
   * 用途只有一个：`pentest_exec` 判断"命令是否自己把产物写进了挂载根"（2026-10-11 操作者实测 #5：
   * 命令写了 `/work/…`、宿主侧又落一份 ⇒ 两份近重复文件）。省略 = 只按 `/work` 判。
   */
  readonly mountContainerPathsFor?: (workerSessionId: string) => readonly string[];
  /** dsh 会话标识 → worker 会话标识。 */
  resolveWorkerSessionId(dshSessionId: string): Promise<string | null>;
  /** 原子解析当前 worker 会话及调用开始时的生效租约世代。 */
  readonly resolveWorkerSessionContext?: (dshSessionId: string) => Promise<{
    readonly workerSessionId: string;
    readonly leaseGeneration: number | null;
  } | null>;

  /**
   * 读取本会话**已装载** skill 的正文。
   *
   * 实现必须按会话冻结的装载集合收口：不在集合里的名字返回 `skill: null` 并附上集合，
   * 而不是「库里有就返回」——那样「装载在创建时冻结」就形同虚设。skill 正文会被模型当作
   * 指令执行，拿到未装载的正文等于人类勾选失去意义。
   */
  loadSkill(input: { readonly workerSessionId: string; readonly skillName: string }): Promise<{
    readonly skill: {
      readonly name: string;
      readonly description: string;
      readonly body: string;
      readonly contentHash: string;
      readonly revision: number;
    } | null;
    /** 本会话实际装载的名字（供拒绝时如实告知）。 */
    readonly loadedNames: readonly string[];
    /** 明确的拒绝原因（内容漂移/被删除/被停用）；给出时 `skill` 必为 null。 */
    readonly refusal?: { readonly message: string; readonly nextAction: string };
  }>;

  /** 混合检索（§8.7）。 */
  search(input: {
    workerSessionId: string;
    query: string;
    phase?: string;
    kinds?: readonly string[];
    trustLevels?: readonly string[];
    assetIds?: readonly string[];
    includeReasoning?: boolean;
    limit?: number;
  }): Promise<MemorySearchResult>;
  /** 按标识读取完整内容（§8.7）。 */
  read(input: {
    workerSessionId: string;
    refs: readonly string[];
  }): Promise<readonly MemoryRecord[]>;
  /** 读取证据（§9.2）。 */
  readArtifact(input: {
    workerSessionId: string;
    artifactId: string;
  }): Promise<ArtifactRecord>;
  /** 提交任务报告（§7.1、§12.3）。 */
  submitReport(input: {
    workerSessionId: string;
    leaseGeneration?: number | null;
    report: WorkerReportInput;
  }): Promise<{
    reportId: string;
    stateVersion: number;
    /**
     * 同事务里落进 `pentest.findings` 的候选结论计数（外部审计 P0-1 的写入方）。
     * `skipped` 只统计**空标题**这类无法成行的条目——原始条目仍在 `worker_reports.payload_json`。
     */
    findings: { written: number; skipped: number };
    /**
     * `mode: 'append'` 时的合并信息（基底报告 + 合并后各数组分段的条数）。缺省 = 整份替换。
     * 模型据此确认"我补的那条真的进去了"，而不是靠"我发出去了"推断。
     */
    merged?: {
      readonly mode: 'append';
      readonly baseReportId: string;
      readonly sections: Readonly<Record<string, number>>;
    };
  }>;
  /**
   * 写入本轮状态便签（§6.2.2）。`leaseGeneration` 与报告同口径：写入必须绑定世代。
   *
   * Agent 主动调用时返回 `source: 'agent'`。报告提交未提供便签时，服务端用报告 `summary`
   * 截断兜底并返回 `source: 'derived'`；回合结束自动收尾请求仍未实现，不要把该返回值误解
   * 为已有自动请求钩子。
   */
  writeStatusNote(input: {
    workerSessionId: string;
    leaseGeneration?: number | null;
    note: string;
  }): Promise<{ stored: boolean; source: 'agent' | 'derived' }>;
  /** intake Worker 提交待人类确认的结构化范围方案。 */
  requestScopeConfirmation(input: RequestScopeConfirmationInput & {
    readonly leaseGeneration?: number | null;
  }): Promise<ScopeProposal>;
  /** 申请高风险动作放行（§10.3）。 */
  requestApproval(input: {
    workerSessionId: string;
    intent: ActionIntent;
  }): Promise<{ approvalId: string; planHash: string; expiresAt: string; selfApproved?: boolean }>;
  /**
   * 「会话即 intake」：把**当前会话**登记为一个新作业的 intake。
   *
   * `dshSessionId` 由工具层从执行身份取（`exec.agent.sessionId`），**不接受模型传值**。
   * 服务端据此创建 `auth_pending` + 范围版本 0 的作业，并把会话本身登记为其 intake——
   * 之后本会话的其余 Worker 工具才解析得到归属。
   *
   * 这是「聊天里发起渗透任务」的唯一入口：没有它，工具面看得见却无处归属
   * （见 `workerSessionIdOf` 的说明）。
   */
  bootstrapIntake(input: {
    readonly dshSessionId: string;
    readonly name?: string;
  }): Promise<BootstrapIntakeResult>;
  /** 执行（经 admit → execute 两步，令牌在服务内部签发）。 */
  execute(input: {
    workerSessionId: string;
    intent: ActionIntent;
    /** 宿主工具调用的取消信号；必须继续传到沙箱执行。 */
    signal: AbortSignal;
  }): Promise<ExecuteOutcome>;
  /**
   * 作业目录（`sandbox.mounts` 声明的宿主目录）的读写。
   *
   * **不经过范围裁决**：它不接触任何目标，只碰人类自己挂进来的目录。空范围作业里
   * 这是唯一能拿到作业资料的通道（`pentest_exec` 在范围版本 0 下会被 out_of_scope 拒绝）。
   * 未声明挂载时省略——工具随即给出 `no_roots` 的明确拒绝，而不是退回某个默认目录。
   */
  readonly workdir?: {
    /**
     * **配置声明的**挂载根（容器路径 + 只读标记）。只作描述与回退：
     * 实际生效的挂载可能被"按会话的工作目录"覆盖 `/work` —— 见 {@link rootsFor}。
     */
    readonly roots: readonly { readonly containerPath: string; readonly readOnly?: boolean }[];
    /**
     * **本会话实际生效的挂载根**（2026-10-11 修）。容器把会话 cwd 挂成 `/work`，因此工具
     * 必须读同一份——否则会出现最坏的一种漂移：结构化动作把证据写进容器看到的 `/work`，
     * 而这里读的是配置里的另一个目录 ⇒ 模型看到"证据不存在"（实测，差一步写成结论）。
     */
    rootsFor?(workerSessionId: string): readonly { readonly containerPath: string; readonly readOnly?: boolean }[];
    list(input: { readonly path: string; readonly workerSessionId: string }): Promise<WorkdirListing>;
    read(input: { readonly path: string; readonly workerSessionId: string }): Promise<WorkdirFile>;
    write(input: { readonly path: string; readonly content: string; readonly workerSessionId: string }): Promise<WorkdirWriteResult>;
    /** 在挂载根内递归检索（正则）。200+ 份归档文档里考古靠它，避免整文件读烧上下文。 */
    search(input: { readonly path: string; readonly pattern: string; readonly workerSessionId: string }): Promise<WorkdirSearchResult>;
    /** 追加写：给已写的报告补一行不必整文件重发。 */
    append(input: { readonly path: string; readonly content: string; readonly workerSessionId: string }): Promise<WorkdirWriteResult>;
  };
}

/**
 * 一次执行尝试的结果。
 *
 * `blocked` 分支承载契约里的稳定错误码（`ErrorCode`），模型据码分支而不解析文本。
 */
type ExecuteOutcome =
  | {
      readonly kind: 'executed';
      readonly plan: ExecutionPlan;
      readonly result: unknown;
      /** 这次执行的运行标识（账本 `pentest.tool_runs.id`）；工具层要把它回给模型（可审计）。 */
      readonly toolRunId?: string;
    }
  | {
      readonly kind: 'blocked';
      readonly error: ToolError;
    };

export interface MemorySearchResult {
  readonly hits: readonly {
    readonly memoryId: string;
    readonly excerpt: string;
    readonly score: number;
    readonly source: {
      readonly eventId: string;
      readonly workerSessionId: string;
      readonly phase: string;
      readonly occurredAt: string;
    };
    readonly trust: string;
    readonly citation: string;
  }[];
  readonly indexWatermark: number;
  /**
   * 零命中/降级时的**诊断说明**（运行期一直返回它，类型里此前漏了——测试因此报了三个版本的
   * "Property 'note' does not exist"，而那是类型在说谎，不是测试写错）。
   */
  readonly note?: string;
}

export interface MemoryRecord {
  readonly memoryId: string;
  readonly content: string;
  readonly contentHash: string;
  readonly occurredAt: string;
  readonly originWorkerSessionId: string | null;
  readonly trust: string;
  readonly classification: string;
  readonly provisional: boolean;
  readonly relatedEventIds: readonly string[];
}

export interface ArtifactRecord {
  readonly artifactId: string;
  readonly mediaType: string;
  readonly byteSize: number;
  readonly contentHash: string;
  /** 已授权解密后的内容，或指向受控存储的引用（不上传原始字节给模型）。 */
  readonly inline?: string;
  readonly storageRef?: string;
  readonly truncated: boolean;
  readonly metadata: unknown;
}

/** 统一把服务的拒绝结果转成模型可见的工具错误载荷。 */
function asError(e: ToolError): ToolError {
  return e;
}

/**
 * 把工具返回值规范化为无损 JSON。
 *
 * dsh 的 `output.schema: { type: 'json' }` 要求规范值为 `JsonValue`，且注册表在
 * 物化时会用 `isJsonValue` 运行时校验——非 JSON 可序列化的值会被拒绝。
 * 因此在工具边界做一次真实的序列化往返：既满足类型契约，也让"不可序列化"在
 * 这里就暴露出来，而不是在注册表深处失败。
 */
function toJson(value: unknown): JsonValue {
  const round = JSON.parse(JSON.stringify(value)) as JsonValue;
  return round;
}

/** 统一的 JSON 渲染：把结构化结果原样交给模型，不做自然语言美化。 */
function renderJson(_args: unknown, value: JsonValue): { type: 'text'; text: string }[] {
  return [{ type: 'text', text: JSON.stringify(value, null, 2) }];
}

/**
 * `verify_tls` 的说明**只写一份**（规范 §7：同一事实不许手写第二份）。
 *
 * 此前这段在 `pentest_recon` 与 `pentest_scan` 里各抄一份，两份只在末尾的"适用"清单上不同——
 * 那种"几乎逐字相同"的复制正是漂移的温床（2026-10-11 质检 §三 3.4：同一段说明在 5 处复制）。
 * 差异部分由下方拼接，正文只有这一份。
 */
const VERIFY_TLS_DOC =
  '是否校验 TLS 证书，**默认 true**（**能用默认就用默认**：证书有效时默认就能通，IP 目标也一样）。' +
  '只有**校验真的失败**（自签/链不全/SAN 不匹配）才传 false——此后该次结果不再证明证书链可信，' +
  '报告里会写明未校验。';

/**
 * 「工具拒绝怎么读」**只写一份**（规范 §6）：模型据 `code` 分支，而不是解析 message 文本。
 *
 * 为什么必须有（2026-10-11 质检 §三 3.3）：20 个 `ERROR_CODES` 此前在面向模型的文本里**零解释**，
 * 而它们的处置完全不同——改参数、等放行、等人类推进状态、停下请人改范围。分不清就会"原样重发"，
 * 白烧一轮（甚至对目标重复动作）。
 */
const REFUSAL_DOC =
  '**拒绝怎么读**（`status:"blocked"` 的返回）：按 `code` 分支，不要解析 message 文本——' +
  '`usage_error` / `classification_rejected`（带 `expected_values`）⇒ **改参数后重发**，合法取值就在 `expected_values` 里；' +
  '`approval_required` / `approval_expired` / `approval_consumed` ⇒ 走放行流程：重新申请，拿到 `approval_id` 后**同一条命令**再执行；' +
  '`lease_required` / `lease_expired` / `lease_revoked` / `lease_generation_stale` / `stale_state_version` / `engagement_halted` / `budget_exhausted` ⇒ ' +
  '**原样重发无效**：要么等人类推进状态/续租，要么先收尾交给人类；' +
  '`scope_violation` / `target_not_adjudicated` / `authorization_expired` ⇒ 目标不在当前授权范围内：**停下并请人类裁决**，不要换目标试；' +
  '`sandbox_unavailable` ⇒ 沙箱/容器侧不可用（不是目标结论），报到控制台由人处理。';

/** 构造全部 Worker 工具定义。 */
export function createWorkerTools(deps: WorkerToolDeps) {
  const memorySearch = defineWorkerTool({
    name: 'memory_search',
    description:
      '检索本 engagement 的记忆（混合检索：语义近邻 + 全文 + 三元组）。' +
      '返回 `hits[]`（每条含 `memory_id`/`excerpt`/`score`/`trust`/`citation`/`source{event_id,worker_session_id,phase,occurred_at}`）' +
      '、`index_watermark` 与（零命中/降级时的）`note`。检索范围受当前范围版本约束：' +
      '未纳入范围的资产内容不会返回。思考链默认参与检索。' +
      REFUSAL_DOC,

    parameters: {
      query: { type: 'string', required: true, description: '待检索的问题' },
      phase: { type: 'string', description: '可选：限定阶段' },
      kinds: {
        type: 'array',
        items: { type: 'string' },
        description: '可选：限定记忆类型（fact / tool_observation / finding 等）',
      },
      trust_levels: {
        type: 'array',
        items: { type: 'string' },
        description: '可选：限定来源可信度',
      },
      asset_ids: { type: 'array', items: { type: 'string' }, description: '可选：限定资产' },
      include_reasoning: {
        type: 'boolean',
        description: '可选筛选开关：false 表示本次只要非思考链条目；不是权限门禁',
      },
      // dsh 的 schema DSL 只支持 annotation + type/enum/const，`minimum`/`maximum`
      // 会在 defineTool 编译期抛 JsonSchemaError（实测：
      // "parameters.limit.minimum is not supported by the value schema DSL"）。
      // 因此取值约束写进 description，而不是静默丢弃。
      limit: { type: 'integer', description: '返回条数上限，默认 8；有效范围 1–50' },
    },
    output: { schema: { type: 'json' }, render: (_a, v) => renderJson(_a, v) },
    async execute(args, exec) {
      const workerSessionId = await workerSessionIdOf(deps, exec);
      const result = await deps.search({
        workerSessionId,
        query: args.query,
        phase: args.phase,
        kinds: args.kinds,
        trustLevels: args.trust_levels,
        assetIds: args.asset_ids,
        includeReasoning: args.include_reasoning,
        limit: args.limit ?? 8,
      });
      // 规范 §7：模型可见字段一律 snake_case（内部类型不动，见 result-view.ts 的说明）。
      return toJson(memorySearchView(result));
    },
  });

  const memoryRead = defineWorkerTool({
    name: 'memory_read',
    description: '按标识读取记忆或事件的完整内容。返回原文、内容哈希、来源与标签。',
    parameters: {
      refs: {
        type: 'array',
        items: { type: 'string' },
        required: true,
        description: 'memory:<id> 或 event:<id> 形式的引用，单次上限 20 条',
      },
    },
    output: { schema: { type: 'json' }, render: (_a, v) => renderJson(_a, v) },
    async execute(args, exec) {
      if (args.refs.length > 20) {
        const err: ToolError = {
          status: 'blocked',
          code: 'classification_rejected',
          message: '单次读取上限 20 条',
          next_action: '分批读取',
        };
        return toJson(asError(err));
      }
      const records = await deps.read({ workerSessionId: await workerSessionIdOf(deps, exec), refs: args.refs });
      return toJson(memoryRecordsView(records));
    },
  });

  const artifactRead = defineWorkerTool({
    name: 'artifact_read',
    description:
      '读取一条证据的元数据与（已授权的）内容。二进制证据只返回元数据与引用。' +
      '返回：`artifact_id` / `media_type` / `byte_size` / `content_hash` / `truncated` / `metadata`，' +
      '外加 `inline`（仅"未加密 + 内联 + 文本类 + 未超阈值"时才有原文）或 `storage_ref`（受控引用，' +
      '文件证据是宿主路径）——两者**必有其一**，二进制证据不会把字节交给模型。' +
      '标识来自 `pentest_exec` 的 `artifact_ref`（形如 `artifact:<uuid>`）。',
    parameters: {
      artifact_id: { type: 'string', required: true, description: '证据标识（来自 artifact_ref 的 uuid 部分）' },
    },
    output: { schema: { type: 'json' }, render: (_a, v) => renderJson(_a, v) },
    async execute(args, exec) {
      const record = await deps.readArtifact({
        workerSessionId: await workerSessionIdOf(deps, exec),
        artifactId: args.artifact_id,
      });
      return toJson(artifactView(record));
    },
  });

  const bootstrapIntakeTool = defineWorkerTool({
    name: 'pentest_bootstrap_intake',
    description:
      '当人类在**本会话**里发起一次渗透测试任务时，用它把本会话登记为一个新作业的授权范围 intake。' +
      '调用之后本会话即绑定该作业，其余渗透工具（记忆检索、范围方案提交、状态便签）才开始可用。' +
      '它只能创建「授权待确认、范围版本 0」的作业——**不授予任何目标动作能力**：' +
      '范围必须由人类本人确认（会话里的确认卡片，或控制台），执行还要逐次放行与沙箱。' +
      '同一个会话重复调用只会返回同一个作业，不会重复创建。',
    parameters: {
      name: { type: 'string', description: '作业名；人类给了名字就填，省略则自动生成一个' },
    },
    output: { schema: { type: 'json' }, render: (_a, v) => renderJson(_a, v) },
    async execute(args, exec) {
      // 会话标识**从执行身份取**，不读模型参数：模型无法把作业绑到别的会话上。
      const intake = await deps.bootstrapIntake({
        dshSessionId: dshSessionIdOf(exec),
        ...(args.name === undefined ? {} : { name: args.name }),
      });
      // 规范 §7：`engagementId`→`engagement_id` 等。
      return toJson(intakeView(intake));
    },
  });

  // ── 报告载荷 schema（设计 §13.4）──
  //
  // 这里**不是**一句随手 description：`facts`/`hypotheses` 的形状决定记忆面能不能索引到证据
  // （分块器按 statement/confidence/source_refs 渲染成文本）。写成 `type:'json'` 的后果实测过：
  // 模型自创字段名（`{fact,source,confidence}`、`not_verified`）→ 分块器一条都认不出 →
  // 报告只剩摘要进检索面，且队列任务照样 done（静默丢弃）。校验失败会把下面的描述原样回到
  // 模型，所以描述必须自解释。
  const reportStatementSchema = {
    type: 'object',
    additionalProperties: false,
    properties: {
      statement: {
        type: 'string',
        required: true,
        description: '一条可验证的观察或推断（写清对象+结果，如「GET / 返回 200，Server: SimpleHTTP/0.6」）',
      },
      confidence: { type: 'number', description: '0–1 的置信度（没有就不填）' },
      source_refs: {
        type: 'array',
        items: { type: 'string' },
        description:
          '证据引用：memory:<uuid> / artifact:<uuid> / tool_run:<uuid>（有就直接引用，别复述）。' +
          '`artifact:<uuid>` 取自 `pentest_exec` 开启 `save_stdout_as_evidence` 后返回的 `artifact_ref`' +
          '（2026-10-11 起落盘的证据会自动登记）——**有了它就优先引它**：人复核时能按 id 取回原文，' +
          '而路径只是纯文本',
      },
    },
  } as const;
  const reportFindingSchema = {
    type: 'object',
    additionalProperties: false,
    properties: {
      title: { type: 'string', required: true, description: '候选结论标题' },
      severity: { type: 'string', enum: ['info', 'low', 'medium', 'high', 'critical'] },
      affected_assets: { type: 'array', items: { type: 'string' }, description: '受影响资产标识或地址' },
      reproduction_plan: { type: 'array', items: { type: 'string' }, description: '尚未执行的验证步骤' },
      evidence_refs: { type: 'array', items: { type: 'string' }, description: '证据引用' },
      validation_required: { type: 'boolean', description: '是否还需一次显式验证（默认 true）' },
    },
  } as const;

/**
 * 容器 **stderr 非空**时的醒目字段（2026-10-10 操作者实测 P0）。
 *
 * 实况：`grep -oE '[a-zA-Z0-9_\-/]{3,}'` 在容器里报 `grep: Invalid range end`（ERE 的字符类里
 * `\` 不是转义符，`\`→`/` 成了倒置区间 ⇒ rc=2），但命令写成 `… | grep … | head -30` 时
 * **管道末尾把 rc 掩成 0**，stdout 又是空的 ⇒ 看起来就是"页面里确实没有路由/API 路径"这类
 * **干净的阴性结论**。操作者原话：「这正是 skill 文档里反复警告的那类『看起来正常、其实是漏报』」。
 *
 * 因此：stderr 非空**必须在返回值里自己开口**，别让它只躺在 `result.stderr` 里等人翻。
 * 同时把「管道会吃掉退出码」这条写进提醒——那是这个陷阱的机制，不说清下次还会踩。
 */
function stderrMarker(result: { readonly stderr?: unknown } | null): Record<string, unknown> {
  const raw = result?.stderr;
  if (typeof raw !== 'string') return {};
  const text = raw.trim();
  if (text === '') return {};
  return {
    stderr_nonempty: true,
    stderr: text.slice(0, 800),
    stderr_warning:
      'stderr 非空：先判断它是「警告」还是「命令根本没跑成」再据此下结论。**管道会吃掉退出码**' +
      '（`a | grep x | head` 的 rc 是 head 的 0），所以只看 rc/空 stdout 会把失败当成"干净的阴性结果"。' +
      '排查方向：单独重跑那一段、或用 `set -o pipefail`、或换成 python3（正则语义更可控）。',
  };
}


/**
 * 证据登记（诉求 #5）：算好哈希与字节数，交给注入的端口去写 `pentest.artifacts`。
 *
 * **绝不把一次已经执行完的动作变成失败**（与 `writeEvidence` 同一条纪律）：登记失败只回一句
 * 原因，文件仍在磁盘上、输出仍在返回值里。但**不静默**——原因会进返回值。
 */
async function registerEvidenceArtifact(
  deps: WorkerToolDeps,
  input: {
    readonly workerSessionId: string;
    readonly storagePath: string;
    readonly containerPath: string;
    readonly stdout: string;
    readonly purpose: string;
    readonly targetSelector: string;
    readonly targetHints: readonly string[];
    readonly toolRunId?: string;
  },
): Promise<{ readonly artifactId?: string; readonly error?: string }> {
  const record = deps.recordEvidenceArtifact;
  if (record === undefined) return {}; // 未接端口的部署：只是没有 artifact id，不是错误
  try {
    const bytes = Buffer.from(input.stdout, 'utf8');
    const { artifactId } = await record({
      workerSessionId: input.workerSessionId,
      storagePath: input.storagePath,
      containerPath: input.containerPath,
      mediaType: 'text/plain; charset=utf-8',
      byteSize: bytes.byteLength,
      contentHash: createHash('sha256').update(bytes).digest('hex'),
      purpose: input.purpose,
      targetSelector: input.targetSelector,
      targetHints: input.targetHints,
      ...(input.toolRunId === undefined ? {} : { toolRunId: input.toolRunId }),
    });
    return { artifactId };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

  const submitReport = defineWorkerTool({
    name: 'pentest_submit_report',
    description:
      '提交本轮任务报告并进入等待人工判断。' +
      '提交后本会话状态变为等待人工，**不改变阶段、不创建新会话**。' +
      '报告需包含面向人的 summary；可选 status_note 用于控制台列表扫描。' +
      '**只有范围已确认的阶段会话可以提交**：intake 会话的服务端闸门会直接拒绝（intake 的产出是' +
      '待人类确认的范围方案，用 pentest_request_scope_confirmation 提交）。',
    parameters: {
      status: {
        type: 'string',
        enum: ['report_ready', 'blocked'],
        required: true,
        description: 'report_ready 表示任务完成或无法继续；blocked 表示有明确阻塞',
      },
      objective: { type: 'string', required: true, description: '本次任务目标（不可变快照）。**此字段必须作为顶层参数传递，不要只放在 payload 里**；payload.objective 仅用于兼容整份照抄设计示例的情况' },
      summary: { type: 'string', required: true, description: '面向人的简短总结' },
      status_note: {
        // 容忍 null（= 不填）：模型把"没有"写成 null 是常态，不该为它重发整份报告。
        oneOf: [{ type: 'string' }, { type: 'null' }],
        description: `可选短状态便签（≤${DEFAULTS.statusNoteMaxChars} 字符），供控制台列表扫描；不填或写 null 都可以`,
      },
      mode: {
        oneOf: [{ type: 'string', enum: ['replace', 'append'] }, { type: 'null' }],
        description:
          '载荷模式。replace（默认）：本份 payload 整份替换；append：在**本会话本次尝试的当前报告载荷**上合并' +
          '本份 payload（数组**追加并按深等值去重**、对象递归合并、其余由新值覆盖）——补几条事实/候选时用它，' +
          '不必整份重发（一份真实报告可能几 KB）。返回里带 `merged` 与各分段的条数。',
      },
      payload: {
        // **不容忍 `null`**（没有载荷请**省略该字段**）：`oneOf` 会把 payload 内部的**细分违规**
        // 塌成一条「must match exactly one oneOf branch」，而"一次说清哪里错"正是操作者的直接诉求
        // （2026-10-11 实测：普通对象分支给出 facts[0]/facts[1] 两条，oneOf 分支只给一条泛化信息）。
        // 浅层标量（`status_note`/`mode`）没有这个代价，才用 `oneOf` 容忍 null。
        type: 'object',
        additionalProperties: false,
        description:
          '结构化报告（设计 §13.4）。facts/hypotheses 的每条必须有 statement（可选 confidence 与 ' +
          'source_refs）；candidate_findings 的每条必须有 title。没有的段落就省略，别用空数组占位。',
        properties: {
          facts: {
            type: 'array',
            items: reportStatementSchema,
            description: '已观察、可验证的事实（每条一个对象）',
          },
          hypotheses: {
            type: 'array',
            items: {
              ...reportStatementSchema,
              properties: {
                ...reportStatementSchema.properties,
                missing_evidence: {
                  type: 'array',
                  items: { type: 'string' },
                  description: '要证伪/证实这条推断还缺什么证据',
                },
              },
            },
            description: '尚未证实的推断（每条一个对象）',
          },
          candidate_findings: {
            type: 'array',
            items: reportFindingSchema,
            description: '候选结论（每条一个对象；必须带证据引用或标注待验证）',
          },
          limitations: {
            type: 'array',
            items: { type: 'string' },
            description: '本次的覆盖不足、工具不可用或未验证的假设',
          },
          scope_or_roe_issues: {
            type: 'array',
            items: { type: 'string' },
            description: '与范围/授权相关的疑问（需要人类裁决的写这里，别自己去碰）',
          },
          contradictions: {
            type: 'array',
            items: { type: 'string' },
            description: '与既有记忆/结论矛盾之处',
          },
          recommended_next_phase: {
            type: 'string',
            enum: [
              'intelligence-gathering',
              'threat-modeling',
              'vulnerability-analysis',
              'exploitation',
              'post-exploitation',
            ],
            description: '建议的下一阶段（人类最终决定）',
          },
          suggested_skills: { type: 'array', items: { type: 'string' }, description: '建议下一会话装载的 skill' },
          // ── 设计 §7.1 示例里的其余字段：接收它们，但分块只认上面的分段 ──
          //
          // **为什么不一律收（`additionalProperties: true`）**：那样「facts 写成 fact」这类漂移会
          // 重新变成静默丢弃；这里逐项列出设计里出现过的名字，拼错的名字仍然会被拒。
          // 这几个字段有些与工具入参同名（`status`/`objective`/`summary`/`status_note`）：
          // 它们作为入参是必填/可选的兄弟字段，模型按设计示例整份塞进 `payload` 时不该被拒。
          schema_version: { type: 'json', description: '报告 schema 版本（设计 §7.1 示例为 1）。**不采信**：可以是任意值，包括 null' },
          status: { type: 'json', description: '与入参 status 同义；整份照抄设计示例时会出现。**不采信**：可以是任意值，包括 null' },
          objective: { type: 'json', description: '**顶层必填**；整份照抄设计示例到 payload 里会重复。**不采信**：可以是任意值，包括 null' },
          summary: { type: 'json', description: '与入参 summary 同义。**不采信**：可以是任意值，包括 null' },
          status_note: { type: 'json', description: '与入参 status_note 同义（≤200 字符）。**不采信**：可以是任意值，包括 null' },
          completed: { type: 'json', description: '已完成事项清单。**不采信**：可以是任意值，包括 null' },
          revision: { type: 'json', description: '报告版本号（派生对象版本化管理，§7.1）。**不采信**：可以是任意值，包括 null' },
          finished_at: { type: 'json', description: '完成时间（ISO 字符串）。**不采信**：可以是任意值，包括 null' },
          // 归属字段：设计 §7.1 的示例里有，**只接收不采信**——真实归属由服务端从执行身份推导
          // （§4.2：不信任模型传入的会话标识）。列出来是为了让「照抄设计示例」能通过校验。
          engagement_id: { type: 'json', description: '**只接收不采信**：归属由服务端从执行身份推导（§4.2）。可以是任意值，**包括 null**——写 null 或不写都行，别为它重发整份' },
          agent_session_id: { type: 'json', description: '**只接收不采信**：同上，服务端不采信入参。可以是任意值，包括 null' },
          phase: { type: 'json', description: '**只接收不采信**：阶段由会话决定。可以是任意值，包括 null' },
        },
      },
    },
    output: { schema: { type: 'json' }, render: (_a, v) => renderJson(_a, v) },
    async execute(args, exec) {
      const dshSessionId = dshSessionIdOf(exec);
      const session = await workerSessionContextOf(deps, dshSessionId);
      // `status_note: null` 与不填同义（schema 用 oneOf 容忍 null，见上面的说明）。
      const note = typeof args.status_note === 'string' ? args.status_note : undefined;
      const submitted = await deps.submitReport({
            workerSessionId: session.workerSessionId,
            leaseGeneration: session.leaseGeneration,
            report: {
              status: args.status,
              objective: args.objective,
              summary: args.summary,
              ...(note === undefined ? {} : { statusNote: note.slice(0, DEFAULTS.statusNoteMaxChars) }),
              payload: args.payload ?? {},
              ...(args.mode === undefined || args.mode === null ? {} : { mode: args.mode }),
            },
          });
      // 规范 §7：模型可见字段 snake_case（`reportId`→`report_id`、`merged.baseReportId`→`merged.base_report_id`…）。
      return toJson(reportResultView(submitted));
    },
  });
const scopeTargetSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    kind: {
      type: 'string',
      enum: ['domain', 'ip', 'cidr', 'url', 'asset-label'],
      required: true,
      description: '范围条目类型',
    },
    value: { type: 'string', required: true, description: '域名、IP、网段或 URL' },
    protocols: {
      type: 'array',
      items: { type: 'string', enum: ['tcp', 'udp', 'icmp'] },
      required: true,
      description: '允许的协议集合',
    },
    ports: {
      type: 'array',
      required: true,
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          from: { type: 'integer', required: true, description: '端口区间起点（0-65535）' },
          to: { type: 'integer', required: true, description: '端口区间终点（0-65535）' },
        },
      },
      description: '端口区间集合；每项为 from/to 对象',
    },
    wildcardSubdomain: { type: 'boolean', description: '是否显式匹配一级子域' },
  },
} as const;
const requestScopeConfirmation = defineWorkerTool({
    name: 'pentest_request_scope_confirmation',
    description:
      '提交一个供人类确认的目标与动作范围方案。当前 intake 会话只负责问清范围，' +
      '不得执行目标动作；提交方案不会创建范围版本，也不会代替人类确认。' +
      '每个目标必须提供 kind、value、protocols 数组和 ports 数组；端口用 from/to 区间表示。',
    parameters: {
      objective: { type: 'string', required: true, description: '本次任务目标' },
      targets: {
        type: 'array',
        items: scopeTargetSchema,
        required: true,
        description: '建议纳入的范围条目；每项必须含 kind/value/protocols/ports',
      },
      exclusions: {
        type: 'array',
        items: scopeTargetSchema,
        description: '建议排除的范围条目；每项必须含 kind/value/protocols/ports',
      },
      allowed_actions: {
        type: 'array',
        items: {
          type: 'string',
          enum: [
            'passive_collection',
            'active_probing',
            'credentialed_access',
            'exploit_validation',
            'lateral_movement',
            'persistence',
            'destructive',
            'exfiltration',
          ],
        },
        description: '建议允许的动作类别',
      },
    },
    output: { schema: { type: 'json' }, render: (_a, v) => renderJson(_a, v) },
    async execute(args, exec) {
      const dshSessionId = dshSessionIdOf(exec);
      const session = await workerSessionContextOf(deps, dshSessionId);
      const proposal = await deps.requestScopeConfirmation({
        workerSessionId: session.workerSessionId,
        leaseGeneration: session.leaseGeneration,
        objective: args.objective,
        targets: args.targets as unknown as RequestScopeConfirmationInput['targets'],
        exclusions: (args.exclusions ?? []) as unknown as RequestScopeConfirmationInput['exclusions'],
        allowedActions: (args.allowed_actions ?? []) as unknown as RequestScopeConfirmationInput['allowedActions'],
        // 留痕字段由服务端按「没有就是空」处理；模型侧既不提供也不回显它。
        authorizationNote: '',
      });
      // **工具结果是模型上下文**：留痕字段（`authorization_note`）不回显——"看见字段名就会谈起它"
      // 那条实测结论现在由 `scopeProposalView` 承载（摘字段与命名映射在同一处，不再各写一半）。
      return toJson(scopeProposalView(proposal));
    },
  });


  const writeStatusNote = defineWorkerTool({
    name: 'pentest_write_status_note',
    description:
      '写入本轮的短状态便签（刚做完什么、下一步、需要人类提供什么）。' +
      '这是给人类在控制台列表上扫一眼用的线索，不是报告：报告请用 pentest_submit_report。' +
      '随时可以写，一轮可以写多次（后写的覆盖先写的）。',
    parameters: {
      note: { type: 'string', required: true, description: `便签正文，≤${DEFAULTS.statusNoteMaxChars} 字符` },
    },
    output: { schema: { type: 'json' }, render: (_a, v) => renderJson(_a, v) },
    async execute(args, exec) {
      // 与 submitReport / requestScopeConfirmation 同形：一次性解析会话与当前租约世代。
      // 便签是**写**操作，世代必须随写入一起校验，否则旧世代 Agent 能覆盖列表上的便签。
      const dshSessionId = dshSessionIdOf(exec);
      const session = await workerSessionContextOf(deps, dshSessionId);
      return toJson(await deps.writeStatusNote({
        workerSessionId: session.workerSessionId,
        leaseGeneration: session.leaseGeneration,
        note: args.note.slice(0, DEFAULTS.statusNoteMaxChars),
      }));
    },
  });

  const requestApproval = defineWorkerTool({
    name: 'pentest_request_action_approval',
    description:
      '为一条**沙箱命令**申请放行。**一次只提一条**：本会话已有待处理申请时，再提会被拒绝并附上那条的 id' +
      '——等人类处理完再提下一个。是否需要人类过目由**作业的审批模式**决定：' +
      '人工审批模式下每条逐次放行类别的命令都要人点一次；高权限模式下，预设内且非默认禁用类别的' +
      '命令由服务端**自行放行**（返回值里 selfApproved=true 时不必等待，直接执行即可）。' +
      '把 command 写成人类一眼能读懂的原文——放行卡上显示的就是它；' +
      'target_selector 声明打哪个已授权目标（只能来自选择器），port 是它主要针对的端口。' +
      '返回 approval_id 后，带它调用 pentest_exec 执行**同一条命令**（凭证只对那次执行有效）。' +
      '人类在控制台处理后，插件会把决定（连同他的补充）送回本会话。' +
      '沙箱事实：直连目标、不经代理、有 NET_RAW、容器内 root；' +
      '镜像里有 nmap/curl/wget/nc/dig/openssl/jq/whois/ping/ffuf/sqlmap 与 python3。' +
      '**能否出网由部署决定**（`internal` 网络 ⇒ 没有外网出口；非 internal ⇒ 可达范围与宿主一致，且出网是间歇的）：' +
      '公网目标与在线资料够不够得着，先看启动日志里 `[dsh-pentest] 沙箱可达性` 那一行——别把超时当成目标不存在；' +
      '但**可达不等于授权**——只对已授权目标动作；连不上时先分清是防火墙/过滤还是服务没起来，' +
      '别把「无路由」当成目标端口状态的证据。',
    parameters: {
      command: { type: 'string', required: true, description: '要执行的命令原文（与随后 pentest_exec 提交的必须一致）' },
      port: { type: 'integer', required: true, description: '这条命令主要针对的端口（范围闸门据此记账）' },
      target_selector: { type: 'string', required: true, description: '目标选择器（域名 / URL / IP，必须在已授权范围内）' },
      purpose: { type: 'string', required: true, description: '本次动作的目的与预期证据，供人类判断' },
    },
    output: { schema: { type: 'json' }, render: (_a, v) => renderJson(_a, v) },
    async execute(args, exec) {
      // 一次调用只解析一次：两处各查一次库纯属浪费，且可能落到不同结果上。
      const workerSessionId = await workerSessionIdOf(deps, exec);
      const approval = await deps.requestApproval({
        workerSessionId,
        intent: {
          workerSessionId,
          templateId: 'direct_command',
          targetSelector: args.target_selector,
          purpose: args.purpose,
          params: {
            port: args.port,
            // 与 pentest_exec 同一套编码：命令走 base64（宿主侧是单个按空格切分的 argv 字符串）。
            command_b64: Buffer.from(args.command, 'utf8').toString('base64'),
          },
        },
      });
      // 规范 §7：`approvalId`→`approval_id`、`planHash`→`plan_hash`、`expiresAt`→`expires_at`。
      return toJson(approvalView(approval));
    },
  });

  const prepareHandoff = defineWorkerTool({
    name: 'pentest_prepare_handoff',
    description:
      '人类说「进入下一阶段」时用本工具**告诉他去哪里点**——你**不能**自己生成交接草稿。' +
      '草稿是一次**写操作**，按 §6.3 必须由人类在控制台显式请求：点「渗透作业 → 进入下一阶段」。' +
      '本工具不产出任何草稿、不改变任何状态；调用后把提示原样转告人类并结束本回合，' +
      '**不要**声称阶段已切换，也不要重复调用。',
    parameters: {},
    output: { schema: { type: 'json' }, render: (_a, v) => renderJson(_a, v) },
    async execute(_args, exec) {
      // 只做一次身份自检：确认调用方确实是本项目登记的 Worker 会话（拿不到就照旧报错）。
      await workerSessionIdOf(deps, exec);
      const err: ToolError = {
        status: 'blocked',
        code: 'classification_rejected',
        message:
          '交接草稿必须由人类发起：请人类在控制台「渗透作业」列表里选中本作业，点「进入下一阶段」——' +
          '草稿生成后会在会话卡片里展开成编辑器，人类审计修改后才注入下一阶段。' +
          '（你自己不能生成：那次请求要往同一个会话续跑一个新回合，而你现在就在这个回合里——会把自己等死。）',
        next_action: '把上面这句转告人类，然后交完本阶段报告即可结束；不要再次调用本工具。',
      };
      return toJson(asError(err));
    },
  });

  const pentestExec = defineWorkerTool({
    name: 'pentest_exec',
    description:
      '**在沙箱里跑一条命令**（唯一的目标接触通道）。' +
      'command 是你在沙箱内执行的整条命令原文（bash 语法，`bash -c` 执行——不是 dash）；' +
      '镜像里有 nmap / curl / wget / nc / dig / openssl / jq / whois / ping / ffuf / sqlmap ' +
      '与 python3（含 requests/dnspython/beautifulsoup4）、字典在 /usr/share/wordlists 下。' +
      '沙箱直连目标（不经代理）、有 NET_RAW、容器内为 root；**能否出网由部署决定**（`internal` 网络没有出口；' +
      '非 internal ⇒ 与宿主同可达，且出网间歇；形状见启动日志的 `[dsh-pentest] 沙箱可达性` 一行）——' +
      '可达不等于授权，只对已授权目标动作。' +
      'target_selector 声明这条命令打的是哪个已授权目标（只能来自选择器，不接受命令里的目标字面量）；' +
      'port 是它主要针对的端口，用于范围闸门记账。' +
      '**它要不要人批，看你在哪个阶段**（服务端按会话阶段给这条命令定类别，你无法自行改）：' +
      '①②③（情报/威胁建模/漏洞分析）**免批**——服务端按类别放行并记审计，命令原文不再经人过目；' +
      '**④利用验证逐条放行、⑤后渗透一律逐条放行**——先用 `pentest_request_action_approval` 申请，' +
      '人类在放行卡上看到的就是你写的命令原文，批准后带 `approval_id` 执行**同一条**命令。' +
      '另外仍然转给人类的是**超出预设**的动作与默认禁用类别（persistence/destructive/exfiltration）。' +
      '**免批不等于可以自作主张**——范围裁决（只打已裁决地址、端口记账）与沙箱加固照旧，' +
      '不要因为免批就扩大范围或提权。' +
      REFUSAL_DOC,

    parameters: {
      command: { type: 'string', required: true, description: '在沙箱内执行的命令原文（shell 语法）' },
      port: {
        type: 'integer',
        description: '这条命令主要针对的端口（范围闸门据此记账）；`local_only` 时不需要',
      },
      target_selector: {
        type: 'string',
        description: '目标选择器（已授权范围内的目标）；`local_only` 时不需要',
      },
      local_only: {
        type: 'boolean',
        description:
          '这条命令是**纯本地处理**（解析自己落盘的 .gnmap/JSON、校验交付物、比对两份清单……）时设为 true：' +
          '容器**没有网**（`--network none`，实测证实），不做范围裁决，账本单列成 `local_processing`。' +
          '**不要**拿它包装真正要打目标的命令——那种命令的类别、记账与范围裁决都不能省。',
      },
      purpose: { type: 'string', required: true, description: '目的：为什么执行它、预期看到什么' },
      approval_id: {
        type: 'string',
        description: '需要放行的动作必须携带人类放行后返回的 approval_id',
      },
      save_stdout_as_evidence: {
        type: 'boolean',
        description:
          '设为 true 时，服务端把这条命令的 stdout **原文**写进会话工作目录（`/work/evidence/<目标>/<UTC时间>-<用途>.txt`），' +
          '返回值里给出一行 `evidence: <相对路径>`。**文件名由 `purpose` 派生**（slug 化，≤48 字符）——' +
          '想让文件名好读，就把 purpose 写成一句短语（`route chunk api 清单` 比 `js chunk api 268 1 API` 好读）。' +
          '**建议凡是产出证据的命令都开**：容器是一次性的，不开就只能靠你自己在命令里 tee（忘一条那条原文就永久没了）。' +
          '它只是**额外落盘**，不改命令本身。**超时/中止时也落盘**（写已捕获的部分），此时返回值带 `partial_output: true`——' +
          '那半截输出往往是唯一线索，别丢掉。' +
          '落盘成功后还会**登记成证据**：返回值带 `artifact_id`/`artifact_ref`，报告的 `source_refs` 直接引它' +
          '（`artifact:<uuid>`）；登记失败会带 `evidence_failed`/`evidence_artifact_error` **说出来**，' +
          '不会静默少一条证据链。' +
          '**命令自己写进 /work 时不重复落盘**：若命令的最后一段里已有 `> /work/…`、`>> /work/…` 或 `tee /work/…`，' +
          '本项回 `evidence: skipped_by_command`（不写第二份近重复文件）——要那份自动副本就去掉命令里的重定向',
      },
    },
    output: { schema: { type: 'json' }, render: (_a, v) => renderJson(_a, v) },
    timeoutMs: 15 * 60 * 1000,
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      const workerSessionId = await workerSessionIdOf(deps, exec);
      const local = args.local_only === true;
      const targetSelector = args.target_selector ?? '';
      const port = args.port ?? 0;
      // 本地处理与目标动作走**两张不同的模板**：前者容器无网、不做范围裁决、账本单列；
      // 后者必须有 target/port（范围闸门据此记账）。这条校验只能写在这里——
      // schema 表达不了"某参数在另一个参数为真时必填"。
      if (!local && (targetSelector === '' || args.port === undefined)) {
        return toJson(asError({
          status: 'blocked',
          code: 'classification_rejected',
          message:
            'target_selector 与 port 必填——除非这条命令是**纯本地处理**（那种情况请传 local_only: true）。',
          next_action:
            '要么补上目标与端口（命令确实要打目标），要么改成 local_only: true（容器无网，只读挂载进来的文件）。',
        }));
      }
      const commandB64 = Buffer.from(args.command, 'utf8').toString('base64');
      // 命令以 base64 传输：宿主拼出的是一条**单个 argv 字符串**并按空格切分，
      // 裸命令会被切散。编码在这里做（工具侧），所以 Agent 只管写命令原文。
      const intent: ActionIntent = local
        ? {
            workerSessionId,
            templateId: 'local_command',
            // 本地模板的哨兵占位符取值：只进审计展示，不参与裁决（分发器的 `shell_exec` 只读 command_b64）。
            targetSelector: targetSelector === '' ? 'local' : targetSelector,
            purpose: args.purpose,
            params: { command_b64: commandB64 },
            ...(args.approval_id === undefined ? {} : { approvalId: args.approval_id }),
          }
        : {
            workerSessionId,
            templateId: 'direct_command',
            targetSelector,
            purpose: args.purpose,
            params: { port, command_b64: commandB64 },
            ...(args.approval_id === undefined ? {} : { approvalId: args.approval_id }),
          };
      const outcome = await deps.execute({ workerSessionId, intent, signal: exec.signal });
      // 拒绝路径把契约错误直接交给模型（与 memory_read 的拒绝形状一致），
      // 不包在 {plan,result} 里——那会让「被拒绝」看起来像「执行完了」。
      //
      // 证据落盘（2026-10-08 实地记录 §3.3）：**执行完之后**由宿主侧写文件，不依赖模型记得 `tee`。
      // 失败只回一行说明：一次**已经执行完**的动作不该因为写盘失败被报成失败（那会诱发重发＝对目标再打一次）。
      //
      // **为什么条件不是 `kind === 'executed'`**（2026-10-08 操作者实测 P0-2）：容器是一次性的，
      // 超时/中止时 `kind` 不是 `executed`，于是恰恰在**最需要那半截输出**的场景下不落盘——
      // 一条跑了 289 秒的命令，前 288 秒的产出全部不可回收，人只能重跑（等于对目标再打一遍）。
      // 宿主侧的捕获器本来就把已读到的 stdout 保留在 `mapOutcome` 的返回里（`timed_out`/`cancelled`
      // 两个分支都带 `stdout`），所以这里只需把落盘条件放宽到"有结果就落"。
      // 落盘结果结构化（2026-10-11 操作者实测 P0）：此前只回一行 `evidence: …`，成功与失败
      // **同形**（都是同一句话的位置），而失败恰恰是这个功能最不能接受的形态——它的全部价值就是
      // "忘了 tee 时的安全网"。现在失败带 `evidence_failed: true` 并说明输出此刻在哪。
      let evidence:
        | {
            readonly ok: boolean;
            readonly detail: string;
            readonly hostPath?: string;
            readonly artifactId?: string;
            /** 登记失败的原因（文件已落盘，但 artifact 行没写成）：**开口**而不是吞掉。 */
            readonly artifactError?: string;
            /** 命令自己写进了挂载根 ⇒ 本行只是"没重复落盘"的说明（不是失败）。 */
            readonly skippedByCommand?: boolean;
          }
        | null = null;
      // 先收窄再取 result：`blocked` 变体没有 `result` 字段（类型系统盯着这一点）。
      const executed = outcome.kind === 'blocked' ? null : outcome;
      const resultView = executed?.result as
        | { readonly stdout?: unknown; readonly status?: unknown; readonly stderr?: unknown }
        | null;
      const partial = resultView?.status === 'timed_out' || resultView?.status === 'cancelled';
      if (args.save_stdout_as_evidence === true && outcome.kind !== 'blocked') {
        // 优先**按会话**解析（与容器 argv/简报/工具同源）；无该钩子时回退静态配置。
        const root = deps.evidenceRootFor?.(workerSessionId) ?? deps.evidenceRoot;
        const stdout = resultView?.stdout;
        const containerMounts = deps.mountContainerPathsFor?.(workerSessionId) ?? [DEFAULT_MOUNT_CONTAINER_PATH];
        if (root === undefined) {
          evidence = {
            ok: false,
            detail: '未挂载工作目录（见 pentest_workdir 的 no_roots）：本次输出只在返回值与 tool_run 记录里',
          };
        } else if (writesIntoMount(args.command, containerMounts)) {
          // 命令**自己**写进了挂载根（台账/报告）：不再落一份近重复文件（2026-10-11 操作者实测 #5：
          // 两份文件名相邻、内容近似，派生那份是用途 slug 的截断，读起来更差）。此行**说出来**，
          // 不静默：要那份自动副本就把命令里的重定向去掉（安全网的场景正是"模型忘了写"）。
          evidence = {
            ok: true,
            detail:
              `命令自己写进了挂载根（${containerMounts.join('、')}/…）⇒ 未重复落盘；` +
              '需要宿主侧自动副本时，把命令里的 `/work` 重定向/tee 去掉再跑',
            skippedByCommand: true,
          };
        } else if (typeof stdout === 'string' && stdout.length > 0) {
          const relPath = evidenceRelPath({ targetSelector, purpose: args.purpose, at: new Date() });
          const written = writeEvidence(root, relPath, stdout);
          if (written.ok) {
            const hostPath = join(root, relPath);
            // 登记为 artifact（见 `recordEvidenceArtifact` 的说明）：只多一条数据库行，
            // 却让报告的证据链从"tool_run 一条腿"变成"可被 readArtifact 取回的一条腿"。
            const registered = await registerEvidenceArtifact(deps, {
              workerSessionId,
              storagePath: hostPath,
              containerPath: `${DEFAULT_MOUNT_CONTAINER_PATH}/${relPath}`,
              stdout,
              purpose: args.purpose,
              targetSelector,
              targetHints: [
                ...new Set([
                  ...(outcome.plan.resolvedAddresses ?? []),
                  outcome.plan.normalizedTarget,
                ]),
              ].filter((hint) => hint !== ''),
              // 规范 §7：模型可见字段 snake_case（内部仍叫 `toolRunId`）。
              ...(outcome.toolRunId === undefined ? {} : { tool_run_id: outcome.toolRunId }),
            });
            evidence = {
              ok: true,
              detail: written.detail,
              hostPath,
              ...(registered.artifactId === undefined ? {} : { artifactId: registered.artifactId }),
              ...(registered.error === undefined ? {} : { artifactError: registered.error }),
            };
          } else {
            evidence = written;
          }
        } else if (partial) {
          evidence = { ok: false, detail: '本次没有捕获到任何 stdout（命令在产出前就被终止）' };
        }
      }
      return toJson(
        outcome.kind === 'blocked'
          ? outcome.error
          : {
              plan: planView(outcome.plan),
              // 执行结果在这一层是 `unknown`（`outcome` 的形状宽松）；它由 execution 层构造，
              // 类型就是 `ToolRunResult` ⇒ 在这一处**具名断言**（不是内联成员访问）。
              result: toolRunResultView(outcome.result as ToolRunResult),
              // 超时/中止时明确标注"这是部分输出"：消费方不该把它当完整结果（§10.3 同一条纪律）。
              ...(partial ? { partial_output: true } : {}),
              // **stderr 非空就自己开口**（见 `stderrMarker` 的说明：空 stdout + 被管道掩掉的
              // 退出码 = 看起来像"干净的阴性结果"）。
              ...stderrMarker(resultView),
              ...(evidence === null
                ? {}
                : evidence.ok
                  ? evidence.skippedByCommand === true
                    ? { evidence: evidence.detail, evidence_skipped: 'command_wrote_mount' }
                    : {
                        evidence: evidence.detail,
                        // 两种路径都给：容器路径是模型写命令时用的，宿主路径是人复核时用的。
                        evidence_container_path: `${DEFAULT_MOUNT_CONTAINER_PATH}/${evidence.detail}`,
                        ...(evidence.hostPath === undefined ? {} : { evidence_host_path: evidence.hostPath }),
                        // 证据链：报告写 `source_refs: ["artifact:<id>"]` 用它（诉求 #5）。
                        ...(evidence.artifactId === undefined
                          ? {}
                          : { artifact_id: evidence.artifactId, artifact_ref: `artifact:${evidence.artifactId}` }),
                        ...(evidence.artifactError === undefined
                          ? {}
                          : { evidence_artifact_error: evidence.artifactError }),
                      }
                  : { evidence_failed: true, evidence: evidence.detail }),
              // 规范 §7：模型可见字段 snake_case（内部仍叫 `toolRunId`）。
              ...(outcome.toolRunId === undefined ? {} : { tool_run_id: outcome.toolRunId }),
            },
      );
    },
  });

  const pentestRecon = defineWorkerTool({
    name: 'pentest_recon',
    description:
      '**结构化侦察动作**（唯一入口是它，而不是让你手写 nmap/ffuf 命令）。' +
      '每个 technique 由服务端固定一条命令形态，参数只有声明过的枚举/整数——' +
      '目标从选择器注入、地址由宿主的裁决结果固定（容器不做 DNS），' +
      '因此同一动作的审计与幂等键是可复现的，也不需要人类为每条扫描命令逐次放行：' +
      '侦察类动作按 `active_probing`/`passive_collection` 记账，由范围、租约、节奏（stealth 1rps / standard 5rps / fast 10rps）约束；' +
      '需要人批的是**超出预设**的动作（会转给人类）与 `exploit_validation`/`lateral_movement` 两个逐次放行类别；自由命令模板 `direct_command`（走 pentest_exec）按会话阶段定类：①②③ 免批，④ 记 `exploit_validation`、⑤ 记 `lateral_movement` ⇒ 这两个阶段逐条人批。' +
      '**DNS 类 technique（dns_enum/dns_brute）走 UDP**：范围条目要声明 udp，否则会被范围闸门拒绝。' +
      '先扫面（port_scan）再指纹（service_probe/tls_inspect/http_probe），最后才目录与爬取——顺序写进了 recon-network-surface/recon-web-surface 两份 skill。' +
      REFUSAL_DOC,

    parameters: {
      technique: {
        type: 'string',
        enum: [
          'port_scan',
          'service_probe',
          'nse_safe',
          'tls_inspect',
          'http_probe',
          'content_discover',
          'web_crawl',
          'dns_enum',
          'dns_axfr',
          'dns_brute',
          'whois',
          'ct_subdomains',
        ],
        required: true,
        description: '要执行的侦察动作（见 recon-* skill 里的判据与顺序）',
      },
      target_selector: {
        type: 'string',
        required: true,
        description: '已授权范围内的目标选择器；命令里的目标由服务端从这里注入',
      },
      purpose: { type: 'string', required: true, description: '目的：为什么做它、预期看到什么' },
      port: { type: 'integer', description: '单个端口（tls_inspect/http_probe/content_discover/web_crawl/nse_safe）' },
      ports: {
        type: 'string',
        description: '端口表达式（service_probe 必填；port_scan 可选，none 表示按 scope 档位）',
      },
      scope: { type: 'string', enum: ['top100', 'top1000', 'common_services', 'full_tcp'], description: 'port_scan 的扫描档位' },
      ping: {
        type: 'string',
        enum: ['syn', 'connect', 'skip'],
        description:
          'port_scan 的**主机存活判定**（不是扫描类型）：syn=`-sS -PS`（先探 80 判存活；目标丢弃探针会被判 down ⇒ **一个端口都不扫**，报告里以 `host: … state=down` + `open_ports=0` 呈现——那是漏报形态，不是"全关"）；connect=`-sT -Pn`；skip=`-Pn`（**默认**，不判存活直接扫，最不容易漏）',
      },
      restrict_to_scope: {
        type: 'string',
        enum: ['true', 'false'],
        description:
          'port_scan 的**交集扫描**。**先分清三条路**（2026-10-11 实测：旧文档把这条写成"否则会被闸门拒"，那是错的）——' +
          '① 只给 `ports=<授权端口>`：`scope` 被忽略，**就扫这几个端口**，完全合法，**不需要本开关**；' +
          '② 只给 `scope=<档位>`（`ports=none`）：扫整个档位，而范围只授权了其中一部分时会被闸门拒（档位不可枚举）；' +
          '③ 本开关 = true 且**同时给 `ports`**：扫「档位 ∩ 授权集合」（容器算 `top-N ∩ ports`，回报 `used_ports`）——' +
          '"想按 top-100 的口径覆盖、但只能打授权的那几个端口"时用它。空交集会明说 `scope_intersection: empty` 且 `scanned=false`（**别读成"0 开放"**）',
      },
      intensity: { type: 'string', enum: ['light', 'normal'], description: 'service_probe 的指纹强度' },
      scripts: { type: 'string', description: 'nse_safe 的只读脚本名（逗号分隔，白名单由沙箱强制）' },
      sni: { type: 'string', description: 'tls_inspect 的 SNI；none 表示用目标名' },
      enumerate_protocols: { type: 'string', enum: ['on', 'off'], description: 'tls_inspect 是否枚举协议版本与套件' },
      scheme: { type: 'string', enum: ['http', 'https', 'auto'], description: 'http_probe 的协议（content_discover/web_crawl 只接受 http/https）' },
      follow_redirects: { type: 'integer', description: 'http_probe 的跳转上限（0-3；跨主机跳转一律拒绝）' },
      include_chunks: {
        type: 'string',
        enum: ['true', 'false'],
        description:
          'http_probe 的 **endpoints 专用**开关（默认 true）：是否**跟随同主机的 .js 引用**（`/_next/static/chunks/*` 这类）再抽一遍路径。**对 Next.js/Vite 这类 SPA，路由往往只在 chunk 里**（实测：首页抽到 20 条，chunk 另有 11 条 `/api/*`——含核心发现，而字典枚举全都没命中）。只跟同主机、上限 8 条 / 每条 256KiB；命中标出 `@<chunk 路径>` 供复核',
      },
      collect: {
        type: 'string',
        enum: ['headers', 'security_headers', 'robots', 'sitemap', 'tech', 'endpoints'],
        description:
          'http_probe 的采集面。**endpoints=端点/路由抽取**：固定三种形态（属性 href/src/action、引号内的绝对路径、fetch/axios 调用第一实参），每条短行带 hits。**手写 grep 抽路由的失败是静默的**（ERE 字符类里反斜杠不是转义 ⇒ 倒置区间报 Invalid range end，而 `| head` 会把 rc 掩成 0，空 stdout 看起来就像「页面里没有路径」）——要抽路由优先用它',
      },
      verify_tls: {
        type: 'string',
        enum: ['true', 'false'],
        description:
          VERIFY_TLS_DOC +
          '适用：http_probe / content_discover / web_crawl / http_check / exposure_check（http_get 同理，但它在插件侧没有模板）',
      },
      wordlist: {
        type: 'string',
        enum: ['common_dirs', 'raft_small', 'api_endpoints', 'quickhits'],
        description:
          '字典档位：common_dirs / raft_small（通用目录）、api_endpoints（API 路由命名）、quickhits（高价值小文件）',
      },
      extensions: {
        type: 'string',
        enum: ['none', 'php', 'asp', 'aspx', 'jsp', 'html', 'txt', 'json', 'multi'],
        description: 'content_discover 追加的扩展名',
      },
      rate: { type: 'integer', description: 'content_discover 的每秒请求数上限（1-20）' },
      path: {
        type: 'string',
        description:
          'content_discover 的基准路径前缀（空串或省略 = 站点根；如 `api` 或 `v1/api`，两侧斜杠会归一）。' +
          '在 /api/ 这类子路径下枚举时必须给，否则只会打根路径；不得含 `..` 段或查询串',
      },
      paths: {
        type: 'string',
        description:
          'http_probe 的**批量路径状态复核**（≤60 条，逗号分隔，每条形如 `/x/y`，**可以带查询串**如 `/api/submissions?mine=1`；' +
          '**拒绝**含 scheme/主机/空白/片段 `#`/路径里 `..` 的串——那是把"路径"当"目标"用，会让范围记账失效）。' +
          '给了它：只对每条发 GET（加 `probe_options=true` 时每条再发一次 OPTIONS），逐条返回 ' +
          '`path status size content_type note baseline_ns allow`——**`allow` 列是未鉴权下的方法表**（405 响应常带 `Allow`），' +
          '据此**不发写请求**就能清点写端点。软 404 基准**按命名空间各取一条**（页面 404 与 API 404 常不同形），' +
          '同命名空间内同状态码同长度的命中标 `soft404`。' +
          '**发现**用 collect=endpoints，**复核**才用它（2026-10-11 操作者诉求：别再退回手写 bash for + curl）',
      },
      page: {
        type: 'string',
        description:
          'http_probe 的**取哪一页**（省略或空串 = 站点根 `/`；可带查询串）。抽取端点与跟随 chunk 都以这一页为对象。' +
          '**SPA/Next.js 的关键用法**：路由自己的 chunk 才含 API 调用（每条路由自带 8–11 个 chunk），' +
          '所以逐路由调 `collect=endpoints page=/admin`、`page=/run`… 是本轮最有效的发现路径——' +
          '不必自己写 `for p in …; do curl; grep; done`（手写 grep 抽路由的失败是静默的）。' +
          '`paths=` 批量模式下本参数不生效',
      },
      probe_options: {
        type: 'string',
        enum: ['true', 'false'],
        description:
          'http_probe 的**方法表清点**（默认 false）：true ⇒ 对同一条路径（`page` 或 `paths` 里的每一条）' +
          '**额外**发一次只读 `OPTIONS` 并读 `Allow` 头。405/OPTIONS 的 `Allow` 在未鉴权下常给出完整方法表' +
          '（实测：一个写请求都没发就拿到 20 条写端点的 POST/PUT/DELETE）——这是清点，不是利用；' +
          '**别**为了"确认"去发 PUT/DELETE',
      },
      entry_range: {
        type: 'string',
        description:
          'content_discover 的**字典分段**（`A-B`，1 基双闭区间，如 `1-2000`；省略 = 整本字典）。' +
          '大字典（common_dirs≈4700 行）在单条命令墙钟内跑不完：用分段多次调用拼完，每次 summary 自证 ' +
          '`entry_range/attempted/truncated/remaining`，超可调度量时直接写"需要分 N 段"',
      },
      depth: { type: 'integer', description: 'web_crawl 深度（1-3）' },
      max_pages: { type: 'integer', description: 'web_crawl 页数上限（1-500）' },
      record_types: { type: 'string', description: 'dns_enum 的记录类型（逗号分隔，最多 8 个）' },
      resolver: { type: 'string', enum: ['system', 'public'], description: 'dns_enum 用哪组解析器' },
      concurrency: { type: 'integer', description: 'dns_brute 并发查询数（1-20）' },
      wildcard_check: { type: 'string', enum: ['on', 'off'], description: 'dns_brute 是否先探测泛解析' },
      kind: { type: 'string', enum: ['domain', 'ip'], description: 'whois 的查询类型' },
      include_wildcards: { type: 'string', enum: ['false', 'true'], description: 'ct_subdomains 是否保留通配项' },
      approval_id: { type: 'string', description: '若服务端判定需要放行，把人类放行后返回的 approval_id 带上重试' },
    },
    output: { schema: { type: 'json' }, render: (_a, v) => renderJson(_a, v) },
    timeoutMs: 15 * 60 * 1000,
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      const workerSessionId = await workerSessionIdOf(deps, exec);
      const planned = buildStructuredIntent('recon', {
        technique: args.technique,
        targetSelector: args.target_selector,
        purpose: args.purpose,
        ...(args.port === undefined ? {} : { port: args.port }),
        ...(args.ports === undefined ? {} : { ports: args.ports }),
        ...(args.scope === undefined ? {} : { scope: args.scope }),
        ...(args.ping === undefined ? {} : { ping: args.ping }),
        ...(args.restrict_to_scope === undefined ? {} : { restrict_to_scope: args.restrict_to_scope }),
        ...(args.intensity === undefined ? {} : { intensity: args.intensity }),
        ...(args.scripts === undefined ? {} : { scripts: args.scripts }),
        ...(args.sni === undefined ? {} : { sni: args.sni }),
        ...(args.enumerate_protocols === undefined ? {} : { enumerate_protocols: args.enumerate_protocols }),
        ...(args.scheme === undefined ? {} : { scheme: args.scheme }),
        ...(args.follow_redirects === undefined ? {} : { followRedirects: args.follow_redirects }),
        ...(args.collect === undefined ? {} : { collect: args.collect }),
        ...(args.include_chunks === undefined ? {} : { include_chunks: args.include_chunks }),
        ...(args.wordlist === undefined ? {} : { wordlist: args.wordlist }),
        ...(args.extensions === undefined ? {} : { extensions: args.extensions }),
        ...(args.path === undefined ? {} : { path: args.path }),
        ...(args.paths === undefined ? {} : { paths: args.paths }),
        ...(args.page === undefined ? {} : { page: args.page }),
        ...(args.probe_options === undefined ? {} : { probe_options: args.probe_options }),
        ...(args.entry_range === undefined ? {} : { entry_range: args.entry_range }),
        ...(args.depth === undefined ? {} : { depth: args.depth }),
        ...(args.max_pages === undefined ? {} : { maxPages: args.max_pages }),
        ...(args.record_types === undefined ? {} : { recordTypes: args.record_types }),
        ...(args.resolver === undefined ? {} : { resolver: args.resolver }),
        ...(args.concurrency === undefined ? {} : { concurrency: args.concurrency }),
        ...(args.wildcard_check === undefined ? {} : { wildcardCheck: args.wildcard_check }),
        ...(args.kind === undefined ? {} : { kind: args.kind }),
        ...(args.include_wildcards === undefined ? {} : { includeWildcards: args.include_wildcards }),
        ...(args.verify_tls === undefined ? {} : { verify_tls: args.verify_tls }),
      });
      if (!planned.ok) {
        return toJson(
          asError({
            status: 'blocked',
            code: planned.code,
            message: planned.message,
            next_action: planned.nextAction,
          }),
        );
      }
      const intent: ActionIntent = {
        workerSessionId,
        templateId: planned.templateId,
        targetSelector: args.target_selector,
        purpose: args.purpose,
        params: planned.params,
        ...(args.approval_id === undefined ? {} : { approvalId: args.approval_id }),
      };
      const outcome = await deps.execute({ workerSessionId, intent, signal: exec.signal });
      return toJson(
        outcome.kind === 'blocked'
          ? outcome.error
          : {
              plan: planView(outcome.plan),
              // 执行结果在这一层是 `unknown`（`outcome` 的形状宽松）；它由 execution 层构造，
              // 类型就是 `ToolRunResult` ⇒ 在这一处**具名断言**（不是内联成员访问）。
              result: toolRunResultView(outcome.result as ToolRunResult),
              // 与 `pentest_exec` 同一口径：stderr 非空就自己开口（空 stdout + 被管道掩掉的 rc
              // = 看起来像"干净的阴性结果"）。
              ...stderrMarker(outcome.result as { readonly stderr?: unknown }),
              // 规范 §7：模型可见字段 snake_case（内部仍叫 `toolRunId`）。
              ...(outcome.toolRunId === undefined ? {} : { tool_run_id: outcome.toolRunId }),
            },
      );
    },
  });

  const pentestScan = defineWorkerTool({
    name: 'pentest_scan',
    description:
      '**结构化核验动作**（漏洞分析阶段的只读面）：把一条候选变成「成立 / 不成立 / 需要更多证据」。' +
      '每个 technique 由服务端固定命令形态、只打已裁决地址，类别是 `active_probing`——' +
      '**不需要逐条人工放行**；它只发读取类请求、不写目标、不下载内容' +
      '（配置面暴露只报存在性、长度、哈希与形态判定）。' +
      '判据写进对应的 skill：一条候选没有可判定的判据就不要核验，先补情报。' +
      '需要发载荷（SQLi/XSS/SSRF/上传…）的验证**不属于本工具**：那是利用验证阶段的 `poc_run`/`pentest_exec`，逐条人批。' +
      REFUSAL_DOC,

    parameters: {
      technique: {
        type: 'string',
        enum: ['http_check', 'exposure_check', 'tls_weakness', 'nse_handshake'],
        required: true,
        description: '核验动作：http_check / exposure_check / tls_weakness / nse_handshake',
      },
      target_selector: { type: 'string', required: true, description: '已授权范围内的目标选择器' },
      purpose: { type: 'string', required: true, description: '目的：要验证哪条候选、预期看到什么' },
      port: { type: 'integer', description: '端口（多数 technique 需要；缺省按 technique 的安全默认值）' },
      scheme: { type: 'string', enum: ['http', 'https', 'auto'], description: 'http_check 用 auto；exposure_check 只接受 http/https' },
      check: {
        type: 'string',
        enum: ['tech_stack', 'security_headers', 'cookies', 'cors_policy', 'http_verbs', 'error_disclosure'],
        description: 'http_check 的核验项',
      },
      paths: {
        type: 'string',
        description: 'exposure_check 要探测的暴露项（逗号分隔，≤10）：git,env,backup,swagger,openapi,actuator,server_status,phpinfo,web_config,dockerfile',
      },
      verify_tls: {
        type: 'string',
        enum: ['true', 'false'],
        description:
          VERIFY_TLS_DOC + '适用：http_check / exposure_check',
      },
      sni: { type: 'string', description: 'tls_weakness 的 SNI；none 表示用目标名' },
      enumerate_protocols: { type: 'string', enum: ['on', 'off'], description: 'tls_weakness 必须为 on' },
      scripts: {
        type: 'string',
        description: 'nse_handshake 的只读脚本（smtp-commands,ftp-anon,ssh-auth-methods,rdp-ntlm-info,ssl-enum-ciphers,http-methods,smb-os-discovery,smb-security-mode）',
      },
      approval_id: { type: 'string', description: '若服务端判定需要放行，把放行后返回的 approval_id 带上重试' },
    },
    output: { schema: { type: 'json' }, render: (_a, v) => renderJson(_a, v) },
    timeoutMs: 15 * 60 * 1000,
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      const workerSessionId = await workerSessionIdOf(deps, exec);
      const planned = buildStructuredIntent('vuln', {
        technique: args.technique,
        targetSelector: args.target_selector,
        purpose: args.purpose,
        ...(args.port === undefined ? {} : { port: args.port }),
        ...(args.scheme === undefined ? {} : { scheme: args.scheme }),
        ...(args.check === undefined ? {} : { check: args.check }),
        ...(args.paths === undefined ? {} : { paths: args.paths }),
        ...(args.verify_tls === undefined ? {} : { verify_tls: args.verify_tls }),
        ...(args.sni === undefined ? {} : { sni: args.sni }),
        ...(args.enumerate_protocols === undefined ? {} : { enumerateProtocols: args.enumerate_protocols }),
        ...(args.scripts === undefined ? {} : { scripts: args.scripts }),
      });
      if (!planned.ok) {
        return toJson(
          asError({
            status: 'blocked',
            code: planned.code,
            message: planned.message,
            next_action: planned.nextAction,
          }),
        );
      }
      const intent: ActionIntent = {
        workerSessionId,
        templateId: planned.templateId,
        targetSelector: args.target_selector,
        purpose: args.purpose,
        params: planned.params,
        ...(args.approval_id === undefined ? {} : { approvalId: args.approval_id }),
      };
      const outcome = await deps.execute({ workerSessionId, intent, signal: exec.signal });
      return toJson(
        outcome.kind === 'blocked'
          ? outcome.error
          : {
              plan: planView(outcome.plan),
              // 执行结果在这一层是 `unknown`（`outcome` 的形状宽松）；它由 execution 层构造，
              // 类型就是 `ToolRunResult` ⇒ 在这一处**具名断言**（不是内联成员访问）。
              result: toolRunResultView(outcome.result as ToolRunResult),
              // 与 `pentest_exec` 同一口径：stderr 非空就自己开口（空 stdout + 被管道掩掉的 rc
              // = 看起来像"干净的阴性结果"）。
              ...stderrMarker(outcome.result as { readonly stderr?: unknown }),
              // 规范 §7：模型可见字段 snake_case（内部仍叫 `toolRunId`）。
              ...(outcome.toolRunId === undefined ? {} : { tool_run_id: outcome.toolRunId }),
            },
      );
    },
  });

  const skillLoad = defineWorkerTool({
    name: 'skill_load',
    description:
      '读取本会话**已装载** skill 的正文（方法论、步骤、命令与判据）。' +
      '能力快照里列出的才是可加载的——装载集合在创建会话时冻结，你无法自行扩大，' +
      '库里的其它 skill 对你不可见。动手前先加载与本阶段目标相关的那一份，按它的步骤与判据执行；' +
      '正文里的命令就是你要在沙箱里跑的命令。',
    parameters: {
      skill_name: { type: 'string', required: true, description: '能力快照里列出的 skill 名' },
    },
    output: { schema: { type: 'json' }, render: (_a, v) => renderJson(_a, v) },
    async execute(args, exec) {
      const result = await deps.loadSkill({
        workerSessionId: await workerSessionIdOf(deps, exec),
        skillName: args.skill_name,
      });
      if (result.skill === null) {
        // 内容漂移/被删除/被停用：拒绝原因必须原样呈现——说成「不在装载集合里」
        // 会让模型和人类都找错方向（事故 2026-10-05）。
        const err: ToolError = result.refusal === undefined
          ? {
              status: 'blocked',
              code: 'classification_rejected',
              message:
                `skill ${args.skill_name} 不在本会话的装载集合里` +
                (result.loadedNames.length === 0
                  ? '（本会话没有装载任何 skill）'
                  : `；本会话装载的是：${result.loadedNames.join('、')}`),
              next_action: '只加载能力快照里列出的 skill；需要别的 skill 请人类在创建会话时勾选',
            }
          : {
              status: 'blocked',
              code: 'classification_rejected',
              message: result.refusal.message,
              next_action: result.refusal.nextAction,
            };
        return toJson(asError(err));
      }
      // 规范 §7：技能条目的 `contentHash`→`content_hash`。
      return toJson(result.skill === null ? null : skillView(result.skill));
    },
  });

  /**
   * 作业目录的读写（`sandbox.mounts` 声明的宿主目录）。
   *
   * 存在的理由是一个自锁：沙箱命令**每条**都要声明已授权目标，于是空范围作业
   * （范围版本 0）里连 `ls /work` 都跑不了——「读你自己的作业资料」与目标无关，
   * 却被目标闸门挡住。本工具不接触任何目标，只用一条路径约束（必须落在挂载根内）。
   */
  // **把配置声明的挂载内联进描述**（2026-10-10 操作者实测 P1）：写新文件时"是哪几个根"不该靠先
  // `op=list` 才知道。**但描述只能说配置值**：`/work` 实际跟随**本会话的工作目录**（按会话解析，
  // 见 `rootsFor`），构造期拿不到会话 ⇒ 描述里点明这一点、并把权威指向 `op=list` 的 `roots`
  // （2026-10-11：只写配置值会把模型引到错误的目录，那正是实测到的漂移）。
  const mountRoots = deps.workdir?.roots ?? [];
  const rootsFact =
    mountRoots.length === 0
      ? '**配置里没有挂载根**（`sandbox.mounts` 为空）：本工具可调用，但有没有可读写目录以 `op=list` 的 `roots` 为准。'
      : `**配置声明的挂载**：${mountRoots
          .map((root) => `\`${root.containerPath}\`${root.readOnly === true ? '（只读）' : '（读写）'}`)
          .join('、')}；**其中 \`/work\` 实际跟随本会话在宿主上的工作目录**（会话 cwd 覆盖它）。`;
  const workdirTool = defineWorkerTool({
    name: 'pentest_workdir',
    description:
      '**读写人类挂进沙箱的作业目录**（profile 里 `sandbox.mounts` 声明的宿主目录；容器内路径也在返回值里给出）。' +
      rootsFact +
      '**它不经过范围闸门**：空范围作业（范围版本 0）里 `pentest_exec` 会被 out_of_scope 拒绝，' +
      '而本工具照常可用——读作业资料（资产清单、既有报告、目标说明、人类放进去的任何文件）就该用它。' +
      `op：\`list\` 列目录、\`read\` 读文本（超 ${Math.round(WORKDIR_READ_LIMIT_BYTES / 1024)}KiB 会截断并标注）、` +
      '`write` 写文本文件（会建父目录）、`search` 在目录内**递归检索正则**（返回文件/行号/该行，' +
      '外加**命中文件清单** `files`（路径 + 修改时间 + 命中行数，**新的在前**）——归档目录里考古时' +
      '先看最近动过的那几份，比整文件读省上下文）、`append` 追加到文件末尾（补一行不必重发整份）。' +
      'path 是**相对挂载根**的路径，例如 `1-未打点资产与暴露面/清单.md`；写入新文件时若**可写根不止一个**' +
      '才必须用容器路径（如 `/work/...`）消歧——只有一个可写根（其余是只读）时相对路径直接落到它。' +
      '**`/work` 跟随本会话在宿主上的工作目录**（不是配置里的固定目录）；实际生效的挂载根以 `op=list` 返回的 `roots` 为准**（每次调用都会附加）。' +
      '不接受绝对宿主路径、不允许 `..` 跳出根、符号链接指向根外会被拒绝。' +
      '它**不产生证据账本条目**：读到的东西要形成结论，照常写进报告/证据（`pentest_submit_report`）。' +
      '\n⚠️  **警告**：挂载根由人类在启动时配置。如果配置错误，你可能在读写**不属于本作业**的目录。' +
      '每次 `op=list` 时请检查返回的 `roots` 字段（列出所有挂载根及其容器路径），或用 `op=list .` 浏览根目录确认；' +
      '遇到怀疑属于其它作业的文件时停止写操作并通知人类。',
    parameters: {
      op: { type: 'string', required: true, description: 'list | read | write' },
      path: { type: 'string', required: true, description: '相对挂载根的路径（空或 `.` 就是根；目录用于 list/search）' },
      content: { type: 'string', description: 'op=write / op=append 时的正文' },
      pattern: { type: 'string', description: 'op=search 时的正则（JS 语法，u 标志）' },
    },
    output: { schema: { type: 'json' }, render: (_a, v) => renderJson(_a, v) },
    async execute(args, exec) {
      // 与其余 Worker 工具同口径：先确认调用方是本项目登记的会话（拿不到就报错）。
      // **标识要带上**：挂载根按会话解析（会话 cwd 覆盖 `/work`），读写必须落在同一处。
      const workerSessionId = await workerSessionIdOf(deps, exec);
      const op = args.op.trim().toLowerCase();
      if (op !== 'list' && op !== 'read' && op !== 'write' && op !== 'search' && op !== 'append') {
        return toJson(asError({
          status: 'blocked',
          code: 'classification_rejected',
          message: `op 只能是 list / read / write / search / append（收到 ${JSON.stringify(args.op)}）`,
          next_action: '用 list 列目录、read 读文件、search 正则检索、write/append 写文件',
        }));
      }
      const access = deps.workdir;
      if (access === undefined) {
        return toJson(asError({
          status: 'blocked',
          code: 'classification_rejected',
          message: '本部署没有挂载任何宿主目录（`sandbox.mounts` 为空）：作业目录不可读写。',
          next_action: '让人类在 profile 的 `runtime.sandbox.mounts` 里声明作业目录并重启；要跑命令则需先有已确认的范围',
        }));
      }
      try {
        if (op === 'list') {
          const result = await access.list({ path: args.path, workerSessionId });
          // 附加挂载根信息（P0 #3：让模型知道有哪些根可用）
          const roots = access.rootsFor?.(workerSessionId) ?? access.roots;
          // 规范 §7：模型可见字段 snake_case（内部 `WorkdirRoot` 仍是 camelCase）。
          return toJson(workdirListingView(result, roots));
        }
        if (op === 'read') return toJson(workdirFileView(await access.read({ path: args.path, workerSessionId })));
        if (op === 'search') {
          if (args.pattern === undefined) {
            return toJson(asError({
              status: 'blocked',
              code: 'classification_rejected',
              message: 'op=search 必须给出 pattern（正则）',
              next_action: '补上 pattern 再调用；pattern 是 JS 正则，可在大量文档里定位文件与行号',
            }));
          }
          return toJson(workdirSearchView(await access.search({ path: args.path, pattern: args.pattern, workerSessionId })));
        }
        if (args.content === undefined) {
          return toJson(asError({
            status: 'blocked',
            code: 'classification_rejected',
            message: `op=${op} 必须给出 content`,
            next_action: '补上 content 再调用',
          }));
        }
        if (op === 'append') return toJson(workdirWriteView(await access.append({ path: args.path, content: args.content, workerSessionId })));
        return toJson(workdirWriteView(await access.write({ path: args.path, content: args.content, workerSessionId })));
      } catch (error) {
        if (error instanceof WorkdirError) {
          // 策略性拒绝（越界/只读/没挂载）→ 稳定错误码；操作性未命中（不存在/是目录/超限）
          // → 结构化数据，模型据此自我纠偏（比如先 list 父目录），不必当失败处置。
          const policy = error.code === 'outside_roots' || error.code === 'bad_path' ||
            error.code === 'no_roots' || error.code === 'read_only';
          if (policy) {
            return toJson(asError({
              status: 'blocked',
              code: 'classification_rejected',
              message: error.message,
              next_action:
                error.code === 'read_only'
                  ? '该挂载是只读的：把要写的东西交给人类，或让人类把挂载改成读写'
                  : error.code === 'bad_path'
                    ? '多个**可写**根时写新文件必须用容器路径（如 /work/文件名）消歧；只有一个可写根时相对路径即可；可用挂载根见 op=list 返回的 roots'
                    : '用容器路径（如 /work/...）或相对挂载根路径；相对路径只对已存文件或单根部署有效；越界路径不接受'
            }));
          }
          return toJson({
            ok: false,
            reason: error.code,
            message: error.message,
            next_action:
              error.code === 'not_found'
                ? '先用 op=list 看上层目录，确认文件名（注意大小写与中文名）'
                : error.code === 'is_dir' || error.code === 'not_dir'
                  ? 'op 用错：目录用 list，文件用 read'
                  : error.code === 'binary'
                    ? '这是二进制文件：不要在上下文里搬它，需要处理就用沙箱命令（先有范围）'
                    : '把内容拆小，或把大产物留在沙箱里再只回报结论',
          });
        }
        throw error;
      }
    },
  });

  return {
    bootstrapIntake: bootstrapIntakeTool,
    memorySearch,
    memoryRead,
    artifactRead,
    submitReport,
    requestScopeConfirmation,
    writeStatusNote,
    requestApproval,
    prepareHandoff,
    skillLoad,
    pentestExec,
    pentestRecon,
    pentestScan,
    workdirTool,
  };
}

/**
 * 全部 Worker 工具名，供登记与工具面校验使用。
 *
 * `pentest_bootstrap_intake` 排在最前：它是「聊天里发起任务」的**入口**，其余工具
 * 在它成功之前都会以 `lease_required` 拒绝（会话没有作业归属）。清单顺序不影响
 * 工具面可见性，这里只是让「先 bootstrap」这件事在源码里一眼可见。
 */
export const WORKER_TOOL_NAMES = [
  'pentest_bootstrap_intake',
  'memory_search',
  'memory_read',
  'artifact_read',
  'pentest_submit_report',
  'pentest_request_scope_confirmation',
  'pentest_write_status_note',
  'pentest_request_action_approval',
  'pentest_prepare_handoff',
  'skill_load',
  'pentest_exec',
  'pentest_recon',
  'pentest_scan',
  // 作业目录的读写：**不是**目标工具（TARGET_TOOL_NAMES 里没有它）——它只碰人类
  // 显式挂进来的宿主目录，因此不经过范围裁决，空范围作业里也能读作业资料。
  'pentest_workdir',
] as const;

/** 触及目标的工具（守卫与登记据此区分「本插件的目标工具」与宿主工具）。 */
export const TARGET_TOOL_NAMES = ['pentest_exec', 'pentest_recon', 'pentest_scan'] as const;

/**
 * 从执行上下文取本会话的 **dsh 会话标识**。
 *
 * 工具实现不信任模型传入的会话标识，一律从执行身份推导（§4.2：不在 Agent prompt
 * 中暴露内部标识）。注意这只是 dsh 侧的标识，服务方法要的是 worker 会话标识——
 * 必须再过 {@link workerSessionIdOf}。
 */
function dshSessionIdOf(exec: { agent?: unknown }): string {
  const agent = exec.agent as { id?: unknown; sessionId?: unknown } | undefined;
  const id = agent?.sessionId ?? agent?.id;
  if (typeof id === 'string' && id.length > 0) return id;
  throw new Error(
    'pentest worker tool invoked without an agent identity; ' +
      'refusing to guess the session (worker scope must be established by the host)',
  );
}

/**
 * 取本会话的 **worker 会话标识**（服务方法唯一接受的会话身份）。
 *
 * 解析失败即抛——那一刻工具无法确定自己属于哪个 engagement，任何「用默认值继续」
 * 都会让动作落到错误的范围与租约上。
 *
 * ── 这条错误为什么写得这么长 ──
 *
 * 它是**唯一**会出现在「会话不是控制台创建的」这一情形里的信号，而模型会把它的文本
 * 原样转述给人类——所以它必须把「该去哪儿」一次讲清，且不许把两件事混成一句"补不了"。
 *
 * 事实分两层（2026-10-08 人类实测：模型照旧文案告诉人"无法事后补上"，而它自己手里
 * 就有 `pentest_bootstrap_intake`）：
 *
 *   1. **worker 会话**确实补不了：它由控制台的 `startWorker` 创建，标识按
 *      `dsh-<workerSessionId>` 派生并写库，聊天界面里的 `session-…` 没有、也不该有这条记录。
 *   2. **但本会话可以成为 intake**：调 `pentest_bootstrap_intake` 即以本会话建一个作业草稿
 *      （名字形如「未命名任务 …」），人类在控制台确认范围后即可启动真正的 Worker。
 */
async function workerSessionIdOf(deps: WorkerToolDeps, exec: { agent?: unknown }): Promise<string> {
  const dshSessionId = dshSessionIdOf(exec);
  const workerSessionId = await deps.resolveWorkerSessionId(dshSessionId);
  if (workerSessionId === null) {
    throw new Error(
      `本会话（${dshSessionId}）不是渗透控制台创建的，因此没有 engagement 绑定——` +
        'Worker 会话只在控制台「启动 Agent」那一步派生并写库，聊天界面里开的会话不在那条路径上。' +
        '**但你可以把本会话立成 intake**：调用 pentest_bootstrap_intake 建一个作业草稿' +
        '（名字形如「未命名任务 …」），人类在控制台「渗透作业」确认范围后即可启动真正的 Worker。' +
        '另注：读**宿主目录里的普通文件**不需要 engagement（用宿主自带的读工具即可）；' +
        '本插件的读工具面向的是作业记忆、产物与**沙箱内**的挂载目录。' +
        '在此之前请把这件事告诉人类，不要重试、也不要用猜测的范围填补空白。',
    );
  }
  return workerSessionId;
}

async function workerSessionContextOf(
  deps: WorkerToolDeps,
  dshSessionId: string,
): Promise<{ readonly workerSessionId: string; readonly leaseGeneration: number | null }> {
  const resolve = deps.resolveWorkerSessionContext;
  if (resolve !== undefined) {
    const context = await resolve(dshSessionId);
    if (context === null) {
      throw new Error(
        `本会话（${dshSessionId}）不是渗透控制台创建的，因此没有 engagement 绑定；` +
          '先把本会话立成 intake（pentest_bootstrap_intake），' +
          '或从控制台「启动 Agent」创建渗透 Worker 后再试。',
      );
    }
    return context;
  }
  const workerSessionId = await deps.resolveWorkerSessionId(dshSessionId);
  if (workerSessionId === null) {
    throw new Error(`本会话（${dshSessionId}）没有已登记的 Worker 会话绑定`);
  }
  // 仅测试/兼容替身没有原子上下文端口；真实组合始终注入上面的实现。
  return { workerSessionId, leaseGeneration: null };
}


/** 未使用的动作类别引用，保持类型可见性（供后续切片使用）。 */
export type { ActionClass };
