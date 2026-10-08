/**
 * 控制台端点的 **Typert Gateway 门面**（§16.1 的 `/api` 传输）。
 *
 * ── 为什么需要这一层 ──
 *
 * 宿主提供两个 RPC 注册面，本插件的控制台两条都走过：
 *
 *   1. `ctx.connection.rpc.handle(channel, handler)` —— 自建独立前缀通道。
 *      实测**不可用**：该方法内部是 `owner.effect(() => owner.webServer.register(route))`，
 *      而 `owner` 是 **connection 服务自己的 ctx**，其 `inject` 只有 `['credentials']`
 *      不含 `webServer`，于是属性读取直接抛
 *      `cannot get property "webServer" without inject`。对任何调用方都成立，
 *      属上游缺陷（官方生态里无人调用它）。
 *
 *   2. `ctx.connection.rpc.intercept('/api', matches, handler)` —— 共享网关。
 *      每通道**只允许一个** interceptor，已被 `typert-gateway` 占用；但它的
 *      `claimsEndpoint` 会遍历 `ctx.reflect.props` 里所有服务、读其 `typertRemote`
 *      绑定与 `@Remote` 标记，**自动认领** `namespace/method` 端点。这就是本文件。
 *
 * ── SRC 模式：零 codegen ──
 *
 * 官方 `TypertRemoteService` + `@Remote` 即足以让 `/api/<ns>/<method>` 可分发
 * （`resolveSrcDescriptor` 读函数源码取参数名、`{ mode: 'src-json' }` 弱描述符）。
 * 因此本插件**不提供** `./typert` 导出：一旦某 endpoint 有过严格描述符 commit，
 * `hasSeen` 会把它永久标脏，SRC 回退对该端点失效（直到进程重启）。
 *
 * ── 业务逻辑零重复 ──
 *
 * 每个方法都只做一件事：把信封交给**已经存在**的 {@link ConsoleRpc}。
 * 表驱动的校验、幂等、乐观锁、审计与错误码全部复用同一条路径——多个传输
 * （本门面、测试里的直接调用、将来的其它载体）共用一份判定，不会漂移。
 */

import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol';
import type { Context } from '@deepseek-ai/cordis';

import type { ConsoleRequest, ConsoleResponse } from './rpc.ts';
import { ConsoleRpc } from './rpc.ts';
import { CONSOLE_TYPRET_SERVICE } from './method-names.ts';

/**
 * 命名空间（= cordis 服务键）。定义在 `./rpc.ts` 以便客户端共用同一处——
 * 客户端要拼 `/api/<ns>/<method>`，两处各写一份必然漂移。
 */
export { CONSOLE_TYPRET_SERVICE } from './method-names.ts';

/** 操作者身份的来源（部署配置，见 `PluginConfig.operator` 的说明）。 */
interface ConsoleTypertOperator {
  readonly id: string;
  readonly source: string;
}

interface ConsoleTypertServiceOptions {
  readonly rpc: ConsoleRpc;
  readonly operator: ConsoleTypertOperator;
  /** 时钟注入，便于测试。 */
  readonly clock?: () => Date;
}

/**
 * 控制台端点的 Gateway 服务。
 *
 * 继承 `TypertRemoteService` 会做两件事：把服务注册到 cordis（`super(ctx, key)`），
 * 并把 `typertRemote` 绑定写在实例上——后者正是 `collectSrcClaims()` 扫描的对象。
 */
export class ConsoleTypertService extends TypertRemoteService {
  /**
   * 依赖用 TS `private`（**可擦除修饰符**）而**不是** `#` 语言级私有字段。
   *
   * 这不是风格选择，是硬约束：`TypertRemoteService extends Service`，而 cordis 会把
   * Service 实例包成 traceable 代理后交给调用方（网关用 `ctx.get(key)` 取它再
   * `Reflect.apply(method, receiver, args)`）。代理**能转发普通属性**（官方
   * `CredentialsController` 正是靠 `this.ctx.get(...)` 取依赖），但**无法转发
   * `#` 私有字段**——`this` 不是那个实例，读 `#` 会抛
   * `Cannot read private member #rpc from an object whose class did not declare it`。
   *
   * 实测踩过：最初用 `#rpc`，端点已能被网关认领、参数也校验通过，一到方法体就抛上面那句。
   */
  private readonly rpcImpl: ConsoleRpc;
  private readonly operatorInfo: ConsoleTypertOperator;
  private readonly clockImpl: () => Date;

  constructor(ctx: Context, options: ConsoleTypertServiceOptions) {
    super(ctx, CONSOLE_TYPRET_SERVICE);
    this.rpcImpl = options.rpc;
    this.operatorInfo = options.operator;
    this.clockImpl = options.clock ?? (() => new Date());
  }

  /**
   * 构造调用上下文。
   *
   * **操作者身份来自部署配置，不是请求**：共享网关的 handler 签名
   * `(endpoint, payload, signal)` 拿不到认证主体，宿主只提供「已认证」这个二元事实。
   * 这与自建通道那条路径的取值方式一致（见 `index.ts` 的 `config.operator`）。
   *
   * `authenticatedAt` 每次调用取当前时刻：网关路径没有 token 交换语义，
   * 只有「本次请求已通过围栏与 cookie 校验」这一个事实。
   */
  private contextOf(): { operatorId: string; authenticatedAt: Date; source: string } {
    return {
      operatorId: this.operatorInfo.id,
      authenticatedAt: this.clockImpl(),
      source: this.operatorInfo.source,
    };
  }

