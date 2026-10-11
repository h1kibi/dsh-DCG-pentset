---
name: recon-web-surface
description: 用 curl/ffuf 清点 HTTP/Web 面：站点可达、响应头、标题、robots/sitemap 与目录，并在软 404 基准下给出可复核的命中
whenToUse: 情报收集阶段；范围里出现 http/https 服务、需要枚举站点与路径时；进入漏洞分析前补齐 Web 覆盖
metadata:
  version: 0.1.0
  phase: intelligence-gathering
  sources: [PTES 情报收集, OWASP WSTG-INFO-01, WSTG-INFO-02, WSTG-INFO-03, WSTG-INFO-08, ffuf 官方文档]
  smoked: "沙箱实测@19cd12b3b93c：（2026-10-11 第八轮，对 SPA 夹具 docker/lab-spa 172.29.0.2:8080）①逐路由 chunk 抽取：`collect=endpoints page=/admin include_chunks=true` → `page: /admin`、`endpoints_page: /admin`、引用 11 条 chunk **全抓**（上限 24 条）、`endpoints_kind_counts: chunk=122, page=11`，命中带来源 `/api/admin/entry kind=quoted@/static/chunks/admin-1.js hits=2`；②批量复核（查询串 + 分命名空间基准 + 方法表）：`paths=/api/submissions,/api/submissions?mine=1,/api/run,/api/nope,/lists/xyz,/lists/mine,/nope probe_options=true` → 三条基准 `ns=/api/ status=404 size=22`、`ns=/lists/ status=200 size=1241`、`ns=/ status=404 size=8522`；`?mine=1` 判 ok/200/size=10 而**不带**是 size=2（结论性差异可见）；`/lists/xyz` 用**自己的**命名空间基准判 soft404（只用根基准会误判为 ok）；`/api/run` 从 GET 的 405 拿到 `allow=POST`、`/api/submissions` 从 OPTIONS 拿到 `allow=GET, POST, PUT, DELETE`，汇总 `method_tables=3 baselines=3 verbs_probed=7`；③速率对账：`content_discover rate=5 entry_range=1-60` → `rate_check: declared_rps=5 observed_rps=5.0 threads=5 per_thread_delay_s=1.00 verdict=ok`（60 请求 12.0s；旧配方同参数实测 25 req/s）。（2026-10-06 首轮对 fx-web 的 12 段配方实跑记录见 git 历史。）；**第八轮质检后复跑（同一夹具）**：`/waf/thing` 的命名空间基准被 WAF 断连 ⇒ **回退到根基准**判 `soft404`（`baseline_ns=/`）——修前会误写成 `ok`+`candidate_endpoint`（把兜底路由当端点）；全断连模式（`LABSPA_REFUSE_SOFT404=1`）下一个基准都采不到 ⇒ 该行标 `no_baseline`、`candidates=0 no_baseline=1` 并给 `paths_warning`（**不可判定不许装成判过**）；`>|`/引号内字面量/`2>`/`tee` 当参数四类形态的抑制判据已收紧（证据：`test/evidence-sink.test.ts`）"
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
- 速率由宿主按行为预设（stealth 1/s、standard 5/s、fast 10/s）。命令里**不要**加 `--min-rate` 类参数去顶；被排队是预期行为。
- 本技能只发 **GET / HEAD / OPTIONS** 这类只读请求。任何写方法（PUT/POST 写、DELETE）与目录递归爆破都越界。

## 步骤

> **容器是一次性的**（`--rm`）：`/tmp/web-ffuf.json` 等中间产物**只在那一条命令内存在**。
> 本技能里「先爆破落盘、再 `jq` 复核」是同一件事的两端——**必须写在同一条命令里**
> （`ffuf … -o /tmp/web-ffuf.json && jq … /tmp/web-ffuf.json`），否则复核那一步会拿到空文件（实测）。

