/**
 * 集成测试的清理夹具：把「删掉本文件造的全部数据」集中到一处。
 *
 * ── 为什么需要共享实现 ──
 *
 * 此前每个集成测试文件各写一份清理，结果是**普遍的静默残留**：实测跑一次全量后
 * 库里留下几十个 engagement，因为它们各自漏掉了引用 `engagements` 的某几张表
 * （最典型的是 `session_leases`——`delete from engagements` 会被它的外键挡住，
 * 而失败又被 `.catch(() => undefined)` 吞掉，看起来一切正常）。
 *
 * 集中到一处后：
 *   - 表清单只有一个来源，加表只改这里；
 *   - 顺序与绕过方式统一，不再靠每个文件各自记得；
 *   - 失败不再被吞（见下），残留会立刻暴露而不是累积。
 *
 * ── 两条实现要点 ──
 *
 * 1. **用 `session_replication_role = 'replica'` 绕过全部约束**（用户触发器与 FK），
 *    而不是「临时 disable trigger + 按外键倒序删」。后者要求作者记得每一张引用表，
 *    漏一张就静默残留；replica 角色让顺序问题不存在。
 *
 * 2. **必须用同一条连接**：`session_replication_role` 是**会话级**设置，用
 *    `pool.query` 设它只影响当时借出的那条连接，而删除可能落在另一条上——那会让
 *    「设置看似生效但删除仍被 FK 挡住」。
 *
 * ── 为什么故意不吞错 ──
 *
 * 失败会抛出去，让「清理失败」表现为测试失败。静默吞掉残留比一次失败的测试更糟：
 * 残留会跨运行累积，让后续测试读到前次的数据，表现出难以复现的 flakiness。
 * 唯一的例外是 `SET ... 'origin'` 的恢复——它若失败也会抛，因为未恢复的连接上
 * 后续所有写入都不再受约束，那是更严重的问题。
 */

import type { Client, Pool, PoolClient } from 'pg';

/**
 * 清理目标：表名 + 按 engagement 过滤的 WHERE 片段。
 *
 * **不是所有表都有 `engagement_id`**——`retrieval_hits` 只有 `query_id`
 * （它引用 `retrieval_queries`）。写死「按 engagement_id 删」会以
 * `column "engagement_id" does not exist` 失败，而那张表的行就成了残留。
 * 因此每张表带自己的过滤表达式。
 *
 * 顺序按依赖倒序：被引用者在后（`engagements` 最后）。replica 角色下顺序其实
 * 不敏感，但保留倒序一是可读、二是将来若去掉 replica 仍然正确。
 */
interface CleanupTarget {
  readonly table: string;
  readonly where: string;
}

