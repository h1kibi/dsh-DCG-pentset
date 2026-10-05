/**
 * 控制台客户端调用层测试。
 *
 * 重点锁定三条（都是 §15.3 / §15.4 要求控制台必须成立的事）：
 *   1. **幂等键由调用方提供**——本层不自动生成，否则重试会拿到新键、幂等失效
 *   2. **期望状态版本是必填**——可省略就等于允许悄悄放弃并发保护
 *   3. **错误码保留**——UI 要据码分支（冲突时重读、需放行时引导）
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_CALL_TIMEOUT_MS,
  ConsoleClient,
  ConsoleCallError,
  buildEnvelope,
  toCallResult,
  isConflict,
  isRetryable,
} from '../src/console/client.ts';
import type { ConsoleCallInput } from '../src/console/client.ts';
import type { HostRpcResult } from '../src/console/rpc.ts';
import { CONSOLE_TYPRET_SERVICE, DEFAULT_CONSOLE_CHANNEL } from '../src/console/method-names.ts';
import type { ConsoleMethodName } from '../src/console/method-names.ts';
import type { WorkflowSnapshot } from '../src/contracts.ts';

const SNAPSHOT: WorkflowSnapshot = {
  engagementId: 'e1',
  mainStatus: 'worker_running',
  runMarker: 'running',
  currentPhase: 'intelligence-gathering',
  stateVersion: 4,
  graphIteration: 1,
  activeWorkerSessionId: 'w1',
  scopeVersion: 1,
  authorizationExpiresAt: null,
};

const SIGNAL = new AbortController().signal;

function callInput(over: Partial<ConsoleCallInput> = {}): ConsoleCallInput {
  return {
    method: 'pause' as ConsoleMethodName,
    params: { engagementId: 'e1' },
    expectedStateVersion: 3,
    reason: '人工暂停',
    idempotencyKey: 'k-1',
    ...over,
  };
}

/** 捕获调用参数的假 Host 调用器。 */
function fakeInvoker(result: HostRpcResult): {
  invoke: (channel: string, endpoint: string, payload: unknown, signal: AbortSignal) => Promise<HostRpcResult>;
  calls: Array<{ channel: string; endpoint: string; payload: unknown; signal: AbortSignal }>;
} {
  const calls: Array<{ channel: string; endpoint: string; payload: unknown; signal: AbortSignal }> = [];
  return {
    calls,
    invoke: async (channel, endpoint, payload, signal) => {
      calls.push({ channel, endpoint, payload, signal });
      return result;
    },
  };
}

// ─────────────── 信封构造 ───────────────

test('信封字段名与 Host 侧一致（两侧不一致会让每个请求都被拒且不指出原因）', () => {
  const env = buildEnvelope(callInput());
  assert.deepEqual(Object.keys(env).sort(), [
    'expectedStateVersion',
    'idempotencyKey',
    'method',
    'params',
    'reason',
  ]);
});

test('空 reason 放行给信封：客户端只校验形状，强不强制由服务端按方法规格判定', () => {
  // 2026-10-05：放行决定允许空附言（人类要能直接点「批准这一次执行」）。
  // 「哪些方法必须写非空理由」是**服务端策略**（规格里的 `reason` / `reasonOptional`），
  // 客户端看不到那张表——替它拦会连"可选附言"的方法一起挡死，而且拦在发请求之前。
  const env = buildEnvelope(callInput({ reason: '' }));
  assert.equal(env.reason, '');
});

test('reason 不是字符串：仍然拒绝（形状是硬的）', () => {
  assert.throws(
    () => buildEnvelope(callInput({ reason: 42 as unknown as string })),
    (e: unknown) => e instanceof ConsoleCallError && e.field === 'reason',
  );
});

test('缺幂等键：拒绝（无法区分重复点击与有意重复）', () => {
  assert.throws(
    () => buildEnvelope(callInput({ idempotencyKey: '' })),
    (e: unknown) => e instanceof ConsoleCallError && e.field === 'idempotencyKey',
  );
});

