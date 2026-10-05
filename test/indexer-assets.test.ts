/**
 * 索引器的**资产归属与阶段解析**（§8.6 写入侧义务与范围过滤 / §5.1 阶段 / §8.5 分块）。
 *
 * 重点锁定四件事，每件都对应一条会静默失效的缺口：
 *   1. **阶段真落库**：账本事件不带阶段（阶段是会话属性，§5.1），
 *      分块的 `phase` 必须来自 `worker_sessions` 的 join；无会话的事件就是 null，不猜。
 *   2. **已登记的目标被解析为 `asset_ids`**：只认 `pentest.assets` 里已登记的行，
 *      不自动创建（登记资产是情报收集的产出，不是索引器的职权）。
 *   3. **写入侧义务真的生效**：事件明确含目标却无任何已登记资产 → 索引失败，
 *      错误码 `target_not_adjudicated`。这是 fail-closed 的刻选择：
 *      §8.6 对空 `asset_ids` 是**放行**的，不拦就等于"不标资产即可绕过范围过滤"。
 *   4. **排除的资产带不进检索面**：§8.6 的三条判定在真实库上按范围版本求值。
 *
 * 集成用例沿用 test/indexer.test.ts 的约定：没有 `PENTEST_DATABASE_URL` 就 skip。
 * `context_events` 只允许追加（002 的触发器），清理种子数据必须先临时停触发器
 * ——与 test/recovery.test.ts 同一个做法。
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';

import { MemoryIndexer, IndexerError, extractTargetHints } from '../src/memory/indexer.ts';
import { buildRetrievalSql } from '../src/memory/retrieval.ts';
import { PgOutboxQueue } from '../src/memory/outbox.ts';
import { IndexDispatcher } from '../src/memory/dispatcher.ts';
import { MemoryLedger } from '../src/memory/ledger.ts';
import { LedgerIndexEnqueue } from '../src/memory/index-enqueue.ts';
import type { DbClient } from '../src/db/port.ts';
import type { ChunkSourceEvent } from '../src/memory/chunks.ts';

const DATABASE_URL = process.env.PENTEST_DATABASE_URL;

/** 本套件使用的范围版本（会话绑定它，资产决策挂它）。 */
const SCOPE_VERSION = 7;

// ───────────────────── 目标线索提取（纯逻辑，无需数据库） ─────────────────────

test('目标线索：结构化字段 target 直接取用，主机:端口再拆出主机', () => {
  assert.deepEqual(extractTargetHints({ target: '10.20.30.40' }), ['10.20.30.40']);
  assert.deepEqual(extractTargetHints({ target: '10.20.30.40:8443' }), [
    '10.20.30.40:8443',
    '10.20.30.40',
  ]);
});

test('目标线索：URL 取整串与主机（主机按 RFC 3986 小写化）', () => {
  assert.deepEqual(extractTargetHints({ http: { url: 'https://App.Example.COM:8443/login?x=1' } }), [
    'https://App.Example.COM:8443/login?x=1',
    'app.example.com:8443',
    'app.example.com',
  ]);
  // 没有嵌套 http 的形态：顶层 payload 就是 HTTP 交换（与 chunks.ts 的取法一致）
  assert.deepEqual(extractTargetHints({ url: 'http://app.example.com/x' }), [
    'http://app.example.com/x',
    'app.example.com',
  ]);
});

test('目标线索：命令里只认 URL、IP/CIDR 字面量与显式目标开关的值', () => {
  assert.deepEqual(extractTargetHints({ command: 'nmap -sV -p 443 10.20.30.40' }), ['10.20.30.40']);
  assert.deepEqual(extractTargetHints({ command: 'masscan 10.20.30.0/24 -p1-65535' }), [
    '10.20.30.0/24',
  ]);
  assert.deepEqual(extractTargetHints({ command: 'curl -sS https://app.example.com/admin,' }), [
    'https://app.example.com/admin',
    'app.example.com',
  ]);
  assert.deepEqual(extractTargetHints({ command: 'ffuf -w w.txt --target https://app.example.com/FUZZ' }), [
    'https://app.example.com/FUZZ',
    'app.example.com',
  ]);
  assert.deepEqual(extractTargetHints({ command: 'sqlmap --url=https://app.example.com/?id=1' }), [
    'https://app.example.com/?id=1',
    'app.example.com',
  ]);
  assert.deepEqual(extractTargetHints({ command: 'gobuster dir -u http://app.example.com -w words' }), [
    'http://app.example.com',
    'app.example.com',
  ]);
  assert.deepEqual(extractTargetHints({ command: 'ping6 fe80::1' }), ['fe80::1']);
});

