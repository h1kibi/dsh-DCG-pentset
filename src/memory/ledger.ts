/**
 * 事件账本（写 PostgreSQL）—— 设计文档 §8.2「事件模型」与 §9.5「追加写与完整性」。
 *
 * 纪律与硬约束：
 *
 * 1. **领域事件只进 PostgreSQL，不进会话日志**（§8.2）。dsh 会话事件词汇表是 fail-closed 的，
 *    本模块绝不调用 `Session.append`，也不定义任何会话事件类型。
 * 2. **只允许追加**。本服务不提供任何 update/delete 方法；已提交行的修正通过追加新事件并
 *    引用被取代条目完成。`context_events` 的运行时角色没有 `UPDATE`/`DELETE` 权限。
 * 3. **在 engagement 级 advisory lock 下串行化**（§15.4「会话创建、交接确认与结论采纳在
 *    engagement 锁内串行」）。链头读取与 `chain_seq` 推进必须在同一把锁内，否则两个并发追加
 *    会读到同一个链头、写出同一条链序或产生分叉。
 * 4. **`anchor()` 返回链头摘要与事件计数**：计数是检测尾部截断所必需的——只有摘要无法发现
 *    截断，因为链长本身只存在于被删的行里（§9.5）。每批追加（而非定期）写锚点，且锚点写在
 *    「运行时角色不可写」的独立存储里。
 * 5. **幂等**：`(engagementId, source_system, source_id, source_seq)` 是既有唯一键，重复追加
 *    返回既有结果而不重复插入（§15.3「工具结果已入库但响应丢失时，重试返回原结果」）。
 * 6. **完整性用密钥签名，不用裸哈希链**。签名密钥由调用方从 KMS 注入构造函数，运行时数据库
 *    角色不持有；本模块也绝不从环境变量或数据库读密钥。
 *
 * 关于 `context_events` 的两个列，写 NULL 是**刻意的**，不是待补的 TODO：
 *
 * - `dsh_session_id`：账本存 `worker_session_id`，需要 dsh 会话标识时 join `worker_sessions`。
 *   冗余存两份会让两者出现分歧时无法判定谁是对的。只有采集侧（知道 dsh 会话标识的那一层）
 *   直接写该列时才填，本服务不填。
 * - `text_projection`：运行时角色对 `context_events` **没有 UPDATE 权限**（§9.5 append-only），
 *   索引器**无法回填**该列，写入时留 NULL 就永远是 NULL。因此检索文本只存在于
 *   `memory_chunks.content`（索引器可写该表），`context_events` 不做文本投影。
 *
 * 关于 `raw_payload_zstd`：本服务把 `AppendEventInput.rawPayload` 的字节**原样**写入该列，
 * 不压缩也不解压。事件哈希覆盖「入库时写入的字节」，因此链校验（`verifyChain`）只依赖表中
 * 实际存储的值就能重现。压缩由采集侧在调用前完成（契约没有压缩开关，本模块不引入新依赖）。
 */

import { randomUUID } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import {
  DOMAIN_EVENT_TYPES,
  type AppendEventInput,
  type AppendEventResult,
  type EventHashPayload,
  type MemoryLedgerService,
} from '../contracts.ts';
import {
  CLASSIFICATIONS,
  HASH_HEX_LENGTH,
  LedgerError,
  TRUST_LEVELS,
  ZERO_HASH,
  computeEventHash,
  signBatch,
  verifyBatch,
  type BatchSignatureScope,
  type LedgerSecret,
} from './hash.ts';

/** 事件 schema 版本（协议版本，§9.1）。改变哈希覆盖字段集时必须递增。 */
export const EVENT_SCHEMA_VERSION = 1;

/** advisory lock 键的命名空间高位，区分本插件与同库其它锁使用者。 */
export const ADVISORY_LOCK_NAMESPACE = 0x4453_4850; // 'DSHP'

const ENGAGEMENT_ID_PATTERN = /^[0-9a-zA-Z][0-9a-zA-Z-]{0,63}$/;

// ───────────────────────────── 数据库端口 ─────────────────────────────

/** 最小查询结果形状：`pg` 的 `QueryResult` 结构可赋值给它。 */
export interface DbResult<Row> {
  readonly rows: readonly Row[];
  readonly rowCount: number | null;
}

/**
 * 最小数据库客户端端口。用方法语法（而非属性箭头）让 `pg` 的 Pool / PoolClient
 * 可直接赋值；同一个写客户端由所有需要事务的服务共享。
 */
export interface DbClient {
  query<Row = Record<string, unknown>>(
    sql: string,
    params?: readonly unknown[],
  ): Promise<DbResult<Row>>;
}

/**
 * 事务级 RLS 上下文；worker_session_id 只由服务端从当前会话填充。
 *
 * `engagementId` 为 `null` 表示**租户级**作用域：只按租户定界的操作（作业列表、
 * skill 库）用它；engagement 作用域的查询在租户级下查不到行。
 */
export interface DbRlsContext {
  readonly tenantId: string;
  readonly engagementId: string | null;
  readonly workerSessionId: string | null;
}

