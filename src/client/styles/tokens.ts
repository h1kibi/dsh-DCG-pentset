/**
 * 令牌层：**唯一**注入字面颜色的地方（颜色本身在 `../design.ts` 定义）。
 *
 * 三块内容：
 *   1. `@font-face`——随包发的 Cascadia Mono（base64 内联，见 `../fontAssets.ts`）；
 *   2. 令牌块——挂在插件每个根元素上（选择器清单出自 `design.ts`）；
 *   3. 一个极小的基座：根元素的字体、行高、数字对齐。
 *
 * 组件规则（`shell.ts` / `panels.ts` / `chat.ts`）**不允许**出现字面颜色，
 * 只能引用 `var(--pt-*)`；由 `test/client-surfaces.test.ts` 断言。
 */

import { tokenCss } from '../design.ts';
import { FONT_FAMILY, FONT_SRC } from '../fontAssets.ts';

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
