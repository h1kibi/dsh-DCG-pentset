/**
 * Skill 库：skill 的增删改（§2.2「可添加」）与装载选择（§2.2「可选择」/「可为空」）。
 *
 * 设计依据：docs/dsh-pentest-plugin-design.md §2.2、§6.2.1、§6.6、§7.2
 *
 * ── 三条产品规则（§2.2），逐条落到界面上 ──
 *
 * 1. **可添加**：新增需要名称、描述与正文。正文是 **Agent 会遵循的指令文本**，因此新增界面
 *    必须显式提示 {@link INJECTION_RISK}——「装载来源不明的 skill 等于允许其作者向 Agent
 *    注入指令」。这句话不是免责声明，它是人类决定勾不勾选这一条时的唯一依据；同时每条
 *    非本人添加的条目在列表与勾选区都标出来源（§6.2.1「编辑非本人添加的条目时提示来源」）。
 * 2. **可选择**：任意阶段的 Agent 都能装载库中任意 skill，不按阶段硬性限制。因此本视图
 *    **没有**「阶段 → 可选 skill」的过滤（{@link ANY_PHASE_NOTE}）——是否合适由装载它的人类
 *    判断，插件不预设。
 * 3. **可为空**：不装载任何 skill 是合法状态。空集是一个**显式选项**，不是「什么都没勾」
 *    的结果：勾选框未点是「尚未决定」，勾上「不装载任何 skill」才是「有意为空」。
 *    这个区分不是洁癖——§7.2 对可空但须已表决的键（`skill_ids`）要求人类显式提交过决定。
 *
 * ── 会话隔离 ──
 *
 * skill 装载在创建会话时冻结（§2.2/§2.4）。修改库里的 skill 不影响已创建的会话，只对之后
 * 创建的会话生效。界面必须说这句（{@link SESSION_ISOLATION}），否则人类会以为改完就立刻
 * 改变了正在跑的 Agent 的能力。
 *
 * ── 端点现状（已接线）──
 *
 * §2.2 的四个动作都有真实端点，且都在控制台方法表里（`src/console/rpc.ts`）：
 *
 *   - `listSkills`    —— 库列表（名称、描述、添加者、添加时间、内容哈希，§6.2.1）
 *   - `addSkill`      —— §2.2 新增（记录操作者、理由与内容哈希）
 *   - `updateSkill`   —— §2.2 编辑（revision 递增）
 *   - `removeSkill`   —— §2.2 删除（表上是 `disabled` 软停用：已创建会话的装载集合不受影响）
 *
 * 对应契约 `PentestSkillService`（`src/contracts.ts`），错误码 `skill_name_taken` 表示重名。
 *
 * 本组件仍然**不自己发请求**：`onAddSkill` / `onUpdateSkill` / `onRemoveSkill` /
 * `onSelectionChange` 是意图出口，缺回调时按钮禁用并说明缺什么（回调式，与其余视图一致）。
 *
 * 这里曾写「契约里没有 SkillService、方法表里没有任何 skill 端点」——那是本视图写成时的
 * 事实，后来服务面与端点都补齐了，注释却留着。过时的注释比没有注释更贵：它会让人
 * 以为功能不可用而绕过它。判断端点是否存在请用 `isConsoleMethod`（`console/method-names.ts`，运行时探测），
 * 不要读这段文字。
 *
 * ── 服务端渲染 ──
 *
 * 纯函数组件、纯 props：不订阅控制器、不碰 `window`/`document`、渲染期不发请求。
 */

import { useState } from 'react';
import type { ReactNode } from 'react';
import type { ConsoleController, ConsoleSnapshot } from '../controller.ts';
import { formatCount, formatTimestamp, truncate } from '../format.ts';
import { Badge, Button, Card, Empty, ErrorBar, Field, List, Stat, Table, TextArea, TextInput } from '../ui.tsx';

// ───────────────────────── 文案（§6.2.3 要求文案可经 locale 覆盖；本仓暂无完整 locale 表，先集中在此） ─────────────────────────

