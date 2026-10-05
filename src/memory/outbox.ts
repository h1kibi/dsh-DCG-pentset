/**
 * 索引任务队列（设计文档 §8.4「Streaming RAG 管线」、§15.3、§15.5「索引滞后」，§14.3「启动重扫」）。
 *
 * 模块分工：本文件是**整个队列**——取值表、纯判定（状态机边、退避、滞后状态）与 PostgreSQL
 * 装配都在一起，因为设计文档 §17 的目录里队列就是一个文件（`memory/outbox.ts`）。
 * 规则只写一遍：状态迁移边由 002 的 `outbox_jobs_state_progression` 触发器强制，退避与滞后
 * 判定写在 SQL 的**同一句 UPDATE** 里，不在 JS 里重算，避免两处公式漂移。
 *
 * 表结构（`001_init.sql`）与由此而来的硬约束：
 *
 * - `status CHECK (status IN ('pending','leased','done','dead'))`；
 * - `idempotency_key text NOT NULL UNIQUE` —— **全局唯一**，跨 engagement 也唯一；
 * - `entity_id uuid NOT NULL` —— 目标实体（事件 / 记忆条目 / engagement），本模块不解释其含义；
 * - 无租约令牌列（没有 owner / fencing token），因此**无法做租约围栏**：迟到实例的
 *   `complete` 仍能结算。这是可接受的，因为分块写入按唯一键去重（§8.4「重跑不会产生重复分块」），
 *   重复索引的代价只是白干一遍；反过来（拒绝迟到结算）会让已索引完成的任务永远回到 pending，
 *   变成无限的重复索引循环——两害相权取其轻。
 *
 * 触发器（`002_security.sql`）规定的可更新面：
 *   - 可变列：`status`、`attempts`、`available_at`、`lease_until`、`last_error`；
 *   - 状态迁移边：`pending>leased`、`leased>done`、`leased>dead`、`leased>pending`；
 *   - `done` / `dead` 是**终态**：踏入后一切修改都被拒（所以 `complete`/`fail` 都必须带
 *     `status = 'leased'` 谓词，而不是无条件 UPDATE——否则重放会撞触发器）；
 *   - `idempotency_key`、`job_type`、`entity_id`、`engagement_id` 是冻结列：入队后不可改。
 *
 * 事务与连接（与 `ledger.ts` 的 `txDb` 约定一致）：
 *   - 每个方法都是**单条语句**（`claim` 用 CTE + `FOR UPDATE SKIP LOCKED` 一句完成领取），
 *     因此不需要 `txDb`：调用方把专用连接当 `db` 传进来即可。
 *   - §8.4 要求「追加原始事件 → **同事务**入队索引任务」：把账本事务的连接传给本类即可，
 *     两侧共用同一个 `DbClient` 就是同事务。
 *   - RLS（§9.4）：`outbox_jobs` 是 FORCE RLS，非所有者角色必须已在连接上设置
 *     engagement 上下文（`pentest.set_rls_context`），否则看不见任何行。本模块不代设，
 *     因为它没有事务边界可依附（`pg-lease.ts` 的 `rlsContext` 是挂在事务上的）。
 */

import type { DbClient } from '../db/port.ts';
import { NOTIFY_CHANNEL } from './notify-listener.ts';

// ───────────────────────────── job_type 取值表 ─────────────────────────────
//
// 001 把 `job_type` 定为 `text`（刻意不加 CHECK：索引任务类型会随索引策略演进，加 CHECK 就要为
// 每个新类型做一次迁移）。取值表因此在本模块维护，是入队与领取过滤的唯一闸门。
//
// | job_type | 来源（§） | `entity_id` | 索引器做什么 |
// |---|---|---|---|
// | `index_event` | §8.4 事件追加同事务入队；§8.5 分块策略 | `context_events.event_id` | 分类 → 规范化 → 分块 → 嵌入 → 写 `memory_chunks` |
// | `index_memory_item` | §8.10 压缩摘要作为记忆条目入库；§8.5「压缩摘要」单独成类 | `memory_items.id` | 为不经过 `context_events` 的记忆条目派生分块（`memory_chunks.memory_item_id`） |
// | `reindex_engagement` | §15.5「可按事件水位重建分块与嵌入」 | `engagements.id` | 按水位全量重建；幂等键必须带水位判别值，否则永远只入队一次 |
//
// 新增类型时只改这里，并同步索引器；`isOutboxJobType` 是唯一的判定入口。

const OUTBOX_JOB_TYPES = [
  'index_event',
  'index_memory_item',
  'reindex_engagement',
] as const;
type OutboxJobType = (typeof OUTBOX_JOB_TYPES)[number];

