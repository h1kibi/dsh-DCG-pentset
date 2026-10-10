/**
 * 零命中诊断的回归锁（真实 PostgreSQL，2026-10-10 操作者实测 P0）。
 *
 * 事故形态：`memory_search` **每次零命中都抛** `column "kind" does not exist`
 *（诊断查询里 `kind` 未限定别名，而 `memory_chunks` 没有这一列），
 * 于是「检索不到」——新作业里的常态——变成「工具报错」，Agent 再也不敢用记忆面。
 *
 * 同一查询还有第二个错：`JOIN context_events` 是 INNER JOIN，把**以记忆条目为来源**
 * 的分块（`source_event_id` 为 NULL）整个丢掉，`totalChunks` 少算、诊断结论跟着失真。
 *
 * 这条锁钉住两件事：
 *   1. 零命中必须**返回**（带 note），不得抛错；
 *   2. note 里的分块计数必须把「条目来源」的分块算进去。
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';

import { PgWorkerTools } from '../src/memory/pg-worker-tools.ts';
import type { DbClient } from '../src/db/port.ts';
import { cleanupEngagements } from './helpers/cleanup.ts';

const DATABASE_URL = process.env.PENTEST_DATABASE_URL;

describe('memory_search 零命中诊断（真实 PostgreSQL）', { skip: DATABASE_URL === undefined ? '未设置 PENTEST_DATABASE_URL' : false }, () => {
  let pool: Pool;
  let tools: PgWorkerTools;
  const madeEngagements: string[] = [];

  const db = (): DbClient => ({
    async query<Row = Record<string, unknown>>(sql: string, params?: readonly unknown[]) {
      const r = await pool.query(sql, params as unknown[] | undefined);
      return { rows: r.rows as Row[], rowCount: r.rowCount };
    },
  });

  before(() => {
    pool = new Pool({ connectionString: DATABASE_URL, max: 4 });
    tools = new PgWorkerTools(db(), {} as never);
  });

  after(async () => {
    if (pool === undefined) return;
    await cleanupEngagements(pool, madeEngagements);
    await pool.end();
  });

  /** 作业 + 一条**条目来源**的分块（正是旧查询会丢掉的那一类）。 */
  async function fixture(): Promise<{ engagementId: string; workerSessionId: string }> {
    const engagementId = randomUUID();
    madeEngagements.push(engagementId);
    await pool.query(
      `insert into pentest.engagements
         (id, tenant_id, name, status, current_status, target_snapshot, scope_snapshot, roe_snapshot, policy_snapshot, config_snapshot, created_by)
       values ($1::uuid, 't', 'mem-diag-test', 'running', 'worker_running', '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, 'tester')`,
      [engagementId],
    );
    const workerSessionId = randomUUID();
    await pool.query(
      `insert into pentest.worker_sessions
         (id, engagement_id, dsh_session_id, phase, profile_id, profile_revision,
          task_prompt, tool_filter, skill_ids, skill_freeze, model_route, status)
       values ($1::uuid, $2::uuid, $3, 'intelligence-gathering', 'p', 'r1',
          'tp', '{}'::jsonb, '[]'::jsonb, '[]'::jsonb, '{}'::jsonb, 'active')`,
      [workerSessionId, engagementId, `dsh-mem-diag-${workerSessionId}`],
    );
    // 读取路径要求「已签发且未过期」的租约（admitWorkerSession）。
    await pool.query(
      `insert into pentest.session_leases (engagement_id, worker_session_id, generation, expires_at)
       values ($1::uuid, $2::uuid, 1, now() + interval '1 hour')`,
      [engagementId, workerSessionId],
    );
    const itemId = randomUUID();
    await pool.query(
      `insert into pentest.memory_items (id, engagement_id, kind, content, trust_level, status, created_by)
       values ($1::uuid, $2::uuid, 'fact', '夹具事实：端口 3002 上跑着 nginx。', 'asserted', 'active', 'tester')`,
      [itemId, engagementId],
    );
    // 条目来源 ⇒ source_event_id 为 NULL（旧查询的 INNER JOIN 正是在这里丢行）。
    await pool.query(
      `insert into pentest.memory_chunks
         (engagement_id, memory_item_id, ordinal, content, content_hash, embedding_revision,
          phase, trust_level, classification, asset_ids)
       values ($1::uuid, $2::uuid, 0, '夹具事实：端口 3002 上跑着 nginx。', 'deadbeef', 'lexical-only',
          'intelligence-gathering', 'asserted', 'engagement', '{}'::uuid[])`,
      [engagementId, itemId],
    );
    return { engagementId, workerSessionId };
  }

  test('零命中：返回带诊断的 note，而不是抛 column "kind" does not exist', async () => {
    const { workerSessionId } = await fixture();
    const result = await tools.search({ workerSessionId, query: 'zzzz-绝不可能命中的词-qx7' });
    assert.equal(result.hits.length, 0);
    assert.ok(result.note !== undefined, '零命中必须给出解释（这是那次修复的意图）');
  });

  test('诊断计数把「条目来源」的分块算进去（INNER JOIN 事件会漏掉它）', async () => {
    const { workerSessionId } = await fixture();
    const result = await tools.search({ workerSessionId, query: 'zzzz-绝不可能命中的词-qx7' });
    assert.match(result.note ?? '', /1 个分块/u, '条目来源的分块必须计入 totalChunks');
  });

  test('带 kinds 过滤的零命中同样返回（诊断里 kind 走 memory_items 的 LEFT JOIN）', async () => {
    const { workerSessionId } = await fixture();
    const result = await tools.search({ workerSessionId, query: 'zzzz-绝不可能命中的词-qx7', kinds: ['fact'] });
    assert.equal(result.hits.length, 0);
    assert.ok(result.note !== undefined);
    assert.match(result.note ?? '', /1 个分块/u);
  });
});
