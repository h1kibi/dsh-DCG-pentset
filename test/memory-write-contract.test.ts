/**
 * 写入侧 → 分块器的**契约**测试。
 *
 * ── 为什么单独立一个文件 ──
 *
 * 这两条链路之间的漂移**不会让任何既有测试变红**：分块器测试自己造载荷，写入侧测试只管写库，
 * 两边各自都「通过」。2026-10-04 的实机演练里，人类插话正文与报告事实都没进检索面，
 * 而当时 1511 个用例全绿。
 *
 * 因此本文件的纪律是：**载荷一律由写入侧导出的构造器生成**（`interjectionEventPayload`、
 * `workerReportEventPayload`），再喂给 `planChunks`。测试里手抄形状等于把契约测试又变回
 * 「两边的测试各自自洽」——那正是要避免的失败模式。
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { planChunks, reportSectionTexts, deriveChunkKind, REPORT_SECTIONS, type ChunkDraft, type ChunkSourceEvent } from '../src/memory/chunks.ts';
import { interjectionEventPayload } from '../src/workflow/sessions.ts';
import { workerReportEventPayload } from '../src/memory/pg-worker-tools.ts';

const ENGAGEMENT = '00000000-0000-4000-8000-000000000001';
const EVENT = '00000000-0000-4000-8000-000000000002';

function sourceEvent(eventType: ChunkSourceEvent['eventType'], payload: unknown): ChunkSourceEvent {
  return {
    eventId: EVENT,
    engagementId: ENGAGEMENT,
    eventType,
    workerSessionId: null,
    phase: 'intelligence-gathering',
    trustLevel: 'human_decision',
    classification: 'engagement',
    occurredAt: new Date('2026-10-04T11:39:00Z'),
    payload,
  };
}

const kindsOf = (drafts: readonly ChunkDraft[]): readonly string[] => drafts.map((draft) => draft.kind);

describe('人类插话：正文必须进账本并落成 human_input 块（§8.5「人类输入」）', () => {
  for (const woke of [false, true]) {
    test(`载荷构造器（woke=${String(woke)}）→ planChunks 至少一块且含原文`, () => {
      const message = '跳过那个端口，它属于客户的生产系统';
      const drafts = planChunks(sourceEvent('human.interjection', interjectionEventPayload({ message, woke })));

      assert.equal(drafts.length, 1, '一条插话 = 一块（分块器按 payload.text 取值）');
      const [chunk] = drafts;
      assert.equal(chunk?.kind, 'human_input');
      assert.match(chunk?.content ?? '', /跳过那个端口/);
      // 唤醒与否只是审计事实，不该改变可检索内容。
      assert.ok(!(chunk?.content ?? '').includes('woke'));
    });
  }

  test('运行中投递与唤醒的载荷只在 woke 上不同（正文都在）', () => {
    const message = '先停一下';
    const delivered = interjectionEventPayload({ message, woke: false });
    const woke = interjectionEventPayload({ message, woke: true });

    assert.equal(delivered.text, message);
    assert.equal(woke.text, message);
    assert.equal('woke' in delivered, false);
    assert.equal(woke.woke, true);
  });
});

describe('Agent 报告：分段落块（设计 §13.4 的对象形状）', () => {
  const report = {
    status: 'report_ready' as const,
    objective: '对 172.17.0.2:8000 做一次被动读取',
    summary: '单次被动 GET 返回 200；正文为目录列表',
    payload: {
      facts: [
        {
          statement: 'GET / 返回 200，Server: SimpleHTTP/0.6',
          confidence: 0.92,
          source_refs: ['tool_run:abc'],
        },
      ],
      hypotheses: [
        {
          statement: '该服务可能暴露了容器根目录',
          confidence: 0.4,
          missing_evidence: ['目录内容全文'],
        },
      ],
      candidate_findings: [
        {
          title: '目录列表暴露',
          severity: 'medium',
          affected_assets: ['asset:x'],
          evidence_refs: ['artifact:xyz'],
          validation_required: true,
        },
      ],
      limitations: ['未跟随重定向'],
    },
  };

  test('摘要/事实/假设/候选结论/限制各自成块，置信度与引用留在文本里', () => {
    const payload = workerReportEventPayload({ reportId: 'r-1', report });
    const drafts = planChunks(sourceEvent('worker.report', payload));
    const kinds = kindsOf(drafts);

    for (const kind of ['report_summary', 'fact', 'hypothesis', 'finding', 'limitation'] as const) {
      assert.ok(kinds.includes(kind), `缺少 ${kind} 分段：${kinds.join(',')}`);
    }

    const fact = drafts.find((draft) => draft.kind === 'fact');
    assert.match(fact?.content ?? '', /GET \/ 返回 200/);
    assert.match(fact?.content ?? '', /置信度 0\.92/);
    assert.match(fact?.content ?? '', /tool_run:abc/);

    const hypothesis = drafts.find((draft) => draft.kind === 'hypothesis');
    assert.match(hypothesis?.content ?? '', /缺失证据: 目录内容全文/);

    const finding = drafts.find((draft) => draft.kind === 'finding');
    assert.match(finding?.content ?? '', /目录列表暴露/);
    assert.match(finding?.content ?? '', /严重度 medium/);
    assert.match(finding?.content ?? '', /artifact:xyz/);
    assert.match(finding?.content ?? '', /受影响: asset:x/, '受影响资产要进分块文本（检索线索）');
  });

  test('检索侧回推分块种类时，分段的**渲染文本**必须包含同段的分块内容', () => {
    // 这条锁的是评审抓到的 Critical：检索侧按「分块内容落在哪个分段的原文里」回推 kind
    // （`deriveChunkKind`），而它此前用的是自己的私有读取器——只读顶层、只认字符串条目。
    // 信封+对象形状的报告于是回推不出分段，全部落到父种类 `report_summary`，
    // 而 `kinds` 是精确过滤：`kinds:['fact']` 取不到刚写进去的事实块。
    // 现在分块器与回推器共用 `reportSectionTexts`，这条断言就是那份共享协议的锁。
    const payload = workerReportEventPayload({
      reportId: 'r-derive',
      report: {
        status: 'report_ready',
        objective: '被动读取',
        summary: 'GET 200',
        payload: {
          facts: [{ statement: 'GET / 返回 200', confidence: 0.9, source_refs: ['tool_run:t'] }],
          hypotheses: [{ statement: '可能暴露目录', confidence: 0.3 }],
          candidate_findings: [{ title: '目录列表暴露', severity: 'medium' }],
          limitations: ['未跟随重定向'],
        },
      },
    });

    const sections = reportSectionTexts(payload);
    const drafts = planChunks(sourceEvent('worker.report', payload));
    assert.ok(drafts.length >= 4, `五类分段里至少四类应成块，实际 ${String(drafts.length)}`);
    for (const draft of drafts) {
      const section = REPORT_SECTIONS.find((candidate) => candidate === draft.part);
      assert.ok(section !== undefined, `分块必须带报告分段名，实际 ${String(draft.part)}`);
      const index = REPORT_SECTIONS.indexOf(section);
      assert.ok(
        (sections[index] ?? '').includes(draft.content),
        `回推文本必须包含 ${String(draft.part)} 分块的内容（否则 kind 回推会落到父种类）`,
      );
    }
  });

  test('分块种类回推吃「账本原样的信封」，每个分段都还原成自己的种类', () => {
    // 这条锁的是**消费端**：控制台与 Worker 两条读路径都把 `context_events.payload_json` 原样
    // 交给共享实现（不预拆信封）。此前两侧各有一份只读顶层的私有副本，于是信封形状的报告
    // 全部回推成父种类 `report_summary`——而 `kinds` 是精确过滤，事实块因此取不到。
    const payload = workerReportEventPayload({
      reportId: 'r-derive-consumer',
      report: {
        status: 'report_ready',
        objective: '被动读取',
        summary: 'GET 200',
        payload: {
          facts: [{ statement: 'GET / 返回 200', confidence: 0.9 }],
          hypotheses: [{ statement: '可能暴露目录', confidence: 0.3 }],
          candidate_findings: [{ title: '目录列表暴露', severity: 'medium' }],
          limitations: ['未跟随重定向'],
        },
      },
    });
    const drafts = planChunks(sourceEvent('worker.report', payload));
    const expected: Readonly<Record<string, string>> = {
      summary: 'report_summary',
      facts: 'fact',
      hypotheses: 'hypothesis',
      findings: 'finding',
      limitations: 'limitation',
    };
    for (const [part, kind] of Object.entries(expected)) {
      const draft = drafts.find((candidate) => candidate.part === part);
      assert.ok(draft !== undefined, `缺少 ${part} 分块`);
      assert.equal(
        deriveChunkKind({
          item_kind: null,
          event_type: 'worker.report',
          content: draft.content,
          report_payload: payload,
        }),
        kind,
        `${part} 必须还原成 ${kind}（落到父种类意味着 kinds 精确过滤取不到它）`,
      );
    }
  });

  test('历史形状（旧模型写出的 {fact,source,confidence} 与未知键）仍然落块——不静默丢弃', () => {
    // 这一坨就是 2026-10-04 实机演练里真实存进账本的形状（当时的工具 schema 是自由 JSON）。
    // 它必须仍能被索引：库里已有的报告不会因为我们改了 schema 就从检索面消失。
    const legacy = workerReportEventPayload({
      reportId: 'r-legacy',
      report: {
        status: 'report_ready',
        objective: '被动读取',
        summary: 'GET 200',
        payload: {
          facts: [{ fact: '响应头 Server: SimpleHTTP/0.6 Python/3.10.21', source: '响应头原文', confidence: 'high' }],
          not_verified: ['未验证路径遍历'],
        },
      },
    });
    const drafts = planChunks(sourceEvent('worker.report', legacy));
    const fact = drafts.find((draft) => draft.kind === 'fact');

    assert.ok(fact !== undefined, '旧形状的 facts 也必须落块');
    assert.match(fact?.content ?? '', /SimpleHTTP\/0\.6/);
    // 旧形状的来源与置信度标签也要带上：它们决定检索时怎么判可信度。
    assert.match(fact?.content ?? '', /响应头原文/);
    assert.match(fact?.content ?? '', /置信度 high/);
  });

  test('空 statement 不吞掉同条目的 fact；findings 与 candidate_findings 同时出现不成块两遍', () => {
    // 两个都是自审抓到的边角：`statement: ''` 若按「有值」处理，条目会被静默丢弃；
    // 别名键同时出现若不去重，同一批候选结论会在检索面存两份。
    const payload = workerReportEventPayload({
      reportId: 'r-edge',
      report: {
        status: 'report_ready',
        objective: 'o',
        summary: 's',
        payload: {
          facts: [{ statement: '', fact: '空 statement 的条目也要落块' }],
          findings: [{ title: '候选结论 A', severity: 'low' }],
          candidate_findings: [{ title: '候选结论 A', severity: 'low' }],
        },
      },
    });
    const drafts = planChunks(sourceEvent('worker.report', payload));

    const fact = drafts.find((draft) => draft.kind === 'fact');
    assert.match(fact?.content ?? '', /空 statement 的条目也要落块/, '空 statement 不得让条目消失');

    const finding = drafts.find((draft) => draft.kind === 'finding');
    const occurrences = (finding?.content.match(/候选结论 A/g) ?? []).length;
    assert.equal(occurrences, 1, '同一分段的两个别名键不得让同一条目成块两遍');
  });
});