/**
 * 具名常量：**唯一**的字面量出处（`satisfies` 保证它们仍在取值表内，写错即编译失败）。
 *
 * 此前 `dispatcher.ts` 与 `index-enqueue.ts` 各写了一份同名/同值的字面量
 * （第六轮质检）；取值表说「新增类型时只改这里」，那这条也得真的只在这里。
 */
export const INDEX_EVENT_JOB = 'index_event' satisfies OutboxJobType;
export const INDEX_MEMORY_ITEM_JOB = 'index_memory_item' satisfies OutboxJobType;
export const REINDEX_ENGAGEMENT_JOB = 'reindex_engagement' satisfies OutboxJobType;

function isOutboxJobType(value: unknown): value is OutboxJobType {
  return typeof value === 'string' && (OUTBOX_JOB_TYPES as readonly string[]).includes(value);
}

/** 任务状态（与 001 的 CHECK 逐字一致）。 */
const OUTBOX_STATUSES = ['pending', 'leased', 'done', 'dead'] as const;
export type OutboxJobStatus = (typeof OUTBOX_STATUSES)[number];

/** 索引滞后状态（§15.5「索引状态单独展示为就绪、滞后或失败」；与 005 的 `index_watermarks.status` 同词表）。 */
type IndexLagState = 'ready' | 'lagging' | 'failed';

const OUTBOX_DEFAULTS = {
  /** `claim` 单批上限。 */
  claimLimit: 16,
  /** 默认租约长度（秒）。索引一个事件是秒级工作，60 秒留出足够的余量。 */
  leaseSeconds: 60,
  /** 重试上限（§8.4「每个索引任务带租约、重试次数、失败归档」）。 */
  maxAttempts: 5,
  /** 指数退避基数（秒）：第 N 次失败后延迟 `base * factor^(N-1)`。 */
  backoffBaseSeconds: 5,
  backoffFactor: 2,
  /** 退避上限（秒）：15 分钟。 */
  backoffMaxSeconds: 900,
  /** `sweepExpired` 单批上限（§14.3 启动重扫）。 */
  sweepLimit: 100,
} as const;

/** `last_error` 的写入上限：错误文本可能裹着模型响应，不设上限就是一次无界写。 */
export const OUTBOX_MAX_ERROR_LENGTH = 2000;

/** 租约过期被重扫归档时的失败原因（§15.5「索引失败进入失败归档，不删除事件」）。 */
export const LEASE_EXPIRED_ERROR = '租约过期：实例在结算前停止（§14.3 启动重扫归档）';

// ───────────────────────────── 错误 ─────────────────────────────

export type OutboxErrorCode =
  /** 调用参数不合法（uuid、批量、租约秒数、退避参数、错误文本）。 */
  | 'invalid_input'
  /** `job_type` 不在取值表内：调用方与索引器版本不一致。 */
  | 'unknown_job_type'
  /** 数据库返回的行无法解释（id/时间/状态不是预期形状）：宁可抛错也不静默转换。 */
  | 'malformed_row';

export class OutboxError extends Error {
  readonly code: OutboxErrorCode;
  readonly detail: string;

  constructor(code: OutboxErrorCode, message: string, detail = '') {
    super(message);
    this.name = 'OutboxError';
    this.code = code;
    this.detail = detail;
  }
}

// ───────────────────────────── 实体形状 ─────────────────────────────

export interface OutboxJob {
  /** `bigserial` 主键。`pg` 把 int8 解成字符串，这里统一成十进制字符串（比较用 `BigInt`）。 */
  readonly id: string;
  readonly engagementId: string;
  readonly jobType: string;
  readonly entityId: string;
  readonly idempotencyKey: string;
  readonly status: OutboxJobStatus;
  readonly attempts: number;
  readonly availableAt: Date;
  readonly leaseUntil: Date | null;
  readonly lastError: string | null;
  readonly createdAt: Date;
}

/** 已领取的任务：租约必然存在（`claim` 只在写租约的同一句里返回行）。 */
export interface ClaimedJob extends OutboxJob {
  readonly leaseUntil: Date;
}

export interface EnqueueInput {
  readonly engagementId: string;
  readonly jobType: string;
  /** 目标实体标识（事件 / 记忆条目 / engagement）。 */
  readonly entityId: string;
  /** 幂等键。省略时用 {@link deriveIdempotencyKey} 由类型与实体派生。 */
  readonly idempotencyKey?: string;
  /** 最早可领取时间。省略为 `now()`。 */
  readonly availableAt?: Date;
}

export interface EnqueueResult {
  readonly job: OutboxJob;
  /** `true` = 本次调用真的插入了任务；`false` = 幂等命中既有任务。 */
  readonly created: boolean;
}

