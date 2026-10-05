/**
 * 诊断面（只读）：把「现在到底是什么在卡」聚合成一张快照。
 *
 * ── 数据来源与边界 ──
 *
 * - 连接池统计：进程内的实时读数（`pg.Pool` 的 total/idle/waiting）。
 * - 审计探针：注入的 `available()`——**必须走真实审计写路径**（见 compose 的说明），
 *   这里只转发，不自己造一个「只读探针」（那会变成假绿灯）。
 * - 索引队列与水位：按 engagement 取（`outbox_jobs` 与 `index_watermarks`），
 *   未选作业时这两项为 `null`。
 *
 * 只读、无副作用、不写审计。所有依赖都是注入的端口——测试不需要数据库，
 * 装配处（compose）负责把真实实现接进来。
 */

import type {
  DiagnosticsSnapshot,
  EngagementDiagnostics,
  MemoryWatermark,
  PentestDiagnosticsService,
} from '../contracts.ts';
import type { OutboxStats } from '../memory/outbox.ts';

export interface DiagnosticsDeps {
  readonly poolStats: () => {
    readonly totalCount: number;
    readonly idleCount: number;
    readonly waitingCount: number;
  };
  /** 审计写路径探针；省略即快照里 `audit: null`（未装配，而不是「通过」）。 */
  readonly audit?: { available(): Promise<{ readonly writable: boolean; readonly detail: string }> };
  readonly outbox: { stats(engagementId: string): Promise<OutboxStats> };
  readonly watermark: (engagementId: string) => Promise<MemoryWatermark>;
  readonly clock?: () => Date;
}

export class PgDiagnosticsService implements PentestDiagnosticsService {
  readonly #deps: DiagnosticsDeps;
  readonly #clock: () => Date;

  constructor(deps: DiagnosticsDeps) {
    this.#deps = deps;
    this.#clock = deps.clock ?? ((): Date => new Date());
  }

  async getDiagnostics(input: { readonly engagementId?: string | null }): Promise<DiagnosticsSnapshot> {
    const pool = this.#deps.poolStats();
    const audit = this.#deps.audit === undefined ? null : await this.#deps.audit.available();
    const engagementId = input.engagementId ?? null;
    const engagement = engagementId === null || engagementId.length === 0
      ? null
      : await this.#engagementDiagnostics(engagementId);
    return {
      checkedAt: this.#clock().toISOString(),
      pool: { total: pool.totalCount, idle: pool.idleCount, waiting: pool.waitingCount },
      audit,
      engagement,
    };
  }

  async #engagementDiagnostics(engagementId: string): Promise<EngagementDiagnostics> {
    // 顺序执行而不是并行：两者都走各自的服务（队列走写连接、水位走读连接），
    // 诊断是低频人工动作，不值得为省一次往返引入并发。
    const stats = await this.#deps.outbox.stats(engagementId);
    const watermark = await this.#deps.watermark(engagementId);
    return {
      engagementId,
      indexQueue: {
        pending: stats.counts.pending,
        leased: stats.counts.leased,
        done: stats.counts.done,
        dead: stats.counts.dead,
        lagState: stats.state,
        oldestPendingAt: stats.oldestPendingAt === null ? null : stats.oldestPendingAt.toISOString(),
      },
      watermark,
    };
  }
}
