/**
 * 作业的创建、读取与策略/范围预览（§6.2.0.5/§9）
 *
 * 从 `pg-workflow.ts` 机械搬运（拆分目标：组合器只做装配与委托，流程各自成类）。
 * 方法体与拆分前逐字一致；共享原语经构造注入的 {@link WorkflowCore} 使用。
 */

import type { ApprovalModeChange, ApprovalModeChangeRef, ArchiveEngagementInput, PurgeEngagementInput, PurgePreview, PurgeResult, ActionClass, BehaviorProfile, CandidateAsset, CreateEngagementInput, EngagementMemory, EngagementSummary, GetEngagementMemoryInput, GetScopeInput, ListCandidateAssetsInput, ListEngagementsInput, ListWorkerSessionsInput, MainStatus, Phase, PolicyPreview, PolicyPreviewInput, PreviewScopeInput, RunMarker, ScopeDetail, ScopeEntryProfile, ScopePreview, ScopePreviewEntry, SessionStatus, UpdateEngagementMemoryInput, WorkerSessionSummary } from '../contracts.ts';
import { ACTION_CLASSES, TERMINAL_SESSION_STATUSES } from '../contracts.ts';
import { scopeContentHash } from '../policy/scope-snapshot.ts';
import { policyContentHash, policySnapshotIsIntact, requireApprovalMode, requireBehaviorSelection, withCustomGuidance } from '../policy/behavior-profile.ts';
import { actionPolicyFromSnapshot } from '../policy/pg-policy.ts';
import type { ScopeTarget } from '../contracts.ts';
import { isPhase } from '../contracts.ts';
import { WorkflowRejection, actionPolicyRiskSummary, asPlainRecord, asStringArray, assertPublicMemorySize, isScopeDecision, previewOne, toInt, toScopeVersionDetail } from './model.ts';
import type { ConfirmationExpansion } from './model.ts';
import type { WorkflowCore } from './core.ts';

export class EngagementFlow {
  readonly #core: WorkflowCore;

  constructor(core: WorkflowCore) {
    this.#core = core;
  }

