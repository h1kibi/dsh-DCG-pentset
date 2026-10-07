/**
 * 行为预设的**提示词包**（2026-10-04 决定：预设不再是硬纪律，只注入提示词；
 * 2026-10-05 起预设是每个作业的**必选项**，并按作业场景做差异化）。
 *
 * 为什么改成提示词：当"预设"决定"哪些动作类别被服务端拒绝"时，Agent 会在被拒后反复
 * 试探，或者因为"这一类没开"而放弃本来就合理的动作——而真正的边界应当由**人类放行**
 * 把守，预设只表达意图（要不要安静、覆盖到什么程度、能不能接受噪声）。
 *
 * 因此现在的分工是：
 *   - 预设 → 一段**场景化的行为指引**（本文件），注入每个 worker 会话的提示词；
 *   - 超出预设的动作 → Agent **主动请人类放行**（`pentest_request_action_approval`）；
 *   - 默认禁用类别（persistence / destructive / exfiltration）与逐次放行下限
 *     仍然由服务端硬守——预设措辞不能豁免它们。
 *
 * 四档对应四种作业场景，指引必须**真的不同**（不是同一段话换个形容词）：
 *   `stealth`  红队 / 隐蔽测试——被看见即失败，少发一个请求比多拿一条信息划算；
 *   `standard` 已通知的授权渗透测试——噪声可接受，但每一步可解释、可追溯；
 *   `deep`     高许可 / 穷尽利用尝试——授权内把可能性打满，成组规划放行；
 *   `custom`   人类自己写的指引（逐字注入，冲突时优先于通用口径）。
 */

import type { BehaviorProfile } from '../contracts.ts';

/** 注入所需的最小事实：预设名 + 宿主侧实际生效的节奏上限 + 自定义指引（仅 custom）。 */
export interface BehaviorBrief {
  readonly profile: BehaviorProfile;
  readonly pacing?: Readonly<Record<string, number>>;
  readonly customGuidance?: string;
  /** 该作业冻结的审批模式；省略按 `human`（保守）。 */
  readonly approvalMode?: 'human' | 'auto';
}

/** 场景名（与界面下拉的标签同源语义；界面另有自己的 exhaustiveness 映射）。 */
const PROFILE_SCENARIOS: Readonly<Record<BehaviorProfile, string>> = Object.freeze({
  stealth: '红队 / 隐蔽测试',
  standard: '已通知的授权渗透测试',
  deep: '高许可 / 穷尽利用尝试',
  custom: '自定义（人类写指引）',
});

/**
 * 四段指引。写法上刻意用同一套骨架（允许 / 需要人批 / 禁止），
 * 这样"差异"落在**内容**上而不是排版上——模型扫一眼就能对照自己的处境。
 */
