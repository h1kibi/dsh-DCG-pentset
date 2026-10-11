/**
 * 模型可见结果的**命名规范**（《沙箱工具规范 v1》§7）：宿主侧 JSON 一律 `snake_case`。
 *
 * ── 为什么需要"边界映射"而不是全库改名 ──
 *
 * 内部类型（`ArtifactRecord` / `MemoryRecord` / `MemorySearchResult`）的字段是 camelCase，而且
 * 它们同时被**控制台客户端**（`src/client/views/ReportExport.tsx`）与**报告服务**（`src/report/pg-report.ts`）
 * 消费——全库改名要动那两处（以及它们的测试），风险与收益不成比例。
 *
 * 但**模型读到的字段必须统一**：`pentest_exec` 给的是 `artifact_id` / `evidence_host_path`（snake），
 * 而 `artifact_read` 以前给的是 `artifactId` / `mediaType` / `storageRef`（camel）——同一个概念两种拼法，
 * 模型在报告里引用时很容易写错键名（2026-10-11 质检 §三 3.3：出参字段零文档，只能靠调用一次才知道）。
 *
 * 所以规范落在**边界**：工具返回前过一次映射，且映射结果有**具名类型**——它同时是
 * "模型看到什么"的契约（工具描述里写的字段清单就是这个类型）与测试的断言对象。
 *
 * ── 改名时的纪律 ──
 *
 * 改这里的字段名 = 改模型看到的契约 ⇒ 必须同步改提示词里引用它的地方（阶段档案/参数指南/技能），
 * 否则就是新的漂移源（`index_watermark` 就是这么一次协同改名：2026-10-11）。
 */

import type {
  ArtifactRecord,
  MemoryRecord,
  MemorySearchResult,
  WorkerToolDeps,
} from './worker.ts';
import type { BootstrapIntakeResult, ExecutionPlan, ToolRunResult } from '../contracts.ts';
import type {
  WorkdirEntry,
  WorkdirFile,
  WorkdirListing,
  WorkdirMatch,
  WorkdirSearchResult,
  WorkdirWriteResult,
} from '../execution/workdir.ts';

/** `artifact_read` 的模型可见形状。 */
export interface ArtifactView {
  readonly artifact_id: string;
  readonly media_type: string;
  readonly byte_size: number;
  readonly content_hash: string;
  /** 已授权解密后的原文（仅"未加密 + 内联 + 文本类 + 未超阈值"时才有）。 */
  readonly inline?: string;
  /** 受控引用（文件证据是宿主路径）——与 `inline` **必有其一**。 */
  readonly storage_ref?: string;
  readonly truncated: boolean;
  /**
   * 证据元数据：**不透明数据**（由写入方决定内容）——本规范只约定**字段名**是 `metadata`，
   * 不约束它内部的键（那可能是任何来源的 JSON）。
   */
  readonly metadata: unknown;
}

/** `memory_read` 的模型可见形状（每条）。 */
export interface MemoryRecordView {
  readonly memory_id: string;
  readonly content: string;
  readonly content_hash: string;
  readonly occurred_at: string;
  readonly origin_worker_session_id: string | null;
  readonly trust: string;
  readonly classification: string;
  readonly provisional: boolean;
  readonly related_event_ids: readonly string[];
}

/** `memory_search` 的模型可见形状。 */
export interface MemorySearchView {
  readonly hits: readonly {
    readonly memory_id: string;
    readonly excerpt: string;
    readonly score: number;
    readonly source: {
      readonly event_id: string;
      readonly worker_session_id: string;
      readonly phase: string;
      readonly occurred_at: string;
    };
    readonly trust: string;
    readonly citation: string;
  }[];
  readonly index_watermark: number;
  /** 零命中/降级时的诊断说明（"索引为空"与"没命中"是两种处置）。 */
  readonly note?: string;
}

/** `artifact_read` 的模型可见形状（规范 §7）。 */
export function artifactView(record: ArtifactRecord): ArtifactView {
  return {
    artifact_id: record.artifactId,
    media_type: record.mediaType,
    byte_size: record.byteSize,
    content_hash: record.contentHash,
    ...(record.inline === undefined ? {} : { inline: record.inline }),
    ...(record.storageRef === undefined ? {} : { storage_ref: record.storageRef }),
    truncated: record.truncated,
    metadata: record.metadata,
  };
}

/** `memory_read` 的模型可见形状（规范 §7）。 */
export function memoryRecordsView(records: readonly MemoryRecord[]): readonly MemoryRecordView[] {
  return records.map((record) => ({
    memory_id: record.memoryId,
    content: record.content,
    content_hash: record.contentHash,
    occurred_at: record.occurredAt,
    origin_worker_session_id: record.originWorkerSessionId,
    trust: record.trust,
    classification: record.classification,
    provisional: record.provisional,
    related_event_ids: record.relatedEventIds,
  }));
}

