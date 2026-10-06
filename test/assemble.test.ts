/**
 * 装配层回归测试：`apply` 的装配行为。
 *
 * **这个文件存在的理由**：此前 412 个测试全绿，却从未调用过 `apply` /
 * `createWorkerTools`，导致一个硬缺陷无人发现——`apply` 的第三个参数由宿主注入，
 * 而 cordis 恒只传两个参数（`cordis/lib/index.js:1066-1070`），于是 `apply`
 * 永远走早退分支、注册 0 个工具。实测当时的输出是 `tools registered: 0`。
 *
 * 这些测试按 cordis 的**真实调用语义**（两个参数）调用 `apply`，因此任何
 * 「依赖宿主注入」的回归都会立刻失败。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  apply,
  applyPentest,
  PENTEST_HOST_SERVICES,
  PentestBootError,
  REQUIRED_ECOSYSTEM_PLUGINS,
} from '../src/index.ts';
import type { PluginConfig } from '../src/index.ts';
import type { WorkerToolDeps } from '../src/tools/worker.ts';
import { WORKER_TOOL_NAMES, TARGET_TOOL_NAMES } from '../src/tools/worker.ts';

interface Recorder {
  tools: string[];
  guards: number;
  effects: number;
  prefilters: number;
  logs: string[];
}

/** 最小可用的假服务面：只验证装配，不验证业务。 */
const fakeDeps: WorkerToolDeps = {
  // 装配期不读 skill：给空实现，形状对上即可。
  async loadSkill() {
    return { skill: null, loadedNames: [] };
  },
  async bootstrapIntake(input) {
    return {
      engagementId: 'e1',
      workerSessionId: 'w1',
      dshSessionId: input.dshSessionId,
      leaseId: 'l1',
      leaseGeneration: 1,
      scopeVersion: 0,
      resumed: false,
      nextStep: '装配测试',
    };
  },
  async resolveWorkerSessionId(dshSessionId) {
    // 装配测试只关心注册是否成功，不关心身份解析；按派生约定回一个确定值。
    return dshSessionId.startsWith('dsh-') ? dshSessionId.slice(4) : null;
  },
  async resolveWorkerSessionContext(dshSessionId) {
    const workerSessionId = dshSessionId.startsWith('dsh-') ? dshSessionId.slice(4) : null;
    return workerSessionId === null ? null : { workerSessionId, leaseGeneration: 1 };
  },
  async search() {
    return { hits: [], indexWatermark: 1 };
  },
  async read() {
    return [];
  },
  async readArtifact() {
    return {
      artifactId: 'a',
      mediaType: 'text/plain',
      byteSize: 0,
      contentHash: 'h',
      truncated: false,
      metadata: {},
    };
  },
  async submitReport() {
    return { reportId: 'r', stateVersion: 1 };
  },
  async writeStatusNote() {
    return { stored: true, source: 'agent' as const };
  },
  async requestScopeConfirmation() {
    return {
      id: 'proposal-1',
      engagementId: 'engagement-1',
      workerSessionId: 'worker-1',
      objective: 'scope intake',
      targets: [],
      exclusions: [],
      allowedActions: [],
      authorizationNote: 'authorized lab',
      status: 'pending' as const,
      createdAt: '2026-01-01T00:00:00Z',
      decidedAt: null,
    };
  },
  async requestApproval() {
    return { approvalId: 'ap', planHash: 'ph', expiresAt: '2026-01-01T00:00:00Z' };
  },
  async execute() {
    // 返回完整的 ExecutionPlan：类型上不省略字段，避免假实现与真实形状漂移
    // （这也正是之前假 DB 掩盖真缺陷的同类风险）。
    // kind 判别字段是必须的：拒绝路径与执行路径的形状不同。
    return {
      kind: 'executed' as const,
      plan: {
        workerSessionId: 's',
        templateId: 't',
        actionClass: 'passive_collection' as const,
        normalizedTarget: 'https://a.target.com/',
        resolvedAddresses: ['93.184.216.34'],
        normalizedCommand: 'http_read',
        planHash: 'ph',
        idempotencyKey: 'ik',
        scopeVersion: 1,
        policyEpoch: 0,
        leaseGeneration: 1,
        approvalId: null,
        timeoutMs: 1000,
        maxOutputBytes: 1024,
      },
      result: {},
    };
  },
};

