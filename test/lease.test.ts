/**
 * 会话租约与提交准入测试（设计文档 §10.6）。
 *
 * 假 DB 按 `pentest.session_leases` 的 DDL 语义实现，包括两条唯一约束：
 *   - `UNIQUE (worker_session_id, generation)`
 *   - `session_leases_one_active`：`UNIQUE (worker_session_id) WHERE revoked_at IS NULL`
 * 因此"先签发后吊销"这类顺序错误会在这里被真实拒绝，并且事务回滚可被断言。
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import type {
  LeaseRevocationReason,
  SessionLease,
  SessionStatus,
} from '../src/contracts.ts';
import { DEFAULTS, LEASE_REQUIRED_OPERATIONS, LIVE_SESSION_STATUSES } from '../src/contracts.ts';
import type { LeaseStore, LeaseTx, NewLeaseRow, RevokeActiveLeasesInput, WorkerSessionRow } from '../src/workflow/lease.ts';
import {
  applySessionStatusChange,
  assertLeaseValid,
  describeLease,
  isLeaseExpired,
  isLeaseRequiredOperation,
  isLeaseRevocationReason,
  issueLease,
  expireLeases,
  leaseDispositionForSessionStatus,
  reissueLease,
  renewLease,
  revokeLease,
  validateLeaseForOperation,
  LeaseProtocolError,
} from '../src/workflow/lease.ts';
import type { ExpiredLeaseRef } from '../src/workflow/lease.ts';

// ───────────────────────────── 假 DB ─────────────────────────────

interface FakeLeaseRow {
  id: string;
  engagementId: string;
  workerSessionId: string;
  taskRef: string | null;
  generation: number;
  issuedAt: Date;
  expiresAt: Date;
  lastHeartbeatAt: Date;
  revokedAt: Date | null;
  revokedReason: LeaseRevocationReason | null;
}

interface Statement {
  readonly op: string;
  readonly args: Record<string, unknown>;
}

function cloneRow(row: FakeLeaseRow): FakeLeaseRow {
  return {
    ...row,
    issuedAt: new Date(row.issuedAt),
    expiresAt: new Date(row.expiresAt),
    lastHeartbeatAt: new Date(row.lastHeartbeatAt),
    revokedAt: row.revokedAt === null ? null : new Date(row.revokedAt),
  };
}

function toLease(row: FakeLeaseRow): SessionLease {
  return {
    id: row.id,
    workerSessionId: row.workerSessionId,
    taskRef: row.taskRef,
    generation: row.generation,
    expiresAt: new Date(row.expiresAt),
    revokedAt: row.revokedAt === null ? null : new Date(row.revokedAt),
    revokedReason: row.revokedReason,
  };
}

class FakeLeaseDatabase implements LeaseStore, LeaseTx {
  readonly sessions = new Map<string, WorkerSessionRow>();
  readonly rows: FakeLeaseRow[] = [];
  /** 语句级审计：用于断言吊销与签发的相对顺序。 */
  readonly statements: Statement[] = [];
  transactionCount = 0;

  transaction<T>(work: (tx: LeaseTx) => Promise<T>): Promise<T> {
    this.transactionCount += 1;
    const snapshot = this.rows.map(cloneRow);
    return work(this).catch((error: unknown) => {
      this.rows.length = 0;
      this.rows.push(...snapshot);
      throw error;
    });
  }

  async lockWorkerSession(workerSessionId: string): Promise<WorkerSessionRow | null> {
    this.statements.push({ op: 'lockWorkerSession', args: { workerSessionId } });
    return this.sessions.get(workerSessionId) ?? null;
  }

  async selectActiveLease(workerSessionId: string): Promise<SessionLease | null> {
    this.statements.push({ op: 'selectActiveLease', args: { workerSessionId } });
    const row = this.rows.find((r) => r.workerSessionId === workerSessionId && r.revokedAt === null);
    return row === undefined ? null : toLease(row);
  }

  /**
   * 到期清扫：把 `expiresAt <= now && revokedAt === null` 的行标记为 `expired`。
   * 真实 SQL 由 `session_leases_expiry` 索引驱动扫描；这里按同一谓词遍历假行集合，
   * 因此"到期行仍占槽位"这件事在假 DB 上也会真实发生。
   */
  async revokeExpiredLeases(now: Date): Promise<readonly ExpiredLeaseRef[]> {
    this.statements.push({ op: 'revokeExpiredLeases', args: { now: now.toISOString() } });
    const expired: ExpiredLeaseRef[] = [];
    for (const row of this.rows) {
      if (row.revokedAt !== null) continue;
      if (row.expiresAt.getTime() > now.getTime()) continue;
      row.revokedAt = now;
      row.revokedReason = 'expired';
      expired.push({ leaseId: row.id, workerSessionId: row.workerSessionId, expiresAt: row.expiresAt });
    }
    return expired;
  }

  async selectLease(workerSessionId: string, generation: number): Promise<SessionLease | null> {
    this.statements.push({ op: 'selectLease', args: { workerSessionId, generation } });
    const row = this.rows.find(
      (r) => r.workerSessionId === workerSessionId && r.generation === generation,
    );
    return row === undefined ? null : toLease(row);
  }

  async maxGeneration(workerSessionId: string): Promise<number> {
    this.statements.push({ op: 'maxGeneration', args: { workerSessionId } });
    const generations = this.rows
      .filter((r) => r.workerSessionId === workerSessionId)
      .map((r) => r.generation);
    return generations.length === 0 ? 0 : Math.max(...generations);
  }

  async insertLease(row: NewLeaseRow): Promise<void> {
    this.statements.push({ op: 'insertLease', args: { ...row } });
    const sameGeneration = this.rows.some(
      (r) => r.workerSessionId === row.workerSessionId && r.generation === row.generation,
    );
    if (sameGeneration) {
      throw new Error(
        'duplicate key value violates unique constraint "session_leases_worker_session_id_generation_key"',
      );
    }
    const active = this.rows.some(
      (r) => r.workerSessionId === row.workerSessionId && r.revokedAt === null,
    );
    if (active) {
      throw new Error('duplicate key value violates unique index "session_leases_one_active"');
    }
    this.rows.push({
      id: row.id,
      engagementId: row.engagementId,
      workerSessionId: row.workerSessionId,
      taskRef: row.taskRef,
      generation: row.generation,
      issuedAt: new Date(row.issuedAt),
      expiresAt: new Date(row.expiresAt),
      lastHeartbeatAt: new Date(row.lastHeartbeatAt),
      revokedAt: null,
      revokedReason: null,
    });
  }

  async revokeActiveLeases(input: RevokeActiveLeasesInput): Promise<readonly string[]> {
    this.statements.push({ op: 'revokeActiveLeases', args: { ...input } });
    const active = this.rows.find(
      (r) => r.workerSessionId === input.workerSessionId && r.revokedAt === null,
    );
    if (active === undefined) return [];
    if (input.expectGeneration !== undefined && active.generation !== input.expectGeneration) {
      return [];
    }
    const revoked: string[] = [];
    for (const row of this.rows) {
      if (row.workerSessionId !== input.workerSessionId || row.revokedAt !== null) continue;
      row.revokedAt = new Date(input.revokedAt);
      row.revokedReason = input.reason;
      revoked.push(row.id);
    }
    return revoked;
  }

  async touchHeartbeat(input: {
    readonly leaseId: string;
    readonly expiresAt: Date;
    readonly heartbeatAt: Date;
  }): Promise<void> {
    this.statements.push({ op: 'touchHeartbeat', args: { ...input } });
    const row = this.rows.find((r) => r.id === input.leaseId);
    if (row === undefined) throw new Error(`touchHeartbeat：租约不存在 ${input.leaseId}`);
    row.expiresAt = new Date(input.expiresAt);
    row.lastHeartbeatAt = new Date(input.heartbeatAt);
  }

  rowFor(workerSessionId: string, generation: number): FakeLeaseRow {
    const row = this.rows.find(
      (r) => r.workerSessionId === workerSessionId && r.generation === generation,
    );
    assert.ok(row !== undefined, `未找到租约 ${workerSessionId}/${generation}`);
    return row;
  }

  activeRow(workerSessionId: string): FakeLeaseRow {
    const row = this.rows.find(
      (r) => r.workerSessionId === workerSessionId && r.revokedAt === null,
    );
    assert.ok(row !== undefined, `会话 ${workerSessionId} 没有未吊销租约`);
    return row;
  }

  activeCount(workerSessionId: string): number {
    return this.rows.filter((r) => r.workerSessionId === workerSessionId && r.revokedAt === null)
      .length;
  }

  ops(): readonly string[] {
    return this.statements.map((s) => s.op);
  }
}

