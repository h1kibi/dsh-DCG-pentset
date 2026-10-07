---
name: model-attack-paths
description: 把信任边界与资产连成入口→资产的攻击路径：前置条件、ATT&CK 战术映射，按影响×可行性排序，证据不足的路径显式标为假设
whenToUse: 威胁建模阶段；已有边界表与入口→资产映射，需要回答「哪些路径可测、先测哪条」时；为攻击树与漏洞分析提供候选路径
metadata:
  version: 0.1.0
  phase: threat-modeling
  sources: [PTES 威胁建模, MITRE ATT&CK Enterprise, OWASP WSTG]
  smoked: "沙箱实测@b9d9011f8331：6 块原文照跑（候选边台账、缺前置条件检出、战术映射、影响×可行性排序（EVID 全在 ASSUMPTION 之前）、冻结假设、缺字段兜底）；impact 越界被 assert 挡下（exit=1）"
---

# 攻击路径与优先级（model-attack-paths）

## 适用场景
- 威胁建模阶段，`model-trust-boundaries` 已产出边界表、入口/出口清单与入口→资产映射。
- 产出是**候选路径 + 前置条件 + 战术标签 + 优先级**，回答「哪些路径值得测、按什么顺序」；验证本身留给漏洞分析。
- 本阶段默认**零目标动作**；路径是纸面推演，不在这里打任何一跳。

## 前提与边界
- 只在授权范围内建模：入口与资产都必须能在边界台账或资产台账里解析到 `ref`；解析不到的节点视为幽灵，删除或标假设。
- 每条路径的每个节点都要么挂 `memory:<uuid>`/`artifact:<uuid>` 引用，要么标 `assumption=true` 并写 `missing_evidence`。
- 战术标签是**分类**，不是证据：它说明这条路径属于哪类行为，不证明它可行。
- 影响取自业务影响模型（资产关键度），可行性取自前置条件的数量与强度 —— 两者都要写清依据，不靠直觉给分。
- 外网可达（2026-10-05 起）：外部漏洞库、公网 POC 查得到，但**外部资料不是本目标的证据**——引用标来源，未在目标上复现的一律标假设。

## 步骤

> **容器是一次性的**（`--rm`）：台账 `/tmp/tm/paths.json` **只在那一条命令内存在**。
> 读它的命令必须与写它的命令**写成同一条**（`… && jq … /tmp/tm/paths.json`）；分开写会得到
> `No such file or directory`（2026-10-06 实测）。

### 1. 建入口 → 资产候选边
把候选路径写成 `/tmp/tm/paths.json`（数组，元素含 `id`、`entry`、`asset`、`technique`、`preconditions`、`tactics`、`impact`、`feasibility`、`evidence_refs`、`missing_evidence`）。
```bash
jq -r '.[] | [.id, .entry, .asset, (.technique//"?"), (.evidence_refs|length)] | @tsv' /tmp/tm/paths.json | sort
```
**期望**：`id entry asset technique 引用数`。
**判据**：`entry` 与 `asset` 必须能解析回台账里的 `ref`；解析不到 = 幽灵节点，先删除或标假设，**不得**让它进入评分。

### 2. 补前置条件
```bash
jq -r '.[] | select((.preconditions|length)==0) | .id' /tmp/tm/paths.json
```
**期望**：缺少前置条件的路径 id。
**判据**：非空即必须补齐 —— 前置条件要写成可核查的（需要某类凭据、需要某网段位置、目标版本已知、存在可写目录、需要已认证会话）。**禁止**写「可能需要」这种不可判定的措辞。

### 3. 映射 ATT&CK 战术
```bash
jq -r '.[] | [.id, ((.tactics//[])|join(","))] | @tsv' /tmp/tm/paths.json
```
**期望**：每条路径的战术 id 列表（可为空）。
**判据**：战术名必须来自固定枚举 —— TA0001 Initial Access、TA0006 Credential Access、TA0007 Discovery、TA0008 Lateral Movement、TA0010 Exfiltration、TA0040 Impact 等；出现枚举外的自造名一律修正。跨多跳的路径标多枚战术，按跳序排列。

