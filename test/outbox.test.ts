/**
 * 索引任务队列测试（设计文档 §8.4「Streaming RAG 管线」、§14.3「启动重扫」、§15.3、§15.5「索引滞后」）。
 *
 * 两层用例，分工不重叠：
 *
 * - **纯逻辑**（始终运行）：`job_type` 取值表、幂等键派生、参数校验、滞后状态判定。
 *   参数校验用「拒绝服务」的假 `DbClient`：校验不合法时**不得触库**——数据库不可用时，
 *   一个参数错误不该表现为连接错误。
 * - **集成**（设置 `PENTEST_DATABASE_URL` 时启用）：真实 PostgreSQL 才能验证的东西——
 *   `FOR UPDATE SKIP LOCKED` 的真实行锁与跳过、`idempotency_key` 的全局唯一冲突、
 *   002 触发器强制的状态迁移（`pending>leased,leased>done/dead/pending`）与终态不可改写、
 *   `make_interval` 的退避时间算术。
 *
 * **SKIP LOCKED 的证明方式**（不止断言条数，见「并发与行锁」一节）：
 *   a. 让另一个连接在**打开的事务里**对队首任务持 `FOR UPDATE` 行锁，再调用 `claim()`：
 *      断言它跳过该行、领到后面的任务，并且**在 1.5 秒内返回**（没有 SKIP LOCKED 时会一直等
 *      那把锁，直到 statement_timeout 把它取消）；
 *   b. 对照组：同一把锁上跑一条**去掉 SKIP LOCKED** 的 `FOR UPDATE`，断言它以 SQLSTATE 57014
 *      超时。这证明锁是真实存在的，因此 (a) 的"跳过"只能归因于 SKIP LOCKED，
 *      而不是"那一行恰好没被锁"。
 *   c. 两个独立连接并发 claim 各领各的（不重复），但它本身**不是** SKIP LOCKED 的证据：
 *      自动提交的单语句本来就会先后串行完成。
 *
 * 连接用超级用户（`postgres`）：002 已对 `outbox_jobs` 启用 FORCE RLS，非所有者角色未设
 * `pentest.engagement_id` 会话变量时看不到任何行。因此本文件测的是队列装配与并发语义，
 * 不是 RLS 本身（RLS 由 test/db.test.ts 覆盖）。
 */

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import { Client, Pool } from 'pg';

import type { DbClient } from '../src/db/port.ts';
import {
  LEASE_EXPIRED_ERROR,
  OUTBOX_MAX_ERROR_LENGTH,
  OutboxError,
  PgOutboxQueue,
  deriveIdempotencyKey,
  indexLagState,
  type EnqueueInput,
  type EnqueueResult,
  type OutboxErrorCode,
  type OutboxJobStatus,
} from '../src/memory/outbox.ts';

// ───────────────────────────── 辅助 ─────────────────────────────

/** 不应被访问的数据库：用来证明参数校验发生在触库之前。 */
const NO_DB: DbClient = {
  query() {
    return Promise.reject(new Error('该用例不应访问数据库'));
  },
};

/** 取唯一一行（0 行或多行都直接失败，避免断言被静默跳过）。 */
function onlyRow<Row>(rows: readonly Row[]): Row {
  assert.equal(rows.length, 1, `期望恰好一行，实际 ${rows.length} 行`);
  const row = rows[0];
  if (row === undefined) throw new Error('unreachable');
  return row;
}

/** 运行一段应当失败的调用并取回错误对象；成功则返回 null。 */
async function captureError(run: () => Promise<unknown>): Promise<unknown> {
  try {
    await run();
    return null;
  } catch (error: unknown) {
    return error;
  }
}

async function expectOutboxError(
  run: () => Promise<unknown>,
  code: OutboxErrorCode,
): Promise<OutboxError> {
  const error = await captureError(run);
  assert.ok(error instanceof OutboxError, `期望 OutboxError，实际 ${String(error)}`);
  assert.equal(error.code, code, `错误码不符：${error.message} / ${error.detail}`);
  return error;
}

// ───────────────────────────── 取值表与幂等键（纯逻辑） ─────────────────────────────

describe('job_type 取值表与幂等键（纯逻辑）', () => {
  it('未知 job_type 入队被拒：调用方与索引器版本不一致必须立刻可见', async () => {
    const queue = new PgOutboxQueue(NO_DB);
    const error = await expectOutboxError(
      () =>
        queue.enqueue({
          engagementId: randomUUID(),
          jobType: 'index_thought',
          entityId: randomUUID(),
        }),
      'unknown_job_type',
    );
    assert.match(error.detail, /index_event/);
  });

  it('入队参数：非法 engagementId / entityId 被拒（不触库）', async () => {
    const queue = new PgOutboxQueue(NO_DB);
    await expectOutboxError(
      () => queue.enqueue({ engagementId: 'eng-1', jobType: 'index_event', entityId: randomUUID() }),
      'invalid_input',
    );
    await expectOutboxError(
      () => queue.enqueue({ engagementId: randomUUID(), jobType: 'index_event', entityId: 'nope' }),
      'invalid_input',
    );
    await expectOutboxError(
      () =>
        queue.enqueue({
          engagementId: randomUUID(),
          jobType: 'index_event',
          entityId: randomUUID(),
          idempotencyKey: '   ',
        }),
      'invalid_input',
    );
  });

  it('幂等键派生：同输入同键，实体与类型参与区分', () => {
    const entityId = randomUUID();
    assert.equal(
      deriveIdempotencyKey({ jobType: 'index_event', entityId }),
      deriveIdempotencyKey({ jobType: 'index_event', entityId }),
    );
    assert.notEqual(
      deriveIdempotencyKey({ jobType: 'index_event', entityId }),
      deriveIdempotencyKey({ jobType: 'index_memory_item', entityId }),
    );
    assert.notEqual(
      deriveIdempotencyKey({ jobType: 'index_event', entityId }),
      deriveIdempotencyKey({ jobType: 'index_event', entityId: randomUUID() }),
    );
  });

  it('reindex_engagement 必须能用判别值换键：终态任务不会被同键重新激活', () => {
    const entityId = randomUUID();
    const atWatermark4200 = deriveIdempotencyKey({
      jobType: 'reindex_engagement',
      entityId,
      discriminator: '4200',
    });
    const atWatermark4300 = deriveIdempotencyKey({
      jobType: 'reindex_engagement',
      entityId,
      discriminator: '4300',
    });
    assert.notEqual(atWatermark4200, atWatermark4300);
    assert.ok(atWatermark4200.startsWith(`reindex_engagement:${entityId}:`));
  });

  it('判别值不得为空白，也不得超长', () => {
    const entityId = randomUUID();
    for (const discriminator of ['', '   ', 'x'.repeat(201)]) {
      assert.throws(
        () => deriveIdempotencyKey({ jobType: 'reindex_engagement', entityId, discriminator }),
        (error: unknown) => error instanceof OutboxError && error.code === 'invalid_input',
      );
    }
  });
});

