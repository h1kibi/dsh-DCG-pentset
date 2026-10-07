/** Deterministic server-side expansion of engagement behavior profiles. */

import { createHash } from 'node:crypto';
import {
  ACTION_CLASSES,
  APPROVAL_MODES,
  BEHAVIOR_PROFILES,
  CUSTOM_GUIDANCE_MAX_CHARS,
  DEFAULT_DISABLED_CLASSES,
  PER_ACTION_APPROVAL_CLASSES,
  isActionClass,
  normalizeActionClass,
} from '../contracts.ts';
import type { ApprovalMode } from '../contracts.ts';
import type { ActionClass, BehaviorProfile, ScopeEntryProfile } from '../contracts.ts';
import type { ActionPolicySnapshot } from '../execution/service.ts';

export type { BehaviorProfile, ScopeEntryProfile } from '../contracts.ts';
type CredentialMode = 'none' | 'reference' | 'session';

interface BehaviorProfileHardLimits {
  readonly maxRatePerSecond?: number;
  readonly maxConcurrency?: number;
  readonly maxBurst?: number;
  readonly maxRetryLimit?: number;
  readonly maxJitter?: number;
  readonly max_rate_per_second?: number;
  readonly max_concurrency?: number;
  readonly max_burst?: number;
  readonly max_retry_limit?: number;
  readonly max_jitter?: number;
}

interface BehaviorProfileInput {
  readonly profile?: BehaviorProfile;
  /** 审批模式；省略按 `human`（人类逐次审批）——缺省必须是最保守的一档。 */
  readonly approvalMode?: ApprovalMode;
  readonly behaviorProfile?: BehaviorProfile;
  readonly behavior_profile?: BehaviorProfile;
  readonly scopeEntry?: ScopeEntryProfile;
  readonly scope_entry?: ScopeEntryProfile;
  readonly targets?: readonly unknown[];
  readonly exclusions?: readonly unknown[];
  readonly normalizedTargets?: readonly unknown[];
  readonly normalizedExclusions?: readonly unknown[];
  readonly normalized_targets?: readonly unknown[];
  readonly normalized_exclusions?: readonly unknown[];
  readonly overrides?: Readonly<Record<string, unknown>>;
  readonly constraints?: Readonly<Record<string, unknown>>;


  readonly hardLimits?: BehaviorProfileHardLimits;
  readonly hard_limits?: BehaviorProfileHardLimits;
  readonly profileRevision?: number;
  readonly profile_revision?: number;
}

interface ProfilePacing {
  readonly rate: number;
  readonly concurrency: number;
  readonly jitter: number;
  readonly burst: number;
  readonly retry: number;
}

interface ExpandedActionPolicy extends ActionPolicySnapshot {
  readonly enabled: readonly ActionClass[];
  readonly disabled: readonly ActionClass[];
}

export interface ExpandedBehaviorProfile {
  readonly profile: BehaviorProfile;
  readonly profile_version: number;
  readonly scope_entry: ScopeEntryProfile;
  readonly detection_objective: string;
  readonly pacing: ProfilePacing;
  readonly action_policy: ExpandedActionPolicy;
  readonly credential_mode: CredentialMode;
  readonly stop_conditions: readonly string[];
  readonly normalized_scope: {
    readonly targets: readonly unknown[];
    readonly exclusions: readonly unknown[];
  };
  /**
   * **被哈希的那个对象本身**。
   *
   * 存储侧必须原样存它（而不是重新拼一个形状相近的对象）：否则
   * `hash(存的) === 记录的哈希` 这条可复核关系在第一次字段增删时就断了。
   */
  readonly snapshot: Readonly<Record<string, unknown>>;
  readonly canonicalJson: string;
  readonly snapshotHash: `sha256:${string}`;
  readonly execution_constraints: Readonly<Record<string, unknown>>;
  readonly contentHash: `sha256:${string}`;
}

type JsonRecord = Readonly<Record<string, unknown>>;

interface ProfileLimits {
  maxRatePerSecond: number;
  maxConcurrency: number;
  maxBurst: number;
  maxRetryLimit: number;
  maxJitter: number;
}

