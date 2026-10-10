#!/usr/bin/env node

/**
 * Skill 依赖检查脚本（CI/CD 门禁）。
 *
 * **硬约束**：Skill 正文不得包含对**其他 Skill** 的显式引用。
 *
 * 原因：
 * - Skill 由**阶段** Worker 按字符串名字加载（`skill_load` 工具）
 * - 一个 Skill 正文里引用另一个 Skill 名，意味着它依赖另一个名字的存在
 * - 如果依赖的 Skill 在同阶段、跨阶段或被删除，就会运行时加载失败
 * - **跨阶段依赖**特别危险：阶段切换时新加载集合可能缺少上阶段的 Skill
 *
 * 扫描规则：
 * 1. 找所有 `.md` Skill 文件
 * 2. 在正文（不含 frontmatter）里查找形如 `skill_load` 调用或对其他 Skill 名的引用
 * 3. 记录违反的 Skill 对 + 位置
 *
 * 运行：
 *   node scripts/check-skill-deps.ts
 *   # 或在 CI 中
 *   npm run check:skill-deps
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.join(__dirname, '..');
const SKILLS_DIR = path.join(PROJECT_ROOT, 'skills');

interface SkillMetadata {
  name: string;
  phase: string;
  path: string;
}

interface DependencyViolation {
  skillName: string;
  skillPhase: string;
  skillPath: string;
  referencedSkill: string;
  lineNumber: number;
  snippet: string;
}

/**
 * 从 Skill 文件的 frontmatter 提取 name 和 phase。
 */
function extractMetadata(content: string): { name: string; phase: string } | null {
  const match = content.match(/^---\n([\s\S]+?)\n---\n/);
  if (!match) return null;

  const frontmatter = match[1];
  const nameMatch = frontmatter.match(/^name:\s*(.+)$/m);
  const phaseMatch = frontmatter.match(/^\s+phase:\s*(.+)$/m);

  if (!nameMatch || !phaseMatch) return null;

  return {
    name: nameMatch[1].trim(),
    phase: phaseMatch[1].trim(),
  };
}

/**
 * 从 Skill 文件中提取正文（去掉 frontmatter）。
 */
function extractBody(content: string): string {
  const match = content.match(/^---\n[\s\S]+?\n---\n([\s\S]*)$/);
  return match ? match[1] : content;
}

/**
 * 查找 Skill 正文中对其他 Skill 的引用。
 * 匹配模式：`skill_load` 工具调用或直接的 Skill 名引用。
 */
function findSkillReferences(body: string, allSkillNames: string[]): Array<{ name: string; line: number; snippet: string }> {
  const references: Array<{ name: string; line: number; snippet: string }> = [];
  const lines = body.split('\n');

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // 模式 1: `skill_load` 工具调用中的 skill_name 参数
    // 例：skill_name=recon-network-surface
    const skillLoadMatch = line.match(/skill_(?:_)?name\s*[=:]\s*["`]?(\w+-[\w-]*)\b/gi);
    if (skillLoadMatch) {
      for (const match of skillLoadMatch) {
        const skillName = match.replace(/skill_(?:_)?name\s*[=:]\s*["`]?/i, '').replace(/["`].*/, '');
        if (skillName && allSkillNames.includes(skillName)) {
          references.push({
            name: skillName,
            line: i + 1,
            snippet: line.trim().substring(0, 100),
          });
        }
      }
    }

    // 模式 2: 直接引用 Skill 名（作为文字字符串或变量值）
    // 例：See skills/recon-network-surface/SKILL.md for details
    for (const skillName of allSkillNames) {
      // 避免误匹配（前后都是单词边界）
      const regex = new RegExp(`\\b${skillName}\\b`, 'g');
      if (regex.test(line)) {
        references.push({
          name: skillName,
          line: i + 1,
          snippet: line.trim().substring(0, 100),
        });
      }
    }
  }

  return references;
}

/**
 * 主检查逻辑。
 */
async function checkSkillDependencies(): Promise<void> {
  console.log('🔍 Checking Skill dependencies...\n');

  // 1. 扫描所有 Skill 文件，提取 name 和 phase
  const skillFiles = fs.readdirSync(SKILLS_DIR).filter((file) => {
    const fullPath = path.join(SKILLS_DIR, file);
    return fs.statSync(fullPath).isDirectory();
  });

  const skills: SkillMetadata[] = [];
  const skillNameToPhase: Record<string, string> = {};
  const allSkillNames: string[] = [];

  for (const skillDir of skillFiles) {
    const skillPath = path.join(SKILLS_DIR, skillDir, 'SKILL.md');
    if (!fs.existsSync(skillPath)) continue;

    const content = fs.readFileSync(skillPath, 'utf-8');
    const metadata = extractMetadata(content);
    if (!metadata) {
      console.warn(`⚠️  No metadata in ${skillPath}`);
      continue;
    }

    skills.push({
      name: metadata.name,
      phase: metadata.phase,
      path: skillPath,
    });
    skillNameToPhase[metadata.name] = metadata.phase;
    allSkillNames.push(metadata.name);
  }

  console.log(`✓ Found ${skills.length} Skills\n`);

  // 2. 检查每个 Skill 的依赖
  const violations: DependencyViolation[] = [];

  for (const skill of skills) {
    const content = fs.readFileSync(skill.path, 'utf-8');
    const body = extractBody(content);

    const references = findSkillReferences(body, allSkillNames);
    for (const ref of references) {
      // 检查是否是跨阶段依赖
      const refPhase = skillNameToPhase[ref.name];
      if (skill.phase !== refPhase) {
        violations.push({
          skillName: skill.name,
          skillPhase: skill.phase,
          skillPath: skill.path,
          referencedSkill: ref.name,
          lineNumber: ref.line,
          snippet: ref.snippet,
        });
      }
    }
  }

  // 3. 报告
  if (violations.length === 0) {
    console.log('✅ No Skill dependency violations found.\n');
    process.exit(0);
  }

  console.error('❌ Found Skill dependency violations:\n');
  for (const v of violations) {
    console.error(`  ${v.skillName} (${v.skillPhase}) → ${v.referencedSkill}\n`);
    console.error(`    at ${v.skillPath}:${v.lineNumber}\n`);
    console.error(`    ${v.snippet}...\n`);
  }

  console.error(`\n❌ Total violations: ${violations.length}`);
  console.error('💡 Skill正文不得包含对其他Skill的引用（尤其是跨阶段）。\n');
  process.exit(1);
}

checkSkillDependencies().catch((err) => {
  console.error('❌ Check failed:', err);
  process.exit(1);
});
