#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""**开发/排障用**的出口代理（不是插件的出网路径）。

2026-10-07 更正：本脚本**已不在插件的出网路径上**。沙箱自 2026-10-05 起直连目标，
`buildDockerArgs` 只透传 `--network`、**不注入任何 `HTTP_PROXY`/`HTTPS_PROXY`**
（回归锁在 `test/docker-sandbox.test.ts`）。出网与否只由网络形状决定：`--internal` ⇒ 没有出口；
非 internal ⇒ 可达范围等于宿主。本代理保留在仓里，供 `dev-sandbox-up.sh proxy|smoke`
单独排障"经代理出网"这条**旧链路**用。

设计依据（历史）：docs/dsh-pentest-plugin-design.md §10.4 —— 工具容器只接入 `internal: true`
的自建网络、经代理出网，代理在连接时刻的裁决即第 2 层边界。**该形态已不成立**：网络非 internal
时容器与宿主同可达，网络是 internal 时容器没有任何出口。若将来恢复该形态，接线点在
`buildDockerArgs` 与 `assertAdjudicatedAddress`（见 pg-policy.ts 的注释）。

本代理是**开发/测试用**的最小实现（Python 3 标准库，无第三方依赖，基础镜像用本机已有的
python:3.10-slim-bookworm，不需要联网拉取）。它只做两件事：

  * `GET/POST/... <absolute-URL>`（明文 HTTP）→ 改写成 origin-form 后转发给目标
  * `CONNECT host:port`（HTTPS 等 TLS 隧道）→ 建 TCP 隧道后双向搬运字节

它**不做**范围校验、不做审计、不做鉴权——生产中这一层应当换成一个真正的裁决型代理
（squid / tinyproxy / 自研），并按 §10.4 在连接时刻对照已裁决的目标集。这里明确写出来，
是为了避免有人把开发用的透传代理当成边界实现。

第一轮实验室实战必须设置 `EGRESS_ALLOW`，并将其限制为书面授权目标的已裁决地址；未设置时本代理拒绝所有目标，不再默认全放行。

用法：
    EGRESS_ALLOW=172.28.0.10 python3 egress-proxy.py [--port 8080]

