# 规范化这一轮的质检（2026-10-11，对提交 `0e97fda`）

**对象**：刚落地的"沙箱工具规范化"（《规范 v1》七条 + 三面施工 + 68 例新锁）。
**方法**：三路只读质检（容器侧 / 宿主侧 / 提示词与锁）+ 我自己对高价值结论的**独立复现**
（不接受未复现的结论）。⚠ 三路质检方都因平台积分耗尽**中途失败**——它们已产出的结论凡被我复现的
都写在本报告里，未被复现的**明确标注**。

## 一、确认"确实做到了"的部分（可复现）

| 声明 | 我的复现 | 结论 |
|---|---|---|
| AST 静态锁能在旧代码上咬住两条阻断缺陷 | 取 `0e97fda^` 的旧分发器跑同两条检查：`未定义名 = ['ICMP_ECHO_REPLY','ICMP_ECHO_REQUEST']`、`链式比较 = [(2981, ['Is','NotIn'])]`；现版两者皆空 | ✅ 真实（不是自证） |
| 四条阻断缺陷已修 | 质检方实证：`icmp_ping` 真能跑出回复；`restrict_to_scop=true` ⇒ rc=2；`include_chunks=yes` ⇒ rc=2 | ✅（我复核了 ③④ 的代码路径） |
| 每个动词都有 `state=` 首行 | 我按"动词 → 是否直达 `report.finish(` 或经共享助手"扫：20 个动词 19 直达，`service_probe` 经 `nmap_ports`；无遗漏 | ✅ |
| `deadline_for`/`remaining_s` 不是只定义不用 | 7/13 处调用点在长动词里 | ✅ |
| 镜像钉死值与工作副本同源 | 镜像内 `/usr/local/bin/pentest-tool` 与工作副本 `sha256` 逐字相同；两处 digest 一致；25 份技能戳 27 处已轮换 | ✅ |

## 二、查出并已修的缺陷（6 条）

| # | 缺陷 | 发现者 | 证据 | 修法 |
|---|---|---|---|---|
| 1 | **退出码兜底漏了**：`mapOutcome` 只显式处理 0/1/2/3，而 `4/125/126/127/137/255`（docker 自身失败、命令不可执行、命令不存在、**被 SIGKILL**）全部落进 `completed` ⇒ "docker 根本没跑起来"在账本里长成"成功执行" | 我（真值表） | 直接调 `mapOutcome` 打表：`code=137 → completed`（修复前） | `code !== 0` 兜底 ⇒ `runtime_error` + `tool_failed`（`code===0` 是唯一成功）；真值表进测试（10 个取值） |
| 2 | **§7 命名只落实了三个视图**：`pentest_workdir`（`containerPath`/`readOnly`/`filesScanned`/`modifiedAt`）、`skill_load`（`contentHash`）、`pentest_exec/recon/scan` 的 `plan`/`result`、`bootstrap_intake`/`submit_report`/`request_approval`/`request_scope_confirmation` 全是**直通内部 camelCase** | 质检方（`skill_load`）+ 我（全量清点） | 逐个 `toJson(...)` 调用点清点；`skill_load` 的 `contentHash` 由质检方实证 | `result-view.ts` 扩到 **15 个视图**（含 `plan`/`tool_run_result`/`report`/`approval`/`scope_proposal`/`intake`/`skill`/workdir 四个）；命名锁从 3 个视图扩到全部（含"旧键不得出现"的正向断言） |
| 3 | **`presets/pentest/agent.cordis.yml` 里还写着 `deep`**（不存在的档位名，且整段进模型提示词） | 质检方 | 文件第 55 行 | 改 `fast`；**并且**把档位名锁的扫描范围从 `skills/**` 扩到 `presets/**`、形态从"`<名> N/s`"扩到"档位清单 `a / b / c`" |
| 4 | **档位名锁其实锁不住**（我扩了范围后仍绿）：清单**跨行**，而正则要求一行内 ≥3 个名字 | 我（注入回归） | 把 `deep` 放回 presets ⇒ 锁**仍绿** | 量词改 `{1,}`；再次注入 ⇒ 红并给出 `presets\pentest\agent.cordis.yml:55 —— 档位清单 deep / custom 里有不存在的档位 deep`；还原后绿 |
| 5 | **`firstDiagnosticLine` 会把 Python 栈帧当消息**：内部 bug 时 `tool_failed` 的 message 是 `File "/opt/pentest-tool", line 3976, in <module>` | 质检方 | 质检方用真容器构造 | 过滤 `Traceback`/`File "`/缩进帧行；纯栈时不回帧，退回异常行（实测：`KeyError: 1`） |
| 6 | **`content_discover` 的 `summary:` 用裸字段名**（`attempted=`/`truncated=`），与同动词的 `coverage:` 行和规范 §3 的固定后缀不一致；另：规范写 `*_attempted` 而 `ct_lookup`/`dns_axfr` 实际用 `*_listed` | 容器侧质检方 + 我复核 | 源码约 2751/2758 行；真容器输出 | 容器侧改成 `entries_*`/`requests_*` 两轴命名（新镜像 `d6de07ed3f5c`，两处重钉 + 戳轮换）；规范 §3 增补 `*_listed` 与"预算耗尽"语义（`partial`+`*_truncated`+rc0 vs `aborted`+rc1） |
| 7 | **RUNBOOK 手抄的数字是错的**：`recon_port_scan` 写 300s（真值 900s） | 质检方 | `RUNBOOK.md:1042` | 改为"以 `templates.ts` 的 `timeoutMs` 为准"，并注明手抄必错（规范 §7） |
| 8 | 我自己上一轮新加的 `pentest_workdir` 字段（`modifiedAt`）就是新的 camelCase 违规 | 我 | 清点 | 见 #2（并入统一映射） |

