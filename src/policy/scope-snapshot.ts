/**
 * 范围的**规范化与哈希**（设计文档 §6.2.0.5、§9.2、§10.2.2）。
 *
 * ── 为什么单独一个模块 ──
 *
 * 创建、确认、修订三条路径此前各拼一份哈希，而且都只哈希 `targets`：
 *
 *     sha256(base64url(JSON.stringify(targets)).slice(0, 43))
 *
 * 两个缺陷：**排除项没有参与**（只改 exclusions 会复用同一个内容哈希，
 * 而排除项恰恰是「哪些不能打」这条边界），以及 base64url 截断后不是稳定摘要格式。
 * 抽屉里的第三个问题是三处实现必然漂移，而漂移的表现是「范围版本看起来没变」。
 *
 * 因此这里定义唯一的一份：**规范化 → 规范 JSON → 完整 SHA-256**，
 * 覆盖目标、排除项、授权引用与版本号。判定仍由 `scope.ts` 的唯一实现负责
 * （本模块只做条目级的规范化与稳定序列化，不复制匹配规则）。
 */

import { createHash } from 'node:crypto';
import type { PortRange, Protocol, ScopeTarget } from '../contracts.ts';
import { canonicalPolicyJson } from './behavior-profile.ts';
import { normalizeScopeEntry } from './scope.ts';
import type { NormalizedScopeEntry, Result } from './scope.ts';

export type ScopeContentHash = `sha256:${string}`;

function sortPorts(ports: readonly PortRange[]): readonly PortRange[] {
  return [...ports].sort((a, b) => (a.from - b.from) || (a.to - b.to));
}

/** 协议集合的稳定顺序：规范化结果与输入顺序无关，否则等价范围会得到不同哈希。 */
function sortProtocols(protocols: readonly Protocol[]): readonly Protocol[] {
  return [...protocols].sort();
}

/**
 * 规范化条目 → 规范 `ScopeTarget`。
 *
 * 只保留判定真正读取的字段：`kind` / `value` / `protocols` / `ports` /
 * `wildcardSubdomain`。原始书写形态（大小写、尾点、IDN 原文）不进入规范形式——
 * 它们可以由规范化结果重建，而保留它们会让「同一个目标写两遍」得到两个哈希。
 */
export function canonicalScopeTarget(entry: NormalizedScopeEntry): ScopeTarget {
  const protocols = sortProtocols(entry.protocols);
  const ports = sortPorts(entry.ports);
  switch (entry.kind) {
    case 'url':
      return {
        kind: 'url',
        value: `${entry.scheme ?? 'http'}://${entry.host.includes(':') ? `[${entry.host}]` : entry.host}:${String(entry.port ?? 80)}`,
        protocols,
        ports,
      };
    case 'cidr':
      return {
        kind: 'cidr',
        value: `${entry.cidr?.network ?? entry.host}/${String(entry.cidr?.prefix ?? 0)}`,
        protocols,
        ports,
      };
    case 'asset-label':
      return { kind: 'asset-label', value: `@${entry.host}`, protocols, ports };
    default:
      return {
        kind: entry.kind,
        value: entry.wildcardSubdomain ? `*.${entry.host}` : entry.host,
        protocols,
        ports,
        ...(entry.wildcardSubdomain ? { wildcardSubdomain: true } : {}),
      };
  }
}

export interface NormalizedScope {
  readonly targets: readonly ScopeTarget[];
  readonly exclusions: readonly ScopeTarget[];
}

/**
 * 规范化一份范围（创建、确认、修订共用）。
 *
 * **不展开资产标签**：本函数只服务快照写入路径，而那条路径上还没有本作业的资产登记表
 * （资产是 Agent 在阶段里发现的）。标签的语义是「展开为当前范围版本内已登记的资产」，
 * 那是判定期（`loadScopeRuleSet` 带 registry）的事；在这里强行展开必然失败，
 * 而那会把一个合法条目变成「创建不了作业」。这里只校验标签条目的形态。
 */
export function normalizeScope(input: {
  readonly targets: readonly ScopeTarget[];
  readonly exclusions: readonly ScopeTarget[];
}): Result<NormalizedScope> {
  const normalize = (entries: readonly ScopeTarget[], bucket: string): Result<readonly ScopeTarget[]> => {
    const out: ScopeTarget[] = [];
    for (let index = 0; index < entries.length; index += 1) {
      const entry = entries[index];
      if (entry === undefined) continue;
      const normalized = normalizeScopeEntry(entry, { staticAssetLabels: true });
      if (!normalized.ok) {
        return {
          ok: false,
          code: normalized.code,
          detail: `${bucket}[${String(index)}] ${normalized.detail}`,
        };
      }
      out.push(canonicalScopeTarget(normalized.value));
    }
    return { ok: true, value: out };
  };

  const targets = normalize(input.targets, '目标');
  if (!targets.ok) return targets;
  const exclusions = normalize(input.exclusions, '排除项');
  if (!exclusions.ok) return exclusions;
  return { ok: true, value: { targets: targets.value, exclusions: exclusions.value } };
}

/**
 * 范围版本的内容哈希：覆盖**完整**规范化范围。
 *
 * 覆盖集合是刻意的：`targets`（能打什么）、`exclusions`（不能打什么）、
 * `authorizationRef`（依据什么授权）、`version`（第几次边界）。
 * 只改排除项必然产生不同哈希——这正是此前那个截断哈希丢掉的判别力。
 */
export function scopeContentHash(input: {
  readonly targets: readonly ScopeTarget[];
  readonly exclusions: readonly ScopeTarget[];
  readonly authorizationRef: string | null;
  readonly version: number;
}): ScopeContentHash {
  const canonical = canonicalPolicyJson({
    scope_schema: 1,
    version: input.version,
    authorization_ref: input.authorizationRef,
    targets: input.targets.map((entry) => serializeTarget(entry)),
    exclusions: input.exclusions.map((entry) => serializeTarget(entry)),
  });
  return `sha256:${createHash('sha256').update(canonical, 'utf8').digest('hex')}`;
}

function serializeTarget(entry: ScopeTarget): Readonly<Record<string, unknown>> {
  return {
    kind: entry.kind,
    value: entry.value,
    protocols: sortProtocols(entry.protocols),
    ports: sortPorts(entry.ports).map((range) => ({ from: range.from, to: range.to })),
    wildcard_subdomain: entry.wildcardSubdomain === true,
  };
}
