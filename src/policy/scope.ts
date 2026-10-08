/**
 * 范围规范化与判定引擎 —— 设计文档 §10.2.2「目标规范化与范围判定」的唯一实现。
 *
 * 约束（与设计文档一一对应，逐条在代码处标注引用）：
 *   - 纯函数：不访问网络、不查 DNS。解析结果由调用方通过 `adjudicatedAddresses` 注入。
 *   - 无法安全规范化即拒绝，不做尽力解析（§10.2.2「必须拒绝的输入形态」）。
 *   - 所有拒绝路径返回契约 `ScopeRejectionCode` 中的稳定错误码 + 可读 detail，
 *     调用方据此记录 `scope_violation` 事件（§10.2.2「范围违规的处置」）。
 *   - 判定是执行热路径：`loadScopeRuleSet` 的结果可复用，避免每次动作重新规范化整份范围。
 */

import type {
  AssetScopeDecision,
  NormalizedTarget,
  PortRange,
  Protocol,
  ScopeDecision,
  ScopeRejectionCode,
  ScopeTarget,
  ScopeVerdict,
} from '../contracts.ts';

const DOC = '§10.2.2';

// ───────────────────────────── 结果类型 ─────────────────────────────

/**
 * 范围判定的拒绝结果。
 *
 * `normalized` 是**规范化之后**才可能有的东西：像 `malformed_target` 这类失败发生在
 * 规范化之前，本来就不存在规范化结果，因此该字段可选且为 `null`。
 * 而匹配类失败（`out_of_scope` / `excluded` / `pending` / 端口协议类）规范化已经完成，
 * 把规范形式带出来让 §10.2.2 的 `scope_violation` 事件能同时记下
 * 「Agent 想打什么」与「服务端认成什么」——只记原文的话，事后无法判断
 * 是 Agent 写错了还是范围配错了。
 */
type Rejection = {
  readonly ok: false;
  readonly code: ScopeRejectionCode;
  readonly detail: string;
  readonly normalized?: NormalizedTarget | null;
};
export type Result<T> = { readonly ok: true; readonly value: T } | Rejection;

function ok<T>(value: T): { readonly ok: true; readonly value: T } {
  return { ok: true, value };
}

function fail(code: ScopeRejectionCode, detail: string, normalized?: NormalizedTarget | null): Rejection {
  return normalized === undefined ? { ok: false, code, detail } : { ok: false, code, detail, normalized };
}

// ───────────────────────────── 固定表（版本写死，不随运行环境变化） ─────────────────────────────

/**
 * URL scheme → 传输协议 + 缺省端口。
 * §10.2.2「URL」：缺省端口补全为 80 / 443；「协议」：协议无法确定时拒绝。
 * 未列出的 scheme（ftp、gopher、chrome…）一律视为协议未确定 —— 本插件不猜测协议。
 */
const SCHEME_INFO: Readonly<Record<string, { readonly protocol: Protocol; readonly port: number }>> = {
  http: { protocol: 'tcp', port: 80 },
  https: { protocol: 'tcp', port: 443 },
  ws: { protocol: 'tcp', port: 80 },
  wss: { protocol: 'tcp', port: 443 },
};

/** HTTP 路径（代理容器）覆盖的重定向链 scheme；其余 scheme 的重定向按「协议未确定」拒绝（§10.4）。 */
const REDIRECT_SCHEMES: readonly string[] = ['http', 'https'];

/** 主机名 / IP 条目未指定端口时按默认端口匹配（§10.2.2「端口的协议依赖性」）。 */
const DEFAULT_HOST_PORTS: readonly number[] = [80, 443];

const PROTOCOLS: readonly Protocol[] = ['tcp', 'udp', 'icmp'];

function isProtocol(v: unknown): v is Protocol {
  return typeof v === 'string' && (PROTOCOLS as readonly string[]).includes(v);
}

/** 任意端口的显式人类选项：`{from:0,to:65535}`（§10.2.2，记入范围版本与放行记录）。 */
export const ANY_PORT: PortRange = { from: 0, to: 65535 };

// ───────────────────────────── 字符级防护 ─────────────────────────────

/**
 * §10.2.2「必须拒绝的输入形态 · 含控制字符或制表符、换行」→ 请求行注入。
 * 额外覆盖 Unicode 空白与行分隔符：一律拒绝，**不做 trim**（trim 会掩盖混淆）。
 */
const FORBIDDEN_CHAR =
  /[\u0000-\u0020\u007F-\u009F\u00A0\u1680\u2000-\u200A\u2028\u2029\u202F\u205F\u3000]/u;

function findForbiddenChar(text: string): string | null {
  const m = FORBIDDEN_CHAR.exec(text);
  if (!m) return null;
  const cp = m[0].codePointAt(0) ?? 0;
  return `U+${cp.toString(16).toUpperCase().padStart(4, '0')}`;
}

// ───────────────────────────── IP 字面量 ─────────────────────────────

/** 严格点分十进制：恰好 4 段、无前导零（前导零在不同解析器下是八进制）。 */
function parseIpv4Strict(text: string): readonly number[] | null {
  const parts = text.split('.');
  if (parts.length !== 4) return null;
  const octets: number[] = [];
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    if (part.length > 1 && part.startsWith('0')) return null;
    const n = Number(part);
    if (n > 255) return null;
    octets.push(n);
  }
  return octets;
}

/** IPv6 分组解析（RFC 4291 文本形式，含点分十进制尾部）；返回 8 个 16 位分组或 null。 */
function parseIpv6Groups(text: string): readonly number[] | null {
  if (text.length === 0 || !/^[0-9a-fA-F:.]+$/.test(text)) return null;
  let t = text;
  const dotted = /(^|:)((?:\d{1,3}\.){3}\d{1,3})$/.exec(t);
  if (dotted) {
    const v4 = parseIpv4Strict(dotted[2] ?? '');
    if (v4 === null) return null;
    const g1 = ((v4[0] ?? 0) << 8) | (v4[1] ?? 0);
    const g2 = ((v4[2] ?? 0) << 8) | (v4[3] ?? 0);
    t = `${t.slice(0, dotted.index)}${dotted[1] === ':' ? ':' : ''}${g1.toString(16)}:${g2.toString(16)}`;
  }
  const dbl = t.indexOf('::');
  if (dbl !== -1 && t.indexOf('::', dbl + 1) !== -1) return null;
  if (dbl === -1) {
    const parts = t.split(':');
    if (parts.length !== 8) return null;
    const groups: number[] = [];
    for (const p of parts) {
      if (!/^[0-9a-fA-F]{1,4}$/.test(p)) return null;
      groups.push(parseInt(p, 16));
    }
    return groups;
  }
  const headStr = t.slice(0, dbl);
  const tailStr = t.slice(dbl + 2);
  const head = headStr === '' ? [] : headStr.split(':');
  const tail = tailStr === '' ? [] : tailStr.split(':');
  if (head.length + tail.length > 7) return null; // `::` 至少压缩一个分组
  const headG: number[] = [];
  for (const p of head) {
    if (!/^[0-9a-fA-F]{1,4}$/.test(p)) return null;
    headG.push(parseInt(p, 16));
  }
  const tailG: number[] = [];
  for (const p of tail) {
    if (!/^[0-9a-fA-F]{1,4}$/.test(p)) return null;
    tailG.push(parseInt(p, 16));
  }
  const zeros = 8 - headG.length - tailG.length;
  if (zeros < 1) return null;
  return [...headG, ...new Array<number>(zeros).fill(0), ...tailG];
}

/** RFC 5952 规范写法：小写、无前导零、最长零段压缩为 `::`（单段零不压缩）。 */
function formatIpv6(groups: readonly number[]): string {
  let bestStart = -1;
  let bestLen = 0;
  let i = 0;
  while (i < 8) {
    if (groups[i] === 0) {
      let j = i;
      while (j < 8 && groups[j] === 0) j++;
      if (j - i > bestLen) {
        bestLen = j - i;
        bestStart = i;
      }
      i = j;
    } else {
      i++;
    }
  }
  const hex = groups.map((g) => (g ?? 0).toString(16));
  if (bestLen < 2) return hex.join(':');
  return `${hex.slice(0, bestStart).join(':')}::${hex.slice(bestStart + bestLen).join(':')}`;
}

/**
 * IPv4 等价翻译（§10.2.2「IP」）：
 *   - IPv4 映射 `::ffff:a.b.c.d`（边界 /96）
 *   - NAT64 WKP `64:ff9b::/96`（边界 /96）
 *   - 6to4 `2002:V4ADDR::/48`（边界 /48）
 * 带 zone id（`%`）的地址由调用方先行拒绝。
 */
interface Translation {
  readonly kind: 'ipv4-mapped' | 'nat64' | '6to4';
  readonly boundary: number;
  readonly ipv4: readonly number[];
}

