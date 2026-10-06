# dsh-pentest

**人工驾驶的渗透测试多 Agent 插件**（DeepSeek Harness / dsh）。

它不是"自动打点机器人"。这个插件赌的是另一件事：**把授权、范围、放行、证据这四件事变成宿主强制的流程**——
每一步由人决定，Agent 负责把事做扎实、把结论写成别人能复核的东西。

## 定位

| 是 | 不是 |
|---|---|
| 五阶段渗透流程的编排器（情报收集 → 威胁建模 → 漏洞分析 → 利用验证 → 后渗透） | 自动化漏洞利用框架（**不含** Metasploit / 自动武器化） |
| **人类在环**：范围由人确认、危险动作逐条放行 | 无人值守扫描器 |
| 证据与审计留痕（原始件 + 哈希 + 脱敏 + 判定表） | 「打点报告生成器」 |
| 沙箱执行：真工具（nmap / ffuf / sqlmap / impacket / nuclei …）跑在一次性容器里 | 在宿主上直接跑命令 |
| 技能是**在真沙箱里跑过**的作业指导（含命令、期望、判据） | 一篇读起来有道理的方法论散文 |

## 设计思想

1. **阶段即 Agent。** 五个阶段各有一个**顶层会话**（不是 subagent），各有自己的技能包与工具面；
   阶段之间的推进/回环走同一套转移机制，回环把「新发现的内网面」带回下一轮（状态机是循环的，不是流水线）。
2. **能力冻结 + 逐动作放行。** 会话创建时冻结工具白名单与技能集，模型**无法自行扩大**；
   危险动作（`exploit_validation` / `lateral_movement`）**永远逐条人批**，
   `persistence` / `destructive` / `exfiltration` 三类默认关闭。
   只读侦察另走**结构化通道**（`pentest_recon` / `pentest_scan`）——不逐条批，但受范围裁决、租约、节奏与输出上限约束。
3. **沙箱是一次性的。** 沙箱只有 Docker 一条执行路径：镜像按 **digest** 钉死、`--cap-drop ALL` 只给 `NET_RAW`、
   限额（CPU/内存/PID/墙钟/输出）、跑完即销毁。**一条命令一个容器**——这条约束连技能写法都管（见下）。
4. **知识与工具同源。** 工具集、字典、限额只在 `src/contracts.ts` 声明一处，提示词与自检都从它渲染；
   技能里能用哪些命令，由"镜像里真的有什么"决定，而不是由文档声称。
5. **证据要能被别人复核。** 判定必须落到「可判定的判据 + 原始件 + 哈希」；外部情报只作线索并标来源；
   产出是**判定表**（成立 / 不成立 / 未取得 + 原因），不是形容词。拿不到就写「未取得」，不许留空冒充「无」。

## 一组机器门禁（声明 ↔ 现实不许漂）

这个仓库最硬的纪律是：**提示词、技能、镜像三者之间由测试对账**，漂了就红：

| 门禁 | 防的是什么 |
|---|---|
| 工具声明 ↔ `docker/tools/Dockerfile` | 提示词里写了的工具，镜像里其实没有 |
| 提示词 ↔ 工具集/限额 | 声明了但没渲染进会话（模型看不到） |
| 技能冒烟 ↔ 镜像摘要 | 换了镜像，旧背书还挂着「实测过」 |
| 技能 ↔ 缺失工具黑名单 | 教 Agent 跑一条注定 `command not found` 的命令 |
| 技能 ↔ 「容器是一次性的」 | 跨步 `/tmp` 依赖没写合并方式（分开执行必断） |
| 工具 ↔ 教学面 | 装了却没有任何技能或用法说明教它怎么用 |

另外：`npm run verify:tool-image` 会把声明的每一项回镜像里 `command -v` 一遍。

## 目录

```
src/            插件本体（Host 侧）：装配、状态机、闸门、执行服务、记忆、控制台 RPC、客户端 UI
skills/         25 份技能（源文件）+ 撰写规格 AUTHORING-SPEC.md + 索引 README.md
docker/
  Dockerfile    宿主/应用镜像（Kali）
  tools/        沙箱工具镜像：Dockerfile + 分发动词 + 自建 nuclei 只读模板
  ad-dc/        实验室 Samba AD 域控        ┐
  dns-lab/      实验室 DNS 权威服务器（含故意配错的 AXFR） │ 冒烟与演练用靶标，
  lab-api/      实验室 API 靶站（含 BOLA/mass assignment）│ 起法见 RUNBOOK §2.1⑤
docs/           设计文档（权威）、质量复检、架构删除测试记录
RUNBOOK.md      怎么在这台机器上跑起来、怎么排障（运维口径）
start-personal.mjs  个人启动器：预检 → 起 dsh → 打印带 token 的控制台地址
```

## 快速开始

前置：Node `^22.19`、Docker、PostgreSQL + pgvector、模型凭据（`DEEPSEEK_API_KEY`）。
完整步骤与坑见 **[RUNBOOK.md](RUNBOOK.md)**（含沙箱网络/镜像摘要/迁移的强制项）。

```bash
# 1 起沙箱基础设施（本地 registry + 工具镜像 + 迁移见 RUNBOOK §1–§2）
# 2 起控制台
node start-personal.mjs        # 端口绑不上会自动改用系统分配的端口
# 3 进界面：设置 → 插件 → 渗透作业 → 建作业（名称 + 至少一个授权目标）→ 启动 Agent
```

开发：

```bash
npm run build && npm run verify && npm test    # 五道门 + 全量测试（测试库见 RUNBOOK）
npm run verify:tool-image -- <镜像引用>         # 工具声明 ↔ 镜像 的对账
```

## 文档

| 想知道 | 去哪看 |
|---|---|
| 怎么跑、怎么排障、怎么升级镜像 | [RUNBOOK.md](RUNBOOK.md) |
| 为什么这么设计（阶段/闸门/记忆/沙箱/风险） | [docs/dsh-pentest-plugin-design.md](docs/dsh-pentest-plugin-design.md)（权威设计文档） |
| 怎么写一份合格的技能 | [skills/AUTHORING-SPEC.md](skills/AUTHORING-SPEC.md) + [skills/README.md](skills/README.md) |
| 历史质检与删除测试 | [docs/](docs/) |

## 硬边界

- **只对已授权目标动作**：范围由人在控制台确认，选择器把域名解析成地址后钉死；越界即中止并请人修订范围。
- **不做**持久化、留后门、改目标配置、批量外传数据——这三类是默认禁用的动作类别。
- **不自动利用**：利用类动作逐条人批，且要留最小化验证的证据。
- 依赖生态插件（`dsh-permission-rules` / `dsh-defend` / `dsh-mask` / `dsh-observe` / `dsh-budget`）承担硬边界与审计。

## 基线

- 宿主基线：dsh `0.1.5-rc.2`（0.2.0-rc.2 的评估结论与升级步骤见 RUNBOOK §6.5.12：**插件侧已就绪，被生态插件的 peer 上限阻塞，暂不升**）。
- 沙箱工具镜像：`docker/tools/`（工具集清单的权威出处是 `src/contracts.ts` 的 `SANDBOX_TOOL_GROUPS`）。

## 许可

**尚未声明**（默认保留所有权利）。`assets/fonts/CascadiaMono.ttf` 为 SIL OFL 1.1 字体，再分发需随附其许可证文本。
