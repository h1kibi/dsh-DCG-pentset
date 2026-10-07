/**
 * 政策装配层测试（设计文档 §10.2、§10.2.1、§10.2.2、§10.3）。
 *
 * 两类用例：
 *   - **纯逻辑**：`classifyAction` 只依赖模板注册表，策略快照解析只依赖 jsonb 值，
 *     都不碰数据库，因此始终运行（也是「无法归类即拒绝」在这些用例上的证据）；
 *   - **集成**：仅在设置了 `PENTEST_DATABASE_URL` 时运行，验证 jsonb 范围条目、uuid 会话标识、
 *     外键与真实列的往返。
 *
 * 为什么集成用例必须在真实 PostgreSQL 上跑：假 DB 不模拟 CHECK 约束与唯一索引，
 * 此前掩盖过 `revoked_reason` 缺 `expired` 的真缺陷；本层还额外依赖 `uuid` 列的外键、
 * jsonb 往返、`bigint` 列返回字符串（`policy_epoch`）这些只有真实库才会暴露的行为。
 *
 * 连接用超级用户（`postgres`）：002 已启用 RLS，非所有者角色未设会话变量时看不到任何行；
 * 超级用户绕过 RLS，因此本文件测的是**数据装配**，不是 RLS 行为本身。
 */

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import { Pool } from 'pg';

import type {
  ExecutionPlan,
  NormalizedTarget,
  ScopeRejectionCode,
  ScopeVerdict,
} from '../src/contracts.ts';
import {
  DEFAULT_DISABLED_CLASSES,
  PER_ACTION_APPROVAL_CLASSES,
} from '../src/contracts.ts';
import type { DbClient } from '../src/db/port.ts';
import { DEFAULT_ACTION_POLICY } from '../src/execution/service.ts';
import type { ActionTemplateSpec } from '../src/execution/templates.ts';
import { DEFAULT_TEMPLATES } from '../src/execution/templates.ts';
import { MECHANISM_FIXTURES } from './helpers/template-fixtures.ts';

/** 机制用例统一用这份模板集：出厂那一张 + 五个夹具（见 helpers/template-fixtures.ts）。 */
const FIXTURE_OPTIONS = { templates: [...DEFAULT_TEMPLATES, ...MECHANISM_FIXTURES] } as const;
import {
  PgActionPolicySource,
  PgPolicyService,
  PgSessionDirectory,
  actionPolicyFromSnapshot,
} from '../src/policy/pg-policy.ts';

// ───────────────────────────── 辅助 ─────────────────────────────

/** 不应被访问的数据库：用来证明 `classifyAction` / `actionPolicyFromSnapshot` 不碰库。 */
const NO_DB: DbClient = {
  query() {
    return Promise.reject(new Error('该用例不应访问数据库'));
  },
};

/** 取拒绝码（通过时用断言失败把 detail 带出来）。 */
function rejection(verdict: ScopeVerdict): { code: ScopeRejectionCode; detail: string } {
  assert.equal(verdict.ok, false, `期望被拒绝，实际通过：${JSON.stringify(verdict)}`);
  if (verdict.ok) throw new Error('unreachable');
  return { code: verdict.code, detail: verdict.detail };
}

function accepted(verdict: ScopeVerdict): NormalizedTarget {
  assert.equal(verdict.ok, true, `期望通过，实际被拒：${verdict.ok ? '' : verdict.detail}`);
  if (!verdict.ok) throw new Error('unreachable');
  return verdict.normalized;
}

function plan(overrides: Partial<ExecutionPlan>): ExecutionPlan {
  return {
    workerSessionId: randomUUID(),
    // 与夹具模板 `http_read` 的命令形态一致：`validateExecution` 会用模板复算命令并比对，
    // 名不对或命令对不上都会先按 `classification_rejected` 拒掉，掩盖本用例真正要验的那条规则。
    templateId: 'http_read',
    actionClass: 'passive_collection',
    normalizedTarget: 'http://target.example:80',
    resolvedAddresses: ['192.0.2.10'],
    normalizedCommand: 'http_get target=http://target.example:80 method=GET path=/ follow_redirects=false',
    planHash: 'sha256:test',
    idempotencyKey: 'idem-test',
    scopeVersion: 1,
    policyEpoch: 0,
    leaseGeneration: 1,
    approvalId: null,
    timeoutMs: 15_000,
    maxOutputBytes: 262_144,
    ...overrides,
  };
}

// ───────────────────────────── 类别判定（纯逻辑） ─────────────────────────────

