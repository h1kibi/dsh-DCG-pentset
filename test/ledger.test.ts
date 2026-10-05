/**
 * `src/memory/ledger.ts` 的账本测试（设计文档 §8.2、§9.5）。
 *
 * 逻辑用例跑在可注入的假 DB 层上（记录型 `DbClient`，模拟 `jsonb` 往返与唯一键冲突）；
 * 若设置了 `PENTEST_DATABASE_URL`，额外跑一组真实 PostgreSQL 集成用例。
 */

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import { Pool } from 'pg';

import {
  DOMAIN_EVENT_TYPES,
  type AppendEventInput,
  type AppendEventResult,
  type EventHashPayload,
} from '../src/contracts.ts';
import {
  LedgerError,
  computeEventHash,
  signBatch,
} from '../src/memory/hash.ts';
import type { DbClient, DbResult } from '../src/db/port.ts';
import { EVENT_SCHEMA_VERSION, InMemoryAnchorSink, MemoryLedger, PgAnchorSink, engagementLockKey, type AnchorSink, type ContextEventRow, type LedgerAnchor } from '../src/memory/ledger.ts';

const SECRET = 'kms://test/ledger-secret';
const ENGAGEMENT = 'eng-1';
const OCCURRED_AT = '2026-01-02T03:04:05.000Z';

// ───────────────────────────── 假 DB 层 ─────────────────────────────

interface StoredEvent extends ContextEventRow {
  readonly engagement_id: string;
  readonly worker_session_id: string | null;
  readonly dsh_session_id: string | null;
  readonly schema_version: number;
  readonly text_projection: string | null;
  readonly ingested_at: Date;
}

interface StoredAnchorRow {
  readonly id: number;
  readonly engagement_id: string;
  readonly chain_head: Uint8Array;
  readonly event_count: number;
  readonly batch_from_seq: number;
  readonly batch_to_seq: number;
  readonly batch_signature: Uint8Array;
}

/** 假 DB 内部原始结果：行形状由各私有 helper 决定，出口统一断言为契约端口。 */
interface RawResult {
  readonly rows: readonly unknown[];
  readonly rowCount: number | null;
}

/** 把 SQL 归约为语句类别，便于断言事务/锁/读写之间的**顺序**。 */
function statementKind(sql: string): string {
  if (sql === 'begin' || sql === 'commit' || sql === 'rollback') return sql;
  if (sql.includes('pg_advisory_xact_lock')) return 'advisory_lock';
  return sql.startsWith('insert') ? 'insert' : 'select';
}

/**
 * 记录型假 DB：按 SQL 形状分派，模拟 `jsonb` 往返（对象经一次 JSON 序列化/反序列化）、
 * `ON CONFLICT DO NOTHING` 与 `count(*)`，并记录事务与锁语句的顺序。
 */
class FakeDb implements DbClient {
  readonly events: StoredEvent[] = [];
  readonly anchors: StoredAnchorRow[] = [];
  readonly statements: string[] = [];
  readonly lockKeys: string[] = [];
  #nextAnchorId = 1;
  #snapshot: { events: StoredEvent[]; anchors: StoredAnchorRow[] } | null = null;

