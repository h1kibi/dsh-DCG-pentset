/**
 * 放行队列与范围管理的测试。
 *
 * 重点锁定五条**关于闸门**的规则——它们的存在与否决定了人类能否看出自己批准了什么：
 *   1. **approve-what-you-see**（§10.3.1）：展示的是完整命令文本，不是动作名
 *   2. **过期不可放行**（§15.2）：过期凭证不复活，按钮禁用并说明
 *   3. **补充选填**（2026-10-05 人类要求）：不填也能直接放行 / 拒绝 / 撤销；
 *      填了随决定进审计，并被投递给 Agent 作为上下文补充（`deliverApprovalNotice`）
 *   4. **待确认与排除都不纳入**（§5.5）：三选一渲染，且后果逐项写明
 *   5. **授权依据不再是闸门**：空授权依据必须能提交（本部署授权主体即部署方，
 *      该字段只作审计留痕）；真正阻断提交的是理由/engagement/候选资产
 *
 * 写路径**不 mock 控制器**：测试用真实的 `ConsoleController` → `ConsoleClient` 信封
 * → `ConsoleRpc` → 假工作流跑通整条链，因此断言的「点了放行之后服务端收到什么」
 * 与运行时完全同源（信封与参数拼装都是真代码在跑）。视图渲染用
 * `renderToStaticMarkup`，不需要 jsdom。
 */

import { consoleServicesStub } from './helpers/console-services.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { ConsoleRpc } from '../src/console/rpc.ts';
import { ConsoleController } from '../src/client/controller.ts';
import type { ConsoleControllerDeps } from '../src/client/controller.ts';
import type { ConsoleSnapshot } from '../src/client/controller.ts';
import { ApprovalQueue, approvalGateOf, noticeFailureOf } from '../src/client/views/ApprovalQueue.tsx';
import { IntakeRunningCard, PendingApprovals, PhaseStrip } from '../src/client/views/IntakePrompt.tsx';
import type { ApprovalItem } from '../src/client/views/ApprovalQueue.tsx';
import { ScopeManager, amendmentBlockers, formatScopeTarget } from '../src/client/views/ScopeManager.tsx';
import type { CandidateAsset, ScopeVersionView } from '../src/client/views/ScopeManager.tsx';
import type { HumanWorkflowService, ScopeTarget, WorkflowSnapshot } from '../src/contracts.ts';
import type { HostRpcResult } from '../src/console/rpc.ts';

const NOW = new Date('2026-09-19T12:00:00Z');
const APPROVAL_ID = '11111111-1111-1111-1111-111111111111';
const SESSION_ID = '22222222-2222-2222-2222-222222222222';

// ───────────────────────────── 测试骨架 ─────────────────────────────

/**
 * 假工作流：记录被调用的方法与入参。
 *
 * 用 `as unknown as HumanWorkflowService` 是本仓既有约定（见 `test/console-rpc.test.ts`）：
 * 测试只关心放行与范围修订两个端点，把 25 个方法全部实现只会让「测试里到底断言了什么」
 * 更难看清。
 */
function fakeWorkflow(): {
  workflow: HumanWorkflowService;
  calls: Array<{ readonly method: string; readonly input: unknown }>;
} {
  const calls: Array<{ readonly method: string; readonly input: unknown }> = [];
  const snapshot: WorkflowSnapshot = {
    engagementId: 'e1',
    mainStatus: 'waiting_human_review',
    runMarker: 'running',
    currentPhase: 'exploitation',
    stateVersion: 7,
    graphIteration: 1,
    activeWorkerSessionId: SESSION_ID, scopeVersion: 1, authorizationExpiresAt: null,
  };
  const handler =
    (method: string, result: unknown) =>
    async (input: unknown): Promise<unknown> => {
      calls.push({ method, input });
      return result;
    };

  const workflow = {
    getState: handler('getState', snapshot),
    listWorkerSessions: handler('listWorkerSessions', []),
    listEngagements: handler('listEngagements', []),
    decideApproval: handler('decideApproval', {
      id: APPROVAL_ID, workerSessionId: SESSION_ID, actionClass: 'exploit_validation',
      planHash: 'h', leaseGeneration: 1, decision: 'approved', expiresAt: NOW, consumedAt: null,
    }),
    revokeApproval: handler('revokeApproval', {
      id: APPROVAL_ID, workerSessionId: SESSION_ID, actionClass: 'exploit_validation',
      planHash: 'h', leaseGeneration: 1, decision: 'revoked', expiresAt: NOW, consumedAt: null,
    }),
    amendScope: async (input: unknown) => {
      calls.push({ method: 'amendScope', input });
      return { engagementId: 'e1', version: 2, contentHash: 'sha256:x' };
    },
  } as unknown as HumanWorkflowService;

  return { workflow, calls };
}

