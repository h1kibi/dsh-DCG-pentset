/**
 * 交接上下文的**真压缩**（2026-10-07）。
 *
 * ── 为什么要有它 ──
 *
 * 交接的本质是"跨阶段的一次压缩转发"，而在此之前压缩源只有两处拼接：状态便签（≤600 字符）
 * 与上一份报告的 `summary`。两者都是**人写/Agent 写的摘要**，不是对上一阶段材料的压缩——
 * 上一阶段真正发生了什么的载体（事件账本、报告明细、PINNED 的人类决策）并没有被**压成一段
 * 可注入的文字**。memory_search 不能替代它：检索是"想起来才查"，注入是"保证看见"。
 *
 * ── 谁来做压缩 ──
 *
 * **用会话当前的模型**（操作者裁定 2026-10-07）：调用方传入源会话 `model_route` 里的模型名，
 * 数据不外发给另一个模型；本地小模型明确不用。
 *
 * ── 纪律 ──
 *
 *   1. **纯逻辑与 IO 分开**：`buildCompressionPrompt` / `parseCompressionOutput` 是纯函数，
 *      可穷举断言；`compressHandoffContext` 只负责一次 HTTP 调用。
 *   2. **PINNED 原文不参与压缩**：人类决策/插话这类"永不压缩"的条目（与 `compaction.ts` 同一份
 *      清单）必须**原样保留在材料里**，由模型原样转述——压缩可以丢推理，不能丢人的话。
 *   3. **失败即退回**：超时/解析失败/无配置一律返回 `ok: false`，由调用方退回现有拼接，
 *      并在 `limitations` 里如实说明"这次没压缩成"。
 */
import { COMPRESSION_MAX_CHARS, COMPRESSION_TIMEOUT_MS } from '../contracts.ts';

export interface CompressionMaterial {
  readonly fromPhaseLabel: string;
  readonly toPhaseLabel: string;
  /** 状态便签（Agent 写的压缩产物，≤ `DEFAULTS.statusNoteMaxChars`）。 */
  readonly statusNote: string;
  /** 上一份未取代报告的要点与其 id（可回溯）。 */
  readonly reportSummary: string;
  readonly reportId: string | null;
  /** 永不压缩的条目原文（人类决策 / 插话）；原样进入材料，要求模型原样转述。 */
  readonly pinned: readonly string[];
  /** 可被压缩的近期事件正文（已截断），按时间正序。 */
  readonly recent: readonly string[];
  /** 输出上限（字符）。 */
  readonly maxChars?: number;
}

export interface CompressionPrompt {
  readonly system: string;
  readonly user: string;
}

/**
 * 压缩提示词（纯函数）。
 *
 * 输出契约写死在 system 里：**四段固定标题**（结论 / 证据 / 未决 / 边界）+ 事实约束。
 * 不这么写的话模型会写成散文，而下一阶段的 Agent 需要的是能直接当约束用的条目。
 */
export function buildCompressionPrompt(material: CompressionMaterial): CompressionPrompt {
  const maxChars = material.maxChars ?? COMPRESSION_MAX_CHARS;
  const system =
    '你是渗透测试的交接压缩器。把上一阶段的工作材料压成一段给下一阶段 Agent 看的交接要点。' +
    '只依据材料，不推断、不补充、不美化；材料里没有的信息一律不写。' +
    '人类决策与插话（下面标为「人类原话」的部分）必须原样保留，可以整理顺序，不得改写内容。' +
    '输出用以下四个标题，每段用短句或条目，不要散文，不要客套，不要解释你在做什么：\n' +
    '# 结论\n# 证据\n# 未决\n# 边界\n' +
    `总长不超过 ${String(maxChars)} 字符。`;
  const parts: string[] = [
    `阶段：${material.fromPhaseLabel} → ${material.toPhaseLabel}`,
    material.statusNote.trim() === '' ? '' : `## 状态便签（Agent 自述）\n${material.statusNote.trim()}`,
    material.reportSummary.trim() === ''
      ? ''
      : `## 上一阶段报告${material.reportId === null ? '' : `（${material.reportId}）`}\n${material.reportSummary.trim()}`,
    material.pinned.length === 0
      ? ''
      : `## 人类原话（永不压缩，原样保留）\n${material.pinned.map((line) => `- ${line}`).join('\n')}`,
    material.recent.length === 0 ? '' : `## 近期过程（可压缩）\n${material.recent.join('\n')}`,
  ];
  return { system, user: parts.filter((part) => part !== '').join('\n\n') };
}

/**
 * 解析模型输出（纯函数）：剥掉代码围栏、去首尾空白、按上限截断。
 *
 * 截断在**这里**做而不是信模型：模型经常无视长度上限，而提示词长度是硬约束。
 */
export function parseCompressionOutput(raw: string, maxChars: number = COMPRESSION_MAX_CHARS): string {
  const withoutFence = raw
    .replace(/^\s*```[a-zA-Z]*\s*\n/, '')
    .replace(/\n?```\s*$/, '')
    .trim();
  return withoutFence.length <= maxChars ? withoutFence : withoutFence.slice(0, maxChars).trimEnd();
}

export interface CompressionClientConfig {
  readonly endpoint: string;
  readonly apiKey: string;
  readonly model: string;
  readonly timeoutMs?: number;
  /** 注入点（测试用）；省略即用全局 `fetch`。 */
  readonly fetchImpl?: typeof fetch;
}

/**
 * 一次压缩调用。**任何失败都返回 `ok: false`**，绝不抛给调用方——交接起草是人点出来的动作，
 * 不能因为一次模型调用失败而让人点不动。
 */
export async function compressHandoffContext(
  config: CompressionClientConfig,
  material: CompressionMaterial,
): Promise<{ ok: true; text: string; model: string } | { ok: false; reason: string }> {
  const prompt = buildCompressionPrompt(material);
  const timeoutMs = config.timeoutMs ?? COMPRESSION_TIMEOUT_MS;
  const doFetch = config.fetchImpl ?? fetch;
  try {
    const response = await doFetch(config.endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${config.apiKey}` },
      body: JSON.stringify({
        model: config.model,
        messages: [
          { role: 'system', content: prompt.system },
          { role: 'user', content: prompt.user },
        ],
        temperature: 0,
        stream: false,
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) return { ok: false, reason: `HTTP ${String(response.status)}` };
    const body: unknown = await response.json();
    const text = readFirstChoice(body);
    if (text === null) return { ok: false, reason: '响应里没有 choices[0].message.content' };
    const parsed = parseCompressionOutput(text, material.maxChars ?? COMPRESSION_MAX_CHARS);
    if (parsed === '') return { ok: false, reason: '模型返回空内容' };
    return { ok: true, text: parsed, model: config.model };
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  }
}

/** 从 OpenAI 兼容响应里取第一条消息正文；形状不对返回 null（不猜、不硬转）。 */
function readFirstChoice(body: unknown): string | null {
  if (typeof body !== 'object' || body === null || !('choices' in body)) return null;
  const choices = body.choices;
  if (!Array.isArray(choices) || choices.length === 0) return null;
  const first: unknown = choices[0];
  if (typeof first !== 'object' || first === null || !('message' in first)) return null;
  const message = first.message;
  if (typeof message !== 'object' || message === null || !('content' in message)) return null;
  return typeof message.content === 'string' ? message.content : null;
}
