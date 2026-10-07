---
name: recon-web-surface
description: 用 curl/ffuf 清点 HTTP/Web 面：站点可达、响应头、标题、robots/sitemap 与目录，并在软 404 基准下给出可复核的命中
whenToUse: 情报收集阶段；范围里出现 http/https 服务、需要枚举站点与路径时；进入漏洞分析前补齐 Web 覆盖
metadata:
  version: 0.1.0
  phase: intelligence-gathering
  sources: [PTES 情报收集, OWASP WSTG-INFO-01, WSTG-INFO-02, WSTG-INFO-03, WSTG-INFO-08, ffuf 官方文档]
  smoked: "沙箱实测@3c49879dd61b：12 块原文照跑，11 块通过；第 6 块本轮修掉——主配方原用 raft-small-directories.txt（纯目录字典，20116 行），产生不了文档声称的 /robots.txt、/index.html 命中（只有空行匹配 /），换成 common.txt + -fs 469 后实测命中 /.git/HEAD、/robots.txt、/index.html；同时修正「镜像没有 whatweb/httpx」的过时前提（两者都在）与两份字典行数（20116 / 4723）。2026-10-06 补工具取舍并实测：dirb 命中 `/.env`、`/.git`、`/.git/HEAD`；katana `-d 2` 抓到 `/` 与 `/page2.html`；wfuzz 跑通（过滤 2561 请求；其 `-f` 输出语法本次未验成，故只写进取舍说明、没写进步骤）"
---

# Web 面清点（recon-web-surface）

## 适用场景
- 情报收集阶段，网络面里已有确认 open 的 HTTP/HTTPS 端口（见 `recon-network-surface`），现在要把「站点与路径」记成可复核的事实。
- 目标是 **清点**，不是找漏洞：参数 fuzz、注入、认证绕过都转给漏洞分析/利用阶段。

## 前提与边界
- 沙箱直连目标；本部署**可出网**（2026-10-05 起）——需要联网的做法（CDN 归属查询、在线指纹库、下载字典）现在都能用，但**外部结果不是目标证据**：标来源，结论以目标实测为准（取不到时的退化路径见第 8 步）。
- 镜像里有 `curl`、`ffuf`、`python3`，**也有 `whatweb`（0.5.5）与 `httpx`（ProjectDiscovery）**（2026-10-06 实测）。本技能的指纹步骤仍以 `curl` 读头 + 标题 + 特征路径为主：输出小、可逐条落到证据里；`whatweb`/`httpx` 作为**补强**（一次覆盖多特征、出 TechDetect 列表），用了就把原始输出另存进 `/tmp` 并记进证据，别只贴一行结论。
- 目标地址用**选择器给的那份已裁决地址**，不要自己解析域名。
- 自由命令的 shell **是 bash**（2026-10-06 起；此前是 Debian 的 dash，`$RANDOM`、`<(...)` 一类都会炸）。`$RANDOM`、进程替换、数组都能用。
- 速率由宿主按行为预设（stealth 1/s、standard 5/s、deep 10/s）。命令里**不要**加 `--min-rate` 类参数去顶；被排队是预期行为。
- 本技能只发 **GET / HEAD / OPTIONS** 这类只读请求。任何写方法（PUT/POST 写、DELETE）与目录递归爆破都越界。

## 步骤

> **容器是一次性的**（`--rm`）：`/tmp/web-ffuf.json` 等中间产物**只在那一条命令内存在**。
> 本技能里「先爆破落盘、再 `jq` 复核」是同一件事的两端——**必须写在同一条命令里**
> （`ffuf … -o /tmp/web-ffuf.json && jq … /tmp/web-ffuf.json`），否则复核那一步会拿到空文件（实测）。