/** 真实控制器 + 真实 RPC：视图拿到的就是运行时那个控制器。 */
function harness(): {
  controller: ConsoleController;
  calls: Array<{ readonly method: string; readonly input: unknown }>;
} {
  const { workflow, calls } = fakeWorkflow();
  const rpc = new ConsoleRpc({ services: consoleServicesStub(workflow) });
  const invoke: ConsoleControllerDeps['invoke'] = async (channel, endpoint, payload) => {
    // 通道名不参与语义，但真实适配器会用它——这里保留参数以保持签名一致
    void channel;
    void endpoint;
    // 载荷是**两层**：外层 `{ args: … }` 是网关的固定容器，内层 `{ request: <信封> }`
    // 是宿主方法的具名参数表。真实路径由「共享网关 + Typert 门面」完成这两层解包，
    // 测试里必须复刻同样的解包，否则会把合法的信封当成非法输入拒掉
    // （表现是「放行没有到达工作流服务」这类误导性失败）。
    const envelope = (payload as { args: { request: unknown } }).args.request;
    const response = await rpc.handle(envelope, {
      operatorId: 'op-1',
      authenticatedAt: NOW,
      source: 'web-console-test',
    });
    if (response.ok) return { ok: true, value: response } satisfies HostRpcResult;
    return {
      ok: false,
      error: {
        code: response.code,
        message: response.message,
        details: response.state === undefined ? {} : { state: response.state },
      },
    } satisfies HostRpcResult;
  };
  return { controller: new ConsoleController({ invoke, clock: () => NOW }), calls };
}

/** 未选中 engagement 的空快照（首屏、或列表还没读回来时的形状）。 */
function emptySnapshot(): ConsoleSnapshot {
  return {
    engagements: [],
    selectedEngagementId: null,
    state: null,
    sessions: [],
    loading: false,
    lastError: null,
    conflict: false,
    loadedAt: null,
  };
}

/** 已选中 engagement 且读到状态的快照。 */
function loadedSnapshot(): ConsoleSnapshot {
  return {
    ...emptySnapshot(),
    selectedEngagementId: 'e1',
    state: {
      engagementId: 'e1',
      mainStatus: 'waiting_human_review',
      runMarker: 'running',
      currentPhase: 'exploitation',
      stateVersion: 7,
      graphIteration: 1,
      activeWorkerSessionId: SESSION_ID, scopeVersion: 1, authorizationExpiresAt: null,
    },
  };
}

/** 一条放行记录：字段与 `pentest.approvals` + `command_plan` 对齐。 */
const COMMAND = 'nuclei -u https://app.example.com -t cves/2026/ -timeout 30s -o /tmp/out.json';
const PURPOSE = '验证 CVE-2026-0001 的反序列化入口';

function approval(over: Partial<ApprovalItem> = {}): ApprovalItem {
  const base: Omit<ApprovalItem, 'displayCommand'> = {
    id: APPROVAL_ID,
    workerSessionId: SESSION_ID,
    actionClass: 'exploit_validation',
    normalizedTarget: 'app.example.com:443',
    normalizedCommand: COMMAND,
    scopeVersion: 3,
    policyEpoch: 4,
    timeoutMs: 30_000,
    maxOutputBytes: 262_144,
    purpose: PURPOSE,
    riskSummary: 'exploit_validation：验证 CVE-2026-0001 的反序列化入口',
    decision: 'pending',
    expiresAt: '2026-09-19T12:30:00Z',
    consumedAt: null,
    createdAt: '2026-09-19T11:55:00Z',
    templateId: 'http_payload_probe',
    params: { payload_id: 'xss-1' },
    targetSelector: 'app.example.com',
    ...over,
  };
  // 展示形态默认跟随 `normalizedCommand`（服务端在没有 `*_b64` 参数时也是这样回落的）：
  // 用例把命令置空时必须跟着空，否则 fail-closed 的断言会被一个仍在的展示文本骗过。
  return { ...base, displayCommand: over.displayCommand ?? base.normalizedCommand };
}

function candidate(over: Partial<CandidateAsset> & { readonly assetId: string }): CandidateAsset {
  return {
    canonicalTarget: '10.20.3.17',
    kind: 'ip',
    labels: ['internal'],
    discoveredFrom: '入口 app.example.com 的凭据 svc_backup，经 SMB 会话发现',
    discoveredInSessionId: SESSION_ID,
    firstSeenIteration: 1,
    ...over,
  };
}

function target(over: Partial<ScopeTarget> & { readonly value: string }): ScopeTarget {
  return { kind: 'domain', protocols: ['tcp'], ports: [], ...over };
}

function version(over: Partial<ScopeVersionView> = {}): ScopeVersionView {
  return {
    version: 1,
    iteration: 1,
    targets: [target({ value: 'app.example.com' })],
    exclusions: [target({ value: 'admin.example.com' })],
    authorizationRef: 'SOW-2026-014 §3.2',
    amendmentReason: null,
    changedBy: 'op-1',
    contentHash: 'sha256:abc',
    createdAt: '2026-09-18T09:00:00Z',
    ...over,
  };
}

/** 取某个标签对应的 `<button>` 起始标签文本，供断言 `disabled` 与 `title`。 */
function buttonTag(html: string, label: string): string {
  const match = new RegExp(`<button[^>]*>${label}</button>`).exec(html);
  assert.ok(match !== null, `未找到按钮「${label}」`);
  return match[0];
}

/**
 * 断言按钮被禁用，且禁用原因里包含给定片段。
 *
 * 认 `disabled=""` 这个属性而不是 `is-disabled` 这个类名——类名只是样式，
 * 属性才是「点不动」这件事本身。`title` 的检查对应 §6.2.3 的「闸门要可见」：
 * 一个禁用的按钮不说话，人类只能猜为什么。
 */
