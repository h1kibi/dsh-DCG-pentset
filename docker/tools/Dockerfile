# dsh-pentest 沙箱**工具镜像**：`buildDockerArgs` 真正 `docker run` 起来的那一层。
#
# ── 两张镜像的区别（别混淆）──
#
#   docker/Dockerfile         → **宿主/应用镜像**：Kali + Node + dsh + 本插件 + PostgreSQL。
#   docker/tools/Dockerfile   → **沙箱工具镜像**（本文件）：装真工具集，
#                               由 `buildDockerArgs` 以 `<name>@<digest>` 引用。
#                               它不含 dsh、Node、数据库、凭据。
#
# ── 契约（由 src/execution/docker-sandbox.ts + src/execution/templates.ts 决定）──
#
# 宿主拼出的 argv 形状（见 buildDockerArgs）：
#
#   docker run --rm --name pentest-<id> --network <internalNet> \
#     --cap-drop ALL --cap-add NET_RAW --security-opt no-new-privileges \
#     --pids-limit 512 --cpus 2.0 --memory 2g \
#     --tmpfs /tmp:rw,exec,nosuid,size=512m \
#     <name>@sha256:<digest> "<command>"
#
# 三个关键点：
#   1. 命令是**单个 argv 元素**（字符串，不是 argv 数组），所以镜像必须靠 ENTRYPOINT
#      接住整串并自行切分 → `/usr/local/bin/pentest-tool`。
#   2. 沙箱**完全放开**（2026-10-04 决定）：给 NET_RAW、去掉只读根、/tmp 可执行；
#      不再注入 HTTP(S)_PROXY——沙箱直连目标。容器**以 root 运行**（Docker 不把
#      `--cap-add NET_RAW` 放进非特权用户的 effective 集，非 root 时 `nmap -sS` 直接失败）。
#   3. **工具集与提示词必须同源**：`SANDBOX_TOOL_GROUPS`（src/contracts.ts）声明"有什么、
#      怎么用"，`test/sandbox-environment.test.ts` 逐条回到本文件核对（每个工具都要能在
#      下面的 apt / pip / go 清单里找到出处）。改镜像不同步声明 = 测试红。
#
# 默认模板集（DEFAULT_TEMPLATE_SPECS）用到的命令名：
#
#   http_get / tcp_connect / udp_probe / icmp_ping / dns_resolve（前五个动词）
#   shell_exec（direct_command，类别 `active_probing`，**免批**：命令原文不再经人过目）
#   结构化动词（2026-10-06 新增，只打已裁决地址）：
#     port_scan / service_probe / nse_run / tls_probe / http_probe / content_discover /
#     web_crawl / dns_enum / dns_axfr / dns_brute / whois_query / ct_lookup
#     http_check / exposure_check
#
# ── 构建期网络（实测，2026-10-06）──
#
#   deb.debian.org ✓   pypi.org ✓   cdn.jsdelivr.net ✓   goproxy.cn ✓   sum.golang.google.cn ✓
#   github.com ✗（拒绝）   proxy.golang.org ✗（超时）
#
# 因此：apt / pip 走官方源；字典走 jsDelivr（逐字镜像 GitHub 内容）；Go 工具走
# goproxy.cn + sum.golang.google.cn（**版本钉死**，不使用 @latest）。本文件不依赖 github.com。
#
# ── 已知约束（排查时别误判成镜像问题）──
#
# NET_RAW 只有在**容器内是 root** 时才是 effective 的（实测 uid 10001 → CapEff=0，
# `nmap -sS` 报 "requires root privileges"）。因此镜像默认不设 USER。
#
# 构建（上下文就是本目录）：
#   docker build -t pentest-tools:dev docker/tools
#
# digest 引用（代码只认 digest，不认标签）见 scripts/dev-sandbox-up.sh 与 RUNBOOK §2.1。

# ───────────────────────── 阶段 1：编译 Go 工具 ─────────────────────────
#
# 工具集选择标准：**每个阶段真正会用到的**，而不是"Kali 里有的都装"。
# 只装二进制 = 运行镜像里不留 Go 工具链（省 ~1GB 与一条供应链面）。
#
# Go **1.25**（与运行镜像的 Go 版本无关，编译产物在 Debian 12 上跑）：1.22 时 dalfox v2.13.0
# 直接报 `requires go >= 1.25.5 (running go 1.22.12; GOTOOLCHAIN=local)`——GOTOOLCHAIN=local
# 意味着不会自动下载工具链，所以升构建镜像是唯一修法（2026-10-06 实测）。
FROM golang:1.25-bookworm AS gobuild

