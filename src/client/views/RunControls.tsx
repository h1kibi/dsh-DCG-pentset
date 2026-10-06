/**
 * 运行控制：**启动 Agent** 与运行期的四个人类动作（暂停 / 恢复 / 插话 / 终止）。
 *
 * ── 为什么必须有这个组件 ──
 *
 * 设计文档 §1.1 的核心决定是「人类是唯一的状态机控制器」：每个阶段由人类**显式启动**，
 * 运行中由人类观察与纠偏。而这些动作的入口此前**在界面上完全不存在**——
 * 控制器的 `startWorker` / `pause` / `resume` / `abort` / `interject` 都能用，
 * 但没有任何视图调用它们。后果是整个产品在 UI 上不成立：
 * 能建 engagement、能看报告，却**无法让 Agent 开始工作**，也无法让它停下。
 *
 * 这个组件把那五个动作接出来。它是「人工驱动」这条主线的起点。
 *
 * ── 状态怎么决定显示什么 ──
 *
 * 用两个正交字段（§5.1）：
 *   - `mainStatus`：主状态，决定**能否启动**（`ready` 是唯一可启动态）；
 *   - `runMarker`：运行标记，决定**运行期动作**（`paused` 才能恢复、`running` 才能插话）。
 *
 * 两者不互相改写，因此这里也**分别**判定，不写成一个大 switch——那会把
 * 「暂停中的交接确认」这类真实组合错误地折叠掉。
 *
 * ── 两条纪律 ──
 *
 * 1. **禁用必须说明原因**：按钮不可用时给出「为什么不可用」与「怎么才能可用」。
 *    只说「不可用」会让人反复点击。
 * 2. **写操作不要求填文字**（2026-10-05 人类要求：操作者就是本人，理由多余）：
 *    动作、操作者与时间照旧进 `human_decisions` 与审计，理由为空串；不可撤销的动作
 *    （终止）保留**二次确认勾选**——那是防手滑，不是要人写作文。
 */

import { useState } from 'react';
import type { ReactNode } from 'react';

import type { ApprovalMode, MainStatus, Phase, RunMarker } from '../../contracts.ts';
import type { RunActionAvailability as SharedRunActionAvailability } from '../../contracts.ts';
import { APPROVAL_MODES, PHASES, runActionAvailability as decideRunActions } from '../../contracts.ts';
import { APPROVAL_MODE_HINTS, APPROVAL_MODE_LABELS } from '../presets.ts';
import type { ConsoleController, ConsoleSnapshot } from '../controller.ts';
import { formatCount, mainStatusLabel, phaseLabel, runMarkerLabel } from '../format.ts';
import { Badge, Button, Card, Field, TextArea, TextInput } from '../ui.tsx';

/** 启动 Agent 时可选填写的预算上限。留空即不设限（由阶段默认值决定）。 */
interface StartBudgetForm {
  readonly maxTokensText: string;
  readonly maxStepsText: string;
  readonly maxSecondsText: string;
}

interface RunControlsProps {
  /** 唯一写入路径（§4.2）：五个动作都经它下发。 */
  readonly controller: ConsoleController;
  readonly snapshot: ConsoleSnapshot;
  readonly now?: Date;
  /** 初值（测试与「恢复上次填写」用）。 */
  readonly initialTaskPrompt?: string;
}

const EMPTY_BUDGET: StartBudgetForm = { maxTokensText: '', maxStepsText: '', maxSecondsText: '' };

/**
 * 预算上限解析：**只接受十进制正整数**。
 *
 * 事故（2026-10-05 复核 REQ-13a）：此前用 `Number.parseInt`——`'1e5'` 解析成 1
 * （想设 10 万，实际按 1 步执行）、`'2,5'` 解析成 2；而调用方无法区分「空」与
 * 「写了但解析失败」，于是一次手滑会让三项预算被**整体静默丢弃**、悄悄回落到阶段默认值。
 * 现在：语法非法一律返回 undefined，由 `startBlockers` 把「写了但解析不了」变成
 * 可见的禁用理由——拒绝提交，而不是带着默认值开跑。
 */
