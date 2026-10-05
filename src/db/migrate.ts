/**
 * 极简迁移器（设计文档 §9.1）。
 *
 * 规则：
 *   - 表结构版本单调递增，逐级向前迁移；按迁移文件名顺序执行 migrations/*.sql。
 *   - 幂等：已记录在 pentest.schema_migrations 的版本不重复执行。
 *   - 版本检查：数据库里的版本高于代码拥有的版本（或出现本地不存在的版本、
 *     或存在低于已执行最高版本的缺口）时**响亮拒绝**并抛错，绝不静默降级。
 *     错误码沿用 dsh-memento 的语义：STORE_UNSUPPORTED_VERSION。
 *     （该码存在于 §9.1，不属于 contracts.ts 的工具错误码 ERROR_CODES——
 *      迁移器是部署期工具，不是返回给模型的工具结果。）
 *
 * 连接串从环境变量 PENTEST_DATABASE_URL 读取。
 */

import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import pg from 'pg';

/** 迁移文件所在目录（本文件同级 migrations/）。 */
export const MIGRATIONS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'migrations');

/** 迁移记录表：迁移器自身拥有，不属于任何一版 DDL。 */
export const MIGRATIONS_TABLE = 'pentest.schema_migrations';

const CREATE_MIGRATIONS_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS ${MIGRATIONS_TABLE} (
    version    integer PRIMARY KEY,
    filename   text NOT NULL,
    applied_at timestamptz NOT NULL DEFAULT now()
)`;

/** 确保迁移记录表存在（迁移器与验收脚本共用同一处 DDL）。 */
export async function ensureMigrationsTable(client: pg.Client): Promise<void> {
  await client.query('CREATE SCHEMA IF NOT EXISTS pentest');
  await client.query(CREATE_MIGRATIONS_TABLE_SQL);
}

/** 记录一条已应用的迁移；重复记录时保持原样（幂等）。 */
export async function recordAppliedMigration(
  client: pg.Client,
  version: number,
  fileName: string,
): Promise<void> {
  await client.query(
    `INSERT INTO ${MIGRATIONS_TABLE} (version, filename) VALUES ($1, $2) ON CONFLICT (version) DO NOTHING`,
    [version, fileName],
  );
}

/** 表结构版本冲突：数据库比代码新（或与代码分叉）。必须响亮拒绝。 */
export class SchemaVersionError extends Error {
  readonly code = 'STORE_UNSUPPORTED_VERSION';
  readonly databaseVersion: number;
  readonly codeVersion: number;

  constructor(message: string, databaseVersion: number, codeVersion: number) {
    super(`${message}（数据库表结构版本 ${databaseVersion}，代码支持到 ${codeVersion}）`);
    this.name = 'SchemaVersionError';
    this.databaseVersion = databaseVersion;
    this.codeVersion = codeVersion;
  }
}

export interface MigrationFile {
  /** 文件名前缀解析出的单调版本号，例如 001_init.sql → 1。 */
  readonly version: number;
  readonly fileName: string;
  /** 文件绝对路径。 */
  readonly filePath: string;
  readonly sql: string;
}

export interface MigrationPlan {
  /** 需要按顺序执行的版本。 */
  readonly pending: readonly number[];
  /** 已执行且与代码一致的版本。 */
  readonly applied: readonly number[];
  readonly codeVersion: number;
  readonly databaseVersion: number;
}

export interface MigrateOptions {
  readonly connectionString?: string;
  readonly migrationsDir?: string;
  readonly log?: (message: string) => void;
}

export interface MigrateResult {
  readonly appliedFiles: readonly string[];
  readonly skippedFiles: readonly string[];
  readonly databaseVersion: number;
  readonly codeVersion: number;
}

/**
 * 把迁移文件切成可独立执行的语句。
 * 追踪单引号、双引号、行注释、块注释（支持嵌套）与 dollar-quote，
 * 因此字符串与注释里的分号不会被误切。
 */
export function splitSqlStatements(sql: string): string[] {
  const statements: string[] = [];
  let buf = '';
  let state: 'plain' | 'single' | 'double' | 'line' | 'block' | 'dollar' = 'plain';
  let blockDepth = 0;
  let dollarTag = '';

  for (let i = 0; i < sql.length; i += 1) {
    const ch = sql[i] as string;
    const next = sql[i + 1];

    if (state === 'plain') {
      if (ch === "'") {
        state = 'single';
      } else if (ch === '"') {
        state = 'double';
      } else if (ch === '-' && next === '-') {
        state = 'line';
      } else if (ch === '/' && next === '*') {
        state = 'block';
        blockDepth = 1;
      } else if (ch === '$') {
        const m = /^\$[A-Za-z_][A-Za-z0-9_]*\$|^\$\$/.exec(sql.slice(i));
        if (m) {
          state = 'dollar';
          dollarTag = m[0];
          buf += dollarTag;
          i += dollarTag.length - 1;
          continue;
        }
      } else if (ch === ';') {
        const stmt = buf.trim();
        if (stmt) statements.push(stmt);
        buf = '';
        continue;
      }
      buf += ch;
      continue;
    }

    if (state === 'single') {
      buf += ch;
      if (ch === "'") {
        if (next === "'") {
          buf += next as string;
          i += 1;
          continue;
        }
        state = 'plain';
      }
      continue;
    }

    if (state === 'double') {
      buf += ch;
      if (ch === '"') state = 'plain';
      continue;
    }

    if (state === 'line') {
      buf += ch;
      if (ch === '\n') state = 'plain';
      continue;
    }

    if (state === 'block') {
      if (ch === '*' && next === '/') {
        buf += '*/';
        i += 1;
        blockDepth -= 1;
        if (blockDepth === 0) state = 'plain';
        continue;
      }
      if (ch === '/' && next === '*') {
        buf += '/*';
        i += 1;
        blockDepth += 1;
        continue;
      }
      buf += ch;
      continue;
    }

    // dollar-quoted 文本
    if (sql.startsWith(dollarTag, i)) {
      buf += dollarTag;
      i += dollarTag.length - 1;
      state = 'plain';
      continue;
    }
    buf += ch;
  }

  const tail = buf.trim();
  if (tail) statements.push(tail);
  return statements;
}

/**
 * 迁移器自身包住每个版本的事务；旧迁移文件可能仍带有 BEGIN/COMMIT 包裹，
 * 不能让它们提交外层事务，否则 dry-run 回滚会留下半套 schema。
 */
function stripLeadingSqlComments(statement: string): string {
  return statement.replace(/^(?:\s*(?:--[^\n]*(?:\n|$)|\/\*[\s\S]*?\*\/))*\s*/, '');
}

export function splitMigrationStatements(sql: string): string[] {
  return splitSqlStatements(sql).filter((statement) => {
    const code = stripLeadingSqlComments(statement);
    return !/^(?:BEGIN|COMMIT|ROLLBACK)\s*$/i.test(code);
  });
}

/**
 * 从迁移文本中提取 DDL 显式声明的对象名（验收脚本与测试共用，避免第二套解析）。
 *
 * 必须容忍 `IF NOT EXISTS` 与 `pentest.` 限定前缀：`scripts/verify-schema.ts`
 * 曾用 `/CREATE (?:UNIQUE )?INDEX (\w+)/` 提取索引名，而 017/018 的
 * `CREATE INDEX IF NOT EXISTS ...` 会被捕获成名字 `IF`——脚本因此在**任何迁移
 * 正确的库**上都报「缺少索引：IF」并 exit 1；而它不在测试覆盖里，所以一直没暴露。
 */

/** 提取 `CREATE TABLE [IF NOT EXISTS] pentest.<name>` 的表名（去重、保持出现顺序）。 */
export function declaredTableNames(sql: string): string[] {
  const names = new Set<string>();
  for (const m of sql.matchAll(/CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?pentest\s*\.\s*(\w+)/gi)) {
    names.add(m[1] as string);
  }
  return [...names];
}

/** 提取 `CREATE [UNIQUE] INDEX [IF NOT EXISTS] [pentest.]<name>` 的索引名（去重、保持出现顺序）。 */
export function declaredIndexNames(sql: string): string[] {
  const names = new Set<string>();
  for (const m of sql.matchAll(/CREATE\s+(?:UNIQUE\s+)?INDEX\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:pentest\s*\.\s*)?(\w+)/gi)) {
    names.add(m[1] as string);
  }
  return [...names];
}

/** 从 `001_init.sql` 解析版本号 1。文件名必须以数字前缀开头。 */
export function parseMigrationVersion(fileName: string): number {
  const m = /^(\d+)_[A-Za-z0-9_.-]+\.sql$/.exec(fileName);
  if (!m) {
    throw new Error(`迁移文件名不合规（应为 <数字前缀>_<名称>.sql）：${fileName}`);
  }
  return Number.parseInt(m[1] as string, 10);
}

/** 读取目录下全部迁移，按版本升序排列。 */
export async function loadMigrations(dir: string = MIGRATIONS_DIR): Promise<MigrationFile[]> {
  const names = (await readdir(dir)).filter((n) => n.endsWith('.sql'));
  const files: MigrationFile[] = [];
  for (const fileName of names) {
    const filePath = path.join(dir, fileName);
    files.push({
      version: parseMigrationVersion(fileName),
      fileName,
      filePath,
      sql: await readFile(filePath, 'utf8'),
    });
  }
  files.sort((a, b) => a.version - b.version);
  const versions = new Set<number>();
  for (const f of files) {
    if (versions.has(f.version)) throw new Error(`迁移版本重复：${f.version}（${f.fileName}）`);
    versions.add(f.version);
  }
  return files;
}

/**
 * 纯函数版本规划：决定要执行哪些迁移，或响亮拒绝。
 * - 数据库存在代码里没有的版本 → 拒绝（含「数据库更新」与「代码分叉」两种情形）。
 * - 数据库最高版本高于代码最高版本 → 拒绝（§9.1 的核心条款）。
 * - 存在低于已执行最高版本的未执行版本（缺口）→ 拒绝：逐级向前迁移不允许跳档补写。
 */
export function planMigrations(
  appliedVersions: readonly number[],
  availableVersions: readonly number[],
): MigrationPlan {
  const applied = [...new Set(appliedVersions)].sort((a, b) => a - b);
  const available = [...new Set(availableVersions)].sort((a, b) => a - b);
  const codeVersion = available.length ? (available[available.length - 1] as number) : 0;
  const databaseVersion = applied.length ? (applied[applied.length - 1] as number) : 0;

  for (const v of applied) {
    if (!available.includes(v)) {
      throw new SchemaVersionError(
        `数据库已应用迁移 ${v}，但当前代码没有这个版本；拒绝启动以免静默读错结构`,
        Math.max(databaseVersion, v),
        codeVersion,
      );
    }
  }
  if (databaseVersion > codeVersion) {
    throw new SchemaVersionError('数据库表结构版本高于当前代码版本，拒绝启动', databaseVersion, codeVersion);
  }

  const pending = available.filter((v) => !applied.includes(v));
  for (const v of pending) {
    if (v < databaseVersion) {
      throw new SchemaVersionError(
        `数据库已应用迁移 ${databaseVersion}，却缺少更早的迁移 ${v}；逐级向前迁移不允许跳档补写`,
        databaseVersion,
        codeVersion,
      );
    }
  }

  return { pending, applied, codeVersion, databaseVersion };
}

async function readAppliedVersions(client: pg.Client): Promise<number[]> {
  const res = await client.query<{ version: number | string }>(
    `SELECT version FROM ${MIGRATIONS_TABLE} ORDER BY version`,
  );
  return res.rows.map((r) => Number(r.version));
}

/** 连接数据库并迁移到代码拥有的最高版本。幂等：已应用的版本不重复执行。 */
export async function migrate(options: MigrateOptions = {}): Promise<MigrateResult> {
  const connectionString = options.connectionString ?? process.env['PENTEST_DATABASE_URL'];
  if (!connectionString) {
    throw new Error('缺少数据库连接串：请设置环境变量 PENTEST_DATABASE_URL');
  }
  const log = options.log ?? (() => {});
  const migrations = await loadMigrations(options.migrationsDir);
  const client = new pg.Client({ connectionString });
  await client.connect();
  try {
    await ensureMigrationsTable(client);
    const applied = await readAppliedVersions(client);
    const plan = planMigrations(applied, migrations.map((m) => m.version));
    if (plan.pending.length === 0) {
      log(`已是最新表结构版本 ${plan.codeVersion}，无需迁移`);
    }
    const appliedFiles: string[] = [];
    for (const version of plan.pending) {
      const file = migrations.find((m) => m.version === version);
      if (!file) throw new Error(`内部错误：找不到版本 ${version} 的迁移文件`);
      log(`应用迁移 ${file.fileName}`);
      const statements = splitMigrationStatements(file.sql);
      await client.query('BEGIN');
      try {
        for (let i = 0; i < statements.length; i += 1) {
          try {
            await client.query(statements[i] as string);
          } catch (err) {
            const detail = err instanceof Error ? err.message : String(err);
            throw new Error(`${file.fileName} 第 ${i + 1}/${statements.length} 条语句失败：${detail}`, { cause: err });
          }
        }
        await recordAppliedMigration(client, version, file.fileName);
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        throw err;
      }
      appliedFiles.push(file.fileName);
    }

    return {
      appliedFiles,
      skippedFiles: migrations.filter((m) => plan.applied.includes(m.version)).map((m) => m.fileName),
      databaseVersion: plan.databaseVersion,
      codeVersion: plan.codeVersion,
    };
  } finally {
    await client.end();
  }
}

const isDirectRun =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isDirectRun) {
  try {
    const result = await migrate({ log: (m) => console.log(m) });
    console.log(
      `迁移完成：本次应用 ${result.appliedFiles.length} 个，跳过 ${result.skippedFiles.length} 个，` +
        `当前表结构版本 ${result.codeVersion}`,
    );
  } catch (err) {
    if (err instanceof SchemaVersionError) {
      console.error(`[${err.code}] ${err.message}`);
    } else {
      console.error(`迁移失败：${err instanceof Error ? err.message : String(err)}`);
    }
    process.exitCode = 1;
  }
}
