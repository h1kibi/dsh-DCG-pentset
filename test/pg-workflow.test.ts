/**
 * 人类工作流服务的集成测试：验证状态机在**真实数据库**上的行为。
 *
 * 这个文件覆盖的是此前完全没有执行者的部分——`state_version`、
 * `state_transitions`、`human_decisions` 的写入方。重点证明四条核心不变量：
 *
 *   I-04 Worker 报告只把会话置为等待人工判断，**不改变阶段**
 *   I-05 阶段切换必然创建新会话；重做默认复用当前会话
 *   I-03 所有推进来自人类操作；乐观锁让并发点击只有一个成功
 *   §5.1 暂停是正交标记，**不改写主状态、不吊销租约**
 *
 * 需要 `PENTEST_DATABASE_URL`；未设置时整组 skip。
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { Pool } from 'pg';

import { assertNoResidue, cleanupEngagements } from './helpers/cleanup.ts';
import { scopeContentHash } from '../src/policy/scope-snapshot.ts';
import { policyContentHash } from '../src/policy/behavior-profile.ts';
import { TERMINAL_SESSION_STATUSES } from '../src/contracts.ts';
import type { MainStatus, ScopeTarget, TransitionType } from '../src/contracts.ts';
import { isLegalStatusEdge } from '../src/workflow/phases.ts';
import { computeDraftHash, computeHandoffHash } from '../src/workflow/handoff.ts';

import { PgWorkflowService } from '../src/workflow/pg-workflow.ts';
import { WorkflowRejection } from '../src/workflow/model.ts';
import type { RlsScopePort, WorkflowServiceDeps } from '../src/workflow/model.ts';
import { PgLeaseStore } from '../src/workflow/pg-lease.ts';
import { PgReportService } from '../src/report/pg-report.ts';
import { MemoryLedger, PgAnchorSink } from '../src/memory/ledger.ts';
import { planChunks } from '../src/memory/chunks.ts';
import type { DbClient } from '../src/db/port.ts';
import { SessionFactoryError } from '../src/workflow/session-port.ts';
import type { SessionFactory, CreatedSession, FrozenSessionInput } from '../src/workflow/session-port.ts';

const DATABASE_URL = process.env.PENTEST_DATABASE_URL;

/** 假会话工厂：记录调用，不接触真实 dsh。 */
class FakeSessionFactory implements SessionFactory {
  readonly created: FrozenSessionInput[] = [];
  readonly delivered: Array<{ dshSessionId: string; message: string }> = [];
  readonly closed: string[] = [];
  #failCreate = false;

  failNextCreate(): void {
    this.#failCreate = true;
  }

  async create(input: FrozenSessionInput): Promise<CreatedSession> {
    if (this.#failCreate) {
      this.#failCreate = false;
      throw new SessionFactoryError('模拟 dsh 不可用', { dshSessionId: input.dshSessionId });
    }
    this.created.push(input);
    return { dshSessionId: input.dshSessionId };
  }

  async deliver(dshSessionId: string, message: string): Promise<void> {
    if (this.closed.includes(dshSessionId)) {
      throw new SessionFactoryError('会话已关闭', { dshSessionId });
    }
    this.delivered.push({ dshSessionId, message });
  }

  /** 记录每次草稿请求的目标阶段（用于断言「省略时按状态机」）。 */

  async interrupt(): Promise<void> {}

  async close(dshSessionId: string): Promise<void> {
    this.closed.push(dshSessionId);
  }
}

