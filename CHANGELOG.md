# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.2.0] - 2026-10-27

### Changed

- **The CUA tools are no longer given to Coo by default.** `worlds.cua.exposeToBot` is `false`, so the
  bot's tool table stays clean and only the bridge (AstrBot) can use the screen. Turn it on if you
  want both.
- The bridge's `Host` allowlist is configurable (`worlds.cua.bridgeHosts`) so a reverse proxy or a
  named tunnel can reach it without weakening the loopback bind.

### Added

- Remote deployment: the plugin now takes `base` + `token` (+ `verify_tls`) for the case where
  AstrBot runs on a server and Coopanion on your own PC, with [docs/remote.md](docs/remote.md)
  covering SSH reverse tunnels, frp and HTTPS reverse proxies.

## [0.1.0] - 2026-10-27

### Added

- AstrBot plugin `astrbot_plugin_coopanion`: six LLM tools (`coopanion_screen`, `coopanion_windows`,
  `coopanion_click`, `coopanion_type`, `coopanion_key`, `coopanion_focus`) that return
  `mcp.types.CallToolResult` with `ImageContent`, so a multimodal model actually sees the screen.
- Coopanion World extension `cortico-world-cua` (`kind: world`, `api: 6`): PowerShell engine for
  capture and input, a native Yes/No approval box, and a token-guarded loopback bridge
  (`GET /v1/health`, `POST /v1/tool`) that the plugin talks to.
- Bridge discovery through `<deployment>/data/cua/bridge.json` (port + token, regenerated per start).
- `describe.json` generated from the tool specs (`npm run describe`), for the extension page and market.
- Offline smoke test for the plugin client (`tests/smoke_client.py`) and a bidirectional CI workflow.

### Notes

- Windows only: the engine is PowerShell + `System.Drawing` / `user32`, and the extension's
  `preflight` refuses other platforms.
- The tool coordinates are always pixels of the most recent screenshot.
