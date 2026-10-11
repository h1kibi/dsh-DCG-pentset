/**
 * 「提示词里的事实必须同源于代码」的锁（沙箱工具规范 v1 §7）。
 *
 * 为什么值得一条永久测试：2026-10-11 质检 §三 3.1/3.2 的四条 P0，形状完全一样——
 * **渲染给模型的文本里有一份手写的第二副本**，而副本已经与代码相反：
 *
 *   - 阶段档案教的十个 `memory_search` `kinds` 里**九个不存在**（真实枚举是 `CHUNK_KINDS` 的 14 个）
 *     ⇒ 模型照档案发起的**第一次**强制检索必被拒（`classification_rejected`）；
 *   - `trust_level` 教的是 `confirmed/likely/speculative` 与 `high/medium/low` 两套虚构档位，
 *     而 `TrustLevel` 是**来源**语义（`human_decision/tool_observation/…`）；
 *   - 技能按 `maxWallClockMs`（沙箱天花板）估**自由命令**的规模，而后者真限 300s ⇒ 必被杀；
 *   - 速率档位写成不存在 `deep`（合法枚举是 `stealth/standard/fast/custom`）。
 *
 * 这些都不是"措辞"，是**模型照做就会失败的事实**。所以锁的方式是回源对拍：渲染产物里出现的
 * 数字/词表，必须能在注册表或契约里找到**同值**的那一份。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { renderPhaseProfile } from '../src/agents/phase-profiles.ts';
import { renderSandboxBrief } from '../src/agents/sandbox-brief.ts';
import { renderTechniqueParamsGuide } from '../src/agents/technique-params-guide.ts';
import { BEHAVIOR_PROFILES, FREE_COMMAND_TEMPLATE_ID, PHASES } from '../src/contracts.ts';
import { defaultRegistry } from '../src/execution/templates.ts';
import { STRUCTURED_TECHNIQUES } from '../src/execution/techniques.ts';
import { CHUNK_KINDS } from '../src/memory/chunks.ts';
import { PROFILE_DEFAULTS } from '../src/policy/behavior-profile.ts';

const REGISTRY = defaultRegistry();
const FAMILIES = ['recon', 'vuln'] as const;
const SKILLS_DIR = join(import.meta.dirname, '..', 'skills');

test('参数指南与 technique 注册表双向对齐：每个 technique 都有条目，也没有多出来的条目', () => {
  // 2026-10-11 质检 §三 3.4：`nse_safe`/`web_crawl`/`dns_brute`/`whois`/`ct_subdomains`/`dns_axfr`
  // 六个 technique **在参数指南里根本没有条目** ⇒ 模型只能从工具参数说明反推默认值。
  const guide = renderTechniqueParamsGuide({ recon: true, vuln: true });
  const offenders: string[] = [];
  for (const family of FAMILIES) {
    const tool = family === 'recon' ? 'pentest_recon' : 'pentest_scan';
    const techniques = Object.keys(STRUCTURED_TECHNIQUES[family]);
    for (const technique of techniques) {
      if (!guide.includes(`**${technique}**：`)) offenders.push(`${tool} 的 ${technique} 缺参数指南条目`);
    }
    const rendered = [...guide.matchAll(new RegExp(`示例：\`${tool}\\(`, 'g'))].length;
    if (rendered !== techniques.length) {
      offenders.push(`${tool}：指南渲染了 ${String(rendered)} 个条目，注册表有 ${String(techniques.length)} 个`);
    }
  }
  assert.deepEqual(offenders, [], '参数指南必须与注册表一一对应（少一个 = 模型靠猜；多一个 = 模型照调必被拒）');
});

test('提示词里的超时数字必须与模板注册表同值（规范 §7 的锁）', () => {
  const guide = renderTechniqueParamsGuide({ recon: true, vuln: true });
  const declared = new Set<number>();
  const offenders: string[] = [];
  for (const family of FAMILIES) {
    for (const technique of Object.keys(STRUCTURED_TECHNIQUES[family])) {
      const spec = REGISTRY.get(`${family}_${technique}`);
      assert.ok(spec !== undefined, `technique ${technique} 必须真有模板 ${family}_${technique}`);
      const seconds = Math.round(spec.template.timeoutMs / 1000);
      declared.add(seconds);
      if (!guide.includes(`墙钟上限：**${String(seconds)}s**`)) {
        offenders.push(`${family}_${technique}：指南没渲染注册表的 ${String(seconds)}s`);
      }
    }
  }
  // 反方向：指南里出现的每个超时数字都必须是注册表里某个模板的值（挡住手写的第二份）。
  const rendered = [...guide.matchAll(/墙钟上限：\*\*(\d+)s\*\*/g)].map((match) => Number(match[1]));
  for (const seconds of rendered) {
    if (!declared.has(seconds)) offenders.push(`指南里的 ${String(seconds)}s 不在任何模板的 timeoutMs 里`);
  }
  assert.deepEqual(offenders, [], '超时数字必须从注册表渲染：手写第二份必然漂移（实测：技能按 900s 估自由命令，真限 300s）');

  const brief = renderSandboxBrief('phase');
  const freeSpec = REGISTRY.get(FREE_COMMAND_TEMPLATE_ID);
  assert.ok(freeSpec !== undefined, `注册表里必须有自由命令模板 ${FREE_COMMAND_TEMPLATE_ID}`);
  const freeSeconds = Math.round(freeSpec.template.timeoutMs / 1000);
  assert.ok(
    brief.includes(`自由命令 \`pentest_exec\` ${String(freeSeconds / 60)} 分钟（${String(freeSeconds)}s）`),
    `简报里的自由命令上限必须等于模板 ${FREE_COMMAND_TEMPLATE_ID} 的 timeoutMs`,
  );
  // 旧形态的回归锁：这里曾写"端口扫描 5 分钟"（真值 900s）与独立手写的"自由命令 5 分钟"。
  assert.equal(brief.includes('端口扫描 5 分钟'), false, '简报不得再手写动作超时');
  assert.equal(brief.includes('自由命令 `pentest_exec` **5 分钟**'), false, '简报不得再手写自由命令超时');
});

