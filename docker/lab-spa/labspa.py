#!/usr/bin/env python3
"""SPA 夹具（2026-10-11 冒烟用）：模拟 Next.js 形态的**两个命名空间 + 逐路由 chunk**。

为什么需要它：本轮四条改动只在这种形态上才有意义——

- `http_probe page=` 逐路由抽 chunk：**每条路由自带多条 chunk**，chunk 里才是 `/api/*`；
- `paths=` 查询串：`/api/submissions?mine=1` 与不带是**两条不同的响应**；
- **分命名空间软 404 基准**：页面 404 是 `text/html`（8596B），API 404 是 `application/json`（22B），
  而 `/lists/*` 有自己的 200 兜底页 —— 只有按命名空间取基准才判得出 `/lists/xyz` 是兜底；
- 未鉴权方法表：`GET /api/run` 回 405 + `Allow: POST`，`OPTIONS /api/submissions` 回 405 + 完整方法表。

用法：`python3 labspa.py <port>`（绑 0.0.0.0）。
"""

from __future__ import annotations

import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlsplit

ROOT_404 = (
    b"<!doctype html><html><head><title>404</title></head><body>"
    + b"x" * 8450
    + b"</body></html>"
)
API_404 = b'{"detail":"Not Found"}'  # 22 字节
LISTS_FALLBACK = (
    b"<!doctype html><html><body>lists fallback page " + b"y" * 1180 + b"</body></html>"
)
LISTS_REAL = LISTS_FALLBACK[:-200]  # 真端点：长度与兜底不同（200 字节差）
ROUTES = {"admin": 10, "run": 10, "lists": 10}


def chunk_body(route: str, index: int) -> bytes:
    """一条路由的某个 chunk：11 个 `/api/...` 字面量 + 一个 fetch 调用。"""
    lines = [f'const u{i} = "/api/{route}/item{i}";' for i in range(1, 12)]
    lines.append(f'fetch("/api/{route}/entry");')
    return ("\n".join(lines) + f"\n// chunk {route}-{index}\n").encode()


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = "labspa/1.0"

    def _send(self, code: int, body: bytes, ctype: str, allow: str | None = None) -> None:
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        if allow is not None:
            self.send_header("Allow", allow)
        self.end_headers()
        self.wfile.write(body)

    def _dispatch(self, method: str) -> None:
        parts = urlsplit(self.path)
        path = parts.path
        query = parse_qs(parts.query)

        if path == "/static/chunk-root.js":
            return self._send(
                200, b'const a="/api/session";const b="/api/profile";', "application/javascript"
            )
        if path.startswith("/static/chunks/"):
            name = path.rsplit("/", 1)[-1][:-3]
            route, _, index = name.rpartition("-")
            return self._send(200, chunk_body(route, int(index or "1")), "application/javascript")

        route = path.strip("/")
        if route in ROUTES:
            refs = "".join(
                f'<script src="/static/chunks/{route}-{i}.js"></script>'
                for i in range(1, ROUTES[route] + 1)
            )
            body = (
                f"<!doctype html><html><head><title>{route}</title></head><body>{refs}"
                '<script src="/static/chunk-root.js"></script></body></html>'
            ).encode()
            return self._send(200, body, "text/html")

        if path == "/api/submissions":
            if query.get("mine") == ["1"]:
                return self._send(200, b'{"mine":1}', "application/json")
            return self._send(200, b"[]", "application/json")
        if path == "/api/run":
            if method == "GET":  # 只写端点：GET 回 405，但**方法表随 Allow 泄露**
                return self._send(
                    405, b'{"detail":"Method Not Allowed"}', "application/json", allow="POST"
                )
            return self._send(200, b'{"ok":1}', "application/json")
        if path == "/api/session":
            return self._send(200, b'{"user":null}', "application/json")
        if path.startswith("/api/"):
            return self._send(404, API_404, "application/json")
        if path == "/lists/mine":
            return self._send(200, LISTS_REAL, "text/html")
        if path.startswith("/lists/"):
            return self._send(200, LISTS_FALLBACK, "text/html")
        if path == "/":
            return self._send(
                200,
                b'<!doctype html><html><head><title>lab spa</title></head><body>'
                b'<script src="/static/chunk-root.js"></script></body></html>',
                "text/html",
            )
        return self._send(404, ROOT_404, "text/html")

    def do_GET(self) -> None:  # noqa: N802（http.server 的接口名）
        self._dispatch("GET")

    def do_OPTIONS(self) -> None:  # noqa: N802
        parts = urlsplit(self.path)
        if parts.path == "/api/submissions":
            return self._send(
                405,
                b'{"detail":"Method Not Allowed"}',
                "application/json",
                allow="GET, POST, PUT, DELETE",
            )
        return self._send(405, b'{"detail":"Method Not Allowed"}', "application/json")

    def log_message(self, *args: object) -> None:
        return


if __name__ == "__main__":
    port = int(sys.argv[1])
    print(
        f"labspa 起在 :{port}；长度：root404={len(ROOT_404)} api404={len(API_404)} "
        f"lists_fallback={len(LISTS_FALLBACK)} lists_real={len(LISTS_REAL)} "
        f"chunk={len(chunk_body('admin', 1))}",
        flush=True,
    )
    ThreadingHTTPServer(("0.0.0.0", port), Handler).serve_forever()
