/**
 * 范围修订与策略 epoch（§5.5/§6.2.0.5）
 *
 * 从 `pg-workflow.ts` 机械搬运（拆分目标：组合器只做装配与委托，流程各自成类）。
 * 方法体与拆分前逐字一致；共享原语经构造注入的 {@link WorkflowCore} 使用。
 */

import type { ScopeAmendment, ScopeVersionRef } from '../contracts.ts';
import { policySnapshotIsIntact } from '../policy/behavior-profile.ts';
import { scopeContentHash } from '../policy/scope-snapshot.ts';
import { actionPolicyFromSnapshot } from '../policy/pg-policy.ts';
import { WorkflowRejection, asPlainRecord, readAuthorizationExpiry, toInt } from './model.ts';
import type { WorkflowCore } from './core.ts';

export class ScopeAmendmentFlow {
  readonly #core: WorkflowCore;

  constructor(core: WorkflowCore) {
    this.#core = core;
  }

  // ───────────────────────── 范围修订与策略 epoch ─────────────────────────

  /**
   * 范围修订（§5.5、§6.2.0.5）：产生新范围版本与**新策略版本**，递增 `policy_epoch`，
   * 撤销仍待处理的旧凭证，并在提交后终止旧 epoch 的在途动作。
   *
   * 为什么修订必须带着策略一起走：范围是**策略快照的一部分**（`normalized_scope`），
   * 只改范围版本而不产生新策略版本，会让「策略哈希」继续描述一个已经不存在的边界。
   *
   * `policy_epoch` 与 `state_version` 分开：后者被所有人类操作推进（含暂停），
   * 拿它当策略 epoch 会让暂停作废全部放行凭证。
   */
  async amendScope(input: ScopeAmendment): Promise<ScopeVersionRef> {
    let version = 0;
    let hash = '';
    let newPolicyEpoch = 0;
    let policyVersion = 0;
    let aborted = 0;
    await this.#core.tx(async () => {
      const engagement = await this.#core.lockEngagement(input.engagementId, input.expectedStateVersion);
      newPolicyEpoch = toInt(engagement.policy_epoch, 'policy_epoch') + 1;

      const v = await this.#core.deps.txDb.query<{ next: number | string }>(
        `select coalesce(max(version), 0) + 1 as next from pentest.scope_versions where engagement_id = $1::uuid`,
        [input.engagementId],
      );
      version = toInt(v.rows[0]?.next ?? 1, 'scope_version');

