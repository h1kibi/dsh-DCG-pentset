/**
 * 控制台面向的记忆检索服务测试（§8.7、§8.3、§8.6）。
 *
 * 这个实现由并行切片交付但**没有配套测试**——这份测试是补上的，重点锁定三条
 * 容易做错且后果明确的规则：
 *
 *   1. **`includeReasoning` 是筛选开关，不是权限门禁**（§8.3）：不传时思考链参与
 *      检索；传 `false` 时排除。任何把它当权限校验的实现都会让「思考链对全部
 *      Worker 开放」这条产品规则失效。
 *   2. **范围过滤谓词**（§8.6）：含被排除资产的分块不可见；**无资产归属的分块可见**
 *      （否则思考链、人工决策、压缩摘要会整批消失）。
 *   3. **读取写访问审计**（§8.3）：读取原文必须留痕，且理由进审计。
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';

import { PgMemoryQueryService, MemoryQueryRejection } from '../src/memory/pg-memory-query.ts';
import { MemoryLedger } from '../src/memory/ledger.ts';
import type { DbClient } from '../src/memory/ledger.ts';
import { cleanupEngagements } from './helpers/cleanup.ts';

const DATABASE_URL = process.env.PENTEST_DATABASE_URL;

describe('记忆检索面（真实 PostgreSQL）', { skip: DATABASE_URL === undefined ? '未设置 PENTEST_DATABASE_URL' : false }, () => {
  let pool: Pool;
  const made: string[] = [];

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
    await cleanupEngagements(pool, made);
    await pool.end();
  });

  /** 建 engagement + 两个资产（一个纳入、一个排除）。 */
  async function seed(options: { readonly withActiveRevision?: boolean } = {}): Promise<{
    engagementId: string;
    includedAssetId: string;
    excludedAssetId: string;
  }> {
    const engagementId = randomUUID();
    made.push(engagementId);
    await pool.query(
      `insert into pentest.engagements
         (id, tenant_id, name, status, current_status, target_snapshot, scope_snapshot, roe_snapshot, policy_snapshot, config_snapshot, created_by)
       values ($1::uuid, 't', 'memquery-test', 'running', 'worker_running', '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, 'tester')`,
      [engagementId],
    );
    // 范围版本 2（资产裁决挂到它上面）
    await pool.query(
      `insert into pentest.scope_versions (engagement_id, version, iteration, targets, exclusions, changed_by, content_hash)
       values ($1::uuid, 2, 1, '[]'::jsonb, '[]'::jsonb, 'tester', 'h2')`,
      [engagementId],
    );
    // 登记**生效**嵌入版本。
    //
    // 检索层默认只返回 `embedding_revision` 等于当前 active 版本的分块
    // （`retrieval.ts` 的 `activeEmbeddingRevisionOnly`，§9.1「不原地解释旧向量」）。
    // 因此**有嵌入器的部署**必须登记它，否则分块一条都查不到。
    //
    // `withActiveRevision: false` 复现的是**没有嵌入器**的部署（个人档）：分块写成
    // `lexical-only` 且不登记任何版本行——那里必须仍能检索（见本文件的 lexical-only 用例）。
    if (options.withActiveRevision !== false) {
      await pool.query(
        `insert into pentest.embedding_revisions (engagement_id, revision, model, dimensions, is_active)
         values ($1::uuid, 'rev-mq', 'test-model', 1024, true)`,
        [engagementId],
      );
    }

    const included = randomUUID();
    const excluded = randomUUID();
    await pool.query(
      `insert into pentest.assets (id, engagement_id, canonical_target, kind, first_seen_iteration)
       values ($1::uuid, $3::uuid, 'in-scope.example', 'domain', 1), ($2::uuid, $3::uuid, 'out.example', 'domain', 1)`,
      [included, excluded, engagementId],
    );
    await pool.query(
      `insert into pentest.asset_scope_versions (asset_id, scope_version, engagement_id, decision)
       values ($1::uuid, 2, $3::uuid, 'included'), ($2::uuid, 2, $3::uuid, 'excluded')`,
      [included, excluded, engagementId],
    );
    return { engagementId, includedAssetId: included, excludedAssetId: excluded };
  }

  /**
   * 造一个分块：先造事件，再插 chunk。返回 chunk 的 eventId（用于 readMemory 的 ref）。
   *
   * `payload` 可覆盖事件载荷，默认 `{ text: content }`。需要它的场合是「载荷里有分块里
   * **没有**的东西」——例如验证读取路径返回的是分块投影、而不是未脱敏的原始载荷。
   * 事件表是追加写（§9.5 的触发器拒绝 UPDATE），因此载荷只能在插入时给。
   */
  async function seedChunk(input: {
    engagementId: string;
    seq: number;
    content: string;
    classification: string;
    trustLevel: string;
    assetIds: readonly string[];
    payload?: unknown;
    /** 默认 `rev-mq`（`seed()` 登记的活跃版本）；lexical-only 部署写 `'lexical-only'`。 */
    embeddingRevision?: string;
  }): Promise<{ eventId: string; chunkId: string }> {
    const ev = await pool.query<{ event_id: string }>(
      `insert into pentest.context_events
         (engagement_id, source_system, source_id, source_seq, event_type, schema_version,
          occurred_at, chain_seq, payload_json, raw_payload_zstd, text_projection,
          classification, trust_level, event_hash)
       values ($1::uuid, 'test', $2, $3, 'llm.reasoning', 1, now(), $3, $4::jsonb, '\\x00', $5,
               $6, $7, decode(repeat('ab', 32), 'hex'))
       returning event_id`,
      [input.engagementId, `mq-${String(input.seq)}-${randomUUID()}`, input.seq,
        JSON.stringify(input.payload ?? { text: input.content }), input.content,
        input.classification, input.trustLevel],
    );
    const eventId = ev.rows[0]!.event_id;
    const chunk = await pool.query<{ id: string }>(
      `insert into pentest.memory_chunks
         (engagement_id, source_event_id, ordinal, content, content_hash,
          search_vector, embedding_revision, asset_ids, trust_level, classification)
       values ($1::uuid, $2::uuid, 0, $3, $4,
               to_tsvector('simple', $3), $5, $6::uuid[], $7, $8)
       returning id`,
      [input.engagementId, eventId, input.content, `ch-${randomUUID()}`,
        input.embeddingRevision ?? 'rev-mq', [...input.assetIds], input.trustLevel, input.classification],
    );
    return { eventId, chunkId: chunk.rows[0]!.id };
  }

  /** 组装服务：带账本（用于断言访问审计）。 */
  function service(): { svc: PgMemoryQueryService; ledger: MemoryLedger } {
    const d = db();
    const ledger = new MemoryLedger({ db: d, txDb: d, secret: 'memquery-test-secret-32-bytes-min' });
    return { svc: new PgMemoryQueryService(d, { ledger }), ledger };
  }

  // ─────────────── 检索 ───────────────

  test('检索返回命中，且带引用与来源信息', async () => {
    const { engagementId, includedAssetId } = await seed();
    await seedChunk({
      engagementId, seq: 1, content: 'target-10.0.0.5 port 8080 open', classification: 'engagement',
      trustLevel: 'tool_observation', assetIds: [includedAssetId],
    });

    const { svc } = service();
    const result = await svc.searchMemory({ engagementId, query: '10.0.0.5' });
    assert.ok(result.hits.length >= 1, '应命中刚写入的分块');
    const hit = result.hits[0]!;
    assert.ok(typeof hit.memoryId === 'string' && hit.memoryId !== '');
    assert.ok(typeof hit.citation === 'string' && hit.citation !== '', '每条结果必须带可回溯引用');
    assert.ok(typeof hit.occurredAt === 'string');
    // 水位在**结果集**上而不是单条命中上（§8.4：结果要带索引水位，提示可能遗漏未索引事件）
    assert.equal(typeof result.watermark.lagEvents, 'number');
  });

  // ─────────────── 范围过滤（§8.6） ───────────────

  test('lexical-only 部署（没有活跃嵌入版本）也能检索；登记活跃版本后旧版本仍被挡住', async () => {
    const { svc } = service();

    // (a) 个人档的真实形态：没有嵌入器 → 分块写 `lexical-only`、`embedding_revisions` 一行都没有。
    // 过滤条件若直接写 `embedding_revision = (SELECT revision … WHERE is_active)`，右侧为 NULL，
    // 匹配恒不成立——**每一次检索都返回 0 条**，而索引、水位、队列全都显示正常（活体实测）。
    const bare = await seed({ withActiveRevision: false });
    await seedChunk({
      engagementId: bare.engagementId, seq: 1, content: 'lexical-only-probe-abc',
      classification: 'engagement', trustLevel: 'tool_observation', assetIds: [],
      embeddingRevision: 'lexical-only',
    });
    const lexical = await svc.searchMemory({ engagementId: bare.engagementId, query: 'lexical-only-probe-abc' });
    assert.ok(
      lexical.hits.length >= 1,
      '没有活跃版本时必须放行词法分块——否则没有嵌入器的部署整库检索恒 0 命中',
    );

    // (b) 一旦登记了活跃版本，过滤照原样生效（§9.1「不原地解释旧向量」）：旧版本分块仍然不可见。
    const versioned = await seed();
    await seedChunk({
      engagementId: versioned.engagementId, seq: 1, content: 'active-rev-probe-abc',
      classification: 'engagement', trustLevel: 'tool_observation', assetIds: [],
    });
    await seedChunk({
      engagementId: versioned.engagementId, seq: 2, content: 'stale-rev-probe-abc',
      classification: 'engagement', trustLevel: 'tool_observation', assetIds: [],
      embeddingRevision: 'lexical-only',
    });
    const active = await svc.searchMemory({ engagementId: versioned.engagementId, query: 'active-rev-probe-abc' });
    assert.ok(active.hits.length >= 1, '活跃版本的分块必须能检索到');
    const stale = await svc.searchMemory({ engagementId: versioned.engagementId, query: 'stale-rev-probe-abc' });
    // 按**内容**判定而不是 `hits.length === 0`：查询词与活跃分块共享大量三元组，
    // 近似匹配会返回那条**活跃版本**的分块（那是正确行为）。这里要钉的是
    // 「旧版本的分块一条都不许出现」。
    assert.ok(
      stale.hits.every((hit) => !hit.excerpt.includes('stale-rev-probe-abc')),
      '登记了活跃版本后，其它版本的分块不得返回（§9.1）',
    );
  });

  test('范围过滤：含被排除资产的分块不返回', async () => {
    const { engagementId, excludedAssetId } = await seed();
    await seedChunk({
      engagementId, seq: 10, content: 'out-of-scope-host-192.0.2.9 finding', classification: 'engagement',
      trustLevel: 'tool_observation', assetIds: [excludedAssetId],
    });

    const { svc } = service();
    const result = await svc.searchMemory({ engagementId, query: 'out-of-scope-host-192.0.2.9' });
    assert.equal(result.hits.length, 0, '被排除资产的证据不得通过检索泄露（§8.6 排除优先）');
  });

  test('范围过滤：无资产归属的分块仍可见（否则思考链会整批消失）', async () => {
    const { engagementId } = await seed();
    await seedChunk({
      engagementId, seq: 11, content: 'orphan-reasoning-fragment-xyz', classification: 'reasoning',
      trustLevel: 'model_reasoning', assetIds: [],
    });

    const { svc } = service();
    const result = await svc.searchMemory({ engagementId, query: 'orphan-reasoning-fragment-xyz' });
    assert.ok(
      result.hits.length >= 1,
      '空 asset_ids 必须放行：思考链、人工决策、压缩摘要都没有资产归属，' +
        '若要求「必须归属某资产」它们会整批从检索面消失（§8.6）',
    );
  });

  // ─────────────── includeReasoning 是筛选开关 ───────────────

  test('includeReasoning 不传：思考链与其他类型一同参与检索（它不是权限门禁）', async () => {
    const { engagementId } = await seed();
    await seedChunk({
      engagementId, seq: 20, content: 'reasoning-about-entry-zzz maybe exploitable', classification: 'reasoning',
      trustLevel: 'model_reasoning', assetIds: [],
    });

    const { svc } = service();
    const result = await svc.searchMemory({ engagementId, query: 'reasoning-about-entry-zzz' });
    assert.ok(
      result.hits.length >= 1,
      '§8.3：思考链对本 engagement 全部 Worker 开放。不传 includeReasoning 时必须能命中它',
    );
  });

  test('includeReasoning 传 false：本次只要非思考链条目', async () => {
    const { engagementId } = await seed();
    await seedChunk({
      engagementId, seq: 21, content: 'only-in-reasoning-zzzunique', classification: 'reasoning',
      trustLevel: 'model_reasoning', assetIds: [],
    });
    await seedChunk({
      engagementId, seq: 22, content: 'tool-observation-zzzunique port closed', classification: 'engagement',
      trustLevel: 'tool_observation', assetIds: [],
    });

    const { svc } = service();
    const withoutReasoning = await svc.searchMemory({
      engagementId, query: 'zzzunique', includeReasoning: false,
    });
    assert.ok(
      withoutReasoning.hits.every((h) => h.kind !== 'reasoning'),
      'includeReasoning=false 时结果里不得出现思考链——它是筛选，不是权限（两者都要成立）',
    );
  });

  // ─────────────── 读取与访问审计 ───────────────

  test('readMemory：按引用读取，且写入访问审计', async () => {
    const { engagementId } = await seed();
    const { eventId } = await seedChunk({
      engagementId, seq: 30, content: 'original-evidence-text-abc', classification: 'engagement',
      trustLevel: 'tool_observation', assetIds: [],
    });

    const { svc } = service();
    const records = await svc.readMemory({
      engagementId,
      refs: [`event:${eventId}`],
      reason: '人工核对证据原文',
    });
    assert.equal(records.length, 1, '应读回一条');
    assert.match(records[0]!.content, /original-evidence-text-abc/);
    assert.ok(typeof records[0]!.contentHash === 'string' && records[0]!.contentHash !== '');

    // 访问审计：§8.3「每次读取记入访问审计」
    const audit = await pool.query<{ n: string }>(
      `select count(*)::text as n from pentest.context_events
        where engagement_id = $1::uuid and event_type = 'memory.access'`,
      [engagementId],
    );
    assert.ok(Number(audit.rows[0]!.n) >= 1, '读取必须留痕（§8.3），否则审计无从追溯谁读了什么');
  });

  test('readMemory：空引用集不报错、也不写审计（没读东西就不该留痕）', async () => {
    const { engagementId } = await seed();
    const { svc } = service();
    const records = await svc.readMemory({ engagementId, refs: [], reason: 'r' });
    assert.deepEqual(records, []);

    const audit = await pool.query<{ n: string }>(
      `select count(*)::text as n from pentest.context_events
        where engagement_id = $1::uuid and event_type = 'memory.access'`,
      [engagementId],
    );
    assert.equal(audit.rows[0]!.n, '0', '空集不写审计——写了就是凭空造痕迹');
  });

  test('readMemory：无法归类的引用被拒绝，且错误码稳定', async () => {
    const { engagementId } = await seed();
    const { svc } = service();
    await assert.rejects(
      () => svc.readMemory({ engagementId, refs: ['这不是一个引用'], reason: 'r' }),
      (e: unknown) => {
        assert.ok(e instanceof MemoryQueryRejection, '应为结构化拒绝而不是裸字符串');
        assert.equal(e.code, 'classification_rejected');
        return true;
      },
    );
  });

  test('readMemory：被排除资产的事件引用必须拒绝，且不得回退返回原始 payload', async () => {
    // 回归锁。此前 `#eventRecord` 在「没有任何可见分块」时回退为
    // `JSON.stringify(row.payload_json)`，于是**全部**分块都被范围排除的事件
    // （例如被排除资产的工具输出）会把未脱敏的原始载荷原样返回——
    // 分块那侧的脱敏与过滤完全被绕过。
    //
    // 「索引滞后所以没有分块」与「被范围排除所以没有可见分块」在这条路径上无法区分，
    // 而两者都不该给出正文：Worker 面对同一情形（`pg-worker-tools.ts` 的 read）明确拒绝。
    const { engagementId, excludedAssetId } = await seed();
    const secret = 'EXCLUDED-PAYLOAD-SECRET-2f';
    // 事件载荷刻意带上分块里**没有**的敏感字段：只有这样才区分得出读取路径返回的
    // 是「分块投影」还是「未脱敏的原始 payload」。
    const { eventId } = await seedChunk({
      engagementId, seq: 40, content: `out-of-scope ${secret}`, classification: 'engagement',
      trustLevel: 'tool_observation', assetIds: [excludedAssetId],
      payload: { stdout: secret, token: 'leaked-credential-8c' },
    });

    const { svc } = service();
    const error = await svc
      .readMemory({ engagementId, refs: [`event:${eventId}`], reason: '尝试越权读取' })
      .then(() => null, (e: unknown) => e);
    assert.ok(error instanceof MemoryQueryRejection, '被排除资产的事件引用必须被拒绝');
    assert.equal(error.code, 'scope_violation');
    assert.equal(
      error.message.includes(secret),
      false,
      '拒绝信息不得回流被排除资产的内容',
    );
    assert.equal(
      error.message.includes('leaked-credential-8c'),
      false,
      '拒绝信息不得回流原始 payload 里的凭据',
    );

    // 审计不得为一次**被拒绝**的读取留痕：什么都没读到，写审计就是凭空造痕迹。
    const audit = await pool.query<{ n: string }>(
      `select count(*)::text as n from pentest.context_events
        where engagement_id = $1::uuid and event_type = 'memory.access'`,
      [engagementId],
    );
    assert.equal(audit.rows[0]?.n, '0', '拒绝的读取不应写访问审计');
  });

  test('readMemory：事件没有可见分块时整批引用一起拒绝（部分返回会误导调用方）', async () => {
    // 同一批次里一条可见、一条不可见：整体拒绝，而不是「返回一条、悄悄丢掉另一条」。
    // 部分返回会让调用方以为未列出的引用已经读过了。
    const { engagementId, includedAssetId, excludedAssetId } = await seed();
    const visible = await seedChunk({
      engagementId, seq: 50, content: 'in-scope text-51', classification: 'engagement',
      trustLevel: 'tool_observation', assetIds: [includedAssetId],
    });
    const hidden = await seedChunk({
      engagementId, seq: 51, content: 'out-of-scope text-52', classification: 'engagement',
      trustLevel: 'tool_observation', assetIds: [excludedAssetId],
    });

    const { svc } = service();
    await assert.rejects(
      () => svc.readMemory({
        engagementId,
        refs: [`event:${visible.eventId}`, `event:${hidden.eventId}`],
        reason: '混合引用',
      }),
      (e: unknown) => e instanceof MemoryQueryRejection && e.code === 'scope_violation',
    );
  });

  // ─────────────── 索引水位 ───────────────

  test('memoryWatermark：滞后量按「水位之后、能落块却还没落块」的事件条数计算', async () => {
    // 口径是**已落成分块的事件**，不是 `index_watermarks` 行：那张表只在重建（reindex）期间被写，
    // 事件驱动的索引不写它——拿它当显示值会让「索引队列完成 N / 索引水位 0」并列出现（实测）。
    // 滞后量用**规划器**判定（不是「类型在不在可分块集合里」）：见 (c)(d)。
    const { svc } = service();

    // (a) 三个**能落块**的事件、没有分块 → 水位 0、滞后 3。
    const notIndexed = await seed();
    for (let i = 1; i <= 3; i += 1) {
      await pool.query(
        `insert into pentest.context_events
           (engagement_id, source_system, source_id, source_seq, event_type, schema_version,
            occurred_at, chain_seq, payload_json, raw_payload_zstd, text_projection,
            classification, trust_level, event_hash)
         values ($1::uuid, 'test', $2, $3, 'human.input', 1, now(), $3, '{}'::jsonb, '\\x00', $4,
                 'engagement', 'human_decision', decode(repeat('cd', 32), 'hex'))`,
        [notIndexed.engagementId, `wm-${String(i)}-${randomUUID()}`, i, `第 ${String(i)} 条`],
      );
    }
    const unstained = await svc.memoryWatermark(notIndexed.engagementId);
    assert.equal(unstained.lastChainSeq, 0, '没有分块 = 尚未索引任何事件');
    assert.equal(unstained.lagEvents, 3, `应报告滞后 3 条（实际 ${String(unstained.lagEvents)}）`);

    // (b) 分块覆盖到链头 → 滞后 0：这正是「事件驱动索引不写水位行」时也必须显示 0 的场景。
    const indexed = await seed();
    for (let i = 1; i <= 3; i += 1) {
      await seedChunk({
        engagementId: indexed.engagementId, seq: i, content: `watermark-probe-${String(i)}`,
        classification: 'engagement', trustLevel: 'tool_observation', assetIds: [],
      });
    }
    const stained = await svc.memoryWatermark(indexed.engagementId);
    assert.equal(stained.lastChainSeq, 3, '水位取已索引事件里的最大链序号');
    assert.equal(stained.lagEvents, 0, '分块覆盖到链头就没有滞后');

    // (c) 尾部有**不可分块**的控制面事件（每次都发生）→ 不得算成「遗漏」。
    const mixed = await seed();
    await seedChunk({
      engagementId: mixed.engagementId, seq: 1, content: 'mixed-probe-1',
      classification: 'engagement', trustLevel: 'tool_observation', assetIds: [],
    });
    await pool.query(
      `insert into pentest.context_events
         (engagement_id, source_system, source_id, source_seq, event_type, schema_version,
          occurred_at, chain_seq, payload_json, raw_payload_zstd, classification, trust_level, event_hash)
       values ($1::uuid, 'test', $2, 1, 'worker.waiting_human', 1, now(), 2, '{}'::jsonb, '\\x00',
               'engagement', 'agent_claim', decode(repeat('ef', 32), 'hex'))`,
      [mixed.engagementId, `mixed-${randomUUID()}`],
    );
    const withControlPlaneTail = await svc.memoryWatermark(mixed.engagementId);
    assert.equal(withControlPlaneTail.lagEvents, 0, '不可分块的控制面事件不属于「遗漏」');

    // (d) 尾部是**可分块类型、但载荷里没有正文**的事件（`handoff.*` 的真实形状）→ 同样不算遗漏。
    // 按「事件类型在不在可分块集合里」判定的实现会在这里永久报滞后：每次阶段交接都写
    // `handoff.draft.generated` / `handoff.confirmed`，而它们的载荷只有 `{handoffId}` 之类的标识。
    const handoffTail = await seed();
    await seedChunk({
      engagementId: handoffTail.engagementId, seq: 1, content: 'handoff-probe-1',
      classification: 'engagement', trustLevel: 'tool_observation', assetIds: [],
    });
    await pool.query(
      `insert into pentest.context_events
         (engagement_id, source_system, source_id, source_seq, event_type, schema_version,
          occurred_at, chain_seq, payload_json, raw_payload_zstd, classification, trust_level, event_hash)
       values ($1::uuid, 'test', $2, 1, 'handoff.confirmed', 1, now(), 2, '{"handoffId":"x"}'::jsonb, '\\x00',
               'engagement', 'human_decision', decode(repeat('ab', 32), 'hex'))`,
      [handoffTail.engagementId, `handoff-${randomUUID()}`],
    );
    const withHandoffTail = await svc.memoryWatermark(handoffTail.engagementId);
    assert.equal(
      withHandoffTail.lagEvents,
      0,
      '可分块类型但载荷无正文的事件不属于「遗漏」（否则控制台永久报警）',
    );
  });

  test('memoryWatermark：无 engagement 数据时返回零值而不是抛错', async () => {
    const { svc } = service();
    const wm = await svc.memoryWatermark(randomUUID());
    assert.equal(wm.lagEvents, 0);
    assert.equal(wm.lastChainSeq, 0);
  });
});

