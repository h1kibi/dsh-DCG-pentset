/**
 * 记忆浏览器（§8.3/§8.4/§8.6/§8.7）与 skill 库（§2.2/§6.2.1）的服务端渲染测试。
 *
 * ── 为什么用 `renderToStaticMarkup` ──
 *
 * 视图的契约是「纯函数组件 + 纯 props」：给定同一份 props，渲染出稳定的 HTML。用
 * `renderToStaticMarkup` 断言正好覆盖这条契约，而且不需要 jsdom、不需要事件模拟——
 * 需要交互的部分（表单校验、入参映射、禁用理由）都是导出的纯函数，直接调用更精确。
 *
 * ── react-dom 的类型 ──
 *
 * 本仓装了 `react-dom` 运行时但**没有** `@types/react-dom`，因此不能 `import ... from
 * 'react-dom/server'`（会得到 TS7016）。这里用 `createRequire` 在运行时取模块并做
 * 运行时窄化——不写类型断言，模块形状不符时测试直接失败。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createElement } from 'react';
import type { ReactNode } from 'react';

import type { HostRpcResult } from '../src/console/rpc.ts';
import { ConsoleController } from '../src/client/controller.ts';
import type { ConsoleSnapshot } from '../src/client/controller.ts';
import {
  DEFAULT_MEMORY_LIMIT,
  EMPTY_MEMORY_FORM,
  LedgerVerifyResult,
  MAX_MEMORY_LIMIT,
  MemoryExplorer,
  REASONING_NOTE,
  REASONING_SWITCH_HINT,
  parseIdList,
  parseLimit,
  reasoningNoteOf,
  toSearchParams,
} from '../src/client/views/MemoryExplorer.tsx';
import { trustTone } from '../src/client/format.ts';
import type { IndexWatermarkView, MemoryHitView, MemoryQueryForm } from '../src/client/views/MemoryExplorer.tsx';
import type { LedgerVerificationView } from '../src/contracts.ts';
import {
  EMPTY_SKILL_DRAFT,
  INJECTION_RISK,
  SESSION_ISOLATION,
  SkillEditForm,
  SkillLibrary,
  draftOf,
  skillDraftBlockers,
} from '../src/client/views/SkillLibrary.tsx';
import type { SkillView } from '../src/client/views/SkillLibrary.tsx';

// ───────────────────────── 测试夹具 ─────────────────────────

const FIXED_NOW = new Date('2026-09-19T12:00:00.000Z');

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/** 运行时取 `renderToStaticMarkup`。形状不符即失败——不做「大概是这个形状」的假设。 */
function loadRenderToStaticMarkup(): (node: ReactNode) => string {
  const loaded: unknown = createRequire(import.meta.url)('react-dom/server');
  if (!isRecord(loaded)) throw new Error('react-dom/server 不是对象');
  const candidate: unknown = loaded['renderToStaticMarkup'];
  if (typeof candidate !== 'function') throw new Error('react-dom/server 缺少 renderToStaticMarkup');
  return (node: ReactNode) => String(Reflect.apply(candidate, loaded, [node]));
}

const renderToStaticMarkup = loadRenderToStaticMarkup();

function markup(node: ReactNode): string {
  return renderToStaticMarkup(node);
}

function makeController(): ConsoleController {
  const invoke = async (): Promise<HostRpcResult> => ({ ok: true, value: [] });
  return new ConsoleController({ invoke, clock: () => FIXED_NOW });
}

function makeSnapshot(over: Partial<ConsoleSnapshot> = {}): ConsoleSnapshot {
  return {
    engagements: [],
    selectedEngagementId: 'engagement-1',
    state: null,
    sessions: [],
    loading: false,
    lastError: null,
    conflict: false,
    loadedAt: '2026-09-19T11:59:00.000Z',
    ...over,
  };
}

