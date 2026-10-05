/**
 * 索引调度器：让 `IndexDispatcher` 真的被周期性调用。
 *
 * 设计依据：docs/dsh-pentest-plugin-design.md §14.3（多实例与启动重扫）、
 * §8.4（Streaming RAG 管线）、§15.5（索引滞后）
 *
 * ── 这个模块补的是什么缺口 ──
 *
 * `IndexDispatcher` 能排空队列，但没有任何东西**周期性**调它。没有本模块，
 * 队列只进不出——索引任务会一直堆在 `pending` 里，检索面永远缺内容，
 * 而且没有任何东西报错。
 *
 * ── 四条实现纪律 ──
 *
 * 1. **启动时必须先扫一遍，不依赖通知**（§14.3 原话：「实例启动后必须扫描未
 *    完成任务，不能依赖启动前收到的通知」）。唤醒通知只降低延迟，它可能丢；
 *    可靠来源是任务队列本身。因此 `start()` 立即执行一次「先清扫、再排空」，
 *    然后才进入周期。
 *
 * 2. **不重叠**。上一次 tick 还在跑时，下一次直接跳过而不是排队。索引是低频
 *    维护工作，堆叠只会让同一批任务被反复尝试；跳过让队列自己决定节奏。
 *
 * 3. **错误不杀循环**。一次 tick 失败（数据库瞬断、嵌入服务抖动）不能让调度器
 *    停摆——那会让索引静默停止直到进程重启。错误交给回调记录，循环继续。
 *
 * 4. **定时器不阻止宿主退出**。`unref()` 是必需的：否则插件会让 dsh 进程
 *    无法正常退出，那在测试与 CLI 场景下都是真实故障。
 *
 * ── 与 §14.3 唤醒通知的关系 ──
 *
 * 通知（`NOTIFY`）可以另接一个「立即触发一次 tick」的入口（`wakeNow()`），
 * 但它只是延迟优化：本模块的周期 tick 与启动重扫才是可靠性来源。
 * 通知丢了最多晚一个间隔，不会漏任务。
 */

import type { OutboxQueue } from './outbox.ts';
import type { IndexDispatcher, DrainResult } from './dispatcher.ts';

export interface IndexSchedulerDeps {
  readonly dispatcher: IndexDispatcher;
  /** 用于启动时回收过期租约（§14.3：崩溃实例留下的 `leased` 行）。 */
  readonly outbox: OutboxQueue;
  /** 一次 tick 失败时的回调。原始错误交出去记录，循环继续。 */
  readonly onError?: (error: unknown, phase: 'sweep' | 'drain') => void;
  /** 一次 tick 完成时的回调，便于接指标（§14.2）。 */
  readonly onTick?: (result: SchedulerTickResult) => void;
  /** 启动重扫完成后的回调。 */
  readonly onStartup?: (result: SchedulerTickResult) => void;
}

export interface SchedulerTickResult {
  readonly drained: readonly DrainResult[];
  /** 启动清扫回收的任务数（仅启动 tick 非零）。 */
  readonly sweptJobs: number;
  readonly errors: number;
}

export interface IndexSchedulerOptions {
  /**
   * 周期（毫秒）。三种取值：
   *   - 省略 → 用 {@link DEFAULT_SCHEDULER_INTERVAL_MS}
   *   - `null` → **不启用周期**，只做启动重扫，此后靠手动 `tick()` 或 `wakeNow()`
   *   - 数字 → 该周期
   *
   * 必须区分「省略」与「null」：单实例部署可能希望索引只在启动时跑一次、
   * 之后由外部触发器驱动（例如由控制台按钮或外部 cron）。用 `??` 会把 `null`
   * 当成缺省，那种部署就表达不出来——所以这里是显式的 `null` 语义。
   */
  readonly intervalMs?: number | null;
  readonly maxEngagements?: number;
  readonly maxBatches?: number;
  readonly limit?: number;
  /** 定时器注入（测试用）。省略即用全局 `setInterval`/`clearInterval`。 */
  readonly setIntervalFn?: (fn: () => void, ms: number) => TimerHandle;
  readonly clearIntervalFn?: (handle: TimerHandle) => void;
}

/** 定时器句柄。Node 的 `Timeout` 与浏览器的 `number` 都归到这里。 */
export type TimerHandle = ReturnType<typeof setInterval>;

export const DEFAULT_SCHEDULER_INTERVAL_MS = 15_000;

export class IndexScheduler {
  readonly #deps: IndexSchedulerDeps;
  readonly #intervalMs: number | null;
  readonly #maxEngagements: number;
  readonly #maxBatches: number;
  readonly #limit: number | null;
  readonly #setInterval: (fn: () => void, ms: number) => TimerHandle;
  readonly #clearInterval: (handle: TimerHandle) => void;

  #timer: TimerHandle | null = null;
  /** 在途 tick。用于 stop 时等待它结束——否则 dispose 会留下悬挂的写操作。 */
  #inFlight: Promise<SchedulerTickResult> | null = null;
  #stopped = false;