/** 可在同一条连接上为单次查询绑定事务级 RLS 上下文的客户端。 */
export interface RlsAwareDbClient extends DbClient {
  queryWithRlsContext<Row = Record<string, unknown>>(
    context: DbRlsContext,
    sql: string,
    params?: readonly unknown[],
  ): Promise<DbResult<Row>>;
}

/**
 * 共享独占写连接的事务调度器。
 *
 * 组合根把同一条连接交给多个服务；所有服务复用本调度器，避免并发调用交叉
 * `BEGIN`/`COMMIT`。AsyncLocalStorage 区分真正嵌套的事务与并发调用。
 */
export class DbTransactionRunner {
  readonly #db: DbClient;
  readonly #context = new AsyncLocalStorage<true>();
  #queue: Promise<void> = Promise.resolve();

  constructor(db: DbClient) {
    this.#db = db;
  }

  async run<T>(work: (tx: DbClient) => Promise<T>, setup?: (tx: DbClient) => Promise<void>): Promise<T> {
    if (this.#context.getStore() === true) return work(this.#db);
    const execute = async (): Promise<T> => this.#context.run(true, async () => {
      await this.#db.query('begin');
      try {
        await setup?.(this.#db);
        const value = await work(this.#db);
        await this.#db.query('commit');
        return value;
      } catch (error) {
        await this.#db.query('rollback').catch(() => undefined);
        throw error;
      }
    });
    const current = this.#queue.then(execute, execute);
    this.#queue = current.then(() => undefined, () => undefined);
    return current;
  }
}

const TRANSACTION_RUNNERS = new WeakMap<object, DbTransactionRunner>();

/** 同一个写客户端只建立一个事务调度器。 */
export function transactionRunnerFor(db: DbClient): DbTransactionRunner {
  const key = db as object;
  const existing = TRANSACTION_RUNNERS.get(key);
  if (existing !== undefined) return existing;
  const created = new DbTransactionRunner(db);
  TRANSACTION_RUNNERS.set(key, created);
  return created;
}


/** `context_events` 行形状（只列出本模块读写到的列）。 */
export interface ContextEventRow {
  readonly event_id: string;
  readonly chain_seq: number | string;
  readonly prev_hash: Uint8Array | null;
  readonly event_hash: Uint8Array;
  readonly event_type: string;
  readonly source_system: string;
  readonly source_id: string;
  readonly source_seq: number | string;
  readonly occurred_at: Date | string;
  readonly provisional: boolean;
  readonly classification: string;
  readonly trust_level: string;
  readonly payload_json: unknown;
  readonly raw_payload_zstd: Uint8Array;
}

/** 锚点记录：链头摘要 + 事件计数，写入运行时角色不可写的存储（§9.5）。 */
export interface LedgerAnchor {
  readonly engagementId: string;
  readonly chainHead: string;
  readonly eventCount: number;
  readonly batchFromSeq: number;
  readonly batchToSeq: number;
  readonly batchSignature: string;
}

/**
 * 锚点存储端口。`lastEventCount` 把「计数单调递增」变成追加前可判定的信号；
 * `latestAnchor` 供完整性比对（`MemoryLedger.verifyAnchor`）使用。
 */
export interface AnchorSink {
  appendAnchor(anchor: LedgerAnchor): Promise<void>;
  lastEventCount(engagementId: string): Promise<number | null>;
  latestAnchor?(engagementId: string): Promise<LedgerAnchor | null>;
}

/** 批次签名器。默认用注入的密钥对「负载集合 + 作用域」做 HMAC-SHA256。 */
export type BatchSigner = (
  payloads: readonly EventHashPayload[],
  scope: BatchSignatureScope,
) => string;

/** 索引任务入队端口；调用发生在账本事务内。 */
export interface IndexEnqueuePort {
  enqueueInTransaction(
    tx: DbClient,
    input: { readonly engagementId: string; readonly eventIds: readonly string[] },
  ): Promise<void>;
}
export interface TransactionalLedger {
  appendBatchInTransaction(
    tx: DbClient,
    inputs: readonly AppendEventInput[],
  ): Promise<readonly AppendEventResult[]>;
}

/** 账本选项。 */
export interface LedgerOptions {
  readonly db: DbClient;
  readonly txDb?: DbClient;
  readonly secret: LedgerSecret;
  readonly anchors?: AnchorSink;
  readonly sign?: BatchSigner;
  readonly now?: () => Date;
  readonly generateId?: () => string;
  readonly indexOutbox?: IndexEnqueuePort;
}

// ───────────────────────────── 行 ↔ 哈希负载 ─────────────────────────────
function hashBytes(value: Uint8Array): Buffer {
  return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
}

function toHex(value: Uint8Array): string {
  return hashBytes(value).toString('hex');
}

function decodeHash(value: Uint8Array, what: string): Buffer {
  const bytes = hashBytes(value);
  if (bytes.length !== 32) {
    throw new LedgerError('audit_unavailable', `${what} 不是 32 字节 SHA-256 摘要`, `${bytes.length} 字节`);
  }
  return bytes;
}

function toSafeInt(value: number | string, what: string): number {
  const num = typeof value === 'number' ? value : Number(value);
  if (!Number.isSafeInteger(num) || num < 0) {
    throw new LedgerError('audit_unavailable', `${what} 不是非负安全整数`, String(value));
  }
  return num;
}

function toIso(value: Date | string): string {
  const date = value instanceof Date ? value : new Date(value);
  const ms = date.getTime();
  if (Number.isNaN(ms)) {
    throw new LedgerError('audit_unavailable', 'occurred_at 不可解析', String(value));
  }
  return new Date(ms).toISOString();
}

/**
 * 由已入库的行重建哈希负载。必须与写入时用的负载逐字节等值，
 * 否则 `verifyChain()` 会把完好账本判为篡改。
 */
export function hashPayloadFromRow(row: ContextEventRow): EventHashPayload {
  return {
    eventType: row.event_type,
    sourceSystem: row.source_system,
    sourceId: row.source_id,
    sourceSeq: toSafeInt(row.source_seq, 'source_seq'),
    chainSeq: toSafeInt(row.chain_seq, 'chain_seq'),
    occurredAt: toIso(row.occurred_at),
    provisional: row.provisional,
    classification: row.classification as EventHashPayload['classification'],
    trustLevel: row.trust_level as EventHashPayload['trustLevel'],
    payloadJson: row.payload_json,
    rawPayload: hashBytes(row.raw_payload_zstd),
  };
}

// ───────────────────────────── advisory lock ─────────────────────────────

/** 由 engagementId 派生 64 位锁键：高位命名空间，低位 32 位 FNV-1a 指纹。 */
export function engagementLockKey(engagementId: string): bigint {
  let fingerprint = 0x811c_9dc5;
  for (let i = 0; i < engagementId.length; i += 1) {
    fingerprint ^= engagementId.charCodeAt(i);
    fingerprint = Math.imul(fingerprint, 0x0100_0193) >>> 0;
  }
  return (BigInt(ADVISORY_LOCK_NAMESPACE) << 32n) | BigInt(fingerprint);
}

const SQL_ACQUIRE_LOCK = 'select pg_advisory_xact_lock($1)';

const SQL_FIND_EXISTING = `
select event_id, chain_seq, event_hash
  from pentest.context_events
 where engagement_id = $1
   and source_system = $2
   and source_id = $3
   and source_seq = $4`;

const SQL_CHAIN_HEAD = `
select chain_seq, event_hash
  from pentest.context_events
 where engagement_id = $1
 order by chain_seq desc
 limit 1`;

const SQL_EVENT_COUNT = `
select count(*)::bigint as event_count
  from pentest.context_events
 where engagement_id = $1`;

const SQL_INSERT_EVENT = `
insert into pentest.context_events (
  event_id, engagement_id, worker_session_id, dsh_session_id,
  source_system, source_id, source_seq, event_type, schema_version,
  occurred_at, chain_seq, payload_json, raw_payload_zstd, text_projection,
  classification, trust_level, provisional, prev_hash, event_hash
) values (
  $1, $2, $3, null, $4, $5, $6, $7, $8, $9, $10,
  $11::jsonb, $12, null, $13, $14, $15, $16, $17
)
on conflict (engagement_id, source_system, source_id, source_seq) do nothing
returning event_id, chain_seq, event_hash`;

/**
 * 锚点表读写（§9.5「独立角色表」。§9.2 原本未给 DDL，本实现假定下列对象，
 * 已由迁移切片采纳；`ledger.ts` 在事务内额外校验计数严格递增）：
 *
 * ```sql
 * CREATE TABLE pentest.ledger_anchors (
 *   id bigserial PRIMARY KEY, engagement_id uuid NOT NULL,
 *   chain_head bytea NOT NULL, event_count bigint NOT NULL,
 *   batch_from_seq bigint NOT NULL, batch_to_seq bigint NOT NULL,
 *   batch_signature bytea NOT NULL, signed_at timestamptz NOT NULL DEFAULT now(),
 *   CHECK (batch_to_seq >= batch_from_seq));
 * ```
 */
export class PgAnchorSink implements AnchorSink {
  readonly #db: DbClient;

