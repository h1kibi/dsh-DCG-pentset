/**
 * 控制台 RPC 层：把**人类专属操作**暴露为可被 Web UI 调用的端点（设计文档 §6、§16.1）。
 *
 * ── 为什么这一层是宿主无关的（§21.0 的同一条纪律：先验证宿主契约，再落笔）──
 *
 * dsh 0.1.5-rc.2 实测结论（`node_modules/.pnpm/@deepseek-ai+dsh-api-*`）：
 *
 * 1. **RPC 语义面（Typert Remote）可用，且是当前采用的路径**。
 *    官方的人类操作面（如 `@deepseek-ai/dsh-api-session-controller` 的 `SessionController`）
 *    继承 `TypertRemoteService`（`@deepseek-ai/dsh-typert-protocol`），端点有两种登记方式：
 *    - **严格模式**：`@deepseek-ai/dsh-typert-generator` 从 FaceModel 编译期生成描述符。
 *      该生成器绑死 harness 式 workspace（要求根有 `tsconfig.host.json`），对独立仓库不友好。
 *    - **SRC 模式**：Service 的公开方法挂标准 ES `@Remote` 装饰器，由 Gateway 的
 *      `resolveSrcDescriptor` 在运行期读函数源码解析出参数名。**零 codegen**。
 *
 *    〔修正记录〕本注释曾断言「两条路都够不着」，并给了两条**实测为假**的理由：
 *      · 「`erasableSyntaxOnly: true` 禁止装饰器」——实测通过：标准装饰器是**降级**到
 *        辅助函数调用，不是新增语法，`erasableSyntaxOnly` 只禁「有运行期语义的类型语法」。
 *      · 「`@deepseek-ai/dsh-typert-protocol` 不在依赖里」——它当时确实不在，现在**已装**。
 *    两条错误结论的真实代价：`src/console/typert-face.ts` 因此在**晚了一轮之后**才被写出来，
 *    中间还绕了一条自建通道（见第 2 点）。教训是「读宿主源码得出的结论也要跑一遍」。
 *
 *    另有一条**必须遵守**的纪律（`packages/typert/registry` 的 `hasSeen`）：某个 endpoint
 *    一旦提交过严格描述符，SRC 回退对它**永久失效**（直到进程重启）。因此本包**不提供**
 *    `./typert` 导出、也不注册任何严格描述符。
 *
 * 2. **自建前缀通道在本版本不可用**（曾经试过，已放弃）。`ctx.connection.rpc.handle(channel, …)`
 *    内部是 `owner.effect(() => owner.webServer.register(route))`，而 `owner` 是
 *    **connection 服务自己的 ctx**，其 `inject` 只有 `['credentials']`、不含 `webServer`，
 *    于是属性读取直接抛 `cannot get property "webServer" without inject`——对**任何**调用方
 *    都成立，属上游潜伏缺陷（官方生态里无人调用它）。症状是请求落到静态兜底并得到 405，
 *    而服务端只留一条看不见的 warn。当前走共享网关 `/api`（见第 3 点）。
 *
 * 3. **传输面**：端点经共享网关暴露为 Remote（`POST /api/<namespace>/<method>`），
 *    见 `src/console/typert-face.ts`。本层仍然**不 import 任何 HTTP 类型**：入参是已解码的
 *    JSON 请求对象、出参是响应对象，适配层只是薄薄一层编解码——这条设计经受住了从
 *    「自建通道」到「共享网关」的整次迁移，本文件除了表里的调用形状外无需改动。
 *
 * 2. **传输面存在，但只给裸 HTTP**。`@deepseek-ai/dsh-host-webserver` 的
 *    `ctx.webServer.register({ kind, path, handler })` 是插件可用的注册面，其自述为
 *    "knows no harness concepts"，handler 直接拿 `IncomingMessage` / `ServerResponse`。
 *    它不提供方法分发、参数校验、错误信封、操作者身份或幂等——那正是本层要补的东西。
 *    因此本层**不 import 任何 HTTP 类型**：入参是一个已解码的 JSON 请求对象，
 *    出参是一个响应对象；`webServer` 适配器（或未来的 Typert 适配器）只是薄薄一层
 *    编解码。这样本层既不依赖宿主版本，也不会因为宿主破坏性改名而失效。
 *
 * 3. **协议里没有操作者身份**。`InvokeRemoteRequest` 只有
 *    `{ namespace, method, args, signal }`（`dsh-api-gateway/lib/types/types.d.ts`），
 *    错误码表 `remote-error-codes.d.ts` 也全是基础设施故障码，没有 principal/claims 概念。
 *    故身份只能由**宿主从传输层注入**，这正是 {@link CallContext} 的由来。
 *
 * ── 四条安全与并发纪律 ──
 *
 * 1. **身份来自传输层，不来自请求体**。请求体是**不可信输入**：`params` 若出现
 *    `operatorId`（或信封顶层出现），一律拒绝并返回 `console/operator-forbidden`。
 *    这是安全边界而不是参数校验——若只是"忽略"，客户端就会以为自己的伪造生效了；
 *    若"以请求体为准"，模型或浏览器就能冒充任意操作者，§11.1 的审计锚点随之作废。
 *    合并顺序上 `CallContext` 也恒胜出（见 {@link ConsoleRpc} 的分发）。
 *
 * 2. **乐观锁缺省即拒绝**。`expectedStateVersion` 缺失不是"当作 0"——那会让
 *    §15.4 的并发保护静默消失（两个浏览器同时点「下一阶段」双双成功）。
 *    除纯读与审批决策外一律要求显式给出；显式的 `0` 是合法值（新 engagement）。
 *    每个方法消费版本的方式见 {@link ConsoleMethodSpec.lock}，三种取值的**确切**保证
 *    写在 {@link ConsoleLockKind} 上——不含糊其辞地说"已加锁"。
 *
 * 3. **错误按码分支，不做 500，不做裸字符串**。`WorkflowRejection` 及任何携带契约
 *    `ErrorCode` 的失败（§16.5）都被映射成 `{ ok: false, code, message }`；
 *    `stale_state_version` 额外带回最新快照（§15.4「另一个返回冲突与最新状态」）。
 *    非契约错误折成 `console/internal` 并**不把原始 message 交给客户端**
 *    （可能含连接串等敏感信息），原始错误交给宿主的 {@link ConsoleRpcDeps.onInternalError} 记录。
 *
 * 4. **幂等**（§15.3「状态已提交但界面未收到结果时，重试返回原结果」）。
 *    键的作用域是 `(operatorId, key)`：不同操作者的同名字 key 互不干扰，也不会
 *    把甲的结果回放给乙。同 key 同体 → 回放原结果（`replay: true`）；同 key **不同体**
 *    → `console/idempotency-conflict`（那是客户端 bug，不能静默当成重试）。
 *    同一时刻的在途重复请求共享同一次执行（同 key 不同体则在途即冲突）。
 *    **失败不落记录**：失败没有被提交的状态可供复用，若把 `stale_state_version` 记成
 *    该键的永久结果，客户端刷新版本后就再也无法用同一键重试了。成功才落记录。
 */

import {
  ACTION_CLASSES,
  ERROR_CODES,
  isPhase,
} from '../contracts.ts';
import type {
  ErrorCode,
  HumanWorkflowService,
  PentestDiagnosticsService,
  PentestMemoryQueryService,
  PentestReportService,
  PentestSkillService,
  WorkflowSnapshot,
} from '../contracts.ts';
import { sha256Hex } from '../memory/chunks.ts';
import { CONSOLE_METHOD_NAMES, isConsoleMethod } from './method-names.ts';
import type { ConsoleMethodName } from './method-names.ts';

// ───────────────────────────── 稳定错误码 ─────────────────────────────

/**
 * 控制台 RPC 自身的失败码。
 *
 * 前缀与命名沿用官方 Gateway 的家族风格（`gateway/method-unavailable`、
 * `gateway/context-not-found`…，见 `dsh-api-gateway/lib/types/remote-error-codes.d.ts`）：
 * **基础设施故障与业务故障共用一张词汇表，但按前缀分区**。这样 UI 能一眼区分
 * 「我的请求不合法」（`console/*`）与「工作流拒绝了这次操作」（契约 `ErrorCode`，
 * 例如 `stale_state_version`、`budget_exhausted`），并对二者分支处置。
 */
export const CONSOLE_ERROR_CODES = [
  /** 传输层注入的 CallContext 不合法（宿主适配器的 bug，fail-closed）。 */
  'console/context-invalid',
  /** 信封结构不合法：非对象、缺 method、method 非字符串、params 非对象、多余顶层键。 */
  'console/envelope-invalid',
  /** 请求体试图携带操作者身份。**安全边界**，不是参数校验。 */
  'console/operator-forbidden',
  /** 端点未导出（未知方法，或属于 Worker/状态机面的方法）。 */
  'console/method-unavailable',
  /** 缺少 expectedStateVersion（拒绝静默默认 0）。 */
  'console/state-version-required',
  /** 缺少 reason（信封不提供，无法拼出 HumanActor）。 */
  'console/reason-required',
  /** 变更类方法缺少 idempotencyKey（§15.3 要求所有控制台操作带幂等标识）。 */
  'console/idempotency-key-required',
  /** 同 key、不同请求体。 */
  'console/idempotency-conflict',
  /** 命名参数缺失、类型不符、取值不在契约域内，或含未声明的键。 */
  'console/argument-invalid',
  /** 非契约错误。原始细节只交给宿主日志，不进响应。 */
  'console/internal',
  /**
   * 通道未在超时内响应。
   *
   * 单列一个码是因为它的**处置与 internal 完全不同**：它几乎总是部署配置问题
   * （控制台通道未注册——缺 `config.operator`，或宿主的 Connection 未装），
   * 而不是代码缺陷。界面据此给出可执行的提示，而不是永远转圈。
   */
  'console/channel-unavailable',
] as const;

export type ConsoleErrorCode = (typeof CONSOLE_ERROR_CODES)[number] | ErrorCode;

/** 控制台 RPC 故障：携带稳定码，供 {@link ConsoleRpc.handle} 映射为结构化响应。 */
export class ConsoleRpcFault extends Error {
  override readonly name = 'ConsoleRpcFault';
  readonly code: ConsoleErrorCode;

