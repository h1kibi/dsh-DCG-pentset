/**
 * 交接草稿与交接包的校验（设计文档 §7.2、§7.3）。
 *
 * 两条硬约束：
 *   - 必需键**不是交接结构里的独立字段**，而是从交接上下文中解析出的引用集合，
 *     解析来源固定为 §7.2 的表；本模块只回答"已声明的键能否解析",不推断语义完整性；
 *   - 校验是**纯函数**：不派发、不改状态、不调用模型。确认切换前先证明交接完整，
 *     再允许它驱动下游。
 *
 * ── 重建说明（2026-10-04）──
 *
 * 本文件在「pg-workflow 拆分」的机械搬运中被流程文件误覆盖（同名冲突）。
 * 现依据拆分前的构建产物重建：`lib/workflow/handoff.js`（tsc 发射时保留了全部注释，
 * 逻辑逐字未改）+ `lib/types/workflow/handoff.d.ts`（导出签名与类型）。
 * 内部辅助函数的类型注解按使用处推导——它们不影响行为；测试（`test/handoff.test.ts`）
 * 是重建正确性的验收依据。
 */

import { createHash } from 'node:crypto';
import { canonicalJson } from '../canonical.ts';
import {
  HANDOFF_MAX_CONTEXT_REFS,
  HANDOFF_TRANSITION_TYPES,
  NULLABLE_HANDOFF_KEYS,
  REQUIRED_HANDOFF_KEYS,
  TRANSITION_TYPES,
} from '../contracts.ts';
import type {
  ContextRef,
  HandoffPackage,
  HandoffTransitionType,
  HandoffValidation,
  RequiredHandoffKey,
  ToolError,
} from '../contracts.ts';

const DEFAULT_HANDOFF_HASH_ALGORITHM = 'sha256';

/**
 * 交接包里**引用列表**的上限（设计 §8.10.1：被截断的引用要写进交接包）。
 *
 * 注进下一会话的不是正文而是引用清单（agent 自己用检索去取），所以这里的"截断"截的是
 * **引用条数**，不是正文长度：条数过多会把提示词里那份信封撑大，而其中绝大多数引用
 * 下一 Agent 根本不会读。溢出的部分进 `truncatedRefs`，它据此知道"还有哪些没带过来、可主动检索"。
 *
 * 顺序保持不变（人类在弹窗里排的序就是优先级），因此截断是确定性的——同一份确认输入
 * 永远得到同一个交接包内容哈希。
 *
 * 常量本身在契约层（`contracts.ts`）：控制台要在确认前就提示预算，而本模块 import 了
 * `node:crypto`，不能进浏览器包。这里再导出一次，方便服务端调用方就近引用。
 */
export { HANDOFF_MAX_CONTEXT_REFS } from '../contracts.ts';

interface CappedContextRefs {
  /** 进入交接包的引用（保持原顺序）。 */
  readonly kept: readonly string[];
  /** 因超预算未进入交接包的引用（顺序不变）——写入交接包供下一 Agent 检索补齐。 */
  readonly truncated: readonly string[];
}

/**
 * 引用分块元信息的输入行（只取审计需要的四列）。
 */
export interface ContextChunkMeta {
  readonly id: string;
  readonly classification: string;
  readonly trust_level: string;
  readonly provisional: boolean;
}

/**
 * 把记忆分块的元信息补回引用列表（纯函数：不查库，由调用方取数）。
 *
 * 匹配不到的行**保持原样**（`kind`/`trust` 留空）——不猜、不填默认值：界面上留空
 * 表示「服务端没补到」，伪造一个 `tool_observation` 会让审计看到假的可信度。
 */
export function enrichContextRefs(
  refs: readonly ContextRef[],
  chunks: readonly ContextChunkMeta[],
): readonly ContextRef[] {
  const byId = new Map(chunks.map((chunk) => [chunk.id, chunk]));
  return refs.map((ref) => {
    const chunk = byId.get(ref.memoryId.replace(/^memory:/, ''));
    if (chunk === undefined) return ref;
    return {
      ...ref,
      kind: chunk.classification,
      trust: chunk.trust_level,
      provisional: chunk.provisional,
    };
  });
}

