/**
 * 对账与恢复：把「崩溃后的残留状态」变为确定的、可审计的结论。
 *
 * 设计依据：docs/dsh-pentest-plugin-design.md §15.2（dsh 进程崩溃）、
 * §15.3（重复提交与结果丢失）、§15.1（数据库不可用）、§12.1（单进程运维契约）
 *
 * ── 为什么需要这个模块 ──
 *
 * 状态写入与会话创建是**两步**（库先写、dsh 会话后建），中间必然存在崩溃窗口。
 * 库里那条 `status='starting'` 的行就是那个窗口的证据。没有对账，它永远停在
 * 半空状态：人类看到「有个会话」但没有任何东西在跑，而系统也不认为它失败了。
 * 文档原话是「按**已中断**对账，不假装已完成」——本模块就是那句话的执行者。
 *
 * ── 三条判定纪律 ──
 *
 * 1. **不自动重放有副作用的动作**。文档 §15.2 明确：已受理但没有结束事件的
 *    工具执行标记为 `interrupted` / `unknown`，**必须人工核查**。猜想式的重试
 *    在渗透场景里等于未经授权地再打一次目标。
 *
 * 2. **过期凭证不复活**（§15.2）。崩溃跨越了放行凭证的有效期时，凭证不能因为
 *    「会话恢复了」就重新可用——那是把过期授权当成有效授权。
 *
 * 3. **利用验证与后渗透的恢复必须人类重新确认**（§15.2）。这两个阶段可能已经
 *    在目标上留下了东西；在状态未知的旧会话上继续攻击是不可接受的。默认创建
 *    新会话，旧会话标为需要人工处置。
 */

import type { Phase, SessionStatus } from '../contracts.ts';
import type { DbClient } from '../db/port.ts';

/**
 * 恢复建议。**只描述结论与所需的人类决定，不执行任何动作**——
 * 恢复动作由工作流服务在人类确认后执行（本模块是纯判定层，便于测试与审计）。
 */
type RecoveryAction =
  /** 会话行停在 starting：dsh 会话可能建了也可能没建，需人工核对后处置。 */
  | { readonly kind: 'mark_interrupted'; readonly reason: string }
  /** 会话存活且可继续：仅对账，不改状态。 */
  | { readonly kind: 'resume'; readonly reason: string }
  /** 陈旧会话：标记为被取代，需人类重新开始。 */
  | { readonly kind: 'supersede'; readonly reason: string }
  /** 高危阶段的未知状态：**必须**人类重新确认，不自动继续。 */
  | { readonly kind: 'requires_human_reconfirmation'; readonly reason: string };

/** 一个会话行的对账输入。 */
export interface SessionReconciliationInput {
  readonly workerSessionId: string;
  readonly dshSessionId: string;
  readonly phase: Phase;
  readonly status: SessionStatus;
  readonly attempt: number;
  /** 该会话是否有未吊销租约。 */
  readonly hasActiveLease: boolean;
  /** 租约是否已过期（`expiresAt < now`）。 */
  readonly leaseExpired: boolean;
  /** dsh 侧是否仍能触达该会话（由适配器探测，不在本层做 I/O）。 */
  readonly dshSessionReachable: boolean;
  /** 会话是否有未结束的工具执行（`status='running'` 且无结果）。 */
  readonly hasUnfinishedToolRuns: boolean;
  readonly startedAt: string | null;
}

export interface SessionReconciliation {
  readonly workerSessionId: string;
  readonly action: RecoveryAction;
  /** 需要人类处置才能继续。 */
  readonly blocksProgress: boolean;
}

/**
 * 高危阶段：崩溃恢复必须由人类重新确认（§15.2）。
 *
 * 只含利用验证与后渗透。情报收集与威胁建模是只读或纯分析，崩溃后重跑不改变
 * 目标状态；漏洞分析同样不执行利用。而这两个阶段**可能已经在目标上留下了东西**，
 * 在状态未知的旧会话上继续是不可接受的。
 */
