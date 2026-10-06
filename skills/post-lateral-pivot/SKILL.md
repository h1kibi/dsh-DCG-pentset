---
name: post-lateral-pivot
description: 经已控跳板建立临时隧道，把沙箱够不到的内网段变成可核验面；含方向约束、经代理扫描与强制收尾
whenToUse: 后渗透阶段；已控一台双网主机（跳板）；目标网段从沙箱直接不可达，而范围快照里已包含该网段
metadata:
  version: 0.1.0
  phase: post-exploitation
  sources: [MITRE ATT&CK T1090（Proxy）/ T1572（Protocol Tunneling）, chisel 官方文档, ligolo-ng 官方文档, socat 手册, proxychains-ng 手册, PTES Post-Exploitation]
  smoked: "沙箱实测@8aba5d58ad5b：对实验室双网拓扑（沙箱在 pentest-lab-internal；内网段在 --internal 的 pentest-lab-deep；跳板主机 dual-homed）逐块跑：①直连内网 172.30.0.2:8080 超时（direct=000）②socat 在跳板上 TCP-LISTEN:9999,fork,reuseaddr → 经跳板 curl = 200 ③chisel 服务端**必须带 --socks5**——漏了时客户端日志显示 Connected 而 SOCKS 请求全部 Connection reset by peer（实测踩到并写入常见失败）④沙箱侧 chisel client … socks 后：curl --socks5-hostname=200（987 字节真内容）、proxychains4 curl=200、proxychains4 nmap -sT -Pn -p 8080 得 8080/tcp open ⑤配对证据落在同一文件（direct=000 与 via=200）⑥收尾 pkill -x chisel 后 after_teardown=000。另实测本沙箱**无 /dev/net/tun 且无 NET_ADMIN** ⇒ ligolo-proxy 不可用（已写进前提与常见失败）"
---

# 跳板与隧道（post-lateral-pivot）

## 适用场景
- 已控一台**同时接两张网**的主机（跳板）：一张是沙箱所在的网，另一张是目标内网。
- 目标内网段从沙箱**直接不可达**，但**范围快照里已经包含它**——不包含就不做，先请人类修订范围。
- 目标是把「够不到」变成「可核验」，为后续只读核验提供通道；不是"建个隧道长期挂在那"。

## 前提与边界
- **类别是 `lateral_movement`：永远逐条人工放行**（这是本插件的默认策略，不因任何理由自动放行）。
  每条命令经 `pentest_exec`，人类在放行卡上要能看清「这条隧道通往哪个网段、用来干什么」。
- **方向约束（本部署特有）**：沙箱**没有入站端口**（`buildDockerArgs` 不发布端口），所以
  **隧道必须由沙箱主动连出**——跳板侧监听、沙箱侧做客户端。反过来（跳板回调沙箱）在这里不成立，
  不要按"攻击机做服务端"的习惯写命令。
- **范围**：隧道只是通道，**不改变范围**——经它打到的每个网段/端口都必须已在范围里。
  隧道会让"够不到"变"够得到"，但不会让越界变成合规。
- **临时性**：隧道是本次动作的一部分，**用完立即关闭并在产出里给出关闭证据**（见第 6 步）。
  不留常驻隧道、不留跳板后门——那是 `persistence` 类别，本插件默认关闭。
- **能力约束**：本沙箱只有 `NET_RAW`、**没有 `NET_ADMIN`，也没有 `/dev/net/tun`**（实测）。
  因此**需要 TUN 的隧道工具（ligolo-ng 的代理端）在本沙箱不可用**；`ligolo-agent` 二进制可以用于
  投放到目标侧（那属投递动作，逐条放行），但代理端要在有 TUN 的机器上跑。可用的是 SOCKS/端口转发这一族
  （chisel / socat / proxychains4 / ssh -D）。

## 步骤

