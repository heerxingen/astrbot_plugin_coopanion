"""AstrBot 插件：让 bot 通过 Coopanion 的 CUA 扩展看/操作这台电脑。

Coopanion 侧是一个真正的 Cortico World 扩展（`cortico-world-cua`），它在 127.0.0.1 上开一个
带令牌的小 HTTP 服务；本插件是它的 AstrBot 端。三个关键决定：

1. 工具结果以 `mcp.types.CallToolResult` 返回，截图放进 `ImageContent` —— 这是 AstrBot 把图片
   喂给多模态模型的唯一通道（对照 astrbot/core/tools/computer_tools/cua.py:100-110）。
2. 权限询问、"用户正在用鼠标就别抢"、开关全部留在 Coopanion 扩展里，本插件不重复实现，
   也不提供"绕过权限"的开关。
3. 工具名带 `coopanion_` 前缀，避免和 AstrBot 内置的 `astrbot_cua_*`（沙箱桌面）撞名。
4. CUA 工具的 schema 由扩展的 `GET /v1/tools` 提供，插件启动时按它注册；插件只保留名字映射
   和一个聊天工具，不再复制 6 份 docstring。
"""

from __future__ import annotations

import asyncio
from typing import Any

import mcp.types as mcp_types
from astrbot.api import star
from astrbot.api.event import AstrMessageEvent, MessageChain, filter
from astrbot.api.provider import ProviderRequest
from astrbot.core.agent.message import TextPart
from astrbot.core.agent.tool import FunctionTool

from .client import CoopanionClient, CoopanionError

# The extension names tools after what it does; AstrBot keeps its own prefix so a tool
# collision with another plugin is visible in the name rather than silently replacing one.
TOOL_ALIASES = {
    "cua_screenshot": "coopanion_screen",
    "cua_windows": "coopanion_windows",
    "cua_click": "coopanion_click",
    "cua_type": "coopanion_type",
    "cua_key": "coopanion_key",
    "cua_focus": "coopanion_focus",
}