const CLEANUP_TARGETS: readonly CleanupTarget[] = [
  // 检索记录：hits 引用 queries，先删 hits（它没有 engagement_id，按子查询过滤）
  {
    table: 'pentest.retrieval_hits',
    where:
      'query_id in (select id from pentest.retrieval_queries where engagement_id = any($1::uuid[]))',
  },
  { table: 'pentest.retrieval_queries', where: 'engagement_id = any($1::uuid[])' },
  { table: 'pentest.memory_access_log', where: 'engagement_id = any($1::uuid[])' },
  { table: 'pentest.memory_chunks', where: 'engagement_id = any($1::uuid[])' },
  { table: 'pentest.memory_items', where: 'engagement_id = any($1::uuid[])' },
  // 结论与报告
  { table: 'pentest.findings', where: 'engagement_id = any($1::uuid[])' },
  { table: 'pentest.reports', where: 'engagement_id = any($1::uuid[])' },
  { table: 'pentest.worker_reports', where: 'engagement_id = any($1::uuid[])' },
  { table: 'pentest.scope_intake_proposals', where: 'engagement_id = any($1::uuid[])' },
  { table: 'pentest.handoffs', where: 'engagement_id = any($1::uuid[])' },
  // 工具与证据
  { table: 'pentest.tool_runs', where: 'engagement_id = any($1::uuid[])' },
  { table: 'pentest.approvals', where: 'engagement_id = any($1::uuid[])' },
  // 请求快照：有外键指回 engagements，漏了它「删作业」会被 23503 挡住。
  // 当前没有生产写入方，但清单漏表的代价是**将来**某次给测试加写入后清理报错，
  // 因此按 schema 补齐（缺口 2026-10-05 由「清单 vs schema」自检发现，见
  // `test/cleanup-fixture.test.ts`）。
  { table: 'pentest.request_snapshots', where: 'engagement_id = any($1::uuid[])' },
  { table: 'pentest.artifacts', where: 'engagement_id = any($1::uuid[])' },
  { table: 'pentest.llm_calls', where: 'engagement_id = any($1::uuid[])' },
  // 状态与决策
  { table: 'pentest.state_transitions', where: 'engagement_id = any($1::uuid[])' },
  { table: 'pentest.human_decisions', where: 'engagement_id = any($1::uuid[])' },
  // 会话与租约（session_leases 引用 engagements，漏了它 engagements 删不掉）
  { table: 'pentest.session_leases', where: 'engagement_id = any($1::uuid[])' },
  { table: 'pentest.policy_versions', where: 'engagement_id = any($1::uuid[])' },

  // 索引
  { table: 'pentest.outbox_jobs', where: 'engagement_id = any($1::uuid[])' },
  { table: 'pentest.index_watermarks', where: 'engagement_id = any($1::uuid[])' },
  // 范围与资产
  { table: 'pentest.asset_scope_versions', where: 'engagement_id = any($1::uuid[])' },
  { table: 'pentest.assets', where: 'engagement_id = any($1::uuid[])' },
  { table: 'pentest.scope_versions', where: 'engagement_id = any($1::uuid[])' },
  { table: 'pentest.embedding_revisions', where: 'engagement_id = any($1::uuid[])' },
  // 账本最后：它引用 worker_sessions 与 engagements
  { table: 'pentest.context_events', where: 'engagement_id = any($1::uuid[])' },
  { table: 'pentest.ledger_anchors', where: 'engagement_id = any($1::uuid[])' },
  // 会话与 engagement 本身
  { table: 'pentest.worker_sessions', where: 'engagement_id = any($1::uuid[])' },
  // 销毁记录：**没有**外键指回 engagements（它是删除动作本身的唯一证据，独立于被删作业），
  // 因此不删它不会挡住清理，但测试跑一次就积一行，属于跨运行累积的残留。一并删。
  { table: 'pentest.engagement_purges', where: 'engagement_id = any($1::uuid[])' },
  { table: 'pentest.engagements', where: 'id = any($1::uuid[])' },
];

/**
 * 补扫清单：**迟到写入**最可能出现的那几张表（见 `cleanupEngagements` 的第二轮说明）。
 *
 * 顺序仍按引用方在前：异步索引会先插分块再插事件；`engagements` 最后，确保补扫本身自洽。
 */
const LATE_CLEANUP_TARGETS: readonly CleanupTarget[] = [
  { table: 'pentest.memory_chunks', where: 'engagement_id = any($1::uuid[])' },
  { table: 'pentest.memory_items', where: 'engagement_id = any($1::uuid[])' },
  { table: 'pentest.outbox_jobs', where: 'engagement_id = any($1::uuid[])' },
  { table: 'pentest.context_events', where: 'engagement_id = any($1::uuid[])' },
  { table: 'pentest.index_watermarks', where: 'engagement_id = any($1::uuid[])' },
  { table: 'pentest.engagements', where: 'id = any($1::uuid[])' },
];

/**
 * 清单里的表名（不含 schema 前缀），供「清单 vs schema」自检使用。
 *
 * 自检存在的原因：这份清单漏一张表，代价不是「多几行残留」而是**下一次全量套件
 * 里某个文件的清理抛 23503**——排查成本高、且与本次改动的因果关系很隐蔽。
 * 2026-10-05 的自检当场发现漏了 `request_snapshots` 与 `engagement_purges`。
 */