  /**
   * `createEngagement` —— 转发到 {@link ConsoleRpc.handle}。
   *
   * 参数名 `request` 是**线协议的一部分**：SRC 模式从函数源码解析参数名，网关据此校验
   * `payload.args` 的字段是否与之匹配（`assertExactArguments`），因此这个标识符不能随意改，
   * 也不能用解构/默认值/rest（会以 `gateway/signature-invalid` 被拒）。
   *
   * 注意有两层 `args`：**外层**是网关固定的 `payload = { args: … }` 容器，
   * **内层**才是本方法的具名参数表 `{ request: <信封> }`。实测踩过一次——
   * 只写一层时网关报 `args fields do not match the descriptor: unexpected "method", …`。
   */
  @Remote
  async createEngagement(request: ConsoleRequest): Promise<ConsoleResponse> {
    return this.rpcImpl.handle(request, this.contextOf());
  }

  @Remote
  async openTask(request: ConsoleRequest): Promise<ConsoleResponse> {
    return this.rpcImpl.handle(request, this.contextOf());
  }

  @Remote
  async getIntakeStatus(request: ConsoleRequest): Promise<ConsoleResponse> {
    return this.rpcImpl.handle(request, this.contextOf());
  }

  @Remote
  async getScopeProposal(request: ConsoleRequest): Promise<ConsoleResponse> {
    return this.rpcImpl.handle(request, this.contextOf());
  }

  @Remote
  async confirmScopeProposal(request: ConsoleRequest): Promise<ConsoleResponse> {
    return this.rpcImpl.handle(request, this.contextOf());
  }

  @Remote
  async rejectScopeProposal(request: ConsoleRequest): Promise<ConsoleResponse> {
    return this.rpcImpl.handle(request, this.contextOf());
  }

  /**
   * `listEngagements` —— 转发到 {@link ConsoleRpc.handle}。
   *
   * 参数名 `request` 是**线协议的一部分**：SRC 模式从函数源码解析参数名，网关据此校验
   * `payload.args` 的字段是否与之匹配（`assertExactArguments`），因此这个标识符不能随意改，
   * 也不能用解构/默认值/rest（会以 `gateway/signature-invalid` 被拒）。
   *
   * 注意有两层 `args`：**外层**是网关固定的 `payload = { args: … }` 容器，
   * **内层**才是本方法的具名参数表 `{ request: <信封> }`。实测踩过一次——
   * 只写一层时网关报 `args fields do not match the descriptor: unexpected "method", …`。
   */
  @Remote
  async listEngagements(request: ConsoleRequest): Promise<ConsoleResponse> {
    return this.rpcImpl.handle(request, this.contextOf());
  }

  /**
   * `listWorkerSessions` —— 转发到 {@link ConsoleRpc.handle}。
   *
   * 参数名 `request` 是**线协议的一部分**：SRC 模式从函数源码解析参数名，网关据此校验
   * `payload.args` 的字段是否与之匹配（`assertExactArguments`），因此这个标识符不能随意改，
   * 也不能用解构/默认值/rest（会以 `gateway/signature-invalid` 被拒）。
   *
   * 注意有两层 `args`：**外层**是网关固定的 `payload = { args: … }` 容器，
   * **内层**才是本方法的具名参数表 `{ request: <信封> }`。实测踩过一次——
   * 只写一层时网关报 `args fields do not match the descriptor: unexpected "method", …`。
   */
  @Remote
  async listWorkerSessions(request: ConsoleRequest): Promise<ConsoleResponse> {
    return this.rpcImpl.handle(request, this.contextOf());
  }

  /**
   * `getWorkerReport` —— 转发到 {@link ConsoleRpc.handle}。
   *
   * 参数名 `request` 是**线协议的一部分**：SRC 模式从函数源码解析参数名，网关据此校验
   * `payload.args` 的字段是否与之匹配（`assertExactArguments`），因此这个标识符不能随意改，
   * 也不能用解构/默认值/rest（会以 `gateway/signature-invalid` 被拒）。
   */
  @Remote
  async getWorkerReport(request: ConsoleRequest): Promise<ConsoleResponse> {
    return this.rpcImpl.handle(request, this.contextOf());
  }

  /**
   * `previewScope` —— 转发到 {@link ConsoleRpc.handle}。
   *
   * 参数名 `request` 是**线协议的一部分**：SRC 模式从函数源码解析参数名，网关据此校验
   * `payload.args` 的字段是否与之匹配（`assertExactArguments`），因此这个标识符不能随意改，
   * 也不能用解构/默认值/rest（会以 `gateway/signature-invalid` 被拒）。
   *
   * 注意有两层 `args`：**外层**是网关固定的 `payload = { args: … }` 容器，
   * **内层**才是本方法的具名参数表 `{ request: <信封> }`。实测踩过一次——
   * 只写一层时网关报 `args fields do not match the descriptor: unexpected "method", …`。
   */
  @Remote
  async previewScope(request: ConsoleRequest): Promise<ConsoleResponse> {
    return this.rpcImpl.handle(request, this.contextOf());
  }

  /**
   * `previewPolicy` —— 转发到 {@link ConsoleRpc.handle}。
   *
   * 参数名 `request` 是**线协议的一部分**（见 {@link previewScope} 的说明）：
   * SRC 模式从函数源码解析参数名，网关据此校验 `payload.args`，因此不能改标识符、
   * 不能用解构/默认值/rest。
   *
   * 这个方法必须**逐个**登记：网关只认领带 `@Remote` 的方法，而方法表（`rpc.ts`）
   * 与网关面是两份清单——漏一处的表现是 `404 not found`（实测踩过：
   * 端点已加进方法表、类型检查通过，但线上就是 404）。
   */
  @Remote
  async previewPolicy(request: ConsoleRequest): Promise<ConsoleResponse> {
    return this.rpcImpl.handle(request, this.contextOf());
  }