  async query<Row = Record<string, unknown>>(
    sql: string,
    params: readonly unknown[] = [],
  ): Promise<DbResult<Row>> {
    const text = sql.trim().replace(/\s+/g, ' ');
    const head = text.toLowerCase();
    this.statements.push(statementKind(head));

    if (head === 'begin') {
      this.#snapshot = { events: [...this.events], anchors: [...this.anchors] };
      return { rows: [], rowCount: null };
    }
    if (head === 'commit') {
      this.#snapshot = null;
      return { rows: [], rowCount: null };
    }
    if (head === 'rollback') {
      if (this.#snapshot !== null) {
        this.events.length = 0;
        this.events.push(...this.#snapshot.events);
        this.anchors.length = 0;
        this.anchors.push(...this.#snapshot.anchors);
        this.#snapshot = null;
      }
      return { rows: [], rowCount: null };
    }
    if (head.includes('pg_advisory_xact_lock')) {
      this.lockKeys.push(String(params[0]));
      return { rows: [], rowCount: null };
    }
    if (head.includes('insert into pentest.context_events')) {
      return this.#insertEvent(params) as unknown as DbResult<Row>;
    }
    if (head.includes('insert into pentest.ledger_anchors')) {
      return this.#insertAnchor(params) as unknown as DbResult<Row>;
    }
    if (head.includes('from pentest.ledger_anchors')) {
      return (head.includes('chain_head') ? this.#latestAnchor(params) : this.#lastAnchorCount(params)) as unknown as DbResult<Row>;
    }
    if (head.includes('order by chain_seq desc')) {
      return this.#chainHead(params) as unknown as DbResult<Row>;
    }
    if (head.includes('count(*)')) {
      return this.#count(params) as unknown as DbResult<Row>;
    }
    if (head.includes('source_seq = $4')) {
      return this.#findExisting(params) as unknown as DbResult<Row>;
    }
    if (head.includes('order by chain_seq asc')) {
      return this.#chain(params) as unknown as DbResult<Row>;
    }
    throw new Error(`FakeDb 未识别的 SQL：${head}`);
  }

  #engagement(params: readonly unknown[], index: number): string {
    return String(params[index]);
  }

  #insertEvent(params: readonly unknown[]): RawResult {
    const engagementId = this.#engagement(params, 1);
    const sourceSystem = String(params[3]);
    const sourceId = String(params[4]);
    const sourceSeq = Number(params[5]);
    const duplicated = this.events.some(
      (row) =>
        row.engagement_id === engagementId &&
        row.source_system === sourceSystem &&
        row.source_id === sourceId &&
        Number(row.source_seq) === sourceSeq,
    );
    if (duplicated) return { rows: [], rowCount: 0 };

    const row: StoredEvent = {
      event_id: String(params[0]),
      engagement_id: engagementId,
      worker_session_id: (params[2] as string | null) ?? null,
      dsh_session_id: null,
      source_system: sourceSystem,
      source_id: sourceId,
      source_seq: sourceSeq,
      event_type: String(params[6]),
      schema_version: Number(params[7]),
      occurred_at: new Date(String(params[8])),
      chain_seq: Number(params[9]),
      payload_json: JSON.parse(String(params[10])) as unknown,
      raw_payload_zstd: Buffer.from(params[11] as Uint8Array),
      text_projection: null,
      classification: String(params[12]),
      trust_level: String(params[13]),
      provisional: Boolean(params[14]),
      prev_hash: params[15] === null ? null : Buffer.from(params[15] as Uint8Array),
      event_hash: Buffer.from(params[16] as Uint8Array),
      ingested_at: new Date(),
    };
    this.events.push(row);
    return { rows: [{ event_id: row.event_id, chain_seq: row.chain_seq, event_hash: row.event_hash }], rowCount: 1 };
  }

  #insertAnchor(params: readonly unknown[]): RawResult {
    this.anchors.push({
      id: this.#nextAnchorId++,
      engagement_id: String(params[0]),
      chain_head: Buffer.from(params[1] as Uint8Array),
      event_count: Number(params[2]),
      batch_from_seq: Number(params[3]),
      batch_to_seq: Number(params[4]),
      batch_signature: Buffer.from(params[5] as Uint8Array),
    });
    return { rows: [], rowCount: 1 };
  }

  #lastAnchorCount(params: readonly unknown[]): RawResult {
    const engagementId = this.#engagement(params, 0);
    const rows = this.anchors.filter((row) => row.engagement_id === engagementId);
    const last = rows[rows.length - 1];
    return {
      rows: last === undefined ? [] : [{ event_count: last.event_count }],
      rowCount: last === undefined ? 0 : 1,
    };
  }

  #latestAnchor(params: readonly unknown[]): RawResult {
    const engagementId = this.#engagement(params, 0);
    const rows = this.anchors.filter((row) => row.engagement_id === engagementId);
    const last = rows[rows.length - 1];
    return { rows: last === undefined ? [] : [last], rowCount: last === undefined ? 0 : 1 };
  }

  #chainHead(params: readonly unknown[]): RawResult {
    const rows = this.#forEngagement(params);
    const last = rows[rows.length - 1];
    return { rows: last === undefined ? [] : [last], rowCount: last === undefined ? 0 : 1 };
  }

  #count(params: readonly unknown[]): RawResult {
    const rows = this.#forEngagement(params);
    return { rows: [{ event_count: rows.length }], rowCount: 1 };
  }

  #findExisting(params: readonly unknown[]): RawResult {
    const engagementId = this.#engagement(params, 0);
    const found = this.events.filter(
      (row) =>
        row.engagement_id === engagementId &&
        row.source_system === String(params[1]) &&
        row.source_id === String(params[2]) &&
        Number(row.source_seq) === Number(params[3]),
    );
    return { rows: found, rowCount: found.length };
  }

  #chain(params: readonly unknown[]): RawResult {
    const rows = [...this.#forEngagement(params)]
      .filter((row) => {
        if (params.length < 3) return true;
        const seq = Number(row.chain_seq);
        return seq >= Number(params[1]) && seq <= Number(params[2]);
      })
      .sort((a, b) => Number(a.chain_seq) - Number(b.chain_seq));
    return { rows, rowCount: rows.length };
  }

  #forEngagement(params: readonly unknown[]): StoredEvent[] {
    const engagementId = this.#engagement(params, 0);
    return this.events.filter((row) => row.engagement_id === engagementId);
  }
}

// ───────────────────────────── 夹具 ─────────────────────────────

function input(overrides: Partial<AppendEventInput> = {}): AppendEventInput {
  return {
    engagementId: ENGAGEMENT,
    workerSessionId: 'sess-1',
    eventType: 'tool.result',
    sourceSystem: 'dsh',
    sourceId: 'run-1',
    sourceSeq: 1,
    occurredAt: new Date(OCCURRED_AT),
    payload: { stdout: 'x' },
    rawPayload: new TextEncoder().encode('raw-1'),
    classification: 'engagement',
    trustLevel: 'tool_observation',
    ...overrides,
  };
}

function expectedPayload(overrides: Partial<EventHashPayload> = {}): EventHashPayload {
  return {
    eventType: 'tool.result',
    sourceSystem: 'dsh',
    sourceId: 'run-1',
    sourceSeq: 1,
    chainSeq: 1,
    occurredAt: OCCURRED_AT,
    provisional: false,
    classification: 'engagement',
    trustLevel: 'tool_observation',
    payloadJson: { stdout: 'x' },
    rawPayload: new TextEncoder().encode('raw-1'),
    ...overrides,
  };
}

