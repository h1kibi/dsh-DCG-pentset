/**
 * `.tsx` 加载器：让 `node --test` 能直接跑引用 React 组件的测试。
 *
 * ── 为什么需要它 ──
 *
 * 两个原因，都是实测踩出来的：
 *
 * **(a) `.tsx` 不被原生支持**：Node 的 `--experimental-strip-types` 只处理 `.ts`。
 * 实测导入 `.tsx` 会抛：
 *
 * ```
 * TypeError [ERR_UNKNOWN_FILE_EXTENSION]: Unknown file extension ".tsx"
 * ```
 *
 * `--experimental-transform-types` 同样不行（它解决的是 TS 的**类型语法**降级，
 * 不是 JSX 转译）。而视图组件必须是 `.tsx`——JSX 没有 `.ts` 写法。
 *
 * **(b) `.ts` 里的装饰器不被原生支持**：`--experimental-strip-types` 按设计只剥离
 * 类型，**不做转译**，所以 TC39 装饰器（`@Remote`）会让模块在导入期抛
 * `SyntaxError: Invalid or unexpected token`。
 *
 * 因此需要一个加载钩子：用 TypeScript 自带的 `transpileModule` 把 `.ts`/`.tsx`
 * 转成普通 JS。**不引入额外依赖**——`typescript` 本来就在 devDependencies 里，
 * 用它自己的编译器保证转译与 `npx tsc` 的判定一致。
 *
 * 文件名保留 `tsx-loader.mjs`：它现在也管 `.ts`，但改名会牵动 `package.json` 与
 * 全部测试命令，收益不抵破坏面。
 *
 * ── 用法 ──
 *
 * ```bash
 * node --import ./test/helpers/tsx-loader.mjs --test test/**\/*.test.ts
 * ```
 *
 * `package.json` 的 `test` 脚本已经带上它，因此常规运行不需要手动加参数。
 *
 * ── 实现说明 ──
 *
 * 用 `module.registerHooks`（Node 22.15+ 的**同步**钩子）而不是 `register`：
 * 同步钩子在本线程内执行，不需要单独的 loader 线程，因此：
 *   - 启动更快（没有额外的 worker 与消息往返）；
 *   - 调试时堆栈连续（loader 线程会让错误堆栈断开）；
 *   - 不需要 `.mjs` 与 `.js` 两套文件区分 loader 与被加载代码。
 *
 * `registerHooks` 的 `load` 钩子接收与返回 `format`/`source`，比旧的
 * `resolve`+`getSource` 组合更直接。
 */

import { registerHooks } from 'node:module';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

/**
 * 交给 TypeScript 编译器转译的扩展名。
 *
 * **`.ts` 也在内**（曾经只有 `.tsx`）。原因：Node 的 `--experimental-strip-types`
 * **按设计只剥离类型、不做任何转译**，因此它无法处理 TC39 装饰器——实测报
 * `SyntaxError: Invalid or unexpected token` 指向那一行 `@Remote`。
 *
 * 控制台端点的 Typert 门面必须用装饰器（`@Remote` 是网关发现方法的唯一标记），
 * 于是 `.ts` 一旦含装饰器，直接用 Node 原生剥离就会在**导入期**崩掉整个测试文件。
 *
 * 让 `.ts` 也走 `ts.transpileModule` 之后，运行期语义与 `npx tsc` 的产物**同源**，
 * 「类型检查通过但运行期语法不支持」这类分歧随之消失。
 */
const TRANSPILE_EXTENSIONS = ['.ts', '.tsx'];

/**
 * 转译缓存。
 *
 * 按「绝对路径 + 内容」缓存：测试文件在一次进程里可能被多个测试文件导入
 * （例如多个测试都引用同一个视图），重复转译纯属浪费。用内容做键的一部分，
 * 这样即使在同一次运行里文件被改写（watch 模式）也不会拿到旧结果。
 */
const cache = new Map();

function cacheKey(path, source) {
  return `${path}\u0000${String(source.length)}\u0000${source.slice(0, 64)}`;
}

