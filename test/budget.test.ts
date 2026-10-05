/**
 * 预算与进度活性测试（设计文档 §10.5）。
 *
 * 纯逻辑，不连数据库：token 计量来源用假 `DshBudgetPort` 替代，
 * 时钟用显式时间戳，因此每条规则都能精确卡在阈值上验证。
 *
 * 覆盖重点：
 *   - 软阈值只告警、硬阈值只暂停（动作取值域里没有终止成员）；
 *   - 追加预算产生新修订并带审计信息，终态拒绝追加；
 *   - 步数与挂钟时长自建计量，token 直接取 dsh-budget 官方聚合值；
 *   - 终态（closed / superseded / failed）不再消耗预算、不再取数；
 *   - 四种健康信号各自触发，检查点连续错过两次判停滞；
 *   - **停滞不等于自动终止**（会话继续运行，且监视器接口上没有终止动作）。
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { DEFAULTS, LIVE_SESSION_STATUSES, SESSION_STATUSES } from '../src/contracts.ts';
import type { BudgetExtension, BudgetLimits, SessionStatus } from '../src/contracts.ts';
import {
  BUDGET_ACTIONS,
  BUDGET_TERMINAL_STATUSES,
  BUDGET_VERDICTS,
  BudgetMeter,
  BudgetProtocolError,
  DEFAULT_CONTEXT_PRESSURE_SECONDS,
  HEALTH_SIGNAL_KINDS,
  HUMAN_BUDGET_OPTIONS,
  LIVENESS_ACTIONS,
  LivenessMonitor,
  isBudgetTerminalStatus,
  projectionOf,
} from '../src/workflow/budget.ts';
import type { DshBudgetPort, DshBudgetUsage } from '../src/workflow/budget.ts';

// ───────────────────────────── 测试替身 ─────────────────────────────

const START = new Date('2026-01-01T00:00:00.000Z');

/** START 之后第 n 秒；测试里的所有时刻都由它派生，保持确定性。 */
function at(seconds: number): Date {
  return new Date(START.getTime() + seconds * 1000);
}

/** 假 dsh-budget：聚合值由测试直接设定，并记录被取数的次数与会话 id。 */
class FakeDshBudget implements DshBudgetPort {
  #inputTokens = 0;
  #outputTokens = 0;
  #sessionSeq = 0;
  reads = 0;
  readonly sessionIds: string[] = [];

  setUsage(inputTokens: number, outputTokens: number, sessionSeq: number): void {
    this.#inputTokens = inputTokens;
    this.#outputTokens = outputTokens;
    this.#sessionSeq = sessionSeq;
  }

  readUsage(dshSessionId: string): DshBudgetUsage {
    this.reads += 1;
    this.sessionIds.push(dshSessionId);
    return {
      source: 'dsh-budget',
      inputTokens: this.#inputTokens,
      outputTokens: this.#outputTokens,
      totalTokens: this.#inputTokens + this.#outputTokens,
      sessionSeq: this.#sessionSeq,
    };
  }
}

const LIMITS: BudgetLimits = { maxTokens: 1000, maxSteps: 10, maxSeconds: 100 };

function makeMeter(
  port: FakeDshBudget,
  limits: BudgetLimits = LIMITS,
  status?: SessionStatus,
): BudgetMeter {
  return new BudgetMeter({
    dshBudget: port,
    dshSessionId: 'dsh-1',
    limits,
    startedAt: START,
    status,
  });
}

function extension(overrides: Partial<BudgetExtension> = {}): BudgetExtension {
  return {
    workerSessionId: '11111111-1111-4111-8111-111111111111',
    operatorId: 'op-1',
    reason: '测试追加',
    expectedStateVersion: 3,
    ...overrides,
  };
}

// ───────────────────────────── 预算：冻结与修订 ─────────────────────────────

