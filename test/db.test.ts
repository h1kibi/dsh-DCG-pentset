/**
 * 数据库层测试：不依赖真实 PostgreSQL 的结构断言 + 可选的集成用例。
 *
 * 纯逻辑部分断言 SQL 文本与迁移器纯函数；集成部分仅在设置了
 * PENTEST_DATABASE_URL 时运行（首次迁移 + 幂等复跑 + 对象计数）。
 */

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';
import pg from 'pg';
import { LIVE_SESSION_STATUSES, SESSION_STATUSES } from '../src/contracts.ts';
import {
  MIGRATIONS_DIR,
  SchemaVersionError,
  declaredIndexNames,
  declaredTableNames,
  loadMigrations,
  migrate,
  parseMigrationVersion,
  planMigrations,
  splitMigrationStatements,
  splitSqlStatements,
} from '../src/db/migrate.ts';
import { isLeaseRevocationReason } from '../src/workflow/lease.ts';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const INIT_SQL_PATH = path.join(HERE, '..', 'src', 'db', 'migrations', '001_init.sql');
const INIT_SQL = readFileSync(INIT_SQL_PATH, 'utf8');
const SECURITY_SQL_PATH = path.join(HERE, '..', 'src', 'db', 'migrations', '002_security.sql');
const SECURITY_SQL = readFileSync(SECURITY_SQL_PATH, 'utf8');

/**
 * 断言用的无注释文本：002 里 `--` 只出现在行注释中（本文件不含带 `--` 的字面量），
 * 因此直接去掉行注释即可——否则注释里提到的 `CREATE ROLE IF NOT EXISTS` 会被误判成真语句。
 */
const SECURITY_CODE = SECURITY_SQL.replace(/--[^\n]*/g, '');

/** 去掉语句开头的注释与空白，便于用 ^ 锚定语句类型。 */
function stripLeadingComments(statement: string): string {
  return statement.replace(/^(?:\s*(?:--[^\n]*\n|\/\*[\s\S]*?\*\/))*\s*/, '');
}

const STATEMENTS = splitSqlStatements(INIT_SQL);
const CODE_STATEMENTS = STATEMENTS.map(stripLeadingComments);
const CODE_SQL = CODE_STATEMENTS.join('\n');

/**
 * 全部迁移的原文。
 *
 * 对象计数**不从迁移文本推导就会漂移**：这三条断言此前写死着 `29 / 61 / 5`，而 DDL 早已
 * 长到 29 张表、64 个外键、6 个运行态触发器——它们只在没有真实数据库时被跳过，所以
 * 缺陷一直没暴露。写死数字还会训练人「见红灯改数字」，而那种维护动作会掩盖真正的问题
 * （少写一条 RLS、少一个外键）。因此改为从迁移文本推导期望值：DDL 变了，期望值自动跟上；
 * 而「库里与 DDL 不一致」这类真实缺陷仍然会红。
 */
const ALL_MIGRATION_SQL = readdirSync(path.join(HERE, '..', 'src', 'db', 'migrations'))
  .filter((name) => name.endsWith('.sql'))
  .sort()
  .map((name) => readFileSync(path.join(HERE, '..', 'src', 'db', 'migrations', name), 'utf8'))
  .join('\n');

/** DDL 声明的业务表数（不含迁移器自有的 `schema_migrations`）。 */
const DECLARED_TABLES = declaredTableNames(ALL_MIGRATION_SQL).length;

/** DDL 声明的外键数：每条 `REFERENCES pentest.x` 恰好对应一个外键约束。 */
const DECLARED_FOREIGN_KEYS = [...ALL_MIGRATION_SQL.matchAll(/REFERENCES\s+pentest\.\w+/g)].length;

function findStatement(fragment: string): string {
  const found = CODE_STATEMENTS.find((s) => s.includes(fragment));
  assert.ok(found, `未找到语句：${fragment}`);
  return found;
}

function findSecurityStatement(fragment: string): string {
  const found = splitSqlStatements(SECURITY_SQL)
    .map(stripLeadingComments)
    .find((s) => s.includes(fragment));
  assert.ok(found, `未找到语句：${fragment}`);
  return found;
}

describe('splitSqlStatements', () => {
  it('按分号切分并丢弃空语句', () => {
    assert.deepEqual(splitSqlStatements('SELECT 1; SELECT 2;'), ['SELECT 1', 'SELECT 2']);
    assert.deepEqual(splitSqlStatements('  ;;  SELECT 1 ;\n;'), ['SELECT 1']);
    assert.deepEqual(splitSqlStatements(''), []);
  });

  it('字符串字面量里的分号不切分', () => {
    assert.deepEqual(splitSqlStatements("SELECT 'a;b'; SELECT 2"), ["SELECT 'a;b'", 'SELECT 2']);
  });

  it('转义单引号不结束字面量', () => {
    assert.deepEqual(splitSqlStatements("SELECT 'it''s; fine'; SELECT 2"), [
      "SELECT 'it''s; fine'",
      'SELECT 2',
    ]);
  });

  it('行注释与块注释里的分号不切分（块注释支持嵌套）', () => {
    assert.deepEqual(splitSqlStatements('SELECT 1 -- a; b\n; SELECT 2'), ['SELECT 1 -- a; b', 'SELECT 2']);
    assert.deepEqual(splitSqlStatements('SELECT /* a; /* b; */ c; */ 1; SELECT 2'), [
      'SELECT /* a; /* b; */ c; */ 1',
      'SELECT 2',
    ]);
  });

  it('dollar-quote 里的分号不切分', () => {
    assert.deepEqual(splitSqlStatements('DO $$ BEGIN PERFORM 1; END $$; SELECT 2'), [
      'DO $$ BEGIN PERFORM 1; END $$',
      'SELECT 2',
    ]);
    assert.deepEqual(splitSqlStatements('DO $tag$ x; $tag$;'), ['DO $tag$ x; $tag$']);
  });

  it('迁移文件切出的每条语句都以关键字开头', () => {
    for (const code of CODE_STATEMENTS) {
      assert.match(
        code,
        /^(CREATE|ALTER|INSERT|COMMENT|SET|GRANT)\b/i,
        `可疑语句：${code.slice(0, 60)}`,
      );
    }
  });
});

describe('splitMigrationStatements', () => {
  it('过滤迁移文件自带的事务控制语句并保留其他 SQL', () => {
    assert.deepEqual(
      splitMigrationStatements('-- wrapper\nBEGIN;\nCREATE TABLE t (id int);\nCOMMIT;'),
      ['CREATE TABLE t (id int)'],
    );
  });
});

