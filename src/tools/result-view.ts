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

import type { ArtifactRecord, MemoryRecord, MemorySearchResult } from './worker.ts';

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