function detectTranslation(groups: readonly number[]): Translation | null {
  const g = groups;
  const g0 = g[0] ?? 0;
  const g1 = g[1] ?? 0;
  const g6 = g[6] ?? 0;
  const g7 = g[7] ?? 0;
  const tail4: readonly number[] = [g6 >> 8, g6 & 0xff, g7 >> 8, g7 & 0xff];
  const zeroPrefix = (upto: number): boolean => {
    for (let k = 0; k < upto; k++) if ((g[k] ?? 0) !== 0) return false;
    return true;
  };
  if (zeroPrefix(5) && g[5] === 0xffff) {
    return { kind: 'ipv4-mapped', boundary: 96, ipv4: tail4 };
  }
  if (g0 === 0x0064 && g1 === 0xff9b && [2, 3, 4, 5].every((k) => (g[k] ?? 0) === 0)) {
    return { kind: 'nat64', boundary: 96, ipv4: tail4 };
  }
  if (g0 === 0x2002) {
    return { kind: '6to4', boundary: 48, ipv4: [g1 >> 8, g1 & 0xff, (g[2] ?? 0) >> 8, (g[2] ?? 0) & 0xff] };
  }
  return null;
}

const formatIpv4 = (octets: readonly number[]): string => octets.join('.');

/** 地址字面量 normalize 结果：canonical 可能已被翻译为 IPv4 等价形式。 */
interface AddressForm {
  readonly canonical: string;
  readonly family: 4 | 6;
  readonly v4?: readonly number[];
  readonly v6?: readonly number[];
  readonly translation?: Translation;
}

/**
 * 规范化单个 IP 字面量。非 IP 字面量返回 null（由调用方按域名处理）。
 * `%` zone id → 非规范 IP 字面量（§10.2.2「带 zone id 的地址拒绝」）。
 */
function tryNormalizeAddress(text: string): AddressForm | null {
  if (text.includes('%')) return null;
  if (text.includes(':')) {
    const groups = parseIpv6Groups(text);
    if (groups === null) return null;
    const translation = detectTranslation(groups);
    if (translation) {
      return {
        canonical: formatIpv4(translation.ipv4),
        family: 4,
        v4: translation.ipv4,
        v6: groups,
        translation,
      };
    }
    return { canonical: formatIpv6(groups), family: 6, v6: groups };
  }
  const v4 = parseIpv4Strict(text);
  if (v4 === null) return null;
  return { canonical: formatIpv4(v4), family: 4, v4 };
}

/** 裁决地址集合中的地址必须是 IP 字面量（§10.2.2 DNS 解析与地址固定）。 */
function canonicalizeAddress(text: string): Result<AddressForm> {
  const trimmed = text.startsWith('[') && text.endsWith(']') ? text.slice(1, -1) : text;
  const forbidden = findForbiddenChar(trimmed);
  if (forbidden !== null) return fail('control_chars', `裁决地址含控制字符或空白（${forbidden}）`);
  if (trimmed.includes('%')) {
    return fail('noncanonical_ip', `地址 ${text} 带 zone id，无法与裁决集合比较（${DOC} IP）`);
  }
  const form = tryNormalizeAddress(trimmed);
  if (form === null) {
    return fail('noncanonical_ip', `裁决地址 ${text} 不是规范 IP 字面量（${DOC} IP）`);
  }
  return ok(form);
}

/** 显式调用的规范 IP 判定：非字面量或非规范形态都给出稳定错误码。 */
export function normalizeAddressLiteral(text: string): Result<AddressForm> {
  const trimmed = text.startsWith('[') && text.endsWith(']') ? text.slice(1, -1) : text;
  if (trimmed.includes('%')) {
    return fail('noncanonical_ip', `地址 ${text} 带 zone id，无法与裁决集合比较（${DOC} IP）`);
  }
  if (looksLikeNoncanonicalIp(trimmed)) {
    return fail('noncanonical_ip', `非规范 IP 字面量 ${text}：不同解析器还原结果不同（${DOC} 必须拒绝的输入形态）`);
  }
  const form = tryNormalizeAddress(trimmed);
  if (form === null) return fail('malformed_target', `无法解析为 IP 字面量：${text}`);
  return ok(form);
}

/**
 * §10.2.2 非规范 IP 字面量识别（`2130706433`、`0x7f.0.0.1`、`127.1`、`0177.0.0.1`…）：
 * 只由数字与点组成、或含 `0x` 十六进制段的串，若不能被严格点分十进制解析，即视为非规范。
 */
function looksLikeNoncanonicalIp(text: string): boolean {
  if (text.length === 0) return false;
  if (/(^|\.)0[xX][0-9a-fA-F]*(\.|$)/.test(text)) return true;
  if (/^[0-9.]+$/.test(text)) return parseIpv4Strict(text) === null;
  return false;
}

// ───────────────────────────── IPv6 / IPv4 网段 ─────────────────────────────

interface NormalizedCidr {
  readonly family: 4 | 6;
  readonly network: string;
  readonly prefix: number;
}

function maskIpv4(octets: readonly number[], prefix: number): readonly number[] {
  const out: number[] = [];
  for (let i = 0; i < 4; i++) {
    const bits = Math.min(8, Math.max(0, prefix - i * 8));
    const mask = bits === 0 ? 0 : (0xff << (8 - bits)) & 0xff;
    out.push((octets[i] ?? 0) & mask);
  }
  return out;
}

function maskIpv6(groups: readonly number[], prefix: number): readonly number[] {
  const out: number[] = [];
  for (let i = 0; i < 8; i++) {
    const bits = Math.min(16, Math.max(0, prefix - i * 16));
    const mask = bits === 0 ? 0 : (0xffff << (16 - bits)) & 0xffff;
    out.push((groups[i] ?? 0) & mask);
  }
  return out;
}

/**
 * §10.2.2「网段」：解析为网络地址加前缀长度（主机位清零）。
 * 位于 IPv4 映射 / NAT64 / 6to4 前缀之内且前缀长度不小于翻译边界的网段，
 * 归一化为其 IPv4 等价形式。
 */
export function normalizeCidr(text: string): Result<NormalizedCidr> {
  const slash = text.indexOf('/');
  if (slash === -1) {
    return fail('malformed_target', `网段 ${text} 缺少前缀长度（${DOC} 网段）`);
  }
  if (text.indexOf('/', slash + 1) !== -1) {
    return fail('malformed_target', `网段 ${text} 含多个 '/'`);
  }
  const addrText = text.slice(0, slash);
  const prefixText = text.slice(slash + 1);
  if (addrText.includes('%')) {
    return fail('noncanonical_ip', `网段 ${text} 的基地址带 zone id，无法与裁决地址比较（${DOC} IP）`);
  }
  if (!/^\d{1,3}$/.test(prefixText)) {
    return fail('malformed_target', `网段 ${text} 的前缀长度非法`);
  }
  if (prefixText.length > 1 && prefixText.startsWith('0')) {
    return fail('malformed_target', `网段 ${text} 的前缀长度含前导零，形态非规范`);
  }
  const prefix = Number(prefixText);
  if (looksLikeNoncanonicalIp(addrText)) {
    return fail('noncanonical_ip', `网段 ${text} 的基地址是非规范 IP 字面量（${DOC} 必须拒绝的输入形态）`);
  }
  const form = tryNormalizeAddress(addrText);
  if (form === null) return fail('malformed_target', `网段 ${text} 的基地址无法解析`);
  const maxPrefix = form.v6 !== undefined ? 128 : 32;
  if (prefix > maxPrefix) {
    return fail('malformed_target', `网段 ${text} 的前缀长度超出 ${form.v6 !== undefined ? 'IPv6' : 'IPv4'} 上限 ${maxPrefix}`);
  }
  const translation = form.translation;
  if (translation && prefix >= translation.boundary) {
    // 翻译边界之内：整个网段落到 IPv4 等价空间
    const prefix4 = translation.kind === '6to4' ? 32 : prefix - translation.boundary;
    const net = maskIpv4(translation.ipv4, prefix4);
    return ok({ family: 4, network: formatIpv4(net), prefix: prefix4 });
  }
  if (form.family === 4) {
    const v4 = form.v4 ?? [];
    return ok({ family: 4, network: formatIpv4(maskIpv4(v4, prefix)), prefix });
  }
  const groups = form.v6 ?? [];
  return ok({ family: 6, network: formatIpv6(maskIpv6(groups, prefix)), prefix });
}

/**
 * 把一个 IPv4 网段展开成地址列表（**供范围批次用**）。
 *
 * 为什么设上限：宿主会逐地址裁决这份列表，并把它注入容器（`PENTEST_RESOLVED_ADDRESSES`）——
 * `/16` = 65536 条既撑爆环境变量，也让"逐地址裁决"失去意义（那本就是一次 nmap 的输入）。
 * 超过上限**如实拒绝**并给出可行的下一步（拆成更小的段），绝不静默截断——静默截断等于
 * 悄悄少扫一段，那正是这套工具最贵的错误形态。
 */
