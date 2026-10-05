/**
 * 工具执行守卫：`tools/pre-execute` 瀑布 + `ctx.tools.guard` 单调拒绝。
 *
 * 设计依据：docs/dsh-pentest-plugin-design.md §10.2、§10.2.1
 *
 * ── 两条实测确认的 dsh 契约（dsh 0.1.5-rc.2）──
 *
 * 1. `PreToolDecision = {kind:'allow'} | {kind:'deny',reason} | {kind:'ask',reason?}`
 *    官方注释：「Input rewriting is excluded because arguments are already logged
 *    and presented」→ 守卫只放行或拒绝，绝不改写参数。
 *
 * 2. `ToolGuard = (exec) => string | undefined`
 *    官方注释：「guards have no allow result, listener ordering cannot turn a
 *    denial back into permission」→ 需要单调最终拒绝时用 guard。
 *
 * 3. **参数是深冻结的**。官方注释：「Parsed arguments cross one lossless-JSON
 *    materialization boundary before policy and are **deep-frozen**」。
 *    这条决定了守卫**不能**依赖「参数里带一个服务端签发的令牌」——
 *    没有任何东西能把令牌写进冻结的参数，模型也构造不出来。
 *
 * ── 上一版的设计错误（已修正）──
 *
 * 上一版让守卫要求 target 工具的参数携带 `__execution_token`，由守卫验证。
 * 这在 dsh 契约下不可实现（参数冻结、无生产者），实测导致 `pentest_exec`
 * 被**无条件拒绝**——放行队列只进不出。更糟的是它采用「未登记即拒绝」，
 * 会把宿主全部工具（bash / fs / web …）一并拒掉。
 *
 * ── 现行设计 ──
 *
 * 守卫是**纵深防御**，不是主闸门。主闸门在执行服务内部（`pentest_exec` → admit）。
 * 守卫的职责收窄为两件事：
 *
 *   a. **拒绝绕过通道**：宿主自带的能力型工具（shell / 文件写入 / 代码执行 /
 *      网络抓取）能让 Worker 直接触及目标、绕过 `pentest_exec` 的范围校验与
 *      放行。守卫拦下这些，除非它们已被显式授权。
 *   b. **放行其余一切**：本插件的工具、以及与本设计无关的宿主工具一律放行。
 *
 * 这与「deny-by-default」的原措辞不同，且是有意的修正：Worker 会话的工具面
 * 本应由 dsh 的 `restrict()` 收窄（§2.4 能力冻结），守卫不重复承担那份职责。
 * 对整张宿主工具表做 deny-by-default 会废掉宿主，而宿主工具名是开放集合、
 * 无法穷举成放行清单——只能按「已知危险」拒绝。
 */

import type { ErrorCode, ToolError } from '../contracts.ts';

/** 工具的分类，决定它是否可绕过执行服务。 */
export type ToolKind =
  /** 本插件的只读记忆与报告类工具，不触及目标网络。 */
  | 'non-target'
  /** 本插件的目标类工具，必须经 ExecutionService 准入。 */
  | 'target';

export interface ToolRegistration {
  readonly name: string;
  readonly kind: ToolKind;
}

/** 由工具实现方在注册时提交的登记信息。守卫据此区分本插件自己的工具。 */
export class ToolRegistry {
  private readonly kinds = new Map<string, ToolKind>();

  register(reg: ToolRegistration): () => void {
    this.kinds.set(reg.name, reg.kind);
    return () => {
      if (this.kinds.get(reg.name) === reg.kind) this.kinds.delete(reg.name);
    };
  }

  kindOf(name: string): ToolKind | undefined {
    return this.kinds.get(name);
  }

  has(name: string): boolean {
    return this.kinds.has(name);
  }

  names(): readonly string[] {
    return [...this.kinds.keys()];
  }
}

/** 守卫看到的调用视图（与 dsh 的 ToolExecution 结构对齐的最小子集）。 */
export interface GuardedCall {
  readonly name: string;
  readonly arguments: unknown;
  /** 非空表示 PTC（run_code）内的嵌套子调用。 */
  readonly parent?: unknown;
  readonly agent?: unknown;
}

export type GuardDecision =
  | { readonly kind: 'allow' }
  | { readonly kind: 'deny'; readonly reason: string; readonly code: ErrorCode };

/** 构造拒绝结果，附带稳定错误码。 */
export function deny(code: ErrorCode, reason: string): GuardDecision {
  return { kind: 'deny', code, reason };
}

/** 把拒绝决策转成模型可见的工具错误载荷（§16.5）。 */
export function toToolError(d: Extract<GuardDecision, { kind: 'deny' }>): ToolError {
  return {
    status: 'blocked',
    code: d.code,
    message: d.reason,
    next_action: '不要重试相同调用；如需执行该动作，请改用 pentest_exec 并按其流程申请',
  };
}

/**
 * 绕过通道工具名（默认集）。
 *
 * 这些宿主能力能让 Worker 直接抵达目标而不经过 `pentest_exec`：
 * - shell 类：`bash` / `pwsh` / `shell` —— 可运行任意第三方工具（nmap、curl…）
 * - 代码执行：`run_code` / `code` / `python` —— 同上，且可实现原始套接字
 * - 文件写入：`write` / `edit` —— 可落地脚本再执行
 * - 网络抓取：`web_fetch` / `fetch` —— 直接发起出站请求
 * - 子代理与工作流：`subagent` / `run_workflow` —— 可在子上下文里调用上述能力
 *
 * 名称匹配是**按前缀归一化后的大小写不敏感比较**（见 `isBypassChannel`），
 * 因为宿主可能把同一能力注册成 `bash` / `Bash` / `tool-bash` 等多种写法。
 */
