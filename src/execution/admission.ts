/**
 * 受理闸门管线（设计文档 §10.2；2026-10-05 复核 C1 的结构化）。
 *
 * ── 为什么把闸门从 `admit` 里搬出来 ──
 *
 * 此前 `createExecutionService` 里的 `admit` 是一个 ~490 行的函数：闸门的**顺序藏在行号里**
 * ——「模板解析在第 820 行、范围校验在第 941 行、租约在第 978 行」。新增一道闸门意味着在
 * 两千行文件的中段插入代码，而「这道闸门相对其它闸门在哪一步生效」只能靠通读推导；
 * 想单独测一道闸门也没有落点（它和 DB 查询、审计写入缠在一起）。
 *
 * 现在闸门是**具名、有序、只读**的阶段数组：
 *
 *   - 顺序 = {@link ADMISSION_GATES} 的数组顺序（测试直接断言它，见
 *     `test/admission-pipeline.test.ts`）；
 *   - 每道闸门只做「查 + 判」，**不写任何东西**：写审计、建凭证、落库都在管线之外
 *     （`service.ts` 的 `admit` 尾部）——因此闸门可以在没有数据库的情况下逐个测；
 *   - 判定拒绝时把「该记一条什么闸门失败事件」当**数据**返回（`gateFailure`），
 *     由调用方决定怎么写。闸门因此不知道账本、门铃或控制台的存在。
 *
 * ── 类型与顺序的约定（重要）──
 *
 * 闸门把判定所需的事实写进 {@link AdmissionState}（`resolveSpec` / `resolveScope` …），
 * 后续闸门与管线之外的装配阶段通过**非可选访问器**读它们。访问器在事实缺失时抛错——
 * 那表示**闸门顺序被破坏**（编程错误，测试会立刻发现），而不是输入问题：
 * 输入问题一律走 `reject`，绝不抛。
 */

import type {
  ActionClass,
  ActionIntent,
  ErrorCode,
  ExecutionPlan,
  PolicyService,
  ScopeRejectionCode,
  ScopeVerdict,
  SessionLease,
  ToolError,
} from '../contracts.ts';
// 终态会话（closed / superseded / failed）不可执行任何动作。**用契约里的那一份**：
// `workflow/core.ts` 的数据库对账读的是同一个集合，这里若再 filter 一份就会漂移，
// 而漂移的后果是「某种终态会话仍能提交动作」这类静默越权。
import { TERMINAL_SESSION_STATUSES, EXECUTION_MAIN_STATUSES, PURPOSE_MAX_CHARS } from '../contracts.ts';
import { derivePlanHash } from './idempotency.ts';
import { executionGateForAudit } from '../workflow/reconcile.ts';
import { normalizeCidr, rangeAddressesOf } from '../policy/scope.ts';
import {
  portForScope,
  validateParams,
  type ActionTemplateSpec,
  type ParamBag,
  type TemplateRegistry,
} from './templates.ts';
// 只引类型：`SessionBinding` 与闸门失败记录的归属字段由 service.ts 定义，
// 而 service.ts 反过来引本模块的**值**。类型导入在运行期被擦除，不构成循环。
import type { GateFailureRecord, SessionBinding } from './service.ts';

// ───────────────────────────── 错误构造 ─────────────────────────────

/** 拒绝形状的唯一来源：`ToolError` 的 `blocked` 分支（服务内所有拒绝都走它）。 */
export function blocked(
  code: ErrorCode,
  message: string,
  nextAction: string,
  approvalId?: string,
): ToolError {
  return {
    status: 'blocked',
    code,
    message,
    next_action: nextAction,
    ...(approvalId === undefined ? {} : { approval_id: approvalId }),
  };
}

/** 范围判定拒绝码 → 稳定错误码（模型据码分支，不解析文本）。 */
function mapScopeRejection(code: ScopeRejectionCode): ErrorCode {
  switch (code) {
    case 'protocol_undetermined':
      return 'protocol_undetermined';
    case 'dns_unresolved':
    case 'address_not_adjudicated':
      return 'target_not_adjudicated';
    default:
      // 其余形态（malformed_target、userinfo_present、encoded_authority、control_chars、
      // noncanonical_ip、wildcard_illegal、port_not_allowed、
      // protocol_not_allowed、out_of_scope、excluded、pending）都是范围校验失败。
      return 'scope_violation';
  }
}

// ───────────────────────────── 会话级校验（受理与执行前复核共用） ─────────────────────────────

