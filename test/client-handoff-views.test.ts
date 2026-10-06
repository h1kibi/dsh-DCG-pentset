/**
 * 交接编辑、engagement 列表与授权向导的渲染契约测试。
 *
 * 锁定的是**四类关于「人类看到了什么」的规则**，它们决定人类能否看出自己确认了什么：
 *
 *   1. **强制跳转是双条件闸门**（§5.3）：缺理由禁用，未二次确认也禁用——两条都要单独成立，
 *      因为它们是两个独立的误点风险（手滑点了强制入口 / 没看被跳过的阶段）。
 *   2. **内容哈希必须显示**（§6.5 第 6 块）：确认前人类要能看到自己确认的那份内容。
 *   3. **两种空态不能合并**（§6.2）：还没有 engagement / 筛选后没有匹配，下一步动作完全不同。
 *   4. **向导只建立授权与范围**（§1.2）：缺名称 / 授权依据 / 目标时禁用并说明；且必须写明
 *      它不会创建任何 Agent。
 *
 * 渲染用 `renderToStaticMarkup`，不需要 jsdom。控制器传的是**渲染期拒绝被调用**的桩：
 * 视图必须纯 props——若哪个视图在渲染里发请求，测试会直接失败而不是静默通过。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { ConsoleController } from '../src/client/controller.ts';
import type { ConsoleControllerDeps } from '../src/client/controller.ts';
import { EngagementList, engagementActionAvailability } from '../src/client/views/EngagementList.tsx';
import { EngagementWizard } from '../src/client/views/EngagementWizard.tsx';
import { HandoffEditor } from '../src/client/views/HandoffEditor.tsx';
import type { EngagementSummary, HandoffDraft } from '../src/contracts.ts';

const NOW = new Date('2026-09-19T12:00:00Z');

// ───────────────────────────── 骨架 ─────────────────────────────

/**
 * 渲染期拒绝被调用的控制器桩。
 *
 * 视图在渲染阶段**不应**与 Host 通信（数据全部走 props）。桩抛错而不是返回空结果，
 * 是为了让「在渲染里偷偷发请求」这种错误立刻暴露，而不是变成一个空界面。
 */
function inertController(): ConsoleController {
  const invoke: ConsoleControllerDeps['invoke'] = async () => {
    throw new Error('视图在渲染阶段不应调用 Host（数据必须经 props 传入，§6.2.3）');
  };
  return new ConsoleController({ invoke, clock: () => NOW });
}

/** 取某个标签对应的 `<button>` 起始标签文本，供断言 `disabled` 与 `title`。 */
function buttonTag(html: string, label: string): string {
  const match = new RegExp(`<button[^>]*>${label}</button>`).exec(html);
  assert.ok(match !== null, `未找到按钮「${label}」`);
  return match[0];
}

/**
 * 断言按钮被禁用且禁用原因里包含给定片段。
 *
 * 认 `disabled` 属性而不是 `is-disabled` 类名：属性才是「点不动」这件事本身，
 * 类名只是样式。`title` 的检查对应 §6.2.3「闸门要可见」——禁用的按钮必须说明原因。
 */
function assertDisabled(html: string, label: string, reasonFragment: string): void {
  const tag = buttonTag(html, label);
  assert.ok(tag.includes('disabled=""'), `按钮「${label}」应被禁用：${tag}`);
  assert.ok(tag.includes(reasonFragment), `按钮「${label}」的禁用原因应含「${reasonFragment}」：${tag}`);
}

// ───────────────────────────── 夹具 ─────────────────────────────

