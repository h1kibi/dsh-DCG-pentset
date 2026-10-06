/**
 * 交接编辑器：人类确认「进入下一阶段」时唯一的编辑面。
 *
 * ── 这块屏只做两件事（2026-10-07 操作者裁定）──
 *
 *   1. 改**要注入下一阶段的两段文字**：任务目标、任务提示词；
 *   2. 确认或取消。
 *
 * skill 勾选、工具允许列表、逐次放行类别、上下文引用**不再出现在这里**。它们的取值在
 * 确认时原样取自草稿（`draft.*`，由服务端按 Profile 与阶段生成），人类不再逐项编辑。
 * 撤下这些编辑器的后果要说清：**逐会话收窄能力**的入口没有了，能力边界只由 Profile 决定。
 *
 * 文案口径（同日裁定）：名词短语、无主语、无语气词、不用括号、不引规范章节号。
 */
import { useState } from 'react';
import type { ReactNode } from 'react';
import type { HandoffDraft } from '../../contracts.ts';
import type { ConsoleController } from '../controller.ts';
import { planPhaseMove } from '../../workflow/phases.ts';
import { phaseLabel } from '../format.ts';
import { Button, Card, ErrorBar, Field, TextArea, TextInput } from '../ui.tsx';
import { GateList } from './GateList.tsx';

const TRANSCRIPT_NOTICE =
  '新会话不继承旧对话：它收到的是这里确认的任务提示词、草稿携带的上下文引用、范围与规则快照。' +
  '其余记忆内容与旧会话对话都不会传过去。';

interface HandoffEditorProps {
  /** 确认与取消走控制器封装（人类专属操作）。 */
  readonly controller: ConsoleController;
  /** 当前 engagement；交接包属于它，控制器不从快照里猜。 */
  readonly engagementId: string;
  /** 当前会话生成、可能已被人类编辑过的草稿。 */
  readonly draft: HandoffDraft;
  /** 服务端给出的交接内容哈希预览；缺省表示这条数据没走读端点。 */
  readonly contentHash?: string | null;
  /**
   * 回环（后渗透 → 情报收集）的前置：范围修订状态。
   * 未完成时本弹窗不能确认——这是 `planPhaseMove` 的结论，不是本组件的判断。
   */
  readonly scopeAmendment?: { readonly completed: boolean; readonly newVersion: number | null };
  /** 弹窗关闭（确认或取消成功后调用）。 */
  readonly onClose?: () => void;
  /**
   * 已知的状态版本。会话卡片必须给：卡片用会话级控制器，不传就恒发 0，服务端一律回
   * `stale_state_version`。控制台面板可省略。
   */
  readonly expectedStateVersion?: number;
}

export function HandoffEditor(props: HandoffEditorProps): ReactNode {
  const { draft } = props;

  // 目标阶段由状态机给出，本屏不允许改。
  const toPhase = draft.suggestedToPhase;
  const [objective, setObjective] = useState(draft.objective);
  const [prompt, setPrompt] = useState(draft.prompt);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ readonly code: string; readonly message: string } | null>(null);

  // 本屏没有强制跳转入口，二次确认恒为 false；服务端照旧校验。
  const plan = planPhaseMove({
    from: draft.fromPhase,
    to: toPhase,
    forced: false,
    reason: '',
    doubleConfirmed: false,
    ...(props.scopeAmendment === undefined ? {} : { scopeAmendment: props.scopeAmendment }),
  });

  const gates: string[] = plan.ok ? [] : [plan.message];
  const blocked = gates.length > 0 || busy;

  const confirm = (): void => {
    setBusy(true);
    setError(null);
    props.controller
      .confirmTransition({
        engagementId: props.engagementId,
        draftId: draft.draftId,
        forced: false,
        forcedAcknowledged: false,
        objective: objective.trim(),
        excludedRefs: draft.excludedRefs,
        approvedToPhase: toPhase,
        approvedPrompt: prompt,
        // 能力面原样沿用草稿：这一屏不再提供逐项编辑。
        approvedSkillIds: draft.suggestedSkillIds,
        approvedToolAllow: draft.toolCapabilitySuggestion.allowed,
        approvedApprovalRequired: draft.toolCapabilitySuggestion.approvalRequired,
        contextRefs: draft.contextRefs,
        reason: '',
        ...(props.expectedStateVersion === undefined ? {} : { expectedStateVersion: props.expectedStateVersion }),
      })
      .then((result) => {
        if (!result.ok) {
          setError({ code: result.code, message: result.message });
          return;
        }
        props.onClose?.();
      })
      .catch((cause: unknown) => {
        setError({ code: 'client_call_failed', message: cause instanceof Error ? cause.message : String(cause) });
      })
      .finally(() => { setBusy(false); });
  };

  const cancel = (): void => {
    setBusy(true);
    setError(null);
    props.controller
      .cancelHandoff('', props.expectedStateVersion)
      .then((result) => {
        if (!result.ok) {
          setError({ code: result.code, message: result.message });
          return;
        }
        props.onClose?.();
      })
      .catch((cause: unknown) => {
        setError({ code: 'client_call_failed', message: cause instanceof Error ? cause.message : String(cause) });
      })
      .finally(() => { setBusy(false); });
  };

  return (
    <Card title="阶段交接">
      <p className="pentest-handoff__notice">{TRANSCRIPT_NOTICE}</p>

      {error === null ? null : <ErrorBar code={error.code} message={error.message} />}
      <p className="pentest-handoff__hash">
        {props.contentHash === undefined || props.contentHash === null
          ? '内容哈希不可用'
          : <>内容哈希 <code title={props.contentHash}>{`${props.contentHash.slice(0, 16)}…`}</code></>}
      </p>

      <section className="pentest-handoff__block">
        <h4 className="pentest-handoff__block-title">目标阶段</h4>
        <p className="pentest-handoff__hint">
          {`${phaseLabel(draft.fromPhase)} → ${phaseLabel(draft.suggestedToPhase)}：状态机指定的推进方向`}
        </p>
      </section>

      <section className="pentest-handoff__block">
        <h4 className="pentest-handoff__block-title">注入下一阶段的内容</h4>
        <Field label="任务目标" hint="下游会话的任务意图">
          <TextInput value={objective} onChange={setObjective} />
        </Field>
        <Field label="任务提示词" hint="下游会话实际收到的任务描述">
          <TextArea value={prompt} onChange={setPrompt} rows={20} />
        </Field>
        <p className="pentest-handoff__hint">
          能力面取自 Profile 与阶段：草稿候选值随本次确认一并提交。
        </p>
      </section>

      <GateList blockers={gates} label="确认前置条件" />

      <div className="pentest-handoff__actions">
        <Button
          label={busy ? '正在提交…' : '确认并创建会话'}
          kind="primary"
          onClick={confirm}
          disabled={blocked}
          reason={busy ? '正在提交' : gates.join('；')}
        />
        <Button label="取消" onClick={cancel} disabled={busy} reason={busy ? '正在提交' : ''} />
      </div>
    </Card>
  );
}
