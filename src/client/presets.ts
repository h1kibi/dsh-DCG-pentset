/**
 * 行为预设的**界面文案**（向导、范围确认卡、会话卡片共用一份）。
 *
 * 为什么单独成文件：四档预设的标签与场景说明必须**三处一致**——人在这三个地方看到的
 * 是同一份选择。此前标签只写在向导里，确认卡上就没有可选项（预设只能靠服务端默认值
 * 偷偷落到 `stealth`），那正是「预设不是必选项」的成因之一。
 *
 * 文案与 `src/policy/behavior-prompts.ts` 的注入文案**语义对齐但受众不同**：
 * 这里写给人类（选哪一档合适），那里写给 Agent（怎么做）。两边都用
 * `Record<BehaviorProfile, string>`，预设增删会在两处同时编译失败。
 */

import type { ApprovalMode, BehaviorProfile } from '../contracts.ts';

/** 场景名（与注入提示词里的场景名叫法一致）。 */
export const BEHAVIOR_PROFILE_LABELS: Readonly<Record<BehaviorProfile, string>> = Object.freeze({
  stealth: '红队 · 隐蔽测试',
  standard: '已通知的授权渗透测试',
  deep: '高许可 · 穷尽利用尝试',
  custom: '自定义（我写指引）',
});

/** 一句话说清「这一档允许什么、什么时候选它」。 */
export const BEHAVIOR_PROFILE_HINTS: Readonly<Record<BehaviorProfile, string>> = Object.freeze({
  stealth:
    '被看见即失败：被动优先、低噪声确认、动作留间隔；不做全端口/爆破，需要噪声动作先请人类放行。',
  standard:
    '目标与时间窗已知、噪声可接受：常规识别、路径枚举与最小化验证；每个动作要可解释、证据可追溯，利用验证仍逐条人批。',
  deep:
    '授权内把可能性打满：全端口、指纹细化、爆破与多路径利用尝试；exploit 类逐条人批，破坏性/持久化/外传仍需逐类别确认。',
  custom:
    '由你写这一段行为指引（≤ 上限字数），它会逐字注入该作业下每一次会话，并随策略快照冻结进哈希。',
});

/** 审批模式的两档标签（人工审批 / 高权限）。 */
export const APPROVAL_MODE_LABELS: Readonly<Record<ApprovalMode, string>> = Object.freeze({
  human: '人工审批',
  auto: '高权限（Agent 自行放行）',
});

/** 一句话说清每档的含义与代价——高权限那档尤其要说清「人类不再逐条看命令」。 */
export const APPROVAL_MODE_HINTS: Readonly<Record<ApprovalMode, string>> = Object.freeze({
  human:
    '逐次放行类别的每个动作都要你在控制台点一次；审批卡是唯一看过命令内容的人。最慢，也最可控。',
  auto:
    '**预设内且非默认禁用类别**的动作由服务端自行放行（凭证直接建成已批准，落库并记审计），Agent 不必等你；' +
    '超出预设、以及 persistence / destructive / exfiltration 的申请仍然必须你批。' +
    '代价：这些命令在人类看到之前就已经跑了——范围闸门只核主机/端口，不看你跑了什么。',
});
