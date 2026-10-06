/**
 * 结构化动作的**技巧表**（侦察 + 核验）：`technique` → 模板 id + 参数。
 *
 * 为什么单独成模块：三处消费者读同一份表，谁都不该自己抄一遍——
 *   1. 工具（`tools/worker.ts` 的 `pentest_recon` / `pentest_scan` 用它翻译入参）；
 *   2. 会话提示词（`agents/sandbox-brief.ts` 用它列出「有哪些动作、各自要什么参数」）；
 *   3. 测试（技巧↔模板双向可达、必填与取值域）。
 *
 * 依赖方向也更好看：agents → execution/techniques（纯数据 + 一个纯函数），
 * 不必为了渲染提示词去 import 一整个 defineTool 模块。
 */

import type { ErrorCode } from '../contracts.ts';

/**
 * 结构化侦察动作表：`technique` → 模板 id + 该模板**声明过的**参数（含安全默认值）。
 *
 * ── 为什么需要这张表 ──
 *
 * 模板声明的参数即必填、多一个少一个都被拒。让模型自己凑参数集合，它会猜错名字
 * （历史事故：猜错九个工具名，白烧一轮）；这张表把「人话 technique → 服务端模板」的翻译
 * 固定下来，模型只提供它真正知道的量（端口、档位）。`templateId` 一律是 `recon_<technique>`——
 * 与 `src/execution/templates.ts` 的 RECON_TEMPLATES 逐字对应，测试断言两边不漂移。
 *
 * `defaults` 是「没给就用它」；`required` 是「没有安全默认值、必须显式给」。
 */
export interface ReconTechniqueSpec {
  /** 模板声明过的参数 → 默认值（不含 required 的那些）。 */
  readonly defaults: Readonly<Record<string, string | number>>;
  /** 必须由模型显式提供的模板参数名（该参数没有安全默认值）。 */
  readonly required: readonly string[];
  /** 该 technique 下这些参数的取值域（用来把错误提前到工具层，给出更准的提示）。 */
  readonly enums?: Readonly<Record<string, readonly string[]>>;
}
export const RECON_TECHNIQUES: Readonly<Record<string, ReconTechniqueSpec>> = Object.freeze({
  port_scan: {
    defaults: { scope: 'top100', ports: 'none', ping: 'skip' },
    required: [],
    enums: { scope: ['top100', 'top1000', 'common_services', 'full_tcp'], ping: ['syn', 'connect', 'skip'] },
  },
  service_probe: {
    defaults: { intensity: 'light' },
    required: ['ports'],
    enums: { intensity: ['light', 'normal'] },
  },
  nse_safe: {
    defaults: { scripts: 'http-title,http-headers' },
    required: ['port'],
  },
  tls_inspect: {
    defaults: { port: 443, sni: 'none', enumerate_protocols: 'on' },
    required: [],
    enums: { enumerate_protocols: ['on', 'off'] },
  },
  http_probe: {
    defaults: { port: 80, scheme: 'auto', follow_redirects: 0, collect: 'headers' },
    required: [],
    enums: { scheme: ['http', 'https', 'auto'], collect: ['headers', 'security_headers', 'robots', 'sitemap', 'tech'] },
  },
  content_discover: {
    defaults: { port: 80, scheme: 'http', wordlist: 'common_dirs', extensions: 'none', rate: 5 },
    required: [],
    enums: {
      // 注意：这里**没有** `auto`——内容发现必须先知道协议，猜协议会让整轮结果失真。
      scheme: ['http', 'https'],
      wordlist: ['common_dirs', 'raft_small'],
      extensions: ['none', 'php', 'asp', 'aspx', 'jsp', 'html', 'txt', 'json', 'multi'],
    },
  },
  web_crawl: {
    defaults: { port: 80, scheme: 'http', depth: 2, max_pages: 100 },
    required: [],
    enums: { scheme: ['http', 'https'] },
  },
  dns_enum: {
    defaults: { record_types: 'A,AAAA,MX,NS,TXT', resolver: 'system' },
    required: [],
    enums: { resolver: ['system', 'public'] },
  },
  dns_axfr: { defaults: {}, required: [] },
  dns_brute: {
    defaults: { wordlist: 'subdomains_5k', concurrency: 10, wildcard_check: 'on' },
    required: [],
    enums: { wordlist: ['subdomains_5k'], wildcard_check: ['on', 'off'] },
  },
  whois: { defaults: { kind: 'domain' }, required: [], enums: { kind: ['domain', 'ip'] } },
  ct_subdomains: { defaults: { include_wildcards: 'false' }, required: [], enums: { include_wildcards: ['false', 'true'] } },
});

/**
 * 漏洞分析的核验动作表（与 `VULN_TEMPLATES` 逐字对应，`templateId = vuln_<technique>`）。
 *
 * 与侦察族的差别只在**动作语义**：这里每条都是「验证一条候选」，不是「记录一个事实」。
 */