### 1. 先证明「直连不可达」（不要把隧道当默认动作）
```bash
curl -sS -o /dev/null -m 5 -w 'direct=%{http_code}\n' http://<内网目标>:<端口>/ ; echo "exit=$?"
nc -z -w3 <内网目标> <端口>; echo "nc exit=$?"
```
**期望**：`direct=000` 且 `curl: (28) Connection timed out`，`nc exit` 非 0。
**判据**：**必须**先拿到这份失败证据——它既是"需要跳板"的判据，也是后面"隧道生效"的对照。
若直连就通（`200`/`exit=0`），**不需要建隧道**：别为了用工具而建隧道。

### 2. 最小的一条：单端口转发（socat，只开一个口）
```bash
# 在跳板上（这条是跳板侧命令，经放行后在跳板执行/或由人类执行）
socat TCP-LISTEN:<转发端口>,fork,reuseaddr TCP:<内网目标>:<端口>
# 在沙箱里验证
curl -sS -o /dev/null -m 8 -w 'via_socat=%{http_code}\n' http://<跳板>:<转发端口>/
```
**期望**：`via_socat=200`（对照第 1 步的 `000`）。
**判据**：状态码与正文形态要与直连**同一个服务**对得上（别把跳板上另一个服务当成目标）。
单端口够用时**就用它**——转发面越小，收尾越干净。

### 3. 多目标：chisel 的 SOCKS5（跳板做服务端，沙箱做客户端）
```bash
# 跳板侧：**必须带 --socks5**，否则沙箱的 SOCKS 请求会被 reset（实测：客户端显示 Connected，业务却全 000）
chisel server --port <服务端口> --socks5
# 沙箱侧：连出并开本地 SOCKS5（默认 127.0.0.1:1080）
chisel client <跳板>:<服务端口> socks
```
**期望**：沙箱侧日志出现 `Connected (Latency …)` 与 `tun: proxy#127.0.0.1:1080=>socks: Listening`。
**判据**：`Connected` **只说明控制通道通了**，不代表能转发——必须用第 4 步的业务请求验证；
不要把"客户端说连上了"当成功。

### 4. 经 SOCKS 做核验（只读）
```bash
curl -sS --socks5-hostname 127.0.0.1:1080 -o /tmp/pivot/out.html -w 'via_socks=%{http_code} size=%{size_download}\n' --max-time 10 http://<内网目标>:<端口>/
printf 'strict_chain\nproxy_dns\n[ProxyList]\nsocks5 127.0.0.1 1080\n' > /tmp/pivot/pc.conf
proxychains4 -q -f /tmp/pivot/pc.conf curl -sS -o /dev/null -w 'via_proxychains=%{http_code}\n' --max-time 10 http://<内网目标>:<端口>/
proxychains4 -q -f /tmp/pivot/pc.conf nmap -sT -Pn -p <端口> <内网目标>
```
**期望**：`via_socks=200`、`via_proxychains=200`、nmap 输出 `8080/tcp open`。
**判据**：三者的目标必须是**同一个内网服务**（正文/标题/banner 对上）；nmap **必须 `-sT`**——
`-sS`（SYN）走不了 SOCKS，写 `-sS` 会得到"扫了个寂寞"的结果。

> `--socks5-hostname` 与 `--socks5` 的区别：前者把**域名交给代理去解析**（碰到内网 DNS 时必需），
> 后者本地解析。内网域名场景用 `--socks5-hostname`。

### 5. 留证据：把「不可达 → 可达」配成一对
```bash
{ echo "== 直连（失败）=="; curl -sS -o /dev/null -m 5 -w 'direct=%{http_code}\n' http://<内网目标>:<端口>/ || true; \
  echo "== 经隧道（成功）=="; curl -sS --socks5-hostname 127.0.0.1:1080 -o /dev/null -m 10 -w 'via=%{http_code}\n' http://<内网目标>:<端口>/; } | tee /tmp/pivot/proof.txt
```
**期望**：同一文件里同时出现失败与成功两条。
**判据**：证据必须**成对**——只有"经隧道成功"那一条，读者无法判断隧道是否真的必要（也可能是直连本来就能通）。
隧道链本身（沙箱 → 跳板:端口 → 内网目标:端口）也要写进产出。