/**
 * engagement 运行标记校验（§5.1、§15.1、§15.2）。
 *
 * **只有 `running` 允许触及目标的动作**。其余四个标记都意味着「现在不该有动作」：
 *
 *   | 标记 | 含义 | 依据 |
 *   |---|---|---|
 *   | `paused` | 人类暂停（或预算耗尽触发的系统暂停） | §5.1 两层状态表 |
 *   | `blocked` | 等人类处置（含恢复对账发现的未知副作用） | §15.2 |
 *   | `aborted` | 人类终止测试 | §5.1 |
 *   | `failed` | engagement 失败 | §5.1 |
 *
 * **为什么必须在执行闸门校验**：运行标记只落库而不拦动作时，`pause` 与恢复
 * 对账的 `blocked` 对目标动作毫无约束力——「人类闸门」就成了装饰。
 *
 * 用词是「停止」而不是「拒绝重试」：模型收到这个码后**不该换个动作继续试**，
 * 而应停下等人类。因此 `next_action` 与其它拒绝不同。
 */
export function engagementViolation(binding: SessionBinding, session: string): ToolError | undefined {
  if (binding.engagementStatus !== 'running') {
    const reason: Readonly<Record<string, string>> = {
      // 不会走到（上面已返回），但保持映射完整：缺项会让将来加标记时静默放行
      running: '',
      // 别把责任推给人类：`paused` 也可能是**系统自动暂停**（预算耗尽，compose 的
      // `pauseForSystem`）。人类看到「人类已暂停」会以为自己点错了什么（2026-10-05 实测报障）。
      paused:
        '该 engagement 已被暂停（人工暂停，或预算耗尽触发的自动暂停）；在控制台「运行控制 → 恢复」后动作才会执行',
      blocked: '该 engagement 处于阻塞状态，等待人类处置（可能是恢复对账发现的未知副作用）',
      aborted: '人类已终止该 engagement',
      failed: '该 engagement 已失败',
    };
    return blocked(
      'engagement_halted',
      `engagement ${binding.engagementId} 不在运行状态（${binding.engagementStatus}）：${reason[binding.engagementStatus] ?? ''}。会话 ${session} 的动作不执行`,
      '不要换个动作重试；等待人类在控制台恢复或结束该 engagement',
    );
  }
  // 主状态的另一半：运行标记只管「暂停/阻塞/终止」，看不见「作业已经收工」。
  // 允许的集合是 `EXECUTION_MAIN_STATUSES`（唯一权威）：`worker_running` 与
  // `waiting_human_review`（人类批准放行后唤醒 Agent 继续干活的那一态）。
  // 其余状态（授权未确认、交接中、已结束技术测试、已签字导出）都不接受目标动作。
  if (!(EXECUTION_MAIN_STATUSES as readonly string[]).includes(binding.mainStatus)) {
    return blocked(
      'engagement_halted',
      `engagement ${binding.engagementId} 的主状态是「${binding.mainStatus}」，不接受接触目标的动作` +
        `（只允许 ${EXECUTION_MAIN_STATUSES.join(' / ')}）。会话 ${session} 的动作不执行`,
      '请人类在控制台的「渗透作业 → 交接编辑」面板里**取消本次交接**（取消后作业回到可工作状态），' +
        '然后重发本条动作；若这是误判，也在这里确认作业状态',
    );
  }
  return undefined;
}

/**
 * 租约校验（§10.6）：会话存在不等于有权提交。
 * `expectedGeneration` 为 null 时只校验有效性，不比对世代（受理路径用 null，
 * 执行前复核用计划里冻结的世代）。
 */
export function leaseViolation(
  binding: SessionBinding,
  expectedGeneration: number | null,
  now: Date,
  session: string,
): ToolError | undefined {
  if (TERMINAL_SESSION_STATUSES.has(binding.status)) {
    return blocked(
      'lease_revoked',
      `会话 ${session} 已处于终态 ${binding.status}，其放行凭证与租约立即失效`,
      '重新申请会话与放行凭证',
    );
  }
  const lease: SessionLease | null = binding.lease;
  if (lease === null) {
    return blocked('lease_required', `会话 ${session} 当前不持有租约`, '由控制台重新签发租约');
  }
  if (lease.revokedAt !== null) {
    return blocked(
      'lease_revoked',
      `会话 ${session} 的租约已被撤销：${lease.revokedReason ?? 'unknown'}`,
      '重新申请会话与租约',
    );
  }
  if (lease.expiresAt.getTime() <= now.getTime()) {
    return blocked(
      'lease_expired',
      `会话 ${session} 的租约已过期（${lease.expiresAt.toISOString()}）`,
      '由控制台续租后重试',
    );
  }
  if (expectedGeneration !== null && lease.generation !== expectedGeneration) {
    return blocked(
      'lease_generation_stale',
      `会话 ${session} 的租约世代已前进（计划 ${expectedGeneration}，当前 ${lease.generation}）`,
      '重新构造计划后再执行',
    );
  }
  return undefined;
}

// ───────────────────────────── 闸门形状 ─────────────────────────────

/** 闸门失败事件的内容（归属字段 engagementId/workerSessionId/rawTarget 由调用方补）。 */
type AdmissionGateFailure = Omit<
  GateFailureRecord,
  'engagementId' | 'workerSessionId' | 'rawTarget'
>;

