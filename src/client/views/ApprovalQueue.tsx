/**
 * 放行队列：逐动作放行（§10.3、§10.3.1、§6.2.1）。
 *
 * 设计依据：docs/dsh-pentest-plugin-design.md §6.2.1（放行队列要显示的字段）、
 * §10.3（风险分级表）、§10.3.1（放行的送达路径、凭证失效条件）、§15.2（过期凭证不复活）
 *
 * ── 这一屏的核心：approve-what-you-see ──
 *
 * §10.3.1 写着「人类批准的是**将要执行的那条命令**，不是『某个扫描动作』」。
 * 因此每条放行都原样展示 `command_plan` 里的规范化命令文本、规范化目标、超时、
 * 输出上限与目的——而不是一个动作名。抽象动作名让人无法判断自己批准了什么，
 * 而这里的每一次点击都在授权一次真实的内网动作。
 *
 * ── 四条闸门规则（只在 `approvalGateOf` 里实现一份） ──
 *
 * 1. **理由必填**：`HumanApprovalDecision.reason` 与 `HumanApprovalRevocation.reason`
 *    是契约里的必填字段（§16.1 的 HumanActor 审计锚点），控制台 RPC 也要求非空
 *    （`console/reason-required`）。所以缺理由时三个按钮全部禁用并说明原因，
 *    而不是让人类点了之后被服务端拒掉——那种交互会让人以为放行成功了。
 * 2. **已消费（`consumedAt !== null`）＝已完成**：凭证被一次执行消费后不再可操作
 *    （§10.3.1「一次性消费」）。
 * 3. **已过期不可放行**：`expiresAt` 已过即视为过期；到期时间不可解析时同样按过期
 *    处理（fail-closed，与 `execution/pg-store.ts` 的读法一致）。§15.2 明确
 *    「过期凭证不复活」——人类能做的只有让会话重新申请。
 * 4. **已决策是终态**：拒绝 / 撤销 / 已被取代都不再有操作；已放行未消费只留「撤销」。
 *
 * ── 端点缺口（重要，已在实现报告中列出） ──
 *
 * 放行队列的**读**端点在任何一层都**不存在**：`HumanWorkflowService`（方法表 = 它的人类面）
 * 没有任何方法返回放行记录，`ApprovalRecord` 本身也不含命令计划；而 `ExecutionStore.getApproval`
 * 的 SQL（`src/execution/pg-store.ts` 的 `SQL_GET_APPROVAL`）只取 id / requested_by_worker /
 * action_class / plan_hash / decision / expires_at / consumed_at——`command_plan`、
 * `target_snapshot`、`risk_summary`、`created_at` 都没被取出，尽管它们就在表里。
 * 因此条目由调用方经 props 注入（Host 侧从 `pentest.approvals` 投影），刷新所需端点名经
 * `readEndpointGap` 显示给人类——而不是假装队列是空的。
 * **写**端点 `decideApproval` / `revokeApproval` 在表里，直接用 `controller` 的封装。
 */

import { useState } from 'react';
import type { ReactNode } from 'react';
import { DEFAULT_DISABLED_CLASSES } from '../../contracts.ts';
import type { ActionClass, ApprovalDecision, ApprovalDetail } from '../../contracts.ts';
import type { ConsoleController, ConsoleSnapshot } from '../controller.ts';
import { actionClassLabel, formatCount, formatDuration, formatTimestamp, needsPerActionApproval, truncate } from '../format.ts';
import type { Tone } from '../format.ts';
import { Badge, Button, Card, Empty, ErrorBar, Field, Table, TextArea, TextInput } from '../ui.tsx';

// ───────────────────────────── 文案与取值域（§21 暂无完整 locale 表，先集中在这里） ─────────────────────────────

/**
 * 决策**成功**但通知没送达时的告警（否则人类看到的就是「点了批准没反应」）。
 *
 * 为什么必须有：凭证在通知之前就已生效，投递失败不回滚；而 Agent 收不到通知就会一直等，
 * 人类只知道「我批了」，于是合理地把现象归因成「插件坏了」。审计里其实有一条
 * `tool.approval.notice_failed`——问题是没人会去翻审计。这里把它拿到台面上。
 */
