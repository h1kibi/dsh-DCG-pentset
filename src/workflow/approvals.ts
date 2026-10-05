/**
 * 放行队列与放行决策（§10.3.1）
 *
 * 从 `pg-workflow.ts` 机械搬运（拆分目标：组合器只做装配与委托，流程各自成类）。
 * 方法体与拆分前逐字一致；共享原语经构造注入的 {@link WorkflowCore} 使用。
 */

import type { ActionClass, ApprovalDecision, ApprovalDetail, ApprovalRecord, HumanApprovalDecision, HumanApprovalRevocation, ListApprovalsInput } from '../contracts.ts';
import { asRecord, readNumber, readString, toInt } from './model.ts';
import type { WorkflowCore } from './core.ts';

export class ApprovalFlow {
  readonly #core: WorkflowCore;

  constructor(core: WorkflowCore) {
    this.#core = core;
  }

  /**
   * 列出放行记录（放行队列的数据源，§10.3.1）。
   *
   * **必须读出完整执行内容**：`command_plan` 里的规范化目标与命令文本、
   * `target_snapshot`、`risk_summary`。§10.3.1 的 approve-what-you-see 要求
   * 人类批准的是「即将执行的那条命令」——只给状态列的读取端点无法支撑那个界面
   * （这正是此前 `getApproval` 的局限：它服务执行侧校验，只选 7 列）。
   *
   * `canResolve` 由服务端算：判据是「`pending` 且未过期且未消费」三条同时成立。
   * 让界面自己推会让过期判定的时间基准落在浏览器上，那既不一致也不可审计。
   */
  async listApprovals(input: ListApprovalsInput): Promise<readonly ApprovalDetail[]> {
    const limit = Math.min(Math.max(input.limit ?? 100, 1), 500);
    const decisions = input.decisions === undefined
      ? ['pending', 'approved']
      : [...input.decisions];
    const now = this.#core.now().getTime();
    const r = await this.#core.deps.db.query<{
      id: string;
      engagement_id: string;
      requested_by_worker: string | null;
      action_class: ActionClass;
      decision: ApprovalDecision;
      command_plan: unknown;
      target_snapshot: unknown;
      risk_summary: string | null;
      plan_hash: string;
      lease_generation: number | string | null;
      decided_by: string | null;
      decision_reason: string | null;
      expires_at: string | null;
      consumed_at: string | null;
      created_at: string;
    }>(
      `select id, engagement_id, requested_by_worker, action_class, decision,
              command_plan, target_snapshot, risk_summary, plan_hash, lease_generation,
              decided_by, decision_reason, expires_at, consumed_at, created_at
         from pentest.approvals
        where engagement_id = $1::uuid
          and decision = any($2::text[])
        order by created_at desc
        limit $3`,
      [input.engagementId, decisions, limit],
    );

    return r.rows.map((row) => {
      // `command_plan` 是 jsonb：pg 可能返回对象或字符串，两种都要处理
      const plan = asRecord(row.command_plan);
      const expiresAt = row.expires_at;
      const consumed = row.consumed_at;
      const expired = expiresAt !== null && Date.parse(expiresAt) <= now;
      return {
        id: row.id,
        engagementId: row.engagement_id,
        workerSessionId: row.requested_by_worker,
        actionClass: row.action_class,
        decision: row.decision,
        commandPlan: row.command_plan,
        normalizedTarget: readString(plan, 'normalized_target'),
        normalizedCommand: readString(plan, 'normalized_command'),
        purpose: readString(plan, 'purpose'),
        timeoutMs: readNumber(plan, 'timeout_ms'),
        maxOutputBytes: readNumber(plan, 'max_output_bytes'),
        scopeVersion: readNumber(plan, 'scope_version'),
        policyEpoch: readNumber(plan, 'policy_epoch'),
        targetSnapshot: row.target_snapshot,
        riskSummary: row.risk_summary,
        planHash: row.plan_hash,
        leaseGeneration: row.lease_generation === null ? null : toInt(row.lease_generation, 'lease_generation'),
        decidedBy: row.decided_by,
        decisionReason: row.decision_reason,
        expiresAt,
        consumedAt: consumed,
        createdAt: row.created_at,
        canResolve: row.decision === 'pending' && !expired && consumed === null,
      };
    });
  }

  async decideApproval(input: HumanApprovalDecision): Promise<ApprovalRecord> {
    const reason = input.reason ?? '';
    const resolved = await this.#core.resolveApproval(
      input.approvalId, input.operatorId, input.decision, reason, input.modifiedCommandPlan,
    );
    const noticeDelivered = await this.#core.deliverApprovalNotice(
      resolved.engagementId,
      resolved.record,
      reason,
    );
    return { ...resolved.record, noticeDelivered };
  }

  async revokeApproval(input: HumanApprovalRevocation): Promise<ApprovalRecord> {
    const reason = input.reason ?? '';
    const resolved = await this.#core.resolveApproval(input.approvalId, input.operatorId, 'revoked', reason);
    // 撤销同样要送达：Agent 手里可能正攥着这张凭证准备执行。
    const noticeDelivered = await this.#core.deliverApprovalNotice(
      resolved.engagementId,
      resolved.record,
      reason,
    );
    return { ...resolved.record, noticeDelivered };
  }
}