  /**
   * `listApprovals` —— 转发到 {@link ConsoleRpc.handle}。
   *
   * 参数名 `request` 是**线协议的一部分**：SRC 模式从函数源码解析参数名，网关据此校验
   * `payload.args` 的字段是否与之匹配（`assertExactArguments`），因此这个标识符不能随意改，
   * 也不能用解构/默认值/rest（会以 `gateway/signature-invalid` 被拒）。
   *
   * 注意有两层 `args`：**外层**是网关固定的 `payload = { args: … }` 容器，
   * **内层**才是本方法的具名参数表 `{ request: <信封> }`。实测踩过一次——
   * 只写一层时网关报 `args fields do not match the descriptor: unexpected "method", …`。
   */
  @Remote
  async listApprovals(request: ConsoleRequest): Promise<ConsoleResponse> {
    return this.rpcImpl.handle(request, this.contextOf());
  }

  /**
   * `getScope` —— 转发到 {@link ConsoleRpc.handle}。
   *
   * 参数名 `request` 是**线协议的一部分**：SRC 模式从函数源码解析参数名，网关据此校验
   * `payload.args` 的字段是否与之匹配（`assertExactArguments`），因此这个标识符不能随意改，
   * 也不能用解构/默认值/rest（会以 `gateway/signature-invalid` 被拒）。
   *
   * 注意有两层 `args`：**外层**是网关固定的 `payload = { args: … }` 容器，
   * **内层**才是本方法的具名参数表 `{ request: <信封> }`。实测踩过一次——
   * 只写一层时网关报 `args fields do not match the descriptor: unexpected "method", …`。
   */
  @Remote
  async getScope(request: ConsoleRequest): Promise<ConsoleResponse> {
    return this.rpcImpl.handle(request, this.contextOf());
  }

  /**
   * `listCandidateAssets` —— 转发到 {@link ConsoleRpc.handle}。
   *
   * 参数名 `request` 是**线协议的一部分**：SRC 模式从函数源码解析参数名，网关据此校验
   * `payload.args` 的字段是否与之匹配（`assertExactArguments`），因此这个标识符不能随意改，
   * 也不能用解构/默认值/rest（会以 `gateway/signature-invalid` 被拒）。
   *
   * 注意有两层 `args`：**外层**是网关固定的 `payload = { args: … }` 容器，
   * **内层**才是本方法的具名参数表 `{ request: <信封> }`。实测踩过一次——
   * 只写一层时网关报 `args fields do not match the descriptor: unexpected "method", …`。
   */
  @Remote
  async listCandidateAssets(request: ConsoleRequest): Promise<ConsoleResponse> {
    return this.rpcImpl.handle(request, this.contextOf());
  }

  /**
   * `getState` —— 转发到 {@link ConsoleRpc.handle}。
   *
   * 参数名 `request` 是**线协议的一部分**：SRC 模式从函数源码解析参数名，网关据此校验
   * `payload.args` 的字段是否与之匹配（`assertExactArguments`），因此这个标识符不能随意改，
   * 也不能用解构/默认值/rest（会以 `gateway/signature-invalid` 被拒）。
   *
   * 注意有两层 `args`：**外层**是网关固定的 `payload = { args: … }` 容器，
   * **内层**才是本方法的具名参数表 `{ request: <信封> }`。实测踩过一次——
   * 只写一层时网关报 `args fields do not match the descriptor: unexpected "method", …`。
   */
  @Remote
  async getState(request: ConsoleRequest): Promise<ConsoleResponse> {
    return this.rpcImpl.handle(request, this.contextOf());
  }

  /**
   * `startWorker` —— 转发到 {@link ConsoleRpc.handle}。
   *
   * 参数名 `request` 是**线协议的一部分**：SRC 模式从函数源码解析参数名，网关据此校验
   * `payload.args` 的字段是否与之匹配（`assertExactArguments`），因此这个标识符不能随意改，
   * 也不能用解构/默认值/rest（会以 `gateway/signature-invalid` 被拒）。
   *
   * 注意有两层 `args`：**外层**是网关固定的 `payload = { args: … }` 容器，
   * **内层**才是本方法的具名参数表 `{ request: <信封> }`。实测踩过一次——
   * 只写一层时网关报 `args fields do not match the descriptor: unexpected "method", …`。
   */
  @Remote
  async startWorker(request: ConsoleRequest): Promise<ConsoleResponse> {
    return this.rpcImpl.handle(request, this.contextOf());
  }



  /**
   * `cancelHandoff` —— 转发到 {@link ConsoleRpc.handle}。
   *
   * 参数名 `request` 是**线协议的一部分**：SRC 模式从函数源码解析参数名，网关据此校验
   * `payload.args` 的字段是否与之匹配（`assertExactArguments`），因此这个标识符不能随意改，
   * 也不能用解构/默认值/rest（会以 `gateway/signature-invalid` 被拒）。
   *
   * 注意有两层 `args`：**外层**是网关固定的 `payload = { args: … }` 容器，
   * **内层**才是本方法的具名参数表 `{ request: <信封> }`。实测踩过一次——
   * 只写一层时网关报 `args fields do not match the descriptor: unexpected "method", …`。
   */
  @Remote
  async cancelHandoff(request: ConsoleRequest): Promise<ConsoleResponse> {
    return this.rpcImpl.handle(request, this.contextOf());
  }

