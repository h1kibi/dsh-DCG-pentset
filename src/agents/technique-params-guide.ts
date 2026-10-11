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


import { defaultRegistry } from '../execution/templates.ts';

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
  /** 怎么读这条动作的输出（判据）。缺省表示判据已写在 purpose/params 里。 */
  readonly judgement?: string;
  readonly example: string;
}

/**
 * 模板注册表：**超时上限的唯一来源**。
 *
 * 规范 §7：渲染给模型的"数字型事实"必须从唯一来源渲染，手写第二份即视为缺陷
 * （2026-10-11 质检 §三 3.2 第 14 条就是手写副本漂移：技能按 900s 估规模，而自由命令真限 300s）。
 * 这里按 `templateId = <family>_<technique>` 反查 `timeoutMs`，指南里的每个数字都由它渲染。
 */
const TEMPLATE_REGISTRY = defaultRegistry();

/** 该 technique 的模板墙钟上限（秒）；注册表里没有就不渲染这一行（不猜）。 */
function templateTimeoutSeconds(family: 'recon' | 'vuln', technique: string): number | undefined {
  const spec = TEMPLATE_REGISTRY.get(`${family}_${technique}`);
  return spec === undefined ? undefined : Math.round(spec.template.timeoutMs / 1000);
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
        description: '**主机存活判定**（不是扫描类型）',
        options: [
          { value: 'syn', note: '先做 SYN 主机发现（-PS 探 80）。目标丢弃探针时会被判 down ⇒ **一个端口都不扫**，报告里是 `state=down` + `open_ports=0` ——那是漏报形态，不是"全关"' },
          { value: 'connect', note: 'TCP connect 扫描（-sT -Pn）' },
          { value: 'skip', note: '跳过存活判定直接扫（-Pn，默认，最不容易漏）' },
        ],
      },
      {
        name: 'restrict_to_scope',
        type: 'enum',
        required: false,
        default: 'false',
        description:
          '**交集扫描**。三条路先分清：① 只给 `ports=<授权端口>` ⇒ 就扫这几个端口（`scope` 被忽略），**不需要本开关**；② 只给档位 ⇒ 范围只授权一部分时会被闸门拒；③ 本开关 + **同时给 `ports`** ⇒ 扫「档位 ∩ 授权集合」并回报 `used_ports`。空交集：`scope_intersection: empty` + `scanned=false`（不是"0 开放"）',
        options: [
          { value: 'true', note: '算 top-N ∩ ports（nmap-services 频率列，与 nmap 自身取舍逐位一致）' },
          { value: 'false', note: '不交集（默认）；显式 ports 会**整个取代**档位' },
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
    technique: 'nse_safe',
    purpose: '只读 NSE 脚本扫描：拿服务 banner、认证方式、证书这类**服务级**事实',
    params: [
      {
        name: 'port',
        type: 'integer',
        required: true,
        description: '脚本针对的端口（先从 `port_scan` 拿到开放端口，再对它跑脚本）',
      },
      {
        name: 'scripts',
        type: 'string',
        required: false,
        default: 'http-title,http-headers',
        description:
          '只读脚本名（逗号分隔，**最多 8 个**）。白名单由沙箱侧强制：`*brute*`/`*dos*`/exploit 类一律拒绝。可用的有 banner、http-title、http-headers、http-methods、http-security-headers、http-server-header、ssl-cert、ssl-enum-ciphers、smb-os-discovery、smb-security-mode、smb2-security-mode、ftp-anon、ssh-auth-methods、rdp-ntlm-info、smtp-commands',
        example: 'scripts="ftp-anon,ssh-auth-methods"',
      },
    ],
    judgement:
      '命中会输出 `script: <脚本名>` + `output:` 块。**没有 `script:` 行 = 这些脚本在该端口没有可报告的结论**，不是"端口没开"（端口状态看 `port_scan`）。示例：`ftp-anon` 打出 `Anonymous FTP login allowed` 才算可读匿名 FTP。',
    example: 'pentest_recon(technique="nse_safe", targetSelector="192.168.1.10", port=21, scripts="ftp-anon", purpose="...")',
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
          { value: 'endpoints', note: '**端点/路由抽取**：固定三种形态（href/src/action、引号内绝对路径、fetch/axios 第一实参），短行带 hits；空结果会明说「不等于页面里没有端点」——手写 grep 抽路由失败是静默的' },
        ],
      },
      {
        name: 'include_chunks',
        type: 'enum',
        required: false,
        default: 'true',
        description:
          '**endpoints 专用**：是否跟随同主机的 `.js` 引用（`/_next/static/chunks/*`）再抽一遍。SPA 的路由**常常只在 chunk 里**，建议保持默认 true',
        options: [
          { value: 'true', note: '跟随（默认）：只跟同主机，≤8 条 / 每条 256KiB；命中标出 `@<chunk 路径>`' },
          { value: 'false', note: '只看本页字节（页面很重或只想看首屏时用）' },
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
        description:
          '是否验证 TLS 证书：**能用默认就用默认**（证书有效时默认就能通，IP 目标也一样）；只有**校验真的失败**（自签/链不全/SAN 不匹配）才设 false',
        options: [
          { value: 'true', note: '验证证书（默认；证书有效时就用它）' },
          { value: 'false', note: '跳过验证（校验失败时才用；此后该次结果不再证明证书链可信）' },
        ],
      },
      {
        name: 'paths',
        type: 'string',
        required: false,
        default: '（空串＝关闭）',
        description:
          '**批量路径状态复核**（操作者诉求 #3）：逗号分隔的**绝对路径**，≤60 条，每条形如 `/api/users`。给了它只对每条发 **GET**，逐条回 `path<TAB>status<TAB>size<TAB>content_type<TAB>note` ＋ 汇总 `paths=N ok=M no_response=K`；并先用一条**随机路径**取软 404 基准，同状态码同长度即标 `soft404`（兜底路由，不是端点）。**拒绝**含 scheme/主机/空格的串（把路径当目标用会让范围记账失效）。**发现**用 `collect=endpoints`，**复核**才用它',
        example: 'paths="/api/users,/api/orders,/admin/config"',
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
          { value: 'api_endpoints', note: 'API 路由命名（268条，条目自带 api/ 前缀，在站点根用）' },
          { value: 'quickhits', note: '高价值小文件（备份/配置/密钥等常见命名）' },
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
        description:
          '是否验证 TLS 证书：**能用默认就用默认**（证书有效时默认就能通，IP 目标也一样）；只有**校验真的失败**（自签/链不全/SAN 不匹配）才设 false',
        options: [
          { value: 'true', note: '验证证书（默认；证书有效时就用它）' },
          { value: 'false', note: '跳过验证（校验失败时才用；此后该次结果不再证明证书链可信）' },
        ],
      },
      {
        name: 'path',
        type: 'string',
        required: false,
        default: '',
        description:
          '基准路径前缀（空串 = 站点根；如 `api` 或 `v1/api`，两侧斜杠会归一）。在 /api/ 这类子路径下枚举时**必须**给，否则只打根路径；不得含 `..` 段或查询串',
        example: 'path="api"',
      },
      {
        name: 'entry_range',
        type: 'string',
        required: false,
        default: '（空串＝整本字典）',
        description:
          '**字典分段**（操作者诉求 #4）：`A-B`，1 基双闭区间，如 `1-2000`。大字典在**单条命令的墙钟内跑不完**（`common_dirs` 4723 条按 5 请求/秒需 ~945s，超过本动作的墙钟上限——上限由模板注册表渲染在上面的标题行，不在这里手抄）——用 `1-2000` / `2001-4000` … 多次调用拼完。每次返回都自证：`coverage: wordlist_entries=… entries_total=… entry_range=A-B requested=… entries_attempted=… entries_truncated=… entries_remaining=… position=… reason=completed|host_timeout`（另有一行 `coverage_hit_span: position_max_hit=… hits=…`），并在超可调度量时直接写「需要分 N 段」（这是数学，不是判断）',
        example: 'entry_range="1-2000"',
      },
    ],
    example: 'pentest_recon(technique="content_discover", targetSelector="192.168.1.10", scheme="https", wordlist="common_dirs", rate=5, path="api", purpose="...")',
  },
  {
    technique: 'web_crawl',
    purpose: '爬取站点：按链接逐页走，抽出页面、表单与查询参数（比字典枚举更"跟着站点的形状走"）',
    params: [
      {
        name: 'port',
        type: 'integer',
        required: false,
        default: 80,
        description: '目标 Web 端口',
      },
      {
        name: 'scheme',
        type: 'enum',
        required: false,
        default: 'http',
        description: '协议（这里没有 auto，必须明确）',
        options: [
          { value: 'http', note: '明文 HTTP' },
          { value: 'https', note: 'TLS 加密' },
        ],
      },
      {
        name: 'depth',
        type: 'integer',
        required: false,
        default: 2,
        description: '爬取深度（1-3）；从 `/` 起算，只跟**同主机**链接',
      },
      {
        name: 'max_pages',
        type: 'integer',
        required: false,
        default: 100,
        description: '页数硬上限（1-500）；单页最多读 512KiB',
      },
      {
        name: 'verify_tls',
        type: 'enum',
        required: false,
        default: 'true',
        description:
          '是否验证 TLS 证书：**能用默认就用默认**（证书有效时默认就能通，IP 目标也一样）；只有**校验真的失败**（自签/链不全/SAN 不匹配）才设 false',
        options: [
          { value: 'true', note: '验证证书（默认）' },
          { value: 'false', note: '跳过验证（校验失败时才用；此后该次结果不再证明证书链可信）' },
        ],
      },
    ],
    judgement:
      '汇总行 `summary: pages=N forms=M params=K queue_remaining=R`。逐页 `page: <路径> status=<码> links=<n>`，`form:` 行给表单的 action/method/inputs（参数名线索）。**`queue_remaining>0` = 触到 `max_pages` 被截住**，不是"站点只有这么多页"；`page: … error=<异常类名>` 的行是**没取到**（连接失败/超时），不是"页面不存在"。',
    example: 'pentest_recon(technique="web_crawl", targetSelector="192.168.1.10", scheme="https", depth=2, max_pages=100, purpose="...")',
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
    technique: 'dns_axfr',
    purpose: 'DNS 区域传送（AXFR）：向该区权威服务器要整份区文件（成功即拿到全部主机名）',
    params: [],
    judgement:
      '先看 `nameservers:`（该区权威列表，来自 NS 记录），再逐个尝试，每台回一行：`zone: <区> server=<ns> records=<n>  ← 区域传送成功（高价值）` 是成功；`zone: <ns> refused detail=<异常类名>` 是拒绝。汇总 `summary: transferred=<记录数>`。**全部 refused 是正常结果**（绝大多数 DNS 不开放 AXFR）——写成"AXFR 未开放"，不要写成"没跑"或"失败"。',
    example: 'pentest_recon(technique="dns_axfr", targetSelector="example.com", purpose="...")',
  },
  {
    technique: 'dns_brute',
    purpose: '子域爆破：用字典逐个查 A 记录（主动，会打到解析器，注意速率与授权）',
    params: [
      {
        name: 'wordlist',
        type: 'enum',
        required: false,
        default: 'subdomains_5k',
        description: '字典档位（镜像内固定）',
        options: [{ value: 'subdomains_5k', note: '5000 个常见子域标签（默认）' }],
      },
      {
        name: 'concurrency',
        type: 'integer',
        required: false,
        default: 10,
        description: '并发查询数（1-20）；默认建议 ≤10，避免被解析器限速',
      },
      {
        name: 'wildcard_check',
        type: 'enum',
        required: false,
        default: 'on',
        description: '泛解析剔除：先用 3 个随机标签探测通配，命中与通配答案相同的记录会被剔除',
        options: [
          { value: 'on', note: '剔除泛解析命中（默认）' },
          { value: 'off', note: '不剔除（结果里会混进泛解析记录，谨慎读）' },
        ],
      },
    ],
    judgement:
      '先看 `wildcard: detected|none` 与 `wildcard: … addresses=…`：`detected` 时，与通配答案相同的命中**已被剔除**，`found` 里只剩真子域。汇总 `summary: labels=<字典条数> found=<命中数> wildcard_filtered=yes|no`。因此 `found=0` 有两种读法：`wildcard_filtered=yes` 时可能被泛解析掩盖（换 `-` 前缀/更多随机探测确认），`wildcard_filtered=no` 才是"这本字典在这个域上确实没有命中"。',
    example: 'pentest_recon(technique="dns_brute", targetSelector="example.com", wordlist="subdomains_5k", concurrency=10, wildcard_check="on", purpose="...")',
  },
  {
    technique: 'whois',
    purpose: 'WHOIS 归属查询：域名查注册局/注册商，IP 查分配机构与网段',
    params: [
      {
        name: 'kind',
        type: 'enum',
        required: false,
        default: 'domain',
        description: '查什么（**按目标类型选**：域名用 domain，IP 用 ip）',
        options: [
          { value: 'domain', note: '域名 → 注册局/注册商/创建与到期/NS（默认）' },
          { value: 'ip', note: 'IP → 分配机构、inetnum/netname 网段归属' },
        ],
      },
    ],
    judgement:
      '字段逐行回 `whois_<字段>: <值>`（registrar / name_server / inetnum / netname / orgname / country / …），并附 `raw_head:` 原文前 40 行。两种**不是失败**的形态要分清：`note: 私有/回环/保留地址段没有注册局记录`（`kind=ip` 且目标是内网地址时的**预期行为**，不要重试）；真正的失败是 `error: whois_failed`（rc=1，附 `next_action`）——**别把失败读成"没有记录"**。查询量小、走第三方，输出里 `pinning: none`。',
    example: 'pentest_recon(technique="whois", targetSelector="example.com", kind="domain", purpose="...")',
  },
  {
    technique: 'ct_subdomains',
    purpose: '证书透明度日志查询：从 CT 日志里拿该域签发过的证书覆盖的主机名（被动，不碰目标）',
    params: [
      {
        name: 'include_wildcards',
        type: 'enum',
        required: false,
        default: 'false',
        description: '是否保留 `*.example.com` 形式的通配项',
        options: [
          { value: 'false', note: '剥掉 `*.` 前缀（默认）' },
          { value: 'true', note: '保留通配形式（想看通配证书覆盖范围时用）' },
        ],
      },
    ],
    judgement:
      '逐行 `subdomain: <名字>`，汇总 `summary: entries=<CT 条目数> unique_names=<去重子域数>`；`unique_names` 是**已列出**的数量（列出上限 500 条），不等于日志里的全量。本动作依赖 crt.sh **出网**：取不到是 `error: request_failed`（rc=1）——**不是"该域没有证书"**。输出里 `pinning: none`（走第三方）。',
    example: 'pentest_recon(technique="ct_subdomains", targetSelector="example.com", include_wildcards="false", purpose="...")',
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
        description:
          '是否验证 TLS 证书：**能用默认就用默认**（证书有效时默认就能通，IP 目标也一样）；只有**校验真的失败**（自签/链不全/SAN 不匹配）才设 false',
        options: [
          { value: 'true', note: '验证证书（默认；证书有效时就用它）' },
          { value: 'false', note: '跳过验证（校验失败时才用；此后该次结果不再证明证书链可信）' },
        ],
      },
    ],
    example: 'pentest_scan(technique="http_check", targetSelector="192.168.1.10", check="security_headers", purpose="...")',
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
        description:
          '暴露项名单（逗号分隔，≤10）：git,env,backup,swagger,openapi,actuator,server_status,phpinfo,web_config,dockerfile',
        example: 'paths="git,env,swagger"',
      },
      {
        name: 'verify_tls',
        type: 'enum',
        required: false,
        default: 'true',
        description:
          '是否验证 TLS 证书：**能用默认就用默认**（证书有效时默认就能通，IP 目标也一样）；只有**校验真的失败**（自签/链不全/SAN 不匹配）才设 false',
        options: [
          { value: 'true', note: '验证证书（默认；证书有效时就用它）' },
          { value: 'false', note: '跳过验证（校验失败时才用；此后该次结果不再证明证书链可信）' },
        ],
      },
    ],
    example: 'pentest_scan(technique="exposure_check", targetSelector="192.168.1.10", paths="git,env", purpose="...")',
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
    example: 'pentest_scan(technique="tls_weakness", targetSelector="192.168.1.10", port=443, purpose="...")',
  },
  {
    technique: 'nse_handshake',
    purpose: '握手面核验（只读 NSE 脚本：服务 banner、认证方式、证书）',
    params: [
      {
        name: 'port',
        type: 'integer',
        required: true,
        description: '脚本针对的端口',
      },
      {
        name: 'scripts',
        type: 'string',
        required: false,
        default: 'http-methods',
        description:
          '只读脚本（逗号分隔，最多 8 个）：smtp-commands,ftp-anon,ssh-auth-methods,rdp-ntlm-info,ssl-enum-ciphers,http-methods,smb-os-discovery,smb-security-mode',
        example: 'scripts="ftp-anon,ssh-auth-methods"',
      },
    ],
    example: 'pentest_scan(technique="nse_handshake", targetSelector="192.168.1.10", port=21, purpose="...")',
  },
];