test('简报里的速率与档位名必须与契约同值（规范 §7 的锁）', () => {
  const brief = renderSandboxBrief('phase');
  for (const profile of ['stealth', 'standard', 'fast'] as const) {
    const rate = PROFILE_DEFAULTS[profile].pacing.rate;
    assert.ok(brief.includes(`${profile} ${String(rate)} 请求/秒`), `简报缺 ${profile} ${String(rate)} 请求/秒`);
  }
});

test('技能与作者规范里不得出现不存在的速率档位名（`deep` 是历史词汇）', () => {
  // 2026-10-11 质检 §三 3.2 第 15 条：五份技能 + AUTHORING-SPEC 写 `deep 10/s`，而契约的
  // `BEHAVIOR_PROFILES` 是 `stealth/standard/fast/custom`。这条锁同时覆盖两类文件
  // （`test/skill-pack.test.ts` 的速率锁只扫 SKILL.md，且正则里没有 `deep`，所以它放过了这条漂移）。
  const files = readdirSync(SKILLS_DIR, { recursive: true })
    .map((entry) => join(SKILLS_DIR, String(entry)))
    .filter((full) => full.endsWith('SKILL.md') || full.endsWith('AUTHORING-SPEC.md') || full.endsWith('README.md'));
  assert.ok(files.length >= 20, `skills 目录扫到的文件太少：${String(files.length)}`);
  const offenders: string[] = [];
  for (const file of files) {
    readFileSync(file, 'utf8')
      .split('\n')
      .forEach((line, index) => {
        for (const match of line.matchAll(/([a-z]+)\s+\d+\s*\/\s*s/g)) {
          const name = match[1] ?? '';
          if (!(BEHAVIOR_PROFILES as readonly string[]).includes(name)) {
            offenders.push(`${file.slice(SKILLS_DIR.length + 1)}:${String(index + 1)} —— 档位名 ${name} 不存在`);
          }
        }
      });
  }
  assert.deepEqual(offenders, [], `合法档位只有 ${BEHAVIOR_PROFILES.join('/')}`);
});

test('阶段档案教的检索字段必须是真实枚举（`kinds`/`trust_levels`）', () => {
  for (const phase of PHASES) {
    const text = renderPhaseProfile(phase);
    // ① 合法取值必须出现在渲染产物里（规范 §6：拒信里的合法值经常拿不到，那就提前给）。
    for (const kind of CHUNK_KINDS) {
      assert.ok(text.includes(`\`${kind}\``), `${phase} 档案没列出合法 kind \`${kind}\``);
    }
    for (const level of ['human_decision', 'tool_observation', 'agent_claim', 'model_reasoning', 'external_untrusted']) {
      assert.ok(text.includes(`\`${level}\``), `${phase} 档案没列出合法 trust_level \`${level}\``);
    }
    // ② 那十个"业务分类"不得再出现：它们里九个在代码里不存在（第一次强制检索必被拒）。
    const ghosts = text.match(
      /`(service_fingerprint|dns_record|web_surface|attack_path|trust_boundary|verification_plan|exploit_proof|compromised_asset|impact_scope|excluded_candidate|cleanup_item|internal_asset|impact_boundary|asset)`/,
    );
    assert.equal(ghosts, null, `${phase} 档案还在教不存在的分类 ${String(ghosts?.[1])}`);
    // ③ 两套虚构的可信度/严重度档位也不得复现。
    const trustGhosts = text.match(/`(confirmed|likely|speculative|high|medium|low)`/);
    assert.equal(trustGhosts, null, `${phase} 档案还在教不存在的 trust_level ${String(trustGhosts?.[1])}`);
    // ④ "要已确认就过滤 human_decision + tool_observation" 这句口径必须给出。
    assert.match(text, /已确认.*`human_decision`.*`tool_observation`/s, `${phase} 档案缺"已确认"的过滤口径`);
  }
});

test('零命中的两种语义在每个阶段都能分辨（索引为空 → workdir；有内容没命中 → 换查询词）', () => {
  for (const phase of PHASES) {
    const text = renderPhaseProfile(phase);
    assert.ok(text.includes('索引为空'), `${phase} 档案缺"索引为空"这一路的处置`);
    assert.ok(text.includes('没有命中'), `${phase} 档案缺"没有命中"这一路的处置`);
    assert.ok(text.includes('pentest_workdir'), `${phase} 档案缺 workdir 回退通道`);
  }
});

test('阶段档案不得教 `memory_search` 做跨作业检索（参数面没有 engagement_id）', () => {
  // 2026-10-11 质检 §三 3.1 第 13 条：`exploitation` 的 usageGuidance 曾写"可跨 engagement 检索
  // （去掉 engagement_id）"——参数里根本没有 engagement_id，服务端按会话绑定本作业（§9.4）。
  for (const phase of PHASES) {
    const text = renderPhaseProfile(phase);
    assert.equal(
      /去掉\s*engagement_id/.test(text),
      false,
      `${phase} 档案还在教"去掉 engagement_id 跨作业检索"（做不到，且与 §9.4 隔离相反）`,
    );
  }
});
