import type { Context } from '@deepseek-ai/cordis';

import { logWarn } from './log.ts';
import { describeError } from '../contracts.ts';

/**
 * 跳到渗透作业主面板（常驻状态条与卡片上的「打开控制台」都走这里）。
 *
 * ── 为什么用 `ctx.get('layout')` 而不是 `ctx.layout` ──
 *
 * `layout` 刻意**不放进模块的 `inject`**：`inject` 是**等待**语义——列出的服务不出现，
 * 整个客户端插件就永不 apply 且不报任何错。一个「点击跳转」的便利能力不值得那个风险。
 *
 * 但「容错读取」不能写成属性访问：宿主里 `ctx.layout` 拿到的东西**既不抛错也不生效**，
 * 于是点击静默失效——人类看到的现象就是「按钮点了没反应」，而日志里连一行线索都没有。
 * `ctx.get(name)` 的契约正好是这里需要的：**不需要 inject、不抛错**，服务缺失时返回
 * `undefined`，服务存在时返回实现本身。
 *
 * 宿主确实提供 `layout`：`@deepseek-ai/dsh-client-ui-layout` 用
 * `ctx.reflect.provide('layout', …)` 注册 `LayoutController`，侧栏也是用它跳的
 * （`ctx.layout.selectPanel(id)`，要求 id 已在 `main` 点位注册）。
 */
export function selectPentestPanel(ctx: Context, panelId: string): void {
  try {
    const layout: unknown = ctx.get('layout');
    if (layout === null || layout === undefined || typeof layout !== 'object') {
      logWarn(ctx, '宿主未提供 layout 服务：无法跳转到主面板（请用侧栏「渗透作业」入口）');
      return;
    }
    if (!('selectPanel' in layout)) {
      logWarn(ctx, 'layout 服务没有 selectPanel：无法跳转主面板（请用侧栏「渗透作业」入口）');
      return;
    }
    // 形状逐个用 `in` + `typeof` 确认，不做内联断言：宿主服务的形状不是我们声明的。
    const select: unknown = layout.selectPanel;
    if (typeof select !== 'function') {
      logWarn(ctx, 'layout.selectPanel 不是函数：无法跳转主面板（请用侧栏「渗透作业」入口）');
      return;
    }
    // 未注册的主面板会让宿主抛错（`layout.selectPanel: main panel "…" is not registered`）。
    // 那是宿主事实，不该把点击变成未捕获异常。
    select.call(layout, panelId);
  } catch (error) {
    logWarn(ctx, `跳转渗透作业主面板失败（不影响其它功能）：${describeError(error)}`);
  }
}
