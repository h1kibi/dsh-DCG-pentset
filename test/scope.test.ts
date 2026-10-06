/**
 * 范围规范化与判定引擎的对抗性验收测试（设计文档 §10.2.2）。
 *
 * 覆盖分类：
 *   A 域名与 IDN 规范化          E 匹配语义（子域/路径/协议/端口/ICMP/共享 IP）
 *   B URL 规范化与缺省端口        F 范围加载校验（网段与资产标签必须声明端口或协议）
 *   C IP 规范化与 IPv4 等价翻译   G 排除项优先与资产裁决
 *   D 必须拒绝的输入形态（对抗）  H 重定向逐跳校验
 *                                 I 地址固定（裁决集合）
 *                                 J 资产标签展开
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import type {
  AssetScopeDecision,
  NormalizedTarget,
  PortRange,
  Protocol,
  ScopeRejectionCode,
  ScopeTarget,
  ScopeVerdict,
} from '../src/contracts.ts';
import {
  ANY_PORT,
  assertAdjudicatedAddress,
  evaluateRedirectChain,
  evaluateScope,
  expandAssetLabel,
  loadScopeRuleSet,
  normalizeAddressLiteral,
  normalizeCidr,
  normalizeScopeEntry,
  normalizeTarget,
} from '../src/policy/scope.ts';
import type { AdjudicatedAddresses, ScopeRuleSet } from '../src/policy/scope.ts';

// ───────────────────────────── 测试辅助 ─────────────────────────────

function target(
  kind: ScopeTarget['kind'],
  value: string,
  protocols: readonly Protocol[] = ['tcp'],
  ports: readonly PortRange[] = [],
): ScopeTarget {
  return { kind, value, protocols, ports };
}

function wildcardTarget(value: string, protocols: readonly Protocol[] = ['tcp'], ports: readonly PortRange[] = []): ScopeTarget {
  return { kind: 'domain', value, protocols, ports, wildcardSubdomain: true };
}

function scope(
  targets: readonly ScopeTarget[],
  exclusions: readonly ScopeTarget[] = [],
  decisions: readonly AssetScopeDecision[] = [],
): ScopeRuleSet {
  return { targets, exclusions, decisions };
}

/** 固定端口区间，避免测试里重复书写对象字面量。 */
function port(from: number, to: number = from): PortRange {
  return { from, to };
}

/** 拒绝形态在所有 Result 类型上结构一致，测试断言无需区分具体 Result 载荷。 */
type Rejectable =
  | { readonly ok: true }
  | { readonly ok: false; readonly code: ScopeRejectionCode; readonly detail: string };

function expectRejected(verdict: Rejectable, code: ScopeRejectionCode): string {
  if (verdict.ok) {
    assert.fail(`期望拒绝 ${code}，实际通过：${JSON.stringify(verdict)}`);
  }
  assert.equal(verdict.code, code, `detail: ${verdict.detail}`);
  return verdict.detail;
}

function expectOk(verdict: ScopeVerdict): NormalizedTarget {
  if (!verdict.ok) {
    assert.fail(`期望通过，实际拒绝 ${verdict.code}：${verdict.detail}`);
  }
  return verdict.normalized;
}

/** 常用范围：target.com 仅 443/tcp。 */
const BASIC = scope([target('domain', 'target.com', ['tcp'], [port(443)])]);

// ═════════════════════════ A. 域名与 IDN 规范化 ═════════════════════════

test('A1 域名小写化并去掉尾部点', () => {
  assert.equal(expectOk(normalizeTarget('EXAMPLE.com.')).host, 'example.com');
});

test('A2 国际化域名按固定 punycode 版本转换（IDNA2008/UTS-46）', () => {
  // 与运行时 ICU 版本无关：本模块自实现 RFC 3492 编码器
  assert.equal(expectOk(normalizeTarget('BÜCHER.example')).host, 'xn--bcher-kva.example');
  assert.equal(expectOk(normalizeTarget('bücher.example')).host, 'xn--bcher-kva.example');
});

test('A3 全角 ASCII 与全角句点按 UTS-46 映射表归一', () => {
  assert.equal(expectOk(normalizeTarget('ｅｘａｍｐｌｅ.com')).host, 'example.com');
  assert.equal(expectOk(normalizeTarget('example。com')).host, 'example.com');
});

test('A4 域名标签含非法字符时拒绝（下划线）', () => {
  expectRejected(normalizeTarget('ex_ample.com'), 'malformed_target');
});

test('A5 零宽连接符无法按固定 IDNA 子集处理，拒绝', () => {
  expectRejected(normalizeTarget('a\u200db.com'), 'malformed_target');
});

test('A6 连续点（空标签）拒绝', () => {
  expectRejected(normalizeTarget('a..target.com'), 'malformed_target');
});

// ═════════════════════════ B. URL 规范化与缺省端口 ═════════════════════════

test('B1 http/https 缺省端口补全为 80/443', () => {
  const http = expectOk(normalizeTarget('http://target.com/'));
  assert.equal(http.kind, 'url');
  assert.equal(http.port, 80);
  assert.equal(expectOk(normalizeTarget('https://target.com/')).port, 443);
});

