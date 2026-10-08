/**
 * Docker 沙箱执行器：`SandboxExecutor` 的真实实现。
 *
 * 设计依据：docs/dsh-pentest-plugin-design.md §10.4（隔离执行）
 *
 * 沙箱是唯一的目标接触路径。边界模型（2026-10-04 调整：权限放开给 Agent）：
 *   1. **容器网络可达性**——容器只接入部署方指定的那一张网络（`internalNetwork`），**不经 HTTP 代理**：
 *      真工具 nmap/ffuf/sqlmap 穿不过代理，「只能走代理」等于让它们全部不可用。
 *      ⚠ **2026-10-05 起本部署该网络不再是 `--internal`**：操作者要求「沙箱可达范围 = 宿主可达范围」，
 *      于是网络层**不再是范围边界**——仅剩的闸门是 admit 阶段的范围裁决与逐次人工放行。
 *      代码不判断该网络的 internal 属性（那是部署事实，原样透传给 `docker run --network`）：
 *      要恢复封闭可达集合，把网络重建为 `--internal` 并去掉 profile 的 `sandbox.allowEgress`
 *      （预检与 RUNBOOK §4 都写了这条回退路径）。
 *   2. **容器加固**——`--cap-drop ALL` + 仅 `NET_RAW`、`no-new-privileges`、无宿主挂载/宿主网络/
 *      运行时套接字、资源限额。**容器内以 root 运行**（Dockerfile 不再切非特权用户）：
 *      NET_RAW 只对 root 的 effective capability set 生效，非 root 进程拿不到 `--cap-add` 的
 *      能力（Docker 不放进 ambient set），而真 SYN 扫描需要它。边界不靠容器内的用户——
 *      靠「只有一个 cap + 无特权 + 无宿主资源 + 只接部署指定的那一张网络（本部署非 internal）+ 限额」。
 *   3. **执行服务的范围与动作类别校验**——本次调用之前的 admit 阶段。
 *
 * 本文件负责第 1、2 层与「把执行令牌传给容器内的包装器」。
 *
 * ── 三条硬约束（违反即拒绝执行，不做降级）──
 *
 * a. **镜像按 digest 固定**。`allowedImages` 里没有匹配的 digest 就不执行——标签会漂移，
 *    digest 不会。这条来自 dsh-permission-rules 记录的一类事故：白名单按标签写，
 *    上游重新推送同名标签后白名单失效。
 * b. **禁止特权 / 宿主网络 / 宿主挂载 / 容器运行时套接字**。容器是进程级隔离而非内核级，
 *    这些限制必须显式配置到位，不能依赖默认值。
 * c. **资源限额必须有**（CPU / 内存 / PID / 时长 / 输出上限）。缺任一项即拒绝——
 *    「没限额」意味着一次失控的扫描可以打满宿主。
 *
 * ── 关于「执行令牌」（已删除，2026-10-05 复核 REQ-4）──
 *
 * 此前这里注入一个 `commitRun` 签发的一次性令牌，注释声称「容器内的包装器持它向代理
 * 证明本次执行已获准入」。事实是**没有任何消费方校验它**：出口代理只看 `EGRESS_ALLOW`，
 * 容器内的包装器只打印它是否存在，服务端签发之后自己也不再读。一条不可验证的凭证
 * 等于没有凭证，却让读者以为这条路径上还有第二道闸门——因此整条删掉。
 *
 * 「只有已准入的执行才会跑」这件事**目前由结构承担**，不是运行时检查：
 * `SandboxExecutor.run` 的唯一调用点在 `ExecutionService` 内、位于 `commitRun` 事务成功
 * 之后，模型侧触达不到执行器。将来若要独立凭证，正确形态是代理与服务端共享存储校验
 * （设计 §10.2.3 的完整形态），而不是再往环境变量里塞一个没人验的字符串。
 */

import { spawn } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { sanitizeJsonText } from './text-sanitize.ts';
import type { ExecutionPlan, SandboxMount, ToolRunResult } from '../contracts.ts';
import type { SandboxExecutor, SandboxRunRequest } from './service.ts';

/** 已允许的镜像：按 digest 固定，不用标签。 */
export interface AllowedImage {
  readonly name: string;
  /** 形如 `sha256:...`。不允许为空——标签会漂移。 */
  readonly digest: string;
  /** 该镜像明确支持的动作模板；省略仅允许在清单只有一个镜像时使用。 */
  readonly templateIds?: readonly string[];
}

interface SandboxLimits {
  readonly cpus: string;
  readonly memory: string;
  readonly pidsLimit: number;
  /** 容器级硬超时（毫秒），与 plan.timeoutMs 取较小者。 */
  readonly maxWallClockMs: number;
}