function engagement(over: Partial<EngagementSummary> = {}): EngagementSummary {
  return {
    id: 'e1',
    name: '内部靶场 A 轮',
    runMarker: 'paused',
    mainStatus: 'waiting_human_review',
    currentPhase: 'exploitation',
    stateVersion: 7,
    graphIteration: 2,
    activeWorkerSessionId: null,
    scopeEntryProfile: 'custom',
    behaviorProfile: 'stealth',
    approvalMode: 'human',
    policyVersion: 1,
    policySnapshotHash: 'sha256:test',
    createdAt: '2026-09-18T09:00:00Z',
    updatedAt: '2026-09-19T11:30:00Z',
    ...over,
  };
}

function draft(over: Partial<HandoffDraft> = {}): HandoffDraft {
  return {
    draftId: 'draft-1',
    fromWorkerSessionId: 'session-1',
    fromPhase: 'intelligence-gathering',
    suggestedToPhase: 'threat-modeling',
    objective: '为内部靶场建立信任边界与攻击路径',
    prompt: '基于资产清单构建攻击路径，标注假设与优先级',
    suggestedSkillIds: ['asset-graph', 'attack-path'],
    contextRefs: [{ memoryId: 'memory:aaa', reason: '资产清单' }],
    excludedRefs: ['memory:bbb'],
    toolCapabilitySuggestion: {
      allowed: ['memory_search', 'pentest_exec:http_read'],
      approvalRequired: ['active_probing'],
    },
    limitations: ['未验证：边界防火墙的默认拒绝规则'],
    revision: 2,
    contentHash: 'f'.repeat(64),
    ...over,
  };
}

// ───────────────────────────── engagement 列表（§6.1、§6.2） ─────────────────────────────

test('列表渲染名称、运行标记、主状态、阶段、迭代与状态版本', () => {
  const html = renderToStaticMarkup(
    createElement(EngagementList, {
      engagements: [engagement()],
      selectedId: 'e1',
      onSelect: () => undefined,
      controller: inertController(),
      now: NOW,
    }),
  );

  assert.ok(html.includes('内部靶场 A 轮'), '应显示 engagement 名称');
  assert.ok(html.includes('已暂停'), '运行标记应本地化显示');
  assert.ok(html.includes('等待你判断'), '主状态应显示为动作提示');
  assert.ok(html.includes('利用验证'), '当前阶段应中文化');
  assert.ok(html.includes('迭代') && html.includes('状态版本'), '应列出迭代与状态版本两列');
  // 迭代次数与状态版本是列表的核心数字：前者说明攻击深度，后者是乐观锁的比对基准
  assert.ok(/<td[^>]*>2<\/td>/.test(html), '应显示迭代次数（graphIteration=2）');
  assert.ok(/<td[^>]*>7<\/td>/.test(html), '应显示状态版本（stateVersion=7）');
  assert.ok(/<tr[^>]*>[\s\S]*?<\/tr>/.test(html), '应渲染表格行');
  // 每行要有选择入口，且必须可点（选择是控制台的第一步，禁用它会让整个界面失去入口）
  const select = buttonTag(html, '内部靶场 A 轮');
  assert.ok(select.includes('aria-disabled="false"'), `选择按钮必须可点：${select}`);
});

test('库为空时区分「还没有 engagement」而不是筛选无匹配', () => {
  const html = renderToStaticMarkup(
    createElement(EngagementList, { engagements: [], onSelect: () => undefined, controller: inertController() }),
  );
  assert.ok(html.includes('还没有 engagement'), '应显示首屏空态');
  assert.ok(!html.includes('筛选后没有匹配'), '库为空不是筛选问题');
});

test('筛选无匹配时给出的是筛选空态，并回显总数与筛选值', () => {
  const html = renderToStaticMarkup(
    createElement(EngagementList, {
      engagements: [engagement(), engagement({ id: 'e2', name: '实验室 B' })],
      onSelect: () => undefined,
      controller: inertController(),
      now: NOW,
      filter: '不存在的靶场',
      onFilterChange: () => undefined,
    }),
  );
  assert.ok(html.includes('筛选后没有匹配'), '应显示筛选空态');
  assert.ok(!html.includes('还没有 engagement'), '库里有数据，不是首屏空态');
  assert.ok(html.includes('共 2 个'), '应回显库内总数');
  assert.ok(html.includes('不存在的靶场'), '应回显当前筛选值');
});

