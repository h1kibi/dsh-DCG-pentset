/**
 * 启动对账执行者的测试。
 *
 * 重点锁定三条纪律：
 *   1. **只动无主会话**：租约有效的一律不碰（那是另一个实例在正常驱动）
 *   2. **不自动重放有副作用的动作**：遗留工具执行标为 `unknown`（终态），不是重试
 *   3. **高危阶段的未知状态交人类**：只阻塞 engagement，不动会话
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';

import { StartupRecovery, STALE_CREATION_SECONDS, STALE_TOOL_RUN_SECONDS } from '../src/workflow/recovery.ts';
import { PgLeaseStore } from '../src/workflow/pg-lease.ts';
import { MemoryLedger } from '../src/memory/ledger.ts';
import type { DbClient } from '../src/db/port.ts';
import type { Phase } from '../src/contracts.ts';
import { assertNoResidue, cleanupEngagements } from './helpers/cleanup.ts';

const DATABASE_URL = process.env.PENTEST_DATABASE_URL;

describe('启动对账执行者（真实 PostgreSQL）', { skip: DATABASE_URL === undefined ? '未设置 PENTEST_DATABASE_URL' : false }, () => {
  let pool: Pool;
  const engagements: string[] = [];

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
    // 清理走共享夹具（2026-10-05 复核 REQ-12）：此前这里有一份本地副本，
    // 表清单缺 `memory_chunks`/`artifacts`/`findings` 等，且每一条都
    // `.catch(() => undefined)` 把失败一并吞掉——残留因此无人发现。
    // `assertNoResidue` 把「清理是否真的生效」变成断言，而不是靠人工查库。
    await cleanupEngagements(pool, engagements);
    await assertNoResidue(pool, engagements);
    engagements.length = 0;
    await pool.end();
  });

  async function newEngagement(): Promise<string> {
    const id = randomUUID();
    await pool.query(
      `insert into pentest.engagements
         (id, tenant_id, name, status, current_status, target_snapshot, scope_snapshot, roe_snapshot, policy_snapshot, config_snapshot, created_by)
       values ($1::uuid, 't', 'recovery-test', 'running', 'worker_running', '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, 'tester')`,
      [id],
    );
    engagements.push(id);
    return id;
  }

  /** 造一个会话，可指定状态与「创建时间早于 N 秒」。 */
  async function newSession(input: {
    engagementId: string;
    status: string;
    phase?: Phase;
    ageSeconds?: number;
  }): Promise<string> {
    const id = randomUUID();
    await pool.query(
      `insert into pentest.worker_sessions
         (id, engagement_id, dsh_session_id, phase, profile_id, profile_revision, attempt, iteration,
          scope_version, task_prompt, tool_filter, skill_ids, model_route, status, created_at)
       values ($1::uuid, $2::uuid, $3, $4, 'p', 'r1', 1, 1, 0, 'tp', '{}'::jsonb, '[]'::jsonb, '{}'::jsonb, $5,
               now() - make_interval(secs => $6))`,
      [id, input.engagementId, `dsh-${id}`, input.phase ?? 'intelligence-gathering', input.status, input.ageSeconds ?? 0],
    );
    return id;
  }

  /** 造一条未结算的工具执行。 */
  async function newRunningToolRun(input: {
    engagementId: string;
    workerSessionId: string;
    ageSeconds?: number;
  }): Promise<string> {
    const id = randomUUID();
    await pool.query(
      `insert into pentest.tool_runs
         (id, engagement_id, worker_session_id, idempotency_key, tool_name, action_class,
          arguments_json, policy_decision, status, started_at)
       values ($1::uuid, $2::uuid, $3::uuid, $4, 'pentest_exec', 'passive_collection',
               '{}'::jsonb, '{}'::jsonb, 'running', now() - make_interval(secs => $5))`,
      [id, input.engagementId, input.workerSessionId, `run-${id}`, input.ageSeconds ?? 0],
    );
    return id;
  }

  /** 签发租约（可指定是否已过期）。 */
  async function newLease(input: {
    engagementId: string;
    workerSessionId: string;
    expired: boolean;
  }): Promise<void> {
    await pool.query(
      `insert into pentest.session_leases (engagement_id, worker_session_id, generation, expires_at)
       values ($1::uuid, $2::uuid, 1, now() + make_interval(secs => $3))`,
      [input.engagementId, input.workerSessionId, input.expired ? -3600 : 3600],
    );
  }

  function recovery(over: {
    probe?: (id: string) => Promise<boolean>;
    withLedger?: boolean;
  } = {}) {
    const d = db();
    const ledger = new MemoryLedger({
      db: d,
      txDb: d,
      secret: 'recovery-test-secret-32-bytes-minimum',
    });
    return new StartupRecovery({
      db: d,
      txDb: d,
      leases: new PgLeaseStore(pool),
      ...(over.withLedger === false ? {} : { ledger }),
      ...(over.probe === undefined ? {} : { probeDshSession: over.probe }),
    });
  }

  // ─────────────── 无主判定 ───────────────

  test('租约有效 → 不碰（那是另一个实例在正常驱动）', async () => {
    const engagementId = await newEngagement();
    const sessionId = await newSession({ engagementId, status: 'active' });
    await newLease({ engagementId, workerSessionId: sessionId, expired: false });

    const r = recovery();
    const unowned = await r.findUnownedSessions();
    assert.equal(
      unowned.some((s) => s.worker_session_id === sessionId),
      false,
      '租约有效的会话必须被排除——§10.6 里租约就是「我活着」的信号',
    );
  });

  test('租约过期 → 判为无主', async () => {
    const engagementId = await newEngagement();
    const sessionId = await newSession({ engagementId, status: 'active' });
    await newLease({ engagementId, workerSessionId: sessionId, expired: true });

    const unowned = await recovery().findUnownedSessions();
    assert.ok(unowned.some((s) => s.worker_session_id === sessionId));
  });

  test('存活会话没有租约 → 判为孤儿（不该发生，但按无主处理）', async () => {
    const engagementId = await newEngagement();
    const sessionId = await newSession({ engagementId, status: 'active' });

    const unowned = await recovery().findUnownedSessions();
    assert.ok(
      unowned.some((s) => s.worker_session_id === sessionId),
      '存活会话没有租约是异常状态，按孤儿处理比放着不管好',
    );
  });

  test('超龄的 starting 会话 → 判为无主（创建窗口没走完）', async () => {
    const engagementId = await newEngagement();
    const staleId = await newSession({
      engagementId,
      status: 'starting',
      ageSeconds: STALE_CREATION_SECONDS + 60,
    });
    // 即便租约还有效也判无主：创建是秒级动作，久留必有异常
    await newLease({ engagementId, workerSessionId: staleId, expired: false });

    const unowned = await recovery().findUnownedSessions();
    assert.ok(
      unowned.some((s) => s.worker_session_id === staleId),
      '超龄 starting 必须被恢复——否则 engagement 永远卡在半创建状态',
    );
  });

  test('刚创建的 starting 会话 → 不碰（可能是另一实例正在创建中）', async () => {
    const engagementId = await newEngagement();
    const fresh = await newSession({ engagementId, status: 'starting', ageSeconds: 1 });
    await newLease({ engagementId, workerSessionId: fresh, expired: false });

    const unowned = await recovery().findUnownedSessions();
    assert.equal(
      unowned.some((s) => s.worker_session_id === fresh),
      false,
      '刚创建的会话必须留出创建窗口，避免打断另一个实例',
    );
  });

  // ─────────────── 应用动作 ───────────────

  test('无主会话 → 标记为 failed（已中断），并写 status_reason 与 ended_at', async () => {
    const engagementId = await newEngagement();
    const sessionId = await newSession({ engagementId, status: 'active' });
    await newLease({ engagementId, workerSessionId: sessionId, expired: true });

    const report = await recovery().recoverAll();
    assert.ok(report.sessionsMarkedInterrupted.includes(sessionId));

    const row = await pool.query<{ status: string; status_reason: string; ended_at: string | null }>(
      `select status, status_reason, ended_at from pentest.worker_sessions where id = $1::uuid`,
      [sessionId],
    );
    assert.equal(row.rows[0]!.status, 'failed');
    assert.match(String(row.rows[0]!.status_reason), /已中断/);
    assert.notEqual(row.rows[0]!.ended_at, null, '终态必须与 ended_at 同批写入（002 的结算列约束）');
  });

  test('标记为已中断时吊销租约（其下放行凭证随之失效，§10.6）', async () => {
    const engagementId = await newEngagement();
    const sessionId = await newSession({ engagementId, status: 'active' });
    await newLease({ engagementId, workerSessionId: sessionId, expired: true });

    await recovery().recoverAll();

    const lease = await pool.query<{ revoked_at: string | null; revoked_reason: string | null }>(
      `select revoked_at, revoked_reason from pentest.session_leases where worker_session_id = $1::uuid`,
      [sessionId],
    );
    assert.notEqual(lease.rows[0]!.revoked_at, null, '租约必须被吊销——否则过期凭证会被当成有效');
    assert.equal(lease.rows[0]!.revoked_reason, 'failed');
  });

  test('遗留工具执行 → 标记为 unknown（终态，不自动重放）', async () => {
    const engagementId = await newEngagement();
    const sessionId = await newSession({ engagementId, status: 'active' });
    await newLease({ engagementId, workerSessionId: sessionId, expired: true });
    const runId = await newRunningToolRun({
      engagementId,
      workerSessionId: sessionId,
      ageSeconds: STALE_TOOL_RUN_SECONDS + 60,
    });

    const report = await recovery().recoverAll();
    assert.ok(report.toolRunsMarkedUnknown.includes(runId));

    const row = await pool.query<{ status: string; finished_at: string | null; result_json: { recovery?: string } }>(
      `select status, finished_at, result_json from pentest.tool_runs where id = $1::uuid`,
      [runId],
    );
    assert.equal(row.rows[0]!.status, 'unknown', '副作用是否已作用于目标未知——unknown 如实表达这一点');
    assert.notEqual(row.rows[0]!.finished_at, null, '结算列必须同批写入');
    assert.equal(row.rows[0]!.result_json.recovery, 'marked_unknown');
  });

  test('未超龄的工具执行 → 不动它（沙箱单次执行可达 15 分钟）', async () => {
    const engagementId = await newEngagement();
    const sessionId = await newSession({ engagementId, status: 'active' });
    await newLease({ engagementId, workerSessionId: sessionId, expired: true });
    const runId = await newRunningToolRun({ engagementId, workerSessionId: sessionId, ageSeconds: 30 });

    await recovery().recoverAll();

    const row = await pool.query<{ status: string }>(
      `select status from pentest.tool_runs where id = $1::uuid`,
      [runId],
    );
    assert.equal(row.rows[0]!.status, 'running', '不能把仍在正常执行的工具判为遗留');
  });

  test('高危阶段（利用验证）+ 无主会话 → 只阻塞 engagement，**不动会话**', async () => {
    const engagementId = await newEngagement();
    const sessionId = await newSession({ engagementId, status: 'active', phase: 'exploitation' });
    await newLease({ engagementId, workerSessionId: sessionId, expired: true });

    const report = await recovery().recoverAll();
    assert.ok(report.engagementsBlocked.includes(engagementId));
    assert.ok(report.needsHumanReconfirmation.some((x) => x.workerSessionId === sessionId));

    // 会话保持原状：让人类在控制台看着它决定
    const row = await pool.query<{ status: string }>(
      `select status from pentest.worker_sessions where id = $1::uuid`,
      [sessionId],
    );
    assert.equal(
      row.rows[0]!.status,
      'active',
      '高危阶段的会话必须保持原状交人类判断——自动终止可能掩盖未清理的现场',
    );

    const eng = await pool.query<{ status: string; current_status: string }>(
      `select status, current_status from pentest.engagements where id = $1::uuid`,
      [engagementId],
    );
    assert.equal(eng.rows[0]!.status, 'blocked', 'engagement 必须阻塞，等人类处置');
    assert.equal(
      eng.rows[0]!.current_status,
      'worker_running',
      '只改运行标记，主状态如实反映「上次停在哪」（§5.1 两层状态表）',
    );
  });

  test('后渗透阶段同样需要人类重新确认', async () => {
    const engagementId = await newEngagement();
    const sessionId = await newSession({ engagementId, status: 'active', phase: 'post-exploitation' });
    await newLease({ engagementId, workerSessionId: sessionId, expired: true });

    const report = await recovery().recoverAll();
    assert.ok(report.needsHumanReconfirmation.some((x) => x.workerSessionId === sessionId));
    assert.ok(report.engagementsBlocked.includes(engagementId));
  });

  test('等待人工判断的会话：报告它可继续，不做任何数据库改动', async () => {
    const engagementId = await newEngagement();
    const sessionId = await newSession({ engagementId, status: 'waiting_human' });
    await newLease({ engagementId, workerSessionId: sessionId, expired: true });

    const report = await recovery().recoverAll();
    assert.equal(report.sessionsMarkedInterrupted.includes(sessionId), false);
    assert.equal(report.engagementsBlocked.includes(engagementId), false);

    const row = await pool.query<{ status: string }>(
      `select status from pentest.worker_sessions where id = $1::uuid`,
      [sessionId],
    );
    assert.equal(row.rows[0]!.status, 'waiting_human', '它本来就在等人，崩溃不改变这一点');
  });

  test('等待人工判断 + 有遗留工具执行：必须阻塞（未知副作用需人工核查），并点明原因', async () => {
    const engagementId = await newEngagement();
    const sessionId = await newSession({ engagementId, status: 'waiting_human' });
    await newLease({ engagementId, workerSessionId: sessionId, expired: true });
    await newRunningToolRun({
      engagementId,
      workerSessionId: sessionId,
      ageSeconds: STALE_TOOL_RUN_SECONDS + 60,
    });

    const events: Array<{ engagementId: string; action: string; detail: string }> = [];
    const r = new StartupRecovery({
      db: db(),
      txDb: db(),
      leases: new PgLeaseStore(pool),
      onRecovered: (e) => events.push({ engagementId: e.engagementId, action: e.action, detail: e.detail }),
    });
    const report = await r.recoverAll();
    // **有未知副作用即阻塞**：§15.2 要求人工核查，而自动重放与继续推进都不安全。
    // 阻塞只是运行标记（主状态不变），人类可用 `resume` 带理由解除。
    assert.ok(
      report.engagementsBlocked.includes(engagementId),
      '存在未结算的工具执行时必须阻塞——那是唯一能让「副作用未知」不被忽略的机制',
    );
    // 会话本身仍是等待人工判断：他本来就在等人，阻塞的是 engagement 而非会话
    const resumeEvent = events.find((e) => e.engagementId === engagementId && e.action === 'resume');
    assert.ok(resumeEvent !== undefined, '会话不该被终止');
    assert.match(resumeEvent.detail, /副作用未知/, '未知副作用必须在会话结论里点明');
    assert.match(resumeEvent.detail, /请人工核查/);
  });

  // ─────────────── 幂等 ───────────────

  test('幂等：连跑两次不重复动作', async () => {
    const engagementId = await newEngagement();
    const sessionId = await newSession({ engagementId, status: 'active' });
    await newLease({ engagementId, workerSessionId: sessionId, expired: true });

    const r = recovery();
    const first = await r.recoverAll();
    assert.ok(first.sessionsMarkedInterrupted.includes(sessionId));

    const second = await r.recoverAll();
    assert.equal(
      second.sessionsMarkedInterrupted.includes(sessionId),
      false,
      '第二次不得重复标记——会话已是终态，不再是「无主存活会话」',
    );

    // 审计事件也不重复（幂等键派生自事件类型与主体）
    const events = await pool.query<{ n: string }>(
      `select count(*)::text as n from pentest.context_events
        where engagement_id = $1::uuid and event_type = 'session.reconciled'`,
      [engagementId],
    );
    assert.equal(events.rows[0]!.n, '1', '重复对账不得在链上留下重复条目');
  });

  test('幂等：工具执行二次标记不产生额外行', async () => {
    const engagementId = await newEngagement();
    const sessionId = await newSession({ engagementId, status: 'active' });
    await newLease({ engagementId, workerSessionId: sessionId, expired: true });
    await newRunningToolRun({
      engagementId,
      workerSessionId: sessionId,
      ageSeconds: STALE_TOOL_RUN_SECONDS + 60,
    });

    const r = recovery();
    const first = await r.recoverAll();
    assert.equal(first.toolRunsMarkedUnknown.length, 1);
    const second = await r.recoverAll();
    assert.equal(second.toolRunsMarkedUnknown.length, 0, 'unknown 是终态，不会被二次标记');
  });

  // ─────────────── 探测缺省 ───────────────

  test('探测缺省：保守判为不可达（不假装会话还活着）', async () => {
    const engagementId = await newEngagement();
    const sessionId = await newSession({ engagementId, status: 'active' });
    await newLease({ engagementId, workerSessionId: sessionId, expired: true });

    const events: string[] = [];
    const r = new StartupRecovery({
      db: db(),
      txDb: db(),
      leases: new PgLeaseStore(pool),
      onRecovered: (e) => events.push(e.action),
    });
    await r.recoverAll();
    assert.ok(
      events.includes('mark_interrupted'),
      '缺省探测判为不可达 → 会话按已中断处置（dsh 侧重启后会话本就可能不存在）',
    );
  });

  test('探测成功 + 存活且可达 → 不动它', async () => {
    const engagementId = await newEngagement();
    const sessionId = await newSession({ engagementId, status: 'active' });
    await newLease({ engagementId, workerSessionId: sessionId, expired: true });

    const events: Array<{ engagementId: string; action: string }> = [];
    const r = new StartupRecovery({
      db: db(),
      txDb: db(),
      leases: new PgLeaseStore(pool),
      probeDshSession: async () => true,
      onRecovered: (e) => events.push({ engagementId: e.engagementId, action: e.action }),
    });
    const report = await r.recoverAll();
    assert.equal(
      report.sessionsMarkedInterrupted.includes(sessionId),
      false,
      '可达且存活不应被终止——§15.2 的恢复路径本就是「dsh 恢复会话，插件对账」',
    );
    // 按 engagement 过滤：全局扫描会带上其他测试的残留
    const mine = events.filter((e) => e.engagementId === engagementId);
    assert.deepEqual(mine.map((e) => e.action), ['resume']);
  });

  // ─────────────── 报告 ───────────────

  test('报告按 engagement 聚合，且列出需人工确认的项', async () => {
    const a = await newEngagement();
    const b = await newEngagement();
    const sa = await newSession({ engagementId: a, status: 'active' });
    const sb = await newSession({ engagementId: b, status: 'active', phase: 'exploitation' });
    await newLease({ engagementId: a, workerSessionId: sa, expired: true });
    await newLease({ engagementId: b, workerSessionId: sb, expired: true });

    const report = await recovery().recoverAll();
    assert.ok(report.engagements.includes(a));
    assert.ok(report.engagements.includes(b));
    assert.equal(report.errors.length, 0);
    // 同样按 engagement 过滤：全局扫描会带上其他测试的残留
    const mine = report.needsHumanReconfirmation.filter((x) => x.engagementId === b);
    assert.equal(mine.length, 1, `B 应恰好产生一条需人工确认项，实际 ${mine.length}`);
    assert.equal(mine[0]!.phase, 'exploitation');
  });

  test('recoverEngagement：只处理指定 engagement', async () => {
    const a = await newEngagement();
    const b = await newEngagement();
    const sa = await newSession({ engagementId: a, status: 'active' });
    const sb = await newSession({ engagementId: b, status: 'active' });
    await newLease({ engagementId: a, workerSessionId: sa, expired: true });
    await newLease({ engagementId: b, workerSessionId: sb, expired: true });

    const report = await recovery().recoverEngagement(a);
    assert.ok(report.sessionsMarkedInterrupted.includes(sa));
    assert.equal(report.sessionsMarkedInterrupted.includes(sb), false, '不得越界处理别的 engagement');

    const other = await pool.query<{ status: string }>(
      `select status from pentest.worker_sessions where id = $1::uuid`,
      [sb],
    );
    assert.equal(other.rows[0]!.status, 'active', 'B 的会话应保持原状');
  });

  test('无残留时：报告为空且不报错', async () => {
    const report = await recovery().recoverAll();
    // 可能有别的测试遗留，但至少不应报错
    assert.equal(report.errors.length, 0);
  });

  test('不写审计（ledger 省略）时仍能恢复——降级是明确的', async () => {
    const engagementId = await newEngagement();
    const sessionId = await newSession({ engagementId, status: 'active' });
    await newLease({ engagementId, workerSessionId: sessionId, expired: true });

    const r = recovery({ withLedger: false });
    const report = await r.recoverAll();
    assert.ok(report.sessionsMarkedInterrupted.includes(sessionId), '会话状态仍被修正');

    const events = await pool.query<{ n: string }>(
      `select count(*)::text as n from pentest.context_events
        where engagement_id = $1::uuid and source_system = 'pentest-recovery'`,
      [engagementId],
    );
    assert.equal(events.rows[0]!.n, '0', '未配账本时不写审计——这是明确降级，不是静默失败');
  });

  // ───────── 悬空态结算：重做之后作业悬空、按钮不可达（2026-10-11 外部缺陷报告）─────────

  /**
   * 造出报告里的现场：主状态 `worker_running`、唯一会话已终态 `failed`、运行标记 `blocked`，
   * 且存在一条把主状态推进到 `worker_running` 的转移 `waiting_human_review → worker_running`
   * （基础夹具里它同时也是最后一条转移 ⇒ **正例不区分新旧锚点**，区分由 aborted / 无锚点两条反例承担）。
   */
  async function seedDangling(input: {
    readonly liveSession?: boolean;
    /** 运行标记，默认 `blocked`（报告现场的形态）。`aborted` 用来验"终止过的不结算"。 */
    readonly runMarker?: string;
    /** 不写"进入 worker_running"的那次转移（用来验"没有锚点就不结算"）。 */
    readonly skipAnchor?: boolean;
    /** 追加一条 `worker_running → worker_running` 的空转移（终止就是这么记的）。 */
    readonly abortNoop?: boolean;
  }): Promise<{ engagementId: string; deadSessionId: string; stateVersion: number }> {
    const engagementId = await newEngagement();
    const deadSessionId = await newSession({
      engagementId,
      status: input.liveSession === true ? 'active' : 'failed',
    });
    const decision = await pool.query<{ id: string }>(
      `insert into pentest.human_decisions
         (engagement_id, operator_id, decision_type, subject_id, decision, reason, auth_context)
       values ($1::uuid, 'tester', 'retry', $2, 'reuse_session', '外部报告现场：重做', '{}'::jsonb)
       returning id`,
      [engagementId, deadSessionId],
    );
    if (input.skipAnchor !== true) {
      await pool.query(
        `insert into pentest.state_transitions
           (engagement_id, from_status, to_status, transition_type, session_reused, expected_version,
            resulting_version, human_decision_id, reason)
         values ($1::uuid, 'waiting_human_review', 'worker_running', 'retry', true, 15, 16, $2::uuid, '重做')`,
        [engagementId, decision.rows[0]?.id],
      );
    }
    if (input.abortNoop === true) {
      await pool.query(
        `insert into pentest.state_transitions
           (engagement_id, from_status, to_status, transition_type, session_reused, expected_version,
            resulting_version, human_decision_id, reason)
         values ($1::uuid, 'worker_running', 'worker_running', 'abort', false, 16, 17, $2::uuid, '终止')`,
        [engagementId, decision.rows[0]?.id],
      );
    }
    // 版本与最后一条转移的 resulting_version 对齐（夹具也要自洽：不然将来读它会误判）
    const lastVersion = input.abortNoop === true ? 17 : 16;
    await pool.query(
      `update pentest.engagements
          set current_status = 'worker_running', status = $3,
              state_version = $4, active_agent_session_id = $2::uuid
        where id = $1::uuid`,
      [engagementId, deadSessionId, input.runMarker ?? 'blocked', lastVersion],
    );
    return { engagementId, deadSessionId, stateVersion: lastVersion };
  }

  test('悬空态结算：主状态 worker_running + 没有活会话 ⇒ 回滚到进入 worker_running 的那次转移的 from_status', async () => {
    const { engagementId, stateVersion } = await seedDangling({});

    const report = await recovery().recoverEngagement(engagementId);

    assert.deepEqual(
      report.danglingSettled,
      [{ engagementId, rolledBackTo: 'waiting_human_review' }],
      '结算必须出现在报告里（静默把状态按回去，人类会以为是自己变的）',
    );
    const after = await pool.query(
      `select current_status, status, state_version, active_agent_session_id
         from pentest.engagements where id = $1::uuid`,
      [engagementId],
    );
    const row = after.rows[0] as {
      current_status: string;
      status: string;
      state_version: string | number;
      active_agent_session_id: string | null;
    };
    assert.equal(row.current_status, 'waiting_human_review', '主状态回到转移前的状态（不是猜的，来自 from_status）');
    assert.equal(row.active_agent_session_id, null, '活动会话指针必须清空（它还指着那个死会话）');
    assert.equal(Number(row.state_version), stateVersion + 1, '版本推进一格（登记在 NON_TRANSITION_VERSION_BUMPS）');
    assert.equal(row.status, 'blocked', '运行标记保持 blocked（那是「等人类处置」的如实标记）');
    // 结算必须**在账本里留痕**（2026-10-11 质检）：这条事件的唯一用途就是解释那次回滚，
    // 少了它，负例的"一个字都没写"断言也没有对照。
    const events = await pool.query<{ n: number; rolled: string | null }>(
      `select count(*)::int as n, max(payload_json->>'rolledBackTo') as rolled
         from pentest.context_events
        where engagement_id = $1::uuid and event_type = 'workflow.dangling_running_settled'`,
      [engagementId],
    );
    assert.equal(Number(events.rows[0]?.n ?? -1), 1, '结算必须在账本里留下可检索的痕迹');
    assert.equal(events.rows[0]?.rolled, 'waiting_human_review', 'payload 要带 rolledBackTo');
  });

  test('悬空态结算不误伤：还有活会话时**不动**主状态', async () => {
    const { engagementId, deadSessionId } = await seedDangling({ liveSession: true });
    // **必须带一个有效租约**：没有租约的会话在对账眼里就是"没人驱动的残留"，会被判中断 ——
    // 那样作业确实变成悬空态，结算反而是对的（第一版夹具就栽在这里）。生产里正常在跑的会话
    // 必然持有租约，所以这一条才是"不误伤"的正确形态。
    await newLease({ engagementId, workerSessionId: deadSessionId, expired: false });

    const report = await recovery().recoverEngagement(engagementId);

    assert.deepEqual(report.danglingSettled, [], '还有 active 会话 ⇒ 不是悬空态');
    const after = await pool.query(
      `select current_status, active_agent_session_id from pentest.engagements where id = $1::uuid`,
      [engagementId],
    );
    const row = after.rows[0] as { current_status: string; active_agent_session_id: string | null };
    assert.equal(row.current_status, 'worker_running', '正常在跑的作业不得被按回上一态');
    assert.notEqual(row.active_agent_session_id, null, '活动会话指针不得被清空');
  });

  test('悬空态结算不碰"终止过"的作业：运行标记 aborted ⇒ 不结算、不写事件', async () => {
    // 真库现场（2026-10-11 自纠，个人库里 8 条）：最后一条转移是 `worker_running → worker_running`
    //（type=abort，人类按了「终止」）——运行已经结束，出路是归档与清空，不是把主状态回滚。
    // 第一版没看运行标记，于是这 8 条被"结算"成空操作：事件写了、版本进了、状态一动没动。
    const { engagementId, deadSessionId, stateVersion } = await seedDangling({
      runMarker: 'aborted',
      abortNoop: true,
    });

    const report = await recovery().recoverEngagement(engagementId);

    assert.deepEqual(report.danglingSettled, [], '终止过的作业不进结算');
    const after = await pool.query(
      `select current_status, state_version, active_agent_session_id
         from pentest.engagements where id = $1::uuid`,
      [engagementId],
    );
    const row = after.rows[0] as {
      current_status: string;
      state_version: string | number;
      active_agent_session_id: string | null;
    };
    assert.equal(row.current_status, 'worker_running', '主状态不得被动（终止是人类的决定）');
    assert.equal(Number(row.state_version), stateVersion, '版本不得推进');
    assert.equal(row.active_agent_session_id, deadSessionId, '指针不得被清空');
    const events = await pool.query<{ n: number }>(
      `select count(*)::int as n from pentest.context_events
        where engagement_id = $1::uuid and event_type = 'workflow.dangling_running_settled'`,
      [engagementId],
    );
    assert.equal(Number(events.rows[0]?.n ?? -1), 0, '什么都不动 ⇒ 一个字都不许写进账本');
  });

  test('悬空态结算要有落点：没有"进入 worker_running"的转移 ⇒ 不结算、不写事件', async () => {
    // 只有终止那种空转移（from_status = to_status）时，照它回滚就是原地踏步 ⇒ 正确行为是**不结算**：
    // 结算 SQL 的 update 不命中 ⇒ 返回零行 ⇒ 调用方连事件都不写（运行标记这里给 blocked，
    // 保证挡住它的只可能是"没有锚点"这一条）。
    const { engagementId, deadSessionId, stateVersion } = await seedDangling({
      skipAnchor: true,
      abortNoop: true,
    });

    const report = await recovery().recoverEngagement(engagementId);

    assert.deepEqual(report.danglingSettled, [], '没有可回滚的落点 ⇒ 不结算');
    const after = await pool.query(
      `select current_status, state_version, active_agent_session_id
         from pentest.engagements where id = $1::uuid`,
      [engagementId],
    );
    const row = after.rows[0] as {
      current_status: string;
      state_version: string | number;
      active_agent_session_id: string | null;
    };
    assert.equal(row.current_status, 'worker_running', '主状态不得被动');
    assert.equal(Number(row.state_version), stateVersion, '版本不得推进');
    assert.equal(row.active_agent_session_id, deadSessionId, '指针不得被清空');
    const events = await pool.query<{ n: number }>(
      `select count(*)::int as n from pentest.context_events
        where engagement_id = $1::uuid and event_type = 'workflow.dangling_running_settled'`,
      [engagementId],
    );
    assert.equal(Number(events.rows[0]?.n ?? -1), 0, '没结算就不许写结算事件');
  });

  test('启动对账按作业补扫：有锚点且没有活会话 ⇒ 进报告；有活会话 ⇒ 不进', async () => {
    // 这条同时锁**接线**与**候选守卫**（2026-10-11 质检）：测试工厂不传 rlsScope，走的正是
    // `#recover` 的无作用域分支——第一版那条分支提前返回，`recoverAll` 从不结算（而
    // `recoverEngagement` 会），两个入口行为不一致且没有任何用例能发现。
    const dangling = await seedDangling({});
    const guarded = await seedDangling({ liveSession: true });
    await newLease({ engagementId: guarded.engagementId, workerSessionId: guarded.deadSessionId, expired: false });

    const report = await recovery().recoverAll();

    assert.deepEqual(
      report.danglingSettled.filter((x) => x.engagementId === dangling.engagementId),
      [{ engagementId: dangling.engagementId, rolledBackTo: 'waiting_human_review' }],
      '按作业扫描必须能把报告场景扫出来（按无主会话驱动会一条都扫不到）',
    );
    assert.equal(
      report.danglingSettled.some((x) => x.engagementId === guarded.engagementId),
      false,
      '候选必须排除还有活会话的作业（否则会把正常在跑的作业按回上一态）',
    );
  });

  test('结算只在主状态是 worker_running 时：别的主状态 + 有锚点 + 没有活会话 ⇒ 不结算', async () => {
    // 守卫①的**行为**锁（2026-10-11 质检）：四个现场的主状态全是 worker_running，
    // 于是把 `current_status = 'worker_running'` 放宽/删掉不会有任何用例变红——而它会去改
    // `report_ready`/`waiting_human_review` 这些**别的主状态**。
    const { engagementId, deadSessionId, stateVersion } = await seedDangling({});
    await pool.query(
      `update pentest.engagements set current_status = 'report_ready' where id = $1::uuid`,
      [engagementId],
    );

    const report = await recovery().recoverEngagement(engagementId);

    assert.deepEqual(report.danglingSettled, [], '主状态不是 worker_running ⇒ 不在本规则内');
    const after = await pool.query(
      `select current_status, state_version, active_agent_session_id
         from pentest.engagements where id = $1::uuid`,
      [engagementId],
    );
    const row = after.rows[0] as {
      current_status: string;
      state_version: string | number;
      active_agent_session_id: string | null;
    };
    assert.equal(row.current_status, 'report_ready', '别的主状态不得被按回 worker_running 的历史落点');
    assert.equal(Number(row.state_version), stateVersion, '版本不得推进');
    assert.equal(row.active_agent_session_id, deadSessionId, '指针不得被清空');
  });
});

