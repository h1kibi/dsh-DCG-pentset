/**
 * 范围管理与回环修订：范围版本、目标清单、以及「新发现资产逐项三选一」。
 *
 * 设计依据：docs/dsh-pentest-plugin-design.md §5.5（循环与范围修订）、
 * §10.2.2（目标规范化与范围判定）、§6.2.1（范围管理面板职责）
 *
 * ── 这一屏的核心：深度推进必须建立在已完成的范围修订上 ──
 *
 * §5.5 写着「内网发现的主机**默认不在授权范围内**——上一轮的范围快照只覆盖了最初
 * 约定的外部目标」。所以回环不是「再跑一轮」，而是**一次独立的人工决策**：
 * 列出候选资产（带发现来源）→ 逐项决定纳入 / 排除 / 待确认 → 记录授权依据
 * → 生成新的范围版本。§10.3 的横向移动放行要求目标「必须已纳入当前范围版本」，
 * 这条闸门正是靠这里的决策成立的。
 *
 * ── 闸门规则（只在 `amendmentBlockers` 里实现一份） ──
 *
 * 1. **授权依据不再必填**：本部署运行在已获授权的作业环境里（授权主体就是部署方），
 *    填授权凭据只会挡住作业、并不增加任何技术安全边界。该字段保留为**审计留痕**：
 *    有就记，没有就空着。真正的边界是下面这些闸门与执行层的范围/放行/审计。
 * 2. **每项候选资产都要表态**：未表态的项按 `pending` 处理，而**待确认与排除都不纳入**
 *    （§5.5「未纳入新范围的资产不参与后续任何阶段的检索、扫描或验证」）。界面把这条
 *    规则明写在每一行上，避免人类把「待确认」误解成「先放进去再说」。
 * 3. **提交即产生新范围版本**：提交前明确提示人类「这会生成新范围版本，并递增策略 epoch，
 *    中止按旧 epoch 签发的在途动作」（§10.3.1），而且旧凭证随之失效。
 *
 * ── 端点缺口 ──
 *
 * `amendScope` **在**控制台方法表里（`src/console/rpc.ts`），因此提交直接走
 * `controller.amendScope`。但**读**端点在表里不存在：没有任何方法返回当前范围版本、
 * 历史版本或候选资产列表（契约里只有 `HumanWorkflowService.getState` 的状态摘要）。
 * 因此版本与候选资产由调用方经 props 注入，缺失的读端点名经 `readEndpointGap`
 * 显示给人类——而不是让一个空列表假装「当前没有目标」。
 */

import { useState } from 'react';
import type { ReactNode } from 'react';
import { ANY_PORT, SCOPE_DECISIONS } from '../../contracts.ts';
import type { AssetScopeDecision, ScopeDecision, ScopeTarget } from '../../contracts.ts';
import type { ConsoleController, ConsoleSnapshot } from '../controller.ts';
import { formatCount, formatTimestamp } from '../format.ts';
import type { Tone } from '../format.ts';
import { Badge, Button, Card, Empty, ErrorBar, Field, List, Stat, Table, TextArea, TextInput } from '../ui.tsx';

// ───────────────────────────── 文案与取值域（§21 暂无完整 locale 表，先集中在这里） ─────────────────────────────

/** 三选一的中文名（与契约的 `ScopeDecision` 一一对应）。 */
const DECISION_LABELS: Readonly<Record<ScopeDecision, string>> = {
  included: '纳入',
  excluded: '排除',
  pending: '待确认',
};

/**
 * 每个选项的**后果**说明。
 *
 * `pending` 与 `excluded` 在后果上完全一样（都不纳入），但决策含义不同——前者是
 * 「还没判断」，后者是「判断了，不要」。把后果写在同一行，人类才不会把待确认当成
 * 「暂时先纳入」。§5.5 只对后果有规定，对措辞没有，因此这里逐项说明后果。
 */
const DECISION_EFFECTS: Readonly<Record<ScopeDecision, string>> = {
  included: '纳入本轮范围：参与后续检索、扫描与验证，横向移动放行要求目标在此集合内。',
  excluded: '不纳入：本资产不参与后续任何阶段，直到下一次范围修订。',
  pending: '不纳入：与「排除」的后果相同。未纳入的资产不参与后续任何阶段。差异只在于尚未做出判断。',
};

const DECISION_TONES: Readonly<Record<ScopeDecision, Tone>> = {
  included: 'done',
  excluded: 'neutral',
  pending: 'attention',
};

