/**
 * 命令输出的**证据落盘**：把一次性容器里跑出来的 stdout 写到会话的工作目录（`/work` ⇄ 宿主挂载根）。
 *
 * ── 为什么要有它（2026-10-08 实地问题记录 §3.3）──
 *
 * 容器是一次性的（`--rm`），除挂载目录外**没有任何持久路径**。此前证据能不能留下，取决于模型
 * 在每个命令里都记得 `tee /work/evidence/...`：忘一条，那条命令的原文就永久消失（报告里只剩
 * 截断版的 stdout）。写盘放在**宿主侧**有两个好处：不依赖模型自觉；不必让模型处理路径转义、
 * 目录不存在、命令里带引号这些坑。
 *
 * ── 路径规则（与 `pentest_workdir` 的越界校验同源精神）──
 *
 *   `<挂载根>/evidence/<目标 slug>/<UTC 时间戳>-<用途 slug>.txt`
 *
 * 两个 slug 都**只保留白名单字符**（ASCII 字母数字与 `-_.`），其余替换成 `-`：这两段字符串
 * 分别来自目标与模型给的 purpose，直接当文件名会带来路径穿越与非法字符两类问题。时间戳用
 * UTC ISO（`2026-10-08T1201Z`）——排序即时间序，且不含 `:`（Windows 文件名合法）。
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

/** 目标与用途 → 文件名安全片段：只留 `[A-Za-z0-9._-]`，其余折叠成 `-`，并去首尾 `-`/`.`。 */
export function slugForFileName(text: string, maxLength = 48): string {
  const folded = text
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '');
  return folded.slice(0, maxLength) === '' ? 'unnamed' : folded.slice(0, maxLength);
}

/** UTC 时间戳（文件名用）：`2026-10-08T1201Z`。 */
export function utcStamp(at: Date): string {
  const iso = at.toISOString(); // 2026-10-08T12:01:23.456Z
  return `${iso.slice(0, 13).replace(/:/g, '')}${iso.slice(14, 16)}Z`;
}

/**
 * 相对挂载根的落盘路径（**纯函数**，越界由调用方与写盘共同保证：这里只拼相对段，
 * 不含 `..`，因为两段 slug 的白名单里没有点号连排的形态）。
 */
export function evidenceRelPath(input: {
  readonly targetSelector: string;
  readonly purpose: string;
  readonly at: Date;
}): string {
  const target = slugForFileName(input.targetSelector, 64);
  const slug = slugForFileName(input.purpose, 48);
  return path.posix.join('evidence', target, `${utcStamp(input.at)}-${slug}.txt`);
}

export interface EvidenceWriteResult {
  readonly ok: boolean;
  /** 成功时是相对挂载根的路径（给模型引用用）；失败时是原因。 */
  readonly detail: string;
}

/**
 * 命令是否**自己**把 stdout 写进了挂载根：命中 ⇒ 返回**命中的那个挂载根**，否则 `undefined`。
 *
 * 判据的作用是**抑制**宿主侧的自动落盘（避免同一件事产出两份近重复文件），而抑制错了的代价是
 * "证据永久消失"（容器一次性、`/tmp` 不跨命令）。所以：**宁可漏判（多落一份文件），不可误判**。
 * 收紧后的形态是三类能证明 stdout 落进挂载根的写法（2026-10-11 第八轮质检）：
 *   ① 真正的重定向算符 `>` / `>>` / `>|`——**不认** `2>`、`1>`、`&>`（那不是 stdout，或无法确证）；
 *   ② `tee`（含 `sudo`/`command`/`env` 前缀与 `-a`）出现在**命令词位置**（段首或管道之后）；
 *   ③ heredoc 写者：`cat > /work/f <<'EOF' …`——正文按换行切分后最后一段是终止符，
 *      所以带 `<<` 的那一段也参与判定。
 * 引号内的文本先剥掉：`-d '{"a":"> /work/x"}'` 里的 `>` 是**字面量**，不是重定向。
 *
 * **已知漏判**（方向安全：不抑制 ⇒ 只是多一份派生文件）：`curl -o`/`wget -O`、`1>`、`&>`、
 * `$(…)` 或 heredoc 正文里的重定向、`xargs tee`。这些一律不认——**认错比认少贵**。
 */
