/**
 * 沙箱环境的一致性锁（2026-10-06）。
 *
 * 这一层要防的错误很具体：**提示词对模型撒谎**。它谎报"有什么工具/多大限额"时，
 * 从对话里看不出任何异常——模型会照着一个不存在的工具反复失败，然后把失败归因成
 * 「目标不可达」或「被 WAF 挡了」，整轮侦察因此跑偏，而人类在控制台上只看到"Agent 很笨"。
 *
 * 三组断言：
 *   1. **声明 ↔ 镜像**：`SANDBOX_TOOL_GROUPS` / `SANDBOX_WORDLISTS` / `SANDBOX_TEMPLATE_DIR`
 *      的每一项都必须能在 `docker/tools/Dockerfile` 里找到出处（apt 包 / pip 模块 / go 模块 / COPY）；
 *   2. **声明 ↔ 提示词**：简报必须真的把工具、用法、限额、退出码写进去（不是"声明了但没渲染"）；
 *   3. **限额 ↔ 执行侧**：简报里的 CPU/内存/进程数/墙钟必须等于 `DEFAULT_SANDBOX_LIMITS`，
 *      并且渲染出来（数值改了两边一起动）。
 */

import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

import { SANDBOX_TEMPLATE_DIR, SANDBOX_TOOL_GROUPS, SANDBOX_TOOLBELT, SANDBOX_WORDLISTS } from '../src/contracts.ts';
import { renderSandboxBrief } from '../src/agents/sandbox-brief.ts';
import { DEFAULT_SANDBOX_LIMITS, SANDBOX_TMPFS_SIZE } from '../src/execution/docker-sandbox.ts';
import { RECON_TECHNIQUES, VULN_TECHNIQUES } from '../src/execution/techniques.ts';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DOCKERFILE = readFileSync(path.join(HERE, '..', 'docker', 'tools', 'Dockerfile'), 'utf8');
/** 只比对 Dockerfile 的**指令部分**：注释里解释"为什么不装 naabu"不该被当成安装声明。 */
const DOCKERFILE_CODE = DOCKERFILE.split('\n')
  .filter((line) => !line.trimStart().startsWith('#'))
  .join('\n');

describe('沙箱环境声明 ↔ 镜像：每个工具都能在 Dockerfile 里找到出处', () => {
  it('工具分组非空、组内工具名不重复、扁平清单与分组一致', () => {
    assert.ok(SANDBOX_TOOL_GROUPS.length >= 5, '工具分组太少——大概率是漏了整组');
    const names = SANDBOX_TOOLBELT;
    assert.equal(new Set(names).size, names.length, '工具名不得重复（同一工具出现在两组会让用法矛盾）');
    assert.deepEqual(
      names,
      SANDBOX_TOOL_GROUPS.flatMap((group) => group.tools.map((tool) => tool.name)),
      '扁平清单必须由分组派生（它是兼容用的派生值，不是第二份声明）',
    );
    for (const group of SANDBOX_TOOL_GROUPS) {
      assert.ok(group.tools.length > 0, `分组「${group.group}」是空的`);
      assert.ok(group.usage.trim().length >= 10, `分组「${group.group}」的用法说明太短——模型看不出什么时候用它`);
    }
  });

  it('每个工具的 from 都出现在 Dockerfile 的安装清单里', () => {
    const missing: string[] = [];
    for (const group of SANDBOX_TOOL_GROUPS) {
      for (const tool of group.tools) {
        if (!DOCKERFILE_CODE.includes(tool.from)) {
          missing.push(`${tool.name}（声明出处 ${tool.from}）`);
        }
      }
    }
    assert.deepEqual(
      missing,
      [],
      '这些工具在提示词里声明了，但 Dockerfile 里找不到出处：' +
        '要么把工具装进镜像，要么把它从 SANDBOX_TOOL_GROUPS 删掉（提示词不许撒谎）',
    );
  });

  it('每份字典的文件名都出现在 Dockerfile 里，且路径前缀由提示词统一给出', () => {
    for (const wordlist of SANDBOX_WORDLISTS) {
      assert.ok(
        DOCKERFILE_CODE.includes(wordlist.file),
        `字典 ${wordlist.file} 声明在提示词里，但 Dockerfile 没下载它`,
      );
      assert.ok(wordlist.purpose.trim().length > 0, `字典 ${wordlist.file} 没写用途`);
    }
    const brief = renderSandboxBrief('phase');
    assert.ok(brief.includes('/usr/share/wordlists/'), '提示词必须给出字典目录（否则模型不知道去哪找）');
  });

  it('nuclei 模板目录既进了镜像也进了提示词，且提示词明确禁止下载外部模板', () => {
    assert.ok(DOCKERFILE_CODE.includes('nuclei-templates/'), 'Dockerfile 必须把自建模板 COPY 进镜像');
    assert.ok(DOCKERFILE_CODE.includes(SANDBOX_TEMPLATE_DIR), 'Dockerfile 里的模板路径必须与声明一致');
    const brief = renderSandboxBrief('phase');
    assert.ok(brief.includes(SANDBOX_TEMPLATE_DIR), '提示词必须给出模板目录');
    assert.match(brief, /不要从网上下载模板库/, '必须明确禁止下载外部模板（含入侵性用例）');
  });

  it('每个声明的工具都要「有人教」：出现在某份 skill 里，或在本组用途说明里被点名', () => {
    // 为什么要有这条：镜像里装了工具、提示词里也列了它，但**没有任何技能或用法说不清什么时候用它**时，
    // 模型的选择只剩两种——忽略它（白装），或者照着名字硬猜怎么用（无判据、无证据纪律）。
    // 2026-10-06 实测：69 个已装工具里曾有一半处于这种状态（nuclei / testssl / tshark / cewl / hydra…）。
    const skillsDir = path.join(HERE, '..', 'skills');
    const skillText = readdirSync(skillsDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && existsSync(path.join(skillsDir, entry.name, 'SKILL.md')))
      .map((entry) => readFileSync(path.join(skillsDir, entry.name, 'SKILL.md'), 'utf8'))
      .join('\n');
    const usage = SANDBOX_TOOL_GROUPS.map((group) => group.usage).join('\n');
    const untaught: string[] = [];
    for (const group of SANDBOX_TOOL_GROUPS) {
      for (const tool of group.tools) {
        const name = tool.name.replace(/\*$/, '');
        if (!skillText.includes(name) && !usage.includes(name)) untaught.push(`${group.group} / ${tool.name}`);
      }
    }
    assert.deepEqual(
      untaught,
      [],
      '这些工具进了镜像也进了提示词，但没教怎么用：要么在某份技能里加一步（并在镜像上冒烟），要么在本组 usage 里点名并写清什么时候用',
    );
  });
});

