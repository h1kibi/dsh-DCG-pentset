/**
 * 报告审阅：结论的「接受 / 拒绝 / 暂缓」三选一。
 *
 * 设计依据：docs/dsh-pentest-plugin-design.md §8.9（结论生命周期）、§6.2.1（报告审阅面板职责）
 *
 * ── 三条产品规则（§8.9），都在这里落地 ──
 *
 * 1. **拒绝与暂缓必须填理由**：理由为空时这两个按钮禁用，并把原因写在 `title` 上
 *    （`Button` 的约定：禁用的按钮必须说明为什么，人类不该靠猜）。
 * 2. **未处置条目阻止签字**：只要还有「候选态且从未被处置」的结论，本组件显示这条阻断
 *    与剩余数量；签字本身在 `ReportExport` 里被硬禁用。
 * 3. **严重度由人确认**：严重度是可编辑的选择项，模型给的值只是初值。严重度为空时不允许
 *    「接受」——否则报告里会出现一条没有风险等级的已验证结论。
 *
 * ── 分节 ──
 *
 * 四节「已验证结论 / 已评估但不成立 / 未验证候选 / 待审阅」的映射与
 * `src/report/pg-report.ts` 的 `sectionOf()` 同义，但**在这里重写了一份**：那个模块经
 * `memory/chunks.ts` 依赖 `node:crypto`（还有账本工具），客户端 bundle 不能引它。
 * 规则本身只有三行，重写比引一整条服务端依赖链便宜。
 *
 * 「已被取代」的结论不进任何一节（报告里也不出现）——但**不隐藏**：它们以一行计数显示，
 * 因为被取代的判断本身是审计信息（§8.9「冲突不覆盖旧结论」）。
 *
 * ── 端点现状（决定了本组件的接线方式）──
 *
 * 结论处置的端点是契约的 `PentestReportService.dispositionFinding`，它**在**控制台方法表里
 * （`src/console/rpc.ts` 的 `REPORT_METHOD_TABLE`，`kind: 'mutation'`、`operator: true`、
 * `reason: true`）——报告面整体已挂上，不再是缺口。
 *
 * 既然如此，本组件为什么**仍不直接发写请求**：处置要同时带上人工确认的严重度与人类写的
 * 理由，还要在成功后更新 App 持有的处置表与未处置计数（见 `onDispose` 的接线）——这些是
 * 调用方的职责。组件因此经 `onDispose` 回调上报意图，自身保持纯 props、可服务端渲染。
 * 回调缺席时按钮禁用并说明原因，绝不静默失败。
 */

import { useState } from 'react';
import type { ReactNode } from 'react';
import { SEVERITIES } from '../../contracts.ts';
import type {
  Finding,
  FindingDisposition,
  FindingStatus,
  ReportSection,
  Severity,
} from '../../contracts.ts';
import { isConsoleMethod } from '../../console/method-names.ts';
import type { ConsoleController, ConsoleSnapshot } from '../controller.ts';
import { formatConfidence, formatCount, formatTimestamp, renderInlineMarkdown, truncate } from '../format.ts';
import type { Tone } from '../format.ts';
import { Badge, Button, Card, Empty, ErrorBar, Field, List, Stat, TextArea } from '../ui.tsx';

// ─────────────── 文案与取值域（§21 暂无完整 locale 表，先集中在这里） ───────────────

/** §8.9 的四类分节。顺序即报告里的顺序，也是本页的阅读顺序。 */
const REVIEW_SECTION_ORDER: readonly ReportSection[] = [
  'verified_findings',
  'assessed_not_confirmed',
  'unverified_candidates',
  'awaiting_review',
];

const SECTION_TITLES: Readonly<Record<ReportSection, string>> = {
  verified_findings: '已验证结论',
  assessed_not_confirmed: '已评估但不成立',
  unverified_candidates: '未验证候选',
  awaiting_review: '待审阅',
};

const SECTION_NOTES: Readonly<Record<ReportSection, string>> = {
  verified_findings: '人工接受的结论，严重度为人工确认值。',
  assessed_not_confirmed: '人类已评估并判定不成立，证据引用保留，不删除。',
  unverified_candidates: '人类已暂缓处置，未经确认：不得当作已证实的风险。',
  awaiting_review: '尚未处置：列在这里即表示签字前置条件未满足。',
};

