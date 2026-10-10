/**
 * 参数 DSL：结构化动作参数的**单一源头**。
 *
 * 设计原则：
 * - 一份定义，多处消费（工具 schema + techniques + 模板参数）
 * - 类型检查天然可得（TypeScript DSL，不写 JSON）
 * - 不增加运行时开销（编译期生成）
 *
 * 用法示例：
 *   const http_probe_params = {
 *     port: { type: 'integer', minimum: 1, maximum: 65535, default: 80 },
 *     scheme: { type: 'enum', values: ['http', 'https', 'auto'], default: 'auto' },
 *     verify_tls: { type: 'boolean', default: true },
 *   } as const satisfies ParamSpec;
 */

/**
 * 参数规范：单个参数的完整声明。
 */
export type ParamDef =
  | {
      readonly type: 'string';
      readonly description?: string;
      readonly default?: string;
      readonly pattern?: string;
    }
  | {
      readonly type: 'integer';
      readonly description?: string;
      readonly default?: number;
      readonly minimum?: number;
      readonly maximum?: number;
    }
  | {
      readonly type: 'enum';
      readonly values: readonly string[];
      readonly description?: string;
      readonly default?: string;
    }
  | {
      readonly type: 'boolean';
      readonly description?: string;
      readonly default?: boolean;
    };

/**
 * 参数集合：记录参数名→定义的映射。
 */
export type ParamSpec = Readonly<Record<string, ParamDef>>;

/**
 * 工具 schema 参数对象的类型：dsh 支持的参数定义。
 */
export interface ToolSchemaParam {
  readonly type: 'string' | 'integer' | 'boolean';
  readonly required?: boolean;
  readonly description?: string;
  readonly enum?: readonly string[];
  readonly pattern?: string;
  readonly minimum?: number;
  readonly maximum?: number;
}

export type ToolSchema = Readonly<Record<string, ToolSchemaParam>>;

/**
 * 从 ParamSpec 导出 defaults 和 required：
 * - default 字段存在 → 放入 defaults
 * - default 不存在 → 放入 required
 */
export function extractDefaults(spec: ParamSpec): { defaults: Record<string, string | number | boolean>; required: string[] } {
  const defaults: Record<string, string | number | boolean> = {};
  const required: string[] = [];

  for (const [name, def] of Object.entries(spec)) {
    if ('default' in def && def.default !== undefined) {
      defaults[name] = def.default;
    } else {
      required.push(name);
    }
  }

  return { defaults, required };
}

/**
 * 从 ParamSpec 导出 enums：
 * 只抽取 type: 'enum' 的参数。
 */
export function extractEnums(spec: ParamSpec): Record<string, readonly string[]> {
  const enums: Record<string, readonly string[]> = {};

  for (const [name, def] of Object.entries(spec)) {
    if (def.type === 'enum') {
      enums[name] = def.values;
    }
  }

  return enums;
}

/**
 * 从 ParamSpec 导出工具 schema（dsh tool 的参数对象）：
 * 转换为 dsh 的 ParameterPropertySpec 格式。
 */
export function generateToolSchema(spec: ParamSpec): ToolSchema {
  const schema: Record<string, ToolSchemaParam> = {};

  for (const [name, def] of Object.entries(spec)) {
    const required = !('default' in def) || def.default === undefined;

    if (def.type === 'string') {
      const stringParam: ToolSchemaParam = {
        type: 'string',
        required,
        description: def.description,
        ...(def.pattern && { pattern: def.pattern }),
      };
      schema[name] = stringParam;
    } else if (def.type === 'integer') {
      const intParam: ToolSchemaParam = {
        type: 'integer',
        required,
        description: def.description,
        ...(def.minimum !== undefined && { minimum: def.minimum }),
        ...(def.maximum !== undefined && { maximum: def.maximum }),
      };
      schema[name] = intParam;
    } else if (def.type === 'enum') {
      schema[name] = {
        type: 'string',
        required,
        enum: def.values,
        description: def.description,
      };
    } else if (def.type === 'boolean') {
      // dsh 不支持 boolean，改成 enum: ['true', 'false']
      schema[name] = {
        type: 'string',
        required,
        enum: ['true', 'false'],
        description: (def.description || '') + ' (true/false)',
      };
    }
  }

  return schema;
}