export function rangeAddressesOf(
  cidr: NormalizedCidr,
  maxAddresses = 4096,
): Result<readonly string[]> {
  if (cidr.family !== 4) {
    return fail(
      'malformed_target',
      `批次选择器目前只支持 IPv4 网段（${cidr.network}/${String(cidr.prefix)} 是 IPv6）`,
    );
  }
  const octets = cidr.network.split('.').map((part) => Number(part));
  const base =
    (((octets[0] ?? 0) << 24) | ((octets[1] ?? 0) << 16) | ((octets[2] ?? 0) << 8) | (octets[3] ?? 0)) >>> 0;
  const count = 2 ** (32 - cidr.prefix);
  if (count > maxAddresses) {
    return fail(
      'malformed_target',
      `网段 ${cidr.network}/${String(cidr.prefix)} 有 ${String(count)} 个地址，超过单次批次的 ${String(maxAddresses)} 上限：拆成更小的段（例如 /20）分几次跑`,
    );
  }
  const out: string[] = [];
  for (let i = 0; i < count; i += 1) {
    const value = (base + i) >>> 0;
    out.push(
      `${String((value >>> 24) & 255)}.${String((value >>> 16) & 255)}.${String((value >>> 8) & 255)}.${String(value & 255)}`,
    );
  }
  return ok(out);
}

function cidrContains(cidr: NormalizedCidr, host: NormalizedHost): boolean {
  if (cidr.family === 4) {
    if (host.v4) {
      return formatIpv4(maskIpv4(host.v4, cidr.prefix)) === cidr.network;
    }
    return false;
  }
  if (host.v6) {
    return formatIpv6(maskIpv6(host.v6, cidr.prefix)) === cidr.network;
  }
  return false;
}

// ───────────────────────────── 域名（IDNA2008 / UTS-46，版本写死） ─────────────────────────────

// RFC 3492 参数。punycode 编码器自实现，不调用运行时的 ICU IDNA，
// 因此规范化结果不随 Node/ICU 版本漂移（§10.2.2「版本写死，不随运行环境变化」）。
const PUNY_BASE = 36;
const PUNY_TMIN = 1;
const PUNY_TMAX = 26;
const PUNY_SKEW = 38;
const PUNY_DAMP = 700;
const PUNY_INITIAL_BIAS = 72;
const PUNY_INITIAL_N = 128;

function punyAdapt(delta: number, numPoints: number, firstTime: boolean): number {
  let d = firstTime ? Math.floor(delta / PUNY_DAMP) : delta >> 1;
  d += Math.floor(d / numPoints);
  let k = 0;
  while (d > ((PUNY_BASE - PUNY_TMIN) * PUNY_TMAX) >> 1) {
    d = Math.floor(d / (PUNY_BASE - PUNY_TMIN));
    k += PUNY_BASE;
  }
  return k + Math.floor(((PUNY_BASE - PUNY_TMIN + 1) * d) / (d + PUNY_SKEW));
}

function punyDigit(d: number): string {
  return d < 26 ? String.fromCharCode(97 + d) : String.fromCharCode(48 + (d - 26));
}

/** 把单个非 ASCII 标签编码为 punycode 载荷（不含 `xn--`）。 */
function punycodeEncode(label: string): string {
  const codePoints = [...label].map((ch) => ch.codePointAt(0) ?? 0);
  const basic = codePoints.filter((c) => c < 128);
  const output: string[] = basic.map((c) => String.fromCodePoint(c));
  let h = basic.length;
  const b = h;
  if (b > 0) output.push('-');
  let n = PUNY_INITIAL_N;
  let delta = 0;
  let bias = PUNY_INITIAL_BIAS;
  while (h < codePoints.length) {
    let m = Number.MAX_SAFE_INTEGER;
    for (const c of codePoints) if (c >= n && c < m) m = c;
    delta += (m - n) * (h + 1);
    n = m;
    for (const c of codePoints) {
      if (c < n) delta++;
      else if (c === n) {
        let q = delta;
        for (let k = PUNY_BASE; ; k += PUNY_BASE) {
          const t = k <= bias ? PUNY_TMIN : k >= bias + PUNY_TMAX ? PUNY_TMAX : k - bias;
          if (q < t) break;
          output.push(punyDigit(t + ((q - t) % (PUNY_BASE - t))));
          q = Math.floor((q - t) / (PUNY_BASE - t));
        }
        output.push(punyDigit(q));
        bias = punyAdapt(delta, h + 1, h === b);
        delta = 0;
        h++;
      }
    }
    delta++;
    n++;
  }
  return output.join('');
}

/**
 * UTS-46 映射（固定子集）：
 *   - 三种全角句点（U+3002 / U+FF0E / U+FF61）→ `.`
 *   - 全角 ASCII（U+FF01–U+FF5E）→ ASCII
 *   - ZWJ / ZWNJ：需要上下文规则，超出固定子集 → 拒绝
 *   - 其余按 Unicode 小写折叠 + NFC
 */
function mapIdnaChars(text: string): Result<string> {
  let out = '';
  for (const ch of text) {
    const cp = ch.codePointAt(0) ?? 0;
    if (cp === 0x3002 || cp === 0xff0e || cp === 0xff61) out += '.';
    else if (cp >= 0xff01 && cp <= 0xff5e) out += String.fromCodePoint(cp - 0xfee0);
    else if (cp === 0x200c || cp === 0x200d) {
      return fail('malformed_target', `域名含零宽连接符 U+${cp.toString(16).toUpperCase()}，无法按固定 IDNA 子集处理`);
    } else out += ch;
  }
  return ok(out.toLowerCase().normalize('NFC'));
}

const LABEL_RE = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;

function normalizeLabel(label: string): Result<string> {
  if (label.length === 0) return fail('malformed_target', '域名含空标签（连续点或首尾点）');
  let ascii = label;
  if (/[^\x00-\x7f]/.test(label)) {
    ascii = `xn--${punycodeEncode(label)}`;
  }
  if (ascii.length > 63) return fail('malformed_target', `域名标签 ${label} 超过 63 字节`);
  if (!LABEL_RE.test(ascii)) {
    return fail('malformed_target', `域名标签 ${label} 含非法字符（仅允许 a-z 0-9 与中划线）`);
  }
  return ok(ascii);
}

/** 域名规范化：去尾点、IDNA 转 punycode。 */
function normalizeDomain(rawHost: string): Result<string> {
  const mapped = mapIdnaChars(rawHost);
  if (!mapped.ok) return mapped;
  let text = mapped.value;
  if (text.endsWith('.')) text = text.slice(0, -1); // §10.2.2「去尾点」
  if (text.length === 0) return fail('malformed_target', '域名条目为空');
  const labels = text.split('.');
  const out: string[] = [];
  for (const label of labels) {
    const normalized = normalizeLabel(label);
    if (!normalized.ok) return normalized;
    out.push(normalized.value);
  }
  const host = out.join('.');
  if (host.length > 253) return fail('malformed_target', `域名 ${rawHost} 超过 253 字节`);
  return ok(host);
}

// ───────────────────────────── 主机 token ─────────────────────────────

interface NormalizedHost {
  readonly kind: 'domain' | 'ip';
  readonly host: string;
  readonly family?: 4 | 6;
  readonly v4?: readonly number[];
  readonly v6?: readonly number[];
}

interface WildcardSplit {
  readonly host: string;
  readonly wildcard: boolean;
}

/**
 * 通配合法性（§10.2.2「子域」）：只有显式写出的 `*.example.com` 合法；
 * 裸 `*`、`*.*`、部分通配 `web*.target.com` 一律非法（加载范围时报错）。
 */
function splitWildcard(raw: string, flag: boolean | undefined): Result<WildcardSplit> {
  if (raw === '*' || raw === '*.' || raw === '*.*') {
    return fail('wildcard_illegal', `裸通配条目 ${raw} 语义不明，可能导致过宽放行（${DOC} 必须拒绝的输入形态）`);
  }
  if (raw.startsWith('*.')) {
    const rest = raw.slice(2);
    if (rest.includes('*')) {
      return fail('wildcard_illegal', `条目 ${raw} 含多处通配，仅允许一级子域通配（${DOC} 子域）`);
    }
    return ok({ host: rest, wildcard: true });
  }
  if (raw.includes('*')) {
    return fail('wildcard_illegal', `部分通配条目 ${raw} 非法，仅允许 \`*.example.com\` 形式（${DOC} 子域）`);
  }
  return ok({ host: raw, wildcard: flag === true });
}