// ── 测试库守卫（事故驱动，2026-10-05）──
//
// 事故：「全量套件」在一次运行里 52 秒就报了 96 个失败。根因不是代码，而是**测试库指向错了**——
// `npm test` 继承了 shell 里的 `PENTEST_DATABASE_URL`，那是**个人库**（pentest_personal）。
// RUNBOOK §4 早就写了「测试库是 pentest、不是 pentest_personal……拿个人库跑测试是在拿战果冒险」，
// 但纪律靠人记就一定会破；更糟的是那次的失败看起来像代码坏了，会白查半天。
//
// 因此把纪律变成闸门：只要这次进程是测试运行（argv 带 --test*），并且数据库名不是 `pentest`，
// 就直接拒绝启动，并说清怎么改。非测试用途（如 scripts/seed-skills.ts 指向个人库）不受影响。
{
  // 判据要覆盖两种情况：主进程（argv 带 --test*）与**测试 worker 进程**
  // （argv 里没有 --test，但 Node 会设 NODE_TEST_CONTEXT）。只测 argv 会漏掉后者，
  // 而恰恰是 worker 才真正连库——第一次加这个守卫时就是这么漏过去的。
  const testRun =
    process.argv.some((arg) => arg === '--test' || arg.startsWith('--test-')) ||
    (process.env.NODE_TEST_CONTEXT ?? '') !== '';
  if (testRun) {
    const dsn = process.env.PENTEST_DATABASE_URL ?? '';
    const dbName = (() => {
      if (dsn === '') return null;
      try {
        return decodeURIComponent(new URL(dsn).pathname.replace(/^\//, '')) || null;
      } catch {
        return null;
      }
    })();
    if (dbName === null) {
      throw new Error(
        '测试运行缺少可解析的 PENTEST_DATABASE_URL（应指向测试库 pentest）。' +
          '例如：PENTEST_DATABASE_URL=postgresql://postgres:<pw>@127.0.0.1:55446/pentest npm test',
      );
    }
    if (dbName !== 'pentest') {
      throw new Error(
        `测试运行被拒绝：PENTEST_DATABASE_URL 指向的是数据库 "${dbName}"，而不是测试库 "pentest"。` +
          '测试套件会按 engagement 清理数据——指向个人库会吃掉真实战果，而且失败看起来像代码坏了。' +
          '请显式传测试库：PENTEST_DATABASE_URL=postgresql://postgres:<pw>@127.0.0.1:55446/pentest npm test',
      );
    }
  }
}

registerHooks({
  /**
   * 解析钩子：把 `.js` 后缀的导入映射回 `.tsx`/`.ts`。
   *
   * 为什么需要：TypeScript 的 `allowImportingTsExtensions` 让我们在源码里写
   * `from './Foo.tsx'`，但**部分工具链**（以及历史代码）可能写 `'./Foo.js'`。
   * 这里做一层容错映射，让两种写法都能解析到实际存在的文件。
   */
  resolve(specifier, context, nextResolve) {
    try {
      return nextResolve(specifier, context);
    } catch (error) {
      // 只对「相对/绝对路径 + .js/.jsx 后缀」做回退，裸包名不动
      if (!specifier.startsWith('.') && !specifier.startsWith('/')) throw error;
      for (const ext of ['.tsx', '.ts']) {
        const candidate = specifier.replace(/\.(js|jsx|mjs|cjs)$/, ext);
        if (candidate === specifier) continue;
        try {
          return nextResolve(candidate, context);
        } catch {
          // 继续试下一个扩展名
        }
      }
      throw error;
    }
  },

  /**
   * 加载钩子：把 `.tsx` 转译为 ESM。
   *
   * 用 `jsx: ReactJSX`（而非 `React`）与 tsconfig 的 `"jsx": "react-jsx"` 一致——
   * 前者自动从 `react/jsx-runtime` 引入工厂，源码里不需要 `import React`。
   * 两者不一致会编译通过而运行时 `React is not defined`。
   */
  load(url, context, nextLoad) {
    const path = url.startsWith('file:') ? fileURLToPath(url) : null;
    if (path === null || !TRANSPILE_EXTENSIONS.some((ext) => path.endsWith(ext))) {
      return nextLoad(url, context);
    }

    const source = readFileSync(path, 'utf8');
    const key = cacheKey(path, source);
    const cached = cache.get(key);
    if (cached !== undefined) {
      return { format: 'module', source: cached, shortCircuit: true };
    }

    const result = ts.transpileModule(source, {
      compilerOptions: {
        // 目标与 `tsconfig.json` 对齐；`--experimental-strip-types` 下 Node 也是
        // 按 ES2023 运行，两侧一致才不会出现「类型检查通过但运行时语法不支持」。
        target: ts.ScriptTarget.ES2023,
        module: ts.ModuleKind.ESNext,
        moduleResolution: ts.ModuleResolutionKind.Bundler,
        jsx: ts.JsxEmit.ReactJSX,
        // 只做转译，不做类型检查——类型检查由 `npm run typecheck` 负责，
        // 这里是运行期加速路径（`transpileModule` 的定位就是「快，不查类型」）。
        isolatedModules: true,
        esModuleInterop: true,
        // 保留 `.ts`/`.tsx` 后缀的相对导入（与源码写法一致）
        allowImportingTsExtensions: true,
        verbatimModuleSyntax: true,
        // 不生成 source map：测试失败时的行号来自 Node 的堆栈，转译后行号已经
        // 与源码一一对应（transpileModule 逐行替换，不重排）。
        sourceMap: false,
      },
      fileName: path,
      reportDiagnostics: false,
    });

    cache.set(key, result.outputText);
    return { format: 'module', source: result.outputText, shortCircuit: true };
  },
});