  constructor(code: ConsoleErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}

// ───────────────────────────── 传输层注入的调用者身份 ─────────────────────────────

/**
 * 一次调用的传输层上下文。由**宿主适配器**在解码请求时注入，绝不出现在请求体里。
 *
 * - `operatorId`：操作者身份，是 `HumanActor.operatorId` 的唯一来源；
 * - `authenticatedAt`：该会话完成认证的时刻（适配器给的，不是客户端声称的）；
 * - `source`：传输来源标签（如 `web-console`、`cli`、`desktop-ipc`），用于审计与排障。
 *
 * 只有 `operatorId` 会进入工作流服务的输入——`HumanActor` 只消费这一个字段。
 * 三者都会被**校验**（缺失或类型不符即 `console/context-invalid`）：宿主适配器把
 * 上下文接错时必须响亮失败，而不是退化成匿名操作者。`authenticatedAt` 与 `source`
 * 由适配器自行记入宿主日志；本层不替宿主决定保留策略（§11.5）。
 */
export interface CallContext {
  readonly operatorId: string;
  readonly authenticatedAt: Date;
  readonly source: string;
}

// ───────────────────────────── 请求与响应 ─────────────────────────────

/**
 * 控制台请求信封（**不可信输入**：由客户端构造，逐字段校验后才使用）。
 *
 * 职责划分是一条硬规则，`params` 里出现 `reason` / `expectedStateVersion` /
 * `operatorId` / `idempotencyKey` 一律被拒（未知键即 `console/argument-invalid`，
 * 身份键另见 `console/operator-forbidden`）：信封管「谁、以什么理由、基于哪个版本、
 * 带哪个幂等键」，`params` 只管方法自己的命名参数。落在两处会造成"哪一份生效"
 * 的静默分歧。
 */
/**
 * 宿主 Connection RPC 的**结果形状**。
 *
 * `{ok:true,value} | {ok:false,error:{code,message,details}}` 是宿主的既定形状，
 * 客户端的解析逻辑围绕它写。`/api` 网关的响应也归到这上面：它回
 * `{type:'server-response',rpcId,result}`，其中 `result` 就是这个形状，
 * 因此适配层只需剥掉外层信封、把 `result` 交给客户端。
 *
 * 放在本模块而不是某个适配器里：它是**传输契约**，由协议层拥有，
 * 不该随某一个适配器的存亡而移动。
 */
export type HostRpcResult =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly error: { readonly code: string; readonly message: string; readonly details: Record<string, unknown> } };

/**
 * 控制台端点所在的通道：见 `method-names.ts` 的 `DEFAULT_CONSOLE_CHANNEL`。
 *
 * （常量与命名空间都移到了零依赖模块——客户端要拼同一路径，而本模块的实现链
 * 会拉到 `node:crypto`；两侧必须来自同一处，否则改一处就静默 404。）
 */

export interface ConsoleRequest {
  /** 端点名，取值见 {@link CONSOLE_RPC_METHODS}。 */
  readonly method: string;
  /** 方法自己的命名参数（不含任何身份/版本/幂等字段）。 */
  readonly params?: Readonly<Record<string, unknown>>;
  /** 乐观锁版本；要求与否见 {@link ConsoleMethodSpec.lock}。 */
  readonly expectedStateVersion?: number;
  /** 人类填写的理由；要求与否见 {@link ConsoleMethodSpec.reason}。 */
  readonly reason?: string;
  /** 幂等键；变更类方法必填（§15.3）。 */
  readonly idempotencyKey?: string;
}

/** 成功响应。`replay` 为 true 表示未再次执行，返回的是该幂等键的首次结果。 */
export interface ConsoleOk {
  readonly ok: true;
  readonly method: ConsoleMethodName;
  readonly result: unknown;
  readonly replay: boolean;
}

/** 失败响应。`method` 是**请求中声称的**端点名（无法解析时为 null），仅用于诊断。 */
export interface ConsoleFailure {
  readonly ok: false;
  readonly method: string | null;
  readonly code: ConsoleErrorCode;
  readonly message: string;
  /** 仅 `stale_state_version` 时尽力附带：§15.4「另一个返回冲突与最新状态」。 */
  readonly state?: WorkflowSnapshot;
}

export type ConsoleResponse = ConsoleOk | ConsoleFailure;

// ───────────────────────────── 方法表 ─────────────────────────────

/**
 * 期望版本被消费的方式。三种取值的保证**不同**，因此必须区分而不是笼统说"已加锁"：
 *
 * - `actor`：`expectedStateVersion` 合并进输入（该方法输入派生自 `HumanActor`），
 *   由服务在**它自己的转移事务内**做比对——真正的乐观锁，
 *   §15.4「两个界面同时提交切换，只有一个能成功」由它保证。
 * - `envelope`：信封必须携带，但**该方法的输入契约里没有这个字段**，服务读的是
 *   数据库里的当前版本（当前只有 `interject` 属于这一类：它在服务内部自取版本）。
 *   本层只能强制"必须显式给出"，无法替服务比对——声称已加锁会是假的。
 *   这是**服务契约的缺口**：要真正闭合，得让该方法的输入带上锚点。
 * - `none`：不参与版本比对。纯读（`getState`）与审批决策
 *   （`decideApproval` / `revokeApproval` 的输入类型里没有 `expectedStateVersion`；
 *   审批的一次性由 `approvals.decision` 的状态迁移与 `consumeApproval` 保证）。
 */
export type ConsoleLockKind = 'actor' | 'envelope' | 'none';

/** 命名参数的类型标签。校验是**结构化**的，不引入第二套 schema DSL（§21.0 A9）。 */
type ConsoleParamKind =
  | 'string'
  /**
   * 可选字符串，**允许空串**（空串 = 未提供）。
   *
   * 与 `'string'` 的区别只在空串：授权留痕类字段（授权说明/授权引用/授权到期）
   * 的语义是「有就记、没有就空着」，因此调用方把空串显式传过来是合法表达；
   * 而必填字段（名称、目标、理由等）仍旧走 `'string'` 的非空校验。
   */
  | 'stringAllowEmpty'
  | 'stringOrNull'
  | 'boolean'
  | 'number'
  | 'phase'
  | 'stringArray'
  | 'actionClassArray'
  | 'array'
  | 'budget'
  | 'json';

interface ConsoleParamSpec {
  readonly name: string;
  readonly kind: ConsoleParamKind;
  readonly required: boolean;
}

interface ConsoleMethodSpec {
  readonly kind: 'read' | 'mutation';
  readonly lock: ConsoleLockKind;
  /** 是否把 `CallContext.operatorId` 合并进输入。 */
  readonly operator: boolean;
  /** 是否把信封 `reason` 合并进输入，且缺失即拒绝。 */
  readonly reason: boolean;
  /**
   * `reason: true` 时**只放宽「非空」那一半**：字段照旧进输入（填了就全程留痕），
   * 但允许空/缺省。放行决定用它——人类要能直接点「批准这一次执行」，
   * 同时保留「把话带给 Agent」的通道（2026-10-05 人类要求）。
   */
  readonly reasonOptional?: boolean;
  readonly fields: readonly ConsoleParamSpec[];
  /**
   * 调用服务。经 {@link call} 构造，保持与 `HumanWorkflowService` 成员名编译期同源。
   *
   * 函数上**附带 `callShape`**：形状的唯一来源是 `call()` 的实参，随函数带出来供加载期
   * 检查读取。若把它另存一份在 spec 上，两处就会漂移——而漂移的后果是静默的错误调用。
   */
  readonly invoke: ((services: ConsoleServices, input: Record<string, unknown>) => Promise<unknown>) & {
    readonly callShape: 'object' | { readonly scalar: string };
  };
}

/**
 * 服务方法**第一个参数**的类型。
 *
 * 用来推导该端点的调用形状：服务方法收标量（`getState(engagementId: string)`）
 * 与收对象（`getScope(input: GetScopeInput)`）时，控制台必须用不同的方式把命名参数递下去。
 */
type FirstParamOf<
  F extends keyof ConsoleServices,
  K extends keyof ConsoleServices[F],
> = ConsoleServices[F][K] extends (...args: infer A) => unknown
  ? A extends readonly []
    ? undefined
    : A[0]
  : never;

/**
 * 端点的**调用形状**——由契约**推导**，不能手选。
 *
 * - 首参是 `string` → 必须给 `{ scalar: '字段名' }`：只把该命名参数的裸值作为唯一实参传下去。
 * - 否则 → `'object'`：把命名参数整体作为一个参数对象传下去（34 个端点如此）。
 *
 * ── 为什么需要它（实测踩过）──
 *
 * {@link call} 原先一律 `Reflect.apply(method, target, [input])`。对收对象的方法正确，
 * 对收标量的方法就变成「把 `{engagementId: '…'}` 当成 id 传给 SQL」→ 运行期
 * `console/internal`。受影响的是 5 个方法：
 *
 *   workflow.getState / report.getReportDraft / report.listFindings /
 *   report.listUndisposed / memory.memoryWatermark
 *
 * 症状是**首屏读不到数据**（`getState` 挂了 → 整个控制台空白），而单元测试全绿——
 * 因为测试直接调服务方法、从不经过这张表。
 *
 * 之所以让类型来判而不是「记得给标量端点加个标记」：这类错配的后果在编译期完全可见，
 * 而人一定会忘。现在把 `{ scalar }` 用在收对象的方法上、或漏给标量方法，
 * 都是**编译错误**。
 *
 * 之所以是 `{ scalar: '字段名' }` 而不是布尔：显式写出取哪个字段，
 * 读表时就能看出这个端点把哪个命名参数当实参，不必回查服务签名。
 */
export type MethodCallArgs<
  F extends keyof ConsoleServices,
  K extends keyof ConsoleServices[F],
> = [FirstParamOf<F, K>] extends [string] ? { readonly scalar: string } : 'object';

/**
 * 把接口成员名绑定到具体调用：方法名写错或改名会在编译期失败。
 *
 * `shape` 是**必填**的：对象形状显式写 `'object'`，标量形状写 `{ scalar: '字段' }`。
 * 不给默认值是有意的——默认值会让「标量端点忘了声明」重新变成静默错误，
 * 而显式的 `'object'` 让每一行都能自证调用方式。
 */
function call<F extends keyof ConsoleServices, K extends keyof ConsoleServices[F] & string>(
  face: F,
  name: K,
  shape: MethodCallArgs<F, K>,
) {
  const invoke = async (services: ConsoleServices, input: Record<string, unknown>): Promise<unknown> => {
    const target: ConsoleServices[F] = services[face];
    const method: unknown = target[name];
    if (typeof method !== 'function') {
      // 服务面缺方法说明装配错了（或版本不匹配）。fail loud 好过静默返回 undefined。
      throw new ConsoleRpcFault(
        'console/internal',
        `服务面 ${face} 上不存在方法 ${name}：控制台端点的装配与契约不一致`,
      );
    }

    // 对象形状传整个命名参数表；标量形状只传那一个字段的裸值。
    const argv: readonly unknown[] =
      typeof shape === 'object' && shape !== null && 'scalar' in shape
        ? [input[shape.scalar]]
        : [input];

    // 用 `Reflect.apply` 而不是 `(method as Fn).call(...)`：后者需要类型断言，
    // 而这里方法的形状由注入方决定，断言会掩盖真实的接口错配。
    const result: unknown = Reflect.apply(method, target, argv);
    if (!isPromiseLike(result)) {
      throw new ConsoleRpcFault(
        'console/internal',
        `服务面 ${face}.${name} 未返回 Promise：控制台端点的调用约定是异步`,
      );
    }
    return result;
  };
  // 把形状随函数带出去（唯一来源仍是上面的 `shape` 实参）。
  return Object.assign(invoke, { callShape: shape as 'object' | { readonly scalar: string } });
}

