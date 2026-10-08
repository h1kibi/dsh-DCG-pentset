/**
 * 插件入口：把各模块装配为 Cordis 插件。
 *
 * 设计依据：docs/dsh-pentest-plugin-design.md §4.1、§4.2、§4.4、§8.2
 *
 * 本文件只做装配与启动自检，不含业务判定。业务判定分别位于：
 *   src/policy/scope.ts        范围规范化与判定
 *   src/execution/service.ts   执行管线（强制点）
 *   src/workflow/             状态机、租约、交接
 *   src/memory/               事件账本与检索
 *
 * ── 两个实测确认的宿主契约（dsh 0.1.5-rc.2）──
 *
 * 1. **cordis 只传两个参数**。唯一调用点 `cordis/lib/index.js:1066-1070`：
 *    `runtime.callback(this.ctx, this.config)`。
 *    因此 `apply(ctx, config)` 是**唯一**可用的签名——宿主不会注入任何第三方
 *    依赖。上一版在这里加了第三个 `services` 参数，导致 `apply` 永远走早退
 *    分支、注册 0 个工具（静默空转）。现行实现改为从 `ctx` 与插件自身解析依赖。
 *
 * 2. **不得写入宿主未注册的会话事件类型**。`KNOWN_SESSION_EVENT_TYPES` 是构建期
 *    生成的固定集合（实测 56 项），官方注释明确「Downstream (out-of-repo) plugin
 *    events are outside this list by construction」，读路径拒绝未带 `ignorable`
 *    标记的未知类型。写入未知类型会让新版宿主拒绝打开该会话日志——不可恢复的
 *    损坏。因此领域事件只进 PostgreSQL，绝不进会话日志。
 */

import type { Context } from '@deepseek-ai/cordis';
// 注意：KNOWN_SESSION_EVENT_TYPES 挂在 dsh-session 主入口下。
// 该包虽存在 lib/types/known-event-types.js，但 package.json 的 exports 未导出
// 该子路径（实测：只有 "." / "./invariant" / "./types" / "./surface" / "./src/*"）。
import { KNOWN_SESSION_EVENT_TYPES } from '@deepseek-ai/dsh-session';
import { DOMAIN_EVENT_TYPES } from './contracts.ts';
import { ToolRegistry, installGuard } from './tools/guard.ts';
import type { GuardPolicy } from './tools/guard.ts';
import { createWorkerTools, TARGET_TOOL_NAMES, WORKER_TOOL_NAMES } from './tools/worker.ts';
import type { WorkerToolDeps } from './tools/worker.ts';
import { CONSOLE_TYPRET_SERVICE, ConsoleTypertService } from './console/typert-face.ts';
import type { ConsoleRpc } from './console/rpc.ts';
import { lookup } from 'node:dns/promises';
import { compose } from './compose.ts';
import { inspectRls } from './compose.ts';
import { probeReachability, renderReachabilityNote, spawnRunner } from './execution/docker-sandbox.ts';
import { migrate } from './db/migrate.ts';
import { DshSessionFactory } from './agents/dsh-session-factory.ts';
import { assertGraph } from './workflow/phases.ts';
import type { ComposeConfig, ComposedPlugin } from './compose.ts';
import type { DshBudgetPort } from './workflow/budget.ts';

export const name = 'dsh-pentest';

/** 本插件使用的宿主会话事件类型——只读，不新增。 */
const HOST_SESSION_EVENTS_USED = [
  'user/message',
  'system/message',
  'assistant/message',
  'assistant/attempt',
  'tool/call',

  'tool/result',
  'request/header',
  'request/context',
] as const;

/** 依赖的宿主服务。cordis 会等它们就绪后再调用 `apply`。 */
export const inject = ['tools', 'agents', 'sessions'];

export interface PluginConfig {
  /** 生态依赖要求：缺失或版本不符时拒绝启动（§4.4）。默认开启。 */
  readonly requireEcosystem?: boolean;
  /**
   * 必需生态插件名称。省略时使用设计文档 §4.4 的五个硬依赖；显式传空数组会被拒绝，
   * 防止把「开启检查但不检查任何东西」当成安全配置。
   */
  readonly ecosystemPlugins?: readonly string[];
  /** 守卫策略：绕过通道清单与显式授权（§10.2）。 */
  readonly guard?: {
    readonly bypassChannels?: readonly string[];
    readonly allowedBypassChannels?: readonly string[];
  };
  /**
   * 运行时装配配置。**给出后插件自行调用 `compose()` 连库并注册工具面**；
   * 省略则只安装守卫、不注册工具（工具面没有可用的服务实现时注册会失败）。
   *
   * 类型是 `unknown` 以避免 `index.ts` 反向依赖 `compose.ts`（后者依赖 pg）。
   * 实际取值见 `src/compose.ts` 的 `ComposeConfig`。
   */
  readonly runtime?: unknown;
  /** 运行时组合完成的钩子（测试用）。 */
  readonly onComposed?: (hostServices: PentestHostServices) => void;
  /**
   * 操作者身份（**部署配置，不是请求**）。
   *
   * 宿主的 Connection RPC 在通道层面做认证，但 handler 的签名是
   * `(endpoint, payload, signal)`——**拿不到认证主体**。因此本实例的操作者是谁
   * 必须由部署方声明。省略则控制台通道不注册（UI 无法调用），并记录警告。
   */
  readonly operator?: { readonly id: string; readonly source?: string };
  /**
   * 启动对账（§15.2）。省略即启用。
   *
   * 关掉的场景：
   *   - **多实例共享数据库**：每个实例启动都全库对账会互相写审计事件
   *     （`recoverAll` 扫描的是整库的无主会话，不只是自己关心的那些）。
   *     租约判定已保证不会误终止别的实例在驱动的会话，但写事件本身是副作用。
   *   - 共享数据库的测试环境：同理。
   *
   * 关掉只影响**启动时**的自动对账；控制台仍可随时手动触发
   * （`recovery.recoverEngagement` 或 `recoverAll`）。
   */
  readonly recovery?: { readonly onStartup?: boolean };
}

