# 沙箱工具质检与改进方案（2026-10-11）

**范围**：工具镜像里的分发器 `docker/tools/pentest-tool`（**20 个动词** / 本轮规范化后 4027 行）、模板注册表
`src/execution/templates.ts`（16 个模板 / 39 条参数声明）、technique 表 `src/execution/techniques.ts`
（13 条）、沙箱 argv 构造 `src/execution/docker-sandbox.ts`，以及**模型读到的一切使用说明**
（14 个工具的描述与参数说明、结构化动作参数指南、沙箱简报、五份阶段指令、25 份技能）。

**方法**：① 把操作者七轮实测反馈（`RUNBOOK.md` §6.5.9–§6.5.13.7）逐条抽成缺陷行并按类归并；
② 两路只读取证（分发器/工具面、提示词/指导面），每条结论要求"文件:行 或 复现命令 + 原样输出"；
③ 只列能说出"它会怎样害到操作者"的条目，不凑琐碎项。

**本轮新增发现（两路只读取证）**：**16 条**（工具面 10 条含 4 条阻断；提示词面 13 条 P0/P1/P2，
去重后并入 16 条口径）——历史 42 条是本轮发现的**前身**，两者形状一致（见 §四 三条根因）。

**基线数字（实测）**：

| 项 | 数字 |
|---|---|
| 分发器动词 | **20**（`TOOLS` 全量；超时天花板表同样 20 条）——初版写的"43"是用粗 grep 数错的值，2026-10-11 复查更正 |
| 模板 | 16 个 / 39 条参数声明 |
| technique | 13 条 |
| Worker 工具 | 14 个 |
| 技能 | 25 份 |
| 分发器 / 模板 / 参数指南 / 工具层 行数 | 3183 / 1140 / 584 / 1659 |
| 历史反馈里的缺陷行 | **42 条**（七轮，去重前） |

## 一、七轮反馈的缺陷分类（42 条 → 6 类）

### A 类（最大）：**失败与"阴性结果"同形**——12 条

共同形状：命令跑完了、有输出、退出码可能是 0，但**看不出它没说真话**。这类是操作者最贵的：
它会变成报告里的一句错误结论。

| 现象 | 危害 |
|---|---|
| `memory_search` 五次全报 `column "kind" does not exist` | 被当成"没有历史材料" |
| `whois` 对某 IP **完全无输出**（rDNS 也空） | 归属无法确证，却看不出是工具失败还是真无记录 |
| `port_scan` 扫 33 个端口报 `open_ports=0`，而 `3002` 实际开放 | 差点写进"未开放" |
| 空交集与"扫了但全关"同形（`open_ports=0 hosts_up=0`） | 分不清"没扫"与"扫过是 0" |
| `content_discover` 只回 `hits=N autocalibration=…` | 分不清"跑完干净"与"跑一半报一堆错" |
| 大字典"看起来跑完了"（`maxtime`/`position` 只在原始 JSON 里） | 漏报会以"有输出"的形态骗过复核 |
| `grep -oE '…\-…'` 报 `Invalid range end`、**stdout 为空**，管道把 rc 掩成 0 | 看起来像"页面里确实没有路由" |
| `grep -oE '[一-龥]+'` → `Invalid collation character`（rc=2） | 同上，且与"没命中"不可分辨 |
| `curl … \| head -30`（响应体是单行） | 一条都没切，输出被塞满 |
| `verify_tls: false` 被记成 `verify_tls=true` | **静默篡改账本**：账本说"已校验"，事实是没校验 |
| `save_stdout_as_evidence` 静默不落盘 | 安全网失效，原文只剩 tool_run 一条记录 |
| `port_scan` 无原始件可复核（只有解析后的摘要） | 复核者无法回到原始事实 |

**治理方向（已在部分落地，需系统化）**：每个动词的输出必须带**可判定的状态字段**
（`scanned`/`attempted`/`truncated`/`errors`/`stderr_nonempty`/`parsed`），且"没扫"与"扫到 0"
必须不同形；操作者不该需要读原始 JSON 才能发现截断。

### B 类：**同一份事实多处各写一份 → 漂移**——15 条