describe('预算计量与闸门（§10.5）', () => {
  it('创建时冻结预算，首版修订记为 initial', () => {
    const meter = makeMeter(new FakeDshBudget());
    assert.equal(meter.revision, 1);
    assert.deepEqual(meter.limits, LIMITS);
    assert.deepEqual(meter.revisions.map((r) => r.revision), [1]);
    assert.equal(meter.revisions[0]?.reason, 'initial');
    assert.equal(meter.revisions[0]?.additional, null);
    assert.equal(meter.revisions[0]?.operatorId, null);
    assert.equal(meter.consuming, true);
  });

  it('软阈值：达到上限的 80% 只告警，会话继续运行', () => {
    const port = new FakeDshBudget();
    port.setUsage(800, 0, 7);
    const reading = makeMeter(port).evaluate(at(0));

    assert.equal(reading.tokens.ratio, 0.8);
    assert.equal(reading.tokens.verdict, 'warning');
    assert.equal(reading.verdict, 'warning');
    assert.equal(reading.action, 'continue');
    assert.equal(reading.pauseRequest, null);
    assert.deepEqual(
      reading.warnings.map((w) => w.dimension),
      ['tokens'],
    );
    assert.match(reading.warnings[0]?.message ?? '', /80%/);
  });

  it('软阈值以下（79.9%）判 ok，不写告警', () => {
    const port = new FakeDshBudget();
    port.setUsage(799, 0, 1);
    const reading = makeMeter(port).evaluate(at(0));

    assert.equal(reading.tokens.verdict, 'ok');
    assert.equal(reading.verdict, 'ok');
    assert.deepEqual(reading.warnings, []);
    assert.equal(reading.action, 'continue');
  });

  it('软阈值比率可配置（默认取 DEFAULTS.budgetSoftThresholdRatio）', () => {
    assert.equal(DEFAULTS.budgetSoftThresholdRatio, 0.8);
    const port = new FakeDshBudget();
    port.setUsage(500, 0, 1);
    const meter = new BudgetMeter({
      dshBudget: port,
      dshSessionId: 'dsh-1',
      limits: LIMITS,
      startedAt: START,
      softThresholdRatio: 0.5,
    });

    assert.equal(meter.evaluate(at(0)).tokens.verdict, 'warning');
  });

  it('硬阈值：达到上限返回暂停而不是终止，并给出人类的三个选择', () => {
    const port = new FakeDshBudget();
    port.setUsage(1000, 0, 2);
    const reading = makeMeter(port).evaluate(at(0));

    assert.equal(reading.tokens.verdict, 'exhausted');
    assert.equal(reading.verdict, 'exhausted');
    assert.equal(reading.action, 'pause');
    assert.equal(reading.pauseRequest?.action, 'pause');
    assert.equal(reading.pauseRequest?.reason, 'budget_exhausted');
    assert.deepEqual(reading.pauseRequest?.dimensions, ['tokens']);
    assert.deepEqual(reading.pauseRequest?.humanOptions, ['extend_budget', 'retry', 'transition']);
    assert.equal(reading.pauseRequest?.humanOptions, HUMAN_BUDGET_OPTIONS);
    assert.match(reading.pauseRequest?.message ?? '', /暂停等待人工判断/);
  });

  it('动作取值域里没有终止：预算耗尽只能继续或暂停', () => {
    assert.deepEqual(BUDGET_ACTIONS, ['continue', 'pause']);
    assert.deepEqual(BUDGET_VERDICTS, ['ok', 'warning', 'exhausted']);
    assert.equal((BUDGET_ACTIONS as readonly string[]).includes('terminate'), false);
    assert.equal((BUDGET_ACTIONS as readonly string[]).includes('abort'), false);

    const port = new FakeDshBudget();
    port.setUsage(10_000, 0, 1);
    const reading = makeMeter(port).evaluate(at(0));
    assert.equal('terminate' in reading, false);
    assert.equal('terminated' in reading, false);
  });

  it('无额度上限（limit 为 0）视为触顶，仍只要求暂停', () => {
    const port = new FakeDshBudget();
    port.setUsage(0, 0, 1);
    const reading = makeMeter(port, { maxTokens: 0, maxSteps: 0, maxSeconds: 0 }).evaluate(at(0));

    assert.equal(reading.tokens.ratio, 1);
    assert.equal(reading.verdict, 'exhausted');
    assert.equal(reading.action, 'pause');
    assert.deepEqual(reading.pauseRequest?.dimensions, ['tokens', 'steps', 'seconds']);
  });

  it('多个维度同时触顶时按固定顺序列出', () => {
    const port = new FakeDshBudget();
    port.setUsage(1000, 0, 1);
    const meter = makeMeter(port);
    for (let i = 0; i < 10; i += 1) meter.noteStep();
    const reading = meter.evaluate(at(100));

    assert.deepEqual(reading.pauseRequest?.dimensions, ['tokens', 'steps', 'seconds']);
  });
});