const NOW = new Date('2026-09-19T00:00:00.000Z');
const TTL_MS = DEFAULTS.leaseTtlSeconds * 1000;

function harness(): { db: FakeLeaseDatabase; store: LeaseStore } {
  const db = new FakeLeaseDatabase();
  db.sessions.set('s1', { id: 's1', engagementId: 'eng-1', taskRef: 'task-A' });
  db.sessions.set('s2', { id: 's2', engagementId: 'eng-1', taskRef: 'task-B' });
  return { db, store: db };
}

/** 大多数用例的前置：会话 s1 已持有世代 1 的租约。 */
async function seedGen1(store: LeaseStore): Promise<SessionLease> {
  return issueLease(store, { workerSessionId: 's1', now: NOW, leaseId: 'lease-g1' });
}

// ───────────────────────────── 谓词与处置表 ─────────────────────────────

test('吊销理由取值域：含 expired（清扫驱动），不含 budget_exhausted（暂停保留租约）', () => {
  for (const reason of ['superseded', 'closed', 'failed', 'human_revoke', 'expired']) {
    assert.equal(isLeaseRevocationReason(reason), true, reason);
  }
  // budget_exhausted 必须不合法：预算耗尽只是暂停，租约保留，
  // 否则一次预算追加会静默作废该会话全部待用放行凭证（§10.6）。
  for (const reason of ['budget_exhausted', 'paused', '', undefined, 1]) {
    assert.equal(isLeaseRevocationReason(reason), false, String(reason));
  }
});