/** §10.2.2 非规范 IP 字面量与 IP 字面量的分流。 */
function normalizeHostToken(raw: string, allowWildcard: boolean, wildcardFlag?: boolean): Result<WildcardSplit & NormalizedHost> {
  if (raw.length === 0) {
    return fail('malformed_target', `目标条目为空（${DOC} 必须拒绝的输入形态）`);
  }
  const splitted = splitWildcard(raw, wildcardFlag);
  if (!splitted.ok) return splitted;
  let { host } = splitted.value;
  const wildcard = splitted.value.wildcard;
  if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1);
  if (host.length === 0) return fail('malformed_target', `目标条目 ${raw} 的主机部分为空`);

  if (host.includes('%')) {
    if (host.includes(':')) {
      return fail('noncanonical_ip', `地址 ${raw} 带 zone id，裁决端无法安全比较（${DOC} IP）`);
    }
    return fail('malformed_target', `主机名 ${raw} 含百分号，形态非法`);
  }
  if (looksLikeNoncanonicalIp(host)) {
    return fail('noncanonical_ip', `非规范 IP 字面量 ${raw}：多数 HTTP 客户端会解析为 IP，与裁决端判断不一致（${DOC} 必须拒绝的输入形态）`);
  }
  const addr = tryNormalizeAddress(host);
  if (addr !== null) {
    return ok({ host: addr.canonical, wildcard, kind: 'ip', family: addr.family, v4: addr.v4, v6: addr.v6 });
  }
  const domain = normalizeDomain(host);
  if (!domain.ok) return domain;
  return ok({ host: domain.value, wildcard, kind: 'domain' });
}

// ───────────────────────────── URL（RFC 3986 authority） ─────────────────────────────

interface ParsedUrl {
  readonly scheme: string;
  readonly host: string;
  readonly port: number;
  readonly protocol: Protocol;
  readonly wildcard: boolean;
  readonly hostKind: 'domain' | 'ip';
  readonly v4?: readonly number[];
  readonly v6?: readonly number[];
  readonly family?: 4 | 6;
}

const SCHEME_RE = /^([a-zA-Z][a-zA-Z0-9+.-]*):/;

/**
 * URL 目标解析（§10.2.2「URL」）：解析 RFC 3986 authority，提取 scheme / host / port，
 * 缺省端口补全为 80 / 443。路径与查询串**不参与判定**，也不进入规范化结果。
 */
function parseUrlSelector(raw: string, allowWildcard: boolean): Result<ParsedUrl> {
  // §10.2.2：反斜杠可被不同解析器还原为路径分隔符 → 拒绝
  if (raw.includes('\\')) {
    return fail('encoded_authority', `URL ${raw} 的 authority 含反斜杠，不同解析器还原结果不同（${DOC} 必须拒绝的输入形态）`);
  }
  const schemeMatch = SCHEME_RE.exec(raw);
  if (!schemeMatch) {
    return fail('malformed_target', `URL ${raw} 缺少 scheme`);
  }
  const scheme = (schemeMatch[1] ?? '').toLowerCase();
  const rest = raw.slice(schemeMatch[0].length);
  if (!rest.startsWith('//')) {
    return fail('protocol_undetermined', `URL ${raw} 无 authority（非层次化或省略「//」），协议无法确定（${DOC} 协议）`);
  }
  const afterSlashes = rest.slice(2);
  const end = [afterSlashes.indexOf('/'), afterSlashes.indexOf('?'), afterSlashes.indexOf('#')]
    .filter((i) => i >= 0)
    .reduce((acc, i) => Math.min(acc, i), afterSlashes.length);
  const authority = afterSlashes.slice(0, end);

  if (authority.includes('@')) {
    return fail('userinfo_present', `URL ${raw} 的 authority 含 userinfo，authority 与用户可见部分不一致（${DOC} 必须拒绝的输入形态）`);
  }
  if (authority.includes('%')) {
    return fail('encoded_authority', `URL ${raw} 的 authority 含百分号编码，不同解析器还原结果不同（${DOC} 必须拒绝的输入形态）`);
  }

  let hostPart: string;
  let portText: string | undefined;
  if (authority.startsWith('[')) {
    const close = authority.indexOf(']');
    if (close === -1) return fail('malformed_target', `URL ${raw} 的 IPv6 字面量缺少 ']'`);
    hostPart = authority.slice(1, close);
    const tail = authority.slice(close + 1);
    if (!hostPart.includes(':')) return fail('malformed_target', `URL ${raw} 用了方括号但不是 IPv6 字面量`);
    if (tail === '') portText = undefined;
    else if (tail.startsWith(':')) portText = tail.slice(1);
    else return fail('malformed_target', `URL ${raw} 的 authority 在 ']' 之后含非法内容`);
  } else {
    const colon = authority.indexOf(':');
    if (colon === -1) {
      hostPart = authority;
    } else {
      hostPart = authority.slice(0, colon);
      portText = authority.slice(colon + 1);
      if (portText.includes(':')) {
        return fail('malformed_target', `URL ${raw} 含未加方括号的 IPv6 字面量或非法 authority`);
      }
    }
  }
  if (hostPart.length === 0) return fail('malformed_target', `URL ${raw} 的主机为空`);

  const info = SCHEME_INFO[scheme];
  if (!info) {
    return fail('protocol_undetermined', `URL scheme ${scheme} 的传输协议未声明（${DOC} 协议：协议无法确定时拒绝）`);
  }
  let port = info.port;
  if (portText !== undefined) {
    if (portText.length === 0) return fail('malformed_target', `URL ${raw} 的端口为空`);
    if (!/^\d{1,5}$/.test(portText)) return fail('malformed_target', `URL ${raw} 的端口非数字`);
    if (portText.length > 1 && portText.startsWith('0')) {
      return fail('malformed_target', `URL ${raw} 的端口含前导零，形态非规范`);
    }
    const parsed = Number(portText);
    if (parsed < 1 || parsed > 65535) return fail('malformed_target', `URL ${raw} 的端口超出 1-65535`);
    port = parsed;
  }
  const host = normalizeHostToken(hostPart, allowWildcard);
  if (!host.ok) return host;
  return ok({
    scheme,
    host: host.value.host,
    port,
    protocol: info.protocol,
    wildcard: host.value.wildcard,
    hostKind: host.value.kind,
    v4: host.value.v4,
    v6: host.value.v6,
    family: host.value.family,
  });
}

// ───────────────────────────── 资产标签 ─────────────────────────────

/** 资产标签登记表：标签 → 具体目标选择器集合（当前范围版本内登记，§10.2.2「资产标签」）。 */
export interface AssetRegistry {
  readonly [label: string]: readonly string[] | undefined;
}

export function expandAssetLabel(label: string, registry: AssetRegistry | undefined): Result<readonly string[]> {
  const members = registry?.[label];
  if (!members || members.length === 0) {
    return fail('malformed_target', `资产标签 @${label} 在当前范围版本中没有登记任何目标（${DOC} 资产标签）`);
  }
  return ok(members);
}

// ───────────────────────────── 单目标规范化 ─────────────────────────────

interface ScopeTargetSelector {
  readonly kind: 'domain' | 'ip' | 'cidr' | 'url' | 'asset-label';
  readonly value: string;
}

/** 按规范化主机键注入的 DNS 裁决结果（§10.2.2 DNS 解析与地址固定；本模块不查 DNS）。 */
export interface AdjudicatedAddresses {
  readonly [host: string]: readonly string[] | undefined;
}

interface NormalizeOptions {
  readonly adjudicatedAddresses?: AdjudicatedAddresses;
  readonly assetRegistry?: AssetRegistry;
}

/**
 * §10.2.2「目标规范化」：把 Agent 给出的目标选择器统一为可比较的形式。
 *
 * 支持形态：域名（含 IDN）、URL、IP 字面量、资产标签（展开为唯一目标时）。
 * 网段是范围条目形态而非动作目标，用 `normalizeCidr` / `normalizeScopeEntry`；
 * 把它当动作目标传入按 `malformed_target` 拒绝。
 */
