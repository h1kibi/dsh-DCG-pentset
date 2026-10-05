/**
 * 幂等键与计划摘要派生（设计文档 §10.2）。
 *
 * 两条纪律：
 *   1. **服务端计算**：键与摘要都由本模块派生，绝不采信 Agent 传入的值——
 *      否则 Agent 可以复用同一个键跳过实际执行。
 *   2. **未放行时凭证字段为空串**：因此「未放行的动作」与「已放行的同一动作」
 *      派生出的键不同，不会互相覆盖；跨会话同样不共享键（会话标识参与派生）。
 *
 * 分隔符用 U+001F（单元分隔符）：上游校验已排除控制字符，因此该字符不可能
 * 出现在被拼字段内部，拼接结果无歧义。
 */

import { createHash } from 'node:crypto';
import type { ActionClass, ActionPacing, IdempotencyInput, NormalizedTarget } from '../contracts.ts';

/** 参与拼接的分隔符；见模块头注释。 */
const FIELD_SEPARATOR = '\u001f';

function sha256Hex(payload: string): string {
  return createHash('sha256').update(payload, 'utf8').digest('hex');
}

// ───────────────────────────── 规范化文本 ─────────────────────────────

/**
 * 命令中使用的目标字面量（不含地址注解）。
 * URL 保留 scheme 与显式端口；其余形态只写 host[:port]。
 */
export function targetLiteral(target: NormalizedTarget): string {
  const hostPort = target.port === undefined ? target.host : `${target.host}:${target.port}`;
  return target.kind === 'url' ? `${target.scheme ?? 'http'}://${hostPort}` : hostPort;
}

/**
 * 规范化目标的规范文本——进入幂等键与计划摘要的形式。
 * 已裁决地址集合参与其中：地址固定是硬要求（§10.2.2），裁决结果变化必须改变键。
 */
export function canonicalTargetString(target: NormalizedTarget): string {
  const base = targetLiteral(target);
  const addresses = target.resolvedAddresses;
  if (addresses === undefined || addresses.length === 0) return base;
  return `${base} [${[...addresses].sort().join(',')}]`;
}

/**
 * 命令摘要的规范形式：折叠空白、去首尾，使同一命令的不同排版派生出同一个键。
 * 命令本身由服务端按模板构造，这里只消除排版差异，不做任何解释或重写。
 */
export function canonicalizeCommand(command: string): string {
  return command.trim().replace(/\s+/g, ' ');
}

// ───────────────────────────── 派生 ─────────────────────────────

/** `sha256(会话 ‖ 动作类别 ‖ 规范化目标 ‖ 规范化命令 ‖ 放行凭证)`。 */
export function deriveIdempotencyKey(input: IdempotencyInput): string {
  const fields = [
    input.workerSessionId,
    input.actionClass,
    // 规范化目标已是规范文本（由裁决结果生成），原样进入派生，避免二次解释。
    input.normalizedTarget,
    canonicalizeCommand(input.normalizedCommand),
    // 未携带凭证时为空串：未放行与已放行同一动作是两个不同的键。
    // 自铸凭证（auto 档）由调用方显式传空串：它每次受理都会新建一张，
    // 不能当作动作身份（否则重发=新键=二次执行，见 service.admit）。
    input.approvalId ?? '',
  ];
  return sha256Hex(fields.join(FIELD_SEPARATOR));
}

/**
 * 计划摘要覆盖的字段集合：模板、类别、目标、命令、超时、输出上限、
 * 会话绑定的范围版本、策略 epoch、策略版本与展开后的 pacing。
 *
 * 范围版本与策略版本参与摘要是设计文档 §10.3.1 的直接要求：
 * 「凭证在下列任一变化时失效：目标、规范化命令、范围版本、策略版本、会话标识或有效期」。
 * 因此计划内容任何一处变化都会让旧凭证与摘要不符而被拒绝。
 *
 * `pacing` 与 `policyVersion` 参与是 §6.2.0.5/§10.2 的第二条硬要求：
 * **行为策略必须进入 plan_hash 与审批负载**——人类批准的是展开后的真实计划，
 * 而不是「隐蔽性测试」这个名称。缺了它，改 pacing 不会让旧凭证失效。
 *
 * 这两个字段**必填**（未知时显式写 `null`）：它们曾经是可选，于是审批计划验证器
 * 漏传了它们，导致「人类修改后放行」的凭证永远无法消费——而那种缺陷在类型层
 * 完全没有信号。必填之后，漏传是编译错误。
 *
 * 不含 approvalId / idempotencyKey / leaseGeneration：凭证标识本身不参与摘要
 * （申请时尚不存在），租约世代另行单独校验。
 */
export interface PlanHashInput {
  readonly templateId: string;
  readonly actionClass: ActionClass;
  readonly normalizedTarget: string;
  readonly normalizedCommand: string;
  readonly timeoutMs: number;
  readonly maxOutputBytes: number;
  readonly scopeVersion: number;
  readonly policyEpoch: number;
  /** 冻结策略的版本号；读不到时写 `null`（而不是省略）。 */
  readonly policyVersion: number | null;
  /** 冻结策略展开出的节奏；该会话不施加 pacing 时写 `null`。 */
  readonly pacing: ActionPacing | null;
}

/** 计划摘要：对固定键序的规范 JSON 取 SHA-256。 */
export function derivePlanHash(input: PlanHashInput): string {
  const pacing = input.pacing;
  const canonical = JSON.stringify({
    templateId: input.templateId,
    actionClass: input.actionClass,
    normalizedTarget: input.normalizedTarget,
    normalizedCommand: canonicalizeCommand(input.normalizedCommand),
    timeoutMs: input.timeoutMs,
    maxOutputBytes: input.maxOutputBytes,
    scopeVersion: input.scopeVersion,
    policyEpoch: input.policyEpoch,
    policyVersion: input.policyVersion,
    pacing: pacing === null
      ? null
      : {
          rate: pacing.rate,
          concurrency: pacing.concurrency,
          jitter: pacing.jitter,
          burst: pacing.burst,
          retry: pacing.retry,
        },
  });
  return sha256Hex(canonical);
}
