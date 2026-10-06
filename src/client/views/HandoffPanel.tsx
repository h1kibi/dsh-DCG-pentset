/**
 * 交接面板：把「请求生成交接草稿 → 人类编辑 → 确认切换」串成一条可走的路径。
 *
 * ── 为什么需要一个包装 ──
 *
 * {@link HandoffEditor} 的契约是「**已经有**一份草稿」：它渲染草稿、收集编辑、确认切换。
 * 但草稿本身要先由**人类显式请求**（`requestHandoffDraft` 是写操作，Agent 不会自己生成，
 * §6.3）。此前面板直接把 `HandoffEditor` 摆上去，而草稿只能来自 props——结果是
 * 这个面板永远拿不到草稿，**阶段切换在界面上走不通**（而阶段切换是 §5 的核心动作）。
 *
 * 这个组件补上前面那一步：没有草稿时给出「请求生成」的入口与它的前置条件；
 * 有草稿时把编辑器渲染出来。
 *
 * ── 前置条件为什么要在界面上说清 ──
 *
 * `requestHandoffDraft` 服务端只在 `waiting_human_review` 接受（§5.2 的状态图：
 * 只有 Agent 交了报告、等人判断时才谈得上交接）。把这条写出来，人类就不必
 * 「点一下、被拒、再猜」。
 */

import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';

import type { HandoffDraft, Phase } from '../../contracts.ts';
import type { ConsoleController, ConsoleSnapshot } from '../controller.ts';
import { HandoffEditor } from './HandoffEditor.tsx';
import { Button, Card, Empty, Field, TextArea, TextInput } from '../ui.tsx';
import { GateList } from './GateList.tsx';

interface HandoffPanelProps {
  /** 唯一写入路径（§4.2）。 */
  readonly controller: ConsoleController;
  readonly snapshot: ConsoleSnapshot;
  /** 已生成的草稿；由调用方持有（刷新页面后可重新请求）。 */
  readonly draft: HandoffDraft | null;
  /** 草稿生成后的回调：调用方保存它，下次渲染即显示编辑器。 */
  readonly onDraft: (draft: HandoffDraft | null) => void;
  /** 交接编辑器的其余透传（范围修订状态等）。 */
  readonly scopeAmendment?: { readonly completed: boolean; readonly newVersion: number | null };
  readonly contentHash?: string | null;
}

/** 请求草稿的闸门：返回阻止原因（空数组即可请求）。 */
export function draftRequestBlockers(input: {
  readonly selected: boolean;
  readonly mainStatus: string | null;
  readonly hasActiveSession: boolean;
  readonly reason: string;
}): readonly string[] {
  const gates: string[] = [];
  if (!input.selected) gates.push('先选择一个作业');
  // 服务端的准入（`pg-workflow.ts` 的 requestHandoffDraft）：只有等待人工判断时可以请求。
  if (input.mainStatus !== 'waiting_human_review') {
    gates.push(
      `只有 Agent 交了报告、等待判断时才能进入下一阶段：当前主状态 ${input.mainStatus ?? '未知'}。` +
        '先让当前 Agent 提交报告',
    );
  }
  if (!input.hasActiveSession) gates.push('当前没有活动 Worker 会话：交接从某个会话交接出去，没有会话就无从生成');
  // 不要求理由（2026-10-05 人类明确要求）：操作者与时间照记进决策与审计。
  return gates;
}

