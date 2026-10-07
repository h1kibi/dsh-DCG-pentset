---
name: vuln-web-checks
description: 按 OWASP WSTG 测试项核验 Web 面候选漏洞（认证/会话/授权/输入/配置），用 curl 与 ffuf 产出带证据行的结论
whenToUse: 漏洞分析阶段，目标已确认有 HTTP(S) 服务，需要把「可疑」判成「命中/排除/待定」时
metadata:
  version: 0.1.0
  phase: vulnerability-analysis
  sources: [OWASP WSTG, OWASP Top 10 2021, PayloadsAllTheThings, HackTricks]
  smoked: "沙箱实测@b9d9011f8331：8 块原文照跑，5 块通过、3 块为靶站无该现象（POST 501、无 Set-Cookie、IDOR/反射/安全头全 404 或缺失，静态站预期）；soft-404 基线三行一致 404/469；ffuf -ac + jq 范式 20s 命中 1；OPTIONS → 501 判读"
---

# Web 面候选漏洞核验（vuln-web-checks）

## 适用场景
- 漏洞分析阶段，`recon-network-surface` 已给出目标开放的 HTTP(S) 端口与响应指纹。
- 输入是 Web 面上的候选问题（可疑登录页、可疑参数、缺失响应头），输出是逐条带证据的判定。
- 只做核验：确认存在 / 排除 / 记为待定；利用与载荷投递属于下一阶段。

## 前提与边界
- 全程只发探测请求，不写入、不删改目标数据；需要身份时只用范围里提供的凭据。
- 只碰授权目标；沙箱**可出网**（2026-10-05 起），但依赖公网的模板/外部资源只作线索：目标证据以目标上实测为准。
- 速率由宿主限速（stealth 1/s、standard 5/s、deep 10/s）。**不要**用 `-rate 0` 或 `--min-rate` 顶速；
  被排队是预期行为，不是故障，不重试绕过。
- 每个测试项只给一个结论：要么「命中 + 证据行」，要么「未命中 + 排除依据」，不写「视情况而定」。

## 步骤

> **容器是一次性的**（`--rm`）：`/tmp/cj.txt`（cookie jar）与 `/tmp/ref.html` 等**只在那一条命令内存在**。
> 「登录拿 cookie → 带 cookie 访问受保护页 → 登出 → 再访问」**必须写在同一条命令里**，
> 否则后面的步骤看到的是"cookie jar 不存在"这个假象，而不是真正的会话行为（2026-10-06 实测）。

> **优先用 `pentest_scan`（结构化核验入口）**：它只发读取类请求、不写目标、不下载内容，
> 类别 `active_discovery`——**不需要逐条人工放行**；手写命令走 `pentest_exec` 属 `exploit_validation`，
> **每条都要人类批准**。核验的产出是「成立 / 不成立 / 需要更多证据」+ 证据行，判断依据写在本 skill 的判据里。

| 本 skill 的 WSTG 项 | 用这个 technique | 关键参数 |
|---|---|---|
| 技术栈与响应头 | `http_check` | `check=tech_stack` / `check=security_headers` |
| 会话与 Cookie 属性 | `http_check` | `check=cookies`（只读 Set-Cookie 的 Secure/HttpOnly/SameSite） |
| CORS 策略 | `http_check` | `check=cors_policy`（只发 Origin 头，不带凭证） |
| HTTP 方法暴露 | `http_check` | `check=http_verbs`（只做 OPTIONS/TRACE，**不试 PUT/DELETE**） |
| 错误页信息泄露 | `http_check` | `check=error_disclosure`（随机不存在路径的响应形态） |
| 配置面暴露 | `exposure_check` | `paths=env,git,backup,swagger,actuator`（只报存在性/长度/哈希/形态，不回显内容） |

> 需要**发载荷**的核验（注入、XSS、SSRF、上传…）不属于本阶段：那些是「候选漏洞的验证计划」，
> 交给利用验证阶段逐条人批执行。