export class PentestBootError extends Error {
  override readonly name = 'PentestBootError';
}

/**
 * 启动自检：确认不触碰宿主未知的会话事件类型。
 *
 * 一旦写入未知类型，新版宿主可能直接拒绝打开该会话日志。因此这条是**红线**，
 * 不满足即拒绝启动。
 */
export function assertSessionVocabularyClean(): void {
  const unknown = HOST_SESSION_EVENTS_USED.filter((t) => !KNOWN_SESSION_EVENT_TYPES.has(t));
  if (unknown.length > 0) {
    throw new PentestBootError(
      `宿主不认识这些会话事件类型：${unknown.join(', ')}。` +
        `本插件不得依赖未注册的会话事件（§8.2）；请核对 dsh 版本或修正事件名。`,
    );
  }

  // 反向检查：领域事件名绝不能出现在宿主会话事件表里（否则命名冲突，
  // 同一名字在两条通道上含义不同）。
  const collided = DOMAIN_EVENT_TYPES.filter((t) => KNOWN_SESSION_EVENT_TYPES.has(t));
  if (collided.length > 0) {
    throw new PentestBootError(
      `领域事件名与宿主会话事件冲突：${collided.join(', ')}。这会让同一名字在两条通道上含义不同，必须改名。`,
    );
  }
}

/** §4.4 中承担硬边界的生态依赖；dsh-auto-review 是可选复核层，不列入启动硬门。 */
export const REQUIRED_ECOSYSTEM_PLUGINS = [
  'dsh-permission-rules',
  'dsh-defend',
  'dsh-mask',
  'dsh-observe',
  'dsh-budget',
] as const;

/**
 * Cordis registry 的 runtime identity 不一定等于 npm package name：
 * dsh-permission-rules、dsh-mask、dsh-observe 分别导出
 * `permission-rules`、`mask`、`observe`。要求清单继续使用文档/配置里的包名，
 * 这里只做显式的一对一身份绑定；未知插件仍必须以精确名称出现。
 */
const ECOSYSTEM_RUNTIME_IDENTITIES: Readonly<Record<string, string>> = Object.freeze({
  'dsh-permission-rules': 'permission-rules',
  'dsh-defend': 'dsh-defend',
  'dsh-mask': 'mask',
  'dsh-observe': 'observe',
  'dsh-budget': 'dsh-budget',
});

/** §4.4 生态依赖自检：要求存在且身份匹配，否则拒绝启动。 */
export function assertEcosystem(available: readonly string[], required: readonly string[] = REQUIRED_ECOSYSTEM_PLUGINS): void {
  if (required.length === 0) {
    throw new PentestBootError('生态依赖检查清单不能为空：空清单会把缺失防护静默当成已满足（§4.4）。');
  }
  const missing = required.filter((packageName) => {
    const runtimeName = ECOSYSTEM_RUNTIME_IDENTITIES[packageName] ?? packageName;
    return !available.includes(packageName) && !available.includes(runtimeName);
  });
  if (missing.length > 0) {
    throw new PentestBootError(
      `缺少生态依赖：${missing.join(', ')}。` +
        `运行时已注册 identity：${available.length === 0 ? '（无）' : available.join(', ')}。` +
        `这些依赖承担网络策略、注入防御、脱敏或遥测（§4.4）；` +
        `不允许"少一层防护仍在运行"，因此拒绝启动。`,
    );
  }
}

/**
 * Worker 工具实现的服务面在组合层的注册名。
 *
 * 宿主（或本插件的其他组装层）用 `ctx.provide(PENTEST_HOST_SERVICES, impl)`
 * 提供实现；`apply` 在启动时取用。取不到时**不注册工具面**——宁可空转也不
 * 注册一批会抛异常的工具。
 *
 * 为什么用服务而不走第三参：cordis 恒只传两个参数（见文件头），没有别的通道。
 */
export const PENTEST_HOST_SERVICES = 'pentestHostServices';

export interface PentestHostServices {
  readonly workerTools: WorkerToolDeps;
  /**
   * 控制台 RPC 的服务面（§16.1）。
   *
   * **可选**：headless 部署的宿主只关心工具面，provide 一个 `workerTools` 就够。
   * 缺它时不注册控制台通道并记录原因——把必需面锁成两个会让「只想用工具面」的
   * 宿主无法接入，那是把可选功能变成了前置条件。
   */
  readonly consoleRpc?: ConsoleRpc;
}

export interface ApplyResult {
  readonly toolsRegistered: readonly string[];
  readonly servicesBound: boolean;
  /**
   * 本次 apply 实际启动的后台循环（测试与运维观察用）。
   *
   * 与 `recovery.onStartup` **无关**：那个开关只控制启动时的一次性对账，
   * 关掉它不该让心跳/调度/通知一起停摆（事故 2026-10-05：按文档关掉对账后，
   * 任何超过 TTL 的会话再也无法执行动作，且没有任何提示）。
   */
  readonly backgroundLoops: {
    readonly heartbeat: boolean;
    readonly scheduler: boolean;
    readonly notify: boolean;
  };
}

/**
 * 插件 apply：**cordis 的入口**。
 *
 * 签名必须是 `(ctx, config)`：cordis 就是这么调的（`cordis/lib/index.js:1070`）。
 *
 * ── 返回值必须是 cordis 能接受的 effect ──
 *
 * cordis 把 apply 的返回值当作一个 effect 收集（`Fiber._execute` → `safeCollect`），
 * 只接受四类：函数（disposer）、`null`/`undefined`、Promise、可迭代对象。
 * **返回普通对象会让加载器抛 `TypeError: Invalid effect`，整个 profile 起不来**——
 * 实测踩过：本函数曾返回 `ApplyResult` 结构，于是插件在任何真实 dsh 部署中都装不上，
 * 而全部单元测试仍绿（它们直接调函数读返回值，绕过了 cordis 的校验）。
 *
 * 因此这里返回 `void`；结构化结果由 {@link applyPentest} 提供，测试调它。
 */
export async function apply(ctx: Context, config: PluginConfig = {}): Promise<void> {
  await applyPentest(ctx, config);
}

