/**
 * 报告载荷的**合并**（`mode: 'append'`，2026-10-11 操作者诉求 #2）。
 *
 * ── 为什么要有它 ──
 *
 * 一份真实报告有几 KB（操作者那次：21 条 facts + 5 条候选）。模型按"错一个改一个"的节奏
 * 重发整份，每次都是几千 token；而绝大多数补交是**追加几条**，不是重写全文。
 *
 * ── 语义（三条，够用且可预期）──
 *
 *   1. **数组追加（深等值去重）**：`facts`/`candidate_findings` 这类分段是列表，补交就是往后接。
 *      去重按**深等值**：同一份增量重发两次（超时重试、模型重试）不会把条目翻倍。
 *   2. **对象递归合并**：载荷是对象、增量也是对象时，逐键合并（分段下面还有一层对象的情况）。
 *   3. **其余（标量、类型冲突、缺失）由增量覆盖**：拒绝猜测"合并"两个不同形状的值——
 *      覆盖是最可预期的选择，且新旧两份载荷都留在 `worker_reports` 里可回溯。
 *
 * 调用方负责保证：合并的基底是**同一会话同一次尝试**的当前报告（见 `PgWorkerTools.submitReport`），
 * 而不是某个历史版本——否则"追加"会接在人类已经审阅过的旧版后面。
 */

/** 深等值（只处理 JSON 值；NaN/函数/类实例不在载荷里）。 */
function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b || a === null || b === null) return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((item, index) => deepEqual(item, b[index]));
  }
  if (typeof a === 'object') {
    const left = a as Record<string, unknown>;
    const right = b as Record<string, unknown>;
    const keys = Object.keys(left);
    if (keys.length !== Object.keys(right).length) return false;
    return keys.every((key) => Object.hasOwn(right, key) && deepEqual(left[key], right[key]));
  }
  return false;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * 合并载荷。`base` 是既有载荷（可为 `undefined`/`null`），`delta` 是本次提交的增量。
 *
 * **不修改入参**：返回新对象（既有载荷来自 `payload_json`，直接改它会让"旧版本"跟着变）。
 */
export function mergeReportPayload(base: unknown, delta: unknown): unknown {
  if (isPlainObject(base) && isPlainObject(delta)) {
    const merged: Record<string, unknown> = { ...base };
    for (const [key, value] of Object.entries(delta)) {
      merged[key] = Object.hasOwn(base, key) ? mergeReportPayload(base[key], value) : value;
    }
    return merged;
  }
  if (Array.isArray(base) && Array.isArray(delta)) {
    const appended = delta.filter((item) => !base.some((existing) => deepEqual(existing, item)));
    return [...base, ...appended];
  }
  return delta;
}

/**
 * 载荷各分段条数（给提交返回用）：让模型自己确认"补进去的这条真的在里头"，
 * 而不是靠"我发出去了"推断。只统计数组分段。
 */
export function reportPayloadSectionCounts(payload: unknown): Record<string, number> {
  if (!isPlainObject(payload)) return {};
  const counts: Record<string, number> = {};
  for (const [key, value] of Object.entries(payload)) {
    if (Array.isArray(value)) counts[key] = value.length;
  }
  return counts;
}
