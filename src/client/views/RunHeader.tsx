/**
 * 运行总览条：始终可见的一行关键状态。
 *
 * 设计依据：docs/dsh-pentest-plugin-design.md §6.2
 *
 * ── 为什么它必须始终可见 ──
 *
 * 人类在看 Agent 输出、翻报告、查记忆时，随时可能忘记「现在在哪个阶段、
 * 授权还有效吗、跑了几轮」。这些信息决定了**当前屏幕上的一切是否还可信**——
 * 例如授权快到期时，任何正在进行的扫描都值得重新考虑。
 *
 * ── 索引水位的必要性 ──
 *
 * §8.4 要求检索结果带索引水位，因为「可能遗漏尚未索引的事件」这件事必须让人类
 * 知道。总览条是它的自然落点：滞后量不为零时显示告警色，提醒 Agent 的报告
 * 可能建立在尚未索引的上下文之上。
 */

import type { ReactNode } from 'react';
import type { WorkflowSnapshot } from '../../contracts.ts';
import {
  formatCount,
  formatTimestamp,
  mainStatusLabel,
  phaseLabel,
  runMarkerLabel,
  runMarkerTone,
} from '../format.ts';
import { Badge, Card, ErrorBar, Stat } from '../ui.tsx';

interface RunHeaderProps {
  readonly engagementName: string;
  readonly state: WorkflowSnapshot | null;
  /** 授权到期时间（来自范围版本快照）。 */
  readonly authorizationExpiresAt?: string | null;
  /** 当前范围版本号。 */
  readonly scopeVersion?: number | null;
  /** 索引水位滞后量（未索引的事件数）。`null` 表示不可知。 */
  readonly indexLagEvents?: number | null;
  /** 最近一次失败的稳定错误码与消息。 */
  readonly lastError?: { readonly code: string; readonly message: string } | null;
  /** 版本冲突提示（§15.4）：另一个界面先提交了，界面已自动重读。 */
  readonly conflict?: boolean;
  readonly now?: Date;
}

export function RunHeader(props: RunHeaderProps): ReactNode {
  const { state } = props;

  return (
    <Card title="运行总览">
      {props.conflict === true ? (
        <ErrorBar
          code="stale_state_version"
          message="另一个界面先提交了改动；本页已重新读取最新状态，请复核后再操作。"
          tone="attention"
        />
      ) : null}
      {props.lastError === null || props.lastError === undefined ? null : (
        <ErrorBar code={props.lastError.code} message={props.lastError.message} />
      )}

      <div className="pentest-runheader">
        <Stat label="engagement" value={props.engagementName} />

        {state === null ? (
          <Stat label="状态" value="未选择" tone="neutral" hint="从 engagement 列表选择一个" />
        ) : (
          <>
            <Stat
              label="主状态"
              value={mainStatusLabel(state.mainStatus)}
              tone={state.mainStatus === 'waiting_human_review' ? 'attention' : 'active'}
              hint="状态机当前位置；‘等待你判断’表示系统已停下等你决定"
            />
            <Stat
              label="运行标记"
              value={runMarkerLabel(state.runMarker)}
              tone={runMarkerTone(state.runMarker)}
              hint="与主状态并存的运行标记：暂停/阻塞不改写主状态"
            />
            <Stat
              label="当前阶段"
              value={state.currentPhase === null ? '—' : phaseLabel(state.currentPhase)}
            />
            <Stat
              label="迭代"
              value={`第 ${formatCount(state.graphIteration)} 轮`}
              hint="每次回环（后渗透→情报收集）递增，表示攻击深度增加了一层"
            />
            <Stat
              label="状态版本"
              value={formatCount(state.stateVersion)}
              hint="乐观锁：提交时带上它，防止覆盖另一个界面的改动（§15.4）"
            />
          </>
        )}

        <Stat
          label="范围版本"
          value={props.scopeVersion === null || props.scopeVersion === undefined ? '—' : `v${String(props.scopeVersion)}`}
          hint="会话绑定范围版本；修订后新会话才用新版本（§10.2.2）"
        />

        <Stat
          label="授权到期"
          value={expiryState(props.authorizationExpiresAt) === 'invalid'
            ? '无法解析'
            : formatTimestamp(props.authorizationExpiresAt, props.now)}
          tone={
            expiryState(props.authorizationExpiresAt) === 'invalid'
              ? 'danger'
              : isExpired(props.authorizationExpiresAt, props.now) ? 'danger' : 'neutral'
          }
          hint={
            expiryState(props.authorizationExpiresAt) === 'invalid'
              ? '授权依据读不懂：执行侧会以 authorization_expired 拒绝每个目标动作，直到人类修正'
              : isExpired(props.authorizationExpiresAt, props.now)
                ? '授权已过期：不应再发起新的目标动作'
                : undefined
          }
        />

        <Stat
          label="索引水位"
          value={
            props.indexLagEvents === null || props.indexLagEvents === undefined
              ? '—'
              : props.indexLagEvents === 0
                ? '已追平'
                : `滞后 ${formatCount(props.indexLagEvents)} 条`
          }
          tone={props.indexLagEvents === null || props.indexLagEvents === undefined
            ? 'neutral'
            : props.indexLagEvents === 0 ? 'done' : 'attention'}
          hint="滞后量不为零时，Agent 可能看不到尚未索引的事件（§8.4）"
        />
      </div>

      {state === null ? null : (
        <p className="pentest-runheader__footnote">
          {state.activeWorkerSessionId === null ? (
            <Badge text="当前没有活动 Worker" tone="neutral" />
          ) : (
            <Badge
              text="有活动 Worker"
              tone="active"
              hint={`会话 ${state.activeWorkerSessionId}`}
            />
          )}
        </p>
      )}
    </Card>
  );
}

/**
 * 授权到期的三种形态。
 *
 * 判定层（`PgPolicyService.authorizationValidity`）对 `invalid` 是**拒绝**，所以界面也
 * 不能把它渲染成「—」（那是「未声明到期」的样子）——操作者会看到一个正常的总览条，
 * 而每个目标动作都在被 `authorization_expired` 拒掉，原因无处可查。
 */
function expiryState(value: string | null | undefined): 'none' | 'at' | 'invalid' {
  if (value === null || value === undefined || value === '') return 'none';
  return Number.isFinite(Date.parse(value)) ? 'at' : 'invalid';
}

/** 授权是否已过期。缺值或读不懂时按「未知」处理——是否过期由 {@link expiryState} 单独表达。 */
function isExpired(value: string | null | undefined, now?: Date): boolean {
  if (expiryState(value) !== 'at') return false;
  const ts = Date.parse(value as string);
  return ts <= (now ?? new Date()).getTime();
}