describe('迁移文本对象提取（回归：IF NOT EXISTS 不得被当成对象名）', () => {
  it('declaredIndexNames 接受 IF NOT EXISTS 与 pentest. 限定前缀', () => {
    assert.deepEqual(
      declaredIndexNames(`
        CREATE INDEX pentest.bare_idx ON pentest.t (a);
        CREATE UNIQUE INDEX IF NOT EXISTS uniq_idx ON pentest.t (b);
        CREATE INDEX IF NOT EXISTS pentest.qual_idx ON pentest.t (c);
      `).sort(),
      ['bare_idx', 'qual_idx', 'uniq_idx'],
    );
  });

  it('declaredTableNames 同样接受 IF NOT EXISTS 与限定前缀', () => {
    assert.deepEqual(
      declaredTableNames(`
        CREATE TABLE pentest.alpha (id uuid);
        CREATE TABLE IF NOT EXISTS pentest.beta (id uuid);
      `).sort(),
      ['alpha', 'beta'],
    );
  });

  it('真实迁移文本提取的索引名不含 IF/pentest（db:verify 曾因此在正确库上假失败）', () => {
    const names = declaredIndexNames(ALL_MIGRATION_SQL);
    assert.ok(names.length >= 25, `至少 25 个显式索引，实际 ${names.length}`);
    assert.equal(names.includes('IF'), false, 'IF NOT EXISTS 的 IF 不得被当成索引名');
    assert.equal(names.includes('pentest'), false, '限定前缀不得被当成索引名');
  });
});