### 6. 收尾（**必做**，且要留证据）
```bash
pkill -x chisel; pkill -x socat
sleep 1
curl -sS -o /dev/null -m 5 -w 'after_teardown=%{http_code}\n' --socks5-hostname 127.0.0.1:1080 http://<内网目标>:<端口>/ 2>&1 | tail -1
```
**期望**：`after_teardown` 为 `000`（或明确的连接失败）。
**判据**：**关不掉就是没关**——`000` 才算证据；同时确认跳板侧进程也停了（`pkill` 两侧都做），
并把「已关闭 + 关闭证据」写进产出。后渗透阶段的 `post-cleanup-verify` 会核对这一步。

## 判读与去噪
- **隧道只搬 TCP**：SOCKS/端口转发不管 UDP 与 ICMP——`ping` 不通不代表目标不在，`nmap -sU` 也别指望。
- **`Connected` ≠ 可用**：chisel 的控制通道与数据通道是两件事（实测：服务端漏 `--socks5` 时控制通道照连，
  业务请求全被 reset）。任何"隧道建好了"的结论都必须由**一次真实业务请求**支撑。
- **chisel 服务端绑 IPv6**：日志说 `Listening on http://0.0.0.0:9000`，但实测监听落在 `tcp6` 的 `::`
  （IPv4-only 的调用方要用能回退到 v4 的客户端；`curl`/`chisel client` 都行）。
- **经代理的扫描很慢**：`proxychains` 是逐连接串行化的，`-p` 端口范围给大一点就会卡到超时——按端口清单小步走。
- **代理链会掩盖来源**：经隧道打到的日志在目标侧看起来来自跳板。产出里要写明这一点（归因与影响）。

## 常见失败
| 现象 | 真实原因 | 处置 |
|---|---|---|
| chisel 客户端 `Connected`，但 SOCKS 请求 `Recv failure: Connection reset by peer` | 服务端**没带 `--socks5`** | 服务端加 `--socks5` 重启（实测修法） |
| `nmap -sS` 经代理无结果 | SYN 扫描不能用 SOCKS 代理 | 改 `-sT -Pn`；要 SYN 就得在跳板上跑（逐条放行） |
| `proxychains4` 报 `can't locate` / 直接走直连 | 配置文件路径/语法 | 显式 `-f <conf>`；配置里 `strict_chain` + `[ProxyList]` 段名不能写错 |
| `ligolo-proxy` 起不来、没有 `ligolo` 接口 | 本沙箱**没有 `/dev/net/tun`、没有 `NET_ADMIN`**（实测） | 用第 2/3 步的 SOCKS/端口转发；ligolo 的代理端改在有 TUN 的机器上跑，agent 二进制可用于投放到目标侧 |
| 隧道通了但目标服务返回别的服务内容 | 转发端口撞上跳板上的其它服务 | 换端口，并用正文/标题与直连那次的期望对齐 |
| 关掉客户端后仍能访问 | 跳板侧服务端还在（或还有别的隧道） | 两侧都 `pkill`；用第 6 步的 `000` 作证据 |

## 不做的事
- 不建常驻隧道、不留跳板后门（`persistence` 默认关闭）。
- 不经隧道做写操作或横向扩散；隧道只用于本次放行的只读核验。
- 不把隧道当"扩大范围"的手段——打到的每个网段都必须已在范围快照里。
- 不为了"测试隧道"而扫描跳板自己所在的网段（那是另一条放行）。

## 产出（交给下一步）
- **隧道链**：`沙箱 → 跳板:<端口> → 内网目标:<端口>`（含所用工具与服务端参数）。
- **可达性变化**：直连失败与经隧道成功的**成对证据**引用。
- **清理证据**：关闭命令 + 关闭后的失败证据；未关掉的条目要显式列出。
- **归因说明**：经隧道的流量在目标侧以跳板身份出现。

## 参考
- MITRE ATT&CK：T1090（Proxy）、T1572（Protocol Tunneling）。
- 工具文档：chisel（`server --socks5` / `client … socks`）、socat（`TCP-LISTEN,fork,reuseaddr`）、
  proxychains-ng（`strict_chain` / `proxy_dns`）、ligolo-ng（TUN 依赖）。