test('B2 ws/wss 缺省端口补全', () => {
  assert.equal(expectOk(normalizeTarget('ws://target.com/')).port, 80);
  assert.equal(expectOk(normalizeTarget('wss://target.com/')).port, 443);
});

test('B3 scheme 不在固定表内时按协议未确定拒绝', () => {
  expectRejected(normalizeTarget('gopher://target.com/'), 'protocol_undetermined');
});

test('B4 路径与查询串不进入规范化结果（只比 scheme/host/port）', () => {
  const normalized = expectOk(normalizeTarget('https://target.com/deep/path?q=1#frag'));
  assert.deepEqual(normalized, { kind: 'url', host: 'target.com', port: 443, scheme: 'https' });
});

test('B5 IPv6 字面量 URL 用方括号，规范化后去掉方括号', () => {
  const normalized = expectOk(normalizeTarget('https://[2001:0DB8::1]:8443/x'));
  assert.equal(normalized.host, '2001:db8::1');
  assert.equal(normalized.port, 8443);
});

test('B6 端口非数字、前导零、超界、为空都拒绝', () => {
  expectRejected(normalizeTarget('http://target.com:notaport/'), 'malformed_target');
  expectRejected(normalizeTarget('http://target.com:080/'), 'malformed_target');
  expectRejected(normalizeTarget('http://target.com:99999/'), 'malformed_target');
  expectRejected(normalizeTarget('https://target.com:/'), 'malformed_target');
});

test('B7 协议相对 URL（//host）协议无法确定即拒绝', () => {
  expectRejected(normalizeTarget('//target.com/path'), 'protocol_undetermined');
});

test('B8 层次化 URL 缺 authority（http:target.com）拒绝', () => {
  expectRejected(normalizeTarget('http:target.com'), 'protocol_undetermined');
});

test('B9 端口参数与 URL 端口冲突时拒绝，不静默采用其中之一', () => {
  expectRejected(
    evaluateScope({
      target: 'https://target.com/',
      protocol: 'tcp',
      port: 8443,
      scope: BASIC,
      adjudicatedAddresses: { 'target.com': ['93.184.216.34'] },
    }),
    'malformed_target',
  );
});

// ═════════════════════════ C. IP 规范化与 IPv4 等价翻译 ═════════════════════════

test('C1 IPv6 压缩为标准写法（RFC 5952）', () => {
  assert.equal(expectOk(normalizeTarget('2001:0DB8:0000:0000:0000:0000:0000:0001')).host, '2001:db8::1');
  assert.equal(expectOk(normalizeTarget('0:0:0:0:0:0:0:1')).host, '::1');
  assert.equal(expectOk(normalizeTarget('fe80:0:0:0:1:0:0:1')).host, 'fe80::1:0:0:1');
});

test('C2 IPv4 映射地址归一化为 IPv4 等价形式', () => {
  assert.equal(expectOk(normalizeTarget('::ffff:192.0.2.128')).host, '192.0.2.128');
  assert.equal(expectOk(normalizeTarget('0:0:0:0:0:ffff:c000:0281')).host, '192.0.2.129');
});

test('C3 6to4 地址归一化为 IPv4 等价形式', () => {
  assert.equal(expectOk(normalizeTarget('2002:c000:0201::')).host, '192.0.2.1');
});

test('C4 NAT64（64:ff9b::/96）归一化为 IPv4 等价形式', () => {
  assert.equal(expectOk(normalizeTarget('64:ff9b::192.0.2.1')).host, '192.0.2.1');
  assert.equal(expectOk(normalizeTarget('64:ff9b::c000:201')).host, '192.0.2.1');
});

test('C5 带 zone id 的地址拒绝（无法与裁决集合比较）', () => {
  expectRejected(normalizeTarget('fe80::1%eth0'), 'noncanonical_ip');
  expectRejected(normalizeAddressLiteral('fe80::1%12'), 'noncanonical_ip');
});

test('C6 网段归一化为网络地址加前缀长度（主机位清零）', () => {
  assert.deepEqual(normalizeCidr('192.168.1.7/24'), { ok: true, value: { family: 4, network: '192.168.1.0', prefix: 24 } });
  assert.deepEqual(normalizeCidr('2001:db8:1:2::/32'), {
    ok: true,
    value: { family: 6, network: '2001:db8::', prefix: 32 },
  });
});

test('C7 翻译前缀内的网段归一化为 IPv4 等价网段', () => {
  assert.deepEqual(normalizeCidr('::ffff:192.0.2.0/120'), {
    ok: true,
    value: { family: 4, network: '192.0.2.0', prefix: 24 },
  });
  // 6to4 /48 恰好确定一个 IPv4 地址
  assert.deepEqual(normalizeCidr('2002:c000:0201::/48'), {
    ok: true,
    value: { family: 4, network: '192.0.2.1', prefix: 32 },
  });
});

test('C8 网段缺前缀、前缀超界、含 zone id 都拒绝', () => {
  assert.equal(normalizeCidr('10.0.0.0').ok, false);
  assert.equal(normalizeCidr('2001:db8::/129').ok, false);
  assert.equal(normalizeCidr('10.0.0.0/33').ok, false);
  assert.equal(normalizeCidr('fe80::%1/64').ok, false);
});

