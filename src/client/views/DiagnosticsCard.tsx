/**
 * 运行诊断卡（§15.5/§15.1）：总览页上的只读快照。
 *
 * ── 它回答的问题 ──
 *
 * 「卡住」有很多种形态：审计写不进去（闸门停摆）、索引队列积压/死信、
 * 连接池耗尽、水位滞后。每种形态的处置完全不同，而此前只能翻日志与手写 SQL。
 *
 * ── 三条状态纪律（P16）──
 *
 * - 「尚未读取」「读取失败」「读到了」三者分开：空卡片说的是「还没点刷新」，
 *   错误条说的是「这次没读到」——都不代表系统是健康的。
 * - 审计探针为 `null`（未装配）不等于「可写」。
 * - 未选作业时作业级字段整块不显示，并说明原因（不是显示 0）。
 *
 * 纯展示组件：不发请求、不订阅控制器（刷新由调用方接线）。
 */

import type { ReactNode } from 'react';
import type { DiagnosticsSnapshot } from '../../contracts.ts';
import { Button, Card, Empty, ErrorBar, Stat } from '../ui.tsx';
import { formatCount, formatTimestamp } from '../format.ts';

export interface DiagnosticsCardProps {
  /** null = 尚未成功读取（与「读到了空数据」是两件事）。 */
  readonly diagnostics: DiagnosticsSnapshot | null;
  readonly error?: { readonly code: string; readonly message: string } | null;
  readonly onRefresh?: () => void;
  readonly now?: Date;
}

export function DiagnosticsCard(props: DiagnosticsCardProps): ReactNode {
  const snapshot = props.diagnostics;
  return (
    <Card title="运行诊断（§15.5）">
      <div className="pentest-diagnostics__actions">
        <Button
          label="刷新诊断"
          disabled={props.onRefresh === undefined}
          reason={props.onRefresh === undefined ? '本部署未接线诊断端点' : undefined}
          onClick={() => {
            props.onRefresh?.();
          }}
        />
        {snapshot === null ? null : (
          <span className="pentest-diagnostics__note">{`读取于 ${formatTimestamp(snapshot.checkedAt, props.now)}`}</span>
        )}
      </div>

      {props.error === null || props.error === undefined ? null : (
        <ErrorBar code={props.error.code} message={props.error.message} />
      )}

      {snapshot === null ? (
        <Empty
          title="尚未读取诊断"
          reason="点「刷新诊断」读取连接池、审计探针、索引队列与水位。这里显示不出来不代表系统是健康的（P16）。"
        />
      ) : (
        <>
          <div className="pentest-diagnostics__grid">
            <Stat
              label="连接池"
              value={`总 ${formatCount(snapshot.pool.total)} / 空闲 ${formatCount(snapshot.pool.idle)} / 等待 ${formatCount(snapshot.pool.waiting)}`}
              tone={snapshot.pool.waiting > 0 ? 'attention' : 'neutral'}
              hint="读写共用；「等待」大于 0 说明池已耗尽，动作会在取连接处排队"
            />
            <Stat
              label="审计写入"
              value={snapshot.audit === null ? '未装配探针' : snapshot.audit.writable ? '可写' : '不可用'}
              tone={snapshot.audit === null ? 'neutral' : snapshot.audit.writable ? 'done' : 'danger'}
              hint={snapshot.audit === null
                ? '本实例未提供审计探针：这不是「通过」，是「无从判断」'
                : snapshot.audit.detail === ''
                  ? '走真实审计写路径探测通过（§15.1 的闸门依据）'
                  : snapshot.audit.detail}
            />
          </div>

          {snapshot.engagement === null ? (
            <p className="pentest-diagnostics__note">
              未选中作业：索引队列与水位不可见（它们按 engagement 取值）。选中一个作业后刷新即可。
            </p>
          ) : (
            <div className="pentest-diagnostics__grid">
              <Stat
                label="索引队列（§15.5）"
                value={
                  `待办 ${formatCount(snapshot.engagement.indexQueue.pending)} / ` +
                  `租约 ${formatCount(snapshot.engagement.indexQueue.leased)} / ` +
                  `完成 ${formatCount(snapshot.engagement.indexQueue.done)} / ` +
                  `死信 ${formatCount(snapshot.engagement.indexQueue.dead)}`
                }
                tone={
                  snapshot.engagement.indexQueue.dead > 0
                    ? 'danger'
                    : snapshot.engagement.indexQueue.lagState === 'ready'
                      ? 'done'
                      : 'attention'
                }
                hint={
                  snapshot.engagement.indexQueue.oldestPendingAt === null
                    ? '队列为空'
                    : `最早可领取：${formatTimestamp(snapshot.engagement.indexQueue.oldestPendingAt, props.now)}`
                }
              />
              <Stat
                label="索引水位（§8.4）"
                value={`链序 ${formatCount(snapshot.engagement.watermark.lastChainSeq)}`}
                tone={snapshot.engagement.watermark.lagEvents === 0 ? 'done' : 'attention'}
                hint={
                  `滞后 ${formatCount(snapshot.engagement.watermark.lagEvents)} 条；` +
                  '原始账本是唯一事实源，索引是可重建的派生数据'
                }
              />
            </div>
          )}
        </>
      )}
    </Card>
  );
}
