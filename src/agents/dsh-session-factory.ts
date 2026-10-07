/**
 * 真实 DSH 会话工厂：`SessionFactory` 端口的 dsh 适配器。
 *
 * 设计依据：docs/dsh-pentest-plugin-design.md §4.3（顶层会话生命周期：
 * 「创建 → 冻结能力 → 注入任务 → 运行」）、§5.3（顶层 Agent）、§7.2（交接草稿形状）、
 * §7.4（新会话的上下文注入）、§10.6（租约）、§15.6（草稿失败时保持人工判断）。
 *
 * ── 本文件依赖面为什么这么窄 ──
 *
 * 本插件的 `package.json` 只声明了 `cordis` / `dsh-session` / `dsh-tools` /
 * `dsh-util-values` 这几个生态包（其余运行时由宿主提供）。**`@deepseek-ai/dsh-llm`
 * 与 `@deepseek-ai/dsh-brand` 不在其中**（实测：`node -e "require.resolve('@deepseek-ai/dsh-llm')"`
 * 在本仓库根目录失败）。因此：
 *
 *   - `createUserMessage` 不能 import。它在 dsh 0.1.5-rc.2 里的实现是
 *     `createMessage({...input, role:'user'})`，而 `createMessage` 就是
 *     `deepFreeze(structuredClone({...input, id: randomUUID()}))`
 *     （`dsh-llm/lib/types/message.js:28-50`）。本文件按同一形状**本地镜像**它，
 *     并原样用 `dsh-util-values` 的 `deepFreeze`。
 *   - `brandString` 是**编译期**品牌（`dsh-brand/lib/index.js`：`function brandString(value){return value}`），
 *     运行时就是原值；所以 `sessionId` 直接传字符串即可，品牌由类型断言补齐。
 *   - `agentCtx.tools` / `agentCtx.systemPrompt` 的类型由 `dsh-tools` /
 *     `dsh-system-prompt` 的模块增强提供，而后者不是本插件的依赖。本文件因此用
 *     **最小结构视图**（只声明真正调用的成员）经 `ctx.get(name)` 取用宿主服务，
 *     并在每个 seam 缺失时 fail loud（抛 `SessionFactoryError`），绝不静默降级为
 *     「一个没有能力限制的会话」。
 *
 * ── 实测确认的缝（dsh 0.1.5-rc.2）──
 *
 *   - `ctx.agents.create({ sessionId, meta:{cwd}, agentOptions:{provider,model}, setup })`：
 *     `parentAgent` 省略即**顶层** Agent；`setup(agentCtx)` 在会话与 Agent 被插入/公告**之前**
 *     执行（`dsh-agent/lib/types/index.d.ts:88-104`），因此能力冻结必须在这里完成。
 *   - `agentCtx.tools.restrict({ allow })`：收窄**调用方作用域**继承来的全局工具
 *     （`dsh-tools/lib/index.js:2790`：`scopeOf(this.ctx)`，非 scoped context 直接抛错）。
 *     `allow` 里出现宿主不认识的名字会抛错 → 这正是我们要的 fail loud。
 *   - `agentCtx.systemPrompt.section({ name, order, text })`：在**调用方作用域**注册提示词分节
 *     （`dsh-system-prompt/lib/types/index.d.ts:233`）；同名分节在一次创建里只能注册一次。
 *   - `agent.followup(msg)`：排入一个**独立的后续回合**并唤醒驱动；`agent.steer(msg)`：投递给
 *     **最近的步骤边界**（idle 时直接开启一个回合）。`agent.whenIdle()` 等整机静默。
 *   - `agent.cancel(cause, { keepInbox })`：中止当前回合；`cause` 会落进 `turn/end` 的
 *     `aborted.reason`（`AgentCancelCause` 的 `hook` 变体带 `reason` 字符串，见
 *     `dsh-session/lib/types/types.d.ts:148`）——本文件的 `interrupt(reason)` 正是用它。
 *   - 关闭用 `AgentHandle.dispose()`：停循环、注销 Agent、移除会话、解开作用域
 *     （`dsh-agent/lib/types/index.d.ts:138`）。会话的持久化由宿主持久化插件负责，
 *     本进程不退出，因此这里**不调用** `sessions.flush`；草稿的耐久性由工作流写
 *     `handoffs.draft_json` 保证（§8.2 两条通道互不混写）。
 *
 * ── 消息来源（`createUserMessage` 的 `source`）──
 *
 * 可选值来自 `MessageSourceMap`（`dsh-llm/lib/types/message.d.ts`）：
 * `user` / `plugin` / `model` / `tool`，其中 `plugin` 变体是
 * `{ kind:'plugin', plugin:string } & ContextFormed`。本文件一律用
 * **`{ kind:'plugin', plugin:'dsh-pentest' }`**：投递内容的**生产者是本插件**，不是终端用户
 * 直接输入——`kind:'user'` 是给终端/控制台 RPC 用的（`dsh-api-session-controller` 的 prompt
 * 路径就是 `{ kind:'user', rpcId }`）。`ContextFormed` 的 `form` 有意**不声明**：
 * `relay` 的语义是「另一个 Agent 投给这个 Agent」，而这里是人类经插件转投，声明成 `relay`
 * 反而失真；不声明即文档里的默认（不透明内容）。实测确认这条消息会被正常受理：
 * 回合准入不按 `source.kind` 过滤，只有 `dsh-system-prompt` 自己的运行时上下文投影会用
 * `source.kind === 'plugin'` 认领自己的消息（`dsh-agent-loop/lib/index.js:223`）。
 */

