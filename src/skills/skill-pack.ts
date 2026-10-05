/**
 * skill pack：仓库里的 `skills/<name>/SKILL.md` 是**知识资产的源文件**，
 * `pentest.skills` 表是运行时装载点（人类在控制台勾选、会话创建时冻结）。
 *
 * 为什么需要这一层：生态里的 skill 约定是「文件 + frontmatter」，而本插件的装载模型是
 * 「库 + 冻结集合 + 内容哈希 + 审计」。两者必须能对齐——本模块把文件解析成可入库的形状，
 * 并给出**阶段 → 默认 pack** 的单一事实源；写库由 `scripts/seed-skills.ts` 走服务层完成
 * （保留审计与哈希，不绕过）。
 */

import type { Phase } from '../contracts.ts';

/** 每个阶段出厂默认装载的 skill（名称即 `skills/<name>/SKILL.md` 的目录名）。 */
export const SKILL_PACKS: Readonly<Record<Phase, readonly string[]>> = Object.freeze({
  'intelligence-gathering': ['recon-network-surface', 'recon-web-surface', 'recon-dns-cert', 'internal-discovery'],
  'threat-modeling': ['model-trust-boundaries', 'model-attack-paths', 'model-attack-trees', 'asset-graph', 'business-impact'],
  'vulnerability-analysis': ['vuln-web-checks', 'vuln-service-checks', 'vuln-intel', 'vuln-triage'],
  exploitation: ['exploit-minimal-poc', 'exploit-safety', 'exploit-auth-testing', 'exploit-evidence', 'exploit-approval-request'],
  'post-exploitation': ['post-impact-boundary', 'post-cleanup-verify', 'post-loop-handoff'],
});

/** pack 里出现的全部 skill 名（去重，供播种脚本与检查使用）。 */
export function allPackSkillNames(): readonly string[] {
  const names = new Set<string>();
  for (const list of Object.values(SKILL_PACKS)) for (const name of list) names.add(name);
  return [...names].sort();
}

export interface ParsedSkill {
  readonly name: string;
  readonly description: string;
  readonly whenToUse: string;
  readonly phase: Phase | null;
  readonly version: string | null;
  readonly sources: readonly string[];
  /**
   * 冒烟证明：`沙箱实测@<镜像摘要前 12 位>：<跑过什么>`，或 `无需沙箱：<原因>`。
   *
   * 绑定镜像摘要是有意为之：镜像一重建（digest 变），这份证明就**失效**，
   * `test/skill-pack.test.ts` 会红——逼人重跑命令，而不是让"验证过"这句话一直挂着。
   */
  readonly smoked: string | null;
  /** 去掉 frontmatter 后的正文（入库的 `body`）。 */
  readonly body: string;
}

const PHASES: readonly Phase[] = [
  'intelligence-gathering',
  'threat-modeling',
  'vulnerability-analysis',
  'exploitation',
  'post-exploitation',
];

class SkillPackError extends Error {
  override readonly name = 'SkillPackError';
}

/** 解析 `key: value`；只认第一个冒号，值里的冒号原样保留。 */
function field(line: string): { key: string; value: string } | null {
  const index = line.indexOf(':');
  if (index <= 0) return null;
  return { key: line.slice(0, index).trim(), value: line.slice(index + 1).trim() };
}

/** `[a, b]` 形式的内联列表；不是列表就返回空数组（不猜）。 */
function inlineList(value: string): readonly string[] {
  const trimmed = value.trim();
  if (!trimmed.startsWith('[') || !trimmed.endsWith(']')) return [];
  return trimmed
    .slice(1, -1)
    .split(',')
    .map((item) => item.trim().replace(/^["']|["']$/g, ''))
    .filter((item) => item !== '');
}

/**
 * 解析一个 `SKILL.md`。
 *
 * 只支持本目录实际使用的 YAML 子集（顶层标量 + `metadata:` 下的标量与内联列表）——
 * 宁可**显式报错**也不引入 YAML 依赖或静默吞掉不认识的结构：skill 正文是要进模型上下文的
 * 内容，解析错了比解析失败更危险。
 */
export function parseSkillFile(text: string): ParsedSkill {
  const source = text.replace(/\r\n/g, '\n');
  if (!source.startsWith('---\n')) throw new SkillPackError('缺少 frontmatter（文件必须以 --- 行开头）');
  const end = source.indexOf('\n---\n', 3);
  if (end < 0) throw new SkillPackError('frontmatter 没有闭合的 --- 行');
  const head = source.slice(4, end).split('\n');
  const body = source.slice(end + 5).replace(/^\n+/, '');

  const top = new Map<string, string>();
  const meta = new Map<string, string>();
  let inMeta = false;
  for (const raw of head) {
    if (raw.trim() === '' || raw.trimStart().startsWith('#')) continue;
    const indented = /^\s+\S/.test(raw);
    const parsed = field(raw.trim());
    if (parsed === null) throw new SkillPackError(`frontmatter 行无法解析：${raw.trim()}`);
    if (parsed.key === 'metadata' || parsed.key === 'metadata:') {
      inMeta = true;
      continue;
    }
    (inMeta && indented ? meta : top).set(parsed.key, parsed.value);
  }

  const name = top.get('name') ?? '';
  const description = top.get('description') ?? '';
  const whenToUse = top.get('whenToUse') ?? '';
  if (name === '') throw new SkillPackError('frontmatter 缺少 name');
  if (description === '') throw new SkillPackError(`${name}：缺少 description`);
  if (whenToUse === '') throw new SkillPackError(`${name}：缺少 whenToUse`);
  if (body.trim() === '') throw new SkillPackError(`${name}：正文为空`);

  const phaseText = meta.get('phase') ?? '';
  if (phaseText !== '' && !(PHASES as readonly string[]).includes(phaseText)) {
    throw new SkillPackError(`${name}：未知 phase ${phaseText}`);
  }
  return {
    name,
    description,
    whenToUse,
    phase: phaseText === '' ? null : (phaseText as Phase),
    version: meta.get('version') ?? null,
    sources: inlineList(meta.get('sources') ?? ''),
    smoked: (meta.get('smoked') ?? '').replace(/^"|"$/g, '') || null,
    body,
  };
}
