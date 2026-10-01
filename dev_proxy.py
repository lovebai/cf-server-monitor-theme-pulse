#!/usr/bin/env python3
"""本地验收代理：静态主题 + /api 反向代理到线上测试服

用途：线上服务器未开 CORS，浏览器无法直接跨域联调，故用本代理提供同源访问。
- /api/ws (Upgrade: websocket) → 与上游 wss 建立 TLS 隧道，握手后双向透传 TCP
  （上游对 WS Origin 做白名单校验，转发时会剥掉 Origin 头）
- 其他 /api/* → urllib 透传（含 Authorization 头；不透传 Accept-Encoding 以避免压缩内容）
- 其余路径 → 本地静态文件（主题目录）

启动：python3 dev_proxy.py  →  http://127.0.0.1:8788/
配置：上游地址与 JWT 在 dev_config.py（私密，gitignore）；模板见 dev_config.example.py
"""
import json
import socket
import ssl
import threading
import time
import urllib.error
import urllib.request
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

try:
    from dev_config import JWT_TOKEN, UPSTREAM_HOST
except ImportError:  # noqa: B904
    raise SystemExit("缺少 dev_config.py：cp dev_config.example.py dev_config.py 后填写上游地址")

UPSTREAM = f"https://{UPSTREAM_HOST}"
MOCK_OFFLINE = False  # 验收用：把第一台服务器伪装成离线
MOCK_THREE_NET = True  # 验收用：强制开启三网详情（线上后台未开时预览面板）
MOCK_BG = "bg-test.jpg"  # 验收用：模拟 worker custom_bg 注入（本地图片路径，空串关闭）
HOP_HEADERS = {"host", "connection", "content-length", "keep-alive", "upgrade", "sec-websocket-extensions", "accept-encoding"}


class Handler(SimpleHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def do_GET(self):
        if self.path.startswith("/api/"):
            if "websocket" in (self.headers.get("Upgrade") or "").lower():
                self.tunnel_ws()
            else:
                self.proxy_http()
            return
        # 旗帜 / OS 图标由后端默认皮肤提供，本地目录没有，代理到上游
        if self.path.startswith(("/flags/", "/os-icons/")):
            return self.proxy_http()
        if MOCK_BG and self.path.split("?")[0] in ("/", "/index.html"):
            return self.serve_index()
        return super().do_GET()

    def do_POST(self):
        if self.path.startswith("/api/"):
            length = int(self.headers.get("Content-Length") or 0)
            data = self.rfile.read(length) if length else None
            self.proxy_http(method="POST", data=data)
            return
        self.send_error(501, "Unsupported method ('POST')")

    def serve_index(self):
        """按 worker buildBackgroundStyle 的方式向 index.html 注入背景图样式"""
        with open("index.html", "rb") as f:
            body = f.read()
        style = (
            f"<style>body{{background-image:url('{MOCK_BG}') !important;"
            "background-size:cover !important;background-attachment:fixed !important;"
            "background-position:center !important;background-repeat:no-repeat !important;}</style>"
        )
        body = body.replace(b"</head>", style.encode() + b"</head>", 1)
        self.send_response(200)
        self.send_header("Content-Type", "text/html;charset=UTF-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def proxy_http(self, method="GET", data=None):
        headers = {k: v for k, v in self.headers.items() if k.lower() not in HOP_HEADERS}
        if JWT_TOKEN:
            headers["Authorization"] = f"Bearer {JWT_TOKEN}"
        req = urllib.request.Request(UPSTREAM + self.path, data=data, headers=headers, method=method)
        try:
            with urllib.request.urlopen(req, timeout=30) as resp:
                status, body = resp.status, resp.read()
                ctype = resp.headers.get("Content-Type", "application/json")
        except urllib.error.HTTPError as e:
            status, body = e.code, e.read()
            ctype = (e.headers.get("Content-Type") if e.headers else None) or "application/json"
        except Exception as e:  # noqa: BLE001
            status, body, ctype = 502, json.dumps({"error": str(e)}).encode(), "application/json"
        if MOCK_OFFLINE and self.path.startswith("/api/servers") and status == 200:
            try:
                data = json.loads(body)
                first = (data.get("servers") or [None])[0]
                if first:
                    first["last_updated"] = int(time.time() * 1000) - 3_600_000
                    data["latestReportUpdates"] = [
                        u for u in data.get("latestReportUpdates") or [] if u.get("serverId") != first.get("id")
                    ]
                    body = json.dumps(data).encode()
            except Exception:  # noqa: BLE001
                pass
        if MOCK_THREE_NET and self.path.startswith("/api/servers") and status == 200:
            try:
                data = json.loads(body)
                data.setdefault("sysConfig", {})["show_three_net_details"] = True
                body = json.dumps(data).encode()
            except Exception:  # noqa: BLE001
                pass
        self.send_response(status)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def tunnel_ws(self):
        try:
            upstream = ssl.create_default_context().wrap_socket(
                socket.create_connection((UPSTREAM_HOST, 443), timeout=20),
                server_hostname=UPSTREAM_HOST,
            )
        except OSError:
            self.send_error(502, "upstream connect failed")
            return
        lines = [f"GET {self.path} HTTP/1.1"]
        for k, v in self.headers.items():
            lk = k.lower()
            if lk == "host":
                v = UPSTREAM_HOST
            # 上游对 WS Origin 做白名单校验，剥掉本地 Origin 才能通过握手
            if lk in ("connection", "keep-alive", "origin"):
                continue
            lines.append(f"{k}: {v}")
        lines.append("Connection: Upgrade")
        upstream.sendall(("\r\n".join(lines) + "\r\n\r\n").encode())
        buf = b""
        while b"\r\n\r\n" not in buf:
            chunk = upstream.recv(4096)
            if not chunk:
                upstream.close()
                return
            buf += chunk
        self.close_connection = True
        self.connection.sendall(buf)

        def pipe(src, dst):
            try:
                while True:
                    data = src.recv(65536)
                    if not data:
                        break
                    dst.sendall(data)
            except OSError:
                pass
            finally:
                try:
                    dst.shutdown(socket.SHUT_WR)
                except OSError:
                    pass

        t = threading.Thread(target=pipe, args=(upstream, self.connection), daemon=True)
        t.start()
        pipe(self.connection, upstream)


if __name__ == "__main__":
    with ThreadingHTTPServer(("127.0.0.1", 8788), Handler) as server:
        host, port = server.server_address
        print(f"HTTP 服务已启动：http://{host}:{port}/#", flush=True)
        print("按 Ctrl+C 停止服务。", flush=True)
        try:
            server.serve_forever()
        except KeyboardInterrupt:
            print("\nHTTP 服务已停止。", flush=True)