export const VULN_TECHNIQUES: Readonly<Record<string, ReconTechniqueSpec>> = Object.freeze({
  http_check: {
    defaults: { port: 80, scheme: 'auto', check: 'security_headers' },
    required: [],
    enums: {
      scheme: ['http', 'https', 'auto'],
      check: ['tech_stack', 'security_headers', 'cookies', 'cors_policy', 'http_verbs', 'error_disclosure'],
    },
  },
  exposure_check: {
    defaults: { port: 80, scheme: 'http' },
    required: ['paths'],
    enums: { scheme: ['http', 'https'] },
  },
  tls_weakness: {
    defaults: { port: 443, sni: 'none', enumerate_protocols: 'on' },
    required: [],
    // 核验**必须**枚举协议与套件：允许 off 等于允许一次"什么都没验证"的核验。
    // 取值域在这里收窄，而不是只写在工具描述里（提示词会被忽略，取值域不会）。
    enums: { enumerate_protocols: ['on'] },
  },
  nse_handshake: {
    defaults: { scripts: 'http-methods' },
    required: ['port'],
  },
});

/** 结构化动作的两个族：`templateId = <family>_<technique>`（族与模板前缀同一份来源）。 */
export type StructuredFamily = 'recon' | 'vuln';

export const STRUCTURED_TECHNIQUES: Readonly<
  Record<StructuredFamily, Readonly<Record<string, ReconTechniqueSpec>>>
> = Object.freeze({ recon: RECON_TECHNIQUES, vuln: VULN_TECHNIQUES });

/** 工具入参（camelCase）→ 模板参数（snake_case）。只列两者写法不同的那些。 */
const RECON_INPUT_ALIASES: Readonly<Record<string, string>> = Object.freeze({
  enumerateProtocols: 'enumerate_protocols',
  followRedirects: 'follow_redirects',
  maxPages: 'max_pages',
  recordTypes: 'record_types',
  wildcardCheck: 'wildcard_check',
  includeWildcards: 'include_wildcards',
});

export interface ReconIntentInput {
  readonly technique: string;
  readonly targetSelector: string;
  readonly purpose: string;
  readonly [input: string]: string | number | undefined;
}

export type ReconIntentOutcome =
  | { readonly ok: true; readonly templateId: string; readonly params: Readonly<Record<string, string | number>> }
  | { readonly ok: false; readonly code: ErrorCode; readonly message: string; readonly nextAction: string };

/**
 * 把「人话 technique + 少量参数」翻译成模板实例。**纯函数**：工具与测试共用同一份映射。
 *
 * 拒绝的三种情形都给出**可执行的下一步**（模型据 next_action 修正，而不是反复试探）：
 * 未知 technique、给了该 technique 不接受的参数、缺了必填参数。
 */
export function buildStructuredIntent(family: StructuredFamily, input: ReconIntentInput): ReconIntentOutcome {
  const table = STRUCTURED_TECHNIQUES[family];
  const spec = table[input.technique];
  if (spec === undefined) {
    return {
      ok: false,
      code: 'classification_rejected',
      message: `未知的 ${family} 动作 technique=${input.technique}`,
      nextAction: `改用其中之一：${Object.keys(table).join('、')}（各自的参数见对应的 skill）`,
    };
  }
  const allowed = new Set([...Object.keys(spec.defaults), ...spec.required]);
  const params: Record<string, string | number> = { ...spec.defaults };
  for (const [key, value] of Object.entries(input)) {
    if (key === 'technique' || key === 'targetSelector' || key === 'purpose') continue;
    if (value === undefined) continue;
    const paramName = RECON_INPUT_ALIASES[key] ?? key;
    if (!allowed.has(paramName)) {
      return {
        ok: false,
        code: 'classification_rejected',
        message: `${family} 的 technique=${input.technique} 不接受参数 ${key}`,
        nextAction: `本动作只接受：${[...allowed].join('、')}`,
      };
    }
    const domain = spec.enums?.[paramName];
    if (domain !== undefined && !domain.includes(String(value))) {
      return {
        ok: false,
        code: 'classification_rejected',
        message: `${family} 的 technique=${input.technique} 参数 ${key} 取值不在允许集合内：${String(value)}`,
        nextAction: `只允许：${domain.join('、')}`,
      };
    }
    params[paramName] = value;
  }
  const missing = spec.required.filter((name) => params[name] === undefined);
  if (missing.length > 0) {
    return {
      ok: false,
      code: 'classification_rejected',
      message: `${family} 的 technique=${input.technique} 缺少必填参数：${missing.join('、')}`,
      nextAction: `补上这些参数再调用：${missing.join('、')}`,
    };
  }
  return { ok: true, templateId: `${family}_${input.technique}`, params };
}