type GateOutcome =
  | { readonly kind: 'pass' }
  | {
      readonly kind: 'rejected';
      readonly error: ToolError;
      /** 需要记一条闸门失败事件时给出；纯形状校验（参数白名单等）不给。 */
      readonly gateFailure?: AdmissionGateFailure;
    };

/** 闸门形状（受理与执行前复核共用同一套短路语义）。 */
interface Gate<State> {
  /** 具名：审计与测试里用名字指认「是哪一道闸门拒的」。 */
  readonly name: string;
  readonly check: (state: State) => Promise<GateOutcome>;
}

/** 受理闸门：读 {@link AdmissionState}（intent 形态）。 */
type AdmissionGate = Gate<AdmissionState>;

/** 闸门读取依赖的最小端口面（只读）。 */
export interface AdmissionPorts {
  readonly registry: Pick<TemplateRegistry, 'get'>;
  readonly policy: Pick<PolicyService, 'classifyAction' | 'authorizationValidity' | 'evaluateScope'>;
  readonly audit?: { available: () => Promise<{ writable: boolean; detail: string }> };
}

const pass = (): GateOutcome => ({ kind: 'pass' });
const reject = (error: ToolError, gateFailure?: AdmissionGateFailure): GateOutcome =>
  gateFailure === undefined ? { kind: 'rejected', error } : { kind: 'rejected', error, gateFailure };

/**
 * 受理状态：闸门之间传递事实的**唯一**通道。
 *
 * 事实用「解析器 + 非可选访问器」成对暴露：解析器由对应的闸门在通过时调用，
 * 访问器给后续闸门与装配阶段用。访问器缺失时抛错＝闸门顺序被破坏（编程错误），
 * 与「输入不合规」严格区分——后者必须走 `reject` 返回结构化错误。
 */
export class AdmissionState {
  readonly intent: ActionIntent;
  readonly now: Date;
  readonly ports: AdmissionPorts;
  /**
   * 会话绑定的**惰性**读取源（调用方负责记忆化：同一次受理只读一次）。
   *
   * 为什么是惰性而不是提前读：审计闸门（第 0 道）必须在**任何数据库读之前**给出结论——
   * §10.2 的顺序如此，且 §15.1 要的是「根本不受理」。提前读会让「审计不可用」这条路径
   * 先发一次 `worker_sessions` 查询；那次读若抛错（连接池耗尽、语句超时），调用方看到的是
   * 未包装异常，而**不是**结构化的 `audit_unavailable`（2026-10-05 独立评审的实测结论：
   * 探针 A 异常逃逸、探针 B 结构化拒绝）。
   *
   * 「只读一次」由调用方的记忆化保证：闸门失败的记录要以 engagementId 归属
   * （账本是 engagement 级的），而**分类失败发生在会话准入之前**，两处必须共用同一次读。
   */
  readonly bindingSource: () => Promise<SessionBinding | undefined>;
  #binding?: SessionBinding;
  #bindingResolved = false;

  #spec?: ActionTemplateSpec;
  #params?: ParamBag;
  #purpose?: string;
  #actionClass?: ActionClass;
  #scope?: Extract<ScopeVerdict, { ok: true }>;
  #addresses?: readonly string[];

  constructor(input: {
    readonly intent: ActionIntent;
    readonly now: Date;
    readonly bindingSource: () => Promise<SessionBinding | undefined>;
    readonly ports: AdmissionPorts;
  }) {
    this.intent = input.intent;
    this.now = input.now;
    this.bindingSource = input.bindingSource;
    this.ports = input.ports;
  }

  /** 由 `session_bound` 闸门解析绑定（解析前读 `requireBinding()` 会抛错＝顺序被破坏）。 */
  resolveBinding(binding: SessionBinding | undefined): void {
    this.#binding = binding;
    this.#bindingResolved = true;
  }

  resolveSpec(spec: ActionTemplateSpec): void {
    this.#spec = spec;
  }
  resolveParams(params: ParamBag): void {
    this.#params = params;
  }
  resolvePurpose(purpose: string): void {
    this.#purpose = purpose;
  }
  resolveActionClass(actionClass: ActionClass): void {
    this.#actionClass = actionClass;
  }
  resolveScope(scope: Extract<ScopeVerdict, { ok: true }>): void {
    this.#scope = scope;
  }
  resolveAddresses(addresses: readonly string[]): void {
    this.#addresses = addresses;
  }

  /** 已注册模板（闸门 1 之后可用）。 */
  get spec(): ActionTemplateSpec {
    return this.#require(this.#spec, 'spec');
  }
  /** 归一化后的参数（闸门 2 之后可用）。 */
  get params(): ParamBag {
    return this.#require(this.#params, 'params');
  }
  /** 目的说明（闸门 3 之后可用）。 */
  get purpose(): string {
    return this.#require(this.#purpose, 'purpose');
  }
  /** 复算后的动作类别（闸门 4 之后可用）。 */
  get actionClass(): ActionClass {
    return this.#require(this.#actionClass, 'actionClass');
  }
  /** 范围裁决（闸门 7 之后可用）。 */
  get scope(): Extract<ScopeVerdict, { ok: true }> {
    return this.#require(this.#scope, 'scope');
  }
  /** 已裁决地址集合（闸门 11 之后可用，非空）。 */
  get resolvedAddresses(): readonly string[] {
    return this.#require(this.#addresses, 'resolvedAddresses');
  }

