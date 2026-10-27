# HANDOFF

> 写于 2026-10-27 23:05。给接手的自己（或下一个人）看：现在做到哪、什么没做完、下一步怎么接着做。

## 当前状态

| 项 | 状态 |
|---|---|
| 仓库 | https://github.com/heerxingen/astrbot_plugin_coopanion（public，MIT） |
| 最新提交 | `c52bc3c`（v0.3.1 发布后，未提交的改动见文末） |
| 最新 release | v0.3.1，两个 zip：插件 + Coopanion 扩展 |
| CI | 通过（py_compile + 客户端冒烟 + tsc + describe 漂移 + ps1 语法） |
| 本机 Coopanion | 扩展以 `link:` 指回本仓库的 `coopanion-extension/`，World 处于 active（用户手工在 World 总览启用） |
| AstrBot | 在用户服务器上，经 SSL 隧道访问；本地 3030 未监听，未做端到端联调 |

## 已完成并验证

- **Coopanion 侧 World 扩展** `cortico-world-cua`（`kind: world, api 6`）：
  PowerShell 引擎（截图/窗口/点击/输入/按键/聚焦）、系统「是/否」确认框、回环令牌桥接
  （`/v1/health`、`/v1/tool`、`/v1/identity`、`/v1/chat`、`/v1/mailbox`）。
- **CUA 工具只给桥接**：`worlds.cua.exposeToBot=false` 时 `tools()` 只返回 `send_msg_to_astrbot`，
  Coo 的工具表里没有 `cua_*`（本机实测 `tools: ["send_msg_to_astrbot"]`）。
- **AstrBot 插件** `astrbot_plugin_coopanion`：6 个 `coopanion_*` 工具（返回
  `CallToolResult` + `ImageContent`）、`send_msg_to_coo`、身份 system prompt、取信轮询。
- **身份命名**：`worlds.cua.names.{coo,astrbot,user}`，同时喂给 CUA 环境提示词、两边工具描述、
  `/v1/identity` 与插件的 system prompt 段；只影响 CUA。
- **双向聊天（当前实现）**：AstrBot→Coo 走 `/v1/chat`；Coo→AstrBot 走 **outbox 信箱**，
  插件 `poll_seconds` 轮询 `/v1/mailbox`。实测往返成功（Coo 5 秒内回信）。
- 真机验证过的：截图（2160×1440 → 1200×800 JPEG）、窗口列表、权限框超时拒绝、
  UTF-8 正确性（早先 curl 的乱码是 GBK 终端导致，桥接现在拒收非 UTF-8 body）。

## 没做完的（按优先级）

### 1. Coo → AstrBot 应该走 AstrBot 的 OpenAPI（用户明确指出）

我之前判断"插件的 Web API 在 Dashboard 鉴权后面、隧道另一头打不进来"，于是把
`worlds.cua.chat.*` 和插件的 webhook 都删了。**用户纠正：AstrBot 有基于 API Key 的 OpenAPI，
从这个方向（本地 → 服务器）是通的。**

文档 `AstrBot/docs/zh/dev/openapi.md`：

`@
POST {astrbot}/api/v1/chat
Authorization: Bearer abk_xxx        # 或 X-API-Key: abk_xxx
Content-Type: application/json

{"username": "coo", "message": "…", "enable_streaming": true}
→ SSE，每条 "data: {json}"
`@

API Key 在 AstrBot 的 **设置 → OpenAPI → 创建 API Key**，需要 `chat` scope。

所以要做：
1. 扩展配置恢复 `worlds.cua.chat.{astrbotUrl, apiKey, username, sessionId}`
   （`astrbotUrl` 例如 `https://host:6185`，`apiKey` 是 `abk_...`）。
2. `sendToAstrBot()` 改成：有 url+key 就 POST `/api/v1/chat` 并解析 SSE 取回复文本（同步把回复
   作为工具返回值给 Coo）；没配就退回现在的 outbox 信箱。
3. 解析 SSE 之前先读 `astrbot/dashboard/services/chat_service.py` 第 ~1000-1050 行，
   确认 `data: {json}` 里正文在哪个字段（`type/text/delta/data` 待确认）。
4. 顺手把插件里已删掉的 webhook 决定清楚：**不要恢复**（OpenAPI 是官方路径）。

### 1b. 用户偏好的形态：互相暴露 tool，收信箱也做成 tool，回信在**开头**注入

2026-10-27 23:10 用户补充，**按这个做，别按我原来的默认**：

1. **首选形态是「互相暴露 tool」**：两边各有一个 `send_msg_to_*`，模型自己决定什么时候说，
   tool → tool 直接对话。不要把它做成"后台轮询 + 推送"为主的系统。
2. **信件的读取也要是 tool**：如果保留信箱，就再暴露一个 `check_coo_messages` /
   `read_from_astrbot` 之类的工具，由模型在需要时主动取；现在插件里那个
   `poll_seconds` 后台轮询**降级为可选**（默认关），只当兜底。