const DEFAULT_LIMITS: ProfileLimits = Object.freeze({
  maxRatePerSecond: 10,
  maxConcurrency: 4,
  maxBurst: 2,
  maxRetryLimit: 2,
  maxJitter: 1,
});


const DEFAULT_STOPS = Object.freeze([
  'authorization_expired',
  'budget_exhausted',
  'scope_violation_threshold',
  'audit_unavailable',
]);

export const PROFILE_DEFAULTS: Readonly<Record<BehaviorProfile, {
  readonly detectionObjective: string;
  readonly pacing: ProfilePacing;
  readonly enabled: readonly ActionClass[];
}>> = Object.freeze({
  stealth: {
    detectionObjective: 'minimize_detection',
    pacing: { rate: 1, concurrency: 1, jitter: 0.5, burst: 1, retry: 1 },
    enabled: ['passive_collection', 'active_probing'],
  },
  standard: {
    detectionObjective: 'balanced_coverage',
    pacing: { rate: 5, concurrency: 2, jitter: 0.25, burst: 2, retry: 1 },
    enabled: ['passive_collection', 'active_probing', 'credentialed_access'],
  },
  deep: {
    detectionObjective: 'maximize_bounded_coverage',
    pacing: { rate: 10, concurrency: 4, jitter: 0.1, burst: 2, retry: 2 },
    enabled: ['passive_collection', 'active_probing', 'credentialed_access', 'exploit_validation'],
  },
  custom: {
    detectionObjective: 'minimize_detection',
    pacing: { rate: 1, concurrency: 1, jitter: 0.5, burst: 1, retry: 1 },
    enabled: ['passive_collection', 'active_probing'],
  },
});