describe('动作类别判定：无法归类即拒绝（§10.2.1）', () => {
  // 夹具 + 出厂集：本组用例考「机制」（参数白名单、端口来源、类别判定），
  // 不该因为出厂集只剩一张就整片红。
  const policy = new PgPolicyService(NO_DB, FIXTURE_OPTIONS);

  it('未注册模板返回 ok:false，而不是归到任何低风险类别', async () => {
    const verdict = await policy.classifyAction({ templateId: 'not_registered', params: {} });
    assert.equal(verdict.ok, false);
    if (verdict.ok) return;
    assert.equal(verdict.code, 'classification_rejected');
    assert.match(verdict.detail, /未注册的模板/);
  });

  it('不做名称近似或大小写归一：近似 id 同样拒绝', async () => {
    for (const id of ['HTTP_READ', 'http_read ', ' http_read', 'http-read', 'http_read2']) {
      const verdict = await policy.classifyAction({ templateId: id, params: {} });
      assert.equal(verdict.ok, false, `模板 ${JSON.stringify(id)} 不应被归类`);
    }
  });

  it('参数越界即拒绝（类别不因参数不同而改变，也只有白名单内的参数能通过）', async () => {
    const cases: readonly Record<string, string | number>[] = [
      // 缺少声明的参数（声明即必填）
      { method: 'GET', path: '/' },
      // 未声明的参数：不忽略，直接拒绝
      { method: 'GET', path: '/', follow_redirects: 'false', extra: '1' },
      // 枚举外取值
      { method: 'POST', path: '/', follow_redirects: 'false' },
      // 违反 pattern 的路径（查询串）
      { method: 'GET', path: '/a?b=1', follow_redirects: 'false' },
    ];
    for (const params of cases) {
      const verdict = await policy.classifyAction({ templateId: 'http_read', params });
      assert.equal(verdict.ok, false, `参数 ${JSON.stringify(params)} 不应通过`);
      if (verdict.ok) continue;
      assert.equal(verdict.code, 'classification_rejected');
    }
  });

  it('整数参数超出已声明区间即拒绝（tcp_connect 的 port）', async () => {
    for (const port of [0, 65_536, -1, 1.5]) {
      const verdict = await policy.classifyAction({ templateId: 'tcp_connect', params: { port } });
      assert.equal(verdict.ok, false, `端口 ${port} 不应通过`);
    }
    const ok = await policy.classifyAction({ templateId: 'tcp_connect', params: { port: 443 } });
    assert.deepEqual(ok, { ok: true, actionClass: 'active_probing' });
  });

  it('类别只来自模板注册信息：同一模板的任意合法参数都得到同一个类别', async () => {
    const first = await policy.classifyAction({
      templateId: 'http_read',
      params: { method: 'GET', path: '/a', follow_redirects: 'false' },
    });
    const second = await policy.classifyAction({
      templateId: 'http_read',
      params: { method: 'HEAD', path: '/b', follow_redirects: 'true' },
    });
    assert.deepEqual(first, { ok: true, actionClass: 'passive_collection' });
    assert.deepEqual(second, first);
  });

  it('出厂集 = 直连命令 + 两族结构化模板（侦察/核验）；**没有任何**出厂模板落在逐次放行类别里', async () => {
    // 2026-10-05 清理：五个示例模板删除（镜像里有真工具，Agent 直接写命令）。
    // 2026-10-06：新增 12 张 `recon_*`（类别 passive_collection/active_probing，不触发逐次放行）——
    // 这一族的意义就是「侦察不消耗人类审批预算，危险动作才消耗」。
    // 2026-10-07 免批裁定：`direct_command` 的类别改为 `active_probing` ⇒ 出厂集里**一张都不剩**。
    // 断言反转 = 反转那个决定；代价（放行卡不再对它显示命令原文、仅剩范围裁决与沙箱）写在
    // 执行层那条锁旁边（test/execution.test.ts 的「直连命令模板」用例）。
    const ids = DEFAULT_TEMPLATES.map((s) => s.template.id);
    assert.equal(ids[0], 'direct_command');
    assert.equal(ids.length, 17, `实际：${ids.join('、')}`);
    const freeForm = DEFAULT_TEMPLATES.filter((s) => s.allowFreeForm === true);
    assert.deepEqual(freeForm.map((s) => s.template.id), ['direct_command']);
    const perAction = DEFAULT_TEMPLATES.filter((s) =>
      (PER_ACTION_APPROVAL_CLASSES as readonly string[]).includes(s.template.actionClass),
    );
    assert.deepEqual(
      perAction.map((s) => s.template.id),
      [],
      '按 2026-10-07 裁定：没有任何出厂模板落在逐次放行类别里（改回只需把 direct_command 的类别改回 exploit_validation）',
    );
    const spec = DEFAULT_TEMPLATES[0]!;
    assert.equal(spec.allowFreeForm, true, '它就是要跑任意命令，黑名单由显式开关跳过');
    const verdict = await policy.classifyAction({
      templateId: 'direct_command',
      params: { port: 443, command_b64: Buffer.from('id', 'utf8').toString('base64') },
    });
    assert.deepEqual(verdict, { ok: true, actionClass: spec.template.actionClass });
    // 侦察族经同一入口判定：类别来自模板注册信息，不由参数决定。
    const reconVerdict = await policy.classifyAction({
      templateId: 'recon_port_scan',
      params: { scope: 'top1000', ports: 'none', ping: 'skip' },
    });
    assert.deepEqual(reconVerdict, { ok: true, actionClass: 'active_probing' });
  });

  it('注入的模板集就是生效的封闭集合：默认模板在注入后不再存在', async () => {
    const custom: ActionTemplateSpec = {
      template: {
        id: 'wipe_target',
        actionClass: 'destructive',
        tool: 'wipe_target',
        parameters: [{ name: 'mode', kind: 'enum', values: ['dry', 'real'] }],
        targetPlaceholder: 'target',
        timeoutMs: 5_000,
        maxOutputBytes: 4_096,
      },
      protocol: 'tcp',
      portSource: { kind: 'target' },
      carries: { mode: '执行模式；dry 仅演练' },
      commandTemplate: 'wipe_target target={target} mode={mode}',
    };
    const injected = new PgPolicyService(NO_DB, { templates: [custom] });
    assert.deepEqual(await injected.classifyAction({ templateId: 'wipe_target', params: { mode: 'dry' } }), {
      ok: true,
      actionClass: 'destructive',
    });
    const gone = await injected.classifyAction({
      templateId: 'http_read',
      params: { method: 'GET', path: '/', follow_redirects: 'false' },
    });
    assert.equal(gone.ok, false);
  });
});

// ───────────────────────────── 策略快照（纯逻辑） ─────────────────────────────