  constructor(db: DbClient) {
    this.#db = db;
  }

  async appendAnchor(anchor: LedgerAnchor): Promise<void> {
    const previous = await this.lastEventCount(anchor.engagementId);
    assertMonotonicCount(previous, anchor.eventCount);
    await this.#db.query(
      `insert into pentest.ledger_anchors (
         engagement_id, chain_head, event_count,
         batch_from_seq, batch_to_seq, batch_signature
       ) values ($1, $2, $3, $4, $5, $6)`,
      [
        anchor.engagementId,
        decodeHash(Buffer.from(anchor.chainHead, 'hex'), 'chain_head'),
        anchor.eventCount,
        anchor.batchFromSeq,
        anchor.batchToSeq,
        Buffer.from(anchor.batchSignature, 'hex'),
      ],
    );
  }

  async lastEventCount(engagementId: string): Promise<number | null> {
    const result = await this.#db.query<{ event_count: number | string }>(
      `select event_count from pentest.ledger_anchors
        where engagement_id = $1 order by id desc limit 1`,
      [engagementId],
    );
    const row = result.rows[0];
    return row === undefined ? null : toSafeInt(row.event_count, 'event_count');
  }

  async latestAnchor(engagementId: string): Promise<LedgerAnchor | null> {
    const result = await this.#db.query<{
      chain_head: Uint8Array;
      event_count: number | string;
      batch_from_seq: number | string;
      batch_to_seq: number | string;
      batch_signature: Uint8Array;
    }>(
      `select chain_head, event_count, batch_from_seq, batch_to_seq, batch_signature
         from pentest.ledger_anchors
        where engagement_id = $1 order by id desc limit 1`,
      [engagementId],
    );
    const row = result.rows[0];
    if (row === undefined) return null;
    return {
      engagementId,
      chainHead: toHex(row.chain_head),
      eventCount: toSafeInt(row.event_count, 'event_count'),
      batchFromSeq: toSafeInt(row.batch_from_seq, 'batch_from_seq'),
      batchToSeq: toSafeInt(row.batch_to_seq, 'batch_to_seq'),
      batchSignature: toHex(row.batch_signature),
    };
  }
}

