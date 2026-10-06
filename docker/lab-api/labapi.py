#!/usr/bin/env python3
"""实验室 API 靶站：给 vuln-api-checks 的冒烟提供"刻意做错"的 REST/GraphQL 面。

刻意做错的地方（每条都是技能里要能判出来的形态）：
  GET /api/v1/users            → 无鉴权就能列全部用户（含 admin 的 api_key）
  GET /api/v1/users/2          → BOLA：不校验资源归属，任何 id 都返回
  GET /api/v1/orders/101       → IDOR：同上（订单属 2 号用户）
  GET /api/v1/admin            → 403 + **verbose** 报错（回显判定逻辑），带 X-Role: admin 才 200
  GET /api/v1/debug            → 回显请求头与内部路径（信息泄露）
  POST /api/v1/users           → 接受 {"role":"admin"}（mass assignment，回显写入结果）
  POST /api/v1/orders          → 只接受 application/json，其它 Content-Type 返回 415
  GET /graphql?query=...       → 开启 introspection（返回 __schema）
  OPTIONS *                    → 声明允许的方法（含 PUT/DELETE，实际未实现）
"""
import json
import re
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

USERS = {
    1: {"id": 1, "name": "alice", "role": "user", "email": "alice@lab.local"},
    2: {"id": 2, "name": "bob", "role": "admin", "email": "bob@lab.local", "api_key": "sk_live_51H8xQ2eZvKY"},
    3: {"id": 3, "name": "carol", "role": "user", "email": "carol@lab.local"},
}
ORDERS = {
    100: {"id": 100, "user_id": 1, "total": 42.00, "status": "paid"},
    101: {"id": 101, "user_id": 2, "total": 1337.00, "status": "refunded"},
}


class Handler(BaseHTTPRequestHandler):
    server_version = "labapi/0.1"
    protocol_version = "HTTP/1.1"

    def _send(self, code, body, ctype="application/json"):
        payload = json.dumps(body, ensure_ascii=False).encode() if not isinstance(body, bytes) else body
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(payload)))
        self.send_header("X-Lab-Api", "v1")
        self.end_headers()
        self.wfile.write(payload)

    def do_OPTIONS(self):
        self.send_response(204)
        self.send_header("Allow", "GET, HEAD, OPTIONS, POST, PUT, DELETE")
        self.send_header("Content-Length", "0")
        self.end_headers()

    def do_HEAD(self):
        self._send(200, b"")

    def do_GET(self):
        path, _, query = self.path.partition("?")

        if path == "/api/v1/users":
            return self._send(200, {"count": len(USERS), "users": list(USERS.values())})

        m = re.fullmatch(r"/api/v1/users/(\d+)", path)
        if m:
            uid = int(m.group(1))
            if uid not in USERS:
                return self._send(404, {"error": "no such user"})
            # 刻意：不校验调用者与该资源的关系（BOLA）
            return self._send(200, USERS[uid])

        m = re.fullmatch(r"/api/v1/orders/(\d+)", path)
        if m:
            oid = int(m.group(1))
            if oid not in ORDERS:
                return self._send(404, {"error": "no such order"})
            return self._send(200, ORDERS[oid])

        if path == "/api/v1/admin":
            if self.headers.get("X-Role") == "admin":
                return self._send(200, {"panel": "admin", "flag": "lab-admin-panel"})
            # 刻意：verbose 报错，把判定逻辑说出来
            return self._send(
                403,
                {"error": "forbidden", "detail": "requires header X-Role equal to admin (case-sensitive)"},
            )

        if path == "/api/v1/debug":
            return self._send(
                200,
                {
                    "headers": dict(self.headers),
                    "cwd": "/srv",
                    "python": sys.version.split()[0],
                    "note": "debug endpoint should not be exposed",
                },
            )

        if path == "/graphql":
            q = query or ""
            if "__schema" in q or "IntrospectionQuery" in q:
                return self._send(
                    200,
                    {
                        "data": {
                            "__schema": {
                                "queryType": {"name": "Query"},
                                "types": [
                                    {"name": "User", "fields": [{"name": "id"}, {"name": "email"}, {"name": "role"}]},
                                    {"name": "Order", "fields": [{"name": "id"}, {"name": "total"}, {"name": "userId"}]},
                                ],
                            }
                        }
                    },
                )
            if "users" in q:
                return self._send(200, {"data": {"users": list(USERS.values())}})
            return self._send(200, {"data": None, "errors": [{"message": "unknown query"}]})

        if path == "/openapi.json":
            return self._send(
                200,
                {
                    "openapi": "3.0.0",
                    "info": {"title": "lab-api", "version": "1.0"},
                    "paths": {
                        "/api/v1/users": {"get": {}, "post": {}},
                        "/api/v1/users/{id}": {"get": {}},
                        "/api/v1/orders/{id}": {"get": {}},
                        "/api/v1/admin": {"get": {}},
                        "/graphql": {"post": {}},
                    },
                },
            )

        return self._send(404, {"error": "not found", "path": path})

    def do_POST(self):
        length = int(self.headers.get("Content-Length") or 0)
        raw = self.rfile.read(length) if length else b""
        ctype = (self.headers.get("Content-Type") or "").split(";")[0].strip()

        if self.path == "/api/v1/orders":
            if ctype != "application/json":
                return self._send(415, {"error": "unsupported media type", "got": ctype or "(none)"})
            return self._send(201, {"created": True, "raw": raw.decode("utf-8", "replace")})

        if self.path == "/api/v1/users":
            try:
                body = json.loads(raw or b"{}")
            except json.JSONDecodeError as exc:
                return self._send(400, {"error": "bad json", "detail": str(exc)})
            # 刻意：不做字段白名单——客户端写什么就存什么（mass assignment）
            created = {"id": len(USERS) + 1, **body}
            return self._send(201, {"created": created, "accepted_fields": sorted(body.keys())})

        if self.path == "/graphql":
            return self._send(200, {"data": None, "errors": [{"message": "send ?query= for GET form"}]})

        return self._send(404, {"error": "not found", "path": self.path})

    def log_message(self, fmt, *args):  # 静音
        pass


if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 9000
    ThreadingHTTPServer(("0.0.0.0", port), Handler).serve_forever()
