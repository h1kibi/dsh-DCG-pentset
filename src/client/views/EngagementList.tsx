/**
 * engagement 列表：控制台首页。
 *
 * 设计依据：docs/dsh-pentest-plugin-design.md §6.1、§6.2、§11.1
 *
 * ── 为什么它是首页而不是「会话视图」 ──
 *
 * 主入口是设置页里的插件标签页，**没有会话依赖**（§6.2：`settings.plugins.tab`
 * 的 owner props 为空，自由渲染）。因此 `AUTH_PENDING` 与 `READY` 两个状态天然可达：
 * 授权向导与 engagement 列表就在这里，不需要额外的承载面。列表本身也不依赖
 * 任何 Worker 会话——第一个会话要等人类在向导之后显式启动（§1.2）。
 *
 * ── 两种空态必须分开 ──
 *
 * 「还没有 engagement」（库是空的，下一步是走向导）与「筛选后没有匹配」（库里有数据，
 * 只是当前筛选没有命中）对人类的下一步动作完全不同。合成一句「无数据」会让人
 * 以为记录丢了。这也是 `Empty` 组件要求 `reason` 的原因。
 *
 * 组件是**纯函数、纯 props**：不订阅控制器、不发请求、不用 effect。列表数据由调用方
 * 从快照传入，点击回调由调用方接 `controller.select`。
 */

import { useState } from 'react';
import type { ReactNode } from 'react';
import type { EngagementSummary, MainStatus } from '../../contracts.ts';
import type { ConsoleController } from '../controller.ts';
import type { Tone } from '../format.ts';
import {
  formatCount,
  formatTimestamp,
  mainStatusLabel,
  phaseLabel,
  runMarkerLabel,
  runMarkerTone,
} from '../format.ts';
import { Badge, Button, Card, Empty, Field, Table, TextInput } from '../ui.tsx';
import { GateList } from './GateList.tsx';

/** 列表列定义（顺序即展示顺序）。 */
const COLUMNS: readonly { readonly key: string; readonly header: string }[] = [
  { key: 'name', header: '名称' },
  { key: 'marker', header: '运行标记' },
  { key: 'status', header: '主状态' },
  { key: 'phase', header: '当前阶段' },
  { key: 'iteration', header: '迭代' },
  { key: 'version', header: '状态版本' },
  { key: 'updated', header: '更新时间' },
  // 清理动作（归档 / 彻底删除）：两段确认，见下方 purge 面板。
  { key: 'actions', header: '清理' },
];

/**
 * 主状态的语义色。
 *
 * 与 `RunHeader` 的判定同源：**需要人类动手**的状态用 attention（这是这一屏的
 * 核心信息「现在该谁动」），已完成用 done，尚未成立（授权确认中）用 neutral。
 */
function mainStatusTone(status: MainStatus): Tone {
  switch (status) {
    case 'auth_pending':
      return 'neutral';
    case 'complete':
      return 'done';
    case 'waiting_human_review':
    case 'handoff_drafting':
    case 'transition_confirmation':
    case 'report_ready':
      return 'attention';
    case 'ready':
    case 'worker_running':
      return 'active';
  }
}

/** 清理列的判定。单独成函数以便测试穷举「未归档 / 已归档 / 已清空」三种组合。 */
export interface EngagementActionAvailability {
  /** 归档按钮文案：归档 ⇄ 取消归档。 */
  readonly archiveLabel: string;
  /** 是否渲染「清空内容…」（只对已归档的作业有意义）。 */
  readonly purgeVisible: boolean;
  readonly purgeDisabled: boolean;
  readonly purgeReason: string | null;
}

export function engagementActionAvailability(
  item: Pick<EngagementSummary, 'archivedAt' | 'purgedAt'>,
): EngagementActionAvailability {
  const archived = item.archivedAt != null;
  const purged = item.purgedAt != null;
  return {
    archiveLabel: archived ? '取消归档' : '归档',
    purgeVisible: archived,
    // 清空过的作业不再给可点的按钮：点进去只会看到「已经清空过」的拦截，
    // 人类会以为上次那一下没生效（2026-10-05 实测：确实这么误会了）。
    purgeDisabled: purged,
    purgeReason: purged
      ? '内容已清空（不可恢复）；审计骨架按 §9.5 永久保留'
      : '两段确认后才能点最终删除',
  };
}

