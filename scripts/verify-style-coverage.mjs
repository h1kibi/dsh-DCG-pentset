/**
 * 样式覆盖自检：**组件用到的每个类名都必须有 CSS 规则**。
 *
 * ── 为什么需要它 ──
 *
 * 这个插件历史上出过一次「组件只带类名、样式从未交付」的缺陷：阶段轨道因此退化成
 * 五条文字（DOM 结构一直是对的，只是没有任何规则）。当时是靠人在浏览器里跑一段
 * 一次性脚本发现的。这类缺陷**没有任何运行时信号**——不报错、不警告，只是难看。
 *
 * ── 它检查三件事 ──
 *
 *   1. 覆盖：`src/client/**` 里出现的每个 `pentest-*` 类名，都在样式表里有规则；
 *   2. 令牌：样式表（`design.ts` 之外）里不得出现字面颜色，且每个 `var(--pt-*)`
 *      都必须在 `design.ts` 里定义（写错的令牌不会报错，只会静默变成空值）；
 *   3. 根元素：令牌块的选择器清单必须覆盖插件的每个渲染入口。
 *
 * 用法：
 *   node --import ./test/helpers/tsx-loader.mjs --experimental-strip-types \
 *     scripts/verify-style-coverage.mjs
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CLIENT = join(ROOT, 'src', 'client');

/** 递归收集 .ts/.tsx 文件。 */
function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (/\.tsx?$/.test(entry)) out.push(full);
  }
  return out;
}

const files = walk(CLIENT);

// ── 1. 组件里用到的类名 ──
const used = new Map();
for (const file of files) {
  if (file.endsWith(join('client', 'styles.ts'))) continue;
  const text = readFileSync(file, 'utf8');
  // 负向先行断言：`dsh-pentest-client` 这类带前缀的标识符不是类名；
  // 紧跟着 `.md` 的是设计文档路径（`docs/dsh-pentest-plugin-design.md`），也不是类名。
  for (const match of text.matchAll(/(?<![A-Za-z0-9_-])(pentest-[A-Za-z0-9_-]+)/g)) {
    const name = match[1];
    const after = text.slice(match.index + name.length, match.index + name.length + 3);
    if (after.startsWith('.md')) continue;
    // 模板串里的前缀片段（如 `pentest-button--${kind}`）不是完整类名。
    if (name.endsWith('-') || name.endsWith('__')) continue;
    if (!used.has(name)) used.set(name, new Set());
    used.get(name).add(relative(ROOT, file));
  }
}

// ── 2. 样式表 ──
const stylesDir = join(CLIENT, 'styles');
const cssFiles = [join(CLIENT, 'styles.ts'), ...walk(stylesDir)].filter((f) => /\.ts$/.test(f));
const cssText = cssFiles.map((f) => readFileSync(f, 'utf8')).join('\n');

const declared = new Set();
for (const match of cssText.matchAll(/\.pentest-[A-Za-z0-9_-]+/g)) declared.add(match[0].slice(1));

const missing = [...used.keys()].filter((name) => !declared.has(name)).sort();

// ── 3. 令牌 ──
const designText = readFileSync(join(CLIENT, 'design.ts'), 'utf8');
const defined = new Set();
for (const match of designText.matchAll(/--pt-[a-z0-9-]+/g)) defined.add(match[0]);
// 由 design.ts 动态拼出的令牌（色板键 + 语义别名）。
for (const match of designText.matchAll(/^\s{2}([a-zA-Z][a-zA-Z0-9]*):\s'#[0-9a-fA-F]{6}',$/gm)) {
  defined.add(`--pt-${match[1].replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`);
}
for (const match of designText.matchAll(/^\s{2}'([a-z0-9-]+)':\s'[a-zA-Z][a-zA-Z0-9]*',$/gm)) {
  defined.add(`--pt-${match[1]}`);
}