export interface DockerSandboxConfig {
  readonly allowedImages: readonly AllowedImage[];
  /**
   * 工具容器接入的网络名（部署事实，代码原样透传给 `docker run --network`）。
   *
   * 两种部署形状的**后果不同**，选哪种是操作者的决定：
   *   - `internal: true`（封闭）：无外网路由 ⇒ 可达集合 = 该网络成员集合，网络层就是范围边界；
   *   - 非 internal（放开；2026-10-05 本部署的选择）：与宿主一样可出网 ⇒ **网络层不再是范围边界**，
   *     只剩 admit 的范围裁决 + 逐次人工放行在把关。
   * 无论哪种，**不要把非授权容器接进这张网**（与沙箱同处一个二层域）。
   */
  readonly internalNetwork: string;
  /**
   * 操作者的**声明意图**：非 internal 网络是否被明确允许（`profile` 的 `sandbox.allowEgress`）。
   *
   * **不进 argv**（`buildDockerArgs` 不看它）——只有个人启动器据此拒绝/提醒。声明在这里是
   * 为了让启动自检能把**声明与实况对照**（`internal` 网络 + `allowEgress: true` 是矛盾组合；
   * 非 internal 而没声明 ⇒ 很可能绕过了启动器）。本仓对"配置写了但插件读不到"的既有立场是
   * **必须显式告警**（见 `runtime.recovery` 的先例），这条字段就是把那个立场落下来。
   */
  readonly allowEgress?: boolean;
  readonly limits?: Partial<SandboxLimits>;
  /** 容器内的工作目录（docker `-w`）。注意：模板入口在 `/tmp` 下执行命令，实测 `pwd` 是 `/tmp`。 */
  readonly workdir?: string;
  /**
   * 显式声明的宿主目录挂载——设计文档 §10.4「只挂载当前 engagement 的授权目录」的实现。
   *
   * 语义与约束（每一条都有理由，别放宽）：
   *   - **只有这里列出的目录**会进容器；不写就是零挂载（默认，等于之前的行为）。
   *   - `containerPath` 必须落在 `/work` 或 `/mnt` 下（见 `MOUNT_CONTAINER_PATH`）——
   *     防止配置写错把 `/`、`/tmp`、`/usr/local/bin` 这类路径盖掉（那会让工具镜像失去工具，
   *     症状是"所有命令突然 command not found"，极难归因）。
   *   - 默认**读写**：人类要在那里写证据、脚本、中间产物（这也是"容器一次性"的天然补偿——
   *     挂载目录里的东西跨命令存在）。要收紧就显式 `readOnly: true`。
   *   - 宿主路径必须**存在且是目录**，不允许盘根（`C:\`）——这些在 `assertSandboxConfig` 里 fail loud。
   *   - 同一个容器路径只能挂一次（重复会让后一个静默覆盖前一个）。
   */
  readonly mounts?: readonly SandboxMount[];
}

/**
 * 挂载形状定义在 `contracts.ts`（提示词侧与沙箱侧必须同一份），这里只做转出，
 * 让执行模块的使用者不必再跨一层 import。
 */
export type { SandboxMount } from '../contracts.ts';

/**
 * 允许挂进容器的容器路径形态：`/work`、`/mnt` 及其子路径（如 `/work/case`、`/mnt/evidence`）。
 *
 * 为什么是白名单式而非黑名单式：挂载会**盖掉**镜像里那个路径（根文件系统可写，盖住
 * `/usr/local/bin` 这种地方等于把工具藏起来）。黑名单永远列不全，白名单只有两个前缀、一眼可审。
 * 注意**默认值 `/work` 本身也必须合法**（曾经写成 `/(work|mnt)/<名>`，于是不写 containerPath 的
 * 最常见配置被自己的校验拒掉——被同一批测试抓到）。
 */
export const MOUNT_CONTAINER_PATH = /^\/(work|mnt)(\/[A-Za-z0-9._-]+)*$/;

/** 默认容器路径（`containerPath` 省略时）。 */
export const DEFAULT_MOUNT_CONTAINER_PATH = '/work';

/**
 * 容器资源限额的**默认值**（导出给提示词用：会话提示词里的限额必须与真正生效的这份一致，
 * 否则模型会按错误的前提规划——比如以为可以跑 30 分钟的长扫描）。
 */
export const DEFAULT_SANDBOX_LIMITS: SandboxLimits = {
  // 真工具(nmap/ffuf/sqlmap/nuclei)会 fork 子进程、吃内存，比纯探测脚本重；
  // 限额仍在（硬约束 c），只是按新工具集调高。
  cpus: '2.0',
  memory: '2g',
  pidsLimit: 512,
  maxWallClockMs: 15 * 60 * 1000,
};

/** 容器内 `/tmp` 的大小（同一份值既进 docker run 的 argv 也进提示词）。 */
export const SANDBOX_TMPFS_SIZE = '512m';

export class SandboxConfigError extends Error {
  override readonly name = 'SandboxConfigError';
}
export function assertSandboxConfig(config: DockerSandboxConfig): void {
  if (config.allowedImages.length === 0) {
    throw new SandboxConfigError('allowedImages 为空：没有允许的镜像即无法执行任何动作');
  }
  const seenTemplates = new Set<string>();
  for (const img of config.allowedImages) {
    if (!img.digest.startsWith('sha256:')) {
      throw new SandboxConfigError(
        `镜像 ${img.name} 的 digest 必须是 sha256:... 形式（实际 ${JSON.stringify(img.digest)}）。` +
          `不接受标签——上游重新推送同名标签会让白名单静默失效。`,
      );
    }
    for (const templateId of img.templateIds ?? []) {
      if (seenTemplates.has(templateId)) {
        throw new SandboxConfigError(`动作模板 ${templateId} 被多个沙箱镜像声明，无法确定执行环境`);
      }
      seenTemplates.add(templateId);
    }
  }
  if (config.internalNetwork.trim().length === 0) {
    throw new SandboxConfigError('internalNetwork 不能为空');
  }

  const limits = { ...DEFAULT_SANDBOX_LIMITS, ...config.limits };
  if (limits.pidsLimit <= 0 || limits.maxWallClockMs <= 0) {
    throw new SandboxConfigError('资源限额必须为正数：pidsLimit / maxWallClockMs');
  }
  assertMounts(config.mounts ?? []);
}