interface ClaimInput {
  readonly engagementId: string;
  /** 只领这些类型；省略 = 全部类型。 */
  readonly jobTypes?: readonly string[];
  /** 单批上限，默认 {@link OUTBOX_DEFAULTS.claimLimit}。 */
  readonly limit?: number;
  /** 本次租约长度（秒），默认 {@link OUTBOX_DEFAULTS.leaseSeconds}。 */
  readonly leaseSeconds?: number;
}

interface SweepInput {
  /** 判定基准时间；省略用数据库时钟。传入只为确定性（§14.3 启动重扫按真实时钟即可）。 */
  readonly now?: Date;
  /** 单批上限，默认 {@link OUTBOX_DEFAULTS.sweepLimit}。 */
  readonly limit?: number;
  /** 只扫一个 engagement；省略 = 全部（启动重扫是全局的）。 */
  readonly engagementId?: string;
}

export interface OutboxStats {
  readonly engagementId: string;
  readonly counts: Readonly<Record<OutboxJobStatus, number>>;
  /** 未完成量 = `pending + leased`，即「索引落后多少条任务」。 */
  readonly unfinished: number;
  /** 最早可领取时间：滞后起点，供控制台显示时间范围（§15.5）。 */
  readonly oldestPendingAt: Date | null;
  readonly state: IndexLagState;
}

interface IdempotencyKeyInput {
  readonly jobType: string;
  readonly entityId: string;
  /**
   * 判别值：让同一实体的**可重复工作**各自拿到独立的键。
   * `reindex_engagement` 必须给出（例如事件水位），否则同一 engagement 只可能入队一次。
   */
  readonly discriminator?: string;
}

export interface OutboxOptions {
  readonly claimLimit?: number;
  readonly leaseSeconds?: number;
  readonly maxAttempts?: number;
  readonly backoffBaseSeconds?: number;
  readonly backoffFactor?: number;
  readonly backoffMaxSeconds?: number;
  readonly sweepLimit?: number;
}

/** 队列端口。索引器与采集侧依赖它，测试可注入假实现。 */
export interface OutboxQueue {
  enqueue(input: EnqueueInput): Promise<EnqueueResult>;
  /**
   * 在调用方给定的事务连接上入队（§8.4「同事务入队索引任务」）。
   *
   * 接口的一部分而非可选能力：账本追加与索引入队必须原子，任何实现都
   * 必须支持这一点。用自己的连接入队会脱离账本事务，留下静默缺口。
   */
  enqueueInTransaction(tx: DbClient, input: EnqueueInput): Promise<void>;
  claim(input: ClaimInput): Promise<readonly ClaimedJob[]>;
  complete(jobId: string): Promise<boolean>;
  fail(jobId: string, error: string): Promise<OutboxJob | null>;
  sweepExpired(input?: SweepInput): Promise<readonly OutboxJob[]>;
  stats(engagementId: string): Promise<OutboxStats>;
}

// ───────────────────────────── 纯判定 ─────────────────────────────

/**
 * 由（类型、实体、判别值）派生幂等键。
 *
 * 幂等键是**全局唯一**的列，所以它必须同时编码"对哪个实体做什么"，否则跨 engagement 的
 * 相同实体标识会互相顶掉。终态（`done` / `dead`）的任务不会被同键入队重新激活
 * （触发器禁止终态回退），需要重跑时换一个判别值拿到新键——这正是 `discriminator` 的用途。
 */
export function deriveIdempotencyKey(input: IdempotencyKeyInput): string {
  const jobType = assertJobType(input.jobType, 'idempotencyKey.jobType');
  const entityId = assertUuid(input.entityId, 'idempotencyKey.entityId');
  const discriminator = input.discriminator;
  if (discriminator === undefined) return `${jobType}:${entityId}`;
  const trimmed = discriminator.trim();
  if (trimmed.length === 0) {
    throw new OutboxError('invalid_input', '幂等键判别值不得为空白', 'discriminator');
  }
  if (trimmed.length > 200) {
    throw new OutboxError('invalid_input', '幂等键判别值过长（上限 200 字符）', String(trimmed.length));
  }
  return `${jobType}:${entityId}:${trimmed}`;
}

/**
 * 索引滞后状态（§15.5）。判定顺序即优先级：
 *   1. 有死信 → `failed`（失败归档是必须人工处置的状态，不能被"同时还有待办"盖过去）；
 *   2. 有未完成任务（`pending + leased`）→ `lagging`；
 *   3. 否则 → `ready`。
 * `done` 只增不减，不代表滞后。
 */
export function indexLagState(counts: Readonly<Record<OutboxJobStatus, number>>): IndexLagState {
  if (counts.dead > 0) return 'failed';
  if (counts.pending + counts.leased > 0) return 'lagging';
  return 'ready';
}