> **优先用 `pentest_recon`，不要手写 curl/ffuf。** 它把命令形态固定在服务端、参数只有枚举与整数、
> 只打**已裁决地址**，类别 `active_probing`——**不需要逐条人工放行**；手写命令走 `pentest_exec`
> 是 `active_probing`，**免批**（命令原文不再经人过目）。本 skill 只在需要未覆盖选项时才落到 ```bash 形态。

| 本 skill 的步骤 | 用这个 technique | 关键参数 |
|---|---|---|
| 1 可达性与状态码 | `http_probe` | `port=…`、`scheme=auto`、`collect=headers` |
| 2 响应头与指纹 | `http_probe` | `collect=tech`（技术栈推断 + 关键响应头） |
| 2b 安全响应头 | `http_probe` | `collect=security_headers`（六个头的有无） |
| 4 robots / sitemap | `http_probe` | `collect=robots` 或 `collect=sitemap` |
| 6 目录/文件枚举 | `content_discover` | `wordlist=common_dirs`、`extensions=none`、`rate=5` |
| 7 命中复核与富化 | `http_probe` / `web_crawl` | `collect=tech`；`depth=2 max_pages=100` |

### 1. 站点可达性与状态码
```bash
curl -sS -m 10 -o /dev/null \
  -w 'code=%{http_code} size=%{size_download} type=%{content_type} redirect=%{redirect_url}\n' \
  http://<目标>:<端口>/
```
期望：`code=200 size=484 type=text/html redirect=`。
判据：拿到 2xx/3xx 即「站点存在」。状态码分类：

| 码 | 含义 | 记法 |
|---|---|---|
| 2xx | 端点存在 | 计入资产 |
| 3xx | 重定向，读 `Location` | 目标路径也算线索 |
| 401 / 403 | 存在但受限 | 计入资产，**不尝试绕过** |
| 404 | 不存在 | 排除 |
| 405 / 501 | 方法不被接受 | 端点存在；换 GET |
| 5xx | 服务端报错 | 端点存在但异常，记下 |

connection refused / timeout 不算「不存在」，见「常见失败」。

### 2. 响应头与指纹（whatweb 类手法）
```bash
curl -sS -m 10 -D - -o /dev/null http://<目标>:<端口>/
```
期望：`HTTP/1.0 200 OK` + `Server:` / `Content-type:` / 可能的 `X-Powered-By:` / `Set-Cookie:` / `X-...` 安全头。
判据：把 `Server` 原文（截断到 120 字符）作为证据。**`Server` 头可被伪造**，只能当线索，不能当版本结论；与 `recon-network-surface` 的 nmap 指纹冲突时两条都记。

```bash
curl -sS -m 10 -X OPTIONS -D - -o /dev/null http://<目标>:<端口>/ | grep -i '^allow:'
```
期望：`Allow: GET, HEAD` 之类。
判据：有 `Allow` 说明方法被显式声明；返回 501（如 `SimpleHTTP` 实测）**不代表端点不存在**，只是该实现不支持 OPTIONS。
> `HEAD` 与 `GET` 头可能不同；某些服务不支持 HEAD（返回 405/501），此时一律回退到上面的 `GET -D -`。

### 3. 标题与正文摘要
```bash
curl -sS -m 10 http://<目标>:<端口>/ | grep -io '<title>[^<]*</title>' | head -n1
```
期望：`<title>DCG 实验室靶站</title>`。
判据：标题不同往往意味着不同应用/虚拟主机，是资产切分的依据；没有标题是正常现象，不是故障。

```bash
curl -sS -m 10 http://<目标>:<端口>/ | sha256sum
```
判据：同样的 `sha256` = 同一份页面。批量比对时用它去重，避免把同一个兜底页当成多个资产。

### 4. robots / sitemap / 安全策略文件
```bash
for p in robots.txt sitemap.xml sitemap_index.xml .well-known/security.txt; do
  printf '%-28s ' "$p"
  curl -sS -m 10 -o /dev/null -w 'code=%{http_code} size=%{size_download}\n' "http://<目标>:<端口>/$p"
done
```
期望：该端点存在时 `code=200 size>0`。
判据：`200` 且 `size>0` 才算存在并把正文记入证据。**robots 里 `Disallow:` 的路径只是声明，不是事实**——实测靶标 robots 写了 `Disallow: /private/`，而 `/private/` 实测 404。以实测为准。

```bash
curl -sS -m 10 http://<目标>:<端口>/robots.txt
```

### 5. 软 404 基准（先做，不做就会淹死）
```bash
for s in zz-nope-7f3a aa-random-xyz non-existent-404 do-not-exist-9f3a; do
  curl -sS -m 10 -o /dev/null \
    -w "%{http_code} %{size_download}\n" "http://<目标>:<端口>/$s"