/**
 * §2.2 的风险提示。放在**新增表单内**与**非本人添加条目的勾选框旁**，因为这两处正是
 * 人类即将把一段陌生文本变成 Agent 指令的时刻。
 */
export const INJECTION_RISK =
  'skill 正文是 Agent 会遵循的指令文本：装载来源不明的 skill，等于允许其作者向 Agent 注入指令。';

/** §2.2 会话隔离。 */
export const SESSION_ISOLATION =
  'skill 装载在创建会话时冻结：修改库里的 skill 不影响已创建的会话，只对之后创建的会话生效。';

/** §2.2「可选择」：不按阶段硬性限制。 */
const ANY_PHASE_NOTE =
  '任意阶段的 Agent 都可以装载库中任意 skill，不按阶段硬性限制——是否合适由装载它的人类判断，插件不预设。';

/** §2.2「可为空」：空集是显式选项。 */
const EMPTY_SET_LABEL = '不装载任何 skill';
const EMPTY_SET_HINT =
  '空集意味着 Agent 仅凭自身 Profile 与人类写清楚的任务提示词工作。'
  + '取消勾选表示「还没决定」；要表达不装载，就显式勾上这一项。';

const UNDECIDED_NOTE =
  '尚未作出装载选择：请显式勾选「不装载任何 skill」或至少勾选一个条目。';

const AUDIT_NOTE =
  '新增与修改会记录操作者、时间与内容哈希，形成审计条目。';

// ───────────────────────── 类型 ─────────────────────────

/**
 * 库中的一条 skill。
 *
 * 契约里没有 `SkillSummary`，因此这里按数据库表 `pentest.skills`（`src/db/migrations/001_init.sql`）
 * 与 §6.2.1 要求展示的字段定义：名称、描述、正文、添加者、添加时间、内容哈希，外加
 * `revision`（编辑递增）与 `disabled`（删除在表上是软停用，历史会话的装载集合仍然可读）。
 */