/**
 * 挂载声明的校验：**fail loud，不做降级**。
 *
 * 为什么在这里校验而不是等容器起不来：宿主路径写错时 Docker 会直接报错，但那条错误出现在
 * 某一次动作的执行日志里，看起来像"目标不可达"；而这些问题是**配置错**，应该在建实例时就炸。
 */
function assertMounts(mounts: readonly SandboxMount[]): void {
  const seenContainerPaths = new Set<string>();
  for (const mount of mounts) {
    const hostPath = mount.hostPath.replace(/\\/g, '/').replace(/\/+$/, '');
    if (hostPath.length === 0) {
      throw new SandboxConfigError('挂载的 hostPath 为空');
    }
    if (!/^([A-Za-z]:\/|\/)/.test(hostPath)) {
      throw new SandboxConfigError(`挂载的 hostPath 必须是绝对路径（实际 ${mount.hostPath}）`);
    }
    if (/^[A-Za-z]:$/.test(hostPath) || hostPath === '') {
      throw new SandboxConfigError(`不允许挂载盘根（实际 ${mount.hostPath}）：那是整块盘，不是 engagement 目录`);
    }
    if (!existsSync(mount.hostPath) || !statSync(mount.hostPath).isDirectory()) {
      throw new SandboxConfigError(`挂载的 hostPath 不存在或不是目录：${mount.hostPath}`);
    }
    const containerPath = mount.containerPath ?? DEFAULT_MOUNT_CONTAINER_PATH;
    if (!MOUNT_CONTAINER_PATH.test(containerPath)) {
      throw new SandboxConfigError(
        `挂载的 containerPath 只允许 ${String(MOUNT_CONTAINER_PATH)}（实际 ${containerPath}）：` +
          '它必须落在 /work 或 /mnt 下，否则会盖掉镜像里的系统路径',
      );
    }
    if (seenContainerPaths.has(containerPath)) {
      throw new SandboxConfigError(`containerPath 重复：${containerPath}（后者会静默覆盖前者）`);
    }
    seenContainerPaths.add(containerPath);
  }
}

/**
 * 把容器执行命令组装为 argv。
 *
 * 抽成纯函数是为了可测：**参数构造是安全关键**（漏一个 `--network` 就少一层边界、
 * 多一个 cap 就多一分容器逃逸面），而它不依赖 Docker 是否可用。
 */
