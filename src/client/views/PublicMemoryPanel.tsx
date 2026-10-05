/**
 * 公共记忆：本作业下**所有 Agent** 都会读到的规则与共识。
 *
 * 设计依据：docs/dsh-pentest-plugin-design.md §8.1（记忆分层）、§7.4（新会话注入）
 *
 * ── 它和「记忆浏览器」是什么关系 ──
 *
 * 两者刻意分开，因为它们的方向相反：
 *
 * | | 记忆浏览器 | 公共记忆 |
 * |---|---|---|
 * | 谁写 | Agent 产出的事实与证据 | **人**写的指令与共识 |
 * | 怎么变 | 只追加，可检索 | 就地改写，有唯一当前版本 |
 * | 去处 | 被检索到才进上下文 | **无条件**注入每一次会话的提示词 |
 *
 * 正因为公共记忆是无条件注入的，它必须**唯一且可预期**——所以它不做追加、不进检索排序。
 * 混在一起会让「哪些内容会被注入」变得不可预测，而那恰恰是它需要稳定可靠的原因。
 *
 * ── 三个必须讲清的点（都写进界面，不靠人猜） ──
 *
 * 1. **它进每一次会话**，包括重做与阶段切换——不只是下一个新会话。
 * 2. **改动要写理由**：它改变的是整个作业的行为边界，因而走「人类决策」那条路径，
 *    与切换阶段同级。
 * 3. **有长度上限**：它挤占每一次请求的上下文，过长会吃掉任务本身需要的空间。
 */

import { useState } from 'react';
import type { ReactNode } from 'react';

import type { EngagementMemory } from '../../contracts.ts';
import type { ConsoleController, ConsoleSnapshot } from '../controller.ts';
import { formatTimestamp } from '../format.ts';
import { Button, Card, Empty, ErrorBar, Field, TextArea } from '../ui.tsx';
import { PUBLIC_MEMORY_MAX_CHARS } from '../../contracts.ts';

export interface PublicMemoryPanelProps {
  readonly controller: ConsoleController;
  readonly snapshot: ConsoleSnapshot;
  /** 已读取的记忆；`null` = 尚未成功读取（还没读，或读失败）。 */
  readonly memory: EngagementMemory | null;
  /** 保存回调：由外层持有状态，保存成功后重新读取。 */
  readonly onSave: (content: string, reason: string) => Promise<void> | void;
  readonly now?: Date;
}

/** 保存的闸门：返回阻止原因（空数组即可保存）。纯函数，便于测试。 */
export function publicMemoryBlockers(input: {
  readonly selected: boolean;
  readonly content: string;
  readonly reason: string;
  readonly dirty: boolean;
}): readonly string[] {
  const out: string[] = [];
  if (!input.selected) out.push('尚未选中作业：先在列表里选一个。');
  // 只在真的改过内容时才要求理由——没改就没得记，逼人写理由是纯摩擦。
  if (input.dirty && input.reason.trim().length === 0) {
    out.push('改动必须写理由：它改变整个作业的行为边界，随决策记录存档。');
  }
  if (input.content.length > PUBLIC_MEMORY_MAX_CHARS) {
    out.push(
      `超出上限 ${String(PUBLIC_MEMORY_MAX_CHARS)} 字符（当前 ${String(input.content.length)}）：` +
        '它会被注入每一次会话，过长会挤掉任务本身需要的上下文。',
    );
  }
  return out;
}

