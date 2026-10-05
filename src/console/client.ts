/**
 * 控制台 RPC 的**客户端**调用层：UI 与 Host 之间的那一段。
 *
 * 设计依据：docs/dsh-pentest-plugin-design.md §6、§15.3、§15.4、§16.1
 *
 * ── 与宿主侧门面的对称 ──
 *
 *   console/typert-face.ts  把 `ConsoleRpc` 暴露成 `/api` 上的 Remote（Host 侧入口）
 *   client.ts         把宿主的调用入口包装成类型化的 18 个人类操作（客户端侧入）
 *
 * 两者共享同一套信封契约（`src/console/rpc.ts` 的 `ConsoleRequest`），因此
 * 改动信封只改一处。
 *
 * ── 为什么不直接用 `ctx.remote` ──
 *
 * 实测确认（dsh 0.1.5-rc.2）：客户端通过 `ctx.remote`（`@deepseek-ai/dsh-api-remotes`
 * 提供的 `ClientRemote`）调用 Host，而那是**由 codegen 从 remote 声明生成的**，
 * 形状依赖各插件的声明与 codegen 流程。本层刻意**不绑定**那个生成物：
 *
 *   - 它接受一个「调用函数」作为依赖（`(endpoint, payload, signal) => Promise<HostRpcResult>`），
 *     真实运行时由适配器传入 `ctx.remote` 的调用，测试里传入假实现；
 *   - 因此本层的逻辑（信封构造、字段校验、结果分类、幂等键）**完全可测**，
 *     不依赖客户端构建链或 React。
 *
 * 这正是让 UI 的核心逻辑在**没有前端构建基础设施**时也能被验证的原因。
 */

import type { HostRpcResult } from './rpc.ts';
import { DEFAULT_CONSOLE_CHANNEL } from './rpc.ts';
import { CONSOLE_TYPRET_SERVICE } from './rpc.ts';
import { CONSOLE_RPC_METHODS } from './rpc.ts';
import type { ConsoleErrorCode, ConsoleMethodName, ConsoleResponse } from './rpc.ts';

/**
 * 调用宿主的函数。
 *
 * 对应实测确认的客户端契约（dsh 0.1.5-rc.2）：
 * ```ts
 * // dsh-client-connection/lib/types/rpc.d.ts
 * interface ClientConnectionRpc {
 *   call(channel: string, endpoint: string, payload: unknown, signal?: AbortSignal)
 *     : Promise<ConnectionRpcResult<unknown>>;
 * }
 * ```
 * **通道与端点是两个参数**，不是拼成一条路径——真实实现就是
 * `(channel, endpoint, payload, signal) => ctx.connection.rpc.call(channel, endpoint, payload, signal)`。
 * 早前的版本把两者拼成一个字符串让适配器再拆开，那是多余的一层。
 */
export type HostInvoker = (
  channel: string,
  endpoint: string,
  payload: unknown,
  signal: AbortSignal,
) => Promise<HostRpcResult>;

/**
 * 一次人类操作的输入。
 *
 * **每个字段都在这里显式出现，不给隐式默认**——尤其是 `expectedStateVersion` 与
 * `idempotencyKey`：让它们可省略就等于允许「悄悄放弃并发保护」与「悄悄放弃幂等」，
 * 而那两条正是 §15.3 / §15.4 要求控制台必须带的。
 */
export interface ConsoleCallInput {
  readonly method: ConsoleMethodName;
  readonly params: Readonly<Record<string, unknown>>;
  /** §15.4 乐观锁：来自最近一次读到的快照。 */
  readonly expectedStateVersion: number;
  /** 审计理由（§16.1 的 HumanActor 要求）。 */
  readonly reason: string;
  /** §15.3 幂等键。由调用方提供——见下方的键生命周期说明。 */
  readonly idempotencyKey: string;
}

/**
 * 调用结果。
 *
 * 保留**稳定的错误码**而不抛异常：UI 要据码分支（`stale_state_version` 时重读并
 * 提示冲突、`approval_required` 时引导去放行队列……），异常会把码压成字符串。
 */