test('目标线索：保守——不从正文挖 URL（报告段落、标准输出都不是目标）', () => {
  assert.deepEqual(
    extractTargetHints({
      summary: '参考 https://nvd.nist.gov/vuln/detail/CVE-2021-1234 与 https://docs.example.org/x',
      facts: ['攻击面见 https://attacker-controlled.example.com/'],
    }),
    [],
    '文档链接与 CVE 链接不是 engagement 资产；挖出来只会把正常报告变成死信',
  );
  assert.deepEqual(
    extractTargetHints({ command: 'curl -i http://app.example.com', stdout: 'Location: https://cdn.example.net/a.js' }),
    ['http://app.example.com', 'app.example.com'],
    '只认命令里的目标，不认标准输出里的链接',
  );
});

test('目标线索：保守——裸主机名、文件名与非地址串都不算目标', () => {
  assert.deepEqual(
    extractTargetHints({ command: 'nmap -sV victim.example.com' }),
    [],
    '裸主机名与文件名（report.txt）在命令行里同形，宁可漏也不误判',
  );
  assert.deepEqual(extractTargetHints({ command: 'cat report.txt && grep -i nginx changelog.md' }), []);
  assert.deepEqual(extractTargetHints({ command: 'sqlmap -u http://app.example.com -t 20' }), [
    'http://app.example.com',
    'app.example.com',
  ]);
  assert.deepEqual(
    extractTargetHints({ command: 'nmap -p 1:2:3 host.example.com' }),
    [],
    '`1:2:3` 不是 IPv6（既没有 :: 压缩也没有 8 组），不能当地址',
  );
  assert.deepEqual(extractTargetHints({ target: '999.1.1.1' }), ['999.1.1.1']);
  assert.deepEqual(extractTargetHints({ command: 'nmap 999.1.1.1' }), [], '非法 IPv4 不当地址');
});

test('目标线索：非对象负载与重复线索', () => {
  assert.deepEqual(extractTargetHints(null), []);
  assert.deepEqual(extractTargetHints('文本里的 https://app.example.com 不算'), []);
  assert.deepEqual(extractTargetHints([{ target: '10.20.30.40' }]), []);
  assert.deepEqual(
    extractTargetHints({ target: '10.20.30.40', command: 'nmap 10.20.30.40' }),
    ['10.20.30.40'],
    '同一目标只留一条线索',
  );
});

// ───────────────────── 集成（真实 PostgreSQL） ─────────────────────