| 主题 | 漂移形态 |
|---|---|
| `ports="3002"` 被判成 80/443 | 声明（模板模式）与解析器实现不一致 |
| `wordlist=api_endpoints` 被参数校验拒 | 能力已存在但没登记进声明 |
| `skill_load` 拒绝某个 skill 的同时把它列为"已装载" | 两个来源给出矛盾事实 |
| `workdir` 报错三处说法互相打架 | 描述 / message / next_action 各写一份 |
| 提示词用整节介绍 `pentest_vuln_check`，而能力快照里没有 | 提示词与冻结能力不同源 |
| 参数指南缺 `path`（模板已有） | 指南手写、注册表演进后没跟 |
| 超时口径"5 分钟，不是 15 分钟"＋"15 分钟是上限" | 同一件事两句话 |
| 宿主按 15 分钟规划、容器 5 分钟就砍 | **天花板表与模板 timeoutMs 不同源** |
| 情报阶段看不到 `pentest_scan` | 阶段能力面与设计不一致 |
| `restrict_to_scope` 参数表暗示"不给 true 会被拒"，而显式 `ports=` 本来就合法 | 文案与实现 |
| `bytes=4096 declared_length=8596` 并排像"大小对不上=可疑" | 命名误导 |
| `collect=robots` 报 `status: 200` 同时 `robots: missing`（200 是主页面的） | 字段归属不清 |
| `/work` 与 `/mnt/engagement` 在容器 argv / 简报 / 工具读写根 / 证据落盘**四处各解析一遍** | 上次实测："证据文件不存在"（两份产物分居两处） |
| `payload.engagement_id` 说明写"不必填也不被采信"，校验却拒绝 `null` | 说明与校验 |
| `verify_tls` 指引过度泛化（"IP 目标就传 false"） | 措辞把一种情形写成通则 |

**治理方向**：**凡是有单一事实源的，不要再手写第二份**——能从注册表渲染的就渲染
（参数指南、阶段能力面、简报里的挂载/超时/速率），不能渲染的用启动期/测试期对拍锁住
（天花板表 ↔ 模板 `timeoutMs`，目前**没有**这道锁）。

**已核实的量化事实（本轮实测，不是推断）**：

| 核查项 | 结果 |
|---|---|
| 天花板表 ↔ 模板 `timeoutMs` | 逐一相等（16/16 一致，**0 处不一致**）⇒ #18 的"值"已对齐，但**没有锁**：下一次改一边就会漂 |
| `budget_ms(...)` 调用点 ↔ 天花板表键 | 17 个调用点全部命中表键（**无 `KeyError` 风险**） |
| 走共享助手的动词（`port_scan`/`service_probe`/`dns_brute` 等） | 经 `budget_ms(label)`（分发器:1334）取预算 ⇒ 受注入超时治理 |
| 表里有、模板未引用的天花板 | `dns_resolve` / `http_get` / `icmp_ping` / `tcp_connect` / `udp_probe`（5 条：`port_scan` 内部探测步骤用；需确认是否还有别的入口） |
| 分发器动词无独立天花板条目 | 见 §二取证（长动词经共享助手受管） |

### C 类：**能力缺口 → 退回手写命令**——3 条

- 60 条路径复核只能写 `for p in …; do curl …; done`（**已补**：`http_probe paths=`）。
- 大字典只能一段段手搓（**已补**：`entry_range`）。
- `scope=top100` 的 top-N 清单在沙箱里查不到，只能靠记忆列端口（漏了就是静默漏报）。

### D 类：**可调度性不相容**——2 条

`common_dirs` 4723 条按声明节奏 5 req/s 需 ~945s，而单条命令上限 300s ⇒ **数学上不可调度**
（旧实现既不报截断也不给分段手段）。这类缺陷的特征是"不改能力就永远做不到"，必须在参数面
提供分段/续跑，或在声明层面给出可调度组合。

### E 类：**幂等/重试语义**——1 条

`tls_inspect` 之后调 `tls_weakness`（参数相同）被拒 `idempotent_replay`：两个模板的
`commandTemplate` 逐字相同而幂等键不含 `templateId` ⇒ 键相撞、摘要不同（**已修**）。

### F 类：**崩溃/异常形态**——1 条

