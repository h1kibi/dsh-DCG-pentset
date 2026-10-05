/**
 * 能力冻结：为顶层 Worker 会话绑定独立的能力快照。
 *
 * 设计依据：docs/dsh-pentest-plugin-design.md §2.4、§4.3、§5.3
 *
 * 冻结的含义（文档原话）：运行中的 Agent 不会因为后台配置变动而获得新权限；
 * 人类想改变能力边界，只能重做或切换阶段，从而留下一条可追溯的决策记录。
 *
 * 实测确认的 dsh 机制（dsh 0.1.5-rc.2）：
 *   `ctx.agents.create({ parentAgent 省略 })` 创建**顶层** Agent；
 *   其 setup 回调通过 `agentCtx` 做 scoped tools / `restrict()` / prompt sections，
 *   且「The factory awaits setup after minting agentCtx but BEFORE inserting or
 *   announcing either the session or agent, so observers can never see a
 *   partially configured world」——这正是能力冻结需要的原子性。
 */

import { createHash } from 'node:crypto';
import type { BudgetLimits, Phase } from '../contracts.ts';
import { DEFAULTS } from '../contracts.ts';

/** Worker 能力快照：创建会话时冻结，之后只读。 */
export interface CapabilitySnapshot {
  readonly phase: Phase;
  readonly profileId: string;
  readonly profileRevision: string;
  /** 本次装载的 skill 集合；允许为空（§2.2：可为空是合法状态）。 */
  readonly skillIds: readonly string[];
  /** 工具允许列表：只能收窄，不能放宽。 */
  readonly toolAllow: readonly string[];
  readonly modelRoute: ModelRoute;
  readonly budget: BudgetLimits;
  /** 冻结时的范围版本。 */
  readonly scopeVersion: number;
  readonly policyEpoch: number;
  /** 快照内容的哈希，用于审计与幂等。 */
  readonly contentHash: string;
}

export interface ModelRoute {
  readonly provider: string;
  readonly model: string;
  readonly reasoningEffort: 'low' | 'high' | 'max';
}

/**
 * 冻结能力：把阶段 Profile 与被勾选的 skill/tool 合并成不可变快照。
 *
 * 关键规则（§10.2.1 的延伸）：人类选择的工具允许列表**可以比 Profile 更严格，
 * 不能更宽**。放宽请求在这里被拒绝，而不是等运行时才发现。
 */
export function freezeCapabilities(input: {
  phase: Phase;
  profileId: string;
  profileRevision: string;
  /** Profile 声明的可用能力上界。 */
  profileSkills: readonly string[];
  profileTools: readonly string[];
  /** 人类本次勾选；省略表示沿用 Profile 全部默认。 */
  selectedSkillIds?: readonly string[];
  selectedToolAllow?: readonly string[];
  modelRoute: ModelRoute;
  budget?: Partial<BudgetLimits>;
  scopeVersion: number;
  policyEpoch: number;
}): CapabilitySnapshot {
  const skills = input.selectedSkillIds ?? input.profileSkills;
  const tools = input.selectedToolAllow ?? input.profileTools;

  assertSubset('skill', skills, input.profileSkills);
  assertSubset('tool', tools, input.profileTools);

  const budget: BudgetLimits = {
    maxTokens: input.budget?.maxTokens ?? DEFAULTS.budgetMaxTokens,
    maxSteps: input.budget?.maxSteps ?? DEFAULTS.budgetMaxSteps,
    maxSeconds: input.budget?.maxSeconds ?? DEFAULTS.budgetMaxSeconds,
  };

  const body = {
    phase: input.phase,
    profileId: input.profileId,
    profileRevision: input.profileRevision,
    skillIds: [...skills].sort(),
    toolAllow: [...tools].sort(),
    modelRoute: input.modelRoute,
    budget,
    scopeVersion: input.scopeVersion,
    policyEpoch: input.policyEpoch,
  };

  return { ...body, contentHash: hashSnapshot(body) };
}

/** 子集校验：勾选必须是上界的子集。宽度只能收窄。 */
function assertSubset(what: 'skill' | 'tool', chosen: readonly string[], upper: readonly string[]): void {
  const allowed = new Set(upper);
  const illegal = chosen.filter((x) => !allowed.has(x));
  if (illegal.length > 0) {
    throw new CapabilityFreezeError(
      `${what} 选择超出 Profile 上界：${illegal.join(', ')}。` +
        `能力只能收窄不能放宽（§2.4）；要扩大需先修改 Profile 并产生新的 revision。`,
    );
  }
}

export class CapabilityFreezeError extends Error {
  override readonly name = 'CapabilityFreezeError';
}

/** 确定性哈希：键排序 + 规范 JSON。用于审计与幂等，不用于安全签名。 */
function hashSnapshot(body: unknown): string {
  return createHash('sha256').update(canonicalJson(body), 'utf8').digest('hex');
}

/** 规范性 JSON：递归按键排序，保证同一逻辑内容得到同一哈希。 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
}

/**
 * 校验一次工具调用是否在冻结的能力边界内。
 *
 * 返回 `undefined` 表示允许；返回字符串表示拒绝理由（供 guard 使用）。
 * 注意：这里只判「能力边界」，不判范围与放行——那是执行服务的职责（§10.2）。
 */
export function checkCapability(
  snapshot: CapabilitySnapshot,
  call: { readonly tool: string; readonly skill?: string },
): string | undefined {
  if (!snapshot.toolAllow.includes(call.tool)) {
    return `工具 ${call.tool} 不在本会话冻结的能力快照内（阶段 ${snapshot.phase}）`;
  }
  if (call.skill !== undefined && !snapshot.skillIds.includes(call.skill)) {
    return `skill ${call.skill} 未装载到本会话（允许空装载，但不能使用未勾选的 skill）`;
  }
  return undefined;
}
