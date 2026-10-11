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

import {
  approvalView,
  artifactView,
  intakeView,
  memoryRecordsView,
  memorySearchView,
  planView,
  reportResultView,
  scopeProposalView,
  skillView,
  toolRunResultView,
  workdirFileView,
  workdirListingView,
  workdirSearchView,
  workdirWriteView,
} from '../src/tools/result-view.ts';
import type { ExecutionPlan, ToolRunResult } from '../src/contracts.ts';
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

test('作业目录工具的字段也是 snake_case（规范 §7）：四个视图递归检查', () => {
  const root = { containerPath: '/work', readOnly: false } as const;
  const listing = workdirListingView(
    {
      path: '.',
      root: '/work',
      containerPath: '/work',
      entries: [{ name: 'a.md', type: 'file', size: 12 }],
      truncated: false,
    },
    [root],
  );
  const file = workdirFileView({
    path: 'a.md',
    containerPath: '/work/a.md',
    bytes: 12,
    text: 'hi',
    truncated: false,
    binary: false,
  });
  const write = workdirWriteView({ path: 'a.md', containerPath: '/work/a.md', bytes: 3 });
  const search = workdirSearchView({
    path: '.',
    pattern: 'x',
    matches: [{ path: 'a.md', line: 1, text: 'x' }],
    filesScanned: 1,
    truncated: false,
    skipped: [],
    files: [{ path: 'a.md', modifiedAt: '2026-10-11T00:00:00.000Z', matches: 1 }],
  });

  for (const [name, view] of [
    ['op=list', listing],
    ['op=read', file],
    ['op=write', write],
    ['op=search', search],
  ] as const) {
    const bad = collectKeys(view).filter((key) => !SNAKE_CASE.test(key));
    assert.deepEqual(bad, [], `${name} 的可见字段出现了非 snake_case 键：${bad.join(', ')}`);
  }

  // 判据字段改名后仍可达（模型据它们判断"要不要带前缀""是否被截断"）
  assert.equal(listing.container_path, '/work');
  assert.deepEqual(listing.roots, [{ container_path: '/work', read_only: false }]);
  assert.equal(file.container_path, '/work/a.md');
  assert.equal(search.files[0]?.modified_at, '2026-10-11T00:00:00.000Z');
  assert.equal(search.files_scanned, 1);
});

test('其余工具面（intake/report/approval/scope/skill/plan/result）也必须过视图（规范 §7）', () => {
  // 2026-10-11 复查发现：这几处此前是**直通内部类型**（`skill_load` 泄漏 `contentHash`、
  // `pentest_exec` 的 `plan`/`result` 全是 camelCase）——锁必须覆盖它们，否则"改了三个视图"
  // 会被误当成"§7 已落实"。
  const PLAN: ExecutionPlan = {
    workerSessionId: 'ws-1',
    templateId: 'http_get',
    actionClass: 'passive_collection',
    normalizedTarget: 'example.com',
    resolvedAddresses: ['93.184.216.34'],
    normalizedCommand: 'http_get url=https://example.com/',
    planHash: 'plan-hash',
    idempotencyKey: 'idem-1',
    scopeVersion: 1,
    policyEpoch: 1,
    leaseGeneration: 1,
    approvalId: null,
    timeoutMs: 30_000,
    maxOutputBytes: 64 * 1024,
  };
  const runResult: ToolRunResult = {
    status: 'completed',
    exitCode: 0,
    stdout: 'out',
    stderr: '',
    truncated: false,
    artifactIds: ['a-1'],
    toolRunId: 'run-1',
  };
  const views: Readonly<Record<string, unknown>> = {
    bootstrap_intake: intakeView({
      engagementId: 'e-1',
      workerSessionId: 'ws-1',
      dshSessionId: 'dsh-ws-1',
      leaseId: 'l-1',
      leaseGeneration: 1,
      scopeVersion: 0,
      resumed: false,
      nextStep: '去控制台确认范围',
    }),
    plan: planView(PLAN),
    tool_run_result: toolRunResultView(runResult),
    report: reportResultView({
      reportId: 'r-1',
      stateVersion: 3,
      findings: { written: 1, skipped: 0 },
      merged: { mode: 'append', baseReportId: 'r-0', sections: { facts: 2 } },
    }),
    approval: approvalView({ approvalId: 'ap-1', planHash: 'h', expiresAt: '2026-01-01T00:10:00.000Z' }),
    scope_proposal: scopeProposalView({
      id: 'p-1',
      engagementId: 'e-1',
      workerSessionId: 'ws-1',
      objective: 'o',
      targets: [],
      exclusions: [],
      allowedActions: ['passive_collection'],
      status: 'pending',
      createdAt: '2026-01-01T00:00:00.000Z',
      decidedAt: null,
    }),
    skill: skillView({ name: 's', description: 'd', body: 'b', contentHash: 'h', revision: 2 }),
  };

  for (const [name, view] of Object.entries(views)) {
    const bad = collectKeys(view).filter((key) => !SNAKE_CASE.test(key));
    assert.deepEqual(bad, [], `${name} 的可见字段出现了非 snake_case 键：${bad.join(', ')}`);
  }

  // 语义不能丢：改名后关键字段仍可达
  assert.equal((views['plan'] as Record<string, unknown>)['plan_hash'], 'plan-hash');
  assert.equal((views['tool_run_result'] as Record<string, unknown>)['tool_run_id'], 'run-1');
  assert.equal((views['tool_run_result'] as Record<string, unknown>)['exit_code'], 0);
  assert.equal(
    ((views['report'] as { merged: { base_report_id: string } }).merged).base_report_id,
    'r-0',
    '`merged.baseReportId` → `merged.base_report_id`（提示词里也引它）',
  );
  assert.equal((views['skill'] as Record<string, unknown>)['content_hash'], 'h');
  // 留痕字段刻意不回显（见 `scopeProposalView` 的说明）
  assert.equal(Object.hasOwn(views['scope_proposal'] as object, 'authorization_note'), false);
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
  for (const view of [
    'artifactView(',
    'memoryRecordsView(',
    'memorySearchView(',
    'intakeView(',
    'planView(',
    'toolRunResultView(',
    'reportResultView(',
    'approvalView(',
    'scopeProposalView(',
    'skillView(',
    'workdirListingView(',
    'workdirSearchView(',
  ]) {
    assert.equal(source.includes(view), true, `worker.ts 未使用视图：${view}`);
  }
});