// ───────────────────────────── 校验 ─────────────────────────────

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const JOB_ID_PATTERN = /^[0-9]{1,19}$/;

function assertUuid(value: unknown, what: string): string {
  if (typeof value !== 'string' || !UUID_PATTERN.test(value)) {
    throw new OutboxError('invalid_input', `${what} 必须是 uuid`, String(value));
  }
  return value;
}

function assertJobType(value: unknown, what: string): OutboxJobType {
  if (!isOutboxJobType(value)) {
    throw new OutboxError(
      'unknown_job_type',
      `${what} 不在取值表内`,
      `取值表：${OUTBOX_JOB_TYPES.join(', ')}；收到 ${String(value)}`,
    );
  }
  return value;
}

function assertPositiveInteger(value: unknown, what: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
    throw new OutboxError('invalid_input', `${what} 必须是 >= 1 的整数`, String(value));
  }
  return value;
}

function assertJobId(value: unknown): string {
  if (typeof value !== 'string' || !JOB_ID_PATTERN.test(value)) {
    throw new OutboxError('invalid_input', 'jobId 必须是十进制任务标识', String(value));
  }
  return value;
}

function assertNonEmptyText(value: unknown, what: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new OutboxError('invalid_input', `${what} 不得为空`, String(value));
  }
  return value;
}

/** 错误文本裁剪：保头留尾注，既保留诊断信息又给写入定界。 */
function normalizeError(error: string): string {
  const trimmed = assertNonEmptyText(error, 'fail 的错误描述').trim();
  if (trimmed.length <= OUTBOX_MAX_ERROR_LENGTH) return trimmed;
  return `${trimmed.slice(0, OUTBOX_MAX_ERROR_LENGTH)}…（已截断，原始长度 ${trimmed.length}）`;
}

function assertJobTypesFilter(value: readonly string[] | undefined): string[] | null {
  if (value === undefined) return null;
  if (value.length === 0) {
    throw new OutboxError('invalid_input', 'jobTypes 不得为空数组（省略表示全部类型）', '');
  }
  return value.map((entry) => assertJobType(entry, 'jobTypes[]'));
}

// ───────────────────────────── 行映射 ─────────────────────────────

interface OutboxJobRow {
  readonly id: string | number;
  readonly engagement_id: string;
  readonly job_type: string;
  readonly entity_id: string;
  readonly idempotency_key: string;
  readonly status: string;
  readonly attempts: number | string;
  readonly available_at: Date | string;
  readonly lease_until: Date | string | null;
  readonly last_error: string | null;
  readonly created_at: Date | string;
}

function jobColumns(alias = ''): string {
  const p = alias === '' ? '' : `${alias}.`;
  return `${p}id, ${p}engagement_id, ${p}job_type, ${p}entity_id, ${p}idempotency_key,
          ${p}status, ${p}attempts, ${p}available_at, ${p}lease_until, ${p}last_error, ${p}created_at`;
}

function toJobId(value: string | number): string {
  const text = typeof value === 'string' ? value : String(value);
  if (!JOB_ID_PATTERN.test(text)) {
    throw new OutboxError('malformed_row', '任务标识不是十进制整数', text);
  }
  return text;
}

function toNonNegativeInteger(value: number | string, what: string): number {
  const num = typeof value === 'number' ? value : Number(value);
  if (!Number.isSafeInteger(num) || num < 0) {
    throw new OutboxError('malformed_row', `${what} 不是非负整数`, String(value));
  }
  return num;
}

function toDate(value: Date | string, what: string): Date {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new OutboxError('malformed_row', `${what} 不是可解析时间`, String(value));
  }
  return date;
}

function toStatus(value: string): OutboxJobStatus {
  if (!(OUTBOX_STATUSES as readonly string[]).includes(value)) {
    throw new OutboxError('malformed_row', 'status 不在取值域内', value);
  }
  return value as OutboxJobStatus;
}

function toJob(row: OutboxJobRow): OutboxJob {
  return {
    id: toJobId(row.id),
    engagementId: row.engagement_id,
    jobType: row.job_type,
    entityId: row.entity_id,
    idempotencyKey: row.idempotency_key,
    status: toStatus(row.status),
    attempts: toNonNegativeInteger(row.attempts, 'attempts'),
    availableAt: toDate(row.available_at, 'available_at'),
    leaseUntil: row.lease_until === null ? null : toDate(row.lease_until, 'lease_until'),
    lastError: row.last_error,
    createdAt: toDate(row.created_at, 'created_at'),
  };
}

