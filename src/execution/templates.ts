/**
 * 服务端受信动作模板注册表（设计文档 §10.2.1）。
 *
 * **2026-10-05 起只剩一张模板**（人类要求：模板是早期「封闭动作集」的遗留，清理掉）。
 * 对 Agent 而言模板概念**已经不存在**：`pentest_exec` 现在只收一条命令，
 * 服务端把它当作这张唯一模板的实例来处理。
 *
 * 为什么还留着一张：下面四样机制都挂在「模板实例化」上，删掉它们才是真损失——
 *   - **范围闸门**：目标只来自选择器，端口按声明记账（`portSource`）；
 *   - **计划摘要与幂等**：命令 + 目标 + 端口 + 预算派生 `plan_hash`，同一动作不会执行两次；
 *   - **证据关联**：`tool_runs` 按模板实例记录命令原文与产出；
 *   - **放行类别**：类别来自模板注册信息——这是「哪些动作要人批」的唯一可信来源
 *     （让 Agent 自报风险等级等于没有风险分级）。
 *
 * 因此仍然保留的硬约束：
 *   - 目标只能来自选择器注入：命令里的目标由服务端从已裁决的规范化目标写入；
 *   - 端口是必填整数，用于范围闸门记账（自由命令实际可打该主机的任意端口，这一点如实写在 carries 里）；
 *   - 命令文本长度、超时、输出都有上限；
 *   - 类别固定 `exploit_validation` ⇒ **每条命令都要人类逐次放行**（契约下限，不可下调）。
 */

import type {
  ActionTemplate,
  NormalizedTarget,
  Protocol,
  TemplateParam,
  ToolError,
} from '../contracts.ts';
import { targetLiteral } from './idempotency.ts';

/** 参数取值：模板声明的取值范围只允许标量（字符串或整数）。 */
type ParamValue = string | number;
export type ParamBag = Readonly<Record<string, ParamValue>>;

type TemplateValidation =
  /**
   * 通过。`params` 是**归一化后**的参数（目前只有一种归一化：整数字段接受规范数字串，
   * 统一转成数字）。调用方必须用它，而不是自己手里那份原始输入——否则下游看到的是字符串，
   * 范围判定、命令拼装与计划摘要都会跟着走样。
   */
  | { readonly ok: true; readonly params: ParamBag }
  | { readonly ok: false; readonly error: ToolError };

/**
 * 端口来源：范围判定必须明确端口从何处来（§10.2.2）。
 * ICMP 没有端口维度，因此用 `none` 显式表达，而不是缺省成 0 或跳过校验。
 */
type PortSource =
  | { readonly kind: 'target' }
  | { readonly kind: 'param'; readonly param: string }
  | { readonly kind: 'fixed'; readonly port: number }
  | { readonly kind: 'none' };

/** 注册的模板：契约里的 `ActionTemplate` 加上服务端持有的命令构造与协议/端口来源。 */
export interface ActionTemplateSpec {
  readonly template: ActionTemplate;
  /** 协议由注册信息决定，Agent 无法在调用里更改（协议无法确定即拒绝，§10.2.2）。 */
  readonly protocol: Protocol;
  readonly portSource: PortSource;
  /**
   * **跳过 `FORBIDDEN_PAYLOAD_RULES`** 的显式开关（默认 false）。
   *
   * 只有「自由命令」这一类模板会打开它——它的参数**就是要携带任意命令文本**，黑名单对它没有意义。
   * 代价与补偿写在 `direct_command` 的注册说明里；关键补偿是它属于 `exploit_validation` 类，
   * 因而本部署**每条命令都要人类逐次放行**。除它以外的模板一律不许打开（评审与测试都盯着这一条）。
   */
  readonly allowFreeForm?: boolean;
  /** 每个参数「可携带什么」的显式声明；键集合必须与 parameters 完全一致。 */
  readonly carries: Readonly<Record<string, string>>;
  /**
   * 服务端固定命令形态，逐 token 形如 `name={placeholder}`。
   * 占位符只能是目标占位符或已声明的参数名——注册时校验，命令文本不接受自由输入。
   */
  readonly commandTemplate: string;
}

export interface TemplateRegistry {
  /** 已注册模板（按注册顺序，人类审阅用）。 */
  list(): readonly ActionTemplateSpec[];
  get(templateId: string): ActionTemplateSpec | undefined;
}

// ───────────────────────────── 自由形式载荷黑名单 ─────────────────────────────

interface ForbiddenPayloadRule {
  readonly id: string;
  readonly detail: string;
  readonly test: RegExp;
}

/**
 * §10.2.1「解释器与外部模板受限」：这些形态一律拒绝，不区分「看起来是否有害」。
 * 规则作用于 **string 类型参数**（enum / integer 由取值范围保证，不受此影响）。
 */
/**
 * `verify_tls` 的 carries 文案**单源**（四处模板共用：http_probe / http_check / exposure_check，
 * 以及未来任何走 `ssl_context()` 的动词）。它同时是一句**承诺**：说"报告里会写明未校验"，
 * 就必须真有那一行 —— 实现在 `pentest-tool` 的 `tls_verify_line()`（2026-10-07 首版曾写成假承诺）。
 */
const VERIFY_TLS_CARRY =
  '**默认 true**（校验证书）。自签/IP 目标要连通必须显式 false —— 此后该次结果不再能证明"证书链可信"，报告里会写明未校验';

