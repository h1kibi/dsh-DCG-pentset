/**
 * 组合根：把所有模块装配成可运行的插件服务面。
 *
 * 设计依据：docs/dsh-pentest-plugin-design.md §4.1、§4.2、§4.4
 *
 * 这个文件是**唯一**知道「哪些件接哪些件」的地方。各模块之间只通过契约接口
 * 相互认识，因此替换任一实现（例如换成非 Docker 沙箱、换成 KMS 签名器）
 * 只需要改这里。
 *
 * ── 为什么必须有它 ──
 *
 * 此前所有数据访问都只是接口 + 测试假实现，`apply` 拿不到可用的服务面就
 * 不注册任何工具——插件能加载但完全空转。本文件补上那个缺口。
 *
 * ── 两条实测确认的连接约束 ──
 *
 * 1. **事务必须落在同一条连接上**。`MemoryLedger` 与 `PgLeaseStore` 的
 *    `#withTransaction` 会发 `begin` / `commit`；若把连接池直接当 `txDb`，
 *    BEGIN 与 COMMIT 会落到不同连接，事务**静默失效**（不报错，只是不原子）。
 *    因此写路径必须用独占连接。
 *
 * 2. **读路径可以用池**。单条语句（含 CTE）自带隐式事务，池足够——
 *    `PgExecutionStore.commitRun` 正是这么设计的。
 *
 * 因此这里对写路径获取**一条独占连接**并常驻。代价是写操作串行化；对本插件
 * 是合适的（一个 engagement 同时只有一个活动 Worker，且人工闸门决定节奏）。
 * 独占连接若断开，审计写入会失败——这按设计触发 `audit_unavailable` 的
 * fail-closed 路径（§15.1：审计不可用时所有触及目标的动作停止），而不是静默降级。
 */

import { AsyncLocalStorage } from 'node:async_hooks';

import { Pool } from 'pg';
import { Client } from 'pg';
import type { PoolClient } from 'pg';

import type { DbClient, DbRlsContext, RlsAwareDbClient } from './memory/ledger.ts';
import { MemoryLedger, PgAnchorSink, transactionRunnerFor } from './memory/ledger.ts';
import type { LedgerSecret } from './memory/hash.ts';
import { PgWorkerTools } from './memory/pg-worker-tools.ts';
import { PgOutboxQueue } from './memory/outbox.ts';
import type { OutboxOptions } from './memory/outbox.ts';
import { MemoryIndexer } from './memory/indexer.ts';
import { LedgerIndexEnqueue } from './memory/index-enqueue.ts';
import { IndexDispatcher } from './memory/dispatcher.ts';
import { NotifyListener, createPgNotifyConnection } from './memory/notify-listener.ts';
import { IndexScheduler } from './memory/scheduler.ts';
import { StartupRecovery } from './workflow/recovery.ts';
import { LeaseHeartbeat } from './workflow/heartbeat.ts';
import type { LeaseHeartbeatOptions } from './workflow/heartbeat.ts';
import type { IndexSchedulerOptions } from './memory/scheduler.ts';
import type { EmbeddingProvider } from './memory/embedding.ts';
import { EmbeddingRevisionRegistry } from './memory/embedding.ts';
import { PgExecutionStore } from './execution/pg-store.ts';
import { spawnRunner } from './execution/docker-sandbox.ts';
import {
  egressHostsForScope,
  syncEgressAllowlist,
  unrepresentableEgressEntries,
  withEgressSync,
  type EgressScopeTarget,
} from './execution/egress-allowlist.ts';
import { createExecutionService } from './execution/service.ts';
import type { ActionTemplateSpec, ParamBag } from './execution/templates.ts';
import { buildNormalizedCommand, createRegistry, portForScope, validateParams } from './execution/templates.ts';
import { canonicalTargetString, derivePlanHash } from './execution/idempotency.ts';
import { DockerSandbox } from './execution/docker-sandbox.ts';
import type { DockerSandboxConfig, ProcessRunner } from './execution/docker-sandbox.ts';
import { PgLeaseStore } from './workflow/pg-lease.ts';
import { PgPolicyService, PgSessionDirectory, PgActionPolicySource } from './policy/pg-policy.ts';
import { PgWorkflowService } from './workflow/pg-workflow.ts';
import { SYSTEM_OPERATOR_ID } from './workflow/model.ts';
import type { ActionPolicySource, GateFailureSink } from './execution/service.ts';
import type { AppendEventInput } from './contracts.ts';
import { DEFAULTS } from './contracts.ts';
import { BudgetMeter, LivenessMonitor, projectionOf } from './workflow/budget.ts';
import type { DshBudgetPort } from './workflow/budget.ts';
import type { BudgetLimits, SessionStatus } from './contracts.ts';
import {
  collectReconciliationInputs,
  reconcileEngagement,
} from './workflow/reconcile.ts';
import type { SessionReconciliationInput, EngagementReconciliation } from './workflow/reconcile.ts';
import { ConsoleRpc } from './console/rpc.ts';
import type { ConsoleServices } from './console/rpc.ts';
import { PgDiagnosticsService } from './console/diagnostics.ts';
import { PgReportService } from './report/pg-report.ts';
import { PgMemoryQueryService } from './memory/pg-memory-query.ts';
import { PgSkillService } from './skills/pg-skill.ts';
import type {
  CreatedSession,
  FrozenSessionInput,
  ModelRoute,
  SessionFactory,
} from './workflow/session-port.ts';
import { SessionFactoryError } from './workflow/session-port.ts';
import type {
  ApprovalPlanValidator,
  HumanWorkflowService,
  ValidatedApprovalPlan,
} from './contracts.ts';
import type { ExecutionService, PolicyService, ToolError } from './contracts.ts';
import type { WorkerToolDeps } from './tools/worker.ts';

/**
 * 运行期 RLS 的**部署级**上下文。
 *
 * ── 这里为什么只剩租户 ──
 *
 * 此前本类型还持有可变的 `engagementId` 与 `locked`：一个进程只能有一个作业，
 * 想访问第二个就被 `assertRlsEngagement` 拒绝。那条锁换来的是简单性——所有
 * `this.#db.query(...)` 都从这一个共享值取 engagement——代价是**一个进程一个作业**。
 *
 * 「每个会话各自一个作业」要求 engagement 成为**每个操作的事实**而不是进程状态，
 * 因此它被移到 {@link RlsScope}（异步作用域），本类型只保留租户：
 * 租户是部署属性，全进程唯一且不变，放在进程级是正确的。
 */
export interface RuntimeRlsContext {
  readonly tenantId: string;
}

/**
 * 一次操作的 RLS 作用域：本操作属于哪个租户、哪个作业、哪个 Worker 会话。
 *
 * ── 为什么用异步作用域而不是逐处传参 ──
 *
 * 读路径有一百多处 `this.#db.query(...)`。逐处加一个 engagement 参数是**不可审的
 * 改动面**，而且漏掉一处的后果不是编译错误（参数可选）就是静默错误。
 * `AsyncLocalStorage` 让作用域随异步调用的自然边界传播：并发操作各持各的 store，
 * 不存在交叉。仓库里 `DbTransactionRunner` 已经是这个做法。
 *
 * ── `engagementId: null` 是合法取值 ──
 *
 * `listEngagements`、skill 库这类操作本来就只按**租户**定界（013 的租户级
 * PERMISSIVE 策略正是为它们加的）。强行要求一个 engagement 会让它们查不到东西。
 *
 * ── 漏设作用域的后果 ──
 *
 * 未设作用域时按**租户级**处理：engagement 作用域的查询在 RLS 下看不见任何行
 * （fail closed），而不是读到别的作业的数据。这是刻意的取向——宁可返回空、
 * 让人发现漏了，也不能让两个作业的数据互相泄漏。
 */
export interface RlsScope {
  readonly tenantId: string;
  readonly engagementId: string | null;
  readonly workerSessionId: string | null;
}