export function buildDockerArgs(input: {
  /** 本次运行的挂载（按会话区分目录时由调用方给出）；缺省用配置里的。 */
  readonly mounts?: readonly SandboxMount[];
  readonly image: AllowedImage;
  readonly plan: ExecutionPlan;
  readonly config: DockerSandboxConfig;
  readonly containerName: string;
}): readonly string[] {
  const { image, plan, config, containerName } = input;
  const limits = { ...DEFAULT_SANDBOX_LIMITS, ...config.limits };
  const timeoutMs = Math.min(plan.timeoutMs, limits.maxWallClockMs);
  const mounts = input.mounts ?? config.mounts ?? [];
  const firstMount = mounts[0];
  // 命令默认落在「人类的工作目录」里：显式 workdir 优先，否则取第一个挂载点。
  const workdir =
    config.workdir ??
    (firstMount === undefined ? undefined : (firstMount.containerPath ?? DEFAULT_MOUNT_CONTAINER_PATH));

  // 首元素是**可执行文件本身**，不是子命令：返回值是一条完整命令行，
  // `spawnRunner` 只做 `spawn(argv[0], argv.slice(1))`。
  //
  // 这里曾经漏掉 `DOCKER_BIN`，于是 argv 以 `run` 开头、runner 去 spawn 一个叫
  // `run` 的程序，真实执行一律 `spawn run ENOENT` → `sandbox_unavailable`。
  // 单测没抓到，因为它只验证开关构造、runner 是注入的假实现——
  // 「argv 交给真实进程时会发生什么」那一环没人测。切缝两侧的约定必须在一处断言。
  return [
    DOCKER_BIN,
    'run',
    '--rm',
    '--name', containerName,
    // ── 网络：只接入部署指定的那一张网络（本部署非 internal ⇒ 可出网）；不发布端口（入站不可达）──
    // 例外：**纯本地处理**（模板 `local_command`）不接任何网络——`--network none` 是**事实**，
    // 不是记录里的一句声明。这样"这条动作没碰目标"由内核保证，审计与实现不可能不一致。
    ...(plan.templateId === 'local_command'
      ? ['--network', 'none']
      : ['--network', config.internalNetwork]),
    // ── 加固：与三者相关的限制全部显式声明 ──
    // NET_RAW 是放开后的**唯一**新增能力：真 SYN 扫描/原始套接字需要它。
    // 注意它只对 root 生效（见文件头第 2 条）——镜像里已不切非特权用户。
    // 其余能力一律不给（不加 --privileged，不加其它 cap）。
    '--cap-drop', 'ALL',
    '--cap-add', 'NET_RAW',
    '--security-opt', 'no-new-privileges',
    // /tmp 可执行：工具要能在 /tmp 落地并运行脚本/自解压的临时文件。
    // 根文件系统保持 Docker 默认（可写层、`--rm` 即弃）——不再用只读根给工具制造无谓失败。
    '--tmpfs', `/tmp:rw,exec,nosuid,size=${SANDBOX_TMPFS_SIZE}`,
    '--pids-limit', String(limits.pidsLimit),
    '--cpus', limits.cpus,
    '--memory', limits.memory,
    // ── 不再注入 HTTP_PROXY/HTTPS_PROXY：容器直连内网授权目标 ──
    // 真工具（nmap/ffuf/sqlmap）不走 HTTP 代理，注入它只会让 curl 类工具被代理挡在门外。
    // 出口边界改由「网络成员集合」承担：目标必须与沙箱同在 internalNetwork 上。
    // ── 已裁决地址：容器不得按域名再次解析；JSON 由服务端生成，非用户参数 ──
    '-e', `PENTEST_RESOLVED_ADDRESSES=${JSON.stringify(plan.resolvedAddresses)}`,
    // **范围批次**（宿主已逐地址裁决；见 `allowTargetRange`）：把网段原样告诉容器，
    // 由它按**字符串相等**识别并把网段交给 nmap 原生处理——不做第二份展开实现。
    ...(plan.normalizedTarget.includes('/') ? ['-e', `PENTEST_TARGET_RANGE=${plan.normalizedTarget}`] : []),
    // ── 裁决基准：经环境变量传递，不出现在 argv（ps 可见）──
    '-e', `PENTEST_PLAN_HASH=${plan.planHash}`,
    '-e', `PENTEST_POLICY_EPOCH=${plan.policyEpoch}`,
    '-e', `PENTEST_SCOPE_VERSION=${plan.scopeVersion}`,
    // ── 硬超时由宿主侧计时器实现；这里给容器内一个自超时 ──
    '-e', `PENTEST_TIMEOUT_MS=${timeoutMs}`,
    '-e', `PENTEST_MAX_OUTPUT_BYTES=${plan.maxOutputBytes}`,
    // ── 显式声明的宿主目录挂载（设计 §10.4：只挂载当前 engagement 的授权目录）──
    // 默认读写：那里是人类的工作目录（证据/脚本/中间产物），也是「容器一次性」的补偿——
    // 挂载目录跨命令存在，而 /tmp 不跨命令。不声明就是零挂载（与之前行为一致）。
    ...mounts.flatMap((mount) => [
      '-v',
      `${mount.hostPath.replace(/\\/g, '/')}:${mount.containerPath ?? DEFAULT_MOUNT_CONTAINER_PATH}` +
        (mount.readOnly === true ? ':ro' : ''),
    ]),
    // ── 工作目录：显式 workdir 优先；否则取第一个挂载点 ──
    // **注意这不决定命令的当前目录**：模板入口 `pentest-tool` 在 `/tmp` 下执行命令
    // （2026-10-07 实测：带 `-w /work` 时容器内 `pwd` 仍是 `/tmp`）。因此提示词里
    // 要求 Agent 用**绝对路径**引用挂载文件，而不是靠 cwd。`-w` 仍设上（人工排障
    // 直接 `docker run … bash` 时有意义），但不要在任何文案里承诺 cwd。
    ...(workdir === undefined ? [] : ['-w', workdir]),
    // 镜像必须用 digest 引用（不是标签）
    `${image.name}@${image.digest}`,
    // 命令文本由模板实例化产生；目标已由选择器注入（§10.2.1）
    plan.normalizedCommand,
  ];
}

/** docker 可执行文件名；要换 podman 之类只需改这一处（argv 自足，runner 不做假设）。 */
export const DOCKER_BIN = 'docker';

/**
 * 超时/中止后 `docker rm -f` 的等待上限（毫秒）。
 *
 * 取 5s：守护进程正常时删除是毫秒级；卡住时说明运行时本身有问题，继续等只会拖长
 * 调用链——而清理失败已经会打日志，操作者据此人工收口。
 */
const FORCE_REMOVE_TIMEOUT_MS = 5_000;

/** 在 allowedImages 里按显式动作模板映射找唯一镜像。 */
export function resolveImage(
  plan: ExecutionPlan,
  allowed: readonly AllowedImage[],
): AllowedImage | undefined {
  // 单镜像部署允许省略映射；多镜像部署必须声明 templateIds，避免错配。
  const matches = allowed.filter((img) =>
    img.templateIds === undefined
      ? allowed.length === 1
      : img.templateIds.includes(plan.templateId),
  );
  return matches.length === 1 ? matches[0] : undefined;
}

/**
 * Docker 沙箱执行器。
 *
 * 依赖 `docker` 在 PATH 上。`spawn` 的过程与输出由注入的 runner 完成——
 * 这样测试可以验证**参数构造与结果映射**，而不必真的起容器。
 */
