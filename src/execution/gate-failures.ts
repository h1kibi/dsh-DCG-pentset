/**
 * 闸门失败的落点与处置（§10.2.2；2026-10-05 复核 C2 从组合根抽出）。
 *
 * ── 为什么它值得独立成模块，而不是躺在 `compose()` 里 ──
 *
 * 这段不是接线，而是**一个服务**：写 `scope_violation` / `classification_rejected` 事件进账本、
 * 数出「自上次成功执行以来该会话的范围违规次数」、达阈值时请求系统暂停。
 * 它此前是 `compose()` 里约 100 行的一段闭包——既拖长了组合根，又让「这段逻辑的边界在哪」
 * 只能靠通读推导。
 *
 * ── 为什么把「计数」与「写事件」放在同一处 ──
 *
 * 判据（账本事件 + `tool_runs` 终态）分散两处必然漂移，而漂移的表现是
 * 「暂停了但说不清为什么」或「该停没停」。这里两者共用同一条事务与同一把锁序。
 *
 * ── 锁序（与工作流及其它状态写路径一致）──
 *
 * 先锁 `engagements` 行，再进入账本的 engagement advisory lock。反过来
 *（账本锁 → engagement 行锁）会与工作流「engagement 行锁 → 账本锁」形成死锁。
 */

import type { AppendEventInput, MemoryLedgerService } from '../contracts.ts';
import type { DbClient } from '../db/port.ts';
import type { TransactionalLedger } from '../memory/ledger.ts';
import { transactionRunnerFor } from '../memory/ledger.ts';
import type { GateFailureSink } from './service.ts';

/**
 * sink 需要的账本端口：`appendEvent` 来自账本服务契约面，`appendBatchInTransaction` 来自事务面——
 * 两个面在同一条写连接上（sink 必须与工作流状态写入共处一个事务）。
 *
 * 具名导出：组合根装配执行服务时要传同一个端口，两边各写一遍交集类型必然漂移。
 */
export type GateFailureLedger = Pick<MemoryLedgerService, 'appendEvent'> &
  Pick<TransactionalLedger, 'appendBatchInTransaction'>;

/** 系统暂停的落点（工作流服务）。只声明用到的那一个方法——本模块不依赖具体实现。 */
export interface SystemPausePort {
  pauseForSystem(input: {
    readonly engagementId: string;
    readonly expectedStateVersion: number;
    readonly cause: 'scope_violation_threshold';
    readonly detail: string;
  }): Promise<unknown>;
}

interface GateFailureSinkDeps {
  /** 账本端口（见 {@link GateFailureLedger}）。 */
  readonly ledger: GateFailureLedger;
  /** 账本写连接：闸门事件必须与工作流状态写入落在同一个事务里。 */
  readonly txDb: DbClient;
  /**
   * 系统暂停的出口。用 **getter** 而不是值：sink 只在**运行时**（检测到阈值时）读它，
   * 而工作流服务在 sink 之后才构造——晚绑定比调换构造顺序清晰。
   */
  readonly workflow: () => SystemPausePort | null;
}

/**
 * 构造闸门失败 sink。
 *
 * `record` 是「不暂停」的那条路（阈值取 `MAX_SAFE_INTEGER`），`recordAndPause` 是生产路径——
 * 两者共用同一段实现，避免「计数口径」出现第二份。
 */
export function createGateFailureSink(deps: GateFailureSinkDeps): GateFailureSink {
  const runner = transactionRunnerFor(deps.txDb);
  return {
    async record(input) {
      return this.recordAndPause!({ ...input, threshold: Number.MAX_SAFE_INTEGER });
    },
    async recordAndPause(input) {
      const sourceId = `${input.eventType}:${crypto.randomUUID()}`;
      const appendInput: AppendEventInput = {
        engagementId: input.engagementId,
        workerSessionId: input.workerSessionId,
        eventType: input.eventType,
        sourceSystem: 'pentest-execution',
        sourceId,
        sourceSeq: 1,
        occurredAt: new Date(),
        payload: {
          rawTarget: input.rawTarget,
          normalized: input.normalized,
          rule: input.rule,
          detail: input.detail,
        },
        rawPayload: new TextEncoder().encode(JSON.stringify(input)),
        classification: 'engagement',
        trustLevel: 'tool_observation',
      };
      if (input.eventType !== 'scope.violation') {
        await deps.ledger.appendEvent(appendInput);
        return 0;
      }

      let count = 0;
      await runner.run(async (tx) => {
        // 锁序见文件头：engagement 行锁在前，账本 advisory lock 在后。
        await tx.query(
          `select id from pentest.engagements where id = $1::uuid for update`,
          [input.engagementId],
        );
        await deps.ledger.appendBatchInTransaction(tx, [appendInput]);
        const counted = await tx.query<{ readonly n: number | string }>(
          `select count(*)::int as n
             from pentest.context_events e
            where e.engagement_id = $1::uuid
              and e.worker_session_id = $2::uuid
              and e.event_type = 'scope.violation'
              and e.occurred_at > coalesce(
                    (select max(r.finished_at) from pentest.tool_runs r
                      where r.worker_session_id = $2::uuid and r.status = 'completed'),
                    '-infinity'::timestamptz)`,
          [input.engagementId, input.workerSessionId],
        );
        count = Number(counted.rows[0]?.n ?? 0);
        if (count < input.threshold) return;
        const state = await tx.query<{ readonly status: string; readonly state_version: number | string }>(
          `select status, state_version from pentest.engagements where id = $1::uuid`,
          [input.engagementId],
        );
        const row = state.rows[0];
        if (row === undefined || row.status === 'paused') return;
        const workflow = deps.workflow();
        if (workflow === null) {
          throw new Error('系统暂停工作流尚未装配');
        }
        await workflow.pauseForSystem({
          engagementId: input.engagementId,
          expectedStateVersion: Number(row.state_version),
          cause: 'scope_violation_threshold',
          detail:
            `同一会话自上次成功执行以来连续 ${String(count)} 次范围违规（阈值 ${String(input.threshold)}）。` +
            '这通常意味着任务描述有歧义，而不是偶发失误——交人类判断（§10.2.2）。',
        });
      });
      return count;
    },
    async pauseForScopeViolations() {
      // 生产路径使用 recordAndPause；保留接口以兼容测试替身与旧调用者。
    },
  };
}