`exposure_check` 只要命中候选就 `internal_error: TypeError`（**已修**）。这条的教训是
"命中路径从来没被测过"——阴性路径测了，阳性路径没测。

## 二、分发器与工具面质检

取证方式：静态审计（AST 扫描 + 逐个函数体阅读）+ **实跑复现**（在宿主上直接跑 `pentest-tool <verb>`
或调纯函数）。下面每条都标了我**独立复核过**还是"仅审计方证据"。

### 2.1 阻断级（4 条）：会让错误结论进报告，或让能力完全不工作

| # | 位置 | 缺陷 | 证据 | 症状 | 复核 |
|---|---|---|---|---|---|
| 1 | `pentest-tool:729,760` | `icmp_ping` 用的 `ICMP_ECHO_REQUEST`/`ICMP_ECHO_REPLY` **全文件未定义** | AST 扫描：两常量 assigned=False / used=True；实跑 `python docker/tools/pentest-tool "icmp_ping target=127.0.0.1 …"` → 先打印成功形态的两行 `resolved:`/`icmp_socket:`，再 `internal_error: NameError`，rc=1 | 零产出，且与"目标不回 ICMP"**同形** | ✅ 独立复核（grep 全文件：只有两处使用、无定义） |
| 2 | `pentest-tool:2981` | `echoed = "<" not in body is False` 是 Python **链式比较** ⇒ `("<" not in body) and (body is False)`，`body` 是 `str` ⇒ **恒 False** | 四种 body（含真 XST 反射）实跑全为 `echo_risk=false` | 真 XST 与安全目标同形——模型会把可利用 XSS 写成"无反射风险" | ✅ 独立复核（读到 2981 行原文） |
| 3 | `src/execution/docker-sandbox.ts` `mapOutcome` | 分发器 exit **1/2** 未传进账本：任意非 null code 都记 `status:'completed'`（只在 `exitCode` 字段留痕） | 分发器:35-39 声明 0/1/2 约定；全 `src/` grep 无 `code === 1|2|124`；实跑确认分发器侧正确（`bad-enum` rc=2、`unknown-verb` rc=2、`scheme=ftp` rc=2） | **"用错参数"被记成成功执行**，模型照抄错参数再烧一轮；账本层无法分辨失败 | ✅ 独立复核（读到 `status: 'completed', exitCode: outcome.code`） |
| 4 | `pentest-tool:1460`、`1949` | `restrict_to_scope`/`include_chunks` 用 `== "true"` 读，**键名拼错或取值拼错静默退化 false**；且无通用"未知键拒绝" | 实跑 `restrict_to_scop=true`（键名拼错）→ 完整 top-100 SYN 扫描照跑、`scanned=true open_ports=3`、rc=0、无任何忽略提示；`include_chunks=TRUE` → `endpoints_kind_counts: none`、rc=0。对照 `scheme=ftp` → rc=2（说明严格度不一致） | `restrict_to_scope` 是范围交集防线，拼错即**未经收敛地扫整档**；`include_chunks` 是 Next.js/Vite 路由唯一发现路径 | ✅ 独立复核（读到 `(params.get("restrict_to_scope") or "false") == "true"`） |

### 2.2 误导级（6 条）