export type ConsoleCallResult =
  | {
      readonly ok: true;
      readonly method: string;
      /** 服务端的原始结果。 */
      readonly value: unknown;
      /** 服务端标记的幂等重放（§15.3）。UI 可据此避免重复提示「已执行」。 */
      readonly replay: boolean;
    }
  | {
      readonly ok: false;
      readonly method: string | null;
      readonly code: string;
      readonly message: string;
      /**
       * `stale_state_version` 时附带的最新状态（§15.4）。
       *
       * UI 用它直接重渲染，不必再发一次读请求——这也是「另一个浏览器先提交了」
       * 时唯一能让用户看到当前实况的信息。
       */
      readonly state: unknown;
      /** 是不是「版本冲突」。UI 的高频分支，故提升为具名布尔。 */
      readonly conflict: boolean;
    };

/**
 * 客户端侧的信封形状（与 `src/console/rpc.ts` 的 `ConsoleRequest` 对应）。
 *
 * 字段名用 camelCase：服务端的 `ENVELOPE_KEYS` 也是 camelCase。两侧不一致会让
 * 每个请求都因「信封不允许键」被拒，而错误信息不会指出是哪个键写错了——这是
 * 值得在客户端**构造时就保证**的事，而不是等服务端拒绝。
 */
interface ConsoleEnvelope {
  readonly method: string;
  readonly params: Readonly<Record<string, unknown>>;
  readonly expectedStateVersion: number;
  readonly reason: string;
  readonly idempotencyKey: string;
}

export class ConsoleCallError extends Error {
  override readonly name = 'ConsoleCallError';
  /** 构造期的字段问题（不是服务端拒绝）——属于客户端 bug。 */
  readonly field: string;

  constructor(field: string, message: string) {
    super(message);
    this.field = field;
  }
}

/**
 * 校验并构造信封。
 *
 * 在**发出请求之前**拦住明显非法的输入：缺理由、缺幂等键、非有限版本号。
 * 这些在服务端也会被拒，但客户端早拦一步的价值是**错误信息能点到字段名**
 * （服务端的拒绝只说明「信封不允许键」或「必须携带幂等键」，不指出调用方该改哪里）。
 */
export function buildEnvelope(input: ConsoleCallInput): ConsoleEnvelope {
  // 只校验**形状**：`reason` 必须是字符串（`''` 合法）。
  //
  // 「哪些方法必须写非空理由」是**服务端策略**，由方法规格里的
  // `reason` / `reasonOptional` 决定——客户端看不到那张表，替它判定就会把
  // 「可选附言」的方法（如放行决定，2026-10-05 起允许空）也一并拦死，
  // 而且拦在发请求之前，服务端连拒绝的机会都没有。
  if (typeof input.reason !== 'string') {
    throw new ConsoleCallError('reason', '写操作必须携带 reason（字符串，可为空串）');
  }
  if (typeof input.idempotencyKey !== 'string' || input.idempotencyKey.trim().length === 0) {
    throw new ConsoleCallError(
      'idempotencyKey',
      '写操作必须携带非空幂等键（§15.3）——缺失时无法区分重复点击与有意重复',
    );
  }
  if (!Number.isSafeInteger(input.expectedStateVersion) || input.expectedStateVersion < 0) {
    throw new ConsoleCallError(
      'expectedStateVersion',
      `期望状态版本必须是非负整数：${String(input.expectedStateVersion)}（§15.4 乐观锁）`,
    );
  }
  return {
    method: input.method,
    params: input.params,
    expectedStateVersion: input.expectedStateVersion,
    reason: input.reason,
    idempotencyKey: input.idempotencyKey,
  };
}

/**
 * 把宿主的结果形状转成客户端结果。
 *
 * 成功时兼容两种 `value`：服务端原样透传的 `ConsoleResponse`（含 `result` 与
 * `replay`），或直接是结果本身。**宽容**是刻意的：`host-channel` 用前者，
 * 而若将来 dsh 的 remote 层对 `value` 做一次解包，后者就会成为实际形态——
 * 两种都接受比强行规定一种更稳。
 */
