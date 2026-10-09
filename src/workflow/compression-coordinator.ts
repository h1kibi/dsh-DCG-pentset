/**
 * 会话内压缩协调器（§8.10 实现接线）。
 *
 * 职责：
 * 1. 监测会话上下文使用率（估算令牌数 vs 窗口大小）
 * 2. 在达到 60% 阈值时在**回合边界**触发压缩
 * 3. 调用模型服务生成压缩摘要
 * 4. 通过 SessionFactory.compressHistory 把摘要事件注入会话并折叠历史范围
 * 5. 记录压缩事件到审计账本
 *
 * ── 依赖关系 ──
 * - `SessionFactory.compressHistory`：宿主会话机制接缝
 * - `compaction.ts`：压缩算法（已有）
 * - 宿主模型服务：生成压缩摘要
 * - 工作流数据库：记录压缩事件
 *
 * ── 当前状态（2026-10-09）──
 * 本模块定义接缝与数据模型，具体实现取决于：
 * - dsh-session 对 `replace` 事件的正式支持（预期 0.1.6+）
 * - 宿主模型调用服务的回调机制
 * - 回合边界的 effect 注册点
 */

import { DEFAULTS } from '../contracts.ts';

/**
 * 会话的上下文使用估算。
 *
 * 在**回合边界**评估：每当即将投递下一条消息前，检查当前活跃历史的令牌估算。
 * 若超过预算的 60%，则启动压缩。
 */
export interface ContextUsageEstimate {
  /** 当前活跃历史的估算请求令牌数（包括推理内容）。 */
  readonly currentTokens: number;
  /** 模型的上下文窗口大小（令牌）。 */
  readonly windowSize: number;
  /** 压缩触发的阈值比例，默认 60%。 */
  readonly triggerRatio: number;
}

/**
 * 压缩事件的输入参数。
 *
 * 由 Worker 会话的事件监听器在回合边界计算，并投递给压缩协调器。
 */
export interface CompressionTrigger {
  readonly dshSessionId: string;
  readonly workerSessionId: string;
  readonly engagementId: string;
  /** 会话当前的轮次号（新投递消息将成为下一轮）。 */
  readonly currentTurn: number;
  /** 当前上下文使用估算。 */
  readonly usage: ContextUsageEstimate;
  /** 压缩前的活跃历史（用于摘要生成；来自会话事件流）。 */
  readonly historyContext: string;
  /** 保留集（永不压缩的轮次，来自压缩算法 PINNED_ENTRY_KINDS）。 */
  readonly pinnedTurns: readonly number[];
}

/**
 * 压缩结果。
 *
 * 成功压缩后返回，包含所有必要的审计信息。
 */
export interface CompressionResult {
  /** 压缩覆盖的范围 [from, to]（包含）。 */
  readonly compressedRange: { readonly from: number; readonly to: number };
  /** 压缩摘要的事件 ID（已写入会话与审计）。 */
  readonly summaryEventId: string;
  /** 压缩前的估算令牌数。 */
  readonly beforeTokens: number;
  /** 压缩后的估算令牌数（活跃历史新大小）。 */
  readonly afterTokens: number;
  /** 压缩所用的模型与成本。 */
  readonly model: string;
  /** 压缩耗时（毫秒）。 */
  readonly elapsedMs: number;
}

/**
 * 压缩协调器的依赖。
 *
 * 所有方法都必须实现，否则协调器拒绝工作。
 */
export interface CompressionCoordinatorDeps {
  /**
   * 调用模型生成压缩摘要。
   *
   * 实现应：
   * 1. 使用会话当前的模型与提示词配置
   * 2. 记录为「用途=压缩」的模型调用（计费与监控）
   * 3. 返回摘要文本与实际使用的模型名
   * 4. 失败时抛错，由调用方决定是否降级
   */
  generateSummary(input: {
    readonly historyContext: string;
    readonly dshSessionId: string;
  }): Promise<{ readonly summary: string; readonly model: string }>;

  /**
   * 记录压缩事件到审计账本。
   *
   * 写入 `context.compacted` 事件，包含压缩区间、摘要引用、令牌统计、策略版本。
   * 同时更新 `worker_sessions.compacted_through_turn`。
   */
  recordCompressionEvent(input: {
    readonly engagementId: string;
    readonly workerSessionId: string;
    readonly result: CompressionResult;
  }): Promise<void>;

  /**
   * 向会话追加压缩事件并折叠历史。
   *
   * 由工作流服务通过 SessionFactory 调用。
   */
  applyCompressionToSession(input: {
    readonly dshSessionId: string;
    readonly result: CompressionResult;
  }): Promise<void>;
}

/**
 * 评估是否应该触发压缩。
 *
 * 纯函数：返回 `true` 当且仅当 `currentTokens / windowSize >= triggerRatio`。
 */
export function shouldCompress(usage: ContextUsageEstimate): boolean {
  const ratio = usage.currentTokens / usage.windowSize;
  return ratio >= (usage.triggerRatio ?? DEFAULTS.compactionTriggerRatio);
}

/**
 * 压缩协调器：会话运行时的压缩触发与执行。
 *
 * ── 集成点 ──
 * 该类由工作流服务在创建 Worker 会话时注册到**回合边界事件监听器**。
 * 实现需要等待 dsh-session 的正式 effect 暴露（当前 0.1.5-rc.2 未支持）。
 *
 * 预期的调用时序：
 * 1. Worker Agent 消息投递前，会话驱动评估上下文使用率
 * 2. 若超过 60%，事件监听器调用 `coordinator.trigger(trigger)`
 * 3. 协调器调用模型、记录审计、更新会话
 * 4. 返回成功后，消息才投递给会话
 */
export class CompressionCoordinator {
  readonly #deps: CompressionCoordinatorDeps;

  constructor(deps: CompressionCoordinatorDeps) {
    this.#deps = deps;
  }
  /**
   * 处理压缩触发。
   *
   * 预期失败处理：
   * - 模型调用失败：记日志但**不阻塞**会话运行（压缩是可选优化）
   * - 会话更新失败：记日志并告警（表示会话状态不一致）
   */
  async trigger(request: CompressionTrigger): Promise<CompressionResult | null> {
    const startTime = Date.now();

    // 1. 验证是否真正需要压缩（二次检查，因为状态可能已变）
    if (!shouldCompress(request.usage)) {
      return null;
    }

    // 2. 调用模型生成摘要
    const { model } = await this.#deps.generateSummary({
      historyContext: request.historyContext,
      dshSessionId: request.dshSessionId,
    });

    // 3. 构造结果（轮次范围、令牌统计等由外层驱动基于会话状态）
    // 注：实际的轮次范围由 dsh-session 的压缩事件机制决定
    // 这里只定义数据模型，具体实现待 dsh-session 支持
    const result: CompressionResult = {
      compressedRange: { from: 0, to: request.currentTurn - 6 }, // 保留最近 6 轮
      summaryEventId: `compaction-${Date.now()}`,
      beforeTokens: request.usage.currentTokens,
      afterTokens: Math.floor(request.usage.currentTokens * 0.4), // 估算压缩后为 40%
      model,
      elapsedMs: Date.now() - startTime,
    };

    // 4. 记录审计事件
    await this.#deps.recordCompressionEvent({
      engagementId: request.engagementId,
      workerSessionId: request.workerSessionId,
      result,
    });

    // 5. 向会话应用压缩（折叠历史、追加摘要事件）
    await this.#deps.applyCompressionToSession({
      dshSessionId: request.dshSessionId,
      result,
    });

    return result;
  }
}