function isPlainObject(value: unknown): value is JsonRecord {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function finiteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function positiveInteger(value: unknown): value is number {
  return finiteNumber(value) && Number.isInteger(value) && value > 0;
}

function pickNumber(record: JsonRecord | undefined, camel: string, snake: string): number | undefined {
  const value = record?.[camel] ?? record?.[snake];
  return finiteNumber(value) ? value : undefined;
}

/**
 * Encode JSON-compatible policy values without relying on object insertion order.
 * Unsupported values are rejected so a caller cannot accidentally hash a lossy form.
 */
export function canonicalPolicyJson(value: unknown): string {
  const active = new Set<object>();

  const encode = (current: unknown): string => {
    if (current === null) return 'null';
    switch (typeof current) {
      case 'string': return JSON.stringify(current);
      case 'boolean': return current ? 'true' : 'false';
      case 'number':
        if (!Number.isFinite(current)) throw new TypeError('Policy JSON cannot contain a non-finite number');
        return Object.is(current, -0) ? '0' : JSON.stringify(current);
      case 'undefined':
      case 'bigint':
      case 'function':
      case 'symbol':
        throw new TypeError(`Unsupported policy JSON value: ${typeof current}`);
      case 'object': {
        if (active.has(current)) throw new TypeError('Policy JSON cannot contain cycles');
        active.add(current);
        try {
          if (Array.isArray(current)) {
            const parts: string[] = [];
            for (let index = 0; index < current.length; index += 1) {
              if (!Object.prototype.hasOwnProperty.call(current, index)) {
                throw new TypeError('Policy JSON cannot contain sparse arrays');
              }
              parts.push(encode(current[index]));
            }
            return `[${parts.join(',')}]`;
          }
          const prototype = Object.getPrototypeOf(current);
          if (prototype !== Object.prototype && prototype !== null) {
            throw new TypeError('Policy JSON only accepts plain objects');
          }
          for (const key of Reflect.ownKeys(current)) {
            if (typeof key !== 'string') throw new TypeError('Policy JSON cannot contain symbol keys');
            const descriptor = Object.getOwnPropertyDescriptor(current, key);
            if (!descriptor?.enumerable) continue;
            if (!descriptor || !('value' in descriptor)) {
              throw new TypeError('Policy JSON cannot contain accessors');
            }
          }
          const record = current as JsonRecord;
          const keys = Object.keys(record).sort();
          return `{${keys.map((key) => `${JSON.stringify(key)}:${encode(record[key])}`).join(',')}}`;
        } finally {
          active.delete(current);
        }
      }
      default: throw new TypeError('Unsupported policy JSON value');
    }
  };

  return encode(value);
}

/**
 * 读侧归一化：**唯一**的解析入口（策略 JSON、profile 覆盖、预设默认值都走这里）。
 *
 * 旧标识符必须被接受并映射到新值——策略快照是追加式的，历史行里存的就是旧值
 * （见 `contracts.ts` 的兼容纪律）；不归一化会让旧快照的类别列表突然"少几项"，
 * 表现为"某类动作静默变成越界/免批"，最难查的那种。
 */
function uniqueActionClasses(value: unknown): ActionClass[] {
  if (!Array.isArray(value)) return [];
  const result: ActionClass[] = [];
  for (const item of value) {
    if (!isActionClass(item)) continue;
    const normalized = normalizeActionClass(item) as ActionClass;
    if (!result.includes(normalized)) result.push(normalized);
  }
  return result;
}

function confirmationFor(overrides: JsonRecord, actionClass: ActionClass): boolean {
  const confirmations = overrides.confirmations;
  const key = `enable_${actionClass}`;
  const direct = overrides[key];
  if (direct === true) return true;
  if (isPlainObject(confirmations)) {
    return confirmations[actionClass] === true || confirmations[key] === true;
  }
  return false;
}

function chooseScopeEntry(input: BehaviorProfileInput, targets: readonly unknown[]): ScopeEntryProfile {
  const requested = input.scopeEntry ?? input.scope_entry;
  if (requested !== undefined) {
    if (requested === 'ip' || requested === 'domain' || requested === 'cidr' || requested === 'custom') return requested;
    // 显式给了却读不懂 = 调用方与服务端的分工出了错，不能静默退回推断。
    throw new TypeError(`Unknown scope entry profile: ${String(requested)}`);
  }
  if (targets.length > 0 && targets.every((target) => isPlainObject(target) && target.kind === 'ip')) return 'ip';
  if (targets.length > 0 && targets.every((target) => isPlainObject(target) && target.kind === 'domain')) return 'domain';
  if (targets.length > 0 && targets.every((target) => isPlainObject(target) && target.kind === 'cidr')) return 'cidr';
  return 'custom';
}

function limitsFrom(input: BehaviorProfileInput): ProfileLimits {
  const source = input.hardLimits ?? input.hard_limits;
  const result: ProfileLimits = { ...DEFAULT_LIMITS };
  if (!source) return result;
  for (const [camel, snake] of [
    ['maxRatePerSecond', 'max_rate_per_second'],
    ['maxConcurrency', 'max_concurrency'],
    ['maxBurst', 'max_burst'],
    ['maxRetryLimit', 'max_retry_limit'],
    ['maxJitter', 'max_jitter'],
  ] as const) {
    const candidate = pickNumber(source as JsonRecord, camel, snake);
    if (candidate !== undefined && candidate >= 0 && (camel === 'maxJitter' || Number.isInteger(candidate))) {
      result[camel] = candidate;
    }
  }
  return result;
}

function overrideActions(overrides: JsonRecord): ActionClass[] {
  const policy = isPlainObject(overrides.action_policy) ? overrides.action_policy : undefined;
  const value = overrides.allowedActions
    ?? overrides.allowed_actions
    ?? overrides.enabledActionClasses
    ?? overrides.enabled_action_classes
    ?? policy?.enabled;
  return uniqueActionClasses(value);
}

function approvalActions(overrides: JsonRecord): ActionClass[] {
  const policy = isPlainObject(overrides.action_policy) ? overrides.action_policy : undefined;
  const value = overrides.perActionApprovalClasses
    ?? overrides.per_action_approval_classes
    ?? overrides.approvalRequired
    ?? overrides.approval_required
    ?? policy?.perActionApprovalClasses
    ?? policy?.per_action_approval_classes
    ?? policy?.approval_required;
  return uniqueActionClasses(value);
}

function expandedPacing(profile: BehaviorProfile, overrides: JsonRecord, limits: typeof DEFAULT_LIMITS): ProfilePacing {
  const base = PROFILE_DEFAULTS[profile].pacing;
  const pacing = isPlainObject(overrides.pacing) ? overrides.pacing : undefined;
  const read = (camel: string, snake: string, fallback: number): number => {
    const value = pickNumber(overrides, camel, snake) ?? pickNumber(pacing, camel, snake) ?? fallback;
    return value >= 0 ? value : fallback;
  };
  return {
    rate: Math.min(read('rate', 'rate_limit', base.rate), limits.maxRatePerSecond),
    concurrency: Math.min(Math.max(1, Math.floor(read('concurrency', 'max_concurrency', base.concurrency))), limits.maxConcurrency),
    jitter: Math.min(read('jitter', 'jitter', base.jitter), limits.maxJitter),
    burst: Math.min(Math.max(1, Math.floor(read('burst', 'burst_limit', base.burst))), limits.maxBurst),
    retry: Math.min(Math.max(0, Math.floor(read('retry', 'retry_limit', base.retry))), limits.maxRetryLimit),
  };
}

/**
 * 策略快照的内容哈希（`canonicalPolicyJson` + SHA-256，十六进制全量）。
 *
 * 导出它是为了让**存储侧能复核**：服务端存下的快照对象与它的哈希必须同源，
 * 「存入时算一次、校验时另算一种」正是 §6.2.0.5 要避免的漂移。
 */
export function policyContentHash(value: unknown): `sha256:${string}` {
  return `sha256:${createHash('sha256').update(canonicalPolicyJson(value), 'utf8').digest('hex')}`;
}

/**
 * `policyOverrides` 允许出现的键。
 *
 * 这是一张**静态**表：它同时是文档与判据。未声明的键一律拒绝——静默忽略会让调用方
 * 以为「我调低了速率」，而实际快照里什么都没变（§10.2.1 的同一条纪律）。
 */
const ALLOWED_OVERRIDE_KEYS: Record<string, true> = {
  allowedActions: true,
  allowed_actions: true,
  enabledActionClasses: true,
  enabled_action_classes: true,
  disabledActionClasses: true,
  disabled_action_classes: true,
  action_policy: true,
  approvalRequired: true,
  approval_required: true,
  perActionApprovalClasses: true,
  per_action_approval_classes: true,
  confirmations: true,
  pacing: true,
  rate: true,
  rate_limit: true,
  concurrency: true,
  jitter: true,
  burst: true,
  burst_limit: true,
  retry: true,
  retry_limit: true,
  detectionObjective: true,
  detection_objective: true,
  credentialMode: true,
  credential_mode: true,
  stopConditions: true,
  stop_conditions: true,
  customGuidance: true,
  custom_guidance: true,
};

/**
 * 规范化自定义指引（人类自己写的 preset 提示词）。
 *
 * 三条规则，任一不满足即**拒绝**而不是静默忽略（静默忽略会让人类以为自己写的指引生效了）：
 *   - 非空串（纯空白 = 没写）；
 *   - ≤ {@link CUSTOM_GUIDANCE_MAX_CHARS}；
 *   - **只能配 `custom`**——其它四档的指引是固定文案，配了就是误用。
 */
function normalizeGuidance(raw: unknown, profile: BehaviorProfile): string | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== 'string') throw new TypeError('自定义指引必须是字符串');
  const text = raw.trim();
  if (text === '') return undefined;
  if (text.length > CUSTOM_GUIDANCE_MAX_CHARS) {
    throw new TypeError(`自定义指引过长：${String(text.length)} 字符，上限 ${String(CUSTOM_GUIDANCE_MAX_CHARS)}`);
  }
  if (profile !== 'custom') {
    throw new TypeError('自定义指引只能配 custom 预设：其它预设的指引是固定文案，写了不会生效（拒绝而不是忽略）');
  }
  return text;
}