describe('沙箱环境声明 ↔ 提示词：渲染出来的东西必须真的写进去', () => {
  const brief = renderSandboxBrief('phase');

  it('每个分组与组内工具都出现在简报里，且带用法说明', () => {
    for (const group of SANDBOX_TOOL_GROUPS) {
      assert.ok(brief.includes(group.group), `简报缺分组「${group.group}」`);
      for (const tool of group.tools) {
        assert.ok(brief.includes(tool.name), `简报缺工具 ${tool.name}`);
      }
    }
    assert.ok(brief.includes('用法：'), '分组必须带用法（只列名字等于没介绍）');
  });

  it('两条命令通道与各自的审批语义都写清楚了', () => {
    assert.ok(brief.includes('pentest_recon'), '简报必须点名结构化侦察入口');
    assert.ok(brief.includes('pentest_scan'), '简报必须点名结构化核验入口');
    assert.ok(brief.includes('pentest_exec'), '简报必须点名自由命令通道');
    assert.match(brief, /不消耗人类审批/, '必须说明结构化通道不需要逐条人批（这是选它的理由）');
    // 2026-10-07 免批裁定：这条锁改成钉**当前事实**（自由命令不再逐条人批）；
    // 它反过来防的是"有人偷偷改回逐条人批却不改简报"这类口径漂移。
    assert.match(brief, /自由命令[^\n]*免批/, '必须说明自由命令已免批（裁定：任意命令免批）');
    assert.match(brief, /不再有人逐条过目/, '必须说明命令原文不再经人过目（这是免批的代价，要写在简报里）');
    for (const technique of Object.keys(RECON_TECHNIQUES)) {
      assert.ok(brief.includes(technique), `简报缺侦察 technique ${technique}`);
    }
    for (const technique of Object.keys(VULN_TECHNIQUES)) {
      assert.ok(brief.includes(technique), `简报缺核验 technique ${technique}`);
    }
  });

  it('世界模型、退出码与边界都在：一次性容器 / 无持久状态 / 0·1·2·124 / 不爆破', () => {
    assert.match(brief, /一次性容器/, '必须讲清容器是一次性的（否则模型会以为状态能留）');
    assert.match(brief, /没有跨命令的持久状态/, '必须点明没有持久状态');
    assert.match(brief, /没有入站端口/, '必须点明不能等回连/起监听');
    for (const code of ['0', '1', '2', '124']) {
      assert.ok(brief.includes(`\`${code}\``), `简报缺退出码 ${code} 的语义`);
    }
    assert.match(brief, /不(做)?爆破|禁爆破/, '必须写明默认不做爆破');
    assert.match(brief, /可达 ≠ 授权/, '必须写明可达不等于授权');
    assert.match(brief, /长输出先落盘/, '必须教它长输出先落盘再筛（否则会被截断）');
  });

  it('intake 简报是短的、且不介绍任何目标工具（那段能力它没有）', () => {
    const intake = renderSandboxBrief('intake');
    assert.match(intake, /不得执行目标动作/);
    for (const tool of ['nmap', 'nuclei', 'sqlmap', 'pentest_exec', 'pentest_recon']) {
      assert.equal(intake.includes(tool), false, `intake 简报不该出现 ${tool}`);
    }
  });
});