export const DEFAULT_BYPASS_CHANNELS: readonly string[] = [
  'bash',
  'pwsh',
  'powershell',
  'shell',
  'sh',
  'cmd',
  'terminal',
  'run_code',
  'run-code',
  'code',
  'python',
  'node',
  'write',
  'edit',
  'fs_write',
  'multiedit',
  'notebook_edit',
  'web_fetch',
  'webfetch',
  'fetch',
  'http',
  'subagent',
  'task',
  'run_workflow',
  'workflow',
];

export interface GuardPolicy {
  /**
   * 绕过通道清单。命中即拒绝，除非该工具在本插件的登记表里
   * （即「插件自己包了一层受控实现」）。
   */
  readonly bypassChannels?: readonly string[];
  /**
   * 允许的绕过通道（按 engagement 策略显式授权）。
   *
   * 例如某些 engagement 确实需要 Worker 直接跑 `bash` 做只读排查——
   * 那是人类在策略里明确同意的，写进这里即可放行。默认空集。
   */
  readonly allowedBypassChannels?: readonly string[];
}

/** 归一化工具名以便比较：去 `tool-`/`mcp__` 前缀、小写、下划线转连字符。 */
function normalizeToolName(name: string): string {
  return name
    .toLowerCase()
    .replace(/^tool[-_]/, '')
    .replace(/^mcp__/, '')
    .replace(/_/g, '-');
}

/**
 * 判定一次调用是否命中绕过通道。
 *
 * 用「归一化后的精确匹配 + 前缀匹配」而不是子串包含：子串会把
 * `memory_search`、`artifact_read` 这类名字里的普通词误判成危险能力。
 */
export function isBypassChannel(name: string, channels: readonly string[]): boolean {
  const n = normalizeToolName(name);
  return channels.some((c) => {
    const k = normalizeToolName(c);
    return n === k || n.startsWith(`${k}-`) || n.endsWith(`-${k}`);
  });
}

/**
 * 守卫的核心判定。纯函数，便于测试。
 *
 * 判定顺序：
 *   1. 本插件登记的工具 → 放行（主闸门在服务内部，不在此重复判定）
 *   2. 命中绕过通道且未被显式授权 → 拒绝
 *   3. 其余一切 → 放行
 *
 * **第 3 条是本版与上一版的关键差别**。守卫不再对「未登记」施加默认拒绝：
 * 它只拦已知能绕过 `pentest_exec` 的能力，把「Worker 不该看见哪些工具」
 * 留给能力冻结（§2.4 的 `restrict()`）去表达。
 */
export function evaluateGuard(
  call: GuardedCall,
  registry: ToolRegistry,
  policy: GuardPolicy = {},
): GuardDecision {
  // 1. 本插件自己的工具：放行。目标类工具的准入判定在 ExecutionService 内。
  if (registry.has(call.name)) {
    return { kind: 'allow' };
  }

  // 2. 绕过通道：默认拒绝，除非 engagement 策略显式授权。
  const channels = policy.bypassChannels ?? DEFAULT_BYPASS_CHANNELS;
  if (!isBypassChannel(call.name, channels)) {
    return { kind: 'allow' };
  }

  const allowed = policy.allowedBypassChannels ?? [];
  if (isBypassChannel(call.name, allowed)) {
    return { kind: 'allow' };
  }

  return deny(
    'scope_violation',
    `工具 ${call.name} 能直接触及目标，会绕过 pentest_exec 的范围校验与逐动作放行。` +
      `请改用 pentest_exec（受信动作模板 + 目标选择器 + 必要时的 approval_id）；` +
      `若该能力确有必要，需由人类在 engagement 策略中显式授权。`,
  );
}

/**
 * 把守卫注册到 dsh 的两个扩展点。
 *
 * - `tools/pre-execute` 瀑布：提供带理由的早期拒绝，模型能看到可读原因。
 * - `ctx.tools.guard`：单调最终拒绝——即使有后续监听器在 pre-execute 里放行，
 *   这里仍会拦下，因为 guard 没有 allow 结果。
 *
 * **PTC 嵌套子调用同样经过这两个扩展点**（`ToolExecution.parent` 非空），
 * 因此「把绕过动作塞进 run_code」的路径也会被拦住。
 */
export interface GuardHost {
  on(event: 'tools/pre-execute', handler: (call: GuardedCall) => GuardDecision): void;
  guard(fn: (call: Readonly<GuardedCall>) => string | undefined): () => void;
}

export function installGuard(
  host: GuardHost,
  registry: ToolRegistry,
  policy: GuardPolicy = {},
): () => void {
  host.on('tools/pre-execute', (call) => evaluateGuard(call, registry, policy));

  // 单调守卫：返回字符串即拒绝，返回 undefined 保持不变。
  // 与 pre-execute 用同一判定，保证两处结论一致。
  return host.guard((call) => {
    const decision = evaluateGuard(call, registry, policy);
    return decision.kind === 'deny' ? decision.reason : undefined;
  });
}
