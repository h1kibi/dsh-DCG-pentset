/**
 * 《沙箱工具规范 v1》的宿主侧锁。
 *
 * 锁两条：
 *   1. **§7 命名**：模型可见的字段一律 `snake_case`（递归，含嵌套对象与数组元素）——
 *      这件事以前靠人看，而"同一个概念两种拼法"（`artifact_id` vs `artifactId`）正是
 *      2026-10-11 质检的发现之一；模型在报告里引用字段时写错键名，代价是整段证据链失效。
 *   2. **§7 单一来源**：`result-view.ts` 是"内部 camelCase → 模型可见 snake_case"的**唯一**
 *      转换点——工具不得绕过它直接返回内部类型。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { artifactView, memoryRecordsView, memorySearchView } from '../src/tools/result-view.ts';
import type { ArtifactRecord, MemoryRecord, MemorySearchResult } from '../src/tools/worker.ts';

const SNAKE_CASE = /^[a-z][a-z0-9_]*$/u;

/** 递归收集键名（对象与数组都进）；只做 `typeof`/`Array.isArray` 收窄，不造守卫类型。 */
function collectKeys(value: unknown, into: string[] = []): readonly string[] {
  if (Array.isArray(value)) {
    for (const item of value) collectKeys(item, into);
    return into;
  }
  if (typeof value === 'object' && value !== null) {
    for (const [key, child] of Object.entries(value)) {
      into.push(key);
      collectKeys(child, into);
    }
  }
  return into;
}

const ARTIFACT: ArtifactRecord = {
  artifactId: 'a-1',
  mediaType: 'text/plain',
  byteSize: 12,
  contentHash: 'h',
  inline: 'hello',
  truncated: false,
  // `metadata` 是**不透明数据**：本规范只约定这个字段叫 `metadata`，不约束它内部的键
  // （那是写入方的事；拿它当契约断言会把别人的数据形状误判成规范违规）。
  metadata: { source: 'probe', nested: { some_key: 1 } },
};

const RECORDS: readonly MemoryRecord[] = [
  {
    memoryId: 'm-1',
    content: 'c',
    contentHash: 'h2',
    occurredAt: '2026-10-11T00:00:00.000Z',
    originWorkerSessionId: null,
    trust: 'tool_observation',
    classification: 'engagement',
    provisional: false,
    relatedEventIds: ['e-1'],
  },
];

const SEARCH: MemorySearchResult = {
  hits: [
    {
      memoryId: 'm-1',
      excerpt: 'x',
      score: 0.5,
      source: {
        eventId: 'e-1',
        workerSessionId: 'ws-1',
        phase: 'intelligence-gathering',
        occurredAt: '2026-10-11T00:00:00.000Z',
      },
      trust: 'tool_observation',
      citation: 'memory:m-1',
    },
  ],
  indexWatermark: 3,
  note: '本作业记忆索引为空',
};

test('模型可见字段一律 snake_case（规范 §7）：三个视图递归检查', () => {
  const artifact = artifactView(ARTIFACT);
  const records = memoryRecordsView(RECORDS);
  const search = memorySearchView(SEARCH);

  for (const [tool, view] of [
    ['artifact_read', artifact],
    ['memory_read', records],
    ['memory_search', search],
  ] as const) {
    const bad = collectKeys(view).filter((key) => !SNAKE_CASE.test(key));
    assert.deepEqual(bad, [], `${tool} 的可见字段出现了非 snake_case 键：${bad.join(', ')}`);
  }

  // 语义不能因为改名而丢（改名最容易悄悄丢东西）
  assert.equal(artifact.artifact_id, 'a-1');
  assert.equal(artifact.inline, 'hello');
  assert.equal(artifact.storage_ref, undefined, '内联证据不该有 storage_ref（两者互斥）');
  assert.equal(records[0]?.memory_id, 'm-1');
  assert.equal(records[0]?.origin_worker_session_id, null, 'null 也是一条事实，不能被"省略"掉');
  assert.equal(search.index_watermark, 3, '`indexWatermark` → `index_watermark`');
  assert.equal(search.hits[0]?.source.event_id, 'e-1', '嵌套字段同样改名');
  assert.equal(search.note, '本作业记忆索引为空', '零命中/降级说明要照旧可达（模型据此分流）');
});

test('内部 camelCase 类型不得直接进工具返回（规范 §7：转换点只有 result-view.ts）', () => {
  const source = readFileSync(new URL('../src/tools/worker.ts', import.meta.url), 'utf8');
  for (const forbidden of [
    'toJson(await deps.readArtifact(',
    'toJson(await deps.search(',
    'toJson(await deps.read({',
  ]) {
    assert.equal(source.includes(forbidden), false, `worker.ts 仍有绕过视图的直接返回：${forbidden}`);
  }
  for (const view of ['artifactView(', 'memoryRecordsView(', 'memorySearchView(']) {
    assert.equal(source.includes(view), true, `worker.ts 未使用视图：${view}`);
  }
});