export interface ProcessRunner {
  run(
    argv: readonly string[],
    options: { readonly signal: AbortSignal; readonly timeoutMs: number },
  ): Promise<{
    readonly code: number | null;
    readonly stdout: string;
    readonly stderr: string;
    readonly timedOut: boolean;
    /**
     * 是否由 `options.signal` 中止。
     *
     * **必须与 `code` 分开报告**：被信号杀死的进程在 Node 里 `code === null`，
     * 与「docker 根本没起来」不可区分。只看 `code` 会把一次**人类或策略发起的终止**
     * 记成 `sandbox_unavailable`，并让模型读到「检查容器运行时是否可用」——一句关于
     * 世界的假话（§16.5：工具返回的是机器事实，不是安慰文本）。
     */
    readonly aborted: boolean;
  }>;
}

/**
 * 宿主侧输出缓冲上限（字节）。**与容器内的 `PENTEST_MAX_OUTPUT_BYTES` 是两件事**：
 * 后者约束守规矩的容器内 Reporter 主动截断，前者是宿主对「容器根本不守规矩」的兜底。
 * 没有它，一个持续输出的容器可以在退出前把宿主进程的内存吃光——上限只在 **退出之后**
 * 的 `mapOutcome` 里才生效，那时内存已经花掉了。取 8 MiB：远超任何单次动作的正常输出，
 * 又小到不可能构成内存压力。
 */
const HOST_OUTPUT_BUFFER_LIMIT_BYTES = 8 * 1024 * 1024;
export { HOST_OUTPUT_BUFFER_LIMIT_BYTES };

/**
 * 计算「按字节截断但不切出半个 UTF-8 序列」的安全切点。
 *
 * 从切点开始往回退：若切口处（含）之后是**续字节**（`10xxxxxx`），说明切在了某个序列
 * 中间，就继续回退到该序列的起始字节之前。`truncate` 与 `appendBounded` 共用它——
 * 这段逻辑只写错一次就会在两条路径上各错一遍，而且错法是「偶发出现一个替换字符」，
 * 极易被当成偶发而放过。
 */
function safeByteCut(buf: Buffer, maxBytes: number): number {
  let end = maxBytes;
  while (end > 0 && (buf[end]! & 0xc0) === 0x80) end -= 1;
  return end;
}

/** 累积输出并丢弃超限部分，返回「是否发生过截断」。 */
export function appendBounded(current: string, chunk: string, limit: number): {
  readonly text: string;
  readonly overflowed: boolean;
} {
  const currentBytes = Buffer.byteLength(current, 'utf8');
  if (currentBytes >= limit) return { text: current, overflowed: true };
  const chunkBuf = Buffer.from(chunk, 'utf8');
  const room = limit - currentBytes;
  if (chunkBuf.length <= room) return { text: current + chunk, overflowed: false };
  // 只保留放得下的前缀，并回退到合法 UTF-8 起点，避免截出半个字符。
  return { text: current + chunkBuf.subarray(0, safeByteCut(chunkBuf, room)).toString('utf8'), overflowed: true };
}

/** 用 child_process.spawn 实现真实 runner。 */
export const spawnRunner: ProcessRunner = {
  run(argv, options) {
    // 注：不用 Promise.withResolvers——它需要 lib es2024，而本仓 lib 是 es2023。
    // 升级 lib 会波及全部类型检查，为一个辅助 API 不值得。
    return new Promise((resolve) => {
      const child = spawn(argv[0]!, argv.slice(1), {
        windowsHide: true,
        // 自成进程组（POSIX）：杀的时候可以连**后代**一起杀。
        // 只 kill 直接子进程会留下它派生的进程继续跑——容器 CLI 被 SIGKILL 后，
        // 其容器内的进程仍可能存活，而宿主侧已经当它结束了。
        detached: process.platform !== 'win32',
      });
      let stdout = '';
      let stderr = '';
      let outputOverflowed = false;
      let timedOut = false;
      let aborted = false;
      let settled = false;

      /**
       * 终止整棵进程树。
       *
       * `detached: true` 让子进程成为新进程组的组长（pgid = pid），于是 `-pid` 可以一次
       * 杀掉整组。Windows 上没有进程组信号，退化为普通 `kill`（容器由 `--rm` 回收）。
       */
      const killTree = (): void => {
        if (child.pid === undefined) return;
        try {
          if (process.platform !== 'win32') process.kill(-child.pid, 'SIGKILL');
          else child.kill('SIGKILL');
        } catch {
          // 进程组/进程已经消失（竞态）——目标已达成，不是错误。
          try { child.kill('SIGKILL'); } catch { /* 同上 */ }
        }
      };

      const timer = setTimeout(() => {
        timedOut = true;
        killTree();
      }, options.timeoutMs);

      const onAbort = (): void => {
        aborted = true;
        killTree();
      };
      options.signal.addEventListener('abort', onAbort, { once: true });
      // **已 abort 的信号不会再触发监听器**，因此必须显式检查一次。
      //
      // 这不是理论边界：`ExecutionService.execute` 先登记在途动作、再调 `sandbox.run`，
      // 而 `abortInFlight`（策略 epoch 前进、人工终止）随时可能在这两步之间触发。
      // 少了这一次检查，容器会一直跑到墙钟超时（最长 15 分钟）——而调用方以为自己
      // 已经终止了它。
      if (options.signal.aborted) onAbort();

      const push = (target: 'stdout' | 'stderr', b: Buffer): void => {
        const current = target === 'stdout' ? stdout : stderr;
        const next = appendBounded(current, b.toString('utf8'), HOST_OUTPUT_BUFFER_LIMIT_BYTES);
        if (target === 'stdout') stdout = sanitizeJsonText(next.text);
        else stderr = next.text;
        if (next.overflowed) outputOverflowed = true;
      };
      child.stdout.on('data', (b: Buffer) => { push('stdout', b); });
      child.stderr.on('data', (b: Buffer) => { push('stderr', b); });

      const settle = (code: number | null, extraStderr = ''): void => {
        // 只结算一次：'error' 与 'close' 都可能到达，重复 resolve 会让调用方看到两次结果。
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        options.signal.removeEventListener('abort', onAbort);
        const overflowNote = outputOverflowed
          ? `\n[宿主侧输出缓冲已达上限 ${String(HOST_OUTPUT_BUFFER_LIMIT_BYTES)} 字节，后续输出被丢弃]`
          : '';
        resolve({
          code,
          stdout,
          stderr: `${stderr}${extraStderr}${overflowNote}`,
          timedOut,
          aborted,
        });
      };

      child.on('error', (e: Error) => { settle(null, e.message); });
      child.on('close', (code: number | null) => { settle(code); });
    });
  },
};

