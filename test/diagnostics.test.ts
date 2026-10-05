/**
 * 诊断面测试：服务端映射（注入端口，不依赖数据库）+ 卡片渲染（SSR）+ 控制器接线。
 *
 * 三条纪律在此锁定：
 *   1. 「未给作业」与「给了作业」返回的结构不同——不得用零值伪装「没读到」；
 *   2. 审计探针缺省是 `null`（未装配），不是「可写」；
 *   3. 卡片把「尚未读取 / 读取失败 / 读到了」分开渲染（P16）。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createElement } from 'react';
import type { ReactNode } from 'react';

import { PgDiagnosticsService } from '../src/console/diagnostics.ts';
import type { DiagnosticsDeps } from '../src/console/diagnostics.ts';
import { DiagnosticsCard } from '../src/client/views/DiagnosticsCard.tsx';
import { ConsoleController } from '../src/client/controller.ts';
import type { DiagnosticsSnapshot, MemoryWatermark } from '../src/contracts.ts';
import type { OutboxStats } from '../src/memory/outbox.ts';

const FIXED_NOW = new Date('2026-09-19T12:00:00.000Z');

/** 运行时取 `renderToStaticMarkup`（本仓没有 `@types/react-dom`，见 client-memory-views 的说明）。 */
function loadRenderToStaticMarkup(): (node: ReactNode) => string {
  const loaded: unknown = createRequire(import.meta.url)('react-dom/server');
  if (typeof loaded !== 'object' || loaded === null || !('renderToStaticMarkup' in loaded)) {
    throw new Error('react-dom/server 形状不符：缺少 renderToStaticMarkup');
  }
  const candidate = loaded.renderToStaticMarkup;
  if (typeof candidate !== 'function') throw new Error('react-dom/server 的 renderToStaticMarkup 不是函数');
  return (node: ReactNode) => String(Reflect.apply(candidate, loaded, [node]));
}

const renderToStaticMarkup = loadRenderToStaticMarkup();

/** 从宿主信封里取出 `{ method, params }`（窄化而不是断言：线协议是外部输入）。 */
function requestEnvelopeOf(payload: unknown): { readonly method: string; readonly params: unknown } {
  const request = ((): unknown => {
    if (typeof payload !== 'object' || payload === null || !('args' in payload)) return undefined;
    const args: unknown = payload.args;
    if (typeof args !== 'object' || args === null || !('request' in args)) return undefined;
    return args.request;
  })();
  if (
    typeof request !== 'object' ||
    request === null ||
    !('method' in request) ||
    typeof request.method !== 'string'
  ) {
    throw new Error('宿主信封缺少 args.request.method');
  }
  return { method: request.method, params: 'params' in request ? request.params : undefined };
}

const WATERMARK: MemoryWatermark = {
  lastChainSeq: 41,
  occurredAt: '2026-09-19T11:45:00.000Z',
  status: 'lagging',
  detail: null,
  lagEvents: 3,
};

function outboxStub(
  counts: Partial<Record<'pending' | 'leased' | 'done' | 'dead', number>>,
  state: OutboxStats['state'] = 'ready',
): DiagnosticsDeps['outbox'] {
  const full = { pending: 0, leased: 0, done: 0, dead: 0, ...counts };
  return {
    async stats(engagementId: string): Promise<OutboxStats> {
      return {
        engagementId,
        counts: full,
        unfinished: full.pending + full.leased,
        oldestPendingAt: new Date('2026-09-19T11:00:00.000Z'),
        state,
      };
    },
  };
}

// ───────────────────────── 服务端映射（不依赖数据库） ─────────────────────────

test('未给作业：只给实例级事实，engagement 为 null（不得用零值伪装）', async () => {
  const service = new PgDiagnosticsService({
    poolStats: () => ({ totalCount: 3, idleCount: 2, waitingCount: 0 }),
    outbox: outboxStub({ pending: 99 }),
    watermark: async () => {
      throw new Error('未给作业时不应调用水位');
    },
    clock: () => FIXED_NOW,
  });

  const snapshot = await service.getDiagnostics({});

  assert.equal(snapshot.checkedAt, FIXED_NOW.toISOString());
  assert.deepEqual(snapshot.pool, { total: 3, idle: 2, waiting: 0 });
  assert.equal(snapshot.audit, null, '未装配探针必须是 null，而不是「可写」');
  assert.equal(snapshot.engagement, null, '未给作业时不得给出作业级数据');
});

