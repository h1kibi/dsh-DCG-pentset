/**
 * 报告审阅与导出的渲染测试。
 *
 * 设计依据：docs/dsh-pentest-plugin-design.md §8.9、§6.2.1
 *
 * 用 `renderToStaticMarkup`（不需要 jsdom）：本组视图全是纯 props 函数组件，
 * 服务端渲染能把「渲染出什么」这件事一次问清楚。
 *
 * 重点锁定四条**关于判断**的规则——放在纯函数里才能穷举：
 *   1. §8.9 的四类分节映射（状态优先于处置记录；被取代的不进报告但不隐藏）
 *   2. 拒绝/暂缓**必须填理由**、接受**必须有人工确认的严重度**
 *   3. 未处置条目**阻止签字**（与服务端 `signReport` 同一条前置条件）
 *   4. 报告面端点缺席时必须**显式说明**，不能静默失败或假装已接线
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import type { Finding, MainStatus, ReportDraft } from '../src/contracts.ts';
import { isConsoleMethod } from '../src/console/method-names.ts';
import { ConsoleController } from '../src/client/controller.ts';
import type { ConsoleSnapshot } from '../src/client/controller.ts';
import {
  DISPOSITION_ENDPOINT_EXPORTED,
  DISPOSITION_METHOD_NAME,
  ReportReview,
  countUndisposed,
  dispositionBlockers,
  reviewSectionOf,
} from '../src/client/views/ReportReview.tsx';
import {
  MISSING_CONSOLE_METHODS,
  REPORT_EXPORT_METHOD_NAME,
  REPORT_FACE_METHOD_NAMES,
  ReportExport,
  exportBlockers,
  signBlockers,
} from '../src/client/views/ReportExport.tsx';

// ─────────────── 造数据 ───────────────

/**
 * 真控制器（不是类型断言出来的假货）。
 *
 * `invoke` 一律拒绝：本测试只渲染静态标记，任何真实调用都是 bug，必须响亮失败。
 */
function makeController(): ConsoleController {
  return new ConsoleController({
    invoke: async () => ({
      ok: false,
      error: { code: 'console/internal', message: '测试不发起真实调用', details: {} },
    }),
  });
}

function snapshot(over: Partial<ConsoleSnapshot> = {}): ConsoleSnapshot {
  return {
    engagements: [],
    selectedEngagementId: 'eng-1',
    state: {
      engagementId: 'eng-1',
      mainStatus: 'report_ready',
      runMarker: 'running',
      currentPhase: 'post-exploitation',
      stateVersion: 7,
      graphIteration: 1,
      activeWorkerSessionId: null, scopeVersion: 1, authorizationExpiresAt: null,
    },
    sessions: [],
    loading: false,
    lastError: null,
    conflict: false,
    loadedAt: null,
    ...over,
  };
}

function finding(over: Partial<Finding> & { readonly id: string }): Finding {
  return {
    engagementId: 'eng-1',
    title: '标题',
    severity: 'high',
    status: 'candidate',
    affectedAssetIds: [],
    evidenceRefs: [],
    reproductionSteps: [],
    impact: null,
    remediation: null,
    confidence: null,
    acceptedBy: null,
    acceptedAt: null,
    ...over,
  };
}

const HASH = 'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90';
const DRAFT: ReportDraft = { engagementId: 'eng-1', version: 3, content: '报告正文', contentHash: HASH };

/** 取出某个按钮的完整开标签（`Button` 把 label 直接作为文本子节点）。 */
function buttonMarkup(html: string, label: string): string {
  return new RegExp(`<button[^>]*>${label}</button>`).exec(html)?.[0] ?? '';
}

/** 取开标签里的 title（禁用原因就写在这里）。 */
function titleOf(tag: string): string {
  return /title="([^"]*)"/.exec(tag)?.[1] ?? '';
}

/**
 * 禁用的判据是 HTML 布尔属性 `disabled=""`。
 *
 * 不能拿 `/disabled/` 匹配整个开标签：`Button` 总会渲染 `aria-disabled="false"`，
 * 那种写法会把**可用**的按钮判成禁用——一条永远不会失败的假测试。
 */
