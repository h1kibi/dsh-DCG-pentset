/**
 * 索引调度器：消费 outbox 队列，把每个任务交给索引器。
 *
 * 设计依据：docs/dsh-pentest-plugin-design.md §8.4（Streaming RAG 管线）、
 * §14.3（多实例与启动重扫）、§15.5（索引滞后）
 *
 * ── 这个模块补的是什么缺口 ──
 *
 * outbox 会入队、索引器会索引，但两者之间缺一个**消费者**：
 * 没有它，队列只进不出，`memory_chunks` 永远为空，检索面恒返回空。
 *
 * ── 三个设计决定 ──
 *
 * 1. **任务驱动，不是水位驱动**。水位是 `runOnce` 的重建路径用的；日常索引
 *    走队列，因为队列提供了水位给不了的东西：按事件的失败隔离、指数退避、
 *    死信归档。一个坏事件不会拖住同批的其它事件，且它的失败是**可见**的。
 *
 * 2. **未实现的任务类型必须失败，不得静默完成**。`index_memory_item` 目前
 *    没有实现，调度器会让它走重试直至死信——那在控制台的索引状态里是可见的
 *    （`stats().state === 'failed'`）。静默 `complete` 会让「有一类任务从未被
 *    处理」这件事永远查不出来。这与 §16.5「不把拒绝渲染为成功」是同一条原则。
 *
 * 3. **不吞异常**。每个任务的失败都交给 `fail(jobId, error)` 并回调
 *    `onJobFailure`，绝不因为「循环要继续」而丢弃错误。索引失败影响的是
 *    检索完整性，那是必须可观测的。
 *
 * ── 与水位的关系（容易误解，特别说明） ──
 *
 * **运行期的索引滞后看 outbox 统计，不看水位**。
 *
 *   指标                    含义
 *   ─────────────────────  ──────────────────────────────────────────
 *   `outbox.stats()`       运行期滞后：pending/leased/dead 计数（权威）
 *   `indexer.watermark()`  重建进度：仅 `reindex_engagement` 期间有意义
 *
 * 为什么不把任务驱动的进度也写进水位：水位是一个**链序号**，只有在「到该序号
 * 为止的事件全部已索引」时才有意义。任务可以乱序完成（事件 5 成功而事件 3 失败），
 * 此时把水位推到 5 会谎报「3 也索引好了」。要正确计算连续前缀，需要知道未完成
 * 任务的集合——而那正是 outbox 统计已经提供的东西。两套机制重复表达同一事实
 * 只会分叉，因此这里明确分工。
 */

import type { DbClient } from './ledger.ts';
import { deriveIdempotencyKey, INDEX_EVENT_JOB, INDEX_MEMORY_ITEM_JOB, REINDEX_ENGAGEMENT_JOB } from './outbox.ts';
import type { OutboxQueue, ClaimedJob } from './outbox.ts';
import { INDEX_STRATEGY_VERSION } from './indexer.ts';
import type { MemoryIndexer, IndexEventResult } from './indexer.ts';

/**
 * 单次重建的批预算：`REINDEX_BATCH_BUDGET` 批 × `runOnce` 的 100 事件上限
 * = 一个回合最多处理 5000 个事件。**不是**「建完了」的判据——用满即抛错走重试，
 * 重试从水位断点续跑（见 `#reindex`）。
 */
export const REINDEX_BATCH_BUDGET = 50;

/**
 * 单个任务的处理结论。
 *
 * 结构化字段（`chunksInserted`）与人类可读的 `detail` 并存，而不是把数字编进
 * 字符串再解析出来：字符串解析是脆弱的（改一处措辞就让统计静默归零），而
 * 统计数字应当由类型保证。
 */
export type JobOutcome =
  | {
      readonly kind: 'done';
      readonly detail: string;
      /** 本次实际写入的分块数，供吞吐统计。 */
      readonly chunksInserted: number;
    }
  /** 未实现或不可处理：走重试直至死信，从而在索引状态里可见。 */
  | { readonly kind: 'unsupported'; readonly detail: string };

