/**
 * 报告服务装配层测试（设计文档 §8.9 结论生命周期、§11.3 凭据与敏感信息、§14.4 报告内容、§16.1.1）。
 *
 * 两类用例：
 *   - **纯逻辑**（始终运行）：§8.9 的分节映射表、签字前置条件判定、脱敏只作用于渲染期副本；
 *   - **集成**（仅在设置了 `PENTEST_DATABASE_URL` 时运行）：处置的四种状态转移、拒绝必填理由、
 *     严重度人工覆盖、证据引用在处置与脱敏前后逐字节不变、报告版本递增不覆盖、
 *     导出元数据与哈希自洽。
 *
 * 为什么必须跑真实 PostgreSQL：`findings.evidence_refs` 是 `uuid[]`、`state_version` 是 `bigint`
 * （`pg` 返回字符串）、`reports` 有 `UNIQUE (engagement_id, version)`、`human_decisions` 是
 * §9.5 的 A 类只追加表（触发器拒绝 UPDATE/DELETE）——这些只有真实库才会暴露。
 * 假 DB 不模拟唯一索引与触发器，会掩盖「版本覆盖」与「处置理由被改写」这类真缺陷。
 *
 * 连接用 `pg.Client`（单连接）而不是 Pool：处置与版本号分配都在 `begin`/`commit` 之间进行，
 * 而 `reports` 版本号分配依赖 engagement 级 advisory xact lock；BEGIN 与 COMMIT 落到不同连接
 * 会静默失效（不报错，只是不原子）。连接用超级用户：002 已启用 RLS（FORCE），
 * 本文件测的是数据装配与映射，不是 RLS 行为本身。
 */

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import { Client } from 'pg';

import type { Finding, FindingStatus, ReportSection } from '../src/contracts.ts';
import { REPORT_SECTIONS } from '../src/contracts.ts';
import type { DbClient } from '../src/db/port.ts';
import { sha256Hex } from '../src/memory/chunks.ts';
import type { FindingProjection, ReportProjection } from '../src/report/pg-report.ts';
import {
  PgReportService,
  ReportServiceError,
  applyRedactions,
  isUndisposed,
  parseReportProjection,
  renderReportMarkdown,
  sectionOf,
} from '../src/report/pg-report.ts';

// ───────────────────────────── 辅助 ─────────────────────────────

/** 不应被访问的数据库：用来证明纯逻辑用例不碰库。 */
const NO_DB: DbClient = {
  query() {
    return Promise.reject(new Error('该用例不应访问数据库'));
  },
};

function fixtureProjection(): ReportProjection {
  return {
    kind: 'pentest.report.projection',
    engagementId: 'e-1',
    version: 1,
    engagement: {
      name: '靶场 A',
      status: 'running',
      currentStatus: 'report_ready',
      currentPhase: 'exploitation',
      stateVersion: 5,
    },
    phaseTimeline: [],
    sections: REPORT_SECTIONS.map((section) => ({
      section,
      findings:
        section === 'unverified_candidates'
          ? [
              {
                id: 'f-1',
                title: '弱口令',
                severity: 'high',
                status: 'candidate',
                section,
                affectedAssetIds: [],
                evidence: [
                  {
                    ref: 'a-secret',
                    available: true,
                    kind: 'capture',
                    mediaType: 'text/plain',
                    byteSize: 12,
                    classification: 'credential-like',
                    truncated: false,
                  },
                ],
                reproductionSteps: [],
                impact: null,
                remediation: null,
                confidence: null,
                acceptedBy: null,
                acceptedAt: null,
                dispositionAction: 'defer',
                dispositionReason: '等待复现环境',
                dispositionOperatorId: 'op-1',
                dispositionAt: '2026-01-01T00:00:00.000Z',
              },
            ]
          : [],
    })),
    undisposedFindingIds: [],
    supersededFindingIds: [],
    acceptedFindingIds: [],
  };
}

// ───────────────────────────── §8.9 分节映射（纯逻辑）─────────────────────────────