describe('策略快照 → 动作策略：默认严格（§10.3）', () => {
  it('快照缺失或形状非法时回落 DEFAULT_ACTION_POLICY', () => {
    for (const snapshot of [undefined, null, {}, 'x', 7, [], [1, 2]]) {
      assert.equal(actionPolicyFromSnapshot(snapshot), DEFAULT_ACTION_POLICY, String(snapshot));
    }
  });

  it('契约基线是下界：快照不能把逐次放行集合缩小', () => {
    const shrunk = actionPolicyFromSnapshot({ perActionApprovalClasses: ['passive_collection'] });
    for (const cls of PER_ACTION_APPROVAL_CLASSES) {
      assert.ok(shrunk.perActionApprovalClasses.includes(cls), `基线类别 ${cls} 不应被快照移除`);
    }
  });

  it('快照可以把逐次放行集合扩大（两种拼写都接受，且不重复）', () => {
    for (const key of ['perActionApprovalClasses', 'per_action_approval_classes', 'approval_required']) {
      const policy = actionPolicyFromSnapshot({ [key]: ['active_probing', 'exploit_validation'] });
      assert.deepEqual(
        [...policy.perActionApprovalClasses].sort(),
        ['active_probing', ...PER_ACTION_APPROVAL_CLASSES].sort(),
        key,
      );
    }
  });

  it('只有契约里默认禁用的类别才可能被开启，且必须携带双人确认位', () => {
    const enabled = actionPolicyFromSnapshot({
      enabledDisabledClasses: ['persistence', 'passive_collection', 'not_a_class'],
      dualConfirmed: true,
    });
    assert.deepEqual(enabled.enabledDisabledClasses, ['persistence']);
    assert.equal(enabled.dualConfirmed, true);
    assert.deepEqual(
      DEFAULT_DISABLED_CLASSES.filter((cls) => enabled.enabledDisabledClasses?.includes(cls)),
      ['persistence'],
    );
  });

  it('未双人确认时如实返回 false，让上层拒绝（本层不放宽）', () => {
    const policy = actionPolicyFromSnapshot({ enabledDisabledClasses: ['destructive'], dualConfirmed: false });
    assert.deepEqual(policy.enabledDisabledClasses, ['destructive']);
    assert.equal(policy.dualConfirmed, false);
    const missing = actionPolicyFromSnapshot({ enabled_disabled_classes: ['destructive'] });
    assert.equal(missing.dualConfirmed, false);
  });

  it('没有开启任何默认禁用类别时不带 enabledDisabledClasses 键', () => {
    const policy = actionPolicyFromSnapshot({ enabledDisabledClasses: ['passive_collection'] });
    assert.equal(policy, DEFAULT_ACTION_POLICY);
  });
});

// ───────────────────────────── 授权时效（纯逻辑） ─────────────────────────────

/**
 * §11.1 的授权硬边依赖「到期时间可信」。这里锁的是**三种形态不能合并**：
 *
 *   - 字段缺失 / 空串 → 未声明到期（合法且常见，向导不强制填）：放行；
 *   - 合法时间 → 按时间判；
 *   - 非空但读不懂 → **拒绝**。
 *
 * 第三条此前被并进第一条（返回 `null` = 不限制），于是一条改库语句就能静默移除硬边。
 * 用桩 DB 返回坏值即可覆盖，不需要真实 PostgreSQL——判定逻辑全在解析层。
 */
describe('授权时效：坏值 fail-closed（§11.1）', () => {
  const withExpiry = (expiresAt: string | null): DbClient => ({
    async query<Row = Record<string, unknown>>() {
      return { rows: [{ expires_at: expiresAt }] as Row[], rowCount: 1 };
    },
  });

  it('非空但不可解析的到期值为拒绝，而不是当成「未声明到期」', async () => {
    const policy = new PgPolicyService(withExpiry('2026-13-45 99:99'), FIXTURE_OPTIONS);
    const verdict = await policy.authorizationValidity(randomUUID());
    assert.equal(verdict.ok, false, '读不懂的到期时间不等于「不限制」');
    if (verdict.ok) return;
    // 处置与「已过期」相同：唯一出路是修正授权依据，因此复用同一个码。
    assert.equal(verdict.error.code, 'authorization_expired');
    assert.match(verdict.error.message, /无法解析/);
    assert.match(verdict.error.message, /2026-13-45/, '拒绝信息要带出坏值，否则无从修数据');
  });

  it('缺失或空串是「未声明到期」，仍然放行', async () => {
    for (const raw of [null, '', '   ']) {
      const policy = new PgPolicyService(withExpiry(raw), FIXTURE_OPTIONS);
      const verdict = await policy.authorizationValidity(randomUUID());
      assert.equal(verdict.ok, true, `${JSON.stringify(raw)} 应被当作未声明到期`);
      if (!verdict.ok) continue;
      assert.equal(verdict.expiresAt, null);
    }
  });

  it('合法时间原样返回，由调用方按当前时间判定是否过期', async () => {
    const policy = new PgPolicyService(withExpiry('2030-01-01T00:00:00Z'), FIXTURE_OPTIONS);
    const verdict = await policy.authorizationValidity(randomUUID());
    assert.equal(verdict.ok, true);
    if (!verdict.ok) return;
    assert.equal(verdict.expiresAt?.toISOString(), '2030-01-01T00:00:00.000Z');
  });

  it('engagement 标识非法时拒绝，不按「未声明到期」放行', async () => {
    // 桩不返回任何行；非法标识必须在发查询前就被拒。
    const policy = new PgPolicyService({
      query() {
        return Promise.reject(new Error('非法标识不该走到查询'));
      },
    } satisfies DbClient);
    const verdict = await policy.authorizationValidity('not-a-uuid');
    assert.equal(verdict.ok, false);
    if (verdict.ok) return;
    assert.equal(verdict.error.code, 'classification_rejected');
  });

  it('执行前复核对坏值同样返回 blocked（不放过旧计划）', async () => {
    // 桩按 SQL 文本分流：会话与范围版本都存在且一致，唯独授权到期是坏值——
    // 这正是「只有授权依据坏掉」这一种故障，判定必须落在授权那一条而不是别的复核项。
    const stub: DbClient = {
      async query<Row = Record<string, unknown>>(sql: string) {
        if (sql.includes('scope_snapshot')) {
          return { rows: [{ expires_at: 'garbage' }] as Row[], rowCount: 1 };
        }
        if (sql.includes('from pentest.worker_sessions')) {
          return {
            rows: [{
              engagement_id: randomUUID(),
              status: 'active',
              scope_version: 1,
              policy_epoch: 1,
              engagement_status: 'running',
            }] as Row[],
            rowCount: 1,
          };
        }
        // scope_versions 存在性查询：命中一行。
        return { rows: [{ present: 1 }] as Row[], rowCount: 1 };
      },
    };
    const policy = new PgPolicyService(stub, FIXTURE_OPTIONS);
    const verdict = await policy.validateExecution(plan({ scopeVersion: 1, policyEpoch: 1 }));
    assert.equal(verdict.ok, false);
    if (verdict.ok) return;
    assert.equal(verdict.error.code, 'authorization_expired');
    assert.match(verdict.error.message, /无法解析/);
  });
});

