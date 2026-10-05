/**
 * 把仓库里的 `skills/` 下每个目录里的 SKILL.md 播种进 `pentest.skills`。
 *
 * 为什么走**服务层**而不是裸 SQL：内容哈希、revision 递增、审计留痕（配了
 * `skillAuditEngagementId` 时）都在 `PgSkillService` 里。脚本若自带一套哈希/版本语义，
 * 迟早与运行时漂移——「同一个 skill 两个哈希」是最难查的那类问题。
 *
 * 幂等：同名且内容哈希一致 → 跳过；不一致 → `updateSkill`（revision +1，留痕）。
 * 缺文件即失败：pack 里点了名却没有对应文件，说明仓库状态不完整，不能静默跳过。
 *
 * 用法：
 *   PENTEST_DATABASE_URL=postgresql://postgres:<pw>@127.0.0.1:55446/pentest_personal \
 *     node --import ./test/helpers/tsx-loader.mjs scripts/seed-skills.ts
 */
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Pool } from 'pg';

import { PgSkillService, skillContentHash } from '../src/skills/pg-skill.ts';
import { SKILL_PACKS, allPackSkillNames, parseSkillFile } from '../src/skills/skill-pack.ts';

const SKILLS_DIR = join(import.meta.dirname, '..', 'skills');
/** 操作者标识：写明这是**播种脚本**而不是某个人手动加的，审计里一眼可辨。 */
const SEEDER_OPERATOR = 'builtin-pack:skills';
/** 变更理由：会写进审计（配了 auditEngagementId 的部署），因此写成人类可读的一句话。 */
const SEED_REASON = '内置 skill pack 播种（scripts/seed-skills.ts）';

async function readPack(): Promise<Map<string, ReturnType<typeof parseSkillFile>>> {
  const entries = await readdir(SKILLS_DIR, { withFileTypes: true });
  const out = new Map<string, ReturnType<typeof parseSkillFile>>();
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const path = join(SKILLS_DIR, entry.name, 'SKILL.md');
    let text: string;
    try {
      text = await readFile(path, 'utf8');
    } catch {
      continue; // 目录里没有 SKILL.md：不是 skill（例如 references 目录）。
    }
    const parsed = parseSkillFile(text);
    if (parsed.name !== entry.name) {
      throw new Error(`${path}: frontmatter name=${parsed.name} 与目录名 ${entry.name} 不一致`);
    }
    out.set(parsed.name, parsed);
  }
  const missing = allPackSkillNames().filter((name) => !out.has(name));
  if (missing.length > 0) {
    throw new Error(`pack 里点到但仓库里没有文件的 skill：${missing.join('、')}`);
  }
  return out;
}

async function main(): Promise<number> {
  const dsn = process.env.PENTEST_DATABASE_URL;
  if (dsn === undefined || dsn.trim() === '') {
    console.error('缺少 PENTEST_DATABASE_URL（指向要播种的库，例如个人库 pentest_personal）');
    return 2;
  }
  const pack = await readPack();
  const pool = new Pool({ connectionString: dsn });
  try {
    const skills = new PgSkillService(pool);
    const existing = new Map((await skills.listSkills()).map((row) => [row.name, row]));
    let created = 0;
    let updated = 0;
    let unchanged = 0;
    for (const [name, parsed] of [...pack.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
      const current = existing.get(name);
      if (current === undefined) {
        await skills.addSkill({
          operatorId: SEEDER_OPERATOR,
          reason: SEED_REASON,
          name,
          description: parsed.description,
          body: parsed.body,
        });
        created += 1;
        continue;
      }
      if (current.contentHash === skillHashOf(parsed, current.revision)) {
        unchanged += 1;
        continue;
      }
      await skills.updateSkill({
        operatorId: SEEDER_OPERATOR,
        reason: SEED_REASON,
        skillId: current.id,
        name,
        description: parsed.description,
        body: parsed.body,
      });
      updated += 1;
    }
    const phases = Object.entries(SKILL_PACKS)
      .map(([phase, names]) => `  ${phase}: ${names.join('、')}`)
      .join('\n');
    console.log(`播种完成：新增 ${created}、更新 ${updated}、未变 ${unchanged}（共 ${pack.size} 个）`);
    console.log(`阶段默认装载：\n${phases}`);
    return 0;
  } finally {
    await pool.end();
  }
}

/**
 * 与服务层同源的哈希：借用它的实现，而不是自己算一遍。
 *
 * `revision` 参与哈希（§2.2），所以比对时必须用**库里那一行的 revision**，
 * 否则同一份内容永远算不相等、每次播种都白升一版。
 */
function skillHashOf(parsed: ReturnType<typeof parseSkillFile>, revision: number): string {
  return skillContentHash({
    name: parsed.name,
    description: parsed.description,
    body: parsed.body,
    revision,
  });
}

process.exitCode = await main();