/** 按 {@link HANDOFF_MAX_CONTEXT_REFS} 切分人工确认过的引用列表。 */
export function capContextRefs(
  refs: readonly string[],
  max: number = HANDOFF_MAX_CONTEXT_REFS,
): CappedContextRefs {
  if (!Number.isInteger(max) || max < 1) throw new HandoffProtocolError(`引用上限非法：${String(max)}`);
  const unique = uniqueStable([...refs]);
  if (unique.length <= max) return { kept: unique, truncated: [] };
  return { kept: unique.slice(0, max), truncated: unique.slice(max) };
}

interface HandoffViolationContext {
  readonly draftId?: string;
  readonly transitionType?: unknown;
  readonly requiredKeys?: readonly string[];
}

/**
 * 调用方或配置违反协议（Profile 声明了未注册的必需键、为交接包构造了不产生交接记录的
 * 转移类型）。这类问题必须在开发期显式暴露，不静默降级成"缺键"。
 */
export class HandoffProtocolError extends Error {
  readonly draftId: string | null;
  readonly transitionType: string | null;
  readonly requiredKeys: readonly string[];

  constructor(message: string, context: HandoffViolationContext = {}) {
    const detail = [
      context.draftId === undefined ? null : `草稿=${context.draftId}`,
      context.transitionType === undefined ? null : `转移类型=${String(context.transitionType)}`,
      context.requiredKeys === undefined ? null : `必需键=${context.requiredKeys.join('/')}`,
    ]
      .filter((part) => part !== null)
      .join('，');
    super(detail === '' ? message : `${message}（${detail}）`);
    this.name = 'HandoffProtocolError';
    this.draftId = context.draftId ?? null;
    this.transitionType =
      context.transitionType === undefined ? null : String(context.transitionType);
    this.requiredKeys = context.requiredKeys ?? [];
  }
}

// ───────────────────────────── 转移类型 ─────────────────────────────

/** 交接包只取产生交接记录的四种转移类型（§5.4、`handoffs.transition_type` 取值域）。 */
export function isHandoffTransitionType(v: unknown): v is HandoffTransitionType {
  return typeof v === 'string' && (HANDOFF_TRANSITION_TYPES as readonly string[]).includes(v);
}

function illegalTransitionMessage(transitionType: unknown): string {
  const allowed = HANDOFF_TRANSITION_TYPES.join('/');
  if (
    typeof transitionType === 'string' &&
    (TRANSITION_TYPES as readonly string[]).includes(transitionType)
  ) {
    return `转移类型 ${transitionType} 不产生交接记录（§5.4），不得出现在交接包里；交接包只取 ${allowed}`;
  }
  return `未知转移类型 ${String(transitionType)}；交接包只取 ${allowed}`;
}

/**
 * 手工构造交接包时的前置断言；`validateHandoff` 内部也会做同样检查。
 * 例如 `interject_wake` 是插话唤醒的转移记录，没有交接记录，重试它只会得到同一个拒绝。
 */
export function assertHandoffTransitionType(
  transitionType: unknown,
  draftId?: string,
): HandoffTransitionType {
  if (!isHandoffTransitionType(transitionType)) {
    throw new HandoffProtocolError(illegalTransitionMessage(transitionType), {
      transitionType,
      draftId,
    });
  }
  return transitionType;
}

const ASSET_CHUNK_KINDS: Readonly<Record<string, true>> = { asset: true, assets: true };
const FINDING_CHUNK_KINDS: Readonly<Record<string, true>> = { finding: true, findings: true };

function uniqueStable(values: readonly string[]): string[] {
  return [...new Set(values.filter((value) => value.length > 0))];
}

/**
 * `approved_context_refs` 中的一条引用解析出的分块。
 * `kind` 由记忆层给出（`null` 表示未知），决定该分块是否"指向资产 / 指向结论"。
 */