export function noticeFailureOf(
  result: unknown,
): { readonly code: string; readonly message: string } | null {
  if (typeof result !== 'object' || result === null) return null;
  const value = (result as { readonly value?: unknown }).value;
  if (typeof value !== 'object' || value === null) return null;
  if ((value as { readonly noticeDelivered?: unknown }).noticeDelivered !== false) return null;
  return {
    code: 'approval/notice-undelivered',
    message:
      '放行已记录（凭证已生效），但没能唤醒 Agent 会话——宿主重启过，旧会话不属于当前进程。' +
      '请用「插话」提醒它继续，或在当前阶段「重做」后重新申请放行；这条凭证到期会自动失效。',
  };
}

// 「补充」是**选填**的（2026-10-05 人类要求）：放行卡上要能直接点「批准这一次执行」，
// 不该被一个必填框拦住。补充仍然有用——填了会随决定进审计，并**投递给 Agent** 做上下文补充
// （`deliverApprovalNotice`），所以这里不设闸门，只在文案上说清它去哪儿。

/** 必需字段读出来是 null 时的占位。它显式表示「这里本该有值」，而不是「值是空的」。 */
const MISSING = '（记录缺失）';

/** 决定人类能否看懂「自己要批什么」的那些字段。缺任何一个都不许放行。 */
function missingFields(item: ApprovalItem): readonly string[] {
  const missing: string[] = [];
  // 判据是 `normalizedCommand`（执行真正要跑的那份）：`displayCommand` 只是展示形态，
  // 它缺了可以回落，`normalizedCommand` 缺了这条记录就不能放行。
  if (item.normalizedCommand === null) missing.push('完整命令');
  if (item.normalizedTarget === null) missing.push('规范化目标');
  if (item.workerSessionId === null) missing.push('请求方会话');
  if (item.scopeVersion === null) missing.push('范围版本');
  if (item.maxOutputBytes === null) missing.push('输出上限');
  if (item.timeoutMs === null) missing.push('超时');
  return missing;
}

/**
 * 一条放行在**界面上**的处置状态。
 *
 * 它比 `ApprovalDecision` 多一个 `consumed`：已放行且已消费与「已放行但还没执行」
 * 对人类的含义完全不同（前者已成事实、后者仍可撤销），而数据库里两者都是
 * `decision = 'approved'` + `consumed_at` 有值。多出来的这一个值正是这一屏要讲的差异。
 */
type ApprovalResolution =
  | 'awaiting'
  | 'approved'
  | 'consumed'
  | 'expired'
  | 'rejected'
  | 'revoked'
  | 'superseded'
  /** 记录本身不完整（必需字段缺失）。不是生命周期状态，而是数据故障。 */
  | 'malformed';

/** 处置状态的中文标签。键与 `ApprovalResolution` 对齐，缺项会在类型层暴露。 */
const RESOLUTION_LABELS: Readonly<Record<ApprovalResolution, string>> = {
  awaiting: '待放行',
  approved: '已放行（待执行）',
  consumed: '已放行 → 已完成',
  expired: '已过期',
  rejected: '已拒绝',
  revoked: '已撤销',
  superseded: '已被取代',
  malformed: '记录不完整',
};

/**
 * §10.3 风险分级表的「放行要求」列，逐类别照抄。
 *
 * 这是界面上的「风险等级」：它不是模型给出的分数，而是**这个类别需要什么级别的
 * 人工授权**——那才是人类在这一屏上要判断的东西。
 */
const RISK_TIER_LABELS: Readonly<Record<ActionClass, string>> = {
  passive_read: '低：engagement 授权即可，通常不需逐次放行',
  active_discovery: '中：阶段级放行，受速率、目标白名单与时间窗约束',
  authenticated_read: '中：需要凭据引用与人工放行',
  exploit_validation: '高：逐目标、逐动作放行，载荷保持最小',
  lateral_movement: '高：逐目标、逐动作放行，且目标必须已纳入当前范围版本',
  persistence: '极高：默认不启用，启用需在 engagement 策略中显式开启并双人确认',
  destructive: '极高：默认不启用，启用需在 engagement 策略中显式开启并双人确认',
  exfiltration: '极高：默认不启用，启用需在 engagement 策略中显式开启并双人确认',
};

function riskTone(actionClass: ActionClass): Tone {
  switch (actionClass) {
    case 'passive_read':
      return 'neutral';
    case 'active_discovery':
    case 'authenticated_read':
      return 'active';
    case 'exploit_validation':
    case 'lateral_movement':
      return 'attention';
    case 'persistence':
    case 'destructive':
    case 'exfiltration':
      return 'danger';
  }
}

