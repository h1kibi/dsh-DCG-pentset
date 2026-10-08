/**
 * `src/memory/pg-worker-tools.ts` 的集成测试（设计文档 §8.6、§8.7、§7.1、§6.2.2、§9.2）。
 *
 * 只跑**真实 PostgreSQL**：用例覆盖的正是假实现模拟不到的东西——`uuid` 外键列、
 * 部分唯一索引（`worker_reports_current`）、延迟自引用外键、`memory_chunks` 的 CHECK、
 * 以及 002 触发器对可更新列的收窄。未设置 `PENTEST_DATABASE_URL` 时整体跳过。
 *
 * 连接用 `pg.Client`（单连接）而不是 Pool：报告取代必须「先让位、后插入」同事务完成，
 * 而 `BEGIN`/`COMMIT` 走连接池可能落到不同后端（见实现文件头的事务约定）。
 */

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import { Client } from 'pg';

import type { ToolError } from '../src/contracts.ts';
import { DEFAULTS, LIVE_SESSION_STATUSES } from '../src/contracts.ts';
import { compose } from '../src/compose.ts';
import { PgWorkerTools, PgWorkerToolRefusal } from '../src/memory/pg-worker-tools.ts';
import { RRF_K, RRF_UNIT, REASONING_LABEL } from '../src/memory/retrieval.ts';
import { sha256Hex } from '../src/memory/chunks.ts';
import { MemoryLedger } from '../src/memory/ledger.ts';
import type { DbClient } from '../src/db/port.ts';

const DATABASE_URL = process.env['PENTEST_DATABASE_URL'];

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
// 按外键依赖倒序删除，删完立刻切回 origin。`session_replication_role` 是**会话级**设置：
// `pool.query` 每次可能借出不同的连接，因此清理必须在显式取得的那一条连接上完成。

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

/** 一次检索/读取都能命中的关键词（ASCII：`simple` 分词配置下才切得出词元）。 */
const TOKEN = 'findme-token';

/** 放行拒绝的样例载荷：断言「原样带出」时逐字段比对。 */
const OK_REJECTION: ToolError = {
  status: 'blocked',
  code: 'scope_violation',
  message: '目标不在范围内',
  next_action: '改用范围内的目标',
};

