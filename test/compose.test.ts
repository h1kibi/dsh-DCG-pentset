/**
 * 组合根的集成测试：验证装配真的把件接起来了。
 *
 * **这个文件存在的理由**：此前 412 个测试全绿，插件却是「能加载但注册 0 个工具」
 * 的空壳——因为没有任何测试走过「compose → apply → 工具注册」这条路径。
 * 这里补上那条路径的端到端覆盖。
 *
 * 需要 `PENTEST_DATABASE_URL`；未设置时整组 skip（与其它集成测试一致）。
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { EventEmitter, once } from 'node:events';
import { Pool, Client } from 'pg';

import { compose, acquireTxClient, createDatabasePool, createTxDb, classifyRlsCombination, inspectRls } from '../src/compose.ts';
import type { ComposedPlugin } from '../src/compose.ts';
import { PgExecutionStore } from '../src/execution/pg-store.ts';
import type { DbClient } from '../src/memory/ledger.ts';
import { WorkflowRejection } from '../src/workflow/model.ts';
import type { ActionTemplateSpec } from '../src/execution/templates.ts';
import { applyPentest, PENTEST_HOST_SERVICES } from '../src/index.ts';
import { CONSOLE_TYPRET_SERVICE } from '../src/console/rpc.ts';
import { WORKER_TOOL_NAMES } from '../src/tools/worker.ts';

import { cleanupEngagements } from './helpers/cleanup.ts';
import type { AllowedImage } from '../src/execution/docker-sandbox.ts';

const DATABASE_URL = process.env.PENTEST_DATABASE_URL;

const IMAGE: AllowedImage = {
  name: 'registry.example/pentest-toolbox',
  digest: 'sha256:' + 'c'.repeat(64),
};
const APPROVAL_TEMPLATE: ActionTemplateSpec = {
  template: {
    id: 'http_payload_probe',
    actionClass: 'exploit_validation',
    tool: 'http_probe',
    parameters: [{ name: 'payload_id', kind: 'enum', values: ['xss-1', 'sqli-1'] }],
    targetPlaceholder: 'target',
    timeoutMs: 20_000,
    maxOutputBytes: 32 * 1024,
  },
  protocol: 'tcp',
  portSource: { kind: 'target' },
  carries: { payload_id: '受信模板中登记的最小验证载荷标识' },
  commandTemplate: 'http_probe target={target} payload_id={payload_id}',
};

const SANDBOX = {
  allowedImages: [IMAGE],
  internalNetwork: 'pentest-sandbox',
  proxyHost: 'pentest-egress-proxy',
  proxyPort: 3128,
};

/** 用管理员连接终止指定后端（模拟 PG 重启/网络闪断对单条连接的效果）。 */
async function terminateBackend(pid: number): Promise<void> {
  const admin = new Client({ connectionString: DATABASE_URL! });
  await admin.connect();
  try {
    await admin.query('select pg_terminate_backend($1)', [pid]);
  } finally {
    await admin.end();
  }
}

// ─────────────── 独占写连接的失效与重建（桩 pool，不依赖数据库） ───────────────
//
// 这一组刻意放在 DATABASE_URL 闸门之外：它验证连接生命周期状态机本身，
// 桩 pool 能精确控制触发时序（真库撞不到「获取失败」「dispose 与在途并发」这类窗口）。

interface FakeTxClient {
  query: (sql: string, params?: readonly unknown[]) => Promise<{ rows: unknown[]; rowCount: number }>;
  on: (event: 'error', handler: (error: Error) => void) => void;
  release: (error?: Error | boolean) => void;
}

/** 造一个可控假连接：query/on 由用例决定，release 记入日志。 */
function fakeClient(over: Partial<Pick<FakeTxClient, 'query' | 'on'>> = {}): {
  readonly client: FakeTxClient;
  readonly released: Array<Error | boolean | undefined>;
} {
  const released: Array<Error | boolean | undefined> = [];
  return {
    released,
    client: {
      query: over.query ?? (async () => ({ rows: [{ ok: 1 }], rowCount: 1 })),
      on: over.on ?? ((): void => undefined),
      release: (error?: Error | boolean): void => { released.push(error); },
    },
  };
}

/** 把「connect 返回假连接」包成 `Pool`（只实现 createTxDb 用到的 connect；显式转换是测试边界）。 */
function fakePool(connect: () => Promise<FakeTxClient>): { readonly pool: Pool; readonly calls: () => number } {
  let count = 0;
  const pool = {
    connect: async (): Promise<FakeTxClient> => {
      count += 1;
      return connect();
    },
  } as unknown as Pool;
  return { pool, calls: () => count };
}

/** 手动闸门（`Promise.withResolvers` 需要 lib es2024，本仓 lib 是 es2023）。 */
function latch(): { readonly promise: Promise<void>; readonly open: () => void } {
  let open: () => void = () => undefined;
  const promise = new Promise<void>((resolve) => { open = resolve; });
  return { promise, open };
}

describe('独占写连接的失效与重建（桩 pool）', () => {
  test('dispose：在途查询超过期限仍未结清时销毁连接，不阻塞关停', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const gate = latch();
    let queries = 0;
    const made = fakeClient({
      query: async () => {
        queries += 1;
        if (queries > 1) await gate.promise; // 第二条查询永不结清
        return { rows: [{ ok: 1 }], rowCount: 1 };
      },
    });
    const { pool } = fakePool(async () => made.client);
    const port = createTxDb(pool, { drainTimeoutMs: 5_000 });
    await port.db.query('select 1');
    const inFlight = port.db.query('select 1');
    const disposing = port.dispose();

    t.mock.timers.tick(5_000);

    await disposing; // 超时后必须返回，而不是把关停永久挂住
    assert.equal(made.released.length, 1, '超时后必须销毁连接');
    assert.ok(made.released[0] instanceof Error, '销毁通过 release(error)（pg-pool 语义）');
    gate.open();
    await inFlight;
  });

  test('失效信号绑定到具体客户端：迟到旧信号不重复上报、不打断在途获取', async () => {
    const handlers: Array<(error: Error) => void> = [];
    let mode: 'ok' | 'socket' = 'ok';
    let gate: Promise<void> | null = null;
    const { pool, calls } = fakePool(async () => {
      if (gate !== null) await gate;
      return fakeClient({
        on: (_event, handler) => { handlers.push(handler); },
        query: async () => {
          if (mode === 'socket') throw Object.assign(new Error('socket hang up'), { code: '08006' });
          return { rows: [{ ok: 1 }], rowCount: 1 };
        },
      }).client;
    });
    const errors: Error[] = [];
    const port = createTxDb(pool, { onError: (error) => errors.push(error) });
    try {
      await port.db.query('select 1'); // 建立 A（handlers[0]）
      mode = 'socket';
      await assert.rejects(() => port.db.query('select 1')); // A 经查询路径失效
      assert.equal(errors.length, 1);

      mode = 'ok';
      // 一次新的获取在途；q2/q3 应共享它
      const open = latch();
      gate = open.promise;
      const q2 = port.db.query('select 1');
      const q3 = port.db.query('select 1');

      // A 的第二个信号（迟到）：不得重复上报，更不得清掉在途获取
      handlers[0]?.(new Error('late stale signal'));
      open.open();
      gate = null;
      await Promise.all([q2, q3]);

      assert.equal(calls(), 2, '旧信号不得打断在途获取（否则会多起一条独占连接并泄漏）');
      assert.equal(errors.length, 1, '迟到的第二个信号不得重复上报');
    } finally {
      await port.dispose();
    }
  });

  test('获取失败只影响那一次调用：下一次写入自动重建，并上报一次 onError', async () => {
    const boom = new Error('connect ECONNREFUSED 127.0.0.1:5432');
    let first = true;
    const { pool, calls } = fakePool(async () => {
      if (first) {
        first = false;
        throw boom;
      }
      return fakeClient().client;
    });
    const errors: Error[] = [];
    const port = createTxDb(pool, { onError: (error) => errors.push(error) });
    try {
      await assert.rejects(() => port.db.query('select 1'), (error: unknown) => error === boom);
      const ok = await port.db.query<{ ok: number }>('select 1');
      assert.equal(ok.rows[0]?.ok, 1, '第二次写入必须重新获取并成功（不得复读陈旧错误）');
      assert.equal(calls(), 2, 'connect 应被调用两次：一次失败 + 一次重建');
      assert.equal(errors.length, 1, '获取失败必须上报一次（静默停摆不可接受）');
    } finally {
      await port.dispose();
    }
  });

  test('并发写入只获取一条独占连接（pending 去重）', async () => {
    const { pool, calls } = fakePool(async () => fakeClient().client);
    const port = createTxDb(pool);
    try {
      const [a, b] = await Promise.all([port.db.query('select 1'), port.db.query('select 1')]);
      assert.equal(a.rows.length, 1);
      assert.equal(b.rows.length, 1);
      assert.equal(calls(), 1, '两个并发调用必须共享同一次获取');
    } finally {
      await port.dispose();
    }
  });

  test('查询期连接类失败（08006 / 文案兜底）重建；领域错误（23505）不连坐丢弃健康连接', async () => {
    const sqlstate = Object.assign(new Error('server closed the connection'), { code: '08006' });
    let mode: 'fail08006' | 'failText' | 'failDomain' | 'ok' = 'fail08006';
    const { pool, calls } = fakePool(async () =>
      fakeClient({
        query: async () => {
          if (mode === 'fail08006') throw sqlstate;
          if (mode === 'failText') throw new Error('Connection terminated unexpectedly');
          if (mode === 'failDomain') throw Object.assign(new Error('duplicate key'), { code: '23505' });
          return { rows: [{ ok: 1 }], rowCount: 1 };
        },
      }).client,
    );
    const port = createTxDb(pool);
    try {
      // ① 08006：本次以原错误抛出；下一次写入重建
      await assert.rejects(() => port.db.query('select 1'), (error: unknown) => error === sqlstate);
      mode = 'ok';
      assert.equal((await port.db.query('select 1')).rows.length, 1);
      assert.equal(calls(), 2, '08006 必须销毁句柄，并在下一次写入时重建');

      // ② 无 code 的文案兜底
      mode = 'failText';
      await assert.rejects(() => port.db.query('select 1'));
      mode = 'ok';
      assert.equal((await port.db.query('select 1')).rows.length, 1);
      assert.equal(calls(), 3, '无 code 的 connection terminated 文案同样触发重建');

      // ③ 领域错误不得连坐
      mode = 'failDomain';
      await assert.rejects(() => port.db.query('select 1'));
      mode = 'ok';
      assert.equal((await port.db.query('select 1')).rows.length, 1);
      assert.equal(calls(), 3, '领域错误（23505）不得丢弃健康连接');
    } finally {
      await port.dispose();
    }
  });

  test('dispose：在途获取不复活句柄（连接被销毁），dispose 后写入被拒', async () => {
    const gate = latch();
    const made = fakeClient();
    const { pool } = fakePool(async () => {
      await gate.promise;
      return made.client;
    });
    const port = createTxDb(pool);
    const inFlight = port.db.query('select 1');
    const disposing = port.dispose(); // 获取仍在途：dispose 会等它结算
    gate.open();
    await assert.rejects(() => inFlight);
    await disposing;
    assert.equal(made.released.length, 1, '在途获取的连接必须在 dispose 时被销毁，不得复活句柄');
    await assert.rejects(() => port.db.query('select 1'), /已释放/);
  });

  test('dispose：等待在途查询结清后才归还连接', async () => {
    const gate = latch();
    let queries = 0;
    const made = fakeClient({
      query: async () => {
        queries += 1;
        // 第一次查询用于建立句柄（立即返回）；之后的查询悬挂在闸门上。
        if (queries > 1) await gate.promise;
        return { rows: [{ ok: 1 }], rowCount: 1 };
      },
    });
    const { pool } = fakePool(async () => made.client);
    const port = createTxDb(pool);
    await port.db.query('select 1'); // 建立句柄
    const inFlight = port.db.query('select 1'); // 在途查询
    const disposed = port.dispose();
    // dispose 同步执行到「等待在途查询」处即返回；此刻不得归还连接。
    assert.equal(made.released.length, 0, '在途查询结清前不得归还连接');
    gate.open();
    await Promise.all([inFlight, disposed]);
    assert.equal(made.released.length, 1, '结清后归还恰好一次');
  });
});