test('C9 网段不能当作动作目标提交', () => {
  expectRejected(normalizeTarget('10.0.0.0/8'), 'malformed_target');
});

// ═════════════════════════ D. 必须拒绝的输入形态（对抗向量） ═════════════════════════

test('D1 URL 含 userinfo 拒绝，且 userinfo 后的 host 不因“出现过 target.com”而放行', () => {
  const verdict = normalizeTarget('https://target.com@evil.com/');
  expectRejected(verdict, 'userinfo_present');
  expectRejected(normalizeTarget('https://evil.com@target.com/'), 'userinfo_present');
  expectRejected(normalizeTarget('https://target.com%31@evil.com/'), 'userinfo_present');
});

test('D2 authority 内百分号编码拒绝（不同解析器还原结果不同）', () => {
  expectRejected(normalizeTarget('https://target.com%00.evil.com/'), 'encoded_authority');
  expectRejected(normalizeTarget('https://%74arget.com/'), 'encoded_authority');
});

test('D3 authority 内反斜杠拒绝（解析器可能当作路径分隔符）', () => {
  expectRejected(normalizeTarget('https://target.com\\@evil.com/'), 'encoded_authority');
});

test('D4 控制字符、制表符、换行拒绝（请求行注入）', () => {
  expectRejected(normalizeTarget('https://target.com/\r\nHost: evil.com'), 'control_chars');
  expectRejected(normalizeTarget('target.com\t'), 'control_chars');
  expectRejected(normalizeTarget('target.com\n'), 'control_chars');
  expectRejected(normalizeTarget(' target.com'), 'control_chars');
});

test('D5 非规范 IP 字面量拒绝：整数形态、十六进制形态、缩写形态', () => {
  expectRejected(normalizeTarget('2130706433'), 'noncanonical_ip');
  expectRejected(normalizeTarget('0x7f.0.0.1'), 'noncanonical_ip');
  expectRejected(normalizeTarget('127.1'), 'noncanonical_ip');
  expectRejected(normalizeTarget('0177.0.0.1'), 'noncanonical_ip');
});

test('D6 URL 中的非规范 IP 字面量同样拒绝', () => {
  expectRejected(normalizeTarget('http://2130706433/'), 'noncanonical_ip');
  expectRejected(normalizeTarget('http://0x7f.0.0.1/'), 'noncanonical_ip');
});

test('D7 空条目与裸通配条目拒绝', () => {
  expectRejected(normalizeTarget(''), 'malformed_target');
  expectRejected(normalizeTarget('*'), 'wildcard_illegal');
  expectRejected(normalizeScopeEntry(target('domain', '*')), 'wildcard_illegal');
});
test('D7a 畸形范围条目返回拒绝而不是读取 undefined.length', () => {
  assert.doesNotThrow(() => {
    const result = normalizeScopeEntry({ value: '47.109.76.66:3002', port: 3002, protocol: 'tcp' });
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.code, 'malformed_target');
  });
  assert.deepEqual(
    normalizeScopeEntry({ kind: 'ip', value: '47.109.76.66', port: 3002, protocol: 'tcp' }),
    {
      ok: false,
      code: 'protocol_undetermined',
      detail: '范围条目 ip 47.109.76.66 未声明协议集合，协议无法确定（§10.2.2 协议）',
    },
  );
  assert.deepEqual(
    normalizeScopeEntry({ kind: 'ip', value: '47.109.76.66', protocols: ['tcp'] }),
    {
      ok: false,
      code: 'malformed_target',
      detail: '范围条目 ip 47.109.76.66 未声明端口集合',
    },
  );
});

test('D8 部分通配条目在加载范围时报错', () => {
  const loaded = loadScopeRuleSet(scope([target('domain', 'web*.target.com', ['tcp'], [port(443)])]));
  assert.equal(loaded.ok, false);
  if (!loaded.ok) assert.equal(loaded.code, 'wildcard_illegal');
  expectRejected(normalizeScopeEntry(target('domain', '*.')), 'wildcard_illegal');
  expectRejected(normalizeScopeEntry(target('domain', '*.*')), 'wildcard_illegal');
});

test('D9 动作目标不能是通配条目', () => {
  expectRejected(normalizeTarget('*.target.com'), 'wildcard_illegal');
});

// ═════════════════════════ E. 匹配语义 ═════════════════════════

test('E1 子域精确匹配，不隐含通配', () => {
  expectRejected(
    evaluateScope({
      target: 'a.target.com',
      protocol: 'tcp',
      port: 443,
      scope: BASIC,
      adjudicatedAddresses: { 'a.target.com': ['93.184.216.34'] },
    }),
    'out_of_scope',
  );
  expectOk(
    evaluateScope({
      target: 'target.com',
      protocol: 'tcp',
      port: 443,
      scope: BASIC,
      adjudicatedAddresses: { 'target.com': ['93.184.216.34'] },
    }),
  );
});