function assertDisabled(html: string, label: string, reasonFragment: string): void {
  const tag = buttonTag(html, label);
  assert.ok(tag.includes('disabled=""'), `按钮「${label}」应被禁用：${tag}`);
  assert.ok(
    tag.includes(reasonFragment),
    `按钮「${label}」的禁用原因应包含「${reasonFragment}」：${tag}`,
  );
}

// ───────────────────────────── 会话卡片：内联放行区 ─────────────────────────────

/**
 * 会话卡片（`conversation.chat.turnTail`）里也长了一张放行区。
 *
 * 它必须与放行队列**同判据、同证据**：判据分叉会出现「队列里能批、聊天里批不了」，
 * 证据分叉则更糟——人类在聊天里批准的可能不是队列里看到的那条命令。
 */
function renderPending(items: readonly ApprovalItem[]): string {
  return renderToStaticMarkup(
    createElement(PendingApprovals, {
      items,
      now: NOW,
      busyId: null,
      failure: null,
      onDecide: () => undefined,
      onOpenConsole: () => undefined,
    }),
  );
}

test('会话卡片的放行区原样展示完整命令，且与队列共用同一套闸门（§10.3.1）', () => {
  const markup = renderPending([approval()]);
  assert.ok(markup.includes(COMMAND), '批准的是那条命令本身：必须完整展示，不做摘要');
  // 补充是选填：不填也能直接批——放行卡上只留「要不要批」这一个决定。
  assert.ok(!markup.includes('理由必填'), '缺补充不再禁用按钮');
  assert.ok(markup.includes('批准本次执行') && markup.includes('驳回'), '两个动作都要在');
});

test('自由命令的放行卡显示**解码后的命令**，不是 base64（放开权限后卡片是唯一内容闸门）', () => {
  // 服务端把 `*_b64` 参数解码后写进 `command_plan.display_command`，卡片优先用它。
  // 否则人类看到的是 `command_b64=<base64>`——点「批准」等于盲批，闸门形同虚设。
  const plaintext = 'nmap -sS -Pn -p 3002,3003 10.0.0.5; echo done';
  const raw = `shell_exec target=http://10.0.0.5 port=3002 command_b64=${Buffer.from(plaintext, 'utf8').toString('base64')}`;
  const markup = renderPending([approval({ normalizedCommand: raw, displayCommand: plaintext })]);
  assert.ok(markup.includes(plaintext), '必须显示解码后的命令原文');
  assert.ok(!markup.includes(raw), '不得把给容器读的 base64 形态摆给人类看');
});

test('没有 display_command 的老记录回落显示 normalized_command（不算「记录缺失」）', () => {
  const markup = renderPending([approval({ displayCommand: null })]);
  assert.ok(markup.includes(COMMAND), '回落显示规范化命令');
  assert.ok(!markup.includes('记录缺失：完整命令'), '有 normalized_command 就不算缺字段');
});

test('会话卡片的放行区对不完整记录 fail-closed：可驳回、不可放行', () => {
  const markup = renderPending([approval({ normalizedCommand: null })]);
  assert.ok(
    markup.includes('记录缺失：完整命令'),
    '缺字段要显式说「记录缺失」，不能渲染成空块让人以为命令是空的',
  );
  assertDisabled(markup, '批准本次执行', '放行记录不完整');
});

test('范围确认后的状态卡：说清 Agent 在哪个会话、在做什么、去哪看', () => {
  const html = renderToStaticMarkup(
    createElement(IntakeRunningCard, {
      engagementName: '47.109.76.66:3002 授权渗透测试',
      mainStatus: 'worker_running',
      currentPhase: 'intelligence-gathering',
      activeSession: {
        dshSessionId: 'dsh-5dea5956-7eda-4501-9f89-27650e9e3b2c',
        workerSessionId: 'ws-5dea5956',
        status: 'active',
        statusNote: '已识别：nginx + Next.js（CDUT Judge），正在做敏感路径探测',
        phase: 'intelligence-gathering',
      },
      onFollowSession: () => undefined,
    }),
  );
  assert.ok(html.includes('范围已确认'), '标题必须直接回答「到底启动了没有」');
  assert.ok(html.includes('正在运行'), 'worker_running 时标题就该说正在运行');
  assert.ok(html.includes('dsh-5dea5956'), '必须给出 Agent 所在的会话标识');
  assert.ok(html.includes('CDUT Judge'), '状态便签是「它确实在干活」的证据，必须原样展示');
  assert.ok(
    /进入下一阶段|去看 Agent 的会话/.test(html),
    '必须给一条到「Agent 所在会话」的路——人类要的是会话切换，不是打开控制台',
  );
  assert.equal(html.includes('打开控制台'), false, '这张卡不再提供控制台入口（侧栏与常驻状态条已有）');
});