/**
 * 标量形状端点的**前置检查**：只传一个字段时，其余派生字段（`operatorId` / `reason` /
 * `expectedStateVersion`）不会被送达服务。
 *
 * 那些字段对成形的输入对象是必需的（例如 `lock: 'actor'` 的方法要把版本号一并交给服务），
 * 只传标量等于把它们**静默丢掉**。因此这里在**模块加载时**就拒绝这种组合，
 * 而不是等运行期出现「审计没有操作者」这类难以归因的现象。
 */
function assertScalarShapeIsSafe(name: string, spec: ConsoleMethodSpec): void {
  if (spec.invoke.callShape === 'object') return;
  const needsDerived = spec.operator || spec.reason || spec.lock === 'actor';
  if (needsDerived) {
    throw new Error(
      `控制台端点 ${name} 声明了标量调用形状，但它还需要派生字段` +
        `（operator=${String(spec.operator)} reason=${String(spec.reason)} lock=${spec.lock}）。` +
        `标量形状只把单个字段的裸值传给服务，派生字段会被静默丢弃。` +
        `请改用对象形状，或把这些字段并入服务的单个参数。`,
    );
  }
}

/** 运行时判定 Promise 形状（不依赖 `instanceof`，跨 realm 也成立）。 */
function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  if (value === null || typeof value !== 'object') return false;
  if (!('then' in value)) return false;
  return typeof value.then === 'function';
}

const f = (name: string, kind: ConsoleParamKind, required = true): ConsoleParamSpec => ({ name, kind, required });
const PHASE = 'phase' as const;
const CLASSES = 'actionClassArray' as const;

/**
 * RPC 暴露的方法集 = `HumanWorkflowService` 的人类面。
 *
 * `Record<Exclude<keyof HumanWorkflowService, 'finishWorker'>, …>` 不是装饰：
 * 它让**编译期**保证这张表恰好覆盖人类面且不多不少——服务新增方法而忘了挂端点会报错，
 * 把 `finishWorker` 加进来也会报错。
 *
 * `finishWorker` 被排除的理由（§4.2、§10.1）：它是 Worker 工具 `pentest_submit_report`
 * 的路径（自报成果，只把会话推进到等待人工，不改阶段）。模型可以调它，
 * 因此它不属于"人类专属"，不能出现在控制台面——否则控制台面就成了第二个模型可达的写入入口。
 */
