/**
 * 清理夹具自检（2026-10-05 复核 REQ-12）。
 *
 * 这个文件的理由：清理清单是本仓集成测试的公共地基，而它此前**漏过表**——
 * `request_snapshots` 有外键指回 `engagements`，漏了它意味着「将来某次给测试加上
 * 请求快照写入后，另一个文件的清理会抛 23503」，而因果极难追。
 *
 * 两件事被钉住：
 *   1. **清单 vs schema**：每一张带 `engagement_id` 的表都必须在清理清单里；
 *   2. **端到端**：夹具确实删得掉（含补上的那几张），且 `assertNoResidue` 真的
 *      能判出残留——它是「清理有没有生效」这件事本身的判据。
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';

import { assertNoResidue, CLEANUP_TARGET_TABLES, cleanupEngagements } from './helpers/cleanup.ts';

const DATABASE_URL = process.env.PENTEST_DATABASE_URL;

describe(
  '清理夹具自检（真实 PostgreSQL）',
  { skip: DATABASE_URL === undefined ? '未设置 PENTEST_DATABASE_URL' : false },
  () => {
    let pool: Pool;

    before(() => {
      pool = new Pool({ connectionString: DATABASE_URL, max: 4 });
    });

    after(async () => {
      if (pool === undefined) return;
      await pool.end();
    });

    test('清理清单覆盖每一张带 engagement_id 的表（漏表的代价是别处的 23503）', async () => {
      const rows = await pool.query<{ table_name: string }>(
        `select c.relname as table_name
           from pg_class c
           join pg_namespace n on n.oid = c.relnamespace
           join pg_attribute a on a.attrelid = c.oid and a.attname = 'engagement_id' and a.attnum > 0
          where n.nspname = 'pentest' and c.relkind = 'r'
          order by c.relname`,
      );
      const missing = rows.rows
        .map((row) => row.table_name)
        .filter((table) => !CLEANUP_TARGET_TABLES.includes(table));
      assert.deepEqual(
        missing,
        [],
        `这些表带 engagement_id 却不在清理清单里：${missing.join('、')}。` +
          '补进 helpers/cleanup.ts 的 CLEANUP_TARGETS（有外键指回 engagements 的会让删作业失败）。',
      );
    });

    test('夹具删得掉带外键的子表（request_snapshots），且残留可被判出', async () => {
      const engagementId = randomUUID();
      const workerSessionId = randomUUID();
      await pool.query(
        `insert into pentest.engagements
           (id, tenant_id, name, status, current_status, target_snapshot, scope_snapshot,
            roe_snapshot, policy_snapshot, config_snapshot, created_by)
         values ($1::uuid, 't', 'cleanup-fixture', 'running', 'ready', '{}'::jsonb, '{}'::jsonb,
                 '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, 'tester')`,
        [engagementId],
      );
      await pool.query(
        `insert into pentest.worker_sessions
           (id, engagement_id, dsh_session_id, phase, profile_id, profile_revision,
            task_prompt, tool_filter, model_route, status)
         values ($1::uuid, $2::uuid, $3, 'intelligence-gathering', 'p1', 'r1',
                 '清理夹具自检', '{"allow":[]}'::jsonb, '{}'::jsonb, 'active')`,
        [workerSessionId, engagementId, `dsh-cleanup-${randomUUID()}`],
      );
      // 请求快照：**有外键指回 engagements**，正是清单曾经漏掉的那张（漏它的表现是
      // 「删作业」抛 23503，而不是多几行残留）。
      await pool.query(
        `insert into pentest.request_snapshots
           (engagement_id, worker_session_id, assembler_version, assembled_zstd, content_hash)
         values ($1::uuid, $2::uuid, 'v1', '\\x00'::bytea, 'sha256:cleanup-fixture')`,
        [engagementId, workerSessionId],
      );

      // 残留判据本身必须有效：此刻还没清，断言必须抛。
      await assert.rejects(
        () => assertNoResidue(pool, [engagementId]),
        /清理未生效/,
        'assertNoResidue 必须在有残留时抛——否则它是空转的',
      );

      await cleanupEngagements(pool, [engagementId]);
      await assertNoResidue(pool, [engagementId]);

      const snapshots = await pool.query<{ n: string }>(
        'select count(*)::text as n from pentest.request_snapshots where engagement_id = $1::uuid',
        [engagementId],
      );
      assert.equal(snapshots.rows[0]!.n, '0', '带外键的子表也必须被清掉');
    });
  },
);