import { randomUUID } from 'node:crypto';

import type { Context } from '@deepseek-ai/cordis';
import { SessionSeq } from '@deepseek-ai/dsh-session';
import type { SessionId } from '@deepseek-ai/dsh-session';
import { deepFreeze } from '@deepseek-ai/dsh-util-values';

import { describeError } from '../contracts.ts';
import type { SandboxMount } from '../contracts.ts';
import { describeActionClasses, actionClassLabelSafe } from '../policy/action-class-labels.ts';
import { renderSandboxBrief } from './sandbox-brief.ts';
import type {
  CreatedSession,
  FrozenSessionInput,
  SessionFactory,
} from '../workflow/session-port.ts';
import { HUMAN_QUESTION_TOOL } from '../contracts.ts';
import { SessionFactoryError } from '../workflow/session-port.ts';
import { renderBehaviorSection } from '../policy/behavior-prompts.ts';

// ───────────────────────────── 常量 ─────────────────────────────

/** 消息来源里标记本插件的名字；必须与 `src/index.ts` 的 `name` 一致。 */
const PLUGIN_NAME = 'dsh-pentest';


interface PromptSectionView {
  readonly name: string;
  readonly order: number;
  readonly text: string;
}

interface SystemPromptView {
  section(section: PromptSectionView): unknown;
}

/** `setup(agentCtx)` 收到的 agent 作用域 context。 */
interface AgentScopedContextView {
  readonly tools?: ToolRuntimeView;
  readonly systemPrompt?: SystemPromptView;
}

interface AgentCreateOptionsView {
  readonly sessionId: SessionId;
  /**
   * 注意：本文件**有意不声明** `parentAgent`。类型上不给你放宽的入口，
   * 运行时更不允许出现——省略即顶层 Agent（§5.3）。
   */
  readonly meta: { readonly cwd: string };
  readonly agentOptions: {
    readonly provider: string;
    readonly model: string;
    readonly reasoningEffort?: 'low' | 'high' | 'max';
  };
  /**
   * `setup` 可以返回 Promise：dsh 会等它完成才公告会话与 Agent，并在拒绝时整体回滚
   * （见 `create()` 的注释）。本视图类型此前写死 `void`，与真实行为不符。
   */
  readonly setup: (agentCtx: AgentScopedContextView) => void | Promise<void>;
}

interface UserMessageView {
  readonly id: string;
  readonly role: 'user';
  readonly content: readonly { readonly type: 'text'; readonly text: string }[];
  readonly source: { readonly kind: 'plugin'; readonly plugin: string };
}

interface SessionView {
  /** 会话身份。工厂断言它等于工作流派生出来的 `dshSessionId`。 */
  readonly id: string;
  /** 下一个事件的序号（= 日志长度）。 */
  readonly seq: number;
  eventAt(seq: SessionSeq): unknown;
}

interface AgentView {
  readonly session: SessionView;
  /** 已实测的状态面；`running` 时投递走 steer 语义（见 `deliver`）。 */
  readonly status?: 'idle' | 'running';
  followup(message: UserMessageView): void;
  steer(message: UserMessageView): void;
  cancel(cause: { readonly kind: 'hook'; readonly reason: string }, options: { readonly keepInbox: boolean }): void;
  whenIdle(): Promise<void>;
}

interface AgentHandleView {
  readonly agent: AgentView;
  dispose(): Promise<void>;
}

interface AgentRegistryView {
  create(options: AgentCreateOptionsView): Promise<AgentHandleView>;
  /**
   * 宿主注册表查询。用于判定「会话已关闭或被取代」——dsh 自己的会话控制器
   * 就是用 `ctx.agents.get(id) !== agent` 做这个判断
   * （`dsh-api-session-controller/lib/index.js:771`）。
   */
  get(sessionId: string): AgentView | undefined;
}

