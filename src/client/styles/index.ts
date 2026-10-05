/**
 * 样式表装配：令牌 → 基座 → 外壳 → 面板 → 会话。
 *
 * 拆成模块的理由是**变更半径**：改放行队列的排版不该碰到阶段轨道，也不该让
 * 两个人同时编辑同一份 700 行的字符串。装配顺序固定（后者可以覆盖前者）。
 */

import { FONT_FACE_CSS, TOKENS_CSS } from './tokens.ts';
import { BASE_CSS } from './base.ts';
import { SHELL_CSS } from './shell.ts';
import { PANELS_CSS } from './panels.ts';
import { CHAT_CSS } from './chat.ts';

/** 注入到页面的完整样式表。 */
export const PENTEST_CSS = [FONT_FACE_CSS, TOKENS_CSS, BASE_CSS, SHELL_CSS, PANELS_CSS, CHAT_CSS]
  .filter((part) => part.length > 0)
  .join('\n');
