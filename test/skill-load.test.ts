/**
 * `PgWorkerTools.loadSkill` 的「装载即冻结」回归测试（真实 PostgreSQL）。
 *
 * 锁定的是这条安全不变量：
 *
 *   **skill 正文会被模型当指令执行，因此只有会话创建时冻结在 `worker_sessions.skill_ids`
 *   里的 skill 才能拿到正文。** 「库里存在」不等于「本会话拿得到」。
 *
 * 实现的两步顺序不能反：先读冻结集合、命中才查库。若有人把它改成「先查库再比对集合」，
 * 查询出错或未来挪走集合判断都会静默放行——那时下面这两条必须红：
 *
 *   1. 库里有、但本会话没装载 → `skill === null`，且 `loadedNames` 只反映冻结集合；
 *   2. 已装载、但库里 `disabled = true` → 仍然 `skill === null`（停用即时生效）。
 *
 * 夹具自造自清；用 `new PgWorkerTools(db, {} as never)`，即未配置 RLS 上下文的部署形态。
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';

import { PgWorkerTools } from '../src/memory/pg-worker-tools.ts';
import { skillContentHash } from '../src/skills/pg-skill.ts';
import type { DbClient } from '../src/memory/ledger.ts';
import { cleanupEngagements } from './helpers/cleanup.ts';

const DATABASE_URL = process.env.PENTEST_DATABASE_URL;

/** 正例与「库里有但未装载」反例都要用固定的 skill 名，与实现按名字匹配的语义对齐。 */
const LOADED_SKILL = 'exploit-safety';
const UNLOADED_SKILL = 'recon-network-surface';

