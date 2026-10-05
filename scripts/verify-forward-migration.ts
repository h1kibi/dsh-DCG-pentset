/**
 * 前向迁移验收（§9.1、§6.2.0.5）：在**已有旧版本的库**上演练升级，并核查 legacy 回填。
 *
 * ── 为什么需要它 ──
 *
 * 干净库演练只证明「SQL 能跑」；真实升级面对的是**已经装着 engagement 数据**的库，
 * 那才可能出现「回填伪造人类选择」「哈希与投影不一致」「追加写/RLS 对旧库没生效」
 * 这类只有数据在场才暴露的问题。`test/db.test.ts` 在同一张库上做集成测试，
 * 不会新建库，因此这条路径需要一个独立脚本。
 *
 * 用法：
 *   PENTEST_DATABASE_URL=postgresql://<可建库的角色>@host:5432/<任意库> \
 *     node --experimental-strip-types scripts/verify-forward-migration.ts
 *
 * 它会在**同一集群**上创建 `<原库名>_forward_verify`，跑完（无论成败）自动删掉。
 * 连接角色需要 `CREATEDB`；不满足时会以明确错误退出，而不是留半截库。
 */

import { randomUUID } from 'node:crypto';
import pg from 'pg';
import {
  ensureMigrationsTable,
  loadMigrations,
  migrate,
  recordAppliedMigration,
  splitSqlStatements,
} from '../src/db/migrate.ts';

const BASE_URL = process.env['PENTEST_DATABASE_URL'] ?? '';
if (BASE_URL === '') {
  console.error('缺少 PENTEST_DATABASE_URL（需要可 CREATEDB 的角色）');
  process.exit(2);
}

const source = new URL(BASE_URL);
const DB = `${source.pathname.replace(/^\//, '').replace(/[^A-Za-z0-9_]/g, '_') || 'pentest'}_forward_verify`;
const DB_URL = ((): string => {
  const url = new URL(BASE_URL);
  url.pathname = `/${DB}`;
  return url.toString();
})();
const ADMIN_URL = ((): string => {
  const url = new URL(BASE_URL);
  url.pathname = '/postgres';
  return url.toString();
})();

let checks = 0;

function ok(condition: unknown, message: string): void {
  checks += 1;
  if (condition) return;
  throw new Error(`断言失败：${message}`);
}

async function admin(sql: string, params?: readonly unknown[]): Promise<void> {
  const client = new pg.Client({ connectionString: ADMIN_URL });
  await client.connect();
  try {
    await client.query(sql, params as unknown[] | undefined);
  } finally {
    await client.end();
  }
}

const legacyA = randomUUID();
const legacyB = randomUUID();
const legacyScopeId = randomUUID();

