"""AstrBot 插件：让 bot 通过 Coopanion 的 CUA 扩展看/操作这台电脑。

Coopanion 侧是一个真正的 Cortico World 扩展（`cortico-world-cua`），它在 127.0.0.1 上开一个
带令牌的小 HTTP 服务；本插件是它的 AstrBot 端。三个关键决定：

1. 工具结果以 `mcp.types.CallToolResult` 返回，截图放进 `ImageContent` —— 这是 AstrBot 把图片
   喂给多模态模型的唯一通道（对照 astrbot/core/tools/computer_tools/cua.py:100-110）。
2. 权限询问、"用户正在用鼠标就别抢"、开关全部留在 Coopanion 扩展里，本插件不重复实现，
   也不提供"绕过权限"的开关。
3. 工具名带 `coopanion_` 前缀，避免和 AstrBot 内置的 `astrbot_cua_*`（沙箱桌面）撞名。
"""

from __future__ import annotations

from typing import Any

import mcp.types as mcp_types
from astrbot.api import star
from astrbot.api.event import AstrMessageEvent, filter

from .client import CoopanionClient, CoopanionError


def _text(text: str) -> mcp_types.TextContent:
    return mcp_types.TextContent(type="text", text=text)


def _result(out: dict[str, Any]) -> mcp_types.CallToolResult:
    """把 Coopanion 的回执转成 AstrBot 的工具结果（文字 + 可选图片）。"""
    content: list[mcp_types.ContentBlock] = [
        _text(str(out.get("text") or ("失败" if out.get("failed") else "完成（没有回执）")))
    ]
    for blob in out.get("blobs") or []:
        mime = str(blob.get("mime") or "")
        data = blob.get("base64")
        if mime.startswith("image/") and isinstance(data, str) and data:
            content.append(mcp_types.ImageContent(type="image", data=data, mimeType=mime))
    return mcp_types.CallToolResult(content=content, isError=bool(out.get("failed")))


class Main(star.Star):
    def __init__(self, context, config: dict | None = None) -> None:
        super().__init__(context)
        self.config = config or {}
        self.client = CoopanionClient(
            bridge_json=str(self.config.get("bridge_json") or ""),
            base=str(self.config.get("base") or ""),
            token=str(self.config.get("token") or ""),
            timeout=float(self.config.get("timeout") or 60.0),
        )

    async def initialize(self) -> None:
        """插件载入后调用（AstrBot 在加载末尾 await 它）。只做一次不打扰的提示。"""
        try:
            info = await self.client.alive()
        except (CoopanionError, Exception) as e:  # noqa: BLE001 - 启动时失败不该拦住加载
            self.logger.warning("Coopanion 的 CUA 桥接暂时不可用，工具调用会报错：%s", e)
            return
        self.logger.info("Coopanion CUA 就绪，工具：%s", ", ".join(info.get("tools") or []))

    async def _call(self, tool: str, args: dict[str, Any] | None = None) -> mcp_types.CallToolResult:
        try:
            out = await self.client.call_tool(tool, args)
        except CoopanionError as e:
            return mcp_types.CallToolResult(content=[_text(f"调用 Coopanion 失败：{e}")], isError=True)
        return _result(out)

    # ---- 看 -----------------------------------------------------------------

    @filter.llm_tool(name="coopanion_screen")
    async def coopanion_screen(self, event: AstrMessageEvent, display: int = 1) -> mcp_types.CallToolResult:
        """看一眼用户此刻的电脑屏幕（通过用户桌面上的 Coopanion）。

        返回截图（已画出鼠标指针）、显示器尺寸、指针位置与前台窗口标题。之后的点击坐标都用这张截图的像素。
        读取屏幕可能需要用户在桌面的确认框里点一下同意；被拒绝就别反复重试。

        Args:
            display(number): 显示器序号，1 是左起第一块；不确定就用 1
        """
        return await self._call("cua_screenshot", {"display": int(display or 1)})

    @filter.llm_tool(name="coopanion_windows")
    async def coopanion_windows(self, event: AstrMessageEvent) -> mcp_types.CallToolResult:
        """列出用户屏幕上可见的窗口（标题、pid、位置尺寸、是否最小化、哪个在前台）。"""
        return await self._call("cua_windows", {})

    # ---- 动 -----------------------------------------------------------------

    @filter.llm_tool(name="coopanion_click")
    async def coopanion_click(self, event: AstrMessageEvent, x: int = 0, y: int = 0, button: str = "left", clicks: int = 1) -> mcp_types.CallToolResult:
        """把鼠标移到截图的 (x, y) 并点击。点之前先 coopanion_screen 确认位置。

        Args:
            x(number): 横坐标（截图像素）
            y(number): 纵坐标（截图像素）
            button(string): left、right 或 middle，默认 left
            clicks(number): 1 单击、2 双击、3 三击
        """
        return await self._call("cua_click", {"x": int(x), "y": int(y), "button": button, "clicks": int(clicks)})

    @filter.llm_tool(name="coopanion_type")
    async def coopanion_type(self, event: AstrMessageEvent, text: str = "") -> mcp_types.CallToolResult:
        """在当前输入焦点输入文字（中文可用，与输入法状态无关；换行按一次回车）。输入前先点一下要输入的框。

        Args:
            text(string): 要输入的文字
        """
        return await self._call("cua_type", {"text": text})

    @filter.llm_tool(name="coopanion_key")
    async def coopanion_key(self, event: AstrMessageEvent, keys: str = "") -> mcp_types.CallToolResult:
        """按一个键或组合键。组合键用 + 连，先后按用空格分隔，例如 "ctrl+s"、"alt+f4"、"ctrl+a delete"。

        Args:
            keys(string): 键名组合
        """
        return await self._call("cua_key", {"keys": keys})

    @filter.llm_tool(name="coopanion_focus")
    async def coopanion_focus(self, event: AstrMessageEvent, window: str = "") -> mcp_types.CallToolResult:
        """把某个窗口切到前台（最小化的会先还原）。window 用 coopanion_windows 给的 handle，或其标题的一部分。

        Args:
            window(string): 窗口 handle（0x...）或标题片段
        """
        return await self._call("cua_focus", {"window": window})