test('需要持租约的操作由契约固定为提交/放行/执行/草稿四种', () => {
  assert.deepEqual([...LEASE_REQUIRED_OPERATIONS], [
    'submit_report',
    'request_approval',
    'execute',
    'draft_handoff',
  ]);
  for (const op of LEASE_REQUIRED_OPERATIONS) assert.equal(isLeaseRequiredOperation(op), true, op);
  assert.equal(isLeaseRequiredOperation('interject_wake'), false);
  assert.equal(isLeaseRequiredOperation('start'), false);
});

test('会话状态到租约处置：存活态（含 paused/blocked）保留，终态吊销', () => {
  for (const status of LIVE_SESSION_STATUSES) {
    assert.deepEqual(leaseDispositionForSessionStatus(status), { action: 'keep' }, status);
  }
  const terminal: readonly (readonly [SessionStatus, LeaseRevocationReason])[] = [
    ['superseded', 'superseded'],
    ['closed', 'closed'],
    ['failed', 'failed'],
  ];
  for (const [status, reason] of terminal) {
    assert.deepEqual(leaseDispositionForSessionStatus(status), { action: 'revoke', reason }, status);
  }
});

test('到期判定使用闭区间：到点即失效', () => {
  const lease: SessionLease = {
    id: 'l',
    workerSessionId: 's1',
    taskRef: null,
    generation: 1,
    expiresAt: new Date('2026-09-19T00:10:00.000Z'),
    revokedAt: null,
    revokedReason: null,
  };
  assert.equal(isLeaseExpired(lease, new Date('2026-09-19T00:09:59.999Z')), false);
  assert.equal(isLeaseExpired(lease, new Date('2026-09-19T00:10:00.000Z')), true);
  assert.equal(isLeaseExpired(lease, new Date('2026-09-19T00:10:00.001Z')), true);
});

// ───────────────────────────── 签发 ─────────────────────────────

test('签发租约：世代 1、TTL 取默认值、心跳时间戳同步写入', async () => {
  const { db, store } = harness();
  const lease = await seedGen1(store);

  assert.equal(lease.generation, 1);
  assert.equal(lease.workerSessionId, 's1');
  assert.equal(lease.taskRef, 'task-A');
  assert.equal(lease.revokedAt, null);
  assert.equal(lease.revokedReason, null);
  assert.equal(lease.expiresAt.toISOString(), new Date(NOW.getTime() + TTL_MS).toISOString());

  const row = db.rowFor('s1', 1);
  assert.equal(row.issuedAt.toISOString(), NOW.toISOString());
  assert.equal(row.lastHeartbeatAt.toISOString(), NOW.toISOString());
});

test('签发租约：taskRef 省略时取会话行绑定的任务，显式给出时以显式值签发', async () => {
  const { store } = harness();
  const fromSession = await issueLease(store, {
    workerSessionId: 's2',
    now: NOW,
    leaseId: 'lease-s2',
  });
  assert.equal(fromSession.taskRef, 'task-B', '省略时绑定会话行的任务');

  const explicit = await issueLease(store, {
    workerSessionId: 's1',
    taskRef: 'task-C',
    now: NOW,
    leaseId: 'lease-s1',
  });
  assert.equal(explicit.taskRef, 'task-C', '显式任务覆盖会话行的绑定');
});

test('签发租约：TTL 可覆盖，非法 TTL 是协议错误', async () => {
  const { store } = harness();
  const lease = await issueLease(store, { workerSessionId: 's1', now: NOW, ttlSeconds: 30 });
  assert.equal(lease.expiresAt.toISOString(), new Date(NOW.getTime() + 30_000).toISOString());
  await assert.rejects(
    issueLease(store, { workerSessionId: 's2', now: NOW, ttlSeconds: 0 }),
    LeaseProtocolError,
  );
});

test('签发租约：会话已持有未吊销租约时抛出协议错误，并带上操作名与租约状态', async () => {
  const { db, store } = harness();
  await seedGen1(store);

  await assert.rejects(seedGen1(store), (error: unknown) => {
    assert.ok(error instanceof LeaseProtocolError);
    assert.equal(error.operation, 'issue_lease');
    assert.equal(error.workerSessionId, 's1');
    assert.match(error.message, /reissueLease/);
    assert.match(error.leaseState ?? '', /世代 1/);
    return true;
  });
  assert.equal(db.rows.length, 1, '拒绝时不得产生第二行');
});

