/**
 * 客户端产物自检：验证 `lib/client.js` 真的能被宿主的模块加载器吃下。
 *
 * ── 为什么需要它 ──
 *
 * 客户端产物的格式是**自定义的**（`window.__ModuleLoader__.load({id, factory})`），
 * 由 tsdown 的 banner/footer 包装而成。构建成功（exit 0）**不等于**格式正确——
 * 包装写错时 rolldown 照样会宣布成功，而插件在浏览器里静默不加载，
 * 没有任何服务端线索。
 *
 * 因此这里模拟宿主的加载过程：
 *   1. 提供一个假的 `window.__ModuleLoader__`，捕获 `load()` 调用；
 *   2. 在 Node 里执行产物（`vm`），得到 id 与 factory；
 *   3. 用桩 `require` **materialize** 工厂（这是宿主在首次 import 时做的事）；
 *   4. 断言导出是合法的 cordis 插件形状，且 `apply` 真的把槽位注册了进去。
 *
 * 第 4 步是关键：它证明的不只是「格式对」，而是**注册行为正确**——包括
 * 那条防重复挂载的认领标志。
 */

import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { createElement } from 'react';
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { resolve } from 'node:path';
import { runInNewContext } from 'node:vm';

const BUNDLE = resolve(process.cwd(), 'lib/client.js');
const EXPECTED_ID = 'dsh-pentest';

interface Loaded {
  readonly id: string;
  readonly factory: (require: (spec: string) => unknown) => unknown;
}

const failures: string[] = [];
const notes: string[] = [];

function check(label: string, condition: boolean, detail = ''): void {
  if (condition) notes.push(`ok   ${label}${detail === '' ? '' : `（${detail}）`}`);
  else failures.push(`FAIL ${label}${detail === '' ? '' : `（${detail}）`}`);
}

// ── 1) 执行产物，捕获 load() ──

let captured: Loaded | null = null;
const fakeWindow = {
  __ModuleLoader__: {
    load(entry: Loaded): void {
      captured = entry;
    },
  },
};

const source = readFileSync(BUNDLE, 'utf8');
runInNewContext(source, { window: fakeWindow, console, Symbol, Object, Error, TypeError });

check('产物调用 window.__ModuleLoader__.load', captured !== null);
if (captured === null) {
  console.log(failures.join('\n'));
  process.exit(1);
}

const entry: Loaded = captured;
check('产物 id 与包名一致', entry.id === EXPECTED_ID, entry.id);
check('factory 是函数', typeof entry.factory === 'function');
// 外部化：产物必须向宿主 `require` react，而不是内联一份（内联会导致两份 React 实例）。
check('产物外部化 react（require 而非内联）', source.includes('require("react")'), '');
check('产物外部化 react/jsx-runtime', source.includes('require("react/jsx-runtime")'), '');

// ── 2) materialize：模拟宿主在首次 import 时做的事 ──

/**
 * 桩 `require`：模拟宿主提供外部依赖。
 *
 * **返回真的 `react` / `react/jsx-runtime`**，而不是一个最小假实现。此前用假
 * `createElement`（返回普通对象）的后果是：本脚本可以验证素材化，却**无法把组件真的
 * 渲染出来**——而「注册了槽位」与「槽位能渲染出正确的界面」是两件事。实测正是后者的
 * 缺陷（从槽位 props 找 RPC，真机上渲染出降级提示）在自检里毫无痕迹。
 *
 * 「依赖被外部化」这件事由下面的产物源码断言负责（`require("react")` 出现在产物里
 * 而不是内联了一份 React），不靠这里的桩来表达。
 */
const requireFromHere = createRequire(import.meta.url);
const stubRequire = (spec: string): unknown => requireFromHere(spec);

let exports: Record<string, unknown>;
try {
  exports = entry.factory(stubRequire) as Record<string, unknown>;
  check('factory 可 materialize（桩 require 足够）', true);
} catch (error) {
  check('factory 可 materialize（桩 require 足够）', false, error instanceof Error ? error.message : String(error));
  console.log(failures.join('\n'));
  process.exit(1);
}

// ── 3) 导出是合法的 cordis 插件形状 ──

check('导出 name', typeof exports['name'] === 'string', String(exports['name']));
check('导出 inject 数组', Array.isArray(exports['inject']), JSON.stringify(exports['inject']));
check('导出 apply 函数', typeof exports['apply'] === 'function');

// ── 4) apply 真的注册槽位，且防重复 ──

interface Registration {
  readonly options: Record<string, unknown>;
  readonly component: unknown;
}

