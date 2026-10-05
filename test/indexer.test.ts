/**
 * 索引器测试。
 *
 * 重点锁定四条纪律（不是「函数返回什么」）：
 *   1. **幂等**：重跑不产生重复分块，崩溃后重扫安全
 *   2. **非暂定分块必须有嵌入版本**（DDL 级约束）
 *   3. **暂定分块不进索引**：无向量、无全文索引，且结算后被标记取代
 *   4. **嵌入失败即抛**：不返回零向量、不静默跳过
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';

import {
  MemoryIndexer,
  toVectorLiteral,
  CHUNK_VECTOR_DIMENSIONS,
} from '../src/memory/indexer.ts';
import type { DbClient } from '../src/memory/ledger.ts';
import type { EmbeddingProvider } from '../src/memory/embedding.ts';
import type { ChunkSourceEvent } from '../src/memory/chunks.ts';

const DATABASE_URL = process.env.PENTEST_DATABASE_URL;

// ───────────────────────────── 共享库清理夹具 ─────────────────────────────
//
// 这些集成用例跑在**共享**数据库上，且与兄弟测试文件并行。compose.test.ts 里的 `apply()`
// 会触发 `StartupRecovery.recoverAll()`——对账是**全库扫描**，会把本文件刚建、尚未心跳的
// 会话判为「无主」，并为它补写审计行（context_events / ledger_anchors / outbox_jobs）。
// 这些行通过外键把 worker_sessions 钉住，于是「删自己的种子数据」会被兄弟测试写的数据挡住
// （实测：23503 context_events_worker_session_id_fkey）。而 §9.5 的追加写触发器又拒绝
// DELETE 事件行，靠 `.catch()` 吞掉只会留下静默残留。
//
// 因此：在**同一条连接**上临时切到 replica 角色（用户触发器与 FK 触发器都不触发），
// 按外键依赖倒序删除，删完立刻切回 origin。`session_replication_role` 是会话级设置：
// 用 `pool.query` 设只影响当时借出的那条连接，因此清理必须在显式取得的那一条连接上完成。

/** 先断开两处外键环：tool_runs ↔ approvals、engagements.active_agent_session_id ↔ worker_sessions。
 *  replica 角色下并不必要，但留着可让随后的倒序删除自身自洽。 */
const RING_BREAKERS = [
  'update pentest.approvals set consumed_by_tool_run = null where engagement_id = any($1::uuid[])',
  'update pentest.engagements set active_agent_session_id = null where id = any($1::uuid[])',
] as const;

/** 按外键依赖倒序删除：引用方在前、被引用方在后；末两项固定是 worker_sessions → engagements。 */
const CLEANUP_STATEMENTS = [
  'delete from pentest.retrieval_hits where query_id in (select id from pentest.retrieval_queries where engagement_id = any($1::uuid[]))',
  'delete from pentest.retrieval_queries where engagement_id = any($1::uuid[])',
  'delete from pentest.request_snapshots where engagement_id = any($1::uuid[])',
  'delete from pentest.memory_access_log where engagement_id = any($1::uuid[])',
  'delete from pentest.memory_chunks where engagement_id = any($1::uuid[])',
  // findings.origin_memory_item_id 指向 memory_items：引用方必须先走。
  'delete from pentest.findings where engagement_id = any($1::uuid[])',
  'delete from pentest.memory_items where engagement_id = any($1::uuid[])',
  'delete from pentest.reports where engagement_id = any($1::uuid[])',
  'delete from pentest.state_transitions where engagement_id = any($1::uuid[])',
  'delete from pentest.handoffs where engagement_id = any($1::uuid[])',
  'delete from pentest.worker_reports where engagement_id = any($1::uuid[])',
  // artifacts.tool_run_id 指向 tool_runs：引用方必须先走。
  'delete from pentest.artifacts where engagement_id = any($1::uuid[])',
  'delete from pentest.tool_runs where engagement_id = any($1::uuid[])',
  'delete from pentest.llm_calls where engagement_id = any($1::uuid[])',
  'delete from pentest.approvals where engagement_id = any($1::uuid[])',
  'delete from pentest.session_leases where engagement_id = any($1::uuid[])',
  'delete from pentest.outbox_jobs where engagement_id = any($1::uuid[])',
  'delete from pentest.index_watermarks where engagement_id = any($1::uuid[])',
  'delete from pentest.asset_scope_versions where engagement_id = any($1::uuid[])',
  'delete from pentest.assets where engagement_id = any($1::uuid[])',
  'delete from pentest.scope_versions where engagement_id = any($1::uuid[])',
  'delete from pentest.context_events where engagement_id = any($1::uuid[])',
  'delete from pentest.ledger_anchors where engagement_id = any($1::uuid[])',
  'delete from pentest.human_decisions where engagement_id = any($1::uuid[])',
  'delete from pentest.embedding_revisions where engagement_id = any($1::uuid[])',
  'delete from pentest.worker_sessions where engagement_id = any($1::uuid[])',
  // policy_versions 也引用 engagements：先删子表，engagements 才删得掉。
  'delete from pentest.policy_versions where engagement_id = any($1::uuid[])',
  'delete from pentest.engagements where id = any($1::uuid[])',
] as const;

