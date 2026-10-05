---
name: business-impact
description: 给资产与候选路径标业务影响与优先级，产出「先验哪条」的可辩护排序
whenToUse: 威胁建模阶段收尾；需要在进入漏洞分析前决定投入顺序时
metadata:
  version: 0.1.0
  phase: threat-modeling
  sources: [PTES 威胁建模, OWASP Risk Rating, MITRE ATT&CK T0040]
  smoked: "沙箱实测@a197af1d36f6：python 四维评分：[3,2,2,1] ok；缺依据条目 → 0 分并标「缺依据」"
---

# 业务影响与优先级（business-impact）

## 适用场景
- 资产图已成型，需要回答「哪些目标值得先测」「这条路径真出事会怎样」。
- 产出是**排序与理由**，不是分数崇拜：每一个打分都要能指出依据来源。

## 前提与边界
- 本阶段不做目标动作；依据来自人类材料、记忆与已收集证据三处。
- **业务信息通常不在技术证据里**：资产属于哪条业务线、停机代价、合规约束，多来自人类的公共规则或直接询问。拿不到就标 `[INFERENCE]` 并写清推断依据，**不要**用「一般来说很关键」这类不可判定的措辞。
- 打分不是精确科学：给的是**相对次序**。同样的假设下，两个人应该得到同一个排序。

## 步骤

### 1. 收集业务标签（拿不到就显式留白）
```bash
jq -r '.nodes[] | [.id, (.business // "unknown"), (.owner // "unknown")] | @tsv' /tmp/graph.json | head -20
```
**期望**：每个资产一行，业务线/负责人可 `unknown`。
**判据**：`unknown` 占比超过一半时，**先补一轮**（问人类或用 `memory_search` 找业务背景），再打分——否则排序是在给自己编故事。

### 2. 四维打分（每维 1–3，必须写依据）
```bash
python3 - <<'PY'
import json
nodes = json.load(open('/tmp/graph.json'))['nodes']
def score(n):
    # 1=低 2=中 3=高。依据字段为空即视为无法打分（0），不要臆造。
    d = n.get('impact', {})
    dims = ['data_sensitivity', 'availability', 'compliance', 'pivot_value']
    vals = [d.get(k, 0) for k in dims]
    return sum(vals), vals, all(d.get(k + '_basis') for k in dims)
for n in sorted(nodes, key=lambda x: -score(x)[0]):
    total, vals, complete = score(n)
    print(f"{n['id']}\t{total}\t{vals}\t{'ok' if complete else '缺依据'}")
PY
```
**期望**：`id 总分 四维取值 依据是否完整`。
**判据**：**依据不完整的行不得进入排序**（先补依据或标 `[INFERENCE]` 并注明依据）。四维定义：`data_sensitivity` 数据敏感度、`availability` 停机代价、`compliance` 合规约束、`pivot_value` 横向可达价值。

### 3. 与可行性交叉，产出「先验哪条」
```bash
jq -r '.edges[] | select(.crosses_boundary==true) | [.to, (.impact_total // 0), (.feasibility // 0)] | @tsv' /tmp/graph.json \
  | python3 -c "import sys
rows=[l.split('\t') for l in sys.stdin if l.strip()]
for r in sorted(rows, key=lambda r: -(int(r[1])*int(r[2]))): print('\t'.join(r))"
```
**期望**：按 `影响 × 可行性` 降序的边界清单。
**判据**：排序结果里，**影响高但可行性 0（没有任何可执行动作）的目标排在最后**，并附一句「为何不可达」——不可达的高价值目标是有用的缺口，不是噪声。

### 4. 写「若被攻陷会怎样」（一句话，可被反驳）
```bash
jq -r '.edges[] | select(.crosses_boundary==true) | "\(.to): 若失守 → \(.impact_statement // "未写")"' /tmp/graph.json
```
**期望**：每条跨边界目标一句影响陈述。
**判据**：陈述必须包含**具体后果 + 依据来源**（如「可读到 A 系统的只读凭据（来源：情报阶段证据 E-12）」）。写不出具体后果 → 退回第 2 步补依据，不许写「可能导致严重后果」。

### 5. 产出排序与理由
```bash
jq -n --slurpfile g /tmp/graph.json '{order: ($g[0].edges | map(select(.crosses_boundary==true)) | sort_by(-(.impact_total*.feasibility)) | map({to, impact_total, feasibility, basis: .impact_basis}))}' > /tmp/priority.json
jq '.order[:5]' /tmp/priority.json
```
**期望**：前 5 个优先目标的 `to / 影响 / 可行性 / 依据`。
**判据**：每条都带 `basis`；无依据的条目会被打回。这份文件是交给人决定「先测哪条」的输入，不是决定本身。

## 判读与去噪
- **技术严重 ≠ 业务重要**：一个 RCE 打在内网一次性构建机上，可能不如一个读接口泄露客户名单。
- 有人给的业务标签要**原样引用并注明来源**（人类材料 / 公共规则 / 对话），别转述成自己的判断。
- 分数相同不要强行拆开：并列就并列，把理由写清，让人来定。

## 常见失败
| 现象 | 真实原因 | 处置 |
|---|---|---|
| 每条影响都是 3 | 依据缺失时倾向给高分 | 依据不全的一律不给分（0 分），先补依据 |
| 排序与直觉相反 | 可行性权重压过了影响 | 检查 `feasibility` 是否有依据；没有依据的可行性按 0 处理 |
| 人类问「凭什么排第一」答不上 | 只有分数没有依据引用 | 回到第 2 步补 `*_basis` 字段 |
| 业务标签与资产对不上 | 资产归一不彻底 | 先做 `asset-graph` 的归一，再回到本步骤 |

## 不做的事
- 不替人类拍板优先级：产出的是排序 + 理由，决定权在人。
- 不把 `[INFERENCE]` 写成事实；不用不可判定的形容词给影响打分。
- 不为凑满四维编造依据。

## 产出（交给下一步）
- `/tmp/priority.json`：排序 + 每条的影响/可行性/依据。
- 业务标签覆盖率与其缺口（哪些资产仍 `unknown`）。
- 给漏洞分析阶段的建议先验清单（按排序，附不可达目标与其原因）。

## 参考
- PTES：Threat Modeling（业务影响与优先级）。
- OWASP Risk Rating Methodology（影响×可能性）。
- MITRE ATT&CK T0040 相关战术上下文（影响评估为何要落到资产）。
