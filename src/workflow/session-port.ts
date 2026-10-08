/**
 * 会话工厂端口：工作流服务创建/驱动顶层 DSH 会话的唯一入口。
 *
 * 设计依据：docs/dsh-pentest-plugin-design.md §4.3、§5.3、§10.6
 *
 * ── 为什么要抽成端口 ──
 *
 * 工作流服务的职责是「状态机与审计」，创建会话是 dsh 运行时的事。
 * 把两者分开有三个直接好处：
 *   1. 工作流服务可以在没有 dsh 运行时的环境里被完整测试（注入假工厂即可）；
 *   2. dsh 会话 API 变化时只改适配器（`src/agents/dsh-session-factory.ts`）；
 *   3. 强制点清晰——「创建新会话」只发生在这里，而它只被人类操作调用。
 *
 * ── 实测确认的 dsh 会话 API（0.1.5-rc.2）──
 *
 * ```ts
 * const { agent } = await ctx.agents.create({
 *   sessionId: brandString<SessionId>(`session-${randomUUID()}`),
 *   meta: { cwd, agentPreset },
 *   agentOptions: { provider, model },
 *   setup: (agentCtx) => { /* 能力冻结在这里 *\/ },
 * });
 * agent.followup(createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }));
 * await agent.whenIdle();
 * ```
 *
 * 关键点：
 *   - `sessionId` 必须是 branded 类型（`@deepseek-ai/dsh-brand` 的 `brandString`）；
 *   - `parentAgent` **省略**即为顶层 Agent——这正是本设计要的「所有 Worker 都是主 Agent」；
 *   - `setup(agentCtx)` 在会话与 Agent 被**插入与公告之前**执行，观察者看不到半配置状态，
 *     因此工具允许列表与 skill 的冻结必须在这里完成，不能事后再改；
 *   - 任务经 `agent.followup()` 投递，等待用 `agent.whenIdle()`。
 */

import type { ActionClass, BehaviorProfile, BudgetLimits, Phase, ScopeTarget } from '../contracts.ts';

/** 冻结到会话的能力快照；来源是 `workflow/model.ts` 的 `ResolvedCapabilities`，经人类确认收窄后固化。 */
export interface FrozenSessionInput {
  /** 工作流服务分配的会话标识（也是我们数据库里的 worker_sessions.id）。 */
  readonly workerSessionId: string;
  /** dsh 侧会话标识，由工作流确定性派生并原样使用。 */
  readonly dshSessionId: string;
  /** 工厂必须原样使用该 dsh 标识，不得替换。 */
  readonly engagementId: string;
  /** intake 与五阶段 phase Agent 的能力边界和提示词必须显式区分。 */
  readonly sessionKind: 'intake' | 'phase';
  /**
   * **冻结范围的只读视图**（当前版本的条目）。缺省即"读不到"，简报会如实写。
   *
   * 有了它，模型不必靠试错知道"哪个段被放行、CIDR 能不能当目标"——那正是 2026-10-08
   * 操作者实测里最贵的两次弯路（一次 `/16` 被拆成 283 台逐 IP）。
   */
  readonly scope?: {
    readonly targets: readonly ScopeTarget[];
    readonly exclusions: readonly ScopeTarget[];
  };
  readonly phase: Phase;
  readonly profileId: string;
  readonly profileRevision: string;
  /** 人类勾选的 skill 集合；允许为空（§2.2）。 */
  readonly skillIds: readonly string[];
  /**
   * 上述 skill 的目录（名字 + 一句话描述），写进提示词用。
   *
   * 只写名字的话模型不知道「什么时候该加载哪一份」——`skill_load` 就成了摆设。
   * 正文**不进提示词**（太长）：模型按目录判断需要哪份，再用 `skill_load` 取正文。
   */
  readonly skillBriefs?: readonly { readonly id: string; readonly description: string }[];
  /** 人类确认的工具允许列表；只能比 Profile 更窄（§2.4）。 */
  readonly toolAllow: readonly string[];
  /** 需要逐次放行的动作类别（写进提示词，让 Worker 知道什么要先申请）。 */
  readonly approvalRequired: readonly ActionClass[];
  /**
   * 本作业**实际强制逐次放行**的动作类别（来自冻结策略，与执行器同一来源）。
   *
   * 与 {@link approvalRequired} 的区别：后者是调用点传进来的「候选/上下文」列表，
   * 语义在不同调用点并不一致；提示词要说的是**服务端真的会拦下来的那一组**，否则会误导模型。
   * 省略时退回 `approvalRequired`（找不到策略快照的早期会话）。
   */
  readonly enforcedApprovalClasses?: readonly ActionClass[];

  /**
   * 本部署**实际可用**的记忆检索通道（如 `['lexical', 'trigram']`）。
   *
   * 为什么必须写进提示词：没有嵌入端点时语义通道是空的（索引侧记 `lexical-only`），
   * 而 Agent 若不被告知，会按"语义检索"的心智模型提问——用一句改写过的问题去查，
   * 召回必然差，它却会得出"记忆里没有"的结论。告诉它通道，它才会改用字面线索检索。
   */
  readonly retrievalChannels?: readonly string[];

