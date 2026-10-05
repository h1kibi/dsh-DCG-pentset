/**
 * `PgLeaseStore`（租约存储的 PostgreSQL 装配层）集成测试（设计文档 §10.6）。
 *
 * 本文件的全部用例都跑在真实 PostgreSQL 上（设置 `PENTEST_DATABASE_URL` 时启用），
 * 因为这一层要验证的恰恰是假实现无法模拟的东西：
 *   - 部分唯一索引 `session_leases_one_active`（`WHERE revoked_at IS NULL`）；
 *   - `UNIQUE (worker_session_id, generation)`；
 *   - `revoked_reason` 的 CHECK 取值域；
 *   - `SELECT ... FOR UPDATE` 的真实行锁；
 *   - 002 启用的 RLS 与非所有者运行时角色。
 * 纯逻辑（判定顺序、取值域、并发语义）由 `test/lease.test.ts` 的假 DB 覆盖，两者不重复。
 *
 * 迁移由 Main 统一执行；这里只确认所需对象已就位。
 */

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, it, test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { Pool, type PoolClient } from 'pg';

import type { LeaseRevocationReason } from '../src/contracts.ts';
import type { DbClient } from '../src/db/port.ts';
import {
  LeaseProtocolError,
  expireLeases,
  issueLease,
  reissueLease,
  renewLease,
  revokeLease,
  validateLeaseForOperation,
} from '../src/workflow/lease.ts';
import { PgLeaseStore } from '../src/workflow/pg-lease.ts';
import { assertNoResidue, cleanupEngagements } from './helpers/cleanup.ts';

const DATABASE_URL = process.env['PENTEST_DATABASE_URL'];

// ───────────────────────────── 共享库清理夹具 ─────────────────────────────
//
// 这些集成用例跑在**共享**数据库上，且与兄弟测试文件并行：compose.test.ts 里的 `apply()`
// 会触发 `StartupRecovery.recoverAll()`（对账是**全库扫描**），为本文件刚建、尚未心跳的
// 会话补写审计行（context_events / ledger_anchors / outbox_jobs）；那些行通过外键把
// `worker_sessions` 钉住，而 §9.5 的追加写触发器又拒绝 DELETE 事件行。
//
// 清理方式（同一条连接上临时切 replica 角色 → 按依赖倒序删 → 立刻切回 origin）此前在
// 这里有一份**本地副本**，与 `test/helpers/cleanup.ts` 的共享实现重复。两份清单漂移过：
// 共享那份曾漏掉 `request_snapshots`（有外键指回 engagements，漏了会让「删作业」抛 23503），
// 本地这份则少了后来新增的几张表。2026-10-05 复核（REQ-12）统一到共享夹具，
// 并新增 `test/cleanup-fixture.test.ts` 的「清单 vs schema」自检，防止再漏。

// ───────────────────────────── 测试工具 ─────────────────────────────

/** `pg` 错误对象里我们真正当契约用的字段：SQLSTATE 与约束/索引名（不解析 message 文本）。 */
interface PgErrorLike {
  readonly code?: string;
  readonly constraint?: string;
  readonly name?: string;
  readonly message?: string;
}

/** 运行一段会失败的 SQL/调用并取回错误；成功则返回 null。 */
async function captureError(run: () => Promise<unknown>): Promise<PgErrorLike | null> {
  try {
    await run();
    return null;
  } catch (error: unknown) {
    return error as PgErrorLike;
  }
}

interface LeaseRowView {
  readonly generation: number;
  readonly task_ref: string | null;
  readonly issued_at: Date;
  readonly expires_at: Date;
  readonly last_heartbeat_at: Date;
  readonly revoked_at: Date | null;
  readonly revoked_reason: string | null;
}

const T0 = new Date('2026-03-01T00:00:00.000Z');
const T1 = new Date('2026-03-01T00:05:00.000Z');
const TENANT = 'pg-lease-test';