/** 领取顺序：`available_at` 升序、同刻按 id 升序（与 SQL 的 `order by available_at, id` 一致）。 */
function compareClaimOrder(a: OutboxJob, b: OutboxJob): number {
  const byTime = a.availableAt.getTime() - b.availableAt.getTime();
  if (byTime !== 0) return byTime;
  const left = BigInt(a.id);
  const right = BigInt(b.id);
  return left < right ? -1 : left > right ? 1 : 0;
}

// ───────────────────────────── SQL ─────────────────────────────
//
// 列名与 001_init.sql 逐字一致：出问题时能直接与 DDL 对照。

const SQL_ENQUEUE = `
insert into pentest.outbox_jobs (
  engagement_id, job_type, entity_id, idempotency_key, status, attempts, available_at
) values ($1::uuid, $2, $3::uuid, $4, 'pending', 0, coalesce($5::timestamptz, now()))
on conflict (idempotency_key) do nothing
returning ${jobColumns()}`;

/**
 * 发布唤醒通知（§8.4）。
 *
 * **必须在写 outbox_jobs 的同一事务内调用**。`NOTIFY` 是事务性的：提交时才投递、
 * 回滚时一条都不发、同事务内相同（通道 + 负载）的通知折叠为一条。因此放在同一
 * 事务里既保证「任务真的入队了才唤醒」，也天然去掉重复。
 *
 * 负载只用任务标识/engagement，不塞内容——`NOTIFY` 的负载上限是 8000 字节，
 * 而通知本身**只是延迟优化**：丢了只晚一个周期，周期扫描与启动重扫才是可靠性来源。
 *
 * 通道名用双引号包起来（标识符转义），让它与订阅侧的字符串逐字相同：
 * `LISTEN` 的标识符会被折叠为小写，而 `pg_notify` 的字符串区分大小写，
 * 两侧写法不同就会订阅到一个永远收不到消息的通道**且不报任何错**。
 */
const SQL_NOTIFY = `select pg_notify('${NOTIFY_CHANNEL}', $1)`;

/** 通知负载：小且可诊断。订阅侧有意不解析它（见 notify-listener 的说明）。 */
function notifyPayload(engagementId: string, jobType: string): string {
  return `${engagementId}:${jobType}`;
}

/**
 * 幂等命中后的回查。
 *
 * `ON CONFLICT DO NOTHING` 不加 `WHERE`：若并发事务正在插入同一个键，本语句会等它提交，
 * 因此回查一定能看到已提交的行。回查按**键**（唯一索引的列）取，不按 entity：键就是任务身份。
 */
const SQL_BY_IDEMPOTENCY_KEY = `
select ${jobColumns()}
  from pentest.outbox_jobs
 where idempotency_key = $1`;

/**
 * 领取（§8.4「按租约领取任务」，§15.4「索引器可以并行工作」）。
 *
 * `FOR UPDATE SKIP LOCKED` 是**必须**的：没有它，两个索引器实例会互相阻塞（或其中一个空转超时），
 * 有了它，被别的实例锁住的行直接跳过，各领各的。跳过发生在 SQL 层（LockRows 节点），
 * 不在应用层重试，因此不存在"先读后写"的竞态窗口。
 *
 * 可领取 = `available_at <= now()` 且（`pending` 或 `leased` 且租约已过期）。
 * **过期租约必须可重领**：否则索引器进程崩溃后任务永久卡在 `leased`——`lease_until` 过期是
 * 唯一的崩溃信号（本表没有心跳列）。
 */
const SQL_CLAIM = `
with picked as (
  select j.id
    from pentest.outbox_jobs j
   where j.engagement_id = $1::uuid
     and j.available_at <= now()
     and (j.status = 'pending' or (j.status = 'leased' and j.lease_until < now()))
     and ($2::text[] is null or j.job_type = any($2::text[]))
   order by j.available_at, j.id
   limit $3::integer
     for update skip locked
)
update pentest.outbox_jobs t
   set status = 'leased',
       attempts = t.attempts + 1,
       lease_until = now() + make_interval(secs => $4::double precision)
  from picked
 where t.id = picked.id
returning ${jobColumns('t')}`;

/**
 * 结算成功。`status = 'leased'` 谓词同时承担两件事：
 *   - 幂等：重复结算（崩溃重放、两个实例都完成了同一任务）第二次影响 0 行，返回 `false`
 *     而不是撞上"终态不可改写"的触发器；
 *   - 不改写终态：已 `done` / `dead` 的行根本不进 UPDATE 的候选集。
 * 租约在结算时清空：`lease_until` 非空且状态为终态只会让诊断读错。
 */
const SQL_COMPLETE = `
update pentest.outbox_jobs t
   set status = 'done',
       lease_until = null
 where t.id = $1::bigint and t.status = 'leased'
returning t.id`;