interface DockerSandboxDeps {
  readonly runner?: ProcessRunner;
  /** 生成容器名的函数（便于测试注入固定值）。 */
  readonly containerName?: (plan: ExecutionPlan) => string;
  /**
   * **本次运行的挂载根**（宿主路径）——按会话区分目录的接入口（2026-10-08）。
   *
   * 返回 `undefined` ⇒ 用配置里的 `mounts`（行为与今天完全一致，回退路径）；返回一个路径 ⇒
   * 本次运行只挂它（落在 `/work`），且**必须在运行前校验通过**：目录不存在就**拒绝这次运行**，
   * 绝不静默回退到配置里的目录（静默回退会把证据写进人类没预期的项目资料里——那正是要修的毛病）。
   */
  readonly mountRootFor?: (plan: ExecutionPlan) => string | undefined;
}

/**
 * `docker network inspect -f '{{.Internal}}'` 的原始输出 → 形状判定（**纯函数**，可穷举单测）。
 *
 * 判据收紧到**精确等于** `true` / `false`：其余一切（空输出、CLI 多写一行、读错字段）都判 `unknown`。
 * 2026-10-07 评审的变异实验证明了为什么必须这样：把命令里的字段名误写成别的（例如 `{{.Name}}`）
 * 时输出恒为网络名，原先"非 true 即非 internal"的默认分支会把**每个 internal 部署**印成
 * "可达 = 宿主可达"——恰好把本自检要解决的故障模式（沙箱不出网）反向说了一遍，而当时的测试抓不住。
 */
export function networkShape(raw: string): 'internal' | 'open' | 'unknown' {
  const value = raw.trim();
  if (value === 'true') return 'internal';
  if (value === 'false') return 'open';
  return 'unknown';
}

/** 探针得到的事实（**事实与渲染分开**：想知道"能不能出网"的调用方不该去解析散文）。 */
export interface ReachabilityFact {
  readonly shape: 'internal' | 'open' | 'unknown';
  readonly network: string;
  /** shape==='unknown' 时的原因（inspect 的 stderr/超时/不可识别输出），其余为空串。 */
  readonly detail: string;
  /** 操作者的声明（profile 的 `sandbox.allowEgress`），用于和实况互校。 */
  readonly allowEgress: boolean | undefined;
}

/**
 * 探一次网络形状。**唯一**会跑 `docker network inspect` 的地方（除它之外没有第二个真相源）。
 * 失败（docker 不在、网络名写错、超时）一律 'unknown'，绝不当成 open——危险方向必须最难命中。
 */
export async function probeReachability(
  runner: ProcessRunner,
  network: string,
  allowEgress: boolean | undefined,
): Promise<ReachabilityFact> {
  const outcome = await runner.run([DOCKER_BIN, 'network', 'inspect', '-f', '{{.Internal}}', network], {
    signal: new AbortController().signal,
    timeoutMs: 10_000,
  });
  const failed = outcome.timedOut || outcome.code !== 0;
  if (failed) {
    return {
      shape: 'unknown',
      network,
      detail: (outcome.stderr ?? '').trim().slice(0, 200) || '无输出',
      allowEgress,
    };
  }
  const shape = networkShape(outcome.stdout);
  return {
    shape,
    network,
    detail: shape === 'unknown' ? `inspect 输出不可识别：${JSON.stringify(outcome.stdout.trim())}` : '',
    allowEgress,
  };
}