describe(
  '集成：真实 PostgreSQL',
  { skip: DATABASE_URL === undefined ? '未设置 PENTEST_DATABASE_URL' : false },
  () => {
    let pool: Pool;
    let store: PgLeaseStore;
    let engagementId = '';

    /**
     * 真实 `worker_sessions` 行：租约的 `worker_session_id` 是带外键的 uuid 列，不能造假串。
     *
     * 默认用**非存活**状态 `closed`：§9.3 的存活会话索引
     * （`worker_sessions_one_live_per_engagement`，谓词覆盖 starting/active/waiting_human/
     * handoff_drafting/transition_confirmation/paused/blocked）允许一个 engagement 同时只有
     * 一个存活会话，而本文件需要多个互不干扰的会话夹具。租约端口不看会话状态
     * （§10.6：续租只看租约自身），`lockWorkerSession` 只取会话行的 engagement，因此
     * `closed` 会话足以驱动全部用例；存活会话的真实路径由第一个用例单独覆盖。
     */
    async function createSession(live = false): Promise<string> {
      const id = randomUUID();
      await pool.query(
        `insert into pentest.worker_sessions
           (id, engagement_id, dsh_session_id, phase, profile_id, profile_revision,
            task_prompt, tool_filter, skill_ids, model_route, status)
         values ($1, $2, $3, 'intelligence-gathering', 'p', 'r1', 'tp',
                 '{}'::jsonb, '[]'::jsonb, '{}'::jsonb, $4)`,
        [id, engagementId, `dsh-${id}`, live ? 'active' : 'closed'],
      );
      return id;
    }

    async function leaseRows(workerSessionId: string): Promise<readonly LeaseRowView[]> {
      const result = await pool.query<LeaseRowView>(
        `select generation, task_ref, issued_at, expires_at, last_heartbeat_at,
                revoked_at, revoked_reason
           from pentest.session_leases
          where worker_session_id = $1
          order by generation`,
        [workerSessionId],
      );
      return result.rows;
    }

    before(async () => {
      pool = new Pool({ connectionString: DATABASE_URL });
      // 对象由迁移建立（test/db.test.ts 覆盖迁移器本身）；缺表时在这里给出明确信号，
      // 而不是让每个用例各自报一句 "relation does not exist"。
      await pool.query('select 1 from pentest.session_leases limit 0');
      await pool.query('select 1 from pentest.worker_sessions limit 0');
      store = new PgLeaseStore(pool as unknown as DbClient);
      engagementId = randomUUID();
      await pool.query(
        `insert into pentest.engagements
           (id, tenant_id, name, status, current_status, target_snapshot, scope_snapshot,
            roe_snapshot, policy_snapshot, config_snapshot, created_by)
         values ($1, $2, 'pg-lease-integration', 'running', 'ready', '{}'::jsonb, '{}'::jsonb,
                 '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, 'node-test')`,
        [engagementId, TENANT],
      );
    });

    after(async () => {
      // 共享夹具（`test/helpers/cleanup.ts`）：临时切 replica 角色绕过追加写触发器与外键，
      // 删完立刻切回；失败直接冒泡，不吞错。`assertNoResidue` 把「清理是否真的生效」
      // 变成断言，而不是靠人工查库。
      await cleanupEngagements(pool, [engagementId]);
      await assertNoResidue(pool, [engagementId]);
      await pool.end();
    });

    it('签发落库并可读回：世代、任务绑定、TTL、未吊销状态', async () => {
      const workerSessionId = await createSession(true);

      // 未显式给 taskRef：会话行不提供默认任务绑定（真实 schema 无此列），因此租约为无绑定
      const anonymous = await issueLease(store, { workerSessionId, now: T0, ttlSeconds: 120 });
      assert.equal(anonymous.generation, 1);
      assert.equal(anonymous.taskRef, null);
      assert.equal(anonymous.revokedAt, null);
      assert.equal(anonymous.expiresAt.toISOString(), '2026-03-01T00:02:00.000Z');

      const active = await store.transaction((tx) => tx.selectActiveLease(workerSessionId));
      assert.deepEqual(active, anonymous, '读回的行必须与签发返回值逐字段一致');
      assert.deepEqual(
        await store.transaction((tx) => tx.selectLease(workerSessionId, 1)),
        anonymous,
      );
      assert.equal(await store.transaction((tx) => tx.selectLease(workerSessionId, 2)), null);
      assert.equal(await store.transaction((tx) => tx.maxGeneration(workerSessionId)), 1);

      // 锁会话行：真实会话返回行（engagement 来自库），未知会话返回 null
      assert.deepEqual(await store.transaction((tx) => tx.lockWorkerSession(workerSessionId)), {
        id: workerSessionId,
        engagementId,
        taskRef: null,
      });
      assert.equal(await store.transaction((tx) => tx.lockWorkerSession(randomUUID())), null);
      const fresh = await createSession();
      assert.equal(
        await store.transaction((tx) => tx.maxGeneration(fresh)),
        0,
        '从未签发过的会话最大世代是 0',
      );

      // 显式 taskRef 会被写进库（跨任务提权防护的依据）；now 必须早于旧租约到期，
      // 否则重做复用会被 lease.ts 判为"到期不能记 superseded"
      const bound = await reissueLease(store, {
        workerSessionId,
        now: new Date(T0.getTime() + 30_000),
        taskRef: 'task-A',
      });
      assert.equal(bound.lease.taskRef, 'task-A');
      const rows = await leaseRows(workerSessionId);
      assert.deepEqual(
        rows.map((r) => [r.generation, r.task_ref, r.revoked_reason]),
        [
          [1, null, 'superseded'],
          [2, 'task-A', null],
        ],
      );
      assert.ok(rows[0]?.revoked_at !== null, '吊销必须写入 revoked_at，与理由成对（§9.5）');
    });

    it('并发签发：FOR UPDATE 串行化同一会话，部分唯一索引拦住绕过端口的写入', async () => {
      const contended = await createSession();
      // 绕过端口的写入（人工 SQL、其它模块）只能靠索引拦：generation 用 2，
      // 使冲突必然落在 session_leases_one_active 上而不是 generation 唯一约束上
      await issueLease(store, { workerSessionId: contended, now: T0 });
      const bypass = await captureError(() =>
        pool.query(
          `insert into pentest.session_leases (engagement_id, worker_session_id, generation, expires_at)
           values ($1, $2, 2, $3)`,
          [engagementId, contended, new Date(T0.getTime() + 60_000)],
        ),
      );
      assert.equal(bypass?.code, '23505', '第二条未吊销租约必须被唯一索引拒绝');
      assert.equal(bypass?.constraint, 'session_leases_one_active');

      const workerSessionId = await createSession();
      const holder = await pool.connect();
      const contender = await pool.connect();
      try {
        const holderStore = new PgLeaseStore(holder as unknown as DbClient);
        const contenderStore = new PgLeaseStore(contender as unknown as DbClient);

        let locked!: () => void;
        const lockTaken = new Promise<void>((resolve) => {
          locked = resolve;
        });
        let openGate!: () => void;
        const gate = new Promise<void>((resolve) => {
          openGate = resolve;
        });

        // A：拿住会话行锁，插入未吊销租约，然后保持事务打开
        const winner = holderStore.transaction(async (tx) => {
          assert.notEqual(await tx.lockWorkerSession(workerSessionId), null);
          locked();
          await gate;
          await tx.insertLease({
            id: randomUUID(),
            engagementId,
            workerSessionId,
            taskRef: null,
            generation: 1,
            issuedAt: T0,
            expiresAt: new Date(T0.getTime() + 600_000),
            lastHeartbeatAt: T0,
          });
        });
        await lockTaken;

        // B：同一会话的签发必须被行锁挡住，而不是立刻撞唯一索引
        let settled = false;
        const contenderResult = issueLease(contenderStore, { workerSessionId, now: T1 }).finally(
          () => {
            settled = true;
          },
        );
        await delay(200);
        assert.equal(settled, false, '并发签发必须被 SELECT ... FOR UPDATE 阻塞');

        openGate();
        await winner;
        // A 提交后 B 才拿到锁；此时它看到的是"已有未吊销租约"这一确定性协议错误
        const rejection = await captureError(() => contenderResult);
        assert.equal(rejection?.name, 'LeaseProtocolError');
        assert.match(String(rejection?.message), /reissueLease/);
        assert.equal(
          rejection?.constraint,
          undefined,
          '串行化生效时不应让并发方撞唯一索引',
        );

        const rows = await leaseRows(workerSessionId);
        assert.deepEqual(
          rows.map((r) => [r.generation, r.revoked_reason]),
          [[1, null]],
          '失败的签发不得留下任何行',
        );
      } finally {
        await holder.query('rollback');
        await contender.query('rollback');
        holder.release();
        contender.release();
      }
    });

    it('重做复用：先吊销后签发在同一事务内成功，陈旧世代提交被拒', async () => {
      const workerSessionId = await createSession();
      const first = await issueLease(store, {
        workerSessionId,
        now: T0,
        ttlSeconds: 600,
        taskRef: 'task-A',
      });
      const outcome = await reissueLease(store, { workerSessionId, now: T1 });
      assert.deepEqual(outcome.revokedLeaseIds, [first.id]);
      assert.equal(outcome.lease.generation, 2);
      assert.equal(outcome.lease.taskRef, 'task-A', '重做复用不得丢失任务绑定');

      const rows = await leaseRows(workerSessionId);
      assert.deepEqual(
        rows.map((r) => [r.generation, r.revoked_reason]),
        [
          [1, 'superseded'],
          [2, null],
        ],
      );
      assert.equal(
        rows.filter((r) => r.revoked_at === null).length,
        1,
        'session_leases_one_active 只允许一行未吊销',
      );

      // 世代语义：旧世代提交被拒，新世代通过（真实行上验证，非假 DB）
      const stale = await validateLeaseForOperation(store, {
        workerSessionId,
        generation: 1,
        operation: 'submit_report',
        now: T1,
      });
      assert.equal(stale.ok, false);
      if (!stale.ok) assert.equal(stale.code, 'lease_generation_stale');
      const fresh = await validateLeaseForOperation(store, {
        workerSessionId,
        generation: 2,
        operation: 'submit_report',
        now: T1,
        taskRef: 'task-A',
      });
      assert.equal(fresh.ok, true);

      // 到期后按 superseded 记录是审计错误：必须被拒（理由已到期）
      const expiredSession = await createSession();
      const expiredLease = await issueLease(store, {
        workerSessionId: expiredSession,
        now: T0,
        ttlSeconds: 60,
      });
      await assert.rejects(
        reissueLease(store, {
          workerSessionId: expiredSession,
          now: new Date(expiredLease.expiresAt.getTime()),
        }),
        (error: unknown) => error instanceof LeaseProtocolError,
      );
    });

    it('顺序颠倒（先签发后吊销）撞部分唯一索引，且整个事务回滚', async () => {
      const workerSessionId = await createSession();
      const other = await createSession();
      await issueLease(store, { workerSessionId, now: T0 });
      await issueLease(store, { workerSessionId: other, now: T0 });

      const conflict = await captureError(() =>
        store.transaction(async (tx) => {
          // 同一事务里先做一次会成功的写入：回滚必须把它一并撤销，
          // 否则"回滚"只是失败语句自己没生效，而不是事务原子性
          await tx.revokeActiveLeases({ workerSessionId: other, reason: 'closed', revokedAt: T1 });
          await tx.insertLease({
            id: randomUUID(),
            engagementId,
            workerSessionId,
            taskRef: null,
            generation: 2,
            issuedAt: T1,
            expiresAt: new Date(T1.getTime() + 600_000),
            lastHeartbeatAt: T1,
          });
        }),
      );
      assert.equal(conflict?.code, '23505');
      assert.equal(conflict?.constraint, 'session_leases_one_active');

      // 回滚证据一：另一会话的吊销被撤销
      const stillActive = await store.transaction((tx) => tx.selectActiveLease(other));
      assert.notEqual(stillActive, null, '同一事务里先成功的写入也必须被回滚');
      assert.equal(stillActive?.revokedAt, null);
      // 回滚证据二：本会话仍只有世代 1，且未被吊销
      const rows = await leaseRows(workerSessionId);
      assert.deepEqual(
        rows.map((r) => [r.generation, r.revoked_reason]),
        [[1, null]],
      );
    });

    it('UNIQUE (worker_session_id, generation) 真正生效：吊销释放槽位但世代号不可复用', async () => {
      const workerSessionId = await createSession();
      const lease = await issueLease(store, { workerSessionId, now: T0 });
      // expectGeneration 分支（4 个绑定参数）与无期望世代分支的 SQL 形状不同，两条都要走
      const stale = await store.transaction((tx) =>
        tx.revokeActiveLeases({
          workerSessionId,
          reason: 'human_revoke',
          revokedAt: T1,
          expectGeneration: 2,
        }),
      );
      assert.deepEqual(stale, [], '期望世代不符时吊销 0 行，不误伤当前世代');
      const revoked = await revokeLease(store, {
        workerSessionId,
        reason: 'human_revoke',
        now: T1,
        expectGeneration: lease.generation,
      });
      if (!revoked.ok) assert.fail(revoked.message);
      assert.deepEqual(revoked.value.revokedLeaseIds, [lease.id]);

      const raw = await captureError(() =>
        pool.query(
          `insert into pentest.session_leases (engagement_id, worker_session_id, generation, expires_at)
           values ($1, $2, 1, $3)`,
          [engagementId, workerSessionId, new Date(T1.getTime() + 60_000)],
        ),
      );
      assert.equal(raw?.code, '23505');
      assert.equal(raw?.constraint, 'session_leases_worker_session_id_generation_key');

      // 端口不吞冲突：insertLease 必须把唯一约束违例原样抛出
      const viaPort = await captureError(() =>
        store.transaction((tx) =>
          tx.insertLease({
            id: randomUUID(),
            engagementId,
            workerSessionId,
            taskRef: null,
            generation: 1,
            issuedAt: T1,
            expiresAt: new Date(T1.getTime() + 60_000),
            lastHeartbeatAt: T1,
          }),
        ),
      );
      assert.equal(viaPort?.code, '23505');
      assert.equal(viaPort?.constraint, 'session_leases_worker_session_id_generation_key');

      // 世代推进后可以签发（§18.1「吊销后可签发新租约」）
      const next = await issueLease(store, { workerSessionId, now: T1 });
      assert.equal(next.generation, 2);
    });

    it('到期清扫：闭区间谓词写入 revoked_reason=expired 并释放部分唯一索引槽位', async () => {
      const workerSessionId = await createSession();
      const lease = await issueLease(store, { workerSessionId, now: T0, ttlSeconds: 60 });
      // 恰好到期（expires_at === now）即失效：谓词是闭区间 expires_at <= now
      const boundary = new Date(lease.expiresAt.getTime());

      const outcome = await expireLeases(store, { now: boundary });
      assert.deepEqual(
        outcome.expiredLeases.filter((ref) => ref.workerSessionId === workerSessionId),
        [{ leaseId: lease.id, workerSessionId, expiresAt: boundary }],
      );
      const rows = await leaseRows(workerSessionId);
      assert.equal(rows[0]?.revoked_reason, 'expired', '理由由端口固定写入，不接受调用方传入');
      assert.equal(rows[0]?.revoked_at?.toISOString(), boundary.toISOString());

      // 槽位释放：到期未续的行本来会永久占着 session_leases_one_active
      const next = await issueLease(store, { workerSessionId, now: boundary });
      assert.equal(next.generation, 2);

      // 幂等：再扫一次，本会话没有新的到期未吊销行
      const again = await expireLeases(store, { now: boundary });
      assert.deepEqual(
        again.expiredLeases.filter((ref) => ref.workerSessionId === workerSessionId),
        [],
      );
      assert.equal((await leaseRows(workerSessionId)).length, 2);
    });

    it("budget_exhausted 被拒绝：端口取值域与数据库 CHECK 两层都拦（暂停不吊销）", async () => {
      const workerSessionId = await createSession();
      const lease = await issueLease(store, { workerSessionId, now: T0, ttlSeconds: 600 });

      const rejection = await captureError(() =>
        store.transaction((tx) =>
          tx.revokeActiveLeases({
            workerSessionId,
            reason: 'budget_exhausted' as LeaseRevocationReason,
            revokedAt: T1,
          }),
        ),
      );
      assert.equal(rejection?.name, 'LeaseProtocolError');
      assert.match(String(rejection?.message), /budget_exhausted/);
      assert.equal(rejection?.code, undefined, '端口在发 SQL 前拒绝，不是 SQLSTATE');
      // 端口拒绝后库里没有任何变化
      assert.equal(
        (await store.transaction((tx) => tx.selectActiveLease(workerSessionId)))?.id,
        lease.id,
      );

      // 绕过端口直接写库：001 的 CHECK 是第二道闸
      const dbRejection = await captureError(() =>
        pool.query(
          `update pentest.session_leases
              set revoked_at = $2, revoked_reason = 'budget_exhausted'
            where worker_session_id = $1 and revoked_at is null`,
          [workerSessionId, T1],
        ),
      );
      assert.equal(dbRejection?.code, '23514', 'CHECK 违例（check_violation）');
      assert.match(String(dbRejection?.constraint), /revoked_reason/);
      const rows = await leaseRows(workerSessionId);
      assert.equal(rows[0]?.revoked_at, null, '两层拒绝都不得留下半截吊销');
      assert.equal(rows[0]?.revoked_reason, null);
    });

    it('心跳续租：前推 expires_at 与 last_heartbeat_at，冻结列不动，到期后不可续', async () => {
      const workerSessionId = await createSession();
      const lease = await issueLease(store, { workerSessionId, now: T0, ttlSeconds: 60 });
      const beatAt = new Date(T0.getTime() + 30_000);

      const renewed = await renewLease(store, {
        workerSessionId,
        generation: lease.generation,
        now: beatAt,
        ttlSeconds: 90,
      });
      if (!renewed.ok) assert.fail(`续租被拒绝：${renewed.code} ${renewed.message}`);

      const rows = await leaseRows(workerSessionId);
      assert.equal(
        rows[0]?.expires_at.toISOString(),
        new Date(beatAt.getTime() + 90_000).toISOString(),
      );
      assert.equal(rows[0]?.last_heartbeat_at.toISOString(), beatAt.toISOString());
      assert.equal(
        rows[0]?.issued_at.toISOString(),
        T0.toISOString(),
        '续租不得改写签发时间（§9.5 冻结列）',
      );

      // 到期即失效：判定由 lease.ts 负责，这里验证真实行上不产生任何写入
      const late = await renewLease(store, {
        workerSessionId,
        generation: lease.generation,
        now: new Date(renewed.value.expiresAt.getTime()),
        ttlSeconds: 90,
      });
      assert.equal(late.ok, false);
      if (!late.ok) assert.equal(late.code, 'lease_expired');
      const afterLate = await leaseRows(workerSessionId);
      assert.equal(afterLate[0]?.last_heartbeat_at.toISOString(), beatAt.toISOString());
      assert.equal(afterLate[0]?.expires_at.toISOString(), rows[0]?.expires_at.toISOString());

      // 续租不能凭空成立：命中 0 行时必须响亮失败，而不是返回一个库里并不存在的到期时间
      await assert.rejects(
        store.transaction((tx) =>
          tx.touchHeartbeat({
            leaseId: randomUUID(),
            expiresAt: new Date(beatAt.getTime() + 90_000),
            heartbeatAt: beatAt,
          }),
        ),
        (error: unknown) => error instanceof LeaseProtocolError,
      );
    });

    it('lockWorkerSession 锁的是 worker_sessions 行：同会话的租约行仍可被其它连接取行锁', async () => {
      const workerSessionId = await createSession();
      await issueLease(store, { workerSessionId, now: T0, ttlSeconds: 600 });

      const holder = await pool.connect();
      const prober = await pool.connect();
      try {
        const holderStore = new PgLeaseStore(holder as unknown as DbClient);
        let locked!: () => void;
        const lockTaken = new Promise<void>((resolve) => {
          locked = resolve;
        });
        let openGate!: () => void;
        const gate = new Promise<void>((resolve) => {
          openGate = resolve;
        });

        const holding = holderStore.transaction(async (tx) => {
          assert.notEqual(await tx.lockWorkerSession(workerSessionId), null);
          locked();
          await gate;
        });
        await lockTaken;

        // 会话行被锁：NOWAIT 立刻失败（55P03 lock_not_available）
        const onSessionRow = await captureError(() =>
          prober.query('select id from pentest.worker_sessions where id = $1 for update nowait', [
            workerSessionId,
          ]),
        );
        assert.equal(onSessionRow?.code, '55P03', '会话行必须真的被 FOR UPDATE 锁住');

        // 同一会话的租约行没有被锁：这条 FOR UPDATE 正常返回
        const onLeaseRow = await prober.query<{ id: string }>(
          'select id from pentest.session_leases where worker_session_id = $1 for update nowait',
          [workerSessionId],
        );
        assert.equal(onLeaseRow.rows.length, 1, '锁的范围只到会话行，不波及租约行');

        openGate();
        await holding;
      } finally {
        await holder.query('rollback');
        holder.release();
        prober.release();
      }
    });

    it('RLS：pentest_app 未设上下文即 fail-closed，设上下文后可完成重做复用（吊销 + 签发）', async () => {
      const workerSessionId = await createSession();
      const first = await issueLease(store, { workerSessionId, now: T0, ttlSeconds: 600 });

      const client: PoolClient = await pool.connect();
      try {
        await client.query('set role pentest_app');

        // 未设 pentest.engagement_id：策略比较结果为 NULL，看不见任何行（§9.4 fail-closed）
        const blind = new PgLeaseStore(client as unknown as DbClient);
        assert.equal(await blind.transaction((tx) => tx.selectActiveLease(workerSessionId)), null);
        assert.equal(await blind.transaction((tx) => tx.maxGeneration(workerSessionId)), 0);

        // 设上下文后同一行可见，且真实运行时角色能走完吊销 + 签发
        const scoped = new PgLeaseStore(client as unknown as DbClient, {
          rlsContext: { tenantId: TENANT, engagementId },
        });
        const visible = await scoped.transaction((tx) => tx.selectActiveLease(workerSessionId));
        assert.equal(visible?.id, first.id);
        const outcome = await reissueLease(scoped, { workerSessionId, now: T1 });
        assert.deepEqual(outcome.revokedLeaseIds, [first.id]);
        assert.equal(outcome.lease.generation, 2);

        // 清扫是跨会话的 UPDATE ... RETURNING：RLS 下同样只影响本 engagement
        const swept = await scoped.transaction((tx) =>
          tx.revokeExpiredLeases(new Date(T1.getTime() + 3_600_000)),
        );
        assert.deepEqual(
          swept.filter((ref) => ref.workerSessionId === workerSessionId),
          [{ leaseId: outcome.lease.id, workerSessionId, expiresAt: outcome.lease.expiresAt }],
        );
      } finally {
        // 先回滚再复位角色：角色未复位时连接回池会带着租户上下文（静默的跨租户可见）。
        // 两条都不吞错——失败就是失败，测试该红（2026-10-05 复核 REQ-12）。
        await client.query('rollback');
        await client.query('reset role');
        client.release();
      }
    });
  },
);