describe('索引器资产归属与阶段（真实 PostgreSQL）', { skip: DATABASE_URL === undefined ? '未设置 PENTEST_DATABASE_URL' : false }, () => {
  let pool: Pool;
  let engagementId: string;
  let sessionId: string;
  /** 已登记且在范围内：`app.example.com`（kind domain）。 */
  let includedAssetId: string;
  /** 已登记但被排除：`old.example.com`（kind domain）。 */
  let excludedAssetId: string;
  /** 已登记且已纳入的整条 URL（kind url）。 */
  let urlAssetId: string;

  const db = (): DbClient => ({
    async query<Row = Record<string, unknown>>(sql: string, params?: readonly unknown[]) {
      const r = await pool.query(sql, params === undefined ? undefined : [...params]);
      return { rows: r.rows as Row[], rowCount: r.rowCount };
    },
  });

  /** 不带嵌入提供方：只做词法索引，版本固定为 `lexical-only`（便于范围用例断言）。 */
  const indexer = (): MemoryIndexer => new MemoryIndexer({ db: db(), txDb: db(), clock: () => new Date() });

  before(async () => {
    pool = new Pool({ connectionString: DATABASE_URL, max: 6 });
    engagementId = randomUUID();
    sessionId = randomUUID();
    await pool.query(
      `insert into pentest.engagements
         (id, tenant_id, name, status, current_status, target_snapshot, scope_snapshot, roe_snapshot, policy_snapshot, config_snapshot, created_by)
       values ($1::uuid, 't', 'indexer-assets-test', 'running', 'worker_running', '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, 'tester')`,
      [engagementId],
    );
    await pool.query(
      `insert into pentest.worker_sessions
         (id, engagement_id, dsh_session_id, phase, profile_id, profile_revision, attempt, iteration,
          scope_version, task_prompt, tool_filter, skill_ids, model_route, status)
       values ($1::uuid, $2::uuid, $3, 'threat-modeling', 'p', 'r1', 1, 1, $4,
               'tp', '{}'::jsonb, '[]'::jsonb, '{}'::jsonb, 'active')`,
      [sessionId, engagementId, `dsh-idx-assets-${randomUUID()}`, SCOPE_VERSION],
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
      [engagementId, sessionId],
    );

    await pool.query(
      `insert into pentest.scope_versions
         (engagement_id, version, iteration, targets, exclusions, changed_by, content_hash)
       values ($1::uuid, $2, 1, '[]'::jsonb, '[]'::jsonb, 'tester', 'h1')`,
      [engagementId, SCOPE_VERSION],
    );
    includedAssetId = await newAsset({ canonicalTarget: 'app.example.com', kind: 'domain', decision: 'included' });
    excludedAssetId = await newAsset({ canonicalTarget: 'old.example.com', kind: 'domain', decision: 'excluded' });
    urlAssetId = await newAsset({
      canonicalTarget: 'https://app.example.com/login',
      kind: 'url',
      decision: 'included',
    });
    // 检索的向量路默认只比对当前生效版本（§9）；本套件用 lexical-only 这一固定版本。
    await pool.query(
      `insert into pentest.embedding_revisions (engagement_id, revision, model, dimensions, is_active)
       values ($1::uuid, 'lexical-only', 'fixture', 1024, true)`,
      [engagementId],
    );
  });

  after(async () => {
    if (pool === undefined) return;
    await cleanupEngagement(engagementId);
    await pool.end();
  });

  /**
   * 清理一个 engagement 的全部痕迹。
   *
   * `context_events` 与 `ledger_anchors` 只允许追加（002 的触发器），
   * 所以必须先临时停触发器——与 test/recovery.test.ts 同一个做法。
   * 顺序按外键反着来：分块/锚点/事件 → 资产与范围 → 会话 → engagement。
   */
  async function cleanupEngagement(id: string): Promise<void> {
    // 用 `session_replication_role = 'replica'` 一次性绕过用户触发器与 FK 触发器。
    // 详见 `dispatcher.test.ts` 的 `cleanup` 注释：临时停触发器 + 按外键倒序删的形状
    // 漏掉任何一张引用 `engagements` 的表（尤其 `session_leases`）就会静默残留。
    const client = await pool.connect();
    try {
      await client.query("SET session_replication_role = 'replica'");
      for (const sql of [
        'delete from pentest.outbox_jobs where engagement_id = $1::uuid',
        'delete from pentest.memory_chunks where engagement_id = $1::uuid',
        'delete from pentest.index_watermarks where engagement_id = $1::uuid',
        'delete from pentest.ledger_anchors where engagement_id = $1::uuid',
        'delete from pentest.context_events where engagement_id = $1::uuid',
        'delete from pentest.asset_scope_versions where engagement_id = $1::uuid',
        'delete from pentest.assets where engagement_id = $1::uuid',
        'delete from pentest.scope_versions where engagement_id = $1::uuid',
        'delete from pentest.embedding_revisions where engagement_id = $1::uuid',
        // session_leases 引用 engagements：漏了这一句，engagements 永远删不掉
        'delete from pentest.session_leases where engagement_id = $1::uuid',
        'delete from pentest.worker_sessions where engagement_id = $1::uuid',
        // policy_versions 也引用 engagements：先删子表，engagements 才删得掉。
        'delete from pentest.policy_versions where engagement_id = $1::uuid',
        'delete from pentest.engagements where id = $1::uuid',
      ]) {
        await client.query(sql, [id]);
      }
    } finally {
      await client.query("SET session_replication_role = 'origin'");
      client.release();
    }
  }

  /** 登记一个资产并挂上范围决策（§9：assets + asset_scope_versions）。 */
  async function newAsset(input: {
    canonicalTarget: string;
    kind: string;
    decision: 'included' | 'excluded' | 'pending';
  }): Promise<string> {
    const id = randomUUID();
    await pool.query(
      `insert into pentest.assets
         (id, engagement_id, canonical_target, kind, labels, first_seen_iteration, discovered_in_session_id)
       values ($1::uuid, $2::uuid, $3, $4, '[]'::jsonb, 1, $5::uuid)`,
      [id, engagementId, input.canonicalTarget, input.kind, sessionId],
    );
    await pool.query(
      `insert into pentest.asset_scope_versions (asset_id, scope_version, engagement_id, decision, decided_by)
       values ($1::uuid, $2, $3::uuid, $4, 'tester')`,
      [id, SCOPE_VERSION, engagementId, input.decision],
    );
    return id;
  }

  let chainSeq = 100;

  /** 造一条账本事件（直接插入，绕过账本的事务约束与哈希链）。 */
  async function insertEvent(input: {
    eventType: string;
    payload: unknown;
    /** 省略即 null：人类输入与系统事件没有会话。 */
    workerSessionId?: string | null;
    trustLevel?: string;
    classification?: string;
  }): Promise<string> {
    chainSeq += 1;
    const r = await pool.query<{ event_id: string }>(
      `insert into pentest.context_events
         (engagement_id, worker_session_id, source_system, source_id, source_seq, event_type,
          schema_version, occurred_at, chain_seq, payload_json, raw_payload_zstd,
          classification, trust_level, event_hash)
       values ($1::uuid, $2::uuid, 'test', $3, $4, $5, 1, now(), $4, $6::jsonb, '\\x00',
               $7, $8, '\\x01')
       returning event_id`,
      [
        engagementId,
        input.workerSessionId === undefined ? sessionId : input.workerSessionId,
        `src-${chainSeq}`,
        chainSeq,
        input.eventType,
        JSON.stringify(input.payload),
        input.classification ?? 'engagement',
        input.trustLevel ?? 'tool_observation',
      ],
    );
    return r.rows[0]!.event_id;
  }

  /** 某个事件落库的分块（按序号）。 */
  async function chunksOf(
    eventId: string,
  ): Promise<readonly { id: string; phase: string | null; asset_ids: string[] }[]> {
    const r = await pool.query<{ id: string; phase: string | null; asset_ids: string[] }>(
      `select id, phase, asset_ids from pentest.memory_chunks where source_event_id = $1::uuid order by ordinal`,
      [eventId],
    );
    return r.rows;
  }

  async function rejectionCodeOf(run: () => Promise<unknown>): Promise<string> {
    try {
      await run();
    } catch (error) {
      if (error instanceof IndexerError) return error.code;
      throw new Error(`期望 IndexerError，实际是 ${String(error)}`, { cause: error });
    }
    throw new Error('期望失败，但调用成功了');
  }

  // ── 阶段（§5.1 / §2.1） ──

  test('阶段：写入侧从会话 join 出阶段，真的落进分块', async () => {
    const eventId = await insertEvent({ eventType: 'human.input', payload: { text: '威胁建模：先画信任边界' } });
    const result = await indexer().indexEventById(engagementId, eventId);
    assert.equal(result.inserted, 1);

    const [chunk] = await chunksOf(eventId);
    assert.equal(chunk!.phase, 'threat-modeling', '阶段来自 worker_sessions.phase，不是猜的');
  });

  test('阶段：无会话的事件（人类输入/系统事件）阶段就是 null', async () => {
    const eventId = await insertEvent({
      eventType: 'human.input',
      payload: { text: '范围外的旁注，不归属任何会话' },
      workerSessionId: null,
    });
    await indexer().indexEventById(engagementId, eventId);

    const [chunk] = await chunksOf(eventId);
    assert.equal(chunk!.phase, null, '没有会话就没有阶段——不猜、不继承上一个阶段的会话');
  });

  test('阶段：会话换阶段后，新分块带新阶段而旧分块不动（索引是派生数据、按事件写）', async () => {
    // 一个 engagement 同时只有一个存活会话（001 的部分唯一索引），
    // 所以第二个会话取终态 superseded——历史事件照样要能被索引并带对阶段。
    const second = randomUUID();
    await pool.query(
      `insert into pentest.worker_sessions
         (id, engagement_id, dsh_session_id, phase, profile_id, profile_revision, attempt, iteration,
          scope_version, task_prompt, tool_filter, skill_ids, model_route, status)
       values ($1::uuid, $2::uuid, $3, 'vulnerability-analysis', 'p', 'r1', 1, 1, $4,
               'tp', '{}'::jsonb, '[]'::jsonb, '{}'::jsonb, 'superseded')`,
      [second, engagementId, `dsh-idx-assets-${randomUUID()}`, SCOPE_VERSION],
    );
    const eventId = await insertEvent({
      eventType: 'human.input',
      payload: { text: '进入漏洞分析' },
      workerSessionId: second,
    });
    await indexer().indexEventById(engagementId, eventId);

    const [chunk] = await chunksOf(eventId);
    assert.equal(chunk!.phase, 'vulnerability-analysis');
  });

  // ── 资产归属解析（§8.6 写入侧） ──

  test('归属：工具产出里已登记的目标被解析为 asset_ids', async () => {
    const eventId = await insertEvent({
      eventType: 'tool.result',
      payload: {
        toolRunId: 'run-1',
        target: 'app.example.com',
        command: 'nmap -sV -p 443 app.example.com',
        stdout: '443/tcp open https',
        exitCode: 0,
      },
    });
    await indexer().indexEventById(engagementId, eventId);

    const chunks = await chunksOf(eventId);
    assert.ok(chunks.length >= 1);
    for (const chunk of chunks) {
      assert.deepEqual(chunk.asset_ids, [includedAssetId], '每个工具输出分块都要带归属');
      assert.equal(chunk.phase, 'threat-modeling');
    }
  });

  test('归属：URL 整串与主机分别匹配各自登记的资产（同一事件可归属多个）', async () => {
    const eventId = await insertEvent({
      eventType: 'tool.result',
      payload: {
        toolRunId: 'run-2',
        contentType: 'http',
        http: { url: 'https://app.example.com/login', method: 'GET', statusCode: 200 },
      },
    });
    await indexer().indexEventById(engagementId, eventId);

    const [chunk] = await chunksOf(eventId);
    assert.deepEqual(
      [...chunk!.asset_ids].sort(),
      [includedAssetId, urlAssetId].sort(),
      'kind=url 的整串与 kind=domain 的主机都是同一目标的登记录入，两条都要带上',
    );
  });

  test('归属：同一 canonical_target 的不同 kind 都算命中（assets 的唯一键含 kind）', async () => {
    const serviceAssetId = await newAsset({
      canonicalTarget: 'app.example.com:8443',
      kind: 'service',
      decision: 'included',
    });
    const eventId = await insertEvent({
      eventType: 'tool.result',
      payload: { target: 'app.example.com:8443', command: 'curl -k https://app.example.com:8443/' },
    });
    await indexer().indexEventById(engagementId, eventId);

    const [chunk] = await chunksOf(eventId);
    assert.ok(chunk!.asset_ids.includes(serviceAssetId), 'service 行要命中');
    assert.ok(chunk!.asset_ids.includes(includedAssetId), '同一个值的 domain 行也要命中');
  });

  test('归属：被排除的资产照常写入归属（写入侧不裁决范围，裁决在检索侧）', async () => {
    const eventId = await insertEvent({
      eventType: 'tool.result',
      payload: { target: 'old.example.com', command: 'nmap old.example.com' },
    });
    await indexer().indexEventById(engagementId, eventId);

    const [chunk] = await chunksOf(eventId);
    assert.deepEqual(
      chunk!.asset_ids,
      [excludedAssetId],
      '写侧必须如实记录归属——若这里留空，§8.6 的空归属放行会让被排除资产的内容留在检索面',
    );
  });

  test('归属：只存元数据的分块（二进制证据）同样带归属', async () => {
    const eventId = await insertEvent({
      eventType: 'tool.result',
      payload: {
        target: 'app.example.com',
        binary: { mimeType: 'application/vnd.tcpdump.pcap', byteLength: 2048, sha256: 'b'.repeat(64) },
      },
    });
    const result = await indexer().indexEventById(engagementId, eventId);

    assert.equal(result.metadataOnly, 1);
    const [chunk] = await chunksOf(eventId);
    assert.deepEqual(chunk!.asset_ids, [includedAssetId], '不参与检索的分块也要能按资产过滤');
  });

  test('归属：报告正文里的 URL 不算目标（保守提取），分段照常写入且无归属', async () => {
    const eventId = await insertEvent({
      eventType: 'worker.report',
      payload: {
        revision: 1,
        summary: '结论见 https://nvd.nist.gov/vuln/detail/CVE-2021-1234',
        facts: ['上游文档 https://docs.example.org/x'],
        findings: ['app.example.com 的登录页缺少限速'],
      },
      trustLevel: 'agent_claim',
      classification: 'engagement',
    });
    await indexer().indexEventById(engagementId, eventId);

    const chunks = await chunksOf(eventId);
    assert.ok(chunks.length >= 3, '报告各分段都要落库');
    for (const chunk of chunks) {
      assert.deepEqual(chunk.asset_ids, [], '正文里的链接不是目标，不能凭它归属（也不该因此失败）');
      assert.equal(chunk.phase, 'threat-modeling');
    }
  });

  // ── 写入侧义务（§8.6 末段） ──

  test('义务：未登记的目标 → 索引失败，错误码 target_not_adjudicated，且不留半个分块', async () => {
    const eventId = await insertEvent({
      eventType: 'tool.result',
      payload: { target: 'unregistered.example.com', command: 'nmap unregistered.example.com' },
    });

    assert.equal(await rejectionCodeOf(() => indexer().indexEventById(engagementId, eventId)), 'target_not_adjudicated', '有目标但没有任何已登记资产可归属 → 拒绝写入（fail-closed）');
    assert.equal((await chunksOf(eventId)).length, 0, '失败不得留下无归属的分块');
  });

  test('义务：义务校验在写入路径上，而不是只在账本装载路径上', async () => {
    const eventId = await insertEvent({
      eventType: 'tool.result',
      payload: { toolRunId: 'run-x', stdout: 'open ports', exitCode: 0 },
    });
    const event: ChunkSourceEvent = {
      eventId,
      engagementId,
      eventType: 'tool.result',
      workerSessionId: sessionId,
      phase: 'threat-modeling',
      trustLevel: 'tool_observation',
      classification: 'engagement',
      occurredAt: new Date(),
      payload: { toolRunId: 'run-x', stdout: 'open ports', exitCode: 0 },
      // 调用方（写入侧）未解析出归属，却声明了目标线索 → 必须被拦
      assetIds: [],
      targetHints: ['10.20.30.40'],
    };
    assert.equal(
      await rejectionCodeOf(() => indexer().indexEvent(engagementId, event)),
      'target_not_adjudicated',
    );
    assert.equal((await chunksOf(eventId)).length, 0);
  });

  test('义务：有线索但**部分**解析到资产时放行（义务只要求填齐，不要求解析全部线索）', async () => {
    const eventId = await insertEvent({
      eventType: 'tool.result',
      payload: { toolRunId: 'run-y', stdout: 'open ports' },
    });
    const event: ChunkSourceEvent = {
      eventId,
      engagementId,
      eventType: 'tool.result',
      workerSessionId: sessionId,
      trustLevel: 'tool_observation',
      classification: 'engagement',
      occurredAt: new Date(),
      payload: { toolRunId: 'run-y', stdout: 'open ports' },
      assetIds: [includedAssetId],
      targetHints: ['app.example.com', '10.20.30.40'],
    };
    const result = await indexer().indexEvent(engagementId, event);
    assert.ok(result.inserted >= 1);
  });

  test('义务：人类输入、插话、决策无归属也允许写入（ASSET_OPTIONAL_KINDS）', async () => {
    const cases: readonly { eventType: string; payload: unknown }[] = [
      { eventType: 'human.input', payload: { text: '这个段不在范围内', target: '10.20.30.40' } },
      { eventType: 'human.interjection', payload: { text: '先停一下', target: '10.20.30.40' } },
      { eventType: 'human.decision', payload: { text: '批准继续', target: '10.20.30.40' } },
    ];
    for (const item of cases) {
      const eventId = await insertEvent({
        eventType: item.eventType,
        payload: item.payload,
        trustLevel: 'human_decision',
      });
      const result = await indexer().indexEventById(engagementId, eventId);
      assert.equal(result.inserted, 1, `${item.eventType} 必须能写入`);
      const [chunk] = await chunksOf(eventId);
      assert.deepEqual(chunk!.asset_ids, [], '人工输入本就没有资产归属');
      assert.equal(chunk!.asset_ids.length, 0);
    }
  });

  test('义务：思考链无归属也允许写入（检索默认纳入，§8.3）', async () => {
    const eventId = await insertEvent({
      eventType: 'llm.reasoning',
      payload: { text: '先枚举子域，再验证登录页限速', target: '10.20.30.40' },
      trustLevel: 'model_reasoning',
    });
    const result = await indexer().indexEventById(engagementId, eventId);

    assert.equal(result.inserted, 1);
    const [chunk] = await chunksOf(eventId);
    assert.deepEqual(chunk!.asset_ids, [], '思考链无归属，否则按范围过滤时会整批消失');
  });

  test('义务：待定（pending）资产与已登记资产一样能解析出归属', async () => {
    const pendingAssetId = await newAsset({
      canonicalTarget: 'pending.example.com',
      kind: 'domain',
      decision: 'pending',
    });
    const eventId = await insertEvent({
      eventType: 'tool.result',
      payload: { target: 'pending.example.com', command: 'curl http://pending.example.com/' },
    });
    await indexer().indexEventById(engagementId, eventId);

    const [chunk] = await chunksOf(eventId);
    assert.deepEqual(chunk!.asset_ids, [pendingAssetId]);
  });

  test('义务：不自动创建资产——解析不到就是解析不到，登记是情报收集的产出', async () => {
    const before = await pool.query<{ n: string }>(
      'select count(*)::text as n from pentest.assets where engagement_id = $1::uuid',
      [engagementId],
    );
    const eventId = await insertEvent({
      eventType: 'tool.result',
      payload: { target: 'never-registered.example.com' },
    });
    await rejectionCodeOf(() => indexer().indexEventById(engagementId, eventId));

    const after = await pool.query<{ n: string }>(
      'select count(*)::text as n from pentest.assets where engagement_id = $1::uuid',
      [engagementId],
    );
    assert.equal(after.rows[0]!.n, before.rows[0]!.n, '索引器不得替 engagement 追加攻击面');
  });

  // ── 水位路径与范围过滤 ──

  test('runOnce：归属失败 → 整批失败、水位不动、原因里带错误码（可见，不静默）', async () => {
    const fresh = randomUUID();
    const freshSession = randomUUID();
    await pool.query(
      `insert into pentest.engagements
         (id, tenant_id, name, status, current_status, target_snapshot, scope_snapshot, roe_snapshot, policy_snapshot, config_snapshot, created_by)
       values ($1::uuid, 't', 'indexer-assets-watermark', 'running', 'worker_running', '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, 'tester')`,
      [fresh],
    );
    await pool.query(
      `insert into pentest.worker_sessions
         (id, engagement_id, dsh_session_id, phase, profile_id, profile_revision, attempt, iteration,
          scope_version, task_prompt, tool_filter, skill_ids, model_route, status)
       values ($1::uuid, $2::uuid, $3, 'intelligence-gathering', 'p', 'r1', 1, 1, 1,
               'tp', '{}'::jsonb, '[]'::jsonb, '{}'::jsonb, 'active')`,
      [freshSession, fresh, `dsh-idx-assets-${randomUUID()}`],
    );
    await pool.query(
      `insert into pentest.session_leases (engagement_id, worker_session_id, generation, expires_at)
       values ($1::uuid, $2::uuid, 1, now() + interval '1 hour')`,
      [fresh, freshSession],
    );
    await pool.query(
      `insert into pentest.context_events
         (engagement_id, worker_session_id, source_system, source_id, source_seq, event_type,
          schema_version, occurred_at, chain_seq, payload_json, raw_payload_zstd,
          classification, trust_level, event_hash)
       values ($1::uuid, $2::uuid, 'test', 'wm-1', 1, 'tool.result', 1, now(), 1,
               '{"target":"unregistered.example.com"}'::jsonb, '\\x00', 'engagement', 'tool_observation', '\\x01')`,
      [fresh, freshSession],
    );

    try {
      const instance = indexer();
      const run = await instance.runOnce(fresh);
      assert.equal(run.status, 'failed');
      assert.match(String(run.detail), /target_not_adjudicated/);
      assert.equal(run.chunksInserted, 0);

      const wm = await instance.watermark(fresh);
      assert.equal(wm.lastChainSeq, 0, '失败时水位不得推进（重扫同一批）');
      assert.equal(wm.lagEvents, 1, '滞后可观测——坏事件不会静默消失');
    } finally {
      await cleanupEngagement(fresh);
    }
  });

  test('坏事件可见：经调度器索引失败 → 退避重试 → 重试耗尽进死信（不静默、可人工核查）', async () => {
    const fresh = randomUUID();
    const freshSession = randomUUID();
    await pool.query(
      `insert into pentest.engagements
         (id, tenant_id, name, status, current_status, target_snapshot, scope_snapshot, roe_snapshot, policy_snapshot, config_snapshot, created_by)
       values ($1::uuid, 't', 'indexer-assets-deadletter', 'running', 'worker_running', '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, 'tester')`,
      [fresh],
    );
    await pool.query(
      `insert into pentest.worker_sessions
         (id, engagement_id, dsh_session_id, phase, profile_id, profile_revision, attempt, iteration,
          scope_version, task_prompt, tool_filter, skill_ids, model_route, status)
       values ($1::uuid, $2::uuid, $3, 'intelligence-gathering', 'p', 'r1', 1, 1, 1,
               'tp', '{}'::jsonb, '[]'::jsonb, '{}'::jsonb, 'active')`,
      [freshSession, fresh, `dsh-idx-assets-${randomUUID()}`],
    );

    try {
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
      [fresh, freshSession],
    );

      const d = db();
      // maxAttempts=1：一次失败即耗尽，直接看死信（默认 5 次会先挂退避重试）
      const outbox = new PgOutboxQueue(d, { maxAttempts: 1 });
      const failures: string[] = [];
      const dispatcher = new IndexDispatcher({
        outbox,
        indexer: new MemoryIndexer({ db: d, txDb: d }),
        db: d,
        onJobFailure: (_job, error) => {
          failures.push(error instanceof IndexerError ? error.code : `非索引器错误：${String(error)}`);
        },
      });
      const ledger = new MemoryLedger({
        db: d,
        txDb: d,
        secret: 'indexer-assets-test-secret-32-bytes',
        indexOutbox: new LedgerIndexEnqueue(outbox),
      });

      await ledger.appendEvent({
        engagementId: fresh,
        workerSessionId: freshSession,
        eventType: 'tool.result',
        sourceSystem: 'indexer-assets-test',
        sourceId: `dead-${randomUUID()}`,
        sourceSeq: 1,
        occurredAt: new Date(),
        payload: { target: 'unregistered.example.com', command: 'nmap unregistered.example.com' },
        rawPayload: new TextEncoder().encode('{}'),
        classification: 'engagement',
        trustLevel: 'tool_observation',
      });

      const batch = await dispatcher.dispatchBatch(fresh);
      assert.equal(batch.claimed, 1, '账本追加应同事务入队一条索引任务');
      assert.equal(batch.failed, 1);
      assert.deepEqual(failures, ['target_not_adjudicated'], '失败必须带稳定错误码交到回调');

      const stats = await outbox.stats(fresh);
      assert.equal(stats.counts.dead, 1, '重试耗尽即死信——问题在队列上可见，不需要翻日志');
      const jobs = await pool.query<{ status: string; last_error: string | null }>(
        'select status, last_error from pentest.outbox_jobs where engagement_id = $1::uuid',
        [fresh],
      );
      assert.match(String(jobs.rows[0]!.last_error), /target_not_adjudicated|已登记资产/);
      const left = await pool.query<{ n: string }>(
        'select count(*)::text as n from pentest.memory_chunks where engagement_id = $1::uuid',
        [fresh],
      );
      assert.equal(Number(left.rows[0]!.n), 0, '死信事件不得留下无归属的分块');
    } finally {
      await cleanupEngagement(fresh);
    }
  });

  test('范围过滤：被排除资产的分块检索不到，已纳入与无归属的分块可见（§8.6）', async () => {
    // 三条分块：归属已纳入资产、归属被排除资产、以及无归属的人类输入。
    const includedEvent = await insertEvent({
      eventType: 'tool.result',
      payload: { target: 'app.example.com', command: 'nmap app.example.com' },
    });
    const excludedEvent = await insertEvent({
      eventType: 'tool.result',
      payload: { target: 'old.example.com', command: 'nmap old.example.com' },
    });
    const looseEvent = await insertEvent({
      eventType: 'human.input',
      payload: { text: '与资产无关的范围说明' },
      trustLevel: 'human_decision',
    });
    const instance = indexer();
    for (const id of [includedEvent, excludedEvent, looseEvent]) {
      await instance.indexEventById(engagementId, id);
    }

    // 会话绑定的范围版本按 §8.6 的公式下推（version-join 形态：直接查 asset_scope_versions）
    const sql = buildRetrievalSql({
      engagementId,
      query: { query: '' },
      includedAssetIds: [],
      excludedAssetIds: [],
      scopeResolution: 'version-join',
      scopeVersion: SCOPE_VERSION,
    });
    const visible = await pool.query<{ id: string; source_event_id: string; asset_ids: string[] }>(
      `select mc.id, mc.source_event_id, mc.asset_ids from pentest.memory_chunks mc where ${sql.where}`,
      [...sql.params],
    );
    const visibleEvents = new Set(visible.rows.map((row) => row.source_event_id));

    assert.ok(visibleEvents.has(includedEvent), '已纳入资产的分块必须可见');
    assert.ok(visibleEvents.has(looseEvent), '空 asset_ids 必须放行，否则思考链与人工决策会整批消失');
    assert.ok(!visibleEvents.has(excludedEvent), '排除是硬边界：被排除资产的分块不得出现在检索面');
    assert.equal(
      visible.rows.some((row) => row.asset_ids.includes(excludedAssetId)),
      false,
    );
  });

  test('范围过滤：范围版本升级后，原先被排除的资产重新可见（不需重建索引）', async () => {
    const eventId = await insertEvent({
      eventType: 'tool.result',
      payload: { target: 'old.example.com', command: 'nmap old.example.com' },
    });
    await indexer().indexEventById(engagementId, eventId);

    const version = SCOPE_VERSION + 1;
    await pool.query(
      `insert into pentest.scope_versions
         (engagement_id, version, iteration, targets, exclusions, changed_by, content_hash)
       values ($1::uuid, $2, 2, '[]'::jsonb, '[]'::jsonb, 'tester', 'h2')`,
      [engagementId, version],
    );
    await pool.query(
      `insert into pentest.asset_scope_versions (asset_id, scope_version, engagement_id, decision, decided_by)
       values ($1::uuid, $2, $3::uuid, 'included', 'tester')`,
      [excludedAssetId, version, engagementId],
    );

    const sql = buildRetrievalSql({
      engagementId,
      query: { query: '' },
      includedAssetIds: [],
      excludedAssetIds: [],
      scopeResolution: 'version-join',
      scopeVersion: version,
    });
    const visible = await pool.query<{ source_event_id: string }>(
      `select mc.source_event_id from pentest.memory_chunks mc where ${sql.where}`,
      [...sql.params],
    );
    assert.ok(
      visible.rows.some((row) => row.source_event_id === eventId),
      '范围版本升级即重新可见（"追加为范围的历史内容重新可见"），分块不动',
    );
  });
});