export const HIGH_RISK_PHASES: readonly Phase[] = ['exploitation', 'post-exploitation'];

export function isHighRiskPhase(phase: Phase): boolean {
  return HIGH_RISK_PHASES.includes(phase);
}

/**
 * 对账单个会话。**纯函数**：所有探测结果由调用方注入。
 */
export function reconcileSession(input: SessionReconciliationInput): SessionReconciliation {
  // ── 1. 停在 starting：创建窗口内崩溃 ──
  //
  // **无论有没有未结算的工具执行，这一步都要把会话判为已中断**。会话从没创建
  // 成功，它就是死的；留着它不动正是本模块要消除的「半空状态」——库里有一条
  // 行、没有东西在跑、系统也不认为它失败了。
  //
  // 未结算的工具执行是**另一个独立问题**（副作用未知），由工具执行自己的规则
  // 处理：标记为 `unknown` 并阻塞 engagement（§15.2「必须人工核查」）。
  // 两件事分开处置，比让一个信号掩盖另一个信号清楚。
  if (input.status === 'starting') {
    const detail = input.dshSessionReachable
      ? 'dsh 侧会话存在，但库里的回写未完成'
      : 'dsh 侧会话不存在，创建未完成';
    return {
      workerSessionId: input.workerSessionId,
      action: {
        kind: 'mark_interrupted',
        reason:
          `会话停在 starting（${detail}）；按已中断对账，不假装已完成` +
          (input.hasUnfinishedToolRuns
            ? '。**注意**：该会话下存在未结算的工具执行，其副作用是否已作用于目标未知，需人工核查'
            : ''),
      },
      blocksProgress: true,
    };
  }

  // ── 2. 高危阶段的存活会话：必须人类重新确认 ──
  if (isHighRiskPhase(input.phase) && (input.status === 'active' || input.status === 'blocked')) {
    return {
      workerSessionId: input.workerSessionId,
      action: {
        kind: 'requires_human_reconfirmation',
        reason:
          `阶段 ${input.phase} 可能在目标上留下痕迹；崩溃恢复不得在状态未知的旧会话上继续，` +
          `需人类确认是继续、清理还是重新开始`,
      },
      blocksProgress: true,
    };
  }

  // ── 4. 等待人工判断的会话：崩溃不影响它（它本来就在等人） ──
  //
  // 但若有未结束的工具执行，**必须在理由里点明**——人类马上就要看这份报告，
  // 这是告知未知副作用的最佳时机。不阻塞（他本来就要决策），但也不静默隐藏。
  if (input.status === 'waiting_human') {
    return {
      workerSessionId: input.workerSessionId,
      action: {
        kind: 'resume',
        reason: input.hasUnfinishedToolRuns
          ? '会话在等待人工判断，崩溃不改变该状态；但**存在已受理而没有结束事件的工具执行**，' +
            '副作用未知，请人工核查后再决策（§15.2 不自动重放）'
          : '会话在等待人工判断，崩溃不改变该状态；人类可照常决策',
      },
      blocksProgress: false,
    };
  }

  // ── 5. 未结束的工具执行：人工核查，不自动重放（§15.2） ──
  if (input.hasUnfinishedToolRuns) {
    return {
      workerSessionId: input.workerSessionId,
      action: {
        kind: 'requires_human_reconfirmation',
        reason:
          '存在已受理但没有结束事件的工具执行；副作用未知。' +
          '按 §15.2 标记为 interrupted/unknown 并交人工核查，不自动重放有副作用的动作',
      },
      blocksProgress: true,
    };
  }

  // ── 5. dsh 侧不可达：会话实际不存在 ──
  //
  // **这一条必须排在租约过期之前**。理由是 §15.2 的恢复路径本身：
  // 第一句就是「dsh 会恢复顶层会话」——会话对象仍在，而它的租约很可能早已过期
  // （进程重启 + 租约 TTL 600 秒）。若让租约过期先胜出，恢复会把一个 dsh 刚刚
  // 恢复好、本可继续使用的会话判为已中断，等于**把正常的恢复路径变成终止**。
  //
  // 两条信号的语义要分清：
  //   - 租约过期 → 影响的是**放行凭证**（它们不能再被用），不是会话的可用性；
  //   - dsh 侧不可达 → 才是「这个会话真的没了」。
  if (!input.dshSessionReachable) {
    return {
      workerSessionId: input.workerSessionId,
      action: {
        kind: 'mark_interrupted',
        reason: 'dsh 侧会话不可达；库里有记录但实际不存在，按已中断对账',
      },
      blocksProgress: true,
    };
  }

  // ── 6. 租约过期：会话可能仍可用，但放行凭证已失效（§15.2「过期凭证不复活」） ──
  //
  // 这里**不自动续签租约**：续签就等于让过期凭证复活，而那正是 §15.2 禁止的。
  // 会话保持存活、交人决定（重做 / 切换 / 显式重新签发），因此本结论
  // 只报告事实、不阻塞推进——它是一个常规决策点，不是安全闸门。
  if (input.leaseExpired) {
    return {
      workerSessionId: input.workerSessionId,
      action: {
        kind: 'resume',
        reason:
          '会话存活且 dsh 侧可达，但其租约已过期：该会话的**放行凭证已一并失效**（§15.2 过期凭证不复活）。' +
          '会话本身可继续使用，但任何需要放行的动作都必须重新申请——请人工决定是重做、切换还是显式重新签发',
      },
      blocksProgress: false,
    };
  }

  // ── 7. 存活且可达：可以继续 ──
  return {
    workerSessionId: input.workerSessionId,
    action: { kind: 'resume', reason: '会话存活且 dsh 侧可达，状态一致' },
    blocksProgress: false,
  };
}