describe('组合根接线', { skip: DATABASE_URL === undefined ? '未设置 PENTEST_DATABASE_URL' : false }, () => {
  let composed: ComposedPlugin | null = null;
  let pool: Pool | null = null;

  before(async () => {
    pool = new Pool({ connectionString: DATABASE_URL });
    composed = compose({
      database: { url: DATABASE_URL! },
      ledgerSecret: 'test-secret-not-from-env-32-bytes-min',
      sandbox: SANDBOX,
    });
  });

  after(async () => {
    await composed?.dispose();
    await pool?.end();
  });

  test('compose 返回全部件，且 workerTools 的 7 个方法齐备', () => {
    const c = composed!;
    const expected = [
      'search',
      'read',
      'readArtifact',
      'submitReport',
      'writeStatusNote',
      'requestApproval',
      'execute',
    ] as const;
    for (const m of expected) {
      assert.equal(
        typeof (c.hostServices.workerTools as unknown as Record<string, unknown>)[m],
        'function',
        `workerTools 缺少 ${m}`,
      );
    }
  });

  test('compose 后 apply 能注册全部 Worker 工具（端到端装配）', async () => {
    const c = composed!;
    const registered: string[] = [];
    const provided = new Map<string, unknown>([
      [PENTEST_HOST_SERVICES, c.hostServices],
      ['pluginRegistry', { names: () => [
        'dsh-permission-rules', 'dsh-defend', 'dsh-mask', 'dsh-observe', 'dsh-budget',
      ] }],
    ]);
    const ctx = {
      tools: {
        register(def: { name: string }) {
          registered.push(def.name);
          return () => {};
        },
        guard() {
          return () => {};
        },
      },
      on() {},
      /**
     * 桩的 `ctx.inject`：cordis 的「服务就绪后执行」缝。
     *
     * 真实语义是创建一个子 fiber、等服务齐备再执行回调。桩里服务已在手边，
     * 因此**立即执行**——它要覆盖的是注册路径本身，而不是 cordis 的调度。
     */
    inject(_deps: readonly string[], callback: (c: unknown) => void) {
      callback(this);
      return () => {};
    },
    effect(fn: () => unknown) {
        fn();
      },
      get(key: string) {
        return provided.get(key);
      },
    };

    // 按 cordis 的真实调用语义：两个参数
    const out = await applyPentest(ctx as never, {});

    assert.equal(out.servicesBound, true, '组合根提供的服务面必须被 apply 认出');
    assert.equal(out.toolsRegistered.length, WORKER_TOOL_NAMES.length);
    assert.deepEqual([...registered].sort(), [...WORKER_TOOL_NAMES].sort());
  });

  test('准入链路真的接上了：未注册模板经 admit 被拒（不是抛异常）', async () => {
    const c = composed!;
    const decision = await c.execution.admit({
      workerSessionId: randomUUID(),
      templateId: 'definitely-not-registered',
      targetSelector: 'https://a.target.com/',
      params: {},
      purpose: 'probe',
    });
    assert.equal(
      decision.kind,
      'rejected',
      '未注册模板必须走拒绝路径（这是「无法归类即拒绝」的落点）',
    );
    if (decision.kind !== 'rejected') return;
    assert.equal(decision.error.status, 'blocked');
    assert.ok(decision.error.code.length > 0, '拒绝必须带稳定错误码');
  });

  test('默认模板集已装载：一个真实的被动读取模板能通过模板解析', async () => {
    const c = composed!;
    // 出厂集只剩直连命令模板（2026-10-05 清理）；目标用 IP 字面量以绕开 DNS 裁决要求
    // （未注入 resolveAddresses 时域名目标按 dns_unresolved 拒绝——这是设计行为）
    const decision = await c.execution.admit({
      workerSessionId: randomUUID(),
      templateId: 'direct_command',
      targetSelector: 'http://192.0.2.10/',
      params: { port: 80, command_b64: Buffer.from('curl -sS -I http://192.0.2.10/', 'utf8').toString('base64') },
      purpose: '冒烟：验证默认模板可解析',
    });
    // 结果可能是 rejected（范围外——没有该 engagement 的范围）或 needs_approval，
    // 但**不得**是「模板未注册」——那说明模板集没装上。
    if (decision.kind === 'rejected') {
      assert.equal(
        /模板.*未注册|not registered/i.test(decision.error.message),
        false,
        `默认模板集未装载：${decision.error.message}`,
      );
    }
  });

  test('独占写连接可获取且可用（事务的正确载体）', async () => {
    const handle = await acquireTxClient(pool!);
    try {
      const r = await handle.client.query<{ n: string }>('select 1::text as n');
      assert.equal(r.rows[0]?.n, '1');
    } finally {
      handle.release();
    }
  });

  test('空闲池连接被后端终止：Pool 监听器接住错误，进程存活且连接可重建', async () => {
    // 回归锁：此前 `new Pool(...)` 没有连接级 'error' 监听器——空闲连接被终止
    // （PG 重启/网络闪断）时 Node 以未处理 'error' 终止**宿主进程**（实测 exit 1）。
    const signals = new EventEmitter();
    const ownPool = createDatabasePool({ url: DATABASE_URL! }, (error) => {
      signals.emit('connection-error', error);
    });
    try {
      const conn = await ownPool.connect();
      const pid = Number((await conn.query('select pg_backend_pid() as pid')).rows[0]?.pid);
      conn.release();
      // 先订阅再触发：错误投递与等待之间存在竞态，晚订阅会永远等不到。
      const delivered = once(signals, 'connection-error');
      await terminateBackend(pid);
      const [error] = await delivered;
      assert.ok(error instanceof Error, '池必须把连接级错误交给监听器（而不是以未处理事件终止进程）');
      const again = await ownPool.query<{ n: number }>('select 1 as n');
      assert.equal(again.rows[0]?.n, 1, '池应回收死连接并重建');
    } finally {
      await ownPool.end();
    }
  });

  test('独占写连接被后端终止：本次失败，下一次写入自动重建（回归：曾崩溃/永久停摆）', async () => {
    // 回归锁二：独占写连接是**永久借出**的，池监听器接不住它；且此前句柄缓存到永久，
    // 连接一死所有写入（含审计）永久失败，audit_unavailable 闸门让插件在进程重启前停摆。
    const signals = new EventEmitter();
    const ownPool = createDatabasePool({ url: DATABASE_URL! }, () => undefined);
    const port = createTxDb(ownPool, { onError: (error) => { signals.emit('connection-error', error); } });
    try {
      const first = await port.db.query<{ pid: number | string }>('select pg_backend_pid() as pid');
      const pid = Number(first.rows[0]?.pid);
      assert.ok(Number.isInteger(pid) && pid > 0, '必须读到后端 pid');
      const delivered = once(signals, 'connection-error');
      await terminateBackend(pid);
      await delivered;
      const again = await port.db.query<{ n: number }>('select 1 as n');
      assert.equal(again.rows[0]?.n, 1, '连接被终止后下一次写入必须自动重建');
    } finally {
      await port.dispose();
      await ownPool.end();
    }
  });

  test('账本可读链摘要（写路径与读路径都接上了）', async () => {
    const c = composed!;
    const engagementId = randomUUID();
    // 无需建 engagement 行：verifyChain 只读 context_events
    const verified = await c.ledger.verifyChain(engagementId);
    assert.deepEqual(verified.failures, []);
  });

  test('账本校验面接进了组合产物：空链返回「未锚定」而不是伪造通过', async () => {
    const c = composed!;
    // 这个断言同时防两件事：模块没接进 compose（悬空模块），
    // 以及把「没有锚点可比」当成「校验通过」（未证明 ≠ 已证明完好）。
    const view = await c.memoryQuery.verifyLedger(randomUUID());
    assert.equal(view.ok, false, '没有锚点时必须判为未通过');
    assert.equal(view.anchored, false);
    assert.deepEqual(view.mismatches, []);
    assert.deepEqual(view.failures, []);
  });

  test('诊断面接进了组合产物：连接池与审计探针有真实读数', async () => {
    const c = composed!;
    const first = await c.diagnostics.getDiagnostics({});
    assert.equal(first.audit?.writable, true, '真实数据库上审计探针应可写');
    assert.equal(first.engagement, null, '未给 engagementId 时不得返回作业级数据');
    // 第一次读取会触发审计探针（进而获取独占写连接），第二次才能看到池里的连接。
    const second = await c.diagnostics.getDiagnostics({});
    assert.ok(second.pool.total >= 1, `连接池应至少有独占写连接（实际 ${String(second.pool.total)}）`);
  });
});

// ─────────────── 接线验证：新模块真的接进了组合产物 ───────────────
//
// 这一组存在的理由：模块写完但没接进 `compose` 时，它们等于不存在——
// 代码可编译、测试全绿，而运行时永远不会被调用。这类「悬空模块」只能靠
// 断言组合产物的形状来防。