// ───────────────────────────── 存储故障（纯逻辑） ─────────────────────────────

/**
 * 政策存储不可用时的行为必须是「拒绝」，而不是「放行」或「伪装成范围外」。
 * 伪装成 `out_of_scope` 会让 §10.2.2 的范围违规计数把一次故障算成三次违规并触发自动暂停。
 */
describe('存储故障一律拒绝（fail-closed）', () => {
  const broken: DbClient = {
    query() {
      return Promise.reject(new Error('connection refused'));
    },
  };

  it('范围裁决返回 address_not_adjudicated，而不是 out_of_scope', async () => {
    const policy = new PgPolicyService(broken, FIXTURE_OPTIONS);
    const verdict = await policy.evaluateScope({
      engagementId: randomUUID(),
      scopeVersion: 1,
      target: '10.20.0.5',
      protocol: 'tcp',
      port: 80,
    });
    assert.equal(verdict.ok, false);
    if (verdict.ok) return;
    assert.equal(verdict.code, 'address_not_adjudicated');
    assert.match(verdict.detail, /范围裁决不可用/);
  });

  it('执行前复核返回 blocked + target_not_adjudicated', async () => {
    const policy = new PgPolicyService(broken, FIXTURE_OPTIONS);
    const verdict = await policy.validateExecution(plan({ scopeVersion: 1, policyEpoch: 1 }));
    assert.equal(verdict.ok, false);
    if (verdict.ok) return;
    assert.equal(verdict.error.status, 'blocked');
    assert.equal(verdict.error.code, 'target_not_adjudicated');
    assert.match(verdict.error.message, /复核不可用/);
  });

  it('动作策略回落到默认（严格）策略', async () => {
    const actions = new PgActionPolicySource(broken);
    assert.equal(await actions.forSession(randomUUID()), DEFAULT_ACTION_POLICY);
  });

  it('会话绑定不被吞掉：存储故障向上抛，不伪装成「会话不存在」', async () => {
    const sessions = new PgSessionDirectory(broken);
    await assert.rejects(() => sessions.binding(randomUUID()), /connection refused/);
  });
});

// ───────────────────────────── 集成（可选） ─────────────────────────────

const DATABASE_URL = process.env['PENTEST_DATABASE_URL'];

// ───────────────────────────── 共享库清理夹具 ─────────────────────────────
//
// 这些集成用例跑在**共享**数据库上，且与兄弟测试文件并行。compose.test.ts 里的 `apply()`
// 会触发 `StartupRecovery.recoverAll()`——对账是**全库扫描**，会把本文件刚建、尚未心跳的
// 会话判为「无主」，并为它补写审计行（context_events / ledger_anchors / outbox_jobs）。
// 这些行通过外键把 worker_sessions 钉住，于是「删自己的种子数据」会被兄弟测试写的数据挡住
// （实测：23503 context_events_worker_session_id_fkey）。而 §9.5 的追加写触发器又拒绝
// DELETE 事件行，靠 `.catch()` 吞掉只会留下静默残留。
//
// 因此：在**同一条连接**上临时切到 replica 角色（用户触发器与 FK 触发器都不触发），
// 按外键依赖倒序删除，删完立刻切回 origin。`session_replication_role` 是**会话级**设置：
// `pool.query` 每次可能借出不同的连接，因此清理必须在显式取得的那一条连接上完成。

/** 先断开两处外键环：tool_runs ↔ approvals、engagements.active_agent_session_id ↔ worker_sessions。
 *  replica 角色下并不必要，但留着可让随后的倒序删除自身自洽。 */
const RING_BREAKERS = [
  'update pentest.approvals set consumed_by_tool_run = null where engagement_id = any($1::uuid[])',
  'update pentest.engagements set active_agent_session_id = null where id = any($1::uuid[])',
] as const;