/**
 * 实际装配。返回结构化结果**仅供测试与调用方观察**，不可作为 cordis 的 apply 返回值。
 *
 * 两条路：
 *   - `config.runtime` 省略 → 只装守卫，不注册工具（明确记录，不静默）
 *   - `config.runtime` 给出 → 自行 `compose()` 连库，随后注册 7 个 Worker 工具
 */
export async function applyPentest(ctx: Context, config: PluginConfig = {}): Promise<ApplyResult> {
  // ── 启动自检：先等待同一 profile 中已配置的生态 entry 完成激活，再同步断言 ──
  // loader 会并行初始化 sibling entries；仅按 bundle 列表顺序读取 registry 会在
  // mask/observe 尚未注册 runtime 时产生假阴性。等待只针对配置中的 entry，entry
  // 缺失、导入失败或 apply 失败仍由后面的精确 identity 断言/loader 错误 fail closed。
  assertSessionVocabularyClean();
  // 状态机自检（`phases.ts` 的 `assertGraph`）：转移表/邻接表是**静态**数据，
  // 坏一行不会有测试之外的任何症状（真实后果是状态机在运行期走出设计外的路径）。
  // 放在启动路径一次性校验，坏表即开即失败——第六轮质检发现它此前只被测试调用。
  assertGraph();
  const requireEcosystem = config.requireEcosystem ?? true;
  if (requireEcosystem) {
    const required = config.ecosystemPlugins ?? REQUIRED_ECOSYSTEM_PLUGINS;
    await awaitConfiguredEcosystem(ctx, required);
    assertEcosystem(ecosystemNames(ctx), required);
  }

  // ── 工具登记：守卫据此区分「本插件的工具」与「宿主工具」──
  const registry = new ToolRegistry();
  for (const toolName of WORKER_TOOL_NAMES) {
    const kind = (TARGET_TOOL_NAMES as readonly string[]).includes(toolName) ? 'target' : 'non-target';
    const dispose = registry.register({ name: toolName, kind });
    ctx.effect(() => dispose, `pentest: register ${toolName}`);
  }

  // ── 全局守卫：拦截绕过 pentest_exec 的能力型宿主工具（§10.2）──
  const policy: GuardPolicy = {
    ...(config.guard?.bypassChannels === undefined
      ? {}
      : { bypassChannels: config.guard.bypassChannels }),
    ...(config.guard?.allowedBypassChannels === undefined
      ? {}
      : { allowedBypassChannels: config.guard.allowedBypassChannels }),
  };
  ctx.effect(
    () => installGuard(guardHostOf(ctx), registry, policy),
    'pentest: install execution guard',
  );

  // ── 服务面：优先取组合层已 provide 的，其次自行组合 ──
  //
  // 自行组合时我们同时持有组合产物，因此可以启动它的后台循环；
  // 服务面来自宿主 provide 时，**生命周期归宿主**——我们不越权启停别人的
  // 调度器（宿主可能已按自己的节奏管理它）。
  const own = hostServicesOf(ctx) === undefined ? await composeIfConfigured(ctx, config) : undefined;
  const services = own?.hostServices ?? hostServicesOf(ctx);
  if (services === undefined) {
    log(ctx, 'warn')(
      `未提供 ${PENTEST_HOST_SERVICES}，且 config.runtime 未配置：` +
        `已安装守卫，但工具面对模型不可见。请配置 runtime 或由组合层 provide。`,
    );
    return {
      toolsRegistered: [],
      servicesBound: false,
      backgroundLoops: { heartbeat: false, scheduler: false, notify: false },
    };
  }

  const tools = createWorkerTools(services.workerTools);
  const registered = [
    tools.bootstrapIntake,
    tools.memorySearch,
    tools.memoryRead,
    tools.artifactRead,
    tools.submitReport,
    tools.requestScopeConfirmation,
    tools.writeStatusNote,
    tools.requestApproval,
    tools.prepareHandoff,
    tools.skillLoad,
    tools.pentestExec,
    // 结构化侦察入口（2026-10-06）：与 WORKER_TOOL_NAMES 一一对应——
    // 漏登记会以「注册数比清单少一个」的形式被 assemble/compose 的断言抓到。
    tools.pentestRecon,
    // 结构化核验入口（漏洞分析阶段）。
    tools.pentestScan,
    // 作业目录的读写（2026-10-07）：**不是目标工具**，不经过范围裁决——
    // 空范围作业里它是唯一能读到作业资料的通道（`pentest_exec` 会被 out_of_scope 拒绝）。
    tools.workdirTool,
  ];
  const names: string[] = [];
  for (const def of registered) {
    const dispose = ctx.tools.register(def);
    ctx.effect(() => dispose, `pentest: tool ${def.name}`);
    names.push(def.name);
  }

  // ── 启动对账与后台循环 ──
  //
  // 两件事，**开关只该管它自己那一件**：
  //   1. 启动对账（§15.2）由 `recovery.onStartup` 控制：把上次崩溃的残留
  //      （停在 starting 的会话、未结算的工具执行、无主会话）变成确定结论。
  //      共享库/测试环境可以关掉——它扫描整库并写审计事件。
  //   2. 租约心跳、索引调度、通知监听是插件的**常驻循环**，与对账开关无关。
  //
  // 顺序：对账先跑，索引调度后起（§14.3 会立即做一次启动重扫）——在对账之前
  // 启动调度，会让调度器去处理一个状态尚未对清的 engagement。
  //
  // 对账**不 await**：`apply` 是同步的启动路径，一次全库扫描不该阻塞插件加载。
  // 失败进回调记录，不阻止后续步骤——对账失败不该让索引也停摆。
  //
  // 事故（2026-10-05）：三个 `start()` 曾与对账同处一个 `if`，于是按文档关掉
  // 对账会连带把常驻循环全部停掉——任何运行超过 TTL 的会话再也无法执行动作，
  // 而且没有任何提示。开关只该管它自己那一件事。
  const backgroundLoops = { heartbeat: false, scheduler: false, notify: false };
  // 告警曾经的错误落点：放进 `runtime` 的 `recovery` 不生效（ComposeConfig
  // 没有这个字段），静默忽略会把「我关了全库对账」变成假事实。见 `PluginConfig.recovery`。
  if ((config.runtime as { recovery?: unknown } | undefined)?.recovery !== undefined) {
    log(ctx, 'warn')(
      'config.runtime.recovery 不生效：recovery 是插件配置的顶层字段（与 runtime 并列），请把它移出 runtime',
    );
  }
  if (own !== undefined && (config.recovery?.onStartup ?? true)) {
    void own.recovery
      .recoverAll()
      .then((report) => {
        if (report.engagements.length > 0 || report.errors.length > 0) {
          log(ctx, 'info')(
            `启动对账：处理 ${String(report.engagements.length)} 个 engagement；` +
              `标记已中断 ${String(report.sessionsMarkedInterrupted.length)} 个会话、` +
              `未结算工具 ${String(report.toolRunsMarkedUnknown.length)} 次、` +
              `阻塞 ${String(report.engagementsBlocked.length)} 个 engagement` +
              (report.needsHumanReconfirmation.length > 0
                ? `；**${String(report.needsHumanReconfirmation.length)} 项需人工重新确认**（高危阶段的未知状态）`
                : '') +
              (report.errors.length > 0 ? `；${String(report.errors.length)} 项失败` : ''),
          );
        }
      })
      .catch((error: unknown) => {
        // 对账失败不阻止索引调度起：两者互不依赖，让能跑的继续跑
        log(ctx, 'warn')(
          `启动对账未完成：${error instanceof Error ? error.message : String(error)}。` +
            `残留状态仍可在控制台手动触发对账处理。`,
        );
      });
  }

  if (own !== undefined) {
    // 租约心跳与索引调度同时起：前者保证会话不会因 TTL 到期而失去执行能力，
    // 后者保证积压的索引任务被处理。两者互不依赖，失败各自记录。
    own.heartbeat.start();
    backgroundLoops.heartbeat = true;
    log(ctx, 'info')(`租约心跳已启动：每 ${String(own.heartbeat.intervalSeconds)}s 续租临界租约`);

    own.scheduler.start();
    backgroundLoops.scheduler = true;
    const interval = own.scheduler.intervalMs;
    log(ctx, 'info')(
      `索引调度已启动：${interval === null ? '仅启动重扫（未启用周期）' : `启动重扫 + 周期排空每 ${String(interval)}ms`}`,
    );

    // 通知监听最后起：它只是延迟优化，失败（例如数据库不可达）会自己重连，
    // 不影响上面两个已经起好的循环。
    own.notify?.start();
    backgroundLoops.notify = own.notify !== null;
    if (own.notify !== null) {
      log(ctx, 'info')('唤醒通知监听已启动：入队时立即触发索引，不依赖周期');
    }
  }
  // ── 控制台端点面（§16.1）：注册为 Typert Gateway 服务 ──
  //
  // 端点通过**共享网关** `/api` 暴露：`POST /api/pentest/<method>`。
  //
  // 为什么不再自建通道：`ctx.connection.rpc.handle(channel, …)` 在本版本**不可用**。
  // 它内部是 `owner.effect(() => owner.webServer.register(route))`，而 `owner` 是
  // **connection 服务自己的 ctx**（`get rpc() { const owner = this.ctx … }`），
  // 其 `inject` 只有 `['credentials']`、不含 `webServer`，于是属性读取直接抛
  // `cannot get property "webServer" without inject`——对**任何**调用方都成立。
  // 官方生态里无人调用它，属上游潜伏缺陷；实测已在其上花掉数轮排查。
  //
  // 共享网关的 `intercept('/api', …)` 每通道只允许一个，已被 typert-gateway 占用，
  // 但它的 `claimsEndpoint` 会自动认领**任何活跃服务**上带 `typertRemote` 绑定与
  // `@Remote` 标记的 `namespace/method` 端点（SRC 模式，零 codegen）。
  // 见 `src/console/typert-face.ts` 的说明。
  //
  // 这一层**不需要 connection，也不需要 webServer**：它只是注册一个 cordis 服务，
  // 由网关在分发时自行查找。因此 headless 部署里它照样成立（只是没人调它）。

  if (config.operator === undefined) {
    log(ctx, 'warn')(
      '未配置 config.operator：控制台端点未注册（UI 将无法调用任何端点）。' +
        '宿主的通道级认证只提供「已认证」这个二元事实，不提供操作者身份，因此必须由部署方声明。',
    );
  } else if (services.consoleRpc === undefined) {
    log(ctx, 'warn')(
      '控制台端点未注册：本实例的服务面没有 consoleRpc（宿主 provide 时未带该面）。' +
        'Worker 工具不受影响；需要控制台时请让组合层一并 provide。',
    );
  } else {
    const operator = config.operator;
    // 构造即注册：`TypertRemoteService` 的构造函数会 `super(ctx, 'pentest')`
    // 并把 `typertRemote` 绑定写在实例上——后者正是网关扫描的对象。
    // 实例必须被持有（否则可能被回收），但生命周期由 cordis 管，这里只需不丢弃引用。
    const typertFace = new ConsoleTypertService(ctx, {
      rpc: services.consoleRpc,
      operator: {
        id: operator.id,
        source: operator.source ?? 'local-console',
      },
    });
    void typertFace;
    log(ctx, 'info')(
      `控制台端点已注册为 Remote 命名空间 ${CONSOLE_TYPRET_SERVICE}：` +
        `POST /api/${CONSOLE_TYPRET_SERVICE}/<method>（操作者 ${operator.id}）`,
    );
  }

  log(ctx, 'info')(
    `已注册 ${names.length} 个 Worker 工具；` +
      `其中触及目标的为 ${TARGET_TOOL_NAMES.join(', ')}（准入判定在 ExecutionService 内）`,
  );
  return { toolsRegistered: names, servicesBound: true, backgroundLoops };
}

