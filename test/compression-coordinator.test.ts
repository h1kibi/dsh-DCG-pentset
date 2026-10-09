/**
 * 压缩协调器集成测试：验证 60% 阈值触发与事件流。
 *
 * 测试覆盖：
 * 1. shouldCompress 的阈值判定逻辑
 * 2. CompressionCoordinator 的完整流程
 * 3. 依赖服务的调用顺序与参数传递
 *
 * 注：实际的会话事件折叠需要 dsh-session 运行时支持，
 * 此测试采用模拟实现验证逻辑正确性。
 */

import { test } from 'node:test';
import * as assert from 'node:assert';
import {
  shouldCompress,
  CompressionCoordinator,
  type CompressionCoordinatorDeps,
  type ContextUsageEstimate,
  type CompressionTrigger,
} from '../src/workflow/compression-coordinator.ts';
import { DEFAULTS } from '../src/contracts.ts';

test('shouldCompress: 阈值判定', () => {
  // 测试用例 1：低于阈值，不压缩
  const below: ContextUsageEstimate = {
    currentTokens: 30_000,
    windowSize: 100_000,
    triggerRatio: 0.6,
  };
  assert.strictEqual(shouldCompress(below), false, '30% 应该不触发压缩');

  // 测试用例 2：正好在阈值，触发压缩
  const atThreshold: ContextUsageEstimate = {
    currentTokens: 60_000,
    windowSize: 100_000,
    triggerRatio: 0.6,
  };
  assert.strictEqual(shouldCompress(atThreshold), true, '60% 应该触发压缩');

  // 测试用例 3：超过阈值，触发压缩
  const above: ContextUsageEstimate = {
    currentTokens: 70_000,
    windowSize: 100_000,
    triggerRatio: 0.6,
  };
  assert.strictEqual(shouldCompress(above), true, '70% 应该触发压缩');

  // 测试用例 4：使用默认阈值
  const useDefault: ContextUsageEstimate = {
    currentTokens: 60_000,
    windowSize: 100_000,
    triggerRatio: DEFAULTS.compactionTriggerRatio,
  };
  assert.strictEqual(shouldCompress(useDefault), true, '默认 60% 应该触发压缩');

  // 测试用例 5：自定义阈值
  const custom: ContextUsageEstimate = {
    currentTokens: 50_000,
    windowSize: 100_000,
    triggerRatio: 0.5,
  };
  assert.strictEqual(shouldCompress(custom), true, '自定义 50% 应该在 50% 触发');
});