/**
 * 「计数单调」是检测尾部截断的核心，比链头摘要更重要：删除尾部行之后计数回落，
 * 而链头可能仍然是剩余部分的合法链头。
 */
function assertMonotonicCount(previous: number | null, next: number): void {
  if (previous !== null && next <= previous) {
    throw new LedgerError(
      'audit_unavailable',
      '锚点事件计数未严格递增：检测到账本尾部截断或重复锚点',
      `已锚定 ${previous}，本次准备锚定 ${next}`,
    );
  }
}

/** 内存锚点存储：不提供「运行时角色不可写」的性质，仅用于单测与本地装配。 */
export class InMemoryAnchorSink implements AnchorSink {
  readonly #history: LedgerAnchor[] = [];

  async appendAnchor(anchor: LedgerAnchor): Promise<void> {
    assertMonotonicCount(await this.lastEventCount(anchor.engagementId), anchor.eventCount);
    this.#history.push(anchor);
  }

  async lastEventCount(engagementId: string): Promise<number | null> {
    for (let i = this.#history.length - 1; i >= 0; i -= 1) {
      const anchor = this.#history[i];
      if (anchor !== undefined && anchor.engagementId === engagementId) return anchor.eventCount;
    }
    return null;
  }

  async latestAnchor(engagementId: string): Promise<LedgerAnchor | null> {
    for (let i = this.#history.length - 1; i >= 0; i -= 1) {
      const anchor = this.#history[i];
      if (anchor !== undefined && anchor.engagementId === engagementId) return anchor;
    }
    return null;
  }

  get history(): readonly LedgerAnchor[] {
    return this.#history;
  }
}

// ───────────────────────────── 校验 ─────────────────────────────

function assertAppendInput(input: AppendEventInput): void {
  if (typeof input.engagementId !== 'string' || !ENGAGEMENT_ID_PATTERN.test(input.engagementId)) {
    throw new LedgerError('audit_unavailable', 'engagementId 形状非法', String(input.engagementId));
  }
  // 领域事件类型必须限定在契约词汇表内（§8.2）：写入未注册类型等于让读路径无法解释账本。
  if (!(DOMAIN_EVENT_TYPES as readonly string[]).includes(input.eventType)) {
    throw new LedgerError(
      'classification_rejected',
      '领域事件类型不在契约词汇表内（§8.2）',
      String(input.eventType),
    );
  }
  if (!(CLASSIFICATIONS as readonly string[]).includes(input.classification)) {
    throw new LedgerError('classification_rejected', '分类取值不在契约取值域内', String(input.classification));
  }
  if (!(TRUST_LEVELS as readonly string[]).includes(input.trustLevel)) {
    throw new LedgerError('classification_rejected', '来源可信度取值不在契约取值域内', String(input.trustLevel));
  }
  if (typeof input.sourceSystem !== 'string' || input.sourceSystem === '') {
    throw new LedgerError('audit_unavailable', 'sourceSystem 必须是非空字符串');
  }
  if (typeof input.sourceId !== 'string' || input.sourceId === '') {
    throw new LedgerError('audit_unavailable', 'sourceId 必须是非空字符串');
  }
  if (!Number.isSafeInteger(input.sourceSeq) || input.sourceSeq < 0) {
    throw new LedgerError('audit_unavailable', 'sourceSeq 必须是非负安全整数', String(input.sourceSeq));
  }
  if (!(input.occurredAt instanceof Date) || Number.isNaN(input.occurredAt.getTime())) {
    throw new LedgerError('audit_unavailable', 'occurredAt 必须是有效 Date');
  }
  if (!(input.rawPayload instanceof Uint8Array)) {
    throw new LedgerError('audit_unavailable', 'rawPayload 必须是 Uint8Array');
  }
  if (input.provisional !== undefined && typeof input.provisional !== 'boolean') {
    throw new LedgerError('audit_unavailable', 'provisional 必须是布尔值');
  }
}