/**
 * 若配置了运行时，则自行组合。
 *
 * `compose.ts` 用静态导入：它是本插件的组成部分，不是可选插件，
 * 让构建期就能看到这条依赖比省一次模块加载更重要。
 */
async function composeIfConfigured(ctx: Context, config: PluginConfig): Promise<ComposedPlugin | undefined> {
  if (config.runtime === undefined) return undefined;

  // runtime 的类型在 compose.ts（依赖 pg），此处经 unknown 传递以保持 index.ts 的
  // 依赖面窄——校验交给 compose 自身（它会对数据库与沙箱配置做启动自检）。
  const runtime = config.runtime as ComposeConfig;
  // 会话工厂**必须**在这里注入：真实实现要 `ctx.agents.create`，只有本层同时持有
  // `ctx` 与 runtime 配置（compose 是纯服务装配，拿不到 ctx；部署方的 YAML 更拿不到）。
  // 之前这行不存在，于是 `config.sessions` 永远是 undefined、工作流拿到
  // `missingSessionFactory`——点「启动 Agent」必报「未注入会话工厂」，任何 Agent 都起不来。
  // ── 表结构迁移：**必须在 compose 之前** ──
  //
  // 两个理由，都是实测踩出来的：
  //   1. 插件不自建 schema，而「忘了迁移」的表现是插件正常启动、界面正常渲染，
  //      只有每次动作都以 `relation "pentest.xxx" does not exist` 失败——最难查的一类。
  //   2. 顺序有硬要求：`recovery.onStartup` 会立刻查 `worker_sessions`。迁移若与它并发，
  //      新库上对账必然报「表不存在」并静默降级。await 迁移就消除了这个竞态。
  //
  // 迁移本身幂等（已应用的版本记在 `pentest.schema_migrations`），已是最新时只做一次查询。
  const dbConfig = narrowDatabase(runtime.database);
  if (dbConfig !== undefined && (dbConfig.migrateOnStartup ?? true)) {
    await migrate({ connectionString: dbConfig.url, log: (m) => log(ctx, 'info')(`表结构：${m}`) });
  }
  if (dbConfig !== undefined) {
    // RLS 组合自检（事故 2026-10-05）：RLS 是否**真的**构成边界取决于连接角色与
    // `runtime.rlsContext` 的组合，而不是配置文件里写了什么。不合格的组合必须显式
    // 告警或拒绝启动——静默的「以为有隔离」比没有隔离更危险。
    const rls = await inspectRls({ url: dbConfig.url }, runtime.rlsContext !== undefined);
    for (const warning of rls.warnings) {
      log(ctx, 'warn')(`RLS 自检（当前角色 ${rls.currentUser}）：${warning}`);
    }
    if (rls.refusals.length > 0) {
      throw new PentestBootError(`RLS 自检未通过：${rls.refusals.join('；')}`);
    }
  }

  // 沙箱可达性自检（2026-10-07）：与 RLS 自检并列——两者都是"启动时把部署事实说出来"。
  // 放在这里而非 compose() 里，三个理由：① 它在**启动路径**上，启动早退时不会漏印；
  // ② compose() 保持无副作用（此前每次 compose 都真 spawn 一个 docker inspect，单测里二十多次）；
  // ③ 出口统一到启动类日志的可见通道。
  // **注意出口**：这里用 console 而不是 `log(ctx, 'info')`——cordis 的 logger 默认只写内存
  // 环形缓冲、不接 console（本仓在 `onInternalError` 处踩过同一个坑并把结论写在注释里），
  // 用 log(ctx) 会让这条"唯一说清出不出网"的话**根本看不见**（实测：线上日志里那行消失）。
  // **永不抛**：放开是操作者的决定，探针失败只降级为一行说明。
  {
    const sandbox = runtime.sandbox;
    const note = await probeReachability(spawnRunner, sandbox.internalNetwork, sandbox.allowEgress).then(
      (fact) => renderReachabilityNote(fact),
      (error: unknown) => `[dsh-pentest] 沙箱可达性自检未完成：${error instanceof Error ? error.message : String(error)}`,
    );
    console.log(note);
  }

  // 模型路由：**优先跟随宿主声明的默认模型**。
  //
  // 插件内置的那个默认值（`deepseek-official/deepseek-flash`）是猜的，而猜错的代价不是
  // 建会话报错，而是第一个回合直接失败（`no adapter registered for provider ...`）——
  // 会话已建、库里已是 active，表现为「Agent 起来了但永远不产出」。
  // 宿主自己知道默认模型是什么（`ctx.agentDefaultModel`），问它比猜准。
  // 优先级：显式配置 > 宿主默认 > 内置默认。
  // **不要在这里快照**：`currentSelection()` 是活的（人类在界面里随时能换模型），
  // 取一次存下来就等于把"我在界面选的模型"和"Agent 用的模型"永久错开。
  // 传一个闭包下去，每次创建会话现取一次。
  const hostModel = (): { readonly provider: string; readonly model: string } | undefined =>
    hostDefaultModel(ctx);
  // 会话预设：先**解析**再传，不能把 id 直接丢给工厂。
  // `agentPresets.mount()` 对未知 id 抛 `agent-preset/not-found`，而那会让**每一次**
  // 创建会话都失败——即「预设没装好 → 整个插件用不了」。解析放在这里，缺了就整个不挂。
  const presetId = await resolveSessionPreset(ctx, runtime.sessionPreset, (m) => log(ctx, 'warn')(m));
  // 挂载函数在这里构造：**服务读取的风险集中在装配层一处**，工厂只依赖一个函数
  // （见 `DshSessionFactoryDeps.mountPreset` 的说明）。
  const mountPreset =
    presetId === undefined
      ? undefined
      : async (agentCtx: unknown): Promise<void> => {
          const service: unknown = ctx.get('agentPresets');
          const mount: unknown =
            service !== null && typeof service === 'object'
              ? (service as { mount?: unknown }).mount
              : undefined;
          if (typeof mount !== 'function') {
            throw new Error(`宿主 agentPresets 服务不可用：无法挂载预设 ${presetId}`);
          }
          await (mount as (c: unknown, id: string) => Promise<unknown>).call(service, agentCtx, presetId);
        };
  const runtimeBudget = runtime.dshBudget ?? budgetPortOf(ctx);
  const composed = compose({
    ...runtime,
    // 按会话区分工作目录（2026-10-08）：优先用**宿主的会话头 cwd**（"我在哪个目录开会话"），
    // 取不到再退回 profile 的 `runtime.sessionCwd`（会话工厂本来就按这个优先级用 cwd ✓）。
    sessionCwdOf: (dshSessionId: string) => {
      // `ctx.sessions.get` 要的是品牌类型 `SessionId`，而这里的入参是普通字符串（它来自
      // 会话头与工具上下文）。这一处是**唯一**的边界，集中在这里转换而不是让上游到处带品牌。
      const session = ctx.sessions.get(dshSessionId as Parameters<typeof ctx.sessions.get>[0]);
      return session?.header.cwd ?? runtime.sessionCwd;
    },
    ...(runtimeBudget === undefined ? {} : { dshBudget: runtimeBudget }),
    ...(runtime.modelRoute === undefined ? { modelRoute: hostModel } : { modelRoute: runtime.modelRoute }),
    sessions: runtime.sessions ?? new DshSessionFactory(ctx, {
      ...(runtime.sessionCwd === undefined ? {} : { cwd: runtime.sessionCwd }),
      // 会话提示词里的挂载说明必须与沙箱 argv 同源（见 DshSessionFactoryDeps.sandboxMounts）。
      ...(runtime.sandbox.mounts === undefined ? {} : { sandboxMounts: runtime.sandbox.mounts }),
      ...(mountPreset === undefined ? {} : { mountPreset }),
      ...(presetId === undefined ? {} : { presetId }),
    }),
    // 会话即 intake 的审计归属：Agent 在对话里开作业时没有控制台 CallContext，
    // 由这里注入部署声明的身份（与 config.operator 同一来源）。
    ...(config.operator === undefined ? {} : { operatorId: config.operator.id }),
    // DNS 地址裁决（§10.2.2「DNS 解析与地址固定」）。**必须**在装配层给：
    resolveAddresses: runtime.resolveAddresses ?? defaultResolveAddresses,
  });
  // dsh-budget 监听的是同一条宿主 session/event 流；这里再把 Worker 会话的
  // step/message 边界交给 pentest 预算闸门。监听器只负责派发，写账本由 compose 串行化。
  ctx.on('session/event', (session, event) => {
    if (event.type !== 'step/start' && event.type !== 'assistant/message') return;
    void composed.budgetLifecycle.observe(String(session.id), event.type).catch((error: unknown) => {
      log(ctx, 'error')(
        `Worker 预算评估失败：${error instanceof Error ? error.message : String(error)}`,
      );
    });
  });

  // 卸载时释放连接池与独占写连接。`composed.dispose` 内部会先停调度器，
  // 避免释放连接时有在途写入。
  //
  // `ctx.effect` 的契约：回调必须**返回 disposer 本身**（或它的 Promise），
  // 不能返回一个「返回 disposer 的函数」——后者会抛 `Invalid effect`
  // 并使整个 boot 失败（真实 boot 抓到的缺陷）。
  ctx.effect(() => composed.dispose, 'pentest: dispose composition');

  config.onComposed?.(composed.hostServices);
  return composed;
}

