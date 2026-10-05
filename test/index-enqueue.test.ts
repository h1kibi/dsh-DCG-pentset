/**
 * 索引入队适配器测试。
 *
 * **唯一重要的性质是原子性**：账本追加与索引任务入队要么都提交、要么都回滚。
 * 若分两次提交，进程在中间崩溃会留下「事件已落库但永远不被索引」的缺口——
 * 那种缺口不报错，只是检索面少了内容，只能靠比对水位发现。
 *
 * 因此这里用真实事务验证：在未提交的事务里入队，回滚后任务必须消失；
 * 提交后必须存在。
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';

import { cleanupEngagements } from './helpers/cleanup.ts';
import type { PoolClient } from 'pg';

import { LedgerIndexEnqueue, pendingJobCountOnTx } from '../src/memory/index-enqueue.ts';
import { PgOutboxQueue, INDEX_EVENT_JOB } from '../src/memory/outbox.ts';
import { MemoryLedger } from '../src/memory/ledger.ts';
import type { DbClient } from '../src/db/port.ts';

const DATABASE_URL = process.env.PENTEST_DATABASE_URL;

/** 把一条已连接的 client 适配成 DbClient。 */
function clientAsDb(client: PoolClient): DbClient {
  return {
    async query<Row = Record<string, unknown>>(sql: string, params?: readonly unknown[]) {
      const r = await client.query(sql, params as unknown[] | undefined);
      return { rows: r.rows as Row[], rowCount: r.rowCount };
    },
  };
}

