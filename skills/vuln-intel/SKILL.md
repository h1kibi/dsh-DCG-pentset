---
name: vuln-intel
description: 对给定 CVE/GHSA 或产品版本做漏洞情报核证（NVD/CISA-KEV/GHSA/OSV 的查证姿势与判据），并给出出网被挡时的退化路径
whenToUse: 漏洞分析阶段，拿到 CVE 编号、产品+版本或扫描器报警，需要判断「是否真的适用、是否在野利用」时
metadata:
  version: 0.1.0
  phase: vulnerability-analysis
  sources: [NVD CVE API 2.0, CISA KEV, OSV, GitHub Advisory Database, MITRE CVE]
  smoked: "沙箱实测@a197af1d36f6：curl https://services.nvd.nist.gov/ → curl(6) Could not resolve host（离线退化分支成立）"
---

# 漏洞情报查证（vuln-intel）

## 适用场景
- 手上有 CVE/GHSA/OSV 编号，或一条「产品+版本」线索，要判断是否真的影响当前目标。
- 扫描器 / NSE / 指纹给出的报警需要权威外部数据佐证。
- 输出是「适用性判定 + 置信度 + 出处」，不是漏洞复现。

## 前提与边界
- **沙箱可出网**（2026-10-05 起；`curl -sS https://api.osv.dev/` 实测可达）。因此**在线查证**直接在沙箱内做即可；
  **离线退化**保留给「出网被挡 / 限流 / 目标侧无网络」的场景（见第 6 步）。
- 情报是线索不是结论：CVE 存在 ≠ 目标适用；在野利用 ≠ 本目标可利用。最终判定必须回到目标侧版本/配置证据。
- **不臆造**：查不到就写「未获取到」，绝不用记忆里的数字冒充实测结果。

## 步骤

### 1. 归一化输入
```bash
printf '%s\n' '<原始线索>' | grep -oiE \
  'CVE-[0-9]{4}-[0-9]{4,}|GHSA-[a-z0-9]{4}-[a-z0-9]{4}-[a-z0-9]{4}|[a-z0-9_.-]+/[a-z0-9_.-]+|[a-z0-9_.-]+ [0-9]+(\.[0-9]+)+'
```
期望：抽出编号，或「产品 版本」。**判据**：抽到 CVE/GHSA → 走编号查证；只有产品+版本 → 走版本对比；
都没有 → 先回情报收集阶段补齐指纹，不要凭空猜。

### 2. NVD 查证（在线）
```bash
curl -sS -m 20 -H 'User-Agent: vuln-intel/0.1' \
  "https://services.nvd.nist.gov/rest/json/cves/2.0?cveId=CVE-XXXX-YYYY" -o /tmp/nvd.json -w '%{http_code}\n'
jq -r '.vulnerabilities[0].cve | "\(.id) \(.metrics.cvssMetricV31[0].cvssData.baseScore // .metrics.cvssMetricV30[0].cvssData.baseScore // "n/a") \(.metrics.cvssMetricV31[0].cvssData.baseSeverity // "n/a")"' /tmp/nvd.json
jq -r '.vulnerabilities[0].cve.configurations[]?.nodes[]?.cpeMatch[]? | "\(.criteria) start=\(.versionStartIncluding // "-") end=\(.versionEndExcluding // "-")"' /tmp/nvd.json
```
期望：`CVE-XXXX-YYYY <分数> <等级>` 与三段式 CPE（`cpe:2.3:a:vendor:product:...`）。**判据**：
- CPE 的 vendor/product 与目标指纹一致，且版本落在 `versionStartIncluding..versionEndExcluding` 区间 → 「适用」候选。
- 只匹配品牌不匹配版本，或 CPE 指向别的产品 → 「不适用」。
- `vulnStatus` 为 `Rejected`/`Awaiting Analysis`、或无任何 `configurations` → 「情报不足」，不下结论。

### 3. CISA KEV 查证（是否在野利用）
```bash
curl -sS -m 20 "https://www.cisa.gov/sites/default/files/feeds/known_exploited_vulnerabilities.json" \
  | jq -r '.vulnerabilities[] | select(.cveID=="CVE-XXXX-YYYY") | "\(.cveID) \(.vendorProject)/\(.product) added=\(.dateAdded) ransomware=\(.knownRansomwareCampaignUse)"'
```
期望：命中则一行，否则无输出。**判据**：有输出 → 标记「已知在野利用」并提升优先级；
无输出 → 「未见 KEV 记录」，**不等于不可利用**。