// ───────────────────────────── 预算：token 来源 ─────────────────────────────

describe('token 计量直接取自 dsh-budget（§10.5 计数来源）', () => {
  it('token 读数是官方聚合值，并带来源标记与日志水位', () => {
    const port = new FakeDshBudget();
    port.setUsage(700, 50, 42);
    const reading = makeMeter(port).evaluate(at(0));

    assert.equal(reading.tokens.used, 750);
    assert.equal(reading.tokens.limit, 1000);
    assert.equal(reading.tokens.remaining, 250);
    assert.equal(reading.tokens.metered, true);
    assert.equal(reading.tokenSource, 'dsh-budget');
    assert.equal(reading.tokenSeq, 42);
    assert.deepEqual(port.sessionIds, ['dsh-1']);
  });

  it('token 不是累计器：官方值下调，读数跟着下调', () => {
    const port = new FakeDshBudget();
    const meter = makeMeter(port);

    port.setUsage(700, 0, 1);
    assert.equal(meter.evaluate(at(0)).tokens.used, 700);

    port.setUsage(300, 0, 2);
    assert.equal(meter.evaluate(at(1)).tokens.used, 300);
  });

  it('接口层面不存在自建 token 计数器（表面锁）', () => {
    const meter = makeMeter(new FakeDshBudget());
    for (const name of ['noteTokens', 'addTokens', 'recordTokens', 'setTokens', 'incrementTokens', 'noteUsage']) {
      assert.equal(name in meter, false, `BudgetMeter 不应提供 ${name}：token 只能来自 dsh-budget`);
    }
    const prototypeNames = Object.getOwnPropertyNames(BudgetMeter.prototype);
    assert.deepEqual(
      prototypeNames.filter((name) => /token/i.test(name)),
      [],
      '原型上不应存在任何 token 写入入口',
    );
  });

  it('投影不一致时产出诊断事件，且以 dsh-budget 为准', () => {
    const port = new FakeDshBudget();
    port.setUsage(700, 0, 9);
    const reading = makeMeter(port).evaluate(at(0), { consumedTokens: 99_999, consumedSteps: 0 });

    assert.equal(reading.tokens.used, 700);
    assert.equal(reading.diagnostics.length, 1);
    assert.equal(reading.diagnostics[0]?.kind, 'projection_mismatch_tokens');
    assert.equal(reading.diagnostics[0]?.projectionValue, 99_999);
    assert.equal(reading.diagnostics[0]?.meteredValue, 700);
    assert.equal(reading.diagnostics[0]?.authoritative, 'dsh-budget');
    assert.match(reading.diagnostics[0]?.message ?? '', /以 dsh-budget 为准/);
  });

  it('步数投影不一致时以步骤事件为准', () => {
    const port = new FakeDshBudget();
    port.setUsage(0, 0, 1);
    const meter = makeMeter(port);
    meter.noteStep();
    meter.noteStep();
    const reading = meter.evaluate(at(0), { consumedTokens: 0, consumedSteps: 8 });

    assert.equal(reading.steps.used, 2);
    assert.equal(reading.diagnostics.length, 1);
    assert.equal(reading.diagnostics[0]?.kind, 'projection_mismatch_steps');
    assert.equal(reading.diagnostics[0]?.authoritative, 'step_events');
  });

  it('投影一致时没有诊断事件', () => {
    const port = new FakeDshBudget();
    port.setUsage(700, 0, 1);
    const meter = makeMeter(port);
    meter.noteStep();
    const reading = meter.evaluate(at(0), { consumedTokens: 700, consumedSteps: 1 });

    assert.deepEqual(reading.diagnostics, []);
  });

  it('projectionOf 写回的值就是计量值，不是另一套计数', () => {
    const port = new FakeDshBudget();
    port.setUsage(700, 0, 1);
    const meter = makeMeter(port);
    meter.noteStep();
    meter.noteStep();
    meter.noteStep();
    const reading = meter.evaluate(at(0), { consumedTokens: 1, consumedSteps: 1 });

    assert.deepEqual(projectionOf(reading), { consumedTokens: 700, consumedSteps: 3 });
  });
});

// ───────────────────────────── 预算：步数与时长 ─────────────────────────────

