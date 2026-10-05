/**
 * 会话优先的 intake 流程（§4.2/§5.4 建立作业与范围确认）
 *
 * 从 `pg-workflow.ts` 机械搬运（拆分目标：组合器只做装配与委托，流程各自成类）。
 * 方法体与拆分前逐字一致；共享原语经构造注入的 {@link WorkflowCore} 使用。
 */

import type { BootstrapIntakeInput, BootstrapIntakeResult, ConfirmScopeProposalInput, ConfirmedScopeProposal, IntakeStatus, IntakeStatusInput, MainStatus, OpenTaskInput, OpenTaskResult, RejectScopeProposalInput, RunMarker, ScopeProposal, SessionKind } from '../contracts.ts';
import { HUMAN_QUESTION_TOOL, ACTION_CLASSES, TERMINAL_SESSION_STATUSES } from '../contracts.ts';
import { scopeContentHash } from '../policy/scope-snapshot.ts';
import { actionPolicyFromSnapshot } from '../policy/pg-policy.ts';
import { requireApprovalMode, requireBehaviorSelection, withCustomGuidance } from '../policy/behavior-profile.ts';
import { issueLease, revokeLease } from './lease.ts';
import { DEFAULTS } from '../contracts.ts';
import { BOOTSTRAP_NEXT_STEP, WorkflowRejection, actionPolicyRiskSummary, normalizeEngagementName, toInt } from './model.ts';
import type { EngagementRow, SessionRow } from './model.ts';
import type { WorkflowCore } from './core.ts';
import { planTransition } from './transition-table.ts';

export class IntakeFlow {
  readonly #core: WorkflowCore;

  constructor(core: WorkflowCore) {
    this.#core = core;
  }

  // ───────────────────────── 读取 ─────────────────────────

  // ───────────────────────── 会话优先 intake ─────────────────────────

  /**
   * 打开或恢复一个隐藏 engagement 的 intake Worker。
   *
   * 该路径不写 scope_versions，也不把未确认输入当成授权；唯一可见的 Worker 能力是
   * 只读/报告/范围提案。相同租户与 clientSessionKey 通过唯一索引幂等恢复。
   */
  async openTask(input: OpenTaskInput): Promise<OpenTaskResult> {
    const clientSessionKey = input.clientSessionKey.trim();
    if (clientSessionKey.length === 0) {
      throw new WorkflowRejection('classification_rejected', 'clientSessionKey 不能为空');
    }
    if (clientSessionKey.length > 256) {
      throw new WorkflowRejection('classification_rejected', 'clientSessionKey 过长');
    }

    const caps = await this.#core.capabilities().resolve('intelligence-gathering');
    const intakeTools = [
      'memory_search',
      'memory_read',
      'artifact_read',
      // 官方人机提问通道（带选项的提问界面）。intake 的全部工作就是「问清范围」，
      // 纯文本问卷让人类手抄答案，正是这条通道要解决的问题（见 `HUMAN_QUESTION_TOOL`）。
      HUMAN_QUESTION_TOOL,
      'pentest_request_scope_confirmation',
      'pentest_write_status_note',
    ] as const;
    const staged = await this.#core.tx(async () => {
      // This lock covers the lookup and insert boundary. The partial unique index remains
      // the durable invariant; the advisory lock makes concurrent callers converge instead
      // of racing into a unique-violation retry loop.
      await this.#core.deps.txDb.query(
        `select pg_advisory_xact_lock(hashtextextended($1::text, 0))`,
        [clientSessionKey],
      );
      // 反查「本客户端键是否已有作业」。
      //
      // ── 为什么分两条路，而不是统一走函数 ──
      //
      // `engagement_for_client_session` 是 SECURITY DEFINER 函数，**在函数体内**要求
      // `current_tenant_id()` 非空（那是它防跨租户探测的唯一手段）。而 `current_tenant_id()`
      // 读的是 `set_rls_context` 写的 GUC，只有配置了 `config.rlsContext` 的部署才会设它。
      //
      // 于是：
      //   - **配置了 RLS 的部署**：函数可用且必须用它——直接查 `engagements` 会被
      //     `app_engagement` 挡下（此时上下文里还没有 engagement），而 `013` 当年正是
      //     为了绕过这一点才加了租户级 PERMISSIVE，那同时放开了写入。
      //   - **没配置 RLS 的部署**（`harness.dev.patch.yml`、`docker/profile.patch.yml` 两处
      //     交付配置都是这种；`docs/...design.md` §9.4.1 有记录）：GUC 恒为空，函数恒返回
      //     NULL。若仍然走函数，`openTask` 会把「已有作业」误判成「没有」→ 走 INSERT →
      //     撞 `engagements_tenant_client_session` 唯一索引 23505。**这是实测的回归**：
      //     控制台每次挂载都会调 `openTask`，于是第二次就失败，幂等恢复整条失效。
      //     这种部署里 RLS 本来就不生效（运行时是超级用户），直查与改前逐字等价。
      //
      // 两条路的**结果形状相同**（0 或 1 行），因此下游逻辑不需要分支。
      //
      // 不加 `for update`：并发同一 `clientSessionKey` 的互斥由上面那条 advisory 锁保证，
      // 而持久不变量是 `engagements_tenant_client_session` 部分唯一索引。
      const found = this.#core.deps.rlsContext === undefined
        ? (await this.#core.deps.txDb.query<{
            id: string;
            state_version: number | string;
            active_agent_session_id: string | null;
            current_status: MainStatus;
            status: RunMarker;
          }>(
            `select id, state_version, active_agent_session_id, current_status, status
               from pentest.engagements
              where tenant_id = $1 and client_session_key = $2`,
            [this.#core.tenantId(), clientSessionKey],
          )).rows[0]
        : (await this.#core.deps.txDb.query<{
            id: string;
            state_version: number | string;
            active_agent_session_id: string | null;
            current_status: MainStatus;
            status: RunMarker;
          }>(
            `select id, state_version, active_agent_session_id, current_status, status
               from pentest.engagements
              where id = pentest.engagement_for_client_session($1, $2)`,
            [this.#core.tenantId(), clientSessionKey],
          )).rows[0];