done
```
期望：多条随机路径返回**同一组** `code size`（实测 `404 469`）。
判据：出现稳定重复的 `code size` → 它就是软 404 签名，后面爆破用 `-fs <该字节数>` 过滤。若随机路径返回 **200 且长度稳定**，说明是 SPA/兜底路由：必须按长度或正文正则过滤，**不能按状态码**。
> 每次换目标或换路径层级都要重取基准；长度只差 1–2 字节通常是动态内容（时间戳、CSRF token），此时改用 `-fr` 正则而不是 `-fs`。

### 6. 目录/文件枚举（保守并发）
```bash
ffuf -u http://<目标>:<端口>/FUZZ \
  -w /usr/share/wordlists/common.txt \
  -t 5 -p 0.2 \
  -fs <第 5 步的软 404 字节数> \
  -of json -o /tmp/web-ffuf.json -s
```
期望：命中行形如 `/.git/HEAD`、`/robots.txt`、`/index.html`（2026-10-06 在静态靶站上就是这么命中的）。
判据：`-fs` 已滤掉软 404，剩下的每条都用第 7 步复核后才算资产。
注意事项（都是实测得到的）：
- **本版本 ffuf v1.1.0 没有 `-rate`**，写 `-rate 5` 会直接报 `flag provided but not defined: -rate`。限速只能用 `-t`（并发）与 `-p`（每请求延迟）。
- `common.txt` 共 **4723** 行（含扩展名的文件与目录混合字典），`-t 5 -p 0.2` 实测几分钟内跑完。
- **想跑大字典再换 `raft-small-directories.txt`（20116 行）——但它是纯目录字典，没有文件项**：2026-10-06 实测它一条文件命中都产生不了（只有空行匹配到 `/`）。要用它必须配 `-e .txt,.html,.php` 之类扩展名，或另接文件字典；跑完约 25–30 分钟，时间紧就 `head -n 2000` 截断并在覆盖说明里写明。
- 备选：`-ac`（自动校准）也能去掉软 404，但显式 `-fs` 的判据更可解释、更方便复核，优先用它。
- 需要探文件扩展名时用 `-e .txt,.bak,.zip`；**不要**用 `-recursion` 无限递归——除非人类明确授权并给出深度。
- **同类工具的取舍（判据相同，选一个用到底）**：`dirb`（最简；实测在本题靶命中 `/.env`、`/.git/HEAD`）、
  `wfuzz`（过滤语法强，适合复杂判据）、`dirsearch`（字典与统计最全，`-at SIMPLE` 那类参数与它无关）。
  **不要**为了"更全"把四个都跑一遍——每个都在打目标，每个都算一次动作。
- **需要 JS 感知的爬取**（现代前端、单页应用）时用 `katana -u <目标> -silent -d 2`（实测抓到 `/`、`/page2.html`）；
  `gospider` 更快但只看静态链接；结构化通道的 `web_crawl` 是同一条链的免审批版本，先考虑它。

### 7. 命中复核与富化
```bash
jq -r '.results[].url' /tmp/web-ffuf.json | while read -r u; do
  printf '%s\t' "$u"
  curl -sS -m 10 -o /dev/null \
    -w 'code=%{http_code} size=%{size_download} redirect=%{redirect_url}\n' "$u"
done
```
期望：每行 `URL code=... size=... redirect=...`。
判据：`size` 与软 404 基准不同、或 `code` 是 200/401/403 → 记为资产。重定向到登录页/主页的路径要标「疑似兜底路由」，不要当成独立功能。
可选：对命中逐个取标题，区分真实应用页与通用页。
```bash
jq -r '.results[].url' /tmp/web-ffuf.json | while read -r u; do
  printf '%s -> ' "$u"; curl -sS -m 10 "$u" | grep -io '<title>[^<]*</title>' | head -n1; echo
