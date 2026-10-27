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

### 2. AstrBot 插件配置页不好懂（用户第二次提）

现状：7 个配置项（`bridge_json/base/token/verify_tls/timeout/umo/poll_seconds`），
用户反馈「只看这个分不清到底怎么配置」。候选项：
- 把同机/远程两种部署写成 `object` 嵌套（`type: object` + `items`），或者
- 提供 `views/` 可视化页（`plugin-pages.md`），页面里直接给"同机一键填 / 远程填三项"的表单。

### 3. 其它已知缺口

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