export interface EngagementListProps {
  /** 完整列表（未经筛选）。筛选由本组件按 `filter` 做，空态才能区分两种原因。 */
  readonly engagements: readonly EngagementSummary[];
  /** 当前选中项（高亮）。 */
  readonly selectedId?: string | null;
  /** 某一项被点击。调用方据此调 `controller.select(id)`。 */
  readonly onSelect: (engagementId: string) => void;
  /**
   * 请求打开授权向导。
   *
   * 列表本身**不渲染向导**（那是外壳的模态），只表达「人类想新建」这个意图。
   * 缺这个回调时按钮禁用并说明原因——空列表上连一个能点的东西都没有是最糟的体验。
   */
  readonly onRequestCreate?: () => void;
  /** 受控筛选串；与 `onFilterChange` 一起提供时渲染筛选框。 */
  readonly filter?: string;
  readonly onFilterChange?: (next: string) => void;
  /** 正在重读（§6.2 的刷新提示）。 */
  readonly loading?: boolean;
  /** 注入的「现在」，便于渲染确定性（测试用）。 */
  readonly now?: Date;
  /**
   * 唯一写入路径：归档与彻底删除都经它下发（§4.2）。
   *
   * **必需**。曾经它是可选的，于是外壳漏传时按钮只是全灰（禁用原因写着
   * 「调用方未接入控制器」），人类点不动又看不出哪里错了（2026-10-05 实测报障）。
   * 改成必需属性后，漏传在 `tsc` 阶段就红。
   */
  readonly controller: ConsoleController;
}