export interface SkillView {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  /** 正文：Agent 会遵循的指令文本（§2.2）。 */
  readonly body: string;
  readonly contentHash: string;
  readonly addedBy: string;
  readonly revision: number;
  readonly disabled: boolean;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** 可编辑的字段。名称/描述/正文三者都必填（§2.2）。 */
interface SkillDraftForm {
  readonly name: string;
  readonly description: string;
  readonly body: string;
}

export const EMPTY_SKILL_DRAFT: SkillDraftForm = { name: '', description: '', body: '' };

export function draftOf(skill: SkillView): SkillDraftForm {
  return { name: skill.name, description: skill.description, body: skill.body };
}

/** 新增请求。`idempotencyKey` 由视图在点击时生成（§15.3）。 */
export interface SkillAddInput extends SkillDraftForm {
  readonly idempotencyKey: string;
}

/** 修改请求。 */
export interface SkillUpdateInput extends SkillDraftForm {
  readonly skillId: string;
  readonly idempotencyKey: string;
}

/** 删除请求（表上是软停用）。 */
export interface SkillRemoveInput {
  readonly skillId: string;
  readonly name: string;
  readonly idempotencyKey: string;
}

// ───────────────────────── 纯规则 ─────────────────────────

/** 新增/编辑表单的禁用理由。空数组表示可以提交。 */
export function skillDraftBlockers(input: {
  readonly form: SkillDraftForm;
  /** 编辑时传被编辑条目的标识，用于放行「名称没改」这一情况。 */
  readonly editingSkillId?: string | null;
  readonly skills: readonly SkillView[];
  readonly provided: boolean;
  readonly method: string;
}): readonly string[] {
  const blockers: string[] = [];
  const name = input.form.name.trim();
  if (name === '') blockers.push('名称必填');
  if (input.form.description.trim() === '') blockers.push('描述必填');
  if (input.form.body.trim() === '') {
    blockers.push('正文必填：正文就是 Agent 会遵循的指令文本，空正文等于装载一个没有指令的 skill');
  }
  // 停用的条目同样占用名称：`pentest.skills.name` 的唯一约束不看 `disabled`。
  const duplicated = input.skills.some(
    (skill) => skill.id !== input.editingSkillId && skill.name === name,
  );
  if (name !== '' && duplicated) {
    blockers.push('名称已存在：skill 名称在库中唯一 · pentest.skills.name 的唯一约束');
  }
  if (!input.provided) {
    blockers.push(`控制台方法表未导出 skill 端点 ${input.method}：改动无法提交`);
  }
  return blockers;
}

/** 表单内容是否与上一次提交的完全相同。用于阻止用新幂等键重复提交同一份内容（§15.3）。 */
function sameDraft(a: SkillDraftForm, b: SkillDraftForm): boolean {
  return a.name === b.name && a.description === b.description && a.body === b.body;
}

/** 列表列定义。顺序即阅读顺序（§6.2.1 要求展示的字段）。 */
export const SKILL_COLUMNS: readonly { readonly key: string; readonly header: string }[] = [
  { key: 'name', header: '名称' },
  { key: 'description', header: '描述' },
  { key: 'addedBy', header: '添加者' },
  { key: 'addedAt', header: '添加时间' },
  { key: 'contentHash', header: '内容哈希' },
  { key: 'actions', header: '操作' },
];

// ───────────────────────── 组件 ─────────────────────────

interface SkillLibraryProps {
  /**
   * 控制台控制器。按控制台视图的统一 props 契约接收（调用方总是同时给 controller +
   * snapshot）。本视图**不订阅**它，只用 `newKey()` 为写操作生成幂等键（§15.3）。
   */
  readonly controller: ConsoleController;
  readonly snapshot: ConsoleSnapshot;
  readonly skills: readonly SkillView[];
  readonly loading?: boolean;
  readonly error?: { readonly code: string; readonly message: string } | null;
  /**
   * 当前操作者标识。与 `addedBy` 比对，用于「编辑非本人添加的条目时提示来源」（§6.2.1）。
   * 缺省时不标注来源（无法判定谁是谁，不猜）。
   */
  readonly operatorId?: string | null;
  /**
   * 已勾选的装载集合。`null` 表示**尚未决定**，`[]` 表示**有意选择空集**（§2.2 可为空；
   * §7.2 要求可空的键必须已表决）。提供 `onSelectionChange` 时才渲染勾选区。
   */
  readonly selection?: readonly string[] | null;
  readonly onSelectionChange?: (next: readonly string[] | null) => void;
  readonly onAddSkill?: (input: SkillAddInput) => void;
  readonly onUpdateSkill?: (input: SkillUpdateInput) => void;
  readonly onRemoveSkill?: (input: SkillRemoveInput) => void;
  readonly now?: Date;
}

export function SkillLibrary(props: SkillLibraryProps): ReactNode {
  const [draft, setDraft] = useState<SkillDraftForm>(EMPTY_SKILL_DRAFT);
  /** 上一次提交的草稿：与当前草稿相同时禁止再次提交（否则会以新幂等键重复写入，§15.3）。 */
  const [submittedDraft, setSubmittedDraft] = useState<SkillDraftForm | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);

  const operatorId = props.operatorId ?? null;
  const available = props.skills.filter((skill) => !skill.disabled);
  const selectionMode = props.onSelectionChange !== undefined;
  const selection = props.selection ?? null;
  const emptySetChosen = selection !== null && selection.length === 0;
  /** 编辑中的条目。库里已经没有它（被删除或刷新掉了）时按不在编辑处理。 */
  const editing = editingId === null ? null : props.skills.find((skill) => skill.id === editingId) ?? null;

  const addBlockers = skillDraftBlockers({
    form: draft,
    skills: props.skills,
    provided: props.onAddSkill !== undefined,
    // 用**控制台真实端点名**：此前写的是 `skill.add`，而方法表里的名字是 `addSkill`
    // （`console/rpc.ts`）。那串文字只出现在禁用理由里，因此不会导致功能错误——
    // 但它会让人照着去搜一个不存在的端点，属于会误导排查的文案。
    method: 'addSkill',
  });
  /** 同一份内容已提交过：再用一次点击会以新幂等键重复写入（§15.3），因此禁止。 */
  const addResubmitBlocked = submittedDraft !== null && sameDraft(submittedDraft, draft);

