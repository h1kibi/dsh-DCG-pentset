/**
 * 控制台设计系统：**唯一**的颜色、字体、间距、动效来源。
 *
 * ── 为什么单独一个模块 ──
 *
 * 原来的样式表把颜色写成 `var(--dsw-alias-*)`（宿主令牌，深浅色自动跟随），代价是
 * 视觉语言完全由宿主决定，插件没有自己的性格。这一版选择**深色单主题的磷光终端**
 * 方向（人类显式决定，见 2026-10-04 的设计确认），于是颜色必须自持：
 *
 *   - 令牌只在本模块定义**一次**；`styles/*.css.ts` 里的组件规则**只允许**引用
 *     `var(--pt-*)`，不允许出现任何字面颜色。这条由 `test/client-surfaces.test.ts`
 *     用「组件规则内零字面颜色 + 每个引用都能在本文件找到」两条断言锁住。
 *   - 令牌块挂在插件的每个根元素上（`.pentest-console` / `.pentest-mainpanel` /
 *     `.pentest-statusbar` / 会话卡片），**不写 `:root`**——宿主也是同一个 DOM，
 *     不能污染它的其它面板。
 *
 * ── 方向：深色 CRT 仪表盘，天蓝强调 ──
 *
 * 一台嵌在现代外壳里的加固终端：**天蓝**读数（与 dsh 的蓝色主调同源）、琥珀色等待、
 * 暖红危险、冷调近黑底、等宽网格、扫描线与辉光。
 * 约束是「盯屏六小时不累」——所以辉光只在**活动元素**上出现，动画只在**状态改变**时
 * 发生，静息状态是平的、暗的、安静的。
 *
 * 色相历史：第一版用了磷光绿（`phos`），人类看过实机后判定「墨绿和 dsh 不太配」，
 * 2026-10-04 改为天蓝（`sky`），背景同步从绿调改成冷调近黑——否则底色会与蓝色打架。
 * 令牌只换了值，**结构、布局、动效一字未动**：这就是「颜色只有一个定义处」的兑现方式。
 *
 * 对比度（WCAG）：**最坏背景**下的实测值——背景取 {void, bg, module, well} 与四种
 * 语义底纹（wash，按各自透明度叠在 module 上）中最不利的一个。文字令牌全部 ≥ 4.5:1
 * （ink 12.0、inkDim 6.9、inkFaint 4.6、sky 7.3、skyDim 4.9、info 7.2、amber 8.5、
 * red 5.4）；主按钮上的 void 文字对 sky 9.6:1。
 * 由测试按同一套背景与算法复核：改色到不达标会失败。**上一版就是靠这条抓出来的**
 * （inkFaint #5A8577 只有 4.36:1——原来只对 `bg` 算，漏了更亮的 module 与底纹）。
 */

/** 颜色令牌。键名即 CSS 变量名（去掉 `--pt-` 前缀）。 */
export const PALETTE = {
  /** 最底：我们的容器背景。 */
  void: '#060A10',
  /** 面板表面。 */
  bg: '#0A111A',
  /** 抬起的卡片（模块）。 */
  raise: '#0E1721',
  /** 内凹的井（代码块、命令、日志）。 */
  inset: '#04070C',
  /** 发丝线（分隔、边框）。 */
  line: '#16222F',
  /** 更弱的线（同一模块内部）。 */
  lineSoft: '#0F1826',
  /** 主文字：带冷调偏白的墨色。 */
  ink: '#D8E8F5',
  /** 次要文字。 */
  inkDim: '#93B4CC',
  /** 三级文字（标签、单位）。 */
  inkFaint: '#6C93AF',
  /** 主强调：活动、当前、通过。**天蓝**——与 dsh 的蓝色主调一致（2026-10-04 人类决定）。 */
  sky: '#5FBDFF',
  /** 强调的暗调（边框、完成态、静息脉动）。 */
  skyDim: '#3D9ADB',
  /** 等待人类判断。 */
  amber: '#FFB454',
  /** 错误、阻塞、危险。 */
  red: '#FF6B6B',
  /** 信息、链接、次要强调：偏紫的天蓝，与主强调能一眼分开。 */
  info: '#9FB0FF',
} as const;

export type PaletteKey = keyof typeof PALETTE;

