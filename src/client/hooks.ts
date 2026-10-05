/**
 * React 绑定：把控制器的 uSES 订阅形状接进组件。
 *
 * 设计依据：docs/dsh-pentest-plugin-design.md §6.2.3
 *
 * ── 为什么单独一个文件 ──
 *
 * 视图组件不该各自 `useSyncExternalStore(controller.subscribe, controller.getSnapshot)`：
 * 手写订阅容易漏掉「getSnapshot 必须返回稳定引用」这条要求——每次调用返回新对象会让
 * React 认为状态永远在变，触发无限重渲染。把这条纪律封在一个 hook 里，视图就不可能写错。
 *
 * 控制器已经保证 `getSnapshot()` 返回**同一引用直到状态真的变化**（它内部用不可变替换），
 * 因此这里可以放心直传。
 */

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { ConsoleController, ConsoleSnapshot } from './controller.ts';

/** 订阅控制台快照。 */
export function useConsoleSnapshot(controller: ConsoleController): ConsoleSnapshot {
  const subscribe = useCallback((listener: () => void) => controller.subscribe(listener), [controller]);
  const getSnapshot = useCallback(() => controller.getSnapshot(), [controller]);
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

/**
 * 首屏加载：挂载时拉一次数据。
 *
 * `load` 的引用必须稳定（调用方用 `useCallback` 包），否则会无限重拉——
 * 这类错误在开发时表现为请求风暴，很容易被误判为后端问题。
 */
export function useInitialLoad(load: () => Promise<void>): { readonly error: string | null } {
  const [error, setError] = useState<string | null>(null);
  const loadRef = useRef(load);
  loadRef.current = load;

  useEffect(() => {
    let cancelled = false;
    void loadRef
      .current()
      .then(() => {
        if (!cancelled) setError(null);
      })
      .catch((cause: unknown) => {
        // 首屏加载失败只记录，不抛：抛出去会让整个标签页渲染失败，
        // 而人类至少应该看到「加载失败」而不是一片空白。
        if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return { error };
}

/**
 * 周期刷新（本文件的其它 hook）：
 *
 * 控制台需要跟上一个正在工作的 Agent，但**轮询不是主要机制**：主要机制是人类操作后的刷新
 * （控制器在写操作后自动重读）与 Host 推送。此前这里还有一个 `usePolling` 兜底 hook——
 * 它没有被任何界面挂上（零调用），只留着一个「有轮询」的印象，2026-10-05 复核 C6 删除。
 * 真要兜底轮询时再按需引入：那时它必须带上「enabled 为 false 不起定时器」的语义。
 */