function isDisabled(tag: string): boolean {
  return tag.includes('disabled=""');
}

// ─────────────── §8.9 分节映射（纯规则） ───────────────

test('分节：状态优先于处置记录，被取代的不进报告', () => {
  assert.equal(reviewSectionOf('human_accepted', 'defer'), 'verified_findings', '接受是状态事实，之后的处置不改归类');
  assert.equal(reviewSectionOf('rejected', null), 'assessed_not_confirmed');
  assert.equal(reviewSectionOf('candidate', 'defer'), 'unverified_candidates', '暂缓只对候选态生效');
  assert.equal(reviewSectionOf('validated', null), 'awaiting_review');
  assert.equal(reviewSectionOf('superseded', 'defer'), null, '已被取代的不进任何分节');
});

test('未处置计数：暂缓已是一条处置（不阻塞签字），缺投影时保守按未处置算', () => {
  const findings = [
    finding({ id: 'f1', status: 'human_accepted' }),
    finding({ id: 'f2' }),
    finding({ id: 'f3' }),
  ];
  assert.equal(countUndisposed(findings, undefined), 2, '没有处置投影时不能假设已处置');
  assert.equal(countUndisposed(findings, { f2: 'defer' }), 1, '暂缓是已给出的处置');
  assert.equal(countUndisposed(findings, { f2: 'defer', f3: 'reject' }), 0);
});

// ─────────────── 处置闸门（纯规则） ───────────────

test('处置闸门：拒绝/暂缓缺理由被拦，接受缺人工严重度被拦', () => {
  const base = { engagementId: 'eng-1', endpointExported: true, wired: true } as const;
  assert.deepEqual(
    dispositionBlockers({ ...base, action: 'reject', severity: 'high', reason: '  ' }).map((b) => b.code),
    ['reason-required'],
  );
  assert.deepEqual(
    dispositionBlockers({ ...base, action: 'defer', severity: 'high', reason: '等待复现环境' }).map((b) => b.code),
    [],
  );
  assert.deepEqual(
    dispositionBlockers({ ...base, action: 'accept', severity: null, reason: '' }).map((b) => b.code),
    ['severity-required'],
  );
  assert.deepEqual(
    dispositionBlockers({ ...base, action: 'accept', severity: 'medium', reason: '' }).map((b) => b.code),
    [],
    '接受不要求理由，但要求严重度',
  );
});

test('处置闸门：端点缺席与未接线各自报出（不静默失败）', () => {
  const codes = dispositionBlockers({
    action: 'accept',
    severity: 'high',
    reason: '证据充分',
    engagementId: 'eng-1',
    endpointExported: false,
    wired: false,
  }).map((b) => b.code);
  assert.deepEqual(codes, ['endpoint-missing', 'wiring-missing']);
});

test('签字闸门：未处置优先报出；状态不就绪另报（与服务端 signReport 同一条前置条件）', () => {
  assert.deepEqual(
    signBlockers({
      engagementId: 'eng-1',
      mainStatus: 'report_ready',
      draftVersion: 3,
      contentHash: HASH,
      undisposedCount: 2,
    }).map((b) => b.code),
    ['undisposed-findings'],
  );
  assert.deepEqual(
    signBlockers({
      engagementId: 'eng-1',
      mainStatus: 'waiting_human_review',
      draftVersion: 3,
      contentHash: HASH,
      undisposedCount: 0,
    }).map((b) => b.code),
    ['not-report-ready'],
  );
  assert.deepEqual(
    signBlockers({
      engagementId: 'eng-1',
      mainStatus: 'report_ready',
      draftVersion: 3,
      contentHash: null,
      undisposedCount: 0,
    }).map((b) => b.code),
    ['content-hash-missing'],
    '没有内容哈希不能签字：§8.9 的签字以哈希为准',
  );
});

// ─────────────── 端点缺口 ───────────────