const WORKFLOW_METHOD_TABLE: Record<Exclude<keyof HumanWorkflowService, 'finishWorker'>, ConsoleMethodSpec> = {
  // ── engagement 生命周期（授权向导与列表；§6.1、§11.1）──
  //
  // `lock: 'none'` 是有意的：`expectedStateVersion` 的用途是防止覆盖别人的修改
  // （§15.4），而 `createEngagement` 此刻**还没有 engagement** —— 没有版本可比对，
  // 它是这条状态链的起点。防重复提交由调用方的幂等键承担（§15.3）。
  // 反过来，强行要求一个版本号会逼调用方填 0，那只是形式上的保护。
  createEngagement: {
    kind: 'mutation',
    lock: 'none',
    operator: true,
    reason: true,
    // 人类动作**不要求理由**（2026-10-05 人类明确要求）：操作者与时间照记，理由填了留痕、不填为空串。
    reasonOptional: true,
    fields: [
      // 名称、目标、**行为预设**必填（预设没有默认值——它是每个作业的必选项）。
      // 此前七项全必填，让「自己给自己开个作业」每次都要编授权引用、算时间窗、
      // 填一堆**零读取方**的 RoE 字段（roe/timeWindow 全仓没有任何读取点）。
      f('name', 'string'),
      // 授权留痕：空串是合法表达（未提供），因此用 stringAllowEmpty 而不是 string。
      f('authorizationRef', 'stringAllowEmpty', false),
      f('authorizationExpiresAt', 'stringAllowEmpty', false),
      f('targets', 'array'),
      f('exclusions', 'array', false),
      f('roe', 'json', false),
      f('timeWindow', 'json', false),
      f('scopeEntryProfile', 'string', false),
      f('behaviorProfile', 'string'),
      f('customGuidance', 'stringAllowEmpty', false),
      // 审批模式同样是必选项（人工审批 / 高权限）：它决定预设内的命令要不要人类过目。
      f('approvalMode', 'string'),
      f('policyOverrides', 'json', false),
      f('publicMemory', 'string', false),
    ],
    invoke: call('workflow', 'createEngagement', 'object'),
  },
  openTask: {
    kind: 'mutation',
    lock: 'none',
    operator: true,
    reason: true,
    // 人类动作**不要求理由**（2026-10-05 人类明确要求）：操作者与时间照记，理由填了留痕、不填为空串。
    reasonOptional: true,
    fields: [f('clientSessionKey', 'string')],
    invoke: call('workflow', 'openTask', 'object'),
  },
  // 聊天里的「待你确认」卡片用的只读查询：传 dsh 会话标识，服务端反查到作业后
  // 返回待确认的范围方案与待放行凭证数。**只读**，因此不需要操作者/理由/幂等键。
  getIntakeStatus: {
    kind: 'read',
    lock: 'none',
    operator: false,
    reason: false,
    fields: [f('dshSessionId', 'string')],
    invoke: call('workflow', 'getIntakeStatus', 'object'),
  },
  getScopeProposal: {
    kind: 'read',
    lock: 'none',
    operator: false,
    reason: false,
    fields: [f('engagementId', 'string')],
    invoke: call('workflow', 'getScopeProposal', { scalar: 'engagementId' }),
  },
  confirmScopeProposal: {
    kind: 'mutation',
    lock: 'actor',
    operator: true,
    reason: true,
    // 人类动作**不要求理由**（2026-10-05 人类明确要求）：操作者与时间照记，理由填了留痕、不填为空串。
    reasonOptional: true,
    fields: [
      f('engagementId', 'string'),
      f('proposalId', 'string'),
      f('objective', 'string'),
      f('targets', 'array'),
      f('exclusions', 'array'),
      f('allowedActions', 'actionClassArray'),
      // 可选：授权说明只进审计与策略快照，不作为确认前提（部署方本身即授权主体）。
      // 授权说明可留空：它是留痕，不是前提（见 §5.5.1）。
      f('authorizationNote', 'stringAllowEmpty', false),
      f('authorizationExpiresAt', 'stringAllowEmpty', false),
      f('taskPrompt', 'string', false),
      f('scopeEntryProfile', 'string', false),
      f('behaviorProfile', 'string'),
      f('customGuidance', 'stringAllowEmpty', false),
      f('approvalMode', 'string'),
      f('policyOverrides', 'json', false),
      f('roe', 'json', false),
      f('timeWindow', 'json', false),
    ],
    invoke: call('workflow', 'confirmScopeProposal', 'object'),
  },
  rejectScopeProposal: {
    kind: 'mutation',
    lock: 'actor',
    operator: true,
    reason: true,
    // 人类动作**不要求理由**（2026-10-05 人类明确要求）：操作者与时间照记，理由填了留痕、不填为空串。
    reasonOptional: true,
    fields: [f('engagementId', 'string'), f('proposalId', 'string')],
    invoke: call('workflow', 'rejectScopeProposal', 'object'),
  },
  listEngagements: {
    kind: 'read',
    lock: 'none',
    operator: false,
    reason: false,
    fields: [
      f('statuses', 'stringArray', false),
      f('limit', 'number', false),
      // 归档的作业默认不列（列表噪声的主要来源）；控制台要「显示已归档」开关时显式索取。
      f('includeArchived', 'boolean', false),
    ],
    invoke: call('workflow', 'listEngagements', 'object'),
  },
  // 阶段轨道与时间轴的数据源：`getState` 只给当前状态，而轨道要按阶段聚合
  // 全部会话、时间轴要画重做链与交接链——那些都在历史会话里。
  listWorkerSessions: {
    kind: 'read',
    lock: 'none',
    operator: false,
    reason: false,
    fields: [
      f('engagementId', 'string'),
      f('phases', 'stringArray', false),
      f('limit', 'number', false),
    ],
    invoke: call('workflow', 'listWorkerSessions', 'object'),
  },

  /**
   * 「进入下一阶段」：服务端**起稿**（不经 Agent），返回可直接编辑的交接包。
   *
   * 不要求理由：人类点这一下就是在推进自己的作业，操作者与时间照记进决策与审计。
   */
  beginHandoff: {
    kind: 'mutation',
    lock: 'actor',
    operator: true,
    reason: false,
    fields: [
      f('workerSessionId', 'string'),
      f('toPhase', 'string', false),
    ],
    invoke: call('workflow', 'beginHandoff', 'object'),
  },

  /**
   * 读回当前待确认的交接草稿（只读；没有草稿时 `value` 为 null）。
   *
   * 界面用它渲染编辑器：草稿必须能从**服务端**取回，而不是只活在请求它的那次调用里
   * （否则刷新/重挂载就丢，人类看到正文却找不到确认按钮）。
   */
  currentHandoffDraft: {
    kind: 'read',
    lock: 'none',
    operator: false,
    reason: false,
    fields: [f('workerSessionId', 'string')],
    invoke: call('workflow', 'currentHandoffDraft', 'object'),
  },

  // 授权向导的范围 dry-run：显示「服务端规范化后的最终范围与限制」（§13.1）。
  //
  // 它是**纯计算**：不读数据库、不改状态、不写审计，因此 `lock`/`operator`/`reason`
  // 全部为 none/false。这与「所有写操作都要求理由与幂等键」并不矛盾——
  // 那些要求服务于审计与并发保护，而这里没有任何可审计的事实发生。
  previewScope: {
    kind: 'read',
    lock: 'none',
    operator: false,
    reason: false,
    fields: [
      f('targets', 'array'),
      f('exclusions', 'array'),
    ],
    invoke: call('workflow', 'previewScope', 'object'),
  },

  // 策略预览（§6.2.0.5）：人类在确认范围/策略之前看到**服务端将冻结的全部事实**——
  // 规范化范围、地址裁决、展开后的节奏与动作权限、最终快照哈希。
  //
  // 与 `previewScope` 一样是只读纯计算（读当前投影以给出「将产生哪个版本」），
  // 因此不需要 operator/reason/幂等键。
  previewPolicy: {
    kind: 'read',
    lock: 'none',
    operator: false,
    reason: false,
    fields: [
      f('engagementId', 'string'),
      // 界面会带上待确认的提案标识（服务端据此校验它仍处于 pending）——
      // 漏声明会让整次调用被「未声明的键一律拒绝」挡下（实测：界面表现为「尚未取得预览」）。
      f('proposalId', 'string', false),
      f('targets', 'array'),
      f('exclusions', 'array'),
      f('scopeEntryProfile', 'string', false),
      f('behaviorProfile', 'string', false),
      f('customGuidance', 'stringAllowEmpty', false),
      f('approvalMode', 'string', false),
      f('policyOverrides', 'json', false),
      f('allowedActions', 'actionClassArray', false),
      f('authorizationRef', 'stringAllowEmpty', false),
      f('authorizationExpiresAt', 'string', false),
      f('roe', 'json', false),
      f('timeWindow', 'json', false),
    ],
    invoke: call('workflow', 'previewPolicy', 'object'),
  },

  // 放行队列的数据源。**必须返回完整执行内容**（命令文本、目标、风险摘要）——
  // §10.3.1 的 approve-what-you-see 要求人类批准的是「即将执行的那条命令」。
  listApprovals: {
    kind: 'read',
    lock: 'none',
    operator: false,
    reason: false,
    fields: [
      f('engagementId', 'string'),
      f('decisions', 'stringArray', false),
      f('limit', 'number', false),
    ],
    invoke: call('workflow', 'listApprovals', 'object'),
  },
  // 公共记忆面板的数据源。单独一个读端点而不是塞进 `getState`：它可能很长，
  // 而 `getState` 每次操作后都会被刷新——搭在上面会让每次点击都多传几 KB。
  getEngagementMemory: {
    kind: 'read',
    lock: 'none',
    operator: false,
    reason: false,
    fields: [f('engagementId', 'string')],
    invoke: call('workflow', 'getEngagementMemory', 'object'),
  },
  updateEngagementMemory: {
    kind: 'mutation',
    lock: 'actor',
    operator: true,
    reason: true,
    // 人类动作**不要求理由**（2026-10-05 人类明确要求）：操作者与时间照记，理由填了留痕、不填为空串。
    reasonOptional: true,
    fields: [f('engagementId', 'string'), f('content', 'stringOrNull')],
    invoke: call('workflow', 'updateEngagementMemory', 'object'),
  },
  getScope: {
    kind: 'read',
    lock: 'none',
    operator: false,
    reason: false,
    fields: [
      f('engagementId', 'string'),
      f('includeHistory', 'boolean', false),
    ],
    invoke: call('workflow', 'getScope', 'object'),
  },
  // 回环范围修订的输入：候选资产带发现来源（§5.5 要求「标注来源」）。
  listCandidateAssets: {
    kind: 'read',
    lock: 'none',
    operator: false,
    reason: false,
    fields: [
      f('engagementId', 'string'),
      f('decisions', 'stringArray', false),
      f('limit', 'number', false),
    ],
    invoke: call('workflow', 'listCandidateAssets', 'object'),
  },

  getState: {
    kind: 'read',
    lock: 'none',
    operator: false,
    reason: false,
    fields: [f('engagementId', 'string')],
    invoke: call('workflow', 'getState', { scalar: 'engagementId' }),
  },

  // ── 创建会话与交接 ──
  startWorker: {
    kind: 'mutation',
    lock: 'actor',
    operator: true,
    reason: false,
    reasonOptional: true,
    fields: [
      f('engagementId', 'string'),
      f('phase', PHASE),
      f('taskPrompt', 'string'),
      // 可选：省略即由工作流用**该阶段能力声明的默认值**填充（见 StartWorkerInput 的说明）。
      // 这两个字段曾经是必填且界面固定传空数组——结果是每个 Agent 的工具面都被收窄成空集，
      // 模型一个工具都看不见，而界面看起来一切正常。
      f('skillIds', 'stringArray', false),
      f('toolAllow', 'stringArray', false),
      f('budget', 'budget', false),
    ],
    invoke: call('workflow', 'startWorker', 'object'),
  },
  cancelHandoff: {
    kind: 'mutation',
    lock: 'actor',
    operator: true,
    reason: true,
    // 人类动作**不要求理由**（2026-10-05 人类明确要求）：操作者与时间照记，理由填了留痕、不填为空串。
    reasonOptional: true,
    fields: [f('engagementId', 'string')],
    invoke: call('workflow', 'cancelHandoff', 'object'),
  },
  confirmTransition: {
    kind: 'mutation',
    lock: 'actor',
    operator: true,
    reason: true,
    // 人类动作**不要求理由**（2026-10-05 人类明确要求）：操作者与时间照记，理由填了留痕、不填为空串。
    reasonOptional: true,
    fields: [
      f('engagementId', 'string'),
      f('draftId', 'string'),
      f('forced', 'boolean'),
      f('forcedAcknowledged', 'boolean'),
      // 同 `editHandoff`：漏声明即端点整死（见那里的说明）。
      f('objective', 'string'),
      f('excludedRefs', 'stringArray'),
      f('approvedToPhase', PHASE),
      f('approvedPrompt', 'string'),
      f('approvedSkillIds', 'stringArray'),
      f('approvedToolAllow', 'stringArray'),
      f('approvedApprovalRequired', CLASSES),
      f('contextRefs', 'array'),
    ],
    invoke: call('workflow', 'confirmTransition', 'object'),
  },
  retryWorker: {
    kind: 'mutation',
    lock: 'actor',
    operator: true,
    reason: true,
    // 人类动作**不要求理由**（2026-10-05 人类明确要求）：操作者与时间照记，理由填了留痕、不填为空串。
    reasonOptional: true,
    fields: [
      f('engagementId', 'string'),
      f('taskPrompt', 'string'),
      f('reuseSession', 'boolean'),
      f('contextRefs', 'array', false),
    ],
    invoke: call('workflow', 'retryWorker', 'object'),
  },
  reopenTechnicalWork: {
    kind: 'mutation',
    lock: 'actor',
    operator: true,
    reason: true,
    // 人类动作**不要求理由**（2026-10-05 人类明确要求）：操作者与时间照记，理由填了留痕、不填为空串。
    reasonOptional: true,
    fields: [f('engagementId', 'string')],
    invoke: call('workflow', 'reopenTechnicalWork', 'object'),
  },

  // ── 范围与预算 ──
  amendScope: {
    kind: 'mutation',
    lock: 'actor',
    operator: true,
    reason: true,
    // 人类动作**不要求理由**（2026-10-05 人类明确要求）：操作者与时间照记，理由填了留痕、不填为空串。
    reasonOptional: true,
    fields: [
      f('engagementId', 'string'),
      f('targets', 'array'),
      f('exclusions', 'array'),
      f('authorizationRef', 'stringOrNull'),
      f('decisions', 'array'),
    ],
    invoke: call('workflow', 'amendScope', 'object'),
  },
  /**
   * 归档 / 取消归档。清理的**第一级**：列表隐藏、数据全留、随时可恢复。
   */
  archiveEngagement: {
    kind: 'mutation',
    lock: 'none',
    operator: true,
    reason: false,
    fields: [
      f('engagementId', 'string'),
      f('archived', 'boolean'),
    ],
    invoke: call('workflow', 'archiveEngagement', 'object'),
  },
  /** 彻底删除前的只读预览（行数 + 拦截原因），确认框里显示的就是它。 */
  previewEngagementPurge: {
    kind: 'read',
    lock: 'none',
    operator: true,
    reason: false,
    fields: [f('engagementId', 'string')],
    invoke: call('workflow', 'previewEngagementPurge', 'object'),
  },
  /**
   * **彻底删除**（不可恢复）。只对已归档、无未终结会话/有效租约、且 `confirmName`
   * 与作业名逐字一致的作业生效——三步都过了才动数据。
   */
  purgeEngagement: {
    kind: 'mutation',
    lock: 'actor',
    operator: true,
    reason: false,
    fields: [
      f('engagementId', 'string'),
      f('confirmName', 'string'),
    ],
    invoke: call('workflow', 'purgeEngagement', 'object'),
  },
  /**
   * 切换审批模式（人工审批 ⇄ 高权限）。**运行中可切、不要求理由**（人类是主人）：
   * 写新一版策略并推进 policy epoch，于是旧放行凭证与在途计划当场失效。
   * `lock: 'actor'` ⇒ 仍必须带 `expectedStateVersion`（与其它人类变更同形）。
   */
  setApprovalMode: {
    kind: 'mutation',
    lock: 'actor',
    operator: true,
    reason: false,
    fields: [
      f('engagementId', 'string'),
      f('approvalMode', 'string'),
    ],
    invoke: call('workflow', 'setApprovalMode', 'object'),
  },
  extendBudget: {
    kind: 'mutation',
    lock: 'actor',
    operator: true,
    reason: true,
    // 人类动作**不要求理由**（2026-10-05 人类明确要求）：操作者与时间照记，理由填了留痕、不填为空串。
    reasonOptional: true,
    fields: [
      f('workerSessionId', 'string'),
      f('additionalTokens', 'number', false),
      f('additionalSteps', 'number', false),
      f('additionalSeconds', 'number', false),
    ],
    invoke: call('workflow', 'extendBudget', 'object'),
  },

  // ── 运行中干预 ──
  interject: {
    kind: 'mutation',
    lock: 'envelope',
    operator: true,
    reason: false,
    reasonOptional: true,
    fields: [f('workerSessionId', 'string'), f('message', 'string')],
    invoke: call('workflow', 'interject', 'object'),
  },
  pause: {
    kind: 'mutation',
    lock: 'actor',
    operator: true,
    reason: false,
    reasonOptional: true,
    fields: [f('engagementId', 'string')],
    invoke: call('workflow', 'pause', 'object'),
  },
  resume: {
    kind: 'mutation',
    lock: 'actor',
    operator: true,
    reason: false,
    reasonOptional: true,
    fields: [f('engagementId', 'string')],
    invoke: call('workflow', 'resume', 'object'),
  },
  abort: {
    kind: 'mutation',
    lock: 'actor',
    operator: true,
    reason: false,
    reasonOptional: true,
    fields: [f('engagementId', 'string')],
    invoke: call('workflow', 'abort', 'object'),
  },

  // ── 审批（唯一不参与版本比对的写入面） ──
  decideApproval: {
    kind: 'mutation',
    lock: 'none',
    operator: true,
    // 放行决定：**携带**附言但不强制非空——人类要能直接点「批准这一次执行」，
    // 而填了的内容仍会全程留痕并投递给 Agent（`decision_reason` + `deliverApprovalNotice`）。
    //
    // ⚠ `reason` 必须是 `true`：信封只在 `reason === true` 时才把附言**转发给工作流**
    // （`if (!spec.reason) return null`）。写成 `false` 会让「填了也白填」——
    // 注释说携带、实际静默丢弃，而界面看起来一切正常（2026-10-05 实测踩到）。
    reason: true,
    // 人类动作**不要求理由**（2026-10-05 人类明确要求）：操作者与时间照记，理由填了留痕、不填为空串。
    reasonOptional: true,
    fields: [
      f('approvalId', 'string'),
      f('decision', 'string'),
      f('modifiedCommandPlan', 'json', false),
    ],
    invoke: call('workflow', 'decideApproval', 'object'),
  },
  revokeApproval: {
    kind: 'mutation',
    lock: 'none',
    operator: true,
    reason: true,
    // 人类动作**不要求理由**（2026-10-05 人类明确要求）：操作者与时间照记，理由填了留痕、不填为空串。
    reasonOptional: true,
    fields: [f('approvalId', 'string')],
    invoke: call('workflow', 'revokeApproval', 'object'),
  },

  // ── 报告 ──
  finishTechnicalTesting: {
    kind: 'mutation',
    lock: 'actor',
    operator: true,
    reason: true,
    // 人类动作**不要求理由**（2026-10-05 人类明确要求）：操作者与时间照记，理由填了留痕、不填为空串。
    reasonOptional: true,
    fields: [f('engagementId', 'string')],
    invoke: call('workflow', 'finishTechnicalTesting', 'object'),
  },
  signReport: {
    kind: 'mutation',
    lock: 'actor',
    operator: true,
    // HumanReportSignature 没有 reason 字段：签字以内容哈希为准，不要求自由文本理由。
    reason: false,
    fields: [f('engagementId', 'string'), f('contentHash', 'string')],
    invoke: call('workflow', 'signReport', 'object'),
  },
};

