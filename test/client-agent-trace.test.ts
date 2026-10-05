/**
 * 「当前 Agent 轨迹」的投影与选取（`src/client/session-chat.ts` 的两个纯函数）。
 *
 * 这一栏是**自动跟随会话不生效时的替代通道**：它只依赖 dsh 自己的 `session/page`
 * 端点，因此必须自己站得住——投影漏掉工具调用就等于把「Agent 到底在干什么」丢掉，
 * 而选取挑错会话则会让人看着另一个阶段的轨迹。
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { activeWorkerSessionOf, stripControlSequences, traceTranscript, type SessionRecord } from '../src/client/session-chat.ts';
import type { WorkerSessionSummary, WorkflowSnapshot } from '../src/contracts.ts';

function record(seq: number, type: string, data: unknown): SessionRecord {
  return { type, event: { seq, time: 0, type, data } };
}

test('轨迹投影保留工具调用/结果/思考/回复，并丢弃运行噪声', () => {
  const records: SessionRecord[] = [
    record(1, 'turn/start', { turn: 1 }),
    record(2, 'step/start', { turn: 1, step: 1 }),
    record(3, 'assistant/message', {
      message: {
        content: [
          { type: 'reasoning', text: '先看服务指纹，再决定要不要深挖。' },
          { type: 'tool-call', name: 'pentest_exec', arguments: '{"template_id":"http_get"}' },
        ],
      },
    }),
    record(4, 'tool/call', { turn: 1, step: 1, callId: 'c1', name: 'pentest_exec', arguments: '{"text":"http_get target=https://x:3002"}' }),
    record(5, 'tool/result', {
      message: { source: { kind: 'tool', callId: 'c1' }, content: [{ type: 'tool-result', content: [{ type: 'text', text: 'HTTP/1.1 200 OK' }], isError: false }] },
    }),
    record(6, 'assistant/message', { message: { content: [{ type: 'text', text: '指纹完成：nginx + Next.js。' }] } }),
    record(7, 'step/end', { turn: 1, step: 1 }),
  ];

  const rows = traceTranscript(records);
  const kinds = rows.map((row) => row.kind);
  // 助手消息里的 tool-call 块不单独成行（事件流里另有 tool/call，重复会双倍计数）。
  assert.deepEqual(kinds, ['thinking', 'tool-call', 'tool-result', 'reply'], '顺序与种类都要对');
  assert.ok(rows[0]?.text.includes('先看服务指纹'), '思考正文要留下');
  assert.ok(rows[1]?.label.includes('pentest_exec'), '工具名要出现在标签里');
  assert.ok(rows[1]?.text.includes('http_get'), '工具参数要留下（人类靠它判断在做什么）');
  assert.ok(rows[2]?.text.includes('200 OK'), '工具结果要留下');
  assert.ok(rows[3]?.text.includes('nginx'), '回复要留下');
});

test('工具失败与回合失败都显式标出（不得混进「正常结果」）', () => {
  const rows = traceTranscript([
    record(1, 'tool/result', {
      message: { source: { kind: 'tool' }, content: [{ type: 'tool-result', content: [{ type: 'text', text: 'proxy 403' }], isError: true }] },
    }),
    record(2, 'turn/end', { turn: 1, error: '上下文超限' }),
  ]);
  assert.equal(rows[0]?.label, '工具失败', 'isError 必须变成「失败」标签');
  assert.equal(rows[1]?.kind, 'note');
  assert.ok(rows[1]?.text.includes('上下文超限'));
});

test('超长输出截断并留话（不把完整内容塞进进程内展示）', () => {
  const rows = traceTranscript([
    record(1, 'tool/result', {
      message: { source: { kind: 'tool' }, content: [{ type: 'tool-result', content: [{ type: 'text', text: 'x'.repeat(5000) }], isError: false }] },
    }),
  ]);
  assert.ok((rows[0]?.text.length ?? 0) < 700, '必须截断');
  assert.ok(rows[0]?.text.includes('已截断'), '要说明截断了，而不是静默丢内容');
});

test('活动会话以指针为准；指针缺失时退回最新的未结束会话；都没有则 null', () => {
  const snapshot = (activeWorkerSessionId: string | null): { state: WorkflowSnapshot | null; sessions: readonly WorkerSessionSummary[] } => ({
    state: activeWorkerSessionId === null ? null : ({ activeWorkerSessionId } as unknown as WorkflowSnapshot),
    sessions: [
      summary('w-old', 'dsh-old', 'closed', '2026-10-03T04:00:00.000Z'),
      summary('w-phase', 'dsh-phase', 'waiting_human', '2026-10-03T04:10:00.000Z'),
      summary('w-newest', 'dsh-newest', 'active', '2026-10-03T04:20:00.000Z'),
    ],
  });

  assert.equal(activeWorkerSessionOf(snapshot('w-phase'))?.dshSessionId, 'dsh-phase', '有指针时必须听指针的');
  assert.equal(activeWorkerSessionOf(snapshot(null))?.dshSessionId, 'dsh-newest', '指针缺失时退回最新未结束的会话');
  assert.equal(
    activeWorkerSessionOf({ state: null, sessions: [summary('w-old', 'dsh-old', 'closed', '2026-10-03T04:00:00.000Z')] }),
    null,
    '只有已结束的会话时不给轨迹（面板不画这一栏）',
  );
});

function summary(
  id: string,
  dshSessionId: string,
  status: WorkerSessionSummary['status'],
  createdAt: string,
): WorkerSessionSummary {
  return {
    id,
    dshSessionId,
    phase: 'intelligence-gathering',
    status,
    attempt: 1,
    iteration: 1,
    scopeVersion: 1,
    previousAgentSessionId: null,
    retryOfSessionId: null,
    transitionId: null,
    statusNote: null,
    statusNoteSource: null,
    statusNoteAt: null,
    startedAt: null,
    endedAt: null,
    createdAt,
  };
}

// ─────────────────── 会话记录里的控制序列 ───────────────────

/**
 * 宿主会把内联进度/锚点标记写进消息文本。人类从界面复制出来的是
 * `…的话。所以我会用 [13;28;13;1;0;1_[13;28;13;0;0;1_http://…` 这种垃圾
 *（2026-10-04 实机报障）。投影必须在**唯一的文本出口**上剥掉它们。
 */
test('会话记录投影剥掉控制序列与裸坐标标记，但不误伤正常方括号写法', () => {
  const noisy = '第一句。\u001b[13;28m [13;28;13;1;0;1_[13;28;13;0;0;1_http://47.109.76.66:3002/ 之后的话\u0007';
  const clean = stripControlSequences(noisy);
  assert.equal(clean.includes('13;28'), false, '裸坐标标记必须去掉');
  assert.equal(clean.includes('\u001b'), false, 'ESC 必须去掉');
  assert.equal(clean.includes('\u0007'), false, '其余 C0 控制字符（响铃）必须去掉');
  assert.match(clean, /http:\/\/47\.109\.76\.66:3002\//, '正文与 URL 必须原样保留');
  assert.match(clean, /第一句。/);

  // 不误伤：编号、日期、普通方括号说明、区间写法都得留着。
  for (const keep of ['见 [1] 与 [2]', '[2026-10-04] 开始', '[note] 说明', '数组 a[0] 的写法', '区间 [1;2] 与 [3;4)']) {
    assert.equal(stripControlSequences(keep), keep, `不得改写：${keep}`);
  }
  // 经典 SGR 也要剥掉（宿主/工具输出里常见）。
  assert.equal(stripControlSequences('正常\u001b[31;1m红字\u001b[0m结束'), '正常红字结束');
});
