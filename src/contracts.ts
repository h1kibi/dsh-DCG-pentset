/**
 * 共享契约：所有模块共同依赖的类型与常量。
 *
 * 依据：docs/dsh-pentest-plugin-design.md（设计基线 v0.3+）
 * 已对 dsh 0.1.5-rc.2 实测确认的前提：
 *   - KNOWN_SESSION_EVENT_TYPES 是固定集合，外部插件事件在其外；
 *     读路径拒绝未带 `ignorable` 标记的未知类型 → 本插件不写自定义会话事件
 *   - tools/pre-execute 返回 PreToolDecision（allow/deny/ask），不接受入参改写
 *   - tools.guard 返回 string | undefined，无 allow 结果
 *   - ctx.agents.create({ parentAgent 省略 }) 创建顶层 Agent
 *   - conversation.view / settings.plugins.tab / settings.plugin.item 槽位存在
 */

// ───────────────────────────── 阶段（五阶段 1:1） ─────────────────────────────

export const PHASES = [
  'intelligence-gathering',
  'threat-modeling',
  'vulnerability-analysis',
  'exploitation',
  'post-exploitation',
] as const;
export type Phase = (typeof PHASES)[number];

export function isPhase(v: unknown): v is Phase {
  return typeof v === 'string' && (PHASES as readonly string[]).includes(v);
}

/** PTES 的 Pre-engagement 与 Reporting 由控制台承担，不是 Worker 阶段。 */
export const CONSOLE_ONLY_PHASES = ['pre-engagement', 'reporting'] as const;

// ───────────────────────────── 状态模型（两层） ─────────────────────────────

/** 主状态：状态机当前位置，唯一权威。对应 engagements.current_status。 */
export const MAIN_STATUSES = [
  'auth_pending',
  'ready',
  'worker_running',
  'waiting_human_review',
  'handoff_drafting',
  'transition_confirmation',
  'report_ready',
  'complete',
] as const;
export type MainStatus = (typeof MAIN_STATUSES)[number];

/** 正交运行标记：与主状态并存，不改写主状态。对应 engagements.status。 */
export const RUN_MARKERS = ['running', 'paused', 'blocked', 'aborted', 'failed'] as const;
export type RunMarker = (typeof RUN_MARKERS)[number];

/**
 * 运行期动作（暂停 / 恢复 / 终止 / 插话）的可用性——**服务端与客户端共用同一份判定**。
 *
 * ── 为什么是单源 ──
 *
 * 这三条规则此前只在客户端实现（`RunControls` 的按钮禁用），服务端不设前置：界面挡住
 * 的操作，经控制台端点直调照样生效。实测过的后果有两条：
 *
 *   1. `abort` 之后还能 `pause`，再 `resume`——而终止已经把所有会话置为 `closed`、
 *      吊销了全部租约，于是作业留下「运行标记 running、主状态 worker_running、
 *      活动会话指向一行已关闭的会话」的僵尸；
 *   2. 签字导出（主状态 `complete`）之后仍能暂停/终止——那只是噪音，且会让
 *      「终态」这个词在账本里失去意义。
 *
 * 因此判定收进契约层：服务端把它当**前置**（拒绝并给出具体标记），客户端把它当
 * **禁用依据**（文案各自渲染，判定不各写一份）。
 *
 * ── 各条规则 ──
 *
 * - `complete`（已签字导出）：一切运行期动作无意义，全 false；
 * - `canPause`：只有 `running` 能暂停（对已暂停的再暂停是空操作，对终止后的暂停是复活入口）；
 * - `canResume`：`paused` 与 `blocked` 都可以恢复。`blocked` 由启动对账（§15.2）与
 *   会话创建失败写入，语义是「等人类处置」——人类处置完必须有一条受支持的出口，
 *   否则堵塞的作业只能靠改库收场；
 * - `canAbort`：终止是人类的兜底手段，除 `aborted` / `failed` 两个终态外都可用
 *   （连 `blocked` 也要能终止，理由同上）；
 * - `canInterject`：只对「正在运行的标记 + 有活动会话」开放。暂停或阻塞时投递无人消费，
 *   等待人工时人类该做的是交接而不是插话（§6.7）。
 */
export interface RunActionAvailability {
  readonly canPause: boolean;
  readonly canResume: boolean;
  readonly canAbort: boolean;
  readonly canInterject: boolean;
  /**
   * 「结束技术测试」（§5.2 那两条指向 `report_ready` 的边）的可用性。
   *
   * 允许的起点是**等待人工判断**（Agent 已交报告）与 **Agent 正在跑**（人类决定就此收工），
   * 且运行标记为 `running`：暂停/阻塞时先恢复或终止，别把「停止工作」混进中间态。
   */
  readonly canFinishTesting: boolean;
  /**
   * 「追加预算」（§10.5）的可用性：运行中或已暂停，且作业**没有签字导出**。
   *
   * 它是契约层判定的一部分而不是服务方法里现拼的条件——现拼过一版
   * （`canPause || runMarker === 'paused'`），漏掉了 `complete`：在 `report_ready` 时暂停、
   * 再签字导出的作业会停在「complete + paused」，于是追加预算把已经结束的作业的
   * 运行标记复活成 `running`（2026-10-05 质检发现）。
   */
  readonly canExtendBudget: boolean;
}

export function runActionAvailability(state: {
  readonly mainStatus: MainStatus;
  readonly runMarker: RunMarker;
  readonly activeWorkerSessionId: string | null;
}): RunActionAvailability {
  if (state.mainStatus === 'complete') {
    return {
      canPause: false,
      canResume: false,
      canAbort: false,
      canInterject: false,
      canFinishTesting: false,
      canExtendBudget: false,
    };
  }
  const terminal = state.runMarker === 'aborted' || state.runMarker === 'failed';
  return {
    canPause: state.runMarker === 'running',
    canResume: state.runMarker === 'paused' || state.runMarker === 'blocked',
    canAbort: !terminal,
    canInterject: state.activeWorkerSessionId !== null && state.runMarker === 'running',
    canFinishTesting:
      state.runMarker === 'running' &&
      (state.mainStatus === 'worker_running' || state.mainStatus === 'waiting_human_review'),
    canExtendBudget: state.runMarker === 'running' || state.runMarker === 'paused',
  };
}

/**
 * **允许触及目标动作的主状态**（§10.2 的执行闸门）。
 *
 * 只有两个：`worker_running`（Agent 正在干活）与 `waiting_human_review`
 * （Agent 交完报告等人类判断——人类**批准某条放行后**唤醒它继续，所以这一态必须能执行）。
 *
 * 其余主状态一律不执行：
 *   - `auth_pending`（未授权）、`handoff_drafting` / `transition_confirmation`（交接中，
 *     §16.1 明确「起草不授予任何工具权限」）、`report_ready`（人类已宣布结束技术测试）、
 *     `complete`（已签字导出）。
 *
 * 为什么它必须和运行标记一起进**执行侧的原子条件**：运行标记只管暂停/阻塞/终止，
 * 看不见「作业已经收工」。少了这一半，`结束技术测试` 之后仍在跑的会话照样能把动作
 * 提交上去（2026-10-05 质检发现的时间窗：结束测试的事务提交后、租约被吊销前，
 * 一条在等的 `commitRun` 会重新求值并通过）。因此它与 `runActionAvailability`
 * 一样是**单源**：执行侧的受理闸门与提交语句都消费这一份。
 */
export const EXECUTION_MAIN_STATUSES = ['worker_running', 'waiting_human_review'] as const;

/** 会话级状态。终态为 closed / superseded / failed（存活索引不覆盖它们）。 */
export const SESSION_STATUSES = [
  'starting',
  'active',
  'waiting_human',
  'handoff_drafting',
  'transition_confirmation',
  'paused',
  'blocked',
  'failed',
  'closed',
  'superseded',
] as const;
export type SessionStatus = (typeof SESSION_STATUSES)[number];

/** Worker 会话用途；intake 只负责授权与范围确认，不是五阶段技术 Agent。 */
export const SESSION_KINDS = ['intake', 'phase'] as const;
export type SessionKind = (typeof SESSION_KINDS)[number];

/** 存活会话：数据库部分唯一索引必须与此集合一致，否则同 engagement 可并存多个存活会话。 */
export const LIVE_SESSION_STATUSES = [
  'starting',
  'active',
  'waiting_human',
  'handoff_drafting',
  'transition_confirmation',
  'paused',
  'blocked',
] as const satisfies readonly SessionStatus[];

/**
 * 终态会话：不再接收输入、租约应已吊销。
 *
 * 与 {@link LIVE_SESSION_STATUSES} 互补——两者的并集是全部 `SessionStatus`（002 的
 * 状态机保证不存在第三种）。判活用「不在终态」而不是「在存活集合」，是为了让
 * 新增存活状态时不会**静默**把一个活着的会话当成死的。
 *
 * 集合本身按 `string` 查找（调用方常从数据库读回 `string`），但成员由
 * `satisfies` 在**定义处**校验，仍与 `SessionStatus` 绑定。
 */
const TERMINAL_SESSION_STATUS_LIST = ['failed', 'closed', 'superseded'] as const satisfies readonly SessionStatus[];
export const TERMINAL_SESSION_STATUSES: ReadonlySet<string> = new Set(TERMINAL_SESSION_STATUS_LIST);

// ───────────────────────────── 转移类型 ─────────────────────────────

/**
 * 转移类型。分派规则见设计文档 §5.4：
 *   - rollback 与 loop 的区别决定是否递增 graph_iteration 与范围版本
 *   - interject_wake / handoff_cancel / handoff_regen / report_reopen 不产生交接记录
 */
export const TRANSITION_TYPES = [
  'start',
  'advance',
  'retry',
  'rollback',
  'loop',
  'interject_wake',
  'handoff_cancel',
  'handoff_regen',
  'report_reopen',
  'pause',
  'resume',
  'abort',
  'complete',
] as const;
export type TransitionType = (typeof TRANSITION_TYPES)[number];

/** 产生交接记录的转移类型，与 handoffs.transition_type 的取值域一致。 */
export const HANDOFF_TRANSITION_TYPES = ['advance', 'retry', 'loop', 'rollback'] as const;
export type HandoffTransitionType = (typeof HANDOFF_TRANSITION_TYPES)[number];

/** 递增迭代与范围版本的转移：只有回环。**规则的单源**——分派表校验器（`transition-table.ts`）消费它，不要另行硬编码。 */
export function advancesIteration(t: TransitionType): boolean {
  return t === 'loop';
}

/**
 * 把 `unknown` 的错误收成一句可读文本。
 *
 * **唯一实现**：此前 `client/log.ts`、`agents/dsh-session-factory.ts`、`workflow/recovery.ts`
 * 各写了一份逐字相同的私有副本（第六轮质检）；放在契约层是因为两侧（host 与 client 包）
 * 都要用，而它只依赖 Error/String，没有平台依赖。
 */
export function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// ───────────────────────────── 风险与动作类别 ─────────────────────────────

/**
 * 动作类别（风险分级）。
 *
 * **命名口径**：一个概念一个名字——标识符是显示名（`policy/action-class-labels.ts`）的
 * snake_case，避免"审批卡上写 A、账本里写 B"。前三个 2026-10-07 由操作者定名，从
 * `passive_read` / `active_discovery` / `authenticated_read` 改为行业标准词
 * （旧名与它们真正干的事对不上：前者会向 crt.sh / whois 发包，后者是"用凭据访问"）。
 *
 * **改名的兼容纪律**（三条，缺一条就会伤到账本）：
 *   1. 历史行**不改**：`tool_runs` / `approvals` 上有 `action_class` 不可变触发器
 *      （迁移 008/011/025），原地重写会被数据库直接拒绝——那正是审计要求的形状；
 *   2. 读侧兼容：旧值经 {@link normalizeActionClass} 一律映射到新值，因此历史行、
 *      旧策略快照、旧范围方案照常渲染与评估；
 *   3. 写侧只写新值，且旧值不得出现在任何下拉框/提示词/新文档里。
 */
export const ACTION_CLASSES = [
  'passive_collection',
  'active_probing',
  'credentialed_access',
  'exploit_validation',
  'lateral_movement',
  'persistence',
  'destructive',
  'exfiltration',
] as const;
export type ActionClass = (typeof ACTION_CLASSES)[number];

/**
 * 旧标识符 → 新标识符（**只增不改**：一份历史映射，只用于读侧归一化）。
 *
 * 不放进 `ACTION_CLASSES`：它不该出现在任何新写入或界面上；但必须被**接受**——
 * 否则读旧账本与旧策略快照会把它们当成未知类别（进而按"无法归类即拒绝"处理，
 * 把历史数据读成错误状态）。
 */
export const LEGACY_ACTION_CLASS_ALIASES = Object.freeze({
  passive_read: 'passive_collection',
  active_discovery: 'active_probing',
  authenticated_read: 'credentialed_access',
} as const);

/** 旧值归一化：新值原样返回，旧值映射到新值，不认识的原样返回（由调用方决定拒绝或显示）。 */
export function normalizeActionClass(value: string): string {
  return (LEGACY_ACTION_CLASS_ALIASES as Readonly<Record<string, string | undefined>>)[value] ?? value;
}

/** 类型守卫：新值与旧值都算"可识别的类别"（读侧宽容、写侧只用新值）。 */
export function isActionClass(value: unknown): value is ActionClass {
  return (
    typeof value === 'string' &&
    ((ACTION_CLASSES as readonly string[]).includes(value) || Object.hasOwn(LEGACY_ACTION_CLASS_ALIASES, value))
  );
}

/** 默认需要逐次人工放行的类别。 */
export const PER_ACTION_APPROVAL_CLASSES = [
  'exploit_validation',
  'lateral_movement',
] as const satisfies readonly ActionClass[];

/**
 * 唯一触及目标的工具名。
 *
 * 放在契约层而不是各模块各写一份：`tools/worker.ts` 用它注册工具、
 * `execution/service.ts` 用它登记 `tool_runs.tool_name`、守卫用它区分
 * 「本插件的工具」与「宿主工具」。三处必须字面一致，否则守卫会把自己的
 * 目标工具当成宿主工具拒掉。
 */
export const EXEC_TOOL_NAME = 'pentest_exec';

/**
 * 官方人机提问工具的名字（`@deepseek-ai/dsh-tool-ask-user` 注册的那个）。
 *
 * **不是本插件的工具**，本插件只做两件事：
 *   1. 在 `presets/pentest/agent.cordis.yml` 里挂官方那一行——官方包的宿主半是**刻意空的**
 *      （注释原话：the model-facing tool is composed per preset, not here），工具只能由预设提供；
 *   2. 在会话的冻结工具允许列表里**放行**它——预设走的是祖先作用域，`tools.restrict({allow})`
 *      照样能把它挡在会话之外。
 *
 * 交互界面由官方 `@deepseek-ai/dsh-client-ui-user-questions` 接管编辑器渲染（带选项、多选、
 * 自定义答案、跳过）。因此这里**不复制**官方 schema：复制出来的副本会随上游漂移，
 * 而漂移的代价是人类看到的选择项与模型发出去的请求对不上。
 */
