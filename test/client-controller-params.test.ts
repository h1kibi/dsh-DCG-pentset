/**
 * 「客户端发出的 params 必须落在方法表声明内」的回归测试。
 *
 * ── 这条测试防的是哪一类缺陷 ──
 *
 * 控制台的 `params` 是**闭合**的：`buildInput` 对未声明的键一律拒绝
 * （「静默忽略会让客户端以为它生效了」）。因此客户端多发一个字段 = 该端点整体不可用，
 * 而不是「多余字段被忽略」。实测已经踩过两次：
 *
 *   - `readMemory` 把 `reason` 同时放进 `params` 与信封 → kwargs 不认 `reason`
 *     → **读原文功能完全不可用**；
 *   - `refreshSkills` 多带一个 `engagementId`（skill 是全局库、不绑定 engagement）
 *     → **Skill 库面板恒为空**，且那个 `id === null` 守卫还让未选中时根本不发请求。
 *
 * 两个缺陷都逃过了全部单元测试：测试直接调服务方法，从不经过**客户端 → 方法表**这条缝。
 * 这条测试就是那条缝的检查点。
 *
 * ── 为什么不是「跑一遍真服务」 ──
 *
 * 那需要数据库与真服务面；而这里要验的是**形状**（键集），不是业务结果。
 * 用一个捕获型 invoker 拿到客户端真正发出的 params，与 `describeConsoleMethods()`
 * 的字段声明逐条比对即可——判据来自方法表本身，不来自我手写的期望值
 * （手写期望值会在改表时腐烂成第二份真相）。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { ConsoleController, draftRejectionMessage } from '../src/client/controller.ts';
import type { HostRpcResult } from '../src/console/rpc.ts';
import { ConsoleRpc, describeConsoleMethods } from '../src/console/rpc.ts';
import type { ConsoleServices } from '../src/console/rpc.ts';

const NOW = new Date('2026-09-19T12:00:00Z');
const ENGAGEMENT = 'e1';

/** 方法表声明的 params 字段 + 允许出现在 params 里的信封级键。 */
function declaredParams(): ReadonlyMap<string, ReadonlySet<string>> {
  const map = new Map<string, ReadonlySet<string>>();
  for (const desc of describeConsoleMethods()) {
    // `expectedStateVersion` 允许出现在 params（lock: 'actor' 的方法由客户端显式提供）；
    // 信封自身的键（method/reason/idempotencyKey）**不允许**出现在 params 里——
    // 它们进 params 就是 `console/argument-invalid`。
    map.set(desc.name, new Set([...desc.fields.map((f) => f.name), 'expectedStateVersion']));
  }
  return map;
}

interface Captured {
  readonly method: string;
  readonly params: Readonly<Record<string, unknown>>;
}

/**
 * 四个服务面都在、每个方法都返回空数组的桩。
 *
 * 本测试只关心**请求能否通过校验**（信封形状 → 身份边界 → 端点存在 → 该端点的前置要求），
 * 不关心业务结果——那是各服务面自己测试的事。用宽容桩而非真实现，
 * 是为了让失败信息只指向形状问题，不被业务错误淹没。
 */
function permissiveServices(): ConsoleServices {
  const face = new Proxy({}, { get: () => async () => [] });
  return { workflow: face, report: face, memory: face, skills: face } as unknown as ConsoleServices;
}

/**
 * 捕获**并且真的交给服务端校验**的 invoker。
 *
 * ── 为什么要过真 ConsoleRpc 而不是只捕获 ──
 *
 * 「形状对」与「服务端接受」是两件事：`params` 是**闭合**的，多一个键就整体被拒。
 * 实测过两次真实故障（`readMemory` 的 reason、三处 `{ params: … }` 双重包装），
 * 它们都能通过「只看键集」的弱检查吗？——不，键集检查能抓到；但**判断依据**如果由
 * 我自己写（而不是方法表），就会随表腐烂。因此这里把捕获到的信封原样交给
 * {@link ConsoleRpc}：判定权在服务端，测试只断言「它接受了」。
 *
 * 服务面用 `consoleServicesStub`：本测试只关心请求能否通过校验，
 * 业务结果由各自的测试负责。
 */
function capturingController(): {
  controller: ConsoleController;
  calls: Captured[];
  rejected: string[];
} {
  const calls: Captured[] = [];
  const rejected: string[] = [];
  const rpc = new ConsoleRpc({ services: permissiveServices() });

  const invoke = async (
    _channel: string,
    endpoint: string,
    payload: unknown,
  ): Promise<HostRpcResult> => {
    const envelope = (payload as {
      args: { request: { method: string; params?: Record<string, unknown> } };
    }).args.request;
    calls.push({ method: endpoint.split('/').at(-1) ?? envelope.method, params: envelope.params ?? {} });

    // 真服务端校验：把信封交给 ConsoleRpc，看它是否接受。
    const response = await rpc.handle(envelope, {
      operatorId: 'op-1',
      authenticatedAt: NOW,
      source: 'client-controller-params-test',
    });
    if (!response.ok) rejected.push(`${envelope.method}: [${response.code}] ${response.message}`);
    return response.ok
      ? { ok: true, value: response }
      : { ok: false, error: { code: response.code, message: response.message, details: {} } };
  };

  const controller = new ConsoleController({ invoke, clock: () => NOW });
  return { controller, calls, rejected };
}

