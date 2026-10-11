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
  FREE_COMMAND_TEMPLATE_ID,
  PHASE_COMMAND_ACTION_CLASS,
  effectiveActionClass,
} from '../src/contracts.ts';
import { defaultRegistry, validateParams } from '../src/execution/templates.ts';
import { PROFILE_DEFAULTS } from '../src/policy/behavior-profile.ts';
import { SCAN_PRESETS } from '../src/execution/port-expr.ts';
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
/**
 * 两族各自的模板清单 + 工具名 + **默认承载它的阶段**。
 *
 * `pentest_scan` 自 2026-10-10（操作者裁定）起**同时发给情报收集与漏洞分析**：
 * 情报阶段做配置暴露核查时，手搓 curl 会把正文写进证据，而 `exposure_check` / `http_check`
 * 这类只读核验动词只报存在性/长度/哈希/形态、从不回显内容——同一件事，结构化通道姿态更严。
 * 两个阶段拿它做的事不同（情报：记录事实；漏洞分析：判定候选），因此这条边界是**承载面**
 * 的边界，不是"只能一个阶段用"的边界。
 */
const FAMILIES: readonly { family: StructuredFamily; tool: string; phases: readonly string[] }[] = [
  { family: 'recon', tool: 'pentest_recon', phases: ['intelligence-gathering'] },
  { family: 'vuln', tool: 'pentest_scan', phases: ['intelligence-gathering', 'vulnerability-analysis'] },
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
    for (const profile of ['stealth', 'standard', 'fast', 'custom'] as const) {
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
      // 注意：除"缺 ports"那条外都带全 `restrict_to_scope`，否则第一条错误会变成
      // "缺少参数 restrict_to_scope"，把"多参数/枚举越界/表达式非法"这三条测名的意义漂掉。
      ['recon_port_scan', { scope: 'top100', ping: 'skip' }], // 缺 ports（也缺 restrict_to_scope）
      ['recon_port_scan', { scope: 'top100', ports: 'none', ping: 'skip', restrict_to_scope: 'false', depth: 2 }], // 多参数
      ['recon_port_scan', { scope: 'top10', ports: 'none', ping: 'skip', restrict_to_scope: 'false' }], // 枚举越界
      ['recon_port_scan', { scope: 'top100', ports: '80; rm -rf /', ping: 'skip', restrict_to_scope: 'false' }], // 端口表达式非法
      ['vuln_http_check', { port: 443, scheme: 'auto', check: 'sql_injection' }], // 不存在的核验项
      ['vuln_exposure_check', { port: 80, scheme: 'http', paths: 'env,passwd' }], // 暴露项越界
    ];
    for (const [id, params] of cases) {
      assert.equal(validateForTest(id, params).ok, false, `${id} 应拒绝参数 ${JSON.stringify(params)}`);
    }
  });

  it('显式取值表达「不指定」与「按默认」：ports=none、sni=none 合法', () => {
    assert.equal(
      validateForTest('recon_port_scan', { scope: 'top1000', ports: 'none', ping: 'connect', restrict_to_scope: 'false' }).ok,
      true,
    );
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
  for (const { tool, phases } of FAMILIES) {
    it(`${tool} 只出现在 ${phases.join(' / ')} 的默认工具面里`, () => {
      const carriers = PHASES.filter((candidate) => DEFAULT_PHASE_TOOL_ALLOW[candidate].includes(tool));
      assert.deepEqual([...carriers], [...phases], '承载阶段与裁定不一致（多一个或少一个都会让提示词与工具面对不上）');
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

// ─────────────────── 阶段提升类别（自由命令通道，2026-10-09 裁定） ───────────────────

/**
 * 「④⑤ 逐条放行」这条闸门由**两处**共同决定：契约里的提升规则（`effectiveActionClass`）
 * 与受理闸门（`classificationGate` 用会话阶段算有效类别）。这里锁规则本身的三条性质：
 *
 *   1. **只作用于自由命令通道那一张模板**——注册表里其它模板的有效类别恒等于声明类别。
 *      少了这条，将来新增一张自由表单模板（或改 id）会让规则悄悄漏到别的动作上，或**失效**
 *      （改 id 后提升不再匹配 ⇒ 命令退回免批，而界面上看不出少了闸门）。
 *   2. **只提升不降低**：提升后的类别必须都在逐次放行集合里——否则「提升」只是换了个名字，
 *      人还是不会被叫来。
 *   3. **阶段读不回来按最严处理**（`null` ⇒ `lateral_movement`）。
 */
describe('阶段提升类别：只作用自由命令通道，只提升不降低', () => {
  it('自由命令：①②③ 保持基类，④ 升为 exploit_validation，⑤ 升为 lateral_movement', () => {
    const spec = registry.get(FREE_COMMAND_TEMPLATE_ID);
    assert.ok(spec !== undefined, `注册表里必须有 ${FREE_COMMAND_TEMPLATE_ID}`);
    const declared = spec.template.actionClass;
    assert.equal(declared, 'active_probing', '基类必须是预设内的 active_probing——①②③ 的免批靠它');

    for (const phase of ['intelligence-gathering', 'threat-modeling', 'vulnerability-analysis'] as const) {
      assert.equal(effectiveActionClass(FREE_COMMAND_TEMPLATE_ID, declared, phase), declared);
    }
    assert.equal(effectiveActionClass(FREE_COMMAND_TEMPLATE_ID, declared, 'exploitation'), 'exploit_validation');
    assert.equal(effectiveActionClass(FREE_COMMAND_TEMPLATE_ID, declared, 'post-exploitation'), 'lateral_movement');
  });

  it('阶段读不回来（null）按最严处理：自由命令视为 ⑤ 的 lateral_movement', () => {
    assert.equal(effectiveActionClass(FREE_COMMAND_TEMPLATE_ID, 'active_probing', null), 'lateral_movement');
  });

  it('除自由命令通道外，任何注册模板的有效类别恒等于声明类别', () => {
    for (const spec of registry.list()) {
      if (spec.template.id === FREE_COMMAND_TEMPLATE_ID) continue;
      for (const phase of PHASES) {
        assert.equal(
          effectiveActionClass(spec.template.id, spec.template.actionClass, phase),
          spec.template.actionClass,
          `${spec.template.id} 不应被阶段提升规则影响`,
        );
      }
      assert.equal(
        effectiveActionClass(spec.template.id, spec.template.actionClass, null),
        spec.template.actionClass,
        `${spec.template.id} 在阶段读不回来时也不应被提升`,
      );
    }
  });

  it('提升后的类别都在逐次放行集合里（提升必须真换来一次人批）', () => {
    const entries = Object.entries(PHASE_COMMAND_ACTION_CLASS);
    assert.ok(entries.length > 0, '提升表不能是空的——空了就等于把闸门撤了');
    for (const [phase, actionClass] of entries) {
      assert.ok(
        (PER_ACTION_APPROVAL_CLASSES as readonly string[]).includes(actionClass),
        `${phase} 提升到 ${String(actionClass)}，但它不在 PER_ACTION_APPROVAL_CLASSES 里`,
      );
    }
  });
});

/**
 * 扫描档位与容器分发器的**逐字对拍**（2026-10-10）。
 *
 * 宿主侧的范围闸门必须知道「这次动作将要触及哪些端口」才能核验授权
 * （`SCAN_PRESETS`）。它与容器实际执行的 `NMAP_SCOPE_ARGS` 是同一份知识的两个消费者：
 * 漂移的后果是双向的——闸门放行容器却扫了别处（越权），或闸门拒绝容器本可精确执行的扫描
 * （能力为空，2026-10-10 实测 P0 就是后者的一种）。
 *
 * 因此这里**解析分发器源码**取真实清单，不手抄；`top100`/`top1000` 在 nmap 内部决定，
 * 宿主侧如实标为不可枚举（`null`），此测试同时钉住这一点。
 */
describe('扫描档位：宿主闸门与容器分发器逐字对拍', () => {
  /**
   * 从分发器的 `NMAP_SCOPE_ARGS` 取档位名。
   *
   * 不复用 `dispatcherKeys`：它的键名正则只接受 `[a-z_]`，而这里的档位名含数字（`top100`）。
   * 直接对这一段用更宽的正则，避免为一个用途改宽公共助手。
   */
  const scopeArgsBlock = (() => {
    const start = DISPATCHER.indexOf('NMAP_SCOPE_ARGS = {');
    assert.ok(start > 0, '分发器里找不到 NMAP_SCOPE_ARGS');
    const end = DISPATCHER.indexOf('\n}', start);
    assert.ok(end > start, 'NMAP_SCOPE_ARGS 的闭合括号没找到');
    return DISPATCHER.slice(start, end);
  })();
  const presetNames = [...scopeArgsBlock.matchAll(/^\s{4}"([a-z0-9_]+)":/gm)].map((m) => m[1] ?? '');

  it('档位名集合两处一致', () => {
    assert.deepEqual([...Object.keys(SCAN_PRESETS)].sort(), [...presetNames].sort());
  });

  it('common_services 的端口清单逐字一致（顺序也一致：两侧都是人类可读的清单）', () => {
    // 源码里这串清单被**跨行拼接**（相邻字符串字面量），必须把所有纯数字/逗号字面量按序接起来。
    const commonPart = scopeArgsBlock.slice(
      scopeArgsBlock.indexOf('"common_services"'),
      scopeArgsBlock.indexOf('"full_tcp"'),
    );
    const pieces = [...commonPart.matchAll(/"([\d,]+)"/g)].map((m) => m[1] ?? '');
    assert.ok(pieces.length > 0, '分发器里找不到 common_services 的端口清单');
    const fromDispatcher = pieces.join('').split(',').map((n) => Number(n));
    const fromHost = (SCAN_PRESETS.common_services ?? []).map((r) => r.from);
    // 宿主侧每条都是单端口区间（起止相同），逐位对拍。
    assert.ok((SCAN_PRESETS.common_services ?? []).every((r) => r.from === r.to), 'common_services 在宿主侧是逐端口清单');
    assert.deepEqual(fromHost, fromDispatcher);
  });

  it('full_tcp 的范围一致；top100/top1000 在宿主侧如实标为不可枚举', () => {
    assert.deepEqual(SCAN_PRESETS.full_tcp, [{ from: 1, to: 65535 }]);
    assert.equal(SCAN_PRESETS.top100, null);
    assert.equal(SCAN_PRESETS.top1000, null);
  });

  it('两个多端口模板声明了 ports-param（不能退回 none——那会让闸门回落默认 web 端口）', () => {
    for (const id of ['recon_port_scan', 'recon_service_probe']) {
      const spec = registry.get(id);
      assert.ok(spec !== undefined, `模板 ${id} 未注册`);
      assert.equal(spec.portSource.kind, 'ports-param', `${id} 的 portSource 必须是 ports-param`);
    }
  });
});

/**
 * 字典档位与容器分发器的**逐字对拍**（2026-10-10）。
 *
 * 操作者实测：镜像里装了 `api-endpoints.txt` / `quickhits.txt`（Dockerfile 早就 fetch 了），
 * 但 `WORDLIST_FILES` 与参数面都只有三档，`wordlist=api_endpoints` 被参数校验直接拒——
 * 落差卡住整个 API 面枚举。以下锁钉住"宿主枚举 == 容器允许表"，并钉住 path 前缀的存在。
 */
describe('字典档位：宿主参数面与容器分发器逐字对拍', () => {
  /** 解析分发器的 `WORDLIST_ALLOWED`：`"verb": ("a", "b"),`。 */
  function dispatcherWordlists(verb: string): readonly string[] {
    const start = DISPATCHER.indexOf('WORDLIST_ALLOWED = {');
    assert.ok(start > 0, '分发器里找不到 WORDLIST_ALLOWED');
    const end = DISPATCHER.indexOf('\n}', start);
    assert.ok(end > start, 'WORDLIST_ALLOWED 的闭合括号没找到');
    const block = DISPATCHER.slice(start, end);
    const line = block.match(new RegExp(`"${verb}":\\s*\\(([^)]*)\\)`));
    assert.ok(line !== null, `分发器 WORDLIST_ALLOWED 里没有 ${verb}`);
    return [...(line[1] ?? '').matchAll(/"([a-z0-9_]+)"/g)].map((m) => m[1] ?? '');
  }

  it('content_discover：technique 枚举、模板枚举与容器允许表三处一致', () => {
    const fromDispatcher = dispatcherWordlists('content_discover');
    const fromTechnique = STRUCTURED_TECHNIQUES.recon.content_discover?.enums?.wordlist ?? [];
    assert.deepEqual([...fromTechnique].sort(), [...fromDispatcher].sort(), 'techniques.ts 与分发器漂移');
    const spec = registry.get('recon_content_discover');
    assert.ok(spec !== undefined);
    const declared = spec.template.parameters.find((p) => p.name === 'wordlist');
    assert.ok(declared !== undefined && declared.kind === 'enum');
    assert.deepEqual([...(declared.values ?? [])].sort(), [...fromDispatcher].sort(), '模板与分发器漂移');
  });

  it('dns_brute：模板枚举与容器允许表一致（DNS 字典不得混进目录枚举的动作）', () => {
    const fromDispatcher = dispatcherWordlists('dns_brute');
    const spec = registry.get('recon_dns_brute');
    assert.ok(spec !== undefined);
    const declared = spec.template.parameters.find((p) => p.name === 'wordlist');
    assert.ok(declared !== undefined && declared.kind === 'enum');
    assert.deepEqual([...(declared.values ?? [])].sort(), [...fromDispatcher].sort());
    assert.ok(!fromDispatcher.includes('api_endpoints'), 'api_endpoints 是 Web 内容字典，不应出现在 dns_brute');
  });

  it('content_discover 的 path 前缀在宿主模板与容器实现两侧都存在', () => {
    const spec = registry.get('recon_content_discover');
    assert.ok(spec !== undefined);
    assert.ok(
      spec.template.parameters.some((p) => p.name === 'path'),
      '模板未声明 path：API 面只能扫根路径（2026-10-10 实测缺口）',
    );
    assert.match(spec.commandTemplate, /path=\{path\}/, 'path 必须进入命令模板（声明即必须进入命令）');
    const verbStart = DISPATCHER.indexOf('def content_discover(');
    assert.ok(verbStart > 0);
    const verbBody = DISPATCHER.slice(verbStart, DISPATCHER.indexOf('\ndef ', verbStart + 1));
    // 规范 §1：参数读取统一走 `param_*` 助手（2026-10-11）；这条锁认助手名，不认 `params.get`。
    assert.match(verbBody, /param_optional\(params, "path"/, '容器侧未读取 path 参数（应经 param_optional）');
  });

  it("http_probe 的 collect 枚举：模板 / technique / 容器三处一致（endpoints 是 2026-10-10 补的）", () => {
    // 手写 grep 抽路由的失败是**静默**的（倒置区间报 Invalid range end，而 `| head` 把 rc 掩成 0，
    // 空 stdout 看起来就是"页面里没有路径"）⇒ 给一条服务端固定形态的通道。三处枚举必须同源。
    const start = DISPATCHER.indexOf('def http_probe(');
    const verbBody = DISPATCHER.slice(start, DISPATCHER.indexOf('\ndef ', start + 1));
    const m = /param_enum\(params, "collect", \(([^)]*)\)\)/.exec(verbBody);
    assert.ok(m !== null, '容器侧找不到 collect 的 param_enum（规范 §1 的统一助手）');
    const fromContainer = [...(m[1] ?? '').matchAll(/"([a-z_]+)"/g)].map((x) => x[1] ?? '');
    assert.ok(fromContainer.includes('endpoints'), '容器侧必须有 endpoints 抽取');
    const spec = registry.get('recon_http_probe');
    assert.ok(spec !== undefined);
    const declared = spec.template.parameters.find((p) => p.name === 'collect');
    assert.ok(declared !== undefined && declared.kind === 'enum');
    assert.deepEqual([...(declared.values ?? [])].sort(), [...fromContainer].sort(), '模板与容器漂移');
    const fromTechnique = STRUCTURED_TECHNIQUES.recon.http_probe?.enums?.collect ?? [];
    assert.deepEqual([...fromTechnique].sort(), [...fromContainer].sort(), 'techniques.ts 与容器漂移');
    // 抽取器只认这三种固定形态（服务端拥有形态，模型给不了自由正则）。
    // 模式表在**模块级**（`ENDPOINT_PATTERNS`），不在动词体内——作用域别写窄。
    for (const kind of ['attr', 'quoted', 'call']) {
      assert.ok(DISPATCHER.includes(`("${kind}",`), `抽取器缺 ${kind} 形态`);
    }
    assert.match(verbBody, /这不等于「页面里没有端点」/, '空结果必须自我解释（否则又是静默阴性）');
  });

  it('exposure_check 的形态判据：签名与正文同为 bytes，比对**不得解码**（2026-10-10 实测崩过）', () => {
    // 实况：`signature.lower() in body.decode(...)` ⇒ `bytes in str` ⇒ TypeError，
    // 而且只在"真的命中候选"时触发（更早的冒烟全落在"与对照同形"分支）⇒ 一路漏到实测。
    const sigStart = DISPATCHER.indexOf('EXPOSURE_SIGNATURES = {');
    assert.ok(sigStart > 0, '分发器里找不到 EXPOSURE_SIGNATURES');
    const sigBlock = DISPATCHER.slice(sigStart, DISPATCHER.indexOf('\n}', sigStart));
    // 两种引号都要认：正文含引号的签名写成 `b'"swagger"'`（单引号包 bytes、内部是双引号）。
    const entries = [...sigBlock.matchAll(/"([a-z_]+)":\s*(b?['"])/g)].map((m) => ({
      key: m[1] ?? '',
      prefix: m[2] ?? '',
    }));
    assert.ok(entries.length >= 9, `签名条目太少：${String(entries.length)}`);
    const notBytes = entries.filter((e) => e.prefix !== 'b"' && e.prefix !== "b'").map((e) => e.key);
    assert.deepEqual(notBytes, [], '签名必须是 bytes 字面量（与 resp.read() 的 bytes 一致；str 会在比对处 TypeError）');

    const fnStart = DISPATCHER.indexOf('def classify_exposure(');
    assert.ok(fnStart > 0, '分发器里找不到 classify_exposure');
    const fnBody = DISPATCHER.slice(fnStart, DISPATCHER.indexOf('\ndef ', fnStart + 1));
    // **只看代码行**：注释里会引用旧写法（"曾经写成 …decode(…)"），那不是实现。
    const cmpLine = fnBody
      .split('\n')
      .filter((line) => !line.trimStart().startsWith('#'))
      .find((line) => line.includes('signature.lower()'));
    assert.ok(cmpLine !== undefined, 'classify_exposure 里找不到签名比对那一行');
    assert.ok(
      !cmpLine.includes('.decode('),
      '签名比对不得解码：签名与正文同为 bytes，混用 str 会 TypeError（这条崩只在命中候选时出现）',
    );
    assert.match(cmpLine, /body\.lower\(\)/, '应按 bytes 比对（body.lower()）');
  });

  it('port_scan 的 restrict_to_scope：宿主声明 / 容器读取 / 交集取自镜像 nmap-services（2026-10-10）', () => {
    const spec = registry.get('recon_port_scan');
    assert.ok(spec !== undefined);
    const declared = spec.template.parameters.find((p) => p.name === 'restrict_to_scope');
    assert.ok(declared !== undefined && declared.kind === 'enum', '模板必须声明 restrict_to_scope（枚举）');
    assert.match(spec.commandTemplate, /restrict_to_scope=\{restrict_to_scope\}/, '新参数必须进入命令形态');
    assert.ok('restrict_to_scope' in spec.carries, '新参数必须有 carries（否则注册期就报错）');
    assert.equal(
      STRUCTURED_TECHNIQUES.recon.port_scan?.defaults.restrict_to_scope,
      'false',
      'technique 默认必须是 false：默认行为不变（显式 ports 仍整个取代档位）',
    );
    // 容器侧：读到该参数、且交集取自 nmap 自己的频率表（不许手抄清单）。
    const verbStart = DISPATCHER.indexOf('def port_scan(');
    const verbBody = DISPATCHER.slice(verbStart, DISPATCHER.indexOf('\ndef ', verbStart + 1));
    assert.match(verbBody, /restrict_to_scope/, '容器侧未读取 restrict_to_scope');
    assert.match(verbBody, /top_ports\(/, '容器侧必须自己算 top-N（不是让模型列端口）');
    assert.match(DISPATCHER, /NMAP_SERVICES_FILE = "\/usr\/share\/nmap\/nmap-services"/, 'top-N 的来源必须是镜像自带的 nmap-services');
    assert.match(verbBody, /used_ports:/, '交集结果必须回报（可复核）');
  });

  it('nmap 动词的零命中必须可分辨：hosts_up/ports_scanned 进 summary，全 down 时给 warn（2026-10-10）', () => {
    // 实况：`host: … state=down` + `summary: open_ports=0` 与"扫了 33 个端口全关"**同形**，
    // 操作者差点把漏报写进报告的"未开放"。修法是把两种情形在输出里分开喊出来。
    const body = DISPATCHER.slice(DISPATCHER.indexOf('def nmap_ports('), DISPATCHER.indexOf('\ndef port_scan('));
    assert.match(body, /ports_scanned=/, 'summary 必须带"扫了几个端口"（nmap 自报的 scaninfo 计数）');
    assert.match(body, /hosts_up=/, 'summary 必须带主机判定计数');
    assert.match(body, /if hosts_up == 0:/, '全 down 时必须走显式告警分支（否则就是静默漏报）');
    assert.match(body, /ping=skip/, '告警要给出可执行的下一步（换 -Pn 重扫）');
    assert.match(body, /land_bytes\(|report_evidence\(/, 'nmap 动词必须落原始件并回报路径');
    assert.match(DISPATCHER, /EVIDENCE_ROOT = "\/work"/, '原始件的根必须是挂载根 /work');
    assert.match(DISPATCHER, /def compress_ports\(/, '交集要能压成紧凑端口表达式（可复核）');
  });

  it('http_probe 的 include_chunks：三处一致，且 chunk 跟随是**同主机 + 有界**的（2026-10-11 实测：路由只在 chunk 里）', () => {
    const spec = registry.get('recon_http_probe');
    assert.ok(spec !== undefined);
    const declared = spec.template.parameters.find((p) => p.name === 'include_chunks');
    assert.ok(declared !== undefined && declared.kind === 'enum', '模板必须声明 include_chunks');
    assert.match(spec.commandTemplate, /include_chunks=\{include_chunks\}/, '新参数必须进入命令形态');
    assert.ok('include_chunks' in spec.carries, '新参数必须有 carries');
    assert.equal(
      STRUCTURED_TECHNIQUES.recon.http_probe?.defaults.include_chunks,
      'true',
      '默认必须是 true：SPA 的路由常常只在 chunk 里，默认关掉等于把发现路径藏起来',
    );
    assert.equal(STRUCTURED_TECHNIQUES.recon.http_probe?.enums?.include_chunks?.length, 2);
    // 容器侧：读到该参数；只跟同主机；条数/字节有硬上限；命中带来源。
    const start = DISPATCHER.indexOf('def http_probe(');
    const verbBody = DISPATCHER.slice(start, DISPATCHER.indexOf('\ndef ', start + 1));
    assert.match(verbBody, /include_chunks/, '容器侧未读取 include_chunks');
    assert.match(verbBody, /same_host_chunk_paths\(/, '必须用同主机过滤（跨主机要重新裁决）');
    assert.match(verbBody, /fetch_chunks\(/, '必须走有界的 chunk 抓取');
    assert.match(verbBody, /kind=\{kind\}@|@\{chunk_path\}|f"\{kind\}@/, 'chunk 命中必须标出来源（可复核）');
    const helper = DISPATCHER.slice(DISPATCHER.indexOf('def same_host_chunk_paths('), DISPATCHER.indexOf('def fetch_chunks('));
    assert.match(helper, /!=\s*host/, '跨主机的引用必须被跳过');
    assert.match(DISPATCHER, /CHUNK_FETCH_LIMIT = \d+/, 'chunk 条数必须有常量上限');
    assert.match(DISPATCHER, /CHUNK_BYTES_LIMIT = \d+/, 'chunk 字节必须有常量上限');
  });

  it('端口状态的可信度：近全开（≥80%）必须给可判定的告警与字段（2026-10-11 外部反馈 D6/§2.3）', () => {
    // 现场（目标 10.25.27.206）：top-1000 回 1000/1000、1-200 段回 200/200，而带载荷只证实 4 个服务。
    // 这类目标上"开放端口数"是伪信号；人不会自己去怀疑比例 ⇒ 工具必须给机器可判的字段 + 处置。
    const body = DISPATCHER.slice(DISPATCHER.indexOf('def nmap_ports('), DISPATCHER.indexOf('\ndef port_scan('));
    assert.match(body, /port_state_trust/, 'summary 必须带 port_state_trust 字段（ok/suspect/unknown）');
    assert.match(body, /ratio = open_ports \/ ports_scanned/, '比例口径必须写死在容器里（不靠人算）');
    assert.match(body, /ratio >= 0\.8/, '阈值 0.8 必须显式（近全开）');
    assert.match(body, /port_state_trust = "suspect" if ratio >= 0\.8 else "ok"/, '判定必须可机器复核');
    assert.match(body, /端口状态可能是伪信号/, '可疑时必须显式告警');
    assert.match(body, /以「有协议级应答」为真实服务面的判据/, '告警要给出可执行的处置（换判据）');
    assert.match(body, /recon-network-surface 的第 3b 步/, '告警要指向技能里的具体步骤');
    // D6 的另一半：`open` 但**拿不到版本信息**的端口（`unknown`/`tcpwrapped`）不许当已知服务。
    assert.match(body, /open_without_version/, 'summary 必须带 open_without_version（可判字段）');
    assert.match(body, /version_info=none/, '逐端口行要显式标"没有版本信息"，别让人从缺列里读结论');
    assert.match(body, /拿不到任何版本信息/, '有这类端口时必须显式告警');
  });

  it('零命中的判别字段：summary 里 `scanned=` 必须把「没扫」与「扫了全关」分开（2026-10-11）', () => {
    const body = DISPATCHER.slice(DISPATCHER.indexOf('def nmap_ports('), DISPATCHER.indexOf('\ndef port_scan('));
    assert.match(body, /scanned=\{scanned\}|scanned=\{/, '正常收尾必须带 scanned=');
    const verb = DISPATCHER.slice(DISPATCHER.indexOf('def port_scan('), DISPATCHER.indexOf('\ndef service_probe('));
    assert.match(verb, /open_ports=not_scanned/, '空交集的 open_ports 不能写成数字 0（与"扫了全关"同形）');
    assert.match(verb, /scanned=false/, '空交集必须显式 scanned=false');
  });

  it('content_discover 的 summary 必须给出覆盖依据（entries/duration/错误迹象）（2026-10-11）', () => {
    // 旧 summary 只有 `hits=N autocalibration=…`：跑完了干净 vs 跑一半报一堆错**同形**。
    const start = DISPATCHER.indexOf('def content_discover(');
    const body = DISPATCHER.slice(start, DISPATCHER.indexOf('\ndef web_crawl(', start));
    // 规范 §7 的固定后缀：`entries_attempted=`（旧别名 `entries_scanned=` 已于第八轮镜像删掉）。
    for (const field of ['entries_attempted=', 'duration_ms=', 'stderr_lines=', 'stderr_errorish=']) {
      assert.ok(body.includes(field), `summary 缺 ${field}`);
    }
    assert.match(body, /warn: ffuf 的 stderr 里有/, '有错误迹象时必须显式 warn（别让人从干净数字里读结论）');
  });

  it('exposure_check 的字段名不再误导：hashed_bytes 与 content_length 是两件事（2026-10-11）', () => {
    const start = DISPATCHER.indexOf('def exposure_check(');
    const body = DISPATCHER.slice(start, DISPATCHER.indexOf('\ndef ', start + 1));
    assert.ok(body.includes('hashed_bytes='), '读入字节数应叫 hashed_bytes');
    assert.ok(body.includes('content_length='), '目标自报长度应叫 content_length');
    assert.ok(!body.includes('declared_length='), '旧的 declared_length 名字会与 bytes 并排误读，必须消失');
  });

  it('每个结构化动词的超时：容器默认表与宿主模板一致（port_scan 曾是 300s vs 900s）', () => {
    // 容器侧是**天花板**（budget_ms 取 min(注入值, 本表)）：比宿主模板小 ⇒
    // 宿主按模板规划、容器提前砍，批次扫描在离完成很远的地方被截断而不自知。
    const start = DISPATCHER.indexOf('DEFAULT_TOOL_TIMEOUT_MS = {');
    assert.ok(start > 0, '分发器里找不到 DEFAULT_TOOL_TIMEOUT_MS');
    const end = DISPATCHER.indexOf('\n}', start);
    const block = DISPATCHER.slice(start, end);
    const container = new Map<string, number>();
    for (const m of block.matchAll(/"([a-z_]+)":\s*([0-9_]+)/g)) {
      container.set(m[1] ?? '', Number((m[2] ?? '').replace(/_/g, '')));
    }
    const mismatches: string[] = [];
    for (const spec of registry.list()) {
      const tool = spec.template.tool;
      const fromContainer = container.get(tool);
      if (fromContainer === undefined) continue;
      if (fromContainer !== spec.template.timeoutMs) {
        mismatches.push(`${tool}: 容器 ${fromContainer}ms vs 模板 ${spec.template.timeoutMs}ms`);
      }
    }
    assert.deepEqual(mismatches, []);
  });
});

/**
 * 2026-10-11 两条结构化能力（操作者诉求 #3/#4）的**三处一致性锁**。
 *
 *   A. `http_probe paths=` —— 批量路径状态复核。此前只能退回手写 `pentest_exec` 的
 *      `for p in …; do curl …; done` 逐条确认「这 60 条路径是真实端点还是兜底路由」：
 *      输出进不了审计通道，也没法逐条核账。
 *   B. `content_discover entry_range=` —— 字典分段 + 覆盖度自报。`common_dirs` ≈ 4723 条
 *      按声明节奏 5 req/s 需 ~945s，而单条命令上限 295s ⇒ **数学上不可调度**；且旧摘要里
 *      **看不见被截断**（上游 JSON 有 `maxtime:295`、命中停在 `position:4313`）。
 *
 * 两处都跨三个信任域（模板注册表 / technique 表 / 容器分发器），与既有那一组同一纪律：
 * **声明与实现不许漂移**，且"能分辨"这件事本身要有机器可核对的落点。
 */
describe('批量路径复核与字典分段：模板 / technique / 容器三处对拍（2026-10-11）', () => {
  it('http_probe 的 paths：模板声明、命令形态、carries、technique 默认都在，形状即语义', () => {
    const spec = registry.get('recon_http_probe');
    assert.ok(spec !== undefined);
    const declared = spec.template.parameters.find((p) => p.name === 'paths');
    assert.ok(declared !== undefined && declared.kind === 'string', '模板必须声明 paths（字符串 + 形状）');
    assert.ok((declared.pattern ?? '').length > 0, 'paths 必须带 shape 校验（形状是语义的一部分，不只是提示）');
    assert.match(spec.commandTemplate, /paths=\{paths\}/, '新参数必须进入命令形态');
    assert.ok('paths' in spec.carries, '新参数必须有 carries');
    assert.equal(
      STRUCTURED_TECHNIQUES.recon.http_probe?.defaults.paths,
      '',
      'technique 默认必须是空串（关闭）：默认行为不变，批量复核是显式动作',
    );
    const base = { port: 80, scheme: 'auto', follow_redirects: 0, collect: 'headers', verify_tls: 'true', include_chunks: 'true', page: '', probe_options: 'false' };
    assert.equal(validateForTest('recon_http_probe', { ...base, paths: '' }).ok, true, '空串＝关闭，必须合法');
    assert.equal(validateForTest('recon_http_probe', { ...base, paths: '/,/api/users,/.git/HEAD' }).ok, true);
    // 查询串（2026-10-11 操作者实测 #2）：只读 GET 上 `?k=v` 是表达语义的唯一手段。
    assert.equal(
      validateForTest('recon_http_probe', { ...base, paths: '/api/submissions?mine=1,/api/x?a=1&b=2' }).ok,
      true,
      'paths 必须接受查询串（否则只能退回手写 curl，不进审计通道）',
    );
    for (const bad of [
      'https://example.com/x', // 带 scheme（把路径当目标用）
      '//example.com/x', // 协议相对 URL：带主机
      'example.com/x', // 没有前导 `/`
      '/a b', // 空白（会把 k=v 切成两个 token）
      '/a/../b', // `..` 段
      '/a#f', // 片段（不发给服务端，写进去只会让记账与实发不符）
      '/a?x=<script>', // 查询串里的非法字符
      Array.from({ length: 61 }, (_, i) => `/p${i}`).join(','), // 超 60 条上限
    ]) {
      assert.equal(validateForTest('recon_http_probe', { ...base, paths: bad }).ok, false, `paths=${bad} 必须被拒`);
    }
    // 查询串里的 `..` 是**取值内容**（`?next=/a/../b`），只拦路径部分的 `..`。
    assert.equal(
      validateForTest('recon_http_probe', { ...base, paths: '/x?next=/a/../b' }).ok,
      true,
      '查询串里的 `..` 不该拦（那是取值，不是穿越）',
    );
    // 放行面**只有 `&` 一个字符**（`queryCapable`）：真正危险的 shell 字面量照旧一个不放。
    for (const bad of ['/x?y=$HOME', '/x?y=`id`', '/x?y="q"', '/x?y={a,b}', '/x?y=(1)', '/x?y=a\nb']) {
      assert.equal(
        validateForTest('recon_http_probe', { ...base, paths: bad }).ok,
        false,
        `paths=${JSON.stringify(bad)} 必须被拒（防载荷闸门照旧生效）`,
      );
    }
  });

  it('http_probe 的 page / probe_options：取哪一页 + 未鉴权方法表（2026-10-11 操作者实测 #1）', () => {
    const spec = registry.get('recon_http_probe');
    assert.ok(spec !== undefined);
    for (const name of ['page', 'probe_options']) {
      assert.ok(
        spec.template.parameters.some((p) => p.name === name),
        `模板必须声明 ${name}`,
      );
      assert.ok(name in spec.carries, `${name} 必须有 carries（否则注册期就报错）`);
      assert.match(spec.commandTemplate, new RegExp(`${name}=\\{${name}\\}`), `${name} 必须进入命令形态`);
    }
    assert.equal(
      STRUCTURED_TECHNIQUES.recon.http_probe?.defaults.page,
      '',
      'page 默认空串＝站点根：不改变既有调用的语义',
    );
    assert.equal(
      STRUCTURED_TECHNIQUES.recon.http_probe?.defaults.probe_options,
      'false',
      'probe_options 默认 false：额外请求是显式动作',
    );
    assert.deepEqual(STRUCTURED_TECHNIQUES.recon.http_probe?.enums?.probe_options, ['true', 'false']);
    const base = { port: 80, scheme: 'auto', follow_redirects: 0, collect: 'endpoints', verify_tls: 'true', include_chunks: 'true', paths: '', probe_options: 'false', page: '' };
    assert.equal(validateForTest('recon_http_probe', { ...base, page: '' }).ok, true, '空串＝站点根');
    assert.equal(validateForTest('recon_http_probe', { ...base, page: '/admin' }).ok, true);
    assert.equal(validateForTest('recon_http_probe', { ...base, page: '/admin?tab=1' }).ok, true, 'page 可带查询串');
    for (const bad of ['/a,/b', 'https://h/x', '/a b', '/a/../b', '/a#f']) {
      assert.equal(validateForTest('recon_http_probe', { ...base, page: bad }).ok, false, `page=${bad} 必须被拒`);
    }
    assert.equal(validateForTest('recon_http_probe', { ...base, probe_options: 'true' }).ok, true);
    assert.equal(validateForTest('recon_http_probe', { ...base, probe_options: 'yes' }).ok, false);
  });

  it('http_probe paths= 的容器实现：GET（可加 OPTIONS）+ 分命名空间软 404 基准 + 方法表 + 逐条表格与汇总', () => {
    const start = DISPATCHER.indexOf('def http_probe(');
    const verbBody = DISPATCHER.slice(start, DISPATCHER.indexOf('\ndef ', start + 1));
    assert.match(verbBody, /parse_probe_paths\(params\)/, '容器侧必须读 paths 并做**服务端**校验');
    assert.ok(DISPATCHER.includes('PROBE_PATHS_LIMIT = 60'), '条数上限必须是常量 60（与模板 {0,59} 同口径）');
    // 复核的主方法是 GET（形态由服务端固定）；`probe_options=true` 时**额外**发只读 OPTIONS。
    const probeOne = verbBody.slice(verbBody.indexOf('def probe_one('), verbBody.indexOf('paths_budget:'));
    assert.ok(probeOne.length > 0, '找不到 probe_one（批量复核的逐条实现）');
    assert.match(probeOne, /conn\.request\(\s*\n?\s*"GET",/, '复核主方法写死为 GET（不许再留一个没人用的 method 形参）');
    assert.ok(!/method: str = "GET"/.test(probeOne), '死参数已删（第八轮质检：它形同虚设却让"只发 GET"这条锁变松）');
    assert.ok(!/"(HEAD|POST|PUT|DELETE|PATCH)"/.test(verbBody), '批量复核不得出现写方法或 HEAD');
    // OPTIONS **只有一条**路径（`fetch_methods`）：probe_one 里不得再出现 OPTIONS。
    assert.ok(!/conn\.request\(\s*"OPTIONS"/.test(probeOne), 'probe_one 不得**发** OPTIONS（两条路径做同一件事、锁只钉得住一条）');
    assert.ok(!/fetch_methods\(/.test(probeOne), 'probe_one 不得调 fetch_methods（OPTIONS 只有一条路径）');
    assert.match(verbBody, /fetch_methods\(use_scheme, item_path/, 'probe_options=true 时必须逐条发 OPTIONS');
    assert.match(verbBody, /allow = \(resp\.getheader\("allow"\)/, 'GET 响应里的 Allow 也要收（405 响应常带方法表）');
    assert.match(verbBody, /method_table:/, '方法表要自己开口（未鉴权清点，不发写请求）');
    // 软 404 基准：**按命名空间各取一条**（页面 404 与 API 404 常不同形），同命名空间同形即判兜底。
    assert.match(verbBody, /SOFT404_PATH_PREFIX/, '必须用随机路径取软 404 基准');
    assert.match(DISPATCHER, /def namespace_of_path\(item_path: str\) -> str:/, '必须有"路径 → 命名空间"的纯函数（模块级：要给行为对拍用）');
    assert.match(verbBody, /paths_soft404_baseline: ns=\{ns\}/, '基准要逐命名空间自己开口（含取不到的情形）');
    // 采样器是**有界**的纯函数（第八轮质检：旧写法能采到 7 条，而预算只按 6 算）。
    assert.match(verbBody, /sample_baseline_namespaces\(probe_paths\)/, '基准命名空间必须走采样器（上限在它里面）');
    const sampler = DISPATCHER.slice(
      DISPATCHER.indexOf('def sample_baseline_namespaces('),
      DISPATCHER.indexOf('def parse_entry_range('),
    );
    assert.match(sampler, /SOFT404_MAX_BASELINES - 1/, '其它命名空间必须按"上限 − 1"截断（根那条永远占一位）');
    assert.match(sampler, /\+\s*\["\/"\]/, '根永远采一条（最终兜底尺子）');
    assert.match(DISPATCHER, /SOFT404_MAX_BASELINES = \d+/, '基准条数必须有常量上限（否则 60 条路径能打出 60 次基准请求）');
    assert.match(
      verbBody,
      /request_budget = len\(probe_paths\) \* \(2 if probe_options else 1\) \+ SOFT404_MAX_BASELINES \+ 1/,
      '预算 = 路径(×2) + 基准（同一上限）+ **预检那一次**（第八轮质检：报告写 N 而实际发 N+1）',
    );
    // 基准缺失**不许退化成 ok**（第八轮质检 major 回归：某命名空间采不到基准时，兜底路由会被当端点）。
    assert.match(DISPATCHER, /def pick_baseline_ns\(item_path: str, recorded: list\[str\]\) -> str \| None:/, '回退只能在**真的采到基准**的前缀里选');
    assert.match(verbBody, /pick_baseline_ns\(item_path, list\(baselines\)\)/, '逐条判定要用 pick_baseline_ns（吃的是已采到的基准）');
    assert.match(verbBody, /note = "no_baseline"/, '没有可用基准时必须标 no_baseline（不可判定，不许写 ok）');
    assert.match(verbBody, /paths_warning: \{no_baseline\} 条路径/, '不可判定的条数要显式告警');
    assert.match(verbBody, /if note in \("ok", "size>=cap"\):/, 'candidate_endpoint 只许从"判过"的行里出（no_baseline 不是候选）');
    assert.match(verbBody, /note = "soft404"/, '与基准同形的命中要标 soft404');
    assert.match(verbBody, /candidate_endpoint:/, '非兜底命中要有可直接引用的短行');
    assert.match(
      verbBody,
      /paths_summary: paths=\{len\(probe_paths\)\} responded=\{responded\} no_response=\{no_response\}/,
      '汇总形态固定：paths=N ok=M no_response=K',
    );
    assert.ok(
      verbBody.includes('paths_columns: path<TAB>status<TAB>size<TAB>content_type<TAB>note<TAB>baseline_ns<TAB>allow'),
      '列定义要写出来（含 baseline_ns 与 allow 两列）',
    );
    assert.match(verbBody, /unprobed/, '墙钟到点必须报"没发出去"的条数（否则会被读成"不存在"）');
    assert.match(verbBody, /collect=endpoints/, '复核通道要指明"发现"用哪条通道（不许替代发现）');
    // 服务端拒绝"把路径当目标用"（模板只管形状，模型仍可能递 scheme/主机串）。
    const parser = DISPATCHER.slice(
      DISPATCHER.indexOf('def split_probe_path('),
      DISPATCHER.indexOf('def parse_entry_range('),
    );
    assert.match(parser, /:\/\/" in item or not item\.startswith\("\/"\)/, '必须拒绝含 scheme/主机/无前导 / 的串');
    assert.match(parser, /head\.startswith\("\/\/"\)/, '必须拒绝协议相对 URL（//host/x）');
    assert.match(parser, /不得含空白/, '必须拒绝含空白的串（命令按空格分词）');
    assert.match(parser, /PROBE_PATH_RE\.match/, '路径部分的形状由常量正则锁死');
    assert.match(parser, /PROBE_QUERY_RE\.match/, '查询串部分的形状由常量正则锁死');
    assert.match(parser, /不得含片段/, '必须拒绝片段 `#`（不发给服务端）');
    assert.match(parser, /def parse_page_path\(/, 'page 必须走同一个校验器（形状即语义）');
    assert.match(verbBody, /page_path = parse_page_path\(params\)/, '容器侧必须读 page');
    assert.match(verbBody, /result = fetch\(use_scheme, preflight_path, preflight_timeout\)/, '预检必须用 preflight_path/preflight_timeout（批量模式下不许用 page、不许吃整段预算）');
    assert.match(
      verbBody,
      /preflight_path = "\/" if probe_paths else page_path/,
      'paths= 批量模式**不取 page**（第八轮质检：文案说不生效，代码却用它做预检——多发一个请求且会拖垮整批）',
    );
    assert.match(
      verbBody,
      /preflight_timeout = max\(1\.0, min\(8\.0, timeout_s \/ max\(1, preflight_budget\)\)\)/,
      '批量模式的预检要按逐条预算计时（否则一页挂住就把整批复核废掉）',
    );
    assert.match(verbBody, /endpoints_page: \{page_path\}/, '抽取来源页要写出来（可复核：抽的是哪一页）');
  });

  it('content_discover 的 entry_range：模板声明、命令形态、carries、technique 默认都在', () => {
    const spec = registry.get('recon_content_discover');
    assert.ok(spec !== undefined);
    const declared = spec.template.parameters.find((p) => p.name === 'entry_range');
    assert.ok(declared !== undefined && declared.kind === 'string', '模板必须声明 entry_range');
    assert.match(spec.commandTemplate, /entry_range=\{entry_range\}/, '新参数必须进入命令形态');
    assert.ok('entry_range' in spec.carries, '新参数必须有 carries');
    assert.equal(
      STRUCTURED_TECHNIQUES.recon.content_discover?.defaults.entry_range,
      '',
      'technique 默认必须是空串（整本字典）：不改变既有调用的语义',
    );
    const base = { port: 80, scheme: 'http', wordlist: 'common_dirs', extensions: 'none', rate: 5, verify_tls: 'true', path: '' };
    assert.equal(validateForTest('recon_content_discover', { ...base, entry_range: '' }).ok, true);
    assert.equal(validateForTest('recon_content_discover', { ...base, entry_range: '1-2000' }).ok, true);
    // 模板只管**形状**：1 ≤ A ≤ B ≤ 条目数 这类语义只能由容器（知道字典有多长）判。
    for (const bad of ['1-', '-10', '1-2-3', 'abc', '1 - 2', '1234567-1', '1-2000,3000-4000']) {
      assert.equal(validateForTest('recon_content_discover', { ...base, entry_range: bad }).ok, false, `entry_range=${bad} 必须被拒`);
    }
  });

  it('content_discover 的容器实现：分段切片 + 覆盖度自报 + 可调度性提示（数学不是判断）', () => {
    const start = DISPATCHER.indexOf('def content_discover(');
    const body = DISPATCHER.slice(start, DISPATCHER.indexOf('\ndef web_crawl(', start));
    assert.match(body, /param_optional\(params, "entry_range"/, '容器侧必须读 entry_range（经 param_optional）');
    assert.ok(
      DISPATCHER.includes('ENTRY_RANGE_RE = re.compile(r"^(\\d{1,6})-(\\d{1,6})$")'),
      'entry_range 的形状常量必须与模板模式同口径',
    );
    assert.match(body, /parse_entry_range\(raw_range, wordlist_lines\)/, '语义校验（上界 ≤ 条目数）走同一个纯函数');
    assert.match(body, /ffuf\.wordlist\.txt/, '必须把**本段**字典落盘再喂给 ffuf（报告的编号与实跑同一来源）');
    for (const field of ['coverage: wordlist_entries=', 'attempted=', 'truncated=', 'position=', 'remaining=', 'position_max_hit=']) {
      assert.ok(body.includes(field), `coverage 行缺字段 ${field}`);
    }
    assert.match(body, /coverage_note:/, '必须给一句人能读懂的"跑到哪儿、还剩多少"');
    assert.match(body, /需要分 \{segments\} 段/, '超可调度量时必须直接写出"需要分 N 段"（这是数学，不是判断）');
    assert.match(body, /schedulability_note:/, '本段自己就超容量时也要说（否则又是"跑一半"）');
    // 覆盖依据来自 ffuf 的 stderr 进度行 ⇒ **不能再传 `-s`**（静默模式把进度整条吞掉，
    // 于是"跑完、干净"与"跑一半被 maxtime 砍"输出同形——这正是本轮要修的形态）。
    assert.ok(!body.includes('"-s"'), '不得再用 -s：进度行是覆盖度的唯一直接证据');
    assert.match(body, /facts = ffuf_stderr_facts\(stderr\)/, 'stderr 要走同一份解析（进度/速率/错误计数/maxtime）');
    // 速率口径（2026-10-11 操作者实测 #4）：ffuf 的 `-p` 是**每线程**间隔，旧公式 `1/rate` 配
    // `-t rate` 实际打出 `rate²`（真容器对拍：`-t 5 -p 0.20` → 25 req/s、`-t 5 -p 1.00` → 5 req/s、
    // `-t 1 -p 1.00` → 1 req/s）。声明值必须等于实测值，否则"按 5/s 排的预算"是假的。
    assert.match(body, /threads = min\(10, max\(1, rate\)\)/, '线程数必须是显式变量（速率公式的分子）');
    assert.match(body, /delay = threads \/ rate/, '每线程间隔必须是 threads/rate（声明值才等于实测值）');
    assert.match(body, /"-t", str\(threads\)/, 'argv 必须用同一个线程数变量（不许两处各算一遍）');
    assert.match(body, /rate_check: declared_rps=\{rate\} observed_rps=/, '声明与实测必须逐轮对账');
    assert.match(body, /verdict=\{'over' if over else 'ok'\}/, '超速必须有可判定的 verdict（over/ok）');
    assert.ok(DISPATCHER.includes('def ffuf_stderr_facts(stderr: str) -> dict:'), '覆盖度读数必须有单一来源');
    assert.ok(DISPATCHER.includes('FFUF_MAXTIME_RE = re.compile(r"Maximum running time")'), 'maxtime 收尾行是截断的直接证据');
  });
});

describe('buildStructuredIntent 布尔值强制转换（2026-10-10 实测：LLM 看到 enum: ["true","false"] 常传布尔）', () => {
  it('枚举参数：布尔值自动转换成字符串', () => {
    // 用户传布尔 false
    const result = buildStructuredIntent('recon', {
      technique: 'http_probe',
      targetSelector: '10.0.0.9',
      purpose: 'test',
      port: 443,
      scheme: 'https',
      verify_tls: false, // 布尔
    });
    assert.ok(result.ok);
    assert.strictEqual(result.params.verify_tls, 'false', 'verify_tls 应转换成字符串 "false"');
    assert.strictEqual(typeof result.params.verify_tls, 'string');

    // 用户传布尔 true
    const result2 = buildStructuredIntent('recon', {
      technique: 'http_probe',
      targetSelector: '10.0.0.9',
      purpose: 'test',
      verify_tls: true, // 布尔
    });
    assert.ok(result2.ok);
    assert.strictEqual(result2.params.verify_tls, 'true', 'verify_tls 应转换成字符串 "true"');
  });

  it('非枚举参数收到布尔：**明确拒绝**（不许归一成 "true" 静默命中模式）', () => {
    // `scripts: true` 若被归一成 `'true'`，正好命中脚本名的 `^[a-z0-9-]+(,…)*$` ⇒
    // 一个类型错误会变成**合法的静默调用**（`ports: true` 同理：结果对、理由错、不可预期）。
    // 契约：布尔只对枚举参数有意义；其余一律在工具层拒绝并说明理由。
    const scripts = buildStructuredIntent('recon', {
      technique: 'nse_safe',
      targetSelector: 't',
      purpose: 'p',
      port: 80,
      scripts: true,
    });
    assert.equal(scripts.ok, false, '非枚举参数收到布尔必须拒绝');
    assert.match(scripts.ok ? '' : scripts.message, /只有枚举参数接受布尔/);
  });

  it('非枚举参数：保留原始类型', () => {
    const result = buildStructuredIntent('recon', {
      technique: 'port_scan',
      targetSelector: '10.0.0.9',
      purpose: 'test',
      scope: 'top100', // 非枚举参数
    });
    assert.ok(result.ok);
    assert.strictEqual(result.params.scope, 'top100');
    assert.strictEqual(typeof result.params.scope, 'string');
  });

  it('转换后的字符串值能通过模板验证', () => {
    const result = buildStructuredIntent('recon', {
      technique: 'http_probe',
      targetSelector: '10.0.0.9',
      purpose: 'test',
      verify_tls: false, // 布尔
    });
    assert.ok(result.ok);

    const spec = registry.get('recon_http_probe');
    assert.ok(spec !== undefined);

    const validation = validateParams(spec.template, result.params);
    assert.ok(validation.ok, `模板验证应通过，实际：${validation.ok ? 'ok' : validation.error.message}`);
  });
});