export interface ResolvedContextChunk {
  /** 与 `approvedContextRefs` 中的字符串同一标识形式（如 `memory:<uuid>`）。 */
  readonly memoryId: string;
  readonly kind: string | null;
  /** 分块携带的资产引用（`memory_chunks.asset_ids`）。 */
  readonly assetIds?: readonly string[];
  /** 分块携带的结论引用（`memory_chunks.finding_ids`）。 */
  readonly findingIds?: readonly string[];
}

export interface HandoffResolutionContext {
  /** 已确认的上下文引用解析出的分块；未解析出的引用不贡献任何键。 */
  readonly resolvedChunks?: readonly ResolvedContextChunk[];
}

/** 新会话绑定的范围版本（§5.4 的 `scope_versions`）。 */
export interface BoundScopeVersion {
  readonly version: number;
  /** 当前版本的纳入资产集合（`asset_scope_versions.decision = 'included'`）。 */
  readonly includedAssetIds?: ReadonlySet<string>;
}

/** 每个必需键解析出的引用集合；空数组即"解析为空"（§7.2 阻止确认）。 */
type ResolvedHandoffKeys = Readonly<Record<RequiredHandoffKey, readonly string[]>>;

/**
 * §7.2 的解析来源表，逐条实现：
 *   `asset_refs`     ← `approved_context_refs` 中指向资产的分块携带的 `asset_ids`，
 *                      并入新会话绑定范围版本的纳入集合
 *   `scope_version`  ← 新会话绑定的范围版本
 *   `finding_refs`   ← `approved_context_refs` 中指向结论的分块携带的 `finding_ids`
 *   `approval_scope` ← 交接包的 `approved_approval_required`
 *   `skill_ids`      ← `approved_skill_ids`
 *
 * 未解析出的引用（记忆层查不到该 ref）静默不贡献键：它是否"应当存在"属于引用归属校验，
 * 由调用方在确认前的 schema/归属校验里回答。
 */
export function resolveHandoffKeys(
  pkg: HandoffPackage,
  boundScopeVersion: BoundScopeVersion | null,
  context: HandoffResolutionContext = {},
): ResolvedHandoffKeys {
  const chunksByMemoryId = new Map<string, ResolvedContextChunk>();
  for (const chunk of context.resolvedChunks ?? []) {
    chunksByMemoryId.set(chunk.memoryId, chunk);
  }

  const assetRefs: string[] = [];
  const findingRefs: string[] = [];
  for (const ref of pkg.approvedContextRefs) {
    const chunk = chunksByMemoryId.get(ref);
    if (chunk === undefined) continue;
    const kind = (chunk.kind ?? '').trim().toLowerCase();
    if (ASSET_CHUNK_KINDS[kind] === true) assetRefs.push(...(chunk.assetIds ?? []));
    if (FINDING_CHUNK_KINDS[kind] === true) findingRefs.push(...(chunk.findingIds ?? []));
  }
  if (boundScopeVersion !== null) {
    assetRefs.push(...(boundScopeVersion.includedAssetIds ?? []));
  }

  const boundVersion: readonly string[] =
    boundScopeVersion !== null &&
    Number.isInteger(boundScopeVersion.version) &&
    boundScopeVersion.version >= 1
      ? [String(boundScopeVersion.version)]
      : [];

  return {
    asset_refs: uniqueStable(assetRefs),
    scope_version: boundVersion,
    finding_refs: uniqueStable(findingRefs),
    approval_scope: uniqueStable(pkg.approvedApprovalRequired),
    skill_ids: uniqueStable(pkg.approvedSkillIds),
  };
}

// ───────────────────────────── 校验 ─────────────────────────────