| # | 位置 | 缺陷 | 症状 |
|---|---|---|---|
| 5 | `run_tool:1246-1252` | 超时分支 `return 124, "", …` **丢弃子进程已产出的 stdout**（`TimeoutExpired.stdout` 实测有 `EARLY_LINE_1`） | ffuf 进度、whois 已拿到的 inetnum、nse 部分输出全消失；模型无法区分"跑了 90% 被砍"与"没发出去" |
| 6 | `Reporter:228-236` ↔ 宿主 `docker-sandbox.ts:779` | 容器**截断常不置位**宿主 `truncated`：宿主判据是 `buf.length <= maxBytes`，而容器按行截断后总字节可能仍小于上限 | 长行（port/hit/record）被砍几万字节后 `truncated=false`，残缺结果被当完整结论 |
| 7 | `dns_enum:3033`、`exposure_check:2489` | 逗号列表参数可传空值：`record_types=,` → `records=0 types=` rc=0；`paths=,` → 只有 control_path 一行 rc=0（`parse_required` 只判空字符串） | **"一个都没查"与"查过确实没有"同形**——报告会写"未发现暴露" |
| 8 | `exposure_check`/`dns_enum`/`dns_brute` | **无总预算 deadline**（逐函数体确认 `monotonic`/`deadline` 不出现；对照 `http_probe`/`content_discover`/`whois` 都有） | 名义 120s/30s/120s，DNS 按 resolver 生命周期累加可数倍超支 → 宿主 SIGKILL；`dns_enum` 只拿到前 2 种记录类型却只被告知 `timed_out` |
| 9 | `ct_lookup`/`web_crawl`/`dns_axfr` | 结果切片**不报被省略**（`[:500]`、`[:100]`、`[:400]`；ct 的 `unique_names` 是已列数而非全量）。对照：endpoint 切片做对了（`endpoints_truncated: true`） | 被动子域/区域传送是唯一发现路径，丢的部分**无任何计数线索** |
| 10 | `test/action-templates.test.ts:573-906` | 既有锁覆盖不到：`maxOutputBytes` 零断言；源码文本匹配只滤注释；**无动词行为锁**；非 enum 的 string pattern 只对拍了一条（`ENTRY_RANGE_RE`，`PROBE_PATH_RE`/`PATH_PREFIX_RE` 没比）；`exitCode → status` 映射零覆盖 | 这是上面 1–9 能长期存活的**直接原因**：锁的是"字符串还在"，不是"行为还对" |

### 2.3 三处声明的对齐状态：**已锁什么 / 未锁什么**

**已锁（实跑逐条复核，18 张表全一致）**：`template.tool ⊆ 分发器 TOOLS`（存在性 + 数值相等）；
technique ↔ template 的参数名集合与 enum 域双向对拍（×16）；档位键集与 `common_services`/`full_tcp`
清单；wordlist 三处一致。**结论：参数面与超时值当前无漂移**——历史 D-11（`port_scan` 300s→900s）确已修好。

**未锁**（也就是下一轮改进的靶子）：

1. **分发器运行时行为本身**——全部阻断级缺陷都在这一层；J 段锁只做字符串匹配 ⇒ "字符串还在、行为已坏"。
2. `maxOutputBytes` 全无断言（模板 2MiB/512KiB/64KiB 与容器默认 256KiB 的关系无人守）。
3. 非 enum 的 string pattern 除一条外无对拍。
4. **孤儿动词**（`http_get`/`tcp_connect`/`udp_probe`/`icmp_ping`/`dns_resolve` 无模板对应）：锁只查"模板⊆动词"方向 ⇒ `icmp_ping` 恒崩无人知。
5. `exitCode → tool_runs.status` 映射零覆盖。
6. `restrict_to_scope`/`include_chunks` 的读取严格度与 `parse_enum` 不一致。

> 审计方还澄清了一处自己的假阳性（第一轮按函数体提取曾误报 `verify_tls`/`resolver`/`paths`
> "声明未读"，实为经 `verify_tls_param`/`dns_resolver_for`/`parse_probe_paths` 助手读取）——
> 这条记下来是因为它说明**"函数体局部 grep"这种取证方式本身会产生假阳性**，报告结论必须回源核。

## 三、提示词与指导面质检

取证方式：对渲染产物**直接测量字节**、对 materialize 后的 schema **反序列化验证**、逐条回源 grep。
覆盖 14 个工具的描述与全部参数说明、简报、参数指南、5 份阶段档案、能力快照、22 份技能。
本节标 ✅ 的条目我独立复核过。

### 3.1 「教了会被拒」的错误事实（P0，共 3 条）

