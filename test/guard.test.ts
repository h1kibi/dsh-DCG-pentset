/**
 * 守卫语义回归测试。
 *
 * **这个文件存在的理由**：上一版守卫要求 target 工具的参数携带
 * `__execution_token`，而 dsh 官方契约明确参数是 **deep-frozen** 的
 * （`dsh-tools/lib/types/index.d.ts:256`：「Parsed arguments cross one
 * lossless-JSON materialization boundary before policy and are deep-frozen」），
 * 没有任何东西能把令牌写进冻结参数。实测后果：`pentest_exec` 被**无条件拒绝**，
 * 放行队列只进不出。
 *
 * 同一版还采用「未登记即拒绝」，实测把宿主整张工具面（bash/read/grep…）一并拒掉。
 *
 * 下列测试锁定修正后的语义，防止这两种行为回归。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ToolRegistry, evaluateGuard, isBypassChannel, DEFAULT_BYPASS_CHANNELS } from '../src/tools/guard.ts';
import type { GuardPolicy } from '../src/tools/guard.ts';
import { WORKER_TOOL_NAMES, TARGET_TOOL_NAMES } from '../src/tools/worker.ts';

function registry(): ToolRegistry {
  const reg = new ToolRegistry();
  for (const name of WORKER_TOOL_NAMES) {
    const kind: 'target' | 'non-target' = (TARGET_TOOL_NAMES as readonly string[]).includes(name)
      ? 'target'
      : 'non-target';
    reg.register({ name, kind });
  }
  return reg;
}

function decide(name: string, policy: GuardPolicy = {}) {
  return evaluateGuard({ name, arguments: {} }, registry(), policy);
}

// ───────────────── 修正一：本插件工具必须放行 ─────────────────

test('本插件的全部工具都放行，含唯一的 target 工具 pentest_exec', () => {
  for (const name of WORKER_TOOL_NAMES) {
    const decision = decide(name);
    assert.equal(decision.kind, 'allow', `${name} 应放行，实际 ${decision.kind}`);
  }
});

test('回归：pentest_exec 不再因为没有令牌而被无条件拒绝', () => {
  // 上一版在这里返回 deny/scope_violation（令牌无生产者）。
  // 现在准入判定在 ExecutionService 内，守卫不重复承担。
  const decision = decide('pentest_exec');
  assert.equal(decision.kind, 'allow');
});

// ───────────────── 修正二：宿主其他工具不得被误杀 ─────────────────

test('回归：宿主普通工具一律放行（上一版把它们全部拒掉）', () => {
  for (const name of ['todo', 'read', 'grep', 'glob', 'ask', 'web_search', 'memory_search']) {
    const decision = decide(name);
    assert.equal(
      decision.kind,
      'allow',
      `${name} 是本设计无关的宿主工具，不得拒绝（实际 ${decision.kind}）`,
    );
  }
});

// ───────────────── 守卫的正当职责：拦绕过通道 ─────────────────

test('绕过 pentest_exec 的能力型工具被拒绝', () => {
  for (const name of ['bash', 'pwsh', 'run_code', 'write', 'edit', 'web_fetch', 'subagent']) {
    const decision = decide(name);
    assert.equal(decision.kind, 'deny', `${name} 能绕过范围校验，应拒绝`);
    if (decision.kind !== 'deny') return;
    assert.equal(decision.code, 'scope_violation');
  }
});

test('工具名归一化：大小写与常见前缀都不放过', () => {
  for (const name of ['Bash', 'BASH', 'tool-bash', 'tool_bash']) {
    assert.equal(decide(name).kind, 'deny', `${name} 应被归一化后命中`);
  }
});

test('归一化不误伤：含普通词的名字不会被判成危险能力', () => {
  // memory_search / artifact_read 里都含普通词，不得被当成 shell 类命中
  assert.equal(decide('memory_search').kind, 'allow');
  assert.equal(decide('artifact_read').kind, 'allow');
  assert.equal(decide('report_reader').kind, 'allow');
});

test('策略可显式授权某个绕过通道（该能力确有必要时由人类同意）', () => {
  assert.equal(decide('bash', { allowedBypassChannels: ['bash'] }).kind, 'allow');
  assert.equal(decide('pwsh', { allowedBypassChannels: ['bash'] }).kind, 'deny');
});

test('策略可替换绕过通道清单', () => {
  assert.equal(decide('my-scanner', { bypassChannels: ['my-scanner'] }).kind, 'deny');
  assert.equal(decide('bash', { bypassChannels: [] }).kind, 'allow', '空清单即不拦任何东西');
});

test('绕过通道清单是显式常量，可被审计', () => {
  assert.ok(DEFAULT_BYPASS_CHANNELS.length > 0);
  assert.ok(isBypassChannel('bash', DEFAULT_BYPASS_CHANNELS));
  assert.equal(isBypassChannel('todo', DEFAULT_BYPASS_CHANNELS), false);
});

// ───────────────── PTC 嵌套调用同样受检 ─────────────────

test('PTC 嵌套子调用（带 parent）与顶层调用同样判定', () => {
  // 塞进 run_code 里的绕过动作不得因此逃过检查。
  const direct = evaluateGuard({ name: 'bash', arguments: {} }, registry());
  const nested = evaluateGuard(
    { name: 'bash', arguments: {}, parent: Symbol('parent-token') },
    registry(),
  );
  assert.equal(direct.kind, 'deny');
  assert.equal(nested.kind, 'deny', '嵌套调用必须同样被拒');
});