test('给定作业：队列计数、滞后状态、最早可领取时间与水位一起给出', async () => {
  const service = new PgDiagnosticsService({
    poolStats: () => ({ totalCount: 5, idleCount: 1, waitingCount: 2 }),
    audit: { available: async () => ({ writable: false, detail: 'connection terminated' }) },
    outbox: outboxStub({ pending: 2, leased: 1, done: 7, dead: 1 }, 'failed'),
    watermark: async () => WATERMARK,
    clock: () => FIXED_NOW,
  });

  const snapshot = await service.getDiagnostics({ engagementId: 'engagement-1' });

  assert.deepEqual(snapshot.pool, { total: 5, idle: 1, waiting: 2 });
  assert.equal(snapshot.audit?.writable, false, '探针失败必须如实给出，不得吞成通过');
  assert.equal(snapshot.audit?.detail, 'connection terminated');
  assert.deepEqual(snapshot.engagement?.indexQueue, {
    pending: 2,
    leased: 1,
    done: 7,
    dead: 1,
    lagState: 'failed',
    oldestPendingAt: '2026-09-19T11:00:00.000Z',
  });
  assert.deepEqual(snapshot.engagement?.watermark, WATERMARK);
});

// ───────────────────────── 卡片渲染（SSR） ─────────────────────────

const SNAPSHOT: DiagnosticsSnapshot = {
  checkedAt: '2026-09-19T11:59:00.000Z',
  pool: { total: 3, idle: 2, waiting: 1 },
  audit: { writable: true, detail: '' },
  engagement: {
    engagementId: 'engagement-1',
    indexQueue: {
      pending: 2,
      leased: 1,
      done: 7,
      dead: 1,
      lagState: 'failed',
      oldestPendingAt: '2026-09-19T11:00:00.000Z',
    },
    watermark: WATERMARK,
  },
};

test('尚未读取：说明「还没点刷新」，不冒充健康也不冒充失败', () => {
  const html = String(renderToStaticMarkup(createElement(DiagnosticsCard, {
    diagnostics: null,
    onRefresh: () => undefined,
    now: FIXED_NOW,
  })));
  assert.ok(html.includes('尚未读取诊断'));
  assert.ok(!html.includes('role="alert"'), '未读取时不应有错误条');
});

test('读到了：连接池/审计/队列/水位逐项呈现，死信与滞后给 attention/danger', () => {
  const html = String(renderToStaticMarkup(createElement(DiagnosticsCard, {
    diagnostics: SNAPSHOT,
    onRefresh: () => undefined,
    now: FIXED_NOW,
  })));
  assert.ok(html.includes('总 3 / 空闲 2 / 等待 1'));
  assert.ok(html.includes('可写'));
  assert.ok(html.includes('待办 2 / 租约 1 / 完成 7 / 死信 1'));
  assert.ok(html.includes('链序 41'));
  assert.ok(html.includes('滞后 3 条'));
  assert.ok(html.includes('pentest-stat--danger'), '死信 > 0 必须给危险色（§15.5）');
});

test('读取失败：错误条与「尚未读取」分开渲染（P16）', () => {
  const html = String(renderToStaticMarkup(createElement(DiagnosticsCard, {
    diagnostics: null,
    error: { code: 'console/internal', message: '诊断请求失败' },
    onRefresh: () => undefined,
    now: FIXED_NOW,
  })));
  assert.ok(html.includes('console/internal'));
  assert.ok(html.includes('尚未读取诊断'), '失败后卡片本体仍说「尚未读取」，两者语义不同（P16）');
});

test('未选作业：作业级区块不显示，并说明原因', () => {
  const html = String(renderToStaticMarkup(createElement(DiagnosticsCard, {
    diagnostics: { ...SNAPSHOT, engagement: null },
    onRefresh: () => undefined,
    now: FIXED_NOW,
  })));
  assert.ok(html.includes('未选中作业'));
  assert.ok(!html.includes('索引队列（§15.5）'), '没有作业时不画队列区块');
});

// ───────────────────────── 控制器接线 ─────────────────────────

test('controller.diagnostics：未选作业发空参数，选中后带 engagementId', async () => {
  const sent: { readonly method: string; readonly params: unknown }[] = [];
  const controller = new ConsoleController({
    clock: () => FIXED_NOW,
    invoke: async (_channel, _endpoint, payload) => {
      const request = requestEnvelopeOf(payload);
      sent.push({ method: request.method, params: request.params });
      return { ok: true, value: SNAPSHOT };
    },
  });

  await controller.diagnostics();
  assert.deepEqual(sent[0], { method: 'getDiagnostics', params: {} }, '未选作业时不带 engagementId');

  await controller.select('engagement-1');
  await controller.diagnostics();
  const last = sent[sent.length - 1];
  assert.deepEqual(last, { method: 'getDiagnostics', params: { engagementId: 'engagement-1' } });
});