test('E2 显式通配只匹配一级子域，不含多级嵌套，也不含裸域', () => {
  const wild = scope([wildcardTarget('*.target.com', ['tcp'], [port(443)])]);
  const evaluate = (host: string) =>
    evaluateScope({
      target: host,
      protocol: 'tcp',
      port: 443,
      scope: wild,
      adjudicatedAddresses: { [host]: ['93.184.216.34'] },
    });
  expectOk(evaluate('a.target.com'));
  expectRejected(evaluate('a.b.target.com'), 'out_of_scope');
  expectRejected(evaluate('target.com'), 'out_of_scope');
});

test('E3 URL 只比 scheme/host/port，路径与查询串不参与', () => {
  const s = scope([target('url', 'https://target.com', ['tcp'])]);
  expectOk(
    evaluateScope({
      target: 'https://target.com/a/b?c=d#e',
      protocol: 'tcp',
      scope: s,
      adjudicatedAddresses: { 'target.com': ['93.184.216.34'] },
    }),
  );
  // scheme 不同（http → 80）不匹配 URL 条目
  expectRejected(
    evaluateScope({ target: 'http://target.com/a', protocol: 'tcp', scope: s, adjudicatedAddresses: { 'target.com': ['93.184.216.34'] } }),
    'out_of_scope',
  );
});

test('E4 URL 端口越界在范围内即报端口未授权，而非静默放行', () => {
  const s = scope([target('url', 'https://target.com', ['tcp'])]);
  expectRejected(
    evaluateScope({
      target: 'https://target.com:8443/',
      protocol: 'tcp',
      scope: s,
      adjudicatedAddresses: { 'target.com': ['93.184.216.34'] },
    }),
    'port_not_allowed',
  );
});

test('E5 协议未声明时拒绝，不因“没有端口”跳过校验', () => {
  expectRejected(
    evaluateScope({ target: 'target.com', port: 443, scope: BASIC, adjudicatedAddresses: { 'target.com': ['93.184.216.34'] } }),
    'protocol_undetermined',
  );
  expectRejected(
    evaluateScope({ target: 'target.com', protocol: 'sctp' as Protocol, port: 443, scope: BASIC }),
    'protocol_undetermined',
  );
});

test('E6 URL scheme 与声明协议冲突时拒绝', () => {
  expectRejected(
    evaluateScope({ target: 'https://target.com/', protocol: 'udp', scope: BASIC, adjudicatedAddresses: { 'target.com': ['93.184.216.34'] } }),
    'protocol_not_allowed',
  );
});

test('E7 ICMP 没有端口维度：只看目标与类型，不接受端口参数', () => {
  const s = scope([target('ip', '10.0.0.1', ['icmp'])]);
  expectOk(evaluateScope({ target: '10.0.0.1', protocol: 'icmp', scope: s }));
  expectRejected(evaluateScope({ target: '10.0.0.1', protocol: 'icmp', port: 7, scope: s }), 'port_not_allowed');
  // ICMP 条目不放行 TCP
  expectRejected(evaluateScope({ target: '10.0.0.1', protocol: 'tcp', port: 443, scope: s }), 'protocol_not_allowed');
});

test('E7b 没有端口维度的动作（DNS/WHOIS/CT 一类）只按目标与协议判定', () => {
  // 起因（2026-10-06）：结构化侦察模板里有一族声明 `portSource: none`——它们要么发往解析器、
  // 要么发往第三方，端口不属于**目标**。若空端口集合仍走端口判定，这些动作会被判成
  // 「端口不在范围内」而永久不可用（实测踩到）。端口维度缺失 ⇒ 该维度不参与判定；
  // 协议维度照旧生效（「授权了 tcp 没授权 udp」仍然要说清）。
  const tcpOnly = scope([target('domain', 'target.com', ['tcp'], [port(443)])]);
  expectOk(
    evaluateScope({
      target: 'target.com',
      protocol: 'tcp',
      scope: tcpOnly,
      adjudicatedAddresses: { 'target.com': ['93.184.216.34'] },
    }),
  );
  expectRejected(
    evaluateScope({ target: 'target.com', protocol: 'udp', scope: tcpOnly, adjudicatedAddresses: { 'target.com': ['93.184.216.34'] } }),
    'protocol_not_allowed',
  );
  // 有端口维度的动作不受影响：80 不在条目声明的 443 里，照旧拒绝。
  expectRejected(
    evaluateScope({
      target: 'target.com',
      protocol: 'tcp',
      port: 80,
      scope: tcpOnly,
      adjudicatedAddresses: { 'target.com': ['93.184.216.34'] },
    }),
    'port_not_allowed',
  );
});

test('E8 主机名条目未指定端口时按默认端口 80/443 匹配', () => {
  const s = scope([target('domain', 'target.com', ['tcp'])]);
  const evaluate = (portNumber: number) =>
    evaluateScope({
      target: 'target.com',
      protocol: 'tcp',
      port: portNumber,
      scope: s,
      adjudicatedAddresses: { 'target.com': ['93.184.216.34'] },
    });
  expectOk(evaluate(80));
  expectOk(evaluate(443));
  expectRejected(evaluate(8443), 'port_not_allowed');
});

test('E9 任意端口只作为显式选项存在（0-65535 区间），仍记录在范围条目中', () => {
  const s = scope([target('domain', 'target.com', ['tcp'], [ANY_PORT])]);
  expectOk(
    evaluateScope({
      target: 'target.com',
      protocol: 'tcp',
      port: 31337,
      scope: s,
      adjudicatedAddresses: { 'target.com': ['93.184.216.34'] },
    }),
  );
});