describe('索引入队适配器（真实 PostgreSQL）', { skip: DATABASE_URL === undefined ? '未设置 PENTEST_DATABASE_URL' : false }, () => {
  let pool: Pool;
  let engagementId: string;
  /** 本文件建的全部 engagement，供共享夹具在 after 里清理。 */
  const madeEngagements: string[] = [];

  before(async () => {
    pool = new Pool({ connectionString: DATABASE_URL, max: 6 });
    engagementId = await newEngagement();
  });

  /**
   * 建一个全新的 engagement 并返回其标识。
   *
   * 每个测试用独立 engagement 而不是共用一个：`pendingJobCountOnTx` 这类断言
   * 数的是「该 engagement 下的任务总数」，共享会让前一个测试的残留影响后一个。
   * 这类跨测试污染在任务表上尤其隐蔽——它表现为断言时对时错。
   */
  async function newEngagement(): Promise<string> {
    const id = randomUUID();
    // 单点追踪：所有调用者自动被记录，不会漏（在调用点逐个 push 会漏掉后加的那些）
    madeEngagements.push(id);
    await pool.query(
      `insert into pentest.engagements
         (id, tenant_id, name, status, current_status, target_snapshot, scope_snapshot, roe_snapshot, policy_snapshot, config_snapshot, created_by)
       values ($1::uuid, 't', 'enqueue-test', 'running', 'ready', '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, 'tester')`,
      [id],
    );
    return id;
  }

  after(async () => {
    if (pool === undefined) return;
    // 用共享清理夹具：它覆盖**全部**引用 engagements 的表（含 session_leases
    // 与 ledger_anchors），并以 `session_replication_role = 'replica'` 绕过
    // 触发器与外键。此前这里手写只删 3 张表，漏掉的表让清理静默失败、逐次运行累积残留。
    await cleanupEngagements(pool, madeEngagements);
    await pool.end();
  });

  /** 造一条事件标识（不入账本，仅用于入队测试）。 */
  async function insertEvent(seq: number): Promise<string> {
    const r = await pool.query<{ event_id: string }>(
      `insert into pentest.context_events
         (engagement_id, source_system, source_id, source_seq, event_type, schema_version,
          occurred_at, chain_seq, payload_json, raw_payload_zstd, classification, trust_level, event_hash)
       values ($1::uuid, 'test', $2, $3, 'human.input', 1, now(), $3, '{"text":"x"}'::jsonb, '\\x00', 'engagement', 'human_decision', decode(repeat('ab', 32), 'hex'))
       returning event_id`,
      [engagementId, `enq-${seq}-${randomUUID()}`, seq],
    );
    return r.rows[0]!.event_id;
  }

  test('回滚后索引任务消失：入队与账本同事务', async () => {
    const eventId = await insertEvent(100);
    const client = await pool.connect();
    const tx = clientAsDb(client);
    const enqueue = new LedgerIndexEnqueue(new PgOutboxQueue(tx));

    await tx.query('begin');
    await enqueue.enqueueInTransaction(tx, { engagementId, eventIds: [eventId] });
    // 同事务内可见
    assert.equal(await pendingJobCountOnTx(tx, engagementId), 1, '未提交时任务在本事务内应可见');
    await tx.query('rollback');

    // 回滚后：跨事务不可见
    const after = await pool.query<{ n: string }>(
      `select count(*)::text as n from pentest.outbox_jobs where engagement_id = $1::uuid`,
      [engagementId],
    );
    assert.equal(after.rows[0]!.n, '0', '回滚后不得残留任务——这正是原子性的含义');
    client.release();
  });

  test('提交后索引任务存在且类型正确', async () => {
    const eventId = await insertEvent(101);
    const client = await pool.connect();
    const tx = clientAsDb(client);
    const enqueue = new LedgerIndexEnqueue(new PgOutboxQueue(tx));

    await tx.query('begin');
    await enqueue.enqueueInTransaction(tx, { engagementId, eventIds: [eventId] });
    await tx.query('commit');
    client.release();

    const row = await pool.query<{ job_type: string; entity_id: string; status: string; attempts: number }>(
      `select job_type, entity_id, status, attempts from pentest.outbox_jobs where engagement_id = $1::uuid and entity_id = $2::uuid`,
      [engagementId, eventId],
    );
    assert.equal(row.rows[0]!.job_type, INDEX_EVENT_JOB);
    assert.equal(row.rows[0]!.entity_id, eventId);
    assert.equal(row.rows[0]!.status, 'pending');
    assert.equal(row.rows[0]!.attempts, 0, '入队时 attempts 应为 0，领取时才递增');
  });

  test('批量入队：一个事件一个任务，幂等键互不相同', async () => {
    const ids = await Promise.all([insertEvent(102), insertEvent(103), insertEvent(104)]);
    const client = await pool.connect();
    const tx = clientAsDb(client);
    const enqueue = new LedgerIndexEnqueue(new PgOutboxQueue(tx));

    await tx.query('begin');
    await enqueue.enqueueInTransaction(tx, { engagementId, eventIds: ids });
    await tx.query('commit');
    client.release();

    const rows = await pool.query<{ n: string }>(
      `select count(*)::text as n from pentest.outbox_jobs
        where engagement_id = $1::uuid and entity_id = any($2::uuid[])`,
      [engagementId, ids],
    );
    assert.equal(rows.rows[0]!.n, '3', '每个事件各一个任务（失败隔离粒度）');

    const keys = await pool.query<{ n: string }>(
      `select count(distinct idempotency_key)::text as n from pentest.outbox_jobs
        where engagement_id = $1::uuid and entity_id = any($2::uuid[])`,
      [engagementId, ids],
    );
    assert.equal(keys.rows[0]!.n, '3', '幂等键必须互不相同，否则只有一条能入队');
  });

  test('重复入队同一事件：幂等，不产生第二个任务', async () => {
    const eventId = await insertEvent(105);
    const client = await pool.connect();
    const tx = clientAsDb(client);
    const enqueue = new LedgerIndexEnqueue(new PgOutboxQueue(tx));

    await tx.query('begin');
    await enqueue.enqueueInTransaction(tx, { engagementId, eventIds: [eventId] });
    await enqueue.enqueueInTransaction(tx, { engagementId, eventIds: [eventId] });
    await tx.query('commit');
    client.release();

    const rows = await pool.query<{ n: string }>(
      `select count(*)::text as n from pentest.outbox_jobs where entity_id = $1::uuid`,
      [eventId],
    );
    assert.equal(rows.rows[0]!.n, '1', '重放同一事件不得重复建任务');
  });

  test('空事件列表：不做任何事，不报错', async () => {
    const fresh = await newEngagement();
    const client = await pool.connect();
    const tx = clientAsDb(client);
    const enqueue = new LedgerIndexEnqueue(new PgOutboxQueue(tx));
    await tx.query('begin');
    await enqueue.enqueueInTransaction(tx, { engagementId: fresh, eventIds: [] });
    assert.equal(await pendingJobCountOnTx(tx, fresh), 0);
    await tx.query('commit');
    client.release();
  });

  test('端到端：账本追加自动入队（appendBatch 触发 enqueueInTransaction）', async () => {
    // 这是最关键的一条：账本内部真的调用了入队端口。
    // 若忘了接线，事件会落库而任务不产生——检索面静默缺失内容。
    const fresh = await newEngagement();
    const client = await pool.connect();
    const tx = clientAsDb(client);
    const queue = new PgOutboxQueue(tx);
    const ledger = new MemoryLedger({
      db: tx,
      txDb: tx,
      secret: 'enqueue-test-secret-32-bytes-minimum',
      indexOutbox: new LedgerIndexEnqueue(queue),
    });

    const result = await ledger.appendEvent({
      engagementId: fresh,
      workerSessionId: null,
      eventType: 'human.input',
      sourceSystem: 'test',
      sourceId: `e2e-${randomUUID()}`,
      sourceSeq: 1,
      occurredAt: new Date(),
      payload: { text: '端到端入队验证' },
      rawPayload: new TextEncoder().encode('{}'),
      classification: 'engagement',
      trustLevel: 'human_decision',
    });
    client.release();

    const job = await pool.query<{ job_type: string; entity_id: string }>(
      `select job_type, entity_id from pentest.outbox_jobs where entity_id = $1::uuid`,
      [result.eventId],
    );
    assert.equal(job.rows.length, 1, '账本追加必须自动产生索引任务');
    assert.equal(job.rows[0]!.job_type, INDEX_EVENT_JOB);
  });

  test('未接入队端口时：账本仍可工作，只是不产生索引任务（明确降级）', async () => {
    const fresh = await newEngagement();
    const client = await pool.connect();
    const tx = clientAsDb(client);
    const ledger = new MemoryLedger({
      db: tx,
      txDb: tx,
      secret: 'enqueue-test-secret-32-bytes-minimum',
      // 有意不传 indexOutbox
    });

    const result = await ledger.appendEvent({
      engagementId: fresh,
      workerSessionId: null,
      eventType: 'human.input',
      sourceSystem: 'test',
      sourceId: `solo-${randomUUID()}`,
      sourceSeq: 1,
      occurredAt: new Date(),
      payload: { text: '无入队端口' },
      rawPayload: new TextEncoder().encode('{}'),
      classification: 'engagement',
      trustLevel: 'human_decision',
    });
    client.release();

    const job = await pool.query<{ n: string }>(
      `select count(*)::text as n from pentest.outbox_jobs where entity_id = $1::uuid`,
      [result.eventId],
    );
    assert.equal(job.rows[0]!.n, '0', '未接入队端口时不产生任务——这是明确的降级，不是静默失败');
  });

  test('账本重放已有事件：不重复入队', async () => {
    const fresh = await newEngagement();
    const sourceId = `replay-${randomUUID()}`;
    const client = await pool.connect();
    const tx = clientAsDb(client);
    const ledger = new MemoryLedger({
      db: tx,
      txDb: tx,
      secret: 'enqueue-test-secret-32-bytes-minimum',
      indexOutbox: new LedgerIndexEnqueue(new PgOutboxQueue(tx)),
    });

    const input = {
      engagementId: fresh,
      workerSessionId: null,
      eventType: 'human.input' as const,
      sourceSystem: 'test',
      sourceId,
      sourceSeq: 1,
      occurredAt: new Date(),
      payload: { text: '重放' },
      rawPayload: new TextEncoder().encode('{}'),
      classification: 'engagement' as const,
      trustLevel: 'human_decision' as const,
    };
    const first = await ledger.appendEvent(input);
    await ledger.appendEvent(input); // 同一幂等键 → 命中重放
    client.release();

    const job = await pool.query<{ n: string }>(
      `select count(*)::text as n from pentest.outbox_jobs where entity_id = $1::uuid`,
      [first.eventId],
    );
    assert.equal(job.rows[0]!.n, '1', '重放不得重复入队——只追踪真正新插入的事件');
  });
});