### 0. 建立响应基线（先量 soft-404）
```bash
BASE=http://<目标>:<端口>
for i in 1 2 3; do
  curl -sS -o /dev/null -m 8 -w "$i %{http_code} %{size_download} %{redirect_url}\n" "$BASE/__probe-$i$RANDOM"
done
```
期望：三行形如 `1 404 469 `。**判据**：三行 `code`+`size` 一致即得到 soft-404 指纹，后续
`ffuf` 用 `-ac`（自动校准）或显式 `-fc <code> -fs <size>` 复用；三行不一致说明有动态内容，
改用「长度区间 + 关键词」判据（见「判读与去噪」）。

### 1. 认证面（WSTG-ATHN）
```bash
curl -sS -i -m 8 -c /tmp/cj.txt "$BASE/login" \
  -d 'username=admin&password=admin' -o /tmp/login_admin.txt \
  -w 'code=%{http_code} size=%{size_download}\n'
grep -iE '^set-cookie|^location|^retry-after|^x-rate' /tmp/login_admin.txt
```
期望：一次登录尝试的状态码/大小，及是否下发会话 cookie。**判据**：
- 出现「登录成功」信号（302 到后台、下发新会话 cookie）→ 默认口令命中，**立刻停手**，不再枚举。
- 把这次响应与一个已知错误口令的响应对比：两次在 `size`/`Location` 上可区分 → 用户名枚举线索（WSTG-ATHN-04）。
- 没看到 `retry-after` **不能**断定无速率限制；要断言必须连续多次同请求并观察是否出现 429/延迟。

### 2. 会话面（WSTG-SESS）
```bash
curl -sS -i -m 8 "$BASE/" | grep -i '^set-cookie'          # 登录前匿名 cookie
curl -sS -i -m 8 -X POST "$BASE/login" -d 'username=<u>&password=<p>' | grep -i '^set-cookie'
```
期望：`Set-Cookie: <name>=<value>; <属性>`。**判据**：
- 缺 `HttpOnly` → XSS 可读会话；缺 `SameSite`（或 `SameSite=None` 且无 `Secure`）→ CSRF 面。
- 缺 `Secure` **仅在站点为 HTTPS 时**才算缺陷；纯 HTTP 站点本就不带，属设计使然。
- 登录前后会话 ID 值**完全相同** → 会话固定命中；发生变化 → 该项排除。

### 3. 授权面（WSTG-ATHZ）
```bash
curl -sS -o /dev/null -m 8 -w 'anon %{http_code} %{size_download}\n' "$BASE/admin"
curl -sS -o /dev/null -m 8 -b /tmp/cj.txt -w 'auth %{http_code} %{size_download}\n' "$BASE/admin"
for id in 1 2 1001; do
  curl -sS -o /tmp/id_$id -m 8 -b /tmp/cj.txt -w "id=$id %{http_code} %{size_download}\n" "$BASE/api/order?id=$id"
done
```
期望：anon/auth 各一行 `anon <code> <size>`、`auth <code> <size>`；IDOR 循环三行 `id=<n> <code> <size>`。
**判据**：
- `anon` 与 `auth` 都 200 且长度接近 → 未授权访问命中；`anon` 是 302→login、`auth` 200 → 访问控制正常。
- IDOR：用**低权账号**取他人 `id` 得到 200 且返回非本人数据 → 越权命中；全 403/404 → 排除。
- 「非本人」必须由人类确认（或范围材料佐证），否则只记「待定」，避免把共享数据误判为越权。

### 4. 输入面（WSTG-INPV）
```bash
TOK=omp$(date +%s)
curl -sS -m 8 "$BASE/search?q=$TOK%3Cu%3E" -o /tmp/ref.html
grep -c "$TOK" /tmp/ref.html; grep -c "<u>" /tmp/ref.html
curl -sS -o /dev/null -m 8 -w 'true  %{http_code} %{size_download}\n' "$BASE/item?id=1%20AND%201=1"
curl -sS -o /dev/null -m 8 -w 'false %{http_code} %{size_download}\n' "$BASE/item?id=1%20AND%201=2"
```
期望：`grep -c` 输出两个计数（token 出现次数、`<u>` 出现次数）；布尔探针输出 `true <code> <size>` 与 `false <code> <size>` 两行。
**判据**：
- 回显里出现**未转义**的 `<u>`（而非 `&lt;u&gt;`）→ 反射型 XSS 命中；只回显 token 但已编码 → 未命中。
- `AND 1=1` 与 `AND 1=2` 的 `size`/`code` 出现稳定差异 → SQLi 线索（再用 sqlmap 只读确认：
  `sqlmap -u "<URL>" --batch --level=1 --risk=1 --technique=B`）。