// ───────────────────────────── 其余服务面 ─────────────────────────────
//
// 控制台需要四个服务面，而不是一个。分开的理由是**它们的职责与失败语义不同**：
//
//   workflow  状态与权限（唯一写入路径，§4.2）
//   report    报告投影与结论处置（§8.9）
//   memory    记忆检索（只读，§8.7）
//   skills    skill 库（全局，§2.2）
//
// 每张表都用 `Record<keyof Face, …>` 绑定到对应契约：**服务新增方法而忘了挂端点
// 会在编译期失败**。这个约束在工作流面上已经抓到过三次缺口（创建/列表、会话列表、
// 范围预校验），因此对其他面同样施加。

/** 报告面（§8.9、§16.1.1）。 */
const REPORT_METHOD_TABLE: Record<keyof PentestReportService, ConsoleMethodSpec> = {
  getReportDraft: {
    kind: 'read',
    lock: 'none',
    operator: false,
    reason: false,
    fields: [f('engagementId', 'string')],
    invoke: call('report', 'getReportDraft', { scalar: 'engagementId' }),
  },
  listFindings: {
    kind: 'read',
    lock: 'none',
    operator: false,
    reason: false,
    fields: [f('engagementId', 'string')],
    invoke: call('report', 'listFindings', { scalar: 'engagementId' }),
  },
  dispositionFinding: {
    kind: 'mutation',
    lock: 'none',
    operator: true,
    reason: true,
    // 人类动作**不要求理由**（2026-10-05 人类明确要求）：操作者与时间照记，理由填了留痕、不填为空串。
    reasonOptional: true,
    fields: [
      f('findingId', 'string'),
      f('action', 'string'),
      f('severity', 'stringOrNull', false),
    ],
    invoke: call('report', 'dispositionFinding', 'object'),
  },
  updateReport: {
    kind: 'mutation',
    lock: 'none',
    operator: true,
    reason: true,
    // 人类动作**不要求理由**（2026-10-05 人类明确要求）：操作者与时间照记，理由填了留痕、不填为空串。
    reasonOptional: true,
    fields: [
      f('engagementId', 'string'),
      f('expectedStateVersion', 'number'),
      f('editedContent', 'string'),
    ],
    invoke: call('report', 'updateReport', 'object'),
  },
  redactPreview: {
    kind: 'read',
    lock: 'none',
    operator: false,
    reason: false,
    fields: [
      f('engagementId', 'string'),
      f('classifications', 'stringArray'),
    ],
    invoke: call('report', 'redactPreview', 'object'),
  },
  exportReport: {
    kind: 'read',
    lock: 'none',
    // `operator: true`：契约的 `ExportRequest`**需要** `operatorId`（导出要可归因），
    // 但身份**不能来自 params**——`assertAllowedEnvelopeKeys` 对 params 里的身份键直接抛
    // `console/operator-forbidden`。因此声明为 operator 面，由控制台注入
    // `CallContext.operatorId`；把它写成普通字段会让这个端点**永远调不通**。
    operator: true,
    reason: false,
    fields: [
      f('engagementId', 'string'),
      f('format', 'string'),
    ],
    invoke: call('report', 'exportReport', 'object'),
  },
  listUndisposed: {
    kind: 'read',
    lock: 'none',
    operator: false,
    reason: false,
    fields: [f('engagementId', 'string')],
    invoke: call('report', 'listUndisposed', { scalar: 'engagementId' }),
  },
};

/** 记忆检索面（§8.7）。全是读——检索不改任何事实。 */
const MEMORY_METHOD_TABLE: Record<keyof PentestMemoryQueryService, ConsoleMethodSpec> = {
  searchMemory: {
    kind: 'read',
    lock: 'none',
    operator: true,
    reason: false,
    fields: [
      f('engagementId', 'string'),
      f('query', 'string'),
      f('phase', 'stringOrNull', false),
      f('kinds', 'stringArray', false),
      f('trustLevels', 'stringArray', false),
      f('assetIds', 'stringArray', false),
      f('includeReasoning', 'boolean', false),
      f('limit', 'number', false),
    ],
    invoke: call('memory', 'searchMemory', 'object'),
  },
  readMemory: {
    kind: 'read',
    lock: 'none',
    operator: true,
    // 读取**要求理由**：§8.3 要求每次读取记入访问审计，而审计里没有理由就没法解释
    reason: true,
    // 人类动作**不要求理由**（2026-10-05 人类明确要求）：操作者与时间照记，理由填了留痕、不填为空串。
    reasonOptional: true,
    fields: [
      f('engagementId', 'string'),
      f('refs', 'stringArray'),
    ],
    invoke: call('memory', 'readMemory', 'object'),
  },
  memoryWatermark: {
    kind: 'read',
    lock: 'none',
    operator: false,
    reason: false,
    fields: [f('engagementId', 'string')],
    invoke: call('memory', 'memoryWatermark', { scalar: 'engagementId' }),
  },
  // 账本完整性校验（§8.4）：只读、无副作用，因此不要求理由（不写访问审计）。
  verifyLedger: {
    kind: 'read',
    lock: 'none',
    operator: false,
    reason: false,
    fields: [f('engagementId', 'string')],
    invoke: call('memory', 'verifyLedger', { scalar: 'engagementId' }),
  },
};

/** 诊断面（§15.5/§15.1）：只读聚合。 */
const DIAGNOSTICS_METHOD_TABLE: Record<keyof PentestDiagnosticsService, ConsoleMethodSpec> = {
  getDiagnostics: {
    kind: 'read',
    lock: 'none',
    operator: false,
    reason: false,
    // engagementId 可选：未选作业时仍可看实例级事实（连接池、审计探针）。
    fields: [f('engagementId', 'string', false)],
    invoke: call('diagnostics', 'getDiagnostics', 'object'),
  },
};

/**
 * skill 库面（§2.2）。
 *
 * **写操作要求理由且记审计**：skill 正文是 Agent 会遵循的**指令文本**，
 * 增删改等于改动 Agent 行为，必须留下「谁在什么时候改了什么」。
 */
const SKILL_METHOD_TABLE: Record<keyof PentestSkillService, ConsoleMethodSpec> = {
  listSkills: {
    kind: 'read',
    lock: 'none',
    operator: false,
    reason: false,
    fields: [f('enabledOnly', 'boolean', false)],
    invoke: call('skills', 'listSkills', 'object'),
  },
  addSkill: {
    kind: 'mutation',
    lock: 'none',
    operator: true,
    reason: true,
    // 人类动作**不要求理由**（2026-10-05 人类明确要求）：操作者与时间照记，理由填了留痕、不填为空串。
    reasonOptional: true,
    fields: [
      f('name', 'string'),
      f('description', 'string'),
      f('body', 'string'),
    ],
    invoke: call('skills', 'addSkill', 'object'),
  },
  updateSkill: {
    kind: 'mutation',
    lock: 'none',
    operator: true,
    reason: true,
    // 人类动作**不要求理由**（2026-10-05 人类明确要求）：操作者与时间照记，理由填了留痕、不填为空串。
    reasonOptional: true,
    fields: [
      f('skillId', 'string'),
      f('name', 'string', false),
      f('description', 'string', false),
      f('body', 'string', false),
      f('disabled', 'boolean', false),
    ],
    invoke: call('skills', 'updateSkill', 'object'),
  },
  removeSkill: {
    kind: 'mutation',
    lock: 'none',
    operator: true,
    reason: true,
    // 人类动作**不要求理由**（2026-10-05 人类明确要求）：操作者与时间照记，理由填了留痕、不填为空串。
    reasonOptional: true,
    fields: [f('skillId', 'string')],
    invoke: call('skills', 'removeSkill', 'object'),
  },
};

/**
 * 合并后的端点表。
 *
 * **重名检查是必需的，不是防御性编程**：`{...a, ...b}` 在重名时后者静默胜出，
 * 于是「report.listSkills 被 skills.listSkills 覆盖」这种错误不会报错，
 * 只会让某个端点在运行时调用到另一个服务面的方法。TS 的 spread 不检查这个。
 */
const METHOD_TABLE: Record<string, ConsoleMethodSpec> = (() => {
  const faces: readonly (readonly [string, Record<string, ConsoleMethodSpec>])[] = [
    ['workflow', WORKFLOW_METHOD_TABLE],
    ['report', REPORT_METHOD_TABLE],
    ['memory', MEMORY_METHOD_TABLE],
    ['skills', SKILL_METHOD_TABLE],
    ['diagnostics', DIAGNOSTICS_METHOD_TABLE],
  ];
  const merged: Record<string, ConsoleMethodSpec> = {};
  const owner = new Map<string, string>();
  for (const [faceName, table] of faces) {
    for (const [methodName, spec] of Object.entries(table)) {
      const existing = owner.get(methodName);
      if (existing !== undefined) {
        throw new Error(
          `控制台端点名冲突：${methodName} 同时存在于 ${existing} 与 ${faceName} 两个服务面。` +
            `扁平 RPC 面要求方法名全局唯一——请给其中一个加前缀（例如 listSkills 而非 list）。`,
        );
      }
      owner.set(methodName, faceName);
      // 加载期检查：标量形状的端点不得同时依赖派生字段（见该函数的说明）。
      assertScalarShapeIsSafe(methodName, spec);
      merged[methodName] = spec;
    }
  }
  return merged;
})();

