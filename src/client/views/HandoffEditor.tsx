/**
 * 交接审阅与编辑：“下一阶段”弹窗里的第 1、3、5、6 块。
 *
 * 设计依据：docs/dsh-pentest-plugin-design.md §6.5、§7.2、§7.3、§7.4、§5.3
 *
 * ── 这个弹窗在为谁负责 ──
 *
 * 交接包一经确认即不可变（§7.3），新会话只收到「这里确认的内容」——**不继承旧 transcript**
 * （§7.4）。因此这一屏是人类最后一次能改变下游 Agent 所见的机会：任务提示词、skill、
 * 工具允许列表、上下文引用与放行类别都在这里定稿。界面的首要任务不是“收集输入”，
 * 而是让人**看清自己正在确认什么**。
 * ── 两条硬规则 ──
 *
 * 1. **强制跳转**（目标不在推荐路径，§5.3、§6.5 第 3 块）必须同时满足「理由非空」与
 *    「二次确认」；被跳过的阶段、缺失的证据基础都在此展示。判定不在这里自造：
 *    直接调 `planPhaseMove`（`src/workflow/phases.ts`，纯函数，控制台与服务端同源），
 *    禁用原因就是服务端会返回的拒绝理由。
 * 2. **可空但须已表决**（§7.2）：skill 与放行类别集合为空本身合法（§6.6 允许清空），
 *    但必须能区分「有意为空」与「漏了」——因此清空后要勾一句“确认不装载 / 确实没有”，
 *    否则确认被阻止。这条规则客户端就能判定，因为缺失的信号正是“人类有没有表决”。
 *
 * ── 内容哈希的事实（报告里有对应条目） ──
 *
 * §6.5 第 6 块要求「显示最终内容的差异与内容哈希」。两个哈希都由**服务端**给出，
 * 客户端一律不复算：确认后的哈希（`computeHandoffHash`）覆盖确认时才分配的
 * `handoff_id` 与 `human_decision_ref`；草稿哈希（`computeDraftHash`）覆盖落库的
 * `draft_json`——客户端手里那份副本算出来可能已经不是库里那一行。
 * 因此这里显示的是读端点带回的**权威哈希**（props `contentHash`，REQ-9 起由
 * `currentHandoffDraft` 带回），缺它时明确说明「尚未计算」，而不是自己拼一个
 * 看起来像哈希的字符串。
 */

import { useState } from 'react';
import type { ReactNode } from 'react';
import { ACTION_CLASSES, HANDOFF_MAX_CONTEXT_REFS, PER_ACTION_APPROVAL_CLASSES } from '../../contracts.ts';
import type { ActionClass, ContextRef, HandoffDraft, Phase } from '../../contracts.ts';
import type { ConsoleController } from '../controller.ts';
import { planPhaseMove } from '../../workflow/phases.ts';
import { actionClassLabel, needsPerActionApproval, phaseLabel } from '../format.ts';
import { Badge, Button, Card, ErrorBar, Field, List, TextArea, TextInput, toneClass } from '../ui.tsx';
import { GateList } from './GateList.tsx';

// ───────────────────────────── 文案（集中在此，便于将来接入 locale） ─────────────────────────────

/** §7.4：新会话拿不到旧会话的完整对话记录。 */
const TRANSCRIPT_NOTICE =
  '新会话不会继承旧 transcript：它只收到这里确认的任务提示词、被选中的上下文引用、范围与规则快照。未被选中的记忆内容与旧会话的完整对话都不会传过去。';


// ───────────────────────────── props ─────────────────────────────

/**
 * skill 库条目（§6.6「新增 skill 到库中后立即勾选」）。
 *
 * 契约里没有 skill 摘要类型，skill 端点也不在控制台方法表内，因此**由调用方喂进来**：
 * 本组件不猜端点、不发请求。
 */
interface SkillOption {
  readonly id: string;
  readonly label: string;
  /** 建议装载的阶段；`null` 表示不限阶段。 */
  readonly phase?: Phase | null;
}

/** 工具允许列表的可选项（同样由调用方喂入，见报告里的缺失端点）。 */
interface ToolOption {
  readonly id: string;
  readonly label: string;
}