- 响应出现数据库报错原文（`SQL syntax`、`ORA-`、`Unclosed quotation`）→ 报错式注入证据。

### 5. 配置面（WSTG-CONF）
```bash
curl -sS -D - -o /dev/null -m 8 "$BASE/" | grep -iE 'strict-transport-security|content-security-policy|x-content-type-options|x-frame-options|referrer-policy|permissions-policy'
curl -sS -i -m 8 -X OPTIONS "$BASE/" | head -3
ffuf -w /usr/share/wordlists/raft-small-directories.txt -u "$BASE/FUZZ" -ac -t 10 -of json -o /tmp/ff.json
jq -r '.results[] | "\(.status) \(.length) \(.input.FUZZ)"' /tmp/ff.json
```
期望：`grep` 打印命中的安全头；`OPTIONS` 返回 `Allow:` 或 405/501；`jq` 按行打印 ffuf 命中（状态/长度/路径）。
**判据**：
- 安全头逐条记录存在/缺失；缺失记「配置缺陷·低危」（HSTS 仅对 HTTPS 站点有意义）。
- `Allow:` 里出现 `PUT`/`DELETE`/`TRACE` → 配置缺陷候选；`501 Unsupported method` → 未实现，不是缺陷。
- ffuf 命中**必须逐条 curl 复核** body：确认是真资源，还是自定义 200 错误页。
- 命中 `/.git/`、`/.env`、`/backup*`、`robots.txt` 的 Disallow 路径 → 附原文证据。

## 判读与去噪
- **soft-404**：「不存在」也返回 200 的页面，必须用第 0 步指纹过滤，否则 ffuf 全是假命中。
- **WAF 干扰**：特征为 403/406/429、`Server: cloudflare`、`cf-ray`、挑战页 HTML、响应时间骤增。
  处置：降到单请求、加真实 UA，记 `blocked-by-waf`；**不要**用编码变形/分片尝试绕过。
- 只做布尔/报错型注入探针；**不做时间盲注**（噪声大、慢，且拖时）。
- 反射探针必须带唯一随机 token，否则会把站点自带内容误判成回显。
- 同一状态码但 body 不同时，以 `size`/关键词为准，不只看 `code`。

## 常见失败
| 现象 | 真实原因 | 处置 |
|---|---|---|
| ffuf 命中一大片 200 | 站点对任意路径都返回 200 的 soft-404 | 用第 0 步基线，开 `-ac` 或 `-fs <size>` |
| curl 连接超时 | 目标不在内网 / 端口写错 | 回 recon 结果核对地址端口；**不要**换外网地址 |
| 请求成片 403/429 | WAF 或 CDN 拦截 | 记 `blocked-by-waf`，降速单发，不绕过 |
| 登录响应看不出成败 | 前端 JS 提交 / 必填 CSRF token | 记「无法自动化核验」，交人类手工或补 token 后重测 |
| OPTIONS 返回 501 | 服务器未实现该方法 | 记「方法不可用」，不要写成配置缺陷 |

## 不做的事
- 不跑 sqlmap 的高危/写文件参数；不投 XSS/SQLi 利用载荷，只用探针 token。
- 不做口令爆破：只试范围里给定的极小默认口令集，命中即停。
- 不探测范围外主机/端口，不用 `-rate 0` 顶速。
- 不做破坏性操作（PUT/DELETE 写入、文件上传、数据修改）。

## 产出（交给下一步）
- 逐项结论：`WSTG 编号 | 目标 URL/参数 | 结论(命中/排除/待定) | 证据(状态码+长度+请求/响应片段)`。
- 覆盖缺口：未测试项及原因（WAF 遮挡/缺凭据/需人类确认）。
- 交给利用阶段的候选：按可利用性排序。

## 参考
- OWASP WSTG：ATHN/SESS/ATHZ/INPV/CONF 各测试项编号与描述。
- OWASP Top 10 2021（A01 访问控制、A03 注入、A07 认证与会话）。
- PayloadsAllTheThings（SQLi、XSS）、HackTricks（Web 章节）。
