/**
 * 报告服务的 PostgreSQL 装配层（设计文档 §8.9 结论生命周期、§14.4 报告内容、§16.1.1 服务面、
 * §11.3 凭据与敏感信息）。
 *
 * 这一层只做两件事：**从数据库读事实**、**按固定规则投影成报告版本**。它不调模型——
 * 报告草稿是确定性投影（同一份库状态 + 同一版本号 → 同一份正文与同一内容哈希），
 * 因此哈希可以被人签字，也可以被事后复核。
 *
 * ── §8.9 的分节映射（唯一规则，全部落在 `sectionOf()`）──
 *
 * | 结论状态 / 最新处置                | 报告分节（契约 `REPORT_SECTIONS`） |
 * |-----------------------------------|-----------------------------------|
 * | `human_accepted`                  | `verified_findings`（已验证结论） |
 * | `rejected`                        | `assessed_not_confirmed`（已评估但不成立） |
 * | `candidate`/`validation_pending`/`validated` 且最新处置为 `defer` | `unverified_candidates`（未验证候选，标注未经确认） |
 * | 同上但从未有处置记录               | `awaiting_review`（待审阅，同时触发签字前置条件） |
 * | `superseded`                      | 不进任何分节（已取代的历史结论，只在摘要里计数） |
 *
 * 「暂缓」与「未处置」的区别必须落库才能分辨：`findings` 没有处置列（§9.2 冻结），
 * 因此处置一律写 `human_decisions`（`decision_type = 'finding_disposition'`，A 类只追加表，
 * §9.5）。**暂缓是一条已给出的处置**，因此不阻塞签字；只有从未被处置的条目才阻塞
 * （§8.9「不允许带着未处置条目出报告」）。
 *
 * ── 三条硬约束 ──
 *
 * 1. **证据原文永不脱敏**（§11.3）：`redactPreview` / `exportReport` 只作用于投影文本，
 *    绝不 `UPDATE findings.evidence_refs`、绝不改写 `artifacts` 行。脱敏是渲染期替换。
 * 2. **结论采纳在 engagement 级 advisory lock 内串行**（§15.4），报告版本号也在同一把锁下
 *    分配，因此 `UNIQUE (engagement_id, version)` 不会被并发版本号撞上。
 * 3. **状态写入只经过 workflow**（§4.2）：本服务不写 `engagements.state_version`。
 *    `updateReport.expectedStateVersion` 只做乐观并发校验——它挡住的是「人类编辑报告的同时
 *    工作流推进了阶段」，不是为了自己推进状态。
 *
 * 只依赖注入的 `DbClient`（`{ query(sql, params) }`，见 `src/memory/ledger.ts`），
 * 不持有连接池；需要独占连接的事务走 `options.txDb`，与 `MemoryLedger` / `PgWorkerTools` 同约定。
 */

import type { Classification } from '../contracts.ts';
import {
  FINDING_STATUSES,
  REPORT_SECTIONS,
  SEVERITIES,
} from '../contracts.ts';
import type {
  ExportRequest,
  ExportResult,
  Finding,
  FindingDisposition,
  FindingStatus,
  PentestReportService,
  RedactionRequest,
  ReportDraft,
  ReportEdit,
  ReportPreview,
  ReportSection,
  ReportSignatureSnapshot,
  ReportVersionRef,
  Severity,
} from '../contracts.ts';
import { sha256Hex } from '../memory/chunks.ts';
import { engagementLockKey, transactionRunnerFor, type DbTransactionRunner, type DbClient } from '../memory/ledger.ts';
// ───────────────────────────── 错误 ─────────────────────────────

/**
 * 报告服务的拒绝路径。携带契约稳定错误码（§16.5：模型据机器码分支，不解析 message 文本）；
 * 契约的 `ERROR_CODES` 没有「未找到 / 数据形状非法」类取值，这类情况 `code` 为 `null`。
 */
export class ReportServiceError extends Error {
  override readonly name = 'ReportServiceError';
  readonly code: string | null;

  constructor(message: string, code: string | null = null) {
    super(message);
    this.code = code;
  }
}

// ───────────────────────────── 取值域 ─────────────────────────────

const FINDING_STATUS_SET: ReadonlySet<string> = new Set<string>(FINDING_STATUSES);
const SEVERITY_SET: ReadonlySet<string> = new Set<string>(SEVERITIES);
const SECTION_SET: ReadonlySet<string> = new Set<string>(REPORT_SECTIONS);
/** §11.3 的字段分类取值域。`artifacts.classification` 列没有 CHECK 约束，越界值按「未知」处理。 */
const CLASSIFICATION_SET: ReadonlySet<string> = new Set<string>([
  'public',
  'engagement',
  'secret-like',
  'reasoning',
  'credential-like',
  'binary',
]);

/** 处置记录的 `decision_type`（A 类只追加表 `human_decisions`，§9.5）。 */
export const DISPOSITION_DECISION_TYPE = 'finding_disposition';

/**
 * 报告编辑记录的 `decision_type`。`ReportEdit` 带 `operatorId`，而 `reports` 表没有编辑者列——
 * 人类编辑是人工操作，必须可归因（§15.3 控制台操作带操作者），因此每次保存写一条只追加决策行。
 */
export const REPORT_EDIT_DECISION_TYPE = 'report_edit';

const DISPOSITION_ACTIONS = ['accept', 'reject', 'defer'] as const;
type DispositionAction = (typeof DISPOSITION_ACTIONS)[number];
const DISPOSITION_ACTION_SET: ReadonlySet<string> = new Set<string>(DISPOSITION_ACTIONS);

/**
 * 导出时的默认脱敏分类：§11.3「报告导出按字段分类脱敏，不复制密钥、会话令牌或靶场内的真实凭据」。
 * 契约的 `ExportRequest` 没有 classifications 字段，所以默认集合只能从构造参数注入。
 */
export const DEFAULT_EXPORT_REDACTIONS: readonly Classification[] = ['credential-like', 'secret-like'];

/** 严重度排序权重：critical 在前，未定级最后（严重度由人确认，可能为空）。 */
const SEVERITY_RANK: Record<string, number> = Object.fromEntries(
  SEVERITIES.map((severity, index) => [severity, index]),
);

// ───────────────────────────── 数据库行形状 ─────────────────────────────

interface EngagementRow {
  readonly id: string;
  readonly name: string;
  readonly status: string;
  readonly current_status: string;
  readonly current_phase: string | null;
  readonly state_version: number | string;
}

interface FindingRow {
  readonly id: string;
  readonly engagement_id: string;
  readonly title: string;
  readonly severity: string | null;
  readonly status: string;
  readonly affected_asset_ids: readonly string[];
  readonly evidence_refs: readonly string[];
  readonly reproduction_steps: unknown;
  readonly impact: string | null;
  readonly remediation: string | null;
  readonly confidence: number | string | null;
  readonly accepted_by: string | null;
  readonly accepted_at: Date | string | null;
  readonly created_at: Date | string;
}

