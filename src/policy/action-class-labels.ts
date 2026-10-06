/**
 * 动作类别的**显示名与释义**（唯一出处）。
 *
 * 为什么单独一个模块：同一份名字要在三个地方出现——会话提示词、控制台、错误消息——
 * 各写一份必然漂移（而漂移的后果是"卡上写的"和"提示词里说的"不是一回事，
 * 人类据此判断放行，等于判断依据被污染）。客户端此前自己抄了一份，提示词则直接
 * 吐裸标识符（`exploit_validation`），两者都收口到这里。
 *
 * 命名口径（2026-10-07 与操作者对齐）：
 *   - `passive_read` / `active_discovery` / `authenticated_read` 用**行业标准英文**，
 *     因为原来的中文标签（被动读取/主动发现/认证读取）与它们真正干的事对不上：
 *     前者会向 crt.sh / whois 服务器发包（不是"不发流量"），后者是"用凭据访问"
 *     而不是"利用了凭据"；
 *   - 其余五个保持既有中文标签（操作者裁定"还好"）；
 *   - `exploit_validation` 名字容易被读成"只是验证漏洞"，实际是**任意自由命令**的档位，
 *     因此释义里必须点明这点，避免审批卡看起来比实际轻。
 *
 * **改名的做法（2026-10-07）**：标识符改了（`passive_read` → `passive_collection`、
 * `active_discovery` → `active_probing`、`authenticated_read` → `credentialed_access`），
 * 但**历史行一个字不动**——`tool_runs` / `approvals` 上有 `action_class` 不可变触发器，
 * 数据库层面就禁止原地重写。因此改名的全部代价落在"读侧归一化"：
 * `normalizeActionClass()` 把旧值映射到新值，本模块的查询一律先归一化，
 * 于是历史行、旧策略快照、旧范围方案照常渲染与评估（写侧只写新值）。
 */
import type { ActionClass } from '../contracts.ts';
import { PER_ACTION_APPROVAL_CLASSES, DEFAULT_DISABLED_CLASSES, normalizeActionClass } from '../contracts.ts';

/** 类别 → 显示名。 */
export const ACTION_CLASS_LABELS: Readonly<Record<ActionClass, string>> = Object.freeze({
  passive_collection: 'Passive Collection',
  active_probing: 'Active Probing',
  credentialed_access: 'Credentialed Access',
  exploit_validation: '利用验证',
  lateral_movement: '横向移动',
  persistence: '持久化',
  destructive: '破坏性动作',
  exfiltration: '数据外传',
});

/**
 * 类别 → 一句话释义（说"它意味着什么"，而不是复述名字）。
 *
 * 这话是给**做放行决定的人**和**规划动作的模型**看的：只给名字时两边都在猜。
 */
export const ACTION_CLASS_MEANINGS: Readonly<Record<ActionClass, string>> = Object.freeze({
  passive_collection: '不触碰目标：只读公开源与第三方（whois / 证书透明日志 / DNS 查询）',
  active_probing: '主动探测目标：只读、低噪声（端口、指纹、TLS、HTTP、字典）',
  credentialed_access: '用凭据访问目标（凭据来自人类提供或既有成果）',
  exploit_validation: '动手档：本部署的唯一模板是**自由命令**（任意 shell），逐条人批',
  lateral_movement: '跨主机移动到其它系统',
  persistence: '在目标上留驻（不可逆，永不放行）',
  destructive: '破坏性操作（不可逆，永不放行）',
  exfiltration: '把数据带出目标（不可逆，永不放行）',
});

export function actionClassLabel(actionClass: ActionClass): string {
  return ACTION_CLASS_LABELS[actionClass];
}

/**
 * 宽松版：给"类别值来自宽松来源（旧账本行 / 旧策略快照 / 模板简报里的 string）"的调用点用。
 *
 * 三步：旧值归一化 → 查表 → 查不到就原样显示。**不硬转类型**：注册表里的类别已经过校验，
 * 但显示层不该假装知道——不认识的值原样显示，总比把它当成某个已知类别（从而在审批卡上
 * 给出错误的严重度）要好。
 */
export function actionClassLabelSafe(value: string): string {
  const normalized = normalizeActionClass(value);
  return (ACTION_CLASS_LABELS as Readonly<Record<string, string | undefined>>)[normalized] ?? normalized;
}

/** 类别是否**默认**逐条人批（与执行侧同源，不在调用点重抄一遍）。旧值先归一化。 */
export function needsPerActionApproval(value: string): boolean {
  return (PER_ACTION_APPROVAL_CLASSES as readonly string[]).includes(normalizeActionClass(value));
}

/** 类别是否**永远**不放行（与执行侧同源）。旧值先归一化。 */
export function isAlwaysDenied(value: string): boolean {
  return (DEFAULT_DISABLED_CLASSES as readonly string[]).includes(normalizeActionClass(value));
}

/** `Passive Collection、Active Probing` 形态的名字列表（提示词与卡片用）。 */
export function actionClassNames(classes: readonly string[]): string {
  if (classes.length === 0) return '（无）';
  return classes.map((cls) => actionClassLabelSafe(cls)).join('、');
}

/**
 * 提示词形态：名字 + 标识符 + 释义，逐条给出。
 *
 * 只给名字时模型会按字面理解（把 `exploit_validation` 当成"只做漏洞验证"），
 * 而它需要知道的是"这一档动手且要人批"；标识符也给出，是因为范围方案里手写的仍是它。
 */
export function describeActionClasses(classes: readonly string[]): string {
  if (classes.length === 0) return '（无：本会话不需要逐次放行）';
  return classes
    .map((raw) => {
      const cls = normalizeActionClass(raw);
      const label = actionClassLabelSafe(cls);
      const meaning = (ACTION_CLASS_MEANINGS as Readonly<Record<string, string | undefined>>)[cls];
      return meaning === undefined ? label : `${label}（${cls}）：${meaning}`;
    })
    .join('；');
}
