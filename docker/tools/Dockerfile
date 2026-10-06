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
#   shell_exec（direct_command，逐条人批）
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
FROM golang:1.22-bookworm AS gobuild

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
# `does not contain package` 失败；目录发现由 ffuf（可递归）/gobuster/dirb 覆盖。
#
# 为什么不装 naabu：它依赖 gopacket/libpcap，需要在**两个**阶段都处理 CGO 依赖
# （构建期 libpcap-dev、运行期 libpcap0.8）；端口面的覆盖已由 nmap（准）与 masscan
# （快，apt 包）承担，多一层跨阶段 C 依赖只会让构建更脆（2026-10-06 实测记录）。
RUN set -eux; \
    go install -ldflags='-s -w' github.com/projectdiscovery/subfinder/v2/cmd/subfinder@v2.6.6; \
    go install -ldflags='-s -w' github.com/projectdiscovery/dnsx/cmd/dnsx@v1.2.1; \
    go install -ldflags='-s -w' github.com/projectdiscovery/httpx/cmd/httpx@v1.6.0; \
    go install -ldflags='-s -w' github.com/projectdiscovery/katana/cmd/katana@v1.1.0; \
    go install -ldflags='-s -w' github.com/projectdiscovery/nuclei/v3/cmd/nuclei@v3.3.0; \
    go install -ldflags='-s -w' github.com/jpillora/chisel@v1.9.1; \
    ls -la /go/bin

# ───────────────────────── 阶段 2：运行时 ─────────────────────────
FROM python:3.10-slim-bookworm

LABEL org.opencontainers.image.title="dsh-pentest sandbox tools" \
      org.opencontainers.image.description="工具容器：结构化动词（侦察/核验）+ 自由命令通道，内置 nmap/nuclei/httpx/ffuf/sqlmap/impacket 等真工具与自建只读模板" \
      org.opencontainers.image.toolbelt.version="2026.10.06"

# 真工具集。构建期需要网络——这是有意的取舍（旧版「零网络依赖」的说法已作废）。
# 分组见 src/contracts.ts 的 SANDBOX_TOOL_GROUPS（与提示词同源，测试逐条核对出处）。
RUN apt-get update && apt-get install -y --no-install-recommends \
      # 侦察与资产测绘
      nmap masscan dnsutils whois fping traceroute mtr-tiny arp-scan nbtscan whatweb dnsenum iproute2 \
      # Web 内容与核验
      ffuf gobuster dirb wfuzz sslscan testssl.sh \
      # 凭据与杂凑（**默认禁止爆破**，见 skills/exploit-auth-testing）
      hydra john \
      # AD / Windows 服务
      smbclient smbmap ldap-utils snmp \
      # 隧道与转发
      socat proxychains4 sshpass openssh-client \
      # 基础运行时与数据处理
      curl wget netcat-openbsd openssl jq git rsync ca-certificates unzip xxd file less \
  && rm -rf /var/lib/apt/lists/*

# Python 工具与库（阶段 Agent 的脚本面）。sqlmap 用 pip 版（Debian 包落后于上游）。
#
# **netexec / enum4linux-ng 不在这里**：两者都不在 PyPI（只从 GitHub 安装），而本构建网络
# 拒绝 github.com（见文件头）。SMB/AD 面由 smbmap（PyPI ✓）+ impacket + smbclient + ldap-utils 覆盖，
# 缺的只是 netexec 的"一体化 AD 用例编排"——那部分本来就属横向类动作，本部署逐条人批。
RUN pip install --no-cache-dir \
      requests dnspython beautifulsoup4 lxml \
      sqlmap impacket smbmap commix \
      pyjwt paramiko pycryptodome scapy sslyze wafw00f hashid \
      pwntools
# 说明：pip 版 smbmap/netexec/enum4linux-ng 覆盖 apt 版缺的新特性（协议实现跟上上游）；
# 两者共存时 PATH 里 pip 的 console script 优先（/usr/local/bin 在 /usr/bin 之前）。

# Go 工具（阶段 1 编译好的二进制，只有可执行文件进运行镜像）
COPY --from=gobuild /go/bin/ /usr/local/bin/

# 字典：放进镜像，沙箱里直接用。走 jsDelivr（逐字镜像 GitHub 内容），**钉到 tag** 而非 master——
# master 会让同一次构建在不同时间拿到不同字典（供应链与复现性都受害）。
RUN mkdir -p /usr/share/wordlists && cd /usr/share/wordlists && \
    SECLISTS="https://cdn.jsdelivr.net/gh/danielmiessler/SecLists@2023.4"; \
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