describe('001_init.sql 结构', () => {
  it('语句数与对象数量符合设计文档 §9', () => {
    assert.equal(STATEMENTS.length, 63);
    assert.equal(CODE_STATEMENTS.filter((s) => /^CREATE TABLE/i.test(s)).length, 27);
    assert.equal(CODE_STATEMENTS.filter((s) => /^CREATE (?:UNIQUE )?INDEX/i.test(s)).length, 25);
    // 7 条后置外键（004 移除了 worker_sessions_report_fk：它与
    // worker_reports.worker_session_id 构成不可解的外键环）
    assert.equal(CODE_STATEMENTS.filter((s) => /^ALTER TABLE/i.test(s)).length, 7);
  });

  it('扩展与 schema 齐备（§9.1）', () => {
    assert.match(INIT_SQL, /CREATE EXTENSION IF NOT EXISTS pgcrypto;/);
    assert.match(INIT_SQL, /CREATE EXTENSION IF NOT EXISTS vector;/);
    assert.match(INIT_SQL, /CREATE EXTENSION IF NOT EXISTS pg_trgm;/);
    assert.match(INIT_SQL, /CREATE SCHEMA IF NOT EXISTS pentest;/);
  });

  it('27 张表全部建立且落在 pentest schema', () => {
    const expected = [
      'engagements', 'scope_versions', 'assets', 'asset_scope_versions', 'skills',
      'worker_sessions', 'worker_reports', 'session_leases', 'context_events', 'ledger_anchors',
      'llm_calls', 'request_snapshots', 'tool_runs', 'artifacts', 'memory_items', 'findings',
      'memory_chunks', 'embedding_revisions', 'retrieval_queries', 'retrieval_hits',
      'memory_access_log', 'handoffs', 'human_decisions', 'state_transitions', 'approvals',
      'reports', 'outbox_jobs',
    ];
    const declared = declaredTableNames(INIT_SQL);
    assert.deepEqual(declared, expected);
  });

  it('外键总数 60（53 内联 + 7 后置），且不存在前向引用', () => {
    assert.equal((CODE_SQL.match(/REFERENCES pentest\.\w+\s*\(/g) ?? []).length, 60);
    const alterStatements = CODE_STATEMENTS.filter((s) => /^ALTER TABLE/i.test(s));
    const alterRefs = alterStatements.reduce(
      (n, s) => n + (s.match(/REFERENCES pentest\.\w+\s*\(/g) ?? []).length,
      0,
    );
    assert.equal(alterRefs, 7);

    // 逐条推进：被 REFERENCES 引用的表在引用点必须已定义（自引用除外）。
    const defined = new Set<string>();
    const problems: string[] = [];
    for (const statement of CODE_STATEMENTS) {
      const create = /^CREATE TABLE pentest\.(\w+)/i.exec(statement);
      const alter = /^ALTER TABLE pentest\.(\w+)\s+ADD CONSTRAINT/i.exec(statement);
      const owner = create?.[1] ?? alter?.[1];
      if (owner) {
        for (const ref of statement.matchAll(/REFERENCES pentest\.(\w+)\s*\(/g)) {
          const target = ref[1] as string;
          if (target !== owner && !defined.has(target)) {
            problems.push(`${owner} 引用了尚未定义的 ${target}`);
          }
        }
      }
      if (create) defined.add(create[1] as string);
    }
    assert.deepEqual(problems, []);
    assert.equal(defined.size, 27);
  });

  it('worker_reports 的两个自引用外键可延迟（先让位、后插入）', () => {
    const supersedes = findStatement('worker_reports_supersedes_fk');
    const supersededBy = findStatement('worker_reports_superseded_by_fk');
    for (const [constraint, column] of [
      [supersedes, 'supersedes_id'],
      [supersededBy, 'superseded_by'],
    ] as const) {
      assert.match(constraint, new RegExp(`FOREIGN KEY \\(${column}\\) REFERENCES pentest\\.worker_reports\\(id\\)`));
      assert.match(constraint, /DEFERRABLE INITIALLY DEFERRED/);
    }
    // 可延迟声明只出现在这两个外键上（注释里的提法不计）
    assert.equal((CODE_SQL.match(/DEFERRABLE INITIALLY DEFERRED/g) ?? []).length, 2);
  });

  it('会话存活索引与契约 LIVE_SESSION_STATUSES 完全一致，且不含终态', () => {
    const index = findStatement('worker_sessions_one_live_per_engagement');
    const predicate = index.slice(index.indexOf('WHERE status IN'));
    const covered = [...predicate.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
    assert.deepEqual([...covered].sort(), [...LIVE_SESSION_STATUSES].sort());
    for (const terminal of ['closed', 'superseded', 'failed']) {
      assert.ok(!covered.includes(terminal), `终态 ${terminal} 不能出现在存活索引里`);
      assert.ok(SESSION_STATUSES.includes(terminal as never));
    }
  });

  it('关键部分唯一索引的谓词正确', () => {
    assert.match(findStatement('session_leases_one_active'), /WHERE revoked_at IS NULL/);
    assert.match(findStatement('worker_reports_current'), /WHERE superseded_by IS NULL/);
    assert.match(findStatement('approvals_single_consumption'), /WHERE consumed_by_tool_run IS NOT NULL/);
    assert.match(findStatement('embedding_revisions_one_active'), /WHERE is_active/);
    assert.match(findStatement('memory_chunks_event_unique'), /WHERE source_event_id IS NOT NULL/);
    assert.match(findStatement('memory_chunks_item_unique'), /WHERE memory_item_id IS NOT NULL/);
  });

  it('§9.3 的 25 个索引全部存在，含 HNSW 与 GIN', () => {
    const expectedIndexes = [
      'worker_reports_current', 'session_leases_one_active', 'embedding_revisions_one_active',
      'approvals_single_consumption',
      'context_events_engagement_time', 'ledger_anchors_latest', 'worker_sessions_engagement_phase',
      'memory_items_engagement_kind', 'memory_chunks_search_vector', 'memory_chunks_content_trgm',
      'memory_chunks_embedding_hnsw', 'worker_sessions_one_live_per_engagement',
      'worker_reports_session', 'findings_engagement_status', 'artifacts_engagement',
      'scope_versions_engagement', 'skills_enabled', 'memory_chunks_event_unique',
      'memory_chunks_item_unique', 'memory_chunks_asset_ids', 'memory_chunks_finding_ids',
      'assets_engagement_kind', 'asset_scope_versions_lookup', 'session_leases_expiry',
      'outbox_claimable',
    ];
    const declared = declaredIndexNames(INIT_SQL);
    assert.deepEqual([...declared].sort(), [...expectedIndexes].sort());
    assert.equal((INIT_SQL.match(/USING gin/g) ?? []).length, 4);
    assert.equal((INIT_SQL.match(/USING hnsw/g) ?? []).length, 1);
    assert.match(
      findStatement('memory_chunks_embedding_hnsw'),
      /USING hnsw \(embedding vector_cosine_ops\)\s+WHERE embedding IS NOT NULL/,
    );
    assert.match(findStatement('memory_chunks_content_trgm'), /USING gin \(content gin_trgm_ops\)/);
  });

  it('向量维度与嵌入版本 CHECK 已声明', () => {
    assert.match(INIT_SQL, /embedding\s+vector\(1024\)/);
    assert.match(findStatement('provisional OR embedding_revision IS NOT NULL'), /CHECK \(provisional OR embedding_revision IS NOT NULL\)/);
    assert.match(findStatement('memory_item_id IS NOT NULL'), /CHECK \(\(memory_item_id IS NOT NULL\) <> \(source_event_id IS NOT NULL\)\)/);
  });

  it('session_leases.revoked_reason 的取值域与契约 LeaseRevocationReason 逐字一致', () => {
    // 契约里的 LeaseRevocationReason 是类型，运行时没有可枚举的常量，
    // 因此用「SQL 里的取值域」与「运行时判定函数」双向对齐：
    // 逐字列出 5 个取值，且每个都必须被 isLeaseRevocationReason 接受。
    // expired 曾缺失，而 expireLeases（清扫到期未续租约）固定写入它——缺了必然撞 CHECK。
    const statement = findStatement('revoked_reason');
    const region = statement.slice(statement.indexOf('revoked_reason'));
    const reasons = [...region.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
    assert.deepEqual(reasons, ['superseded', 'closed', 'failed', 'human_revoke', 'expired']);
    for (const reason of reasons) {
      assert.ok(isLeaseRevocationReason(reason), `${reason} 必须是运行时认可的吊销理由`);
    }
    // 暂停/预算耗尽不吊销租约（§10.6）：SQL 里不能多出这类取值
    assert.ok(!reasons.includes('budget_exhausted'));
  });

  it('25 个 CHECK 与后置外键名字齐全', () => {
    assert.equal((CODE_SQL.match(/CHECK\s*\(/g) ?? []).length, 25);
    assert.match(
      findStatement('CHECK (batch_to_seq >= batch_from_seq)'),
      /CHECK \(batch_to_seq >= batch_from_seq\)/,
    );
    // 注：worker_sessions_report_fk 已被 004 移除（外键环），不在本清单内
    for (const name of [
      'engagements_active_session_fk', 'tool_runs_approval_fk',
      'assets_discovered_session_fk', 'scope_versions_decision_fk', 'handoffs_decision_fk',
    ]) {
      assert.match(CODE_SQL, new RegExp(`ADD CONSTRAINT ${name}\\b`), `缺少后置外键 ${name}`);
    }
  });

  it('001 不建立 worker_sessions.report_id（避免与 worker_reports.worker_session_id 构成外键环）', () => {
    // 回归用例：该列曾是死指针（无任何写入），却让报告与会话永久不可删除——
    // §11.5 保留的人工删除通道会被环堵死。
    assert.equal(
      /report_id/.test(CODE_SQL),
      false,
      '001 不得再定义 report_id 或指向它的外键',
    );
  });
});

describe('002_security.sql 结构（§9.4 隔离与角色 / §9.5 追加写）', () => {
  const statements = splitSqlStatements(SECURITY_SQL).map(stripLeadingComments);

  it('文件可被语句分割，且每条语句都是可独立解析的关键字开头', () => {
    assert.equal(statements.length, 139);
    for (const code of statements) {
      assert.match(code, /^(CREATE|ALTER|DO|GRANT)\b/i, `可疑语句：${code.slice(0, 60)}`);
    }
    assert.equal(statements.filter((s) => /^CREATE OR REPLACE FUNCTION/.test(s)).length, 8);
    assert.equal(statements.filter((s) => /^CREATE POLICY/.test(s)).length, 53);
    assert.equal(statements.filter((s) => /^CREATE TRIGGER/.test(s)).length, 11);
    assert.equal(statements.filter((s) => /^ALTER TABLE/.test(s)).length, 52);
    assert.equal(statements.filter((s) => /^DO\b/.test(s)).length, 4);
  });

  it('四个角色用 DO 块幂等创建（PG 没有 CREATE ROLE IF NOT EXISTS）', () => {
    const roles = [...SECURITY_SQL.matchAll(/EXECUTE 'CREATE ROLE (\w+)/g)].map((m) => m[1]);
    assert.deepEqual(roles, ['pentest_migrator', 'pentest_app', 'pentest_worker_ro', 'pentest_auditor']);
    assert.ok(
      !/CREATE ROLE\s+IF NOT EXISTS/i.test(SECURITY_CODE),
      'PG 不接受 CREATE ROLE IF NOT EXISTS，必须用 DO 块 + pg_roles 检查',
    );
    assert.match(
      SECURITY_CODE,
      /IF NOT EXISTS \(SELECT 1 FROM pg_roles WHERE rolname = 'pentest_migrator'\)/,
    );
    // superuser / BYPASSRLS 会静默绕过全部策略，必须显式拦下而不是继续迁移
    assert.match(SECURITY_CODE, /rolsuper OR rolbypassrls/);
  });

  it('26 张 engagement 相关表 ENABLE + FORCE RLS，策略按会话变量隔离', () => {
    const enabled = [...SECURITY_SQL.matchAll(/ALTER TABLE pentest\.(\w+)\s+ENABLE ROW LEVEL SECURITY/g)].map((m) => m[1]);
    const forced = [...SECURITY_SQL.matchAll(/ALTER TABLE pentest\.(\w+)\s+FORCE ROW LEVEL SECURITY/g)].map((m) => m[1]);
    assert.equal(enabled.length, 26);
    assert.deepEqual(forced, enabled, '每张启用 RLS 的表都必须同时 FORCE（表所有者也不豁免）');
    for (const table of [
      'engagements', 'scope_versions', 'assets', 'asset_scope_versions', 'worker_sessions',
      'worker_reports', 'session_leases', 'context_events', 'ledger_anchors', 'llm_calls',
      'request_snapshots', 'tool_runs', 'artifacts', 'memory_items', 'findings', 'memory_chunks',
      'embedding_revisions', 'retrieval_queries', 'retrieval_hits', 'memory_access_log',
      'handoffs', 'human_decisions', 'state_transitions', 'approvals', 'reports', 'outbox_jobs',
    ]) {
      assert.ok(enabled.includes(table), `缺少行级安全：${table}`);
    }
    // skills 是跨 engagement 的全局注册表（没有 engagement_id），刻意不启用 RLS
    assert.ok(!enabled.includes('skills'));
    // 隔离依据是会话变量；current_setting(..., true) + NULLIF 保证未设置时不返回任何行
    assert.match(SECURITY_CODE, /current_setting\('pentest\.engagement_id', true\)/);
    assert.match(SECURITY_CODE, /current_setting\('pentest\.worker_session_id', true\)/);
  });

  it('审计账本与运行态表分成两类，触发器集合互不重叠（§9.5）', () => {
    const triggers = [
      ...SECURITY_SQL.matchAll(/CREATE TRIGGER (\w+)\s+BEFORE ([A-Z ]+?) ON pentest\.(\w+)/g),
    ].map((m) => ({ name: m[1] as string, event: (m[2] as string).trim(), table: m[3] as string }));

    // A 类：审计账本只追加——UPDATE OR DELETE 全拒，运行时无改写通道
    const appendOnly = triggers.filter((t) => t.event === 'UPDATE OR DELETE');
    assert.deepEqual(
      appendOnly.map((t) => t.table).sort(),
      ['context_events', 'human_decisions', 'ledger_anchors', 'memory_access_log', 'state_transitions'],
    );
    // B 类：运行态记录允许状态推进——结算时 running → completed/failed/unknown（§15.2/§15.3）
    const progression = triggers.filter((t) => t.event === 'UPDATE');
    assert.deepEqual(
      progression.map((t) => t.table).sort(),
      ['handoffs', 'llm_calls', 'outbox_jobs', 'session_leases', 'tool_runs', 'worker_sessions'],
    );
    // 两类严格互斥：同一个表不能既只追加又允许推进
    const both = appendOnly.filter((t) => progression.some((p) => p.table === t.table));
    assert.deepEqual(both, []);
    assert.equal(appendOnly.length, 5);
    assert.equal(progression.length, 6);

    // 运行态触发器必须显式声明「允许的迁移边」与「终态/已结算集合」，
    // 否则冻结列与终态回退就无从判定（这正是两类表分开处理的原因）
    for (const name of ['llm_calls', 'tool_runs', 'worker_sessions', 'handoffs', 'outbox_jobs']) {
      const trigger = statements.find((s) => s.includes(`CREATE TRIGGER ${name}_state_progression`));
      assert.ok(trigger, `缺少 ${name}_state_progression`);
      const args = [...(trigger as string).matchAll(/'([^']*)'/g)].map((m) => m[1] as string);
      assert.ok(args.length >= 7, `${name} 的触发器参数不足（状态/终态/已结算/迁移边/可变列/一次性列/结算列）`);
      assert.ok(args.some((a) => a.includes('>')), `${name} 未声明任何允许的状态迁移边`);
    }
    // session_leases 没有 status 列，用独立函数按 revoked_at/expires_at 判定
    assert.match(findSecurityStatement('session_leases_settlement'), /enforce_lease_settlement/);
    assert.match(SECURITY_CODE, /revoked_at IS NULL AND NEW\.revoked_reason IS NOT NULL/);
    assert.match(SECURITY_CODE, /NEW\.expires_at < OLD\.expires_at/);
  });

  it('授权按角色收窄：审计账本只追加、无 DELETE、无 DDL', () => {
    // A 类只授 SELECT/INSERT；B 类才需要 UPDATE 来结算
    assert.match(
      SECURITY_CODE,
      /GRANT SELECT, INSERT ON pentest\.context_events, pentest\.ledger_anchors,\s*pentest\.human_decisions, pentest\.state_transitions, pentest\.memory_access_log\s*TO pentest_app/,
    );
    assert.match(SECURITY_CODE, /GRANT SELECT, INSERT, UPDATE ON pentest\.llm_calls, pentest\.tool_runs/);
    // 删除是 §11.5 的人工通道，运行时角色一律不得持有 DELETE
    assert.ok(!/GRANT[^;]*DELETE[^;]*pentest_app/i.test(SECURITY_CODE), 'pentest_app 不得有 DELETE');
    assert.ok(!/GRANT[^;]*DELETE[^;]*pentest_worker_ro/i.test(SECURITY_CODE));
    assert.ok(!/GRANT[^;]*DELETE[^;]*pentest_auditor/i.test(SECURITY_CODE));
    // 运行时角色无 DDL：schema 只授 USAGE，CREATE 只给迁移角色
    assert.match(SECURITY_CODE, /GRANT USAGE ON SCHEMA pentest TO pentest_app, pentest_worker_ro, pentest_auditor/);
    // 所有权归 pentest_migrator（表/序列/函数），运行时角色只是被授权者
    assert.match(SECURITY_CODE, /ALTER TABLE pentest\.%I OWNER TO pentest_migrator/);
    assert.match(SECURITY_CODE, /ALTER FUNCTION %s OWNER TO pentest_migrator/);
    // 审计角色能读思考链，Worker 只读角色不能
    assert.match(SECURITY_CODE, /TO pentest_auditor;/);
  });

  it('未并入 001 的执行路径：安全层只存在于 002', () => {
    assert.ok(!/CREATE ROLE|CREATE POLICY|ROW LEVEL SECURITY|CREATE TRIGGER/.test(CODE_SQL));
    assert.ok(!/ROW LEVEL SECURITY/.test(INIT_SQL));
  });
});

describe('008_gate_hardening.sql 结构（审批写入闸门）', () => {
  const path008 = path.join(HERE, '..', 'src', 'db', 'migrations', '008_gate_hardening.sql');
  const sql008 = readFileSync(path008, 'utf8');

  it('限制审批决策单向推进，并只给执行侧消费列 UPDATE 权限', () => {
    assert.match(sql008, /CREATE OR REPLACE FUNCTION pentest\.enforce_approval_update/);
    assert.match(sql008, /OLD\.decision = 'pending' AND NEW\.decision NOT IN \('approved', 'rejected', 'revoked'\)/);
    assert.match(sql008, /GRANT UPDATE \(consumed_at, consumed_by_tool_run\) ON pentest\.approvals TO pentest_app/);
    assert.match(sql008, /CREATE TRIGGER approvals_update_guard/);
  });

  it('提供受保护的人类审批解析函数', () => {
    assert.match(sql008, /CREATE OR REPLACE FUNCTION pentest\.resolve_approval/);
    assert.match(sql008, /SECURITY DEFINER/);
    assert.match(sql008, /GRANT EXECUTE ON FUNCTION pentest\.resolve_approval/);
  });
});

describe('010_approval_privilege_binding.sql 结构（审批伪造与租户边界）', () => {
  const path010 = path.join(HERE, '..', 'src', 'db', 'migrations', '010_approval_privilege_binding.sql');
  const sql010 = readFileSync(path010, 'utf8');

  it('插入只允许 pending 且不得伪造决策/消费见证', () => {
    assert.match(sql010, /CREATE OR REPLACE FUNCTION pentest\.enforce_approval_insert/);
    assert.match(sql010, /NEW\.decision <> 'pending'/);
    assert.match(sql010, /CREATE TRIGGER approvals_insert_guard/);
  });

  it('resolver 绑定当前 engagement 并拒绝过期 pending', () => {
    assert.match(sql010, /engagement_id = pentest\.current_engagement_id\(\)/);
    assert.match(sql010, /expires_at IS NULL OR expires_at > now\(\)/);
    assert.match(sql010, /SECURITY DEFINER/);
  });
});

describe('017/018 迁移结构（策略版本与审计上下文）', () => {
  const path017 = path.join(HERE, '..', 'src', 'db', 'migrations', '017_policy_profiles.sql');
  const sql017 = readFileSync(path017, 'utf8');
  const path018 = path.join(HERE, '..', 'src', 'db', 'migrations', '018_audit_context.sql');
  const sql018 = readFileSync(path018, 'utf8');

  it('017 为 engagements 补齐范围入口/行为/策略版本与授权见证列', () => {
    // 只截取针对 engagements 的那条 ALTER：同名列还会出现在后面的新表里，全文匹配会误判。
    const alter = sql017.slice(
      sql017.indexOf('ALTER TABLE pentest.engagements'),
      sql017.indexOf('CREATE TABLE IF NOT EXISTS pentest.policy_versions'),
    );
    for (const column of [
      'scope_entry_profile', 'behavior_profile', 'policy_version', 'policy_snapshot_hash',
      'authorization_confirmed_at', 'authorization_confirmed_by',
    ]) {
      assert.match(alter, new RegExp(`ADD COLUMN IF NOT EXISTS ${column}\\b`), `缺少列 ${column}`);
    }
  });

  it('017 建立只追加策略版本表：身份是 (engagement_id, version)，内容哈希不做唯一', () => {
    const table = sql017.slice(sql017.indexOf('CREATE TABLE IF NOT EXISTS pentest.policy_versions'));
    assert.match(table, /UNIQUE \(engagement_id, version\)/);
    // 刻意**没有** UNIQUE(engagement_id, content_hash)：`policy_epoch` 每次变更递增，
    // 「重新确认同一份范围」会产生内容相同、epoch 不同的新版本；把内容哈希当身份
    // 会让这类合法修订撞 23505 并整体回滚（含同一事务里的资产裁决）。
    assert.ok(
      !/UNIQUE \(engagement_id, content_hash\)/.test(table),
      '内容哈希是复核证据，不是身份——它不能有唯一约束',
    );
  });

  it('017 回填来源标为 migration，不冒充人类选择', () => {
    const backfill = sql017.slice(
      sql017.indexOf('INSERT INTO pentest.policy_versions'),
      sql017.indexOf('ON CONFLICT (engagement_id, version) DO NOTHING'),
    );
    assert.match(backfill, /'migration'/);
    // policy.profile.selected 是人类/系统选择事件，回填不得借它伪造历史决策。
    assert.ok(!sql017.includes('policy.profile.selected'));
  });

  it('018 对 policy_versions 先 ENABLE 后 FORCE RLS，并声明读写策略', () => {
    const enable = sql018.indexOf('ALTER TABLE pentest.policy_versions ENABLE ROW LEVEL SECURITY');
    const force = sql018.indexOf('ALTER TABLE pentest.policy_versions FORCE ROW LEVEL SECURITY');
    assert.ok(enable >= 0, '缺少 ENABLE ROW LEVEL SECURITY');
    assert.ok(force > enable, 'FORCE 必须紧随 ENABLE 之后');
    assert.match(sql018, /CREATE POLICY app_engagement ON pentest\.policy_versions/);
    assert.match(sql018, /CREATE POLICY readonly_engagement ON pentest\.policy_versions/);
    // 新表必须继承 015 的租户边界（RESTRICTIVE）：`app_engagement` 只比较 engagement_id，
    // 而那两个 GUC 是可被任意角色设置的会话变量——缺了这条，policy_versions 会成为
    // 同一租户边界里唯一「上下文写错也读得到」的缺口。
    const boundary = sql018.slice(sql018.indexOf('CREATE POLICY tenant_boundary ON pentest.policy_versions'));
    assert.match(boundary, /AS RESTRICTIVE FOR ALL TO pentest_app/);
    assert.match(boundary, /e\.tenant_id = pentest\.current_tenant_id\(\)/);
  });

  it('018 用 BEFORE UPDATE OR DELETE 触发器封住改写通道（§9.5）', () => {
    assert.match(
      sql018,
      /CREATE TRIGGER policy_versions_append_only\s+BEFORE UPDATE OR DELETE ON pentest\.policy_versions/,
    );
  });
});

describe('迁移器纯逻辑', () => {
  it('解析文件名版本号', () => {
    assert.equal(parseMigrationVersion('001_init.sql'), 1);
    assert.equal(parseMigrationVersion('002_add_rls.sql'), 2);
    assert.equal(parseMigrationVersion('0001_x.sql'), 1);
    assert.throws(() => parseMigrationVersion('init.sql'), /迁移文件名不合规/);
  });

  it('loadMigrations 读取到 001_init.sql 且版本升序', async () => {
    const files = await loadMigrations(MIGRATIONS_DIR);
    assert.ok(files.length >= 1);
    assert.equal(files[0]?.fileName, '001_init.sql');
    assert.equal(files[0]?.version, 1);
    for (let i = 1; i < files.length; i += 1) {
      assert.ok((files[i]?.version ?? 0) > (files[i - 1]?.version ?? 0));
    }
  });

  it('幂等：已应用的版本不重复执行', () => {
    assert.deepEqual(planMigrations([1], [1]).pending, []);
    assert.deepEqual(planMigrations([1, 2], [1, 2]).pending, []);
  });

  it('全新库与增量库正确规划', () => {
    assert.deepEqual(planMigrations([], [1]).pending, [1]);
    assert.deepEqual(planMigrations([], [1, 2]).pending, [1, 2]);
    assert.deepEqual(planMigrations([1], [1, 2]).pending, [2]);
    assert.equal(planMigrations([1], [1, 2]).codeVersion, 2);
    assert.equal(planMigrations([1], [1, 2]).databaseVersion, 1);
  });

  it('数据库版本更高时响亮拒绝（§9.1）', () => {
    assert.throws(
      () => planMigrations([1, 2], [1]),
      (err: unknown) => {
        assert.ok(err instanceof SchemaVersionError);
        assert.equal(err.code, 'STORE_UNSUPPORTED_VERSION');
        assert.equal(err.databaseVersion, 2);
        assert.equal(err.codeVersion, 1);
        assert.match(err.message, /拒绝启动/);
        return true;
      },
    );
  });

  it('代码分叉或跳档补写同样拒绝', () => {
    assert.throws(() => planMigrations([1, 3], [1, 2, 3]), SchemaVersionError);
    assert.throws(() => planMigrations([2], [1]), SchemaVersionError);
  });
});

// ───────────────────────── 集成用例（需真实 PostgreSQL） ─────────────────────────

const connectionString = process.env['PENTEST_DATABASE_URL'];
const integration = connectionString ? describe : describe.skip;

integration('集成：真实 PostgreSQL + pgvector', () => {
  it('迁移幂等：连跑两次不重复执行', async () => {
    const expectedFiles = (await loadMigrations(MIGRATIONS_DIR)).map((m) => m.fileName);
    const first = await migrate({ connectionString });
    const second = await migrate({ connectionString });

    // 测试数据库可能已经应用了旧版本；第一次运行应把「本次应用」与「已跳过」合并后
    // 收敛到完整迁移清单，而不是只比较 appliedFiles（增量迁移时它只包含 009）。
    assert.deepEqual(
      [...first.appliedFiles, ...first.skippedFiles].sort(),
      [...expectedFiles].sort(),
    );
    assert.deepEqual(second.appliedFiles, [], '第二次迁移必须是空操作');
    assert.deepEqual(second.skippedFiles, expectedFiles);
    assert.equal(second.databaseVersion, second.codeVersion);

    const client = new pg.Client({ connectionString });
    await client.connect();
    try {
      const rows = await client.query<{ version: string; n: string }>(
        `SELECT version::text AS version, count(*)::text AS n
           FROM pentest.schema_migrations GROUP BY version ORDER BY version::integer`,
      );
      assert.deepEqual(
        rows.rows.map((r) => `${r.version}:1`),
        expectedFiles.map((_, i) => `${i + 1}:1`),
        'schema_migrations 不应出现重复版本行',
      );
    } finally {
      await client.end();
    }
  });

  it('对象计数与设计文档一致', async () => {
    const client = new pg.Client({ connectionString });
    await client.connect();
    try {
      const tables = await client.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = 'pentest' AND c.relkind = 'r'`,
      );
      assert.equal(
        tables.rows[0]?.n,
        String(DECLARED_TABLES + 1),
        '业务表数必须与迁移 DDL 一致（+1 是迁移器自有的 schema_migrations）',
      );

      const fks = await client.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM pg_constraint co JOIN pg_namespace n ON n.oid = co.connamespace
          WHERE n.nspname = 'pentest' AND co.contype = 'f'`,
      );
      assert.equal(
        fks.rows[0]?.n,
        String(DECLARED_FOREIGN_KEYS),
        '外键数必须与迁移 DDL 里声明的 REFERENCES 条数一致',
      );

      const deferrable = await client.query<{ conname: string }>(
        `SELECT co.conname FROM pg_constraint co JOIN pg_namespace n ON n.oid = co.connamespace
          WHERE n.nspname = 'pentest' AND co.contype = 'f' AND co.condeferrable ORDER BY co.conname`,
      );
      // 可延迟外键是**刻意**的一小撮：多一条都要有理由。
      // worker_reports 的两条服务于报告 supersede 的瞬态引用；
      // approvals/tool_runs 的两条服务于「清空作业」——两表互为外键，且两边的行都被
      // 守卫触发器锁死（审批：消费见证不可覆盖；工具运行：终态不可改写），
      // 只能靠事务内 `set constraints all deferred` 在 DELETE 之间解环（023 / 024）。
      assert.deepEqual(
        deferrable.rows.map((r) => r.conname),
        [
          'approvals_consumed_by_tool_run_fkey',
          'tool_runs_approval_fk',
          'worker_reports_superseded_by_fk',
          'worker_reports_supersedes_fk',
        ],
        '可延迟外键集合变了：这是设计决策，不是顺手加的',
      );

      const ams = await client.query<{ amname: string; n: string }>(
        `SELECT a.amname, count(*)::text AS n FROM pg_class c
           JOIN pg_namespace n ON n.oid = c.relnamespace
           JOIN pg_am a ON a.oid = c.relam
          WHERE n.nspname = 'pentest' AND a.amname IN ('hnsw','gin')
          GROUP BY a.amname ORDER BY a.amname`,
      );
      assert.deepEqual(ams.rows, [
        { amname: 'gin', n: '4' },
        { amname: 'hnsw', n: '1' },
      ]);
    } finally {
      await client.end();
    }
  });

  it('数据库版本更高时响亮拒绝（§9.1）', async () => {
    const client = new pg.Client({ connectionString });
    await client.connect();
    try {
      await client.query(
        `INSERT INTO pentest.schema_migrations (version, filename)
         VALUES (999, '999_from_the_future.sql') ON CONFLICT (version) DO NOTHING`,
      );
      await assert.rejects(
        () => migrate({ connectionString }),
        (err: unknown) => {
          assert.ok(err instanceof SchemaVersionError);
          assert.equal(err.code, 'STORE_UNSUPPORTED_VERSION');
          return true;
        },
      );
    } finally {
      await client.query(`DELETE FROM pentest.schema_migrations WHERE version = 999`).catch(() => {});
      await client.end();
    }
  });

  it('隔离与追加写对象在真实库中生效（§9.4/§9.5）', async () => {
    const client = new pg.Client({ connectionString });
    await client.connect();
    try {
      const roles = await client.query<{ rolname: string; rolsuper: boolean; rolbypassrls: boolean }>(
        `SELECT rolname, rolsuper, rolbypassrls FROM pg_roles
          WHERE rolname IN ('pentest_migrator','pentest_app','pentest_worker_ro','pentest_auditor')
          ORDER BY rolname`,
      );
      assert.deepEqual(
        roles.rows.map((r) => r.rolname),
        ['pentest_app', 'pentest_auditor', 'pentest_migrator', 'pentest_worker_ro'],
      );
      for (const role of roles.rows) {
        assert.ok(!role.rolsuper && !role.rolbypassrls, `${role.rolname} 不得是 superuser/BYPASSRLS`);
      }

      // §9.4 的原话是「**所有** engagement 相关表启用 RLS + FORCE」——断言这条**性质**，
      // 而不是一个写死的表数。
      //
      // 此前这里钉的是 `{ n: '26', forced: '26' }`。它有两个毛病：
      //   1. 每加一张带 RLS 的表就要改一次数字（噪音）；
      //   2. **加一张漏了 RLS 的表却不会让它失败**——数字不变，测试照过。
      //      005 建的 `index_watermarks` 正是这样漏掉的（含 engagement_id 却既无 RLS
      //      也无策略），直到 006 才补上。改成性质断言后，这类缺口会被自动抓住。
      //
      // 「engagement 相关」的判据用**列表**而不是表名清单：有 `engagement_id` 列即属于
      // 某个 engagement（`skills` 是全局库、没有该列，因此自动被排除）。
      const rls = await client.query<{ relname: string; rls: boolean; forced: boolean }>(
        `SELECT c.relname, c.relrowsecurity AS rls, c.relforcerowsecurity AS forced
           FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = 'pentest' AND c.relkind = 'r'
            AND EXISTS (
              SELECT 1 FROM pg_attribute a
               WHERE a.attrelid = c.oid AND a.attname = 'engagement_id'
                 AND a.attnum > 0 AND NOT a.attisdropped
            )
          ORDER BY c.relname`,
      );
      // 先确认这条查询本身是有效的：它应当认出至少 20 张表。
      // 少了说明判据写错（例如列名拼错），那时下面的「全部通过」是空真。
      assert.ok(rls.rows.length >= 20, `按 engagement_id 认出 ${String(rls.rows.length)} 张表，判据可能失效`);
      assert.deepEqual(
        rls.rows.filter((row) => !row.rls || !row.forced).map((row) => row.relname),
        [],
        '这些表有 engagement_id 却没有启用并 FORCE RLS（§9.4）',
      );

      // 期望值从迁移文本推导：写死数字会在每次加表/加触发器时要求人回来改，
      // 而「见红灯改数字」正好掩盖真正该被抓到的东西（漏 RLS、漏触发器）。
      //
      // 比对**名字集合**而不是计数：计数相同但某个触发器被漏建、另一个被多建时，
      // 计数断言会全绿。`DROP TRIGGER` 后重建（004、010 的替换写法）在集合视角下
      // 自然收敛，不需要在期望值里手工去重。
      const liveTriggers = await client.query<{ name: string }>(
        `SELECT t.tgname AS name FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
           JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = 'pentest' AND NOT t.tgisinternal ORDER BY t.tgname`,
      );
      const declaredTriggers = [...new Set(
        [...ALL_MIGRATION_SQL.matchAll(/CREATE(?: OR REPLACE)? TRIGGER (\w+)/g)].map((m) => m[1] as string),
      )].sort();
      assert.deepEqual(
        liveTriggers.rows.map((r) => r.name),
        declaredTriggers,
        '库里的触发器集合必须与迁移声明的完全一致（不多不少）',
      );
      // 分类计数仍然锁住两种「事件形态」各自覆盖哪些表——这是分类本身的契约。
      const triggers = await client.query<{ kind: string; n: string }>(
        `SELECT CASE
                  WHEN t.tgname LIKE '%_append_only' THEN 'append_only'
                  WHEN t.tgname LIKE '%_state_progression' THEN 'progression'
                  ELSE 'other'
                END AS kind,
                count(*)::text AS n
           FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
           JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = 'pentest' AND NOT t.tgisinternal
          GROUP BY 1 ORDER BY 1`,
      );
      assert.deepEqual(triggers.rows, [
        { kind: 'append_only', n: String(declaredTriggers.filter((n) => n.endsWith('_append_only')).length) },
        {
          kind: 'other',
          n: String(declaredTriggers.filter((n) => !n.endsWith('_append_only') && !n.endsWith('_state_progression')).length),
        },
        { kind: 'progression', n: String(declaredTriggers.filter((n) => n.endsWith('_state_progression')).length) },
      ]);

      // 授权边界：审计账本无 UPDATE、运行态可 UPDATE、任何运行时角色都无 DELETE
      const grants = await client.query<Record<string, boolean>>(
        `SELECT has_table_privilege('pentest_app','pentest.context_events','UPDATE') AS app_upd_events,
                has_table_privilege('pentest_app','pentest.context_events','INSERT') AS app_ins_events,
                has_table_privilege('pentest_app','pentest.llm_calls','UPDATE') AS app_upd_llm,
                has_table_privilege('pentest_app','pentest.memory_items','DELETE') AS app_del_memory,
                has_schema_privilege('pentest_app','pentest','CREATE') AS app_create,
                has_table_privilege('pentest_worker_ro','pentest.llm_calls','SELECT') AS ro_llm_read,
                has_column_privilege('pentest_auditor','pentest.llm_calls','reasoning_zstd','SELECT') AS aud_reasoning`,
      );
      assert.deepEqual(grants.rows[0], {
        app_upd_events: false,
        app_ins_events: true,
        app_upd_llm: true,
        app_del_memory: false,
        app_create: false,
        ro_llm_read: false,
        aud_reasoning: true,
      });
      assert.equal(
        grants.rows[0] !== undefined && await client.query(
          `SELECT has_column_privilege('pentest_app','pentest.approvals','decision','UPDATE') AS app_upd_approval_decision,
                  has_column_privilege('pentest_app','pentest.approvals','consumed_at','UPDATE') AS app_upd_approval_consumed,
                  has_function_privilege('pentest_app','pentest.resolve_approval(uuid,text,text,text)','EXECUTE') AS app_exec_resolver`,
        ).then((r) => r.rows[0]?.app_upd_approval_decision === false && r.rows[0]?.app_upd_approval_consumed === true && r.rows[0]?.app_exec_resolver === true),
        true,
        '审批决策列只能由 resolver 写入，运行时只能消费并可调用受控 resolver',
      );

      const owners = await client.query<{ n: string }>(
        // 排除迁移器自有的元数据表：它是部署期工具的表，不属于 engagement 数据，
        // 由执行迁移的角色（而非 pentest_migrator）持有是正常的。
        `SELECT count(*)::text AS n FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = 'pentest' AND c.relkind IN ('r','S')
            AND c.relname <> 'schema_migrations'
            AND c.relname <> 'schema_migrations_pkey'
            AND pg_get_userbyid(c.relowner) <> 'pentest_migrator'`,
      );
      assert.equal(owners.rows[0]?.n, '0', '全部业务表与序列必须归 pentest_migrator');
    } finally {
      await client.end();
    }
  });

  it('RLS 按 engagement 隔离，且未设上下文时看不见任何行（§9.4）', async () => {
    const client = new pg.Client({ connectionString });
    await client.connect();
    const e1 = randomUUID();
    const e2 = randomUUID();
    try {
      for (const [id, name] of [[e1, 'rls-e1'], [e2, 'rls-e2']] as const) {
        await client.query(
          `INSERT INTO pentest.engagements (id, tenant_id, name, status, current_status,
             target_snapshot, scope_snapshot, roe_snapshot, policy_snapshot, config_snapshot, created_by)
           VALUES ($1,'rls-test',$2,'running','ready','{}','{}','{}','{}','{}','test')`,
          [id, name],
        );
        await client.query(
          `INSERT INTO pentest.memory_items (engagement_id, kind, content, trust_level, status, created_by)
           VALUES ($1,'observation',$2,'untrusted','active','test')`,
          [id, name],
        );
      }

      // 以运行时角色跑：只有显式设置上下文后才有可见行，且只看本 engagement
      await client.query('SET ROLE pentest_app');
      await client.query('BEGIN');
      await client.query(`SELECT pentest.set_rls_context('rls-test', $1, NULL)`, [e1]);
      const visible = await client.query<{ content: string }>(
        `SELECT content FROM pentest.memory_items ORDER BY content`,
      );
      assert.deepEqual(visible.rows.map((r) => r.content), ['rls-e1']);

      // 跨 engagement 的 UPDATE 被 USING 过滤影响 0 行：不报错，也不改错行
      const crossed = await client.query(
        `UPDATE pentest.memory_items SET content = 'hacked' WHERE engagement_id = $1`,
        [e2],
      );
      assert.equal(crossed.rowCount, 0);

      // 跨 engagement 的 INSERT 被 WITH CHECK 响亮拒绝（必须是最后一条，事务将因此中止）
      await assert.rejects(
        () =>
          client.query(
            `INSERT INTO pentest.memory_items (engagement_id, kind, content, trust_level, status, created_by)
             VALUES ($1,'observation','cross','untrusted','active','test')`,
            [e2],
          ),
        /row-level security/,
      );
      await client.query('ROLLBACK');

      // 事务结束后上下文失效：未设上下文必须 fail-closed
      const none = await client.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM pentest.memory_items WHERE engagement_id IN ($1, $2)`,
        [e1, e2],
      );
      assert.equal(none.rows[0]?.n, 0, '未设 pentest.engagement_id 时必须看不见任何行');
    } finally {
      await client.query('RESET ROLE').catch(() => {});
      await client
        .query(`DELETE FROM pentest.memory_items WHERE engagement_id IN ($1, $2)`, [e1, e2])
        .catch(() => {});
      await client.query(`DELETE FROM pentest.engagements WHERE id IN ($1, $2)`, [e1, e2]).catch(() => {});
      await client.end();
    }
  });
});

integration('集成：审批权限与 resolver 边界', () => {
  async function queryAsApp(client: pg.Client, sql: string, params?: readonly unknown[]) {
    await client.query('SET ROLE pentest_app');
    try {
      return await client.query(sql, params as unknown[] | undefined);
    } finally {
      await client.query('RESET ROLE');
    }
  }

  it('pentest_app 只能创建 pending，resolver 必须绑定 engagement 且拒绝过期审批', async () => {
    const client = new pg.Client({ connectionString });
    await client.connect();
    const engagementA = randomUUID();
    const engagementB = randomUUID();
    const workerA = randomUUID();
    const workerB = randomUUID();
    const pendingId = randomUUID();
    const forgedId = randomUUID();
    const crossId = randomUUID();
    const expiredId = randomUUID();
    try {
      for (const [id, name] of [[engagementA, 'approval-a'], [engagementB, 'approval-b']] as const) {
        await client.query(
          `INSERT INTO pentest.engagements (id, tenant_id, name, status, current_status,
             target_snapshot, scope_snapshot, roe_snapshot, policy_snapshot, config_snapshot, created_by)
           VALUES ($1, 'approval-test', $2, 'running', 'ready', '{}'::jsonb, '{}'::jsonb,
             '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, 'test')`,
          [id, name],
        );
      }
      for (const [id, engagement, name] of [[workerA, engagementA, 'approval-worker-a'], [workerB, engagementB, 'approval-worker-b']] as const) {
        await client.query(
          `INSERT INTO pentest.worker_sessions
             (id, engagement_id, dsh_session_id, phase, profile_id, profile_revision, attempt,
              iteration, scope_version, task_prompt, tool_filter, skill_ids, model_route, status)
           VALUES ($1, $2, $3, 'intelligence-gathering', 'p', 'r1', 1, 1, 1, 'tp',
              '{}'::jsonb, '[]'::jsonb, '{}'::jsonb, 'active')`,
          [id, engagement, `dsh-${id}`],
        );
      }
      const approval = (id: string, engagement: string, worker: string, expires: Date | null) => [
        id, engagement, worker, expires,
      ];
      const insertPending = async (row: readonly unknown[]) => {
        await client.query(
          `INSERT INTO pentest.approvals
             (id, engagement_id, requested_by_worker, action_class, target_snapshot, command_plan,
              plan_hash, risk_summary, decision, lease_generation, expires_at)
           VALUES ($1::uuid, $2::uuid, $3::uuid, 'exploit_validation', '{}'::jsonb, '{}'::jsonb,
              'plan', 'risk', 'pending', 1, $4)`,
          [...row],
        );
      };
      await queryAsApp(client, `SELECT pentest.set_rls_context('approval-test', $1, NULL)`, [engagementA]);
      await insertPending(approval(pendingId, engagementA, workerA, new Date(Date.now() + 900_000)));
      await assert.rejects(
        () => queryAsApp(
          client,
          `INSERT INTO pentest.approvals
             (id, engagement_id, requested_by_worker, action_class, target_snapshot, command_plan,
              plan_hash, risk_summary, decision, lease_generation)
           VALUES ($1::uuid, $2::uuid, $3::uuid, 'exploit_validation', '{}'::jsonb, '{}'::jsonb,
              'forged', 'risk', 'approved', 1)`,
          [forgedId, engagementA, workerA],
        ),
        /审批只能以 pending/u,
      );
      await assert.rejects(
        () => queryAsApp(client, 'SELECT pentest.resolve_approval($1::uuid, $2, $3, $4)', [pendingId, 'approved', 'op', 'ok']),
        /审批不存在/u,
        '没有事务级 engagement context 时 app resolver 必须 fail closed',
      );
      await client.query('BEGIN');
      await client.query('SET ROLE pentest_app');
      await client.query('SELECT pentest.set_rls_context($1, $2::uuid, NULL)', ['approval-test', engagementA]);
      await client.query('SELECT pentest.resolve_approval($1::uuid, $2, $3, $4)', [pendingId, 'approved', 'op', 'ok']);
      await client.query('ROLLBACK');

      await insertPending(approval(crossId, engagementB, workerB, new Date(Date.now() + 900_000)));
      await client.query('BEGIN');
      await client.query('SET ROLE pentest_app');
      await client.query('SELECT pentest.set_rls_context($1, $2::uuid, NULL)', ['approval-test', engagementA]);
      await assert.rejects(
        () => client.query('SELECT pentest.resolve_approval($1::uuid, $2, $3, $4)', [crossId, 'approved', 'op', 'cross']),
        /row-level security|审批不存在/u,
      );
      await client.query('ROLLBACK');

      await insertPending(approval(expiredId, engagementA, workerA, new Date(Date.now() - 1_000)));
      await client.query('BEGIN');
      await client.query('SET ROLE pentest_app');
      await client.query('SELECT pentest.set_rls_context($1, $2::uuid, NULL)', ['approval-test', engagementA]);
      await assert.rejects(
        () => client.query('SELECT pentest.resolve_approval($1::uuid, $2, $3, $4)', [expiredId, 'approved', 'op', 'expired']),
        /审批不存在|row-level security/u,
      );
      await client.query('ROLLBACK');
    } finally {
      await client.query('RESET ROLE').catch(() => undefined);
      await client.query('ROLLBACK').catch(() => undefined);
      await client.query('SET session_replication_role = replica').catch(() => undefined);
      for (const table of ['approvals', 'worker_sessions', 'engagements']) {
        await client.query(`DELETE FROM pentest.${table} WHERE id = ANY($1::uuid[])`, [[pendingId, forgedId, crossId, expiredId, workerA, workerB, engagementA, engagementB]]).catch(() => undefined);
      }
      await client.query('SET session_replication_role = origin').catch(() => undefined);
      await client.end();
    }
  });
});