  /**
   * 创建 engagement（授权向导的落点）。
   *
   * 两步合一：写 engagement 行 + 写范围版本 1。**不创建任何会话**——
   * 设计里授权向导只建立能力边界，首个 Worker 由人类随后显式启动（§1.2）。
   *
   * 初始状态是 `READY` 而非 `AUTH_PENDING`：向导在调用本方法之前已完成授权确认
   * （它是弹窗的最后一步），因此到这里时授权已成立。`AUTH_PENDING` 是向导
   * **进行中**的界面状态，不是数据库里等待被创建的中间态——让数据库里存在一个
   * 「授权未完成」的 engagement 会引入「未授权但已存在」的窗口。
   */
  async createEngagement(input: CreateEngagementInput): Promise<EngagementSummary> {
    if (input.name.trim().length === 0) {
      throw new WorkflowRejection('classification_rejected', 'engagement 名称不能为空');
    }
    // 可选字段在这里**一次性**收敛成确定值。
    //
    // 为什么必须在服务端做而不是指望调用方传：`target_snapshot`/`roe_snapshot`/
    // `config_snapshot` 三列都是 NOT NULL，而 `JSON.stringify(undefined)` 是
    // `undefined`——node-postgres 把它绑成 NULL 并触发 23502。把默认值放在这里，
    // 任何调用方（控制台、脚本、测试）都踩不到那个约束。
    const exclusions = input.exclusions ?? [];
    const roe = input.roe ?? {};
    const timeWindow = input.timeWindow ?? {};
    const authorizationRef = input.authorizationRef ?? '';
    const authorizationExpiresAt = input.authorizationExpiresAt ?? '';
    const publicMemory = input.publicMemory ?? '';
    const scopeEntryProfile = input.scopeEntryProfile ?? 'custom';
    // 行为预设是**每个作业的必选项**，没有默认值：缺了、值不认识、custom 没给指引，一律拒绝。
    // 静默落默认会把「人类选过哪一档」从冻结策略快照里抹掉——而快照是事后唯一能复核的证据。
    let behavior: ReturnType<typeof requireBehaviorSelection>;
    try {
      behavior = requireBehaviorSelection({
        behaviorProfile: input.behaviorProfile,
        customGuidance: input.customGuidance,
      });
    } catch (error) {
      throw new WorkflowRejection(
        'classification_rejected',
        error instanceof Error ? error.message : String(error),
      );
    }
    // 审批模式同样是**必选项**：它决定「预设内的命令要不要人类过目」，静默落默认
    // 等于替人类做了能力决定。
    let approvalMode: ReturnType<typeof requireApprovalMode>;
    try {
      approvalMode = requireApprovalMode(input.approvalMode);
    } catch (error) {
      throw new WorkflowRejection(
        'classification_rejected',
        error instanceof Error ? error.message : String(error),
      );
    }
    const policyEpoch = 0;
    const policyVersion = 1;
    // 长度上限必须在**两个入口**都查。
    //
    // 此前只在 `updateEngagementMemory` 里查，于是建作业时能从向导粘贴任意长度的文本进库
    // （实测 20 万字符被接受），而那段文本会被整段拼进该作业**每一次**会话的系统提示词——
    // 上限是这条面上唯一的上下文占用闸门，绕过它等于允许一段文本挤掉任务本身的空间。
    // 同一不变量在两处实现必然漂移，因此判据抽成一个方法、两处共用。
    assertPublicMemorySize(publicMemory);
    // 范围为空即无事可做，且会让后续所有动作都因「范围外」被拒。
    // 在创建时就拒绝，比让人类启动 Worker 后才发现要好。
    if (input.targets.length === 0) {
      throw new WorkflowRejection(
        'classification_rejected',
        '范围不能为空（§11.1）——没有任何目标被授权时，创建 engagement 没有意义',
      );
    }
    // 服务端展开（§6.2.0.5）：规范化范围 → 展开预设 → 哈希完整快照。
    // 授权引用、到期时间、RoE 与时间窗都进 `execution_constraints`，因此也在哈希覆盖内。
    const expanded = this.#core.expandPolicy({
      scopeEntryProfile,
      behaviorProfile: behavior.behaviorProfile,
      approvalMode,
      policyOverrides: withCustomGuidance(input.policyOverrides ?? {}, behavior.customGuidance),
      targets: input.targets,
      exclusions,
      constraints: {
        authorizationRef,
        authorizationExpiresAt,
        roe,
        timeWindow,
        budget: null,
        credential_mode: 'none',
      },
    });
    const policySnapshot = expanded.policySnapshot;
    const policyHash = expanded.policyHash;
    const scope = expanded.scope;
    const scopeHash = scopeContentHash({
      targets: scope.targets,
      exclusions: scope.exclusions,
      authorizationRef,
      version: 1,
    });
    const id = this.#core.id();
    // 新作业的作用域：INSERT 要过 `app_engagement` 的 WITH CHECK（`id = current_engagement_id()`），
    // 因此必须在**自己的**作用域里插入，而不是沿用调用方那个（可能为空、也可能是别的作业）。
    await this.#core.tx(async () => {
      await this.#core.deps.txDb.query(
        `insert into pentest.engagements
           (id, tenant_id, name, status, current_status, state_version, graph_iteration,
            target_snapshot, scope_snapshot, roe_snapshot, policy_snapshot, config_snapshot, created_by,
            public_memory, public_memory_updated_at, public_memory_updated_by,
            scope_entry_profile, behavior_profile, policy_version, policy_snapshot_hash,
            authorization_confirmed_at, authorization_confirmed_by)
         values ($1::uuid, $2, $3, 'running', 'ready', 0, 1,
                 $4::jsonb, $5::jsonb, $6::jsonb, $7::jsonb, $8::jsonb, $9,
                 $10, case when $10 = '' then null else now() end,
                 case when $10 = '' then null else $9 end,
                 $11, $12, $13, $14, now(), $9)`,
        [
          id,
          this.#core.deps.rlsContext?.tenantId ?? 'local',
          input.name,
          JSON.stringify({ targets: scope.targets, exclusions: scope.exclusions }),
          JSON.stringify({
            version: 1,
            targets: scope.targets,
            exclusions: scope.exclusions,
            authorizationRef,
            authorizationExpiresAt,
            publicMemory,
          }),
          JSON.stringify(roe),
          JSON.stringify(policySnapshot),
          JSON.stringify({ timeWindow }),
          input.operatorId,
          publicMemory,
          scopeEntryProfile,
          behavior.behaviorProfile,
          policyVersion,
          policyHash,
        ],
      );

      // 范围版本 1：与 engagement 同事务写入。
      // `targets` / `exclusions` 存**规范化后**的条目（§9.2）：判定与哈希读的是同一份，
      // 于是「存进库的」与「哈希覆盖的」不会分成两套写法。
      await this.#core.deps.txDb.query(
        `insert into pentest.scope_versions
           (engagement_id, version, iteration, targets, exclusions, authorization_ref,
            amendment_reason, changed_by, content_hash)
         values ($1::uuid, 1, 1, $2::jsonb, $3::jsonb, $4, $5, $6, $7)`,
        [
          id,
          JSON.stringify(scope.targets),
          JSON.stringify(scope.exclusions),
          authorizationRef,
          '初始范围（授权向导）',
          input.operatorId,
          scopeHash,
        ],
      );

      // 决策记录：创建本身是一次人类决定，必须留痕（§16.1）。
      const decisionId = await this.#core.recordDecision({
        engagementId: id,
        operatorId: input.operatorId,
        decisionType: 'create_engagement',
        subjectId: id,
        decision: 'created',
        reason: input.reason,
        editedPayload: {
          name: input.name,
          authorizationRef,
          targets: scope.targets,
          exclusions: scope.exclusions,
          scopeEntryProfile,
          behaviorProfile: behavior.behaviorProfile,
          policyHash,
        },
      });

      await this.#core.deps.txDb.query(
        `insert into pentest.policy_versions
           (engagement_id, version, scope_entry_profile, behavior_profile, policy_snapshot,
            content_hash, policy_epoch, changed_by, human_decision_id, amendment_reason)
         values ($1::uuid,$2,$3,$4,$5::jsonb,$6,$7,$8,$9::uuid,$10)`,
        [
          id,
          policyVersion,
          scopeEntryProfile,
          behavior.behaviorProfile,
          JSON.stringify(policySnapshot),
          policyHash,
          policyEpoch,
          input.operatorId,
          decisionId,
          '初始策略确认',
        ],
      );

      await this.#core.audit(id, null, 'policy.profile.selected', {
        operatorId: input.operatorId,
        scopeEntryProfile,
        behaviorProfile: behavior.behaviorProfile,
        policyVersion,
      });
      // 预览审计（§13.1 / §16.2）：设计要求的顺序是「服务端展开 → 写 previewed → 人类确认」。
      // 预览（控制台 `previewScope`）发生在 engagement 存在之前，而 `context_events.engagement_id`
      // 是 NOT NULL，因此这条事件落在创建事务里、`confirmed` 之前——账本顺序仍是先预览后确认。
      // 关键性质：`previewHash` 必须等于 `confirmed` 的 `policyHash`：两侧都是同一份确定性展开，
      // 浏览器拼不出第二个哈希，于是「人类看到的预览」与「冻结的策略」在账本上可以直接比对。
      await this.#core.audit(id, null, 'policy.snapshot.previewed', {
        operatorId: input.operatorId,
        policyVersion,
        scopeEntryProfile,
        behaviorProfile: behavior.behaviorProfile,
        previewHash: policyHash,
        normalizedSummary: {
          targets: scope.targets.length,
          exclusions: scope.exclusions.length,
          authorizationRef,
        },
        riskSummary: actionPolicyRiskSummary(policySnapshot),
      });
      await this.#core.audit(id, null, 'policy.snapshot.confirmed', {
        operatorId: input.operatorId,
        policyVersion,
        policyHash,
      });
      await this.#core.audit(id, null, 'policy.snapshot.frozen', {
        operatorId: input.operatorId,
        policyVersion,
        policyEpoch,
        policyHash,
      });
      await this.#core.audit(id, null, 'engagement.created', {
        name: input.name,
        authorizationRef,
        targetCount: input.targets.length,
      });
    }, id);

    return {
      id,
      name: input.name,
      runMarker: 'running',
      mainStatus: 'ready',
      currentPhase: null,
      stateVersion: 0,
      graphIteration: 1,
      activeWorkerSessionId: null,
      scopeEntryProfile,
      behaviorProfile: behavior.behaviorProfile,
      approvalMode,
      policyVersion,
      policySnapshotHash: policyHash,
      createdAt: this.#core.now().toISOString(),
      updatedAt: this.#core.now().toISOString(),
    };
  }

  /**
   * 切换审批模式（**运行中可切**，2026-10-05）。
   *
   * 为什么必须写新一版策略而不是原地改一行：模式进策略快照哈希，改它即改策略；
   * 旧放行凭证与在途计划的绑定里有 `policyEpoch`，推进 epoch 让它们**当场**失效——
   * 「切回人工审批」必须立刻生效，不能等旧凭证自己过期。
   *
   * 收紧与放宽同一条路径：都记人类决策、写审计、并在事务**提交后**终止旧 epoch 的在途动作
   * （`onPolicyEpochAdvanced`，返回的终止数落 `execution.stopped`）。
   * **不要求理由**：人类是主人——理由是可选备注（`input.reason ?? ''`），不拦切换。
   */
  async setApprovalMode(input: ApprovalModeChange): Promise<ApprovalModeChangeRef> {
    const nextMode = requireApprovalMode(input.approvalMode);
    let policyVersion = 0;
    let newPolicyEpoch = 0;
    await this.#core.tx(async () => {
      const engagement = await this.#core.lockEngagement(input.engagementId, input.expectedStateVersion);
      const projection = asPlainRecord(engagement.policy_snapshot);
      if (projection === undefined || asPlainRecord(projection['execution_constraints']) === undefined) {
        throw new WorkflowRejection(
          'stale_state_version',
          '当前策略快照不可读（缺少 execution_constraints），无法在保留其余策略的前提下切换审批模式',
        );
      }
      // 与范围修订同一条纪律：投影必须自证来源，否则会替篡改背书。
      if (!policySnapshotIsIntact(projection, engagement.policy_snapshot_hash)) {
        throw new WorkflowRejection(
          'stale_state_version',
          '当前策略投影与其记录哈希不一致：投影可能被手工改过或写入中断，不能以它为基础改策略',
        );
      }
      const current = actionPolicyFromSnapshot(projection).approvalMode ?? 'human';
      if (current === nextMode) {
        throw new WorkflowRejection(
          'classification_rejected',
          `当前已经是${nextMode === 'auto' ? '高权限' : '人工审批'}档，无需切换（切换会平白推进一次策略 epoch）`,
        );
      }
      newPolicyEpoch = toInt(engagement.policy_epoch, 'policy_epoch') + 1;
      policyVersion = toInt(engagement.policy_version, 'policy_version') + 1;
      const policySnapshot = {
        ...projection,
        action_policy: { ...(asPlainRecord(projection['action_policy']) ?? {}), approval_mode: nextMode },
      };
      const policyHash = policyContentHash(policySnapshot);
      const decisionId = await this.#core.recordDecision({
        engagementId: input.engagementId,
        operatorId: input.operatorId,
        decisionType: 'set_approval_mode',
        subjectId: `${input.engagementId}:v${String(policyVersion)}`,
        decision: nextMode,
        // 理由可选：不写也照切（人类是主人），决策记录仍留下 from/to/操作者/时间。
        reason: input.reason ?? '',
        editedPayload: { from: current, to: nextMode, policyVersion, policyHash },
      });
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
          JSON.stringify(policySnapshot),
          policyHash,
          newPolicyEpoch,
          input.operatorId,
          decisionId,
          `审批模式：${current} → ${nextMode}`,
        ],
      );
      await this.#core.deps.txDb.query(
        // version-bump-registered:policy-snapshot-switch —— 理由见 transition-table.ts 的登记表：
        // 审批模式切换要推进版本（旧凭证与在途计划当场失效），但它不是状态转移。
        `update pentest.engagements
            set policy_version = $2, policy_snapshot = $3::jsonb, policy_snapshot_hash = $4,
                policy_epoch = $5, state_version = state_version + 1, updated_at = now()
          where id = $1::uuid`,
        [input.engagementId, policyVersion, JSON.stringify(policySnapshot), policyHash, newPolicyEpoch],
      );
      await this.#core.audit(input.engagementId, null, 'policy.approval_mode.changed', {
        humanDecisionId: decisionId,
        operatorId: input.operatorId,
        from: current,
        to: nextMode,
        policyVersion,
        policyEpoch: newPolicyEpoch,
      });
      await this.#core.audit(input.engagementId, null, 'policy.epoch.advanced', {
        operatorId: input.operatorId,
        policyEpoch: newPolicyEpoch,
        cause: 'policy_amended',
      });
    }, input.engagementId);
    // 事务已提交：只做「停掉旧 epoch 的在途动作」，失败不回滚（与范围修订同一条纪律）。
    let aborted = 0;
    if (this.#core.deps.onPolicyEpochAdvanced !== undefined) {
      aborted = await this.#core.deps.onPolicyEpochAdvanced({
        engagementId: input.engagementId,
        newPolicyEpoch,
        cause: 'policy_amended',
      });
    }
    return { engagementId: input.engagementId, approvalMode: nextMode, policyVersion, policyEpoch: newPolicyEpoch, aborted };
  }

  /**
   * 归档 / 取消归档。清理的**第一级**：列表隐藏，一个字节都不删（审计要求，§9.2）。
   */
  async archiveEngagement(input: ArchiveEngagementInput): Promise<EngagementSummary> {
    await this.#core.tx(async () => {
      const engagement = await this.#core.lockEngagementCurrent(input.engagementId);
      if ((engagement.archived_at !== null) === input.archived) {
        throw new WorkflowRejection(
          'classification_rejected',
          input.archived ? '该作业已经是归档状态' : '该作业本来就没有归档',
        );
      }
      await this.#core.deps.txDb.query(
        `update pentest.engagements set archived_at = $2, updated_at = now() where id = $1::uuid`,
        [input.engagementId, input.archived ? new Date() : null],
      );
      await this.#core.recordDecision({
        engagementId: input.engagementId,
        operatorId: input.operatorId,
        decisionType: 'archive_engagement',
        subjectId: input.engagementId,
        decision: input.archived ? 'archived' : 'unarchived',
        reason: input.reason ?? '',
      });
      await this.#core.audit(input.engagementId, null, 'engagement.archived', {
        operatorId: input.operatorId,
        archived: input.archived,
      });
    }, input.engagementId);
    const listed = await this.listEngagements({ operatorId: input.operatorId, statuses: ['running', 'paused', 'blocked', 'aborted', 'failed'], includeArchived: true });
    const found = listed.find((entry) => entry.id === input.engagementId);
    if (found === undefined) {
      throw new WorkflowRejection('classification_rejected', '归档后读不回该作业（请刷新列表）');
    }
    return found;
  }

  /** 彻底删除前的只读预览：把「要删什么」摊开给人类看。 */
  async previewEngagementPurge(input: { readonly engagementId: string }): Promise<PurgePreview> {
    const engagement = await this.#core.loadEngagement(input.engagementId);
    const blockers = await this.#purgeBlockers(input.engagementId, engagement);
    const counts = await this.#purgeCounts(input.engagementId);
    const retained = await this.#countRows(EngagementFlow.#PURGE_RETAINED, input.engagementId);
    return {
      engagementId: input.engagementId,
      name: engagement.name,
      archived: engagement.archived_at !== null,
      counts,
      total: Object.values(counts).reduce((sum, n) => sum + n, 0),
      retained,
      retainedTotal: Object.values(retained).reduce((sum, n) => sum + n, 0),
      blockers,
    };
  }

  /** 非空即不可删除的三条判据（预览与执行**共用**，否则预览会说谎）。 */
  async #purgeBlockers(
    engagementId: string,
    engagement: { readonly archived_at: Date | null; readonly purged_at: Date | null },
  ): Promise<readonly string[]> {
    const blockers: string[] = [];
    if (engagement.purged_at !== null) {
      blockers.push('该作业的内容已经清空过：再清一次没有意义（审计骨架按 §9.5 永久保留）');
    }
    if (engagement.archived_at === null) {
      blockers.push('该作业尚未归档：清理分两步（先归档、确认列表干净后再彻底删除），避免误删还需要的作业');
    }
    const live = await this.#core.deps.db.query<{ n: number | string }>(
      `select count(*)::int as n from pentest.worker_sessions
        where engagement_id = $1::uuid and not (status = any($2::text[]))`,
      [engagementId, [...TERMINAL_SESSION_STATUSES]],
    );
    const liveSessions = toInt(live.rows[0]?.n ?? 0, 'live_sessions');
    if (liveSessions > 0) blockers.push(`仍有 ${String(liveSessions)} 个未终结的会话：先让它结束（或中止）再删`);
    const leases = await this.#core.deps.db.query<{ n: number | string }>(
      `select count(*)::int as n from pentest.session_leases
        where engagement_id = $1::uuid and revoked_at is null and expires_at > now()`,
      [engagementId],
    );
    const liveLeases = toInt(leases.rows[0]?.n ?? 0, 'live_leases');
    if (liveLeases > 0) blockers.push(`仍有 ${String(liveLeases)} 份有效租约：等它过期或先吊销`);
    return blockers;
  }

  /**
   * 删除顺序表（**按外键依赖**：全部 `NO ACTION`，没有级联，顺序错了就撞 23503）。
   *
   * 完整性由测试兜底：删完断言「可删表全 0 行、必留表仍有行」——加表漏了这里，测试会红。
   */
  /**
   * **按 §9.5 必须保留**的表：审计账本只允许追加（触发器拒 DELETE），而它们引用
   * `engagements`，所以作业行也不能删——第二级清理的语义因此是「内容清零 + 骨架保留」。
   * 被这些行引用的 `worker_sessions` / `handoffs` 同样留下（体量很小）。
   */
  static readonly #PURGE_RETAINED: readonly string[] = [
    'pentest.context_events',
    'pentest.human_decisions',
    'pentest.state_transitions',
    'pentest.ledger_anchors',
    'pentest.memory_access_log',
    'pentest.policy_versions',
    'pentest.worker_sessions',
    'pentest.handoffs',
  ];

  static readonly #PURGE_ORDER: readonly string[] = [
    // `retrieval_hits` 没有 `engagement_id`（它经 `query_id` 关联），条件单独写。
    'pentest.retrieval_hits:query_id in (select id from pentest.retrieval_queries where engagement_id = $1::uuid)',
    'pentest.artifacts',
    'pentest.findings',
    'pentest.memory_chunks',
    // 审批行必须**先于** tool_runs 落删：`approvals.consumed_by_tool_run` 指向 tool_runs，
    // 反向依赖（`tool_runs.approval_id`）已在解环那步摘掉，所以这里只剩一个方向。
    'pentest.approvals',
    'pentest.tool_runs',
    'pentest.retrieval_queries',
    'pentest.memory_items',
    'pentest.reports',
    'pentest.worker_reports',
    'pentest.asset_scope_versions',
    'pentest.assets',
    'pentest.session_leases',
    'pentest.outbox_jobs',
    'pentest.index_watermarks',
    'pentest.embedding_revisions',
    'pentest.request_snapshots',
    'pentest.llm_calls',
    'pentest.scope_intake_proposals',
    'pentest.scope_versions',
  ];

  /** 把「表[:条件]」拆成表名与 WHERE；缺省条件是 `engagement_id = $1::uuid`。 */
  static #purgeTarget(entry: string): { readonly table: string; readonly where: string } {
    const colon = entry.indexOf(':');
    return colon < 0
      ? { table: entry, where: 'engagement_id = $1::uuid' }
      : { table: entry.slice(0, colon), where: entry.slice(colon + 1) };
  }

  /** 按表清单计数（表名可带 `:条件` 后缀，见 {@link #purgeTarget}）。 */
  async #countRows(tables: readonly string[], engagementId: string): Promise<Record<string, number>> {
    const counts: Record<string, number> = {};
    for (const entry of tables) {
      const { table, where } = EngagementFlow.#purgeTarget(entry);
      const result = await this.#core.deps.db.query<{ n: number | string }>(
        `select count(*)::int as n from ${table} where ${where}`,
        [engagementId],
      );
      counts[table.replace('pentest.', '')] = toInt(result.rows[0]?.n ?? 0, `${table}_count`);
    }
    return counts;
  }

  async #purgeCounts(engagementId: string): Promise<Record<string, number>> {
    const counts: Record<string, number> = {};
    for (const entry of EngagementFlow.#PURGE_ORDER) {
      const { table, where } = EngagementFlow.#purgeTarget(entry);
      const result = await this.#core.deps.db.query<{ n: number | string }>(
        `select count(*)::int as n from ${table} where ${where}`,
        [engagementId],
      );
      counts[table.replace('pentest.', '')] = toInt(result.rows[0]?.n ?? 0, `${table}_count`);
    }
    return counts;
  }

  /**
   * **彻底删除**（清理的第二级，不可恢复）。
   *
   * 三条硬约束：① 必须已归档；② 无未终结会话、无有效租约；③ `confirmName` 与作业名
   * **完全一致**——这是人类防手滑的唯一栏杆，前端提示只是辅助。
   * 销毁记录写在 `pentest.engagement_purges`（**独立于被删作业**）：
   * 挂在作业上的话会连同它一起消失，审计上等于「从未存在过」。
   */
  async purgeEngagement(input: PurgeEngagementInput): Promise<PurgeResult> {
    let counts: Record<string, number> = {};
    let retained: Record<string, number> = {};
    await this.#core.tx(async () => {
      const engagement = await this.#core.lockEngagement(input.engagementId, input.expectedStateVersion);
      if (engagement.name !== input.confirmName) {
        throw new WorkflowRejection(
          'classification_rejected',
          '确认名与作业名不一致：这一步不可恢复，请原样输入作业名',
        );
      }
      const blockers = await this.#purgeBlockers(input.engagementId, engagement);
      if (blockers.length > 0) {
        throw new WorkflowRejection('classification_rejected', blockers.join('；'));
      }
      counts = await this.#purgeCounts(input.engagementId);
      retained = await this.#countRows(EngagementFlow.#PURGE_RETAINED, input.engagementId);
      // 先写销毁记录：删到一半失败也不会丢失「人类要求删过它」这件事。
      await this.#core.deps.txDb.query(
        `insert into pentest.engagement_purges
           (engagement_id, engagement_name, operator_id, reason, deleted_counts)
         values ($1::uuid, $2, $3, $4, $5::jsonb)`,
        [
          input.engagementId,
          engagement.name,
          input.operatorId,
          input.reason ?? '',
          JSON.stringify({ deleted: counts, retained }),
        ],
      );
      // 两处外键环先解开（与测试的清理同源）：approvals ↔ tool_runs、
      // engagements.active_agent_session_id ↔ worker_sessions。
      //
      // **解环不能改写任何一边的行，只能延迟约束。**
      // approvals 的 `consumed_by_tool_run` 有守卫触发器（`消费见证不可覆盖` /
      // `只能从 pending 由人类入口推进`，008/011），tool_runs 的终态行同样不可改写（§9.5）——
      // 2026-10-05 实测：清空带已消费审批的作业先死在审批守卫，改从 tool_runs 侧解环后又死在
      // 终态守卫。023 把审批一侧的外键设为 deferrable，于是两条 DELETE 能在本事务里互相解环。
      // 用 ALL 而不是点名：`set constraints <名>` 走 search_path 解析，而 pentest 不在其中
      // （会报 `42704 constraint ... does not exist`，实测如此）。本库里可延迟的约束只有这一条。
      await this.#core.deps.txDb.query(`set constraints all deferred`);
      await this.#core.deps.txDb.query(
        `update pentest.engagements set active_agent_session_id = null where id = $1::uuid`,
        [input.engagementId],
      );
      for (const entry of EngagementFlow.#PURGE_ORDER) {
        const { table, where } = EngagementFlow.#purgeTarget(entry);
        await this.#core.deps.txDb.query(`delete from ${table} where ${where}`, [input.engagementId]);
      }
      // **不删作业行**：审计账本行（§9.5 只允许追加）引用它，删不掉也不该删。
      // 标记 `purged_at` 即「内容已清空」；列表据此显示「已清理」，不再有内容可读。
      await this.#core.deps.txDb.query(
        `update pentest.engagements
            set purged_at = now(), archived_at = coalesce(archived_at, now()), updated_at = now()
          where id = $1::uuid`,
        [input.engagementId],
      );
    }, input.engagementId);
    return { engagementId: input.engagementId, counts, retained };
  }

  /**
   * 列出可管理的 engagement。
   *
   * 排序按 `updated_at` 倒序：控制台首页要优先显示最近动过的那些。
   * 默认不含 `aborted` / `failed`——它们仍在库里（审计要求），但列在首页会让
   * 列表噪声变大；需要时用 `statuses` 显式索取。
   */
  async listEngagements(input: ListEngagementsInput): Promise<readonly EngagementSummary[]> {
    const limit = Math.min(Math.max(input.limit ?? 50, 1), 200);
    const statuses = input.statuses === undefined
      ? ['running', 'paused', 'blocked']
      : [...input.statuses];
    const r = await this.#core.deps.db.query<{
      id: string;
      name: string;
      status: RunMarker;
      current_status: MainStatus;
      current_phase: string | null;
      state_version: number | string;
      graph_iteration: number | string;
      active_agent_session_id: string | null;
      scope_entry_profile: ScopeEntryProfile;
      /** 审批模式存在快照里：列表要显示「高权限」标记，因此把整份快照读回来。 */
      policy_snapshot: unknown;
      /** 归档时间（非空即已归档；默认列表过滤掉它们）。 */
      archived_at: Date | null;
      /** 内容清空时间（非空即已清理，不可逆）。 */
      purged_at: Date | null;
      behavior_profile: BehaviorProfile;
      policy_version: number | string;
      policy_snapshot_hash: string;
      created_at: string;
      updated_at: string;
    }>(
      `select id, name, status, current_status, current_phase, state_version, graph_iteration,
              active_agent_session_id, scope_entry_profile, behavior_profile,
              policy_version, policy_snapshot_hash, policy_snapshot, created_at, updated_at, name, archived_at, purged_at
         from pentest.engagements
        where status = any($1::text[]) and tenant_id = $3
          and ($4::boolean or archived_at is null)
        order by updated_at desc
        limit $2`,
      [statuses, limit, this.#core.tenantId(), input.includeArchived === true],
    );
    return r.rows.map((row) => ({
      id: row.id,
      name: row.name,
      runMarker: row.status,
      mainStatus: row.current_status,
      currentPhase: isPhase(row.current_phase) ? row.current_phase : null,
      stateVersion: toInt(row.state_version, 'state_version'),
      graphIteration: toInt(row.graph_iteration, 'graph_iteration'),
      activeWorkerSessionId: row.active_agent_session_id,
      scopeEntryProfile: row.scope_entry_profile,
      behaviorProfile: row.behavior_profile,
      archivedAt: row.archived_at === null ? null : row.archived_at.toISOString(),
      purgedAt: row.purged_at === null ? null : row.purged_at.toISOString(),
      // 审批模式存在快照里（没有独立列）：读回时按快照解析，旧作业缺键即 `human`。
      approvalMode: actionPolicyFromSnapshot(row.policy_snapshot).approvalMode ?? 'human',
      policyVersion: toInt(row.policy_version, 'policy_version'),
      policySnapshotHash: row.policy_snapshot_hash,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }));
  }

  /**
   * 列出某 engagement 的 Worker 会话（阶段轨道与时间轴的数据源）。
   *
   * 带全部历史指针（`previous_agent_session_id` / `retry_of_session_id` /
   * `transition_id`）：轨道要按阶段聚合、时间轴要画重做链与交接链——没有这些
   * 指针，界面只能平铺一串会话，看不出谁是谁的后继（§6.2「只画有证据的边」的
   * 前提是证据本身可得）。
   *
   * 排序按 `created_at` 升序：时间轴与轨道都按发生顺序阅读，倒序会让「回环」
   * 看起来像往回走。
   */
  async listWorkerSessions(input: ListWorkerSessionsInput): Promise<readonly WorkerSessionSummary[]> {
    const limit = Math.min(Math.max(input.limit ?? 200, 1), 1000);
    const phases = input.phases === undefined ? null : [...input.phases];
    const r = await this.#core.deps.db.query<{
      id: string;
      dsh_session_id: string;
      phase: Phase;
      status: SessionStatus;
      session_kind: string | null;
      attempt: number | string;
      iteration: number | string;
      scope_version: number | string;
      previous_agent_session_id: string | null;
      retry_of_session_id: string | null;
      transition_id: string | null;
      status_note: string | null;
      status_note_source: string | null;
      status_note_at: string | null;
      started_at: string | null;
      ended_at: string | null;
      created_at: string;
      report_id: string | null;
      report_attempt: number | string | null;
      report_status: string | null;
      report_summary: string | null;
      report_created_at: string | null;
    }>(
      // 报告要点用 `left join lateral` 取每会话**最新未取代**的一份（外部审计 P0-2）：
      // 一次查询拿全，避免界面为了显示一行要点再打 N 发。改名必须在**连接内部**完成——
      // 只在外层 `as` 改不动作用域：连接暴露的列名仍叫 `id`/`status`/`created_at`，
      // 与外层同名列撞成 `column reference "id" is ambiguous`（实测 42702）。
      `select id, dsh_session_id, phase, status, session_kind, attempt, iteration, scope_version,
              previous_agent_session_id, retry_of_session_id, transition_id,
              status_note, status_note_source, status_note_at,
              started_at, ended_at, created_at,
              report_id, report_attempt, report_status, report_summary, report_created_at
         from pentest.worker_sessions ws
         left join lateral (
           select r.id as report_id, r.attempt as report_attempt, r.status as report_status,
                  r.summary as report_summary, r.created_at as report_created_at
             from pentest.worker_reports r
            where r.worker_session_id = ws.id and r.superseded_by is null
            order by r.created_at desc, r.id desc
            limit 1
         ) report on true
        where engagement_id = $1::uuid
          and ($2::text[] is null or phase = any($2::text[]))
        order by created_at
        limit $3`,
      [input.engagementId, phases, limit],
    );
    return r.rows.map((row) => ({
      id: row.id,
      dshSessionId: row.dsh_session_id,
      phase: row.phase,
      status: row.status,
      // `session_kind` 是 012 之后的列；**必须给出去**，否则界面无法把 intake 会话从
      // 五阶段轨道里分出来——而 intake 的会话 id 是重载之后找回授权对话的唯一线索
      // （那时 `openTask` 会因运行时已锁定别的作业而被拒，拿不到返回值）。
      sessionKind: row.session_kind === 'intake' ? 'intake' : 'phase',
      attempt: toInt(row.attempt, 'attempt'),
      iteration: toInt(row.iteration, 'iteration'),
      scopeVersion: toInt(row.scope_version, 'scope_version'),
      previousAgentSessionId: row.previous_agent_session_id,
      retryOfSessionId: row.retry_of_session_id,
      transitionId: row.transition_id,
      statusNote: row.status_note,
      // 便签来源用运行时窄化：列是自由文本，未来新增来源时按「非 agent 即为派生」处理，
      // 界面会显示「（自动摘要）」标记——保守的一侧。
      statusNoteSource: row.status_note_source === 'agent' ? 'agent'
        : row.status_note_source === 'derived' ? 'derived' : null,
      statusNoteAt: row.status_note_at,
      latestReport: row.report_id === null
        ? null
        : {
            id: row.report_id,
            attempt: toInt(row.report_attempt, 'report_attempt'),
            status: row.report_status ?? '',
            summary: row.report_summary ?? '',
            createdAt: row.report_created_at ?? row.created_at,
          },
      startedAt: row.started_at,
      endedAt: row.ended_at,
      createdAt: row.created_at,
    }));
  }

  /**
   * 读公共记忆（控制台面板的数据源）。
   *
   * 未写过时返回空串而不是 null：调用方（面板的 textarea、提示词分节）都按字符串处理，
   * 多一个 null 分支就多一处可能忘记处理。
   */
  async getEngagementMemory(input: GetEngagementMemoryInput): Promise<EngagementMemory> {
    const r = await this.#core.deps.db.query<{
      public_memory: string;
      public_memory_updated_at: string | null;
      public_memory_updated_by: string | null;
    }>(
      `select public_memory, public_memory_updated_at, public_memory_updated_by
         from pentest.engagements where id = $1::uuid`,
      [input.engagementId],
    );
    const row = r.rows[0];
    if (row === undefined) {
      throw new WorkflowRejection('classification_rejected', `engagement 不存在：${input.engagementId}`);
    }
    return {
      engagementId: input.engagementId,
      content: row.public_memory,
      updatedAt: row.public_memory_updated_at,
      updatedBy: row.public_memory_updated_by,
    };
  }

  /**
   * 改写公共记忆。
   *
   * 走与其它人类写操作**同一条路径**：加锁 → 记录决策 → 写库 → 推进 state_version → 审计。
   * 为什么它也算「状态推进」：这段文本会被注入之后每一个会话的提示词，因此它改变的是
   * 作业的行为边界——和切换阶段属于同一类事情，必须留下决策记录与版本印记。
   */
  async updateEngagementMemory(input: UpdateEngagementMemoryInput): Promise<EngagementMemory> {
    // 正文必须是字符串：RPC 层把它声明为 `stringOrNull`（为了放行「清空」的空串），
    // 于是 `null` 会一路走到这里。此前直接 `content.length` 会抛 TypeError，
    // 最终被映射成 `console/internal`「内部错误」——一个参数问题伪装成服务故障。
    if (typeof input.content !== 'string') {
      throw new WorkflowRejection('classification_rejected', '公共记忆正文必须是字符串');
    }
    const content = input.content;
    assertPublicMemorySize(content);

    return this.#core.tx(async () => {
      // 用**调用方给的版本**做乐观锁比对，而不是锁后重读当前版本。
      //
      // 方法表把本端点声明为 `lock: 'actor'`，而那个 kind 的定义就是「由服务在它自己的
      // 事务内用信封里的 expectedStateVersion 比对」——与 `amendScope` 同形。
      // 此前写成「锁后读当前版本」，等于**无条件成功**：基于过期版本的保存不会被拒成
      // `stale_state_version`，界面也不会出现 §15.4 的冲突提示，后写者静默覆盖前写者。
      const engagement = await this.#core.lockEngagement(input.engagementId, input.expectedStateVersion);
      await this.#core.recordDecision({
        engagementId: input.engagementId,
        operatorId: input.operatorId,
        decisionType: 'update_public_memory',
        subjectId: input.engagementId,
        decision: 'updated',
        reason: input.reason,
        // 记长度而不是正文：正文已经在 engagements 里，决策记录存一份会让审计链
        // 出现两个可能不一致的副本。长度足以回答「这次改了多少」。
        editedPayload: { length: content.length },
      });
      await this.#core.deps.txDb.query(
        `update pentest.engagements
            set public_memory = $2, public_memory_updated_at = now(), public_memory_updated_by = $3
          where id = $1::uuid`,
        [input.engagementId, content, input.operatorId],
      );
      await this.#core.updateEngagement({
        engagementId: input.engagementId,
        expectedVersion: toInt(engagement.state_version, 'state_version'),
        currentStatus: engagement.current_status,
        currentPhase: engagement.current_phase,
        activeSessionId: engagement.active_agent_session_id,
      });
      await this.#core.audit(input.engagementId, null, 'engagement.public_memory.updated', {
        length: content.length,
      });
      return {
        engagementId: input.engagementId,
        content,
        updatedAt: this.#core.now().toISOString(),
        updatedBy: input.operatorId,
      };
    });
  }

  /**
   * 读取当前范围与历史版本（范围管理页的数据源，§5.5）。
   *
   * `getState` 只给状态机字段，不含范围——而范围管理页要显示版本、目标清单、
   * 排除项、授权依据与历史。
   */
  async getScope(input: GetScopeInput): Promise<ScopeDetail> {
    const r = await this.#core.deps.db.query<{
      version: number | string;
      iteration: number | string;
      targets: unknown;
      exclusions: unknown;
      authorization_ref: string | null;
      amendment_reason: string | null;
      changed_by: string;
      content_hash: string;
      created_at: string;
    }>(
      `select version, iteration, targets, exclusions, authorization_ref,
              amendment_reason, changed_by, content_hash, created_at
         from pentest.scope_versions
        where engagement_id = $1::uuid
        order by version desc
        ${input.includeHistory === true ? '' : 'limit 1'}`,
      [input.engagementId],
    );

    const all = r.rows.map(toScopeVersionDetail);
    const current = all[0] ?? null;
    return {
      current,
      // 历史不含 current 本身——列表里再出现一遍会让人以为有两个当前版本
      history: input.includeHistory === true ? all.slice(1) : [],
    };
  }

  /**
   * 列出待裁决的候选资产（回环范围修订的输入，§5.5）。
   *
   * 带**发现来源**（`discovered_in_session_id` / `discovered_from_asset_id`）：
   * 人类需要知道每个候选是怎么来的（从哪个入口、哪次访问发现）才能判断是否纳入。
   * 只给一个主机名列表等于让人凭空决定。
   */
  async listCandidateAssets(input: ListCandidateAssetsInput): Promise<readonly CandidateAsset[]> {
    const limit = Math.min(Math.max(input.limit ?? 200, 1), 1000);
    const decisions = input.decisions === undefined ? ['pending'] : [...input.decisions];
    const scopeVersion = await this.#core.currentScopeVersion(input.engagementId);
    const r = await this.#core.deps.db.query<{
      id: string;
      canonical_target: string;
      kind: string;
      labels: unknown;
      first_seen_iteration: number | string;
      discovered_in_session_id: string | null;
      discovered_from_asset_id: string | null;
      evidence_refs: unknown;
      decision: string | null;
    }>(
      `select a.id, a.canonical_target, a.kind, a.labels, a.first_seen_iteration,
              a.discovered_in_session_id, a.discovered_from_asset_id, a.evidence_refs,
              asv.decision
         from pentest.assets a
         left join pentest.asset_scope_versions asv
                on asv.asset_id = a.id and asv.scope_version = $2
        where a.engagement_id = $1::uuid
          and coalesce(asv.decision, 'pending') = any($3::text[])
        order by a.first_seen_iteration, a.canonical_target
        limit $4`,
      [input.engagementId, scopeVersion, decisions, limit],
    );

    return r.rows.map((row) => ({
      id: row.id,
      canonicalTarget: row.canonical_target,
      kind: row.kind,
      labels: asStringArray(row.labels),
      firstSeenIteration: toInt(row.first_seen_iteration, 'first_seen_iteration'),
      discoveredFromSessionId: row.discovered_in_session_id,
      discoveredFromAssetId: row.discovered_from_asset_id,
      evidenceRefs: asStringArray(row.evidence_refs),
      currentDecision: isScopeDecision(row.decision) ? row.decision : null,
    }));
  }

  /**
   * 逐条预校验范围条目（授权向导的 dry-run，§13.1）。
   *
   * 用与 `loadScopeRuleSet` **同一份** `normalizeScopeEntry`：这是「同源」的
   * 唯一可靠保证——客户端若自己复制一份（或打包服务端策略模块），两份迟早漂移，
   * 表现为「界面说没问题、服务端整体拒绝」或更糟的反向情况。
   *
   * 刻意**不做整体校验**（不调 `loadScopeRuleSet`）：向导需要的是**逐行**结论，
   * 好把失败对回具体那一行让人类改。整体校验只给一个错误，人类无从下手。
   */
  async previewScope(input: PreviewScopeInput): Promise<ScopePreview> {
    const targets = input.targets.map((entry, index) => previewOne(entry, index));
    const exclusions = input.exclusions.map((entry, index) => previewOne(entry, index));
    return {
      targets,
      exclusions,
      ok: [...targets, ...exclusions].every((e) => e.rejectionCode === null),
    };
  }

  /**
   * 策略/范围预览（§6.2.0.5）：把「现在点确认会冻结什么」完整摊给人类看。
   *
   * 三件事必须为真，否则这个端点就是在误导人：
   *   1. **同源**：与确认共用 {@link #expandForConfirmation}，因此哈希逐位相同；
   *   2. **只读**：不写库、不推进版本，可以反复刷新；
   *   3. **诚实**：解析不到的域名、非法的预设、未知的覆盖键都以 blocker 呈现，
   *      而不是「预览通过、确认时被拒」。
   *
   * 主动动作的**地址裁决**只在这里展示（`resolvedAddresses`）：真实拨号仍发生在沙箱内，
   * 服务端不做任何指向目标的连接——预览不是探测。
   */
  async previewPolicy(input: PolicyPreviewInput): Promise<PolicyPreview> {
    const blockers: string[] = [];
    const engagement = await this.#core.loadEngagement(input.engagementId);
    const currentEpoch = toInt(engagement.policy_epoch, 'policy_epoch');

    // 复刻确认侧的前置校验：预览的全部意义是「这里通过 = 确认会成功」，
    // 因此凡是确认会拒的输入，都必须在这里变成 blocker 而不是让人类白点一次。
    const intakeBlock = await this.#core.intakeConfirmBlock({
      engagementId: input.engagementId,
      currentStatus: engagement.current_status,
      activeSessionId: engagement.active_agent_session_id,
    });
    if (intakeBlock !== null) {
      blockers.push(
        intakeBlock.kind === 'status'
          ? `当前任务没有可确认的 intake 范围（${intakeBlock.detail}）：确认会被拒`
          : `${intakeBlock.detail}：确认会被拒（lease_revoked）`,
      );
    }
    if (input.proposalId !== undefined) {
      const proposal = (await this.#core.deps.db.query<{ status: string; worker_session_id: string }>(
        `select status, worker_session_id from pentest.scope_intake_proposals
          where id = $1::uuid and engagement_id = $2::uuid`,
        [input.proposalId, input.engagementId],
      )).rows[0];
      if (proposal === undefined || proposal.status !== 'pending') {
        blockers.push('范围方案不存在或已被处理：请刷新后重新读取方案（不要对着失效的方案点确认）');
      }
    }
    // 授权依据**不是闸门**：本插件服务于已获授权的作业环境（部署方自己就是授权主体），
    // 因此空授权引用不再阻断确认——它只作为审计字段被记录（有就存，没有就空着）。
    for (const action of input.allowedActions ?? []) {
      if (!(ACTION_CLASSES as readonly string[]).includes(action)) {
        blockers.push(`未知动作类别：${String(action)}（确认会拒绝）`);
      }
    }
    const scopeEntryProfile = input.scopeEntryProfile ?? engagement.scope_entry_profile;
    // 预览必须与确认**同样严格**：缺预设（或 custom 缺指引）在这里就是 blocker。
    // 否则会出现「预览一片绿、点确认被拒」——那是最费人的组合。
    let behaviorSelection: ReturnType<typeof requireBehaviorSelection> | undefined;
    try {
      behaviorSelection = requireBehaviorSelection({
        behaviorProfile: input.behaviorProfile ?? engagement.behavior_profile,
        customGuidance: input.customGuidance,
      });
    } catch (error) {
      blockers.push(error instanceof Error ? error.message : String(error));
    }
    const behaviorProfile = behaviorSelection?.behaviorProfile ?? engagement.behavior_profile;
    // 审批模式：与确认同样严格（缺了就拦下，不让人类对着默认值点确认）。
    let approvalMode = actionPolicyFromSnapshot(engagement.policy_snapshot).approvalMode ?? 'human';
    if (input.approvalMode !== undefined) {
      try {
        approvalMode = requireApprovalMode(input.approvalMode);
      } catch (error) {
        blockers.push(error instanceof Error ? error.message : String(error));
      }
    }

    // 逐条结论：把服务端规范化结果摊开（与 `previewScope` 同一份纯函数）。
    const entriesOf = (entries: readonly ScopeTarget[]): readonly ScopePreviewEntry[] =>
      entries.map((entry, index) => previewOne(entry, index));
    const targets = entriesOf(input.targets);
    const exclusions = entriesOf(input.exclusions);
    for (const [bucket, entries] of [['目标', targets], ['排除项', exclusions]] as const) {
      for (const entry of entries) {
        if (entry.rejectionCode !== null) {
          blockers.push(`${bucket}[${String(entry.index)}] ${entry.detail ?? entry.rejectionCode}`);
        }
      }
    }
    if (input.targets.length === 0) blockers.push('范围不能为空：没有任何目标被授权时，确认没有意义');
    const currentScopeVersion = await this.#core.currentScopeVersion(input.engagementId);
    if (currentScopeVersion > 0) {
      blockers.push(
        `该作业已有范围版本 ${String(currentScopeVersion)}：确认路径不适用（会撞唯一约束），请改用范围修订`,
      );
    }

    let expanded: ConfirmationExpansion | null = null;
    try {
      expanded = this.#core.expandForConfirmation({
        scopeEntryProfile,
        behaviorProfile,
        approvalMode,
        policyOverrides: withCustomGuidance(input.policyOverrides ?? {}, behaviorSelection?.customGuidance),
        allowedActions: input.allowedActions ?? [],
        targets: input.targets,
        exclusions: input.exclusions,
        authorizationNote: input.authorizationRef ?? '',
        authorizationExpiresAt: input.authorizationExpiresAt ?? '',
        roe: input.roe ?? {},
        timeWindow: input.timeWindow ?? {},
      });
    } catch (error) {
      // 展开失败是**可预期的拒绝**（未知预设、未知覆盖键、非法条目），以 blocker 呈现。
      blockers.push(error instanceof Error ? error.message : String(error));
    }

    // 地址裁决（§10.2.2 地址固定）：IP 字面量自身即已裁决；域名要服务端解析。
    const resolvedAddresses: Record<string, readonly string[]> = {};
    const resolve = this.#core.deps.resolveAddresses;
    for (const target of expanded?.scope.targets ?? []) {
      if (target.kind === 'asset-label' || target.kind === 'cidr' || target.kind === 'url') continue;
      const isIp = /^\d{1,3}(\.\d{1,3}){3}$/.test(target.value) || target.value.includes(':');
      if (isIp) {
        resolvedAddresses[target.value] = [target.value];
        continue;
      }
      if (resolve === undefined) {
        blockers.push(`未配置 DNS 裁决钩子：域名 ${target.value} 无法在确认前确定拨号地址`);
        resolvedAddresses[target.value] = [];
        continue;
      }
      let addresses: readonly string[] | undefined;
      try {
        addresses = await resolve(target.value);
      } catch (error) {
        blockers.push(`解析 ${target.value} 失败：${error instanceof Error ? error.message : String(error)}`);
        addresses = undefined;
      }
      resolvedAddresses[target.value] = addresses ?? [];
      if ((addresses ?? []).length === 0) {
        // 这正是「确认后动作会被拒」的典型原因，必须在确认前说清。
        blockers.push(`域名 ${target.value} 未解析出任何地址：指向它的动作会被 dns_unresolved 拒绝`);
      }
    }

    const policy = expanded === null ? null : expanded;
    const actionPolicy = policy === null
      ? null
      : asPlainRecord(asPlainRecord(policy.policySnapshot['action_policy']) ?? {});
    const readClassList = (value: unknown): readonly ActionClass[] =>
      Array.isArray(value)
        ? value.filter((item): item is ActionClass => (ACTION_CLASSES as readonly string[]).includes(item as string))
        : [];

    return {
      ok: blockers.length === 0,
      blockers,
      scopeEntryProfile,
      behaviorProfile,
      approvalMode,
      targets,
      exclusions,
      resolvedAddresses,
      pacing: policy === null
        ? { rate: 0, concurrency: 0, jitter: 0, burst: 0, retry: 0 }
        : asPlainRecord(policy.policySnapshot['pacing']) as PolicyPreview['pacing'],
      enabledActionClasses: readClassList(actionPolicy?.['enabled']),
      disabledActionClasses: readClassList(actionPolicy?.['disabled']),
      perActionApprovalClasses: readClassList(actionPolicy?.['perActionApprovalClasses']),
      enabledDisabledClasses: readClassList(actionPolicy?.['enabledDisabledClasses']),
      dualConfirmed: actionPolicy?.['dualConfirmed'] === true,
      credentialMode: typeof policy?.policySnapshot['credential_mode'] === 'string'
        ? policy.policySnapshot['credential_mode']
        : 'none',
      stopConditions: Array.isArray(policy?.policySnapshot['stop_conditions'])
        ? (policy.policySnapshot['stop_conditions'] as readonly string[])
        : [],
      executionConstraints: policy === null ? {} : (asPlainRecord(policy.policySnapshot['execution_constraints']) ?? {}),
      nextScopeVersion: (await this.#core.currentScopeVersion(input.engagementId)) + 1,
      nextPolicyVersion: await this.#core.nextPolicyVersionReadOnly(input.engagementId),
      currentPolicyEpoch: currentEpoch,
      // 确认不推进 epoch（见契约注释）：这里如实回填同一个值，界面据此显示「保持不变」。
      nextPolicyEpoch: currentEpoch,
      snapshotHash: policy?.policyHash ?? '',
    };
  }
}