/**
 * 一个**忠实**的槽位桩：复刻 `SlotCore` + `SlotRegistry` 的两条关键语义。
 *
 * 此前的桩让 `register` 永远成功、且根本没有 `inject`，于是「注册到未声明的槽位」
 * 这一整类**真实失败**在自检里被完全掩盖——实测正是这个盲区让插件在真机上
 * 静默消失，而自检 16/16 全绿。桩必须与真实实现同样会拒绝。
 *
 * 语义对照（`@deepseek-ai/dsh-client-ui-slots/lib/index.js:73`、
 * `@deepseek-ai/dsh-client-ui-renderer/lib/client.js:1015`）：
 *   - `register` 到未声明的槽位 → **抛错**；
 *   - `inject(key, cb)` → 声明已存在则同步执行 cb；否则先记下来，等 `declare()` 后执行；
 *     声明塌缩（`undeclare`）会 dispose 上一次的效果。
 */
function makeSlotStub(): {
  slots: Record<string, unknown>;
  registrations: Registration[];
  /** 声明一个槽位（对应父条目的 children 表）。每个等待中的 inject 回调在此刻执行。 */
  declare(key: string): void;
  /** 撤销声明（对应声明塌缩，如 HMR 重挂设置区）。上一次的效果被 dispose。 */
  undeclare(key: string): void;
} {
  const registrations: Registration[] = [];
  const declared = new Set<string>();
  /** 每个 key 上的 inject 订阅者：**常驻**，每次声明到来都重跑。 */
  const subscribers = new Map<string, Set<() => () => void>>();
  /** 上一次声明效果产出的注销函数，塌缩时调用。 */
  let activeDisposers: Array<() => void> = [];

  const slots: Record<string, unknown> = {
    register(options: Record<string, unknown>, component: unknown): () => void {
      const name = options['name'];
      if (typeof name !== 'string' || !declared.has(name)) {
        throw new Error(
          `slot "${String(name)}" is not declared (a parent entry's children table must declare it)`,
        );
      }
      const record: Registration = { options, component };
      registrations.push(record);
      return () => {
        const at = registrations.indexOf(record);
        if (at >= 0) registrations.splice(at, 1);
      };
    },
    inject(key: string, callback: () => unknown): () => void {
      const run = (): (() => void) => {
        const result = callback();
        return typeof result === 'function' ? (result as () => void) : () => {};
      };
      const set = subscribers.get(key) ?? new Set<() => () => void>();
      set.add(run);
      subscribers.set(key, set);
      if (declared.has(key)) activeDisposers.push(run());
      // 真实的 inject 返回「取消这次等待」的 disposer。
      return () => {
        set.delete(run);
      };
    },
  };

  const declare = (key: string): void => {
    declared.add(key);
    // 声明（重新）到来 → **全部常驻订阅者重跑**，与真实实现
    // 「声明 epoch 变化即重跑」一致。这正是「一次性认领标志会破坏重挂」的原因。
    for (const run of subscribers.get(key) ?? []) activeDisposers.push(run());
  };

  const undeclare = (key: string): void => {
    declared.delete(key);
    // 声明塌缩：dispose 上一次声明效果产出的全部注销函数。
    for (const dispose of activeDisposers.splice(0)) dispose();
    for (let i = registrations.length - 1; i >= 0; i -= 1) {
      if (registrations[i]!.options['name'] === key) registrations.splice(i, 1);
    }
  };

  return { slots, registrations, declare, undeclare };
}

/** 组装一个最小的 cordis ctx（只含本插件用到的面）。 */
function makeCtx(): ReturnType<typeof makeSlotStub> & { ctx: unknown } {
  const stub = makeSlotStub();
  const logger = (): Record<string, unknown> => ({ warn: () => {}, info: () => {}, error: () => {} });
  const ctx = {
    slots: stub.slots,
    // 忠实的 locale 桩：register 存字典、bind 按当前语言查。缺一不可——
    // 只提供 `t(key)` 的桩会掩盖「从没注册过字典」这类真实失败（标签会显示原始 key）。
    locale: (() => {
      const dicts = new Map<string, Record<string, Record<string, string>>>();
      return {
        register(ns: string, d: Record<string, Record<string, string>>): () => void {
          dicts.set(ns, d);
          return () => { dicts.delete(ns); };
        },
        bind(ns: string): (key: string) => string {
          return (key: string) => dicts.get(ns)?.['zh']?.[key] ?? key;
        },
      };
    })(),
    connection: { rpc: { call: async () => ({ ok: true, value: {} }) } },
    effect(fn: () => unknown): () => void {
      fn();
      return () => {};
    },
    logger,
  };
  return { ...stub, ctx };
}

// ── 4) apply 经 slots.inject 注册，且在槽位未声明时不冒进 ──