/** 对整个 engagement 的对账结论。 */
export interface EngagementReconciliation {
  readonly engagementId: string;
  readonly sessions: readonly SessionReconciliation[];
  /** 任一结论需要人工处置即阻塞推进——人类不确认就不放行下一步。 */
  readonly blocksProgress: boolean;
  readonly requiresHumanReconfirmation: readonly string[];
}

export function reconcileEngagement(
  engagementId: string,
  sessions: readonly SessionReconciliationInput[],
): EngagementReconciliation {
  const results = sessions.map(reconcileSession);
  const reconfirm = results
    .filter((r) => r.action.kind === 'requires_human_reconfirmation')
    .map((r) => r.workerSessionId);
  return {
    engagementId,
    sessions: results,
    blocksProgress: results.some((r) => r.blocksProgress),
    requiresHumanReconfirmation: reconfirm,
  };
}

// ───────────────────────────── 放行凭证对账 ─────────────────────────────

export interface ApprovalReconciliationInput {
  readonly approvalId: string;
  readonly decision: 'pending' | 'approved' | 'rejected' | 'revoked' | 'expired' | 'superseded';
  readonly consumedAt: string | null;
  readonly expiresAt: string | null;
  /** 租约是否仍有效（吊销与否）。 */
  readonly leaseActive: boolean;
  /** now 注入以便测试。 */
  readonly now: string;
}

type ApprovalReconciliationAction =
  /** 仍可用。 */
  | { readonly kind: 'keep' }
  /** 已过期 → 标记 expired（不复活）。 */
  | { readonly kind: 'expire'; readonly reason: string }
  /** 租约已失效 → 吊销（其下凭证一并失效，§10.6）。 */
  | { readonly kind: 'revoke'; readonly reason: string }
  /** 已被消费 → 保持不动（幂等重放靠它，§15.3）。 */
  | { readonly kind: 'already_consumed' };