/** `DEFAULT_DISABLED_CLASSES` 的成员提示（§10.3「默认不启用」）。 */
const DEFAULT_DISABLED: Record<string, true> = Object.fromEntries(DEFAULT_DISABLED_CLASSES.map((c) => [c, true]));

/**
 * 表格列。
 *
 * §6.2.1 要求显示七个字段，但**不要求七个列**：这一屏的主要阅读动作是逐字读那条命令，
 * 列越多每格越窄，命令就越读不下去。因此把同一件事的字段并到一列——
 * 动作类别与它的风险等级是同一件事的两面；请求方、范围版本与用途合起来正是
 * 「这份凭证绑在什么上」；状态与有效期共同回答「现在还能不能用」。
 */
const COLUMNS = [
  { key: 'target', header: '规范化目标' },
  { key: 'command', header: '即将执行的完整命令' },
  { key: 'class', header: '动作类别与风险' },
  { key: 'binding', header: '请求方与绑定（理由 / 范围版本）' },
  { key: 'expiry', header: '有效期与状态' },
  { key: 'actions', header: '操作' },
] as const;

type ColumnKey = (typeof COLUMNS)[number]['key'];

/** 列键的成员表：静态字面量用 Record，`renderCell` 收到的 columnKey 是 `string`，需要窄化。 */
const COLUMN_KEYS: Record<string, true> = Object.fromEntries(COLUMNS.map((column) => [column.key, true]));

function isColumnKey(value: string): value is ColumnKey {
  return Object.hasOwn(COLUMN_KEYS, value);
}

// ───────────────────────────── 数据形状 ─────────────────────────────

/**
 * 放行队列的一条。
 *
 * 字段来自 `pentest.approvals` 一行加它的 `command_plan` / `target_snapshot`
 * （写法见 `src/execution/pg-store.ts` 的 `requestApproval`）。时间用 ISO 字符串：
 * 契约的 `ApprovalRecord` 用 `Date`，但那需要 Host 侧先序列化才能过线，
 * 视图只消费过线后的文本。
 */
export interface ApprovalItem {
  readonly id: string;
  /**
   * 请求方会话（`approvals.requested_by_worker`）。凭证不跨会话（§10.3.1）。
   *
   * 可空：这些键在落库时都是 NOT NULL，读出来是 null 意味着记录不完整
   * （迁移期数据、或上游写坏）。视图**不把它伪造成空串**——伪造会让人类
   * 以为自己看到了一条完整的放行请求。见 {@link ApprovalGate} 的 fail-closed 处置。
   */
  readonly workerSessionId: string | null;
  readonly actionClass: ActionClass;
  /** 被裁决的规范化目标（`target_snapshot.normalized_target`）。可空，理由同上。 */
  readonly normalizedTarget: string | null;
  /** 完整命令文本（`command_plan.normalized_command`，给容器读的形态）。可空，理由同上。 */
  readonly normalizedCommand: string | null;
  /**
   * **人类可读**的命令文本（`command_plan.display_command`，服务端把 `*_b64` 参数解码后写入）。
   *
   * 卡片优先显示它：自由命令的 `normalized_command` 是一串 base64，把它摆给人类看
   * 等于内容闸门作废。为空表示这条记录没带展示形态（老数据），此时回落显示 `normalizedCommand`。
   */
  readonly displayCommand: string | null;
  readonly scopeVersion: number | null;
  readonly policyEpoch: number | null;
  readonly timeoutMs: number | null;
  readonly maxOutputBytes: number | null;
  /** 申请理由（`command_plan.purpose`）。可空，理由同上。 */
  readonly purpose: string | null;
  /** 影响评估（`approvals.risk_summary`）。可空：这里缺的是**给人看的**判断依据。 */
  readonly riskSummary: string | null;
  readonly decision: ApprovalDecision;
  /**
   * 到期时间。可空：读出来是 null 时**按已过期处理**（fail-closed）——
   * 说不清什么时候失效的凭证不该被放行。
   */
  readonly expiresAt: string | null;
  readonly consumedAt: string | null;
  readonly createdAt: string;
  /** 服务端可接受的修改入口；不包含自由命令文本。 */
  readonly templateId: string | null;
  readonly params: Readonly<Record<string, string | number>> | null;
  readonly targetSelector: string | null;
}

