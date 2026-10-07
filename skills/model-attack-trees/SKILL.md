---
name: model-attack-trees
description: 把优先级路径展开成攻击树：根=目标状态、叶=本作业可执行动作，逐叶标注动作类别与是否需人类逐次放行，产出交给漏洞分析阶段的验证计划
whenToUse: 威胁建模阶段收尾；已有攻击路径优先级表，需要把「测什么、用哪类动作、要不要人放行、何时停」定成可交接的验证计划时
metadata:
  version: 0.1.0
  phase: threat-modeling
  sources: [Schneier 攻击树方法论, PTES 威胁建模, MITRE ATT&CK 战术]
  smoked: "沙箱实测@3c49879dd61b：6 块原文照跑，4 块通过；步骤 1 的输入契约本轮修掉——原配方只造 root，而步骤 3/4/5 读 .leaves[]，在它自己产出的文件上三块全部 Cannot iterate over null (exit=5)，补 leaves:[] 后三块 exit=0（AND/OR 枚举与缺 op 检测本就有效）"
---

# 攻击树与验证计划（model-attack-trees）

## 适用场景
- 威胁建模阶段最后一步：`model-attack-paths` 已产出排序后的候选路径。
- 产出**攻击树 + 叶子表 + 验证计划草案**，交给漏洞分析阶段去落地验证；本技能不执行验证。
- 本阶段默认**零目标动作**：整棵树是计划，不是执行记录。

## 前提与边界
- 根必须是**可判定的目标状态**（能说清「观察到什么算达成」），且来自业务影响或攻击路径，不是「随便找找」。
- 叶子必须是**本作业可执行的动作**：在范围内、动作类别在本次策略内可申请。
- 动作类别取自固定枚举：`passive_collection`、`active_probing`、`credentialed_access`、`exploit_validation`、`lateral_movement`、`persistence`、`destructive`、`exfiltration`。
- 默认需逐次人工放行的类别是 `exploit_validation`、`lateral_movement`；`persistence`/`destructive`/`exfiltration` 默认关闭，只能记为「本作业不可执行」。
- 需要现场核验才能确认某叶子可达时，**至多一次只读**核验（`recon_http_probe`：`http_probe target=… port=… scheme=… follow_redirects=0 collect=headers`；或经人工逐条放行的裸 `curl`，只发 GET/HEAD），并写清为什么非现场不可；其余核验属于漏洞分析 / 利用阶段。

## 步骤

> **容器是一次性的**（`--rm`）：树文件 `/tmp/tm/tree.json` **只在那一条命令内存在**。
> 第 1 步造它、第 3/4/5 步读它——**造与读必须写在同一条命令里**（`jq -n … > /tmp/tm/tree.json && jq … /tmp/tm/tree.json`）；
> 分开写会得到 `No such file or directory`（2026-10-06 实测）。

### 1. 定根（目标状态）
```bash
jq -n --arg g "获得对<资产>的未授权读取" --arg ref "memory:<uuid>" \
  '{root:{goal:$g, evidence_refs:[$ref]}, leaves:[]}' > /tmp/tm/tree.json
```
**期望**：`tree.json` 的 `root.goal` 是一个可判定的目标状态，且带至少一个 `evidence_ref`。
**判据**：根无法表述成「看到 X 即算达成」就不算根；根没有业务影响或攻击路径依据的，先回去补，不展开。

> **顶层 `leaves` 必须存在**（哪怕先是空数组）：第 3/4/5 步都读 `.leaves[]`，缺这个键会让它们全部以
> `Cannot iterate over null` 硬失败——2026-10-06 的逐块验证实测到，且当时正文从没写过这条契约。

### 2. 展开 AND / OR 节点
```bash
jq -r '.. | objects | select(has("children") and has("op")) | [.id, .op, (.children|length)] | @tsv' /tmp/tm/tree.json
jq -r '.. | objects | select(has("children")) | select(.op==null) | (.id//"(root)")' /tmp/tm/tree.json
```
**期望**：第一段是内部节点的算子与子节点数；第二段是未标 `op` 的带子节点节点（根节点本身除外）。
**判据**：内部节点必须标 `op`（`OR` = 任一子节点达成即达成；`AND` = 全部子节点必需）；第二段出现 `(root)` 之外任何 id = 语义歧义，先补再继续。`AND` 节点最容易藏「缺失前置条件」，逐个核对。