test('报告面端点已挂到控制台方法表（视图的运行时探测据此自动接线）', () => {
  // 这条断言原本锁的是「端点缺失」这个事实前提。端点已挂上（RPC 面重构后
  // 报告面成为四个服务面之一），因此反转为「已挂载」——它守住的机制没变：
  // 视图用 `isConsoleMethod` 在**运行时探测**端点是否存在，挂上即自动接线、
  // 不需要改视图代码。这条断言就是那个机制的回归检查。
  assert.equal(REPORT_EXPORT_METHOD_NAME, 'exportReport');
  assert.equal(DISPOSITION_METHOD_NAME, 'dispositionFinding');
  assert.equal(
    DISPOSITION_ENDPOINT_EXPORTED,
    true,
    'dispositionFinding 已挂到方法表——若不成立说明报告面没装配上，视图会再次显示端点缺口',
  );
  // 视图导出的这个常量就是探测结果；它现在应为 true。
  // 不必再单独调 isConsoleMethod——视图已经把结论暴露出来了。
  assert.equal(typeof DISPOSITION_ENDPOINT_EXPORTED, 'boolean');
});

test('报告面端点清单完整且全部已挂载（漏写会让界面漏掉某个端点的接线）', () => {
  // 清单本身由 `satisfies readonly ReportEndpointName[]` 绑到契约上——**写错**（例如
  // 曾经的 `getDraft` 而非 `getReportDraft`）是编译错误。但**漏写**编译器看不出来，
  // 而漏写同样有害：视图会以为报告面少了一个端点，于是显示假的缺口提示。
  //
  // 因此这里同时钉住两件事：条数（= 契约里报告面的端点数）与「每一个都真的在方法表里」。
  assert.equal(
    REPORT_FACE_METHOD_NAMES.length,
    7,
    '报告面端点数变化时必须同步更新视图清单（服务面 7 个：draft/findings/disposition/update/redact/export/undisposed）',
  );
  const notMounted = REPORT_FACE_METHOD_NAMES.filter((name) => !isConsoleMethod(name));
  assert.deepEqual(notMounted, [], `这些报告面端点没挂到控制台方法表：${notMounted.join(', ')}`);
  assert.deepEqual(
    MISSING_CONSOLE_METHODS,
    [],
    '报告面端点全部已挂载——非空会让签字界面显示一句假的「端点缺口」',
  );
});

// ─────────────── 报告审阅：分节渲染 ───────────────

test('报告审阅：四类分节标题恒定出现，条目按 §8.9 归类并计数', () => {
  const html = renderToStaticMarkup(
    createElement(ReportReview, {
      controller: makeController(),
      snapshot: snapshot(),
      findings: [
        finding({ id: 'f1', title: '接受过的结论', status: 'human_accepted', severity: 'critical' }),
        finding({ id: 'f2', title: '被判不成立的结论', status: 'rejected' }),
        finding({ id: 'f3', title: '暂缓的结论', status: 'candidate', severity: 'low' }),
        finding({ id: 'f4', title: '没人处置的结论', status: 'candidate' }),
      ],
      dispositions: { f3: 'defer' },
    }),
  );

  for (const title of ['已验证结论', '已评估但不成立', '未验证候选', '待审阅']) {
    assert.ok(html.includes(`${title}（1）`), `缺少分节或计数错误：${title}`);
  }
  assert.ok(html.includes('接受过的结论'));
  assert.ok(html.includes('没人处置的结论'));
  assert.match(html, /还有 1 条结论从未处置/, '未处置条目数必须显式呈现（§8.9 的签字前置条件）');
});

test('报告审阅：已被取代的结论不进分节，但计数可见（不隐藏）', () => {
  const html = renderToStaticMarkup(
    createElement(ReportReview, {
      controller: makeController(),
      snapshot: snapshot(),
      findings: [
        finding({ id: 'gone', title: '被推翻的旧结论', status: 'superseded' }),
        finding({ id: 'live', title: '仍然有效的结论', status: 'candidate' }),
      ],
    }),
  );
  assert.ok(html.includes('另有 1 条结论已被取代'));
  assert.ok(!html.includes('被推翻的旧结论'), '已被取代的不进报告分节');
});

