---
name: asset-graph
description: 把情报阶段的资产/服务/入口整理成带证据的资产图与信任边界，标出孤立节点与覆盖缺口
whenToUse: 威胁建模阶段开头；情报收集已有产出、需要一张「我们知道了什么」的图时
metadata:
  version: 0.1.0
  phase: threat-modeling
  sources: [PTES 威胁建模, OWASP WSTG-INFO, MITRE ATT&CK T1016]
  smoked: "沙箱实测@a197af1d36f6：jq 节点/边管线：MISSING ref 被点名、孤立节点与 GAP 计数"
---

# 资产图与信任边界（asset-graph）

## 适用场景
- 情报收集已提交报告；现在要回答「资产之间怎么连、哪里是信任边界、哪里还是空白」。
- 产出是**给下一阶段用的事实底座**，不是散文：每条边都要能追到证据。

## 前提与边界
- 本阶段默认**不做目标动作**。需要的现场数据在情报阶段就该拿到；缺什么写成「缺口」，不要为了补图临时开扫。
- 本技能全程在 `/tmp` 里的台账上做变换（jq/python3），不接触目标。
- 台账来源：Agent 用 `memory_search` / `memory_read` / `artifact_read` 取到内容后写进 `/tmp`（写文件本身走沙箱命令）。**每条记录必须带 `ref`**（记忆 id 或证据 id）——没有 `ref` 的记录不要进图。

## 步骤

### 1. 归一：把台账读成节点与边
```bash
jq -n --slurpfile a /tmp/assets.json --slurpfile s /tmp/services.json \
  '{nodes: ($a[0] + $s[0]), edges: []}' > /tmp/graph.json
jq -r '.nodes[] | [.id, .kind, (.ref // "MISSING")] | @tsv' /tmp/graph.json | head -20
```
**期望**：每行 `id kind ref`；`kind` ∈ {asset, service, entry}。
**判据**：出现 `MISSING` 的节点先补 `ref` 或删除——**无证据的节点不是资产，是传闻**。

### 2. 连边：只连能被观测支持的
```bash
jq -r '.nodes[] | select(.kind=="entry") | [.id, (.talks_to // [] | join(","))] | @tsv' /tmp/graph.json
```
**期望**：每个入口点指向它实际访问过的服务。
**判据**：一条边成立的条件（满足其一即可，写进边的 `basis`）：① url/host 在证据里同时出现；② 证书 SAN / DNS 记录证明同属；③ 端口与 banner 对应。**都不满足的连线必须标 `[ASSUMPTION]`**，不得混进事实层。

### 3. 标信任边界（跨边界的每一步都要能说清「凭什么信」）
```bash
jq -r '.edges[] | select(.crosses_boundary==true) | [.from, .to, (.auth // "unknown")] | @tsv' /tmp/graph.json
```
**期望**：跨边界边的 `from → to` 与认证状态。
**判据**：`auth` 三态之一——`authenticated`（有会话/凭据证据）、`unauthenticated`（同一请求无需凭据的实测）、`unknown`（没测）。**`unknown` 必须留在图里**：它正是下一步要验证的东西，涂成 `authenticated` 会把风险藏起来。

### 4. 找孤立节点与覆盖缺口
```bash
jq -r --argjson ids "$(jq '[.edges[].from,.edges[].to]|unique' /tmp/graph.json)" \
  '.nodes[] | select(($ids | index(.id)) == null) | .id' /tmp/graph.json
```
**期望**：没有入边也没有出边的节点 id。
**判据**：孤立节点二选一处理——补一条有依据的边，或明确标成「独立资产（未观测到与其他资产的连接）」。**不允许留在灰色状态**：灰色节点在后续阶段会被当成「有连接但没写」。

### 5. 输出图与缺口清单
```bash
jq '{nodes: (.nodes|length), edges: (.edges|length),
     assumptions: ([.edges[]|select(.basis=="ASSUMPTION")]|length),
     gaps: ([.nodes[]|select(.ref=="MISSING")]|length)}' /tmp/graph.json
```
**期望**：四个计数。
**判据**：`gaps > 0` 或 `assumptions > 0` 时，二者必须出现在交给下一阶段的产出里（数字 + 明细），不能只在终端里一闪而过。

## 判读与去噪
- **同一资产的多种写法**（`10.0.0.5` / `app.internal` / `https://app.internal:3002`）要归一到同一个 `id`，否则图会被重复节点撕裂；归一规则写进图文件的 `normalization` 字段，便于复核。
- 情报阶段标成 `unknown` 的东西（服务版本、认证状态）在图里**保持 unknown**：这一层不负责把它猜成事实。
- 边的方向以「谁主动发起」为准，不以数据流方向；反向连接（目标回连）单独记 `kind:"callback"`。

## 常见失败
| 现象 | 真实原因 | 处置 |
|---|---|---|
| 节点数远多于情报报告里的资产数 | 同一资产多种写法 | 先做归一（见上），再统计 |
| 大量 `MISSING` ref | 台账是手抄的、没带 id | 回 `memory_read` 逐条补 `ref`；补不到的删除 |
| 每条边都要标 ASSUMPTION | 情报阶段只记了结论没记证据 | 如实标注并把它列为情报阶段的缺口，不要在这里补造证明 |
| 图看起来"连成一片" | 把「同网段」当成了「有连接」 | 同网段只是可达集合，不是边；边必须有观测依据 |

## 不做的事
- 不做目标动作（不扫描、不请求）；不把「同网段」或「同域名后缀」当连接证据。
- 不把假设涂成事实；不删掉 `unknown`。
- 不为了图好看省略孤立节点与缺口。

## 产出（交给下一步）
- 图文件 `/tmp/graph.json`：`nodes` / `edges`（每条带 `basis`、`auth`、`crosses_boundary`）/ `normalization`。
- 缺口与假设清单：数量 + 明细 + 各自缺什么证据。
- 交给 `model-attack-paths` 的入口点清单（含认证状态）。

## 参考
- PTES：Threat Modeling（资产、边界、信任关系）。
- OWASP WSTG-INFO：信息收集结果的整理方式。
- MITRE ATT&CK：T1016 System Network Configuration Discovery（为什么边界清单要有证据）。