| # | 位置 | 提示词教的 | 代码事实 | 后果 |
|---|---|---|---|---|
| 11 | `phase-profiles.ts:149,198,259,327,394` | memory_search 的 `kinds` 用业务分类：`asset`/`service_fingerprint`/`dns_record`/`web_surface`/`attack_path`/`trust_boundary`/`verification_plan`/`compromised_asset`/`impact_scope`/`exploit_proof`（`:439-448` 渲染成「**会话开始强制检索**」代码块） | `chunks.ts:31-46` 的 `CHUNK_KINDS` 只有 14 个：`human_input/decision/handoff/compaction_summary/report_summary/fact/hypothesis/finding/limitation/tool_observation/http_exchange/binary_evidence/assistant_message/reasoning`；**10 个业务分类里 9 个不存在**（只有 `finding` 真存在） | 模型照档案发起的**第一次**强制检索必被拒（`classification_rejected`）✅ 独立复核 |
| 12 | `phase-profiles.ts:213` 附近、`:339` | `trust_level` 用 `confirmed/likely/speculative`（威胁建模）与 `high/medium/low`（漏洞分析） | `contracts.ts:937-943` 的 `TrustLevel` 是**来源**语义：`human_decision/tool_observation/agent_claim/model_reasoning/external_untrusted`。两套虚构词彼此还矛盾（一套可信度三档、一套严重度三档） | 拒一次；**更坏的是**模型若猜 `agent_claim`（它认得这个词）过滤会"生效"却与"已确认"无关 ⇒ 结果静默为空/偏，note 只说"没命中"，于是它一直换查询词 |
| 13 | `phase-profiles.ts:342`（exploitation 的 usageGuidance） | 「**可跨 engagement 检索**同类漏洞的 PoC 载荷与绕过技巧（去掉 engagement_id）」 | memory_search 的参数里**根本没有 engagement_id**（`worker.ts` 参数面），服务端按会话绑定本作业（§9.4）；**同一文件 `:211`/`:276` 说的正好相反** | 一条"必须照做"的指令做不到，且它教的做法与另两处说明直接冲突 ✅ 独立复核 |

> 第 11/12 条的失败形态还叠加了一层：`#memoryQuery` 用 `throw refuse(...)`（`pg-worker-tools.ts:829-846`），
> 而没有任何适配层把 `PgWorkerToolRefusal` 转成 §16.5 的 `blocked` 载荷；错误对象的 `message` 是
> `${code}: ${message}`（**不含 `next_action`**，而合法取值就在 `next_action` 里）。宿主按 `.message`
> 提取（dsh-tools lib 的说明）⇒ **模型连"合法取值是哪些"都看不到**，只能猜。✅ 代码层复核

### 3.2 「教了会算错」的数字与名称（P1，共 3 条）

| # | 主题 | 提示词里的数字/名称 | 事实 | 后果 |
|---|---|---|---|---|
| 14 | 墙钟上限 | `internal-discovery:22,41,50,94` 全按 **900s** 规划；`sandbox-brief` 说"15 分钟是天花板、自由命令 5 分钟、端口扫描 5 分钟、爬取 3 分钟"；`recon-web-surface:59` 说 **295s** | 沙箱天花板 900s（`docker-sandbox.ts:138`）；**自由命令 300s**（`templates.ts:605`）；`port_scan` 900s；`content_discover` 300s；`http_probe` 120s | `internal-discovery` 按 900s 估规模 ⇒ 实测 2493s 的命令必被杀在 300s（技能自己记的"必被 900s 杀掉"是**错的那一半**）✅ 独立复核 |
| 15 | 速率档位名 | 5 份技能 + `AUTHORING-SPEC.md:55` 写 **`deep 10/s`**（`recon-network-surface:22`、`exploit-minimal-poc:21` 还漏写 standard） | 合法枚举是 `BEHAVIOR_PROFILES = ['stealth','standard','fast','custom']`（`contracts.ts:658`）——**`deep` 不存在** | 模型按不存在的档位规划节奏/写进报告 ⇒ 至少是事实错误 ✅ 独立复核 |
| 16 | 技能里的 technique 名与参数派属 | `recon-dns-cert:46` 把 `dns_brute` 的 `concurrency`/`wildcard_check` 派给 `ct_subdomains`；`:156` 把 dispatcher 动词名 `whois_query` 当作结构化通道的 technique 名写出 | technique 真名是 `whois`（`techniques.ts:100`）；`concurrency`/`wildcard_check` 属 `dns_brute`（`techniques.ts:95-99`） | 模型按技能传参 ⇒ 拒绝或行为不符 ✅ 独立复核 |

### 3.3 失败语义与返回结构没写（P1，共 3 条）