/** 组合配置。密钥类字段只接受引用或已解析的值，本模块不读环境变量。 */
export interface ComposeConfig {
  readonly database: {
    readonly url: string;
    /** 连接池上限。写路径另占一条独占连接。 */
    readonly poolMax?: number;
    /**
     * 启动时跑表结构迁移；省略即 **true**。
     *
     * 默认开的原因：schema 归本插件所有（迁移文件就在 `src/db/migrations/`），
     * 而「忘了迁移」的失败形态极难诊断——插件照常启动、界面照常渲染，只有每次动作
     * 都以 `relation "pentest.xxx" does not exist` 失败。`migrate()` 幂等且在有
     * 版本记录时只做一次查询，所以每次启动跑它的代价可以忽略。
     *
     * 关掉的场景：部署方的数据库角色**没有 DDL 权限**（迁移由独立的发布步骤做），
     * 那时自动迁移会以权限错误让整个启动失败。
     */
    readonly migrateOnStartup?: boolean;
  };
  /** 批次签名密钥，由 Host 从 KMS 取。 */
  readonly ledgerSecret: LedgerSecret;
  readonly sandbox: DockerSandboxConfig;
  /** 受信动作模板集。省略即用服务端默认集（仅被动读取与主动发现）。 */
  readonly templates?: readonly ActionTemplateSpec[];
  /**
   * DNS 裁决钩子（§10.2.2 地址固定）。
   * 省略则域名目标按 `dns_unresolved` 拒绝——不退化按域名拨号。
   */
  readonly resolveAddresses?: (host: string) => Promise<readonly string[] | undefined>;
  /** 嵌入查询钩子；省略则检索退化为纯词法路径。 */
  readonly embedQuery?: (text: string) => Promise<readonly number[]>;
  /** 沙箱进程运行器注入（测试用；生产省略即用真实 spawn）。 */
  readonly sandboxRunner?: ProcessRunner;
  /**
   * RLS 上下文。
   *
   * 数据库已 FORCE ROW LEVEL SECURITY，非所有者角色在未设会话变量时读不到任何行。
   * 这里只声明**租户**——它是部署属性。作业（engagement）属于**每个操作**，
   * 经 `ComposedPlugin.rls.run(...)` 建立作用域，不再是进程级状态：
   * 一个进程可以同时服务多个作业，各会话互不干扰。
   */
  readonly rlsContext?: { readonly tenantId: string };
  /**
   * 操作者标识，用于**没有控制台调用上下文**的写操作。
   *
   * 控制台的操作者来自 `CallContext`（传输层认证），但「会话即 intake」是
   * **Agent 在对话里发起**的：那里没有 `CallContext`，而 `engagements.created_by`
   * 是 NOT NULL 且要能回答「谁开的这个作业」。由装配层注入部署声明的身份
   * （与 `config.operator` 同一来源）。
   *
   * 省略即落到 `SYSTEM_OPERATOR_ID`——审计里一眼能看出「这不是人点的」。
   */
  readonly operatorId?: string;
  readonly dshBudget?: DshBudgetPort;
  /** 租约生命周期审计归属；省略则仅记录到宿主日志，不伪造 engagement。 */
  readonly leaseAuditEngagementId?: string;
  /**
   * 探测 dsh 侧会话是否可达，供启动对账使用（§15.2）。
   * 省略则对账把「不可达」保守判为不可达——不假装会话还活着。
   */
  readonly probeDshSession?: (dshSessionId: string) => Promise<boolean>;
  /**
   * 会话工厂：工作流创建/驱动顶层 dsh 会话的唯一入口（§4.3）。
   *
   * **由插件的装配层注入**（`index.ts` 构造 `DshSessionFactory`）：真实实现需要
   * cordis `Context` 才能 `ctx.agents.create`，而组合根本不持有 `ctx`——它的职责
   * 是纯服务装配，所以这个参数只能从外面传进来。
   *
   * 省略时工作流用 `missingSessionFactory`：`startWorker` 会以明确错误失败，
   * 而不是静默什么都不做。**注意这只该发生在测试或刻意降级的部署里**——曾经
   * 生产装配路径也从不注入它，于是任何 Agent 都起不来（见 `index.ts` 的接线）。
   */
  readonly sessions?: SessionFactory;
  /**
   * 内置默认能力使用的模型路由（provider/model）；省略即插件内置默认。
   *
   * 只在内置能力解析器生效时（即没有自定义 `capabilities`）有意义，因为路由
   * 是解析器输出的一部分。真实部署按自己的供应商改这里。
   */
  /**
   * 显式模型路由，或**解析函数**（每次创建会话现取）。
   *
   * 函数形式是给「跟随人类当前选择」用的：界面里的模型是活的，快照会让 Agent 永远用旧模型。
   * 显式给了值就以它为准（部署要钉死模型时用）。
   */
  readonly modelRoute?: ModelRoute | (() => ModelRoute | undefined);
  /**
   * Worker 会话要挂载的 dsh agent 预设 id；省略即 `pentest`（本插件随包发的那个）。
   *
   * 这个字段**不是**「是否启用渗透模式」的开关——本插件的功能不依赖预设。它控制的是
   * 那层**姿态提示词**（「你在一个受授权约束的作业里」）要不要进会话。
   *
   * 三种取值：
   *   - 省略 / 字符串：尝试挂载；清单里没有就记 `warn` 并跳过（**不**让会话创建失败）。
   *   - `null` 或 `''`：明确不挂，静默。
   *
   * 注意这里存的是**类型上**的 `unknown`——`index.ts` 刻意不依赖本文件的类型。
   */
  readonly sessionPreset?: string | null;
  /**
   * 新建 dsh 会话的工作目录；省略用进程的 cwd。
   *
   * 与安全无关（沙箱是隔离边界），只影响会话自己的相对路径解析与日志落点。
   * 独立配置的好处是会话不会把临时文件写进 harness 仓库。
   */
  readonly sessionCwd?: string;
  /**
   * 嵌入提供方（§12.2 本地或远端）。省略则索引器**只做词法索引**——
   * 分块仍落库（有版本、有全文索引），但没有向量，语义检索退化为词法。
   * 这是明确降级而非静默失败：水位与结果里都会标明 `lexicalOnly`。
   */
  readonly embeddings?: EmbeddingProvider;
  /** outbox 队列参数（§8.4）。省略即用模块默认。 */
  readonly outbox?: OutboxOptions;
  /**
   * skill 改动的审计归属 engagement（§2.2）。
   *
   * **为什么需要它**：skill 是**全局库**（不属于任何 engagement），而审计事件表
   * `context_events.engagement_id` 是 `NOT NULL` 且有外键。因此全局操作的事件必须
   * 归到某个真实 engagement 名下。省略即**不写 skill 审计**——那是明确的降级，
   * 装配时会记警告，因为 §2.2 要求技能改动留痕（正文是指令文本，改它等于改 Agent 行为）。
   */
  readonly skillAuditEngagementId?: string;
  /** 检索文本投影（§8.6 中文分词）。省略即用原文。 */
  readonly projectForSearch?: (content: string) => string;
  /**
   * 索引调度参数（§14.3）。`intervalMs: null` 表示不启用周期——
   * 那种部署形态下索引只在启动跑一次，之后由外部触发。
   */
  readonly scheduler?: IndexSchedulerOptions;
  /**
   * 唤醒通知（§8.4）。省略即启用；显式 `false` 关掉它。
   *
   * 关掉的场景：极多实例部署时，每个实例持一条 LISTEN 长连接可能不划算。
   * 关掉只影响**延迟**（周期扫描与启动重扫仍是可靠性来源），不影响正确性。
   */
  readonly notify?: { readonly enabled?: boolean; readonly channel?: string } | false;
  /**
   * 租约心跳参数（§10.6）。省略即用默认（心跳 60 秒、提前 180 秒续租）。
   *
   * 心跳是**必需**的：默认 TTL 600 秒，而执行闸门在过期时拒绝——没有心跳，
   * 任何运行超过 10 分钟的会话都无法执行动作。
   */
  readonly heartbeat?: LeaseHeartbeatOptions;
}

/** 组合产物：交给 `apply` 的宿主服务面。 */
export interface ComposedPlugin {
  readonly createBudget: (input: {
    readonly dshSessionId: string;
    readonly limits: BudgetLimits;
    readonly startedAt: Date;
    readonly status?: SessionStatus;
  }) => BudgetMeter | null;
  /** 绑定真实 dsh session/event 到 Worker 预算闸门。 */
  readonly budgetLifecycle: {
    observe(dshSessionId: string, eventType: 'step/start' | 'assistant/message'): Promise<void>;
  };
  /** 按会话构造进度活性监视（§10.5）。 */
  readonly createLiveness: (startedAt: Date) => LivenessMonitor;
  readonly hostServices: {
    readonly workerTools: WorkerToolDeps;
    readonly consoleRpc: ConsoleRpc;
  };
  readonly execution: ExecutionService;
  readonly ledger: MemoryLedger;
  readonly leases: PgLeaseStore;
  readonly policy: PolicyService;
  readonly workflow: PgWorkflowService;
  readonly report: PgReportService;
  readonly memoryQuery: PgMemoryQueryService;
  readonly skills: PgSkillService;
  /** 诊断面（§15.5）：只读快照，控制台总览卡与排障使用。 */
  readonly diagnostics: PgDiagnosticsService;
  /** 对账（§15.2）：把崩溃残留变成确定结论。 */
  readonly reconcile: {
    collect(engagementId: string): Promise<readonly SessionReconciliationInput[]>;
    evaluate(engagementId: string, sessions: readonly SessionReconciliationInput[]): EngagementReconciliation;
  };
  /** 索引任务队列（§8.4）。账本追加时经它同事务入队。 */
  readonly outbox: PgOutboxQueue;
  /**
   * 记忆索引器（§8.4）。
   *
   * 未配 `embeddings` 时它只做词法索引——分块仍落库、有版本与全文索引，
   * 但没有向量。这一降级在 `IndexEventResult.lexicalOnly` 与水位上可见。
   */
  readonly indexer: MemoryIndexer;
  /**
   * 索引调度器（§8.4）：消费 outbox，把每个任务交给索引器。
   *
   * 它是让记忆链路真正运转起来的那一环——没有它，队列只进不出，
   * `memory_chunks` 永远为空，检索面恒返回空。
   */
  readonly dispatcher: IndexDispatcher;
  /**
   * 租约心跳（§10.6）：周期性续租，防止活动会话因 TTL 到期而无法执行动作。
   *
   * 与调度器同理，`compose` 不自动启动它。
   */
  readonly heartbeat: LeaseHeartbeat;
  /**
   * 唤醒通知监听（§8.4）。
   *
   * 关掉时为 `null`。它只是**延迟优化**：订阅到 `outbox_jobs` 入队时发的
   * `pg_notify`，让索引器立刻工作而不是等下一个周期。丢了只晚一个间隔，
   * 周期扫描与启动重扫才是可靠性来源。
   */
  readonly notify: NotifyListener | null;
  /**
   * 索引调度器（§14.3）：启动重扫 + 周期排空。
   *
   * `compose` **不自动启动它**——启动是有副作用的动作（会立刻读写数据库），
   * 由装配层在确认要启用时显式 `start()`。这样 `compose` 保持可测与无副作用。
   */
  readonly scheduler: IndexScheduler;
  /**
   * 启动对账执行者（§15.2）：把崩溃残留变成确定结论。
   *
   * `compose` 不自动运行它（与调度器同理：启动是有副作用的动作）。
   * 装配层在确认启用时调用 `recoverAll()`。
   */
  readonly recovery: StartupRecovery;
  /** 关闭连接池与独占连接。 */
  readonly dispose: () => Promise<void>;
  /**
   * 在指定作业/会话作用域内运行一段操作。
   *
   * **所有触及 engagement 作用域数据的入口都必须经它**：作用域外查询落在租户级，
   * RLS 会挡住 engagement 行。见 {@link RlsScope}。
   */
  readonly rls: RlsScopePort;
}

/**
 * RLS 作用域端口：建立作用域、读当前作用域。
 *
 * 由 `compose` 基于 `AsyncLocalStorage` 实现，供工作流与组合层复用
 * （`WorkflowServiceDeps.rlsScope` 收的就是它）。
 */
export interface RlsScopePort {
  run<T>(
    scope: { readonly engagementId?: string | null; readonly workerSessionId?: string | null },
    work: () => Promise<T>,
  ): Promise<T>;
  current(): RlsScope | undefined;
}