// ───────────────────── 纯逻辑 ─────────────────────

test('向量字面量：格式正确', () => {
  assert.equal(toVectorLiteral([1, 2.5, -3]), '[1,2.5,-3]');
  assert.equal(toVectorLiteral([]), '[]');
});

test('向量字面量：非有限值必须拒绝（写进去会静默不可检索）', () => {
  for (const bad of [NaN, Infinity, -Infinity]) {
    assert.throws(
      () => toVectorLiteral([1, bad, 3]),
      (e: unknown) => {
        assert.ok(e instanceof Error);
        assert.match(e.message, /非有限值/);
        assert.match(e.message, /永远无法被检索/);
        return true;
      },
      `含 ${String(bad)} 的向量必须被拒绝`,
    );
  }
});

// ───────────────────── 假提供方 ─────────────────────

/** 确定性假嵌入：返回全 1 向量，dimensions 可配置。 */
function fakeEmbeddings(over: {
  dimensions?: number;
  revision?: string;
  fail?: string;
  callCount?: { n: number };
} = {}): EmbeddingProvider {
  const dims = over.dimensions ?? CHUNK_VECTOR_DIMENSIONS;
  return {
    model: 'fake-model',
    dimensions: dims,
    revision: over.revision ?? 'rev-fake-1',
    async embed(texts: readonly string[]) {
      if (over.callCount !== undefined) over.callCount.n += 1;
      if (over.fail !== undefined) throw new Error(over.fail);
      return texts.map(() => Array.from({ length: dims }, () => 0.01));
    },
  };
}

// ───────────────────── 集成 ─────────────────────