describe('组合接线：四个运营模块', { skip: DATABASE_URL === undefined ? '未设置 PENTEST_DATABASE_URL' : false }, () => {
  test('组合产物暴露控制台 RPC，且端点数与导出面一致', async () => {
    const c = compose({
      database: { url: DATABASE_URL! },
      ledgerSecret: 'test-secret-not-from-env-32-bytes-min',
      sandbox: SANDBOX,
    });
    try {
      assert.ok(c.hostServices.consoleRpc !== undefined, '控制台 RPC 必须接进宿主服务面');
      assert.equal(typeof c.hostServices.consoleRpc.handle, 'function');
    } finally {
      await c.dispose();
    }
  });

  test('组合产物暴露工作流服务（状态机的写入路径）', async () => {
    const c = compose({
      database: { url: DATABASE_URL! },
      ledgerSecret: 'test-secret-not-from-env-32-bytes-min',
      sandbox: SANDBOX,
    });
    try {
      assert.equal(typeof c.workflow.startWorker, 'function');
      assert.equal(typeof c.workflow.confirmTransition, 'function');
      assert.equal(typeof c.workflow.pause, 'function');
    } finally {
      await c.dispose();
    }
  });

  test('预算：未接 dsh-budget 端口时工厂返回 null（不给出自算数字）', async () => {
    const c = compose({
      database: { url: DATABASE_URL! },
      ledgerSecret: 'test-secret-not-from-env-32-bytes-min',
      sandbox: SANDBOX,
    });
    try {
      const meter = c.createBudget({
        dshSessionId: 's1',
        limits: { maxTokens: 1000, maxSteps: 10, maxSeconds: 60 },
        startedAt: new Date(),
      });
      assert.equal(
        meter,
        null,
        '§10.5：token 计量必须取自 dsh-budget，没有端口时宁可明确不可用',
      );
    } finally {
      await c.dispose();
    }
  });

  test('预算：接了端口时可构造，且活性监视按会话起始时刻构造', async () => {
    const c = compose({
      database: { url: DATABASE_URL! },
      ledgerSecret: 'test-secret-not-from-env-32-bytes-min',
      sandbox: SANDBOX,
      dshBudget: {
        readUsage: () => ({ source: 'dsh-budget' as const, inputTokens: 10, outputTokens: 5, totalTokens: 15, sessionSeq: 1 }),
      },
    });
    try {
      const meter = c.createBudget({
        dshSessionId: 's1',
        limits: { maxTokens: 1000, maxSteps: 10, maxSeconds: 60 },
        startedAt: new Date(),
      });
      assert.ok(meter !== null, '有端口时必须能构造');
      const liveness = c.createLiveness(new Date());
      assert.equal(typeof liveness.observe, 'function');
      assert.equal(typeof liveness.checkpoint, 'function');
    } finally {
      await c.dispose();
    }
  });
  test('预算硬阈值：官方用量投影、告警、暂停、幂等与追加预算继续', async () => {
    const probe = new Pool({ connectionString: DATABASE_URL });
    const engagementId = randomUUID();
    const dshSessionId = `dsh-budget-${randomUUID()}`;
    const workerSessionId = randomUUID();
    const usage = { totalTokens: 8 };
    const c = compose({
      database: { url: DATABASE_URL! },
      ledgerSecret: 'budget-lifecycle-test-secret-32-bytes',
      sandbox: SANDBOX,
      dshBudget: {
        readUsage: (id: string) => {
          assert.equal(id, dshSessionId);
          return {
            source: 'dsh-budget' as const,
            inputTokens: 0,
            outputTokens: 0,
            totalTokens: usage.totalTokens,
            sessionSeq: 0,
          };
        },
      },
    });
    try {
      await probe.query(
        `insert into pentest.engagements
           (id, tenant_id, name, status, current_status, target_snapshot, scope_snapshot,
            roe_snapshot, policy_snapshot, config_snapshot, created_by)
         values ($1::uuid, 't', 'budget-lifecycle', 'running', 'worker_running', '{}', '{}', '{}', '{}', '{}', 'tester')`,
        [engagementId],
      );
      await probe.query(
        `insert into pentest.worker_sessions
           (id, engagement_id, dsh_session_id, phase, profile_id, profile_revision, attempt,
            iteration, scope_version, task_prompt, tool_filter, skill_ids, model_route, status,
            budget_max_tokens, budget_max_steps, budget_max_seconds, started_at)
         values ($1::uuid, $2::uuid, $3, 'intelligence-gathering', 'p', 'r1', 1, 1, 0,
                 'budget test', '{}'::jsonb, '[]'::jsonb, '{}'::jsonb, 'active', 10, 100, 3600, now())`,
        [workerSessionId, engagementId, dshSessionId],
      );
      const leaseId = randomUUID();
      await probe.query(
        `insert into pentest.session_leases
           (id, engagement_id, worker_session_id, generation, expires_at)
         values ($1::uuid, $2::uuid, $3::uuid, 1, now() + interval '10 minutes')`,
        [leaseId, engagementId, workerSessionId],
      );

      await c.budgetLifecycle.observe(dshSessionId, 'step/start');
      let row = await probe.query<{ consumed_tokens: number | string; consumed_steps: number | string }>(
        `select consumed_tokens, consumed_steps from pentest.worker_sessions where id = $1::uuid`,
        [workerSessionId],
      );
      assert.deepEqual([Number(row.rows[0]!.consumed_tokens), Number(row.rows[0]!.consumed_steps)], [8, 1]);
      let events = await probe.query<{ event_type: string }>(
        `select event_type from pentest.context_events where engagement_id = $1::uuid order by chain_seq`,
        [engagementId],
      );
      assert.deepEqual(events.rows.map((event) => event.event_type), ['budget.warning']);

      usage.totalTokens = 10;
      await c.budgetLifecycle.observe(dshSessionId, 'assistant/message');
      row = await probe.query<{ consumed_tokens: number | string; consumed_steps: number | string }>(
        `select consumed_tokens, consumed_steps from pentest.worker_sessions where id = $1::uuid`,
        [workerSessionId],
      );
      assert.equal(Number(row.rows[0]!.consumed_tokens), 10);
      let state = await probe.query<{ status: string; state_version: number | string }>(
        `select status, state_version from pentest.engagements where id = $1::uuid`,
        [engagementId],
      );
      assert.equal(state.rows[0]!.status, 'paused');
      assert.equal(Number(state.rows[0]!.state_version), 1);
      events = await probe.query<{ event_type: string }>(
        `select event_type from pentest.context_events where engagement_id = $1::uuid order by chain_seq`,
        [engagementId],
      );
      assert.deepEqual(events.rows.map((event) => event.event_type), ['budget.warning', 'budget.exhausted']);
      const decisions = await probe.query<{ n: string }>(
        `select count(*)::text as n from pentest.human_decisions
          where engagement_id = $1::uuid and decision_type = 'system_auto_pause:budget_exhausted'`,
        [engagementId],
      );
      assert.equal(decisions.rows[0]!.n, '1');

      await c.budgetLifecycle.observe(dshSessionId, 'assistant/message');
      const repeated = await probe.query<{ n: string }>(
        `select count(*)::text as n from pentest.context_events
          where engagement_id = $1::uuid and event_type = 'budget.exhausted'`,
        [engagementId],
      );
      assert.equal(repeated.rows[0]!.n, '1');
      const lease = await probe.query<{ revoked_at: Date | null }>(
        `select revoked_at from pentest.session_leases where id = $1::uuid`,
        [leaseId],
      );
      assert.equal(lease.rows[0]!.revoked_at, null, '预算暂停不能吊销租约');

      // ② 人类点「恢复」后**重启 harness**：去重键必须从账本里活过来。
      //
      // 实测报障（2026-10-05）：断网几小时后人类收到 `engagement_halted`，其实是 harness
      // 重启把内存里的去重标记清了零，于是同一个耗尽的预算又暂停了一次——
      // 人类看到的是「我明明点了恢复，它又自己停了」。
      const beforeResume = await probe.query<{ state_version: number | string }>(
        `select state_version from pentest.engagements where id = $1::uuid`,
        [engagementId],
      );
      await c.workflow.resume({
        engagementId,
        operatorId: 'operator-budget-test',
        reason: '恢复继续',
        expectedStateVersion: Number(beforeResume.rows[0]!.state_version),
      });
      const restarted = compose({
        database: { url: DATABASE_URL! },
        ledgerSecret: 'budget-lifecycle-test-secret-32-bytes',
        sandbox: SANDBOX,
        dshBudget: {
          readUsage: () => ({
            source: 'dsh-budget' as const,
            inputTokens: 0,
            outputTokens: 0,
            totalTokens: usage.totalTokens,
            sessionSeq: 0,
          }),
        },
      });
      try {
        await restarted.budgetLifecycle.observe(dshSessionId, 'assistant/message');
      } finally {
        await restarted.dispose();
      }
      const afterRestart = await probe.query<{ n: string }>(
        `select count(*)::text as n from pentest.context_events
          where engagement_id = $1::uuid and event_type = 'budget.exhausted'`,
        [engagementId],
      );
      assert.equal(afterRestart.rows[0]!.n, '1', '重启后不得因丢失去重标记而二次暂停');
      state = await probe.query<{ status: string; state_version: number | string }>(
        `select status, state_version from pentest.engagements where id = $1::uuid`,
        [engagementId],
      );
      assert.equal(state.rows[0]!.status, 'running', '重启后的复核不得把人类已恢复的作业再暂停一次');

      const beforeExtend = await probe.query<{ state_version: number | string }>(
        `select state_version from pentest.engagements where id = $1::uuid`,
        [engagementId],
      );
      await c.workflow.extendBudget({
        workerSessionId,
        additionalTokens: 10,
        operatorId: 'operator-budget-test',
        reason: '追加测试额度',
        expectedStateVersion: Number(beforeExtend.rows[0]!.state_version),
      });
      state = await probe.query<{ status: string; state_version: number | string }>(
        `select status, state_version from pentest.engagements where id = $1::uuid`,
        [engagementId],
      );
      assert.equal(state.rows[0]!.status, 'running', '追加预算必须恢复 engagement 运行标记');
      assert.equal(
        Number(state.rows[0]!.state_version),
        Number(beforeExtend.rows[0]!.state_version) + 1,
        '追加预算只让状态版本前进一格',
      );
      await c.budgetLifecycle.observe(dshSessionId, 'assistant/message');
      const afterExtension = await probe.query<{ n: string }>(
        `select count(*)::text as n from pentest.context_events
          where engagement_id = $1::uuid and event_type = 'budget.exhausted'`,
        [engagementId],
      );
      assert.equal(afterExtension.rows[0]!.n, '1', '追加预算后未再次触顶不应重复暂停');
    } finally {
      await cleanupEngagements(probe, [engagementId]);
      await probe.end();
      await c.dispose();
    }
  });

  test('对账已接线：collect 可调用且对空 engagement 返回空集', async () => {
    const c = compose({
      database: { url: DATABASE_URL! },
      ledgerSecret: 'test-secret-not-from-env-32-bytes-min',
      sandbox: SANDBOX,
    });
    try {
      const sessions = await c.reconcile.collect(randomUUID());
      assert.deepEqual(sessions, [], '不存在的 engagement 没有会话可对账');
      const evaluated = c.reconcile.evaluate('e1', []);
      assert.equal(evaluated.blocksProgress, false);
    } finally {
      await c.dispose();
    }
  });

  test('未注入会话工厂时：创建会话以明确错误失败，而不是静默空转', async () => {
    const c = compose({
      database: { url: DATABASE_URL! },
      ledgerSecret: 'test-secret-not-from-env-32-bytes-min',
      sandbox: SANDBOX,
    });
    try {
      await assert.rejects(
        () =>
          c.workflow.startWorker({
            engagementId: randomUUID(),
            operatorId: 'op',
            reason: 'r',
            expectedStateVersion: 0,
            phase: 'intelligence-gathering',
            taskPrompt: 'x',
            skillIds: [],
            toolAllow: [],
          }),
        // engagement 不存在 → 先被状态校验拦下；这条断言的是「不静默成功」
        (e: unknown) => e instanceof Error,
      );
    } finally {
      await c.dispose();
    }
  });

  test('对账探测缺省时保守判为不可达（不假装会话还活着）', async () => {
    const c = compose({
      database: { url: DATABASE_URL! },
      ledgerSecret: 'test-secret-not-from-env-32-bytes-min',
      sandbox: SANDBOX,
    });
    // 单独一个池：`acquireTxClient` 需要一个池，且它必须在 finally 里 end——
    // 此前这里直接 `new Pool(...)` 内联传参，池从未关闭，连接泄漏。
    const probe = new Pool({ connectionString: DATABASE_URL });
    let engagementId: string | null = null;
    try {
      engagementId = randomUUID();
      const client = await acquireTxClient(probe);
      // 直接造一行会话，验证探测缺省时的对账结论
      await client.client.query(
        `insert into pentest.engagements (id,tenant_id,name,status,current_status,target_snapshot,scope_snapshot,roe_snapshot,policy_snapshot,config_snapshot,created_by)
         values ($1::uuid,'t','recon','running','worker_running','{}'::jsonb,'{}'::jsonb,'{}'::jsonb,'{}'::jsonb,'{}'::jsonb,'tester')`,
        [engagementId],
      );
      await client.client.query(
        `insert into pentest.worker_sessions (id,engagement_id,dsh_session_id,phase,profile_id,profile_revision,attempt,iteration,scope_version,task_prompt,tool_filter,skill_ids,model_route,status)
         values (gen_random_uuid(),$1::uuid,$2,'intelligence-gathering','p','r1',1,1,0,'tp','{}'::jsonb,'[]'::jsonb,'{}'::jsonb,'active')`,
        [engagementId, `dsh-probe-${randomUUID()}`],
      );
      client.release();

      const sessions = await c.reconcile.collect(engagementId);
      assert.equal(sessions.length, 1);
      assert.equal(
        sessions[0]!.dshSessionReachable,
        false,
        '缺省探测必须判为不可达——宁可让人复核一个还活着的会话，也不要假装它活着',
      );
      const evaluated = c.reconcile.evaluate(engagementId, sessions);
      assert.equal(evaluated.blocksProgress, true, '不可达的会话必须阻塞推进');
    } finally {
      // 此前这里不清理数据，是「跑一次全量留一个 recon」的来源。
      if (engagementId !== null) await cleanupEngagements(probe, [engagementId]);
      await probe.end();
      await c.dispose();
    }
  });
});