/** 本适配器的构造参数。 */
export interface DshSessionFactoryDeps {
  /**
   * 会话工作目录。优先级：`FrozenSessionInput.cwd` > 本值 > `process.cwd()`。
   * §4.3 的「冻结」里 cwd 属于 engagement 的授权目录，由工作流按 engagement 传入。
   */
  readonly cwd?: string;
  /**
   * 沙箱的宿主目录挂载（§10.4）。**只用于写进会话提示词**——真正生效的挂载在
   * `execution/docker-sandbox.ts` 的 argv 里，两者必须来自同一份配置值，否则模型会按
   * "我看得见你的目录" 去规划命令，而容器里根本没有那个路径（症状：`No such file or directory`）。
   */
  readonly sandboxMounts?: readonly SandboxMount[];
  /**
   * 在 agent 作用域里挂载预设（由装配层注入）。
   *
   * ── 为什么是函数而不是预设 id ──
   *
   * dsh 的预设是**目录 + 一份 agent 平面组合**，且 `meta.agentPreset` 只是**元数据**
   * ——真正把预设挂上去的是调用方在 `setup(agentCtx)` 里自己调 `agentPresets.mount()`。
   * 会话工厂若不挂，本插件发的「渗透模式」预设就只对**聊天界面开的会话**生效，
   * 而那些会话**永远拿不到 engagement 绑定**（绑定由控制台的 `startWorker` 创建并派生
   * 会话标识）——预设于是变成一条死路：会话看着像渗透 Agent，却做不了任何事。
   *
   * 但工厂**不该自己去取 cordis 服务**：本插件没在 `inject` 里声明 `agentPresets`，
   * 而 cordis 对未声明服务的**属性读取直接抛**（实测把整个 boot 拖挂过）。把「怎么挂」
   * 交给装配层注入，工厂就只依赖一个函数，既躲开那道门，也不必在测试里伪造 cordis 服务。
   *
   * ── 装配层负责先解析 ──
   *
   * `mount()` 对未知 id 抛 `agent-preset/not-found`；若拿一个部署里不存在的 id，
   * **每次创建会话都会失败**。所以解析在装配层做（先 `list()` 确认存在），
   * 这里收到的已经是一个「确认可用」的挂载函数。
   */
  /**
   * 形参是 `unknown` 而不是本模块内部的 `AgentScopedContextView`：装配层不需要、
   * 也不该依赖那个内部结构视图（它只为躲开宿主 API 的版本漂移而存在）。
   * 真正的类型由本模块在调用点保证。
   */
  readonly mountPreset?: (agentCtx: unknown) => Promise<void>;

  /**
   * 预设 id，**仅用于写进会话元数据**（宿主据此投影「本会话用的是哪个预设」）。
   *
   * 与 {@link mountPreset} 成对出现：挂了预设却不写元数据，界面会显示「无预设」，
   * 而元数据与事实不符比不挂更容易误导。
   */
  readonly presetId?: string;
}

/** 本进程创建且尚未关闭的会话。 */
interface LiveSession {
  readonly handle: AgentHandleView;
}

// 提示词分节的 order：persona 前缀是 0、PLAN_POLICY 是 500。冻结能力与任务简报夹在中间，
// 即「身份之后、工具指引之前」——模型先读到自己的边界，再读到工具目录。
const SECTION_ORDER_CAPABILITY = 300;
// 行为预设排在能力快照之后、任务简报之前：先看边界，再看「该用什么姿态」，最后才是这一轮的任务。
const SECTION_ORDER_BEHAVIOR = 305;
const SECTION_ORDER_TASK = 310;
const SECTION_ORDER_HANDOFF_CONTEXT = 320;
// 公共记忆排在**能力冻结之前**（300 之前）：提示词自上而下读，作业的长期规矩是「前提」，
// 能力冻结是「本次会话的边界」——前提先出现，边界才有依附。
const SECTION_ORDER_PUBLIC_MEMORY = 290;
const SECTION_CAPABILITY = 'pentest:capability-freeze';
const SECTION_BEHAVIOR = 'pentest:behavior-preset';
const SECTION_PUBLIC_MEMORY = 'pentest:engagement-memory';
const SECTION_TASK = 'pentest:task-brief';
const SECTION_HANDOFF_CONTEXT = 'pentest:handoff-context';

/**
 * 工具运行面的最小视图：只声明本适配器真正用到的部分。
 *
 * 收窄是**唯一**的能力入口（`allow` 逐字传下去；宿主对未知工具名抛错，那条错误会带着整次
 * 创建一起回滚——这是想要的 fail loud）。返回值（宿主的 disposer）本适配器不使用：
 * 作用域随会话关闭一起解开。
 */
interface ToolRuntimeView {
  restrict(input: { readonly allow: readonly string[] }): unknown;
}

// ───────────────────────────── 会话工厂 ─────────────────────────────

/**
 * `SessionFactory` 的 dsh 适配器。
 *
 * 生命周期不变式：
 *
 *   1. **顶层**：`agents.create` 不传 `parentAgent`；会话之间的历史关系
 *      （`previous_agent_session_id` 等）由工作流的数据库表达，不经 dsh 父子机制（§5.3）。
 *   2. **冻结**：工具面收窄与提示词分节全部发生在 `setup(agentCtx)` 里，即在会话/Agent
 *      被插入与公告**之前**。本类不提供任何放宽入口；`restrict` 的 disposer 由 agent 作用域
 *      持有，随会话关闭一起解开。
 *   3. **id 由工作流派生**：`sessionId` 原样使用 `input.dshSessionId`（`dsh-<workerSessionId>`），
 *      因为创建 dsh 会话是事务外的异步副作用——时序必须是「先写库（含该标识）→ 再创建会话」，
 *      否则库写入失败会留下没有任何记录指向的孤儿会话。
 *   4. **关闭后不可投递**：`close` 后 `deliver` / `interrupt` / `requestHandoffDraft` 一律失败。
 */