/**
 * **高权限模式的自我放行判据**（服务端唯一一处；`admit` 与申请放行两条路径共用）。
 *
 * 放行集合 = 「预设启用集合」∪ {`exploit_validation`}，再减去默认禁用类别。三条理由：
 *
 *   1. **类别豁免（2026-10-07 起收窄）**。`exploit_validation` 这条豁免当初是为一件事设的：
 *      `stealth` / `standard`（按设计不含利用验证）下**每一条命令**都越界 ⇒ 高权限档退化成
 *      「每条都问人」（2026-10-05 实测），于是把命令类单独放进来。**2026-10-07 免批裁定后**，
 *      `direct_command` 的类别是 `active_probing` —— 它在各预设的启用集合里（见本文件 `enabled`），
 *      因此"命令在 auto 档能被自放行"这件事**已由预设本身保证**，不再需要这条豁免。
 *      **刻意不把豁免改挂到 `active_probing`**：那个名字被整个主动探测族共用，改挂等于让
 *      「越界也自放行」扩散到所有主动探测模板 —— 那是未经裁定的放宽。于是豁免保持只管旧类别，
 *      对越界的命令类不再生效（越界 ⇒ 拉人进回路）。
 *   2. `lateral_movement` 与其它非预设类别**仍然转人工**：横向移动与「没被本预设允许的动作」
 *      不是同一种风险，它跨主机。
 *   3. `DEFAULT_DISABLED_CLASSES`（persistence / destructive / exfiltration）**永远**不放行——
 *      即使人类此前逐类别确认开启过它们：那类后果不可逆，必须有人看过命令。
 *
 * 缺 `enabledActionClasses`（旧快照）时只看命令类那一条：无法判断「预设内」不等于可以放任。
 */