/**
 * 取某槽位上的注册。
 *
 * 断言必须**按槽位名**检索，不能用注册总数：控制台有多个落点，任何一处新增都会
 * 让「总数等于 1」这类断言在无关改动上失败，而它本来想表达的是「设置页标签注册了」。
 */
function forSlot(stub: { readonly registrations: { readonly options: Record<string, unknown>; readonly component: unknown }[] }, name: string): { readonly options: Record<string, unknown>; readonly component: unknown }[] {
  return stub.registrations.filter((r) => r.options['name'] === name);
}

const first = makeCtx();
const apply = exports['apply'] as (ctx: unknown) => void;

// 槽位**尚未声明**时：不得注册，也不得抛（官方要求靠 inject 等声明）。
apply(first.ctx);
check(
  '槽位未声明时不注册（必须等声明，不能裸 register）',
  first.registrations.length === 0,
  `注册 ${String(first.registrations.length)} 次`,
);

// 声明到来：inject 的回调在此刻执行，注册才发生。
first.declare('settings.plugins.tab');
const tabRegs = forSlot(first, 'settings.plugins.tab');
check('声明到来后注册到槽位', tabRegs.length === 1, `注册 ${String(tabRegs.length)} 次`);

if (tabRegs.length === 1) {
  const opts = tabRegs[0]!.options;
  check('注册到 settings.plugins.tab', opts['name'] === 'settings.plugins.tab', String(opts['name']));
  check('带 id', typeof opts['id'] === 'string', String(opts['id']));
  check('带 order', typeof opts['order'] === 'number', String(opts['order']));
  // label 是 thunk（官方契约 `SlotLabel = string | (() => string)`），
  // 这样 locale 切换无需重新注册
  check('label 是 thunk', typeof opts['label'] === 'function');
  if (typeof opts['label'] === 'function') {
    const label = (opts['label'] as () => unknown)();
    check('label thunk 可求值', typeof label === 'string', String(label));
    // 文案必须真的解析出来。此前的桩没有 locale 字典能力，于是标签渲染成
    // 原始 key（`pentest.tab.label`）也能通过自检——真机上就是这么显示的。
    check('label 解析为文案而不是原始 key', label === '渗透作业', String(label));
  }
  check('注册带 locale 命名空间', typeof opts['locale'] === 'string', String(opts['locale']));
  check('组件是函数（SlotComponent 形状）', typeof tabRegs[0]!.component === 'function');
  check('导出 inject 含 connection', (exports['inject'] as string[]).includes('connection'), JSON.stringify(exports['inject']));
  // 组件必须能用 ctx 上的 connection 服务渲染出**控制台本体**，而不是那句
  // 「需要宿主的 Connection 服务」的降级提示。此前从槽位 props 找 rpc，实测拿不到
  // （owner props 刻意留空），真机上渲染的就是降级提示。
  if (typeof tabRegs[0]!.component === 'function') {
    const paint = (tabRegs[0]!.component as (p: unknown) => unknown)({});
    const html = renderToStaticMarkup(paint as never);
    check(
      '组件能从 ctx 取到 RPC 并渲染控制台（非降级提示）',
      !html.includes('需要宿主的 Connection 服务'),
      html.slice(0, 120),
    );
  }
}

// 声明塌缩后重新声明：必须能重新注册。
// （此前的「一次性认领标志」会在这里失败——第二次不再注册，标签就再也回不来。）
first.undeclare('settings.plugins.tab');
first.declare('settings.plugins.tab');
check(
  '声明塌缩后重新声明能重新注册（不得用一次性标志挡住）',
  forSlot(first, 'settings.plugins.tab').length === 1,
  `注册 ${String(forSlot(first, 'settings.plugins.tab').length)} 次`,
);

// 第二个 ctx：同一 bundle 被另一个 ctx 装载时也要注册（认领不能是模块级的）。
const second = makeCtx();
apply(second.ctx);
second.declare('settings.plugins.tab');
check(
  '另一个 ctx 装载时同样注册（认领不是模块级）',
  forSlot(second, 'settings.plugins.tab').length === 1,
  `注册 ${String(forSlot(second, 'settings.plugins.tab').length)} 次`,
);

// ── 5) 三个额外落点（§6.2 的槽位表） ──
//
// 此前只有 settings.plugins.tab 一个落点，而它是个弹窗——状态机与各阶段 Agent
// 事实上不可见。这三个落点是「看得见」的实现，因此必须在自检里被覆盖。

const surfacesStub = makeCtx();
apply(surfacesStub.ctx);
check(
  '额外落点在槽位未声明时也不冒进',
  surfacesStub.registrations.length === 0,
  `注册 ${String(surfacesStub.registrations.length)} 次`,
);