// ═══════════════════════════════════════════════════════════════════════════
//                           渲染函数
// ═══════════════════════════════════════════════════════════════════════════

/** 渲染单个 technique 的参数表（Markdown 表格）。`family` 用于从注册表渲染超时上限（唯一来源）。 */
function renderTechniqueGuide(guide: TechniqueGuide, family: 'recon' | 'vuln'): string {
  const timeoutSeconds = templateTimeoutSeconds(family, guide.technique);
  const lines = [
    `**${guide.technique}**：${guide.purpose}`,
    timeoutSeconds === undefined
      ? ''
      : `墙钟上限：**${String(timeoutSeconds)}s**（模板 \`${family}_${guide.technique}\` 的 \`timeoutMs\`；本行由注册表渲染，不手抄）`,
    '',
  ];

  if (guide.params.length === 0) {
    lines.push('（无参数）');
  } else {
    lines.push('| 参数 | 类型 | 必填 | 默认值 | 说明 |');
    lines.push('|---|---|---|---|---|');
    for (const param of guide.params) {
      const req = param.required ? '✓' : '';
      const def = param.default === '' ? '（空串）' : param.default !== undefined ? String(param.default) : '—';
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

  if (guide.judgement !== undefined) {
    lines.push('', `**判据**：${guide.judgement}`);
  }

  lines.push('');
  lines.push(`示例：\`${guide.example}\``);
  lines.push('');
  return lines.join('\n');
}

/** 读输出的纪律：状态行、summary、覆盖度四字段、「没扫」与「扫到 0」的区别（规范 §2/§3）。 */
const OUTPUT_READING_GUIDE: readonly string[] = [
  '═══ 读输出：状态行、覆盖度、阴性结论怎么读 ═══',
  '',
  '沙箱里的**每个动词**输出都自报状态（沙箱工具规范 v1 §2）——**别只看有没有内容**：',
  '',
  '- **首行固定是 `state=`**：`ok`（跑完并拿到结果，**含"扫完是 0"**）/ `failed`（工具级失败、目标不可达）/ ' +
    '`no_target`（**没扫**：范围为空、没有可解析目标）/ `aborted`（被墙钟 deadline 提前终止）/ `partial`（只跑了一部分）。',
  '- 其后是 **`summary:` 行**（机器可读的 `key=value`，空格分隔），再后才是逐条明细（`path<TAB>…`、`port=…` 等）。' +
    '**结论从 summary 的字段读，不要从"明细看起来有几行"去推**。',
  '- **「没扫」与「扫到 0」不同形**：`scanned=false`（并给出原因）⇒ 范围为空/参数为空/被 deadline 提前终止，' +
    '这是**未覆盖**；`scanned=true` 且计数为 0 ⇒ 真的扫完是 0。前者写进报告的"未覆盖"，后者才是阴性结论。',
  '- **覆盖度四字段**（§3：凡有总量上限的动词都给）：`<x>_total` 本次总量（字典条数/路径条数/主机数/脚本数/结果条数）、' +
    '`<x>_attempted` 实际尝试数、`<x>_truncated` 是否被截断（**显式** `true`/`false`，不得靠"数字看起来小"推断）、' +
    '`<x>_remaining` 还剩多少。**`*_truncated=true` 时命中数只能当下界读**；`*_remaining>0` 时用分段参数（如 `entry_range=`）续跑。',
  '- **阴性结论**（0 命中/0 端口/无记录）必须能回答"你扫了什么、扫了多少"：`<x>_attempted` 或 `<x>_total` 至少给一个——' +
    '两个都没有，就不能说"没有"。',
  '- **退出码与状态是三档**（§4）：`0` 成功（含扫完是 0）/ `1` 运行时失败 / `2` 用法错误（输出里有 `usage_error:` 与**合法取值**）/ ' +
    '`124` 超时（容器保留已产出的输出，别当"没发出去"）。',
  '',
];

/**
 * 渲染结构化动作参数指南（注入到沙箱简报的两条通道对比表之后）。
 *
 * **按在场的工具分节渲染**（2026-10-10 修）：此前只要有一个结构化工具在面里就整篇渲染，
 * 于是情报阶段的简报里出现了「`pentest_scan` 各 technique 参数说明」——而那个工具当时
 * 不在该会话的能力快照里，模型照着参数表去调，得到的是"没这个工具"。**提示词只描述
 * 真实可调用的东西**，这条与"只宣传真实存在的通道"是同一条纪律。
 */
export function renderTechniqueParamsGuide(include: {
  readonly recon: boolean;
  readonly vuln: boolean;
}): string {
  const sections: string[] = [...OUTPUT_READING_GUIDE];
  if (include.recon) {
    sections.push(
      '═══ 结构化侦察动作参数指南 ═══',
      '',
      '以下是 `pentest_recon` 工具各个 technique 的参数说明。',
      '优先用结构化通道：参数少、免手写命令、①②③阶段免批。',
      '',
      ...RECON_GUIDES.map((guide) => renderTechniqueGuide(guide, 'recon')),
      '',
    );
  }
  if (include.vuln) {
    sections.push(
      '═══ 结构化漏洞核验动作参数指南 ═══',
      '',
      '以下是 `pentest_scan` 工具各个 technique 的参数说明。',
      '',
      ...VULN_GUIDES.map((guide) => renderTechniqueGuide(guide, 'vuln')),
    );
  }
  return sections.join('\n');
}
