/**
 * 沙箱环境简报：**每次创建 Worker 会话都会注入**的一段提示词。
 *
 * ── 它解决什么问题 ──
 *
 * 模型对本插件的沙箱有三种典型误解，每一种都会让整轮任务跑偏，而且从对话里看不出来：
 *
 *   1. **以为有个"服务器"**：以为命令之间状态会保留（装了个工具、写了文件下次还在）。
 *      实际每个动作都是**一次性容器**（`--rm`），上一秒的 `/tmp` 下一秒就没了。
 *   2. **以为能力随心**：不知道装了什么、不知道限额（超时就以为"目标不可达"，
 *      输出被截断就以为"命令没跑"）。
 *   3. **不知道两条通道的区别**：明明有不需要逐条人批的结构化动作（`pentest_recon` /
 *      `pentest_scan`），却去手写 `nmap`/`curl` 命令 —— 后者属逐次放行类别，
 *      人类要在放行卡上一条条读，侦察吞吐直接被人审预算拖死。
 *
 * 因此这份简报按「**它是什么 → 限额 → 两条通道 → 有什么工具（分组 + 用法）→ 字典与模板 →
 * 退出码 → 边界**」的顺序写：先给世界模型，再给操作细节。
 *
 * ── 与别处的同源关系 ──
 *
 * 工具、字典、模板路径来自 `contracts.ts` 的声明（`test/sandbox-environment.test.ts` 会回到
 * `docker/tools/Dockerfile` 逐条核对出处）；限额来自 `execution/docker-sandbox.ts` 的常量——
 * 提示词里的限额必须与真正生效的那份一致，否则就是让模型按错误前提规划命令。
 */

import {
  SANDBOX_TEMPLATE_DIR,
  SANDBOX_TOOL_GROUPS,
  SANDBOX_WORDLISTS,
} from '../contracts.ts';
import type { SessionKind } from '../contracts.ts';
import { SANDBOX_TMPFS_SIZE, DEFAULT_SANDBOX_LIMITS, HOST_OUTPUT_BUFFER_LIMIT_BYTES } from '../execution/docker-sandbox.ts';
import { RECON_TECHNIQUES, VULN_TECHNIQUES } from '../execution/techniques.ts';

/** 字节数转成人读的形式（提示词里出现 262144 这种数字没有意义）。 */
function humanBytes(bytes: number): string {
  if (bytes % (1024 * 1024) === 0) return `${String(bytes / (1024 * 1024))}MiB`;
  if (bytes % 1024 === 0) return `${String(bytes / 1024)}KiB`;
  return `${String(bytes)} 字节`;
}

/** 模板自己的输出上限（`docker/tools/pentest-tool` 与 templates.ts 一致）：写在这里只作提示，不参与判定。 */
const TYPICAL_OUTPUT_CAP = 256 * 1024;