/** 事实 → 启动日志那一行（前缀 `[dsh-pentest] 沙箱可达性` 是 RUNBOOK 排障表的检索锚点，别改）。 */
export function renderReachabilityNote(fact: ReachabilityFact): string {
  // 声明 ↔ 实况对照（仓里既有立场：配置写了但读不到/对不上，必须显式告警而不是静默）。
  const contradiction =
    fact.shape === 'internal' && fact.allowEgress === true
      ? '\n⚠ 声明与实况矛盾：网络是 internal，profile 里的 sandbox.allowEgress 无意义（删掉它，或把网络改成非 internal）。'
      : fact.shape === 'open' && fact.allowEgress !== true
        ? '\n⚠ 网络非 internal 但未声明 sandbox.allowEgress：本进程很可能**绕过了个人启动器**（只有它会强制这条声明），请知情。'
        : '';
  if (fact.shape === 'unknown') {
    return (
      `[dsh-pentest] 沙箱可达性：**未知** —— 读不到网络 ${fact.network} 的 Internal 属性` +
      `（${fact.detail}）。` +
      '先确认真实网络名（profile 的 runtime.sandbox.internalNetwork）与 docker 权限；在此之前不要假设沙箱有网。'
    );
  }
  if (fact.shape === 'internal') {
    return (
      `[dsh-pentest] 沙箱可达性：网络 ${fact.network} 是 **internal** ⇒ 本沙箱**没有外网出口**，` +
      '可达集合只有该网络成员；任何出网动作（crt.sh、公网 CVE 库、apt/pip……）都只会超时。' +
      '要"宿主能访问的沙箱也能"：把该网络重建为**非 internal**，并在 profile 写 sandbox.allowEgress: true 后重启。' +
      contradiction
    );
  }
  return (
    `[dsh-pentest] 沙箱可达性：网络 ${fact.network} **不是 internal** ⇒ 沙箱可达 = 宿主可达（网络层不是范围边界）。` +
    '仅剩的闸门是 admit 阶段的范围裁决与审批模式；要恢复封闭可达集合：重建为 --internal 并去掉 allowEgress。' +
    contradiction
  );
}

export class DockerSandbox implements SandboxExecutor {
  private readonly config: DockerSandboxConfig;
  private readonly runner: ProcessRunner;
  private readonly containerName: (plan: ExecutionPlan) => string;
  private readonly mountRootFor: ((plan: ExecutionPlan) => string | undefined) | undefined;

  constructor(config: DockerSandboxConfig, deps: DockerSandboxDeps = {}) {
    // 显式赋值而非构造函数参数属性：erasableSyntaxOnly 禁止后者
    // （参数属性会生成运行时代码，与「类型可擦除」的前提冲突）。
    this.config = config;
    this.runner = deps.runner ?? spawnRunner;
    this.containerName = deps.containerName ?? ((plan) => `pentest-${plan.idempotencyKey.slice(0, 24)}`);
    this.mountRootFor = deps.mountRootFor;
    assertSandboxConfig(this.config);
  }

  /**
   * 启动自检的可读输出（薄壳：探针 + 渲染在模块级，便于启动层直接复用而不必建一个沙箱实例）。
   *
   * 为什么要它（2026-10-07，GitHub 反馈"装完插件沙箱不出网"）：`buildDockerArgs` 只透传
   * `--network <名>` 且**不注入任何代理变量**，于是"出不出网"完全是部署事实 ——
   * 网络建成 `--internal` ⇒ 可达集合只有该网络成员（等于**完全不出网**）；非 internal ⇒
   * 可达范围等于宿主。代码知道这件事，但**从不检查、也不说**：绕过 `start-personal.mjs`
   * 的启动路径上，用户看到的只是动作超时，看起来像工具坏了。
   *
   * 不做拒绝（放开是操作者的决定，且 `allowEgress` 只存在于 profile/启动器一侧、插件读不到），
   * 只做**每一次启动都吵一遍**：两种形状各自的后果与出路。
   */
  async reachabilityNote(): Promise<string> {
    return renderReachabilityNote(
      await probeReachability(this.runner, this.config.internalNetwork, this.config.allowEgress),
    );
  }

  async run(request: SandboxRunRequest, signal: AbortSignal): Promise<ToolRunResult> {
    const { plan } = request;

    const image = resolveImage(plan, this.config.allowedImages);
    if (image === undefined) {
      // fail closed：没有允许的镜像就不执行，不降级为「直接跑」
      return {
        status: 'blocked',
        error: {
          status: 'blocked',
          code: 'sandbox_unavailable',
          message: `没有允许的镜像可以执行模板 ${plan.templateId}`,
          next_action: '请由人类在沙箱配置里登记镜像摘要',
        },
      };
    }

    const timeoutMs = Math.min(plan.timeoutMs, { ...DEFAULT_SANDBOX_LIMITS, ...this.config.limits }.maxWallClockMs);
    const containerName = this.containerName(plan);
    // 按会话区分工作目录（2026-10-08）：本次运行的挂载根可来自**会话的 cwd**。
    // 它必须**在运行前校验通过**：目录不存在就拒绝这次运行——**绝不静默回退**到配置里的目录
    // （静默回退会把证据写进人类没预期的项目资料里，那正是要被修掉的毛病）。
    let runMounts: readonly SandboxMount[] | undefined;
    const overrideRoot = this.mountRootFor?.(plan);
    if (overrideRoot !== undefined) {
      runMounts = [{ hostPath: overrideRoot, containerPath: DEFAULT_MOUNT_CONTAINER_PATH }];
      try {
        assertMounts(runMounts);
      } catch (error) {
        return {
          status: 'blocked',
          error: {
            status: 'blocked',
            code: 'sandbox_unavailable',
            message: `会话工作目录不可用：${error instanceof Error ? error.message : String(error)}`,
            next_action: '在宿主上确认该会话目录存在（会话的 cwd 取自宿主会话头），再重发本条动作',
          },
        };
      }
    }
    const argv = buildDockerArgs({
      image,
      plan,
      config: this.config,
      containerName,
      ...(runMounts === undefined ? {} : { mounts: runMounts }),
    });

    const outcome = await this.runner.run(argv, { signal, timeoutMs });

    if (outcome.timedOut || outcome.aborted) {
      // 兜底删除（2026-10-05 复核 GAP-6）：`spawnRunner` 只能杀掉宿主侧的 docker CLI
      // 进程组；容器内进程可能仍在跑（源码注释自认这一点）。容器名是确定性的，
      // 因此这里补一次 `docker rm -f`——宿主已判「已停止」之后，目标不该继续被扫。
      await this.#forceRemoveContainer(containerName);
    }

    return mapOutcome(outcome, plan.maxOutputBytes);
  }