test('报告审阅：已接受/已拒绝的结论不显示「从未处置」（状态就是处置事实）', () => {
  const html = renderToStaticMarkup(
    createElement(ReportReview, {
      controller: makeController(),
      snapshot: snapshot(),
      findings: [
        finding({ id: 'f1', title: '已接受的结论', status: 'human_accepted' }),
        finding({ id: 'f2', title: '已拒绝的结论', status: 'rejected' }),
      ],
    }),
  );
  assert.ok(html.includes('已接受'), '接受过的结论不能被标成未处置');
  assert.ok(html.includes('已拒绝'));
  assert.ok(!html.includes('从未处置'), '没有候选态条目时不该出现「从未处置」');
  assert.ok(!html.includes('条结论从未处置'), '也不该显示签字阻断');
});

test('报告审阅：空列表显示空态而不崩溃', () => {
  const html = renderToStaticMarkup(
    createElement(ReportReview, { controller: makeController(), snapshot: snapshot(), findings: [] }),
  );
  assert.ok(html.includes('还没有任何结论'));
  assert.ok(html.includes('本节暂无结论'), '四个分节各自给出空态');
  assert.ok(!html.includes('条结论从未处置'), '没有未处置条目时不得显示签字阻断');
});

// ─────────────── 报告审阅：处置按钮 ───────────────

test('报告审阅：拒绝与暂缓缺理由时按钮禁用并写明原因（§8.9）', () => {
  const html = renderToStaticMarkup(
    createElement(ReportReview, {
      controller: makeController(),
      snapshot: snapshot(),
      findings: [finding({ id: 'f1', severity: null })],
      endpointExported: true,
      onDispose: () => undefined,
    }),
  );

  const reject = buttonMarkup(html, '拒绝');
  assert.ok(isDisabled(reject), '拒绝缺理由必须禁用');
  assert.match(titleOf(reject), /必须填写理由/, '禁用必须说明为什么');

  const defer = buttonMarkup(html, '暂缓');
  assert.ok(isDisabled(defer), '暂缓同样要求理由');
  assert.match(titleOf(defer), /必须填写理由/);

  const accept = buttonMarkup(html, '接受');
  assert.match(titleOf(accept), /严重度需人工确认/, '严重度为空的结论不能接受（§8.9 严重度由人确认）');
});

test('报告审阅：严重度已人工确认且已接线时，接受按钮可用（闸门不是恒禁用）', () => {
  const html = renderToStaticMarkup(
    createElement(ReportReview, {
      controller: makeController(),
      snapshot: snapshot(),
      findings: [finding({ id: 'f1', severity: 'high' })],
      endpointExported: true,
      onDispose: () => undefined,
    }),
  );
  assert.ok(!isDisabled(buttonMarkup(html, '接受')));
  assert.ok(isDisabled(buttonMarkup(html, '拒绝')), '同一行里拒绝仍需理由');
});

test('报告审阅：端点已挂载 + 回调已接入时，按钮按规则可用', () => {
  // 两个条件**都要满足**，这是视图刻意的两层设计：
  //   - 端点是否挂载（运行时探测）→ 决定是否显示「端点缺口」说明
  //   - 调用方是否接入回调 → 决定按钮是否可点
  // 只满足前者时按钮仍禁用：端点存在不等于「这次点击有人接」。
  // 断言缺口说明消失与按钮可用，是为了守住这两层不互相冒充。
  const html = renderToStaticMarkup(
    createElement(ReportReview, {
      controller: makeController(),
      snapshot: snapshot(),
      findings: [finding({ id: 'f1', severity: 'high' })],
      onDispose: () => {},
    }),
  );
  assert.equal(
    html.includes('console/method-unavailable'),
    false,
    '端点已挂载，不该再渲染缺口说明',
  );
  // 严重度已给定时「接受」可用；拒绝与暂缓仍需理由
  assert.ok(!isDisabled(buttonMarkup(html, '接受')));
  assert.ok(isDisabled(buttonMarkup(html, '拒绝')), '拒绝必须填理由');
  assert.ok(isDisabled(buttonMarkup(html, '暂缓')), '暂缓必须填理由');
});