/**
 * 查询串字符集的**逐字符对拍**（2026-10-11 操作者实测 #2）。
 *
 * 放行 `&` 的前提是"两边同集、且集合里没有真正危险的 shell 字面量"：宿主模板只管形状，
 * 容器侧才是权威校验器。两处若漂移，症状是"模板放行、容器 rc=2"（或反过来静默发送非法路径），
 * 而这两种都很难从报告里看出来。
 */
test('查询串字符集：宿主模板与容器正则逐字符同集，且不含 shell 危险字面量', () => {
  const templates = readFileSync(new URL('../src/execution/templates.ts', import.meta.url), 'utf8');
  const dispatcher = readFileSync(new URL('../docker/tools/pentest-tool', import.meta.url), 'utf8');

  const hostMatch = /const PROBE_QUERY_CHARS = "(.+)";/u.exec(templates);
  assert.ok(hostMatch !== null, '找不到 PROBE_QUERY_CHARS（宿主侧查询串字符集）');
  const containerMatch = /PROBE_QUERY_RE = re\.compile\(r"\^\[(.+)\]\{0,200\}\$"\)/u.exec(dispatcher);
  assert.ok(containerMatch !== null, '找不到 PROBE_QUERY_RE（容器侧查询串字符集）');

  /**
   * 把字符类字面量展开成**排序去重的字符数组**（处理 `a-z` 区间与 `\x` 转义）。
   * 宿主侧是 TS 字符串（要先解一层 `\\` 才是正则字面量），容器侧是 Python raw string（已是正则层）。
   */
  const expand = (body: string): readonly string[] => {
    const out: string[] = [];
    for (let i = 0; i < body.length; i += 1) {
      if (body[i] === '\\') {
        i += 1;
        if (i < body.length) out.push(body[i]!);
        continue;
      }
      if (body[i + 1] === '-' && i + 2 < body.length && body[i + 2] !== ']') {
        for (let code = body.charCodeAt(i); code <= body.charCodeAt(i + 2); code += 1) {
          out.push(String.fromCharCode(code));
        }
        i += 2;
        continue;
      }
      out.push(body[i]!);
    }
    return [...new Set(out)].sort();
  };

  // 宿主捕获里含**字符类定界符** `[`/`]`，容器捕获不含——先剥掉定界符再展开，否则
  // 定界符本身会冒充集合成员，"宿主删掉 `\[`/`\]`" 这类漂移就判不出来（第八轮质检）。
  const hostBody = (hostMatch[1] ?? '').replace(/^\[/u, '').replace(/\]$/u, '');
  const host = expand(hostBody.replace(/\\\\/gu, '\\'));
  const container = expand(containerMatch[1] ?? '');
  assert.deepEqual(
    host,
    container,
    '宿主与容器的查询串字符集必须逐字符相同（两边都改，且只改一处会红）',
  );
  // 放行面**只有 `&`**：真正危险的 shell 字面量一个都不许在集合里。
  for (const dangerous of ['$', '`', '"', "'", '\\', '{', '}', '<', '>', '|', ';', ',', '#', ' ']) {
    assert.equal(host.includes(dangerous), false, `查询串字符集不得含 ${JSON.stringify(dangerous)}`);
  }
  assert.equal(host.includes('&'), true, '`&` 必须放行（否则多参数查询串没有结构化通道）');
});