  /** 会话绑定（`session_bound` 闸门之后可用；未解析即顺序被破坏）。 */
  requireBinding(): SessionBinding {
    if (!this.#bindingResolved) {
      throw new Error('受理闸门顺序被破坏：binding 尚未解析。顺序见 ADMISSION_GATES。');
    }
    return this.#require(this.#binding, 'binding');
  }

  #require<T>(value: T | undefined, what: string): T {
    if (value === undefined) {
      throw new Error(
        `受理闸门顺序被破坏：${what} 尚未解析。` +
          `每个阶段只解析自己那一项事实，后续阶段才能读它——顺序见 ADMISSION_GATES。`,
      );
    }
    return value;
  }
}

// ───────────────────────────── 闸门（顺序即数组顺序） ─────────────────────────────

/**
 * 0. 审计闸门（§15.1 的硬约束）：审计写不进去时**所有**触及目标的动作一律停止。
 *
 * 放在最前面，而不是靠「写 tool_runs 会失败」间接兜底：那种保护只在**执行之后**
 * 才生效，而这里要的是「根本不受理」。两者的差别是动作会不会真的跑起来。
 *
 * 不看动作类别是有意的：§15.1 明确反对「只停高风险」的降级——分类准确度
 * 不足以支撑那种挑拣。
 */
export const auditGate: AdmissionGate = {
  name: 'audit_available',
  async check(state) {
    const probe = state.ports.audit;
    if (probe === undefined) return pass();
    const gate = executionGateForAudit(await probe.available());
    if (gate.allowed) return pass();
    return reject(
      blocked('audit_unavailable', gate.reason, '恢复审计写入后重新提交；在此之前不要重试'),
    );
  },
};

/** 1. 模板解析：未注册模板一律拒绝，绝不降级。 */
export const templateGate: AdmissionGate = {
  name: 'template_registered',
  async check(state) {
    const spec = state.ports.registry.get(state.intent.templateId);
    if (spec === undefined) {
      return reject(
        blocked(
          'classification_rejected',
          `动作模板 ${state.intent.templateId} 未注册：可执行的动作集合本身是封闭的`,
          '改用已注册模板，或由人类显式注册受信模板后重试',
        ),
        {
          eventType: 'classification.rejected',
          rule: 'template_unregistered',
          detail: `动作模板 ${state.intent.templateId} 未注册`,
          normalized: null,
        },
      );
    }
    state.resolveSpec(spec);
    return pass();
  },
};

/** 2. 参数白名单校验：未声明的参数一律拒绝，声明即必填。 */
export const paramsGate: AdmissionGate = {
  name: 'params_whitelisted',
  async check(state) {
    const validated = validateParams(state.spec.template, state.intent.params, {
      allowFreeForm: state.spec.allowFreeForm === true,
    });
    if (!validated.ok) return reject(validated.error);
    // 用**归一化后**的参数：整数字段可能是以字符串形式到达的（宿主链路会做这种转换），
    // 直接沿用原始输入会让范围判定、命令拼装与计划摘要都按字符串处理。
    state.resolveParams(validated.params);
    return pass();
  },
};

/** 3. 目的必填：动作必须说明为什么执行（审计与放行界面依赖它）。 */
export const purposeGate: AdmissionGate = {
  name: 'purpose_present',
  async check(state) {
    const purpose = state.intent.purpose.trim();
    if (purpose.length === 0 || purpose.length > PURPOSE_MAX_CHARS) {
      // 话术要**区分**"没写"与"太长"并给出实际字数（2026-10-07 实测踩到：写超了却被报"缺少"，
      // 第一反应是"字段没传对"）。上限从 500 提到 4000：`exploit-approval-request` 要求五段
      // （影响面四问 / 停止条件 / 预期证据 / 最小化自查），500 字符装不下 —— 技能与闸门曾经互相打架。
      const detail =
        purpose.length === 0
          ? '目的说明为空：请写清为什么执行这个动作'
          : `目的说明过长：当前 ${String(purpose.length)} 字符，上限 ${String(PURPOSE_MAX_CHARS)}`;
      return reject(
        blocked('classification_rejected', detail, '按提示改写目的说明后重试'),
        {
          eventType: 'classification.rejected',
          rule: 'purpose_invalid',
          detail,
          normalized: null,
        },
      );
    }
    state.resolvePurpose(purpose);
    return pass();
  },
};

