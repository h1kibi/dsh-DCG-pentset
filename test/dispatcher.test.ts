/**
 * 索引调度器测试。
 *
 * 最重要的两条是**失败可见性**与**端到端链路**：
 *   - 未实现的任务类型不得被静默完成（否则「有一类任务从未被处理」永远查不出来）
 *   - `appendEvent → 入队 → 调度 → 分块落库` 这条链必须真的通
 *     （此前每一段都有测试，但没有任何测试走过整条链）
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';

import {
  IndexDispatcher,
  INDEX_EVENT_JOB,
  INDEX_MEMORY_ITEM_JOB,
  REINDEX_ENGAGEMENT_JOB,
} from '../src/memory/dispatcher.ts';
import { PgOutboxQueue } from '../src/memory/outbox.ts';
import { MemoryIndexer } from '../src/memory/indexer.ts';
import { MemoryLedger } from '../src/memory/ledger.ts';
import { LedgerIndexEnqueue } from '../src/memory/index-enqueue.ts';
import type { DbClient } from '../src/memory/ledger.ts';
import type { EmbeddingProvider } from '../src/memory/embedding.ts';

const DATABASE_URL = process.env.PENTEST_DATABASE_URL;

const fakeEmbeddings: EmbeddingProvider = {
  model: 'fake-model',
  dimensions: 1024,
  revision: 'rev-disp-1',
  async embed(texts: readonly string[]) {
    return texts.map(() => Array.from({ length: 1024 }, () => 0.02));
  },
};

describe('索引调度器（真实 PostgreSQL）', { skip: DATABASE_URL === undefined ? '未设置 PENTEST_DATABASE_URL' : false }, () => {
  let pool: Pool;
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
    await cleanup();
    await pool.end();
  });

  /** 建 engagement + 会话，返回两者标识。 */
  async function seed(): Promise<{ engagementId: string; workerSessionId: string }> {
    const engagementId = randomUUID();
    const workerSessionId = randomUUID();
    await pool.query(
      `insert into pentest.engagements
         (id, tenant_id, name, status, current_status, target_snapshot, scope_snapshot, roe_snapshot, policy_snapshot, config_snapshot, created_by)
       values ($1::uuid, 't', 'dispatcher-test', 'running', 'worker_running', '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, 'tester')`,
      [engagementId],
    );
    await pool.query(
      `insert into pentest.worker_sessions
         (id, engagement_id, dsh_session_id, phase, profile_id, profile_revision, attempt, iteration, scope_version, task_prompt, tool_filter, skill_ids, model_route, status)
       values ($1::uuid, $2::uuid, $3, 'intelligence-gathering', 'p', 'r1', 1, 1, 0, 'tp', '{}'::jsonb, '[]'::jsonb, '{}'::jsonb, 'active')`,
      [workerSessionId, engagementId, `dsh-disp-${randomUUID()}`],
    );
    // 存活态会话签**有效**租约。
    //
    // 两个理由：
    //   1. 数据真实：§10.6 里一个正在工作的会话本就持有租约；「active 但无租约」
    //      是 §15.2 定义的**孤儿**，用它当种子是在测一个不该存在的场景。
    //   2. 并行隔离：`compose.test.ts` 里有个用例会 `apply()` 并启动**全库对账**
    //      （`StartupRecovery.recoverAll()` 是产品行为——单实例启动对账整库）。
    //      无租约的存活会话会被它判为孤儿、标记 failed、并写审计事件；那会让
    //      本文件的会话在断言前变成终态。
    await pool.query(
      `insert into pentest.session_leases (engagement_id, worker_session_id, generation, expires_at)
       values ($1::uuid, $2::uuid, 1, now() + interval '1 hour')`,
      [engagementId, workerSessionId],
    );

    madeEngagements.push(engagementId);
    return { engagementId, workerSessionId };
  }

  async function cleanup(): Promise<void> {
    if (madeEngagements.length === 0) return;
    // 用 `session_replication_role = 'replica'` 一次性绕过**用户触发器与 FK 触发器**。
    //
    // 为什么不用「临时 disable trigger + 按外键倒序删」：
    //   1. `context_events` / `ledger_anchors` 只允许追加（002 的触发器），要删必须先停触发器；
    //   2. 更麻烦的是外键——`session_leases`、`scope_versions`、`assets` 等都引用
    //      `engagements`，漏掉任何一张，`delete from engagements` 就失败。用 replica
    //      角色后这些顺序问题全部消失。
    //
    // **必须用同一条连接**：`session_replication_role` 是会话级设置，用 `pool.query`
    // 设只影响当时借出的那条连接，而删除可能落在另一条上——那会导致「设置看似生效
    // 但删除仍被 FK 挡住」，且失败被下面的 catch 吞掉，表现为静默残留。
    const client = await pool.connect();
    try {
      await client.query("SET session_replication_role = 'replica'");
      for (const id of madeEngagements) {
        for (const sql of [
          'delete from pentest.outbox_jobs where engagement_id = $1::uuid',
          'delete from pentest.memory_chunks where engagement_id = $1::uuid',
          'delete from pentest.index_watermarks where engagement_id = $1::uuid',
          'delete from pentest.ledger_anchors where engagement_id = $1::uuid',
          'delete from pentest.context_events where engagement_id = $1::uuid',
          // session_leases 引用 engagements：漏了这一句，engagements 永远删不掉
          'delete from pentest.session_leases where engagement_id = $1::uuid',
          'delete from pentest.worker_sessions where engagement_id = $1::uuid',
          // policy_versions 也引用 engagements：先删子表，engagements 才删得掉。
          'delete from pentest.policy_versions where engagement_id = $1::uuid',
          'delete from pentest.engagements where id = $1::uuid',
        ]) {
          await client.query(sql, [id]);
        }
      }
    } finally {
      // 恢复必须执行且不可吞：否则这条连接后续的所有写入都不再触发约束
      await client.query("SET session_replication_role = 'origin'");
      client.release();
    }
    madeEngagements.length = 0;
  }

  /** 组装完整的调度链：outbox + 索引器 + 调度器。 */
  function build(embeddings: EmbeddingProvider | undefined = fakeEmbeddings, onJobFailure?: (j: unknown, e: unknown) => void) {
    const d = db();
    const outbox = new PgOutboxQueue(d);
    const indexer = new MemoryIndexer({
      db: d,
      txDb: d,
      ...(embeddings === undefined ? {} : { embeddings }),
    });
    const dispatcher = new IndexDispatcher({
      outbox,
      indexer,
      db: d,
      ...(onJobFailure === undefined ? {} : { onJobFailure }),
    });
    return { outbox, indexer, dispatcher };
  }

  async function textOf(engagementId: string): Promise<string[]> {
    const r = await pool.query<{ content: string }>(
      `select content from pentest.memory_chunks where engagement_id = $1::uuid order by created_at`,
      [engagementId],
    );
    return r.rows.map((x) => x.content);
  }

  /**
   * 轮询到条件成立（上限 5s）。
   *
   * 存在的理由：本套件与「另一个可能也在跑调度器的进程」共享 PG（RUNBOOK:754 要求跑前停服务，
   * 但测试不该因为对方还在收尾就变红）。停服务时条件第一次就成立，零等待；
   * 有并发者时它只是把「谁领的」这个无关变量排除掉。
   */
  async function waitFor(condition: () => Promise<boolean>, label: string): Promise<void> {
    const deadline = Date.now() + 5000;
    for (;;) {
      if (await condition()) return;
      if (Date.now() > deadline) throw new Error(`等待超时：${label}`);
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }

  // ───────────────── 端到端链路 ─────────────────

  test('端到端：账本追加 → 自动入队 → 调度处理 → 分块落库', async () => {
    const { engagementId } = await seed();
    const d = db();
    const outbox = new PgOutboxQueue(d);
    const ledger = new MemoryLedger({
      db: d,
      txDb: d,
      secret: 'dispatcher-test-secret-32-bytes-minimum',
      indexOutbox: new LedgerIndexEnqueue(outbox),
    });
    const indexer = new MemoryIndexer({ db: d, txDb: d, embeddings: fakeEmbeddings });
    const dispatcher = new IndexDispatcher({ outbox, indexer, db: d });

    // 1) 账本追加（应自动入队）
    await ledger.appendEvent({
      engagementId,
      workerSessionId: null,
      eventType: 'human.input',
      sourceSystem: 'dispatcher-test',
      sourceId: `e2e-${randomUUID()}`,
      sourceSeq: 1,
      occurredAt: new Date(),
      payload: { text: '端到端链路验证：目标段已授权' },
      rawPayload: new TextEncoder().encode('{}'),
      classification: 'engagement',
      trustLevel: 'human_decision',
    });

    // 2) 队列里应有一条待办
    const stats = await outbox.stats(engagementId);
    assert.equal(stats.counts.pending, 1, '账本追加必须产生一条待办索引任务');

    // 3) 调度处理
    const batch = await dispatcher.dispatchBatch(engagementId);
    assert.equal(batch.claimed, 1);
    assert.equal(batch.completed, 1, '任务应被完成');
    assert.equal(batch.failed, 0);
    assert.equal(batch.chunksInserted, 1);

    // 4) 分块真的落库且可检索
    const contents = await textOf(engagementId);
    assert.equal(contents.length, 1);
    assert.match(contents[0]!, /目标段已授权/);

    const idx = await pool.query<{ has_vector: boolean; has_fts: boolean }>(
      `select (embedding is not null) as has_vector, (search_vector is not null) as has_fts
         from pentest.memory_chunks where engagement_id = $1::uuid`,
      [engagementId],
    );
    assert.equal(idx.rows[0]!.has_vector, true);
    assert.equal(idx.rows[0]!.has_fts, true);

    // 5) 队列已空
    const after = await outbox.stats(engagementId);
    assert.equal(after.counts.pending, 0);
    assert.equal(after.counts.done, 1);
  });

  // ───────────────── 失败可见性 ─────────────────

  test('未实现的任务类型：走失败路径，不被静默完成（否则永远查不出有一类任务从未被处理）', async () => {
    const { engagementId, workerSessionId } = await seed();
    const failures: unknown[] = [];
    const { outbox, dispatcher } = build(fakeEmbeddings, (_j, e) => failures.push(e));

    // 手工入队一个未实现类型的任务
    await outbox.enqueue({
      engagementId,
      jobType: INDEX_MEMORY_ITEM_JOB,
      entityId: randomUUID(),
    });
    void workerSessionId;

    const batch = await dispatcher.dispatchBatch(engagementId);
    assert.equal(batch.completed, 0, '未实现类型不得被判为完成');
    assert.equal(batch.failed, 1);
    assert.deepEqual(batch.unsupportedTypes, [INDEX_MEMORY_ITEM_JOB]);

    const stats = await outbox.stats(engagementId);
    assert.equal(stats.counts.done, 0);
    assert.equal(stats.counts.pending, 1, '应回到 pending 等待重试');
    assert.ok(failures.length >= 1, '原始错误必须交给回调，不能吞');

    const job = await pool.query<{ last_error: string }>(
      `select last_error from pentest.outbox_jobs where engagement_id = $1::uuid`,
      [engagementId],
    );
    assert.match(String(job.rows[0]!.last_error), /尚未实现|不支持/);
  });

  test('未知任务类型：同样走失败路径', async () => {
    const { engagementId } = await seed();
    const { outbox, dispatcher } = build();
    // 直接插一行未知类型（绕过 enqueue 的取值表校验，模拟更高版本入队的任务）
    await pool.query(
      `insert into pentest.outbox_jobs (engagement_id, job_type, entity_id, idempotency_key, status)
       values ($1::uuid, 'future_job_type', $2::uuid, $3, 'pending')`,
      [engagementId, randomUUID(), `future-${randomUUID()}`],
    );
    const batch = await dispatcher.dispatchBatch(engagementId);
    assert.equal(batch.completed, 0);
    assert.equal(batch.failed, 1);
    assert.deepEqual(batch.unsupportedTypes, ['future_job_type']);
  });

  test('索引失败：任务不被完成，错误落库，可重试', async () => {
    const { engagementId } = await seed();
    const d = db();
    const outbox = new PgOutboxQueue(d);
    // 嵌入提供方失败 → 索引必然中途抛错
    const failing: EmbeddingProvider = {
      model: 'failing',
      dimensions: 1024,
      revision: 'rev-fail',
      async embed() { throw new Error('嵌入服务不可达'); },
    };
    const indexer = new MemoryIndexer({ db: d, txDb: d, embeddings: failing });
    const dispatcher = new IndexDispatcher({ outbox, indexer, db: d });

    // 造事件 + 入队
    const ev = await pool.query<{ event_id: string }>(
      `insert into pentest.context_events
         (engagement_id, source_system, source_id, source_seq, event_type, schema_version,
          occurred_at, chain_seq, payload_json, raw_payload_zstd, classification, trust_level, event_hash)
       values ($1::uuid, 'test', $2, 1, 'human.input', 1, now(), 1, '{"text":"会失败"}'::jsonb, '\\x00', 'engagement', 'human_decision', decode(repeat('ef', 32), 'hex'))
       returning event_id`,
      [engagementId, `fail-${randomUUID()}`],
    );
    await outbox.enqueue({ engagementId, jobType: INDEX_EVENT_JOB, entityId: ev.rows[0]!.event_id });

    const batch = await dispatcher.dispatchBatch(engagementId);
    assert.equal(batch.completed, 0);
    assert.equal(batch.failed, 1);

    const row = await pool.query<{ status: string; attempts: number; last_error: string | null }>(
      `select status, attempts, last_error from pentest.outbox_jobs where engagement_id = $1::uuid`,
      [engagementId],
    );
    assert.equal(row.rows[0]!.attempts, 1);
    assert.equal(row.rows[0]!.status, 'pending', '未到上限应回到 pending 以便重试');
    assert.match(String(row.rows[0]!.last_error), /嵌入服务不可达/);

    const chunks = await pool.query<{ n: string }>(
      `select count(*)::text as n from pentest.memory_chunks where engagement_id = $1::uuid`,
      [engagementId],
    );
    assert.equal(chunks.rows[0]!.n, '0', '失败时不得留下半个分块');
  });

  test('事件不属于该 engagement：拒绝索引并让任务失败（不静默完成）', async () => {
    const a = await seed();
    const b = await seed();
    const { outbox, dispatcher } = build();

    // 把 B 的事件入队到 A 的名下（模拟数据错乱/越权）
    const ev = await pool.query<{ event_id: string }>(
      `insert into pentest.context_events
         (engagement_id, source_system, source_id, source_seq, event_type, schema_version,
          occurred_at, chain_seq, payload_json, raw_payload_zstd, classification, trust_level, event_hash)
       values ($1::uuid, 'test', $2, 1, 'human.input', 1, now(), 1, '{"text":"别人的事件"}'::jsonb, '\\x00', 'engagement', 'human_decision', decode(repeat('12', 32), 'hex'))
       returning event_id`,
      [b.engagementId, `cross-${randomUUID()}`],
    );
    await outbox.enqueue({ engagementId: a.engagementId, jobType: INDEX_EVENT_JOB, entityId: ev.rows[0]!.event_id });

    const batch = await dispatcher.dispatchBatch(a.engagementId);
    assert.equal(batch.completed, 0, '跨 engagement 的事件不得被索引');
    assert.equal(batch.failed, 1);

    const chunks = await pool.query<{ n: string }>(
      `select count(*)::text as n from pentest.memory_chunks where engagement_id = $1::uuid`,
      [a.engagementId],
    );
    assert.equal(chunks.rows[0]!.n, '0');
  });

  // ───────────────── 排空与发现 ─────────────────

  test('drain：反复处理直到队列为空', async () => {
    const { engagementId } = await seed();
    const d = db();
    const outbox = new PgOutboxQueue(d);
    const indexer = new MemoryIndexer({ db: d, txDb: d, embeddings: fakeEmbeddings });
    const dispatcher = new IndexDispatcher({ outbox, indexer, db: d });

    // 造 5 个事件与任务
    for (let i = 1; i <= 5; i += 1) {
      const ev = await pool.query<{ event_id: string }>(
        `insert into pentest.context_events
           (engagement_id, source_system, source_id, source_seq, event_type, schema_version,
            occurred_at, chain_seq, payload_json, raw_payload_zstd, classification, trust_level, event_hash)
         values ($1::uuid, 'test', $2, $3, 'human.input', 1, now(), $3, $4::jsonb, '\\x00', 'engagement', 'human_decision', decode(repeat('34', 32), 'hex'))
         returning event_id`,
        [engagementId, `drain-${i}-${randomUUID()}`, i, JSON.stringify({ text: `第 ${i} 条` })],
      );
      await outbox.enqueue({ engagementId, jobType: INDEX_EVENT_JOB, entityId: ev.rows[0]!.event_id });
    }

    // 每批 2 条 → 至少 3 批。
    //
    // **断言的是最终状态，不是「本次 drain 领了几个」**：本套件跑在共享 PG 上，
    // 常驻服务的调度器可能同时领走其中几个任务（RUNBOOK:754 因此要求跑测试前先停服务）。
    // 产品承诺是「任务最终都被处理、事件最终都落块」——那才是这里要钉的东西；
    // 断言「claimed === 5」会让一个正常的并发调度器把测试变红（实测：2 !== 5）。
    const result = await dispatcher.drain(engagementId, { limit: 2 });
    assert.equal(result.failed, 0);
    assert.equal(result.exhaustedBudget, false, '批次上限 20 远大于所需批次，不该报预算耗尽');

    await waitFor(async () => {
      const jobs = await pool.query<{ done: string; bad: string }>(
        `select count(*) filter (where status = 'done')::text as done,
                count(*) filter (where status in ('pending','dead'))::text as bad
           from pentest.outbox_jobs where engagement_id = $1::uuid`,
        [engagementId],
      );
      return (
        jobs.rows[0]?.done === '5' &&
        jobs.rows[0]?.bad === '0' &&
        (await textOf(engagementId)).length === 5
      );
    }, '五个索引任务最终完成、五个事件都落块、没有 pending/dead 遗留');
  });

  test('drain：批次数上限生效，且报告预算耗尽', async () => {
    const { engagementId } = await seed();
    const d = db();
    const outbox = new PgOutboxQueue(d);
    const indexer = new MemoryIndexer({ db: d, txDb: d, embeddings: fakeEmbeddings });
    const dispatcher = new IndexDispatcher({ outbox, indexer, db: d });

    for (let i = 1; i <= 4; i += 1) {
      const ev = await pool.query<{ event_id: string }>(
        `insert into pentest.context_events
           (engagement_id, source_system, source_id, source_seq, event_type, schema_version,
            occurred_at, chain_seq, payload_json, raw_payload_zstd, classification, trust_level, event_hash)
         values ($1::uuid, 'test', $2, $3, 'human.input', 1, now(), $3, $4::jsonb, '\\x00', 'engagement', 'human_decision', decode(repeat('56', 32), 'hex'))
         returning event_id`,
        [engagementId, `budget-${i}-${randomUUID()}`, i, JSON.stringify({ text: `第 ${i} 条` })],
      );
      await outbox.enqueue({ engagementId, jobType: INDEX_EVENT_JOB, entityId: ev.rows[0]!.event_id });
    }

    // 每批 1 条、最多 2 批 → 只处理 2 条
    const result = await dispatcher.drain(engagementId, { limit: 1, maxBatches: 2 });
    assert.equal(result.claimed, 2);
    assert.equal(result.exhaustedBudget, true, '还有待办即应报告预算耗尽，让调用方决定再排一轮');

    const stats = await outbox.stats(engagementId);
    assert.equal(stats.counts.pending, 2, '剩余任务留在队列里');
  });

  test('engagementsWithWork：发现有待办任务的 engagement，且忽略他人持有中的租约', async () => {
    const a = await seed();
    const b = await seed();
    const { outbox, dispatcher } = build();

    await outbox.enqueue({ engagementId: a.engagementId, jobType: INDEX_EVENT_JOB, entityId: randomUUID() });
    await outbox.enqueue({ engagementId: b.engagementId, jobType: INDEX_EVENT_JOB, entityId: randomUUID() });

    const found = await dispatcher.engagementsWithWork(200);
    assert.ok(found.includes(a.engagementId), '应发现 A');
    assert.ok(found.includes(b.engagementId), '应发现 B');
  });

  test('drainAll：对所有有待办的 engagement 各排空一轮', async () => {
    const a = await seed();
    const b = await seed();
    const d = db();
    const outbox = new PgOutboxQueue(d);
    const indexer = new MemoryIndexer({ db: d, txDb: d, embeddings: fakeEmbeddings });
    const dispatcher = new IndexDispatcher({ outbox, indexer, db: d });

    for (const { engagementId } of [a, b]) {
      const ev = await pool.query<{ event_id: string }>(
        `insert into pentest.context_events
           (engagement_id, source_system, source_id, source_seq, event_type, schema_version,
            occurred_at, chain_seq, payload_json, raw_payload_zstd, classification, trust_level, event_hash)
         values ($1::uuid, 'test', $2, 1, 'human.input', 1, now(), 1, '{"text":"多 engagement"}'::jsonb, '\\x00', 'engagement', 'human_decision', decode(repeat('78', 32), 'hex'))
         returning event_id`,
        [engagementId, `all-${randomUUID()}`],
      );
      await outbox.enqueue({ engagementId, jobType: INDEX_EVENT_JOB, entityId: ev.rows[0]!.event_id });
    }

    const results = await dispatcher.drainAll({ maxEngagements: 200 });
    const touched = results.filter((r) => r.engagementId === a.engagementId || r.engagementId === b.engagementId);
    assert.ok(touched.length >= 2, '两个 engagement 都应被处理');
    assert.ok(touched.every((r) => r.failed === 0));

    assert.equal((await textOf(a.engagementId)).length, 1);
    assert.equal((await textOf(b.engagementId)).length, 1);
  });

  // ───────────────── 重建 ─────────────────

  test('reindex_engagement：重置水位并按批推平，且**不删除已有分块**', async () => {
    const { engagementId } = await seed();
    const d = db();
    const outbox = new PgOutboxQueue(d);
    const indexer = new MemoryIndexer({ db: d, txDb: d, embeddings: fakeEmbeddings });
    const dispatcher = new IndexDispatcher({ outbox, indexer, db: d });

    // 造 3 个事件并索引
    for (let i = 1; i <= 3; i += 1) {
      const ev = await pool.query<{ event_id: string }>(
        `insert into pentest.context_events
           (engagement_id, source_system, source_id, source_seq, event_type, schema_version,
            occurred_at, chain_seq, payload_json, raw_payload_zstd, classification, trust_level, event_hash)
         values ($1::uuid, 'test', $2, $3, 'human.input', 1, now(), $3, $4::jsonb, '\\x00', 'engagement', 'human_decision', decode(repeat('9a', 32), 'hex'))
         returning event_id`,
        [engagementId, `reidx-${i}-${randomUUID()}`, i, JSON.stringify({ text: `重建第 ${i} 条` })],
      );
      await outbox.enqueue({ engagementId, jobType: INDEX_EVENT_JOB, entityId: ev.rows[0]!.event_id });
    }
    await dispatcher.drain(engagementId);
    const before = await textOf(engagementId);
    assert.equal(before.length, 3);

    // 入队重建任务
    await outbox.enqueue({ engagementId, jobType: REINDEX_ENGAGEMENT_JOB, entityId: engagementId, idempotencyKey: `reindex-${randomUUID()}` });
    const batch = await dispatcher.dispatchBatch(engagementId);
    assert.equal(batch.completed, 1, '重建任务应完成');

    // 分块仍在（重建不删除），且数量未翻倍（幂等命中跳过）
    const after = await textOf(engagementId);
    assert.equal(after.length, 3, '重建期间不得删除已有分块，也不得重复插入');
    assert.deepEqual([...after].sort(), [...before].sort());
  });

  test('重建后水位推进到账本头部', async () => {
    const { engagementId } = await seed();
    const d = db();
    const outbox = new PgOutboxQueue(d);
    const indexer = new MemoryIndexer({ db: d, txDb: d, embeddings: fakeEmbeddings });
    const dispatcher = new IndexDispatcher({ outbox, indexer, db: d });

    for (let i = 1; i <= 2; i += 1) {
      await pool.query(
        `insert into pentest.context_events
           (engagement_id, source_system, source_id, source_seq, event_type, schema_version,
            occurred_at, chain_seq, payload_json, raw_payload_zstd, classification, trust_level, event_hash)
         values ($1::uuid, 'test', $2, $3, 'human.input', 1, now(), $3, '{"text":"水位"}'::jsonb, '\\x00', 'engagement', 'human_decision', decode(repeat('bc', 32), 'hex'))`,
        [engagementId, `wm-${i}-${randomUUID()}`, i],
      );
    }
    await outbox.enqueue({ engagementId, jobType: REINDEX_ENGAGEMENT_JOB, entityId: engagementId, idempotencyKey: `reindex-${randomUUID()}` });
    await dispatcher.dispatchBatch(engagementId);

    const wm = await indexer.watermark(engagementId);
    assert.equal(wm.lastChainSeq, 2, '重建应把水位推到账本头部');
    assert.equal(wm.lagEvents, 0);
    assert.equal(wm.status, 'ready');
  });
});
