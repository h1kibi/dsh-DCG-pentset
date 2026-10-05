/**
 * 客户端产物的构建配置。
 *
 * 目标：产出宿主模块加载器能吃下的 `lib/client.js`。
 *
 * ── 实测确认的产物格式（dsh 0.1.5-rc.2）──
 *
 * 官方客户端包的 `lib/client.js` 形如：
 *
 * ```js
 * window.__ModuleLoader__.load({
 *   id: "@deepseek-ai/dsh-client-ui-settings",
 *   factory: (require) => {
 *     var module = { exports: {} };
 *     var exports = module.exports;
 *     let _cordis = require("@deepseek-ai/cordis");   // 依赖外部化
 *     ...
 *     return module.exports;
 *   }
 * });
 * ```
 *
 * 三条语义（来自 `dsh-client-modules/lib/types/client/manifest.d.ts` 的说明）：
 *
 *   1. 执行脚本**只注册工厂**；模块体的副作用（含 CSS 注入）都在工厂闭包里，
 *      到 materialization 时才跑。
 *   2. `require` 由模块系统解析：seed → 记忆化记录 → 图上登记的工厂 → 抛错。
 *      因此外部依赖**不能打进 bundle**，必须留给宿主。
 *   3. materialization 在首次 import 时发生并记忆化；循环依赖是致命的
 *      （CJS 工厂无法交付部分 exports）。
 *
 * ── 为什么需要自定义包装 ──
 *
 * tsdown/rollup 没有现成的这个格式。用 `output.format: 'cjs'` 生成模块体，
 * 再用 banner/footer 把它包进 `window.__ModuleLoader__.load({...})`。
 *
 * 这样做的代价是**自己保证包装正确**——所以下面有一段产物自检
 * （`scripts/verify-client-bundle.ts`），不靠肉眼确认。
 */

import { defineConfig } from 'tsdown';

/** 产物 id：必须与包名一致，宿主按它做图行匹配。 */
const MODULE_ID = 'dsh-pentest';

/**
 * 外部依赖：由宿主提供，**不打进 bundle**。
 *
 * 用前缀匹配而不是逐个列举：`@deepseek-ai/*` 是宿主的一整套运行时，
 * 逐个列举会在升级时漏掉新增的包。`react` 也在其列（宿主的 UI 框架）。
 */
const EXTERNAL = [/^@deepseek-ai\//, /^react$/, /^react-dom$/, /^react\//];

export default defineConfig({
  entry: { client: 'src/client/index.ts' },
  outDir: 'lib',
  format: 'cjs',
  platform: 'browser',
  target: 'es2022',
  dts: false,
  /**
   * **不要清理输出目录**。
   *
   * `lib/` 同时是 `tsc`（Host 侧产物 + 复制过来的 SQL 迁移）与 tsdown
   * （客户端单文件）的输出目录——因为 `exports["./client"]` 必须指向 `lib/client.js`，
   * 客户端产物不能放到别处。而 tsdown 默认会清理 outDir，实测**擦掉了 tsc 的
   * 43 个 JS 与 5 个 SQL 迁移**：跑一次客户端构建就把 Host 插件弄坏了。
   *
   * 关掉清理是安全的：两个构建器写的是不同文件（tsc 写 `lib/**\/*.js`，
   * tsdown 只写 `lib/client.js`），互不覆盖。
   */
  clean: false,
  // 依赖外部化：留给宿主的模块加载器解析（见上方语义 2）。
  // 用 `deps.neverBundle`（tsdown 0.23 起 `external` 已弃用并会在构建时告警）。
  deps: { neverBundle: EXTERNAL },
  outputOptions: {
    /**
     * 产物名固定为 `client.js`。
     *
     * tsdown 对 CJS 格式默认输出 `client.cjs`（实测 `fixedExtension: false` 未改变
     * 这一行为），而 `exports["./client"]` 与宿主的图行都按 **`lib/client.js`** 查找
     * ——扩展名不符会让客户端插件**静默不被加载**。显式指定文件名最可靠。
     */
    entryFileNames: 'client.js',
    // 产物只注册工厂，不立即执行模块体（见上方语义 1）
    banner: `window.__ModuleLoader__.load({ id: ${JSON.stringify(MODULE_ID)}, factory: (require) => {`,
    footer: 'return module.exports; } });',
    // CJS 下 rollup 会生成 `exports.xxx = ...`，需要 module/exports 存在
    intro: 'var module = { exports: {} }; var exports = module.exports;',
    // 不生成 `"use strict"` 之外的多余包装，保持与官方产物同形
    esModule: false,
    exports: 'named',
  },
});