      // 范围与策略同源：**已有确认过的策略快照**时以它为基础，只替换规范化的范围部分
      // （预设、pacing、动作集合、停止条件都保持人类当初确认的那一份）；
      // 从未确认过策略的作业（session-first 的 auth_pending 窗口）则按行上的投影列
      // 展开一份新策略——那些列就是它当前的全部事实，没有可丢失的人类选择。
      const projection = asPlainRecord(engagement.policy_snapshot);
      const confirmedBase = projection !== undefined && asPlainRecord(projection['execution_constraints']) !== undefined
        ? projection
        : undefined;
      // 投影必须自证来源：`policy_snapshot_hash` 是写入时算的，重算不一致说明这一行被改过
      // 或写入中断。此时**不能**拿它当基线——那会把篡改内容重新哈希成一个看似合法的
      // 新策略版本，等于替篡改背书。从未被哈希过的行（017 回填与旧行）不受此限。
      if (confirmedBase !== undefined && !policySnapshotIsIntact(confirmedBase, engagement.policy_snapshot_hash)) {
        throw new WorkflowRejection(
          'stale_state_version',
          '当前策略投影与其记录哈希不一致：投影可能被手工改过或写入中断。' +
            '请先由人类重新确认策略，再修订范围——不能以一份无法自证来源的策略作为基线。',
        );
      }
      if (confirmedBase === undefined && (await this.#core.policyVersionCount(input.engagementId)) > 0) {
        // 有历史版本却读不出当前快照：形状已被破坏。重建一份形状相近的会在无人察觉时
        // 换掉人类批准过的策略，因此拒绝修订而不是猜。
        throw new WorkflowRejection(
          'stale_state_version',
          '当前策略快照不可读（缺少 execution_constraints），无法在保留原有约束的前提下修订范围',
        );
      }
      // 修订只替换范围：预设与审批模式都取自**当前冻结快照**（不随修订变化）。
      const frozenPolicy = actionPolicyFromSnapshot(confirmedBase);
      const expanded = this.#core.expandPolicy({
        scopeEntryProfile: engagement.scope_entry_profile,
        behaviorProfile: engagement.behavior_profile,
        approvalMode: frozenPolicy.approvalMode ?? 'human',
        policyOverrides: {},
        targets: input.targets,
        exclusions: input.exclusions,
        constraints: {
          authorization_ref: input.authorizationRef ?? '',
          authorization_expires_at: readAuthorizationExpiry(engagement.scope_snapshot) ?? '',
          roe: {},
          time_window: {},
          budget: null,
          credential_mode: 'none',
        },
        ...(confirmedBase === undefined ? {} : { base: confirmedBase }),
      });
      const scope = expanded.scope;
      // 与创建路径**同一处归一化**：`null` 与空串必须落到同一个形式，
      // 否则同一个边界状态会派生出两个哈希（`scope_versions.authorization_ref`
      // 也会时而是 NULL、时而是空串）。
      const authorizationRef = input.authorizationRef ?? '';
      hash = scopeContentHash({
        targets: scope.targets,
        exclusions: scope.exclusions,
        authorizationRef,
        version,
      });

      const decisionId = await this.#core.recordDecision({
        engagementId: input.engagementId,
        operatorId: input.operatorId,
        decisionType: 'amend_scope',
        subjectId: `${input.engagementId}:v${String(version)}`,
        decision: 'amended',
        reason: input.reason,
        editedPayload: {
          targets: scope.targets,
          exclusions: scope.exclusions,
          decisions: input.decisions,
          policyVersion: toInt(engagement.policy_version, 'policy_version') + 1,
          policyHash: expanded.policyHash,
        },
      });

      await this.#core.deps.txDb.query(
        `insert into pentest.scope_versions
           (engagement_id, version, iteration, targets, exclusions, authorization_ref,
            amendment_reason, changed_by, human_decision_id, content_hash)
         values ($1::uuid,$2,$3,$4::jsonb,$5::jsonb,$6,$7,$8,$9::uuid,$10)`,
        [
          input.engagementId,
          version,
          toInt(engagement.graph_iteration, 'graph_iteration'),
          JSON.stringify(scope.targets),
          JSON.stringify(scope.exclusions),
          authorizationRef,
          input.reason,
          input.operatorId,
          decisionId,
          hash,
        ],
      );

      // 逐资产裁决：纳入/排除/待确认（§5.5 的回环前置）
      for (const d of input.decisions) {
        await this.#core.deps.txDb.query(
          `insert into pentest.asset_scope_versions (asset_id, scope_version, engagement_id, decision, decided_by, human_decision_id)
           values ($1::uuid,$2,$3::uuid,$4,$5,$6::uuid)
           on conflict (asset_id, scope_version) do update
             set decision = excluded.decision, decided_by = excluded.decided_by`,
          [d.assetId, version, input.engagementId, d.decision, input.operatorId, decisionId],
        );
      }

      policyVersion = await this.#core.nextPolicyVersion(input.engagementId);
      await this.#core.deps.txDb.query(
        `insert into pentest.policy_versions
           (engagement_id, version, scope_entry_profile, behavior_profile, policy_snapshot,
            content_hash, policy_epoch, changed_by, human_decision_id, amendment_reason)
         values ($1::uuid,$2,$3,$4,$5::jsonb,$6,$7,$8,$9::uuid,$10)`,
        [
          input.engagementId,
          policyVersion,
          engagement.scope_entry_profile,
          engagement.behavior_profile,
          JSON.stringify(expanded.policySnapshot),
          expanded.policyHash,
          newPolicyEpoch,
          input.operatorId,
          decisionId,
          `范围修订 v${String(version)}`,
        ],
      );

      await this.#core.deps.txDb.query(
        `update pentest.engagements
            set policy_version = $2, policy_snapshot = $3::jsonb,
                policy_snapshot_hash = $4, scope_snapshot = $5::jsonb,
                target_snapshot = $6::jsonb, updated_at = now()
          where id = $1::uuid`,
        [
          input.engagementId,
          policyVersion,
          JSON.stringify(expanded.policySnapshot),
          expanded.policyHash,
          JSON.stringify({
            version,
            targets: scope.targets,
            exclusions: scope.exclusions,
            authorizationRef: input.authorizationRef ?? '',
            authorizationExpiresAt: readAuthorizationExpiry(engagement.scope_snapshot) ?? '',
          }),
          JSON.stringify({ targets: scope.targets, exclusions: scope.exclusions }),
        ],
      );

      // 仍在等待处理的凭证引用的是**旧边界**：作废它，而不是让它攒着等人类误批。
      // 已批准未消费的凭证由执行侧复核失效（计划摘要含 scopeVersion 与 policyEpoch）。
      const pending = await this.#core.deps.txDb.query<{ id: string }>(
        `select id from pentest.approvals
          where engagement_id = $1::uuid and decision = 'pending' and consumed_at is null
          order by created_at`,
        [input.engagementId],
      );
      for (const row of pending.rows) {
        await this.#core.deps.txDb.query(
          `select pentest.resolve_approval($1::uuid, 'revoked', $2, $3)`,
          [row.id, input.operatorId, `范围修订 v${String(version)}：旧凭证失效`],
        );
        await this.#core.audit(input.engagementId, null, 'tool.approval.resolved', {
          approvalId: row.id,
          decision: 'revoked',
          cause: 'scope_amended',
          scopeVersion: version,
        });
      }

      // 策略 epoch 前进：沙箱与代理据此中止在途动作（§10.3.1）
      await this.#core.updateEngagement({
        engagementId: input.engagementId,
        expectedVersion: input.expectedStateVersion,
        policyEpoch: newPolicyEpoch,
      });
      await this.#core.audit(input.engagementId, null, 'scope.amended', {
        operatorId: input.operatorId,
        version,
        policyVersion,
        policyHash: expanded.policyHash,
        scopeHash: hash,
        revokedPendingApprovals: pending.rows.length,
        policyEpochBumped: true,
      });
      await this.#core.audit(input.engagementId, null, 'policy.snapshot.amended', {
        operatorId: input.operatorId,
        policyVersion,
        policyHash: expanded.policyHash,
        scopeVersion: version,
      });
      await this.#core.audit(input.engagementId, null, 'policy.epoch.advanced', {
        operatorId: input.operatorId,
        policyEpoch: newPolicyEpoch,
        scopeVersion: version,
        cause: 'scope_amended',
      });
    });
    if (this.#core.deps.onPolicyEpochAdvanced !== undefined) {
      aborted = await this.#core.deps.onPolicyEpochAdvanced({
        engagementId: input.engagementId,
        newPolicyEpoch,
        cause: 'scope_amended',
      });
    }

    return { engagementId: input.engagementId, version, contentHash: hash, policyVersion, aborted };
  }
}