// ─────────────── 账本校验面（不依赖数据库：端口可注入） ───────────────

describe('账本校验面（§8.4 / P7）', () => {
  /** 触库即失败的 db：校验路径只应经由注入的校验端口，不应碰数据库。 */
  const noDb: DbClient = {
    query: async <Row = Record<string, unknown>>(): Promise<{ rows: Row[]; rowCount: number | null }> => {
      throw new Error('verifyLedger 不应触库');
    },
  };

  test('verifyLedger：未装配校验端口时明确拒绝，不返回「通过」', async () => {
    const svc = new PgMemoryQueryService(noDb);
    await assert.rejects(
      () => svc.verifyLedger('engagement-x'),
      (e: unknown) => e instanceof MemoryQueryRejection && e.code === 'audit_unavailable',
    );
  });

  test('verifyLedger：链失败与锚点结论分别保留，ok 取两者之合', async () => {
    const calls: string[] = [];
    const svc = new PgMemoryQueryService(noDb, {
      ledgerVerifier: {
        verifyChain: async (engagementId) => {
          calls.push(`chain:${engagementId}`);
          return {
            ok: false,
            eventCount: 9,
            chainHead: 'f'.repeat(64),
            failures: [{ chainSeq: 4, detail: '前序哈希与重算结果不符' }],
          };
        },
        verifyAnchor: async (engagementId) => {
          calls.push(`anchor:${engagementId}`);
          return { ok: true, anchored: { id: 'anchor-1' }, mismatches: [] };
        },
      },
    });

    const view = await svc.verifyLedger('engagement-x');

    assert.deepEqual(calls, ['chain:engagement-x', 'anchor:engagement-x']);
    assert.equal(view.ok, false, '链失败时整体必须判为未通过');
    assert.equal(view.eventCount, 9);
    assert.deepEqual(view.failures, [{ chainSeq: 4, detail: '前序哈希与重算结果不符' }]);
    assert.equal(view.anchored, true);
    assert.deepEqual(view.mismatches, []);
    assert.ok(view.checkedAt.length > 0, '校验时间由服务端给出');
  });

  test('verifyLedger：无锚点判为未通过（未证明 ≠ 已证明完好）', async () => {
    const svc = new PgMemoryQueryService(noDb, {
      ledgerVerifier: {
        verifyChain: async () => ({ ok: true, eventCount: 0, chainHead: '0'.repeat(64), failures: [] }),
        verifyAnchor: async () => ({ ok: false, anchored: null, mismatches: [] }),
      },
    });

    const view = await svc.verifyLedger('engagement-y');

    assert.equal(view.ok, false);
    assert.equal(view.anchored, false);
    assert.deepEqual(view.mismatches, []);
  });
});
