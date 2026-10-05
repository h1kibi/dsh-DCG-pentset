/**
 * 安全承诺的接线检查（2026-10-05 引入）。
 *
 * 复核轮发现的**成类缺陷**：机制被实现、被注释、被设计文档承诺，但没有任何运行时
 * 消费者——「以为有、实际没有」比没有更危险（地址固定、重定向逐跳、执行令牌、
 * 沙箱前第二次策略审计、嵌入版本登记器都是这一类）。
 *
 * 本脚本把每个承诺钉在一处声明上，扫描全仓（src + scripts + test）引用：
 *
 *   - `wired`   ：除声明文件外必须至少有一处引用，否则**失败**；
 *   - `pending` ：已知未接线（有出处、有处置计划），打印告警，不阻塞。
 *
 * 新增承诺时默认按 `wired` 处理；只有明确写进 PENDING 并注明原因才允许未接线。
 */
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

interface PromiseEntry {
  readonly symbol: string;
  readonly file: string;
  readonly status: 'wired' | 'pending';
  readonly note: string;
  /**
   * 只做转发的文件：它们里的调用点不算「消费者」——转发包装的存在恰恰是
   * 「承诺看起来有接线」的成因（REQ-4 的两处就是这样被误判为已接线的）。
   */
  readonly forwarders?: readonly string[];
}

const PROMISES: readonly PromiseEntry[] = [
  {
    symbol: 'assertAdjudicatedAddress',
    file: 'src/policy/scope.ts',
    status: 'pending',
    note: 'REQ-4：连接时刻的地址固定未接线——删除或由代理侧真实接线，二选一',
    forwarders: ['src/policy/pg-policy.ts'],
  },
  {
    symbol: 'evaluateRedirectChain',
    file: 'src/policy/scope.ts',
    status: 'pending',
    note: 'REQ-4：HTTP 重定向逐跳校验未接线',
    forwarders: ['src/policy/pg-policy.ts'],
  },
  {
    symbol: 'EmbeddingRevisionRegistry',
    file: 'src/memory/embedding.ts',
    status: 'wired',
    note: '索引器首次索引时登记（compose 注入），检索侧的活跃版本过滤依赖它',
  },
];

const SCAN_DIRS = ['src', 'scripts', 'test'] as const;
const SKIP_DIRS = new Set(['node_modules', 'lib', '.git']);

async function collectFiles(dir: string, out: string[] = []): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) await collectFiles(path, out);
    else if (/\.(ts|tsx|mjs)$/.test(entry.name)) out.push(path);
  }
  return out;
}

const files = (await Promise.all(SCAN_DIRS.map((dir) => collectFiles(dir)))).flat();
const contents = new Map<string, string>();
for (const file of files) {
  // 归一成 `/`：entries 里的声明/转发路径写的是仓库相对 POSIX 形式，
  // Windows 的 `join` 产出反斜杠，不归一会让排除表静默失配。
  contents.set(file.replaceAll('\\', '/'), await readFile(file, 'utf8'));
}

/** 声明文件与转发文件之外，`src/` 中的**调用点**数量（测试不计入消费者）。 */
function consumersOutside(entry: PromiseEntry): number {
  const ignored = new Set([entry.file, ...(entry.forwarders ?? [])]);
  const callSite = new RegExp(`(?:\\bnew\\s+)?\\b${entry.symbol}\\b\\s*\\(`);
  let count = 0;
  for (const [file, text] of contents) {
    if (!file.startsWith('src') || ignored.has(file)) continue;
    // 逐行判断并跳过注释行：注释里提到符号不算接线。
    for (const line of text.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (trimmed.startsWith('*') || trimmed.startsWith('//')) continue;
      if (callSite.test(line)) count += 1;
    }
  }
  return count;
}

const failures: string[] = [];
const warnings: string[] = [];
for (const entry of PROMISES) {
  const consumers = consumersOutside(entry);
  const label = `${entry.symbol}（${entry.file}）`;
  if (consumers === 0 && entry.status === 'wired') {
    failures.push(`未接线：${label}——${entry.note}`);
  } else if (consumers === 0) {
    warnings.push(`[待处置] ${label}——${entry.note}`);
  } else if (entry.status === 'pending') {
    warnings.push(`[已接线，可从 PENDING 移除] ${label}（${String(consumers)} 处引用）`);
  }
}

for (const warning of warnings) console.log(`warn ${warning}`);
for (const failure of failures) console.log(`FAIL ${failure}`);
if (failures.length > 0) {
  console.log(`\n承诺接线检查未通过：${String(failures.length)} 项未接线。`);
  process.exit(1);
}
console.log(
  `\n承诺接线检查通过：${String(PROMISES.length)} 项（${String(warnings.length)} 项告警，0 项失败）。`,
);