/** 一条放行的操作闸门：状态、可用动作、以及每个不可用动作的说明。 */
/** 只接受**普通对象**；数组与 null 一律当作「没有」。 */
function recordOf(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

/** `jsonb` 列可能回来是对象，也可能是字符串（驱动差异）——两种都接受。 */
function jsonRecordOf(value: unknown): Record<string, unknown> | null {
  if (typeof value === 'string') {
    try {
      return recordOf(JSON.parse(value));
    } catch {
      return null;
    }
  }
  return recordOf(value);
}

/**
 * `ApprovalDetail` → 证据行（放行队列与会话卡片**共用**的唯一映射）。
 *
 * 为什么必须是唯一一处：两处渲染要看同一份字段。一旦分叉，就会出现
 * 「队列里能批、聊天里批不了」（或更糟：聊天里看到的是旧字段）——
 * 而 §10.3.1 要求人类批准的正是**那条具体的命令**。
 *
 * 缺失字段一律保留 `null`（不伪造成空串），由 {@link approvalGateOf} 统一 fail-closed。
 */
export function approvalItemOf(detail: ApprovalDetail): ApprovalItem {
  const plan = jsonRecordOf(detail.commandPlan);
  const params = recordOf(plan?.['params']);
  return {
    id: detail.id,
    workerSessionId: detail.workerSessionId,
    actionClass: detail.actionClass,
    normalizedTarget: detail.normalizedTarget,
    normalizedCommand: detail.normalizedCommand,
    displayCommand: typeof plan?.['display_command'] === 'string' ? plan['display_command'] : null,
    scopeVersion: detail.scopeVersion,
    policyEpoch: detail.policyEpoch,
    timeoutMs: detail.timeoutMs,
    maxOutputBytes: detail.maxOutputBytes,
    purpose: detail.purpose,
    riskSummary: detail.riskSummary,
    decision: detail.decision,
    expiresAt: detail.expiresAt,
    consumedAt: detail.consumedAt,
    createdAt: detail.createdAt,
    templateId: typeof plan?.['template_id'] === 'string' ? plan['template_id'] : null,
    params: params as Readonly<Record<string, string | number>> | null,
    targetSelector: typeof plan?.['target_selector'] === 'string' ? plan['target_selector'] : null,
  };
}

interface ApprovalGate {
  /** 处置状态的判别值。视图据它计数与分支，**不比较展示标签**。 */
  readonly resolution: ApprovalResolution;
  readonly stateLabel: string;
  readonly stateTone: Tone;
  /** 状态说明，显示在状态标签下方。 */
  readonly note: string | null;
  /**
   * 该条是否还有任何可做的动作（理由填写后即可用）。
   *
   * 它决定是否渲染理由输入框：**没有它，待放行条目在理由为空时会陷入死锁**——
   * 三个按钮都因缺理由而禁用，而理由框又不显示，人类无处可填。
   */
  readonly interactive: boolean;
  readonly canApprove: boolean;
  readonly canReject: boolean;
  readonly canRevoke: boolean;
  readonly approveDisabledReason: string | null;
  readonly rejectDisabledReason: string | null;
  readonly revokeDisabledReason: string | null;
  /** 人类接下来该做什么（失效、过期、已消费时给出）。 */
  readonly guidance: string | null;
}

/**
 * 放行闸门（纯函数，便于单测）。
 *
 * `reason` 是当前填写的理由文本——理由必填这条规则属于闸门，不属于渲染，
 * 因此放在这里而不是散在按钮的 `disabled` 表达式里。
 */
export function approvalGateOf(item: ApprovalItem, reason: string, now: Date): ApprovalGate {
  // 记录不完整 → 一律不得放行（fail-closed）。
  //
  // §10.3.1 的全部意义是「人类批准的是那条具体的命令」。看不到命令、看不到输出上限
  // 或看不到范围版本时，人类无法做出这个判断——此时唯一安全的结论是不放行。
  // 这与「过期不复活」同理：不确定就拒绝，绝不因为「likely 没问题」而放行。
  const missing = missingFields(item);
  if (missing.length > 0) {
    const why = `放行记录不完整（缺少：${missing.join('、')}），无法确认将要执行的内容，因此不得放行（§10.3.1）。请让 Agent 重新申请。`;
    return {
      resolution: 'malformed',
      stateLabel: RESOLUTION_LABELS.malformed,
      stateTone: 'danger',
      note: `这条记录的必需字段没有完整落库：${missing.join('、')}。`,
      interactive: true,
      canApprove: false,
      canReject: true,
      canRevoke: false,
      approveDisabledReason: why,
      rejectDisabledReason: null,
      revokeDisabledReason: why,
      guidance: '可以拒绝它（拒绝不需要看到命令全文）。要执行则必须重新申请一条完整记录。',
    };
  }

  const consumed = item.consumedAt !== null;
  // 到期时间缺失或不可解析 → 按「已过期」处理：放行判定必须 fail-closed（与存储层的读法一致）
  const expiryMs = item.expiresAt === null ? Number.NaN : Date.parse(item.expiresAt);
  const expired =
    !consumed && (item.decision === 'expired' || !Number.isFinite(expiryMs) || expiryMs <= now.getTime());

  if (consumed) {
    const why = '凭证已被一次执行消费：同一条命令不会被执行第二次（§10.3.1）。';
    return {
      resolution: 'consumed',
      stateLabel: RESOLUTION_LABELS.consumed,
      stateTone: 'done',
      note: `随后的执行已完成：消费于 ${formatTimestamp(item.consumedAt, now)}。`,
      interactive: false,
      canApprove: false,
      canReject: false,
      canRevoke: false,
      approveDisabledReason: why,
      rejectDisabledReason: why,
      revokeDisabledReason: why,
      guidance: '无需处置：凭证已用完，Agent 若还要执行同一条命令必须重新申请。',
    };
  }

  if (expired) {
    const why = '已过期：过期凭证不复活（§15.2），本凭证不可放行、不可撤销。';
    return {
      resolution: 'expired',
      stateLabel: RESOLUTION_LABELS.expired,
      stateTone: 'danger',
      note: `有效期至 ${formatTimestamp(item.expiresAt, now)}，已经过去。`,
      interactive: false,
      canApprove: false,
      canReject: false,
      canRevoke: false,
      approveDisabledReason: why,
      rejectDisabledReason: why,
      revokeDisabledReason: why,
      guidance: '该动作不会执行。需放行时由该会话重新申请——旧凭证不会被复活，也不会被自动重试（§15.2）。',
    };
  }

  if (item.decision === 'rejected') {
    const why = '该凭证已被人类拒绝（终态）。';
    return {
      resolution: 'rejected',
      stateLabel: RESOLUTION_LABELS.rejected,
      stateTone: 'danger',
      note: '人类拒绝后凭证失效，该动作不会执行。',
      interactive: false,
      canApprove: false,
      canReject: false,
      canRevoke: false,
      approveDisabledReason: why,
      rejectDisabledReason: why,
      revokeDisabledReason: why,
      guidance: '如需继续，由该会话重新申请放行（§10.3.1：失效后重新调用会被拒绝并提示需要重新申请）。',
    };
  }

  if (item.decision === 'revoked') {
    const why = '该凭证已被人类撤销（终态）。';
    return {
      resolution: 'revoked',
      stateLabel: RESOLUTION_LABELS.revoked,
      stateTone: 'danger',
      note: '撤销后凭证失效，在途动作由策略 epoch 终止（§10.3.1）。',
      interactive: false,
      canApprove: false,
      canReject: false,
      canRevoke: false,
      approveDisabledReason: why,
      rejectDisabledReason: why,
      revokeDisabledReason: why,
      guidance: '如需继续，由该会话重新申请放行。',
    };
  }

  if (item.decision === 'superseded') {
    const why = '该凭证已被取代（目标、命令、范围版本或策略版本变化，§10.3.1）。';
    return {
      resolution: 'superseded',
      stateLabel: RESOLUTION_LABELS.superseded,
      stateTone: 'neutral',
      note: '旧凭证不生效，以最新的一条放行记录为准。',
      interactive: false,
      canApprove: false,
      canReject: false,
      canRevoke: false,
      approveDisabledReason: why,
      rejectDisabledReason: why,
      revokeDisabledReason: why,
      guidance: '看最新那条放行记录——被取代的这条不能再放行。',
    };
  }

  if (item.decision === 'approved') {
    return {
      resolution: 'approved',
      stateLabel: RESOLUTION_LABELS.approved,
      stateTone: 'active',
      note: '凭证已签发：等该会话携带 approval_id 重新调用执行（§10.3.1）。执行前服务端会重新裁决范围、策略与会话租约。',
      interactive: true,
      canApprove: false,
      canReject: false,
      canRevoke: true,
      approveDisabledReason: '凭证已放行，不再需要放行；如需停止，用「撤销」。',
      rejectDisabledReason: '凭证已放行；拒绝只对未决策的申请有意义，如需停止请用「撤销」。',
      revokeDisabledReason: null,
      guidance: '撤销后凭证立即失效，Agent 的后续调用会被拒。',
    };
  }

  // pending：三条路都开着——**补充是选填**（2026-10-05 人类要求：要能直接点「批准这一次执行」）。
  // 补充框仍在，填了随决定投递给 Agent 作为上下文补充（`deliverApprovalNotice`）。
  return {
    resolution: 'awaiting',
    stateLabel: RESOLUTION_LABELS.awaiting,
    stateTone: 'attention',
    note: '等你判断：放行后 Agent 会携带 approval_id 重新调用执行（§10.3.1）。',
    interactive: true,
    canApprove: true,
    canReject: true,
    canRevoke: true,
    approveDisabledReason: null,
    rejectDisabledReason: null,
    revokeDisabledReason: null,
    guidance: '补充选填：填了会随决定投递给 Agent，作为它下一步的上下文。',
  };
}

/** 放行队列的 props。 */
interface ApprovalQueueProps {
  /** 唯一写入路径（§4.2）：放行决策经它下发。 */
  readonly controller: ConsoleController;
  readonly snapshot: ConsoleSnapshot;
  /** 待处理的放行记录，由服务端 listApprovals 读取并注入。 */
  readonly items: readonly ApprovalItem[];
  readonly now?: Date;
  readonly readEndpointGap?: string;
}

/** 放行队列。 */
export function ApprovalQueue(props: ApprovalQueueProps): ReactNode {
  const [revisions, setRevisions] = useState<Readonly<Record<string, {
    readonly templateId: string;
    readonly targetSelector: string;
    readonly paramsText: string;
    readonly purpose: string;
    readonly enabled: boolean;
  }>>>({});
  const [reasons, setReasons] = useState<Readonly<Record<string, string>>>({});
  const [failure, setFailure] = useState<{ readonly code: string; readonly message: string } | null>(null);
  const now = props.now ?? new Date();

  const pending = props.items.filter((item) => approvalGateOf(item, '', now).resolution === 'awaiting').length;

  /**
   * 写操作只有一个落点。
   *
   * 服务端拒绝由控制器记进快照（`lastError`）并在这里渲染；而**抛出的异常**不会进快照——
   * 传输层抛错（通道断开、fetch 被拒）或客户端 bug（信封构造失败）都走这条路。
   * 如果一并吞掉，人类点下去会什么都没发生、也看不到任何提示；因此显式接住并报出来。
   */
  const submit = (run: () => Promise<unknown>): void => {
    run().then(
      (value: unknown) => {
        setFailure(noticeFailureOf(value));
      },
      (cause: unknown) => {
        setFailure({
          code: 'client/envelope-rejected',
          message: cause instanceof Error ? cause.message : String(cause),
        });
      },
    );
  };

  const renderCell = (row: ApprovalItem, columnKey: string): ReactNode => {
    if (!isColumnKey(columnKey)) return null;
    const reason = reasons[row.id] ?? '';
    const gate = approvalGateOf(row, reason, now);

    switch (columnKey) {
      case 'target':
        return <code className="pentest-approval__target">{row.normalizedTarget ?? MISSING}</code>;

      case 'command':
        return (
          <div className="pentest-approval__command-block">
            {/* §10.3.1：人类批准的是这条命令本身，因此原样展示、不截断成摘要。
                优先显示 displayCommand（`*_b64` 参数已解码）——放开权限后放行卡是唯一的内容
                闸门，把 base64 摆在这里等于让人类盲批；老记录没有该字段时才回落。 */}
            <pre className="pentest-approval__command">
              {row.displayCommand ?? row.normalizedCommand ?? MISSING}
            </pre>
            <span className="pentest-approval__limits">
              {row.timeoutMs === null || row.maxOutputBytes === null
                ? MISSING
                : `超时 ${formatDuration(row.timeoutMs / 1000)} · 输出上限 ${formatBytes(row.maxOutputBytes)}`}
            </span>
          </div>
        );

      case 'class':
        return (
          <div className="pentest-approval__class">
            <Badge
              text={actionClassLabel(row.actionClass)}
              tone={riskTone(row.actionClass)}
              hint={row.actionClass}
            />
            {needsPerActionApproval(row.actionClass) ? (
              <Badge
                text="逐次放行"
                tone="attention"
                hint="§10.3：该类别逐目标逐动作放行，凭证一次性消费"
              />
            ) : null}
            {Object.hasOwn(DEFAULT_DISABLED, row.actionClass) ? (
              <Badge
                text="默认不启用"
                tone="danger"
                hint="§10.3：该类别默认不启用，需在 engagement 策略中显式开启并双人确认"
              />
            ) : null}
            <span className="pentest-approval__risk-tier">{RISK_TIER_LABELS[row.actionClass]}</span>
            <span className="pentest-approval__impact">
              {row.riskSummary === null ? MISSING : truncate(row.riskSummary, 120)}
            </span>
          </div>
        );

      case 'binding':
        return (
          <div className="pentest-approval__binding">
            {row.workerSessionId === null ? (
              <code>{MISSING}</code>
            ) : (
              <code title={row.workerSessionId}>{truncate(row.workerSessionId, 12)}</code>
            )}
            <span className="pentest-approval__purpose">
              {row.purpose === null ? MISSING : truncate(row.purpose, 120)}
            </span>
            {row.scopeVersion === null || row.policyEpoch === null ? (
              // 范围版本与 epoch 是凭证绑定的边界：缺了它们就说不清「批的是哪个范围的判断」，
              // 因此不显示半截信息。
              <span className="pentest-approval__scope-version">{MISSING}</span>
            ) : (
              <span
                className="pentest-approval__scope-version"
                title={`策略 epoch ${formatCount(row.policyEpoch)}：范围或策略变化会递增 epoch 并中止在途动作（§10.3.1）`}
              >
                {`范围版本 v${formatCount(row.scopeVersion)} · 策略 epoch ${formatCount(row.policyEpoch)}`}
              </span>
            )}
            <span className="pentest-approval__asked">{`申请于 ${formatTimestamp(row.createdAt, now)}`}</span>
          </div>
        );

      case 'expiry':
        return (
          <div className="pentest-approval__expiry">
            <Badge text={gate.stateLabel} tone={gate.stateTone} />
            <span>{`有效期至 ${formatTimestamp(row.expiresAt, now)}`}</span>
            {gate.note === null ? null : <span className="pentest-approval__state-note">{gate.note}</span>}
            {gate.guidance === null ? null : (
              <span className="pentest-approval__guidance">{gate.guidance}</span>
            )}
          </div>
        );

      case 'actions':
        return (
          <div className="pentest-approval__actions" data-approval-id={row.id} data-decision={row.decision}>
            {gate.interactive ? (
              <Field label="补充（选填）" hint="填了会随决定进审计，并投递给 Agent 作为下一步的上下文补充">
                <TextArea
                  value={reason}
                  onChange={(next) => {
                    setReasons((current) => ({ ...current, [row.id]: next }));
                  }}
                  rows={2}
                  placeholder="可选：给 Agent 的补充说明（例如「只测这一个端口，别扩散」）"
                />
              </Field>
            ) : null}
            {gate.resolution === 'awaiting' && row.templateId !== null ? (() => {
              const revision = revisions[row.id] ?? {
                templateId: row.templateId,
                targetSelector: row.targetSelector ?? row.normalizedTarget ?? '',
                paramsText: row.params === null ? '{}' : JSON.stringify(row.params),
                purpose: row.purpose ?? '',
                enabled: false,
              };
              const patch = (next: Partial<typeof revision>): void => {
                setRevisions((current) => ({ ...current, [row.id]: { ...revision, ...next } }));
              };
              return (
                <details className="pentest-approval__revision">
                  <summary>修改受信计划后放行</summary>
                  <Field label="模板 ID">
                    <TextInput value={revision.templateId} onChange={(next) => { patch({ templateId: next, enabled: true }); }} />
                  </Field>
                  <Field label="目标选择器">
                    <TextInput value={revision.targetSelector} onChange={(next) => { patch({ targetSelector: next, enabled: true }); }} />
                  </Field>
                  <Field label="模板参数 JSON" hint="只能提交模板参数；服务端重新生成命令、范围、地址与摘要">
                    <TextArea value={revision.paramsText} onChange={(next) => { patch({ paramsText: next, enabled: true }); }} rows={3} />
                  </Field>
                  <Field label="修改后的目的">
                    <TextArea value={revision.purpose} onChange={(next) => { patch({ purpose: next, enabled: true }); }} rows={2} />
                  </Field>
                  <pre className="pentest-approval__revision-preview">
                    {revision.enabled ? `template_id=${revision.templateId}\ntarget_selector=${revision.targetSelector}\nparams=${revision.paramsText}\npurpose=${revision.purpose}` : '未启用修改；放行将使用原始计划。'}
                  </pre>
                </details>
              );
            })() : null}
            <Button
              label="放行"
              kind="primary"
              tone="done"
              disabled={!gate.canApprove}
              {...(gate.approveDisabledReason === null ? {} : { reason: gate.approveDisabledReason })}
              onClick={() => {
                const revision = revisions[row.id];
                let modifiedCommandPlan: unknown;
                if (revision?.enabled === true) {
                  try {
                    const params = JSON.parse(revision.paramsText) as unknown;
                    modifiedCommandPlan = {
                      template_id: revision.templateId,
                      target_selector: revision.targetSelector,
                      params,
                      purpose: revision.purpose,
                    };
                  } catch {
                    setFailure({ code: 'client/invalid-modified-plan', message: '修改计划的参数必须是合法 JSON 对象。' });
                    return;
                  }
                }
                submit(() => props.controller.decideApproval({
                  approvalId: row.id,
                  decision: 'approved',
                  reason: reason.trim(),
                  ...(modifiedCommandPlan === undefined ? {} : { modifiedCommandPlan }),
                }));
              }}
            />
            <Button
              label="拒绝"
              tone="danger"
              disabled={!gate.canReject}
              {...(gate.rejectDisabledReason === null ? {} : { reason: gate.rejectDisabledReason })}
              onClick={() => {
                submit(() => props.controller.decideApproval({ approvalId: row.id, decision: 'rejected', reason: reason.trim() }));
              }}
            />
            <Button
              label="撤销"
              tone="attention"
              disabled={!gate.canRevoke}
              {...(gate.revokeDisabledReason === null ? {} : { reason: gate.revokeDisabledReason })}
              onClick={() => {
                submit(() => props.controller.revokeApproval({ approvalId: row.id, reason: reason.trim() }));
              }}
            />
          </div>
        );
    }
  };

  return (
    <Card title={`放行队列（${formatCount(pending)} 条待判断 / ${formatCount(props.items.length)} 条）`}>
      <p className="pentest-approval__rule">
        §10.3.1 approve-what-you-see：你批准的是
        <strong>即将执行的这条命令</strong>
        ，不是一个抽象动作名。凭证绑定会话、目标、命令、范围版本与有效期；目标、命令、范围或状态任一变化，旧凭证失效。
      </p>

      {props.readEndpointGap === undefined ? null : (
        <p className="pentest-approval__gap">
          {`端点缺口：${props.readEndpointGap}。队列只能渲染调用方注入的数据，刷新不可用。`}
        </p>
      )}

      {props.snapshot.conflict ? (
        <ErrorBar
          code="stale_state_version"
          message="另一个界面先提交了：已重读最新状态（§15.4）。请基于当前版本重新判断。"
          tone="attention"
        />
      ) : null}
      {props.snapshot.lastError === null ? null : (
        <ErrorBar code={props.snapshot.lastError.code} message={props.snapshot.lastError.message} />
      )}
      {failure === null ? null : <ErrorBar code={failure.code} message={failure.message} />}
      {props.snapshot.loading ? <Badge text="读写中" tone="active" hint="正在与控制台交换数据" /> : null}

      <Table
        columns={COLUMNS}
        rows={props.items}
        keyOf={(row) => row.id}
        renderCell={renderCell}
        empty={
          <Empty
            title="放行队列为空"
            reason="该 engagement 当前没有待处理的放行申请。Worker 调用 pentest_request_action_approval 申请高风险动作放行后，条目会出现在这里（§10.3.1）。"
          />
        }
      />
    </Card>
  );
}

/** 字节数的人类可读形式。用 KiB/MiB（1024 进制）——输出上限是按字节定的配额，不是营销单位。 */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '—';
  if (bytes < 1024) return `${String(Math.round(bytes))} B`;
  if (bytes < 1024 * 1024) return `${String(Math.round(bytes / 1024))} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}