function build(): {
  ledger: MemoryLedger;
  db: FakeDb;
  anchors: InMemoryAnchorSink;
  signedBatches: EventHashPayload[][];
} {
  const db = new FakeDb();
  const anchors = new InMemoryAnchorSink();
  const signedBatches: EventHashPayload[][] = [];
  const ledger = new MemoryLedger({
    db,
    anchors,
    secret: SECRET,
    sign: (payloads, scope) => {
      signedBatches.push([...payloads]);
      return signBatch(SECRET, payloads, scope);
    },
  });
  return { ledger, db, anchors, signedBatches };
}

function assertLedgerError(fn: () => unknown | Promise<unknown>, code: string): Promise<void> | void {
  const check = (error: unknown): boolean => {
    assert.ok(error instanceof LedgerError, `期望 LedgerError，实际 ${String(error)}`);
    assert.equal(error.code, code);
    return true;
  };
  const result = fn();
  if (result instanceof Promise) {
    return assert.rejects(result, check);
  }
  assert.throws(fn, check);
  return undefined;
}

function hexOf(value: Uint8Array | null): string | null {
  return value === null ? null : Buffer.from(value.buffer, value.byteOffset, value.byteLength).toString('hex');
}

/** 行的内容指纹：把字节列转成十六进制后再序列化，便于比较「未被改写」。 */
function fingerprintRow(row: StoredEvent): string {
  return JSON.stringify(row, (key, value: unknown) =>
    key === 'prev_hash' || key === 'event_hash' || key === 'raw_payload_zstd'
      ? (value === null ? null : Buffer.from(value as Uint8Array).toString('hex'))
      : value,
  );
}

// ───────────────────────────── 追加与链 ─────────────────────────────

describe('追加与链连续性', () => {
  it('首个事件的 chain_seq=1、prev_hash 为空，且哈希与冻结字段集一致', async () => {
    const { ledger, db } = build();
    const result = await ledger.appendEvent(input());
    assert.equal(result.chainSeq, 1);
    assert.equal(db.events[0]?.prev_hash, null);
    assert.equal(db.events[0]?.schema_version, EVENT_SCHEMA_VERSION);
    assert.equal(result.eventHash, computeEventHash(null, expectedPayload()));
  });

  it('dsh_session_id 与 text_projection 写 NULL（前者 join 可得，后者索引器无法回填）', async () => {
    const { ledger, db } = build();
    await ledger.appendEvent(input());
    assert.equal(db.events[0]?.dsh_session_id, null);
    assert.equal(db.events[0]?.text_projection, null);
  });

  it('连续追加推进 chain_seq 并串起 prev_hash（verifyChain 通过）', async () => {
    const { ledger, db } = build();
    const first = await ledger.appendEvent(input());
    const second = await ledger.appendEvent(input({ sourceId: 'run-2', sourceSeq: 1 }));
    const third = await ledger.appendEvent(input({ sourceId: 'run-3', sourceSeq: 1 }));
    assert.deepEqual([first.chainSeq, second.chainSeq, third.chainSeq], [1, 2, 3]);
    assert.equal(hexOf(db.events[1]?.prev_hash ?? null), first.eventHash);
    assert.equal(hexOf(db.events[2]?.prev_hash ?? null), second.eventHash);
    const verified = await ledger.verifyChain(ENGAGEMENT);
    assert.deepEqual(verified.failures, []);
    assert.equal(verified.ok, true);
    assert.equal(verified.eventCount, 3);
    assert.equal(verified.chainHead, third.eventHash);
  });

  it('每个事件哈希绑定其 chain_seq：同负载换链序即换哈希', async () => {
    const { ledger } = build();
    const first = await ledger.appendEvent(input());
    const second = await ledger.appendEvent(input({ sourceId: 'run-2' }));
    assert.notEqual(first.eventHash, second.eventHash);
    assert.equal(second.eventHash, computeEventHash(Buffer.from(first.eventHash, 'hex'), expectedPayload({
      sourceId: 'run-2',
      chainSeq: 2,
    })));
  });

  it('单批多事件在一次事务内按序追加', async () => {
    const { ledger, db, anchors } = build();
    const results = await ledger.appendBatch([
      input({ sourceId: 'a', sourceSeq: 1 }),
      input({ sourceId: 'a', sourceSeq: 2 }),
      input({ sourceId: 'a', sourceSeq: 3 }),
    ]);
    assert.deepEqual(results.map((r) => r.chainSeq), [1, 2, 3]);
    assert.equal(db.events.length, 3);
    assert.equal(anchors.history.length, 1, '每批追加写一个锚点');
    assert.equal(anchors.history[0]?.eventCount, 3);
    assert.equal(anchors.history[0]?.batchFromSeq, 1);
    assert.equal(anchors.history[0]?.batchToSeq, 3);
    assert.equal(anchors.history[0]?.chainHead, results[2]?.eventHash);
    assert.match(anchors.history[0]?.batchSignature ?? '', /^[0-9a-f]{64}$/);
  });

  it('批次签名覆盖本批全部负载（含各自 chain_seq）', async () => {
    const { ledger, signedBatches } = build();
    await ledger.appendBatch([input({ sourceId: 'b', sourceSeq: 1 }), input({ sourceId: 'b', sourceSeq: 2 })]);
    assert.equal(signedBatches.length, 1);
    assert.deepEqual(signedBatches[0]?.map((p) => p.chainSeq), [1, 2]);
    assert.equal(signedBatches[0]?.[0]?.classification, 'engagement');
    assert.equal(signedBatches[0]?.[0]?.trustLevel, 'tool_observation');
  });

  it('事务边界与锁：begin → engagement 级 advisory lock → 读写 → commit', async () => {
    const { ledger, db } = build();
    await ledger.appendEvent(input());
    assert.deepEqual(db.statements, [
      'begin',
      'advisory_lock',
      'select', // 链头
      'select', // 事件计数
      'select', // 幂等键查重
      'insert',
      'commit',
    ]);
    assert.deepEqual(db.lockKeys, [engagementLockKey(ENGAGEMENT).toString()]);
  });

  it('空批次不写任何东西', async () => {
    const { ledger, db, anchors } = build();
    assert.deepEqual(await ledger.appendBatch([]), []);
    assert.equal(db.events.length, 0);
    assert.equal(anchors.history.length, 0);
  });
});

