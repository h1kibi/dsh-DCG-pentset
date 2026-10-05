/**
 * 启动对账的**执行者**：把 `reconcile.ts` 的纯判定落到数据库上。
 *
 * 设计依据：docs/dsh-pentest-plugin-design.md §15.2（dsh 进程崩溃）、
 * §15.1（数据库不可用）、§12.1（单进程运维契约）、§10.6（租约）
 *
 * ── 为什么需要它 ──
 *
 * `reconcile.ts` 只产出结论（「该标记为已中断」「该人类重新确认」），
 * 它**不执行任何动作**——那是刻意的分层。但结论若无人应用，崩溃残留就永远
 * 停在那里：库里有一条 `status='starting'` 的行，没有东西在跑，系统也不认为
 * 它失败了。本模块是那句话的执行者：「按**已中断**对账，不假装已完成」。
 *
 * ── 谁该做恢复：用租约判定，不用猜测 ──
 *
 * 多实例部署下必须能区分「我自己崩溃留下的残留」与「另一个实例正在正常驱动」。
 * 判据是**租约**：§10.6 里租约就是「我活着」的信号。租约已过期或不存在 =
 * 无主，可以恢复；租约有效 = 别人在管，**一律不碰**。
 *
 * 外加一条针对 `starting` 的年龄判据：创建会话是秒级动作，若某行在 `starting`
 * 停留超过 {@link STALE_CREATION_SECONDS}，说明当时那步没走完。这条用来避免
 * 「另一实例正在创建中」被误判为残留——它也是唯一需要猜的地方，因此阈值取得
 * 宽松（默认为创建耗时的数十倍）。
 *
 * ── 三条纪律 ──
 *
 * 1. **不自动重放有副作用的动作**（§15.2）。已受理但没有结束事件的工具执行
 *    标记为 `unknown`——我们**不知道**目标是否收到了那次动作。`unknown` 是终态，
 *    因此不会有人自动重试它。这与「标记为 interrupted 后重跑」是完全不同的处置。
 *
 * 2. **高危阶段的未知状态交人类**（§15.2）。利用验证与后渗透可能已经在目标上
 *    留下痕迹；本模块只把 engagement 置为 blocked 并记事件，**不动会话**——
 *    让它保持原状态，人类在控制台看着它做决定。
 *
 * 3. **幂等**。恢复动作把行推进到终态（`failed`/`superseded`）或终态集合
 *    （`unknown`），因此第二次跑不会重复动作；同时每个动作都写入带幂等键的
 *    审计事件，链上不会出现重复条目。
 */

import type { DbClient } from '../memory/ledger.ts';
import { transactionRunnerFor } from '../memory/ledger.ts';
import type { MemoryLedgerService } from '../contracts.ts';
import { describeError } from '../contracts.ts';
import type { LeaseStore } from './lease.ts';
import { revokeLease } from './lease.ts';
import type { SessionReconciliationInput, SessionReconciliation } from './reconcile.ts';
import { reconcileSession, isHighRiskPhase } from './reconcile.ts';
import type { Phase, SessionStatus } from '../contracts.ts';

/**
 * `starting` 停留超过这个秒数即视为残留。
 *
 * 为什么需要它：创建 dsh 会话是秒级动作，若一行在 `starting` 停留远超这个时长，
 * 说明当时那步没走完。取 120 秒是因为它远大于创建耗时（数十倍），
 * 宁可晚一点恢复一个真残留，也不要打断另一个实例正在进行的创建。
 */
export const STALE_CREATION_SECONDS = 120;

/**
 * 工具执行的「可能仍在跑」宽限期（秒）。
 *
 * 沙箱单次执行上限是 15 分钟（§10.4 的 `maxWallClockMs`）。超过该上限仍未结算的
 * 执行不可能是活的；本模块据此把 `running` 判为遗留。取 16 分钟留一分钟余量。
 */
export const STALE_TOOL_RUN_SECONDS = 16 * 60;

