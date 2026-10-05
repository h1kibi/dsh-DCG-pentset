// ESLint 平面配置（2026-10-05 引入）。
//
// 目的不是风格，而是**只靠人眼看不到的那类缺陷**：浮动 Promise、被吞掉的 catch、
// 显式 any，以及后续可扩展的"未接线安全承诺"扫描（见 scripts/verify-promises.ts）。
// 类型感知规则走 projectService：它复用 tsconfig.json 的 include，
// 因此新增目录不需要在这里同步。
import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: ['lib/**', 'node_modules/**', 'docs/**', 'skills/**', 'assets/**', 'docker/**', 'presets/**', '**/*.py'],
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.ts', '**/*.tsx'],
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    rules: {
      // 这三条是引入 lint 的直接动机：它们各自代表一类"测试全绿但线上坏"的缺陷。
      // `node:test` 的 test/describe/before/after 返回 Promise，但在测试文件顶层
      // 不 await 就是它们的正常用法（Runner 负责调度），因此显式声明为安全调用。
      '@typescript-eslint/no-floating-promises': ['error', {
        allowForKnownSafeCalls: [{
          from: 'package',
          package: 'node:test',
          name: ['test', 'it', 'describe', 'before', 'after', 'beforeEach', 'afterEach'],
        }],
      }],
      '@typescript-eslint/no-misused-promises': 'error',
      '@typescript-eslint/no-explicit-any': 'error',
      // 空 catch 必须显式写出来（哪怕是 .catch(() => undefined) 也不该静默）：
      // 静默残留是这个仓库亲手记录过的反复事故（test/helpers/cleanup.ts 头部）。
      'no-empty': ['error', { allowEmptyCatch: false }],
      // `_` 前缀是仓库里"刻意不用"的约定（如 `_recordOnly`），不按缺陷计。
      '@typescript-eslint/no-unused-vars': ['error', {
        argsIgnorePattern: '^_',
        varsIgnorePattern: '^_',
        caughtErrorsIgnorePattern: '^_',
        ignoreRestSiblings: true,
      }],
    },
  },
  {
    // 脚本用 Node 全局；tsconfig 的 `types: ["node"]` 不覆盖 flat config 的 JS 侧判定。
    files: ['**/*.mjs'],
    languageOptions: {
      globals: {
        console: 'readonly', process: 'readonly', Buffer: 'readonly',
        URL: 'readonly', URLSearchParams: 'readonly',
        TextEncoder: 'readonly', TextDecoder: 'readonly',
        setTimeout: 'readonly', clearTimeout: 'readonly',
        setInterval: 'readonly', clearInterval: 'readonly',
        AbortController: 'readonly', fetch: 'readonly',
      },
    },
  },
  {
    // 这两处**刻意**匹配控制字符：scope.ts 拒绝控制字符输入，session-chat.ts 剥离 ANSI。
    // 关掉规则而不是改正则——正则本身就是要表达"控制字符"。
    files: ['src/policy/scope.ts', 'src/client/session-chat.ts'],
    rules: { 'no-control-regex': 'off' },
  },
);