# 模块代理与校验：官方 proxy/sumdb 在本构建网络不可达（实测），换国内镜像；
# 校验库仍在（sum.golang.google.cn），**不关 GONOSUMCHECK**——关掉等于放弃校验。
ENV GOPROXY=https://goproxy.cn,direct \
    GOSUMDB=sum.golang.google.cn \
    GOFLAGS=-mod=mod

# CGO **开启**：katana 的爬虫内核依赖 go-tree-sitter（C 源码随模块编译），关掉 CGO 会以
# `undefined: Node` 失败（2026-10-06 实测）。构建镜像自带 gcc；运行镜像是同一 Debian 版本，
# 因此动态链接的 libc 在运行镜像里满足。
ENV CGO_ENABLED=1

# 版本全部钉死（`@latest` 会让同一次构建在不同时间产出不同二进制）。一条 RUN 共享模块缓存。
#
# 为什么不装 feroxbuster：它是 **Rust** 工具（本阶段只编译 Go），跑 go install 会以
# `does not contain package` 失败；目录发现由 ffuf（可递归）/gobuster/dirb/dirsearch 覆盖。
#
# 为什么不装 gowitness / hakrawler：两者**没有 tag**（`go list -m -versions` 只回模块路径、
# 不列版本），钉不住版本就等于每次构建拿不同代码——截图取证与爬虫分别由 chromium 缺失时的
# `curl -D-`+标题、以及 katana/ gospider 覆盖（2026-10-06 实测记录）。
#
# 为什么不装 naabu：它依赖 gopacket/libpcap，需要在**两个**阶段都处理 CGO 依赖
# （构建期 libpcap-dev、运行期 libpcap0.8）；端口面的覆盖已由 nmap（准）与 masscan
# （快，apt 包）承担，多一层跨阶段 C 依赖只会让构建更脆（2026-10-06 实测记录）。
#
# 为什么不装 sliver（C2）：本部署的沙箱是一次性容器、无入站端口、无持久进程，
# C2 服务端在这里既跑不起来（没有常驻），也与「不持久化/不留后门」的动作边界冲突。
RUN set -eux; \
    go install -ldflags='-s -w' github.com/projectdiscovery/subfinder/v2/cmd/subfinder@v2.6.6; \
    go install -ldflags='-s -w' github.com/projectdiscovery/dnsx/cmd/dnsx@v1.2.1; \
    go install -ldflags='-s -w' github.com/projectdiscovery/httpx/cmd/httpx@v1.6.0; \
    go install -ldflags='-s -w' github.com/projectdiscovery/katana/cmd/katana@v1.1.0; \
    go install -ldflags='-s -w' github.com/projectdiscovery/nuclei/v3/cmd/nuclei@v3.3.0; \
    go install -ldflags='-s -w' github.com/jpillora/chisel@v1.9.1; \
    go install -ldflags='-s -w' github.com/hahwul/dalfox/v2@v2.13.0; \
    go install -ldflags='-s -w' github.com/jaeles-project/gospider@v1.1.6; \
    go install -ldflags='-s -w' github.com/ropnop/kerbrute@v1.0.3; \
    go install -ldflags='-s -w' github.com/nicocha30/ligolo-ng/cmd/agent@v0.9.2; \
    go install -ldflags='-s -w' github.com/nicocha30/ligolo-ng/cmd/proxy@v0.9.2; \
    mv /go/bin/agent /go/bin/ligolo-agent; \
    mv /go/bin/proxy /go/bin/ligolo-proxy; \
    ls -la /go/bin

# ───────────────────────── 阶段 2：运行时 ─────────────────────────
# Python **3.11**（不是 3.10）：NetExec 要求 `>=3.11`（2026-10-06 实测：3.10 上装 git 版直接
# 报 `Package 'netexec' requires a different Python`）。3.11 也是 Debian 12 的系统版本，
# 其余 python 工具（sqlmap/impacket/commix/pwntools 等）在 3.11 上均可用。
FROM python:3.11-slim-bookworm

LABEL org.opencontainers.image.title="dsh-pentest sandbox tools" \
      org.opencontainers.image.description="工具容器：结构化动词（侦察/核验）+ 自由命令通道，内置 nmap/nuclei/httpx/ffuf/sqlmap/impacket 等真工具与自建只读模板" \
      org.opencontainers.image.toolbelt.version="2026.10.06"