try {
  await admin(`drop database if exists ${DB}`);
  await admin(`create database ${DB}`);

  const client = new pg.Client({ connectionString: DB_URL });
  await client.connect();
  try {
    // ── 1. 只跑到 016，模拟「生产上已经在跑的旧库」 ──
    await ensureMigrationsTable(client);
    const files = await loadMigrations();
    const upTo16 = files.filter((f) => f.version <= 16);
    for (const file of upTo16) {
      for (const statement of splitSqlStatements(file.sql)) await client.query(statement);
      await recordAppliedMigration(client, file.version, file.fileName);
    }
    const legacyVersion = await client.query<{ v: number }>('select max(version) as v from pentest.schema_migrations');
    ok(legacyVersion.rows[0]?.v === 16, `旧库必须停在版本 16，实际 ${String(legacyVersion.rows[0]?.v)}`);

    // ── 2. 旧库里放真实数据（legacy 缺 profile / 缺哈希） ──
    await client.query(
      `insert into pentest.engagements
         (id, tenant_id, name, status, current_status, target_snapshot, scope_snapshot, roe_snapshot,
          policy_snapshot, config_snapshot, created_by)
       values ($1::uuid,'legacy','legacy-a','running','ready','{}'::jsonb,
               '{"version":1,"authorizationExpiresAt":"2030-01-01T00:00:00Z"}','{}'::jsonb,
               '{"approval_required":["exploit_validation"]}'::jsonb,'{}'::jsonb,'human-a'),
              ($2::uuid,'legacy','legacy-b','running','ready','{}'::jsonb,'{}'::jsonb,'{}'::jsonb,
               '{}'::jsonb,'{}'::jsonb,'human-b')`,
      [legacyA, legacyB],
    );
    await client.query(
      `insert into pentest.scope_versions
         (id, engagement_id, version, iteration, targets, exclusions, authorization_ref, changed_by, content_hash)
       values ($1::uuid,$2::uuid,1,1,'[]'::jsonb,'[]'::jsonb,'AUTH-LEGACY','human-a','sha256:legacy-a')`,
      [legacyScopeId, legacyA],
    );
    await client.query('commit').catch(() => undefined);
  } finally {
    await client.end();
  }

  // ── 3. 前向迁移：016 之后的**全部**迁移都该按序应用 ──
  // （这里曾经把「017/018」写死。019 之后再加迁移就会假红——判据要跟着实现走，
  //   而不是跟着「写这份脚本时的迁移清单」走。）
  const pool = new pg.Pool({ connectionString: DB_URL });
  // 收尾会强制断开剩余连接；被断开的空闲连接会让 pg 抛出 'error' 事件，
  // 没有监听者时进程会直接崩——那不是演练结论，只是清理噪声。
  pool.on('error', () => undefined);
  try {
    const files = await loadMigrations();
    const forward = files.filter((f) => f.version > 16).map((f) => f.fileName);
    const first = await migrate({ connectionString: DB_URL });
    ok(
      first.appliedFiles.length === forward.length
        && first.appliedFiles.every((name, index) => name === forward[index]),
      `016 之后的迁移必须全部按序前向应用（${String(forward.length)} 个），实际 ${first.appliedFiles.join(',')}`,
    );
    ok(first.skippedFiles.length === 16, `001–016 必须被跳过，实际跳过 ${String(first.skippedFiles.length)}`);

    // 幂等：再跑一次不应重复执行
    const second = await migrate({ connectionString: DB_URL });
    ok(
      second.appliedFiles.length === 0 && second.skippedFiles.length === files.length,
      `迁移必须幂等（第二次应跳过全部 ${String(files.length)} 个）`,
    );

    // ── 4. legacy 回填：来源明确、哈希自洽、不伪造人类选择 ──
    const backfill = await pool.query<{
      id: string;
      version: number;
      changed_by: string;
      amendment_reason: string;
      content_hash: string;
      recomputed: string;
      projection_hash: string;
      scope_entry_profile: string;
      behavior_profile: string;
      policy_version: number;
      legacy_snapshot: boolean;
    }>(
      `select e.id, p.version, p.changed_by, p.amendment_reason, p.content_hash,
              'sha256:' || encode(digest(convert_to(p.policy_snapshot::text, 'UTF8'), 'sha256'), 'hex') as recomputed,
              e.policy_snapshot_hash as projection_hash,
              e.scope_entry_profile, e.behavior_profile, e.policy_version,
              (p.policy_snapshot->>'legacy')::text = 'true' as legacy_snapshot
         from pentest.engagements e
         join pentest.policy_versions p on p.engagement_id = e.id and p.version = e.policy_version
        where e.tenant_id = 'legacy'
        order by e.name`,
    );
    ok(backfill.rows.length === 2, '两个 legacy 作业都必须有可回放的策略版本');
    for (const row of backfill.rows) {
      ok(row.changed_by === 'migration', `回填来源必须是 migration，实际 ${row.changed_by}`);
      ok(row.amendment_reason.includes('017'), '回填原因必须指向 017');
      ok(row.legacy_snapshot, 'legacy 快照必须显式标记 legacy=true');
      ok(row.content_hash === row.recomputed, '回填哈希必须与回填内容自洽（PG 侧可复核）');
      ok(row.projection_hash === row.content_hash, '当前投影哈希必须等于回填版本的内容哈希');
      ok(row.policy_version === 1 && row.version === 1, 'legacy 版本号必须为 1');
    }
    const a = backfill.rows.find((r) => r.id === legacyA);
    const b = backfill.rows.find((r) => r.id === legacyB);
    ok(a?.scope_entry_profile === 'custom' && a?.behavior_profile === 'stealth', '缺失 profile 的旧行按可确定默认值回填');
    ok(b?.scope_entry_profile === 'custom' && b?.behavior_profile === 'stealth', '空快照的旧行同样按默认值回填');

    // 历史数据不得被补写虚假的人类选择事件
    const fake = await pool.query<{ n: string }>(
      `select count(*)::text as n from pentest.context_events
        where event_type in ('policy.profile.selected','policy.snapshot.confirmed','policy.snapshot.frozen')`,
    );
    ok(fake.rows[0]?.n === '0', '不得为历史数据补写策略选择事件');

    // ── 5. 追加写与 RLS 在旧库上同样生效 ──
    const probe = new pg.Client({ connectionString: DB_URL });
    await probe.connect();
    try {
      await probe.query('begin');
      await probe.query(`select pentest.set_rls_context('legacy', $1::uuid, null)`, [legacyA]);
      await probe.query('set local role pentest_app');
      const visible = await probe.query<{ id: string }>('select id from pentest.policy_versions');
      ok(visible.rowCount === 1 && visible.rows[0]?.id !== undefined, '本作业的策略版本可读');
      const other = await probe.query<{ id: string }>(
        'select id from pentest.policy_versions where engagement_id = $1::uuid',
        [legacyB],
      );
      ok(other.rowCount === 0, '跨 engagement 读不到别的作业的策略版本');
      await probe.query('rollback');

      // 租户边界（RESTRICTIVE）：**知道 engagement 标识也不行**——上下文里的租户与
      // 该作业的租户不符时，一行都读不到。缺了 018 的那条策略，这里会读到 legacyA 的版本。
      await probe.query('begin');
      await probe.query(`select pentest.set_rls_context('other-tenant', $1::uuid, null)`, [legacyA]);
      await probe.query('set local role pentest_app');
      const crossTenant = await probe.query<{ id: string }>('select id from pentest.policy_versions');
      ok(crossTenant.rowCount === 0, '租户不符时必须读不到任何策略版本（RESTRICTIVE 边界）');
      await probe.query('rollback');
    } finally {
      await probe.query('reset role').catch(() => undefined);
      // 必须显式关闭：留一条连接会让收尾的 `drop database` 报
      // 「being accessed by other users」，把演练变成留下一个半截库。
      await probe.end().catch(() => undefined);
    }

    const writes = new pg.Client({ connectionString: DB_URL });
    await writes.connect();
    try {
      await writes.query('begin');
      await writes.query(`select pentest.set_rls_context('legacy', $1::uuid, null)`, [legacyA]);
      await writes.query('set local role pentest_app');
      // INSERT 允许（新版本只追加）
      await writes.query(
        `insert into pentest.policy_versions
           (engagement_id, version, scope_entry_profile, behavior_profile, policy_snapshot,
            content_hash, policy_epoch, changed_by, amendment_reason)
         values ($1::uuid, 99, 'custom', 'stealth', '{}'::jsonb, 'sha256:probe', 0, 'probe', 'probe')`,
        [legacyA],
      );
      // UPDATE / DELETE 被追加写触发器拒绝
      for (const [label, sql] of [
        ['update', `update pentest.policy_versions set changed_by = 'tamper' where version = 99`],
        ['delete', `delete from pentest.policy_versions where version = 99`],
      ] as const) {
        let rejected = false;
        try {
          await writes.query(sql);
        } catch {
          rejected = true;
        }
        ok(rejected, `pentest_app 的 ${label} 必须被拒绝（只追加）`);
        if (rejected) await writes.query('rollback').then(
          async () => {
            await writes.query('begin');
            await writes.query(`select pentest.set_rls_context('legacy', $1::uuid, null)`, [legacyA]);
            await writes.query('set local role pentest_app');
          },
        );
      }
      await writes.query('rollback');
    } finally {
      await writes.query('reset role').catch(() => undefined);
      await writes.end();
    }

    console.log(`前向迁移演练通过：${String(checks)} 项断言`);
  } finally {
    await pool.end();
  }
} finally {
  // 删库前先踢掉所有连接：池与探针连接释放存在竞态，直接 drop 会以
  // 「database is being accessed by other users」失败，留下一个半截库。
  await admin(
    `select pg_terminate_backend(pid) from pg_stat_activity where datname = $1 and pid <> pg_backend_pid()`,
    [DB],
  ).catch(() => undefined);
  await admin(`drop database if exists ${DB}`).catch((error: unknown) => {
    // 清理失败不掩盖演练结论，但必须**说出来**：否则用户以为没留下东西。
    console.error(`清理失败：请手工删除数据库 ${DB}（${error instanceof Error ? error.message : String(error)}）`);
    process.exitCode = 1;
  });
}
