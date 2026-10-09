---
name: recon-network-surface
description: 用沙箱里的真 nmap 做网络面清点：存活、开放端口、服务指纹，并给出可复核的证据行
whenToUse: 情报收集阶段；需要确定目标开放端口与服务版本时；进入漏洞分析前补齐覆盖
metadata:
  version: 0.1.0
  phase: intelligence-gathering
  sources: [PTES 情报收集, Nmap 官方文档, WSTG-INFO-01]
  smoked: "沙箱实测@5ee07609c870：6 块原文配方逐条实跑（靶标 fx-web 172.29.0.2:8080）——①`-sS -Pn -p 8080 -oN /tmp/alive.txt` → `Host is up` + `8080/tcp open`（0.17s，rc=0）；占位符换整份声明目标 `172.29.0.2-7 -p 8080,8443,9000` 时 6/6 up、`.2:8080/.3:8443/.4:9000` open（0.18s）；②`-sT -Pn --top-ports 200 -oN` → 8080 open、199 closed（0.05s）；③`-sV --version-light -p 8080` → `SimpleHTTPServer 0.6 (Python 3.10.21)`；④`--script=banner,http-title,http-headers` 有输出但**无** `banner:` 段（http-title=fixture、Server: SimpleHTTP/0.6 Python/3.10.21）；⑤`arp-scan -I eth0 172.29.0.0/16` → 12 台含 MAC（263s，248 主机/秒）、`fping -a -q` 打印 6 台存活但 rc=1（列表含 1 台不可达，非失败）、`nbtscan -r 172.29.0.0/24` → `172.29.0.7 DC1 <server>`、`traceroute -n -m 5 172.30.0.2` 第 1 跳即网关 172.29.0.1 后全 `*`（跨网段须经跳板）、`mtr -n -r -c 5 172.29.0.2` 单跳 0% 丢包；⑥`tshark -i eth0 -a duration:5 -w /tmp/cap.pcap` 抓包 + 同一条命令内读回 → 24 包含 `GET /index.html HTTP/1.1` 与 `HTTP/1.0 200 OK`（cap/read rc=0；仅有 `cap_set_proc()` 告警）。历史：沙箱实测@81483611f0a0：5 块照跑通过（8080 open、网段 6 台存活、top-200、--version-light、NSE 三脚本）；/24 扫 top-200 达 900s 属耗时非语法错。2026-10-06 补第 5/6 步：arp-scan /24 得 9 台、fping 2 台、traceroute 1 跳、masscan 命中 .2、nbtscan 无名字、tshark 34 包"
---

# 网络面清点（recon-network-surface）

## 适用场景
- 情报收集阶段，已经把目标交给选择器、范围里有明确的 IP/域名与端口约定。
- 目标是「把网络面记录成可复核的事实」，不是「找漏洞」——发现的问题转给漏洞分析阶段。

## 前提与边界
- 沙箱直连目标；本部署**可出网**（2026-10-05 起，可达范围与宿主一致）。打不到某个地址时先分清是目标侧过滤还是路由/策略，不要笼统归因于「没有外网」。
- 容器内是 root 且有 `NET_RAW`，所以 `-sS`（SYN）可用；但没有 `-O`/`--osscan` 需要的其它能力，别指望它。
- 目标地址一律用**已裁决的地址**（选择器给的那份）；外部解析器可用（2026-10-05 起），但解析结果不是裁决依据。
- 速率：宿主按行为预设限速（stealth 1/s、deep 10/s）。**命令里不要自己加 `--min-rate` 去顶**，被限速器排队才是预期。

## 步骤

> **多主机扫描必须钉死主机级并行**（2026-10-08 实测）：一次 **45 台批次只报出 1 台**有开放端口，
> 而同一时段 **16 个已知端点全部连通、ICMP 0% 丢包、单台 top-1000 仅 5 秒且结果正确**
> ⇒ 根因不是网络、也不是目标，是 **nmap 默认 hostgroup 随主机数增长放大每台超时窗口**。
> 危害在形态：这类漏报**看起来完全正常**（有输出、rc=0、有端口行），不做交叉验证就会把
> 漏报当成**资产底数**写进报告——这比任何报错都贵。
>
> - 段级/多目标扫描**一律**带：`--min-hostgroup 32 --max-hostgroup 64 --min-parallelism 16`
>   （沙箱的 `port_scan` 动词已内置 ✓；**手写 nmap 时必须自己带**）；
> - 跑完**抽一台已知开放的主机做单台交叉验证**（`nmap -sT -Pn -p <已知端口> <单台>`），
>   命中数与批次结果对不上就**不要**把该批当底数，改成小批次或单台逐台跑；
> - 段级清点优先 `arp-scan`（同网段二层，绕开 ICMP 过滤）与 `fping`，把 nmap 留给"确定要扫端口"的目标。