export class DshSessionFactory implements SessionFactory {
  readonly #ctx: Context;
  readonly #cwd: string | undefined;
  readonly #sandboxMounts: readonly SandboxMount[];
  readonly #mountPreset: ((agentCtx: unknown) => Promise<void>) | undefined;
  readonly #presetId: string | undefined;
  readonly #live = new Map<string, LiveSession>();
  readonly #closed = new Set<string>();

  constructor(ctx: Context, deps: DshSessionFactoryDeps = {}) {
    this.#ctx = ctx;
    this.#cwd = deps.cwd;
    this.#sandboxMounts = deps.sandboxMounts ?? [];
    this.#mountPreset = deps.mountPreset;
    this.#presetId = deps.presetId;
  }

  /**
   * 创建顶层会话并冻结能力，随后注入人类确认的任务提示词（§4.3「创建 → 冻结 → 注入任务」）。
   *
   * 注入是**必须**的：新会话的第一次任务不会被别处投递——工作流只在「复用旧会话」
   * 的路径上自己 `deliver`（`pg-workflow.ts` 的 retry 复用分支），新建会话路径上
   * 没有任何其他投递点。这里只把消息排进驱动（`followup`）就返回，**不等**模型跑完：
   * 创建是状态机的同步前置，任务跑多久由 Worker 自己决定。
   */
  async create(input: FrozenSessionInput): Promise<CreatedSession> {
    const agents = this.#agentsOrFail();
    if (this.#live.has(input.dshSessionId) || this.#closed.has(input.dshSessionId)) {
      throw new SessionFactoryError(`dsh 会话标识已被本进程使用过：${input.dshSessionId}`, {
        dshSessionId: input.dshSessionId,
      });
    }

    let handle: AgentHandleView;
    try {
      handle = await agents.create({
        // 品牌只是编译期；运行时 `brandString` 是恒等函数，因此直接传字符串（文件头已说明）。
        sessionId: input.dshSessionId as SessionId,
        // parentAgent 省略 = 顶层 Agent（§5.3）。这里连字段都不出现，避免任何"看起来像子会话"的写法。
        meta: {
          cwd: input.cwd ?? this.#cwd ?? process.cwd(),
          // 记进会话元数据，宿主据此投影「本会话用的是哪个预设」。
          //
          // **以「确实会挂」为条件**，而不是「配了 id」：装配层解析失败时会只给 id 不给
          // 挂载函数，那时写元数据就是在撒谎——界面会显示「渗透模式」，而会话其实没挂上。
          ...(this.#mountPreset === undefined || this.#presetId === undefined
            ? {}
            : { agentPreset: this.#presetId }),
        },
        agentOptions: {
          provider: input.modelRoute.provider,
          model: input.modelRoute.model,
          ...(input.modelRoute.reasoningEffort === undefined
            ? {}
            : { reasoningEffort: input.modelRoute.reasoningEffort }),
        },
        // 预设与能力冻结都在这里完成：setup 返回前，会话与 Agent 都还没被公告。
        //
        // 顺序是先预设后冻结：预设提供的是「姿态」（身份与工作方式），冻结收窄的是
        // 「能力」（工具面）。后者更具体，压在后者之上；反过来会让冻结的分节先注册，
        // 预设想用同名分节时冲突。
        setup: async (agentCtx) => {
          await this.#applyPreset(agentCtx);
          // 按**事实**校正工具面：预设没挂上时它贡献的工具也不存在（见方法注释）。
          installFrozenCapabilities(
            agentCtx,
            {
              ...input,
              toolAllow: this.#toolAllowWithPresetFacts(input.toolAllow),
            },
            this.#sandboxMounts,
          );
        },
      });
    } catch (error) {
      if (error instanceof SessionFactoryError) throw error;
      throw new SessionFactoryError(`创建 dsh 会话失败：${describeError(error)}`, {
        dshSessionId: input.dshSessionId,
        // dsh 对 setup 的抛出/拒绝、commit 失败、owner 卸载都会**整体回滚**且不公告任何 id，
        // 因此带上同一标识重试是安全的；是否重试由工作流决定（§17.2 对账）。
        retryable: true,
        cause: error,
      });
    }

    // 断言会话身份就是我们派生的那个：dsh 若自有其 id，库里那行 dsh_session_id 会指向
    // 一个不存在（或不属于本会话）的标识，属不可接受的静默错配。
    if (handle.agent.session.id !== input.dshSessionId) {
      await handle.dispose().catch(() => undefined);
      throw new SessionFactoryError(
        `dsh 用了不同的会话标识（期望 ${input.dshSessionId}，实际 ${handle.agent.session.id}）：` +
          `库里的记录会指向别的会话，已回滚创建`,
        { dshSessionId: input.dshSessionId },
      );
    }

    const record: LiveSession = { handle };
    this.#live.set(input.dshSessionId, record);

    try {
      this.#deliver(record, input.taskPrompt);
    } catch (error) {
      // 注入失败 → 会话虽然建起来但不会被驱动，绝不能留在注册表里假装活着。
      this.#live.delete(input.dshSessionId);
      await handle.dispose().catch(() => undefined);
      throw error;
    }

    return { dshSessionId: input.dshSessionId };
  }

  /**
   * 在 agent 作用域里挂载预设。
   *
   * 未配置 `presetId` 时什么都不做——预设是**可选**的姿态增强，不是本插件工作的前提。
   * 挂了会让会话带上该预设的提示词分节（以及它可能声明的工具收窄）；不挂则只有本插件
   * 自己的能力分节与任务简报。两者都能正常工作，这正是它可选的原因。
   *
   * 抛错即让 dsh 回滚整个未公告的创建（与能力冻结同一条纪律）：宁可没有这个会话，
   * 也不要一个「看着用了预设、其实没挂上」的会话——那种会话的提示词与人类以为的不一致。
   */
  /**
   * 事实校正：预设**没挂上**时，把它贡献的工具从允许列表里拿掉。
   *
   * 为什么必须校正：`agentCtx.tools.restrict({ allow })` 对**未知工具名**抛错，而那条错误
   * 会让整次创建回滚（fail loud 是刻意的）。但预设是**可选**的姿态增强——`resolveSessionPreset`
   * 解析不到就整个不挂（例如宿主没有 `agentPresets`、或预设目录没配）。那时预设的行
   * （含官方提问工具 `ask_user_question`）在继承面上**不存在**，allow 里仍留着它，
   * 就等于把「少了一层姿态提示词」升级成「会话根本建不起来」。
   *
   * 裁剪同时让注入提示词的那份工具清单保持可信（§2.4 的冻结快照必须与真实可见面一致）。
   */
  #toolAllowWithPresetFacts(toolAllow: readonly string[]): readonly string[] {
    if (this.#mountPreset !== undefined) return toolAllow;
    return toolAllow.filter((name) => name !== HUMAN_QUESTION_TOOL);
  }

  async #applyPreset(agentCtx: AgentScopedContextView): Promise<void> {
    const mount = this.#mountPreset;
    if (mount === undefined) return;
    const presetId = this.#presetId ?? '(未命名)';

    try {
      await mount(agentCtx);
    } catch (error) {
      // 不吞异常：预设挂不上说明部署配置有问题（id 写错、组合有坏行），
      // 而「静默不挂」会让会话以错误的提示词工作到人类发现为止。
      throw new SessionFactoryError(
        `挂载会话预设 ${presetId} 失败：${describeError(error)}`,
        { cause: error, retryable: false },
      );
    }
  }

  /**
   * 投递一条人类消息（任务、插话、放行结果）。
   *
   * dsh 的两条投递语义（端口注释的原话）：
   *   - 运行中的会话「按 steer 语义在下个步骤边界接收」→ `agent.steer()`；
   *   - 等待中的会话「被唤醒后接收」→ `agent.followup()`（排入独立回合并唤醒驱动）。
   * 因此按 `agent.status` 分派。用 `followup` 投给正在跑的会话会把纠偏内容排到**本回合之后**，
   * 那正是 §6.7 插话要避免的滞后。
   */
  async deliver(dshSessionId: string, message: string): Promise<void> {
    this.#deliver(this.#requireLive(dshSessionId), message);
  }

  /**
   * 请求当前会话生成一次交接草稿（§7.2、§16.1：**受控续跑**，不创建会话、不授予任何权限）。
   *
   * 流程：记下当前 seq → 投递草稿指令（`followup`，新开一个回合）→ 等静默 → 只在该回合新增的
   * 事件里读回 assistant 文本 → 抽出定界标记之间的 JSON → 逐字段校验成 `HandoffDraftResult`。
   * 任一环节不成立都抛 `SessionFactoryError`，**不返回半成品**：草稿是候选内容，
   * 但形状必须可信，否则人类会拿一个残件去确认切换。
   */
  /**
   * 中止当前回合但保留会话（§6.7 叫停跑偏的动作）。
   *
   * 用 `AgentCancelCause` 的 `hook` 变体而非 `user`：`reason` 会随 `turn/end` 的
   * `aborted.reason` 落进会话日志（审计要能回答「谁因为什么中断了这一回合」），
   * 而 `{ kind:'user' }` 没有携带理由的字段。`keepInbox: true` 与 dsh 自己的用户取消路径
   * 一致（`dsh-api-session-controller` 的 cancel）：不静默丢弃已排队的输入。
   */
  async interrupt(dshSessionId: string, reason: string): Promise<void> {
    const record = this.#requireLive(dshSessionId);
    try {
      record.handle.agent.cancel({ kind: 'hook', reason: `pentest interrupt: ${reason}` }, { keepInbox: true });
    } catch (error) {
      throw new SessionFactoryError(`中止会话失败：${describeError(error)}`, {
        dshSessionId,
        cause: error,
      });
    }
  }

  /**
   * 关闭会话：注销 Agent、移除会话、解开作用域（`AgentHandle.dispose()`）。
   *
   * 顺序有意如此——**先标记关闭再 dispose**，因为「关闭后任何 deliver 都必须失败」是不变式，
   * 不能取决于 dispose 是否成功。dispose 失败会抛可重试错误（会话可能仍留在宿主注册表里），
   * 但它已经被标记为关闭，不会再接受任何投递。
   *
   * 对同一标识重复调用是幂等的：后置条件（会话已关闭）已经成立，不属于失败。
   */
  async close(dshSessionId: string, reason: string): Promise<void> {
    if (this.#closed.has(dshSessionId)) return;
    const record = this.#live.get(dshSessionId);
    if (record === undefined) {
      throw new SessionFactoryError(`关闭失败：本进程没有这个会话：${dshSessionId}`, { dshSessionId });
    }
    this.#closed.add(dshSessionId);
    this.#live.delete(dshSessionId);
    try {
      await record.handle.dispose();
    } catch (error) {
      throw new SessionFactoryError(
        `关闭会话失败（${reason}；会话已标记关闭，投递仍会失败）：${describeError(error)}`,
        { dshSessionId, retryable: true, cause: error },
      );
    }
  }

  // ───────────────────────── 内部 ─────────────────────────

  /** 取宿主 agents 服务；缺它就 fail loud——没有会话 API 就没有本适配器。 */
  #agentsOrFail(): AgentRegistryView {
    const agents = this.#ctx.get('agents') as AgentRegistryView | undefined;
    if (agents === undefined || typeof agents.create !== 'function' || typeof agents.get !== 'function') {
      throw new SessionFactoryError(
        '宿主 ctx 没有可用的 agents 服务（dsh 会话注册表）：' +
          '本适配器拒绝在没有会话 API 的环境里静默降级',
      );
    }
    return agents;
  }

  /**
   * 取一个**活着**的会话记录：已关闭、不存在、或已不在宿主注册表（被别处关闭/取代）都抛错。
   *
   * 「在注册表里」这一条是必须的：直接对已被宿主 dispose 的 Agent 调用 `followup` 会把消息
   * 静默留在无人驱动的队列里（dsh 文档：`disposed` 取消之后的消息会被搁置），
   * 那正是端口禁止的「静默成功」。
   */
  #requireLive(dshSessionId: string): LiveSession {
    if (this.#closed.has(dshSessionId)) {
      throw new SessionFactoryError(`会话已关闭，不再接受投递：${dshSessionId}`, { dshSessionId });
    }
    const record = this.#live.get(dshSessionId);
    if (record === undefined) {
      throw new SessionFactoryError(`会话不存在（本进程未创建过它）：${dshSessionId}`, { dshSessionId });
    }
    const agents = this.#agentsOrFail();
    if (agents.get(dshSessionId) !== record.handle.agent) {
      throw new SessionFactoryError(`会话已不在 dsh 注册表中（已关闭或被取代）：${dshSessionId}`, {
        dshSessionId,
      });
    }
    return record;
  }