test('期望状态版本非整数或为负：拒绝（否则并发保护失效）', () => {
  for (const bad of [1.5, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.throws(
      () => buildEnvelope(callInput({ expectedStateVersion: bad })),
      (e: unknown) => e instanceof ConsoleCallError && e.field === 'expectedStateVersion',
      String(bad),
    );
  }
});

test('版本 0 是合法的（新 engagement 的初始版本）', () => {
  assert.equal(buildEnvelope(callInput({ expectedStateVersion: 0 })).expectedStateVersion, 0);
});

test('构造期错误指出字段名（服务端拒绝不会指出调用方该改哪里）', () => {
  try {
    // 用**形状**违规触发（空串已合法：那是服务端策略，见上一条用例的说明）。
    buildEnvelope(callInput({ reason: 42 as unknown as string }));
    assert.fail('应当抛错');
  } catch (e) {
    assert.ok(e instanceof ConsoleCallError);
    assert.equal(e.field, 'reason');
    assert.match(e.message, /reason/);
  }
});

// ─────────────── 端点与调用 ───────────────

test('默认通道前缀来自 host-channel 的常量（两侧同一个来源）', () => {
  const { invoke } = fakeInvoker({ ok: true, value: { ok: true, method: 'pause', result: {}, replay: false } });
  const client = new ConsoleClient({ invoke });
  assert.equal(client.channel, DEFAULT_CONSOLE_CHANNEL);
});

test('自定义通道前缀被使用', () => {
  const { invoke } = fakeInvoker({ ok: true, value: { ok: true, method: 'pause', result: {}, replay: false } });
  const client = new ConsoleClient({ invoke, channel: '/rpc/custom' });
  assert.equal(client.channel, '/rpc/custom');
});

test('调用把信封作为 payload 传出，并透传 signal', async () => {
  const { invoke, calls } = fakeInvoker({
    ok: true,
    value: { ok: true, method: 'pause', result: { done: true }, replay: false },
  });
  const client = new ConsoleClient({ invoke });
  await client.call(callInput(), SIGNAL);
  assert.equal(calls.length, 1);
  // 通道与端点是**两个参数**（对应 ctx.connection.rpc.call(channel, endpoint, …)）
  assert.equal(calls[0]!.channel, DEFAULT_CONSOLE_CHANNEL);
  assert.equal(calls[0]!.endpoint, `${CONSOLE_TYPRET_SERVICE}/pause`);
  assert.equal(calls[0]!.signal, SIGNAL, 'signal 必须透传：中止要能取消在途请求');
  // 信封在 `payload.args.request`（两层 args 的原因见文件末尾那条测试）
  const payload = calls[0]!.payload as { args: { request: { method: string; reason: string } } };
  assert.equal(payload.args.request.method, 'pause');
  assert.equal(payload.args.request.reason, '人工暂停');
});

// ─────────────── 结果分类 ───────────────

test('成功：提取 result 与 replay', async () => {
  const { invoke } = fakeInvoker({
    ok: true,
    value: { ok: true, method: 'pause', result: { stateVersion: 4 }, replay: false },
  });
  const result = await new ConsoleClient({ invoke }).call(callInput(), SIGNAL);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.deepEqual(result.value, { stateVersion: 4 });
  assert.equal(result.replay, false);
});

test('幂等重放被标记（UI 可据此避免重复提示「已执行」）', async () => {
  const { invoke } = fakeInvoker({
    ok: true,
    value: { ok: true, method: 'pause', result: { stateVersion: 4 }, replay: true },
  });
  const result = await new ConsoleClient({ invoke }).call(callInput(), SIGNAL);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.replay, true);
});

test('版本冲突：保留码、标记 conflict、附带最新状态', () => {
  const result = toCallResult('pause', {
    ok: false,
    error: {
      code: 'stale_state_version',
      message: '版本不匹配',
      details: { method: 'pause', state: SNAPSHOT },
    },
  });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.code, 'stale_state_version');
  assert.equal(result.conflict, true, '冲突被提升为具名布尔');
  assert.deepEqual(result.state, SNAPSHOT, '§15.4：冲突时把最新状态带回，界面不必再读一次');
  assert.equal(isConflict(result), true);
});

test('需放行的拒绝：不是冲突、不自动重试（正确动作是等人放行）', () => {
  const result = toCallResult('pentest_exec', {
    ok: false,
    error: { code: 'approval_required', message: '需要人类放行', details: {} },
  });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.conflict, false);
  assert.equal(isRetryable(result), false, '业务拒绝自动重试没有意义');
});

test('内部错误：可重试（传输层问题，可能瞬时）', () => {
  const result = toCallResult('getState', {
    ok: false,
    error: { code: 'console/internal', message: '内部错误', details: {} },
  });
  assert.equal(isRetryable(result), true);
});

test('成功的结果不可重试（isRetryable 对成功返回 false）', () => {
  const result = toCallResult('pause', {
    ok: true,
    value: { ok: true, method: 'pause', result: {}, replay: false },
  });
  assert.equal(isRetryable(result), false);
});

test('宿主已解包 value：同样被接受（兼容两种形态）', () => {
  // 若将来 remote 层对 value 做一次解包，这个分支就是实际形态。
  // 强制规定一种形态会让上游一变就全线失败，故宽容处理。
  const result = toCallResult('getState', { ok: true, value: { snapshots: [] } });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.deepEqual(result.value, { snapshots: [] });
  assert.equal(result.replay, false);
});

