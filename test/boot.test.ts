/**
 * 插件入口与启动自检的测试。
 *
 * 这些测试锁定设计文档 §8.2 与 §4.4 的两条红线：
 *   1. 不得依赖宿主未注册的会话事件类型
 *   2. 生态依赖缺失时拒绝启动，不静默降级
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { KNOWN_SESSION_EVENT_TYPES } from '@deepseek-ai/dsh-session';
import {
  assertSessionVocabularyClean,
  assertEcosystem,
  PentestBootError,
} from '../src/index.ts';
import { DOMAIN_EVENT_TYPES, TRANSITION_TYPES, LIVE_SESSION_STATUSES, SESSION_STATUSES } from '../src/contracts.ts';

test('启动自检通过：本插件使用的会话事件类型全部已被宿主注册', () => {
  // 不应抛错
  assert.doesNotThrow(() => assertSessionVocabularyClean());
});

test('领域事件与宿主会话事件命名空间不冲突', () => {
  const collided = DOMAIN_EVENT_TYPES.filter((t) => KNOWN_SESSION_EVENT_TYPES.has(t));
  assert.deepEqual(collided, [], `领域事件不得与宿主会话事件同名：${collided.join(', ')}`);
});

test('宿主事件词汇表是 fail-closed 的固定集合（这是本设计的核心前提）', () => {
  // 若此断言失败，说明 dsh 改为开放注册，可重新考虑把领域事件写进会话日志。
  assert.ok(KNOWN_SESSION_EVENT_TYPES.size > 0, '宿主应暴露非空的事件词汇表');
  assert.equal(
    KNOWN_SESSION_EVENT_TYPES.has('pentest/anything'),
    false,
    '宿主不应认识本插件的事件名——这正是领域事件必须只进数据库的原因',
  );
});

test('生态依赖缺失时拒绝启动，且错误信息点名缺失项', () => {
  assert.throws(
    () => assertEcosystem(['dsh-permission-rules'], ['dsh-permission-rules', 'dsh-defend']),
    (e: unknown) => {
      assert.ok(e instanceof PentestBootError);
      assert.match(e.message, /dsh-defend/);
      return true;
    },
  );
});

test('生态依赖齐备时通过自检', () => {
  assert.doesNotThrow(() =>
    assertEcosystem(['dsh-permission-rules', 'dsh-defend'], ['dsh-permission-rules', 'dsh-defend']),
  );
});

test('真实 Cordis runtime identity 可映射到生态包名', () => {
  assert.doesNotThrow(() =>
    assertEcosystem(['permission-rules', 'dsh-defend', 'mask', 'observe', 'dsh-budget']),
  );
});

test('存活会话状态集合必须是会话状态集合的真子集，且不含终态', () => {
  const all: readonly string[] = SESSION_STATUSES;
  const live: readonly string[] = LIVE_SESSION_STATUSES;
  for (const s of live) {
    assert.ok(all.includes(s), `存活状态 ${s} 必须是合法的会话状态`);
  }
  for (const terminal of ['closed', 'superseded', 'failed']) {
    assert.equal(live.includes(terminal), false, `终态 ${terminal} 不得出现在存活状态集合中`);
  }
  // 逐一列出：任何一个存活态被漏掉都会让"一个 engagement 只有一个存活会话"失效
  for (const expected of ['starting', 'active', 'waiting_human', 'handoff_drafting', 'transition_confirmation', 'paused', 'blocked']) {
    assert.ok(live.includes(expected), `存活状态集合必须包含 ${expected}`);
  }
});

test('转移类型集合包含全部四条人工边所需的取值', () => {
  const types: readonly string[] = TRANSITION_TYPES;
  for (const t of ['interject_wake', 'handoff_cancel', 'handoff_regen', 'report_reopen']) {
    assert.ok(types.includes(t), `转移类型必须包含 ${t}（§5.4 四条人工边必须可记账）`);
  }
});