describe('步数与挂钟时长计量（不属于 token 计量，自建）', () => {
  it('步数来自步骤事件并参与闸门判定', () => {
    const port = new FakeDshBudget();
    const meter = makeMeter(port);
    for (let i = 0; i < 10; i += 1) assert.equal(meter.noteStep(), true);

    const reading = meter.evaluate(at(0));
    assert.equal(meter.steps, 10);
    assert.equal(reading.steps.used, 10);
    assert.equal(reading.steps.verdict, 'exhausted');
    assert.deepEqual(reading.pauseRequest?.dimensions, ['steps']);
  });

  it('步数达到 80% 只告警', () => {
    const port = new FakeDshBudget();
    const meter = makeMeter(port);
    for (let i = 0; i < 8; i += 1) meter.noteStep();

    const reading = meter.evaluate(at(0));
    assert.equal(reading.steps.verdict, 'warning');
    assert.equal(reading.action, 'continue');
    assert.deepEqual(reading.warnings.map((w) => w.dimension), ['steps']);
  });

  it('挂钟时长由会话时间戳推出', () => {
    const port = new FakeDshBudget();
    const meter = makeMeter(port);

    assert.equal(meter.evaluate(at(25)).seconds.used, 25);
    assert.equal(meter.evaluate(at(50)).seconds.ratio, 0.5);
    assert.equal(meter.evaluate(at(80)).seconds.verdict, 'warning');
    assert.equal(meter.evaluate(at(100)).seconds.verdict, 'exhausted');
    assert.equal(meter.evaluate(at(100)).pauseRequest?.reason, 'budget_exhausted');
  });

  it('时长不会因判定时刻早于起点而变负', () => {
    const port = new FakeDshBudget();
    const reading = makeMeter(port).evaluate(at(-30));

    assert.equal(reading.seconds.used, 0);
    assert.equal(reading.seconds.remaining, 100);
  });
});

// ───────────────────────────── 预算：终态 ─────────────────────────────

describe('终止与失败状态不再消耗预算（§10.5）', () => {
  it('终态取值域 = SESSION_STATUSES − LIVE_SESSION_STATUSES', () => {
    const expected = SESSION_STATUSES.filter(
      (status) => !(LIVE_SESSION_STATUSES as readonly SessionStatus[]).includes(status),
    );
    assert.deepEqual(BUDGET_TERMINAL_STATUSES, expected);
    assert.deepEqual(BUDGET_TERMINAL_STATUSES, ['failed', 'closed', 'superseded']);
    assert.equal(isBudgetTerminalStatus('paused'), false);
    assert.equal(isBudgetTerminalStatus('closed'), true);
  });

  it('终态后不再计入步数', () => {
    const port = new FakeDshBudget();
    const meter = makeMeter(port);
    meter.noteStep();
    meter.setStatus('closed', at(10));

    assert.equal(meter.noteStep(), false);
    assert.equal(meter.steps, 1);
    assert.equal(meter.evaluate(at(10)).steps.used, 1);
  });

  it('三种终态都停止消耗预算', () => {
    for (const status of ['closed', 'superseded', 'failed'] as const) {
      const meter = makeMeter(new FakeDshBudget());
      meter.setStatus(status, at(5));
      assert.equal(meter.consuming, false, status);
      assert.equal(meter.noteStep(), false, status);
      assert.equal(meter.evaluate(at(9999)).consuming, false, status);
    }
  });

  it('终态冻结时长：会话结束后时钟不再走', () => {
    const meter = makeMeter(new FakeDshBudget());
    meter.setStatus('failed', at(30));

    const reading = meter.evaluate(at(10_000));
    assert.equal(reading.seconds.used, 30);
    assert.equal(meter.endedAt?.getTime(), at(30).getTime());
    assert.equal(reading.seconds.verdict, 'ok');
  });

  it('终态后不再向 dsh-budget 取数，token 冻结在最后一次官方读数', () => {
    const port = new FakeDshBudget();
    port.setUsage(400, 0, 1);
    const meter = makeMeter(port);
    assert.equal(meter.evaluate(at(5)).tokens.used, 400);
    assert.equal(port.reads, 1);

    meter.setStatus('closed', at(10));
    port.setUsage(900, 0, 2);

    const reading = meter.evaluate(at(10_000));
    assert.equal(reading.tokens.used, 400);
    assert.equal(reading.tokenSeq, 1);
    assert.equal(port.reads, 1, '终态后不应再取数');
  });

  it('暂停中的会话仍属存活态，继续消耗预算', () => {
    const port = new FakeDshBudget();
    const meter = makeMeter(port);
    meter.setStatus('paused', at(10));

    assert.equal(meter.consuming, true);
    assert.equal(meter.noteStep(), true);
    assert.equal(meter.evaluate(at(50)).seconds.used, 50);
  });

  it('终态不可逆：冻结后收到存活态不被改写', () => {
    const meter = makeMeter(new FakeDshBudget());
    meter.setStatus('closed', at(10));
    meter.setStatus('active', at(20));

    assert.equal(meter.consuming, false);
    assert.equal(meter.evaluate(at(60)).seconds.used, 10);
  });

  it('会话创建即处于终态时不消耗预算，token 维度标为未计量', () => {
    const port = new FakeDshBudget();
    port.setUsage(500, 0, 1);
    const meter = makeMeter(port, LIMITS, 'closed');
    const reading = meter.evaluate(at(500));

    assert.equal(reading.consuming, false);
    assert.equal(reading.seconds.used, 0);
    assert.equal(reading.tokens.metered, false);
    assert.equal(reading.tokens.used, 0);
    assert.equal(reading.tokenSource, 'dsh-budget');
    assert.equal(port.reads, 0);
    assert.equal(reading.action, 'continue');
  });
});

