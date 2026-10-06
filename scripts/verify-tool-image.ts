/**
 * 工具镜像自检：**声明的工具在镜像里真的存在吗**。
 *
 * ── 为什么需要它 ──
 *
 * `SANDBOX_TOOL_GROUPS`（提示词里告诉模型"有什么"的那份清单）与 `docker/tools/Dockerfile`
 * 之间有一条源码级一致性检查（`test/sandbox-environment.test.ts`，只看 Dockerfile 文本）。
 * 但那只能证明"我们声明过的包名写进了安装清单"，证明不了**装完真的能用**：
 * 包名写错、pip 包没有 console script、Go 二进制因 CGO 成了坏链接——这几种都只有真跑一遍才知道。
 *
 * 于是这条自检把清单拿去**问镜像本身**（`command -v`），并顺带检查字典与模板目录。
 * 典型用法（RUNBOOK §2.1 的升级流程第 ② 步）：
 *
 *   # 先构建/拿到镜像（标签或 digest 都行）
 *   docker build -t pentest-tools:dev docker/tools
 *   npm run verify:tool-image -- pentest-tools:dev
 *   # 全绿之后再推 registry、抄 digest、重跑 skill 冒烟
 *
 * 退出码：0 全部存在；1 有缺失（逐条打印，便于直接改 Dockerfile）；2 用法错误（镜像跑不起来）。
 */

import { spawnSync } from 'node:child_process';

import { SANDBOX_TEMPLATE_DIR, SANDBOX_TOOL_GROUPS, SANDBOX_WORDLISTS } from '../src/contracts.ts';

const image = process.argv[2];
if (image === undefined || image === '') {
  process.stderr.write(
    '用法：npm run verify:tool-image -- <镜像引用>\n' +
      '  例：npm run verify:tool-image -- pentest-tools:dev\n' +
      '  例：npm run verify:tool-image -- 127.0.0.1:5005/pentest-tools@sha256:<digest>\n',
  );
  process.exit(2);
}

/** 逐个 `command -v`：缺哪个打印哪个（不让一条坏命令换成一个笼统的失败）。 */
const toolNames = SANDBOX_TOOL_GROUPS.flatMap((group) => group.tools.map((tool) => tool.name));
// `impacket-*` 是通配形式（pip 装的一组脚本），单独按前缀检查。
const exactNames = toolNames.filter((name) => !name.includes('*'));
const wildcardNames = toolNames.filter((name) => name.includes('*'));

const probes = [
  ...exactNames.map((name) => ({ label: name, shell: `command -v ${name}` })),
  ...wildcardNames.map((name) => {
    const prefix = name.replace(/\*$/, '');
    // pip 的 console script 落在 /usr/local/bin，Debian 包落在 /usr/bin——
    // 两处都要查（2026-10-06 实测：impacket 的 `impacket-*` 来自 Debian 包，在 /usr/bin 下，
    // 只查 /usr/local/bin 会把它误报成缺失）。
    return {
      label: name,
      shell: `ls -1 /usr/local/bin /usr/bin 2>/dev/null | grep -c '^${prefix}' | grep -qv '^0$'`,
    };
  }),
  ...SANDBOX_WORDLISTS.map((wordlist) => ({
    label: `/usr/share/wordlists/${wordlist.file}`,
    shell: `test -s /usr/share/wordlists/${wordlist.file}`,
  })),
  { label: SANDBOX_TEMPLATE_DIR, shell: `test -d ${SANDBOX_TEMPLATE_DIR}` },
  {
    label: `${SANDBOX_TEMPLATE_DIR}/*.yaml（自建模板）`,
    shell: `ls ${SANDBOX_TEMPLATE_DIR}/*.yaml 2>/dev/null | head -1 | grep -q yaml`,
  },
];

const script = probes.map((probe) => `${probe.shell} || echo "MISSING:${probe.label}"`).join('\n');
const run = spawnSync('docker', ['run', '--rm', '--entrypoint', '/bin/sh', image, '-c', script], {
  encoding: 'utf8',
  maxBuffer: 4 * 1024 * 1024,
});

if (run.error !== undefined || run.status !== 0) {
  process.stderr.write(
    `镜像 ${image} 跑不起来（docker 退出码 ${String(run.status)}）：${run.stderr || String(run.error)}\n`,
  );
  process.exit(2);
}

const missing = run.stdout
  .split('\n')
  .filter((line) => line.startsWith('MISSING:'))
  .map((line) => line.slice('MISSING:'.length));

if (missing.length > 0) {
  process.stdout.write(`工具镜像自检失败：${String(missing.length)} 项缺失\n`);
  for (const item of missing) process.stdout.write(`  ✗ ${item}\n`);
  process.stdout.write(
    '\n修法：把工具装进 docker/tools/Dockerfile（apt / pip / go 任一），' +
      '并按 test/sandbox-environment.test.ts 的要求把出处写进 src/contracts.ts 的 SANDBOX_TOOL_GROUPS。\n' +
      '若是**有意不装**的工具：从 SANDBOX_TOOL_GROUPS 删掉声明，并在该组的 usage 里写明为什么。\n',
  );
  process.exit(1);
}

const digestRun = spawnSync('docker', ['inspect', image, '--format', '{{index .RepoDigests 0}}'], {
  encoding: 'utf8',
});
const digest = digestRun.stdout.trim() === '' ? '（本地标签，无 RepoDigest——推 registry 后才有）' : digestRun.stdout.trim();

process.stdout.write(
  `工具镜像自检通过：${String(probes.length)} 项（${String(exactNames.length)} 个命令 + ` +
    `${String(wildcardNames.length)} 个通配前缀 + ${String(SANDBOX_WORDLISTS.length)} 份字典 + 模板目录）\n` +
    `镜像：${image}\n` +
    `digest：${digest}\n` +
    '\n下一步（RUNBOOK §2.1）：推 registry → 抄 digest 到 profile 与 harness.dev.patch.yml → ' +
    '重跑各 skill 的冒烟命令（test/skill-pack.test.ts 会核对，摘要对不上就红）。\n',
);