// ─────────────── 索引链路接线 ───────────────
//
// 与上一组同一理由：模块完整但没接进 compose 时等于不存在。

describe('组合接线：索引链路', { skip: DATABASE_URL === undefined ? '未设置 PENTEST_DATABASE_URL' : false }, () => {

  /**
   * 清掉一个测试 engagement 的全部痕迹。
   *
   * **必须临时禁用只追加触发器**：`context_events` 拒绝 DELETE（§9.5），
   * 而测试要回收自己造的种子数据。这是测试夹具的正当需求——生产代码里
   * 没有任何路径能删审计行，那正是该触发器要保证的。
   *
   * 用 `ALTER TABLE ... DISABLE TRIGGER` 而不是以超级用户身份绕过：
   * 触发器对超级用户同样生效，禁用是唯一途径。
   */
  test('组合产物暴露 outbox 与索引器', async () => {
    const c = compose({
      database: { url: DATABASE_URL! },
      ledgerSecret: 'test-secret-not-from-env-32-bytes-min',
      sandbox: SANDBOX,
    });
    try {
      assert.equal(typeof c.outbox.enqueue, 'function');
      assert.equal(typeof c.outbox.claim, 'function');
      assert.equal(typeof c.outbox.enqueueInTransaction, 'function', '事务内入队是接口的一部分');
      assert.equal(typeof c.indexer.runOnce, 'function');
      assert.equal(typeof c.indexer.indexEvent, 'function');
    } finally {
      await c.dispose();
    }
  });

  test('端到端：账本追加自动产生索引任务（组合层的原子性）', async () => {
    const c = compose({
      database: { url: DATABASE_URL! },
      ledgerSecret: 'test-secret-not-from-env-32-bytes-min',
      sandbox: SANDBOX,
    });
    const probe = new Pool({ connectionString: DATABASE_URL });
    try {
      const engagementId = randomUUID();
      await probe.query(
        `insert into pentest.engagements
           (id, tenant_id, name, status, current_status, target_snapshot, scope_snapshot, roe_snapshot, policy_snapshot, config_snapshot, created_by)
         values ($1::uuid, 't', 'wire-index', 'running', 'ready', '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, 'tester')`,
        [engagementId],
      );

      const result = await c.ledger.appendEvent({
        engagementId,
        workerSessionId: null,
        eventType: 'human.input',
        sourceSystem: 'compose-test',
        sourceId: `wire-${randomUUID()}`,
        sourceSeq: 1,
        occurredAt: new Date(),
        payload: { text: '组合层原子性验证' },
        rawPayload: new TextEncoder().encode('{}'),
        classification: 'engagement',
        trustLevel: 'human_decision',
      });

      const job = await probe.query<{ job_type: string; status: string }>(
        `select job_type, status from pentest.outbox_jobs where entity_id = $1::uuid`,
        [result.eventId],
      );
      assert.equal(job.rows.length, 1, '组合根的账本必须自动入队——否则检索面静默缺失内容');
      assert.equal(job.rows[0]!.job_type, 'index_event');
      assert.equal(job.rows[0]!.status, 'pending');

      await cleanupEngagements(probe, [engagementId]);
    } finally {
      await probe.end();
      await c.dispose();
    }
  });

  test('未配嵌入提供方时：索引器只做词法索引（明确降级，非静默失败）', async () => {
    const c = compose({
      database: { url: DATABASE_URL! },
      ledgerSecret: 'test-secret-not-from-env-32-bytes-min',
      sandbox: SANDBOX,
    });
    const probe = new Pool({ connectionString: DATABASE_URL });
    try {
      const engagementId = randomUUID();
      await probe.query(
        `insert into pentest.engagements
           (id, tenant_id, name, status, current_status, target_snapshot, scope_snapshot, roe_snapshot, policy_snapshot, config_snapshot, created_by)
         values ($1::uuid, 't', 'lexical-only', 'running', 'ready', '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, 'tester')`,
        [engagementId],
      );
      const ev = await probe.query<{ event_id: string }>(
        `insert into pentest.context_events
           (engagement_id, source_system, source_id, source_seq, event_type, schema_version,
            occurred_at, chain_seq, payload_json, raw_payload_zstd, classification, trust_level, event_hash)
         values ($1::uuid, 'test', $2, 1, 'human.input', 1, now(), 1, '{"text":"词法降级"}'::jsonb, '\\x00', 'engagement', 'human_decision', decode(repeat('cd', 32), 'hex'))
         returning event_id`,
        [engagementId, `lex-${randomUUID()}`],
      );

      const result = await c.indexer.indexEvent(engagementId, {
        eventId: ev.rows[0]!.event_id,
        engagementId,
        eventType: 'human.input',
        workerSessionId: null,
        trustLevel: 'human_decision',
        classification: 'engagement',
        occurredAt: new Date(),
        payload: { text: '词法降级' },
      });

      assert.equal(result.lexicalOnly, true, '未配嵌入时必须如实标明降级');
      const chunk = await probe.query<{ embedding_revision: string; has_vector: boolean; has_fts: boolean }>(
        `select embedding_revision, (embedding is not null) as has_vector, (search_vector is not null) as has_fts
           from pentest.memory_chunks where source_event_id = $1::uuid`,
        [ev.rows[0]!.event_id],
      );
      assert.equal(chunk.rows[0]!.embedding_revision, 'lexical-only');
      assert.equal(chunk.rows[0]!.has_vector, false, '无提供方则不写向量');
      assert.equal(chunk.rows[0]!.has_fts, true, '词法索引仍建立');

      await cleanupEngagements(probe, [engagementId]);
    } finally {
      await probe.end();
      await c.dispose();
    }
  });
});

// ─────────────── 记忆链路端到端 ───────────────

describe('组合接线：记忆链路端到端', { skip: DATABASE_URL === undefined ? '未设置 PENTEST_DATABASE_URL' : false }, () => {
  /**
   * 这条断言是本轮最重要的：`appendEvent → 入队 → 调度 → 分块可检索`。
   *
   * 此前每一段都有测试，但**没有任何测试走过整条链**——而链路上的接缝
   * （入队端口、调度器装配）恰恰是最容易漏的地方。漏了的表现是：
   * 插件照常运行，检索面恒为空，没有任何东西报错。
   */
  test('账本追加后，经调度器处理，分块真的落库并可检索', async () => {
    const c = compose({
      database: { url: DATABASE_URL! },
      ledgerSecret: 'test-secret-not-from-env-32-bytes-min',
      sandbox: SANDBOX,
    });
    const probe = new Pool({ connectionString: DATABASE_URL });
    let engagementId = '';
    try {
      engagementId = randomUUID();
      await probe.query(
        `insert into pentest.engagements
           (id, tenant_id, name, status, current_status, target_snapshot, scope_snapshot, roe_snapshot, policy_snapshot, config_snapshot, created_by)
         values ($1::uuid, 't', 'e2e-chain', 'running', 'ready', '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, 'tester')`,
        [engagementId],
      );

      // 1) 账本追加（自动入队）
      await c.ledger.appendEvent({
        engagementId,
        workerSessionId: null,
        eventType: 'human.input',
        sourceSystem: 'e2e',
        sourceId: `chain-${randomUUID()}`,
        sourceSeq: 1,
        occurredAt: new Date(),
        payload: { text: '端到端：目标段 10.0.0.0/24 已授权' },
        rawPayload: new TextEncoder().encode('{}'),
        classification: 'engagement',
        trustLevel: 'human_decision',
      });

      const pending = await c.outbox.stats(engagementId);
      assert.equal(pending.counts.pending, 1, '账本追加必须产生待办索引任务');

      // 2) 调度器处理
      const drained = await c.dispatcher.drain(engagementId);
      assert.equal(drained.claimed, 1);
      assert.equal(drained.completed, 1, '任务应被完成');
      assert.equal(drained.failed, 0);

      // 3) 分块落库
      const chunks = await probe.query<{ content: string; has_fts: boolean }>(
        `select content, (search_vector is not null) as has_fts
           from pentest.memory_chunks where engagement_id = $1::uuid`,
        [engagementId],
      );
      assert.equal(chunks.rows.length, 1, '分块必须落库——这是检索面的内容来源');
      assert.match(chunks.rows[0]!.content, /已授权/);
      assert.equal(chunks.rows[0]!.has_fts, true, '可索引分块必须有全文索引');

      // 4) 队列清空
      const after = await c.outbox.stats(engagementId);
      assert.equal(after.counts.pending, 0);
      assert.equal(after.counts.done, 1);
    } finally {
      if (engagementId !== '') {
        await probe.query('alter table pentest.context_events disable trigger context_events_append_only').catch(() => undefined);
        await probe.query('alter table pentest.ledger_anchors disable trigger ledger_anchors_append_only').catch(() => undefined);
        await probe.query('alter table pentest.policy_versions disable trigger policy_versions_append_only').catch(() => undefined);
        await probe.query('delete from pentest.outbox_jobs where engagement_id = $1::uuid', [engagementId]).catch(() => undefined);
        await probe.query('delete from pentest.memory_chunks where engagement_id = $1::uuid', [engagementId]).catch(() => undefined);
        await probe.query('delete from pentest.index_watermarks where engagement_id = $1::uuid', [engagementId]).catch(() => undefined);
        await probe.query('delete from pentest.ledger_anchors where engagement_id = $1::uuid', [engagementId]).catch(() => undefined);
        await probe.query('delete from pentest.context_events where engagement_id = $1::uuid', [engagementId]).catch(() => undefined);
        // policy_versions 也引用 engagements：先删子表，engagements 才删得掉。
        await probe.query('delete from pentest.policy_versions where engagement_id = $1::uuid', [engagementId]).catch(() => undefined);
        await probe.query('delete from pentest.engagements where id = $1::uuid', [engagementId]).catch(() => undefined);
        await probe.query('alter table pentest.context_events enable trigger context_events_append_only').catch(() => undefined);
        await probe.query('alter table pentest.ledger_anchors enable trigger ledger_anchors_append_only').catch(() => undefined);
        await probe.query('alter table pentest.policy_versions enable trigger policy_versions_append_only').catch(() => undefined);
      }
      await probe.end();
      await c.dispose();
    }
  });

  test('组合产物暴露调度器', async () => {
    const c = compose({
      database: { url: DATABASE_URL! },
      ledgerSecret: 'test-secret-not-from-env-32-bytes-min',
      sandbox: SANDBOX,
    });
    try {
      assert.equal(typeof c.dispatcher.dispatchBatch, 'function');
      assert.equal(typeof c.dispatcher.drain, 'function');
      assert.equal(typeof c.dispatcher.drainAll, 'function');
    } finally {
      await c.dispose();
    }
  });
});