test('E10 网段按地址匹配，网段外拒绝', () => {
  const s = scope([target('cidr', '10.0.0.0/8', ['tcp'], [port(443)])]);
  expectOk(evaluateScope({ target: '10.9.9.9', protocol: 'tcp', port: 443, scope: s }));
  expectRejected(evaluateScope({ target: '11.0.0.1', protocol: 'tcp', port: 443, scope: s }), 'out_of_scope');
  expectRejected(evaluateScope({ target: '10.9.9.9', protocol: 'tcp', port: 80, scope: s }), 'port_not_allowed');
});

test('E11 共享 IP 不按 IP 放行：域名解析到范围内 IP 不因此获得授权', () => {
  const s = scope([target('ip', '93.184.216.34', ['tcp'], [port(443)])]);
  // 字面量 IP 在范围内
  expectOk(evaluateScope({ target: '93.184.216.34', protocol: 'tcp', port: 443, scope: s }));
  // 域名解析到同一地址仍在范围外
  expectRejected(
    evaluateScope({
      target: 'shared-host.example',
      protocol: 'tcp',
      port: 443,
      scope: s,
      adjudicatedAddresses: { 'shared-host.example': ['93.184.216.34'] },
    }),
    'out_of_scope',
  );
});

test('E12 IPv6 网段只匹配 IPv6 目标，IPv4 目标不匹配（不同地址族）', () => {
  const s = scope([target('cidr', '2001:db8::/32', ['tcp'], [port(443)])]);
  expectOk(evaluateScope({ target: '2001:db8::5', protocol: 'tcp', port: 443, scope: s }));
  expectRejected(evaluateScope({ target: '10.0.0.1', protocol: 'tcp', port: 443, scope: s }), 'out_of_scope');
});

// ═════════════════════════ F. 范围加载校验 ═════════════════════════

test('F1 网段条目未声明端口即按默认 80/443 加载（不再拒绝）', () => {
  // 此前这里拒绝（`port_required_for_cidr`），理由是「否则可能触达该网段全部端口」。
  // 那个理由在实现上不成立：`effectivePorts` 对空端口一律展开成 80/443，**不看 kind**。
  // 所以这条限制没有守住任何东西，只是让「填个网段就得多写一个端口」变成强制动作。
  const loaded = loadScopeRuleSet(scope([target('cidr', '10.0.0.0/8', ['tcp'])]));
  assert.equal(loaded.ok, true);

  // 关键：加载成功后，匹配**仍然只到 80/443**——放宽的是表单，不是边界。
  const inRange = scope([target('cidr', '10.0.0.0/8', ['tcp'])]);
  // 匹配期端口不匹配的码是 `port_not_allowed`（`out_of_scope` 留给「主机不在范围内」）。
  expectRejected(
    evaluateScope({ target: '10.1.2.3', protocol: 'tcp', port: 8080, scope: inRange }),
    'port_not_allowed',
  );
  expectOk(evaluateScope({ target: '10.1.2.3', protocol: 'tcp', port: 443, scope: inRange }));
});

test('F2 网段条目未声明协议即拒绝加载', () => {
  const loaded = loadScopeRuleSet(scope([target('cidr', '10.0.0.0/8', [], [port(443)])]));
  assert.equal(loaded.ok, false);
  if (!loaded.ok) assert.equal(loaded.code, 'protocol_undetermined');
});

test('F3 ICMP-only 条目声明端口即拒绝加载（ICMP 没有端口维度）', () => {
  const loaded = loadScopeRuleSet(scope([target('ip', '10.0.0.1', ['icmp'], [port(7)])]));
  assert.equal(loaded.ok, false);
  if (!loaded.ok) assert.equal(loaded.code, 'port_not_allowed');
});

test('F4 任意一条条目非法即整体拒绝加载（fail-closed）', () => {
  // 用一条**真的**非法条目验 fail-closed：ICMP-only 却声明了端口（ICMP 没有端口维度）。
  const loaded = loadScopeRuleSet(
    scope([target('domain', 'ok.example', ['tcp'], [port(443)]), target('ip', '10.0.0.1', ['icmp'], [port(7)])]),
  );
  assert.equal(loaded.ok, false);
  if (!loaded.ok) {
    assert.equal(loaded.code, 'port_not_allowed');
    assert.match(loaded.detail, /targets\[1\]/, '必须点名是哪一条');
  }
  // 判定入口同样 fail-closed
  expectRejected(
    evaluateScope({
      target: '8.8.8.8', protocol: 'tcp', port: 443,
      scope: scope([target('ip', '10.0.0.1', ['icmp'], [port(7)])]),
    }),
    'port_not_allowed',
  );
});

test('F5 非法端口区间拒绝加载', () => {
  const loaded = loadScopeRuleSet(scope([target('domain', 'target.com', ['tcp'], [port(900, 100)])]));
  assert.equal(loaded.ok, false);
  if (!loaded.ok) assert.equal(loaded.code, 'malformed_target');
});

