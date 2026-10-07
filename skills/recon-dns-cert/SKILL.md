---
name: recon-dns-cert
description: 用 dig 与 openssl s_client 清点 DNS 记录与 TLS 证书（链、有效期、SAN、签发者），并给出解析不可用时的退化路径
whenToUse: 情报收集阶段；拿到域名/证书线索、需要确认解析归属、或要确定 TLS 身份与有效期时
metadata:
  version: 0.1.0
  phase: intelligence-gathering
  sources: [PTES 情报收集, OWASP WSTG-INFO-01, WSTG-CRYP-01, RFC 5280, RFC 9309, MITRE ATT&CK T1590.002/T1596.003]
  smoked: "沙箱实测@81483611f0a0：7 块原文照跑（解析器选定 127.0.0.11、A/AAAA、记录类型循环、PTR 反解出容器名 fx-tls.pentest-lab-internal、证书字段 CN=smoke.local、链校验 self-signed 预期、退化探测）；退化块本轮修掉——dig … | head -3; echo $? 取的是 head 的退出码恒为 0，改成单独捕获后 exit=124/9 才可用；非 A/PTR 类型在内嵌 DNS 下超时属环境行为。2026-10-06 又补两步并实测：⑧区域传送——对实验室 bind9（docker/dns-lab，zone lab-zone.test 故意 allow-transfer any）拿到完整传送（11 条记录，含只应内网的 internal-only A 10.42.0.9），对同服务器的 hardened.test 与 AD DC 的内嵌 DNS 都得 `Transfer failed.`（正常配置的否定结论）；⑨whois——whois example.com 取到注册局/创建/到期/NS，结构化 whois_query kind=domain|ip 返回 whois_registrar / whois_inetnum / whois_netname。另实测：结构化 DNS 通道（dns_enum/dns_brute/dns_axfr）只支持 system/public 解析器，对内网 zone 返回 records=0、labels=4989 found=0（跑了约 7 分钟）——已写入判读与去噪。2026-10-06 再补第 10 步（子域枚举）并实测：subfinder -d example.com 得 m.example.com / dev.example.com / products.example.com；dnsx 解析出该域两条 A 记录"
---

# DNS 与证书面清点（recon-dns-cert）

## 适用场景
- 情报收集阶段，手上是**域名或证书线索**，需要把它落到可复核的记录上（解析到哪里、由谁签发、覆盖哪些名字）。
- 为 `recon-network-surface`（端口）与 `recon-web-surface`（站点）提供归属与身份证据。

## 前提与边界
- 沙箱是 root 且有 `NET_RAW`，`dig` 可直接发 UDP/TCP 53 查询。
- **沙箱可出网**（2026-10-05 起）：公网解析器（8.8.8.8 / 1.1.1.1）、在线 CT 日志、CVE 站点、在线 WHOIS 都可达。但**外部解析与外部库不是目标的证据**：目标事实以目标上实测为准；外部结果标来源，并区分「解析得到」与「权威确认」。出网被挡（目标侧或本地策略）时走第 7 步退化。
- 只应使用**范围授权的解析器**（人类提供的内网权威/递归）。目标地址用**选择器给的那份已裁决地址**，不要自己解析域名替换它。
- 速率由宿主按行为预设限速；本技能查询量小，但仍不加高频参数、不做批量爆破。
- 证书判读依赖本地信任库：内部 CA / 自签会报校验失败，这**不等于**目标有问题。

## 步骤

> **优先用 `pentest_recon`**：`dns_enum` / `tls_inspect` / `ct_subdomains` 把记录类型、SNI、
> 通配处理都做成枚举参数，类别是 `passive_collection`/`active_probing`——**不需要逐条人工放行**；
> 手写 `dig`/`openssl` 走 `pentest_exec` 属 `active_probing`，**免批**（命令原文不再经人过目）。
> 注意：DNS 类 technique 在服务端按 `udp` 记账，**范围条目要声明 udp**，否则会被范围闸门拒绝。

| 本 skill 的步骤 | 用这个 technique | 关键参数 |
|---|---|---|
| 1 选定解析器 | `dns_enum` | `resolver=public`（不想暴露内网 DNS 时） |
| 2 正向解析 A/AAAA | `dns_enum` | `record_types=A,AAAA` |
| 3 其它记录类型 | `dns_enum` | `record_types=MX,NS,TXT,CAA,SOA,SRV`（最多 8 个） |
| 4 反向解析 PTR | ——（不覆盖） | 手写 `dig -x <地址>` |
| 5 TLS 证书字段 | `tls_inspect` | `port=443`、`sni=none`（用目标名）或指定主机名 |
| 6 协议/弱套件 | `tls_inspect` | `enumerate_protocols=on` |
| 附加：子域枚举 | `ct_subdomains` / `dns_brute` | `include_wildcards=false`；`concurrency=10`、`wildcard_check=on` |

