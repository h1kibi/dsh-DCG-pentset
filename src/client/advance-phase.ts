import type { HandoffDraft, Phase } from '../contracts.ts';
import type { ConsoleController } from './controller.ts';
import type { ActiveSessionView } from './views/IntakePrompt.tsx';

/**
 * 交接草稿的窄化：形状不符就返回 `null`，**绝不猜**。
 *
 * 半个对象喂给确认端点会带着残缺内容切换阶段（§7.2 的可空键正是为这种事设的）。
 * 只在本模块内使用（外部没有第二个消费者），因此不导出。
 */
function handoffDraftOf(value: unknown): HandoffDraft | null {
  if (value === null || typeof value !== 'object') return null;
  if (!('draftId' in value) || typeof value.draftId !== 'string') return null;
  if (!('fromPhase' in value) || typeof value.fromPhase !== 'string') return null;
  if (!('suggestedToPhase' in value) || typeof value.suggestedToPhase !== 'string') return null;
  if (!('objective' in value) || typeof value.objective !== 'string') return null;
  if (!('prompt' in value) || typeof value.prompt !== 'string') return null;
  if (!('revision' in value) || typeof value.revision !== 'number') return null;
  if (!('toolCapabilitySuggestion' in value) || typeof value.toolCapabilitySuggestion !== 'object') return null;
  return value as HandoffDraft;
}

/**
 * 「进入下一阶段」第一步的结果：成功时给出**待人类审计的交接草稿**。
 *
 * 这一步**不**提交：注入下一阶段会话是人类的决定，草稿要交给「交接编辑」呈现、
 * 修改、再提交（`controller.confirmTransition`）。从前这里会自动按草稿原样确认——
 * 人类没有机会审计，那正是本次要改掉的（2026-10-05 人类要求：先生成、给我改、再注入）。
 */
type PhaseAdvanceOutcome =
  | { readonly ok: true; readonly draft: HandoffDraft }
  | { readonly ok: false; readonly message: string };

/**
 * 「进入下一阶段」：请求当前 Worker 生成交接草稿（下一阶段的提示词 + 要交接的上下文）。
 *
 * 抽成独立函数（而不是写在组件里）是为了能用假控制器断言**调用序列与载荷**：
 * 这条链路每一步都可能悄悄走错（草稿没窄化、拿错会话 id、失败被吞），在界面上都表现为
 * 「点了没反应」。
 *
 * 两条硬边界：
 *   1. 只有 `waiting_human_review` 能请求草稿（服务端闸门；调用方负责不画按钮）；
 *   2. 非推荐路径不由本函数放行：草稿**原样**交给人类，走不走、怎么走由「交接编辑」
 *      里的显式确认决定——那里才有 `forced` 与独立二次确认。
 */
export async function requestAdvanceDraft(input: {
  readonly controller: ConsoleController;
  readonly activeSession: Pick<ActiveSessionView, 'workerSessionId'>;
  /** 目标阶段：省略即由服务端按状态机的推荐给出。 */
  readonly suggestedToPhase?: Phase;
  /**
   * 已知的状态版本。**会话卡片必须给**：卡片用会话级控制器，它没有 `state`，
   * 不传就会恒定发 0 → 服务端回 `stale_state_version`（期望 0，实际 4）。
   */
  readonly expectedStateVersion?: number;
}): Promise<PhaseAdvanceOutcome> {
  const fail = (message: string): PhaseAdvanceOutcome => ({ ok: false, message });

  // **不经过 Agent**：服务端按阶段定义与当前状态直接起草（2026-10-05 人类要求）。
  // 从前这里会向当前会话续跑一个回合去要草稿——人类要先看一堵机器格式的 JSON、再等它跑完，
  // 而他要的只是一份能直接改的内容。
  let result;
  try {
    result = await input.controller.beginHandoff({
      workerSessionId: input.activeSession.workerSessionId,
      ...(input.suggestedToPhase === undefined ? {} : { toPhase: input.suggestedToPhase }),
      ...(input.expectedStateVersion === undefined ? {} : { expectedStateVersion: input.expectedStateVersion }),
    });
  } catch (cause: unknown) {
    return fail(cause instanceof Error ? cause.message : String(cause));
  }
  if (!result.ok) return fail(`${result.code}：${result.message}`);

  const draft = handoffDraftOf(result.value);
  if (draft === null) return fail('交接草稿的返回形状不符合契约，缺少 draftId，已忽略这次结果');
  return { ok: true, draft };
}