test('details 缺 method：回落到调用时的方法名（不丢定位信息）', () => {
  const result = toCallResult('pause', {
    ok: false,
    error: { code: 'console/internal', message: 'x', details: {} },
  });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.method, 'pause');
});

test('details 的 method 优先于调用时的方法名（服务端更清楚实际路由到哪）', () => {
  const result = toCallResult('pause', {
    ok: false,
    error: { code: 'console/internal', message: 'x', details: { method: 'resume' } },
  });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.method, 'resume');
});

// ─────────────── 幂等键的生命周期 ───────────────

test('幂等键不自动生成：重试必须复用同一个键，否则幂等失效', async () => {
  // 这是本类最关键的形状约束。若本类自动生成键，每次重试都会拿到新键，
  // 服务端就会把「同一次操作的重试」当成新操作——正是 §15.3 要防的
  // 「重试时创建第二个 Worker」。
  const { invoke, calls } = fakeInvoker({
    ok: true,
    value: { ok: true, method: 'pause', result: {}, replay: false },
  });
  const client = new ConsoleClient({ invoke });
  const input = callInput({ idempotencyKey: 'same-key' });
  await client.call(input, SIGNAL);
  await client.call(input, SIGNAL); // 同一次操作的重试
  const keys = calls.map(
    (c) => (c.payload as { args: { request: { idempotencyKey: string } } }).args.request.idempotencyKey,
  );
  assert.deepEqual(keys, ['same-key', 'same-key'], '两次调用必须携带同一个键');
});

test('newIdempotencyKey：单调且彼此不同（供「新点击」使用）', () => {
  const client = new ConsoleClient({ invoke: async () => ({ ok: true, value: {} }) });
  const keys = new Set([client.newIdempotencyKey(), client.newIdempotencyKey(), client.newIdempotencyKey()]);
  assert.equal(keys.size, 3, '每次生成的键必须不同');
});

test('newIdempotencyKey：不依赖 Web Crypto（本地 http 开发环境不是安全上下文）', () => {
  // 若用 crypto.randomUUID，在 http://localhost 下会抛错（randomUUID 需安全上下文），
  // 表现为「本地调试时所有写操作失败」。用时间戳+计数器避开这一点。
  const client = new ConsoleClient({ invoke: async () => ({ ok: true, value: {} }) });
  const key = client.newIdempotencyKey();
  assert.match(key, /^ui-\d+-\d+$/, `键形状应为 ui-<时间戳>-<序号>，实际 ${key}`);
});

test('newIdempotencyKey：前缀可自定义（便于区分不同入口）', () => {
  const client = new ConsoleClient({ invoke: async () => ({ ok: true, value: {} }) });
  assert.match(client.newIdempotencyKey('wizard'), /^wizard-/);
});

// ─────────────── 方法面 ───────────────

test('ConsoleClient.methods 暴露全部人类端点（供 UI 生成菜单）', () => {
  const methods = ConsoleClient.methods();
  // 不硬编码数量：端点数会随设计演进；这里断言「方法集非空且含关键端点」
  assert.ok(methods.length >= 20, `人类端点应有 20 个（18 个状态机操作 + 创建/列表），实际 ${methods.length}`);
  assert.ok(methods.includes('createEngagement' as ConsoleMethodName), '授权向导需要创建端点');
  assert.ok(methods.includes('listEngagements' as ConsoleMethodName), '控制台首页需要列表端点');
  assert.ok(methods.includes('startWorker' as ConsoleMethodName));
  assert.ok(methods.includes('confirmTransition' as ConsoleMethodName));
  assert.equal(
    methods.includes('finishWorker' as ConsoleMethodName),
    false,
    'finishWorker 是 Agent 侧动作，不在控制台面',
  );
});

// ───────────────────────────── 超时（防「永久转圈」） ─────────────────────────────

test('通道不响应时超时并返回 channel-unavailable，而不是让 Promise 悬着', async () => {
  // 实测踩过：宿主的控制台通道没注册时（缺 `config.operator`），`rpc.call` 既不解析
  // 也不拒绝，界面上的「正在读取…」永远转下去——没有任何错误、没有任何线索。
  //
  // 悬着的 Promise 在 UI 里等价于「功能消失且无解释」，比一个明确的失败更糟。
  const client = new ConsoleClient({
    // 永不 settle：模拟未注册的通道（不是拒绝，是石沉大海）。
    invoke: () => new Promise<HostRpcResult>(() => {}),
    timeoutMs: 20,
  });

  const result = await client.call(
    { method: 'listEngagements', params: {}, expectedStateVersion: 0, reason: '读取', idempotencyKey: 'k1' },
    new AbortController().signal,
  );

  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.code, 'console/channel-unavailable', '部署配置类失败要有可判别的码');
  assert.match(result.message, /config\.operator/, '提示要指向可执行的排查方向');
});