export interface DispatcherDeps {
  readonly outbox: OutboxQueue;
  readonly indexer: MemoryIndexer;
  /** 读库：用于发现有待办任务的 engagement。 */
  readonly db: DbClient;
  /** 每个任务失败时的回调，供接入日志与指标（原始错误不丢）。 */
  readonly onJobFailure?: (
    job: ClaimedJob,
    error: unknown,
  ) => void;
  /** 每个任务成功时的回调，便于统计吞吐（可选）。 */
  readonly onJobDone?: (job: ClaimedJob, detail: string) => void;
  /**
   * RLS 作用域。
   *
   * **必须有**：`engagementsWithWork` 读 `outbox_jobs`，那张表没有租户级放行。
   * 没有作用域时它扫到零行——索引队列会**只进不出**，`memory_chunks` 永远为空，
   * 检索面恒返回空，而所有日志看起来都正常。
   *
   * `listEngagementIds` 在**租户级**列出作业；`run` 逐作业建立作用域。
   */
  readonly rlsScope?: {
    run<T>(
      scope: { readonly engagementId?: string | null; readonly workerSessionId?: string | null },
      work: () => Promise<T>,
    ): Promise<T>;
    listEngagementIds: () => Promise<readonly string[]>;
  };
}

export interface DispatchBatchResult {
  readonly engagementId: string;
  readonly claimed: number;
  readonly completed: number;
  readonly failed: number;
  /** 本批里遇到的不支持类型（去重）。 */
  readonly unsupportedTypes: readonly string[];
  /** 每个事件索引插入的分块数之和。 */
  readonly chunksInserted: number;
}

export interface DrainResult {
  readonly engagementId: string;
  readonly batches: number;
  readonly claimed: number;
  readonly completed: number;
  readonly failed: number;
  /** 达到批次数上限时仍可能有待办——据此决定是否继续排空。 */
  readonly exhaustedBudget: boolean;
}

export class IndexDispatcher {
  readonly #outbox: OutboxQueue;
  readonly #indexer: MemoryIndexer;
  readonly #db: DbClient;
  readonly #onJobFailure: DispatcherDeps['onJobFailure'];
  readonly #onJobDone: DispatcherDeps['onJobDone'];
  readonly #scopes: DispatcherDeps['rlsScope'];

  constructor(deps: DispatcherDeps) {
    this.#outbox = deps.outbox;
    this.#indexer = deps.indexer;
    this.#db = deps.db;
    this.#onJobFailure = deps.onJobFailure;
    this.#onJobDone = deps.onJobDone;
    this.#scopes = deps.rlsScope;
  }

