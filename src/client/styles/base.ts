/**
 * 基座层：字面意义上的「这台终端长什么样」。
 *
 * 包含四类，全部按根元素作用域，绝不落到 `:root`（宿主也是同一个 DOM）：
 *   - 排版基座：中文走宿主同源无衬线，等宽字体只给标识/数字/命令；
 *   - 交互基座：选区、聚焦环、滚动条——这三处最容易被忽略，也最影响"手感"；
 *   - 动效原材料：`@keyframes`（开机错落、光标闪烁、扫描、等待脉冲）；
 *   - 可达性：`prefers-reduced-motion` 一次性关掉全部动画。
 *
 * ── 两个选择器常量，别用错 ──
 *
 * `ROOTS`（逗号分隔的清单）只能当作**完整选择器**用：`${ROOTS}{…}`。
 * `ROOT`（`:is(清单)`）才是可以加后缀/后代的那个：`${ROOT} ::selection`、`${ROOT} *`。
 *
 * 实测踩过：早期写成 `${ROOTS} ::selection`——逗号清单被当成了选择器前缀，于是
 * **除最后一项以外的根元素自己**拿到了后面那段声明。滚动条规则里的 `width:10px`
 * 就这么落到了 `.pentest-mainpanel` 身上，把主面板压成 35px 宽（10px 内容宽 +
 * 24px 内边距）——界面看起来一片空白，而源码里毫无异常。
 * `test/client-surfaces.test.ts` 有一条断言专门锁这个形状。
 */

import { TOKEN_ROOT_SELECTOR } from '../design.ts';

/** 根元素清单：只能整体当选择器用。 */
const ROOTS = TOKEN_ROOT_SELECTOR;
/** 任意根元素：可加后缀与后代。 */
const ROOT = `:is(${TOKEN_ROOT_SELECTOR})`;

export const BASE_CSS = `
${ROOTS}{font-family:var(--pt-font-sans);font-size:12.5px;line-height:1.6;color:var(--pt-fg);font-variant-numeric:tabular-nums;-webkit-font-smoothing:antialiased;text-rendering:optimizeLegibility}
${ROOT} *{box-sizing:border-box}
${ROOT} ::selection{background:var(--pt-select)}
${ROOT} :focus-visible{outline:1px solid var(--pt-accent);outline-offset:1px}
${ROOT} :where(button,input,textarea,select){font-family:inherit;font-size:inherit;color:inherit}
${ROOT} :where(code,kbd,pre,samp,.pentest-mono){font-family:var(--pt-font-mono);font-variant-ligatures:none}
${ROOT} :where(h1,h2,h3,h4,p,ul,ol){margin:0}
${ROOT} :where(a){color:var(--pt-info);text-decoration:none;border-bottom:1px solid var(--pt-line)}
${ROOT} :where(a:hover){border-bottom-color:var(--pt-info)}
${ROOT}::-webkit-scrollbar{width:10px;height:10px}
${ROOT}::-webkit-scrollbar-track{background:var(--pt-bg-well)}
${ROOT}::-webkit-scrollbar-thumb{background:var(--pt-line);border:2px solid var(--pt-bg-well)}
${ROOT}::-webkit-scrollbar-thumb:hover{background:var(--pt-accent-dim)}

@keyframes pt-boot{from{opacity:0;transform:translateY(4px)}to{opacity:1;transform:none}}
@keyframes pt-blink{0%,48%{opacity:1}49%,100%{opacity:0}}
@keyframes pt-sweep{from{transform:translateY(-100%)}to{transform:translateY(1400%)}}
@keyframes pt-wait{0%,100%{box-shadow:0 0 0 1px var(--pt-wait-line);opacity:1}50%{box-shadow:var(--pt-glow-wait);opacity:.86}}
@keyframes pt-alarm{0%,100%{box-shadow:0 0 0 1px var(--pt-danger-line);opacity:1}50%{box-shadow:var(--pt-glow-danger);opacity:.84}}

/* 降低动效：一次性关掉所有动画，只保留颜色过渡（那是状态可读性的一部分）。 */
@media (prefers-reduced-motion:reduce){
${ROOT} *{animation:none !important;transition-duration:1ms !important}
}
`;
