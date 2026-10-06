/**
 * 检索文本投影：**中文双字词投影**（设计 §8.6 要求，长期只有接口没有实现）。
 *
 * ── 为什么需要它（实测）──
 *
 * 全文索引用的是 PostgreSQL 的 `simple` 配置：`to_tsvector('simple', …)` 不切中文，
 * 一整段中文会变成**一个词元**。实测（个人库 138 块）：
 *
 *     to_tsvector('simple','成都理工大学公网网段资产侦查报告')
 *       → '成都理工大学公网网段资产侦查报告':1        ← 整串一个词元
 *     查询「网段」→ 词法路 0 命中 ✗（语义路未启用，中文召回全靠三元组兜底）
 *
 * 投影把每个中文连续段切成**相邻二字组**（bigram），与原文一起进 tsvector：
 *
 *     网段资产 → 「网段资产 网段 段资 资产」        ← 词元各自独立，2 字查询即可命中
 *
 * ── 两条纪律 ──
 *
 * 1. **索引侧与查询侧必须用同一个函数**（否则切出来的词元对不上，等于没做）。
 *    调用点在 `MemoryIndexer`（写 `search_vector` 前）与词法路查询绑定处。
 * 2. **幂等/可重复**：函数对同一文本重复调用只多出重复词元，不会产生错误词元；
 *    但不要对已经投影过的文本再投影一次（会翻倍，无收益）。
 *
 * 只处理 CJK 连续段，ASCII/数字/标点原样保留 —— 英文与端口号路径本来就切得对，
 * 不要动它们（动了会改变现有能命中的查询的行为）。
 */

/** 单个 CJK 字符（**不带 `/g`**：带 `g` 的正则在 `.test()` 里是有状态的，会时对时错）。 */
const CJK_CHAR = /[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF]/u;

/** CJK 统一表意文字（含扩展 A 与兼容区）。只对这些字符做投影。 */
const CJK_RUN = /[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF]+/gu;

/** 单个连续段最多产出多少个二字组（防御异常长的输入把索引吹大）。 */
const MAX_GRAMS_PER_RUN = 4096;

/**
 * 把中文连续段投影成「原文 + 相邻二字组」。
 *
 * 字数 1 的段原样保留（没有二字组可切，查询侧同理 ✓——1 个汉字不该被当成可检索词）。
 */
export function projectCjkBigrams(text: string): string {
  return text.replace(CJK_RUN, (run) => {
    if (run.length < 2) return run;
    const limit = Math.min(run.length - 1, MAX_GRAMS_PER_RUN);
    const grams: string[] = [];
    for (let i = 0; i < limit; i += 1) grams.push(run.slice(i, i + 2));
    return `${run} ${grams.join(' ')}`;
  });
}

/**
 * 查询侧投影：与索引侧同一个函数，但**只保留二字组**（原文不参与词法匹配）。
 *
 * 为什么不带原文：查询侧带上整串原文会让 `plainto_tsquery` 生成一个巨大词元，
 * 只有在文档里恰好出现同一整串时才命中 —— 那不是我们想要的"部分命中"。
 * 保留二字组即可覆盖 2 字及以上的中文查询；1 字查询交给三元组路。
 */
export function projectCjkQuery(text: string): string {
  const trimmed = text.trim();
  if (trimmed === '') return trimmed;
  const projected = projectCjkBigrams(trimmed);
  const grams = projected
    .split(/\s+/)
    .filter((token) => token.length === 2 && CJK_CHAR.test(token.slice(0, 1)));
  const unique: string[] = [];
  const seen = new Set<string>();
  for (const gram of grams) {
    if (seen.has(gram)) continue;
    seen.add(gram);
    unique.push(gram);
  }
  // 没有中文（或只有单字）时原样返回：ASCII 查询本来就切得对，别动它。
  if (unique.length === 0) return trimmed;
  return unique.join(' ');
}