// ───────────────────────────── 预算：追加 ─────────────────────────────

describe('追加预算产生新修订（§10.5 不静默放大）', () => {
  it('追加后生成第 2 版修订并记录审计信息', () => {
    const port = new FakeDshBudget();
    port.setUsage(1000, 0, 1);
    const meter = makeMeter(port);
    assert.equal(meter.evaluate(at(0)).verdict, 'exhausted');

    const revision = meter.extend(extension({ additionalTokens: 500 }), at(60));

    assert.equal(revision.revision, 2);
    assert.equal(revision.reason, 'human_extension');
    assert.equal(revision.operatorId, 'op-1');
    assert.equal(revision.note, '测试追加');
    assert.deepEqual(revision.additional, { tokens: 500, steps: 0, seconds: 0 });
    assert.equal(revision.at.getTime(), at(60).getTime());
    assert.deepEqual(revision.limits, { maxTokens: 1500, maxSteps: 10, maxSeconds: 100 });
    assert.equal(meter.revision, 2);
    assert.deepEqual(meter.revisions.map((r) => r.revision), [1, 2]);
    assert.equal(meter.limits.maxTokens, 1500);
  });

  it('追加后闸门按新上限判定，会话恢复运行', () => {
    const port = new FakeDshBudget();
    port.setUsage(1000, 0, 1);
    const meter = makeMeter(port);
    meter.extend(extension({ additionalTokens: 250 }), at(30));

    const reading = meter.evaluate(at(31));
    assert.equal(reading.tokens.limit, 1250);
    assert.equal(reading.tokens.ratio, 0.8);
    assert.equal(reading.tokens.verdict, 'warning');
    assert.equal(reading.verdict, 'warning');
    assert.equal(reading.action, 'continue');
    assert.equal(reading.pauseRequest, null);
    assert.equal(reading.revision, 2);
  });

  it('三个维度可以同时追加', () => {
    const meter = makeMeter(new FakeDshBudget());
    const revision = meter.extend(
      extension({ additionalTokens: 100, additionalSteps: 5, additionalSeconds: 50 }),
      at(10),
    );

    assert.deepEqual(revision.additional, { tokens: 100, steps: 5, seconds: 50 });
    assert.deepEqual(meter.limits, { maxTokens: 1100, maxSteps: 15, maxSeconds: 150 });
  });

  it('修订历史逐次累积（多次追加 = 多版修订）', () => {
    const meter = makeMeter(new FakeDshBudget());
    meter.extend(extension({ additionalTokens: 100 }), at(10));
    meter.extend(extension({ additionalTokens: 200 }), at(20));

    assert.deepEqual(meter.revisions.map((r) => r.revision), [1, 2, 3]);
    assert.equal(meter.limits.maxTokens, 1300);
    assert.equal(meter.revision, 3);
  });

  it('零增量追加被拒绝', () => {
    const meter = makeMeter(new FakeDshBudget());
    assert.throws(() => meter.extend(extension(), at(10)), BudgetProtocolError);
    assert.equal(meter.revision, 1);
  });

  it('负增量追加被拒绝', () => {
    const meter = makeMeter(new FakeDshBudget());
    assert.throws(
      () => meter.extend(extension({ additionalTokens: -1 }), at(10)),
      BudgetProtocolError,
    );
    assert.equal(meter.revision, 1);
  });

  it('终态会话拒绝追加预算', () => {
    const meter = makeMeter(new FakeDshBudget());
    meter.setStatus('closed', at(10));

    assert.throws(
      () => meter.extend(extension({ additionalTokens: 500 }), at(20)),
      BudgetProtocolError,
    );
    assert.equal(meter.revision, 1);
    assert.deepEqual(meter.limits, LIMITS);
  });

  it('软阈值比率越界时构造失败', () => {
    assert.throws(
      () =>
        new BudgetMeter({
          dshBudget: new FakeDshBudget(),
          dshSessionId: 'dsh-1',
          limits: LIMITS,
          startedAt: START,
          softThresholdRatio: 1.5,
        }),
      BudgetProtocolError,
    );
  });
});