export function normalizeTarget(input: string | ScopeTargetSelector, options: NormalizeOptions = {}): ScopeVerdict {
  const raw = typeof input === 'string' ? input : input.value;
  const hint = typeof input === 'string' ? undefined : input.kind;

  // §10.2.2「含控制字符或制表符、换行」→ 请求行注入
  const forbidden = findForbiddenChar(raw);
  if (forbidden !== null) {
    return fail('control_chars', `目标含控制字符或空白（${forbidden}），可能构成请求行注入（${DOC} 必须拒绝的输入形态）`);
  }
  if (raw.length === 0) {
    return fail('malformed_target', `目标条目为空，语义不明（${DOC} 必须拒绝的输入形态）`);
  }
  const schemeMatch = SCHEME_RE.exec(raw);
  const scheme = schemeMatch === null ? '' : (schemeMatch[1] ?? '').toLowerCase();
  // 只有 `scheme://` 形态才按 URL 处理：`fe80::1%eth0` 这类串只是恰好以 `xxxx:` 开头，
  // 交给主机解析才能得到正确的拒绝码。
  const hasAuthority = schemeMatch !== null && raw.slice(schemeMatch[0].length).startsWith('//');
  const protocolRelative = raw.startsWith('//');
  const isUrl = hint === 'url' || hasAuthority;

  if (protocolRelative) {
    return fail('protocol_undetermined', `目标 ${raw} 是协议相对 URL，协议无法确定（${DOC} 协议）`);
  }
  if (hint === 'cidr' || (!isUrl && raw.includes('/'))) {
    return fail('malformed_target', `网段 ${raw} 不是可执行的动作目标（网段仅作为范围条目，${DOC} 网段）`);
  }
  if (!isUrl && schemeMatch !== null && SCHEME_INFO[scheme] !== undefined) {
    return fail('protocol_undetermined', `URL ${raw} 缺少 authority，协议无法确定（${DOC} 协议）`);
  }

  let normalized: NormalizedTarget;
  if (hint === 'asset-label' || raw.startsWith('@')) {
    const label = hint === 'asset-label' ? raw : raw.slice(1);
    const members = expandAssetLabel(label, options.assetRegistry);
    if (!members.ok) return members;
    if (members.value.length !== 1) {
      return fail(
        'malformed_target',
        `资产标签 @${label} 展开为 ${members.value.length} 个目标，需按范围条目整体展开（${DOC} 资产标签）`,
      );
    }
    const single = normalizeTarget(members.value[0] ?? '', options);
    if (!single.ok) return single;
    normalized = single.normalized;
  } else if (isUrl) {
    const parsed = parseUrlSelector(raw, false);
    if (!parsed.ok) return parsed;
    normalized = { kind: 'url', host: parsed.value.host, port: parsed.value.port, scheme: parsed.value.scheme };
  } else {
    if (raw.includes('*')) {
      return fail('wildcard_illegal', `动作目标 ${raw} 不能是通配条目（${DOC} 子域）`);
    }
    if (raw.includes('%')) {
      return fail('noncanonical_ip', `地址 ${raw} 带 zone id，裁决端无法安全比较（${DOC} IP）`);
    }
    if (looksLikeNoncanonicalIp(raw)) {
      return fail('noncanonical_ip', `非规范 IP 字面量 ${raw}：多数 HTTP 客户端会解析为 IP，与裁决端判断不一致（${DOC} 必须拒绝的输入形态）`);
    }
    const host = normalizeHostToken(raw, false);
    if (!host.ok) return host;
    if (hint === 'ip' && host.value.kind !== 'ip') {
      return fail('malformed_target', `条目 ${raw} 声明为 IP，但无法解析为 IP 字面量（${DOC} IP）`);
    }
    normalized = host.value.kind === 'ip' ? { kind: 'ip', host: host.value.host } : { kind: 'domain', host: host.value.host };
  }

  // 地址固定：解析结果由调用方注入；本函数不做 I/O，缺注入时只返回未绑定的规范化结果。
  const addresses = options.adjudicatedAddresses?.[normalized.host];
  if (addresses !== undefined) {
    const canonical: string[] = [];
    for (const address of addresses) {
      const form = canonicalizeAddress(address);
      if (!form.ok) return form;
      canonical.push(form.value.canonical);
    }
    normalized = { ...normalized, resolvedAddresses: canonical };
  }
  return { ok: true, normalized };
}

// ───────────────────────────── 范围条目规范化 ─────────────────────────────

export interface NormalizedScopeEntry {
  readonly kind: ScopeTarget['kind'];
  /** 稳定键：范围版本内用于 `AssetScopeDecision.assetId` 与审计记录。 */
  readonly key: string;
  readonly protocols: readonly Protocol[];
  /** 已解析端口集合。domain/ip 条目为空表示默认端口 80/443；ICMP 条目恒为空。 */
  readonly ports: readonly PortRange[];
  readonly wildcardSubdomain: boolean;
  readonly host: string;
  readonly scheme?: string;
  readonly port?: number;
  readonly family?: 4 | 6;
  readonly cidr?: NormalizedCidr;
  readonly v4?: readonly number[];
  readonly v6?: readonly number[];
  /** 资产标签展开的具体目标（继承标签条目的协议与端口约束）。 */
  readonly members?: readonly NormalizedScopeEntry[];
  readonly source: ScopeTarget;
}

interface ScopeBuildOptions {
  readonly assetRegistry?: AssetRegistry;
  /**
   * 资产标签**不做展开**，只校验条目形态。
   *
   * 创建与确认阶段还没有本作业的资产登记表（资产是 Agent 在阶段里发现的），
   * 展开必然失败；而标签的语义是「展开为当前范围版本内已登记的资产」，
   * 那属于判定期（`loadScopeRuleSet` 带 registry 调用）的事。
   */
  readonly staticAssetLabels?: boolean;
}

function isScopeKind(value: unknown): value is ScopeTarget['kind'] {
  return value === 'domain' || value === 'ip' || value === 'cidr' || value === 'url' || value === 'asset-label';
}

function validatePortRanges(ports: readonly unknown[]): Result<readonly PortRange[]> {
  const out: PortRange[] = [];
  for (const range of ports) {
    if (typeof range !== 'object' || range === null || Array.isArray(range)) {
      return fail('malformed_target', '范围条目的端口必须是合法的 from/to 区间（0-65535）');
    }
    const candidate = range as { readonly from?: unknown; readonly to?: unknown };
    if (
      !Number.isInteger(candidate.from) ||
      !Number.isInteger(candidate.to) ||
      (candidate.from as number) < 0 ||
      (candidate.to as number) > 65535 ||
      (candidate.from as number) > (candidate.to as number)
    ) {
      return fail('malformed_target', '范围条目的端口必须是合法的 from/to 区间（0-65535）');
    }
    out.push({ from: candidate.from as number, to: candidate.to as number });
  }
  return ok(out);
}

function validateProtocols(protocols: readonly unknown[], context: string): Result<readonly Protocol[]> {
  if (protocols.length === 0) {
    return fail('protocol_undetermined', `范围条目 ${context} 未声明协议集合，协议无法确定（${DOC} 协议）`);
  }
  const out: Protocol[] = [];
  for (const protocol of protocols) {
    if (!isProtocol(protocol)) {
      return fail('protocol_undetermined', `范围条目 ${context} 声明了未知协议 ${String(protocol)}（${DOC} 协议）`);
    }
    out.push(protocol);
  }
  return ok(out);
}

/**
 * §10.2.2「端口的协议依赖性」：
 *   - 任意 kind 留空端口都按默认 80/443 匹配（由 `effectivePorts` 统一展开）；
 *   - ICMP 条目没有端口维度，ICMP-only 条目声明端口即非法。
 */
function validatePortDimension(
  entry: ScopeTarget,
  protocols: readonly Protocol[],
  ports: readonly PortRange[],
): Result<void> {
  const context = `${entry.kind} ${entry.value}`;
  const icmpOnly = protocols.length === 1 && protocols[0] === 'icmp';
  if (icmpOnly && ports.length > 0) {
    return fail('port_not_allowed', `ICMP 条目 ${context} 没有端口维度，不能声明端口（${DOC} 端口的协议依赖性）`);
  }
  // 留空端口 → 由 {@link effectivePorts} 统一按默认 80/443 展开，**对所有 kind 一致**。
  //
  // 这里曾对 cidr / asset-label 额外拒绝（`port_required_for_cidr`），理由是「否则一次
  // 阶段级授权可能触达该网段全部端口」。那个理由**在实现上不成立**：`effectivePorts`
  // 只看 `entry.ports.length`，不看 kind——留空就是 80/443，网段条目也一样。
  // 于是那条限制没有守住任何东西，只是让「填个网段就得多写一个端口」变成了强制动作。
  return ok(undefined);
}

function entryKey(kind: ScopeTarget['kind'], canonical: string): string {
  return `${kind}:${canonical}`;
}

/**
 * 规范化并校验一条范围条目（§10.2.2）。
 * 任一形态非法即返回稳定错误码 —— 加载范围时报错，不做尽力解析。
 */