test('F6 URL 条目 scheme 与声明协议冲突时拒绝加载', () => {
  const loaded = loadScopeRuleSet(scope([target('url', 'https://target.com', ['udp'], [port(443)])]));
  assert.equal(loaded.ok, false);
  if (!loaded.ok) assert.equal(loaded.code, 'protocol_not_allowed');
});

test('F7 URL 条目声明的端口与 URL 自身端口矛盾时拒绝加载', () => {
  const loaded = loadScopeRuleSet(scope([target('url', 'https://target.com', ['tcp'], [port(80)])]));
  assert.equal(loaded.ok, false);
  if (!loaded.ok) assert.equal(loaded.code, 'malformed_target');
  // 自洽的声明允许加载
  assert.equal(loadScopeRuleSet(scope([target('url', 'https://target.com:8443', ['tcp'], [port(8443)])])).ok, true);
});

// ═════════════════════════ G. 排除项优先与资产裁决 ═════════════════════════

test('G1 同时命中包含与排除时按排除处理', () => {
  const s = scope(
    [target('domain', 'target.com', ['tcp'], [port(443)])],
    [target('domain', 'target.com', ['tcp'], [port(443)])],
  );
  expectRejected(
    evaluateScope({
      target: 'target.com',
      protocol: 'tcp',
      port: 443,
      scope: s,
      adjudicatedAddresses: { 'target.com': ['93.184.216.34'] },
    }),
    'excluded',
  );
});

test('G2 排除项是包含项的子集时，只排除子集内的目标', () => {
  const s = scope(
    [target('cidr', '10.0.0.0/8', ['tcp'], [port(443)])],
    [target('cidr', '10.5.0.0/16', ['tcp'], [port(443)])],
  );
  expectRejected(evaluateScope({ target: '10.5.1.1', protocol: 'tcp', port: 443, scope: s }), 'excluded');
  expectOk(evaluateScope({ target: '10.6.1.1', protocol: 'tcp', port: 443, scope: s }));
});

test('G3 域名解析出的裁决地址落在排除网段内时按排除处理', () => {
  const s = scope(
    [target('domain', 'target.com', ['tcp'], [port(443)])],
    [target('cidr', '93.184.216.0/24', ['tcp'], [port(443)])],
  );
  expectRejected(
    evaluateScope({
      target: 'target.com',
      protocol: 'tcp',
      port: 443,
      scope: s,
      adjudicatedAddresses: { 'target.com': ['93.184.216.34'] },
    }),
    'excluded',
  );
});

test('G4 人类裁决为 pending 的资产不放行', () => {
  const s = scope([target('domain', 'other.example', ['tcp'], [port(443)])], [], [
    { assetId: 'domain:pending.example', decision: 'pending' },
  ]);
  expectRejected(
    evaluateScope({ target: 'pending.example', protocol: 'tcp', port: 443, scope: s, adjudicatedAddresses: { 'pending.example': ['93.184.216.34'] } }),
    'pending',
  );
});

test('G4b pending 资产落在宽泛范围条目内仍然被拒（不得被范围条目绕过）', () => {
  // 回归用例：这里曾经放行。逐资产的人类裁决比范围条目更具体、更新，
  // 必须短路返回；被范围条目的匹配「改善」为 ok 就等于绕过了人类的暂缓决定。
  const s = scope(
    [target('cidr', '10.0.0.0/24', ['tcp'], [port(80)])],
    [],
    [{ assetId: 'ip:10.0.0.5', decision: 'pending' }],
  );
  expectRejected(
    evaluateScope({ target: '10.0.0.5', protocol: 'tcp', port: 80, scope: s }),
    'pending',
  );
});

test('G4c 排除优先：excluded 资产落在宽泛范围条目内被拒', () => {
  const s = scope(
    [target('cidr', '10.0.0.0/24', ['tcp'], [port(80)])],
    [],
    [{ assetId: 'ip:10.0.0.5', decision: 'excluded' }],
  );
  expectRejected(
    evaluateScope({ target: '10.0.0.5', protocol: 'tcp', port: 80, scope: s }),
    'excluded',
  );
});

test('G4d 对照：同一网段内未裁决的主机仍按范围条目放行', () => {
  // 确保修复没有把「无裁决」一并拒掉——那是过度收紧。
  const s = scope(
    [target('cidr', '10.0.0.0/24', ['tcp'], [port(80)])],
    [],
    [{ assetId: 'ip:10.0.0.5', decision: 'pending' }],
  );
  expectOk(evaluateScope({ target: '10.0.0.6', protocol: 'tcp', port: 80, scope: s }));
});

test('G4e included 裁决可让不在任何范围条目内的目标通过', () => {
  const s = scope([], [], [{ assetId: 'ip:192.0.2.9', decision: 'included' }]);
  expectOk(evaluateScope({ target: '192.0.2.9', protocol: 'tcp', port: 443, scope: s }));
});

test('G5 人类裁决为 included 的目标无需再列条目即通过', () => {
  const s = scope([], [], [{ assetId: 'included.example', decision: 'included' }]);
  expectOk(
    evaluateScope({
      target: 'included.example',
      protocol: 'tcp',
      port: 443,
      scope: s,
      adjudicatedAddresses: { 'included.example': ['93.184.216.34'] },
    }),
  );
});

