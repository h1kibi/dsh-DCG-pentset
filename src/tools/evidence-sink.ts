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
 * 写盘。`root` 是宿主上的挂载根（沙箱里对应 `/work`）；`relPath` 只接受相对路径。
 *
 * **绝不抛**：它是执行后的附带动作，写不进去（目录不可写、磁盘满）不该把一次**已经执行完**
 * 的动作变成失败——那会让模型以为命令没跑、进而重发（对目标再打一次）。
 */
export function writeEvidence(root: string, relPath: string, content: string): EvidenceWriteResult {
  if (relPath.startsWith('/') || relPath.includes('..')) {
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
