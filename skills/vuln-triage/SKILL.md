---
name: vuln-triage
description: 候选发现的去重、证据完整性检查、评级与验证计划——把一堆线索整理成「该验哪条、怎么验」
whenToUse: 漏洞分析阶段收尾；候选已被列出、需要决定哪些进入利用验证时
metadata:
  version: 0.1.0
  phase: vulnerability-analysis
  sources: [PTES 漏洞分析, OWASP Risk Rating, CVSS v4 概念]
  smoked: "沙箱实测@b9d9011f8331：6 块原文照跑通过（去重 6→5 且保留 dupes 计数、无任何观察证据的条目落退回列、评级 python（缺依据不得进验证计划）、验证计划行、覆盖面核对 declared=3 covered=2）；只有 signal 没 evidence_ref 的条目不被误退"
---

# 候选去重、评级与验证计划（vuln-triage）

## 适用场景
- 漏洞分析阶段攒了一批候选（扫描命中、手工观察、指纹推断），现在要回答：**哪条值得验、按什么顺序、验的时候需要什么**。
- 产出是**验证计划**（交给利用验证阶段），不是结论——结论要等验证拿到证据。

## 前提与边界
- 本技能只在台账上做变换（jq / python3），不接触目标。
- 台账来源：`/tmp/findings.json`（Agent 用 `memory_search` / `artifact_read` 取到内容后写入）。
- **没有证据的候选不是候选**：只有「版本像」或「按经验可能存在」的条目可以留档，但必须标 `[INFERENCE]`，且**不得进入验证计划的执行序列**。
- 验证动作会触及目标，因此计划里每条都要标**动作类别**（是否需要逐次放行）；计划本身不执行任何动作。

## 步骤

> **容器是一次性的**（`--rm`）：`/tmp/findings.json`（原始发现，来自上游）与 `/tmp/findings.dedup.json`
> （本技能产出）**只在那一条命令内存在**——原始发现不会由别的步骤留在容器里，必须由你在**同一条命令里**
> 先落成 json 再消费；去重后的每一步读取也要与产出它的命令**写成同一条**。
> 分开写会得到 `No such file or directory`（2026-10-06 实测）。

### 1. 去重：按「同一处、同一类、同一证据」合并
```bash
python3 - <<'PY'
import json
rows = json.load(open('/tmp/findings.json'))
seen, out = {}, []
for f in rows:
    key = (f.get('asset'), f.get('class'), (f.get('evidence_ref') or f.get('signal') or ''))
    if key in seen:
        seen[key]['dupes'] = seen[key].get('dupes', 0) + 1
        continue
    f['dupes'] = 0
    seen[key] = f
    out.append(f)
json.dump(out, open('/tmp/findings.dedup.json','w'), ensure_ascii=False, indent=2)
print(f'去重前 {len(rows)} → 去重后 {len(out)}')
PY
```
**期望**：`去重前 N → 去重后 M`。
**判据**：合并键必须同时含**位置**（资产/端口/路径）与**证据引用**。只按标题相似合并会把两个真问题并成一个（漏报）；只按位置合并会把不同类问题压扁。被合并的原条目仍留在文件里（`dupes` 计数），不删除。

### 2. 证据完整性：不完整的先退回
```bash
jq -r '.[] | [.id, (.evidence_ref // "无"), (.signal // "无")] | @tsv' /tmp/findings.dedup.json \
  | awk -F'\t' '$2=="无" && $3=="无" {print $1"\t退回：无任何观察证据"}'
```
**期望**：没有任何观察证据的候选 id。
**判据**：这一列里的条目**不得进入验证计划**，退回补一次最小观察；补不到就留成「未决线索」，不要靠猜把它升级成待验证项。