  #deliver(record: LiveSession, text: string): void {
    const agent = record.handle.agent;
    const message = createUserMessage(text);
    try {
      if (agent.status === 'running') agent.steer(message);
      else agent.followup(message);
    } catch (error) {
      throw new SessionFactoryError(`投递失败：${describeError(error)}`, {
        dshSessionId: agent.session.id,
        cause: error,
      });
    }
  }

}

// ───────────────────────────── 能力冻结 ─────────────────────────────

/**
 * 在 `setup(agentCtx)` 里冻结能力：收窄工具面 + 注册提示词分节。
 *
 * 抛错即让 dsh 回滚整个未公告的创建（不发 `session/created` / `agent/created`），
 * 所以这里是「要么冻结成功，要么根本没有这个会话」。任何 seam 缺失都抛
 * `SessionFactoryError`——降级成一个没有能力限制的会话比创建失败危险得多。
 */
function installFrozenCapabilities(
  agentCtx: AgentScopedContextView,
  input: FrozenSessionInput,
  mounts: readonly SandboxMount[],
): void {
  const tools = agentCtx.tools;
  if (tools === undefined || typeof tools.restrict !== 'function') {
    throw new SessionFactoryError(
      '本 dsh 版本不支持 setup(agentCtx).tools.restrict(...)：无法冻结工具面，拒绝创建一个没有能力限制的会话',
      { dshSessionId: input.dshSessionId },
    );
  }

  // 只能收窄：allow 取人类勾选的那一份，逐字传下去。不合并 Profile 上界、不接受 deny。
  // 宿主对未知工具名会抛错，那条错误会带着整次创建一起回滚——这是想要的 fail loud。
  tools.restrict({ allow: [...input.toolAllow] });

  const prompt = agentCtx.systemPrompt;
  if (prompt === undefined || typeof prompt.section !== 'function') {
    throw new SessionFactoryError(
      '本 dsh 版本不支持 setup(agentCtx).systemPrompt.section(...)：无法把冻结能力与任务简报写进提示词，' +
        '拒绝创建一个模型看不见边界的会话',
      { dshSessionId: input.dshSessionId },
    );
  }

  // 公共记忆：人类为本作业写的规矩。每次创建会话都注入，包括重做与阶段切换——
  // 它是作业级的事实，不是某一轮的过渡材料。
  if (input.publicMemory.trim().length > 0) {
    prompt.section({
      name: SECTION_PUBLIC_MEMORY,
      order: SECTION_ORDER_PUBLIC_MEMORY,
      text:
        '【本作业的公共规则与共识】（由人类在控制台维护，适用于本作业下的所有 Agent；§8.1）\n' +
        input.publicMemory,
    });
  }

  // 能力快照：本会话最基础的边界说明——模型必须看得见自己冻结了什么（可用工具、已装载
  // skill、需逐次放行的类别、可用的动作模板），才能在不越界的前提下规划。它无条件注册：
  // 与公共记忆是否为空、是否带交接上下文都无关，是每个会话都该有的那一条。
  // 排在公共记忆之后、任务简报之前（§2.4、§4.3）：先读作业的长期规矩，再读本次会话的边界，
  // 最后才是这一轮的任务本身。工具面已经由上面的 restrict 收窄，这里补的是「模型知道边界」。
  prompt.section({
    name: SECTION_CAPABILITY,
    order: SECTION_ORDER_CAPABILITY,
    text: renderCapabilitySection(input, mounts),
  });

  // 行为预设：注入的是**指引**而不是硬边界（2026-10-04 决定）。预设决定「要多安静 / 覆盖到什么
  // 程度」，边界由人类放行把守；超出预设的动作由 Agent 主动申请放行，而不是被预设直接拒掉。
  if (input.behavior !== undefined) {
    prompt.section({
      name: SECTION_BEHAVIOR,
      order: SECTION_ORDER_BEHAVIOR,
      text: renderBehaviorSection(input.behavior),
    });
  }

  const modeText = input.sessionKind === 'intake'
    ? '【当前是范围 intake 会话】只向人类询问目标、排除项、协议、端口、允许动作、时间窗。' +
      '在 scope proposal 被人类明确确认前，不得调用或尝试任何触及目标的能力；不得把口头授权当作已确认范围。' +
      '你只能提交 pentest_request_scope_confirmation，提交内容仍是候选方案，不能代替人类确认。'
    : '【当前是五阶段技术会话】只能在已确认范围和人类批准的能力快照内工作；阶段推进与交接必须由人类确认。';
  prompt.section({
    name: SECTION_TASK,
    order: SECTION_ORDER_TASK,
    text: `${modeText}\n\n【人类确认的任务提示词】（§7.4）\n${input.taskPrompt}`,
  });
  if (input.handoffContext !== null) {
    prompt.section({
      name: SECTION_HANDOFF_CONTEXT,
      order: SECTION_ORDER_HANDOFF_CONTEXT,
      text: `【人类确认的交接上下文】（§7.4；已按上下文预算截断）\n${input.handoffContext}`,
    });
  }
}
/**
 * 把检索通道渲染成人话，并给**没有语义通道**时配一句可执行的替代打法。
 *
 * 只说"通道是 X"不够：模型需要知道「那我该怎么提问」。没有向量时，同义改写式的问法是
 * 最差的一种（召回全靠字面重合），所以直接告诉它改用字面线索。
 */