describe('§8.9 报告分节映射（纯逻辑）', () => {
  it('状态与最新处置共同决定分节，暂缓与未处置必须分开', () => {
    const cases: readonly (readonly [FindingStatus, 'accept' | 'reject' | 'defer' | null, ReportSection | null])[] = [
      ['human_accepted', 'accept', 'verified_findings'],
      ['rejected', 'reject', 'assessed_not_confirmed'],
      ['candidate', 'defer', 'unverified_candidates'],
      ['validation_pending', 'defer', 'unverified_candidates'],
      ['validated', 'defer', 'unverified_candidates'],
      ['candidate', null, 'awaiting_review'],
      ['validation_pending', null, 'awaiting_review'],
      ['validated', null, 'awaiting_review'],
      // 已被取代的历史结论不进任何分节（§8.9：取代关系交由人类审阅，不冒充当前结论）
      ['superseded', null, null],
      // 状态优先于处置记录：接受后又被暂缓，仍是已验证结论
      ['human_accepted', 'defer', 'verified_findings'],
      ['rejected', 'defer', 'assessed_not_confirmed'],
    ];
    for (const [status, disposition, expected] of cases) {
      assert.equal(
        sectionOf(status, disposition),
        expected,
        `status=${status} disposition=${String(disposition)}`,
      );
    }
  });

  it('签字前置条件：只有从未被处置的候选态结论阻塞签字，暂缓不算未处置', () => {
    assert.equal(isUndisposed('candidate', null), true);
    assert.equal(isUndisposed('validation_pending', null), true);
    assert.equal(isUndisposed('validated', null), true);
    assert.equal(isUndisposed('candidate', 'defer'), false);
    assert.equal(isUndisposed('validated', 'defer'), false);
    assert.equal(isUndisposed('human_accepted', null), false);
    assert.equal(isUndisposed('rejected', null), false);
    assert.equal(isUndisposed('superseded', null), false);
  });

  it('脱敏只改渲染期副本：原文引用与未知分类都按敏感处理', () => {
    const projection = fixtureProjection();
    const before = structuredClone(projection);
    const { projection: redacted, redactedCount } = applyRedactions(projection, new Set(['credential-like']));

    assert.equal(redactedCount, 1);
    assert.deepEqual(projection, before, '脱敏不得改动传入的投影');
    const entry = redacted.sections.find((s) => s.section === 'unverified_candidates')?.findings[0]?.evidence[0];
    assert.equal(entry?.redacted, true);
    assert.equal(entry?.mediaType, null);
    assert.equal(entry?.byteSize, null);
    // 未请求脱敏时原样保留详情
    assert.equal(applyRedactions(projection, new Set<string>()).redactedCount, 0);

    // artifacts.classification 列没有 CHECK 约束：越界值在请求了脱敏时不能当作可公开
    const unknown = fixtureProjection();
    const withUnknown: ReportProjection = {
      ...unknown,
      sections: unknown.sections.map((section) => ({
        ...section,
        findings: section.findings.map((finding) => ({
          ...finding,
          evidence: finding.evidence.map((evidence) => ({ ...evidence, classification: 'weird-value' })),
        })),
      })),
    };
    assert.equal(applyRedactions(withUnknown, new Set(['credential-like'])).redactedCount, 1);
  });

  it('渲染是确定性的，且报告列出四个分节', () => {
    const projection = fixtureProjection();
    const first = renderReportMarkdown(projection);
    assert.equal(renderReportMarkdown(projection), first);
    for (const section of REPORT_SECTIONS) {
      assert.match(first, new RegExp(`（${section}）`), `报告应包含分节 ${section}`);
    }
    // 暂缓项必须标注「未经确认」，否则报告会把未定论当成已证实（§8.9）
    assert.match(first, /未经确认/);
  });

  it('§8.9 严重度标注按分节区分：只有人工确认分节标「人工确认值」', () => {
    const base = fixtureProjection();
    const statusFor: Record<ReportSection, FindingStatus> = {
      verified_findings: 'human_accepted',
      assessed_not_confirmed: 'rejected',
      unverified_candidates: 'candidate',
      awaiting_review: 'candidate',
    };
    const findingIn = (section: ReportSection): FindingProjection => ({
      id: `f-${section}`,
      title: `${section} 结论`,
      severity: 'medium',
      status: statusFor[section],
      section,
      affectedAssetIds: [],
      evidence: [],
      reproductionSteps: [],
      impact: null,
      remediation: null,
      confidence: null,
      acceptedBy: null,
      acceptedAt: null,
      dispositionAction: null,
      dispositionReason: null,
      dispositionOperatorId: null,
      dispositionAt: null,
    });
    const projection: ReportProjection = {
      ...base,
      sections: REPORT_SECTIONS.map((section) => ({ section, findings: [findingIn(section)] })),
    };
    const content = renderReportMarkdown(projection);
    const blockOf = (section: ReportSection): string => {
      const marker = `（${section}）`;
      const start = content.indexOf(marker);
      assert.ok(start >= 0, `报告应包含分节 ${section}`);
      const rest = content.slice(start + marker.length);
      const end = rest.indexOf('\n## ');
      return end === -1 ? rest : rest.slice(0, end);
    };

    const verified = blockOf('verified_findings');
    assert.match(verified, /- 严重度：medium（人工确认值）/);
    assert.doesNotMatch(verified, /Agent 建议值/);

    // 其余分节的人类动作是暂缓 / 拒绝 / 未处置，从未确认严重度，不得标「人工确认值」。
    for (const section of ['assessed_not_confirmed', 'unverified_candidates', 'awaiting_review'] as const) {
      const block = blockOf(section);
      assert.match(block, /- 严重度：medium（Agent 建议值，未经人工确认）/, section);
      assert.doesNotMatch(block, /人工确认值/, `分节 ${section} 不得把 Agent 建议冒充人工确认`);
    }
  });

  it('无库依赖：纯逻辑用例不访问数据库', async () => {
    const service = new PgReportService(NO_DB);
    await assert.rejects(() => service.getReportDraft('e-1'), /该用例不应访问数据库/);
  });
});

