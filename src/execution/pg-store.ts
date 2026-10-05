/**
 * `ExecutionStore` 的 PostgreSQL 装配（设计文档 §10.3、§10.3.1、§9.2、§9.5）。
 *
 * 三条纪律：
 *
 * 1. **凭证消费 + 运行登记必须在同一事务内完成**（§10.3.1）。`commitRun` 不自行
 *    `BEGIN`/`COMMIT`，而是把两步压进**一条语句**（4 个 CTE）：单条语句本身就是一个隐式
 *    事务，原子性来自语句而非连接亲和性，因此 `DbClient` 由连接池适配时也不会出现
 *    「BEGIN 与 COMMIT 落在不同连接」的静默错误。凭证行用 `for update` 锁定，
 *    同一凭证/同一幂等键的并发提交被行锁串行化；运行登记的 `ON CONFLICT DO NOTHING`
 *    与凭证消费互相以 `exists (select 1 from ...)` 互锁，两侧要么都落地，要么都不落地。
 * 2. **一次性消费只看条件 UPDATE 的 `rowCount`**，不先 SELECT 再 UPDATE（那会留竞态窗口）。
 *    消费同时校验 `consumed_at is null`、`decision = 'approved'` 与未过期。
 * 3. **结算一次性写入**：002 的 `tool_runs_state_progression` 把
 *    `finished_at / exit_code / stdout_zstd / stderr_zstd / result_json / artifact_ids`
 *    定义为「一次性列 ∩ 结算列」——只能在**进入 completed / failed / unknown 的同一次
 *    UPDATE** 里写。因此 `finishRun` 是一条 UPDATE 写完全部结算列，绝不拆成两次。
 *
 * 关于 `stdout_zstd` / `stderr_zstd`：本层把 `ToolRunResult.stdout` 的 UTF-8 字节**原样**
 * 写入该列，不压缩（与 `memory/ledger.ts` 对 `raw_payload_zstd` 的约定一致），完整结果同时
 * 落在 `result_json`，重放返回的就是它。
 *
 * 关于审计字段：`tool_runs` 的 `tool_name` / `action_class` / `target_selector` /
 * `normalized_command` / `arguments_json` / `policy_decision` 都是 NOT NULL，取值全部来自
 * `CommitRunInput`（调用点持有 plan，因此不额外查询）。`action_class` 落的是真实类别——
 * 它是审计里「这是什么动作」的唯一依据，绝不用哨兵值占位。
 * `policy_decision` 额外保存 `plan_hash`：幂等重放要靠它比对
 * （`service.ts` 据 `record.planHash` 判定是否复用他人结果）。
 *
 * 关于 uuid 列：`worker_sessions.id` / `tool_runs.id` / `approvals.id` 都是 `uuid`，而
 * `ExecutionServiceDeps.newId` 的默认实现产出 `run-<uuid>`，直接入库会被类型拒绝。本层先做
 * 形状校验并抛出可读错误（装配时必须注入 `newId: () => randomUUID()`），而不是把裸的
 * `invalid input syntax` 抛给上层。
 */

import { randomBytes } from 'node:crypto';
import type { ActionClass, ApprovalDecision, ApprovalRecord, ToolRunResult } from '../contracts.ts';
import type { DbClient } from '../memory/ledger.ts';
import type {
  ApprovalRequest,
  CommitRunInput,
  CommitRunResult,
  ExecutionStore,
  ToolRunRecord,
} from './service.ts';

// ───────────────────────────── 常量 ─────────────────────────────

/**
 * `ToolRunResult.status` → `tool_runs.status`（§9.5 只有 completed / failed / unknown 三个终态）。
 * 超时与取消都是「我方中断在途动作」：进程树被杀，目标侧的实际影响未知，按 §9.5
 * 「执行中被打断时结果未知，必须记 unknown 并人工核查」处理；`runtime_error` / `blocked`
 * 是沙箱给出的确定失败结论，不会自动重试（结算即冻结，重放只返回原结果）。
 */