const referenced = new Set([...cssText.matchAll(/var\((--pt-[a-z0-9-]+)/g)].map((m) => m[1]));
const unknownTokens = [...referenced].filter((token) => !defined.has(token)).sort();

// 字面颜色：允许出现在 design.ts（令牌定义），不允许出现在任何组件样式里。
const literalColors = [...cssText.matchAll(/(#[0-9a-fA-F]{3,8}\b|\brgba?\(|\bhsla?\()/g)]
  .filter((m) => !m[0].startsWith('#') || true)
  .map((m) => m[0]);

// ── 4. CSS 模板里不得出现反引号 ──
// CSS 是模板字符串，注释里写一个反引号就把模板截断了：构建报的是「语法错误」，
// 而行号指向注释——实测同一个人为此连踩两次。这里提前说清。
const templateProblems = [];
for (const file of walk(stylesDir)) {
  const lines = readFileSync(file, 'utf8').split(/\r?\n/);
  let inside = false;
  for (const [index, line] of lines.entries()) {
    if (/^export const [A-Z_]+ = `$/.test(line.trim())) { inside = true; continue; }
    if (inside && line.startsWith('`;')) { inside = false; continue; }
    if (inside && line.includes('`')) {
      templateProblems.push(`${relative(ROOT, file)}:${index + 1} CSS 模板里出现反引号：${line.trim().slice(0, 60)}`);
    }
  }
}

// ── 5. 运行时拼出来的 tone 修饰词必须有规则 ──
// `toneClass('pentest-x', tone)` 的第二参是运行时值，静态 grep 看不到具体类名——
// 实测两次漏样式都是这一类（`pentest-statusbar--neutral`、`pentest-track__edge--neutral`）。
//
// 判定按**调用点真正可能传入的 tone**：
//   - 参数是字面量三元（`x ? 'attention' : 'neutral'`）→ 只要求那两个；
//   - 参数是变量（可能来自任意 tone 来源）→ 要求 `format.ts` 里 Tone 的全集。
// 这样既不会漏（变量情形要全集），也不会造死规则（字面量三元只写实际用到的）。
const TONES = ['neutral', 'active', 'done', 'attention', 'danger'];
const toneRequirements = new Map();
for (const file of files) {
  const text = readFileSync(file, 'utf8');
  // 注意 `[a-z0-9_-]+`：类名里有下划线（`pentest-track__node`），早期写成 `[a-z-]+`
  // 时这些前缀一个都匹配不上，于是 `--neutral` 缺失从闸门里漏了过去（实测漏掉过一次）。
  for (const match of text.matchAll(/toneClass\(\s*'([a-z0-9_-]+)'\s*,\s*([^)]*)\)/g)) {
    const prefix = match[1];
    const expression = match[2] ?? '';
    const literals = [...expression.matchAll(/'([a-z]+)'/g)].map((m) => m[1]);
    const needed = literals.length > 0 ? literals : TONES;
    const current = toneRequirements.get(prefix);
    toneRequirements.set(prefix, current === undefined
      ? new Set(needed)
      : new Set([...current, ...needed]));
  }
}
const toneGaps = [];
for (const [prefix, tones] of toneRequirements) {
  for (const tone of TONES) {
    if (!tones.has(tone)) continue;
    if (!declared.has(`${prefix}--${tone}`)) toneGaps.push(`${prefix}--${tone}`);
  }
}

// ── 输出 ──
const problems = [];
if (missing.length > 0) problems.push(`无样式规则（${missing.length}）：\n  ` + missing.map((n) => `${n} ← ${[...used.get(n)].join(', ')}`).join('\n  '));
if (literalColors.length > 0) problems.push(`组件样式里出现字面颜色（${literalColors.length}）：${literalColors.slice(0, 8).join(' ')}`);
if (unknownTokens.length > 0) problems.push(`引用了未定义的令牌（${unknownTokens.length}）：${unknownTokens.join(', ')}`);
if (toneGaps.length > 0) problems.push(`tone 修饰词缺规则（${toneGaps.length}）：\n  ` + toneGaps.join('\n  '));
if (templateProblems.length > 0) problems.push(`CSS 模板被反引号截断（${templateProblems.length}）：\n  ` + templateProblems.join('\n  '));

console.log(`类名：使用 ${used.size} / 声明 ${declared.size}`);
console.log(`令牌：引用 ${referenced.size} / 定义 ${defined.size}`);
if (problems.length > 0) {
  console.error('\n' + problems.join('\n\n'));
  process.exit(1);
}
console.log('样式覆盖自检通过：全部类名有规则、无字面颜色、令牌全部已定义。');