interface ArtifactRow {
  readonly id: string;
  readonly kind: string;
  readonly media_type: string;
  readonly byte_size: number | string;
  readonly classification: string;
  readonly truncated: boolean;
}

interface DecisionRow {
  readonly subject_id: string;
  readonly decision: string;
  readonly reason: string;
  readonly operator_id: string;
  readonly created_at: Date | string;
}

interface TransitionRow {
  readonly resulting_version: number | string;
  readonly from_phase: string | null;
  readonly to_phase: string | null;
  readonly transition_type: string;
  readonly forced: boolean;
  readonly reason: string;
  readonly created_at: Date | string;
}

interface ReportRow {
  readonly version: number | string;
  readonly projection_json: unknown;
  readonly edited_content: string | null;
  readonly content_hash: string;
  readonly accepted_finding_ids: readonly string[];
}

// ───────────────────────────── 投影形状（落 reports.projection_json）─────────────────────────────

/**
 * 证据引用条目。**只放引用与分类，不放内容**：`artifacts` 的 `storage_path` / `inline_content`
 * / `source_ref` 一律不进报告投影，否则脱敏会漏掉真正的敏感面（§11.3）。
 * `available = false` 表示引用指向的 artifacts 行已不存在（§11.5 保留人工发起的删除通道，
 * 因此这不是异常，但必须显式标注）。
 */
export interface EvidenceProjection {
  readonly ref: string;
  readonly available: boolean;
  readonly kind: string | null;
  readonly mediaType: string | null;
  readonly byteSize: number | null;
  /** 原文分类（越界值原样保留）。 */
  readonly classification: string | null;
  readonly truncated: boolean | null;
  /** 仅出现在渲染期副本上：该证据已按分类脱敏。落库的投影不含此字段。 */
  readonly redacted?: boolean;
}

export interface FindingProjection {
  readonly id: string;
  readonly title: string;
  readonly severity: Severity | null;
  readonly status: FindingStatus;
  readonly section: ReportSection;
  readonly affectedAssetIds: readonly string[];
  readonly evidence: readonly EvidenceProjection[];
  readonly reproductionSteps: readonly string[];
  readonly impact: string | null;
  readonly remediation: string | null;
  readonly confidence: number | null;
  readonly acceptedBy: string | null;
  readonly acceptedAt: string | null;
  /** 最新处置（§8.9 三选一）；从未处置为 null。 */
  readonly dispositionAction: DispositionAction | null;
  /** 拒绝理由或暂缓理由（`human_decisions.reason`）。 */
  readonly dispositionReason: string | null;
  readonly dispositionOperatorId: string | null;
  readonly dispositionAt: string | null;
}

export interface ReportSectionProjection {
  readonly section: ReportSection;
  readonly findings: readonly FindingProjection[];
}

export interface PhaseTimelineEntry {
  readonly resultingVersion: number;
  readonly fromPhase: string | null;
  readonly toPhase: string | null;
  readonly transitionType: string;
  readonly forced: boolean;
  readonly reason: string;
  readonly createdAt: string;
}

export interface ReportProjection {
  readonly kind: 'pentest.report.projection';
  readonly engagementId: string;
  readonly version: number;
  readonly engagement: {
    readonly name: string;
    readonly status: string;
    readonly currentStatus: string;
    readonly currentPhase: string | null;
    readonly stateVersion: number;
  };
  /** §14.4「每次阶段切换与重做记录」：来自 `state_transitions`。 */
  readonly phaseTimeline: readonly PhaseTimelineEntry[];
  readonly sections: readonly ReportSectionProjection[];
  /** 签字前置条件（§8.9）：非空即阻止签字。 */
  readonly undisposedFindingIds: readonly string[];
  /** 已被取代的历史结论：不进分节，只计数。 */
  readonly supersededFindingIds: readonly string[];
  readonly acceptedFindingIds: readonly string[];
}

/** 投影主体（版本号由落库时补上，因此单独一个类型）。 */
type ProjectionBody = Omit<ReportProjection, 'kind' | 'version'>;

interface LatestReport {
  readonly version: number;
  readonly projection: ReportProjection;
  readonly editedContent: string | null;
  readonly contentHash: string;
}

// ───────────────────────────── SQL ─────────────────────────────

/** §8.9：处置串行化用 engagement 级 advisory lock（§15.4「结论采纳在 engagement 锁内串行」）。 */
const SQL_ACQUIRE_LOCK = 'select pg_advisory_xact_lock($1)';

const SQL_ENGAGEMENT = `select id, name, status, current_status, current_phase, state_version
       from pentest.engagements
      where id = $1`;

const FINDING_COLUMNS = `id, engagement_id, title, severity, status, affected_asset_ids, evidence_refs,
       reproduction_steps, impact, remediation, confidence, accepted_by, accepted_at, created_at`;

/** 确定性顺序：同一份库状态必须得到同一份投影（`created_at` 并列时用 id 兜底）。 */
const SQL_FINDINGS = `select ${FINDING_COLUMNS}
       from pentest.findings
      where engagement_id = $1
      order by created_at, id`;

const SQL_FINDING_BY_ID = `select ${FINDING_COLUMNS}
       from pentest.findings
      where id = $1`;

/** 每条结论取**最新**处置（§8.9：后续阶段可能推翻前一个判断，历史处置保留不删）。 */
const SQL_LATEST_DECISIONS = `select distinct on (subject_id) subject_id, decision, reason, operator_id, created_at
       from pentest.human_decisions
      where engagement_id = $1 and decision_type = $2
      order by subject_id, created_at desc, id desc`;

/** 证据元数据：只取脱敏与标注需要的列，不取 storage_path / inline_content（§11.3）。 */
const SQL_ARTIFACTS = `select id, kind, media_type, byte_size, classification, truncated
       from pentest.artifacts
      where engagement_id = $1 and id = any($2::uuid[])`;

/** §14.4「五阶段时间线 / 每次阶段切换与重做记录」。 */
const SQL_TRANSITIONS = `select resulting_version, from_phase, to_phase, transition_type, forced, reason, created_at
       from pentest.state_transitions
      where engagement_id = $1
      order by resulting_version`;

const SQL_NEXT_VERSION = `select coalesce(max(version), 0) + 1 as version
       from pentest.reports
      where engagement_id = $1`;

const SQL_LATEST_REPORT = `select version, projection_json, edited_content, content_hash, accepted_finding_ids
       from pentest.reports
      where engagement_id = $1
      order by version desc
      limit 1`;

/** 版本只追加：`updateReport` 建新行而不是覆盖旧版（旧版可被签字哈希追溯）。 */
const SQL_INSERT_REPORT = `insert into pentest.reports
         (engagement_id, version, projection_json, edited_content, accepted_finding_ids, content_hash)
       values ($1::uuid, $2, $3::jsonb, $4, $5::uuid[], $6)`;