// ───────────────────────────── 幂等 ─────────────────────────────

describe('幂等（(engagement, sourceSystem, sourceId, sourceSeq)）', () => {
  it('同一批重复追加返回既有结果且不重复插入', async () => {
    const { ledger, db, anchors } = build();
    const batch = [input({ sourceId: 'i', sourceSeq: 1 }), input({ sourceId: 'i', sourceSeq: 2 })];
    const first = await ledger.appendBatch(batch);
    const second = await ledger.appendBatch(batch);
    assert.deepEqual(second, first);
    assert.equal(db.events.length, 2);
    assert.equal(anchors.history.length, 1, '未插入新事件的批次不写新锚点');
  });

  it('部分重复的批次只补写缺失事件，链序仍连续', async () => {
    const { ledger, db } = build();
    const existing = await ledger.appendEvent(input({ sourceId: 'p', sourceSeq: 1 }));
    const results = await ledger.appendBatch([
      input({ sourceId: 'p', sourceSeq: 1 }),
      input({ sourceId: 'p', sourceSeq: 2 }),
      input({ sourceId: 'p', sourceSeq: 3 }),
    ]);
    assert.equal(results[0]?.eventId, existing.eventId);
    assert.equal(results[0]?.chainSeq, 1);
    assert.deepEqual(results.map((r) => r.chainSeq), [1, 2, 3]);
    assert.equal(db.events.length, 3);
  });

  it('重复追加不改变事件哈希（同键即同结果）', async () => {
    const { ledger } = build();
    const single = input({ sourceId: 'q', sourceSeq: 7 });
    const first = await ledger.appendEvent(single);
    const replay = await ledger.appendEvent({ ...single, occurredAt: new Date('2027-09-09T09:09:09.000Z') });
    assert.deepEqual(replay, first);
  });

  it('不同 sourceSeq 是不同事件', async () => {
    const { ledger, db } = build();
    await ledger.appendEvent(input({ sourceId: 'r', sourceSeq: 1 }));
    await ledger.appendEvent(input({ sourceId: 'r', sourceSeq: 2 }));
    assert.equal(db.events.length, 2);
    assert.deepEqual(db.events.map((row) => row.chain_seq), [1, 2]);
  });

  it('幂等键含 engagement：不同 engagement 的同源事件各成一条链', async () => {
    const { ledger, db } = build();
    const a = await ledger.appendEvent(input({ engagementId: 'eng-a' }));
    const b = await ledger.appendEvent(input({ engagementId: 'eng-b' }));
    assert.equal(a.chainSeq, 1);
    assert.equal(b.chainSeq, 1);
    assert.equal(db.events.length, 2);
  });
});

// ───────────────────────────── 只允许追加 ─────────────────────────────

describe('只允许追加', () => {
  it('服务面不暴露任何 update/delete/remove 方法', () => {
    const { ledger } = build();
    const forbidden = /update|delete|remove|mutate|overwrite|truncate|replace/i;
    const methods = Object.getOwnPropertyNames(Object.getPrototypeOf(ledger)).filter(
      (name) => typeof (ledger as unknown as Record<string, unknown>)[name] === 'function',
    );
    assert.deepEqual(methods.filter((name) => forbidden.test(name)), []);
    assert.ok(methods.includes('appendEvent'));
    assert.ok(methods.includes('appendBatch'));
    assert.ok(methods.includes('anchor'));
  });

  it('已提交行在后续追加中保持不变（修正只能靠追加新事件）', async () => {
    const { ledger, db } = build();
    const first = await ledger.appendEvent(input({ sourceId: 'f', sourceSeq: 1 }));
    const snapshot = fingerprintRow(db.events[0]!);
    await ledger.appendEvent(input({ sourceId: 'f', sourceSeq: 2 }));
    assert.equal(fingerprintRow(db.events[0]!), snapshot);
    assert.equal(db.events[0]?.event_id, first.eventId);
  });
});

