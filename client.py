"""Coopanion 的 CUA 桥接客户端。

Coopanion 侧装的是扩展 `cortico-world-cua`（见 ../cortico-world-cua/）：它在 127.0.0.1 上开一个
小 HTTP 服务，并把**实际端口与令牌**写进部署目录的 `cua/bridge.json`：

    {"port": 17901, "token": "…", "tools": ["cua_screenshot", …]}

所以这里只需要读那个文件，然后：

    POST http://127.0.0.1:<port>/v1/tool   {"name":"cua_screenshot","args":{}}
    -> {"ok":true,"failed":false,"text":"…","blobs":[{"mime":"image/jpeg","base64":"…"}]}

三件必须守住的事：
1. 只连 127.0.0.1（扩展也只监听这里）。
2. 令牌放在 `Authorization: Bearer …` 里；没有令牌一律 401。
3. 扩展那边的询问、拒绝、让位都由它自己处理，插件不做任何"绕过权限"的事。
"""

from __future__ import annotations

import json
import os
import time
from pathlib import Path
from typing import Any

import httpx

# 端口被占用时扩展会顺延，所以默认端口只是一个候选，真正的端口永远从 bridge.json 读。
DEFAULT_PORT = 17901


class CoopanionError(RuntimeError):
    """调用 Coopanion 失败；消息直接给用户看，所以要写人话。"""


class CoopanionClient:
    def __init__(
        self,
        bridge_json: str = "",
        base: str = "",
        token: str = "",
        timeout: float = 60.0,
    ) -> None:
        self._bridge_json = bridge_json.strip()
        self._base = base.strip().rstrip("/")
        self._token = token.strip()
        self.timeout = timeout
        self._cache: tuple[float, str, str] | None = None  # (mtime, base_url, token)

    # ---- 发现 ---------------------------------------------------------------

    @staticmethod
    def candidate_bridge_files() -> list[Path]:
        """常见的 bridge.json 位置；用户也可以直接配 bridge_json。"""
        out: list[Path] = []
        env = os.environ.get("COOPANION_CUA_BRIDGE_JSON", "").strip()
        if env:
            out.append(Path(env).expanduser())
        for root in (
            os.environ.get("COOPANION_HOME", ""),
            os.environ.get("CORTICO_HOME", ""),
            str(Path.home() / ".coopanion"),
        ):
            if not root:
                continue
            base = Path(root).expanduser()
            out.extend(sorted(base.glob("*/cua/bridge.json")))
            out.extend(sorted(base.glob("*/home/*/cua/bridge.json")))
            out.append(base / "cua" / "bridge.json")
        return out

    def _discover(self) -> tuple[str, str]:
        if self._bridge_json:
            path = Path(self._bridge_json).expanduser()
            if not path.is_file():
                raise CoopanionError(f"找不到 {path}。请确认 Coopanion 里装了 cortico-world-cua 扩展并已启用。")
            try:
                mtime = path.stat().st_mtime
            except OSError:
                mtime = 0.0
            if self._cache and self._cache[0] == mtime:
                return self._cache[1], self._cache[2]
            try:
                data = json.loads(path.read_text(encoding="utf-8"))
            except (OSError, ValueError) as e:
                raise CoopanionError(f"读不懂 {path}：{e}") from e
            port = int(data.get("port") or DEFAULT_PORT)
            token = str(data.get("token") or "")
            if not token:
                raise CoopanionError(f"{path} 里没有 token。")
            self._cache = (mtime, f"http://127.0.0.1:{port}", token)
            return self._cache[1], self._cache[2]

        if self._base and self._token:
            return self._base, self._token

        for path in self.candidate_bridge_files():
            if path.is_file():
                self._bridge_json = str(path)
                return self._discover()
        raise CoopanionError(
            "找不到 Coopanion 的 cua/bridge.json。请确认："
            "① Coopanion 里装了 cortico-world-cua 扩展并在「World 总览」启用；"
            "② worlds.cua.bridge 是开着的；"
            "③ 在插件配置里填上 bridge_json 的完整路径（Coopanion 日志里会打印）。"
        )

    # ---- 调用 ---------------------------------------------------------------

    async def call_tool(self, tool: str, args: dict[str, Any] | None = None) -> dict[str, Any]:
        """调用一个 cua 工具，返回 {text, failed, blobs}。"""
        base_url, token = self._discover()
        body = {"name": tool, "args": args or {}}
        async with httpx.AsyncClient(timeout=self.timeout) as client:
            try:
                resp = await client.post(
                    base_url + "/v1/tool",
                    content=json.dumps(body).encode("utf-8"),
                    headers={"content-type": "application/json", "authorization": f"Bearer {token}"},
                )
            except httpx.ConnectError as e:
                raise CoopanionError(
                    f"连不上 Coopanion 的 CUA 桥接（{base_url}）。确认 Coopanion 正在运行、扩展已启用；"
                    "端口变了的话删掉缓存或重启 AstrBot 再试。"
                ) from e
            except httpx.TimeoutException as e:
                raise CoopanionError(
                    "Coopanion 一直没回：多半是在等你桌面上那个确认框点「是」，或者截图超时。"
                    "把插件配置里的 timeout 调大再试。"
                ) from e

        if resp.status_code == 401:
            raise CoopanionError("桥接令牌不对（401）。重启一次 Coopanion 让它重写 cua/bridge.json，再重启 AstrBot。")
        if resp.status_code >= 400:
            raise CoopanionError(f"Coopanion 返回 {resp.status_code}：{resp.text[:300]}")
        try:
            out = resp.json()
        except ValueError as e:
            raise CoopanionError(f"Coopanion 回的不是 JSON（{resp.headers.get('content-type', '?')}）：{resp.text[:200]}") from e
        if not isinstance(out, dict):
            raise CoopanionError(f"Coopanion 回了意料之外的内容：{str(out)[:200]}")
        return out

    async def alive(self) -> dict[str, Any]:
        """探活：GET /v1/health。"""
        base_url, token = self._discover()
        async with httpx.AsyncClient(timeout=5.0) as client:
            resp = await client.get(base_url + "/v1/health", headers={"authorization": f"Bearer {token}"})
            resp.raise_for_status()
            return resp.json()