/** 按外键依赖倒序删除：引用方在前、被引用方在后；末两项固定是 worker_sessions → engagements。 */
const CLEANUP_STATEMENTS = [
  'delete from pentest.retrieval_hits where query_id in (select id from pentest.retrieval_queries where engagement_id = any($1::uuid[]))',
  'delete from pentest.retrieval_queries where engagement_id = any($1::uuid[])',
  'delete from pentest.request_snapshots where engagement_id = any($1::uuid[])',
  'delete from pentest.memory_access_log where engagement_id = any($1::uuid[])',
  'delete from pentest.memory_chunks where engagement_id = any($1::uuid[])',
  // findings.origin_memory_item_id 指向 memory_items：引用方必须先走。
  'delete from pentest.findings where engagement_id = any($1::uuid[])',
  'delete from pentest.memory_items where engagement_id = any($1::uuid[])',
  'delete from pentest.reports where engagement_id = any($1::uuid[])',
  'delete from pentest.state_transitions where engagement_id = any($1::uuid[])',
  'delete from pentest.handoffs where engagement_id = any($1::uuid[])',
  'delete from pentest.worker_reports where engagement_id = any($1::uuid[])',
  // artifacts.tool_run_id 指向 tool_runs：引用方必须先走。
  'delete from pentest.artifacts where engagement_id = any($1::uuid[])',
  'delete from pentest.tool_runs where engagement_id = any($1::uuid[])',
  'delete from pentest.llm_calls where engagement_id = any($1::uuid[])',
  'delete from pentest.approvals where engagement_id = any($1::uuid[])',
  'delete from pentest.session_leases where engagement_id = any($1::uuid[])',
  'delete from pentest.outbox_jobs where engagement_id = any($1::uuid[])',
  'delete from pentest.index_watermarks where engagement_id = any($1::uuid[])',
  'delete from pentest.asset_scope_versions where engagement_id = any($1::uuid[])',
  'delete from pentest.assets where engagement_id = any($1::uuid[])',
  'delete from pentest.scope_versions where engagement_id = any($1::uuid[])',
  'delete from pentest.context_events where engagement_id = any($1::uuid[])',
  'delete from pentest.ledger_anchors where engagement_id = any($1::uuid[])',
  'delete from pentest.human_decisions where engagement_id = any($1::uuid[])',
  'delete from pentest.embedding_revisions where engagement_id = any($1::uuid[])',
  'delete from pentest.worker_sessions where engagement_id = any($1::uuid[])',
  // policy_versions 也引用 engagements：先删子表，engagements 才删得掉。
  'delete from pentest.policy_versions where engagement_id = any($1::uuid[])',
  'delete from pentest.engagements where id = any($1::uuid[])',
] as const;