export function shouldSelfApprove(
  policy: {
    readonly approvalMode?: ApprovalMode;
    readonly enabledActionClasses?: readonly ActionClass[];
  },
  actionClass: ActionClass,
): boolean {
  if (policy.approvalMode !== 'auto') return false;
  if ((DEFAULT_DISABLED_CLASSES as readonly string[]).includes(actionClass)) return false;
  if (actionClass === 'exploit_validation') return true;
  const enabled = policy.enabledActionClasses;
  if (enabled === undefined) return false;
  return enabled.includes(actionClass);
}

/**
 * 审批模式的边界校验：**必选**，缺了或值不认识都拒绝（静默落 `human` 会让人类以为选了高权限，
 * 反之更糟——静默落 `auto` 等于替人类放开了审批）。
 */
export function requireApprovalMode(raw: unknown): ApprovalMode {
  if (typeof raw === 'string' && (APPROVAL_MODES as readonly string[]).includes(raw)) {
    return raw as ApprovalMode;
  }
  throw new TypeError(`必须显式选择审批模式（可选：${APPROVAL_MODES.join(' / ')}）——没有默认值`);
}

/** 把自定义指引并进覆盖对象（缺了就不加键——快照哈希因此只在真有指引时变化）。 */
export function withCustomGuidance(
  overrides: Readonly<Record<string, unknown>>,
  guidance: string | undefined,
): Readonly<Record<string, unknown>> {
  return guidance === undefined ? overrides : { ...overrides, customGuidance: guidance };
}

/**
 * **每个作业的必选**：解析人类选定的行为预设与自定义指引。
 *
 * 存在的理由：预设会写进冻结策略快照并逐次注入会话提示词，静默落到某个默认等于
 * 把「人类选过什么」从冻结证据里抹掉。因此缺了、值不认识、或 custom 没给指引，一律拒绝。
 */
export function requireBehaviorSelection(input: {
  readonly behaviorProfile?: unknown;
  readonly customGuidance?: unknown;
}): { readonly behaviorProfile: BehaviorProfile; readonly customGuidance?: string } {
  const value = input.behaviorProfile;
  if (typeof value !== 'string' || !(BEHAVIOR_PROFILES as readonly string[]).includes(value)) {
    throw new TypeError(
      `必须显式选择行为预设（可选：${BEHAVIOR_PROFILES.join(' / ')}）——它是每个作业的必选项，没有默认值`,
    );
  }
  const profile = value as BehaviorProfile;
  const guidance = normalizeGuidance(input.customGuidance, profile);
  if (profile === 'custom' && guidance === undefined) {
    throw new TypeError('custom 预设必须给出自定义指引（人类自己写的行为提示词）；其它预设请改用对应的固定档位');
  }
  return guidance === undefined ? { behaviorProfile: profile } : { behaviorProfile: profile, customGuidance: guidance };
}