test('报告审阅：版本冲突与错误各自呈现（§15.4）', () => {
  const html = renderToStaticMarkup(
    createElement(ReportReview, {
      controller: makeController(),
      snapshot: snapshot({ conflict: true, lastError: { code: 'stale_state_version', message: '版本已变' } }),
      findings: [],
    }),
  );
  assert.ok(html.includes('stale_state_version'));
  assert.ok(html.includes('另一个界面先提交了'));
});

// ─────────────── 报告导出：签字与导出 ───────────────

test('报告导出：未处置条目 > 0 时签字禁用，并写明剩余数量（§8.9 硬前置条件）', () => {
  const html = renderToStaticMarkup(
    createElement(ReportExport, {
      controller: makeController(),
      snapshot: snapshot(),
      draft: DRAFT,
      undisposedCount: 2,
      contentHash: HASH,
    }),
  );

  const sign = buttonMarkup(html, '签字');
  assert.ok(isDisabled(sign));
  assert.match(titleOf(sign), /未处置/);
  assert.ok(html.includes('data-blocker="undisposed-findings"'), '阻断必须作为清单项出现');
  assert.match(html, /还有 2 条结论未处置/);
});

test('报告导出：未处置为 0 且状态为报告就绪时签字按钮可用', () => {
  const html = renderToStaticMarkup(
    createElement(ReportExport, {
      controller: makeController(),
      snapshot: snapshot(),
      draft: DRAFT,
      undisposedCount: 0,
      contentHash: HASH,
    }),
  );
  assert.ok(!isDisabled(buttonMarkup(html, '签字')));
});

test('报告导出：状态未就绪或没有哈希时签字禁用并说明原因', () => {
  const notReady = renderToStaticMarkup(
    createElement(ReportExport, {
      controller: makeController(),
      snapshot: snapshot({
        state: {
          engagementId: 'eng-1',
          mainStatus: 'waiting_human_review' as MainStatus,
          runMarker: 'running',
          currentPhase: 'post-exploitation',
          stateVersion: 7,
          graphIteration: 1,
          activeWorkerSessionId: null, scopeVersion: 1, authorizationExpiresAt: null,
        },
      }),
      draft: DRAFT,
      undisposedCount: 0,
      contentHash: HASH,
    }),
  );
  assert.ok(notReady.includes('data-blocker="not-report-ready"'));
  assert.match(titleOf(buttonMarkup(notReady, '签字')), /报告就绪/);

  const noHash = renderToStaticMarkup(
    createElement(ReportExport, {
      controller: makeController(),
      snapshot: snapshot(),
      draft: DRAFT,
      undisposedCount: 0,
    }),
  );
  assert.ok(noHash.includes('data-blocker="content-hash-missing"'));
});

test('报告导出：显示报告版本、内容哈希与需人工注意的限制项', () => {
  const html = renderToStaticMarkup(
    createElement(ReportExport, {
      controller: makeController(),
      snapshot: snapshot(),
      draft: DRAFT,
      undisposedCount: 0,
      contentHash: HASH,
      limitations: ['未覆盖内网 10.0.0.0/8', '凭据仅验证了只读权限'],
    }),
  );
  assert.ok(html.includes('v3'), '报告版本必须显示');
  assert.ok(html.includes(HASH.slice(0, 16)), '内容哈希按前缀显示，完整值在 title 上');
  assert.ok(html.includes(HASH), '完整哈希出现在 title（签字绑定到它）');
  assert.ok(html.includes('未覆盖内网 10.0.0.0/8'));
  assert.ok(html.includes('凭据仅验证了只读权限'));
});

test('报告导出：没有限制项时给出警示性空态（空 ≠ 没有限制）', () => {
  const html = renderToStaticMarkup(
    createElement(ReportExport, {
      controller: makeController(),
      snapshot: snapshot(),
      draft: DRAFT,
      undisposedCount: 0,
      contentHash: HASH,
    }),
  );
  assert.ok(html.includes('未标注限制项'));
  assert.ok(html.includes('这不等于没有限制'));
});