describe('工作流服务', { skip: DATABASE_URL === undefined ? '未设置 PENTEST_DATABASE_URL' : false }, () => {
  let pool: Pool;
  /** 夹具里的租户标识（与直接写库的 fixtures `tenant_id = 't'` 一致）。 */
  const TENANT = 't';
  let service: PgWorkflowService;
  let sessions: FakeSessionFactory;
  let report: PgReportService;
  let deps: WorkflowServiceDeps;
  let engagementId: string;

  /**
   * 专用读连接（在 `before` 里取、`after` 里还）。
   *
   * 为什么不能用连接池：`set_rls_context` 是**连接级**状态，而连接池每次借出的连接不同——
   * 在一条连接上设好的租户/作业上下文，下一条查询可能落到另一条连接上，
   * 表现就是「上下文明明设了却读不到」这种最难查的间歇性失败。
   */
  let readClient: { query: DbClient['query']; release: () => void } | null = null;

  const db = (): DbClient => ({
    async query<Row = Record<string, unknown>>(sql: string, params?: readonly unknown[]) {
      const r = readClient === null
        ? await pool.query(sql, params as unknown[] | undefined)
        : await readClient.query(sql, params as unknown[] | undefined);
      return { rows: r.rows as Row[], rowCount: r.rowCount };
    },
  });

  /** 每次测试用独立连接做独占用（事务必须落在同一连接上）。 */
  let txClient: { query: DbClient['query']; release: () => void };

  before(async () => {
    pool = new Pool({ connectionString: DATABASE_URL });
    const [client, readConn] = await Promise.all([pool.connect(), pool.connect()]);
    readClient = {
      query: (async <Row = Record<string, unknown>>(sql: string, params?: readonly unknown[]) => {
        const r = await readConn.query(sql, params as unknown[] | undefined);
        return { rows: r.rows as Row[], rowCount: r.rowCount };
      }) as DbClient['query'],
      release: () => readConn.release(),
    };
    txClient = {
      query: (async (sql: string, params?: readonly unknown[]) => {
        const r = await client.query(sql, params as unknown[] | undefined);
        return { rows: r.rows, rowCount: r.rowCount };
      }) as DbClient['query'],
      release: () => { client.release(); },
    };
    sessions = new FakeSessionFactory();
    const readDb = db();
    const txDb: DbClient = {
      async query<Row = Record<string, unknown>>(sql: string, params?: readonly unknown[]) {
        return txClient.query<Row>(sql, params);
      },
    };
    const ledger = new MemoryLedger({
      db: readDb,
      txDb,
      secret: 'workflow-test-secret-32-bytes-minimum',
      anchors: new PgAnchorSink(txDb),
    });
    const leases = new PgLeaseStore(pool);
    report = new PgReportService(readDb, { txDb });
    // 与生产同构：租户上下文 + 作业作用域。缺了它，`worker_session_binding_by_dsh`
    // （函数体要求租户在场）恒返回 0 行，「会话状态」端点会退化成「没有待办」。
    // 上下文必须裹在**事务里**：`set_rls_context` 内部用 `set_config(..., is_local=true)`，
    // 自动提交下只对当前语句有效——事务一结束（其实上一条语句一结束）上下文就没了，
    // 表现是「设了却读不到」（与生产的 `poolAsDbClient` 同构：BEGIN → 设 → 读 → COMMIT）。
    const rlsScope: RlsScopePort = {
      run: async (scope, work) => {
        await readDb.query('begin');
        try {
          await readDb.query('select pentest.set_rls_context($1, $2::uuid, $3::uuid)', [
            TENANT,
            scope.engagementId ?? null,
            scope.workerSessionId ?? null,
          ]);
          const value = await work();
          await readDb.query('commit');
          return value;
        } catch (error) {
          try {
            await readDb.query('rollback');
          } catch (rollbackError) {
            // 回滚失败**不能顶掉**原始错误：原始错误才是「这次调用为什么失败」的答案。
            // 但也不能丢——把它并进消息里，两件事都留在记录上（2026-10-05 复核 REQ-12）。
            if (error instanceof Error) {
              error.message += `（附带：回滚也失败——${String(rollbackError)}）`;
            }
          }
          throw error;
        }
      },
      current: () => undefined,
    };
    const depsLocal: WorkflowServiceDeps = {
      db: readDb,
      txDb,
      sessions,
      leases,
      ledger,
      report,
      reportSignature: report,
      rlsContext: { tenantId: TENANT },
      rlsScope,
    };
    deps = depsLocal;
    service = new PgWorkflowService(depsLocal);
  });

  after(async () => {
    // 此前这里**完全不清理**：本文件建了十几个 engagement 却一个都没删，
    // 每个测试跑完都留下全套数据（实测跑一次全量就留 3 个 `wf-test`）。
    // 现在用共享夹具清理，并按依赖覆盖全部相关表。
    if (pool !== undefined) {
      await cleanupEngagements(pool, madeEngagements);
      // 断言清理生效：残留会跨运行累积，让后续用例读到前次数据（REQ-12）。
      await assertNoResidue(pool, madeEngagements);
    }
    if (readClient !== null) {
      // 不吞错：这是**租户上下文复位**，而连接要还给池。复位失败时把它放回池里，
      // 会让下一个借到它的用例带着上一个租户的 RLS 上下文——静默的跨租户可见。
      await readClient.query('select pentest.set_rls_context($1, null, null)', [TENANT]);
      readClient.release();
      readClient = null;
    }
    txClient?.release();
    await pool?.end();
  });

  /** 本文件建的全部 engagement，供共享夹具在 after 里清理。 */
  const madeEngagements: string[] = [];

  /** 建一个 READY 的新 engagement。 */
  async function newEngagement(): Promise<string> {
    const id = randomUUID();
    // 单点追踪：所有调用者自动被记录，不会漏
    madeEngagements.push(id);
    await pool.query(
      `insert into pentest.engagements
         (id, tenant_id, name, status, current_status, target_snapshot, scope_snapshot, roe_snapshot, policy_snapshot, config_snapshot, created_by)
       values ($1::uuid,'t','wf-test','running','ready','{}'::jsonb,'{}'::jsonb,'{}'::jsonb,'{}'::jsonb,'{}'::jsonb,'tester')`,
      [id],
    );
    return id;
  }

  /**
   * 造第二个独立的工作流实例（各持一条独占连接），用于测真实并发。
   *
   * 共用一条连接的并发会由内部队列串行化，测不出「两个人类同时操作」的语义。
   */
  async function makeSecondService(): Promise<{ service: PgWorkflowService; dispose: () => Promise<void> }> {
    const client = await pool.connect();
    const readDb: DbClient = db();
    const txDb: DbClient = {
      async query<Row = Record<string, unknown>>(sql: string, params?: readonly unknown[]) {
        const r = await client.query(sql, params as unknown[] | undefined);
        return { rows: r.rows as Row[], rowCount: r.rowCount };
      },
    };
    const ledger = new MemoryLedger({
      db: readDb,
      txDb,
      secret: 'workflow-test-secret-32-bytes-minimum',
      anchors: new PgAnchorSink(txDb),
    });
    return {
      service: new PgWorkflowService({ db: readDb, txDb, sessions, leases: new PgLeaseStore(pool), ledger }),
      dispose: async () => { client.release(); },
    };
  }

  async function scopeVersionOf(id: string): Promise<number> {
    await pool.query(
      `insert into pentest.scope_versions (engagement_id, version, iteration, targets, exclusions, changed_by, content_hash)
       values ($1::uuid, 1, 1, '[]'::jsonb, '[]'::jsonb, 'tester', 'h1')
       on conflict (engagement_id, version) do nothing`,
      [id],
    );
    return 1;
  }

  test('getState 读出两层状态（主状态 + 运行标记）', async () => {
    engagementId = await newEngagement();
    const s = await service.getState(engagementId);
    assert.equal(s.mainStatus, 'ready');
    assert.equal(s.runMarker, 'running');
    assert.equal(s.stateVersion, 0);
    assert.equal(s.activeWorkerSessionId, null);
  });

  test('getState 给出范围版本与授权到期（运行总览要靠它们，缺了界面永远是「—」）', async () => {
    // 这两条是回归锁：它们曾经不在快照里，于是运行总览的两格永远显示「—」——
    // 而「—」既可能是「没声明」也可能是「没读」，人分不清，
    // 也就看不到自己的授权只剩几天（那是 §11.1 的硬边界）。
    const expires = '2030-01-02T03:04:05.000Z';
    const created = await service.createEngagement({
      behaviorProfile: 'stealth',
      approvalMode: 'human',
      operatorId: 'op',
      reason: '建授权',
      name: 'snapshot-fields',
      authorizationRef: 'SOW-9',
      authorizationExpiresAt: expires,
      targets: [{ kind: 'domain', value: 'example.com', protocols: ['tcp'], ports: [] }],
      exclusions: [],
      roe: {},
      timeWindow: {},
    });
    madeEngagements.push(created.id);

    // 建完即有范围版本 1
    const after = await service.getState(created.id);
    assert.equal(after.authorizationExpiresAt, expires, '授权到期必须原样给出来');
    assert.equal(after.scopeVersion, 1, '建 engagement 即产生范围版本 1');
  });

  test('无范围版本时 scopeVersion 给 null（而不是 0——0 会被读成「有一个版本叫 v0」）', async () => {
    const bare = await newEngagement();
    const s = await service.getState(bare);
    assert.equal(s.scopeVersion, null);
    // 未声明授权到期同样给 null，不是空串
    const unset = await service.createEngagement({
      behaviorProfile: 'stealth',
      approvalMode: 'human',
      operatorId: 'op', reason: '无到期', name: 'no-expiry', authorizationRef: 'SOW-10',
      authorizationExpiresAt: '', exclusions: [], roe: {}, timeWindow: {},
      targets: [{ kind: 'domain', value: 'unset.example.com', protocols: ['tcp'], ports: [] }],
    });
    madeEngagements.push(unset.id);
    const s2 = await service.getState(unset.id);
    assert.equal(s2.authorizationExpiresAt, null, '空串要归一成 null，别让界面渲染出空白');
  });

  test('startWorker：从 READY 创建会话、签发租约、写转移与决策记录', async () => {
    const started = await service.startWorker({
      engagementId,
      operatorId: 'op',
      reason: '开始情报收集',
      expectedStateVersion: 0,
      phase: 'intelligence-gathering',
      taskPrompt: '收集目标资产',
      skillIds: [],
      toolAllow: ['memory_search', 'pentest_exec'],
    });

    assert.ok(started.workerSessionId.length > 0);
    assert.equal(started.dshSessionId, `dsh-${started.workerSessionId}`, 'dsh 会话标识必须确定性派生');
    assert.equal(started.leaseGeneration, 1);

    const s = await service.getState(engagementId);
    assert.equal(s.mainStatus, 'worker_running');
    assert.equal(s.currentPhase, 'intelligence-gathering');
    assert.equal(s.stateVersion, 1);
    assert.equal(s.activeWorkerSessionId, started.workerSessionId);

    // 决策与转移各一条
    const d = await pool.query(
      `select count(*)::int as n from pentest.human_decisions where engagement_id = $1::uuid`,
      [engagementId],
    );
    const t = await pool.query(
      `select count(*)::int as n, min(transition_type) as ty from pentest.state_transitions where engagement_id = $1::uuid`,
      [engagementId],
    );
    assert.equal(d.rows[0]!.n, 1);
    assert.equal(t.rows[0]!.n, 1);
    assert.equal(t.rows[0]!.ty, 'start');

    // 会话行状态：假工厂成功 → active
    const ws = await pool.query(
      `select status, dsh_session_id from pentest.worker_sessions where id = $1::uuid`,
      [started.workerSessionId],
    );
    assert.equal(ws.rows[0]!.status, 'active');
    assert.equal(ws.rows[0]!.dsh_session_id, started.dshSessionId);
    assert.equal(sessions.created.length, 1, '会话工厂必须被调用一次');
  });
  test('startWorker：预算上限冻结到 worker_sessions', async () => {
    engagementId = await newEngagement();
    const started = await service.startWorker({
      engagementId,
      operatorId: 'op',
      reason: '带预算启动',
      expectedStateVersion: 0,
      phase: 'intelligence-gathering',
      taskPrompt: '预算测试',
      budget: { maxTokens: 1234, maxSteps: 7, maxSeconds: 89 },
    });
    const row = await pool.query<{ budget_max_tokens: number | string; budget_max_steps: number | string; budget_max_seconds: number | string }>(
      `select budget_max_tokens, budget_max_steps, budget_max_seconds
         from pentest.worker_sessions where id = $1::uuid`,
      [started.workerSessionId],
    );
    assert.deepEqual(
      [Number(row.rows[0]?.budget_max_tokens), Number(row.rows[0]?.budget_max_steps), Number(row.rows[0]?.budget_max_seconds)],
      [1234, 7, 89],
    );
  });

  test('省略 toolAllow/skillIds 时用该阶段能力的默认装载（而不是空工具面）', async () => {
    // 这条防的是一个真实的致命缺陷：控制台固定传 `skillIds: []` / `toolAllow: []`，
    // 而宿主把 allow 当**白名单**——空集意味着「一个工具都不给」，Agent 连
    // `pentest_exec` 都看不见，界面上却毫无异常。省略与显式空数组必须区分开。
    // 自建 engagement：共享的那个已被前面的用例推进到版本 1，
    // 依赖它的版本号会让这条测试随执行顺序而变。
    const own = await newEngagement();
    const started = await service.startWorker({
      engagementId: own,
      operatorId: 'op',
      reason: '按阶段默认启动',
      expectedStateVersion: 0,
      phase: 'intelligence-gathering',
      taskPrompt: '收集目标资产',
      // 刻意不传 skillIds / toolAllow
    });

    const frozen = sessions.created.at(-1);
    assert.ok(frozen, '会话工厂必须被调用');
    assert.equal(frozen.dshSessionId, started.dshSessionId);
    // 内置默认能力声明的就是这一份（其中 pentest_exec 是触及目标的出口；
    // ask_user_question 是官方提问通道，让 Agent 能把岔路口摆成可点的选项；
    // pentest_prepare_handoff 让「进入下一阶段」有明确去处（指路到控制台按钮），不反问人类——它一度
    // 只存在于工具注册表里、没进这份默认装载，等于那个修复没生效，故在此钉住；
    // skill_load 是 skill 正文的唯一读取入口（能力快照只给名字+描述）——它同样一度缺失，
    // 结果是 21 份 skill 的正文一条都取不到（2026-10-06 补）；
    // pentest_recon 是同一批新增的**结构化侦察**入口，只发给需要它的阶段——
    // 本用例用的阶段是情报收集，因此它在列表里；其它阶段的工具面由
    // `test/action-templates.test.ts` 的边界断言钉住。
    assert.deepEqual(
      [...frozen.toolAllow].sort(),
      [
        'artifact_read',
        'ask_user_question',
        'memory_read',
        'memory_search',
        'pentest_exec',
        'pentest_prepare_handoff',
        'pentest_recon',
        'pentest_request_action_approval',
        'pentest_submit_report',
        // 作业目录读写：不进范围裁决的**非目标**通道（2026-10-07）——空范围作业里
        // 它是唯一能读到作业资料的入口，因此每个阶段（含情报收集）默认都带。
        'pentest_workdir',
        'pentest_write_status_note',
        'skill_load',
      ],
      '省略时必须拿到阶段能力的默认工具面，而不是空集',
    );

    // 同一份列表也必须落库：会话重建（复用/重做）时靠它还原冻结能力。
    const row = await pool.query(
      `select tool_filter from pentest.worker_sessions where id = $1::uuid`,
      [started.workerSessionId],
    );
    assert.deepEqual([...row.rows[0]!.tool_filter.allow].sort(), [...frozen.toolAllow].sort());
  });

  test('提问通道两侧必须齐备：渗透模式预设挂官方工具行', async () => {
    // 官方 `ask_user_question` 的**宿主半是空实现**（包内注释原话：the model-facing tool is
    // composed per preset, not here）——所以「AI 提问、人类点选项」这条通道只能由预设挂载，
    // 交互界面由官方 `@deepseek-ai/dsh-client-ui-user-questions` 接管（随 web-app bundle 已启用）。
    //
    // 两侧分工：
    //   * 预设那一行缺失 ⇒ 工具根本没注册，模型问不了（人类收到的是纯文本问卷，得手抄答案）；
    //   * 工具面那一行缺失 ⇒ 预设走祖先作用域，`restrict({allow})` 会把它挡在会话之外；
    //   * 工具面有、预设没有 ⇒ `restrict()` 因**未知工具名**抛错，会话直接建不起来。
    // 工具面那一侧由上面两条用例（阶段默认 + intake）钉住，这里只钉预设这一侧。
    const preset = await readFile(new URL('../presets/pentest/agent.cordis.yml', import.meta.url), 'utf8');
    assert.match(
      preset,
      /^\s*- id: tool-ask-user\s*$/m,
      '渗透模式预设必须挂 tool-ask-user 行，否则 Worker 会话拿不到提问工具',
    );
    assert.match(preset, /@deepseek-ai\/dsh-tool-ask-user/, '预设行必须指向官方包（不要复制官方 schema）');
  });

  test('显式给空 toolAllow 仍然生效：那是「真的要零工具」，不是「用默认」', async () => {
    const own = await newEngagement();
    const started = await service.startWorker({
      engagementId: own,
      operatorId: 'op',
      reason: '刻意零工具',
      expectedStateVersion: 0,
      phase: 'intelligence-gathering',
      taskPrompt: '不装任何工具',
      skillIds: [],
      toolAllow: [],
    });

    const frozen = sessions.created.at(-1);
    assert.deepEqual(frozen?.toolAllow, [], '显式空数组必须原样保留，不能被默认值顶掉');
    assert.ok(started.workerSessionId.length > 0);
  });

  test('乐观锁：期望版本不符时拒绝（stale_state_version）', async () => {
    await assert.rejects(
      () =>
        service.startWorker({
          engagementId,
          operatorId: 'op',
          reason: '重复点击',
          expectedStateVersion: 0,
          phase: 'intelligence-gathering',
          taskPrompt: 'x',
          skillIds: [],
          toolAllow: [],
        }),
      (e: unknown) => {
        assert.ok(e instanceof WorkflowRejection);
        assert.equal(e.code, 'stale_state_version');
        return true;
      },
    );
    // 版本未被推进
    assert.equal((await service.getState(engagementId)).stateVersion, 1);
  });

  test('并发启动只有一个成功（行锁 + 唯一索引）', async () => {
    const id = await newEngagement();
    await scopeVersionOf(id);

    // 两个**独立**的工作流实例，各持一条独占连接——这才是真实并发：
    // 两个浏览器会话各自驱动一个实例。同一实例内的并发由内部队列串行化，
    // 因此不能用单实例测并发语义。
    const other = await makeSecondService();
    try {
      const attempt = (svc: PgWorkflowService): Promise<unknown> =>
        svc.startWorker({
          engagementId: id,
          operatorId: 'op',
          reason: '并发',
          expectedStateVersion: 0,
          phase: 'intelligence-gathering',
          taskPrompt: 'x',
          skillIds: [],
          toolAllow: [],
        });
      const results = await Promise.allSettled([attempt(service), attempt(other.service)]);
      const ok = results.filter((r) => r.status === 'fulfilled').length;
      assert.equal(ok, 1, '两个并发请求必须只有一个成功');
    } finally {
      await other.dispose();
    }

    const live = await pool.query(
      `select count(*)::int as n from pentest.worker_sessions
        where engagement_id = $1::uuid and status in ('starting','active','waiting_human','handoff_drafting','transition_confirmation','paused','blocked')`,
      [id],
    );
    assert.equal(live.rows[0]!.n, 1, '一个 engagement 只能有一个存活会话');
    const transitions = await pool.query(
      `select count(*)::int as n from pentest.state_transitions
        where engagement_id = $1::uuid and transition_type = 'start'`,
      [id],
    );
    assert.equal(transitions.rows[0]!.n, 1, '只应写入一条 start 转移记录');
  });

  test('startWorker 仅限 READY；在 worker_running 时拒绝', async () => {
    await assert.rejects(
      () =>
        service.startWorker({
          engagementId,
          operatorId: 'op',
          reason: '越权',
          expectedStateVersion: 1,
          phase: 'threat-modeling',
          taskPrompt: 'x',
          skillIds: [],
          toolAllow: [],
        }),
      (e: unknown) => e instanceof WorkflowRejection && e.code === 'classification_rejected',
    );
  });

  test('signReport 只接受服务端报告版本哈希，并把真实版本写入签字审计', async () => {
    const id = await newEngagement();
    await pool.query(
      `update pentest.engagements
          set current_status = 'report_ready', current_phase = 'exploitation'
        where id = $1::uuid`,
      [id],
    );

    const draft = await report.getReportDraft(id);
    assert.equal(draft.version, 1);
    assert.equal(typeof draft.contentHash, 'string');

    await assert.rejects(
      () => service.signReport({
        engagementId: id,
        operatorId: 'report-signer',
        expectedStateVersion: 0,
        contentHash: 'attacker-supplied-hash',
      }),
      (error: unknown) => error instanceof WorkflowRejection && error.code === 'stale_state_version',
      '客户端伪造或过期的哈希必须在落库前被拒绝',
    );
    const stillReady = await pool.query<{ current_status: string; state_version: string }>(
      'select current_status, state_version from pentest.engagements where id = $1::uuid',
      [id],
    );
    assert.equal(stillReady.rows[0]?.current_status, 'report_ready');
    assert.equal(stillReady.rows[0]?.state_version, '0');

    const signed = await service.signReport({
      engagementId: id,
      operatorId: 'report-signer',
      expectedStateVersion: 0,
      contentHash: draft.contentHash!,
    });
    assert.deepEqual(signed, { engagementId: id, version: 1, contentHash: draft.contentHash });

    const decision = await pool.query<{ subject_id: string }>(
      `select subject_id from pentest.human_decisions
        where engagement_id = $1::uuid and decision_type = 'sign_report'
        order by created_at desc limit 1`,
      [id],
    );
    assert.equal(decision.rows[0]?.subject_id, draft.contentHash);
    const signedRow = await pool.query<{ signed_by: string | null; signed_at: string | null; content_hash: string }>(
      `select signed_by, signed_at, content_hash from pentest.reports
        where engagement_id = $1::uuid and version = 1`,
      [id],
    );
    assert.equal(signedRow.rows[0]?.signed_by, 'report-signer');
    assert.notEqual(signedRow.rows[0]?.signed_at, null);
    assert.equal(signedRow.rows[0]?.content_hash, draft.contentHash);
    const completed = await pool.query<{ current_status: string; state_version: string }>(
      'select current_status, state_version from pentest.engagements where id = $1::uuid',
      [id],
    );
    assert.equal(completed.rows[0]?.current_status, 'complete');
    assert.equal(completed.rows[0]?.state_version, '1');
  });

  test('暂停：只改运行标记，主状态与租约都不变（§5.1 / §10.6）', async () => {
    // 起点摆在「等待人工判断」：这条用例需要「主状态 ≠ worker_running」才能证明暂停不改写它。
    // （此前这个状态由同一个文件里那份已删除的 `finishWorker` 用例顺手留下——那是隐式依赖，
    // 现在显式摆放。）
    const seed = await service.getState(engagementId);
    await markWaitingHuman(engagementId, seed.activeWorkerSessionId!);
    const before = await service.getState(engagementId);
    const leaseBefore = await pool.query(
      `select count(*)::int as n from pentest.session_leases
        where worker_session_id = $1::uuid and revoked_at is null`,
      [before.activeWorkerSessionId],
    );

    const paused = await service.pause({
      engagementId,
      operatorId: 'op',
      reason: '暂缓',
      expectedStateVersion: before.stateVersion,
    });
    assert.equal(paused.runMarker, 'paused');
    assert.equal(paused.mainStatus, 'waiting_human_review', '暂停不得改写主状态');

    const leaseAfter = await pool.query(
      `select count(*)::int as n from pentest.session_leases
        where worker_session_id = $1::uuid and revoked_at is null`,
      [before.activeWorkerSessionId],
    );
    assert.equal(
      leaseAfter.rows[0]!.n,
      leaseBefore.rows[0]!.n,
      '暂停必须保留租约——吊销会连带作废该会话全部待用放行凭证',
    );

    // 恢复：回到原主状态
    const resumed = await service.resume({
      engagementId,
      operatorId: 'op',
      reason: '继续',
      expectedStateVersion: paused.stateVersion,
    });
    assert.equal(resumed.runMarker, 'running');
    assert.equal(resumed.mainStatus, 'waiting_human_review', '恢复回到暂停前的主状态');
  });

  test('插话唤醒：等待人工 → 运行中，写 interject_wake 且不递增迭代', async () => {
    // 唤醒路径的起点必须是「等待人工判断 + 会话 waiting_human」——显式摆放（同上）。
    const seed = await service.getState(engagementId);
    await markWaitingHuman(engagementId, seed.activeWorkerSessionId!);
    const before = await service.getState(engagementId);
    const result = await service.interject({
      workerSessionId: before.activeWorkerSessionId!,
      message: '请先看 10.0.0.5 这台',
      expectedStateVersion: before.stateVersion,
    });
    assert.equal(result.delivered, true);
    assert.equal(result.transitionType, 'interject_wake');

    const after = await service.getState(engagementId);
    assert.equal(after.mainStatus, 'worker_running');
    assert.equal(
      after.graphIteration,
      before.graphIteration,
      '插话唤醒不是回环，不得递增迭代（§5.4）',
    );

    const t = await pool.query(
      `select count(*)::int as n from pentest.state_transitions
        where engagement_id = $1::uuid and transition_type = 'interject_wake'`,
      [engagementId],
    );
    assert.equal(t.rows[0]!.n, 1);

    // ── 写入侧 → 账本 → 分块器：插话正文必须一路走到底 ──
    //
    // 只写 `{delivered, woke}` 的旧形状会让人类指令在检索面与审计里都不存在
    //（QA 2026-10-04 实测：插话提到的端口在 `memory_chunks` 里查不到）。
    // 这里断言的是**真实写进账本的那一行**，不是手抄的载荷。
    const events = await pool.query<{ payload_json: Record<string, unknown> }>(
      `select payload_json from pentest.context_events
        where engagement_id = $1::uuid and event_type = 'human.interjection'
        order by chain_seq desc limit 1`,
      [engagementId],
    );
    const payload = events.rows[0]?.payload_json ?? {};
    assert.equal(payload.text, '请先看 10.0.0.5 这台', '插话正文必须进账本载荷（分块器按 payload.text 取内容）');
    assert.equal(payload.woke, true, '唤醒路径要留下 woke 事实');

    const drafts = planChunks({
      eventId: 'qa-interjection-event',
      engagementId,
      eventType: 'human.interjection',
      trustLevel: 'human_decision',
      classification: 'engagement',
      occurredAt: new Date(),
      payload,
    });
    assert.equal(drafts.length, 1, '账本里的载荷必须能落成一块');
    assert.equal(drafts[0]?.kind, 'human_input');
    assert.match(drafts[0]?.content ?? '', /10\.0\.0\.5/);
  });

  test('重做：默认复用当前会话，执行次数递增且不创建新会话', async () => {
    // 先让会话回到等待人工
    const s0 = await service.getState(engagementId);
    await markWaitingHuman(engagementId, s0.activeWorkerSessionId!);
    const s1 = await service.getState(engagementId);
    const sessionsBefore = sessions.created.length;

    const r = await service.retryWorker({
      engagementId,
      operatorId: 'op',
      reason: '再试一次',
      expectedStateVersion: s1.stateVersion,
      taskPrompt: '请重试，上次漏了 vhost',
      reuseSession: true,
    });

    assert.equal(r.sessionReused, true);
    assert.equal(r.workerSessionId, s1.activeWorkerSessionId, '复用必须是同一会话');
    assert.equal(sessions.created.length, sessionsBefore, '复用不得创建新 dsh 会话');

    const ws = await pool.query(`select attempt from pentest.worker_sessions where id = $1::uuid`, [
      s1.activeWorkerSessionId,
    ]);
    assert.equal(ws.rows[0]!.attempt, 2, '复用会话时执行次数递增');
  });

  test('组合器委托矩阵：此前零覆盖的 11 个公开方法各真实调用一次', async () => {
    // 背景：拆分后这些方法只剩一行委托，而「丢字段 / 接错流程」在类型上未必报错。
    // 本用例为每个方法提供最小真实路径；委托链退化时先在这里响。
    // 1) 空作业上的纯读
    const id = await newEngagement();
    assert.deepEqual(await service.listWorkerSessions({ engagementId: id }), []);
    assert.deepEqual(await service.listApprovals({ engagementId: id }), []);
    assert.deepEqual(await service.listCandidateAssets({ engagementId: id }), []);
    assert.equal(await service.getScopeProposal(id), null);
    const scope = await service.getScope({ engagementId: id });
    assert.equal(scope.current, null, '空作业没有范围版本');
    const memory = await service.getEngagementMemory({ engagementId: id });
    assert.equal(memory.engagementId, id);
    assert.equal(memory.content, '', '从未写过时是空串而不是 null');

    // 2) bootstrapIntake：为一条新 dsh 会话建立 intake（服务端自建作业）
    const boot = await service.bootstrapIntake({
      dshSessionId: `dsh-composer-matrix-${randomUUID()}`,
      operatorId: 'op',
    });
    madeEngagements.push(boot.engagementId);
    assert.ok(boot.workerSessionId.length > 0);
    assert.equal(boot.dshSessionId.includes('composer-matrix'), true);

    // 3) rejectScopeProposal：驳回一份待确认方案
    const proposal = await newIntakeProposal();
    // 契约行为：rejectScopeProposal 成功时返回 null（处理结果看库行状态）。
    const rejected = await service.rejectScopeProposal({
      engagementId: proposal.engagementId,
      proposalId: proposal.proposalId,
      operatorId: 'op',
      reason: '矩阵用例：驳回',
      expectedStateVersion: (await service.getState(proposal.engagementId)).stateVersion,
    });
    assert.equal(rejected, null, '驳回成功按契约返回 null');
    const proposalRow = await pool.query<{ status: string }>(
      `select status from pentest.scope_intake_proposals where id = $1::uuid`,
      [proposal.proposalId],
    );
    assert.equal(proposalRow.rows[0]?.status, 'rejected');

    // 4) cancelHandoff：请求草稿后取消
    const waiting = await newWaitingHumanSession();
    await service.beginHandoff({ workerSessionId: waiting.sessionId, operatorId: 'op', toPhase: 'threat-modeling' });
    const cancelled = await service.cancelHandoff({
      engagementId: waiting.id,
      operatorId: 'op',
      reason: '矩阵用例：取消交接',
      expectedStateVersion: (await service.getState(waiting.id)).stateVersion,
    });
    assert.equal(cancelled.mainStatus, 'waiting_human_review');

    // 5) finishTechnicalTesting → reopenTechnicalWork：结束技术测试后重新打开
    const finishing = await newWaitingHumanSession();
    const report = await service.finishTechnicalTesting({
      engagementId: finishing.id,
      operatorId: 'op',
      reason: '矩阵用例：结束技术测试',
      expectedStateVersion: (await service.getState(finishing.id)).stateVersion,
    });
    assert.equal(report.engagementId, finishing.id);
    const ready = await service.getState(finishing.id);
    const reopened = await service.reopenTechnicalWork({
      engagementId: finishing.id,
      operatorId: 'op',
      reason: '矩阵用例：重新打开',
      expectedStateVersion: ready.stateVersion,
    });
    assert.equal(reopened.mainStatus, 'worker_running');
  });

  test('重做（新建会话）：旧会话被取代、其租约被吊销', async () => {
    const s0 = await service.getState(engagementId);
    await markWaitingHuman(engagementId, s0.activeWorkerSessionId!);
    const s1 = await service.getState(engagementId);
    const oldId = s1.activeWorkerSessionId!;

    const r = await service.retryWorker({
      engagementId,
      operatorId: 'op',
      reason: '换新会话重做',
      expectedStateVersion: s1.stateVersion,
      taskPrompt: '重新开始',
      reuseSession: false,
    });

    assert.equal(r.sessionReused, false);
    assert.notEqual(r.workerSessionId, oldId, '新建会话必须是不同的会话');

    const old = await pool.query(`select status from pentest.worker_sessions where id = $1::uuid`, [oldId]);
    assert.equal(old.rows[0]!.status, 'superseded');
    const lineage = await pool.query<{ retry_of_session_id: string | null }>(
      `select retry_of_session_id from pentest.worker_sessions where id = $1::uuid`,
      [r.workerSessionId],
    );
    assert.equal(
      lineage.rows[0]?.retry_of_session_id,
      oldId,
      '新建型重做必须记录来源会话（阶段轨道的重做边靠它）',
    );
    const lease = await pool.query(
      `select count(*)::int as n from pentest.session_leases
        where worker_session_id = $1::uuid and revoked_at is null`,
      [oldId],
    );
    assert.equal(lease.rows[0]!.n, 0, '旧会话的租约必须被吊销');
    const nextLease = await pool.query(
      `select generation, count(*)::int as n from pentest.session_leases
        where worker_session_id = $1::uuid and revoked_at is null
        group by generation`,
      [r.workerSessionId],
    );
    assert.equal(nextLease.rows.length, 1, '新会话必须有一份未吊销租约');
    assert.equal(Number(nextLease.rows[0]!.generation), 1, '新会话首次签发租约应从世代 1 开始');
    assert.equal(nextLease.rows[0]!.n, 1);
  });

  test('amendScope：产生新范围版本并递增 policy_epoch（state_version 不参与）', async () => {
    const before = await service.getState(engagementId);
    await service.amendScope({
      engagementId,
      operatorId: 'op',
      reason: '纳入内网主机',
      expectedStateVersion: before.stateVersion,
      targets: [],
      exclusions: [],
      authorizationRef: 'auth-2',
      decisions: [],
    });

    const row = await pool.query(`select policy_epoch from pentest.engagements where id = $1::uuid`, [engagementId]);
    assert.equal(Number(row.rows[0]!.policy_epoch), 1, '范围修订必须递增 policy_epoch');
    const versions = await pool.query(
      `select count(*)::int as n from pentest.scope_versions where engagement_id = $1::uuid`,
      [engagementId],
    );
    assert.ok((versions.rows[0]!.n as number) >= 1, '必须产生范围版本');
  });

  test('会话工厂失败：会话标记 failed，engagement 置为阻塞（不静默留半空状态）', async () => {
    const id = await newEngagement();
    await scopeVersionOf(id);
    sessions.failNextCreate();
    await assert.rejects(
      () =>
        service.startWorker({
          engagementId: id,
          operatorId: 'op',
          reason: 'x',
          expectedStateVersion: 0,
          phase: 'intelligence-gathering',
          taskPrompt: 'x',
          skillIds: [],
          toolAllow: [],
        }),
      (e: unknown) => e instanceof WorkflowRejection,
    );
    const ws = await pool.query(
      `select status, status_reason from pentest.worker_sessions where engagement_id = $1::uuid`,
      [id],
    );
    assert.equal(ws.rows[0]!.status, 'failed');
    assert.match(String(ws.rows[0]!.status_reason), /创建 dsh 会话失败/);
    const eng = await pool.query(`select status from pentest.engagements where id = $1::uuid`, [id]);
    assert.equal(eng.rows[0]!.status, 'blocked', '创建失败必须让 engagement 阻塞等待人类处置');
  });

  test('读回当前草稿：界面据服务端渲染编辑器（刷新、重挂载、换会话都不该丢）', async () => {
    // 人类报障（2026-10-05）：点「进入下一阶段」后**看得到草稿正文，却没有确认按钮、也改不了
    // 任何字段**——因为草稿只活在「请求它的那次调用」的返回值里，界面把它塞进会话尾部组件的
    // 局部状态，而草稿那一轮的新消息让该组件重新挂载，状态随之丢失。
    // 服务端本来就是唯一事实来源（草稿落库在 `handoffs.status='draft'`），补上读端点即可。
    const { id, sessionId } = await newWaitingHumanSession();
    assert.equal(
      await service.currentHandoffDraft({ workerSessionId: sessionId }),
      null,
      '还没请求过草稿时必须是 null——不能造一份空壳让人确认',
    );

    // 走**新路径**：服务端起稿（不经 Agent）——人类点一下就该拿到可直接编辑的内容。
    const draft = await service.beginHandoff({ workerSessionId: sessionId, operatorId: 'op', toPhase: 'threat-modeling' });
    assert.match(draft.prompt, /威胁建模/, '初始提示词必须带上阶段目标，人类才有东西可改');
    assert.deepEqual(draft.toolCapabilitySuggestion.allowed.length > 0, true, '工具建议要有默认值');
    const readBack = await service.currentHandoffDraft({ workerSessionId: sessionId });
    assert.equal(readBack?.draftId, draft.draftId, '读回来的必须就是那份草稿');
    assert.equal(readBack?.prompt, draft.prompt, '提示词要原样取回，人类才谈得上审计修改');
    assert.equal(readBack?.objective, draft.objective);
    assert.deepEqual(readBack?.excludedRefs, [...draft.excludedRefs], '要排除的上下文也要取回');
    assert.equal(readBack?.revision, draft.revision, '版本要一致，编辑的乐观锁靠它');

    // 取消之后它不再是「当前待确认的草稿」：编辑器必须消失，不能让人对着旧草稿再点一次确认。
    await service.cancelHandoff({
      engagementId: id,
      operatorId: 'op',
      reason: '读回用例：取消交接',
      expectedStateVersion: (await service.getState(id)).stateVersion,
    });
    assert.equal(
      await service.currentHandoffDraft({ workerSessionId: sessionId }),
      null,
      '取消后不得再读到那份草稿',
    );
  });

  test('起稿：冻结列在生成时定稿，工具建议随草稿抵达调用方（§9.5、§7.2）', async () => {
    // `handoffs` 上可变的只有 status / human_edited_json / approved_* / revision / content_hash，
    // 其余一律冻结——因此 `context_refs` 与 `excluded_refs` 的唯一写入时机是**起稿**。
    // 界面不再有「另存草稿」这一步（2026-10-05 人类要求删掉草稿概念），于是这里只锁一件事：
    // 起稿就把冻结列写定，而且工具建议必须过界抵达调用方（否则人类看不到起点，只能从零手填）。
    const { sessionId } = await newWaitingHumanSession();

    const draft = await service.beginHandoff({ workerSessionId: sessionId, operatorId: 'op', toPhase: 'threat-modeling' });
    assert.ok(draft.toolCapabilitySuggestion.allowed.length > 0, '工具建议必须随草稿返回');
    assert.match(draft.prompt, /威胁建模/, '初始提示词必须带上阶段目标');
    assert.match(draft.prompt, /# 边界/, '必须写明边界（范围以冻结版本为准）');

    const row = await pool.query<{ status: string; context_refs: unknown; excluded_refs: unknown; transition_type: string }>(
      `select status, context_refs, excluded_refs, transition_type from pentest.handoffs where id = $1::uuid`,
      [draft.draftId],
    );
    assert.equal(row.rows[0]!.status, 'draft');
    assert.equal(row.rows[0]!.transition_type, 'advance');
    assert.deepEqual(row.rows[0]!.context_refs, [], '起稿时定稿（服务端起稿不预选引用，由人类在编辑器里加）');
    assert.deepEqual(row.rows[0]!.excluded_refs, [], '起稿时定稿');
  });

  test('confirmTransition：批准包携带目标与排除引用；冻结列不被改写（§7.2、§9.5）', async () => {
    // 两条规则在这个测试里一起钉住：
    //
    //   1. `handoffs` 上只有 `status / human_edited_json / approved_to_phase /
    //      approved_skill_ids / human_decision_id / revision / content_hash` 可变，
    //      `approved_json` 是唯一的结算列；`context_refs` 与 `excluded_refs` 是**冻结列**
    //      （§9.5：未列出的列改了就抛错）。此前的确认语句更新了 `context_refs`，
    //      只因确认的 happy path 无测试覆盖才没被发现。
    //   2. 人类批准的目标与排除引用必须在**批准包**里（唯一的结算列），
    //      否则目标任务的意图与「哪些内容被排除」在下游消失。
    const id = await newEngagement();
    await pool.query(
      `update pentest.engagements
          set current_status = 'transition_confirmation', current_phase = 'intelligence-gathering'
        where id = $1::uuid`,
      [id],
    );
    const sessionId = randomUUID();
    await pool.query(
      `insert into pentest.worker_sessions
         (id, engagement_id, dsh_session_id, phase, profile_id, profile_revision,
          task_prompt, tool_filter, model_route, status)
       values ($1::uuid, $2::uuid, $3, 'intelligence-gathering', 'p1', 'r1',
               '扫描内部靶场', '{"allow":[]}'::jsonb, '{}'::jsonb, 'waiting_human')`,
      [sessionId, id, `dsh-${sessionId}`],
    );
    // 阶段切换会关闭当前活动会话并新建目标阶段会话（§6.3），
    // 而「每个 engagement 只有一个活动会话」由唯一索引守着——因此必须把它标为活动的，
    // 否则新建的目标阶段会话会撞上这条索引。
    await pool.query(
      `update pentest.engagements set active_agent_session_id = $2::uuid where id = $1::uuid`,
      [id, sessionId],
    );
    // 一个范围版本：交接必需键里的 `scope_version` 从绑定的范围版本解析（§7.2）。
    await pool.query(
      `insert into pentest.scope_versions
         (engagement_id, version, iteration, targets, exclusions, changed_by, content_hash)
       values ($1::uuid, 1, 1, '[]'::jsonb, '[]'::jsonb, 'tester', 'sha256:scope')`,
      [id],
    );
    const draftId = randomUUID();
    await pool.query(
      `insert into pentest.handoffs
         (id, engagement_id, from_worker_session_id, transition_type, suggested_to_phase,
          draft_json, context_refs, excluded_refs, content_hash, status)
       values ($1::uuid, $2::uuid, $3::uuid, 'advance', 'threat-modeling',
               '{"objective":"草稿目标"}'::jsonb,
               '[{"memoryId":"memory:aaa","reason":"资产清单"}]'::jsonb,
               '["memory:bbb"]'::jsonb, 'sha256:draft', 'draft')`,
      [draftId, id, sessionId],
    );

    const state = await service.getState(id);
    const result = await service.confirmTransition({
      engagementId: id,
      operatorId: 'op',
      reason: '按推荐路径进入威胁建模',
      expectedStateVersion: state.stateVersion,
      draftId,
      forced: false,
      forcedAcknowledged: false,
      objective: '已确认的目标：建立信任边界',
      excludedRefs: ['memory:bbb'],
      approvedToPhase: 'threat-modeling',
      approvedPrompt: '基于资产清单构建攻击路径',
      approvedSkillIds: [],
      approvedToolAllow: [],
      approvedApprovalRequired: [],
      contextRefs: [{ memoryId: 'memory:aaa', reason: '资产清单' }],
    });

    assert.equal(result.transitionType, 'advance');
    const row = await pool.query(
      `select approved_json, excluded_refs, context_refs, status, content_hash, human_decision_id
         from pentest.handoffs where id = $1::uuid`,
      [draftId],
    );
    assert.equal(row.rows[0]!.status, 'approved');
    assert.equal(
      row.rows[0]!.approved_json.objective,
      '已确认的目标：建立信任边界',
      '批准包必须带上目标（新会话据此理解任务意图）',
    );
    assert.deepEqual(
      row.rows[0]!.approved_json.excludedRefs,
      ['memory:bbb'],
      '批准包必须带上人类确认的排除引用',
    );
    assert.deepEqual(
      row.rows[0]!.approved_json.approvedContextRefs,
      ['memory:aaa'],
      '批准包必须带上人类确认的上下文引用',
    );
    // 冻结列保持草稿生成时的值——确认不（也不能）改写它们
    assert.deepEqual(row.rows[0]!.excluded_refs, ['memory:bbb'], 'excluded_refs 是冻结列，不得被确认改写');
    assert.deepEqual(
      row.rows[0]!.context_refs,
      [{ memoryId: 'memory:aaa', reason: '资产清单' }],
      'context_refs 是冻结列，不得被确认改写',
    );

    // 确认哈希取**最终批准包**的真摘要（REQ-9）：此前是提示词的可逆 base64 前缀。
    // 用批准包复算一遍——人类决策 id 也在覆盖范围内，因此「谁批的」也进摘要。
    assert.equal(
      row.rows[0]!.approved_json.humanDecisionRef,
      row.rows[0]!.human_decision_id,
      '批准包里的决策引用必须指向本次决策（哈希覆盖它，写 pending 会让摘要与事实不符）',
    );
    assert.equal(
      row.rows[0]!.content_hash,
      computeHandoffHash(row.rows[0]!.approved_json, { version: 1 }),
      '确认写入的哈希必须等于批准包在绑定范围版本下的摘要（回放与定责据此判定）',
    );
    assert.match(row.rows[0]!.content_hash, /^[0-9a-f]{64}$/, '确认哈希是 sha256 十六进制摘要');
    assert.equal(
      row.rows[0]!.approved_json.contentHash,
      row.rows[0]!.content_hash,
      '批准包内的 contentHash 必须与落库列一致（同一条事实不要两处写法）',
    );
  });

  /**
   * 造一个「可回环」的现场：后渗透会话已交报告、等人类确认切换到情报收集。
   *
   * `sessionScopeVersion` 是**来源会话绑定的**范围版本——回环前置的判据以它为起点
   * （见 `confirmTransition` 的说明），因此必须能显式指定。
   */
  async function loopFixture(sessionScopeVersion: number): Promise<{
    id: string;
    sessionId: string;
    draftId: string;
  }> {
    const id = await newEngagement();
    await pool.query(
      `update pentest.engagements
          set current_status = 'transition_confirmation', current_phase = 'post-exploitation'
        where id = $1::uuid`,
      [id],
    );
    const sessionId = randomUUID();
    await pool.query(
      `insert into pentest.worker_sessions
         (id, engagement_id, dsh_session_id, phase, profile_id, profile_revision,
          task_prompt, tool_filter, model_route, status, scope_version)
       values ($1::uuid, $2::uuid, $3, 'post-exploitation', 'p1', 'r1',
               '后渗透', '{"allow":[]}'::jsonb, '{}'::jsonb, 'waiting_human', $4)`,
      [sessionId, id, `dsh-${sessionId}`, sessionScopeVersion],
    );
    await pool.query(
      `update pentest.engagements set active_agent_session_id = $2::uuid where id = $1::uuid`,
      [id, sessionId],
    );
    await pool.query(
      `insert into pentest.scope_versions
         (engagement_id, version, iteration, targets, exclusions, changed_by, content_hash)
       values ($1::uuid, 2, 1, '[]'::jsonb, '[]'::jsonb, 'tester', 'sha256:scope2')`,
      [id],
    );
    const draftId = randomUUID();
    await pool.query(
      `insert into pentest.handoffs
         (id, engagement_id, from_worker_session_id, transition_type, suggested_to_phase,
          draft_json, context_refs, excluded_refs, content_hash, status)
       values ($1::uuid, $2::uuid, $3::uuid, 'loop', 'intelligence-gathering',
               '{"objective":"回环侦察"}'::jsonb, '[]'::jsonb, '[]'::jsonb, 'sha256:draft', 'draft')`,
      [draftId, id, sessionId],
    );
    return { id, sessionId, draftId };
  }
  test('confirmTransition：强制跳转必须有独立二次确认', async () => {
    const { id, draftId } = await loopFixture(2);
    await pool.query(
      `update pentest.engagements set current_phase = 'intelligence-gathering' where id = $1::uuid`,
      [id],
    );
    const state = await service.getState(id);

    await assert.rejects(
      () => service.confirmTransition({
        engagementId: id,
        operatorId: 'op',
        reason: '直接进入漏洞分析',
        expectedStateVersion: state.stateVersion,
        draftId,
        forced: true,
        forcedAcknowledged: false,
        objective: '直接验证漏洞',
        excludedRefs: [],
        approvedToPhase: 'vulnerability-analysis',
        approvedPrompt: '验证漏洞',
        approvedSkillIds: [],
        approvedToolAllow: [],
        approvedApprovalRequired: [],
        contextRefs: [],
      }),
      (error: unknown) => error instanceof WorkflowRejection && error.code === 'forced_reason_required',
      '仅选择强制跳转而未独立确认必须被拒',
    );
  });


  test('confirmTransition：回环未做范围修订被拒（§5.4 步骤 4 的闸门不是摆设）', async () => {
    // 这里的判据是「来源会话绑定的范围版本」与「当前最新范围版本」相等——
    // 也就是**后渗透期间没有新增范围版本**。此前服务端把
    // `scopeAmendment` 硬编码成 `{ completed: true }`，这条闸门虽然写着却永远通过，
    // 于是回环可以在完全没做范围修订的情况下发生；而回环的全部意义正是
    // 「带着新纳入的内部资产重新侦察」（§5.5），没有修订就等于用旧范围再跑一轮。
    const { id, sessionId, draftId } = await loopFixture(2); // 会话绑 v2，最新也是 v2
    const state = await service.getState(id);

    await assert.rejects(
      () =>
        service.confirmTransition({
          engagementId: id,
          operatorId: 'op',
          reason: '回环到情报收集',
          expectedStateVersion: state.stateVersion,
          draftId,
          forced: false,
          forcedAcknowledged: false,
          objective: '回环侦察内部资产',
          excludedRefs: [],
          approvedToPhase: 'intelligence-gathering',
          approvedPrompt: 'p',
          approvedSkillIds: [],
          approvedToolAllow: [],
          approvedApprovalRequired: [],
          contextRefs: [],
        }),
      (error: unknown) =>
        error instanceof WorkflowRejection && error.code === 'scope_amendment_required',
      '未做范围修订的回环必须被拒',
    );
    assert.equal(sessionId.length > 0, true);
  });

  test('confirmTransition：回环前完成范围修订后可以确认（闸门放行「已修订」）', async () => {
    // 反向断言，缺了它这条闸门就可能被「永远拒绝」地修错——那同样破坏功能，
    // 只是表现从「静默越权」变成「流程走不通」。
    const { id, draftId } = await loopFixture(2); // 会话仍绑 v2
    // 模拟 amendScope：新增 v3（比来源会话的绑定版本更新）。
    await pool.query(
      `insert into pentest.scope_versions
         (engagement_id, version, iteration, targets, exclusions, changed_by, content_hash)
       values ($1::uuid, 3, 2, '[]'::jsonb, '[]'::jsonb, 'tester', 'sha256:scope3')`,
      [id],
    );
    const state = await service.getState(id);
    const beforeActive = state.activeWorkerSessionId;

    const result = await service.confirmTransition({
      engagementId: id,
      operatorId: 'op',
      reason: '范围已修订，回环到情报收集',
      expectedStateVersion: state.stateVersion,
      draftId,
      forced: false,
      forcedAcknowledged: false,
      objective: '回环侦察内部资产',
      excludedRefs: [],
      approvedToPhase: 'intelligence-gathering',
      approvedPrompt: 'p',
      approvedSkillIds: [],
      approvedToolAllow: [],
      approvedApprovalRequired: [],
      contextRefs: [],
    });

    assert.equal(result.transitionType, 'loop', '回环应记为 loop 转移（§5.4）');
    const advanced = await service.getState(id);
    assert.notEqual(advanced.activeWorkerSessionId, beforeActive, '回环必须创建新会话');
    const lineage = await pool.query<{ previous_agent_session_id: string | null }>(
      `select previous_agent_session_id from pentest.worker_sessions where id = $1::uuid`,
      [advanced.activeWorkerSessionId],
    );
    assert.equal(
      lineage.rows[0]?.previous_agent_session_id,
      beforeActive,
      '阶段推进必须记录前置会话（时间轴的交接边靠它）',
    );
  });

  /**
   * 造一个「等待人工判断」现场：`waiting_human_review` 的作业 + 一个 `waiting_human` 会话。
   * 这是草稿请求的**唯一合法起点**（服务端闸门），因此多个用例共用同一份构造。
   */
  async function newWaitingHumanSession(): Promise<{ id: string; sessionId: string }> {
    const id = await newEngagement();
    await pool.query(
      `update pentest.engagements
          set current_status = 'waiting_human_review', current_phase = 'intelligence-gathering'
        where id = $1::uuid`,
      [id],
    );
    const sessionId = randomUUID();
    await pool.query(
      `insert into pentest.worker_sessions
         (id, engagement_id, dsh_session_id, phase, profile_id, profile_revision,
          task_prompt, tool_filter, model_route, status)
       values ($1::uuid, $2::uuid, $3, 'intelligence-gathering', 'p1', 'r1',
               '扫描内部靶场', '{"allow":[]}'::jsonb, '{}'::jsonb, 'waiting_human')`,
      [sessionId, id, `dsh-${sessionId}`],
    );
    await pool.query(
      `update pentest.engagements set active_agent_session_id = $2::uuid where id = $1::uuid`,
      [id, sessionId],
    );
    return { id, sessionId };
  }

  /**
   * 把会话推到「等待人工判断」——与生产实现（`PgWorkerTools.submitReport`）同一套状态效果。
   *
   * 为什么不用服务方法：会话流程里那份 `finishWorker` 是**重复实现**，2026-10-05 复核
   * （F3）已删除——生产只走 `PgWorkerTools.submitReport`，而本文件不需要真跑一遍提交
   * （提交的准入、账本与环境断言在 `pg-worker-tools.test.ts`）。这里只做**状态摆放**，
   * 供「重做 / 交接」等用例把起点摆好。
   */
  async function markWaitingHuman(target: string, sessionId: string): Promise<void> {
    await pool.query(`update pentest.worker_sessions set status = 'waiting_human' where id = $1::uuid`, [
      sessionId,
    ]);
    await pool.query(
      `update pentest.engagements
          set current_status = 'waiting_human_review', state_version = state_version + 1
        where id = $1::uuid`,
      [target],
    );
  }

  test('起稿：省略目标阶段时按状态机的推荐推进（人类只说「进入下一阶段」）', async () => {
    // 阶段是预设状态机，下一阶段由当前阶段唯一确定——人类不该被反问「哪个阶段」。
    const { id, sessionId } = await newWaitingHumanSession();
    const draft = await service.beginHandoff({ workerSessionId: sessionId, operatorId: 'op' });
    assert.equal(draft.suggestedToPhase, 'threat-modeling', '情报收集 → 威胁建模');

    // 草稿哈希必须是**真摘要**、且等于落库 `draft_json` 的摘要（REQ-9）：
    // 此前写的是 `'sha256:' + base64url(json).slice(0,43)`——可逆且截断，
    // 既泄露草稿正文、又无法自证（同一列两种含义的字符串）。
    const row = await pool.query<{ content_hash: string; draft_json: unknown }>(
      `select content_hash, draft_json from pentest.handoffs
        where engagement_id = $1::uuid and status = 'draft'`,
      [id],
    );
    assert.match(row.rows[0]!.content_hash, /^[0-9a-f]{64}$/, '草稿哈希是 sha256 十六进制摘要');
    assert.equal(
      row.rows[0]!.content_hash,
      computeDraftHash(row.rows[0]!.draft_json),
      '草稿哈希必须等于库里那份 draft_json 的摘要（人能据此核对看到的草稿）',
    );
    // 读端点带回的必须是**库里那一行**的哈希：UI 显示的值不能来自客户端复算。
    assert.equal(draft.contentHash, row.rows[0]!.content_hash, '读端点必须返回权威哈希');
  });

  test('confirmTransition：状态不符时拒绝（不能在非交接确认阶段切换）', async () => {
    const s = await service.getState(engagementId);
    await assert.rejects(
      () =>
        service.confirmTransition({
          engagementId,
          operatorId: 'op',
          reason: 'x',
          expectedStateVersion: s.stateVersion,
          draftId: randomUUID(),
          forced: false,
          forcedAcknowledged: false,
          objective: '下一轮任务目标',
          excludedRefs: [],
          approvedToPhase: 'threat-modeling',
          approvedPrompt: 'p',
          approvedSkillIds: [],
          approvedToolAllow: [],
          approvedApprovalRequired: [],
          contextRefs: [],
        }),
      (e: unknown) => e instanceof WorkflowRejection && e.code === 'handoff_transition_illegal',
    );
  });

  // ─────────────── engagement 生命周期（§6.1、§11.1） ───────────────
  //
  // 这一组覆盖的是一个**真实功能缺口**：此前 RPC 面没有创建/列出 engagement 的
  // 端点，控制台连第一步都走不了。现在补上并在此用真实库验证。

  test('createEngagement：建 engagement + 范围版本 1 + 决策记录，不创建会话', async () => {
    const id = randomUUID();
    const summary = await service.createEngagement({
      behaviorProfile: 'stealth',
      approvalMode: 'human',
      operatorId: 'op',
      reason: '建立授权靶场 engagement',
      name: 'e2e-created',
      authorizationRef: 'AUTH-2026-001',
      authorizationExpiresAt: '2026-06-30T00:00:00Z',
      targets: [{ kind: 'cidr', value: '10.0.0.0/24', protocols: ['tcp'], ports: [{ from: 80, to: 80 }] }],
      exclusions: [],
      roe: { maxRatePerSecond: 20 },
      timeWindow: { from: '09:00', to: '18:00' },
    });
    madeEngagements.push(summary.id);
    void id;

    assert.equal(summary.mainStatus, 'ready', '向导确认后即 READY——授权已成立');
    assert.equal(summary.runMarker, 'running');
    assert.equal(summary.stateVersion, 0);
    assert.equal(summary.activeWorkerSessionId, null, '创建 engagement 不创建会话（§1.2）');
    assert.equal(summary.currentPhase, null, '尚无阶段');

    // 范围版本 1 与 engagement 同事务写入
    const scope = await pool.query<{ version: number; authorization_ref: string; targets: unknown }>(
      `select version, authorization_ref, targets from pentest.scope_versions where engagement_id = $1::uuid`,
      [summary.id],
    );
    assert.equal(scope.rows.length, 1, '必须写入范围版本 1');
    assert.equal(scope.rows[0]!.version, 1);
    assert.equal(scope.rows[0]!.authorization_ref, 'AUTH-2026-001');

    // 决策留痕
    const decision = await pool.query<{ n: string }>(
      `select count(*)::text as n from pentest.human_decisions
        where engagement_id = $1::uuid and decision_type = 'create_engagement'`,
      [summary.id],
    );
    assert.equal(decision.rows[0]!.n, '1', '创建本身是一次人类决定，必须留痕');

    // 没有会话
    const sessions = await pool.query<{ n: string }>(
      `select count(*)::text as n from pentest.worker_sessions where engagement_id = $1::uuid`,
      [summary.id],
    );
    assert.equal(sessions.rows[0]!.n, '0');
  });

  test('公共记忆：创建时受同一个长度上限约束（此前只有 update 路径查）', async () => {
    // 回归锁。此前上限只写在 updateEngagementMemory 里，于是建作业时能从向导粘贴
    // **任意长度**的文本进库（实测 20 万字符被接受），而那段文本会被整段拼进该作业
    // 每一次会话的系统提示词——上限是这条面上唯一的上下文占用闸门。
    // 同一不变量在两处实现必然漂移，这里同时钉住两个入口。
    const base = {
      behaviorProfile: 'stealth' as const,
      approvalMode: 'human' as const,
      operatorId: 'op', reason: 'r', name: 'size-gate',
      targets: [{ kind: 'domain', value: 'a.test', protocols: ['tcp'], ports: [{ from: 443, to: 443 }] }] as const,
    };
    const oversize = 'x'.repeat(8001);

    await assert.rejects(
      () => service.createEngagement({ ...base, publicMemory: oversize }),
      (e: unknown) => e instanceof WorkflowRejection && e.code === 'classification_rejected',
      '创建路径必须拒超长公共记忆',
    );

    // 边界：正好等于上限应当通过（不是 off-by-one）。
    const atLimit = await service.createEngagement({ ...base, publicMemory: 'y'.repeat(8000) });
    madeEngagements.push(atLimit.id);
    const stored = await pool.query<{ n: number }>(
      `select length(public_memory) as n from pentest.engagements where id = $1::uuid`,
      [atLimit.id],
    );
    assert.equal(stored.rows[0]?.n, 8000);
  });

  test('公共记忆：正文必须是字符串；null 不得落成内部错误', async () => {
    // RPC 层把它声明为 `stringOrNull`（为了放行「清空」的空串），于是 null 会一路
    // 走到服务端。此前直接 `content.length` 抛 TypeError，最终被映射成
    // `console/internal`「内部错误」——把参数问题伪装成服务故障。
    const created = await service.createEngagement({
      behaviorProfile: 'stealth',
      approvalMode: 'human',
      operatorId: 'op', reason: 'r', name: 'null-gate',
      targets: [{ kind: 'domain', value: 'b.test', protocols: ['tcp'], ports: [] }],
    });
    madeEngagements.push(created.id);

    await assert.rejects(
      () => service.updateEngagementMemory({
        engagementId: created.id, operatorId: 'op', reason: 'r',
        expectedStateVersion: 0,
        // 类型上不可达，但线协议放行——因此必须在这里挡住，而不是崩。
        content: null as unknown as string,
      }),
      (e: unknown) => e instanceof WorkflowRejection,
      '必须是可识别的拒绝，而不是未捕获的 TypeError',
    );

    // 空串是**合法**的「清空」。
    const cleared = await service.updateEngagementMemory({
      engagementId: created.id, operatorId: 'op', reason: 'r',
      expectedStateVersion: 0, content: '',
    });
    assert.equal(cleared.content, '');
  });

  test('公共记忆：写操作真的按信封版本做乐观锁（不是锁后重读）', async () => {
    const created = await service.createEngagement({
      behaviorProfile: 'stealth',
      approvalMode: 'human',
      operatorId: 'op', reason: 'r', name: 'optimistic-lock',
      targets: [{ kind: 'domain', value: 'c.test', protocols: ['tcp'], ports: [] }],
    });
    madeEngagements.push(created.id);

    await service.updateEngagementMemory({
      engagementId: created.id, operatorId: 'op', reason: 'r',
      expectedStateVersion: 0, content: '第一次',
    });

    // 版本已推进到 1；再用过期的 0 提交必须被拒。
    // 此前实现是「锁后读当前版本」，等于无条件成功——后写者静默覆盖前写者。
    await assert.rejects(
      () => service.updateEngagementMemory({
        engagementId: created.id, operatorId: 'op', reason: 'r',
        expectedStateVersion: 0, content: '基于过期版本',
      }),
      (e: unknown) => e instanceof WorkflowRejection && e.code === 'stale_state_version',
      '过期版本必须被拒（§15.4 冲突）',
    );
  });

  test('策略审计：创建必须写出「选择 → 预览 → 确认 → 冻结」，且预览哈希等于冻结哈希', async () => {
    // 设计 §13.1 / §16.2 要求人类能只凭账本重建「我选了哪个预设、服务端展开了什么、我确认的是不是它」。
    // 此前创建路径只写了 selected/confirmed/frozen 三条，中间那条预览缺失——
    // 于是「人类看到的预览」和「实际冻结的策略」在账本上无法比对，只能靠信任浏览器。
    const created = await service.createEngagement({
      operatorId: 'op', reason: 'r', name: 'policy-audit-create',
      targets: [{ kind: 'ip', value: '10.9.9.9', protocols: ['tcp'], ports: [{ from: 443, to: 443 }] }],
      scopeEntryProfile: 'ip', behaviorProfile: 'stealth',
    approvalMode: 'human',
    });
    madeEngagements.push(created.id);

    const events = await pool.query<{ event_type: string; payload_json: Record<string, unknown> }>(
      `select event_type, payload_json from pentest.context_events
        where engagement_id = $1::uuid and event_type like 'policy.%'
        order by chain_seq`,
      [created.id],
    );
    assert.deepEqual(
      events.rows.map((r) => r.event_type),
      [
        'policy.profile.selected',
        'policy.snapshot.previewed',
        'policy.snapshot.confirmed',
        'policy.snapshot.frozen',
      ],
      '顺序即语义：人类选择 → 服务端展开预览 → 人类确认 → 冻结',
    );

    const hashRow = await pool.query<{ policy_snapshot_hash: string }>(
      'select policy_snapshot_hash from pentest.engagements where id = $1::uuid',
      [created.id],
    );
    const previewed = events.rows[1]!.payload_json;
    assert.equal(
      previewed['previewHash'],
      hashRow.rows[0]!.policy_snapshot_hash,
      '预览哈希必须等于最终冻结的哈希——否则「人类看到的」与「落库的」可以不一致',
    );
    assert.equal(previewed['operatorId'], 'op', '预览也必须归因到真实操作者');
    const risk = previewed['riskSummary'] as Record<string, unknown>;
    assert.deepEqual(
      risk['perActionApprovalClasses'],
      ['exploit_validation', 'lateral_movement'],
      '逐动作放行清单必须进预览摘要：人类才知道自己确认了什么会被每次拦下',
    );
    assert.equal(risk['credentialMode'], 'none', 'stealth 的凭据模式必须进摘要');
  });

  test('公共记忆：省略可选项的创建路径真的落到安全默认值', async () => {
    // TestQuality 指出的空洞：所有既有 createEngagement 调用点都显式传了可选项，
    // 于是「省略 → 服务端兜默认」这条路径零覆盖。删掉那三行 `?? []`/`?? {}`/`?? ''`
    // 会让所有测试仍然绿，而线上因 NOT NULL 列收到 NULL 而 23502。
    const created = await service.createEngagement({
      behaviorProfile: 'stealth',
      approvalMode: 'human',
      operatorId: 'op', reason: 'r', name: 'omitted-options',
      targets: [{ kind: 'domain', value: 'd.test', protocols: ['tcp'], ports: [] }],
      // 刻意不传 exclusions / roe / timeWindow / authorizationRef /
      // authorizationExpiresAt / publicMemory
    });
    madeEngagements.push(created.id);

    const row = await pool.query<{
      ref: string | null; exp: string | null; mem: string;
      roe: unknown; tw: unknown; ex: unknown;
    }>(
      `select scope_snapshot->>'authorizationRef' as ref,
              scope_snapshot->>'authorizationExpiresAt' as exp,
              public_memory as mem, roe_snapshot as roe,
              config_snapshot->'timeWindow' as tw, target_snapshot->'exclusions' as ex
         from pentest.engagements where id = $1::uuid`,
      [created.id],
    );
    const r = row.rows[0]!;
    assert.equal(r.ref, '', '省略授权依据 → 空串（供档案展示）');
    assert.equal(r.exp, '', '省略到期 → 空串（= 未声明到期，永不过期）');
    assert.equal(r.mem, '', '省略公共记忆 → 空串（不是 null）');
    assert.deepEqual(r.roe, {}, '省略 roe → {}（NOT NULL 列不能拿到 NULL）');
    assert.deepEqual(r.tw, {}, '省略 timeWindow → {}');
    assert.deepEqual(r.ex, [], '省略 exclusions → []');
  });

  test('listEngagements 按租户过滤（RLS 在当前部署不生效）', async () => {
    // 当前部署用 postgres 超级用户连接，而**超级用户绕过 RLS**（实测：在 A 的
    // set_rls_context 下仍能读到全部租户的行）。因此列表这个跨 engagement 的读
    // 必须自己带 tenant 过滤——它是 RLS 本该兜底、实际没有兜的地方。
    const foreign = randomUUID();
    await pool.query(
      `insert into pentest.engagements
         (id, tenant_id, name, status, current_status, target_snapshot, scope_snapshot,
          roe_snapshot, policy_snapshot, config_snapshot, created_by)
       values ($1::uuid, 'other-tenant', 'foreign-engagement', 'running', 'ready',
               '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, 't')`,
      [foreign],
    );
    madeEngagements.push(foreign);

    const mine = await service.listEngagements({ operatorId: 'op' });
    assert.equal(
      mine.some((e) => e.id === foreign),
      false,
      '不属于本租户的作业不得出现在列表里',
    );
  });

  test('createEngagement：无授权依据 / 无目标 / 空名称 都被拒', async () => {
    const base = {
      behaviorProfile: 'stealth' as const,
      approvalMode: 'human' as const,
      operatorId: 'op',
      reason: 'r',
      name: 'x',
      authorizationRef: 'A',
      authorizationExpiresAt: '2026-01-01T00:00:00Z',
      targets: [{ kind: 'domain', value: 'a.test', protocols: ['tcp'], ports: [{ from: 443, to: 443 }] }] as const,
      exclusions: [],
      roe: {},
      timeWindow: {},
    };

    await assert.rejects(
      () => service.createEngagement({ ...base, name: '   ' }),
      (e: unknown) => e instanceof WorkflowRejection && e.code === 'classification_rejected',
      '名称不能为空',
    );
    // 授权依据**不再是必填**：它只进档案与审计，没有任何判定读它。
    // 此前连空串都拒，让「自己给自己开个作业」每次都要编一个引用。
    // 现在：省略 → 存空串；给了空白串 → 同样当空串。
    const noRef = await service.createEngagement({ ...base, authorizationRef: '  ' });
    madeEngagements.push(noRef.id);
    const stored = await pool.query<{ authorization_ref: string | null }>(
      `select authorization_ref from pentest.scope_versions where engagement_id = $1::uuid`,
      [noRef.id],
    );
    assert.equal(stored.rows[0]?.authorization_ref, '  ', '原样存档，不做 trim——它只是档案');

    // 但**范围不能为空**：那是真正的硬约束（后续所有动作都会因范围外被拒）。
    await assert.rejects(
      () => service.createEngagement({ ...base, targets: [] }),
      (e: unknown) => e instanceof WorkflowRejection,
      '空范围没有意义——后续所有动作都会因范围外被拒',
    );
  });

  test('listEngagements：返回自己创建的 engagement，按最近活动倒序', async () => {
    const a = await service.createEngagement({
      behaviorProfile: 'stealth',
      approvalMode: 'human',
      operatorId: 'op', reason: 'r', name: 'list-a',
      authorizationRef: 'A1', authorizationExpiresAt: '2026-01-01T00:00:00Z',
      targets: [{ kind: 'domain', value: 'a.test', protocols: ['tcp'], ports: [{ from: 443, to: 443 }] }],
      exclusions: [], roe: {}, timeWindow: {},
    });
    madeEngagements.push(a.id);
    const b = await service.createEngagement({
      behaviorProfile: 'stealth',
      approvalMode: 'human',
      operatorId: 'op', reason: 'r', name: 'list-b',
      authorizationRef: 'A2', authorizationExpiresAt: '2026-01-01T00:00:00Z',
      targets: [{ kind: 'domain', value: 'b.test', protocols: ['tcp'], ports: [{ from: 443, to: 443 }] }],
      exclusions: [], roe: {}, timeWindow: {},
    });
    madeEngagements.push(b.id);

    const list = await service.listEngagements({ operatorId: 'op', limit: 200 });
    const mine = list.filter((x) => x.id === a.id || x.id === b.id);
    assert.equal(mine.length, 2, '两个都应出现在列表里');
    // 摘要不含大字段（列表用于选择与状态总览）
    for (const item of mine) {
      assert.equal(typeof item.name, 'string');
      assert.equal(typeof item.stateVersion, 'number');
      assert.equal(Object.hasOwn(item, 'scopeSnapshot'), false);
    }
  });

  /**
   * session-first 的 intake 现场：一个 AUTH_PENDING 作业 + 活动 intake 会话 + 租约 + 待确认提案。
   *
   * 抽成一处是因为「确认」与「预览」两条用例必须站在**同一个现场**上——现场不同，
   * 「预览的哈希等于确认写入的哈希」这条断言就失去了意义。
   */
  async function newIntakeProposal(): Promise<{ engagementId: string; intakeId: string; proposalId: string }> {
    const engagementId = randomUUID();
    madeEngagements.push(engagementId);
    const intakeId = randomUUID();
    const proposalId = randomUUID();
    await pool.query(
      `insert into pentest.engagements
         (id, tenant_id, name, status, current_status, target_snapshot, scope_snapshot, roe_snapshot, policy_snapshot, config_snapshot, created_by)
       values ($1::uuid,'t','confirm-scope','running','auth_pending','[]'::jsonb,'{}'::jsonb,'{}'::jsonb,'{}'::jsonb,'{}'::jsonb,'tester')`,
      [engagementId],
    );
    await pool.query(
      `insert into pentest.worker_sessions
         (id, engagement_id, dsh_session_id, phase, profile_id, profile_revision, attempt, iteration,
          scope_version, task_prompt, tool_filter, skill_ids, model_route, status, session_kind)
       values ($1::uuid,$2::uuid,$3,'intelligence-gathering','p','r1',1,1,0,'intake','{}'::jsonb,'[]'::jsonb,'{}'::jsonb,'active','intake')`,
      [intakeId, engagementId, `dsh-${intakeId}`],
    );
    await pool.query(
      `update pentest.engagements set active_agent_session_id = $2::uuid where id = $1::uuid`,
      [engagementId, intakeId],
    );
    await pool.query(
      `insert into pentest.session_leases (engagement_id, worker_session_id, generation, expires_at)
       values ($1::uuid,$2::uuid,1, now() + interval '10 minutes')`,
      [engagementId, intakeId],
    );
    await pool.query(
      `insert into pentest.scope_intake_proposals
         (id, engagement_id, worker_session_id, objective, proposed_targets, proposed_exclusions,
          proposed_allowed_actions, authorization_note, status)
       values ($1::uuid,$2::uuid,$3::uuid,'rt','[]'::jsonb,'[]'::jsonb,'[]'::jsonb,'','pending')`,
      [proposalId, engagementId, intakeId],
    );
    return { engagementId, intakeId, proposalId };
  }

  test('confirmScopeProposal：确认即冻结策略（规范化范围 + 策略版本 + 授权确认人）', async () => {
    // 这条路径此前**完全没有测试覆盖**，而它正是 session-first 的主入口：
    // 人类在控制台点「确认」的那一刻，范围与策略同时冻结。
    // 断言的是冻结的四个事实：规范化范围、范围哈希、策略版本、授权确认人。
    const { engagementId: id, intakeId, proposalId } = await newIntakeProposal();

    const confirmed = await service.confirmScopeProposal({
      approvalMode: 'human',
      engagementId: id,
      operatorId: 'op',
      reason: '人类确认范围',
      expectedStateVersion: 0,
      proposalId,
      objective: '确认后的目标',
      targets: [{ kind: 'domain', value: 'Target.Example.', protocols: ['tcp'], ports: [{ from: 443, to: 443 }] }],
      exclusions: [{ kind: 'ip', value: '10.0.0.9', protocols: ['tcp'], ports: [{ from: 443, to: 443 }] }],
      allowedActions: ['active_probing'],
      authorizationNote: 'AUTH-CONFIRM-1',
      behaviorProfile: 'standard',
      scopeEntryProfile: 'domain',
    });
    assert.equal(confirmed.scopeVersion, 1);
    assert.equal(confirmed.sessionKind, 'phase');

    const scopeRow = await pool.query<{ targets: ScopeTarget[]; exclusions: ScopeTarget[]; content_hash: string }>(
      `select targets, exclusions, content_hash from pentest.scope_versions where engagement_id = $1::uuid`,
      [id],
    );
    assert.equal(scopeRow.rows[0]?.targets[0]?.value, 'target.example', '落库的是规范化后的范围条目');
    assert.equal(
      scopeRow.rows[0]?.content_hash,
      scopeContentHash({
        targets: scopeRow.rows[0]!.targets,
        exclusions: scopeRow.rows[0]!.exclusions,
        authorizationRef: 'AUTH-CONFIRM-1',
        version: 1,
      }),
      '范围哈希必须覆盖目标与排除项，且可由存储内容复核',
    );

    const engagementRow = await pool.query<{
      behavior_profile: string;
      scope_entry_profile: string;
      policy_version: number;
      policy_snapshot_hash: string;
      policy_snapshot: unknown;
      authorization_confirmed_by: string | null;
    }>(
      `select behavior_profile, scope_entry_profile, policy_version, policy_snapshot_hash,
              policy_snapshot, authorization_confirmed_by
         from pentest.engagements where id = $1::uuid`,
      [id],
    );
    const row = engagementRow.rows[0]!;
    assert.equal(row.behavior_profile, 'standard', '人类选的预设必须落库');
    assert.equal(row.scope_entry_profile, 'domain');
    assert.equal(Number(row.policy_version), 1);
    assert.equal(row.authorization_confirmed_by, 'op', '确认人必须留痕');
    assert.equal(
      policyContentHash(row.policy_snapshot),
      row.policy_snapshot_hash,
      '当前投影的哈希必须能由投影本身复核',
    );

    const versionRow = await pool.query<{ version: number; behavior_profile: string; content_hash: string; human_decision_id: string | null }>(
      `select version, behavior_profile, content_hash, human_decision_id
         from pentest.policy_versions where engagement_id = $1::uuid`,
      [id],
    );
    assert.equal(versionRow.rows.length, 1, '确认必须写入策略版本 1');
    assert.equal(versionRow.rows[0]?.behavior_profile, 'standard');
    assert.equal(versionRow.rows[0]?.content_hash, row.policy_snapshot_hash);
    assert.ok(versionRow.rows[0]?.human_decision_id !== null, '策略版本必须绑定人类决策');

    // intake 确认是**另一条**创建路径：它同样冻结策略，因此必须写出同一组策略事件。
    // 此前它只写 scope.snapshot / human.authorization.confirmed——账本里看不出预设与预览哈希。
    const intakePolicyEvents = await pool.query<{ event_type: string }>(
      `select event_type from pentest.context_events
        where engagement_id = $1::uuid and event_type like 'policy.%'
        order by chain_seq`,
      [id],
    );
    assert.deepEqual(
      intakePolicyEvents.rows.map((r) => r.event_type),
      [
        'policy.profile.selected',
        'policy.snapshot.previewed',
        'policy.snapshot.confirmed',
        'policy.snapshot.frozen',
      ],
      'intake 确认路径必须留同一组策略事件',
    );

    // 确认会推进 `state_version`：卡片下一次读到它，才不会拿旧版本反复撞乐观锁。
    const afterStatus = await service.getIntakeStatus({ dshSessionId: `dsh-${intakeId}` });
    assert.equal(afterStatus.pendingProposal, null, '确认后不该再有待确认方案');
    assert.equal(
      afterStatus.stateVersion,
      1,
      '确认必须让 state_version 前进——否则界面会一直拿 0 去重试一个已经变了的状态',
    );
    assert.equal(
      afterStatus.sessionKind,
      'intake',
      '反查仍应认出这是那个 intake 会话（它已关闭，但会话卡片还要在那一页显示状态）',
    );

    // 会话与转移的关联（这条路径此前三个外键顺序/语义错误都被掩盖着，因此一并锁住）：
    // intake 必须被关闭，新 phase 会话必须是活动指针指向的那一个，且转移不伪指交接草稿。
    const sessionsRow = await pool.query<{ intake_status: string; phase_status: string; pointer: string }>(
      `select (select status from pentest.worker_sessions where id = $2::uuid) as intake_status,
              (select status from pentest.worker_sessions where id = $3::uuid) as phase_status,
              (select active_agent_session_id from pentest.engagements where id = $1::uuid) as pointer`,
      [id, intakeId, confirmed.workerSessionId],
    );
    assert.equal(sessionsRow.rows[0]?.intake_status, 'closed', 'intake 会话必须被关闭');
    // 新 phase 会话在事务里落为 `starting`，随后由 `#createDshSessionOrMarkFailed`
    // 在事务外创建 dsh 会话并回写 `active`（见文件头的时序纪律 1）——此刻它已是 active。
    assert.equal(sessionsRow.rows[0]?.phase_status, 'active');
    assert.equal(sessionsRow.rows[0]?.pointer, confirmed.workerSessionId, '活动指针必须指向新 phase 会话');

    const transitionRow = await pool.query<{ handoff_id: string | null; human_decision_id: string; to_worker_session_id: string }>(
      `select handoff_id, human_decision_id, to_worker_session_id
         from pentest.state_transitions where engagement_id = $1::uuid`,
      [id],
    );
    assert.equal(transitionRow.rows[0]?.handoff_id, null, '范围确认不是交接草稿：不得借用 handoff_id');
    assert.equal(transitionRow.rows[0]?.to_worker_session_id, confirmed.workerSessionId);
    assert.ok(transitionRow.rows[0]?.human_decision_id !== undefined);
  });

  test('intake 提方案 → 人类确认：主状态停在 AUTH_PENDING，预览与确认结论一致（实战主路径）', async () => {
    // 这条路径曾因**两个过窄的判据**走不通：会推主状态的报告路径不限会话种类
    // （intake 一提报告就把 `auth_pending` 推成 `waiting_human_review`），而确认侧又要求
    // intake 会话仍是 `active`——人类点确认只拿到「当前任务没有可确认的 intake 范围」。
    // 现在 intake 会话**根本不允许**走报告路径（`PgWorkerTools.submitReport` 对 intake
    // 直接 `classification_rejected`，见 `pg-worker-tools.test.ts`），因此确认之前主状态
    // 只会是 `auth_pending`；这里锁的是「预览与确认给同一结论」。
    const { engagementId: id, proposalId } = await newIntakeProposal();

    const row = await pool.query<{ current_status: string }>(
      `select current_status from pentest.engagements where id = $1::uuid`,
      [id],
    );
    assert.equal(
      row.rows[0]?.current_status,
      'auth_pending',
      'intake 阶段的「等人类」就是 AUTH_PENDING（§13.1 人类边的前置）',
    );

    // 预览与确认必须给出同一个结论：此刻预览里不该有任何 intake 相关的 blocker。
    const preview = await service.previewPolicy({
      engagementId: id,
      proposalId,
      targets: [{ kind: 'domain', value: 'Target.Example.', protocols: ['tcp'], ports: [{ from: 443, to: 443 }] }],
      exclusions: [],
      allowedActions: ['active_probing'],
      scopeEntryProfile: 'domain',
      behaviorProfile: 'standard',
    });
    assert.equal(
      preview.blockers.some((blocker) => blocker.includes('intake')),
      false,
      `预览不得把正常时序报成 blocker：${preview.blockers.join(' / ')}`,
    );

    const confirmed = await service.confirmScopeProposal({
      approvalMode: 'human',
      engagementId: id,
      operatorId: 'op',
      reason: '人类确认范围',
      expectedStateVersion: 0,
      proposalId,
      objective: '确认后的目标',
      targets: [{ kind: 'domain', value: 'Target.Example.', protocols: ['tcp'], ports: [{ from: 443, to: 443 }] }],
      exclusions: [],
      allowedActions: ['active_probing'],
      authorizationNote: 'AUTH-INTAKE-AFTER-REPORT',
      behaviorProfile: 'standard',
      scopeEntryProfile: 'domain',
    });
    assert.equal(confirmed.scopeVersion, 1, '报告之后确认必须照常成立');
    assert.equal(confirmed.sessionKind, 'phase');
  });

  test('已经分叉的历史作业（报告把主状态推成 waiting_human_review）仍然可以确认', async () => {
    // 线上已经处于分叉状态的作业不该被判死刑：判据认的是「活动会话就是那份 intake、
    // 且它已交回人类」这条事实。写入点已修（上一条用例），这条锁的是**可恢复性**。
    const { engagementId: id, intakeId, proposalId } = await newIntakeProposal();
    await pool.query(`update pentest.worker_sessions set status = 'waiting_human' where id = $1::uuid`, [intakeId]);
    await pool.query(`update pentest.engagements set current_status = 'waiting_human_review' where id = $1::uuid`, [id]);

    const preview = await service.previewPolicy({
      engagementId: id,
      proposalId,
      targets: [{ kind: 'domain', value: 'Target.Example.', protocols: ['tcp'], ports: [{ from: 443, to: 443 }] }],
      exclusions: [],
      allowedActions: ['active_probing'],
      scopeEntryProfile: 'domain',
      behaviorProfile: 'standard',
    });
    assert.equal(
      preview.blockers.some((blocker) => blocker.includes('intake')),
      false,
      `分叉状态也必须给出「确认会成功」的预览：${preview.blockers.join(' / ')}`,
    );

    const confirmed = await service.confirmScopeProposal({
      approvalMode: 'human',
      engagementId: id,
      operatorId: 'op',
      reason: '人类确认范围（分叉修复）',
      expectedStateVersion: 0,
      proposalId,
      objective: '确认后的目标',
      targets: [{ kind: 'domain', value: 'Target.Example.', protocols: ['tcp'], ports: [{ from: 443, to: 443 }] }],
      exclusions: [],
      allowedActions: ['active_probing'],
      authorizationNote: 'AUTH-INTAKE-LEGACY',
      behaviorProfile: 'standard',
      scopeEntryProfile: 'domain',
    });
    assert.equal(confirmed.scopeVersion, 1);
  });

  test('previewPolicy：预览与确认同源（哈希逐位相同、版本号即写入的那个）', async () => {
    // 这是预览面唯一的硬要求：人类看到的就是确认之后会冻结的东西。
    // 两边各自拼参数迟早漂移，而漂移的表现是「预览里的哈希 ≠ 确认后写的哈希」——
    // 那等于让人确认了一件没发生的事。
    const { engagementId: id, proposalId } = await newIntakeProposal();
    const inputs = {
      scopeEntryProfile: 'ip' as const,
      behaviorProfile: 'stealth' as const,
      targets: [
        { kind: 'ip' as const, value: '192.0.2.77', protocols: ['tcp' as const], ports: [{ from: 8000, to: 8000 }] },
        // 投影规则：cidr / url / asset-label **不进**裁决集合（它们不是可拨号的字面地址）。
        // 删掉 `egress-allowlist.test.ts` 之后这条语义一度没人锁（2026-10-07 评审指出的覆盖空洞）。
        { kind: 'cidr' as const, value: '198.51.100.0/24', protocols: ['tcp' as const], ports: [{ from: 8000, to: 8000 }] },
        { kind: 'url' as const, value: 'https://app.example/', protocols: ['tcp' as const], ports: [{ from: 443, to: 443 }] },
        { kind: 'asset-label' as const, value: '核心资产', protocols: ['tcp' as const], ports: [{ from: 8000, to: 8000 }] },
      ],
      exclusions: [],
      allowedActions: ['active_probing' as const],
      authorizationRef: 'LAB-SELF-1',
      authorizationExpiresAt: '2030-01-01T00:00:00Z',
      timeWindow: { from: '09:00', to: '18:00' },
    };

    const preview = await service.previewPolicy({ engagementId: id, ...inputs });
    assert.equal(preview.ok, true, `预览不应被拦：${preview.blockers.join('; ')}`);
    assert.equal(preview.nextScopeVersion, 1, '尚无范围版本时预览应给出 v1');
    assert.equal(preview.nextPolicyVersion, 1);
    assert.equal(preview.currentPolicyEpoch, 0);
    // 首次确认**不**推进 epoch：它之前没有在途动作与凭证可撤销。预览必须如实说明，
    // 否则界面会展示一个不会发生的 `epoch → +1`（这条断言就是那个谎言的锁）。
    assert.equal(preview.nextPolicyEpoch, preview.currentPolicyEpoch);
    assert.equal(preview.behaviorProfile, 'stealth');
    // 地址裁决：IP 字面量自身即已裁决地址，预览必须显示同一个事实。
    assert.deepEqual(preview.resolvedAddresses['192.0.2.77'], ['192.0.2.77']);
    // 投影规则的可证伪面：cidr / url / asset-label 不得出现在裁决集合里
    // （它们在实现里被显式跳过；不带这类条目的夹具会让这条断言永真）。
    assert.deepEqual(
      Object.keys(preview.resolvedAddresses),
      ['192.0.2.77'],
      'cidr / url / asset-label 不进裁决集合——只有可拨号的字面地址才进',
    );
    assert.deepEqual(preview.targets[0]?.protocols, ['tcp']);
    assert.ok(preview.pacing.rate > 0 && preview.pacing.concurrency >= 1, '预览必须给出展开后的节奏');
    // **人类勾选的「允许类别」不是「逐次放行类别」。**
    //
    // 这条断言此前写反了（它钉的是 `perActionApprovalClasses: [...allowedActions]` 那个实现），
    // 而那个实现让每一次 `passive_collection` / `active_probing` 都要人工放行——
    // 实战里每个动作都要人点一次，作业根本跑不动。§10.3 的分级表才是逐次放行的正解。
    assert.ok(
      !preview.perActionApprovalClasses.includes('active_probing'),
      '低风险类（主动探测）不该被逐次放行：它只是「允许」而已',
    );
    assert.ok(
      preview.perActionApprovalClasses.includes('exploit_validation'),
      '契约基线（利用验证）无论是否启用都必须在逐次放行集合里（§10.3 不得关闭）',
    );
    assert.ok(
      preview.perActionApprovalClasses.includes('lateral_movement'),
      '契约基线（横向移动）同上',
    );
    assert.ok(preview.executionConstraints['timeWindow'] !== undefined, '时间窗必须进约束（并因此进哈希）');
    assert.match(preview.snapshotHash, /^sha256:[0-9a-f]{64}$/);

    // 预览是只读的：连查两次结果一致，且版本号没有被推进。
    const again = await service.previewPolicy({ engagementId: id, ...inputs });
    assert.equal(again.snapshotHash, preview.snapshotHash);
    assert.equal(again.nextScopeVersion, 1);

    const confirmed = await service.confirmScopeProposal({
      approvalMode: 'human',
      engagementId: id,
      operatorId: 'op',
      reason: '人类确认范围',
      expectedStateVersion: 0,
      proposalId,
      objective: '确认后的目标',
      taskPrompt: undefined,
      targets: inputs.targets,
      exclusions: inputs.exclusions,
      allowedActions: [...inputs.allowedActions],
      authorizationNote: inputs.authorizationRef,
      authorizationExpiresAt: inputs.authorizationExpiresAt,
      scopeEntryProfile: inputs.scopeEntryProfile,
      behaviorProfile: inputs.behaviorProfile,
      timeWindow: inputs.timeWindow,
    });
    assert.equal(confirmed.scopeVersion, preview.nextScopeVersion);

    const stored = await pool.query<{ policy_snapshot_hash: string; policy_version: number }>(
      `select policy_snapshot_hash, policy_version from pentest.engagements where id = $1::uuid`,
      [id],
    );
    assert.equal(
      stored.rows[0]?.policy_snapshot_hash,
      preview.snapshotHash,
      '预览里的哈希必须就是确认写入的哈希',
    );
    assert.equal(Number(stored.rows[0]?.policy_version), preview.nextPolicyVersion);
  });

  test('previewPolicy：解析不到的域名与非法条目都以 blocker 呈现（不是「预览通过、确认被拒」）', async () => {
    const { engagementId: id } = await newIntakeProposal();

    const bad = await service.previewPolicy({
      engagementId: id,
      targets: [{ kind: 'ip', value: '999.1.1.1', protocols: ['tcp'], ports: [] }],
      exclusions: [],
    });
    assert.equal(bad.ok, false);
    assert.ok(bad.blockers.some((b) => b.includes('目标[0]')), `应点名具体行：${bad.blockers.join('; ')}`);

    // 夹具没有注入解析钩子：域名目标必须被明确说成「确认前无法确定拨号地址」，
    // 而不是静默给一个空地址集合。
    const noResolver = await service.previewPolicy({
      engagementId: id,
      targets: [{ kind: 'domain', value: 'target.example', protocols: ['tcp'], ports: [{ from: 443, to: 443 }] }],
      exclusions: [],
    });
    assert.equal(noResolver.ok, false);
    assert.ok(
      noResolver.blockers.some((b) => b.includes('DNS 裁决钩子')),
      `应说明缺少解析钩子：${noResolver.blockers.join('; ')}`,
    );
  });

  test('previewPolicy：确认会拒的输入必须在预览里就报出来（不是「预览通过、确认被拒」）', async () => {
    // 质检发现的四类不一致，逐条锁住：预览的承诺是「这里通过 = 确认会成功」。
    const { engagementId: id, proposalId } = await newIntakeProposal();
    const base = {
      engagementId: id,
      targets: [{ kind: 'ip' as const, value: '192.0.2.90', protocols: ['tcp' as const], ports: [{ from: 80, to: 80 }] }],
      exclusions: [],
    };

    // 空授权引用**不再**是阻断项（本部署授权主体即部署方；该字段只作审计留痕）。
    // 保留这条断言是为了防回归：它一旦重新出现在阻断列表里，作业又会被表单挡住。
    const blank = await service.previewPolicy({ ...base, authorizationRef: '   ' });
    assert.equal(blank.ok, true, `空授权引用不该阻断预览：${blank.blockers.join('; ')}`);

    const unknown = await service.previewPolicy({
      ...base,
      authorizationRef: 'AUTH-X',
      allowedActions: ['read_only' as never],
    });
    assert.equal(unknown.ok, false);
    assert.ok(unknown.blockers.some((b) => b.includes('未知动作类别')), unknown.blockers.join('; '));

    // 提案已被处理/不存在：两个标签页的典型情形——后者不能对着失效方案点确认。
    const stale = await service.previewPolicy({ ...base, authorizationRef: 'AUTH-X', proposalId: randomUUID() });
    assert.equal(stale.ok, false);
    assert.ok(stale.blockers.some((b) => b.includes('范围方案不存在或已被处理')), stale.blockers.join('; '));

    const fresh = await service.previewPolicy({ ...base, authorizationRef: 'AUTH-X', proposalId });
    assert.equal(fresh.ok, true, `待处理提案应当通过：${fresh.blockers.join('; ')}`);

    // 已经确认过的作业（此处用直接写库模拟「范围版本已存在」）不能再走确认路径——
    // 原实现会硬编码写 version 1，撞唯一约束后以 23505 冒到调用方。
    await pool.query(
      `insert into pentest.scope_versions
         (engagement_id, version, iteration, targets, exclusions, changed_by, content_hash)
       values ($1::uuid, 1, 1, '[]'::jsonb, '[]'::jsonb, 'tester', 'sha256:already')`,
      [id],
    );
    const already = await service.previewPolicy({ ...base, authorizationRef: 'AUTH-X', proposalId });
    assert.equal(already.ok, false);
    assert.ok(already.blockers.some((b) => b.includes('已有范围版本')), already.blockers.join('; '));
    await assert.rejects(
      () =>
        service.confirmScopeProposal({
          behaviorProfile: 'stealth',
          approvalMode: 'human',
          engagementId: id,
          operatorId: 'op',
          reason: '重复确认',
          expectedStateVersion: 0,
          proposalId,
          objective: 'x',
          targets: base.targets,
          exclusions: [],
          allowedActions: [],
          authorizationNote: 'AUTH-X',
        }),
      (error: unknown) => error instanceof WorkflowRejection && error.code === 'classification_rejected',
      '已有范围版本时必须给出领域拒绝，而不是把 23505 冒出去',
    );
  });

  test('getIntakeStatus：聊天内的卡片能读到「等待确认」的事实', async () => {
    // 这条路径曾经在 FORCE RLS 下静默返回「没有待办」：作业名读得到（租户级读），
    // 范围方案读不到（engagement 作用域）——人会因此以为没有要确认的东西。
    const { engagementId: id, intakeId, proposalId } = await newIntakeProposal();
    const status = await service.getIntakeStatus({ dshSessionId: `dsh-${intakeId}` });
    assert.equal(status.engagementId, id, '反查必须把 dsh 会话映射到作业');
    assert.equal(status.engagementName, 'confirm-scope');
    assert.equal(status.sessionKind, 'intake');
    assert.equal(status.mainStatus, 'auth_pending');
    assert.equal(
      status.pendingProposal?.id,
      proposalId,
      '待确认的方案必须读得出来——卡片没有它就画不出任何可点的选项',
    );
    assert.equal(status.pendingApprovalCount, 0);
    assert.equal(
      status.stateVersion,
      0,
      '必须把作业当前的 state_version 一起给界面——聊天卡片用它做乐观锁；' +
        '缺了它卡片只能发 0，而那是必然失败（实测：期望 0、实际 1）',
    );
    // 「哪个会话正在跑」由 `getState` + `listWorkerSessions` 回答（同一事实只留一处来源），
    // `IntakeStatus` 不重复携带它。


    const unknown = await service.getIntakeStatus({ dshSessionId: 'session-not-a-pentest-binding' });
    assert.equal(unknown.engagementId, null, '不属于本插件的会话返回全 null（不画任何东西）');
    assert.equal(unknown.pendingProposal, null);
    assert.equal(unknown.pendingApprovalCount, 0);
    assert.equal(unknown.stateVersion, 0, '读不到绑定时版本给 0（界面此时不画任何东西）');
  });

  test('会话列表带上最新未取代报告的要点：报告在界面上有出口（外部审计 P0-2）', async () => {
    engagementId = await newEngagement();
    const started = await service.startWorker({
      engagementId,
      operatorId: 'op',
      reason: '开始情报收集',
      expectedStateVersion: 0,
      phase: 'intelligence-gathering',
      taskPrompt: '收集目标资产',
      skillIds: [],
      toolAllow: ['pentest_exec'],
    });

    // 没交过报告时是 null，不是空对象：界面要能区分"没交过"与"交了但摘要是空的"。
    const before = await service.listWorkerSessions({ engagementId });
    assert.equal(
      before.length,
      1,
      `这个全新作业里冒出了 ${String(before.length)} 个会话：`
        + JSON.stringify(before.map((s) => [s.id, s.phase, s.status, s.dshSessionId])),
    );
    assert.equal(before[0]!.latestReport, null);

    // 交两份：列表给**最新未取代**的那份。两条行用不同的 `attempt`——同一 `(会话, attempt)`
    // 上只允许一条 `superseded_by is null`（部分唯一索引），而这里是自动提交，没有延迟外键
    // 可以颠倒"先让位、后插入"的顺序。
    const first = randomUUID();
    const second = randomUUID();
    const insertReport = `insert into pentest.worker_reports
         (id, engagement_id, worker_session_id, attempt, iteration, status, objective, summary,
          payload_json, content_hash, supersedes_id)
       values ($1::uuid, $2::uuid, $3::uuid, $4::int, 1, 'report_ready', $5, $6, '{}'::jsonb, $7, $8)`;
    await pool.query(insertReport, [first, engagementId, started.workerSessionId, 1, '第一轮', '第一份报告', 'h1', null]);
    await pool.query(insertReport, [second, engagementId, started.workerSessionId, 2, '第二轮', '第二份报告（取代前一份）', 'h2', first]);
    await pool.query(
      `update pentest.worker_reports set superseded_by = $2::uuid where id = $1::uuid`,
      [first, second],
    );

    const after = await service.listWorkerSessions({ engagementId });
    assert.equal(after[0]!.latestReport?.id, second, '被取代的那份不得当成要点给出去');
    assert.equal(after[0]!.latestReport?.summary, '第二份报告（取代前一份）');
    assert.equal(after[0]!.latestReport?.attempt, 2, '要点里的执行次数取自报告行本身');
  });

  test('getIntakeStatus：查询失败必须向上抛，不得伪装成「未绑定 / 0 待办」（P16）', async () => {
    // 此前这两条读路径各带 `.catch(() => ({ rows: [] }))`：DB 错误被折叠成
    // 「不属于本插件」或「0 个待放行」——与真实事实的含义相反（人会以为没有待办）。
    // 客户端已把 RPC 失败显示为「读不到」，因此服务层的正确行为是让错误出去。
    const boom = new Error('connection terminated unexpectedly');
    const failingOn = (fragment: string): PgWorkflowService => {
      const failingDb: DbClient = {
        async query<Row = Record<string, unknown>>(sql: string, params?: readonly unknown[]) {
          if (sql.includes(fragment)) throw boom;
          return db().query<Row>(sql, params);
        },
      };
      return new PgWorkflowService({ ...deps, db: failingDb });
    };

    // ① 绑定反查失败
    await assert.rejects(
      () => failingOn('worker_session_binding_by_dsh').getIntakeStatus({ dshSessionId: 'dsh-x' }),
      (error: unknown) => error === boom,
      '绑定查询失败必须原样抛出（而不是返回全 null）',
    );

    // ② 待办计数失败（绑定存在：先造一份真实 intake 提案）
    const { intakeId } = await newIntakeProposal();
    await assert.rejects(
      () => failingOn('from pentest.approvals').getIntakeStatus({ dshSessionId: `dsh-${intakeId}` }),
      (error: unknown) => error === boom,
      '待办计数失败必须原样抛出（而不是返回 0）',
    );
  });

  test('放行决策必须唤醒请求方会话（否则人类批了也没反应）', async () => {
    // 实战现象：Agent 提交申请后结束回合；人类在放行队列/会话卡片上点了批准，
    // 而**没有任何东西告诉 Agent 可以执行了**——作业就停在原地，看起来像「插件坏了」。
    // §10.3 的验收项写得很明确：会话运行中按插话路径送达、等待中唤醒送达。
    const { engagementId: id, proposalId } = await newIntakeProposal();
    const confirmed = await service.confirmScopeProposal({
      behaviorProfile: 'stealth',
      approvalMode: 'human',
      engagementId: id,
      operatorId: 'op',
      reason: '人类确认范围',
      expectedStateVersion: 0,
      proposalId,
      objective: '确认后的目标',
      targets: [{ kind: 'ip', value: '192.0.2.88', protocols: ['tcp'], ports: [{ from: 80, to: 80 }] }],
      exclusions: [],
      allowedActions: ['passive_collection'],
      authorizationNote: '',
    });

    const insertApproval = async (): Promise<string> => {
      const approvalId = randomUUID();
      await pool.query(
        `insert into pentest.approvals
           (id, engagement_id, requested_by_worker, action_class, target_snapshot, command_plan,
            plan_hash, risk_summary, decision, lease_generation, expires_at)
         values ($1::uuid,$2::uuid,$3::uuid,'passive_collection','{}'::jsonb,'{}'::jsonb,'h','',
                 'pending', 1, now() + interval '10 minutes')`,
        [approvalId, id, confirmed.workerSessionId],
      );
      return approvalId;
    };

    // ① 批准 → 必须送达，且消息里带 approval_id（Agent 靠它调用执行）。
    const approved = await insertApproval();
    const before = sessions.delivered.length;
    await service.decideApproval({ approvalId: approved, operatorId: 'op', decision: 'approved', reason: '核对了命令与目标' });
    const afterApprove = sessions.delivered.slice(before);
    assert.equal(afterApprove.length, 1, '批准必须投递一条唤醒消息');
    assert.equal(afterApprove[0]?.dshSessionId, confirmed.dshSessionId, '必须投给发起申请的那个会话');
    assert.ok(afterApprove[0]?.message.includes(approved), '消息里必须带 approval_id');

    // ② 驳回 → 同样送达，并带上人类给的理由（Agent 据此换方案而不是重试）。
    const rejected = await insertApproval();
    const beforeReject = sessions.delivered.length;
    await service.decideApproval({ approvalId: rejected, operatorId: 'op', decision: 'rejected', reason: '这条命令超出本次范围' });
    const afterReject = sessions.delivered.slice(beforeReject);
    assert.equal(afterReject.length, 1, '驳回也必须告知请求方');
    assert.ok(afterReject[0]?.message.includes('超出本次范围'), '驳回理由必须随消息送达');

    // ③ 会话已关闭 → 不投递，也不把「批准」变成失败（凭证自身仍按规则有效/失效）。
    await pool.query(`update pentest.worker_sessions set status = 'closed' where id = $1::uuid`, [confirmed.workerSessionId]);
    const orphan = await insertApproval();
    const beforeClosed = sessions.delivered.length;
    await service.decideApproval({ approvalId: orphan, operatorId: 'op', decision: 'approved', reason: '会话已结束' });
    assert.equal(sessions.delivered.length, beforeClosed, '会话已关闭时不得投递（设计：会话失效时凭证失效且不投递）');
  });

  test('已批准未消费的凭证可撤销；已消费的不可撤销（撤销通道事故 2026-10-05）', async () => {
    // 事故：UI 对 `approved` 且未消费的凭证给出「撤销」按钮与「撤销后立即失效」的说明，
    // 但 service、resolver、触发器三层都只认 `pending`——人类对自己刚批准、Agent 还没用的
    // 凭证没有任何撤回通道（§10.3.1「放行队列可撤销」）。本用例锁住修复后的边：
    // approved + 未消费 --撤销--> revoked；已消费的凭证不在此列。
    const { engagementId: id, proposalId } = await newIntakeProposal();
    const confirmed = await service.confirmScopeProposal({
      behaviorProfile: 'stealth',
      approvalMode: 'human',
      engagementId: id,
      operatorId: 'op',
      reason: '人类确认范围',
      expectedStateVersion: 0,
      proposalId,
      objective: '确认后的目标',
      targets: [{ kind: 'ip', value: '192.0.2.88', protocols: ['tcp'], ports: [{ from: 80, to: 80 }] }],
      exclusions: [],
      allowedActions: ['passive_collection'],
      authorizationNote: '',
    });

    const insertApproval = async (): Promise<string> => {
      const approvalId = randomUUID();
      await pool.query(
        `insert into pentest.approvals
           (id, engagement_id, requested_by_worker, action_class, target_snapshot, command_plan,
            plan_hash, risk_summary, decision, lease_generation, expires_at)
         values ($1::uuid,$2::uuid,$3::uuid,'passive_collection','{}'::jsonb,'{}'::jsonb,'h','',
                 'pending', 1, now() + interval '10 minutes')`,
        [approvalId, id, confirmed.workerSessionId],
      );
      return approvalId;
    };

    // ① 批准 → 撤销：必须成功，写入新的决策见证、不触碰消费列。
    const revocable = await insertApproval();
    await service.decideApproval({ approvalId: revocable, operatorId: 'op', decision: 'approved', reason: '批准' });
    await service.revokeApproval({ approvalId: revocable, operatorId: 'op', reason: '目标已被移出范围' });
    const revoked = await pool.query<{
      decision: string; decided_by: string; decision_reason: string; consumed_at: Date | null;
    }>(
      `select decision, decided_by, decision_reason, consumed_at from pentest.approvals where id = $1::uuid`,
      [revocable],
    );
    assert.equal(revoked.rows[0]?.decision, 'revoked', '已批准未消费的凭证必须可撤销');
    assert.equal(revoked.rows[0]?.decided_by, 'op');
    assert.equal(revoked.rows[0]?.decision_reason, '目标已被移出范围');
    assert.equal(revoked.rows[0]?.consumed_at, null, '撤销不得写入消费见证');

    // ② 终态不可反复：再撤一次必须被拒。
    await assert.rejects(
      () => service.revokeApproval({ approvalId: revocable, operatorId: 'op', reason: '再来一次' }),
      /已被处理过/u,
    );

    // ③ 已消费的凭证不可撤销（消费见证不可覆盖，§16.1.1）。
    const runId = randomUUID();
    await pool.query(
      `insert into pentest.tool_runs
         (id, engagement_id, idempotency_key, tool_name, action_class, arguments_json, policy_decision, status)
       values ($1::uuid,$2::uuid,$3,'pentest_exec','passive_collection','{}'::jsonb,'{}'::jsonb,'succeeded')`,
      [runId, id, `k-revoke-${runId}`],
    );
    const consumed = await insertApproval();
    await service.decideApproval({ approvalId: consumed, operatorId: 'op', decision: 'approved', reason: '批准' });
    await pool.query(
      `update pentest.approvals set consumed_at = now(), consumed_by_tool_run = $2::uuid where id = $1::uuid`,
      [consumed, runId],
    );
    await assert.rejects(
      () => service.revokeApproval({ approvalId: consumed, operatorId: 'op', reason: '晚了' }),
      /已被消费/u,
    );
  });

  test('空授权说明也能确认：去掉的是表单，不是审计', async () => {
    // 部署画像：运行环境本身即授权主体（配套已获授权的作业），索要授权凭据只会挡住作业，
    // 而不增加任何技术安全边界。因此 `authorizationNote` 允许为空——
    // 但**人类决定必须照旧留痕**：这次改动删的是必填，不是账本。
    const { engagementId: id, proposalId } = await newIntakeProposal();

    const confirmed = await service.confirmScopeProposal({
      behaviorProfile: 'stealth',
      approvalMode: 'human',
      engagementId: id,
      operatorId: 'op',
      reason: '人类确认范围（未填授权凭据）',
      expectedStateVersion: 0,
      proposalId,
      objective: '确认后的目标',
      targets: [{ kind: 'ip', value: '192.0.2.77', protocols: ['tcp'], ports: [{ from: 80, to: 80 }] }],
      exclusions: [],
      allowedActions: ['passive_collection'],
      authorizationNote: '',
    });
    assert.equal(confirmed.scopeVersion, 1, '空授权说明必须能确认（否则作业被表单挡住）');
    assert.equal(confirmed.sessionKind, 'phase', '确认必须真的推进到第一阶段会话');

    const decisions = await pool.query<{ n: string }>(
      `select count(*)::text as n from pentest.human_decisions
        where engagement_id = $1::uuid and decision_type = 'confirm_scope_proposal'`,
      [id],
    );
    assert.equal(decisions.rows[0]?.n, '1', '人类决定必须照旧写进账本（删的是必填，不是审计）');

    const scope = await pool.query<{ authorization_ref: string | null }>(
      `select authorization_ref from pentest.scope_versions where engagement_id = $1::uuid`,
      [id],
    );
    assert.equal(scope.rows[0]?.authorization_ref ?? '', '', '留痕字段原样存空，不伪造内容');
  });

  test('confirmScopeProposal：范围条目非法时整体拒绝（不部分落库）', async () => {
    const id = randomUUID();
    madeEngagements.push(id);
    await assert.rejects(
      () =>
        service.confirmScopeProposal({
          behaviorProfile: 'stealth',
          approvalMode: 'human',
          engagementId: id,
          operatorId: 'op',
          reason: 'r',
          expectedStateVersion: 0,
          proposalId: randomUUID(),
          objective: 'x',
          targets: [{ kind: 'ip', value: '999.1.1.1', protocols: ['tcp'], ports: [] }],
          exclusions: [],
          allowedActions: [],
          authorizationNote: 'AUTH',
        }),
      (e: unknown) => e instanceof WorkflowRejection && e.code === 'classification_rejected',
      '规范化失败必须在写库之前拒绝',
    );
    const rows = await pool.query(`select 1 from pentest.scope_versions where engagement_id = $1::uuid`, [id]);
    assert.equal(rows.rowCount, 0, '拒绝时不得留下范围版本');
  });

  test('listEngagements：按 statuses 过滤，且默认不含 aborted/failed', async () => {
    const created = await service.createEngagement({
      behaviorProfile: 'stealth',
      approvalMode: 'human',
      operatorId: 'op', reason: 'r', name: 'to-abort',
      authorizationRef: 'A3', authorizationExpiresAt: '2026-01-01T00:00:00Z',
      targets: [{ kind: 'domain', value: 'c.test', protocols: ['tcp'], ports: [{ from: 443, to: 443 }] }],
      exclusions: [], roe: {}, timeWindow: {},
    });
    madeEngagements.push(created.id);
    await service.abort({
      engagementId: created.id, operatorId: 'op', reason: '结束', expectedStateVersion: 0,
    });

    const defaultList = await service.listEngagements({ operatorId: 'op', limit: 200 });
    assert.equal(
      defaultList.some((x) => x.id === created.id),
      false,
      '默认列表不含 aborted——它们留在库里（审计要求）但不占首页',
    );

    const explicit = await service.listEngagements({
      operatorId: 'op', statuses: ['aborted'], limit: 200,
    });
    assert.ok(explicit.some((x) => x.id === created.id), '显式索取时应返回');
  });

  test('审批模式：运行中可切（新策略版本 + policy epoch 推进 + 人类决策留痕）', async () => {
    const created = await service.createEngagement({
      behaviorProfile: 'deep',
      approvalMode: 'human',
      operatorId: 'op',
      reason: 'r',
      name: 'mode-switch',
      scopeEntryProfile: 'ip',
      targets: [{ kind: 'ip', value: '10.7.7.7', protocols: ['tcp'], ports: [{ from: 443, to: 443 }] }] as const,
    });
    madeEngagements.push(created.id);

    const ref = await service.setApprovalMode({
      engagementId: created.id,
      approvalMode: 'auto',
      operatorId: 'op',
      reason: '情报阶段太慢：验证阶段改为高权限',
      expectedStateVersion: created.stateVersion,
    });
    assert.equal(ref.approvalMode, 'auto');
    assert.equal(ref.policyVersion, 2, '切换必须写新一版策略，不原地改');
    assert.equal(ref.policyEpoch, 1, '必须推进 policy epoch：旧放行凭证与在途计划当场失效');

    const row = await pool.query<{ policy_version: number; policy_epoch: string | number; mode: string | null; enabled: unknown }>(
      `select policy_version, policy_epoch,
              policy_snapshot -> 'action_policy' ->> 'approval_mode' as mode,
              policy_snapshot -> 'action_policy' -> 'enabled' as enabled
         from pentest.engagements where id = $1::uuid`,
      [created.id],
    );
    assert.equal(Number(row.rows[0]!.policy_version), 2);
    assert.equal(Number(row.rows[0]!.policy_epoch), 1);
    assert.equal(row.rows[0]!.mode, 'auto');
    assert.ok(Array.isArray(row.rows[0]!.enabled) && row.rows[0]!.enabled.includes('exploit_validation'), '切换不得动启用集合：只改模式');

    // 同一档再切 → 拒绝（不平白推进 epoch，不产生空版本）。
    await assert.rejects(
      () => service.setApprovalMode({
        engagementId: created.id,
        approvalMode: 'auto',
        operatorId: 'op',
        reason: '再切一次',
        expectedStateVersion: 1,
      }),
      /已经是高权限档/,
    );

    // 切回来（收紧）：同样是新版本 + 新 epoch。
    const back = await service.setApprovalMode({
      engagementId: created.id,
      approvalMode: 'human',
      operatorId: 'op',
      reason: '发现疑似告警，切回人工审批',
      expectedStateVersion: 1,
    });
    assert.equal(back.approvalMode, 'human');
    assert.equal(back.policyVersion, 3);
    assert.equal(back.policyEpoch, 2);

    // **不写理由也照切**（人类是主人）：决策记录留 from/to，理由为空串。
    const noReason = await service.setApprovalMode({
      engagementId: created.id,
      approvalMode: 'auto',
      operatorId: 'op',
      expectedStateVersion: 2,
    });
    assert.equal(noReason.policyVersion, 4);
    const lastDecision = await pool.query<{ decision: string; reason: string | null }>(
      `select decision, reason from pentest.human_decisions
        where engagement_id = $1::uuid and decision_type = 'set_approval_mode'
        order by created_at desc limit 1`,
      [created.id],
    );
    assert.equal(lastDecision.rows[0]?.decision, 'auto');
    assert.equal(lastDecision.rows[0]?.reason, '', '没写理由就是空串，而不是拒绝切换');
  });

  test('清理：归档=列表隐藏可撤销；彻底删除三步（已归档 / 名字逐字一致 / 无活会话）', async () => {
    const created = await service.createEngagement({
      behaviorProfile: 'stealth',
      approvalMode: 'human',
      operatorId: 'op',
      reason: 'r',
      name: 'purge-me',
      scopeEntryProfile: 'ip',
      targets: [{ kind: 'ip', value: '10.9.9.9', protocols: ['tcp'], ports: [{ from: 443, to: 443 }] }] as const,
    });
    madeEngagements.push(created.id);

    // ① 未归档不能删：清理分两步，第一步就是「先让它在列表里消失、观察一阵」。
    await assert.rejects(
      () =>
        service.purgeEngagement({
          engagementId: created.id,
          operatorId: 'op',
          confirmName: 'purge-me',
          reason: '',
          expectedStateVersion: created.stateVersion,
        }),
      /尚未归档/,
    );

    // ② 归档 = 默认列表隐藏，但 includeArchived 仍读得到（数据一个字节没删）。
    const archived = await service.archiveEngagement({ engagementId: created.id, operatorId: 'op', archived: true });
    assert.ok(archived.archivedAt !== null, '归档时间必须落库');
    const defaultList = await service.listEngagements({ operatorId: 'op' });
    assert.equal(defaultList.some((entry) => entry.id === created.id), false, '归档后默认列表不该带它');
    const full = await service.listEngagements({ operatorId: 'op', includeArchived: true });
    assert.equal(full.some((entry) => entry.id === created.id), true, '显式索取时仍能看到');
    const preview = await service.previewEngagementPurge({ engagementId: created.id });
    assert.equal(preview.archived, true);
    assert.deepEqual([...preview.blockers], [], '无活会话/活租约时不该有拦截项');

    // ③ 名字必须逐字一致（人类防手滑的唯一栏杆）。
    await assert.rejects(
      () =>
        service.purgeEngagement({
          engagementId: created.id,
          operatorId: 'op',
          confirmName: 'purge',
          reason: '',
          expectedStateVersion: archived.stateVersion,
        }),
      /确认名与作业名不一致/,
    );

    // ④ 正名清空：**内容清零 + 审计骨架保留**（§9.5 只允许追加，触发器拒 DELETE）。
    const purge = await service.purgeEngagement({
      engagementId: created.id,
      operatorId: 'op',
      confirmName: 'purge-me',
      reason: '清理自检作业',
      expectedStateVersion: archived.stateVersion,
    });
    assert.ok(purge.retained['context_events'] !== undefined, '销毁记录要同时报「保留了什么」');

    const contentTables = [
      'approvals', 'scope_versions', 'scope_intake_proposals', 'tool_runs', 'worker_reports',
      'session_leases', 'outbox_jobs', 'index_watermarks', 'memory_items', 'memory_chunks',
      'artifacts', 'findings', 'reports', 'llm_calls', 'assets', 'asset_scope_versions',
      'embedding_revisions', 'request_snapshots', 'retrieval_queries',
    ] as const;
    for (const table of contentTables) {
      const left = await pool.query<{ n: number }>(
        `select count(*)::int as n from pentest.${table} where engagement_id = $1::uuid`,
        [created.id],
      );
      assert.equal(left.rows[0]?.n, 0, `${table} 必须清零（删漏一张表就会留下孤儿内容）`);
    }

    // 审计骨架仍在：这些行按 §9.5 不允许删除，作业行因此也保留（标记 purged_at）。
    // 建作业本身就会写这三张表；它们必须原样留着（只允许追加）。
    for (const table of ['context_events', 'human_decisions', 'policy_versions'] as const) {
      const left = await pool.query<{ n: number }>(
        `select count(*)::int as n from pentest.${table} where engagement_id = $1::uuid`,
        [created.id],
      );
      assert.ok((left.rows[0]?.n ?? 0) > 0, `${table} 的审计行必须保留（只允许追加）`);
    }
    assert.ok(purge.counts['context_events'] === undefined, '可删清单里不该出现审计表');
    assert.ok(purge.retained['context_events'] !== undefined, '预览/结果都要报「保留了什么」');
    const still = await pool.query<{ purged_at: Date | null; archived_at: Date | null; name: string }>(
      `select purged_at, archived_at, name from pentest.engagements where id = $1::uuid`,
      [created.id],
    );
    assert.equal(still.rowCount, 1, '作业行必须保留（审计行引用它）');
    assert.ok(still.rows[0]?.purged_at !== null, 'purged_at 标记内容已清空');

    // ⑤ 幂等：再清一次没有意义，明确拒绝。
    await assert.rejects(
      () =>
        service.purgeEngagement({
          engagementId: created.id,
          operatorId: 'op',
          confirmName: 'purge-me',
          reason: '',
          expectedStateVersion: archived.stateVersion,
        }),
      /已经清空过/,
    );

    const log = await pool.query<{ engagement_name: string; operator_id: string; deleted_counts: Record<string, unknown> }>(
      `select engagement_name, operator_id, deleted_counts from pentest.engagement_purges where engagement_id = $1::uuid`,
      [created.id],
    );
    assert.equal(log.rowCount, 1, '销毁记录必须留一行（独立于被清空的作业，否则等于没发生过）');
    assert.equal(log.rows[0]?.engagement_name, 'purge-me');
    assert.equal(log.rows[0]?.operator_id, 'op');
    assert.ok(log.rows[0]?.deleted_counts['retained'] !== undefined, '记录里要有保留计数');
  });


  test('信封丢掉 reason 时工作流不能炸：reason 以空串落库（列是 NOT NULL）', async () => {
    // 回归锁（2026-10-05 实测事故）：运行控制类端点改成「不要求理由」后，信封会**丢掉**
    // `reason` 字段；工作流若原样写库，`human_decisions.reason`（NOT NULL）会拒，
    // 人类看到的是 `console/internal 内部错误`——终止一个旧会话想归档时撞上的就是它。
    const created = await service.createEngagement({
      behaviorProfile: 'stealth',
      approvalMode: 'human',
      operatorId: 'op',
      reason: 'r',
      name: 'no-reason',
      scopeEntryProfile: 'ip',
      targets: [{ kind: 'ip', value: '10.9.9.9', protocols: ['tcp'], ports: [{ from: 443, to: 443 }] }] as const,
    });
    madeEngagements.push(created.id);

    await service.updateEngagementMemory({
      engagementId: created.id,
      operatorId: 'op',
      content: '规则：只做只读动作',
      reason: undefined as unknown as string,
      expectedStateVersion: created.stateVersion,
    });
    const row = await pool.query<{ reason: string | null }>(
      `select reason from pentest.human_decisions where engagement_id = $1::uuid order by created_at desc limit 1`,
      [created.id],
    );
    assert.equal(row.rows[0]?.reason, '', '缺 reason 必须归一成空串，而不是写 null');
  });


  test('终止（信封丢掉 reason）不炸：human_decisions 与 state_transitions 都以空串落库', async () => {
    // 完整复刻人类的动作：建作业 → 启动 Agent → 终止，且**信封丢掉了 reason**
    // （运行控制类端点改成「不要求理由」后就是这个形状）。
    // 2026-10-05 实测先后撞了两处 NOT NULL：human_decisions.reason、state_transitions.reason。
    const created = await service.createEngagement({
      behaviorProfile: 'stealth',
      approvalMode: 'human',
      operatorId: 'op',
      reason: 'r',
      name: 'abort-no-reason',
      scopeEntryProfile: 'ip',
      targets: [{ kind: 'ip', value: '10.9.9.9', protocols: ['tcp'], ports: [{ from: 443, to: 443 }] }] as const,
    });
    madeEngagements.push(created.id);
    await service.startWorker({
      engagementId: created.id,
      operatorId: 'op',
      reason: '开始情报收集',
      expectedStateVersion: created.stateVersion,
      phase: 'intelligence-gathering',
      taskPrompt: '收集目标资产',
      skillIds: [],
      toolAllow: ['memory_search'],
    });

    // 启动后版本前进了：现取（`StartedWorker` 不带它，别猜）。
    const versionRow = await pool.query<{ state_version: string | number }>(
      // bigint 经驱动回来是字符串：必须显式转数字，否则 `1 !== '1'` 会伪装成"版本不匹配"。
      `select state_version from pentest.engagements where id = $1::uuid`,
      [created.id],
    );
    const aborted = await service.abort({
      engagementId: created.id,
      operatorId: 'op',
      reason: undefined as unknown as string,
      expectedStateVersion: Number(versionRow.rows[0]?.state_version ?? 0),
    });
    assert.equal(aborted.runMarker, 'aborted');

    const decisions = await pool.query<{ reason: string | null }>(
      `select reason from pentest.human_decisions where engagement_id = $1::uuid order by created_at desc limit 1`,
      [created.id],
    );
    assert.equal(decisions.rows[0]?.reason, '', 'human_decisions.reason 必须是空串');
    const transitions = await pool.query<{ reason: string | null }>(
      `select reason from pentest.state_transitions where engagement_id = $1::uuid order by created_at desc limit 1`,
      [created.id],
    );
    assert.equal(transitions.rows[0]?.reason, '', 'state_transitions.reason 必须是空串');
  });


  test('清空：终止要结束**所有**非终态会话；审批被消费后也删得掉（外键环从 tool_runs 侧解）', async () => {
    // 实战现象（2026-10-05）：
    // ① 终止过去只关 `active_agent_session_id`，等待人工判断的 worker 与 intake 会话以非终态
    //    留在库里，清空被「仍有 N 个未终结的会话」**永久**拦住——而界面上没有任何按钮能结束它们；
    // ② 带已消费审批的作业清空撞 approvals 守卫触发器（`消费见证不可覆盖` /
    //    `只能从 pending 由人类入口推进`）：那是审批凭证语义的守卫，不该为清理开洞。
    const { engagementId: id, proposalId } = await newIntakeProposal();
    const confirmed = await service.confirmScopeProposal({
      behaviorProfile: 'stealth',
      approvalMode: 'human',
      engagementId: id,
      operatorId: 'op',
      reason: '人类确认范围',
      expectedStateVersion: 0,
      proposalId,
      objective: '确认后的目标',
      targets: [{ kind: 'ip', value: '192.0.2.88', protocols: ['tcp'], ports: [{ from: 80, to: 80 }] }],
      exclusions: [],
      allowedActions: ['passive_collection'],
      authorizationNote: '',
    });

    // 一张已消费的审批 + 它对应的工具运行：外键环的实物。
    const runId = randomUUID();
    await pool.query(
      `insert into pentest.tool_runs
         (id, engagement_id, idempotency_key, tool_name, action_class, arguments_json, policy_decision, status)
       values ($1::uuid,$2::uuid,'k-consumed','pentest_exec','passive_collection','{}'::jsonb,'{}'::jsonb,'succeeded')`,
      [runId, id],
    );
    const approvalId = randomUUID();
    await pool.query(
      `insert into pentest.approvals
         (id, engagement_id, requested_by_worker, action_class, target_snapshot, command_plan,
          plan_hash, risk_summary, decision, lease_generation, expires_at)
       values ($1::uuid,$2::uuid,$3::uuid,'passive_collection','{}'::jsonb,'{}'::jsonb,'h','',
               'pending', 1, now() + interval '10 minutes')`,
      [approvalId, id, confirmed.workerSessionId],
    );
    await service.decideApproval({ approvalId, operatorId: 'op', decision: 'approved', reason: '批准' });
    await pool.query(
      `update pentest.approvals set consumed_at = now(), consumed_by_tool_run = $2::uuid where id = $1::uuid`,
      [approvalId, runId],
    );

    // 终止 = 整体结束：所有非终态会话落终态，租约同时吊销。
    const versionOf = async (): Promise<number> => {
      const r = await pool.query<{ state_version: string | number }>(
        `select state_version from pentest.engagements where id = $1::uuid`,
        [id],
      );
      return Number(r.rows[0]?.state_version ?? 0);
    };
    await service.abort({ engagementId: id, operatorId: 'op', reason: '不做了', expectedStateVersion: await versionOf() });
    const live = await pool.query<{ n: number }>(
      `select count(*)::int as n from pentest.worker_sessions
        where engagement_id = $1::uuid and not (status = any($2::text[]))`,
      [id, [...TERMINAL_SESSION_STATUSES]],
    );
    assert.equal(live.rows[0]?.n, 0, '终止后不该还有未终结的会话（含 intake 与等待人工判断的 worker）');
    const leasesLeft = await pool.query<{ n: number }>(
      `select count(*)::int as n from pentest.session_leases
        where engagement_id = $1::uuid and revoked_at is null and expires_at > now()`,
      [id],
    );
    assert.equal(leasesLeft.rows[0]?.n, 0, '终止后不该还有有效租约（否则清空会被死凭证拦住，而界面没有吊销按钮）');

    await service.archiveEngagement({ engagementId: id, operatorId: 'op', archived: true });
    const preview = await service.previewEngagementPurge({ engagementId: id });
    assert.deepEqual([...preview.blockers], [], '终止 + 归档后不该还有拦截项');

    const nameRow = await pool.query<{ name: string }>(`select name from pentest.engagements where id = $1::uuid`, [id]);
    const purge = await service.purgeEngagement({
      engagementId: id,
      operatorId: 'op',
      confirmName: nameRow.rows[0]?.name ?? '',
      reason: '清理自检作业',
      expectedStateVersion: await versionOf(),
    });
    assert.equal(purge.counts['approvals'], 1, '已消费的审批必须随清空落删');
    assert.equal(purge.counts['tool_runs'], 1, '外键环另一侧（工具运行）也要落删');
    const left = await pool.query<{ n: number }>(
      `select count(*)::int as n from pentest.approvals where engagement_id = $1::uuid`,
      [id],
    );
    assert.equal(left.rows[0]?.n, 0, '清空后审批行不该残留');
  });

  // ── 账本一致性（2026-10-05 复核 REQ-8 / AD-1 / AD-2 / AD-3 的回归锁）──

  async function countTransitions(target: string): Promise<number> {
    const r = await pool.query<{ n: number }>(
      `select count(*)::int as n from pentest.state_transitions where engagement_id = $1::uuid`,
      [target],
    );
    return r.rows[0]?.n ?? 0;
  }

  /**
   * 账本一致性：该作业的**每一条** `state_transitions` 都必须是状态图上的边。
   *
   * 这是 REQ-8 家族的通用锁：手写 `from_status` / `type` 曾把 `complete` 写在
   * 「结束技术测试」的边上、把 `start` 写在 `auth_pending → worker_running` 上——
   * 两者都不在图上，而只看单个操作很难发现。
   */
  async function assertLedgerLegal(target: string): Promise<void> {
    const rows = await pool.query<{ transition_type: string; from_status: string; to_status: string }>(
      `select transition_type, from_status, to_status from pentest.state_transitions
        where engagement_id = $1::uuid`,
      [target],
    );
    // 空账本合法（这些夹具是直接播种子行、不写迁移的）；这里只锁「写了的每一行都合法」，
    // 行的存在性由各用例自己的断言负责。
    for (const row of rows.rows) {
      assert.equal(
        isLegalStatusEdge(
          row.transition_type as TransitionType,
          row.from_status as MainStatus,
          row.to_status as MainStatus,
        ),
        true,
        `账本出现图上不存在的边：${row.transition_type} ${row.from_status} → ${row.to_status}`,
      );
    }
    // 版本推进与转移行必须同向：`resulting_version` 是那一行的落点，而
    // `engagements.state_version` 是所有推进（含登记在案的非转移推进）之后的当前值。
    // 因此**当前版本不得低于任何一行的落点**——低了说明有人写了转移行却没推进版本，
    // 那种账本回放时会读出「状态没变但发生过转移」。
    const versions = await pool.query<{ state_version: number | string; max_resulting: number | string | null }>(
      `select e.state_version,
              (select max(t.resulting_version) from pentest.state_transitions t
                where t.engagement_id = e.id) as max_resulting
         from pentest.engagements e where e.id = $1::uuid`,
      [target],
    );
    const current = Number(versions.rows[0]?.state_version ?? 0);
    const maxResulting = Number(versions.rows[0]?.max_resulting ?? 0);
    assert.ok(
      current >= maxResulting,
      `state_version（${current}）低于账本最大落点（${maxResulting}）：有转移行没有推进版本`,
    );
  }

  test('结束技术测试不写图上不存在的边；重新打开必须挂回活动会话（REQ-8a / AD-1 回归锁）', async () => {
    const finishing = await newWaitingHumanSession();
    const before = await service.getState(finishing.id);
    await service.finishTechnicalTesting({
      engagementId: finishing.id,
      operatorId: 'op',
      reason: '回归用例：结束技术测试',
      expectedStateVersion: before.stateVersion,
    });
    const ghost = await pool.query<{ n: number }>(
      `select count(*)::int as n from pentest.state_transitions
        where engagement_id = $1::uuid and from_status = 'waiting_human_review' and to_status = 'report_ready'`,
      [finishing.id],
    );
    assert.equal(ghost.rows[0]?.n, 0, '该边 recorded:false：账本不得出现这一行（REQ-8a）');
    await assertLedgerLegal(finishing.id);

    const ready = await service.getState(finishing.id);
    await service.reopenTechnicalWork({
      engagementId: finishing.id,
      operatorId: 'op',
      reason: '回归用例：重新打开',
      expectedStateVersion: ready.stateVersion,
    });
    const reopened = await service.getState(finishing.id);
    assert.equal(reopened.mainStatus, 'worker_running');
    assert.notEqual(
      reopened.activeWorkerSessionId,
      null,
      'AD-1：重新打开必须挂回活动会话，否则补充技术动作永远无法开始',
    );
    const session = await pool.query<{ status: string }>(
      `select status from pentest.worker_sessions where id = $1::uuid`,
      [reopened.activeWorkerSessionId],
    );
    assert.equal(session.rows[0]?.status, 'active', '被挂回的会话必须置回 active');
    await assertLedgerLegal(finishing.id);
  });

  test('插话在交接草稿/确认期间必须被拒：不写账本、草稿不被孤儿化（REQ-8b 回归锁）', async () => {
    const waiting = await newWaitingHumanSession();
    const draft = await service.beginHandoff({
      workerSessionId: waiting.sessionId,
      operatorId: 'op',
      toPhase: 'threat-modeling',
    });
    const inHandoff = await service.getState(waiting.id);
    assert.notEqual(inHandoff.mainStatus, 'waiting_human_review', '前置条件：作业已进入交接阶段');
    const before = await countTransitions(waiting.id);

    await assert.rejects(
      () => service.interject({
        workerSessionId: waiting.sessionId,
        message: '先看 10.0.0.5',
        expectedStateVersion: inHandoff.stateVersion,
      }),
      (error: unknown) =>
        error instanceof WorkflowRejection &&
        error.code === 'classification_rejected' &&
        /交接/.test(error.message),
      '交接草稿/确认期间插话必须拒绝：否则草稿成孤儿、账本写下与实际不符的 from_status',
    );

    assert.equal(await countTransitions(waiting.id), before, '拒绝不得写账本');
    assert.equal(
      (await service.getState(waiting.id)).mainStatus,
      inHandoff.mainStatus,
      '主状态不得被插话改动',
    );
    // 草稿仍可取消：证明没有把作业扳成 worker_running 而让它失去取消/确认路径。
    const cancelled = await service.cancelHandoff({
      engagementId: waiting.id,
      operatorId: 'op',
      reason: '回归用例：取消草稿',
      expectedStateVersion: (await service.getState(waiting.id)).stateVersion,
    });
    assert.equal(cancelled.mainStatus, 'waiting_human_review');
    assert.ok(draft.draftId.length > 0);
    await assertLedgerLegal(waiting.id);
  });

  test('交接确认不得用来做同阶段重做：拒绝并指向 retryWorker（REQ-8c 回归锁）', async () => {
    const waiting = await newWaitingHumanSession();
    const phase = (await service.getState(waiting.id)).currentPhase;
    assert.ok(phase !== null, '前置条件：当前阶段已知');
    const draft = await service.beginHandoff({
      workerSessionId: waiting.sessionId,
      operatorId: 'op',
      toPhase: phase,
    });
    const before = await countTransitions(waiting.id);
    const stateBefore = await service.getState(waiting.id);

    await assert.rejects(
      () =>
        service.confirmTransition({
          engagementId: waiting.id,
          operatorId: 'op',
          reason: '同阶段重做',
          expectedStateVersion: stateBefore.stateVersion,
          draftId: draft.draftId,
          forced: false,
          forcedAcknowledged: false,
          objective: '同阶段重做',
          excludedRefs: [],
          approvedToPhase: phase,
          approvedPrompt: 'p',
          approvedSkillIds: [],
          approvedToolAllow: [],
          approvedApprovalRequired: [],
          contextRefs: [],
        }),
      (error: unknown) =>
        error instanceof WorkflowRejection && /重做本阶段|retryWorker/.test(error.message),
      '同阶段确认写不出合法的边：必须拒绝并指向 retryWorker',
    );

    assert.equal(await countTransitions(waiting.id), before, '拒绝不得写账本');
    assert.equal(
      (await service.getState(waiting.id)).mainStatus,
      'transition_confirmation',
      '状态必须保持不变：草稿仍可确认（换目标阶段）或取消',
    );
    await assertLedgerLegal(waiting.id);
  });

  // ── 运行期动作前置、blocked 出口与投递失败补偿（2026-10-05 复核 F1/F5/F6 的回归锁）──

  test('运行标记前置：终止后不能暂停/恢复，已签字导出后一切运行期动作无意义', async () => {
    const id = await newEngagement();
    await pool.query(
      `update pentest.engagements set status = 'paused', current_status = 'waiting_human_review'
        where id = $1::uuid`,
      [id],
    );
    const paused = await service.getState(id);
    await assert.rejects(
      () => service.pause({ engagementId: id, operatorId: 'op', reason: '', expectedStateVersion: paused.stateVersion }),
      (e: unknown) => e instanceof WorkflowRejection && e.code === 'classification_rejected',
      '对已暂停的再暂停是空操作，必须拒绝（客户端按同一份判定禁用按钮）',
    );

    // 阻塞态：**有受支持的出口**——恢复（处置完继续），且不改写主状态。
    await pool.query(`update pentest.engagements set status = 'blocked' where id = $1::uuid`, [id]);
    const blocked = await service.getState(id);
    const resumed = await service.resume({
      engagementId: id,
      operatorId: 'op',
      reason: '处置完毕',
      expectedStateVersion: blocked.stateVersion,
    });
    assert.equal(resumed.runMarker, 'running');
    assert.equal(resumed.mainStatus, 'waiting_human_review', '恢复回到原主状态（§5.1）');

    // 终止是终态：暂停会把它弹回 paused、恢复再弹回 running——这条复活链必须断在服务端。
    const running = await service.getState(id);
    const aborted = await service.abort({
      engagementId: id,
      operatorId: 'op',
      reason: '',
      expectedStateVersion: running.stateVersion,
    });
    assert.equal(aborted.runMarker, 'aborted');
    for (const attempt of [
      () => service.pause({ engagementId: id, operatorId: 'op', reason: '', expectedStateVersion: aborted.stateVersion }),
      () => service.resume({ engagementId: id, operatorId: 'op', reason: '', expectedStateVersion: aborted.stateVersion }),
      () => service.abort({ engagementId: id, operatorId: 'op', reason: '', expectedStateVersion: aborted.stateVersion }),
    ]) {
      await assert.rejects(
        attempt,
        (e: unknown) => e instanceof WorkflowRejection && e.code === 'classification_rejected',
        '终态作业的运行期动作必须全部拒绝（否则出现「标记运行中、会话全关闭」的僵尸）',
      );
    }
    assert.equal((await service.getState(id)).runMarker, 'aborted');

    // 已签字导出（complete）：同样全部拒绝。
    await pool.query(
      `update pentest.engagements set status = 'running', current_status = 'complete' where id = $1::uuid`,
      [id],
    );
    const complete = await service.getState(id);
    assert.equal(complete.mainStatus, 'complete');
    for (const attempt of [
      () => service.pause({ engagementId: id, operatorId: 'op', reason: '', expectedStateVersion: complete.stateVersion }),
      () => service.abort({ engagementId: id, operatorId: 'op', reason: '', expectedStateVersion: complete.stateVersion }),
      () => service.resume({ engagementId: id, operatorId: 'op', reason: '', expectedStateVersion: complete.stateVersion }),
    ]) {
      await assert.rejects(
        attempt,
        (e: unknown) => e instanceof WorkflowRejection && e.code === 'classification_rejected',
      );
    }
  });

  test('追加预算只加额度：主状态不被改写，且阻塞作业不能靠它恢复', async () => {
    const { id, sessionId } = await newWaitingHumanSession();
    const s0 = await service.getState(id);
    const paused = await service.pause({
      engagementId: id,
      operatorId: 'op',
      reason: '预算触顶',
      expectedStateVersion: s0.stateVersion,
    });
    const extended = await service.extendBudget({
      workerSessionId: sessionId,
      operatorId: 'op',
      reason: '加额度',
      expectedStateVersion: paused.stateVersion,
      additionalTokens: 1000,
    });
    assert.equal(extended.runMarker, 'running', '追加预算即恢复会话（§10.5）');
    assert.equal(
      extended.mainStatus,
      'waiting_human_review',
      '追加预算不是「回到运行中」：主状态必须原样不动（此前会被改写成 worker_running）',
    );
    const budget = await pool.query<{ budget_max_tokens: number | null }>(
      `select budget_max_tokens from pentest.worker_sessions where id = $1::uuid`,
      [sessionId],
    );
    assert.equal(Number(budget.rows[0]?.budget_max_tokens), 1000);

    // 阻塞态：先恢复或终止，不能靠追加预算当第二条恢复路径。
    await pool.query(`update pentest.engagements set status = 'blocked' where id = $1::uuid`, [id]);
    const blocked = await service.getState(id);
    await assert.rejects(
      () =>
        service.extendBudget({
          workerSessionId: sessionId,
          operatorId: 'op',
          reason: '绕过阻塞',
          expectedStateVersion: blocked.stateVersion,
          additionalTokens: 1000,
        }),
      (e: unknown) => e instanceof WorkflowRejection && e.code === 'classification_rejected',
    );
    assert.equal((await service.getState(id)).runMarker, 'blocked', '拒绝不得顺手改标记');

    // 「complete + paused」也必须拒绝：在 report_ready 暂停、再签字导出就是这个形态，
    // 放行会把已经结束的作业的运行标记复活成 running（2026-10-05 质检发现）。
    await pool.query(
      `update pentest.engagements set status = 'paused', current_status = 'complete' where id = $1::uuid`,
      [id],
    );
    const signed = await service.getState(id);
    await assert.rejects(
      () =>
        service.extendBudget({
          workerSessionId: sessionId,
          operatorId: 'op',
          reason: '再给点额度',
          expectedStateVersion: signed.stateVersion,
          additionalTokens: 1000,
        }),
      (e: unknown) =>
        e instanceof WorkflowRejection && e.code === 'classification_rejected' && /签字导出/.test(e.message),
    );
    assert.equal((await service.getState(id)).runMarker, 'paused', '拒绝不得复活已签字导出的作业');
  });

  test('结束技术测试：worker_running 那条边可用，且关掉在跑的会话、吊销其租约', async () => {
    const id = await newEngagement();
    const started = await service.startWorker({
      engagementId: id,
      operatorId: 'op',
      reason: '开跑',
      expectedStateVersion: (await service.getState(id)).stateVersion,
      phase: 'intelligence-gathering',
      taskPrompt: '情报收集',
      skillIds: [],
      toolAllow: [],
    });
    const before = await service.getState(id);
    assert.equal(before.mainStatus, 'worker_running', '前置条件：Agent 正在跑');

    // §13.8 第二步：有在途执行或待决放行时不得结束技术测试（否则那条执行留在半空，
    // 而作业已经宣布「技术测试结束」）。
    await pool.query(
      `insert into pentest.tool_runs
         (engagement_id, worker_session_id, idempotency_key, tool_name, action_class,
          arguments_json, policy_decision, status)
       values ($1::uuid, $2::uuid, 'wf-inflight', 'pentest_exec', 'active_probing',
               '{}'::jsonb, '{}'::jsonb, 'running')`,
      [id, started.workerSessionId],
    );
    await assert.rejects(
      () =>
        service.finishTechnicalTesting({
          engagementId: id,
          operatorId: 'op',
          reason: '还有在途动作',
          expectedStateVersion: before.stateVersion,
        }),
      (e: unknown) =>
        e instanceof WorkflowRejection && e.code === 'classification_rejected' && /在途|运行中的工具执行/.test(e.message),
      '在途工具执行必须拦住「结束技术测试」（§13.8）',
    );
    await pool.query(`delete from pentest.tool_runs where engagement_id = $1::uuid and status = 'running'`, [id]);

    // 过期的待决凭证**不拦**：它谁也处置不了（人类入口对已过期一律抛 approval_expired，
    // 界面把它置为不可交互，且没有任何生产路径会写 decision='expired'），若把它计入，
    // 「Agent 申请放行 → 人类忘了处理 → 过期」会让结束技术测试**永久被拒**（2026-10-05 质检发现）。
    await pool.query(
      `insert into pentest.approvals
         (engagement_id, requested_by_worker, action_class, target_snapshot, command_plan,
          plan_hash, risk_summary, decision, expires_at)
       values ($1::uuid, $2::uuid, 'active_probing', '{}'::jsonb, '{}'::jsonb,
               'expired-plan', '低', 'pending', now() - interval '1 minute')`,
      [id, started.workerSessionId],
    );

    const draft = await service.finishTechnicalTesting({
      engagementId: id,
      operatorId: 'op',
      reason: '就此收工',
      expectedStateVersion: before.stateVersion,
    });
    assert.equal(draft.engagementId, id);
    const after = await service.getState(id);
    assert.equal(after.mainStatus, 'report_ready', '§5.2 的 worker_running → report_ready 边必须能走');
    assert.equal(after.activeWorkerSessionId, null);

    const session = await pool.query<{ status: string }>(
      `select status from pentest.worker_sessions where id = $1::uuid`,
      [started.workerSessionId],
    );
    assert.equal(session.rows[0]?.status, 'closed', '在跑的会话必须收进终态，否则 Agent 继续烧预算');
    const leases = await pool.query<{ n: number }>(
      `select count(*)::int as n from pentest.session_leases
        where worker_session_id = $1::uuid and revoked_at is null`,
      [started.workerSessionId],
    );
    assert.equal(leases.rows[0]?.n, 0, '会话终结必须连带吊销租约（否则死凭证仍能通过准入）');
    await assertLedgerLegal(id);
  });

  test('暂停中不能结束技术测试：先恢复或终止（服务端与界面共用同一份判定）', async () => {
    const { id } = await newWaitingHumanSession();
    const running = await service.getState(id);
    const paused = await service.pause({
      engagementId: id,
      operatorId: 'op',
      reason: '先停一下',
      expectedStateVersion: running.stateVersion,
    });
    await assert.rejects(
      () =>
        service.finishTechnicalTesting({
          engagementId: id,
          operatorId: 'op',
          reason: '暂停中收工',
          expectedStateVersion: paused.stateVersion,
        }),
      (e: unknown) =>
        e instanceof WorkflowRejection && e.code === 'classification_rejected' && /结束技术测试|运行标记/.test(e.message),
    );
    assert.equal((await service.getState(id)).mainStatus, 'waiting_human_review', '拒绝不得改状态');
  });

  test('暂停中插话：拒绝且**不投递**（会话 active + 作业 paused，判定看运行标记）', async () => {
    // 判别力与上一条同源：从 waiting_human_review 起，旧实现只看"主状态 ≠ waiting_human_review" ⇒ 会放行。
    // 关键的第二半是**不投递**：拒绝后 `sessions.delivered` 必须一条都没多（插话会进模型上下文，
    // 静默投递等于把同一条指令送进会话两次）。
    const { id, sessionId } = await newWaitingHumanSession();
    const paused = await service.pause({
      engagementId: id,
      operatorId: 'op',
      reason: '先停一下',
      expectedStateVersion: (await service.getState(id)).stateVersion,
    });
    const before = sessions.delivered.length;
    await assert.rejects(
      () => service.interject({ workerSessionId: sessionId, message: '继续', expectedStateVersion: paused.stateVersion }),
      (e: unknown) => e instanceof WorkflowRejection && e.code === 'classification_rejected' && /运行标记/.test(e.message),
    );
    assert.equal(sessions.delivered.length, before, '被拒的插话不得有任何投递');
    // **不调 `assertLedgerLegal`**：实测从 `waiting_human_review` 调 `pause` 会写出一条
    // `pause: waiting_human_review → waiting_human_review`，而状态图上没有这条自环边、
    // 校验会红。服务允许这个动作（守卫只拒插话），所以这是**图/账本校验缺一条边**的既有问题，
    // 与本用例要守的"插话守卫"无关——不在这里顺手放宽，单独记在该轮的质检结论里。
  });

  test('结束技术测试的收尾失败：会话关不掉时不吞错——草稿仍返回、且不谎称已关闭', async () => {
    // `finishTechnicalTesting` 的最后一步是关会话；那一步失败**不得**回滚已经写好的报告草稿
    // （草稿是主产物），也不得把会话留在半关闭状态。用一个"任何方法都抛"的 leases 端口逼出这条路径
    // （与端口形状解耦，端口加了新方法也不会漏测）。
    const flaky = new PgWorkflowService({
      ...deps,
      leases: new Proxy({}, { get: () => () => { throw new Error('leases 不可用（演习）'); } }) as never,
    });
    const { id, sessionId } = await newWaitingHumanSession();
    const draft = await flaky.finishTechnicalTesting({
      engagementId: id,
      operatorId: 'op',
      reason: '收尾',
      expectedStateVersion: (await flaky.getState(id)).stateVersion,
    });
    assert.equal(draft.engagementId, id, '草稿必须照常返回：它是主产物');
    const session = await pool.query<{ status: string }>(
      `select status from pentest.worker_sessions where id = $1::uuid`,
      [sessionId],
    );
    assert.equal(
      session.rows[0]?.status === 'closed',
      false,
      '会话关闭失败时不得报成已关闭（实测会停在 waiting_human：不是 active，但也没谎称关闭）',
    );
  });

  test('投递失败的补偿：会话 failed、作业 blocked、账本留事件，且仍有恢复出口', async () => {
    const { id, sessionId } = await newWaitingHumanSession();
    await pool.query(
      `insert into pentest.session_leases (engagement_id, worker_session_id, generation, expires_at)
       values ($1::uuid, $2::uuid, 1, now() + interval '10 minutes')`,
      [id, sessionId],
    );
    // 让投递必然失败：假工厂把「已关闭」的 dsh 标识一律拒收。
    sessions.closed.push(`dsh-${sessionId}`);
    const before = await service.getState(id);
    await assert.rejects(
      () =>
        service.interject({
          workerSessionId: sessionId,
          message: '唤醒',
          expectedStateVersion: before.stateVersion,
        }),
      (e: unknown) => e instanceof WorkflowRejection && e.code === 'lease_revoked',
    );

    const after = await service.getState(id);
    assert.equal(after.runMarker, 'blocked', '投递失败必须交给人类处置，而不是停在「运行中」');
    const session = await pool.query<{ status: string }>(
      `select status from pentest.worker_sessions where id = $1::uuid`,
      [sessionId],
    );
    assert.equal(session.rows[0]?.status, 'failed');
    const leases = await pool.query<{ n: number }>(
      `select count(*)::int as n from pentest.session_leases
        where worker_session_id = $1::uuid and revoked_at is null`,
      [sessionId],
    );
    assert.equal(leases.rows[0]?.n, 0, '终结会话必须连带吊销租约');
    const events = await pool.query<{ n: number }>(
      `select count(*)::int as n from pentest.context_events
        where engagement_id = $1::uuid and event_type = 'workflow.delivery_failed'`,
      [id],
    );
    assert.equal(events.rows[0]?.n, 1, '补偿动作必须留痕');

    // 人类处置后仍有出口：blocked → running（主状态保持投递前的位置）。
    const resumed = await service.resume({
      engagementId: id,
      operatorId: 'op',
      reason: '换会话继续',
      expectedStateVersion: after.stateVersion,
    });
    assert.equal(resumed.runMarker, 'running');
  });

  test('插话的乐观锁：两条路径都消费 expectedStateVersion（不再「比对必然通过」）', async () => {
    const { id, sessionId } = await newWaitingHumanSession();
    const before = await service.getState(id);
    await assert.rejects(
      () =>
        service.interject({
          workerSessionId: sessionId,
          message: '基于过期快照',
          expectedStateVersion: before.stateVersion + 1,
        }),
      (e: unknown) => e instanceof WorkflowRejection && e.code === 'stale_state_version',
    );

    const woken = await service.interject({
      workerSessionId: sessionId,
      message: '请先看 10.0.0.5',
      expectedStateVersion: before.stateVersion,
    });
    assert.equal(woken.transitionType, 'interject_wake');
    const running = await service.getState(id);

    // 运行中投递不改状态，但同样要核对版本：否则双击会把同一条指令投两次。
    await assert.rejects(
      () =>
        service.interject({
          workerSessionId: sessionId,
          message: '再投一次',
          expectedStateVersion: running.stateVersion + 5,
        }),
      (e: unknown) => e instanceof WorkflowRejection && e.code === 'stale_state_version',
    );
    const delivered = await service.interject({
      workerSessionId: sessionId,
      message: '按当前版本投递',
      expectedStateVersion: running.stateVersion,
    });
    assert.equal(delivered.transitionType, 'none');
    assert.equal(delivered.delivered, true);
  });

});