export const HUMAN_QUESTION_TOOL = 'ask_user_question';

/** 默认禁用的类别（需在 engagement 策略中显式开启）。 */
export const DEFAULT_DISABLED_CLASSES = [
  'persistence',
  'destructive',
  'exfiltration',
] as const satisfies readonly ActionClass[];

/**
 * 沙箱工具镜像的**声明源**：既进会话提示词（每个新会话都注入一套「有什么、怎么用」），
 * 又与 `docker/tools/Dockerfile` 做**源码级一致性核对**（`test/sandbox-environment.test.ts`：
 * 每个工具的 `from` 都必须能在 Dockerfile 的 apt / pip / go 清单里找到）。
 *
 * 为什么必须是同源：提示词里写着一个镜像里没有的工具，模型会反复调用失败并把它归因成
 * 「目标不可达」——这种谎言的代价是整轮侦察跑偏，而它在纯文本层面看不出任何异常。
 *
 * `usage` 是给模型看的一句话（什么时候用、用的时候注意什么），不是给人看的简介。
 */
export interface SandboxTool {
  readonly name: string;
  /** 出处：apt 包名 / pip 模块名 / go 模块路径 / base 镜像自带——测试回到 Dockerfile 核对。 */
  readonly from: string;
}

export interface SandboxToolGroup {
  readonly group: string;
  readonly usage: string;
  readonly tools: readonly SandboxTool[];
}

export const SANDBOX_TOOL_GROUPS: readonly SandboxToolGroup[] = [
  {
    group: '侦察与资产测绘',
    usage:
      '先端口与服务、再指纹与 DNS/子域：结构化通道（pentest_recon）能覆盖的就别手写命令。' +
      'masscan 只在人类明确要求高速扫描时用（很响）；arp-scan/nbtscan 仅对同网段有意义（跨三层没有结果）。' +
      '`fping`/`traceroute`/`mtr` 是"打不通"时的归因工具：fping 批量判存活、traceroute 看隔离在哪一跳、' +
      'mtr 统计丢包（间歇问题比 traceroute 有用）。`dnsenum` 是老牌 DNS 枚举（同一件事优先用结构化 `dns_enum`）。',
    tools: [
      { name: 'nmap', from: 'nmap' },
      { name: 'masscan', from: 'masscan' },
      { name: 'subfinder', from: 'github.com/projectdiscovery/subfinder' },
      { name: 'dnsx', from: 'github.com/projectdiscovery/dnsx' },
      { name: 'httpx', from: 'github.com/projectdiscovery/httpx' },
      { name: 'katana', from: 'github.com/projectdiscovery/katana' },
      { name: 'whatweb', from: 'whatweb' },
      { name: 'dnsenum', from: 'dnsenum' },
      { name: 'dig', from: 'dnsutils' },
      { name: 'ip', from: 'iproute2' },
      { name: 'whois', from: 'whois' },
      { name: 'fping', from: 'fping' },
      { name: 'traceroute', from: 'traceroute' },
      { name: 'mtr', from: 'mtr-tiny' },
      { name: 'arp-scan', from: 'arp-scan' },
      { name: 'nbtscan', from: 'nbtscan' },
    ],
  },
  {
    group: 'Web 内容与核验',
    usage:
      '目录/文件枚举用 ffuf（先量软 404 基线）、dirsearch 或 gobuster；爬取用 katana / gospider（前者 JS 感知，后者快）。' +
      'nuclei 只用镜像自带的只读模板（/opt/pentest-templates），**不要**从网上下载模板——上游模板集含入侵性用例。' +
      'dalfox 是主动型 XSS 扫描、sqlmap/commix 属利用类动作，三者都要人类逐条放行；arjun 发现隐藏参数（只发探测请求）；' +
      'wafw00f 在发起大规模扫描前先判防护类型（一次请求，成本极低）。',
    tools: [
      { name: 'ffuf', from: 'ffuf' },
      { name: 'gobuster', from: 'gobuster' },
      { name: 'dirb', from: 'dirb' },
      { name: 'wfuzz', from: 'wfuzz' },
      { name: 'dirsearch', from: 'dirsearch' },
      { name: 'arjun', from: 'arjun' },
      { name: 'dalfox', from: 'github.com/hahwul/dalfox/v2' },
      { name: 'gospider', from: 'github.com/jaeles-project/gospider' },
      { name: 'wafw00f', from: 'wafw00f' },
      { name: 'nuclei', from: 'github.com/projectdiscovery/nuclei' },
      { name: 'sqlmap', from: 'sqlmap' },
      { name: 'commix', from: 'commix' },
    ],
  },
  {
    group: '凭据与杂凑',
    usage:
      '**默认禁止爆破/喷洒**（见 skills/exploit-auth-testing：单账号 ≤5 次、间隔 ≥1s，且必须人类逐条放行）。' +
      'hydra 只在人类明确放行的单账号验证里用；john 只做**小规模**离线校验（拿到杂凑后在本机算，不打目标）；' +
      'hashid 只做形态识别。**重活交人类**：GPU 破解（hashcat 那类）与 10^6 量级字典不在沙箱里硬跑——' +
      '2 核/2g/无 GPU 的容器跑这些只会占满预算并产出不可复核的降级结论（hashcat 本镜像有意不装）。',
    tools: [
      { name: 'hydra', from: 'hydra' },
      { name: 'john', from: 'john' },
      { name: 'hashid', from: 'hashid' },
    ],
  },
  {
    group: 'AD / Windows 服务',
    usage:
      '**从只读枚举起步**：enum4linux-ng（SMB/RPC 结构化输出）、smbclient -L / smbmap -H / rpcclient、' +
      'ldapsearch、ldapdomaindump（域对象转储）、adidnsdump（AD DNS 记录）、bloodhound-python（收集后做最短路分析）。' +
      '**攻击链动作全部逐条人批**：kerbrute（用户名枚举与密码喷洒——喷洒属爆破类，单账号 ≤5 次/间隔 ≥1s）、' +
      'certipy（ADCS 模板枚举与 ESC1-8）、evil-winrm（含 pass-the-hash）、impacket 的写操作。' +
      '任何写 share、改配置、投递文件都属带破坏性的类别。\n' +
      '**NetExec（`nxc`）本镜像没有**：它的依赖表里有四个 git URL，装它必须 github.com 可达，而本环境该域时通时不通（' +
      '2026-10-06 实测，理由与手工装法写在 `docker/tools/Dockerfile` 的"有意不装"清单里）。' +
      '它的一体化用法请用等价组合替代：枚举用 enum4linux-ng + smbmap + ldapdomaindump，' +
      '横向用 evil-winrm（WinRM）或 impacket 的 psexec/wmiexec/smbexec。\n' +
      'impacket 在本镜像里**有两套名字**（2026-10-06 实测）：`impacket-<脚本>`（如 impacket-smbclient，来自 apt 的' +
      'python3-impacket，随 smbmap 进来，在 /usr/bin）与 73 个上游原名 `*.py`（如 GetNPUsers.py / secretsdump.py，' +
      '来自 pip 的 impacket，在 /usr/local/bin）。两套都能用，找不到 `impacket-x` 时试 `x.py`。\n' +
      '**不在这里的**（它们是投放到 Windows 目标上运行的工件，不是 Linux 沙箱里的 CLI）：Rubeus / Seatbelt / ' +
      'PowerUp / WinPEAS —— 需要在目标侧执行时，由人类决定投递方式并逐条放行。' +
      '`nmblookup` / `nbtscan` 用于 NetBIOS 名字（老资产、非 AD 的 Windows 机器也吃这套）；' +
      '`snmpwalk` 只在目标开 161 且人类给了 community 时用（v2c 是明文，且它属主动探测，别乱扫）。',
    tools: [
      { name: 'smbclient', from: 'smbclient' },
      { name: 'smbmap', from: 'smbmap' },
      { name: 'rpcclient', from: 'samba-common-bin' },
      { name: 'nmblookup', from: 'samba-common-bin' },
      { name: 'enum4linux-ng', from: 'cddmp/enum4linux-ng' },
      { name: 'ldapsearch', from: 'ldap-utils' },
      { name: 'ldapdomaindump', from: 'ldapdomaindump' },
      { name: 'adidnsdump', from: 'adidnsdump' },
      { name: 'bloodhound-python', from: 'bloodhound' },
      { name: 'certipy', from: 'certipy-ad' },
      { name: 'kerbrute', from: 'github.com/ropnop/kerbrute' },
      { name: 'evil-winrm', from: 'evil-winrm' },
      { name: 'snmpwalk', from: 'snmp' },
      { name: 'impacket-*', from: 'impacket' },
    ],
  },
  {
    group: '字典与流量取证',
    usage:
      '字典生成（crunch 模式化、cewl 从目标站点爬关键词）：产出的字典落到 /tmp，**不要**在沙箱里跑大规模破解' +
      '（见提示词里「交人类」那条：hashcat 那类 GPU 活、10^6 量级字典都不在沙箱硬跑）。' +
      'tshark 用于读/分析已有 pcap；沙箱内没有入站端口，抓不到"别人发给你的流量"。',
    tools: [
      { name: 'crunch', from: 'crunch' },
      { name: 'cewl', from: 'cewl' },
      { name: 'tshark', from: 'tshark' },
    ],
  },
  {
    group: 'TLS / 加密',
    usage: '证书与协议面从「已裁决地址」拨号（--connect <地址>:<端口>），域名只作 SNI/Host。',
    tools: [
      { name: 'openssl', from: 'openssl' },
      { name: 'sslscan', from: 'sslscan' },
      { name: 'testssl', from: 'testssl.sh' },
      { name: 'sslyze', from: 'sslyze' },
    ],
  },
  {
    group: '隧道与转发',
    usage:
      '建立可达性通道属于 `lateral_movement` 类别——**永远逐条人工放行**，且目标网段必须已在范围快照里。' +
      'chisel 走 HTTP(S) 单端口最简单（**服务端必须带 `--socks5`**，否则客户端的 SOCKS 请求全被 reset）；' +
      'ligolo-proxy 需要 TUN 与 NET_ADMIN，**本沙箱两者都没有**（实测无 `/dev/net/tun`）⇒ 用 chisel/socat；' +
      '**ligolo-agent 是投放到目标上运行的二进制**——投递文件本身也要人类放行。' +
      '`scp`/`sshpass` 用于**从目标取回文件**（带口令的非交互拷贝）：这属采集/外传类，逐条批且要写明取什么、为什么；' +
      '用完必须关闭隧道并在后渗透阶段核查清理（见 post-lateral-pivot / post-cleanup-verify）。',
    tools: [
      { name: 'chisel', from: 'github.com/jpillora/chisel' },
      { name: 'ligolo-proxy', from: 'github.com/nicocha30/ligolo-ng/cmd/proxy' },
      { name: 'ligolo-agent', from: 'github.com/nicocha30/ligolo-ng/cmd/agent' },
      { name: 'socat', from: 'socat' },
      { name: 'proxychains4', from: 'proxychains4' },
      { name: 'ssh', from: 'openssh-client' },
      { name: 'scp', from: 'openssh-client' },
      { name: 'sshpass', from: 'sshpass' },
      { name: 'nc', from: 'netcat-openbsd' },
    ],
  },
  {
    group: '脚本与数据处理',
    usage:
      '长输出**先落 /tmp 再用 jq/grep 处理**——但注意**容器是一次性的**：`/tmp` 产物只在那一条命令内存在，' +
      '「写」与「读」必须写在同一条命令里（`cmd > /tmp/x && jq … /tmp/x`）。容器输出有上限（超限截断，宿主侧还有一层缓冲上限）。' +
      'python3 预装了 requests / dnspython / beautifulsoup4 / lxml / paramiko / pyjwt / pycryptodome / scapy / pwntools / impacket。' +
      '`wget` 是 curl 的备选（递归抓取用 `-r`，注意那是在打目标）；`rsync` 用于**与人类确认过的**本地/记忆导出间同步；' +
      '`xxd` 看二进制证据的十六进制（配合 `file` 判类型，证据里写哈希而不是贴字节）。',
    tools: [
      { name: 'python3', from: 'python:3.11-slim-bookworm' },
      { name: 'curl', from: 'curl' },
      { name: 'wget', from: 'wget' },
      { name: 'jq', from: 'jq' },
      { name: 'git', from: 'git' },
      { name: 'rsync', from: 'rsync' },
      { name: 'xxd', from: 'xxd' },
      { name: 'file', from: 'file' },
    ],
  },
] as const;

/** 扁平清单（兼容旧用法：能力快照里的「工具名列表」由它生成，不再手写第二份）。 */
export const SANDBOX_TOOLBELT: readonly string[] = SANDBOX_TOOL_GROUPS.flatMap((group) =>
  group.tools.map((tool) => tool.name),
);

/** 自建 nuclei 模板的容器内路径（提示词与测试都用它，避免两处字面量）。 */
export const SANDBOX_TEMPLATE_DIR = '/opt/pentest-templates';

/**
 * 镜像里预置的字典（`/usr/share/wordlists/`）。同样进提示词并与 Dockerfile 核对——
 * 模型不知道有什么字典时，要么裸猜路径，要么自己造一份很差的小字典。
 */
export interface SandboxWordlist {
  readonly file: string;
  readonly purpose: string;
}

export const SANDBOX_WORDLISTS: readonly SandboxWordlist[] = [
  { file: 'common.txt', purpose: '通用目录/文件名（约 4700 条；内容发现的首选）' },
  { file: 'raft-small-directories.txt', purpose: '目录名（小字典，递归发现用）' },
  { file: 'raft-small-files.txt', purpose: '文件名（备份/配置/脚本后缀）' },
  { file: 'quickhits.txt', purpose: '高价值敏感路径（配置、凭据、管理面板）' },
  { file: 'api-endpoints.txt', purpose: 'API 端点命名' },
  { file: 'subdomains-5000.txt', purpose: '子域标签（DNS 枚举/爆破）' },
  { file: 'top-usernames.txt', purpose: '用户名短表（**不用于爆破**，只用于单次猜测）' },
  { file: 'top-passwords-1000.txt', purpose: '口令短表（同上：单次猜测，禁爆破）' },
];
/** 服务端展开的范围入口；只描述入口语义，不改变具体 ScopeTarget kind。 */
export const SCOPE_ENTRY_PROFILES = ['ip', 'domain', 'cidr', 'custom'] as const;
export type ScopeEntryProfile = (typeof SCOPE_ENTRY_PROFILES)[number];

/** 服务端展开的行为预设；custom 从 stealth 的安全基线开始应用受限覆盖。 */
export const BEHAVIOR_PROFILES = ['stealth', 'standard', 'deep', 'custom'] as const;
export type BehaviorProfile = (typeof BEHAVIOR_PROFILES)[number];