test('签发租约：会话不存在时抛出协议错误', async () => {
  const { store } = harness();
  await assert.rejects(issueLease(store, { workerSessionId: 'nope', now: NOW }), (error: unknown) => {
    assert.ok(error instanceof LeaseProtocolError);
    assert.equal(error.operation, 'issue_lease');
    return true;
  });
});

// ───────────────────────────── 重做复用：先吊销再签发 ─────────────────────────────

test('重做复用：先吊销旧世代再签发新世代，同一事务内完成', async () => {
  const { db, store } = harness();
  await seedGen1(store);
  db.statements.length = 0;
  db.transactionCount = 0;

  const outcome = await reissueLease(store, {
    workerSessionId: 's1',
    now: NOW,
    leaseId: 'lease-g2',
  });

  assert.deepEqual(outcome.revokedLeaseIds, ['lease-g1']);
  assert.equal(outcome.lease.generation, 2);
  assert.equal(outcome.lease.taskRef, 'task-A', '复用不得丢失任务绑定');
  assert.equal(db.transactionCount, 1, '吊销与签发必须在同一事务内');

  const ops = db.ops();
  assert.deepEqual(ops.slice(0, 2), ['lockWorkerSession', 'selectActiveLease']);
  assert.equal(ops.at(-1), 'insertLease');
  assert.ok(
    ops.indexOf('revokeActiveLeases') < ops.indexOf('insertLease'),
    '顺序固定为：先吊销旧世代，再插入新世代',
  );

  const old = db.rowFor('s1', 1);
  assert.equal(old.revokedAt?.toISOString(), NOW.toISOString());
  assert.equal(old.revokedReason, 'superseded');
  assert.equal(db.activeCount('s1'), 1, '部分唯一索引 session_leases_one_active 不得被违反');
  assert.equal(db.activeRow('s1').generation, 2);
});
test('重做复用：生命周期事件按 revoked 后 issued 顺序发送，事务 callback 不重复发送', async () => {
  const { db } = harness();
  const events: string[] = [];
  const store: LeaseStore = {
    transaction: db.transaction.bind(db),
    onLifecycleInTransaction: async (_tx, event) => { events.push(`tx:${event.type}`); },
    onLifecycle: (event) => { events.push(`post:${event.type}`); },
  };
  await issueLease(store, { workerSessionId: 's1', now: NOW, leaseId: 'lease-g1' });
  events.length = 0;
  await reissueLease(store, { workerSessionId: 's1', now: NOW, leaseId: 'lease-g2' });
  assert.deepEqual(events, ['tx:lease.revoked', 'tx:lease.issued']);
});

test('重做复用：事务生命周期审计失败时旧租约吊销与新租约签发整体回滚', async () => {
  const { db } = harness();
  await seedGen1(db);
  const before = db.rows.map(cloneRow);
  let calls = 0;
  const store: LeaseStore = {
    transaction: db.transaction.bind(db),
    onLifecycleInTransaction: async (_tx, event) => {
      calls += 1;
      if (event.type === 'lease.issued') throw new Error('reissue audit failed');
    },
  };
  await assert.rejects(
    reissueLease(store, { workerSessionId: 's1', now: NOW, leaseId: 'lease-g2' }),
    /reissue audit failed/,
  );
  assert.equal(calls, 2);
  assert.deepEqual(db.rows, before);
  assert.equal(db.activeRow('s1').id, 'lease-g1');
});
test('生命周期审计回调：事务内失败时租约变更与事件都回滚', async () => {
  const { db } = harness();
  const events: string[] = [];
  const store: LeaseStore = {
    transaction: db.transaction.bind(db),
    onLifecycleInTransaction: async (_tx, event) => {
      events.push(event.type);
      throw new Error('audit write failed');
    },
  };
  await assert.rejects(
    issueLease(store, { workerSessionId: 's1', now: NOW, leaseId: 'audit-failed' }),
    /audit write failed/,
  );
  assert.deepEqual(db.rows, [], '审计失败必须回滚租约 INSERT');
  assert.deepEqual(events, ['lease.issued']);
});

test('生命周期审计回调：事务提交后才收到提交后回调', async () => {
  const { db } = harness();
  const events: string[] = [];
  const store: LeaseStore = {
    transaction: db.transaction.bind(db),
    onLifecycle: (event) => { events.push(event.type); },
  };
  await issueLease(store, { workerSessionId: 's1', now: NOW, leaseId: 'audit-ok' });
  assert.deepEqual(events, ['lease.issued']);
  assert.equal(db.rowFor('s1', 1).id, 'audit-ok');
});