/** 未声明的覆盖键（`enable_<action_class>` 形态的显式确认除外）。 */
export function unknownPolicyOverrideKeys(overrides: Readonly<Record<string, unknown>>): readonly string[] {
  const actionClasses = new Set<string>(ACTION_CLASSES);
  return Object.keys(overrides).filter((key) => {
    if (Object.hasOwn(ALLOWED_OVERRIDE_KEYS, key)) return false;
    if (key.startsWith('enable_') && actionClasses.has(key.slice('enable_'.length))) return false;
    return true;
  });
}

/**
 * 策略快照是否**自证来源**（§6.2.0.5）：内容与记录的哈希一致。
 *
 * 三类豁免，都是「没有可比对的哈希」而不是「比对失败」：
 *   - 快照自带 `legacy: true`：017 用 PostgreSQL 的 `jsonb` 文本形式回填，
 *     与 JS 侧 `canonicalPolicyJson` 不同源，比对必然不相等；
 *   - 记录哈希是 017 的默认哨兵 `sha256:legacy`：这一行从未被哈希过；
 *   - 记录哈希不是完整 `sha256:<64hex>`：同上（旧行或手工写入）。
 *
 * 其余情况一律按内容重算并比对——比对不通过说明投影被改过或写入中断。
 */
export function policySnapshotIsIntact(
  snapshot: Readonly<Record<string, unknown>>,
  recordedHash: string | null | undefined,
): boolean {
  if (snapshot['legacy'] === true) return true;
  if (recordedHash === null || recordedHash === undefined) return true;
  if (!/^sha256:[0-9a-f]{64}$/.test(recordedHash)) return true;
  try {
    return policyContentHash(snapshot) === recordedHash;
  } catch {
    // 含非 JSON 值：读路径不回退成「相信它」。
    return false;
  }
}