describe('索引器（真实 PostgreSQL）', { skip: DATABASE_URL === undefined ? '未设置 PENTEST_DATABASE_URL' : false }, () => {
  let pool: Pool;
  let engagementId: string;
  let workerSessionId: string;

  const db = (): DbClient => ({
    async query<Row = Record<string, unknown>>(sql: string, params?: readonly unknown[]) {
      const r = await pool.query(sql, params as unknown[] | undefined);
      return { rows: r.rows as Row[], rowCount: r.rowCount };
    },
  });

  before(async () => {
    pool = new Pool({ connectionString: DATABASE_URL, max: 6 });
    engagementId = randomUUID();
    workerSessionId = randomUUID();
    await pool.query(
      `insert into pentest.engagements
         (id, tenant_id, name, status, current_status, target_snapshot, scope_snapshot, roe_snapshot, policy_snapshot, config_snapshot, created_by)
       values ($1::uuid, 't', 'indexer-test', 'running', 'worker_running', '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, 'tester')`,
      [engagementId],
    );
    await pool.query(
      `insert into pentest.worker_sessions
         (id, engagement_id, dsh_session_id, phase, profile_id, profile_revision, attempt, iteration, scope_version, task_prompt, tool_filter, skill_ids, model_route, status)
       values ($1::uuid, $2::uuid, $3, 'intelligence-gathering', 'p', 'r1', 1, 1, 0, 'tp', '{}'::jsonb, '[]'::jsonb, '{}'::jsonb, 'active')`,
      [workerSessionId, engagementId, `dsh-indexer-${randomUUID()}`],
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

  });

  /**
   * 清理本文件自己造的 engagement 下的全部种子数据（含兄弟测试对账时补写的审计行）。
   *
   * 用**同一条连接**收发 `SET session_replication_role`：它是会话级设置，
   * 用 `pool.query` 设只影响当时借出的那条连接，删表却可能落在另一条上。
   */
  async function cleanupEngagements(ids: readonly string[]): Promise<void> {
    const client = await pool.connect();
    // 只在 replica 确实生效后才需要恢复：若 SET 本身失败，再发一条同样会失败的
    // origin 只会掩盖原始错误，而那时连接上并没有 replica 状态可恢复。
    let replicaActive = false;
    try {
      // 用户触发器与 FK 触发器都不触发；该设置只作用于 teardown 的这条连接。
      await client.query("SET session_replication_role = 'replica'");
      replicaActive = true;
      for (const statement of RING_BREAKERS) await client.query(statement, [ids]);
      for (const statement of CLEANUP_STATEMENTS) await client.query(statement, [ids]);
    } finally {
      try {
        // 恢复不能被吞：这条连接之后会回到池里继续被别的查询借用，
        // 带着 replica 语义（触发器/FK 失效）会让后续写入静默失去保护。
        if (replicaActive) await client.query("SET session_replication_role = 'origin'");
      } finally {
        client.release();
      }
    }
  }

  after(async () => {
    // 清理失败必须冒泡（不再 `.catch(() => undefined)`）：静默残留会累积，
    // 并且会以「下次运行的前置状态」形式污染后续测试。
    await cleanupEngagements([engagementId]);
    await pool.end();
  });

  /** 造一条账本事件（直接插入，绕过账本的事务约束）。 */
  async function insertEvent(input: {
    eventType: string;
    chainSeq: number;
    payload: unknown;
    provisional?: boolean;
    textProjection?: string | null;
  }): Promise<string> {
    const r = await pool.query<{ event_id: string }>(
      `insert into pentest.context_events
         (engagement_id, worker_session_id, source_system, source_id, source_seq, event_type,
          schema_version, occurred_at, chain_seq, payload_json, raw_payload_zstd,
          text_projection, classification, trust_level, provisional, event_hash)
       values ($1::uuid, $2::uuid, 'test', $3, $4, $5, 1, now(), $4, $6::jsonb, '\\x00',
               $7, 'engagement', 'agent_claim', $8, '\\x01')
       returning event_id`,
      [
        engagementId,
        workerSessionId,
        `src-${input.chainSeq}`,
        input.chainSeq,
        input.eventType,
        JSON.stringify(input.payload),
        input.textProjection ?? null,
        input.provisional === true,
      ],
    );
    return r.rows[0]!.event_id;
  }

  function sourceEvent(eventId: string, over: Partial<ChunkSourceEvent> = {}): ChunkSourceEvent {
    return {
      eventId,
      engagementId,
      eventType: 'human.input',
      workerSessionId,
      trustLevel: 'human_decision',
      classification: 'engagement',
      occurredAt: new Date(),
      payload: { text: '人类说明：目标段 10.0.0.0/24 已在授权范围内' },
      ...over,
    };
  }

  async function countChunks(): Promise<number> {
    const r = await pool.query<{ n: string }>(
      'select count(*)::text as n from pentest.memory_chunks where engagement_id = $1::uuid',
      [engagementId],
    );
    return Number(r.rows[0]!.n);
  }

  test('indexEvent：分块落库，带向量与全文索引', async () => {
    const eventId = await insertEvent({ eventType: 'human.input', chainSeq: 1, payload: { text: '人类说明：目标段已授权' } });
    const indexer = new MemoryIndexer({ db: db(), txDb: db(), embeddings: fakeEmbeddings() });
    const before = await countChunks();
    const result = await indexer.indexEvent(engagementId, sourceEvent(eventId));

    assert.equal(result.inserted, 1);
    assert.equal(result.lexicalOnly, false);
    assert.equal(await countChunks(), before + 1);

    const row = await pool.query<{ embedding_revision: string; embedding_model: string; has_vector: boolean; has_fts: boolean; provisional: boolean }>(
      `select embedding_revision, embedding_model, (embedding is not null) as has_vector,
              (search_vector is not null) as has_fts, provisional
         from pentest.memory_chunks where source_event_id = $1::uuid`,
      [eventId],
    );
    assert.equal(row.rows[0]!.embedding_revision, 'rev-fake-1');
    assert.equal(row.rows[0]!.embedding_model, 'fake-model');
    assert.equal(row.rows[0]!.has_vector, true);
    assert.equal(row.rows[0]!.has_fts, true, '可索引分块必须有全文索引');
    assert.equal(row.rows[0]!.provisional, false);
  });

  test('首次索引登记嵌入版本，且每个 engagement 只登记一次（事故 2026-10-05：登记器零调用）', async () => {
    // 背景：检索侧的「只取活跃版本」过滤依赖 `embedding_revisions` 里有一行 is_active；
    // 登记器此前没有生产调用方，那道过滤是空转的，跨版本混比防护从未生效。
    const registered: Array<{ engagementId: string; model: string; dimensions: number; revision: string }> = [];
    const indexer = new MemoryIndexer({
      db: db(),
      txDb: db(),
      embeddings: fakeEmbeddings(),
      ensureEmbeddingRevision: async (registeredEngagementId, descriptor) => {
        registered.push({ engagementId: registeredEngagementId, ...descriptor });
      },
    });
    const first = await insertEvent({ eventType: 'human.input', chainSeq: 4201, payload: { text: '第一条' } });
    await indexer.indexEvent(engagementId, sourceEvent(first));
    assert.deepEqual(registered, [
      { engagementId, model: 'fake-model', dimensions: CHUNK_VECTOR_DIMENSIONS, revision: 'rev-fake-1' },
    ]);

    // 进程内去重：同一 engagement 的后续事件不再重复登记（登记器本身幂等，这里省一次查询）。
    const second = await insertEvent({ eventType: 'human.input', chainSeq: 4202, payload: { text: '第二条' } });
    await indexer.indexEvent(engagementId, sourceEvent(second));
    assert.equal(registered.length, 1);

    // 词法索引部署（无嵌入提供方）不登记任何版本。
    const lexical = new MemoryIndexer({
      db: db(),
      txDb: db(),
      ensureEmbeddingRevision: async () => {
        throw new Error('词法索引不该登记嵌入版本');
      },
    });
    const third = await insertEvent({ eventType: 'human.input', chainSeq: 4203, payload: { text: '第三条' } });
    const lexicalResult = await lexical.indexEvent(engagementId, sourceEvent(third));
    assert.equal(lexicalResult.lexicalOnly, true);
  });

  test('幂等：同一事件索引两次，第二次全部命中跳过且不重复落库', async () => {
    const eventId = await insertEvent({ eventType: 'human.input', chainSeq: 2, payload: { text: '重复索引检查' } });
    const indexer = new MemoryIndexer({ db: db(), txDb: db(), embeddings: fakeEmbeddings() });
    const first = await indexer.indexEvent(engagementId, sourceEvent(eventId));
    const before = await countChunks();
    const second = await indexer.indexEvent(engagementId, sourceEvent(eventId));

    assert.equal(first.inserted, 1);
    assert.equal(second.inserted, 0, '第二次不得插入');
    assert.ok(second.skipped >= 1, '应报告命中幂等');
    assert.equal(await countChunks(), before, '分块总数不得变化');
  });

  test('批量插入：大输出一次落库，重跑全部命中幂等（回归：逐条 720ms → 单语句 91ms）', async () => {
    // 回归锁：插入曾是「每分块一条 INSERT（各自隐含事务）」。实测 316KB 输出
    // （178 分块）逐条 720ms、单语句批量 91ms；这里用小一号的载荷锁定语义：
    // 一次批量必须全部落库、返回计数正确、重跑全部命中幂等。
    const line = 'GET /api/v1/resource -> 200 text/html';
    const big = Array.from({ length: 1500 }, (_, i) => `${line} #${String(i)}`).join('\n');
    const payload = { command: 'ffuf -u http://target/FUZZ', stdout: big, exitCode: 0 };
    const eventId = await insertEvent({ eventType: 'tool.result', chainSeq: 77, payload });
    const indexer = new MemoryIndexer({ db: db(), txDb: db(), embeddings: fakeEmbeddings() });
    const before = await countChunks();

    const first = await indexer.indexEvent(engagementId, sourceEvent(eventId, {
      eventType: 'tool.result',
      payload,
    }));

    assert.ok(first.inserted > 10, `大输出应切出多块（实际 ${String(first.inserted)}）`);
    assert.equal(await countChunks(), before + first.inserted, '一次批量必须全部落库');

    const second = await indexer.indexEvent(engagementId, sourceEvent(eventId, {
      eventType: 'tool.result',
      payload,
    }));
    assert.equal(second.inserted, 0, '重跑不得插入');
    assert.equal(second.skipped, first.inserted, '重跑必须全部命中幂等');
    assert.equal(await countChunks(), before + first.inserted, '分块总数不得变化');
  });

  test('暂定分块：无版本、无向量、无全文索引（不进检索面）', async () => {
    const eventId = await insertEvent({
      eventType: 'human.input',
      chainSeq: 3,
      payload: { text: '暂定的人类输入（尚未结算）' },
    });
    const indexer = new MemoryIndexer({ db: db(), txDb: db(), embeddings: fakeEmbeddings() });
    await indexer.indexEvent(engagementId, sourceEvent(eventId, { provisional: true }));

    const row = await pool.query<{ embedding_revision: string | null; has_vector: boolean; has_fts: boolean }>(
      `select embedding_revision, (embedding is not null) as has_vector, (search_vector is not null) as has_fts
         from pentest.memory_chunks where source_event_id = $1::uuid`,
      [eventId],
    );
    assert.equal(row.rows[0]!.embedding_revision, null, '暂定块无版本（DDL 允许）');
    assert.equal(row.rows[0]!.has_vector, false);
    assert.equal(row.rows[0]!.has_fts, false, '暂定块不可检索');
  });

  test('未配嵌入提供方时：只做词法索引，版本标 lexical-only，且 DDL CHECK 仍满足', async () => {
    const eventId = await insertEvent({ eventType: 'human.input', chainSeq: 4, payload: { text: '无嵌入提供方' } });
    const indexer = new MemoryIndexer({ db: db(), txDb: db() });
    const result = await indexer.indexEvent(engagementId, sourceEvent(eventId));

    assert.equal(result.lexicalOnly, true);
    const row = await pool.query<{ embedding_revision: string; has_vector: boolean; has_fts: boolean }>(
      `select embedding_revision, (embedding is not null) as has_vector, (search_vector is not null) as has_fts
         from pentest.memory_chunks where source_event_id = $1::uuid`,
      [eventId],
    );
    assert.equal(row.rows[0]!.embedding_revision, 'lexical-only', '非暂定块必须有版本');
    assert.equal(row.rows[0]!.has_vector, false);
    assert.equal(row.rows[0]!.has_fts, true, '词法索引仍应建立');
  });

  test('嵌入维度不符：拒绝且错误信息可操作', async () => {
    const indexer = new MemoryIndexer({
      db: db(),
      txDb: db(),
      embeddings: fakeEmbeddings({ dimensions: 768 }),
    });
    const eventId = await insertEvent({ eventType: 'human.input', chainSeq: 5, payload: { text: '维度检查' } });
    await assert.rejects(
      () => indexer.indexEvent(engagementId, sourceEvent(eventId)),
      (e: unknown) => {
        assert.ok(e instanceof Error);
        // 错误必须说清「怎么办」，而不是只说「维度不对」
        assert.match(e.message, /1024|重建|revision/i);
        return true;
      },
    );
  });

  test('嵌入提供方失败：抛错，不写零向量、不静默跳过', async () => {
    const eventId = await insertEvent({ eventType: 'human.input', chainSeq: 6, payload: { text: '提供方故障' } });
    const indexer = new MemoryIndexer({
      db: db(),
      txDb: db(),
      embeddings: fakeEmbeddings({ fail: '上游 503' }),
    });
    const before = await countChunks();
    await assert.rejects(() => indexer.indexEvent(engagementId, sourceEvent(eventId)), /上游 503/);
    assert.equal(await countChunks(), before, '失败时不得留下半个分块');
  });

  test('runOnce：从水位推进并写入水位', async () => {
    const fresh = randomUUID();
    await pool.query(
      `insert into pentest.engagements
         (id, tenant_id, name, status, current_status, target_snapshot, scope_snapshot, roe_snapshot, policy_snapshot, config_snapshot, created_by)
       values ($1::uuid, 't', 'watermark-test', 'running', 'worker_running', '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, 'tester')`,
      [fresh],
    );
    const sess = randomUUID();
    await pool.query(
      `insert into pentest.worker_sessions
         (id, engagement_id, dsh_session_id, phase, profile_id, profile_revision, attempt, iteration, scope_version, task_prompt, tool_filter, skill_ids, model_route, status)
       values ($1::uuid, $2::uuid, $3, 'intelligence-gathering', 'p', 'r1', 1, 1, 0, 'tp', '{}'::jsonb, '[]'::jsonb, '{}'::jsonb, 'active')`,
      [sess, fresh, `dsh-wm-${randomUUID()}`],
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
      [fresh, sess],
    );

    for (let i = 1; i <= 3; i += 1) {
      await pool.query(
        `insert into pentest.context_events
           (engagement_id, worker_session_id, source_system, source_id, source_seq, event_type,
            schema_version, occurred_at, chain_seq, payload_json, raw_payload_zstd,
            classification, trust_level, event_hash)
         values ($1::uuid, $2::uuid, 'test', $3, $4, 'human.input', 1, now(), $4, $5::jsonb, '\\x00', 'engagement', 'human_decision', '\\x01')`,
        [fresh, sess, `wm-${i}`, i, JSON.stringify({ text: `第 ${i} 条` })],
      );
    }

    const indexer = new MemoryIndexer({ db: db(), txDb: db(), embeddings: fakeEmbeddings() });
    const run = await indexer.runOnce(fresh);

    assert.equal(run.fromChainSeq, 0);
    assert.equal(run.toChainSeq, 3);
    assert.equal(run.eventsProcessed, 3);
    assert.equal(run.chunksInserted, 3);
    assert.equal(run.status, 'ready');

    const wm = await indexer.watermark(fresh);
    assert.equal(wm.lastChainSeq, 3);
    assert.equal(wm.lagEvents, 0);
    assert.equal(wm.status, 'ready');

    // 再跑一次：水位已推进，无事可做
    const again = await indexer.runOnce(fresh);
    assert.equal(again.eventsProcessed, 0);
    assert.equal(again.chunksInserted, 0);

    // 用例内部即回收本次的临时 engagement：走与 after 相同的倒序 + replica 角色路径
    // （对账可能已为它补写审计行，普通 DELETE 会被 §9.5 触发器与外键挡住）。
    await cleanupEngagements([fresh]);
  });

  test('runOnce 失败：水位不动（下次重扫同一批），状态标 failed 并留原因', async () => {
    const fresh = randomUUID();
    await pool.query(
      `insert into pentest.engagements
         (id, tenant_id, name, status, current_status, target_snapshot, scope_snapshot, roe_snapshot, policy_snapshot, config_snapshot, created_by)
       values ($1::uuid, 't', 'fail-test', 'running', 'worker_running', '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, 'tester')`,
      [fresh],
    );
    const sess = randomUUID();
    await pool.query(
      `insert into pentest.worker_sessions
         (id, engagement_id, dsh_session_id, phase, profile_id, profile_revision, attempt, iteration, scope_version, task_prompt, tool_filter, skill_ids, model_route, status)
       values ($1::uuid, $2::uuid, $3, 'intelligence-gathering', 'p', 'r1', 1, 1, 0, 'tp', '{}'::jsonb, '[]'::jsonb, '{}'::jsonb, 'active')`,
      [sess, fresh, `dsh-fail-${randomUUID()}`],
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
      [fresh, sess],
    );

    await pool.query(
      `insert into pentest.context_events
         (engagement_id, worker_session_id, source_system, source_id, source_seq, event_type,
          schema_version, occurred_at, chain_seq, payload_json, raw_payload_zstd,
          classification, trust_level, event_hash)
       values ($1::uuid, $2::uuid, 'test', 'f1', 1, 'human.input', 1, now(), 1, '{"text":"会失败"}'::jsonb, '\\x00', 'engagement', 'human_decision', '\\x01')`,
      [fresh, sess],
    );

    const indexer = new MemoryIndexer({
      db: db(),
      txDb: db(),
      embeddings: fakeEmbeddings({ fail: '嵌入服务不可达' }),
    });
    const run = await indexer.runOnce(fresh);

    assert.equal(run.status, 'failed');
    assert.match(String(run.detail), /嵌入服务不可达/);

    const wm = await indexer.watermark(fresh);
    assert.equal(wm.lastChainSeq, 0, '失败时水位不得推进');
    assert.equal(wm.status, 'failed');
    assert.equal(wm.lagEvents, 1, '滞后量必须可观测——索引失败不能静默消失');
    assert.match(String(wm.detail), /嵌入服务不可达/);

    // 用例内部即回收本次的临时 engagement：走与 after 相同的倒序 + replica 角色路径
    // （对账可能已为它补写审计行，普通 DELETE 会被 §9.5 触发器与外键挡住）。
    await cleanupEngagements([fresh]);
  });

  test('watermark：滞后量按账本头与水位之差计算', async () => {
    const indexer = new MemoryIndexer({ db: db(), txDb: db() });
    const wm = await indexer.watermark(engagementId);
    // 本套件此前造了若干事件但没跑 runOnce，因此滞后量应大于 0
    assert.ok(wm.lagEvents > 0, `应能观测到滞后（实际 ${wm.lagEvents}）`);
  });

  test('索引器只读账本：不产生 context_events 写入', async () => {
    const before = await pool.query<{ n: string }>(
      'select count(*)::text as n from pentest.context_events where engagement_id = $1::uuid',
      [engagementId],
    );
    const indexer = new MemoryIndexer({ db: db(), txDb: db(), embeddings: fakeEmbeddings() });
    await indexer.runOnce(engagementId);
    const after = await pool.query<{ n: string }>(
      'select count(*)::text as n from pentest.context_events where engagement_id = $1::uuid',
      [engagementId],
    );
    assert.equal(after.rows[0]!.n, before.rows[0]!.n, '索引器是账本的下游，绝不写账本');
  });

  test('不可索引分块（二进制证据）：只落元数据，有版本但无向量无全文索引', async () => {
    // §8.5「流量与二进制」：保留可溯源的元数据，但不做全文与向量索引
    const eventId = await insertEvent({
      eventType: 'tool.result',
      chainSeq: 20,
      payload: {
        binary: { mimeType: 'application/vnd.tcpdump.pcap', byteLength: 4096, sha256: 'a'.repeat(64), protocolSummary: 'HTTP over TCP' },
      },
    });
    const indexer = new MemoryIndexer({ db: db(), txDb: db(), embeddings: fakeEmbeddings() });
    const result = await indexer.indexEvent(
      engagementId,
      sourceEvent(eventId, { eventType: 'tool.result', trustLevel: 'tool_observation', payload: { binary: { mimeType: 'application/vnd.tcpdump.pcap', byteLength: 4096, sha256: 'a'.repeat(64) } } }),
    );

    assert.equal(result.metadataOnly, 1, '应报告一条元数据专用分块');
    const row = await pool.query<{ embedding_revision: string; has_vector: boolean; has_fts: boolean; content: string }>(
      `select embedding_revision, (embedding is not null) as has_vector, (search_vector is not null) as has_fts, content
         from pentest.memory_chunks where source_event_id = $1::uuid`,
      [eventId],
    );
    assert.equal(row.rows[0]!.has_vector, false, '二进制不做向量索引');
    assert.equal(row.rows[0]!.has_fts, false, '二进制不做全文索引');
    assert.equal(
      row.rows[0]!.embedding_revision,
      'rev-fake-1',
      '仍必须有版本——DDL 的 CHECK 要求非暂定分块有 embedding_revision',
    );
    assert.match(row.rows[0]!.content, /SHA-256/, '元数据必须可溯源（含哈希）');
  });

  test('结算后旧暂定分块被标记取代（同一会话同内容的帧不再出现在检索面）', async () => {
    // 先造一条暂定块（模拟流式帧）
    const provisionalEventId = await insertEvent({
      eventType: 'human.input',
      chainSeq: 21,
      payload: { text: '结算内容' },
      provisional: true,
    });
    const indexer = new MemoryIndexer({ db: db(), txDb: db(), embeddings: fakeEmbeddings() });
    await indexer.indexEvent(
      engagementId,
      sourceEvent(provisionalEventId, { provisional: true, payload: { text: '结算内容' } }),
    );

    // 再造结算事件（内容相同、会话相同、时间更晚）
    const finalEventId = await insertEvent({
      eventType: 'human.input',
      chainSeq: 22,
      payload: { text: '结算内容' },
    });
    const result = await indexer.indexEvent(
      engagementId,
      sourceEvent(finalEventId, { payload: { text: '结算内容' } }),
    );

    assert.ok(result.supersededProvisional >= 1, '应标记同源暂定块被取代');

    const marked = await pool.query<{ superseded_by_revision: string | null }>(
      `select superseded_by_revision from pentest.memory_chunks where source_event_id = $1::uuid`,
      [provisionalEventId],
    );
    assert.equal(
      marked.rows[0]!.superseded_by_revision,
      'rev-fake-1',
      '暂定块必须被标记取代，否则同一内容会以两份分块出现在召回里',
    );
  });
});