/**
 * 加载期对齐：零依赖端点清单（`method-names.ts`）必须与方法表**逐字一致**（两向）。
 *
 * 清单是客户端视图**值导入**的那个模块——视图只需要「这个名字是不是端点」这一个事实，
 * 而本模块的实现链会拉到 `node:crypto`（会话摘要）。它一旦与表漂移，视图就会按错的
 * 名字探测端点（表现为功能「莫名不可用」或「点了 404」）；因此把漂移做成启动即失败。
 */
function assertMethodNamesAligned(): void {
  const tableNames = Object.keys(METHOD_TABLE);
  const missing = CONSOLE_METHOD_NAMES.filter((name) => !tableNames.includes(name));
  const extra = tableNames.filter((name) => !(CONSOLE_METHOD_NAMES as readonly string[]).includes(name));
  if (missing.length > 0 || extra.length > 0) {
    throw new Error(
      '控制台端点清单与方法表不一致（method-names.ts ↔ rpc.ts）：' +
        `清单缺失 [${missing.join(', ')}]，表内多余 [${extra.join(', ')}]`,
    );
  }
}

assertMethodNamesAligned();

/** 暴露的端点名（声明序近似 §16.1 的列出顺序，按服务面分组）。 */
export const CONSOLE_RPC_METHODS: readonly ConsoleMethodName[] = CONSOLE_METHOD_NAMES;

/**
 * 查方法表，返回 `null` 表示端点不存在。
 *
 * **为什么要一个查表函数而不是「先 isConsoleMethod 再索引」**：合并后的表是
 * `Record<string, ConsoleMethodSpec>`，在 `noUncheckedIndexedAccess` 下索引结果
 * 恒为 `Spec | undefined`——类型系统在说真话（宽索引表可能有缺失键）。
 * 用查表函数把「判断 + 再查一次」合成一次操作：调用处窄化一次即可，
 * 既少一次哈希查找，也不必写断言。
 */
export function lookupConsoleMethod(name: string): ConsoleMethodSpec | null {
  const spec: ConsoleMethodSpec | undefined = METHOD_TABLE[name];
  return spec ?? null;
}

/** 方法表的一行：供 UI 渲染"该操作是否需要版本/理由/幂等键"，也供测试锁定方法集。 */
export interface ConsoleMethodDescription {
  readonly name: ConsoleMethodName;
  readonly kind: 'read' | 'mutation';
  readonly lock: ConsoleLockKind;
  readonly operator: boolean;
  readonly reason: boolean;
  readonly fields: readonly ConsoleParamSpec[];
}

/** 导出方法表快照（结构化数组，便于 UI 与测试消费）。 */
export function describeConsoleMethods(): readonly ConsoleMethodDescription[] {
  // 遍历 entries 而不是「先取键、再回表查」：后者在宽索引表下需要四次 undefined
  // 守卫，而 entries 已经给出了确定存在的 (key, spec) 对。
  return Object.entries(METHOD_TABLE)
    .filter((entry): entry is [ConsoleMethodName, ConsoleMethodSpec] => isConsoleMethod(entry[0]))
    .map(([name, spec]) => ({
      name,
      kind: spec.kind,
      lock: spec.lock,
      operator: spec.operator,
      reason: spec.reason,
      fields: spec.fields,
    }));
}

// ───────────────────────────── 规范 JSON 与摘要 ─────────────────────────────

/**
 * 确定性 JSON 序列化（键按码元升序、无空白）。
 *
 * 为什么要自己写：账本的 `canonicalize()`（`memory/hash.ts`）签名钉死在
 * `EventHashPayload` 上，不是通用序列化器；把它放宽会动到账本哈希的覆盖字段集
 * （协议版本变更，§9.1）。这里只需要"请求体的规范文本"，且纪律与账本一致：
 *
 * - 对象的 `undefined` 值**按键丢弃**——`JSON.stringify` 就是这么做的，
 *   丢弃才能让进程内调用与过线调用得到同一个摘要（否则同一次操作在两条路径上哈希不同）；
 * - **数组里的 `undefined` 拒绝**（`JSON.stringify` 会把它变成 `null`，那是有损的）；
 * - 非有限数、`bigint`、`symbol`、函数、循环引用，以及一切非平凡对象
 *   （`Date` / `Map` / `Set` / 类实例）一律拒绝：静默丢弃等于给幂等键开洞，
 *   两个不同的请求体会撞成同一个摘要。
 */
function canonicalJson(value: unknown, path: string, seen: Set<object>): string {
  if (value === null) return 'null';
  switch (typeof value) {
    case 'boolean':
      return value ? 'true' : 'false';
    case 'string':
      return JSON.stringify(value);
    case 'number':
      if (!Number.isFinite(value)) {
        throw new ConsoleRpcFault('console/argument-invalid', `${path} 不是有限数：${String(value)}`);
      }
      return JSON.stringify(Object.is(value, -0) ? 0 : value);
    case 'undefined':
      throw new ConsoleRpcFault('console/argument-invalid', `${path} 是 undefined；JSON 没有这个值`);
    case 'bigint':
    case 'symbol':
    case 'function':
      throw new ConsoleRpcFault('console/argument-invalid', `${path} 不是 JSON 值（${typeof value}）`);
    default:
      break;
  }

  const object = value as object;
  if (seen.has(object)) {
    throw new ConsoleRpcFault('console/argument-invalid', `${path} 存在循环引用`);
  }
  seen.add(object);
  try {
    if (Array.isArray(object)) {
      const items: string[] = [];
      for (let index = 0; index < object.length; index += 1) {
        // 未赋值的槽位（稀疏数组）取值为 undefined，由 canonicalJson 拒绝。
        items.push(canonicalJson(object[index], `${path}[${index}]`, seen));
      }
      return `[${items.join(',')}]`;
    }
    const proto: unknown = Object.getPrototypeOf(object);
    if (proto !== Object.prototype && proto !== null) {
      throw new ConsoleRpcFault(
        'console/argument-invalid',
        `${path} 不是平凡对象（${Object.prototype.toString.call(object)}）；请传 JSON 值`,
      );
    }
    const record = object as Record<string, unknown>;
    const parts: string[] = [];
    for (const key of Object.keys(record).sort()) {
      const entry = record[key];
      if (entry === undefined) continue; // 与 JSON.stringify 一致：整个键消失
      parts.push(`${JSON.stringify(key)}:${canonicalJson(entry, `${path}.${key}`, seen)}`);
    }
    return `{${parts.join(',')}}`;
  } finally {
    seen.delete(object);
  }
}

/** 幂等体的摘要：覆盖**全部**参与语义的字段，任一变化都必须改变键。 */
function bodyDigest(input: {
  readonly method: string;
  readonly params: Readonly<Record<string, unknown>>;
  readonly expectedStateVersion: number | null;
  readonly reason: string | null;
}): string {
  const canonical = canonicalJson(
    {
      method: input.method,
      params: input.params,
      expectedStateVersion: input.expectedStateVersion,
      reason: input.reason,
    },
    '$',
    new Set<object>(),
  );
  return sha256Hex(canonical);
}

// ───────────────────────────── 依赖 ─────────────────────────────

/**
 * 控制台可调用的四个服务面。
 *
 * **四个面是必需的**，不设可选：控制台的八个面板各自依赖其中至少一个
 * （报告审阅用 report、记忆浏览器用 memory、skill 库用 skills、其余用 workflow）。
 * 允许省略某个面只会让「某个面板静默没有数据」变成合法状态——那正是
 * 此前多个视图不得不自带「端点缺口」提示的原因。
 *
 * 装配方若要临时缺省某个面，应传一个**每方法都抛错**的桩（见 `compose.ts` 的做法），
 * 而不是省略它：抛错会在调用时立刻可见，省略只会让端点凭空消失。
 */
export interface ConsoleServices {
  readonly workflow: HumanWorkflowService;
  readonly report: PentestReportService;
  readonly memory: PentestMemoryQueryService;
  readonly skills: PentestSkillService;
  readonly diagnostics: PentestDiagnosticsService;
}

export interface ConsoleRpcDeps {
  /** 四个服务面（见 {@link ConsoleServices}）。 */
  readonly services: ConsoleServices;
  /**
   * 幂等记录上限（默认 512）。控制台操作是低频人工操作，进程内保留最近若干条足够；
   * 超出后按插入序淘汰最旧的一条。跨进程/跨重启的持久化需要一张专门的表
   * （当前迁移里没有 console 侧的幂等表，故本层不假装有）。
   */
  readonly maxIdempotencyRecords?: number;
  /**
   * 非契约错误的落点。RPC 层不注入 logger（避免发明宿主不提供的通道），
   * 由适配器在这里接自己的日志，并负责把原始错误记全。
   */
  readonly onInternalError?: (error: unknown, context: { readonly method: string | null }) => void;
  /**
   * RLS 作用域运行器。
   *
   * 控制台是**人工作业的入口**：请求参数里带着 `engagementId` / `workerSessionId`
   * （方法表已声明这两个字段），本层据此为整个调用建立作用域。
   *
   * 不在这一层建立的话，服务方法内部的 `#db.query(...)` 会落在**租户级**作用域上——
   * 那里 `engagements` 行仍可见（`app_tenant_read`），但 `worker_sessions` 之类
   * engagement 作用域的表一行都读不到，结果是「列表能看、详情全空」这种半死状态。
   *
   * 省略即不做作用域管理（单测里的假服务面、迁移连接）。
   */
  readonly rls?: {
    run<T>(
      scope: { readonly engagementId?: string | null; readonly workerSessionId?: string | null },
      work: () => Promise<T>,
    ): Promise<T>;
  };
  /**
   * worker 会话 → engagement 反查。只带 `workerSessionId` 的端点需要它来建作用域。
   * 省略时那些端点落在租户级作用域，服务会以明确的准入错误拒绝。
   */
  readonly resolveEngagement?: (workerSessionId: string) => Promise<string | null>;
}

interface IdempotencyRecord {
  readonly digest: string;
  readonly response: ConsoleOk;
}

const DEFAULT_MAX_IDEMPOTENCY_RECORDS = 512;

/** 信封允许的键。静态字符串键查表用 Record，不用数组 includes。 */
const ENVELOPE_KEYS: Record<string, true> = {
  method: true,
  params: true,
  expectedStateVersion: true,
  reason: true,
  idempotencyKey: true,
};

/**
 * 请求体里禁止出现的身份键。
 *
 * 它们是**传输层的越权尝试**信号：操作者身份只能由宿主在 `CallContext` 注入，
 * 请求体里带这两个键（含 snake_case 变体）一律拒绝，而不是忽略。
 */
const IDENTITY_KEYS: readonly string[] = ['operatorId', 'operator_id'];

/** 幂等冲突的说明文本：三处报告同一个客户端 bug，措辞必须一致。 */
const IDEMPOTENCY_CONFLICT_MESSAGE =
  '同一幂等键已用于另一个请求体：这是客户端 bug（幂等键必须唯一标识一次操作），不能当作重试。';