环境变量：EGRESS_ALLOW（逗号分隔的主机后缀或字面地址白名单；不设=拒绝所有目标）。
"""

from __future__ import annotations

import argparse
import os
import select
import socket
import socketserver
import sys
import threading
import time
from urllib.parse import urlsplit

CONNECT_TIMEOUT_S = 15.0
IDLE_TIMEOUT_S = 60.0
BUFFER = 65536
MAX_HEAD = 64 * 1024

HOP_BY_HOP = {
    "proxy-connection",
    "proxy-authorization",
    "connection",
    "keep-alive",
    "te",
    "trailer",
    "transfer-encoding",
    "upgrade",
}


def log(message: str) -> None:
    sys.stdout.write(f"[{time.strftime('%H:%M:%S')}] {message}\n")
    sys.stdout.flush()


def allowlist() -> tuple[str, ...]:
    raw = os.environ.get("EGRESS_ALLOW", "").strip()
    return tuple(part.strip().lower() for part in raw.split(",") if part.strip())


def host_allowed(host: str, allow: tuple[str, ...]) -> bool:
    if not allow:
        return False
    host = host.lower()
    return any(host == entry or host.endswith("." + entry.lstrip(".")) for entry in allow)


def read_head(sock: socket.socket) -> bytes | None:
    buf = b""
    while b"\r\n\r\n" not in buf:
        chunk = sock.recv(BUFFER)
        if not chunk:
            return None
        buf += chunk
        if len(buf) > MAX_HEAD:
            return None
    return buf


def pump(src: socket.socket, dst: socket.socket) -> None:
    """单向搬运，直到源端关闭或空闲超时。

    结束时不销毁 dst：**只有持有终止权的那一方**（handle_* 的主线程）才关连接。
    否则一端提前半关闭就会连带掐掉另一方向仍在途的响应。
    """
    try:
        while True:
            ready, _, _ = select.select([src], [], [], IDLE_TIMEOUT_S)
            if not ready:
                break
            data = src.recv(BUFFER)
            if not data:
                break
            dst.sendall(data)
    except OSError:
        pass
    finally:
        try:
            dst.shutdown(socket.SHUT_WR)  # 把 EOF 传给对端，但不掐掉对端→本端的在途数据
        except OSError:
            pass
        src.close()


def split_head(head: bytes) -> tuple[list[str], dict[str, str]]:
    lines = head.split(b"\r\n")
    headers: list[str] = []
    parsed: dict[str, str] = {}
    for raw in lines[1:]:
        if not raw:
            continue
        text = raw.decode("latin-1")
        name, _, value = text.partition(":")
        parsed[name.strip().lower()] = value.strip()
        headers.append(text)
    return headers, parsed


def rewrite_head(
    method: str, version: str, request_target: str, headers: list[str], parsed: dict[str, str], host: str
) -> bytes:
    kept = [line for line in headers if line.split(":", 1)[0].strip().lower() not in HOP_BY_HOP]
    if "host" not in parsed:
        kept.insert(0, f"Host: {host}")
    kept.append("Connection: close")  # 一个请求一条上游连接：开发代理不做连接复用
    return (f"{method} {request_target} {version}\r\n" + "\r\n".join(kept) + "\r\n\r\n").encode("latin-1")


def send_error(sock: socket.socket, status: str, detail: str) -> None:
    body = f"{status}\n{detail}\n".encode("utf-8")
    head = (
        f"HTTP/1.1 {status}\r\n"
        "Content-Type: text/plain; charset=utf-8\r\n"
        f"Content-Length: {len(body)}\r\n"
        "Connection: close\r\n\r\n"
    ).encode("latin-1")
    try:
        sock.sendall(head + body)
    except OSError:
        pass
    log(f"{status}: {detail}")


class ProxyHandler(socketserver.BaseRequestHandler):
    def handle(self) -> None:  # noqa: D102
        client: socket.socket = self.request
        client.settimeout(CONNECT_TIMEOUT_S)
        peer = f"{self.client_address[0]}:{self.client_address[1]}"
        head = read_head(client)
        if head is None:
            client.close()
            return
        head, _, rest = head.partition(b"\r\n\r\n")
        try:
            first = head.split(b"\r\n", 1)[0].decode("latin-1")
            method, request_target, version = first.split(" ", 2)
        except ValueError:
            send_error(client, "400 Bad Request", "malformed request line")
            client.close()
            return
        headers, parsed = split_head(head)

        if method.upper() == "CONNECT":
            self.handle_connect(client, peer, request_target)
            return
        self.handle_absolute(client, peer, method, request_target, version, headers, parsed, rest)

    def handle_connect(self, client: socket.socket, peer: str, target: str) -> None:
        host, _, port_text = target.partition(":")
        port = int(port_text) if port_text.isdigit() else 443
        allow = allowlist()
        if not host_allowed(host, allow):
            send_error(client, "403 Forbidden", f"CONNECT {host}:{port} not in EGRESS_ALLOW")
            client.close()
            return
        try:
            upstream = socket.create_connection((host, port), CONNECT_TIMEOUT_S)
        except OSError as exc:
            send_error(client, "502 Bad Gateway", f"CONNECT {host}:{port} failed: {exc}")
            client.close()
            return
        log(f"CONNECT {host}:{port} from {peer} -> established")
        client.sendall(b"HTTP/1.1 200 Connection Established\r\n\r\n")
        client.settimeout(None)
        upstream.settimeout(None)
        threading.Thread(target=pump, args=(upstream, client), daemon=True).start()
        pump(client, upstream)
        upstream.close()
        client.close()

    def handle_absolute(
        self,
        client: socket.socket,
        peer: str,
        method: str,
        request_target: str,
        version: str,
        headers: list[str],
        parsed: dict[str, str],
        rest: bytes,
    ) -> None:
        parts = urlsplit(request_target)
        if parts.scheme != "http" or not parts.hostname:
            send_error(client, "400 Bad Request", f"expected absolute-form http:// URL, got {request_target!r}")
            client.close()
            return
        host, port = parts.hostname, parts.port or 80
        if not host_allowed(host, allowlist()):
            send_error(client, "403 Forbidden", f"{host} not in EGRESS_ALLOW")
            client.close()
            return
        path = parts.path or "/"
        if parts.query:
            path += "?" + parts.query
        try:
            upstream = socket.create_connection((host, port), CONNECT_TIMEOUT_S)
        except OSError as exc:
            send_error(client, "502 Bad Gateway", f"{host}:{port} failed: {exc}")
            client.close()
            return
        log(f"{method} {request_target} from {peer} -> {host}:{port}")
        upstream.sendall(rewrite_head(method, version, path, headers, parsed, parts.netloc) + rest)
        client.settimeout(None)
        upstream.settimeout(None)
        threading.Thread(target=pump, args=(client, upstream), daemon=True).start()
        pump(upstream, client)
        upstream.close()
        client.close()


class Server(socketserver.ThreadingTCPServer):
    allow_reuse_address = True
    daemon_threads = True


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description="dsh-pentest 沙箱出口代理（开发用）")
    parser.add_argument("--port", type=int, default=int(os.environ.get("PROXY_PORT", "8080")))
    args = parser.parse_args(argv[1:])
    allow = allowlist()
    with Server(("0.0.0.0", args.port), ProxyHandler) as server:
        log(f"egress proxy listening on 0.0.0.0:{args.port} allow={allow or 'DENY_ALL（未配置 EGRESS_ALLOW）'}")
        try:
            server.serve_forever()
        except KeyboardInterrupt:
            log("shutting down")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