const SEVERITY_LABELS: Readonly<Record<Severity, string>> = {
  critical: '严重',
  high: '高',
  medium: '中',
  low: '低',
  info: '信息',
};

const STATUS_LABELS: Readonly<Record<FindingStatus, string>> = {
  candidate: '候选',
  validation_pending: '待验证',
  validated: '已验证',
  rejected: '已拒绝',
  human_accepted: '已接受',
  superseded: '已被取代',
};

const ACTION_LABELS: Readonly<Record<DispositionAction, string>> = {
  accept: '接受',
  reject: '拒绝',
  defer: '暂缓',
};

/** 处置动作的取值域取自契约，不另立一套枚举。 */
export type DispositionAction = FindingDisposition['action'];

/** 本页唯一的写入端点名。已在方法表里——见文件头「端点现状」。 */
export const DISPOSITION_METHOD_NAME = 'dispositionFinding';

/** 端点是否已经挂在控制台方法表上。挂上后本组件无需修改即可接线。 */
export const DISPOSITION_ENDPOINT_EXPORTED: boolean = isConsoleMethod(DISPOSITION_METHOD_NAME);

// ─────────────── 纯规则（可独立测试） ───────────────

/**
 * §8.9 的分节规则，与 `src/report/pg-report.ts` 的 `sectionOf()` 同义。
 *
 * 顺序敏感：**状态优先于处置记录**——「接受后又暂缓」仍是 `human_accepted`（状态是事实），
 * 而「暂缓」只对仍处候选态的结论生效。`null` 表示不进报告（已被取代）。
 */
export function reviewSectionOf(
  status: FindingStatus,
  disposition: DispositionAction | null,
): ReportSection | null {
  if (status === 'human_accepted') return 'verified_findings';
  if (status === 'rejected') return 'assessed_not_confirmed';
  if (status === 'superseded') return null;
  return disposition === 'defer' ? 'unverified_candidates' : 'awaiting_review';
}

/**
 * 签字前置条件（§8.9）：候选态且**从未被处置**才算未处置。
 *
 * 与 `src/report/pg-report.ts` 的 `isUndisposed()` 同义。注意它与 `reviewSectionOf` 的分工：
 * **分节看状态**（这条结论进报告哪一节），**是否已处置看处置记录**。服务端同样把它拆成两个
 * 函数（`sectionOf` 与 `isUndisposed`），理由是两者会在投影滞后时给出不同答案：
 * 一条刚被拒绝、状态还是 `candidate` 的结论已经算「给过处置」（不阻塞签字），
 * 但因为状态未更新，它仍列在「待审阅」里。
 *
 * **任何**处置记录（含暂缓）都算「已给出处置」：暂缓是一条明确的判断，不是没判断。
 */
function isUndisposedFinding(
  finding: Finding,
  disposition: DispositionAction | null,
): boolean {
  if (
    finding.status === 'human_accepted' ||
    finding.status === 'rejected' ||
    finding.status === 'superseded'
  ) {
    return false;
  }
  return disposition === null;
}

/**
 * 未处置条目数。
 *
 * `dispositions` 缺省时按「全部未处置」保守处理：宁可多报未处置（多一次签字阻断），
 * 也不能把未处置条目显示成已处置——那会让签字绕过 §8.9 的前置条件。
 */
export function countUndisposed(
  findings: readonly Finding[],
  dispositions: Readonly<Record<string, DispositionAction>> | undefined,
): number {
  return findings.filter((finding) => isUndisposedFinding(finding, dispositions?.[finding.id] ?? null)).length;
}

/** 一条闸门：`code` 供分支与测试使用，`message` 是给人看的原因（禁用按钮的 `title`）。 */
export interface GateBlocker {
  readonly code: string;
  readonly message: string;
}

/** 一次处置提交的全部前置条件。 */
interface DispositionGateInput {
  readonly action: DispositionAction;
  /** 人工确认后的严重度（可空：契约里 `severity` 可选，但接受时本页要求给出）。 */
  readonly severity: Severity | null;
  readonly reason: string;
  readonly engagementId: string | null;
  /** 端点是否在控制台方法表里（`console/method-unavailable` 的依据）。 */
  readonly endpointExported: boolean;
  /** 调用方是否提供了 `onDispose` 接线点。 */
  readonly wired: boolean;
}