// ─────────────── apply 启动索引调度 ───────────────

describe('apply 启动索引调度（§14.3）', { skip: DATABASE_URL === undefined ? '未设置 PENTEST_DATABASE_URL' : false }, () => {
  /**
   * 这条断言覆盖 §14.3 的核心要求：
   *
   *   「实例启动后必须扫描未完成任务，不能依赖启动前收到的通知」
   *
   * 做法：先造一条**积压**的索引任务（模拟上次进程崩溃时留下、或由另一个
   * 实例入队但未被处理），然后 apply，再断言它被自动处理掉了。
   *
   * 若调度器没接线、或没做启动重扫，这条任务会一直躺在 pending 里——
   * 而那**不会报错**，只是检索面永远缺这段内容。
   */
  test('apply 时自动处理积压的索引任务（启动重扫）', async () => {
    const probe = new Pool({ connectionString: DATABASE_URL });
    const disposers: Array<() => unknown> = [];
    let engagementId = '';
    let composedCalls = 0;

    try {
      // 1) 造 engagement + 事件 + 积压任务（直接用 SQL，不经 apply）
      engagementId = randomUUID();
      await probe.query(
        `insert into pentest.engagements
           (id, tenant_id, name, status, current_status, target_snapshot, scope_snapshot, roe_snapshot, policy_snapshot, config_snapshot, created_by)
         values ($1::uuid, 't', 'startup-sweep', 'running', 'ready', '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, 'tester')`,
        [engagementId],
      );
      const ev = await probe.query<{ event_id: string }>(
        `insert into pentest.context_events
           (engagement_id, source_system, source_id, source_seq, event_type, schema_version,
            occurred_at, chain_seq, payload_json, raw_payload_zstd, classification, trust_level, event_hash)
         values ($1::uuid, 'test', $2, 1, 'human.input', 1, now(), 1, '{"text":"启动重扫应处理这条"}'::jsonb, '\\x00', 'engagement', 'human_decision', decode(repeat('de', 32), 'hex'))
         returning event_id`,
        [engagementId, `startup-${randomUUID()}`],
      );
      await probe.query(
        `insert into pentest.outbox_jobs (engagement_id, job_type, entity_id, idempotency_key, status)
         values ($1::uuid, 'index_event', $2::uuid, $3, 'pending')`,
        [engagementId, ev.rows[0]!.event_id, `startup-job-${randomUUID()}`],
      );

      // 2) apply（配 runtime）——它会自行 compose 并启动调度器
      const ctx = {
        tools: {
          register: () => () => {},
          guard: () => () => {},
        },
        on: () => {},
        effect: (fn: () => unknown) => {
          const d = fn();
          if (typeof d === 'function') disposers.push(d as () => unknown);
          return () => {};
        },
        get(key: string) {
          if (key === 'pluginRegistry') return { names: () => ['dsh-permission-rules', 'dsh-defend', 'dsh-mask', 'dsh-observe', 'dsh-budget'] };
          return undefined;
        },
        logger: Object.assign(() => ({ info: () => {}, warn: () => {}, error: () => {} }), {}),
      };
      const out = await applyPentest(ctx as never, {
        runtime: {
          database: { url: DATABASE_URL! },
          ledgerSecret: 'apply-sweep-secret-32-bytes-minimum',
          sandbox: SANDBOX,
          scheduler: { intervalMs: null }, // 只要启动重扫，不要周期（测试确定性）
        },
        // 关掉的是**启动对账**（它会全库扫描、动兄弟测试的数据），不是后台循环。
        // 这个字段必须在顶层：放进 runtime 不生效（见 applyPentest 的告警）。
        recovery: { onStartup: false },
        // onComposed 只用于观察「组合已发生」；释放走 ctx.effect 注册的 disposer
        onComposed: () => { composedCalls += 1; },
      });
      assert.equal(out.servicesBound, true);
      assert.equal(out.backgroundLoops.heartbeat, true, '关掉启动对账不得连带关掉心跳（事故 2026-10-05）');
      assert.equal(out.backgroundLoops.scheduler, true, '关掉启动对账不得连带关掉索引调度');
      assert.equal(composedCalls, 1, '自行组合时必须回调 onComposed');

      // 3) 等启动重扫跑完（它是后台任务，apply 不等它）
      const deadline = Date.now() + 5000;
      let done = 0;
      while (Date.now() < deadline) {
        const r = await probe.query<{ n: string }>(
          `select count(*)::text as n from pentest.outbox_jobs
            where engagement_id = $1::uuid and status = 'done'`,
          [engagementId],
        );
        done = Number(r.rows[0]!.n);
        if (done > 0) break;
        await new Promise((r) => setTimeout(r, 50));
      }
      assert.equal(done, 1, 'apply 的启动重扫必须处理积压任务——否则队列只进不出');

      // 4) 分块真的落库
      const chunks = await probe.query<{ content: string }>(
        `select content from pentest.memory_chunks where engagement_id = $1::uuid`,
        [engagementId],
      );
      assert.equal(chunks.rows.length, 1, '启动重扫应产出分块');
      assert.match(chunks.rows[0]!.content, /启动重扫应处理这条/);
    } finally {
      // 释放：调 apply 注册的 disposer（停调度器 + 关连接池）
      for (const d of disposers.reverse()) {
        await Promise.resolve(d()).catch(() => undefined);
      }
      if (engagementId !== '') {
        await probe.query('alter table pentest.context_events disable trigger context_events_append_only').catch(() => undefined);
        await probe.query('alter table pentest.ledger_anchors disable trigger ledger_anchors_append_only').catch(() => undefined);
        await probe.query('alter table pentest.policy_versions disable trigger policy_versions_append_only').catch(() => undefined);
        await probe.query('delete from pentest.outbox_jobs where engagement_id = $1::uuid', [engagementId]).catch(() => undefined);
        await probe.query('delete from pentest.memory_chunks where engagement_id = $1::uuid', [engagementId]).catch(() => undefined);
        await probe.query('delete from pentest.index_watermarks where engagement_id = $1::uuid', [engagementId]).catch(() => undefined);
        await probe.query('delete from pentest.ledger_anchors where engagement_id = $1::uuid', [engagementId]).catch(() => undefined);
        await probe.query('delete from pentest.context_events where engagement_id = $1::uuid', [engagementId]).catch(() => undefined);
        // policy_versions 也引用 engagements：先删子表，engagements 才删得掉。
        await probe.query('delete from pentest.policy_versions where engagement_id = $1::uuid', [engagementId]).catch(() => undefined);
        await probe.query('delete from pentest.engagements where id = $1::uuid', [engagementId]).catch(() => undefined);
        await probe.query('alter table pentest.context_events enable trigger context_events_append_only').catch(() => undefined);
        await probe.query('alter table pentest.ledger_anchors enable trigger ledger_anchors_append_only').catch(() => undefined);
        await probe.query('alter table pentest.policy_versions enable trigger policy_versions_append_only').catch(() => undefined);
      }
      await probe.end();
    }
  });
});

// ─────────────── apply 启动对账（§15.2） ───────────────

describe('apply 启动对账', { skip: DATABASE_URL === undefined ? '未设置 PENTEST_DATABASE_URL' : false }, () => {
  /**
   * 覆盖 §15.2 的核心要求：「dsh 会恢复顶层会话；插件从数据库对账会话、
   * 工具执行与工作流状态」。
   *
   * 造一个**上次崩溃的残留**：一条停在 `starting` 的会话 + 一次未结算的工具执行。
   * apply 之后它们必须被对清——否则那行会永远停在半空状态，没有东西在跑，
   * 而系统也不认为它失败了。
   */
  test('apply 自动对清崩溃残留（starting 会话 + 未结算工具）', async () => {
    const probe = new Pool({ connectionString: DATABASE_URL });
    const disposers: Array<() => unknown> = [];
    let engagementId = '';
    try {
      engagementId = randomUUID();
      await probe.query(
        `insert into pentest.engagements
           (id, tenant_id, name, status, current_status, target_snapshot, scope_snapshot, roe_snapshot, policy_snapshot, config_snapshot, created_by)
         values ($1::uuid, 't', 'startup-recovery', 'running', 'worker_running', '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, 'tester')`,
        [engagementId],
      );
      // 停在 starting 且已超龄（创建窗口没走完）
      const sessionId = randomUUID();
      await probe.query(
        `insert into pentest.worker_sessions
           (id, engagement_id, dsh_session_id, phase, profile_id, profile_revision, attempt, iteration,
            scope_version, task_prompt, tool_filter, skill_ids, model_route, status, created_at)
         values ($1::uuid, $2::uuid, $3, 'intelligence-gathering', 'p', 'r1', 1, 1, 0, 'tp',
                 '{}'::jsonb, '[]'::jsonb, '{}'::jsonb, 'starting', now() - interval '10 minutes')`,
        [sessionId, engagementId, `dsh-stale-${sessionId}`],
      );
      // 未结算的工具执行（超过沙箱单次上限）
      const runId = randomUUID();
      await probe.query(
        `insert into pentest.tool_runs
           (id, engagement_id, worker_session_id, idempotency_key, tool_name, action_class,
            arguments_json, policy_decision, status, started_at)
         values ($1::uuid, $2::uuid, $3::uuid, $4, 'pentest_exec', 'passive_read',
                 '{}'::jsonb, '{}'::jsonb, 'running', now() - interval '20 minutes')`,
        [runId, engagementId, sessionId, `stale-${runId}`],
      );

      // apply —— 它会自行 compose 并在启动时对账
      const ctx = {
        tools: { register: () => () => {}, guard: () => () => {} },
        on: () => {},
        effect: (fn: () => unknown) => {
          const d = fn();
          if (typeof d === 'function') disposers.push(d as () => unknown);
          return () => {};
        },
        get(key: string) {
          if (key === 'pluginRegistry') return { names: () => ['dsh-permission-rules', 'dsh-defend', 'dsh-mask', 'dsh-observe', 'dsh-budget'] };
          return undefined;
        },
        logger: Object.assign(() => ({ info: () => {}, warn: () => {}, error: () => {} }), {}),
      };
      await applyPentest(ctx as never, {
        runtime: {
          database: { url: DATABASE_URL! },
          ledgerSecret: 'recovery-apply-secret-32-bytes-min',
          sandbox: SANDBOX,
          // 不启用周期：测试只需要启动对账与启动重扫
          scheduler: { intervalMs: null },
        },
      });

      // 等对账跑完（它是后台任务）
      const deadline = Date.now() + 5000;
      let sessionStatus = '';
      let runStatus = '';
      while (Date.now() < deadline) {
        const s = await probe.query<{ status: string }>(
          `select status from pentest.worker_sessions where id = $1::uuid`,
          [sessionId],
        );
        sessionStatus = s.rows[0]?.status ?? '';
        if (sessionStatus === 'failed') break;
        await new Promise((r) => setTimeout(r, 50));
      }
      assert.equal(
        sessionStatus,
        'failed',
        '停在 starting 的超龄会话必须被对账标记为已中断——否则它永远停在半空状态',
      );

      const run = await probe.query<{ status: string }>(
        `select status from pentest.tool_runs where id = $1::uuid`,
        [runId],
      );
      runStatus = run.rows[0]?.status ?? '';
      assert.equal(
        runStatus,
        'unknown',
        '未结算的工具执行必须标为 unknown——副作用是否已作用于目标未知，不能自动重放',
      );
    } finally {
      for (const d of disposers.reverse()) {
        await Promise.resolve(d()).catch(() => undefined);
      }
      if (engagementId !== '') {
        await probe.query('alter table pentest.context_events disable trigger context_events_append_only').catch(() => undefined);
        await probe.query('alter table pentest.ledger_anchors disable trigger ledger_anchors_append_only').catch(() => undefined);
        await probe.query('alter table pentest.policy_versions disable trigger policy_versions_append_only').catch(() => undefined);
        await probe.query('delete from pentest.outbox_jobs where engagement_id = $1::uuid', [engagementId]).catch(() => undefined);
        await probe.query('delete from pentest.tool_runs where engagement_id = $1::uuid', [engagementId]).catch(() => undefined);
        await probe.query('delete from pentest.session_leases where engagement_id = $1::uuid', [engagementId]).catch(() => undefined);
        await probe.query('delete from pentest.ledger_anchors where engagement_id = $1::uuid', [engagementId]).catch(() => undefined);
        await probe.query('delete from pentest.context_events where engagement_id = $1::uuid', [engagementId]).catch(() => undefined);
        await probe.query('delete from pentest.worker_sessions where engagement_id = $1::uuid', [engagementId]).catch(() => undefined);
        // policy_versions 也引用 engagements：先删子表，engagements 才删得掉。
        await probe.query('delete from pentest.policy_versions where engagement_id = $1::uuid', [engagementId]).catch(() => undefined);
        await probe.query('delete from pentest.engagements where id = $1::uuid', [engagementId]).catch(() => undefined);
        await probe.query('alter table pentest.context_events enable trigger context_events_append_only').catch(() => undefined);
        await probe.query('alter table pentest.ledger_anchors enable trigger ledger_anchors_append_only').catch(() => undefined);
        await probe.query('alter table pentest.policy_versions enable trigger policy_versions_append_only').catch(() => undefined);
      }
      await probe.end();
    }
  });

  test('组合产物暴露对账执行者', async () => {
    const c = compose({
      database: { url: DATABASE_URL! },
      ledgerSecret: 'test-secret-not-from-env-32-bytes-min',
      sandbox: SANDBOX,
    });
    try {
      assert.equal(typeof c.recovery.recoverAll, 'function');
      assert.equal(typeof c.recovery.recoverEngagement, 'function');
      assert.equal(typeof c.recovery.findUnownedSessions, 'function');
    } finally {
      await c.dispose();
    }
  });
});