  /**
   * `confirmTransition` —— 转发到 {@link ConsoleRpc.handle}。
   *
   * 参数名 `request` 是**线协议的一部分**：SRC 模式从函数源码解析参数名，网关据此校验
   * `payload.args` 的字段是否与之匹配（`assertExactArguments`），因此这个标识符不能随意改，
   * 也不能用解构/默认值/rest（会以 `gateway/signature-invalid` 被拒）。
   *
   * 注意有两层 `args`：**外层**是网关固定的 `payload = { args: … }` 容器，
   * **内层**才是本方法的具名参数表 `{ request: <信封> }`。实测踩过一次——
   * 只写一层时网关报 `args fields do not match the descriptor: unexpected "method", …`。
   */
  @Remote
  async confirmTransition(request: ConsoleRequest): Promise<ConsoleResponse> {
    return this.rpcImpl.handle(request, this.contextOf());
  }

  /**
   * `retryWorker` —— 转发到 {@link ConsoleRpc.handle}。
   *
   * 参数名 `request` 是**线协议的一部分**：SRC 模式从函数源码解析参数名，网关据此校验
   * `payload.args` 的字段是否与之匹配（`assertExactArguments`），因此这个标识符不能随意改，
   * 也不能用解构/默认值/rest（会以 `gateway/signature-invalid` 被拒）。
   *
   * 注意有两层 `args`：**外层**是网关固定的 `payload = { args: … }` 容器，
   * **内层**才是本方法的具名参数表 `{ request: <信封> }`。实测踩过一次——
   * 只写一层时网关报 `args fields do not match the descriptor: unexpected "method", …`。
   */
  @Remote
  async retryWorker(request: ConsoleRequest): Promise<ConsoleResponse> {
    return this.rpcImpl.handle(request, this.contextOf());
  }

  /**
   * `reopenTechnicalWork` —— 转发到 {@link ConsoleRpc.handle}。
   *
   * 参数名 `request` 是**线协议的一部分**：SRC 模式从函数源码解析参数名，网关据此校验
   * `payload.args` 的字段是否与之匹配（`assertExactArguments`），因此这个标识符不能随意改，
   * 也不能用解构/默认值/rest（会以 `gateway/signature-invalid` 被拒）。
   *
   * 注意有两层 `args`：**外层**是网关固定的 `payload = { args: … }` 容器，
   * **内层**才是本方法的具名参数表 `{ request: <信封> }`。实测踩过一次——
   * 只写一层时网关报 `args fields do not match the descriptor: unexpected "method", …`。
   */
  @Remote
  async reopenTechnicalWork(request: ConsoleRequest): Promise<ConsoleResponse> {
    return this.rpcImpl.handle(request, this.contextOf());
  }

  /**
   * `amendScope` —— 转发到 {@link ConsoleRpc.handle}。
   *
   * 参数名 `request` 是**线协议的一部分**：SRC 模式从函数源码解析参数名，网关据此校验
   * `payload.args` 的字段是否与之匹配（`assertExactArguments`），因此这个标识符不能随意改，
   * 也不能用解构/默认值/rest（会以 `gateway/signature-invalid` 被拒）。
   *
   * 注意有两层 `args`：**外层**是网关固定的 `payload = { args: … }` 容器，
   * **内层**才是本方法的具名参数表 `{ request: <信封> }`。实测踩过一次——
   * 只写一层时网关报 `args fields do not match the descriptor: unexpected "method", …`。
   */
  @Remote
  async amendScope(request: ConsoleRequest): Promise<ConsoleResponse> {
    return this.rpcImpl.handle(request, this.contextOf());
  }

  /**
   * `setApprovalMode` —— 转发到 {@link ConsoleRpc.handle}。
   *
   * 与 `amendScope` 同一条约束：参数名 `request` 是线协议的一部分（SRC 模式据此校验
   * `payload.args` 的字段），不能用解构/默认值/rest。
   */
  @Remote
  async setApprovalMode(request: ConsoleRequest): Promise<ConsoleResponse> {
    return this.rpcImpl.handle(request, this.contextOf());
  }

  /** `archiveEngagement` —— 转发到 {@link ConsoleRpc.handle}。 */
  @Remote
  async archiveEngagement(request: ConsoleRequest): Promise<ConsoleResponse> {
    return this.rpcImpl.handle(request, this.contextOf());
  }

  /** `previewEngagementPurge` —— 转发到 {@link ConsoleRpc.handle}。 */
  @Remote
  async previewEngagementPurge(request: ConsoleRequest): Promise<ConsoleResponse> {
    return this.rpcImpl.handle(request, this.contextOf());
  }

  /** `beginHandoff` —— 转发到 {@link ConsoleRpc.handle}。 */
  @Remote
  async beginHandoff(request: ConsoleRequest): Promise<ConsoleResponse> {
    return this.rpcImpl.handle(request, this.contextOf());
  }

  /** `currentHandoffDraft` —— 转发到 {@link ConsoleRpc.handle}。 */
  @Remote
  async currentHandoffDraft(request: ConsoleRequest): Promise<ConsoleResponse> {
    return this.rpcImpl.handle(request, this.contextOf());
  }

  /** `purgeEngagement` —— 转发到 {@link ConsoleRpc.handle}。 */
  @Remote
  async purgeEngagement(request: ConsoleRequest): Promise<ConsoleResponse> {
    return this.rpcImpl.handle(request, this.contextOf());
  }

