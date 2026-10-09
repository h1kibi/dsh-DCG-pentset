/**
 * 交接材料的格式规范（§7.2、§7.4）。
 *
 * 为什么需要这份规范：
 *   - 交接上下文（handoffContext）是上游 Agent 给下游的线索，但当前没有格式约束
 *   - 下游 Agent 不知道哪些是"已验证的结论"、哪些是"待验证的线索"、哪些是"已排除的假设"
 *   - 人类在确认交接弹窗时也看不出哪些内容是"必须消费的"、哪些是"可选的背景"
 *
 * 本规范的三个核心分类：
 *   1. **结论**（已验证）：上游已证实的事实，下游可以直接引用
 *   2. **线索**（待验证）：上游发现但未证实的候选，下游需要核验
 *   3. **排除**（已证伪）：上游已排除的路径，下游不必重复尝试
 *
 * 注入时机：
 *   - 人类在交接确认弹窗里编辑草稿时，控制台自动补充这个格式提示
 *   - 下游 Agent 收到的交接材料（handoffContext）已按此格式整理
 */

/**
 * 交接内容类别的结构定义。
 * 
 * @public 供外部消费者使用，用于类型检查和UI渲染
 */
export interface HandoffContentCategory {
  readonly title: string;
  readonly description: string;
  readonly example: string;
}

/** 交接材料的三个分类及其说明。 */
export const HANDOFF_CATEGORIES: Readonly<{
  readonly conclusions: HandoffContentCategory;
  readonly leads: HandoffContentCategory;
  readonly excluded: HandoffContentCategory;
}> = Object.freeze({
  conclusions: {
    title: '结论（已验证）',
    description: '上游已证实的事实，含证据引用；下游可以直接引用，不必重新验证',
    example:
      '- 192.168.1.10:80 Apache 2.4.50 (CVE-2021-41773 已确认，见 memory:abc123)\n' +
      '- /admin 路径存在且返回 401（需认证，见 artifact:xyz789）\n' +
      '- 域控 DC01.example.com (10.0.1.5) 开放 LDAP 389/tcp',
  },
  leads: {
    title: '线索（待验证）',
    description: '上游发现但未证实的候选；下游需要核验后才能作为结论',
    example:
      '- /backup 目录可能存在（robots.txt 里声明但未实测）\n' +
      '- 用户 testuser 可能有弱口令（命名规律推测）\n' +
      '- 10.0.2.0/24 内网段可能存在（从路由表推断，未扫描）',
  },
  excluded: {
    title: '排除（已证伪）',
    description: '上游已排除的路径与假设；下游不必重复尝试，但要知道"为什么不行"',
    example:
      '- SSH 端口扫描 0 结果（该段无 22/tcp 开放）\n' +
      '- CVE-2021-44228 (Log4Shell) 不适用（版本 2.17.0 已修复）\n' +
      '- SQL 注入未证实（参数 id 对单引号无反应，响应稳定）',
  },
});

/**
 * 渲染交接材料格式指南（给人类在确认弹窗里看的）。
 *
 * 这段文本会显示在交接确认弹窗的"编辑区"上方，作为格式提示。
 * 人类可以按此格式整理 AI 生成的草稿，也可以完全重写。
 */
export function renderHandoffFormatGuide(): string {
  return [
    '【交接材料格式】',
    '',
    '请按以下三类整理交接内容（顺序：结论 → 线索 → 排除）：',
    '',
    `## ${HANDOFF_CATEGORIES.conclusions.title}`,
    HANDOFF_CATEGORIES.conclusions.description,
    '',
    '示例：',
    HANDOFF_CATEGORIES.conclusions.example,
    '',
    `## ${HANDOFF_CATEGORIES.leads.title}`,
    HANDOFF_CATEGORIES.leads.description,
    '',
    '示例：',
    HANDOFF_CATEGORIES.leads.example,
    '',
    `## ${HANDOFF_CATEGORIES.excluded.title}`,
    HANDOFF_CATEGORIES.excluded.description,
    '',
    '示例：',
    HANDOFF_CATEGORIES.excluded.example,
    '',
    '**注意事项**：',
    '- 每条结论必须有证据引用（memory:xxx / artifact:xxx）或明确标注"口头确认"',
    '- 线索要写清楚"为什么是线索"（推测依据）',
    '- 排除要写清楚"为什么排除"（实测结果/版本不匹配/防御机制）',
    '- 不确定分类的条目放在"线索"里，下游自己判断',
  ].join('\n');
}

/**
 * 渲染交接材料消费指南（注入到下游 Agent 的提示词里）。
 *
 * 下游 Agent 收到的 handoffContext 已经是人类确认过的最终版本，
 * 这段提示词教它"怎么消费这份材料"。
 */
export function renderHandoffConsumptionGuide(): string {
  const conclusions = HANDOFF_CATEGORIES.conclusions;
  const leads = HANDOFF_CATEGORIES.leads;
  const excluded = HANDOFF_CATEGORIES.excluded;

  return [
    '【如何使用交接材料】',
    '',
    '上游 Agent 的交接材料已按三类整理：',
    '',
    `**${conclusions.title}**`,
    '- 可以直接引用，不必重新验证',
    '- 引用时注明来源（如"情报阶段已确认 CVE-2021-41773"）',
    '- 如果结论与你的实测冲突，以你的实测为准，并记录差异',
    '',
    `**${leads.title}**`,
    '- 需要你验证后才能作为结论',
    '- 验证后记录：证实 → 记为结论；证伪 → 记为排除；无法验证 → 记为"需凭据"或"环境限制"',
    '- 优先验证高价值线索（敏感路径/已知CVE/弱配置）',
    '',
    `**${excluded.title}**`,
    '- 上游已排除的路径，不必重复尝试',
    '- 如果你有新证据推翻排除理由，可以重新尝试并记录',
    '- 排除不是"禁止"，是"已知此路不通"',
    '',
    '**缺失分类时的处理**：',
    '- 如果交接材料没有按这个格式整理（旧的自由文本），按内容推断：',
    '  有证据引用的 → 结论；"可能"/"推测" → 线索；"未发现"/"不适用" → 排除',
    '- 推断不出的当作"线索"处理（保守策略）',
  ].join('\n');
}

/** 验证交接材料是否遵循格式规范（返回 null 表示通过，否则返回警告信息）。 */
export function validateHandoffFormat(content: string): string | null {
  const trimmed = content.trim();
  if (trimmed.length === 0) {
    return '交接材料为空';
  }

  const hasConclusions = /##?\s*(结论|Conclusions)/i.test(content);
  const hasLeads = /##?\s*(线索|Leads)/i.test(content);
  const hasExcluded = /##?\s*(排除|Excluded)/i.test(content);

  // 至少要有一个分类标题
  if (!hasConclusions && !hasLeads && !hasExcluded) {
    return '建议按"结论/线索/排除"三类整理（当前未使用分类标题）';
  }

  // 这是建议而非强制，返回 null 表示通过
  return null;
}