/**
 * 确认切换前的纯函数校验。
 *
 * **两类键的空值判定不同**（契约 `CONTENT_REQUIRED_KEYS` / `NULLABLE_HANDOFF_KEYS`）：
 *   - 内容必需键（`asset_refs` / `scope_version` / `finding_refs`）：空即缺失。
 *     空意味着下游无法工作——没有资产就没法建威胁模型，没有结论就没法验证。
 *   - 可空但须已表决的键（`approval_scope` / `skill_ids`）：空集合算已解析，
 *     **前提是人类显式表决过为空**（`deliberateEmpty`）。
 *     否则"漏了"与"有意为空"无法区分，前者必须被拦住。
 *
 * `skill_ids` 必须是可空类：§2.2 明确"不装载 skill 是合法状态"，
 * 若按空即缺失处理，人类在 §6.6 清空 skill 的合法选择会被卡住。
 *
 * 人类在弹窗中追加的必需键同样按 §7.2 的来源表解析——本函数不做区分。
 * Profile 声明了来源表之外的键时抛 `HandoffProtocolError`：插件没有该键的解析规则，
 * 不能替它猜一个出来，fail loud 好过静默放行或永久阻塞确认。
 */
export function validateHandoff(
  pkg: HandoffPackage,
  requiredKeys: readonly RequiredHandoffKey[],
  boundScopeVersion: BoundScopeVersion | null,
  context: HandoffResolutionContext = {},
  deliberateEmpty: readonly RequiredHandoffKey[] = [],
): HandoffValidation {
  assertHandoffTransitionType(pkg.transitionType, pkg.handoffId);

  const unknownKeys = requiredKeys.filter((key) => !REQUIRED_HANDOFF_KEYS.includes(key));
  if (unknownKeys.length > 0) {
    throw new HandoffProtocolError(
      `Profile 声明了未注册的必需键：${unknownKeys.join('、')}；§7.2 的解析来源表只有 ${REQUIRED_HANDOFF_KEYS.join('/')}`,
      { draftId: pkg.handoffId, requiredKeys: unknownKeys },
    );
  }

  const required = new Set(requiredKeys);
  const emptied = new Set(deliberateEmpty);
  const resolved = resolveHandoffKeys(pkg, boundScopeVersion, context);
  const missing = REQUIRED_HANDOFF_KEYS.filter((key) => {
    if (!required.has(key)) return false;
    if (resolved[key].length > 0) return false;
    // 解析为空：内容必需键一律算缺失；
    // 可空键仅在人类表决过为空（deliberateEmpty）时才放行。
    // 这里必须宽化：`NULLABLE_HANDOFF_KEYS` 的元素类型是 `RequiredHandoffKey` 的**子集**
    // （只有 approval_scope / skill_ids），而 `key` 是全联合——直接 `includes` 会被 TS 拒绝。
    // `REQUIRED_HANDOFF_KEYS` 无此问题（其元素就是全联合），那里不需要断言。
    const nullable = (NULLABLE_HANDOFF_KEYS as readonly string[]).includes(key);
    return !nullable || !emptied.has(key);
  });
  return missing.length === 0 ? { ok: true } : { ok: false, missing };
}

/** 确认前的完整检查：非法转移类型 → 必需键。两者是不同的失败，模型据码分支。 */
interface HandoffConfirmationInput {
  readonly pkg: HandoffPackage;
  /** 目标阶段 Profile 声明的必需键（人类可追加，不可超出来源表）。 */
  readonly requiredKeys: readonly RequiredHandoffKey[];
  readonly boundScopeVersion: BoundScopeVersion | null;
  readonly context?: HandoffResolutionContext;
}

type HandoffConfirmationCheck =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly error: ToolError;
      /** 缺失的必需键；非法转移类型时为空数组。 */
      readonly missing: readonly RequiredHandoffKey[];
    };

