---
name: recon-network-surface
description: 用沙箱里的真 nmap 做网络面清点：存活、开放端口、服务指纹，并给出可复核的证据行
whenToUse: 情报收集阶段；需要确定目标开放端口与服务版本时；进入漏洞分析前补齐覆盖
metadata:
  version: 0.1.0
  phase: intelligence-gathering
  sources: [PTES 情报收集, Nmap 官方文档, WSTG-INFO-01]
  smoked: "沙箱实测@a197af1d36f6：nmap -sS -Pn -p 8000 → 8000/tcp open；-sT 端口表与 banner 形态"
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

> 上面每步都把结果写到 `/tmp`，再按需用 `cat` 读回：输出很长时 `nmap` 的原始文件比终端回显更适合引用。

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
