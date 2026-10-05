import { test } from 'node:test';
import assert from 'node:assert/strict';

import type { Context } from '@deepseek-ai/cordis';

import { selectPentestPanel } from '../src/client/panel-jump.ts';

const PANEL = 'dsh-pentest-main';

/**
 * 造一个宿主形状的上下文。
 *
 * 关键在 `layout` 这个属性：真实宿主里对它做**属性访问**拿到的东西既不抛错也不生效
 * （静默 stub），只有 `ctx.get('layout')` 才拿到 `LayoutController`。
 * 这里把属性访问做成抛错，就是为了锁住「不许走属性访问」这条约束——
 * 之前的实现正是走属性访问，于是「打开控制台」按钮点了没反应，日志里也没有线索。
 */
function hostCtx(service: unknown): { ctx: Context; warns: string[]; propertyReads: number } {
  const warns: string[] = [];
  const state = { propertyReads: 0 };
  const ctx: Record<string, unknown> = {
    get: (name: string) => (name === 'layout' ? service : undefined),
    logger: Object.assign(() => ({ warn: (message: string) => { warns.push(message); } }), {}),
  };
  Object.defineProperty(ctx, 'layout', {
    get() {
      state.propertyReads += 1;
      throw new Error('undeclared service: layout');
    },
  });
  return { ctx: ctx as unknown as Context, warns, propertyReads: 0 };
}

/** 静默 console.warn（logWarn 会写它），返回恢复函数。 */
function muteConsole(): () => void {
  const original = console.warn;
  console.warn = () => {};
  return () => { console.warn = original; };
}

test('跳转：用 ctx.get 拿到 layout 并真的调用 selectPanel', () => {
  const calls: string[] = [];
  const layout = { selectPanel: (id: string) => { calls.push(id); } };
  const host = hostCtx(layout);
  const restore = muteConsole();
  try {
    selectPentestPanel(host.ctx, PANEL);
  } finally {
    restore();
  }
  assert.deepEqual(calls, [PANEL], '必须把主面板 id 交给宿主：这正是「打开控制台」按钮的行为');
});

test('跳转：服务缺失时只记警告，不抛错也不静默', () => {
  const host = hostCtx(undefined);
  const restore = muteConsole();
  try {
    assert.doesNotThrow(() => { selectPentestPanel(host.ctx, PANEL); });
  } finally {
    restore();
  }
  assert.equal(host.warns.length, 1, '宿主没提供 layout 时必须留下线索（静默降级是上一次的缺陷）');
  assert.match(host.warns[0] ?? '', /layout/);
});

test('跳转：服务形状不对时只记警告；宿主抛错不得变成未捕获异常', () => {
  // (a) 没有 selectPanel
  const missing = hostCtx({ somethingElse: 1 });
  // (b) selectPanel 抛错（主面板未注册时宿主就是这样）
  const throwing = hostCtx({ selectPanel: () => { throw new Error('main panel "x" is not registered'); } });
  const restore = muteConsole();
  try {
    assert.doesNotThrow(() => { selectPentestPanel(missing.ctx, PANEL); });
    assert.doesNotThrow(() => { selectPentestPanel(throwing.ctx, PANEL); });
  } finally {
    restore();
  }
  assert.equal(missing.warns.length, 1);
  assert.equal(throwing.warns.length, 1);
});