test('运行卡：等待判断时主按钮是「进入下一阶段」，运行中时是「去看 Agent 的会话」', () => {
  // 人类报障两条并成一条断言：
  //   1. 卡片写「Agent 在另一个会话里工作」却只给控制台入口 → 现在给会话切换；
  //   2. 人类要的按钮是「进入下一阶段」→ Agent 已交报告时给推进（推荐路径一键走通），
  //      还在跑时给「去看会话」（此刻没有下一阶段可进，标签不能撒谎）。
  // 两种状态都**不再**出现控制台入口。
  const activeSession = {
    dshSessionId: 'dsh-agent-1',
    workerSessionId: 'ws-agent-1',
    status: 'active' as const,
    statusNote: null,
    phase: 'intelligence-gathering' as const,
  };
  const base = {
    engagementName: 'E',
    currentPhase: 'intelligence-gathering' as const,
    activeSession,
  };

  const handedBack = renderToStaticMarkup(
    createElement(IntakeRunningCard, {
      ...base,
      mainStatus: 'waiting_human_review',
      onAdvancePhase: () => undefined,
      onFollowSession: () => undefined,
    }),
  );
  assert.ok(
    handedBack.includes('进入下一阶段：威胁建模'),
    '推荐路径上的下一阶段必须写在按钮上，人类点之前就知道会进哪一阶段',
  );
  assert.equal(/打开控制台/.test(handedBack), false, '这张卡不再提供控制台入口');

  const stillRunning = renderToStaticMarkup(
    createElement(IntakeRunningCard, {
      ...base,
      mainStatus: 'worker_running',
      onAdvancePhase: () => undefined,
      onFollowSession: () => undefined,
    }),
  );
  assert.ok(
    stillRunning.includes('去看 Agent 的会话：dsh-agent-1'),
    '还在跑时给的是会话切换（这时没有下一阶段可进）',
  );
  assert.equal(/进入下一阶段/.test(stillRunning), false, '标签不得在无阶段可推进时撒谎');

  const withoutNav = renderToStaticMarkup(
    createElement(IntakeRunningCard, { ...base, mainStatus: 'worker_running' }),
  );
  assert.equal(
    /去看 Agent 的会话|进入下一阶段/.test(withoutNav),
    false,
    '没有导航/推进能力时不得画按钮（fail-closed）',
  );

  const failed = renderToStaticMarkup(
    createElement(IntakeRunningCard, {
      ...base,
      mainStatus: 'waiting_human_review',
      onAdvancePhase: () => undefined,
      advanceError: '状态版本不匹配：期望 2，实际 3',
    }),
  );
  assert.ok(failed.includes('状态版本不匹配'), '推进失败必须把原因摆在卡片上，不能静默');
});

test('阶段横条：人类所在的 Agent 会话里就能看到当前阶段与已跑完的阶段', () => {
  // 人类报障：推进到下一阶段后，界面上看不到自己在哪一阶段（要进「渗透作业」才看得到）。
  // 这条锁的是「信息在不在这里」：阶段序号、阶段名、五个阶段的轨道、当前阶段被标记。
  const html = renderToStaticMarkup(
    createElement(PhaseStrip, {
      engagementName: '47.109.76.66:3002 授权渗透测试',
      mainStatus: 'worker_running',
      currentPhase: 'vulnerability-analysis',
      statusNote: '正在验证 CVE 候选',
    }),
  );
  assert.ok(html.includes('当前阶段 3/5 · 漏洞分析'), '必须直接写出「第几阶段 / 共几阶段 / 叫什么」');
  assert.ok(html.includes('aria-current="step"'), '当前阶段必须在轨道上被标记，而不是只出现在标题里');
  assert.ok(html.includes('情报收集') && html.includes('后渗透'), '轨道要列出全部阶段（人类才知道还剩几步）');
  assert.ok(html.includes('正在验证 CVE 候选'), '状态便签是「它确实在干活」的证据');
});

test('阶段横条：读不到阶段时说「读不到」，不假装在第一阶段', () => {
  const html = renderToStaticMarkup(
    createElement(PhaseStrip, {
      engagementName: null,
      mainStatus: null,
      currentPhase: null,
      statusNote: null,
    }),
  );
  assert.ok(html.includes('读不到'), '未知就得说未知：默认成第一阶段会让人类以为作业刚开始');
  assert.equal(html.includes('aria-current'), false, '不知道当前阶段时不得标记任何一步');
});

test('等待人工判断时标题不得还说「正在运行」（按真实状态分档）', () => {
  const html = renderToStaticMarkup(
    createElement(IntakeRunningCard, {
      engagementName: 'x',
      mainStatus: 'waiting_human_review',
      currentPhase: 'intelligence-gathering',
      activeSession: null,
    }),
  );
  assert.ok(html.includes('等待判断'), '它已经交完报告了，标题必须如实说');
});

test('读不到活动会话时状态卡不得编造「正在运行」，而是指出去处', () => {
  // 两种来源都可能是 `null`：服务端明确说「没有活动会话」，或旧服务端根本没有这个字段。
  // 因此措辞必须对两者都成立——**不能**断言一个我们并不知道的事实。
  const html = renderToStaticMarkup(
    createElement(IntakeRunningCard, {
      engagementName: 'x',
      mainStatus: 'ready',
      currentPhase: null,
      activeSession: null,
    }),
  );
  assert.ok(html.includes('另一个会话'), '要说清对话在别处，而不是让人在这页干等');
  assert.ok(html.includes('运行控制'), '必须给出下一步该去哪里');
});

test('没有放行待办时不画放行区（常驻空卡片是噪音）', () => {
  assert.equal(renderPending([]), '', '空列表必须渲染成空，而不是一张「0 项等待」的卡片');
});

// ───────────────────────────── 放行队列：approve-what-you-see ─────────────────────────────