/** 4. 动作类别判定与复算：策略给出的类别必须与注册模板一致，漂移即拒绝。 */
export const classificationGate: AdmissionGate = {
  name: 'action_class_recomputed',
  async check(state) {
    const spec = state.spec;
    const classified = await state.ports.policy.classifyAction({
      templateId: state.intent.templateId,
      params: state.params,
    });
    if (!classified.ok) {
      return reject(
        blocked(
          classified.code,
          `动作类别无法确定：${classified.detail}`,
          '改用可归类的已注册模板；无法归类时不降级为低风险放行',
        ),
        {
          eventType: 'classification.rejected',
          rule: classified.code,
          detail: `动作类别无法确定：${classified.detail}`,
          normalized: null,
        },
      );
    }
    if (classified.actionClass !== spec.template.actionClass) {
      const detail =
        `类别复算不一致：模板注册为 ${spec.template.actionClass}，策略判定为 ${classified.actionClass}`;
      return reject(
        blocked('classification_rejected', detail, '检查模板注册与策略配置的一致性，二者不一致时拒绝执行'),
        { eventType: 'classification.rejected', rule: 'classification_mismatch', detail, normalized: null },
      );
    }
    state.resolveActionClass(spec.template.actionClass);
    return pass();
  },
};

/** 5. 会话绑定：范围版本与策略 epoch 来自会话冻结的绑定，而非 Agent 传值。 */
export const bindingGate: AdmissionGate = {
  name: 'session_bound',
  async check(state) {
    // 惰性读取：审计闸门若先拒绝，这次读**根本不会发生**（见 `bindingSource` 的说明）。
    const binding = await state.bindingSource();
    state.resolveBinding(binding);
    if (binding === undefined) {
      return reject(
        blocked(
          'lease_required',
          `会话 ${state.intent.workerSessionId} 没有会话绑定，无法确认其授权`,
          '由控制台创建 Worker 会话并签发租约后再执行',
        ),
      );
    }
    return pass();
  },
};

/**
 * 6. 授权有效期（§11.1 的硬边）：过期即**不受理**。
 *
 * 放在受理路径里而不是只等放行之后：让人类在放行队列中看到一条自己已无权批准的动作，
 * 等于把「授权过期」推给人去兜底。没有授权，就没有「待批准的动作」。
 *
 * 执行前还会再查一次（`policy.validateExecution`）：受理与执行之间可能隔很久
 * （人在队列前停留、命令排队），而授权恰好在那个窗口里到期；那时按旧判断继续执行就是越权。
 * 两处都查不是重复——它们防的是不同的时间点。
 */
export const authorizationGate: AdmissionGate = {
  name: 'authorization_valid',
  async check(state) {
    const binding = state.requireBinding();
    const validity = await state.ports.policy.authorizationValidity(binding.engagementId);
    if (!validity.ok) {
      // 授权依据读不懂（非空但不可解析的到期值）：不等于「未声明到期」，
      // 因此不跳过判定，而是以同一处置拒绝——取得新的授权或修订授权依据。
      return reject(validity.error);
    }
    const expiry = validity.expiresAt;
    if (expiry !== null && expiry.getTime() <= state.now.getTime()) {
      return reject(
        blocked(
          'authorization_expired',
          `授权已于 ${expiry.toISOString()} 过期（§11.1）：不再受理任何触及目标的动作`,
          '取得新的授权或修订授权依据；重新申请放行无法绕过过期的授权',
        ),
      );
    }
    // 到期值只服务本闸门的判定，没有跨阶段消费者——不写进状态（独立评审的 Nit：
    // 此前 `resolveAuthorizationExpiry` + getter 是只写不读的死状态，2026-10-05 删除）。
    return pass();
  },
};