/**
 * 从 `unknown` 的 runtime 配置里窄化出数据库段。
 *
 * `index.ts` 刻意不依赖 `compose.ts` 的类型（那份类型会拖进 pg 的类型面），
 * 所以这里按「用到什么才检查什么」收窄：拿不到 url 就返回 undefined，
 * 由 `compose()` 自己去做完整的配置自检（它才是校验的权威）。
 */
function narrowDatabase(value: unknown): { readonly url: string; readonly migrateOnStartup?: boolean } | undefined {
  if (value === null || typeof value !== 'object') return undefined;
  const { url, migrateOnStartup } = value as { url?: unknown; migrateOnStartup?: unknown };
  if (typeof url !== 'string' || url === '') return undefined;
  return {
    url,
    ...(typeof migrateOnStartup === 'boolean' ? { migrateOnStartup } : {}),
  };
}

/**
 * 解析要挂到 Worker 会话上的 dsh 预设 id。
 *
 * ── 为什么必须在这里解析 ──
 *
 * dsh 的 `agentPresets.mount()` 对未知 id 抛 `agent-preset/not-found`。若把 id 直接交给
 * 会话工厂，一个没装预设的部署会**每次创建会话都失败**——即「装了个插件，整个功能不能用」。
 * 而预设是**可选**的姿态增强，不值得这种耦合。
 *
 * ── 默认值与「缺了怎么办」 ──
 *
 * 默认 `pentest`（本插件随包发的那个）。三种情形区别对待：
 *
 *   - **显式配置了 id 但它不存在**：记 `warn`（运维写了配置却没生效，必须可见），不挂。
 *   - **用的是内置默认但不存**：记 `warn`（同上，且顺带说明它随包发在哪），不挂。
 *     ——这条在「只装了 lib/ 没带 presets/」或「没在 profile 里给 agent-presets 配 roots」
 *     的部署上会出现，是常见情况而非异常。
 *   - **显式配置成 null / ''**：静默不挂（那是明确的「我不要预设」）。
 *
 * 三种都不抛：会话能建起来、能干活，只是没有那层姿态提示词。
 */
