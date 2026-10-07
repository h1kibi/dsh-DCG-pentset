---
name: vuln-service-checks
description: 用只读 NSE 脚本（http-*/ssl-* 等）与 openssl s_client 核验服务面候选漏洞，并给出 NSE 输出的判读与假阳性处置
whenToUse: 漏洞分析阶段，recon 已得到开放端口与服务指纹，需要核验版本/协议/证书类缺陷时
metadata:
  version: 0.1.0
  phase: vulnerability-analysis
  sources: [Nmap NSE 官方文档, OpenSSL s_client 文档, OWASP WSTG-CONF]
  smoked: "沙箱实测@3c49879dd61b：5 块原文照跑通过（nmap -sV 认出 SimpleHTTPServer 0.6 与 OpenSSL s_server；http-headers/http-methods 输出 Server 与 Supported Methods: GET HEAD；ssl-* 打在非 TLS 端口无输出；openssl s_client 与 ssl-cert 互证；OPTIONS/TRACE 501）。2026-10-06 补 3b「TLS 专项」并实测（fx-tls 自签靶）：testssl --protocols 给出 `TLS 1.2 offered (OK)` 与 1.0/1.1 not offered；sslscan 给出 `TLSv1.2 enabled`、1.0/1.1 disabled；sslyze 给出 Mozilla 合规判定 `FAILED - Not compliant` 并逐项列出（证书路径校验失败、弱套件、多余曲线）"
---

# 服务面候选漏洞核验（vuln-service-checks）

## 适用场景
- 漏洞分析阶段，已有 `<地址>:<端口>` + 服务/版本指纹（来自 `recon-network-surface`）。
- 目标是核验服务与 TLS 配置类问题：已知 CVE 脚本、证书、协议与套件、敏感文件。
- 只读核验，不做认证绕过、不做利用。

## 前提与边界
- 只对 recon 里已确认 `open` 的端口跑脚本，不 `-p-`、不扫范围外。
- 只用**只读类** NSE 脚本（`http-*`/`ssl-*`/`*-info`/`*-enum`）；禁止 `--script=exploit`，
  禁止混入 `brute`/`dos`/`intrusive` 分类。
- TLS 探测（NSE 的 `ssl-*` 与 `openssl`）只做客户端握手观察，不改目标状态。
- **可出网**（2026-10-05 起）：OCSP/CRL 联网校验可用；但本地证书链与有效期仍是主证据，在线状态作补充并标来源。

## 步骤

> **优先用 `pentest_scan`**：`nse_handshake` 走只读 NSE 白名单（`smtp-commands`/`ftp-anon`/`ssh-auth-methods`/
> `rdp-ntlm-info`/`ssl-enum-ciphers`/`smb-os-discovery`/`smb-security-mode`），`tls_weakness` 枚举协议与套件；
> 类别 `active_probing`，**不需要逐条人工放行**。手写 `nmap --script` 走 `pentest_exec` 是
> `exploit_validation`——**每条都要人类批准**，且沙箱侧同样只放行白名单脚本。

| 本 skill 的核验项 | 用这个 technique | 关键参数 |
|---|---|---|
| TLS 协议/套件/证书 | `tls_weakness` | `port=443`、`enumerate_protocols=on` |
| SMTP 能力 | `nse_handshake` | `port=25`、`scripts=smtp-commands` |
| 匿名 FTP（只列目录） | `nse_handshake` | `port=21`、`scripts=ftp-anon` |
| SSH 认证方式 | `nse_handshake` | `port=22`、`scripts=ssh-auth-methods` |
| RDP NTLM 信息 | `nse_handshake` | `port=3389`、`scripts=rdp-ntlm-info` |
| SMB 系统/签名 | `nse_handshake` | `port=445`、`scripts=smb-os-discovery,smb-security-mode` |

### 1. 固定服务版本（后续判据的输入）
```bash
nmap -Pn -p <已 open 端口列表> -sV --version-light <目标> -oN /tmp/svc_ver.txt
```
期望：`VERSION` 列给出产品/版本。**判据**：以此作为情报查证与脚本选择的输入；版本拿不准写
`unknown`，不要猜。只记录 `open` 端口的服务，`filtered` 的留作线索。