// ───────────────────────────── 进度活性 ─────────────────────────────

describe('进度活性：检查点与停滞（§10.5 表）', () => {
  it('默认阈值取自 DEFAULTS', () => {
    const monitor = new LivenessMonitor({ startedAt: START });
    assert.equal(monitor.checkpointIntervalSeconds, DEFAULTS.checkpointIntervalSeconds);
    assert.equal(DEFAULTS.checkpointIntervalSeconds, 180);
    assert.equal(DEFAULTS.maxMissedCheckpoints, 2);
    assert.equal(DEFAULTS.maxConsecutiveToolFailures, 5);
    assert.equal(DEFAULTS.queuePressureSeconds, 60);
    assert.equal(DEFAULTS.contextPressureRatio, 0.85);
    assert.equal(DEFAULT_CONTEXT_PRESSURE_SECONDS, 60);
  });

  it('检查点间隔内没有信号，动作是继续', () => {
    const snapshot = new LivenessMonitor({ startedAt: START }).observe(at(179));

    assert.equal(snapshot.missedCheckpoints, 0);
    assert.equal(snapshot.stalled, false);
    assert.equal(snapshot.action, 'continue');
    assert.deepEqual(snapshot.raised, []);
    assert.deepEqual(snapshot.active, []);
  });

  it('错过一次检查点不足以判定停滞', () => {
    const snapshot = new LivenessMonitor({ startedAt: START }).observe(at(180));

    assert.equal(snapshot.missedCheckpoints, 1);
    assert.equal(snapshot.stalled, false);
    assert.deepEqual(snapshot.raised, []);
  });

  it('连续错过两次检查点判定停滞并写健康信号', () => {
    const monitor = new LivenessMonitor({ startedAt: START });
    const first = monitor.observe(at(180));
    assert.equal(first.stalled, false);

    const second = monitor.observe(at(360));
    assert.equal(second.missedCheckpoints, 2);
    assert.equal(second.stalled, true);
    assert.equal(second.action, 'signal');
    assert.deepEqual(
      second.raised.map((s) => s.kind),
      ['stalled'],
    );
    assert.equal(second.raised[0]?.threshold, 2);
    assert.equal(second.raised[0]?.observed, 2);
    assert.match(second.raised[0]?.detail ?? '', /判定进度停滞/);
    assert.deepEqual(monitor.active, ['stalled']);
  });

  it('一次性跳过两个间隔同样判停滞（同一事实不因扫描粒度而漂移）', () => {
    const snapshot = new LivenessMonitor({ startedAt: START }).observe(at(360));

    assert.equal(snapshot.missedCheckpoints, 2);
    assert.equal(snapshot.stalled, true);
    assert.deepEqual(
      snapshot.raised.map((s) => s.kind),
      ['stalled'],
    );
  });

  it('停滞不等于自动终止：监视器只给 continue / signal，且没有终止入口', () => {
    const monitor = new LivenessMonitor({ startedAt: START });
    const snapshot = monitor.observe(at(360));

    assert.equal(snapshot.stalled, true);
    assert.equal(snapshot.action, 'signal');
    assert.deepEqual(LIVENESS_ACTIONS, ['continue', 'signal']);
    assert.equal((LIVENESS_ACTIONS as readonly string[]).includes('terminate'), false);
    assert.equal((LIVENESS_ACTIONS as readonly string[]).includes('pause'), false);
    assert.equal('terminate' in snapshot, false);
    assert.equal('shouldTerminate' in snapshot, false);

    const prototypeNames = Object.getOwnPropertyNames(LivenessMonitor.prototype);
    for (const name of ['terminate', 'abort', 'stop', 'kill', 'pause', 'close', 'cancel']) {
      assert.equal(prototypeNames.includes(name), false, `LivenessMonitor 不应提供 ${name}`);
    }
  });

  it('停滞的会话仍在运行：检查点到达即解除并重新武装', () => {
    const monitor = new LivenessMonitor({ startedAt: START });
    monitor.observe(at(360));
    assert.deepEqual(monitor.active, ['stalled']);

    const recovered = monitor.checkpoint(at(400));
    assert.equal(recovered.missedCheckpoints, 0);
    assert.equal(recovered.stalled, false);
    assert.equal(recovered.action, 'continue');
    assert.deepEqual(monitor.active, []);

    monitor.observe(at(580));
    monitor.observe(at(760));
    assert.deepEqual(
      monitor.issued.map((s) => s.kind),
      ['stalled', 'stalled'],
    );
  });

  it('同一段停滞压力只写一次信号（边沿触发）', () => {
    const monitor = new LivenessMonitor({ startedAt: START });
    monitor.observe(at(360));
    const again = monitor.observe(at(540));

    assert.deepEqual(again.raised, []);
    assert.deepEqual(again.active, ['stalled']);
    assert.equal(again.action, 'signal');
    assert.equal(monitor.issued.length, 1);
  });
});