  return (
    <div className="pentest-skill-library">
      <Card title="Skill 库">
        <div className="pentest-skill-library__summary">
          <Stat label="库内条目" value={formatCount(props.skills.length)} />
          <Stat
            label="可用"
            value={formatCount(available.length)}
            tone={available.length === 0 ? 'attention' : 'neutral'}
            hint="未停用的条目；只有这些能被勾选装载"
          />
          <Stat label="已停用" value={formatCount(props.skills.length - available.length)} />
          {selectionMode ? (
            <Stat
              label="已选择"
              value={selection === null ? '尚未决定' : selection.length === 0 ? '空集 · 有意' : formatCount(selection.length)}
              tone={selection === null ? 'attention' : selection.length === 0 ? 'done' : 'active'}
              hint={selection === null ? UNDECIDED_NOTE : undefined}
            />
          ) : null}
        </div>

        {props.error === null || props.error === undefined ? null : (
          <ErrorBar code={props.error.code} message={props.error.message} />
        )}
        {props.snapshot.conflict ? (
          <ErrorBar
            code="stale_state_version"
            message="另一个界面先提交了改动；本页显示的可能不是最新状态。"
            tone="attention"
          />
        ) : null}
        {props.loading === true ? <Badge text="读写中" tone="active" /> : null}

        <p className="pentest-skill-library__note" role="note">
          {SESSION_ISOLATION}
        </p>
        <p className="pentest-skill-library__note" role="note">
          {ANY_PHASE_NOTE}
        </p>

        <Table
          columns={SKILL_COLUMNS}
          rows={props.skills}
          keyOf={(skill) => skill.id}
          renderCell={(skill, columnKey) => renderSkillCell({
            skill,
            columnKey,
            operatorId,
            now: props.now,
            removable: props.onRemoveSkill !== undefined,
            onEdit: () => {
              // 草稿由 SkillEditForm 自己按被编辑的条目初始化
              setEditingId(skill.id);
            },
            onRemove: props.onRemoveSkill,
            newKey: () => props.controller.newKey('skill-remove'),
          })}
          empty={(
            <Empty
              title="skill 库为空"
              reason="可以新增 skill，填名称、描述、正文；也可以直接选择「不装载任何 skill」。"
            />
          )}
        />
      </Card>

      {!selectionMode ? null : (
        <Card title="勾选装载 · 会话创建 / 阶段切换用">
          <p className="pentest-skill-library__note" role="note">
            {props.snapshot.selectedEngagementId === null
              ? '尚未选中 engagement：装载集合在创建会话时生效。'
              : `装载集合将用于 engagement ${props.snapshot.selectedEngagementId} 之后创建的会话；已创建的会话不受影响。`}
          </p>

          <label className="pentest-check">
            <input
              type="checkbox"
              checked={emptySetChosen}
              onChange={(event: { readonly target: { readonly checked: boolean } }) => {
                // 勾上 = 有意为空；取消 = 回到「尚未决定」，而不是「零个元素」。
                props.onSelectionChange?.(event.target.checked ? [] : null);
              }}
            />
            <span>{EMPTY_SET_LABEL}</span>
          </label>
          <p className="pentest-skill-library__hint">{EMPTY_SET_HINT}</p>
          {selection === null ? (
            <p className="pentest-skill-library__undecided" role="note">
              {UNDECIDED_NOTE}
            </p>
          ) : null}

          <List
            items={available}
            keyOf={(skill) => skill.id}
            empty={(
              <Empty
                title="库里没有可装载的 skill"
                reason="新增一条 skill 后即可勾选；或者直接选中「不装载任何 skill」。"
              />
            )}
            render={(skill) => (
              <label className="pentest-check">
                <input
                  type="checkbox"
                  value={skill.id}
                  checked={selection?.includes(skill.id) ?? false}
                  onChange={(event: { readonly target: { readonly checked: boolean } }) => {
                    const current = selection ?? [];
                    props.onSelectionChange?.(event.target.checked
                      ? [...current, skill.id]
                      : current.filter((id) => id !== skill.id));
                  }}
                />
                <span className="pentest-skill-library__pick-name">{skill.name}</span>
                <span className="pentest-skill-library__pick-desc">{truncate(skill.description, 80)}</span>
                {skill.addedBy === operatorId ? null : (
                  <Badge
                    text="来源：他人添加"
                    tone="attention"
                    hint={`${INJECTION_RISK} 添加者：${skill.addedBy}`}
                  />
                )}
              </label>
            )}
          />
        </Card>
      )}

      <Card title="新增 skill">
        <p className="pentest-skill-library__risk" role="note">
          {INJECTION_RISK}
        </p>
        <Field label="名称" hint="库内唯一；勾选界面按名称展示">
          <TextInput
            value={draft.name}
            onChange={(next) => {
              setDraft({ ...draft, name: next });
            }}
            placeholder="例如：dns-cert"
          />
        </Field>
        <Field label="描述" hint="让人判断「这条 skill 是干什么的」；它不注入 Agent">
          <TextArea
            value={draft.description}
            onChange={(next) => {
              setDraft({ ...draft, description: next });
            }}
            rows={2}
            placeholder="一句话说明适用范围与预期产出"
          />
        </Field>
        <Field label="正文" hint="Agent 会遵循的指令文本。装载后这段文字即成为 Agent 的指令">
          <TextArea
            value={draft.body}
            onChange={(next) => {
              setDraft({ ...draft, body: next });
            }}
            rows={6}
            placeholder="写给 Agent 的指令"
          />
        </Field>
        <p className="pentest-skill-library__hint">{AUDIT_NOTE}</p>
        <Button
          label="加入 skill 库"
          kind="primary"
          disabled={addBlockers.length > 0 || addResubmitBlocked}
          reason={addBlockers[0] ?? (addResubmitBlocked ? '这份内容已提交，幂等键已生成：改动任意字段即可再次提交' : undefined)}
          onClick={() => {
            if (addBlockers.length > 0 || addResubmitBlocked) return;
            const submitted = draft;
            setSubmittedDraft(submitted);
            props.onAddSkill?.({
              name: submitted.name.trim(),
              description: submitted.description.trim(),
              body: submitted.body,
              idempotencyKey: props.controller.newKey('skill-add'),
            });
          }}
        />
      </Card>

      {editing === null ? null : (
        <SkillEditForm
          key={editing.id}
          skill={editing}
          operatorId={operatorId}
          skills={props.skills}
          provided={props.onUpdateSkill !== undefined}
          onSave={(input) => {
            props.onUpdateSkill?.({ ...input, idempotencyKey: props.controller.newKey('skill-update') });
            setEditingId(null);
          }}
          onCancel={() => {
            setEditingId(null);
          }}
          {...(props.now === undefined ? {} : { now: props.now })}
        />
      )}
    </div>
  );
}