// ───────────────────────────── 主体 ─────────────────────────────

/**
 * 控制台 RPC 端点。
 *
 * 用法（适配器）：把已解码的请求体与**宿主注入的**调用上下文交给 {@link handle}，
 * 把返回的响应对象原样写回传输层。
 *
 * ```ts
 * // 例如接 ctx.webServer.register({ kind: 'prefix', path: '/api/pentest', handler })
 * const body: unknown = JSON.parse(await readAll(req));
 * const context: CallContext = { operatorId: req.operatorId, authenticatedAt: ..., source: 'web-console' };
 * const response = await rpc.handle(body, context);
 * res.writeHead(response.ok ? 200 : 409, { 'content-type': 'application/json' });
 * res.end(JSON.stringify(response));
 * ```
 *
 * `handle` **不抛异常**：每个失败都以结构化响应返回。传输适配器因此不必包 try/catch，
 * 也不会让一个坏请求打断宿主的请求处理循环。
 */
export class ConsoleRpc {
  readonly #services: ConsoleServices;
  readonly #maxRecords: number;
  readonly #onInternalError: ConsoleRpcDeps['onInternalError'];
  readonly #rls: ConsoleRpcDeps['rls'];
  readonly #resolveEngagement: ConsoleRpcDeps['resolveEngagement'];
  /** 已完成的幂等记录，键为 `operatorId \u001f idempotencyKey`。 */
  readonly #records = new Map<string, IdempotencyRecord>();
  /** 在途请求：同 key 同体的并发调用共享同一次执行。 */
  readonly #inFlight = new Map<string, { readonly digest: string; readonly promise: Promise<ConsoleResponse> }>();

  constructor(deps: ConsoleRpcDeps) {
    this.#services = deps.services;
    this.#maxRecords = deps.maxIdempotencyRecords ?? DEFAULT_MAX_IDEMPOTENCY_RECORDS;
    this.#onInternalError = deps.onInternalError;
    this.#rls = deps.rls;
    this.#resolveEngagement = deps.resolveEngagement;
  }

  /**
   * 处理一次调用。`request` 声明为 `unknown` 是刻意的：它是不可信输入，
   * 类型标注不能代替校验。
   */
  async handle(request: unknown, context: CallContext): Promise<ConsoleResponse> {
    let method: string | null = null;
    try {
      // 校验顺序是刻意的，从"这甚至不是一个请求"到"这个方法不该被调用"：
      // 信封形状 → 身份边界 → 传输上下文 → 端点是否存在 → 该端点的前置要求。
      // 身份边界排在端点解析之前：伪造操作者是传输层违规，不是某个端点的问题。
      method = envelopeMethod(request);
      const body = request as Record<string, unknown>;
      if (method === null) {
        throw new ConsoleRpcFault('console/envelope-invalid', '缺少 method');
      }
      // 顺序是刻意的：**身份边界先于信封键校验**。
      //
      // 若先校验信封键，携带 operatorId 的请求会得到「信封不允许键 operatorId」，
      // 而那把一次**越权尝试**降级成了一次**格式错误**——运维与安全审计看不到
      // 「有人在试图伪造身份」这个事实。身份违规必须用它自己的码报告。
      rejectIdentityInBody(body);
      assertAllowedEnvelopeKeys(body);
      const actor = requireCallContext(context);
      if (!isConsoleMethod(method)) {
        // Worker 面与状态机内部方法（如 finishWorker）落到这里：不是"未实现"，
        // 而是**不属于控制台面**，永不导出。
        throw new ConsoleRpcFault('console/method-unavailable', `控制台未导出端点：${method}`);
      }
      // 窄化后的值存成 const：`#withScope` 的回调是闭包，而 `let method` 的窄化
      // 不会跨闭包保持（TS 会退回 `string | null`）。
      const resolved = method;
      return await this.#withScope(body, () => this.#dispatch(resolved, body, actor));
    } catch (error) {
      return await this.#failure(method, error);
    }
  }

  /**
   * 按请求参数建立 RLS 作用域，再执行调用。
   *
   * 服务方法**签名里收 `engagementId`**，但那个参数只用于 SQL 谓词；RLS 的会话变量
   * 来自上下文，不是参数。因此这里必须显式建立：否则 `worker_sessions` 这类
   * engagement 作用域的表在租户级上下文下一行都读不到，表现为「列表能看、详情全空」。
   *
   * 作用域来源按端点的入参形状分两类：
   *
   *   - 带 `engagementId`：直接用它。
   *   - 只带 `workerSessionId`（`extendBudget` / `interject` / `requestHandoffDraft`）：
   *     经 `resolveEngagement` 反查。这不是可有可无的便利——那几个端点的服务实现
   *     第一件事就是按会话读 `worker_sessions` 拿 engagement，没有作用域就什么都读不到。
   */
  async #withScope(body: Record<string, unknown>, work: () => Promise<ConsoleResponse>): Promise<ConsoleResponse> {
    const scopes = this.#rls;
    if (scopes === undefined) return work();
    const params = readParams(body);
    const rawEngagement = params?.['engagementId'];
    const rawSession = params?.['workerSessionId'];
    const workerSessionId = typeof rawSession === 'string' && rawSession.length > 0 ? rawSession : null;
    let engagementId = typeof rawEngagement === 'string' && rawEngagement.length > 0 ? rawEngagement : null;
    if (engagementId === null && workerSessionId !== null && this.#resolveEngagement !== undefined) {
      engagementId = await this.#resolveEngagement(workerSessionId);
    }
    // 反查不到、也没有 engagementId：落在租户级作用域。服务会在自己的准入里
    // 明确拒绝（例如租约反查返回 null），不会读错作业。
    if (engagementId === null) return work();
    return scopes.run({ engagementId, workerSessionId }, work);
  }

  // ── 分发 ──

  async #dispatch(
    method: ConsoleMethodName,
    body: Record<string, unknown>,
    actor: CallContext,
  ): Promise<ConsoleResponse> {
    const spec = lookupConsoleMethod(method);
    if (spec === null) {
      // 到这里说明 isConsoleMethod 与 lookup 的判定不一致（不可能，但类型上必须处理）。
      // fail loud 好过继续用 undefined。
      throw new ConsoleRpcFault('console/method-unavailable', `端点 ${method} 不存在于方法表`);
    }
    const params = readParams(body);
    const expectedStateVersion = readStateVersion(body, spec, method);
    const reason = readReason(body, spec, method);

    // 先做一次规范序列化：非 JSON 参数（函数、Date、循环引用…）在这里就被拒，
    // 而不是等到服务里变成一行 jsonb 才发现。摘要同时用于幂等比对。
    const digest = bodyDigest({
      method,
      params,
      expectedStateVersion,
      reason,
    });

    const input = buildInput(spec, params, method, actor, reason, expectedStateVersion);

    if (spec.kind === 'read') {
      // 读不参与幂等：不记录、不回放（带上键也不拒绝——统一客户端总会带一个）。
      return await this.#run(method, params, () => spec.invoke(this.#services, input));
    }

    const idempotencyKey = requireIdempotencyKey(body, method);
    const scope = `${actor.operatorId}\u001f${idempotencyKey}`;
    const recorded = this.#records.get(scope);
    if (recorded !== undefined) {
      if (recorded.digest !== digest) {
        throw new ConsoleRpcFault('console/idempotency-conflict', IDEMPOTENCY_CONFLICT_MESSAGE);
      }
      return { ...recorded.response, replay: true };
    }

    const pending = this.#inFlight.get(scope);
    if (pending !== undefined) {
      if (pending.digest !== digest) {
        throw new ConsoleRpcFault('console/idempotency-conflict', IDEMPOTENCY_CONFLICT_MESSAGE);
      }
      // 同一时刻的同一请求共享同一次执行：第二个调用者拿到的是首次结果，且未执行。
      const shared = await pending.promise;
      return shared.ok ? { ...shared, replay: true } : shared;
    }

    const promise = this.#run(method, params, () => spec.invoke(this.#services, input));
    this.#inFlight.set(scope, { digest, promise });
    try {
      const response = await promise;
      // 只有成功才落记录：失败没有被提交的状态可复用，而把 stale_state_version
      // 记成永久结果会让客户端刷新版本后再也用不了同一个键。
      if (response.ok) this.#remember(scope, { digest, response });
      return response;
    } finally {
      this.#inFlight.delete(scope);
    }
  }

  /** 执行一次并映射失败。 */
  async #run(
    method: ConsoleMethodName,
    params: Readonly<Record<string, unknown>>,
    invoke: () => Promise<unknown>,
  ): Promise<ConsoleResponse> {
    try {
      return { ok: true, method, result: await invoke(), replay: false };
    } catch (error) {
      // 上报由 #failure 负责（单一落点）；此处不再重复，避免同一故障记两遍。
      return await this.#failure(method, error, params);
    }
  }

  #remember(scope: string, record: IdempotencyRecord): void {
    this.#records.set(scope, record);
    if (this.#records.size <= this.#maxRecords) return;
    // Map 保持插入序：删掉最旧的一条即可。
    const oldest = this.#records.keys().next();
    if (oldest.done !== true) this.#records.delete(oldest.value);
  }

  // ── 失败映射 ──

  async #failure(
    method: string | null,
    error: unknown,
    params?: Readonly<Record<string, unknown>>,
  ): Promise<ConsoleFailure> {
    if (error instanceof ConsoleRpcFault) {
      return { ok: false, method, code: error.code, message: error.message };
    }
    const code = contractErrorCode(error);
    if (code === undefined) {
      // 非契约错误：细节只进宿主日志（可能含连接串等敏感信息），响应只给稳定码。
      //
      // 上报**只在这里**发生：`#run` 不再重复上报，否则同一次内部错误会被记两遍
      // （调用方看起来是"两个故障"，实际只有一个）。
      this.#onInternalError?.(error, { method });
      return {
        ok: false,
        method,
        code: 'console/internal',
        message: '控制台调用未完成：内部错误。原始细节见宿主日志。',
      };
    }
    const message = errorMessage(error) ?? code;
    const failure: ConsoleFailure = { ok: false, method, code, message };
    if (code !== 'stale_state_version') return failure;
    // §15.4：冲突时把最新状态一并带回，界面不必再发一次读请求就能重新渲染。
    // 仅当请求体里有 engagementId 时可取（`extendBudget` 只带 workerSessionId，
    // 而 `HumanWorkflowService` 没有"按会话查 engagement"的读方法，故不带状态）。
    const engagementId = params === undefined ? undefined : params['engagementId'];
    if (typeof engagementId !== 'string') return failure;
    try {
      return { ...failure, state: await this.#services.workflow.getState(engagementId) };
    } catch {
      // 快照是尽力而为的附加信息：取不到不改变"这次操作已被拒绝"这个结论。
      return failure;
    }
  }
}