export function toCallResult(method: string, host: HostRpcResult): ConsoleCallResult {
  if (host.ok) {
    const value = host.value;
    if (isConsoleResponse(value)) {
      // 服务端原样透传的 ConsoleResponse
      if (value.ok) {
        return { ok: true, method: value.method, value: value.result, replay: value.replay === true };
      }
      return {
        ok: false,
        method: value.method,
        code: value.code,
        message: value.message,
        state: value.state,
        conflict: value.code === 'stale_state_version',
      };
    }
    // 已被解包的结果
    return { ok: true, method, value, replay: false };
  }
  const rawDetails = host.error.details;
  const detailMethod = typeof rawDetails['method'] === 'string' ? rawDetails['method'] : null;
  return {
    ok: false,
    method: detailMethod ?? method,
    code: host.error.code,
    message: host.error.message,
    state: rawDetails['state'],
    conflict: host.error.code === 'stale_state_version',
  };
}

/**
 * 运行时窄化：`unknown` → `ConsoleResponse`。
 *
 * 用类型守卫而不是断言：`host.value` 的形状由宿主与适配器共同决定，
 * 断言会掩盖「宿主解包了 value」这类真实差异；守卫则把它降级为一个可处理的分支。
 */
function isConsoleResponse(value: unknown): value is ConsoleResponse {
  if (value === null || typeof value !== 'object') return false;
  if (!('ok' in value) || typeof value.ok !== 'boolean') return false;
  if (value.ok) {
    return 'method' in value && typeof value.method === 'string' && 'result' in value;
  }
  return 'code' in value && typeof value.code === 'string' && 'message' in value;
}

/**
 * 控制台客户端。
 *
 * ── 幂等键的生命周期（重要，决定了这个类的形状）──
 *
 * 幂等键**不在本类内部生成**，而是要求调用方传入。理由：只有调用方（UI 组件）
 * 知道「这是用户的一次新点击」还是「上一次点击的重试」——
 *
 *   - 一次新点击 → 新的键（服务端会真的执行）
 *   - 同一次操作的重试（网络失败、界面重试）→ **复用同一个键**（服务端返回原结果）
 *
 * 若本类自动生成键，每次重试都会拿到新键，幂等就完全失效了——而这正是 §15.3
 * 要防的「状态已提交但浏览器未收到结果时，重试返回原结果，不创建第二个 Worker」。
 * `newIdempotencyKey()` 只是给调用方一个便利的生成器，不替它决定何时复用。
 */
export class ConsoleClient {
  readonly #invoke: HostInvoker;
  readonly #channel: string;
  readonly #timeoutMs: number;
  #counter = 0;

  constructor(deps: { readonly invoke: HostInvoker; readonly channel?: string; readonly timeoutMs?: number }) {
    this.#invoke = deps.invoke;
    this.#channel = deps.channel ?? DEFAULT_CONSOLE_CHANNEL;
    this.#timeoutMs = deps.timeoutMs ?? DEFAULT_CALL_TIMEOUT_MS;
  }

  /** 所在通道（供适配器或诊断）。 */
  get channel(): string {
    return this.#channel;
  }