/**
 * 从宿主信封里取出 `{ method, params }`。
 *
 * 用窄化而不是 `as` 断言：线协议是外部输入，形状不符时要让测试立刻失败，
 * 而不是把未校验的值当已校验的用（断言只会把错误推迟到更难查的地方）。
 */
function requestEnvelopeOf(payload: unknown): { readonly method: string; readonly params: unknown } {
  const request = ((): unknown => {
    if (typeof payload !== 'object' || payload === null || !('args' in payload)) return undefined;
    const args: unknown = payload.args;
    if (typeof args !== 'object' || args === null || !('request' in args)) return undefined;
    return args.request;
  })();
  if (
    typeof request !== 'object' ||
    request === null ||
    !('method' in request) ||
    typeof request.method !== 'string'
  ) {
    throw new Error('宿主信封缺少 args.request.method');
  }
  return { method: request.method, params: 'params' in request ? request.params : undefined };
}

/** 一条思考链命中 + 一条工具观测命中：覆盖 §8.3 的标注与 §8.6 的来源展示。 */
const REASONING_HIT: MemoryHitView = {
  chunkId: 'chunk-reasoning-1',
  kind: 'reasoning',
  excerpt: '先看认证接口的响应差异，再决定是否值得验证。',
  score: 0.0325,
  trustLevel: 'model_reasoning',
  citation: 'memory:chunk-reasoning-1',
  occurredAt: '2026-09-19T11:30:00.000Z',
  reasoningLabel: REASONING_NOTE,
  sourceEventId: 'event-9',
  workerSessionId: 'session-9',
  phase: 'exploitation',
  provisional: false,
  humanAccepted: false,
  routes: ['semantic', 'lexical'],
};

const TOOL_HIT: MemoryHitView = {
  chunkId: 'chunk-tool-1',
  kind: 'tool_observation',
  excerpt: 'nmap 返回 200 OK，服务端头缺失 HSTS。',
  score: 0.0161,
  trustLevel: 'tool_observation',
  citation: 'memory:chunk-tool-1',
  occurredAt: '2026-09-19T11:00:00.000Z',
  sourceEventId: 'event-7',
  workerSessionId: 'session-7',
  phase: 'intelligence-gathering',
  provisional: true,
  routes: ['trigram'],
};

const WATERMARK: IndexWatermarkView = {
  lastChainSeq: 120,
  occurredAt: '2026-09-19T11:45:00.000Z',
  status: 'lagging',
  detail: '索引任务队列积压',
  lagEvents: 12,
};

const SELF_SKILL: SkillView = {
  id: 'skill-1',
  name: 'dns-cert',
  description: 'DNS 与证书查询',
  body: '查询目标域的 DNS 记录与证书链，只做被动读取。',
  contentHash: 'a'.repeat(64),
  addedBy: 'operator-self',
  revision: 1,
  disabled: false,
  createdAt: '2026-09-01T08:00:00.000Z',
  updatedAt: '2026-09-01T08:00:00.000Z',
};

const FOREIGN_SKILL: SkillView = {
  id: 'skill-2',
  name: 'osint-passive',
  description: '公开信息检索',
  body: '按目标组织名检索公开来源，记录来源链接。',
  contentHash: 'b'.repeat(64),
  addedBy: 'operator-other',
  revision: 3,
  disabled: false,
  createdAt: '2026-09-02T08:00:00.000Z',
  updatedAt: '2026-09-03T08:00:00.000Z',
};

// ───────────────────────── §8.7 入参映射（纯函数） ─────────────────────────

test('toSearchParams：默认纳入思考链，空筛选省略而不是传空数组（§8.7）', () => {
  const params = toSearchParams({ ...EMPTY_MEMORY_FORM, query: '  认证接口异常  ' });

  assert.equal(params.query, '认证接口异常');
  assert.equal(params.include_reasoning, true);
  assert.equal(params.phase, undefined);
  assert.equal(params.kinds, undefined);
  assert.equal(params.trust_levels, undefined);
  assert.equal(params.asset_ids, undefined);
  assert.equal(params.limit, DEFAULT_MEMORY_LIMIT);
});