/**
 * 审批模式：谁来决定「这条命令能不能跑」。
 *
 *   `human`（默认）：逐次放行类别的每个动作都要人类在控制台点一次——审批卡是唯一看过
 *                    命令内容的人。
 *   `auto`（高权限）：**预设内、且不属于默认禁用类别**的动作由服务端自行放行（凭证直接
 *                    建成 approved，落库并记审计），Agent 不必等待；超出预设、或波及
 *                    persistence / destructive / exfiltration 的申请，仍然强制人类。
 *
 * 两种模式都不能改动逐次放行之外的下限（范围、租约、审计、预算、沙箱边界）。
 */
export const APPROVAL_MODES = ['human', 'auto'] as const;
export type ApprovalMode = (typeof APPROVAL_MODES)[number];

/**
 * `custom` 预设有自定义指引时，指引正文的长度上限（字符）。
 *
 * 它会逐次注入该作业下的**每一次**会话提示词，因此上限是这条面上唯一的上下文占用闸门
 * （与 `publicMemory` 同理：绕过它等于允许一段文本挤掉任务本身的空间）。
 */
export const CUSTOM_GUIDANCE_MAX_CHARS = 2000;


// ───────────────────────────── 范围与目标 ─────────────────────────────

export type Protocol = 'tcp' | 'udp' | 'icmp';

/**
 * 范围条目：(target, protocols, ports)。
 *
 * 端口留空的语义**对所有 kind 一致**：按默认 80/443 匹配（§10.2.2）。
 * 想表达「任意端口」必须显式用 `ANY_PORT`——它是人类可见的选项，会记入范围版本与放行记录。
 */
export interface ScopeTarget {
  readonly kind: 'domain' | 'ip' | 'cidr' | 'url' | 'asset-label';
  readonly value: string;
  readonly protocols: readonly Protocol[];
  /**
   * 端口集合。
   *
   * 语义（§10.2.2）：
   *   - domain / ip 条目**留空** → 按默认端口 80/443 匹配
   *   - 显式"任意端口" → 用 `ANY_PORT` 常量，且必须记入范围版本与放行记录（它是人类可见的显式选项）
   *   - 任意 kind（含 cidr / asset-label）留空 → 同样按默认端口 80/443 匹配
   *   - ICMP 条目无端口维度，恒为空数组
   */
  readonly ports: readonly PortRange[];
  /** 子域通配：仅显式写出的 `*.example.com` 才为 true，不含多级嵌套。 */
  readonly wildcardSubdomain?: boolean;
}

export interface PortRange {
  readonly from: number;
  readonly to: number;
}

/**
 * 显式「任意端口」。它不是"留空"的同义词——
 * 留空在 domain/ip 条目上表示默认端口 80/443，在 cidr/asset-label 条目上被拒绝加载。
 * 人类选择任意端口时范围版本与放行记录都必须记下这个值（§10.2.2）。
 */
export const ANY_PORT: PortRange = { from: 0, to: 65535 };

/** 规范化后的目标。 */
export interface NormalizedTarget {
  readonly kind: 'domain' | 'ip' | 'url';
  readonly host: string;
  readonly port?: number;
  readonly scheme?: string;
  /** DNS 裁决出的地址集合；连接必须落到其中之一（地址固定）。 */
  readonly resolvedAddresses?: readonly string[];
}

/**
 * 资产范围裁决的取值域（§8.6）。
 *
 * 是常量而不是裸联合类型：读库侧要用它做**运行时收窄**（`narrow(row.decision, SCOPE_DECISIONS)`），
 * 此前那张列表在 `pg-memory-query.ts` 与客户端 `ScopeManager.tsx` 里各写了一份——
 * 两份列表漂移时，某一侧会把合法取值当成脏数据拒掉（或反过来放行）。
 */
export const SCOPE_DECISIONS = ['included', 'excluded', 'pending'] as const;
export type ScopeDecision = (typeof SCOPE_DECISIONS)[number];

/** 范围判定结果。拒绝时给出稳定错误码，便于验收与审计分支。 */
export type ScopeVerdict =
  | { readonly ok: true; readonly normalized: NormalizedTarget }
  | {
      readonly ok: false;
      readonly code: ScopeRejectionCode;
      readonly detail: string;
      /**
       * 规范化结果——**只有规范化已经完成的失败才有**（§10.2.2 的 `scope_violation`
       * 事件要求同时记下「原始目标」与「规范化结果」）。
       *
       * `malformed_target` / `userinfo_present` 这类失败发生在规范化之前，
       * 本来就不存在规范形式，因此是可选字段。
       */
      readonly normalized?: NormalizedTarget | null;
    };

export const SCOPE_REJECTION_CODES = [
  'malformed_target',
  'userinfo_present',
  'encoded_authority',
  'control_chars',
  'noncanonical_ip',
  'wildcard_illegal',
  'protocol_undetermined',
  'port_not_allowed',
  'protocol_not_allowed',
  'out_of_scope',
  'excluded',
  'pending',
  'dns_unresolved',
  'address_not_adjudicated',
] as const;
export type ScopeRejectionCode = (typeof SCOPE_REJECTION_CODES)[number];

// ───────────────────────────── 放行（一次性授权） ─────────────────────────────

export type ApprovalDecision =
  | 'pending'
  | 'approved'
  | 'rejected'
  | 'expired'
  | 'revoked'
  | 'superseded';

/** 幂等键派生输入。服务端计算，不采信 Agent 传值（设计文档 §10.2）。 */
export interface IdempotencyInput {
  readonly workerSessionId: string;
  readonly actionClass: ActionClass;
  readonly normalizedTarget: string;
  readonly normalizedCommand: string;
  /** 未携带放行凭证时为空串——保证"未放行"与"已放行同一动作"派生不同键。 */
  readonly approvalId: string;
}

// ───────────────────────────── 会话租约 ─────────────────────────────

/**
 * 租约吊销理由。
 *
 * 为什么需要 `expired`：`session_leases_one_active` 是 `WHERE revoked_at IS NULL`
 * 的部分唯一索引，而**到期未续的行 `revoked_at` 仍为 NULL**——它会继续占用槽位，
 * 使恢复中的会话无法签发新租约。因此需要一个由清扫任务驱动的过期吊销，
 * 把 `expires_at < now()` 且未吊销的行标记为 `expired` 并释放槽位。
 *
 * 为什么 `expired` 不等于 `superseded`：过期表示"会话失联"，被取代表示
 * "会话被有意替换"。两者在审计上的含义与后续处置完全不同，不能混用。
 *
 * 为什么没有 `budget_exhausted`：预算耗尽只是暂停，会话仍存活、租约保留，
 * 否则一次预算追加会静默作废该会话全部待用放行凭证（§10.6）。
 */
export type LeaseRevocationReason = 'superseded' | 'closed' | 'failed' | 'human_revoke' | 'expired';

export interface SessionLease {
  readonly id: string;
  readonly workerSessionId: string;
  readonly taskRef: string | null;
  /** 世代号：重做复用时递增，用于识别滞后提交。 */
  readonly generation: number;
  readonly expiresAt: Date;
  readonly revokedAt: Date | null;
  readonly revokedReason: LeaseRevocationReason | null;
}

/** 需要持租约的提交类操作（设计文档 §10.6）。 */
export const LEASE_REQUIRED_OPERATIONS = [
  'submit_report',
  'request_approval',
  'execute',
  'draft_handoff',
] as const;
export type LeaseRequiredOperation = (typeof LEASE_REQUIRED_OPERATIONS)[number];

// ───────────────────────────── 交接 ─────────────────────────────

/**
 * 下游必需键的解析来源（§7.2）。
 * 这些键不是交接结构里的独立字段，而是从交接上下文解析出的引用集合。
 *
 * **两类键的判定规则不同**（这是 §2.2「允许空装载」与 §7.2「空即阻止」之间的调和）：
 */
export const REQUIRED_HANDOFF_KEYS = [
  'asset_refs',
  'scope_version',
  'finding_refs',
  'approval_scope',
  'skill_ids',
] as const;
export type RequiredHandoffKey = (typeof REQUIRED_HANDOFF_KEYS)[number];

/**
 * 内容必需键：解析为空即阻止确认。
 *
 * 空意味着下游**无法工作**——没有资产就没法建威胁模型，没有结论就没法验证。
 */
export const CONTENT_REQUIRED_KEYS = [
  'asset_refs',
  'scope_version',
  'finding_refs',
] as const satisfies readonly RequiredHandoffKey[];

/**
 * 可空但须已表决的键：空集合算已解析，不阻止确认。
 *
 * 这两者表达"没有"是**合法状态**：§2.2 明确"不装载 skill 是合法状态"，
 * §10.3 也允许某阶段没有任何需逐次放行的类别。若按"空即阻止"处理，
 * 人类在 §6.6 故意清空 skill 的合法选择会被卡住。
 *
 * 但"可空"不等于"可省略"：人类必须显式提交过决定（勾选"不装载"或列空白），
 * 以区分"有意为空"与"漏了"。校验函数接收一个标记来区分这两种情况。
 */
export const NULLABLE_HANDOFF_KEYS = [
  'approval_scope',
  'skill_ids',
] as const satisfies readonly RequiredHandoffKey[];

export interface HandoffPackage {
  readonly handoffId: string;
  readonly transitionType: HandoffTransitionType;
  readonly forced: boolean;
  readonly approvedToPhase: Phase;
  readonly approvedPrompt: string;
  /** 下一任务的目标（人类批准的那一份）。 */
  readonly objective: string;
  /** 人类决定排除的引用，落库到 `handoffs.excluded_refs`。 */
  readonly excludedRefs: readonly string[];
  readonly approvedContextRefs: readonly string[];
  readonly approvedSkillIds: readonly string[];
  readonly approvedToolFilter: { readonly allow: readonly string[] };
  /** approval_scope 的解析来源。 */
  readonly approvedApprovalRequired: readonly ActionClass[];
  readonly truncatedRefs: readonly string[];
  readonly humanDecisionRef: string;
  readonly contentHash: string;
}

/** 必需键校验结果（纯函数，不派发、不改状态、不调用模型）。 */
export type HandoffValidation =
  | { readonly ok: true }
  | { readonly ok: false; readonly missing: readonly RequiredHandoffKey[] };

// ───────────────────────────── 记忆与检索 ─────────────────────────────

export type TrustLevel =
  | 'human_decision'
  | 'tool_observation'
  | 'agent_claim'
  | 'model_reasoning'
  | 'external_untrusted';

export type Classification =
  | 'public'
  | 'engagement'
  | 'secret-like'
  | 'reasoning'
  | 'credential-like'
  | 'binary';

/**
 * 范围过滤谓词（设计文档 §8.6）：
 *   可见 ⟺ NOT (chunk.asset_ids ∩ X(v) ≠ ∅)
 *        ∧ (chunk.asset_ids ∩ I(v) ≠ ∅ ∨ chunk.asset_ids = ∅)
 * 被排除资产优先：含任一被排除资产的分块不可见，即使同块还含已纳入资产。
 * 空 asset_ids 放行（否则思考链、压缩摘要整批消失）。
 */
export interface ScopeFilterInput {
  readonly chunkAssetIds: readonly string[];
  readonly includedAssetIds: ReadonlySet<string>;
  readonly excludedAssetIds: ReadonlySet<string>;
}

// ───────────────────────────── 事件账本 ─────────────────────────────

/** 事件哈希覆盖的规范化字段集合（设计文档 §9.5）。改集合属协议版本变更。 */
export interface EventHashPayload {
  readonly eventType: string;
  readonly sourceSystem: string;
  readonly sourceId: string;
  readonly sourceSeq: number;
  readonly chainSeq: number;
  readonly occurredAt: string;
  readonly provisional: boolean;
  readonly classification: Classification;
  readonly trustLevel: TrustLevel;
  readonly payloadJson: unknown;
  readonly rawPayload: Uint8Array;
}

/** 领域事件只进 PostgreSQL，不进会话日志（设计文档 §8.2）。 */
export const DOMAIN_EVENT_TYPES = [
  'engagement.created',
  'engagement.archived',
  'engagement.public_memory.updated',
  'human.authorization.submitted',
  'human.authorization.confirmed',
  'human.input',
  'human.interjection',
  'human.decision',
  'lease.issued',
  'lease.renewed',
  'lease.expired',
  'lease.revoked',
  'budget.warning',
  'budget.exhausted',
  'budget.extended',
  'context.compacted',
  'scope.snapshot',
  'scope.proposal.created',
  'scope.proposal.superseded',
  'scope.amended',
  'scope.violation',
  'policy.profile.selected',
  'policy.snapshot.previewed',
  'policy.snapshot.confirmed',
  'policy.snapshot.frozen',
  'policy.snapshot.amended',
  'policy.epoch.advanced',
  'policy.approval_mode.changed',
  'execution.policy.checked',
  'execution.pacing.applied',
  'execution.detection_signal',
  'execution.stopped',
  'audit.accessed',

  'roe.snapshot',
  'skill.added',
  'skill.updated',
  'skill.removed',
  'iteration.started',
  'phase.transition',
  'transition.forced_jump',
  'worker.session.created',
  'worker.session.started',
  'worker.session.paused',
  'worker.session.stopped',
  'worker.session.reused_retry',
  'worker.session.closed',
  'session.reconciled',
  'engagement.blocked_by_recovery',
  'workflow.delivery_failed',
  'workflow.close_session_failed',
  'tool.run.marked_unknown',
  'worker.report',
  'worker.status_note',
  'worker.waiting_human',
  'handoff.draft.requested',
  'handoff.draft.generated',
  'handoff.draft.failed',
  'classification.rejected',
  'handoff.edited',
  'handoff.confirmed',
  'llm.request.header',
  'llm.stream.frame',
  'llm.reasoning',
  'llm.assistant.message',
  'tool.call',
  'tool.approval.requested',
  'tool.approval.resolved',
  // 放行决策的**送达**（§10.3 验收：会话运行中按插话路径送达、等待中唤醒送达）。
  'tool.approval.notified',
  'tool.approval.notice_failed',
  'tool.result',
  'tool.artifact',
  'memory.query',
  'memory.hit',
  'memory.recall.injected',
  'memory.access',
  'finding.proposed',
  'finding.validated',
  'finding.rejected',
  'report.draft.generated',
  'report.edited',
  'report.signed',
  'report.exported',
  'run.paused',
  'run.resumed',
  'run.aborted',
] as const;
export type DomainEventType = (typeof DOMAIN_EVENT_TYPES)[number];

// ───────────────────────────── 稳定错误码 ─────────────────────────────

/**
 * 工具返回的机器码。模型据码分支，不解析 message 文本
 * （设计文档 §16.5：异常、超时、拒绝与空结果不渲染为成功消息）。
 */