/**
 * 三个按钮共用的闸门判定。空数组 = 可以提交。
 *
 * 顺序即重要顺序：先产品规则（§8.9），再环境前提（选中的 engagement、端点、接线），
 * 这样人看到的第一条永远是「我该改什么」。
 */
export function dispositionBlockers(input: DispositionGateInput): readonly GateBlocker[] {
  const blockers: GateBlocker[] = [];
  if (input.action === 'accept' && input.severity === null) {
    blockers.push({
      code: 'severity-required',
      message: '严重度需人工确认：没有严重度的结论不能进「已验证结论」',
    });
  }
  if (input.action !== 'accept' && input.reason.trim().length === 0) {
    blockers.push({
      code: 'reason-required',
      message: `${ACTION_LABELS[input.action]}必须填写理由：理由与结论一并存档`,
    });
  }
  if (input.engagementId === null) {
    blockers.push({ code: 'engagement-missing', message: '尚未选中 engagement：先在列表里选一个作业' });
  }
  if (!input.endpointExported) {
    blockers.push({
      code: 'endpoint-missing',
      message: `控制台未导出端点 ${DISPOSITION_METHOD_NAME} · console/method-unavailable：这条链路发不出去`,
    });
  }
  if (!input.wired) {
    blockers.push({
      code: 'wiring-missing',
      message: `调用方未提供 onDispose：本视图不直接发 RPC，处置要由外层接线到 ${DISPOSITION_METHOD_NAME}`,
    });
  }
  return blockers;
}

function severityTone(severity: Severity | null): Tone {
  switch (severity) {
    case 'critical':
    case 'high':
      return 'danger';
    case 'medium':
      return 'attention';
    case 'low':
    case 'info':
      return 'neutral';
    case null:
      return 'attention';
  }
}

function statusTone(status: FindingStatus): Tone {
  switch (status) {
    case 'human_accepted':
      return 'done';
    case 'validated':
      return 'active';
    case 'candidate':
    case 'validation_pending':
      return 'attention';
    case 'rejected':
    case 'superseded':
      return 'neutral';
  }
}

function dispositionTone(action: DispositionAction): Tone {
  switch (action) {
    case 'accept':
      return 'done';
    case 'defer':
      return 'attention';
    case 'reject':
      return 'neutral';
  }
}

/**
 * 状态本身蕴含的处置：`human_accepted` / `rejected` 只可能由人工处置产生（§8.9）。
 *
 * 处置记录投影缺失时用它们兜底——否则一条已接受的结论会显示成「从未处置」，
 * 那是错的（状态就是事实）。`candidate` / `validated` 等候选态不蕴含任何处置，
 * 因此仍然返回 `null`（= 需要处置记录才能判断）。
 */
function impliedDisposition(status: FindingStatus): DispositionAction | null {
  if (status === 'human_accepted') return 'accept';
  if (status === 'rejected') return 'reject';
  return null;
}

// ─────────────── 组件 ───────────────

/** 一次处置提交的内容。调用方据此调用它的报告服务入口。 */
export interface DispositionInput {
  readonly findingId: string;
  readonly action: DispositionAction;
  readonly reason: string;
  /** 人工确认后的严重度；`null` 表示沿用原值。 */
  readonly severity: Severity | null;
}

/**
 * 处置结果。
 *
 * 调用方可以返回 `void`（自己负责反馈）——那样本组件不显示成功/失败，也不会去重读状态：
 * 界面不该替 Host 断言一次它没看到结果的写入。
 */
export type DispositionOutcome =
  | { readonly ok: true; readonly replay?: boolean }
  | { readonly ok: false; readonly code: string; readonly message: string };