// ───────────────────────────── 事务作用域解析（不依赖数据库） ─────────────────────────────
//
// 用假连接断言 `PgLeaseStore.transaction` 把作用域翻译成 RLS 上下文的方式。
// 事故背景（2026-10-05）：清扫在租户级上下文里跑，UPDATE 影响 0 行且不报错——
// 过期行永久占槽。作用域必须显式给，缺了要响亮失败而不是静默落回租户级。

test('事务作用域：显式作业直接落上下文；配了会话反查却缺作用域必须响亮失败', async () => {
  const queries: Array<{ sql: string; params: readonly unknown[] | undefined }> = [];
  let workCalls = 0;
  const fakeClient = {
    async query(sql: string, params?: readonly unknown[]) {
      queries.push({ sql, params });
      return { rows: [], rowCount: 0 };
    },
  };
  const store = new PgLeaseStore(fakeClient as unknown as DbClient, {
    rlsContext: { tenantId: 'tenant-1', engagementId: null },
    rlsContextForSession: async (workerSessionId: string) => ({
      tenantId: 'tenant-1',
      engagementId: `eng-${workerSessionId}`,
    }),
  });

  await store.transaction(async () => { workCalls += 1; }, { engagementId: 'eng-explicit' });
  assert.deepEqual(
    queries.find((entry) => entry.sql.includes('set_rls_context'))?.params,
    ['tenant-1', 'eng-explicit'],
    '显式作业必须原样落进 RLS 上下文',
  );

  queries.length = 0;
  await store.transaction(async () => { workCalls += 1; }, 'session-9');
  assert.deepEqual(
    queries.find((entry) => entry.sql.includes('set_rls_context'))?.params,
    ['tenant-1', 'eng-session-9'],
    '会话作用域仍按会话反查作业',
  );
  assert.equal(workCalls, 2);

  await assert.rejects(
    () => store.transaction(async () => { workCalls += 1; }),
    /缺少 RLS 作用域/u,
    '配了会话反查却没有作用域：必须响亮失败，而不是静默落回租户级',
  );
  assert.equal(workCalls, 2, '缺作用域时事务体不得执行');
});