/** `memory_search` 的模型可见形状（规范 §7）。 */
export function memorySearchView(result: MemorySearchResult): MemorySearchView {
  return {
    hits: result.hits.map((hit) => ({
      memory_id: hit.memoryId,
      excerpt: hit.excerpt,
      score: hit.score,
      source: {
        event_id: hit.source.eventId,
        worker_session_id: hit.source.workerSessionId,
        phase: hit.source.phase,
        occurred_at: hit.source.occurredAt,
      },
      trust: hit.trust,
      citation: hit.citation,
    })),
    index_watermark: result.indexWatermark,
    ...(result.note === undefined ? {} : { note: result.note }),
  };
}

// ───────────────────────────── 作业目录（`pentest_workdir`） ─────────────────────────────

/** 挂载根：只给模型**容器路径 + 只读标记**（宿主路径是部署事实，模型不需要它做事）。 */
export interface WorkdirRootView {
  readonly container_path: string;
  readonly read_only: boolean;
}

/** 目录列表项。 */
export interface WorkdirEntryView {
  readonly name: string;
  readonly type: WorkdirEntry['type'];
  readonly size?: number;
}

/** `op=list` 的模型可见形状。 */
export interface WorkdirListingView {
  readonly path: string;
  readonly root: string;
  readonly container_path: string;
  readonly entries: readonly WorkdirEntryView[];
  readonly truncated: boolean;
  readonly roots: readonly WorkdirRootView[];
}

/** `op=read` 的模型可见形状。 */
export interface WorkdirFileView {
  readonly path: string;
  readonly container_path: string;
  readonly bytes: number;
  readonly text: string;
  readonly truncated: boolean;
  readonly binary: boolean;
}

/** `op=write` / `op=append` 的模型可见形状。 */
export interface WorkdirWriteView {
  readonly path: string;
  readonly container_path: string;
  readonly bytes: number;
}

/** `op=search` 的模型可见形状（命中行 + 命中文件清单）。 */
export interface WorkdirSearchView {
  readonly path: string;
  readonly pattern: string;
  readonly matches: readonly WorkdirMatch[];
  readonly files: readonly { readonly path: string; readonly modified_at: string; readonly matches: number }[];
  readonly files_scanned: number;
  readonly truncated: boolean;
  readonly skipped: readonly string[];
}

export function workdirRootsView(
  roots: readonly { readonly containerPath: string; readonly readOnly?: boolean }[],
): readonly WorkdirRootView[] {
  return roots.map((root) => ({
    container_path: root.containerPath,
    read_only: root.readOnly === true,
  }));
}

export function workdirListingView(
  listing: WorkdirListing,
  roots: readonly { readonly containerPath: string; readonly readOnly?: boolean }[],
): WorkdirListingView {
  return {
    path: listing.path,
    root: listing.root,
    container_path: listing.containerPath,
    entries: listing.entries.map((entry) => ({
      name: entry.name,
      type: entry.type,
      ...(entry.size === undefined ? {} : { size: entry.size }),
    })),
    truncated: listing.truncated,
    // 挂载根随列表回给模型（它据此判断"写新文件要不要带容器路径前缀"）。
    roots: workdirRootsView(roots),
  };
}

export function workdirFileView(file: WorkdirFile): WorkdirFileView {
  return {
    path: file.path,
    container_path: file.containerPath,
    bytes: file.bytes,
    text: file.text,
    truncated: file.truncated,
    binary: file.binary,
  };
}

export function workdirWriteView(result: WorkdirWriteResult): WorkdirWriteView {
  return { path: result.path, container_path: result.containerPath, bytes: result.bytes };
}

export function workdirSearchView(result: WorkdirSearchResult): WorkdirSearchView {
  return {
    path: result.path,
    pattern: result.pattern,
    matches: result.matches,
    files: result.files.map((hit) => ({
      path: hit.path,
      modified_at: hit.modifiedAt,
      matches: hit.matches,
    })),
    files_scanned: result.filesScanned,
    truncated: result.truncated,
    skipped: result.skipped,
  };
}

// ─────────────── 其余工具面（2026-10-11 复查：这些此前都是直通内部类型） ───────────────

/** `pentest_bootstrap_intake` 的模型可见形状。 */
export function intakeView(result: BootstrapIntakeResult): Record<string, unknown> {
  return {
    engagement_id: result.engagementId,
    worker_session_id: result.workerSessionId,
    dsh_session_id: result.dshSessionId,
    lease_id: result.leaseId,
    lease_generation: result.leaseGeneration,
    scope_version: result.scopeVersion,
    resumed: result.resumed,
    next_step: result.nextStep,
  };
}