export function normalizeScopeEntry(rawEntry: unknown, options: ScopeBuildOptions = {}): Result<NormalizedScopeEntry> {
  if (typeof rawEntry !== 'object' || rawEntry === null || Array.isArray(rawEntry)) {
    return fail('malformed_target', '范围条目必须是包含 kind、value、protocols 与 ports 的对象');
  }
  const raw = rawEntry as {
    readonly kind?: unknown;
    readonly value?: unknown;
    readonly protocols?: unknown;
    readonly ports?: unknown;
    readonly wildcardSubdomain?: unknown;
  };
  if (!isScopeKind(raw.kind) || typeof raw.value !== 'string') {
    return fail('malformed_target', '范围条目必须声明合法的 kind 和字符串 value');
  }
  if (!Array.isArray(raw.protocols)) {
    return fail('protocol_undetermined', `范围条目 ${raw.kind} ${raw.value} 未声明协议集合，协议无法确定（${DOC} 协议）`);
  }
  if (!Array.isArray(raw.ports)) {
    return fail('malformed_target', `范围条目 ${raw.kind} ${raw.value} 未声明端口集合`);
  }
  if (raw.wildcardSubdomain !== undefined && typeof raw.wildcardSubdomain !== 'boolean') {
    return fail('malformed_target', `范围条目 ${raw.kind} ${raw.value} 的 wildcardSubdomain 必须是布尔值`);
  }
  const protocols = validateProtocols(raw.protocols, `${raw.kind} ${raw.value}`);
  if (!protocols.ok) return protocols;
  const ports = validatePortRanges(raw.ports);
  if (!ports.ok) return ports;
  const entry: ScopeTarget = {
    kind: raw.kind,
    value: raw.value,
    protocols: protocols.value,
    ports: ports.value,
    ...(raw.wildcardSubdomain === undefined ? {} : { wildcardSubdomain: raw.wildcardSubdomain }),
  };
  const forbidden = findForbiddenChar(entry.value);
  if (forbidden !== null) {
    return fail('control_chars', `范围条目含控制字符或空白（${forbidden}）（${DOC} 必须拒绝的输入形态）`);
  }
  const dimension = validatePortDimension(entry, protocols.value, ports.value);
  if (!dimension.ok) return dimension;

  if (entry.kind === 'url') {
    const parsed = parseUrlSelector(entry.value, true);
    if (!parsed.ok) return parsed;
    if (parsed.value.protocol !== protocols.value[0] && !protocols.value.includes(parsed.value.protocol)) {
      return fail(
        'protocol_not_allowed',
        `URL 条目 ${entry.value} 的 scheme 只支持 ${parsed.value.protocol.toUpperCase()}，与声明的协议集合冲突（${DOC} 协议）`,
      );
    }
    if (
      ports.value.length > 0 &&
      !ports.value.some((range) => parsed.value.port >= range.from && parsed.value.port <= range.to)
    ) {
      return fail(
        'malformed_target',
        `URL 条目 ${entry.value} 的端口 ${parsed.value.port} 不在其声明的端口集合内，条目自相矛盾（${DOC} 端口的协议依赖性）`,
      );
    }
    return ok({
      kind: 'url',
      key: entryKey('url', `${parsed.value.scheme}://${parsed.value.host}:${parsed.value.port}`),
      protocols: protocols.value,
      ports: ports.value,
      wildcardSubdomain: parsed.value.wildcard,
      host: parsed.value.host,
      scheme: parsed.value.scheme,
      port: parsed.value.port,
      family: parsed.value.family,
      v4: parsed.value.v4,
      v6: parsed.value.v6,
      source: entry,
    });
  }

  if (entry.kind === 'cidr') {
    const cidr = normalizeCidr(entry.value);
    if (!cidr.ok) return cidr;
    return ok({
      kind: 'cidr',
      key: entryKey('cidr', `${cidr.value.network}/${cidr.value.prefix}`),
      protocols: protocols.value,
      ports: ports.value,
      wildcardSubdomain: false,
      host: cidr.value.network,
      family: cidr.value.family,
      cidr: cidr.value,
      source: entry,
    });
  }

  if (entry.kind === 'asset-label') {
    const label = entry.value.startsWith('@') ? entry.value.slice(1) : entry.value;
    if (label.length === 0) {
      return fail('malformed_target', `资产标签条目 ${entry.value} 的标签名为空（${DOC} 资产标签）`);
    }
    if (options.staticAssetLabels === true) {
      // 未展开形态：`members` 缺失由类型允许，判定期带 registry 重新规范化时才展开。
      return ok({
        kind: 'asset-label',
        key: entryKey('asset-label', label),
        protocols: protocols.value,
        ports: ports.value,
        wildcardSubdomain: false,
        host: label,
        source: entry,
      });
    }
    const members = expandAssetLabel(label, options.assetRegistry);
    if (!members.ok) return members;
    const expanded: NormalizedScopeEntry[] = [];
    for (const member of members.value) {
      const memberEntry: ScopeTarget = {
        kind: member.startsWith('@')
          ? 'asset-label'
          : SCHEME_RE.test(member)
            ? 'url'
            : member.includes('/')
              ? 'cidr'
              : 'domain',
        value: member,
        protocols: protocols.value,
        ports: ports.value,
      };
      const normalizedMember = normalizeScopeEntry(memberEntry, options);
      if (!normalizedMember.ok) {
        return fail(
          normalizedMember.code,
          `资产标签 @${label} 的成员 ${member} 无法规范化：${normalizedMember.detail}`,
        );
      }
      expanded.push(normalizedMember.value);
    }
    return ok({
      kind: 'asset-label',
      key: entryKey('asset-label', label),
      protocols: protocols.value,
      ports: ports.value,
      wildcardSubdomain: false,
      host: label,
      members: expanded,
      source: entry,
    });
  }

  const host = normalizeHostToken(entry.value, true, entry.wildcardSubdomain);
  if (!host.ok) return host;
  if (host.value.wildcard && host.value.kind === 'ip') {
    return fail('wildcard_illegal', `IP 条目 ${entry.value} 不能使用子域通配（${DOC} 子域）`);
  }
  return ok({
    kind: host.value.kind,
    key: entryKey(host.value.kind, host.value.wildcard ? `*.${host.value.host}` : host.value.host),
    protocols: protocols.value,
    ports: ports.value,
    wildcardSubdomain: host.value.wildcard,
    host: host.value.host,
    family: host.value.family,
    v4: host.value.v4,
    v6: host.value.v6,
    source: entry,
  });
}

// ───────────────────────────── 范围加载 ─────────────────────────────

export interface ScopeRuleSet {
  readonly targets: readonly ScopeTarget[];
  readonly exclusions: readonly ScopeTarget[];
  readonly decisions?: readonly AssetScopeDecision[];
}

export interface LoadedScope {
  /** 品牌字段：区分原始 ScopeRuleSet 与已加载结果，避免热路径重复规范化。 */
  readonly __loaded: true;
  readonly targets: readonly NormalizedScopeEntry[];
  readonly exclusions: readonly NormalizedScopeEntry[];
  readonly decisions: readonly AssetScopeDecision[];
  readonly assetRegistry: AssetRegistry;
}

/** 加载范围版本：任何条目非法即整体拒绝（§10.2.2 加载范围时报错）。 */
export function loadScopeRuleSet(scope: ScopeRuleSet, options: ScopeBuildOptions = {}): Result<LoadedScope> {
  const assetRegistry = options.assetRegistry ?? {};
  const load = (entries: readonly ScopeTarget[], bucket: string): Result<readonly NormalizedScopeEntry[]> => {
    const out: NormalizedScopeEntry[] = [];
    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i];
      if (entry === undefined) continue;
      const normalized = normalizeScopeEntry(entry, { assetRegistry });
      if (!normalized.ok) {
        return fail(normalized.code, `${bucket}[${i}] ${normalized.detail}`);
      }
      out.push(normalized.value);
    }
    return ok(out);
  };
  const targets = load(scope.targets, 'targets');
  if (!targets.ok) return targets;
  const exclusions = load(scope.exclusions, 'exclusions');
  if (!exclusions.ok) return exclusions;
  return ok({
    __loaded: true,
    targets: targets.value,
    exclusions: exclusions.value,
    decisions: scope.decisions ?? [],
    assetRegistry,
  });
}

function isLoadedScope(scope: ScopeRuleSet | LoadedScope): scope is LoadedScope {
  return (scope as LoadedScope).__loaded === true;
}

// ───────────────────────────── 匹配 ─────────────────────────────

interface RequestShape {
  readonly kind: 'domain' | 'ip' | 'url';
  readonly host: string;
  readonly hostKind: 'domain' | 'ip';
  readonly v4?: readonly number[];
  readonly v6?: readonly number[];
  readonly scheme?: string;
  readonly protocol: Protocol;
  readonly candidatePorts: readonly number[];
}

/**
 * §10.2.2「子域」：精确匹配，不隐含通配。
 * 显式 `*.target.com` 只匹配一级子域（`a.target.com`），不含多级嵌套，也不含裸域本身。
 */
function domainMatches(entryHost: string, reqHost: string, wildcard: boolean): boolean {
  if (!wildcard) return entryHost === reqHost;
  const suffix = `.${entryHost}`;
  if (!reqHost.endsWith(suffix)) return false;
  const prefix = reqHost.slice(0, reqHost.length - suffix.length);
  return prefix.length > 0 && !prefix.includes('.');
}

function hostMatches(entry: NormalizedScopeEntry, req: RequestShape): boolean {
  switch (entry.kind) {
    case 'domain':
      return req.hostKind === 'domain' && domainMatches(entry.host, req.host, entry.wildcardSubdomain);
    case 'url':
      return (
        req.kind === 'url' &&
        req.scheme === entry.scheme &&
        domainMatches(entry.host, req.host, entry.wildcardSubdomain)
      );
    case 'ip':
      // §10.2.2「共享 IP」：不按 IP 放行。IP 条目只裁决字面量 IP 目标，
      // 域名解析到该 IP 不因此获得授权。
      return req.hostKind === 'ip' && req.host === entry.host;
    case 'cidr':
      return req.hostKind === 'ip' && entry.cidr !== undefined && cidrContains(entry.cidr, {
        kind: 'ip',
        host: req.host,
        v4: req.v4,
        v6: req.v6,
      });
    case 'asset-label':
      return (entry.members ?? []).some((member) => hostMatches(member, req));
  }
}