// ───────────────────────────── 校验 ─────────────────────────────

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/** 读出信封里的 method；缺失/类型不符返回 null（由调用点决定报什么错）。 */
function envelopeMethod(request: unknown): string | null {
  if (!isPlainObject(request)) {
    throw new ConsoleRpcFault('console/envelope-invalid', '请求体必须是 JSON 对象');
  }
  const method = request['method'];
  if (method === undefined || method === null) return null;
  if (typeof method !== 'string' || method === '') {
    throw new ConsoleRpcFault('console/envelope-invalid', 'method 必须是非空字符串');
  }
  return method;
}

/** 信封顶层只允许声明的键：多余键说明客户端与服务端对契约的理解已经分叉。 */
function assertAllowedEnvelopeKeys(body: Record<string, unknown>): void {
  for (const key of Object.keys(body)) {
    if (Object.hasOwn(ENVELOPE_KEYS, key)) continue;
    throw new ConsoleRpcFault(
      'console/envelope-invalid',
      `信封不允许键 ${JSON.stringify(key)}；方法参数放进 params。`,
    );
  }
}

/**
 * 身份边界的检查，**先于**方法解析与参数校验：伪造身份是传输层的违规，
 * 不是某个端点的问题，因此必须优先、且用专属码报告。
 */
function rejectIdentityInBody(body: Record<string, unknown>): void {
  const params = body['params'];
  for (const key of IDENTITY_KEYS) {
    if (Object.hasOwn(body, key)) {
      throw new ConsoleRpcFault(
        'console/operator-forbidden',
        `请求体不能携带 ${key}：操作者身份由传输层注入，客户端提供的一律不可信。`,
      );
    }
    if (isPlainObject(params) && Object.hasOwn(params, key)) {
      throw new ConsoleRpcFault(
        'console/operator-forbidden',
        `params 不能携带 ${key}：操作者身份由传输层注入，客户端提供的一律不可信。`,
      );
    }
  }
}

function requireCallContext(context: CallContext): CallContext {
  if (context === null || typeof context !== 'object') {
    throw new ConsoleRpcFault('console/context-invalid', '缺少调用上下文');
  }
  if (typeof context.operatorId !== 'string' || context.operatorId.trim() === '') {
    throw new ConsoleRpcFault('console/context-invalid', '调用上下文缺少 operatorId');
  }
  if (!(context.authenticatedAt instanceof Date) || Number.isNaN(context.authenticatedAt.getTime())) {
    throw new ConsoleRpcFault('console/context-invalid', '调用上下文的 authenticatedAt 不是有效时刻');
  }
  if (typeof context.source !== 'string' || context.source.trim() === '') {
    throw new ConsoleRpcFault('console/context-invalid', '调用上下文缺少 source');
  }
  return context;
}

/**
 * 读幂等键。
 *
 * **写操作必须有它**（§15.3「所有控制台操作带幂等标识与期望状态版本」）：
 * 没有键就无法区分「用户重复点击」与「用户有意做两次」——而后者在渗透场景里
 * 可能意味着再打一次目标。因此缺失即拒绝，不默认生成一个。
 */
function requireIdempotencyKey(body: Record<string, unknown>, method: ConsoleMethodName): string {
  const raw = body['idempotency_key'] ?? body['idempotencyKey'];
  if (typeof raw !== 'string' || raw.trim().length === 0) {
    throw new ConsoleRpcFault(
      'console/envelope-invalid',
      `${method} 是写操作，必须携带非空的 idempotency_key；` +
        `缺失时无法区分重复点击与有意重复（§15.3）`,
    );
  }
  return raw;
}

function readParams(body: Record<string, unknown>): Record<string, unknown> {
  const params = body['params'];
  if (params === undefined || params === null) return {};
  if (!isPlainObject(params)) {
    throw new ConsoleRpcFault('console/envelope-invalid', 'params 必须是 JSON 对象');
  }
  return params;
}

function readStateVersion(
  body: Record<string, unknown>,
  spec: ConsoleMethodSpec,
  method: ConsoleMethodName,
): number | null {
  if (spec.lock === 'none') return null;
  const value = body['expectedStateVersion'];
  if (value === undefined || value === null) {
    // 不是"默认 0"：静默默认会让 §15.4 的并发保护消失。
    throw new ConsoleRpcFault(
      'console/state-version-required',
      `${method} 必须携带 expectedStateVersion：缺失会被当成"基于版本 0"，从而静默覆盖别人的修改。`,
    );
  }
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new ConsoleRpcFault(
      'console/argument-invalid',
      `expectedStateVersion 必须是非负安全整数，得到 ${JSON.stringify(value)}`,
    );
  }
  return value;
}

function readReason(
  body: Record<string, unknown>,
  spec: ConsoleMethodSpec,
  method: ConsoleMethodName,
): string | null {
  if (!spec.reason) return null;
  const value = body['reason'];
  if (typeof value !== 'string') {
    // 形状仍是硬的：`reason` 要么不出现，要么是字符串（`''` 合法）——这保证输入可解释。
    throw new ConsoleRpcFault('console/reason-required', `${method} 的 reason 必须是字符串`);
  }
  if (value.trim() === '' && spec.reasonOptional !== true) {
    // 只强制"人类写了理由"这一结构事实；"强制跳转必须有实质理由"由服务判定
    // （`forced_reason_required`），语义判断只在一个地方做。
    throw new ConsoleRpcFault('console/reason-required', `${method} 必须携带非空 reason`);
  }
  return value;
}

// ───────────────────────────── 参数校验与输入拼装 ─────────────────────────────

function buildInput(
  spec: ConsoleMethodSpec,
  params: Record<string, unknown>,
  method: ConsoleMethodName,
  actor: CallContext,
  reason: string | null,
  expectedStateVersion: number | null,
): Record<string, unknown> {
  const input: Record<string, unknown> = {};
  const declared = new Set<string>([...spec.fields.map((field) => field.name), 'expectedStateVersion']);

  for (const key of Object.keys(params)) {
    if (!declared.has(key)) {
      throw new ConsoleRpcFault(
        'console/argument-invalid',
        `${method} 不认识参数 ${JSON.stringify(key)}；未声明的键一律拒绝（静默忽略会让客户端以为它生效了）。`,
      );
    }
  }

  for (const field of spec.fields) {
    const value = params[field.name];
    if (value === undefined || value === null) {
      if (field.required && value === undefined) {
        throw new ConsoleRpcFault('console/argument-invalid', `${method} 缺少参数 ${field.name}`);
      }
      if (value === null && field.kind !== 'stringOrNull') {
        throw new ConsoleRpcFault('console/argument-invalid', `${method} 的参数 ${field.name} 不能为 null`);
      }
      if (value === null) input[field.name] = null;
      continue;
    }
    input[field.name] = checkValue(field, value, method);
  }

  if (spec.operator) input['operatorId'] = actor.operatorId;
  if (reason !== null) input['reason'] = reason;
  if (expectedStateVersion !== null && spec.lock === 'actor') {
    // 只有服务确实消费这个字段时才放进输入：对 `lock: 'envelope'` 的方法，
    // 输入契约里没有它，塞进去只会制造"已经加锁了"的错觉。
    input['expectedStateVersion'] = expectedStateVersion;
  }
  return input;
}

function checkValue(field: ConsoleParamSpec, value: unknown, method: ConsoleMethodName): unknown {
  const where = `${method}.${field.name}`;
  const bad = (why: string): ConsoleRpcFault =>
    new ConsoleRpcFault('console/argument-invalid', `${where} ${why}`);
  switch (field.kind) {
    case 'string':
      if (typeof value !== 'string' || value === '') throw bad('必须是非空字符串');
      return value;
    case 'stringAllowEmpty':
      if (typeof value !== 'string') throw bad('必须是字符串');
      return value;
    case 'stringOrNull':
      if (typeof value !== 'string') throw bad('必须是字符串');
      return value;
    case 'boolean':
      if (typeof value !== 'boolean') throw bad('必须是布尔值');
      return value;
    case 'number':
      if (typeof value !== 'number' || !Number.isFinite(value)) throw bad('必须是有限数');
      return value;
    case 'phase':
      if (!isPhase(value)) throw bad('不是合法阶段');
      return value;
    case 'stringArray': {
      if (!Array.isArray(value)) throw bad('必须是数组');
      for (const item of value) {
        if (typeof item !== 'string' || item === '') throw bad('的元素必须是非空字符串');
      }
      return [...value];
    }
    case 'actionClassArray': {
      if (!Array.isArray(value)) throw bad('必须是数组');
      for (const item of value) {
        if (typeof item !== 'string' || !(ACTION_CLASSES as readonly string[]).includes(item)) {
          throw bad(`含未知动作类别 ${JSON.stringify(item)}`);
        }
      }
      return [...value];
    }
    case 'array':
      if (!Array.isArray(value)) throw bad('必须是数组');
      return value;
    case 'budget': {
      if (!isPlainObject(value)) throw bad('必须是对象');
      const keys = Object.keys(value).sort();
      if (keys.join(',') !== 'maxSeconds,maxSteps,maxTokens') {
        throw bad('的键必须恰好是 maxTokens、maxSteps、maxSeconds');
      }
      for (const key of keys) {
        const item = value[key];
        if (typeof item !== 'number' || !Number.isFinite(item) || item <= 0) {
          throw bad(`的 ${key} 必须是正有限数`);
        }
      }
      return { maxTokens: value['maxTokens'], maxSteps: value['maxSteps'], maxSeconds: value['maxSeconds'] };
    }
    case 'json':
      // 深层的 JSON 合法性由规范序列化保证（非 JSON 值在那里被拒）。
      return value;
    default:
      throw bad('类型未知');
  }
}

// ───────────────────────────── 契约错误码识别 ─────────────────────────────

function isErrorCode(value: unknown): value is ErrorCode {
  return typeof value === 'string' && (ERROR_CODES as readonly string[]).includes(value);
}

/**
 * 从任意抛出物里取出契约错误码。
 *
 * 用**结构化识别**而不是 `instanceof WorkflowRejection`：契约只承诺"失败携带稳定
 * `ErrorCode`"（§16.5），并不承诺实现类。这个判据让控制台层只依赖 `contracts.ts`，
 * 不依赖 `PgWorkflowService`，同时天然覆盖同族的 `LedgerError`
 * （`audit_unavailable` 也是契约码，UI 同样该据码分支）。
 * 注意 PostgreSQL 的错误对象也带 `code`（SQLSTATE，如 `23505`），
 * 因此必须做**取值域成员检查**，否则数据库错误会被误当成业务拒绝。
 */
function contractErrorCode(error: unknown): ErrorCode | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const code = (error as { readonly code?: unknown }).code;
  return isErrorCode(code) ? code : undefined;
}

function errorMessage(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const message = (error as { readonly message?: unknown }).message;
  return typeof message === 'string' && message !== '' ? message : undefined;
}