  /**
   * `extendBudget` —— 转发到 {@link ConsoleRpc.handle}。
   *
   * 参数名 `request` 是**线协议的一部分**：SRC 模式从函数源码解析参数名，网关据此校验
   * `payload.args` 的字段是否与之匹配（`assertExactArguments`），因此这个标识符不能随意改，
   * 也不能用解构/默认值/rest（会以 `gateway/signature-invalid` 被拒）。
   *
   * 注意有两层 `args`：**外层**是网关固定的 `payload = { args: … }` 容器，
   * **内层**才是本方法的具名参数表 `{ request: <信封> }`。实测踩过一次——
   * 只写一层时网关报 `args fields do not match the descriptor: unexpected "method", …`。
   */
  @Remote
  async extendBudget(request: ConsoleRequest): Promise<ConsoleResponse> {
    return this.rpcImpl.handle(request, this.contextOf());
  }

  /**
   * `interject` —— 转发到 {@link ConsoleRpc.handle}。
   *
   * 参数名 `request` 是**线协议的一部分**：SRC 模式从函数源码解析参数名，网关据此校验
   * `payload.args` 的字段是否与之匹配（`assertExactArguments`），因此这个标识符不能随意改，
   * 也不能用解构/默认值/rest（会以 `gateway/signature-invalid` 被拒）。
   *
   * 注意有两层 `args`：**外层**是网关固定的 `payload = { args: … }` 容器，
   * **内层**才是本方法的具名参数表 `{ request: <信封> }`。实测踩过一次——
   * 只写一层时网关报 `args fields do not match the descriptor: unexpected "method", …`。
   */
  @Remote
  async interject(request: ConsoleRequest): Promise<ConsoleResponse> {
    return this.rpcImpl.handle(request, this.contextOf());
  }

  /**
   * `pause` —— 转发到 {@link ConsoleRpc.handle}。
   *
   * 参数名 `request` 是**线协议的一部分**：SRC 模式从函数源码解析参数名，网关据此校验
   * `payload.args` 的字段是否与之匹配（`assertExactArguments`），因此这个标识符不能随意改，
   * 也不能用解构/默认值/rest（会以 `gateway/signature-invalid` 被拒）。
   *
   * 注意有两层 `args`：**外层**是网关固定的 `payload = { args: … }` 容器，
   * **内层**才是本方法的具名参数表 `{ request: <信封> }`。实测踩过一次——
   * 只写一层时网关报 `args fields do not match the descriptor: unexpected "method", …`。
   */
  @Remote
  async pause(request: ConsoleRequest): Promise<ConsoleResponse> {
    return this.rpcImpl.handle(request, this.contextOf());
  }

  /**
   * `resume` —— 转发到 {@link ConsoleRpc.handle}。
   *
   * 参数名 `request` 是**线协议的一部分**：SRC 模式从函数源码解析参数名，网关据此校验
   * `payload.args` 的字段是否与之匹配（`assertExactArguments`），因此这个标识符不能随意改，
   * 也不能用解构/默认值/rest（会以 `gateway/signature-invalid` 被拒）。
   *
   * 注意有两层 `args`：**外层**是网关固定的 `payload = { args: … }` 容器，
   * **内层**才是本方法的具名参数表 `{ request: <信封> }`。实测踩过一次——
   * 只写一层时网关报 `args fields do not match the descriptor: unexpected "method", …`。
   */
  @Remote
  async resume(request: ConsoleRequest): Promise<ConsoleResponse> {
    return this.rpcImpl.handle(request, this.contextOf());
  }

  /**
   * `abort` —— 转发到 {@link ConsoleRpc.handle}。
   *
   * 参数名 `request` 是**线协议的一部分**：SRC 模式从函数源码解析参数名，网关据此校验
   * `payload.args` 的字段是否与之匹配（`assertExactArguments`），因此这个标识符不能随意改，
   * 也不能用解构/默认值/rest（会以 `gateway/signature-invalid` 被拒）。
   *
   * 注意有两层 `args`：**外层**是网关固定的 `payload = { args: … }` 容器，
   * **内层**才是本方法的具名参数表 `{ request: <信封> }`。实测踩过一次——
   * 只写一层时网关报 `args fields do not match the descriptor: unexpected "method", …`。
   */
  @Remote
  async abort(request: ConsoleRequest): Promise<ConsoleResponse> {
    return this.rpcImpl.handle(request, this.contextOf());
  }

  /**
   * `decideApproval` —— 转发到 {@link ConsoleRpc.handle}。
   *
   * 参数名 `request` 是**线协议的一部分**：SRC 模式从函数源码解析参数名，网关据此校验
   * `payload.args` 的字段是否与之匹配（`assertExactArguments`），因此这个标识符不能随意改，
   * 也不能用解构/默认值/rest（会以 `gateway/signature-invalid` 被拒）。
   *
   * 注意有两层 `args`：**外层**是网关固定的 `payload = { args: … }` 容器，
   * **内层**才是本方法的具名参数表 `{ request: <信封> }`。实测踩过一次——
   * 只写一层时网关报 `args fields do not match the descriptor: unexpected "method", …`。
   */
  @Remote
  async decideApproval(request: ConsoleRequest): Promise<ConsoleResponse> {
    return this.rpcImpl.handle(request, this.contextOf());
  }