test('toSearchParams：筛选条件按文档字段名传递，资产标识去重（§8.6/§8.7）', () => {
  const form: MemoryQueryForm = {
    ...EMPTY_MEMORY_FORM,
    query: 'HSTS',
    phase: 'intelligence-gathering',
    kinds: ['tool_observation', 'reasoning'],
    trustLevels: ['tool_observation'],
    assetIdsText: 'asset-a, asset-b、asset-a',
    includeReasoning: false,
    limitText: '20',
  };

  const params = toSearchParams(form);

  assert.equal(params.phase, 'intelligence-gathering');
  assert.deepEqual(params.kinds, ['tool_observation', 'reasoning']);
  assert.deepEqual(params.trust_levels, ['tool_observation']);
  assert.deepEqual(params.asset_ids, ['asset-a', 'asset-b']);
  assert.equal(params.include_reasoning, false);
  assert.equal(params.limit, 20);
});

test('parseLimit：非法值回落默认，超过上限被截断；parseIdList 拆分多种分隔符', () => {
  assert.equal(parseLimit('0'), DEFAULT_MEMORY_LIMIT);
  assert.equal(parseLimit('abc'), DEFAULT_MEMORY_LIMIT);
  assert.equal(parseLimit('999'), MAX_MEMORY_LIMIT);
  assert.deepEqual(parseIdList(''), []);
  assert.deepEqual(parseIdList('a;b\nc'), ['a', 'b', 'c']);
});

// ───────────────────────── §8.3 思考链标注 ─────────────────────────

test('reasoningNoteOf：上游漏传标注时，思考链条目仍必须有标注（§8.3）', () => {
  assert.equal(reasoningNoteOf({ ...REASONING_HIT, reasoningLabel: null }), REASONING_NOTE);
  assert.equal(reasoningNoteOf({ ...REASONING_HIT, reasoningLabel: '自定义标注' }), '自定义标注');
  assert.equal(reasoningNoteOf(TOOL_HIT), null);
});

test('渲染思考链条目带「模型内部推理，不等同于事实」标注（§8.3）', () => {
  const html = markup(createElement(MemoryExplorer, {
    controller: makeController(),
    snapshot: makeSnapshot(),
    hits: [REASONING_HIT, TOOL_HIT],
    watermark: WATERMARK,
    now: FIXED_NOW,
  }));

  assert.ok(html.includes(REASONING_NOTE), '思考链标注必须出现在结果里');
  assert.ok(html.includes('思考链'), '记忆类型标签应显示为「思考链」');
  assert.ok(html.includes('工具观测'), '来源可信度用 trustLabel 渲染');
  assert.ok(html.includes('memory:chunk-tool-1'), '引用标识必须展示（§8.6）');
  assert.ok(html.includes('利用验证'), '命中所属阶段用中文阶段名');
  assert.ok(html.includes('暂定'), '暂定分块应被标出（§8.4）');
});

test('include_reasoning 的说明写明「筛选开关，不是权限门禁」（§8.3）', () => {
  const html = markup(createElement(MemoryExplorer, {
    controller: makeController(),
    snapshot: makeSnapshot(),
    hits: [],
    now: FIXED_NOW,
  }));

  assert.ok(html.includes('筛选开关'), '必须说明它是筛选开关');
  assert.ok(html.includes('不是权限门禁'), '必须说明它不是权限门禁');
  assert.ok(html.includes('include_reasoning'), '说明里应带上参数名，避免与权限混淆');
  assert.ok(html.includes(REASONING_SWITCH_HINT), '完整说明必须逐字渲染（思考链对全部 Worker 开放）');
});

// ───────────────────────── 空态与索引水位 ─────────────────────────

