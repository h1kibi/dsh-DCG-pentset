/**
 * 公共记忆与简化向导的回归锁。
 *
 * 两件事都是**用户直接提的诉求**，因此必须钉住——否则下一次重构很容易把它们悄悄退回去：
 *
 *   1. **新建 engagement 只该问两件事**（名称 + 目标）。此前七项全必填，其中五项
 *      （`roe`、`timeWindow`、`exclusions`、`authorizationRef`、`authorizationExpiresAt`）
 *      要么**零读取方**、要么服务端本来就有安全默认值。让「自己给自己开个作业」每次都要
 *      编授权引用、算时间窗，是纯粹的摩擦。
 *   2. **公共记忆是作业级的**：人类写一次，本作业下**每一次**新建会话都会读到。
 *      它与「记忆浏览器」方向相反（那是 Agent 产出的事实、只追加、可检索），
 *      因此不做追加、不进检索——唯一当前版本才能保证「注入什么」可预期。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { describeConsoleMethods, lookupConsoleMethod } from '../src/console/rpc.ts';
import { PUBLIC_MEMORY_MAX_CHARS } from '../src/contracts.ts';
import { publicMemoryBlockers } from '../src/client/views/PublicMemoryPanel.tsx';

// ─────────────────── 简化的契约面 ───────────────────

test('createEngagement 的必填项：名称、目标与**行为预设**（预设是必选项，没有默认值）', () => {
  const spec = lookupConsoleMethod('createEngagement');
  assert.ok(spec !== null);
  const required = spec.fields.filter((f) => f.required).map((f) => f.name).sort();
  assert.deepEqual(
    required,
    ['approvalMode', 'behaviorProfile', 'name', 'targets'],
    '必填项错位会让新作业的创建路径重新变长；这三项都有真实的读取方（预设决定注入提示词与节奏）',
  );

  // 可选项仍要**声明**（未声明的键一律被拒），只是不要求填。
  const optional = spec.fields.filter((f) => !f.required).map((f) => f.name).sort();
  assert.deepEqual(optional, [
    'authorizationExpiresAt',
    'authorizationRef',
    'customGuidance',
    'exclusions',
    'policyOverrides',
    'publicMemory',
    'roe',
    'scopeEntryProfile',
    'timeWindow',
  ]);
});

test('公共记忆的两个端点在方法表里，且写操作要求理由', () => {
  const read = lookupConsoleMethod('getEngagementMemory');
  assert.ok(read !== null, '读端点缺失会让面板拉不到数据');
  assert.equal(read.kind, 'read');
  assert.equal(read.reason, false, '读不需要理由');

  const write = lookupConsoleMethod('updateEngagementMemory');
  assert.ok(write !== null);
  assert.equal(write.kind, 'mutation');
  // 写它改变的是整个作业的行为边界（注入每一次会话），与切换阶段同级，
  // 因此必须留决策记录——而决策记录要求理由。
  assert.equal(write.reason, true, '改公共记忆必须写理由');
  assert.equal(write.operator, true, '身份由控制器注入，不接受调用方传');
});

test('端点数与文档口径一致：方法表里的名字都是唯一且可查的', () => {
  // 不断言具体条数（那种断言零保护价值，却要求每次加端点回来改数字）。
  // 断言的是**每个名字都能查回同一份规格**——防的是表与查找函数漂移。
  for (const desc of describeConsoleMethods()) {
    const spec = lookupConsoleMethod(desc.name);
    assert.ok(spec !== null, `${desc.name} 在方法表里却查不到`);
    assert.equal(spec.kind, desc.kind);
    assert.equal(spec.fields.length, desc.fields.length);
  }
});

// ─────────────────── 公共记忆的闸门 ───────────────────

test('公共记忆：没改内容就不要求理由（没改就没得记）', () => {
  const gates = publicMemoryBlockers({ selected: true, content: 'x', reason: '', dirty: false });
  assert.deepEqual(gates, [], '内容没变却要求理由，是纯摩擦');
});

test('公共记忆：改了就必须要理由', () => {
  const gates = publicMemoryBlockers({ selected: true, content: 'x', reason: '  ', dirty: true });
  assert.equal(gates.length, 1);
  assert.match(gates[0]!, /改动必须写理由/);
});

test('客户端上限与服务端同源（单一声明，漂移在结构上不可能）', () => {
  // 此前两侧各写一份字面量，这条测试只能断言「等于 8000」；服务端改 12000 → 客户端
  // 仍在 8000 拦（过度拦截），客户端改 20000 → 放行 8001–20000（注释声称的「提前拦」失效）。
  // 现在两侧都 import `contracts.ts` 的同一个常量（第八轮改动），因此这里只钉住「取值本身」
  // ——它变了就是合同变了，必须是有意为之。
  assert.equal(PUBLIC_MEMORY_MAX_CHARS, 8000, '公共记忆上限是契约值：改动需同步设计文档与两侧文案');
});

test('公共记忆：超长在客户端就拦下（不等服务端拒了才知道）', () => {
  const ok = publicMemoryBlockers({
    selected: true,
    content: 'x'.repeat(PUBLIC_MEMORY_MAX_CHARS),
    reason: 'r',
    dirty: true,
  });
  assert.deepEqual(ok, [], '正好等于上限应当通过');

  const tooLong = publicMemoryBlockers({
    selected: true,
    content: 'x'.repeat(PUBLIC_MEMORY_MAX_CHARS + 1),
    reason: 'r',
    dirty: true,
  });
  assert.equal(tooLong.length, 1);
  assert.match(tooLong[0]!, /超出上限/);
});

test('公共记忆：未选中作业时说明原因（而不是静默禁用）', () => {
  const gates = publicMemoryBlockers({ selected: false, content: '', reason: '', dirty: false });
  assert.equal(gates.length, 1);
  assert.match(gates[0]!, /尚未选中作业/);
});