/** 7. 范围校验：协议与端口由模板注册信息决定，Agent 无法在调用里更改。 */
export const scopeGate: AdmissionGate = {
  name: 'scope_adjudicated',
  async check(state) {
    const binding = state.requireBinding();
    const spec = state.spec;
    // **纯本地处理不做范围裁决**（2026-10-08 操作者实测 P0）：它没有目标可裁决——
    // 容器无网（宿主侧 `--network none`），命令只读挂载进来的文件。放它进 `evaluateScope`
    // 只会得到一条没有意义的 `scope_violation`，把"本地解析"记成"越界打目标"。
    if (spec.template.actionClass === 'local_processing') {
      state.resolveAddresses([]);
      return pass();
    }
    const port = portForScope(spec, state.params);
    // **范围批次**（`allowTargetRange`）：选择器可以是一个网段 ⇒ **逐地址裁决**，
    // 一台越界就**整条拒绝**——授权一点没放宽，只是把"283 次单台"收成一次动作
    // （2026-10-08 操作者实测：全段普查被拆成逐 IP，扫描预算大头花在这里）。
    if (spec.allowTargetRange === true && state.intent.targetSelector.includes('/')) {
      const cidr = normalizeCidr(state.intent.targetSelector);
      if (!cidr.ok) {
        return reject(
          blocked(
            'classification_rejected',
            `批次选择器不是合法网段：${cidr.detail}`,
            '用 IPv4 网段字面量（例如 10.25.0.0/20）；单台目标照旧直接写地址',
          ),
        );
      }
      const expanded = rangeAddressesOf(cidr.value);
      if (!expanded.ok) {
        return reject(
          blocked('classification_rejected', expanded.detail, '把网段拆小（例如 /20）分几次跑，别指望一次扫完 /16'),
        );
      }
      for (const address of expanded.value) {
        const one = await state.ports.policy.evaluateScope({
          engagementId: binding.engagementId,
          scopeVersion: binding.scopeVersion,
          target: address,
          protocol: spec.protocol,
          ...(port === undefined ? {} : { port }),
        });
        if (!one.ok) {
          return reject(
            blocked(
              mapScopeRejection(one.code),
              `批次里的 ${address} 未被裁决为在范围内（${one.code}）：${one.detail}`,
              '批次里任何一台越界都会整条拒绝：缩小网段，或先修订范围',
            ),
            {
              eventType: 'scope.violation',
              rule: one.code,
              detail: one.detail,
              normalized: one.normalized ?? null,
            },
          );
        }
      }
      // 裁决通过的**全部**地址（执行侧只打这份集合；分发器拿到的是裁决后的地址）。
      state.resolveAddresses(expanded.value);
      return pass();
    }
    const scope = await state.ports.policy.evaluateScope({
      engagementId: binding.engagementId,
      scopeVersion: binding.scopeVersion,
      target: state.intent.targetSelector,
      protocol: spec.protocol,
      ...(port === undefined ? {} : { port }),
    });
    if (!scope.ok) {
      // §10.2.2：任何范围校验失败都记录 `scope_violation` 事件（含原始目标、规范化结果、
      // 命中的规则、发起会话）；同一会话连续三次时自动暂停——**这通常意味着任务描述
      // 有歧义，而不是偶发失误**，所以处置是交人类而不是让它重试。
      return reject(
        blocked(
          mapScopeRejection(scope.code),
          `目标未被裁决为在范围内（${scope.code}）：${scope.detail}`,
          '改用当前范围版本内的目标；范围违规会记录 scope_violation 事件',
        ),
        {
          eventType: 'scope.violation',
          rule: scope.code,
          detail: scope.detail,
          normalized: scope.normalized ?? null,
        },
      );
    }
    state.resolveScope(scope);
    return pass();
  },
};

/**
 * 8. 会话准入（一）：engagement 运行标记。
 *
 * 顺序是刻意的：engagement 已停时，租约是否有效已不是重点——此时应当告诉
 * 调用方「整个 engagement 停了」，而不是「你缺租约」。后者的下一动作是
 * 去续租，而续租在这个状态下毫无意义。
 */
export const engagementHaltGate: AdmissionGate = {
  name: 'engagement_running',
  async check(state) {
    const violation = engagementViolation(state.requireBinding(), state.intent.workerSessionId);
    return violation === undefined ? pass() : reject(violation);
  },
};

/** 9. 会话准入（二）：租约（§10.6）。受理路径只校验有效性，不比对世代。 */
export const leaseGate: AdmissionGate = {
  name: 'lease_valid',
  async check(state) {
    const violation = leaseViolation(
      state.requireBinding(),
      null,
      state.now,
      state.intent.workerSessionId,
    );
    return violation === undefined ? pass() : reject(violation);
  },
};

/**
 * 10. 已裁决地址集合：执行计划的受信上下文。
 *
 * 域名没有范围裁决地址时绝不退化为容器内 DNS——那正是 DNS 重绑定的窗口。
 */
export const adjudicatedAddressesGate: AdmissionGate = {
  name: 'addresses_adjudicated',
  async check(state) {
    // 本地处理没有目标 ⇒ 没有已裁决地址集合，也**不需要**（容器无网）。上面那道闸门已经
    // 显式 resolve 成空集合，这里直接放过，不再去读 `state.scope`。
    if (state.spec.template.actionClass === 'local_processing') return pass();
    const normalized = state.scope.normalized;
    const addresses =
      normalized.resolvedAddresses ?? (normalized.kind === 'ip' ? [normalized.host] : []);
    if (addresses.length === 0) {
      return reject(
        blocked(
          'target_not_adjudicated',
          `目标 ${normalized.host} 没有已裁决地址集合，拒绝按域名拨号`,
          '让范围服务提供已裁决地址后重新提交',
        ),
        {
          eventType: 'scope.violation',
          rule: 'dns_unresolved',
          detail: `目标 ${normalized.host} 没有已裁决地址集合，拒绝构造执行计划`,
          normalized,
        },
      );
    }
    state.resolveAddresses(addresses);
    return pass();
  },
};

/** 闸门顺序（§10.2）。新增闸门 = 在这里加一项，并在测试里断言它出现的位置。 */
export const ADMISSION_GATES: readonly AdmissionGate[] = [
  auditGate,
  templateGate,
  paramsGate,
  purposeGate,
  classificationGate,
  bindingGate,
  authorizationGate,
  scopeGate,
  engagementHaltGate,
  leaseGate,
  adjudicatedAddressesGate,
];

