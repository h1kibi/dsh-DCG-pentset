# 内置 skill pack

给五个阶段 Agent 各配一套差异化知识装备。**文件是源**，`pentest.skills` 是运行时装载点。

## 结构

```
skills/
  AUTHORING-SPEC.md          撰写规格（格式、章节顺序、沙箱约束、验证方式）
  <skill-name>/SKILL.md      一个 skill 一个目录；名字即 skill 名
```

`SKILL.md` 的 frontmatter（`name` / `description` / `whenToUse` / `metadata.version|phase|sources`）
与 dsh / Claude Code 生态的 skill 约定兼容；正文按固定八节写：适用场景 → 前提与边界 → 步骤（每步含
命令 + 期望 + 判据）→ 判读与去噪 → 常见失败 → 不做的事 → 产出 → 参考。

三条硬纪律：**每条命令都在真沙箱里跑过**（本目录的 skill 在编写时逐条冒烟）、
**判据必须可判定**、**内容原创**（只引用方法论名字，不照抄来源文本）。

## 阶段 → 默认装载

| 阶段 | 默认 skill |
|---|---|
| 情报收集 | `recon-network-surface`、`recon-web-surface`、`recon-dns-cert`、`internal-discovery` |
| 威胁建模 | `model-trust-boundaries`、`model-attack-paths`、`model-attack-trees`、`asset-graph`、`business-impact` |
| 漏洞分析 | `vuln-web-checks`、`vuln-service-checks`、`vuln-intel`、`vuln-triage` |
| 利用验证 | `exploit-minimal-poc`、`exploit-safety`、`exploit-auth-testing`、`exploit-evidence`、`exploit-approval-request` |
| 后渗透 | `post-impact-boundary`、`post-cleanup-verify`、`post-loop-handoff` |

映射写在 `src/skills/skill-pack.ts` 的 `SKILL_PACKS`（单一事实源，默认装载与播种脚本都用它）。

## 为什么设计文档 §2.3 里另一些名字没写

写 skill 的标准是「每条命令都能在**本部署**里真跑」。以下名字在这个部署里写出来只能是空话，故**不写**：

| 未写 | 原因 |
|---|---|
| `osint-passive`、`cloud-surface`、`cloud-vuln`、`source-surface`、`source-vuln` | 沙箱**可出网**（2026-10-05 起，OSINT 类因此可写）；但仍无云 API 凭据、不挂载源码目录——这两类写出来会变成「让 Agent 反复失败的指导」。等部署形态再变（云只读凭据 / 只读源码挂载）再补 |
| `web-validation`、`network-validation`、`post-validation` | 与 `exploit-minimal-poc`（最小复现）、`post-impact-boundary`（影响边界）职责重叠；拆成两份只会让 Agent 在两份里挑，不增加能力 |
| `lateral-movement` | 属于更高风险类别（`lateral_movement` 逐次放行 + 默认禁用类），本作业能力范围明确不做——写技能等于教它越界 |

## 装载与读取（怎么到 Agent 手上）

1. **播种**：`PENTEST_DATABASE_URL=… node --import ./test/helpers/tsx-loader.mjs scripts/seed-skills.ts`
   —— 走 `PgSkillService` 写库（内容哈希、revision、审计同源）。幂等：内容没变就跳过。
2. **目录进提示词**：会话创建时把「已装载 skill」的名字 + 一句话描述写进能力快照分节。
3. **正文按需加载**：Agent 用 `skill_load` 工具取正文；**只有本会话已装载的名字取得到**
   （装载在创建会话时冻结，库里的其它 skill 对它不可见）。
4. **正文不进提示词**：一份 skill 上百行，全量塞进上下文会挤掉任务本身；按需加载是生态的通行做法。

## 质量门槛（`test/skill-pack.test.ts` 强制）

| 检查 | 约束 |
|---|---|
| 名单与文件 | pack 名单 ↔ `SKILL.md` 目录一一对应，目录名 = frontmatter `name` |
| 结构与体量 | 八节齐全且顺序固定；主文件 ≤300 行；LF；`sources` 非空；`phase` 与所在 pack 一致 |
| 步骤质量 | **每一步**都有 ```bash 命令 + `期望` + `判据`（表格类步骤允许无命令） |
| 实质内容 | 「不做的事」≥3 条、「常见失败」≥3 行 |
| 沙箱一致性 | bash 块里不得出现镜像缺失的工具；**速率声明必须等于 `PROFILE_DEFAULTS`**（数字散在多处，最容易走样） |
| **自足性** | 正文不得引用**跨阶段**的 skill 正文，也不得依赖 `references/` 文件 |
| **冒烟证明** | frontmatter 必须有 `metadata.smoked`，形如 `沙箱实测@<镜像摘要前 12 位>：<跑过什么>`，纯文本步骤写 `无需沙箱：<原因>`。**摘要与 `harness.dev.patch.yml` 里当前镜像不一致即红**——镜像换过就必须重跑命令，旧的"验证过"不能一直挂着 |

**为什么不用 `references/` 做渐进披露**：生态里那套（主文件 + `references/`）成立的前提是 harness 能读 skill 目录；
本插件的正文存在库里，Agent 在沙箱里**拿不到那些文件**，写进去就是死引用。这里的渐进披露是
**`skill_load` 本身**：目录（名字 + 一句话描述）进提示词，正文按需拉取，取不到未装载的名字。

## 许可与出处

正文原创，出处只作为参考列出（PTES 阶段、OWASP WSTG 测试项编号、MITRE ATT&CK 战术、
Nmap/OpenSSL/Nuclei 等工具官方文档、HackTricks / PayloadsAllTheThings 的名字）。**没有整段引用。**