interface ReportReviewProps {
  readonly controller: ConsoleController;
  readonly snapshot: ConsoleSnapshot;
  /**
   * 待审阅的结论（Host 报告投影里的 `findings`）。
   *
   * 由调用方传入而不是组件自己去拉：报告投影的形状（含处置记录、脱敏后的资产名）由 Host
   * 一侧决定，视图不该在渲染中途发请求——那会让服务端渲染无法进行。
   */
  readonly findings: readonly Finding[];
  /**
   * `findingId` → 最近一次处置动作。
   *
   * 契约的 `Finding` **不含**处置记录（它落在 `human_decisions`，§9.5），而分节需要它。
   * 缺省视为「从未处置」（见 `countUndisposed`）。
   */
  readonly dispositions?: Readonly<Record<string, DispositionAction>>;
  /** 处置的接线点。缺省时三个按钮禁用并说明原因（见文件头「端点缺口」）。 */
  readonly onDispose?: (input: DispositionInput) => DispositionOutcome | Promise<DispositionOutcome> | void;
  /** 端点可用性的覆盖值，默认取控制台方法表的运行时探测（测试与宿主自定义面用）。 */
  readonly endpointExported?: boolean;
  /** 注入的「现在」，让时间渲染可确定（测试用）。 */
  readonly now?: Date;
}

export function ReportReview(props: ReportReviewProps): ReactNode {
  const endpointExported = props.endpointExported ?? DISPOSITION_ENDPOINT_EXPORTED;
  const engagementId = props.snapshot.selectedEngagementId;
  const undisposed = countUndisposed(props.findings, props.dispositions);

  const groups: Record<ReportSection, Finding[]> = {
    verified_findings: [],
    assessed_not_confirmed: [],
    unverified_candidates: [],
    awaiting_review: [],
  };
  let superseded = 0;
  for (const finding of props.findings) {
    const section = reviewSectionOf(finding.status, props.dispositions?.[finding.id] ?? null);
    if (section === null) superseded += 1;
    else groups[section].push(finding);
  }

  return (
    <div className="pentest-report-review">
      <Card title="报告审阅">
        <div className="pentest-report-review__summary">
          <Stat label="结论总数" value={formatCount(props.findings.length)} />
          <Stat
            label="未处置"
            value={formatCount(undisposed)}
            tone={undisposed > 0 ? 'danger' : 'done'}
            hint="候选态且从未给出处置的结论数；大于 0 时签字被阻止"
          />
          <Stat label="已验证结论" value={formatCount(groups.verified_findings.length)} tone="done" />
          <Stat label="已评估但不成立" value={formatCount(groups.assessed_not_confirmed.length)} />
          <Stat label="未验证候选" value={formatCount(groups.unverified_candidates.length)} tone="attention" />
          <Stat
            label="状态版本"
            value={props.snapshot.state === null ? '—' : formatCount(props.snapshot.state.stateVersion)}
            hint="乐观锁版本：处置基于这个版本提交，冲突时界面重读"
          />
        </div>

        {undisposed > 0 ? (
          <p className="pentest-report-review__block" role="alert">
            {`签字被阻止：还有 ${formatCount(undisposed)} 条结论从未处置；带着未处置条目不能出报告。`}
          </p>
        ) : null}

        {superseded === 0 ? null : (
          <p className="pentest-report-review__superseded">
            {`另有 ${formatCount(superseded)} 条结论已被取代：不进报告，但保留在记忆中可检索。`}
          </p>
        )}

        {endpointExported ? null : (
          <p className="pentest-report-review__gap">
            {`端点缺口：控制台方法表里没有 ${DISPOSITION_METHOD_NAME} · console/method-unavailable。`}
            {' 处置按钮只渲染不提交，由调用方经 onDispose 接线到报告服务入口。'}
          </p>
        )}

        {props.snapshot.conflict ? (
          <ErrorBar
            code="stale_state_version"
            message="另一个界面先提交了：已重读最新状态。请基于当前版本重新处置。"
            tone="attention"
          />
        ) : null}
        {props.snapshot.lastError === null ? null : (
          <ErrorBar code={props.snapshot.lastError.code} message={props.snapshot.lastError.message} />
        )}
        {props.snapshot.loading ? <Badge text="读写中" tone="active" hint="正在与控制台交换数据" /> : null}

        {props.findings.length === 0 ? (
          <Empty
            title="还没有任何结论"
            reason="Agent 提交带候选结论的报告后，这里会按四节分列，供人类逐条处置"
          />
        ) : null}
      </Card>

      {REVIEW_SECTION_ORDER.map((section) => (
        <Card key={section} title={`${SECTION_TITLES[section]} · ${formatCount(groups[section].length)}`}>
          <p className="pentest-report-review__note">{SECTION_NOTES[section]}</p>
          <List
            items={groups[section]}
            keyOf={(finding) => finding.id}
            empty={<Empty title="本节暂无结论" reason={SECTION_NOTES[section]} />}
            render={(finding) => (
              <FindingReviewRow
                finding={finding}
                disposition={props.dispositions?.[finding.id] ?? null}
                controller={props.controller}
                engagementId={engagementId}
                endpointExported={endpointExported}
                {...(props.onDispose === undefined ? {} : { onDispose: props.onDispose })}
                {...(props.now === undefined ? {} : { now: props.now })}
              />
            )}
          />
        </Card>
      ))}
    </div>
  );
}

