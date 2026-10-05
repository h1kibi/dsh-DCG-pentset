/**
 * 把 `assets/fonts/` 下的字体转成可内联的 TS 模块。
 *
 * ── 为什么需要它 ──
 *
 * 客户端插件只交付一个 `lib/client.js`（宿主按 `rev` 缓存、按模块图加载），
 * **没有静态文件路由**。字体要进浏览器就只有一条路：内联。
 *
 * 直接手写一个 500KB 的 base64 TS 文件不可维护（改字体、换子集都要人肉重编），
 * 所以由本脚本从真实字体文件生成，生成物随源码提交：
 *
 *     node scripts/embed-font.mjs            # 生成/更新 src/client/fontAssets.ts
 *
 * `npm run build:client` 之前会自动跑一次（见 package.json 的 prebuild:client），
 * 因此「换了 assets/fonts 里的文件但忘了重新生成」不会发生。
 *
 * ── 为什么不做子集化 ──
 *
 * 子集化需要 fontTools/brotli，本机没有且离线装不了；而 Cascadia Mono 全量
 * 只有 363 KB（base64 后 ~490 KB），对本地加载的插件不值当引入构建依赖。
 * 有一天要加 CJK 子集，就在本脚本里加一步。
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE = join(ROOT, 'assets', 'fonts', 'CascadiaMono.ttf');
const TARGET = join(ROOT, 'src', 'client', 'fontAssets.ts');

/** 内联用的族名。**不要**用真实名（"Cascadia Mono"）：那样宿主或用户已装的字体
 * 会优先命中，而我们要的是「这份随包字节」，否则不同机器渲染不一致。 */
const FAMILY = 'Pentest Cascadia Mono';

if (!existsSync(SOURCE)) {
  console.error(`找不到字体文件：${SOURCE}`);
  process.exit(1);
}

const bytes = readFileSync(SOURCE);
const base64 = bytes.toString('base64');

const module = `/**
 * 由 \`scripts/embed-font.mjs\` 生成，请勿手改。
 *
 * 源：assets/fonts/CascadiaMono.ttf（${bytes.length} 字节）
 * 许可：SIL Open Font License 1.1（可随包分发；版权归 Microsoft Corporation）
 */

/** 内联族名。 */
export const FONT_FAMILY = ${JSON.stringify(FAMILY)};

/** 字体的 data URI（\`@font-face\` 的 src）。 */
export const FONT_SRC = 'data:font/ttf;base64,${base64}';

/** 源文件字节数，供测试与诊断断言「内联的确实是这一份」。 */
export const FONT_BYTES = ${bytes.length};
`;

writeFileSync(TARGET, module, 'utf8');
console.log(`已生成 ${TARGET}：${bytes.length} 字节字体 → ${module.length} 字节模块`);