/**
 * 处置 = 一次只追加的 `human_decisions` 记录 + `findings` 行状态推进。
 * `accepted_by` / `accepted_at` 只在接受时写入；拒绝**不清空**既有接受痕迹（审计要保留全过程）。
 * `evidence_refs` 从不出现在这条语句里——§11.3 的「拒绝不等于删除」由此结构性地保证。
 */
const SQL_APPLY_DISPOSITION = `update pentest.findings
       set status = $2,
           severity = coalesce($3, severity),
           accepted_by = case when $2 = 'human_accepted' then $4 else accepted_by end,
           accepted_at = case when $2 = 'human_accepted' then now() else accepted_at end,
           updated_at = now()
     where id = $1
     returning ${FINDING_COLUMNS}`;

const SQL_INSERT_DECISION = `insert into pentest.human_decisions
         (engagement_id, operator_id, decision_type, subject_id, decision, reason, edited_payload, auth_context)
       values ($1::uuid, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb)`;

// ───────────────────────────── 解析辅助（形状非法即响亮拒绝）─────────────────────────────

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ReportServiceError(`${label} 必须是对象，实际为 ${JSON.stringify(value)}`);
  }
  return value as Record<string, unknown>;
}

function asString(value: unknown, label: string): string {
  if (typeof value !== 'string') {
    throw new ReportServiceError(`${label} 必须是字符串，实际为 ${JSON.stringify(value)}`);
  }
  return value;
}

function asNullableString(value: unknown, label: string): string | null {
  return value === null || value === undefined ? null : asString(value, label);
}

function asArray(value: unknown, label: string): readonly unknown[] {
  if (!Array.isArray(value)) {
    throw new ReportServiceError(`${label} 必须是数组，实际为 ${JSON.stringify(value)}`);
  }
  return value;
}

/** `uuid[]` / `text[]` 列：`pg` 已解析为字符串数组，非字符串元素视为数据缺陷。 */
function asStringArray(value: unknown, label: string): readonly string[] {
  return asArray(value, label).map((entry) => asString(entry, `${label}[] 元素`));
}

/** `findings.reproduction_steps`（jsonb 字符串数组，§9.2）。 */
function asStepArray(value: unknown, label: string): readonly string[] {
  return asArray(value, label).map((entry) => asString(entry, `${label}[] 元素`));
}

/** `bigint` 列（`state_version`、`resulting_version`）经 `pg` 返回字符串。 */
function asNumber(value: unknown, label: string): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(parsed)) {
    throw new ReportServiceError(`${label} 不是有限数：${JSON.stringify(value)}`);
  }
  return parsed;
}

/** `numeric` 列（`confidence`）与 `bigint`（`byte_size`）：空值合法，非法值不猜测。 */
function asOptionalNumber(value: unknown, label: string): number | null {
  if (value === null || value === undefined) return null;
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(parsed)) {
    throw new ReportServiceError(`${label} 不是有限数：${JSON.stringify(value)}`);
  }
  return parsed;
}

function toIso(value: Date | string, label: string): string {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new ReportServiceError(`${label} 不是可解析时刻：${JSON.stringify(value)}`);
  }
  return date.toISOString();
}

// ───────────────────────────── 纯映射规则（§8.9）─────────────────────────────

interface LatestDisposition {
  readonly action: DispositionAction;
  readonly reason: string;
  readonly operatorId: string;
  readonly at: string;
}

function parseDispositionAction(value: string, subjectId: string): DispositionAction {
  if (!DISPOSITION_ACTION_SET.has(value)) {
    throw new ReportServiceError(
      `结论 ${subjectId} 的 ${DISPOSITION_DECISION_TYPE} 记录 decision=${JSON.stringify(value)} 不在 ` +
        `${DISPOSITION_ACTIONS.join(' / ')} 之内：无法判断它进了报告哪一节，拒绝静默归类`,
    );
  }
  return value as DispositionAction;
}

/**
 * §8.9 的唯一分节规则。返回 `null` 表示该结论不进任何分节（已被取代）。
 *
 * 顺序敏感：状态优先于处置记录——「接受后又暂缓」仍是 `human_accepted`（状态是事实），
 * 而「暂缓」只对仍处候选态（`candidate`/`validation_pending`/`validated`）的结论生效。
 */
