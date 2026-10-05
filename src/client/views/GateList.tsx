/**
 * 闸门清单（2026-10-05 复核 C4）：**一处**渲染「为什么现在不能做这件事」。
 *
 * ── 收敛掉的东西 ──
 *
 * 此前同一件事有三份实现、三种数据形状、三组样式：
 *
 * | 视图 | 数据形状 | 标记 |
 * |---|---|---|
 * | `ReportExport`（本地 `GateList`） | `{code, message}[]` | `pentest-report-export__gate*` |
 * | `HandoffEditor` | `string[]`（自己去重） | `pentest-handoff__gates` |
 * | `EngagementList`（清空内容） | `string[]` | `pentest-engagement-list__purge-warn` |
 *
 * 而另外几处（`HandoffPanel` / `MemoryExplorer` / `RunControls`）只在按钮的 `reason` 里显示
 * **第一条**——人类看不到剩下的闸门，只能一条条试。
 *
 * ── 分工（与复核的要求一致）──
 *
 * **判定仍留在各视图的纯函数里**（`signBlockers` / `exportBlockers` / `searchBlockers` …）：
 * 它们知道业务（签名绑定哪个哈希、检索要哪些前置）。本组件只负责**呈现**：
 * 统一形状、统一去重、统一标记与可读性。
 */

import { createElement } from 'react';
import type { ReactNode } from 'react';

/**
 * 一条闸门阻塞。
 *
 * `code` 可选：全静态的文案（例如「先选择一个 engagement」）没有稳定的机器判别码，
 * 硬造一个只会制造假标识；有码的那些（`undisposed-findings`、`content-hash-missing`）
 * 会渲染成 `data-blocker`，供测试与人工排查指认。
 */
export interface GateBlocker {
  readonly code?: string;
  readonly message: string;
}

/** 允许直接给字符串：多数判定函数返回的就是 `string[]`。 */
export type GateInput = GateBlocker | string;

/**
 * 归一化 + 去重（按消息文本）。
 *
 * 去重放在这里而不是每个视图各写一次：同一个原因被两条判定分别推出是很常见的
 * （例如「没选 skill」与「没表决 skill 为空」），重复列两行只会让人以为有两个问题。
 */
export function gateBlockersOf(input: readonly GateInput[]): readonly GateBlocker[] {
  const seen = new Set<string>();
  const out: GateBlocker[] = [];
  for (const entry of input) {
    const blocker = typeof entry === 'string' ? { message: entry } : entry;
    if (blocker.message.trim().length === 0 || seen.has(blocker.message)) continue;
    seen.add(blocker.message);
    out.push(blocker);
  }
  return out;
}

/**
 * 闸门清单：把所有阻塞**一次列全**，而不是只解释第一条。
 *
 * 空清单渲染 `null`（没有阻塞就不该占位置）。
 */
export function GateList(props: {
  readonly blockers: readonly GateInput[];
  /** 可选的清单标题（例如「签字前置条件」）。省略即裸列表。 */
  readonly label?: string;
}): ReactNode {
  const blockers = gateBlockersOf(props.blockers);
  if (blockers.length === 0) return null;
  return createElement(
    'div',
    { className: 'pentest-gate' },
    props.label === undefined
      ? null
      : createElement('span', { className: 'pentest-gate__label' }, props.label),
    createElement(
      'ul',
      { className: 'pentest-gate__items' },
      blockers.map((blocker) =>
        createElement(
          'li',
          {
            key: blocker.message,
            className: 'pentest-gate__item',
            ...(blocker.code === undefined ? {} : { 'data-blocker': blocker.code }),
          },
          blocker.message,
        ),
      ),
    ),
  );
}
