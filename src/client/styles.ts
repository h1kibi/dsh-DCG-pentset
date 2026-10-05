/**
 * 控制台样式表：**入口、令牌层、装配与注入**。
 *
 * 样式按域拆在 `styles/` 下（基座 / 外壳 / 面板 / 会话）；本文件承担四件事：
 *   1. **令牌层**：`@font-face`（随包发的 Cascadia Mono，base64 内联见 `./fontAssets.ts`）
 *      与令牌块（挂在插件每个根元素上，选择器清单出自 `./design.ts`）——本目录下
 *      **唯一**注入字面颜色的地方；
 *   2. 装配并导出 `PENTEST_CSS`（测试直接读它断言，见 `test/client-surfaces.test.ts`）；
 *   3. 幂等注入（模块工厂在同一页面生命周期里可能执行两次——HMR 或重复挂载）；
 *   4. 提供 `installConsoleStyles` 的降级语义（没有 DOM 时不抛，服务端渲染与测试都能用）。
 *
 * 装配顺序固定：令牌 → 基座 → 外壳 → 面板 → 会话（后者可以覆盖前者）。
 *
 * ── 视觉方向（2026-10-04 人类确认）──
 *
 * 深色 CRT 仪表盘（天蓝强调）、单主题、中等动效。令牌与设计说明在 `design.ts`：
 * 颜色**只在那里定义一次**，本目录下的所有规则只允许引用 `var(--pt-*)`。
 * 这条由 `test/client-surfaces.test.ts`（组件样式零字面颜色）与
 * `scripts/verify-style-coverage.mjs`（类名覆盖与令牌定义）两道闸门锁住。
 */

import { tokenCss } from './design.ts';
import { FONT_FAMILY, FONT_SRC } from './fontAssets.ts';
import { BASE_CSS } from './styles/base.ts';
import { SHELL_CSS } from './styles/shell.ts';
import { PANELS_CSS } from './styles/panels.ts';
import { CHAT_CSS } from './styles/chat.ts';

/**
 * 内联字体。
 *
 * `font-display:swap`：字体没就绪时先用等宽回退栈渲染，不做不可见文本占位——
 * 这是本地面板，字节已经到了，swap 只会让首帧更快。
 */
export const FONT_FACE_CSS =
  `@font-face{font-family:"${FONT_FAMILY}";` +
  `src:url(${FONT_SRC}) format("truetype");` +
  `font-weight:400;font-style:normal;font-display:swap}`;

/** 令牌块。 */
export const TOKENS_CSS = tokenCss();

/** 注入到页面的完整样式表。 */
export const PENTEST_CSS = [FONT_FACE_CSS, TOKENS_CSS, BASE_CSS, SHELL_CSS, PANELS_CSS, CHAT_CSS]
  .filter((part) => part.length > 0)
  .join('\n');

/** 样式节点标记：同一个文档只插一次。 */
const STYLE_MARKER = 'data-pentest-style';
const STYLE_ID = 'dsh-pentest-console';

/**
 * 把样式注入文档。
 *
 * `doc` 参数是为了可测与可降级：没有 `document` 时不抛（服务端渲染、测试环境），
 * 调用方不需要为「有没有 DOM」写分支。
 *
 * @returns 无 DOM 时返回 `null`；否则返回一个「仅在本次确实插入时」才移除节点的清理函数。
 */
export function installConsoleStyles(doc: Document | undefined): (() => void) | null {
  if (doc === undefined) return null;

  const existing = doc.querySelector(`style[${STYLE_MARKER}="${STYLE_ID}"]`);
  if (existing !== null) {
    // 已注入：什么也不做，也不在卸载时移除别人的节点——模块工厂可能被执行多次，
    // 后一次执行不该带走前一次留下的样式。
    return null;
  }

  const style = doc.createElement('style');
  style.setAttribute(STYLE_MARKER, STYLE_ID);
  style.textContent = PENTEST_CSS;
  doc.head.appendChild(style);

  return () => {
    style.remove();
  };
}
