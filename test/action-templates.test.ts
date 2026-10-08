/**
 * 结构化动作模板族（侦察 + 核验）的一致性回归锁（2026-10-06）。
 *
 * 这一族跨越**三个信任域**，每个都要有锁：
 *
 *   1. TypeScript 侧：模板注册表（参数/类别/端口来源/命令形态）；
 *   2. 工具侧：`technique` → 模板 id 与参数的翻译（模型只提供它知道的量）；
 *   3. 容器侧：`docker/tools/pentest-tool` 的动词与超时表——**源码扫描**断言
 *      （动词不存在 = 运行期 exit 2；超时表缺项 = `budget_ms` 直接 KeyError，
 *      那会以 internal_error 的形式出现在模型面前，最难查）。
 *
 * 另有两组**边界**断言：`pentest_recon` 只发给情报收集、`pentest_scan` 只发给漏洞分析；
 * 以及 `skill_load` 必须出现在每个阶段的默认工具面里（少了它，skill 正文一条都取不到）。
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

import {
  DEFAULT_DISABLED_CLASSES,
  PER_ACTION_APPROVAL_CLASSES,
  PHASES,
} from '../src/contracts.ts';
import { defaultRegistry, validateParams } from '../src/execution/templates.ts';
import { PROFILE_DEFAULTS } from '../src/policy/behavior-profile.ts';
import {
  STRUCTURED_TECHNIQUES,
  TARGET_TOOL_NAMES,
  WORKER_TOOL_NAMES,
  buildStructuredIntent,
} from '../src/tools/worker.ts';
import type { StructuredFamily } from '../src/tools/worker.ts';
import { DEFAULT_PHASE_TOOL_ALLOW } from '../src/workflow/model.ts';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DISPATCHER = readFileSync(path.join(HERE, '..', 'docker', 'tools', 'pentest-tool'), 'utf8');

/** 从分发器源码里取一段 `NAME = { ... }` 的键名（与容器实现同源，不手抄）。 */
function dispatcherKeys(constant: string): readonly string[] {
  const start = DISPATCHER.indexOf(`${constant} = {`);
  assert.ok(start > 0, `分发器里找不到 ${constant}`);
  const end = DISPATCHER.indexOf('\n}', start);
  assert.ok(end > start, `${constant} 的闭合括号没找到`);
  return [...DISPATCHER.slice(start, end).matchAll(/^\s{4}"([a-z_]+)":/gm)].map((m) => m[1] ?? '');
}

const registry = defaultRegistry();
/** 两族各自的模板清单 + 工具名（族 → 前缀；模板 id 与族前缀同一份来源）。 */
const FAMILIES: readonly { family: StructuredFamily; tool: string; phase: string }[] = [
  { family: 'recon', tool: 'pentest_recon', phase: 'intelligence-gathering' },
  { family: 'vuln', tool: 'pentest_scan', phase: 'vulnerability-analysis' },
];
const templatesOf = (family: StructuredFamily) =>
  registry.list().filter((spec) => spec.template.id.startsWith(`${family}_`));

/** 必填参数的样例值：只为「技术动作能被组装出来」这件事服务，不代表推荐取值。 */
const SAMPLE_REQUIRED_VALUES: Readonly<Record<string, string | number>> = Object.freeze({
  ports: '80,443',
  port: 443,
  paths: 'env,git',
});

describe('结构化动作模板族：注册表与类别', () => {
  it('两族模板都在注册表里（侦察 12 张 + 核验 4 张），且 id 唯一', () => {
    assert.equal(templatesOf('recon').length, 12);
    assert.equal(templatesOf('vuln').length, 4);
    const ids = registry.list().map((spec) => spec.template.id);
    assert.equal(new Set(ids).size, ids.length, '模板 id 不得重复');
  });

  it('类别只落在 passive_collection / active_probing：不触发逐次放行，也不是禁用类别', () => {
    for (const { family } of FAMILIES) {
      for (const spec of templatesOf(family)) {
        const actionClass = spec.template.actionClass;
        assert.ok(
          actionClass === 'passive_collection' || actionClass === 'active_probing',
          `${spec.template.id} 的类别是 ${actionClass}——结构化只读动作不得落在需要人批/禁用的类别上`,
        );
        assert.equal(
          (PER_ACTION_APPROVAL_CLASSES as readonly string[]).includes(actionClass),
          false,
          `${spec.template.id} 落在逐次放行下限里，会把人类审批预算拖死`,
        );
        assert.equal(
          (DEFAULT_DISABLED_CLASSES as readonly string[]).includes(actionClass),
          false,
          `${spec.template.id} 落在默认禁用类别里，等于不可用`,
        );
      }
    }
  });

  it('四档行为预设都启用这些类别（否则会落 beyondPreset → 转人工放行）', () => {
    for (const profile of ['stealth', 'standard', 'deep', 'custom'] as const) {
      for (const actionClass of ['passive_collection', 'active_probing'] as const) {
        assert.ok(PROFILE_DEFAULTS[profile].enabled.includes(actionClass), `${profile} 预设未启用 ${actionClass}`);
      }
    }
  });

  it('自由命令开关只给命令模板族两张（direct_command / local_command），结构化两族都没有偷开', () => {
    const freeForm = registry.list().filter((spec) => spec.allowFreeForm === true).map((spec) => spec.template.id);
    // 2026-10-08 加第二张：`local_command`（纯本地处理，容器无网）。它同样是"参数即任意命令文本"，
    // 因此**必须**开这个开关；规则本身不变——结构化两族一张都不许开。
    assert.deepEqual(freeForm, ['direct_command', 'local_command']);
  });
});