test('顺序颠倒（先插入后吊销）会撞 session_leases_one_active 并整体回滚', async () => {
  const { db, store } = harness();
  await seedGen1(store);
  const before = db.rows.map(cloneRow);

  await assert.rejects(
    db.transaction(async (tx) => {
      await tx.insertLease({
        id: 'lease-g2',
        engagementId: 'eng-1',
        workerSessionId: 's1',
        taskRef: 'task-A',
        generation: 2,
        issuedAt: NOW,
        expiresAt: new Date(NOW.getTime() + TTL_MS),
        lastHeartbeatAt: NOW,
      });
      await tx.revokeActiveLeases({
        workerSessionId: 's1',
        reason: 'superseded',
        revokedAt: NOW,
      });
    }),
    /session_leases_one_active/,
  );

  assert.deepEqual(db.rows, before, '事务回滚：旧租约仍是未吊销的世代 1');
  assert.equal(db.activeRow('s1').generation, 1);
});

test('租约继承会话的 engagement（session_leases.engagement_id 非空）', async () => {
  const { db, store } = harness();
  await seedGen1(store);
  assert.equal(db.rowFor('s1', 1).engagementId, 'eng-1');

  const outcome = await reissueLease(store, {
    workerSessionId: 's1',
    now: NOW,
    leaseId: 'lease-g2',
  });
  assert.equal(outcome.lease.generation, 2);
  assert.equal(db.rowFor('s1', 2).engagementId, 'eng-1', '新世代沿用同一 engagement');
});

test('重做复用后：旧世代在途提交被拒为 lease_generation_stale，新世代正常通过', async () => {
  const { store } = harness();
  await seedGen1(store);
  const outcome = await reissueLease(store, {
    workerSessionId: 's1',
    now: NOW,
    leaseId: 'lease-g2',
  });

  const stale = await validateLeaseForOperation(store, {
    workerSessionId: 's1',
    generation: 1,
    operation: 'submit_report',
    now: NOW,
  });
  assert.equal(stale.ok, false);
  assert.equal(stale.ok === false ? stale.code : null, 'lease_generation_stale');
  assert.match(stale.ok === false ? stale.message : '', /当前世代 2，请求世代 1/);

  const fresh = await validateLeaseForOperation(store, {
    workerSessionId: 's1',
    generation: outcome.lease.generation,
    operation: 'submit_report',
    now: NOW,
  });
  assert.equal(fresh.ok, true);
  assert.equal(fresh.ok === true ? fresh.value.id : null, 'lease-g2');
});

test('多次重做复用：世代逐次递增，任一旧世代都被判为滞后', async () => {
  const { db, store } = harness();
  await seedGen1(store);
  await reissueLease(store, { workerSessionId: 's1', now: NOW, leaseId: 'lease-g2' });
  await reissueLease(store, { workerSessionId: 's1', now: NOW, leaseId: 'lease-g3' });

  assert.equal(db.activeCount('s1'), 1);
  assert.equal(db.activeRow('s1').generation, 3);
  for (const generation of [1, 2]) {
    const result = await validateLeaseForOperation(store, {
      workerSessionId: 's1',
      generation,
      operation: 'execute',
      now: NOW,
    });
    assert.equal(result.ok === false ? result.code : null, 'lease_generation_stale', String(generation));
  }
  const current = await validateLeaseForOperation(store, {
    workerSessionId: 's1',
    generation: 3,
    operation: 'execute',
    now: NOW,
  });
  assert.equal(current.ok, true);
});

// ───────────────────────────── 续租 ─────────────────────────────

test('心跳续租：活动租约延长到期时间并写入心跳时间戳', async () => {
  const { db, store } = harness();
  await seedGen1(store);
  const later = new Date(NOW.getTime() + 60_000);

  const renewed = await renewLease(store, { workerSessionId: 's1', generation: 1, now: later });
  assert.equal(renewed.ok, true);
  const expected = new Date(later.getTime() + TTL_MS).toISOString();
  assert.equal(renewed.ok === true ? renewed.value.expiresAt.toISOString() : null, expected);

  const row = db.rowFor('s1', 1);
  assert.equal(row.expiresAt.toISOString(), expected);
  assert.equal(row.lastHeartbeatAt.toISOString(), later.toISOString());
  assert.equal(row.revokedAt, null, '续租不得改变吊销状态');
});

test('心跳续租：世代滞后被拒，不写心跳', async () => {
  const { db, store } = harness();
  await seedGen1(store);
  await reissueLease(store, {
    workerSessionId: 's1',
    now: NOW,
    leaseId: 'lease-g2',
  });
  const heartbeatAt = new Date(NOW.getTime() + 60_000);

  const stale = await renewLease(store, {
    workerSessionId: 's1',
    generation: 1,
    now: heartbeatAt,
  });
  assert.equal(stale.ok === false ? stale.code : null, 'lease_generation_stale');
  assert.deepEqual(db.ops().includes('touchHeartbeat'), false);

  const fresh = await renewLease(store, {
    workerSessionId: 's1',
    generation: 2,
    now: heartbeatAt,
  });
  assert.equal(fresh.ok, true);
});