test('空数据不崩溃，且区分「尚未检索」与「没有匹配」（§6.2.1）', () => {
  const idle = markup(createElement(MemoryExplorer, {
    controller: makeController(),
    snapshot: makeSnapshot(),
    hits: [],
    now: FIXED_NOW,
  }));
  assert.ok(idle.includes('尚未检索'));

  const searched = markup(createElement(MemoryExplorer, {
    controller: makeController(),
    snapshot: makeSnapshot(),
    hits: [],
    searched: true,
    now: FIXED_NOW,
  }));
  assert.ok(searched.includes('没有匹配的记忆条目'));
  assert.ok(!searched.includes('尚未检索'));
});

test('检索失败时不得显示「没有匹配」：失败与空是两件事（§6.2.1）', () => {
  // 实测踩过：检索被审计闸门拒绝（audit_unavailable，账本锚点不一致）时，
  // 面板同时渲染了错误码与「没有匹配的记忆条目」——那句话说的是「库里没有」，
  // 而事实是「这次根本没查到」。人会据此以为记忆是空的。
  const failed = markup(createElement(MemoryExplorer, {
    controller: makeController(),
    snapshot: makeSnapshot(),
    hits: [],
    searched: true,
    error: { code: 'audit_unavailable', message: '账本事件计数与已锚定计数不一致：检测到尾部截断' },
    now: FIXED_NOW,
  }));
  assert.ok(failed.includes('检索未完成'), '失败要有自己的空态文案');
  assert.ok(failed.includes('audit_unavailable'), '空态要指向错误码');
  assert.ok(!failed.includes('没有匹配的记忆条目'), '失败绝不能被渲染成「没有匹配」');
});

test('检索结果带索引水位与滞后量（§8.4）', () => {
  const html = markup(createElement(MemoryExplorer, {
    controller: makeController(),
    snapshot: makeSnapshot(),
    hits: [TOOL_HIT],
    watermark: WATERMARK,
    searched: true,
    now: FIXED_NOW,
  }));

  assert.ok(html.includes('链序 120'));
  assert.ok(html.includes('滞后 12 条'));
  assert.ok(html.includes('索引滞后'));
});

test('未提供水位时按「不可知」显示，而不是显示为已追平（§8.4）', () => {
  const html = markup(createElement(MemoryExplorer, {
    controller: makeController(),
    snapshot: makeSnapshot(),
    hits: [],
    now: FIXED_NOW,
  }));

  assert.ok(html.includes('无法判断结果是否遗漏了尚未索引的事件'));
});

// ───────────────────────── 账本完整性校验（§8.4 / P7） ─────────────────────────

/** 通过：链自洽 + 已锚定且一致。 */
const LEDGER_OK: LedgerVerificationView = {
  engagementId: 'engagement-1',
  ok: true,
  eventCount: 12,
  chainHead: 'ab'.repeat(32),
  failures: [],
  anchored: true,
  mismatches: [],
  checkedAt: '2026-09-19T11:58:00.000Z',
};

test('账本校验结论：三种失败分开说，通过时不告警（§8.4 / P7）', () => {
  const passed = markup(createElement(LedgerVerifyResult, { result: LEDGER_OK, now: FIXED_NOW }));
  assert.ok(passed.includes('校验通过'));
  assert.ok(!passed.includes('role="alert"'), '通过时不得渲染告警列表');

  const unanchored = markup(createElement(LedgerVerifyResult, {
    result: { ...LEDGER_OK, ok: false, anchored: false },
    now: FIXED_NOW,
  }));
  assert.ok(unanchored.includes('未通过'));
  assert.ok(unanchored.includes('没有锚点可比'), '未锚定必须与链失败区分（未证明≠已证明完好）');
  assert.ok(!unanchored.includes('哈希链校验失败'));

  const tampered = markup(createElement(LedgerVerifyResult, {
    result: {
      ...LEDGER_OK,
      ok: false,
      failures: [{ chainSeq: 7, detail: '前序哈希与重算结果不符' }],
      mismatches: ['chain_head', 'event_count'],
    },
    now: FIXED_NOW,
  }));
  assert.ok(tampered.includes('哈希链校验失败 1 处'));
  assert.ok(tampered.includes('链序 7'));
  assert.ok(tampered.includes('与最近锚点不一致'));
  assert.ok(tampered.includes('chain_head、event_count'));
});