/** 具名顺序表（测试与运维诊断用）。 */
export const ADMISSION_GATE_ORDER: readonly string[] = ADMISSION_GATES.map((gate) => gate.name);

type PipelineVerdict =
  | { readonly kind: 'passed' }
  | {
      readonly kind: 'rejected';
      /** 做出这一结论的闸门名（诊断与测试指认点）。 */
      readonly gate: string;
      readonly error: ToolError;
      readonly gateFailure?: AdmissionGateFailure;
    };

/**
 * 按顺序跑闸门：**第一个非 pass 的结论胜出**，后面的闸门不再执行。
 *
 * 短路是语义的一部分，不是优化：闸门顺序承载 §10.2 的优先级
 * （例如「模板未注册」必须先于「缺租约」报出），因此不允许「全部跑一遍再挑一个」。
 *
 * 受理与执行前复核共用这一个运行器——两处的短路语义必须是同一套，否则
 * 「先报哪个拒绝」会在两条路径上分叉，而拒绝码的顺序本身就是验收判据。
 */
async function runGates<State>(
  state: State,
  gates: readonly Gate<State>[],
): Promise<PipelineVerdict> {
  for (const gate of gates) {
    const outcome = await gate.check(state);
    if (outcome.kind === 'rejected') {
      return outcome.gateFailure === undefined
        ? { kind: 'rejected', gate: gate.name, error: outcome.error }
        : { kind: 'rejected', gate: gate.name, error: outcome.error, gateFailure: outcome.gateFailure };
    }
  }
  return { kind: 'passed' };
}

/** 受理管线（intent 形态）。 */
export function runAdmissionGates(
  state: AdmissionState,
  gates: readonly AdmissionGate[] = ADMISSION_GATES,
): Promise<PipelineVerdict> {
  return runGates(state, gates);
}

// ───────────────────────────── 执行前复核（plan 形态） ─────────────────────────────

/**
 * 执行前复核的端口面（只读）。
 *
 * 为什么单独一组闸门而不是复用受理那组：受理读的是**意图**（`ActionIntent`：模板 + 参数 +
 * 目标选择器），复核读的是**计划**（`ExecutionPlan`：已归一化的命令、摘要、冻结的版本号）。
 * 两者的判据形状不同——把意图形态的端口硬塞进计划形态的上下文里，只会让每道闸门都
 * 多一层「计划里没有这个字段」的分支。
 *
 * 两处**共用**的是：短路语义（{@link runGates}）、会话级校验
 * （{@link engagementViolation} / {@link leaseViolation}，同一份实现）、拒绝码与措辞风格
 * （复核路径的错误消息统一以「执行前复核失败：」开头，便于与受理路径区分）。
 */
export interface RevalidationPorts {
  readonly registry: Pick<TemplateRegistry, 'get'>;
  readonly policy: Pick<PolicyService, 'validateExecution'>;
  readonly sessions: { binding(workerSessionId: string): Promise<SessionBinding | undefined> };
}

/** 执行前复核的状态（plan 形态）。 */
export class RevalidationState {
  readonly plan: ExecutionPlan;
  readonly now: Date;
  readonly ports: RevalidationPorts;

  #binding?: SessionBinding;
  #bindingResolved = false;

  constructor(input: {
    readonly plan: ExecutionPlan;
    readonly now: Date;
    readonly ports: RevalidationPorts;
  }) {
    this.plan = input.plan;
    this.now = input.now;
    this.ports = input.ports;
  }

  /** 会话绑定**可能真的不存在**（这是拒绝路径之一），因此需要「已解析」标记。 */
  resolveBinding(binding: SessionBinding | undefined): void {
    this.#binding = binding;
    this.#bindingResolved = true;
  }

  /** 已解析的绑定（可能为 undefined）。 */
  get bindingOrUndefined(): SessionBinding | undefined {
    if (!this.#bindingResolved) {
      throw new Error('执行前复核闸门顺序被破坏：binding 尚未解析。顺序见 REVALIDATION_GATES。');
    }
    return this.#binding;
  }

  /** 存在的绑定（`plan_session_bound` 之后可用）。 */
  get binding(): SessionBinding {
    const binding = this.bindingOrUndefined;
    if (binding === undefined) {
      throw new Error('执行前复核闸门顺序被破坏：会话绑定不存在，后续闸门不得读取它。');
    }
    return binding;
  }
}

/** 复核闸门（plan 形态）。 */
type RevalidationGate = Gate<RevalidationState>;

/**
 * 1. 模板仍在注册表中。
 *
 * 受理与执行之间可能隔很久（人类在放行队列前停留、命令排队），而注册表由人工维护——
 * 模板被撤下之后，那份已批准的计划不该再执行。
 */