test('放行队列展示即将执行的完整命令文本，而不是抽象动作名（§10.3.1）', () => {
  const { controller } = harness();
  const item = approval();
  const html = renderToStaticMarkup(
    createElement(ApprovalQueue, { controller, snapshot: loadedSnapshot(), items: [item], now: NOW }),
  );

  // 完整命令原文出现
  assert.ok(html.includes(COMMAND), '完整命令文本必须原样出现在放行界面');
  assert.ok(html.includes('nuclei -u https://app.example.com'), '命令参数必须可见');
  assert.ok(html.includes('-timeout 30s'), '命令的完整参数不能被截断成摘要');
  // 规范化目标、类别、范围版本、请求方、理由、有效期
  assert.ok(html.includes('app.example.com:443'), '规范化目标必须显示');
  assert.ok(html.includes('利用验证'), '动作类别用中文标签');
  assert.ok(html.includes('逐目标、逐动作放行'), '风险等级按 §10.3 的风险分级表');
  assert.ok(html.includes('v3'), '范围版本必须显示');
  assert.ok(html.includes(SESSION_ID.slice(0, 12)), '请求方会话必须显示');
  assert.ok(html.includes(PURPOSE), '申请理由必须显示');
  assert.ok(html.includes('30 秒'), '超时必须显示（命令计划的一部分）');
  assert.ok(html.includes('256 KiB'), '输出上限必须显示');
  // 操作按钮存在
  assert.ok(html.includes('>放行</button>'));
  assert.ok(html.includes('>拒绝</button>'));
  assert.ok(html.includes('>撤销</button>'));
});

test('放行队列空态：说明为什么空，而不是一片空白', () => {
  const { controller } = harness();
  const html = renderToStaticMarkup(
    createElement(ApprovalQueue, { controller, snapshot: emptySnapshot(), items: [], now: NOW }),
  );
  assert.ok(html.includes('放行队列为空'));
  assert.ok(html.includes('pentest_exec') === false, '空态不应渲染出伪造的条目');
  assert.ok(html.includes('pentest_request_action_approval'), '空态要说明条目从哪来');
});

test('过期放行不可放行：按钮禁用并说明（§15.2 过期凭证不复活）', () => {
  const { controller } = harness();
  const expired = approval({ expiresAt: '2026-09-19T11:00:00Z' });
  const html = renderToStaticMarkup(
    createElement(ApprovalQueue, { controller, snapshot: loadedSnapshot(), items: [expired], now: NOW }),
  );

  assert.ok(html.includes('已过期'), '过期状态必须显式标注');
  assertDisabled(html, '放行', '过期凭证不复活');
  assertDisabled(html, '撤销', '过期凭证不复活');
  assert.ok(html.includes('重新申请'), '要告诉人类正确动作是重新申请');
  assert.ok(!html.includes('补充说明'), '终态条目不再渲染补充输入框');
});

test('过期判定是纯函数：到期时间不可解析时按过期处理（fail-closed）', () => {
  const gate = approvalGateOf(approval({ expiresAt: '不是时间' }), '有理由', NOW);
  assert.equal(gate.canApprove, false);
  assert.equal(gate.stateLabel, '已过期');
});

test('已消费的放行显示为已完成，不再可操作（§10.3.1 一次性消费）', () => {
  const { controller } = harness();
  const consumed = approval({ decision: 'approved', consumedAt: '2026-09-19T12:05:00Z' });
  const html = renderToStaticMarkup(
    createElement(ApprovalQueue, { controller, snapshot: loadedSnapshot(), items: [consumed], now: NOW }),
  );
  assert.ok(html.includes('已完成'));
  assertDisabled(html, '撤销', '已被一次执行消费');
  assert.ok(html.includes('不会被执行第二次'), '要说明一次性消费的语义');
});

test('放行成功但通知没送达时，界面必须当场告警（否则就是「点了批准没反应」）', () => {
  // 服务端把投递结果带回来了（`noticeDelivered`）；这里只验「它变成人看得懂的一句话」。
  const warned = noticeFailureOf({
    ok: true,
    value: { id: 'x', decision: 'approved', noticeDelivered: false },
  });
  assert.ok(warned !== null, '投递失败必须产生告警');
  assert.equal(warned.code, 'approval/notice-undelivered');
  assert.match(warned.message, /没能唤醒 Agent 会话/);
  assert.match(warned.message, /插话|重做/, '要给出可执行的下一步');

  // 送达成功 / 不适用（会话已关闭）都不得告警——狼来了会让真告警失效。
  assert.equal(noticeFailureOf({ ok: true, value: { noticeDelivered: true } }), null);
  assert.equal(noticeFailureOf({ ok: true, value: {} }), null);
  assert.equal(noticeFailureOf({ ok: false }), null);
  assert.equal(noticeFailureOf(null), null);
});

test('补充是选填：不填也能直接操作；填了不改变闸门结论，只是把话带给 Agent', () => {
  const { controller } = harness();
  const item = approval();

  const withoutSupplement = renderToStaticMarkup(
    createElement(ApprovalQueue, { controller, snapshot: loadedSnapshot(), items: [item], now: NOW }),
  );
  assert.ok(!withoutSupplement.includes('理由必填'), '缺补充不再禁用任何按钮');
  // 补充框必须在：它是人类把话带给 Agent 的唯一入口（随决定投递）
  assert.ok(withoutSupplement.includes('补充说明'), '必须仍渲染补充输入框');

  const blank = approvalGateOf(item, '', NOW);
  assert.equal(blank.canApprove, true, '空补充也能批准');
  assert.equal(blank.canReject, true);
  assert.equal(blank.interactive, true);
  assert.ok(blank.stateLabel.includes('待放行'));
  assert.equal(blank.approveDisabledReason, null);

  const filled = approvalGateOf(item, '  实际依据  ', NOW);
  assert.equal(filled.canApprove, true, '填了补充同样可批准');
  assert.equal(filled.approveDisabledReason, null);
});

