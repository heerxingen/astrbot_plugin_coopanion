# AstrBot 侧：写一个带自定义工具的插件要哪些事实

> 调研对象：@D:\Download\CodingSpace\AstrBot（浅克隆 master @ dad255c，v4 分支）。
> 每条结论标 文件:行号。

## 1. 插件的最小形态

放在 `data/plugins/<插件目录名>/`（`astrbot/core/star/star_manager.py:205` 注释「存储插件的路径。即 data/plugins」），
模块路径是 `data.plugins.<目录名>`（`star_manager.py:724`）。目录里两个文件就够：

    data/plugins/astrbot_plugin_coopanion/
    ├── main.py          # 必须：类 Main(star.Star)
    ├── metadata.yaml    # 必须：name/desc/author/version
    ├── _conf_schema.json# 可选：插件配置 schema
    └── client.py        # 可选：自己的模块，相对 import（内置插件就这么做）

### main.py

    from astrbot.api import star
    from astrbot.api.event import AstrMessageEvent, filter

    class Main(star.Star):
        def __init__(self, context, config=None):
            super().__init__(context)
            self.config = config or {}

插件类由加载器实例化，签名是 `(context=self.context, config=plugin_config)`，
失败时退回只传 `context`（`star_manager.py:1228-1240`）。

### metadata.yaml

    name: astrbot_plugin_coopanion     # 必须是合法 Python 标识符（star_manager.py:634-643 会校验）
    desc: ...
    author: ...
    version: 0.1.0
    repo: https://github.com/...

字段完整表见 `star_manager.py:1180-1200`（`display_name / short_desc / astrbot_version /
support_platforms / i18n / repo` 等）。

### _conf_schema.json

放在插件目录，会被读成 `data/config/<目录名>_config.json` 并作为 `config` 传进构造函数
（`star_manager.py:1159-1176, 1228-1236`）。值必须是字典，每项至少一个 `type`，
支持的类型只有：`int / float / bool / string / text / list / file / object / template_list / dict`
（`astrbot/core/config/default.py:5025-5035`，校验在 `astrbot/core/config/astrbot_config.py:165-190`）。
顶层键的 `default` 会写进用户的配置文件。

## 2. 注册 LLM 工具

装饰器：`@filter.llm_tool(name="...")`（实现 `astrbot/core/star/register/star_handler.py:579-700`）。

    @filter.llm_tool(name="coopanion_screen")
    async def coopanion_screen(self, event: AstrMessageEvent, display: int = 1):
        """看一眼用户此刻的电脑屏幕。

        Args:
            display(number): 显示器序号，1 是左起第一块
        """
        return ...

规则（都从上面那段实现读出来的）：

- **description 来自函数 docstring 的首段**，参数来自 `Args:` 段（docstring_parser 解析）。
- **参数类型只能写** `string / number / object / array / boolean`（`PY_TO_JSON_TYPE` 映射）；
  支持 `list[string]` 这种写法。类型缺失直接抛错。
- **第一个参数（event）不进 schema**：执行时是 `handler(event, **tool_args)`
  （`astrbot/core/astr_agent_tool_exec.py:790-810` 的 `call_local_llm_tool`）。
- 生成的 JSON Schema **没有 required 列表**（`func_tool_manager.py:343-363`），所以给参数写默认值。
- 工具名全局唯一；AstrBot 内置工具叫 `astrbot_*`，插件最好带自己的前缀。

## 3. 返回值：怎样让模型"看到图"

这是本项目最关键的一条。

| 返回 | 结果 |
|---|---|
| `str` | 包装成 `TextContent` 塞进下一轮 prompt（`astr_agent_tool_exec.py:747-754`） |
| `mcp.types.CallToolResult` | **原样**作为工具结果，可以带 `ImageContent` |
| `None` | 不加入 prompt（用于"已经直接给用户发过消息"的场景） |
| `MessageEventResult` / 异步生成器 | 可以直接发消息、`yield` 多段 |

也就是说，**要"看电脑"，必须返回 `mcp.types.CallToolResult`，里面放
`TextContent`（给模型读的文字回执）+ `ImageContent`（截图）**。AstrBot 自己的
`astrbot_cua_screenshot` 就是这么写的（`astrbot/core/tools/computer_tools/cua.py:100-110`）：

    content: list[ContentBlock] = [
        mcp.types.TextContent(type="text", text=_to_json(payload))
    ]
    if return_image_to_llm:
        content.append(mcp.types.ImageContent(
            type="image", data=str(image_data), mimeType=str(payload.get("mime_type", "image/png"))))
    return mcp.types.CallToolResult(content=content)

## 4. AstrBot 自带的电脑操作为什么不够用

