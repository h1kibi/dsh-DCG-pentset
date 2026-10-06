/**
 * 交接压缩的测试（纯逻辑 + 一次注入 fetch 的调用）。
 *
 * 守三条：
 *   1. **材料该带的都带上**：便签、报告（带 id）、人类原话、近期过程；空的部分不留空标题。
 *   2. **人类原话必须原样进材料**（PINNED 不参与压缩，是 `compaction.ts` 同一条纪律在跨阶段上的延续）。
 *   3. **失败一律回落**：HTTP 错、形状不对、空内容、超时 —— 都返回 `ok: false`，绝不抛给调用方
 *      （起草是人点出来的动作，不能因为一次模型调用失败而点不动）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildCompressionPrompt,
  compressHandoffContext,
  parseCompressionOutput,
} from '../src/workflow/handoff-compression.ts';

const MATERIAL = {
  fromPhaseLabel: '情报收集',
  toPhaseLabel: '威胁建模',
  statusNote: '指纹完成：nginx + Next.js；/api/submissions 未认证可读。',
  reportSummary: '资产 12 条、服务 20 条；建议先建信任边界再定攻击路径。',
  reportId: 'report-77',
  pinned: ['人类插话：生产库不许碰'],
  recent: ['nmap -sV 10.0.0.5 → 22/tcp open ssh', 'ffuf /api → 200 /api/submissions'],
} as const;

test('材料齐备时四段都在，且人类原话原样保留', () => {
  const prompt = buildCompressionPrompt({ ...MATERIAL });
  assert.match(prompt.user, /情报收集 → 威胁建模/);
  assert.match(prompt.user, /状态便签（Agent 自述）/);
  assert.match(prompt.user, /报告（report-77）/, '报告 id 要带上（可回溯）');
  assert.match(prompt.user, /人类原话（永不压缩，原样保留）/);
  assert.match(prompt.user, /- 人类插话：生产库不许碰/, '人类原话逐字进材料');
  assert.match(prompt.user, /近期过程（可压缩）/);
  assert.match(prompt.system, /# 结论/, '输出契约写死在 system 里（四段固定标题）');
  assert.match(prompt.system, /不超过 2500 字符/, '长度上限进提示词');
});

test('空的部分不留空标题', () => {
  const prompt = buildCompressionPrompt({
    ...MATERIAL,
    statusNote: '   ',
    reportSummary: '',
    reportId: null,
    pinned: [],
    recent: [],
  });
  assert.ok(!prompt.user.includes('状态便签'));
  assert.ok(!prompt.user.includes('## 上一阶段报告'));
  assert.ok(!prompt.user.includes('人类原话'));
  assert.ok(!prompt.user.includes('近期过程'));
  assert.match(prompt.user, /情报收集 → 威胁建模/, '阶段行总在');
});

test('解析：剥代码围栏、截断到上限', () => {
  const raw = '```markdown\n# 结论\n未认证可读。\n```';
  assert.equal(parseCompressionOutput(raw), '# 结论\n未认证可读。');
  assert.equal(parseCompressionOutput('a'.repeat(100), 10).length, 10);
});

test('调用：形状不对/HTTP 错/空内容都回落，不抛', async () => {
  const wrongShape = async (): Promise<Response> =>
    new Response(JSON.stringify({ nope: true }), { status: 200 });
  const httpError = async (): Promise<Response> => new Response('denied', { status: 403 });
  const emptyText = async (): Promise<Response> =>
    new Response(JSON.stringify({ choices: [{ message: { content: '   ' } }] }), { status: 200 });
  const base = { endpoint: 'http://x/v1/chat/completions', apiKey: 'k', model: 'm' };

  for (const [label, impl, expect] of [
    ['形状不对', wrongShape, 'choices'],
    ['HTTP 错', httpError, 'HTTP 403'],
    ['空内容', emptyText, '空内容'],
  ] as const) {
    const r = await compressHandoffContext({ ...base, fetchImpl: impl as typeof fetch }, { ...MATERIAL });
    assert.equal(r.ok, false, `${label} 必须回落`);
    if (!r.ok) assert.match(r.reason, new RegExp(expect));
  }
});

test('调用：成功时带回模型名与截断后的正文', async () => {
  const ok = async (): Promise<Response> =>
    new Response(
      JSON.stringify({ choices: [{ message: { content: '# 结论\n越权可读。\n# 证据\n/api 200' } }] }),
      { status: 200 },
    );
  const r = await compressHandoffContext(
    { endpoint: 'http://x/v1/chat/completions', apiKey: 'k', model: 'deepseek-v4-pro', fetchImpl: ok as typeof fetch },
    { ...MATERIAL },
  );
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.match(r.text, /# 结论/);
    assert.equal(r.model, 'deepseek-v4-pro', '带回模型名（谁压的要能查到）');
  }
});