interface HandoffEditorProps {
  /** 确认与取消走控制器封装（§16.1 的人类专属操作）。 */
  readonly controller: ConsoleController;
  /** 当前 engagement；交接包属于它，控制器不从快照里猜。 */
  readonly engagementId: string;
  /** 当前会话生成、可能已被人类编辑过的草稿（§7.2）。 */
  readonly draft: HandoffDraft;
  /** 服务端给出的交接内容哈希预览；`null`/缺省表示尚未计算（§6.5 第 6 块）。 */
  readonly contentHash?: string | null;
  readonly skillCatalog?: readonly SkillOption[];
  readonly toolCatalog?: readonly ToolOption[];
  /**
   * 回环（后渗透 → 情报收集）的前置：范围修订状态（§5.4 步骤 4、§13.7）。
   * 未完成时本弹窗不能确认——这不是本组件的判断，而是 `planPhaseMove` 的结论。
   */
  readonly scopeAmendment?: { readonly completed: boolean; readonly newVersion: number | null };
  /** 弹窗关闭（确认或取消成功后调用）。 */
  readonly onClose?: () => void;
  /**
   * 已知的状态版本。**会话卡片必须给**（卡片用会话级控制器，没有 `state`，不传就恒发 0，
   * 服务端一律回 `stale_state_version`）；控制台面板可省略（它有选中的作业与快照版本）。
   */
  readonly expectedStateVersion?: number;
  /**
   * 「展开原文」的意图出口（与记忆浏览器同一个回调形状；缺省时按钮禁用并说明原因）。
   *
   * 视图不发请求：取原文是一次**写入访问审计**的读操作（§8.7），由调用方决定接到哪个面。
   */
  readonly onExpandRef?: (ref: {
    readonly memoryId: string;
    readonly citation: string;
    readonly idempotencyKey: string;
  }) => void;
  /** 已取回的原文（按**裸** memoryId 索引，与记忆浏览器一致）。 */
  readonly refDetails?: Readonly<Record<string, string>>;
}

const TRUST_LABELS: Readonly<Record<string, string>> = {
  tool_observation: '工具观测',
  agent_statement: 'Agent 陈述',
  human_input: '人类输入',
};