# 真工具集。构建期需要网络——这是有意的取舍（旧版「零网络依赖」的说法已作废）。
# 分组见 src/contracts.ts 的 SANDBOX_TOOL_GROUPS（与提示词同源，测试逐条核对出处）。
# DEBIAN_FRONTEND=noninteractive：`tshark` 的 postinst 会问「是否允许非 root 抓包」，
# 非交互构建里必须给默认答案，否则构建会卡住（2026-10-06 实测需要）。**只内联在安装行**，
# 不用 ENV——ENV 会带进运行镜像，改变容器里每条命令的环境。
RUN apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
      # 侦察与资产测绘
      nmap masscan dnsutils whois fping iputils-ping traceroute mtr-tiny arp-scan nbtscan whatweb dnsenum iproute2 \
      # Web 内容与核验
      ffuf gobuster dirb wfuzz sslscan testssl.sh \
      # 凭据与杂凑（**默认禁止爆破**，见 skills/exploit-auth-testing）
      hydra john \
      # AD / Windows 服务
      smbclient smbmap samba-common-bin ldap-utils snmp nfs-common \
      # 隧道与转发
      socat proxychains4 sshpass openssh-client \
      # 数据库客户端（2026-10-07 加：④ 报告实测"容器里没有 psql/redis-cli，只能手搓协议"）
      postgresql-client redis-tools \
      # 字典生成与流量取证（2026-10-06 加）
      crunch cewl tshark \
      # 基础运行时与数据处理
      curl wget netcat-openbsd openssl jq git rsync ca-certificates unzip xxd file less \
  && rm -rf /var/lib/apt/lists/*

# `snmpwalk` 首次运行会在 /var/lib/snmp 下建 `cert_indexes` 并**打印一行**
# `Created directory: /var/lib/snmp/cert_indexes`，污染按行解析的产物（2026-10-08 操作者实测 P2）。
# 预建该目录即可消掉那行：容器是一次性的，镜像里存在就等于每次运行都存在。
RUN mkdir -p /var/lib/snmp/cert_indexes
#
# 有意**不装**（写在这里，免得下次又被"Kali 里都有"的直觉加回来）：
# - `hashcat`（apt 有 6.2.6）：GPU 加速的离线破解，在 2 核/2g/无 GPU 的沙箱里跑等于自残；
#   哈希**识别**已由 hashid 覆盖，破解本身按提示词纪律交人类在专用机器上做。
# - `responder`：LLMNR/NBT-NS 投毒=改目标网络环境 + 需要常驻监听，两样都出界（无入站端口、一次性容器）。
# - `exploitdb`/`searchsploit`：Debian 12 无此包；上游是 GitHub 仓库（无版本、体积大、每次构建内容不同），
#   本地漏洞库改用在线 NVD/OSV（见 skills/vuln-intel 的离线退化分支）。
# - `feroxbuster`：Rust 工具，本阶段只编译 Go（目录发现已由 ffuf/gobuster/dirb/dirsearch 覆盖）。
# - `gowitness` / `hakrawler`：Go 模块**没有 tag**，钉不住版本（截图与爬取由 curl+标题、katana/gospider 覆盖）。
# - `sliver`/`pwncat-cs`：C2 与"反向 shell+自动提权+持久化"，与"一次性容器、无入站"的设计冲突。
# - **Windows 侧工件**（Rubeus / Seatbelt / PowerUp / WinPEAS / LinPEAS）：它们是投放到**目标**上运行的
#   东西，不是 Linux 沙箱里的 CLI；沙箱内跑 LinPEAS 只会枚举沙箱自己。需要时由人类决定投递方式并放行。
# - **云与 K8s 套件**（prowler / scoutsuite / pacu / cloudfox / peirates / trivy / kube-hunter /
#   kube-bench / kubectl-who-can）：本部署没有云目标与凭据，装了就是几百 MB 死重量。真打云时再加，
#   而且它们都能走稳定源：`pip install prowler scoutsuite pacu kube-hunter`、
#   `go install github.com/aquasecurity/trivy/cmd/trivy@v0.75.0`（v0.75.0 实测可解析）。
# - `enum4linux`（老版，apt）：bookworm 已无此包；用 GitHub 的 enum4linux-ng（见下，已装）。
# - **NetExec (`nxc`) / CrackMapExec 系**：依赖表里有**四个 git URL**（certipy-ad / impacket /
#   oscrypto / pynfsclient 全指向 GitHub 仓库），装它必须 `github.com` 可达，而那是本环境里
#   时通时不通的域（2026-10-06 一天内翻转三次）。四条替代路都试过并否掉：`dploot<4` 只解决
#   另一个问题（SMB 模块的 dploot 4 API 断档）、main 分支同样依赖 git URL、把四个 git 依赖
#   改指 PyPI 能装上但运行期 `nxc smb` 直接 `LibraryNotFoundError`（oscrypto 的 OpenSSL 3 检测）、
#   加重试只是把不确定性搬进构建。**需要它时**：在 github 可达的机器上
#   `POETRY_DYNAMIC_VERSIONING_BYPASS=1.5.1 pip install "git+https://github.com/Pennyw0rth/NetExec@v1.5.1" "dploot<4"`，
#   把结果导成 wheel 或在有网机器上构建镜像；或者由人类在沙箱外用自己的 nxc 做 AD 横向。
#   本镜像的 AD 面由 enum4linux-ng + impacket（73 个脚本）+ smbmap/smbclient/rpcclient + evil-winrm 覆盖。

# Python 工具与库（阶段 Agent 的脚本面）。sqlmap 用 pip 版（Debian 包落后于上游）。
#
# AD 链（2026-10-06 补）：bloodhound-python（收集+最短路分析）/ certipy-ad（ADCS 枚举与 ESC1-8）/
# ldapdomaindump + adidnsdump（域信息与 AD DNS 记录）。Web 链：dirsearch（目录）/ arjun（参数发现）/
# wafw00f 的 CLI（此前只有库）。enum4linux-ng 的依赖（ldap3/pyyaml/jsonschema/xmltodict）也在这里。
#
# **NetExec 与 enum4linux-ng 不在 PyPI**（2026-10-06 实测：`pip download` 两者都返回
# `No matching distribution found`），只能从 GitHub 装 → 单独一段，见下。
RUN pip install --no-cache-dir \
      requests dnspython beautifulsoup4 lxml \
      sqlmap impacket smbmap commix \
      pyjwt paramiko pycryptodome scapy sslyze wafw00f hashid \
      certipy-ad bloodhound ldapdomaindump adidnsdump dirsearch arjun \
      ldap3 pyyaml jsonschema xmltodict \
      pwntools
#
# pip 这段**没有钉版本**（与 Go 阶段的 `@版本` 不同）：同一份 Dockerfile 在不同时间会装出
# 不同依赖树。这是已知的复现性缺口（见 RUNBOOK §2.1）；要完全复现得钉到 wheel 版本。

# GitHub 专供件（**钉 tag**）：enum4linux-ng 不发布到 PyPI，只能从源码装。
#   enum4linux-ng → `enum4linux-ng`：SMB/RPC 枚举，输出结构化（比 apt 的老 enum4linux 好）
#
# **走 codeload.github.com 取 tar.gz，不用 `git clone github.com`**（2026-10-06 实测）：
# `github.com:443` 时通时不通（当天上午拒绝 → 下午 200 → 一小时后超时 → 再一小时又 200），
# 而 `codeload.github.com` 稳定可达；按 tag 取归档同样钉得住版本，还省掉整份 git 历史。
#
# **NetExec 不上这里**（见下方"有意不装"清单）：它的依赖表里有四个 git URL，装它必须 github.com 通；
# 2026-10-06 为此试过四条路（钉 dploot<4、换 main 分支、把 git 依赖改指 PyPI、加重试）——
# 改指 PyPI 那条能装上但运行期 `nxc smb` 直接 `LibraryNotFoundError`（oscrypto 的 OpenSSL 3 检测），
# 说明那四个 git 依赖换不掉。于是**不做**：镜像构建不依赖 flaky 网络，AD 面由
# enum4linux-ng + impacket + smbmap/smbclient + evil-winrm 覆盖。
RUN set -eux; \
    curl -fsSL -o /tmp/e4l.tar.gz "https://codeload.github.com/cddmp/enum4linux-ng/tar.gz/refs/tags/v1.3.10"; \
    mkdir -p /opt/enum4linux-ng; tar -xzf /tmp/e4l.tar.gz -C /opt/enum4linux-ng --strip-components=1; \
    chmod +x /opt/enum4linux-ng/enum4linux-ng.py; \
    ln -sf /opt/enum4linux-ng/enum4linux-ng.py /usr/local/bin/enum4linux-ng; \
    rm -f /tmp/e4l.tar.gz; \
    enum4linux-ng --help >/dev/null

# Evil-WinRM（WinRM 横向，支持 pass-the-hash）：**只在 RubyGems 发布**。先装 ruby + 构建链，
# 装完把构建链卸掉——运行镜像里只留 gem 与 ruby 运行时（与 Go 阶段同一思路：只保留下产物）。
# `libreadline-dev`：evil-winrm 的依赖链里有 `readline-ext`，它是**原生扩展**，slim 镜像没有
# readline 头文件时会在 extconf 阶段直接失败（实测 `Neither readline nor libedit was found`）；
# `zlib1g-dev` 同理（其它原生 gem 常见依赖）。装完一并 purge。
RUN set -eux; \
    apt-get update; \
    DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
      ruby ruby-dev build-essential libreadline-dev zlib1g-dev; \
    gem install --no-document evil-winrm -v 4.1; \
    apt-get purge -y ruby-dev build-essential libreadline-dev zlib1g-dev; \
    apt-get autoremove -y; \
    rm -rf /var/lib/apt/lists/*; \
    evil-winrm --version

# Go 工具（阶段 1 编译好的二进制，只有可执行文件进运行镜像）
COPY --from=gobuild /go/bin/ /usr/local/bin/

# 字典：放进镜像，沙箱里直接用。走 jsDelivr（逐字镜像 GitHub 内容），**钉到 tag** 而非 master——
# master 会让同一次构建在不同时间拿到不同字典（供应链与复现性都受害）。
# 字典源**可换**（`--build-arg SECLISTS_BASE=…`）。2026-10-09 实测：某些网络下**容器内** DNS
# 只解析出 IPv6 而容器 IPv6 不可达 ⇒ jsDelivr 必失败（宿主 curl 却正常，极易误判成"抖动"）。
# 换一个可达的镜像源即可（内容仍是钉住的 tag，不用 master）。默认保持原样。
ARG SECLISTS_BASE="https://cdn.jsdelivr.net/gh/danielmiessler/SecLists@2023.4"
RUN mkdir -p /usr/share/wordlists && cd /usr/share/wordlists && \
    SECLISTS="${SECLISTS_BASE}"; \
    fetch() { curl -sSL --http1.1 --retry 5 --retry-all-errors --retry-delay 3 -o "$1" "$2"; }; \
    fetch common.txt               "$SECLISTS/Discovery/Web-Content/common.txt"; \
    fetch raft-small-directories.txt "$SECLISTS/Discovery/Web-Content/raft-small-directories.txt"; \
    fetch raft-small-files.txt     "$SECLISTS/Discovery/Web-Content/raft-small-files.txt"; \
    fetch quickhits.txt            "$SECLISTS/Discovery/Web-Content/quickhits.txt"; \
    fetch api-endpoints.txt        "$SECLISTS/Discovery/Web-Content/api/api-endpoints.txt"; \
    fetch subdomains-5000.txt      "$SECLISTS/Discovery/DNS/subdomains-top1million-5000.txt"; \
    fetch top-usernames.txt        "$SECLISTS/Usernames/top-usernames-shortlist.txt"; \
    fetch top-passwords-1000.txt   "$SECLISTS/Passwords/Common-Credentials/10-million-password-list-top-1000.txt"; \
    wc -l *.txt

# 自建 nuclei 只读模板：**不用网上下载的模板库**（上游模板集含大量入侵性用例，
# 与「核验不可破坏」的纪律冲突，且下载源在本构建网络不可达）。模板随镜像分发、随镜像审计。
COPY nuclei-templates/ /opt/pentest-templates/
RUN nuclei -version >/dev/null 2>&1 || true; ls -la /opt/pentest-templates

# 2026-10-04 起容器内以 root 运行：NET_RAW 只对 root 的 effective capability set 生效。
# 容器边界不靠容器内的用户：--cap-drop ALL + 仅 NET_RAW、无 --privileged、无宿主挂载 /
# 运行时套接字、只接指定网络、有限额、--rm 即弃。
# （`pentest` 用户保留，可用 `--user pentest` 手工以它运行非特权命令。）
RUN useradd --create-home --shell /usr/sbin/nologin --uid 10001 pentest

COPY pentest-tool /usr/local/bin/pentest-tool
RUN chmod 0755 /usr/local/bin/pentest-tool

# exec 形式：PID 1 就是包装器本身，宿主侧 SIGKILL 不会留下中间 shell。
ENTRYPOINT ["/usr/local/bin/pentest-tool"]