async function resolveSessionPreset(
  ctx: Context,
  configured: string | null | undefined,
  warn: (message: string) => void,
): Promise<string | undefined> {
  // 显式关掉：静默。
  if (configured === null || configured === '') return undefined;

  const wanted = configured ?? DEFAULT_SESSION_PRESET;

  // **必须走 `ctx.get`，不能用属性访问。**
  //
  // cordis 里 `ctx.agentPresets` 这类属性读取对**未在自己 `inject` 里声明**的服务
  // **直接抛错**（`cannot get property "agentPresets" without inject`）。而这里刻意不把
  // `agentPresets` 加进 `inject`——`inject` 是**等待**语义，服务不出现会让整个插件永不
  // apply 且不报任何错（比抛错更难查）。用一个可选功能换那个风险不值得。
  //
  // 实测代价：这一行曾经写成属性访问，结果是**整个插件 boot 失败**——
  // 那就成了「装个插件把整个 dsh 拖挂」，而且失败点还是一个可选功能。
  // 因此下面从取服务到枚举清单**全程 try/catch**：任何异常都只降级为「不挂预设」。
  try {
    if (!('get' in ctx) || typeof ctx.get !== 'function') return undefined;
    const service: unknown = ctx.get('agentPresets');
    if (service === null || typeof service !== 'object') {
      warn(
        `宿主没有 agentPresets 服务（未装 @deepseek-ai/dsh-agent-presets）：` +
          `Worker 会话将不挂预设 ${wanted}。这不影响功能，只是少了那层姿态提示词。`,
      );
      return undefined;
    }

    const list: unknown = (service as { list?: unknown }).list;
    if (typeof list !== 'function') {
      warn(`宿主 agentPresets 服务没有 list()：无法确认预设 ${wanted} 是否存在，因此不挂。`);
      return undefined;
    }

    const presets: unknown = await (list as () => Promise<unknown>).call(service);
    const ids: readonly string[] = Array.isArray(presets)
      ? presets
          .map((entry) => (entry !== null && typeof entry === 'object' ? (entry as { id?: unknown }).id : undefined))
          .filter((id): id is string => typeof id === 'string')
      : [];

    if (!ids.includes(wanted)) {
      warn(
        `预设 ${wanted} 不在宿主的预设清单里（现有：${ids.join('、') || '无'}），Worker 会话将不挂预设。` +
          `若想要它：把本仓的 presets/ 目录加进 agent-presets 行的 config.roots，见 RUNBOOK 的「渗透模式」一节。`,
      );
      return undefined;
    }

    log(ctx, 'info')(`Worker 会话将挂载预设 ${wanted}`);
    return wanted;
  } catch (error) {
    warn(
      `解析会话预设 ${wanted} 失败（将不挂预设，不影响其它功能）：` +
        `${error instanceof Error ? error.message : String(error)}`,
    );
    return undefined;
  }
}