// ───────────────────────────── 参数校验（纯逻辑） ─────────────────────────────

describe('参数校验 fail-closed（校验先于触库）', () => {
  it('claim：批量与租约秒数必须是 >= 1 的整数', async () => {
    const queue = new PgOutboxQueue(NO_DB);
    for (const limit of [0, -1, 1.5]) {
      await expectOutboxError(() => queue.claim({ engagementId: randomUUID(), limit }), 'invalid_input');
    }
    await expectOutboxError(
      () => queue.claim({ engagementId: randomUUID(), leaseSeconds: 0 }),
      'invalid_input',
    );
  });

  it('claim：空类型过滤被拒，未知类型按版本不符报错', async () => {
    const queue = new PgOutboxQueue(NO_DB);
    await expectOutboxError(
      () => queue.claim({ engagementId: randomUUID(), jobTypes: [] }),
      'invalid_input',
    );
    await expectOutboxError(
      () => queue.claim({ engagementId: randomUUID(), jobTypes: ['index_event', 'wat'] }),
      'unknown_job_type',
    );
  });

  it('complete / fail：任务标识必须是十进制整数', async () => {
    const queue = new PgOutboxQueue(NO_DB);
    for (const bad of ['', 'abc', '-1', '1;drop table pentest.outbox_jobs']) {
      await expectOutboxError(() => queue.complete(bad), 'invalid_input');
      await expectOutboxError(() => queue.fail(bad, '错误'), 'invalid_input');
    }
  });

  it('fail：空白错误描述被拒（空白会把失败原因写成空）', async () => {
    const queue = new PgOutboxQueue(NO_DB);
    await expectOutboxError(() => queue.fail('1', '   '), 'invalid_input');
    await expectOutboxError(() => queue.fail('1', ''), 'invalid_input');
  });

  it('sweepExpired：批量与基准时间都受校验', async () => {
    const queue = new PgOutboxQueue(NO_DB);
    await expectOutboxError(() => queue.sweepExpired({ limit: 0 }), 'invalid_input');
    await expectOutboxError(
      () => queue.sweepExpired({ now: new Date('不是时间') }),
      'invalid_input',
    );
    await expectOutboxError(
      () => queue.sweepExpired({ engagementId: 'not-a-uuid' }),
      'invalid_input',
    );
  });

  it('stats：engagementId 必须是 uuid', async () => {
    const queue = new PgOutboxQueue(NO_DB);
    await expectOutboxError(() => queue.stats(''), 'invalid_input');
  });

  it('构造参数：重试上限、退避参数不合法时立即失败', () => {
    for (const options of [
      { maxAttempts: 0 },
      { leaseSeconds: 0 },
      { claimLimit: 0 },
      { sweepLimit: -1 },
      { backoffBaseSeconds: 0 },
      { backoffFactor: 0.5 },
      { backoffMaxSeconds: 10, backoffBaseSeconds: 30 },
    ]) {
      assert.throws(
        () => new PgOutboxQueue(NO_DB, options),
        (error: unknown) => error instanceof OutboxError && error.code === 'invalid_input',
        `期望拒绝 ${JSON.stringify(options)}`,
      );
    }
  });
});

// ───────────────────────────── 滞后状态（纯逻辑） ─────────────────────────────

describe('索引滞后状态（§15.5：就绪 / 滞后 / 失败）', () => {
  it('有死信即失败，且优先于「还有待办」', () => {
    assert.equal(indexLagState({ pending: 3, leased: 1, done: 9, dead: 1 }), 'failed');
  });

  it('有未完成任务即滞后', () => {
    assert.equal(indexLagState({ pending: 1, leased: 0, done: 0, dead: 0 }), 'lagging');
    assert.equal(indexLagState({ pending: 0, leased: 2, done: 5, dead: 0 }), 'lagging');
  });

  it('全部完成才是就绪：已完成任务累积不代表滞后', () => {
    assert.equal(indexLagState({ pending: 0, leased: 0, done: 7, dead: 0 }), 'ready');
    assert.equal(indexLagState({ pending: 0, leased: 0, done: 0, dead: 0 }), 'ready');
  });
});

// ───────────────────────────── 集成（可选） ─────────────────────────────

const DATABASE_URL = process.env['PENTEST_DATABASE_URL'];