export function parseLimit(text: string): number | undefined {
  const trimmed = text.trim();
  // 只认纯十进制数字：科学计数法、小数、正负号、千分位、空白一律拒绝。
  if (!/^\d+$/.test(trimmed)) return undefined;
  const n = Number(trimmed);
  return Number.isSafeInteger(n) && n > 0 ? n : undefined;
}

/** 预算三项的展示名（错误信息里指出是哪一项手滑）。 */
const BUDGET_FIELD_LABELS: readonly string[] = ['tokens', '步数', '秒数'];

/**
 * 启动闸门：返回阻止启动的原因（空数组即可启动）。
 *
 * **`ready` 是唯一可启动的主状态**：`auth_pending` 是向导刚建完、授权尚未就位
 * （§5.2 的起点），其余主状态都表示已经启动过或有待人类处理的事项。
 *
 * 提成纯函数是为了能被单测穷举覆盖——写在组件里就只能靠渲染断言。
 */
export function startBlockers(input: {
  readonly mainStatus: string | null;
  readonly taskPrompt: string;
  /** 三个预算输入框的当前文本；用于判定「只填了一部分」。 */
  readonly budgetFields: readonly string[];
}): readonly string[] {
  const gates: string[] = [];
  if (input.mainStatus !== 'ready') {
    gates.push(
      input.mainStatus === 'auth_pending'
        ? '授权尚未就位：先完成授权与范围向导'
        : `当前主状态为「${input.mainStatus ?? '未知'}」，不能启动新会话`,
    );
  }
  if (input.taskPrompt.trim().length === 0) {
    gates.push('任务提示词必填：Agent 靠它知道本轮要做什么');
  }
  // 预算是「全给或全不给」：只填一部分无法构成一次会话的完整上限。
  const filled = input.budgetFields
    .map((text, index) => ({ text: text.trim(), index }))
    .filter((entry) => entry.text !== '');
  if (filled.length > 0 && filled.length < input.budgetFields.length) {
    gates.push(`预算上限要么三项都填、要么都不填；当前填了 ${String(filled.length)} 项`);
  }
  // 填了的必须**真的能解析**（2026-10-05 复核 REQ-13a）：此前只数非空个数，
  // 写 `abc`/`1e5` 也算「填了」——提交时被静默丢弃，悄悄回落到阶段默认值。
  const invalid = filled.filter((entry) => parseLimit(entry.text) === undefined);
  if (invalid.length > 0) {
    gates.push(
      `预算上限需为正整数：${invalid
        .map((entry) => `${BUDGET_FIELD_LABELS[entry.index] ?? '?'}「${entry.text}」`)
        .join('、')}。不接受小数、科学计数法或千分位分隔符`,
    );
  }
  return gates;
}

/**
 * 运行期动作的可用性 + 客户端渲染的禁用原因。
 *
 * **判定字段继承契约层**（`RunActionAvailability`）：契约新增一条动作时，这里跟着报错，
 * 而不是静默少渲染一个按钮的可用性。
 */
interface RunActionAvailability extends SharedRunActionAvailability {
  readonly pauseReason: string | null;
  readonly resumeReason: string | null;
  readonly abortReason: string | null;
  readonly interjectReason: string | null;
  readonly finishTestingReason: string | null;
}

/**
 * 按两个正交字段判定四个运行期动作。
 *
 * **判定取契约层的单源实现**（`contracts.ts` 的 `runActionAvailability`）：
 * 服务端把它当前置（拒绝并报出具体标记），这里按同一函数禁用按钮。此前两边各写一份，
 * 于是「界面挡住、经端点直调却能生效」——终止后还能暂停、再恢复出僵尸作业
 * （2026-10-05 复核 F1）。文案仍留在客户端渲染（服务端只回事实）。
 */