describe('loadSkill 装载冻结（真实 PostgreSQL）', { skip: DATABASE_URL === undefined ? '未设置 PENTEST_DATABASE_URL' : false }, () => {
  let pool: Pool;
  let tools: PgWorkerTools;

  /** skills 是全局库（无 engagement_id），按 id 直删。 */
  const madeSkills: string[] = [];
  const madeEngagements: string[] = [];

  const db = (): DbClient => ({
    async query<Row = Record<string, unknown>>(sql: string, params?: readonly unknown[]) {
      const r = await pool.query(sql, params as unknown[] | undefined);
      return { rows: r.rows as Row[], rowCount: r.rowCount };
    },
  });

  before(() => {
    pool = new Pool({ connectionString: DATABASE_URL, max: 4 });
    // 未配置 RLS 上下文：与迁移连接/无 RLS 部署同形态。
    tools = new PgWorkerTools(db(), {} as never);
  });

  after(async () => {
    if (pool === undefined) return;
    if (madeSkills.length > 0) {
      await pool.query('delete from pentest.skills where id = any($1::uuid[])', [madeSkills]);
    }
    await cleanupEngagements(pool, madeEngagements);
    await pool.end();
  });

  /** 保证库里有这个 skill 行；返回其 id。只有本次插入的行才登记进清理清单。 */
  async function ensureSkill(input: {
    readonly name: string;
    readonly body: string;
    readonly disabled?: boolean;
  }): Promise<string> {
    const existing = await pool.query('select id from pentest.skills where name = $1', [input.name]);
    if (existing.rowCount !== null && existing.rowCount > 0) {
      return String(existing.rows[0].id);
    }
    const id = randomUUID();
    const description = `回归夹具：${input.name}`;
    const revision = 1;
    await pool.query(
      `insert into pentest.skills (id, name, description, body, content_hash, added_by, revision, disabled)
       values ($1::uuid, $2, $3, $4, $5, 'skill-load-test', $6, $7)`,
      [
        id,
        input.name,
        description,
        input.body,
        skillContentHash({ name: input.name, description, body: input.body, revision }),
        revision,
        input.disabled ?? false,
      ],
    );
    madeSkills.push(id);
    return id;
  }

  async function newEngagement(): Promise<string> {
    const engagementId = randomUUID();
    madeEngagements.push(engagementId);
    await pool.query(
      `insert into pentest.engagements
         (id, tenant_id, name, status, current_status, target_snapshot, scope_snapshot, roe_snapshot, policy_snapshot, config_snapshot, created_by)
       values ($1::uuid, 't', 'skill-load-test', 'running', 'worker_running', '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, 'tester')`,
      [engagementId],
    );
    return engagementId;
  }

  async function newWorkerSession(
    engagementId: string,
    skillIds: readonly string[],
    freeze?: readonly { name: string; revision: number | null; contentHash: string | null }[] | null,
  ): Promise<string> {
    const id = randomUUID();
    // 省略 freeze：按当前 skills 行计算三元组（与生产 `insertWorkerSession` 同一语义）；
    // 显式传 null：写成空数组，模拟 026 之前的旧会话。
    let stored = freeze;
    if (stored === undefined) {
      const rows = skillIds.length === 0
        ? { rows: [] as { name: string; revision: number; content_hash: string }[] }
        : await pool.query<{ name: string; revision: number; content_hash: string }>(
            'select name, revision, content_hash from pentest.skills where name = any($1::text[])',
            [skillIds],
          );
      const byName = new Map(rows.rows.map((row) => [row.name, row]));
      stored = skillIds.map((name) => {
        const row = byName.get(name);
        return row === undefined
          ? { name, revision: null, contentHash: null }
          : { name, revision: row.revision, contentHash: row.content_hash };
      });
    }
    await pool.query(
      `insert into pentest.worker_sessions
         (id, engagement_id, dsh_session_id, phase, profile_id, profile_revision,
          task_prompt, tool_filter, skill_ids, skill_freeze, model_route, status)
       values ($1::uuid, $2::uuid, $3, 'intelligence-gathering', 'p', 'r1',
          'tp', '{}'::jsonb, $4::jsonb, $5::jsonb, '{}'::jsonb, 'active')`,
      [id, engagementId, `dsh-skill-load-${id}`, JSON.stringify(skillIds), JSON.stringify(stored ?? [])],
    );
    return id;
  }

  test('正例：已装载的 skill 返回正文，body/contentHash/revision 与库一致', async () => {
    const body = '正文：装载冻结正例。先做 A，再做 B。';
    await ensureSkill({ name: LOADED_SKILL, body });
    const engagementId = await newEngagement();
    const workerSessionId = await newWorkerSession(engagementId, [LOADED_SKILL]);

    const result = await tools.loadSkill({ workerSessionId, skillName: LOADED_SKILL });

    assert.notEqual(result.skill, null, '已装载且启用：必须返回正文');
    assert.equal(result.skill?.name, LOADED_SKILL);

    // 透传正确性：与库里的同一行逐字段比对，而不是与夹具常量比对。
    const row = await pool.query(
      'select description, body, content_hash, revision from pentest.skills where name = $1',
      [LOADED_SKILL],
    );
    assert.equal(row.rowCount, 1);
    assert.equal(result.skill?.body, row.rows[0].body, 'body 必须与库里一致');
    assert.equal(result.skill?.description, row.rows[0].description);
    assert.equal(result.skill?.contentHash, row.rows[0].content_hash, 'contentHash 必须透传库值');
    assert.equal(result.skill?.revision, row.rows[0].revision, 'revision 必须透传库值');
    assert.deepEqual(result.loadedNames, [LOADED_SKILL], 'loadedNames 反映冻结集合');
  });

  test('反例（安全不变量）：库里有但本会话未装载 → null，且不泄漏未装载项', async () => {
    await ensureSkill({ name: LOADED_SKILL, body: '已装载。' });
    await ensureSkill({ name: UNLOADED_SKILL, body: '库里存在，但本会话没装载。' });
    const engagementId = await newEngagement();
    // 冻结集合里**只有** LOADED_SKILL。
    const workerSessionId = await newWorkerSession(engagementId, [LOADED_SKILL]);

    // 先证明确实「库里有」：这个断言把反例钉在「未装载」而不是「不存在」上。
    const present = await pool.query('select 1 from pentest.skills where name = $1 and disabled = false', [
      UNLOADED_SKILL,
    ]);
    assert.equal(present.rowCount, 1, '前置条件：目标 skill 确实存在于库中且启用');

    const result = await tools.loadSkill({ workerSessionId, skillName: UNLOADED_SKILL });
    assert.equal(result.skill, null, '库里有 ≠ 拿得到：本会话没装载就必须拿不到');
    assert.deepEqual(result.loadedNames, [LOADED_SKILL], 'loadedNames 只含已装载的名字');
  });

  test('冻结后停用：拒绝加载并说明原因；恢复启用且内容未变即可再加载', async () => {
    // 事故（2026-10-05）：停用曾**回溯**改变历史会话（正文读不到、错误提示还误报
    // 「不在装载集合里」）。冻结的是内容身份：停用即拒绝，恢复启用且内容未变时可再加载。
    const disabledName = `skill-load-disabled-${randomUUID().slice(0, 8)}`;
    const body = '正文：启停不改变内容身份。';
    await ensureSkill({ name: disabledName, body });
    const engagementId = await newEngagement();
    const workerSessionId = await newWorkerSession(engagementId, [disabledName]);

    await pool.query('update pentest.skills set disabled = true where name = $1', [disabledName]);
    const blocked = await tools.loadSkill({ workerSessionId, skillName: disabledName });
    assert.equal(blocked.skill, null, '停用的 skill 不得返回正文');
    assert.match(blocked.refusal?.message ?? '', /停用/u, '必须给出准确的拒绝原因');

    // 反向确证：是 disabled 挡下的，而不是名字/会话写错导致「恒 null」的假通过。
    await pool.query('update pentest.skills set disabled = false where name = $1', [disabledName]);
    const allowed = await tools.loadSkill({ workerSessionId, skillName: disabledName });
    assert.notEqual(allowed.skill, null, '启用后同一会话必须能拿到');
    assert.equal(allowed.skill?.body, body, '启停不改变正文');
  });

  test('正文在会话创建后被替换：拒绝加载（事故 2026-10-05：冻结只冻名字）', async () => {
    const name = `skill-load-swap-${randomUUID().slice(0, 8)}`;
    const description = `回归夹具：${name}`;
    await ensureSkill({ name, body: '原始正文：只有 A。' });
    const engagementId = await newEngagement();
    const workerSessionId = await newWorkerSession(engagementId, [name]);

    // 人类确认的是原始正文；会话运行中有人把它换成另一套指令。
    const swapped = '替换后的正文：改做 B。';
    await pool.query(
      `update pentest.skills set body = $2, revision = $3, content_hash = $4 where name = $1`,
      [name, swapped, 2, skillContentHash({ name, description, body: swapped, revision: 2 })],
    );
    const result = await tools.loadSkill({ workerSessionId, skillName: name });
    assert.equal(result.skill, null, '正文漂移必须拒绝，而不是默默读到新正文');
    assert.match(result.refusal?.message ?? '', /修改/u);

    // 旧会话（026 之前：skill_freeze 为空）保持既有语义，读到的是当前正文。
    // 每个 engagement 只允许一个存活会话，因此另开一个作业。
    const legacyEngagement = await newEngagement();
    const legacySession = await newWorkerSession(legacyEngagement, [name], null);
    const legacy = await tools.loadSkill({ workerSessionId: legacySession, skillName: name });
    assert.equal(legacy.skill?.body, swapped, '没有冻结记录的旧会话回退到既有语义');
  });

  test('冻结后被删除：拒绝加载并指出删除事实', async () => {
    const name = `skill-load-gone-${randomUUID().slice(0, 8)}`;
    await ensureSkill({ name, body: '将被删除。' });
    const engagementId = await newEngagement();
    const workerSessionId = await newWorkerSession(engagementId, [name]);

    await pool.query('delete from pentest.skills where name = $1', [name]);
    const result = await tools.loadSkill({ workerSessionId, skillName: name });
    assert.equal(result.skill, null);
    assert.match(result.refusal?.message ?? '', /删除/u);
  });

  test('旧会话（无冻结列）保持既有语义：停用即不可读，且不编造漂移理由', async () => {
    const name = `skill-load-legacy-${randomUUID().slice(0, 8)}`;
    await ensureSkill({ name, body: '旧会话正文。' });
    const engagementId = await newEngagement();
    const workerSessionId = await newWorkerSession(engagementId, [name], null);

    await pool.query('update pentest.skills set disabled = true where name = $1', [name]);
    const result = await tools.loadSkill({ workerSessionId, skillName: name });
    assert.equal(result.skill, null);
    assert.equal(result.refusal, undefined, '旧会话没有冻结记录，不应编造拒绝理由');
    await pool.query('update pentest.skills set disabled = false where name = $1', [name]);
  });
});