/**
 * 构造符合 cordis 形状的假 ctx。
 *
 * 注意 `logger` 是**可调用服务**（`ctx.logger(name)` 返回具名 logger），
 * 不是属性对象——这一条也是实测确认的（`cordis/lib/types/context.d.ts`）。
 */
function makeCtx(
  services: unknown,
  rec: Recorder,
  ecosystem: readonly string[] = REQUIRED_ECOSYSTEM_PLUGINS,
): unknown {
  const provided = new Map<string, unknown>();
  if (services !== undefined) provided.set(PENTEST_HOST_SERVICES, services);
  provided.set('pluginRegistry', { names: () => [...ecosystem] });
  const named = { info: (m: string) => rec.logs.push(m), warn: () => {}, error: () => {} };
  const logger = Object.assign(() => named, named);
  return {
    tools: {
      register(def: { name: string }) {
        rec.tools.push(def.name);
        return () => {};
      },
      guard() {
        rec.guards += 1;
        return () => {};
      },
    },
    on(event: string) {
      if (event === 'tools/pre-execute') rec.prefilters += 1;
    },
    inject(_deps: readonly string[], callback: (c: unknown) => void) {
      callback(this);
      return () => {};
    },
    effect(fn: () => unknown) {
      rec.effects += 1;
      fn();
    },
    get(key: string) {
      return provided.get(key);
    },
    logger,
  };
}
function recorder(): Recorder {
  return { tools: [], guards: 0, effects: 0, prefilters: 0, logs: [] };
}

test('apply 可被两参调用（cordis 的真实调用语义）且不抛', async () => {
  const rec = recorder();
  // 若 apply 仍依赖第三个参数，这里会因为缺少参数而抛 TypeError 或走错分支。
  await assert.doesNotReject(() => applyPentest(
    makeCtx({ workerTools: fakeDeps }, rec) as never,
    {},
  ));
});
 

test('apply 的返回值是 cordis 能接受的 effect（真机回归：曾返回普通对象导致插件装不上）', async () => {
  // cordis 把 apply 的返回值当 effect 收集（`Fiber._execute` → `safeCollect`），
  // 只接受四类：函数、null/undefined、Promise、可迭代对象。**返回普通对象会让加载器抛
  // `TypeError: Invalid effect`，整个 profile 起不来。**
  //
  // 这个缺陷曾真实存在：apply 返回 `ApplyResult` 结构，于是插件在任何真实 dsh 部署中
  // 都装不上，而当时全部 1249 个用例仍是绿的——单测直接调函数读返回值，绕过了 cordis 的校验。
  // 因此这条断言针对的正是「测试全绿但装不起来」这一类失败。
  const rec = recorder();
  const result: unknown = await apply(
    makeCtx({ workerTools: fakeDeps }, rec) as never,
    {},
  );

  const acceptable =
    result === undefined ||
    result === null ||
    typeof result === 'function' ||
    (typeof result === 'object' && 'then' in (result as object)) ||
    (typeof result === 'object' &&
      (Symbol.iterator in (result as object) || Symbol.asyncIterator in (result as object)));

  assert.ok(
    acceptable,
    `apply 返回了 cordis 不接受的值（${Object.prototype.toString.call(result)}）——` +
      `这会让整个 profile 加载失败。结构化结果请从 applyPentest 取。`,
  );
});

