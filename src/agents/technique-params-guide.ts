/**
 * 结构化动作的参数说明文档（注入到沙箱简报的两条通道对比表之后）。
 *
 * 为什么需要这份文档：
 *   - sandbox-brief.ts 只说"优先用结构化通道"，但没说各个 technique 要什么参数
 *   - Agent 不知道 port_scan 的 scope 有哪些选项、http_probe 的 collect 能收集什么
 *   - 参数错误会被工具层拒绝，返回 nextAction 提示，但那是**事后补救**——
 *     提前在提示词里列清楚，Agent 第一次就能调对
 *
 * 与 techniques.ts 的关系：
 *   - techniques.ts 是**代码级规范**（服务端用它校验参数）
 *   - 本文件是**人读的说明**（Agent 用它规划调用）
 *   - 两者从同一份 STRUCTURED_TECHNIQUES 生成，保证同步
 */


/**
 * 参数的人读说明（比枚举值更详细的语义解释）。
 * 
 * @public 供外部消费者使用，用于参数验证和文档生成
 */
export interface ParamGuide {
  readonly name: string;
  readonly type: 'enum' | 'integer' | 'string' | 'port_list';
  readonly required: boolean;
  readonly description: string;
  readonly options?: readonly { readonly value: string; readonly note: string }[];
  readonly default?: string | number;
  readonly example?: string;
}

/**
 * 一个 technique 的完整参数指南。
 * 
 * @public 供外部消费者使用，用于生成交互式文档
 */
export interface TechniqueGuide {
  readonly technique: string;
  readonly purpose: string;
  readonly params: readonly ParamGuide[];
  readonly example: string;
}

// ═══════════════════════════════════════════════════════════════════════════
//                           侦察技巧参数指南
// ═══════════════════════════════════════════════════════════════════════════