/** 语义别名：视图与样式规则用这些名字，不直接挑色相。 */
const SEMANTIC: Readonly<Record<string, PaletteKey>> = {
  'bg-void': 'void',
  'bg-panel': 'bg',
  'bg-module': 'raise',
  'bg-well': 'inset',
  'line': 'line',
  'line-soft': 'lineSoft',
  'fg': 'ink',
  'fg-dim': 'inkDim',
  'fg-faint': 'inkFaint',
  'accent': 'sky',
  'accent-dim': 'skyDim',
  'wait': 'amber',
  'danger': 'red',
  'info': 'info',
};

/**
 * 字体栈。
 *
 * - `mono`：**随包发的 Cascadia Mono**（SIL OFL 1.1，可再分发）。数字、标识、
 *   命令、时间戳、以及全部拉丁标签都走它——那是这套视觉的骨架。
 * - `sans`：中文正文落回宿主同源的系统字（雅黑/等线），保证中文不会因为
 *   没有随包字体而变成衬线体。
 * - 不做 CJK 随包字体：一份可用子集也要 2–5 MB，而本机字体的中文在这套
 *   「暗底 + 紧凑字距」里已经够用。要换风格时改这一处即可。
 */
const FONTS = {
  mono: '"Pentest Cascadia Mono","Cascadia Mono","Cascadia Code",Consolas,"DejaVu Sans Mono",ui-monospace,monospace',
  sans: '"Segoe UI Variable Text","Segoe UI","Microsoft YaHei UI","Microsoft YaHei","DengXian",system-ui,sans-serif',
} as const;

/** 字号阶（px 数值，样式里直接写数字以免多一层计算）。 */
export const TYPE_SCALE = {
  label: 10.5,
  body: 12.5,
  title: 13,
  section: 15,
  readout: 20,
  hero: 30,
} as const;

/** 间距阶（8px 网格的半档）。 */
export const SPACE = {
  xs: 4,
  sm: 6,
  md: 10,
  lg: 14,
  xl: 20,
} as const;

/** 动效时长与缓动。 */
const MOTION = {
  fast: 120,
  base: 220,
  slow: 420,
  ease: 'cubic-bezier(.2,.7,.2,1)',
} as const;

/** 圆角：仪器感——几乎全是直角，只在胶囊与弧线上用圆。 */
const RADII = {
  sharp: 2,
  pill: 999,
} as const;

/**
 * 组装令牌块。
 *
 * 选择器是一份**根元素清单**：插件的每个渲染入口都必须在这里出现，否则那块界面
 * 拿不到令牌（`var()` 未定义不会报错，只会静默变成空值——这是本仓库踩过的坑）。
 * 新增落点时同步这里，`test/client-surfaces.test.ts` 会核对清单与已知槽位一致。
 */
export const TOKEN_ROOT_SELECTOR = [
  '.pentest-console',
  '.pentest-mainpanel',
  '.pentest-statusbar',
  '.pentest-intake',
  '.pentest-chat-card',
  '.pentest-trace',
].join(',');