### 2. HTTP 类服务核验（http-* 只读脚本）
```bash
nmap -Pn -p <http 端口> \
  --script='http-headers,http-methods,http-title,http-security-headers,http-cookie-flags,http-auth-finder,http-enum' \
  <目标> -oN /tmp/http_scripts.txt
```
期望：每个脚本一个小节。**判据**：逐条落到具体字段——
- `http-methods`：`Supported Methods` 含 `PUT`/`DELETE`/`TRACE` → 配置缺陷候选，须用第 5 步单发确认。
- `http-cookie-flags`：cookie 缺 `HttpOnly`/`Secure` → 记录 cookie 名与缺失属性。
- `http-enum`：列出的「可能存在路径」**每条都要 curl 复核**，它常把 soft-404 当命中。
- `http-security-headers`：缺失的安全头逐条列出。
证据统一引用 `/tmp/http_scripts.txt` 的小节原文，并附端口。

### 3. TLS 类服务核验（ssl-* 只读脚本）
```bash
nmap -Pn -p <tls 端口> \
  --script='ssl-cert,ssl-enum-ciphers,ssl-dh-params,ssl-heartbleed,ssl-poodle,ssl-known-key' \
  <目标> -oN /tmp/ssl_scripts.txt
```
期望：`ssl-enum-ciphers` 给出套件列表与 `least strength`；`ssl-cert` 给出 subject/issuer/有效期/公钥位数。
**判据**：
- `ssl-cert` 的 `Not valid after` 已过期，或 `Not valid before` 在未来 → 证书有效期问题命中。
- RSA 公钥小于 2048 位、或曲线非 P-256 及以上 → 弱密钥候选。
- `ssl-enum-ciphers` 出现 `SSLv2`/`SSLv3`/`TLSv1.0`/`TLSv1.1`/`RC4`/`3DES`/`EXPORT`/`NULL`/`anon` → 弱协议/弱套件命中。
- `ssl-dh-params` 报 `Logjam`/`export-grade`/DH < 1024 位 → 弱 DH 命中。
- `ssl-heartbleed`/`ssl-poodle`：以脚本最终判定为准，但须过「判读与去噪」的假阳性关。

### 3b. TLS 专项核验（testssl / sslscan / sslyze —— 比 nmap 的 ssl-* 脚本细）
```bash
testssl --quiet --color 0 --protocols <地址>:<端口>
sslscan --no-colour <地址>:<端口> | head -40
sslyze <地址>:<端口>
```
**期望**：逐个协议的 offered/not offered（testssl）、`TLSv1.x disabled/enabled`（sslscan）、
Mozilla 合规判定（sslyze：`FAILED - Not compliant` + 具体项）。
**判据**：**1.0 / 1.1 `offered` = 发现**（1.2/1.3 属正常）；证书问题（自签 / 过期 / 主机名不匹配 /
链不完整）各算一条；弱套件（CBC、RC4、`TLS_RSA_*` 非前向保密）按 sslscan 的清单列出。
> **时间预算**：testssl 很慢（自签小靶上也要几十秒；全套 `--fast` 仍可能几分钟）。先用
> `--protocols` 拿协议面，需要套件细节再跑 sslscan（秒级）；sslyze 用来拿「合规」这类判定性结论。
> 三者是**同一件事的不同粒度**，按需取一两个，别三个都跑满。

### 4. openssl s_client 手工交叉核验
```bash
echo | openssl s_client -connect <目标>:<端口> -servername <SNI> 2>/dev/null \
  | openssl x509 -noout -subject -issuer -dates -fingerprint -sha256
echo | openssl s_client -connect <目标>:<端口> -tls1_1 2>&1 | grep -E 'Protocol|Cipher|error'
echo | openssl s_client -connect <目标>:<端口> -tls1_2 2>&1 | grep -E 'Protocol|Cipher|error'
```
期望：第一条打印 `notBefore`/`notAfter`/`subject`/`issuer`/SHA256 指纹；后两条打印协商结果。
**判据**：
- 证书字段与 `/tmp/ssl_scripts.txt` 的 `ssl-cert` 一致 → 互证；不一致以 s_client 的原始证书为准。
- 旧协议能**完成握手**（出现 `Protocol : TLSv1.1` 且无 handshake failure）才记弱协议命中；
  出现 `wrong version number`/`handshake failure`/`no protocols available` → 协商失败，记为未命中。