done
```

### 8. 需要外网时的退化
以下在沙箱**不可达**，不要反复重试：在线指纹库/CDN 归属、CVE 站点、下载额外字典、外部 DNS。
退化顺序：① 改用人类在控制台提供的材料（页面副本、指纹、字典）；② 只用镜像内已有字典；③ 用记忆中的公开信息作线索，但必须标注 `[INFERENCE]`，不得写成已验证事实。

先确认外网**确实不可达**（而不是目标侧拒绝），再退化：
```bash
timeout 5 curl -sS -o /dev/null -w '%{http_code}\n' http://example.invalid/ ; echo "exit=$?"
```
**期望**：`Could not resolve host` 或 `Couldn't connect to server`，退出码 6 / 7。
**判据**：exit 6/7 → 外网不可达，按下面顺序退化；**拿到任何 HTTP 状态码即说明有出口**——那就别退化，按正常路径继续并记录来源。

**期望**：退化后仍给出「已获得什么、还缺什么、来源是谁」三段结论。
**判据**：① 来自人类材料的按原样引用；② 来自镜像内工具/字典的标出工具名与字典名；③ 记忆里的公开信息必须标 `[INFERENCE]` 且不得写成已验证事实。三者混在一句里无法追溯来源时，拆开写。

## 判读与去噪
- **200 ≠ 页面存在**：软 404 会拿 200 返回通用页，必须先有第 5 步的基准。
- 3xx 的 `Location` 指向登录页/主页，通常是框架兜底路由，不是独立资产。
- `Server` 头、`X-Powered-By` 都可伪造；与真实指纹冲突时并列记录。
- ffuf 结束时的 `WARN`/错误计数很重要：大量错误 = 并发被限速器排队或目标不稳，先降 `-t`、加 `-p`，**不要**加高频参数硬顶。
- 401/403 是资产不是噪音，但处理方式留给漏洞分析阶段。
- 目录列表（`SimpleHTTP` 式）与真实应用要分开记录：前者是配置问题，后者才是应用面。

## 常见失败
| 现象 | 真实原因 | 处置 |
|---|---|---|
| 全部 timeout / connection refused | 目标没接进 `internalNetwork`，或端口未监听 | 报告不可达，请人类确认；**不要**改用外网地址 |
| `https://` 报 `wrong version number` | 该端口是明文 HTTP（实测靶标即如此） | 换 `http://`；TLS 判据见 `recon-dns-cert` |
| ffuf 报 `flag provided but not defined: -rate` | 镜像里是 ffuf v1.1.0 | 用 `-t` + `-p` 限速，删掉 `-rate` |
| 命中一大堆同 `code`+同 `size` | 软 404 没过滤 | 回到第 5 步取基准，用 `-fs` 或 `-fr` |
| ffuf 跑得远比预期慢 | 宿主按行为预设排队 | 正常现象，别重试、别拆命令、别加高频参数 |
| 随机路径也返回 200 | SPA/兜底路由 | 按长度/正文正则过滤，状态码失去判别力 |
| robots 里 Disallow 的路径 404 | robots 只是声明 | 以实测为准，robots 仅作线索 |

## 不做的事
- 不做登录爆破、不做参数 fuzz/注入探测（`ffuf -d` POST、sqlmap 等），那是漏洞分析/利用阶段。
- 不用写方法（PUT/DELETE/POST）改目标状态；本阶段全部只读。
- 不做无限递归、不做全端口/全 vhost 越界枚举；要扩大范围先请人类修订。
- 不投载荷、不触发上传/命令执行类端点。

## 产出（交给下一步）
- Web 资产条目：`URL`、状态码、`Server`、标题、`Content-Type`、是否受限（401/403）。
- 软 404 基准：`code` + `size`（或正文正则）签名，供后续阶段复用。
- 命中清单：路径、状态码、长度、重定向目标、证据（curl 原文一行）。
- 覆盖说明：用了哪份字典（行数）、并发/延迟、跑了多久、哪些没跑（及原因）。
- 未决线索：可疑 vhost、受限端点、指纹冲突项。

## 参考
- PTES：Intelligence Gathering。
- OWASP WSTG-INFO-01（信息收集）、WSTG-INFO-02（Web 服务器指纹）、WSTG-INFO-03（Web 服务器元文件）、WSTG-INFO-08（Web 框架指纹）。
- ffuf 官方文档与示例（matcher/filter 语义）。
- RFC 9309（robots.txt 规范）。
- 姊妹技能：`recon-network-surface`（端口与 banner）、`recon-dns-cert`（解析与证书）。