/** chunk 跟随上限的**数字单一来源**锁（2026-10-11 第八轮质检）。 */
test('chunk 上限：容器常量 ↔ 常驻提示词/文档里的数字必须同值（手抄即漂移）', () => {
  // 为什么要有它：本轮把 `CHUNK_FETCH_LIMIT` 从 8 抬到 24 时，`worker.ts` 的工具描述与 `RUNBOOK`
  // 里各留了一份"上限 8 条"的手抄——两处都是模型/人类直接读的文本（前者常驻提示词面）。
  // §7 的纪律是"数字从唯一来源渲染"，这条锁把它落到可机器判定：**数字本身由容器常量推出来**。
  const dispatcher = readFileSync(new URL('../docker/tools/pentest-tool', import.meta.url), 'utf8');
  const limit = /CHUNK_FETCH_LIMIT = (\d+)/u.exec(dispatcher)?.[1];
  const bytes = /CHUNK_BYTES_LIMIT = (\d+) \* 1024/u.exec(dispatcher)?.[1];
  const total = /CHUNK_TOTAL_BYTES_LIMIT = (\d+) \* 1024/u.exec(dispatcher)?.[1];
  assert.ok(limit !== undefined && bytes !== undefined && total !== undefined, '容器侧的 chunk 上限常量必须可解析');

  const quoted = [
    new URL('../src/tools/worker.ts', import.meta.url),
    new URL('../src/execution/templates.ts', import.meta.url),
    new URL('../src/agents/technique-params-guide.ts', import.meta.url),
    new URL('../RUNBOOK.md', import.meta.url),
  ] as const;
  const countToken = `${limit} 条`;
  const perChunkToken = `${bytes}KiB`;
  const totalToken = `${Number(total) / 1024}MiB`;
  const offenders: string[] = [];
  for (const url of quoted) {
    const text = readFileSync(url, 'utf8');
    const name = url.pathname.split('/').slice(-1)[0] ?? '';
    if (!text.includes(countToken)) offenders.push(`${name} 缺 "${countToken}"（chunk 条数上限没跟容器常量）`);
    if (!text.includes(perChunkToken)) offenders.push(`${name} 缺 "${perChunkToken}"（每条字节上限）`);
    if (!text.includes(totalToken)) offenders.push(`${name} 缺 "${totalToken}"（合计字节上限）`);
    if (text.includes('上限 8 条')) offenders.push(`${name} 仍有"上限 8 条"这种手抄旧值`);
  }
  assert.deepEqual(offenders, [], 'chunk 上限的数字必须与容器常量同源');
});

/** 端口可信度阈值与样本量的**数字单一来源**锁（2026-10-11 质检）。 */
test('端口可信度：技能配方里的阈值与样本下限必须与容器常量同值（手抄即漂移）', () => {
  // 为什么要有它：`recon-network-surface` 的第 3b 步给了**手写扫描**时的自查配方（带 `0.8` 与
  // "样本足够大"），而容器侧 `port_state_trust` 用的是同一口径的常量。两处若漂移，症状是
  // "工具说 suspect、技能说 ok"——而人只会相信其中一个。
  const dispatcher = readFileSync(new URL('../docker/tools/pentest-tool', import.meta.url), 'utf8');
  const minSample = /PORT_STATE_TRUST_MIN_SAMPLE = (\d+)/u.exec(dispatcher)?.[1];
  assert.ok(minSample !== undefined, '容器侧必须有 PORT_STATE_TRUST_MIN_SAMPLE 常量');
  assert.match(dispatcher, /ratio >= 0\.8/, '容器侧的阈值必须仍是 0.8（改了就要同步技能与文档）');

  const skill = readFileSync(new URL('../skills/recon-network-surface/SKILL.md', import.meta.url), 'utf8');
  assert.match(skill, /ratio >= 0\.8/, '技能的配方必须与容器同阈值（0.8）——两者是同一个判据的两种写法');
  assert.match(
    skill,
    /样本/,
    '技能必须写明"样本很小时不按比例判"（否则 1/1 会被当成近全开，正常作业天天响假警报）',
  );
  // 手写配方**必须自足**：扫描与统计在同一条命令里（容器一次性），且读不到结果时**拒绝给结论**。
  assert.match(skill, /nmap -sT -Pn -p "\$P" "\$T" -oN \/tmp\/ports\.txt/, '配方必须自己跑扫描（不能引用上一条命令的 /tmp 产物）');
  assert.match(skill, /verdict=unknown/, '读不到扫描结果时必须给 unknown，不许静默判 ok');
});
