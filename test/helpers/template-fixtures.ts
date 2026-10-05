/**
 * 测试夹具模板（`test/` 专用，不进生产注册表）。
 *
 * 出厂注册表 2026-10-05 起只剩一张直连命令模板（`direct_command`）——五个示例模板已随
 * 「清理模板」删除（镜像里有真工具，Agent 直接写命令，不必先猜模板名）。但许多用例考的是
 * **机制**：注册表不变量、参数白名单、端口来源、类别判定。这些规则对任意模板都成立，
 * 用显式夹具比"恰好依赖出厂那五个"更能说明问题，也不会因为出厂集变化而整片变红。
 */
import type { ActionTemplateSpec } from '../../src/execution/templates.ts';

export const HTTP_READ_TEMPLATE: ActionTemplateSpec = {
  template: {
    id: 'http_read',
    actionClass: 'passive_read',
    tool: 'http_get',
    parameters: [
      { name: 'method', kind: 'enum', values: ['GET', 'HEAD'] },
      { name: 'path', kind: 'string', pattern: '^/[^?]*$' },
      { name: 'follow_redirects', kind: 'enum', values: ['true', 'false'] },
    ],
    targetPlaceholder: 'target',
    timeoutMs: 15_000,
    maxOutputBytes: 256 * 1024,
  },
  protocol: 'tcp',
  portSource: { kind: 'target' },
  carries: { method: 'HTTP 方法', path: '请求路径（不接受查询串）', follow_redirects: '是否跟随重定向' },
  commandTemplate: 'http_get target={target} method={method} path={path} follow_redirects={follow_redirects}',
};

export const TCP_CONNECT_TEMPLATE: ActionTemplateSpec = {
  template: {
    id: 'tcp_connect',
    actionClass: 'active_discovery',
    tool: 'tcp_connect',
    parameters: [{ name: 'port', kind: 'integer', min: 1, max: 65535 }],
    targetPlaceholder: 'target',
    timeoutMs: 10_000,
    maxOutputBytes: 64 * 1024,
  },
  protocol: 'tcp',
  portSource: { kind: 'param', param: 'port' },
  carries: { port: '目标端口' },
  commandTemplate: 'tcp_connect target={target} port={port}',
};

export const UDP_PROBE_TEMPLATE: ActionTemplateSpec = {
  template: {
    id: 'udp_probe',
    actionClass: 'active_discovery',
    tool: 'udp_probe',
    parameters: [{ name: 'port', kind: 'integer', min: 1, max: 65535 }],
    targetPlaceholder: 'target',
    timeoutMs: 5_000,
    maxOutputBytes: 32 * 1024,
  },
  protocol: 'udp',
  portSource: { kind: 'param', param: 'port' },
  carries: { port: '目标端口' },
  commandTemplate: 'udp_probe target={target} port={port}',
};

export const ICMP_PING_TEMPLATE: ActionTemplateSpec = {
  template: {
    id: 'icmp_ping',
    actionClass: 'active_discovery',
    tool: 'icmp_ping',
    parameters: [
      { name: 'count', kind: 'integer', min: 1, max: 10 },
      { name: 'size', kind: 'integer', min: 1, max: 1400 },
    ],
    targetPlaceholder: 'target',
    timeoutMs: 6_000,
    maxOutputBytes: 32 * 1024,
  },
  protocol: 'icmp',
  portSource: { kind: 'none' },
  carries: { count: '探测次数', size: '载荷字节数' },
  commandTemplate: 'icmp_ping target={target} count={count} size={size}',
};

export const DNS_LOOKUP_TEMPLATE: ActionTemplateSpec = {
  template: {
    id: 'dns_lookup',
    actionClass: 'passive_read',
    tool: 'dns_resolve',
    parameters: [{ name: 'record_type', kind: 'enum', values: ['A', 'AAAA', 'CNAME', 'TXT', 'MX', 'NS'] }],
    targetPlaceholder: 'target',
    timeoutMs: 5_000,
    maxOutputBytes: 32 * 1024,
  },
  protocol: 'udp',
  portSource: { kind: 'fixed', port: 53 },
  carries: { record_type: '记录类型' },
  commandTemplate: 'dns_resolve target={target} record_type={record_type}',
};

/** 五个代表「机制」的夹具模板（不含出厂那张 `direct_command`，各文件按需自行拼接）。 */
export const MECHANISM_FIXTURES: readonly ActionTemplateSpec[] = [
  HTTP_READ_TEMPLATE,
  TCP_CONNECT_TEMPLATE,
  UDP_PROBE_TEMPLATE,
  ICMP_PING_TEMPLATE,
  DNS_LOOKUP_TEMPLATE,
];