// ───────────────────────────── 完整性 ─────────────────────────────

describe('完整性：篡改可检出', () => {
  async function threeEventChain(): Promise<{ ledger: MemoryLedger; db: FakeDb; anchors: InMemoryAnchorSink }> {
    const built = build();
    await built.ledger.appendBatch([
      input({ sourceId: 't', sourceSeq: 1 }),
      input({ sourceId: 't', sourceSeq: 2, classification: 'credential-like', trustLevel: 'external_untrusted' }),
      input({ sourceId: 't', sourceSeq: 3 }),
    ]);
    return built;
  }

  it('未篡改时校验通过且链头等于锚点链头', async () => {
    const { ledger, anchors } = await threeEventChain();
    const verified = await ledger.verifyChain(ENGAGEMENT);
    assert.equal(verified.ok, true);
    assert.deepEqual(verified.failures, []);
    const anchor = await ledger.anchor(ENGAGEMENT);
    assert.equal(anchor.eventCount, 3);
    assert.equal(anchor.chainHead, anchors.history[0]?.chainHead);
    const check = await ledger.verifyAnchor(ENGAGEMENT);
    assert.equal(check.ok, true);
    assert.deepEqual(check.mismatches, []);
  });

  it('篡改 classification 导致校验失败（信任语义不可改标）', async () => {
    const { ledger, db } = await threeEventChain();
    (db.events[1] as { classification: string }).classification = 'public';
    const verified = await ledger.verifyChain(ENGAGEMENT);
    assert.equal(verified.ok, false);
    assert.deepEqual(verified.failures.map((failure) => failure.kind), ['hash_mismatch', 'hash_mismatch']);
    assert.equal(verified.failures[0]?.chainSeq, 2, '首个断裂点是被篡改的那一行');
    assert.equal(verified.failures[1]?.chainSeq, 3, '后继行的链式哈希随之失效');
  });

  it('篡改 trustLevel 导致校验失败（外部不可信不能改标为人工决策）', async () => {
    const { ledger, db } = await threeEventChain();
    (db.events[1] as { trust_level: string }).trust_level = 'human_decision';
    const verified = await ledger.verifyChain(ENGAGEMENT);
    assert.equal(verified.ok, false);
    assert.equal(verified.failures[0]?.kind, 'hash_mismatch');
  });

  it('篡改 payload_json / raw_payload_zstd / occurred_at / provisional 均可检出', async () => {
    const mutations: Array<(row: StoredEvent) => void> = [
      (row) => {
        (row as { payload_json: unknown }).payload_json = { stdout: '伪造' };
      },
      (row) => {
        (row as { raw_payload_zstd: Uint8Array }).raw_payload_zstd = new TextEncoder().encode('raw-9');
      },
      (row) => {
        (row as { occurred_at: Date }).occurred_at = new Date('2026-01-02T03:04:06.000Z');
      },
      (row) => {
        (row as { provisional: boolean }).provisional = true;
      },
    ];
    for (const mutate of mutations) {
      const { ledger, db } = await threeEventChain();
      mutate(db.events[2]!);
      const verified = await ledger.verifyChain(ENGAGEMENT);
      assert.equal(verified.ok, false, '尾部事件的篡改必须被检出');
      assert.equal(verified.failures[0]?.chainSeq, 3);
    }
  });

  it('改写 prev_hash 造成断链可检出', async () => {
    const { ledger, db } = await threeEventChain();
    (db.events[2] as { prev_hash: Uint8Array }).prev_hash = Buffer.alloc(32, 9);
    const verified = await ledger.verifyChain(ENGAGEMENT);
    assert.equal(verified.ok, false);
    assert.ok(verified.failures.some((failure) => failure.kind === 'broken_link'));
  });

  it('删除中间事件造成链序缺口可检出', async () => {
    const { ledger, db } = await threeEventChain();
    db.events.splice(1, 1);
    const verified = await ledger.verifyChain(ENGAGEMENT);
    assert.equal(verified.ok, false);
    const kinds = verified.failures.map((failure) => failure.kind);
    assert.ok(kinds.includes('seq_gap'), `期望 seq_gap，实际 ${kinds.join(',')}`);
    assert.ok(kinds.includes('broken_link'));
  });
});