for (const key of ['main', 'sidebar.panellist', 'conversation.session.header.actions']) surfacesStub.declare(key);

const mainRegs = forSlot(surfacesStub, 'main');
const sidebarRegs = forSlot(surfacesStub, 'sidebar.panellist');
const overlayRegs = forSlot(surfacesStub, 'conversation.session.header.actions');

check('注册到 main（全高主面板）', mainRegs.length === 1, `注册 ${String(mainRegs.length)} 次`);
check('注册到 sidebar.panellist（侧栏入口）', sidebarRegs.length === 1, `注册 ${String(sidebarRegs.length)} 次`);
// 2026-10-05 起常驻状态条挂会话上栏右侧动作区，不再用底部浮层。
check('注册到 conversation.session.header.actions（常驻状态条）', overlayRegs.length === 1, `注册 ${String(overlayRegs.length)} 次`);

if (mainRegs.length === 1 && sidebarRegs.length === 1) {
  const panelKey = mainRegs[0]!.options['key'];
  const rowId = sidebarRegs[0]!.options['id'];
  // **这是本节最关键的断言**：侧栏行点击走 `ctx.layout.selectPanel(id)`，而
  // `LayoutController` 对未注册的主面板直接抛
  // `layout.selectPanel: main panel "…" is not registered`。
  // 两个值必须是同一个标识，且只有一处常量（`PENTEST_PANEL_ID`）。
  check('main 带 key', typeof panelKey === 'string', String(panelKey));
  check('侧栏行带 id', typeof rowId === 'string', String(rowId));
  check(
    'main 的 key 与侧栏行的 id 一致（不一致则点击侧栏直接抛错）',
    panelKey === rowId,
    `main.key=${String(panelKey)} sidebar.id=${String(rowId)}`,
  );
  check('侧栏行 label 是 thunk', typeof sidebarRegs[0]!.options['label'] === 'function');
}

check('会话上栏动作区带 id', typeof overlayRegs[0]?.options['id'] === 'string', String(overlayRegs[0]?.options['id']));

// 侧栏 glyph 与主面板外框都是纯组件，可以离屏渲染（渲染不出东西说明签名接错了）。
if (sidebarRegs.length === 1 && typeof sidebarRegs[0]!.component === 'function') {
  const glyph = renderToStaticMarkup(
    (sidebarRegs[0]!.component as (p: unknown) => unknown)({ size: 18, active: false }) as never,
  );
  check('侧栏 glyph 能渲染出图标', glyph.includes('<svg'), glyph.slice(0, 80));
}

if (mainRegs.length === 1 && typeof mainRegs[0]!.component === 'function') {
  const panel = renderToStaticMarkup((mainRegs[0]!.component as (p: unknown) => unknown)({}) as never);
  // 主面板必须渲染**控制台本体**，而不是「需要 Connection」的降级提示。
  check(
    '主面板渲染控制台本体（非降级提示）',
    panel.includes('pentest-mainpanel') && !panel.includes('需要宿主的 Connection 服务'),
    panel.slice(0, 140),
  );
}

if (overlayRegs.length === 1 && typeof overlayRegs[0]!.component === 'function') {
  // 状态条**用了 hooks**（要订阅控制器快照），因此必须以**元素**形式交给渲染器，
  // 不能像纯组件那样直接调用函数——直接调用会在渲染器之外执行 useState 而抛
  // `Invalid hook call`。这也是自检该覆盖它的原因：签名接错时真机上是一片空白。
  const pill = renderToStaticMarkup(
    createElement(overlayRegs[0]!.component as () => ReactNode) as never,
  );
  // 没有选中作业时状态条**不占屏幕**（常驻 UI 空着只是噪音）。
  check('未选择作业时状态条不渲染', pill === '', pill.slice(0, 80));
}

// 声明塌缩后重建：额外落点同样必须能重新注册。
surfacesStub.undeclare('main');
surfacesStub.declare('main');
check(
  '额外落点声明塌缩后能重新注册',
  forSlot(surfacesStub, 'main').length === 1,
  `注册 ${String(forSlot(surfacesStub, 'main').length)} 次`,
);

// apply 绝不抛异常（抛出去会让整个 Web 外壳启动失败）
let threw: string | null = null;
try {
  apply({ slots: undefined, logger: undefined });
} catch (error) {
  threw = error instanceof Error ? error.message : String(error);
}
check('缺 ctx.slots 时降级而不抛', threw === null, threw ?? '');

// ── 报告 ──

console.log(notes.join('\n'));
console.log(`\n总计 ${String(notes.length + failures.length)} 项，失败 ${String(failures.length)} 项`);
if (failures.length > 0) {
  console.log(failures.join('\n'));
  process.exit(1);
}