  /**
   * 行为预设提示词包的事实（2026-10-04：预设改成**提示词**，不再是硬纪律）。
   *
   * 省略即不注入该分节——intake 会话不需要它；作业还没有确认过策略时也取不到。
   */
  readonly behavior?: {
    readonly profile: BehaviorProfile;
    /** 宿主侧实际生效的节奏上限（rate/concurrency/jitter/burst/retry）。 */
    readonly pacing?: Readonly<Record<string, number>>;
  };
  readonly modelRoute: ModelRoute;
  /** 人类确认的任务提示词。 */
  readonly taskPrompt: string;
  /** 人类确认的交接上下文内容（已按预算截断）。 */
  readonly handoffContext: string | null;
  /**
   * engagement 的公共记忆（人类写的作业规则与共识）；空串即没有。
   *
   * 与 `handoffContext` 的区别：交接上下文是**上一轮到这一轮**的过渡材料，
   * 只在新阶段的首个会话里有；公共记忆是**整个作业**的长期规矩，**每一次**创建会话
   * 都要注入——包括重做与阶段切换。它不随会话变化，所以不参与上下文预算截断。
   */
  readonly publicMemory: string;
  /** 工作目录。省略则由适配器决定（通常是 engagement 的授权目录）。 */
  readonly cwd?: string;
  /** 创建时冻结的预算上限；用于真实 Worker 生命周期注册。 */
  readonly budget?: BudgetLimits;
  /** 受信动作模板目录；写进提示词，否则模型无法知道 `template_id` 的合法取值。 */
  readonly actionTemplates: readonly ActionTemplateBrief[];
}

/**
 * 提示词里的动作模板目录项。
 *
 * 为什么必须有：模板集合是**封闭**的（§10.2「可执行的动作集合本身是封闭的」），
 * 服务端只用它把命令实例化成一次受审的动作。若提示词不说明「只有这一张、形状如此」，
 * 模型会去猜别名——实测它连续猜了 9 个名字（`http_get`/`http.request`/`web.fetch`/`fetch`/
 * `http_head`/`http_passive_collection`/`web_http_read`/`passive_http_read`/`http.read`）
 * 全部被拒，最后以「无法枚举可用模板」收场。一个注定失败的任务不是安全，
 * 只是把成本转嫁给了模型和人类。（2026-10-05 起 `pentest_exec` 只收命令原文与端口，
 * 模板由服务端绑定——这份清单现在的作用是**说清参数形状与类别**，而不是让模型点菜。）
 */
export interface ActionTemplateBrief {
  readonly id: string;
  /** 动作类别（`passive_collection` / `active_probing` / …）。 */
  readonly actionClass: string;
  /**
   * 参数名、取值范围与「可携带什么」；模板声明的参数**即必填**。
   *
   * `values` 必须给出来：枚举参数的取值是**字面量字符串**（`"true"` / `"false"`），
   * 而非布尔或数字。把取值藏起来时模型会按直觉传 JSON 布尔值，被参数白名单拒后再自己
   * 纠正——实测白烧了一轮。约束本来就该在提示词里说清，而不是让模型试错。
   */
  readonly parameters: readonly {
    readonly name: string;
    readonly carries: string;
    readonly values?: readonly string[];
    readonly min?: number;
    readonly max?: number;
  }[];
}

export interface ModelRoute {
  readonly provider: string;
  readonly model: string;
  readonly reasoningEffort?: 'low' | 'high' | 'max';
}

/** 创建结果：dsh 侧的会话标识。 */
export interface CreatedSession {
  readonly dshSessionId: string;
}



/**
 * 会话工厂。
 *
 * 所有方法都可能失败（dsh 不可用、会话已关闭、超时）；失败必须**抛错**，
 * 由工作流服务转成确定的拒绝，不得返回半成品——静默成功会让状态机以为
 * 会话已创建而实际没有。
 */
export interface SessionFactory {
  /**
   * 创建一个新的**顶层** Worker 会话，并冻结能力快照。
   *
   * 不得追加到任何父会话；`previous_agent_session_id` 等历史关系由工作流服务
   * 写数据库表达，不通过 dsh 的父子 Agent 机制承载（§5.3）。
   */
  create(input: FrozenSessionInput): Promise<CreatedSession>;

  /**
   * 向会话投递一条人类消息（任务、插话、放行结果）。
   *
   * 运行中的会话按 steer 语义在下个步骤边界接收；等待中的会话被唤醒后接收。
   * 会话已关闭或被取代时抛错——调用方据此判定凭证失效。
   */
  deliver(dshSessionId: string, message: string): Promise<void>;


  /** 中止当前回合但保留会话（用于叫停跑偏的动作）。 */
  interrupt(dshSessionId: string, reason: string): Promise<void>;

  /** 关闭会话。之后任何 deliver 都必须失败。 */
  close(dshSessionId: string, reason: string): Promise<void>;
}

/**
 * 会话工厂失败的统一错误。
 *
 * 带 `dshSessionId`（若已知）便于审计定位；`retryable` 只描述**传输层**是否可重试，
 * 不表示业务可用——状态机据此决定是否允许人类重试同一操作。
 */
export class SessionFactoryError extends Error {
  override readonly name = 'SessionFactoryError';
  readonly dshSessionId: string | null;
  readonly retryable: boolean;

  constructor(message: string, options: { dshSessionId?: string | null; retryable?: boolean; cause?: unknown } = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.dshSessionId = options.dshSessionId ?? null;
    this.retryable = options.retryable ?? false;
  }
}