  /**
   * 处理一个 engagement 的一批任务。
   *
   * 只在 `index_event` 上使用按事件的租约长度；领取的租约应显著长于单事件
   * 的索引耗时，否则健康实例会与自己的过期租约竞争同一条任务。
   */
  async dispatchBatch(
    engagementId: string,
    options: { readonly limit?: number; readonly leaseSeconds?: number } = {},
  ): Promise<DispatchBatchResult> {
    const jobs = await this.#outbox.claim({
      engagementId,
      ...(options.limit === undefined ? {} : { limit: options.limit }),
      ...(options.leaseSeconds === undefined ? {} : { leaseSeconds: options.leaseSeconds }),
    });

    let completed = 0;
    let failed = 0;
    let chunksInserted = 0;
    const unsupported = new Set<string>();

    for (const job of jobs) {
      try {
        const outcome = await this.#handle(job);
        if (outcome.kind === 'unsupported') {
          unsupported.add(job.jobType);
          // 走失败路径：重试直至死信，从而在索引状态里可见（见文件头决定 2）
          await this.#outbox.fail(job.id, `不支持的任务类型 ${job.jobType}：${outcome.detail}`);
          failed += 1;
          this.#onJobFailure?.(job, new Error(outcome.detail));
          continue;
        }
        const done = await this.#outbox.complete(job.id);
        if (done) {
          completed += 1;
          chunksInserted += outcome.chunksInserted;
          this.#onJobDone?.(job, outcome.detail);
        }
      } catch (error) {
        failed += 1;
        const message = error instanceof Error ? error.message : String(error);
        // 失败必须落到队列上（退避/死信），且原始错误交给回调——不吞
        await this.#outbox.fail(job.id, message);
        this.#onJobFailure?.(job, error);
      }
    }

    return {
      engagementId,
      claimed: jobs.length,
      completed,
      failed,
      unsupportedTypes: [...unsupported].sort(),
      chunksInserted,
    };
  }

  /**
   * 反复处理直到队列为空或耗尽批次预算。
   *
   * 有批次上限是刻意的：一次 `drain` 不应无限占用进程。达到上限时
   * `exhaustedBudget` 为真，调用方据此决定是否再排一轮（§14.3 的启动重扫
   * 与定期轮询都用它）。
   */
  async drain(
    engagementId: string,
    options: { readonly maxBatches?: number; readonly limit?: number; readonly leaseSeconds?: number } = {},
  ): Promise<DrainResult> {
    const maxBatches = options.maxBatches ?? 20;
    let batches = 0;
    let claimed = 0;
    let completed = 0;
    let failed = 0;

    while (batches < maxBatches) {
      const batch = await this.dispatchBatch(engagementId, options);
      batches += 1;
      claimed += batch.claimed;
      completed += batch.completed;
      failed += batch.failed;
      // 本批没领到任务 → 队列已空，无需再轮
      if (batch.claimed === 0) break;
    }

    const exhaustedBudget = batches >= maxBatches && claimed > 0;
    return { engagementId, batches, claimed, completed, failed, exhaustedBudget };
  }

  /**
   * 发现**有待办任务**的 engagement 并逐个排空（§14.3「实例启动后必须扫描
   * 未完成任务，不能依赖启动前收到的通知」）。
   *
   * 只查 `pending` 与**租约已过期**的 `leased`：还在有效期内的租约意味着
   * 另一个实例正在处理，抢过来会让两方都做一遍（索引是幂等的，但那只是浪费）。
   */
  async engagementsWithWork(limit = 50): Promise<readonly string[]> {
    const scopes = this.#scopes;
    if (scopes === undefined) return this.#scanEngagementsWithWork(limit);
    // 不能全库一次查：`outbox_jobs` 没有租户级放行，租户级作用域下恒零行，
    // 结果是「队列只进不出」而日志全绿。改为逐作业查，判定与作业边界一致。
    const engagementIds = await scopes.listEngagementIds();
    const out: string[] = [];
    for (const engagementId of engagementIds) {
      if (out.length >= limit) break;
      const pending = await scopes.run({ engagementId }, () => this.#scanEngagementsWithWork(1));
      if (pending.length > 0) out.push(engagementId);
    }
    return out;
  }

  /** 单个作业内是否有待办任务；调用方负责给出正确作用域。 */
  async #scanEngagementsWithWork(limit: number): Promise<readonly string[]> {
    const r = await this.#db.query<{ engagement_id: string }>(
      `select distinct engagement_id
         from pentest.outbox_jobs
        where status = 'pending'
           or (status = 'leased' and (lease_until is null or lease_until < now()))
        order by engagement_id
        limit $1`,
      [limit],
    );
    return r.rows.map((row) => row.engagement_id);
  }

  /**
   * 为「索引由旧策略生成」的 engagement 入队全量重建（§9.1 版本分离、§15.5）。
   *
   * ── 这是 `reindex_engagement` 的**生产端**（2026-10-05 复核 REQ-11 后半）──
   *
   * 此前该任务类型只有消费者没有生产者：「策略变更后重建」这句话没有落点，
   * 水位里的 `strategy_version` 也就只是一个好看的时间戳——旧策略生成的索引
   * 不会自行重建，而 §9.1 的版本分离正要求「识别哪些 engagement 按旧策略建过」。
   *
   * 幂等：幂等键的判别值取**目标策略版本**，同一版本每 engagement 只入队一次；
   * 将来 `INDEX_STRATEGY_VERSION` 再变时自然拿到新键，不必人工清任务。
   * 若那一版重建最终死信（例如坏事件），键已存在 ⇒ 不再重复入队，
   * 但队列状态会显示 failed——可见的卡点优于静默的重试风暴。
   *
   * **只入队重建，不动分块**：重建自己按幂等推进（不删除、不切换嵌入版本）。
   *
   * 作用域：`index_watermarks` 是 FORCE RLS 表（006），无作用域时按租户级查询
   * 会**静默返回零行**——因此有 `rlsScope` 时逐作业进入作用域，与
   * `engagementsWithWork` 同一套做法。
   */
  async enqueueStaleStrategyRebuilds(limit = 50): Promise<readonly string[]> {
    const scopes = this.#scopes;
    if (scopes === undefined) return this.#enqueueStaleFor(null, limit);
    const engagementIds = await scopes.listEngagementIds();
    const enqueued: string[] = [];
    for (const engagementId of engagementIds) {
      if (enqueued.length >= limit) break;
      enqueued.push(...(await scopes.run({ engagementId }, () => this.#enqueueStaleFor(engagementId, 1))));
    }
    return enqueued;
  }

  /** 在给定作用域内挑出策略版本落后的 engagement 并各入队一个重建任务。 */
  async #enqueueStaleFor(engagementId: string | null, limit: number): Promise<readonly string[]> {
    const rows = await this.#db.query<{ engagement_id: string }>(
      `select engagement_id
         from pentest.index_watermarks
        where strategy_version <> $1
          and ($2::uuid is null or engagement_id = $2::uuid)
        order by updated_at
        limit $3`,
      [INDEX_STRATEGY_VERSION, engagementId, limit],
    );
    const enqueued: string[] = [];
    for (const row of rows.rows) {
      const result = await this.#outbox.enqueue({
        engagementId: row.engagement_id,
        jobType: REINDEX_ENGAGEMENT_JOB,
        entityId: row.engagement_id,
        idempotencyKey: deriveIdempotencyKey({
          jobType: REINDEX_ENGAGEMENT_JOB,
          entityId: row.engagement_id,
          discriminator: INDEX_STRATEGY_VERSION,
        }),
      });
      if (result.created) enqueued.push(row.engagement_id);
    }
    return enqueued;
  }

  /**
   * 对所有有待办任务的 engagement 各排空一轮。
   *
   * **先补入队**：策略版本落后的 engagement 在入队前是「没有待办任务」的，
   * 永远进不了 `engagementsWithWork` 的结果——生产者必须走在发现之前。
   */
  async drainAll(
    options: { readonly maxEngagements?: number; readonly maxBatches?: number; readonly limit?: number } = {},
  ): Promise<readonly DrainResult[]> {
    await this.enqueueStaleStrategyRebuilds(options.maxEngagements ?? 50);
    const engagements = await this.engagementsWithWork(options.maxEngagements ?? 50);
    const out: DrainResult[] = [];
    for (const engagementId of engagements) {
      out.push(await this.drain(engagementId, options));
    }
    return out;
  }

  // ───────────────────────── 任务分派 ─────────────────────────

  async #handle(job: ClaimedJob): Promise<JobOutcome> {
    switch (job.jobType) {
      case INDEX_EVENT_JOB:
        return this.#indexEvent(job);
      case REINDEX_ENGAGEMENT_JOB:
        return this.#reindex(job);
      case INDEX_MEMORY_ITEM_JOB:
        // 明确未实现。返回 unsupported 而不是 done——静默完成会让
        // 「有一类任务从未被处理」永远查不出来。
        return {
          kind: 'unsupported',
          detail:
            '记忆条目分块（§8.10 压缩摘要入库路径）尚未实现；' +
            '该任务将走重试直至死信，以便在索引状态中可见',
        };
      default:
        return {
          kind: 'unsupported',
          detail: `未知任务类型；可能是更高版本的插件入队的任务，本实例不认识`,
        };
    }
  }

  async #indexEvent(job: ClaimedJob): Promise<JobOutcome> {
    const result: IndexEventResult = await this.#indexer.indexEventById(job.engagementId, job.entityId);
    return {
      kind: 'done',
      detail:
        `已索引事件：新增 ${result.inserted} 块、命中幂等 ${result.skipped} 块、` +
        `取代暂定 ${result.supersededProvisional} 块` +
        (result.lexicalOnly ? '（仅词法索引：未配置嵌入提供方）' : ''),
      chunksInserted: result.inserted,
    };
  }

  /**
   * 全量重建（§15.5）。
   *
   * 重置水位后按批推进，直到水位追平账本或耗尽预算。**不删除已有分块**——
   * 理由见 `MemoryIndexer.resetWatermark` 的注释：先删后建会让检索面在重建
   * 期间完全为空，而保留旧分块的降级是「内容略旧」，后者更可接受。
   *
   * ── 两条被复核改掉的语义（2026-10-05 复核 REQ-10）──
   *
   * 1. **只在「索引由旧策略生成」时重置水位**，而不是每次尝试都重置。
   *    每次重置 = 每次都从 0 重扫，于是预算耗尽后的重试永远回到起点，
   *    >5000 个事件的 engagement 在这套代码下**永远建不完**（水位停在半路，
   *    任务却报 done）。判定用记录在案的 `strategy_version`：与当前策略一致
   *    就从水位处继续（重试即续跑），不一致才从头重建。
   * 2. **预算耗尽不得报 done**。50 批 × 100 事件只是一个回合的上限，
   *    不是「建完了」的证据；继续返回 done 会让队列与索引状态看起来正常，
   *    而水位停在半路。改为抛错 → 走重试（退避→死信），并因第 1 条而从断点续跑。
   */
  async #reindex(job: ClaimedJob): Promise<JobOutcome> {
    const recorded = await this.#indexer.watermark(job.engagementId);
    if (recorded.strategyVersion !== INDEX_STRATEGY_VERSION) {
      await this.#indexer.resetWatermark(job.engagementId);
    }
    let events = 0;
    let chunks = 0;
    let lastStatus: 'ready' | 'lagging' | 'failed' = 'ready';
    let lastDetail: string | null = null;
    // 上限防止单个任务无限占用：剩余部分由重试或下一个 reindex 任务继续（续跑）。
    for (let i = 0; i < REINDEX_BATCH_BUDGET; i += 1) {
      const run = await this.#indexer.runOnce(job.engagementId);
      events += run.eventsProcessed;
      chunks += run.chunksInserted;
      lastStatus = run.status;
      lastDetail = run.detail;
      if (run.status !== 'lagging') break;
    }

    // **水位卡在 failed 时必须让任务失败**，不能报 done。
    //
    // 重建路径是「到水位为止全部已索引」的语义，因此一个坏事件会让水位停住
    // （这是刻意的 fail-closed：跳过它就等于让内容静默缺失）。但若这里仍返回
    // done，那个卡住只体现在水位行里，而队列与索引状态看起来一切正常——
    // 抛错让它走重试直至死信，从而在 `stats().state === 'failed'` 里可见。
    if (lastStatus === 'failed') {
      throw new Error(
        `全量重建未完成：水位停在事件链的第 ${String(events)} 个之后，原因：${lastDetail ?? '未知'}。` +
          `重建是「到水位为止全部已索引」的语义，一个坏事件会卡住它（刻意的 fail-closed）。` +
          `处置：按原因修复（通常是登记资产）后重试，或改用按事件的增量索引路径（失败按事件隔离）。`,
      );
    }

    // 预算耗尽（仍是 lagging）= 还没建完。水位已推进到断点，因此重试从断点继续。
    if (lastStatus === 'lagging') {
      throw new Error(
        `全量重建未完成（本回合已用满 ${String(REINDEX_BATCH_BUDGET)} 批预算，处理 ${String(events)} 个事件）：` +
          `${lastDetail ?? '仍有未索引事件'}。水位已推进到断点，重试会从断点继续（不是从 0 重扫）。`,
      );
    }

    return {
      kind: 'done',
      detail: `全量重建：处理 ${events} 个事件、写入 ${chunks} 块，水位已追平账本`,
      chunksInserted: chunks,
    };
  }
}
