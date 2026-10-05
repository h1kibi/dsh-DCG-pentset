/**
 * 表结构验收脚本（设计文档 §9）。
 *
 * 用途：在真实 PostgreSQL（含 pgvector、pg_trgm）上执行 migrations/*.sql，
 *       输出对象计数，并在任何语句失败或对象缺失时以非零码退出。
 *
 * 连接串：环境变量 PENTEST_DATABASE_URL。
 * 默认在单个事务内执行并**回滚**（dry-run，可重复运行，不改动数据库）；
 * 加 --keep 则提交，并把已执行的迁移登记到 pentest.schema_migrations，
 * 使后续 migrate() 成为幂等空操作。
 * 目标库已有 pentest 对象时默认响亮拒绝；确需重建时显式加 --recreate（先 DROP SCHEMA）。
 *
 * 运行：node --experimental-strip-types scripts/verify-schema.ts [--keep] [--recreate]
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import {
  declaredIndexNames,
  declaredTableNames,
  ensureMigrationsTable,
  loadMigrations,
  recordAppliedMigration,
  splitMigrationStatements,
} from '../src/db/migrate.ts';

const keep = process.argv.includes('--keep');
const recreate = process.argv.includes('--recreate');
const migrationsDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'db', 'migrations');

async function main(): Promise<void> {
  const connectionString = process.env['PENTEST_DATABASE_URL'];
  if (!connectionString) {
    throw new Error('缺少数据库连接串：请设置环境变量 PENTEST_DATABASE_URL');
  }

  const migrations = await loadMigrations(migrationsDir);
  const allSql = migrations.map((m) => m.sql).join('\n');
  const expectedTables = declaredTableNames(allSql);
  const expectedIndexes = declaredIndexNames(allSql);

  const client = new pg.Client({ connectionString });
  await client.connect();
  let failure: string | null = null;
  let inTransaction = false;
  try {
    const existing = await client.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'pentest' AND c.relkind IN ('r','p','i')`,
    );
    const existingObjects = Number(existing.rows[0]?.n ?? '0');
    if (existingObjects > 0 && !recreate) {
      throw new Error(
        `目标库 pentest schema 已有 ${existingObjects} 个对象；本脚本按 §9.2 原样建表，请指向空库，` +
          '或明确加 --recreate 重建（会 DROP SCHEMA pentest CASCADE）',
      );
    }

    await client.query('BEGIN');
    inTransaction = true;
    if (existingObjects > 0) {
      console.log(`--recreate：先删除已有 pentest schema（${existingObjects} 个对象）`);
      await client.query('DROP SCHEMA pentest CASCADE');
    }
    for (const file of migrations) {
      const statements = splitMigrationStatements(file.sql);
      for (let i = 0; i < statements.length; i += 1) {
        try {
          await client.query(statements[i] as string);
        } catch (err) {
          throw new Error(
            `${file.fileName} 第 ${i + 1}/${statements.length} 条语句失败：${
              err instanceof Error ? err.message : String(err)
            }`,
            { cause: err },
          );
        }
      }
      console.log(`执行 ${file.fileName}：${statements.length} 条语句`);
    }

    const version = await client.query<{ server_version: string }>('SHOW server_version');
    console.log(`PostgreSQL 版本：${version.rows[0]?.server_version ?? '未知'}`);

    const extensions = await queryNames(
      client,
      `SELECT extname AS name FROM pg_extension WHERE extname = ANY($1) ORDER BY extname`,
      [['pgcrypto', 'vector', 'pg_trgm']],
    );

    const tables = await queryNames(
      client,
      `SELECT c.relname AS name FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'pentest' AND c.relkind IN ('r','p')
        ORDER BY c.relname`,
    );
    const indexes = await queryNames(
      client,
      `SELECT c.relname AS name FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'pentest' AND c.relkind = 'i'
        ORDER BY c.relname`,
    );
    const constraints = await queryNames(
      client,
      `SELECT co.conname AS name FROM pg_constraint co
         JOIN pg_namespace n ON n.oid = co.connamespace
        WHERE n.nspname = 'pentest' AND co.contype = $1
        ORDER BY co.conname`,
      ['f'],
    );
    const checks = await queryNames(
      client,
      `SELECT co.conname AS name FROM pg_constraint co
         JOIN pg_namespace n ON n.oid = co.connamespace
        WHERE n.nspname = 'pentest' AND co.contype = 'c'
        ORDER BY co.conname`,
    );
    const deferrableFks = await queryNames(
      client,
      `SELECT co.conname AS name FROM pg_constraint co
         JOIN pg_namespace n ON n.oid = co.connamespace
        WHERE n.nspname = 'pentest' AND co.contype = 'f' AND co.condeferrable
        ORDER BY co.conname`,
    );
    const hnsw = await queryNames(
      client,
      `SELECT c.relname AS name FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace
         JOIN pg_am a ON a.oid = c.relam
        WHERE n.nspname = 'pentest' AND c.relkind = 'i' AND a.amname = 'hnsw'
        ORDER BY c.relname`,
    );
    const gin = await queryNames(
      client,
      `SELECT c.relname AS name FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace
         JOIN pg_am a ON a.oid = c.relam
        WHERE n.nspname = 'pentest' AND c.relkind = 'i' AND a.amname = 'gin'
        ORDER BY c.relname`,
    );

    const missingTables = expectedTables.filter((t) => !tables.includes(t));
    const missingIndexes = expectedIndexes.filter((t) => !indexes.includes(t));
    const missingExtensions = ['pgcrypto', 'vector', 'pg_trgm'].filter((e) => !extensions.includes(e));

    console.log('');
    console.log('── 对象计数 ────────────────────────────────');
    console.log(`表            : ${tables.length}（DDL 声明 ${expectedTables.length}）`);
    console.log(`索引          : ${indexes.length}（DDL 显式声明 ${expectedIndexes.length}）`);
    console.log(`外键          : ${constraints.length}`);
    console.log(`CHECK 约束    : ${checks.length}`);
    console.log(`可延迟外键    : ${deferrableFks.length} → ${deferrableFks.join(', ') || '（无）'}`);
    console.log(`HNSW 索引     : ${hnsw.length} → ${hnsw.join(', ') || '（无）'}`);
    console.log(`GIN 索引      : ${gin.length} → ${gin.join(', ') || '（无）'}`);
    console.log(`扩展          : ${extensions.join(', ') || '（无）'}`);
    console.log('');
    console.log(`表清单        : ${tables.join(', ')}`);

    if (missingExtensions.length) failure = `缺少扩展：${missingExtensions.join(', ')}`;
    else if (missingTables.length) failure = `缺少表：${missingTables.join(', ')}`;
    else if (missingIndexes.length) failure = `缺少索引：${missingIndexes.join(', ')}`;

    if (!failure) {
      console.log('');
      console.log(`全部 ${expectedTables.length} 张表、${expectedIndexes.length} 个显式索引均已创建`);
    }
  } finally {
    if (!inTransaction) {
      await client.end();
    } else if (failure) {
      await client.query('ROLLBACK').catch(() => {});
      await client.end();
    } else if (keep) {
      // 与迁移器共用登记表，使后续 migrate() 成为幂等空操作
      await ensureMigrationsTable(client);
      for (const file of migrations) {
        await recordAppliedMigration(client, file.version, file.fileName);
      }
      await client.query('COMMIT');
      await client.end();
      console.log('已提交（--keep）：迁移已登记到 pentest.schema_migrations');
    } else {
      await client.query('ROLLBACK');
      await client.end();
      console.log('dry-run：已回滚，未改动数据库（加 --keep 可提交）');
    }
  }

  if (failure) {
    console.error(`验收失败：${failure}`);
    process.exitCode = 1;
  }
}

async function queryNames(client: pg.Client, sql: string, params: unknown[] = []): Promise<string[]> {
  const res = await client.query<{ name: string }>(sql, params);
  return res.rows.map((r) => r.name);
}

try {
  await main();
} catch (err) {
  console.error(`验收失败：${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
}