describe('尾部截断：锚点计数与链头', () => {
  it('删除尾部行后事件计数与链头均与锚点不一致（只有摘要发现不了截断）', async () => {
    const { ledger, db, anchors } = build();
    await ledger.appendBatch([input({ sourceId: 'c', sourceSeq: 1 }), input({ sourceId: 'c', sourceSeq: 2 })]);
    await ledger.appendEvent(input({ sourceId: 'c', sourceSeq: 3 }));

    const before = await ledger.verifyAnchor(ENGAGEMENT);
    assert.equal(before.ok, true);
    assert.equal(before.eventCount, 3);
    assert.equal(await anchors.lastEventCount(ENGAGEMENT), 3);

    // 攻击者删除尾部一行：剩下的行自身仍然是一条自洽的链。
    db.events.pop();
    const stillChainOk = await ledger.verifyChain(ENGAGEMENT);
    assert.equal(stillChainOk.ok, true, '裸哈希链发现不了尾部截断——这正是需要锚点计数的原因');

    const after = await ledger.verifyAnchor(ENGAGEMENT);
    assert.equal(after.ok, false);
    assert.equal(after.eventCount, 2);
    assert.deepEqual([...after.mismatches].sort(), ['chain_head', 'event_count']);
    assert.equal(after.anchored?.eventCount, 3);
  });

  it('截断后继续追加被拒绝（计数回落在写入前即可判定）', async () => {
    const { ledger, db } = build();
    await ledger.appendEvent(input({ sourceId: 'd', sourceSeq: 1 }));
    await ledger.appendEvent(input({ sourceId: 'd', sourceSeq: 2 }));
    db.events.pop();
    await assertLedgerError(() => ledger.appendEvent(input({ sourceId: 'd', sourceSeq: 3 })), 'audit_unavailable');
  });

  it('删除尾部行后事务回滚，不留下半写状态', async () => {
    const { ledger, db } = build();
    await ledger.appendEvent(input({ sourceId: 'e', sourceSeq: 1 }));
    db.events.pop();
    await assertLedgerError(() => ledger.appendEvent(input({ sourceId: 'e', sourceSeq: 2 })), 'audit_unavailable');
    assert.equal(db.statements[db.statements.length - 1], 'rollback');
    assert.equal(db.events.length, 0);
  });

  it('锚点计数必须严格递增（尾部截断的核心判据）', async () => {
    const sink = new InMemoryAnchorSink();
    const base: LedgerAnchor = {
      engagementId: ENGAGEMENT,
      chainHead: 'a'.repeat(64),
      eventCount: 5,
      batchFromSeq: 1,
      batchToSeq: 5,
      batchSignature: 'b'.repeat(64),
    };
    await sink.appendAnchor(base);
    await assertLedgerError(() => sink.appendAnchor({ ...base, eventCount: 5 }), 'audit_unavailable');
    await assertLedgerError(() => sink.appendAnchor({ ...base, eventCount: 4 }), 'audit_unavailable');
    await sink.appendAnchor({ ...base, eventCount: 6 });
    assert.equal(await sink.lastEventCount(ENGAGEMENT), 6);
  });

  it('空账本的 anchor() 返回全零链头与零计数', async () => {
    const { ledger } = build();
    assert.deepEqual(await ledger.anchor('eng-empty'), {
      chainHead: '0'.repeat(64),
      eventCount: 0,
    });
  });

  it('锚点批次签名可被持有密钥的一方重新校验', async () => {
    const { ledger, anchors } = build();
    await ledger.appendBatch([input({ sourceId: 'sig', sourceSeq: 1 }), input({ sourceId: 'sig', sourceSeq: 2 })]);
    const anchor = anchors.history[0]!;
    assert.equal(await ledger.verifyBatchSignature(anchor), true);

    // 篡改批次内任一行的分类 → 签名不再成立（密钥在插件进程，运行时不持密钥）
    const { ledger: second, db, anchors: secondAnchors } = build();
    await second.appendBatch([input({ sourceId: 'sig', sourceSeq: 1 }), input({ sourceId: 'sig', sourceSeq: 2 })]);
    (db.events[0] as { classification: string }).classification = 'public';
    assert.equal(await second.verifyBatchSignature(secondAnchors.history[0]!), false);
  });

  it('尾部截断后锚点区间内的行数不足，签名校验失败', async () => {
    const { ledger, db, anchors } = build();
    await ledger.appendBatch([input({ sourceId: 'cut', sourceSeq: 1 }), input({ sourceId: 'cut', sourceSeq: 2 })]);
    const anchor = anchors.history[0]!;
    db.events.pop();
    assert.equal(await ledger.verifyBatchSignature(anchor), false);
  });

  it('伪造的锚点（改了链头、计数或签名）无法通过校验', async () => {
    const { ledger, anchors } = build();
    await ledger.appendEvent(input({ sourceId: 'forge', sourceSeq: 1 }));
    const anchor = anchors.history[0]!;
    assert.equal(await ledger.verifyBatchSignature(anchor), true);
    assert.equal(await ledger.verifyBatchSignature({ ...anchor, eventCount: 99 }), false);
    assert.equal(await ledger.verifyBatchSignature({ ...anchor, chainHead: 'f'.repeat(64) }), false);
    assert.equal(await ledger.verifyBatchSignature({ ...anchor, batchSignature: 'f'.repeat(64) }), false);
    assert.equal(await ledger.verifyBatchSignature({ ...anchor, batchToSeq: 2 }), false);
  });

  it('换了签名密钥（或非 HMAC 方案）时本地校验为 false，不自欺通过', async () => {
    const db = new FakeDb();
    const anchors = new InMemoryAnchorSink();
    const ledger = new MemoryLedger({
      db,
      anchors,
      secret: SECRET,
      sign: (payloads, scope) => signBatch('another-kms-key', payloads, scope),
    });
    await ledger.appendEvent(input());
    assert.equal(await ledger.verifyBatchSignature(anchors.history[0]!), false);
  });
});

