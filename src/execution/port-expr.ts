/**
 * 端口表达式与扫描档位 → 范围判定用的端口集合（2026-10-10）。
 *
 * **存在理由**：`port_scan` / `service_probe` 的端口是表达式（`80,443,8000-8100`）
 * 或 nmap 档位（`--top-ports 100` / `-p 1-65535`）。范围闸门必须知道"这次动作将要
 * 触及哪些端口"才能核验授权——此前这两个动作在 `portSource` 里声明 `none`，
 * 闸门回落默认 web 端口，把显式的 `ports="3002"` 判成"要打 80|443"并拒绝，
 * 单端口范围条目下的服务识别能力实际为空（操作者实测 P0）。
 *
 * **与容器分发器的关系**：`common_services` 的端口清单与 `full_tcp` 的范围必须与
 * `docker/tools/pentest-tool` 的 `NMAP_SCOPE_ARGS` 逐字一致——由
 * `test/action-templates.test.ts` 直接解析分发器源码对拍（同一套思路：
 * 不手抄、不双写）。`top100` / `top1000` 由 nmap 自己决定端口集，**无法在宿主侧枚举**，
 * 因此如实表达为 `unbounded`：只有条目授权全 TCP 时闸门才放行。
 */

import type { PortRange, ScopePorts } from '../contracts.ts';

/** 表达式形状：与模板参数 pattern 和容器侧 `PORT_EXPR_RE` 同一形状（≤64 段）。 */
const PORT_EXPR_RE = /^\d{1,5}(-\d{1,5})?(,\d{1,5}(-\d{1,5})?){0,63}$/;

/**
 * nmap 档位 → 宿主侧可核验的端口集合。
 *
 * `top100` / `top1000` 故意为 `null`：nmap 版本决定其端口清单，宿主侧枚举不出来，
 * 也就不该假装能核验。`full_tcp` 与 `common_services` 是显式清单，可逐段核验。
 */
export const SCAN_PRESETS: Readonly<Record<string, readonly PortRange[] | null>> = Object.freeze({
  top100: null,
  top1000: null,
  common_services: [
    { from: 21, to: 21 },
    { from: 22, to: 22 },
    { from: 23, to: 23 },
    { from: 25, to: 25 },
    { from: 53, to: 53 },
    { from: 80, to: 80 },
    { from: 110, to: 110 },
    { from: 111, to: 111 },
    { from: 135, to: 135 },
    { from: 139, to: 139 },
    { from: 143, to: 143 },
    { from: 443, to: 443 },
    { from: 445, to: 445 },
    { from: 465, to: 465 },
    { from: 587, to: 587 },
    { from: 993, to: 993 },
    { from: 995, to: 995 },
    { from: 1433, to: 1433 },
    { from: 1521, to: 1521 },
    { from: 2049, to: 2049 },
    { from: 3306, to: 3306 },
    { from: 3389, to: 3389 },
    { from: 5060, to: 5060 },
    { from: 5432, to: 5432 },
    { from: 5900, to: 5900 },
    { from: 5985, to: 5985 },
    { from: 6379, to: 6379 },
    { from: 8080, to: 8080 },
    { from: 8443, to: 8443 },
    { from: 9200, to: 9200 },
    { from: 11211, to: 11211 },
    { from: 27017, to: 27017 },
  ],
  full_tcp: [{ from: 1, to: 65535 }],
});

export type PortsResolution =
  | { readonly ok: true; readonly ports: ScopePorts }
  | { readonly ok: false; readonly detail: string };

/**
 * 解析端口表达式 → 区间集合。不接受空串（调用方先判 `none`）。
 * 拒绝未知形状、越界端口与倒置区间——**拒绝**而不是尽力解析：范围记账不允许猜。
 */
export function parsePortExpression(expr: string): PortsResolution {
  const text = expr.trim();
  if (!PORT_EXPR_RE.test(text)) {
    return { ok: false, detail: `端口表达式 ${text} 形状非法（形如 80,443,8000-8100，最多 64 段）` };
  }
  const ranges: PortRange[] = [];
  for (const seg of text.split(',')) {
    const [fromText, toText] = seg.includes('-') ? seg.split('-') : [seg, seg];
    const from = Number(fromText);
    const to = Number(toText);
    if (!Number.isInteger(from) || !Number.isInteger(to) || from < 1 || to > 65535) {
      return { ok: false, detail: `端口段 ${seg} 越界（合法范围 1-65535）` };
    }
    if (from > to) return { ok: false, detail: `端口段 ${seg} 的起止颠倒` };
    ranges.push({ from, to });
  }
  return { ok: true, ports: { kind: 'ranges', ranges } };
}

/**
 * 扫描动作的端口维度：显式表达式优先；`none`/空 → 按档位。
 *
 * 档位在宿主侧不可枚举（`top100`/`top1000`）时返回 `unbounded`——闸门据此要求
 * 条目覆盖全 TCP，或让模型改用显式表达式。未知档位按 `unbounded` 处理：
 * 宁可要人类显式放行，也不假装核验过。
 */
export function resolveScanPorts(explicitExpr: string | undefined, preset: string | undefined): PortsResolution {
  const expr = (explicitExpr ?? '').trim();
  if (expr !== '' && expr !== 'none') return parsePortExpression(expr);
  const key = (preset ?? '').trim();
  const ranges = SCAN_PRESETS[key];
  if (ranges === undefined) return { ok: false, detail: `未知扫描档位 ${key || '(空)'}` };
  if (ranges === null) {
    return { ok: true, ports: { kind: 'unbounded', what: `nmap ${key} 档位` } };
  }
  return { ok: true, ports: { kind: 'ranges', ranges } };
}