## 三、被锁住的新盲区（本轮补的锁 + 失败-先证据）

| 盲区 | 锁 | 失败-先证据 |
|---|---|---|
| 档位名只扫 skills、只认一种形态 | `test/prompt-facts.test.ts` 的范围/形态扩展 | 注入 `deep` ⇒ 红（见 #4） |
| 命名锁只覆盖 3 个视图 | `test/sandbox-spec-locks.test.ts` 扩到 15 个视图 + "旧键不得出现" | 视图未接时 `worker.ts` 直通断言会红 |
| 没有"动词必须能到收尾"的源码锁 | 容器侧 `test/pentest-tool-static.test.ts` 新增（收尾可达性） | 质检方把 `nmap_ports` 的 4 处 `finish` 换成 `line` ⇒ 报 `verbs_without_finish: ['service_probe']` |
| `summary:` 行可能出现裸统计字段 | 容器侧新增（裸名正则） | 拿 `0e97fda` 版本跑 ⇒ 2 条裸名；现版 0 条 |
| 退出码兜底 | 我（真值表 10 个取值） | 修复前 `code=137 → completed` |

## 四、残留（未修，写明理由与期限）

1. **`entries_scanned=` 是待删别名**（与 `entries_attempted=` 同值）：它在改名前就存在且被一条源码锁
   钉着。引用计数已降到 0（测试与提示词都改用新名），**下轮镜像变更时删除**——已写进规范 §7。
2. **提示词预算这一轮涨了**：实测（我）情报阶段首轮 ≈ **65,082 B**（简报 36,868 + 参数指南 22,413 +
   阶段档案 ~5,801）；质检方按另一口径测得 **60,956 → 88,764 B（+45.6%）**。两个口径都指向同一件事：
   这一轮为了"把合法取值/字段名/失败语义写清楚"**加了大量文本**。**批次 3（瘦身）现在是最高优先的
   后续项**：重复陈述（`verify_tls` 曾 5 处、通道纪律 8 处）+ 细节下沉到按需拉取的 skill。
3. **未独立复核的项**（质检方中途失败）：§1 的"每个动词都走统一助手"没有被第三方逐动词核对
   （容器侧的 `TOOL_PARAMS` 锁覆盖了"声明 vs 读取"，但我没手工抽 5 个动词）；`web_crawl` 在预算耗尽
   时用 `partial` 而非 `aborted` 被质检方标为可疑，我判定可接受（可分辨性已由 `pages_truncated` 满足），
   已写进规范——**但这条判定没有第二双眼睛**。
4. **我自己文档里的数字错过一次**：`docs/quality-review-sandbox-tools-2026-10-11.md` 初版写"43 个动词"
   （粗 grep 的产物），真值 **20**（`TOOLS` 全量）⇒ 已在两处更正并注明。**这条本身是教训**：
   连"数数"这种事实也要从唯一来源取（`TOOLS`），不要用正则猜。

## 五、结论

- 规范化的**方向与主体是对的**：四条阻断缺陷确实修掉了、锁确实能在旧代码上咬住、镜像/戳/命名三处
  单一来源确实对得上。
- **但"规范落地"不等于"规范覆盖"**：本轮最大的教训是 §7（命名）与 §8（锁的覆盖率）——
  规范写下来之后，要么有锁覆盖，要么就会在同一轮里立刻出现新违规（#2 的 `skill_load`/`workdir` 就是）。
- 下一轮优先级：**提示词瘦身（批次 3）** > 剩余 §1 逐动词核对 > 别名清理。
