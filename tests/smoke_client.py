"""离线冒烟测试：假的 Coopanion 扩展 + 真插件客户端。

不装 Coopanion、不装 AstrBot，验证四件事：
1. 从 bridge.json 读出端口与令牌；
2. 请求打到 /v1/tool，带 Bearer 令牌；
3. 回执 {text, failed, blobs[].base64} 被原样解析；
4. 令牌不对时是 401，插件会给出人话错误。

    python tests/smoke_client.py
"""

from __future__ import annotations

import asyncio
import json
import sys
import threading
import tempfile
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

PLUGIN_DIR = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(PLUGIN_DIR))

from client import CoopanionClient, CoopanionError  # noqa: E402

TOKEN = "t" * 43
FAKE = {
    "ok": True,
    "failed": False,
    "text": "屏幕 1（1200x800，物理 2160x1440）；指针在 (10, 20)；前台窗口：Visual Studio Code",
    "blobs": [{"mime": "image/jpeg", "name": "screen.jpg", "base64": "/9j/4AAQSkZJRg=="}],
}
seen: dict[str, object] = {}


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def _unauthorized(self):
        payload = b'{"ok":false,"error":"unauthorized"}'
        self.send_response(401)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def do_GET(self):  # noqa: N802
        if self.headers.get("authorization") != "Bearer " + TOKEN:
            self._unauthorized()
            return
        payload = json.dumps({"ok": True, "world": "cua", "tools": ["cua_screenshot", "cua_windows"]}).encode()
        self.send_response(200)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def do_POST(self):  # noqa: N802
        if self.headers.get("authorization") != "Bearer " + TOKEN:
            self._unauthorized()
            return
        length = int(self.headers.get("content-length") or 0)
        body = json.loads(self.rfile.read(length) or b"{}")
        seen["path"] = self.path
        seen["auth"] = self.headers.get("authorization")
        seen["body"] = body
        payload = json.dumps(FAKE).encode()
        self.send_response(200)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def log_message(self, *_args):
        return


def main() -> int:
    tmp = Path(tempfile.mkdtemp(prefix="coopanion-smoke-"))
    server = HTTPServer(("127.0.0.1", 0), Handler)
    port = server.server_address[1]
    threading.Thread(target=server.serve_forever, daemon=True).start()
    bridge = tmp / "cua" / "bridge.json"
    bridge.parent.mkdir(parents=True, exist_ok=True)
    bridge.write_text(json.dumps({"port": port, "token": TOKEN, "tools": ["cua_screenshot"]}), encoding="utf-8")

    try:
        client = CoopanionClient(bridge_json=str(bridge), timeout=10)
        out = asyncio.run(client.call_tool("cua_screenshot", {"display": 1}))
        health = asyncio.run(client.alive())

        bad = CoopanionClient(base="http://127.0.0.1:" + str(port), token="wrong", bridge_json="", timeout=5)
        try:
            asyncio.run(bad.call_tool("cua_windows", {}))
        except CoopanionError as e:
            refused = "401" in str(e)
        else:
            refused = False
    finally:
        server.shutdown()

    assert seen["path"] == "/v1/tool", seen["path"]
    assert seen["auth"] == "Bearer " + TOKEN, seen["auth"]
    assert seen["body"] == {"name": "cua_screenshot", "args": {"display": 1}}, seen["body"]
    assert out["text"] == FAKE["text"], out
    assert out["blobs"][0]["base64"] == "/9j/4AAQSkZJRg==", out
    assert health["tools"] == ["cua_screenshot", "cua_windows"], health
    assert refused, "错误令牌应当被 401 拒绝"
    print("OK: bridge.json 发现、路径、令牌、回执、401 全部符合预期")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())