const PACKS: Record<BehaviorProfile, string> = {
  stealth:
    '**允许**：被动读取（已有证据、记忆、人类提供的材料）、低噪声的服务与路径确认、必要时的单点主动探测。\n' +
    '**节奏**：按宿主上限走并留间隔；不做全端口扫描、不做目录/参数爆破、不做会触发 WAF/IDS 的高频请求。\n' +
    '**需要人批**：任何会显著提高噪声的动作（全端口、爆破类、利用验证）、任何改变远端状态的动作。\n' +
    '**禁止**：留下持久痕迹（后门/账号/计划任务）与把目标数据外发——即使被批准，也要在放行申请里写清留痕与清理方案。\n' +
    '拿不准就往安静的一侧选：**少发一个请求，永远比被看见划算**。',
  standard:
    '**允许**：常规服务识别与版本核对、常见路径与接口枚举、已知漏洞的逐项核对与最小化验证。\n' +
    '**节奏**：宿主上限内正常推进，不必刻意规避噪声；但不要为了"更全"自行升级到入侵性动作。\n' +
    '**需要人批**：破坏性 / 持久化 / 外传类等仍逐类别确认并逐条放行；自由命令（`direct_command`）自 2026-10-07 起**免批**（人类不再逐条看命令原文，仅剩范围裁决与沙箱）；任何超出本预设类别的动作先请批再动。\n' +
    '**证据**：每个动作写清目的与预期证据；**失败也要记录**——失败归因本身就是结论，别把没打通的尝试从报告里删掉。',
  deep:
    '**允许**：完整端口扫描、服务与指纹细化、目录/参数爆破、逐项漏洞验证、对既有线索的多路径利用尝试。\n' +
    '**节奏**：宿主上限内尽量覆盖；同一目标的多条候选路径**成组规划**——一次申请一批放行，比逐条挤牙膏更快也更可审。\n' +
    '**需要人批**：破坏性 / 持久化 / 外传类仍需逐类别确认并逐条放行；自由命令（`direct_command`）自 2026-10-07 起**免批**（不再逐条看命令原文）。\n' +
    '**穷尽的定义是"穷尽尝试并记录"，不是"必须打进去"**：每条路径失败都要留下证据与归因，并列出尚未尝试的路径。\n' +
    '**禁止**：为了"打进去"而绕开范围、绕开放行、或改用未经批准的类别——那不是在穷尽，是在越界。',
  custom:
    '本作业使用**自定义**预设：以下指引由人类撰写，**逐条遵守**；与任何通用口径冲突时，以它为准。' +
    '它没有覆盖到的部分按最保守的口径执行（少发请求、不做高噪声动作、拿不准就先请人类放行）。',
};

/** 渲染会话提示词里的行为预设分节。 */
export function renderBehaviorSection(brief: BehaviorBrief): string {
  const lines = [
    `【行为预设：${brief.profile}｜${PROFILE_SCENARIOS[brief.profile]}】` +
      '（这是**行为指引**，不是硬边界——边界是人类放行）',
  ];
  if (brief.profile === 'custom') {
    const guidance = brief.customGuidance?.trim();
    lines.push(PACKS.custom);
    lines.push(
      guidance === undefined || guidance === ''
        ? '⚠ 本作业没有写入自定义指引（异常状态：服务端要求 custom 必带指引）。按最保守口径执行，并提醒人类补上。'
        : `── 人类写的自定义指引（原文）──\n${guidance}`,
    );
  } else {
    lines.push(PACKS[brief.profile]);
  }
  const rate = brief.pacing?.['rate'];
  const concurrency = brief.pacing?.['concurrency'];
  if (typeof rate === 'number' || typeof concurrency === 'number') {
    const parts: string[] = [];
    if (typeof rate === 'number') parts.push(`速率 ${String(rate)}/s`);
    if (typeof concurrency === 'number') parts.push(`并发 ${String(concurrency)}`);
    lines.push(`宿主侧当前节奏上限：${parts.join('、')}（超出的请求会被排队，不会失败）。`);
  }
  const mode = brief.approvalMode ?? 'human';
  lines.push(
    mode === 'auto'
      ? '【审批模式：高权限】预设内的动作由服务端**自行放行**：照常先申请放行，返回值里 ' +
        '`selfApproved=true` 时直接执行即可，不必等人类。**不要因为能自行放行就扩大范围、提权或加快节奏**——' +
        '超出预设、默认禁用类别（persistence/destructive/exfiltration）与范围外的动作照样会被拦下并转给人类。'
      : '【审批模式：人工审批】逐次放行类别的每个动作都要人类在控制台点一次——审批卡是唯一看过命令内容的人。',
  );
  lines.push(
    '**一次只提一条放行申请**：本会话已有待处理申请时，再提会被服务端拒绝（拒绝里会附上那条的 id）——' +
      '等人类处理完再提下一个。连着提一串只会让人只批一条、其余全悬着。',
  );
  lines.push(
    '**超出预设的动作**（更高风险类别、更大范围、更高速度，或预设里明确叫你别做的）：' +
      '先用 `pentest_request_action_approval` 请人类放行，写清"要做什么、为什么、影响面"；' +
      '不得先做后报。人类拒绝就换方案，不要重复提交同一个动作。',
  );
  return lines.join('\n');
}
