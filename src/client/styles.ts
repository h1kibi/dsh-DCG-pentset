/**
 * 控制台样式表：**入口与注入**。
 *
 * 样式本身按域拆在 `styles/` 下（令牌 / 基座 / 外壳 / 面板 / 会话），本文件只做三件事：
 *   1. 装配并导出 `PENTEST_CSS`（测试直接读它断言，见 `test/client-surfaces.test.ts`）；
 *   2. 幂等注入（模块工厂在同一页面生命周期里可能执行两次——HMR 或重复挂载）；
 *   3. 提供 `installConsoleStyles` 的降级语义（没有 DOM 时不抛，服务端渲染与测试都能用）。
 *
 * ── 视觉方向（2026-10-04 人类确认）──
 *
 * 深色 CRT 仪表盘（天蓝强调）、单主题、中等动效。令牌与设计说明在 `design.ts`：
 * 颜色**只在那里定义一次**，本目录下的所有规则只允许引用 `var(--pt-*)`。
 * 这条由 `test/client-surfaces.test.ts`（组件样式零字面颜色）与
 * `scripts/verify-style-coverage.mjs`（类名覆盖与令牌定义）两道闸门锁住。
 */

import { PENTEST_CSS } from './styles/index.ts';

export { PENTEST_CSS };

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