/**
 * 所有侦察 technique 的参数规范。
 * 用法：`const port_scan_params = RECON_PARAM_SPECS.port_scan;`
 */
export const RECON_PARAM_SPECS = Object.freeze({
  port_scan: {
    scope: {
      type: 'enum' as const,
      values: ['top100', 'top1000', 'common_services', 'full_tcp'],
      description: '扫描范围（top100 / top1000 / common_services / full_tcp）',
      default: 'top100',
    },
    ports: {
      type: 'string' as const,
      description: '端口列表或范围（如 80,443,3000-3010 或 none）',
      default: 'none',
    },
    ping: {
      type: 'enum' as const,
      values: ['syn', 'connect', 'skip'],
      description: '主机发现方式',
      default: 'skip',
    },
  } as const satisfies ParamSpec,

  service_probe: {
    intensity: {
      type: 'enum' as const,
      values: ['light', 'normal'],
      description: '探测强度',
      default: 'light',
    },
    ports: {
      type: 'string' as const,
      description: '目标端口（必填）',
    },
  } as const satisfies ParamSpec,

  nse_safe: {
    scripts: {
      type: 'string' as const,
      description: 'NSE 脚本列表（逗号分隔）',
      default: 'http-title,http-headers',
    },
    port: {
      type: 'integer' as const,
      description: '目标端口（必填）',
      minimum: 1,
      maximum: 65535,
    },
  } as const satisfies ParamSpec,

  tls_inspect: {
    port: {
      type: 'integer' as const,
      description: 'TLS 端口',
      default: 443,
      minimum: 1,
      maximum: 65535,
    },
    sni: {
      type: 'string' as const,
      description: 'Server Name Indication（none 表示不设）',
      default: 'none',
    },
    enumerate_protocols: {
      type: 'enum' as const,
      values: ['on', 'off'],
      description: '枚举支持的协议版本',
      default: 'on',
    },
  } as const satisfies ParamSpec,

  http_probe: {
    port: {
      type: 'integer' as const,
      description: '目标端口',
      default: 80,
      minimum: 1,
      maximum: 65535,
    },
    scheme: {
      type: 'enum' as const,
      values: ['http', 'https', 'auto'],
      description: '协议方案',
      default: 'auto',
    },
    follow_redirects: {
      type: 'integer' as const,
      description: '跟随重定向的深度（0 表示不跟随）',
      default: 0,
      minimum: 0,
      maximum: 10,
    },
    collect: {
      type: 'enum' as const,
      values: ['headers', 'security_headers', 'robots', 'sitemap', 'tech'],
      description: '采集内容类型',
      default: 'headers',
    },
    verify_tls: {
      type: 'enum' as const,
      values: ['true', 'false'],
      description: '校验 TLS 证书',
      default: 'true',
    },
  } as const satisfies ParamSpec,

  content_discover: {
    port: {
      type: 'integer' as const,
      description: '目标端口',
      default: 80,
      minimum: 1,
      maximum: 65535,
    },
    scheme: {
      type: 'enum' as const,
      values: ['http', 'https'],
      description: '协议方案（必须明确，不能自动检测）',
    },
    wordlist: {
      type: 'enum' as const,
      values: ['common_dirs', 'raft_small'],
      description: '字典选择',
      default: 'common_dirs',
    },
    extensions: {
      type: 'string' as const,
      description: '文件扩展名（none 或逗号分隔列表）',
      default: 'none',
    },
    rate: {
      type: 'integer' as const,
      description: '并发请求数',
      default: 5,
      minimum: 1,
      maximum: 50,
    },
    verify_tls: {
      type: 'enum' as const,
      values: ['true', 'false'],
      description: '校验 TLS 证书',
      default: 'true',
    },
  } as const satisfies ParamSpec,

  web_crawl: {
    port: {
      type: 'integer' as const,
      description: '目标端口',
      default: 80,
      minimum: 1,
      maximum: 65535,
    },
    scheme: {
      type: 'enum' as const,
      values: ['http', 'https'],
      description: '协议方案',
      default: 'http',
    },
    depth: {
      type: 'integer' as const,
      description: '爬取深度',
      default: 2,
      minimum: 1,
      maximum: 5,
    },
    max_pages: {
      type: 'integer' as const,
      description: '最多页面数',
      default: 100,
      minimum: 10,
      maximum: 1000,
    },
    verify_tls: {
      type: 'enum' as const,
      values: ['true', 'false'],
      description: '校验 TLS 证书',
      default: 'true',
    },
  } as const satisfies ParamSpec,

  dns_enum: {
    record_types: {
      type: 'string' as const,
      description: 'DNS 记录类型（逗号分隔）',
      default: 'A,AAAA,MX,NS,TXT',
    },
    resolver: {
      type: 'enum' as const,
      values: ['system', 'public'],
      description: '使用的 DNS 服务器',
      default: 'system',
    },
  } as const satisfies ParamSpec,

  web_analytics: {
    port: {
      type: 'integer' as const,
      description: '目标端口',
      default: 80,
      minimum: 1,
      maximum: 65535,
    },
  } as const satisfies ParamSpec,

  ad_user_enum: {
    // AD 用户枚举参数（待完整定义）
  } as const satisfies ParamSpec,

  api_discovery: {
    port: {
      type: 'integer' as const,
      description: '目标端口',
      default: 80,
      minimum: 1,
      maximum: 65535,
    },
  } as const satisfies ParamSpec,

  cloud_enum: {
    // 云资产枚举参数
  } as const satisfies ParamSpec,

  cdn_enum: {
    // CDN 枚举参数
  } as const satisfies ParamSpec,

  domain_trust_enum: {
    // 域信任枚举参数
  } as const satisfies ParamSpec,

  cert_enum: {
    // 证书枚举参数
  } as const satisfies ParamSpec,
} as const);

