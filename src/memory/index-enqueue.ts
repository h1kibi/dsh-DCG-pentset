/**
 * 索引入队适配器：把账本的 `IndexEnqueuePort` 接到 outbox 队列。
 *
 * 设计依据：docs/dsh-pentest-plugin-design.md §8.4（Streaming RAG 管线）
 *
 * ── 这个适配器存在的理由 ──
 *
 * 账本不认识 outbox 模块（它只声明了一个端口接口），outbox 也不认识账本。
 * 两者必须在**同一个事务**里协作：账本追加事件、outbox 入队索引任务，
 * 要么都提交要么都回滚。
 *
 * 若分成两次提交，进程在中间崩溃会留下「事件已落库但永远不被索引」的缺口。
 * 那种缺口**不会报错**——检索面只是少了几条内容，没有任何东西提示异常，
 * 只能靠人工比对索引水位与账本链头才发现。因此原子性是这里唯一重要的性质。
 *
 * 适配器的实现很短，但它是这条性质的落点，因此值得独立成文件并带测试。
 */

import type { DbClient, IndexEnqueuePort } from './ledger.ts';
import { INDEX_EVENT_JOB } from './outbox.ts';
import type { OutboxQueue } from './outbox.ts';

/**
 * 把一批事件入队为索引任务。
 *
 * **一个事件一个任务**，而不是「一批一个任务」：
 *   - 单个事件索引失败只影响它自己，不必重跑整批；
 *   - 退避与死信按事件粒度计，一个坏事件不会拖住同批的其它事件；
 *   - 幂等键由（类型，事件标识）确定性派生，重放自动去重。
 *
 * 代价是事件多时任务行多。索引任务是低频的（事件写入本身就受人类闸门限速），
 * 这个代价可接受；而粒度粗带来的重跑成本更不可接受。
 */
export class LedgerIndexEnqueue implements IndexEnqueuePort {
  readonly #queue: OutboxQueue;

  constructor(queue: OutboxQueue) {
    this.#queue = queue;
  }

  async enqueueInTransaction(
    tx: DbClient,
    input: { readonly engagementId: string; readonly eventIds: readonly string[] },
  ): Promise<void> {
    for (const eventId of input.eventIds) {
      await this.#queue.enqueueInTransaction(tx, {
        engagementId: input.engagementId,
        jobType: INDEX_EVENT_JOB,
        entityId: eventId,
      });
    }
  }
}

/**
 * 校验一次入队是否与账本同事务：供集成测试断言用。
 *
 * 实现方式是在**同一个连接**上入队后立刻回查——同事务内可见、跨事务不可见。
 * 这不是运行时逻辑，而是把「原子性」这件事变成可断言的形状。
 */
export async function pendingJobCountOnTx(tx: DbClient, engagementId: string): Promise<number> {
  const r = await tx.query<{ n: string }>(
    `select count(*)::text as n from pentest.outbox_jobs
      where engagement_id = $1::uuid and status = 'pending'`,
    [engagementId],
  );
  return Number(r.rows[0]?.n ?? '0');
}