test('心跳续租：租约已吊销时报 lease_revoked，而非世代滞后', async () => {
  const { store } = harness();
  await seedGen1(store);
  const closed = await applySessionStatusChange(store, {
    workerSessionId: 's1',
    status: 'closed',
    now: NOW,
  });
  assert.equal(closed.ok, true);

  const renewed = await renewLease(store, { workerSessionId: 's1', generation: 1, now: NOW });
  assert.equal(renewed.ok === false ? renewed.code : null, 'lease_revoked');
});

test('心跳续租：到期未续的租约不可续；清扫后按 expired 释放槽位并签发新租约', async () => {
  const { db, store } = harness();
  await seedGen1(store);
  const afterExpiry = new Date(NOW.getTime() + TTL_MS);

  // 1) 到期的租约不能续
  const renewed = await renewLease(store, { workerSessionId: 's1', generation: 1, now: afterExpiry });
  assert.equal(renewed.ok === false ? renewed.code : null, 'lease_expired');

  // 2) 到期行仍占着 session_leases_one_active —— 直接签发必须被拒
  await assert.rejects(
    issueLease(store, { workerSessionId: 's1', now: afterExpiry }),
    (error: unknown) => {
      assert.ok(error instanceof LeaseProtocolError);
      assert.match(error.message, /已到期但仍占用 session_leases_one_active/);
      return true;
    },
  );

  // 3) 清扫释放槽位，且理由必须是 expired（不能记成 superseded ——
  //    失联与有意替换在审计上含义不同）
  const swept = await expireLeases(store, { now: afterExpiry });
  assert.equal(swept.expiredLeases.length, 1);
  assert.equal(swept.expiredLeases[0]!.workerSessionId, 's1');
  assert.equal(db.rowFor('s1', 1).revokedReason, 'expired');
  assert.equal(db.activeCount('s1'), 0, '清扫后槽位必须释放');

  // 4) 清扫后才能签发新租约，且是新世代
  const issued = await issueLease(store, { workerSessionId: 's1', now: afterExpiry, leaseId: 'lease-g2' });
  assert.equal(issued.generation, 2, '新租约走新世代而不是复活旧行');
  assert.equal(
    issued.expiresAt.toISOString(),
    new Date(afterExpiry.getTime() + TTL_MS).toISOString(),
  );
  assert.equal(db.activeCount('s1'), 1);
});

test('心跳续租：没有租约的会话报 lease_required', async () => {
  const { store } = harness();
  const renewed = await renewLease(store, { workerSessionId: 's2', generation: 1, now: NOW });
  assert.equal(renewed.ok === false ? renewed.code : null, 'lease_required');
});

// ───────────────────────────── 吊销 ─────────────────────────────

test('吊销租约：写入吊销时间与理由', async () => {
  const { db, store } = harness();
  await seedGen1(store);
  const revoked = await revokeLease(store, {
    workerSessionId: 's1',
    reason: 'human_revoke',
    now: NOW,
  });

  assert.equal(revoked.ok, true);
  assert.deepEqual(revoked.ok === true ? revoked.value.revokedLeaseIds : [], ['lease-g1']);
  const row = db.rowFor('s1', 1);
  assert.equal(row.revokedAt?.toISOString(), NOW.toISOString());
  assert.equal(row.revokedReason, 'human_revoke');
});

test('吊销租约：已无生效租约时幂等返回空集合，不产生写入', async () => {
  const { db, store } = harness();
  await seedGen1(store);
  await revokeLease(store, { workerSessionId: 's1', reason: 'closed', now: NOW });
  db.statements.length = 0;

  const again = await revokeLease(store, { workerSessionId: 's1', reason: 'closed', now: NOW });
  assert.deepEqual(again.ok === true ? again.value.revokedLeaseIds : ['x'], []);
  assert.deepEqual(db.ops(), ['revokeActiveLeases'], '幂等路径只发一条 UPDATE，且影响 0 行');
});

test('吊销租约：期望世代不符时报 lease_generation_stale，不误吊销新世代', async () => {
  const { db, store } = harness();
  await seedGen1(store);
  await reissueLease(store, { workerSessionId: 's1', now: NOW, leaseId: 'lease-g2' });
  db.statements.length = 0;

  const stale = await revokeLease(store, {
    workerSessionId: 's1',
    reason: 'human_revoke',
    now: NOW,
    expectGeneration: 1,
  });
  assert.equal(stale.ok === false ? stale.code : null, 'lease_generation_stale');
  assert.deepEqual(db.ops(), ['selectActiveLease'], '拒绝前不执行任何写语句');
  assert.equal(db.activeRow('s1').generation, 2);
});