test('重读中且尚无数据时不冒充空库', () => {
  const html = renderToStaticMarkup(
    createElement(EngagementList, { engagements: [], onSelect: () => undefined, loading: true, controller: inertController() }),
  );
  assert.ok(html.includes('正在读取 engagement 列表'), '应显示加载态');
  assert.ok(!html.includes('还没有 engagement'), '加载中不能断言库里没有数据');
});

// ───────────────────────────── 授权向导（§11.1、§13.1） ─────────────────────────────

test('向导默认态：只缺名称与目标——授权依据与到期时间不再是闸门', () => {
  const html = renderToStaticMarkup(createElement(EngagementWizard, { controller: inertController(), now: NOW }));

  // 必填项从七项降到两项。授权依据只进档案、到期时间留空即「不作限制」，
  // 都不该挡住「自己给自己开个作业」。
  assertDisabled(html, '确认并建立 engagement', '必须填写名称');
  const tag = buttonTag(html, '确认并建立 engagement');
  assert.ok(tag.includes('至少需要一个授权目标'), '缺目标应在禁用原因里');
  assert.equal(tag.includes('授权依据引用'), false, '授权依据不再是闸门');
  assert.equal(tag.includes('授权到期时间'), false, '授权到期时间不再是闸门');

  // §1.2：向导不创建 Agent，必须在确认之前说明
  assert.ok(html.includes('不会创建任何 Agent'), '应提示向导不创建 Agent');
  assert.ok(html.includes('还没有目标条目'), '目标预览应给空态');

  // 简化后的可见性：首屏只有必填项，高级项收在折叠区里。
  assert.ok(html.includes('公共记忆'), '公共记忆应在首屏可填');
  assert.ok(html.includes('高级选项'), '高级区标题应在');
  assert.ok(html.includes('aria-expanded="false"'), '高级区默认收起（首屏字段从 13 个降到 3 个）');
});

test('向导：全端口是**界面上可见的选项**，不是靠知道 0-65535 这个写法', () => {
  // 「任意端口」在契约里是 `ANY_PORT`（0-65535），而设计文档 §10.2.2 明确要求它
  // 「作为**人类可见的显式选项**存在」。此前它只能通过在端口框里手写 `0-65535`
  // 表达，而那个框的提示里一个字都没提——实际上是一个「会用的人才会用」的隐藏约定。
  const html = renderToStaticMarkup(
    createElement(EngagementWizard, { controller: inertController(), now: NOW }),
  );
  assert.ok(html.includes('任意端口'), '必须有可见的「任意端口」入口');
  assert.ok(html.includes('pentest-wizard__anyport'), '它要有自己的可点元素，而不是只写在提示文字里');
  // 提示里也要说清「留空 = 默认 80/443」——两者是不同的事，不能混。
  assert.ok(html.includes('留空即默认 80/443'), '留空的语义必须写出来，否则会被当成「没有限制」');
});

