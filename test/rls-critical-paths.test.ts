/**
 * 关键路径的**真实角色**测试（2026-10-05 复核 §B7）。
 *
 * 背景：绝大多数集成测试用**超级用户**连接，而超级用户绕过全部 RLS——那些测试因此
 * 既证明不了「策略生效」，也发现不了「上下文缺失导致静默 0 行」这一类缺陷：
 * 租约清扫的 REQ-2 事故正是这样长期不可见的（`pg-lease.test.ts` 的清扫用例用的是
 * 无上下文的超级用户连接，恒绿）。
 *
 * 本文件把两条**出过事故**的关键路径放进 `pentest_app` 角色：
 *   1. 到期清扫：作业作用域下必须真的清扫（此前影响 0 行且不报错）；
 *   2. 审批撤销：`approved(未消费) → revoked` 的受保护边真实可用，
 *      且跨作业、已消费仍然被拒。
 *
 * 手法与 `rls-isolation.test.ts` 一致：**种子数据用拥有者连接写入**，
 * 断言一律在 `set role pentest_app` + 事务内 `set_rls_context` 之后执行。
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Pool, type PoolClient } from 'pg';

import type { DbClient } from '../src/db/port.ts';
import { PgLeaseStore } from '../src/workflow/pg-lease.ts';
import { expireLeases } from '../src/workflow/lease.ts';
import { cleanupEngagements } from './helpers/cleanup.ts';

const DATABASE_URL = process.env.PENTEST_DATABASE_URL;
const TENANT = 'rls-critical-tenant';

describe('关键路径：真实角色（pentest_app）+ RLS', { skip: DATABASE_URL === undefined ? '未设置 PENTEST_DATABASE_URL' : false }, () => {
  let pool: Pool;
  const madeEngagements: string[] = [];

  before(() => {
    pool = new Pool({ connectionString: DATABASE_URL, max: 4 });
  });

  after(async () => {
    if (pool === undefined) return;
    await cleanupEngagements(pool, madeEngagements);
    await pool.end();
  });

  /** 种一个作业 + 一个存活会话；返回两者 id。 */
  async function seedEngagement(client: PoolClient): Promise<{ engagementId: string; sessionId: string }> {
    const engagementId = randomUUID();
    const sessionId = randomUUID();
    madeEngagements.push(engagementId);
    await client.query(
      `insert into pentest.engagements
         (id, tenant_id, name, status, current_status, target_snapshot, scope_snapshot, roe_snapshot,
          policy_snapshot, config_snapshot, created_by)
       values ($1::uuid, $2, 'rls-critical-paths', 'running', 'worker_running',
               '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, 'rls-test')`,
      [engagementId, TENANT],
    );
    await client.query(
      `insert into pentest.worker_sessions
         (id, engagement_id, dsh_session_id, phase, profile_id, profile_revision,
          task_prompt, tool_filter, skill_ids, model_route, status)
       values ($1::uuid, $2::uuid, $3, 'intelligence-gathering', 'p', 'r1',
               'tp', '{}'::jsonb, '[]'::jsonb, '{}'::jsonb, 'active')`,
      [sessionId, engagementId, `dsh-${sessionId}`],
    );
    return { engagementId, sessionId };
  }

  async function seedPendingApproval(
    client: PoolClient,
    engagementId: string,
    sessionId: string,
  ): Promise<string> {
    const approvalId = randomUUID();
    await client.query(
      `insert into pentest.approvals
         (id, engagement_id, requested_by_worker, action_class, target_snapshot, command_plan,
          plan_hash, risk_summary, decision, lease_generation, expires_at)
       values ($1::uuid, $2::uuid, $3::uuid, 'passive_read', '{}'::jsonb, '{}'::jsonb,
               'h', '', 'pending', 1, now() + interval '10 minutes')`,
      [approvalId, engagementId, sessionId],
    );
    return approvalId;
  }

  test('到期清扫：租户级上下文影响 0 行，作业作用域下必须真的清扫（REQ-2 事故回归锁）', async () => {
    const client = await pool.connect();
    try {
      const { engagementId, sessionId } = await seedEngagement(client);
      await client.query(
        `insert into pentest.session_leases (engagement_id, worker_session_id, generation, expires_at)
         values ($1::uuid, $2::uuid, 1, now() - interval '1 minute')`,
        [engagementId, sessionId],
      );

      await client.query('set role pentest_app');
      try {
        // 前提校验：**没有作业作用域**时清扫不得命中任何行。这条断言是必要的——
        // 少了它，「清扫成功」可能只是因为连接恰好绕过了 RLS（超级用户恒真）。
        const store = new PgLeaseStore(client as unknown as DbClient, {
          rlsContext: { tenantId: TENANT, engagementId: null },
        });
        const blind = await expireLeases(store, { now: new Date() });
        assert.equal(
          blind.expiredLeases.filter((ref) => ref.workerSessionId === sessionId).length,
          0,
          '租户级上下文下不得清扫到行（这正是事故形态：0 行且不报错）',
        );

        const swept = await expireLeases(store, { now: new Date(), engagementId });
        assert.equal(
          swept.expiredLeases.filter((ref) => ref.workerSessionId === sessionId).length,
          1,
          '作业作用域下必须真的清扫',
        );
      } finally {
        await client.query('reset role');
      }

      const row = await client.query<{ revoked_reason: string | null }>(
        `select revoked_reason from pentest.session_leases where worker_session_id = $1::uuid`,
        [sessionId],
      );
      assert.equal(row.rows[0]?.revoked_reason, 'expired', '理由由端口固定写入 expired');
    } finally {
      client.release();
    }
  });

  test('审批撤销：真实角色下 approved(未消费)→revoked 可用；跨作业与已消费仍拒绝（C-1 回归锁）', async () => {
    const client = await pool.connect();
    try {
      const a = await seedEngagement(client);
      const b = await seedEngagement(client);
      const aApproval = await seedPendingApproval(client, a.engagementId, a.sessionId);
      const bApproval = await seedPendingApproval(client, b.engagementId, b.sessionId);
      const consumedApproval = await seedPendingApproval(client, a.engagementId, a.sessionId);
      const runId = randomUUID();
      await client.query(
        `insert into pentest.tool_runs
           (id, engagement_id, idempotency_key, tool_name, action_class, arguments_json, policy_decision, status)
         values ($1::uuid, $2::uuid, $3, 'pentest_exec', 'passive_read', '{}'::jsonb, '{}'::jsonb, 'succeeded')`,
        [runId, a.engagementId, `rls-critical-${runId}`],
      );

      /**
       * `set_rls_context` 内部是 `set_config(..., is_local => true)`——**事务级**。
       * 在隐式单语句事务里调用它，下一条语句就看不见上下文了（本文件第一次跑就是
       * 这么失败的：`审批不存在、跨 engagement…`）。因此每个动作都要有自己的
       * 显式事务。
       */
      const inAppContext = async <T>(engagementId: string, work: () => Promise<T>): Promise<T> => {
        await client.query('begin');
        try {
          await client.query('select pentest.set_rls_context($1, $2::uuid)', [TENANT, engagementId]);
          const value = await work();
          await client.query('commit');
          return value;
        } catch (error) {
          try {
            await client.query('rollback');
          } catch (rollbackError) {
            // 回滚失败不能顶掉原始错误（它才是「为什么失败」的答案），但也不能丢。
            if (error instanceof Error) {
              error.message += `（附带：回滚也失败——${String(rollbackError)}）`;
            }
          }
          throw error;
        }
      };

      /** 负例：错误会中止事务，因此无论结果如何都回滚，不提交任何东西。 */
      const expectRejected = async (
        engagementId: string,
        run: () => Promise<unknown>,
        pattern: RegExp,
        message: string,
      ): Promise<void> => {
        await client.query('begin');
        try {
          await client.query('select pentest.set_rls_context($1, $2::uuid)', [TENANT, engagementId]);
          await assert.rejects(run, pattern, message);
        } finally {
          // 不吞错：回滚失败意味着这条连接的清理没做完，测试该红（REQ-12）。
          await client.query('rollback');
        }
      };

      await client.query('set role pentest_app');
      try {
        await inAppContext(a.engagementId, () =>
          client.query(`select pentest.resolve_approval($1::uuid, 'approved', 'op', '先批准')`, [aApproval]));
        await inAppContext(a.engagementId, () =>
          client.query(`select pentest.resolve_approval($1::uuid, 'revoked', 'op', '目标已移出范围')`, [aApproval]));

        // 跨作业：B 的凭证在 A 的上下文下不可见。
        await expectRejected(
          a.engagementId,
          () => client.query(`select pentest.resolve_approval($1::uuid, 'approved', 'op', 'x')`, [bApproval]),
          /restrict_violation|审批不存在/u,
          '跨作业的凭证必须拒绝',
        );

        // 已消费：先放行，再（由拥有者补写消费见证后）尝试撤销。
        await inAppContext(a.engagementId, () =>
          client.query(`select pentest.resolve_approval($1::uuid, 'approved', 'op', '批准')`, [consumedApproval]));
      } finally {
        await client.query('reset role');
      }

      await client.query(
        `update pentest.approvals set consumed_at = now(), consumed_by_tool_run = $2::uuid where id = $1::uuid`,
        [consumedApproval, runId],
      );

      await client.query('set role pentest_app');
      try {
        await expectRejected(
          a.engagementId,
          () => client.query(`select pentest.resolve_approval($1::uuid, 'revoked', 'op', '晚了')`, [consumedApproval]),
          /restrict_violation|已消费/u,
          '已消费的凭证不得撤销',
        );
      } finally {
        await client.query('reset role');
      }

      const rows = await client.query<{ id: string; decision: string; decision_reason: string; consumed_at: Date | null }>(
        `select id, decision, decision_reason, consumed_at from pentest.approvals where id = any($1::uuid[])`,
        [[aApproval, consumedApproval]],
      );
      const revoked = rows.rows.find((row) => row.id === aApproval);
      assert.equal(revoked?.decision, 'revoked', '真实角色下 approved(未消费) 必须可撤销');
      assert.equal(revoked?.decision_reason, '目标已移出范围');
      assert.equal(revoked?.consumed_at, null, '撤销不得触碰消费列');
      const consumed = rows.rows.find((row) => row.id === consumedApproval);
      assert.equal(consumed?.decision, 'approved', '已消费的凭证必须保持 approved');
    } finally {
      client.release();
    }
  });
});