/**
 * 编辑一条 skill 的表单。
 *
 * 单独成一个组件而不是内联在 `SkillLibrary` 里：它**必须能在服务端渲染下被验证**——
 * 「编辑非本人添加的条目时提示来源」（§6.2.1）与「改动只对之后创建的会话生效」（§2.2）
 * 这两条提示都只在这里出现，而它们在没有点击能力的渲染测试里否则就完全不可测。
 *
 * 幂等键由调用方在 `onSave` 里生成（§15.3：一次新点击一个新键），因此本组件保持纯函数。
 */
export function SkillEditForm(props: {
  readonly skill: SkillView;
  readonly operatorId: string | null;
  readonly skills: readonly SkillView[];
  /** `onUpdateSkill` 是否已接线。未接线时保存按钮禁用并说明缺哪个端点。 */
  readonly provided: boolean;
  readonly onSave?: (input: Omit<SkillUpdateInput, 'idempotencyKey'>) => void;
  readonly onCancel?: () => void;
  readonly now?: Date;
}): ReactNode {
  const [draft, setDraft] = useState<SkillDraftForm>(() => draftOf(props.skill));
  const blockers = skillDraftBlockers({
    form: draft,
    editingSkillId: props.skill.id,
    skills: props.skills,
    provided: props.provided,
    method: 'updateSkill',
  });

  return (
    <Card title={`编辑 skill：${props.skill.name}`}>
      <p className="pentest-skill-library__note">
        {`来源：${props.skill.addedBy} 添加于 ${formatTimestamp(props.skill.createdAt, props.now)}；内容哈希 ${truncate(props.skill.contentHash, 16)}`}
      </p>
      {props.skill.addedBy === props.operatorId ? null : (
        <p className="pentest-skill-library__risk" role="note">
          {`你正在编辑 ${props.skill.addedBy} 添加的条目。${INJECTION_RISK}`}
        </p>
      )}
      <p className="pentest-skill-library__note" role="note">
        {SESSION_ISOLATION}
      </p>
      <Field label="名称">
        <TextInput
          value={draft.name}
          onChange={(next) => {
            setDraft({ ...draft, name: next });
          }}
        />
      </Field>
      <Field label="描述">
        <TextArea
          value={draft.description}
          onChange={(next) => {
            setDraft({ ...draft, description: next });
          }}
          rows={2}
        />
      </Field>
      <Field label="正文" hint="改动只对之后创建的会话生效">
        <TextArea
          value={draft.body}
          onChange={(next) => {
            setDraft({ ...draft, body: next });
          }}
          rows={6}
        />
      </Field>
      <Button
        label="保存修改"
        kind="primary"
        disabled={blockers.length > 0}
        reason={blockers[0]}
        onClick={() => {
          if (blockers.length > 0) return;
          props.onSave?.({
            skillId: props.skill.id,
            name: draft.name.trim(),
            description: draft.description.trim(),
            body: draft.body,
          });
        }}
      />
      <Button
        label="取消"
        onClick={() => {
          props.onCancel?.();
        }}
      />
    </Card>
  );
}