describe('进度活性：工具失败、队列压力与上下文压力（§10.5 表）', () => {
  it('工具连续失败 5 次才写健康信号', () => {
    const monitor = new LivenessMonitor({ startedAt: START });
    for (let i = 1; i <= 4; i += 1) {
      assert.deepEqual(monitor.noteToolResult(false, at(i)).raised, [], `第 ${i} 次不该触发`);
    }

    const snapshot = monitor.noteToolResult(false, at(5));
    assert.deepEqual(
      snapshot.raised.map((s) => s.kind),
      ['tool_failure_streak'],
    );
    assert.equal(snapshot.raised[0]?.threshold, 5);
    assert.equal(snapshot.raised[0]?.observed, 5);
    assert.equal(snapshot.consecutiveToolFailures, 5);
    assert.deepEqual(monitor.active, ['tool_failure_streak']);
  });

  it('一次工具成功清零连续失败计数并解除信号', () => {
    const monitor = new LivenessMonitor({ startedAt: START });
    for (let i = 0; i < 5; i += 1) monitor.noteToolResult(false, at(i));
    const recovered = monitor.noteToolResult(true, at(6));

    assert.equal(recovered.consecutiveToolFailures, 0);
    assert.deepEqual(monitor.active, []);
    assert.equal(recovered.action, 'continue');

    for (let i = 0; i < 5; i += 1) monitor.noteToolResult(false, at(10 + i));
    assert.deepEqual(
      monitor.issued.map((s) => s.kind),
      ['tool_failure_streak', 'tool_failure_streak'],
    );
  });

  it('队列压力：待执行动作 60 秒未被调度即写信号', () => {
    const monitor = new LivenessMonitor({ startedAt: START });
    monitor.noteQueuePending(at(0));

    const before = monitor.observe(at(59));
    assert.equal(before.queuePendingSeconds, 59);
    assert.deepEqual(before.raised, []);

    const after = monitor.observe(at(60));
    assert.equal(after.queuePendingSeconds, 60);
    assert.deepEqual(
      after.raised.map((s) => s.kind),
      ['queue_pressure'],
    );
    assert.equal(after.raised[0]?.threshold, 60);
    assert.equal(after.raised[0]?.observed, 60);
  });

  it('队首等待起点只记一次：后再有动作入队不重置计时', () => {
    const monitor = new LivenessMonitor({ startedAt: START });
    monitor.noteQueuePending(at(0));
    monitor.noteQueuePending(at(50));

    const snapshot = monitor.observe(at(60));
    assert.equal(snapshot.queuePendingSeconds, 60);
    assert.deepEqual(
      snapshot.raised.map((s) => s.kind),
      ['queue_pressure'],
    );
  });

  it('队列排空解除压力，并可再次触发', () => {
    const monitor = new LivenessMonitor({ startedAt: START });
    monitor.noteQueuePending(at(0));
    monitor.observe(at(60));
    monitor.drain();

    const drained = monitor.noteQueueDrained(at(61));
    assert.equal(drained.queuePendingSeconds, null);
    assert.deepEqual(monitor.active, []);

    monitor.noteQueuePending(at(61));
    const again = monitor.observe(at(121));
    assert.deepEqual(
      again.raised.map((s) => s.kind),
      ['queue_pressure'],
    );
    assert.equal(monitor.issued.length, 2);
  });

  it('上下文压力：持续高于 85% 达到窗口才写信号', () => {
    const monitor = new LivenessMonitor({ startedAt: START });
    monitor.noteContextUsage(0.9, at(0));

    const before = monitor.observe(at(59));
    assert.equal(before.contextHighSeconds, 59);
    assert.deepEqual(before.raised, []);

    const after = monitor.observe(at(60));
    assert.equal(after.contextRatio, 0.9);
    assert.deepEqual(
      after.raised.map((s) => s.kind),
      ['context_pressure'],
    );
    assert.equal(after.raised[0]?.threshold, 0.85);
    assert.equal(after.raised[0]?.observed, 0.9);
  });

  it('上下文用量回落到阈值以下即清零计时并解除信号', () => {
    const monitor = new LivenessMonitor({ startedAt: START });
    monitor.noteContextUsage(0.9, at(0));
    monitor.observe(at(60));
    assert.deepEqual(monitor.active, ['context_pressure']);

    const dropped = monitor.noteContextUsage(0.5, at(61));
    assert.equal(dropped.contextHighSeconds, null);
    assert.deepEqual(monitor.active, []);
  });

  it('上下文瞬时冲高不写信号（「持续」才算数）', () => {
    const monitor = new LivenessMonitor({ startedAt: START });
    monitor.noteContextUsage(0.95, at(0));
    monitor.noteContextUsage(0.4, at(10));

    const snapshot = monitor.observe(at(200));
    assert.deepEqual(snapshot.raised, []);
    assert.deepEqual(monitor.active, []);
    assert.equal(snapshot.contextHighSeconds, null);
  });

  it('恰好等于 85% 不算「高于」，不触发上下文压力', () => {
    const monitor = new LivenessMonitor({ startedAt: START });
    monitor.noteContextUsage(0.85, at(0));

    assert.deepEqual(monitor.observe(at(120)).raised, []);
    assert.equal(monitor.observe(at(120)).contextHighSeconds, null);
  });

  it('四种健康信号可以并存，且互不取代', () => {
    const monitor = new LivenessMonitor({ startedAt: START });
    monitor.noteQueuePending(at(0));
    monitor.noteContextUsage(0.95, at(0));
    for (let i = 0; i < 5; i += 1) monitor.noteToolResult(false, at(1));
    const snapshot = monitor.observe(at(360));

    assert.deepEqual(snapshot.active, HEALTH_SIGNAL_KINDS);
    assert.deepEqual(
      snapshot.raised.map((s) => s.kind),
      // tool_failure_streak 在第 5 次失败那一刻已经写出，本轮扫描不再重复写。
      ['stalled', 'queue_pressure', 'context_pressure'],
    );
    assert.equal(snapshot.action, 'signal');
  });

  it('drain 取走待写账本的信号后清空，不重复记账', () => {
    const monitor = new LivenessMonitor({ startedAt: START });
    monitor.observe(at(360));

    const drained = monitor.drain();
    assert.deepEqual(
      drained.map((s) => s.kind),
      ['stalled'],
    );
    assert.deepEqual(monitor.drain(), []);
    assert.equal(monitor.issued.length, 1);
  });

  it('活性阈值非法时构造失败', () => {
    assert.throws(
      () => new LivenessMonitor({ startedAt: START, checkpointIntervalSeconds: 0 }),
      BudgetProtocolError,
    );
    assert.throws(
      () => new LivenessMonitor({ startedAt: START, maxConsecutiveToolFailures: -1 }),
      BudgetProtocolError,
    );
  });

  it('停滞不改变预算判定：两个机制各说各的，都不终止会话', () => {
    const port = new FakeDshBudget();
    const monitor = new LivenessMonitor({ startedAt: START });
    const stalled = monitor.observe(at(360));

    const meter = makeMeter(port, { maxTokens: 100_000, maxSteps: 100, maxSeconds: 3600 });
    const reading = meter.evaluate(at(360));
    assert.equal(stalled.stalled, true);
    assert.equal(reading.verdict, 'ok');
    assert.equal(reading.action, 'continue');
    assert.equal(reading.consuming, true);
  });
});
