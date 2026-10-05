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
    note:
      'REQ-4：服务层未接线（容器内置工具已按裁决地址固定拨号；缺口在出口代理——它自己解析域名）。'
      + '接线形态：代理按裁决地址拨号，或调用本方法后落审计',
    forwarders: ['src/policy/pg-policy.ts'],
  },
  {
    symbol: 'evaluateRedirectChain',
    file: 'src/policy/scope.ts',
    status: 'pending',
    note: 'REQ-4：未接线（容器 http_get 每跳只做地址固定，缺范围/资产裁决那一层）。接线形态：代理或执行路径每跳调用',
    forwarders: ['src/policy/pg-policy.ts'],
  },
  {
    symbol: 'EmbeddingRevisionRegistry',
    file: 'src/memory/embedding.ts',
    status: 'wired',
    note: '索引器首次索引时登记（compose 注入），检索侧的活跃版本过滤依赖它',
  },
  // ── 2026-10-05 删除测试复核登记的未接线项（附录 E.1 / G）──
  // 这些不是死代码：它们是**已实现、已测试、但没有运行时消费者**的能力。删它们会
  // 连「能力存在过」的唯一证据一起删掉，所以登记为 pending（处置方向写进 note）。
  {
    symbol: 'LivenessMonitor',
    file: 'src/workflow/budget.ts',
    status: 'pending',
    note:
      '§10.5 进度活性（检查点 / 连续工具失败 / 上下文压力）已实现，唯一构造点是 compose.ts 的 createLiveness 导出，'
      + '无任何调用者；设计文档 doc:3750 的 liveness: 配置段在代码中不存在。'
      + '接线形态：由持有会话回合边界的调用方按会话构造并驱动检查点',
    forwarders: ['src/compose.ts'],
  },
  {
    symbol: 'planCompaction',
    file: 'src/memory/compaction.ts',
    status: 'pending',
    note:
      '§8.10 压缩算法（保留集 / 截断 / 压缩区间 / 逐级压缩链）1226 行仅被 test/compaction.test.ts 消费；'
      + '阻塞在宿主侧能力（回合边界 effect 点、模型客户端、SessionPort 的 replace 追加写），'
      + '最小接线路径见设计文档 §8.10.0（doc:2243）——「只写 context.compacted 事件是假接线」',
  },
  {
    symbol: 'enrichContextRefs',
    file: 'src/workflow/handoff.ts',
    status: 'pending',
    note:
      'doc:1670/1683 要求交接视图显示引用的来源与可信度、并允许人工补充引用；'
      + '该纯函数（把 chunk 的 classification/trust_level/provisional 补回引用，匹配不到不猜）零调用，'
      + '级联 ContextChunkMeta 只出现在它的签名里',
  },
  {
    symbol: 'assertGraph',
    file: 'src/workflow/phases.ts',
    status: 'wired',
    note: '启动自检：`applyPentest` 在生态断言后调用一次（第六轮质检前它只被测试调用）；坏表即开即失败，不留给运行期',
  },
  {
    symbol: 'assertLeaseValid',
    file: 'src/workflow/lease.ts',
    status: 'pending',
    note:
      '**文档承诺未接线的安全规则**：doc:3607/4374 要求「跨任务提交被拒」，该检查（taskRef 比对，lease.ts:248）只在这里实现；'
      + '生产三条租约判定路径（execution/admission.ts 的 leaseViolation、execution/pg-store.ts 的 leaseFailure、'
      + 'renewLease 显式传 taskRef=null）都不比对任务绑定。接线前提：先定义「提交所属任务」的来源'
      + '（当前 ExecutionPlan 与审批都不携带任务标识）',
  },
  {
    symbol: 'validateLeaseForOperation',
    file: 'src/workflow/lease.ts',
    status: 'pending',
    note: '同上：提交准入路径未接线（其 taskRef 比对是「跨任务提交被拒」的唯一实现，doc:3607/4374）',
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

/**
 * 去掉注释后的代码文本：块注释整体去掉，行内 `//` 之后截断。
 *
 * 断言说的是「**代码里**有消费者」，注释里提到符号不算——本仓注释大量引用符号名解释
 * 「为什么这里不接线」，把注释算作消费者会把这条棘轮变成噪声（2026-10-05 独立评审实测：
 * 把接线注释掉仍报全绿）。与 `verify-client-bundle.ts` / `verify-style-coverage.mjs`
 * 同一做法。
 */
function codeOnly(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split(/\r?\n/)
    .map((line) => line.replace(/\/\/.*$/, ''))
    .join('\n');
}

/** 声明文件与转发文件之外，`src/` 中的**调用点**数量（测试不计入消费者）。 */
function consumersOutside(entry: PromiseEntry): number {
  const ignored = new Set([entry.file, ...(entry.forwarders ?? [])]);
  const callSite = new RegExp(`(?:\\bnew\\s+)?\\b${entry.symbol}\\b\\s*\\(`);
  let count = 0;
  for (const [file, text] of contents) {
    if (!file.startsWith('src') || ignored.has(file)) continue;
    // **去注释后**再逐行找调用点（2026-10-05 独立评审的 P2）：此前只跳过「整行以 * 或 //
    // 开头」的行，而行尾注释（`null; // new Foo(`）与行内块注释（`/* new Foo( */`）都会命中
    // ——把接线注释掉（而非删除）时棘轮仍然全绿，正是它要防的「以为有、实际没有」。
    for (const line of codeOnly(text).split(/\r?\n/)) {
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