test('向导：补齐字段后仅剩「已核对」这一项闸门', () => {
  const html = renderToStaticMarkup(
    createElement(EngagementWizard, {
      controller: inertController(),
      now: NOW,
      defaults: {
        name: '内部靶场 A 轮',
        authorizationRef: 'SOW-2026-014 §3.2',
        authorizationExpiresAt: '2026-12-31T00:00',
        // 行为预设与审批模式都是必选项：部署级默认值预选它们，闸门因此只剩「已核对」。
        behaviorProfile: 'stealth',
        approvalMode: 'human',
        targets: [{ kind: 'domain', value: 'lab.example.com', protocols: ['tcp'], ports: [] }],
      },
      // 服务端的预校验结论（`previewScope` 端点返回）。
      // 视图**不自己算**规范化——范围规范化是安全边界，只有服务端一份实现。
      scopePreview: {
        targets: [{
          index: 0, kind: 'domain', canonical: 'domain:lab.example.com',
          protocols: ['tcp'], portSummary: '默认 80/443', rejectionCode: null, detail: null,
        }],
        exclusions: [],
        ok: true,
      },
    }),
  );

  // 规范化结果来自服务端结论（域名条目无端口 → 默认 80/443，§10.2.2）
  assert.ok(html.includes('domain:lab.example.com'), '应显示服务端规范化后的稳定键');
  assert.ok(html.includes('默认端口 80/443'), '留空端口的语义必须写出来');
  assert.ok(!html.includes('必须填写名称'), '名称已填，闸门应消失');
  assert.ok(!html.includes('至少需要一个授权目标'), '目标已填，闸门应消失');
  // 只剩「人类确认」这一条：闸门确实由数据驱动，而不是写死的永远禁用
  const gates = html.match(/<ul class="pentest-wizard__gates">[\s\S]*?<\/ul>/);
  assert.notEqual(gates, null, '应渲染闸门列表');
  assert.equal((gates?.[0].match(/<li>/g) ?? []).length, 1, '补齐后应只剩一条闸门');
  assert.ok(gates?.[0].includes('核对'), '剩下的那条应是「已核对范围与限制」（§13.1）');
  assertDisabled(html, '确认并建立 engagement', '核对');
});

test('向导：过期授权被拦下，且未声明协议按服务端同一码拒绝', () => {
  const expired = renderToStaticMarkup(
    createElement(EngagementWizard, {
      controller: inertController(),
      now: NOW,
      defaults: {
        name: '内部靶场 B 轮',
        authorizationRef: 'SOW-2026-015',
        authorizationExpiresAt: '2026-09-01T00:00',
        targets: [{ kind: 'domain', value: 'lab.example.com', protocols: ['tcp'], ports: [] }],
      },
    }),
  );
  // 「填了就必须合法」——留空表示不作限制，但填了一个过去的时间会让作业刚建好就动不了。
  assertDisabled(expired, '确认并建立 engagement', '已过去');

  // 「网段缺端口」不再是拒绝理由（见 scope.test.ts 的 F1：留空 = 默认 80/443，
  // 对所有类型一致）。这里改用另一个**真实存在**的范围拒绝码来验证同一件事：
  // 「视图只显示服务端给的拒绝码，自己不算」——范围规范化只有服务端一份实现。
  const bad = renderToStaticMarkup(
    createElement(EngagementWizard, {
      controller: inertController(),
      now: NOW,
      defaults: {
        name: '内部靶场 C 轮',
        authorizationRef: 'SOW-2026-016',
        authorizationExpiresAt: '2026-12-31T00:00',
        targets: [{ kind: 'cidr', value: '10.20.3.0/24', protocols: [], ports: [] }],
      },
      scopePreview: {
        targets: [{
          index: 0, kind: 'cidr', canonical: null, protocols: [],
          portSummary: '默认 80/443',
          rejectionCode: 'protocol_undetermined',
          detail: '无法确定协议（§10.2.2）',
        }],
        exclusions: [],
        ok: false,
      },
    }),
  );
  assert.ok(bad.includes('protocol_undetermined'), '应原样显示服务端的拒绝码');
  assertDisabled(bad, '确认并建立 engagement', '范围校验');
});

// ───────────────────────────── 交接编辑（§6.5、§7.4） ─────────────────────────────