/** Expand one profile without reading process, network, clock, or database state. */
export function expandBehaviorProfile(input: BehaviorProfileInput): ExpandedBehaviorProfile {
  const profile = input.profile ?? input.behaviorProfile ?? input.behavior_profile ?? 'stealth';
  if (profile !== 'stealth' && profile !== 'standard' && profile !== 'deep' && profile !== 'custom') {
    throw new TypeError(`Unknown behavior profile: ${String(profile)}`);
  }
  const targets = input.normalizedTargets ?? input.normalized_targets ?? input.targets ?? [];
  const exclusions = input.normalizedExclusions ?? input.normalized_exclusions ?? input.exclusions ?? [];
  if (!Array.isArray(targets) || !Array.isArray(exclusions)) throw new TypeError('targets and exclusions must be arrays');

  const overrides = input.overrides ?? {};
  const limits = limitsFrom(input);
  const defaults = PROFILE_DEFAULTS[profile];
  const pacing = expandedPacing(profile, overrides, limits);
  const profileRevision = input.profileRevision ?? input.profile_revision ?? 1;
  if (!positiveInteger(profileRevision)) throw new TypeError('profile revision must be a positive integer');
  const customGuidance = normalizeGuidance(overrides['customGuidance'] ?? overrides['custom_guidance'], profile);
  const approvalMode = input.approvalMode ?? 'human';
  if (!(APPROVAL_MODES as readonly string[]).includes(approvalMode)) {
    throw new TypeError(`未知审批模式：${String(approvalMode)}（可选：${APPROVAL_MODES.join(' / ')}）`);
  }

  // 默认禁用类别的闸门**逐类别**生效，且与来源无关：
  // 无论类别来自 `allowedActions` 还是 `enabledActionClasses`，未经该类别的显式确认一律不开启。
  // 此前 `allowedActions` 分支绕过了这道闸门，而 `dualConfirmed` 是全局布尔——于是一次
  // 「确认 destructive」会连带放行同一批里的 persistence（未经确认）。逐类别过滤是唯一安全的形态。
  const isDefaultDisabled = (actionClass: ActionClass): boolean =>
    (DEFAULT_DISABLED_CLASSES as readonly string[]).includes(actionClass);
  const explicitAllowed = overrides.allowedActions ?? overrides.allowed_actions;
  const hasExplicitAllowed = Object.hasOwn(overrides, 'allowedActions') || Object.hasOwn(overrides, 'allowed_actions');
  const requested = hasExplicitAllowed ? uniqueActionClasses(explicitAllowed) : defaults.enabled.slice();
  const enabled = new Set<ActionClass>();
  for (const actionClass of [...requested, ...overrideActions(overrides)]) {
    if (isDefaultDisabled(actionClass) && !confirmationFor(overrides, actionClass)) continue;
    enabled.add(actionClass);
  }
  const policy = isPlainObject(overrides.action_policy) ? overrides.action_policy : undefined;
  const directDisabled = uniqueActionClasses(overrides.disabledActionClasses ?? overrides.disabled_action_classes ?? policy?.disabled);
  for (const actionClass of directDisabled) enabled.delete(actionClass);
  const enabledList = ACTION_CLASSES.filter((actionClass) => enabled.has(actionClass));
  const disabledList = ACTION_CLASSES.filter((actionClass) => !enabled.has(actionClass));
  const enabledDisabledClasses = ACTION_CLASSES.filter((actionClass) => isDefaultDisabled(actionClass) && enabled.has(actionClass));
  // 逐动作放行的下界，来自设计 §10.3 的风险分级表：
  //   - 契约基线（利用验证、横向移动）**任何输入都不能豁免**；
  //   - 认证读取「需要凭据引用与人工放行」；
  //   - 默认禁用类别「启用需人类二次明确确认**与逐动作放行**」——确认只管开不开启，
  //     开启之后每一次动作仍然要人放行。因此它们被开启时自动进入这个集合。
  const perActionApprovalClasses = [...new Set<ActionClass>([
    ...PER_ACTION_APPROVAL_CLASSES,
    'credentialed_access',
    ...enabledDisabledClasses,
    ...approvalActions(overrides),
  ])].filter((actionClass) => enabled.has(actionClass) || (PER_ACTION_APPROVAL_CLASSES as readonly string[]).includes(actionClass));
  // 双确认是一个**整体结论**：只有在场的每个默认禁用类别都各自被确认时才成立。
  // 用 `every` 而不是 `some`——`some` 会让「确认一个」等于「确认一批」。
  const dualConfirmed = enabledDisabledClasses.length > 0
    && enabledDisabledClasses.every((actionClass) => confirmationFor(overrides, actionClass));

  const objectiveValue = overrides.detectionObjective ?? overrides.detection_objective;
  const detectionObjective = typeof objectiveValue === 'string' && objectiveValue.trim() !== ''
    ? objectiveValue.trim()
    : defaults.detectionObjective;
  const credentialValue = overrides.credentialMode ?? overrides.credential_mode;
  const credentialMode: CredentialMode = credentialValue === 'reference' || credentialValue === 'session' ? credentialValue : 'none';
  const stopValue = overrides.stopConditions ?? overrides.stop_conditions;
  const stopConditions = Array.isArray(stopValue) && stopValue.every((item) => typeof item === 'string' && item.trim() !== '')
    ? [...new Set(stopValue.map((item) => item.trim()))]
    : [...DEFAULT_STOPS];
  const executionConstraints = input.constraints === undefined
    ? {}
    : isPlainObject(input.constraints)
      ? input.constraints
      : (() => { throw new TypeError('policy constraints must be a plain object'); })();
  const normalizedScope = { targets: [...targets], exclusions: [...exclusions] };

  const snapshot = {
    profile,
    profile_version: profileRevision,
    scope_entry: chooseScopeEntry(input, targets),
    detection_objective: detectionObjective,
    pacing,
    execution_constraints: executionConstraints,
    action_policy: {
      approval_mode: approvalMode,
      perActionApprovalClasses,
      enabledDisabledClasses,
      ...(dualConfirmed ? { dualConfirmed: true } : {}),
      enabled: enabledList,
      disabled: disabledList,
    },
    credential_mode: credentialMode,
    ...(customGuidance === undefined ? {} : { custom_guidance: customGuidance }),
    stop_conditions: stopConditions,
    normalized_scope: normalizedScope,
  };
  const canonicalJson = canonicalPolicyJson(snapshot);
  const snapshotHash = policyContentHash(snapshot);
  return { ...snapshot, snapshot, canonicalJson, snapshotHash, contentHash: snapshotHash };
}