/**
 * 结算失败：未到重试上限则回 `pending` 并按指数退避推迟 `available_at`，
 * 到上限则转 `dead`（失败归档，**不删除事件**，§15.5）。
 *
 * 退避公式：`now() + min(base * factor^(attempts-1), max)`，在**这一句里**用 `attempts` 的
 * 现值算。不能改成"先读 attempts 再在 JS 里算"：那是两个语句之间的读改写窗口，
 * 而这里 `attempts` 已经在领取时加过 1，现值就是"已消耗的尝试次数"。
 * 转 `dead` 时 `available_at` 保持原值——死信不再按它调度，改动只会让归档时间失真。
 */
const SQL_FAIL = `
update pentest.outbox_jobs t
   set status = case when t.attempts >= $2::integer then 'dead' else 'pending' end,
       available_at = case
         when t.attempts >= $2::integer then t.available_at
         else now() + make_interval(secs => least(
                $3::double precision * power($4::double precision, greatest(t.attempts - 1, 0)),
                $5::double precision))
       end,
       lease_until = null,
       last_error = $6
 where t.id = $1::bigint and t.status = 'leased'
returning ${jobColumns('t')}`;

/**
 * 启动重扫（§14.3「实例启动后必须扫描未完成任务，不能依赖启动前收到的通知」）。
 *
 * 与 `claim` 的关系：`claim` 只看"租约过期即可重领"，而重扫负责**把状态也拉回来**
 * （`leased` → `pending`），让停滞任务在诊断里看得见、并按 `pending` 重新排队。
 * 两者都带 `FOR UPDATE SKIP LOCKED`，可以同时跑而不互锁。
 *
 * 崩溃循环要有界：`attempts` 已达上限的过期任务直接归档为 `dead`，否则一个"一领到就崩"的
 * 任务会被无限重领（每次崩溃都会让 `attempts` 加 1，但没有 `fail()` 来执行上限判定）。
 * 归档理由只在死信时写入，普通退回不动既有 `last_error`（那是上一次真实失败的原因）。
 */
const SQL_SWEEP = `
with expired as (
  select t.id, t.attempts
    from pentest.outbox_jobs t
   where t.status = 'leased'
     and t.lease_until < coalesce($1::timestamptz, now())
     and ($3::uuid is null or t.engagement_id = $3::uuid)
   order by t.lease_until, t.id
   limit $2::integer
     for update skip locked
)
update pentest.outbox_jobs t
   set status = case when expired.attempts >= $4::integer then 'dead' else 'pending' end,
       available_at = coalesce($1::timestamptz, now()),
       lease_until = null,
       last_error = case
         when expired.attempts >= $4::integer
         then coalesce(nullif(t.last_error, ''), $5)
         else t.last_error
       end
  from expired
 where t.id = expired.id
returning ${jobColumns('t')}`;

/** §15.5 诊断计数：按状态分组，并给出最早可领取时间作为滞后起点。 */
const SQL_STATS = `
select status, count(*)::bigint as job_count,
       min(available_at) filter (where status = 'pending') as oldest_pending_at
  from pentest.outbox_jobs
 where engagement_id = $1::uuid
 group by status`;

// ───────────────────────────── PostgreSQL 装配 ─────────────────────────────

export class PgOutboxQueue implements OutboxQueue {
  readonly #db: DbClient;
  readonly #options: Required<OutboxOptions>;

  constructor(db: DbClient, options: OutboxOptions = {}) {
    this.#db = db;
    this.#options = {
      claimLimit: assertPositiveInteger(options.claimLimit ?? OUTBOX_DEFAULTS.claimLimit, 'claimLimit'),
      leaseSeconds: assertPositiveInteger(
        options.leaseSeconds ?? OUTBOX_DEFAULTS.leaseSeconds,
        'leaseSeconds',
      ),
      maxAttempts: assertPositiveInteger(
        options.maxAttempts ?? OUTBOX_DEFAULTS.maxAttempts,
        'maxAttempts',
      ),
      backoffBaseSeconds: assertPositiveInteger(
        options.backoffBaseSeconds ?? OUTBOX_DEFAULTS.backoffBaseSeconds,
        'backoffBaseSeconds',
      ),
      backoffFactor: options.backoffFactor ?? OUTBOX_DEFAULTS.backoffFactor,
      backoffMaxSeconds: assertPositiveInteger(
        options.backoffMaxSeconds ?? OUTBOX_DEFAULTS.backoffMaxSeconds,
        'backoffMaxSeconds',
      ),
      sweepLimit: assertPositiveInteger(options.sweepLimit ?? OUTBOX_DEFAULTS.sweepLimit, 'sweepLimit'),
    };
    if (!Number.isFinite(this.#options.backoffFactor) || this.#options.backoffFactor < 1) {
      throw new OutboxError('invalid_input', 'backoffFactor 必须是 >= 1 的数', String(options.backoffFactor));
    }
    if (this.#options.backoffMaxSeconds < this.#options.backoffBaseSeconds) {
      throw new OutboxError(
        'invalid_input',
        'backoffMaxSeconds 不得小于 backoffBaseSeconds',
        `${this.#options.backoffMaxSeconds} < ${this.#options.backoffBaseSeconds}`,
      );
    }
  }