  /**
   * `revokeApproval` —— 转发到 {@link ConsoleRpc.handle}。
   *
   * 参数名 `request` 是**线协议的一部分**：SRC 模式从函数源码解析参数名，网关据此校验
   * `payload.args` 的字段是否与之匹配（`assertExactArguments`），因此这个标识符不能随意改，
   * 也不能用解构/默认值/rest（会以 `gateway/signature-invalid` 被拒）。
   *
   * 注意有两层 `args`：**外层**是网关固定的 `payload = { args: … }` 容器，
   * **内层**才是本方法的具名参数表 `{ request: <信封> }`。实测踩过一次——
   * 只写一层时网关报 `args fields do not match the descriptor: unexpected "method", …`。
   */
  @Remote
  async revokeApproval(request: ConsoleRequest): Promise<ConsoleResponse> {
    return this.rpcImpl.handle(request, this.contextOf());
  }

  /**
   * `finishTechnicalTesting` —— 转发到 {@link ConsoleRpc.handle}。
   *
   * 参数名 `request` 是**线协议的一部分**：SRC 模式从函数源码解析参数名，网关据此校验
   * `payload.args` 的字段是否与之匹配（`assertExactArguments`），因此这个标识符不能随意改，
   * 也不能用解构/默认值/rest（会以 `gateway/signature-invalid` 被拒）。
   *
   * 注意有两层 `args`：**外层**是网关固定的 `payload = { args: … }` 容器，
   * **内层**才是本方法的具名参数表 `{ request: <信封> }`。实测踩过一次——
   * 只写一层时网关报 `args fields do not match the descriptor: unexpected "method", …`。
   */
  @Remote
  async finishTechnicalTesting(request: ConsoleRequest): Promise<ConsoleResponse> {
    return this.rpcImpl.handle(request, this.contextOf());
  }

  /**
   * `signReport` —— 转发到 {@link ConsoleRpc.handle}。
   *
   * 参数名 `request` 是**线协议的一部分**：SRC 模式从函数源码解析参数名，网关据此校验
   * `payload.args` 的字段是否与之匹配（`assertExactArguments`），因此这个标识符不能随意改，
   * 也不能用解构/默认值/rest（会以 `gateway/signature-invalid` 被拒）。
   *
   * 注意有两层 `args`：**外层**是网关固定的 `payload = { args: … }` 容器，
   * **内层**才是本方法的具名参数表 `{ request: <信封> }`。实测踩过一次——
   * 只写一层时网关报 `args fields do not match the descriptor: unexpected "method", …`。
   */
  @Remote
  async signReport(request: ConsoleRequest): Promise<ConsoleResponse> {
    return this.rpcImpl.handle(request, this.contextOf());
  }

  /**
   * `getReportDraft` —— 转发到 {@link ConsoleRpc.handle}。
   *
   * 参数名 `request` 是**线协议的一部分**：SRC 模式从函数源码解析参数名，网关据此校验
   * `payload.args` 的字段是否与之匹配（`assertExactArguments`），因此这个标识符不能随意改，
   * 也不能用解构/默认值/rest（会以 `gateway/signature-invalid` 被拒）。
   *
   * 注意有两层 `args`：**外层**是网关固定的 `payload = { args: … }` 容器，
   * **内层**才是本方法的具名参数表 `{ request: <信封> }`。实测踩过一次——
   * 只写一层时网关报 `args fields do not match the descriptor: unexpected "method", …`。
   */
  @Remote
  async getReportDraft(request: ConsoleRequest): Promise<ConsoleResponse> {
    return this.rpcImpl.handle(request, this.contextOf());
  }

  /**
   * `listFindings` —— 转发到 {@link ConsoleRpc.handle}。
   *
   * 参数名 `request` 是**线协议的一部分**：SRC 模式从函数源码解析参数名，网关据此校验
   * `payload.args` 的字段是否与之匹配（`assertExactArguments`），因此这个标识符不能随意改，
   * 也不能用解构/默认值/rest（会以 `gateway/signature-invalid` 被拒）。
   *
   * 注意有两层 `args`：**外层**是网关固定的 `payload = { args: … }` 容器，
   * **内层**才是本方法的具名参数表 `{ request: <信封> }`。实测踩过一次——
   * 只写一层时网关报 `args fields do not match the descriptor: unexpected "method", …`。
   */
  @Remote
  async listFindings(request: ConsoleRequest): Promise<ConsoleResponse> {
    return this.rpcImpl.handle(request, this.contextOf());
  }

  /**
   * `dispositionFinding` —— 转发到 {@link ConsoleRpc.handle}。
   *
   * 参数名 `request` 是**线协议的一部分**：SRC 模式从函数源码解析参数名，网关据此校验
   * `payload.args` 的字段是否与之匹配（`assertExactArguments`），因此这个标识符不能随意改，
   * 也不能用解构/默认值/rest（会以 `gateway/signature-invalid` 被拒）。
   *
   * 注意有两层 `args`：**外层**是网关固定的 `payload = { args: … }` 容器，
   * **内层**才是本方法的具名参数表 `{ request: <信封> }`。实测踩过一次——
   * 只写一层时网关报 `args fields do not match the descriptor: unexpected "method", …`。
   */
  @Remote
  async dispositionFinding(request: ConsoleRequest): Promise<ConsoleResponse> {
    return this.rpcImpl.handle(request, this.contextOf());
  }