describe('结构化动作模板族：参数校验（模板声明的参数即必填）', () => {
  it('缺参数、多参数、枚举越界、端口表达式非法都被拒', () => {
    const cases: readonly [string, Readonly<Record<string, string | number>>][] = [
      ['recon_port_scan', { scope: 'top100', ping: 'skip' }], // 缺 ports
      ['recon_port_scan', { scope: 'top100', ports: 'none', ping: 'skip', depth: 2 }], // 多参数
      ['recon_port_scan', { scope: 'top10', ports: 'none', ping: 'skip' }], // 枚举越界
      ['recon_port_scan', { scope: 'top100', ports: '80; rm -rf /', ping: 'skip' }], // 端口表达式非法
      ['vuln_http_check', { port: 443, scheme: 'auto', check: 'sql_injection' }], // 不存在的核验项
      ['vuln_exposure_check', { port: 80, scheme: 'http', paths: 'env,passwd' }], // 暴露项越界
    ];
    for (const [id, params] of cases) {
      assert.equal(validateForTest(id, params).ok, false, `${id} 应拒绝参数 ${JSON.stringify(params)}`);
    }
  });

  it('显式取值表达「不指定」与「按默认」：ports=none、sni=none 合法', () => {
    assert.equal(validateForTest('recon_port_scan', { scope: 'top1000', ports: 'none', ping: 'connect' }).ok, true);
    assert.equal(validateForTest('recon_tls_inspect', { port: 443, sni: 'none', enumerate_protocols: 'on' }).ok, true);
    assert.equal(validateForTest('vuln_tls_weakness', { port: 443, sni: 'none', enumerate_protocols: 'on' }).ok, true);
    // 核验必须真的核验：工具层把 enumerate_protocols 收窄成 on（模板允许 off 但工具不放行）。
    const offEnumeration = buildStructuredIntent('vuln', {
      technique: 'tls_weakness',
      targetSelector: 't',
      purpose: 'p',
      enumerateProtocols: 'off',
    });
    assert.equal(offEnumeration.ok, false, '不允许一次「什么都没验证」的 TLS 核验');
  });

  it('DNS 类模板声明 udp 且无端口维度；核验族的端口来源都是声明参数', () => {
    for (const id of ['recon_dns_enum', 'recon_dns_brute']) {
      const found = registry.get(id);
      assert.ok(found !== undefined);
      assert.equal(found.protocol, 'udp', `${id} 的协议应是 udp`);
      assert.equal(found.portSource.kind, 'none', `${id} 没有端口维度`);
    }
    for (const spec of templatesOf('vuln')) {
      assert.equal(spec.portSource.kind, 'param', `${spec.template.id} 的端口应来自声明参数`);
      assert.equal(spec.protocol, 'tcp');
    }
  });
});