/**
 * 对账一条放行凭证。
 *
 * 顺序是刻意的：**先看是否已消费**（那是终态，不用管别的），再看租约，
 * 最后看过期——因为租约吊销的语义强于「还没过期」。
 */
export function reconcileApproval(input: ApprovalReconciliationInput): ApprovalReconciliationAction {
  if (input.consumedAt !== null) {
    return { kind: 'already_consumed' };
  }
  if (!input.leaseActive) {
    return {
      kind: 'revoke',
      reason: '其所属会话的租约已失效；租约吊销时其下放行凭证一并失效（§10.6）',
    };
  }
  if (input.expiresAt !== null && Date.parse(input.expiresAt) <= Date.parse(input.now)) {
    return {
      kind: 'expire',
      reason: '凭证已过期；按 §15.2「过期凭证不复活」，不得因会话恢复而重新可用',
    };
  }
  return { kind: 'keep' };
}

// ───────────────────────────── 数据库可用性判定 ─────────────────────

/**
 * 数据库不可用时的门槛（§15.1）。
 *
 * 文档原话：**所有触及目标的动作一律停止**（不按风险分类挑拣——分类准确度
 * 不足以支撑"只停高风险"的降级）。因此这条判定不看动作类别。
 */
interface AuditAvailability {
  readonly writable: boolean;
  readonly detail: string;
}

export function executionGateForAudit(availability: AuditAvailability): { allowed: boolean; reason: string } {
  if (!availability.writable) {
    return {
      allowed: false,
      reason:
        `审计写入不可用（${availability.detail}）：按 §15.1 所有触及目标的动作一律停止。` +
        `不按风险分类挑拣——分类准确度不足以支撑"只停高风险"的降级`,
    };
  }
  return { allowed: true, reason: '审计可写' };
}

// ───────────────────────────── 数据库读取 ─────────────────────

/**
 * 收集对账输入：从数据库读出一个 engagement 的所有会话，供对账使用。
 *
 * 把「读库」与「探测」分开注入：探测会触碰 dsh 运行时，而读库只是 SQL。
 * 这样对账逻辑本身（上面的纯函数）可以在没有 dsh 的环境里被完整测试。
 */
export async function collectReconciliationInputs(
  db: DbClient,
  engagementId: string,
  probe: (dshSessionId: string) => Promise<boolean>,
  now: Date,
): Promise<readonly SessionReconciliationInput[]> {
  const rows = await db.query<{
    id: string;
    dsh_session_id: string;
    phase: Phase;
    status: SessionStatus;
    attempt: number | string;
    lease_expires_at: string | null;
    lease_revoked_at: string | null;
    unfinished_tool_runs: number | string;
  }>(
    `select s.id, s.dsh_session_id, s.phase, s.status, s.attempt,
            l.expires_at as lease_expires_at,
            l.revoked_at as lease_revoked_at,
            (select count(*) from pentest.tool_runs t
              where t.worker_session_id = s.id and t.status = 'running') as unfinished_tool_runs
       from pentest.worker_sessions s
       left join pentest.session_leases l
              on l.worker_session_id = s.id and l.revoked_at is null
      where s.engagement_id = $1::uuid
      order by s.created_at`,
    [engagementId],
  );

  const out: SessionReconciliationInput[] = [];
  for (const r of rows.rows) {
    out.push({
      workerSessionId: r.id,
      dshSessionId: r.dsh_session_id,
      phase: r.phase,
      status: r.status,
      attempt: Number(r.attempt),
      hasActiveLease: r.lease_revoked_at === null && r.lease_expires_at !== null,
      leaseExpired: r.lease_expires_at !== null && Date.parse(r.lease_expires_at) <= now.getTime(),
      dshSessionReachable: await probe(r.dsh_session_id),
      hasUnfinishedToolRuns: Number(r.unfinished_tool_runs) > 0,
      startedAt: null,
    });
  }
  return out;
}