test('G6 人类裁决为 excluded 的目标即使有条目也拒绝', () => {
  const s = scope([target('domain', 'target.com', ['tcp'], [port(443)])], [], [
    { assetId: 'domain:target.com', decision: 'excluded' },
  ]);
  expectRejected(
    evaluateScope({
      target: 'target.com',
      protocol: 'tcp',
      port: 443,
      scope: s,
      adjudicatedAddresses: { 'target.com': ['93.184.216.34'] },
    }),
    'excluded',
  );
});

// ═════════════════════════ H. 重定向逐跳校验 ═════════════════════════

const REDIRECT_SCOPE = scope(
  [target('domain', 'target.com', ['tcp'], [port(443)]), target('domain', 'cdn.target.com', ['tcp'], [port(443)])],
  [target('domain', 'blocked.target.com', ['tcp'], [port(443)])],
);

const REDIRECT_ADDRESSES: AdjudicatedAddresses = {
  'target.com': ['93.184.216.34'],
  'cdn.target.com': ['93.184.216.35'],
  'blocked.target.com': ['93.184.216.36'],
  'evil.example': ['203.0.113.9'],
};

test('H1 每一跳都合法时整链通过，并返回各跳的规范化结果', () => {
  const verdict = evaluateRedirectChain({
    chain: ['https://target.com/a', 'https://cdn.target.com/b'],
    scope: REDIRECT_SCOPE,
    adjudicatedAddresses: REDIRECT_ADDRESSES,
  });
  assert.equal(verdict.ok, true);
  if (verdict.ok) {
    assert.equal(verdict.hops.length, 2);
    assert.deepEqual(verdict.hops.map((hop) => hop.host), ['target.com', 'cdn.target.com']);
  }
});

test('H2 第二跳跳出范围时整条链被拒绝，并给出越界跳序号', () => {
  const verdict = evaluateRedirectChain({
    chain: ['https://target.com/a', 'https://evil.example/b'],
    scope: REDIRECT_SCOPE,
    adjudicatedAddresses: REDIRECT_ADDRESSES,
  });
  assert.equal(verdict.ok, false);
  if (!verdict.ok) {
    assert.equal(verdict.code, 'out_of_scope');
    assert.equal(verdict.hopIndex, 1);
  }
});

test('H3 第二跳命中排除项时整条链被拒绝', () => {
  const verdict = evaluateRedirectChain({
    chain: ['https://target.com/a', 'https://blocked.target.com/b'],
    scope: REDIRECT_SCOPE,
    adjudicatedAddresses: REDIRECT_ADDRESSES,
  });
  assert.equal(verdict.ok, false);
  if (!verdict.ok) {
    assert.equal(verdict.code, 'excluded');
    assert.equal(verdict.hopIndex, 1);
  }
});

test('H4 跳转目标使用非 HTTP scheme 时拒绝（协议无法确定 / 非 HTTP 路径）', () => {
  const verdict = evaluateRedirectChain({
    chain: ['https://target.com/a', 'ftp://cdn.target.com/b'],
    scope: REDIRECT_SCOPE,
    adjudicatedAddresses: REDIRECT_ADDRESSES,
  });
  assert.equal(verdict.ok, false);
  if (!verdict.ok) {
    assert.equal(verdict.code, 'protocol_undetermined');
    assert.equal(verdict.hopIndex, 1);
  }
});

test('H5 后续跳含 userinfo 时拒绝，不因首跳合法而放行', () => {
  const verdict = evaluateRedirectChain({
    chain: ['https://target.com/a', 'https://cdn.target.com@evil.example/'],
    scope: REDIRECT_SCOPE,
    adjudicatedAddresses: REDIRECT_ADDRESSES,
  });
  assert.equal(verdict.ok, false);
  if (!verdict.ok) {
    assert.equal(verdict.code, 'userinfo_present');
    assert.equal(verdict.hopIndex, 1);
  }
});

test('H6 空重定向链拒绝', () => {
  const verdict = evaluateRedirectChain({ chain: [], scope: REDIRECT_SCOPE });
  assert.equal(verdict.ok, false);
  if (!verdict.ok) {
    assert.equal(verdict.code, 'malformed_target');
    assert.equal(verdict.hopIndex, -1);
  }
});

// ═════════════════════════ I. 地址固定 ═════════════════════════

test('I1 拨号地址命中裁决集合时通过', () => {
  const verdict = evaluateScope({
    target: 'target.com',
    protocol: 'tcp',
    port: 443,
    scope: BASIC,
    adjudicatedAddresses: { 'target.com': ['93.184.216.34', '93.184.216.35'] },
  });
  const normalized = expectOk(verdict);
  assert.deepEqual(normalized.resolvedAddresses, ['93.184.216.34', '93.184.216.35']);
  assert.equal(assertAdjudicatedAddress(normalized, '93.184.216.35').ok, true);
});

test('I2 拨号地址不在裁决集合内时拒绝（DNS 重绑定）', () => {
  const normalized = expectOk(
    evaluateScope({
      target: 'target.com',
      protocol: 'tcp',
      port: 443,
      scope: BASIC,
      adjudicatedAddresses: { 'target.com': ['93.184.216.34'] },
    }),
  );
  const verdict = assertAdjudicatedAddress(normalized, '203.0.113.9');
  expectRejected(verdict, 'address_not_adjudicated');
});

