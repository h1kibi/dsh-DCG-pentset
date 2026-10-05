/**
 * 内置 skill pack 的完整性：**格式与规格一致、引用的命令真能在沙箱里跑**。
 *
 * 为什么值得一条永久测试：skill 正文是模型会照着执行的指令。一份格式跑偏（少了判据小节）
 * 或命令引用了镜像里不存在的工具（`ss`/`whatweb`/`nikto`），产出的不是「差一点的建议」，
 * 而是**让 Agent 在沙箱里反复失败**的错误知识——而且失败现场看起来像环境故障。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { PROFILE_DEFAULTS } from '../src/policy/behavior-profile.ts';
import { SKILL_PACKS, allPackSkillNames, parseSkillFile, type ParsedSkill } from '../src/skills/skill-pack.ts';

const SKILLS_DIR = join(import.meta.dirname, '..', 'skills');

/** 正文固定的八节，顺序即验收顺序（与 `skills/AUTHORING-SPEC.md` 一致）。 */
const SECTIONS = [
  '## 适用场景',
  '## 前提与边界',
  '## 步骤',
  '## 判读与去噪',
  '## 常见失败',
  '## 不做的事',
  '## 产出（交给下一步）',
  '## 参考',
] as const;

/**
 * 沙箱里**确实存在**的命令：镜像工具面 + POSIX 基础 + shell 内建。
 *
 * 白名单而不是黑名单：新增一个不认识的可执行名时测试会红，逼人确认「这工具真在镜像里」，
 * 而不是让一条永远跑不通的命令悄悄留在 skill 里。
 */
async function loadPack(): Promise<Map<string, { text: string; parsed: ParsedSkill }>> {
  const entries = await readdir(SKILLS_DIR, { withFileTypes: true });
  const out = new Map<string, { text: string; parsed: ParsedSkill }>();
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    let text: string;
    try {
      text = await readFile(join(SKILLS_DIR, entry.name, 'SKILL.md'), 'utf8');
    } catch {
      continue;
    }
    out.set(entry.name, { text, parsed: parseSkillFile(text) });
  }
  return out;
}

/**
 * 沙箱**已实测缺失**的工具：skill 里不得把它们当命令用。
 *
 * 为什么是黑名单而不是「白名单校验每条命令」：bash 的循环/数组/续行语法会让白名单提取器
 * 产生大量假阳性（`for h in x-frame-options …; do` 会被切出 `x-frame-options` 这种「命令」），
 * 一条天天误报的测试等于没有测试。这里的名单是**冒烟跑出来的事实**（`ss`/`ps`/`netstat` 在镜像里
 * 不存在、`whatweb`/`httpx` 没有、`nikto`/`gobuster`/`hydra` 没装），抓的是真故障模式：
 * 教 Agent 跑一条注定 `command not found` 的命令。
 * 往镜像里加了工具，就把它从这份名单里删掉——这正是这条测试要逼人做的确认。
 */
const ABSENT_IN_SANDBOX = [
  'ss', 'ps', 'netstat', 'whatweb', 'httpx', 'nikto', 'gobuster', 'dirb', 'wfuzz',
  'hydra', 'medusa', 'masscan', 'ssh', 'scp', 'telnet', 'ftp', 'smbclient', 'ldapsearch',
  'amass', 'subfinder', 'gau', 'waybackurls', 'arjun', 'wpscan', 'searchsploit', 'msfconsole',
] as const;