describe('PgAnchorSink（独立角色表）', () => {
  it('写锚点并把链头/签名存为 bytea，可读回最新锚点', async () => {
    const db = new FakeDb();
    const sink = new PgAnchorSink(db);
    const anchor: LedgerAnchor = {
      engagementId: ENGAGEMENT,
      chainHead: 'c'.repeat(64),
      eventCount: 2,
      batchFromSeq: 1,
      batchToSeq: 2,
      batchSignature: 'd'.repeat(64),
    };
    await sink.appendAnchor(anchor);
    assert.equal(await sink.lastEventCount(ENGAGEMENT), 2);
    const latest = await sink.latestAnchor(ENGAGEMENT);
    assert.deepEqual(latest, anchor);
    assert.equal(await sink.lastEventCount('eng-other'), null);
    assert.equal(await sink.latestAnchor('eng-other'), null);
  });

  it('拒绝非严格递增的事件计数', async () => {
    const db = new FakeDb();
    const sink = new PgAnchorSink(db);
    const anchor: LedgerAnchor = {
      engagementId: ENGAGEMENT,
      chainHead: 'c'.repeat(64),
      eventCount: 4,
      batchFromSeq: 1,
      batchToSeq: 4,
      batchSignature: 'd'.repeat(64),
    };
    await sink.appendAnchor(anchor);
    await assertLedgerError(() => sink.appendAnchor({ ...anchor, eventCount: 3 }), 'audit_unavailable');
  });

  it('拒绝非 32 字节的链头', async () => {
    const db = new FakeDb();
    const sink = new PgAnchorSink(db);
    await assertLedgerError(
      () =>
        sink.appendAnchor({
          engagementId: ENGAGEMENT,
          chainHead: 'ab',
          eventCount: 1,
          batchFromSeq: 1,
          batchToSeq: 1,
          batchSignature: 'd'.repeat(64),
        }),
      'audit_unavailable',
    );
  });

  it('账本在 Pg 锚点路径下同样写锚点并可通过 verifyAnchor', async () => {
    const db = new FakeDb();
    const sink = new PgAnchorSink(db);
    const ledger = new MemoryLedger({ db, anchors: sink, secret: SECRET });
    await ledger.appendBatch([input({ sourceId: 'g', sourceSeq: 1 }), input({ sourceId: 'g', sourceSeq: 2 })]);
    assert.equal(db.anchors.length, 1);
    assert.equal(db.anchors[0]?.event_count, 2);
    assert.equal(await sink.lastEventCount(ENGAGEMENT), 2);
    const check = await ledger.verifyAnchor(ENGAGEMENT);
    assert.equal(check.ok, true);
    assert.equal(check.anchored?.batchFromSeq, 1);
    assert.equal(check.anchored?.batchToSeq, 2);
  });

  it('未装配锚点存储时 verifyAnchor 明确拒绝，不静默通过', async () => {
    const db = new FakeDb();
    const ledger = new MemoryLedger({ db, secret: SECRET });
    await assertLedgerError(() => ledger.verifyAnchor(ENGAGEMENT), 'audit_unavailable');
  });

  it('装配了不可读锚点的存储时也拒绝校验', async () => {
    const db = new FakeDb();
    const writeOnly: AnchorSink = {
      appendAnchor: () => Promise.resolve(),
      lastEventCount: () => Promise.resolve(null),
    };
    const ledger = new MemoryLedger({ db, anchors: writeOnly, secret: SECRET });
    await assertLedgerError(() => ledger.verifyAnchor(ENGAGEMENT), 'audit_unavailable');
  });
});

// ───────────────────────────── 输入校验 ─────────────────────────────

describe('输入校验（fail-closed）', () => {
  it('领域事件类型限定在契约词汇表内（§8.2）', async () => {
    const { ledger, db } = build();
    await assertLedgerError(
      () => ledger.appendEvent(input({ eventType: 'plugin.custom.event' as AppendEventInput['eventType'] })),
      'classification_rejected',
    );
    assert.equal(db.events.length, 0);
    assert.ok((DOMAIN_EVENT_TYPES as readonly string[]).includes('tool.result'));
  });

  it('非法分类或可信度被拒绝', async () => {
    const { ledger } = build();
    await assertLedgerError(
      () => ledger.appendEvent(input({ classification: 'top-secret' as AppendEventInput['classification'] })),
      'classification_rejected',
    );
    await assertLedgerError(
      () => ledger.appendEvent(input({ trustLevel: 'god' as AppendEventInput['trustLevel'] })),
      'classification_rejected',
    );
  });

  it('一个批次不能跨 engagement', async () => {
    const { ledger, db } = build();
    await assertLedgerError(
      () => ledger.appendBatch([input(), input({ engagementId: 'eng-2' })]),
      'audit_unavailable',
    );
    assert.equal(db.events.length, 0);
  });

  it('拒绝非法 engagementId、occurredAt、rawPayload、sourceSeq', async () => {
    const { ledger } = build();
    await assertLedgerError(() => ledger.appendEvent(input({ engagementId: 'has space' })), 'audit_unavailable');
    await assertLedgerError(
      () => ledger.appendEvent(input({ occurredAt: new Date('非法') })),
      'audit_unavailable',
    );
    await assertLedgerError(
      () => ledger.appendEvent(input({ rawPayload: 'raw' as unknown as Uint8Array })),
      'audit_unavailable',
    );
    await assertLedgerError(() => ledger.appendEvent(input({ sourceSeq: -1 })), 'audit_unavailable');
    await assertLedgerError(() => ledger.appendEvent(input({ sourceSeq: 1.5 })), 'audit_unavailable');
  });

  it('负载含 undefined 时拒绝（不能依赖 jsonb 静默丢字段）', async () => {
    const { ledger, db } = build();
    await assertLedgerError(
      () => ledger.appendEvent(input({ payload: { a: 1, b: undefined } })),
      'audit_unavailable',
    );
    assert.equal(db.events.length, 0);
  });

  it('批次签名器返回非法长度时拒绝整批写入', async () => {
    const db = new FakeDb();
    const anchors = new InMemoryAnchorSink();
    const ledger = new MemoryLedger({ db, anchors, secret: SECRET, sign: () => 'too-short' });
    await assertLedgerError(() => ledger.appendEvent(input()), 'audit_unavailable');
    assert.equal(db.statements[db.statements.length - 1], 'rollback');
    assert.equal(db.events.length, 0);
    assert.equal(anchors.history.length, 0);
  });

  it('appendEvent 返回首条结果（单条批次的形状）', async () => {
    const { ledger } = build();
    const result: AppendEventResult = await ledger.appendEvent(input());
    assert.deepEqual(Object.keys(result).sort(), ['chainSeq', 'eventHash', 'eventId']);
  });
});