### 1. 选定解析器（先决条件）
```bash
cat /etc/resolv.conf
dig +short +time=2 +tries=1 A <目标名> @<解析器IP>
```
期望：目标名解析出 IP；或 `no servers could be reached`。
判据：解析器可达且能应答才继续。优先顺序：
1. 范围指定的内网权威/递归解析器（人类给的 IP）；
2. 目标跑在同一 Docker 内网时，容器内 `127.0.0.11` 是内嵌 DNS，可解析同网容器名（实测 `pentest-target-http` → `172.29.0.3`）；
3. 都没有 → 直接走第 7 步退化，不要试公网解析器。

### 2. 正向解析 A / AAAA
```bash
dig +noall +answer +time=3 +tries=1 A    <目标名> @<解析器IP>
dig +noall +answer +time=3 +tries=1 AAAA <目标名> @<解析器IP>
```
期望：`名称 TTL IN A 地址`，可能先有 `CNAME` 再是 `A`。
判据：记录每个 CNAME 跳与最终地址。**解析结果与选择器裁决地址不一致时必须报告，不得自行替换目标地址。**

### 3. 其它记录类型：线索密度高
```bash
for t in CNAME MX NS TXT SOA; do
  echo "== $t =="; dig +short +time=3 +tries=1 "$t" <目标名> @<解析器IP>
done
```
期望：内网名通常只有 A/PTR，`TXT/MX/NS` 为空。
判据：**空输出 = 该类型无记录，不是错误**。有价值的是：
- `TXT` 里的 `v=spf1`（邮件/第三方）、`google-site-verification`、`_dmarc`、DKIM（长 base64，截断记录）；
- `NS` 给出该区的权威服务器，可作为下一步指定解析器的候选；
- `SOA` 给出区名与管理员邮箱线索。
> `dig` 与 `nslookup`/`host` 的答案应一致；不一致时以 `+noall +answer` 的原始记录为准。

### 4. 反向解析 PTR
```bash
dig +short +time=3 +tries=1 -x <IP> @<解析器IP>
```
期望：`172.29.0.3` → `pentest-target-http.pentest-lab-internal.`（实测）。
判据：PTR 给出主机名，用来和 `recon-network-surface` 的 IP 资产互相校验；无 PTR 是常见的，不影响继续。

### 5. TLS 证书获取（字段提取）
```bash
echo | openssl s_client -connect <目标>:<端口> -servername <SNI名> -showcerts 2>/dev/null \
  | openssl x509 -noout -subject -issuer -dates -ext subjectAltName 2>/dev/null
```
期望（本地自签服务实测形态）：
```
subject=CN = test.local
issuer=CN = test.local
notBefore=Oct  4 16:47:21 2026 GMT
notAfter=Oct  7 16:47:21 2026 GMT
X509v3 Subject Alternative Name:
    DNS:test.local, DNS:alt.test.local
```
判据：
- 出现 `subject=` 与 `notAfter=` 才算取到证书；否则见「常见失败」。
- `-servername` **必填**：它决定 SNI，不填会拿到默认 vhost 的证书（因此可能 CN 与目标名不符）。
- `-showcerts` 打印整条链；只要叶子证书时可省略。

### 6. 链校验与有效期判读
```bash
echo | openssl s_client -connect <目标>:<端口> -servername <SNI名> 2>&1 >/dev/null \
  | grep -Ei 'verify (return code|error)'
```
期望：`Verify return code: 0 (ok)`。
判据：
- 非 0（`self signed certificate`、`unable to get local issuer certificate`）= 自签 / 内部 CA / 链不全 → 记录签发者，向人类索取内部根 CA 再判；不等于「目标恶意」。
- `notAfter` 早于当前时间 = 已过期（线索）；`notBefore` 在未来 = 时钟/预制证书线索。
- SAN 里的每个名字都是候选 vhost / 域名线索，**但只有范围内或明确相邻的名字才纳入**，越界要请人类修订范围。

