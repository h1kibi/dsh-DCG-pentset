/**
 * 中文双字词投影的测试（设计 §8.6）。
 *
 * 守两条：
 *   1. **索引侧与查询侧对称** —— 文档投影出的二字组，必须能被查询投影出的二字组命中；
 *      不对称就等于没做（这是最容易在实现里悄悄破坏的一点）。
 *   2. **不碰 ASCII** —— 英文、域名、路径、端口号本来就切得对，改了会伤到现有能命中的查询。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { projectCjkBigrams, projectCjkQuery, toOrTsQuery } from '../src/memory/text-projection.ts';

/** 用与 PostgreSQL `simple` 配置相同的方式逼近词元集合：按空白切分。 */
const lexemes = (projected: string): readonly string[] => projected.split(/\s+/).filter((t) => t !== '');

test('中文连续段切成相邻二字组，原文保留', () => {
  const projected = projectCjkBigrams('网段资产');
  const tokens = lexemes(projected);
  assert.ok(tokens.includes('网段'), '2 字查询要能命中');
  assert.ok(tokens.includes('段资'), '相邻组合都要有');
  assert.ok(tokens.includes('资产'));
  assert.ok(tokens.includes('网段资产'), '原文保留（整串查询仍可命中）');
});

test('查询侧与索引侧对称：文档里的二字组都能被查询切出来', () => {
  const doc = projectCjkBigrams('成都理工大学公网网段资产侦查报告');
  const docTokens = new Set(lexemes(doc));
  for (const query of ['网段', '资产', '侦查', '公网', '成都理工']) {
    const q = projectCjkQuery(query);
    const qTokens = lexemes(q);
    assert.ok(qTokens.length > 0, `${query} 必须切出词元`);
    assert.ok(
      qTokens.every((token) => docTokens.has(token)),
      `${query} → ${q} 的每个词元都要在文档词元里（否则词法路必然 0 命中）`,
    );
  }
});

test('ASCII 原样不动（英文、域名、路径、端口）', () => {
  for (const text of ['nmap -sS -p 3002 10.0.0.5', 'https://lab.example.com/admin/login', 'CVE-2024-1234']) {
    assert.equal(projectCjkBigrams(text), text, `不得改动纯 ASCII：${text}`);
    assert.equal(projectCjkQuery(text), text.trim(), `查询侧也不得改动：${text}`);
  }
});

test('中英混排：中文被投影，ASCII 保持原样', () => {
  const projected = projectCjkBigrams('目标 10.0.0.5 的 8080 端口开放');
  assert.ok(projected.includes('10.0.0.5'), 'IP 原样');
  assert.ok(projected.includes('8080'), '端口原样');
  const tokens = lexemes(projected);
  assert.ok(tokens.includes('端口'), '中文被切出二字组');
  assert.ok(tokens.includes('口开'), '跨词组的相邻二字组也在（不做分词，只做滑窗）');
});

test('单字中文段不做投影（没有二字组可切，交给三元组路）', () => {
  assert.equal(projectCjkBigrams('的'), '的');
  // 单字查询：切不出二字组 ⇒ 原样返回（不去伪造一个词元）
  assert.equal(projectCjkQuery('段'), '段');
});

test('查询侧去重且不把原文塞进词法路', () => {
  const q = projectCjkQuery('网段网段');
  const tokens = lexemes(q);
  assert.deepEqual(tokens, [...new Set(tokens)], '重复查询词不重复出现');
  assert.ok(!tokens.includes('网段网段'), '整串原文不进查询词元（否则只有整串命中才算）');
});

test('超长中文段有上限，不会把索引吹爆', () => {
  const huge = '中'.repeat(10000);
  const projected = projectCjkBigrams(huge);
  assert.ok(projected.length < huge.length * 3, '投影长度必须有界');
  assert.ok(lexemes(projected).length <= 4097, '二字组数量按上限收口');
});

test('词法查询用 OR 连接（AND 会让多词元中文查询全不命中）', () => {
  // 实测：`plainto_tsquery('simple','资产 产侦 侦查')` 要求三个词元**全部命中** ⇒ 0 命中。
  assert.equal(toOrTsQuery('资产侦查'), `'资产' | '产侦' | '侦查'`);
  // ASCII 多词同样按 OR 召回（排序交给 ts_rank_cd：召回不足比排序不够致命）
  assert.equal(toOrTsQuery('nmap -sS'), `'nmap' | '-sS'`);
  // 空查询 ⇒ 空串，调用方回落到 plainto_tsquery('') 得空查询，而不是让 to_tsquery 语法错
  assert.equal(toOrTsQuery('   '), '');
});

test('词元一律单引号包裹并转义（to_tsquery 里 & | : ! ( ) 都是运算符）', () => {
  assert.equal(toOrTsQuery(`a'b`), `'a''b'`);
  // 自定义投影（`cjkProjection: false` 时注入恒等函数）：两侧必须用同一个，否则词元对不上
  assert.equal(toOrTsQuery('网段', (value) => value), `'网段'`);
});