describe(
  '集成：真实 PostgreSQL',
  { skip: DATABASE_URL === undefined ? '未设置 PENTEST_DATABASE_URL' : false },
  () => {
    const JOB_COLUMNS = `id, engagement_id, job_type, entity_id, idempotency_key, status,
       attempts, available_at, lease_until, last_error, created_at`;

    interface JobRowView {
      readonly id: string;
      readonly engagement_id: string;
      readonly job_type: string;
      readonly entity_id: string;
      readonly idempotency_key: string;
      readonly status: OutboxJobStatus;
      readonly attempts: number;
      readonly available_at: Date;
      readonly lease_until: Date | null;
      readonly last_error: string | null;
      readonly created_at: Date;
    }

    let pool: Pool;
    /** 主队列：3 次重试上限（便于在一个用例里走到死信），租约 60 秒。 */
    let queue: PgOutboxQueue;
    const engagements: string[] = [];

    /** 每个用例独占一个 engagement：计数类断言（批量、并发、统计）就不会被别的用例污染。 */
    async function newEngagement(): Promise<string> {
      const id = randomUUID();
      await pool.query(
        `insert into pentest.engagements
           (id, tenant_id, name, status, current_status, target_snapshot, scope_snapshot,
            roe_snapshot, policy_snapshot, config_snapshot, created_by)
         values ($1, 'outbox-test', $2, 'running', 'ready', '{}'::jsonb, '{}'::jsonb,
                 '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, 'node-test')`,
        [id, `outbox-${id}`],
      );
      engagements.push(id);
      return id;
    }

    /** 独立的物理连接：模拟第二个索引器实例，或持锁不放的干扰事务。 */
    async function connect(): Promise<Client> {
      const client = new Client({ connectionString: DATABASE_URL });
      await client.connect();
      return client;
    }

    async function readJob(id: string): Promise<JobRowView> {
      const result = await pool.query<JobRowView>(
        `select ${JOB_COLUMNS} from pentest.outbox_jobs where id = $1::bigint`,
        [id],
      );
      return onlyRow(result.rows);
    }

    async function countJobs(engagementId: string): Promise<number> {
      const result = await pool.query<{ job_count: string }>(
        'select count(*)::text as job_count from pentest.outbox_jobs where engagement_id = $1::uuid',
        [engagementId],
      );
      return Number(onlyRow(result.rows).job_count);
    }

    /** 把租约推到期（模拟实例崩溃：租约是唯一的崩溃信号，本表没有心跳列）。 */
    async function expireLease(id: string, seconds = 1): Promise<void> {
      await pool.query(
        `update pentest.outbox_jobs
            set lease_until = now() - make_interval(secs => $2::double precision)
          where id = $1::bigint`,
        [id, seconds],
      );
    }

    /** 把退避推迟的 available_at 拨回现在：只为了让用例不必真的等 5/10/20 秒。 */
    async function resetAvailableAt(id: string): Promise<void> {
      await pool.query('update pentest.outbox_jobs set available_at = now() where id = $1::bigint', [
        id,
      ]);
    }

    function enqueueJob(
      engagementId: string,
      overrides: Partial<EnqueueInput> = {},
    ): Promise<EnqueueResult> {
      return queue.enqueue({
        engagementId,
        jobType: 'index_event',
        entityId: randomUUID(),
        ...overrides,
      });
    }

    /**
     * 反复「领取 → 失败」直到队列的重试上限，把任务推到死信。
     * 每轮先把自己的退避时间拨回现在：否则用例要真的等 5/10/20 秒。
     * 调用前任务必须是待办（不要预先领取），否则第一轮的领取会因租约未过期而拿空。
     */
    async function failUntilDead(
      target: PgOutboxQueue,
      engagementId: string,
      jobId: string,
    ): Promise<void> {
      for (let attempt = 1; attempt <= target.options.maxAttempts; attempt += 1) {
        await resetAvailableAt(jobId);
        const claimed = onlyRow(await target.claim({ engagementId, limit: 1 }));
        assert.equal(claimed.id, jobId, '应当领到的永远是同一个任务');
        assert.equal(claimed.attempts, attempt, '每次领取递增 attempts');
        const settled = await target.fail(jobId, `第 ${attempt} 次失败`);
        assert.ok(settled !== null, '任务在租约内，结算必须成功');
        if (attempt === target.options.maxAttempts) {
          assert.equal(settled.status, 'dead', '走到上限即归档');
        }
      }
    }

    const past = (): Date => new Date(Date.now() - 60_000);

    before(async () => {
      pool = new Pool({ connectionString: DATABASE_URL });
      // 迁移由 Main 统一执行；缺表时在这里给出明确信号，而不是让每个用例各自报 relation does not exist。
      await pool.query('select 1 from pentest.outbox_jobs limit 0');
      queue = new PgOutboxQueue(pool as unknown as DbClient, { maxAttempts: 3, leaseSeconds: 60 });
    });

    after(async () => {
      if (engagements.length > 0) {
        await pool.query('delete from pentest.outbox_jobs where engagement_id = any($1::uuid[])', [
          engagements,
        ]);
        // policy_versions 也引用 engagements：先删子表，engagements 才删得掉。
        await pool.query('delete from pentest.policy_versions where engagement_id = any($1::uuid[])', [engagements]);
        await pool.query('delete from pentest.engagements where id = any($1::uuid[])', [engagements]);
      }
      await pool.end();
    });

    // ───────────── 入队 ─────────────

    it('入队落库为 pending：零尝试、无租约、幂等键与实体一致', async () => {
      const engagementId = await newEngagement();
      const entityId = randomUUID();
      const key = deriveIdempotencyKey({ jobType: 'index_event', entityId });
      const { job, created } = await enqueueJob(engagementId, { entityId, idempotencyKey: key });

      assert.equal(created, true);
      assert.equal(job.status, 'pending');
      assert.equal(job.attempts, 0);
      assert.equal(job.leaseUntil, null);
      assert.equal(job.lastError, null);
      assert.equal(job.jobType, 'index_event');
      assert.equal(job.entityId, entityId);
      assert.equal(job.engagementId, engagementId);
      assert.equal(job.idempotencyKey, key);

      const row = await readJob(job.id);
      assert.equal(row.idempotency_key, key);
      assert.equal(row.entity_id, entityId);
      assert.equal(row.lease_until, null);
      assert.equal(row.attempts, 0);
      assert.ok(Math.abs(row.available_at.getTime() - job.availableAt.getTime()) < 1000);
    });

    it('重复入队幂等：返回既有任务，不新增行、不重置进度', async () => {
      const engagementId = await newEngagement();
      const entityId = randomUUID();
      const key = deriveIdempotencyKey({ jobType: 'index_event', entityId });

      const first = await enqueueJob(engagementId, { entityId, idempotencyKey: key });
      const claimed = onlyRow(await queue.claim({ engagementId, limit: 1 }));
      assert.equal(claimed.id, first.job.id);
      assert.equal(await queue.complete(claimed.id), true);

      const replay = await enqueueJob(engagementId, { entityId, idempotencyKey: key });
      assert.equal(replay.created, false);
      assert.equal(replay.job.id, first.job.id);
      assert.equal(replay.job.status, 'done', '幂等命中不得复活终态任务（终态不可回退）');
      assert.equal(replay.job.attempts, 1, '既有进度原样返回');
      assert.equal(await countJobs(engagementId), 1, '重复入队不得新增行');
    });

    it('幂等键全局唯一：同一键表达另一件事时报错，而不是静默返回别的任务', async () => {
      const engagementId = await newEngagement();
      const key = deriveIdempotencyKey({ jobType: 'index_event', entityId: randomUUID() });
      await enqueueJob(engagementId, { idempotencyKey: key });
      const error = await expectOutboxError(
        () => enqueueJob(engagementId, { entityId: randomUUID(), idempotencyKey: key }),
        'invalid_input',
      );
      assert.match(error.message, /另一个任务/);
    });

    it('并发重复入队：唯一索引兜底，两个实例拿到同一条任务', async () => {
      const engagementId = await newEngagement();
      const entityId = randomUUID();
      const key = deriveIdempotencyKey({ jobType: 'index_event', entityId });
      const left = await connect();
      const right = await connect();
      try {
        const [a, b] = await Promise.all([
          new PgOutboxQueue(left as unknown as DbClient).enqueue({
            engagementId,
            jobType: 'index_event',
            entityId,
            idempotencyKey: key,
          }),
          new PgOutboxQueue(right as unknown as DbClient).enqueue({
            engagementId,
            jobType: 'index_event',
            entityId,
            idempotencyKey: key,
          }),
        ]);
        assert.equal(a.job.id, b.job.id, '同一个键必须落到同一条任务');
        assert.equal(
          [a, b].filter((result) => result.created).length,
          1,
          '恰好一次插入成功，另一次幂等命中（不是两次都插入）',
        );
        assert.equal(await countJobs(engagementId), 1);
      } finally {
        await left.end();
        await right.end();
      }
    });

    it('同一实体可以有不同的索引任务（类型不同、键不同）', async () => {
      const engagementId = await newEngagement();
      const entityId = randomUUID();
      const asEvent = await enqueueJob(engagementId, {
        entityId,
        idempotencyKey: deriveIdempotencyKey({ jobType: 'index_event', entityId }),
      });
      const asItem = await enqueueJob(engagementId, {
        entityId,
        jobType: 'index_memory_item',
        idempotencyKey: deriveIdempotencyKey({ jobType: 'index_memory_item', entityId }),
      });
      assert.notEqual(asEvent.job.id, asItem.job.id);
      assert.equal(await countJobs(engagementId), 2);
    });

    it('入队可指定 available_at：未到点的任务不会被领取', async () => {
      const engagementId = await newEngagement();
      const later = await enqueueJob(engagementId, {
        availableAt: new Date(Date.now() + 3_600_000),
      });
      assert.equal((await queue.claim({ engagementId })).length, 0);
      assert.equal((await readJob(later.job.id)).status, 'pending');

      const due = await enqueueJob(engagementId, { availableAt: past() });
      const claimed = onlyRow(await queue.claim({ engagementId, limit: 5 }));
      assert.equal(claimed.id, due.job.id);
    });

    // ───────────── 领取与租约 ─────────────

    it('领取写租约：pending→leased、attempts+1、lease_until = now + leaseSeconds', async () => {
      const engagementId = await newEngagement();
      const started = Date.now();
      const { job } = await enqueueJob(engagementId, { availableAt: past() });

      const claimed = onlyRow(await queue.claim({ engagementId, limit: 1, leaseSeconds: 45 }));
      assert.equal(claimed.id, job.id);
      assert.equal(claimed.status, 'leased');
      assert.equal(claimed.attempts, 1);

      const row = await readJob(job.id);
      assert.equal(row.status, 'leased');
      assert.equal(row.attempts, 1);
      const leaseUntil = row.lease_until;
      assert.ok(leaseUntil !== null, '领取必须写租约');
      const ttl = leaseUntil.getTime() - started;
      assert.ok(ttl > 40_000 && ttl < 50_000, `租约长度应为 45 秒，实际 ${ttl}ms`);
      assert.equal(claimed.leaseUntil.getTime(), leaseUntil.getTime());
    });

    it('未过期的租约不会被重复领取（同一实例重复 claim 拿到空）', async () => {
      const engagementId = await newEngagement();
      const { job } = await enqueueJob(engagementId, { availableAt: past() });
      assert.equal((await queue.claim({ engagementId, limit: 1 })).length, 1);
      assert.equal((await queue.claim({ engagementId, limit: 1 })).length, 0);
      assert.equal((await readJob(job.id)).status, 'leased');
      assert.equal((await readJob(job.id)).attempts, 1, '重复 claim 不得重复累加尝试次数');
    });

    it('过期租约可被重领：实例崩溃后任务不会永久卡在 leased', async () => {
      const engagementId = await newEngagement();
      const { job } = await enqueueJob(engagementId, { availableAt: past() });
      const first = onlyRow(await queue.claim({ engagementId, limit: 1 }));
      assert.equal(first.attempts, 1);

      // 实例崩溃：没有任何结算调用，只有租约静静到期。
      await expireLease(job.id, 5);

      const second = onlyRow(await queue.claim({ engagementId, limit: 1 }));
      assert.equal(second.id, job.id, '过期租约必须可被另一个实例重领');
      assert.equal(second.attempts, 2, '重领同样计数，重试上限才有意义');
      const row = await readJob(job.id);
      assert.equal(row.status, 'leased');
      const leaseUntil = row.lease_until;
      assert.ok(leaseUntil !== null);
      assert.ok(leaseUntil.getTime() > Date.now(), '重领要写新的租约，不能沿用过期的');
    });

    it('领取尊重批量上限，且按 available_at 升序', async () => {
      const engagementId = await newEngagement();
      const older = await enqueueJob(engagementId, { availableAt: new Date(Date.now() - 20_000) });
      const middle = await enqueueJob(engagementId, { availableAt: new Date(Date.now() - 10_000) });
      const newer = await enqueueJob(engagementId, { availableAt: new Date(Date.now() - 5_000) });

      const firstBatch = await queue.claim({ engagementId, limit: 2 });
      assert.deepEqual(
        firstBatch.map((job) => job.id),
        [older.job.id, middle.job.id],
      );
      const secondBatch = await queue.claim({ engagementId, limit: 2 });
      assert.deepEqual(
        secondBatch.map((job) => job.id),
        [newer.job.id],
      );
      assert.equal((await queue.claim({ engagementId, limit: 2 })).length, 0);
    });

    it('领取可按 job_type 过滤：事件索引器不会抢走记忆条目的任务', async () => {
      const engagementId = await newEngagement();
      const event = await enqueueJob(engagementId, { jobType: 'index_event', availableAt: past() });
      const item = await enqueueJob(engagementId, {
        jobType: 'index_memory_item',
        availableAt: past(),
      });

      const items = await queue.claim({ engagementId, jobTypes: ['index_memory_item'], limit: 5 });
      assert.deepEqual(
        items.map((job) => job.id),
        [item.job.id],
      );
      const events = await queue.claim({ engagementId, jobTypes: ['index_event'], limit: 5 });
      assert.deepEqual(
        events.map((job) => job.id),
        [event.job.id],
      );
    });

    it('领取只在指定 engagement 内：别的 engagement 的任务不被领走', async () => {
      const mine = await newEngagement();
      const theirs = await newEngagement();
      const myJob = await enqueueJob(mine, { availableAt: past() });
      const theirJob = await enqueueJob(theirs, { availableAt: past() });

      const claimed = await queue.claim({ engagementId: mine, limit: 5 });
      assert.deepEqual(
        claimed.map((job) => job.id),
        [myJob.job.id],
      );
      assert.equal((await readJob(theirJob.job.id)).status, 'pending');
    });

    // ───────────── 并发与行锁（SKIP LOCKED 的证明） ─────────────

    it('SKIP LOCKED：别的实例锁住队首时，claim 跳过它并在 1.5 秒内返回', async () => {
      const engagementId = await newEngagement();
      const head = await enqueueJob(engagementId, { availableAt: new Date(Date.now() - 10_000) });
      const next = await enqueueJob(engagementId, { availableAt: new Date(Date.now() - 5_000) });

      const holder = await connect();
      const claimer = await connect();
      try {
        // 模拟另一个索引器实例：它已经领走队首任务（行锁持有到一个尚未提交的事务里）。
        await holder.query('begin');
        await holder.query('select id from pentest.outbox_jobs where id = $1::bigint for update', [
          head.job.id,
        ]);
        // 没有 SKIP LOCKED 时 claim 会一直等这把锁；给个上限让失败是"报错"而不是"挂住"。
        await claimer.query("set statement_timeout = '3000'");

        const started = Date.now();
        const claimed = await new PgOutboxQueue(claimer as unknown as DbClient).claim({
          engagementId,
          limit: 5,
        });
        const elapsed = Date.now() - started;

        assert.deepEqual(
          claimed.map((job) => job.id),
          [next.job.id],
          '被行锁锁住的队首必须被跳过，而不是阻塞或重复领取',
        );
        assert.ok(elapsed < 1500, `claim 在行锁下不得阻塞（实际 ${elapsed}ms）`);
        assert.equal((await readJob(head.job.id)).status, 'pending', '被跳过的行没有被改写');
      } finally {
        await holder.query('rollback');
        await claimer.query('reset statement_timeout');
        await holder.end();
        await claimer.end();
      }

      // 锁释放后，被跳过的那条立刻成为可领取的。
      const after = await queue.claim({ engagementId, limit: 5 });
      assert.deepEqual(
        after.map((job) => job.id),
        [head.job.id],
      );
    });

    it('对照组：同一把锁上不带 SKIP LOCKED 的 FOR UPDATE 会超时（锁真实存在）', async () => {
      const engagementId = await newEngagement();
      const { job } = await enqueueJob(engagementId, { availableAt: past() });

      const holder = await connect();
      const probe = await connect();
      try {
        await holder.query('begin');
        await holder.query('select id from pentest.outbox_jobs where id = $1::bigint for update', [
          job.id,
        ]);

        await probe.query('begin');
        await probe.query("set local statement_timeout = '500ms'");
        const error = await captureError(() =>
          probe.query('select id from pentest.outbox_jobs where id = $1::bigint for update', [job.id]),
        );
        await probe.query('rollback');

        const code =
          typeof error === 'object' && error !== null && 'code' in error
            ? String(error.code)
            : undefined;
        assert.equal(code, '57014', `期望 statement_timeout 取消，实际 ${String(error)}`);
      } finally {
        await holder.query('rollback');
        await holder.end();
        await probe.end();
      }
      assert.equal((await readJob(job.id)).status, 'pending');
    });

    it('两个独立连接并发 claim 不会拿到同一条任务', async () => {
      const engagementId = await newEngagement();
      for (let index = 0; index < 4; index += 1) {
        await enqueueJob(engagementId, { availableAt: past() });
      }
      const left = await connect();
      const right = await connect();
      try {
        const leftQueue = new PgOutboxQueue(left as unknown as DbClient, { leaseSeconds: 60 });
        const rightQueue = new PgOutboxQueue(right as unknown as DbClient, { leaseSeconds: 60 });
        const collected: string[] = [];
        for (let round = 0; round < 2; round += 1) {
          const [fromLeft, fromRight] = await Promise.all([
            leftQueue.claim({ engagementId, limit: 2 }),
            rightQueue.claim({ engagementId, limit: 2 }),
          ]);
          collected.push(...fromLeft.map((job) => job.id), ...fromRight.map((job) => job.id));
        }
        assert.equal(collected.length, 4, '两个实例应恰好取尽 4 条');
        assert.equal(new Set(collected).size, 4, '同一条任务不得被领取两次');
        assert.equal((await queue.claim({ engagementId, limit: 5 })).length, 0);
      } finally {
        await left.end();
        await right.end();
      }
    });

    // ───────────── 结算 ─────────────

    it('complete 结算为 done：清空租约、任务保留、不再可领取', async () => {
      const engagementId = await newEngagement();
      const { job } = await enqueueJob(engagementId, { availableAt: past() });
      const claimed = onlyRow(await queue.claim({ engagementId, limit: 1 }));
      assert.equal(claimed.id, job.id);

      assert.equal(await queue.complete(job.id), true);
      const row = await readJob(job.id);
      assert.equal(row.status, 'done');
      assert.equal(row.lease_until, null, '结算后不应留着租约（否则诊断会读错）');
      assert.equal(await countJobs(engagementId), 1, '完成任务保留，供滞后诊断与审计对照');

      assert.equal(await queue.complete(job.id), false, '重复结算必须幂等返回 false');
      assert.equal((await readJob(job.id)).status, 'done', 'done 是终态，重复结算不得改写');
      assert.equal((await queue.claim({ engagementId, limit: 5 })).length, 0, 'done 不再可领取');
    });

    it('fail 首次失败：回 pending、记录原因、清空租约、按基数退避', async () => {
      const engagementId = await newEngagement();
      const { job } = await enqueueJob(engagementId, { availableAt: past() });
      onlyRow(await queue.claim({ engagementId, limit: 1 }));

      const started = Date.now();
      const settled = await queue.fail(job.id, '嵌入提供方 503');
      assert.ok(settled !== null, '任务在租约内，结算必须成功');
      assert.equal(settled.status, 'pending', '未到上限必须回到待办');
      assert.equal(settled.attempts, 1);
      assert.equal(settled.leaseUntil, null);
      assert.equal(settled.lastError, '嵌入提供方 503');

      const delay = settled.availableAt.getTime() - started;
      assert.ok(delay > 3_500 && delay < 6_500, `首次失败应退避约 5 秒，实际 ${delay}ms`);
      const row = await readJob(job.id);
      assert.equal(row.status, 'pending');
      assert.equal(row.last_error, '嵌入提供方 503');
      assert.equal(row.lease_until, null);
      assert.equal((await queue.claim({ engagementId, limit: 5 })).length, 0, '退避期内不得被领取');
    });

    it('退避顺序正确：连续失败按 5s → 10s → 20s 逐次推迟', async () => {
      const engagementId = await newEngagement();
      const retryQueue = new PgOutboxQueue(pool as unknown as DbClient, { maxAttempts: 10 });
      const { job } = await enqueueJob(engagementId, { availableAt: past() });

      const delays: number[] = [];
      let claimed = onlyRow(await retryQueue.claim({ engagementId, limit: 1 }));
      for (let round = 1; round <= 3; round += 1) {
        const started = Date.now();
        const settled = await retryQueue.fail(claimed.id, `第 ${round} 次失败`);
        assert.ok(settled !== null);
        assert.equal(settled.attempts, round);
        delays.push(settled.availableAt.getTime() - started);
        await resetAvailableAt(job.id);
        claimed = onlyRow(await retryQueue.claim({ engagementId, limit: 1 }));
      }

      const [first, second, third] = delays;
      assert.ok(first !== undefined && second !== undefined && third !== undefined);
      assert.ok(first > 3_500 && first < 6_500, `第 1 次退避应约 5 秒，实际 ${first}ms`);
      assert.ok(second > 8_500 && second < 11_500, `第 2 次退避应约 10 秒，实际 ${second}ms`);
      assert.ok(third > 17_500 && third < 21_000, `第 3 次退避应约 20 秒，实际 ${third}ms`);
      assert.ok(first < second && second < third, '退避必须逐次推迟，不能原地重试');
    });

    it('fail 到重试上限转 dead：失败归档不删除任务，且死信不再可领取', async () => {
      const engagementId = await newEngagement();
      const { job } = await enqueueJob(engagementId, { availableAt: past() });
      onlyRow(await queue.claim({ engagementId, limit: 1 }));

      const firstFail = await queue.fail(job.id, '第 1 次失败');
      assert.ok(firstFail !== null);
      assert.equal(firstFail.status, 'pending', '上限是 3，第 1 次失败还没到');
      await resetAvailableAt(job.id);
      onlyRow(await queue.claim({ engagementId, limit: 1 }));
      const secondFail = await queue.fail(job.id, '第 2 次失败');
      assert.ok(secondFail !== null);
      assert.equal(secondFail.status, 'pending', '第 2 次失败仍未到上限');
      await resetAvailableAt(job.id);
      onlyRow(await queue.claim({ engagementId, limit: 1 }));
      const thirdFail = await queue.fail(job.id, '第 3 次失败');
      assert.ok(thirdFail !== null);
      assert.equal(thirdFail.status, 'dead', '到达上限必须进失败归档而不是无限重试（§15.5）');
      assert.equal(thirdFail.attempts, 3);

      const row = await readJob(job.id);
      assert.equal(row.status, 'dead');
      assert.equal(row.attempts, 3);
      assert.equal(row.last_error, '第 3 次失败');
      assert.equal(await countJobs(engagementId), 1, '归档不删除任务（也不删除事件）');
      assert.equal((await queue.claim({ engagementId, limit: 5 })).length, 0);

      const stats = await queue.stats(engagementId);
      assert.equal(stats.counts.dead, 1);
      assert.equal(stats.state, 'failed');
      assert.equal(stats.unfinished, 0);
    });

    it('终态冻结：dead 之后再怎么结算都不改行（触发器兜底）', async () => {
      const engagementId = await newEngagement();
      const { job } = await enqueueJob(engagementId, { availableAt: past() });
      await failUntilDead(queue, engagementId, job.id);
      const before = await readJob(job.id);

      assert.equal(await queue.complete(job.id), false);
      assert.equal(await queue.fail(job.id, '再失败一次'), null);

      const after = await readJob(job.id);
      assert.deepEqual(
        {
          status: after.status,
          attempts: after.attempts,
          last_error: after.last_error,
          lease_until: after.lease_until,
        },
        {
          status: before.status,
          attempts: before.attempts,
          last_error: before.last_error,
          lease_until: before.lease_until,
        },
      );
    });

    it('不在租约内的任务：complete / fail 都不生效且不改行', async () => {
      const engagementId = await newEngagement();
      const { job } = await enqueueJob(engagementId, { availableAt: past() });

      assert.equal(await queue.complete(job.id), false, '从未领取的任务不能被"完成"');
      assert.equal(await queue.fail(job.id, '不该生效'), null, '从未领取的任务不能被"失败"');

      const row = await readJob(job.id);
      assert.equal(row.status, 'pending');
      assert.equal(row.attempts, 0);
      assert.equal(row.last_error, null);
    });

    it('超长错误文本被截断：保头并标注截断，不做无界写入', async () => {
      const engagementId = await newEngagement();
      const { job } = await enqueueJob(engagementId, { availableAt: past() });
      onlyRow(await queue.claim({ engagementId, limit: 1 }));
      const huge = 'x'.repeat(OUTBOX_MAX_ERROR_LENGTH * 2);

      const settled = await queue.fail(job.id, huge);
      assert.ok(settled !== null);
      const row = await readJob(job.id);
      const stored = row.last_error;
      assert.ok(stored !== null);
      assert.ok(
        stored.startsWith('x'.repeat(100)),
        '截断必须保留开头，否则诊断价值全丢失',
      );
      assert.ok(stored.includes('已截断'));
      assert.ok(stored.length < huge.length);
    });

    // ───────────── 启动重扫 ─────────────

    it('sweepExpired 把过期租约拉回 pending：可立即重领，未过期租约不动', async () => {
      const engagementId = await newEngagement();
      const stalled = await enqueueJob(engagementId, { availableAt: new Date(Date.now() - 20_000) });
      const live = await enqueueJob(engagementId, { availableAt: new Date(Date.now() - 10_000) });
      const firstClaim = onlyRow(await queue.claim({ engagementId, limit: 1 }));
      assert.equal(firstClaim.id, stalled.job.id, '先领到 available_at 更早的那条');
      onlyRow(await queue.claim({ engagementId, limit: 1 }));
      await expireLease(stalled.job.id, 5);

      const swept = await queue.sweepExpired({ engagementId, limit: 10 });
      assert.deepEqual(
        swept.map((job) => job.id),
        [stalled.job.id],
        '只有过期租约被重扫',
      );
      const row = await readJob(stalled.job.id);
      assert.equal(row.status, 'pending');
      assert.equal(row.lease_until, null);
      assert.equal(row.attempts, 1, '重扫不改写尝试次数（那是领取的职责）');
      const due = await pool.query<{ due: boolean }>(
        'select available_at <= now() as due from pentest.outbox_jobs where id = $1::bigint',
        [stalled.job.id],
      );
      assert.equal(
        onlyRow(due.rows).due,
        true,
        '退回后必须立即可领取（比较用数据库时钟，避免客户端时钟偏差）',
      );
      assert.equal((await readJob(live.job.id)).status, 'leased', '未过期租约不得被重扫');

      const reclaimed = onlyRow(await queue.claim({ engagementId, limit: 1 }));
      assert.equal(reclaimed.id, stalled.job.id, '退回的任务必须真的能再被领走');
      assert.equal(reclaimed.attempts, 2);
    });

    it('sweepExpired 区分两种退回：普通退回保留失败原因，达上限则归档为死信', async () => {
      // (a) 崩溃一次（队列上限 3，重扫时 attempts=2 < 3）：退回待办，且不动上一次的真实失败原因。
      const retryEngagement = await newEngagement();
      const retried = await enqueueJob(retryEngagement, { availableAt: past() });
      onlyRow(await queue.claim({ engagementId: retryEngagement, limit: 1 }));
      await queue.fail(retried.job.id, '嵌入提供方 503');
      await resetAvailableAt(retried.job.id);
      onlyRow(await queue.claim({ engagementId: retryEngagement, limit: 1 }));
      await expireLease(retried.job.id, 5);

      const sweptRetry = onlyRow(await queue.sweepExpired({ engagementId: retryEngagement }));
      assert.equal(sweptRetry.status, 'pending');
      assert.equal((await readJob(retried.job.id)).last_error, '嵌入提供方 503');

      // (b) 尝试次数已达上限却仍然崩溃：必须归档，否则"一领到就崩"的任务会被无限重领。
      const cappedQueue = new PgOutboxQueue(pool as unknown as DbClient, { maxAttempts: 2 });
      const crashEngagement = await newEngagement();
      const crashed = await enqueueJob(crashEngagement, { availableAt: past() });
      onlyRow(await cappedQueue.claim({ engagementId: crashEngagement, limit: 1 })); // attempts=1
      await expireLease(crashed.job.id, 5); // 第一次崩溃：没有结算，只有租约到期
      onlyRow(await cappedQueue.claim({ engagementId: crashEngagement, limit: 1 })); // attempts=2
      await expireLease(crashed.job.id, 5); // 第二次崩溃

      const sweptCrash = onlyRow(await cappedQueue.sweepExpired({ engagementId: crashEngagement }));
      assert.equal(sweptCrash.status, 'dead', '重试上限必须在崩溃路径上同样生效');
      const row = await readJob(crashed.job.id);
      assert.equal(row.status, 'dead');
      assert.equal(row.attempts, 2);
      assert.equal(row.last_error, LEASE_EXPIRED_ERROR);
      assert.equal(
        (await cappedQueue.claim({ engagementId: crashEngagement, limit: 5 })).length,
        0,
        '归档的任务不再被领取',
      );
    });

    it('sweepExpired 受批量上限约束：一次扫不完就分次扫', async () => {
      const engagementId = await newEngagement();
      const ids: string[] = [];
      for (let index = 0; index < 3; index += 1) {
        const { job } = await enqueueJob(engagementId, { availableAt: past() });
        ids.push(job.id);
      }
      await queue.claim({ engagementId, limit: 10 });
      for (const id of ids) await expireLease(id, 5);

      const firstBatch = await queue.sweepExpired({ engagementId, limit: 2 });
      assert.equal(firstBatch.length, 2);
      const secondBatch = await queue.sweepExpired({ engagementId, limit: 2 });
      assert.equal(secondBatch.length, 1);
      assert.deepEqual(
        new Set([...firstBatch, ...secondBatch].map((job) => job.id)),
        new Set(ids),
      );
      assert.equal((await queue.sweepExpired({ engagementId, limit: 2 })).length, 0);
    });

    it('sweepExpired 可用注入的基准时间重扫：不依赖数据库时钟也能判定过期', async () => {
      const engagementId = await newEngagement();
      const { job } = await enqueueJob(engagementId, { availableAt: past() });
      onlyRow(await queue.claim({ engagementId, limit: 1 }));

      const future = new Date(Date.now() + 120_000);
      const swept = await queue.sweepExpired({ engagementId, now: future });
      assert.deepEqual(
        swept.map((entry) => entry.id),
        [job.id],
        '基准时间推到租约之后，未过期的租约也应被判定为过期',
      );
      assert.equal((await readJob(job.id)).status, 'pending');
    });

    // ───────────── 诊断 ─────────────

    it('stats 全链路计数：待办 / 租约中 / 完成 / 死信与滞后状态', async () => {
      const engagementId = await newEngagement();

      // 顺序构造四种状态：每步只留下一条可领取的任务。
      const done = await enqueueJob(engagementId, { availableAt: past() });
      onlyRow(await queue.claim({ engagementId, limit: 1 }));
      await queue.complete(done.job.id);

      const dead = await enqueueJob(engagementId, { availableAt: past() });
      await failUntilDead(queue, engagementId, dead.job.id);

      await enqueueJob(engagementId, { availableAt: past() });
      onlyRow(await queue.claim({ engagementId, limit: 1 }));

      const pendingOlder = await enqueueJob(engagementId, {
        availableAt: new Date(Date.now() - 3_600_000),
      });
      await enqueueJob(engagementId, { availableAt: new Date(Date.now() - 1_800_000) });

      const stats = await queue.stats(engagementId);
      assert.deepEqual(stats.counts, { pending: 2, leased: 1, done: 1, dead: 1 });
      assert.equal(stats.unfinished, 3, '未完成量 = pending + leased');
      assert.equal(stats.engagementId, engagementId);
      assert.equal(stats.state, 'failed', '有死信时展示为失败（§15.5）');
      const oldest = stats.oldestPendingAt;
      assert.ok(oldest !== null, '有待办任务时必须给出滞后起点');
      assert.ok(
        Math.abs(oldest.getTime() - pendingOlder.job.availableAt.getTime()) < 1000,
        '滞后起点取最早的可领取时间',
      );
    });

    it('stats 空队列显示就绪，且只统计本 engagement', async () => {
      const empty = await newEngagement();
      const other = await newEngagement();
      await enqueueJob(other, { availableAt: past() });

      const stats = await queue.stats(empty);
      assert.deepEqual(stats.counts, { pending: 0, leased: 0, done: 0, dead: 0 });
      assert.equal(stats.unfinished, 0);
      assert.equal(stats.oldestPendingAt, null);
      assert.equal(stats.state, 'ready');
    });
  },
);