  /** 当前生效的配置（诊断用；不含数据库客户端）。 */
  get options(): Required<OutboxOptions> {
    return { ...this.#options };
  }

  /**
   * 入队（§8.4「同事务入队索引任务」）。幂等：同键重复入队返回既有任务，`created=false`。
   * 既有任务若属于别的 engagement、或类型/实体与本次不同，说明调用方复用了全局唯一的键
   * 去表达另一件事——静默返回别的任务会让调用方以为自己的任务已入队，因此这里抛错。
   */
  async enqueue(input: EnqueueInput): Promise<EnqueueResult> {
    const engagementId = assertUuid(input.engagementId, 'enqueue.engagementId');
    const entityId = assertUuid(input.entityId, 'enqueue.entityId');
    const jobType = assertJobType(input.jobType, 'enqueue.jobType');
    const idempotencyKey =
      input.idempotencyKey === undefined
        ? deriveIdempotencyKey({ jobType, entityId })
        : assertNonEmptyText(input.idempotencyKey, 'enqueue.idempotencyKey').trim();
    if (idempotencyKey.length > 200) {
      throw new OutboxError('invalid_input', '幂等键过长（上限 200 字符）', String(idempotencyKey.length));
    }

    const inserted = await this.#db.query<OutboxJobRow>(SQL_ENQUEUE, [
      engagementId,
      jobType,
      entityId,
      idempotencyKey,
      input.availableAt ?? null,
    ]);
    const created = inserted.rows[0];
    if (created !== undefined) {
      // 真的插入了才通知：命中幂等（任务已存在）时不发——那条任务早就通知过
      await this.#db.query(SQL_NOTIFY, [notifyPayload(engagementId, jobType)]);
      return { job: toJob(created), created: true };
    }