/** 执行计划：模型在报告里引用它（`plan_hash`/`template_id`），因此**字段名也是契约**。 */
export function planView(plan: ExecutionPlan): Record<string, unknown> {
  return {
    worker_session_id: plan.workerSessionId,
    template_id: plan.templateId,
    action_class: plan.actionClass,
    normalized_target: plan.normalizedTarget,
    resolved_addresses: plan.resolvedAddresses,
    normalized_command: plan.normalizedCommand,
    ...(plan.displayCommand === undefined ? {} : { display_command: plan.displayCommand }),
    plan_hash: plan.planHash,
    idempotency_key: plan.idempotencyKey,
    scope_version: plan.scopeVersion,
    policy_epoch: plan.policyEpoch,
    ...(plan.policyVersion === undefined ? {} : { policy_version: plan.policyVersion }),
    ...(plan.pacing === undefined ? {} : { pacing: plan.pacing }),
    lease_generation: plan.leaseGeneration,
    ...(plan.approvalId === undefined ? {} : { approval_id: plan.approvalId }),
    timeout_ms: plan.timeoutMs,
    max_output_bytes: plan.maxOutputBytes,
  };
}

/** 一次执行的**结果**（沙箱层形状）的模型可见形态。 */
export function toolRunResultView(result: ToolRunResult): Record<string, unknown> {
  return {
    status: result.status,
    ...(result.exitCode === undefined ? {} : { exit_code: result.exitCode }),
    ...(result.stdout === undefined ? {} : { stdout: result.stdout }),
    ...(result.stderr === undefined ? {} : { stderr: result.stderr }),
    ...(result.truncated === undefined ? {} : { truncated: result.truncated }),
    ...(result.artifactIds === undefined ? {} : { artifact_ids: result.artifactIds }),
    ...(result.error === undefined ? {} : { error: result.error }),
    ...(result.toolRunId === undefined ? {} : { tool_run_id: result.toolRunId }),
  };
}

/** `pentest_submit_report` 的模型可见形状（含 `mode: append` 的合并信息）。 */
export function reportResultView(result: Awaited<ReturnType<WorkerToolDeps['submitReport']>>): Record<string, unknown> {
  return {
    report_id: result.reportId,
    state_version: result.stateVersion,
    findings: result.findings,
    ...(result.merged === undefined
      ? {}
      : {
          merged: {
            mode: result.merged.mode,
            base_report_id: result.merged.baseReportId,
            sections: result.merged.sections,
          },
        }),
  };
}

/** `pentest_request_action_approval` 的模型可见形状。 */
export function approvalView(result: Awaited<ReturnType<WorkerToolDeps['requestApproval']>>): Record<string, unknown> {
  return {
    approval_id: result.approvalId,
    plan_hash: result.planHash,
    expires_at: result.expiresAt,
  };
}

/**
 * 范围方案的模型可见形状（`targets` 内的字段同样是契约）。
 *
 * **刻意不含 `authorization_note`**：那是留痕字段，服务端收下即可；一旦出现在回显里，模型会
 * 在回复里复述"本部署不要求授权凭据"这类元话术（2026-10-11 之前的实测）。人类侧的方案卡片
 * 读库里的行，不依赖这个回显 ⇒ 这里与工具层摘字段的意图保持一致。
 */
export function scopeProposalView(proposal: {
  readonly id: string;
  readonly engagementId: string;
  readonly workerSessionId: string;
  readonly objective: string;
  readonly targets: readonly unknown[];
  readonly exclusions: readonly unknown[];
  readonly allowedActions: readonly string[];
  readonly status: string;
  readonly createdAt: string;
  readonly decidedAt: string | null;
}): Record<string, unknown> {
  return {
    id: proposal.id,
    engagement_id: proposal.engagementId,
    worker_session_id: proposal.workerSessionId,
    objective: proposal.objective,
    targets: proposal.targets,
    exclusions: proposal.exclusions,
    allowed_actions: proposal.allowedActions,
    status: proposal.status,
    created_at: proposal.createdAt,
    decided_at: proposal.decidedAt,
  };
}

/** `skill_load` 的模型可见形状（技能条目；正文 `body` 原样给）。 */
export function skillView(skill: {
  readonly name: string;
  readonly description: string;
  readonly body: string;
  readonly contentHash: string;
  readonly revision: number;
}): Record<string, unknown> {
  return {
    name: skill.name,
    description: skill.description,
    body: skill.body,
    content_hash: skill.contentHash,
    revision: skill.revision,
  };
}
