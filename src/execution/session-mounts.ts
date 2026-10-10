/**
 * 「本次运行挂什么」的**唯一定义**（2026-10-11）。
 *
 * 起因是一次实测到的漂移，症状属于最难归因的一类：容器把结构化动作的产物（`.xml`/`.json`）
 * 写进**会话的工作目录**，而 `pentest_workdir` 与宿主侧证据落盘读的是**配置里的目录**——
 * 操作者在工具里只看到自己手写的 `.txt`，于是得出"证据不存在"。文件其实一份不少，只是分居两处。
 *
 * 四个消费者（容器 argv / 会话简报 / `pentest_workdir` / 宿主侧证据落盘）此前各自解析：
 * 2026-10-08 给前两者加了"按会话 cwd 覆盖 `/work`"，后两者没跟上。四份推导必然漂移，
 * 所以这里只留**一份**：规则是 {@link sessionMountsForCwd}，四个视图由
 * {@link sessionMountViews} 一次性产出（消费者拿到的就是同一份对象，结构上无法再分叉）。
 *
 * 规则本身（会话 cwd 覆盖 `/work`）是操作者的明确要求："我 dsh 会话在哪个目录，AI 就默认在
 * 哪个目录操作"。**但只覆盖 `/work`**：配置里其余挂载（如 `/mnt` 下的只读锚点）仍然生效——
 * 旧实现把整份配置挂载都换掉了，于是那个锚点在容器里静默消失，简报也不再提它。
 */

import type { SandboxMount } from '../contracts.ts';
import { DEFAULT_MOUNT_CONTAINER_PATH } from './docker-sandbox.ts';
import type { WorkdirRoot } from './workdir.ts';

const isWorkMount = (mount: SandboxMount): boolean =>
  (mount.containerPath ?? DEFAULT_MOUNT_CONTAINER_PATH).replace(/\/+$/, '') === DEFAULT_MOUNT_CONTAINER_PATH;

/**
 * 会话 cwd → 本次运行的挂载列表。
 *
 * - `cwd === undefined` ⇒ 配置原样（回退语义：与完全没配会话 cwd 时一致）。
 * - 给了 cwd ⇒ `[{cwd, /work}, ...配置里 containerPath 不是 /work 的那些]`（顺序稳定：
 *   `/work` 在首位，其余保持配置里的相对顺序——`buildDockerArgs` 用首个挂载决定 `-w`）。
 *
 * hostPath 是否存在**不在这里判**：存在性由 `assertMounts` 在执行前判（不存在 ⇒ 拒绝本次运行、
 * **不启动容器**、不回退到配置目录——静默回退会把证据写进人类没预期的项目资料里）。
 */
export function sessionMountsForCwd(
  cwd: string | undefined,
  configured: readonly SandboxMount[],
): readonly SandboxMount[] {
  if (cwd === undefined) return configured;
  return [
    { hostPath: cwd, containerPath: DEFAULT_MOUNT_CONTAINER_PATH },
    ...configured.filter((mount) => !isWorkMount(mount)),
  ];
}

/** 一份挂载事实的四个视图（容器 argv / 工具读写 / 证据落盘 / 简报）。 */
export interface SessionMountViews {
  /** 配置声明的挂载根（描述与回退用；实际生效的可能被会话 cwd 覆盖 `/work`）。 */
  readonly roots: readonly WorkdirRoot[];
  /** 本次运行实际挂什么（容器 argv 的唯一来源）。 */
  readonly mountsFor: (plan: { readonly workerSessionId: string }) => readonly SandboxMount[];
  /** 某会话实际生效的挂载（与 {@link SessionMountViews.mountsFor} 同源）。 */
  readonly mountsForWorker: (workerSessionId: string) => readonly SandboxMount[];
  /** `pentest_workdir` 的读写根（同源，转成工具侧形状）。 */
  readonly workdirRootsFor: (workerSessionId: string) => readonly WorkdirRoot[];
  /**
   * 宿主侧证据落盘根（`/work` 对应的宿主路径；无挂载 ⇒ `undefined`，调用方据此给说明而非报错）。
   */
  readonly evidenceRootFor: (workerSessionId: string) => string | undefined;
}

/**
 * 产出四个视图。`cwdOf` 由装配层给（只有它持有 cordis `Context`，能读会话头的 cwd）。
 */
export function sessionMountViews(input: {
  readonly configured: readonly SandboxMount[];
  readonly cwdOf: (workerSessionId: string) => string | undefined;
  /** 覆盖规则（装配层用来把"会话 cwd 的取法"与"简报"钉在同一处）；缺省即 {@link sessionMountsForCwd}。 */
  readonly mountsForCwd?: (cwd: string | undefined) => readonly SandboxMount[];
}): SessionMountViews {
  const rule =
    input.mountsForCwd ?? ((cwd: string | undefined) => sessionMountsForCwd(cwd, input.configured));
  const mountsForWorker = (workerSessionId: string): readonly SandboxMount[] =>
    rule(input.cwdOf(workerSessionId));
  const workdirRootsFor = (workerSessionId: string): readonly WorkdirRoot[] =>
    mountsForWorker(workerSessionId).map((mount) => ({
      hostPath: mount.hostPath,
      containerPath: mount.containerPath ?? DEFAULT_MOUNT_CONTAINER_PATH,
      ...(mount.readOnly === true ? { readOnly: true } : {}),
    }));
  return {
    roots: input.configured.map((mount) => ({
      hostPath: mount.hostPath,
      containerPath: mount.containerPath ?? DEFAULT_MOUNT_CONTAINER_PATH,
      ...(mount.readOnly === true ? { readOnly: true } : {}),
    })),
    mountsFor: (plan) => mountsForWorker(plan.workerSessionId),
    mountsForWorker,
    workdirRootsFor,
    evidenceRootFor: (workerSessionId) =>
      mountsForWorker(workerSessionId).find((mount) => isWorkMount(mount))?.hostPath,
  };
}
