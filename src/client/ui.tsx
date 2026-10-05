/**
 * 控制台的基础 UI 组件与样式约定。
 *
 * 设计依据：docs/dsh-pentest-plugin-design.md §6.2.3
 *
 * ── 两条约定 ──
 *
 * 1. **不硬编码颜色**。组件只接受语义化的 `Tone`（`active` / `attention` /
 *    `danger` …），颜色由官方设计令牌通过 `className` 决定，深浅色自动适配。
 *    写 `style={{color:'#f00'}}` 会让界面在深色模式下不可读。
 *
 * 2. **所有文案由调用方传入或从 locale 取**。组件里不写死中文——官方契约要求
 *    客户端文案通过 locale 命名空间注册（§6.2.3「中英文案齐备」）。这里的
 *    默认值只是兜底，让组件在缺 locale 时仍可渲染。
 *
 * ── 为什么用 `createElement` 而不是 JSX ──
 *
 * 本仓的 tsconfig 已开 `jsx: react-jsx`，两者都能用。这里用 `createElement`
 * 是因为这些组件**极简**（三五个属性），而 JSX 版本需要 `.tsx` 文件与一组
 * 额外的类型标注；对基础组件而言 `createElement` 更紧凑、也更接近它在
 * 渲染树里的实际形状。业务视图用 `.tsx` 与 JSX（见 views/）。
 */

import { createElement } from 'react';
import type { ReactNode } from 'react';
import type { Tone } from './format.ts';

/** 把一个语义 tone 映射到 class 名。视图不直接拼 class。 */
export function toneClass(prefix: string, tone: Tone): string {
  return `${prefix} ${prefix}--${tone}`;
}

// ───────────────────────────── 基础组件 ─────────────────────────────

/** 区块容器。 */
export function Card(props: { readonly title?: string; readonly children: ReactNode }): ReactNode {
  return createElement(
    'section',
    { className: 'pentest-card' },
    props.title === undefined
      ? null
      : createElement('h3', { className: 'pentest-card__title' }, props.title),
    props.children,
  );
}

/** 键值对展示（总览条、状态面板）。 */
export function Stat(props: {
  readonly label: string;
  readonly value: ReactNode;
  readonly tone?: Tone;
  readonly hint?: string;
}): ReactNode {
  return createElement(
    'div',
    { className: toneClass('pentest-stat', props.tone ?? 'neutral'), title: props.hint },
    createElement('span', { className: 'pentest-stat__label' }, props.label),
    createElement('span', { className: 'pentest-stat__value' }, props.value),
  );
}

/** 状态胶囊。 */
export function Badge(props: { readonly text: string; readonly tone?: Tone; readonly hint?: string }): ReactNode {
  return createElement(
    'span',
    { className: toneClass('pentest-badge', props.tone ?? 'neutral'), title: props.hint },
    props.text,
  );
}

/**
 * 按钮。
 *
 * `disabled` 时**必须**同时给 `reason`：一个禁用的按钮不说话，人类只能猜为什么。
 * 这是设计里「闸门要可见」的直接体现——例如「下一阶段」在 Agent 还在工作时禁用，
 * 鼠标悬停应说明「Agent 正在工作」。
 */
export function Button(props: {
  readonly label: string;
  readonly onClick: () => void;
  readonly disabled?: boolean;
  readonly reason?: string;
  readonly tone?: Tone;
  readonly kind?: 'primary' | 'secondary';
}): ReactNode {
  const disabled = props.disabled === true;
  return createElement(
    'button',
    {
      type: 'button',
      className: `pentest-button pentest-button--${props.kind ?? 'secondary'}${disabled ? ' is-disabled' : ''}`,
      onClick: disabled ? undefined : props.onClick,
      disabled,
      title: disabled ? (props.reason ?? '当前不可用') : undefined,
      'aria-disabled': disabled,
    },
    props.label,
  );
}

/** 表单字段。 */
export function Field(props: {
  readonly label: string;
  readonly children: ReactNode;
  readonly hint?: string;
}): ReactNode {
  return createElement(
    'label',
    { className: 'pentest-field' },
    createElement('span', { className: 'pentest-field__label' }, props.label),
    props.children,
    props.hint === undefined ? null : createElement('span', { className: 'pentest-field__hint' }, props.hint),
  );
}

export function TextArea(props: {
  readonly value: string;
  readonly onChange: (next: string) => void;
  readonly rows?: number;
  readonly placeholder?: string;
}): ReactNode {
  return createElement('textarea', {
    className: 'pentest-textarea',
    value: props.value,
    rows: props.rows ?? 6,
    placeholder: props.placeholder,
    onChange: (event: { target: { value: string } }) => { props.onChange(event.target.value); },
  });
}

export function TextInput(props: {
  readonly value: string;
  readonly onChange: (next: string) => void;
  readonly placeholder?: string;
  readonly type?: string;
}): ReactNode {
  return createElement('input', {
    className: 'pentest-input',
    type: props.type ?? 'text',
    value: props.value,
    placeholder: props.placeholder,
    onChange: (event: { target: { value: string } }) => { props.onChange(event.target.value); },
  });
}

/** 空态。`reason` 说明**为什么**空——区分「还没有数据」与「筛选后没有匹配」。 */
export function Empty(props: { readonly title: string; readonly reason?: string }): ReactNode {
  return createElement(
    'div',
    { className: 'pentest-empty' },
    createElement('p', { className: 'pentest-empty__title' }, props.title),
    props.reason === undefined ? null : createElement('p', { className: 'pentest-empty__reason' }, props.reason),
  );
}

/** 错误条。保留稳定错误码（UI 据码分支，不解析文本）。 */
export function ErrorBar(props: {
  readonly code: string;
  readonly message: string;
  readonly tone?: Tone;
}): ReactNode {
  return createElement(
    'div',
    { className: toneClass('pentest-error', props.tone ?? 'danger'), role: 'alert' },
    createElement('code', { className: 'pentest-error__code' }, props.code),
    createElement('span', { className: 'pentest-error__message' }, props.message),
  );
}

/** 列表。 */
export function List<T>(props: {
  readonly items: readonly T[];
  readonly keyOf: (item: T) => string;
  readonly render: (item: T) => ReactNode;
  readonly empty: ReactNode;
}): ReactNode {
  if (props.items.length === 0) return props.empty;
  return createElement(
    'ul',
    { className: 'pentest-list' },
    props.items.map((item) => createElement('li', { key: props.keyOf(item), className: 'pentest-list__item' }, props.render(item))),
  );
}

/** 表格（放行队列、结论列表用；列定义由调用方给，避免各写一套表格骨架）。 */
export function Table<Row>(props: {
  readonly columns: readonly { readonly key: string; readonly header: string }[];
  readonly rows: readonly Row[];
  readonly keyOf: (row: Row) => string;
  readonly renderCell: (row: Row, columnKey: string) => ReactNode;
  readonly empty: ReactNode;
}): ReactNode {
  if (props.rows.length === 0) return props.empty;
  return createElement(
    'div',
    { className: 'pentest-table-wrap' },
    createElement(
      'table',
      { className: 'pentest-table' },
      createElement(
        'thead',
        null,
        createElement(
          'tr',
          null,
          props.columns.map((c) => createElement('th', { key: c.key }, c.header)),
        ),
      ),
      createElement(
        'tbody',
        null,
        props.rows.map((row) =>
          createElement(
            'tr',
            { key: props.keyOf(row) },
            props.columns.map((c) => createElement('td', { key: c.key }, props.renderCell(row, c.key))),
          ),
        ),
      ),
    ),
  );
}