### 5. 单发复核（只对前几步命中的项）
```bash
curl -sS -i -m 8 -X OPTIONS "http://<目标>:<端口>/" | head -5
curl -sS -i -m 8 -X TRACE   "http://<目标>:<端口>/" | head -5
```
期望：`Allow: ...` 或 405/501。**判据**：`Allow` 里真有 `PUT`/`DELETE`/`TRACE` 才算命中；
返回 `501 Unsupported method` 说明未实现，不是缺陷。

## 判读与去噪
- NSE 只报**事实**，不报**风险**：「出现 X」是事实，「X 是漏洞」要按上下文判定（如旧 TLS 在纯内网可能是有意为之）。
- 假阳性高发项：
  - `http-enum` 把自定义 404/200 当存在 → 必须 curl 复核 body。
  - `ssl-heartbleed` 在负载均衡/中间盒后可能误报 → 以「连续两次 `-sV` 均报 `VULNERABLE`」为线索，
    仍不确定就标「待确认」，不写成命中。
  - `ssl-dh-params` 的弱 DH 报警通常真实但常被标高危 → 按「是否可实际协商」定级。
  - `http-shellshock` 在无 CGI 的服务上输出 `NOT VULNERABLE` 或无输出 → 既不是错误也不是命中。
- NSE 报错行（`ERROR: Script execution failed`、`could not negotiate`）**不是漏洞证据**，
  是脚本没跑通，先排查端口/协议/SNI。
- 评级字母（`least strength: A`）只是排序参考，不能当结论；结论必须落到具体协议/套件/证书字段。

## 常见失败
| 现象 | 真实原因 | 处置 |
|---|---|---|
| ssl-* 对某端口全程超时 | 端口不是 TLS（或需 SNI） | 先用 `openssl s_client` 单次确认是否 TLS；非 TLS 就不跑 ssl-* |
| `openssl s_client` 报 `wrong version number` | 目标其实是明文 HTTP | 不是 TLS 端口，改跑 http-* 脚本，别当握手失败漏洞 |
| `ssl-enum-ciphers` 无输出或只输出一行 error | 端口非 TLS，或服务器禁用了探测所用协议/套件 | 先 `openssl s_client` 确认是否 TLS；是再用 `-tls1_2/-tls1_3` 手工确认可达的最低版本 |
| http-enum 命中一堆路径但 body 相同 | soft-404 | 用 `vuln-web-checks` 第 0 步的基线过滤 |
| `--script=` 里混入 intrusive/brute | 选错脚本分类 | 移除，只保留 safe/info 类 |
| 脚本对 8443 无输出 | 缺 SNI 或端口非 HTTP | 补 `--script-args http.host=<主机名>` 或换端口 |

## 不做的事
- 不改目标状态：不跑 `--script=exploit`，不跑 `brute`/`dos`/`intrusive` 分类。
- 不扫范围外端口/主机，不用 `--min-rate` 顶速。
- 无授权时不对 TLS 做降级攻击或中间人；只做单次握手观察。

## 产出（交给下一步）
- 服务核验条目：`地址:端口 | 服务/版本 | 命中项 | 证据行引用 | 假阳性风险`。
- TLS 明细：可达的最低/最高协议版本、弱套件清单、证书有效期与指纹。
- 待确认项：NSE 报警但无法单发复核的，注明原因。

## 参考
- Nmap NSE：脚本分类（safe/intrusive/exploit 的界定）、`http-*` 与 `ssl-*` 脚本页。
- OpenSSL：`s_client` 手册（`-servername`、`-tls1_x`、`x509 -dates`）。
- OWASP WSTG：WSTG-CONF-01（网络基础设施配置）、WSTG-CRYP-01（弱传输层加密）。