def _local_tool_name(remote: str) -> str | None:
    """Keep the old coopanion_* names where they exist; map new cua_* tools by prefix."""
    if remote in TOOL_ALIASES:
        return TOOL_ALIASES[remote]
    if remote.startswith("cua_"):
        return "coopanion_" + remote[4:]
    return None


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
        mode = str(self.config.get("mode") or "").strip()
        bridge_json = str(self.config.get("bridge_json") or "").strip()
        base = str(self.config.get("base") or "").strip()
        token = str(self.config.get("token") or "").strip()
        # The hidden group keeps its old values when the mode changes; follow the selected
        # mode, but fall back to whichever side is actually configured so an upgrade survives.
        if mode == "remote" and not (base and token) and bridge_json:
            mode = "local"
        elif mode == "local" and not bridge_json and base and token:
            mode = "remote"
        if mode == "local":
            base = token = ""
        elif mode == "remote":
            bridge_json = ""
        self.client = CoopanionClient(
            bridge_json=bridge_json,
            base=base,
            token=token,
            timeout=float(self.config.get("timeout") or 90.0),
            verify_tls=bool(self.config.get("verify_tls", True)) if mode != "local" else True,
        )
        # Names come from Coopanion (worlds.cua.names.*) so both ends speak the same language.
        self.names = {"coo": "Coo", "astrbot": "AstrBot", "user": "使用者"}
        # What Coo said while AstrBot was not listening, waiting to be shown to the model.
        self._inbox: list[dict[str, Any]] = []
        # The session Coo's messages belong to: the configured umo, or the chat that last spoke to Coo.
        self._peer_umo = str(self.config.get("umo") or "").strip()
        self._poller: asyncio.Task[None] | None = None
        self._tools_task: asyncio.Task[None] | None = None
        self._dynamic_tools: list[FunctionTool] = []

    async def initialize(self) -> None:
        """插件载入后调用：同步工具表、读身份、必要时启动取信。"""
        # The tool table is the extension's; retry until it answers instead of freezing a copy
        # here, so adding a tool in the extension does not require editing the plugin.
        self._tools_task = asyncio.create_task(self._sync_tools())
        if self.config.get("poll_seconds", 30):
            self._poller = asyncio.create_task(self._poll_coo())
        try:
            identity = await self.client.identity()
        except Exception as e:  # noqa: BLE001 - 启动时失败不该拦住加载
            self.logger.warning("Coopanion 的 CUA 桥接暂时不可用，工具会在它起来后自动注册：%s", e)
            return
        for key in ("coo", "astrbot", "user"):
            if isinstance(identity.get(key), str) and identity[key].strip():
                self.names[key] = identity[key].strip()
        self.logger.info(
            "Coopanion 就绪：我是 %s，对面是 %s，取信间隔 %s 秒，工具 %s",
            self.names["astrbot"],
            self.names["coo"],
            self.config.get("poll_seconds", 30),
            ", ".join(identity.get("tools") or []),
        )

    async def terminate(self) -> None:
        """停用/重载插件时调用。撤掉注册的工具和后台任务。"""
        self._unregister_tools()
        for task in (self._poller, self._tools_task):
            if task is not None:
                task.cancel()
        self._poller = None
        self._tools_task = None

    def _make_handler(self, remote: str):
        """One handler per tool: the schema comes from the extension, the call goes to it."""

        async def handler(event: AstrMessageEvent, **kwargs: Any) -> mcp_types.CallToolResult:
            return await self._call(remote, kwargs)

        return handler

    def _unregister_tools(self) -> None:
        if not self._dynamic_tools:
            return
        try:
            manager = self.context.provider_manager.llm_tools
        except Exception:
            self._dynamic_tools = []
            return
        for tool in self._dynamic_tools:
            try:
                manager.remove_func(tool.name)
            except Exception as e:  # noqa: BLE001 - unloading must not raise
                self.logger.debug("移除 Coopanion 工具 %s 失败：%s", tool.name, e)
        self._dynamic_tools = []

    def _register_tools(self, specs: list[dict[str, Any]]) -> None:
        """Register the extension's cua_* tools with AstrBot under the coopanion_* names."""
        tools: list[FunctionTool] = []
        for spec in specs:
            if not isinstance(spec, dict):
                continue
            remote = str(spec.get("name") or "")
            local = _local_tool_name(remote)
            if not local:
                continue
            parameters = spec.get("parameters")
            if not isinstance(parameters, dict) or parameters.get("type") != "object":
                self.logger.warning("跳过没有对象参数的 Coopanion 工具：%s", remote)
                continue
            tools.append(
                FunctionTool(
                    name=local,
                    description=str(spec.get("description") or ""),
                    parameters=parameters,
                    handler=self._make_handler(remote),
                )
            )
        if not tools:
            self.logger.warning("Coopanion 没有返回可注册的 cua_* 工具")
            return
        self._unregister_tools()
        self.context.add_llm_tools(*tools)
        # add_llm_tools derives the owner from the tool object, which is the framework's own
        # module; point it at this plugin so unload/permission follow the plugin.
        for tool in tools:
            tool.handler_module_path = self.__class__.__module__
        self._dynamic_tools = tools
        self.logger.info("CUA 工具已注册：%s", ", ".join(t.name for t in tools))

    async def _sync_tools(self) -> None:
        """Fetch /v1/tools until the bridge answers, then register what it declares."""
        delay = 5
        while True:
            try:
                specs = await self.client.tools()
                if specs:
                    try:
                        self._register_tools(specs)
                    except Exception as e:  # noqa: BLE001 - a bad schema must not kill the task
                        self.logger.warning("注册 Coopanion 工具失败：%s", e)
                    return
                self.logger.warning("Coopanion 的工具表是空的，稍后重试。")
            except asyncio.CancelledError:
                raise
            except CoopanionError as e:
                if "404" in str(e):
                    self.logger.warning("Coopanion 扩展没有 /v1/tools（版本太旧）；工具没注册，插件和扩展要一起升级。")
                    return
                self.logger.debug("取 Coopanion 的工具表失败：%s", e)
            except Exception as e:  # noqa: BLE001 - keep retrying, the bridge may still start
                self.logger.debug("取 Coopanion 的工具表失败：%s", e)
            await asyncio.sleep(delay)
            delay = min(delay * 2, 60)

    async def _poll_coo(self) -> None:
        """Coo 主动发来的消息：送到它所属的会话；送不到才留给下一次请求注入。"""
        interval = max(5, int(self.config.get("poll_seconds", 30) or 30))
        while True:
            try:
                await asyncio.sleep(interval)
                for msg in await self.client.mailbox():
                    text = str(msg.get("text") or "").strip()
                    if not text:
                        continue
                    target = self._peer_umo or str(self.config.get("umo") or "").strip()
                    delivered = False
                    if target:
                        try:
                            delivered = await self.context.send_message(
                                target, MessageChain().message(f"{self.names['coo']}：{text}")
                            )
                        except Exception as e:  # noqa: BLE001 - a bad umo must not drop the message
                            self.logger.debug("Coo 的消息送到 %s 失败：%s", target, e)
                    if not delivered:
                        self._inbox.append(msg)
            except asyncio.CancelledError:
                raise
            except Exception as e:  # noqa: BLE001 - 轮询失败不该杀掉任务
                self.logger.debug("取 Coo 的信箱失败：%s", e)

    # ---- 给 Coo 发消息 -------------------------------------------------------

    @filter.llm_tool(name="send_msg_to_coo")
    async def send_msg_to_coo(self, event: AstrMessageEvent, message: str = "", wait_seconds: int = 0) -> str:
        """给 Coo 发一条消息。Coo 是用户电脑上的桌宠，能看到那块屏幕、能动鼠标键盘；你不在这台电脑上。

        这是"发信"：Coo 的回复不会立刻出现在返回值里，而是过一会儿以「Coo：…」的形式作为新消息进来。
        发完直接告诉用户已经转达，别自己编 Coo 的回答。

        Args:
            message(string): 要说给 Coo 的话，把需要它做的事说清楚
            wait_seconds(number): 就地等它说完的秒数；0（默认）是纯发信，等它的回信更稳
        """
        text = (message or "").strip()
        if not text:
            return "message 不能为空。"
        # Replies from this exchange belong to the chat that asked for it, not to every session.
        self._peer_umo = event.unified_msg_origin or self._peer_umo
        wait_ms = max(0, int(wait_seconds or 0)) * 1000
        try:
            out = await self.client.chat(text, wait_ms=wait_ms)
        except CoopanionError as e:
            return f"没能把消息送到 Coo：{e}"

        coo = self.names["coo"]
        reply = str(out.get("reply") or "").strip()
        if reply:
            return f"{coo} 回了：\n{reply}"
        if out.get("timedOut"):
            return f"消息已经送到 {coo}，但它没在 {int(wait_seconds)} 秒内说完；它的回信会作为新消息进来。"
        return (
            f"消息已经送到 {coo}。它一般会用 send_msg_to_astrbot 回你，"
            f"那条回信会以「{coo}：…」的形式稍后出现，别替它编回答。"
        )

    @filter.on_llm_request()
    async def _identity_prompt(self, event: AstrMessageEvent, req: ProviderRequest) -> None:
        """把"谁是谁"写进系统提示词。名字稳定，所以可以放在 system_prompt 里。"""
        # One request, one append: the block is already there if this hook ran twice on it.
        if "[Coopanion]" in (req.system_prompt or ""):
            return
        coo, astrbot, user = self.names["coo"], self.names["astrbot"], self.names["user"]
        block = (
            f"\n\n[Coopanion]\n"
            f"你是 {astrbot}，一个跑在服务器上的聊天 bot；你看不到用户自己的电脑屏幕。\n"
            f"{coo} 是用户电脑上的桌宠，它能看到那块屏幕、能动鼠标键盘，但它不在这台服务器上。\n"
            f"{user} 是使用这台电脑的人。\n"
            f"以「{coo}：」开头的消息是 {coo} 发来的，不是 {user} 说的，别搞混。\n"
            f"需要看屏幕、点鼠标、打开程序时，用 send_msg_to_coo 交给 {coo}；它可能直接回在工具返回值里，"
            f"也可能稍后以「{coo}：…」进来。\n"
        )
        req.system_prompt = (req.system_prompt or "") + block

        # What Coo sent back since the last request rides along with this one, then is cleared:
        # it changes every turn, so it belongs in the user content rather than the system prompt.
        if self._inbox and self._peer_umo and event.unified_msg_origin == self._peer_umo:
            pending, self._inbox = self._inbox, []
            lines = "\n".join(
                f"{self.names['coo']}：{str(m.get('text') or '').strip()}"
                for m in pending
                if str(m.get("text") or "").strip()
            )
            if lines:
                req.extra_user_content_parts.append(
                    TextPart(text=f"<from_coo>\n{lines}\n</from_coo>")
                )

    async def _call(self, tool: str, args: dict[str, Any] | None = None) -> mcp_types.CallToolResult:
        try:
            out = await self.client.call_tool(tool, args)
        except CoopanionError as e:
            return mcp_types.CallToolResult(content=[_text(f"调用 Coopanion 失败：{e}")], isError=True)
        return _result(out)