- **20 个 `ERROR_CODES` 在全部面向模型的文本里零解释**（`contracts.ts:1081-1139`）。最贵的一条是
  「哪些码该停止重试」——`approval_expired`/`lease_revoked`/`engagement_halted`/`budget_exhausted`
  与 `classification_rejected`（改参数即可）处置完全不同，模型无从区分。
- **6 个工具的返回结构零示例**：入参描述合计 9,609 字节，**出参 0 字节**。例如
  `artifact_read` 的 `inline` 在二进制时是"空串"还是"字段缺失"没说；`pentest_submit_report` 的
  `merged.{baseReportId,sections}`（正是"确认补进去的真的在里头"的机制）一字未提。
- **零命中的两种语义只写在 2/5 个阶段**：`pg-worker-tools.ts:666-681` 区分"索引为空（去 workdir）"
  与"有内容但没命中（换查询词）"，但漏洞分析/利用验证/后渗透三阶段只写"hits 为空 → 未完成/无漏洞"
  ⇒ 而这三阶段恰恰最容易遇到"上游刚交报告、索引器还没跑"。

### 3.4 重复与提示词预算（P2）

实测（对渲染产物直接测量）：工具面 **19,492** B、简报（情报阶段）**26,834** B、参数指南 **11,863** B、
阶段档案 **4,456–4,896** B、模板目录（能力快照全量渲染 carries）**12,652** B ⇒
**情报阶段首轮 ≈ 75.6 KB（≈19k–25k token）**，其中同一纪律的重复陈述约 40%。

重复清单：`verify_tls` 说明 **5 处**（措辞已开始漂移，还把"报告里堆免责声明会稀释结论"这种**写作建议**
混进了契约字段）；`restrict_to_scope` 三条路 **4 处**；通道纪律 **8 处**。
**6 个 technique 在参数指南里根本没有条目**（`nse_safe`/`web_crawl`/`dns_brute`/`whois`/`ct_subdomains`/`dns_axfr`）
⇒ 模型只能从工具参数说明反推默认值。

### 3.5 技能与执行通道的断层（P1）

**6 份利用/后渗透技能里 `pentest_exec`/`pentest_request_action_approval`/`approval_id`/
`save_stdout_as_evidence`/`artifact_ref`/`source_refs` 命中数全为 0**——它们按"直接跑"写 ```bash```
配方，而"怎么把命令交给系统"（一次一条待批、凭证只对那一次执行有效、证据要开 `save_stdout_as_evidence`）
只写在工具描述里。技能是被 `skill_load` 主动拉进上下文的，与工具描述平级 ⇒ 模型读到的是一份详尽配方，
没有配套的三条约束，**每次都要白等一轮**。

## 四、改进方案

### 4.0 三条根因（42 条历史缺陷 + 16 条本轮发现，收敛到这三条）

1. **验证只覆盖"声明"，不覆盖"行为"**。既有锁对拍的是模板/technique/动词的三处**字符串**；
   分发器**运行时行为**没有任何锁 ⇒ `icmp_ping` 恒崩、`echo_risk` 恒假可以长期存活。
   同类：`maxOutputBytes` 零断言、`exitCode → status` 零覆盖、孤儿动词（`http_get`/`tcp_connect`/
   `udp_probe`/`icmp_ping`/`dns_resolve` 无模板对应）无人发现。
2. **同一份事实多处手写**。天花板表 ↔ 模板超时（本轮实测 16/16 一致，**但无锁**）；提示词里的
   `kinds`/`trust_level`/墙钟数字/速率档位/`verify_tls` 说明；四个挂载视图（上一轮已收成一份）。
   手写份数 > 1 的地方，迟早漂移，且漂移方向不可预测。
3. **失败形态不可分辨**。分发器 exit 1/2 → 账本记 `completed`；长行截断不置位 `truncated`；
   空列表参数 → `0 结果 + rc 0`；`oneOf` 把细分违规塌成一条。**默认结果是"看起来正常"**。

### 4.1 批次 0：阻断项（不做这些，其余改进都建在流沙上）