describe('technique → 模板 的翻译（两个工具共用同一份映射机制）', () => {
  for (const { family } of FAMILIES) {
    it(`${family}：每个 technique 可达、每张模板可达`, () => {
      const table = STRUCTURED_TECHNIQUES[family];
      const reachable = new Set<string>();
      for (const technique of Object.keys(table)) {
        const spec = table[technique];
        assert.ok(spec !== undefined);
        const sample: Record<string, string | number> = {};
        for (const name of spec.required) {
          const value = SAMPLE_REQUIRED_VALUES[name];
          assert.ok(value !== undefined, `${technique} 的必填参数 ${name} 没有样例值——补一个，别跳过`);
          sample[name] = value;
        }
        const planned = buildStructuredIntent(family, { technique, targetSelector: 't', purpose: 'p', ...sample });
        assert.equal(planned.ok, true, `${technique} 应可用：${planned.ok ? '' : planned.message}`);
        if (!planned.ok) continue;
        assert.equal(planned.templateId, `${family}_${technique}`);
        assert.ok(registry.get(planned.templateId) !== undefined, `${technique} 指向未注册的模板 ${planned.templateId}`);
        reachable.add(planned.templateId);
      }
      for (const registered of templatesOf(family).map((s) => s.template.id)) {
        assert.ok(reachable.has(registered), `模板 ${registered} 没有任何 technique 可达（等于死模板）`);
      }
    });
  }

  it('把「模型最容易犯的三种错」拒在工具层：未知 technique、多传参数、缺必填', () => {
    const unknown = buildStructuredIntent('recon', { technique: 'nmap_full_port', targetSelector: 't', purpose: 'p' });
    assert.equal(unknown.ok, false);
    assert.match(unknown.ok ? '' : unknown.nextAction, /port_scan/, '要列出可用 technique');

    const extra = buildStructuredIntent('recon', { technique: 'port_scan', targetSelector: 't', purpose: 'p', depth: 2 });
    assert.equal(extra.ok, false);
    assert.match(extra.ok ? '' : extra.message, /不接受参数 depth/);

    const missing = buildStructuredIntent('vuln', { technique: 'exposure_check', targetSelector: 't', purpose: 'p' });
    assert.equal(missing.ok, false);
    assert.match(missing.ok ? '' : missing.message, /paths/);

    // technique 专属取值域：content_discover 不接受 scheme=auto（猜协议会让整轮结果失真）。
    const autoScheme = buildStructuredIntent('recon', {
      technique: 'content_discover',
      targetSelector: 't',
      purpose: 'p',
      scheme: 'auto',
    });
    assert.equal(autoScheme.ok, false);
    assert.match(autoScheme.ok ? '' : autoScheme.nextAction, /http、https/);
  });

  it('参数写法的别名（camelCase → snake_case）真的被翻译，且不适用于该技术时被拒', () => {
    const wrong = buildStructuredIntent('recon', {
      technique: 'http_probe',
      targetSelector: 't',
      purpose: 'p',
      enumerateProtocols: 'off',
    });
    assert.equal(wrong.ok, false, 'http_probe 不接受 enumerateProtocols：必须拒，不能静默忽略');
    const ok = buildStructuredIntent('recon', {
      technique: 'http_probe',
      targetSelector: 't',
      purpose: 'p',
      collect: 'tech',
      followRedirects: 2,
    });
    assert.equal(ok.ok, true);
    if (ok.ok) {
      assert.equal(ok.params['follow_redirects'], 2);
      assert.equal(ok.params['collect'], 'tech');
      assert.equal(ok.params['scheme'], 'auto', '未提供的参数走安全默认值');
    }
    // 核验族的别名同样生效（enumerate_protocols 在两个族里同名）。
    const vuln = buildStructuredIntent('vuln', {
      technique: 'tls_weakness',
      targetSelector: 't',
      purpose: 'p',
      enumerateProtocols: 'on',
    });
    assert.equal(vuln.ok, true);
    if (vuln.ok) assert.equal(vuln.params['enumerate_protocols'], 'on');
  });
});

describe('容器侧一致性（源码扫描：分发器与模板不许漂移）', () => {
  it('每张结构化模板的工具名都在分发器的动词表里', () => {
    const verbs = new Set(dispatcherKeys('TOOLS'));
    assert.ok(verbs.size >= 20, `动词表只解析出 ${verbs.size} 个，扫描逻辑可能失效`);
    for (const { family } of FAMILIES) {
      for (const spec of templatesOf(family)) {
        assert.ok(
          verbs.has(spec.template.tool),
          `模板 ${spec.template.id} 的动词 ${spec.template.tool} 不在分发器 TOOLS 里——运行期会以 exit 2 失败`,
        );
      }
    }
  });

  it('每个动词都在 DEFAULT_TOOL_TIMEOUT_MS 里有条目（缺项会让 budget_ms KeyError）', () => {
    const timeouts = new Set(dispatcherKeys('DEFAULT_TOOL_TIMEOUT_MS'));
    for (const { family } of FAMILIES) {
      for (const spec of templatesOf(family)) {
        assert.ok(
          timeouts.has(spec.template.tool),
          `动词 ${spec.template.tool} 没有默认超时——budget_ms 会 KeyError，模型看到的是 internal_error`,
        );
      }
    }
  });
});

