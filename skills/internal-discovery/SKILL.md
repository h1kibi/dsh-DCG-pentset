---
name: internal-discovery
description: 在授权网段内发现存活主机与服务（ping sweep + 声明端口确认），并把噪音压到预设允许的水平
whenToUse: 情报收集阶段；范围里声明了网段或多台主机、需要补齐内网资产清单时
metadata:
  version: 0.1.0
  phase: intelligence-gathering
  sources: [PTES 情报收集, Nmap 官方文档, MITRE ATT&CK T1046/T1018]
  smoked: "沙箱实测@3c49879dd61b：nmap -sn -PE -PS8080 网段 → 8 台存活；-sT -p 8080 -oG → 172.29.0.2 8080/open；步骤 5 配方本轮修掉（原 `<(...)` 既是 bash-ism，`--slurpfile` 又吃不了非 JSON；改成 awk 落地 + `--rawfile`+split，产出 {\"discovered\":[\"172.29.0.2\"]}）"
---

# 内网资产发现（internal-discovery）

## 适用场景
- 范围里给出的是**网段或多个主机**，而不是单一目标；需要先回答「这个网段里有哪些东西活着」。
- 与 `recon-network-surface` 的分工：那份是**单目标**端口/指纹；这一份是**面**上的存活与声明端口确认。

## 前提与边界
- 只扫**范围声明里有的**网段与端口。范围没写的主机即使存活也不登记——发现它们只写成「越界观察」提请人类确认，不继续探测。
- 沙箱只能到达**同在内网**的成员；扫不到网外地址不是目标沉默，是路由不存在。
- 容器内有 `NET_RAW`，所以 `-sn` 的 ICMP/原始探测可用；但**不做** ARP 扫描（容器不在目标二层、也无此能力）。
- 速率由宿主按行为预设限速（stealth 1/s、standard 5/s、deep 10/s）。**不要**用 `--min-rate`/`-T5` 去顶；被排队是预期。

## 步骤

> **容器是一次性的**（`--rm`）：`/tmp/alive.gnmap`、`/tmp/alive.txt`、`/tmp/ports.gnmap` 等中间产物
> **只在那一条命令内存在**。存活探测 → 落地 → 端口确认 → 落资产这几步有先后依赖，
> **必须写在同一条命令里**（`nmap … -oG /tmp/alive.gnmap && awk … > /tmp/alive.txt && nmap … -iL /tmp/alive.txt …`），
> 或让该步自足；分开写会得到 `No such file or directory`（2026-10-06 实测）。

### 1. 先把「允许扫什么」写清楚（不靠记忆）
```bash
jq -r '.targets[] | [.kind, .value, ((.ports//[])|map("\(.from)-\(.to)")|join(","))] | @tsv' /tmp/scope.json
```
**期望**：每行是 `kind value 端口范围`（`cidr`/`ip`/`domain`）。
**判据**：出现不在范围里的网段就停——扫之前先确认这份文件来自服务端裁决结果，不是自己推的。

### 2. 存活扫描（ICMP + 声明端口的 TCP SYN，一次到位）
```bash
nmap -sn -PE -PS<逗号分隔的声明端口> -n <网段> -oG /tmp/alive.gnmap
awk '/Status: Up/{print $2}' /tmp/alive.gnmap | sort -u > /tmp/alive.txt
wc -l < /tmp/alive.txt
```
**期望**：`/tmp/alive.txt` 里是存活地址，数量为个位到十位数（实验室网段）。
**判据**：**存活 ≠ 资产**——主机活着只说明它在；必须有一个声明端口开放才登记为资产（第 3 步）。`Status: Down` 的主机不写「不存在」，只写「本次未响应」。

### 3. 对存活主机确认声明端口（只测范围里写过的端口）
```bash
nmap -sT -Pn -n -iL /tmp/alive.txt -p <逗号分隔的声明端口> -oG /tmp/ports.gnmap
awk '/Ports:.*open/{print $2, $0}' /tmp/ports.gnmap | head -20
```
**期望**：形如 `10.0.0.5 Ports: 3002/open/tcp//http-alt///, 8000/open/tcp//http///`。
**判据**：只有 `open` 计入资产；`filtered` 记「未确认」（可能是过滤，也可能是本机防火墙），`closed` 记「明确关闭」。同一主机两种状态并存时两条都留。

### 4. 给资产一个身份（反解或 banner，二选一）
```bash
nmap -sT -Pn -n --script=banner -p <已 open 的端口> <单个存活主机> | head -20
```
**期望**：`banner:` 段或空。
**判据**：拿到 banner → 取前 200 字符作证据；拿不到 → 资产名留 `unknown`，**不要**用网段位置猜用途。

### 5. 落资产并入索引
```bash
awk '/Ports:.*open/{print $2}' /tmp/ports.gnmap | sort -u > /tmp/alive-hosts.txt
jq -n --rawfile hosts /tmp/alive-hosts.txt \
  '{discovered: ($hosts | split("\n") | map(select(length > 0))), method: "icmp+declared-ports"}' \
  > /tmp/discovery.json
```
**期望**：一份可交给记忆服务的发现清单（地址 + 端口 + 状态 + 证据引用）。
**判据**：每条资产都要能追回一条命令输出；提交前核对一遍数量与 `/tmp/ports.gnmap` 的 `open` 计数一致。

> 这份清单只有地址是自动来的；**端口、状态、证据引用要按前面几步的实测补齐**——`discovered` 不是「猜出来的资产表」，而是「已确认地址」这一列，其余字段由你填。

## 判读与去噪
- **ICMP 不通不代表主机不在**：很多主机禁 ping。这也是第 2 步同时用 `-PS` 探声明端口的原因。
- **`open|filtered`** 出现在 UDP 与强过滤环境，不能当 open。
- 网段里出现大量「存活」而一个端口都不开：多半是网关/虚拟化宿主，登记为「基础设施设备（未开放声明端口）」而不是资产。
- 扫描速度突然变慢：宿主在按预设排队，**不是**网络故障。

## 常见失败
| 现象 | 真实原因 | 处置 |
|---|---|---|
| 0 台存活 | 目标不在沙箱所在内网、或网段写错 | 报告「不可达」并核对范围里的网段；不要改扫外网地址 |
| 全部 `filtered` | 目标侧防火墙丢包 | 记「未确认」，把过滤规则当线索写进报告，不重试 |
| 反解出容器名而非业务名 | 内网 DNS 只有容器记录 | 如实记录来源（内网 DNS），业务名留待人类确认 |
| 结果远超预期主机数 | 扫到了共享网段 | 立即停止，把超范围主机列成「越界观察」请人类裁定 |

## 不做的事
- 不扫范围外的网段/主机；不用 `-p-` 全端口；不做漏洞探测与利用。
- 不做 ARP 欺骗/中间人；不改变目标状态。
- 不把「存活」当「可用资产」写进报告。

## 产出（交给下一步）
- 资产清单：`地址:端口`、状态（open/未确认/关闭）、身份（banner 或 unknown）、证据引用。
- 覆盖说明：扫了哪些网段、哪些未响应、哪些越界观察被排除。
- 未决线索：只开非常见端口、或 banner 与预期不符的主机。

## 参考
- PTES：Intelligence Gathering — Internal/Network Survey。
- Nmap 官方文档：Host Discovery（`-sn`/`-PE`/`-PS`）、Port Scanning（`-sT`）。
- MITRE ATT&CK：T1046 Network Service Discovery、T1018 Remote System Discovery。