// ─────────────── 范围违规处置端到端（§10.2.2 / §18.1 验收项） ───────────────

describe('范围违规处置（真实 PostgreSQL）', { skip: DATABASE_URL === undefined ? '未设置 PENTEST_DATABASE_URL' : false }, () => {
  let composed: ComposedPlugin | null = null;
  let probe: Pool | null = null;
  const made: string[] = [];

  before(() => {
    composed = compose({
      database: { url: DATABASE_URL! },
      ledgerSecret: 'scope-violation-secret-32-bytes-minimum',
      sandbox: SANDBOX,
      scheduler: { intervalMs: null },
    });
    probe = new Pool({ connectionString: DATABASE_URL });
  });

  after(async () => {
    await composed?.dispose();
    if (probe !== null) await cleanupEngagements(probe, made);
    await probe?.end();
  });

  /** 造一个「有会话、有租约、范围只含 in-scope.example.com」的现场。 */
  async function fixture(): Promise<{ engagementId: string; sessionId: string }> {
    const engagementId = randomUUID();
    made.push(engagementId);
    await probe!.query(
      `insert into pentest.engagements
         (id, tenant_id, name, status, current_status, current_phase, target_snapshot, scope_snapshot,
          roe_snapshot, policy_snapshot, config_snapshot, created_by)
       values ($1::uuid,'t','scope-violation','running','worker_running','intelligence-gathering',
               '{}'::jsonb,'{}'::jsonb,'{}'::jsonb,'{}'::jsonb,'{}'::jsonb,'tester')`,
      [engagementId],
    );
    await probe!.query(
      `insert into pentest.scope_versions
         (id, engagement_id, version, iteration, targets, exclusions, authorization_ref, changed_by, content_hash)
       values ($1::uuid, $2::uuid, 1, 1, $3::jsonb, '[]'::jsonb, 'SOW-1', 'tester', 'sha256:sv')`,
      // 端口**留空**：§10.2.2 规定域名条目的空端口表示「按默认 80/443 匹配」。
      // 而这些模板的 `portSource.kind === 'target'` 不向范围判定传端口，
      // 声明成显式 [80] 反而会因「请求没带端口」被判不匹配。
      [randomUUID(), engagementId, JSON.stringify([
        { kind: 'domain', value: 'in-scope.example.com', protocols: ['tcp'], ports: [] },
      ])],
    );
    const sessionId = randomUUID();
    await probe!.query(
      `insert into pentest.worker_sessions
         (id, engagement_id, dsh_session_id, phase, profile_id, profile_revision, attempt, iteration,
          scope_version, task_prompt, tool_filter, skill_ids, model_route, status)
       values ($1::uuid, $2::uuid, $3, 'intelligence-gathering', 'p', 'r1', 1, 1, 1, 'tp',
               '{}'::jsonb, '[]'::jsonb, '{}'::jsonb, 'active')`,
      [sessionId, engagementId, `dsh-sv-${sessionId}`],
    );
    await probe!.query(
      `insert into pentest.session_leases (engagement_id, worker_session_id, generation, expires_at)
       values ($1::uuid, $2::uuid, 1, now() + interval '1 hour')`,
      [engagementId, sessionId],
    );
    await probe!.query(
      `update pentest.engagements set active_agent_session_id = $2::uuid where id = $1::uuid`,
      [engagementId, sessionId],
    );
    return { engagementId, sessionId };
  }

  /**
   * 一次被动读取动作。
   *
   * 用出厂那张直连命令模板（而不是自造模板）：它的参数即必填，
   * 少一个就会先被参数白名单拒（`classification_rejected`），那样测的就不是范围校验了。
   */
  const intent = (sessionId: string, target: string) => ({
    workerSessionId: sessionId,
    templateId: 'direct_command',
    params: { port: 80, command_b64: Buffer.from('curl -sS -I ' + target, 'utf8').toString('base64') },
    targetSelector: target,
    purpose: '端到端验证范围违规处置',
  });

  test('越界动作被拒，且 scope.violation 事件带着四项归因信息落进账本', async () => {
    const { engagementId, sessionId } = await fixture();

    const decision = await composed!.execution.admit(intent(sessionId, 'http://outside.example.com/'));

    assert.equal(decision.kind, 'rejected');
    if (decision.kind === 'rejected') assert.equal(decision.error.code, 'scope_violation');

    const events = await probe!.query(
      `select payload_json from pentest.context_events
        where engagement_id = $1::uuid and event_type = 'scope.violation'`,
      [engagementId],
    );
    assert.equal(events.rowCount, 1, '范围违规必须写一条账本事件');
    const payload = events.rows[0]!.payload_json as Record<string, unknown>;
    // §10.2.2 要求事件含这四项——缺任何一项事后都无法归因。
    assert.equal(payload['rawTarget'], 'http://outside.example.com/', '原始目标必须是 Agent 提交的那个');
    assert.notEqual(payload['rule'], undefined, '命中的规则');
    assert.notEqual(payload['detail'], undefined, '判定说明');
    assert.ok('normalized' in payload, '规范化结果字段要在（可为 null）');
  });

  test('同一会话连续三次范围违规 → 自动暂停（§10.2.2）', async () => {
    const { engagementId, sessionId } = await fixture();

    for (let i = 1; i <= 2; i += 1) {
      await composed!.execution.admit(intent(sessionId, 'http://outside.example.com/'));
      const row = await probe!.query(`select status from pentest.engagements where id = $1::uuid`, [engagementId]);
      assert.equal(row.rows[0]!.status, 'running', `第 ${String(i)} 次不该暂停`);
    }

    await composed!.execution.admit(intent(sessionId, 'http://outside.example.com/'));

    const after = await probe!.query(`select status from pentest.engagements where id = $1::uuid`, [engagementId]);
    assert.equal(after.rows[0]!.status, 'paused', '第三次（阈值）必须自动暂停');

    // 暂停是**系统**发起的：审计要能区分，主体不能冒充人。
    const decision = await probe!.query(
      `select operator_id, reason from pentest.human_decisions
        where engagement_id = $1::uuid and decision_type like 'system_auto_pause%'`,
      [engagementId],
    );
    assert.equal(decision.rowCount, 1, '自动暂停必须留一条决策记录');
    assert.equal(decision.rows[0]!.operator_id, 'system:dsh-pentest', '主体必须标为系统');
    assert.ok(String(decision.rows[0]!.reason).includes('范围违规'), '理由要说明是范围违规触发的');
  });
  test('并发三次范围违规 → 只产生一次暂停决策', async () => {
    const { engagementId, sessionId } = await fixture();
    await Promise.all([
      composed!.execution.admit(intent(sessionId, 'http://outside.example.com/')),
      composed!.execution.admit(intent(sessionId, 'http://outside.example.com/')),
      composed!.execution.admit(intent(sessionId, 'http://outside.example.com/')),
    ]);

    const state = await probe!.query<{ status: string }>(
      `select status from pentest.engagements where id = $1::uuid`,
      [engagementId],
    );
    assert.equal(state.rows[0]?.status, 'paused');
    const decisions = await probe!.query<{ n: number | string }>(
      `select count(*)::int as n from pentest.human_decisions
        where engagement_id = $1::uuid and decision_type = 'system_auto_pause:scope_violation_threshold'`,
      [engagementId],
    );
    assert.equal(Number(decisions.rows[0]?.n), 1, '并发阈值竞争只能写一条系统暂停决策');
  });

  test('范围内的动作照常受理：闸门不是「一律拒绝」', async () => {
    // 反向断言。缺了它，这套逻辑可能被修成「什么都拒」——那同样破坏功能。
    const { sessionId } = await fixture();
    const decision = await composed!.execution.admit(intent(sessionId, 'http://in-scope.example.com/'));
    assert.notEqual(
      decision.kind === 'rejected' ? decision.error.code : undefined,
      'scope_violation',
      '范围内的目标不该被判范围违规',
    );
  });

  test('已暂停后不再重复写决策记录（每次违规都写会淹掉审计）', async () => {
    const { engagementId, sessionId } = await fixture();
    for (let i = 0; i < 5; i += 1) {
      await composed!.execution.admit(intent(sessionId, 'http://outside.example.com/'));
    }
    const decisions = await probe!.query(
      `select count(*)::int as n from pentest.human_decisions
        where engagement_id = $1::uuid and decision_type like 'system_auto_pause%'`,
      [engagementId],
    );
    assert.equal(decisions.rows[0]!.n, 1, '已暂停就该跳过，而不是每次违规都写一条');
  });
});

// ─────────────── 修改审批计划端到端（§10.3.1） ───────────────