const RUN_STATUS_BY_RESULT: Readonly<Record<ToolRunResult['status'], 'completed' | 'failed' | 'unknown'>> =
  Object.freeze({
    completed: 'completed',
    runtime_error: 'failed',
    blocked: 'failed',
    timed_out: 'unknown',
    cancelled: 'unknown',
  });

/** `ToolRunResult.status` 的取值域：把 `result_json` 的判别字段钉在契约白名单内。 */
const TOOL_RESULT_STATUSES: Readonly<Record<ToolRunResult['status'], true>> = Object.freeze({
  completed: true,
  timed_out: true,
  cancelled: true,
  runtime_error: true,
  blocked: true,
});

function isToolResultStatus(value: unknown): value is ToolRunResult['status'] {
  return typeof value === 'string' && Object.hasOwn(TOOL_RESULT_STATUSES, value);
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ───────────────────────────── SQL（§9.2 表、§9.5 触发器约束） ─────────────────────────────

const SQL_FIND_SESSION = `
select s.id, s.engagement_id
  from pentest.worker_sessions s
 where s.id = $1::uuid`;

/**
 * 幂等重放的唯一入口。语义（见 `ExecutionStore.findRunByIdempotencyKey` 注释）：
 * **凡已回写过结果的运行都参与重放，含被拒绝与失败的**；未结算的不参与。
 * 「已结算」在 001 的列上等价于「status 已在终态集合 ∧ result_json 已写入」——
 * 002 保证 result_json 只能随进入终态同一次写入落地，两者互为见证。
 */
const SQL_FIND_RUN_BY_IDEMPOTENCY_KEY = `
select r.id,
       r.idempotency_key,
       coalesce(r.policy_decision ->> 'plan_hash', '') as plan_hash,
       r.result_json
  from pentest.tool_runs r
 where r.idempotency_key = $1
   and r.status in ('completed', 'failed', 'unknown')
   and r.result_json is not null
 order by r.finished_at desc nulls last
 limit 1`;

/** 任意状态的运行（含在途）：用于区分「运行已登记」与「凭证不可消费」。 */
const SQL_FIND_RUN_ANY_STATE = `
select r.id
  from pentest.tool_runs r
 where r.engagement_id = $1::uuid
   and r.idempotency_key = $2
 limit 1`;

/** 放行申请（§10.3.1）：写入人类将要看到并批准的**完整执行内容**。 */
const SQL_INSERT_APPROVAL = `
insert into pentest.approvals (
  engagement_id, requested_by_worker, action_class, target_snapshot, command_plan,
  plan_hash, risk_summary, decision, lease_generation, expires_at
) values (
  $1::uuid, $2::uuid, $3, $4::jsonb, $5::jsonb, $6, $7, 'pending', $8::integer, $9
)
returning id`;

/**
 * 自放行凭证（高权限模式）：**先以 pending 插入，再走官方的决议函数**。
 *
 * 为什么不能直接插 `approved`（2026-10-05 实测踩到并修）：`010_approval_privilege_binding`
 * 的 `approvals_insert_guard` 触发器规定「运行时只能创建未处理的申请」——直接插 `approved`
 * 会被 `restrict_violation` 拒掉（人类看到的报错是「审批只能以 pending 且无决策/消费见证创建：<id>」，
 * Agent 因此把它当成"已有一条待处理申请"，白跑一轮）。决议只能经 `pentest.resolve_approval`
 * （SECURITY DEFINER + 租户作用域）落——**人类路径也是这么做的**，自放行与它共用同一条路径，
 * 区别只在 `decided_by`（`server:auto-approval` vs 操作者 id）。
 *
 * 用 CTE 把「插入 + 决议」压进**一条语句**：单条语句本身就是一个隐式事务，
 * 不会出现「插入了 pending 但决议失败」的半成品（本文件开头的同一条纪律）。
 */
const SQL_INSERT_SELF_APPROVAL = `
with inserted as (
  insert into pentest.approvals (
    engagement_id, requested_by_worker, action_class, target_snapshot, command_plan,
    plan_hash, risk_summary, decision, lease_generation, expires_at
  ) values (
    $1::uuid, $2::uuid, $3, $4::jsonb, $5::jsonb, $6, $7, 'pending', $8::integer, $9
  )
  returning id
)
select inserted.id as id
  from inserted
 cross join lateral (select pentest.resolve_approval(inserted.id, 'approved', $10, $11)) as resolved`;

const SQL_GET_APPROVAL = `
select a.id, a.requested_by_worker, a.action_class, a.plan_hash,
       a.lease_generation, a.decision, a.expires_at, a.consumed_at
  from pentest.approvals a
 where a.id = $1::uuid`;
/**
 * 一次性消费（§10.3.1）：条件 UPDATE 的 `rowCount` 就是判定结果。
 * 不满足（不存在 / 已消费 / 未放行 / 已过期 / 与工具运行不属于同一 session 或 engagement）
 * 时影响 0 行——没有先读后写的窗口，也不能把一个会话的凭证交给另一个会话的运行消费。
 */
const SQL_CONSUME_APPROVAL = `
update pentest.approvals a
   set consumed_at = now(),
       consumed_by_tool_run = $2::uuid
  from pentest.tool_runs r
 where a.id = $1::uuid
   and r.id = $2::uuid
   and a.engagement_id = r.engagement_id
   and a.requested_by_worker = r.worker_session_id
   and a.consumed_at is null
   and a.decision = 'approved'
   and (a.expires_at is null or a.expires_at > now())`;

/**
 * 原子提交（§10.3.1）：**一条语句**完成凭证消费 + 运行登记。
 *
 * CTE 依赖是有向的，PostgreSQL 按需求值，因此顺序可证：
 *   `approval_row`（锁定并判定凭证可消费）→ `inserted`（以 approved 行存在为前提登记运行）
 *   → `consumed`（以运行已登记为前提消费凭证）。
 * 两侧互锁的结果：运行未登记则凭证不被消费，凭证不可消费则运行不登记；任一侧不成立时
 * 外层 select 返回 null，调用方走只读诊断，**不留半完成状态**（没有需要回滚的残行）。
 * FK 也在语句末尾校验，此时两侧的行都已存在，故不会中途违约。
 */
const SQL_COMMIT_RUN = `
with session_row as (
    select s.id, s.engagement_id
      from pentest.worker_sessions s
      join pentest.engagements e on e.id = s.engagement_id
     where s.id = $2::uuid
       and s.status in ('active', 'waiting_human', 'handoff_drafting', 'transition_confirmation', 'paused', 'blocked')
       and e.status = 'running'
       -- 版本条件与登记同语句原子判定：admit 复核通过之后、本语句提交之前
       -- 版本前进时，登记必须失败（否则在途动作会带着旧版本接触目标，事故 2026-10-05）。
       and e.policy_epoch = $13::bigint
       and s.scope_version = $14::integer
     for update of s, e
),
lease_row as (
    select l.worker_session_id
      from pentest.session_leases l
      join session_row sr on sr.id = l.worker_session_id
     where l.generation = $12::integer
       and l.revoked_at is null
       and l.expires_at > now()
     for update
),
approval_row as (
    select a.id
      from pentest.approvals a
      join session_row sr on sr.id = a.requested_by_worker
                         and sr.engagement_id = a.engagement_id
     where a.id = $4::uuid
       and a.consumed_at is null
       and a.decision = 'approved'
       and (a.expires_at is null or a.expires_at > now())
       and a.action_class = $6
       and a.plan_hash = $11::text
       and a.lease_generation = $12::integer
     for update
),
inserted as (
    insert into pentest.tool_runs (
        id, engagement_id, worker_session_id, idempotency_key, tool_name, action_class,
        target_selector, normalized_command, arguments_json, approval_id, policy_decision,
        status, started_at
    )
    select $1::uuid, sr.engagement_id, sr.id, $3, $5, $6, $7::jsonb, $8::jsonb,
           $9::jsonb, $4::uuid, $10::jsonb, 'running', now()
      from session_row sr
     where exists (select 1 from lease_row)
       and ($4::uuid is null or exists (select 1 from approval_row))
    on conflict (engagement_id, idempotency_key) do nothing
    returning id
),
consumed as (
    update pentest.approvals a
       set consumed_at = now(),
           consumed_by_tool_run = (select i.id from inserted i)
     where a.id = $4::uuid
       and exists (select 1 from inserted)
    returning a.id
)
select (select i.id from inserted i) as run_id,
       (select c.id from consumed c) as consumed_id`;

/**
 * 结算回写：状态与**全部结算列**在同一条 UPDATE 里落地（002 `tool_runs_state_progression`
 * 的「一次性列 ∩ 结算列」约束）。`started_at` 是生命周期列，不在此列——它在认领执行时
 * （`commitRun`）已写入。
 */
const SQL_FINISH_RUN = `
update pentest.tool_runs r
   set status = $2,
       finished_at = now(),
       exit_code = $3,
       stdout_zstd = $4,
       stderr_zstd = $5,
       result_json = $6::jsonb,
       artifact_ids = $7::uuid[]
 where r.id = $1::uuid`;

// ───────────────────────────── 行形状与转换 ─────────────────────────────

interface RunReplayRow {
  readonly id: string;
  readonly idempotency_key: string;
  readonly plan_hash: string;
  readonly result_json: unknown;
}

interface ApprovalRow {
  readonly id: string;
  readonly requested_by_worker: string | null;
  readonly action_class: string;
  readonly plan_hash: string;
  readonly lease_generation: number | string | null;
  readonly decision: string;
  readonly expires_at: Date | string | null;
  readonly consumed_at: Date | string | null;
}

interface RunIdRow {
  readonly id: string;
}

interface SessionIdRow {
  readonly id: string;
  readonly engagement_id: string;
}

interface CommitRow {
  readonly run_id: string | null;
  readonly consumed_id: string | null;
}

/** uuid 形状校验：`tool_runs.id` / `approvals.id` / `worker_sessions.id` 都是 uuid 列。 */
function requireUuid(value: string, field: string): string {
  if (!UUID_PATTERN.test(value)) {
    throw new Error(
      `${field} 必须是 uuid（tool_runs.id / approvals.id / worker_sessions.id 都是 uuid 列）：收到 ${JSON.stringify(value)}。` +
        '装配 ExecutionService 时必须注入 newId: () => randomUUID()——默认的 `run-<uuid>` 形式无法入库。',
    );
  }
  return value;
}

/** 记录型 JSON 值（`jsonb` 往返后是普通对象）。 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * `result_json` → `ToolRunResult`。该列只由 `finishRun` 从 `ToolRunResult` 序列化写入，
 * 因此除判别字段外按忠实往返处理；`status` 单独校验，避免把不可识别的值当成结果返回。
 */
function toToolRunResult(value: unknown): ToolRunResult {
  if (!isRecord(value) || !isToolResultStatus(value['status'])) {
    throw new Error('tool_runs.result_json 缺少合法的 status：无法作为工具运行结果重放');
  }
  // 判别字段已按契约取值域校验；其余字段是本模块在 finishRun 里对 ToolRunResult 的忠实
  // 序列化往返，形状由写入方保证，契约没有可用的运行时校验器。断言取一个命名常量，
  // 避免内联断言被误读为「在这里刚验证过」。
  const roundTripped = value as unknown as ToolRunResult;
  return roundTripped;
}

// ───────────────────────────── 实现 ─────────────────────────────

/** `ExecutionStore` 的 PostgreSQL 实现；依赖仅 `{ query(sql, params) }`。 */
export class PgExecutionStore implements ExecutionStore {
  readonly #db: DbClient;

  constructor(db: DbClient) {
    this.#db = db;
  }

  async findRunByIdempotencyKey(idempotencyKey: string): Promise<ToolRunRecord | undefined> {
    const found = await this.#db.query<RunReplayRow>(SQL_FIND_RUN_BY_IDEMPOTENCY_KEY, [idempotencyKey]);
    const row = found.rows[0];
    if (row === undefined) return undefined;
    return {
      toolRunId: row.id,
      idempotencyKey: row.idempotency_key,
      planHash: row.plan_hash,
      result: toToolRunResult(row.result_json),
    };
  }

  async requestApproval(input: ApprovalRequest): Promise<{ readonly approvalId: string }> {
    const session = await this.#db.query<SessionIdRow>(SQL_FIND_SESSION, [input.workerSessionId]);
    const engagementId = session.rows[0]?.engagement_id;
    if (engagementId === undefined) {
      throw new Error(
        `requestApproval：worker_sessions 中不存在会话 ${input.workerSessionId}，无法确定 engagement`,
      );
    }
    // command_plan 保存服务端模板实例的参数、原始选择器与规范化执行快照；不接受自由命令文本作为修改入口。
    const commandPlan = {
      template_id: input.templateId ?? null,
      target_selector: input.targetSelector,
      params: input.params ?? null,
      normalized_target: input.normalizedTarget,
      normalized_command: input.normalizedCommand,
      // 展示形态：放行卡与审计读它，执行读 normalized_command。两者都存，白纸黑字可对照。
      display_command: input.displayCommand ?? input.normalizedCommand,
      scope_version: input.scopeVersion,
      policy_epoch: input.policyEpoch,
      lease_generation: input.leaseGeneration,
      timeout_ms: input.timeoutMs,
      max_output_bytes: input.maxOutputBytes,
      purpose: input.purpose,
    };
    const selfApproval = input.selfApproval;
    // 人类读的一行：类别 + 目的 + **为什么被拦**（哪条规则把他叫来了）。
    const riskSummary =
      `${input.actionClass}：${input.purpose}` +
      (input.approvalReason === undefined ? '' : `（${input.approvalReason}）`);
    const created = await this.#db.query<RunIdRow>(
      selfApproval === undefined ? SQL_INSERT_APPROVAL : SQL_INSERT_SELF_APPROVAL,
      selfApproval === undefined
        ? [
            engagementId,
            input.workerSessionId,
            input.actionClass,
            JSON.stringify({ normalized_target: input.normalizedTarget }),
            JSON.stringify(commandPlan),
            input.planHash,
            riskSummary,
            input.leaseGeneration,
            input.expiresAt,
          ]
        : [
            engagementId,
            input.workerSessionId,
            input.actionClass,
            JSON.stringify({ normalized_target: input.normalizedTarget }),
            JSON.stringify(commandPlan),
            input.planHash,
            riskSummary,
            // $8 是 `lease_generation::integer`——顺序必须与 SQL 一致（写错过一次：
            // decidedBy 落到 integer 列上，报 22P02）。
            input.leaseGeneration,
            input.expiresAt,
            selfApproval.decidedBy,
            selfApproval.reason,
          ],
    );
    const approvalId = created.rows[0]?.id;
    if (approvalId === undefined) throw new Error('requestApproval：approvals 插入未返回 id');
    return { approvalId };
  }

  async getApproval(approvalId: string): Promise<ApprovalRecord | undefined> {
    const found = await this.#db.query<ApprovalRow>(SQL_GET_APPROVAL, [requireUuid(approvalId, 'getApproval.approvalId')]);
    const row = found.rows[0];
    if (row === undefined) return undefined;
    return {
      id: row.id,
      // requested_by_worker 可空：未绑定会话的行映射为空串，服务侧的「放行不跨会话」比对
      // 必然不相等，因而被拒绝（fail-closed）。
      workerSessionId: row.requested_by_worker ?? '',
      actionClass: row.action_class as ActionClass,
      planHash: row.plan_hash,
      leaseGeneration: row.lease_generation === null ? null : Number(row.lease_generation),
      decision: row.decision as ApprovalDecision,
      expiresAt: row.expires_at === null ? new Date(0) : new Date(row.expires_at),
      consumedAt: row.consumed_at === null ? null : new Date(row.consumed_at),
    };
  }

  async consumeApproval(approvalId: string, toolRunId: string): Promise<boolean> {
    const consumed = await this.#db.query(SQL_CONSUME_APPROVAL, [
      requireUuid(approvalId, 'consumeApproval.approvalId'),
      // consumed_by_tool_run 有外键指向 tool_runs(id)：传入的必须是已登记的运行。
      requireUuid(toolRunId, 'consumeApproval.toolRunId'),
    ]);
    return consumed.rowCount === 1;
  }

  async commitRun(input: CommitRunInput): Promise<CommitRunResult> {
    requireUuid(input.toolRunId, 'commitRun.toolRunId');
    requireUuid(input.workerSessionId, 'commitRun.workerSessionId');
    if (input.approvalId !== null) requireUuid(input.approvalId, 'commitRun.approvalId');

    const committed = await this.#db.query<CommitRow>(SQL_COMMIT_RUN, [
      input.toolRunId,
      input.workerSessionId,
      input.idempotencyKey,
      input.approvalId,
      input.toolName,
      input.actionClass,
      JSON.stringify({ target: input.normalizedTarget, template: input.templateId }),
      JSON.stringify({ text: input.normalizedCommand }),
      JSON.stringify({
        template_id: input.templateId,
        normalized_target: input.normalizedTarget,
        normalized_command: input.normalizedCommand,
      }),
      JSON.stringify({
        plan_hash: input.planHash,
        scope_version: input.scopeVersion,
        policy_epoch: input.policyEpoch,
        approval_required: input.approvalRequired,
      }),
      input.planHash,
      input.leaseGeneration,
      input.policyEpoch,
      input.scopeVersion,
    ]);
    const row = committed.rows[0];
    if (row !== undefined && row.run_id !== null) {
      if (input.approvalId !== null && row.consumed_id === null) {
        // 两个 CTE 的互锁保证不会走到这里；真走到了说明原子性假设被破坏，必须响亮失败。
        throw new Error('commitRun：运行已登记但凭证未消费——单语句原子性被破坏');
      }
      // 一次性执行令牌：CSPRNG 直接产出，不经任何可推导的变换；只交付给沙箱进程。
      // 令牌不落库（001 没有该列）：沙箱与代理持它才可发起连接，代理在连接时刻复核 policy epoch。
      return { ok: true, executionToken: randomBytes(32).toString('base64url') };
    }

    // 状态未落地：以下全部是只读诊断，不写任何东西（因此仍无半完成状态）。
    const session = await this.#db.query<SessionIdRow>(SQL_FIND_SESSION, [input.workerSessionId]);
    const engagementId = session.rows[0]?.engagement_id;
    if (engagementId === undefined) {
      throw new Error(
        `commitRun：worker_sessions 中不存在会话 ${input.workerSessionId}，拒绝登记运行`,
      );
    }
    const engagement = await this.#db.query<{ status: string }>(
      `select status from pentest.engagements where id = $1::uuid`,
      [engagementId],
    );
    if (engagement.rows[0]?.status !== 'running') {
      return { ok: false, reason: 'engagement_halted' };
    }
    const sessionState = await this.#db.query<{ status: string }>(
      `select status from pentest.worker_sessions where id = $1::uuid`,
      [input.workerSessionId],
    );
    const liveStatuses = ['active', 'waiting_human', 'handoff_drafting', 'transition_confirmation', 'paused', 'blocked'];
    if (!liveStatuses.includes(sessionState.rows[0]?.status ?? '')) {
      return { ok: false, reason: 'lease_revoked' };
    }
    const lease = await this.#db.query<{
      generation: number | string;
      expires_at: Date | string;
      revoked_at: Date | string | null;
    }>(
      `select generation, expires_at, revoked_at
         from pentest.session_leases
        where worker_session_id = $1::uuid
        order by generation desc limit 1`,
      [input.workerSessionId],
    );
    const leaseRow = lease.rows[0];
    if (leaseRow === undefined) return { ok: false, reason: 'lease_required' };
    if (Number(leaseRow.generation) !== input.leaseGeneration) {
      return { ok: false, reason: 'lease_generation_stale' };
    }
    if (leaseRow.revoked_at !== null) return { ok: false, reason: 'lease_revoked' };
    if (new Date(leaseRow.expires_at).getTime() <= Date.now()) return { ok: false, reason: 'lease_expired' };

    const existing = await this.#db.query<RunIdRow>(SQL_FIND_RUN_ANY_STATE, [
      engagementId,
      input.idempotencyKey,
    ]);
    // 与假实现同序：运行已登记优先于凭证判定（service.ts 也先做幂等重放再提交）。
    if (existing.rows.length > 0) return { ok: false, reason: 'idempotent_replay' };

    // 版本诊断：SQL_COMMIT_RUN 的 session_row 已把 policy_epoch / scope_version 并进原子条件。
    // 走到这里说明版本已前进（或凭证另有问题）——版本不匹配时原样回报，
    // 不要把它误报成「凭证不可用」（事故 2026-10-05）。
    const freshness = await this.#db.query<{ policy_epoch: string | number; scope_version: string | number }>(
      `select e.policy_epoch, s.scope_version
         from pentest.worker_sessions s
         join pentest.engagements e on e.id = s.engagement_id
        where s.id = $1::uuid`,
      [input.workerSessionId],
    );
    const current = freshness.rows[0];
    if (
      current !== undefined &&
      (Number(current.policy_epoch) !== input.policyEpoch || Number(current.scope_version) !== input.scopeVersion)
    ) {
      return { ok: false, reason: 'stale_state_version' };
    }

    if (input.approvalId !== null) {
      const approval = await this.#db.query<RunIdRow>(SQL_GET_APPROVAL, [input.approvalId]);
      if (approval.rows[0] === undefined) return { ok: false, reason: 'approval_not_found' };
      // 凭证存在但不可消费：已消费 / 未放行 / 已拒绝 / 已撤销 / 已取代 / 已过期。
      // 契约的拒绝原因是封闭集合，这些形态统一归入 approval_consumed（凭证不可再用，须重新申请）。
      return { ok: false, reason: 'approval_consumed' };
    }
    throw new Error(
      `commitRun：运行 ${input.toolRunId} 既未登记也无凭证可消费（不应发生，请检查会话与幂等键）`,
    );
  }

  async finishRun(toolRunId: string, result: ToolRunResult): Promise<void> {
    const runId = requireUuid(toolRunId, 'finishRun.toolRunId');
    const written = await this.#db.query(SQL_FINISH_RUN, [
      runId,
      RUN_STATUS_BY_RESULT[result.status],
      result.exitCode ?? null,
      result.stdout === undefined ? null : Buffer.from(result.stdout, 'utf8'),
      result.stderr === undefined ? null : Buffer.from(result.stderr, 'utf8'),
      JSON.stringify(result),
      result.artifactIds ?? [],
    ]);
    if (written.rowCount !== 1) {
      throw new Error(`finishRun：tool_runs 中不存在运行 ${runId}，拒绝静默丢弃结果`);
    }
  }
}