### 4. 按「影响 × 可行性」排序
```bash
python3 - <<'PY'
import json
rows = json.load(open('/tmp/tm/paths.json'))
for p in rows:
    assert isinstance(p['impact'], int) and 1 <= p['impact'] <= 5, f"impact out of range: {p['id']}"
    assert isinstance(p['feasibility'], int) and 1 <= p['feasibility'] <= 5, f"feasibility out of range: {p['id']}"
    p['score'] = p['impact'] * p['feasibility']
    p['grounded'] = len(p.get('evidence_refs', [])) > 0 and not p.get('missing_evidence')
rows.sort(key=lambda p: (p['grounded'], p['score']), reverse=True)
for p in rows:
    tag = 'EVID' if p['grounded'] else 'ASSUMPTION'
    print(f"{p['score']:3d} {tag:10s} {p['id']:16s} {p['entry']} -> {p['asset']}  {'|'.join(p.get('tactics', []))}")
PY
```
**期望**：降序表，`EVID` 行排在 `ASSUMPTION` 行之前。
**判据**：`impact`、`feasibility` 各为 1–5 整数（脚本会断言）；任何 `ASSUMPTION` 行**不得**在缺缺失证据说明的情况下进入交付的 TOP 列表。

### 5. 冻结假设与缺口
```bash
jq -r '.[] | select((.missing_evidence|length)>0) | "\(.id)\t\(.missing_evidence|join("; "))"' /tmp/tm/paths.json
```
**期望**：路径 id 与它缺的证据。
**判据**：输出为空 = 无假设路径；非空 = 每条都必须在产出里显式标为假设，并点名缺什么证据（哪个引用、哪次观测）。

## 判读与去噪
- 优先级不是「分数高就必测」：`ASSUMPTION` 高分只说明「若成立则值得测」，先补证据再排队。
- 可达 ≠ 可利用：一条路径能连上不代表能达成影响；把「可达」与「已验证可达成」分列。
- 同一入口的多条路径共用前置条件时，合并前置条件、分别保留影响，避免重复计分抬高优先级。
- 影响评分若来自未验证的业务假设，整条路径的影响分继承该假设的不确定性，标出来。
- 公网 CVE/POC 只作**线索**：引用标来源；除非在目标上复现，否则按假设处理。

## 常见失败
| 现象 | 真实原因 | 处置 |
|---|---|---|
| 路径两端解析不到 `ref` | 入口/资产名与台账对不上（拼写或口径不一） | 回到边界产出核名；对不上的删掉或标假设，别硬配 |
| 所有路径可行性都是 5 | 前置条件没写，等于没门槛 | 补步骤 2；无前置条件的路径可行性不得给满分 |
| 战术标签五花八门 | 自造名或混用阶段名 | 收敛到 ATT&CK 枚举；不属任何战术的跳次就不标 |
| 假设路径排在 TOP | 排序没按 `grounded` 优先 | 用步骤 4 的脚本排序，证据支撑优先，假设靠后并带缺口 |

## 不做的事
- 不执行任何一跳：不扫描、不请求、不验证利用；路径是推演产物。
- 不以推断替代观测；不把「想得到」当成「做得到」。
- 不给未授权目标建模；范围外节点只记为待裁决。
- 不使用公网情报充当证据。

## 产出（交给下一步）
- **候选路径表**：`id / entry / asset / technique / preconditions / tactics`。
- **优先级表**：`score = impact × feasibility`，证据支撑的在前，假设在后。
- **假设清单**：未证实路径 + 各自缺失证据。
- **边界说明**：路径止于何处、哪一跳尚未验证。
- 上述路径作为 `model-attack-trees` 的候选根/分支输入。

## 参考
- PTES：Threat Modeling 阶段的攻击路径与优先级。
- MITRE ATT&CK Enterprise：战术（TA00xx）与技术（Txxxx）分类。
- OWASP WSTG：测试项编号用于把路径落到具体测试面时的索引。