/** 交接面板。 */
export function HandoffPanel(props: HandoffPanelProps): ReactNode {
  const [reason, setReason] = useState('');
  const [targetPhase, setTargetPhase] = useState<Phase>('threat-modeling');
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<{ readonly code: string; readonly message: string } | null>(null);

  const state = props.snapshot.state;
  const engagementId = props.snapshot.selectedEngagementId;

  // 打开面板时**从服务端取回**当前待确认的草稿（§7.2）：草稿可能是在会话卡片那边请求的，
  // 也可能来自更早的一次页面加载。只读、幂等；取不到就保持「请求生成」的入口。
  // 不这样做，两处界面会各显示各的：会话卡片里确认过，面板却还是空的（反之亦然）。
  useEffect(() => {
    const sessionId = state?.activeWorkerSessionId ?? null;
    if (props.draft !== null || sessionId === null) return;
    let cancelled = false;
    void props.controller
      .currentHandoffDraft(sessionId)
      .then((draft) => {
        if (!cancelled && draft !== null) props.onDraft(draft);
      })
      .catch(() => undefined);
    return () => { cancelled = true; };
  }, [props.draft, state?.activeWorkerSessionId]);

  const request = (): void => {
    const sessionId = state?.activeWorkerSessionId;
    if (sessionId === null || sessionId === undefined) return;
    setBusy(true);
    setFailure(null);
    // 服务端起稿（不经 Agent）：阶段由人类选的 targetPhase 决定；强制移动仍走编辑器里的闸门。
    props.controller
      .beginHandoff({ workerSessionId: sessionId, toPhase: targetPhase })
      .then(
        (result) => {
          if (!result.ok) return;
          // 端点返回的是草稿本身；形状不符时**不猜**——宁可留空让人重试，
          // 也不把半个对象塞进编辑器（那会让后续确认提交带着残缺内容）。
          const value: unknown = result.value;
          if (value === null || typeof value !== 'object' || !('draftId' in value)) {
            setFailure({
              code: 'client/unexpected-draft',
              message: '交接内容的返回形状不符合契约（缺少 draftId），已忽略这次结果',
            });
            return;
          }
          props.onDraft(value as HandoffDraft);
          setReason('');
        },
        (cause: unknown) => {
          setFailure({
            code: 'client/envelope-rejected',
            message: cause instanceof Error ? cause.message : String(cause),
          });
        },
      )
      .finally(() => { setBusy(false); });
  };

  if (engagementId === null) {
    return (
      <Card title="阶段交接">
        <Empty title="先选择一个作业" reason="交接包归属单个作业及其活动会话" />
      </Card>
    );
  }

  if (props.draft !== null) {
    return (
      <HandoffEditor
        controller={props.controller}
        engagementId={engagementId}
        draft={props.draft}
        {...(props.contentHash === undefined ? {} : { contentHash: props.contentHash })}
        {...(props.scopeAmendment === undefined ? {} : { scopeAmendment: props.scopeAmendment })}
        onClose={() => { props.onDraft(null); }}
      />
    );
  }

  const gates = draftRequestBlockers({
    selected: true,
    mainStatus: state?.mainStatus ?? null,
    hasActiveSession: state?.activeWorkerSessionId !== null && state?.activeWorkerSessionId !== undefined,
    reason,
  });

  return (
    <Card title="阶段交接">
      <Empty
        title="尚未起草交接"
        reason={
          '服务端按阶段定义起草：阶段目标、应产出、上一阶段要点、边界、工具与放行类别。' +
          '改完确认才创建新会话。'
        }
      />

      {failure === null ? null : (
        <p className="pentest-handoff__failure">{`${failure.code}：${failure.message}`}</p>
      )}

      <Field label="期望的下一阶段" hint="Agent 据此起草交接内容">
        <TextInput value={targetPhase} onChange={(next) => { setTargetPhase(next as Phase); }} />
      </Field>

      <Field label="请求理由" hint="写入人工决策与审计">
        <TextArea value={reason} onChange={setReason} placeholder="本轮情报收集已交报告，准备进入威胁建模" />
      </Field>

      <GateList blockers={gates} label="生成前置条件" />

      <Button
        label={busy ? '正在生成…' : '进入下一阶段'}
        kind="primary"
        onClick={request}
        disabled={gates.length > 0 || busy}
        reason={gates.length > 0 ? gates[0] : busy ? '正在请求' : undefined}
      />
    </Card>
  );
}
