/**
 * 控制台端点面的一致性锁（2026-10-05 复核 C7 的落点）。
 *
 * ── 为什么需要它 ──
 *
 * `/api/<ns>/<method>` 由 **Typert Gateway** 认领：它遍历服务上带 `@Remote` 标记的方法
 * （`collectSrcClaims()`），并从**函数源码**解析参数名（SRC 模式）。因此「端点存在」这件事
 * 有**两个**独立事实源：
 *
 *   1. `method-names.ts` 的 `CONSOLE_METHOD_NAMES`（通道与方法表共用的一份清单）；
 *   2. `typert-face.ts` 上真实写着的那批 `@Remote` 方法。
 *
 * 两者一旦漂移，表现是**运行时**的：客户端按清单拼 `/api/pentest/<method>`，网关找不到
 * 对应方法就报 404/未认领，而控制台只会显示「端点不可用」——排查要跨客户端、网关与服务三处。
 *
 * ── 为什么是「校验」而不是「生成」 ──
 *
 * 复核要求先验证机制，再决定生成还是校验。**机制允许生成**：每个方法的形状完全相同
 * （`@Remote async <name>(request: ConsoleRequest): Promise<ConsoleResponse>`，
 * 参数名 `request` 是线协议的一部分、必须字面保留）。但该文件同时承载了**只能用文字表达**的
 * 机制约束（必须继承 `TypertRemoteService`、依赖必须用 TS `private` 而不是 `#`、SRC 模式下
 * 签名不得解构/默认值/rest——三条都是实测踩出来的）。生成器会把这些说明挤到脚本里，
 * 而校验脚本能让「增删端点只改一处」变成**门禁**（改一处漏另一处就红），
 * 代价却小得多。因此选择校验，并在此记录「生成可行」这一结论，供将来真正需要时使用。
 */

import { readFileSync } from 'node:fs';

import { CONSOLE_METHOD_NAMES } from '../src/console/method-names.ts';

const FACE_PATH = 'src/console/typert-face.ts';
const faceText = readFileSync(FACE_PATH, 'utf8');

/** 面里真实声明的方法：只认「规范形状」的那一种（形状错了也要报出来）。 */
const CANONICAL = /@Remote\s+async\s+([A-Za-z0-9_]+)\s*\(\s*([A-Za-z0-9_]+)\s*:\s*ConsoleRequest\s*\)\s*:\s*Promise<ConsoleResponse>\s*\{/g;
/** 宽松形状：只取方法名，用来发现「有 @Remote 但签名不合规」的那些。 */
const LOOSE = /@Remote\s+async\s+([A-Za-z0-9_]+)\s*\(([^)]*)\)/g;

const canonicalNames = [...faceText.matchAll(CANONICAL)].map((match) => match[1] ?? '');
const loose = [...faceText.matchAll(LOOSE)].map((match) => ({
  name: match[1] ?? '',
  params: (match[2] ?? '').trim(),
}));
const expected = new Set<string>(CONSOLE_METHOD_NAMES);

const failures: string[] = [];
const warnings: string[] = [];

// 1) 面里每个 @Remote 方法都必须是规范形状（SRC 模式按源码解析参数，形状错了就被网关拒）。
for (const method of loose) {
  const ok = canonicalNames.includes(method.name) && method.params === 'request: ConsoleRequest';
  if (!ok) {
    failures.push(
      `${method.name}：@Remote 方法形状不合规（实测 ${method.params}）——` +
        '必须是 `(request: ConsoleRequest): Promise<ConsoleResponse>`；' +
        'SRC 模式从源码解析参数名，解构/默认值/rest 会被网关以 gateway/signature-invalid 拒绝',
    );
  }
}
// 2) 面里不得有重复方法名（重复声明后者覆盖前者，端点会静默指向最后一个）。
const seen = new Set<string>();
for (const name of canonicalNames) {
  if (seen.has(name)) failures.push(`${name}：在门面里声明了两次`);
  seen.add(name);
}
// 3) 双向覆盖：清单里的每个端点都要有方法；门面里的每个方法都要在清单里。
for (const name of CONSOLE_METHOD_NAMES) {
  if (!seen.has(name)) {
    failures.push(
      `${name}：在 CONSOLE_METHOD_NAMES 里，但 typert-face.ts 没有对应的 @Remote 方法——` +
        '客户端会拼出 /api/pentest/' + name + ' 而网关无人认领（端点表现为「不可用」）',
    );
  }
}
for (const name of seen) {
  if (!expected.has(name)) {
    failures.push(`${name}：门面上有 @Remote 方法，但不在 CONSOLE_METHOD_NAMES 里（表是唯一事实源，补齐或删除）`);
  }
}

// 数量对齐是两处漂移最容易漏掉的形态（一边加一边删，集合看起来都「差不多」）。
if (canonicalNames.length !== CONSOLE_METHOD_NAMES.length) {
  failures.push(
    `数量不一致：门面 ${String(canonicalNames.length)} 个 @Remote 方法，清单 ${String(CONSOLE_METHOD_NAMES.length)} 个端点`,
  );
}

console.log(
  `端点面一致性：门面 ${String(canonicalNames.length)} 个 @Remote 方法 / 清单 ${String(CONSOLE_METHOD_NAMES.length)} 个端点`,
);
for (const warning of warnings) console.log(`warn ${warning}`);
if (failures.length > 0) {
  console.error('端点面与清单不一致：');
  for (const failure of failures) console.error(`  ${failure}`);
  process.exit(1);
}
console.log('端点面一致性检查通过：每个端点都有唯一且形状合规的 @Remote 方法。');