/** 单条结论：事实展示 + 三选一处置。 */
function FindingReviewRow(props: {
  readonly finding: Finding;
  readonly disposition: DispositionAction | null;
  readonly controller: ConsoleController;
  readonly engagementId: string | null;
  readonly endpointExported: boolean;
  readonly onDispose?: (input: DispositionInput) => DispositionOutcome | Promise<DispositionOutcome> | void;
  readonly now?: Date;
}): ReactNode {
  const { finding } = props;
  // 严重度的初值是模型建议值；人工改动后以本地选择为准（§8.9「Agent 给出的是建议值」）。
  const [severity, setSeverity] = useState<Severity | null>(finding.severity);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<DispositionOutcome | null>(null);
  const undisposed = isUndisposedFinding(finding, props.disposition);
  // 显示用：优先取处置记录，其次取状态蕴含的处置（否则已接受的结论会显示「从未处置」）。
  const latestAction = props.disposition ?? impliedDisposition(finding.status);

  const submit = (action: DispositionAction): void => {
    const gate: DispositionGateInput = {
      action,
      severity,
      reason,
      engagementId: props.engagementId,
      endpointExported: props.endpointExported,
      wired: props.onDispose !== undefined,
    };
    // 按钮已禁用，这里只是防御：闸门规则只有一份，不允许出现「点得动但提交不了」的路径。
    if (dispositionBlockers(gate).length > 0 || props.onDispose === undefined) return;

    const input: DispositionInput = { findingId: finding.id, action, reason: reason.trim(), severity };
    setBusy(true);
    void Promise.resolve(props.onDispose(input))
      .then((resolved) => {
        setBusy(false);
        // `void` 返回值 = 调用方自己反馈；不显示结果，也不替它重读状态。
        if (resolved === undefined) return;
        setOutcome(resolved);
        // 处置改变了 Host 的事实（结论状态 / 未处置计数 / 状态版本），快照必须跟上。
        if (resolved.ok) void props.controller.refreshState();
      })
      .catch((cause: unknown) => {
        setBusy(false);
        setOutcome({
          ok: false,
          code: 'client/dispose-failed',
          message: cause instanceof Error ? cause.message : String(cause),
        });
      });
  };

  return (
    <div className="pentest-finding" data-finding-id={finding.id}>
      <div className="pentest-finding__head">
        <span className="pentest-finding__title">{renderInlineMarkdown(finding.title)}</span>
        <Badge text={STATUS_LABELS[finding.status]} tone={statusTone(finding.status)} hint={finding.status} />
        <Badge
          text={severity === null ? '严重度待人工确认' : `${SEVERITY_LABELS[severity]} · ${severity}`}
          tone={severityTone(severity)}
          hint="最终报告使用人工确认后的严重度"
        />
        <Badge
          text={latestAction === null ? '从未处置' : `已${ACTION_LABELS[latestAction]}`}
          tone={latestAction === null ? 'danger' : dispositionTone(latestAction)}
          hint={
            undisposed
              ? '未处置条目会阻止签字'
              : latestAction === null
                ? '状态为候选态但查不到处置记录'
                : '最近一次处置或状态蕴含的处置，来源 human_decisions'
          }
        />
      </div>

      <div className="pentest-finding__meta">
        <Stat label="置信度" value={formatConfidence(finding.confidence)} hint="0..1；null 表示未评估" />
        <Stat
          label="受影响资产"
          value={formatCount(finding.affectedAssetIds.length)}
          hint="结论与资产是引用关系：资产变化时结论自动反映最新数据"
        />
        <Stat
          label="证据引用"
          value={formatCount(finding.evidenceRefs.length)}
          tone={finding.evidenceRefs.length === 0 ? 'attention' : 'neutral'}
          hint="无证据引用的结论不应被当作已验证"
        />
        <Stat
          label="人工接受时间"
          value={finding.acceptedAt === null ? '—' : formatTimestamp(finding.acceptedAt, props.now)}
          hint={finding.acceptedBy === null ? '尚未人工接受' : `接受者：${finding.acceptedBy}`}
        />
      </div>

      <Field label="受影响资产">
        <List
          items={finding.affectedAssetIds}
          keyOf={(id) => id}
          render={(id) => <code className="pentest-finding__asset">{id}</code>}
          empty={<span className="pentest-finding__missing">未标注受影响资产</span>}
        />
      </Field>

      <Field label="证据引用">
        <List
          items={finding.evidenceRefs}
          keyOf={(ref) => ref}
          render={(ref) => (
            <code className="pentest-finding__evidence" title={ref}>
              {truncate(ref, 64)}
            </code>
          )}
          empty={<span className="pentest-finding__missing">无证据引用：不能作为已验证结论</span>}
        />
      </Field>

      <Field label="复现步骤">
        {finding.reproductionSteps.length === 0 ? (
          <span className="pentest-finding__missing">未提供复现步骤</span>
        ) : (
          <ol className="pentest-finding__steps">
            {finding.reproductionSteps.map((step, index) => (
              <li key={`${String(index)}-${step}`}>{renderInlineMarkdown(step)}</li>
            ))}
          </ol>
        )}
      </Field>

      {finding.impact === null ? null : (
        <Field label="影响">
          <span className="pentest-finding__text">{renderInlineMarkdown(finding.impact)}</span>
        </Field>
      )}
      {finding.remediation === null ? null : (
        <Field label="修复建议">
          <span className="pentest-finding__text">{renderInlineMarkdown(finding.remediation)}</span>
        </Field>
      )}

      <div className="pentest-finding__dispose">
        <Field label="严重度 · 人工确认" hint="模型给的是建议值；改为你确认后的等级">
          <select
            className="pentest-select"
            value={severity ?? ''}
            onChange={(event: { readonly target: { readonly value: string } }) => {
              setSeverity(SEVERITIES.find((candidate) => candidate === event.target.value) ?? null);
            }}
          >
            <option value="">未确认</option>
            {SEVERITIES.map((candidate) => (
              <option key={candidate} value={candidate}>
                {`${SEVERITY_LABELS[candidate]} · ${candidate}`}
              </option>
            ))}
          </select>
        </Field>

        <Field label="处置理由" hint="拒绝与暂缓必填；接受可选。理由与结论一并存档">
          <TextArea
            value={reason}
            onChange={setReason}
            rows={2}
            placeholder="为什么接受 / 拒绝 / 暂缓这条结论"
          />
        </Field>

        <div className="pentest-finding__actions">
          {(['accept', 'reject', 'defer'] as const).map((action) => {
            const blockers = dispositionBlockers({
              action,
              severity,
              reason,
              engagementId: props.engagementId,
              endpointExported: props.endpointExported,
              wired: props.onDispose !== undefined,
            });
            return (
              <Button
                key={action}
                label={ACTION_LABELS[action]}
                tone={action === 'accept' ? 'done' : action === 'defer' ? 'attention' : 'danger'}
                kind={action === 'accept' ? 'primary' : 'secondary'}
                disabled={blockers.length > 0 || busy}
                reason={blockers[0]?.message ?? '正在提交：等待上一次处置返回'}
                onClick={() => {
                  submit(action);
                }}
              />
            );
          })}
          {busy ? <Badge text="提交中" tone="active" /> : null}
          {outcome === null ? null : outcome.ok ? (
            <Badge
              text={outcome.replay === true ? '已处置 · 幂等重放，未重复执行' : '已处置'}
              tone="done"
              hint="结果来自 Host RPC，不是界面推断"
            />
          ) : (
            <ErrorBar code={outcome.code} message={outcome.message} />
          )}
        </div>
      </div>
    </div>
  );
}