test('已放行但未消费的凭证只留「撤销」（撤销同样不需要补充）', () => {
  const { controller } = harness();
  const approved = approval({ decision: 'approved' });
  const html = renderToStaticMarkup(
    createElement(ApprovalQueue, { controller, snapshot: loadedSnapshot(), items: [approved], now: NOW }),
  );
  assertDisabled(html, '放行', '凭证已放行');
  assertDisabled(html, '拒绝', '凭证已放行');
  assert.ok(!html.includes('理由必填'), '撤销不再要求补充');
});

// ───────────────────────────── 放行队列：写路径 ─────────────────────────────

test('放行经控制台写路径下发：服务端收到 approvalId、决策与理由', async () => {
  const { controller, calls } = harness();
  const result = await controller.decideApproval({
    approvalId: APPROVAL_ID,
    decision: 'approved',
    reason: '载荷最小且目标在 v3 范围内',
  });

  assert.equal(result.ok, true, '放行必须真的到达工作流服务（而不是被信封拒掉）');
  const call = calls.find((entry) => entry.method === 'decideApproval');
  assert.ok(call !== undefined);
  assert.deepEqual(call.input, {
    approvalId: APPROVAL_ID,
    decision: 'approved',
    operatorId: 'op-1',
    reason: '载荷最小且目标在 v3 范围内',
  });

  // 补充是选填：**空值也必须照发**（服务端据此记录"人类没有补充"，
  // 并让投递通知如实写「未填写」）——"字段被整个丢掉"与"填了空"是两件事。
  await controller.decideApproval({ approvalId: APPROVAL_ID, decision: 'approved', reason: '' });
  const blank = calls.filter((entry) => entry.method === 'decideApproval').at(-1);
  assert.ok(blank !== undefined);
  const blankInput = blank.input as Record<string, unknown>;
  assert.equal(Object.hasOwn(blankInput, 'reason'), true, '空补充仍要出现在信封里');
  assert.equal(blankInput.reason, '');
});

test('拒绝与撤销各自走对应端点，理由随信封进入审计输入', async () => {
  const { controller, calls } = harness();
  await controller.decideApproval({ approvalId: APPROVAL_ID, decision: 'rejected', reason: '越出时间窗' });
  await controller.revokeApproval({ approvalId: APPROVAL_ID, reason: '目标已被移出新范围' });

  const rejected = calls.find((entry) => entry.method === 'decideApproval');
  const revoked = calls.find((entry) => entry.method === 'revokeApproval');
  assert.ok(rejected !== undefined);
  assert.ok(revoked !== undefined);
  assert.equal((rejected.input as { readonly decision?: unknown }).decision, 'rejected');
  assert.equal((revoked.input as { readonly reason?: unknown }).reason, '目标已被移出新范围');
});

// ───────────────────────────── 范围管理 ─────────────────────────────

test('范围管理显示当前版本、目标清单、排除项与授权依据（§6.2.1）', () => {
  const { controller } = harness();
  const html = renderToStaticMarkup(
    createElement(ScopeManager, {
      controller,
      snapshot: loadedSnapshot(),
      current: version(),
      history: [],
      candidateAssets: [],
      planAmendment: () => ({ targets: version().targets, exclusions: version().exclusions }),
      now: NOW,
    }),
  );

  assert.ok(html.includes('v1'), '当前范围版本号必须显示');
  assert.ok(html.includes('app.example.com'), '目标清单必须显示');
  assert.ok(html.includes('admin.example.com'), '排除项必须显示');
  assert.ok(html.includes('SOW-2026-014 §3.2'), '授权依据必须显示');
  assert.ok(html.includes('默认端口 80/443'), '端口语义按 §10.2.2 说明（留空不等于任意端口）');
});

test('回环修订：候选资产渲染逐项三选一，并写明「待确认」与「排除」都不纳入（§5.5）', () => {
  const { controller } = harness();
  const assets = [
    candidate({ assetId: 'a1', canonicalTarget: '10.20.3.17' }),
    candidate({ assetId: 'a2', canonicalTarget: '10.20.4.0/24', kind: 'cidr' }),
  ];
  const html = renderToStaticMarkup(
    createElement(ScopeManager, {
      controller,
      snapshot: loadedSnapshot(),
      current: version(),
      history: [],
      candidateAssets: assets,
      planAmendment: () => ({ targets: version().targets, exclusions: version().exclusions }),
      now: NOW,
    }),
  );

  assert.ok(html.includes('10.20.3.17'));
  assert.ok(html.includes('10.20.4.0/24'));
  assert.ok(html.includes('入口 app.example.com 的凭据 svc_backup'), '发现来源必须随资产一起显示（§5.5）');
  // 每个候选资产一组三选一
  assert.equal(html.match(/>纳入<\/button>/g)?.length, 2);
  assert.equal(html.match(/>排除<\/button>/g)?.length, 2);
  assert.equal(html.match(/>待确认<\/button>/g)?.length, 2);
  // 后果说明必须写明「待确认」不纳入
  assert.ok(html.includes('未纳入的资产不参与后续任何阶段'));
  assert.ok(html.includes('与「排除」的后果相同'), '「待确认」与「排除」后果相同的规则必须写在界面上');
});

