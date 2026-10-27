# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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