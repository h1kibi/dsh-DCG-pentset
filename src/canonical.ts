/**
 * 内容哈希的规范 JSON：**递归按键排序**后序列化，值保真。
 *
 * ── 为什么需要它 ──
 *
 * 内容哈希（技能正文、交接包、草稿）必须只取决于**值**，不能取决于「谁序列化、
 * 按什么顺序」：同一份内容在写入侧与读回侧算出的字符串必须一致。而对象键序不是值的一部分——
 * 更糟的是 `jsonb` 列**不保留键序**（PostgreSQL 按「长度 + 字节序」重排、并去重），
 * 于是「写入时按 JS 插入顺序、读回时按 jsonb 顺序」会让同一份内容算出两个摘要，
 * 人类看到的、库里存的、事后复算的三者永远对不上（2026-10-05 实测：交接草稿
 * `stored ≠ recomputed`）。
 *
 * 本模块此前以两份复制存在（`agents/capability.ts` 的技能内容哈希与
 * `workflow/handoff.ts` 的交接哈希）；合并到一处后，差异只有调用点。
 *
 * ── 与 `memory/hash.ts` 的 `canonicalize()` 的区别（**不要**混用）──
 *
 * | | 本模块 `canonicalJson` | `memory/hash.ts` `canonicalize` |
 * |---|---|---|
 * | 用途 | 内容哈希（技能/交接/草稿） | 账本事件哈希与批次签名（§9.5） |
 * | 遇到 `Date`/`Map`/类实例 | 按普通对象/`toJSON` 处理（数据来自 jsonb，形状简单） | **一律拒绝**：静默丢弃等于给哈希开洞 |
 * | 遇到 `undefined` | 对象里跳过该键（与 `JSON.stringify` 一致）、数组里写 `null` | 一律拒绝 |
 *
 * 账本那条更严是因为它防的是**伪造**（攻击者构造形状怪异的 payload 让哈希覆盖不全）；
 * 内容哈希防的是**漂移**（同一份内容两侧算子不一致）。两者目标不同，因此是两个函数。
 *
 * 仓库里还有第三个变体：`console/rpc.ts` 的私有 `canonicalJson(value, path, seen)`——
 * 它服务于 RPC 信封的参数校验，需要**循环引用检测**与**出错的路径**，因此形状不同。
 * 三者的分工是刻意的：本模块只做「键排序 + 值保真」，不接受循环引用也不需要路径诊断。
 */

/**
 * 规范化序列化：对象键升序、数组保持原序、`undefined` 按 `JSON.stringify` 语义处理。
 *
 * 数组顺序**必须保留**：引用优先级、工具允许列表的顺序都有语义，排序会抹掉事实。
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value) ?? 'null';
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(',')}}`;
}