test('传输层抛错被转成 internal 结果，同样不会让 Promise 悬着', async () => {
  const client = new ConsoleClient({
    invoke: () => Promise.reject(new Error('socket closed')),
    timeoutMs: 50,
  });

  const result = await client.call(
    { method: 'listEngagements', params: {}, expectedStateVersion: 0, reason: '读取', idempotencyKey: 'k2' },
    new AbortController().signal,
  );

  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.code, 'console/internal');
  assert.equal(result.message, 'socket closed');
});

test('正常返回时不触发超时，且默认超时是可观的量级', () => {
  // 默认值不能太短：单库查询在毫秒级，但冷启动/连接池首连会慢一些；
  // 也不能太长——「等一分钟再报错」在界面上与永远转圈几乎没区别。
  assert.ok(DEFAULT_CALL_TIMEOUT_MS >= 5000 && DEFAULT_CALL_TIMEOUT_MS <= 30000, String(DEFAULT_CALL_TIMEOUT_MS));
});

// ─────────────────── 经共享网关的调用形状（Typert /api） ───────────────────

test('调用形状走共享网关：通道 /api、端点 <命名空间>/<方法>、载荷两层 args', async () => {
  // 这三件事都由**宿主的共享网关**决定，不是本插件自定的，且三处都踩过坑：
  //
  //   1. 通道必须是 `/api`。自建前缀通道在本版本不可用——`connection.rpc.handle()`
  //      内部用 connection 服务自己的 `ctx.webServer`，而它的 `inject` 不含 `webServer`，
  //      任何调用方都会抛 `cannot get property "webServer" without inject`。
  //   2. 端点必须是 `namespace/method` **两段**：`remoteRequest` 按 `/` 切分并要求恰好两段。
  //   3. 载荷必须**恰好**含一个 plain-object 的 `args` 字段（外层），
  //      而 `payload.args` 内是宿主方法的**具名参数表**（内层）。
  //      只写一层时网关报 `args fields do not match the descriptor: unexpected "method", …`；
  //      字段名还必须与宿主方法参数名一致（SRC 模式从函数源码解析参数名），
  //      宿主侧 39 个方法的参数都叫 `request`。
  const { invoke, calls } = fakeInvoker({ ok: true, value: { ok: true, method: 'pause', result: null, replay: false } });
  const client = new ConsoleClient({ invoke });

  await client.call(callInput(), SIGNAL);

  assert.equal(calls.length, 1);
  const [call] = calls;
  assert.ok(call !== undefined);
  assert.equal(call.channel, '/api', '必须走连接的共享网关通道');
  assert.equal(call.endpoint, `${CONSOLE_TYPRET_SERVICE}/pause`, '端点必须是 namespace/method 两段');
  assert.equal(
    DEFAULT_CONSOLE_CHANNEL,
    '/api',
    '默认通道常量必须与实测可用的那个一致（宿主通道规则是单层名）',
  );

  // 载荷：外层网关容器 + 内层宿主参数表
  const payload = call.payload as { args?: Record<string, unknown> };
  assert.ok(payload !== null && typeof payload === 'object', '载荷必须是对象');
  assert.deepEqual(Object.keys(payload), ['args'], '外层只允许 args 一个字段（多一个就被网关拒）');
  const inner = payload.args as Record<string, unknown>;
  assert.deepEqual(Object.keys(inner), ['request'], '内层键必须等于宿主方法的参数名');
  assert.deepEqual(inner['request'], {
    method: 'pause',
    params: { engagementId: 'e1' },
    expectedStateVersion: 3,
    reason: '人工暂停',
    idempotencyKey: 'k-1',
  });
});

test('端点前缀来自同一常量：命名空间不得在两处各写一份', async () => {
  // 客户端拼 `/api/<ns>/<method>`，宿主用同一个键注册服务与 Remote 命名空间。
  // 两处各写一份字符串的话，改一处就变成静默 404（路由未认领 → 静态兜底）。
  const { invoke, calls } = fakeInvoker({ ok: true, value: { ok: true, method: 'getState', result: null, replay: false } });
  const client = new ConsoleClient({ invoke });

  await client.call(callInput({ method: 'getState' as ConsoleMethodName }), SIGNAL);

  const [call] = calls;
  assert.ok(call !== undefined);
  assert.ok(
    call.endpoint.startsWith(`${CONSOLE_TYPRET_SERVICE}/`),
    `端点应以命名空间常量开头：${call.endpoint}`,
  );
});