test('交接编辑器只保留两段文字与确认/取消：能力面与引用编辑不再呈现', () => {
  // 2026-10-07 操作者裁定：本屏只做两件事——改要注入下一阶段的两段文字、确认或取消。
  // skill 勾选、工具允许列表、逐次放行类别、上下文引用编辑全部撤下，取值在确认时原样取自草稿。
  const html = renderToStaticMarkup(
    createElement(HandoffEditor, {
      controller: inertController(),
      engagementId: 'e1',
      draft: draft(),
      contentHash: 'sha256:9f2c1d',
    }),
  );

  assert.ok(html.includes('阶段交接'), '标题应说明这是阶段交接');
  assert.ok(html.includes('为内部靶场建立信任边界与攻击路径'), '任务目标以初值呈现且可编辑');
  assert.ok(html.includes('基于资产清单构建攻击路径'), '提示词以初值呈现且可编辑');
  // §6.5 第 6 块：内容哈希
  assert.ok(html.includes('sha256:9f2c1d'), '应显示服务端给出的内容哈希');
  assert.ok(
    html.includes('title="sha256:9f2c1d"'),
    '完整哈希放在 title 上（前缀显示、全文可核对，与报告导出页同一约定）',
  );
  // §7.4：新会话的上下文隔离
  assert.ok(html.includes('不继承旧对话'), '应提示不继承旧对话');

  // 撤下的编辑器不得以任何形式留在 HTML 里——旧控件的取值（skill、工具、引用）与
  // 旧控件标签都算。夹具已带这些值，因此这是一条有效的反向断言。
  const gone = [
    'memory_search',
    'asset-graph',
    'memory:aaa',
    'skill 勾选',
    '工具允许列表',
    '需逐次放行的动作类别',
    '展开原文',
    '引用预算提醒',
    '手动添加工具',
    '新增引用',
  ];
  for (const word of gone) {
    assert.equal(html.includes(word), false, `不该再出现「${word}」`);
  }
});

test('交接编辑器：没有哈希预览值时如实说明，不伪造', () => {
  // 草稿哈希现在由读端点带回（REQ-9：`currentHandoffDraft` → `HandoffDraft.contentHash`），
  // 因此「缺哈希」只可能意味着调用方没把读端点的结果传进来。这一支要说清这一点，
  // 并且**绝不**自己拼一个像哈希的字符串。
  const html = renderToStaticMarkup(
    createElement(HandoffEditor, {
      controller: inertController(),
      engagementId: 'e1',
      draft: draft(),
    }),
  );
  assert.ok(html.includes('内容哈希不可用'), '缺哈希预览值时要如实说明');
  assert.ok(!html.includes('sha256:'), '不得编造一个像哈希的字符串');
});

test('交接编辑器：理由**不是**闸门——不填也能确认（人类动作不要求理由）', () => {
  // 2026-10-05 人类明确要求：别再在确认前逼人填理由。操作者与时间照记进人工决策与审计，
  // 理由降级为可选备注——所以两个按钮都必须**可点**（本屏没有理由输入框，闸门只来自阶段推进）。
  const html = renderToStaticMarkup(
    createElement(HandoffEditor, {
      controller: inertController(),
      engagementId: 'e1',
      draft: draft({ suggestedSkillIds: ['asset-graph'], toolCapabilitySuggestion: { allowed: ['memory_search'], approvalRequired: ['active_probing'] } }),
    }),
  );
  assert.equal(buttonTag(html, '确认并创建会话').includes('disabled=""'), false, '不填理由也要能确认');
  assert.equal(buttonTag(html, '取消').includes('disabled=""'), false, '取消更不该要求理由');
  assert.ok(!html.includes('保存为草稿版本'), '不该再有「另存草稿」这一步');
  assert.ok(!html.includes('必须填写切换理由'), '不该再有理由闸门');
});

test('交接编辑器：回环未完成范围修订时确认禁用（§5.4 步骤 4）', () => {
  const html = renderToStaticMarkup(
    createElement(HandoffEditor, {
      controller: inertController(),
      engagementId: 'e1',
      draft: draft({ fromPhase: 'post-exploitation', suggestedToPhase: 'intelligence-gathering' }),
      scopeAmendment: { completed: false, newVersion: null },
    }),
  );
  assertDisabled(html, '确认并创建会话', '范围修订');
});