function portCovered(ranges: readonly PortRange[], candidates: readonly number[]): boolean {
  return candidates.some((port) => ranges.some((range) => port >= range.from && port <= range.to));
}

/**
 * 条目有效端口集合：domain/ip 条目留空即默认 80/443（§10.2.2 端口的协议依赖性）。
 *
 * 注意：contracts.ts 里 `ScopeTarget.ports` 的注释写"空数组表示任意端口"，
 * 与设计文档 §10.2.2「主机名与 IP 条目未指定端口时按默认端口（80 / 443）匹配」
 * 相冲突。设计文档是唯一设计权威，此处按设计文档执行：
 * 留空 = 默认端口；"任意端口"必须由人类显式选择，用 `ANY_PORT`（0-65535）表达，
 * 该选项记入范围版本与放行记录。
 */
function effectivePorts(entry: NormalizedScopeEntry): readonly PortRange[] {
  if (entry.kind === 'url' && entry.port !== undefined) return [{ from: entry.port, to: entry.port }];
  if (entry.ports.length > 0) return entry.ports;
  return DEFAULT_HOST_PORTS.map((p) => ({ from: p, to: p }));
}

interface EntryMatch {
  readonly host: boolean;
  readonly protocol: boolean;
  readonly port: boolean;
}

function matchEntry(entry: NormalizedScopeEntry, req: RequestShape): EntryMatch {
  const host = hostMatches(entry, req);
  const protocol = entry.protocols.includes(req.protocol);
  // 没有端口维度的动作只看目标与协议（§10.2.2 端口的协议依赖性）。
  //
  // 「没有端口维度」有两个来源，语义相同：ICMP 本身没有端口；以及模板显式声明
  // `portSource: { kind: 'none' }` 的动作（DNS 查询、WHOIS、证书透明度日志——
  // 它们要么发往解析器、要么发往第三方，端口不属于**目标**）。这两类在请求里都表现为
  // `candidatePorts` 为空。若空集合仍走端口判定，它们会被判成「端口不在范围内」而永远不可用
  // （2026-10-06 新增结构化侦察模板族时实测到）。
  const port = req.candidatePorts.length === 0 ? true : portCovered(effectivePorts(entry), req.candidatePorts);
  return { host, protocol, port };
}

/**
 * 判定结果优先级：排除 > 通过 > 协议/端口不符 > 不在范围。
 *
 * **不包含 `pending`**：pending 是逐资产的人类裁决，比范围条目更具体，
 * 因此短路返回（与 excluded 同级），不参与「多个范围条目取更优者」的比较。
 * 它曾被放进这张表，导致落在宽泛 CIDR 里的待确认资产被判为 ok 放行。
 */
type OutcomeKind = 'ok' | 'port_not_allowed' | 'protocol_not_allowed' | 'out_of_scope';

const OUTCOME_RANK: Readonly<Record<OutcomeKind, number>> = {
  ok: 0,
  port_not_allowed: 1,
  protocol_not_allowed: 2,
  out_of_scope: 4,
};

function better<T extends OutcomeKind>(current: T | null, candidate: T): T {
  if (current === null) return candidate;
  return OUTCOME_RANK[candidate] < OUTCOME_RANK[current] ? candidate : current;
}

function decisionCandidates(req: RequestShape): readonly string[] {
  const out = [req.host, `${req.hostKind}:${req.host}`];
  if (req.kind === 'url' && req.scheme) out.push(`url:${req.scheme}://${req.host}:${req.candidatePorts[0] ?? ''}`);
  if (req.hostKind === 'domain') {
    const dot = req.host.indexOf('.');
    if (dot > 0) out.push(`domain:*.${req.host.slice(dot + 1)}`);
  }
  return out;
}

// ───────────────────────────── 范围判定 ─────────────────────────────

interface EvaluateScopeInput {
  readonly target: string | ScopeTargetSelector;
  /** 动作协议。URL 目标可由 scheme 推导；其余形态未声明即按协议未确定拒绝。 */
  readonly protocol?: Protocol;
  readonly port?: number;
  readonly scope: ScopeRuleSet | LoadedScope;
  /** DNS 裁决结果（按规范化主机键注入）。域名目标缺失或为空即拒绝连接，不退化按域名拨号。 */
  readonly adjudicatedAddresses?: AdjudicatedAddresses;
  readonly assetRegistry?: AssetRegistry;
}

function canonicalAddresses(
  host: string,
  hostKind: 'domain' | 'ip',
  inject: AdjudicatedAddresses | undefined,
): Result<readonly string[]> {
  if (hostKind === 'ip') return ok([host]); // 字面量 IP 自身即已裁决地址
  const addresses = inject?.[host];
  if (!addresses || addresses.length === 0) {
    return fail('dns_unresolved', `目标 ${host} 未解析出任何地址，拒绝连接而非按域名拨号（${DOC} DNS 解析与地址固定）`);
  }
  const out: string[] = [];
  for (const address of addresses) {
    const form = canonicalizeAddress(address);
    if (!form.ok) return form;
    out.push(form.value.canonical);
  }
  return ok(out);
}

/**
 * §10.2.2「匹配规则」与「范围违规的处置」：返回 included/ok 或稳定拒绝码。
 * 通过时返回带 `resolvedAddresses` 的规范化目标 —— 连接必须落到其中之一
 * （由 `assertAdjudicatedAddress` 判定；**该判定在服务层尚未接线**，
 * 容器内置工具已按裁决地址固定拨号，代理侧的接线点见 `pg-policy.ts`）。
 */