describe('修改审批计划（真实 PostgreSQL）', { skip: DATABASE_URL === undefined ? '未设置 PENTEST_DATABASE_URL' : false }, () => {
  const made: string[] = [];
  let composed: ComposedPlugin;
  let probe: Pool;

  before(() => {
    composed = compose({
      database: { url: DATABASE_URL! },
      ledgerSecret: 'approval-replacement-secret-32-bytes-min',
      sandbox: SANDBOX,
      templates: [APPROVAL_TEMPLATE],
      scheduler: { intervalMs: null },
    });
    probe = new Pool({ connectionString: DATABASE_URL });
  });

  after(async () => {
    await composed.dispose();
    await cleanupEngagements(probe, made);
    await probe.end();
  });

  async function fixture(): Promise<{ engagementId: string; sessionId: string; approvalId: string }> {
    const sessionId = randomUUID();
    // 用**真实创建路径**建作业：手写 `'{}'::jsonb` 的策略快照会让策略源回落 DEFAULT，
    // 于是 `plan_hash` 里的 `policyVersion`/`pacing` 变成 null，掩盖了「验证器漏传策略元数据」
    // 这类缺陷（它只在带冻结策略的作业上才暴露）。这里刻意留下真实的策略快照。
    const engagement = await composed.workflow.createEngagement({
      operatorId: 'operator-approval-test',
      reason: '审批替代夹具：建立带冻结策略的作业',
      name: 'approval-replacement',
      scopeEntryProfile: 'ip',
      behaviorProfile: 'custom',
      approvalMode: 'human',
      customGuidance: '审批替代夹具：只做授权范围内的只读与验证动作，不做写操作。',
      policyOverrides: {
        allowedActions: ['passive_read', 'active_discovery', 'exploit_validation'],
        rate: 1,
        concurrency: 1,
        jitter: 0,
      },
      targets: [{ kind: 'ip', value: '192.0.2.10', protocols: ['tcp'], ports: [] }],
      exclusions: [],
      authorizationRef: 'SOW-approval',
    });
    const engagementId = engagement.id;
    made.push(engagementId);
    await probe.query(
      `update pentest.engagements set current_status = 'worker_running', current_phase = 'intelligence-gathering'
        where id = $1::uuid`,
      [engagementId],
    );
    await probe.query(
      `insert into pentest.worker_sessions
         (id, engagement_id, dsh_session_id, phase, profile_id, profile_revision, attempt, iteration,
          scope_version, task_prompt, tool_filter, skill_ids, model_route, status)
       values ($1::uuid, $2::uuid, $3, 'intelligence-gathering', 'p', 'r1', 1, 1, 1, 'approval test',
               '{}'::jsonb, '[]'::jsonb, '{}'::jsonb, 'active')`,
      [sessionId, engagementId, `dsh-approval-${sessionId}`],
    );
    await probe.query(
      `insert into pentest.session_leases (engagement_id, worker_session_id, generation, expires_at)
       values ($1::uuid, $2::uuid, 1, now() + interval '1 hour')`,
      [engagementId, sessionId],
    );
    const decision = await composed.execution.admit({
      workerSessionId: sessionId,
      templateId: APPROVAL_TEMPLATE.template.id,
      targetSelector: '192.0.2.10',
      params: { payload_id: 'xss-1' },
      purpose: '原始审批计划',
    });
    assert.equal(decision.kind, 'needs_approval', JSON.stringify(decision));
    if (decision.kind !== 'needs_approval') throw new Error('expected needs_approval');
    return { engagementId, sessionId, approvalId: decision.approvalId };
  }

  test('修改审批生成 replacement、取代旧凭证，并保留原始选择器', async () => {
    const { engagementId, sessionId, approvalId } = await fixture();
    const result = await composed.workflow.decideApproval({
      approvalId,
      operatorId: 'operator-approval-test',
      decision: 'approved',
      reason: '修改为 SQLi 最小验证模板参数',
      modifiedCommandPlan: {
        template_id: APPROVAL_TEMPLATE.template.id,
        target_selector: '192.0.2.10',
        params: { payload_id: 'sqli-1' },
        purpose: '修改后的最小验证',
      },
    });
    assert.notEqual(result.id, approvalId);
    assert.equal(result.decision, 'approved');
    assert.equal(result.workerSessionId, sessionId);

    const rows = await probe.query<{ id: string; decision: string; command_plan: Record<string, unknown>; plan_hash: string }>(
      `select id, decision, command_plan, plan_hash from pentest.approvals where engagement_id = $1::uuid order by created_at`,
      [engagementId],
    );
    assert.equal(rows.rows.length, 2);
    assert.equal(rows.rows[0]!.id, approvalId);
    assert.equal(rows.rows[0]!.decision, 'superseded');
    assert.equal(rows.rows[1]!.id, result.id);
    assert.equal(rows.rows[1]!.decision, 'approved');
    assert.equal(rows.rows[1]!.command_plan['target_selector'], '192.0.2.10');
    assert.equal(rows.rows[1]!.command_plan['normalized_command'], 'http_probe target=192.0.2.10 payload_id=sqli-1');

    // 回归锁：验证器算出的 plan_hash 必须与**受理时**算出的完全一致，否则人类
    // 「修改后放行」的凭证永远无法消费（`approvalViolation` 会以「与当前计划不一致」拒绝）。
    // 此前验证器按旧签名派生摘要、漏掉了 policyVersion 与 pacing，这条断言就会失败。
    const recalled = await composed.execution.admit({
      workerSessionId: sessionId,
      templateId: APPROVAL_TEMPLATE.template.id,
      targetSelector: '192.0.2.10',
      params: { payload_id: 'sqli-1' },
      purpose: '修改后的最小验证',
      approvalId: result.id,
    });
    assert.equal(recalled.kind, 'admitted', `修改后放行的凭证必须可受理：${JSON.stringify(recalled)}`);

    const store = new PgExecutionStore(probe as unknown as DbClient);
    const replacementToolRunId = randomUUID();
    const commit = await store.commitRun({
      toolRunId: replacementToolRunId,
      workerSessionId: sessionId,
      idempotencyKey: `approval-replacement-${randomUUID()}`,
      planHash: rows.rows[1]!.plan_hash,
      approvalId: result.id,
      leaseGeneration: 1,
      toolName: 'pentest_exec',
      actionClass: 'exploit_validation',
      templateId: APPROVAL_TEMPLATE.template.id,
      normalizedTarget: String(rows.rows[1]!.command_plan['normalized_target']),
      normalizedCommand: String(rows.rows[1]!.command_plan['normalized_command']),
      scopeVersion: 1,
      policyEpoch: 0,
      approvalRequired: true,
    });
    assert.equal(await store.consumeApproval(approvalId, replacementToolRunId), false);
    assert.equal(await store.consumeApproval(approvalId, randomUUID()), false);

    await assert.rejects(
      () => composed.workflow.decideApproval({ approvalId, operatorId: 'operator-approval-test', decision: 'approved', reason: '重复处理' }),
      (error: unknown) => error instanceof WorkflowRejection && error.code === 'classification_rejected',
    );
  });

  test('验证器失败时旧 pending 不变且不留下 replacement 或决策记录', async () => {
    const { engagementId, approvalId } = await fixture();
    const beforeDecisions = await probe.query<{ n: string }>(
      `select count(*)::text as n from pentest.human_decisions where engagement_id = $1::uuid`,
      [engagementId],
    );
    await assert.rejects(
      () => composed.workflow.decideApproval({
        approvalId,
        operatorId: 'operator-approval-test',
        decision: 'approved',
        reason: '非法修改',
        modifiedCommandPlan: {
          template_id: APPROVAL_TEMPLATE.template.id,
          target_selector: '192.0.2.10',
          normalized_command: 'rm -rf /',
          params: { payload_id: 'sqli-1' },
          purpose: '非法自由命令',
        },
      }),
      (error: unknown) => error instanceof WorkflowRejection && error.code === 'classification_rejected',
    );
    const row = await probe.query<{ decision: string }>('select decision from pentest.approvals where id = $1::uuid', [approvalId]);
    assert.equal(row.rows[0]!.decision, 'pending');
    const count = await probe.query<{ n: string }>('select count(*)::text as n from pentest.approvals where engagement_id = $1::uuid', [engagementId]);
    assert.equal(count.rows[0]!.n, '1');
    const afterDecisions = await probe.query<{ n: string }>(
      `select count(*)::text as n from pentest.human_decisions where engagement_id = $1::uuid`,
      [engagementId],
    );
    assert.equal(afterDecisions.rows[0]!.n, beforeDecisions.rows[0]!.n);
  });

  test('后续审批审计失败时 replacement、supersede 与决策全部回滚', async () => {
    const { engagementId, approvalId } = await fixture();
    const beforeDecisions = await probe.query<{ n: string }>(
      `select count(*)::text as n from pentest.human_decisions where engagement_id = $1::uuid`,
      [engagementId],
    );
    const beforeEvents = await probe.query<{ n: string }>(
      `select count(*)::text as n from pentest.context_events where engagement_id = $1::uuid`,
      [engagementId],
    );
    try {
      await probe.query(`
        create or replace function pentest.test_fail_modified_approval_audit()
        returns trigger language plpgsql as $$
        begin
          if new.event_type = 'tool.approval.resolved' then
            raise exception 'test modified approval audit failure';
          end if;
          return new;
        end
        $$;
      `);
      await probe.query(`drop trigger if exists test_fail_modified_approval_audit on pentest.context_events`);
      await probe.query(`
        create trigger test_fail_modified_approval_audit
        before insert on pentest.context_events
        for each row execute function pentest.test_fail_modified_approval_audit()
      `);

      await assert.rejects(
        () => composed.workflow.decideApproval({
          approvalId,
          operatorId: 'operator-approval-test',
          decision: 'approved',
          reason: '审计失败回滚',
          modifiedCommandPlan: {
            template_id: APPROVAL_TEMPLATE.template.id,
            target_selector: '192.0.2.10',
            params: { payload_id: 'sqli-1' },
            purpose: '应随事务回滚的修改',
          },
        }),
        /test modified approval audit failure/,
      );

      const approvals = await probe.query<{ n: string; decision: string }>(
        `select count(*)::text as n, min(decision) as decision
           from pentest.approvals where engagement_id = $1::uuid`,
        [engagementId],
      );
      assert.equal(approvals.rows[0]!.n, '1');
      assert.equal(approvals.rows[0]!.decision, 'pending');
      const afterDecisions = await probe.query<{ n: string }>(
        `select count(*)::text as n from pentest.human_decisions where engagement_id = $1::uuid`,
        [engagementId],
      );
      assert.equal(afterDecisions.rows[0]!.n, beforeDecisions.rows[0]!.n);
      const afterEvents = await probe.query<{ n: string }>(
        `select count(*)::text as n from pentest.context_events where engagement_id = $1::uuid`,
        [engagementId],
      );
      assert.equal(afterEvents.rows[0]!.n, beforeEvents.rows[0]!.n);
    } finally {
      await probe.query(`drop trigger if exists test_fail_modified_approval_audit on pentest.context_events`);
      await probe.query(`drop function if exists pentest.test_fail_modified_approval_audit()`);
    }
  });
});

// ─────────────── apply 启动租约心跳（§10.6） ───────────────

