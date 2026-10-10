/**
 * 报告载荷合并的语义锁（`mode: 'append'`，2026-10-11 操作者诉求 #2）。
 *
 * **为什么锁在纯函数上**：合并语义是"追加模式"的全部可预期性所在——数组怎么接、标量怎么办、
 * 重发同一份增量会不会翻倍。这些跟数据库无关，用纯函数锁最便宜；服务端只负责"基底取哪一行"
 * （那条在 `test/pg-worker-tools.test.ts` 里用真库锁）。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { mergeReportPayload, reportPayloadSectionCounts } from '../src/memory/report-payload-merge.ts';

test('数组追加：新的接在后面，**深等值重复项不重复追加**（同一份增量重发不翻倍）', () => {
  const base = { facts: ['a', { statement: 'b', confidence: 0.4 }] };
  const delta = { facts: [{ statement: 'b', confidence: 0.4 }, 'c'] };
  const merged = mergeReportPayload(base, delta) as { facts: unknown[] };
  assert.deepEqual(
    merged.facts,
    ['a', { statement: 'b', confidence: 0.4 }, 'c'],
    '已有的 {statement:b,confidence:0.4} 不该被追加第二次——深等值（含嵌套对象键序无关）',
  );
  // 幂等：把同一份 delta 再合一次，结果不变（超时重试/模型重试的安全网）
  assert.deepEqual(mergeReportPayload(merged, delta), merged);
});

test('对象递归合并、标量由新值覆盖、类型冲突不猜测', () => {
  const base = { meta: { a: 1, b: 2 }, summary: '旧', facts: ['x'] };
  const delta = { meta: { b: 3 }, summary: '新', facts: '整段被换成字符串' };
  const merged = mergeReportPayload(base, delta) as Record<string, unknown>;
  assert.deepEqual(merged.meta, { a: 1, b: 3 }, '对象逐键合并');
  assert.equal(merged.summary, '新', '标量覆盖');
  assert.equal(merged.facts, '整段被换成字符串', '类型冲突由新值覆盖（不猜"怎么合并数组与字符串"）');
});

test('不修改入参：基底来自 payload_json，改它会让"旧版本"跟着变', () => {
  const base = { facts: ['a'] };
  const delta = { facts: ['b'] };
  const snapshot = JSON.stringify(base);
  const merged = mergeReportPayload(base, delta) as { facts: string[] };
  merged.facts.push('c');
  assert.equal(JSON.stringify(base), snapshot, '基底对象不得被就地修改');
  assert.deepEqual(base, { facts: ['a'] });
});

test('缺失/空基底：增量即结果；null 基线不报错', () => {
  assert.deepEqual(mergeReportPayload(undefined, { facts: ['a'] }), { facts: ['a'] });
  assert.deepEqual(mergeReportPayload(null, { facts: ['a'] }), { facts: ['a'] });
  assert.equal(mergeReportPayload({ facts: [] }, undefined), undefined, '增量为 undefined ⇒ 覆盖语义（服务端不用它）');
});

test('分段计数只数数组（给提交返回值用：模型据此确认补进去的真的在里头）', () => {
  assert.deepEqual(
    reportPayloadSectionCounts({
      facts: ['a', 'b'],
      candidate_findings: [{ title: 't' }],
      summary: '不是数组，不数',
      meta: { nested: ['x'] },
    }),
    { facts: 2, candidate_findings: 1 },
  );
  assert.deepEqual(reportPayloadSectionCounts(null), {});
  assert.deepEqual(reportPayloadSectionCounts('字符串载荷'), {});
});