export function evaluateScope(input: EvaluateScopeInput): ScopeVerdict {
  const loadedResult = isLoadedScope(input.scope)
    ? ok(input.scope)
    : loadScopeRuleSet(input.scope, { assetRegistry: input.assetRegistry });
  if (!loadedResult.ok) return loadedResult;
  const loaded = loadedResult.value;

  const normalizedResult = normalizeTarget(input.target, {
    assetRegistry: loaded.assetRegistry,
    adjudicatedAddresses: input.adjudicatedAddresses,
  });
  if (!normalizedResult.ok) return normalizedResult;
  const normalized = normalizedResult.normalized;

  // ── 协议确定（§10.2.2「协议」：协议无法确定时拒绝） ──
  const schemeInfo = normalized.scheme !== undefined ? SCHEME_INFO[normalized.scheme] : undefined;
  let protocol = input.protocol;
  if (protocol !== undefined && !isProtocol(protocol)) {
    return fail('protocol_undetermined', `未知协议 ${String(protocol)}（${DOC} 协议）`);
  }
  if (protocol === undefined) {
    if (!schemeInfo) {
      return fail('protocol_undetermined', `目标 ${String(input.target)} 未声明协议，无法确定匹配维度（${DOC} 协议）`);
    }
    protocol = schemeInfo.protocol;
  } else if (normalized.kind === 'url' && schemeInfo && schemeInfo.protocol !== protocol) {
    return fail('protocol_not_allowed', `URL scheme ${normalized.scheme} 只支持 ${schemeInfo.protocol.toUpperCase()}（${DOC} 协议）`, normalized);
  }

  // ── 端口一致性（§10.2.2 URL 与端口） ──
  if (
    input.port !== undefined &&
    normalized.kind === 'url' &&
    normalized.port !== undefined &&
    input.port !== normalized.port
  ) {
    return fail('malformed_target', `port 参数 ${input.port} 与 URL 端口 ${normalized.port} 不一致`);
  }
  const explicitPort = input.port ?? (normalized.kind === 'url' ? normalized.port : undefined);
  if (explicitPort !== undefined && (!Number.isInteger(explicitPort) || explicitPort < 1 || explicitPort > 65535)) {
    return fail('malformed_target', `端口 ${String(explicitPort)} 必须是 1-65535 的整数`);
  }
  if (protocol === 'icmp' && explicitPort !== undefined) {
    return fail('port_not_allowed', `ICMP 没有端口维度，不接受端口参数 ${explicitPort}（${DOC} 端口的协议依赖性）`);
  }

  const hostKind: 'domain' | 'ip' = normalized.kind === 'ip' ? 'ip' : isIpLiteral(normalized.host) ? 'ip' : 'domain';
  const hostForm = hostKind === 'ip' ? tryNormalizeAddress(normalized.host) : null;
  const req: RequestShape = {
    kind: normalized.kind,
    host: normalized.host,
    hostKind,
    ...(hostForm?.v4 ? { v4: hostForm.v4 } : {}),
    ...(hostForm?.v6 ? { v6: hostForm.v6 } : {}),
    ...(normalized.scheme !== undefined ? { scheme: normalized.scheme } : {}),
    protocol,
    candidatePorts: protocol === 'icmp' ? [] : explicitPort !== undefined ? [explicitPort] : DEFAULT_HOST_PORTS,
  };

  // ── 排除项优先于包含项（§10.2.2「排除项」） ──
  for (const exclusion of loaded.exclusions) {
    const m = matchEntry(exclusion, req);
    if (m.host && m.protocol && m.port) {
      return fail('excluded', `目标 ${req.host} 命中排除项 ${exclusion.key}，排除项优先于包含项（${DOC} 排除项）`, req);
    }
  }

  // ── 资产裁决（pending 的资产不得放行） ──
  //
  // 逐资产裁决比范围条目**更具体也更新**：它来自人类在范围修订时对单个资产的
  // 决定（`asset_scope_versions.decision`），而范围条目是宽泛的目标集合
  // （CIDR / 通配域名）。因此 `excluded` 与 `pending` 都必须短路返回，
  // 不能被范围条目的匹配「改善」为放行。
  //
  // 这里曾经把 `pending` 放进优先级排名表，导致一个真实缺陷：落在宽泛 CIDR 里的
  // 待确认资产会被判为 ok 并放行——人类的「尚未裁决」被范围条目绕过。
  // 该行为已由 test/scope.test.ts 的特征化用例锁住。
  const candidates = decisionCandidates(req);
  let decision: ScopeDecision | null = null;
  for (const item of loaded.decisions) {
    if (candidates.includes(item.assetId)) decision = item.decision;
  }
  if (decision === 'excluded') {
    return fail('excluded', `目标 ${req.host} 在范围版本中被裁决为 excluded（${DOC} 排除项优先于包含项）`, req);
  }
  if (decision === 'pending') {
    return fail(
      'pending',
      `目标 ${req.host} 对应的资产尚未被人类裁决（范围版本中为 pending）。` +
        `未裁决即未纳入，不得因为落在宽泛范围条目内而放行（${DOC} 范围修订与排除项优先）`,
    );
  }

  // ── 包含项 ──
  let outcome: OutcomeKind | null = null;
  for (const entry of loaded.targets) {
    const m = matchEntry(entry, req);
    if (!m.host) continue;
    if (m.protocol && m.port) {
      outcome = better(outcome, 'ok');
    } else if (!m.port) {
      outcome = better(outcome, 'port_not_allowed');
    } else {
      outcome = better(outcome, 'protocol_not_allowed');
    }
  }
  if (decision === 'included') outcome = better(outcome, 'ok');

  switch (outcome) {
    case 'ok':
      break;
    case 'port_not_allowed':
      return fail(
        'port_not_allowed',
        `目标 ${req.host} 在范围内，但端口 ${req.candidatePorts.join('|')} 未被范围条目授权（${DOC} 端口的协议依赖性）`,
      );
    case 'protocol_not_allowed':
      return fail(
        'protocol_not_allowed',
        `目标 ${req.host} 在范围内，但协议 ${protocol.toUpperCase()} 未被范围条目授权（${DOC} 协议）`,
      );
    default:
      return fail('out_of_scope', `目标 ${req.host} 不在会话绑定的范围版本内（${DOC} 匹配规则）`, req);
  }

  // ── 放行路径才需要裁决地址集合：范围外的目标不需要 DNS（§10.2.2 DNS 解析与地址固定） ──
  const addresses = canonicalAddresses(normalized.host, hostKind, input.adjudicatedAddresses);
  if (!addresses.ok) return addresses;

  // 解析结果落在排除的基础设施上同样按排除处理（地址固定 + 排除优先）
  if (hostKind === 'domain') {
    for (const address of addresses.value) {
      const form = tryNormalizeAddress(address);
      if (form === null) continue;
      const addrReq: RequestShape = {
        kind: 'ip',
        host: address,
        hostKind: 'ip',
        ...(form.v4 ? { v4: form.v4 } : {}),
        ...(form.v6 ? { v6: form.v6 } : {}),
        protocol,
        candidatePorts: req.candidatePorts,
      };
      for (const exclusion of loaded.exclusions) {
        if (hostMatches(exclusion, addrReq)) {
          return fail(
            'excluded',
            `目标 ${req.host} 的裁决地址 ${address} 命中排除项 ${exclusion.key}（${DOC} 排除项 · DNS 解析与地址固定）`,
          );
        }
      }
    }
  }
  // 通过后按已裁决的地址连接，不做第二次解析（地址固定）
  return { ok: true, normalized: { ...normalized, resolvedAddresses: addresses.value } };
}

function isIpLiteral(text: string): boolean {
  return tryNormalizeAddress(text) !== null;
}

// ───────────────────────────── 重定向逐跳校验 ─────────────────────────────

interface RedirectChainInput {
  readonly chain: readonly string[];
  readonly scope: ScopeRuleSet | LoadedScope;
  readonly adjudicatedAddresses?: AdjudicatedAddresses;
  readonly assetRegistry?: AssetRegistry;
}

export type RedirectChainVerdict =
  | { readonly ok: true; readonly hops: readonly NormalizedTarget[] }
  | {
      readonly ok: false;
      readonly code: ScopeRejectionCode;
      readonly detail: string;
      /** 首次越界的跳序号（0 基）；链为空时为 -1。 */
      readonly hopIndex: number;
    };

/**
 * §10.2.2「重定向」：**每一跳都重新校验**。第一跳合法但后续跳指向范围外时，
 * 整个请求链被拒绝 —— 调用方据此记录一次 `scope_violation` 事件，工具返回 blocked。
 */
export function evaluateRedirectChain(input: RedirectChainInput): RedirectChainVerdict {
  if (input.chain.length === 0) {
    return { ok: false, code: 'malformed_target', detail: '重定向链为空，无可校验的跳', hopIndex: -1 };
  }
  const loaded = isLoadedScope(input.scope)
    ? ok(input.scope)
    : loadScopeRuleSet(input.scope, { assetRegistry: input.assetRegistry });
  if (!loaded.ok) return { ok: false, code: loaded.code, detail: loaded.detail, hopIndex: 0 };
  const scope: LoadedScope = loaded.value;
  const hops: NormalizedTarget[] = [];
  for (let i = 0; i < input.chain.length; i++) {
    const hop = input.chain[i] ?? '';
    const schemeMatch = SCHEME_RE.exec(hop);
    const scheme = (schemeMatch?.[1] ?? '').toLowerCase();
    if (!REDIRECT_SCHEMES.includes(scheme)) {
      return {
        ok: false,
        code: 'protocol_undetermined',
        detail: `第 ${i + 1} 跳 ${hop} 的 scheme ${scheme || '(缺失)'} 不在 HTTP 路径覆盖内，协议无法确定（${DOC} 重定向）`,
        hopIndex: i,
      };
    }
    // 每跳重新规范化并重新判定；域名跳使用该跳主机自己的裁决地址
    const verdict = evaluateScope({
      target: hop,
      protocol: 'tcp',
      scope,
      ...(input.adjudicatedAddresses !== undefined ? { adjudicatedAddresses: input.adjudicatedAddresses } : {}),
    });
    if (!verdict.ok) {
      return { ok: false, code: verdict.code, detail: `第 ${i + 1} 跳 ${hop}：${verdict.detail}`, hopIndex: i };
    }
    hops.push(verdict.normalized);
  }
  return { ok: true, hops };
}

// ───────────────────────────── 地址固定 ─────────────────────────────

/**
 * §10.2.2「DNS 解析与地址固定」：实际连接必须落到裁决时看到的地址上。
 * 拨号地址不在 `resolvedAddresses` 中即拒绝 —— 两次解析之间记录可能已被改变（DNS 重绑定）。
 * 裁决未解析出任何地址时同样拒绝，不退化为按域名拨号。
 */
export function assertAdjudicatedAddress(normalized: NormalizedTarget, dialedAddress: string): ScopeVerdict {
  const dialed = canonicalizeAddress(dialedAddress);
  if (!dialed.ok) return dialed;
  const adjudicated = normalized.resolvedAddresses;
  if (!adjudicated || adjudicated.length === 0) {
    return fail(
      'dns_unresolved',
      `目标 ${normalized.host} 没有已裁决地址集合，拒绝连接而非按域名拨号（${DOC} DNS 解析与地址固定）`,
    );
  }
  const allowed: string[] = [];
  for (const address of adjudicated) {
    const form = canonicalizeAddress(address);
    if (!form.ok) return form;
    allowed.push(form.value.canonical);
  }
  if (!allowed.includes(dialed.value.canonical)) {
    return fail(
      'address_not_adjudicated',
      `拨号地址 ${dialed.value.canonical} 不在目标 ${normalized.host} 的裁决地址集合 [${allowed.join(', ')}] 内（${DOC} 地址固定）`,
    );
  }
  return { ok: true, normalized };
}