  /**
   * `updateReport` —— 转发到 {@link ConsoleRpc.handle}。
   *
   * 参数名 `request` 是**线协议的一部分**：SRC 模式从函数源码解析参数名，网关据此校验
   * `payload.args` 的字段是否与之匹配（`assertExactArguments`），因此这个标识符不能随意改，
   * 也不能用解构/默认值/rest（会以 `gateway/signature-invalid` 被拒）。
   *
   * 注意有两层 `args`：**外层**是网关固定的 `payload = { args: … }` 容器，
   * **内层**才是本方法的具名参数表 `{ request: <信封> }`。实测踩过一次——
   * 只写一层时网关报 `args fields do not match the descriptor: unexpected "method", …`。
   */
  @Remote
  async updateReport(request: ConsoleRequest): Promise<ConsoleResponse> {
    return this.rpcImpl.handle(request, this.contextOf());
  }

  /**
   * `redactPreview` —— 转发到 {@link ConsoleRpc.handle}。
   *
   * 参数名 `request` 是**线协议的一部分**：SRC 模式从函数源码解析参数名，网关据此校验
   * `payload.args` 的字段是否与之匹配（`assertExactArguments`），因此这个标识符不能随意改，
   * 也不能用解构/默认值/rest（会以 `gateway/signature-invalid` 被拒）。
   *
   * 注意有两层 `args`：**外层**是网关固定的 `payload = { args: … }` 容器，
   * **内层**才是本方法的具名参数表 `{ request: <信封> }`。实测踩过一次——
   * 只写一层时网关报 `args fields do not match the descriptor: unexpected "method", …`。
   */
  @Remote
  async redactPreview(request: ConsoleRequest): Promise<ConsoleResponse> {
    return this.rpcImpl.handle(request, this.contextOf());
  }

  /**
   * `exportReport` —— 转发到 {@link ConsoleRpc.handle}。
   *
   * 参数名 `request` 是**线协议的一部分**：SRC 模式从函数源码解析参数名，网关据此校验
   * `payload.args` 的字段是否与之匹配（`assertExactArguments`），因此这个标识符不能随意改，
   * 也不能用解构/默认值/rest（会以 `gateway/signature-invalid` 被拒）。
   *
   * 注意有两层 `args`：**外层**是网关固定的 `payload = { args: … }` 容器，
   * **内层**才是本方法的具名参数表 `{ request: <信封> }`。实测踩过一次——
   * 只写一层时网关报 `args fields do not match the descriptor: unexpected "method", …`。
   */
  @Remote
  async exportReport(request: ConsoleRequest): Promise<ConsoleResponse> {
    return this.rpcImpl.handle(request, this.contextOf());
  }

  /**
   * `listUndisposed` —— 转发到 {@link ConsoleRpc.handle}。
   *
   * 参数名 `request` 是**线协议的一部分**：SRC 模式从函数源码解析参数名，网关据此校验
   * `payload.args` 的字段是否与之匹配（`assertExactArguments`），因此这个标识符不能随意改，
   * 也不能用解构/默认值/rest（会以 `gateway/signature-invalid` 被拒）。
   *
   * 注意有两层 `args`：**外层**是网关固定的 `payload = { args: … }` 容器，
   * **内层**才是本方法的具名参数表 `{ request: <信封> }`。实测踩过一次——
   * 只写一层时网关报 `args fields do not match the descriptor: unexpected "method", …`。
   */
  @Remote
  async listUndisposed(request: ConsoleRequest): Promise<ConsoleResponse> {
    return this.rpcImpl.handle(request, this.contextOf());
  }

  /**
   * `searchMemory` —— 转发到 {@link ConsoleRpc.handle}。
   *
   * 参数名 `request` 是**线协议的一部分**：SRC 模式从函数源码解析参数名，网关据此校验
   * `payload.args` 的字段是否与之匹配（`assertExactArguments`），因此这个标识符不能随意改，
   * 也不能用解构/默认值/rest（会以 `gateway/signature-invalid` 被拒）。
   *
   * 注意有两层 `args`：**外层**是网关固定的 `payload = { args: … }` 容器，
   * **内层**才是本方法的具名参数表 `{ request: <信封> }`。实测踩过一次——
   * 只写一层时网关报 `args fields do not match the descriptor: unexpected "method", …`。
   */
  @Remote
  async searchMemory(request: ConsoleRequest): Promise<ConsoleResponse> {
    return this.rpcImpl.handle(request, this.contextOf());
  }

  /**
   * `readMemory` —— 转发到 {@link ConsoleRpc.handle}。
   *
   * 参数名 `request` 是**线协议的一部分**：SRC 模式从函数源码解析参数名，网关据此校验
   * `payload.args` 的字段是否与之匹配（`assertExactArguments`），因此这个标识符不能随意改，
   * 也不能用解构/默认值/rest（会以 `gateway/signature-invalid` 被拒）。
   *
   * 注意有两层 `args`：**外层**是网关固定的 `payload = { args: … }` 容器，
   * **内层**才是本方法的具名参数表 `{ request: <信封> }`。实测踩过一次——
   * 只写一层时网关报 `args fields do not match the descriptor: unexpected "method", …`。
   */
  @Remote
  async readMemory(request: ConsoleRequest): Promise<ConsoleResponse> {
    return this.rpcImpl.handle(request, this.contextOf());
  }