/**
 * 所有漏洞分析 technique 的参数规范。
 */
export const VULN_PARAM_SPECS = Object.freeze({
  port_state_check: {
    port: {
      type: 'integer' as const,
      description: '目标端口',
      minimum: 1,
      maximum: 65535,
    },
  } as const satisfies ParamSpec,

  exposure_check: {
    port: {
      type: 'integer' as const,
      description: '目标端口',
      default: 80,
      minimum: 1,
      maximum: 65535,
    },
    risk_threshold: {
      type: 'string' as const,
      description: '风险阈值（high/medium/low）',
      default: 'high',
    },
  } as const satisfies ParamSpec,

  credential_check: {
    // 凭证检查参数
  } as const satisfies ParamSpec,

  cve_scan: {
    // CVE 扫描参数
  } as const satisfies ParamSpec,
} as const);

/**
 * 生成 STRUCTURED_TECHNIQUES 兼容的输出：
 * 从 DSL 自动生成 defaults/required/enums。
 */
export function generateStructuredTechniques(): {
  recon: Record<string, { defaults: Record<string, string | number | boolean>; required: string[]; enums?: Record<string, readonly string[]> }>;
  vuln: Record<string, { defaults: Record<string, string | number | boolean>; required: string[]; enums?: Record<string, readonly string[]> }>;
} {
  const recon: Record<string, { defaults: Record<string, string | number | boolean>; required: string[]; enums?: Record<string, readonly string[]> }> = {};
  for (const [technique, spec] of Object.entries(RECON_PARAM_SPECS)) {
    const { defaults, required } = extractDefaults(spec as ParamSpec);
    const enums = extractEnums(spec as ParamSpec);
    recon[technique] = {
      defaults,
      required,
      ...(Object.keys(enums).length > 0 && { enums }),
    };
  }

  const vuln: Record<string, { defaults: Record<string, string | number | boolean>; required: string[]; enums?: Record<string, readonly string[]> }> = {};
  for (const [technique, spec] of Object.entries(VULN_PARAM_SPECS)) {
    const { defaults, required } = extractDefaults(spec as ParamSpec);
    const enums = extractEnums(spec as ParamSpec);
    vuln[technique] = {
      defaults,
      required,
      ...(Object.keys(enums).length > 0 && { enums }),
    };
  }

  return { recon, vuln };
}
