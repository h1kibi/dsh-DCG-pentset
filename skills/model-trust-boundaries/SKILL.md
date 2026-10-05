---
name: model-trust-boundaries
description: 从已收集证据绘制信任边界与数据流：入口/出口清单、逐处认证判定、跨边界可信理由，边界必带证据引用或显式假设
whenToUse: 威胁建模阶段；已拿到情报收集的资产/服务/入口证据，需要固定信任边界与数据流基线时；为攻击路径与攻击树提供入口→资产映射
metadata:
  version: 0.1.0
  phase: threat-modeling
  sources: [PTES 威胁建模, OWASP Threat Modeling, MITRE ATT&CK 战术]
  smoked: "沙箱实测@a197af1d36f6：jq/python 台账管线（入口/出口/缺引用跨界流计数）；curl 只读核验 200"
---

# 信任边界与数据流（model-trust-boundaries）

## 适用场景
- 威胁建模阶段，上游情报收集已产出资产/服务/入口清单与覆盖说明，需要把它们固定成边界基线。
- 产出是**边界表 + 数据流 + 假设清单**，不是漏洞、不是利用率。发现的可疑处转给攻击路径技能，不在这里下结论。
- 本阶段默认**零目标动作**；只有一处例外（步骤 3 的一次只读核验）。

## 前提与边界
- 工具面是记忆检索与只读证据访问（`memory_search` / `memory_read` / `artifact_read`）加一次受限的 `pentest_exec:http_read`（模板 `http_get`，仅 GET/HEAD，类别 `passive_read`）。主动扫描（`tcp_connect`/`udp_probe`）、自由命令（`shell_exec`，类别 `exploit_validation`）都不属于本阶段。
- **证据 vs 推断，二选一**：每条边界、每处认证判定、每条数据流，要么挂 `memory:<uuid>`/`artifact:<uuid>` 引用，要么显式 `assumption=true` 并写出缺失证据。禁止「看起来合理就当真」。
- 沙箱**可出网**（2026-10-05 起，DNS 用宿主解析器）：公网 CVE 库、威胁情报站查得到，但**它们不是关于本目标的证据源**——外部事实要么标来源+假设，要么改用人类提供的材料或记忆检索。
- 目标地址一律用选择器给的**已裁决地址**，不自行解析域名。
- 越界即中止并请人类修订范围；破坏性 / 持久化 / 数据外传类动作会被上游直接拒，本阶段也不会用到。

## 步骤

### 1. 归一化并校验证据台账
把上游证据导出成 `/tmp/tm/evidence.json`（JSON 数组，元素含 `kind`、`ref`、`target`、`evidence_refs`）。
```bash
mkdir -p /tmp/tm && jq -e 'type=="array" and length>0' /tmp/tm/evidence.json >/dev/null && \
  jq -r '.[] | [.kind, .ref, (.evidence_refs|length)] | @tsv' /tmp/tm/evidence.json | sort | uniq -c
```
**期望**：每行 `次数 kind ref 引用数`。
**判据**：任何 `ref` 的引用数为 0，就不是证据 —— 移入假设清单，**不得**用它支撑边界；台账为空则先回到记忆检索，不凭记忆建模。

### 2. 抽入口 / 出口清单
```bash
jq -r '.[] | select(.kind=="entry" or .kind=="egress") |
  [.kind, .ref, (.target//"?"), (.protocol//"?"), (.direction//"?"), (.auth//"unknown")] | @tsv' \
  /tmp/tm/evidence.json | sort
```
**期望**：`kind ref target protocol direction auth` 六列。
**判据**：`auth=unknown` 的行**不得**在边界结论里被当作已认证或未认证；逐条进入步骤 3。出口漏一列比多写一条更危险：数据离开的通道（回调、外发集成、DNS 查询）同样要列。

### 3. 逐入口判定认证（优先证据，不足才现场核验一次）
```bash
jq -r '.[] | select(.kind=="entry") | select((.auth//"unknown")=="unknown") | .ref' /tmp/tm/evidence.json
```
**期望**：待判定入口的 `ref` 列表。
**判据**：为空则跳过本节；非空时**先翻证据里已有的响应**（状态码、跳转、`WWW-Authenticate`、跳登录）。**仍无法判定**才允许一次只读核验：
```bash
curl -sS -D - -o /dev/null --max-time 10 http://<已裁决地址>:<端口><路径>
```
**期望**：状态行 + 响应头。**判据**：只有 `401`/`403` 或跳登录能支撑「需要认证」；`200` 只说明该路径匿名可达，**不等于**整个入口无认证（可能只是公开页）。**为什么非现场不可**：认证状态随配置/会话漂移，证据包没有权威响应时，唯一可得的观测就是这一次只读请求；**禁止连发枚举**，全阶段至多一次。

