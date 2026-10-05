/**
 * Typert 门面的测试（`src/console/typert-face.ts`）。
 *
 * 这层是控制台端点**唯一**的对外入口：`POST /api/pentest/<method>`。它取代了原先
 * 自建通道的方案（`connection.rpc.handle()` 在本版本对任何调用方都抛
 * `cannot get property "webServer" without inject`，原因见该文件的说明）。
 *
 * 四条断言各自证伪一件真出过问题的事：
 *
 *   1. **端点集不漂移**：门面 39 个方法与 `CONSOLE_RPC_METHODS` 必须一一对应。
 *      门面是生成的手写代码、方法表是数据——两者脱节时**编译期抓不到**，
 *      表现是某个端点 404。这条把两侧钉在一起。
 *   2. **`@Remote` 标记齐全**：网关靠 `remoteMethods()` 发现方法；少了标记的端点
 *      会被 `resolveSrcDescriptor` 判为「no active Remote method exports this endpoint」。
 *   3. **方法在代理 this 下可调用**（回归锁）：cordis 把 Service 包成 traceable 代理后
 *      才交给调用方，网关用 `Reflect.apply(method, receiver, args)` 调用。
 *      **语言级私有字段（`#x`）在代理上读不到**，实测抛出
 *      `Cannot read private member #rpc from an object whose class did not declare it`。
 *      这条用一个空 Proxy 复现网关的 receiver，锁住「依赖不得放在 `#` 字段里」。
 *   4. **参数名与转发**：参数名是线协议的一部分（SRC 模式从函数源码解析），
 *      且信封必须原样交给 {@link ConsoleRpc}，业务判定不在这层重复。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { remoteMethods } from '@deepseek-ai/dsh-typert-protocol';
import type { Context } from '@deepseek-ai/cordis';

import { CONSOLE_TYPRET_SERVICE, ConsoleTypertService } from '../src/console/typert-face.ts';
import { CONSOLE_RPC_METHODS, ConsoleRpc } from '../src/console/rpc.ts';
import type { ConsoleRequest } from '../src/console/rpc.ts';
import { consoleServicesStub } from './helpers/console-services.ts';

const NOW = new Date('2026-09-19T12:00:00Z');

/**
 * 最小的 cordis 桩：`Service` 构造函数只用 `ctx.reflect.provide(name, impl, check)`。
 *
 * 刻意**不**做更多（不模拟 inject 检查、不模拟 traceable）——这一层的职责就是
 * 「把自己注册成一个服务」，桩只需观察到这一点。真实代理语义由第 3 条测试用
 * Proxy 单独复现。
 */
function makeCtx(): { ctx: Context; provided: string[] } {
  const provided: string[] = [];
  const ctx = {
    reflect: {
      provide(name: string): void {
        provided.push(name);
      },
    },
  };
  return { ctx: ctx as unknown as Context, provided };
}

/** 一个只回显的最小工作流桩（本文件不测业务判定，只测转发）。 */
function makeRpc(calls: ConsoleRequest[]): ConsoleRpc {
  return new ConsoleRpc({
    services: consoleServicesStub({
      listEngagements: async () => [],
      getState: async (input: unknown) => {
        calls.push({ method: 'getState', params: input as Readonly<Record<string, unknown>> });
        return { ok: true };
      },
    } as never),
  });
}

function makeFace(rpc: ConsoleRpc): ConsoleTypertService {
  const { ctx } = makeCtx();
  return new ConsoleTypertService(ctx, {
    rpc,
    operator: { id: 'op-1', source: 'test' },
    clock: () => NOW,
  });
}

// ───────────────────────── 1. 端点集不漂移 ─────────────────────────

test('门面方法集与 CONSOLE_RPC_METHODS 一一对应（少了端点会 404，多了端点会白占命名空间）', () => {
  const face = makeFace(makeRpc([]));
  const declared = new Set(CONSOLE_RPC_METHODS as readonly string[]);
  const exported = new Set(
    remoteMethods(face).map((marker) => marker.exportName ?? marker.method),
  );

  const missing = [...declared].filter((method) => !exported.has(method)).sort();
  const extra = [...exported].filter((method) => !declared.has(method)).sort();

  assert.deepEqual(missing, [], `门面缺少这些端点（它们会 404）：${missing.join(', ')}`);
  assert.deepEqual(extra, [], `门面多出这些端点（不在方法表里）：${extra.join(', ')}`);

  // 这里**刻意不写死条数**。
  //
  // 此前有一句 `assert.equal(CONSOLE_RPC_METHODS.length, 39, …)`：它零保护价值
  // （一一对应已经覆盖「多了/少了」），却要求每次加端点都回来改一个数字——
  // 而那种维护动作会训练人「看到红灯就改数字」，恰好放过真正的漂移。
  // 换成性质断言：确认四个服务面**各自都还在**，防止整面被意外清空。
  for (const face of ['createEngagement', 'getState', 'getReportDraft', 'searchMemory', 'addSkill']) {
    assert.ok(declared.has(face), `方法表缺少 ${face}：某个服务面可能整面掉了`);
  }
  assert.ok(declared.size >= 30, `方法表只有 ${String(declared.size)} 个端点，疑似整面缺失`);
});

// ───────────────────────── 2. @Remote 标记 ─────────────────────────