const RECON_GUIDES: readonly TechniqueGuide[] = [
  {
    technique: 'port_scan',
    purpose: '端口扫描：确定目标开放哪些端口',
    params: [
      {
        name: 'scope',
        type: 'enum',
        required: false,
        default: 'top100',
        description: '扫描范围',
        options: [
          { value: 'top100', note: '最常见100个端口（默认，1-2秒/台）' },
          { value: 'top1000', note: '常见1000个端口（5-10秒/台）' },
          { value: 'common_services', note: '常见服务端口（HTTP/SSH/RDP/SQL等，约30个）' },
          { value: 'full_tcp', note: '全65535端口（5-10分钟/台，噪声高）' },
        ],
      },
      {
        name: 'ports',
        type: 'port_list',
        required: false,
        default: 'none',
        description: '自定义端口列表（如 "80,443,8080-8090"），设了就忽略 scope',
      },
      {
        name: 'ping',
        type: 'enum',
        required: false,
        default: 'skip',
        description: '主机发现方式',
        options: [
          { value: 'syn', note: 'SYN ping（快，需 NET_RAW，本沙箱可用）' },
          { value: 'connect', note: 'TCP connect（慢但通用）' },
          { value: 'skip', note: '跳过主机发现，直接扫端口（默认）' },
        ],
      },
    ],
    example: 'pentest_recon(technique="port_scan", targetSelector="192.168.1.0/24", scope="top100", purpose="...")',
  },
  {
    technique: 'service_probe',
    purpose: '服务指纹识别：确定开放端口上跑的是什么服务与版本',
    params: [
      {
        name: 'ports',
        type: 'port_list',
        required: true,
        description: '要探测的端口列表（如 "22,80,443"），通常来自 port_scan 结果',
        example: 'ports="80,443,8080"',
      },
      {
        name: 'intensity',
        type: 'enum',
        required: false,
        default: 'light',
        description: '探测强度',
        options: [
          { value: 'light', note: '轻量探测（默认，只读 banner）' },
          { value: 'normal', note: '常规探测（nmap -sV，会发多次请求）' },
        ],
      },
    ],
    example: 'pentest_recon(technique="service_probe", targetSelector="192.168.1.10", ports="22,80,443", intensity="light", purpose="...")',
  },
  {
    technique: 'http_probe',
    purpose: 'HTTP/Web 面探测：检查站点可达性、响应头、技术栈',
    params: [
      {
        name: 'port',
        type: 'integer',
        required: false,
        default: 80,
        description: '目标端口',
      },
      {
        name: 'scheme',
        type: 'enum',
        required: false,
        default: 'auto',
        description: '协议',
        options: [
          { value: 'http', note: '明文 HTTP' },
          { value: 'https', note: 'TLS 加密' },
          { value: 'auto', note: '自动探测（默认）' },
        ],
      },
      {
        name: 'collect',
        type: 'enum',
        required: false,
        default: 'headers',
        description: '收集内容',
        options: [
          { value: 'headers', note: '响应头（Server/Content-Type/Set-Cookie 等）' },
          { value: 'security_headers', note: '安全响应头（CSP/HSTS/X-Frame-Options 等6个）' },
          { value: 'robots', note: 'robots.txt 内容' },
          { value: 'sitemap', note: 'sitemap.xml 内容' },
          { value: 'tech', note: '技术栈推断（框架/语言/中间件）' },
        ],
      },
      {
        name: 'follow_redirects',
        type: 'integer',
        required: false,
        default: 0,
        description: '跟随重定向的次数上限（0=不跟随）',
      },
      {
        name: 'verify_tls',
        type: 'enum',
        required: false,
        default: 'true',
        description: '是否验证 TLS 证书（测试环境自签名证书可设 false）',
        options: [
          { value: 'true', note: '验证证书（默认）' },
          { value: 'false', note: '跳过验证' },
        ],
      },
    ],
    example: 'pentest_recon(technique="http_probe", targetSelector="192.168.1.10", port=443, scheme="https", collect="tech", purpose="...")',
  },
  {
    technique: 'content_discover',
    purpose: 'Web 内容发现：枚举目录/文件',
    params: [
      {
        name: 'port',
        type: 'integer',
        required: false,
        default: 80,
        description: '目标端口',
      },
      {
        name: 'scheme',
        type: 'enum',
        required: false,
        default: 'http',
        description: '协议（注意：这里没有 auto，必须明确）',
        options: [
          { value: 'http', note: '明文 HTTP' },
          { value: 'https', note: 'TLS 加密' },
        ],
      },
      {
        name: 'wordlist',
        type: 'enum',
        required: false,
        default: 'common_dirs',
        description: '字典选择',
        options: [
          { value: 'common_dirs', note: '通用目录/文件名（约4700条，默认）' },
          { value: 'raft_small', note: 'raft 小字典（纯目录，约20000条，需配 extensions）' },
        ],
      },
      {
        name: 'extensions',
        type: 'enum',
        required: false,
        default: 'none',
        description: '文件扩展名',
        options: [
          { value: 'none', note: '不加扩展名（默认）' },
          { value: 'php', note: '.php' },
          { value: 'asp', note: '.asp' },
          { value: 'aspx', note: '.aspx' },
          { value: 'jsp', note: '.jsp' },
          { value: 'html', note: '.html' },
          { value: 'txt', note: '.txt' },
          { value: 'json', note: '.json' },
          { value: 'multi', note: '多个常见扩展名（.php,.html,.txt,.bak）' },
        ],
      },
      {
        name: 'rate',
        type: 'integer',
        required: false,
        default: 5,
        description: '请求速率（次/秒），会被宿主行为预设的上限约束',
      },
      {
        name: 'verify_tls',
        type: 'enum',
        required: false,
        default: 'true',
        description: '是否验证 TLS 证书',
        options: [
          { value: 'true', note: '验证证书（默认）' },
          { value: 'false', note: '跳过验证' },
        ],
      },
    ],
    example: 'pentest_recon(technique="content_discover", targetSelector="192.168.1.10", scheme="https", wordlist="common_dirs", rate=5, purpose="...")',
  },
  {
    technique: 'dns_enum',
    purpose: 'DNS 记录枚举',
    params: [
      {
        name: 'record_types',
        type: 'string',
        required: false,
        default: 'A,AAAA,MX,NS,TXT',
        description: 'DNS 记录类型（逗号分隔）',
      },
      {
        name: 'resolver',
        type: 'enum',
        required: false,
        default: 'system',
        description: 'DNS 解析器',
        options: [
          { value: 'system', note: '宿主系统解析器（默认）' },
          { value: 'public', note: '公网解析器（8.8.8.8）' },
        ],
      },
    ],
    example: 'pentest_recon(technique="dns_enum", targetSelector="example.com", record_types="A,MX,TXT", purpose="...")',
  },
  {
    technique: 'tls_inspect',
    purpose: 'TLS/证书检查',
    params: [
      {
        name: 'port',
        type: 'integer',
        required: false,
        default: 443,
        description: '目标端口',
      },
      {
        name: 'sni',
        type: 'string',
        required: false,
        default: 'none',
        description: 'SNI 主机名（虚拟主机场景需要）',
      },
      {
        name: 'enumerate_protocols',
        type: 'enum',
        required: false,
        default: 'on',
        description: '枚举支持的 TLS 协议与套件',
        options: [
          { value: 'on', note: '枚举（默认）' },
          { value: 'off', note: '跳过枚举' },
        ],
      },
    ],
    example: 'pentest_recon(technique="tls_inspect", targetSelector="192.168.1.10", port=443, enumerate_protocols="on", purpose="...")',
  },
];

// ═══════════════════════════════════════════════════════════════════════════
//                           漏洞核验技巧参数指南
// ═══════════════════════════════════════════════════════════════════════════