export function validateHandoffForConfirmation(input: HandoffConfirmationInput): HandoffConfirmationCheck {
  if (!isHandoffTransitionType(input.pkg.transitionType)) {
    return {
      ok: false,
      missing: [],
      error: {
        status: 'blocked',
        code: 'handoff_transition_illegal',
        message: illegalTransitionMessage(input.pkg.transitionType),
        next_action: `改用 ${HANDOFF_TRANSITION_TYPES.join('/')} 对应的操作；插话唤醒、取消交接、重生成草稿与报告复开都不产生交接记录，不要为它们构造交接包`,
      },
    };
  }
  const validation = validateHandoff(
    input.pkg,
    input.requiredKeys,
    input.boundScopeVersion,
    input.context,
  );
  if (validation.ok) return { ok: true };
  return {
    ok: false,
    missing: validation.missing,
    error: {
      status: 'blocked',
      code: 'handoff_incomplete',
      message: `交接包的必需键解析为空：${validation.missing.join('、')}；确认被阻止`,
      next_action:
        '补齐缺失的必需键（或修正目标阶段 Profile 声明的必需键）后重新确认，不要重试相同交接包',
    },
  };
}

// ───────────────────────────── 内容哈希 ─────────────────────────────

/**
 * 确认时的内容哈希（§6.5 第 6 块、§7.3）。
 *
 * 覆盖字段与 `handoffs` 表的已确认列一致（`content_hash` 自身除外），并含新会话绑定的
 * 范围版本号——同一份内容在不同范围版本下是两次不同的交接，回放确认时必须能分辨。
 * 数组按给定顺序参与哈希：顺序变了就是不同内容（§7.4 按引用优先级截断，顺序有语义）；
 * 对象的键序**不**参与（见 `canonicalJson`：`approved_json` 是 jsonb 列，
 * 读回的键序与写入时不同，不消掉这个自由度就会「同一份内容两个摘要」）。
 */
export function computeHandoffHash(
  pkg: HandoffPackage,
  boundScopeVersion: BoundScopeVersion | null,
  algorithm: string = DEFAULT_HANDOFF_HASH_ALGORITHM,
): string {
  const payload = {
    handoff_id: pkg.handoffId,
    transition_type: pkg.transitionType,
    forced: pkg.forced,
    approved_to_phase: pkg.approvedToPhase,
    approved_prompt: pkg.approvedPrompt,
    approved_context_refs: pkg.approvedContextRefs,
    approved_skill_ids: pkg.approvedSkillIds,
    approved_tool_filter: { allow: pkg.approvedToolFilter.allow },
    approved_approval_required: pkg.approvedApprovalRequired,
    truncated_refs: pkg.truncatedRefs,
    human_decision_ref: pkg.humanDecisionRef,
    scope_version: boundScopeVersion?.version ?? null,
  };
  return createHash(algorithm).update(canonicalJson(payload), 'utf8').digest('hex');
}

/**
 * 草稿阶段的内容哈希（§6.5 第 1 块）：对**落库的 `draft_json`** 取真摘要。
 *
 * 草稿也要真摘要，理由有两条（2026-10-05 复核 REQ-9）：
 * 1. 此前写的是 `'sha256:' + base64url(json).slice(0, 43)`——base64url 可逆，等于把草稿正文
 *    （含提示词）编码后存在哈希列里，而且截断到 43 字符（丢掉了尾部）；
 * 2. 人类在确认页看到的「内容哈希」应当是能自证来源的指纹：给同一份草稿能算出同一个值，
 *    给不同的草稿算出不同的值；可逆前缀两类都做不到。
 *
 * 键序无关性由 {@link canonicalJson} 提供（`draft_json` 是 jsonb 列，读回时键序必变——
 * 直接 `JSON.stringify` 会让写入与复算得到两个摘要，实测过）。
 *
 * 与 {@link computeHandoffHash} 的分工：草稿期还没有批准包（没有 `approved_*` 字段、
 * 没有人类决策 id），所以只摘要草稿自身；确认时改摘要**最终批准包**。
 */
export function computeDraftHash(draftJson: unknown, algorithm: string = DEFAULT_HANDOFF_HASH_ALGORITHM): string {
  return createHash(algorithm).update(canonicalJson(draftJson), 'utf8').digest('hex');
}