  /**
   * `memoryWatermark` —— 转发到 {@link ConsoleRpc.handle}。
   *
   * 参数名 `request` 是**线协议的一部分**：SRC 模式从函数源码解析参数名，网关据此校验
   * `payload.args` 的字段是否与之匹配（`assertExactArguments`），因此这个标识符不能随意改，
   * 也不能用解构/默认值/rest（会以 `gateway/signature-invalid` 被拒）。
   *
   * 注意有两层 `args`：**外层**是网关固定的 `payload = { args: … }` 容器，
   * **内层**才是本方法的具名参数表 `{ request: <信封> }`。实测踩过一次——
   * 只写一层时网关报 `args fields do not match the descriptor: unexpected "method", …`。
   */
  @Remote
  async memoryWatermark(request: ConsoleRequest): Promise<ConsoleResponse> {
    return this.rpcImpl.handle(request, this.contextOf());
  }

  @Remote
  async verifyLedger(request: ConsoleRequest): Promise<ConsoleResponse> {
    return this.rpcImpl.handle(request, this.contextOf());
  }

  @Remote
  async getDiagnostics(request: ConsoleRequest): Promise<ConsoleResponse> {
    return this.rpcImpl.handle(request, this.contextOf());
  }

  /**
   * `listSkills` —— 转发到 {@link ConsoleRpc.handle}。
   *
   * 参数名 `request` 是**线协议的一部分**：SRC 模式从函数源码解析参数名，网关据此校验
   * `payload.args` 的字段是否与之匹配（`assertExactArguments`），因此这个标识符不能随意改，
   * 也不能用解构/默认值/rest（会以 `gateway/signature-invalid` 被拒）。
   *
   * 注意有两层 `args`：**外层**是网关固定的 `payload = { args: … }` 容器，
   * **内层**才是本方法的具名参数表 `{ request: <信封> }`。实测踩过一次——
   * 只写一层时网关报 `args fields do not match the descriptor: unexpected "method", …`。
   */
  @Remote
  async listSkills(request: ConsoleRequest): Promise<ConsoleResponse> {
    return this.rpcImpl.handle(request, this.contextOf());
  }

  /**
   * `addSkill` —— 转发到 {@link ConsoleRpc.handle}。
   *
   * 参数名 `request` 是**线协议的一部分**：SRC 模式从函数源码解析参数名，网关据此校验
   * `payload.args` 的字段是否与之匹配（`assertExactArguments`），因此这个标识符不能随意改，
   * 也不能用解构/默认值/rest（会以 `gateway/signature-invalid` 被拒）。
   *
   * 注意有两层 `args`：**外层**是网关固定的 `payload = { args: … }` 容器，
   * **内层**才是本方法的具名参数表 `{ request: <信封> }`。实测踩过一次——
   * 只写一层时网关报 `args fields do not match the descriptor: unexpected "method", …`。
   */
  @Remote
  async addSkill(request: ConsoleRequest): Promise<ConsoleResponse> {
    return this.rpcImpl.handle(request, this.contextOf());
  }

  /**
   * `updateSkill` —— 转发到 {@link ConsoleRpc.handle}。
   *
   * 参数名 `request` 是**线协议的一部分**：SRC 模式从函数源码解析参数名，网关据此校验
   * `payload.args` 的字段是否与之匹配（`assertExactArguments`），因此这个标识符不能随意改，
   * 也不能用解构/默认值/rest（会以 `gateway/signature-invalid` 被拒）。
   *
   * 注意有两层 `args`：**外层**是网关固定的 `payload = { args: … }` 容器，
   * **内层**才是本方法的具名参数表 `{ request: <信封> }`。实测踩过一次——
   * 只写一层时网关报 `args fields do not match the descriptor: unexpected "method", …`。
   */
  @Remote
  async updateSkill(request: ConsoleRequest): Promise<ConsoleResponse> {
    return this.rpcImpl.handle(request, this.contextOf());
  }

  /**
   * `getEngagementMemory` —— 转发到 {@link ConsoleRpc.handle}。
   *
   * 参数名 `request` 是**线协议的一部分**：SRC 模式从函数源码解析参数名，网关据此校验
   * `payload.args` 的字段是否与之匹配（`assertExactArguments`），因此这个标识符不能随意改，
   * 也不能用解构/默认值/rest（会以 `gateway/signature-invalid` 被拒）。
   */
  @Remote
  async getEngagementMemory(request: ConsoleRequest): Promise<ConsoleResponse> {
    return this.rpcImpl.handle(request, this.contextOf());
  }

  /**
   * `updateEngagementMemory` —— 转发到 {@link ConsoleRpc.handle}。
   *
   * 参数名 `request` 同上：它是线协议的一部分。注意这里是**两层 `args`**——
   * 外层是网关固定的 `payload = { args: … }` 容器，内层才是本方法的具名参数表。
   */
  @Remote
  async updateEngagementMemory(request: ConsoleRequest): Promise<ConsoleResponse> {
    return this.rpcImpl.handle(request, this.contextOf());
  }

  /**
   * `removeSkill` —— 转发到 {@link ConsoleRpc.handle}。
   *
   * 参数名 `request` 是**线协议的一部分**：SRC 模式从函数源码解析参数名，网关据此校验
   * `payload.args` 的字段是否与之匹配（`assertExactArguments`），因此这个标识符不能随意改，
   * 也不能用解构/默认值/rest（会以 `gateway/signature-invalid` 被拒）。
   *
   * 注意有两层 `args`：**外层**是网关固定的 `payload = { args: … }` 容器，
   * **内层**才是本方法的具名参数表 `{ request: <信封> }`。实测踩过一次——
   * 只写一层时网关报 `args fields do not match the descriptor: unexpected "method", …`。
   */
  @Remote
  async removeSkill(request: ConsoleRequest): Promise<ConsoleResponse> {
    return this.rpcImpl.handle(request, this.contextOf());
  }
}