### 3. 评级：影响 × 可利用性，每一维都要有依据
```bash
python3 - <<'PY'
import json
rows = json.load(open('/tmp/findings.dedup.json'))
def dims(f):
    i, e = f.get('impact', {}), f.get('exploitability', {})
    ok = all(i.get(k+'_basis') for k in ('confidentiality','integrity','availability')) \
         and all(e.get(k+'_basis') for k in ('reachability','auth_required'))
    score = sum(i.get(k,0) for k in ('confidentiality','integrity','availability')) \
          + sum(e.get(k,0) for k in ('reachability','auth_required'))
    return score, ok
for f in sorted(rows, key=lambda x: -dims(x)[0]):
    score, ok = dims(f)
    print(f"{f['id']}\t{score}\t{'评级可用' if ok else '缺依据：不得进入验证计划'}")
PY
```
**期望**：每条候选的分数与「评级是否可用」。
**判据**：**依据不全的条目不评级、不进计划**——「危害很大」不是依据；依据要指到具体观察（响应内容、版本、可达性实测）。同分时按证据强度排序（有原始响应 > 只有指纹 > 只有推断）。

### 4. 生成验证计划（每条：动作、类别、放行、预期证据、停止条件）
```bash
jq -r '.[] | select(.evidence_ref != null) | [.id, .asset, (.class // "unknown")] | @tsv' /tmp/findings.dedup.json > /tmp/plan.tsv
column -t /tmp/plan.tsv 2>/dev/null || cat /tmp/plan.tsv
```
**期望**：待验证候选的 `id / 目标 / 类别`。
**判据**：**这一步只产出行**；每行必须再补三列——动作类别（`passive_collection` / `active_probing` / `credentialed_access` / `exploit_validation`）、是否需要人类逐次放行、预期证据形态。缺任一列的行**不得交出去**：没有类别就无法判断要不要放行，没有预期证据就无法判断「验完了」。

### 5. 覆盖面核对：哪些声明范围还没被碰过
```bash
jq -n --slurpfile s /tmp/scope.json --slurpfile f /tmp/findings.dedup.json \
  '{declared: ($s[0].targets|length), covered: ([$f[0][].asset]|unique|length)}'
```
**期望**：声明目标数与被候选覆盖的目标数。
**判据**：两者有差距时，差额必须出现在产出里（清单 + 原因：未测 / 无候选 / 无权限），不能只留一个数字。**覆盖面缺口是结论的一部分**，不是失败。

## 判读与去噪
- 「扫出来的」与「手工发现的」是两类候选，合并键里保留来源字段：合并掉会丢失方法学信息。
- 评级分数**不跨作业比较**：它是内部排序工具，不是 CVSS 复现。
- `[INFERENCE]` 条目可以留档，但必须与「可执行序列」分开（不同字段或不同文件），避免被下一步误执行。

## 常见失败
| 现象 | 真实原因 | 处置 |
|---|---|---|
| 去重后一条仍对应多个问题 | 合并键太粗 | 把 `class` 与位置一起入键，重跑 |
| 全部候选都「缺依据」 | 前序阶段只记了结论 | 退回补最小观察；把这条列为方法学缺口 |
| 计划里出现执行动作 | 把「怎么验」写成了「已经验」 | 计划只写「要做什么 + 类别 + 预期证据」，执行交给利用验证阶段走放行 |
| 覆盖面差距解释不清 | 有些资产从未被解析 | 回范围清单逐条核对，缺的写「未测 + 原因」 |

## 不做的事
- 不执行任何目标动作（本技能只产出计划）。
- 不做漏洞利用、不做批量扫描；不把 `[INFERENCE]` 升级成结论。
- 不为凑数把无证据条目塞进计划。

## 产出（交给下一步）
- `/tmp/findings.dedup.json`：去重后的候选（含 `dupes`、`evidence_ref`、评级依据）。
- 验证计划表：每条候选 → 动作类别 / 是否需放行 / 预期证据 / 停止条件。
- 覆盖缺口与未决线索（含原因），以及被退回补证据的条目清单。

## 参考
- PTES：Vulnerability Analysis（去重、评级、验证优先级）。
- OWASP Risk Rating Methodology（影响 × 可能性）。
- CVSS v4 概念（为什么评级要写依据而不是只写分数）。