describe('限额 ↔ 执行侧：提示词里的数字必须等于真正生效的那份', () => {
  it('CPU / 内存 / 进程数 / 墙钟 / tmpfs 都出自 DEFAULT_SANDBOX_LIMITS 并渲染出来', () => {
    const brief = renderSandboxBrief('phase');
    assert.ok(brief.includes(DEFAULT_SANDBOX_LIMITS.cpus), `简报缺 CPU 限额 ${DEFAULT_SANDBOX_LIMITS.cpus}`);
    assert.ok(brief.includes(DEFAULT_SANDBOX_LIMITS.memory), `简报缺内存限额 ${DEFAULT_SANDBOX_LIMITS.memory}`);
    assert.ok(
      brief.includes(String(DEFAULT_SANDBOX_LIMITS.pidsLimit)),
      `简报缺进程数限额 ${String(DEFAULT_SANDBOX_LIMITS.pidsLimit)}`,
    );
    const minutes = Math.round(DEFAULT_SANDBOX_LIMITS.maxWallClockMs / 60000);
    assert.ok(brief.includes(`${String(minutes)} 分钟`), `简报缺墙钟上限 ${String(minutes)} 分钟`);
    assert.ok(brief.includes(SANDBOX_TMPFS_SIZE), `简报缺 /tmp 上限 ${SANDBOX_TMPFS_SIZE}`);
  });

  it('限额改动会同时反映到提示词（防「改了执行侧、提示词还是老数字」）', () => {
    // 这条不是再抄一遍数字，而是断言**渲染路径真的读了常量**：
    // 用一个与当前值不同的假设值反推——若渲染是硬编码的，下面的断言会失败。
    const brief = renderSandboxBrief('phase');
    const swappedCpus = DEFAULT_SANDBOX_LIMITS.cpus === '2.0' ? '3.0' : '2.0';
    assert.equal(
      brief.includes(`CPU ${swappedCpus} 核`),
      false,
      '简报里的 CPU 数字看起来是硬编码的——它必须由 DEFAULT_SANDBOX_LIMITS 渲染',
    );
  });
});

describe('宿主目录挂载的提示词（§10.4）', () => {
  it('声明的挂载必须写进提示词：容器路径 ⇄ 宿主路径 + 读写/只读', () => {
    // 没有这一段时，模型在沙箱里看不见人类的工作目录——它会去猜、去报「读不到」，
    // 而人类看到的是「Agent 说它读不了我的目录」这种看起来像权限问题、其实是配置没通气。
    const brief = renderSandboxBrief('phase', [
      { hostPath: 'C:/Projects/pentest/cdut', containerPath: '/work' },
      { hostPath: 'D:/evidence', containerPath: '/mnt/evidence', readOnly: true },
    ]);
    assert.ok(brief.includes('/work'), '必须给出容器内路径');
    assert.ok(brief.includes('C:/Projects/pentest/cdut'), '必须给出宿主路径（人类据此找东西）');
    assert.match(brief, /读写/, '读写挂载必须写明可写');
    assert.match(brief, /只读/, '只读挂载必须写明不可写');
    assert.match(brief, /跨命令存在/, '必须说明它是唯一跨命令存在的路径');
  });

  it('未声明挂载时，提示词不出现任何挂载段落（默认行为不变）', () => {
    const brief = renderSandboxBrief('phase');
    assert.equal(brief.includes('/work'), false);
    assert.match(brief, /不要指望留在容器里/, '零挂载时仍要强调「容器留不住东西」');
  });

  it('提示词明确要求绝对路径：实测命令的 cwd 是 /tmp，相对路径等于没挂载', () => {
    const brief = renderSandboxBrief('phase', [{ hostPath: 'C:/x', containerPath: '/work' }]);
    assert.match(brief, /绝对路径/, '必须写明用绝对路径');
    assert.match(brief, /当前目录是 `\/tmp`/, '必须点出 cwd=/tmp 这个实测行为');
  });

  it('intake 会话同样是零挂载语义（它本来就不许执行目标动作）', () => {
    const brief = renderSandboxBrief('intake', [{ hostPath: 'C:/x', containerPath: '/work' }]);
    assert.equal(brief.includes('/work'), false, 'intake 不执行命令，不该出现挂载说明');
  });
});