describe('能力边界：结构化工具只发给需要它的阶段；skill_load 每个阶段都要有', () => {
  for (const { tool, phase } of FAMILIES) {
    it(`${tool} 只出现在 ${phase} 的默认工具面里`, () => {
      const carriers = PHASES.filter((candidate) => DEFAULT_PHASE_TOOL_ALLOW[candidate].includes(tool));
      assert.deepEqual([...carriers], [phase]);
    });
  }

  it('两个结构化工具都在册且被标记为触及目标', () => {
    for (const { tool } of FAMILIES) {
      assert.ok((WORKER_TOOL_NAMES as readonly string[]).includes(tool));
      assert.ok(
        (TARGET_TOOL_NAMES as readonly string[]).includes(tool),
        `${tool} 触及目标，必须在 TARGET_TOOL_NAMES 里（登记与守卫据此区分宿主工具）`,
      );
    }
  });

  it('每个阶段的默认工具面都含 skill_load（否则 skill 正文一条都取不到）', () => {
    for (const phase of PHASES) {
      assert.ok(
        DEFAULT_PHASE_TOOL_ALLOW[phase].includes('skill_load'),
        `${phase} 缺少 skill_load：能力快照会列出 skill 名，而正文取不到`,
      );
    }
  });

  it('每个阶段都拿到一份非空工具面，且都含唯一的目标出口', () => {
    for (const phase of PHASES) {
      const allow = DEFAULT_PHASE_TOOL_ALLOW[phase];
      assert.ok(allow.length >= 9, `${phase} 的工具面过窄：${allow.join('、')}`);
      assert.ok(allow.includes('pentest_exec'), `${phase} 缺少目标出口 pentest_exec`);
      assert.equal(new Set(allow).size, allow.length, `${phase} 的工具面里有重复项`);
    }
  });
});

/**
 * 参数面对拍锁（2026-10-07 评审补）。
 *
 * `techniques.ts:23` 的文档原话是「测试断言两边不漂移」，但**此前没有任何测试这么做**：
 * `buildStructuredIntent` 只拿自己的 `defaults ∪ required` 校验（techniques.ts:173），
 * 从不调 `validateParams` ⇒ 模板加了参数而 techniques 忘了补时，全套测试仍绿，
 * 只在**受理时**以"缺参数"把模型打回（2026-10-07 就是这样漏掉了 `verify_tls` 的透传）。
 *
 * 这条锁钉住的不变量：每个 technique 的 `defaults ∪ required` **恰好等于**它对应模板声明的参数名集合。
 */
describe('结构化 technique 与模板的参数面必须逐字对拍', () => {
  for (const { family } of FAMILIES) {
    const table = STRUCTURED_TECHNIQUES[family];
    for (const [technique, spec] of Object.entries(table)) {
      it(`${family}_${technique}：technique 与模板参数面一致`, () => {
        const id = `${family}_${technique}`;
        const template = templatesOf(family).find((entry) => entry.template.id === id);
        assert.ok(template !== undefined, `technique ${technique} 没有对应模板 ${id}`);
        const fromTechnique = [...Object.keys(spec.defaults), ...spec.required].sort();
        const fromTemplate = template.template.parameters.map((p) => p.name).sort();
        assert.deepEqual(
          fromTechnique,
          fromTemplate,
          `${id} 参数面漂移：technique=[${fromTechnique.join('、')}] 模板=[${fromTemplate.join('、')}]。` +
            '模板多出参数 ⇒ 必须同步 techniques.defaults/enums，且 worker.ts 的 schema 与 intent 透传要跟上；' +
            'technique 多出参数 ⇒ 受理时会以"缺参数"被打回。',
        );
        // 枚举域也必须一致（technique.enums 是模板 kind:'enum' 的值集）。
        for (const param of template.template.parameters) {
          if (param.kind !== 'enum') continue;
          const domain = spec.enums?.[param.name];
          assert.deepEqual(
            domain === undefined ? undefined : [...domain].sort(),
            [...(param.values ?? [])].sort(),
            `${id}.${param.name} 的枚举域不一致`,
          );
        }
      });
    }
  }
});

/**
 * 用**运行期同一份**参数校验（`validateParams`）判定，不另写一份规则。
 * 校验入口与受理闸门（`admission.ts`）、策略判定（`pg-policy.ts`）是同一个函数。
 */
function validateForTest(id: string, params: Readonly<Record<string, string | number>>): { readonly ok: boolean } {
  const spec = registry.get(id);
  assert.ok(spec !== undefined, `模板 ${id} 未注册`);
  return validateParams(spec.template, { ...params }, { allowFreeForm: spec.allowFreeForm === true });
}
