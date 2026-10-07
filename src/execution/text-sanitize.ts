/**
 * 入库/回显文本的净化（2026-10-07）。
 *
 * ── 为什么必须做（两份实测报告都撞到）──
 *
 * 目标返回的正文里带 JS 转义序列（`\uXXXX`）或裸 NUL 时，整条结果会因为 **jsonb** 拒绝而入库失败：
 *
 *     audit_unavailable: unsupported Unicode escape sequence
 *
 * 后果比"命令失败"严重得多：命令**已经发出去了**（对目标不再幂等），但结果一个字都没留下，
 * 既无法向人证明第一次发了什么，也无法据此继续判断 —— 等于凭空多一轮流量 + 丢一次证据。
 *
 * ── 规则（只做最小破坏）──
 *
 *   1. 去掉 NUL（`\u0000`）：PostgreSQL 的 `text`/`jsonb` 都不接受它，而它在终端输出里没有语义；
 *   2. 去掉**孤立的代理码点**（lone surrogate）：UTF-8 里没有合法编码，JSON 序列化会产出
 *      `\uD800` 这类非法转义序列，正是报错原文的触发源；
 *   3. **配对**的代理对（真正的 emoji 等）必须原样保留 —— 它们不是问题，误删会把正常内容改坏。
 *
 * 注意：`\uXXXX` 这种**字面文本**（反斜杠 + u + 四个十六进制）是合法内容，不动它。报错的根因是
 * 真的存在非法码点，不是"看起来像转义序列"。
 */

/** 非法码点：NUL 与孤立代理。配对的代理（合法 emoji）保留。 */
export function sanitizeJsonText(text: string): string {
  let result = '';
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    if (code === 0) continue;
    if (code >= 0xd800 && code <= 0xdbff) {
      // 高代理：必须紧跟一个低代理才是合法的 UTF-16 对；否则丢弃。
      const next = i + 1 < text.length ? text.charCodeAt(i + 1) : 0;
      if (next >= 0xdc00 && next <= 0xdfff) {
        result += text[i]! + text[i + 1]!;
        i += 1;
      }
      continue;
    }
    if (code >= 0xdc00 && code <= 0xdfff) continue; // 孤立低代理：丢弃
    result += text[i]!;
  }
  return result;
}

/** 净化是否真的改动了文本（调用方据此决定要不要在结果里标注"已净化"）。 */
export function sanitizeChanged(text: string): boolean {
  return sanitizeJsonText(text) !== text;
}