test('记忆浏览器渲染账本校验入口：未选作业时禁用并说明理由', () => {
  const idle = markup(createElement(MemoryExplorer, {
    controller: makeController(),
    snapshot: makeSnapshot({ selectedEngagementId: null }),
    hits: [],
    now: FIXED_NOW,
  }));
  assert.ok(idle.includes('校验账本完整性'), '入口按钮存在');
  assert.ok(idle.includes('尚未选中 engagement'), '禁用时必须说明理由（按钮不说话等于猜）');

  const ready = markup(createElement(MemoryExplorer, {
    controller: makeController(),
    snapshot: makeSnapshot(),
    hits: [],
    now: FIXED_NOW,
  }));
  assert.ok(ready.includes('校验账本完整性'));
  assert.ok(!ready.includes('尚未选中 engagement'), '选中作业后按钮不应再带禁用理由');
});

test('controller.verifyLedger：按方法表发出 verifyLedger 并原样回传结论', async () => {
  const sent: { method: string; params: unknown }[] = [];
  const controller = new ConsoleController({
    clock: () => FIXED_NOW,
    invoke: async (_channel, _endpoint, payload) => {
      const request = requestEnvelopeOf(payload);
      sent.push({ method: request.method, params: request.params });
      return { ok: true, value: LEDGER_OK };
    },
  });

  const result = await controller.verifyLedger('engagement-1');

  assert.deepEqual(result, LEDGER_OK);
  assert.equal(sent.length, 1);
  assert.equal(sent[0]?.method, 'verifyLedger');
  assert.deepEqual(sent[0]?.params, { engagementId: 'engagement-1' });
});

// ───────────────────────── 交互元素与审计（不自动展开） ─────────────────────────

test('渲染存在关键交互元素；未接线时给出缺哪个端点', () => {
  const unconnected = markup(createElement(MemoryExplorer, {
    controller: makeController(),
    snapshot: makeSnapshot(),
    hits: [TOOL_HIT],
    now: FIXED_NOW,
  }));

  assert.ok(unconnected.includes('>检索</button>'), '检索按钮存在');
  assert.ok(unconnected.includes('展开原文'), '展开原文按钮存在');
  assert.ok(unconnected.includes('memory.search'), '缺检索端点时应说明缺的端点名');
  assert.ok(unconnected.includes('memory.read'), '缺读取端点时应说明缺的端点名');

  const connected = markup(createElement(MemoryExplorer, {
    controller: makeController(),
    snapshot: makeSnapshot(),
    hits: [TOOL_HIT],
    onSearch: () => undefined,
    onExpand: () => undefined,
    now: FIXED_NOW,
  }));

  assert.ok(!connected.includes('memory.search'), '接线后不应再出现缺失提示');
});

test('渲染不会自动展开原文：不调用 onExpand，也不取回内容（§8.3 审计）', () => {
  const expanded: string[] = [];
  const html = markup(createElement(MemoryExplorer, {
    controller: makeController(),
    snapshot: makeSnapshot(),
    hits: [REASONING_HIT],
    onExpand: (ref) => {
      expanded.push(ref.memoryId);
    },
    now: FIXED_NOW,
  }));

  assert.deepEqual(expanded, [], '渲染期不得触发读取——否则审计记录的是「谁打开了页面」');
  assert.ok(html.includes('写入访问审计'), '界面要说明展开会写审计');
});

test('调用方回填的原文只在已展开时渲染', () => {
  const html = markup(createElement(MemoryExplorer, {
    controller: makeController(),
    snapshot: makeSnapshot(),
    hits: [TOOL_HIT],
    details: { 'chunk-tool-1': '完整原文：nmap -sV ...' },
    now: FIXED_NOW,
  }));

  assert.ok(html.includes('完整原文：nmap -sV ...'));
});

