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
export type ParamValue = string | number;
export type ParamBag = Readonly<Record<string, ParamValue>>;

export type TemplateValidation =
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
export type PortSource =
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

export interface ForbiddenPayloadRule {
  readonly id: string;
  readonly detail: string;
  readonly test: RegExp;
}

/**
 * §10.2.1「解释器与外部模板受限」：这些形态一律拒绝，不区分「看起来是否有害」。
 * 规则作用于 **string 类型参数**（enum / integer 由取值范围保证，不受此影响）。
 */
export const FORBIDDEN_PAYLOAD_RULES: readonly ForbiddenPayloadRule[] = Object.freeze([
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
    actionClass: 'exploit_validation',
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
      '要执行的命令（UTF-8 原文的 base64）；沙箱内以 /bin/sh -c 运行（容器内 root，' +
      '能力只有 NET_RAW，可写根；能连到的主机由沙箱所在网络与宿主路由决定——本部署可出网）',
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
const DEFAULT_TEMPLATE_SPECS: readonly ActionTemplateSpec[] = [DIRECT_COMMAND_SPEC];



/** 默认注册的示例模板（冻结后导出，扩展必须走人工注册）。 */
export const DEFAULT_TEMPLATES: readonly ActionTemplateSpec[] = Object.freeze(DEFAULT_TEMPLATE_SPECS);

/** 默认注册表（服务端受信配置）。 */
export function defaultRegistry(): TemplateRegistry {
  return createRegistry(DEFAULT_TEMPLATES);
}