export const ERROR_CODES = [
  'approval_required',
  'approval_consumed',
  'approval_expired',
  'approval_revoked',
  'scope_violation',
  'classification_rejected',
  'protocol_undetermined',
  'target_not_adjudicated',
  'lease_required',
  'lease_expired',
  'lease_revoked',
  'lease_generation_stale',
  'stale_state_version',
  'forced_reason_required',
  'scope_amendment_required',
  /**
   * engagement 不在 `running` 状态。
   *
   * 暂停、阻塞（恢复对账发现未知副作用）、终止、失败都归这里。单列一个码是
   * 因为它与其它拒绝的**处置完全不同**：不是「缺东西」也不是「越界」，而是
   * 「人类或系统要求停下」——模型与 UI 应当据此停止重试，等待人类决定。
   */
  'engagement_halted',
  'budget_exhausted',
  'handoff_incomplete',
  'handoff_transition_illegal',
  'audit_unavailable',
  'idempotent_replay',
  'sandbox_unavailable',
  /**
   * skill 库的名称已被占用（§2.2）。
   *
   * 单列一个码是因为调用方的处置很具体：不是「重试」也不是「修输入格式」，
   * 而是「换一个名字或去改已有条目」。用消息文本判断会让中文文案一改就失效。
   */
  'skill_name_taken',
  /**
   * 授权已过期（§11.1）。
   *
   * 单列一个码是因为它的处置**不是重试也不是改输入**：唯一的出路是取得新的授权
   * （或修订授权依据），在此之前任何触及目标的动作都不该被受理。用 `scope_violation`
   * 或 `classification_rejected` 表示它，会让模型与 UI 以为是范围问题而去改目标。
   */
  'authorization_expired',
] as const;
export type ErrorCode = (typeof ERROR_CODES)[number];

export interface ToolError {
  readonly status: 'blocked';
  readonly code: ErrorCode;
  readonly message: string;
  readonly approval_id?: string;
  readonly next_action: string;
}

// ───────────────────────────── 服务接口（面） ─────────────────────────────

export interface WorkflowSnapshot {
  readonly engagementId: string;
  readonly mainStatus: MainStatus;
  readonly runMarker: RunMarker;
  readonly currentPhase: Phase | null;
  readonly stateVersion: number;
  readonly graphIteration: number;
  readonly activeWorkerSessionId: string | null;
  /**
   * 当前生效的范围版本；`null` 表示还没有任何范围版本。
   *
   * 放进快照而不是让调用方另调 `getScope`：运行总览与运行闸门都要它，而「当前状态」
   * 本来就该由 `getState` 一次给全。分两处取会让界面在两者之间出现短暂的不一致
   * （比如总览已显示新版本、闸门还按旧版本判断）。
   */
  readonly scopeVersion: number | null;
  /**
   * 授权到期时间（ISO 串）；`null` 表示未声明。
   *
   * 为什么会单独给出来：这是**硬边界**（§11.1）——到期后新动作会被 `admit` 拒绝。
   * 界面此前显示「—」，而「—」既可能是「没声明」也可能是「没读」，人分不清，
   * 于是看不到自己只剩几天。
   */
  readonly authorizationExpiresAt: string | null;
}

export interface HumanWorkflowService {
  /** 打开或恢复一个会话优先的授权 intake；engagement 在后台幂等创建。 */
  openTask(input: OpenTaskInput): Promise<OpenTaskResult>;
  /** 读取当前待确认的 AI 范围方案。 */
  getScopeProposal(engagementId: string): Promise<ScopeProposal | null>;
  /** 人类确认 AI 提案并创建第一个五阶段 Agent。 */
  confirmScopeProposal(input: ConfirmScopeProposalInput): Promise<ConfirmedScopeProposal>;
  /** 驳回当前提案，但保留 intake 会话继续收集信息。 */
  rejectScopeProposal(input: RejectScopeProposalInput): Promise<ScopeProposal | null>;
  /**
   * 创建 engagement（授权向导的落点，§6.1、§11.1）。
   *
   * 不要求 `expectedStateVersion`：此刻还没有 engagement，也就没有版本可比对——
   * 它是这一条状态链的起点。防重复靠调用方的幂等键（§15.3）。
   */
  createEngagement(input: CreateEngagementInput): Promise<EngagementSummary>;
  /** 列出可管理的 engagement。 */
  listEngagements(input: ListEngagementsInput): Promise<readonly EngagementSummary[]>;
  /** 列出某 engagement 的 Worker 会话。 */
  listWorkerSessions(input: ListWorkerSessionsInput): Promise<readonly WorkerSessionSummary[]>;
  /** 范围 dry-run。 */
  previewScope(input: PreviewScopeInput): Promise<ScopePreview>;
  /**
   * 策略/范围预览：**确认前**把服务端将冻结的全部事实给人类看（§6.2.0.5）。
   *
   * 与 `previewScope` 的分工：那个只描述条目能否解析；这个描述「确认之后会发生什么」——
   * 规范化范围、地址裁决、展开后的节奏与动作权限、以及最终快照哈希。
   */
  previewPolicy(input: PolicyPreviewInput): Promise<PolicyPreview>;
  /** 列出放行记录。 */
  listApprovals(input: ListApprovalsInput): Promise<readonly ApprovalDetail[]>;
  /** 读该 dsh 会话当前需要人类做什么（聊天内的确认卡片用）。 */
  getIntakeStatus(input: IntakeStatusInput): Promise<IntakeStatus>;
  /** 读取当前范围与历史版本。 */
  getScope(input: GetScopeInput): Promise<ScopeDetail>;
  /** 读取公共记忆。 */
  getEngagementMemory(input: GetEngagementMemoryInput): Promise<EngagementMemory>;
  /** 改写公共记忆。 */
  updateEngagementMemory(input: UpdateEngagementMemoryInput): Promise<EngagementMemory>;
  /** 列出待裁决候选资产。 */
  listCandidateAssets(input: ListCandidateAssetsInput): Promise<readonly CandidateAsset[]>;
  getState(engagementId: string): Promise<WorkflowSnapshot>;
  startWorker(input: StartWorkerInput): Promise<StartedWorker>;
  /**
   * 「进入下一阶段」的**服务端起稿**：不经过 Agent，按阶段定义与当前状态给出可直接编辑的
   * 提示词与上下文（人类在编辑器里改完再确认）。
   *
   * 为什么不用 Agent 起草：那要往会话里续跑一个回合并把机器格式的 JSON 灌进对话，
   * 而人类要的只是一份能直接改的内容（2026-10-05 人类要求）。
   */
  beginHandoff(input: {
    readonly workerSessionId: string;
    readonly operatorId: string;
    readonly toPhase?: Phase;
  }): Promise<HandoffDraft>;
  /** 让当前 Worker 生成交接草稿（受控续跑；控制台不再用它，保留给未来的显式用途）。 */
  /**
   * 读回**当前待确认**的交接草稿（没有则 `null`）。
   *
   * 界面据此渲染编辑器。草稿不能只活在「请求它的那次调用」的返回值里：那一轮新消息会让
   * 会话尾部组件重新挂载，草稿随之消失——人类看得到草稿正文却找不到确认按钮（2026-10-05 报障）。
   */
  currentHandoffDraft(input: { readonly workerSessionId: string }): Promise<HandoffDraft | null>;
  cancelHandoff(input: HumanCancel): Promise<WorkflowSnapshot>;
  amendScope(input: ScopeAmendment): Promise<ScopeVersionRef>;
  /** 切换审批模式（运行中可切；写新策略版本并推进 policy epoch）。 */
  setApprovalMode(input: ApprovalModeChange): Promise<ApprovalModeChangeRef>;
  /** 归档/取消归档（列表隐藏，数据保留）。 */
  archiveEngagement(input: ArchiveEngagementInput): Promise<EngagementSummary>;
  /** 彻底删除前的只读预览（行数 + 拦截原因）。 */
  previewEngagementPurge(input: { readonly engagementId: string }): Promise<PurgePreview>;
  /** 彻底删除（只对已归档、无活会话、且输入名一致的作业生效）。 */
  purgeEngagement(input: PurgeEngagementInput): Promise<PurgeResult>;
  interject(input: Interjection): Promise<InterjectionResult>;
  extendBudget(input: BudgetExtension): Promise<WorkflowSnapshot>;
  decideApproval(input: HumanApprovalDecision): Promise<ApprovalRecord>;
  revokeApproval(input: HumanApprovalRevocation): Promise<ApprovalRecord>;
  confirmTransition(input: TransitionConfirmation): Promise<TransitionResult>;
  retryWorker(input: RetryRequest): Promise<TransitionResult>;
  reopenTechnicalWork(input: HumanReopen): Promise<WorkflowSnapshot>;
  pause(input: HumanPause): Promise<WorkflowSnapshot>;
  resume(input: HumanResume): Promise<WorkflowSnapshot>;
  abort(input: HumanAbort): Promise<WorkflowSnapshot>;
  finishTechnicalTesting(input: HumanFinishTesting): Promise<ReportDraft>;
  signReport(input: HumanReportSignature): Promise<ReportVersionRef>;
}

// ── 人类操作输入（全部要求 expectedStateVersion，防并发覆盖） ──

/**
 * 创建 engagement 的输入：授权向导收集的全部运行前信息（§11.1）。
 *
 * 目标与排除项用 `ScopeTarget`（与范围版本同一结构），因为向导产出的就是
 * 范围版本 1 的内容。`roe` 与 `timeWindow` 是自由结构（jsonb）：它们随部署与
 * 客户而变，硬编码字段会逼实现去改迁移。
 */
export interface CreateEngagementInput {
  readonly operatorId: string;
  readonly reason: string;
  readonly name: string;
  /**
   * 授权主体与内部批准记录引用（§11.1）。
   *
   * **可选**：它只进档案与审计留痕，没有任何判定读它（范围判定只读
   * `scope_versions` 的 targets/exclusions）。此前它是必填、连服务端都拒绝空串——
   * 那让「自己给自己授权」这类个人用法每次都要编一个引用才能开始。
   * 建议填，但不强求；范围管理面板里可以随时补。
   */
  readonly authorizationRef?: string;
  /**
   * 授权有效期（ISO 串）；省略/空串即**未声明到期**。
   *
   * 这是 §11.1 里**唯一真正的硬边**：填了值，到期后 `admit` 与 `validateExecution`
   * 两处都会拒绝新动作；不填则永不过期。因此它可选但意义重大——界面上放在「高级」里，
   * 因为大多数个人作业不需要它，而需要它的场景会自己去找。
   */
  readonly authorizationExpiresAt?: string;
  /** 范围入口选择；省略时服务端使用兼容默认 custom。 */
  readonly scopeEntryProfile?: ScopeEntryProfile;
  /**
   * 行为预设：**必选项**，没有默认值（缺了即拒绝，见 `requireBehaviorSelection`）。
   *
   * 四档分别对应四种作业场景（红队隐蔽 / 已通知授权 / 高许可穷尽 / 自定义），
   * 它决定注入会话的行为指引、宿主侧节奏与"超出预设即强制人工放行"的边界。
   */
  readonly behaviorProfile: BehaviorProfile;
  /**
   * `custom` 预设的自定义指引（人类自己写的行为提示词）。
   *
   * **只有 `custom` 接受它**：其它预设的指引是固定文案，给了会被拒绝而不是静默忽略。
   * 它随策略快照一起冻结、进哈希——改指引等于改策略，旧放行凭证随之失效。
   */
  readonly customGuidance?: string;
  /**
   * 审批模式：**必选项**（`human` 人工审批 / `auto` 高权限自行放行，见 {@link APPROVAL_MODES}）。
   *
   * 它是**能力决定**而不是偏好：`auto` 会让预设内的动作不经人类过目就直接执行，
   * 因此和预设一样必须由人类显式选择，并随策略快照冻结、进哈希。
   */
  readonly approvalMode: ApprovalMode;
  /** 预设之外的受限覆盖（pacing/类别等，键有白名单）；最终快照由服务端生成。 */
  readonly policyOverrides?: Readonly<Record<string, unknown>>;

  readonly targets: readonly ScopeTarget[];
  /** 排除项；省略即 `[]`。 */
  readonly exclusions?: readonly ScopeTarget[];
  /** 规则：允许的测试类型、速率、并发、最大影响、数据规则、紧急停止条件。省略即 `{}`。 */
  readonly roe?: Readonly<Record<string, unknown>>;
  /** 时间窗：允许执行的时间段。省略即 `{}`。 */
  readonly timeWindow?: Readonly<Record<string, unknown>>;
  /**
   * 公共记忆：本作业下**所有 Agent** 都会读到的规则与共识。
   *
   * 内容随每次创建会话注入系统提示词，因此「这个作业的规矩」不必在每个任务提示词里
   * 重复。省略即空（= 没有额外规矩）。建完之后也能在控制台「公共记忆」面板里改。
   */
  readonly publicMemory?: string;
}

/**
 * 一个 engagement 的公共记忆。
 *
 * 与 `memory_*` 表的区别：那些是 Agent 产出的事实（只追加、可检索）；这一条是
 * 人类写的**指令与共识**，可改写、不参与检索、但会被注入每次会话的提示词。
 */
export interface EngagementMemory {
  readonly engagementId: string;
  /** 正文；从未写过时为空串（不是 null）。 */
  readonly content: string;
  readonly updatedAt: string | null;
  readonly updatedBy: string | null;
}

export interface GetEngagementMemoryInput {
  readonly engagementId: string;
}

export interface UpdateEngagementMemoryInput extends HumanActor {
  readonly engagementId: string;
  readonly content: string;
}

export interface ListEngagementsInput {
  readonly operatorId: string;
  /**
   * 只返回这些运行标记的作业。**省略时默认只返回活动态**
   *（`running`/`paused`/`blocked`，见 `EngagementFlow.listEngagements`）——终止/失败的
   * 作业不在其中，所以想看到历史就必须显式列全（控制台就是这么传的）。
   */
  readonly statuses?: readonly RunMarker[];
  readonly limit?: number;
  /** 是否连带列出已归档的作业（默认 false：归档即从默认列表消失）。 */
  readonly includeArchived?: boolean;
}

/**
 * engagement 摘要（列表用）。
 *
 * 刻意不含 snapshot 大字段：列表只用于选择与状态总览，点进去再读 `getState`
 * 与各详情端点。一次列表返回几十 KB 的 scope 快照会让首屏变慢。
 */