### 7. 解析不可用时的退化路径（出网被挡 / 目标侧无解析器）
解析与出网被挡时（2026-10-05 起沙箱默认可出网，所以这不是默认路径），不要反复重试下列动作：公网解析器、`dig +trace`（需要逐级访问根/TLD）、在线 CT 日志、在线 WHOIS、CVE 库。
按顺序退化：
1. **请人类在控制台提供解析结果**（A/AAAA/CNAME/TXT 原文）——本技能只做判读与记录，并在产出里注明「来源：人类提供」。
2. **用范围授权的内网 DNS 或权威服务器**（人类给 IP），重跑第 2–4 步。
3. **只有域名、没有可达解析器**：可用模型记忆中的公开命名/归属作线索，但必须标注 `[INFERENCE]`，**不得当作已验证事实**。
4. **已知 IP、需验 TLS 身份**：直连 IP，`-servername` 填人类给的域名，即可绕过 DNS 完成第 5–6 步。
5. **TXT/MX 等记录拿不到**：在产出里列为「未取得（无解析器）」，不要留空冒充「无记录」。

先证明「确实没有解析器」，再退化——**一次超时不等于不可达**：
```bash
timeout 5 dig +short <目标> @<人类给的内网解析器 IP> >/tmp/dig-out.txt 2>&1; echo "exit=$?"; head -3 /tmp/dig-out.txt
```
**期望**：要么给出记录，要么给出 `no servers could be reached` / `connection timed out`。
**判据**：拿到记录 → 走第 2–4 步正常路径；解析器明确不可达 → 才进入下面的退化序列，并把「解析器不可达」写进产出作为依据。`exit` 要**单独捕获**：`dig … | head -3; echo $?` 取的是 `head` 的退出码，恒为 0，看它永远判不出解析器死活（2026-10-06 逐块验证实测）。`124`=timeout 掐断，`9`=`no servers could be reached`，`2`=参数/用法错。

**期望**：每条拿不到的证据都有明确来源标注，或明确写「未取得」。
**判据**：结论必须能追到来源——人类提供 / 内网解析器 / `[INFERENCE]`（仅线索）。**未标注来源的记录不得写入资产**；宁可写「未取得（无解析器）」，也不要留空冒充「无记录」。

### 8. 区域传送（AXFR）：DNS 里最值钱的一条配置错误
```bash
dig +short NS <zone>            # 先拿权威服务器
dig +time=5 +tries=1 AXFR <zone> @<权威服务器地址>
```
**期望**：两种形态**都算结论**——完整传送（SOA 开头、SOA 结尾、中间是全部记录），或 `; Transfer failed.`。
**判据**：
- **拿到完整传送 ⇒ 这本身是一条发现**：该权威服务器允许任意主机拉走整个 zone。证据里要写「记录条数 +
  是否含只应内网的记录」——实测样本里就吐出一条 `internal-only A 10.42.0.9`，那是最能说明风险的一行。
- `Transfer failed.` ⇒ 未授权传送被拒（**正常配置**），把这条否定结论写下来，**不要反复重试**。
- **通道选择**：公网 zone 可以用结构化 `dns_axfr target=<zone>`（免审批）；内网/lab zone 只能手写
  `dig @<地址>`（类别 `active_probing`，**免批**：命令原文不再经人过目）。

### 9. 归属与网段（whois）：把外部线索定位到主体
```bash
whois <域名>        # 注册局/注册商/创建与到期/NS
whois <IP>         # 网段（inetnum/netname）与所属机构
```
**期望**：域名的注册商与名称服务器；IP 的网段与机构名。
**判据**：把「域名 → 注册商/NS」「IP → 网段/机构」写进资产；**到期时间与最近变更**是时间线素材。
优先用**结构化通道**（免审批、字段已解析）：`whois_query target=<域名或 IP> kind=domain|ip`
（实测返回 `whois_registrar` / `whois_name_server` / `whois_inetnum` / `whois_netname` 这类字段）。
外部查询会**间歇**失败（§6.5.9）：失败时把形态原样记下并走离线分支（记忆/人类提供），
**不要重试到超预算**。

### 10. 子域枚举（外部资产面，结构化通道也行）
```bash
subfinder -d <域名> -silent            # 被动源聚合（不直接打目标）
echo <域名> | dnsx -silent -a -resp    # 批量解析确认（把"名字"变成"地址"）
```
**期望**：subfinder 逐行打印子域；dnsx 逐行打印 `名字 [A] [地址]`。
**判据**：**枚举到的名字不是资产**——只有 dnsx 解析出地址、且在范围内，才算资产；
解析不出的名字记为「线索（未解析）」。子域常常直接暴露内网命名习惯（`dev-`、`staging-`、`internal-`）。
> 结构化通道 `pentest_recon` 的 `dns_enum` 走 system/public 解析器，适合**公网域名**（免审批）；
> 内网 zone 只能手写 `dig @<地址>`（见「判读与去噪」）。
> 出网间歇（§6.5.9）：被动源拿不到时把失败形态记下，不要反复重试。