export function PublicMemoryPanel(props: PublicMemoryPanelProps): ReactNode {
  const engagementId = props.snapshot.selectedEngagementId;
  const [draft, setDraft] = useState<string | null>(null);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<{ code: string; message: string } | null>(null);

  /**
   * 草稿属于**它被写下时的那一个作业**，不是「组件当前实例」。
   *
   * 切换作业时组件不会重挂载（外壳在同一位置渲染同一个元素类型），因此 `useState`
   * 会原样保留——于是 A 的草稿会显示在 B 的面板上，保存即把 A 的正文写进 B。
   * 那段文本会被注入 B 的每一次会话，属于**跨作业污染行为边界**。
   *
   * 修法是给草稿打上归属标记：只在它与当前作业一致时才采用。这比「在上层把草稿置空」
   * 更稳——上层清理是 effect，跑在渲染之后，中间那一帧仍会串。
   */
  const [draftOwner, setDraftOwner] = useState<string | null>(null);
  const ownedDraft = draftOwner === engagementId ? draft : null;
  const ownedReason = draftOwner === engagementId ? reason : '';

  if (engagementId === null) {
    return (
      <Card title="公共记忆">
        <Empty
          title="尚未选中作业"
          reason="公共记忆属于具体的作业——它是这个作业下所有 Agent 的共同前提。先在列表里选一个。"
        />
      </Card>
    );
  }

  const stored = props.memory?.content ?? '';
  // 「未编辑」时输入框显示库里的值；一旦编辑就由本地草稿接管（受控输入的常规做法）。
  const content = ownedDraft ?? stored;
  const dirty = ownedDraft !== null && ownedDraft !== stored;
  const gates = publicMemoryBlockers({ selected: true, content, reason: ownedReason, dirty });

  /** 写入草稿时同时记下归属，避免它漂到别的作业上。 */
  const edit = (next: string): void => {
    setDraft(next);
    setDraftOwner(engagementId);
  };
  const editReason = (next: string): void => {
    setReason(next);
    setDraftOwner(engagementId);
  };

  const save = (): void => {
    if (gates.length > 0) return;
    const owner = engagementId;
    setBusy(true);
    void Promise.resolve(props.onSave(content, ownedReason.trim()))
      .then(() => {
        // 只有**这次保存的目标作业仍是当前作业**时才丢草稿：否则会把人类在新作业里
        // 刚输入的内容一起抹掉（那是同一个根因的第二个窗口）。
        if (draftOwner !== owner) return;
        setDraft(null);
        setDraftOwner(null);
        setReason('');
        setFailure(null);
      })
      .catch((cause: unknown) => {
        // 服务端拒绝走控制器的快照；**抛出的异常**（传输层断开、信封构造失败）不会
        // 进快照，所以单独接住——否则点下去什么都不会发生。
        if (draftOwner !== owner) return;
        setFailure({
          code: 'client/error',
          message: cause instanceof Error ? cause.message : String(cause),
        });
      })
      .finally(() => { setBusy(false); });
  };

  return (
    <Card title="公共记忆">
      <p className="pentest-publicmemory__hint">
        这里写的内容会注入**本作业下每一次新建会话**的系统提示词——包括重做与阶段切换，
        不只是下一个新会话。适用场景：这个作业的通用规矩、客户的硬性限制、已经确认过的
        共识（例如「只做被动读取」「不要碰生产网段」「报告一律用中文」）。
      </p>

      {props.memory === null ? (
        <Empty
          title="尚未读取"
          reason="还没读到公共记忆；若反复出现，看下方错误条的稳定错误码。"
        />
      ) : (
        <>
          <Field
            label="正文"
            hint={
              props.memory.updatedAt === null
                ? '从未修改过（当前为空）'
                : `最后修改：${formatTimestamp(props.memory.updatedAt, props.now)}` +
                  (props.memory.updatedBy === null ? '' : ` · ${props.memory.updatedBy}`)
            }
          >
            <TextArea
              value={content}
              onChange={edit}
              rows={12}
              placeholder={'例如：\n- 本轮只做被动读取，不发起任何会改变远端状态的请求。\n- 目标域名的上游 CDN 属于共享基础设施，不要对其做压力测试。\n- 报告与状态便签一律用中文。'}
            />
          </Field>

          <Field
            label="改动理由"
            hint="写入 human_decisions（§16.1）。只在内容真的改过时才要求填写。"
          >
            <TextArea
              value={reason}
              onChange={editReason}
              rows={2}
              placeholder="例如：客户新增了「不要碰生产网段」的限制"
            />
          </Field>

          {gates.length === 0 ? null : (
            <ul className="pentest-publicmemory__gates">
              {gates.map((gate) => <li key={gate}>{gate}</li>)}
            </ul>
          )}

          <div className="pentest-publicmemory__actions">
            <Button
              label={busy ? '正在保存…' : '保存'}
              kind="primary"
              onClick={save}
              disabled={gates.length > 0 || busy || !dirty}
              reason={
                gates.length > 0
                  ? gates[0]
                  : busy
                    ? '正在保存'
                    : !dirty
                      ? '内容没有改动'
                      : undefined
              }
            />
            <Button
              label="放弃改动"
              onClick={() => { setDraft(null); setDraftOwner(null); setReason(''); }}
              disabled={!dirty}
              reason={dirty ? undefined : '内容没有改动'}
            />
          </div>

          <p className="pentest-publicmemory__meta">
            {`${String(content.length)} / ${String(PUBLIC_MEMORY_MAX_CHARS)} 字符`}
            {dirty ? ' · 有未保存的改动' : ''}
          </p>
        </>
      )}

      {props.snapshot.lastError === null ? null : (
        <ErrorBar code={props.snapshot.lastError.code} message={props.snapshot.lastError.message} />
      )}
      {failure === null ? null : <ErrorBar code={failure.code} message={failure.message} />}
    </Card>
  );
}