test('授权依据为空**不再**阻断提交：它是留痕字段，不是闸门', () => {
  // 部署画像：本插件服务于已获授权的作业环境（授权主体就是部署方），
  // 索要授权凭据只会挡住作业、不增加任何技术安全边界。真正阻断提交的是下面这条理由。
  const { controller } = harness();
  const html = renderToStaticMarkup(
    createElement(ScopeManager, {
      controller,
      snapshot: loadedSnapshot(),
      current: version(),
      history: [],
      candidateAssets: [candidate({ assetId: 'a1' })],
      planAmendment: () => ({ targets: version().targets, exclusions: version().exclusions }),
      now: NOW,
    }),
  );

  assert.ok(
    !html.includes('authorization-ref-required'),
    '授权依据的阻断项必须从闸门里消失（留一个已删除的码会让人以为它还在判定）',
  );
  assert.ok(!html.includes('授权依据必填'), '界面上不该再有「授权依据必填」的字样');
  // 理由仍未填 → 提交依旧被拦，且原因必须说清楚。
  assertDisabled(html, '提交范围修订', '修订理由必填');
});

test('范围修订闸门是纯函数：空理由 / 未选 engagement / 无候选资产被阻断（授权依据不参与）', () => {
  const decisions = [{ assetId: 'a1', decision: 'included' as const }];
  assert.deepEqual(
    amendmentBlockers({
      authorizationRef: 'SOW-1',
      reason: '回环修订',
      decisions,
      candidateCount: 1,
      engagementId: 'e1',
    }),
    [],
    '三项齐备时不应有阻断',
  );
  const codes = amendmentBlockers({
    authorizationRef: '   ',
    reason: '',
    decisions,
    candidateCount: 0,
    engagementId: null,
  }).map((blocker) => blocker.code);
  assert.deepEqual(codes, ['reason-required', 'engagement-missing', 'no-candidates']);
  // 空授权依据**单独**必须什么都不阻断——这是这次改动的核心断言。
  assert.deepEqual(
    amendmentBlockers({
      authorizationRef: '',
      reason: '回环修订',
      decisions,
      candidateCount: 1,
      engagementId: 'e1',
    }),
    [],
    '空授权依据不得产生任何阻断项',
  );
});

test('提交范围修订走 amendScope：逐项决策与授权依据进入服务端输入', async () => {
  const { controller, calls } = harness();
  const result = await controller.amendScope({
    engagementId: 'e1',
    targets: [target({ value: 'app.example.com' }), target({ value: '10.20.3.17', kind: 'ip' })],
    exclusions: [target({ value: 'admin.example.com' })],
    authorizationRef: 'SOW-2026-014 §3.2',
    decisions: [
      { assetId: 'a1', decision: 'included' },
      { assetId: 'a2', decision: 'pending' },
    ],
    reason: '纳入 10.20.3.17，10.20.4.0/24 待确认',
  });

  assert.equal(result.ok, true, '范围修订必须真的到达工作流服务');
  const call = calls.find((entry) => entry.method === 'amendScope');
  assert.ok(call !== undefined);
  const input = call.input as {
    readonly authorizationRef?: unknown;
    readonly decisions?: unknown;
    readonly targets?: unknown;
    readonly reason?: unknown;
    readonly operatorId?: unknown;
  };
  assert.equal(input.authorizationRef, 'SOW-2026-014 §3.2');
  assert.deepEqual(input.decisions, [
    { assetId: 'a1', decision: 'included' },
    { assetId: 'a2', decision: 'pending' },
  ]);
  assert.equal((input.targets as readonly unknown[]).length, 2);
  assert.equal(input.reason, '纳入 10.20.3.17，10.20.4.0/24 待确认');
  assert.equal(input.operatorId, 'op-1', '操作者身份来自传输层，不来自请求体');
});

test('范围管理空态：没有读到版本与没有候选资产时都给出原因', () => {
  const { controller } = harness();
  const html = renderToStaticMarkup(
    createElement(ScopeManager, {
      controller,
      snapshot: emptySnapshot(),
      current: null,
      history: [],
      candidateAssets: [],
      planAmendment: () => ({ targets: [], exclusions: [] }),
      now: NOW,
    }),
  );
  assert.ok(html.includes('尚未读到范围版本'));
  assert.ok(html.includes('没有待决的内部资产'));
  assert.ok(html.includes('还没有历史版本'));
  // 空态下提交同样被拦，且给的是**当前最先命中的那条**原因（理由是空 → 先报理由）。
  // 授权依据不再是原因之一：那是这次改动要保证的事。
  assertDisabled(html, '提交范围修订', '修订理由必填');
  assert.ok(!html.includes('授权依据必填'), '授权依据不再是提交的阻断原因');
});