| 项 | 改动 | 成本 |
|---|---|---|
| 0-1 `icmp_ping` 常量未定义 | 补两个常量 + 一条"used ⇒ defined"静态断言 | 镜像重建 |
| 0-2 `echo_risk` 链式比较恒假 | 改 `"<" in body` + 一条 AST 断言（禁 `x is False` 与比较运算符混用） | 镜像重建 |
| 0-3 exit 1/2 记成 `completed` | `mapOutcome`：`code===2 → blocked(usage_error)`、`code===1 → error(tool_failed)`；补 `exitCode → status` 锁 | 只需重建 lib |
| 0-4 拼错键名/取值静默退化 | `restrict_to_scope`/`include_chunks` 改用与 `verify_tls` 同形态的严格读取；`parse_command` 加**未知键拒绝** | 镜像重建 |
| 0-5 超时丢已产出 stdout | `run_tool` 用 `exc.stdout/exc.stderr` | 镜像重建 |
| 0-6 截断不置位 | 容器侧用**独立信号**（`[已截断：` 前缀或 exit 3）承载截断，宿主按它置 `truncated` | 镜像重建（或宿主侧先兜） |
| 0-7 空列表参数 → 0 结果 | `dns_enum`/`exposure_check` 照 `nse_run` 的做法显式 raise | 镜像重建 |
| 0-8 切片不报省略 | `ct_lookup`/`web_crawl`/`dns_axfr` 补 `<x>_truncated`（照 endpoint 那段的做法） | 镜像重建 |
| 0-9 三动词无 deadline | `dns_enum`/`dns_brute`/`exposure_check` 加总预算 + `aborted_items=N` | 镜像重建 |
| 0-10 提示词教错词表 | `phase-profiles.ts` 的 `kinds`/`trust_level` 换成真实枚举，并**列出合法值**；删掉"可跨 engagement 检索"那句（` :342`） | 只需重建 lib |
| 0-11 墙钟数字/档位名 | 统一成"沙箱 900s / 自由命令 300s / 各模板见能力快照"，技能里的 `deep` → `fast`，`900s 估规模` → 300s | 只需重建 lib |
| 0-12 技能里的 technique 名与参数派属 | `recon-dns-cert` 的 `whois_query` → `whois`、`concurrency`/`wildcard_check` 归 `dns_brute` | 只需重建 lib |

**建议：0-1…0-9 一次镜像重建做完（一次轮换），0-10…0-12 同步改（同一批 lib 构建）。**

### 4.2 批次 1：把"行为"变成可测的（防复发地基）

1. **静态断言**（无容器即可跑，正是能抓住 0-1/0-2 的那条）：AST 扫描分发器，断言
   `used-but-not-defined` 名字为空、无 `is False`/`is True` 链式比较、每个公开函数有返回值。
2. **每个动词的 argv 冒烟**：`pentest-tool <verb>` 无参数 → 断言 rc=2 + usage 非空；
   有纯函数解析的动词（`parse_probe_paths`/`parse_entry_range`/`parse_enum`…）逐个对拍边界。
3. **`exitCode → tool_runs.status` 映射锁**（0-3 的锁）。
4. **`maxOutputBytes` 对拍**：模板声明 vs 容器默认，双向断言。
5. **孤儿动词锁**：`TOOLS` 与模板集合做**双向**差集断言（现在只有单向）。
6. **非 enum 的 string pattern 逐字对拍**（`PROBE_PATH_RE`/`PATH_PREFIX_RE`…）。

### 4.3 批次 2：结构治本（消掉"多处各写一份"）

1. **提示词由注册表渲染**：参数指南、墙钟数字、速率档位、能力快照的 carries —— 从
   `templates.ts`/`techniques.ts`/`contracts.ts` 生成，删掉手写副本。
2. **每个动词统一 `state:` 行**（`ok`/`failed`/`no_target`/`truncated`/`aborted`），宿主按它置
   `tool_runs.status` —— 消灭"看起来正常的失败"这类缺陷的**共同载体**（而不是逐个动词想字段名）。
3. **拒绝信息带合法取值到模型**：工具层统一 catch `PgWorkerToolRefusal`，把 `payload`
   （`blocked` + `next_action` + `expected_values`）原样渲染 —— 现在最有用的那半截被扔掉了。