function renderRetrievalChannels(channels: readonly string[] | undefined): string {
  const list = channels ?? ['lexical', 'trigram'];
  const names: Record<string, string> = {
    semantic: '语义近邻',
    lexical: '全文',
    trigram: '三元组',
  };
  const rendered = list.map((c) => names[c] ?? c).join('、');
  if (list.includes('semantic')) return `${rendered}（混合检索）`;
  return (
    `${rendered}（**本部署未启用语义通道**：检索靠字面重合，` +
    '提问请用实体名、路径、端口、版本号、错误原文、时间窗这类线索，' +
    '不要指望同义改写能召回——查不到时先换线索，不要据此断定「记忆里没有」）'
  );
}

/** 冻结能力分节：把「什么被冻结了」讲到模型不需要猜。 */
function renderCapabilitySection(input: FrozenSessionInput, mounts: readonly SandboxMount[]): string {
  const skills =
    input.skillIds.length === 0
      ? '（本次未装载任何 skill——这是合法状态，但不等于可以使用未勾选的 skill）'
      : (input.skillBriefs ?? input.skillIds.map((id) => ({ id, description: '' })))
          .map((brief) => (brief.description === '' ? brief.id : `${brief.id}（${brief.description}）`))
          .join('；');
  // 以**冻结策略**为准：执行器只认它。调用方传来的那份可能语义不同（intake 传的是允许类别），
  // 拿它写提示词会让模型以为自己在等审批、实际能直接跑（实测踩过）。
  const enforced = input.enforcedApprovalClasses ?? input.approvalRequired;
  // 用**显示名 + 释义**而不是裸标识符：模型按字面理解标识符（把 exploit_validation 当成
  // "只做漏洞验证"）会漏掉"这一档是任意自由命令"，而人类在审批卡上看的是同一份名字。
  const approval =
    enforced.length === 0
      ? describeActionClasses(enforced)
      : `${describeActionClasses(enforced)}——这些动作每执行一次都要先申请放行，不得先做后报`;
  const templates = input.sessionKind === 'intake'
    ? ['（intake 阶段不提供任何目标动作模板；scope proposal 仍需人类确认）']
    : input.actionTemplates.length === 0
      ? ['（本部署没有注册任何动作模板——需要人类先注册受信模板，你无法自行执行任何动作）']
      : input.actionTemplates.map((t) => {
          const params = t.parameters
            .map((p) => {
              const range =
                p.values !== undefined
                  ? `取值：${p.values.map((v) => JSON.stringify(v)).join(' | ')}`
                  : p.min !== undefined || p.max !== undefined
                    ? `取值：整数 ${p.min ?? '-'}–${p.max ?? '-'}`
                    : '';
              const carries = [p.carries === '' ? '' : p.carries, range].filter((s) => s !== '').join('；');
              return carries === '' ? p.name : `${p.name}（${carries}）`;
            })
            .join('；');
          return `  - ${t.id}［${actionClassLabelSafe(t.actionClass)} / ${t.actionClass}］${params === '' ? '（无参数）' : `参数：${params}`}`;
        });
  return [
    '【本会话的冻结能力快照】（创建时冻结，运行中不会放宽；§2.4、§4.3）',
    `用途：${input.sessionKind}`,
    `阶段：${input.phase}`,
    `Profile：${input.profileId}@${input.profileRevision}`,
    `记忆检索通道：${renderRetrievalChannels(input.retrievalChannels)}`,
    `已装载 skill（用 \`skill_load\` 取正文；没装载的取不到）：${skills}`,
    `可用工具（工具面之外的工具对本会话根本不可见）：${input.toolAllow.length === 0 ? '（无）' : input.toolAllow.join('、')}`,
    `需要逐次人工放行的动作类别：${approval}`,
    '',
    renderSandboxBrief(input.sessionKind, mounts, input.toolAllow),
    '',
    input.sessionKind === 'intake'
      ? ''
      : (input.toolAllow.includes('pentest_recon') || input.toolAllow.includes('pentest_scan')
          ? '**跑命令的主通道**：第 1 条是结构化动作（`pentest_recon` / `pentest_scan`，不消耗审批），第 2 条是 `pentest_exec`（**已免批**：服务端按类别放行并记审计）。'
          : '**跑命令的主通道**：本会话**没有结构化动作入口**（能力面创建时冻结）——目标动作一律走 `pentest_exec`（**已免批**：服务端按类别放行并记审计）。') +
        '服务端会把 `pentest_exec` 的命令原文绑到唯一那张直连命令模板上（命令转 `*_b64`），你**不需要**、也**不能**自己指定模板。',
    input.sessionKind === 'intake'
      ? ''
      : `本部署注册的动作模板（共 ${String(input.actionTemplates.length)} 张；决定放行的动作类别与参数形状，无需你在调用里给出）：`,
    ...templates,
    '',
    '能力边界由人类在创建会话时确认：只能收窄，不会因为后台配置变动而放宽。需要更大的能力、或者要做',
    '超出当前行为预设的动作时：先用 `pentest_request_action_approval` 请人类放行，不要绕过、也不要先做后报。',
  ].join('\n');
}


// ───────────────────────────── 交接草稿 ─────────────────────────────


// ───────────────────────────── 草稿形状校验 ─────────────────────────────


// ───────────────────────────── 消息 ─────────────────────────────

/**
 * 本地镜像 dsh 的 `createUserMessage`（原因见文件头）：
 * `deepFreeze(structuredClone({ id: randomUUID(), role:'user', content, source }))`。
 *
 * `source` 固定为 `{ kind:'plugin', plugin:'dsh-pentest' }`——**这条消息的生产者是本插件**，
 * 不是终端用户直接输入（那才是 `kind:'user'`，控制台 RPC 用的就是它）。插件来源也让会话日志里
 * 一眼能区分「人类经插件投递」与「人类在终端里敲的」。
 */
function createUserMessage(text: string): UserMessageView {
  return deepFreeze(
    structuredClone({
      id: randomUUID(),
      role: 'user' as const,
      content: [{ type: 'text' as const, text }],
      source: { kind: 'plugin' as const, plugin: PLUGIN_NAME },
    }),
  );
}
