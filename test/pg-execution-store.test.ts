/**
 * `src/execution/pg-store.ts` 的集成测试（设计文档 §10.3、§10.3.1、§9.5）。
 *
 * **为什么必须在真实 PostgreSQL 上测**：假实现不模拟 CHECK 约束、唯一索引与 002 的状态推进
 * 触发器——此前正是这一点掩盖过 `revoked_reason` 缺 `expired` 的真缺陷。本文件的断言全部落在
 * 真实库的行为上：uuid 列与外键、`tool_runs` 的 UNIQUE (engagement_id, idempotency_key)、
 * `approvals_single_consumption` 部分唯一索引、`tool_runs_state_progression` 的一次性前向迁移。
 *
 * 未设置 `PENTEST_DATABASE_URL` 时整套集成用例 skip（而非失败）。
 * 连接用超级用户：002 已对 `tool_runs` / `approvals` 启用并 FORCE RLS，超级用户绕过策略，
 * 因此无需设置 `pentest.*` 会话变量；要测 RLS 本身需 `SET ROLE` + 会话变量，不属于本文件的职责。
 */

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import { Pool } from 'pg';

import { EXEC_TOOL_NAME } from '../src/contracts.ts';
import type { DbClient } from '../src/db/port.ts';
import { PgExecutionStore } from '../src/execution/pg-store.ts';
import { derivePlanHash } from '../src/execution/idempotency.ts';

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

// ───────────────────────────── 夹具 ─────────────────────────────

const PLAN_INPUT = {
  templateId: 'nmap-service-scan',
  actionClass: 'active_discovery' as const,
  normalizedTarget: 'https://10.20.30.40:8443',
  normalizedCommand: 'nmap -sV -p 8443 10.20.30.40',
  timeoutMs: 600_000,
  maxOutputBytes: 4_194_304,
  scopeVersion: 3,
  policyEpoch: 7,
  leaseGeneration: 1,
};
const PLAN_HASH = derivePlanHash({ ...PLAN_INPUT, policyVersion: null, pacing: null });

interface ToolRunRow {
  readonly id: string;
  readonly engagement_id: string;
  readonly worker_session_id: string | null;
  readonly idempotency_key: string;
  readonly tool_name: string;
  readonly action_class: string;
  readonly target_selector: unknown;
  readonly normalized_command: unknown;
  readonly arguments_json: unknown;
  readonly approval_id: string | null;
  readonly policy_decision: unknown;
  readonly stdout_zstd: Uint8Array | null;
  readonly stderr_zstd: Uint8Array | null;
  readonly exit_code: number | null;
  readonly result_json: unknown;
  readonly artifact_ids: readonly string[] | null;
  readonly status: string;
  readonly started_at: Date | null;
  readonly finished_at: Date | null;
}

interface ApprovalDetailRow {
  readonly id: string;
  readonly engagement_id: string;
  readonly requested_by_worker: string | null;
  readonly action_class: string;
  readonly target_snapshot: unknown;
  readonly command_plan: unknown;
  readonly plan_hash: string;
  readonly risk_summary: string;
  readonly decision: string;
  readonly lease_generation: number | null;
  readonly consumed_at: Date | null;
  readonly consumed_by_tool_run: string | null;
  readonly expires_at: Date | null;
}

/** pg 的唯一约束冲突。 */
const UNIQUE_VIOLATION = '23505';
/** 002 触发器的拒绝码（`using errcode = 'restrict_violation'`）。 */
const RESTRICT_VIOLATION = '23001';

function pgErrorCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null || !('code' in error)) return undefined;
  const { code } = error;
  return typeof code === 'string' ? code : undefined;
}