export function HandoffEditor(props: HandoffEditorProps): ReactNode {
  const { draft } = props;

  // 目标阶段由服务端按状态机给出，本屏**不允许**改（没有强制跳转入口，2026-10-05 人类要求）。
  const toPhase = draft.suggestedToPhase;
  // 目标可编辑：草稿里的是候选（§7.2），而目标会进批准包并被新会话当作任务意图。
  // 只读展示会让人类无法修正一个措辞不对的目标。
  const [objective, setObjective] = useState(draft.objective);
  const [prompt, setPrompt] = useState(draft.prompt);
  const [skillIds, setSkillIds] = useState<readonly string[]>(draft.suggestedSkillIds);
  // 工具建议的起点是 Agent 的候选；人类可增删（§7.2「全部是候选内容」）。
  const [toolAllow, setToolAllow] = useState<readonly string[]>(draft.toolCapabilitySuggestion.allowed);
  const [toolDraft, setToolDraft] = useState('');
  const [approvalRequired, setApprovalRequired] = useState<readonly ActionClass[]>(
    // Agent 一条都没建议时回落到「逐次放行」的保守集合：默认更严，人类再放宽。
    draft.toolCapabilitySuggestion.approvalRequired.length === 0
      ? PER_ACTION_APPROVAL_CLASSES
      : draft.toolCapabilitySuggestion.approvalRequired,
  );
  const [contextRefs, setContextRefs] = useState<readonly ContextRef[]>(draft.contextRefs);
  const [refDraft, setRefDraft] = useState<{ readonly memoryId: string; readonly reason: string }>({ memoryId: '', reason: '' });

  const [reason] = useState('');
  /** §7.2 可空键的「已表决为空」。 */
  const [skillsVotedEmpty, setSkillsVotedEmpty] = useState(false);
  const [approvalVotedEmpty, setApprovalVotedEmpty] = useState(false);

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ readonly code: string; readonly message: string } | null>(null);
  const [notice] = useState<string | null>(null);

  const forced = false;

  // 阶段移动计划：禁用原因就是服务端会返回的拒绝理由（§5.3）
  const plan = planPhaseMove({
    from: draft.fromPhase,
    to: toPhase,
    forced,
    reason,
    doubleConfirmed: false,
    ...(props.scopeAmendment === undefined ? {} : { scopeAmendment: props.scopeAmendment }),
  });

  const gates: string[] = [];
  if (!plan.ok) gates.push(plan.message);
  if (skillIds.length === 0 && !skillsVotedEmpty) {
    gates.push('skill 已清空但尚未表决：勾选「确认不装载任何 skill」或选回至少一个（§7.2 可空键须已表决）');
  }
  if (approvalRequired.length === 0 && !approvalVotedEmpty) {
    gates.push('放行类别为空但尚未表决：勾选「确认该阶段没有需逐次放行的类别」或选回至少一个（§7.2）');
  }
  const blocked = gates.length > 0 || busy;

  const confirm = (): void => {
    setBusy(true);
    setError(null);
    props.controller
      .confirmTransition({
        engagementId: props.engagementId,
        draftId: draft.draftId,
        forced,
        // 本屏不允许强制移动（没有那个入口），因此二次确认恒为 false——服务端照旧校验。
        forcedAcknowledged: false,
        objective: objective.trim(),
        excludedRefs: draft.excludedRefs,
        approvedToPhase: toPhase,
        approvedPrompt: prompt,
        approvedSkillIds: skillIds,
        approvedToolAllow: toolAllow,
        approvedApprovalRequired: approvalRequired,
        contextRefs,
        reason: reason.trim(),
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
      .cancelHandoff(reason.trim(), props.expectedStateVersion)
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

  /**
   * skill 勾选项 = 库里给的 + 已勾选但库里没有的。
   *
   * 取并集是必须的：草稿建议的 skill 可能不在当前库里（例如筛掉了该阶段的），
   * 若只列库内项，那些已勾中的 skill 会变成看不见但仍在提交内容里的幽灵条目。
   */
  const skillOptions: readonly SkillOption[] = [
    ...(props.skillCatalog ?? []),
    ...skillIds
      .filter((id) => !(props.skillCatalog ?? []).some((skill) => skill.id === id))
      .map((id) => ({ id, label: id })),
  ];

  return (
    <Card title="进入下一阶段：审阅并确认">
      <p className="pentest-handoff__notice">{TRANSCRIPT_NOTICE}</p>

      {error === null ? null : <ErrorBar code={error.code} message={error.message} />}
      {notice === null ? null : <p className="pentest-handoff__notice">{notice}</p>}
      {props.contentHash !== undefined && props.contentHash !== null ? (
        <p className="pentest-handoff__hash">
          {/* 卡片窄：64 位摘要直接铺开会把行撑断，但值不能截——完整哈希放进 `title`
              （与报告导出页同一套呈现约定：人看得见的是前缀，核对得到的是全文）。 */}
          内容哈希 <code title={props.contentHash}>{`${props.contentHash.slice(0, 16)}…`}</code>
        </p>
      ) : (
        <p className="pentest-handoff__hash">
          内容哈希：调用方没有提供（服务端在读草稿时一并带回，缺它说明这条数据没走读端点）
        </p>
      )}

      {/* 第 1 块：目标阶段——**状态机决定**，人类只确认。
          2026-10-05 人类明确要求：不要「强制跳转到其他阶段」入口，也不要看起来像动作的阶段按钮
          （「进入威胁建模」被读成第二个确认按钮，与「确认并创建新会话」撞在一起）。 */}
      <section className="pentest-handoff__block">
        <h4 className="pentest-handoff__block-title">1. 目标阶段</h4>
        <p className="pentest-handoff__hint">
          {`${phaseLabel(draft.fromPhase)} → ${phaseLabel(draft.suggestedToPhase)}（状态机给出的下一阶段；推进方向不由这一屏改变）`}
        </p>
      </section>

      {/* 第 5 块后半：人类编辑区（§6.6 的全部可编辑项） */}
      <section className="pentest-handoff__block">
        <h4 className="pentest-handoff__block-title">2. 要注入下一阶段的内容（可改）</h4>
        {/* 任务目标：它随批准包进入新会话，作为下一轮任务的目标——措辞不对就在这里改。
            （删「草稿」区时这块输入必须留下：它是必填载荷，漏了就没法改目标。） */}
        <Field label="任务目标" hint="新会话收到的任务意图；改写即改变下游方向">
          <TextInput value={objective} onChange={setObjective} />
        </Field>
        {/* 提示词往往是一整篇（阶段目标 + 应产出 + 上一阶段要点 + 边界）：给足高度，
            否则人类只能在一个三行高的窗口里改论文（2026-10-05 人类要求）。 */}
        <Field label="任务提示词" hint="这是新会话实际收到的任务描述；改写即改变下游工作方向。框可拖动右下角调整高度">
          <TextArea value={prompt} onChange={setPrompt} rows={20} />
        </Field>

        <Field label="skill 勾选" hint="清空 skill 是合法状态（§6.6）；为空时需显式表决（§7.2）">
          <span className="pentest-handoff__checks">
            {skillOptions.map((skill) => (
              <label key={skill.id} className="pentest-handoff__check">
                <input
                  type="checkbox"
                  checked={skillIds.includes(skill.id)}
                  onChange={() => {
                    setSkillIds(
                      skillIds.includes(skill.id)
                        ? skillIds.filter((id) => id !== skill.id)
                        : [...skillIds, skill.id],
                    );
                  }}
                />
                <span>{skill.label}</span>
              </label>
            ))}
          </span>
        </Field>
        {skillIds.length === 0 ? (
          <label className="pentest-handoff__vote">
            <input type="checkbox" checked={skillsVotedEmpty} onChange={() => { setSkillsVotedEmpty(!skillsVotedEmpty); }} />
            <span>确认不装载任何 skill（§6.6 / §7.2 可空键须已表决）</span>
          </label>
        ) : null}

        <Field label="工具允许列表" hint="只能收窄，不能放宽超出 Profile 上界（§7.2 子集校验）">
          <span className="pentest-handoff__tools">
            {toolAllow.length === 0 ? <span>（空列表 = 不允许任何工具）</span> : toolAllow.map((tool) => (
              <span key={tool} className="pentest-handoff__tool">
                <Badge text={tool} />
                <Button label="移除" onClick={() => { setToolAllow(toolAllow.filter((item) => item !== tool)); }} />
              </span>
            ))}
            {(props.toolCatalog ?? []).filter((tool) => !toolAllow.includes(tool.id)).map((tool) => (
              <Button
                key={tool.id}
                label={`+ ${tool.label}`}
                onClick={() => { setToolAllow([...toolAllow, tool.id]); }}
              />
            ))}
          </span>
        </Field>
        <Field label="手动添加工具">
          <span className="pentest-handoff__ref-form">
            <TextInput value={toolDraft} onChange={setToolDraft} placeholder="工具名，例如 memory_search" />
            <Button
              label="添加"
              onClick={() => {
                const id = toolDraft.trim();
                if (id === '' || toolAllow.includes(id)) return;
                setToolAllow([...toolAllow, id]);
                setToolDraft('');
              }}
              disabled={toolDraft.trim() === '' || toolAllow.includes(toolDraft.trim())}
              reason="工具名不能为空且不能重复"
            />
          </span>
        </Field>

        <Field label="需逐次放行的动作类别" hint="标注为需放行的类别，执行前会进入放行队列（§7.2 approval_scope）">
          <span className="pentest-handoff__checks">
            {ACTION_CLASSES.map((actionClass) => (
              <label key={actionClass} className="pentest-handoff__check">
                <input
                  type="checkbox"
                  checked={approvalRequired.includes(actionClass)}
                  onChange={() => {
                    setApprovalRequired(
                      approvalRequired.includes(actionClass)
                        ? approvalRequired.filter((item) => item !== actionClass)
                        : [...approvalRequired, actionClass],
                    );
                  }}
                />
                <span className={toneClass('pentest-handoff__action', needsPerActionApproval(actionClass) ? 'attention' : 'neutral')}>
                  {actionClassLabel(actionClass)}
                  {needsPerActionApproval(actionClass) ? '（默认需放行）' : ''}
                </span>
              </label>
            ))}
          </span>
        </Field>
        {approvalRequired.length === 0 ? (
          <label className="pentest-handoff__vote">
            <input type="checkbox" checked={approvalVotedEmpty} onChange={() => { setApprovalVotedEmpty(!approvalVotedEmpty); }} />
            <span>确认该阶段没有任何需逐次放行的类别（§7.2 可空键须已表决）</span>
          </label>
        ) : null}

        <Field label="上下文引用（新会话会读到这些内容）">
          <List
            items={contextRefs}
            keyOf={(ref) => ref.memoryId}
            render={(ref) => {
              // 裸 id 是「展开原文」的键（记忆浏览器的 details 就按它索引）；
              // `memoryId` 本身是带前缀的引用形式，两者不能混用——混用的后果是永远展不开。
              const bareId = ref.memoryId.replace(/^memory:/, '');
              const detail = props.refDetails?.[bareId];
              const expandable = props.onExpandRef !== undefined && ref.memoryId.startsWith('memory:');
              return (
                <span className="pentest-handoff__ref">
                  <code>{ref.memoryId}</code>
                  <span>{ref.reason}</span>
                  {ref.kind == null ? null : <Badge text={ref.kind} hint="分块类型（服务端补齐）" />}
                  {ref.trust == null ? null : (
                    <Badge
                      text={TRUST_LABELS[ref.trust] ?? ref.trust}
                      tone={ref.trust === 'tool_observation' ? 'neutral' : 'attention'}
                      hint="来源可信度：工具观测 vs Agent 陈述（§8.10）——压缩摘要永远是后者"
                    />
                  )}
                  {ref.provisional === true ? <Badge text="暂定" tone="attention" hint="该分块被标记为暂定" /> : null}
                  <Button
                    label={detail === undefined ? '展开原文' : '收起'}
                    disabled={!expandable}
                    reason={
                      expandable
                        ? undefined
                        : props.onExpandRef === undefined
                          ? '调用方未提供 onExpandRef：控制台未把记忆读取端点接到本屏'
                          : '只有 memory: 引用可展开（artifact: 等引用需在证据页查看）'
                    }
                    onClick={() => {
                      if (!expandable) return;
                      props.onExpandRef?.({
                        memoryId: bareId,
                        citation: ref.memoryId,
                        // 点击时才生成：幂等键标识「这一次读取」，渲染期生成会变成「这一屏」。
                        idempotencyKey: props.controller.newKey('memory-access'),
                      });
                    }}
                  />
                  <Button
                    label="移除"
                    onClick={() => { setContextRefs(contextRefs.filter((item) => item.memoryId !== ref.memoryId)); }}
                  />
                  {detail === undefined ? null : <pre className="pentest-handoff__ref-detail">{detail}</pre>}
                </span>
              );
            }}
            empty={<span>（未选中任何引用：下游将拿不到资产与结论引用，§7.2 的内容必需键可能解析为空）</span>}
          />
        </Field>
        <Field label="新增引用" hint="引用必须是本 engagement 的记忆或证据标识">
          <span className="pentest-handoff__ref-form">
            <TextInput
              value={refDraft.memoryId}
              onChange={(next) => { setRefDraft({ ...refDraft, memoryId: next }); }}
              placeholder="memory:<uuid> / artifact:<uuid>"
            />
            <TextInput
              value={refDraft.reason}
              onChange={(next) => { setRefDraft({ ...refDraft, reason: next }); }}
              placeholder="为什么需要它"
            />
            <Button
              label="添加"
              onClick={() => {
                setContextRefs([...contextRefs, { memoryId: refDraft.memoryId.trim(), reason: refDraft.reason.trim() }]);
                setRefDraft({ memoryId: '', reason: '' });
              }}
              disabled={refDraft.memoryId.trim() === '' || refDraft.reason.trim() === '' || contextRefs.some((ref) => ref.memoryId === refDraft.memoryId.trim())}
              reason="引用标识与理由都必须填写，且不能重复"
            />
          </span>
        </Field>
        {/* 截断发生在服务端确认那一刻，但人类必须在那之前知道——否则他会以为全部引用都进了下一会话。
            这条提醒不依赖「草稿」概念：它就是编辑区里的一份前置事实（§7.4）。 */}
        {contextRefs.length <= HANDOFF_MAX_CONTEXT_REFS ? null : (
          <p className="pentest-handoff__gate">
            {`引用预算提醒：本次要带走 ${String(contextRefs.length)} 条，超出上限 ${String(HANDOFF_MAX_CONTEXT_REFS)} 条——` +
              '多出来的不会注入下一阶段（会记进交接记录的 truncatedRefs）。请删减，或把最重要的排到前面。'}
          </p>
        )}
      </section>

      <GateList blockers={gates} label="确认前置条件" />

      <div className="pentest-handoff__actions">
        <Button
          label={busy ? '正在提交…' : '确认并创建新会话'}
          kind="primary"
          onClick={confirm}
          disabled={blocked}
          reason={busy ? '正在提交' : gates.join('；')}
        />
        {/* 取消同样**不要求理由**（2026-10-05 人类明确要求）：审计照记操作者与时间。 */}
        <Button label="取消（不创建新会话）" onClick={cancel} disabled={busy} reason={busy ? '正在提交' : ''} />
      </div>
    </Card>
  );
}