`astrbot/core/tools/computer_tools/` 下有 `cua.py / shell.py / python.py / fs.py`，
但 CUA 工具挂的是**沙箱桌面**：

    # astrbot/core/tools/computer_tools/cua.py:20-24
    _CUA_TOOL_CONFIG = {
        "provider_settings.computer_use_runtime": "sandbox",
        "provider_settings.sandbox.booter": "cua",
    }

`_get_gui_component()` 走的是 `get_booter(...)` 的 `gui`（`cua.py:36-47`），
即容器/虚拟机里的桌面。**看不到也点不到用户自己的屏幕**——这正是本插件存在的理由。

## 5. 反向：让 AstrBot 当 MCP 客户端（零插件路线）

AstrBot 自带 MCP 客户端，配置文件是 `data/mcp_server.json`：

    {
      "mcpServers": {
        "coopanion": {
          "command": "python",
          "args": ["C:/path/to/coopanion_mcp.py"],
          "env": {"COOPANION_CORE": "http://127.0.0.1:17788"},
          "active": true
        }
      }
    }

- 读取点：`astrbot/core/provider/func_tool_manager.py:536-580`。
- 支持 stdio（`command/args/env`）、SSE/streamable HTTP（`url` + `transport`），
  MCP 工具会被包装成 `MCPTool` 注入同一张工具表（`astrbot/core/agent/mcp_client.py:798-820`）。
- 因此 **一条 MCP 服务器就能让 AstrBot 零代码接入 Coopanion**，代价是不能像插件那样做
  AstrBot 特有的整合（会话、权限、消息链）。

---

## 6. 补充：几个容易踩的坑（第二轮核对，AstrBot 4.29.3）

1. **装饰器工具必须写在 main.py 的插件类里**。装饰器 handler 在加载时被
   `functools.partial(raw_handler, star_cls)` 绑定，只有 `handler.__module__ ==
   data.plugins.<目录>.main` 才会走这条路径（`star_manager.py:1282-1306`）。
   写到子模块的方法不会被绑定，执行时 `event` 会错位。
2. **@filter.llm_tool 必须带括号**（`@filter.llm_tool(name="x")`）。不带括号会把函数本身当工具名
   （`register/star_handler.py:619,631`）。
3. **docstring 的 Args 段是唯一参数来源**：Python 类型注解被忽略；docstring 里缺类型会让**插件 import 直接失败**
   （`star_handler.py:631-670`）。
4. **装饰器生成的 schema 没有 required**。要必填/枚举/嵌套，用类式 `FunctionTool`
   （`agent/tool.py:20-75`）+ `self.context.add_llm_tools(...)`（`context.py:748-772`），
   自己写完整的 `parameters`。
5. **生命周期**：`async def initialize(self)` 在载入末尾 await（`star_manager.py:1422-1424`），
   `async def terminate(self)` 在停用/重载时 await（`1965-1966`）。**不要写 `__del__`**，否则
   `terminate` 不会被调用（`1947-1966`）。
6. **图片会被缓存**：`ImageContent` 交给模型前会存到 `data/temp/tool_images/`
   （`tool_image_cache.py:32-52`），模型拿到的是路径 + 图。对"看屏幕"这条链路没有副作用，
   但要知道帧会落盘。
7. **工具超时默认 120 s**（`agent/run_context.py:19`），超时抛
   `tool xxx execution timeout`。Coopanion 首次权限询问可能几十秒，必要时调大。
8. **MCP stdio 有命令白名单**：只允许 `python / python3 / py / node / npx / npm / pnpm / yarn / bun /
   deno / uv / uvx`（`mcp_client.py:28-44`），显式拒绝 `bash/sh/cmd/powershell/curl/wget/ssh`，
   并且禁止 `python -c`、`node -e`、`bash -c`（`165-248`）；`env` 必须是 `dict[str,str]`。
   我们的 MCP 服务器用 `command: "python"`，合法。
9. **MCP 工具没有 server 前缀**（`mcp_client.py:804`），多个 server 同名会互相覆盖。工具名统一加前缀。
10. **没有"工具审批"机制**：只有 admin 权限门（`tool_permissions`）、`active` 开关、人格工具白名单、
    会话插件白名单；`on_using_llm_tool` 能改参数但**不能否决**调用
    （`runner 1279-1292` 用 try/except 包住）。真要做人工确认，得自定义 Agent 的 `run_hooks`
    （`agent/hooks.py:11-29`）。
11. 插件目录里可以放 `requirements.txt`，加载时自动安装（`star_manager.py:353-379`）；
    插件也能注册 Web API：`context.register_web_api(...)`（`context.py:774-796`）。