export const planTemplateGate: RevalidationGate = {
  name: 'plan_template_registered',
  async check(state) {
    if (state.ports.registry.get(state.plan.templateId) !== undefined) return pass();
    return reject(
      blocked(
        'classification_rejected',
        `执行前复核失败：动作模板 ${state.plan.templateId} 已不在注册表中`,
        '重新构造计划',
      ),
    );
  },
};

/**
 * 2. 计划摘要仍然成立（计划没被改动过）。
 *
 * 复核必须使用计划里**携带的**策略元数据（缺失即视为无策略版本/无 pacing），
 * 而不是重新读一遍会话策略：复核对的是「人类批准的那份计划有没有被动过」。
 */
export const planHashGate: RevalidationGate = {
  name: 'plan_hash_intact',
  async check(state) {
    const plan = state.plan;
    const recomputed = derivePlanHash({
      ...plan,
      policyVersion: plan.policyVersion ?? null,
      pacing: plan.pacing ?? null,
    });
    if (recomputed === plan.planHash) return pass();
    return reject(
      blocked(
        'stale_state_version',
        '执行前复核失败：计划内容与计划摘要不一致（计划被改动）',
        '重新走 admit 生成计划',
      ),
    );
  },
};

/** 3. 策略复核：授权有效期、策略 epoch、范围版本等由策略服务在**执行时刻**再看一遍。 */
export const planPolicyGate: RevalidationGate = {
  name: 'plan_policy_valid',
  async check(state) {
    const verdict = await state.ports.policy.validateExecution(state.plan);
    return verdict.ok ? pass() : reject(verdict.error);
  },
};

/** 4. 会话绑定存在（复核路径逐项取，因此这里也自己读一次）。 */
export const planSessionGate: RevalidationGate = {
  name: 'plan_session_bound',
  async check(state) {
    const binding = await state.ports.sessions.binding(state.plan.workerSessionId);
    state.resolveBinding(binding);
    if (binding !== undefined) return pass();
    return reject(
      blocked(
        'lease_required',
        `执行前复核失败：会话 ${state.plan.workerSessionId} 没有会话绑定`,
        '重新申请会话与放行凭证',
      ),
    );
  },
};

/** 5. engagement 仍在运行（停机时租约是否有效不是重点——先报「整个作业停了」）。 */
const planEngagementGate: RevalidationGate = {
  name: 'plan_engagement_running',
  async check(state) {
    const violation = engagementViolation(state.binding, state.plan.workerSessionId);
    return violation === undefined ? pass() : reject(violation);
  },
};

/** 6. 租约有效且世代未前进（计划里冻结的世代是判据）。 */
const planLeaseGate: RevalidationGate = {
  name: 'plan_lease_valid',
  async check(state) {
    const violation = leaseViolation(
      state.binding,
      state.plan.leaseGeneration,
      state.now,
      state.plan.workerSessionId,
    );
    return violation === undefined ? pass() : reject(violation);
  },
};

/** 7. 范围版本未变化：范围修订后旧凭证与旧计划失效。 */
const planScopeVersionGate: RevalidationGate = {
  name: 'plan_scope_version_current',
  async check(state) {
    const current = state.binding.scopeVersion;
    if (current === state.plan.scopeVersion) return pass();
    return reject(
      blocked(
        'stale_state_version',
        `执行前复核失败：会话绑定的范围版本已变化（计划 ${state.plan.scopeVersion}，当前 ${current}）`,
        '范围修订后旧凭证与旧计划失效，重新申请放行',
      ),
    );
  },
};

/** 8. 策略 epoch 未前进：策略或范围变更后在途动作必须停止。 */
const planPolicyEpochGate: RevalidationGate = {
  name: 'plan_policy_epoch_current',
  async check(state) {
    const current = state.binding.policyEpoch;
    if (current === state.plan.policyEpoch) return pass();
    return reject(
      blocked(
        'stale_state_version',
        `执行前复核失败：策略 epoch 已前进（计划 ${state.plan.policyEpoch}，当前 ${current}）`,
        '策略或范围变更后在途动作必须停止，重新申请放行',
      ),
    );
  },
};

/**
 * 执行前复核的闸门顺序（§10.3.1）。
 *
 * 顺序承载**诊断价值**：先答「模板还在吗」「计划被改过吗」（形状问题，重构造即可），
 * 再答「策略还允许吗」「会话/租约还在吗」（时序问题，要重新申请放行）。
 */
export const REVALIDATION_GATES: readonly RevalidationGate[] = [
  planTemplateGate,
  planHashGate,
  planPolicyGate,
  planSessionGate,
  planEngagementGate,
  planLeaseGate,
  planScopeVersionGate,
  planPolicyEpochGate,
];

/** 具名顺序表（测试与运维诊断用）。 */
export const REVALIDATION_GATE_ORDER: readonly string[] = REVALIDATION_GATES.map((gate) => gate.name);

/** 执行前复核管线。 */
export function runRevalidationGates(
  state: RevalidationState,
  gates: readonly RevalidationGate[] = REVALIDATION_GATES,
): Promise<PipelineVerdict> {
  return runGates(state, gates);
}
