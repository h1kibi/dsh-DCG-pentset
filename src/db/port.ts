/**
 * 数据库端口（**seam**）：服务层与具体数据库客户端之间的接口。
 *
 * ── 为什么独立成模块 ──
 *
 * 这三个接口原先长在 `memory/ledger.ts` 里，于是「只想要一个 `DbClient` 类型」的模块
 * （`workflow/*`、`execution/*`、`policy/*`、`report/*`、`skills/*` 共 11 个）不得不 import
 * 账本模块——一个与它们毫无语义关系的模块。第六轮质检把这处 seam 错位记为「本报告最强的
 * 接缝建议」：端口的实现者（`pg` 的 Pool/PoolClient、测试替身）与**账本语义**无关。
 *
 * 因此本模块只放端口与它们的最小数据形状，**不 import 任何东西**：
 *   - `DbClient` / `RlsAwareDbClient`：可用 `pg` 的 Pool / PoolClient 直接满足；
 *   - `DbRlsContext`：事务级 RLS 上下文（租户 / 作业 / 会话三段）；
 *   - `DbResult`：最小结果形状（`pg` 的 `QueryResult` 可赋值给它）。
 *
 * 事务调度器（`DbTransactionRunner` / `transactionRunnerFor`）**留在账本模块**：
 * 它编码的是「共享独占写连接 + RLS 上下文 + 审计」的账本语义，不属于端口。
 */

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
