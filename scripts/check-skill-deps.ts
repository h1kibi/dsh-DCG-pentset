#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.join(__dirname, '..');
const SKILLS_DIR = path.join(PROJECT_ROOT, 'skills');

interface SkillMetadata {
  readonly name: string;
  readonly phase: string;
  readonly path: string;
}

interface DependencyViolation {
  readonly skillName: string;
  readonly skillPhase: string;
  readonly skillPath: string;
  readonly referencedSkill: string;
  readonly lineNumber: number;
  readonly snippet: string;
}

function extractMetadata(content: string): { name: string; phase: string } | null {
  const frontmatterMatch = content.match(/^---\n([\s\S]+?)\n---\n/);
  if (!frontmatterMatch || !frontmatterMatch[1]) return null;

  const frontmatter = frontmatterMatch[1];
  const nameMatch = frontmatter.match(/^name:\s*(.+)$/m);
  const phaseMatch = frontmatter.match(/^\s+phase:\s*(.+)$/m);

  if (!nameMatch || !nameMatch[1] || !phaseMatch || !phaseMatch[1]) return null;

  return {
    name: nameMatch[1].trim(),
    phase: phaseMatch[1].trim(),
  };
}

function extractBody(content: string): string {
  const bodyMatch = content.match(/^---\n[\s\S]+?\n---\n([\s\S]*)$/);
  return bodyMatch && bodyMatch[1] ? bodyMatch[1] : content;
}

function findSkillReferences(body: string, allSkillNames: readonly string[]): Array<{ name: string; line: number; snippet: string }> {
  const references: Array<{ name: string; line: number; snippet: string }> = [];
  const lines = body.split('\n');

  for (let i = 0; i < lines.length; i++) {
    const currentLine = lines[i];
    if (typeof currentLine !== 'string' || !currentLine) continue;

    for (const skillName of allSkillNames) {
      const regex = new RegExp(`\\b${skillName}\\b`, 'g');
      if (regex.test(currentLine)) {
        references.push({
          name: skillName,
          line: i + 1,
          snippet: currentLine.trim().substring(0, 100),
        });
      }
    }
  }

  return references;
}

async function checkSkillDependencies(): Promise<void> {
  console.log('🔍 Checking Skill dependencies...\n');

  const skillFiles = fs.readdirSync(SKILLS_DIR).filter((file) => {
    const fullPath = path.join(SKILLS_DIR, file);
    try {
      return fs.statSync(fullPath).isDirectory();
    } catch {
      return false;
    }
  });

  const skills: SkillMetadata[] = [];
  const skillNameToPhase: Record<string, string> = {};
  const allSkillNames: string[] = [];

  for (const skillDir of skillFiles) {
    const skillPath = path.join(SKILLS_DIR, skillDir, 'SKILL.md');
    if (!fs.existsSync(skillPath)) continue;

    const content = fs.readFileSync(skillPath, 'utf-8');
    const metadata = extractMetadata(content);
    if (!metadata) continue;

    skills.push({
      name: metadata.name,
      phase: metadata.phase,
      path: skillPath,
    });
    skillNameToPhase[metadata.name] = metadata.phase;
    allSkillNames.push(metadata.name);
  }

  console.log(`✓ Found ${skills.length} Skills\n`);

  const violations: DependencyViolation[] = [];

  for (const skill of skills) {
    const content = fs.readFileSync(skill.path, 'utf-8');
    const body = extractBody(content);

    const references = findSkillReferences(body, allSkillNames);
    for (const ref of references) {
      const refPhase = skillNameToPhase[ref.name];
      if (refPhase && skill.phase !== refPhase) {
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

  if (violations.length === 0) {
    console.log('✅ No Skill dependency violations found.\n');
    process.exit(0);
  }

  console.error('❌ Found Skill dependency violations:\n');
  for (const v of violations) {
    console.error(`  ${v.skillName} (${v.skillPhase}) → ${v.referencedSkill}`);
    console.error(`    at ${v.skillPath}:${v.lineNumber}`);
    console.error(`    ${v.snippet}...\n`);
  }

  console.error(`❌ Total violations: ${violations.length}`);
  console.error('💡 Skill正文不得包含对其他Skill的引用（尤其是跨阶段）.\n');
  process.exit(1);
}

checkSkillDependencies().catch((err) => {
  console.error('❌ Check failed:', err);
  process.exit(1);
});