> **动手前先跑一次基线探针**（2026-10-08 实测；这是本轮最值钱的一条方法）：在扫任何东西之前，
> 先拿到三条**环境属性**——它们不是目标的属性，但决定你的资产底数对不对：
> - **伪影端口**：有些环境对**任何**地址都在特定端口上握手成功（实测 25/110/143 命中 338 台主机、
>   让 **28 台不存在**的主机看起来"有服务"，还造出过一次「邮件服务器群」的假资产面）。
>   测法：对**一个已授权地址上确定不存在的端口**、再对**一个确定不存在的地址**各做一次握手；
>   把稳定成功的端口记下来，**从资产面里扣掉**，别写进报告；
> - **NAT 源地址**：容器里 `ip addr` 看到的是容器地址（如 `172.29.0.2`），而**目标看到的是另一个**
>   （如 `172.27.105.98`）——判「源 ACL / 白名单」只能用它，用容器地址会得反结论；
> - **出网**：容器能否到公网（决定能不能取外部情报）。
> 探针命令用 `pentest_exec`（要触碰目标，所以**关掉 `local_only`**；目标选已授权地址 + 一个确定关闭的端口）；
> 测不到就明说「没测」，**不要**按假设写报告。

> **优先用 `pentest_recon`（结构化侦察入口），不要手写 nmap。** 它的参数只有枚举与整数、
> 目标从选择器注入、容器只打**已裁决地址**，类别是 `active_probing`——**不需要逐条人工放行**，
> 由范围/租约/节奏约束；而下面这些 ```bash 形态（经 `pentest_exec` 走）类别是 `active_probing`，
> 手写命令同样**免批**（类别 `active_probing`：命令原文不再经人过目）。只有当本 skill 需要 `pentest_recon` 未覆盖的选项时才手写命令。

| 本 skill 的步骤 | 用这个 technique | 关键参数 |
|---|---|---|
| 1 可达性 | `port_scan` | `scope=top100`、`ping=syn` |
| 2 端口清点 | `port_scan` | `scope=top1000`（或 `ports=8000,8080-8090` 显式表达式；`none` 表示按档位） |
| 3 服务指纹 | `service_probe` | `ports=<上一步 open 的端口>`、`intensity=light` |
| 4 只读脚本核验 | `nse_safe` | `port=<端口>`、`scripts=http-title,http-headers`（白名单由沙箱强制） |

### 1. 先确认可达（一次，成本最低）
```bash
nmap -sS -Pn -p <范围里声明的端口> <目标> -oN /tmp/alive.txt
```
期望：`Host is up` + 端口表。判据：出现 `Host is up` 才继续；`0 hosts up` 先查目标是否在内网（见「常见失败」）。

### 2. 常见端口清点（范围声明的端口集内）
```bash
nmap -sT -Pn --top-ports 200 <目标> -oN /tmp/ports.txt
```
期望：`PORT STATE SERVICE` 表。判据：只把 `open`（不是 `filtered`）写进资产；`filtered` 只作为线索。
**端口越界即违规**：范围只声明了 3002 就不要扫全端口；要扩大范围必须请人类修订。

### 3. 服务指纹（只对已 open 的端口）
```bash
nmap -sV --version-light -Pn -p <已 open 的端口列表> <目标> -oN /tmp/version.txt
```
期望：`VERSION` 列出现产品/版本。判据：把「产品+版本」与端口一起记入资产；**版本拿不准就写 `unknown`**，不要猜。

### 4. 需要时做一次脚本核验（只读类脚本）
```bash
nmap -Pn -p <端口> --script=banner,http-title,http-headers <目标>
```
期望：脚本段落有输出。判据：把 banner 原文（截断到 200 字符）作为证据附在资产上。

> 上面每步都把结果写到 `/tmp`：**容器是一次性的**（`--rm`），`/tmp` 产物只在那一条命令内存在——
> 要"落盘再筛"就把 `nmap … -oN /tmp/x && grep … /tmp/x` **写在同一条命令里**；分开写会得到
> `No such file or directory`（2026-10-06 实测）。

### 5. 主机发现的其它手段（ICMP 被挡时）与路径
```bash
arp-scan -I eth0 <网段>          # 同网段二层发现：绕开 ICMP 过滤，最可信
fping -a -q <主机1> <主机2>      # 批量 ICMP，脚本友好（-a 只打印存活）
nbtscan -r <网段>                # NetBIOS 名字（Windows/Samba 资产）
traceroute -n -m 5 <目标>        # 路径与下一跳（判断隔离层在哪一跳）
mtr -n -r -c 5 <目标>            # 路径 + 丢包统计（"间歇不通"比 traceroute 更好用）
```
**期望**：arp-scan 出主机表（含 MAC）；fping 逐行打印存活地址；traceroute/mtr 出逐跳列表。
**判据**：**`arp-scan` 只对同网段有效**（跨三层一律没结果，那不是"主机不存在"，是它看不到）；
nbtscan 出名字才说明是 Windows/Samba；路径里出现网关即说明目标不在本网段。
实测补充（2026-10-09）：`fping -a -q` 的地址表里有**任何一台不可达**时退出码就是 **1**（6 台存活 + 1 台不可达 → rc=1，输出仍逐行正确）——别把它串进 `&&` 链、也别当失败；`arp-scan` 扫 /16 实测 **263s**（248 主机/秒），段级范围大时先按这个速率排预算。
> 快扫工具 `masscan` 很快也**很响**：只在人类明确要求并给出速率时用
> （`masscan <网段> -p<端口清单> --rate <人类给的数>`），且**结果要用 `nmap -sT` 复核**——
> 它自己的握手判定会漏，别把 masscan 的清单直接当资产表。

### 6. 抓包看线缆上到底发生了什么（可选）
```bash
date -u +%FT%TZ && tshark -i eth0 -a duration:5 -w /tmp/cap.pcap && tshark -r /tmp/cap.pcap | head -20
```
**期望**：抓包文件生成，读回时出现本步时间段内的包（如 `HTTP … GET / HTTP/1.1`）。
**判据**：抓到的包要能对上**同时段你发过的动作**（时间窗由 `date -u` 标定）；抓不到任何包 ≠ 目标没响应，
先确认网卡名（`ip a`）与是否真有流量。
实测补充（2026-10-09）：`--cap-drop ALL` 下 tshark 会打印 `cap_set_proc() fail return: Operation not permitted`，
**抓包仍然成功**（24 包含 `GET /index.html HTTP/1.1` 与 `HTTP/1.0 200 OK`，copy/read 均 rc=0），别把它当失败。
> 注意：`/tmp/cap.pcap` 只在那一条命令内存在——**抓与读必须写在同一条命令里**（上面就是合并写法）。

## 判读与去噪
- `open|filtered` 不等于打开：UDP 与部分被过滤的端口会这样显示，记为「待确认」。
- 服务指纹会误导（假 banner、故意伪造的 Server 头）。同一端口有两条互相矛盾的指纹时，两条都记，标注冲突。
- 速率被限（命令跑得比预期慢）是**宿主在按预设排队**，不是网络问题——不要重试、不要拆成多条命令绕过。

## 常见失败
| 现象 | 真实原因 | 处置 |
|---|---|---|
| 全部超时、`0 hosts up` | 目标没接进 `internalNetwork`（沙箱只能到达同网成员） | 报告「目标不可达」，请人类确认目标已接入；**不要**改用外网地址 |
| `-sS` 报 requires root | 容器没跑在 root（部署回退过） | 报告环境问题，改用 `-sT` 继续，别硬试 |
| 结果比目标真实开放面少很多 | 范围只声明了部分端口 | 把「覆盖缺口」写进报告，请人类决定是否扩范围 |

## 不做的事
- 不做漏洞利用、不投载荷、不 `--script=exploit` 类脚本。
- 不扫范围外主机或端口；不为了「更全」而 `-p-`。
- 不改目标状态（这一步全是只读探测）。

## 产出（交给下一步）
- 资产/服务条目：`地址:端口`、协议、产品与版本（或 unknown）、banner 证据引用。
- 覆盖说明：扫了哪些端口、哪些被过滤、哪些没测（及原因）。
- 未决线索：可疑但未证实的服务、指纹冲突项。

## 参考
- PTES：Intelligence Gathering — Network Survey。
- Nmap 官方文档：Host Discovery / Port Scanning Basics / Service and Version Detection。
- OWASP WSTG-INFO-01（信息收集）、WSTG-INFO-02（指纹）。