export function renderSandboxBrief(sessionKind: SessionKind): string {
  if (sessionKind === 'intake') {
    return [
      '【沙箱环境】intake 阶段**不得执行目标动作**：没有目标工具、没有动作模板、不申请放行。',
      '你的产出是待人类确认的范围方案（`pentest_request_scope_confirmation`）与状态便签。',
    ].join('\n');
  }
  const reconTechniques = Object.keys(RECON_TECHNIQUES).join('、');
  const vulnTechniques = Object.keys(VULN_TECHNIQUES).join('、');
  const toolGroups = SANDBOX_TOOL_GROUPS.map(
    (group) => `  - ${group.group}：${group.tools.map((t) => t.name).join(' ')}\n    用法：${group.usage}`,
  );
  const wordlists = SANDBOX_WORDLISTS.map((w) => `/usr/share/wordlists/${w.file}（${w.purpose}）`);
  const wallClockMinutes = Math.round(DEFAULT_SANDBOX_LIMITS.maxWallClockMs / 60000);

  return [
    '【沙箱环境】（每次会话都会注入；动手前先读完这一节，它决定你的命令怎么写）',
    '',
    '**它是什么**：每条命令都在一个**一次性容器**里跑（`--rm`），跑完即销毁。',
    '- 没有跨命令的持久状态：容器里装的东西、写的文件、起的进程，下一条命令都看不见；',
    '- 没有入站端口、没有常驻监听（不能等目标回连，也不能开一个"下次再用"的会话）；',
    '- 容器内是 root、有 `NET_RAW`（`nmap -sS` 可用）、根文件系统可写、`/tmp` 是 tmpfs。',
    '- 命令由 `bash -c` 执行（**是 bash 不是 dash**）：`$RANDOM`、`<(...)`、`[[ ]]`、数组都能用。',
    '- 出入网**直连不经代理**；本部署**可出网，但出网是间歇的**（同一批请求两次结果可能相反）——',
    '  依赖公网的步骤要有离线退路，别把「能连上」当前提；连不上时把失败形态原样记进证据，不要重试到超预算。',
    '因此需要留存的东西**当场落进记忆**（status_note / 报告 / 证据），不要指望留在容器里。',
    '',
    '**限额**（按这个规划命令，超限即失败或截断）：',
    `- 墙钟：单条命令最长 ${String(wallClockMinutes)} 分钟；结构化动作另有更小的默认（端口扫描 5 分钟、nuclei/爬取 3 分钟、探针类 1 分钟）`,
    `- 资源：CPU ${DEFAULT_SANDBOX_LIMITS.cpus} 核 / 内存 ${DEFAULT_SANDBOX_LIMITS.memory} / 进程数 ${String(DEFAULT_SANDBOX_LIMITS.pidsLimit)}`,
    `- 临时空间：\`/tmp\` 上限 ${SANDBOX_TMPFS_SIZE}（大字典与中间结果要留意）`,
    `- 输出：单条命令 stdout 上限约 ${humanBytes(TYPICAL_OUTPUT_CAP)}（宿主侧另有 ${humanBytes(HOST_OUTPUT_BUFFER_LIMIT_BYTES)} 缓冲上限，超了尾部被丢弃）`,
    '- 单条命令正文 ≤ 8192 字符（`pentest_exec`）；速率按行为预设限速（stealth 1 请求/秒、standard 5、deep 10）',
    '**长输出先落盘再筛**：`<命令> > /tmp/out.json 2>/tmp/err` 然后用 `jq`/`grep`/`head` 取字段——直接把上万行倒进输出等于自截断。',
    '',
    '**两条命令通道（按这个顺序选）**：',
    `1. **结构化动作（首选，不消耗人类审批）**：\`pentest_recon\`（technique：${reconTechniques}）、` +
      `\`pentest_scan\`（technique：${vulnTechniques}）。`,
    '   服务端固定命令形态、参数只有枚举与整数、只打**已裁决地址**，因此审计与幂等可复现，也不需要逐条批。',
    '   它们覆盖不到的选项才考虑第 2 条。',
    '2. **自由命令 `pentest_exec`（逐条人类放行）**：`command` 写命令原文（人类在放行卡上读到的就是它）、`port` 填主要端口、`purpose` 写清目的。',
    '   凡是能触及目标的命令，人审模式下**每一条都要人类点一次**——所以能用第 1 条就别用这条。',
    '',
    '**镜像里装了什么**（按用途分组；`which <name>` 可自查）：',
    ...toolGroups,
    '',
    `**字典**（\`/usr/share/wordlists/\`）：${wordlists.join('；')}`,
    `**nuclei 模板**：${SANDBOX_TEMPLATE_DIR}（镜像自带的自建只读模板）。**不要从网上下载模板库**——上游模板集含入侵性用例，与「核验不可破坏」的纪律冲突；`,
    '  用法：`nuclei -u <目标> -t /opt/pentest-templates -disable-update-check -jsonl`。',
    '',
    '**退出码与失败语义**：`0` = 命令跑完并拿到结果（目标返回 4xx/5xx 也是结果）；`1` = 工具级失败（连不上/解析失败）；',
    '`2` = 用法错误（读输出里的 `usage_error`，它会列出允许的取值）；`124` = 超时（拆小规模重跑，不要原样重试）。',
    '',
    '**哪些事不要在这台沙箱里硬跑（主动提出交给人类）**：',
    '- 吃 GPU、吃内存、吃时间的离线破解与大规模爆破/喷洒（`hashcat` 这类、10^6 量级的字典、全端口全脚本扫描）、',
    '  镜像内编译构建、需要图形界面或长时间驻留的任务——这些在宿主机或专用机器上做，快得多，也不占沙箱的 15 分钟/2g 预算。',
    '- 做法：把「要跑什么、在哪跑、期望产出什么」写清楚交给人，**不要用降级参数硬凑一个结果**——降级跑出来的结论不可复核。',
    '- 需要常驻进程/持续交互的能力同样不在本沙箱内（C2、等待目标回连、网络投毒）：容器是一次性的，没有常驻、没有入站端口。',
    '  这类需求属于「交人类在沙箱外做」，不是「换个参数再试一次」。',
    '',
    '**边界（不可协商）**：可达 ≠ 授权——只对已授权目标动作；不尝试持久化/留后门/改目标配置；',
    '不做爆破与喷洒（单账号 ≤5 次、间隔 ≥1s，且要人类逐条放行）；不把数据批量外传；范围外地址一律不打。',
  ].join('\n');
}