test('每个端点都带 @Remote 标记，且是直接调用（非 stream、非 scope）', () => {
  const face = makeFace(makeRpc([]));
  const markers = remoteMethods(face);

  assert.equal(markers.length, CONSOLE_RPC_METHODS.length);
  for (const marker of markers) {
    assert.equal(marker.invocation.kind, 'direct', `${marker.method} 应为直接调用`);
    assert.equal(marker.mode, undefined, `${marker.method} 不应是 stream（控制台端点都是单次请求）`);
    assert.equal(marker.exportName, undefined, `${marker.method} 不应改名导出（线名须等于方法名）`);
  }
});

// ───────────────────────── 3. 代理 this（回归锁） ─────────────────────────

test('方法在代理 this 下可调用：依赖不得放在语言级私有字段里（回归锁）', async () => {
  // cordis 把 Service 包成 traceable 代理后交给调用方；网关用
  // `Reflect.apply(method, receiver, args)` 调用，那个 receiver 就是代理。
  //
  // 曾经把 `ConsoleRpc` 存在 `#rpc` 字段里，于是端点已能被认领、参数也校验通过，
  // 一到方法体就抛：
  //   Cannot read private member #rpc from an object whose class did not declare it
  //
  // 空 Proxy 精确复现「this 不是实例本身」这一点，且不依赖 cordis 的内部实现。
  const calls: ConsoleRequest[] = [];
  const rpc = makeRpc(calls);
  const face = makeFace(rpc);

  const proxied = new Proxy(face, {});
  const method = (proxied as unknown as Record<string, unknown>)['getState'];
  assert.equal(typeof method, 'function');

  const response = await (method as (this: unknown, r: ConsoleRequest) => Promise<unknown>).call(
    proxied,
    {
      method: 'getState',
      params: { engagementId: 'e1' },
      expectedStateVersion: 0,
      reason: '代理 this 回归测试',
      idempotencyKey: 'k-proxy',
    },
  );

  assert.ok(response !== null && typeof response === 'object');
  assert.equal((response as { ok: boolean }).ok, true, '代理 this 下必须仍能拿到响应');
  assert.equal(calls.length, 1, '信封必须真的到达 ConsoleRpc');
});

// ───────────────────────── 4. 参数名与转发 ─────────────────────────

test('服务以命名空间为键注册，且键名与命名空间一致', () => {
  const { ctx, provided } = makeCtx();
  const rpc = makeRpc([]);
  const face = new ConsoleTypertService(ctx, {
    rpc,
    operator: { id: 'op-1', source: 'test' },
  });

  assert.deepEqual(provided, [CONSOLE_TYPRET_SERVICE], '构造即注册，且只注册这一个服务');
  // 网关的 `collectSrcClaims` 读这个绑定来认领端点；namespace 决定 URL 前缀。
  assert.equal(face.typertRemote.namespace, CONSOLE_TYPRET_SERVICE);
  assert.equal(face.typertRemote.serviceKey, CONSOLE_TYPRET_SERVICE);
});

test('信封与调用上下文原样交给 ConsoleRpc：门面不重复业务判定', async () => {
  // 这里用一个**记录型替身**而不是真 ConsoleRpc：要断言的是门面的契约
  // （它把什么转发下去），不是 ConsoleRpc 的内部行为。经真 ConsoleRpc 观察会看到
  // 它派生后的输入，反而看不清"信封是否被原样转交"。
  const seen: Array<{ request: ConsoleRequest; operatorId: string; source: string }> = [];
  const fakeRpc = {
    async handle(request: ConsoleRequest, context: { operatorId: string; source: string }) {
      seen.push({ request, operatorId: context.operatorId, source: context.source });
      return { ok: true, method: request.method, result: null, replay: false };
    },
  } as unknown as ConsoleRpc;

  const face = makeFace(fakeRpc);
  const envelope: ConsoleRequest = {
    method: 'getState',
    params: { engagementId: 'e7' },
    expectedStateVersion: 3,
    reason: '人工查看',
    idempotencyKey: 'k-7',
  };
  const response = await (face as unknown as {
    getState(r: ConsoleRequest): Promise<{ ok: boolean; method?: string }>;
  }).getState(envelope);

  assert.equal(seen.length, 1);
  assert.deepEqual(seen[0]?.request, envelope, '必须逐字转发（含幂等键与期望版本），不在途中改写');
  // 操作者与来源来自部署选项（网关拿不到认证主体，见 index.ts 的 config.operator）
  assert.equal(seen[0]?.operatorId, 'op-1');
  assert.equal(seen[0]?.source, 'test');
  assert.equal(response.ok, true);
  assert.equal(response.method, 'getState');
});

test('操作者身份来自部署选项，不是请求：信封无法伪造它', async () => {
  // 网关的 handler 签名 `(endpoint, payload, signal)` 拿不到认证主体，
  // 因此操作者必须由部署声明。这条锁住「信封里塞 operatorId 也不会生效」——
  // 实际效果是 `ConsoleRpc` 会以 `console/operator-forbidden` 拒掉（身份键不得出现在 params）。
  const calls: ConsoleRequest[] = [];
  const rpc = makeRpc(calls);
  const face = makeFace(rpc);

  const response = await (face as unknown as {
    getState(r: ConsoleRequest): Promise<{ ok: boolean; code?: string }>;
  }).getState({
    method: 'getState',
    params: { engagementId: 'e1', operatorId: 'attacker' },
    expectedStateVersion: 0,
    reason: '试图伪造操作者',
    idempotencyKey: 'k-9',
  });

  assert.equal(response.ok, false, '身份键出现在 params 时必须被拒');
  assert.equal(response.code, 'console/operator-forbidden');
});