/** 逐条比对：客户端发出的每个 params 键都必须在方法表里声明过。 */
function assertParamsDeclared(calls: readonly Captured[], rejected: readonly string[]): void {
  // 服务端接受了每一个请求（含参数形状、身份边界、乐观锁门槛）。
  assert.deepEqual(rejected, [], `服务端拒绝了客户端发出的请求：\n  ${rejected.join('\n  ')}`);

  const declared = declaredParams();
  const violations: string[] = [];
  for (const call of calls) {
    const allowed = declared.get(call.method);
    if (allowed === undefined) {
      violations.push(`${call.method}: 方法表里没有这个端点`);
      continue;
    }
    const extra = Object.keys(call.params).filter((key) => !allowed.has(key));
    if (extra.length > 0) {
      violations.push(
        `${call.method}: 多发了 ${extra.map((k) => JSON.stringify(k)).join(', ')}` +
          `（声明内有：${[...allowed].join(', ')}）`,
      );
    }
  }
  assert.deepEqual(violations, [], `客户端发出的 params 超出方法表声明：\n  ${violations.join('\n  ')}`);
}

// ───────────────────────── 读路径 ─────────────────────────

test('读端点的 params 全部落在方法表声明内', async () => {
  const { controller, calls, rejected } = capturingController();
  await controller.select(ENGAGEMENT);

  await controller.refreshEngagements();
  await controller.refreshFindings();
  await controller.refreshApprovals();
  await controller.refreshScope(true);
  await controller.refreshCandidateAssets();
  await controller.refreshSkills(true);
  await controller.readMemoryWatermark();
  await controller.previewScope({ targets: [], exclusions: [] });
  await controller.searchMemory({ query: 'x', kinds: ['fact'], includeReasoning: false, limit: 5 });
  await controller.readMemory(['memory:1'], '人工查看命中原文');

  assert.ok(calls.length >= 10, `应捕获到多次调用，实际 ${String(calls.length)}`);
  assertParamsDeclared(calls, rejected);
});

test('refreshState 发出的两个端点参数正确（getState 是标量形状，客户端仍按命名参数发）', async () => {
  // `getState(engagementId: string)` 在方法表里是标量形状：控制台把 engagementId 的
  // **裸值**作为唯一实参传给服务。客户端这一侧不受影响——它照常发命名参数
  // （`{engagementId}`），形状由表在服务边界处处理。这条断言把这条分工钉住。
  const { controller, calls, rejected } = capturingController();
  await controller.select(ENGAGEMENT);

  const methods = calls.map((c) => c.method);
  assert.ok(methods.includes('getState'), `应调用 getState，实际：${methods.join(', ')}`);
  assert.ok(methods.includes('listWorkerSessions'), `应调用 listWorkerSessions，实际：${methods.join(', ')}`);
  assertParamsDeclared(calls, rejected);
});

test('listSkills 不要求选中 engagement（skill 是全局库）', async () => {
  // 它此前多带一个 `engagementId`，且有一个「未选中就不发请求」的守卫——
  // 两者都把「全局库」误当成 engagement 局部资源，后果是 Skill 库面板恒为空。
  const { controller, calls, rejected } = capturingController();
  // 有意**不**调用 select：没有选中的 engagement。
  const result = await controller.refreshSkills();

  assert.deepEqual(result, [], '未选中 engagement 时也应能读到全局 skill 库');
  assert.deepEqual(
    calls.map((c) => c.method),
    ['listSkills'],
    '必须真的发出请求，且只发 listSkills',
  );
  assertParamsDeclared(calls, rejected);
});

test('处置结论把 reason 放在信封而不是闭合 params 中', async () => {
  const { controller, calls, rejected } = capturingController();
  await controller.dispositionFinding({ findingId: 'f1', action: 'accept', reason: '确认证据充分' });

  assertParamsDeclared(calls, rejected);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.method, 'dispositionFinding');
  assert.equal('reason' in calls[0]!.params, false, 'reason 必须走 RPC 信封');
  assert.equal(calls[0]!.params.findingId, 'f1');
  assert.equal(calls[0]!.params.action, 'accept');
});

// ───────────────────────── intake 会话键 ─────────────────────────