### 3. 叶子 → 动作类别 + 逐次放行
```bash
jq -r '.leaves[] | [.id, .action_class, (.per_action_approval|tostring)] | @tsv' /tmp/tm/tree.json
```
**期望**：每片叶子的动作类别与放行标记。
**判据**：
- `action_class` 必须 ∈ 8 类枚举，出现枚举外值一律修正；
- `exploit_validation`、`lateral_movement` 的 `per_action_approval` 必须为 `true`；
- 叶子标了 `persistence`、`destructive`、`exfiltration` 的，笔记为「本作业不可执行」，**不得**进入可执行计划。

### 4. 裁剪：只留本作业可执行的叶子
```bash
jq '[.leaves[] | select((.in_scope|not) or (.action_class=="persistence")
   or (.action_class=="destructive") or (.action_class=="exfiltration"))] | length' /tmp/tm/tree.json
```
**期望**：越界或默认关闭类别的叶子数量。
**判据**：必须为 `0`；非 `0` 的叶子移出计划，并注明「需范围修订」或「需显式开启」——留在可执行计划里就是越权。

### 5. 生成验证计划（交给漏洞分析阶段）
```bash
jq -r '.leaves[] | [.id, .action_class, (.per_action_approval|tostring),
  (.verify//"?"), (.stop_condition//"?"), ((.evidence_refs//[])|join(","))] | @tsv' /tmp/tm/tree.json
```
**期望**：`leaf action_class approval 要验证什么 停止条件 证据引用`。
**判据**：每片叶子必须有可观察的 `verify` 和 `stop_condition`；缺 `stop_condition` 的叶子**不得**进入验证计划 —— 利用类动作没有停止条件就是失控。同时标注该叶子是否已有 `evidence_ref`：无引用的叶子在计划里标为假设，验证时先取证。

## 判读与去噪
- 攻击树是**候选计划**，不承诺可行性：叶子的可行性继承攻击路径的前置条件与假设状态。
- `OR` 节点下的多条叶子若共用前置条件，验证时优先取证成本低的一条，避免重复动作。
- 叶子粒度以「一次可放行的动作」为准：跨度太大的叶子拆开，否则无法逐次放行。
- 逐次放行是**人类闸门**，不是自动化开关；计划里写「由人类逐次放行」，不写「自动执行」。
- 叶子引用公网 POC/EXP 时标假设（可查证来源，但未在目标上复现就不是证据）。

## 常见失败
| 现象 | 真实原因 | 处置 |
|---|---|---|
| 内部节点一堆 `UNSET` | 展开时没定 OR/AND 语义 | 回步骤 2 逐节点补算子，语义不清的树算不出攻击面 |
| 叶子动作类别是自造名 | 没用契约里的 8 类枚举 | 映射回枚举；映射不了说明该叶子不是本作业能做的动作 |
| 裁剪计数不为 0 | 混入了关闭类别或范围外目标 | 移出计划并标注前置条件（范围修订 / 显式开启） |
| 叶子没停止条件 | 只写了「测一下」 | 补可观察的停止条件；补不出的叶子移出验证计划 |

## 不做的事
- 不执行任何叶子：不放行、不扫描、不利用、不横向；整棵树是计划。
- 不把 `persistence`/`destructive`/`exfiltration` 叶子留在可执行计划里。
- 不让 Agent 自行开启高风险类别 —— 放行只能由人类在下游阶段给出。
- 不越范围：范围外目标不建树、不核验。

## 产出（交给下一步）
- **攻击树**：根（目标状态）+ AND/OR 内部节点 + 叶子。
- **叶子表**：`id / action_class / per_action_approval / in_scope`。
- **验证计划草案**：每片叶子的 `verify`、`stop_condition`、所需证据、放行要求。
- **假设清单**：无证据引用的叶子 + 缺失证据。
- 以上交漏洞分析阶段，作为「候选漏洞 → 验证计划」的输入骨架。

## 参考
- Schneier：Attack Trees（根=目标状态，叶=可执行动作）。
- PTES：Threat Modeling 阶段的攻击树与优先级。
- MITRE ATT&CK 战术枚举，用于在叶子上标注行为类别。