const FORBIDDEN_PAYLOAD_RULES: readonly ForbiddenPayloadRule[] = Object.freeze([
  {
    id: 'free_form_shell_interpreter',
    detail: '自由形式解释器调用（sh/bash/cmd/powershell -c）',
    test: /(?:^|[\s=;&|])(?:sh|bash|zsh|dash|ksh|csh|tcsh|cmd|powershell|pwsh)\s+(?:-\w*c\b|--?command\b|\/c\b)/i,
  },
  {
    id: 'free_form_scripting_interpreter',
    detail: '自由形式脚本解释器调用（python/perl/ruby/node/php -c）',
    test: /(?:^|[\s=;&|])(?:python[0-9.]*|perl|ruby|node|nodejs|php|lua|tclsh|osascript)\s+(?:-\w*[ce]r?\b|--?(?:eval|command|exec)\b)/i,
  },
  {
    id: 'external_script_reference',
    detail: '外部脚本/模板/配置引用（--script、--template、--from-file 等）',
    test: /(?:^|[\s=])--?(?:script|scripts|template|templates|from-file|rcfile|config|plugin|module|require|include|execute|eval)\b/i,
  },
  {
    id: 'remote_script_reference',
    detail: '指向远端脚本的引用',
    test: /https?:\/\/\S+\.(?:sh|py|pl|rb|js|ps1|bat|cmd)(?:\?\S*)?/i,
  },
  {
    id: 'percent_encoded_payload',
    detail: '百分号编码载荷（连续 ≥2 个 %XX）',
    test: /(?:%[0-9A-Fa-f]{2}){2,}/,
  },
  {
    id: 'base64_payload',
    detail: '疑似 base64 编码载荷',
    test: /[A-Za-z0-9+/]{16,}={1,2}|(?=[A-Za-z0-9+/]{8,})(?=[A-Za-z0-9+/]*[0-9])(?=[A-Za-z0-9+/]*[a-z])(?=[A-Za-z0-9+/]*[A-Z])[A-Za-z0-9+/]{20,}/,
  },
  {
    id: 'escape_encoded_payload',
    detail: '十六进制/Unicode/八进制转义载荷',
    test: /(?:\\x[0-9A-Fa-f]{2}){2,}|(?:\\u[0-9A-Fa-f]{4}){2,}|(?:\\[0-7]{3}){2,}/,
  },
  {
    id: 'command_substitution',
    detail: '命令替换（$(...)、${...} 或反引号）',
    test: /\$[({]|`/,
  },
  {
    id: 'shell_metacharacters',
    detail: 'shell 元字符或控制字符（命令拼接、重定向、引号、花括号展开）',
    test: /[;&|<>$\\"'{}()\n\r\t\v\f]/,
  },
]);

/**
 * 人类可读的命令文本（放行卡与审计展示用）。
 *
 * 服务端实例化后的命令是**给容器读的**（自由命令把正文放在 `command_b64=<base64>` 里）；
 * 人类要批准的却是「将要执行什么」。**放行卡是放开权限后唯一的内容闸门，闸门上不能是
 * 一串 base64** ——所以这里把 `*_b64` 形式的字符串参数解码出来作为展示文本。
 *
 * 解码失败**不抛错**：回落到 `normalizedCommand`（执行用的仍是参数原文，展示不改变执行语义）。
 * 用往返校验识别非法 base64——`Buffer` 对坏输入是静默截断，不校验会把半截命令当正文。
 */
export function buildDisplayCommand(spec: ActionTemplateSpec, params: ParamBag): string | undefined {
  for (const p of spec.template.parameters) {
    if (p.kind !== 'string' || !p.name.endsWith('_b64')) continue;
    const value = params[p.name];
    if (typeof value !== 'string' || value.length === 0) continue;
    const decoded = Buffer.from(value, 'base64').toString('utf8');
    if (decoded.length > 0 && Buffer.from(decoded, 'utf8').toString('base64') === value) return decoded;
  }
  return undefined;
}

/** 命中即返回规则；未命中返回 undefined。 */
export function findForbiddenPayload(value: string): { id: string; detail: string } | undefined {
  for (const rule of FORBIDDEN_PAYLOAD_RULES) {
    if (rule.test.test(value)) return { id: rule.id, detail: rule.detail };
  }
  return undefined;
}

// ───────────────────────────── 参数白名单校验 ─────────────────────────────

function paramError(templateId: string, message: string, nextAction: string): TemplateValidation {
  const error: ToolError = {
    status: 'blocked',
    code: 'classification_rejected',
    message: `模板 ${templateId}：${message}`,
    next_action: nextAction,
  };
  return { ok: false, error };
}

/**
 * 参数白名单校验（§10.2.1）。语言无关的纯函数，服务与守卫共用同一份判定。
 *
 * 拒绝条件：未声明的参数、缺少声明的参数、类型不匹配、超出取值范围或枚举、
 * 违反模式、命中自由形式载荷黑名单。
 */
export function validateParams(
  template: ActionTemplate,
  params: ParamBag,
  options: { readonly allowFreeForm?: boolean } = {},
): TemplateValidation {
  const declared = new Map<string, TemplateParam>();
  for (const p of template.parameters) declared.set(p.name, p);
  // 归一化副本：原输入不动（调用方可能还要用它做别的事），下游拿归一化后的这份。
  const normalized: Record<string, string | number> = { ...params };

  for (const name of Object.keys(params)) {
    if (!declared.has(name)) {
      const allowed = [...declared.keys()].join(', ');
      return paramError(
        template.id,
        `未声明的参数 ${name}（未声明的参数一律拒绝，不做忽略处理）`,
        allowed.length > 0
          ? `改用模板声明的参数集合：${allowed}`
          : '该模板不接受任何参数',
      );
    }
  }

  for (const p of template.parameters) {
    if (!Object.hasOwn(params, p.name)) {
      return paramError(
        template.id,
        `缺少参数 ${p.name}（模板声明的参数即必填，省略即拒绝）`,
        `显式提供参数 ${p.name}：${describeParam(p)}`,
      );
    }
    const value = params[p.name];
    switch (p.kind) {
      case 'enum': {
        const values = p.values ?? [];
        if (typeof value !== 'string' || !values.includes(value)) {
          return paramError(
            template.id,
            `参数 ${p.name} 取值不在枚举内：${String(value)}`,
            `只允许：${values.join(', ')}`,
          );
        }
        break;
      }
      case 'integer': {
        // 宿主链路实测会把 JSON 整数转成字符串（模型传 3002，校验看到 "3002"），
        // 于是所有必填 port 的模板（free_command / tcp_connect / udp_probe）全部不可用。
        // 这里接受**规范数字串**并归一化为数字：输入宽容、输出严格——
        // 下游（范围判定、命令拼装、计划摘要）一律看到数字，而拒绝面不变
        // （'3.5'、'abc'、''、' 3002 ' 这类非规范写法仍然拒绝）。
        const numeric = typeof value === 'string' && /^-?\d+$/.test(value) ? Number(value) : value;
        if (typeof numeric !== 'number' || !Number.isSafeInteger(numeric)) {
          return paramError(
            template.id,
            `参数 ${p.name} 必须是整数：${String(value)}`,
            `提供整数取值：${describeParam(p)}`,
          );
        }
        if (p.min !== undefined && numeric < p.min) {
          return paramError(template.id, `参数 ${p.name} 小于下界 ${p.min}`, `取值范围：${describeParam(p)}`);
        }
        if (p.max !== undefined && numeric > p.max) {
          return paramError(template.id, `参数 ${p.name} 大于上界 ${p.max}`, `取值范围：${describeParam(p)}`);
        }
        normalized[p.name] = numeric;
        break;
      }
      case 'string': {
        if (typeof value !== 'string') {
          return paramError(
            template.id,
            `参数 ${p.name} 必须是字符串：${String(value)}`,
            `提供字符串取值：${describeParam(p)}`,
          );
        }
        if (p.pattern !== undefined && !new RegExp(p.pattern).test(value)) {
          return paramError(
            template.id,
            `参数 ${p.name} 不满足模板声明的模式`,
            `取值必须匹配 /${p.pattern}/`,
          );
        }
        // `allowFreeForm` 只由注册信息打开（见 `ActionTemplateSpec.allowFreeForm`）：
        // 自由命令模板的参数就是要携带任意文本，黑名单在这里没有意义。
        const forbidden = options.allowFreeForm === true ? undefined : findForbiddenPayload(value);
        if (forbidden !== undefined) {
          return paramError(
            template.id,
            `参数 ${p.name} 命中受限载荷形态：${forbidden.detail}`,
            '自由形式解释器调用、编码载荷与外部脚本/模板引用只能作为显式注册的受信模板实现',
          );
        }
        break;
      }
      default: {
        // 未知 kind 属于注册配置错误：无法判定即拒绝，不猜测。
        return paramError(template.id, `参数 ${p.name} 的取值类型未受支持`, '修正模板注册信息');
      }
    }
  }

  return { ok: true, params: normalized };
}

function describeParam(p: TemplateParam): string {
  switch (p.kind) {
    case 'enum':
      return `枚举 [${(p.values ?? []).join(', ')}]`;
    case 'integer': {
      const min = p.min ?? '-∞';
      const max = p.max ?? '+∞';
      return `整数 ${min}..${max}`;
    }
    case 'string':
      return p.pattern === undefined ? '字符串' : `匹配 /${p.pattern}/ 的字符串`;
    default:
      return '未支持';
  }
}

// ───────────────────────────── 端口来源解析 ─────────────────────────────

/** 供范围判定使用的端口；`undefined` 表示该动作没有端口维度。 */
export function portForScope(spec: ActionTemplateSpec, params: ParamBag): number | undefined {
  switch (spec.portSource.kind) {
    case 'target':
      return undefined;
    case 'param': {
      const raw = params[spec.portSource.param];
      return typeof raw === 'number' ? raw : undefined;
    }
    case 'fixed':
      return spec.portSource.port;
    case 'none':
      return undefined;
  }
}

// ───────────────────────────── 命令构造 ─────────────────────────────

interface CommandToken {
  readonly name: string;
  readonly placeholder: string;
}

/**
 * 命令形态：首个 token 必须是注册的工具名（服务端固定），其余为 `name={placeholder}`。
 * 目标占位符与参数占位符之外不接受任何自由文本。
 */
const COMMAND_TOKEN = /^([a-z][a-z0-9_]*)=\{([A-Za-z_][A-Za-z0-9_]*)\}$/;
const TOOL_TOKEN = /^[a-z][a-z0-9_.-]*$/;

function parseCommandTemplate(spec: ActionTemplateSpec): readonly CommandToken[] {
  const raw = spec.commandTemplate.trim();
  if (raw.length === 0) throw new Error(`模板 ${spec.template.id} 的 commandTemplate 为空`);
  const tokens = raw.split(/\s+/);
  const [tool, ...rest] = tokens;
  if (tool === undefined || !TOOL_TOKEN.test(tool) || tool !== spec.template.tool) {
    throw new Error(
      `模板 ${spec.template.id} 的命令必须以注册的工具名 ${spec.template.tool} 开头：${spec.commandTemplate}`,
    );
  }
  return rest.map((token) => {
    const m = COMMAND_TOKEN.exec(token);
    if (m === null) {
      throw new Error(
        `模板 ${spec.template.id} 的命令 token 非法（只允许 name={placeholder}）：${token}`,
      );
    }
    return { name: m[1] as string, placeholder: m[2] as string };
  });
}

/**
 * 用模板实例化规范化命令：目标从已裁决的规范化目标写入，其余取值只能是被白名单校验过的参数。
 * 命令形态由服务端固定，Agent 无法引入额外 token、重定向或引用。
 */
export function buildNormalizedCommand(
  spec: ActionTemplateSpec,
  target: NormalizedTarget,
  params: ParamBag,
): string {
  const parts: string[] = [spec.template.tool];
  for (const token of parseCommandTemplate(spec)) {
    if (token.placeholder === spec.template.targetPlaceholder) {
      parts.push(`${token.name}=${targetLiteral(target)}`);
      continue;
    }
    const value = params[token.placeholder];
    if (value === undefined) continue; // validateParams 已保证不出现；此处保守跳过而非猜测
    parts.push(`${token.name}=${value}`);
  }
  return parts.join(' ');
}

// ───────────────────────────── 注册表 ─────────────────────────────

/**
 * 构造注册表并做注册期校验：配置错误在加载时即失败，不留到执行期。
 * 校验项：id 唯一、参数与 carries 一一对应、命令占位符与声明集合一致、
 * 端口来源可解析、ICMP 不接受端口维度。
 */
export function createRegistry(specs: readonly ActionTemplateSpec[]): TemplateRegistry {
  const byId = new Map<string, ActionTemplateSpec>();
  for (const spec of specs) {
    const id = spec.template.id;
    if (byId.has(id)) throw new Error(`动作模板 id 重复注册：${id}`);

    const declared = spec.template.parameters.map((p) => p.name);
    if (new Set(declared).size !== declared.length) {
      throw new Error(`模板 ${id} 的参数名重复`);
    }
    const carriesKeys = Object.keys(spec.carries);
    if (carriesKeys.length !== declared.length || declared.some((n) => !(n in spec.carries))) {
      throw new Error(`模板 ${id} 必须为每个参数显式声明 carries（可携带什么）`);
    }

    const tokens = parseCommandTemplate(spec);
    const placeholders = tokens.map((t) => t.placeholder);
    const targetUses = placeholders.filter((p) => p === spec.template.targetPlaceholder).length;
    if (targetUses !== 1) {
      throw new Error(
        `模板 ${id} 的命令必须且只能引用一次目标占位符 {${spec.template.targetPlaceholder}}`,
      );
    }
    for (const p of placeholders) {
      if (p === spec.template.targetPlaceholder) continue;
      if (!declared.includes(p)) throw new Error(`模板 ${id} 的命令引用了未声明的参数 {${p}}`);
    }
    for (const name of declared) {
      if (!placeholders.includes(name)) {
        throw new Error(`模板 ${id} 声明了参数 ${name} 但命令未使用它（声明即必须进入命令）`);
      }
    }

    const portSource = spec.portSource;
    if (portSource.kind === 'param') {
      const decl = spec.template.parameters.find((p) => p.name === portSource.param);
      if (decl === undefined || decl.kind !== 'integer') {
        throw new Error(`模板 ${id} 的端口来源参数 ${portSource.param} 必须是已声明的 integer 参数`);
      }
    }
    if (portSource.kind === 'fixed') {
      const port = portSource.port;
      if (!Number.isInteger(port) || port < 1 || port > 65535) {
        throw new Error(`模板 ${id} 的固定端口非法`);
      }
    }
    if (spec.protocol === 'icmp' && portSource.kind !== 'none') {
      throw new Error(`模板 ${id} 为 ICMP 协议，不存在端口维度，portSource 必须是 none`);
    }
    if (spec.template.timeoutMs <= 0 || spec.template.maxOutputBytes <= 0) {
      throw new Error(`模板 ${id} 的超时或输出上限非法`);
    }

    byId.set(id, spec);
  }

  const frozen = Object.freeze([...specs]);
  return {
    list: () => frozen,
    get: (templateId: string) => byId.get(templateId),
  };
}

// ───────────────────────────── 默认模板集 ─────────────────────────────

/**
 * 直连命令模板（**唯一一张**，人类逐条批准）。
 *
 * 为什么要有它：模板集只有五个探测动作时，后两阶段（利用验证 / 后渗透）**没有任何可执行
 * 手段**——它们只能读记忆、写报告。真实渗透需要「在目标上跑命令」，所以这里用三条约束
 * 换取自由：
 *
 *   1. **类别是 `exploit_validation`**：本部署对这类强制**逐次人工放行**，放行卡上显示的就是
 *      将要执行的命令原文（base64 解码后的回显也落 `tool_runs`）。机器无法自己批准。
 *   2. **仍然只跑在沙箱里**（2026-10-04 放开权限、2026-10-05 放开出口后的实际形状）：
 *      `--cap-drop ALL` + 仅 `NET_RAW`、容器内 root（NET_RAW 只对 root 生效）、可写根、
 *      限额 2 CPU/2G/512 pids ⇒ 命令能到达的**主机**由沙箱所在网络与宿主的路由决定
 *      （本部署该网络非 internal，故与宿主可达范围一致——网络层不再是范围边界）。
 *   3. **文本与预算都有上限**：命令 ≤8k 字符、按模板超时、输出受 `PENTEST_MAX_OUTPUT_BYTES` 约束。
 *
 * **它放宽了什么（必须说清）**：端口粒度不再可强制（代理按主机放行，命令可打该主机的任意端口——
 * `port` 参数只用于范围闸门记账）；参数黑名单对它不生效（`allowFreeForm`），因此**审批卡是唯一的
 * 内容闸门**，人类必须真的读那条命令。要恢复「只能跑白名单动作」，把这个模板从注册表移除即可。
 */
const DIRECT_COMMAND_SPEC: ActionTemplateSpec = {
  template: {
    id: 'direct_command',
    // **免批（2026-10-07 操作者裁定：直接"任意命令免批"）**：类别由 `exploit_validation` 改为
    // `active_discovery`（预设内且不在 `PER_ACTION_APPROVAL_CLASSES` 里 ⇒ 不再逐条人批）。
    // 代价已登记在设计文档：这一档从此**不再有人看命令原文**，审批卡对它的闸门失效；
    // 范围裁决与沙箱加固仍在（只打已裁决地址、容器隔离不变）。改这一处必须与镜像里那些
    // "逐条人批"的措辞同轮更新，否则会再生产一处"信息面↔执行面不一致"。
    actionClass: 'active_probing',
    tool: 'shell_exec',
    parameters: [
      { name: 'port', kind: 'integer', min: 1, max: 65535 },
      // base64 字母表:命令不是自由文本字段,形状先在这里卡住(解码在展示层做,见 buildDisplayCommand)。
      { name: 'command_b64', kind: 'string', pattern: '^[A-Za-z0-9+/]+={0,2}$' },
    ],
    targetPlaceholder: 'target',
    // 真工具会在这里跑（nmap 全端口、ffuf 爆破）：60s 不够用。
    // 宿主侧仍与 maxWallClockMs（15min）取小，跑不出无限时长。
    timeoutMs: 300_000,
    maxOutputBytes: 256 * 1024,
  },
  protocol: 'tcp',
  portSource: { kind: 'param', param: 'port' },
  carries: {
    port: '命令主要针对的目标端口（范围闸门据此记账；自由命令实际可打该主机的任意端口）',
    command_b64:
      '要执行的命令（UTF-8 原文的 base64）；沙箱内以 bash -c 运行（Debian 的 /bin/sh 是 dash，' +
      '技能与 Agent 写的都是 bash 方言），容器内 root、根文件系统可写（--rm 即弃），' +
      '能力只有 NET_RAW；能连到的主机由沙箱所在网络与宿主路由决定——本部署可出网',
  },
  commandTemplate: 'shell_exec target={target} port={port} command_b64={command_b64}',
  allowFreeForm: true,
};

/**
 * 默认模板集：**只有一张**直连命令模板。
 *
 * 曾经的 `http_read` / `tcp_connect` / `udp_probe` / `icmp_ping` / `dns_lookup` 五个「示例模板」
 * 已随 2026-10-05 的清理删除：镜像里有 curl/nmap/nc/dig 等真工具，Agent 直接写命令即可，
 * 多一层"先选模板再填参数"只是让它多猜一次名字（实测猜错九个名字、白烧一轮）。
 *
 * 模板声明的参数即必填——这样同一次动作的规范化命令完全由 (模板, 参数) 决定，
 * 幂等键与放行凭证不会因「省略参数走默认值」而产生歧义。
 */

// ───────────────────────── 结构化侦察模板族（情报收集，2026-10-06） ─────────────────────────

/**
 * 为什么要这一族：`direct_command` 把每一种动作都记成 `exploit_validation`，
 * 于是「nmap -sV」这种只读指纹与「打一条 exploit」在闸门上是同一件事——
 * 人审模式下前者要人逐条批（侦察吞吐崩掉），auto 模式下后者又完全不过目。
 * 这一族把**只读/低风险动作**按 `active_probing`（四档预设全部启用，且不在逐次放行下限内）
 * 与 `passive_collection` 记账，于是：
 *
 *   - 人审模式下，侦察类动作**不需要逐条放行**，由范围 + 租约 + pacing（stealth 1rps / standard 5rps / deep 10rps）约束；
 *   - 危险动作仍然只能走 `direct_command`（`exploit_validation`，永远逐条人批）。
 *
 * 与它们一一对应的是沙箱分发器里的同名动词（`docker/tools/pentest-tool`）——那些动词
 * **只打宿主注入的已裁决地址**（`PENTEST_RESOLVED_ADDRESSES`），这是 `shell_exec` 做不到的。
 */
const RECON_TEMPLATES: readonly ActionTemplateSpec[] = [
  {
    template: {
      id: 'recon_port_scan',
      actionClass: 'active_probing',
      tool: 'port_scan',
      parameters: [
        { name: 'scope', kind: 'enum', values: ['top100', 'top1000', 'common_services', 'full_tcp'] },
        // `none` = 用 scope 档位；否则是显式端口表达式。模板声明的参数即必填，
        // 因此「不指定端口」必须是一个**显式取值**，而不是省略。
        { name: 'ports', kind: 'string', pattern: '^(none|\\d{1,5}(-\\d{1,5})?(,\\d{1,5}(-\\d{1,5})?){0,63})$' },
        { name: 'ping', kind: 'enum', values: ['syn', 'connect', 'skip'] },
      ],
      targetPlaceholder: 'target',
      timeoutMs: 300_000,
      maxOutputBytes: 512 * 1024,
    },
    protocol: 'tcp',
    // 多端口扫描没有单一端口维度：如实声明 none（`carries` 里写清实际可达范围）。
    portSource: { kind: 'none' },
    carries: {
      scope: '扫描档位：top100 / top1000 / common_services（约 30 个常见服务端口）/ full_tcp（全 65535，需人类显式选择）',
      ports: 'none 表示按 scope；也可以给显式表达式（如 80,443,8000-8100，最多 64 段）——此时 scope 被忽略',
      ping: 'syn=SYN 扫描（-PS，需 NET_RAW）/ connect=全连接（-sT）/ skip=不判存活直接扫（-Pn）',
    },
    commandTemplate: 'port_scan target={target} scope={scope} ports={ports} ping={ping}',
  },
  {
    template: {
      id: 'recon_service_probe',
      actionClass: 'active_probing',
      tool: 'service_probe',
      parameters: [
        { name: 'ports', kind: 'string', pattern: '^\\d{1,5}(-\\d{1,5})?(,\\d{1,5}(-\\d{1,5})?){0,63}$' },
        { name: 'intensity', kind: 'enum', values: ['light', 'normal'] },
      ],
      targetPlaceholder: 'target',
      timeoutMs: 300_000,
      maxOutputBytes: 512 * 1024,
    },
    protocol: 'tcp',
    portSource: { kind: 'none' },
    carries: {
      ports: '要识别服务的端口表达式（先用 recon_port_scan 拿到开放端口，再对它做指纹）',
      intensity: 'light=--version-intensity 2（快，噪音小）/ normal=5（更准，探测包更多）',
    },
    commandTemplate: 'service_probe target={target} ports={ports} intensity={intensity}',
  },
  {
    template: {
      id: 'recon_nse_safe',
      actionClass: 'active_probing',
      tool: 'nse_run',
      parameters: [
        { name: 'port', kind: 'integer', min: 1, max: 65535 },
        { name: 'scripts', kind: 'string', pattern: '^[a-z0-9-]+(,[a-z0-9-]+){0,7}$' },
      ],
      targetPlaceholder: 'target',
      timeoutMs: 180_000,
      maxOutputBytes: 256 * 1024,
    },
    protocol: 'tcp',
    portSource: { kind: 'param', param: 'port' },
    carries: {
      port: '脚本针对的端口',
      scripts: '只读 NSE 脚本名（逗号分隔，最多 8 个）。白名单由沙箱侧强制：banner/http-title/http-headers/http-methods/http-security-headers/http-server-header/ssl-cert/ssl-enum-ciphers/smb-os-discovery/smb-security-mode/smb2-security-mode/ftp-anon/ssh-auth-methods/rdp-ntlm-info/smtp-commands；*brute*/*dos*/exploit 类一律拒绝',
    },
    commandTemplate: 'nse_run target={target} port={port} scripts={scripts}',
  },
  {
    template: {
      id: 'recon_tls_inspect',
      actionClass: 'active_probing',
      tool: 'tls_probe',
      parameters: [
        { name: 'port', kind: 'integer', min: 1, max: 65535 },
        { name: 'sni', kind: 'string', pattern: '^(none|[A-Za-z0-9._-]{1,253})$' },
        { name: 'enumerate_protocols', kind: 'enum', values: ['on', 'off'] },
      ],
      targetPlaceholder: 'target',
      timeoutMs: 60_000,
      maxOutputBytes: 128 * 1024,
    },
    protocol: 'tcp',
    portSource: { kind: 'param', param: 'port' },
    carries: {
      port: 'TLS 端口（443/8443…）',
      sni: 'SNI 主机名；none 表示用目标名本身',
      enumerate_protocols: 'on 时逐个尝试 TLS1.2 / TLS1.3 并报告协商结果与套件',
    },
    commandTemplate: 'tls_probe target={target} port={port} sni={sni} enumerate_protocols={enumerate_protocols}',
  },
  {
    template: {
      id: 'recon_http_probe',
      actionClass: 'active_probing',
      tool: 'http_probe',
      parameters: [
        { name: 'port', kind: 'integer', min: 1, max: 65535 },
        { name: 'scheme', kind: 'enum', values: ['http', 'https', 'auto'] },
        { name: 'follow_redirects', kind: 'integer', min: 0, max: 3 },
        { name: 'collect', kind: 'enum', values: ['headers', 'security_headers', 'robots', 'sitemap', 'tech'] },
        { name: 'verify_tls', kind: 'enum', values: ['true', 'false'] },
      ],
      targetPlaceholder: 'target',
      timeoutMs: 60_000,
      maxOutputBytes: 256 * 1024,
    },
    protocol: 'tcp',
    portSource: { kind: 'param', param: 'port' },
    carries: {
      port: 'HTTP(S) 端口',
      scheme: 'auto 先试 https 再试 http',
      follow_redirects: '跟随跳转的最大跳数；**跨主机跳转一律拒绝**（与宿主同一策略，需要重新裁决）',
      collect: 'headers=关键响应头 / security_headers=六个安全头有无 / robots=robots.txt 规则 / sitemap=站点地图 URL / tech=技术栈推断（依据响应头与正文标记，不是确证）',
      verify_tls: VERIFY_TLS_CARRY,
    },
    commandTemplate: 'http_probe target={target} port={port} scheme={scheme} follow_redirects={follow_redirects} collect={collect} verify_tls={verify_tls}',
  },
  {
    template: {
      id: 'recon_content_discover',
      actionClass: 'active_probing',
      tool: 'content_discover',
      parameters: [
        { name: 'port', kind: 'integer', min: 1, max: 65535 },
        { name: 'scheme', kind: 'enum', values: ['http', 'https'] },
        { name: 'wordlist', kind: 'enum', values: ['common_dirs', 'raft_small'] },
        { name: 'extensions', kind: 'enum', values: ['none', 'php', 'asp', 'aspx', 'jsp', 'html', 'txt', 'json', 'multi'] },
        { name: 'rate', kind: 'integer', min: 1, max: 20 },
        { name: 'verify_tls', kind: 'enum', values: ['true', 'false'] },
      ],
      targetPlaceholder: 'target',
      timeoutMs: 300_000,
      maxOutputBytes: 512 * 1024,
    },
    protocol: 'tcp',
    portSource: { kind: 'param', param: 'port' },
    carries: {
      port: '目标 Web 端口',
      scheme: 'http / https（https 默认**校验**证书；自签/纯 IP 目标要显式 verify_tls=false，那次结果不证明证书链可信）',
      wordlist: '字典档位（镜像内固定三份：common_dirs / raft_small / subdomains_5k 中的目录类两份）',
      extensions: '追加的扩展名集合；multi = 常见的 7 种',
      rate: '每秒请求数上限（1-20）；并发被钉在 min(10, rate)',
      verify_tls: VERIFY_TLS_CARRY,
    },
    commandTemplate:
      'content_discover target={target} port={port} scheme={scheme} wordlist={wordlist} extensions={extensions} rate={rate} verify_tls={verify_tls}',
  },
  {
    template: {
      id: 'recon_web_crawl',
      actionClass: 'active_probing',
      tool: 'web_crawl',
      parameters: [
        { name: 'port', kind: 'integer', min: 1, max: 65535 },
        { name: 'scheme', kind: 'enum', values: ['http', 'https'] },
        { name: 'depth', kind: 'integer', min: 1, max: 3 },
        { name: 'max_pages', kind: 'integer', min: 1, max: 500 },
        { name: 'verify_tls', kind: 'enum', values: ['true', 'false'] },
      ],
      targetPlaceholder: 'target',
      timeoutMs: 180_000,
      maxOutputBytes: 256 * 1024,
    },
    protocol: 'tcp',
    portSource: { kind: 'param', param: 'port' },
    carries: {
      port: '目标 Web 端口',
      scheme: 'http / https（https 默认**校验**证书；自签/纯 IP 目标要显式 verify_tls=false）',
      depth: '爬取深度（1-3）',
      max_pages: '页数硬上限（1-500）；只跟同主机链接，单页最多读 512KiB',
      verify_tls: VERIFY_TLS_CARRY,
    },
    commandTemplate: 'web_crawl target={target} port={port} scheme={scheme} depth={depth} max_pages={max_pages} verify_tls={verify_tls}',
  },
  {
    template: {
      id: 'recon_dns_enum',
      actionClass: 'passive_collection',
      tool: 'dns_enum',
      parameters: [
        { name: 'record_types', kind: 'string', pattern: '^(A|AAAA|CNAME|MX|NS|TXT|SOA|CAA|SRV)(,(A|AAAA|CNAME|MX|NS|TXT|SOA|CAA|SRV)){0,7}$' },
        { name: 'resolver', kind: 'enum', values: ['system', 'public'] },
      ],
      targetPlaceholder: 'target',
      timeoutMs: 30_000,
      maxOutputBytes: 128 * 1024,
    },
    protocol: 'udp',
    portSource: { kind: 'none' },
    carries: {
      record_types: '要查询的记录类型（最多 8 个，逗号分隔）',
      resolver: 'system=容器解析器 / public=1.1.1.1 + 8.8.8.8（公共场所解析以免暴露内网 DNS）',
    },
    commandTemplate: 'dns_enum target={target} record_types={record_types} resolver={resolver}',
  },
  {
    template: {
      id: 'recon_dns_axfr',
      actionClass: 'active_probing',
      tool: 'dns_axfr',
      parameters: [],
      targetPlaceholder: 'target',
      timeoutMs: 60_000,
      maxOutputBytes: 256 * 1024,
    },
    protocol: 'tcp',
    portSource: { kind: 'none' },
    carries: {},
    commandTemplate: 'dns_axfr target={target}',
  },
  {
    template: {
      id: 'recon_dns_brute',
      actionClass: 'active_probing',
      tool: 'dns_brute',
      parameters: [
        { name: 'wordlist', kind: 'enum', values: ['subdomains_5k'] },
        { name: 'concurrency', kind: 'integer', min: 1, max: 20 },
        { name: 'wildcard_check', kind: 'enum', values: ['on', 'off'] },
      ],
      targetPlaceholder: 'target',
      timeoutMs: 120_000,
      maxOutputBytes: 128 * 1024,
    },
    protocol: 'udp',
    portSource: { kind: 'none' },
    carries: {
      wordlist: '字典档位（镜像内固定：subdomains_5k = 5000 个常见子域标签）',
      concurrency: '并发查询数（1-20）；默认建议 ≤10，避免被解析器限速',
      wildcard_check: 'on 时先用 3 个随机标签探测泛解析，命中与通配答案相同的记录会被剔除',
    },
    commandTemplate: 'dns_brute target={target} wordlist={wordlist} concurrency={concurrency} wildcard_check={wildcard_check}',
  },
  {
    template: {
      id: 'recon_whois',
      actionClass: 'passive_collection',
      tool: 'whois_query',
      parameters: [{ name: 'kind', kind: 'enum', values: ['domain', 'ip'] }],
      targetPlaceholder: 'target',
      timeoutMs: 30_000,
      maxOutputBytes: 64 * 1024,
    },
    protocol: 'tcp',
    portSource: { kind: 'none' },
    carries: { kind: 'domain=查注册局 / ip=查分配机构与网段归属' },
    commandTemplate: 'whois_query target={target} kind={kind}',
  },
  {
    template: {
      id: 'recon_ct_subdomains',
      actionClass: 'passive_collection',
      tool: 'ct_lookup',
      parameters: [{ name: 'include_wildcards', kind: 'enum', values: ['false', 'true'] }],
      targetPlaceholder: 'target',
      timeoutMs: 60_000,
      maxOutputBytes: 256 * 1024,
    },
    protocol: 'tcp',
    portSource: { kind: 'none' },
    carries: { include_wildcards: '是否保留 `*.example.com` 形式的通配项（默认 false 会剥掉前缀）' },
    commandTemplate: 'ct_lookup target={target} include_wildcards={include_wildcards}',
  },
];

// ───────────────────────── 结构化核验模板族（漏洞分析，2026-10-06） ─────────────────────────

/**
 * 与侦察族同一套记账纪律（`active_probing`，四档预设全启用、不在逐次放行下限），
 * 差别在**动作语义**：这一族碰的是「疑似问题」，因此每条都必须**可判定且不可逆影响为零**——
 * 只发读取类请求、不写目标、配置面暴露只报「存在性 + 长度 + 哈希 + 形态判定」，从不回显内容。
 *
 * 为什么不把核验做成侦察模板的 `collect` 取值：两个阶段的**判据不同**（侦察记录事实，
 * 核验要给出"这条候选成不成立"的结论），拆开才能让 skill 与工具面对齐。
 */
const VULN_TEMPLATES: readonly ActionTemplateSpec[] = [
  {
    template: {
      id: 'vuln_http_check',
      actionClass: 'active_probing',
      tool: 'http_check',
      parameters: [
        { name: 'port', kind: 'integer', min: 1, max: 65535 },
        { name: 'scheme', kind: 'enum', values: ['http', 'https', 'auto'] },
        {
          name: 'check',
          kind: 'enum',
          values: ['tech_stack', 'security_headers', 'cookies', 'cors_policy', 'http_verbs', 'error_disclosure'],
        },
        { name: 'verify_tls', kind: 'enum', values: ['true', 'false'] },
      ],
      targetPlaceholder: 'target',
      timeoutMs: 60_000,
      maxOutputBytes: 256 * 1024,
    },
    protocol: 'tcp',
    portSource: { kind: 'param', param: 'port' },
    carries: {
      port: 'HTTP(S) 端口',
      scheme: 'auto 先试 https 再试 http',
      check:
        'tech_stack=技术栈推断 / security_headers=六个安全响应头有无 / cookies=Set-Cookie 的属性（Secure/HttpOnly/SameSite）' +
        ' / cors_policy=只发 Origin 头看回显（不带凭证） / http_verbs=OPTIONS 与 TRACE（**不试 PUT/DELETE**）' +
        ' / error_disclosure=随机不存在路径的响应是否泄露堆栈与路径',
      verify_tls: VERIFY_TLS_CARRY,
    },
    commandTemplate: 'http_check target={target} port={port} scheme={scheme} check={check} verify_tls={verify_tls}',
  },
  {
    template: {
      id: 'vuln_exposure_check',
      actionClass: 'active_probing',
      tool: 'exposure_check',
      parameters: [
        { name: 'port', kind: 'integer', min: 1, max: 65535 },
        { name: 'scheme', kind: 'enum', values: ['http', 'https'] },
        {
          name: 'paths',
          kind: 'string',
          pattern:
            '^(git|env|backup|swagger|openapi|actuator|server_status|phpinfo|web_config|dockerfile)' +
            '(,(git|env|backup|swagger|openapi|actuator|server_status|phpinfo|web_config|dockerfile)){0,9}$',
        },
        { name: 'verify_tls', kind: 'enum', values: ['true', 'false'] },
      ],
      targetPlaceholder: 'target',
      timeoutMs: 120_000,
      maxOutputBytes: 128 * 1024,
    },
    protocol: 'tcp',
    portSource: { kind: 'param', param: 'port' },
    carries: {
      port: 'HTTP(S) 端口',
      scheme: 'http / https',
      paths:
        '要探测的配置面暴露项（逗号分隔，最多 10 个）：git=.git/HEAD / env=.env / backup=backup.zip / swagger=swagger.json' +
        ' / openapi=openapi.json / actuator=actuator/health / server_status=server-status / phpinfo=phpinfo.php' +
        ' / web_config=web.config / dockerfile=Dockerfile。**只报存在性、长度、哈希与形态，不回显内容**',
      verify_tls: VERIFY_TLS_CARRY,
    },
    commandTemplate: 'exposure_check target={target} port={port} scheme={scheme} paths={paths} verify_tls={verify_tls}',
  },
  {
    template: {
      id: 'vuln_tls_weakness',
      actionClass: 'active_probing',
      tool: 'tls_probe',
      parameters: [
        { name: 'port', kind: 'integer', min: 1, max: 65535 },
        { name: 'sni', kind: 'string', pattern: '^(none|[A-Za-z0-9._-]{1,253})$' },
        // 取值域必须是 ['on']：核验**必须**枚举协议与套件——允许 off 等于允许一次"什么都没验证"的
        // 核验。technique 侧早已收窄（techniques.ts:117-119），模板此前漏跟；2026-10-07 的对拍锁
        // 就是为抓这一类漂移而加的（"提示词会被忽略，取值域不会"）。
        { name: 'enumerate_protocols', kind: 'enum', values: ['on'] },
      ],
      targetPlaceholder: 'target',
      timeoutMs: 60_000,
      maxOutputBytes: 128 * 1024,
    },
    protocol: 'tcp',
    portSource: { kind: 'param', param: 'port' },
    carries: {
      port: 'TLS 端口',
      sni: 'SNI 主机名；none 表示用目标名',
      enumerate_protocols: '核验时必须为 on（枚举 TLS1.2/1.3 与套件、证书有效期）',
    },
    commandTemplate: 'tls_probe target={target} port={port} sni={sni} enumerate_protocols={enumerate_protocols}',
  },
  {
    template: {
      id: 'vuln_nse_handshake',
      actionClass: 'active_probing',
      tool: 'nse_run',
      parameters: [
        { name: 'port', kind: 'integer', min: 1, max: 65535 },
        { name: 'scripts', kind: 'string', pattern: '^[a-z0-9-]+(,[a-z0-9-]+){0,7}$' },
      ],
      targetPlaceholder: 'target',
      timeoutMs: 180_000,
      maxOutputBytes: 256 * 1024,
    },
    protocol: 'tcp',
    portSource: { kind: 'param', param: 'port' },
    carries: {
      port: '服务端口',
      scripts:
        '协议级只读核验脚本（逗号分隔，≤8 个）：smtp-commands / ftp-anon / ssh-auth-methods / rdp-ntlm-info' +
        ' / ssl-enum-ciphers / http-methods / smb-os-discovery / smb-security-mode。白名单由沙箱侧强制，' +
        '*brute*/*dos*/exploit 类一律拒绝（匿名 FTP 只列目录，不取文件）',
    },
    commandTemplate: 'nse_run target={target} port={port} scripts={scripts}',
  },
];

const DEFAULT_TEMPLATE_SPECS: readonly ActionTemplateSpec[] = [DIRECT_COMMAND_SPEC, ...RECON_TEMPLATES, ...VULN_TEMPLATES];



/** 默认注册的示例模板（冻结后导出，扩展必须走人工注册）。 */
export const DEFAULT_TEMPLATES: readonly ActionTemplateSpec[] = Object.freeze(DEFAULT_TEMPLATE_SPECS);

/** 默认注册表（服务端受信配置）。 */
export function defaultRegistry(): TemplateRegistry {
  return createRegistry(DEFAULT_TEMPLATES);
}