// ───────────────────────────── 链校验 ─────────────────────────────

export type ChainFailureKind = 'genesis_prev_hash' | 'broken_link' | 'hash_mismatch' | 'seq_gap';

export interface ChainFailure {
  readonly kind: ChainFailureKind;
  readonly chainSeq: number;
  readonly detail: string;
}

export interface ChainVerification {
  readonly engagementId: string;
  readonly ok: boolean;
  readonly eventCount: number;
  readonly chainHead: string;
  readonly failures: readonly ChainFailure[];
}

export type AnchorMismatch = 'chain_head' | 'event_count';

export interface AnchorCheck {
  readonly engagementId: string;
  readonly ok: boolean;
  readonly chainHead: string;
  readonly eventCount: number;
  readonly anchored: LedgerAnchor | null;
  readonly mismatches: readonly AnchorMismatch[];
}


export class MemoryLedger implements MemoryLedgerService, TransactionalLedger {
  async appendBatchInTransaction(
    tx: DbClient,
    inputs: readonly AppendEventInput[],
  ): Promise<readonly AppendEventResult[]> {
    if (inputs.length === 0) return [];
    const engagementId = inputs[0]!.engagementId;
    for (const input of inputs) {
      assertAppendInput(input);
      if (input.engagementId !== engagementId) throw new LedgerError('audit_unavailable', '一个批次只能属于同一个 engagement');
    }
    await tx.query(SQL_ACQUIRE_LOCK, [engagementLockKey(engagementId).toString()]);
    const head = await tx.query<{ chain_seq: number | string; event_hash: Uint8Array }>(SQL_CHAIN_HEAD, [engagementId]);
    const countRow = await tx.query<{ event_count: number | string }>(SQL_EVENT_COUNT, [engagementId]);
    let eventCount = toSafeInt(countRow.rows[0]?.event_count ?? 0, 'event_count');
    const headRow = head.rows[0];
    let chainSeq = headRow === undefined ? 0 : toSafeInt(headRow.chain_seq, 'chain_seq');
    let previousHash = headRow === undefined ? null : decodeHash(headRow.event_hash, 'event_hash');
    const signed: EventHashPayload[] = [];
    const results: AppendEventResult[] = [];
    const eventIds: string[] = [];
    const batchFromSeq = chainSeq + 1;
    for (const input of inputs) {
      const existing = (await tx.query<{ event_id: string; chain_seq: number | string; event_hash: Uint8Array }>(SQL_FIND_EXISTING, [engagementId, input.sourceSystem, input.sourceId, input.sourceSeq])).rows[0];
      if (existing !== undefined) {
        results.push({ eventId: existing.event_id, chainSeq: toSafeInt(existing.chain_seq, 'chain_seq'), eventHash: toHex(existing.event_hash) });
        continue;
      }
      const nextSeq = chainSeq + 1;
      const payload = this.#hashPayload(input, nextSeq);
      const eventHash = computeEventHash(previousHash, payload);
      const inserted = await tx.query<{ event_id: string; chain_seq: number | string; event_hash: Uint8Array }>(SQL_INSERT_EVENT, [this.#generateId(), engagementId, input.workerSessionId, input.sourceSystem, input.sourceId, input.sourceSeq, input.eventType, EVENT_SCHEMA_VERSION, input.occurredAt.toISOString(), nextSeq, JSON.stringify(input.payload ?? null), Buffer.from(input.rawPayload.buffer, input.rawPayload.byteOffset, input.rawPayload.byteLength), input.classification, input.trustLevel, input.provisional ?? false, previousHash, Buffer.from(eventHash, 'hex')]);
      const row = inserted.rows[0];
      if (row === undefined) throw new LedgerError('audit_unavailable', '账本事件幂等冲突未能在同一事务读回');
      chainSeq = nextSeq;
      previousHash = Buffer.from(eventHash, 'hex');
      eventCount += 1;
      signed.push(payload);
      eventIds.push(row.event_id);
      results.push({ eventId: row.event_id, chainSeq: nextSeq, eventHash });
    }
    if (signed.length > 0 && this.#anchors !== null) {
      const chainHead = previousHash === null ? ZERO_HASH : toHex(previousHash);
      const batchSignature = this.#sign(signed, { engagementId, chainHead, eventCount });
      if (batchSignature.length !== HASH_HEX_LENGTH) throw new LedgerError('audit_unavailable', '批次签名不是 SHA-256 长度的十六进制串');
      await this.#anchors.appendAnchor({ engagementId, chainHead, eventCount, batchFromSeq, batchToSeq: chainSeq, batchSignature });
    }
    if (eventIds.length > 0 && this.#indexOutbox !== null) await this.#indexOutbox.enqueueInTransaction(tx, { engagementId, eventIds });
    return results;
  }
  readonly #db: DbClient;
  readonly #txDb: DbClient;
  readonly #anchors: AnchorSink | null;
  readonly #sign: BatchSigner;
  readonly #secret: LedgerSecret;
  readonly #now: () => Date;
  readonly #generateId: () => string;
  readonly #indexOutbox: IndexEnqueuePort | null;
  readonly #txRunner: DbTransactionRunner;

  constructor(options: LedgerOptions) {
    this.#db = options.db;
    this.#txDb = options.txDb ?? options.db;
    this.#txRunner = transactionRunnerFor(this.#txDb);
    this.#anchors = options.anchors ?? null;
    this.#now = options.now ?? (() => new Date());
    this.#generateId = options.generateId ?? (() => randomUUID());
    this.#indexOutbox = options.indexOutbox ?? null;
    this.#secret = options.secret;
    const secret = options.secret;
    this.#sign = options.sign ?? ((payloads, scope) => signBatch(secret, payloads, scope));
  }

  async appendEvent(input: AppendEventInput): Promise<AppendEventResult> {
    const results = await this.appendBatch([input]);
    const first = results[0];
    if (first === undefined) {
      throw new LedgerError('audit_unavailable', '追加未返回结果');
    }
    return first;
  }

  async appendBatch(inputs: readonly AppendEventInput[]): Promise<readonly AppendEventResult[]> {
    if (inputs.length === 0) return [];
    const engagementId = inputs[0]!.engagementId;
    for (const input of inputs) {
      assertAppendInput(input);
      if (input.engagementId !== engagementId) {
        throw new LedgerError('audit_unavailable', '一个批次只能属于同一个 engagement');
      }
    }

    const results: AppendEventResult[] = [];
    // 只追踪**真正新插入**的事件：重放（命中幂等键）的不入队——它的索引任务
    // 在首次插入时就已入队。若把重放的也算进来，队列里会堆满无意义的重复任务。
    const newlyInserted: string[] = [];
    await this.#withTransaction(async () => {
      await this.#txDb.query(SQL_ACQUIRE_LOCK, [engagementLockKey(engagementId).toString()]);

      const head = await this.#txDb.query<{ chain_seq: number | string; event_hash: Uint8Array }>(
        SQL_CHAIN_HEAD,
        [engagementId],
      );
      const countRow = await this.#txDb.query<{ event_count: number | string }>(SQL_EVENT_COUNT, [
        engagementId,
      ]);
      let eventCount = toSafeInt(countRow.rows[0]?.event_count ?? 0, 'event_count');
      const headRow = head.rows[0];
      let chainSeq = headRow === undefined ? 0 : toSafeInt(headRow.chain_seq, 'chain_seq');
      let prevHash = headRow === undefined ? null : decodeHash(headRow.event_hash, 'event_hash');

      // 2) 尾部截断守卫：删除尾部行后，已锚定的计数大于表中的计数。
      const anchoredCount = this.#anchors === null ? null : await this.#anchors.lastEventCount(engagementId);
      if (anchoredCount !== null && anchoredCount !== eventCount) {
        throw new LedgerError(
          'audit_unavailable',
          '账本事件计数与已锚定计数不一致：检测到尾部截断',
          `已锚定 ${anchoredCount}，账本 ${eventCount}`,
        );
      }

      // 3) 幂等：幂等键就是既有唯一键 (engagement, source_system, source_id, source_seq)。
      const signed: EventHashPayload[] = [];
      const batchFromSeq = chainSeq + 1;
      for (const input of inputs) {
        const replayRow = (
          await this.#txDb.query<{ event_id: string; chain_seq: number | string; event_hash: Uint8Array }>(
            SQL_FIND_EXISTING,
            [engagementId, input.sourceSystem, input.sourceId, input.sourceSeq],
          )
        ).rows[0];
        if (replayRow !== undefined) {
          results.push({
            eventId: replayRow.event_id,
            chainSeq: toSafeInt(replayRow.chain_seq, 'chain_seq'),
            eventHash: toHex(replayRow.event_hash),
          });
          continue;
        }

        const seq = chainSeq + 1;
        const payload = this.#hashPayload(input, seq);
        const eventHash = computeEventHash(prevHash, payload);
        const inserted = await this.#txDb.query<{
          event_id: string;
          chain_seq: number | string;
          event_hash: Uint8Array;
        }>(SQL_INSERT_EVENT, [
          this.#generateId(),
          engagementId,
          input.workerSessionId,
          input.sourceSystem,
          input.sourceId,
          input.sourceSeq,
          input.eventType,
          EVENT_SCHEMA_VERSION,
          input.occurredAt.toISOString(),
          seq,
          JSON.stringify(input.payload ?? null),
          Buffer.from(input.rawPayload.buffer, input.rawPayload.byteOffset, input.rawPayload.byteLength),
          input.classification,
          input.trustLevel,
          input.provisional ?? false,
          prevHash,
          Buffer.from(eventHash, 'hex'),
        ]);
        const row = inserted.rows[0];
        if (row === undefined) {
          // 冲突（`on conflict do nothing`）：幂等键已被并发写入，读回既有结果（§15.3）。
          const raced = (
            await this.#txDb.query<{ event_id: string; chain_seq: number | string; event_hash: Uint8Array }>(
              SQL_FIND_EXISTING,
              [engagementId, input.sourceSystem, input.sourceId, input.sourceSeq],
            )
          ).rows[0];
          if (raced === undefined) {
            throw new LedgerError('audit_unavailable', '追加冲突后未能读回既有事件');
          }
          results.push({
            eventId: raced.event_id,
            chainSeq: toSafeInt(raced.chain_seq, 'chain_seq'),
            eventHash: toHex(raced.event_hash),
          });
          continue;
        }

        chainSeq = seq;
        prevHash = Buffer.from(eventHash, 'hex');
        eventCount += 1;
        signed.push(payload);
        newlyInserted.push(row.event_id);
        results.push({ eventId: row.event_id, chainSeq: seq, eventHash });
      }

      // 4) 每批追加写锚点（不是定期写）：链头摘要 + 事件计数 + 批次签名。
      if (signed.length > 0 && this.#anchors !== null) {
        const chainHead = prevHash === null ? ZERO_HASH : toHex(prevHash);
        const batchSignature = this.#sign(signed, { engagementId, chainHead, eventCount });
        if (batchSignature.length !== HASH_HEX_LENGTH) {
          throw new LedgerError('audit_unavailable', '批次签名不是 SHA-256 长度的十六进制串');
        }
        await this.#anchors.appendAnchor({
          engagementId,
          chainHead,
          eventCount,
          batchFromSeq,
          batchToSeq: chainSeq,
          batchSignature,
        });
      }

      // 5) 同事务入队索引任务（§8.4）：账本写入与索引任务必须原子。
      //
      // 分开提交会留下「事件已落库但永远不被索引」的静默缺口——没有任何东西
      // 会为此报错，只能靠人工比对水位才发现。放在锚点之后是因为锚点是审计
      // 完整性的前提：入队失败时整批回滚，包括锚点。
      if (newlyInserted.length > 0 && this.#indexOutbox !== null) {
        await this.#indexOutbox.enqueueInTransaction(this.#txDb, {
          engagementId,
          eventIds: newlyInserted,
        });
      }
    });

    if (results.length !== inputs.length) {
      throw new LedgerError('audit_unavailable', '追加结果数量与输入不一致');
    }
    return results;
  }

  /** 链头摘要 + 事件计数（计数是检测尾部截断所必需的，§9.5）。 */
  async anchor(engagementId: string): Promise<{ chainHead: string; eventCount: number }> {
    return this.#chainSummary(engagementId);
  }

  /** 读整条链并重算哈希，返回首个断裂位置（§9.5「任一字段改动都能被检出」）。 */
  async verifyChain(engagementId: string): Promise<ChainVerification> {
    const rows = await this.#loadChain(this.#db, engagementId);
    const failures: ChainFailure[] = [];
    let prevStoredHash: string | null = null;
    let prevRecomputed: Buffer | null = null;
    let expectedSeq = 0;
    for (const row of rows) {
      const seq = toSafeInt(row.chain_seq, 'chain_seq');
      if (seq !== expectedSeq + 1) {
        failures.push({
          kind: 'seq_gap',
          chainSeq: seq,
          detail: `期望 chain_seq=${expectedSeq + 1}，实际 ${seq}`,
        });
      }
      expectedSeq = seq;
      const storedPrev = row.prev_hash === null ? null : toHex(row.prev_hash);
      if (storedPrev !== prevStoredHash) {
        failures.push({
          kind: prevStoredHash === null ? 'genesis_prev_hash' : 'broken_link',
          chainSeq: seq,
          detail: `prev_hash=${storedPrev ?? 'null'}，上一行 event_hash=${prevStoredHash ?? 'null'}`,
        });
      }
      const recomputed = computeEventHash(prevRecomputed, hashPayloadFromRow(row));
      const storedHash = toHex(row.event_hash);
      if (recomputed !== storedHash) {
        failures.push({
          kind: 'hash_mismatch',
          chainSeq: seq,
          detail: `重算 ${recomputed}，存储 ${storedHash}`,
        });
      }
      prevStoredHash = storedHash;
      prevRecomputed = Buffer.from(recomputed, 'hex');
    }
    return {
      engagementId,
      ok: failures.length === 0,
      eventCount: rows.length,
      chainHead: prevStoredHash ?? ZERO_HASH,
      failures,
    };
  }

  /** 比对实时链摘要与最新锚点。尾部截断表现为 `event_count` 与 `chain_head` 同时不符。 */
  async verifyAnchor(engagementId: string): Promise<AnchorCheck> {
    if (this.#anchors === null || this.#anchors.latestAnchor === undefined) {
      throw new LedgerError('audit_unavailable', '未装配可读锚点存储，无法校验完整性');
    }
    const live = await this.#chainSummary(engagementId);
    const anchored = await this.#anchors.latestAnchor(engagementId);
    const mismatches: AnchorMismatch[] = [];
    if (anchored !== null) {
      if (anchored.chainHead !== live.chainHead) mismatches.push('chain_head');
      if (anchored.eventCount !== live.eventCount) mismatches.push('event_count');
    }
    return {
      engagementId,
      ok: anchored !== null && mismatches.length === 0,
      chainHead: live.chainHead,
      eventCount: live.eventCount,
      anchored,
      mismatches,
    };
  }

  /** 读取链。写入路径只提供追加；此方法供校验、审计回放与索引器使用。 */
  async readChain(engagementId: string): Promise<readonly ContextEventRow[]> {
    return this.#loadChain(this.#db, engagementId);
  }

  /**
   * 校验某次追加的批次签名（§9.5「每批追加由插件进程用 KMS 托管的密钥做 HMAC」）。
   *
   * 持有密钥的一方（如 `pentest_auditor` 角色对应的审计工具）据此确认：该锚点声明的区间
   * 内确实存在这些事件、链头一致、计数一致。运行时数据库角色不持密钥，因此它即使能改行
   * 也无法补出一个可验证的锚点；尾部截断会让区间内的行数不足，直接校验失败。
   *
   * 本方法校验的是「注入密钥的 HMAC-SHA256」。若装配时换成了别的签名方案（如 KMS 非对称
   * 签名），本方法会返回 `false`——失败即失败，不用未经校验的方案冒充通过。
   */
  async verifyBatchSignature(anchor: LedgerAnchor): Promise<boolean> {
    const rows = await this.#loadChainRange(this.#db, anchor.engagementId, anchor.batchFromSeq, anchor.batchToSeq);
    const expected = anchor.batchToSeq - anchor.batchFromSeq + 1;
    if (expected <= 0 || rows.length !== expected) return false;
    const last = rows[rows.length - 1];
    if (last === undefined) return false;
    // 锚点声明的链头必须就是这批行的链头，否则该锚点未覆盖真实链尾。
    if (anchor.chainHead !== toHex(last.event_hash)) return false;
    return verifyBatch(
      this.#secret,
      rows.map(hashPayloadFromRow),
      anchor.batchSignature,
      {
        engagementId: anchor.engagementId,
        chainHead: toHex(last.event_hash),
        eventCount: anchor.eventCount,
      },
    );
  }

  /** 本实例的时钟（供上层写入 `ingested_at` 之外的关联字段时保持同源）。 */
  now(): Date {
    return this.#now();
  }

  #hashPayload(input: AppendEventInput, chainSeq: number): EventHashPayload {
    return {
      eventType: input.eventType,
      sourceSystem: input.sourceSystem,
      sourceId: input.sourceId,
      sourceSeq: input.sourceSeq,
      chainSeq,
      occurredAt: input.occurredAt.toISOString(),
      provisional: input.provisional ?? false,
      classification: input.classification,
      trustLevel: input.trustLevel,
      payloadJson: input.payload ?? null,
      rawPayload: Buffer.from(input.rawPayload.buffer, input.rawPayload.byteOffset, input.rawPayload.byteLength),
    };
  }

  async #chainSummary(engagementId: string): Promise<{ chainHead: string; eventCount: number }> {
    const head = await this.#db.query<{ chain_seq: number | string; event_hash: Uint8Array }>(SQL_CHAIN_HEAD, [engagementId]);
    const count = await this.#db.query<{ event_count: number | string }>(SQL_EVENT_COUNT, [engagementId]);
    const headRow = head.rows[0];
    return {
      chainHead: headRow === undefined ? ZERO_HASH : toHex(headRow.event_hash),
      eventCount: toSafeInt(count.rows[0]?.event_count ?? 0, 'event_count'),
    };
  }

  async #loadChain(db: DbClient, engagementId: string): Promise<readonly ContextEventRow[]> {
    return this.#loadChainRange(db, engagementId, null, null);
  }

  async #loadChainRange(
    db: DbClient,
    engagementId: string,
    fromSeq: number | null,
    toSeq: number | null,
  ): Promise<readonly ContextEventRow[]> {
    const columns = `select event_id, chain_seq, prev_hash, event_hash, event_type, source_system, source_id,
              source_seq, occurred_at, provisional, classification, trust_level,
              payload_json, raw_payload_zstd
         from pentest.context_events
        where engagement_id = $1`;
    const result =
      fromSeq === null || toSeq === null
        ? await db.query<ContextEventRow>(`${columns} order by chain_seq asc`, [engagementId])
        : await db.query<ContextEventRow>(`${columns} and chain_seq between $2 and $3 order by chain_seq asc`, [engagementId, fromSeq, toSeq]);
    return result.rows;
  }

  /** 事务边界：通过共享调度器串行化独占写连接。 */
  async #withTransaction<T>(run: () => Promise<T>): Promise<T> {
    return this.#txRunner.run(async () => run());
  }
}

