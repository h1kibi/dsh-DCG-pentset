/**
 * 资产清单（控制台「资产」面板）。
 *
 * ── 这一页回答什么 ──
 *
 * 「这次作业已知哪些资产、它们各自在**当前范围版本**里的处境如何、有没有结论落在它们身上」。
 * 它是**只读投影**：资产只由范围修订登记（§5.5），这一页不创建、不改判任何资产。
 *
 * ── 为什么没有「被攻陷 / 服务指纹 / 网段」 ──
 *
 * 那些字段在库里没有出处（`pentest.assets` 只有 `canonical_target` / `kind` / `labels` /
 * `metadata` 这类列）。此前那版视图凭想象列了它们，结果是永远显示「无」——比不显示更坏，
 * 因为「无」看起来像一个结论。缺的列先有落库的写入方，再回到这里显示。
 *
 * ── 空与未裁决是两件事 ──
 *
 * `scopeDecision === null` 表示**当前范围版本里没有这条资产的裁决行**（它不在这一版范围内），
 * 与 `'pending'`（登记了、等着人裁决）必须分开显示：前者要去范围修订里把它纳入，
 * 后者要去裁决。混成一句「待处理」会让人做错动作。
 */

import type { ReactNode } from 'react';

import type { NetworkAsset, ScopeDecision } from '../../contracts.ts';
import type { Tone } from '../format.ts';
import { formatTimestamp } from '../format.ts';
import { Badge, Card, Empty, Stat, Table } from '../ui.tsx';

export interface AssetListProps {
  readonly assets: readonly NetworkAsset[];
  /** 展示用「现在」（注入以便测试稳定）。 */
  readonly now: Date;
}

/** 范围裁决的显示名。契约的 `SCOPE_DECISIONS` 只有三个取值，缺项会在类型层暴露。 */
const DECISION_LABELS: Readonly<Record<ScopeDecision, string>> = {
  included: '已纳入',
  excluded: '已排除',
  pending: '待裁决',
};

const DECISION_TONES: Readonly<Record<ScopeDecision, Tone>> = {
  included: 'done',
  excluded: 'danger',
  pending: 'attention',
};

/** 未入本版范围：库里没有该版本的裁决行。 */
const NO_DECISION_TEXT = '未入本版范围';

const KIND_LABELS: Readonly<Record<string, string>> = {
  domain: '域名',
  ip: 'IP',
  cidr: '网段',
  url: 'URL',
  service: '服务',
  'cloud-resource': '云资源',
  repository: '代码库',
  host: '主机',
  other: '其他',
};

export function AssetList(props: AssetListProps): ReactNode {
  const rows = [...props.assets].sort((left, right) => right.findingIds.length - left.findingIds.length);
  const withFindings = props.assets.filter((asset) => asset.findingIds.length > 0).length;

  return (
    <Card title="资产清单">
      <div className="pentest-card">
        <Stat label="资产总数" value={props.assets.length} />
        <Stat label="已纳入本版范围" value={countOf(props.assets, 'included')} tone="done" />
        <Stat label="已排除" value={countOf(props.assets, 'excluded')} tone="danger" />
        <Stat label="待裁决" value={countOf(props.assets, 'pending')} tone="attention" />
        {/* 未入本版范围的资产要单独计数：它们是「知道、但这一版没管」，与待裁决不同。 */}
        <Stat label="未入本版范围" value={countOf(props.assets, null)} />
        <Stat label="带结论的资产" value={withFindings} />
      </div>

      <Table<NetworkAsset>
        columns={[
          { key: 'identifier', header: '资产' },
          { key: 'kind', header: '种类' },
          { key: 'decision', header: '范围裁决' },
          { key: 'labels', header: '标签' },
          { key: 'findings', header: '结论' },
          { key: 'firstSeen', header: '首次出现' },
          { key: 'origin', header: '发现来源' },
        ]}
        rows={rows}
        keyOf={(asset) => asset.id}
        renderCell={(asset, column) => renderCell(asset, column, props.now)}
        empty={
          <Empty
            title="该作业还没有登记资产"
            reason="`pentest.assets` 里没有这个作业的行。注意这一栏的真话不止一句：当前代码里**没有任何写入方**登记资产（范围修订只能给已存在的资产写裁决行 `asset_scope_versions`），因此在这个作业登记过资产之前它会一直是空的——空不等于「目标没有资产」。"
          />
        }
      />
    </Card>
  );
}

function countOf(assets: readonly NetworkAsset[], decision: ScopeDecision | null): number {
  return assets.filter((asset) => asset.scopeDecision === decision).length;
}

function renderCell(asset: NetworkAsset, column: string, now: Date): ReactNode {
  switch (column) {
    case 'identifier':
      return <code title={asset.id}>{asset.identifier}</code>;
    case 'kind':
      return KIND_LABELS[asset.kind] ?? asset.kind;
    case 'decision':
      return asset.scopeDecision === null
        ? <Badge text={NO_DECISION_TEXT} tone="neutral" hint="当前范围版本里没有这条资产的裁决行" />
        : <Badge text={DECISION_LABELS[asset.scopeDecision]} tone={DECISION_TONES[asset.scopeDecision]} hint={asset.scopeDecision} />;
    case 'labels':
      return asset.labels.length === 0 ? '—' : asset.labels.join(', ');
    case 'findings':
      return asset.findingIds.length === 0
        ? '—'
        : <span title={asset.findingIds.join('\n')}>{`${String(asset.findingIds.length)} 条`}</span>;
    case 'firstSeen':
      return `第 ${String(asset.firstSeenIteration)} 轮 · ${formatTimestamp(asset.createdAt, now)}`;
    case 'origin':
      return originOf(asset);
    default:
      return null;
  }
}

/** 发现来源：范围修订登记时记下的入口（资产或会话）。两者都没有就是「未记录」。 */
function originOf(asset: NetworkAsset): string {
  if (asset.discoveredFromAssetId !== null) return `来自资产 ${asset.discoveredFromAssetId.slice(0, 8)}`;
  if (asset.discoveredInSessionId !== null) return `来自会话 ${asset.discoveredInSessionId.slice(0, 8)}`;
  return '未记录';
}