/** 连接池包一层 RLS：每次查询在**当前异步作用域**的租户/作业下执行。 */
function poolAsDbClient(
  pool: Pool,
  rlsContext: RuntimeRlsContext | undefined,
  scopes: AsyncLocalStorage<RlsScope>,
): RlsAwareDbClient {
  const queryWithContext = async <Row>(
    context: DbRlsContext,
    sql: string,
    params?: readonly unknown[],
  ) => {
    const client = await pool.connect();
    try {
      await client.query('begin');
      await client.query('select pentest.set_rls_context($1, $2::uuid, $3::uuid)', [
        context.tenantId,
        context.engagementId,
        context.workerSessionId,
      ]);
      const result = await client.query(sql, params as unknown[] | undefined);
      await client.query('commit');
      return { rows: result.rows as Row[], rowCount: result.rowCount };
    } catch (error) {
      await client.query('rollback').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  };
  return {
    async query<Row = Record<string, unknown>>(sql: string, params?: readonly unknown[]) {
      if (rlsContext === undefined) {
        const result = await pool.query(sql, params as unknown[] | undefined);
        return { rows: result.rows as Row[], rowCount: result.rowCount };
      }
      // 作用域缺省即**租户级**（engagement 为 NULL）：engagement 作用域的查询在 RLS 下
      // 看不见任何行，是 fail closed。见 `RlsScope` 的说明。
      return queryWithContext<Row>(
        scopes.getStore() ?? { tenantId: rlsContext.tenantId, engagementId: null, workerSessionId: null },
        sql,
        params,
      );
    },
    queryWithRlsContext: queryWithContext,
  };
}

/**
 * 为常驻写连接包一层：事务调度器发出 BEGIN 时，立即在同一事务设置 RLS。
 * 事务级设置会随 COMMIT/ROLLBACK 清除，不会污染连接池复用。
 */
function txClientWithRlsContext(
  db: DbClient,
  rlsContext: RuntimeRlsContext | undefined,
  scopes: AsyncLocalStorage<RlsScope>,
): DbClient {
  if (rlsContext === undefined) return db;
  return {
    async query<Row = Record<string, unknown>>(sql: string, params?: readonly unknown[]) {
      const result = await db.query<Row>(sql, params);
      if (/^\s*begin\b/i.test(sql)) {
        // 事务级设置：作用域缺省即租户级（engagement 为 NULL）。
        // 注意 `#tx` 的 setup 会在 BEGIN 之后再设一次显式作用域，那是权威值。
        const active = scopes.getStore();
        await db.query('select pentest.set_rls_context($1, $2::uuid, $3::uuid)', [
          active?.tenantId ?? rlsContext.tenantId,
          active?.engagementId ?? null,
          active?.workerSessionId ?? null,
        ]);
      }
      return result;
    },
  };
}

/** 独占连接：事务的唯一合法载体。 */
export interface TxClientHandle {
  readonly client: DbClient;
  /**
   * 归还连接。传错误即**销毁**而不是归还池中（pg-pool 的 `release(err)` 语义）——
   * 出错的连接不可复用。
   */
  readonly release: (error?: unknown) => void;
  /**
   * 登记连接级错误监听器（必须在任何查询之前调用）。
   *
   * pg 在后端终止/网络断开时会在 **Client 实例**上抛 `'error'`；没有监听器时
   * Node 以未捕获异常终止整个宿主进程（实测：进程 exit 1）。池上的监听器
   * **接不住已经借出的连接**——与 notify-listener 为自有连接单独挂监听器同一原因。
   */
  readonly onError: (handler: (error: Error) => void) => void;
}

/**
 * 未注入会话工厂时的占位实现。
 *
 * 它**每个方法都抛错**，而不是静默返回空值。理由：工作流拿不到工厂时，
 * 「创建会话」这件事无从完成；静默返回一个假标识会让状态机以为会话已建立，
 * 进而在一个不存在的会话上推进阶段——那是比直接失败严重得多的后果。
 *
 * 报错信息直接指出该注入什么，减少部署排障成本。
 */
export const missingSessionFactory: SessionFactory = {
  async create(input: FrozenSessionInput): Promise<CreatedSession> {
    throw new SessionFactoryError(
      `未注入会话工厂，无法创建顶层 dsh 会话（workerSessionId=${input.workerSessionId}）。` +
        `请在组合配置里提供 config.sessions —— 真实实现 DshSessionFactory 需要 cordis Context。`,
      { dshSessionId: input.dshSessionId },
    );
  },
  async deliver(dshSessionId: string): Promise<void> {
    throw new SessionFactoryError(`未注入会话工厂，无法投递消息到 ${dshSessionId}`, { dshSessionId });
  },
  async interrupt(dshSessionId: string): Promise<void> {
    throw new SessionFactoryError(`未注入会话工厂，无法中断 ${dshSessionId}`, { dshSessionId });
  },
  async close(dshSessionId: string): Promise<void> {
    throw new SessionFactoryError(`未注入会话工厂，无法关闭 ${dshSessionId}`, { dshSessionId });
  },
};


/**
 * 建立连接池（读写共用）。
 *
 * `pool.on('error')` **不是可选装饰**：空闲连接被后端终止（PG 重启、Docker 重启、
 * 网络闪断）时，pg 会在 Pool 上抛 `'error'`；没有监听器时 Node 以未捕获异常终止
 * **整个宿主进程**（实测：exit 1）。接住它只是记录——池自身会回收并重建连接。
 */
export function createDatabasePool(
  database: ComposeConfig['database'],
  onError: (error: Error) => void,
): Pool {
  const pool = new Pool({ connectionString: database.url, max: database.poolMax ?? 20 });
  pool.on('error', onError);
  return pool;
}

/**
 * 获取一条独占连接。
 *
 * 调用方必须 `release()`；本函数不做池内缓存（同一时刻只允许一个写事务，
 * 由调用方的串行化保证，见文件头「写路径串行化」）。
 */
export async function acquireTxClient(pool: Pool): Promise<TxClientHandle> {
  const client: PoolClient = await pool.connect();
  return {
    client: {
      async query<Row = Record<string, unknown>>(sql: string, params?: readonly unknown[]) {
        const result = await client.query(sql, params as unknown[] | undefined);
        return { rows: result.rows as Row[], rowCount: result.rowCount };
      },
    },
    onError: (handler) => { client.on('error', handler); },
    release: (error?: unknown) => {
      // pg-pool 的约定：`release(err)` 传真值即**销毁**该连接而不是归还。
      if (error === undefined) client.release();
      else client.release(error instanceof Error ? error : true);
    },
  };
}

/**
 * 关停时等待在途查询结清的上限（毫秒）。超时即销毁连接——
 * pg 自己的 `Client#end` 对挂死查询也是强制断开（`non-pipeline: a hung query
 * could block end forever — force disconnect`）。
 */
const DEFAULT_TX_DRAIN_TIMEOUT_MS = 5_000;

/**
 * 独占写连接：按需获取、出错失效、下次写入自动重建。
 *
 * ── 为什么必须这样（都是实测踩出来的）──
 *
 * 1. **连接级 'error' 没有监听器 = 宿主进程崩溃**。PG 重启/`pg_terminate_backend`/
 *    网络闪断时，pg 在 **Client 实例**上抛 `'error'`；池上的监听器**接不住已借出的
 *    连接**（两个方向都实测过：借出态崩溃、空闲态靠 pool 监听器存活）。
 * 2. **句柄不能缓存到永久**。连接失效后若继续复用，所有写入（含审计）永久失败，
 *    `audit_unavailable` 闸门让插件在进程重启前彻底停摆——fail-closed 应当只作用于
 *    出错的那一次调用。
 *
 * 因此：拿到句柄立刻挂监听器；连接失效（监听器触发，或查询以连接类错误失败）就
 * 销毁并清空句柄，下一次写入重新获取。测试用真实 `pg_terminate_backend` 覆盖。
 */
export function createTxDb(
  pool: Pool,
  hooks: {
    readonly onError?: (error: Error) => void;
    /** 覆盖关停排空上限（测试注入）；省略即 {@link DEFAULT_TX_DRAIN_TIMEOUT_MS}。 */
    readonly drainTimeoutMs?: number;
  } = {},
): TxDbPort {
  const drainTimeoutMs = hooks.drainTimeoutMs ?? DEFAULT_TX_DRAIN_TIMEOUT_MS;
  let handle: TxClientHandle | null = null;
  let pending: Promise<TxClientHandle> | null = null;
  let disposed = false;
  /** 在途查询计数：dispose 必须等它们结清再归还连接（见 dispose 的说明）。 */
  let activeQueries = 0;
  const drainWaiters: Array<() => void> = [];
  const settleDrain = (): void => {
    if (activeQueries === 0) for (const resolve of drainWaiters.splice(0)) resolve();
  };

  /**
   * 让某个**具体的**连接句柄失效。
   *
   * 绑定到具体句柄而不是「无条件清当前句柄」有两个原因（评审实测）：
   *   - pg 在查询在途时断开连接会产生**两个**信号（先 reject 在途查询，再同步 emit 'error'），
   *     第二次信号到达时句柄早已清空——不加身份判定就会重复上报；
   *   - 迟到的旧信号若顺手清掉 `pending`，会打断一次**正在进行**的获取去重，
   *     让两条独占连接同时存在、其中一条被永久泄漏。
   * 在途获取的清理由它自己的结算回调负责（`pending` 不在这里动）。
   */
  const invalidate = (client: TxClientHandle, error: unknown): void => {
    if (handle !== client) return; // 过期信号：不释放当前句柄，也不碰在途获取
    handle = null;
    client.release(error);
    if (error instanceof Error) hooks.onError?.(error);
  };

  const db: DbClient = {
    async query<Row = Record<string, unknown>>(sql: string, params?: readonly unknown[]) {
      if (disposed) {
        throw new Error('audit_unavailable: 独占写连接已释放（dispose 之后不得再写入）');
      }
      if (handle === null) {
        pending ??= acquireTxClient(pool).then(
          (acquired) => {
            if (disposed) {
              // dispose 已经发生：不得复活句柄——销毁这条刚取得的连接并拒绝本次调用。
              acquired.release();
              pending = null;
              throw new Error('audit_unavailable: 独占写连接已释放（获取期间发生 dispose）');
            }
            // 监听器先于任何查询挂上：FATAL 可能在两次使用之间的静默期到达。
            acquired.onError((error) => { invalidate(acquired, error); });
            handle = acquired;
            pending = null;
            return acquired;
          },
          (error: unknown) => {
            // 获取失败也**必须清空在途 promise**：否则后续每次写入都会 await 同一个
            // rejected promise，写路径（含审计）在进程重启前永久停摆——fail-closed
            // 应当只作用于出错的那一次调用（实测：桩 pool 下第 2、3 次调用复读同一错误）。
            pending = null;
            hooks.onError?.(error instanceof Error ? error : new Error(String(error)));
            throw error;
          },
        );
        await pending;
      }
      const current = handle;
      if (current === null) throw new Error('audit_unavailable: 无法获取独占写连接');
      activeQueries += 1;
      try {
        return await current.client.query<Row>(sql, params);
      } catch (error) {
        // 连接类失败才销毁句柄；领域错误（约束、类型…）不得连带丢弃健康连接。
        if (isConnectionFailure(error)) invalidate(current, error);
        throw error;
      } finally {
        activeQueries -= 1;
        settleDrain();
      }
    },
  };

  return {
    db,
    dispose: async () => {
      disposed = true;
      // 在途获取：它的回调会看到 disposed 并把连接销毁；失败则已在 onError 报过。
      const inFlight = pending;
      pending = null;
      if (inFlight !== null) await inFlight.catch(() => undefined);
      // 在途查询必须先结清：否则连接会在语句未返回时被交还池中，池可能把它转手
      // 给别的调用者，两条语句在同一连接上交错。
      if (activeQueries > 0) {
        // 不用 `Promise.withResolvers`：它需要 lib es2024，而本仓 lib 是 es2023
        // （与 docker-sandbox.ts 的同款说明）。
        const drained = await new Promise<boolean>((resolve) => {
          const timer = setTimeout(() => { resolve(false); }, drainTimeoutMs);
          timer.unref?.();
          drainWaiters.push(() => { clearTimeout(timer); resolve(true); });
        });
        if (!drained) {
          // 在途语句迟迟不结清（等锁 / TCP 黑洞 / statement_timeout=0）：按 pg 自身的
          // 关停语义**销毁**连接（socket 断开会让语句立即失败），而不是把关停永久挂住。
          const stuck = handle;
          handle = null;
          await stuck?.release(new Error('dispose：在途查询未在期限内结清，连接已销毁'));
          return;
        }
      }
      const current = handle;
      handle = null;
      await current?.release();
    },
  };
}

/**
 * 连接类失败判定：SQLSTATE 08xxx（连接异常）/ 57P0x（后端关停），或没有 SQLSTATE
 * 的网络层错误文案（socket 断开时 pg 只给 message）。
 */
function isConnectionFailure(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const code: unknown = 'code' in error ? error.code : undefined;
  if (typeof code === 'string') return code.startsWith('08') || /^57P0/.test(code);
  const message: unknown = 'message' in error ? error.message : undefined;
  return typeof message === 'string' && /connection terminated|socket hang up|connection ended/i.test(message);
}

/**
 * 按会话建立作用域地包装 `WorkerToolDeps` 的每个方法。
 *
 * ── 为什么必须在组合层做 ──
 *
 * Worker 工具由 **dsh 的 agent loop** 调用，不经过控制台 RPC，因此没有
 * `ConsoleRpc.#withScope` 建立的外层作用域。而工具依赖的服务（执行服务的 `admit`、
 * 策略读取、放行记录）用的是裸 `this.#db.query(...)`——没有作用域就落在**租户级**，
 * `worker_sessions` / `scope_versions` 这类表一行都读不到。
 *
 * 实测（`.qc/probe-binding.ts`）：`PgSessionDirectory.binding()` 在无作用域时返回
 * `undefined`，有作用域时正常返回。于是 `pentest_exec` 与
 * `pentest_request_action_approval` 在**任何**已确认作业上都无法通过会话准入——
 * 主执行路径整体不可用，而错误文案会指向「会话不存在」，与实际原因无关。
 *
 * 逐个人工包装每个方法是可行的，但那样「新加的工具忘了包」会再次静默失效。
 * 这里按 `WorkerToolDeps` 的统一形状（每个方法首个入参都带 `workerSessionId`）做一次
 * 结构性包装，让这条不变量只写一遍。
 *
 * 入参里没有 `workerSessionId` 时不套作用域：那是编程错误，交给下游的类型与准入
 * 检查暴露，而不是在这里猜一个会话。
 */
function scopeWorkerToolsBySession(
  deps: WorkerToolDeps,
  enter: (workerSessionId: string, work: () => Promise<unknown>) => Promise<unknown>,
): WorkerToolDeps {
  const wrapped: Record<string, unknown> = {};
  for (const [name, fn] of Object.entries(deps)) {
    wrapped[name] = async (input: unknown) => {
      const call = (): Promise<unknown> => (fn as (value: unknown) => Promise<unknown>)(input);
      const workerSessionId = (input as { readonly workerSessionId?: unknown } | null | undefined)
        ?.workerSessionId;
      if (typeof workerSessionId !== 'string' || workerSessionId.length === 0) return call();
      return enter(workerSessionId, call);
    };
  }
  return wrapped as unknown as WorkerToolDeps;
}

/**
 * 执行服务的 `execute` 缺少 `WorkerToolDeps` 需要的形状：
 * 前者是「先 admit 再 execute」两步，后者是单一入口。这里做适配。
 *
 * 拒绝路径原样返回契约错误，不用 `as never` 之类的手段掩盖形状——
 * 那会让类型检查看不到「拒绝载荷」这条路径。
 */
function makeWorkerExecute(execution: ExecutionService): WorkerToolDeps['execute'] {
  return async (input) => {
    // 会话标识以**本方法收到的**为准，不信 intent 里的副本——与
    // `PgWorkerTools.requestApproval` 同一条纪律（服务端权威绑定）。
    // 两处若不一致，静默采用 intent 的那份会让「哪个会话在执行」出现两个真相。
    const decision = await execution.admit({ ...input.intent, workerSessionId: input.workerSessionId });

    if (decision.kind === 'rejected') {
      return { kind: 'blocked', error: decision.error };
    }
    if (decision.kind === 'needs_approval') {
      const pending: ToolError = {
        status: 'blocked',
        code: 'approval_required',
        message: '该动作需要人类放行',
        approval_id: decision.approvalId,
        next_action: '等待控制台放行；插件会把授权送回本会话，不要重试相同调用',
      };
      return { kind: 'blocked', error: pending };
    }

    const result = await execution.execute(decision.plan, input.signal);
    return { kind: 'executed', plan: decision.plan, result };
  };
}

function objectRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

/**
 * 构造人类修改审批计划的唯一服务端重入点。
 *
 * 输入只允许模板 id、目标选择器、标量参数和目的；命令文本、规范化目标、类别、
 * 地址集合与摘要全部由当前策略服务重新生成。这样「修改后放行」不会变成一条
 * 受人类输入控制的自由命令通道。
 */
const APPROVAL_PLAN_KEYS: Record<string, true> = {
  template_id: true,
  target_selector: true,
  params: true,
  purpose: true,
};

function hasApprovalPlanKey(key: string): boolean {
  return Object.hasOwn(APPROVAL_PLAN_KEYS, key);
}

function approvalPlanValidatorFor(
  policy: PgPolicyService,
  sessions: PgSessionDirectory,
  actions: ActionPolicySource,
): ApprovalPlanValidator {
  return {
    async validate(context, modifiedCommandPlan): Promise<ValidatedApprovalPlan | undefined> {
      const input = objectRecord(modifiedCommandPlan);
      if (input === undefined) return undefined;
      if (Object.keys(input).some((key) => !hasApprovalPlanKey(key))) return undefined;
      const templateId = input['template_id'];
      const targetSelector = input['target_selector'];
      const purpose = input['purpose'];
      if (typeof templateId !== 'string' || templateId.length === 0) return undefined;
      if (typeof targetSelector !== 'string' || targetSelector.length === 0) return undefined;
      if (typeof purpose !== 'string' || purpose.trim().length === 0 || purpose.length > 500) return undefined;

      const rawParams = input['params'] === undefined ? {} : objectRecord(input['params']);
      if (rawParams === undefined) return undefined;
      const params: Record<string, string | number> = {};
      for (const [name, value] of Object.entries(rawParams)) {
        if (typeof value !== 'string' && !(typeof value === 'number' && Number.isInteger(value))) return undefined;
        params[name] = value;
      }

      const spec = policy.listActionTemplates().find((candidate) => candidate.template.id === templateId);
      if (spec === undefined) return undefined;
      const paramsVerdict = validateParams(spec.template, params as ParamBag, { allowFreeForm: spec.allowFreeForm === true });
      if (!paramsVerdict.ok) return undefined;
      const classified = await policy.classifyAction({ templateId, params });
      if (!classified.ok || classified.actionClass !== context.actionClass) return undefined;

      if (context.workerSessionId === null || context.scopeVersion === null || context.policyEpoch === null) {
        return undefined;
      }
      const binding = await sessions.binding(context.workerSessionId);
      if (
        binding === undefined ||
        binding.engagementId !== context.engagementId ||
        binding.scopeVersion !== context.scopeVersion ||
        binding.policyEpoch !== context.policyEpoch ||
        binding.lease === null ||
        context.leaseGeneration === null ||
        binding.lease.generation !== context.leaseGeneration
      ) return undefined;

      const port = portForScope(spec, params as ParamBag);
      const scope = await policy.evaluateScope({
        engagementId: context.engagementId,
        scopeVersion: context.scopeVersion,
        target: targetSelector,
        protocol: spec.protocol,
        ...(port === undefined ? {} : { port }),
      });
      if (!scope.ok) return undefined;
      const normalizedTarget = canonicalTargetString(scope.normalized);
      const normalizedCommand = buildNormalizedCommand(spec, scope.normalized, params as ParamBag);
      // 与 `admit` 取**同一个**策略源：`policyVersion` 与展开后的 `pacing` 都必须
      // 进入摘要，否则这里算出的 planHash 与 Agent 重新受理时算出的必然不等，
      // 「人类修改后放行」的凭证就永远无法消费（而那正是人工收窄动作的通道）。
      const actionPolicy = await actions.forSession(context.workerSessionId);
      const planHash = derivePlanHash({
        templateId,
        actionClass: classified.actionClass,
        normalizedTarget,
        normalizedCommand,
        timeoutMs: spec.template.timeoutMs,
        maxOutputBytes: spec.template.maxOutputBytes,
        scopeVersion: context.scopeVersion,
        policyEpoch: context.policyEpoch,
        policyVersion: actionPolicy.policyVersion ?? null,
        pacing: actionPolicy.pacing ?? null,
      });
      return {
        templateId,
        targetSelector,
        params,
        actionClass: classified.actionClass,
        normalizedTarget,
        normalizedCommand,
        targetSnapshot: { normalized_target: normalizedTarget },
        planHash,
        scopeVersion: context.scopeVersion,
        policyEpoch: context.policyEpoch,
        leaseGeneration: context.leaseGeneration,
        timeoutMs: spec.template.timeoutMs,
        maxOutputBytes: spec.template.maxOutputBytes,
        purpose: purpose.trim(),
        riskSummary: `${classified.actionClass}：${purpose.trim()}`,
      };
    },
  };
}

/**
 * RLS 组合诊断（事故 2026-10-05）：只看配置无法判断 RLS 是否构成实际边界——
 * 超级用户/BYPASSRLS 角色绕过全部策略（FORCE 也拦不住），而非超级用户缺
 * `rlsContext` 时所有 engagement 作用域查询会静默落空（fail-closed 但功能不可用）。
 * 启动时探测一次当前角色的**真实属性**，由调用方据 {@link classifyRlsCombination}
 * 告警或拒绝启动。
 */
export interface RlsDiagnosis {
  readonly currentUser: string;
  readonly superuser: boolean;
  readonly rlsContextConfigured: boolean;
  /** 必须处置（调用方应拒绝启动）。 */
  readonly refusals: readonly string[];
  /** 应当知情（调用方告警即可）。 */
  readonly warnings: readonly string[];
}

/** 组合 → 结论（纯函数，四种组合各有确定结论；供测试与启动自检共用）。 */
export function classifyRlsCombination(input: {
  readonly superuser: boolean;
  readonly rlsContextConfigured: boolean;
}): { readonly refusals: readonly string[]; readonly warnings: readonly string[] } {
  if (input.superuser) {
    return input.rlsContextConfigured
      ? {
          refusals: [],
          warnings: [
            '连接角色是超级用户/BYPASSRLS：RLS 策略不生效（FORCE 也拦不住），rlsContext 只是形式；共享库部署前必须换用非超级用户（pentest_app）',
          ],
        }
      : {
          refusals: [],
          warnings: [
            '连接角色是超级用户/BYPASSRLS 且未配置 runtime.rlsContext：单租户形态，RLS 不构成实际边界（设计 §9.4 已声明；扩展到共享库前必须完成真实 pentest_app 连接与隔离验证）',
          ],
        };
  }
  return input.rlsContextConfigured
    ? { refusals: [], warnings: [] }
    : {
        refusals: [
          '连接角色不是超级用户却未配置 runtime.rlsContext：engagement 作用域查询会静默落空（fail-closed，但功能不可用）；请配置 rlsContext 或改用拥有者连接',
        ],
        warnings: [],
      };
}

/** 连接一次数据库，读当前角色属性并给出组合结论。连接失败按启动错误向上抛。 */
export async function inspectRls(
  database: { readonly url: string },
  rlsContextConfigured: boolean,
): Promise<RlsDiagnosis> {
  const client = new Client({ connectionString: database.url });
  await client.connect();
  try {
    const role = await client.query<{ current_user: string; superuser: boolean }>(
      `select current_user as current_user,
              coalesce((select rolsuper or rolbypassrls from pg_roles where rolname = current_user), false) as superuser`,
    );
    const row = role.rows[0];
    const superuser = row?.superuser === true;
    const classified = classifyRlsCombination({ superuser, rlsContextConfigured });
    return {
      currentUser: row?.current_user ?? 'unknown',
      superuser,
      rlsContextConfigured,
      ...classified,
    };
  } finally {
    await client.end();
  }
}

/**
 * 独占写连接的端口（`createTxDb` 的产物）。
 *
 * 具名而不是内联返回形状：安装器要把它当作产品的一部分传给调用方，
 * 内联形状会让下游只能用 `ReturnType<typeof createTxDb>` 表达类型。
 */
export interface TxDbPort {
  readonly db: DbClient;
  readonly dispose: () => Promise<void>;
}

/** 后台循环用的作用域端口：在 {@link RlsScopePort} 之上补一个作业列举。 */
export interface BackgroundScopes {
  readonly run: RlsScopePort['run'];
  readonly current: RlsScopePort['current'];
  readonly listEngagementIds: () => Promise<readonly string[]>;
}

/** `installDatabase` 的产物：连接池、读写通道、RLS 作用域端口。 */
export interface DatabaseInstallation {
  readonly pool: Pool;
  readonly readDb: DbClient;
  readonly txDb: DbClient;
  readonly txPort: TxDbPort;
  readonly rlsContext: RuntimeRlsContext | undefined;
  readonly rlsScopePort: RlsScopePort;
  readonly backgroundScopes: BackgroundScopes | undefined;
}

/**
 * 安装数据库层（连接池 + 读写通道 + RLS 作用域）。
 *
 * ── 为什么拆成安装器（2026-10-05 复核 C2）──
 *
 * `compose()` 此前是一个 880 行的函数：连接池、账本、索引器、策略、执行、工作流、
 * 控制台**顺序平铺**在一个作用域里，任何一处接线改动都要在整段里找位置，启动失败
 * （`config` 形状不对、数据库不可达）也没有局部性——错误栈只会指向 `compose` 的某一行。
 *
 * 安装器把「一块基础设施」的输入与产物显式写成类型：调用方只看
 * {@link DatabaseInstallation} 就知道这一层给出去什么，而这一层内部改接线不影响调用方。
 */
export function installDatabase(config: ComposeConfig): DatabaseInstallation {
  const pool = createDatabasePool(config.database, (error) => {
    console.warn(`[dsh-pentest] 连接池错误（空闲连接被终止或网络断开，池将自行回收重建）：${error.message}`);
  });
  // RLS 作用域：engagement 属于每个操作，不进进程状态（见 `RlsScope`）。
  const rlsScopes = new AsyncLocalStorage<RlsScope>();
  const rlsContext: RuntimeRlsContext | undefined = config.rlsContext === undefined
    ? undefined
    : { tenantId: config.rlsContext.tenantId };
  const readDb = poolAsDbClient(pool, rlsContext, rlsScopes);
  // 惰性获取：compose 是同步的，而 pool.connect() 是异步的。
  // 连接中断即失效，下一次写入自动重建（见 `createTxDb` 的说明）。
  const txPort = createTxDb(pool, {
    onError: (error) => {
      console.warn(`[dsh-pentest] 独占写连接不可用（获取失败或连接中断；下一次写入会自动重建）：${error.message}`);
    },
  });
  const txDb = txClientWithRlsContext(txPort.db, rlsContext, rlsScopes);

  /**
   * 在给定作业/会话作用域内运行一段操作。
   *
   * 所有触及 engagement 作用域数据的入口都必须经它——否则查询落在**租户级**
   * 作用域上，RLS 会把 engagement 行全部挡住（见 {@link RlsScope}）。
   *
   * 不加「嵌套沿用最外层」的保护：内层显式指定另一个作业是**调用方 bug**，
   * 静默沿用外层只会把它变成更难查的错读。内层覆盖外层，语义直白。
   */
  const runWithRlsScope: RlsScopePort['run'] = (
    scope,
    work,
  ) => {
    if (rlsContext === undefined) return work();
    return rlsScopes.run(
      {
        tenantId: rlsContext.tenantId,
        engagementId: scope.engagementId ?? null,
        workerSessionId: scope.workerSessionId ?? null,
      },
      work,
    );
  };
  const rlsScopePort: RlsScopePort = {
    run: runWithRlsScope,
    current: () => rlsScopes.getStore(),
  };
  /**
   * 在**租户级**作用域里列出本租户的全部作业。
   *
   * 后台循环（对账、心跳、索引调度）都要「先知道有哪些作业，再逐个进去」——
   * 它们的扫描表都没有租户级放行，全库一次查询在租户级下恒返回零行，
   * 表现为「循环正常但什么都没做」。
   *
   * `engagements` 本身有租户级 SELECT（`app_tenant_read`，015 的设计行为），
   * 因此这一条不需要任何作业作用域。
   */
  const listEngagementIds = async (): Promise<readonly string[]> => {
    const result = await readDb.query<{ id: string }>(
      `select id from pentest.engagements
        where status not in ('aborted','failed')
        order by updated_at desc`,
    );
    return result.rows.map((row) => row.id);
  };
  const backgroundScopes: BackgroundScopes | undefined = rlsContext === undefined
    ? undefined
    : { run: runWithRlsScope, current: () => rlsScopes.getStore(), listEngagementIds };

  return { pool, readDb, txDb, txPort, rlsContext, rlsScopePort, backgroundScopes };
}

/** `installIndexing` 的产物：队列、账本与索引器。 */
export interface IndexingInstallation {
  readonly outbox: PgOutboxQueue;
  readonly ledger: MemoryLedger;
  readonly indexer: MemoryIndexer;
}

/**
 * 安装「事件 → 分块」这条链：outbox 队列、账本（含锚点）与记忆索引器（§8.4）。
 *
 * 锚点与版本登记器**不**作为产物给出：它们只服务于这一层的内部装配
 * （锚点与账本共用写连接、登记器供索引器调用），调用方拿不到也不需要它们。
 */
export function installIndexing(input: {
  readonly config: ComposeConfig;
  readonly readDb: DbClient;
  readonly txDb: DbClient;
}): IndexingInstallation {
  const { config, readDb, txDb } = input;
  // ── 索引任务队列（§8.4）──
  //
  // 队列用 `txDb`（写连接）而不是连接池：账本要在**同一事务**里入队。
  // 单语句本身不需要事务，但共用一个写连接保证了「账本事务内的语句一定
  // 落在同一连接上」——若走池，入队会落到另一条连接、另起一个事务，
  // 原子性就没了。
  const outbox = new PgOutboxQueue(txDb, config.outbox ?? {});

  // ── 账本 ──
  //
  // 锚点必须与账本**共用同一条写连接**：账本在事务内调用 appendAnchor，
  // 而锚点 INSERT 需要 `engagements` 行的外键共享锁。若锚点走连接池，
  // 它会与状态写入持有的 `FOR UPDATE`（同一行）互相等待——死锁。
  // 用同一条连接后，锚点参与账本事务，锁由本事务自己持有，不会自锁。
  const anchors = new PgAnchorSink(txDb);
  const ledger = new MemoryLedger({
    db: readDb,
    txDb,
    secret: config.ledgerSecret,
    anchors,
    // 账本追加与索引入队同事务（§8.4）：分开提交会留下「事件已落库但
    // 永远不被索引」的静默缺口——它不报错，只能靠比对水位发现。
    indexOutbox: new LedgerIndexEnqueue(outbox),
  });

  // ── 记忆索引器（§8.4）──
  //
  // 未配嵌入提供方时它只做词法索引（分块仍落库，有版本与全文索引，无向量）。
  // 配了嵌入时同时接上版本登记器：检索侧的「只取活跃版本」过滤依赖
  // `embedding_revisions` 有一行 is_active（事故 2026-10-05：登记器零调用，
  // 跨版本混比防护空转）。
  const embeddingRevisions = config.embeddings === undefined
    ? undefined
    : new EmbeddingRevisionRegistry({ db: readDb, txDb });
  const indexer = new MemoryIndexer({
    db: readDb,
    txDb,
    ...(config.embeddings === undefined ? {} : { embeddings: config.embeddings }),
    ...(embeddingRevisions === undefined ? {} : {
      // 直接把记录交回索引器：`isActive` 决定这批分块会不会被检索面读到，
      // 因此索引器必须看到它（非生效版本要拒绝写入，见 indexer.ts 的版本登记）。
      ensureEmbeddingRevision: async (engagementId, descriptor) =>
        embeddingRevisions.ensureRevision(engagementId, descriptor),
    }),
    ...(config.projectForSearch === undefined ? {} : { projectForSearch: config.projectForSearch }),
  });

  return { outbox, ledger, indexer };
}

/** 装配全部服务。 */
export function compose(config: ComposeConfig): ComposedPlugin {
  // 账本签名密钥必须由部署注入：仓库内不再提供默认值（事故 2026-10-05——
  // 公开常量即有效密钥，知道它的人可以在库被篡改后重签批次）。
  if (typeof config.ledgerSecret !== 'string' || config.ledgerSecret === '') {
    throw new Error(
      'ledgerSecret 未配置：账本签名密钥必须由部署注入（环境变量 PENTEST_LEDGER_SECRET），不再提供仓库内默认值',
    );
  }
  const { pool, readDb, txDb, txPort, rlsContext, rlsScopePort, backgroundScopes } = installDatabase(config);
  const { outbox, ledger, indexer } = installIndexing({ config, readDb, txDb });

  // ── 策略与会话 ──
  const policy = new PgPolicyService(readDb, {
    ...(config.templates === undefined ? {} : { templates: config.templates }),
    ...(config.resolveAddresses === undefined ? {} : { resolveAddresses: config.resolveAddresses }),
  });
  const sessions = new PgSessionDirectory(readDb);
  const actions = new PgActionPolicySource(readDb);
  const approvalPlanValidator = approvalPlanValidatorFor(policy, sessions, actions);

  // ── 执行服务 ──
  const sandbox = new DockerSandbox(
    config.sandbox,
    config.sandboxRunner === undefined ? {} : { runner: config.sandboxRunner },
  );
  const store = new PgExecutionStore(readDb);

  // 系统暂停需要 workflow，而 workflow 在本文件后面才构造（它依赖 leases/ledger）。
  // 用一个可变引用打破这个先后：sink 只在**运行时**（检测到阈值时）读它，
  // 那时赋值早已完成。比把两个服务的构造顺序调换来换去清晰。
  let workflowRef: PgWorkflowService | null = null;
  const gateFailureRunner = transactionRunnerFor(txDb);
  /**
   * 闸门失败的记录与处置（§10.2.2）。
   *
   * 两件事在这里合起来做，因为它们必须同源：
   *   1. 写 `scope_violation` / `classification_rejected` 事件进账本；
   *   2. 数出「自上次成功执行以来」该会话的范围违规次数，达阈值时暂停。
   *
   * 计数与事件写入放在同一处：判据（账本事件 + tool_runs 终态）分散两处必然漂移，
   * 而漂移的表现是「暂停了但说不清为什么」或「该停没停」。
   */
  const gateFailures: GateFailureSink = {
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
        await ledger.appendEvent(appendInput);
        return 0;
      }

      let count = 0;
      await gateFailureRunner.run(async (tx) => {
        // 与工作流及其他状态写路径保持同一锁序：先锁 engagement，再进入账本的
        // engagement advisory lock，避免「账本锁 → engagement 行锁」与工作流
        // 「engagement 行锁 → 账本锁」形成死锁。
        await tx.query(
          `select id from pentest.engagements where id = $1::uuid for update`,
          [input.engagementId],
        );
        await ledger.appendBatchInTransaction(tx, [appendInput]);
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
        if (workflowRef === null) {
          throw new Error('系统暂停工作流尚未装配');
        }
        await workflowRef.pauseForSystem({
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
  /**
   * 审计可用性探针（§15.1）：走**真实的审计写路径**（`txDb` → 独占写连接）。
   *
   * 为什么探测 `txDb` 而不是别的：账本只在独占写连接上写（见上面 `txDb` 的说明）。
   * 那条路径失败正是 §15.1 要防的情形——连接池耗尽、独占连接被回收、写权限被撤。
   * 探一条只读查询会「通过」但审计写仍会失败，那是假的绿灯。
   *
   * 用 `select 1` 而不是真写一行：探针每次受理动作都会跑，写真实事件会污染账本；
   * 而 `select 1` 已经能暴露「拿不到写连接」与「连接已断」这两类失败——
   * 它们覆盖了实际会发生的绝大多数情况。表级权限被撤这类更细的故障仍会在
   * 写审计时抛出（`#audit` 不吞错），因此不会静默。
   *
   * 这个探针同时供执行闸门（每次受理动作）与诊断面（人工查看）使用——
   * 两处必须是**同一个**实现，否则诊断面的绿灯不代表闸门会放行。
   */
  const auditProbe = {
    async available() {
      try {
        await txDb.query('select 1 as ok');
        return { writable: true, detail: '' };
      } catch (error) {
        return {
          writable: false,
          detail: error instanceof Error ? error.message : String(error),
        };
      }
    },
  };
  const execution = createExecutionService({
    gateFailures,
    policy,
    sandbox,
    store,
    actions,
    registry: createRegistry(policy.listActionTemplates()),
    sessions,
    newId: () => crypto.randomUUID(),
    audit: auditProbe,
    /**
     * 策略与执行事件的审计落点（§6.2.0.5、§9.5）。
     *
     * 事件写不进去时**向上抛**：执行侧会把它翻译成 `audit_unavailable` 并拒绝动作
     * （§15.1「审计不可用时所有触及目标的动作停止」）。这里不吞错，也不降级成日志——
     * 一条只活在宿主日志里的事件，在审计回放里等于不存在。
     *
     * `trustLevel` 用 `tool_observation`：这些记录描述的是服务端对执行过程的观察
     * （裁决结果、施加的节奏、停止原因、目标侧迹象），不是人类决定。
     */
    executionAudit: {
      async record(input) {
        const payload = input.payload;
        await ledger.appendEvent({
          engagementId: input.engagementId,
          workerSessionId: input.workerSessionId,
          eventType: input.eventType,
          sourceSystem: 'pentest-execution',
          sourceId: `${input.eventType}:${crypto.randomUUID()}`,
          sourceSeq: 1,
          occurredAt: new Date(),
          payload,
          rawPayload: new TextEncoder().encode(JSON.stringify(payload)),
          classification: 'engagement',
          trustLevel: 'tool_observation',
        });
      },
    },
  });

  // ── 租约 ──
  //
  // Session-first 的租约事务要先从会话反查 engagement，才能带上上下文做第一次 FORCE-RLS 查询。
  //
  // 这条反查必须走 `pentest.engagement_for_worker_session`（SECURITY DEFINER，租户内生效），
  // 不能直接 `select engagement_id from worker_sessions`：015 之后那张表没有任何租户级放行，
  // 而此刻上下文里还没有 engagement——直查在 FORCE RLS 下恒为零行，于是这里静默返回 null，
  // 调用方表现为「会话不存在」。用函数反查是**唯一**既保持租户边界、又能先有鸡的形态。
  const leaseRlsContextForSession = rlsContext === undefined
    ? undefined
    : async (workerSessionId: string): Promise<{ readonly tenantId: string; readonly engagementId: string } | null> => {
        const result = await readDb.query<{ engagement_id: string | null }>(
          `select pentest.engagement_for_worker_session($1::uuid) as engagement_id`,
          [workerSessionId],
        );
        const engagementId = result.rows[0]?.engagement_id;
        return engagementId === undefined || engagementId === null
          ? null
          : { tenantId: rlsContext.tenantId, engagementId };
      };
  const leases = new PgLeaseStore(
    pool,
    {
      // 静态上下文只给租户：租约的事务级作业由 `rlsContextForSession` 逐会话解析，
      // 解析不到时落在租户级（查不到行 → fail closed），不会借别的作业的上下文。
      ...(rlsContext === undefined ? {} : {
        rlsContext: { tenantId: rlsContext.tenantId, engagementId: null },
      }),
      ...(leaseRlsContextForSession === undefined ? {} : { rlsContextForSession: leaseRlsContextForSession }),
      ...(config.leaseAuditEngagementId === undefined ? {} : {
        auditEngagementId: config.leaseAuditEngagementId,
        auditLifecycle: async (auditTx, event, engagementId) => {
          const leaseId = 'id' in event.lease ? event.lease.id : event.lease.leaseId;
          const identity = event.type === 'lease.renewed'
            ? `${leaseId}:${event.lease.expiresAt.toISOString()}`
            : leaseId;
          await ledger.appendBatchInTransaction(auditTx, [{
            engagementId,
            workerSessionId: event.lease.workerSessionId,
            eventType: event.type,
            sourceSystem: 'pentest-lease',
            sourceId: `${event.type}:${identity}`,
            sourceSeq: 1,
            occurredAt: new Date(),
            payload: event.lease,
            rawPayload: new TextEncoder().encode(JSON.stringify(event.lease)),
            classification: 'engagement',
            trustLevel: 'tool_observation',
          }]);
        },
      }),
    },
  );

  const pgTools = new PgWorkerTools(readDb, {
    txDb,
    executor: execution,
    ledger,
    ...(config.embedQuery === undefined ? {} : { embedQuery: config.embedQuery }),
    ...(rlsContext === undefined ? {} : {
      rlsContext,
      resolveRlsEngagement: async (workerSessionId: string) => {
        const context = await leaseRlsContextForSession?.(workerSessionId);
        return context?.engagementId ?? null;
      },
    }),
  });
  const workerToolsRaw: WorkerToolDeps = {
    // 「会话即 intake」：把当前会话登记为作业的 intake。
    // 晚绑定 `workflowRef`：工作流服务在本对象之后构造（见下面 `workflowRef` 的说明），
    // 而它必须存在——缺了就只能报错，不能静默让工具消失（工具面对模型是固定清单）。
    bootstrapIntake: async (input) => {
      if (workflowRef === null) throw new Error('工作流服务尚未装配，无法建立 intake');
      return workflowRef.bootstrapIntake({
        dshSessionId: input.dshSessionId,
        operatorId: config.operatorId ?? SYSTEM_OPERATOR_ID,
        ...(input.name === undefined ? {} : { name: input.name }),
      });
    },
    resolveWorkerSessionId: pgTools.resolveWorkerSessionId.bind(pgTools),
    loadSkill: pgTools.loadSkill.bind(pgTools),
    resolveWorkerSessionContext: pgTools.resolveWorkerSessionContext.bind(pgTools),
    search: pgTools.search.bind(pgTools),
    read: pgTools.read.bind(pgTools),
    readArtifact: pgTools.readArtifact.bind(pgTools),
    submitReport: pgTools.submitReport.bind(pgTools),
    writeStatusNote: pgTools.writeStatusNote.bind(pgTools),
    requestScopeConfirmation: pgTools.requestScopeConfirmation.bind(pgTools),
    requestApproval: pgTools.requestApproval.bind(pgTools),
    execute: makeWorkerExecute(execution),
  };

  // 工具路径在**无外层作用域**下运行（agent loop 调用，不经控制台 RPC），
  // 因此这里按会话把作用域补上。见 `scopeWorkerToolsBySession` 的说明。
  const workerTools: WorkerToolDeps = scopeWorkerToolsBySession(
    workerToolsRaw,
    async (workerSessionId, work) => {
      if (leaseRlsContextForSession === undefined) return work();
      const resolved = await leaseRlsContextForSession(workerSessionId);
      if (resolved === null) return work();
      return rlsScopePort.run({ engagementId: resolved.engagementId, workerSessionId }, work);
    },
  );

  // ── 人类工作流服务（§5.4 的状态机写入路径）──
  //
  // `sessions` 是**写**侧端口（创建/驱动 dsh 会话），与上面的 `PgSessionDirectory`
  // （读侧：按会话取绑定信息）是两回事。缺写侧端口时工作流仍可用，只是创建会话
  // 会以明确错误失败——比静默空转好。
  const sessionFactory: SessionFactory = config.sessions ?? missingSessionFactory;
  const reportFace = new PgReportService(readDb, { txDb });
  const memoryFace = new PgMemoryQueryService(readDb, {
    ledger,
    // 账本校验端口（§8.4 链校验 + 锚点核对）：控制台「校验账本完整性」用它。
    ledgerVerifier: ledger,
    ...(config.embedQuery === undefined ? {} : { embedQuery: config.embedQuery }),
  });
  // 诊断面：实例级事实（连接池、审计探针）+ 作业级事实（索引队列、水位）。
  const diagnosticsFace = new PgDiagnosticsService({
    poolStats: () => ({
      totalCount: pool.totalCount,
      idleCount: pool.idleCount,
      waitingCount: pool.waitingCount,
    }),
    audit: auditProbe,
    outbox: { stats: (engagementId) => outbox.stats(engagementId) },
    watermark: (engagementId) => memoryFace.memoryWatermark(engagementId),
  });
  const workflow = new PgWorkflowService({
    db: readDb,
    // 有嵌入端点才有语义通道；没有就如实声明 lexical+trigram（会话提示词里会写清，见 renderRetrievalChannels）。
    retrievalChannels:
      config.embeddings === undefined ? ['lexical', 'trigram'] : ['semantic', 'lexical', 'trigram'],
    txDb,
    sessions: sessionFactory,
    leases,
    approvalPlanValidator,
    ledger,
    ...(config.modelRoute === undefined ? {} : { modelRoute: config.modelRoute }),
    // 提示词里的动作模板目录：从策略服务的注册表取，保持单一来源。
    actionTemplates: () =>
      policy.listActionTemplates().map((spec) => ({
        id: spec.template.id,
        actionClass: spec.template.actionClass,
        parameters: spec.template.parameters.map((p) => ({
          name: p.name,
          carries: spec.carries[p.name] ?? '',
          ...(p.values === undefined ? {} : { values: p.values }),
          ...(p.min === undefined ? {} : { min: p.min }),
          ...(p.max === undefined ? {} : { max: p.max }),
        })),
      })),
    report: reportFace,
    reportSignature: reportFace,
    ...(rlsContext === undefined ? {} : { rlsContext, rlsScope: rlsScopePort }),
    // 预览要显示「动作会拨到哪个地址」，必须与执行期用**同一个**解析钩子。
    ...(config.resolveAddresses === undefined ? {} : { resolveAddresses: config.resolveAddresses }),
    // 策略变更生效的**执行侧**收口（§10.3.1）：事务已提交，这里只做「停掉旧 epoch 的在途动作」。
    // 返回的终止数量必须落审计：只说「epoch 前进了」而不说「停了几个动作」，
    // 事后无法回答那次变更的真实影响。
    onPolicyEpochAdvanced: async ({ engagementId, newPolicyEpoch, cause }) => {
      const aborted = await execution.abortInFlight(engagementId, newPolicyEpoch);
      const payload = {
        engagementId,
        reason: cause === 'scope_amended' ? 'scope_amended' : 'policy_amended',
        policyEpoch: newPolicyEpoch,
        abortedActions: aborted,
        phase: 'in_flight_abort',
      };
      await ledger.appendEvent({
        engagementId,
        workerSessionId: null,
        eventType: 'execution.stopped',
        sourceSystem: 'pentest-execution',
        sourceId: `execution.stopped:${cause}:${String(newPolicyEpoch)}:${crypto.randomUUID()}`,
        sourceSeq: 1,
        occurredAt: new Date(),
        payload,
        rawPayload: new TextEncoder().encode(JSON.stringify(payload)),
        classification: 'engagement',
        trustLevel: 'tool_observation',
      });
      return aborted;
    },
  });
  // 系统暂停的出口（见上面 `workflowRef` 的说明）。
  workflowRef = workflow;

  // ── 控制台 RPC（§6）：人类操作的唯一出口 ──
  //
  // 操作者身份由调用方在 `CallContext` 注入。适配器（HTTP/CLI/Web）负责
  // 从**传输层**取身份，绝不从请求体取——本层会拒绝请求体里的身份键。
  // ── 控制台的四个服务面 ──
  //
  // 分开构造而不是一个大对象：每个面的依赖不同（报告需要 txDb、记忆需要嵌入查询钩子、
  // skill 需要审计归属），混在一起会让「谁依赖什么」变模糊。
  const skillFace = new PgSkillService(
    readDb,
    config.skillAuditEngagementId === undefined
      ? {}   // 降级：不写审计（下方会记警告）
      : { ledger, auditEngagementId: config.skillAuditEngagementId },
  );
  if (config.skillAuditEngagementId === undefined) {
    // 明确告知而不是静默降级：skill 正文是指令文本，改动不留痕是真实的审计缺口。
    console.warn(
      '[dsh-pentest] 未配置 skillAuditEngagementId：skill 增删改**不会写入审计账本**。' +
        '原因见 ComposeConfig.skillAuditEngagementId 的说明（全局库的审计需要归属到某个 engagement）。',
    );
  }

  /**
   * 范围一确认/修订，就把出口白名单**自动**对齐到新范围。
   *
   * 为什么在这里做而不是让人类手工敲 docker：白名单是「已确认范围」的机械投影，
   * 而范围的人类确认就是唯一授权动作（§13.1）。手工同步的实机代价见
   * `egress-allowlist.ts` 头注释：一次忘记同步 = 全部探针 403，而 Agent 会把它读成
   * 「服务未识别」——人类得去翻 RUNBOOK 才知道发生了什么。
   *
   * 失败**不阻断确认**：确认是主行为（写库），同步是基础设施动作（docker）。
   * 同步失败只记日志——但要说清后果（探针会 403），而不是静默。
   */
  function withEgressSyncFor(inner: HumanWorkflowService): HumanWorkflowService {
    const sync = async (targets: readonly EgressScopeTarget[], exclusions: readonly EgressScopeTarget[]): Promise<void> => {
      const required = egressHostsForScope(targets, exclusions);
      // 网段（cidr）在代理上没有表达方式：写进去是**死条目**（永远不匹配）。显式说出来，
      // 别让人类等到「指向网段的探针全部 403」才发现。
      const unrepresentable = unrepresentableEgressEntries(targets);
      if (unrepresentable.length > 0) {
        console.warn(
          `[dsh-pentest] 出口白名单表达不了这些范围条目：${unrepresentable.join(', ')}` +
            '（代理按主机字符串比对，没有网段运算）。指向网段内具体地址的探针会被 403 拒绝；' +
            '需要放行时请把**具体地址**逐条加入范围。',
        );
      }
      if (config.sandbox.proxyHost.trim().length === 0) return;
      const result = await syncEgressAllowlist(
        {
          runner: config.sandboxRunner ?? spawnRunner,
          proxyContainer: config.sandbox.proxyHost,
          internalNetwork: config.sandbox.internalNetwork,
          log: (message) => { console.log(`[dsh-pentest]${message.replace(/^\[egress\]/, ' [egress]')}`); },
        },
        required,
      ).catch((cause: unknown) => ({ ok: false as const, detail: `出口白名单同步异常：${cause instanceof Error ? cause.message : String(cause)}` }));
      if (!result.ok) {
        console.warn(
          `[dsh-pentest] 出口白名单未能自动同步（${result.detail}）。` +
            `后果：指向 ${required.join(',') || '（无）'} 的探针会被代理 403 拒绝。` +
            '按 RUNBOOK §6.5.3 第 1 条手工恢复后再重试。',
        );
      }
    };
    // 包装用 Proxy（保住原型方法与私有字段）——理由与自审抓到的那次错位写在
    // `withEgressSync` 的注释里，并有测试锁住「其余方法仍然可用」。
    return withEgressSync(inner, sync);
  }

  const consoleServices: ConsoleServices = {
    workflow: withEgressSyncFor(workflow),
    report: reportFace,
    memory: memoryFace,
    skills: skillFace,
    diagnostics: diagnosticsFace,
  };
  const consoleRpc = new ConsoleRpc({
    services: consoleServices,
    // 非契约错误（内部故障）的原始细节**必须落到 stdout/stderr**：响应里只有稳定码，
    // 人类看到的那句「原始细节见宿主日志」只有在真的写了日志时才是真的。
    // 此前 `onInternalError` 根本没接线 → 内部错误被静默吞掉，线上只能看到一个
    // 「内部错误」而没有任何线索（人类报障时就是这样）。
    //
    // 不用 `ctx.logger`：cordis 的 logger 默认只写内存环形缓冲、不接 console
    // （同一个坑在客户端 `logWarn` 上已经踩过，见那儿的注释）。
    // 细节可能含敏感信息（这正是它不进响应的原因），因此只进宿主日志。
    onInternalError: (error: unknown, context: { readonly method: string | null }): void => {
      const detail = error instanceof Error ? (error.stack ?? error.message) : String(error);
      console.error(`[dsh-pentest] 控制台内部错误（${context.method ?? 'unknown'}）：${detail}`);
    },
    // 控制台是**人工作业的入口**：每个请求按自己的参数建立 RLS 作用域。
    // 不在这里建立的话，服务内部的查询会落在租户级作用域——`engagements` 行仍可见
    // （`app_tenant_read`），但 `worker_sessions` 等表一行都读不到。
    ...(rlsContext === undefined ? {} : { rls: rlsScopePort }),
    ...(leaseRlsContextForSession === undefined
      ? {}
      : { resolveEngagement: async (workerSessionId: string) => (await leaseRlsContextForSession(workerSessionId))?.engagementId ?? null }),
  });

  // ── 预算与活性（§10.5）──
  //
  // dsh-budget 是唯一 token 事实源；本注册表只绑定 Worker 会话、累计步骤并
  // 在真实 session/event 回调中评估，不复制 token 计数器。
  const dshBudget = config.dshBudget;
  const createBudget = (input: {
    dshSessionId: string;
    limits: BudgetLimits;
    startedAt: Date;
    initialSteps?: number;
    status?: SessionStatus;
  }): BudgetMeter | null =>
    dshBudget === undefined ? null : new BudgetMeter({ dshBudget, ...input });
  const budgetBindings = new Map<string, {
    readonly workerSessionId: string;
    readonly dshSessionId: string;
    meter: BudgetMeter;
    limits: BudgetLimits;
    readonly warningKeys: Set<string>;
    readonly exhaustedKeys: Set<string>;
  }>();
  const budgetChains = new Map<string, Promise<void>>();
  const budgetRunner = transactionRunnerFor(txDb);

/**
 * `observeBudget` 读取的会话行（预算上限与已消费量）。
 *
 * 提成具名类型而不是内联：`readSession` 与两条分流路径共用同一形状，
 * 内联三次会让「加一列」变成三处修改。
 */
interface BudgetSessionRow {
  readonly id: string;
  readonly engagement_id: string;
  readonly status: string;
  readonly budget_max_tokens: number | string | null;
  readonly budget_max_steps: number | string | null;
  readonly budget_max_seconds: number | string | null;
  readonly consumed_tokens: number | string;
  readonly consumed_steps: number | string;
  readonly started_at: Date | string | null;
  readonly created_at: Date | string;
}

function pendingWarningKeys(
  reading: ReturnType<BudgetMeter['evaluate']>,
  seen: ReadonlySet<string>,
): readonly { readonly warning: ReturnType<BudgetMeter['evaluate']>['warnings'][number]; readonly key: string }[] {
  return reading.warnings
    .map((warning) => ({ warning, key: `r${String(reading.revision)}:${warning.dimension}` }))
    .filter(({ key }) => !seen.has(key));
}
  const observeBudget = async (dshSessionId: string, eventType: 'step/start' | 'assistant/message'): Promise<void> => {
    if (dshBudget === undefined) return;
    const previous = budgetChains.get(dshSessionId) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(async () => {
      // 本回调由 `ctx.on('session/event')` 触发，**没有外层 RLS 作用域**。
      //
      // 两种部署形态的取数路径不同，按 `rlsContext` 分流：
      //   - **配置了 RLS**：按 dsh 标识的裸查询在租户级作用域下返回 0 行（行被策略过滤），
      //     于是 `row === undefined` 直接 return —— 预算与活性监视**全程静默空转**。
      //     改用受租户约束的反查函数拿绑定（016），再进作用域读。
      //   - **未配置 RLS**（迁移连接与测试部署，两处交付配置也是这种）：函数体要求
      //     `current_tenant_id()` 非空，恒返回 0 行，套上它反而把**原本可用**的路径弄坏。
      //     此时没有策略要绕过，裸查询正是正确的。
      const boundOnly = rlsContext === undefined
        ? undefined
        : (await readDb.query<{ worker_session_id: string | null; engagement_id: string | null }>(
            `select worker_session_id, engagement_id from pentest.worker_session_binding_by_dsh($1)`,
            [dshSessionId],
          )).rows[0];
      if (boundOnly !== undefined && (boundOnly?.worker_session_id == null || boundOnly.engagement_id == null)) return;
      const readSession = (): Promise<{ rows: readonly BudgetSessionRow[] }> => readDb.query<BudgetSessionRow>(
        `select id, engagement_id, status, budget_max_tokens, budget_max_steps, budget_max_seconds,
                consumed_tokens, consumed_steps, started_at, created_at
           from pentest.worker_sessions
          where dsh_session_id = $1`,
        [dshSessionId],
      );
      const sessionResult = boundOnly === undefined
        ? await readSession()
        : await rlsScopePort.run(
            { engagementId: boundOnly.engagement_id!, workerSessionId: boundOnly.worker_session_id! },
            readSession,
          );
      const row = sessionResult.rows[0];
      if (row === undefined) return;
      const limits: BudgetLimits = {
        maxTokens: Number(row.budget_max_tokens ?? DEFAULTS.budgetMaxTokens),
        maxSteps: Number(row.budget_max_steps ?? DEFAULTS.budgetMaxSteps),
        maxSeconds: Number(row.budget_max_seconds ?? DEFAULTS.budgetMaxSeconds),
      };
      for (const [name, value] of Object.entries(limits)) {
        if (!Number.isSafeInteger(value) || value < 0) {
          throw new Error(`worker_sessions.${name} 预算上限非法：${String(value)}`);
        }
      }
      const committedSteps = Number(row.consumed_steps);
      if (!Number.isSafeInteger(committedSteps) || committedSteps < 0) {
        throw new Error(`worker_sessions.consumed_steps 非法：${String(row.consumed_steps)}`);
      }
      const startedRaw = row.started_at ?? row.created_at;
      const startedAt = startedRaw instanceof Date ? new Date(startedRaw) : new Date(startedRaw);
      if (Number.isNaN(startedAt.getTime())) throw new Error(`Worker 会话起始时间非法：${dshSessionId}`);

      let binding = budgetBindings.get(row.id);
      if (binding === undefined) {
        const meter = createBudget({ dshSessionId, limits, startedAt, initialSteps: committedSteps, status: row.status as SessionStatus });
        if (meter === null) return;
        // **去重标记必须跨进程重启存活。** 事实来源是账本里已经写过的那两条自动事件——
        // `source_id` 里带的正是去重键（`budget.warning:{会话}:{键}`）。否则 harness 一重启，
        // 同一个耗尽的预算会**再暂停一次**，人类看到的是「我明明点了恢复，它又自己停了」
        // （2026-10-05 实测报障：断网几小时后收到 engagement_halted）。
        const priorKeysOf = async (eventType: 'budget.exhausted' | 'budget.warning'): Promise<readonly string[]> => {
          const prefix = `${eventType}:${row.id}:`;
          const read = (): Promise<{ rows: readonly { source_id: string }[] }> => readDb.query<{ source_id: string }>(
            `select source_id from pentest.context_events
              where engagement_id = $1::uuid and event_type = $2 and source_id like $3`,
            [row.engagement_id, eventType, `${prefix}%`],
          );
          // 与上面 `readSession` 同一条分流：配了 RLS 就必须在作用域里读，否则策略把行滤空。
          const result = rlsContext === undefined
            ? await read()
            : await rlsScopePort.run({ engagementId: row.engagement_id, workerSessionId: row.id }, read);
          return result.rows.map((event) => event.source_id.slice(prefix.length));
        };
        binding = {
          workerSessionId: row.id,
          dshSessionId,
          meter,
          limits,
          warningKeys: new Set(await priorKeysOf('budget.warning')),
          exhaustedKeys: new Set(await priorKeysOf('budget.exhausted')),
        };
        budgetBindings.set(row.id, binding);
      }

      const candidate = binding.meter.fork();
      candidate.synchronizeCommittedLimits(limits, new Date());
      candidate.setStatus(row.status as SessionStatus, new Date());
      if (eventType === 'step/start') candidate.noteStep();
      const reading = candidate.evaluate(new Date(), {
        consumedTokens: Number(row.consumed_tokens),
        consumedSteps: committedSteps,
      });
      const warningKeys = pendingWarningKeys(reading, binding.warningKeys);
      const exhaustedKey = reading.pauseRequest === null ? null : `r${String(reading.revision)}:${reading.pauseRequest.dimensions.join(',')}`;
      const pendingExhausted = exhaustedKey !== null && !binding.exhaustedKeys.has(exhaustedKey);
      const engagementId = row.engagement_id;
      const events: AppendEventInput[] = warningKeys.map(({ warning, key }) => ({
        engagementId,
        workerSessionId: row.id,
        eventType: 'budget.warning',
        sourceSystem: 'pentest-budget',
        sourceId: `budget.warning:${row.id}:${key}`,
        sourceSeq: 1,
        occurredAt: reading.at,
        payload: { ...warning, revision: reading.revision, tokenSeq: reading.tokenSeq },
        rawPayload: new TextEncoder().encode(JSON.stringify(warning)),
        classification: 'engagement',
        trustLevel: 'tool_observation',
      }));
      if (pendingExhausted && reading.pauseRequest !== null) {
        events.push({
          engagementId,
          workerSessionId: row.id,
          eventType: 'budget.exhausted',
          sourceSystem: 'pentest-budget',
          sourceId: `budget.exhausted:${row.id}:${exhaustedKey}`,
          sourceSeq: 1,
          occurredAt: reading.at,
          payload: { ...reading.pauseRequest, revision: reading.revision, tokenSeq: reading.tokenSeq },
          rawPayload: new TextEncoder().encode(JSON.stringify(reading.pauseRequest)),
          classification: 'engagement',
          trustLevel: 'tool_observation',
        });
      }

      await budgetRunner.run(async (tx) => {
        const state = await tx.query<{ status: string; state_version: number | string }>(
          `select status, state_version from pentest.engagements where id = $1::uuid for update`,
          [engagementId],
        );
        const stateRow = state.rows[0];
        if (stateRow === undefined) throw new Error(`预算会话的 engagement 不存在：${engagementId}`);
        if (events.length > 0) await ledger.appendBatchInTransaction(tx, events);
        if (reading.pauseRequest !== null && pendingExhausted && stateRow.status === 'running') {
          if (workflowRef === null) throw new Error('系统暂停工作流尚未装配');
          await workflowRef.pauseForSystem({ engagementId, expectedStateVersion: Number(stateRow.state_version), cause: 'budget_exhausted', detail: reading.pauseRequest.message });
        }
        const projected = projectionOf(reading);
        await tx.query(
          `update pentest.worker_sessions set consumed_tokens = $2, consumed_steps = $3 where id = $1::uuid`,
          [row.id, projected.consumedTokens, projected.consumedSteps],
        );
      });

      binding.meter = candidate;
      binding.limits = limits;
      for (const { key } of warningKeys) binding.warningKeys.add(key);
      if (exhaustedKey !== null && pendingExhausted) binding.exhaustedKeys.add(exhaustedKey);
    });
    budgetChains.set(dshSessionId, current);
    try {
      await current;
    } finally {
      if (budgetChains.get(dshSessionId) === current) budgetChains.delete(dshSessionId);
    }
  };
  const budgetLifecycle = { observe: observeBudget };
  const dispatcher = new IndexDispatcher({
    outbox,
    indexer,
    db: readDb,
    ...(backgroundScopes === undefined ? {} : { rlsScope: backgroundScopes }),
  });
  const scheduler = new IndexScheduler({ dispatcher, outbox }, config.scheduler ?? {});
  const notifyConfig = config.notify === false ? null : (config.notify ?? {});
  const recovery = new StartupRecovery({
    db: readDb,
    txDb,
    leases,
    ledger,
    // 对账扫的是 `worker_sessions` / `session_leases`，两张表都没有租户级放行。
    // 不给作用域时它零行通过——那是「没看」，而不是「没有残留」。
    ...(backgroundScopes === undefined ? {} : { rlsScope: backgroundScopes }),
  });
  const createLiveness = (startedAt: Date): LivenessMonitor => new LivenessMonitor({ startedAt });

  // ── 对账（§15.2）──
  //
  // `probeDshSession` 省略时保守判为不可达：宁可让人类复核一个其实还活着的
  // 会话，也不要假装它活着继续在其上执行动作。
  const probe = config.probeDshSession ?? (async () => false);
  const reconcile = {
    collect: (engagementId: string): Promise<readonly SessionReconciliationInput[]> =>
      collectReconciliationInputs(readDb, engagementId, probe, new Date()),
    evaluate: (
      engagementId: string,
      sessions: readonly SessionReconciliationInput[],
    ): EngagementReconciliation => reconcileEngagement(engagementId, sessions),
  };

  // ── 租约心跳（§10.6）──
  const heartbeat = new LeaseHeartbeat(
    {
      db: readDb,
      leases,
      ...(backgroundScopes === undefined ? {} : { rlsScope: backgroundScopes }),
    },
    config.heartbeat ?? {},
  );

  const notify = notifyConfig === null || notifyConfig.enabled === false
    ? null
    : new NotifyListener({
        target: { wakeNow: () => { scheduler.wakeNow(); } },
        connect: () => createPgNotifyConnection(config.database.url),
        ...(notifyConfig.channel === undefined ? {} : { channel: notifyConfig.channel }),
      });

  return {
    hostServices: { workerTools, consoleRpc },
    rls: rlsScopePort,
    execution,
    ledger,
    leases,
    policy,
    workflow,
    report: reportFace,
    memoryQuery: memoryFace,
    skills: skillFace,
    diagnostics: diagnosticsFace,
    createBudget,
    budgetLifecycle,
    createLiveness,
    reconcile,
    outbox,
    indexer,
    dispatcher,
    scheduler,
    heartbeat,
    notify,
    recovery,
    dispose: async () => {
      // 先停后台循环再释放连接：在途 tick 可能正在写 memory_chunks、水位或续租，
      // 直接关池会让那些写入以难以解释的方式失败。
      // 通知监听先停：它会自己关掉那条独立连接。
      await notify?.stop().catch(() => undefined);
      await heartbeat.stop().catch(() => undefined);
      await scheduler.stop().catch(() => undefined);
      await txPort.dispose();
      await pool.end();
    },
  };
}