test('trustTone：外部不可信用危险色，人工决策用完成色（§8.6 只表达证据等级）', () => {
  assert.equal(trustTone('external_untrusted'), 'danger');
  assert.equal(trustTone('human_decision'), 'done');
  assert.equal(trustTone('model_reasoning'), 'attention');
});

// ───────────────────────── Skill 库：三条产品规则（§2.2） ─────────────────────────

test('新增表单写明注入风险，并列出来源与非阶段限制（§2.2）', () => {
  const html = markup(createElement(SkillLibrary, {
    controller: makeController(),
    snapshot: makeSnapshot(),
    skills: [SELF_SKILL, FOREIGN_SKILL],
    operatorId: 'operator-self',
    selection: null,
    onSelectionChange: () => undefined,
    now: FIXED_NOW,
  }));

  assert.ok(html.includes('向 Agent 注入指令'), '注入风险提示必须出现（§2.2）');
  assert.ok(html.includes(INJECTION_RISK));
  assert.ok(html.includes(SESSION_ISOLATION), '会话隔离提示必须出现（§2.2）');
  assert.ok(html.includes('不按阶段硬性限制'), '「任意阶段可装载」必须说明（§2.2）');
  assert.ok(html.includes('他人添加'), '非本人添加的条目要标出来源（§6.2.1）');
});

test('列表展示名称、描述、添加者、添加时间与内容哈希（§6.2.1）', () => {
  const html = markup(createElement(SkillLibrary, {
    controller: makeController(),
    snapshot: makeSnapshot(),
    skills: [SELF_SKILL, FOREIGN_SKILL],
    operatorId: 'operator-self',
    now: FIXED_NOW,
  }));

  assert.ok(html.includes('dns-cert'));
  assert.ok(html.includes('DNS 与证书查询'));
  assert.ok(html.includes('operator-other'));
  assert.ok(html.includes(SELF_SKILL.contentHash), '内容哈希完整值应在提示里可查');
  assert.ok(html.includes('第 3 版'), '编辑过的条目显示修订号');
  assert.ok(html.includes('2026-09-02'), '添加时间按固定时钟渲染');
  assert.ok(html.includes('编辑'), '编辑入口存在');
  assert.ok(html.includes('删除'), '删除入口存在');
  assert.ok(html.split('<tr').length - 1 >= 3, '表格应有表头行 + 两条 skill 行');
});

test('空集是显式选项，且与「尚未决定」区分开（§2.2 可为空 / §7.2）', () => {
  const undecided = markup(createElement(SkillLibrary, {
    controller: makeController(),
    snapshot: makeSnapshot(),
    skills: [SELF_SKILL],
    operatorId: 'operator-self',
    selection: null,
    onSelectionChange: () => undefined,
    now: FIXED_NOW,
  }));

  assert.ok(undecided.includes('不装载任何 skill'), '空集选项必须出现');
  assert.ok(undecided.includes('尚未作出装载选择'), '未决定时必须提示');

  const emptyChoosen = markup(createElement(SkillLibrary, {
    controller: makeController(),
    snapshot: makeSnapshot(),
    skills: [SELF_SKILL],
    operatorId: 'operator-self',
    selection: [],
    onSelectionChange: () => undefined,
    now: FIXED_NOW,
  }));

  assert.ok(emptyChoosen.includes('空集 · 有意'), '有意为空是一种明确状态');
  assert.ok(!emptyChoosen.includes('尚未作出装载选择'));
});

test('未提供 onSelectionChange 时不渲染勾选区（库管理页）', () => {
  const html = markup(createElement(SkillLibrary, {
    controller: makeController(),
    snapshot: makeSnapshot(),
    skills: [SELF_SKILL],
    now: FIXED_NOW,
  }));

  assert.ok(!html.includes('不装载任何 skill'), '库管理页不该出现会话装载选项');
});