/** 内置默认的会话预设（本插件随包发的那个）。 */
const DEFAULT_SESSION_PRESET = 'pentest';

/**
 * 读宿主声明的默认模型（provider / model）。
 *
 * 用 `ctx.get(...)` 而不是属性访问：cordis 的属性读取对**未在自己 `inject` 里声明**的
 * 服务直接抛错，而这里刻意不把 `agentDefaultModel` 加进 `inject`——`inject` 是**等待**
 * 语义，服务不出现会让整个插件永不 apply 且不报错。一个可选的便利值不值得那个风险，
 * 所以走容错读取，读不到就返回 undefined（调用方回落到内置默认）。
 *
 * 形状不符（缺 provider/model、非字符串、空串）一律当读不到：宁可回落到内置默认，
 * 也不要拿一个残缺的路由去建会话——那会以「回合内失败」的形式表现出来，最难查。
 */
function hostDefaultModel(ctx: Context): { readonly provider: string; readonly model: string } | undefined {
  if (!('get' in ctx) || typeof ctx.get !== 'function') return undefined;
  const service: unknown = ctx.get('agentDefaultModel');
  if (service === null || typeof service !== 'object') return undefined;
  const pick: unknown = (service as { currentSelection?: unknown }).currentSelection;
  if (typeof pick !== 'function') return undefined;

  let selection: unknown;
  try {
    selection = pick.call(service);
  } catch {
    // 服务存在但取不到值（未就绪、被卸载）——回落到内置默认，不打断装配。
    return undefined;
  }
  if (selection === null || typeof selection !== 'object') return undefined;
  const { provider, model, reasoningEffort } = selection as {
    provider?: unknown;
    model?: unknown;
    reasoningEffort?: unknown;
  };
  if (typeof provider !== 'string' || provider === '') return undefined;
  if (typeof model !== 'string' || model === '') return undefined;
  return {
    provider,
    model,
    // 思考档位（界面上的 High/Max）也要继承，否则"换了档位不生效"是同一类问题。
    ...(reasoningEffort === 'low' || reasoningEffort === 'high' || reasoningEffort === 'max'
      ? { reasoningEffort }
      : {}),
  };
}

/**
 * 默认的地址裁决：把主机名解析成地址列表。
 *
 * 解析不出地址即返回 `undefined`（而不是空数组或抛错）——策略层把「没有裁决结果」
 * 与「裁决为不在范围内」同等对待，按 `dns_unresolved` 拒绝并给出可读原因。
 * 两种 IP 族都取：只取 IPv4 会让纯 IPv6 目标永远无法执行。
 */
async function defaultResolveAddresses(host: string): Promise<readonly string[] | undefined> {
  // `all: true` 一次拿齐两个地址族；不分别按 family 查两次。
  const records = await lookup(host, { all: true }).catch(() => []);
  const addresses = records.map((r) => r.address);
  return addresses.length === 0 ? undefined : addresses;
}

/** 从宿主 dsh-budget 官方 service 取只读 token 适配器。 */
function budgetPortOf(ctx: Context): DshBudgetPort | undefined {
  const service = ctx.get('budget') as {
    readonly status?: (sessionId?: string) => {
      readonly scopes?: readonly { readonly scope: string; readonly tokens: number }[];
    };
  } | undefined;
  if (service === undefined || typeof service.status !== 'function') return undefined;
  return {
    readUsage(dshSessionId: string) {
      const session = service.status!(dshSessionId).scopes?.find((scope) => scope.scope === 'session');
      const totalTokens = Number(session?.tokens ?? 0);
      if (!Number.isSafeInteger(totalTokens) || totalTokens < 0) {
        throw new Error(`dsh-budget 官方 session token 读数非法：${String(session?.tokens)}`);
      }
      // dsh-budget 0.4.9 的公开 service/status 只暴露 session 总 token；
      // 不从事件自行重算，未知的 input/output 分拆保持为 0，total 仍是官方值。
      return {
        source: 'dsh-budget',
        inputTokens: 0,
        outputTokens: 0,
        totalTokens,
        sessionSeq: 0,
      };
    },
  };
}

