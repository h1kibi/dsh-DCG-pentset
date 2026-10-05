/**
 * skill 库服务的测试（§2.2）。
 *
 * 这个实现由并行切片交付但**没有配套测试**——这份测试是补上的，重点锁定四条
 * 错起来后果明确的规则：
 *
 *   1. **重名由数据库唯一约束最终裁决**，而不是「先查后插」——后者在人手双击时
 *      存在竞态窗口，会插进两条同名 skill。错误必须转成带码的 `SkillServiceError`，
 *      而不是把 SQLSTATE 泄漏给调用方。
 *   2. **修订号单调递增**，且内容哈希把 `revision` 算进去（§2.2「每次改动留痕」，
 *      同哈希的两次修订在审计里分不开）。
 *   3. **停用是软删**：`removeSkill` 之后 `listSkills({ enabledOnly: true })` 看不到，
 *      但默认列表仍然看得到，且行还在库里（`revision` 继续递增）。
 *   4. **空库不是错误**：没有 skill 时返回空数组，而不是抛异常。
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';

import { PgSkillService, SkillServiceError } from '../src/skills/pg-skill.ts';
import { MemoryLedger } from '../src/memory/ledger.ts';
import type { DbClient } from '../src/db/port.ts';
import { cleanupEngagements } from './helpers/cleanup.ts';

const DATABASE_URL = process.env.PENTEST_DATABASE_URL;

describe('skill 库（真实 PostgreSQL）', { skip: DATABASE_URL === undefined ? '未设置 PENTEST_DATABASE_URL' : false }, () => {
  let pool: Pool;
  const madeSkills: string[] = [];
  const madeEngagements: string[] = [];

  const db = (): DbClient => ({
    async query<Row = Record<string, unknown>>(sql: string, params?: readonly unknown[]) {
      const r = await pool.query(sql, params as unknown[] | undefined);
      return { rows: r.rows as Row[], rowCount: r.rowCount };
    },
  });

  before(() => {
    pool = new Pool({ connectionString: DATABASE_URL, max: 6 });
  });

  after(async () => {
    if (pool === undefined) return;
    // skills 表没有 `engagement_id`（它是全局库），因此不能走 engagement 清理夹具，
    // 按 id 列表删（这张表没有只追加约束，直删即可）。
    if (madeSkills.length > 0) {
      await pool.query('delete from pentest.skills where id = any($1::uuid[])', [madeSkills]);
    }
    // 审计事件写在账本里，而账本是**只追加**的（§9.5 的触发器会拒绝 DELETE）。
    // 因此必须用共享夹具——它用 `session_replication_role = 'replica'` 绕过触发器。
    await cleanupEngagements(pool, madeEngagements);
    await pool.end();
  });

  /** 每个用例用独立的名称前缀，避免同名 skill 跨用例互相干扰。 */
  let seq = 0;
  function uniqueName(prefix = 'skill'): string {
    seq += 1;
    return `${prefix}-${String(seq)}-${randomUUID().slice(0, 8)}`;
  }

  async function newService(): Promise<PgSkillService> {
    return new PgSkillService(db());
  }

  async function add(service: PgSkillService, over: { name?: string } = {}) {
    const summary = await service.addSkill({
      operatorId: 'op-1',
      reason: '测试新增',
      name: over.name ?? uniqueName(),
      description: '描述',
      body: '正文：第一步……',
    });
    madeSkills.push(summary.id);
    return summary;
  }

  // ───────────────────────── 新增 ─────────────────────────

  test('新增 skill：返回的修订号为 1，内容哈希非空且可列出', async () => {
    const service = await newService();
    const summary = await add(service);

    assert.equal(summary.revision, 1, '首次新增的修订号是 1');
    assert.equal(summary.disabled, false, '新增的 skill 默认启用');
    assert.notEqual(summary.contentHash, '', '内容哈希必须存在——它是「这次改动是什么」的标识');
    assert.equal(summary.addedBy, 'op-1');

    const listed = await service.listSkills();
    assert.ok(
      listed.some((skill) => skill.id === summary.id),
      '新增后必须能被列出',
    );
  });

  test('新增 skill：名称、描述、正文任一为空都被拒绝（§2.2）', async () => {
    const service = await newService();

    await assert.rejects(
      () => service.addSkill({ operatorId: 'op-1', reason: 'r', name: '  ', description: 'd', body: 'b' }),
      (error: unknown) => error instanceof SkillServiceError,
      '空名称必须被拒绝',
    );
    await assert.rejects(
      () => service.addSkill({ operatorId: 'op-1', reason: 'r', name: uniqueName(), description: '', body: 'b' }),
      (error: unknown) => error instanceof SkillServiceError,
      '空描述必须被拒绝',
    );
    await assert.rejects(
      () => service.addSkill({ operatorId: 'op-1', reason: 'r', name: uniqueName(), description: 'd', body: '  ' }),
      (error: unknown) => error instanceof SkillServiceError,
      '空正文必须被拒绝——正文是 Agent 会遵循的指令文本',
    );
  });

  test('新增 skill：同名被拒绝，且错误带码而不是泄漏 SQLSTATE', async () => {
    const service = await newService();
    const first = await add(service, { name: uniqueName('dup') });

    await assert.rejects(
      () =>
        service.addSkill({
          operatorId: 'op-1',
          reason: '测试重名',
          name: first.name,
          description: '另一条描述',
          body: '另一段正文',
        }),
      (error: unknown) => {
        assert.ok(error instanceof SkillServiceError, '必须是领域错误，而不是 pg 的原始错误');
        assert.notEqual(error.code, null, '重名要带可判别的码（界面据此给出「换个名字」的提示）');
        return true;
      },
    );

    // 重名失败不得留下半条记录
    const same = (await service.listSkills()).filter((skill) => skill.name === first.name);
    assert.equal(same.length, 1, '重名被拒后库里仍应只有一条');
  });

  // ───────────────────────── 更新 ─────────────────────────

  test('更新 skill：修订号递增，内容哈希随之改变', async () => {
    const service = await newService();
    const first = await add(service);

    const updated = await service.updateSkill({
      operatorId: 'op-2',
      reason: '修正正文',
      skillId: first.id,
      body: '正文：修正后的第一步……',
    });

    assert.equal(updated.revision, first.revision + 1, '每次被接受的改动递增修订号');
    assert.notEqual(
      updated.contentHash,
      first.contentHash,
      '修订号参与哈希：否则两次改动在审计里分不开',
    );
    assert.equal(updated.id, first.id, '更新不换标识');
    assert.equal(updated.name, first.name, '未传的字段保持原值');
  });

  test('更新 skill：改名撞到已有名称被拒绝，且原名保持可用', async () => {
    const service = await newService();
    const taken = await add(service, { name: uniqueName('taken') });
    const mine = await add(service, { name: uniqueName('mine') });

    await assert.rejects(
      () =>
        service.updateSkill({
          operatorId: 'op-1',
          reason: '改名',
          skillId: mine.id,
          name: taken.name,
        }),
      (error: unknown) => error instanceof SkillServiceError,
      '改名撞名必须被拒绝',
    );

    const after = (await service.listSkills()).find((skill) => skill.id === mine.id);
    assert.equal(after?.name, mine.name, '被拒的改名不该部分生效');
    assert.equal(after?.revision, mine.revision, '被拒的更新不该递增修订号');
  });

  test('更新 skill：停用后可以重新启用，两个方向都递增修订号', async () => {
    const service = await newService();
    const skill = await add(service);

    const disabled = await service.updateSkill({
      operatorId: 'op-1',
      reason: '暂时停用',
      skillId: skill.id,
      disabled: true,
    });
    assert.equal(disabled.disabled, true);

    const enabled = await service.updateSkill({
      operatorId: 'op-1',
      reason: '恢复使用',
      skillId: skill.id,
      disabled: false,
    });
    assert.equal(enabled.disabled, false);
    assert.equal(enabled.revision, skill.revision + 2, '两次改动各递增一次');
  });

  test('更新 skill：不存在的标识以领域错误拒绝', async () => {
    const service = await newService();
    await assert.rejects(
      () =>
        service.updateSkill({
          operatorId: 'op-1',
          reason: 'r',
          skillId: randomUUID(),
          body: 'x',
        }),
      (error: unknown) => error instanceof SkillServiceError,
    );
  });

  // ───────────────────────── 列出与停用 ─────────────────────────

  test('listSkills：enabledOnly 过滤停用项，默认列表仍包含它们（停用是软删）', async () => {
    const service = await newService();
    const keep = await add(service);
    const drop = await add(service);
    await service.updateSkill({
      operatorId: 'op-1',
      reason: '停用',
      skillId: drop.id,
      disabled: true,
    });

    const all = await service.listSkills();
    const enabled = await service.listSkills({ enabledOnly: true });

    assert.ok(all.some((skill) => skill.id === drop.id), '默认列表包含停用项——它们是软删，历史可查');
    assert.ok(!enabled.some((skill) => skill.id === drop.id), 'enabledOnly 过滤掉停用项');
    assert.ok(enabled.some((skill) => skill.id === keep.id), '启用项仍在');
  });

  test('listSkills：空库返回空数组，而不是错误', async () => {
    // 用一个只返回空集的连接替身：真实库里总有别的测试留下的 skill，
    // 而这里要断言的是「没有数据」这条路径本身。
    const empty = new PgSkillService({
      async query<Row = Record<string, unknown>>() {
        return { rows: [] as Row[], rowCount: 0 };
      },
    });

    assert.deepEqual(await empty.listSkills(), [], '没有 skill 不是异常');
    assert.deepEqual(await empty.listSkills({ enabledOnly: true }), []);
  });

  // ───────────────────────── 移除 ─────────────────────────

  test('removeSkill：软删——行仍在库里，默认列表可见但标记为停用', async () => {
    const service = await newService();
    const skill = await add(service);

    await service.removeSkill({ operatorId: 'op-1', reason: '不再使用', skillId: skill.id });

    const after = (await service.listSkills()).find((item) => item.id === skill.id);
    assert.notEqual(after, undefined, '移除是软删：行必须还在（审计与历史要能追）');
    assert.equal(after?.disabled, true, '软删的可见表现是停用');
    assert.ok(
      !(await service.listSkills({ enabledOnly: true })).some((item) => item.id === skill.id),
      '停用后不出现在启用列表里',
    );

    // 行确实还在库里（不只是服务层的说法）
    const rows = await pool.query('select id, disabled from pentest.skills where id = $1::uuid', [skill.id]);
    assert.equal(rows.rowCount, 1, '物理行必须仍然存在');
    assert.equal(rows.rows[0].disabled, true);
  });

  test('removeSkill：不存在的标识以领域错误拒绝', async () => {
    const service = await newService();
    await assert.rejects(
      () => service.removeSkill({ operatorId: 'op-1', reason: 'r', skillId: randomUUID() }),
      (error: unknown) => error instanceof SkillServiceError,
    );
  });

  // ───────────────────────── 审计 ─────────────────────────

  test('审计：配置了账本时，新增与更新各写一条可归因的事件', async () => {
    // 审计写在账本里，而账本按 engagement 归属，因此需要一个 engagement。
    const engagementId = randomUUID();
    madeEngagements.push(engagementId);
    await pool.query(
      `insert into pentest.engagements
         (id, tenant_id, name, status, current_status, target_snapshot, scope_snapshot, roe_snapshot, policy_snapshot, config_snapshot, created_by)
       values ($1::uuid, 't', 'skill-audit-test', 'running', 'worker_running', '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, 'tester')`,
      [engagementId],
    );

    const ledger = new MemoryLedger({ db: db(), txDb: db(), secret: 'pg-skill-test-secret-32-bytes-min' });
    const service = new PgSkillService(db(), { ledger, auditEngagementId: engagementId });

    const skill = await add(service);
    await service.updateSkill({
      operatorId: 'op-9',
      reason: '按复核意见修正',
      skillId: skill.id,
      body: '正文：修订后……',
    });

    const events = await pool.query(
      `select event_type, payload_json from pentest.context_events
        where engagement_id = $1::uuid and source_system = 'pentest-skill-library'
        order by chain_seq`,
      [engagementId],
    );

    assert.equal(events.rowCount, 2, '新增与更新各一条');
    const types = events.rows.map((row) => row.event_type);
    assert.deepEqual(types, ['skill.added', 'skill.updated']);

    // 归因三要素：谁、为什么、改动落在哪条 skill 上
    const update = events.rows[1].payload_json as Record<string, unknown>;
    assert.equal(update.operatorId, 'op-9', '审计必须记录操作者');
    assert.equal(update.reason, '按复核意见修正', '审计必须记录理由');
    assert.equal(update.skillId, skill.id, '审计必须指向被改的 skill');
    assert.equal(update.revision, skill.revision + 1, '审计必须记录改动后的修订号');
  });

  test('审计：未配置账本时服务照常工作（降级而不是抛错）', async () => {
    // 未配置审计目标时新增仍必须成功——审计是附加要求，不是可用性的前提。
    const service = await newService();
    const summary = await add(service);
    assert.ok(summary.id.length > 0);
  });
});