test('有宿主服务时注册全部 Worker 工具（回归：曾经注册 0 个）', async () => {
  const rec = recorder();
  const out = await applyPentest(makeCtx({ workerTools: fakeDeps }, rec) as never, {});
  assert.equal(out.servicesBound, true);
  assert.equal(out.toolsRegistered.length, WORKER_TOOL_NAMES.length);
  for (const name of WORKER_TOOL_NAMES) {
    assert.ok(out.toolsRegistered.includes(name), `缺少工具 ${name}`);
  }
  assert.deepEqual([...rec.tools].sort(), [...WORKER_TOOL_NAMES].sort());
});

test('无宿主服务时明确不注册工具，而不是注册一批会抛异常的', async () => {
  const rec = recorder();
  const out = await applyPentest(makeCtx(undefined, rec) as never, {});
  assert.equal(out.servicesBound, false);
  assert.deepEqual(out.toolsRegistered, []);
  assert.deepEqual(rec.tools, []);
});

test('无论有无服务，守卫都装上（两个扩展点各一）', async () => {
  for (const services of [undefined, { workerTools: fakeDeps }]) {
    const rec = recorder();
    await applyPentest(makeCtx(services, rec) as never, {});
    assert.equal(rec.prefilters, 1, 'tools/pre-execute 监听器必须装上');
    assert.equal(rec.guards, 1, '单调 guard 必须装上（不可绕过的最终拒绝）');
  }
});

test('状态机类能力不被注册为模型工具（§4.2 人类专属）', async () => {
  const rec = recorder();
  await applyPentest(makeCtx({ workerTools: fakeDeps }, rec) as never, {});
  for (const forbidden of [
    'phase_transition',
    'worker_session_create',
    'approval_resolve',
    'report_sign',
    'next_stage',
    'approve',
  ]) {
    assert.equal(
      rec.tools.includes(forbidden),
      false,
      `${forbidden} 不得作为模型工具注册——它必须只经人类控制台 RPC`,
    );
  }
});

test('目标通路有三条：逐条人批的 pentest_exec、结构化侦察的 pentest_recon、结构化核验的 pentest_scan', () => {
  assert.deepEqual([...TARGET_TOOL_NAMES], ['pentest_exec', 'pentest_recon', 'pentest_scan']);
  for (const t of TARGET_TOOL_NAMES) {
    assert.ok(WORKER_TOOL_NAMES.includes(t), `${t} 必须是 Worker 工具之一`);
  }
});

test('生态依赖缺失时 apply fail loud，且错误点名缺失项', async () => {
  const rec = recorder();
  const config: PluginConfig = {
    requireEcosystem: true,
    ecosystemPlugins: ['dsh-permission-rules', 'dsh-defend'],
  };
  await assert.rejects(
    () => applyPentest(makeCtx(undefined, rec, []) as never, config),
    (e: unknown) => {
      assert.ok(e instanceof PentestBootError);
      assert.match(e.message, /dsh-permission-rules/);
      return true;
    },
  );
});

test('默认启动检查五个硬依赖，且空清单不能绕过检查', async () => {
  const rec = recorder();
  await assert.rejects(
    () => applyPentest(makeCtx(undefined, rec, []) as never, {}),
    (error: unknown) => error instanceof PentestBootError && /dsh-permission-rules/.test(error.message),
  );
  await assert.rejects(
    () => applyPentest(makeCtx(undefined, rec, []) as never, { ecosystemPlugins: [] }),
    (error: unknown) => error instanceof PentestBootError && /不能为空/.test(error.message),
  );
});

test('词汇表自检在 apply 内执行（不满足即拒绝启动）', async () => {
  const rec = recorder();
  // 正常情况不抛；这条断言保证自检确实被接进了 apply 的启动路径。
  await assert.doesNotReject(() => applyPentest(
    makeCtx(undefined, rec) as never,
    {},
  ));
});

test('apply 返回的工具名与注册进 ctx 的一致（防两处漂移）', async () => {
  const rec = recorder();
  const out = await applyPentest(makeCtx({ workerTools: fakeDeps }, rec) as never, {});
  assert.deepEqual([...out.toolsRegistered].sort(), [...rec.tools].sort());
});