test('I3 等价写法视为同一地址：IPv4 映射拨号命中 IPv4 裁决地址', () => {
  const normalized = expectOk(
    evaluateScope({
      target: 'target.com',
      protocol: 'tcp',
      port: 443,
      scope: BASIC,
      adjudicatedAddresses: { 'target.com': ['93.184.216.34'] },
    }),
  );
  assert.equal(assertAdjudicatedAddress(normalized, '::ffff:93.184.216.34').ok, true);
});

test('I4 没有裁决地址集合时拒绝，不退化为按域名拨号', () => {
  const bare: NormalizedTarget = { kind: 'domain', host: 'target.com' };
  expectRejected(assertAdjudicatedAddress(bare, '93.184.216.34'), 'dns_unresolved');
  expectRejected(assertAdjudicatedAddress({ ...bare, resolvedAddresses: [] }, '93.184.216.34'), 'dns_unresolved');
});

test('I5 在范围但未解析出任何地址时拒绝连接', () => {
  expectRejected(
    evaluateScope({ target: 'target.com', protocol: 'tcp', port: 443, scope: BASIC }),
    'dns_unresolved',
  );
  expectRejected(
    evaluateScope({ target: 'target.com', protocol: 'tcp', port: 443, scope: BASIC, adjudicatedAddresses: { 'target.com': [] } }),
    'dns_unresolved',
  );
});

test('I6 裁决集合含非规范地址（zone id）时拒绝', () => {
  expectRejected(
    evaluateScope({
      target: 'target.com',
      protocol: 'tcp',
      port: 443,
      scope: BASIC,
      adjudicatedAddresses: { 'target.com': ['fe80::1%eth0'] },
    }),
    'noncanonical_ip',
  );
});

test('I7 字面量 IP 目标的裁决地址是其自身', () => {
  const s = scope([target('ip', '10.0.0.1', ['tcp'], [port(443)])]);
  const normalized = expectOk(evaluateScope({ target: '10.0.0.1', protocol: 'tcp', port: 443, scope: s }));
  assert.deepEqual(normalized.resolvedAddresses, ['10.0.0.1']);
  assert.equal(assertAdjudicatedAddress(normalized, '10.0.0.1').ok, true);
});

// ═════════════════════════ J. 资产标签 ═════════════════════════

const REGISTRY = { web: ['api.target.com', '10.0.0.0/8'], empty: [] };

test('J1 资产标签条目展开为登记的具体目标集合，并继承条目的协议与端口约束', () => {
  const s = scope([target('asset-label', 'web', ['tcp'], [port(443)])]);
  expectOk(
    evaluateScope({
      target: 'api.target.com',
      protocol: 'tcp',
      port: 443,
      scope: s,
      assetRegistry: REGISTRY,
      adjudicatedAddresses: { 'api.target.com': ['93.184.216.34'] },
    }),
  );
  expectOk(evaluateScope({ target: '10.0.0.5', protocol: 'tcp', port: 443, scope: s, assetRegistry: REGISTRY }));
  expectRejected(
    evaluateScope({
      target: 'other.target.com',
      protocol: 'tcp',
      port: 443,
      scope: s,
      assetRegistry: REGISTRY,
      adjudicatedAddresses: { 'other.target.com': ['93.184.216.34'] },
    }),
    'out_of_scope',
  );
});

test('J2 资产标签条目未声明端口即按默认 80/443 加载（与 F1 同口径）', () => {
  const loaded = loadScopeRuleSet(scope([target('asset-label', 'web', ['tcp'])]), { assetRegistry: REGISTRY });
  assert.equal(loaded.ok, true, '与网段条目一致：留空端口 = 默认 80/443，不再拒绝');
});

test('J3 未登记或登记为空的资产标签拒绝加载', () => {
  assert.equal(expandAssetLabel('unknown', REGISTRY).ok, false);
  assert.equal(expandAssetLabel('empty', REGISTRY).ok, false);
  const loaded = loadScopeRuleSet(scope([target('asset-label', 'unknown', ['tcp'], [port(443)])]), { assetRegistry: REGISTRY });
  assert.equal(loaded.ok, false);
  if (!loaded.ok) assert.equal(loaded.code, 'malformed_target');
});

test('J4 标签成员非法时按成员错误码拒绝（成员携带具体拒绝理由）', () => {
  const loaded = loadScopeRuleSet(scope([target('asset-label', 'bad', ['tcp'], [port(443)])]), {
    assetRegistry: { bad: ['2130706433'] },
  });
  assert.equal(loaded.ok, false);
  if (!loaded.ok) {
    assert.equal(loaded.code, 'noncanonical_ip');
    assert.match(loaded.detail, /2130706433/);
  }
});

test('J5 资产标签在规范化工具中展开为唯一目标时可用，多目标时需按条目展开', () => {
  assert.equal(expectOk(normalizeTarget('@single', { assetRegistry: { single: ['api.target.com'] } })).host, 'api.target.com');
  expectRejected(normalizeTarget('@web', { assetRegistry: REGISTRY }), 'malformed_target');
});