## 判读与去噪
- **结构化 DNS 通道够不到内网 zone**：`pentest_recon` 的 `dns_enum`/`dns_brute`/`dns_axfr` 只支持
  `system` / `public` 解析器，而容器里的 system 解析器是宿主给的、不认识内网域名——实测对实验室 zone
  返回 `records=0`、`labels=4989 found=0`（还跑了 7 分钟）。**内网 zone 一律手写 `dig @<已裁决地址>`**；
  结构化通道留给公网域名（省审批、有结构）。
- 一个名字多个 A 记录 = 负载均衡 / 多后端，不是冲突。
- **`SERVFAIL` ≠ `NXDOMAIN`**：内网解析器对未知名可能返回 `SERVFAIL`（曾实测 Docker 内嵌 DNS 对未知容器名返回 `status: SERVFAIL`），**也可能直接超时/无应答**——2026-10-06 在同一网络实测到的是 `communications error to 127.0.0.11#53: timed out` 与 `no servers could be reached`。两种都表示「解析器答不上」，与 `NXDOMAIN`（权威说「没有」）不是一回事，不要混为一谈；也不要因为「没看到 SERVFAIL」就以为解析器是好的。
- 解析到私网/保留地址时，那是**分裂视图（split-horizon）**，不要拿公网库去核对。
- 证书 SAN 多名字 ≠ 全在范围内；只登记范围内/相邻名字。
- TXT 记录可能很长（DKIM base64），截断为「前 60 字符 + …」。
- `dig +short` 的空输出很好用，但判「无记录」之前先看一眼 `+noall +answer` 的原始应答，确认不是解析器故障。

## 常见失败
| 现象 | 真实原因 | 处置 |
|---|---|---|
| `no servers could be reached` | 指定解析器不在可达网段或未监听 53 | 先核对地址/监听；本部署可出网，公网解析器（8.8.8.8）也可用，但结果要标来源 |
| 公网域名全部 `SERVFAIL` / 超时 | 解析路径不通（无解析器 / 出网被挡） | 先证明是解析器问题，再走第 7 步退化；别无限重试 |
| s_client 报 `wrong version number` | 该端口是明文 HTTP（实测靶标） | 该端口不是 TLS；改走 `recon-web-surface` |
| s_client 报 `no peer certificate available` | 服务端未提供证书，或需 STARTTLS 而未协商 | 先确认服务类型；非 TLS 就停止证书判读 |
| 证书报 `self signed` / verify 非 0 | 自签或内部 CA | 记录签发者，向人类要内部根 CA；不等于目标有问题 |
| 取到的 CN 与目标名不符 | 命中默认 vhost（未指定 SNI） | 用 `-servername <正确名字>` 重取 |
| `dig -x` 无输出 | 该 IP 无 PTR | 正常，不影响其它步骤 |

## 不做的事
- 不把公网查询当作目标证据：CT 日志、CVE 库、在线 WHOIS、外部解析器都可达（2026-10-05 起），但结论要标来源；只有**目标上实测**才算验证。
- **默认不做 `dig AXFR`（区域传送）**：虽属读取，但可能一次性导出整区记录、影响面大；只有人类在范围内明确授权才做，且一次性、限量。
- 不爆破子域名（`subdomains-5000.txt` 是主动动作，需人类授权且解析器可达；本技能默认只用已有线索）。
- 不修改目标状态，不修改 TLS 配置，不做证书/解析劫持类动作。
- 不自行解析域名去替换选择器给的裁决地址。

## 产出（交给下一步）
- 解析记录表：`名称 → 类型 → 值 → 解析器 → 时间`，含 CNAME 链。
- 证书表：`目标:端口`、SNI、`subject`、`issuer`、`notBefore/notAfter`、SAN 列表、链校验码。
- 来源与置信度：哪些值来自人类提供 / 内网解析器 / 记忆推断（`[INFERENCE]`）。
- 未决线索：分裂视图、自签或内部 CA、SAN 中的新名字、解析与裁决地址不一致项。
- 覆盖缺口：哪些记录类型没取到、为什么（无解析器 / 解析器不可达）。

## 参考
- PTES：Intelligence Gathering — DNS 与主机/网络调查。
- OWASP WSTG-INFO-01（信息收集）、WSTG-CRYP-01（传输层安全测试）。
- RFC 5280（X.509 证书与 CRL）、RFC 9309（robots.txt）。
- MITRE ATT&CK：T1590.002（Gather Victim Network Information: DNS）、T1596.003（Search Open Technical Databases: Digital Certificates）。
- `dig` 与 `openssl s_client` 手册页。
- 姊妹技能：`recon-network-surface`（端口与 banner）、`recon-web-surface`（HTTP 面）。