/**
 * 三选一的呈现顺序：先「纳入」，再「排除」，最后「待确认」。
 *
 * 取值表与契约同源（`SCOPE_DECISIONS`）：本地再写一份列表时，两侧漂移会让某一侧
 * 把合法取值当成脏数据（或反过来把非法值渲染成选项）。
 */
const DECISION_ORDER: readonly ScopeDecision[] = SCOPE_DECISIONS;

/** 范围版本的只读展示形状（`pentest.scope_versions` 一行）。 */
export interface ScopeVersionView {
  readonly version: number;
  readonly iteration: number;
  readonly targets: readonly ScopeTarget[];
  readonly exclusions: readonly ScopeTarget[];
  readonly authorizationRef: string | null;
  readonly amendmentReason: string | null;
  readonly changedBy: string;
  readonly contentHash: string;
  readonly createdAt: string;
}

/**
 * 候选资产：上一轮进入的内部空间里被发现的资产。
 *
 * `discoveredFrom` 是 §5.5 要求的「发现来源（从哪个入口、哪个凭据、哪次访问）」——
 * 它决定了人类能不能判断这个资产值不值得纳入，因此它必须和资产本身一起显示，
 * 而不是藏在详情页里。
 */
export interface CandidateAsset {
  readonly assetId: string;
  readonly canonicalTarget: string;
  readonly kind: string;
  readonly labels: readonly string[];
  readonly discoveredFrom: string;
  readonly discoveredInSessionId: string | null;
  readonly firstSeenIteration: number;
}

/** 回环提交的输入（与 `ScopeAmendment` 的字段同名，`reason` 单独传给 controller）。 */
export interface AmendmentInput {
  readonly targets: readonly ScopeTarget[];
  readonly exclusions: readonly ScopeTarget[];
  readonly authorizationRef: string;
  readonly decisions: readonly AssetScopeDecision[];
}

/** 提交闸门的阻断项。`code` 稳定，便于验收与测试分支。 */
interface AmendmentBlocker {
  readonly code: 'engagement-missing' | 'no-candidates' | 'reason-required';
  readonly message: string;
}

interface AmendmentGateInput {
  readonly authorizationRef: string;
  readonly reason: string;
  readonly decisions: readonly AssetScopeDecision[];
  readonly candidateCount: number;
  readonly engagementId: string | null;
}

/**
 * 提交闸门（纯函数）。
 *
 * **未表态不算阻断**：未表态的项按 `pending` 提交（那是契约里的合法值，且后果与
 * 排除相同）。强制表态会逼人类在没有信息时随便点一个，那比诚实地记成「待确认」更糟。
 */
export function amendmentBlockers(input: AmendmentGateInput): readonly AmendmentBlocker[] {
  const blockers: AmendmentBlocker[] = [];
  if (input.reason.trim().length === 0) {
    blockers.push({ code: 'reason-required', message: '修订理由必填：它随新版本一并存档。' });
  }
  if (input.engagementId === null) {
    blockers.push({ code: 'engagement-missing', message: '尚未选中 engagement：先在列表里选一个作业。' });
  }
  if (input.candidateCount === 0) {
    blockers.push({
      code: 'no-candidates',
      message: '没有待决的内部资产：回环修订的输入是后渗透阶段报告的候选资产。',
    });
  }
  return blockers;
}

/** 把目标条目渲染成一行文本（含端口与协议语义）。 */
export function formatScopeTarget(target: ScopeTarget): string {
  const protocols = target.protocols.length === 0 ? '未声明协议' : target.protocols.join('/');
  let ports: string;
  if (target.ports.length === 0) {
    // 留空 = 默认 80/443，**对所有类型一致**（§10.2.2）。这里必须如实显示，
    // 否则人类会以为「没写端口」等于「没有限制」——而它其实是收窄到两个端口。
    ports =
      target.kind === 'domain' || target.kind === 'ip' || target.kind === 'cidr' || target.kind === 'asset-label'
        ? '默认端口 80/443'
        : '无端口维度';
  } else if (target.ports.some((range) => range.from === ANY_PORT.from && range.to === ANY_PORT.to)) {
    ports = '显式任意端口';
  } else {
    ports = target.ports.map((range) => `${String(range.from)}-${String(range.to)}`).join('、');
  }
  const wildcard = target.wildcardSubdomain === true ? ' · 含子域通配' : '';
  return `${target.kind} ${target.value}${wildcard} · ${protocols} · ${ports}`;
}