test('吊销租约：budget_exhausted 不是合法理由（暂停不吊销）', async () => {
  const { db, store } = harness();
  await seedGen1(store);
  db.statements.length = 0;

  await assert.rejects(
    revokeLease(store, {
      workerSessionId: 's1',
      reason: 'budget_exhausted' as LeaseRevocationReason,
      now: NOW,
    }),
    (error: unknown) => {
      assert.ok(error instanceof LeaseProtocolError);
      assert.equal(error.operation, 'revoke_lease');
      return true;
    },
  );
  assert.deepEqual(db.ops(), [], '非法理由不得落库');
  assert.equal(db.activeRow('s1').revokedAt, null, '租约必须保持未吊销');
});

// ───────────────────────────── 会话状态联动 ─────────────────────────────

test('暂停不吊销租约：保留且不产生任何写入与事务', async () => {
  const { db, store } = harness();
  await seedGen1(store);
  const before = db.rows.map(cloneRow);
  db.statements.length = 0;
  db.transactionCount = 0;

  const paused = await applySessionStatusChange(store, {
    workerSessionId: 's1',
    status: 'paused',
    now: NOW,
  });

  assert.deepEqual(paused.ok === true ? paused.value : null, {
    disposition: { action: 'keep' },
    revokedLeaseIds: [],
  });
  assert.equal(db.transactionCount, 0, '保留路径不得开启事务');
  assert.deepEqual(db.ops(), []);
  assert.deepEqual(db.rows, before, '暂停后租约逐字段不变（放行凭证因此不作废）');

  const stillUsable = await validateLeaseForOperation(store, {
    workerSessionId: 's1',
    generation: 1,
    operation: 'execute',
    now: NOW,
  });
  assert.equal(stillUsable.ok, true, '暂停期间租约仍可用于提交');
});

test('存活态全部保留租约：blocked 与 waiting_human 同样不吊销', async () => {
  for (const status of ['blocked', 'waiting_human', 'handoff_drafting'] as const) {
    const { db, store } = harness();
    await seedGen1(store);
    const result = await applySessionStatusChange(store, { workerSessionId: 's1', status, now: NOW });
    assert.deepEqual(result.ok === true ? result.value.revokedLeaseIds : null, [], status);
    assert.equal(db.activeCount('s1'), 1, status);
  }
});

test('会话被取代/关闭/失败：租约按对应理由吊销', async () => {
  const cases = [
    ['superseded', 'superseded'],
    ['closed', 'closed'],
    ['failed', 'failed'],
  ] as const;
  for (const [status, reason] of cases) {
    const { db, store } = harness();
    await seedGen1(store);
    const result = await applySessionStatusChange(store, {
      workerSessionId: 's1',
      status,
      now: NOW,
    });
    assert.deepEqual(result.ok === true ? result.value : null, {
      disposition: { action: 'revoke', reason },
      revokedLeaseIds: ['lease-g1'],
    });
    assert.equal(db.rowFor('s1', 1).revokedReason, reason);
    assert.equal(db.activeCount('s1'), 0);
  }
});

test('吊销后仍可签发新租约（同一会话、世代递增）', async () => {
  const { db, store } = harness();
  await seedGen1(store);
  await applySessionStatusChange(store, { workerSessionId: 's1', status: 'closed', now: NOW });

  const next = await issueLease(store, { workerSessionId: 's1', now: NOW, leaseId: 'lease-g2' });
  assert.equal(next.generation, 2);
  assert.equal(db.activeCount('s1'), 1);
  assert.equal(db.rowFor('s1', 1).revokedReason, 'closed');
});

// ───────────────────────────── 纯函数准入判定 ─────────────────────────────

const VALID_LEASE: SessionLease = {
  id: 'lease-g1',
  workerSessionId: 's1',
  taskRef: 'task-A',
  generation: 1,
  expiresAt: new Date(NOW.getTime() + TTL_MS),
  revokedAt: null,
  revokedReason: null,
};

test('assertLeaseValid 是纯函数：不触碰存储即可判定通过', () => {
  const result = assertLeaseValid(VALID_LEASE, 'submit_report', 1, { now: NOW, taskRef: 'task-A' });
  assert.equal(result.ok, true);
  assert.equal(result.ok === true ? result.value : null, VALID_LEASE);
});

test('assertLeaseValid：世代不符 → lease_generation_stale', () => {
  const result = assertLeaseValid(VALID_LEASE, 'execute', 2, { now: NOW });
  assert.equal(result.ok === false ? result.code : null, 'lease_generation_stale');
});