/** 表格单元格。闭包了操作者的按钮处理器，因此表定义留在组件内。 */
function renderSkillCell(input: {
  readonly skill: SkillView;
  readonly columnKey: string;
  readonly operatorId: string | null;
  readonly now?: Date;
  readonly removable: boolean;
  readonly onEdit: () => void;
  readonly onRemove?: (input: SkillRemoveInput) => void;
  readonly newKey: () => string;
}): ReactNode {
  const { skill } = input;
  switch (input.columnKey) {
    case 'name':
      return (
        <>
          <span className="pentest-skill-library__name">{skill.name}</span>
          {skill.revision > 1 ? (
            <Badge text={`第 ${formatCount(skill.revision)} 版`} hint="编辑会使修订号递增" />
          ) : null}
          {skill.disabled ? (
            <Badge
              text="已停用"
              tone="neutral"
              hint="删除是停用而不是物理删除：已创建会话冻结的装载集合仍然可读"
            />
          ) : null}
        </>
      );
    case 'description':
      return <span className="pentest-skill-library__desc">{truncate(skill.description, 120)}</span>;
    case 'addedBy':
      return (
        <>
          <code className="pentest-skill-library__adder">{skill.addedBy}</code>
          {skill.addedBy === input.operatorId ? null : (
            <Badge text="他人添加" tone="attention" hint={INJECTION_RISK} />
          )}
        </>
      );
    case 'addedAt':
      return <span>{formatTimestamp(skill.createdAt, input.now)}</span>;
    case 'contentHash':
      return (
        <code className="pentest-skill-library__hash" title={skill.contentHash}>
          {truncate(skill.contentHash, 16)}
        </code>
      );
    case 'actions':
      return (
        <>
          <Button label="编辑" onClick={input.onEdit} />
          <Button
            label="删除"
            tone="danger"
            disabled={skill.disabled || !input.removable}
            reason={skill.disabled
              ? '该条目已停用'
              : '控制台方法表未导出 skill 删除端点 removeSkill'}
            onClick={() => {
              input.onRemove?.({ skillId: skill.id, name: skill.name, idempotencyKey: input.newKey() });
            }}
          />
        </>
      );
    default:
      return null;
  }
}