test('报告导出：没有草稿时不崩溃，并说明缺什么', () => {
  const html = renderToStaticMarkup(
    createElement(ReportExport, {
      controller: makeController(),
      snapshot: snapshot(),
      draft: null,
      undisposedCount: 0,
      contentHash: null,
    }),
  );
  assert.ok(html.includes('data-blocker="draft-missing"'));
  assert.ok(html.includes('finishTechnicalTesting'), '缺口说明点名生成草稿的端点');
});

test('报告导出：端点缺席时导出按钮禁用并点名端点，接线后可用', () => {
  // 用**显式的 `endpointExported: false`** 表达「端点缺席」，而不是依赖
  // `REPORT_EXPORT_ENDPOINT_EXPORTED` 的全局求值结果。此前它依赖后者，
  // 于是这条测试实际在断言「报告面有端点没挂」这个**当时为假**的全局状态——
  // 一旦清单修好（`getDraft` → `getReportDraft`），它就开始失败。
  // 组件契约（缺席则禁用并点名）才是这条测试该锁的东西。
  const blocked = renderToStaticMarkup(
    createElement(ReportExport, {
      controller: makeController(),
      snapshot: snapshot(),
      draft: DRAFT,
      undisposedCount: 0,
      contentHash: HASH,
      endpointExported: false,
    }),
  );
  assert.ok(isDisabled(buttonMarkup(blocked, '导出 Markdown')));
  assert.ok(blocked.includes('console/method-unavailable'));
  assert.ok(blocked.includes(REPORT_EXPORT_METHOD_NAME), '缺口说明必须点名端点');

  const wired = renderToStaticMarkup(
    createElement(ReportExport, {
      controller: makeController(),
      snapshot: snapshot(),
      draft: DRAFT,
      undisposedCount: 0,
      contentHash: HASH,
      endpointExported: true,
      onExport: () => undefined,
    }),
  );
  assert.ok(!isDisabled(buttonMarkup(wired, '导出 Markdown')));
  assert.ok(!isDisabled(buttonMarkup(wired, '导出 JSON')));
  assert.deepEqual(exportBlockers({ engagementId: 'eng-1', endpointExported: true, wired: true }), []);
  assert.deepEqual(
    exportBlockers({ engagementId: 'eng-1', endpointExported: true, wired: false }).map((b) => b.code),
    ['wiring-missing'],
  );
});

test('报告导出：签字状态只从 Host 事实派生，草稿正文里的模型「批准」措辞不算数', () => {
  const draft: ReportDraft = {
    engagementId: 'eng-1',
    version: 3,
    content: '本报告已由模型批准（approved），无需人工签字',
    contentHash: HASH,
  };
  const html = renderToStaticMarkup(
    createElement(ReportExport, {
      controller: makeController(),
      snapshot: snapshot(),
      draft,
      undisposedCount: 0,
      contentHash: HASH,
    }),
  );
  assert.ok(!html.includes('approved'), '模型措辞不得进入界面状态');
  assert.ok(!html.includes('已由模型批准'));
  assert.ok(!html.includes('报告已签字'), '没有 Host 的 complete 状态就不能显示已签字');
  assert.ok(
    !isDisabled(buttonMarkup(html, '签字')),
    '模型措辞不改变签字闸门：前置条件都满足时按钮就该可点，由人类决定',
  );

  const complete = renderToStaticMarkup(
    createElement(ReportExport, {
      controller: makeController(),
      snapshot: snapshot({
        state: {
          engagementId: 'eng-1',
          mainStatus: 'complete',
          runMarker: 'running',
          currentPhase: 'post-exploitation',
          stateVersion: 9,
          graphIteration: 1,
          activeWorkerSessionId: null, scopeVersion: 1, authorizationExpiresAt: null,
        },
      }),
      draft,
      undisposedCount: 0,
      contentHash: HASH,
    }),
  );
  assert.ok(complete.includes('报告已签字'));
  assert.match(titleOf(buttonMarkup(complete, '签字')), /已签字/);
});