/** 范围管理的 props。 */
interface ScopeManagerProps {
  readonly controller: ConsoleController;
  readonly snapshot: ConsoleSnapshot;
  /** 当前生效的范围版本。 */
  readonly current: ScopeVersionView | null;
  /** 历史版本（只读展示，最新在前）。 */
  readonly history: readonly ScopeVersionView[];
  /** 待决的内部资产（后渗透报告的产物，§5.5）。 */
  readonly candidateAssets: readonly CandidateAsset[];
  /**
   * 把「本轮对候选资产的裁决」变成新版本的完整目标与排除项集合。
   *
   * 做成回调而不是两个静态数组：新范围取决于**本组件内部**的逐资产裁决，而裁决是
   * 人类在这里做的，调用方在渲染时还不知道。同时这条规则（当前范围 + 本轮纳入/排除的
   * 候选）留在数据层，与范围判定同源——本组件只负责收集裁决。
   *
   * 返回值里的目标允许是**未规范化的原始意图**（例如协议端口留空）：最终形态由服务端
   * 规范化并校验（§10.2.2），本组件不复制那份规则。
   */
  readonly planAmendment: (decisions: readonly AssetScopeDecision[]) => {
    readonly targets: readonly ScopeTarget[];
    readonly exclusions: readonly ScopeTarget[];
  };
  readonly readEndpointGap?: string;
  readonly now?: Date;
}