  /** 调用一个控制台端点。构造期错误直接抛（那是客户端 bug，不是服务端拒绝）。 */
  async call(input: ConsoleCallInput, signal: AbortSignal): Promise<ConsoleCallResult> {
    const envelope = buildEnvelope(input);
    // 端点与载荷的形状由**共享网关**决定，不是本插件定的：
    //   - 端点必须是 `namespace/method` 两段（`remoteRequest` 会按 `/` 切分并要求恰好两段）；
    //   - 载荷必须**恰好**含一个 plain-object 的 `args` 字段（`remoteRequest` 的校验），
    //     而 `payload.args` 内部是**宿主方法的具名参数表**——字段名要与宿主的方法参数名
    //     一致（SRC 模式从函数源码取参数名）。
    // 因此有两层 `args`：外层是网关的固定容器，内层是 `{ request: <信封> }`
    // （宿主侧 39 个方法的参数都叫 `request`）。
    const endpoint = `${CONSOLE_TYPRET_SERVICE}/${input.method}`;
    let host: HostRpcResult;
    try {
      host = await withTimeout(
        this.#invoke(this.#channel, endpoint, { args: { request: envelope } }, signal),
        this.#timeoutMs,
        endpoint,
      );
    } catch (cause) {
      // 超时或传输层抛错：**必须转成结果**，而不是让调用方的 Promise 悬着。
      //
      // 实测踩过：宿主的控制台通道没注册时（缺 `config.operator`），`rpc.call` 既不
      // 解析也不拒绝，于是界面上的「正在读取…」永远转下去——没有任何错误、没有任何线索。
      // 悬着的 Promise 在 UI 里等价于「功能消失且无解释」，比一个明确的失败更糟。
      const code: ConsoleErrorCode =
        cause instanceof ConsoleTimeout ? 'console/channel-unavailable' : 'console/internal';
      return {
        ok: false,
        method: input.method,

        code,
        message: cause instanceof Error ? cause.message : String(cause),
        state: undefined,
        conflict: false,
      };
    }
    return toCallResult(input.method, host);
  }

  /**
   * 生成一个幂等键。
   *
   * 用计数器 + 时间戳而不是 `crypto.randomUUID`：前者在**同一次页面会话**里单调、
   * 可读、且不依赖 Web Crypto（`randomUUID` 只在安全上下文可用，而本地 `http://`
   * 开发环境不是安全上下文——那会让「本地调试时所有写操作抛错」）。
   */
  newIdempotencyKey(prefix = 'ui'): string {
    this.#counter += 1;
    return `${prefix}-${String(Date.now())}-${String(this.#counter)}`;
  }

  /** 全部可调用端点，供 UI 生成菜单或做能力探测。 */
  static methods(): readonly ConsoleMethodName[] {
    return CONSOLE_RPC_METHODS;
  }
}

/**
 * 单次控制台调用的超时。
 *
 * 取 15 秒：控制台端点是单库查询，正常在毫秒级；超过这个数量级只可能是通道没通
 * （未注册、连接断开），此时尽快给出可读的失败远好过继续等。
 * 不用更长的时间是因为「等 60 秒再报错」在界面上与永远转圈几乎没有区别。
 */
export const DEFAULT_CALL_TIMEOUT_MS = 15_000;

/** 超时的判别类型：只有它该被映射成「通道不可用」。 */
class ConsoleTimeout extends Error {
  override readonly name = 'ConsoleTimeout';
}

/**
 * 给宿主调用套一个超时。
 *
 * 透传原有的 signal（调用方可能因为切面板而主动中止），并叠加自己的计时器。
 * 计时器**必须清掉**：不清会让 Node/浏览器保持一个待触发的定时器，
 * 在测试里表现为进程不退出、在页面上表现为无谓的唤醒。
 */
async function withTimeout<T>(work: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          reject(new ConsoleTimeout(`控制台调用「${what}」在 ${String(ms)}ms 内没有响应：控制台 RPC 通道可能未注册（检查部署的 config.operator）`));
        }, ms);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * 判断一个失败是不是「另一个界面先提交了」。
 *
 * 提升为具名函数是因为 UI 对这个分支有专门处置（提示冲突 + 用附带的最新状态重渲染），
 * 而它出现在多个地方；散落的 `code === 'stale_state_version'` 比较容易漏掉一处。
 */
export function isConflict(result: ConsoleCallResult): boolean {
  return !result.ok && result.conflict;
}

/** 判断失败是否值得自动重试（传输层问题）；业务拒绝不该自动重试。 */
export function isRetryable(result: ConsoleCallResult): boolean {
  if (result.ok) return false;
  // 内部错误与中止可能瞬时；业务拒绝（冲突、缺放行、越权）重试无意义——
  // 尤其 `approval_required`：重试只会再次被拒，正确动作是等人放行。
  return result.code === 'console/internal' || result.code === 'console/context-invalid';
}