export function sectionOf(
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
 * 暂缓是一条已给出的处置，因此不阻塞签字；它进「未验证候选」并标注未经确认。
 */
export function isUndisposed(status: FindingStatus, disposition: DispositionAction | null): boolean {
  return status !== 'human_accepted' && status !== 'rejected' && status !== 'superseded' && disposition === null;
}

// ───────────────────────────── 渲染 ─────────────────────────────

const SECTION_TITLES: Record<ReportSection, string> = {
  verified_findings: '已验证结论',
  assessed_not_confirmed: '已评估但不成立',
  unverified_candidates: '未验证候选',
  awaiting_review: '待审阅',
};

const SECTION_NOTES: Record<ReportSection, string> = {
  verified_findings: '人工接受的结论，严重度为人工确认值（§8.9）。',
  assessed_not_confirmed: '人类已评估并判定不成立；证据引用按 §8.9 保留，不删除。',
  unverified_candidates: '人类已暂缓处置，**未经确认**：不得当作已证实的风险。',
  awaiting_review: '**尚未处置**——列入本节即表示签字前置条件未满足（§8.9）。',
};

function compareFindings(a: FindingProjection, b: FindingProjection): number {
  const rankA = a.severity === null ? SEVERITIES.length : (SEVERITY_RANK[a.severity] ?? SEVERITIES.length);
  const rankB = b.severity === null ? SEVERITIES.length : (SEVERITY_RANK[b.severity] ?? SEVERITIES.length);
  if (rankA !== rankB) return rankA - rankB;
  if (a.title !== b.title) return a.title < b.title ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

function renderEvidence(entry: EvidenceProjection): string {
  if (entry.redacted === true) {
    // 只保留引用标识以便审计能追到被脱敏的是哪一份证据；分类与内容细节全部丢弃。
    return `- artifact:${entry.ref}（已脱敏：classification=${entry.classification ?? '未知'}）`;
  }
  if (!entry.available) {
    return `- artifact:${entry.ref}（证据不可用：artifacts 行已不存在，见 §11.5 的删除通道）`;
  }
  return (
    `- artifact:${entry.ref} kind=${entry.kind ?? '未知'} mediaType=${entry.mediaType ?? '未知'} ` +
    `bytes=${entry.byteSize ?? '未知'} classification=${entry.classification ?? '未知'} ` +
    `truncated=${entry.truncated === true ? 'true' : 'false'}`
  );
}

function renderFinding(lines: string[], finding: FindingProjection, index: number): void {
  lines.push(`### ${index + 1}. ${finding.title}`);
  lines.push('');
  lines.push(`- 结论 ID：${finding.id}`);
  lines.push(`- 严重度：${finding.severity ?? '（未定级）'}（人工确认值）`);
  lines.push(`- 状态：${finding.status}`);
  if (finding.confidence !== null) lines.push(`- 置信度：${finding.confidence}`);
  lines.push(`- 受影响资产：${finding.affectedAssetIds.join('、') || '（无）'}`);
  if (finding.acceptedAt !== null) {
    lines.push(`- 接受者 / 接受时间：${finding.acceptedBy ?? '（未记录）'} / ${finding.acceptedAt}`);
  }
  lines.push(`- 影响：${finding.impact ?? '（未记录）'}`);
  if (finding.reproductionSteps.length === 0) {
    lines.push('- 复现步骤：（未记录）');
  } else {
    lines.push('- 复现步骤：');
    for (const step of finding.reproductionSteps) lines.push(`  1. ${step}`);
  }
  lines.push(`- 修复建议：${finding.remediation ?? '（未记录）'}`);
  if (finding.dispositionAction !== null) {
    lines.push(
      `- 处置：${finding.dispositionAction}` +
        (finding.dispositionReason !== null && finding.dispositionReason !== ''
          ? `（理由：${finding.dispositionReason}）`
          : '') +
        (finding.dispositionAt !== null ? `｜${finding.dispositionOperatorId ?? '（未记录）'} @ ${finding.dispositionAt}` : ''),
    );
  } else {
    lines.push('- 处置：尚未给出');
  }
  if (finding.evidence.length === 0) {
    lines.push('- 证据：（无引用）');
  } else {
    lines.push('- 证据：');
    for (const entry of finding.evidence) lines.push(`  ${renderEvidence(entry)}`);
  }
  lines.push('');
}

/** 确定性渲染：投影相同 → 正文逐字节相同（内容哈希因此可被签字复核）。 */
export function renderReportMarkdown(projection: ReportProjection): string {
  const lines: string[] = [];
  const counts = new Map<ReportSection, number>();
  for (const section of projection.sections) counts.set(section.section, section.findings.length);
  const countOf = (section: ReportSection): number => counts.get(section) ?? 0;

  lines.push(`# 渗透测试报告：${projection.engagement.name}`);
  lines.push('');
  lines.push(`- engagementId：${projection.engagementId}`);
  lines.push(`- 报告版本：v${projection.version}`);
  lines.push(
    `- 主状态：${projection.engagement.currentStatus}（运行标记：${projection.engagement.status}）`,
  );
  lines.push(`- 当前阶段：${projection.engagement.currentPhase ?? '（未开始）'}`);
  lines.push(`- 状态版本：${projection.engagement.stateVersion}`);
  lines.push(
    `- 结论统计：已验证 ${countOf('verified_findings')}｜已评估不成立 ` +
      `${countOf('assessed_not_confirmed')}｜未验证候选 ${countOf('unverified_candidates')}｜` +
      `待审阅 ${countOf('awaiting_review')}｜已取代 ${projection.supersededFindingIds.length}`,
  );
  lines.push('');

  lines.push('## 阶段时间线');
  lines.push('');
  if (projection.phaseTimeline.length === 0) {
    lines.push('（无阶段转移记录）');
  } else {
    lines.push('| # | 从 | 到 | 转移类型 | 强制 | 时间 | 理由 |');
    lines.push('|---|---|---|---|---|---|---|');
    for (const entry of projection.phaseTimeline) {
      lines.push(
        `| ${entry.resultingVersion} | ${entry.fromPhase ?? '—'} | ${entry.toPhase ?? '—'} | ` +
          `${entry.transitionType} | ${entry.forced ? '是' : '否'} | ${entry.createdAt} | ${entry.reason} |`,
      );
    }
  }
  lines.push('');

  for (const section of projection.sections) {
    lines.push(`## ${SECTION_TITLES[section.section]}（${section.section}）`);
    lines.push('');
    lines.push(SECTION_NOTES[section.section]);
    lines.push('');
    if (section.findings.length === 0) {
      lines.push('（无）');
      lines.push('');
      continue;
    }
    const ordered = [...section.findings].sort(compareFindings);
    ordered.forEach((finding, index) => renderFinding(lines, finding, index));
  }

  if (projection.undisposedFindingIds.length > 0) {
    lines.push('## 签字前置条件');
    lines.push('');
    lines.push(
      `【签字前置条件未满足】还有 ${projection.undisposedFindingIds.length} 条结论未处置，` +
        '按 §8.9 不允许带着未处置条目出报告。未处置结论 ID：',
    );
    lines.push('');
    for (const id of projection.undisposedFindingIds) lines.push(`- ${id}`);
    lines.push('');
  }

  return `${lines.join('\n')}\n`;
}

interface RedactionResult {
  readonly projection: ReportProjection;
  readonly redactedCount: number;
}

/**
 * 按分类替换证据条目。**只改渲染期副本**：不写库、不动 `findings.evidence_refs`、
 * 不动 `artifacts`（§11.3 硬约束：证据原文永不脱敏）。
 *
 * 未知分类（`artifacts.classification` 列无 CHECK 约束）在请求了脱敏时**按敏感处理**：
 * 越界值不能当作「可公开」放行。
 */
export function applyRedactions(
  projection: ReportProjection,
  classifications: ReadonlySet<string>,
): RedactionResult {
  let redactedCount = 0;
  const sections = projection.sections.map((section) => ({
    section: section.section,
    findings: section.findings.map((finding) => {
      const evidence = finding.evidence.map((entry) => {
        const classification = entry.classification;
        const unknown = classification !== null && !CLASSIFICATION_SET.has(classification);
        const match =
          classifications.size > 0 &&
          (classification !== null && (classifications.has(classification) || unknown));
        if (!match) return entry;
        redactedCount += 1;
        return {
          ref: entry.ref,
          available: entry.available,
          kind: null,
          mediaType: null,
          byteSize: null,
          classification,
          truncated: null,
          redacted: true,
        } satisfies EvidenceProjection;
      });
      return { ...finding, evidence };
    }),
  }));
  return { projection: { ...projection, sections }, redactedCount };
}

// ───────────────────────────── 投影解析（读回 reports.projection_json）─────────────────────────────

function parseEvidence(raw: unknown, label: string): EvidenceProjection {
  const record = asRecord(raw, label);
  return {
    ref: asString(record['ref'], `${label}.ref`),
    available: record['available'] === true,
    kind: asNullableString(record['kind'], `${label}.kind`),
    mediaType: asNullableString(record['mediaType'], `${label}.mediaType`),
    byteSize: asOptionalNumber(record['byteSize'], `${label}.byteSize`),
    classification: asNullableString(record['classification'], `${label}.classification`),
    truncated: record['truncated'] === null || record['truncated'] === undefined
      ? null
      : record['truncated'] === true,
    ...(record['redacted'] === true ? { redacted: true } : {}),
  };
}

function parseFinding(raw: unknown, label: string): FindingProjection {
  const record = asRecord(raw, label);
  const severity = asNullableString(record['severity'], `${label}.severity`);
  if (severity !== null && !SEVERITY_SET.has(severity)) {
    throw new ReportServiceError(`${label}.severity 取值非法：${JSON.stringify(severity)}`);
  }
  const status = asString(record['status'], `${label}.status`);
  if (!FINDING_STATUS_SET.has(status)) {
    throw new ReportServiceError(`${label}.status 取值非法：${JSON.stringify(status)}`);
  }
  const section = asString(record['section'], `${label}.section`);
  if (!SECTION_SET.has(section)) {
    throw new ReportServiceError(`${label}.section 取值非法：${JSON.stringify(section)}`);
  }
  const disposition = asNullableString(record['dispositionAction'], `${label}.dispositionAction`);
  if (disposition !== null && !DISPOSITION_ACTION_SET.has(disposition)) {
    throw new ReportServiceError(`${label}.dispositionAction 取值非法：${JSON.stringify(disposition)}`);
  }
  return {
    id: asString(record['id'], `${label}.id`),
    title: asString(record['title'], `${label}.title`),
    severity: severity as Severity | null,
    status: status as FindingStatus,
    section: section as ReportSection,
    affectedAssetIds: asStringArray(record['affectedAssetIds'], `${label}.affectedAssetIds`),
    evidence: asArray(record['evidence'], `${label}.evidence`).map((entry, index) =>
      parseEvidence(entry, `${label}.evidence[${index}]`),
    ),
    reproductionSteps: asStringArray(record['reproductionSteps'], `${label}.reproductionSteps`),
    impact: asNullableString(record['impact'], `${label}.impact`),
    remediation: asNullableString(record['remediation'], `${label}.remediation`),
    confidence: asOptionalNumber(record['confidence'], `${label}.confidence`),
    acceptedBy: asNullableString(record['acceptedBy'], `${label}.acceptedBy`),
    acceptedAt: asNullableString(record['acceptedAt'], `${label}.acceptedAt`),
    dispositionAction: disposition as DispositionAction | null,
    dispositionReason: asNullableString(record['dispositionReason'], `${label}.dispositionReason`),
    dispositionOperatorId: asNullableString(record['dispositionOperatorId'], `${label}.dispositionOperatorId`),
    dispositionAt: asNullableString(record['dispositionAt'], `${label}.dispositionAt`),
  };
}

function parseTimelineEntry(raw: unknown, label: string): PhaseTimelineEntry {
  const record = asRecord(raw, label);
  return {
    resultingVersion: asNumber(record['resultingVersion'], `${label}.resultingVersion`),
    fromPhase: asNullableString(record['fromPhase'], `${label}.fromPhase`),
    toPhase: asNullableString(record['toPhase'], `${label}.toPhase`),
    transitionType: asString(record['transitionType'], `${label}.transitionType`),
    forced: record['forced'] === true,
    reason: asString(record['reason'], `${label}.reason`),
    createdAt: asString(record['createdAt'], `${label}.createdAt`),
  };
}

/**
 * 读回自己写下的投影。形状非法即拒绝：报告是签字对象，宁可响亮失败，
 * 也不能把一份残缺投影渲染成「看起来正常」的报告。
 */
export function parseReportProjection(raw: unknown): ReportProjection {
  const record = asRecord(raw, 'projection_json');
  if (record['kind'] !== 'pentest.report.projection') {
    throw new ReportServiceError(
      `projection_json.kind 非法：${JSON.stringify(record['kind'])}（期望 pentest.report.projection）`,
    );
  }
  const engagement = asRecord(record['engagement'], 'projection_json.engagement');
  const sections = asArray(record['sections'], 'projection_json.sections').map((entry, index) => {
    const section = asRecord(entry, `projection_json.sections[${index}]`);
    const name = asString(section['section'], `projection_json.sections[${index}].section`);
    if (!SECTION_SET.has(name)) {
      throw new ReportServiceError(`projection_json.sections[${index}].section 非法：${JSON.stringify(name)}`);
    }
    return {
      section: name as ReportSection,
      findings: asArray(section['findings'], `projection_json.sections[${index}].findings`).map((finding, i) =>
        parseFinding(finding, `projection_json.sections[${index}].findings[${i}]`),
      ),
    };
  });
  return {
    kind: 'pentest.report.projection',
    engagementId: asString(record['engagementId'], 'projection_json.engagementId'),
    version: asNumber(record['version'], 'projection_json.version'),
    engagement: {
      name: asString(engagement['name'], 'projection_json.engagement.name'),
      status: asString(engagement['status'], 'projection_json.engagement.status'),
      currentStatus: asString(engagement['currentStatus'], 'projection_json.engagement.currentStatus'),
      currentPhase: asNullableString(engagement['currentPhase'], 'projection_json.engagement.currentPhase'),
      stateVersion: asNumber(engagement['stateVersion'], 'projection_json.engagement.stateVersion'),
    },
    phaseTimeline: asArray(record['phaseTimeline'], 'projection_json.phaseTimeline').map((entry, index) =>
      parseTimelineEntry(entry, `projection_json.phaseTimeline[${index}]`),
    ),
    sections,
    undisposedFindingIds: asStringArray(record['undisposedFindingIds'], 'projection_json.undisposedFindingIds'),
    supersededFindingIds: asStringArray(record['supersededFindingIds'], 'projection_json.supersededFindingIds'),
    acceptedFindingIds: asStringArray(record['acceptedFindingIds'], 'projection_json.acceptedFindingIds'),
  };
}

// ───────────────────────────── 服务 ─────────────────────────────

export interface PgReportOptions {
  /**
   * 事务内客户端。结论处置「写决策 + 推进状态」与报告版本号分配必须在同一事务、
   * 且事务必须落在**同一条连接**上（`begin`/`commit` 落到不同连接会静默失效）。
   * 默认取 `db`，与 `MemoryLedger` / `PgWorkerTools` 同约定。
   */
  readonly txDb?: DbClient;
  /**
   * 导出时按分类脱敏的分类集合（§11.3）。契约的 `ExportRequest` 没有 classifications 字段，
   * 因此默认值在此注入；传空数组即导出未脱敏正文（例如离线审计复核）。
   */
  readonly exportRedactions?: readonly Classification[];
}

export class PgReportService implements PentestReportService {
  readonly #db: DbClient;
  readonly #txDb: DbClient;
  readonly #txRunner: DbTransactionRunner;
  readonly #exportRedactions: ReadonlySet<string>;

  constructor(db: DbClient, options: PgReportOptions = {}) {
    this.#db = db;
    this.#txDb = options.txDb ?? db;
    this.#txRunner = transactionRunnerFor(this.#txDb);
    this.#exportRedactions = new Set<string>(options.exportRedactions ?? DEFAULT_EXPORT_REDACTIONS);
  }

  // ── 1. 结论处置（§8.9 三选一）──

  async dispositionFinding(input: FindingDisposition): Promise<Finding> {
    if (!DISPOSITION_ACTION_SET.has(input.action)) {
      throw new ReportServiceError(
        `处置动作 ${JSON.stringify(input.action)} 非法：只能是 ${DISPOSITION_ACTIONS.join(' / ')}`,
      );
    }
    const action = input.action;
    const rawReason = typeof input.reason === 'string' ? input.reason.trim() : '';
    if (action !== 'accept' && rawReason === '') {
      throw new ReportServiceError(
        `处置 ${action} 必须填写理由（§8.9：拒绝需填写理由；暂缓同样要有依据，` +
          '否则「未验证候选」一节无法解释为何未定论）',
        'forced_reason_required',
      );
    }
    if (input.severity !== undefined && !SEVERITY_SET.has(input.severity)) {
      throw new ReportServiceError(
        `人工确认的严重度 ${JSON.stringify(input.severity)} 非法：只能是 ${SEVERITIES.join(' / ')}`,
      );
    }

    return this.#withTransaction(async (tx) => {
      const current = await this.#findingRow(tx, input.findingId);
      await this.#lock(tx, current.engagement_id);
      // 锁内重读：锁外读到的那份状态可能已被同一 engagement 的另一条处置改写。
      const row = await this.#findingRow(tx, input.findingId);
      const nextStatus: FindingStatus =
        action === 'accept' ? 'human_accepted' : action === 'reject' ? 'rejected' : parseStatus(row.status);

      await tx.query(SQL_INSERT_DECISION, [
        row.engagement_id,
        input.operatorId,
        DISPOSITION_DECISION_TYPE,
        row.id,
        action,
        rawReason,
        JSON.stringify(input.severity === undefined ? {} : { severity: input.severity }),
        JSON.stringify({ source: 'console', operatorId: input.operatorId }),
      ]);

      const updated = await tx.query<FindingRow>(SQL_APPLY_DISPOSITION, [
        row.id,
        nextStatus,
        input.severity ?? null,
        input.operatorId,
      ]);
      const applied = updated.rows[0];
      if (applied === undefined) {
        throw new ReportServiceError(`结论 ${row.id} 的处置未产生更新行——单语句原子性被破坏`);
      }
      return toFinding(applied);
    });
  }

  // ── 2. 报告草稿投影（§14.4；确定性，不调模型）──

  async getReportDraft(engagementId: string): Promise<ReportDraft> {
    return this.#withTransaction(async (tx) => {
      await this.#lock(tx, engagementId);
      const body = await this.#project(tx, engagementId);
      const version = await this.#nextVersion(tx, engagementId);
      const projection: ReportProjection = { kind: 'pentest.report.projection', version, ...body };
      const content = renderReportMarkdown(projection);
      // 哈希在这里算一次、写进行里、原样返回：调用方（控制台）要用它作为签字依据，
      // 重算一次没有意义，而重算与落库不同源正是「签字哈希指不到被审阅版本」的成因。
      const contentHash = sha256Hex(content);
      await tx.query(SQL_INSERT_REPORT, [
        engagementId,
        version,
        JSON.stringify(projection),
        null,
        projection.acceptedFindingIds,
        contentHash,
      ]);
      return { engagementId, version, content, contentHash };
    });
  }

  // ── 3. 保存人类编辑后的正文（只追加新版本）──

  async updateReport(input: ReportEdit): Promise<ReportVersionRef> {
    if (input.editedContent.trim() === '') {
      throw new ReportServiceError('updateReport 拒绝空正文：报告正文不能为空（可先 getReportDraft 取得投影）');
    }
    return this.#withTransaction(async (tx) => {
      await this.#lock(tx, input.engagementId);
      const engagement = await this.#engagement(tx, input.engagementId);
      if (asNumber(engagement.state_version, 'engagements.state_version') !== input.expectedStateVersion) {
        throw new ReportServiceError(
          `期望状态版本 ${input.expectedStateVersion} 与当前 ${String(engagement.state_version)} 不一致：` +
            '报告编辑不覆盖在更新的工作流状态之上（§15.3、§15.4）',
          'stale_state_version',
        );
      }
      const body = await this.#project(tx, input.engagementId);
      const version = await this.#nextVersion(tx, input.engagementId);
      const projection: ReportProjection = { kind: 'pentest.report.projection', version, ...body };
      const contentHash = sha256Hex(input.editedContent);
      // 编辑者归因：reports 表没有编辑者列，人工操作记入只追加的 human_decisions（§9.5）。
      await tx.query(SQL_INSERT_DECISION, [
        input.engagementId,
        input.operatorId,
        REPORT_EDIT_DECISION_TYPE,
        input.engagementId,
        'edited',
        `保存人工编辑的报告正文（版本 v${version}）`,
        JSON.stringify({ version, contentHash, expectedStateVersion: input.expectedStateVersion }),
        JSON.stringify({ source: 'console', operatorId: input.operatorId }),
      ]);
      // 版本只追加：旧版本行（未编辑的投影）原样保留，签字哈希可以追溯被审阅的那一版。
      await tx.query(SQL_INSERT_REPORT, [
        input.engagementId,
        version,
        JSON.stringify(projection),
        input.editedContent,
        projection.acceptedFindingIds,
        contentHash,
      ]);
      return { engagementId: input.engagementId, version, contentHash };
    });
  }

  // ── 4. 脱敏预览（§11.3：只作用于投影）──

  async redactPreview(input: RedactionRequest): Promise<ReportPreview> {
    const projection = await this.#renderSource(this.#db, input.engagementId);
    const redactions = new Set<string>(input.classifications);
    const { projection: redacted, redactedCount } = applyRedactions(projection, redactions);
    return {
      engagementId: input.engagementId,
      content: renderReportMarkdown(redacted),
      redactedCount,
    };
  }

  // ── 5. 导出（签字前也允许，供人工审阅）──

  async exportReport(input: ExportRequest): Promise<ExportResult> {
    if (input.format !== 'markdown' && input.format !== 'json') {
      throw new ReportServiceError(`导出格式 ${JSON.stringify(input.format)} 非法：只能是 markdown / json`);
    }
    const latest = await this.#latestOrDraft(this.#db, input.engagementId);
    const { projection: redacted, redactedCount } = applyRedactions(latest.projection, this.#exportRedactions);
    // 人类编辑版是自由文本，没有字段级分类可依据，因此按原样导出
    // （§8.9 的编辑步骤本身就包含人工脱敏；结构化投影部分仍按分类脱敏）。
    const body = latest.editedContent ?? renderReportMarkdown(redacted);
    const suffix = input.format === 'markdown' ? 'md' : 'json';
    const mediaType =
      input.format === 'markdown' ? 'text/markdown; charset=utf-8' : 'application/json; charset=utf-8';
    const content =
      input.format === 'markdown'
        ? body
        : `${JSON.stringify(
            {
              kind: 'pentest.report',
              engagementId: input.engagementId,
              version: latest.version,
              operatorId: input.operatorId,
              body,
              redactedCount,
              engagedRedactions: [...this.#exportRedactions].sort(),
              engagement: redacted.engagement,
              phaseTimeline: redacted.phaseTimeline,
              sections: redacted.sections,
              undisposedFindingIds: redacted.undisposedFindingIds,
              supersededFindingIds: redacted.supersededFindingIds,
              acceptedFindingIds: redacted.acceptedFindingIds,
            },
            null,
            2,
          )}\n`;
    return {
      fileName: `pentest-report-${input.engagementId}-v${latest.version}.${suffix}`,
      mediaType,
      byteSize: Buffer.byteLength(content, 'utf8'),
      contentHash: sha256Hex(content),
      content,
    };
  }

  // ── 6. 签字前置条件（§8.9）──

  /**
   * 在 engagement advisory lock 内读取签字所需的完整快照。
   *
   * 工作流会在自己的写事务中调用此方法；`transactionRunnerFor` 的重入语义让这里复用
   * 同一条连接、同一个事务。因此报告版本、未处置结论与随后写入的签字决策不会跨事务
   * 产生时间窗。
   */
  async getSignatureSnapshot(engagementId: string): Promise<ReportSignatureSnapshot> {
    return this.#withTransaction(async (tx) => {
      await this.#lock(tx, engagementId);
      await this.#engagement(tx, engagementId);
      const latest = await this.#latestReport(tx, engagementId);
      return {
        report: latest === undefined
          ? null
          : { engagementId, version: latest.version, contentHash: latest.contentHash },
        undisposed: await this.#undisposedFindings(tx, engagementId),
      };
    });
  }

  async signReportVersion(input: {
    readonly engagementId: string;
    readonly version: number;
    readonly contentHash: string;
    readonly operatorId: string;
  }): Promise<ReportVersionRef> {
    return this.#withTransaction(async (tx) => {
      await this.#lock(tx, input.engagementId);
      const updated = await tx.query<{ version: number | string; content_hash: string }>(
        `update pentest.reports
            set signed_by = $4,
                signed_at = now()
          where engagement_id = $1::uuid
            and version = $2
            and content_hash = $3
          returning version, content_hash`,
        [input.engagementId, input.version, input.contentHash, input.operatorId],
      );
      const row = updated.rows[0];
      if (row === undefined) {
        throw new ReportServiceError(
          `报告 ${input.engagementId} v${String(input.version)} 不存在或内容哈希已变化，拒绝签字`,
          'stale_state_version',
        );
      }
      return {
        engagementId: input.engagementId,
        version: asNumber(row.version, 'reports.version'),
        contentHash: row.content_hash,
      };
    });
  }

  /**
   * 列出某 engagement 的全部结论（报告审阅页的逐条处置列表）。
   *
   * 与 `listUndisposed` 的关系是「全集 vs 子集」：后者只给签字前置需要的那些，
   * 而审阅页要按**四个分节**展示全部结论——包括已接受、已拒绝与被取代的。
   * 复用同一套行读取与处置映射，因此两个端点的分节判定永远一致
   * （分节规则只有 `sectionOf` 一份实现）。
   */
  async listFindings(engagementId: string): Promise<readonly Finding[]> {
    await this.#engagement(this.#db, engagementId);
    const findings = await this.#findingRows(this.#db, engagementId);
    return findings.map(toFinding);
  }

  async listUndisposed(engagementId: string): Promise<readonly Finding[]> {
    await this.#engagement(this.#db, engagementId);
    return this.#undisposedFindings(this.#db, engagementId);
  }

  async #undisposedFindings(db: DbClient, engagementId: string): Promise<readonly Finding[]> {
    const findings = await this.#findingRows(db, engagementId);
    const dispositions = await this.#dispositions(db, engagementId);
    return findings
      .filter((row) => isUndisposed(parseStatus(row.status), dispositions.get(row.id)?.action ?? null))
      .map(toFinding);
  }

  // ── 投影主体 ──

  async #project(db: DbClient, engagementId: string): Promise<ProjectionBody> {
    const engagement = await this.#engagement(db, engagementId);
    const findings = await this.#findingRows(db, engagementId);
    const dispositions = await this.#dispositions(db, engagementId);
    const artifacts = await this.#artifacts(db, engagementId, findings);
    const timeline = await this.#phaseTimeline(db, engagementId);

    const bySection = new Map<ReportSection, FindingProjection[]>();
    for (const section of REPORT_SECTIONS) bySection.set(section, []);
    const undisposedFindingIds: string[] = [];
    const supersededFindingIds: string[] = [];
    const acceptedFindingIds: string[] = [];

    for (const row of findings) {
      const status = parseStatus(row.status);
      const disposition = dispositions.get(row.id) ?? null;
      const section = sectionOf(status, disposition?.action ?? null);
      if (section === null) {
        supersededFindingIds.push(row.id);
        continue;
      }
      const finding: FindingProjection = {
        id: row.id,
        title: row.title,
        severity: parseSeverity(row.severity),
        status,
        section,
        affectedAssetIds: asStringArray(row.affected_asset_ids, `findings.${row.id}.affected_asset_ids`),
        evidence: asStringArray(row.evidence_refs, `findings.${row.id}.evidence_refs`).map((ref) => {
          const artifact = artifacts.get(ref);
          return artifact === undefined
            ? {
                ref,
                available: false,
                kind: null,
                mediaType: null,
                byteSize: null,
                classification: null,
                truncated: null,
              }
            : {
                ref,
                available: true,
                kind: artifact.kind,
                mediaType: artifact.media_type,
                byteSize: asOptionalNumber(artifact.byte_size, `artifacts.${ref}.byte_size`),
                classification: artifact.classification,
                truncated: artifact.truncated,
              };
        }),
        reproductionSteps: asStepArray(row.reproduction_steps, `findings.${row.id}.reproduction_steps`),
        impact: row.impact,
        remediation: row.remediation,
        confidence: asOptionalNumber(row.confidence, `findings.${row.id}.confidence`),
        acceptedBy: row.accepted_by,
        acceptedAt: row.accepted_at === null ? null : toIso(row.accepted_at, `findings.${row.id}.accepted_at`),
        dispositionAction: disposition?.action ?? null,
        dispositionReason: disposition?.reason ?? null,
        dispositionOperatorId: disposition?.operatorId ?? null,
        dispositionAt: disposition?.at ?? null,
      };
      bySection.get(section)?.push(finding);
      if (section === 'verified_findings') acceptedFindingIds.push(row.id);
      if (isUndisposed(status, disposition?.action ?? null)) undisposedFindingIds.push(row.id);
    }

    return {
      engagementId,
      engagement: {
        name: engagement.name,
        status: engagement.status,
        currentStatus: engagement.current_status,
        currentPhase: engagement.current_phase,
        stateVersion: asNumber(engagement.state_version, 'engagements.state_version'),
      },
      phaseTimeline: timeline,
      sections: REPORT_SECTIONS.map((section) => ({
        section,
        findings: [...(bySection.get(section) ?? [])].sort(compareFindings),
      })),
      undisposedFindingIds: [...undisposedFindingIds].sort(),
      supersededFindingIds: [...supersededFindingIds].sort(),
      acceptedFindingIds: [...acceptedFindingIds].sort(),
    };
  }

  // ── 读取辅助 ──

  async #engagement(db: DbClient, engagementId: string): Promise<EngagementRow> {
    const found = await db.query<EngagementRow>(SQL_ENGAGEMENT, [engagementId]);
    const row = found.rows[0];
    if (row === undefined) {
      throw new ReportServiceError(`engagement ${engagementId} 不存在：无法投影报告或记录处置`);
    }
    return row;
  }

  async #findingRows(db: DbClient, engagementId: string): Promise<readonly FindingRow[]> {
    const found = await db.query<FindingRow>(SQL_FINDINGS, [engagementId]);
    return found.rows;
  }

  async #findingRow(db: DbClient, findingId: string): Promise<FindingRow> {
    const found = await db.query<FindingRow>(SQL_FINDING_BY_ID, [findingId]);
    const row = found.rows[0];
    if (row === undefined) {
      throw new ReportServiceError(`结论 ${findingId} 不存在：无法处置`);
    }
    return row;
  }

  async #dispositions(db: DbClient, engagementId: string): Promise<ReadonlyMap<string, LatestDisposition>> {
    const found = await db.query<DecisionRow>(SQL_LATEST_DECISIONS, [engagementId, DISPOSITION_DECISION_TYPE]);
    const map = new Map<string, LatestDisposition>();
    for (const row of found.rows) {
      map.set(row.subject_id, {
        action: parseDispositionAction(row.decision, row.subject_id),
        reason: row.reason,
        operatorId: row.operator_id,
        at: toIso(row.created_at, `human_decisions.${row.subject_id}.created_at`),
      });
    }
    return map;
  }

  async #artifacts(
    db: DbClient,
    engagementId: string,
    findings: readonly FindingRow[],
  ): Promise<ReadonlyMap<string, ArtifactRow>> {
    const refs = new Set<string>();
    for (const row of findings) {
      for (const ref of asStringArray(row.evidence_refs, `findings.${row.id}.evidence_refs`)) refs.add(ref);
    }
    if (refs.size === 0) return new Map();
    const found = await db.query<ArtifactRow>(SQL_ARTIFACTS, [engagementId, [...refs]]);
    return new Map(found.rows.map((row) => [row.id, row]));
  }

  async #phaseTimeline(db: DbClient, engagementId: string): Promise<readonly PhaseTimelineEntry[]> {
    const found = await db.query<TransitionRow>(SQL_TRANSITIONS, [engagementId]);
    return found.rows.map((row, index) => ({
      resultingVersion: asNumber(row.resulting_version, `state_transitions[${index}].resulting_version`),
      fromPhase: row.from_phase,
      toPhase: row.to_phase,
      transitionType: row.transition_type,
      forced: row.forced === true,
      reason: row.reason,
      createdAt: toIso(row.created_at, `state_transitions[${index}].created_at`),
    }));
  }

  async #nextVersion(db: DbClient, engagementId: string): Promise<number> {
    const found = await db.query<{ version: number | string }>(SQL_NEXT_VERSION, [engagementId]);
    const row = found.rows[0];
    if (row === undefined) {
      throw new ReportServiceError('报告版本号查询未返回行：无法分配版本（拒绝猜测）');
    }
    return asNumber(row.version, 'reports.next_version');
  }

  async #latestReport(db: DbClient, engagementId: string): Promise<LatestReport | undefined> {
    const found = await db.query<ReportRow>(SQL_LATEST_REPORT, [engagementId]);
    const row = found.rows[0];
    if (row === undefined) return undefined;
    const projection = parseReportProjection(row.projection_json);
    return {
      version: asNumber(row.version, 'reports.version'),
      projection,
      editedContent: row.edited_content,
      contentHash: row.content_hash,
    };
  }

  /** 有版本就用该版本的投影（与人类审阅/签字的对象一致）；没有版本则现投影一版（不落库）。 */
  async #renderSource(db: DbClient, engagementId: string): Promise<ReportProjection> {
    const latest = await this.#latestReport(db, engagementId);
    if (latest !== undefined) return latest.projection;
    const body = await this.#project(db, engagementId);
    return { kind: 'pentest.report.projection', version: 0, ...body };
  }

  /** 导出用：没有报告版本时先落一版草稿（§16.1.1「签字前也允许导出」）。 */
  async #latestOrDraft(db: DbClient, engagementId: string): Promise<LatestReport> {
    const latest = await this.#latestReport(db, engagementId);
    if (latest !== undefined) return latest;
    await this.getReportDraft(engagementId);
    const created = await this.#latestReport(db, engagementId);
    if (created === undefined) {
      throw new ReportServiceError(`engagement ${engagementId} 的草稿刚写入却读不回：拒绝导出空报告`);
    }
    return created;
  }

  // ── 事务与锁 ──

  /** engagement 级 advisory lock：结论采纳与报告版本号分配的串行点（§15.4）。 */
  async #lock(db: DbClient, engagementId: string): Promise<void> {
    await db.query(SQL_ACQUIRE_LOCK, [engagementLockKey(engagementId).toString()]);
  }

  /** 事务边界：提交/回滚只包住写路径，异常不吞；共享写连接上的服务复用同一调度器。 */
  async #withTransaction<T>(run: (tx: DbClient) => Promise<T>): Promise<T> {
    return this.#txRunner.run(run);
  }
}