test('skill 库为空时渲染空态，并指出空集仍是合法选择（§2.2）', () => {
  const html = markup(createElement(SkillLibrary, {
    controller: makeController(),
    snapshot: makeSnapshot(),
    skills: [],
    operatorId: 'operator-self',
    selection: null,
    onSelectionChange: () => undefined,
    now: FIXED_NOW,
  }));

  assert.ok(html.includes('skill 库为空'));
  assert.ok(html.includes('库里没有可装载的 skill'));
});

test('已停用的条目标为已停用、不可再删除、也不进勾选区', () => {
  const html = markup(createElement(SkillLibrary, {
    controller: makeController(),
    snapshot: makeSnapshot(),
    skills: [{ ...SELF_SKILL, disabled: true }],
    operatorId: 'operator-self',
    selection: [],
    onSelectionChange: () => undefined,
    now: FIXED_NOW,
  }));

  assert.ok(html.includes('已停用'));
  assert.ok(html.includes('库里没有可装载的 skill'));
});

// ───────────────────────── Skill 库：编辑表单（§6.2.1 / §2.2） ─────────────────────────

test('编辑他人添加的条目时提示来源与注入风险（§6.2.1 / §2.2）', () => {
  const foreign = markup(createElement(SkillEditForm, {
    skill: FOREIGN_SKILL,
    operatorId: 'operator-self',
    skills: [SELF_SKILL, FOREIGN_SKILL],
    provided: true,
    now: FIXED_NOW,
  }));

  assert.ok(foreign.includes('你正在编辑 operator-other 添加的条目'));
  assert.ok(foreign.includes(INJECTION_RISK));
  assert.ok(foreign.includes(SESSION_ISOLATION));
  assert.ok(foreign.includes(FOREIGN_SKILL.contentHash.slice(0, 16)), '来源信息含内容哈希');

  const own = markup(createElement(SkillEditForm, {
    skill: SELF_SKILL,
    operatorId: 'operator-self',
    skills: [SELF_SKILL, FOREIGN_SKILL],
    provided: true,
    now: FIXED_NOW,
  }));

  assert.ok(!own.includes('你正在编辑'), '编辑自己的条目不需要来源警告');
});

test('编辑表单未接线时禁用保存并说明缺哪个端点', () => {
  const html = markup(createElement(SkillEditForm, {
    skill: SELF_SKILL,
    operatorId: 'operator-self',
    skills: [SELF_SKILL],
    provided: false,
    now: FIXED_NOW,
  }));

  assert.ok(html.includes('保存修改'));
  assert.ok(html.includes('updateSkill'), '应说明缺的端点名（用方法表里的真实名字）');
  assert.ok(html.includes('取消'));
});

// ───────────────────────── Skill 库：表单闸门（纯函数） ─────────────────────────

test('skillDraftBlockers：三字段必填、名称唯一、缺端点各有理由（§2.2）', () => {
  const empty = skillDraftBlockers({ form: EMPTY_SKILL_DRAFT, skills: [SELF_SKILL], provided: true, method: 'addSkill' });
  assert.equal(empty.length, 3);
  assert.ok(empty[0]?.includes('名称必填'));

  const duplicate = skillDraftBlockers({
    form: { ...draftOf(SELF_SKILL), body: 'x' },
    skills: [SELF_SKILL],
    provided: true,
    method: 'addSkill',
  });
  assert.ok(duplicate.some((blocker) => blocker.includes('名称已存在')));

  const editingSelf = skillDraftBlockers({
    form: draftOf(SELF_SKILL),
    editingSkillId: SELF_SKILL.id,
    skills: [SELF_SKILL],
    provided: true,
    method: 'updateSkill',
  });
  assert.deepEqual(editingSelf, [], '编辑自己的条目且未改名时不应被阻塞');

  const unprovided = skillDraftBlockers({
    form: { name: 'n', description: 'd', body: 'b' },
    skills: [],
    provided: false,
    method: 'addSkill',
  });
  assert.ok(unprovided.includes('控制台方法表未导出 skill 端点 addSkill：改动无法提交'));
});