  constructor(deps: IndexSchedulerDeps, options: IndexSchedulerOptions = {}) {
    this.#deps = deps;
    this.#intervalMs =
      options.intervalMs === undefined ? DEFAULT_SCHEDULER_INTERVAL_MS : options.intervalMs;
    this.#maxEngagements = options.maxEngagements ?? 50;
    this.#maxBatches = options.maxBatches ?? 20;
    this.#limit = options.limit ?? null;
    this.#setInterval = options.setIntervalFn ?? ((fn, ms) => setInterval(fn, ms));
    this.#clearInterval = options.clearIntervalFn ?? ((handle) => { clearInterval(handle); });
  }

  /**
   * 启动：先做一次启动重扫，再进入周期。
   *
   * 立即扫一遍而不是等第一个间隔，是因为启动瞬间往往积压最多——上次进程结束
   * 时队列里可能还有任务，它们不会自己消失。
   *
   * 幂等：重复调用不会创建第二个定时器。
   */
  start(): void {
    if (this.#stopped) {
      throw new Error('调度器已停止：停止后的实例不可重启，请新建一个');
    }
    if (this.#timer !== null) return;

    // 启动重扫**不 await**：`apply` 是同步的启动路径，不能因为一次索引扫描
    // 而阻塞插件加载。它作为后台任务跑，失败也不影响启动（错误进回调）。
    void this.#startupSweep();

    if (this.#intervalMs === null) return;
    const handle = this.#setInterval(() => { void this.tick(); }, this.#intervalMs);
    // 不阻止宿主退出：否则插件会让 dsh 进程无法正常结束。
    // `unref` 在浏览器定时器上不存在，因此用可选调用。
    (handle as { unref?: () => void }).unref?.();
    this.#timer = handle;
  }

  /**
   * 停止：清定时器并**等待在途 tick 结束**。
   *
   * 等待是必需的——在途 tick 正在写 `memory_chunks` 与水位；直接断开连接池
   * 会让那些写入以难以解释的方式失败。幂等。
   */
  async stop(): Promise<void> {
    if (this.#timer !== null) {
      this.#clearInterval(this.#timer);
      this.#timer = null;
    }
    this.#stopped = true;
    if (this.#inFlight !== null) {
      // 吞掉错误：停止路径不应因在途失败而抛——它已经通过 onError 报告过
      await this.#inFlight.catch(() => undefined);
    }
  }

  /** 当前是否有在途 tick（供测试与诊断）。 */
  get running(): boolean {
    return this.#inFlight !== null;
  }

  /**
   * 当前生效的周期；`null` 表示不启用周期。
   *
   * 暴露为 getter 而不是让调用方去翻配置对象：装配层不该通过深层类型断言
   * 去挖「那个 intervalMs 到底是什么」——那既脆弱又难读，而调度器自己知道答案。
   */
  get intervalMs(): number | null {
    return this.#intervalMs;
  }

  /**
   * 执行一次 tick。
   *
   * **不重叠**：已有在途 tick 时直接返回当前那次的结果，不起第二次。
   * 这既是性能考虑，也是正确性考虑——两个并发 tick 会领取不同的任务批次，
   * 但都会推进同一份水位，让日志与统计难以解释。
   */
  tick(): Promise<SchedulerTickResult> {
    if (this.#inFlight !== null) return this.#inFlight;
    const run = this.#runTick().finally(() => { this.#inFlight = null; });
    this.#inFlight = run;
    return run;
  }

  /** 收到唤醒通知时立即触发一次（延迟优化，不是可靠性来源）。 */
  wakeNow(): void {
    if (this.#stopped) return;
    void this.tick();
  }

  async #startupSweep(): Promise<void> {
    const result = await this.#runTick();
    this.#deps.onStartup?.(result);
  }

  /**
   * 一次完整的维护轮：清扫过期租约 → 排空所有有待办的 engagement。
   *
   * 顺序是刻意的：**先清扫再排空**。清扫把崩溃实例留下的 `leased` 行拉回
   * `pending`（并把超次数的归档为 `dead`），排空随后就能把它们一并处理掉。
   * 反过来做会让本次 tick 白跑一轮——那些任务要到下个周期才被捡起。
   */
  async #runTick(): Promise<SchedulerTickResult> {
    let sweptJobs = 0;
    let errors = 0;

    try {
      const swept = await this.#deps.outbox.sweepExpired({ limit: 100 });
      sweptJobs = swept.length;
    } catch (error) {
      // 清扫失败不阻止排空：排空的 claim 本身也会领取过期租约的任务
      // （`claim` 的谓词包含「leased 且租约已过期」），因此这只是少了一层
      // 归档动作，不是功能缺失。
      errors += 1;
      this.#deps.onError?.(error, 'sweep');
    }

    let drained: readonly DrainResult[] = [];
    try {
      drained = await this.#deps.dispatcher.drainAll({
        maxEngagements: this.#maxEngagements,
        maxBatches: this.#maxBatches,
        ...(this.#limit === null ? {} : { limit: this.#limit }),
      });
    } catch (error) {
      errors += 1;
      this.#deps.onError?.(error, 'drain');
    }

    const result: SchedulerTickResult = { drained, sweptJobs, errors };
    // 每次 tick（含启动那次）都回调：它是指标钩子，与 onStartup 的分工是
    // 「所有 tick 的观测」vs「启动那次的专门处置」。少调一次会让指标漏统计。
    this.#deps.onTick?.(result);
    return result;
  }
}