describe(
  '集成：真实 PostgreSQL（PgExecutionStore）',
  { skip: DATABASE_URL === undefined ? '未设置 PENTEST_DATABASE_URL' : false },
  () => {
    let pool: Pool;
    let db: DbClient;
    let store: PgExecutionStore;
    let engagementId = '';
    let workerSessionId = '';
    const extraEngagementIds: string[] = [];

    before(async () => {
      pool = new Pool({ connectionString: DATABASE_URL });
      db = pool as unknown as DbClient;
      store = new PgExecutionStore(db);
      engagementId = randomUUID();
      workerSessionId = randomUUID();

      await pool.query(
        `insert into pentest.engagements (id, tenant_id, name, status, current_status,
             target_snapshot, scope_snapshot, roe_snapshot, policy_snapshot, config_snapshot, created_by,
             policy_epoch)
         values ($1, 'test', 'execution-store-integration', 'running', 'ready',
             '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, 'node-test',
             $2::bigint)`,
        [engagementId, PLAN_INPUT.policyEpoch],
      );
      // tool_runs.worker_session_id / approvals.requested_by_worker 都是 uuid 且有外键：
      // 真实库会校验，`'sess-1'` 这类假串既过不了类型也过不了外键。
      await pool.query(
        `insert into pentest.worker_sessions (id, engagement_id, dsh_session_id, phase, profile_id,
             profile_revision, task_prompt, tool_filter, skill_ids, model_route, scope_version, status)
         values ($1, $2, $3, 'intelligence-gathering', 'p', 'r1', 'tp',
             '{}'::jsonb, '[]'::jsonb, '{}'::jsonb, $4::integer, 'active')`,
        [workerSessionId, engagementId, `dsh-${workerSessionId}`, PLAN_INPUT.scopeVersion],
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
    await pool.query(
      `insert into pentest.session_leases (engagement_id, worker_session_id, generation, expires_at)
       values ($1::uuid, $2::uuid, 1, now() + interval '1 hour')`,
      [engagementId, workerSessionId],
    );

    });

    /**
     * 清理本文件自己造的 engagement 下的全部种子数据（含兄弟测试对账时补写的审计行）。
     *
     * tool_runs 与 approvals 互为外键（approvals.consumed_by_tool_run → tool_runs.id、
     * tool_runs.approval_id → approvals.id）：RING_BREAKERS 先断开消费边，倒序删除才自洽。
     * 用**同一条连接**收发 `SET session_replication_role`：它是会话级设置，
     * 用 `pool.query` 设只影响当时借出的那条连接，删表却可能落在另一条上。
     */
    async function cleanupEngagements(ids: readonly string[]): Promise<void> {
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
      // 清理失败必须冒泡（不再靠顺序「刚好够用」）：静默残留会累积成后续运行的脏前置状态。
      await cleanupEngagements([engagementId, ...extraEngagementIds]);
      await pool.end();
    });

    async function createApproval(options: {
      readonly decision?: string;
      readonly expiresInMs?: number;
      readonly workerSessionId?: string;
    } = {}): Promise<string> {
      const requestedExpiresInMs = options.expiresInMs ?? 900_000;
      const expireAfterApproval = requestedExpiresInMs < 0;
      const requestedWorkerSessionId = options.workerSessionId ?? workerSessionId;
      const { approvalId } = await store.requestApproval({
        workerSessionId: requestedWorkerSessionId,
        leaseGeneration: PLAN_INPUT.leaseGeneration,
        actionClass: PLAN_INPUT.actionClass,
        templateId: PLAN_INPUT.templateId,
        params: { port: 8443 },
        targetSelector: 'https://10.20.30.40:8443',
        planHash: PLAN_HASH,
        normalizedTarget: PLAN_INPUT.normalizedTarget,
        normalizedCommand: PLAN_INPUT.normalizedCommand,
        scopeVersion: PLAN_INPUT.scopeVersion,
        policyEpoch: PLAN_INPUT.policyEpoch,
        timeoutMs: PLAN_INPUT.timeoutMs,
        maxOutputBytes: PLAN_INPUT.maxOutputBytes,
        purpose: '确认目标 8443 端口上的服务版本',
        expiresAt: new Date(Date.now() + (expireAfterApproval ? 900_000 : requestedExpiresInMs)),
      });
      if ((options.decision ?? 'approved') !== 'pending') {
        await pool.query('select pentest.resolve_approval($1::uuid, $2, $3, $4)', [
          approvalId,
          options.decision ?? 'approved',
          'operator-1',
          'test decision',
        ]);
      }
      if (expireAfterApproval) {
        const client = await pool.connect();
        let replicaActive = false;
        try {
          await client.query("SET session_replication_role = 'replica'");
          replicaActive = true;
          await client.query(
            `UPDATE pentest.approvals SET expires_at = now() - interval '1 minute' WHERE id = $1::uuid`,
            [approvalId],
          );
        } finally {
          try {
            if (replicaActive) await client.query("SET session_replication_role = 'origin'");
          } finally {
            client.release();
          }
        }
      }
      return approvalId;
    }

    /** `commitRun` 的登记字段（真实调用点由 plan 提供，见 `CommitRunInput` 注释）。 */
    function commitInput(
      toolRunId: string,
      idempotencyKey: string,
      approvalId: string | null,
      sessionId = workerSessionId,
    ): Parameters<PgExecutionStore['commitRun']>[0] {
      return {
        toolRunId,
        workerSessionId: sessionId,
        idempotencyKey,
        planHash: PLAN_HASH,
        approvalId,
        leaseGeneration: PLAN_INPUT.leaseGeneration,
        toolName: EXEC_TOOL_NAME,
        actionClass: PLAN_INPUT.actionClass,
        templateId: PLAN_INPUT.templateId,
        normalizedTarget: PLAN_INPUT.normalizedTarget,
        normalizedCommand: PLAN_INPUT.normalizedCommand,
        scopeVersion: PLAN_INPUT.scopeVersion,
        policyEpoch: PLAN_INPUT.policyEpoch,
        approvalRequired: approvalId !== null,
      };
    }

    async function readRun(toolRunId: string): Promise<ToolRunRow | undefined> {
      const found = await pool.query<ToolRunRow>('select * from pentest.tool_runs where id = $1', [toolRunId]);
      return found.rows[0];
    }

    async function readApproval(approvalId: string): Promise<ApprovalDetailRow | undefined> {
      const found = await pool.query<ApprovalDetailRow>('select * from pentest.approvals where id = $1', [
        approvalId,
      ]);
      return found.rows[0];
    }

    async function countRunsByKey(idempotencyKey: string): Promise<number> {
      const found = await pool.query<{ n: string }>(
        'select count(*)::text as n from pentest.tool_runs where engagement_id = $1 and idempotency_key = $2',
        [engagementId, idempotencyKey],
      );
      return Number(found.rows[0]?.n ?? '0');
    }

    // ───────────────────────────── 放行申请与读取 ─────────────────────────────

    it('requestApproval 写入完整执行内容（approve-what-you-see），getApproval 忠实往返', async () => {
      const approvalId = await createApproval({ decision: 'pending' });
      // 返回值必须是真实 uuid（组合根注入 newId 后由数据库生成）。
      assert.match(approvalId, /^[0-9a-f-]{36}$/);

      const row = await readApproval(approvalId);
      assert.ok(row !== undefined);
      const plan = row.command_plan as Record<string, unknown>;
      assert.equal(plan['target_selector'], 'https://10.20.30.40:8443');
      // §10.3.1「审批负载带完整执行内容」：人类批准的是将要执行的那条命令。
      assert.equal(plan['normalized_command'], PLAN_INPUT.normalizedCommand);
      assert.equal(plan['normalized_target'], PLAN_INPUT.normalizedTarget);
      assert.equal(plan['timeout_ms'], PLAN_INPUT.timeoutMs);
      assert.equal(plan['max_output_bytes'], PLAN_INPUT.maxOutputBytes);
      assert.equal(plan['purpose'], '确认目标 8443 端口上的服务版本');
      assert.equal(plan['scope_version'], PLAN_INPUT.scopeVersion);
      assert.equal(plan['policy_epoch'], PLAN_INPUT.policyEpoch);
      assert.equal(plan['lease_generation'], PLAN_INPUT.leaseGeneration);
      // 目标快照同样记录被裁决的规范化目标。
      assert.deepEqual(row.target_snapshot, { normalized_target: PLAN_INPUT.normalizedTarget });
      assert.equal(row.plan_hash, PLAN_HASH);
      assert.equal(row.action_class, PLAN_INPUT.actionClass);
      assert.equal(row.requested_by_worker, workerSessionId);
      assert.equal(row.engagement_id, engagementId);
      assert.equal(row.decision, 'pending');

      const record = await store.getApproval(approvalId);
      assert.ok(record !== undefined);
      assert.equal(record.id, approvalId);
      assert.equal(record.workerSessionId, workerSessionId);
      assert.equal(record.actionClass, PLAN_INPUT.actionClass);
      assert.equal(record.planHash, PLAN_HASH);
      assert.equal(record.leaseGeneration, PLAN_INPUT.leaseGeneration);
      assert.equal(record.decision, 'pending');
      assert.equal(record.consumedAt, null);
      assert.equal(record.expiresAt.getTime(), row.expires_at?.getTime());
      assert.ok(record.expiresAt.getTime() > Date.now());
      // 未知凭证映射为 undefined，由服务侧转成 approval_required（而不是抛错）。
      assert.equal(await store.getApproval(randomUUID()), undefined);
    });

    it('自放行凭证：以 pending 插入后经 resolve_approval 落成 approved（触发器不允许直接插 approved）', async () => {
      // 回归锁（2026-10-05 实测事故）：`approvals_insert_guard` 规定运行时只能创建 pending。
      // 曾经的实现直接插 `approved`，被 restrict_violation 拒掉，人类看到的是
      // 「审批只能以 pending 且无决策/消费见证创建：<id>」——高权限模式因此整条失效。
      const b64Self = Buffer.from('id', 'utf8').toString('base64');
      const { approvalId } = await store.requestApproval({
        workerSessionId,
        leaseGeneration: PLAN_INPUT.leaseGeneration,
        actionClass: 'exploit_validation',
        templateId: 'direct_command',
        params: { port: 3002, command_b64: b64Self },
        targetSelector: 'http://192.0.2.10/',
        planHash: PLAN_HASH,
        normalizedTarget: PLAN_INPUT.normalizedTarget,
        normalizedCommand: `shell_exec target=${PLAN_INPUT.normalizedTarget} port=3002 command_b64=${b64Self}`,
        displayCommand: 'id',
        scopeVersion: PLAN_INPUT.scopeVersion,
        policyEpoch: PLAN_INPUT.policyEpoch,
        timeoutMs: PLAN_INPUT.timeoutMs,
        maxOutputBytes: PLAN_INPUT.maxOutputBytes,
        purpose: '自放行回归锁',
        expiresAt: new Date(Date.now() + 900_000),
        selfApproval: { decidedBy: 'server:auto-approval', reason: '高权限模式：命令类自行放行' },
      });
      const row = await pool.query<{ decision: string; decided_by: string | null; decision_reason: string | null; decided_at: Date | null }>(
        `select decision, decided_by, decision_reason, decided_at from pentest.approvals where id = $1::uuid`,
        [approvalId],
      );
      assert.equal(row.rows[0]?.decision, 'approved', '自放行凭证必须落成 approved');
      assert.equal(row.rows[0]?.decided_by, 'server:auto-approval', 'decided_by 要写明是服务端自行放行');
      assert.ok(row.rows[0]?.decided_at !== null, '决议时间必须落库');
      // 人类路径能原样消费它：同一个 getApproval 读回 approved。
      const record = await store.getApproval(approvalId);
      assert.equal(record?.decision, 'approved');
    });

    it('requestApproval 两份命令形态都落库：display_command 是解码原文，normalized_command 仍是给容器读的 base64 串', async () => {
      // C1：放行卡是放开权限后唯一的内容闸门，人类必须看到明文命令而不是 base64。
      // 服务端把 `*_b64` 解码结果放进 displayCommand；执行读的 normalizedCommand 原样保留——
      // 两份都存，白纸黑字可对照（不是用展示形态覆盖执行形态）。
      const decoded = 'id && whoami';
      const b64 = Buffer.from(decoded, 'utf8').toString('base64');
      const normalizedCommand = `shell_exec target=${PLAN_INPUT.normalizedTarget} port=443 command_b64=${b64}`;
      const { approvalId } = await store.requestApproval({
        workerSessionId,
        leaseGeneration: PLAN_INPUT.leaseGeneration,
        actionClass: 'exploit_validation',
        templateId: 'direct_command',
        params: { port: 443, command_b64: b64 },
        targetSelector: 'https://10.20.30.40:8443',
        planHash: PLAN_HASH,
        normalizedTarget: PLAN_INPUT.normalizedTarget,
        normalizedCommand,
        displayCommand: decoded,
        scopeVersion: PLAN_INPUT.scopeVersion,
        policyEpoch: PLAN_INPUT.policyEpoch,
        timeoutMs: PLAN_INPUT.timeoutMs,
        maxOutputBytes: PLAN_INPUT.maxOutputBytes,
        purpose: '自由命令需按明文放行',
        expiresAt: new Date(Date.now() + 900_000),
      });

      const row = await readApproval(approvalId);
      assert.ok(row !== undefined);
      const plan = row.command_plan as Record<string, unknown>;
      assert.equal(plan['display_command'], decoded, '放行卡读到的必须是解码后的明文命令');
      assert.equal(plan['normalized_command'], normalizedCommand, '执行形态必须原样保留（给容器读）');
      assert.notEqual(plan['display_command'], plan['normalized_command'], '两份形态必须可对照，不能互相覆盖');
    });

    it('requestApproval 未提供 displayCommand 时回落为 normalized_command（非 *_b64 模板）', async () => {
      // 非 `*_b64` 模板没有展示形态；服务端不传 displayCommand，落库时回落成 normalized_command。
      const approvalId = await createApproval({ decision: 'pending' });
      const row = await readApproval(approvalId);
      assert.ok(row !== undefined);
      const plan = row.command_plan as Record<string, unknown>;
      assert.equal(plan['display_command'], PLAN_INPUT.normalizedCommand);
      assert.equal(plan['display_command'], plan['normalized_command']);
    });

    // ───────────────────────────── commitRun：原子提交 ─────────────────────────────

    it('commitRun 在同一事务内消费凭证 + 登记运行（§10.3.1）', async () => {
      const approvalId = await createApproval();
      const toolRunId = randomUUID();
      const idempotencyKey = `key-${randomUUID()}`;

      const commit = await store.commitRun(commitInput(toolRunId, idempotencyKey, approvalId));
      assert.equal(commit.ok, true);
      assert.ok(commit.ok);

      const run = await readRun(toolRunId);
      assert.ok(run !== undefined);
      assert.equal(run.status, 'running');
      assert.equal(run.engagement_id, engagementId);
      assert.equal(run.worker_session_id, workerSessionId);
      assert.equal(run.idempotency_key, idempotencyKey);
      assert.equal(run.approval_id, approvalId);
      // 审计字段落的是真实值，不是哨兵：动作类别、工具名、目标/命令与裁决依据。
      assert.equal(run.tool_name, EXEC_TOOL_NAME);
      assert.equal(run.action_class, PLAN_INPUT.actionClass);
      assert.notEqual(run.action_class, 'unspecified');
      assert.deepEqual(run.target_selector, {
        target: PLAN_INPUT.normalizedTarget,
        template: PLAN_INPUT.templateId,
      });
      assert.deepEqual(run.normalized_command, { text: PLAN_INPUT.normalizedCommand });
      const decision = run.policy_decision as Record<string, unknown>;
      assert.equal(decision['plan_hash'], PLAN_HASH);
      assert.equal(decision['scope_version'], PLAN_INPUT.scopeVersion);
      assert.equal(decision['policy_epoch'], PLAN_INPUT.policyEpoch);
      assert.equal(decision['approval_required'], true);
      // started_at 是生命周期列：认领执行时即可写；结算列尚未写。
      assert.ok(run.started_at instanceof Date);
      assert.equal(run.finished_at, null);
      assert.equal(run.result_json, null);

      // 凭证被同一条语句标记为已消费，并指向该运行（approvals_single_consumption 支撑）。
      const approval = await readApproval(approvalId);
      assert.ok(approval !== undefined);
      assert.ok(approval.consumed_at instanceof Date);
      assert.equal(approval.consumed_by_tool_run, toolRunId);
    });

    it('commitRun 在凭证已被消费时返回 approval_consumed，且不登记第二个运行', async () => {
      const approvalId = await createApproval();
      const first = await store.commitRun(
        commitInput(randomUUID(), `key-${randomUUID()}`, approvalId),
      );
      assert.ok(first.ok);

      const laterKey = `key-${randomUUID()}`;
      const second = await store.commitRun(commitInput(randomUUID(), laterKey, approvalId));
      assert.deepEqual(second, { ok: false, reason: 'approval_consumed' });
      assert.equal(await countRunsByKey(laterKey), 0);
    });

    it('commitRun 区分 approval_not_found、未放行与已过期凭证', async () => {
      const missingKey = `key-${randomUUID()}`;
      assert.deepEqual(
        await store.commitRun(commitInput(randomUUID(), missingKey, randomUUID())),
        { ok: false, reason: 'approval_not_found' },
      );
      assert.equal(await countRunsByKey(missingKey), 0);

      // 未放行（pending）
      const pendingKey = `key-${randomUUID()}`;
      const pendingId = await createApproval({ decision: 'pending' });
      assert.deepEqual(await store.commitRun(commitInput(randomUUID(), pendingKey, pendingId)), {
        ok: false,
        reason: 'approval_consumed',
      });
      assert.equal(await countRunsByKey(pendingKey), 0);
      assert.equal((await readApproval(pendingId))?.consumed_at ?? null, null);

      // 已过期（decision 仍是 approved，但有效期已过）：到期校验落在消费语句内，不是先读后写。
      const expiredKey = `key-${randomUUID()}`;
      const expiredId = await createApproval({ expiresInMs: -60_000 });
      assert.deepEqual(await store.commitRun(commitInput(randomUUID(), expiredKey, expiredId)), {
        ok: false,
        reason: 'approval_consumed',
      });
      assert.equal(await countRunsByKey(expiredKey), 0);
      assert.equal((await readApproval(expiredId))?.consumed_at ?? null, null);
    });

    it('commitRun 对同一幂等键重复登记返回 idempotent_replay', async () => {
      const key = `key-${randomUUID()}`;
      const first = await store.commitRun(commitInput(randomUUID(), key, await createApproval()));
      assert.ok(first.ok);

      // 同一幂等键 + 新凭证：UNIQUE (engagement_id, idempotency_key) 挡下，凭证也不被烧掉。
      const spareApproval = await createApproval();
      const replay = await store.commitRun(commitInput(randomUUID(), key, spareApproval));
      assert.deepEqual(replay, { ok: false, reason: 'idempotent_replay' });
      assert.equal(await countRunsByKey(key), 1);
      assert.equal((await readApproval(spareApproval))?.consumed_at ?? null, null);

      // 无凭证路径同样命中重放。
      assert.deepEqual(
        await store.commitRun(commitInput(randomUUID(), key, null)),
        { ok: false, reason: 'idempotent_replay' },
      );
      assert.equal(await countRunsByKey(key), 1);
    });

    it('commitRun 的原子条件包含 policy_epoch / scope_version：提交窗口内前进即 stale_state_version', async () => {
      // 事故（2026-10-05）：admit 复核通过之后、commitRun 提交之前版本前进时，
      // 旧版本的计划仍会登记并接触目标。版本条件必须与登记同语句判定。
      const approvalId = await createApproval();
      const toolRunId = randomUUID();
      const key = `key-${randomUUID()}`;
      const before = await pool.query<{ policy_epoch: string }>(
        `select policy_epoch from pentest.engagements where id = $1::uuid`,
        [engagementId],
      );
      await pool.query(`update pentest.engagements set policy_epoch = policy_epoch + 1 where id = $1::uuid`, [
        engagementId,
      ]);
      try {
        assert.deepEqual(await store.commitRun(commitInput(toolRunId, key, approvalId)), {
          ok: false,
          reason: 'stale_state_version',
        });
        assert.equal(await countRunsByKey(key), 0, '版本不匹配不得登记运行');
        assert.equal((await readApproval(approvalId))?.consumed_at ?? null, null, '版本不匹配不得烧掉凭证');
      } finally {
        await pool.query(`update pentest.engagements set policy_epoch = $2::bigint where id = $1::uuid`, [
          engagementId,
          before.rows[0]!.policy_epoch,
        ]);
      }
      // 版本恢复后同一凭证仍能提交：证明上面挡下它的正是版本闸门。
      const retried = await store.commitRun(commitInput(toolRunId, key, approvalId));
      assert.ok(retried.ok);
    });

    it('语句失败时整体回滚：凭证未被烧掉，不留半完成状态', async () => {
      // 先占用一个运行 id，使后续登记必然撞主键（PK 冲突不在 ON CONFLICT 目标上，故整条语句失败）。
      const occupiedId = randomUUID();
      const occupied = await store.commitRun(
        commitInput(occupiedId, `key-${randomUUID()}`, await createApproval()),
      );
      assert.ok(occupied.ok);

      const approvalId = await createApproval();
      const doomedKey = `key-${randomUUID()}`;
      await assert.rejects(
        () => store.commitRun(commitInput(occupiedId, doomedKey, approvalId)),
        (error: unknown) => pgErrorCode(error) === UNIQUE_VIOLATION,
      );

      // 单条语句失败 = 全部 CTE 回滚：既没有消费凭证，也没有留下运行。
      const approval = await readApproval(approvalId);
      assert.equal(approval?.consumed_at ?? null, null);
      assert.equal(approval?.consumed_by_tool_run ?? null, null);
      assert.equal(await countRunsByKey(doomedKey), 0);

      // 「未留半完成状态」是可用的：同一凭证换个运行 id 重试仍能成功。
      const retriedKey = `key-${randomUUID()}`;
      const retriedRunId = randomUUID();
      const retried = await store.commitRun(commitInput(retriedRunId, retriedKey, approvalId));
      assert.ok(retried.ok);
      assert.equal(await countRunsByKey(retriedKey), 1);
      assert.equal((await readApproval(approvalId))?.consumed_by_tool_run, retriedRunId);
    });

    it('commitRun 拒绝非 uuid 标识（装配必须注入 newId: () => randomUUID()）', async () => {
      await assert.rejects(
        () => store.commitRun(commitInput('run-2f1c', `key-${randomUUID()}`, null)),
        /必须是 uuid/,
      );
      await assert.rejects(() => store.getApproval('approval-1'), /必须是 uuid/);
    });

    // ───────────────────────────── consumeApproval：一次性 ─────────────────────────────

    it('consumeApproval 一次性消费：第二次返回 false', async () => {
      const approvalId = await createApproval();
      const toolRunId = randomUUID();
      const commit = await store.commitRun(commitInput(toolRunId, `key-${randomUUID()}`, null));
      assert.ok(commit.ok);

      assert.equal(await store.consumeApproval(approvalId, toolRunId), true);
      assert.equal(await store.consumeApproval(approvalId, toolRunId), false);

      const approval = await readApproval(approvalId);
      assert.equal(approval?.consumed_by_tool_run, toolRunId);
      // 不存在与未放行同样返回 false，不抛错。
      assert.equal(await store.consumeApproval(randomUUID(), toolRunId), false);
      const pendingId = await createApproval({ decision: 'pending' });
      assert.equal(await store.consumeApproval(pendingId, toolRunId), false);
      assert.equal((await readApproval(pendingId))?.consumed_at ?? null, null);
    });

    it('consumeApproval 拒绝跨 session 与跨 engagement 的消费，且凭证保持未消费', async () => {
      const bindingEngagementId = randomUUID();
      const bindingSourceSessionId = randomUUID();
      const bindingOtherSessionId = randomUUID();
      const otherEngagementId = randomUUID();
      const otherSessionId = randomUUID();
      extraEngagementIds.push(bindingEngagementId, otherEngagementId);

      for (const [id, name] of [
        [bindingEngagementId, 'execution-store-binding'],
        [otherEngagementId, 'execution-store-other'],
      ] as const) {
        await pool.query(
          `insert into pentest.engagements (id, tenant_id, name, status, current_status,
               target_snapshot, scope_snapshot, roe_snapshot, policy_snapshot, config_snapshot, created_by,
               policy_epoch)
           values ($1, 'test', $2, 'running', 'ready',
               '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, 'node-test',
               $3::bigint)`,
          [id, name, PLAN_INPUT.policyEpoch],
        );
      }
      await pool.query(
        `insert into pentest.worker_sessions (id, engagement_id, dsh_session_id, phase, profile_id,
             profile_revision, task_prompt, tool_filter, skill_ids, model_route, scope_version, status)
         values ($1, $2, $3, 'intelligence-gathering', 'p', 'r1', 'tp',
             '{}'::jsonb, '[]'::jsonb, '{}'::jsonb, $4::integer, 'active')`,
        [bindingSourceSessionId, bindingEngagementId, `dsh-${bindingSourceSessionId}`, PLAN_INPUT.scopeVersion],
      );
      await pool.query(
        `insert into pentest.session_leases (engagement_id, worker_session_id, generation, expires_at)
         values ($1::uuid, $2::uuid, 1, now() + interval '1 hour')`,
        [bindingEngagementId, bindingSourceSessionId],
      );
      await pool.query(
        `insert into pentest.worker_sessions (id, engagement_id, dsh_session_id, phase, profile_id,
             profile_revision, task_prompt, tool_filter, skill_ids, model_route, scope_version, status)
         values ($1, $2, $3, 'intelligence-gathering', 'p', 'r1', 'tp',
             '{}'::jsonb, '[]'::jsonb, '{}'::jsonb, $4::integer, 'active')`,
        [otherSessionId, otherEngagementId, `dsh-${otherSessionId}`, PLAN_INPUT.scopeVersion],
      );
      await pool.query(
        `insert into pentest.session_leases (engagement_id, worker_session_id, generation, expires_at)
         values ($1::uuid, $2::uuid, 1, now() + interval '1 hour')`,
        [otherEngagementId, otherSessionId],
      );

      const approvalId = await createApproval({ workerSessionId: bindingSourceSessionId });
      await pool.query(
        `update pentest.worker_sessions
            set status = 'closed', ended_at = now()
          where id = $1::uuid`,
        [bindingSourceSessionId],
      );
      await pool.query(
        `insert into pentest.worker_sessions (id, engagement_id, dsh_session_id, phase, profile_id,
             profile_revision, task_prompt, tool_filter, skill_ids, model_route, scope_version, status)
         values ($1, $2, $3, 'intelligence-gathering', 'p', 'r1', 'tp',
             '{}'::jsonb, '[]'::jsonb, '{}'::jsonb, $4::integer, 'active')`,
        [bindingOtherSessionId, bindingEngagementId, `dsh-${bindingOtherSessionId}`, PLAN_INPUT.scopeVersion],
      );
      await pool.query(
        `insert into pentest.session_leases (engagement_id, worker_session_id, generation, expires_at)
         values ($1::uuid, $2::uuid, 1, now() + interval '1 hour')`,
        [bindingEngagementId, bindingOtherSessionId],
      );

      const sameEngagementRun = randomUUID();
      assert.ok((await store.commitRun(
        commitInput(sameEngagementRun, `key-${randomUUID()}`, null, bindingOtherSessionId),
      )).ok);
      assert.equal(await store.consumeApproval(approvalId, sameEngagementRun), false);

      const crossEngagementApprovalId = await createApproval({ workerSessionId: bindingSourceSessionId });
      const crossEngagementRun = randomUUID();
      const otherStore = new PgExecutionStore(db);
      assert.ok((await otherStore.commitRun(
        commitInput(crossEngagementRun, `key-${randomUUID()}`, null, otherSessionId),
      )).ok);
      assert.equal(await store.consumeApproval(crossEngagementApprovalId, crossEngagementRun), false);
      assert.equal((await readApproval(approvalId))?.consumed_at ?? null, null);
      assert.equal((await readApproval(crossEngagementApprovalId))?.consumed_at ?? null, null);
    });

    it('consumeApproval 未登记的运行返回 false，且凭证保持未消费', async () => {
      const approvalId = await createApproval();
      // 绑定查询找不到 tool_runs 行时不执行 UPDATE，不依赖 FK 错误来拒绝。
      assert.equal(await store.consumeApproval(approvalId, randomUUID()), false);
      assert.equal((await readApproval(approvalId))?.consumed_at ?? null, null);
    });


    it('并发消费同一凭证时只有一个成功（条件 UPDATE，无先读后写窗口）', async () => {
      const approvalId = await createApproval();
      const contenders: string[] = [];
      for (let i = 0; i < 8; i += 1) {
        const runId = randomUUID();
        const commit = await store.commitRun(commitInput(runId, `key-${randomUUID()}`, null));
        assert.ok(commit.ok);
        contenders.push(runId);
      }

      const outcomes = await Promise.all(contenders.map((runId) => store.consumeApproval(approvalId, runId)));
      assert.equal(outcomes.filter((ok) => ok).length, 1);
      assert.equal(outcomes.filter((ok) => !ok).length, contenders.length - 1);

      const approval = await readApproval(approvalId);
      const winner = contenders[outcomes.indexOf(true)];
      assert.equal(approval?.consumed_by_tool_run, winner);
      // 部分唯一索引 approvals_single_consumption 只允许一个消费者。
      const consumers = await pool.query<{ n: string }>(
        'select count(*)::text as n from pentest.approvals where consumed_by_tool_run = any($1::uuid[])',
        [contenders],
      );
      assert.equal(consumers.rows[0]?.n, '1');
    });

    // ───────────────────────────── 幂等重放 ─────────────────────────────

    it('findRunByIdempotencyKey 只认已回写结果的运行（含失败/被拒结果）', async () => {
      // 1) 已登记但未回写：不参与重放（调用方据 null 继续走执行前重裁决）。
      const inFlightKey = `key-${randomUUID()}`;
      const inFlightId = randomUUID();
      const inFlight = await store.commitRun(commitInput(inFlightId, inFlightKey, await createApproval()));
      assert.ok(inFlight.ok);
      assert.equal(await store.findRunByIdempotencyKey(inFlightKey), undefined);

      // 2) 回写成功结果后命中，返回原结果与计划摘要。
      const completed = { status: 'completed', exitCode: 0, stdout: 'PORT 8443/tcp open' } as const;
      await store.finishRun(inFlightId, completed);
      const replayed = await store.findRunByIdempotencyKey(inFlightKey);
      assert.ok(replayed !== undefined);
      assert.equal(replayed.toolRunId, inFlightId);
      assert.equal(replayed.idempotencyKey, inFlightKey);
      assert.equal(replayed.planHash, PLAN_HASH);
      assert.deepEqual(replayed.result, completed);

      // 3) 沙箱拒绝/运行失败的结果同样参与重放：防的是「重放放大」，不是「重试成功」。
      const blockedKey = `key-${randomUUID()}`;
      const blockedId = randomUUID();
      const blockedCommit = await store.commitRun(commitInput(blockedId, blockedKey, await createApproval()));
      assert.ok(blockedCommit.ok);
      const blockedResult = {
        status: 'blocked',
        error: { status: 'blocked', code: 'sandbox_unavailable', message: '沙箱不可用', next_action: '确认沙箱' },
      } as const;
      await store.finishRun(blockedId, blockedResult);
      const blockedReplay = await store.findRunByIdempotencyKey(blockedKey);
      assert.equal(blockedReplay?.toolRunId, blockedId);
      assert.deepEqual(blockedReplay?.result, blockedResult);

      // 4) 参数不同即不同的幂等键：不命中（服务侧再比对 planHash 拒绝复用他人结果）。
      assert.equal(await store.findRunByIdempotencyKey(`key-${randomUUID()}`), undefined);
    });

    // ───────────────────────────── finishRun：一次性前向结算 ─────────────────────────────

    it('finishRun 一次写完全部结算列，终态不可回退（002 触发器）', async () => {
      const key = `key-${randomUUID()}`;
      const toolRunId = randomUUID();
      const commit = await store.commitRun(commitInput(toolRunId, key, await createApproval()));
      assert.ok(commit.ok);

      const artifactId = randomUUID();
      const result = {
        status: 'completed',
        exitCode: 0,
        stdout: '8443/tcp open  ssl/http',
        stderr: '',
        truncated: false,
        artifactIds: [artifactId],
      } as const;
      await store.finishRun(toolRunId, result);

      const run = await readRun(toolRunId);
      assert.ok(run !== undefined);
      assert.equal(run.status, 'completed');
      assert.ok(run.finished_at instanceof Date);
      assert.equal(run.exit_code, 0);
      // 字节原样落库（不压缩，与 ledger 对 raw_payload_zstd 的约定一致）。
      assert.equal(Buffer.from(run.stdout_zstd ?? Buffer.alloc(0)).toString('utf8'), result.stdout);
      assert.equal(Buffer.from(run.stderr_zstd ?? Buffer.alloc(0)).toString('utf8'), '');
      assert.deepEqual(run.result_json, result);
      assert.deepEqual(run.artifact_ids, [artifactId]);

      // 终态不可回退、结算列不可覆盖：二次回写被 002 的触发器拒绝，原记录保持不变。
      await assert.rejects(
        () => store.finishRun(toolRunId, { status: 'runtime_error', exitCode: 1 }),
        (error: unknown) => pgErrorCode(error) === RESTRICT_VIOLATION,
      );
      const after = await readRun(toolRunId);
      assert.equal(after?.status, 'completed');
      assert.equal(after?.exit_code, 0);

      // finishRun 对不存在的运行必须响亮失败，不静默丢结果。
      await assert.rejects(() => store.finishRun(randomUUID(), result), /不存在运行/);
    });
  },
);