test('CompressionCoordinator: 完整流程', async () => {
  const calls = {
    generateSummary: [] as Array<{ historyContext: string; dshSessionId: string }>,
    recordCompressionEvent: [] as Array<{
      engagementId: string;
      workerSessionId: string;
    }>,
    applyCompressionToSession: [] as Array<{ dshSessionId: string }>,
  };

  const deps: CompressionCoordinatorDeps = {
    async generateSummary(input: { historyContext: string; dshSessionId: string }) {
      calls.generateSummary.push(input);
      return { summary: '压缩摘要内容', model: 'deepseek-v3' };
    },
    async recordCompressionEvent(input: { engagementId: string; workerSessionId: string; result?: unknown }) {
      calls.recordCompressionEvent.push({
        engagementId: input.engagementId,
        workerSessionId: input.workerSessionId,
      });
    },
    async applyCompressionToSession(input: { dshSessionId: string; result?: unknown }) {
      calls.applyCompressionToSession.push({ dshSessionId: input.dshSessionId });
    },
  };

  const coordinator = new CompressionCoordinator(deps);

  // 测试用例 1：触发压缩
  const trigger: CompressionTrigger = {
    dshSessionId: 'session-123',
    workerSessionId: 'worker-456',
    engagementId: 'engage-789',
    currentTurn: 20,
    usage: {
      currentTokens: 65_000,
      windowSize: 100_000,
      triggerRatio: 0.6,
    },
    historyContext: '历史事件文本',
    pinnedTurns: [0, 1, 2],
  };

  const result = await coordinator.trigger(trigger);

  assert.strictEqual(result !== null, true, '应该返回压缩结果');
  assert.strictEqual(result!.model, 'deepseek-v3', '模型应该是 deepseek-v3');
  assert.strictEqual(result!.beforeTokens, 65_000, '压缩前令牌数应该是 65000');
  assert.strictEqual(result!.afterTokens, 26_000, '压缩后令牌数应该是估算值');

  // 验证调用顺序与参数
  assert.strictEqual(calls.generateSummary.length, 1, '应该调用一次生成摘要');
  assert.strictEqual(
    calls.generateSummary[0]!.dshSessionId,
    'session-123',
    '摘要生成应该收到正确的会话 ID',
  );

  assert.strictEqual(calls.recordCompressionEvent.length, 1, '应该记录一次压缩事件');
  assert.strictEqual(
    calls.recordCompressionEvent[0]!.engagementId,
    'engage-789',
    '记录应该包含正确的作业 ID',
  );

  assert.strictEqual(calls.applyCompressionToSession.length, 1, '应该应用一次压缩到会话');
  assert.strictEqual(
    calls.applyCompressionToSession[0]!.dshSessionId,
    'session-123',
    '应用应该针对正确的会话',
  );
});

test('CompressionCoordinator: 低于阈值不压缩', async () => {
  const calls = {
    generateSummary: 0,
    recordCompressionEvent: 0,
    applyCompressionToSession: 0,
  };

  const deps: CompressionCoordinatorDeps = {
    async generateSummary() {
      calls.generateSummary++;
      return { summary: '', model: 'deepseek-v3' };
    },
    async recordCompressionEvent() {
      calls.recordCompressionEvent++;
    },
    async applyCompressionToSession() {
      calls.applyCompressionToSession++;
    },
  };

  const coordinator = new CompressionCoordinator(deps);

  const trigger: CompressionTrigger = {
    dshSessionId: 'session-123',
    workerSessionId: 'worker-456',
    engagementId: 'engage-789',
    currentTurn: 20,
    usage: {
      currentTokens: 30_000, // 30% < 60%
      windowSize: 100_000,
      triggerRatio: 0.6,
    },
    historyContext: '历史事件文本',
    pinnedTurns: [0, 1, 2],
  };

  const result = await coordinator.trigger(trigger);

  assert.strictEqual(result, null, '低于阈值应该返回 null');
  assert.strictEqual(calls.generateSummary, 0, '不应该调用生成摘要');
  assert.strictEqual(calls.recordCompressionEvent, 0, '不应该记录事件');
  assert.strictEqual(calls.applyCompressionToSession, 0, '不应该应用到会话');
});

test('CompressionCoordinator: 错误处理', async () => {
  const testError = new Error('模型调用失败');

  const deps: CompressionCoordinatorDeps = {
    async generateSummary() {
      throw testError;
    },
    async recordCompressionEvent() {
      // 不应该被调用
      throw new Error('不应该记录');
    },
    async applyCompressionToSession() {
      // 不应该被调用
      throw new Error('不应该应用');
    },
  };

  const coordinator = new CompressionCoordinator(deps);

  const trigger: CompressionTrigger = {
    dshSessionId: 'session-123',
    workerSessionId: 'worker-456',
    engagementId: 'engage-789',
    currentTurn: 20,
    usage: {
      currentTokens: 65_000,
      windowSize: 100_000,
      triggerRatio: 0.6,
    },
    historyContext: '历史事件文本',
    pinnedTurns: [0, 1, 2],
  };

  try {
    await coordinator.trigger(trigger);
    assert.fail('应该抛出错误');
  } catch (error) {
    assert.strictEqual(error, testError, '应该抛出原始错误');
  }
});
