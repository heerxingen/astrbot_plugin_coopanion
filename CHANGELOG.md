# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.4.0] - 2026-10-28

### Added

- `coopanion_delegate` / `coopanion_job`：把多步电脑任务交给 Coo 的模型在本机做，返回 job id 后轮询；
  `allow_act=false` 时任务只能看不能动，长任务不会撞 AstrBot 的 120 秒工具超时。
- Coo 可以在 Coopanion 里填 AstrBot OpenAPI 地址与 `chat` scope 的 API Key，直接 POST
  `/api/v1/chat` 并把回复作为工具结果；没填时继续走信箱。

### Changed

- World id 从 `cua` 改为 `cua-bridge`（配置段 `worlds.cua-bridge.*`）。`worlds.cua` 会被 Coopanion
  自己的迁移并进桌宠并删除，升级后要在 World 总览重新启用，`ask` / `names` 等设置也要重填；
  `bridge.json` 的位置不变。
- `coopanion_click` 增加 `display`，坐标按最近一次 `coopanion_screen` 的坐标帧换算；缺少坐标时
  直接报错，不再默认点 `(0, 0)`。
- 扩展的 `names.user` 留空时读 Coo 启动引导里填的名字（`worlds.desktop-pet.user`），不再固定
  叫「使用者」。
- 插件不再手写 6 个 CUA 工具：启动时拉扩展的 `GET /v1/tools`，按 schema 注册 `coopanion_*`
  （`cua_screenshot` → `coopanion_screen`）。扩展加工具只改扩展；扩展晚启动时插件退避重试注册。
- 插件配置页先选「同机部署」或「服务器 + SSH 隧道」，只显示对应字段；配置里仍保留旧的平铺项，
  但按部署方式过滤。
- 读屏幕和动键鼠分开授权（`askRead` / `askAct`），动键鼠前等使用者停手；桥接令牌首次生成后重启
  不再变化。
- Coo 的消息只送进配置的 `umo` 或最近一次 `send_msg_to_coo` 的会话，发送失败才注入该会话；
  poller 在桥接晚启动时也会跑。

### Fixed

- 截图缩放后点击坐标没有反算，屏幕大于 1280×800 时点击位置偏移；多屏下还会整体偏到第一块屏。
- `cua_type` 把 UTF-16 码元拆成两个 `keybd_event` 事件，中文会被拆成两个字符；改用 `SendInput` 的
  Unicode 模式。
- `describeShot` 的物理尺寸固定取第一块屏，第二块屏会报错主屏尺寸。

## [0.3.1] - 2026-10-27

### Changed

- Coo 主动找 AstrBot 只走信箱：删掉 `worlds.cua.chat.*` 与插件里的 webhook / `coo_token`。
  AstrBot 的插件 Web API 挂在 Dashboard 鉴权后面，隧道另一头打不进来；信箱这一条不需要任何入站入口。
- 插件配置项改成"短标题 + 悬浮说明"，不再把整句说明当标签（Dashboard 里会被截断）。

### Fixed

- CUA 环境提示词模板里现在直接写出另一个 bot 的名字，不再只藏在折叠的变量里；重复的一行也去掉了。

## [0.3.0] - 2026-10-27

### Added

- **The two bots can talk.** `send_msg_to_coo` on the AstrBot side, `send_msg_to_astrbot` on the Coo
  side. AstrBot's tool is a plain send: Coo's answer arrives later as a `Coo：…` message, which the
  plugin injects into the next request.
- `worlds.cua.names.{coo,astrbot,user}`: the one place that says who is who. Both prompts and both
  tool descriptions use those names, so neither bot confuses itself with the other or with the person.
  They only affect the CUA World.
- Identity block in AstrBot's system prompt (who I am, who Coo is, what a `Coo：…` line means).
- Extension: `GET /v1/identity`, `POST /v1/chat`, `GET /v1/mailbox`, the `cua.message` event, and a
  rendered environment-prompt template (`src/ENV_PROMPT.md`).
- Plugin: `umo` / `coo_token` / `poll_seconds` config, the `/astrbot_plugin_coopanion/coo/message`
  webhook, and a mailbox poller for when Coo cannot reach AstrBot directly.

### Changed

- `send_msg_to_coo` sends by default (`wait_seconds=0`); waiting in place is opt-in, because Coo
  answers through its own tool rather than in the same HTTP call.
- The bridge rejects request bodies that are not UTF-8 instead of storing mojibake.

### Fixed

- A refusal in an `ask-*` mode no longer sticks forever: it lasts for the current turn only.

## [0.2.0] - 2026-10-27

### Changed

- The CUA screen tools are no longer given to Coo by default (`worlds.cua.exposeToBot` is `false`);
  only the bridge (AstrBot) can use them.
- The bridge's `Host` allowlist is configurable (`worlds.cua.bridgeHosts`) for reverse proxies.

### Added

- Remote deployment: `base` + `token` (+ `verify_tls`) for AstrBot-on-a-server, with
  [docs/remote.md](docs/remote.md).

## [0.1.0] - 2026-10-27

### Added

- AstrBot plugin `astrbot_plugin_coopanion`: six LLM tools that return `mcp.types.CallToolResult`
  with `ImageContent`, so a multimodal model actually sees the screen.
- Coopanion World extension `cortico-world-cua`: PowerShell engine, native Yes/No approval box,
  token-guarded loopback bridge.
- `describe.json` generated from the tool specs, an offline client smoke test, and a CI workflow.

### Notes

- Windows only.