/** 令牌块的文本形式（供样式表拼装）。 */
export function tokenCss(): string {
  const lines: string[] = [];
  for (const [key, value] of Object.entries(PALETTE)) lines.push(`--pt-${camelToKebab(key)}:${value};`);
  for (const [alias, key] of Object.entries(SEMANTIC)) {
    // 别名的短横线形式与调色板键相同时（`line` / `line-soft`）**跳过**：
    // 否则会写出 `--pt-line:var(--pt-line)` 这种自引用，而 `var()` 自引用是
    // invalid-at-computed-value-time——整条声明作废（边框、表格线、页签下划线
    // 会集体消失，且没有任何报错）。实测踩过。
    if (`--pt-${alias}` === `--pt-${camelToKebab(key)}`) continue;
    lines.push(`--pt-${alias}:var(--pt-${camelToKebab(key)});`);
  }
  lines.push(`--pt-font-mono:${FONTS.mono};`);
  lines.push(`--pt-font-sans:${FONTS.sans};`);
  lines.push(`--pt-radius-sharp:${RADII.sharp}px;`);
  lines.push(`--pt-radius-pill:${RADII.pill}px;`);
  // 辉光：只在活动元素上用，值是颜色 + 模糊半径。
  lines.push('--pt-glow-accent:0 0 0 1px rgba(95,189,255,.30),0 0 18px rgba(95,189,255,.17);');
  lines.push('--pt-glow-wait:0 0 0 1px rgba(255,180,84,.30),0 0 18px rgba(255,180,84,.14);');
  lines.push('--pt-glow-danger:0 0 0 1px rgba(255,107,107,.32),0 0 18px rgba(255,107,107,.14);');
  // 扫描线：3px 周期的极低对比横纹（静息态也保持，是这套视觉的"纸张"）。
  lines.push('--pt-scanlines:repeating-linear-gradient(180deg,rgba(255,255,255,.028) 0 1px,transparent 1px 3px);');
  // 半透明层：**所有** rgba/字面颜色只能出现在本模块，组件规则一律引用这些令牌。
  lines.push('--pt-select:rgba(95,189,255,.26);');
  lines.push('--pt-veil:rgba(0,0,0,.42);');
  lines.push('--pt-grid:linear-gradient(90deg,rgba(95,189,255,.045) 1px,transparent 1px),linear-gradient(180deg,rgba(95,189,255,.045) 1px,transparent 1px);');
  lines.push('--pt-well-shadow:inset 0 1px 0 rgba(0,0,0,.5);');
  lines.push('--pt-hairline:rgba(216,232,245,.06);');
  lines.push('--pt-hover:rgba(95,189,255,.07);');
  lines.push('--pt-press:rgba(95,189,255,.13);');
  lines.push('--pt-glow-text:0 0 10px rgba(95,189,255,.35);');
  lines.push('--pt-glow-line:0 0 10px rgba(95,189,255,.30);');
  lines.push('--pt-vignette:radial-gradient(120% 90% at 50% 0%,rgba(95,189,255,.055),transparent 62%);');
  // 状态描边：脉冲动画在这些半透明描边与实色辉光之间来回，避免动画里写字面颜色。
  lines.push('--pt-accent-line:rgba(95,189,255,.45);');
  lines.push('--pt-wait-line:rgba(255,180,84,.42);');
  lines.push('--pt-danger-line:rgba(255,107,107,.42);');
  lines.push('--pt-accent-wash:rgba(95,189,255,.08);');
  lines.push('--pt-wait-wash:rgba(255,180,84,.10);');
  lines.push('--pt-danger-wash:rgba(255,107,107,.10);');
  lines.push('--pt-info-wash:rgba(159,176,255,.09);');
  lines.push(`--pt-ease:${MOTION.ease};`);
  lines.push(`--pt-dur-fast:${MOTION.fast}ms;`);
  lines.push(`--pt-dur-base:${MOTION.base}ms;`);
  lines.push(`--pt-dur-slow:${MOTION.slow}ms;`);
  return `${TOKEN_ROOT_SELECTOR}{${lines.join('')}}`;
}

/** `phosDim` → `phos-dim`。 */
function camelToKebab(value: string): string {
  return value.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);
}

/** 全部 `--pt-*` 令牌名（测试用它对账「引用了但没定义」）。 */
export function definedTokens(): readonly string[] {
  const names = new Set<string>();
  for (const key of Object.keys(PALETTE)) names.add(`--pt-${camelToKebab(key)}`);
  for (const alias of Object.keys(SEMANTIC)) names.add(`--pt-${alias}`);
  names.add('--pt-font-mono');
  names.add('--pt-font-sans');
  names.add('--pt-radius-sharp');
  names.add('--pt-radius-pill');
  names.add('--pt-glow-accent');
  names.add('--pt-glow-wait');
  names.add('--pt-glow-danger');
  names.add('--pt-scanlines');
  names.add('--pt-select');
  names.add('--pt-veil');
  names.add('--pt-grid');
  names.add('--pt-well-shadow');
  names.add('--pt-hairline');
  names.add('--pt-hover');
  names.add('--pt-press');
  names.add('--pt-glow-text');
  names.add('--pt-glow-line');
  names.add('--pt-vignette');
  names.add('--pt-accent-line');
  names.add('--pt-wait-line');
  names.add('--pt-danger-line');
  names.add('--pt-accent-wash');
  names.add('--pt-wait-wash');
  names.add('--pt-danger-wash');
  names.add('--pt-info-wash');
  names.add('--pt-ease');
  names.add('--pt-dur-fast');
  names.add('--pt-dur-base');
  names.add('--pt-dur-slow');
  return [...names];
}

/** 相对亮度（WCAG 2.1）。 */
function relativeLuminance(hex: string): number {
  const value = hex.replace('#', '');
  const channels = [0, 2, 4].map((offset) => Number.parseInt(value.slice(offset, offset + 2), 16) / 255);
  const [r, g, b] = channels.map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** 两色的对比度（1–21）。 */
export function contrastRatio(a: string, b: string): number {
  const [hi, lo] = [relativeLuminance(a), relativeLuminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}