export interface RecoveryDeps {
  readonly db: DbClient;
  readonly txDb?: DbClient;
  readonly leases: LeaseStore;
  readonly ledger?: MemoryLedgerService;
  readonly clock?: () => Date;
  readonly onRecovered?: (event: RecoveryEvent) => void;
  /**
   * 探测会话可达性的钩子。省略即视为不可达。
   *
   * 用于区分「进程崩了但 dsh 会话还活着」（可续）与「连会话都没了」（须重做）。
   */
  readonly probeDshSession?: (dshSessionId: string) => Promise<boolean>;
  /**
   * RLS 作用域。
   *
   * **必须有**：`findUnownedSessions` 读的是 `worker_sessions` 与 `session_leases`，
   * 两张表在 015 之后没有任何租户级放行。没有作用域时它返回**零行**——启动对账会
   * 静默什么都不做，而那不是「没有残留」，是「没看」。
   */
  readonly rlsScope?: {
    run<T>(
      scope: { readonly engagementId?: string | null; readonly workerSessionId?: string | null },
      work: () => Promise<T>,
    ): Promise<T>;
    /** 在**租户级**作用域里列出本租户的全部作业。 */
    listEngagementIds: () => Promise<readonly string[]>;
  };
}

export interface RecoveryEvent {
  readonly engagementId: string;
  readonly workerSessionId: string;
  readonly action: SessionReconciliation['action']['kind'];
  readonly detail: string;
}

export interface RecoveryReport {
  readonly engagements: readonly string[];
  readonly sessionsMarkedInterrupted: readonly string[];
  readonly sessionsSuperseded: readonly string[];
  readonly toolRunsMarkedUnknown: readonly string[];
  readonly engagementsBlocked: readonly string[];
  readonly needsHumanReconfirmation: readonly {
    readonly engagementId: string;
    readonly workerSessionId: string;
    readonly reason: string;
    readonly phase: Phase;
  }[];
  readonly errors: readonly { readonly engagementId: string; readonly message: string }[];
}

/** 一行待恢复的存活会话。 */
interface StaleSessionRow {
  readonly worker_session_id: string;
  readonly engagement_id: string;
  readonly dsh_session_id: string;
  readonly phase: Phase;
  readonly status: SessionStatus;
  readonly attempt: number | string;
  readonly dsh_session_reachable: boolean;
  readonly unfinished_tool_runs: number | string;
}

export class StartupRecovery {
  readonly #db: DbClient;
  readonly #txDb: DbClient;
  readonly #leases: LeaseStore;
  readonly #ledger: MemoryLedgerService | undefined;
  readonly #probe: (dshSessionId: string) => Promise<boolean>;
  readonly #clock: () => Date;
  readonly #onRecovered: RecoveryDeps['onRecovered'];
  readonly #rlsScope: RecoveryDeps['rlsScope'];

  constructor(deps: RecoveryDeps) {
    this.#db = deps.db;
    this.#txDb = deps.txDb ?? deps.db;
    this.#leases = deps.leases;
    this.#ledger = deps.ledger;
    this.#probe = deps.probeDshSession ?? (async () => false);
    this.#clock = deps.clock ?? (() => new Date());
    this.#onRecovered = deps.onRecovered;
    this.#rlsScope = deps.rlsScope;
  }

