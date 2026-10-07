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
} from '../contracts.ts';
import { DEFAULTS } from '../contracts.ts';
import { PHASE_ORDER } from '../workflow/phases.ts';
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
export interface WorkerToolDeps {
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
  }): Promise<{ reportId: string; stateVersion: number }>;
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
    list(input: { readonly path: string }): Promise<WorkdirListing>;
    read(input: { readonly path: string }): Promise<WorkdirFile>;
    write(input: { readonly path: string; readonly content: string }): Promise<WorkdirWriteResult>;
    /** 在挂载根内递归检索（正则）。200+ 份归档文档里考古靠它，避免整文件读烧上下文。 */
    search(input: { readonly path: string; readonly pattern: string }): Promise<WorkdirSearchResult>;
    /** 追加写：给已写的报告补一行不必整文件重发。 */
    append(input: { readonly path: string; readonly content: string }): Promise<WorkdirWriteResult>;
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

/** 构造全部 Worker 工具定义。 */
export function createWorkerTools(deps: WorkerToolDeps) {
  const memorySearch = defineTool({
    name: 'memory_search',
    description:
      '检索本 engagement 的记忆（混合检索：语义近邻 + 全文 + 三元组）。' +
      '返回带来源与可信度标注的片段。检索范围受当前范围版本约束：' +
      '未纳入范围的资产内容不会返回。思考链默认参与检索。',
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
      return toJson(await deps.search({
        workerSessionId,
        query: args.query,
        phase: args.phase,
        kinds: args.kinds,
        trustLevels: args.trust_levels,
        assetIds: args.asset_ids,
        includeReasoning: args.include_reasoning,
        limit: args.limit ?? 8,
      }));
    },
  });

  const memoryRead = defineTool({
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
      return toJson(await deps.read({ workerSessionId: await workerSessionIdOf(deps, exec), refs: args.refs }));
    },
  });

  const artifactRead = defineTool({
    name: 'artifact_read',
    description: '读取一条证据的元数据与（已授权的）内容。二进制证据只返回元数据与引用。',
    parameters: {
      artifact_id: { type: 'string', required: true, description: '证据标识' },
    },
    output: { schema: { type: 'json' }, render: (_a, v) => renderJson(_a, v) },
    async execute(args, exec) {
      return toJson(await deps.readArtifact({ workerSessionId: await workerSessionIdOf(deps, exec), artifactId: args.artifact_id }));
    },
  });

  const bootstrapIntakeTool = defineTool({
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
      return toJson(await deps.bootstrapIntake({
        dshSessionId: dshSessionIdOf(exec),
        ...(args.name === undefined ? {} : { name: args.name }),
      }));
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
        description: '证据引用：memory:<uuid> / artifact:<uuid> / tool_run:<uuid>（有就直接引用，别复述）',
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

  const submitReport = defineTool({
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
      objective: { type: 'string', required: true, description: '本次任务目标（不可变快照）' },
      summary: { type: 'string', required: true, description: '面向人的简短总结' },
      status_note: {
        type: 'string',
        description: `可选短状态便签（≤${DEFAULTS.statusNoteMaxChars} 字符），供控制台列表扫描`,
      },
      payload: {
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
          schema_version: { type: 'integer', description: '报告 schema 版本（设计 §7.1 示例为 1）' },
          status: { type: 'string', enum: ['report_ready', 'blocked'], description: '与入参 status 同义；整份照抄设计示例时会出现' },
          objective: { type: 'string', description: '与入参 objective 同义' },
          summary: { type: 'string', description: '与入参 summary 同义' },
          status_note: { type: 'string', description: '与入参 status_note 同义（≤200 字符）' },
          completed: { type: 'array', items: { type: 'string' }, description: '已完成事项清单' },
          revision: { type: 'integer', description: '报告版本号（派生对象版本化管理，§7.1）' },
          finished_at: { type: 'string', description: '完成时间（ISO 字符串）' },
          // 归属字段：设计 §7.1 的示例里有，**只接收不采信**——真实归属由服务端从执行身份推导
          // （§4.2：不信任模型传入的会话标识）。列出来是为了让「照抄设计示例」能通过校验。
          engagement_id: { type: 'string', description: '仅接收；归属由服务端推导，不必填也不被采信' },
          agent_session_id: { type: 'string', description: '仅接收；同上，服务端不采信入参' },
          phase: { type: 'string', enum: [...PHASE_ORDER], description: '仅接收；阶段由会话决定，不必填' },
        },
      },
    },
    output: { schema: { type: 'json' }, render: (_a, v) => renderJson(_a, v) },
    async execute(args, exec) {
      const dshSessionId = dshSessionIdOf(exec);
      const session = await workerSessionContextOf(deps, dshSessionId);
      const note = args.status_note;
      return toJson(await deps.submitReport({
        workerSessionId: session.workerSessionId,
        leaseGeneration: session.leaseGeneration,
        report: {
          status: args.status,
          objective: args.objective,
          summary: args.summary,
          ...(note === undefined ? {} : { statusNote: note.slice(0, DEFAULTS.statusNoteMaxChars) }),
          payload: args.payload ?? {},
        },
      }));
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
  const requestScopeConfirmation = defineTool({
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
      // **工具结果是模型上下文**：把留痕字段从回显里摘掉。
      // 模型只要在回显里看见字段名，就会在回复里谈起它（实测：它会复述
      // 「本部署不要求授权凭据 / 授权说明留空即可」这类元话术）。人类侧的方案卡片
      // 读的是库里的行，不依赖这个回显。
      const { authorizationNote: _recordOnly, ...visible } = proposal as { authorizationNote?: unknown };
      return toJson(visible);
    },
  });


  const writeStatusNote = defineTool({
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

  const requestApproval = defineTool({
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
      '**沙箱可出网**（可达范围与宿主一致，DNS 用宿主的解析器）：公网目标与在线资料都够得着，' +
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
      return toJson(await deps.requestApproval({
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
      }));
    },
  });

  const prepareHandoff = defineTool({
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

  const pentestExec = defineTool({
    name: 'pentest_exec',
    description:
      '**在沙箱里跑一条命令**（唯一的目标接触通道）。' +
      'command 是你在沙箱内执行的整条命令原文（bash 语法，`bash -c` 执行——不是 dash）；' +
      '镜像里有 nmap / curl / wget / nc / dig / openssl / jq / whois / ping / ffuf / sqlmap ' +
      '与 python3（含 requests/dnspython/beautifulsoup4）、字典在 /usr/share/wordlists 下。' +
      '沙箱直连目标（不经代理）、有 NET_RAW、容器内为 root；**可出网**（可达范围与宿主一致，' +
      'DNS 用宿主解析器）——可达不等于授权，只对已授权目标动作。' +
      'target_selector 声明这条命令打的是哪个已授权目标（只能来自选择器，不接受命令里的目标字面量）；' +
      'port 是它主要针对的端口，用于范围闸门记账。' +
      '放行取决于作业的审批模式：人工审批模式逐条人批；高权限模式对预设内的命令自行放行' +
      '（申请返回 selfApproved=true 即可直接执行）。**不要因为能自行放行就去扩大范围或提权**——' +
      '超出预设、默认禁用类别（persistence/destructive/exfiltration）仍然会转给人类。',
    parameters: {
      command: { type: 'string', required: true, description: '在沙箱内执行的命令原文（shell 语法）' },
      port: { type: 'integer', required: true, description: '这条命令主要针对的端口（范围闸门据此记账）' },
      target_selector: { type: 'string', required: true, description: '目标选择器（已授权范围内的目标）' },
      purpose: { type: 'string', required: true, description: '目的：为什么执行它、预期看到什么' },
      approval_id: {
        type: 'string',
        description: '需要放行的动作必须携带人类放行后返回的 approval_id',
      },
    },
    output: { schema: { type: 'json' }, render: (_a, v) => renderJson(_a, v) },
    timeoutMs: 15 * 60 * 1000,
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      const workerSessionId = await workerSessionIdOf(deps, exec);
      // 命令以 base64 传输：宿主拼出的是一条**单个 argv 字符串**并按空格切分，
      // 裸命令会被切散。编码在这里做（工具侧），所以 Agent 只管写命令原文。
      const intent: ActionIntent = {
        workerSessionId,
        templateId: 'direct_command',
        targetSelector: args.target_selector,
        purpose: args.purpose,
        params: {
          port: args.port,
          command_b64: Buffer.from(args.command, 'utf8').toString('base64'),
        },
        ...(args.approval_id === undefined ? {} : { approvalId: args.approval_id }),
      };
      const outcome = await deps.execute({ workerSessionId, intent, signal: exec.signal });
      // 拒绝路径把契约错误直接交给模型（与 memory_read 的拒绝形状一致），
      // 不包在 {plan,result} 里——那会让「被拒绝」看起来像「执行完了」。
      return toJson(outcome.kind === 'blocked' ? outcome.error : { plan: outcome.plan, result: outcome.result });
    },
  });

  const pentestRecon = defineTool({
    name: 'pentest_recon',
    description:
      '**结构化侦察动作**（唯一入口是它，而不是让你手写 nmap/ffuf 命令）。' +
      '每个 technique 由服务端固定一条命令形态，参数只有声明过的枚举/整数——' +
      '目标从选择器注入、地址由宿主的裁决结果固定（容器不做 DNS），' +
      '因此同一动作的审计与幂等键是可复现的，也不需要人类为每条扫描命令逐次放行：' +
      '侦察类动作按 `active_probing`/`passive_collection` 记账，由范围、租约、节奏（stealth 1rps / standard 5rps / deep 10rps）约束；' +
      '需要人批的是 `exploit_validation` 类动作（用 pentest_exec）。' +
      '**DNS 类 technique（dns_enum/dns_brute）走 UDP**：范围条目要声明 udp，否则会被范围闸门拒绝。' +
      '先扫面（port_scan）再指纹（service_probe/tls_inspect/http_probe），最后才目录与爬取——顺序写进了 recon-network-surface/recon-web-surface 两份 skill。',
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
      ping: { type: 'string', enum: ['syn', 'connect', 'skip'], description: 'port_scan 的存活判定方式' },
      intensity: { type: 'string', enum: ['light', 'normal'], description: 'service_probe 的指纹强度' },
      scripts: { type: 'string', description: 'nse_safe 的只读脚本名（逗号分隔，白名单由沙箱强制）' },
      sni: { type: 'string', description: 'tls_inspect 的 SNI；none 表示用目标名' },
      enumerate_protocols: { type: 'string', enum: ['on', 'off'], description: 'tls_inspect 是否枚举协议版本与套件' },
      scheme: { type: 'string', enum: ['http', 'https', 'auto'], description: 'http_probe 的协议（content_discover/web_crawl 只接受 http/https）' },
      follow_redirects: { type: 'integer', description: 'http_probe 的跳转上限（0-3；跨主机跳转一律拒绝）' },
      collect: {
        type: 'string',
        enum: ['headers', 'security_headers', 'robots', 'sitemap', 'tech'],
        description: 'http_probe 的采集面',
      },
      verify_tls: {
        type: 'string',
        enum: ['true', 'false'],
        description:
          'http_probe/http_get 是否校验 TLS 证书，**默认 true**；自签/纯 IP 目标必须显式 false 才连得上（那次结果不再证明证书链可信，报告里会写明未校验）',
      },
      wordlist: { type: 'string', enum: ['common_dirs', 'raft_small', 'subdomains_5k'], description: '字典档位' },
      extensions: {
        type: 'string',
        enum: ['none', 'php', 'asp', 'aspx', 'jsp', 'html', 'txt', 'json', 'multi'],
        description: 'content_discover 追加的扩展名',
      },
      rate: { type: 'integer', description: 'content_discover 的每秒请求数上限（1-20）' },
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
        ...(args.intensity === undefined ? {} : { intensity: args.intensity }),
        ...(args.scripts === undefined ? {} : { scripts: args.scripts }),
        ...(args.sni === undefined ? {} : { sni: args.sni }),
        ...(args.enumerate_protocols === undefined ? {} : { enumerate_protocols: args.enumerate_protocols }),
        ...(args.scheme === undefined ? {} : { scheme: args.scheme }),
        ...(args.follow_redirects === undefined ? {} : { followRedirects: args.follow_redirects }),
        ...(args.collect === undefined ? {} : { collect: args.collect }),
        ...(args.wordlist === undefined ? {} : { wordlist: args.wordlist }),
        ...(args.extensions === undefined ? {} : { extensions: args.extensions }),
        ...(args.rate === undefined ? {} : { rate: args.rate }),
        ...(args.depth === undefined ? {} : { depth: args.depth }),
        ...(args.max_pages === undefined ? {} : { maxPages: args.max_pages }),
        ...(args.record_types === undefined ? {} : { recordTypes: args.record_types }),
        ...(args.resolver === undefined ? {} : { resolver: args.resolver }),
        ...(args.concurrency === undefined ? {} : { concurrency: args.concurrency }),
        ...(args.wildcard_check === undefined ? {} : { wildcardCheck: args.wildcard_check }),
        ...(args.kind === undefined ? {} : { kind: args.kind }),
        ...(args.include_wildcards === undefined ? {} : { includeWildcards: args.include_wildcards }),
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
      return toJson(outcome.kind === 'blocked' ? outcome.error : { plan: outcome.plan, result: outcome.result });
    },
  });

  const pentestScan = defineTool({
    name: 'pentest_scan',
    description:
      '**结构化核验动作**（漏洞分析阶段的只读面）：把一条候选变成「成立 / 不成立 / 需要更多证据」。' +
      '每个 technique 由服务端固定命令形态、只打已裁决地址，类别是 `active_probing`——' +
      '**不需要逐条人工放行**；它只发读取类请求、不写目标、不下载内容' +
      '（配置面暴露只报存在性、长度、哈希与形态判定）。' +
      '判据写进对应的 skill：一条候选没有可判定的判据就不要核验，先补情报。' +
      '需要发载荷（SQLi/XSS/SSRF/上传…）的验证**不属于本工具**：那是利用验证阶段的 `poc_run`/`pentest_exec`，逐条人批。',
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
      return toJson(outcome.kind === 'blocked' ? outcome.error : { plan: outcome.plan, result: outcome.result });
    },
  });

  const skillLoad = defineTool({
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
      return toJson(result.skill);
    },
  });

  /**
   * 作业目录的读写（`sandbox.mounts` 声明的宿主目录）。
   *
   * 存在的理由是一个自锁：沙箱命令**每条**都要声明已授权目标，于是空范围作业
   * （范围版本 0）里连 `ls /work` 都跑不了——「读你自己的作业资料」与目标无关，
   * 却被目标闸门挡住。本工具不接触任何目标，只用一条路径约束（必须落在挂载根内）。
   */
  const workdirTool = defineTool({
    name: 'pentest_workdir',
    description:
      '**读写人类挂进沙箱的作业目录**（profile 里 `sandbox.mounts` 声明的宿主目录；容器内路径也在返回值里给出）。' +
      '**它不经过范围闸门**：空范围作业（范围版本 0）里 `pentest_exec` 会被 out_of_scope 拒绝，' +
      '而本工具照常可用——读作业资料（资产清单、既有报告、目标说明、人类放进去的任何文件）就该用它。' +
      `op：\`list\` 列目录、\`read\` 读文本（超 ${Math.round(WORKDIR_READ_LIMIT_BYTES / 1024)}KiB 会截断并标注）、` +
      '`write` 写文本文件（会建父目录）、`search` 在目录内**递归检索正则**（返回文件/行号/该行，' +
      '适合在大量归档文档里定位——比整文件读省上下文）、`append` 追加到文件末尾（补一行不必重发整份）。' +
      'path 是**相对挂载根**的路径，例如 `1-未打点资产与暴露面/清单.md`；也接受容器路径写法（`/work/...`）；' +
      '空路径或 `.` 就是挂载根本身。' +
      '不接受绝对宿主路径、不允许 `..` 跳出根、符号链接指向根外会被拒绝。' +
      '它**不产生证据账本条目**：读到的东西要形成结论，照常写进报告/证据（`pentest_submit_report`）。',
    parameters: {
      op: { type: 'string', required: true, description: 'list | read | write' },
      path: { type: 'string', required: true, description: '相对挂载根的路径（空或 `.` 就是根；目录用于 list/search）' },
      content: { type: 'string', description: 'op=write / op=append 时的正文' },
      pattern: { type: 'string', description: 'op=search 时的正则（JS 语法，u 标志）' },
    },
    output: { schema: { type: 'json' }, render: (_a, v) => renderJson(_a, v) },
    async execute(args, exec) {
      // 与其余 Worker 工具同口径：先确认调用方是本项目登记的会话（拿不到就报错）。
      await workerSessionIdOf(deps, exec);
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
        if (op === 'list') return toJson(await access.list({ path: args.path }));
        if (op === 'read') return toJson(await access.read({ path: args.path }));
        if (op === 'search') {
          if (args.pattern === undefined) {
            return toJson(asError({
              status: 'blocked',
              code: 'classification_rejected',
              message: 'op=search 必须给出 pattern（正则）',
              next_action: '补上 pattern 再调用；pattern 是 JS 正则，可在大量文档里定位文件与行号',
            }));
          }
          return toJson(await access.search({ path: args.path, pattern: args.pattern }));
        }
        if (args.content === undefined) {
          return toJson(asError({
            status: 'blocked',
            code: 'classification_rejected',
            message: `op=${op} 必须给出 content`,
            next_action: '补上 content 再调用',
          }));
        }
        if (op === 'append') return toJson(await access.append({ path: args.path, content: args.content }));
        return toJson(await access.write({ path: args.path, content: args.content }));
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
                  : '只用相对挂载根的路径；越界路径不会被接受',
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
 * 原样转述给人类。此前只说「未登记为 worker 会话」，于是人和模型都会去做一件做不到的事：
 * 试图给这个会话补一个绑定。
 *
 * 事实上**补不了**：worker 会话由控制台的 `startWorker` 创建，会话标识在那时按
 * `dsh-<workerSessionId>` 派生并写库。一个在聊天界面里开的会话（`session-…`）没有、
 * 也不可能有这条记录——这不是权限没给够，是身份模型如此。
 *
 * 所以错误文本必须把「为什么不可能」和「该去哪儿」一次讲清，否则这个死角每被撞一次
 * 就要重查一遍。
 */
async function workerSessionIdOf(deps: WorkerToolDeps, exec: { agent?: unknown }): Promise<string> {
  const dshSessionId = dshSessionIdOf(exec);
  const workerSessionId = await deps.resolveWorkerSessionId(dshSessionId);
  if (workerSessionId === null) {
    throw new Error(
      `本会话（${dshSessionId}）不是渗透控制台创建的，因此没有 engagement 绑定；` +
        '而且它**无法**事后补上：worker 会话只由控制台的「启动 Agent」创建，' +
        '会话标识在那时按 dsh-<workerSessionId> 派生并写库，聊天界面里开的会话不在那条路径上。' +
        '要开始一轮作业：打开控制台（左侧栏「渗透作业」）→ 建/选 engagement → 在「运行控制」里启动 Agent。' +
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
          '而且它无法事后补上：请从控制台「启动 Agent」创建渗透 Worker 后再提交报告。',
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