/** 取一个具名 logger 的方法。
 *
 * cordis 的 `ctx.logger` 是**可调用服务**：`ctx.logger(name)` 返回具名 logger，
 * 也可直接 `ctx.logger.info(...)` 用默认名。这里统一走 `ctx.logger(name)`，
 * 并容忍 logger 缺失（测试用假 ctx 可能不提供）。
 */
function log(
  ctx: Context,
  level: 'info' | 'warn' | 'error',
): (message: string) => void {
  return (message: string) => {
    // 关键降级/失败**同时打到 console**：cordis 的 logger 默认只写内存环形缓冲，
    // 不接 console。只走 logger 的警告在终端与浏览器里一个字都看不到——那会让
    // 「插件静默降级」变成没有线索的黑洞（实测踩过：控制台通道没注册，服务端无迹可寻）。
    if (level !== 'info') console[level](`[dsh-pentest] ${message}`);

    if (!('logger' in ctx)) return;
    const logger: unknown = ctx.logger;
    if (typeof logger === 'function') {
      const named: unknown = logger.call(ctx, 'dsh-pentest');
      if (named !== null && typeof named === 'object' && level in named) {
        const fn: unknown = (named as Record<string, unknown>)[level];
        if (typeof fn === 'function') fn.call(named, message);
      }
      return;
    }
    if (logger !== null && typeof logger === 'object' && level in logger) {
      const fn: unknown = (logger as Record<string, unknown>)[level];
      if (typeof fn === 'function') fn.call(logger, message);
    }
  };
}

/**
 * 把 cordis 的两个扩展点适配成守卫需要的宿主面。
 *
 * `ctx.on` 的事件签名是 `(payload, next)`；守卫只用拒绝语义，放行交给 `next()`，
 * 这样与同一瀑布上的其他监听器（如宿主的权限插件）能正常共存。
 */
function guardHostOf(ctx: Context): Parameters<typeof installGuard>[0] {
  return {
    on: (_event, handler) => {
      ctx.on(
        'tools/pre-execute',
        (async (call: unknown, next: () => Promise<unknown>) => {
          const decision = handler(call as never);
          if (decision.kind === 'deny') {
            return { kind: 'deny', reason: decision.reason };
          }
          return next();
        }) as never,
      );
    },
    guard: (fn) => ctx.tools.guard(fn as never),
  };
}

/**
 * 从 ctx 取组合层提供的宿主服务面。
 *
 * 用 `in`/`typeof` 窄化而非类型断言：宿主组合层的形状不由本插件的类型定义保证。
 */
function hostServicesOf(ctx: Context): PentestHostServices | undefined {
  if (!('get' in ctx) || typeof ctx.get !== 'function') return undefined;
  const found: unknown = ctx.get(PENTEST_HOST_SERVICES);
  if (found === null || typeof found !== 'object') return undefined;
  if (!('workerTools' in found) || found.workerTools === null || typeof found.workerTools !== 'object') {
    return undefined;
  }
  // `consoleRpc` 可选：有就带上，没有就只给工具面（headless 部署的常态）。
  const consoleRpc = 'consoleRpc' in found && found.consoleRpc !== null && typeof found.consoleRpc === 'object'
    ? (found.consoleRpc as ConsoleRpc)
    : undefined;
  return {
    workerTools: found.workerTools as WorkerToolDeps,
    ...(consoleRpc === undefined ? {} : { consoleRpc }),
  };
}

/**
 * dsh loader 并行启动同级 entry；等待已经在途的生态 entry，避免 `apply` 在
 * sibling runtime 注册前把 registry 读成半成品。这里只等待 entry 自己的启动任务，
 * 绝不调用 `entry.init()` 或再次触发 fiber await：active entry 的初始化只能由
 * loader 拥有者执行一次。未配置或尚未启动的 entry 不会被伪造为已安装，最终仍由
 * `assertEcosystem` 精确拒绝。
 */
async function awaitConfiguredEcosystem(ctx: Context, required: readonly string[]): Promise<void> {
  const loaderValue: unknown = 'loader' in ctx ? ctx.loader : undefined;
  if (loaderValue === null || typeof loaderValue !== 'object') return;
  if (!('entries' in loaderValue) || typeof loaderValue.entries !== 'function') return;
  const entries = [...loaderValue.entries()];
  const waits: Promise<void>[] = [];
  for (const packageName of required) {
    const entry = entries.find((candidate) => {
      if (candidate === null || typeof candidate !== 'object') return false;
      if (!('options' in candidate) || candidate.options === null || typeof candidate.options !== 'object') return false;
      return 'name' in candidate.options && candidate.options.name === packageName;
    });
    if (entry === undefined) continue;
    const activation = async (): Promise<void> => {
      if (entry._initTask !== undefined) await entry._initTask;
    };
    waits.push(activation());
  }
  await Promise.all(waits);
}
/** 已安装的生态插件名：读取 Cordis registry 的运行时记录，而不是猜测服务名。 */
function ecosystemNames(ctx: Context): readonly string[] {
  if ('registry' in ctx && ctx.registry !== null && typeof ctx.registry === 'object') {
    const registry = ctx.registry;
    if (typeof registry.values === 'function') {
      const names: string[] = [];
      for (const runtime of registry.values()) {
        if (runtime !== null && typeof runtime === 'object' && typeof runtime.name === 'string') {
          names.push(runtime.name);
        }
      }
      return names;
    }
  }
  // 兼容最小宿主/测试桩；真实 Cordis 使用上面的 ctx.registry。
  if (!('get' in ctx) || typeof ctx.get !== 'function') return [];
  const reg: unknown = ctx.get('pluginRegistry');
  if (reg === null || typeof reg !== 'object') return [];
  if (!('names' in reg) || typeof reg.names !== 'function') return [];
  const names: unknown = reg.names.call(reg);
  if (!Array.isArray(names)) return [];
  return names.filter((n): n is string => typeof n === 'string');
}