// ───────────────────────────── 集成 ─────────────────────────────

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
  let client: Client;
  let db: DbClient;
  let report: PgReportService;
  /** engagement：四条结论（候选 / 已验证 / 候选 / 已取代）+ 两份证据。 */
  let engagementId = '';
  /** 独立 engagement：只用于导出脱敏，不受主流程的编辑影响。 */
  let exportEngagementId = '';
  /** 独立 engagement：只用于报告重读幂等 / 编辑版优先 / 签字版优先（不受主流程状态推进影响）。 */
  let versioningEngagementId = '';
  let credentialArtifactId = '';
  let publicArtifactId = '';
  let candidateDeferredId = '';
  let validatedRejectedId = '';
  let candidateAcceptedId = '';
  let supersededId = '';
  const STATE_VERSION = 5;

  const DISPOSER = 'operator-1';

  interface FindingSnapshot {
    readonly id: string;
    readonly title: string;
    readonly severity: string | null;
    readonly status: string;
    readonly evidence_refs: readonly string[];
    readonly accepted_by: string | null;
    readonly accepted_at: Date | null;
    readonly updated_at: Date;
  }

  async function readFinding(id: string): Promise<FindingSnapshot> {
    const found = await client.query<FindingSnapshot>(
      `select id, title, severity, status, evidence_refs, accepted_by, accepted_at, updated_at
         from pentest.findings where id = $1`,
      [id],
    );
    const row = found.rows[0];
    assert.ok(row !== undefined, `结论 ${id} 应存在`);
    return row;
  }

  async function readReport(
    version: number,
    target = engagementId,
  ): Promise<{ projection_json: Record<string, unknown>; edited_content: string | null; content_hash: string }> {
    const found = await client.query<{
      projection_json: Record<string, unknown>;
      edited_content: string | null;
      content_hash: string;
    }>(
      `select projection_json, edited_content, content_hash from pentest.reports
        where engagement_id = $1 and version = $2`,
      [target, version],
    );
    const row = found.rows[0];
    assert.ok(row !== undefined, `报告版本 v${version} 应存在`);
    return row;
  }

  /** 从落库的投影里读某条结论进了哪一节（直接读原始 jsonb，不经过服务自己的解析器）。 */
  function sectionInReport(projection: Record<string, unknown>, findingId: string): string | null {
    const sections = projection['sections'] as { section: string; findings: { id: string }[] }[];
    for (const section of sections) {
      if (section.findings.some((finding) => finding.id === findingId)) return section.section;
    }
    return null;
  }

  function idsOf(projection: Record<string, unknown>, key: string): readonly string[] {
    return projection[key] as readonly string[];
  }

  /** reports 行数：用来证明读端点（重读 / 签字后重读）不再无界增长版本。 */
  async function countReports(target: string): Promise<number> {
    const found = await client.query<{ n: number }>(
      'select count(*)::int as n from pentest.reports where engagement_id = $1',
      [target],
    );
    return found.rows[0]?.n ?? 0;
  }

  before(async () => {
    client = new Client({ connectionString: DATABASE_URL });
    await client.connect();
    db = client as unknown as DbClient;
    report = new PgReportService(db);

    engagementId = randomUUID();
    exportEngagementId = randomUUID();
    versioningEngagementId = randomUUID();
    credentialArtifactId = randomUUID();
    publicArtifactId = randomUUID();
    candidateDeferredId = randomUUID();
    validatedRejectedId = randomUUID();
    candidateAcceptedId = randomUUID();
    supersededId = randomUUID();

    await client.query(
      `insert into pentest.engagements
         (id, tenant_id, name, status, current_status, current_phase, state_version,
          target_snapshot, scope_snapshot, roe_snapshot, policy_snapshot, config_snapshot, created_by)
       values ($1, 'pg-report', 'pg-report-integration', 'running', 'report_ready', 'exploitation', $2,
               '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, 'node-test'),
              ($3, 'pg-report', 'pg-report-export', 'running', 'waiting_human_review', null, 0,
               '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, 'node-test')`,
      [engagementId, STATE_VERSION, exportEngagementId],
    );

    const sessionId = randomUUID();
    await client.query(
      `insert into pentest.worker_sessions
         (id, engagement_id, dsh_session_id, phase, profile_id, profile_revision, task_prompt,
          tool_filter, skill_ids, model_route, status)
       values ($1, $2, $3, 'exploitation', 'p', 'r1', 'tp', '{}'::jsonb, '[]'::jsonb, '{}'::jsonb, 'active')`,
      [sessionId, engagementId, `dsh-${sessionId}`],
    );
    // 存活态会话签**有效**租约。
    //
    // 两个理由：
    //   1. 数据真实：§10.6 里一个正在工作的会话本就持有租约；「active 但无租约」
    //      是 §15.2 定义的**孤儿**，用它当种子是在测一个不该存在的场景。
    //   2. 并行隔离：`compose.test.ts` 里有个用例会 `apply()` 并启动**全库对账**
    //      （`StartupRecovery.recoverAll()` 是产品行为——单实例启动对账整库）。
    //      无租约的存活会话会被它判为孤儿、标记 failed、并写审计事件；那会让
    //      本文件的会话在断言前变成终态。
    await client.query(
      `insert into pentest.session_leases (engagement_id, worker_session_id, generation, expires_at)
       values ($1::uuid, $2::uuid, 1, now() + interval '1 hour')`,
      [engagementId, sessionId],
    );


    // §14.4 阶段时间线：state_transitions.human_decision_id 是 NOT NULL 外键，先落决策再落转移。
    const transitionDecisionId = randomUUID();
    await client.query(
      `insert into pentest.human_decisions
         (id, engagement_id, operator_id, decision_type, subject_id, decision, reason, auth_context)
       values ($1, $2, 'operator-1', 'phase_transition', 'phase-1', 'advance', '情报收集完成', '{}'::jsonb)`,
      [transitionDecisionId, engagementId],
    );
    await client.query(
      `insert into pentest.state_transitions
         (engagement_id, from_phase, to_phase, from_status, to_status, transition_type,
          expected_version, resulting_version, human_decision_id, reason)
       values ($1, null, 'intelligence-gathering', 'ready', 'worker_running', 'start',
               0, 1, $2, '开始情报收集'),
              ($1, 'intelligence-gathering', 'exploitation', 'waiting_human_review', 'worker_running', 'advance',
               1, 2, $2, '交接确认后进入利用验证')`,
      [engagementId, transitionDecisionId],
    );

    // 证据：一份 credential-like（导出必须脱敏），一份 engagement（可原样列出）。
    await client.query(
      `insert into pentest.artifacts
         (id, engagement_id, worker_session_id, kind, media_type, byte_size, storage_kind, storage_path,
          content_hash, classification, truncated, source_ref)
       values ($1, $2, $3, 'capture', 'text/plain', 12, 'file', '/evidence/cred.txt',
               $4, 'credential-like', false, 'tool_run:login'),
              ($5, $2, $3, 'response', 'text/html', 340, 'file', '/evidence/page.html',
               $6, 'engagement', true, 'tool_run:http_get')`,
      [
        credentialArtifactId,
        engagementId,
        sessionId,
        sha256Hex('admin:secret'),
        publicArtifactId,
        sha256Hex('<html>page</html>'),
      ],
    );

    await client.query(
      `insert into pentest.findings
         (id, engagement_id, discovered_in_session_id, title, severity, status, affected_asset_ids,
          evidence_refs, reproduction_steps, impact, remediation, confidence)
       values ($1, $2, $3, '默认口令可登录管理台', 'medium', 'candidate', '{}'::uuid[],
               array[$4]::uuid[], '["POST /login，使用默认口令"]'::jsonb, '可读取管理数据', '强制改密', 0.8),
              ($5, $2, $3, '响应头缺少 HSTS', 'low', 'validated', '{}'::uuid[],
               array[$6]::uuid[], '["curl -I https://target.example"]'::jsonb, '降级风险', '补齐响应头', 0.9),
              ($7, $2, $3, '未授权接口可枚举用户', null, 'candidate', '{}'::uuid[],
               '{}'::uuid[], '[]'::jsonb, null, null, null),
              ($8, $2, $3, '疑似 SSRF（已被取代）', 'info', 'superseded', '{}'::uuid[],
               '{}'::uuid[], '[]'::jsonb, null, null, null)`,
      [
        candidateDeferredId,
        engagementId,
        sessionId,
        credentialArtifactId,
        validatedRejectedId,
        publicArtifactId,
        candidateAcceptedId,
        supersededId,
      ],
    );

    // 导出用 engagement：一条候选结论 + 一份 credential-like 证据。
    const exportArtifactId = randomUUID();
    await client.query(
      `insert into pentest.artifacts
         (id, engagement_id, kind, media_type, byte_size, storage_kind, storage_path, content_hash,
          classification, truncated)
       values ($1, $2, 'capture', 'text/plain', 12, 'file', '/evidence/export-cred.txt', $3,
               'credential-like', false)`,
      [exportArtifactId, exportEngagementId, sha256Hex('root:toor')],
    );
    await client.query(
      `insert into pentest.findings
         (id, engagement_id, title, severity, status, affected_asset_ids, evidence_refs,
          reproduction_steps, confidence)
       values ($1, $2, '导出脱敏样例', 'high', 'candidate', '{}'::uuid[], array[$3]::uuid[],
               '["使用默认凭据登录"]'::jsonb, 0.5)`,
      [randomUUID(), exportEngagementId, exportArtifactId],
    );

    // 版本化幂等用 engagement：无结论、无证据，state_version=0——让「同一库状态重读」
    // 与「编辑 / 签字后取源」两条路径都能用干净的起点断言，不受主流程推进干扰。
    // 无证据意味着默认导出脱敏是空操作，导出正文与签字版逐字节相同。
    await client.query(
      `insert into pentest.engagements
         (id, tenant_id, name, status, current_status, current_phase, state_version,
          target_snapshot, scope_snapshot, roe_snapshot, policy_snapshot, config_snapshot, created_by)
       values ($1, 'pg-report', 'pg-report-versioning', 'running', 'report_ready', null, 0,
               '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, 'node-test')`,
      [versioningEngagementId],
    );
  });

  after(async () => {
    // 单条 Client 即同一条会话：`session_replication_role` 在这里设置是可靠的
    // （若是 pool，就必须先 `connect()` 固定一条连接）。
    let replicaActive = false;
    try {
      // §9.5 的追加写触发器（human_decisions、state_transitions）拒绝 DELETE，而它们通过外键
      // 把 engagements 钉住；兄弟测试的启动对账还可能往 context_events 补写审计行。切到 replica
      // 角色后用户触发器与 FK 触发器都不触发，才能把本文件的种子按依赖倒序删干净。
      await client.query("SET session_replication_role = 'replica'");
      replicaActive = true;
      const ids = [engagementId, exportEngagementId, versioningEngagementId];
      for (const statement of RING_BREAKERS) await client.query(statement, [ids]);
      for (const statement of CLEANUP_STATEMENTS) await client.query(statement, [ids]);
    } finally {
      try {
        // 恢复不能被吞：这条连接随后还要被关闭，但带着 replica 语义的任何后续查询
        // （含 close 前的隐式语句）都会静默失去触发器与 FK 保护。
        if (replicaActive) await client.query("SET session_replication_role = 'origin'");
      } finally {
        // 客户端必须关闭：否则挂起的连接会让 node:test 进程一直不退出。
        await client.end();
      }
    }
  });

  // ── 草稿投影：§8.9 分节 + §14.4 时间线 ──

  it('getDraft 投影：未处置进「待审阅」、已取代不进分节，并带上 §14.4 阶段时间线', async () => {
    const draft = await report.getReportDraft(engagementId);
    assert.equal(draft.version, 1);
    assert.equal(draft.content, renderReportMarkdown(await storedProjection(1)));
    assert.match(draft.content, /## 待审阅（awaiting_review）/);
    assert.match(draft.content, /【签字前置条件未满足】/);
    assert.match(draft.content, /开始情报收集/);

    const stored = await readReport(1);
    assert.equal(sectionInReport(stored.projection_json, candidateDeferredId), 'awaiting_review');
    assert.equal(sectionInReport(stored.projection_json, validatedRejectedId), 'awaiting_review');
    assert.equal(sectionInReport(stored.projection_json, candidateAcceptedId), 'awaiting_review');
    assert.equal(sectionInReport(stored.projection_json, supersededId), null);
    assert.deepEqual([...idsOf(stored.projection_json, 'supersededFindingIds')], [supersededId]);
    assert.equal(idsOf(stored.projection_json, 'undisposedFindingIds').length, 3);
  });

  it('listUndisposed 在存在未处置条目时非空，且只列候选态结论', async () => {
    const undisposed = await report.listUndisposed(engagementId);
    assert.deepEqual(
      undisposed.map((finding) => finding.id).sort(),
      [candidateAcceptedId, candidateDeferredId, validatedRejectedId].sort(),
    );
    const superseded = undisposed.find((finding) => finding.id === supersededId);
    assert.equal(superseded, undefined);
    assert.ok(undisposed.every((finding: Finding) => finding.engagementId === engagementId));
  });

  // ── 三种处置的状态转移 ──

  it('reject 缺理由即拒绝，且结论状态不变', async () => {
    const before = await readFinding(validatedRejectedId);
    await assert.rejects(
      () =>
        report.dispositionFinding({
          findingId: validatedRejectedId,
          operatorId: DISPOSER,
          action: 'reject',
          reason: '   ',
        }),
      (error: unknown) => error instanceof ReportServiceError && error.code === 'forced_reason_required',
    );
    const after = await readFinding(validatedRejectedId);
    assert.equal(after.status, 'validated');
    assert.deepEqual(after.evidence_refs, before.evidence_refs);
    // 被拒的处置不得留下决策行（要么完整写入，要么什么都没发生）
    const decisions = await client.query(
      `select count(*)::int as n from pentest.human_decisions
        where engagement_id = $1 and subject_id = $2`,
      [engagementId, validatedRejectedId],
    );
    assert.equal(decisions.rows[0]?.n, 0);
  });

  it('reject → rejected，理由落 human_decisions，证据引用逐字节保留', async () => {
    const before = await readFinding(validatedRejectedId);
    const rejected = await report.dispositionFinding({
      findingId: validatedRejectedId,
      operatorId: DISPOSER,
      action: 'reject',
      reason: '靶场镜像未启用该中间件，无法复现，判定不成立',
    });
    assert.equal(rejected.status, 'rejected');
    assert.deepEqual(rejected.evidenceRefs, before.evidence_refs, '§8.9：拒绝不等于删除');
    assert.ok(rejected.evidenceRefs.length > 0);

    const stored = await readFinding(validatedRejectedId);
    assert.equal(stored.status, 'rejected');
    assert.deepEqual(stored.evidence_refs, before.evidence_refs);

    const decisions = await client.query<{ decision: string; reason: string; operator_id: string }>(
      `select decision, reason, operator_id from pentest.human_decisions
        where engagement_id = $1 and subject_id = $2 order by created_at desc limit 1`,
      [engagementId, validatedRejectedId],
    );
    assert.equal(decisions.rows[0]?.decision, 'reject');
    assert.match(decisions.rows[0]?.reason ?? '', /无法复现/);
    assert.equal(decisions.rows[0]?.operator_id, DISPOSER);
  });

  it('accept → human_accepted，写入接受者与时间，严重度按人工值覆盖', async () => {
    const before = await readFinding(candidateAcceptedId);
    assert.equal(before.severity, null);
    const accepted = await report.dispositionFinding({
      findingId: candidateAcceptedId,
      operatorId: DISPOSER,
      action: 'accept',
      reason: '证据与复现步骤一致',
      severity: 'critical',
    });
    assert.equal(accepted.status, 'human_accepted');
    assert.equal(accepted.severity, 'critical', '严重度由人确认：模型给的建议值可被覆盖（§8.9）');
    assert.equal(accepted.acceptedBy, DISPOSER);
    assert.ok(accepted.acceptedAt !== null);
    assert.ok(!Number.isNaN(Date.parse(accepted.acceptedAt ?? '')));

    const stored = await readFinding(candidateAcceptedId);
    assert.equal(stored.status, 'human_accepted');
    assert.equal(stored.severity, 'critical');
    assert.equal(stored.accepted_by, DISPOSER);
  });

  it('defer → 状态不变、理由必填、严重度仍可人工覆盖', async () => {
    await assert.rejects(
      () =>
        report.dispositionFinding({
          findingId: candidateDeferredId,
          operatorId: DISPOSER,
          action: 'defer',
          reason: '',
        }),
      (error: unknown) => error instanceof ReportServiceError && error.code === 'forced_reason_required',
    );
    const before = await readFinding(candidateDeferredId);
    const deferred = await report.dispositionFinding({
      findingId: candidateDeferredId,
      operatorId: DISPOSER,
      action: 'defer',
      reason: '需要先取得受控复现环境，本轮暂不下结论',
      severity: 'high',
    });
    assert.equal(deferred.status, before.status, '暂缓不改变状态（§8.9）');
    assert.equal(deferred.status, 'candidate');
    assert.equal(deferred.severity, 'high');
    assert.deepEqual(deferred.evidenceRefs, before.evidence_refs);
    assert.equal(deferred.acceptedBy, null);
  });

  it('处置全部给出后 listUndisposed 为空，报告分节按映射落位', async () => {
    assert.deepEqual(await report.listUndisposed(engagementId), []);

    const draft = await report.getReportDraft(engagementId);
    assert.equal(draft.version, 2);
    assert.doesNotMatch(draft.content, /【签字前置条件未满足】/);
    assert.match(draft.content, /## 已验证结论（verified_findings）/);
    assert.match(draft.content, /## 已评估但不成立（assessed_not_confirmed）/);
    assert.match(draft.content, /## 未验证候选（unverified_candidates）/);

    const stored = await readReport(2);
    assert.equal(sectionInReport(stored.projection_json, candidateAcceptedId), 'verified_findings');
    assert.equal(sectionInReport(stored.projection_json, validatedRejectedId), 'assessed_not_confirmed');
    assert.equal(sectionInReport(stored.projection_json, candidateDeferredId), 'unverified_candidates');
    assert.deepEqual(idsOf(stored.projection_json, 'undisposedFindingIds'), []);
    assert.deepEqual(idsOf(stored.projection_json, 'acceptedFindingIds'), [candidateAcceptedId]);
  });

  // ── 脱敏：§11.3 不修改原文 ──

  it('redactPreview 只作用于预览文本，findings / artifacts 原文逐字节不变', async () => {
    const findingsBefore = await client.query(
      `select id, title, status, severity, evidence_refs, updated_at
         from pentest.findings where engagement_id = $1 order by id`,
      [engagementId],
    );
    const artifactsBefore = await client.query(
      'select id, content_hash, classification from pentest.artifacts where engagement_id = $1 order by id',
      [engagementId],
    );
    const reportsBefore = await client.query<{ n: number }>(
      'select count(*)::int as n from pentest.reports where engagement_id = $1',
      [engagementId],
    );
    const evidenceRefsBefore = (await readFinding(candidateDeferredId)).evidence_refs;

    const preview = await report.redactPreview({
      engagementId,
      classifications: ['credential-like'],
    });
    assert.ok(preview.redactedCount >= 1, 'credential-like 证据必须被计入脱敏数');
    assert.match(preview.content, /已脱敏：classification=credential-like/);
    assert.doesNotMatch(preview.content, /classification=credential-like truncated/);
    // 未请求脱敏的分类照常列出
    assert.match(preview.content, /classification=engagement/);

    const plain = await report.redactPreview({ engagementId, classifications: [] });
    assert.equal(plain.redactedCount, 0);
    assert.doesNotMatch(plain.content, /已脱敏/);

    const findingsAfter = await client.query(
      `select id, title, status, severity, evidence_refs, updated_at
         from pentest.findings where engagement_id = $1 order by id`,
      [engagementId],
    );
    const artifactsAfter = await client.query(
      'select id, content_hash, classification from pentest.artifacts where engagement_id = $1 order by id',
      [engagementId],
    );
    const reportsAfter = await client.query<{ n: number }>(
      'select count(*)::int as n from pentest.reports where engagement_id = $1',
      [engagementId],
    );
    assert.deepEqual(findingsAfter.rows, findingsBefore.rows, '§11.3：证据原文永不脱敏');
    assert.deepEqual(artifactsAfter.rows, artifactsBefore.rows);
    assert.equal(reportsAfter.rows[0]?.n, reportsBefore.rows[0]?.n, '预览不得产生报告版本');
    assert.deepEqual((await readFinding(candidateDeferredId)).evidence_refs, evidenceRefsBefore);
  });

  // ── 版本递增与编辑 ──

  it('updateReport 校验期望状态版本，版本号只增不覆盖旧版', async () => {
    await assert.rejects(
      () =>
        report.updateReport({
          engagementId,
          operatorId: DISPOSER,
          expectedStateVersion: STATE_VERSION + 1,
          editedContent: '# 人工编辑后的报告',
        }),
      (error: unknown) => error instanceof ReportServiceError && error.code === 'stale_state_version',
    );

    const draftBefore = await readReport(2);
    const edited = '# 人工编辑后的报告\n\n（人类调整措辞并标注未验证项）\n';
    const ref = await report.updateReport({
      engagementId,
      operatorId: DISPOSER,
      expectedStateVersion: STATE_VERSION,
      editedContent: edited,
    });
    assert.equal(ref.version, 3);
    assert.equal(ref.contentHash, sha256Hex(edited));

    const stored = await readReport(3);
    assert.equal(stored.edited_content, edited);
    assert.equal(stored.content_hash, sha256Hex(edited));
    // 旧版仍可读且未被改写（签字哈希可追溯到被审阅的那一版）
    const draftAfter = await readReport(2);
    assert.equal(draftAfter.edited_content, null);
    assert.equal(draftAfter.content_hash, draftBefore.content_hash);
    assert.deepEqual(draftAfter.projection_json, draftBefore.projection_json);

    // 编辑者归因：reports 表没有编辑者列，人工编辑记入只追加的 human_decisions
    const editDecision = await client.query<{ operator_id: string; decision: string; reason: string }>(
      `select operator_id, decision, reason from pentest.human_decisions
        where engagement_id = $1 and decision_type = 'report_edit'
        order by created_at desc limit 1`,
      [engagementId],
    );
    assert.equal(editDecision.rows[0]?.operator_id, DISPOSER);
    assert.match(editDecision.rows[0]?.reason ?? '', /v3/);
  });

  // ── 导出 ──

  it('exportReport：编辑版按原样导出，元数据与内容哈希自洽', async () => {
    const exported = await report.exportReport({ engagementId, format: 'markdown', operatorId: DISPOSER });
    assert.equal(exported.fileName, `pentest-report-${engagementId}-v3.md`);
    assert.equal(exported.mediaType, 'text/markdown; charset=utf-8');
    assert.match(exported.content, /人工编辑后的报告/);
    assert.equal(exported.byteSize, Buffer.byteLength(exported.content, 'utf8'));
    assert.equal(exported.contentHash, sha256Hex(exported.content));
    assert.equal(exported.contentHash.length, 64);

    const again = await report.exportReport({ engagementId, format: 'markdown', operatorId: DISPOSER });
    assert.equal(again.contentHash, exported.contentHash, '同一版本导出必须稳定');

    const json = await report.exportReport({ engagementId, format: 'json', operatorId: DISPOSER });
    assert.equal(json.fileName, `pentest-report-${engagementId}-v3.json`);
    assert.equal(json.mediaType, 'application/json; charset=utf-8');
    assert.equal(json.contentHash, sha256Hex(json.content));
    assert.equal(json.byteSize, Buffer.byteLength(json.content, 'utf8'));
    const payload = JSON.parse(json.content) as { version: number; body: string };
    assert.equal(payload.version, 3);
    assert.match(payload.body, /人工编辑后的报告/);
  });

  // ── 报告读端点幂等与签字一致性（§3.2 复核修复的回归锁）──

  it('getReportDraft 幂等：连续两次重读版本与哈希不变，且 reports 行数不增', async () => {
    const before = await countReports(versioningEngagementId);
    const first = await report.getReportDraft(versioningEngagementId);
    const second = await report.getReportDraft(versioningEngagementId);
    assert.equal(first.version, 1, '首次取草稿落 v1');
    assert.equal(second.version, first.version, '重读不得推进版本');
    assert.equal(second.contentHash, first.contentHash, '重读必须返回同一 contentHash（否则签字必然 stale）');
    assert.equal(second.content, first.content);
    assert.equal(await countReports(versioningEngagementId), before + 1, '首次落一版、重读不得再落新版本');
  });

  it('updateReport 后重读仍返回编辑正文，导出不再静默回退到机器投影', async () => {
    const edited = '# 人工编辑后的版本化报告\n\n（人工修订，必须出现在正式产物里）\n';
    const ref = await report.updateReport({
      engagementId: versioningEngagementId,
      operatorId: DISPOSER,
      expectedStateVersion: 0,
      editedContent: edited,
    });
    assert.equal(ref.version, 2);
    assert.equal(ref.contentHash, sha256Hex(edited));

    const draft = await report.getReportDraft(versioningEngagementId);
    assert.equal(draft.version, 2, '重读不得以更高版本把编辑版挤出');
    assert.equal(draft.content, edited);
    assert.equal(draft.contentHash, sha256Hex(edited), '返回的 contentHash 必须指向编辑版正文');

    const exported = await report.exportReport({
      engagementId: versioningEngagementId,
      format: 'markdown',
      operatorId: DISPOSER,
    });
    assert.equal(exported.fileName, `pentest-report-${versioningEngagementId}-v2.md`);
    assert.equal(exported.content, edited);
    assert.equal(exported.contentHash, sha256Hex(edited));
  });

  it('签字后重读返回签字版本，导出的 contentHash 与签字版一致', async () => {
    const draft = await report.getReportDraft(versioningEngagementId);
    assert.ok(draft.contentHash !== null, '草稿必须带权威内容哈希');
    const signed = await report.signReportVersion({
      engagementId: versioningEngagementId,
      version: draft.version,
      contentHash: draft.contentHash,
      operatorId: DISPOSER,
    });
    assert.equal(signed.version, 2);
    const rowsAfterSign = await countReports(versioningEngagementId);

    const reread = await report.getReportDraft(versioningEngagementId);
    assert.equal(reread.version, signed.version, '存在签字版时重读必须返回签字版本');
    assert.equal(reread.contentHash, signed.contentHash);
    assert.equal(await countReports(versioningEngagementId), rowsAfterSign, '签字后重读不得再产生未签字新版本');

    const exported = await report.exportReport({
      engagementId: versioningEngagementId,
      format: 'markdown',
      operatorId: DISPOSER,
    });
    assert.equal(exported.fileName, `pentest-report-${versioningEngagementId}-v2.md`);
    assert.equal(exported.contentHash, signed.contentHash, '导出哈希必须能核对签字版');
  });

  it('exportReport 默认按分类脱敏结构化投影，且只为无版本的 engagement 落一版草稿', async () => {
    const reportsBefore = await client.query<{ n: number }>(
      'select count(*)::int as n from pentest.reports where engagement_id = $1',
      [exportEngagementId],
    );
    const redacted = await report.exportReport({
      engagementId: exportEngagementId,
      format: 'markdown',
      operatorId: DISPOSER,
    });
    assert.match(redacted.content, /已脱敏：classification=credential-like/);
    assert.match(redacted.content, /导出脱敏样例/);

    // 显式关闭导出脱敏（离线审计复核用）：同一份投影列出证据详情
    const rawService = new PgReportService(db, { exportRedactions: [] });
    const raw = await rawService.exportReport({
      engagementId: exportEngagementId,
      format: 'markdown',
      operatorId: DISPOSER,
    });
    assert.doesNotMatch(raw.content, /已脱敏/);
    assert.match(raw.content, /kind=capture/);
    assert.equal(raw.contentHash, sha256Hex(raw.content));
    assert.notEqual(raw.contentHash, redacted.contentHash);
    assert.equal(raw.byteSize, Buffer.byteLength(raw.content, 'utf8'));

    // 导出会为尚无版本的 engagement 落一版草稿，但不会每次导出都新增版本
    const reportsAfter = await client.query<{ n: number }>(
      'select count(*)::int as n from pentest.reports where engagement_id = $1',
      [exportEngagementId],
    );
    assert.equal(reportsAfter.rows[0]?.n, Number(reportsBefore.rows[0]?.n) + 1);
  });

  it('未知标识与非法输入明确拒绝，不静默返回空结果', async () => {
    await assert.rejects(
      () =>
        report.dispositionFinding({
          findingId: randomUUID(),
          operatorId: DISPOSER,
          action: 'accept',
          reason: '',
        }),
      (error: unknown) => error instanceof ReportServiceError,
    );
    await assert.rejects(
      () => report.getReportDraft(randomUUID()),
      (error: unknown) => error instanceof ReportServiceError,
    );
    await assert.rejects(
      () => report.listUndisposed(randomUUID()),
      (error: unknown) => error instanceof ReportServiceError,
    );
    await assert.rejects(
      () =>
        report.updateReport({
          engagementId,
          operatorId: DISPOSER,
          expectedStateVersion: STATE_VERSION,
          editedContent: '   ',
        }),
      /拒绝空正文/,
    );
    await assert.rejects(
      () => report.exportReport({ engagementId, format: 'pdf' as 'markdown', operatorId: DISPOSER }),
      /导出格式/,
    );
  });

  /** 读回落库投影（服务内部形状），供渲染一致性断言使用。 */
  async function storedProjection(version: number): Promise<ReportProjection> {
    const stored = await readReport(version);
    // 直接复用服务的解析器：它的严格性由「形状非法即拒绝」的失败路径覆盖。
    return parseReportProjection(stored.projection_json);
  }
});