3. **AstrBot 收到回信时，在「每次触发对话时」注入**（不是"放到开头"）。
   用户澄清（23:16）："我的意思是做到每次触发对话时就注入，不是让放到开头的意思，你说的那个注入到末尾的就可以"。
   即：注入位置用我现在这版 `extra_user_content_parts`（追加在本轮 user 内容之后）就行，
   **关键是每轮都注入**——每次模型被触发（`on_llm_request`）都把尚未送出的 Coo 回信带进去，
   而不是只在某次工具调用链里才出现。
   要求：同一批消息只注入一次、注入后清空、空批次不要产生空的 `<from_coo>` 块。
4. **同时支持互相轮询**：AstrBot ⇄ Coo 两个方向都要能主动拉/推，不依赖某一次同步调用碰巧成功。

落到代码上（下一轮动手时）：

- 扩展：`send_msg_to_astrbot` 保持 tool；`/v1/mailbox` 保留，但插件侧改成
  「模型调用 `check_coo_messages` 工具时才取」。
- 插件：新增 `check_coo_messages` 工具（返回信箱内容，取一次清空）；
  `_identity_prompt` 保持 `extra_user_content_parts`（本轮 user 内容之后）的写法，
  但确保**每一轮请求都注入一次**、只注入一次、空批次不加空块；
  `poll_seconds` 默认 0。
- 两个方向都保留"能推就推、推不到就拉"的能力。


### 2. AstrBot 插件配置页：本机部署 vs 服务器部署 分不清（用户提了两次）

用户原话（第二次补充）：**"配置页的问题是本机部署和服务器部署的配置方式区分不明显，大部分人拿到手看不懂怎么配置"**。

现在的 7 个字段是平铺的，没有告诉用户"你属于哪种情况、该填哪几个"：

@@@
bridge_json      同机部署填
base + token     服务器部署填
verify_tls       远程才有意义
timeout          都有意义
umo              都有意义
poll_seconds     都有意义
@@@

拿到手的人看到 7 个空框，不知道要填 3 个、4 个还是全填，也不知道填了会怎样。

要做的（任选其一，优先第一个）：

1. **按场景分组**：把 schema 改成两个 @@object@@
   - @@local@@：只有 @@bridge_json@@（hint：AstrBot 和 Coopanion 在同一台机器时只填这一项）
   - @@remote@@：@@base@@ / @@token@@ / @@verify_tls@@（hint：AstrBot 在服务器、Coopanion 在你电脑上时填这块）
   公共项（@@timeout@@ / @@umo@@ / @@poll_seconds@@）放在最后。
   这样"填哪一块"本身就回答了"我是哪种部署"。
2. **views 可视化页**（参考 @@zh/dev/star/guides/plugin-pages.md@@）：第一屏先问一句
   "你的 AstrBot 和 Coopanion 在同一台机器吗？"，选完只渲染对应字段，并顺手生成
   @@bridge_json@@ 的候选路径。
3. 至少也要在每个 hint 最前面加一句限定语：**"仅同机部署"** / **"仅服务器部署"**，
   并把不适用的那组用 @@invisible@@ 或分组默认收起。

### 3.

- 没有 AstrBot 真机联调（本地 3030 未监听）。
- 只有 Windows；`cua_zoom` / `cua_wait` / 动作后自动截图未实现。
- `send_msg_to_coo` 是"发信"，不回传 Coo 的本轮正文（outputTap 已接，但 Coo 通常改用
  `send_msg_to_astrbot` 回，所以同步等待经常拿不到正文——这是设计取舍，不是 bug）。

## 重要操作事实（别重复踩）

- **World 必须在 GUI 的 World 总览里启用**；`POST /api/run/restart` 之后会回到未启用，
  需要再启用一次（激活状态写在 `config.json` 的 `worlds.cua.enabled`，为此把 `enabled`
  加进了配置组 schema，否则会被配置校验剥掉）。
- 测试通道：`TOKEN=` 读 `<部署目录>/data/cua/bridge.json`，然后
  `curl -H "Authorization: Bearer $TOKEN" http://127.0.0.1:17901/v1/...`。
- **别用 Git Bash 的 curl 发中文**（会变成 GBK 乱码）；用 Python 或插件客户端。
- 部署目录（本机）：`D:\Download\Coopanion\data\home\companion`，
  bridge.json 在 `data/cua/bridge.json`。

## 构建与发布

`@bash
cd astrbot_plugin_coopanion
python scripts/build_dist.py          # → dist/*.zip（插件 + 扩展）
cd coopanion-extension && npm run check
gh release create vX.Y.Z dist/*.zip --notes-file …
`@

## 未提交的改动

本轮对话中改动过（写完本文件时状态）：
- `coopanion-extension/src/world.ts`、`config.ts`、`src/ENV_PROMPT.md`（删 chat 配置、模板改名）
- `astrbot_plugin_coopanion/main.py`、`_conf_schema.json`、README、CHANGELOG

这些已随 v0.3.1 提交（`c52bc3c`）。**接手时的第一件事**是 `git status` 确认干净，
然后按"没做完的 1"改回 OpenAPI 方案。