export interface EngagementSummary {
  readonly id: string;
  readonly name: string;
  readonly runMarker: RunMarker;
  readonly mainStatus: MainStatus;
  readonly currentPhase: Phase | null;
  readonly stateVersion: number;
  readonly graphIteration: number;
  readonly activeWorkerSessionId: string | null;
  /**
   * 当前策略投影（§6.2.0.5）。
   *
   * 摘要里带这四个字段而不是让界面另调端点：创建向导刚返回时人类需要核对的就是
   * 「服务端最终冻结了哪个预设、哈希是多少」，而那正是这一刻服务端自己的事实。
   */
  readonly scopeEntryProfile: ScopeEntryProfile;
  readonly behaviorProfile: BehaviorProfile;
  /** 该作业冻结的审批模式（控制台据此显示「高权限」标记）。 */
  readonly approvalMode: ApprovalMode;
  /** 归档时间（非空即已归档：默认列表不带它）。 */
  readonly archivedAt?: string | null;
  /** 内容清空时间（非空即已清理：不可逆；审计骨架按 §9.5 保留）。 */
  readonly purgedAt?: string | null;
  readonly policyVersion: number;
  readonly policySnapshotHash: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/**
 * 一个 Worker 会话的摘要（阶段轨道、时间轴、审计追溯共用）。
 *
 * 带全部历史关联指针而不是只给当前状态：阶段轨道要按阶段聚合、时间轴要画重做链
 * 与交接链，两者都依赖这些指针。没有它们，前端只能显示一串平铺的会话，
 * 「哪个是重做、哪个是交接来的」就看不出来——而 §6.2 要求「只画有证据的边」
 * 的前提正是证据本身可得。
 */
export interface WorkerSessionSummary {
  readonly id: string;
  readonly dshSessionId: string;
  readonly phase: Phase;
  readonly status: SessionStatus;
  /** intake 只用于授权与范围确认；phase 才属于五阶段轨道。 */
  readonly sessionKind?: SessionKind;
  /** 同阶段内的第几次执行（重做复用会话时递增）。 */
  readonly attempt: number;
  readonly iteration: number;
  readonly scopeVersion: number;
  readonly previousAgentSessionId: string | null;
  readonly retryOfSessionId: string | null;
  readonly transitionId: string | null;
  readonly statusNote: string | null;
  readonly statusNoteSource: 'agent' | 'derived' | null;
  readonly statusNoteAt: string | null;
  readonly startedAt: string | null;
  readonly endedAt: string | null;
  readonly createdAt: string;
}

export interface ListWorkerSessionsInput {
  readonly engagementId: string;
  /** 只返回这些阶段；省略即全部五个。 */
  readonly phases?: readonly Phase[];
  readonly limit?: number;
}

/** 授权向导的范围 dry-run 输入（尚未创建 engagement，因此不要求它的标识）。 */
export interface PreviewScopeInput {
  readonly targets: readonly ScopeTarget[];
  readonly exclusions: readonly ScopeTarget[];
}

/** 一条范围条目的预校验结论。 */
export interface ScopePreviewEntry {
  /** 该行在输入里的位置，供界面把结论对回具体那一行。 */
  readonly index: number;
  readonly kind: ScopeTarget['kind'];
  /** 规范化后的稳定键（`kind:value` 形式）；无法规范化时为 `null`。 */
  readonly canonical: string | null;
  /** 协议集合的规范化结果。 */
  readonly protocols: readonly Protocol[];
  /** 端口语义的人读描述（例如「默认 80/443」或「8000-8100」）。 */
  readonly portSummary: string;
  /** 通过时为空；否则是稳定的拒绝码。 */
  readonly rejectionCode: ScopeRejectionCode | null;
  /** 拒绝原因（人类可读，含 §10.2.2 的规则出处）。 */
  readonly detail: string | null;
}

export interface ScopePreview {
  readonly targets: readonly ScopePreviewEntry[];
  readonly exclusions: readonly ScopePreviewEntry[];
  /** 整体是否可用于创建 engagement。 */
  readonly ok: boolean;
}

// ───────────────────────────── 放行记录的读取（§10.3.1） ─────────────────────────────

export interface ListApprovalsInput {
  readonly engagementId: string;
  /** 只返回这些决策状态；省略即 `pending` 与 `approved`（队列关心的是「还能不能动」）。 */
  readonly decisions?: readonly ApprovalDecision[];
  readonly limit?: number;
}

/**
 * 放行记录的完整视图。
 *
 * 与 `ApprovalRecord`（决策返回值）的区别：那个只够回答「批了没有」，
 * 这个要够回答**「批的是什么」**——因此带 `commandPlan` 与 `targetSnapshot`。
 * §10.3.1 的 approve-what-you-see 依赖后者。
 */
export interface ApprovalDetail {
  readonly id: string;
  readonly engagementId: string;
  readonly workerSessionId: string | null;
  readonly actionClass: ActionClass;
  readonly decision: ApprovalDecision;
  /** 由服务端模板生成的完整计划载荷；UI 只允许提交其中的受信输入字段。 */
  readonly commandPlan: unknown;
  /** 规范化目标。 */
  readonly normalizedTarget: string | null;
  /** **即将执行的完整命令文本**——人类批准的是它。 */
  readonly normalizedCommand: string | null;
  readonly purpose: string | null;
  readonly timeoutMs: number | null;
  readonly maxOutputBytes: number | null;
  readonly scopeVersion: number | null;
  readonly policyEpoch: number | null;
  readonly targetSnapshot: unknown;
  readonly riskSummary: string | null;
  readonly planHash: string;
  readonly leaseGeneration: number | null;
  readonly decidedBy: string | null;
  readonly decisionReason: string | null;
  readonly expiresAt: string | null;
  readonly consumedAt: string | null;
  readonly createdAt: string;
  readonly canResolve: boolean;
}

// ───────────────────────────── 范围读取（§5.5） ─────────────────────────────

export interface GetScopeInput {
  readonly engagementId: string;
  /** 是否附带历史版本（默认 false——只有范围管理页需要）。 */
  readonly includeHistory?: boolean;
}

export interface ScopeVersionDetail {
  readonly version: number;
  readonly iteration: number;
  readonly targets: readonly ScopeTarget[];
  readonly exclusions: readonly ScopeTarget[];
  readonly authorizationRef: string | null;
  readonly amendmentReason: string | null;
  readonly changedBy: string;
  readonly contentHash: string;
  readonly createdAt: string;
}

export interface ScopeDetail {
  /** 当前生效版本；尚无范围版本时为 null。 */
  readonly current: ScopeVersionDetail | null;
  /** 历史版本（新→旧）；`includeHistory` 为 false 时为空数组。 */
  readonly history: readonly ScopeVersionDetail[];
}

export interface ListCandidateAssetsInput {
  readonly engagementId: string;
  /** 只返回这些裁决状态；省略即 `pending`（待裁决的）。 */
  readonly decisions?: readonly ScopeDecision[];
  readonly limit?: number;
}

/**
 * 待裁决的候选资产。
 *
 * `discoveredFromSessionId` / `discoveredFromAssetId` 是**发现来源**（§5.5 要求
 * 「列出新发现资产、标注来源」）：人类需要知道每个候选是怎么来的才能判断。
 */
export interface CandidateAsset {
  readonly id: string;
  readonly canonicalTarget: string;
  readonly kind: string;
  readonly labels: readonly string[];
  readonly firstSeenIteration: number;
  readonly discoveredFromSessionId: string | null;
  readonly discoveredFromAssetId: string | null;
  /** 候选的规范化目标（与范围条目的比较键同形）。 */
  readonly evidenceRefs: readonly string[];
  readonly currentDecision: ScopeDecision | null;
}

export interface HumanActor {
  readonly operatorId: string;
  /**
   * 人类给的备注。**可选**——人类动作不要求理由（2026-10-05 人类明确要求）：
   * 操作者与时间照记进 `human_decisions` 与审计，理由缺省落空串。
   */
  readonly reason?: string;
  readonly expectedStateVersion: number;
}
/**
 * 切换审批模式（运行中可切）。
 *
 * **不要求理由**：人类是主人，切换是他对自己作业的能力决定——理由写成可选的备注即可。
 * 无论有没有理由，服务端都记人类决策（`set_approval_mode`，含 from/to、操作者、时间）
 * 与两条审计事件；收紧（auto → human）与放宽（human → auto）走同一条路径。
 */
export interface ApprovalModeChange {
  readonly engagementId: string;
  readonly operatorId: string;
  readonly approvalMode: ApprovalMode;
  readonly expectedStateVersion: number;
  /** 可选备注：写了就进决策记录，不写也不拦。 */
  readonly reason?: string;
}

/**
 * 归档/取消归档（清理的**第一级**）：列表隐藏、数据一个字节不删、随时可恢复。
 *
 * 为什么不做成"直接删除"：审计要求这些行仍在库里（§9.2）——真正删除是第二级，
 * 需要显式两步（先归档、再输名字确认）。
 */
export interface ArchiveEngagementInput {
  readonly engagementId: string;
  readonly operatorId: string;
  readonly archived: boolean;
  /** 可选备注（写进决策记录）。 */
  readonly reason?: string;
}

/** 彻底删除前的预览：要删多少行、有没有拦路的东西。 */
export interface PurgePreview {
  readonly engagementId: string;
  readonly name: string;
  readonly archived: boolean;
  /** 各表将被删除的行数（人类在确认框里看到的就是它）。 */
  readonly counts: Readonly<Record<string, number>>;
  readonly total: number;
  /**
   * **按 §9.5 必须保留**的行数（审计账本只允许追加：事件/决策/转移/锚点/读取日志/策略版本，
   * 以及被它们引用的会话与交接）。人类在确认框里也要看到这部分——"删干净了"是一句假话。
   */
  readonly retained: Readonly<Record<string, number>>;
  readonly retainedTotal: number;
  /** 非空即不可删除（有活会话/活租约/未归档）。 */
  readonly blockers: readonly string[];
}

export interface PurgeEngagementInput extends HumanActor {
  readonly engagementId: string;
  /** **必须与作业名完全一致**——这一条是人类防手滑的唯一栏杆。 */
  readonly confirmName: string;
}

export interface PurgeResult {
  readonly engagementId: string;
  readonly counts: Readonly<Record<string, number>>;
  readonly retained: Readonly<Record<string, number>>;
}

export interface ApprovalModeChangeRef {
  readonly engagementId: string;
  readonly approvalMode: ApprovalMode;
  /** 新写入的策略版本号（切换即新版本，不原地改）。 */
  readonly policyVersion: number;
  /** 新的策略 epoch：旧放行凭证与在途计划凭它当场失效。 */
  readonly policyEpoch: number;
  /** 被终止的在途动作数（切换后由执行侧收口，落审计）。 */
  readonly aborted: number;
}

export interface StartWorkerInput extends HumanActor {
  readonly engagementId: string;
  readonly phase: Phase;
  readonly taskPrompt: string;
  readonly skillIds?: readonly string[];
  readonly toolAllow?: readonly string[];
  readonly budget?: BudgetLimits;
}

/**
 * 会话装载集合的内容冻结条目（`worker_sessions.skill_freeze`，事故 2026-10-05）。
 *
 * 创建会话时写入 `{name, revision, contentHash}`：名字不是契约，正文才是。
 * `revision`/`contentHash` 为 `null` 表示创建时库里就没有这一行——
 * 读取侧必须拒绝，而不是按「名字在集合里」放行。
 */
export interface SkillFreezeEntry {
  readonly name: string;
  readonly revision: number | null;
  readonly contentHash: string | null;
}

/**
 * 宿主目录挂载（设计 §10.4：「只挂载当前 engagement 的授权目录」）。
 *
 * 定义在契约里而不是沙箱模块里：**提示词侧也要用它**（会话提示词必须告诉 Agent
 * 「哪个容器路径对应人类的哪个目录、能不能写」），否则沙箱读不到文件的同时模型也不知道有这条路，
 * 症状就是「Agent 说它看不见你的目录」。
 */
export interface SandboxMount {
  /** 宿主绝对路径（Windows 写 `C:/x/y`；反斜杠会被规整）。 */
  readonly hostPath: string;
  /** 容器内路径；省略即 `/work`（`/work/*` 或 `/mnt/*`，见沙箱的校验）。 */
  readonly containerPath?: string;
  /** 省略即读写。 */
  readonly readOnly?: boolean;
}

export interface StartedWorker {
  readonly workerSessionId: string;
  readonly dshSessionId: string;
  readonly leaseId: string;
  readonly leaseGeneration: number;
}

export interface OpenTaskInput {
  readonly operatorId: string;
  readonly reason: string;
  /** 浏览器/客户端稳定键；同租户同键只创建一个后台任务。 */
  readonly clientSessionKey: string;
}

export interface OpenTaskResult extends StartedWorker {
  readonly engagementId: string;
  readonly sessionKind: 'intake';
  readonly scopeVersion: 0;
  readonly stateVersion: number;
  readonly resumed: boolean;
}

/**
 * 「会话即 intake」的输入。
 *
 * `dshSessionId` **由服务端从执行身份填写**（`exec.agent.sessionId`），不接受模型传值——
 * 与其余 Worker 工具同一条纪律（§4.2：不在 Agent prompt 中暴露内部标识）。
 *
 * 其余字段都是**人类在对话里已经说过的内容**，由 Agent 归纳后填入；全部可选：
 * 一个信息都还没收集到时也可以先建作业，Agent 随后追问。
 */
export interface BootstrapIntakeInput {
  readonly dshSessionId: string;
  readonly operatorId: string;
  /** 目标说明；省略即由服务端按会话标识派生一个占位名。 */
  readonly name?: string;
}

export interface BootstrapIntakeResult {
  readonly engagementId: string;
  readonly workerSessionId: string;
  readonly dshSessionId: string;
  readonly leaseId: string;
  readonly leaseGeneration: number;
  readonly scopeVersion: 0;
  /** 复用既有绑定（同一会话第二次调用）时为 true。 */
  readonly resumed: boolean;
  /**
   * 人类接下来要做的事，**直接可读**。
   *
   * 工具结果会被模型原样转述给人类，因此这里写的是「人该做什么」，
   * 而不是「服务做了什么」——后者对它没有用。
   */
  readonly nextStep: string;
}

export interface ScopeProposal {
  readonly id: string;
  readonly engagementId: string;
  readonly workerSessionId: string;
  readonly objective: string;
  readonly targets: readonly ScopeTarget[];
  readonly exclusions: readonly ScopeTarget[];
  readonly allowedActions: readonly ActionClass[];
  readonly authorizationNote: string;
  readonly status: 'pending' | 'confirmed' | 'rejected' | 'superseded';
  readonly createdAt: string;
  readonly decidedAt: string | null;
}

export interface RequestScopeConfirmationInput {
  readonly workerSessionId: string;
  readonly objective: string;
  readonly targets: readonly ScopeTarget[];
  readonly exclusions: readonly ScopeTarget[];
  readonly allowedActions: readonly ActionClass[];
  readonly authorizationNote: string;
}

/**
 * 会话状态查询的输入（`conversation.chat.turnTail` 的「待你确认」卡片用它）。
 *
 * 传的是 **dsh 会话标识**而不是 engagement：人类在聊天里看到的只有会话，
 * 服务端负责把它反查到作业（与 `resolveWorkerSessionId` 同一条反查路径）。
 */
export interface IntakeStatusInput {
  readonly dshSessionId: string;
}

/**
 * 一个会话当前需要人类做的事。
 *
 * 存在的理由：Agent 在聊天里说「请到控制台确认」时，人类所在的界面**必须有可点的选项**——
 * 否则「人类闸门」就退化成「自己去找入口」。这个结构把待确认的事实与计数一次性交给界面。
 */
export interface IntakeStatus {
  /** 该 dsh 会话绑定的作业；未绑定时为 null（此时界面不画任何东西）。 */
  readonly engagementId: string | null;
  readonly engagementName: string | null;
  readonly workerSessionId: string | null;
  readonly sessionKind: SessionKind | null;
  readonly mainStatus: MainStatus | null;
  /** 待人类确认的范围方案；没有则为 null。 */
  readonly pendingProposal: ScopeProposal | null;
  /** 待人类处理的放行凭证数（§10.3.1 的放行队列）。 */
  readonly pendingApprovalCount: number;