/** 范围管理 + 回环修订。 */
export function ScopeManager(props: ScopeManagerProps): ReactNode {
  const [authorizationRef, setAuthorizationRef] = useState('');
  const [reason, setReason] = useState('');
  const [decisions, setDecisions] = useState<Readonly<Record<string, ScopeDecision>>>({});
  const [failure, setFailure] = useState<{ readonly code: string; readonly message: string } | null>(null);
  const now = props.now ?? new Date();
  // 先取出来：`submit` 里要的是**已窄化**的非空 id，而不是一个 `?? ''` 兜底——
  // 兜底会把「没选中 engagement」悄悄变成「向空 id 提交」。
  const engagementId = props.snapshot.selectedEngagementId;

  const rows: readonly AssetScopeDecision[] = props.candidateAssets.map((asset) => ({
    assetId: asset.assetId,
    // 未表态按 pending：后果与排除相同，且诚实地表达「尚未判断」（§5.5）
    decision: decisions[asset.assetId] ?? 'pending',
  }));

  const blockers = amendmentBlockers({
    authorizationRef,
    reason,
    decisions: rows,
    candidateCount: props.candidateAssets.length,
    engagementId,
  });
  const ready = blockers.length === 0;
  const disabledReason = blockers[0]?.message;

  const includedCount = rows.filter((row) => row.decision === 'included').length;
  const excludedCount = rows.filter((row) => row.decision === 'excluded').length;
  const pendingCount = rows.length - includedCount - excludedCount;

  const submit = (): void => {
    // `ready` 已经包含「engagementId 非空」这一项；这里再判一次是为了让类型窄化成立，
    // 而不是靠断言把 null 塞进必填字段。
    if (!ready || engagementId === null) return;
    const plan = props.planAmendment(rows);
    props.controller
      .amendScope({
        engagementId,
        targets: plan.targets,
        exclusions: plan.exclusions,
        authorizationRef: authorizationRef.trim(),
        decisions: rows,
        reason: reason.trim(),
      })
      .then(
        // 服务端拒绝由控制器记进快照（`lastError`）并渲染；**抛出的异常**（传输层断开、
        // 信封构造失败）不会进快照，所以单独接住——否则人类点下去什么都不会发生。
        () => {
          setFailure(null);
        },
        (cause: unknown) => {
          setFailure({
            code: 'client/envelope-rejected',
            message: cause instanceof Error ? cause.message : String(cause),
          });
        },
      );
  };

  return (
    <div className="pentest-scope">
      <Card title="当前范围版本">
        {props.readEndpointGap === undefined ? null : (
          <p className="pentest-scope__gap">
            {`端点缺口：控制台方法表未导出 ${props.readEndpointGap}，范围与历史版本只能渲染调用方注入的数据；写端点 amendScope 已在表里。`}
          </p>
        )}
        {props.snapshot.conflict ? (
          <ErrorBar
            code="stale_state_version"
            message="另一个界面先提交了：已重读最新状态。需基于当前版本重新提交修订。"
            tone="attention"
          />
        ) : null}
        {props.snapshot.lastError === null ? null : (
          <ErrorBar code={props.snapshot.lastError.code} message={props.snapshot.lastError.message} />
        )}
        {failure === null ? null : <ErrorBar code={failure.code} message={failure.message} />}
        {props.snapshot.loading ? <Badge text="读写中" tone="active" hint="正在与控制台交换数据" /> : null}

        {props.current === null ? (
          <Empty
            title="尚未读到范围版本"
            reason="范围快照存在 engagements.scope_snapshot 与 scope_versions 里；选中 engagement 并读到数据后这里会显示版本号、目标清单、排除项与授权依据。"
          />
        ) : (
          <>
            <div className="pentest-scope__summary">
              <Stat label="当前版本" value={`v${formatCount(props.current.version)}`} tone="active" />
              <Stat label="所属迭代" value={`第 ${formatCount(props.current.iteration)} 轮`} hint="回环会同时递增迭代计数与范围版本" />
              <Stat label="目标条目" value={formatCount(props.current.targets.length)} />
              <Stat
                label="排除条目"
                value={formatCount(props.current.exclusions.length)}
                tone={props.current.exclusions.length === 0 ? 'neutral' : 'attention'}
              />
              <Stat
                label="授权依据"
                value={props.current.authorizationRef ?? '未记录'}
                tone={props.current.authorizationRef === null ? 'danger' : 'neutral'}
                hint="授权依据缺失的范围版本无法追溯出处"
              />
              <Stat label="变更者" value={props.current.changedBy} hint={`内容哈希 ${props.current.contentHash}`} />
              <Stat label="生成时间" value={formatTimestamp(props.current.createdAt, now)} />
            </div>

            <Field label="目标清单：纳入当前范围">
              <List
                items={props.current.targets}
                keyOf={(target) => `${target.kind}:${target.value}`}
                empty={<Empty title="目标清单为空" reason="没有纳入任何目标时，任何触及目标的动作都会被范围判定拒绝。" />}
                render={(target) => <span className="pentest-scope__target">{formatScopeTarget(target)}</span>}
              />
            </Field>

            <Field label="排除项">
              <List
                items={props.current.exclusions}
                keyOf={(target) => `${target.kind}:${target.value}`}
                empty={<Empty title="没有排除项" reason="创建 engagement 时人类未声明任何排除项。" />}
                render={(target) => (
                  <Badge text={formatScopeTarget(target)} tone="neutral" hint="排除项不参与任何阶段的检索、扫描或验证" />
                )}
              />
            </Field>
          </>
        )}
      </Card>

      <Card title={`回环修订：待决内部资产 · ${formatCount(props.candidateAssets.length)} 项`}>
        <p className="pentest-scope__rule">
          内网发现的主机
          <strong>默认不在授权范围内</strong>
          。逐项三选一：「纳入」进本轮范围，「排除」与「待确认」
          <strong>都不纳入</strong>
          ，未纳入的资产不参与后续任何阶段的检索、扫描或验证。
        </p>

        <Table
          columns={[
            { key: 'asset', header: '候选资产' },
            { key: 'origin', header: '发现来源' },
            { key: 'decision', header: '三选一' },
            { key: 'effect', header: '后果' },
          ]}
          rows={props.candidateAssets}
          keyOf={(asset) => asset.assetId}
          renderCell={(asset, columnKey) => {
            const chosen = decisions[asset.assetId] ?? 'pending';
            switch (columnKey) {
              case 'asset':
                return (
                  <div className="pentest-scope__asset">
                    <code>{asset.canonicalTarget}</code>
                    <span className="pentest-scope__kind">{asset.kind}</span>
                    {asset.labels.map((label) => (
                      <Badge key={label} text={label} tone="neutral" />
                    ))}
                  </div>
                );
              case 'origin':
                return (
                  <div className="pentest-scope__origin">
                    <span>{asset.discoveredFrom}</span>
                    <span className="pentest-scope__session">
                      {`首见于第 ${formatCount(asset.firstSeenIteration)} 轮`}
                      {asset.discoveredInSessionId === null
                        ? ''
                        : ` · 会话 ${asset.discoveredInSessionId}`}
                    </span>
                  </div>
                );
              case 'decision':
                return (
                  <div className="pentest-scope__choices" data-asset-id={asset.assetId} data-decision={chosen}>
                    {DECISION_ORDER.map((option) => (
                      <Button
                        key={option}
                        label={DECISION_LABELS[option]}
                        kind={chosen === option ? 'primary' : 'secondary'}
                        tone={DECISION_TONES[option]}
                        onClick={() => {
                          setDecisions((current) => ({ ...current, [asset.assetId]: option }));
                        }}
                      />
                    ))}
                  </div>
                );
              case 'effect':
                return <span className="pentest-scope__effect">{DECISION_EFFECTS[chosen]}</span>;
              default:
                return null;
            }
          }}
          empty={
            <Empty
              title="没有待决的内部资产"
              reason="回环修订只在后渗透阶段报告了内部可见资产时才需要。若要修订范围本身，走创建 engagement 时的授权向导。"
            />
          }
        />

        <div className="pentest-scope__counts">
          <Stat label="纳入" value={formatCount(includedCount)} tone="done" />
          <Stat
            label="排除"
            value={formatCount(excludedCount)}
            hint="不纳入，但已做出判断"
          />
          <Stat
            label="待确认"
            value={formatCount(pendingCount)}
            tone={pendingCount === 0 ? 'neutral' : 'attention'}
            hint="不纳入：与「排除」后果相同，差异只在于尚未判断"
          />
        </div>

        <Field label="授权依据" hint="留痕用：原授权文件的覆盖范围或补充授权引用。本部署不要求授权凭据，留空也能提交。">
          <TextInput
            value={authorizationRef}
            onChange={setAuthorizationRef}
            placeholder="例如：SOW-2026-014 第 3.2 节内部网段 / 补充授权邮件 2026-09-12"
          />
        </Field>

        <Field label="修订理由">
          <TextArea
            value={reason}
            onChange={setReason}
            rows={3}
            placeholder="例如：后渗透发现 10.20.0.0/16 内网主机，据 3 号入口的凭据横向可达，申请纳入"
          />
        </Field>

        <p className="pentest-scope__consequence" role="note">
          {'提交后会生成'}
          <strong>{`新的范围版本 v${formatCount((props.current?.version ?? 0) + 1)}`}</strong>
          {'，递增策略 epoch 并中止按旧 epoch 签发的在途动作。绑定旧版本的放行凭证随即失效，需由会话重新申请。旧版本保持可读。'}
        </p>

        {ready ? null : (
          <ul className="pentest-scope__blockers">
            {blockers.map((blocker) => (
              <li key={blocker.code} data-blocker={blocker.code}>
                {blocker.message}
              </li>
            ))}
          </ul>
        )}

        <Button
          label="提交范围修订"
          kind="primary"
          tone="done"
          disabled={!ready}
          {...(ready || disabledReason === undefined ? {} : { reason: disabledReason })}
          onClick={submit}
        />
      </Card>

      <Card title={`历史版本 · ${formatCount(props.history.length)} 个 · 只读`}>
        <Table
          columns={[
            { key: 'version', header: '版本' },
            { key: 'iteration', header: '迭代' },
            { key: 'counts', header: '目标 / 排除' },
            { key: 'authorizationRef', header: '授权依据' },
            { key: 'reason', header: '修订理由' },
            { key: 'changedBy', header: '变更者与时间' },
          ]}
          rows={props.history}
          keyOf={(entry) => String(entry.version)}
          renderCell={(entry, columnKey) => {
            switch (columnKey) {
              case 'version':
                return (
                  <Badge
                    text={`v${formatCount(entry.version)}`}
                    tone={entry.version === props.current?.version ? 'active' : 'neutral'}
                    hint={entry.version === props.current?.version ? '当前生效版本' : '历史版本，保持可读'}
                  />
                );
              case 'iteration':
                return `第 ${formatCount(entry.iteration)} 轮`;
              case 'counts':
                return `${formatCount(entry.targets.length)} / ${formatCount(entry.exclusions.length)}`;
              case 'authorizationRef':
                return entry.authorizationRef ?? '未记录';
              case 'reason':
                return entry.amendmentReason ?? '—';
              case 'changedBy':
                return `${entry.changedBy} · ${formatTimestamp(entry.createdAt, now)}`;
              default:
                return null;
            }
          }}
          empty={
            <Empty
              title="还没有历史版本"
              reason="第一次范围修订后，这里会列出所有旧版本，保持可读，便于事后核对当时授权的内容。"
            />
          }
        />
      </Card>
    </div>
  );
}
