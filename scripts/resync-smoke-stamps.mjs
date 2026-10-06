// 把 skills/*/SKILL.md 里的 `沙箱实测@<12 位摘要>` 前缀统一换成新摘要。
// 用途：镜像重建 → 摘要变化 → 21 份冒烟背书必须跟着换（test/skill-pack.test.ts 会核对）。
// 安全性：只动 `沙箱实测@<12hex>` 这一个 token，且断言替换数量，避免误伤正文里的其它摘要引用。
import fs from 'node:fs';
import path from 'node:path';

const next = process.argv[2];
if (!/^[0-9a-f]{12}$/.test(String(next))) {
  console.error('用法：node resync-smoke-stamps.mjs <新摘要前 12 位十六进制>');
  process.exit(2);
}
const dir = 'skills';
let files = 0;
let tokens = 0;
const seenOld = new Set();
for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
  if (!entry.isDirectory()) continue;
  const file = path.join(dir, entry.name, 'SKILL.md');
  if (!fs.existsSync(file)) continue;
  const before = fs.readFileSync(file, 'utf8');
  for (const hit of before.matchAll(/沙箱实测@([0-9a-f]{12})/g)) seenOld.add(hit[1]);
  const after = before.replace(/沙箱实测@[0-9a-f]{12}/g, `沙箱实测@${next}`);
  if (after !== before) {
    fs.writeFileSync(file, after);
    files += 1;
    tokens += (before.match(/沙箱实测@[0-9a-f]{12}/g) ?? []).length;
  }
}
console.log(`改了 ${files} 份、${tokens} 处；替换前的摘要值：${[...seenOld].join(', ')}`);