### 4. OSV / GHSA 查证（组件与生态包）
```bash
curl -sS -m 20 -X POST "https://api.osv.dev/v1/query" \
  -d '{"package":{"name":"<包名>","ecosystem":"<npm|PyPI|Go|Maven|crates.io|...>"},"version":"<版本>"}' \
  | jq -r '.vulns[]? | "\(.id) \(.summary)"'
```
期望：命中则列出 GHSA/OSV 编号；`jq` 输出为空说明该版本不在受影响集合。**判据**：
- 有 `.vulns` 且 `.affected[].ranges` 覆盖目标版本 → 适用。
- GHSA 与 OSV 同号互证（OSV 聚合 GHSA），两条都命中 → 置信度更高。
- 生态名大小写敏感（`PyPI`/`npm`/`crates.io`），写错会得到空结果。

### 5. 交叉判定（情报 × 目标证据）
把第 2/4 步的受影响版本区间与目标实测 banner（`recon-network-surface` 的版本）对照：

| 情报命中 | 版本在区间 | 结论 |
|---|---|---|
| 是 | 是 | 适用（附 CVE + CPE/区间证据） |
| 是 | 否 | 不适用（注明实测版本高于修复版本，或低于引入版本） |
| 是 | 版本未知 | 待定（补指纹，别猜） |
| 否 | — | 未见记录（≠ 安全，记为情报缺口） |

期望：每个候选条目套表后落到「适用 / 不适用 / 待定 / 未见记录」四类之一。
**判据**：产品（CPE/包名）与版本区间**同时**命中才判「适用」；只命中其一按表降为「不适用」或「待定」，不许含糊。

反向：目标有可疑行为但无公开编号 → 记「无公开编号」，走人工分析。

### 6. 出网被挡时的退化路径
先确认是「确实取不到」而不是拼写错误或限流：
```bash
curl -sS -m 8 https://api.osv.dev/ 2>&1 | head -2
```
期望：正常时返回 JSON；取不到时的判据是 `Could not resolve host`（解析失败）、超时或 403/限流。**判据**：确认取不到就走退化，不再反复重试外网。
退化手段（按优先级）：
1. **人类材料**：让人类在控制台跑第 2–4 步，把 JSON/截图/链接交给本 Agent；或提供离线清单
   （NVD JSON、KEV JSON 文件）。
2. **本地材料**：`find / -iname '*nvd*' -o -iname '*kev*' 2>/dev/null` 找镜像自带的缓存，
   有就用第 2/3 步的 `jq` 过滤表达式本地查。
3. **记忆检索**：用模型已训练的知识给出**推测**，必须标注 `[MEMORY·未核验]`，并写明
   「置信度低、发布时间可能晚于训练数据、需人类复核」；分数/编号不确定时写 `unknown`。
4. 仍无法确认 → 列为「情报未决」，交下一步或人类。

## 判读与去噪
- CVE ≠ 适用：同产品不同版本、不同配置是否触发差异极大；没有版本证据只能标待定。
- KEV 缺失 ≠ 安全：只代表未被列入已知在野利用清单。
- CPE 命名会漂移（同一产品多个 vendor）；匹配时以产品语义为准，必要时列出多个 CPE。
- 记忆检索结果可能是**已撤回/已修订**的，必须标注来源与检索时点。
- `Rejected`/保留状态的 CVE 不要引用其细节。

## 常见失败
| 现象 | 真实原因 | 处置 |
|---|---|---|
| curl 报 `Could not resolve host` | 域名拼写错 / 解析器不可达 | 核对域名；仍失败则走第 6 步退化 |
| NVD 返回 403/限流 | 未带 UA 或请求过快 | 加 `-H 'User-Agent: ...'`，降低频率；仍失败交人类 |
| `jq` 取到 null | 该版本无 CVSS v3.1（只有 v2/v3.0） | 用 `//` 回退到其它 metric 字段，或记 `n/a` |
| OSV 查询无 `.vulns` | 生态/包名写错，或本就无公告 | 核对 ecosystem 大小写，空结果记为「未见记录」 |
| 记忆里的 CVE 细节与在线结果不符 | 记忆过时或被修订 | 以在线/人类材料为准，修正并标注来源 |

## 不做的事
- 不臆造 CVE/GHSA 编号、CVSS 分数、CPE、发布日期。
- 不把「情报命中」直接写成「目标存在漏洞」——必须有目标侧版本/配置证据。
- 不在沙箱里反复重试外网请求（无意义且拖时）。
- 不下载并执行第三方 PoC。

## 产出（交给下一步）
- 情报条目：`编号 | 产品/版本 | 来源(NVD/KEV/OSV/人类/记忆) | 适用性 | 证据(CPE/版本区间/KEV 日期) | 置信度`。
- 在野利用标记：是否命中 KEV。
- 情报缺口清单：无法查证 / 版本未知 / 需人类复核的条目。

## 参考
- NVD CVE API 2.0（`GET /rest/json/cves/2.0?cveId=...`）。
- CISA Known Exploited Vulnerabilities 目录 JSON。
- OSV API `POST /v1/query`；GitHub Advisory Database（GHSA 编号）。
- MITRE CVE 编号与状态（Rejected/Reserved）。