      const engagementId = found === undefined ? this.#core.id() : found.id;
      // 本事务按租户作用域开启（此时还不知道/还没生成 engagement），因此这里只断言：
      // 外层若已锁定到**别的**作业，说明调用方把请求路由错了，响亮失败比读错作业安全。
      // 真正的上下文由下面那条 `set_rls_context` 显式设成刚确定的 id。
      this.#core.assertRlsEngagement(engagementId);
      // 上下文必须在**动任何 engagement 作用域的读写之前**设好。
      //
      // 三条理由，缺一不可：
      //   1. `worker_sessions` 与 `session_leases` 没有任何租户级放行（015 拆掉了），
      //      没有上下文时一行都看不见——「已存在的 intake 会话」这条分支会误判成不存在；
      //   2. 新建 engagement 的 INSERT 要过 `app_engagement` 的 WITH CHECK
      //      （`id = current_engagement_id()`），而新 id 是我们自己生成的，先设再插即可；
      //   3. aborted/failed 的复位 UPDATE 同样需要上下文。
      if (this.#core.deps.rlsContext !== undefined) {
        await this.#core.deps.txDb.query('select pentest.set_rls_context($1, $2::uuid, $3::uuid)', [
          this.#core.deps.rlsContext.tenantId,
          engagementId,
          null,
        ]);
      }

      if (found !== undefined && found.status !== 'aborted' && found.status !== 'failed') {
        if (found.active_agent_session_id !== null) {
          const session = await this.#core.deps.txDb.query<SessionRow & { engagement_id: string }>(
            `select id, engagement_id, dsh_session_id, phase, status, session_kind,
                    attempt, iteration, scope_version, task_prompt
               from pentest.worker_sessions
              where id = $1::uuid
              for update`,
            [found.active_agent_session_id],
          );
          const row = session.rows[0];
          if (row !== undefined && row.session_kind === 'intake' && toInt(row.scope_version, 'scope_version') === 0) {
            return {
              kind: 'existing' as const,
              engagementId: found.id,
              workerSessionId: row.id,
              dshSessionId: row.dsh_session_id,
              stateVersion: toInt(found.state_version, 'state_version'),
            };
          }
        }
        if (found.current_status !== 'auth_pending') {
          throw new WorkflowRejection('classification_rejected', '该客户端任务已离开 intake 阶段，不能重新创建 intake');
        }
      }

      const workerSessionId = this.#core.id();
      const dshSessionId = this.#core.dshSessionIdOf(workerSessionId);
      if (found === undefined) {
        await this.#core.deps.txDb.query(
          `insert into pentest.engagements
             (id, tenant_id, name, status, current_status, state_version, graph_iteration,
              target_snapshot, scope_snapshot, roe_snapshot, policy_snapshot, config_snapshot, created_by,
              public_memory, public_memory_updated_at, public_memory_updated_by, client_session_key)
           values ($1::uuid,$2,$3,'running','auth_pending',0,1,'{}'::jsonb,$4::jsonb,'{}'::jsonb,'{}'::jsonb,'{}'::jsonb,$5,'',null,null,$6)`,
          [
            engagementId,
            this.#core.tenantId(),
            `未命名任务 ${clientSessionKey.slice(0, 12)}`,
            JSON.stringify({ version: 0, targets: [], exclusions: [], authorizationExpiresAt: '' }),
            input.operatorId,
            clientSessionKey,
          ],
        );
      } else if (found.status === 'aborted' || found.status === 'failed') {
        await this.#core.deps.txDb.query(
          `update pentest.engagements
              set status = 'running', current_status = 'auth_pending', current_phase = null,
                  active_agent_session_id = null, updated_at = now()
            where id = $1::uuid`,
          [engagementId],
        );
      }

      if (found === undefined) {
        await this.#core.audit(engagementId, null, 'engagement.created', {
          clientSessionKey,
          hidden: true,
          authorizationPending: true,
        });
      }
      await this.#core.insertWorkerSession({
        id: workerSessionId,
        engagementId,
        dshSessionId,
        sessionKind: 'intake',
        phase: 'intelligence-gathering',
        caps,
        skillIds: [],
        toolAllow: intakeTools,
        taskPrompt: '主动询问目标、排除项、协议、端口、允许动作、时间窗；在范围被人类确认前不得执行目标动作，只能提交待确认范围方案。',
        scopeVersion: 0,
        iteration: 1,
      });
      const updated = await this.#core.deps.txDb.query<{ state_version: number | string }>(
        `update pentest.engagements
            set current_status = 'auth_pending', current_phase = null,
                active_agent_session_id = $2::uuid, state_version = state_version + 1, updated_at = now()
          where id = $1::uuid
        returning state_version`,
        [engagementId, workerSessionId],
      );
      if (updated.rows[0] === undefined) throw new WorkflowRejection('classification_rejected', '创建 intake 任务时 engagement 不存在');
      await this.#core.audit(engagementId, workerSessionId, 'worker.session.created', {
        sessionKind: 'intake',
        dshSessionId,
        clientSessionKey,
      });
      return {
        kind: 'created' as const,
        engagementId,
        workerSessionId,
        dshSessionId,
        stateVersion: toInt(updated.rows[0].state_version, 'state_version'),
      };
    });

    if (staged.kind === 'existing') {
      const lease = await this.#core.activeLeaseOf(staged.workerSessionId);
      if (lease === null) {
        throw new WorkflowRejection('lease_required', '已有 intake 会话但租约不可用；请等待恢复流程或重新打开任务');
      }
      return {
        workerSessionId: staged.workerSessionId,
        dshSessionId: staged.dshSessionId,
        leaseId: lease.id,
        leaseGeneration: lease.generation,
        engagementId: staged.engagementId,
        sessionKind: 'intake',
        scopeVersion: 0,
        stateVersion: staged.stateVersion,
        resumed: true,
      };
    }

    const lease = await issueLease(this.#core.deps.leases, {
      workerSessionId: staged.workerSessionId,
      ttlSeconds: DEFAULTS.leaseTtlSeconds,
      now: this.#core.now(),
    });
    await this.#core.createDshSessionOrMarkFailed({
      sessionKind: 'intake',
      engagementId: staged.engagementId,
      workerSessionId: staged.workerSessionId,
      dshSessionId: staged.dshSessionId,
      phase: 'intelligence-gathering',
      profileId: caps.profileId,
      profileRevision: caps.profileRevision,
      modelRoute: caps.modelRoute,
      skillIds: [],
      toolAllow: intakeTools,
      taskPrompt: '请主动询问并澄清目标与范围信息；不得执行目标动作。收集完整后只能提交待人类确认的范围方案。',
      budget: undefined,
      approvalRequired: [],
      handoffContext: null,
      actionTemplates: [],
      publicMemory: '',
    });
    return {
      workerSessionId: staged.workerSessionId,
      dshSessionId: staged.dshSessionId,
      leaseId: lease.id,
      leaseGeneration: lease.generation,
      engagementId: staged.engagementId,
      sessionKind: 'intake',
      scopeVersion: 0,
      stateVersion: staged.stateVersion,
      resumed: false,
    };
  }

  /**
   * 把**当前会话**登记为某作业的 intake（「会话即 intake」）。
   *
   * ── 与 `openTask` 的区别 ──
   *
   * `openTask` 由控制台调用：它派生 `dsh-<workerSessionId>` 并**新建**一个 dsh 会话。
   * 本方法由**正在对话的那个会话里的 Agent** 调用，会话已经存在，因此：
   *   - `dsh_session_id` 记录**调用方的真实标识**（不派生、不新建）；
   *   - 不做 `ctx.agents.create`——那会再起一个会话，而人正在跟眼前这个说话。
   *
   * 这解决的正是那个死角：聊天里发起渗透任务时，工具面看得见却没有作业可归属，
   * 而旧实现只能让人类去控制台手动建（见 `workerSessionIdOf` 的长注释）。
   *
   * ── 安全边界没有放松 ──
   *
   * 只创建 **`auth_pending` + 范围版本 0** 的作业。**不接受**任何「已确认」入参，
   * 也不写范围版本——确认必须由人类在控制台点（`confirmScopeProposal`）。
   * 因此 Agent 自建作业**拿不到任何执行能力**：执行仍要范围版本 + 逐次放行 + 沙箱三道。
   *
   * ── 幂等 ──
   *
   * 客户端键由 dsh 会话标识派生（`session:<id>`），同一会话反复调用收敛到同一个作业；
   * 与 `openTask` 用浏览器键收敛是同一条机制（含同一条 advisory 锁与部分唯一索引）。
   */
  async bootstrapIntake(input: BootstrapIntakeInput): Promise<BootstrapIntakeResult> {
    const dshSessionId = input.dshSessionId.trim();
    if (dshSessionId.length === 0) {
      throw new WorkflowRejection('classification_rejected', 'dshSessionId 不能为空');
    }
    const clientSessionKey = `session:${dshSessionId}`;
    const caps = await this.#core.capabilities().resolve('intelligence-gathering');
    const intakeTools = [
      'memory_search',
      'memory_read',
      'artifact_read',
      // 官方人机提问通道（带选项的提问界面）。intake 的全部工作就是「问清范围」，
      // 纯文本问卷让人类手抄答案，正是这条通道要解决的问题（见 `HUMAN_QUESTION_TOOL`）。
      HUMAN_QUESTION_TOOL,
      'pentest_request_scope_confirmation',
      'pentest_write_status_note',
    ] as const;

    const staged = await this.#core.tx(async () => {
      // 与 `openTask` 同一条互斥：并发调用收敛而不是撞唯一索引。
      await this.#core.deps.txDb.query(
        `select pg_advisory_xact_lock(hashtextextended($1::text, 0))`,
        [clientSessionKey],
      );
      const found = this.#core.deps.rlsContext === undefined
        ? (await this.#core.deps.txDb.query<{
            id: string;
            state_version: number | string;
            active_agent_session_id: string | null;
            current_status: MainStatus;
            status: RunMarker;
          }>(
            `select id, state_version, active_agent_session_id, current_status, status
               from pentest.engagements
              where tenant_id = $1 and client_session_key = $2`,
            [this.#core.tenantId(), clientSessionKey],
          )).rows[0]
        : (await this.#core.deps.txDb.query<{
            id: string;
            state_version: number | string;
            active_agent_session_id: string | null;
            current_status: MainStatus;
            status: RunMarker;
          }>(
            `select id, state_version, active_agent_session_id, current_status, status
               from pentest.engagements
              where id = pentest.engagement_for_client_session($1, $2)`,
            [this.#core.tenantId(), clientSessionKey],
          )).rows[0];

      const engagementId = found === undefined ? this.#core.id() : found.id;
      this.#core.assertRlsEngagement(engagementId);
      if (this.#core.deps.rlsContext !== undefined) {
        await this.#core.deps.txDb.query('select pentest.set_rls_context($1, $2::uuid, $3::uuid)', [
          this.#core.deps.rlsContext.tenantId,
          engagementId,
          null,
        ]);
      }

      // ── 已经有绑定：复用，不新建 ──
      if (found !== undefined && found.status !== 'aborted' && found.status !== 'failed') {
        if (found.active_agent_session_id !== null) {
          const existing = await this.#core.deps.txDb.query<SessionRow & { engagement_id: string }>(
            `select id, engagement_id, dsh_session_id, phase, status, session_kind,
                    attempt, iteration, scope_version, task_prompt
               from pentest.worker_sessions
              where id = $1::uuid
              for update`,
            [found.active_agent_session_id],
          );
          const row = existing.rows[0];
          if (
            row !== undefined
            && row.session_kind === 'intake'
            && row.dsh_session_id === dshSessionId
            && toInt(row.scope_version, 'scope_version') === 0
            && !TERMINAL_SESSION_STATUSES.has(row.status)
          ) {
            return {
              kind: 'existing' as const,
              engagementId: found.id,
              workerSessionId: row.id,
              stateVersion: toInt(found.state_version, 'state_version'),
            };
          }
          // 旧绑定**已终结**：为同一个作业重新绑定本会话。
          //
          // 这是幂等重试的自然路径，不是放松边界：上一次 bootstrap 可能在建好作业后
          // 才失败（如签发租约时进程被打断），于是库里留下 `starting` 行，随后被
          // 启动对账判为中断。此时若一律拒绝，本会话就被永久钉死在一个不能用的作业上——
          // 而人类看到的只是「无法开始」。重新绑定产生的仍是同一个作业、同样
          // `auth_pending` + 范围版本 0，能力边界没有任何变化。
          if (row === undefined || !TERMINAL_SESSION_STATUSES.has(row.status)) {
            throw new WorkflowRejection(
              'classification_rejected',
              '本会话已绑定到一个仍在运行的作业（或绑定已被别的会话占用），不能重复发起',
            );
          }
        } else if (found.current_status !== 'auth_pending') {
          throw new WorkflowRejection(
            'classification_rejected',
            '该作业已离开 intake 阶段，不能重新创建 intake',
          );
        }
      }

      const workerSessionId = this.#core.id();
      if (found === undefined) {
        await this.#core.deps.txDb.query(
          `insert into pentest.engagements
             (id, tenant_id, name, status, current_status, state_version, graph_iteration,
              target_snapshot, scope_snapshot, roe_snapshot, policy_snapshot, config_snapshot, created_by,
              public_memory, public_memory_updated_at, public_memory_updated_by, client_session_key)
           values ($1::uuid,$2,$3,'running','auth_pending',0,1,'{}'::jsonb,$4::jsonb,'{}'::jsonb,'{}'::jsonb,'{}'::jsonb,$5,'',null,null,$6)`,
          [
            engagementId,
            this.#core.tenantId(),
            normalizeEngagementName(input.name, dshSessionId),
            JSON.stringify({ version: 0, targets: [], exclusions: [], authorizationExpiresAt: '' }),
            input.operatorId,
            clientSessionKey,
          ],
        );
        await this.#core.audit(engagementId, null, 'engagement.created', {
          clientSessionKey,
          source: 'session_bootstrap',
          authorizationPending: true,
        });
      } else {
        await this.#core.deps.txDb.query(
          `update pentest.engagements
              set status = 'running', current_status = 'auth_pending', current_phase = null,
                  active_agent_session_id = null, updated_at = now()
            where id = $1::uuid`,
          [engagementId],
        );
      }

      await this.#core.insertWorkerSession({
        id: workerSessionId,
        engagementId,
        // **关键差异**：登记的是调用方自己的会话标识，而不是派生一个新 id。
        dshSessionId,
        sessionKind: 'intake',
        phase: 'intelligence-gathering',
        caps,
        skillIds: [],
        toolAllow: intakeTools,
        taskPrompt:
          '主动询问目标、排除项、协议、端口、允许动作、时间窗；在范围被人类确认前不得执行目标动作，只能提交待确认范围方案。',
        scopeVersion: 0,
        iteration: 1,
      });
      const updated = await this.#core.deps.txDb.query<{ state_version: number | string }>(
        `update pentest.engagements
            set current_status = 'auth_pending', current_phase = null,
                active_agent_session_id = $2::uuid, state_version = state_version + 1, updated_at = now()
          where id = $1::uuid
        returning state_version`,
        [engagementId, workerSessionId],
      );
      if (updated.rows[0] === undefined) {
        throw new WorkflowRejection('classification_rejected', '创建 intake 时 engagement 不存在');
      }
      await this.#core.audit(engagementId, workerSessionId, 'worker.session.created', {
        sessionKind: 'intake',
        dshSessionId,
        source: 'session_bootstrap',
      });
      return {
        kind: 'created' as const,
        engagementId,
        workerSessionId,
        stateVersion: toInt(updated.rows[0].state_version, 'state_version'),
      };
    });

    // ── 事务外：租约 + 把会话置为 active ──
    //
    // 与 `startWorker` 同理，这两步不能进事务：
    //   - 租约有独立事务边界（`lockWorkerSession` 会用另一条连接 `FOR UPDATE` 那行
    //     尚未提交的 `worker_sessions` → 自锁死）；
    //   - 这里**不创建** dsh 会话（会话就是调用方），只把行从 `starting` 推到 `active`。
    if (staged.kind === 'existing') {
      const lease = await this.#core.activeLeaseOf(staged.workerSessionId);
      if (lease === null) {
        throw new WorkflowRejection(
          'lease_required',
          '本会话已绑定到该作业，但其租约不可用；请等待恢复流程或由人类在控制台重建会话',
        );
      }
      return {
        engagementId: staged.engagementId,
        workerSessionId: staged.workerSessionId,
        dshSessionId,
        leaseId: lease.id,
        leaseGeneration: lease.generation,
        scopeVersion: 0,
        resumed: true,
        nextStep: BOOTSTRAP_NEXT_STEP,
      };
    }

    const lease = await issueLease(this.#core.deps.leases, {
      workerSessionId: staged.workerSessionId,
      ttlSeconds: DEFAULTS.leaseTtlSeconds,
      now: this.#core.now(),
    });
    // 从 `starting` 推到 `active`。
    //
    // **必须带作用域**：这条 UPDATE 走的是写路径，而写路径**不会因为 0 行而报错**——
    // 没有上下文时 RLS 会把行滤掉，函数照常返回，会话就永远停在 `starting`。
    // 这里显式给 engagementId（与 `openTask` 那条同语义的 UPDATE 不同：那条在
    // 控制台请求的作用域里执行，本方法由工具调用，没有外层作用域可依附）。
    await this.#core.tx(async () => {
      await this.#core.deps.txDb.query(
        `update pentest.worker_sessions set status = 'active', started_at = now() where id = $1::uuid`,
        [staged.workerSessionId],
      );
    }, staged.engagementId);
    return {
      engagementId: staged.engagementId,
      workerSessionId: staged.workerSessionId,
      dshSessionId,
      leaseId: lease.id,
      leaseGeneration: lease.generation,
      scopeVersion: 0,
      resumed: false,
      nextStep: BOOTSTRAP_NEXT_STEP,
    };
  }

  /**
   * 会话状态：这个 dsh 会话当前需要人类做什么（聊天里的「待你确认」卡片用它）。
   *
   * 反查走 `pentest.worker_session_binding_by_dsh`——与 `PgWorkerTools` 解析会话身份
   * **同一条路径**（SECURITY DEFINER、租户内自校验）。没有绑定就返回全 null：
   * 那不是错误，而是「这个会话不属于渗透作业」。
   *
   * 该函数要求租户上下文已设置（函数体里 `current_tenant_id() IS NOT NULL`），
   * 这里用的 `#d.db` 正是组合根按 `config.rlsContext` 包装的读连接——**每条查询自动带租户**。
   * 裸连接直查会拿到 0 行（实测），所以这里刻意不加"再直查一次"的兜底：
   * 两条路径要么都成要么都不成，兜底只会把失败时机推后。
   *
   * 只读：不推进任何状态，因此聊天面板可以反复轮询。
   */
  async getIntakeStatus(input: IntakeStatusInput): Promise<IntakeStatus> {
    const empty: IntakeStatus = {
      engagementId: null,
      engagementName: null,
      workerSessionId: null,
      sessionKind: null,
      mainStatus: null,
      pendingProposal: null,
      pendingApprovalCount: 0,
      stateVersion: 0,
    };
    if (typeof input.dshSessionId !== 'string' || input.dshSessionId.trim() === '') return empty;
    const scopes = this.#core.deps.rlsScope;
    const inTenantScope = <T>(work: () => Promise<T>): Promise<T> =>
      scopes === undefined ? work() : scopes.run({ engagementId: null, workerSessionId: null }, work);

    // ① 只带**租户**上下文反查：`worker_session_binding_by_dsh` 是 SECURITY DEFINER，
    // 函数体要求租户在场（`current_tenant_id() IS NOT NULL`），此时我们恰恰还没有 engagement。
    // 查询失败**不吞**：吞掉会把「读不到」伪装成「不属于本插件」，而两者对界面的
    // 含义相反（客户端把 RPC 失败显示为「读不到」，把全 null 显示为「不画任何东西」）。
    const binding = await inTenantScope(async () =>
      this.#core.deps.db.query<{ worker_session_id: string | null; engagement_id: string | null }>(
        `select worker_session_id, engagement_id from pentest.worker_session_binding_by_dsh($1)`,
        [input.dshSessionId],
      ),
    );
    const row = binding.rows[0];
    if (row === undefined || row.engagement_id === null || row.worker_session_id === null) return empty;
    // 收成本地常量：TS 对「属性的窄化」不跨进闭包。
    const engagementId = row.engagement_id;
    const workerSessionId = row.worker_session_id;

    // ② 作业名、当前状态、会话行、放行凭证、待确认方案**都是 engagement 作用域的数据**。
    // FORCE RLS 下只带租户上下文读不到它们——`engagements` 能读（它有租户级 SELECT），
    // 于是这条路径最容易退化成「作业名有值、待办恒为空」：人以为没有要确认的东西，
    // 而方案明明还在等。这里显式进入该作业的作用域再读。
    const read = async (): Promise<{
      // `null` = 作业读不到（绑定还在但作业行不可见/不存在）——此时整体返回空而不是抛。
      engagement: EngagementRow | null;
      engagementName: string | null;
      sessionKind: SessionKind | null;
      pendingApprovals: number;
      proposal: ScopeProposal | null;
    }> => {
      let engagement: EngagementRow;
      try {
        engagement = await this.#core.loadEngagement(engagementId);
      } catch {
        // 绑定存在但作业读不到：返回空而不是抛——这是常驻 UI 的数据源，
        // 抛出去会让聊天面板显示一个它无法处置的错误。
        return { engagement: null, engagementName: null, sessionKind: null, pendingApprovals: 0, proposal: null };
      }
      const session = await this.#core.loadSession(workerSessionId);
      // 读取失败不得伪装成「0 待办」（P16：读取失败与确实为空必须分开表达）——
      // 抛出去由 RPC 层折成 console/internal，客户端显示「读不到」而不是「没有要放行的事」。
      const approvals = await this.#core.deps.db.query<{ n: number | string }>(
        `select count(*)::int as n from pentest.approvals
          where engagement_id = $1::uuid and decision = 'pending' and consumed_at is null`,
        [engagementId],
      );
      return {
        engagement,
        engagementName: await this.#core.engagementName(engagementId),
        sessionKind: session === null ? null : session.session_kind,
        pendingApprovals: toInt(approvals.rows[0]?.n ?? 0, 'pending_approval_count'),
        proposal: await this.#core.getScopeProposal(engagementId),
      };
    };
    const data = scopes === undefined ? await read() : await scopes.run({ engagementId, workerSessionId }, read);
    if (data.engagement === null) return empty;
    return {
      engagementId,
      engagementName: data.engagementName,
      workerSessionId,
      sessionKind: data.sessionKind,
      mainStatus: data.engagement.current_status,
      pendingProposal: data.proposal,
      pendingApprovalCount: data.pendingApprovals,
      // 与方案一起交给界面：卡片的确认/驳回要用它做乐观锁（见 `IntakeStatus.stateVersion`）。
      stateVersion: toInt(data.engagement.state_version, 'state_version'),
    };
  }

  async rejectScopeProposal(input: RejectScopeProposalInput): Promise<ScopeProposal | null> {
    const result = await this.#core.tx(async () => {
      const engagement = await this.#core.lockEngagement(input.engagementId, input.expectedStateVersion);
      const proposal = await this.#core.proposalForUpdate(input.engagementId, input.proposalId);
      if (proposal === null || proposal.status !== 'pending') {
        throw new WorkflowRejection('classification_rejected', '范围方案不存在或已被处理');
      }
      const decisionId = await this.#core.recordDecision({
        engagementId: input.engagementId,
        operatorId: input.operatorId,
        decisionType: 'reject_scope_proposal',
        subjectId: input.proposalId,
        decision: 'rejected',
        reason: input.reason,
      });
      await this.#core.deps.txDb.query(
        `update pentest.scope_intake_proposals
            set status = 'rejected', human_decision_id = $2::uuid, decided_at = now()
          where id = $1::uuid`,
        [input.proposalId, decisionId],
      );
      await this.#core.updateEngagement({
        engagementId: input.engagementId,
        expectedVersion: toInt(engagement.state_version, 'state_version'),
      });
      await this.#core.audit(input.engagementId, proposal.worker_session_id, 'human.decision', {
        decisionId,
        proposalId: input.proposalId,
        decision: 'rejected',
      });
      return null;
    });
    return result;
  }

  async confirmScopeProposal(input: ConfirmScopeProposalInput): Promise<ConfirmedScopeProposal> {
    if (input.targets.length === 0) throw new WorkflowRejection('classification_rejected', '确认范围不能为空');
    // 授权说明**可以为空**（它只进审计与策略快照，不作为确认前提）：
    // 要求填授权凭据会把「已获授权的警务/靶场作业」挡在门外，而它并不增加任何技术安全边界——
    // 人类确认闸门、范围强制、逐动作放行与审计账本才是真正的边界，它们一个都没变。
    // 这条路径建立的是**范围版本 1**（会话与转移行同样按 1 写）。若该作业已经有范围版本
    // （例如范围修订先跑过），继续走确认会撞 `UNIQUE (engagement_id, version)` 并以 23505
    // 冒到调用方——那既不是它能理解的错误，也不是它该做的动作。因此在这里明确拒绝，
    // 并让预览给出同一条 blocker（预览通过 = 确认会成功）。
    const existingScopeVersion = await this.#core.currentScopeVersion(input.engagementId);
    if (existingScopeVersion > 0) {
      throw new WorkflowRejection(
        'classification_rejected',
        `该作业已有范围版本 ${String(existingScopeVersion)}：确认范围提案只在尚无范围版本时适用，请改用范围修订`,
      );
    }
    const allowedActions = [...new Set(input.allowedActions)];
    for (const action of allowedActions) {
      if (!ACTION_CLASSES.includes(action)) throw new WorkflowRejection('classification_rejected', `未知动作类别：${String(action)}`);
    }
    const caps = await this.#core.capabilities().resolve('intelligence-gathering');
    const phaseSessionId = this.#core.id();
    const phaseDshSessionId = this.#core.dshSessionIdOf(phaseSessionId);
    const staged = await this.#core.tx(async () => {
      const engagement = await this.#core.lockEngagement(input.engagementId, input.expectedStateVersion);
      // 判据与预览共用（`#intakeConfirmBlock`）：预览通过 = 这里会成功。
      const intakeBlock = await this.#core.intakeConfirmBlock({
        engagementId: input.engagementId,
        currentStatus: engagement.current_status,
        activeSessionId: engagement.active_agent_session_id,
      });
      if (intakeBlock?.kind === 'status') {
        throw new WorkflowRejection('classification_rejected', '当前任务没有可确认的 intake 范围');
      }
      if (intakeBlock !== null) {
        throw new WorkflowRejection('lease_revoked', '活动 intake 会话已不可用');
      }
      // 确认即冻结（§6.2.0.5）：规范化范围 → 展开预设 → 哈希一次成型。
      // 放在**锁定的行**上展开而不是进事务前先读一次：否则并发修订会让
      // 「冻结的预设」与「库里的预设」不是同一份。
      // 「显式给出 → 否则取行投影」与预览、范围修订共用同一套默认——
      // 预览因此必然等于这里冻结的东西。
      // 行为预设是每个作业的必选项：这里接受「人类在确认卡上显式选的」或「建作业时选的」，
      // 但必须在场且合法——缺了就拒绝，不静默落默认（预览侧会给出同一条 blocker）。
      let behavior: ReturnType<typeof requireBehaviorSelection>;
      try {
        behavior = requireBehaviorSelection({
          behaviorProfile: input.behaviorProfile ?? engagement.behavior_profile,
          customGuidance: input.customGuidance,
        });
      } catch (error) {
        throw new WorkflowRejection(
          'classification_rejected',
          error instanceof Error ? error.message : String(error),
        );
      }
      // 审批模式：显式给出，或沿用作业当前的冻结值；缺了就拒绝（与预览同源判据）。
      let approvalMode: ReturnType<typeof requireApprovalMode>;
      try {
        approvalMode = requireApprovalMode(
          input.approvalMode ?? actionPolicyFromSnapshot(engagement.policy_snapshot).approvalMode ?? 'human',
        );
      } catch (error) {
        throw new WorkflowRejection(
          'classification_rejected',
          error instanceof Error ? error.message : String(error),
        );
      }
      const expanded = this.#core.expandForConfirmation({
        scopeEntryProfile: input.scopeEntryProfile ?? engagement.scope_entry_profile,
        behaviorProfile: behavior.behaviorProfile,
        approvalMode,
        policyOverrides: withCustomGuidance(input.policyOverrides ?? {}, behavior.customGuidance),
        allowedActions,
        targets: input.targets,
        exclusions: input.exclusions,
        authorizationNote: input.authorizationNote,
        authorizationExpiresAt: input.authorizationExpiresAt ?? '',
        // RoE 与时间窗随确认一起冻结（省略即空）：它们进快照哈希，
        // 因此必须由人类显式可选，而不是被悄悄丢掉。
        roe: input.roe ?? {},
        timeWindow: input.timeWindow ?? {},
      });
      const scope = expanded.scope;
      const policySnapshot = expanded.policySnapshot;
      const policyHash = expanded.policyHash;
      // 上面的判据保证「活动会话存在且是 intake 会话」；这里再取一次句柄，
      // 既拿到**收窄后的类型**，也让「会话在这中间没了」仍然是一个显式拒绝，
      // 而不是一个非空断言。
      const activeSessionId = engagement.active_agent_session_id;
      if (activeSessionId === null) {
        throw new WorkflowRejection('lease_revoked', '活动 intake 会话已不可用');
      }
      const intake = await this.#core.loadSession(activeSessionId);
      if (intake === null || intake.engagement_id !== input.engagementId || intake.session_kind !== 'intake') {
        throw new WorkflowRejection('lease_revoked', '活动 intake 会话已不可用');
      }
      // ── intake 的租约：**只做证据，不做闸门** ──
      //
      // 人类的思考时间不受 TTL 约束（2026-10-04 实机：人类答复慢于 10 分钟，租约到期，
      // 于是「预览通过、点确认」被 `lease_required` 挡住，方案卡在 pending——会话既提交不了
      // 新方案也确认不了旧方案，只能整单废弃）。而 intake 阶段的产出是**待人类确认的方案**，
      // 闸门是这里的确认动作本身，不是租约；租约在该阶段的价值只是「这个会话确实被登记为
      // 本作业的 intake」这一条证据。
      //
      // 因此：**没签发过**（无行）与**被吊销**（含 superseded/closed/failed，说明会话已被
      // 取代）仍然拒绝；只有**到期**（含清扫器已把它标成 expired）放行。
      const intakeLease = await this.#core.deps.txDb.query<{
        generation: number | string;
        expires_at: Date | string;
        revoked_reason: string | null;
      }>(
        `select generation, expires_at, revoked_reason from pentest.session_leases
          where worker_session_id = $1::uuid
          order by generation desc limit 1`,
        [intake.id],
      );
      const leaseRow = intakeLease.rows[0];
      if (leaseRow === undefined) {
        throw new WorkflowRejection('lease_required', 'intake 租约不存在（本会话从未签发租约）');
      }
      const leaseExpired =
        leaseRow.revoked_reason === 'expired'
        || (leaseRow.revoked_reason === null && new Date(leaseRow.expires_at).getTime() <= this.#core.now().getTime());
      if (leaseRow.revoked_reason !== null && !leaseExpired) {
        throw new WorkflowRejection('lease_revoked', `intake 租约已被吊销（${leaseRow.revoked_reason}）`);
      }
      const proposal = await this.#core.proposalForUpdate(input.engagementId, input.proposalId);
      if (proposal === null || proposal.status !== 'pending' || proposal.worker_session_id !== intake.id) {
        throw new WorkflowRejection('classification_rejected', '范围方案不存在、已被处理或不属于当前 intake');
      }
      const editedPayload = {
        objective: input.objective,
        targets: input.targets,
        exclusions: input.exclusions,
        allowedActions,
        authorizationNote: input.authorizationNote,
        proposal: {
          objective: proposal.objective,
          targets: proposal.proposed_targets,
          exclusions: proposal.proposed_exclusions,
          allowedActions: proposal.proposed_allowed_actions,
          authorizationNote: proposal.authorization_note,
        },
      };
      const scopeSnapshot = {
        version: 1,
        targets: scope.targets,
        exclusions: scope.exclusions,
        authorizationRef: input.authorizationNote,
        authorizationExpiresAt: input.authorizationExpiresAt ?? '',
      };
      const scopeHash = scopeContentHash({
        targets: scope.targets,
        exclusions: scope.exclusions,
        authorizationRef: input.authorizationNote,
        version: 1,
      });
      const decisionId = await this.#core.recordDecision({
        engagementId: input.engagementId,
        operatorId: input.operatorId,
        decisionType: 'confirm_scope_proposal',
        subjectId: input.proposalId,
        decision: 'confirmed',
        reason: input.reason,
        editedPayload,
        authContext: {
          intakeSessionId: intake.id,
          intakeLeaseGeneration: Number(leaseRow.generation),
          clientSessionKey: 'session-first',
        },
      });
      await this.#core.deps.txDb.query(
        `insert into pentest.scope_versions
           (engagement_id, version, iteration, targets, exclusions, authorization_ref,
            amendment_reason, changed_by, human_decision_id, content_hash)
         values ($1::uuid,1,1,$2::jsonb,$3::jsonb,$4,$5,$6,$7::uuid,$8)`,
        [
          input.engagementId,
          JSON.stringify(scope.targets),
          JSON.stringify(scope.exclusions),
          input.authorizationNote,
          '人类确认 intake 范围方案',
          input.operatorId,
          decisionId,
          scopeHash,
        ],
      );
      const nextPolicyVersion = await this.#core.nextPolicyVersion(input.engagementId);
      await this.#core.deps.txDb.query(
        `insert into pentest.policy_versions
           (engagement_id, version, scope_entry_profile, behavior_profile, policy_snapshot,
            content_hash, policy_epoch, changed_by, human_decision_id, amendment_reason)
         values ($1::uuid,$2,$3,$4,$5::jsonb,$6,$7,$8,$9::uuid,$10)`,
        [
          input.engagementId,
          nextPolicyVersion,
          expanded.scopeEntryProfile,
          expanded.behaviorProfile,
          JSON.stringify(policySnapshot),
          policyHash,
          toInt(engagement.policy_epoch, 'policy_epoch'),
          input.operatorId,
          decisionId,
          '人类确认 intake 范围方案并冻结策略',
        ],
      );
      // 策略审计：**两条创建路径必须留下同一组事件**。
      // 这里此前只写了 `scope.snapshot` 与 `human.authorization.confirmed`，冻结了策略版本却没有
      // `policy.*` 事件——于是「intake 确认」建出来的作业在账本里看不出人类选了哪个预设、
      // 服务端展开了什么、以及最终冻结的哈希是否等于预览哈希。设计 §13.1 / §16.2 要求的是后者。
      // 顺序：选择 → 预览 → 确认 → 冻结（`previewHash` 与 `confirmed` 的哈希同源，可直接比对）。
      await this.#core.audit(input.engagementId, intake.id, 'policy.profile.selected', {
        operatorId: input.operatorId,
        scopeEntryProfile: expanded.scopeEntryProfile,
        behaviorProfile: expanded.behaviorProfile,
        policyVersion: nextPolicyVersion,
      });
      await this.#core.audit(input.engagementId, intake.id, 'policy.snapshot.previewed', {
        operatorId: input.operatorId,
        policyVersion: nextPolicyVersion,
        scopeEntryProfile: expanded.scopeEntryProfile,
        behaviorProfile: expanded.behaviorProfile,
        previewHash: policyHash,
        normalizedSummary: {
          targets: scope.targets.length,
          exclusions: scope.exclusions.length,
        },
        riskSummary: actionPolicyRiskSummary(policySnapshot),
      });
      await this.#core.audit(input.engagementId, intake.id, 'policy.snapshot.confirmed', {
        operatorId: input.operatorId,
        policyVersion: nextPolicyVersion,
        policyHash,
      });
      await this.#core.audit(input.engagementId, intake.id, 'policy.snapshot.frozen', {
        operatorId: input.operatorId,
        policyVersion: nextPolicyVersion,
        policyEpoch: toInt(engagement.policy_epoch, 'policy_epoch'),
        policyHash,
      });
      await this.#core.deps.txDb.query(
        `update pentest.scope_intake_proposals
            set status = 'confirmed', human_decision_id = $2::uuid, decided_at = now()
          where id = $1::uuid`,
        [input.proposalId, decisionId],
      );
      // 顺序是**被约束逼出来的**，不是风格问题：
      //   1. `engagements_active_session_fk` 不可延迟 → 指针只能指向已存在的会话行；
      //   2. `worker_sessions_one_live_per_engagement` 是活跃状态的部分唯一索引 →
      //      必须先关掉 intake，再插入 phase 会话。
      // 此前的顺序（先写指针、后插会话）在这两条上都不成立，运行时必然 23503——
      // 该路径当时没有任何测试，所以这个缺陷一直没有暴露。
      await this.#core.deps.txDb.query(
        `update pentest.worker_sessions set status = 'closed', ended_at = now() where id = $1::uuid`,
        [intake.id],
      );
      const transitionId = this.#core.id();
      await this.#core.insertWorkerSession({
        id: phaseSessionId,
        engagementId: input.engagementId,
        dshSessionId: phaseDshSessionId,
        sessionKind: 'phase',
        phase: 'intelligence-gathering',
        caps,
        skillIds: caps.defaultSkillIds,
        toolAllow: caps.defaultToolAllow,
        taskPrompt: input.taskPrompt ?? input.objective,
        scopeVersion: 1,
        iteration: 1,
        previousAgentSessionId: intake.id,
        transitionId,
        // 首个 phase 会话由**范围确认**产生，没有交接草稿可指；`handoff_id` 的语义是
        // 交接包标识，塞范围方案标识进去只会留下一个跨表的悬空引用。
        handoffId: null,
      });
      await this.#core.deps.txDb.query(
        `update pentest.engagements
            set target_snapshot = $2::jsonb, scope_snapshot = $3::jsonb,
                roe_snapshot = $4::jsonb, policy_snapshot = $5::jsonb,
                scope_entry_profile = $7, behavior_profile = $8,
                policy_version = $9, policy_snapshot_hash = $10,
                authorization_confirmed_at = now(), authorization_confirmed_by = $6,
                current_status = 'worker_running', current_phase = 'intelligence-gathering',
                active_agent_session_id = $11::uuid, state_version = state_version + 1, updated_at = now()
          where id = $1::uuid`,
        [
          input.engagementId,
          JSON.stringify({ targets: scope.targets, exclusions: scope.exclusions }),
          JSON.stringify(scopeSnapshot),
          JSON.stringify({ authorizationNote: input.authorizationNote }),
          JSON.stringify(policySnapshot),
          input.operatorId,
          expanded.scopeEntryProfile,
          expanded.behaviorProfile,
          nextPolicyVersion,
          policyHash,
          phaseSessionId,
        ],
      );
      const nextVersion = toInt(engagement.state_version, 'state_version');
      // `handoff_id` 保持 null：它的语义是**交接草稿**标识，而这次转移来自范围确认——
      // 此前这里塞的是 `scope_intake_proposals.id`，而该列外键指向 `handoffs(id)`，运行时必然 23503。
      // 方案关联关系在 `human_decisions.subject_id` 与 `scope_intake_proposals.human_decision_id` 上。
      // AD-2（2026-10-05 复核）：这条账本行此前被手写成
      // `auth_pending → worker_running / start`——图上不存在这个组合。状态图把
      // 「人类确认授权与范围」标为 `auth_pending → ready` 且 **recorded: false**
      // （留痕在 human_decisions 与范围/策略快照），随后才是 `ready → worker_running`
      // 的 `start` 边。因此账本只记后者：一次服务端操作跨了两条边，可记账的只有一条。
      const planned = planTransition({ type: 'start', fromStatus: 'ready', toStatus: 'worker_running' });
      this.#core.assertPlan(planned);
      await this.#core.recordPlannedTransition({
        plan: planned.plan,
        // 预生成 id：上面的会话行 `transition_id` 引用了它（两行互相引用，用预生成 uuid 打破环）。
        id: transitionId,
        engagementId: input.engagementId,
        fromPhase: null,
        toPhase: 'intelligence-gathering',
        graphIteration: 1,
        fromScopeVersion: 0,
        toScopeVersion: 1,
        fromSessionId: intake.id,
        toSessionId: phaseSessionId,
        expectedVersion: nextVersion,
        humanDecisionId: decisionId,
        handoffId: null,
        reason: input.reason,
      });
      await this.#core.audit(input.engagementId, intake.id, 'scope.snapshot', {
        scopeVersion: 1,
        targetSnapshot: { targets: scope.targets, exclusions: scope.exclusions },
        scopeSnapshot,
        roeSnapshot: { authorizationNote: input.authorizationNote },
        policySnapshot,
        policyVersion: nextPolicyVersion,
        policyHash,
        scopeHash,
      });
      await this.#core.audit(input.engagementId, phaseSessionId, 'human.authorization.confirmed', {
        decisionId,
        proposalId: input.proposalId,
        transitionId,
        scopeVersion: 1,
        previousIntakeSessionId: intake.id,
        editedPayload,
      });
      return { intake, stateVersion: nextVersion + 1, transitionId };
    }, input.engagementId);
    await revokeLease(this.#core.deps.leases, { workerSessionId: staged.intake.id, reason: 'closed', now: this.#core.now() });
    let lease;
    try {
      lease = await issueLease(this.#core.deps.leases, {
        workerSessionId: phaseSessionId,
        ttlSeconds: DEFAULTS.leaseTtlSeconds,
        now: this.#core.now(),
      });
      await this.#core.createDshSessionOrMarkFailed({
        sessionKind: 'phase',
        engagementId: input.engagementId,
        workerSessionId: phaseSessionId,
        dshSessionId: phaseDshSessionId,
        phase: 'intelligence-gathering',
        profileId: caps.profileId,
        profileRevision: caps.profileRevision,
        modelRoute: caps.modelRoute,
        skillIds: caps.defaultSkillIds,
        skillBriefs: await this.#core.skillBriefsOf(caps.defaultSkillIds),
        retrievalChannels: this.#core.retrievalChannelsOf(),
        enforcedApprovalClasses: await this.#core.enforcedApprovalClassesOf(input.engagementId),
        toolAllow: caps.defaultToolAllow,
        taskPrompt: input.taskPrompt ?? input.objective,
        budget: undefined,
        approvalRequired: allowedActions,
        handoffContext: JSON.stringify({ proposalId: input.proposalId, targets: input.targets, exclusions: input.exclusions }),
        actionTemplates: this.#core.actionTemplates(),
        behavior: await this.#core.behaviorBriefOf(input.engagementId),
        publicMemory: await this.#core.publicMemoryOf(input.engagementId),
      });
    } catch (error) {
      await revokeLease(this.#core.deps.leases, { workerSessionId: phaseSessionId, reason: 'failed', now: this.#core.now() }).catch(() => undefined);
      throw error;
    }
    return {
      workerSessionId: phaseSessionId,
      dshSessionId: phaseDshSessionId,
      leaseId: lease.id,
      leaseGeneration: lease.generation,
      engagementId: input.engagementId,
      scopeVersion: 1,
      stateVersion: staged.stateVersion,
      sessionKind: 'phase',
    };
  }
}