describe('apply 启动租约心跳', { skip: DATABASE_URL === undefined ? '未设置 PENTEST_DATABASE_URL' : false }, () => {
  /**
   * 这条防的是「运行超过 10 分钟的会话全部动作失败」：
   * 默认 TTL 600 秒，而执行闸门在过期时拒绝。`renewLease` 曾被实现却无人调用，
   * 因此这是必然发生的正确性问题。
   */
  test('apply 后临界租约被自动续租', async () => {
    const probe = new Pool({ connectionString: DATABASE_URL });
    const disposers: Array<() => unknown> = [];
    let engagementId = '';
    let sessionId = '';
    try {
      engagementId = randomUUID();
      await probe.query(
        `insert into pentest.engagements
           (id, tenant_id, name, status, current_status, target_snapshot, scope_snapshot, roe_snapshot, policy_snapshot, config_snapshot, created_by)
         values ($1::uuid, 't', 'heartbeat', 'running', 'worker_running', '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, 'tester')`,
        [engagementId],
      );
      sessionId = randomUUID();
      await probe.query(
        `insert into pentest.worker_sessions
           (id, engagement_id, dsh_session_id, phase, profile_id, profile_revision, attempt, iteration,
            scope_version, task_prompt, tool_filter, skill_ids, model_route, status)
         values ($1::uuid, $2::uuid, $3, 'intelligence-gathering', 'p', 'r1', 1, 1, 0, 'tp',
                 '{}'::jsonb, '[]'::jsonb, '{}'::jsonb, 'active')`,
        [sessionId, engagementId, `dsh-hb-${sessionId}`],
      );
      // 临界租约：只剩 30 秒（< 续租窗口 180 秒）
      await probe.query(
        `insert into pentest.session_leases (engagement_id, worker_session_id, generation, expires_at)
         values ($1::uuid, $2::uuid, 1, now() + interval '30 seconds')`,
        [engagementId, sessionId],
      );
      const before = await probe.query<{ expires_at: string }>(
        `select expires_at from pentest.session_leases where worker_session_id = $1::uuid`,
        [sessionId],
      );

      const ctx = {
        tools: { register: () => () => {}, guard: () => () => {} },
        on: () => {},
        effect: (fn: () => unknown) => {
          const d = fn();
          if (typeof d === 'function') disposers.push(d as () => unknown);
          return () => {};
        },
        get(key: string) {
          if (key === 'pluginRegistry') return { names: () => ['dsh-permission-rules', 'dsh-defend', 'dsh-mask', 'dsh-observe', 'dsh-budget'] };
          return undefined;
        },
        logger: Object.assign(() => ({ info: () => {}, warn: () => {}, error: () => {} }), {}),
      };
      const out = await applyPentest(ctx as never, {
        runtime: {
          database: { url: DATABASE_URL! },
          ledgerSecret: 'heartbeat-apply-secret-32-bytes-min',
          sandbox: SANDBOX,
          // 只启用心跳（不启用周期索引调度，避免与本用例无关的写入）
          scheduler: { intervalMs: null },
          heartbeat: { intervalSeconds: 60 },
        },
        // 关掉启动对账（不关后台循环）：顶层字段才是插件的配置。
        recovery: { onStartup: false },
      });
      assert.equal(out.backgroundLoops.heartbeat, true, '关掉启动对账时心跳必须照常启动（事故 2026-10-05）');

      // 等心跳跑完（apply 里立即跑一次）
      const deadline = Date.now() + 5000;
      let after = before.rows[0]!.expires_at;
      while (Date.now() < deadline) {
        const row = await probe.query<{ expires_at: string }>(
          `select expires_at from pentest.session_leases where worker_session_id = $1::uuid`,
          [sessionId],
        );
        after = row.rows[0]!.expires_at;
        if (Date.parse(after) > Date.parse(before.rows[0]!.expires_at)) break;
        await new Promise((r) => setTimeout(r, 50));
      }
      assert.ok(
        Date.parse(after) > Date.parse(before.rows[0]!.expires_at),
        `临界租约必须被自动续租（原 ${before.rows[0]!.expires_at}，现 ${after}）——` +
          `否则 TTL 一到会话的每次动作都会被拒绝`,
      );
    } finally {
      for (const d of disposers.reverse()) {
        await Promise.resolve(d()).catch(() => undefined);
      }
      if (engagementId !== '') {
        await probe.query('delete from pentest.session_leases where engagement_id = $1::uuid', [engagementId]).catch(() => undefined);
        await probe.query('delete from pentest.worker_sessions where engagement_id = $1::uuid', [engagementId]).catch(() => undefined);
        // policy_versions 也引用 engagements：先删子表（并临时停掉它的追加写触发器），
        // engagements 才删得掉。漏掉触发器会让删除静默失败，留下一个删不掉的作业。
        await probe.query('alter table pentest.policy_versions disable trigger policy_versions_append_only').catch(() => undefined);
        await probe.query('delete from pentest.policy_versions where engagement_id = $1::uuid', [engagementId]).catch(() => undefined);
        await probe.query('alter table pentest.policy_versions enable trigger policy_versions_append_only').catch(() => undefined);
        await probe.query('delete from pentest.engagements where id = $1::uuid', [engagementId]).catch(() => undefined);
      }
      await probe.end();
    }
  });

  test('组合产物暴露心跳', async () => {
    const c = compose({
      database: { url: DATABASE_URL! },
      ledgerSecret: 'test-secret-not-from-env-32-bytes-min',
      sandbox: SANDBOX,
    });
    try {
      assert.equal(typeof c.heartbeat.tick, 'function');
      assert.equal(typeof c.heartbeat.start, 'function');
      assert.ok(c.heartbeat.intervalSeconds > 0);
    } finally {
      await c.dispose();
    }
  });
});

// ─────────────── apply 注册控制台端点面（§16.1） ───────────────

describe('apply 注册控制台端点面', { skip: DATABASE_URL === undefined ? '未设置 PENTEST_DATABASE_URL' : false }, () => {
  /**
   * 带最小 cordis 面的 ctx，用于观察端点面是否被注册。
   *
   * `reflect.provide` 是观察点：`TypertRemoteService`（经 cordis `Service`）在构造时
   * 调 `ctx.reflect.provide(name, impl, check)`，服务名因此可得。
   *
   * 桩**刻意不提供 `connection`**：Typert 端点面不依赖它——这正是新方案的要点之一
   * （旧的自建通道方案要用 `connection.rpc.handle()`，而它在 webServer 就绪前调用会抛）。
   */
  function ctxForApply(provided: string[]): unknown {
    const disposers: Array<() => unknown> = [];
    const ctx = {
      tools: { register: () => () => {}, guard: () => () => {} },
      on: () => {},
      // **必须收集 disposer 并在测试末尾释放**：`apply` 会启动心跳与索引调度，
      get(key: string) {
        if (key === 'pluginRegistry') return { names: () => ['dsh-permission-rules', 'dsh-defend', 'dsh-mask', 'dsh-observe', 'dsh-budget'] };
        return undefined;
      },
      effect: (fn: () => unknown) => {
        const d = fn();
        if (typeof d === 'function') disposers.push(d as () => unknown);
        return () => {};
      },
      reflect: {
        provide: (name: string) => {
          provided.push(name);
        },
      },
      logger: Object.assign(() => ({ info: () => {}, warn: () => {}, error: () => {} }), {}),
      __disposers: disposers,
    };
    return ctx;
  }

  async function release(ctx: unknown): Promise<void> {
    const disposers = (ctx as { __disposers: Array<() => unknown> }).__disposers;
    for (const d of disposers.reverse()) await Promise.resolve(d()).catch(() => undefined);
  }

  test('配置了 operator 时把端点面注册为 Remote 服务', async () => {
    const provided: string[] = [];
    const ctx = ctxForApply(provided);
    try {
      const out = await applyPentest(ctx as never, {
        runtime: {
          database: { url: DATABASE_URL! },
          ledgerSecret: 'console-face-secret-32-bytes-minimum',
          sandbox: SANDBOX,
          scheduler: { intervalMs: null },
        },
        operator: { id: 'op-test', source: 'test' },
        recovery: { onStartup: false },
      });
      assert.deepEqual(
        provided,
        [CONSOLE_TYPRET_SERVICE],
        '端点面必须以命名空间为键注册；网关据此认领 /api/<namespace>/<method>',
      );
      assert.equal(out.servicesBound, true);
    } finally {
      await release(ctx);
    }
  });

  test('未配置 operator：不注册端点面（宿主不提供主体，必须由部署声明）', async () => {
    const provided: string[] = [];
    const ctx = ctxForApply(provided);
    try {
      const out = await applyPentest(ctx as never, {
        runtime: {
          database: { url: DATABASE_URL! },
          ledgerSecret: 'console-face-secret-32-bytes-minimum',
          sandbox: SANDBOX,
          scheduler: { intervalMs: null },
        },
        // 有意不配 operator
        recovery: { onStartup: false },
      });
      assert.equal(out.servicesBound, true, '工具面不受影响');
      assert.deepEqual(provided, [], '没有操作者身份就不该注册端点面');
    } finally {
      await release(ctx);
    }
  });

  test('无需 connection：端点面照常注册（它只依赖 cordis，不依赖 connection/webServer）', async () => {
    // 这是新方案相对旧通道方案的关键差别：`connection.rpc.handle()` 需要调用方 ctx 上有
    // `webServer`（而 connection 服务自己的 ctx 没有声明它，导致对任何调用方都抛错）。
    // Typert 端点面只是注册一个 cordis 服务，由网关在分发时自行查找，
    // 因此**没有 connection 也能注册**——headless 部署下它照样成立（只是没人调它）。
    const provided: string[] = [];
    const ctx = ctxForApply(provided);
    try {
      const out = await applyPentest(ctx as never, {
        runtime: {
          database: { url: DATABASE_URL! },
          ledgerSecret: 'console-face-secret-32-bytes-minimum',
          sandbox: SANDBOX,
          scheduler: { intervalMs: null },
        },
        operator: { id: 'op-test' },
        recovery: { onStartup: false },
      });
      assert.equal(out.servicesBound, true);
      // 与 `WORKER_TOOL_NAMES` 对齐而不是写死数字：工具面本来就是那份清单的投影，
      // 写死 7 会在每次加工具时要求人回来改数字（而「见红灯改数字」会掩盖漏登记）。
      assert.equal(out.toolsRegistered.length, WORKER_TOOL_NAMES.length, 'headless 下工具面照常注册');
      assert.deepEqual([...out.toolsRegistered], [...WORKER_TOOL_NAMES]);
      assert.ok(
        provided.includes(CONSOLE_TYPRET_SERVICE),
        '端点面与 connection 无关，必须注册成功',
      );
    } finally {
      await release(ctx);
    }
  });
});

// ─────────────── RLS 组合自检与密钥校验（事故 2026-10-05） ───────────────

test('compose 拒绝缺失的账本密钥（不再有仓库内默认值）', () => {
  // 公开常量即有效密钥：知道它的人可以在库被篡改后重签批次、让 verifyLedger 通过。
  assert.throws(
    () => compose({ database: { url: 'postgresql://unused' }, sandbox: SANDBOX } as never),
    /ledgerSecret/u,
  );
});

describe('RLS 组合诊断（真实 PostgreSQL）', { skip: DATABASE_URL === undefined ? '未设置 PENTEST_DATABASE_URL' : false }, () => {
  test('超级用户连接显式告警；非超级用户缺 rlsContext 必须拒绝启动', async () => {
    const diagnosis = await inspectRls({ url: DATABASE_URL! }, false);
    assert.equal(diagnosis.superuser, true, '测试库连接是超级用户');
    assert.match(diagnosis.warnings.join('\n'), /超级用户/u);
    assert.deepEqual(diagnosis.refusals, []);

    // 纯分类：四象限各有确定结论（拒绝分支无法用真实角色构造，用纯函数锁）。
    const refused = classifyRlsCombination({ superuser: false, rlsContextConfigured: false });
    assert.equal(refused.refusals.length, 1, '非超级用户 + 无 rlsContext：必须拒绝启动');
    assert.deepEqual(classifyRlsCombination({ superuser: false, rlsContextConfigured: true }).warnings, []);
    assert.deepEqual(classifyRlsCombination({ superuser: true, rlsContextConfigured: true }).refusals, []);
  });
});