test('历史版本只读展示，当前版本被标注', () => {
  const { controller } = harness();
  const html = renderToStaticMarkup(
    createElement(ScopeManager, {
      controller,
      snapshot: loadedSnapshot(),
      current: version({ version: 2 }),
      history: [
        version({ version: 2, amendmentReason: '纳入内网主机' }),
        version({ version: 1, authorizationRef: 'SOW-2026-014 §3.1', amendmentReason: null }),
      ],
      candidateAssets: [],
      planAmendment: () => ({ targets: [], exclusions: [] }),
      now: NOW,
    }),
  );
  assert.ok(html.includes('纳入内网主机'));
  assert.ok(html.includes('SOW-2026-014 §3.1'));
  assert.ok(html.includes('当前生效版本'));
});

test('目标文本渲染保留端口与协议语义，留空端口一律标注为默认 80/443（§10.2.2）', () => {
  const withPort = formatScopeTarget({ kind: 'domain', value: 'a.example.com', protocols: ['tcp'], ports: [{ from: 8443, to: 8443 }] });
  assert.ok(withPort.includes('8443-8443'));
  const wildcard = formatScopeTarget({ kind: 'domain', value: '*.example.com', protocols: ['tcp'], ports: [], wildcardSubdomain: true });
  assert.ok(wildcard.includes('含子域通配'));
  assert.ok(wildcard.includes('默认端口 80/443'));
  // 网段与 domain/ip **同口径**：留空 = 默认 80/443（见 scope.test.ts 的 F1）。
  // 界面必须如实说明，否则人会以为「没写端口」等于「没有限制」。
  const cidr = formatScopeTarget({ kind: 'cidr', value: '10.0.0.0/8', protocols: ['tcp'], ports: [] });
  assert.ok(cidr.includes('默认端口 80/443'), `网段留空端口应标注默认端口，实际：${cidr}`);
  assert.equal(cidr.includes('必须显式声明端口'), false, '那条限制已删除');
  const any = formatScopeTarget({ kind: 'ip', value: '10.0.0.1', protocols: ['tcp'], ports: [{ from: 0, to: 65535 }] });
  assert.ok(any.includes('显式任意端口'), '显式任意端口与留空不是同一件事');
});

test('审批队列使用服务端完整读取端点', () => {
  const { controller } = harness();
  const queue = renderToStaticMarkup(
    createElement(ApprovalQueue, {
      controller,
      snapshot: loadedSnapshot(),
      items: [],
      now: NOW,
    }),
  );
  assert.ok(queue.includes('放行队列为空'));
  assert.equal(queue.includes('端点缺口'), false);
  const scope = renderToStaticMarkup(
    createElement(ScopeManager, {
      controller,
      snapshot: loadedSnapshot(),
      current: version(),
      history: [],
      candidateAssets: [],
      planAmendment: () => ({ targets: [], exclusions: [] }),
      readEndpointGap: 'listScopeVersions',
      now: NOW,
    }),
  );
  assert.ok(scope.includes('listScopeVersions'));
});

test('界面文案不泄漏 Markdown 记号：加粗必须渲染成 strong，而不是字面的星号', () => {
  const { controller } = harness();
  const queue = renderToStaticMarkup(
    createElement(ApprovalQueue, { controller, snapshot: loadedSnapshot(), items: [approval()], now: NOW }),
  );
  const scope = renderToStaticMarkup(
    createElement(ScopeManager, {
      controller,
      snapshot: loadedSnapshot(),
      current: version(),
      history: [version()],
      candidateAssets: [candidate({ assetId: 'a1' })],
      planAmendment: () => ({ targets: version().targets, exclusions: version().exclusions }),
      now: NOW,
    }),
  );
  // 两处规则文案都用了加粗来强调「哪些动作不纳入」「批准的是哪条命令」
  assert.ok(queue.includes('<strong>即将执行的这条命令</strong>'));
  assert.ok(scope.includes('<strong>都不纳入</strong>'));
  assert.ok(scope.includes('<strong>默认不在授权范围内</strong>'));
  for (const html of [queue, scope]) {
    // 星号是 Markdown 的记号，浏览器不会解释它——人类只会看到多余的两个星号
    assert.equal(html.includes('**'), false, '渲染结果里不应出现字面的 Markdown 星号');
  }
});

test('放行队列：记录不完整时不得放行，且如实说明缺了什么（fail-closed）', () => {
  // §10.3.1 的全部意义是「人类批准的是那条具体的命令」。
  // 命令文本读出来是 null 时，人类无法做出这个判断——唯一安全的结论是不放行。
  // 视图也不把它伪造成空串：空命令看起来像「一条没有参数的命令」，那是另一回事。
  const { controller } = harness();
  const html = renderToStaticMarkup(
    createElement(ApprovalQueue, {
      controller,
      snapshot: loadedSnapshot(),
      items: [approval({ normalizedCommand: null, maxOutputBytes: null })],
      now: NOW,
    }),
  );

  assert.ok(html.includes('记录不完整'), '状态标签必须说明这是数据故障，而不是某个生命周期状态');
  assert.ok(html.includes('完整命令'), '必须点名缺了哪个字段——否则人类不知道该让 Agent 补什么');
  assert.ok(html.includes('输出上限'), '缺多个字段时全部列出');
  assert.ok(!html.includes(COMMAND), '不得伪造命令文本');
  assertDisabled(html, '放行', '记录不完整');
  // 拒绝不需要看到命令全文，因此必须仍然可用——否则人类对坏记录毫无办法
  assert.equal(
    buttonTag(html, '拒绝').includes('disabled=""'),
    false,
    '记录不完整时「拒绝」仍应可用',
  );
});
