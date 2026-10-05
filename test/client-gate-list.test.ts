/**
 * 共享闸门清单的测试（2026-10-05 复核 C4）。
 *
 * 收敛前同一件事有三份实现（各自的标记与数据形状）：`ReportExport` 的 {code,message}、
 * `HandoffEditor` 与 `EngagementList` 的 string[]（自己各写一次去重）。这里锁住收敛后的契约：
 *
 *   1. 形状归一：`string` 与 `{code,message}` 混着给都能渲染；
 *   2. 去重与空清单：重复原因只出现一次；没有阻塞时**不占位置**（渲染 null）；
 *   3. `code` 渲染成 `data-blocker`（测试与人工排查靠它指认），没有码时不造假标识；
 *   4. 标题可选：省略即裸列表。
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { GateList, gateBlockersOf } from '../src/client/views/GateList.tsx';

test('GateList：字符串与带码条目混着给，都渲染成清单项', () => {
  const html = renderToStaticMarkup(
    createElement(GateList, {
      blockers: [
        { code: 'undisposed-findings', message: '还有 3 条结论未处置' },
        '先选择一个 engagement',
      ],
      label: '签字前置条件',
    }),
  );
  assert.ok(html.includes('签字前置条件'), '标题必须渲染');
  assert.ok(html.includes('data-blocker="undisposed-findings"'), '带码条目渲染 data-blocker');
  assert.ok(html.includes('还有 3 条结论未处置'));
  assert.ok(html.includes('先选择一个 engagement'), '纯文案条目同样渲染');
  assert.ok(!html.includes('data-blocker="先选择一个 engagement"'), '没有码时不得造假标识');
  assert.equal((html.match(/<li/g) ?? []).length, 2);
});

test('GateList：空清单不占位置（渲染 null）', () => {
  assert.equal(renderToStaticMarkup(createElement(GateList, { blockers: [] })), '');
  assert.equal(renderToStaticMarkup(createElement(GateList, { blockers: ['   '] })), '', '空白文案不算一条');
});

test('GateList：按文案去重（同一原因被两条判定推出时不重复列）', () => {
  const html = renderToStaticMarkup(
    createElement(GateList, { blockers: ['还没选 skill', { message: '还没选 skill' }, '还没表决 skill 为空'] }),
  );
  assert.equal((html.match(/<li/g) ?? []).length, 2, '重复文案只出现一次');
  assert.ok(html.includes('还没表决 skill 为空'));
});

test('GateList：省略标题即裸列表', () => {
  const html = renderToStaticMarkup(createElement(GateList, { blockers: ['一项'] }));
  assert.ok(html.includes('一项'));
  assert.ok(!html.includes('pentest-gate__label'), '没有标题就不该渲染标题元素');
});

test('gateBlockersOf：归一化保持原顺序', () => {
  assert.deepEqual(gateBlockersOf(['a', { code: 'b', message: 'b 说清' }, 'c']), [
    { message: 'a' },
    { code: 'b', message: 'b 说清' },
    { message: 'c' },
  ]);
});