export function runActionAvailability(
  state: { readonly mainStatus: MainStatus; readonly runMarker: RunMarker; readonly activeWorkerSessionId: string | null } | null,
): RunActionAvailability {
  if (state === null) {
    const why = '尚未选中 engagement';
    return {
      canPause: false, canResume: false, canAbort: false, canInterject: false,
      canFinishTesting: false, canExtendBudget: false,
      pauseReason: why, resumeReason: why, abortReason: why, interjectReason: why, finishTestingReason: why,
    };
  }
  const marker = state.runMarker;
  const decided = decideRunActions(state);
  const active = state.activeWorkerSessionId !== null;
  return {
    ...decided,
    pauseReason: decided.canPause
      ? null
      : state.mainStatus === 'complete'
        ? '作业已签字导出，运行期动作不再有意义'
        : `仅运行中可暂停；当前运行标记：${runMarkerLabel(marker)}`,
    resumeReason: decided.canResume
      ? null
      : state.mainStatus === 'complete'
        ? '作业已签字导出，运行期动作不再有意义'
        : `仅已暂停或已阻塞可恢复；当前运行标记：${runMarkerLabel(marker)}`,
    // 终止对「已终止」「已失败」无意义——它们已经是终态，再终止只会产生噪音记录。
    // complete 单独说：那时标记可能还是 `running`，按标记措辞会写成「已经是终态（运行中）」，
    // 前半句与事实相反（封禁来自主状态，不是标记）。
    abortReason: decided.canAbort
      ? null
      : state.mainStatus === 'complete'
        ? '作业已签字导出，终止没有意义'
        : `已是终态：${runMarkerLabel(marker)}；终止没有意义`,
    interjectReason: decided.canInterject
      ? null
      : !active
        ? '当前没有活动 Worker 会话'
        : `插话仅在运行中送达；当前运行标记：${runMarkerLabel(marker)}`,
    finishTestingReason: decided.canFinishTesting
      ? null
      : state.mainStatus === 'complete'
        ? '作业已签字导出，不能再次结束技术测试'
        : `仅主状态为「Agent 正在运行」或「等待人工判断」且运行标记为 running 时可结束技术测试；当前主状态：${mainStatusLabel(state.mainStatus)}，运行标记：${runMarkerLabel(marker)}`,
  };
}