const VULN_GUIDES: readonly TechniqueGuide[] = [
  {
    technique: 'http_check',
    purpose: 'HTTP 安全配置核验',
    params: [
      {
        name: 'port',
        type: 'integer',
        required: false,
        default: 80,
        description: '目标端口',
      },
      {
        name: 'scheme',
        type: 'enum',
        required: false,
        default: 'auto',
        description: '协议',
        options: [
          { value: 'http', note: '明文 HTTP' },
          { value: 'https', note: 'TLS 加密' },
          { value: 'auto', note: '自动探测（默认）' },
        ],
      },
      {
        name: 'check',
        type: 'enum',
        required: false,
        default: 'security_headers',
        description: '核验项',
        options: [
          { value: 'tech_stack', note: '技术栈版本（已知漏洞匹配）' },
          { value: 'security_headers', note: '安全响应头缺失（CSP/HSTS/X-Frame-Options/Strict-Transport-Security 等6个）' },
          { value: 'cookies', note: 'Cookie 属性（Secure/HttpOnly/SameSite）' },
          { value: 'cors_policy', note: 'CORS 配置弱点' },
          { value: 'http_verbs', note: 'HTTP 方法暴露面（OPTIONS/TRACE/PUT 等）' },
          { value: 'error_disclosure', note: '错误泄露（栈跟踪/版本信息）' },
        ],
      },
      {
        name: 'verify_tls',
        type: 'enum',
        required: false,
        default: 'true',
        description: '是否验证 TLS 证书',
        options: [
          { value: 'true', note: '验证证书（默认）' },
          { value: 'false', note: '跳过验证' },
        ],
      },
    ],
    example: 'pentest_vuln_check(technique="http_check", targetSelector="192.168.1.10", check="security_headers", purpose="...")',
  },
  {
    technique: 'exposure_check',
    purpose: '敏感路径暴露核验',
    params: [
      {
        name: 'port',
        type: 'integer',
        required: false,
        default: 80,
        description: '目标端口',
      },
      {
        name: 'scheme',
        type: 'enum',
        required: false,
        default: 'http',
        description: '协议',
        options: [
          { value: 'http', note: '明文 HTTP' },
          { value: 'https', note: 'TLS 加密' },
        ],
      },
      {
        name: 'paths',
        type: 'string',
        required: true,
        description: '路径列表（逗号分隔，如 "/.git/HEAD,/.env,/admin"）',
        example: 'paths="/.git/HEAD,/.env,/admin"',
      },
      {
        name: 'verify_tls',
        type: 'enum',
        required: false,
        default: 'true',
        description: '是否验证 TLS 证书',
        options: [
          { value: 'true', note: '验证证书（默认）' },
          { value: 'false', note: '跳过验证' },
        ],
      },
    ],
    example: 'pentest_vuln_check(technique="exposure_check", targetSelector="192.168.1.10", paths="/.git/HEAD,/.env", purpose="...")',
  },
  {
    technique: 'tls_weakness',
    purpose: 'TLS 弱点核验（协议/套件/密钥强度）',
    params: [
      {
        name: 'port',
        type: 'integer',
        required: false,
        default: 443,
        description: '目标端口',
      },
      {
        name: 'sni',
        type: 'string',
        required: false,
        default: 'none',
        description: 'SNI 主机名',
      },
      {
        name: 'enumerate_protocols',
        type: 'enum',
        required: false,
        default: 'on',
        description: '枚举协议与套件（核验时必须开启）',
        options: [
          { value: 'on', note: '枚举（默认且强制）' },
        ],
      },
    ],
    example: 'pentest_vuln_check(technique="tls_weakness", targetSelector="192.168.1.10", port=443, purpose="...")',
  },
];

// ═══════════════════════════════════════════════════════════════════════════
//                           渲染函数
// ═══════════════════════════════════════════════════════════════════════════

/** 渲染单个 technique 的参数表（Markdown 表格）。 */
function renderTechniqueGuide(guide: TechniqueGuide): string {
  const lines = [`**${guide.technique}**：${guide.purpose}`, ''];

  if (guide.params.length === 0) {
    lines.push('（无参数）');
  } else {
    lines.push('| 参数 | 类型 | 必填 | 默认值 | 说明 |');
    lines.push('|---|---|---|---|---|');
    for (const param of guide.params) {
      const req = param.required ? '✓' : '';
      const def = param.default !== undefined ? String(param.default) : '—';
      let desc = param.description;
      if (param.options !== undefined) {
        const opts = param.options.map((o) => `\`${o.value}\`=${o.note}`).join('、');
        desc += `。可选：${opts}`;
      }
      if (param.example !== undefined) {
        desc += `。示例：${param.example}`;
      }
      lines.push(`| \`${param.name}\` | ${param.type} | ${req} | ${def} | ${desc} |`);
    }
  }

  lines.push('');
  lines.push(`示例：\`${guide.example}\``);
  lines.push('');
  return lines.join('\n');
}

/** 渲染结构化动作参数指南（注入到沙箱简报的两条通道对比表之后）。 */
export function renderTechniqueParamsGuide(): string {
  const sections = [
    '═══ 结构化侦察动作参数指南 ═══',
    '',
    '以下是 `pentest_recon` 工具各个 technique 的参数说明。',
    '优先用结构化通道：参数少、免手写命令、①②③阶段免批。',
    '',
    ...RECON_GUIDES.map(renderTechniqueGuide),
    '',
    '═══ 结构化漏洞核验动作参数指南 ═══',
    '',
    '以下是 `pentest_vuln_check` 工具各个 technique 的参数说明。',
    '',
    ...VULN_GUIDES.map(renderTechniqueGuide),
  ];

  return sections.join('\n');
}