4. **返回结构示例由 schema 生成**：出参 0 字节 → 每个工具给字段清单（或示例），
   特别是 `merged`/`artifact_ref`/`evidence_failed`/`partial_output` 这些新机制。

### 4.4 批次 3：提示词预算瘦身（75KB → 目标 ≤45KB）

去重（`verify_tls` 5→1、三条路 4→1、通道纪律 8→1）；6 个 technique 补参数表；
把"写作建议"从契约字段里挪走（`verify_tls` 那句"堆免责声明会稀释结论"）；细节下沉到按需拉取的 skill。

### 4.5 明确不建议做的

- **不为了参数边界去扩 dsh 的 schema DSL**（宿主不支持 `minimum`/`maximum`，实测编译期抛错）。
  9 个整数参数的边界改为**工具层显式校验 + 返回 `blocked` 载荷**（带 `expected_values`）。
- **不把"未知参数键"做成静默忽略**（那正是历史漂移的来源）；统一**拒绝**并列出接受的键。

## 四之补：本轮落地状态（2026-10-11 当天）

把本报告的方案**按规范施工**，新增了准绳文件 `docs/sandbox-tool-spec.md`（《沙箱工具规范 v1》，七条）。
分工与状态：

| 面 | 内容 | 状态 |
|---|---|---|
| 规范 | 《沙箱工具规范 v1》：参数读取 / 输出状态 / 覆盖度 / 退出码 / 超时中止 / 拒绝载荷 / 命名与单一来源 / 可验证性 | ✅ 落地（`docs/sandbox-tool-spec.md`） |
| 宿主侧（我） | §4 退出码四档映射（新增错误码 `usage_error`/`tool_failed`；exit 3 = 截断）+ 锁；§6 工具层**统一 catch** 把服务层拒绝转成 `blocked` 载荷（含 `expected_values`，`kinds`/`trust_levels` 已带合法取值）；§7 模型可见字段 snake_case（`index_watermark`/`artifact_id`/`media_type`/`storage_ref`/`tool_run_id`，成具名视图类型 + 锁）；工具描述纠正（`verify_tls` 说明收成一份、补「拒绝怎么读」、`artifact_read`/`memory_search` 写出参字段） | ✅ |
| 提示词侧（子代理） | P0 三条教错的词表/事实（kinds/trust_levels 换真实枚举并列出合法值、删「跨 engagement 检索」）+ 数字与名称（墙钟统一、`deep`→`fast`、`recon-dns-cert` 的 technique 名与参数派属）+ 新规范字段的读法 + 零命中分流补齐 + 6 个缺失 technique 条目 | ✅（含新锁 `test/prompt-facts.test.ts`：数字/词表/档位名一律与注册表同值） |
| 容器侧（子代理） | §1 统一参数助手 + 未知键拒绝；§2 `state=` 首行与四态；§3 覆盖度四字段；修 4 条阻断 + 6 条误导；§8 静态断言与每动词 argv 冒烟 | ⏳ 进行中（含镜像轮换） |

**与报告 §四 的关系**：批次 0（阻断）+ 批次 1（可测性）已按上表落地；批次 2（结构治本）里
"提示词由注册表渲染"由提示词侧完成（并配真值锁），"统一 `state:` 行 + 宿主按它置 status"由容器侧
与宿主侧分头完成，"拒绝载荷带合法取值"由宿主侧完成；批次 3（预算瘦身）留待下一轮（本轮只做了
"数字不写死"这一半）。

## 五、一页结论

**写得好的**：参数与模板的声明面已经相当扎实（三处锁 + 18 张表本轮复核对齐）；证据链、
幂等、范围裁决这些"硬边界"的设计是对的；技能与参数指南的**判据**意识（期望/判据/常见失败表）在同类项目里少见。

**真正的问题不在"不知道怎么写"，而在"没有东西替这些文字与行为兜底"**：声明有锁、行为没锁；
同一事实手写多份；失败默认与成功同形。这三条一起，就得到了操作者七轮反馈里反复出现的形状——
**"看起来正常的失败"**。

**因此顺序很重要**：先做批次 0（4 条阻断 + 3 条教错的提示词），再做批次 1（让行为可测），
否则新补的文档与参数还会以同样的方式烂掉。