describe('集成：真实 PostgreSQL', { skip: DATABASE_URL === undefined ? '未设置 PENTEST_DATABASE_URL' : false }, () => {
  // 清理需要拿到原始 Pool（`connect()`）：`session_replication_role` 是会话级设置，
  // 必须在同一条连接上收发，不能让 `pool.query` 随机借连接。
  let pool: (DbClient & Pick<Pool, 'connect'> & { end: () => Promise<void> }) | null = null;
  let policy: PgPolicyService;
  let sessions: PgSessionDirectory;
  let actions: PgActionPolicySource;

  // engagement A：范围版本 1/3/4 + 策略快照；engagement B：空策略快照。
  let engagementId = '';
  let bareEngagementId = '';
  let sessionId = '';
  let bareSessionId = '';
  let revokedLeaseSessionId = '';
  let staleScopeSessionId = '';
  const POLICY_EPOCH = 7;

  before(async () => {
    const created = new Pool({ connectionString: DATABASE_URL });
    pool = created as unknown as DbClient & Pick<Pool, 'connect'> & { end: () => Promise<void> };
    engagementId = randomUUID();
    bareEngagementId = randomUUID();
    sessionId = randomUUID();
    bareSessionId = randomUUID();
    revokedLeaseSessionId = randomUUID();
    staleScopeSessionId = randomUUID();

    await created.query(
      `insert into pentest.engagements
         (id, tenant_id, name, status, current_status, policy_epoch, target_snapshot, scope_snapshot,
          roe_snapshot, policy_snapshot, config_snapshot, created_by)
       values ($1, 'pg-policy', 'pg-policy-integration', 'running', 'ready', $2,
               '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, $3::jsonb, '{}'::jsonb, 'node-test'),
              ($4, 'pg-policy', 'pg-policy-integration-bare', 'running', 'ready', 0,
               '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, 'node-test')`,
      [
        engagementId,
        POLICY_EPOCH,
        {
          per_action_approval_classes: ['active_probing'],
          enabled_disabled_classes: ['persistence'],
          dual_confirmed: true,
        },
        bareEngagementId,
      ],
    );

    const scopeTargets = [
      { kind: 'ip', value: '10.20.0.5', protocols: ['tcp'], ports: [{ from: 80, to: 80 }, { from: 443, to: 443 }] },
      { kind: 'cidr', value: '10.20.1.0/24', protocols: ['tcp'], ports: [{ from: 8080, to: 8080 }] },
      { kind: 'domain', value: 'target.example', protocols: ['tcp'], ports: [{ from: 80, to: 80 }] },
      { kind: 'domain', value: 'shared.example', protocols: ['tcp'], ports: [{ from: 80, to: 80 }] },
      { kind: 'asset-label', value: '@web', protocols: ['tcp'], ports: [{ from: 80, to: 80 }] },
    ];
    const scopeExclusions = [
      { kind: 'ip', value: '10.20.0.9', protocols: ['tcp'], ports: [{ from: 80, to: 80 }] },
      { kind: 'cidr', value: '10.20.1.0/25', protocols: ['tcp'], ports: [{ from: 8080, to: 8080 }] },
    ];
    await created.query(
      `insert into pentest.scope_versions
         (engagement_id, version, iteration, targets, exclusions, changed_by, content_hash)
       values ($1, 1, 1, $2::jsonb, $3::jsonb, 'node-test', 'sha256:v1'),
              -- 版本 3/4 是坏数据：形状非法即整份范围拒绝加载（§10.2.2 加载范围时报错）
              ($1, 3, 1, $4::jsonb, '[]'::jsonb, 'node-test', 'sha256:v3'),
              ($1, 4, 1, '{}'::jsonb, '[]'::jsonb, 'node-test', 'sha256:v4'),
              -- 版本 5 形状合法但语义非法（网段未声明端口），由 scope.ts 判定
              ($1, 5, 1, $5::jsonb, '[]'::jsonb, 'node-test', 'sha256:v5')`,
      [
        engagementId,
        // jsonb 参数必须显式序列化：pg 会把 JS 数组当 Postgres 数组字面量（`{...}`），
        // 而不是 JSON 文本，直接 cast 会得到 22P02。
        JSON.stringify(scopeTargets),
        JSON.stringify(scopeExclusions),
        JSON.stringify([
          { kind: 'domain', value: 'broken.example', protocols: ['tcp'], ports: [] },
          { kind: 'domain', protocols: ['tcp'], ports: [] },
        ]),
        JSON.stringify([{ kind: 'cidr', value: '10.20.3.0/24', protocols: ['tcp'], ports: [] }]),
      ],
    );

    // 资产：登记了标签的资产才进入标签展开集合；决策写入 asset_scope_versions。
    const assetRows: readonly (readonly [string, string, readonly string[]])[] = [
      ['10.20.0.77', 'ip', ['web']],
      ['10.20.2.10', 'ip', ['@web']],
      // 无标签：只走资产裁决路径，用来单独验证 pending
      ['10.20.2.11', 'ip', []],
      // 未在范围版本 1 内登记（没有 asset_scope_versions 行）：不得借标签进入范围
      ['10.20.2.12', 'ip', ['web']],
      // 有标签且在本版本登记为 pending：见「包含项与 pending 的优先级」用例
      ['10.20.2.13', 'ip', ['web']],
    ];
    const assetIds: string[] = [];
    for (const [canonical, kind, labels] of assetRows) {
      const inserted = await created.query<{ id: string }>(
        `insert into pentest.assets (engagement_id, canonical_target, kind, labels, first_seen_iteration)
         values ($1, $2, $3, $4::jsonb, 1)
         returning id`,
        [engagementId, canonical, kind, JSON.stringify(labels)],
      );
      assetIds.push(inserted.rows[0]?.id ?? '');
    }
    const decisions: readonly (readonly [number, string])[] = [
      [0, 'included'],
      [1, 'excluded'],
      [2, 'pending'],
      [4, 'pending'],
    ];
    for (const [index, decision] of decisions) {
      await created.query(
        `insert into pentest.asset_scope_versions (asset_id, scope_version, engagement_id, decision, decided_by)
         values ($1, 1, $2, $3, 'operator-test')`,
        [assetIds[index], engagementId, decision],
      );
    }

    await created.query(
      `insert into pentest.worker_sessions
         (id, engagement_id, dsh_session_id, phase, profile_id, profile_revision, scope_version,
          task_prompt, tool_filter, skill_ids, model_route, status)
       values ($1, $2, $3, 'intelligence-gathering', 'p', 'r1', 1, 'tp', '{}'::jsonb, '[]'::jsonb, '{}'::jsonb, 'active'),
              ($4, $5, $6, 'intelligence-gathering', 'p', 'r1', 1, 'tp', '{}'::jsonb, '[]'::jsonb, '{}'::jsonb, 'active'),
              -- worker_sessions_one_live_per_engagement 只允许每个 engagement 一个存活会话，
              -- 因此另外两个用于边界用例的会话取终态（closed / superseded）。
              ($7, $2, $8, 'intelligence-gathering', 'p', 'r1', 1, 'tp', '{}'::jsonb, '[]'::jsonb, '{}'::jsonb, 'closed'),
              -- 绑定的范围版本在数据库中不存在：用于「范围版本被移除」的复核路径
              ($9, $2, $10, 'intelligence-gathering', 'p', 'r1', 42, 'tp', '{}'::jsonb, '[]'::jsonb, '{}'::jsonb, 'superseded')`,
      [
        sessionId,
        engagementId,
        `dsh-${sessionId}`,
        bareSessionId,
        bareEngagementId,
        `dsh-${bareSessionId}`,
        revokedLeaseSessionId,
        `dsh-${revokedLeaseSessionId}`,
        staleScopeSessionId,
        `dsh-${staleScopeSessionId}`,
      ],
    );

    await created.query(
      `insert into pentest.session_leases
         (engagement_id, worker_session_id, task_ref, generation, expires_at, revoked_at, revoked_reason)
       values ($1, $2, 'task-a', 3, now() + interval '10 minutes', null, null),
              ($1, $3, 'task-a', 1, now() + interval '10 minutes', now(), 'closed')`,
      [engagementId, sessionId, revokedLeaseSessionId],
    );

    const db = created as unknown as DbClient;
    policy = new PgPolicyService(db, {
      ...FIXTURE_OPTIONS,
      // DNS 裁决由 Host 侧注入（§10.2.2 地址固定）；本层不查 DNS。
      resolveAddresses: async (host) => {
        if (host === 'target.example') return ['10.20.0.5'];
        if (host === 'shared.example') return ['10.20.0.9'];
        return undefined;
      },
    });
    sessions = new PgSessionDirectory(db);
    actions = new PgActionPolicySource(db);
  });

  /**
   * 清理本文件自己造的两个 engagement 下的全部种子数据（含兄弟测试对账时补写的审计行）。
   *
   * 用**同一条连接**收发 `SET session_replication_role`：它是会话级设置，
   * 用 `pool.query` 设只影响当时借出的那条连接，删表却可能落在另一条上。
   */
  async function cleanupEngagements(ids: readonly string[]): Promise<void> {
    if (pool === null) return;
    const client = await pool.connect();
    // 只在 replica 确实生效后才需要恢复：若 SET 本身失败，再发一条同样会失败的
    // origin 只会掩盖原始错误，而那时连接上并没有 replica 状态可恢复。
    let replicaActive = false;
    try {
      // 用户触发器与 FK 触发器都不触发；该设置只作用于 teardown 的这条连接。
      await client.query("SET session_replication_role = 'replica'");
      replicaActive = true;
      for (const statement of RING_BREAKERS) await client.query(statement, [ids]);
      for (const statement of CLEANUP_STATEMENTS) await client.query(statement, [ids]);
    } finally {
      try {
        // 恢复不能被吞：这条连接之后会回到池里继续被别的查询借用，
        // 带着 replica 语义（触发器/FK 失效）会让后续写入静默失去保护。
        if (replicaActive) await client.query("SET session_replication_role = 'origin'");
      } finally {
        client.release();
      }
    }
  }

  after(async () => {
    if (pool === null) return;
    // 清理失败必须冒泡（原先逐句 `.catch(() => undefined)` 会把 23503 静默吞掉，
    // 留下一整套 engagement + 会话 + 事件，直到拖垮某个兄弟测试文件的清理）。
    await cleanupEngagements([engagementId, bareEngagementId]);
    await pool.end();
  });

  const scopeOf = (target: string, port: number | undefined, version = 1): Promise<ScopeVerdict> =>
    policy.evaluateScope({
      engagementId,
      scopeVersion: version,
      target,
      protocol: 'tcp',
      ...(port === undefined ? {} : { port }),
    });

  it('范围内目标通过，并带上已裁决地址（地址固定）', async () => {
    const normalized = accepted(await scopeOf('10.20.0.5', 80));
    assert.equal(normalized.host, '10.20.0.5');
    assert.deepEqual(normalized.resolvedAddresses, ['10.20.0.5']);

    const viaDomain = accepted(await scopeOf('target.example', 80));
    assert.equal(viaDomain.host, 'target.example');
    assert.deepEqual(viaDomain.resolvedAddresses, ['10.20.0.5']);

    const viaCidr = accepted(await scopeOf('10.20.1.200', 8080));
    assert.equal(viaCidr.host, '10.20.1.200');
  });

  it('范围外目标被拒（out_of_scope）', async () => {
    const verdict = await scopeOf('10.30.0.99', 80);
    const { code, detail } = rejection(verdict);
    assert.equal(code, 'out_of_scope');
    assert.match(detail, /不在会话绑定的范围版本内/);

    const subdomain = await scopeOf('a.target.example', 80);
    assert.equal(rejection(subdomain).code, 'out_of_scope');
  });

  it('排除项优先于包含项（IP 与网段两种形态）', async () => {
    const excludedIp = rejection(await scopeOf('10.20.0.9', 80));
    assert.equal(excludedIp.code, 'excluded');
    // 10.20.1.100 同时落在包含的 /24 与排除的 /25 内：按排除处理
    const excludedCidr = rejection(await scopeOf('10.20.1.100', 8080));
    assert.equal(excludedCidr.code, 'excluded');
    // 同网段但不在排除范围内：仍然通过，证明上一条不是「整个 /24 被排除」
    assert.equal(accepted(await scopeOf('10.20.1.200', 8080)).host, '10.20.1.200');
  });

  it('解析出的地址落在排除基础设施上时按排除处理', async () => {
    const { code, detail } = rejection(await scopeOf('shared.example', 80));
    assert.equal(code, 'excluded');
    assert.match(detail, /10\.20\.0\.9/);
  });

  it('域名目标缺 DNS 裁决结果时拒绝，不退化为按域名拨号', async () => {
    const noResolver = new PgPolicyService(pool as DbClient);
    const verdict = await noResolver.evaluateScope({
      engagementId,
      scopeVersion: 1,
      target: 'target.example',
      protocol: 'tcp',
      port: 80,
    });
    assert.equal(rejection(verdict).code, 'dns_unresolved');
  });

  it('端口与协议未授权时分别给出稳定拒绝码', async () => {
    assert.equal(rejection(await scopeOf('10.20.0.5', 8080)).code, 'port_not_allowed');
    const wrongProtocol = await policy.evaluateScope({
      engagementId,
      scopeVersion: 1,
      target: '10.20.0.5',
      protocol: 'udp',
      port: 80,
    });
    assert.equal(rejection(wrongProtocol).code, 'protocol_not_allowed');
  });

  it('资产标签按当前范围版本内登记的资产展开（未登记的资产不进入范围）', async () => {
    assert.equal(accepted(await scopeOf('10.20.0.77', 80)).host, '10.20.0.77');
    // 有标签但未在本范围版本登记决策：不得借标签进入范围
    assert.equal(rejection(await scopeOf('10.20.2.12', 80)).code, 'out_of_scope');
  });

  it('资产裁决 excluded / pending 分别拒绝', async () => {
    // excluded 的判定先于包含项求值，因此标签展开也拦不住它
    assert.equal(rejection(await scopeOf('10.20.2.10', 80)).code, 'excluded');
    // 无标签、只经由资产裁决被拒的目标
    assert.equal(rejection(await scopeOf('10.20.2.11', 80)).code, 'pending');
  });

  /**
   * pending 必须短路返回，与 excluded 同级。
   *
   * 这条用例曾以「已知不一致，待裁决」的形式记录了一个真实缺陷：`scope.ts` 的
   * `better()` 把「通过」排在「待裁决」之前，因此当一个资产既是 `asset-label`
   * 条目的成员、又在 `asset_scope_versions` 里被裁决为 `pending` 时会被放行——
   * 人类的「尚未裁决」被范围条目的宽泛匹配绕过。
   *
   * Main 已裁决：pending 与 excluded 同级短路（逐资产裁决比范围条目更具体、更新），
   * 该行为已在 `scope.ts` 修正，本用例随之改为断言 `pending`。
   */
  it('pending 优先于包含项：既在标签内又被裁决为 pending 的目标被拒', async () => {
    assert.equal(rejection(await scopeOf('10.20.2.13', 80)).code, 'pending');
  });

  it('范围版本不存在时拒绝（不读最新版本、不当作全部在范围内）', async () => {
    const { code, detail } = rejection(await scopeOf('10.20.0.5', 80, 999));
    assert.equal(code, 'out_of_scope');
    assert.match(detail, /不存在/);
  });

  it('范围条目形状非法即整份拒绝加载（不跳过坏条目）', async () => {
    for (const version of [3, 4]) {
      const { code, detail } = rejection(await scopeOf('10.20.0.5', 80, version));
      assert.equal(code, 'malformed_target', `版本 ${version}`);
      assert.match(detail, /无法加载|不是对象|不是数组/);
    }
  });

  it('语义校验仍由 scope.ts 判定（版本 5 的网段条目留空端口 = 默认 80/443）', async () => {
    // 版本 5 的夹具是 `cidr 10.20.3.0/24 + tcp + ports: []`。这条**不再**被拒：
    // 留空端口对所有 kind 都按默认 80/443 展开（见 scope.test.ts 的 F1）。
    // 这条测试的意图是「语义校验真的由 scope.ts 做了，而不是数据库层漏过去」，
    // 因此正向断言它被接受、且**端口确实收窄到 80/443**——那才是边界所在。
    const inRange = accepted(await scopeOf('10.20.3.10', 443, 5));
    assert.equal(inRange.host, '10.20.3.10');
    // 匹配期端口不匹配的码是 `port_not_allowed`（不是 `out_of_scope`——那个留给「主机不在范围内」）。
    const { code } = rejection(await scopeOf('10.20.3.10', 8080, 5));
    assert.equal(code, 'port_not_allowed', '留空端口不等于任意端口：8080 必须被拒');
  });

  it('会话不存在或缺席 uuid 形态时 binding 返回 undefined', async () => {
    assert.equal(await sessions.binding(randomUUID()), undefined);
    assert.equal(await sessions.binding('sess-1'), undefined);
    assert.equal(await sessions.binding(''), undefined);
  });

  it('binding 组装会话冻结的范围版本、策略 epoch 与未吊销租约', async () => {
    const binding = await sessions.binding(sessionId);
    assert.ok(binding);
    assert.equal(binding.engagementId, engagementId);
    assert.equal(binding.status, 'active');
    assert.equal(binding.scopeVersion, 1);
    assert.equal(binding.policyEpoch, POLICY_EPOCH);
    assert.equal(binding.lease?.generation, 3);
    assert.equal(binding.lease?.revokedAt, null);
    assert.equal(binding.lease?.revokedReason, null);
    assert.equal(binding.lease?.workerSessionId, sessionId);
  });

  it('租约被吊销后 binding 的 lease 为 null（不复活旧世代）', async () => {
    const binding = await sessions.binding(revokedLeaseSessionId);
    assert.ok(binding);
    assert.equal(binding.lease, null);
  });

  it('未注册模板在真实库路径上同样返回失败', async () => {
    const failure = await policy.classifyAction({ templateId: 'scan_everything', params: { ports: '1-65535' } });
    assert.equal(failure.ok, false);
  });

  it('策略快照缺失时回落默认（严格）策略', async () => {
    assert.equal(await actions.forSession(bareSessionId), DEFAULT_ACTION_POLICY);
    assert.equal(await actions.forSession(randomUUID()), DEFAULT_ACTION_POLICY);
    assert.equal(await actions.forSession('sess-1'), DEFAULT_ACTION_POLICY);
    assert.deepEqual(DEFAULT_ACTION_POLICY.perActionApprovalClasses, PER_ACTION_APPROVAL_CLASSES);
    assert.equal(DEFAULT_ACTION_POLICY.enabledDisabledClasses, undefined);
  });

  it('策略快照存在时读回逐次放行与已开启的默认禁用类别', async () => {
    const snapshot = await actions.forSession(sessionId);
    assert.deepEqual(
      [...snapshot.perActionApprovalClasses].sort(),
      ['active_probing', ...PER_ACTION_APPROVAL_CLASSES].sort(),
    );
    assert.deepEqual(snapshot.enabledDisabledClasses, ['persistence']);
    assert.equal(snapshot.dualConfirmed, true);
  });

  it('validateExecution：模板与类别复核', async () => {
    const ok = await policy.validateExecution(plan({ workerSessionId: sessionId, policyEpoch: POLICY_EPOCH }));
    assert.deepEqual(ok, { ok: true });

    const unregistered = await policy.validateExecution(
      plan({ workerSessionId: sessionId, templateId: 'scan_everything', policyEpoch: POLICY_EPOCH }),
    );
    assert.equal(unregistered.ok, false);
    if (!unregistered.ok) assert.equal(unregistered.error.code, 'classification_rejected');

    const drifted = await policy.validateExecution(
      plan({ workerSessionId: sessionId, actionClass: 'active_probing', policyEpoch: POLICY_EPOCH }),
    );
    assert.equal(drifted.ok, false);
    if (!drifted.ok) {
      assert.equal(drifted.error.code, 'classification_rejected');
      assert.match(drifted.error.message, /类别复算不一致/);
    }
  });

  it('validateExecution：策略版本前进即拒绝（暂停不推进 epoch，因此不在此列）', async () => {
    const stale = await policy.validateExecution(plan({ workerSessionId: sessionId, policyEpoch: POLICY_EPOCH - 1 }));
    assert.equal(stale.ok, false);
    if (!stale.ok) {
      assert.equal(stale.error.code, 'stale_state_version');
      assert.match(stale.error.message, /策略版本已前进/);
      assert.equal(stale.error.status, 'blocked');
    }
  });

  it('validateExecution：会话冻结的范围版本与计划不一致即拒绝', async () => {
    const mismatch = await policy.validateExecution(
      plan({ workerSessionId: sessionId, scopeVersion: 2, policyEpoch: POLICY_EPOCH }),
    );
    assert.equal(mismatch.ok, false);
    if (!mismatch.ok) assert.equal(mismatch.error.code, 'stale_state_version');
  });

  it('validateExecution：会话不存在即拒绝', async () => {
    const missing = await policy.validateExecution(plan({ workerSessionId: randomUUID(), policyEpoch: POLICY_EPOCH }));
    assert.equal(missing.ok, false);
    if (!missing.ok) assert.equal(missing.error.code, 'stale_state_version');
  });

  it('validateExecution：计划绑定的范围版本已不存在即拒绝', async () => {
    const gone = await policy.validateExecution(
      plan({ workerSessionId: staleScopeSessionId, scopeVersion: 42, policyEpoch: POLICY_EPOCH }),
    );
    assert.equal(gone.ok, false);
    if (!gone.ok) {
      assert.equal(gone.error.code, 'scope_violation');
      assert.match(gone.error.message, /范围版本 42 已不存在/);
    }
  });
});