export function writesIntoMount(command: string, mountContainerPaths: readonly string[]): string | undefined {
  // 引号**不能直接剥掉**：`> '/work/x'` 的带引号目标是合法写入，剥掉反而漏判。
  // 正确做法是先把引号区间标出来，匹配到之后再判"这个匹配点是不是落在引号里"
  // （`-d '{"a":"> /work/x"}'` 的 `>` 落在单引号里 ⇒ 那是字面量，不算重定向）。
  const quoted: Array<readonly [number, number]> = [];
  let openQuote: string | null = null;
  let openAt = 0;
  for (let i = 0; i < command.length; i += 1) {
    const ch = command[i]!;
    if (openQuote === null) {
      if (ch === "'" || ch === '"') {
        openQuote = ch;
        openAt = i;
      }
    } else if (ch === openQuote) {
      quoted.push([openAt, i]);
      openQuote = null;
    }
  }
  if (openQuote !== null) quoted.push([openAt, command.length]);
  const insideQuotes = (index: number): boolean => quoted.some(([from, to]) => index >= from && index <= to);

  // 分段：`||`、`&&`、`|`、`;`、换行都切——但 **`>|`（覆写算符）里的 `|` 不能切**
  // （否则 `curl … >| /work/a.txt` 会被切成两段，最后一段看不见重定向 ⇒ 漏判）。
  // 每段记下它在原串里的偏移，才能在"引号内/外"这件事上用原始下标判定。
  const segments: Array<{ readonly text: string; readonly offset: number }> = [];
  let cursor = 0;
  for (const match of command.matchAll(/\|\||&&|(?<!>)\||[;\n]/gu)) {
    segments.push({ text: command.slice(cursor, match.index), offset: cursor });
    cursor = match.index + match[0].length;
  }
  segments.push({ text: command.slice(cursor), offset: cursor });
  const nonEmpty = segments.filter((segment) => segment.text.trim() !== '');
  // heredoc 写者的重定向在**带 `<<` 的那一段**（正文按换行切开后最后一段是终止符）。
  const candidates = [
    ...new Map(
      [nonEmpty.at(-1), ...nonEmpty.filter((segment) => segment.text.includes('<<'))]
        .filter((segment): segment is { text: string; offset: number } => segment !== undefined)
        .map((segment) => [segment.offset, segment] as const),
    ).values(),
  ];

  for (const mountPath of mountContainerPaths) {
    const root = escapeRegExp(mountPath.replace(/\/+$/u, ''));
    const redirect = new RegExp(`(?:^|[^0-9&>])(?:>>|>\\|?)\\s*['"]?${root}/`, 'gu');
    // `tee` 必须落在**命令词位置**：段首（允许前导空白）或 `sudo/command/env` 之后。
    // 不这么收的话 `grep -n tee /work/x` 会被当成写入（那是**误判** ⇒ 吞掉唯一副本）。
    const tee = new RegExp(`^\\s*(?:(?:sudo|command|env)\\s+)?tee\\s+(?:-a\\s+)?['"]?${root}/`, 'gu');
    for (const segment of candidates) {
      for (const pattern of [redirect, tee]) {
        for (const match of segment.text.matchAll(pattern)) {
          if (!insideQuotes(segment.offset + match.index)) return mountPath;
        }
      }
    }
  }
  return undefined;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

/**
 * 写盘。`root` 是宿主上的挂载根（沙箱里对应 `/work`）；`relPath` 只接受相对路径。
 *
 * **绝不抛**：它是执行后的附带动作，写不进去（目录不可写、磁盘满）不该把一次**已经执行完**
 * 的动作变成失败——那会让模型以为命令没跑、进而重发（对目标再打一次）。
 */
export function writeEvidence(root: string, relPath: string, content: string): EvidenceWriteResult {
  // 逐段判越界：只拒**真正的** `..` / 空段 / 绝对路径。
  // 此前是 `relPath.includes('..')` —— 那会把 `a..b` 这种合法文件名一起拒掉
  // （2026-10-08 操作者实测 P2：purposes 里带 `..` 就整条落盘失败，另有几条落成 unnamed.txt）。
  const segments = relPath.split('/');
  if (relPath.startsWith('/') || segments.some((segment) => segment === '' || segment === '.' || segment === '..')) {
    return { ok: false, detail: `拒绝越界的落盘路径：${relPath}` };
  }
  try {
    const full = path.join(root, relPath);
    mkdirSync(path.dirname(full), { recursive: true });
    writeFileSync(full, content, 'utf8');
    return { ok: true, detail: relPath };
  } catch (error) {
    return { ok: false, detail: `证据落盘失败：${error instanceof Error ? error.message : String(error)}` };
  }
}