// ───────────────────────────── 集成（可选） ─────────────────────────────

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

describe('集成：真实 PostgreSQL', { skip: DATABASE_URL === undefined ? '未设置 PENTEST_DATABASE_URL' : false }, () => {
  // 清理需要拿到原始 Pool（`connect()`）：`session_replication_role` 是会话级设置，
  // 必须在同一条连接上收发，不能让 `pool.query` 随机借连接。
  let pool: (DbClient & Pick<Pool, 'connect'> & { end: () => Promise<void> }) | null = null;
  let engagementId = '';
  let workerSessionId = '';
  let ledger: MemoryLedger;
  let anchors: PgAnchorSink;

  before(async () => {
    const created = new Pool({ connectionString: DATABASE_URL });
    pool = created as unknown as DbClient & Pick<Pool, 'connect'> & { end: () => Promise<void> };
    engagementId = randomUUID();
    workerSessionId = randomUUID();
    // 种子写入不吞错：真实库缺表/约束不符时，用例应当在这里就报出来，
    // 而不是让后续断言在「没有种子」的状态下给出误导性的失败。
    await created.query(
      `insert into pentest.engagements (id, tenant_id, name, status, current_status, target_snapshot, scope_snapshot, roe_snapshot, policy_snapshot, config_snapshot, created_by)
         values ($1, 'test', 'ledger-integration', 'running', 'ready', '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, 'node-test')`,
      [engagementId],
    );
    // context_events.worker_session_id 有外键指向 worker_sessions：
    // 假 DB 不校验外键，真实库会。因此集成用例必须先建真实会话行。
    await created.query(
      `insert into pentest.worker_sessions (id, engagement_id, dsh_session_id, phase, profile_id, profile_revision, task_prompt, tool_filter, skill_ids, model_route, status)
         values ($1, $2, $3, 'intelligence-gathering', 'p', 'r1', 'tp', '{}'::jsonb, '[]'::jsonb, '{}'::jsonb, 'active')`,
      [workerSessionId, engagementId, `dsh-${workerSessionId}`],
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
    await created.query(
      `insert into pentest.session_leases (engagement_id, worker_session_id, generation, expires_at)
       values ($1::uuid, $2::uuid, 1, now() + interval '1 hour')`,
      [engagementId, workerSessionId],
    );

    const db = created as unknown as DbClient;
    anchors = new PgAnchorSink(db);
    ledger = new MemoryLedger({ db, anchors, secret: SECRET });
  });

  /**
   * 清理本文件自己造的 engagement 下的全部种子数据（含兄弟测试对账时补写的审计行）。
   *
   * 用**同一条连接**收发 `SET session_replication_role`：它是会话级设置，
   * 用 `pool.query` 设只影响当时借出的那条连接，删表却可能落在另一条上。
   */
  async function cleanupEngagements(ids: readonly string[]): Promise<void> {
    if (pool === null) return;
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
    if (pool === null) return;
    // 清理失败必须冒泡（原先逐句 `.catch(() => undefined)` 会连 `engagements` 都没删，
    // 静默留下一整行种子）；顺序上的变化是补上 engagements 这一层。
    await cleanupEngagements([engagementId]);
    await pool.end();
  });

  it('追加、链校验、锚点比对与幂等重放在真实库上成立', async () => {
    const batch = [
      input({ engagementId, workerSessionId, sourceId: 'pg', sourceSeq: 1 }),
      input({ engagementId, workerSessionId, sourceId: 'pg', sourceSeq: 2 }),
    ];
    const first = await ledger.appendBatch(batch);
    assert.deepEqual(first.map((r) => r.chainSeq), [1, 2]);
    const replay = await ledger.appendBatch(batch);
    assert.deepEqual(replay, first);
    const verified = await ledger.verifyChain(engagementId);
    assert.deepEqual(verified.failures, []);
    const check = await ledger.verifyAnchor(engagementId);
    assert.equal(check.ok, true);
    assert.equal(check.eventCount, 2);
  });
});