// ───────────────────────────── 强制跳转确认块（§5.3 条件 2、3） ─────────────────────────────

test('向导：未做过服务端校验时，提交被拦且提示去点「校验范围」', () => {
  // 这是「范围校验走服务端端点」的直接后果：未校验就不能提交。
  // 它符合 §13.1（服务端规范化并校验 → 展示 → 人类确认才提交），
  // 而且避免人类填完整张表才被打回。
  const html = renderToStaticMarkup(
    createElement(EngagementWizard, {
      controller: inertController(),
      now: NOW,
      defaults: {
        name: '内部靶场 A 轮',
        authorizationRef: 'SOW-2026-014 §3.2',
        authorizationExpiresAt: '2026-12-31T00:00',
        targets: [{ kind: 'domain', value: 'lab.example.com', protocols: ['tcp'], ports: [] }],
      },
      // 有意不提供 scopePreview
      onRequestPreview: () => {},
    }),
  );

  assert.ok(html.includes('尚未校验'), '未校验要明确说出来，并与「校验失败」区分');
  assert.ok(html.includes('校验范围'), '要给出可执行的下一步：点「校验范围」');
  assertDisabled(html, '确认并建立 engagement', '尚未校验');
  // 「校验范围」按钮本身必须可用（否则人无从下手）
  const checkButton = buttonTag(html, '校验范围');
  assert.ok(checkButton.length > 0, '校验按钮应渲染');
  assert.equal(
    checkButton.includes('disabled=""'),
    false,
    '提供了 onRequestPreview 时校验按钮不该被禁用',
  );
});

test('清理列：未归档只给「归档」；已归档给「取消归档」+「清空内容…」；已清空则按钮禁用并说明', () => {
  // 穷举三种组合。**为什么不用渲染断言**：归档行默认被隐藏（`showArchived` 是组件内状态），
  // 静态渲染碰不到它们——而「清空过还留着可点的按钮」正是人类会误读的那一格
  //（2026-10-05 实测：人类以为「清空内容点了没生效」）。
  const fresh = engagementActionAvailability({ archivedAt: null, purgedAt: null });
  assert.deepEqual(fresh, {
    archiveLabel: '归档',
    purgeVisible: false,
    purgeDisabled: false,
    purgeReason: '两段确认后方可最终删除',
  });

  const archived = engagementActionAvailability({ archivedAt: '2026-01-02T00:00:00Z', purgedAt: null });
  assert.equal(archived.archiveLabel, '取消归档');
  assert.equal(archived.purgeVisible, true, '已归档才谈得上清空（服务端也是这么拦的）');
  assert.equal(archived.purgeDisabled, false);
  assert.equal(archived.purgeReason, '两段确认后方可最终删除');

  const purged = engagementActionAvailability({ archivedAt: '2026-01-02T00:00:00Z', purgedAt: '2026-01-03T00:00:00Z' });
  assert.equal(purged.purgeVisible, true, '清空过仍然显示这一格——它承载「已清理」这件事的说明');
  assert.equal(purged.purgeDisabled, true, '清空过就不该再给可点的按钮');
  assert.match(purged.purgeReason ?? '', /内容已清空，不可恢复/);
});

test('清理列接线：未归档行渲染「归档」且**不是**禁用态（漏传控制器会在这里露馅）', () => {
  const html = renderToStaticMarkup(
    createElement(EngagementList, {
      engagements: [engagement()],
      onSelect: () => undefined,
      controller: inertController(),
      now: NOW,
    }),
  );
  const archive = buttonTag(html, '归档');
  assert.equal(archive.includes('disabled=""'), false, `接线正常时「归档」必须可点：${archive}`);
  assert.equal(/清空内容/.test(html), false, '未归档的作业不渲染「清空内容…」（服务端也会拦）');
});