describe('集成：真实 PostgreSQL（Worker 工具面 · 记忆与报告）', { skip: DATABASE_URL === undefined ? '未设置 PENTEST_DATABASE_URL' : false }, () => {
  let client: Client;
  let db: DbClient;
  /** 默认存根：只有 `requestApproval` 会用到执行服务。 */
  let tools: PgWorkerTools;
  let engagementId = '';
  let foreignEngagementId = '';
  let workerSessionId = '';
  let endedSessionId = '';
  let includedAssetId = '';
  let excludedAssetId = '';
  let includedChunkId = '';
  let includedEventId = '';
  let excludedEventId = '';
  let excludedChunkId = '';
  let reasoningChunkId = '';
  let reasoningEventId = '';
  let binaryChunkId = '';
  let textArtifactId = '';
  let sealedArtifactId = '';
  /**
   * 租约准入等用例另建的 engagement。
   *
   * 为什么不能复用主力 engagement：`worker_sessions_one_live_per_engagement` 是部分唯一索引
   * （同一 engagement 至多一个存活会话），而这些用例需要**额外的存活会话**来构造
   * 「已吊销 / 已过期 / 已离开存活集合」三种状态。另建 engagement 也顺带证明这些判定
   * 不是靠「只有一个会话」这种巧合成立的。
   */
  const extraEngagementIds: string[] = [];

  async function seedEngagement(id: string, name: string): Promise<void> {
    await client.query(
      `INSERT INTO pentest.engagements
         (id, tenant_id, name, status, current_status, target_snapshot, scope_snapshot,
          roe_snapshot, policy_snapshot, config_snapshot, created_by)
       VALUES ($1::uuid, 'test', $2, 'running', 'ready', '{}'::jsonb, '{}'::jsonb,
          '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, 'node-test')`,
      [id, name],
    );
  }

  async function seedSession(
    engagement: string,
    status: string,
    options: { readonly sessionKind?: 'intake' | 'phase'; readonly scopeVersion?: number } = {},
  ): Promise<string> {
    const id = randomUUID();
    // `session_kind` 是 §9.5 的**冻结列**（触发器禁止 UPDATE）：要造 intake 夹具只能插入时给。
    await client.query(
      `INSERT INTO pentest.worker_sessions
         (id, engagement_id, dsh_session_id, phase, profile_id, profile_revision, attempt,
          iteration, scope_version, task_prompt, tool_filter, skill_ids, model_route, status,
          session_kind)
       VALUES ($1::uuid, $2::uuid, $3, 'vulnerability-analysis', 'p', 'r1', 1, 1, $5, 'tp',
          '{}'::jsonb, '[]'::jsonb, '{}'::jsonb, $4, $6)`,
      [id, engagement, `dsh-${id}`, status, options.scopeVersion ?? 1, options.sessionKind ?? 'phase'],
    );

    // 存活态会话签一份**有效**租约。
    //
    // 两个理由，缺一不可：
    //   1. **数据真实**：§10.6 里一个正在工作的会话本就持有租约。「active 但无租约」
    //      是 §15.2 定义的孤儿状态，用它当测试种子是在测一个不该存在的场景。
    //   2. **并行测试隔离**：`compose.test.ts` 里有个用例会 `apply()` 并启动
    //      **全库对账**（`StartupRecovery.recoverAll()` 是产品行为——单实例启动时
    //      对账整库）。无租约的存活会话会被它判为孤儿、标记为 failed、并写审计事件。
    //      那会让本文件的会话在断言前变成终态，于是 `writeStatusNote` 正确地拒绝写入
    //      （终态不收滞后便签）——测试失败，但产品行为是对的。
    //
    // 终态会话不签：它们的租约本该已吊销，签了反而掩盖清理逻辑的问题。
    if ((LIVE_SESSION_STATUSES as readonly string[]).includes(status)) {
      await client.query(
        `INSERT INTO pentest.session_leases (engagement_id, worker_session_id, generation, expires_at)
         VALUES ($1::uuid, $2::uuid, 1, now() + interval '1 hour')`,
        [engagement, id],
      );
    }
    return id;
  }

  /**
   * 另建一个只含单个会话的 engagement，供租约准入用例使用。
   *
   * 为什么必须另建：`worker_sessions_one_live_per_engagement` 是部分唯一索引
   * （同一 engagement 至多一个存活会话），而这些用例需要额外的存活会话来构造
   * 「已吊销 / 已过期 / 已离开存活集合」三种状态。另建也顺带证明判定不是靠
   * 「本文件只有一个会话」这种巧合成立的。返回的 engagement 会登记进
   * `extraEngagementIds` 以便清理。
   */
  async function seedIsolatedSession(
    status: string,
    lease?: 'revoked' | 'expired' | 'never',
    options: { readonly sessionKind?: 'intake' | 'phase'; readonly scopeVersion?: number } = {},
  ): Promise<{ engagementId: string; sessionId: string }> {
    const engagement = randomUUID();
    extraEngagementIds.push(engagement);
    await seedEngagement(engagement, `lease-fixture-${engagement.slice(0, 8)}`);
    const sessionId = await seedSession(engagement, status, options);
    if (lease === 'revoked') {
      await client.query(
        `UPDATE pentest.session_leases SET revoked_at = now(), revoked_reason = 'human_revoke'
          WHERE worker_session_id = $1::uuid AND revoked_at IS NULL`,
        [sessionId],
      );
    } else if (lease === 'never') {
      // 「从未签发」与「已吊销」是两种不同的事实，报的错误码也不同（`lease_required`
      // vs `lease_revoked`）——分开造夹具才能锁住这个区别。
      await client.query(
        'DELETE FROM pentest.session_leases WHERE worker_session_id = $1::uuid',
        [sessionId],
      );
    } else if (lease === 'expired') {
      // 到期时间**不得回退**（§10.6 的租约触发器：续租只允许前推），因此不能把已签发的
      // 租约改成过去时间。改为删掉它、直接插一条「签发时就已过期、尚未被清扫」的租约——
      // 那正是 PgLeaseStore.revokeExpiredLeases 跑起来之前库里的真实形态。
      await client.query(
        'DELETE FROM pentest.session_leases WHERE worker_session_id = $1::uuid',
        [sessionId],
      );
      await client.query(
        `INSERT INTO pentest.session_leases
           (engagement_id, worker_session_id, generation, issued_at, expires_at, last_heartbeat_at)
         VALUES ($1::uuid, $2::uuid, 1, now() - interval '2 hours', now() - interval '1 hour',
                 now() - interval '2 hours')`,
        [engagement, sessionId],
      );
    }
    return { engagementId: engagement, sessionId };
  }

  async function seedEvent(input: {
    readonly engagement: string;
    readonly workerSessionId: string | null;
    readonly eventType: string;
    readonly chainSeq: number;
    readonly trustLevel: string;
    readonly classification: string;
    readonly payload: unknown;
  }): Promise<string> {
    const eventId = randomUUID();
    await client.query(
      `INSERT INTO pentest.context_events
         (event_id, engagement_id, worker_session_id, dsh_session_id, source_system, source_id,
          source_seq, event_type, schema_version, occurred_at, chain_seq, payload_json,
          raw_payload_zstd, classification, trust_level, event_hash)
       VALUES ($1::uuid, $2::uuid, $3::uuid, $4, 'dsh-session', $5, $6, $7, 1, now(), $6,
          $8::jsonb, $9, $10, $11, $12)`,
      [
        eventId,
        input.engagement,
        input.workerSessionId,
        input.workerSessionId === null ? null : `dsh-${input.workerSessionId}`,
        `src-${input.chainSeq}`,
        input.chainSeq,
        input.eventType,
        JSON.stringify(input.payload),
        Buffer.from(`raw-${eventId}`),
        input.classification,
        input.trustLevel,
        Buffer.from(sha256Hex(eventId), 'hex'),
      ],
    );
    return eventId;
  }

  async function seedChunk(input: {
    readonly engagement: string;
    readonly sourceEventId: string;
    readonly content: string;
    readonly assetIds: readonly string[];
    readonly workerSessionId: string | null;
    readonly trustLevel: string;
    readonly classification: string;
    readonly indexed: boolean;
  }): Promise<string> {
    const id = randomUUID();
    await client.query(
      `INSERT INTO pentest.memory_chunks
         (id, engagement_id, source_event_id, ordinal, content, content_hash, search_vector,
          embedding_revision, phase, worker_session_id, asset_ids, finding_ids, trust_level,
          classification)
       VALUES ($1::uuid, $2::uuid, $3::uuid, 0, $4, $5,
          CASE WHEN $7::boolean THEN to_tsvector('simple', $4) ELSE NULL END,
          'rev-1', 'vulnerability-analysis', $6::uuid, $8::uuid[], '{}'::uuid[], $9, $10)`,
      [
        id,
        input.engagement,
        input.sourceEventId,
        input.content,
        sha256Hex(input.content),
        input.workerSessionId,
        input.indexed,
        [...input.assetIds],
        input.trustLevel,
        input.classification,
      ],
    );
    return id;
  }

  before(async () => {
    client = new Client({ connectionString: DATABASE_URL });
    await client.connect();
    // `pg.Client.query` 与本项目的最小端口结构性一致（与 ledger 集成测试同样处理）。
    db = client as unknown as DbClient;

    engagementId = randomUUID();
    foreignEngagementId = randomUUID();
    await seedEngagement(engagementId, 'pg-worker-tools');
    await seedEngagement(foreignEngagementId, 'pg-worker-tools-foreign');

    // 检索强制按当前生效嵌入版本过滤（§9）；没有生效版本时任何分块都不匹配。
    await client.query(
      `INSERT INTO pentest.embedding_revisions (engagement_id, revision, model, dimensions, is_active)
       VALUES ($1::uuid, 'rev-1', 'test-embed', 1024, true),
              ($2::uuid, 'rev-1', 'test-embed', 1024, true)`,
      [engagementId, foreignEngagementId],
    );

    workerSessionId = await seedSession(engagementId, 'active');
    await client.query(
      `update pentest.engagements set active_agent_session_id = $2::uuid where id = $1::uuid`,
      [engagementId, workerSessionId],
    );
    endedSessionId = await seedSession(engagementId, 'superseded');
    includedAssetId = randomUUID();
    excludedAssetId = randomUUID();
    await client.query(
      `INSERT INTO pentest.assets (id, engagement_id, canonical_target, kind, first_seen_iteration)
       VALUES ($1::uuid, $2::uuid, 'in.target.test', 'host', 1),
              ($3::uuid, $2::uuid, 'out.target.test', 'host', 1)`,
      [includedAssetId, engagementId, excludedAssetId],
    );
    await client.query(
      `INSERT INTO pentest.asset_scope_versions (asset_id, scope_version, engagement_id, decision)
       VALUES ($1::uuid, 1, $2::uuid, 'included'), ($3::uuid, 1, $2::uuid, 'excluded')`,
      [includedAssetId, engagementId, excludedAssetId],
    );

    // 三个都能被同一关键词命中的分块：已纳入资产、被排除资产、空归属（思考链）。
    includedEventId = await seedEvent({
      engagement: engagementId,
      workerSessionId,
      eventType: 'tool.result',
      chainSeq: 1,
      trustLevel: 'tool_observation',
      classification: 'engagement',
      payload: { command: `probe ${TOKEN}`, stdout: `${TOKEN} in scope` },
    });
    includedChunkId = await seedChunk({
      engagement: engagementId,
      sourceEventId: includedEventId,
      content: `工具调用 目标: in.target.test 命令: probe ${TOKEN}`,
      assetIds: [includedAssetId],
      workerSessionId,
      trustLevel: 'tool_observation',
      classification: 'engagement',
      indexed: true,
    });

    excludedEventId = await seedEvent({
      engagement: engagementId,
      workerSessionId,
      eventType: 'tool.result',
      chainSeq: 2,
      trustLevel: 'tool_observation',
      classification: 'engagement',
      payload: { command: `probe ${TOKEN}`, secret: 'excluded event payload' },
    });
    excludedChunkId = await seedChunk({
      engagement: engagementId,
      sourceEventId: excludedEventId,
      content: `EXCLUDED-SECRET-9f ${TOKEN} 目标: out.target.test`,
      assetIds: [excludedAssetId],
      workerSessionId,
      trustLevel: 'tool_observation',
      classification: 'engagement',
      indexed: true,
    });

    // 思考链：asset_ids 为空（§8.6「空归属放行」），必须仍能被检索到。
    reasoningEventId = await seedEvent({
      engagement: engagementId,
      workerSessionId,
      eventType: 'llm.reasoning',
      chainSeq: 3,
      trustLevel: 'model_reasoning',
      classification: 'reasoning',
      payload: { text: `${TOKEN} 的归属尚未确定` },
    });
    reasoningChunkId = await seedChunk({
      engagement: engagementId,
      sourceEventId: reasoningEventId,
      content: `推理: ${TOKEN} 的归属尚未确定，先按空归属记录`,
      assetIds: [],
      workerSessionId,
      trustLevel: 'model_reasoning',
      classification: 'reasoning',
      indexed: true,
    });

    // 二进制证据：§8.5 只存元数据、不建全文与向量索引 → search_vector 为空，不进入检索。
    const binaryEventId = await seedEvent({
      engagement: engagementId,
      workerSessionId,
      eventType: 'tool.artifact',
      chainSeq: 4,
      trustLevel: 'tool_observation',
      classification: 'binary',
      payload: { binary: { sha256: `b-${TOKEN}` } },
    });
    binaryChunkId = await seedChunk({
      engagement: engagementId,
      sourceEventId: binaryEventId,
      content: `二进制证据元数据 MIME: image/png 协议解析摘要: ${TOKEN}`,
      assetIds: [includedAssetId],
      workerSessionId,
      trustLevel: 'tool_observation',
      classification: 'binary',
      indexed: false,
    });

    // 另一个 engagement 的分块：跨 engagement 引用必须被拒。
    const foreignEventId = await seedEvent({
      engagement: foreignEngagementId,
      workerSessionId: null,
      eventType: 'tool.result',
      chainSeq: 1,
      trustLevel: 'tool_observation',
      classification: 'engagement',
      payload: { stdout: `FOREIGN-SECRET ${TOKEN}` },
    });
    await seedChunk({
      engagement: foreignEngagementId,
      sourceEventId: foreignEventId,
      content: `FOREIGN-SECRET ${TOKEN}`,
      assetIds: [],
      workerSessionId: null,
      trustLevel: 'tool_observation',
      classification: 'engagement',
      indexed: true,
    });

    textArtifactId = randomUUID();
    sealedArtifactId = randomUUID();
    await client.query(
      `INSERT INTO pentest.artifacts
         (id, engagement_id, worker_session_id, kind, media_type, byte_size, storage_kind,
          storage_path, inline_content, content_hash, encrypted, classification, truncated, metadata)
       VALUES ($1::uuid, $2::uuid, $3::uuid, 'http_body', 'text/plain', 11, 'inline', NULL, $4,
               $5, false, 'engagement', false, '{"source":"probe"}'::jsonb),
              ($6::uuid, $2::uuid, $3::uuid, 'dump', 'application/octet-stream', 8, 'inline', NULL,
               $7, $8, true, 'binary', false, '{"source":"dump"}'::jsonb)`,
      [
        textArtifactId,
        engagementId,
        workerSessionId,
        Buffer.from('hello world'),
        sha256Hex('hello world'),
        sealedArtifactId,
        Buffer.from('cipher!!'),
        sha256Hex('cipher!!'),
      ],
    );

    const ledger = new MemoryLedger({ db, txDb: db, secret: 'worker-tools-test-secret-32-bytes-min' });
    tools = new PgWorkerTools(db, {
      executor: {
        admit: async (): Promise<never> => {
          throw new Error('requestApproval 用例会换成专门的存根');
        },
      },
      ledger,
      txDb: db,
    });
  });

  after(async () => {
    // 单条 Client 即同一条会话：`session_replication_role` 在这里设置是可靠的
    // （若是 pool，就必须先 `connect()` 固定一条连接）。
    let replicaActive = false;
    try {
      // §9.5 的追加写触发器（context_events、memory_access_log 等）拒绝 DELETE，而这些表又通过外键
      // 把 engagements / worker_sessions 钉住；兄弟测试的启动对账还会往 context_events 补写审计行
      // （实测：不解除这一层，每次运行都留下一整套 engagement + 会话 + 事件）。
      // 切到 replica 角色后用户触发器与 FK 触发器都不触发，才能把本文件的种子按依赖倒序删干净。
      await client.query("SET session_replication_role = 'replica'");
      replicaActive = true;
      const ids = [engagementId, foreignEngagementId, ...extraEngagementIds];
      for (const statement of RING_BREAKERS) await client.query(statement, [ids]);
      for (const statement of CLEANUP_STATEMENTS) await client.query(statement, [ids]);
    } finally {
      try {
        // 恢复不能被吞：这条连接随后还要被关闭，但带着 replica 语义的任何后续查询
        // （含 close 前的隐式语句）都会静默失去触发器与 FK 保护。
        if (replicaActive) await client.query("SET session_replication_role = 'origin'");
      } finally {
        // 客户端必须关闭：否则挂起的连接会让 node:test 进程一直不退出。
        await client.end();
      }
    }
  });

  it('RLS：worker 读取审计使用当前 worker_session_id，而非 null 或其它会话', async () => {
    const composed = compose({
      database: { url: DATABASE_URL! },
      ledgerSecret: 'worker-rls-test-secret-32-bytes-min',
      sandbox: {
        allowedImages: [{ name: 'registry.example/test', digest: `sha256:${'a'.repeat(64)}` }],
        internalNetwork: 'pentest-sandbox',
      },
      rlsContext: { tenantId: 'test' },
    });
    try {
      const result = await composed.hostServices.workerTools.read({ workerSessionId, refs: [`memory:${includedChunkId}`] });
      assert.equal(result[0]?.memoryId, includedChunkId);
      const audit = await client.query<{ worker_session_id: string }>(
        `select worker_session_id from pentest.memory_access_log
          where engagement_id = $1::uuid and access_kind = 'memory_read'
          order by id desc limit 1`,
        [engagementId],
      );
      assert.equal(audit.rows[0]?.worker_session_id, workerSessionId);
    } finally {
      await composed.dispose();
    }
  });


  it('检索：被排除资产的分块不返回，空归属的思考链分块返回', async () => {
    const result = await tools.search({ workerSessionId, query: TOKEN });
    const ids = result.hits.map((hit) => hit.memoryId);
    assert.ok(ids.includes(includedChunkId), '已纳入资产的分块必须在结果里');
    assert.ok(ids.includes(reasoningChunkId), '空 asset_ids 的思考链分块必须被放行（§8.6）');
    assert.ok(!ids.includes(excludedChunkId), '含被排除资产的分块必须不可见（排除是硬边界）');

    const serialized = JSON.stringify(result);
    assert.ok(serialized.includes(TOKEN), '命中片段应含检索词，证明检索真的命中了索引');
    assert.ok(
      !serialized.includes('EXCLUDED-SECRET-9f'),
      '被排除资产的内容不得以任何字段泄漏（摘录、来源、引用都不行）',
    );
    assert.ok(result.indexWatermark > 0, '索引水位应反映已索引事件的最大链序号');

    const reasoning = result.hits.find((hit) => hit.memoryId === reasoningChunkId);
    assert.equal(reasoning?.trust, 'model_reasoning');
    // §8.3：思考链必须带标注；命中的形状里只有摘录字段能承载它。
    assert.match(reasoning?.excerpt ?? '', new RegExp(REASONING_LABEL));
    assert.equal(reasoning?.source.eventId, reasoningEventId, '来源事件必须是账本事件标识');
  });

  it('检索：未建全文索引的分块（§8.5 二进制证据）不进入结果', async () => {
    const result = await tools.search({ workerSessionId, query: TOKEN, limit: 20 });
    assert.ok(
      !result.hits.some((hit) => hit.memoryId === binaryChunkId),
      'search_vector 为空表示该分块不参与检索（§8.5 只存元数据）',
    );
    assert.ok(result.hits.some((hit) => hit.memoryId === includedChunkId));
  });

  it('检索：include_reasoning=false 只排除思考链，其余照旧（§8.3 是筛选开关不是权限门禁）', async () => {
    const result = await tools.search({
      workerSessionId,
      query: TOKEN,
      includeReasoning: false,
      limit: 20,
    });
    const ids = result.hits.map((hit) => hit.memoryId);
    assert.ok(!ids.includes(reasoningChunkId));
    assert.ok(ids.includes(includedChunkId), '同一批次里的非思考链条目不受影响');
  });

  it('检索：条目来源的分块按条目种类与来源事件还原（§8.5 / §9.2 的 memory_item_id 分支）', async () => {
    const itemId = randomUUID();
    await client.query(
      `INSERT INTO pentest.memory_items
         (id, engagement_id, kind, content, trust_level, status, source_event_ids, created_by)
       VALUES ($1::uuid, $2::uuid, 'fact', $3, 'tool_observation', 'candidate', $4::uuid[],
          'node-test')`,
      [itemId, engagementId, `规范化事实：${TOKEN} 已确认`, [includedEventId]],
    );
    const itemChunkId = randomUUID();
    const content = `事实: ${TOKEN} 已确认（条目 ${itemId}）`;
    await client.query(
      `INSERT INTO pentest.memory_chunks
         (id, engagement_id, memory_item_id, ordinal, content, content_hash, search_vector,
          embedding_revision, worker_session_id, asset_ids, finding_ids, trust_level, classification)
       VALUES ($1::uuid, $2::uuid, $3::uuid, 0, $4, $5, to_tsvector('simple', $4), 'rev-1',
          $6::uuid, $7::uuid[], '{}'::uuid[], 'tool_observation', 'engagement')`,
      [itemChunkId, engagementId, itemId, content, sha256Hex(content), workerSessionId, [includedAssetId]],
    );

    const result = await tools.search({ workerSessionId, query: TOKEN, kinds: ['fact'], limit: 20 });
    const hit = result.hits.find((candidate) => candidate.memoryId === itemChunkId);
    assert.ok(hit !== undefined, '条目来源的分块必须参与检索，并按其种类命中 kinds 过滤');
    // 条目来源没有 source_event，来源事件回退到条目声明的来源事件（引用可追溯）。
    assert.equal(hit.source.eventId, includedEventId);
  });

  it('检索：结果写入检索审计（§8.7），过滤器取值越界一律拒绝（§10.2.1）', async () => {
    await tools.search({ workerSessionId, query: TOKEN, kinds: ['tool_observation'] });
    const queries = await client.query<{ origin: string; filters: { kinds?: string[] } }>(
      `SELECT origin, filters FROM pentest.retrieval_queries
        WHERE engagement_id = $1::uuid AND filters->'kinds' @> '["tool_observation"]'::jsonb
        ORDER BY created_at DESC, id DESC`,
      [engagementId],
    );
    assert.equal(queries.rowCount, 1, '每次检索写一条检索记录');
    assert.equal(queries.rows[0]?.origin, 'worker');
    assert.deepEqual(queries.rows[0]?.filters.kinds, ['tool_observation']);

    const hits = await client.query<{ rank: number; final_score: string }>(
      `SELECT h.rank, h.final_score
         FROM pentest.retrieval_hits h
         JOIN pentest.retrieval_queries q ON q.id = h.query_id
        WHERE q.engagement_id = $1::uuid AND q.filters->'kinds' @> '["tool_observation"]'::jsonb
        ORDER BY h.rank`,
      [engagementId],
    );
    assert.ok(hits.rowCount !== null && hits.rowCount >= 1, '命中必须落审计（§8.7 写入检索记录）');
    assert.equal(hits.rows[0]?.rank, 1, '命中按名次编号，从 1 起');
    // 最终分与融合层一致：RRF 至多三路各贡献 1/(k+1)，权威度与时效性只加不减。
    const top = Number(hits.rows[0]?.final_score ?? 0);
    assert.ok(top >= RRF_UNIT, `最终分应至少含一个 RRF 单位（k=${RRF_K}）`);
    assert.ok(top <= 4 * RRF_UNIT, '最终分不应超出三路 RRF 与叠加项的上界');

    await assert.rejects(
      () => tools.search({ workerSessionId, query: TOKEN, kinds: ['not-a-kind'] }),
      (error: unknown) =>
        error instanceof PgWorkerToolRefusal && error.code === 'classification_rejected',
    );
    await assert.rejects(
      () => tools.search({ workerSessionId: randomUUID(), query: TOKEN }),
      (error: unknown) => error instanceof PgWorkerToolRefusal && error.code === 'lease_required',
      '没有会话绑定就没有 engagement：不接受任何调用方提供的范围',
    );
  });

  it('检索：注入查询向量化后向量路参与融合；未注入时不伪造向量也不误伤其余两路', async () => {
    // 内容与检索词不共享任何三元组（不同文字系统），只有向量路可能命中。
    const vectorEventId = await seedEvent({
      engagement: engagementId,
      workerSessionId,
      eventType: 'tool.result',
      chainSeq: 5,
      trustLevel: 'tool_observation',
      classification: 'engagement',
      payload: { stdout: '内核转储分析完毕' },
    });
    const vectorChunkId = await seedChunk({
      engagement: engagementId,
      sourceEventId: vectorEventId,
      content: '量子回声 内核转储 分析完毕',
      assetIds: [includedAssetId],
      workerSessionId,
      trustLevel: 'tool_observation',
      classification: 'engagement',
      indexed: true,
    });
    const axis = `[${Array.from({ length: 1024 }, (_, index) => (index === 0 ? '1' : '0')).join(',')}]`;
    await client.query(
      `UPDATE pentest.memory_chunks SET embedding = $1::vector WHERE id = $2::uuid`,
      [axis, vectorChunkId],
    );

    const plain = await tools.search({ workerSessionId, query: TOKEN, limit: 20 });
    assert.ok(
      !plain.hits.some((hit) => hit.memoryId === vectorChunkId),
      '未注入向量化时不得有向量路命中（也不得凭语义猜测）',
    );

    const semantic = new PgWorkerTools(db, {
      executor: {
        admit: async (): Promise<never> => {
          throw new Error('本用例不涉及放行');
        },
      },
      embedQuery: async () => [1, ...Array.from({ length: 1023 }, () => 0)],
    });
    const withVector = await semantic.search({ workerSessionId, query: TOKEN, limit: 20 });
    assert.ok(
      withVector.hits.some((hit) => hit.memoryId === vectorChunkId),
      '向量路必须把最近邻带回融合（§8.6 三路之一）',
    );
    assert.ok(
      withVector.hits.some((hit) => hit.memoryId === includedChunkId),
      '注入向量后其余两路照常参与',
    );
  });

  // ───────────────────────────── §8.7 按标识读取 ─────────────────────────────

  it('读取：memory:/event: 返回内容、哈希与关联事件；跨 engagement 引用被拒且不泄露存在性', async () => {
    const records = await tools.read({
      workerSessionId,
      refs: [`memory:${includedChunkId}`, `event:${reasoningEventId}`],
    });
    assert.equal(records.length, 2);
    const [chunkRecord, eventRecord] = [records[0]!, records[1]!];
    assert.equal(chunkRecord.memoryId, includedChunkId);
    assert.equal(chunkRecord.contentHash, sha256Hex(chunkRecord.content), '内容哈希描述返回的内容');
    assert.deepEqual(chunkRecord.relatedEventIds, [includedEventId]);
    assert.equal(chunkRecord.originWorkerSessionId, workerSessionId);
    assert.equal(chunkRecord.classification, 'engagement');
    assert.equal(eventRecord.memoryId, reasoningEventId);
    assert.match(eventRecord.content, new RegExp(TOKEN));
    assert.equal(eventRecord.trust, 'model_reasoning');

    const foreignRef = await client.query<{ id: string }>(
      'select id from pentest.memory_chunks where engagement_id = $1::uuid limit 1',
      [foreignEngagementId],
    );
    const denied = async (ref: string): Promise<PgWorkerToolRefusal> => {
      try {
        await tools.read({ workerSessionId, refs: [ref] });
      } catch (error) {
        assert.ok(error instanceof PgWorkerToolRefusal);
        return error;
      }
      throw new Error(`引用 ${ref} 本应被拒绝`);
    };
    const foreign = await denied(`memory:${foreignRef.rows[0]?.id as string}`);
    const missing = await denied(`memory:${randomUUID()}`);
    // 跨 engagement 与不存在返回同一个码、同一段措辞：不泄露存在性（§18.4）。
    assert.equal(foreign.code, 'scope_violation');
    assert.equal(missing.code, foreign.code);
    assert.equal(missing.payload.next_action, foreign.payload.next_action);
    for (const refusal of [foreign, missing]) {
      assert.match(refusal.payload.message, /^引用不可用/u);
      assert.ok(
        !refusal.payload.message.includes('FOREIGN-SECRET'),
        '拒绝信息不得回流内容或存在性细节',
      );
    }

    // 条目来源（memory_items）没有资产归属列：只做 engagement 边界，条目自身声明种类与可信度。
    const itemId = randomUUID();
    await client.query(
      `INSERT INTO pentest.memory_items
         (id, engagement_id, kind, content, trust_level, status, source_event_ids, created_by)
       VALUES ($1::uuid, $2::uuid, 'fact', '规范化事实：入口 3 个', 'tool_observation', 'candidate',
          $3::uuid[], 'node-test')`,
      [itemId, engagementId, [includedEventId]],
    );
    const itemRecords = await tools.read({ workerSessionId, refs: [`memory:${itemId}`] });
    assert.equal(itemRecords[0]?.memoryId, itemId);
    assert.equal(itemRecords[0]?.content, '规范化事实：入口 3 个');
    assert.equal(itemRecords[0]?.contentHash, sha256Hex('规范化事实：入口 3 个'));
    assert.deepEqual(itemRecords[0]?.relatedEventIds, [includedEventId]);
    assert.equal(itemRecords[0]?.classification, 'engagement');

    // 直接读取也要过范围过滤：被排除资产的分块不能靠引用绕过检索（§8.6）。
    await assert.rejects(
      () => tools.read({ workerSessionId, refs: [`memory:${excludedChunkId}`] }),
      (error: unknown) => error instanceof PgWorkerToolRefusal && error.code === 'scope_violation',
    );

    await assert.rejects(
      () => tools.read({ workerSessionId, refs: [`event:${excludedEventId}`] }),
      (error: unknown) =>
        error instanceof PgWorkerToolRefusal &&
        error.code === 'scope_violation' &&
        !error.message.includes('excluded event payload'),
      '事件只有被排除分块时不得回退返回原始 payload',
    );

    // 非法引用形态（无法归类）直接拒绝，不做尽力解析。
    await assert.rejects(
      () => tools.read({ workerSessionId, refs: ['artifact:xyz'] }),
      (error: unknown) =>
        error instanceof PgWorkerToolRefusal && error.code === 'classification_rejected',
    );
  });

  // ───────────────────────────── §8.7 / §9.2 证据读取 ─────────────────────────────

  it('证据：未加密文本内联返回；encrypted=true 只返回受控引用，不发原始字节', async () => {
    const text = await tools.readArtifact({ workerSessionId, artifactId: textArtifactId });
    assert.equal(text.inline, 'hello world');
    assert.equal(text.byteSize, 11);
    assert.equal(text.truncated, false);
    assert.deepEqual(text.metadata, { source: 'probe' });

    const sealed = await tools.readArtifact({ workerSessionId, artifactId: sealedArtifactId });
    assert.equal(sealed.inline, undefined, '加密证据不得把原始字节交给模型（§11.3）');
    assert.equal(sealed.storageRef, `artifact:${sealedArtifactId}`);
    assert.equal(sealed.truncated, true, '未返回完整内容时必须标记截断');

    await assert.rejects(
      () => tools.readArtifact({ workerSessionId, artifactId: randomUUID() }),
      (error: unknown) => error instanceof PgWorkerToolRefusal && error.code === 'scope_violation',
    );

    const access = await client.query<{ access_kind: string }>(
      'select access_kind from pentest.memory_access_log where engagement_id = $1::uuid order by id',
      [engagementId],
    );
    const kinds = access.rows.map((row) => row.access_kind);
    assert.ok(kinds.includes('memory_read') && kinds.includes('artifact_read'), '读取必须留审计');
  });

  // ───────────────────────────── §7.1 / §9.2 报告取代 ─────────────────────────────

  it('报告：同一 attempt 的取代按「先让位、后插入」在延迟外键下成功', async () => {
    const note = '已确认三个 Web 入口；下一步验证越权读取';
    const first = await tools.submitReport({
      workerSessionId,
      leaseGeneration: 1,
      report: {
        status: 'report_ready',
        objective: '第一轮',
        summary: '第一份报告',
        payload: { facts: ['a'] },
      },
    });
    const second = await tools.submitReport({
      workerSessionId,
      leaseGeneration: 1,
      report: {
        status: 'report_ready',
        objective: '第一轮',
        summary: '第二份报告（取代前一份）',
        statusNote: note,
        payload: { facts: ['a', 'b'] },
      },
    });
    assert.notEqual(first.reportId, second.reportId);

    const reports = await client.query<{
      id: string;
      attempt: number;
      supersedes_id: string | null;
      superseded_by: string | null;
    }>(
      `SELECT id, attempt, supersedes_id, superseded_by
         FROM pentest.worker_reports WHERE worker_session_id = $1::uuid ORDER BY created_at, id`,
      [workerSessionId],
    );
    const byId = new Map(reports.rows.map((row) => [row.id, row]));
    const firstRow = byId.get(first.reportId);
    const secondRow = byId.get(second.reportId);
    assert.ok(firstRow !== undefined && secondRow !== undefined);
    // 取代是双向记录：旧行写 superseded_by，新行写 supersedes_id。
    assert.equal(firstRow.superseded_by, second.reportId);
    assert.equal(secondRow.supersedes_id, first.reportId);
    assert.equal(secondRow.superseded_by, null);
    assert.equal(secondRow.attempt, 1);
    assert.equal(
      reports.rows.filter((row) => row.superseded_by === null).length,
      1,
      '每个 (会话, attempt) 只能有一份当前报告',
    );

    // 会话进入等待人工（§13.4），并带上报告里的便签与来源标记（§6.2.2 的第二种载体）。
    const session = await client.query<{
      status: string;
      status_note: string | null;
      status_note_source: string | null;
    }>(
      'select status, status_note, status_note_source from pentest.worker_sessions where id = $1::uuid',
      [workerSessionId],
    );
    assert.equal(session.rows[0]?.status, 'waiting_human');
    assert.equal(session.rows[0]?.status_note, note);
    assert.equal(session.rows[0]?.status_note_source, 'agent');
    const engagement = await client.query<{ current_status: string; state_version: number | string }>(
      'select current_status, state_version from pentest.engagements where id = $1::uuid',
      [engagementId],
    );
    assert.equal(Number(engagement.rows[0]?.state_version), 2, '两次生产 Worker 报告各推进一次 engagement state_version');
    // Agent 侧报告**不写转移行**：`worker_running → waiting_human_review` 在 §5.2 的图上
    // 是 `recorded: false` 的边（§5.4 只规范人类操作），只有版本推进与领域事件。
    // 这条断言此前锁在 `pg-workflow.test.ts` 的 `SessionFlow.finishWorker` 上，
    // 而那是生产不可达的重复实现（2026-10-05 复核 F3 已删除）——现在由生产路径自己证明。
    const ghost = await client.query<{ n: number }>(
      `select count(*)::int as n from pentest.state_transitions
        where engagement_id = $1::uuid and from_status = 'worker_running' and to_status = 'waiting_human_review'`,
      [engagementId],
    );
    assert.equal(ghost.rows[0]?.n, 0, 'Agent 提交报告不得写图上 recorded:false 的边');
    const events = await client.query<{ event_type: string }>(
      `select event_type from pentest.context_events
        where engagement_id = $1::uuid and worker_session_id = $2::uuid
          and event_type in ('worker.report', 'worker.status_note', 'worker.waiting_human')
        order by chain_seq`,
      [engagementId, workerSessionId],
    );
    assert.deepEqual(
      events.rows.map((row) => row.event_type),
      [
        'worker.report', 'worker.status_note', 'worker.waiting_human',
        'worker.report', 'worker.status_note', 'worker.waiting_human',
      ],
    );
    const notes = await client.query<{ payload_json: Record<string, unknown> }>(
      `select payload_json from pentest.context_events
        where engagement_id = $1::uuid and worker_session_id = $2::uuid
          and event_type = 'worker.status_note'
        order by chain_seq`,
      [engagementId, workerSessionId],
    );
    assert.equal(notes.rows[0]?.payload_json['note'], '第一份报告');
    assert.equal(notes.rows[0]?.payload_json['source'], 'derived');
    assert.equal(notes.rows[0]?.payload_json['reportId'], first.reportId);
    assert.equal(notes.rows[1]?.payload_json['note'], note);
    assert.equal(notes.rows[1]?.payload_json['source'], 'agent');
    assert.equal(notes.rows[1]?.payload_json['reportId'], second.reportId);
    const reportEvent = await client.query<{ payload_json: Record<string, unknown> }>(
      `select payload_json from pentest.context_events
        where engagement_id = $1::uuid and worker_session_id = $2::uuid
          and event_type = 'worker.report'
        order by chain_seq desc limit 1`,
      [engagementId, workerSessionId],
    );
    assert.deepEqual(reportEvent.rows[0]?.payload_json, {
      reportId: second.reportId,
      status: 'report_ready',
      objective: '第一轮',
      summary: '第二份报告（取代前一份）',
      payload: { facts: ['a', 'b'] },
    });
  });

  it('报告：未提供状态便签时从 summary 派生并记录来源事件', async () => {
    const summary = '下一步核实允许的 Web 入口';
    const submitted = await tools.submitReport({
      workerSessionId,
      leaseGeneration: 1,
      report: { status: 'blocked', objective: '验证入口', summary, payload: {} },
    });
    const session = await client.query<{ status_note: string; status_note_source: string }>(
      'select status_note, status_note_source from pentest.worker_sessions where id = $1::uuid',
      [workerSessionId],
    );
    assert.equal(session.rows[0]?.status_note, summary);
    assert.equal(session.rows[0]?.status_note_source, 'derived');

    const event = await client.query<{ payload_json: Record<string, unknown> }>(
      `select payload_json from pentest.context_events
        where engagement_id = $1::uuid and worker_session_id = $2::uuid
          and event_type = 'worker.status_note'
          and payload_json->>'reportId' = $3
        order by chain_seq desc limit 1`,
      [engagementId, workerSessionId, submitted.reportId],
    );
    assert.equal(event.rows[0]?.payload_json['note'], summary);
    assert.equal(event.rows[0]?.payload_json['source'], 'derived');
    assert.equal(event.rows[0]?.payload_json['reportId'], submitted.reportId);
  });

  it('报告：重做推进世代后，旧世代提交被拒且不写报告', async () => {
    await client.query(
      `update pentest.worker_sessions
          set status = 'superseded', ended_at = now(), status_reason = 'redo'
        where id = $1::uuid`,
      [workerSessionId],
    );
    const staleSessionId = await seedSession(engagementId, 'active');
    await client.query(
      `update pentest.engagements set active_agent_session_id = $2::uuid where id = $1::uuid`,
      [engagementId, staleSessionId],
    );
    await client.query(
      `update pentest.session_leases
          set revoked_at = now(), revoked_reason = 'superseded'
        where worker_session_id = $1::uuid and revoked_at is null`,
      [staleSessionId],
    );
    await client.query(
      `insert into pentest.session_leases (engagement_id, worker_session_id, generation, expires_at)
       values ($1::uuid, $2::uuid, 2, now() + interval '1 hour')`,
      [engagementId, staleSessionId],
    );
    await assert.rejects(
      () => tools.submitReport({
        workerSessionId: staleSessionId,
        leaseGeneration: 1,
        report: { status: 'report_ready', objective: '旧', summary: '旧世代', payload: {} },
      }),
      (error: unknown) => error instanceof PgWorkerToolRefusal && error.code === 'lease_generation_stale',
    );
    const reports = await client.query(
      `select 1 from pentest.worker_reports where worker_session_id = $1::uuid`,
      [staleSessionId],
    );
    assert.equal(reports.rowCount, 0);
  });

  it('报告：非当前活动会话的滞后提交被拒且不推进 engagement', async () => {
    const previousSession = await client.query<{ id: string }>(
      `select ws.id from pentest.engagements e
        join pentest.worker_sessions ws on ws.id = e.active_agent_session_id
       where e.id = $1::uuid`,
      [engagementId],
    );
    if (previousSession.rows[0] !== undefined) {
      await client.query(
        `update pentest.worker_sessions
            set status = 'superseded', ended_at = now(), status_reason = 'stale'
          where worker_sessions.id = $1::uuid`,
        [previousSession.rows[0].id],
      );
    }
    const staleSessionId = await seedSession(engagementId, 'active');
    await client.query(
      `update pentest.engagements set active_agent_session_id = null where id = $1::uuid`,
      [engagementId],
    );
    await assert.rejects(
      () => tools.submitReport({
        workerSessionId: staleSessionId,
        leaseGeneration: 1,
        report: { status: 'report_ready', objective: '滞后', summary: '不应写入', payload: {} },
      }),
      (error: unknown) => error instanceof PgWorkerToolRefusal && error.code === 'lease_revoked',
    );
    const reports = await client.query(
      `select 1 from pentest.worker_reports where worker_session_id = $1::uuid`,
      [staleSessionId],
    );
    assert.equal(reports.rowCount, 0);
    await client.query(
      `update pentest.worker_sessions
          set status = 'superseded', ended_at = now(), status_reason = 'stale'
        where id = $1::uuid`,
      [staleSessionId],
    );
    workerSessionId = await seedSession(engagementId, 'active');
    await client.query(
      `update pentest.engagements set active_agent_session_id = $2::uuid where id = $1::uuid`,
      [engagementId, workerSessionId],
    );
  });

  it('报告：candidate_findings 在同一事务里落进 findings（外部审计 P0-1 的写入方）', async () => {
    const submitted = await tools.submitReport({
      workerSessionId,
      leaseGeneration: 1,
      report: {
        status: 'report_ready',
        objective: '结论落表',
        summary: '两条候选结论 + 一条无法成行的空标题',
        payload: {
          candidate_findings: [
            {
              title: '未授权访问 /admin 面板',
              severity: 'high',
              affected_assets: ['http://target/admin'],
              reproduction_plan: ['curl -i http://target/admin'],
              evidence_refs: ['evidence/target/admin.txt'],
              validation_required: true,
            },
            { statement: '低危信息泄露', severity: 'not-a-severity', confidence: 0.8 },
            { title: '   ' },
          ],
        },
      },
    });
    // 计数必须如实：空标题无法满足 `title NOT NULL` 记 skipped，不静默丢弃。
    assert.deepEqual(submitted.findings, { written: 2, skipped: 1 });

    const rows = await client.query<{
      title: string;
      severity: string | null;
      status: string;
      steps: unknown;
      assets: unknown;
      confidence: string | null;
    }>(
      `SELECT title, severity, status, reproduction_steps AS steps,
              affected_asset_ids AS assets, confidence::text AS confidence
         FROM pentest.findings WHERE discovered_in_session_id = $1::uuid`,
      [workerSessionId],
    );
    // 排序在 JS 里做：字符序随库的 collation 变，断言不能依赖它。
    const projected = rows.rows
      .map((row) => [row.title, row.severity, row.status] as const)
      .sort((left, right) => (left[0] < right[0] ? -1 : 1));
    assert.deepEqual(projected, [
      ['低危信息泄露', null, 'candidate'],
      ['未授权访问 /admin 面板', 'high', 'validation_pending'],
    ]);

    const detail = new Map(rows.rows.map((row) => [row.title, row]));
    assert.deepEqual(detail.get('未授权访问 /admin 面板')?.steps, ['curl -i http://target/admin']);
    assert.equal(detail.get('低危信息泄露')?.confidence, '0.8000');
    // 模型侧的 `affected_assets` 是字符串（"标识或地址"），表里是 uuid[]：**不猜测性转换**，
    // 原始条目留在 worker_reports.payload_json 与账本事件里。
    assert.deepEqual(detail.get('未授权访问 /admin 面板')?.assets, []);
  });

  it('报告：再次提交把本会话仍在待处置的结论置为 superseded（先让位、后插入）', async () => {
    await tools.submitReport({
      workerSessionId,
      leaseGeneration: 1,
      report: {
        status: 'report_ready',
        objective: '二轮',
        summary: '重新提交',
        payload: { candidate_findings: [{ title: '新结论', severity: 'info' }] },
      },
    });
    const rows = await client.query<{ title: string; status: string }>(
      `SELECT title, status FROM pentest.findings WHERE discovered_in_session_id = $1::uuid`,
      [workerSessionId],
    );
    const projected = rows.rows
      .map((row) => [row.title, row.status] as const)
      .sort((left, right) => (left[0] < right[0] ? -1 : 1));
    assert.deepEqual(projected, [
      ['低危信息泄露', 'superseded'],
      ['新结论', 'candidate'],
      ['未授权访问 /admin 面板', 'superseded'],
    ]);
  });

  it('报告：同一 attempt 的第二份当前报告被部分唯一索引拒绝', async () => {
    await tools.submitReport({
      workerSessionId,
      leaseGeneration: 1,
      report: { status: 'report_ready', objective: 'o', summary: 's', payload: {} },
    });
    await assert.rejects(
      () =>
        client.query(
          `INSERT INTO pentest.worker_reports
             (engagement_id, worker_session_id, attempt, iteration, status, objective, summary,
              payload_json, content_hash)
           VALUES ($1::uuid, $2::uuid, 1, 1, 'report_ready', 'o', 's', '{}'::jsonb, 'h')`,
          [engagementId, workerSessionId],
        ),
      (error: unknown) =>
        typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        (error as { code: unknown }).code === '23505',
      'worker_reports_current 是 (worker_session_id, attempt) WHERE superseded_by IS NULL 的部分唯一索引',
    );
  });

  it('报告：顺序反过来（先插入后让位）会撞唯一索引，「先让位、后插入」是必需的', async () => {
    await tools.submitReport({
      workerSessionId,
      leaseGeneration: 1,
      report: { status: 'report_ready', objective: 'o', summary: 's', payload: {} },
    });

    // 反序：旧报告的 superseded_by 仍为 NULL，唯一索引位被占着。
    const wrongOrderId = randomUUID();
    await client.query('begin');
    try {
      await assert.rejects(
        () =>
          client.query(
            `INSERT INTO pentest.worker_reports
               (id, engagement_id, worker_session_id, attempt, iteration, status, objective,
                summary, payload_json, content_hash)
             VALUES ($1::uuid, $2::uuid, $3::uuid, 1, 1, 'report_ready', 'o', 's', '{}'::jsonb, 'h')`,
            [wrongOrderId, engagementId, workerSessionId],
          ),
        (error: unknown) =>
          typeof error === 'object' &&
          error !== null &&
          'code' in error &&
          (error as { code: unknown }).code === '23505',
      );
    } finally {
      await client.query('rollback');
    }

    // 正序：同一条新行先让旧行让位，再插入，并在提交时通过两个延迟自引用外键。
    const rightOrderId = randomUUID();
    await client.query('begin');
    try {
      const displaced = await client.query<{ id: string }>(
        `UPDATE pentest.worker_reports SET superseded_by = $1::uuid
          WHERE worker_session_id = $2::uuid AND attempt = 1 AND superseded_by IS NULL
        RETURNING id`,
        [rightOrderId, workerSessionId],
      );
      assert.equal(displaced.rowCount, 1, '让位必须命中当前报告');
      await client.query(
        `INSERT INTO pentest.worker_reports
           (id, engagement_id, worker_session_id, attempt, iteration, status, objective, summary,
            payload_json, content_hash, supersedes_id)
         VALUES ($1::uuid, $2::uuid, $3::uuid, 1, 1, 'report_ready', 'o', 's', '{}'::jsonb, 'h', $4::uuid)`,
        [rightOrderId, engagementId, workerSessionId, displaced.rows[0]?.id as string],
      );
      await client.query('commit');
    } catch (error) {
      await client.query('rollback');
      throw error;
    }

    const current = await client.query<{ id: string }>(
      `SELECT id FROM pentest.worker_reports
        WHERE worker_session_id = $1::uuid AND attempt = 1 AND superseded_by IS NULL`,
      [workerSessionId],
    );
    assert.equal(current.rowCount, 1);
    assert.equal(current.rows[0]?.id, rightOrderId);
  });

  it('报告：终态会话不能提交（§10.6 滞后提交被拒）', async () => {
    await assert.rejects(
      () =>
        tools.submitReport({
          workerSessionId: endedSessionId,
          leaseGeneration: null,
          report: { status: 'report_ready', objective: 'o', summary: 's', payload: {} },
        }),
      (error: unknown) => error instanceof PgWorkerToolRefusal && error.code === 'lease_revoked',
    );
    const reports = await client.query(
      'select 1 from pentest.worker_reports where worker_session_id = $1::uuid',
      [endedSessionId],
    );
    assert.equal(reports.rowCount, 0);
  });

  // ───────────────────────────── §6.2.2 状态便签 ─────────────────────────────

  it('便签：写入正文、时间与来源标记；空便签不写；终态会话被拒', async () => {
    const stored = await tools.writeStatusNote({
      workerSessionId,
      leaseGeneration: 1,
      note: '已确认三个 Web 入口；下一步验证越权读取',
    });
    assert.deepEqual(stored, { stored: true, source: 'agent' });
    const row = await client.query<{
      status_note: string | null;
      status_note_at: Date | null;
      status_note_source: string | null;
    }>(
      'select status_note, status_note_at, status_note_source from pentest.worker_sessions where id = $1::uuid',
      [workerSessionId],
    );
    assert.equal(row.rows[0]?.status_note, '已确认三个 Web 入口；下一步验证越权读取');
    assert.equal(row.rows[0]?.status_note_source, 'agent');
    assert.ok(row.rows[0]?.status_note_at instanceof Date, '便签必须带时间戳');

    // 超长截断（§6.2.2 上限 200），而不是任由它撑爆控制台列表。
    await tools.writeStatusNote({
      workerSessionId,
      leaseGeneration: 1,
      note: 'x'.repeat(DEFAULTS.statusNoteMaxChars + 50),
    });
    const truncated = await client.query<{ status_note: string }>(
      'select status_note from pentest.worker_sessions where id = $1::uuid',
      [workerSessionId],
    );
    assert.equal(truncated.rows[0]?.status_note.length, DEFAULTS.statusNoteMaxChars);

    // 空白便签是「没东西要写」，不是错误：不写、也不校验租约（什么都没改）。
    const empty = await tools.writeStatusNote({ workerSessionId, leaseGeneration: 1, note: '   ' });
    assert.deepEqual(empty, { stored: false, source: 'agent' });

    // 终态会话（取代/关闭/失败）不接收 Agent 的滞后便签。与 `submitReport` 同口径：
    // **抛** `lease_revoked` 而不是静默返回「没存」——静默会让旧 Agent 以为自己写成功了。
    await assert.rejects(
      () => tools.writeStatusNote({ workerSessionId: endedSessionId, leaseGeneration: null, note: '滞后便签' }),
      (error: unknown) => error instanceof PgWorkerToolRefusal && error.code === 'lease_revoked',
    );
  });

  // ─────────────── §8.6 条目与证据的范围旁路（回归锁） ───────────────

  it('读取：被排除资产的 memory_item 不能靠 UUID 绕过范围（§8.6 同样约束条目）', async () => {
    // 回归锁。`memory_items` 此前没有资产归属列，于是条目读取只做 engagement 边界：
    // 只要知道条目 UUID，被排除资产派生的条目就能读出来——分块那侧的过滤形同虚设，
    // 因为这条引用根本不经过分块。迁移 014 补上 `asset_ids` 后必须复用同一份谓词。
    const excludedItem = randomUUID();
    const includedItem = randomUUID();
    await client.query(
      `INSERT INTO pentest.memory_items
         (id, engagement_id, kind, content, trust_level, status, source_event_ids, asset_ids, created_by)
       VALUES ($1::uuid, $2::uuid, 'fact', 'EXCLUDED-ITEM-SECRET-7a', 'tool_observation', 'candidate',
          $3::uuid[], $4::uuid[], 'node-test'),
              ($5::uuid, $2::uuid, 'fact', '在范围内的规范化事实', 'tool_observation', 'candidate',
          $3::uuid[], $6::uuid[], 'node-test')`,
      [excludedItem, engagementId, [includedEventId], [excludedAssetId], includedItem, [includedAssetId]],
    );

    // 已纳入资产的条目照常可读。
    const ok = await tools.read({ workerSessionId, refs: [`memory:${includedItem}`] });
    assert.equal(ok[0]?.memoryId, includedItem);

    // 被排除资产的条目：与「不存在」返回同一个码、同一段措辞（不泄露存在性，§18.4）。
    const denied = async (ref: string): Promise<PgWorkerToolRefusal> => {
      try {
        await tools.read({ workerSessionId, refs: [ref] });
      } catch (error) {
        assert.ok(error instanceof PgWorkerToolRefusal);
        return error;
      }
      throw new Error(`引用 ${ref} 本应被拒绝`);
    };
    const excludedRefusal = await denied(`memory:${excludedItem}`);
    const missingRefusal = await denied(`memory:${randomUUID()}`);
    assert.equal(excludedRefusal.code, 'scope_violation');
    assert.equal(missingRefusal.code, excludedRefusal.code);
    assert.equal(missingRefusal.payload.next_action, excludedRefusal.payload.next_action);
    assert.equal(
      excludedRefusal.payload.message.includes('EXCLUDED-ITEM-SECRET-7a'),
      false,
      '拒绝信息不得回流条目正文',
    );
  });

  it('证据：被排除资产关联的 artifact 不能靠 UUID 绕过范围（范围修订后同样成立）', async () => {
    // 回归锁。`readArtifact` 此前只按 `id + engagement_id` 查询，完全不看范围，
    // 而范围修订只改 `asset_scope_versions`——于是修订把某资产改为排除之后，
    // 它的证据仍然可以按 UUID 直读。迁移 014 给 `artifacts` 补了 `asset_ids`。
    const excludedArtifactId = randomUUID();
    await client.query(
      `INSERT INTO pentest.artifacts
         (id, engagement_id, worker_session_id, kind, media_type, byte_size, storage_kind,
          inline_content, content_hash, encrypted, classification, truncated, asset_ids, metadata)
       VALUES ($1::uuid, $2::uuid, $3::uuid, 'http_body', 'text/plain', 13, 'inline',
               $4, $5, false, 'engagement', false, $6::uuid[], '{}'::jsonb)`,
      [
        excludedArtifactId,
        engagementId,
        workerSessionId,
        Buffer.from('excluded-body'),
        sha256Hex('excluded-body'),
        [excludedAssetId],
      ],
    );

    // 已纳入资产的证据照常返回（同一路径没有被误伤）。
    const included = await tools.readArtifact({ workerSessionId, artifactId: textArtifactId });
    assert.equal(included.inline, 'hello world');

    // 被排除资产的证据：与「不存在」同码同措辞。
    const denied = async (artifactId: string): Promise<PgWorkerToolRefusal> => {
      try {
        await tools.readArtifact({ workerSessionId, artifactId });
      } catch (error) {
        assert.ok(error instanceof PgWorkerToolRefusal);
        return error;
      }
      throw new Error(`证据 ${artifactId} 本应被拒绝`);
    };
    const excludedRefusal = await denied(excludedArtifactId);
    const missingRefusal = await denied(randomUUID());
    assert.equal(excludedRefusal.code, 'scope_violation');
    assert.equal(missingRefusal.code, excludedRefusal.code);
    assert.equal(
      excludedRefusal.payload.message.includes('excluded-body'),
      false,
      '拒绝信息不得回流证据内容',
    );
  });

  it('读取：租约被吊销或已过期的会话不能读记忆或证据（读取也要过租约准入）', async () => {
    // 回归锁。此前 `#session` 只查 worker_sessions + engagements，读取路径对租约状态
    // 完全无感：被人工吊销租约、或租约到期未续的会话，只要 dsh Agent 还活着就仍能读
    // 整个 engagement 的记忆与证据。租约是「这个会话现在还被允许代表本作业工作」的
    // 唯一凭证，读取属于「代表作业工作」的一部分。
    //
    // 三条读取路径都要过这道闸：search / read / readArtifact。
    const revoked = await seedIsolatedSession('active', 'revoked');
    await assert.rejects(
      () => tools.read({ workerSessionId: revoked.sessionId, refs: [`memory:${includedChunkId}`] }),
      (error: unknown) => error instanceof PgWorkerToolRefusal && error.code === 'lease_revoked',
      '已吊销的租约报 lease_revoked——它既不是「从未签发」也不是「到期」',
    );
    await assert.rejects(
      () => tools.search({ workerSessionId: revoked.sessionId, query: TOKEN }),
      (error: unknown) => error instanceof PgWorkerToolRefusal && error.code === 'lease_revoked',
    );
    await assert.rejects(
      () => tools.readArtifact({ workerSessionId: revoked.sessionId, artifactId: textArtifactId }),
      (error: unknown) => error instanceof PgWorkerToolRefusal && error.code === 'lease_revoked',
    );

    // 从未签发租约：与「已吊销」区分开（处置相同，但归因不同）。
    const never = await seedIsolatedSession('active', 'never');
    await assert.rejects(
      () => tools.read({ workerSessionId: never.sessionId, refs: [`memory:${includedChunkId}`] }),
      (error: unknown) => error instanceof PgWorkerToolRefusal && error.code === 'lease_required',
    );

    // 租约已过期：错误码必须与「没有租约」区分，因为处置不同（续期失败 vs 重新签发）。
    const expired = await seedIsolatedSession('active', 'expired');
    await assert.rejects(
      () => tools.read({ workerSessionId: expired.sessionId, refs: [`memory:${includedChunkId}`] }),
      (error: unknown) => error instanceof PgWorkerToolRefusal && error.code === 'lease_expired',
    );

    // 到期**且已被清扫**：清扫把过期租约写成 revoked_at（reason `expired`），
    // 仍必须报 lease_expired，而不是退化成 lease_required（那会把排错引向
    // 「为什么没签发租约」这个错误方向）。
    const swept = await seedIsolatedSession('active', 'expired');
    await client.query(
      `UPDATE pentest.session_leases SET revoked_at = now(), revoked_reason = 'expired'
        WHERE worker_session_id = $1::uuid AND revoked_at IS NULL`,
      [swept.sessionId],
    );
    await assert.rejects(
      () => tools.read({ workerSessionId: swept.sessionId, refs: [`memory:${includedChunkId}`] }),
      (error: unknown) => error instanceof PgWorkerToolRefusal && error.code === 'lease_expired',
      '被到期清扫过的租约仍是「到期」，不是「从未签发」',
    );

    // 状态已离开存活集合、但租约行仍在（`human_revoke` 与到期清扫会吊销租约而不改状态，
    // 反过来状态转移漏吊销时也只剩这一条能拦）：必须拒绝。
    const ended = await seedIsolatedSession('active');
    await client.query(
      `UPDATE pentest.worker_sessions SET status = 'closed', ended_at = now() WHERE id = $1::uuid`,
      [ended.sessionId],
    );
    await assert.rejects(
      () => tools.search({ workerSessionId: ended.sessionId, query: TOKEN }),
      (error: unknown) => error instanceof PgWorkerToolRefusal && error.code === 'lease_revoked',
      '状态已离开存活集合的会话读取必须拒绝',
    );
    await assert.rejects(
      () => tools.readArtifact({ workerSessionId: ended.sessionId, artifactId: textArtifactId }),
      (error: unknown) => error instanceof PgWorkerToolRefusal && error.code === 'lease_revoked',
    );
  });

  it('便签：旧租约世代、已吊销/过期租约与非当前活动会话都不得覆盖便签', async () => {
    // 回归锁。此前 `writeStatusNote` 是一条 `UPDATE ... WHERE id = $1 AND status NOT IN (...)`
    // ——只看会话 id 与「不是终态」。租约世代、到期、吊销、以及「是否仍是当前活动会话」
    // 一概不看，于是被替换掉的旧 Agent 回来仍能改写控制台列表上人类读到的第一句话。
    const fixture = await seedIsolatedSession('active');
    await client.query(
      `UPDATE pentest.engagements SET active_agent_session_id = $2::uuid WHERE id = $1::uuid`,
      [fixture.engagementId, fixture.sessionId],
    );
    await tools.writeStatusNote({
      workerSessionId: fixture.sessionId,
      leaseGeneration: 1,
      note: '当前会话的便签',
    });

    // ① 世代不符：吊销世代 1、签发世代 2，再用世代 1 提交。
    await client.query(
      `UPDATE pentest.session_leases SET revoked_at = now(), revoked_reason = 'superseded'
        WHERE worker_session_id = $1::uuid AND revoked_at IS NULL`,
      [fixture.sessionId],
    );
    await client.query(
      `INSERT INTO pentest.session_leases (engagement_id, worker_session_id, generation, expires_at)
       VALUES ($1::uuid, $2::uuid, 2, now() + interval '1 hour')`,
      [fixture.engagementId, fixture.sessionId],
    );
    await assert.rejects(
      () => tools.writeStatusNote({ workerSessionId: fixture.sessionId, leaseGeneration: 1, note: '旧世代便签' }),
      (error: unknown) => error instanceof PgWorkerToolRefusal && error.code === 'lease_generation_stale',
    );

    // ② 租约已到期：世代正确也不行。到期时间不得回退，因此重插一条已过期的世代 2 租约
    //    （而不是把上面那条改成过去时间）。
    await client.query(
      'DELETE FROM pentest.session_leases WHERE worker_session_id = $1::uuid AND generation = 2',
      [fixture.sessionId],
    );
    await client.query(
      `INSERT INTO pentest.session_leases
         (engagement_id, worker_session_id, generation, issued_at, expires_at, last_heartbeat_at)
       VALUES ($1::uuid, $2::uuid, 2, now() - interval '2 hours', now() - interval '1 hour',
               now() - interval '2 hours')`,
      [fixture.engagementId, fixture.sessionId],
    );
    await assert.rejects(
      () => tools.writeStatusNote({ workerSessionId: fixture.sessionId, leaseGeneration: 2, note: '过期租约便签' }),
      (error: unknown) => error instanceof PgWorkerToolRefusal && error.code === 'lease_expired',
    );

    // ③ 不再是当前活动会话：租约有效也不行——被取代的会话写的便签不代表任何人。
    //    会话转为 superseded（非存活）后新会话才能成为存活会话（部分唯一索引）。
    //    先把世代 2 的到期时间前推回有效（续租只允许前推，这里正是前推）。
    await client.query(
      `UPDATE pentest.session_leases SET expires_at = now() + interval '1 hour', last_heartbeat_at = now()
        WHERE worker_session_id = $1::uuid AND revoked_at IS NULL`,
      [fixture.sessionId],
    );
    await client.query(
      `UPDATE pentest.worker_sessions SET status = 'superseded', ended_at = now() WHERE id = $1::uuid`,
      [fixture.sessionId],
    );
    const successor = await seedSession(fixture.engagementId, 'active');
    await client.query(
      `UPDATE pentest.engagements SET active_agent_session_id = $2::uuid WHERE id = $1::uuid`,
      [fixture.engagementId, successor],
    );
    await assert.rejects(
      () => tools.writeStatusNote({ workerSessionId: fixture.sessionId, leaseGeneration: 2, note: '非活动会话便签' }),
      (error: unknown) => error instanceof PgWorkerToolRefusal && error.code === 'lease_revoked',
      '非当前活动会话（且已离开存活集合）不得覆盖便签',
    );

    // 便签正文始终是第 ① 次写入的那条：三次拒绝都没有改动它。
    const row = await client.query<{ status_note: string | null }>(
      'select status_note from pentest.worker_sessions where id = $1::uuid',
      [fixture.sessionId],
    );
    assert.equal(row.rows[0]?.status_note, '当前会话的便签');

    // ④ 合法写入必须同时追加 `worker.status_note` 领域事件（§6.2.2 的「落点」要求两者都写）。
    //    该事件类型此前在契约里注册、文档里要求写，却**从未**被写入过。
    await tools.writeStatusNote({ workerSessionId: successor, leaseGeneration: 1, note: '合法便签' });
    const events = await client.query<{ payload_json: { note?: string } }>(
      `select payload_json from pentest.context_events
        where engagement_id = $1::uuid and worker_session_id = $2::uuid
          and event_type = 'worker.status_note'
        order by chain_seq desc limit 1`,
      [fixture.engagementId, successor],
    );
    assert.equal(events.rowCount, 1, '合法便签必须写一条 worker.status_note 事件');
    assert.equal(events.rows[0]?.payload_json.note, '合法便签');
  });

  // ───────────────────────────── §10.3 放行申请 ─────────────────────────────

  it('放行：needs_approval 映射成 approvalId/planHash/expiresAt；admitted 与 rejected 都不静默', async () => {
    const approvalId = randomUUID();
    const expiresAt = new Date(Date.now() + 900_000);
    await client.query(
      // 挂到**另一个**会话：这一行只是「按 id 读 expires_at」的夹具，
      // 不能落成本会话的待处理申请——那会命中「一次只提一条」的新规则（见下一个用例）。
      `INSERT INTO pentest.approvals
         (id, engagement_id, requested_by_worker, action_class, target_snapshot, command_plan,
          plan_hash, risk_summary, decision, expires_at)
       VALUES ($1::uuid, $2::uuid, $3::uuid, 'exploit_validation', '{}'::jsonb, '{}'::jsonb,
          'plan-hash-1', 'risky', 'pending', $4)`,
      [approvalId, engagementId, endedSessionId, expiresAt],
    );

    const intent = {
      workerSessionId,
      templateId: 'http_probe',
      targetSelector: 'in.target.test',
      params: {},
      purpose: '验证越权读取',
    };
    const needsApproval = new PgWorkerTools(db, {
      executor: {
        admit: async () => ({ kind: 'needs_approval', approvalId, planHash: 'plan-hash-1' }),
      },
    });
    assert.deepEqual(await needsApproval.requestApproval({ workerSessionId, intent }), {
      approvalId,
      planHash: 'plan-hash-1',
      expiresAt: expiresAt.toISOString(),
    });

    // **一次只提一条**（2026-10-05 人类要求）：本会话已有 pending 时再提必须被拒，
    // 并把那条的 id 与命令带出来（人类一次只能认真看一条命令；连着提会让人只批一条）。
    const pendingId = randomUUID();
    await client.query(
      `INSERT INTO pentest.approvals
         (id, engagement_id, requested_by_worker, action_class, target_snapshot, command_plan,
          plan_hash, risk_summary, decision, expires_at)
       VALUES ($1::uuid, $2::uuid, $3::uuid, 'exploit_validation', '{}'::jsonb,
          jsonb_build_object('display_command', 'nmap -sV target'), 'h-pending', 'risky', 'pending',
          now() + interval '15 minutes')`,
      [pendingId, engagementId, workerSessionId],
    );
    await assert.rejects(
      () => needsApproval.requestApproval({ workerSessionId, intent }),
      (error: unknown) =>
        error instanceof PgWorkerToolRefusal &&
        error.code === 'approval_required' &&
        error.message.includes(pendingId) &&
        error.message.includes('nmap -sV target'),
      '已有一条待处理时必须拒绝，并把那条的 id 与命令带出来',
    );
    await client.query(`delete from pentest.approvals where id = $1::uuid`, [pendingId]);

    const rejected = new PgWorkerTools(db, {
      executor: {
        admit: async () => ({ kind: 'rejected', error: { ...OK_REJECTION } }),
      },
    });
    // 该存根返回 rejected：放行申请必须原样带出稳定错误码与下一步动作（§16.5）。
    await assert.rejects(
      () => rejected.requestApproval({ workerSessionId, intent }),
      (error: unknown) =>
        error instanceof PgWorkerToolRefusal &&
        error.code === 'scope_violation' &&
        error.payload.next_action === OK_REJECTION.next_action,
    );

    const noApproval = new PgWorkerTools(db, {
      executor: {
        admit: async () => ({
          kind: 'admitted',
          plan: {
            workerSessionId,
            templateId: 'http_probe',
            actionClass: 'passive_collection',
            resolvedAddresses: ['192.0.2.10'],
            normalizedTarget: 'in.target.test',
            normalizedCommand: 'http_probe',
            planHash: 'h',
            idempotencyKey: 'k',
            scopeVersion: 1,
            policyEpoch: 1,
            leaseGeneration: 1,
            approvalId: null,
            timeoutMs: 1000,
            maxOutputBytes: 1024,
          },
        }),
      },
    });
    await assert.rejects(
      () => noApproval.requestApproval({ workerSessionId, intent }),
      (error: unknown) =>
        error instanceof PgWorkerToolRefusal && error.code === 'classification_rejected',
      '不需要放行的动作申请放行时必须明确拒绝，不能凭空造一个 approval_id',
    );

    // 放行记录尚未落库时不得返回不可投递的凭证。
    const dangling = new PgWorkerTools(db, {
      executor: {
        admit: async () => ({
          kind: 'needs_approval',
          approvalId: randomUUID(),
          planHash: 'plan-hash-x',
        }),
      },
    });
    await assert.rejects(
      () => dangling.requestApproval({ workerSessionId, intent }),
      (error: unknown) => error instanceof PgWorkerToolRefusal && error.code === 'audit_unavailable',
    );
  });

  // ─────────────── intake 会话的边界（2026-10-04 实机事故的回归锁） ───────────────

  /**
   * 事故形状：聊天路径的 intake 会话接管的是**人类已有的 dsh 会话**，插件无法在它上面补
   * `tools.restrict`——实测那个会话的工具面是全部 Worker 工具，于是模型「顺手收尾」调用了
   * `pentest_submit_report`。报告把会话推进到等待人工，而 intake 的唯一出口
   * （`pentest_request_scope_confirmation`）随后被挡住，整个 intake 卡死（人类看到 `lease_revoked`）。
   */
  it('intake 会话不能提交任务报告：服务端闸门直接拒绝，且不写任何报告行', async () => {
    const { engagementId, sessionId } = await seedIsolatedSession('active', undefined, {
      sessionKind: 'intake',
      scopeVersion: 0,
    });
    await client.query(
      `update pentest.engagements set active_agent_session_id = $2::uuid where id = $1::uuid`,
      [engagementId, sessionId],
    );

    await assert.rejects(
      () => tools.submitReport({
        workerSessionId: sessionId,
        leaseGeneration: 1,
        report: { status: 'blocked', objective: '顺手收尾', summary: '不该写进去', payload: {} },
      }),
      (error: unknown) => {
        assert.ok(error instanceof PgWorkerToolRefusal, '应为结构化拒绝');
        assert.equal(error.code, 'classification_rejected');
        assert.match(error.message, /intake/, '错误必须点明是 intake 会话的边界');
        assert.match(error.payload.next_action, /request_scope_confirmation/, '必须给出正确工具');
        return true;
      },
    );
    const reports = await client.query(
      `select 1 from pentest.worker_reports where worker_session_id = $1::uuid`,
      [sessionId],
    );
    assert.equal(reports.rowCount, 0, '拒绝必须是彻底的：一条报告行都不许落');
  });

  /**
   * 事故的第二半：人类的思考时间不受 10 分钟 TTL 约束。租约到期后若连**提案**都提交不了，
   * 「人类想改口径 → Agent 重提方案」这条唯一路径就被锁死（实测：用户卡在 waiting_human）。
   */
  it('intake 会话的租约过期后仍能提交/更新范围方案；阶段会话的过期租约照旧拒绝', async () => {
    // 复刻 2026-10-04 实机卡死的**完整形态**：会话 waiting_human（提交过报告留下的）、
    // engagement waiting_human_review、租约已过期——旧代码在这里回 `lease_revoked`，
    // 人类既改不了口径也确认不了旧方案。
    const { engagementId, sessionId } = await seedIsolatedSession('waiting_human', 'expired', {
      sessionKind: 'intake',
      scopeVersion: 0,
    });
    await client.query(
      `update pentest.engagements
          set current_status = 'waiting_human_review', active_agent_session_id = $2::uuid
        where id = $1::uuid`,
      [engagementId, sessionId],
    );

    const proposal = await tools.requestScopeConfirmation({
      workerSessionId: sessionId,
      leaseGeneration: 1,
      objective: '实验室 3002 端口被动读取',
      targets: [
        {
          kind: 'ip',
          value: '47.109.76.66',
          protocols: ['tcp'],
          ports: [{ from: 3002, to: 3002 }],
        },
      ],
      exclusions: [],
      allowedActions: ['passive_collection'],
      authorizationNote: '',
    });
    assert.ok(typeof proposal.id === 'string' && proposal.id.length > 0, '过期的 intake 租约不得锁死提案');
    assert.deepEqual(proposal.allowedActions, ['passive_collection']);

    // **清扫形态**（心跳的 `expireLeases` 会把过期租约写成 revoked_reason='expired'）：
    // 只豁免「未清扫」等于推迟一个心跳 tick 再卡死（评审抓到的半修）。
    const swept = await seedIsolatedSession('waiting_human', undefined, {
      sessionKind: 'intake',
      scopeVersion: 0,
    });
    await client.query(
      `update pentest.engagements
          set current_status = 'waiting_human_review', active_agent_session_id = $2::uuid
        where id = $1::uuid`,
      [swept.engagementId, swept.sessionId],
    );
    await client.query(
      `delete from pentest.session_leases where worker_session_id = $1::uuid`,
      [swept.sessionId],
    );
    await client.query(
      `insert into pentest.session_leases
         (engagement_id, worker_session_id, generation, issued_at, expires_at, last_heartbeat_at)
       values ($1::uuid, $2::uuid, 1, now() - interval '2 hours', now() - interval '1 hour', now() - interval '2 hours')`,
      [swept.engagementId, swept.sessionId],
    );
    // 清扫形态本身：`revoked_at` + `revoked_reason='expired'`（`expires_at` 不许回退，见 §10.6 触发器）。
    await client.query(
      `update pentest.session_leases
          set revoked_at = now(), revoked_reason = 'expired'
        where worker_session_id = $1::uuid`,
      [swept.sessionId],
    );
    const sweptProposal = await tools.requestScopeConfirmation({
      workerSessionId: swept.sessionId,
      leaseGeneration: 1,
      objective: '清扫后的 intake 仍可改口径',
      targets: [{ kind: 'ip', value: '47.109.76.66', protocols: ['tcp'], ports: [{ from: 3002, to: 3002 }] }],
      exclusions: [],
      allowedActions: ['passive_collection', 'active_probing'],
      authorizationNote: '',
    });
    assert.deepEqual(
      sweptProposal.allowedActions,
      ['passive_collection', 'active_probing'],
      '被心跳清扫过的到期租约不得锁死提案（否则「人慢于 TTL」这条路径又死）',
    );

    // 反向：阶段会话的过期租约仍然拒绝——豁免只给 intake 的提案路径，目标动作没有任何豁免。
    const phase = await seedIsolatedSession('active', 'expired');
    await client.query(
      `update pentest.engagements set active_agent_session_id = $2::uuid where id = $1::uuid`,
      [phase.engagementId, phase.sessionId],
    );
    await assert.rejects(
      () => tools.submitReport({
        workerSessionId: phase.sessionId,
        leaseGeneration: 1,
        report: { status: 'report_ready', objective: 'o', summary: 's', payload: {} },
      }),
      (error: unknown) => error instanceof PgWorkerToolRefusal && error.code === 'lease_expired',
      '阶段会话的过期租约必须仍然无效（豁免不能外溢）',
    );
    void engagementId;
  });
});