  /**
   * 该作业当前的 `state_version`——聊天卡片的确认/驳回要用它做乐观锁。
   *
   * **必须由服务端一起给**：卡片用的控制器是**会话级**的，它从没 `select()` 过作业，
   * `snapshot.state` 恒为空；缺这个字段，卡片只能发 0，而那是必然失败
   * （实测：期望 0、实际 1，人类点了「确认」只看到「请刷新后重试」）。
   */
  readonly stateVersion: number;
}

export interface ConfirmScopeProposalInput extends HumanActor {
  readonly engagementId: string;
  readonly proposalId: string;
  readonly objective: string;
  readonly targets: readonly ScopeTarget[];
  readonly exclusions: readonly ScopeTarget[];
  readonly allowedActions: readonly ActionClass[];
  readonly authorizationNote: string;
  readonly authorizationExpiresAt?: string;
  readonly taskPrompt?: string;
  readonly scopeEntryProfile?: ScopeEntryProfile;
  /** 行为预设：**必选项**（显式给出，或沿用该作业创建时人类选定的那一档）。 */
  readonly behaviorProfile: BehaviorProfile;
  /** `custom` 预设的自定义指引（只有 custom 接受它）。 */
  readonly customGuidance?: string;
  /** 审批模式：**必选项**（显式给出，或沿用该作业创建时人类选定的那一档）。 */
  readonly approvalMode: ApprovalMode;
  readonly policyOverrides?: Readonly<Record<string, unknown>>;
  /** 规则与时间窗：省略即按「空」冻结（会被哈希覆盖，因此必须显式可选而不是悄悄丢弃）。 */
  readonly roe?: Readonly<Record<string, unknown>>;
  readonly timeWindow?: Readonly<Record<string, unknown>>;
}

/**
 * 策略预览输入：与 `confirmScopeProposal` 的范围/策略字段**逐字对齐**，但不写库。
 *
 * 存在的理由（§6.2.0.5）：人类要确认的是「服务端最终冻结了什么」，而不是 Agent 写的提案文本。
 * 预览与确认必须同源——因此这个输入刻意与确认输入同名同义，任何一侧新增字段都必须同步，
 * 否则预览会开始"说谎"。
 */
export interface PolicyPreviewInput {
  readonly engagementId: string;
  /**
   * 待确认的提案（若来自 session-first 流程）。
   *
   * 给出时预览会一并校验它的状态：提案已被别人处理过、或不属于该作业时，
   * 预览必须**拦下**——否则人类会对着一个已经失效的提案点确认（两个标签页的典型情形）。
   */
  readonly proposalId?: string;
  readonly targets: readonly ScopeTarget[];
  readonly exclusions: readonly ScopeTarget[];
  readonly scopeEntryProfile?: ScopeEntryProfile;
  /** 省略即沿用该作业当前预设；缺预设且作业行也没有时，预览**必须**给出 blocker（与确认同源）。 */
  readonly behaviorProfile?: BehaviorProfile;
  /** `custom` 预设的自定义指引（只有 custom 接受它）。 */
  readonly customGuidance?: string;
  /** 审批模式：省略即沿用作业当前值；缺值且作业行也没有时，预览必须给出 blocker（与确认同源）。 */
  readonly approvalMode?: ApprovalMode;
  readonly policyOverrides?: Readonly<Record<string, unknown>>;
  /** 与确认同义：需要逐次放行的动作类别（进入策略快照）。 */
  readonly allowedActions?: readonly ActionClass[];
  readonly authorizationRef?: string;
  readonly authorizationExpiresAt?: string;
  readonly roe?: Readonly<Record<string, unknown>>;
  readonly timeWindow?: Readonly<Record<string, unknown>>;
}

/**
 * 服务端预览（§6.2.0.5 的「最终预览」）。
 *
 * 它是**只读**的：不写库、不推进版本，因此可以反复刷新；但里面的 `snapshotHash`
 * 与版本号必须是「现在点确认就会写入」的那一组值——否则预览就是另一种事实。
 */
export interface PolicyPreview {
  /** 有 blocker 时为 false：界面必须据此禁用确认按钮。 */
  readonly ok: boolean;
  /** 人类可读的拦截原因（范围非法、域名解析不到地址、预设不合法……）。 */
  readonly blockers: readonly string[];
  readonly scopeEntryProfile: ScopeEntryProfile;
  readonly behaviorProfile: BehaviorProfile;
  readonly approvalMode: ApprovalMode;
  /** 规范化后的目标与排除项（逐行结论，含稳定键与端口语义）。 */
  readonly targets: readonly ScopePreviewEntry[];
  readonly exclusions: readonly ScopePreviewEntry[];
  /**
   * 服务端地址裁决结果：主机 → 已裁决地址。
   *
   * 这是「主动动作会拨到哪个地址」的服务端事实（§10.2.2 地址固定）；
   * 空数组表示解析不到——那种目标在受理时会被 `dns_unresolved` 拒绝。
   */
  readonly resolvedAddresses: Readonly<Record<string, readonly string[]>>;
  readonly pacing: {
    readonly rate: number;
    readonly concurrency: number;
    readonly jitter: number;
    readonly burst: number;
    readonly retry: number;
  };
  /** 展开后的动作权限：启用、禁用、逐动作放行、以及默认禁用类别与是否已二次确认。 */
  readonly enabledActionClasses: readonly ActionClass[];
  readonly disabledActionClasses: readonly ActionClass[];
  readonly perActionApprovalClasses: readonly ActionClass[];
  readonly enabledDisabledClasses: readonly ActionClass[];
  readonly dualConfirmed: boolean;
  readonly credentialMode: string;
  readonly stopConditions: readonly string[];
  /** 将进入哈希的完整约束（授权引用、到期、RoE、时间窗、预算、凭据模式）。 */
  readonly executionConstraints: Readonly<Record<string, unknown>>;
  /** 确认后写入的版本与 epoch 现值（供界面写出「将产生 范围 v2 / 策略 v3，epoch 1→2」）。 */
  readonly nextScopeVersion: number;
  readonly nextPolicyVersion: number;
  readonly currentPolicyEpoch: number;
  /**
   * 本次确认之后的策略 epoch。
   *
   * 首次确认**不推进** epoch：确认之前没有任何在途动作与放行凭证可以撤销，
   * 递增它只会造出一个没有对应事实的数字。界面必须显示服务端给的这两个值，
   * 而不是自己写 `current + 1`（那会展示一个不会发生的推进）。
   */
  readonly nextPolicyEpoch: number;
  /** 与确认写入的 `policy_snapshot_hash` 完全相同的那一个值。 */
  readonly snapshotHash: string;
}

export interface ConfirmedScopeProposal extends StartedWorker {
  readonly engagementId: string;
  readonly scopeVersion: number;
  readonly stateVersion: number;
  readonly sessionKind: 'phase';
}

export interface RejectScopeProposalInput extends HumanActor {
  readonly engagementId: string;
  readonly proposalId: string;
}


export interface WorkerReportInput {
  readonly status: 'report_ready' | 'blocked';
  readonly objective: string;
  readonly summary: string;
  readonly statusNote?: string;
  readonly payload: unknown;
}

export interface HandoffDraftRequest {
  readonly workerSessionId: string;
  /**
   * 目标阶段。**省略时由服务端按状态机的推荐推进给出下一阶段**——人类说「进入下一阶段」
   * 时不必（也不该）回答「哪个阶段」：阶段是预设状态机，下一阶段由当前阶段唯一确定。
   * 只有回补/回滚/跳级这类**强制移动**才需要显式给出，而那要人类显式确认（§5.3）。
   */
  readonly suggestedToPhase?: Phase;
  /**
   * 请求者（§9.5 的归因）。
   *
   * 由**传输层**注入（控制台 RPC 的 `CallContext.operatorId`），不接受请求体里的
   * 普通参数；缺失时落到 `system:dsh-pentest`，绝不写死 `console`
   * ——写死会让审计无法回答「是谁要求生成这份草稿的」。
   */
  readonly operatorId?: string;
}

export interface ContextRef {
  /** 形如 `memory:<分块标识>`（契约里就是带前缀的引用形式）。 */
  readonly memoryId: string;
  /** Agent 给出的选用理由——人类审计时要看的第一件东西。 */
  readonly reason: string;
  /**
   * 以下三个字段由**服务端**在草稿生成后补齐（Agent 只提案 id 与理由）。
   *
   * 为什么不让 Agent 自己声明：可信度是审计信号，由被审计方自报就没有意义了。
   * 设计 §8.10：压缩摘要属于「Agent 陈述」，**不得继承**原始工具观测的可信度——
   * 这条规则只有在界面把两者并排显示出来时才真正生效。
   */
  readonly kind?: string | null;
  /** 来源可信度：`tool_observation`（工具观测）/ `agent_statement`（Agent 陈述）等。 */
  readonly trust?: string | null;
  readonly provisional?: boolean;
}

/**
 * 交接包里**引用条数**的上限（设计 §8.10.1「被截断的引用写入交接包」）。
 *
 * 放在契约层而不是 `workflow/handoff.ts`：控制台要在人类**点确认之前**就告诉他
 * 「超出预算的部分不会随交接包带过去」。那个模块 import 了 node:crypto，进不了浏览器包。
 */
export const HANDOFF_MAX_CONTEXT_REFS = 50;

/**
 * 起草交接时**自动带入**的引用条数上限（2026-10-07）。
 *
 * 背景：18 次真实交接里 `contextRefs` 全是空数组——不是代理不用（它自己 `memory_search`
 * 搜了 77 次），而是**从来没人往里放**。引用编辑器撤下后，人类那条补充路径也没了，
 * 因此由起草者自动带上一小组（新→旧的上一阶段记忆条目）。保守取值的理由：引用是给
 * 下一阶段"按需取回"的线索，条数多了只是噪声；而且人类不再能逐条剔除。
 */
export const HANDOFF_AUTO_CONTEXT_REFS = 5;

/** 「上一阶段要点」里报告摘要的截断上限（便签另有 `DEFAULTS.statusNoteMaxChars`）。 */
export const HANDOFF_REPORT_SUMMARY_MAX_CHARS = 1200;

/**
 * 交接压缩（用会话当前模型把上一阶段材料压成一段要点）的输出上限。
 * 上限存在的理由同提示词预算：注入文本是硬约束，模型经常无视长度要求。
 */
export const COMPRESSION_MAX_CHARS = 2500;

/** 交接压缩的单次调用超时（毫秒）。起草是人点出来的动作 —— 超时就退回现有拼接，不让人干等。 */
export const COMPRESSION_TIMEOUT_MS = 30_000;

/** 参与压缩的「近期过程」条数与单条截断（只取最近若干条，避免把整本账本塞进一次调用）。 */
export const COMPRESSION_RECENT_EVENTS = 40;
export const COMPRESSION_RECENT_EVENT_MAX_CHARS = 600;

/**
 * 公共记忆的长度上限（字符）。
 *
 * 放在契约层而不是 `workflow/model.ts`：客户端面板要在**提交之前**就用同一个数拦一次，
 * 两侧各写一份必然漂移（实测：客户端曾用 8000 拦住服务端已放宽的值，注释声称的
 * 「提前拦」变成过度拦截）。服务端在创建与更新两个入口都用它。
 */
export const PUBLIC_MEMORY_MAX_CHARS = 8000;

export interface HandoffDraft {
  readonly draftId: string;
  readonly fromWorkerSessionId: string;
  readonly fromPhase: Phase;
  readonly suggestedToPhase: Phase;
  readonly objective: string;
  readonly prompt: string;
  readonly suggestedSkillIds: readonly string[];
  readonly contextRefs: readonly ContextRef[];
  readonly excludedRefs: readonly string[];
  /**
   * Agent 的工具能力建议（§7.2 `tool_capability_suggestion`）。
   *
   * 与 `approvedToolAllow` / `approvedApprovalRequired` 是「候选」与「人类确认」的关系。
   */
  readonly toolCapabilitySuggestion: {
    readonly allowed: readonly string[];
    readonly approvalRequired: readonly ActionClass[];
  };
  readonly limitations: readonly string[];
  readonly revision: number;
  /**
   * 草稿内容哈希（§6.5「显示内容哈希」）：服务端对**落库的 `draft_json`** 取的真摘要。
   *
   * 客户端**不自己算**这个值：草稿一旦被服务端重新生成（`beginHandoff`），哈希随之改变，
   * 客户端手里的副本算出来的会与库里那一份不一致。人类在确认页看到的必须是
   * **权威来源**的那个值，因此由读端点带回（REQ-9）。
   */
  readonly contentHash: string;
}
export interface HandoffEdit {
  readonly draftId: string;
  /** 客户端读取到的草稿修订号；保存必须基于该版本，避免并发覆盖。 */
  readonly expectedRevision: number;
  /** 下一任务的目标（人类可改）。 */
  readonly objective: string;
  readonly approvedToPhase: Phase;
  readonly approvedPrompt: string;
  readonly approvedSkillIds: readonly string[];
  readonly approvedToolAllow: readonly string[];
  readonly approvedApprovalRequired: readonly ActionClass[];
  readonly contextRefs: readonly ContextRef[];
  /** 人类明确排除的引用；不得注入下一 Agent。 */
  readonly excludedRefs?: readonly string[];
}

export interface HumanCancel extends HumanActor {
  readonly engagementId: string;
}

export interface ScopeAmendment extends HumanActor {
  readonly engagementId: string;
  readonly targets: readonly ScopeTarget[];
  readonly exclusions: readonly ScopeTarget[];
  readonly authorizationRef: string | null;
  readonly decisions: readonly AssetScopeDecision[];
}

export interface AssetScopeDecision {
  readonly assetId: string;
  readonly decision: ScopeDecision;
}

export interface ScopeVersionRef {
  readonly engagementId: string;
  readonly version: number;
  readonly contentHash: string;
  /** 本次修订产生的策略版本（§6.2.0.5：范围是策略快照的一部分）。 */
  readonly policyVersion: number;
  /** 提交后被实际终止的在途动作数（§10.3.1；按旧 epoch 签发）。 */
  readonly aborted: number;
}

export interface Interjection {
  readonly workerSessionId: string;
  readonly message: string;
  readonly operatorId?: string;
  /**
   * 人类读到的那一版状态。**必填**——插话是投进模型上下文的消息，重放或双击会把
   * 同一条指令送进会话两次（对模型可见的副作用），因此它必须和别的写操作一样带锚点。
   *
   * 此前这个字段不存在：控制台端点的 `lock` 是 `envelope`，本层的注释自己写着
   * 「这是服务契约的缺口」——信封要求携带版本，但输入里没有它，服务只能在内部自取
   * 当前版本，于是比对必然通过。现在补齐：`lock: 'actor'`、两条路径都消费它。
   */
  readonly expectedStateVersion: number;
}

export interface InterjectionResult {
  readonly delivered: boolean;
  readonly transitionType: 'interject_wake' | 'none';
  readonly stateVersion: number;
}

export interface BudgetExtension extends HumanActor {
  readonly workerSessionId: string;
  readonly additionalTokens?: number;
  readonly additionalSteps?: number;
  readonly additionalSeconds?: number;
}

export interface BudgetLimits {
  readonly maxTokens: number;
  readonly maxSteps: number;
  readonly maxSeconds: number;
}

export interface HumanApprovalDecision {
  readonly approvalId: string;
  readonly operatorId: string;
  readonly decision: 'approved' | 'rejected';
  readonly reason: string;
  /** 修改后放行时的新计划；服务端必须重新验证，不能接受自由命令文本。 */
  readonly modifiedCommandPlan?: unknown;
}

/** 原审批绑定上下文；验证器据此重新裁决修改计划。 */
interface ApprovalPlanValidationContext {
  readonly approvalId: string;
  readonly engagementId: string;
  readonly workerSessionId: string | null;
  readonly actionClass: ActionClass;
  readonly originalPlanHash: string;
  readonly originalCommandPlan: unknown;
  readonly originalTargetSnapshot: unknown;
  readonly scopeVersion: number | null;
  readonly policyEpoch: number | null;
  readonly leaseGeneration: number | null;
}

/** 受信验证器返回的完整、可持久化审批计划；command 只能由服务端模板生成。 */
export interface ValidatedApprovalPlan {
  readonly templateId: string;
  readonly targetSelector: string;
  readonly params: Readonly<Record<string, string | number>>;
  readonly actionClass: ActionClass;
  readonly normalizedTarget: string;
  readonly normalizedCommand: string;
  readonly targetSnapshot: unknown;
  readonly planHash: string;
  readonly scopeVersion: number;
  readonly policyEpoch: number;
  readonly leaseGeneration: number;
  readonly timeoutMs: number;
  readonly maxOutputBytes: number;
  readonly purpose: string;
  readonly riskSummary: string;
}

/** 修改计划验证端口；缺失时修改请求必须 fail closed。 */
export interface ApprovalPlanValidator {
  validate(
    context: ApprovalPlanValidationContext,
    modifiedCommandPlan: unknown,
  ): Promise<ValidatedApprovalPlan | undefined>;
}

export interface HumanApprovalRevocation {
  readonly approvalId: string;
  readonly operatorId: string;
  readonly reason: string;
}

export interface ApprovalRecord {
  readonly id: string;
  readonly workerSessionId: string;
  readonly actionClass: ActionClass;
  readonly planHash: string;
  /** 凭证只对申请时的租约世代有效；缺失记录按不匹配处理。 */
  readonly leaseGeneration: number | null;
  readonly decision: ApprovalDecision;
  readonly expiresAt: Date;
  readonly consumedAt: Date | null;
  /**
   * 决策**送达 Agent 会话**是否成功（缺省=未尝试/不适用）。
   *
   * 凭证在通知之前就已生效，所以投递失败≠决策失败；但"点了批准没反应"恰恰就是这么来的
   * （宿主重启过，旧 dsh 会话不属于当前进程）。控制台据此当场告警。
   */
  readonly noticeDelivered?: boolean;
}

export interface TransitionConfirmation extends HumanActor {
  readonly engagementId: string;
  readonly draftId: string;
  /** 跨出推荐路径时必须为 true，且 reason 非空。 */
  readonly forced: boolean;
  /** 强制跳转的独立二次确认；不能复用 forced 选择本身。 */
  readonly forcedAcknowledged: boolean;
  readonly objective: string;
  readonly approvedToPhase: Phase;
  readonly approvedPrompt: string;
  /** 人类决定排除的引用（§7.2 `excluded_refs`）。 */
  readonly excludedRefs: readonly string[];
  readonly approvedSkillIds: readonly string[];
  readonly approvedToolAllow: readonly string[];
  readonly approvedApprovalRequired: readonly ActionClass[];
  readonly contextRefs: readonly ContextRef[];
}

export interface RetryRequest extends HumanActor {
  readonly engagementId: string;
  readonly taskPrompt: string;
  /** 默认 true：复用当前会话（保留推理链与前缀缓存）。 */
  readonly reuseSession: boolean;
  readonly contextRefs?: readonly ContextRef[];
}

export interface TransitionResult {
  readonly transitionType: TransitionType;
  readonly stateVersion: number;
  readonly graphIteration: number;
  readonly scopeVersion: number;
  readonly workerSessionId: string | null;
  readonly sessionReused: boolean;
}

export interface HumanReopen extends HumanActor {
  readonly engagementId: string;
}

export interface HumanPause extends HumanActor {
  readonly engagementId: string;
}

export interface HumanResume extends HumanActor {
  readonly engagementId: string;
}

export interface HumanAbort extends HumanActor {
  readonly engagementId: string;
}

export interface HumanFinishTesting extends HumanActor {
  readonly engagementId: string;
}

export interface ReportDraft {
  readonly engagementId: string;
  readonly version: number;
  readonly content: string;
  /**
   * 该报告版本的权威内容哈希（`pentest.reports.content_hash`）；无版本行时为 `null`。
   *
   * ── 为什么它必须在草稿上 ──
   *
   * §8.9 的签字以内容哈希为准，服务端把它记进 `human_decisions.subject_id`；
   * 而 `reports` 表的设计是「版本只追加，**旧版可被签字哈希追溯**」
   * （`pg-report.ts` 的 `SQL_INSERT_REPORT` 注释）。因此签字用的哈希必须是**报告版本**
   * 的哈希，而不是某次**导出产物**的哈希——同一个版本导出 markdown 与 json 会得到两个
   * 不同的哈希，用后者做 `subject_id` 会让审计指不到被审阅的那一版。
   *
   * 这个字段此前缺失，于是控制台把「最近一次导出的哈希」当成了签字依据；
   * `ReportExport` 里那句「与签字用的哈希比对：不一致说明导出的是另一个版本」也因此
   * 永远比对自己。补上它之后，两处哈希各归其位：草稿给签字，导出结果给核对。
   */
  readonly contentHash: string | null;
}

// ───────────────────────────── 报告服务（§8.9、§16.1.1） ─────────────────────────────

export const FINDING_STATUSES = [
  'candidate',
  'validation_pending',
  'validated',
  'rejected',
  'human_accepted',
  'superseded',
] as const;
export type FindingStatus = (typeof FINDING_STATUSES)[number];

export const SEVERITIES = ['critical', 'high', 'medium', 'low', 'info'] as const;
export type Severity = (typeof SEVERITIES)[number];

export interface Finding {
  readonly id: string;
  readonly engagementId: string;
  readonly title: string;
  readonly severity: Severity | null;
  readonly status: FindingStatus;
  readonly affectedAssetIds: readonly string[];
  readonly evidenceRefs: readonly string[];
  readonly reproductionSteps: readonly string[];
  readonly impact: string | null;
  readonly remediation: string | null;
  readonly confidence: number | null;
  readonly acceptedBy: string | null;
  readonly acceptedAt: string | null;
}

/**
 * 结论处置（§8.9 的三选一）。
 *
 * - `accept`：状态转 `human_accepted`，进报告的「已验证结论」一节
 * - `reject`：状态转 `rejected`，进「已评估但不成立」一节，**保留证据引用**
 * - `defer`：状态不变，进「未验证候选」一节并标注未经确认
 *
 * 严重度由人确认：`severity` 给出时覆盖 Agent 的建议值——模型不能单方面定风险等级。
 */
export interface FindingDisposition {
  readonly findingId: string;
  readonly operatorId: string;
  readonly action: 'accept' | 'reject' | 'defer';
  /** 不接受/暂缓时必填；接受时可选。 */
  readonly reason: string;
  /** 人工确认后的严重度；省略则保留原值。 */
  readonly severity?: Severity;
}

export interface ReportEdit {
  readonly engagementId: string;
  readonly operatorId: string;
  readonly expectedStateVersion: number;
  /** 人类编辑后的报告正文。 */
  readonly editedContent: string;
}

export interface RedactionRequest {
  readonly engagementId: string;
  /** 需要脱敏的字段类别（按分类字段过滤：credential-like / secret-like 等）。 */
  readonly classifications: readonly Classification[];
}

export interface ReportPreview {
  readonly engagementId: string;
  readonly content: string;
  readonly redactedCount: number;
}

export interface ExportRequest {
  readonly engagementId: string;
  readonly format: 'markdown' | 'json';
  readonly operatorId: string;
}

export interface ExportResult {
  readonly fileName: string;
  readonly mediaType: string;
  readonly byteSize: number;
  readonly contentHash: string;
  /** 导出内容的内联文本（大文件时应改为证据引用）。 */
  readonly content: string;
}

/** 报告分节——决定每条结论进报告的哪一部分（§8.9 的映射）。 */
export const REPORT_SECTIONS = [
  'verified_findings',
  'assessed_not_confirmed',
  'unverified_candidates',
  'awaiting_review',
] as const;
export type ReportSection = (typeof REPORT_SECTIONS)[number];

export interface PentestReportService {
  /** 生成报告草稿（投影，不创建 Agent）。 */
  getReportDraft(engagementId: string): Promise<ReportDraft>;
  /**
   * 列出该 engagement 的全部结论（报告审阅页的逐条处置列表）。
   *
   * 与 `listUndisposed` 是「全集 vs 子集」：审阅页要按四类分节展示全部结论
   * （含已接受、已拒绝、被取代），而签字前置只关心未处置的那些。
   */
  listFindings(engagementId: string): Promise<readonly Finding[]>;
  /** 处置一条结论。返回处置后的结论。 */
  dispositionFinding(input: FindingDisposition): Promise<Finding>;
  /** 保存人类编辑后的报告正文。 */
  updateReport(input: ReportEdit): Promise<ReportVersionRef>;
  /** 脱敏预览。 */
  redactPreview(input: RedactionRequest): Promise<ReportPreview>;
  /** 导出。签字前也允许导出（供人工审阅）。 */
  exportReport(input: ExportRequest): Promise<ExportResult>;
  /**
   * 签名前置条件检查：是否还有未处置的候选结论。
   *
   * §8.9：「签字前置条件是所有候选结论都已给出处置，不允许带着未处置条目出报告」。
   */
  listUndisposed(engagementId: string): Promise<readonly Finding[]>;
}

/**
 * 工作流内部使用的报告签字读面，不注册为控制台 RPC。
 *
 * 它单独存在是为了避免把事务协调原语暴露成报告端点；实现与工作流必须共享同一
 * `txDb` 对应的 `DbTransactionRunner`，这样调用发生在工作流事务内时会重入当前事务。
 */
export interface ReportSignatureService {
  /** 在 engagement advisory lock 内读取最新报告版本与未处置结论。 */
  getSignatureSnapshot(engagementId: string): Promise<ReportSignatureSnapshot>;
  /** 在同一报告锁内把已核对的版本标记为已签字。 */
  signReportVersion(input: {
    readonly engagementId: string;
    readonly version: number;
    readonly contentHash: string;
    readonly operatorId: string;
  }): Promise<ReportVersionRef>;
}

export interface ReportSignatureSnapshot {
  readonly report: ReportVersionRef | null;
  readonly undisposed: readonly Finding[];
}
// ───────────────────────────── 记忆检索面（§8.7） ─────────────────────────────

/**
 * 控制台与 Worker 共用的记忆检索面。
 *
 * 与 `MemoryLedgerService`（只追加的写入面）分开：那个面服务审计与哈希链，
 * 这个面服务「按语义取回带引用的片段」。两者的失败语义完全不同——写失败必须
 * 阻断动作（§15.1），读失败只是本次检索没结果。
 */
export interface PentestMemoryQueryService {
  /** 混合检索（§8.6）。返回带来源与可信度标注的片段。 */
  searchMemory(input: MemorySearchRequest): Promise<MemorySearchResultSet>;
  /** 按标识读取完整内容（§8.7）。读取原文会写入访问审计。 */
  readMemory(input: MemoryReadRequest): Promise<readonly MemoryRecord[]>;
  /** 索引水位与滞后量（§8.4）。 */
  memoryWatermark(engagementId: string): Promise<MemoryWatermark>;
  /**
   * 校验事件账本完整性（§8.4 链校验 + 锚点核对）。只读，不写访问审计。
   *
   * 追加写与读取只能证明「读得到」，不能证明「没被动过」；这个面把「链自洽」与
   * 「与锚点一致」两件事交给人工按需核验（P7 可回放的证据根）。
   */
  verifyLedger(engagementId: string): Promise<LedgerVerificationView>;
}

export interface MemorySearchRequest {
  readonly engagementId: string;
  readonly query: string;
  /** 限定阶段；省略即全部。 */
  readonly phase?: Phase | null;
  readonly kinds?: readonly string[];
  readonly trustLevels?: readonly TrustLevel[];
  readonly assetIds?: readonly string[];
  /**
   * 筛选开关，**不是权限门禁**（§8.3）：思考链对本 engagement 全部 Worker 开放。
   * 不传时思考链与其他类型一同参与检索；传 `false` 表示本次只要非思考链条目。
   */
  readonly includeReasoning?: boolean;
  readonly limit?: number;
  /**
   * 检索发起者（§9.5 的访问归因）。
   *
   * 由**传输层**注入：控制台走 `CallContext.operatorId`（RPC 方法表 `operator: true`），
   * Worker 走会话标识。绝不接受请求体里的普通参数，也不使用固定值 `console`。
   */
  readonly operatorId?: string;
  /** 检索理由：可选（检索本身不改变任何事实），但填了就原样落访问审计。 */
  readonly reason?: string;
}

export interface MemorySearchHit {
  readonly memoryId: string;
  readonly excerpt: string;
  readonly score: number;
  readonly kind: string;
  readonly trustLevel: TrustLevel;
  readonly phase: Phase | null;
  readonly workerSessionId: string | null;
  readonly occurredAt: string;
  readonly citation: string;
  /** 命中来自模型推理时的提示文案（§8.3 要求标注「不等同于事实」）。 */
  readonly reasoningNote?: string;
}

export interface MemorySearchResultSet {
  readonly hits: readonly MemorySearchHit[];
  /** 索引水位：结果可能遗漏尚未索引的事件（§8.4）。 */
  readonly watermark: MemoryWatermark;
}

export interface MemoryReadRequest {
  readonly engagementId: string;
  readonly refs: readonly string[];
  /** 读取理由，写入访问审计（§8.3 的「每次读取记入访问审计」）。 */
  readonly operatorId?: string;
  readonly reason: string;
}

export interface MemoryRecord {
  readonly memoryId: string;
  readonly content: string;
  readonly kind: string;
  readonly trustLevel: TrustLevel;
  readonly classification: Classification;
  readonly occurredAt: string;
  readonly contentHash: string;
  readonly sourceRefs: readonly string[];
}

export interface MemoryWatermark {
  readonly lastChainSeq: number;
  readonly occurredAt: string | null;
  readonly status: 'ready' | 'lagging' | 'failed';
  readonly detail: string | null;
  /** 与账本链头之差，即「可能遗漏多少条」。 */
  readonly lagEvents: number;
}

/**
 * 账本完整性校验结果（人工触发的只读报告）。
 *
 * 三种失败必须分开呈现，因为含义与处置都不同：
 *   - `failures` 非空：链内哈希/序号不自洽（行被改过或插入过）；
 *   - `anchored === false`：没有锚点可比——**不等于**「没被改」，而是「无法证明未被截断」；
 *   - `mismatches` 非空：实时链与最近锚点不一致（典型是尾部截断）。
 * `ok` 覆盖三者：只有「链自洽 **且** 有锚点且与锚点一致」才为真。
 */
export interface LedgerVerificationView {
  readonly engagementId: string;
  readonly ok: boolean;
  readonly eventCount: number;
  readonly chainHead: string;
  readonly failures: readonly LedgerChainFailureView[];
  readonly anchored: boolean;
  readonly mismatches: readonly string[];
  readonly checkedAt: string;
}

interface LedgerChainFailureView {
  readonly chainSeq: number;
  readonly detail: string;
}

// ───────────────────────────── 诊断面（§8.4/§15.1/§15.5） ─────────────────────────────

/**
 * 诊断快照：回答「现在到底是什么在卡」。
 *
 * ── 为什么需要它 ──
 *
 * 长期运行的实例出问题时，「卡住」的形态有很多种：审计写不进去、索引队列积压、
 * 连接池耗尽、水位滞后。没有统一视图时只能翻日志与手写 SQL——而每种形态的处置
 * 完全不同。这里把实例级事实（连接池、审计探针）与作业级事实（索引队列、水位）
 * 放进同一张只读快照。
 *
 * `audit` 为 `null` 表示本实例未装配审计探针；`engagement` 为 `null` 表示未选作业
 * （没有可诊断的队列与水位）——两种 null 含义不同，界面必须分开说（P16）。
 */
export interface DiagnosticsSnapshot {
  readonly checkedAt: string;
  /** 读写共用的连接池。`waiting > 0` 说明池已耗尽，动作会在取连接处排队。 */
  readonly pool: { readonly total: number; readonly idle: number; readonly waiting: number };
  /** 审计写入探针（§15.1 闸门的依据）。null = 本实例未装配。 */
  readonly audit: { readonly writable: boolean; readonly detail: string } | null;
  readonly engagement: EngagementDiagnostics | null;
}

export interface EngagementDiagnostics {
  readonly engagementId: string;
  /** 索引任务队列（§15.5）。`dead > 0` 即「索引失败」，需人工处置。 */
  readonly indexQueue: {
    readonly pending: number;
    readonly leased: number;
    readonly done: number;
    readonly dead: number;
    readonly lagState: 'ready' | 'lagging' | 'failed';
    /** 最早可领取时间（滞后起点）；队列为空时为 null。 */
    readonly oldestPendingAt: string | null;
  };
  /** 索引水位（§8.4）：与账本链头之差即「可能遗漏多少条」。 */
  readonly watermark: MemoryWatermark;
}

/** 诊断面：只读、无副作用；不写审计（它不改变任何事实，也不读取记忆正文）。 */
export interface PentestDiagnosticsService {
  getDiagnostics(input: { readonly engagementId?: string | null }): Promise<DiagnosticsSnapshot>;
}

// ───────────────────────────── 技能面（§2.2） ─────────────────────────────

/**
 * skill 库：可添加、可选择、可为空（§2.2）。
 *
 * 它是**全局库**而非 engagement 局部：同一份 skill 可被任意阶段的 Agent 装载。
 * 因此这个面没有 `engagementId` 参数——但 `add`/`update`/`remove` 仍要求操作者
 * 与理由，因为 skill 正文是 Agent 会遵循的**指令文本**，改动它等于改动 Agent 行为。
 */
export interface PentestSkillService {
  listSkills(input?: SkillListRequest): Promise<readonly SkillSummary[]>;
  addSkill(input: SkillAddRequest): Promise<SkillSummary>;
  updateSkill(input: SkillUpdateRequest): Promise<SkillSummary>;
  removeSkill(input: SkillRemoveRequest): Promise<void>;
}

export interface SkillListRequest {
  /** 只返回启用的（省略即全部）。 */
  readonly enabledOnly?: boolean;
}

export interface SkillSummary {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  /** 正文是 Agent 会遵循的指令文本，因此列表也返回它供人类核对。 */
  readonly body: string;
  readonly revision: number;
  readonly disabled: boolean;
  readonly contentHash: string;
  readonly addedBy: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface SkillAddRequest {
  readonly operatorId: string;
  readonly reason: string;
  readonly name: string;
  readonly description: string;
  readonly body: string;
}

export interface SkillUpdateRequest {
  readonly operatorId: string;
  readonly reason: string;
  readonly skillId: string;
  readonly name?: string;
  readonly description?: string;
  readonly body?: string;
  readonly disabled?: boolean;
}

export interface SkillRemoveRequest {
  readonly operatorId: string;
  readonly reason: string;
  readonly skillId: string;
}

export interface HumanReportSignature {
  readonly engagementId: string;
  readonly operatorId: string;
  readonly expectedStateVersion: number;
  readonly contentHash: string;
}

export interface ReportVersionRef {
  readonly engagementId: string;
  readonly version: number;
  readonly contentHash: string;
}

// ───────────────────────────── 系统发起的运行标记变更 ─────────────────────────────

/**
 * 系统自动暂停的起因。
 *
 * 列成枚举而不是自由文本：这两处是**设计里唯二的系统暂停**（§10.2.2 的范围违规阈值、
 * §10.5 的预算硬阈值），而事后审计要能一眼区分「是哪一个触发的」。
 */
type SystemPauseCause = 'scope_violation_threshold' | 'budget_exhausted';

export interface SystemPauseRequest {
  readonly engagementId: string;
  readonly expectedStateVersion: number;
  readonly cause: SystemPauseCause;
  /** 触发详情（阈值、计数、维度等）——写入决策记录的理由。 */
  readonly detail: string;
}

/**
 * 系统发起的运行标记变更（§10.2.2、§10.5）。
 *
 * **刻意不属于人类操作面**：它不出现在 `HumanWorkflowService` 上，因此
 * **不注册控制台端点**——否则会多出一个「可以冒充系统去暂停」的入口。
 * 只有装配层（`compose.ts`）在检测到阈值时调用它。
 *
 * 与人类 `pause` 分开而不是复用（例如传 `operatorId: 'system'`）：
 * `human_decisions` 要能回答「是谁停的」，混在一起就答不出来；
 * 而且复用会让人类面的每个调用方都能自称系统。
 */
export interface SystemWorkflowService {
  pauseForSystem(input: SystemPauseRequest): Promise<WorkflowSnapshot>;
}

// ───────────────────────────── 执行服务 ─────────────────────────────

/**
 * 服务端受信动作模板（设计文档 §10.2.1）。
 * 动作由模板实例化，不接受自由命令文本；目标只能来自选择器。
 */
export interface ActionTemplate {
  readonly id: string;
  readonly actionClass: ActionClass;
  readonly tool: string;
  /** 允许的参数名与取值范围；未声明的参数一律拒绝。 */
  readonly parameters: readonly TemplateParam[];
  /** 从选择器注入的目标占位符名。 */
  readonly targetPlaceholder: string;
  readonly timeoutMs: number;
  readonly maxOutputBytes: number;
}

export interface TemplateParam {
  readonly name: string;
  readonly kind: 'enum' | 'integer' | 'string';
  readonly values?: readonly string[];
  readonly min?: number;
  readonly max?: number;
  readonly pattern?: string;
}

export interface ActionIntent {
  readonly workerSessionId: string;
  readonly templateId: string;
  readonly targetSelector: string;
  readonly params: Readonly<Record<string, string | number>>;
  readonly purpose: string;
  readonly approvalId?: string;
}

export type AdmissionDecision =
  | { readonly kind: 'admitted'; readonly plan: ExecutionPlan }
  /** 高权限模式：服务端已自行放行，凭证可直接用于执行（人类还没看过这条命令）。 */
  | { readonly kind: 'self_approved'; readonly approvalId: string; readonly planHash: string; readonly plan: ExecutionPlan }
  | { readonly kind: 'needs_approval'; readonly approvalId: string; readonly planHash: string }
  | { readonly kind: 'rejected'; readonly error: ToolError };

export interface ExecutionPlan {
  readonly workerSessionId: string;
  readonly templateId: string;
  readonly actionClass: ActionClass;
  readonly normalizedTarget: string;
  /** 服务端范围解析出的实际拨号地址；执行器不得从未经裁决的目标重新解析。 */
  readonly resolvedAddresses: readonly string[];
  readonly normalizedCommand: string;
  /**
   * 人类可读的命令文本（放行卡与审计展示用）。
   *
   * `normalizedCommand` 是**给容器读的**形态（自由命令里是一串 base64）；人类批准的是
   * 「将要执行什么」，所以展示层用这个字段。缺省即与 `normalizedCommand` 相同——
   * 只有把正文放在 `*_b64` 参数里的模板（`direct_command`）才需要它。
   */
  readonly displayCommand?: string;
  readonly planHash: string;
  readonly idempotencyKey: string;
  readonly scopeVersion: number;
  readonly policyEpoch: number;
  /**
   * 冻结策略的版本号（§6.2.0.5）。
   *
   * 与 `policyEpoch` 是两件事：epoch 是「边界动过」的单调计数器（撤销凭证用），
   * 版本是**哪一份快照**（人类批准的是它）。两者都进计划摘要。
   */
  readonly policyVersion?: number;
  /**
   * 服务端展开的 pacing（§10.2 执行管线）；`null`/缺省表示该会话策略不施加 pacing。
   *
   * 它必须进计划摘要：人类批准的计划里包含「这个动作以什么节奏跑」，
   * 否则「隐蔽性测试」只是一句写在提示词里的愿望。
   */
  readonly pacing?: ActionPacing | null;
  readonly leaseGeneration: number;
  readonly approvalId: string | null;
  readonly timeoutMs: number;
  readonly maxOutputBytes: number;
}

/**
 * 行为预设展开出的执行节奏（§6.2.0.5、§10.2）。
 *
 * 五个维度都由**服务端**产生并冻结进策略快照：速率（每秒动作起始数）、并发、
 * 抖动（每次动作前额外等待的上限，秒）、突发桶容量、重试上限（目前只记录，
 * 执行器不自动重试——自动重试会放大目标侧影响）。
 */
export interface ActionPacing {
  readonly rate: number;
  readonly concurrency: number;
  readonly jitter: number;
  readonly burst: number;
  readonly retry: number;
}

export interface ToolRunResult {
  readonly status: 'completed' | 'timed_out' | 'cancelled' | 'runtime_error' | 'blocked';
  readonly exitCode?: number;
  readonly stdout?: string;
  readonly stderr?: string;
  readonly truncated?: boolean;
  readonly artifactIds?: readonly string[];
  readonly error?: ToolError;
}

export interface ExecutionService {
  admit(input: ActionIntent): Promise<AdmissionDecision>;
  execute(plan: ExecutionPlan, signal: AbortSignal): Promise<ToolRunResult>;
  consumeApproval(approvalId: string, toolRunId: string): Promise<boolean>;
  abortInFlight(engagementId: string, newPolicyEpoch: number): Promise<number>;
}

// ───────────────────────────── 政策服务（只读判定） ─────────────────────────────

export interface PolicyService {
  evaluateScope(input: {
    engagementId: string;
    scopeVersion: number;
    target: string;
    protocol: Protocol;
    port?: number;
  }): Promise<ScopeVerdict>;
  classifyAction(input: { templateId: string; params: Readonly<Record<string, string | number>> }):
    Promise<{ ok: true; actionClass: ActionClass } | { ok: false; code: ErrorCode; detail: string }>;
  validateExecution(plan: ExecutionPlan): Promise<{ ok: true } | { ok: false; error: ToolError }>;
  /**
   * 读该 engagement 的**授权时效**（§11.1）。返回 `{ ok: true, expiresAt: null }` 表示未声明到期。
   *
   * 为什么由策略面提供：授权与范围是同一份快照（建 engagement 时冻结），
   * 而「该不该放行」正是策略面的职责。执行侧（admit 与执行前重裁决）都调这一个入口，
   * 保证两处判定同源——各读一次列会让「受理时未过期、执行时已过期」这类时间差
   * 出现两种实现。
   *
   * 为什么返回裁决而不是 `Date | null`：`Date | null` 无法表达第三种形态——「字段非空但
   * 读不懂」。把它并进 `null` 会让一条改库语句静默移除授权硬边（调用方无从分辨，只能放行）。
   * 因此坏值必须能被调用方看见并拒绝，见 `PgPolicyService` 的 `readExpiry`。
   */
  authorizationValidity(
    engagementId: string,
  ): Promise<{ ok: true; expiresAt: Date | null } | { ok: false; error: ToolError }>;
}

// ───────────────────────────── 事件账本服务 ─────────────────────────────

export interface AppendEventInput {
  readonly engagementId: string;
  readonly workerSessionId: string | null;
  readonly eventType: DomainEventType;
  readonly sourceSystem: string;
  readonly sourceId: string;
  readonly sourceSeq: number;
  readonly occurredAt: Date;
  readonly payload: unknown;
  readonly rawPayload: Uint8Array;
  readonly classification: Classification;
  readonly trustLevel: TrustLevel;
  readonly provisional?: boolean;
}

export interface AppendEventResult {
  readonly eventId: string;
  readonly chainSeq: number;
  readonly eventHash: string;
}

export interface MemoryLedgerService {
  appendEvent(input: AppendEventInput): Promise<AppendEventResult>;
  appendBatch(inputs: readonly AppendEventInput[]): Promise<readonly AppendEventResult[]>;
  anchor(engagementId: string): Promise<{ chainHead: string; eventCount: number }>;
}

// ───────────────────────────── 常量 ─────────────────────────────

export const DEFAULTS = {
  /** 检查点间隔（秒）；连续错过判定停滞。 */
  checkpointIntervalSeconds: 180,
  maxMissedCheckpoints: 2,
  maxConsecutiveToolFailures: 5,
  queuePressureSeconds: 60,
  contextPressureRatio: 0.85,
  /** 租约。 */
  leaseTtlSeconds: 600,
  leaseHeartbeatSeconds: 60,
  /** 预算。 */
  budgetMaxTokens: 12_000_000,
  budgetMaxSteps: 400,
  budgetMaxSeconds: 14_400,
  budgetSoftThresholdRatio: 0.8,
  /** 压缩。 */
  compactionTriggerRatio: 0.6,
  compactionKeepRecentTurns: 6,
  /** 证据落盘阈值。 */
  artifactFileThresholdBytes: 64 * 1024,
  /**
   * 便签上限。
   *
   * 2026-10-07 由 200 提到 600：便签是**唯一的自动压缩通路**——它被塞进下一阶段的
   * 「上一阶段要点」（`seedHandoffContent`），而 200 字符装不下"结论 + 未决 + 交接注意"。
   * 实测（个人库 18 次交接）：均长 113–144、最长正好 200 = 有几次撞顶被静默截断。
   */
  statusNoteMaxChars: 600,
  /** 范围违规连续次数上限，达到则自动暂停会话。 */
  scopeViolationPauseThreshold: 3,
} as const;
