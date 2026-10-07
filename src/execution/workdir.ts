/**
 * 作业目录的文件访问：挂载目录的**非目标**通道（设计 §10.4）。
 *
 * ── 为什么需要它（2026-10-07 实测的自锁）──
 *
 * 挂载本身只解决「容器能不能看见目录」。空范围的作业（范围版本 0）里，**任何**沙箱命令
 * 都过不了范围闸门（每条命令必须声明一个已授权目标选择器 → `out_of_scope`），于是：
 *
 *     要读作业资料（资产清单）→ 需要跑命令 → 需要范围 → 需要资产清单才能定范围
 *
 * 这个环是设计上的：范围必须由人确认，而资料可以由人贴进对话——但「Agent 读自己作业目录」
 * 这件事**与目标无关**，被目标闸门挡住纯属连接错误。本模块给出这条不经过范围裁决的路径。
 *
 * ── 硬约束（每一条都是安全边界，别放宽）──
 *
 *   1. **只碰配置里显式声明的挂载根**（`sandbox.mounts[].hostPath`）。没有挂载 = 没有访问
 *      （`no_roots`），不退回 cwd、不退回进程工作目录。
 *   2. **路径必须落在根内**：拒绝绝对路径、拒绝 `..` 跳出，并在**解析后的真实路径**上再查一次
 *      （防符号链接从根内指向根外）。前缀比较按「根 + 分隔符」做，避免 `/work` 匹配到 `/workx`。
 *   3. **只读根不写**（`readOnly: true`）。
 *   4. 读取有上限并**如实标注截断**；二进制不返回正文（告诉模型改用别的手段）。
 *
 * 本模块不接触任何目标、不产出计划、不需要放行：它只碰人类自己挂进来的宿主目录。
 */
import { mkdirSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

/** 一个挂载根（与 `sandbox.mounts` 同源，只是两个路径都必填）。 */
export interface WorkdirRoot {
  readonly hostPath: string;
  readonly containerPath: string;
  readonly readOnly?: boolean;
}

/** 读取上限：够放资产清单/报告这类文本，又不至于把上下文塞满。 */
export const WORKDIR_READ_LIMIT_BYTES = 256 * 1024;
/** 写入上限。 */
export const WORKDIR_WRITE_LIMIT_BYTES = 1024 * 1024;
/** 列目录的条数上限。 */
export const WORKDIR_LIST_LIMIT = 500;

/** 拒绝原因。前四个是**策略性**拒绝（工具层据此给稳定错误码），其余是操作性未命中。 */
export type WorkdirErrorCode =
  | 'no_roots'
  | 'bad_path'
  | 'outside_roots'
  | 'read_only'
  | 'not_found'
  | 'not_dir'
  | 'is_dir'
  | 'too_large'
  | 'binary';

export class WorkdirError extends Error {
  override readonly name = 'WorkdirError';
  readonly code: WorkdirErrorCode;
  constructor(code: WorkdirErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}

function normalizeRootPath(hostPath: string): string {
  const p = resolve(hostPath.replace(/\\/g, '/'));
  return p.endsWith(sep) ? p.slice(0, -1) : p;
}

/** 路径是否落在根内（按「根 + 分隔符」比较，避免 /work 匹配 /workx）。 */
function isInside(root: string, candidate: string): boolean {
  return candidate === root || candidate.startsWith(root.endsWith(sep) ? root : root + sep);
}

/**
 * 把模型给的相对路径解析成某个挂载根内的绝对路径。
 *
 * `containerPath` 前缀是可选的、只为可读性：模型常把提示词里的 `/work/xxx` 原样带进来。
 */
export function resolveInRoots(
  roots: readonly WorkdirRoot[],
  rawPath: string,
): { readonly abs: string; readonly root: WorkdirRoot; readonly rel: string; readonly explicit: boolean } {
  if (roots.length === 0) {
    throw new WorkdirError('no_roots', '本部署没有声明任何宿主目录挂载（sandbox.mounts 为空）：作业目录不可读写');
  }
  const input = rawPath.trim();
  if (input.includes('\0')) {
    throw new WorkdirError('bad_path', 'path 不能包含空字节');
  }
  let rel = input.replace(/\\/g, '/');
  let onlyRoot: WorkdirRoot | undefined;
  for (const root of roots) {
    const cp = root.containerPath.replace(/\/+$/, '');
    if (rel === cp) {
      rel = '';
      onlyRoot = root;
      break;
    }
    if (rel.startsWith(cp + '/')) {
      rel = rel.slice(cp.length + 1);
      onlyRoot = root;
      break;
    }
  }
  if (isAbsolute(rel) || /^[A-Za-z]:/.test(rel)) {
    throw new WorkdirError(
      'bad_path',
      `path 必须是**相对挂载根**的路径（挂载根：${roots.map((r) => r.containerPath).join('、')}），不接受绝对路径：${rawPath}`,
    );
  }
  const rootEntry = roots[0];
  if (rootEntry === undefined) throw new WorkdirError('no_roots', '没有挂载根');
  // 逐个根试：命中第一个存在的（多根时模型只需给相对路径，不必知道是哪个根）。
  const candidates: { abs: string; root: WorkdirRoot; rel: string }[] = [];
  // 给了容器路径前缀就**只**认那个根：否则前缀形同虚设，多根时可能落到别的根上
  // （实测后果：写 /mnt/scratch/x.md 却写进了 /work 指向的目录）。
  const pool = onlyRoot === undefined ? roots : [onlyRoot];
  for (const root of pool) {
    const rootAbs = normalizeRootPath(root.hostPath);
    const abs = resolve(join(rootAbs, rel));
    if (!isInside(rootAbs, abs)) {
      // 真跳出去就跳过这个根（多个根时其它根仍可命中）。
      continue;
    }
    // rel 用**规范化**结果：`a/../b.md` 要回报成 `b.md`，否则 containerPath 会把 `..`
    // 原样带给模型，它下一次照抄就可能撞上别的实现。
    candidates.push({ abs, root, rel: relative(rootAbs, abs).replace(/\\/g, '/') });
  }
  const first = candidates[0];
  if (first === undefined) {
    throw new WorkdirError(
      'outside_roots',
      `path 跳出了挂载根：${rawPath}（只允许在该目录内读写，「..」不能跳出根）`,
    );
  }
  // 多根：优先命中「该路径已存在」的那个根——读作业资料时模型只需给相对路径，
  // 不必先知道它在哪个根里；写入（文件还不存在）退回第一个根，但**多根时必须显式**
  // （见 writeWorkdir 的歧义拒绝），否则会静默写进一个模型没指定的目录。
  const picked = candidates.find((candidate) => existsSync(candidate.abs)) ?? first;
  return { ...picked, explicit: onlyRoot !== undefined };
}

/** 真实路径校验：符号链接指向根外时拒绝（在根内则放行）。 */
function assertRealPathInside(candidate: { abs: string; root: WorkdirRoot }): void {
  const rootAbs = normalizeRootPath(candidate.root.hostPath);
  let probe = candidate.abs;
  // 向上找到第一个存在的祖先（写入时文件本身可能还不存在）。
  for (;;) {
    try {
      const real = realpathSync(probe);
      const realRoot = realpathSync(rootAbs);
      if (!isInside(realRoot, real)) {
        throw new WorkdirError('outside_roots', `path 通过符号链接指向了挂载根之外：${candidate.abs}`);
      }
      return;
    } catch (error) {
      if (error instanceof WorkdirError) throw error;
      const parent = dirname(probe);
      if (parent === probe) {
        throw new WorkdirError('not_found', `路径不存在：${candidate.abs}`);
      }
      probe = parent;
    }
  }
}

export interface WorkdirEntry {
  readonly name: string;
  readonly type: 'file' | 'dir' | 'symlink' | 'other';
  readonly size?: number;
}

export interface WorkdirListing {
  readonly path: string;
  readonly root: string;
  readonly containerPath: string;
  readonly entries: readonly WorkdirEntry[];
  readonly truncated: boolean;
}

export function listWorkdir(roots: readonly WorkdirRoot[], rawPath: string): WorkdirListing {
  const target = resolveInRoots(roots, rawPath);
  assertRealPathInside(target);
  let stat;
  try {
    stat = statSync(target.abs);
  } catch {
    throw new WorkdirError('not_found', `路径不存在：${rawPath}`);
  }
  if (!stat.isDirectory()) {
    throw new WorkdirError('not_dir', `不是目录（用 op=read 读文件，op=list 只能列目录）：${rawPath}`);
  }
  const names = readdirSync(target.abs, { withFileTypes: true })
    .map((d) => d.name)
    .sort((a, b) => a.localeCompare(b));
  const truncated = names.length > WORKDIR_LIST_LIMIT;
  const entries: WorkdirEntry[] = names.slice(0, WORKDIR_LIST_LIMIT).map((name) => {
    const child = join(target.abs, name);
    try {
      const st = statSync(child);
      const type: WorkdirEntry['type'] = st.isSymbolicLink()
        ? 'symlink'
        : st.isDirectory()
          ? 'dir'
          : st.isFile()
            ? 'file'
            : 'other';
      return { name, type, ...(st.isFile() ? { size: st.size } : {}) };
    } catch {
      return { name, type: 'other' };
    }
  });
  return {
    path: target.rel === '' ? '.' : target.rel,
    root: normalizeRootPath(target.root.hostPath),
    containerPath: target.root.containerPath,
    entries,
    truncated,
  };
}

export interface WorkdirFile {
  readonly path: string;
  readonly containerPath: string;
  readonly bytes: number;
  /** 文本正文；二进制或超限截断时按截断后的内容给出。 */
  readonly text: string;
  readonly truncated: boolean;
  readonly binary: boolean;
}

export function readWorkdir(roots: readonly WorkdirRoot[], rawPath: string): WorkdirFile {
  const target = resolveInRoots(roots, rawPath);
  assertRealPathInside(target);
  let stat;
  try {
    stat = statSync(target.abs);
  } catch {
    throw new WorkdirError('not_found', `文件不存在：${rawPath}`);
  }
  if (stat.isDirectory()) {
    throw new WorkdirError('is_dir', `这是目录（用 op=list）：${rawPath}`);
  }
  const buf = readFileSync(target.abs);
  const sliced = buf.length > WORKDIR_READ_LIMIT_BYTES ? buf.subarray(0, WORKDIR_READ_LIMIT_BYTES) : buf;
  const binary = sliced.includes(0);
  return {
    path: target.rel,
    containerPath: `${target.root.containerPath.replace(/\/+$/, '')}/${target.rel}`,
    bytes: buf.length,
    text: binary ? '' : sliced.toString('utf8'),
    truncated: buf.length > sliced.length,
    binary,
  };
}

export interface WorkdirWriteResult {
  readonly path: string;
  readonly containerPath: string;
  readonly bytes: number;
}

export function writeWorkdir(
  roots: readonly WorkdirRoot[],
  rawPath: string,
  content: string,
): WorkdirWriteResult {
  const bytes = Buffer.byteLength(content, 'utf8');
  if (bytes > WORKDIR_WRITE_LIMIT_BYTES) {
    throw new WorkdirError(
      'too_large',
      `内容 ${bytes} 字节超过上限 ${WORKDIR_WRITE_LIMIT_BYTES} 字节：分多次写，或把大产物留在沙箱里再说明`,
    );
  }
  const target = resolveInRoots(roots, rawPath);
  if (target.root.readOnly === true) {
    throw new WorkdirError('read_only', `挂载根是只读的（readOnly: true），不能写入：${target.root.containerPath}`);
  }
  if (target.rel === '') {
    throw new WorkdirError('is_dir', 'path 指向挂载根本身：请给出文件名');
  }
  if (!target.explicit && !existsSync(target.abs) && roots.length > 1) {
    // 多根 + 新文件 = 写哪儿都说得通 ⇒ 必须由调用方指明，不能替它猜。
    throw new WorkdirError(
      'bad_path',
      `本部署声明了多个挂载根（${roots.map((r) => r.containerPath).join('、')}）：` +
        `写入新文件必须带容器路径前缀指明写到哪个根（例如 ${roots[0]?.containerPath ?? ''}/目录/文件.md）`,
    );
  }
  assertRealPathInside(target);
  mkdirSync(dirname(target.abs), { recursive: true });
  writeFileSync(target.abs, content, 'utf8');
  return {
    path: target.rel,
    containerPath: `${target.root.containerPath.replace(/\/+$/, '')}/${target.rel}`,
    bytes,
  };
}