export function EngagementList(props: EngagementListProps): ReactNode {
  const filter = (props.filter ?? '').trim();
  // 归档默认隐藏（列表噪声的主要来源），但一个字节都没删——勾上就能看见并取消归档。
  const [showArchived, setShowArchived] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [purge, setPurge] = useState<{
    readonly id: string;
    readonly name: string;
    readonly total: number;
    readonly counts: Readonly<Record<string, number>>;
    readonly retained: Readonly<Record<string, number>>;
    readonly retainedTotal: number;
    readonly blockers: readonly string[];
    readonly confirmName: string;
  } | null>(null);

  const visible = showArchived
    ? props.engagements
    : props.engagements.filter((item) => item.archivedAt == null);
  const matched = filter === '' ? visible : visible.filter((item) => matches(item, filter));

  const archive = (id: string, archived: boolean): void => {
    const controller = props.controller;
    setBusyId(id);
    setActionError(null);
    void controller
      .mutate('archiveEngagement', { engagementId: id, archived }, '')
      .then(async (result) => {
        if (!result.ok) {
          setActionError(`${result.code}：${result.message}`);
          return;
        }
        await controller.refreshEngagements();
      })
      .catch((cause: unknown) => {
        setActionError(cause instanceof Error ? cause.message : String(cause));
      })
      .finally(() => { setBusyId(null); });
  };

  const openPurge = (id: string): void => {
    const controller = props.controller;
    setBusyId(id);
    setActionError(null);
    void controller
      .previewEngagementPurge(id)
      .then((value) => {
        if (value === null) {
          setActionError('预览读不到（未选中作业或服务端未返回）');
          return;
        }
        setPurge({
          id,
          name: value.name,
          total: value.total,
          counts: value.counts,
          retained: value.retained,
          retainedTotal: value.retainedTotal,
          blockers: value.blockers,
          confirmName: '',
        });
      })
      .catch((cause: unknown) => {
        setActionError(cause instanceof Error ? cause.message : String(cause));
      })
      .finally(() => { setBusyId(null); });
  };

  const confirmPurge = (): void => {
    const controller = props.controller;
    if (purge === null) return;
    setBusyId(purge.id);
    setActionError(null);
    void controller
      .mutate('purgeEngagement', { engagementId: purge.id, confirmName: purge.confirmName }, '')
      .then(async (result) => {
        if (!result.ok) {
          setActionError(`${result.code}：${result.message}`);
          return;
        }
        setPurge(null);
        await controller.refreshEngagements();
      })
      .catch((cause: unknown) => {
        setActionError(cause instanceof Error ? cause.message : String(cause));
      })
      .finally(() => { setBusyId(null); });
  };

  /**
   * 空态三分支只在一处决定。
   *
   * 「库里没有数据」与「筛选没命中」必须给不同的话：前者下一步是走向导，后者下一步是
   * 清筛选。加载中也不能冒充空库——那会让人以为记录丢了。
   */
  const emptyState =
    props.engagements.length > 0 ? (
      <Empty
        title="筛选后没有匹配"
        reason={`当前筛选「${filter}」没有命中任何 engagement；清空筛选可看到全部 ${formatCount(props.engagements.length)} 个`}
      />
    ) : props.loading === true ? (
      <Empty title="正在读取 engagement 列表" />
    ) : (
      <Empty
        title="还没有 engagement"
        reason="点上方「新建 engagement」起个名字、填一个授权目标即可开始；建立不等于启动 Agent（§1.2）"
      />
    );

  const actionsCell = (item: EngagementSummary): ReactNode => {
    const actions = engagementActionAvailability(item);
    return (
    <span className="pentest-engagement-list__actions">
      <Button
        label={actions.archiveLabel}
        onClick={() => { archive(item.id, item.archivedAt == null); }}
        disabled={busyId === item.id}
      />
      {actions.purgeVisible ? (
        <Button
          label="清空内容…"
          kind="secondary"
          onClick={() => { openPurge(item.id); }}
          disabled={busyId === item.id || actions.purgeDisabled}
          reason={actions.purgeReason ?? undefined}
        />
      ) : null}
    </span>
    );
  };

  return (
    <Card title="Engagement 列表">
      <div className="pentest-engagement-list__bar">
        <Button
          label="新建 engagement"
          kind="primary"
          onClick={props.onRequestCreate ?? (() => {})}
          disabled={props.onRequestCreate === undefined}
          reason={
            props.onRequestCreate === undefined
              ? '调用方未接入新建回调（onRequestCreate）'
              : undefined
          }
        />
        <Badge text={`共 ${formatCount(props.engagements.length)} 个`} tone="neutral" />
        {props.loading === true ? <Badge text="正在重读…" tone="active" /> : null}
        {/* 归档 = 清理的第一级：只是从默认列表消失，一个字节都没删。 */}
        <label className="pentest-engagement-list__archived">
          <input
            type="checkbox"
            checked={showArchived}
            onChange={() => { setShowArchived((value) => !value); }}
          />
          <span>{`显示已归档（${formatCount(props.engagements.filter((item) => item.archivedAt != null).length)}）`}</span>
        </label>
        {props.onFilterChange === undefined ? null : (
          <Field label="筛选" hint="按名称、标识、阶段或状态过滤；清空即显示全部">
            <TextInput
              value={props.filter ?? ''}
              onChange={props.onFilterChange}
              placeholder="例如：靶场 / 利用验证 / 等待你判断"
            />
          </Field>
        )}
      </div>

      <Table
        columns={COLUMNS}
        rows={matched}
        keyOf={(item) => item.id}
        empty={emptyState}
        renderCell={(item, column) =>
          column === 'actions' ? actionsCell(item) : renderCell(item, column, props)}
      />

      {actionError === null ? null : (
        <p className="pentest-engagement-list__error" role="alert">{actionError}</p>
      )}

      {purge === null ? null : (
        <div className="pentest-engagement-list__purge">
          <strong>{`清空「${purge.name}」的内容`}</strong>
          <p className="pentest-engagement-list__purge-warn">
            {`将删除 ${formatCount(purge.total)} 行内容（${Object.entries(purge.counts)
              .filter(([, n]) => n > 0)
              .sort((a, b) => b[1] - a[1])
              .slice(0, 6)
              .map(([table, n]) => `${table} ${formatCount(n)}`)
              .join('、')}）。**这一步不可恢复**：归档可以撤销，清空不行。`}
          </p>
          <p className="pentest-engagement-list__purge-note">
            {`按 §9.5，审计账本行**不能删除**（只允许追加）：${formatCount(purge.retainedTotal)} 行` +
              `（${Object.entries(purge.retained)
                .filter(([, n]) => n > 0)
                .sort((a, b) => b[1] - a[1])
                .slice(0, 5)
                .map(([table, n]) => `${table} ${formatCount(n)}`)
                .join('、')}）连同作业行一起保留——作业在列表里显示为「已清理」，不再有内容可读。`}
          </p>
          <GateList blockers={purge.blockers} />
          <Field
            label="确认：原样输入作业名"
            hint="前端只是辅助；服务端也会逐字比对，不一致一律拒绝。"
          >
            <TextInput
              value={purge.confirmName}
              onChange={(next) => { setPurge({ ...purge, confirmName: next }); }}
              placeholder={purge.name}
            />
          </Field>
          <div className="pentest-engagement-list__purge-actions">
            <Button
              label={busyId === purge.id ? '清空中…' : '确认清空内容（不可恢复）'}
              kind="secondary"
              onClick={confirmPurge}
              disabled={
                busyId === purge.id ||
                purge.blockers.length > 0 ||
                purge.confirmName.trim() !== purge.name
              }
              reason={
                purge.blockers.length > 0
                  ? '上面还有拦路的项：先解决它们'
                  : purge.confirmName.trim() !== purge.name
                    ? '作业名不一致：请原样输入'
                    : undefined
              }
            />
            <Button label="取消" onClick={() => { setPurge(null); }} />
          </div>
        </div>
      )}
    </Card>
  );
}