  /**
   * 找出**无主**的存活会话（= 需要恢复的那些）。
   *
   * 「无主」的定义（见文件头）：
   *   - 会话处于存活态，且
   *   - 其未吊销租约已过期，或根本没有未吊销租约（不该发生，按孤儿处理），
   *     或它是超龄的 `starting` 行
   *
   * **租约有效的一律排除**——那表示另一个实例正在驱动它。
   *
   * ── 为什么要逐作业扫描 ──
   *
   * 这条查询在 015 之后**跨不了 engagement**：`worker_sessions` 与 `session_leases`
   * 只按当前 engagement 放行。旧实现直接全库跑一次，在租户级作用域下会返回零行——
   * 那种「什么都没找到」与「确实没有残留」在报告里长得一样，是最坏的一种静默失败。
   *
   * 因此先在租户级列出作业，再**逐作业在其作用域内**跑同一条查询。代价是 N 次查询
   * （作业数是人的工作项，量级很小），换来的是每个作业的判定与它的真实边界一致。
   */
  async findUnownedSessions(limit = 200): Promise<readonly StaleSessionRow[]> {
    const scopes = this.#rlsScope;
    if (scopes === undefined) return this.#scanUnowned(limit);
    const engagementIds = await scopes.listEngagementIds();
    const found: StaleSessionRow[] = [];
    for (const engagementId of engagementIds) {
      if (found.length >= limit) break;
      const rows = await scopes.run({ engagementId }, () => this.#scanUnowned(limit - found.length));
      found.push(...rows);
    }
    return found;
  }

  /** 单个作业内的无主会话扫描；调用方负责给出正确作用域。 */
  async #scanUnowned(limit: number): Promise<readonly StaleSessionRow[]> {
    const now = this.#clock().toISOString();
    const r = await this.#db.query<StaleSessionRow>(
      `select s.id   as worker_session_id,
              s.engagement_id,
              s.dsh_session_id,
              s.phase,
              s.status,
              s.attempt,
              (select count(*) from pentest.tool_runs t
                where t.worker_session_id = s.id and t.status = 'running') as unfinished_tool_runs
         from pentest.worker_sessions s
         left join pentest.session_leases l
                on l.worker_session_id = s.id and l.revoked_at is null
        where s.status in ('starting','active','waiting_human','handoff_drafting',
                           'transition_confirmation','paused','blocked')
          and (
            -- 无主：没有未吊销租约
            (l.id is null and s.status <> 'starting')
            -- 无主：租约已过期
            or (l.id is not null and l.expires_at <= $1::timestamptz)
            -- 超龄的创建窗口：那一刻没走完
            or (s.status = 'starting' and s.created_at <= ($1::timestamptz - make_interval(secs => $2)))
          )
        order by s.created_at
        limit $3`,
      [now, STALE_CREATION_SECONDS, limit],
    );
    return r.rows;
  }

  /** 对待恢复的会话补齐探测结果，转成对账输入。 */
  async #collect(rows: readonly StaleSessionRow[]): Promise<readonly SessionReconciliationInput[]> {
    const out: SessionReconciliationInput[] = [];
    for (const row of rows) {
      out.push({
        workerSessionId: row.worker_session_id,
        dshSessionId: row.dsh_session_id,
        phase: row.phase,
        status: row.status,
        attempt: Number(row.attempt),
        // 这两项由查询的 WHERE 已经确定：走到这一步的会话必然无有效租约
        // （要么租约过期、要么根本没有，要么是超龄的 starting 行）。
        // 因此在这里如实置为「无有效租约」，而不是再查一遍。
        hasActiveLease: false,
        leaseExpired: true,
        dshSessionReachable: await this.#probe(row.dsh_session_id),
        hasUnfinishedToolRuns: Number(row.unfinished_tool_runs) > 0,
        startedAt: null,
      });
    }
    return out;
  }

  /**
   * 恢复一个 engagement：找出无主会话 → 判定 → 应用动作。
   *
   * 返回本轮的恢复明细。单个会话的动作失败**不中断整体**——一个坏行不该
   * 让其余残留继续悬着；错误逐条记入报告。
   */
  async recoverEngagement(engagementId: string): Promise<RecoveryReport> {
    const scopes = this.#rlsScope;
    // 只扫这一个作业：`findUnownedSessions` 会遍历全部作业，在这里是纯浪费，
    // 而且它返回的是别的作业的行——过滤掉之后仍然多做了 N 次查询。
    if (scopes === undefined) {
      const rows = (await this.#scanUnowned(200)).filter((r) => r.engagement_id === engagementId);
      return this.#recoverGroup(rows);
    }
    const rows = await scopes.run({ engagementId }, () => this.#scanUnowned(200));
    return this.#recoverGroup(rows);
  }

  /**
   * 扫描并恢复所有需要处理的 engagement。
   *
   * 供启动时调用一次（§15.2），也可由控制台或定期任务调用以清理运行期残留。
   */
  async recoverAll(limit = 200): Promise<RecoveryReport> {
    const rows = await this.findUnownedSessions(limit);
    return this.#recover(rows);
  }

  /**
   * 把本批待恢复的会话**按作业分组**，逐个作业在其作用域内恢复。
   *
   * ── 为什么必须分组、而不能一次全做 ──
   *
   * 恢复的每一步都是写：标记会话中断/取代、`tool_runs` 置 unknown、阻塞作业、写审计。
   * 这些表都没有租户级放行，而**写路径没有「查不到就报错」这回事**——RLS 过滤掉的行
   * 让 `UPDATE ... WHERE id = X` 静默影响 0 行，函数照常返回。
   * 也就是说，作用域给错时恢复会是**完全静默的空转**：报告显示「无残留」，
   * 而残留原封不动。分组是让每一步都落在它自己那个作业的边界内。
   *
   * 单个会话失败不中断整体：一个坏行不该让其余残留继续悬着（与改动前一致）。
   */
  async #recover(rows: readonly StaleSessionRow[]): Promise<RecoveryReport> {
    const scopes = this.#rlsScope;
    if (scopes === undefined) return this.#recoverGroup(rows);

    const byEngagement = new Map<string, StaleSessionRow[]>();
    for (const row of rows) {
      const bucket = byEngagement.get(row.engagement_id);
      if (bucket === undefined) byEngagement.set(row.engagement_id, [row]);
      else bucket.push(row);
    }

    const engagements: string[] = [];
    const sessionsMarkedInterrupted: string[] = [];
    const sessionsSuperseded: string[] = [];
    const toolRunsMarkedUnknown: string[] = [];
    const engagementsBlocked: string[] = [];
    const needsHumanReconfirmation: RecoveryReport['needsHumanReconfirmation'][number][] = [];
    const errors: { engagementId: string; message: string }[] = [];
    for (const [engagementId, group] of byEngagement) {
      const report = await scopes.run(
        { engagementId },
        () => this.#recoverGroup(group),
      );
      engagements.push(...report.engagements);
      sessionsMarkedInterrupted.push(...report.sessionsMarkedInterrupted);
      sessionsSuperseded.push(...report.sessionsSuperseded);
      toolRunsMarkedUnknown.push(...report.toolRunsMarkedUnknown);
      engagementsBlocked.push(...report.engagementsBlocked);
      needsHumanReconfirmation.push(...report.needsHumanReconfirmation);
      errors.push(...report.errors);
    }
    return {
      engagements,
      sessionsMarkedInterrupted,
      sessionsSuperseded,
      toolRunsMarkedUnknown,
      engagementsBlocked,
      needsHumanReconfirmation,
      errors,
    };
  }

  /** 恢复**同一作业内**的一组会话；调用方负责给出该作业的作用域。 */
  async #recoverGroup(rows: readonly StaleSessionRow[]): Promise<RecoveryReport> {
    const inputs = await this.#collect(rows);
    const byId = new Map(rows.map((r) => [r.worker_session_id, r]));

    const engagements = new Set<string>();
    const interrupted: string[] = [];
    const superseded: string[] = [];
    const toolRunsUnknown: string[] = [];
    const blocked: string[] = [];
    const needsHuman: RecoveryReport['needsHumanReconfirmation'][number][] = [];
    const errors: { engagementId: string; message: string }[] = [];

    // 先把本批涉及的 engagement 里的遗留工具执行标记为 unknown。
    // 这一步与逐会话动作分开：工具执行属于会话，但它的终态（unknown）
    // 独立于会话状态，且必须在会话被判「已中断」前后都保持一致。
    for (const engagementId of new Set(rows.map((r) => r.engagement_id))) {
      try {
        const marked = await this.#markStaleToolRunsUnknown(engagementId);
        toolRunsUnknown.push(...marked);
        if (marked.length > 0) {
          await this.#audit(engagementId, null, 'tool.run.marked_unknown', {
            toolRunIds: marked,
            reason: `进程重启后存在未结算的工具执行；其副作用是否已作用于目标未知（§15.2）`,
          });
          // **有未知副作用即阻塞**：§15.2 要求「必须人工核查」。自动重放不行
          // （不知道目标是否已收到），继续推进也不行（可能在未知状态下叠加动作）。
          await this.#blockEngagement(
            engagementId,
            `存在 ${String(marked.length)} 次未结算的工具执行，其副作用是否已作用于目标未知，需人工核查`,
          );
          blocked.push(engagementId);
        }
      } catch (error) {
        errors.push({ engagementId, message: describeError(error) });
      }
    }

    for (const input of inputs) {
      const row = byId.get(input.workerSessionId);
      if (row === undefined) continue;
      engagements.add(row.engagement_id);

      const verdict = reconcileSession(input);
      try {
        switch (verdict.action.kind) {
          case 'resume':
            // 无需动作：会话存活且可达，或它在等待人工判断（本来就该等人）
            break;

          case 'mark_interrupted': {
            await this.#markSessionInterrupted(row, verdict.action.reason);
            interrupted.push(input.workerSessionId);
            break;
          }

          case 'supersede': {
            await this.#markSessionSuperseded(row, verdict.action.reason);
            superseded.push(input.workerSessionId);
            break;
          }

          case 'requires_human_reconfirmation': {
            // **不动会话**：它在状态未知的情况下被继续驱动是危险的；保持原样，
            // 让人类在控制台看着它决定。只把 engagement 置为阻塞并记事件。
            await this.#blockEngagement(row.engagement_id, verdict.action.reason);
            blocked.push(row.engagement_id);
            needsHuman.push({
              engagementId: row.engagement_id,
              workerSessionId: input.workerSessionId,
              reason: verdict.action.reason,
              phase: row.phase,
            });
            break;
          }
        }

        this.#onRecovered?.({
          engagementId: row.engagement_id,
          workerSessionId: input.workerSessionId,
          action: verdict.action.kind,
          detail: verdict.action.reason,
        });
      } catch (error) {
        errors.push({ engagementId: row.engagement_id, message: describeError(error) });
      }
    }

    return {
      engagements: [...engagements].sort(),
      sessionsMarkedInterrupted: interrupted,
      sessionsSuperseded: superseded,
      toolRunsMarkedUnknown: toolRunsUnknown,
      engagementsBlocked: [...new Set(blocked)].sort(),
      needsHumanReconfirmation: needsHuman,
      errors,
    };
  }

  /**
   * 在**一个事务**里执行一次写入。
   *
   * ── 为什么不直接 `this.#txDb.query(...)` ──
   *
   * 共享写连接上的 RLS 上下文是**事务级**的：`pentest.set_rls_context` 内部用
   * `set_config(..., is_local => true)`，而上下文的注入点在 BEGIN（见 compose 的
   * `txClientWithRlsContext`）。
   *
   * 因此一条**裸** `update` 落在事务外时没有任何上下文，RLS 会把它过滤掉——
   * 而写路径不会因为 0 行而报错，函数照常返回。结果是恢复动作**完全静默地什么都没做**，
   * 报告里却写着「已中断 1 个会话」。这个探针实测到了：`recovered_interrupted: 1`
   * 而库里那行仍是 `active`。
   *
   * 走事务运行器同时拿到两件事：正确的上下文，以及「要么整个动作成立、要么整个不成立」。
   */
  async #write<T>(work: (tx: DbClient) => Promise<T>): Promise<T> {
    return transactionRunnerFor(this.#txDb).run(work);
  }

  /**
   * 把超龄仍未结算的工具执行标记为 `unknown`。
   *
   * `running → unknown` 是 002 触发器允许的边，且 `unknown` 在终态集合里，
   * 因此这一步不可能被重复执行、也不可能有人自动重试它。
   *
   * **为什么是 `unknown` 而不是 `failed`**：`failed` 意味着「执行了但失败了」；
   * 而这里我们**不知道**目标是否收到了那次动作。`unknown` 如实表达这一点，
   * 并触发 §15.2 要求的「必须人工核查」。
   *
   * 同时写入结算列：002 要求 `finished_at` 与进入终态在同一次 UPDATE 里。
   */
  async #markStaleToolRunsUnknown(engagementId: string): Promise<readonly string[]> {
    const r = await this.#write(async (tx) => tx.query<{ id: string }>(
      `update pentest.tool_runs
          set status = 'unknown',
              finished_at = now(),
              result_json = coalesce(result_json, '{}'::jsonb) || jsonb_build_object(
                'recovery', 'marked_unknown',
                'reason', '进程重启：该执行没有结束事件，其副作用是否已作用于目标未知'
              )
        where engagement_id = $1::uuid
          and status = 'running'
          and coalesce(started_at, now()) <= (now() - make_interval(secs => $2))
        returning id`,
      [engagementId, STALE_TOOL_RUN_SECONDS],
    ));
    return r.rows.map((x) => x.id);
  }

  /**
   * 把无主会话标记为已中断（`failed`）。
   *
   * 为什么用 `failed` 而不是别的：会话的终态集合只有 `failed/closed/superseded`
   * （002 触发器）。进程崩溃导致会话没能继续，语义上就是失败；`status_reason`
   * 里写明「已中断」这一具体原因，供人区分它与「Agent 自己报错」。
   */
  async #markSessionInterrupted(row: StaleSessionRow, reason: string): Promise<void> {
    await this.#write(async (tx) => tx.query(
      `update pentest.worker_sessions
          set status = 'failed',
              status_reason = $2,
              ended_at = now()
        where id = $1::uuid
          and status not in ('failed','closed','superseded')`,
      [row.worker_session_id, `已中断（进程重启后对账）：${reason}`],
    ));
    // 租约吊销：其下放行凭证随之失效（§10.6）。会话已终结，凭证不该复活。
    await revokeLease(this.#leases, {
      workerSessionId: row.worker_session_id,
      reason: 'failed',
      now: this.#clock(),
    });
    await this.#audit(row.engagement_id, row.worker_session_id, 'session.reconciled', {
      action: 'mark_interrupted',
      reason,
    });
  }

  /** 标记会话被取代（§15.2 的陈旧会话处置）。 */
  async #markSessionSuperseded(row: StaleSessionRow, reason: string): Promise<void> {
    await this.#write(async (tx) => tx.query(
      `update pentest.worker_sessions
          set status = 'superseded',
              status_reason = $2,
              ended_at = now()
        where id = $1::uuid
          and status not in ('failed','closed','superseded')`,
      [row.worker_session_id, `已取代（对账）：${reason}`],
    ));
    await revokeLease(this.#leases, {
      workerSessionId: row.worker_session_id,
      reason: 'superseded',
      now: this.#clock(),
    });
    await this.#audit(row.engagement_id, row.worker_session_id, 'session.reconciled', {
      action: 'supersede',
      reason,
    });
  }

  /**
   * 把 engagement 置为阻塞，等待人类处置。
   *
   * 只改运行标记（`engagements.status`），**不动主状态**——主状态如实反映
   * 「上次停在哪」，人类据此判断。这与 §5.1 的两层状态表一致。
   */
  async #blockEngagement(engagementId: string, reason: string): Promise<void> {
    await this.#write(async (tx) => tx.query(
      `update pentest.engagements
          set status = 'blocked', updated_at = now()
        where id = $1::uuid and status not in ('aborted','failed')`,
      [engagementId],
    ));
    await this.#audit(engagementId, null, 'engagement.blocked_by_recovery', { reason });
  }

  /**
   * 写审计事件。
   *
   * 幂等键由（事件类型，主体）派生（`sourceId`），因此重复恢复不会在链上
   * 留下重复条目——第二次追加会命中幂等重放。
   */
  async #audit(
    engagementId: string,
    workerSessionId: string | null,
    eventType: 'session.reconciled' | 'engagement.blocked_by_recovery' | 'tool.run.marked_unknown',
    payload: unknown,
  ): Promise<void> {
    if (this.#ledger === undefined) return;
    const subject = workerSessionId ?? engagementId;
    await this.#ledger.appendEvent({
      engagementId,
      workerSessionId,
      eventType,
      sourceSystem: 'pentest-recovery',
      sourceId: `${eventType}:${subject}`,
      sourceSeq: 1,
      occurredAt: this.#clock(),
      payload,
      rawPayload: new TextEncoder().encode(JSON.stringify(payload)),
      classification: 'engagement',
      trustLevel: 'human_decision',
    });
  }
}

/**
 * 判断一个会话是否属于高危阶段（供装配层决定是否提示人类）。
 */
export function requiresHumanReconfirmation(phase: Phase): boolean {
  return isHighRiskPhase(phase);
}