export const CLEANUP_TARGET_TABLES: readonly string[] = [
  ...new Set([...CLEANUP_TARGETS, ...LATE_CLEANUP_TARGETS].map((t) => t.table.replace('pentest.', ''))),
];

/**
 * 清理目标接受的连接：池、**已借出的池连接**，或裸 `Client`。
 *
 * 为什么三者都要：多数文件用池（本模块自己借一条连接），但有些用例已经把连接
 * 捏在手里（`SET ROLE` / 事务状态下），那种场景必须复用同一条连接——另借一条
 * 会拿不到相同的角色与会话状态。裸 `Client` 出现在迁移类测试里（`new pg.Client`）。
 */
export type CleanupConnection = Pool | PoolClient | Client;

function isPool(value: CleanupConnection): value is Pool {
  // 判定**不能只看 `connect`**：裸 `Client` 也有 `connect`，但那是「建立连接」而不是
  // 「借一条」——误判会以 `Client has already been connected. You cannot reuse a client.`
  // 失败（2026-10-05 实际踩到）。`Pool` 独有的是计数属性。
  return typeof (value as Pool).totalCount === 'number' && typeof (value as Pool).connect === 'function';
}

/**
 * 删掉给定 engagement（及其全部从属数据）。
 *
 * `engagementIds` 为空时直接返回（没有要清的东西，也不需要拿连接）。
 */
export async function cleanupEngagements(
  connection: CleanupConnection,
  engagementIds: readonly string[],
): Promise<void> {
  if (engagementIds.length === 0) return;
  const ids = [...new Set(engagementIds)];
  const owned = isPool(connection);
  // `owned` 为真时借出的是池连接（有 `release`）；否则调用方的连接由调用方关闭。
  const client: Client = owned ? await (connection as Pool).connect() : connection;
  try {
    await client.query("SET session_replication_role = 'replica'");
    for (const target of CLEANUP_TARGETS) {
      await client.query(`delete from ${target.table} where ${target.where}`, [ids]);
    }
    // **第二轮：补扫迟到写入。**
    //
    // 主清单是一串独立的 DELETE（每条一次往返），而索引/事件这类异步路径可能**插在两条之间**：
    // 先插成 `memory_chunks`（此刻 engagement 还在），再被我们删掉 engagement —— 于是留下
    // 孤儿分块，而 `assertNoResidue` 查不出来（它只看 `engagements`）。
    // 实测（QA 2026-10-04）：一次含失败用例的全量套件在库里留下 3 行孤儿 `memory_chunks`。
    // 只补最容易迟到的那几张表，代价是几条按 id 的 DELETE。
    for (const target of LATE_CLEANUP_TARGETS) {
      await client.query(`delete from ${target.table} where ${target.where}`, [ids]);
    }
  } finally {
    // 恢复不可吞：未恢复的连接上后续写入都不再受约束。
    await client.query("SET session_replication_role = 'origin'");
    if (owned) (client as PoolClient).release();
  }
}

/**
 * 断言清理有效：库里没有残留的 engagement。
 *
 * 供测试调用——把「清理是否真的生效」变成一个可断言的检查，
 * 而不是靠人工查库。这是本模块存在的直接原因（此前残留无人发现）。
 */
export async function assertNoResidue(
  connection: CleanupConnection,
  engagementIds: readonly string[],
): Promise<void> {
  if (engagementIds.length === 0) return;
  const r = await connection.query<{ n: string }>(
    'select count(*)::text as n from pentest.engagements where id = any($1::uuid[])',
    [[...new Set(engagementIds)]],
  );
  const remaining = Number(r.rows[0]?.n ?? '0');
  if (remaining > 0) {
    throw new Error(
      `清理未生效：仍有 ${String(remaining)} 个 engagement 残留。` +
        `大概率是某张引用 engagements 的表没被删（见表清单），或删除失败被吞掉了。`,
    );
  }
}