  /**
   * 超时/中止后的容器兜底删除。
   *
   * best-effort：失败只记日志——清理失败不该把一个已经判定的 `timed_out`/`cancelled`
   * 变成另一种结论；但必须可见，否则操作者不知道容器可能还在跑。
   */
  async #forceRemoveContainer(containerName: string): Promise<void> {
    const controller = new AbortController();
    try {
      await this.runner.run([DOCKER_BIN, 'rm', '-f', containerName], {
        signal: controller.signal,
        timeoutMs: FORCE_REMOVE_TIMEOUT_MS,
      });
    } catch (error) {
      console.warn(
        `[dsh-pentest] 超时/中止后删除容器失败（${containerName}）：` +
          `${error instanceof Error ? error.message : String(error)}。` +
          '容器可能仍在运行，请人工 `docker rm -f` 清理',
      );
    }
  }
}

/**
 * 把进程结果映射为契约的 `ToolRunResult`。
 *
 * 截断在这里做（而不是留给调用方）：输出上限是入参承诺的一部分，
 * 超限必须带 `truncated` 标记，**不能返回看起来完整的结果**（§10.3）。
 *
 * 判定顺序 matters：`timedOut` → `aborted` → `code === null`。
 * 被信号杀死的进程 `code` 也是 `null`，若先判 `code`，一次**有意终止**会被报成
 * `sandbox_unavailable`——那会让模型去查一个根本没坏的容器运行时。
 */
export function mapOutcome(
  outcome: {
    readonly code: number | null;
    readonly stdout: string;
    readonly stderr: string;
    readonly timedOut: boolean;
    readonly aborted: boolean;
  },
  maxOutputBytes: number,
): ToolRunResult {
  if (outcome.timedOut) {
    return {
      status: 'timed_out',
      stdout: truncate(outcome.stdout, maxOutputBytes).text,
      stderr: truncate(outcome.stderr, maxOutputBytes).text,
      truncated: true,
    };
  }
  if (outcome.aborted) {
    // 中止是一次**正常结论**，不是错误：策略 epoch 前进或人类终止了它。
    // 因此不带 `error`——`cancelled` 本身就是完整的事实（§16.5）。
    //
    // `truncated` 与其它分支同规则：只看这个标志的消费方不该把被截断的输出当成完整。
    const out = truncate(outcome.stdout, maxOutputBytes);
    const err = truncate(outcome.stderr, maxOutputBytes);
    return {
      status: 'cancelled',
      stdout: out.text,
      stderr: err.text,
      ...(out.truncated || err.truncated ? { truncated: true } : {}),
    };
  }
  if (outcome.code === null) {
    // 与其余三个分支同规则截断（2026-10-05 复核 GAP-7）：容器没起来时 stderr 里
    // 可能有整段 docker 报错，宿主缓冲上限是 8MiB——不截断就会原样进库、回给模型，
    // 而模板声明的 `maxOutputBytes` 在这里形同虚设。
    const err = truncate(outcome.stderr, maxOutputBytes);
    return {
      status: 'runtime_error',
      stderr: err.text,
      ...(err.truncated ? { truncated: true } : {}),
      error: {
        status: 'blocked',
        code: 'sandbox_unavailable',
        message: '沙箱进程未能启动或异常终止',
        next_action: '检查容器运行时是否可用；不要自动重试',
      },
    };
  }

  const out = truncate(outcome.stdout, maxOutputBytes);
  const err = truncate(outcome.stderr, maxOutputBytes);
  return {
    status: 'completed',
    exitCode: outcome.code,
    stdout: out.text,
    stderr: err.text,
    ...(out.truncated || err.truncated ? { truncated: true } : {}),
  };
}

/** 按字节上限截断，并在尾部标注被截断。 */
function truncate(text: string, maxBytes: number): { readonly text: string; readonly truncated: boolean } {
  const buf = Buffer.from(text, 'utf8');
  if (buf.length <= maxBytes) return { text, truncated: false };
  // 从字节边界回退到合法 UTF-8 起点，避免截出半个字符
  const end = safeByteCut(buf, maxBytes);
  return { text: `${buf.subarray(0, end).toString('utf8')}\n[已截断：原长 ${buf.length} 字节，上限 ${maxBytes}]`, truncated: true };
}
