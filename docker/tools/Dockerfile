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
# 两个关键点：
#   1. 命令是**单个 argv 元素**（字符串，不是 argv 数组），所以镜像必须靠 ENTRYPOINT
#      接住整串并自行切分 → `/usr/local/bin/pentest-tool`。
#   2. 沙箱**完全放开**（2026-10-04 决定）：给 NET_RAW、去掉只读根、/tmp 可执行；
#      不再注入 HTTP(S)_PROXY——沙箱直连内网目标，不再只有 HTTP 代理一条路。
#      容器**以 root 运行**（见下：Docker 不把 `--cap-add NET_RAW` 放进非特权用户的
#      effective 集，非 root 时 `nmap -sS` 直接失败），保留 no-new-privileges。
#
# 默认模板集（DEFAULT_TEMPLATE_SPECS）用到的命令名：
#
#   http_get     target= method= path= follow_redirects=   → HTTP/HTTPS 直连（不再注入代理）
#   tcp_connect  target= port=
#   udp_probe    target= port=                             （空载荷）
#   icmp_ping    target= count= size=
#   dns_resolve  target= record_type=
#
# 五个模板仍由 `pentest-tool`（Python 3）实现；镜子里另装了**真工具集**
# （nmap / curl / wget / netcat / dig / openssl / jq / whois / ping / ffuf / sqlmap /
# requests / dnspython / beautifulsoup4 + SecLists 字典），供自由命令使用。
# 构建期需要网络（apt / pip / CDN 下载）——这是有意的取舍；
# 旧版「零网络依赖 / 不依赖 apt」的说法已作废。
#
# ── 已知约束（排查时别误判成镜像问题）──
#
# NET_RAW 只有在**容器内是 root** 时才是 effective 的：Docker 不会把 `--cap-add`
# 的 capability 放进非特权用户的 effective/ambient 集（实测 uid 10001 → CapEff=0，
# `nmap -sS` 报 "requires root privileges"；root → CapEff=NET_RAW，SYN 扫描可用）。
# 因此镜像默认不设 USER（以 root 运行）——这是「完全放开」的代价。
# `icmp_ping`：镜像装了 iputils-ping；`pentest-tool` 自身实现也可用非特权 ICMP
# （SOCK_DGRAM + IPPROTO_ICMP），两种情况都可用。
#
# 构建（上下文就是本目录）：
#   docker build -t pentest-tools:dev docker/tools
#
# digest 引用（代码只认 digest，不认标签）见 scripts/dev-sandbox-up.sh。

FROM python:3.10-slim-bookworm

LABEL org.opencontainers.image.title="dsh-pentest sandbox tools" \
      org.opencontainers.image.description="工具容器：接收单字符串命令并分发到 http_get/tcp_connect/udp_probe/icmp_ping/dns_resolve，并内置 nmap/curl/ffuf/sqlmap 等真工具"

# 真工具集（2026-10-04 决定：沙箱权限完全放开）。构建期需要网络——这是有意的取舍，
# 旧版「零网络依赖」的说法已作废。
# ffuf 取 Debian bookworm 官方包（1.1.0）：原计划从 GitHub Release 下 v2.1.0 二进制，
# 但本构建网络拒绝 github.com（apt/pypi/CDN 可达），故改用同一工具的官方 Debian 包。
RUN apt-get update && apt-get install -y --no-install-recommends \
      ffuf nmap curl wget netcat-openbsd dnsutils openssl jq whois iputils-ping \
      ca-certificates unzip \
  && rm -rf /var/lib/apt/lists/*

RUN pip install --no-cache-dir requests dnspython beautifulsoup4 sqlmap

# 字典：放进镜像，沙箱里直接用。原用 raw.githubusercontent.com，同样被构建网络拒绝，
# 改走 jsDelivr CDN（逐字镜像 GitHub 内容，文件名与内容不变）。
RUN mkdir -p /usr/share/wordlists && cd /usr/share/wordlists && \
    curl -sSL --http1.1 --retry 5 --retry-all-errors --retry-delay 3 -o common.txt "https://cdn.jsdelivr.net/gh/danielmiessler/SecLists@master/Discovery/Web-Content/common.txt" && \
    curl -sSL --http1.1 --retry 5 --retry-all-errors --retry-delay 3 -o raft-small-directories.txt "https://cdn.jsdelivr.net/gh/danielmiessler/SecLists@master/Discovery/Web-Content/raft-small-directories.txt" && \
    curl -sSL --http1.1 --retry 5 --retry-all-errors --retry-delay 3 -o subdomains-5000.txt "https://cdn.jsdelivr.net/gh/danielmiessler/SecLists@master/Discovery/DNS/subdomains-top1million-5000.txt"

# 2026-10-04 起容器内以 root 运行：NET_RAW 只对 root 的 effective capability set 生效，
# 非 root 进程拿不到 `--cap-add` 给的能力（Docker 不放 ambient set）；真 SYN 扫描需要它。
# 容器边界不靠容器内的用户：--cap-drop ALL + 仅 NET_RAW、无 --privileged、无宿主挂载 /
# 运行时套接字、只接 internal 网络、有限额、--rm 即弃。
# （`pentest` 用户保留，可用 `--user pentest` 手工以它运行非特权命令。）
RUN useradd --create-home --shell /usr/sbin/nologin --uid 10001 pentest

COPY pentest-tool /usr/local/bin/pentest-tool
RUN chmod 0755 /usr/local/bin/pentest-tool

# exec 形式：PID 1 就是包装器本身，宿主侧 SIGKILL 不会留下中间 shell。
ENTRYPOINT ["/usr/local/bin/pentest-tool"]