/** 命中判定：名称、标识与两个已本地化的标签都参与，避免人类只能按名称找。 */
function matches(item: EngagementSummary, needle: string): boolean {
  const haystack = [
    item.name,
    item.id,
    phaseText(item.currentPhase),
    mainStatusLabel(item.mainStatus),
    runMarkerLabel(item.runMarker),
  ]
    .join(' ')
    .toLowerCase();
  return haystack.includes(needle.toLowerCase());
}

/** 阶段为 `null` 时（尚未进入任何阶段）不参与筛选。 */
function phaseText(phase: EngagementSummary['currentPhase']): string {
  return phase === null ? '' : phaseLabel(phase);
}

function renderCell(
  item: EngagementSummary,
  column: string,
  props: EngagementListProps,
): ReactNode {
  const selected = props.selectedId === item.id;
  switch (column) {
    case 'name':
      return (
        <span className="pentest-engagement-list__name">
          <Button
            label={item.name}
            kind={selected ? 'primary' : 'secondary'}
            onClick={() => { props.onSelect(item.id); }}
          />
          {selected ? <Badge text="当前" tone="active" /> : null}
          {item.purgedAt == null ? null : <Badge text="已清理" tone="attention" hint="内容已清空；审计账本行按 §9.5 保留" />}
          {item.purgedAt == null && item.archivedAt != null ? <Badge text="已归档" tone="neutral" /> : null}
        </span>
      );
    case 'marker':
      return <Badge text={runMarkerLabel(item.runMarker)} tone={runMarkerTone(item.runMarker)} />;
    case 'status':
      return <Badge text={mainStatusLabel(item.mainStatus)} tone={mainStatusTone(item.mainStatus)} />;
    case 'phase':
      return item.currentPhase === null ? '—' : phaseLabel(item.currentPhase);
    case 'iteration':
      return formatCount(item.graphIteration);
    case 'version':
      // 状态版本是乐观锁的比对基准，列表里也要看得见：人类要能判断自己手上的界面有多旧
      return formatCount(item.stateVersion);
    case 'updated':
      return formatTimestamp(item.updatedAt, props.now);
    default:
      return null;
  }
}