// ───────────────────────────── 行 → 契约对象 ─────────────────────────────

function parseStatus(value: string): FindingStatus {
  if (!FINDING_STATUS_SET.has(value)) {
    throw new ReportServiceError(`findings.status 取值非法：${JSON.stringify(value)}`);
  }
  return value as FindingStatus;
}

function parseSeverity(value: string | null): Severity | null {
  if (value === null) return null;
  if (!SEVERITY_SET.has(value)) {
    throw new ReportServiceError(`findings.severity 取值非法：${JSON.stringify(value)}`);
  }
  return value as Severity;
}

function toFinding(row: FindingRow): Finding {
  return {
    id: row.id,
    engagementId: row.engagement_id,
    title: row.title,
    severity: parseSeverity(row.severity),
    status: parseStatus(row.status),
    affectedAssetIds: asStringArray(row.affected_asset_ids, `findings.${row.id}.affected_asset_ids`),
    evidenceRefs: asStringArray(row.evidence_refs, `findings.${row.id}.evidence_refs`),
    reproductionSteps: asStepArray(row.reproduction_steps, `findings.${row.id}.reproduction_steps`),
    impact: row.impact,
    remediation: row.remediation,
    confidence: asOptionalNumber(row.confidence, `findings.${row.id}.confidence`),
    acceptedBy: row.accepted_by,
    acceptedAt: row.accepted_at === null ? null : toIso(row.accepted_at, `findings.${row.id}.accepted_at`),
  };
}