test('assertLeaseValid：已吊销 → lease_revoked（即使世代一致）', () => {
  const revoked: SessionLease = {
    ...VALID_LEASE,
    revokedAt: NOW,
    revokedReason: 'superseded',
  };
  const result = assertLeaseValid(revoked, 'execute', 1, { now: NOW });
  assert.equal(result.ok === false ? result.code : null, 'lease_revoked');
  assert.match(result.ok === false ? result.message : '', /superseded/);
});

test('assertLeaseValid：过期 → lease_expired，未到期（差 1 毫秒）通过', () => {
  const expired = assertLeaseValid(VALID_LEASE, 'request_approval', 1, {
    now: new Date(VALID_LEASE.expiresAt),
  });
  assert.equal(expired.ok === false ? expired.code : null, 'lease_expired');

  const alive = assertLeaseValid(VALID_LEASE, 'request_approval', 1, {
    now: new Date(VALID_LEASE.expiresAt.getTime() - 1),
  });
  assert.equal(alive.ok, true);
});

test('assertLeaseValid：跨任务提交被拒（租约绑定任务防提权）', () => {
  const cross = assertLeaseValid(VALID_LEASE, 'submit_report', 1, { now: NOW, taskRef: 'task-B' });
  assert.equal(cross.ok === false ? cross.code : null, 'lease_required');
  assert.match(cross.ok === false ? cross.message : '', /task-A.*task-B/);

  const same = assertLeaseValid(VALID_LEASE, 'submit_report', 1, { now: NOW, taskRef: 'task-A' });
  assert.equal(same.ok, true);
});

test('assertLeaseValid：无租约 → lease_required；非持租约操作/非法世代是协议错误', () => {
  const none = assertLeaseValid(null, 'draft_handoff', 1, { now: NOW });
  assert.equal(none.ok === false ? none.code : null, 'lease_required');

  assert.throws(
    () => assertLeaseValid(VALID_LEASE, 'interject_wake' as never, 1, { now: NOW }),
    LeaseProtocolError,
  );
  assert.throws(() => assertLeaseValid(VALID_LEASE, 'execute', 0, { now: NOW }), LeaseProtocolError);
});

test('describeLease 描述无租约 / 生效 / 已吊销三种状态', () => {
  assert.equal(describeLease(null), '无租约');
  assert.match(describeLease(VALID_LEASE), /世代 1 生效至/);
  assert.match(
    describeLease({ ...VALID_LEASE, revokedAt: NOW, revokedReason: 'human_revoke' }),
    /世代 1 .*吊销（human_revoke）/,
  );
});

// ───────────────────────────── 提交准入（读存储） ─────────────────────────────

test('提交准入：四种持租约操作全部通过', async () => {
  const { store } = harness();
  await seedGen1(store);
  for (const operation of LEASE_REQUIRED_OPERATIONS) {
    const result = await validateLeaseForOperation(store, {
      workerSessionId: 's1',
      generation: 1,
      operation,
      now: NOW,
      taskRef: 'task-A',
    });
    assert.equal(result.ok, true, operation);
  }
});

test('提交准入：无租约的会话报 lease_required', async () => {
  const { store } = harness();
  const result = await validateLeaseForOperation(store, {
    workerSessionId: 's2',
    generation: 1,
    operation: 'submit_report',
    now: NOW,
  });
  assert.equal(result.ok === false ? result.code : null, 'lease_required');
});

test('提交准入：过期租约报 lease_expired（暂停后长期不续租的情形）', async () => {
  const { store } = harness();
  await seedGen1(store);
  const result = await validateLeaseForOperation(store, {
    workerSessionId: 's1',
    generation: 1,
    operation: 'submit_report',
    now: new Date(NOW.getTime() + TTL_MS),
  });
  assert.equal(result.ok === false ? result.code : null, 'lease_expired');
});

test('提交准入：会话被人工吊销后同一世代报 lease_revoked', async () => {
  const { store } = harness();
  await seedGen1(store);
  await revokeLease(store, { workerSessionId: 's1', reason: 'human_revoke', now: NOW });

  const result = await validateLeaseForOperation(store, {
    workerSessionId: 's1',
    generation: 1,
    operation: 'submit_report',
    now: NOW,
  });
  assert.equal(result.ok === false ? result.code : null, 'lease_revoked');
});

test('提交准入：跨任务提交被拒，即使角色相同', async () => {
  const { store } = harness();
  await seedGen1(store);
  const result = await validateLeaseForOperation(store, {
    workerSessionId: 's1',
    generation: 1,
    operation: 'submit_report',
    now: NOW,
    taskRef: 'task-B',
  });
  assert.equal(result.ok === false ? result.code : null, 'lease_required');
});

test('提交准入：非持租约操作不得走租约通道', async () => {
  const { store } = harness();
  await seedGen1(store);
  await assert.rejects(
    validateLeaseForOperation(store, {
      workerSessionId: 's1',
      generation: 1,
      operation: 'start' as never,
      now: NOW,
    }),
    LeaseProtocolError,
  );
});