### 4. 定义边界并登记数据流
```bash
jq -r '.[] | select(.kind=="flow") |
  [.from, .to, (.boundary//"?"), (.mechanism//"?"), (.evidence_refs|length)] | @tsv' \
  /tmp/tm/evidence.json
```
**期望**：`from to boundary mechanism 引用数`。
**判据**：`boundary` 为空 = 这条流没声明跨哪条边界，先补边界再谈可信。**不要**把「同一台主机」默认当同一边界 —— 反向代理前后、容器内外、认证前后都可能是边界。

### 5. 逐边界写「为何可信」并冻结假设
```bash
jq -r '.[] | select(.kind=="flow") | select((.evidence_refs|length)==0) |
  "\(.from) -> \(.to) [boundary=\(.boundary//"?")]"' /tmp/tm/evidence.json
```
**期望**：所有缺引用的跨界流。
**判据**：输出为空 = 每条边界都有证据；非空 = 这些必须在产出里逐条标 `assumption=true` 并写 `missing_evidence`。可信理由只能来自机制证据（TLS/mTLS、令牌校验、网络 ACL、TLS 终止点），**禁止**用「通常如此」充当理由。

### 6. 自检：证据与假设不混列
```bash
jq -r '[.[] | select(.kind=="flow")] |
  "flows=\(length) with_evid=\([.[]|select((.evidence_refs|length)>0)]|length)"' /tmp/tm/evidence.json
```
**期望**：一行计数。
**判据**：`flows == with_evid` 才算闭环；否则假设清单必须非空，且条数与差额一致（不许多、不许少）。

## 判读与去噪
- `Server` / `banner` 可伪造、可被中间设备改写：弱证据，标证据级别而不是直接采信。
- 「存在登录页」≠「强制认证」：要有跳转或 401/403 的实际证据。
- 同一边界两条矛盾证据（如一个响应说已认证、一个说匿名可达）：两条都记录并标 `conflict`，**不静默取一条**。
- 速率被宿主限流（命令比预期慢）是排队，不是网络故障：不要重试、不要拆命令绕过。
- 需要公网材料时：能取到，但一律标来源；未在目标上验证前按假设处理。

## 常见失败
| 现象 | 真实原因 | 处置 |
|---|---|---|
| `jq` 报 parse error | 台账不是合法 JSON 数组（混入了日志行） | 先修格式；格式不齐说明上游导出有问题，标为覆盖缺口并返工，别硬解析 |
| 全部入口 `auth=unknown` | 上游只抓了 banner，没抓认证响应 | 先从证据里找 401/跳转；仍缺则做**一次**只读核验，其余全部标假设 |
| 边界表里出现范围外主机 | 上游证据混入了未授权目标 | 立即移除并报告「范围污染」；不要对它建模、更不要核验 |
| 数据流出奇地多、全是假设 | 出口通道来源全靠推断 | 收敛到有证据的出口；其余整批标假设并点名缺失证据，不逐条编理由 |

## 不做的事
- 不执行攻击、扫描、枚举、爆破；除步骤 3 的一次只读 `http_get` 外不触目标。
- 不以推断替代观测；不把「未观察到」写成「不存在」。
- 不引用公网情报当证据（2026-10-05 起公网可达，但外部情报只作线索：引用标来源，未在目标上验证的按假设处理）。
- 不越范围：任何范围外主机只记录为「待人类裁决」，不建模。

## 产出（交给下一步）
- **边界表**：每条边界 `id / 两侧 / mechanism / evidence_refs 或 assumption+missing_evidence`。
- **入口 / 出口清单**：`ref / target / protocol / direction / auth`（`auth` 可以是 `unknown`）。
- **数据流**：`from → to` 边集合，每条带所跨边界与可信理由。
- **假设清单**：未证实项 + 各缺什么证据。
- **入口 → 资产映射**：供 `model-attack-paths` 直接消费的起始边。

## 参考
- PTES：Threat Modeling 阶段的信任边界与数据流梳理。
- OWASP Threat Modeling：Trust Boundaries / Data Flow Diagrams。
- MITRE ATT&CK 战术枚举（TA0001 Initial Access、TA0006 Credential Access、TA0008 Lateral Movement、TA0010 Exfiltration）。
