/**
 * 入库文本净化的测试（两份实测报告都撞到"Unicode 入库丢证据"）。
 *
 * 守两条边界：**该丢的丢**（NUL / 孤立代理 —— 它们会让 jsonb 整条写入失败），
 * **不该丢的一个都不丢**（配对的代理 = 正常 emoji；`\u0000` 这种**字面文本**是合法内容）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { sanitizeChanged, sanitizeJsonText } from '../src/execution/text-sanitize.ts';

test('NUL 与孤立代理被去掉', () => {
  assert.equal(sanitizeJsonText('a\u0000b'), 'ab', 'NUL 必须去掉（PostgreSQL 不收）');
  assert.equal(sanitizeJsonText('x\uD800y'), 'xy', '孤立高代理必须去掉');
  assert.equal(sanitizeJsonText('x\uDC00y'), 'xy', '孤立低代理必须去掉');
  assert.equal(sanitizeJsonText('\uD800'), '', '只剩一个孤立代理时结果为空');
});

test('配对的代理（正常 emoji）必须原样保留', () => {
  assert.equal(sanitizeJsonText('😀 ok'), '😀 ok');
  assert.equal(sanitizeJsonText('命中 😀 目标'), '命中 😀 目标');
  // 误删配对代理会把正常内容改坏 —— 这条与上面"去掉孤立代理"是一对边界
  assert.equal(sanitizeJsonText('😀\uD800😀'), '😀😀');
});

test('字面转义文本是合法内容，不动它', () => {
  const literal = '目标返回了 \\u0000 这三个字符作为**文本**';
  assert.equal(sanitizeJsonText(literal), literal);
  assert.equal(sanitizeChanged(literal), false, '没改动就不该说改过');
});

test('正常中英文与换行不受影响', () => {
  const normal = '第一行\n第二行 TCP 443 open\nGET /admin → 200\n';
  assert.equal(sanitizeJsonText(normal), normal);
  assert.equal(sanitizeChanged(normal), false);
});