/** 运行控制面板。 */
export function RunControls(props: RunControlsProps): ReactNode {
  const state = props.snapshot.state;
  const engagementId = props.snapshot.selectedEngagementId;

  const [phase, setPhase] = useState<Phase>('intelligence-gathering');
  const [taskPrompt, setTaskPrompt] = useState(props.initialTaskPrompt ?? '');
  const [budget, setBudget] = useState<StartBudgetForm>(EMPTY_BUDGET);

  const [abortConfirmed, setAbortConfirmed] = useState(false);
  const [interjection, setInterjection] = useState('');

  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<{ readonly code: string; readonly message: string } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  // ── 审批模式：**运行中可切**。切换 = 写新策略版本 + 推进 policy epoch，
  //    于是旧放行凭证与在途计划当场失效（收紧与放宽都记人类决策与审计）。
  const currentApprovalMode: ApprovalMode =
    props.snapshot.engagements.find((entry) => entry.id === engagementId)?.approvalMode ?? 'human';
  const [modeTarget, setModeTarget] = useState<ApprovalMode | ''>('');
  const [modeBusy, setModeBusy] = useState(false);
  const [modeFailure, setModeFailure] = useState<string | null>(null);
  const [modeNotice, setModeNotice] = useState<string | null>(null);

  const switchApprovalMode = (): void => {
    // 不要求理由：人类是主人。理由若写了就带上，没写直接切。
    if (engagementId === null || modeTarget === '') return;
    setModeBusy(true);
    setModeFailure(null);
    setModeNotice(null);
    void props.controller
      .setApprovalMode({ engagementId, approvalMode: modeTarget })
      .then((result) => {
        if (!result.ok) {
          setModeFailure(`${result.code}：${result.message}`);
          return;
        }
        setModeNotice(
          `已切到「${APPROVAL_MODE_LABELS[modeTarget]}」：新策略版本已生效，旧放行凭证与在途计划已失效。`,
        );
        setModeTarget('');
      })
      .catch((cause: unknown) => {
        setModeFailure(cause instanceof Error ? cause.message : String(cause));
      })
      .finally(() => { setModeBusy(false); });
  };

  if (engagementId === null) {
    // 未选中 engagement 时整块不渲染：外壳已经用列表说明了「下一步做什么」，
    // 再渲染一组永远禁用的按钮只会增加噪音。
    return null;
  }

  const availability = runActionAvailability(state);
  const canStartNow = state?.mainStatus === 'ready';
  const gates = startBlockers({
    mainStatus: state?.mainStatus ?? null,
    taskPrompt,
    budgetFields: [budget.maxTokensText, budget.maxStepsText, budget.maxSecondsText],
  });

  /**
   * 统一的结果处理。
   *
   * 服务端拒绝会经控制器记进快照（由外壳的 `ErrorBar` 显示），但**抛出的异常**
   * （传输层断开、信封构造失败）不会进快照——不接住的话人类点下去什么都不会发生。
   * 与 `HandoffEditor` / `ScopeManager` 的处理保持一致。
   */
  const settle = (
    work: Promise<{ readonly ok: boolean; readonly code?: string; readonly message?: string }>,
    onOk: () => void,
  ): void => {
    setBusy(true);
    setFailure(null);
    setNotice(null);
    void work
      .then(
        (result) => {
          if (!result.ok) return;
          onOk();
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

  const submitStart = (): void => {
    if (gates.length > 0) return;
    // 契约的 `BudgetLimits` 三个字段都是**必需**的（不是可选上限，而是这次会话的完整上限），
    // 因此要么三项齐备、要么一项都不传（不传即用阶段默认值）。只填两项就发，
    // 服务端会以 `console/argument-invalid` 拒绝整次启动——那种「填了反而启动不了」的
    // 体验比多一条闸门更糟。
    const maxTokens = parseLimit(budget.maxTokensText);
    const maxSteps = parseLimit(budget.maxStepsText);
    const maxSeconds = parseLimit(budget.maxSecondsText);
    const filled = [budget.maxTokensText, budget.maxStepsText, budget.maxSecondsText]
      .filter((text) => text.trim() !== '').length;
    const parsedBudget = maxTokens !== undefined && maxSteps !== undefined && maxSeconds !== undefined
      ? { maxTokens, maxSteps, maxSeconds }
      : undefined;
    if (filled > 0 && parsedBudget === undefined) {
      // 闸门应当已经拦住；真走到这里说明调用方绕过了 UI。**拒绝提交**，
      // 而不是把三项预算静默丢掉、悄悄改用阶段默认值（2026-10-05 复核 REQ-13a）。
      setFailure({
        code: 'client/argument-invalid',
        message: '预算上限需为正整数；解析失败时不提交',
      });
      return;
    }
    settle(
      props.controller.startWorker({
        engagementId,
        phase,
        taskPrompt: taskPrompt.trim(),
        // **不传** `skillIds` / `toolAllow`：省略即由服务端用该阶段能力声明的默认装载。
        // 这里曾固定传空数组，而宿主把 allow 当白名单——空集意味着「一个工具都不给」，
        // 于是 Agent 连 `pentest_exec` 都看不见，界面上却看不出任何异常。
        ...(parsedBudget === undefined ? {} : { budget: parsedBudget }),
        reason: '',
      }),
      () => { setNotice('已请求启动 Agent；会话建立后时间轴会出现新的一轮。'); },
    );
  };

  return (
    <Card title="运行控制">
      {/* 审批模式：切换在任何时候都可用（运行中亦可）。切一次 = 新策略版本 + epoch 推进。 */}
      <div className="pentest-runcontrols__mode">
        <p className="pentest-runcontrols__mode-current">
          {`当前审批模式：${APPROVAL_MODE_LABELS[currentApprovalMode]}`}
        </p>
        <Field label="切换审批模式" hint="收紧为人工审批立刻生效；放宽到高权限后，预设内动作不再经人过目。">
          <select
            className="pentest-select"
            value={modeTarget}
            disabled={modeBusy}
            onChange={(event) => {
              const next = event.target.value;
              if ((APPROVAL_MODES as readonly string[]).includes(next)) setModeTarget(next as ApprovalMode);
            }}
          >
            <option value="" disabled>选择档位</option>
            {APPROVAL_MODES.map((mode) => (
              <option key={mode} value={mode}>{APPROVAL_MODE_LABELS[mode]}</option>
            ))}
          </select>
        </Field>
        {modeTarget === '' ? null : (
          <p className="pentest-runcontrols__mode-current">{APPROVAL_MODE_HINTS[modeTarget]}</p>
        )}
        <Button
          label={modeBusy ? '切换中…' : '切换审批模式'}
          disabled={modeBusy || modeTarget === '' || modeTarget === currentApprovalMode}
          onClick={switchApprovalMode}
          reason={
            modeTarget === ''
              ? '先选择目标档位'
              : modeTarget === currentApprovalMode
                ? '已经是该档位'
                : modeBusy
                  ? '正在提交'
                  : undefined
          }
        />
        {modeFailure === null ? null : (
          <p className="pentest-runcontrols__failure" role="alert">{`切换失败：${modeFailure}`}</p>
        )}
        {modeNotice === null ? null : <p className="pentest-runcontrols__notice">{modeNotice}</p>}
      </div>
      <div className="pentest-runcontrols__status">
        <Badge text={state === null ? '状态未知' : runMarkerLabel(state.runMarker)} tone="neutral" />
        <Badge
          text={state === null ? '—' : phaseLabel(state.currentPhase ?? phase)}
          tone="active"
          hint="当前阶段；尚未启动时显示即将启动的阶段"
        />
        {state === null || state.activeWorkerSessionId === null ? null : (
          <Badge
            text={`活动会话 ${state.activeWorkerSessionId.slice(0, 8)}`}
            tone="done"
            hint="单活动会话：一个 engagement 同时只有一个 Worker"
          />
        )}
      </div>

      {failure === null ? null : (
        <p className="pentest-runcontrols__failure">{`${failure.code}：${failure.message}`}</p>
      )}
      {notice === null ? null : <p className="pentest-runcontrols__notice">{notice}</p>}

      {/* ── 启动 ── */}
      {state !== null && !canStartNow ? null : (
        <div className="pentest-runcontrols__start">
          <Field label="阶段" hint="五个阶段严格 1:1 对应一个 Agent 会话；首个阶段通常从情报收集开始">
            {/*
              五个阶段是**互斥选项**，且它们的关系本身就是本设计的核心（§1.2、§2.1）。
              用横排按钮而不是下拉：下拉把五个阶段藏进一次点击里，而这五格是
              「我这次要启动哪一个 Agent」——是这一屏最该被看见的选择。
            */}
            <div className="pentest-phasechoice" role="radiogroup" aria-label="起始阶段">
              {PHASES.map((p) => (
                <button
                  key={p}
                  type="button"
                  role="radio"
                  aria-checked={p === phase}
                  className={`pentest-phasechoice__item${p === phase ? ' is-active' : ''}`}
                  onClick={() => { setPhase(p); }}
                >
                  {phaseLabel(p)}
                </button>
              ))}
            </div>
          </Field>

          <Field
            label="任务提示词"
            hint="本轮要让 Agent 做什么。它会作为任务简报进入新会话；写得越具体，Agent 越不容易跑偏"
          >
            <TextArea
              value={taskPrompt}
              onChange={setTaskPrompt}
              placeholder="例如：枚举 lab.example.com 的外部攻击面，标注证据来源，不要执行主动扫描。"
            />
          </Field>

          <div className="pentest-runcontrols__budget">
            <Field label="token 上限" hint="三项要么都填、要么都不填；不填即用阶段默认上限。达到硬阈值会自动暂停并等待人工决定">
              <TextInput value={budget.maxTokensText} onChange={(v) => { setBudget((b) => ({ ...b, maxTokensText: v })); }} placeholder="例如 200000" />
            </Field>
            <Field label="步数上限" hint="留空即不设限">
              <TextInput value={budget.maxStepsText} onChange={(v) => { setBudget((b) => ({ ...b, maxStepsText: v })); }} placeholder="例如 60" />
            </Field>
            <Field label="挂钟上限" hint="留空即不设限；单位：秒">
              <TextInput value={budget.maxSecondsText} onChange={(v) => { setBudget((b) => ({ ...b, maxSecondsText: v })); }} placeholder="例如 3600" />
            </Field>
          </div>


          {gates.length === 0 ? null : (
            <ul className="pentest-runcontrols__gates">
              {gates.map((gate) => <li key={gate}>{gate}</li>)}
            </ul>
          )}

          <Button
            label={busy ? '正在启动…' : '启动 Agent'}
            kind="primary"
            onClick={submitStart}
            disabled={gates.length > 0 || busy}
            reason={gates.length > 0 ? gates[0] : busy ? '正在提交' : undefined}
          />
        </div>
      )}

      {/* ── 运行期动作 ── */}
      <div className="pentest-runcontrols__actions">
        <Button
          label="暂停"
          onClick={() => { settle(props.controller.pause(''), () => { setNotice('已暂停。'); }); }}
          disabled={!availability.canPause || busy}
          reason={
            availability.pauseReason ?? (busy ? '正在提交' : undefined)
          }
        />

        <Button
          label="恢复"
          onClick={() => { settle(props.controller.resume(''), () => { setNotice('已恢复。'); }); }}
          disabled={!availability.canResume || busy}
          reason={
            availability.resumeReason ?? (busy ? '正在提交' : undefined)
          }
        />

        <Field
          label="插话内容"
          hint="运行中按步骤边界送达；改变 Agent 的判断，不改变范围与权限"
        >
          <TextArea value={interjection} onChange={setInterjection} placeholder="例如：跳过那个端口，它属于客户的生产系统" />
        </Field>
        <Button
          label="发送插话"
          onClick={() => {
            const sessionId = state?.activeWorkerSessionId;
            if (sessionId === null || sessionId === undefined) return;
            settle(props.controller.interject(sessionId, interjection.trim()), () => {
              setInterjection('');
              setNotice('插话已投递。');
            });
          }}
          disabled={!availability.canInterject || interjection.trim() === '' || busy}
          reason={
            availability.interjectReason ??
            (interjection.trim() === '' ? '插话内容必填' : busy ? '正在提交' : undefined)
          }
        />

        <label className="pentest-check">
          <input
            type="checkbox"
            checked={abortConfirmed}
            onChange={(event) => { setAbortConfirmed(event.target.checked); }}
          />
          确认终止，不可撤销
        </label>
        <Button
          label="终止"
          onClick={() => { settle(props.controller.abort(''), () => { setNotice('已终止。'); }); }}
          disabled={!availability.canAbort || !abortConfirmed || busy}
          reason={
            availability.abortReason ??
            (!abortConfirmed ? '终止不可撤销，需勾选二次确认' : busy ? '正在提交' : undefined)
          }
        />
        <Button
          label="结束技术测试"
          // 这条边此前**没有界面入口**：服务端有 `finishTechnicalTesting`（§13.8），
          // 但没有任何视图调用它，人类只能看着报告面板提示「先完成技术测试」却点不到。
          // 它不接阶段切换（那是「下一阶段」按钮的事），只把作业送进 report_ready 并生成草稿。
          onClick={() => {
            settle(props.controller.finishTechnicalTesting('人类结束技术测试'), () => {
              setNotice('已结束技术测试：报告草稿已生成，可在报告面板复核与签字。');
            });
          }}
          disabled={!availability.canFinishTesting || busy}
          reason={availability.finishTestingReason ?? (busy ? '正在提交' : undefined)}
        />
      </div>

      <p className="pentest-runcontrols__hint">
        {`状态版本 ${formatCount(state?.stateVersion ?? 0)} · 图迭代 ${formatCount(state?.graphIteration ?? 0)}。`}
        {' 所有写操作都记入人类决策与审计：操作者与时间。'}
      </p>
    </Card>
  );
}