    const existing = await this.#db.query<OutboxJobRow>(SQL_BY_IDEMPOTENCY_KEY, [idempotencyKey]);
    const row = existing.rows[0];
    if (row === undefined) {
      // 键已被占用却读不回来：RLS 把别的 engagement 的行藏了起来（§9.4）。
      throw new OutboxError(
        'invalid_input',
        '幂等键已被占用但当前上下文不可见（可能属于其他 engagement）',
        idempotencyKey,
      );
    }
    if (row.engagement_id !== engagementId || row.job_type !== jobType || row.entity_id !== entityId) {
      throw new OutboxError(
        'invalid_input',
        '幂等键已被另一个任务占用：同一键不能表达两件事',
        `键 ${idempotencyKey} 属于 ${row.job_type}/${row.entity_id}@${row.engagement_id}`,
      );
    }
    return { job: toJob(row), created: false };
  }

  /**
   * 在**调用方给定的事务连接**上入队（§8.4「同事务入队索引任务」）。
   *
   * 与 {@link enqueue} 的唯一差别是使用传入的 `tx` 而不是本实例的连接。
   * 为什么必须有这个方法：账本追加与索引入队必须原子——若入队用自己的连接，
   * 它就脱离了账本事务，进程在两者之间崩溃会留下「事件已落库但永远不被索引」
   * 的静默缺口，而这种缺口不报错，只能靠比对水位发现。
   *
   * 返回仅表示「语句已在本事务内执行」；**真正的可见性取决于调用方提交**。
   * 因此这里不返回 `created` 语义（未提交时无法可靠判定是新建还是命中既有）。
   */
  async enqueueInTransaction(
    tx: DbClient,
    input: EnqueueInput,
  ): Promise<void> {
    const engagementId = assertUuid(input.engagementId, 'enqueueInTransaction.engagementId');
    const entityId = assertUuid(input.entityId, 'enqueueInTransaction.entityId');
    const jobType = assertJobType(input.jobType, 'enqueueInTransaction.jobType');
    const idempotencyKey =
      input.idempotencyKey === undefined
        ? deriveIdempotencyKey({ jobType, entityId })
        : assertNonEmptyText(input.idempotencyKey, 'enqueueInTransaction.idempotencyKey').trim();
    if (idempotencyKey.length > 200) {
      throw new OutboxError('invalid_input', '幂等键过长（上限 200 字符）', String(idempotencyKey.length));
    }
    // `ON CONFLICT DO NOTHING`：重复入队（例如同一事件被重放）不报错也不重复建任务。
    // 这里不做命中回查——回查在未提交事务里看不到并发插入的行，回查本身不可靠。
    const inserted = await tx.query(SQL_ENQUEUE, [
      engagementId,
      jobType,
      entityId,
      idempotencyKey,
      input.availableAt ?? null,
    ]);
    // 同一事务内发通知：提交才投递、回滚不发（见 SQL_NOTIFY 的说明）。
    // 只在本事务真的插入了行时发——`ON CONFLICT` 命中说明任务早已存在且已通知过。
    if ((inserted.rowCount ?? inserted.rows.length) > 0) {
      await tx.query(SQL_NOTIFY, [notifyPayload(engagementId, jobType)]);
    }
  }

  /** 领取一批任务：`pending` 或租约已过期的 `leased`，按 `available_at` 升序。 */
  async claim(input: ClaimInput): Promise<readonly ClaimedJob[]> {
    const engagementId = assertUuid(input.engagementId, 'claim.engagementId');
    const limit = assertPositiveInteger(input.limit ?? this.#options.claimLimit, 'claim.limit');
    const leaseSeconds = assertPositiveInteger(
      input.leaseSeconds ?? this.#options.leaseSeconds,
      'claim.leaseSeconds',
    );
    const jobTypes = assertJobTypesFilter(input.jobTypes);

    const result = await this.#db.query<OutboxJobRow>(SQL_CLAIM, [
      engagementId,
      jobTypes,
      limit,
      leaseSeconds,
    ]);
    const jobs = result.rows.map(toJob).sort(compareClaimOrder);
    return jobs.map((job) => {
      if (job.leaseUntil === null) {
        throw new OutboxError('malformed_row', '领取结果缺少租约', job.id);
      }
      return { ...job, leaseUntil: job.leaseUntil };
    });
  }

  /** 结算为 `done`。返回本次调用是否真的完成了结算（重复结算为 `false`，不抛错）。 */
  async complete(jobId: string): Promise<boolean> {
    const id = assertJobId(jobId);
    const result = await this.#db.query<{ id: string | number }>(SQL_COMPLETE, [id]);
    return result.rows.length > 0;
  }

  /**
   * 结算失败。返回结算后的行（调用方据 `status` 判断是否已进失败归档），
   * 若任务不在租约内（已被结算、从未领取、或本就处终态）返回 `null`。
   */
  async fail(jobId: string, error: string): Promise<OutboxJob | null> {
    const id = assertJobId(jobId);
    const message = normalizeError(error);
    const result = await this.#db.query<OutboxJobRow>(SQL_FAIL, [
      id,
      this.#options.maxAttempts,
      this.#options.backoffBaseSeconds,
      this.#options.backoffFactor,
      this.#options.backoffMaxSeconds,
      message,
    ]);
    const row = result.rows[0];
    return row === undefined ? null : toJob(row);
  }

  /** 重扫过期租约（§14.3 启动重扫）。返回被改动的任务行。 */
  async sweepExpired(input: SweepInput = {}): Promise<readonly OutboxJob[]> {
    const limit = assertPositiveInteger(input.limit ?? this.#options.sweepLimit, 'sweep.limit');
    const engagementId =
      input.engagementId === undefined ? null : assertUuid(input.engagementId, 'sweep.engagementId');
    const now = input.now;
    if (now !== undefined && Number.isNaN(now.getTime())) {
      throw new OutboxError('invalid_input', 'sweep.now 不是可解析时间', String(now));
    }
    const result = await this.#db.query<OutboxJobRow>(SQL_SWEEP, [
      now ?? null,
      limit,
      engagementId,
      this.#options.maxAttempts,
      LEASE_EXPIRED_ERROR,
    ]);
    return result.rows.map(toJob).sort(compareClaimOrder);
  }

  /** 按状态计数与滞后状态（§15.5）。 */
  async stats(engagementId: string): Promise<OutboxStats> {
    const id = assertUuid(engagementId, 'stats.engagementId');
    const result = await this.#db.query<{
      status: string;
      job_count: number | string;
      oldest_pending_at: Date | string | null;
    }>(SQL_STATS, [id]);

    const counts: Record<OutboxJobStatus, number> = { pending: 0, leased: 0, done: 0, dead: 0 };
    let oldestPendingAt: Date | null = null;
    for (const row of result.rows) {
      const status = toStatus(row.status);
      counts[status] = toNonNegativeInteger(row.job_count, `${status} 计数`);
      if (status === 'pending' && row.oldest_pending_at !== null) {
        oldestPendingAt = toDate(row.oldest_pending_at, 'oldest_pending_at');
      }
    }
    return {
      engagementId: id,
      counts,
      unfinished: counts.pending + counts.leased,
      oldestPendingAt,
      state: indexLagState(counts),
    };
  }
}
