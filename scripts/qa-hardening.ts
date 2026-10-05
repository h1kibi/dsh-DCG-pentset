import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { SKILL_PACKS, parseSkillFile } from '../src/skills/skill-pack.ts';

const dir = 'skills';
const packOf = new Map<string, string>();
for (const [phase, names] of Object.entries(SKILL_PACKS)) for (const n of names) packOf.set(n, phase);

const files = new Map<string, string>();
for (const e of await readdir(dir, { withFileTypes: true })) {
  if (!e.isDirectory()) continue;
  try { files.set(e.name, parseSkillFile(await readFile(join(dir, e.name, 'SKILL.md'), 'utf8')).body); } catch { /* 解析失败：跳过该 skill（脚本只做自检，不阻断） */ }
}

console.log('=== 1) 跨 pack 引用（Agent 取不到被引用的正文 → 死引用）===');
let dead = 0;
for (const [name, body] of files) {
  for (const m of body.matchAll(/skill\s*`([a-z0-9-]+)`|`([a-z0-9-]+)`\s*(?:这份|技能|skill)/g)) {
    const ref = m[1] ?? m[2] ?? '';
    if (ref === '' || ref === name) continue;
    if (!packOf.has(ref)) continue;
    if (packOf.get(ref) !== packOf.get(name)) { console.log(`  ${name}(${packOf.get(name)}) → ${ref}(${packOf.get(ref)})`); dead += 1; }
  }
}
console.log(dead === 0 ? '  无死引用' : `  死引用 ${dead} 处`);

console.log('=== 2) 依赖 references/ 的自足性缺陷 ===');
let refDep = 0;
for (const [name, body] of files) {
  for (const m of body.matchAll(/references\/[A-Za-z0-9._-]+|见\s*`?README\.md/g)) {
    console.log(`  ${name}: ${m[0]}`);
    refDep += 1;
  }
}
console.log(refDep === 0 ? '  无（全部自足）' : `  依赖外部文件 ${refDep} 处`);

console.log('=== 3) 沙箱事实一致性（三处字典名 / 速率 / 无外网）===');
const facts = { wordlists: 0, rates: 0, noEgress: 0 };
for (const [, body] of files) {
  if (/\/usr\/share\/wordlists\/\{?common\.txt/.test(body)) facts.wordlists += 1;
  if (/stealth\s*1\/s/.test(body)) facts.rates += 1;
  if (/没有外网|无外网|外网.*不可达/.test(body)) facts.noEgress += 1;
}
console.log(`  提及字典路径 ${facts.wordlists} 份 | 提及速率 ${facts.rates} 份 | 提及无外网 ${facts.noEgress} 份`);