/**
 * 会话键必须**跨控制器实例稳定**。
 *
 * ── 它为什么是行为而不是实现细节 ──
 *
 * 服务端按 `(tenant_id, client_session_key)` 查重：命中即**恢复**该 intake，
 * 未命中才新建 engagement。因此这个键就是「刷新」与「新建」之间的开关。
 * 此前它每次构造都重新随机，于是浏览器每刷新一次就多一个 intake——实测把库从 5 条
 * 推到 8 条，**每条都挂着活动 Worker 会话与租约**，而运行时只锁定其中一条。
 *
 * 断言落在**发出的请求参数**上，而不是控制器字段上：前者是服务端看到的事实，
 * 后者只是它的来源。
 */
class FakeStorage {
  readonly #items = new Map<string, string>();
  getItem(key: string): string | null {
    return this.#items.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.#items.set(key, value);
  }
}

/** 构造一个控制器、触发 `openTask`，返回它实际发出去的 `clientSessionKey`。 */
async function clientSessionKeySentBy(): Promise<string> {
  let sent: string | null = null;
  const controller = new ConsoleController({
    clock: () => NOW,
    invoke: async (_channel, _endpoint, payload) => {
      const envelope = (payload as {
        args: { request: { method: string; params?: Record<string, unknown> } };
      }).args.request;
      if (envelope.method === 'openTask') sent = String(envelope.params?.['clientSessionKey'] ?? '');
      // 这里只需拿到请求；业务结果由服务面自己的测试负责（与文件头同一约定）。
      return { ok: false, error: { code: 'console/internal', message: '本用例只看请求参数', details: {} } };
    },
  });
  await controller.openTask();
  assert.ok(sent !== null, 'openTask 必须发出请求');
  return sent;
}

/** 装一个假的 `localStorage`（Node 默认没有），返回还原函数。 */
function withFakeStorage(value: unknown): () => void {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value });
  return () => {
    if (original === undefined) delete (globalThis as { localStorage?: unknown }).localStorage;
    else Object.defineProperty(globalThis, 'localStorage', original);
  };
}

test('同一浏览器的第二次挂载复用同一个 intake 会话键（刷新＝恢复，不是新建）', async () => {
  const restore = withFakeStorage(new FakeStorage());
  try {
    const first = await clientSessionKeySentBy();
    const second = await clientSessionKeySentBy();
    assert.equal(second, first, '刷新后换键会让服务端每次都新建 intake（实测 5→8 条）');
    assert.notEqual(first.trim(), '', '键不能为空：服务端会以 classification_rejected 拒绝');
  } finally {
    restore();
  }
});

test('没有浏览器存储时退回每次新建，且不抛错', async () => {
  // 降级路径必须有：Node（测试）与非浏览器嵌入方共用这个构造函数。
  // 代价是刷新会多留一个 intake，但控制台仍可用——比直接抛错好。
  const restore = withFakeStorage(undefined);
  try {
    const first = await clientSessionKeySentBy();
    const second = await clientSessionKeySentBy();
    assert.notEqual(second, first, '无存储时无从持久化，只能新建');
  } finally {
    restore();
  }
});

// ─────────────────── 自动建单被拒的措辞 ───────────────────

/**
 * 回归锁：重启后控制台回到**已确认过范围的** intake 会话时，`openTask` 会被服务端以
 * `classification_rejected` 拒绝。服务端原文（「该客户端任务已离开 intake 阶段，不能重新
 * 创建 intake」）挂在红色错误条里对人类是惊吓，而此刻该做的是从列表选中已有作业。
 * 因此这一种拒绝译成人话；**其它拒绝码必须原样透出**——不认识就不要替服务端改写事实。
 */
test('「已离开 intake」的拒绝译成中性提示，其它拒绝原样透出', () => {
  const serverText = '该客户端任务已离开 intake 阶段，不能重新创建 intake';
  const translated = draftRejectionMessage('classification_rejected', serverText);
  assert.match(translated, /已经离开 intake 阶段/);
  assert.match(translated, /从上方列表选中它/, '必须给出下一步动作，而不是只报错');
  assert.equal(translated.includes(serverText), false, '不要把人话和惊吓文案混在一起');

  assert.equal(
    draftRejectionMessage('lease_required', '会话不存在'),
    '会话不存在',
    '不认识的拒绝码原样透出',
  );
  assert.equal(
    draftRejectionMessage('classification_rejected', 'clientSessionKey 不能为空'),
    'clientSessionKey 不能为空',
    '同一个码但不是那件事时也不能改写',
  );
  assert.equal(
    draftRejectionMessage('classification_rejected', 'intake 提案已被取代'),
    'intake 提案已被取代',
    '只含 intake 的其它拒绝必须原样透出（改写会让服务端原文不可见）',
  );
});