/** 抽出 ```bash 围栏里的所有 token，逐个对照黑名单（不做「哪一个是命令」的判断）。 */
function bashTokensOf(body: string): readonly string[] {
  const blocks = [...body.matchAll(/```bash\n([\s\S]*?)```/g)].map((m) => m[1] ?? '');
  const tokens = new Set<string>();
  for (const block of blocks) {
    for (const rawLine of block.split('\n')) {
      const line = rawLine.trim();
      if (line === '' || line.startsWith('#')) continue;
      // 命令行（含续行）里的每一个词都可能是被当成命令用的工具名；参数位置同样要查，
      // 因为 `| ss -tlnp` 这种「管道里换个工具」正是最容易漏的写法。
      for (const token of line.split(/[\s|;&()<>]+/)) {
        const name = token.replace(/^["'`$(-]+/, '').replace(/["'`;:)*]+$/, '');
        if (name !== '') tokens.add(name);
      }
    }
  }
  return [...tokens];
}

test('pack 名单与仓库文件一一对应，且目录名与 frontmatter 一致', async () => {
  const pack = await loadPack();
  for (const name of allPackSkillNames()) {
    assert.ok(pack.has(name), `pack 点了名但仓库里没有 skills/${name}/SKILL.md`);
  }
  for (const [dir, { parsed }] of pack) {
    assert.equal(parsed.name, dir, `frontmatter name=${parsed.name} 与目录 ${dir} 不一致`);
    assert.ok(allPackSkillNames().includes(dir), `${dir} 不在任何阶段的 pack 名单里（加了文件就要挂进 SKILL_PACKS）`);
  }
});

test('每份 skill：phase 与 pack 归属一致、八节齐全且顺序正确、≤300 行、LF', async () => {
  const pack = await loadPack();
  for (const [phase, names] of Object.entries(SKILL_PACKS)) {
    for (const name of names) {
      const entry = pack.get(name);
      assert.ok(entry !== undefined, `缺少 ${name}`);
      const { text, parsed } = entry;
      assert.equal(parsed.phase, phase, `${name} 的 phase 与所在 pack（${phase}）不一致`);
      assert.ok(parsed.sources.length > 0, `${name} 没写 sources——参考出处是原创性的凭据`);
      const positions = SECTIONS.map((section) => parsed.body.indexOf(`\n${section}`));
      for (const [index, position] of positions.entries()) {
        assert.ok(position >= 0, `${name} 缺少小节 ${SECTIONS[index]}`);
        if (index > 0) {
          assert.ok(positions[index - 1]! < position, `${name} 的小节顺序不符合规格：${SECTIONS[index]}`);
        }
      }
      assert.ok(text.split('\n').length <= 300, `${name} 超过 300 行`);
      assert.equal(text.includes('\r'), false, `${name} 含 CRLF——规格要求 LF`);
    }
  }
});

test('每一步都自带「命令 + 期望 + 判据」——这是这类 skill 的全部价值所在', async () => {
  // 规格把每一步写成三段：能跑的命令、期望的输出形态、可判定的判据。
  // 少了任何一段，这份 skill 就从「可执行的作业指导」退化成「一段读起来有道理的话」，
  // 而后者正是模型最容易照着自信跑偏的形态。
  const pack = await loadPack();
  const offenders: string[] = [];
  for (const [name, { parsed }] of pack) {
    const steps = parsed.body.split('\n## 步骤\n')[1]?.split('\n## ')[0] ?? '';
    const chunks = steps.split(/^### /m).slice(1);
    if (chunks.length === 0) offenders.push(`${name}: 没有分步（### 小节）`);
    for (const chunk of chunks) {
      const title = chunk.split('\n')[0]?.trim() ?? '';
      // 表格步（分级矩阵、判定表）本来就无命令可跑：要求它必须带 ```bash 只会逼人凑一条假命令。
      const isTableStep = /^\|.*\|$/m.test(chunk);
      if (!isTableStep && !chunk.includes('```bash')) offenders.push(`${name} / ${title}: 缺命令块`);
      // 「期望/判据」加不加粗是排版，不是内容：只认这两个词是否出现（两种冒号都算）。
      if (!/\*{0,2}期望\*{0,2}(（[^）]*）)?\s*[:：]/.test(chunk)) offenders.push(`${name} / ${title}: 缺「期望」`);
      if (!/\*{0,2}判据\*{0,2}(（[^）]*）)?\s*[:：]/.test(chunk)) offenders.push(`${name} / ${title}: 缺「判据」`);
    }
  }
  assert.deepEqual(offenders, [], '每一步都必须有：```bash 命令 + **期望** + **判据**');
});

test('skill 必须自足：不引用 Agent 取不到的其它 skill 正文，也不依赖仓库文件', async () => {
  // 两次踩过的坑：① 跨阶段引用（「见 skill `vuln-triage`」）——`skill_load` 只认本会话装载集合，
  // 跨阶段的引用在运行时取不到正文，等于死链；② 依赖 `references/xxx.md` ——生态里可行是因为
  // harness 能读 skill 目录，而本插件的正文是入库的，Agent 拿不到那些文件。
  // 结论写进 skills/README.md：正文必须自足，渐进披露靠 `skill_load` 本身。
  const pack = await loadPack();
  const packOf = new Map<string, string>();
  for (const [phase, names] of Object.entries(SKILL_PACKS)) for (const name of names) packOf.set(name, phase);
  const offenders: string[] = [];
  for (const [name, { parsed }] of pack) {
    for (const match of parsed.body.matchAll(/skill\s*`([a-z0-9-]+)`/g)) {
      const ref = match[1] ?? '';
      if (ref === '' || ref === name || !packOf.has(ref)) continue;
      if (packOf.get(ref) !== packOf.get(name)) offenders.push(`${name} 跨阶段引用 ${ref}`);
    }
    for (const match of parsed.body.matchAll(/references\/[A-Za-z0-9._-]+/g)) {
      offenders.push(`${name} 依赖外部文件 ${match[0]}`);
    }
  }
  assert.deepEqual(offenders, [], '正文必须自足：跨阶段引用与 references/ 依赖在运行时都取不到');
});

test('skill 里写的速率必须与 PROFILE_DEFAULTS 一致（数字散在多处，最容易悄悄走样）', async () => {
  const pack = await loadPack();
  const offenders: string[] = [];
  for (const [name, { parsed }] of pack) {
    for (const match of parsed.body.matchAll(/(stealth|standard|deep)\s*(\d+)\s*\/\s*s/g)) {
      const profile = match[1] as 'stealth' | 'standard' | 'deep';
      const claimed = Number(match[2]);
      const actual = PROFILE_DEFAULTS[profile].pacing.rate;
      if (claimed !== actual) offenders.push(`${name}: 写的是 ${profile} ${claimed}/s，实际 ${actual}/s`);
    }
  }
  assert.deepEqual(offenders, [], 'skill 里的速率声明与代码里的预设不一致——要么改 skill，要么改预设（只能二选一）');
});

test('每份 skill 都得有实质内容：至少 3 条「不做的事」与 3 行失败表', async () => {
  // 防止未来加进来一份「八节齐全但每节一句话」的空壳：结构对了不等于有用。
  // 这两个下限来自现有 21 份的实测区间（不做的事 3–5 条、失败表 4–15 行），取保守下界。
  const pack = await loadPack();
  const offenders: string[] = [];
  for (const [name, { parsed }] of pack) {
    const body = parsed.body;
    const dont = (body.split('## 不做的事')[1]?.split('## ')[0] ?? '')
      .split('\n')
      .filter((line) => line.trim().startsWith('- ')).length;
    const failRows = (body.split('## 常见失败')[1]?.split('## ')[0] ?? '')
      .split('\n')
      .filter((line) => line.trim().startsWith('|') && !/^\|\s*-+/.test(line.trim())).length;
    if (dont < 3) offenders.push(`${name}: 「不做的事」只有 ${dont} 条（下限 3）`);
    // 计数已排除分隔行（`|---|`），只剩表头要减：数据行 = failRows - 1。
    if (failRows - 1 < 3) offenders.push(`${name}: 「常见失败」只有 ${Math.max(0, failRows - 1)} 行（下限 3）`);
  }
  assert.deepEqual(offenders, [], 'skill 要有实质内容：不做的事 ≥3 条、常见失败 ≥3 行');
});

test('每份 skill 都要有**绑定当前镜像**的冒烟证明（镜像一换，证明就该失效）', async () => {
  // 命令「跑过」这件事以前只存在会话报告里，机器无法核对。现在写进 frontmatter：
  // `沙箱实测@<镜像摘要前 12 位>：<跑过什么>`，或 `无需沙箱：<原因>`（纯文本步骤）。
  // 摘要是关键：镜像重建（digest 变）后证明自动失效，测试会红，逼人重跑而不是让旧背书一直挂着。
  const pack = await loadPack();
  const overlay = await readFile(join(import.meta.dirname, '..', 'harness.dev.patch.yml'), 'utf8');
  const digest = /sha256:([0-9a-f]{64})/.exec(overlay)?.[1];
  assert.ok(digest !== undefined, 'harness.dev.patch.yml 里读不到沙箱镜像摘要');
  const prefix = digest.slice(0, 12);
  const offenders: string[] = [];
  for (const [name, { parsed }] of pack) {
    const smoked = parsed.smoked ?? '';
    if (smoked === '') { offenders.push(`${name}: 缺 smoked 字段`); continue; }
    if (smoked.startsWith('无需沙箱：')) continue;
    const matched = /^沙箱实测@([0-9a-f]{12})：/.exec(smoked);
    if (matched === null) { offenders.push(`${name}: smoked 格式不合规`); continue; }
    if (matched[1] !== prefix) {
      offenders.push(`${name}: 证明绑定 ${matched[1]}，当前镜像 ${prefix} —— 镜像换过，命令必须重跑`);
    }
  }
  assert.deepEqual(offenders, []);
});

test('skill 里不得出现沙箱实测缺失的工具（否则是在教 Agent 反复失败）', async () => {
  const pack = await loadPack();
  const absent = new Set<string>(ABSENT_IN_SANDBOX);
  const offenders: string[] = [];
  for (const [name, { parsed }] of pack) {
    for (const token of bashTokensOf(parsed.body)) {
      if (absent.has(token)) offenders.push(`${name}: ${token}`);
    }
  }
  assert.deepEqual(
    offenders,
    [],
    '这些工具名出现在 bash 代码块里，但镜像里没有它们。改用存在的工具，或把工具加进镜像并同步 SANDBOX_TOOLBELT/本名单',
  );
});