> **优先用 `pentest_recon`，不要手写 curl/ffuf。** 它把命令形态固定在服务端、参数只有枚举与整数、
> 只打**已裁决地址**，类别 `active_probing`——**不需要逐条人工放行**（**① 阶段的阶段性事实**：④⑤ 阶段同一模板提升为逐条人批）；手写命令走 `pentest_exec`
> 是 `active_probing`，**免批**（命令原文不再经人过目）。本 skill 只在需要未覆盖选项时才落到 ```bash 形态。

| 本 skill 的步骤 | 用这个 technique | 关键参数 |
|---|---|---|
| 1 可达性与状态码 | `http_probe` | `port=…`、`scheme=auto`、`collect=headers` |
| 2 响应头与指纹 | `http_probe` | `collect=tech`（技术栈推断 + 关键响应头） |
| 2b 安全响应头 | `http_probe` | `collect=security_headers`（六个头的有无） |
| 4 robots / sitemap | `http_probe` | `collect=robots` 或 `collect=sitemap` |
| 6 目录/文件枚举 | `content_discover` | `wordlist=common_dirs`、`extensions=none`、`rate=5`；要枚举子路径再加 `path=api` |
| 6b API 路由枚举 | `content_discover` | `wordlist=api_endpoints`（条目自带 `api/` 前缀，**站点根直接用**）；或通用字典 + `path=<你的前缀>`；`quickhits` 找高价值小文件 |
| 7 命中复核与富化 | `http_probe` / `web_crawl` | `collect=tech`；`depth=2 max_pages=100` |
| 7b 端点/路由抽取 | `http_probe` | **`collect=endpoints`**：固定三种形态（href/src/action、引号内绝对路径、fetch/axios 第一实参），短行带 hits；**默认 `include_chunks=true` 会跟随同主机的 `.js` 再抽一遍**——SPA（Next.js/Vite）的路由**常常只在 chunk 里**（实测：首页 20 条，chunk 另有 11 条 `/api/*`，字典枚举全部漏掉） |
| 7c 批量路径状态复核（已知 60 条里哪些是真端点） | `http_probe` | **`paths=/a,/b,…`**（≤60 条逗号分隔，**可带查询串** `/api/x?mine=1`）；软 404 基准**按命名空间各取一条**，同形即标 `soft404`；`allow` 列给未鉴权方法表 |
| **7d SPA/Next.js 逐路由收 API 路径（本会话最大摩擦的正解）** | `http_probe` | **`page=/那条路由` + `collect=endpoints`**：抽取与 chunk 跟随都换成这一页——路由自己的 chunk 才含 API 调用（实测每条路由自带 8–11 个 chunk）；逐路由调 14 次 ≫ 手写 14 段 `for p in …; do curl; grep; done` |
| **2c 未鉴权方法表清点（零写请求、高产）** | `http_probe` / `http_check` | `probe_options=true`（对每条路径**额外**发只读 OPTIONS 读 `Allow`）或 `check=http_verbs`（根路径 OPTIONS+TRACE）；**405 响应的 `Allow` 头也算**——`paths=` 的第 7 列就能拿到 |
| 6c 大字典分段（一次跑不完就分次拼） | `content_discover` | **`entry_range=1-2000`**（1 基双闭区间；空=整本）；返回的 `coverage:` 行自证 `entries_attempted/entries_truncated/position/entries_remaining` |
| 8 配置面暴露核查 | `exposure_check` | `paths=git,env,swagger,openapi,actuator,server_status,phpinfo,web_config,dockerfile`（逗号分隔，≤10；**项名**不是路径） |
| 9 基线核验（头/Cookie/CORS/方法/错误泄露） | `http_check` | `check=security_headers` / `cookies` / `cors_policy` / `http_verbs` / `error_disclosure` |

**第 8/9 行的姿态比手写 curl 更严，优先用它们**：`exposure_check` 只报**存在性、长度、哈希与形态判定**（自带随机对照路径，与对照同形即判"通配页/软 404"），`http_check` 只报有无与取值——**两者都从不回显正文**。手写 `curl` 很容易把响应体写进证据，那在"仅核查配置面是否暴露"这类任务上是不必要的内容采集。
**适用阶段**：情报收集用它**记录事实**（"这个路径存在、长度 X、形态像 swagger"）；"这条暴露成不成立/要不要报"属漏洞分析阶段的判定，别在这里下结论。

**两条新通道的分工（2026-10-11 操作者诉求 #3/#4，别把它们的用途搞反）**：

- **发现 vs 复核**：`collect=endpoints` 与 `content_discover` 负责**发现**新路径；`http_probe paths=/a,/b,…` 负责**复核**你手里那份清单（"这 60 条里哪些是真端点、哪些只是兜底路由"）。**`paths=` 不能替代发现**——它的输入是你已有的路径集合，集合之外的东西它一条也看不见；反过来，拿字典枚举去确认 60 条已知路径既慢又（大字典时）跑不完。
- **`paths=` 的判据**：每条只发一次 **GET**，逐条回 `path<TAB>status<TAB>size<TAB>content_type<TAB>note<TAB>baseline_ns<TAB>allow`；容器**按命名空间各取一条随机路径**作软 404 基准（页面 404 与 API 404 常不同形：运营者真实目标实测 `text/html` 8596B vs `application/json` 22B；本仓库夹具是 8522B），**与同命名空间基准的状态码或长度任一不同**才算候选端点（另有 `candidate_endpoint:` 短行可直接引用）。同形 ⇒ `note=soft404`：该命名空间对不存在的路径也回同一份响应（SPA/兜底路由），**别读成「端点存在」**。汇总 `paths_summary: paths=N responded=M no_response=K candidates=C method_tables=J baselines=B`：`responded`＝**拿到响应**的条数（含被判 `soft404` 的），**确认的候选看 `candidates=`**（或 `note=ok` 的行）；`no_response` 是"请求没打通"（超时/被拒/连接重置），**不是"不存在"**，不得混进报告的"未开放"；出现 `no_baseline=` 时这些行**不可判定**（连祖先基准都没采到）——看 `paths_warning`，别把 `responded` 当端点确认数。
- **`paths=` 的参数纪律**：逗号分隔的**绝对路径**、≤60 条、**不得含 scheme/主机/空格**（递了会被 exit 2 明确拒绝——那是把"路径"当"目标"用，范围裁决针对目标，混进来会让范围记账失效）；也不接受片段 `#` 与路径里的 `..` 段。**可以带查询串**（`/api/submissions?mine=1`、`/api/x?a=1&b=2`）：查询串字符集只含字母数字与 `. _ ~ % = & : @ / + [ ] -`，`$`、引号、反斜杠、`{ }`、`< >`、`|`、`;` 一律不放行——**这是结论性验证的唯一结构化通道**（"`?mine=1` 与不带是不是两个结果"这类判据别再退回手写 curl）。
- **`content_discover` 的覆盖度**：返回里 `coverage:` 一行自证 `wordlist_entries / entries_total / entry_range / requested / entries_attempted / entries_truncated / entries_remaining / position / reason`。**`entries_truncated=true` 时 hits 只能当下界读**（旧版摘要里看不出这一点，正是"跑了一半"被读成"全站干净"的成因）。大字典跑不完是**数学**不是故障：`common_dirs` 4723 条按 5 请求/秒需 ~945s，而单条命令的墙钟上限（`content_discover` 的模板超时，见能力快照/模板声明，不在这里手抄）远小于它 ⇒ 摘要会直接给出「**需要分 N 段**」与具体区间；照它用 `entry_range=` 依次调用即可拼完整本字典（每次返回都自证"从第几条跑到第几条"）。

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

### 2c. 未鉴权方法表清点（**零写请求**，本会话最值钱的一步）
```bash
# 逐端点：对每条已知路径发只读 OPTIONS，读 Allow（结构化通道，输出进审计）
#   pentest_recon technique=http_probe target_selector=… port=… probe_options=true \
#     paths=/admin,/run,/lists,…
# 单路径：只抽这一条的 Allow
curl -sS -m 10 -X OPTIONS -D - -o /dev/null http://<目标>:<端口>/admin | grep -i '^allow:'
```
期望：`allow=GET, HEAD, POST, PUT, DELETE`（或 `method_table: /admin allow=POST,PUT,DELETE` 短行）。
判据：**405 与 OPTIONS 的 `Allow` 头在未鉴权下就给出完整方法表**——实测用它一次拿到 20 条写端点的 `POST/PUT/DELETE`，**一个写请求都没发**。这是**清点**（"这个端点接受哪些方法"），不是利用：
- 拿到方法表**只记事实**，写方法一律不发（PUT/DELETE 属利用类动作，要向人类逐条申请）；
- `Allow` 缺失（`missing`）与 501 都不是"端点不存在"——只是该实现没声明；
- `paths=` 的第 7 列 `allow` 顺带给出同一信息（GET 的 405 响应常带），**不必为清点再跑一轮**。

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
- **本版本 ffuf v1.1.0 没有 `-rate`**，写 `-rate 5` 会直接报 `flag provided but not defined: -rate`。限速只能用 `-t`（并发）与 `-p`（**每线程**请求间隔）。
- **`-p` 是"每线程"间隔，不是"整体"间隔**（2026-10-11 实测，最容易算错的一条）：整体速率 ≈ `线程数 ÷ 延迟`。`-t 5 -p 0.2` 实测 **25 req/s**（不是 5），`-t 5 -p 1.0` 才是 5 req/s，`-t 1 -p 1.0` 是 1 req/s。想按声明速率（stealth 1/s、standard 5/s、fast 10/s）跑，用 `-t <r> -p 1.0` 或 `-t <r×0.5> -p 0.5` 这类**等价比**，别把 `-p` 理解成全局间隔。
- 走结构化通道（`content_discover`）时这件事由服务端保证：它按 `delay = threads/rate` 下发，并在报告里逐轮对账 `rate_check: declared_rps=… observed_rps=… verdict=ok|over`。**看到 `verdict=over` 就按实测值重排预算**（"声明 5/s 而实际 22/s"曾让整段预算差 4 倍）。
- `common.txt` 共 **4723** 行（含扩展名的文件与目录混合字典），`-t 5 -p 0.2` 实测几分钟内跑完。
- **想跑大字典再换 `raft-small-directories.txt`（20116 行）——但它是纯目录字典，没有文件项**：2026-10-06 实测它一条文件命中都产生不了（只有空行匹配到 `/`）。要用它必须配 `-e .txt,.html,.php` 之类扩展名，或另接文件字典；跑完约 25–30 分钟，时间紧就 `head -n 2000` 截断并在覆盖说明里写明。
- 备选：`-ac`（自动校准）也能去掉软 404，但显式 `-fs` 的判据更可解释、更方便复核，优先用它。
- 需要探文件扩展名时用 `-e .txt,.bak,.zip`；**不要**用 `-recursion` 无限递归——除非人类明确授权并给出深度。
- **同类工具的取舍（判据相同，选一个用到底）**：`dirb`（最简；实测在本题靶命中 `/.env`、`/.git/HEAD`）、
  `wfuzz`（过滤语法强，适合复杂判据）、`dirsearch`（字典与统计最全，`-at SIMPLE` 那类参数与它无关）。
  **不要**为了"更全"把四个都跑一遍——每个都在打目标，每个都算一次动作。
- **需要 JS 感知的爬取**（现代前端、单页应用）时用 `katana -u <目标> -silent -d 2`（实测抓到 `/`、`/page2.html`）；
  `gospider` 更快但只看静态链接；结构化通道的 `web_crawl` 是同一条链的免审批版本，先考虑它。

### 6b. API 路由枚举（基准路径 + 命名字典）
```bash
# A. 命名字典（条目自带 api/ 前缀，站点根直接跑）
ffuf -u http://<目标>:<端口>/FUZZ -w /usr/share/wordlists/api-endpoints.txt \
  -t 5 -p 0.05 -ac -of json -o /tmp/api-named.json -s
# B. 通用字典 + 基准路径（枚举 /api/ 下的文件；前缀按页面/JS 里读到的实际层级换）
ffuf -u http://<目标>:<端口>/api/FUZZ -w /usr/share/wordlists/common.txt \
  -t 5 -p 0.05 -ac -of json -o /tmp/api-prefix.json -s
```
期望：命中行形如 `/api/auth`（301，目录）、`/api/.config`（200）——**路径存在**即可入账为面。
判据：`-ac` 已滤掉软 404；301/401/403 只证明**路由存在**，不得写成"存在漏洞"，按第 7 步复核后再下结论。
注意事项：
- **先看字典有没有自带前缀再决定要不要拼前缀**：`api-endpoints.txt` 的条目就写作 `api/auth/login`，**站点根**跑它就会打 `/api/...`；再套一层 `/api/FUZZ` 会变成 `/api/api/...`（实测 0 命中）。不带前缀的字典（`common.txt` / `quickhits.txt`）才需要你在 URL 里拼 `/api/`。
- 结构化通道一步到位：`content_discover` 的 `wordlist=api_endpoints`（配 `path=` 空）或 `wordlist=common_dirs` + `path=api`（两侧斜杠会归一，`..` 段与查询串会被拒）。
- 关掉 `/openapi.json`、`/docs` 的目标没有接口清单可用，字典命名枚举是**主通道**——不要因为文档 404 就放弃面测绘。
- 命中数少不代表没有面：换前缀层级（`/api/v1/`）、换字典（`quickhits.txt` 找 `.env`/`.git/HEAD`）各跑一轮，并把"跑过哪些前缀/字典"写进覆盖说明。
- 单层级跑完不命中时如实写"未覆盖"——**不要**把 `/api/FUZZ` 的结果冒充全站枚举。

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

### 7d. SPA/Next.js：**逐路由**收 API 路径（本会话最大的摩擦，也是唯一高产出路径）
目标站是 Next.js/Vite 这类 SPA 时：**字典枚举近乎无效**（实测 268 条只命中 1 条），而每条路由**自己的 chunk**
里成组写着 API 调用（实测 `/admin`、`/run`、`/lists` 各带 8–11 个 `/api/*`）。抽取器**只跟被取页面引用的 chunk**
（上限 24 条 / 每条 256KiB / 合计 1MiB），所以关键是**一页一页地取**——`page=` 就是干这个的：

```bash
# 取一条路由的页面，并列出它引用的 chunk（真实形态：/_next/static/chunks/…）
curl -sS -m 10 'http://<目标>:<端口>/admin' \
  | grep -oE '(src|href)="[^"]*\.js[^"]*"' | cut -d'"' -f2 | sort -u
# 再逐块抽 API 调用（注意：chunk 必须与页面在**同一条命令**里取——容器是一次性的）
for c in $(curl -sS -m 10 'http://<目标>:<端口>/admin' \
             | grep -oE '(src|href)="[^"]*\.js[^"]*"' | cut -d'"' -f2 | sort -u); do
  echo "== $c"
  curl -sS -m 10 "http://<目标>:<端口>$c" \
    | grep -oE '"/api/[a-zA-Z0-9_/-]+"' | sort -u
done
```
期望：页面的 chunk 列表（几条到十几条）+ 每块里 `"/api/..."` 的字面量（**成组出现**，这是 SPA 的正常形态）。
判据：把这些 `/api/*` 去重后**逐条复核**（判据 = 各自的 HTTP 状态码：2xx/401/403/405 都算存在，与软 404 基准同形的不算）——实测一口气拿到 **38 条、38/38 全部存在**。
**优先用结构化通道**（等价但自带 provenance 与逐条核账，且不用手写 grep——手写 grep 抽路由的失败是**静默**的，见「常见失败」）：
```
pentest_recon technique=http_probe target_selector=… port=… collect=endpoints include_chunks=true page=/admin
pentest_recon technique=http_probe target_selector=… port=… collect=endpoints include_chunks=true page=/run
…（每条路由一次；`endpoints_page:` 行自证抽的是哪一页，命中带 `kind=quoted@<chunk 路径>`）
```
**不要把 14 条路由写成 14 段 bash 循环**：结构化调用同样便宜、还能逐条核账。
**`page=` 与 `paths=` 的分工**：`page=` 负责**发现**（抽取这一页的 chunk 里的路径），`paths=` 负责**复核**（把拿到的那批路径逐条判真伪）。顺序是先 7d 再 7c。

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
| `grep -oE '[a-zA-Z0-9_\-/]...'` 报 `Invalid range end`，而 stdout 是空的 | ERE 的字符类里**反斜杠不是转义符**：`\`→`/` 成了**倒置区间**；而命令写成 `… | grep … | head` 时**管道末尾把 rc 掩成 0** | ① 修区间（把 `-` 放末尾：`[a-zA-Z0-9_/-]`）；② 抽端点/路由**直接用 `http_probe collect=endpoints`**（服务端固定形态，空结果会自我解释）；③ 非用 grep 不可时加 `set -o pipefail`，别让 rc 被尾巴吃掉 |
| `curl … | head -30` 输出里塞进几百行内容 | 响应体是**一整行**（RSC/JSON/压缩后文本）：`head` 按**行**截断，单行内容它一条都不切 | 按**字节**截：`cut -c1-400`、`fold -w 200`；或走结构化通道（`collect=endpoints` / `http_check`），它们的输出天然是短行 |
| `grep -oE '[一-龥]+'` 报 `Invalid collation character`（**rc=2**，管道里像"没命中"） | **不是 locale**（容器已是 `C.UTF-8`）：GNU grep 3.8 拒绝**多字节字符区间** | 中文抽取别用区间：`grep -oP '\p{Han}+'`（实测可用），或 `python3 -c "import re,sys;print(' '.join(re.findall(r'[\u4e00-\u9fff]+', sys.stdin.read())))"`。`LC_ALL=C` 能让区间"过"，但那只是退化成字节匹配，别依赖 |
| `content_discover` 的命中数看着"结论完整"，其实只跑了半本字典 | 单条命令被 ffuf 的 `-maxtime` 截断，而**旧摘要里看不见**（上游 JSON 有 `maxtime`/`position`，摘要里没有） | 看 `coverage:` 行的 `entries_truncated=` / `position=` / `entries_remaining=`；`entries_truncated=true` 时 hits 只当下界，按 `schedulability:` 给的区间用 `entry_range=` 续跑拼完 |
| 60 条路径只能写 `for p in …; do curl …; done` 逐条确认，输出没法核账、也进不了审计 | 没有批量复核通道 | 用 `http_probe paths=/a,/b,…`：逐条 `path<TAB>status<TAB>size<TAB>content_type<TAB>note<TAB>baseline_ns<TAB>allow` + **分命名空间**的软 404 基准；`note=soft404` 是兜底路由，`no_response` 是没打通 |
| 递进去的 `paths=` 报 `usage_error`（含 scheme/主机/空格） | 那是把"路径"当"目标"用，服务端**有意**拒绝（否则范围记账失效） | 只给绝对路径（`/api/users`，**可带 `?k=v`**）；要打另一个主机就换 `target_selector` 重新走范围裁决 |
| SPA 上字典枚举几乎全灭（268 条只中 1 条），而页面里明明有大量 `/api/` 调用 | 路由**只在 chunk 里**，而抽取器只跟**被取页面**引用的 chunk——默认取的是 `/` | 逐路由调 `http_probe collect=endpoints page=/admin`（第 7d 步）；一次调用一条路由，命中带 `@<chunk 路径>` |
| 抽出来的路径成堆但不知道哪些是真的 | 抽取只是"页面上写了" | 用 `paths=` 批量复核（第 7c 步）：每条 GET + 分命名空间软 404 基准，`note=soft404` 的剔除 |
| 按声明速率排的预算差好几倍（声明 5/s、实测 22/s） | ffuf 的 `-p` 是**每线程**间隔 ⇒ 实际 ≈ `线程数 ÷ 延迟`（旧公式 `1/rate` 配 `-t rate` 打出 `rate²`） | 走 `content_discover` 看 `rate_check: … verdict=`；手写 ffuf 用 `-t <r> -p 1.0`；`verdict=over` 时按实测值重排预算 |
| 每条命令产出两份近重复证据文件（我写的台账 + 派生副本） | `save_stdout_as_evidence` 又落了一份 | 命令最后一段里若已有 `> /work/…` / `tee /work/…`，现在会回 `evidence_skipped: command_wrote_mount`（不重复落盘）；想让文件名好读就把 `purpose` 写成短语（文件名从它派生） |

## 不做的事
- 不做登录爆破、不做参数 fuzz/注入探测（`ffuf -d` POST、sqlmap 等），那是漏洞分析/利用阶段。
- 不用写方法（PUT/DELETE/POST）改目标状态；本阶段全部只读。
- 不做无限递归、不做全端口/全 vhost 越界枚举；要扩大范围先请人类修订。
- 不投载荷、不触发上传/命令执行类端点。

## 产出（交给下一步）
- Web 资产条目：`URL`、状态码、`Server`、标题、`Content-Type`、是否受限（401/403）。
- 软 404 基准：**每个命名空间一条** `code` + `size`（或正文正则）签名（页面与 API 常不同形，供后续阶段复用）。
- **未鉴权方法表**：每条端点接受的方法（`Allow`）——**清点结果，不是利用结果**；写方法（PUT/DELETE/POST）列出来但**一个都不发**。
- **逐路由 API 清单**（SPA）：路由页 → 它引用的 chunk → chunk 里的 `/api/…` 字面量（带来源文件），以及复核后的存在性判定。
- 命中清单：路径、状态码、长度、重定向目标、证据（curl 原文一行）。
- 覆盖说明：用了哪份字典（行数）、并发/延迟、跑了多久、哪些没跑（及原因）。**走结构化通道时直接引用 `coverage:` 行**（`wordlist_entries/entries_total/entry_range/entries_attempted/entries_truncated/entries_remaining`）——它自证"跑到哪儿、还剩多少"，别自己从 hits 数推覆盖。
- 未决线索：可疑 vhost、受限端点、指纹冲突项。

## 参考
- PTES：Intelligence Gathering。
- OWASP WSTG-INFO-01（信息收集）、WSTG-INFO-02（Web 服务器指纹）、WSTG-INFO-03（Web 服务器元文件）、WSTG-INFO-08（Web 框架指纹）。
- ffuf 官方文档与示例（matcher/filter 语义）。
- RFC 9309（robots.txt 规范）。
- 姊妹技能：`recon-network-surface`（端口与 banner）、`recon-dns-cert`（解析与证书）。
