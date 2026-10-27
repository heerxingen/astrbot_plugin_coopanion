# Changelog

## 0.2.0 — 2026-10-27

### 变更

- **默认不再把 CUA 工具交给 Coo**：`tools()` 在 `worlds.cua.exposeToBot` 关闭时返回空数组，
  `envPromptVars()` 也随之清空。Coo 的工具表里不再出现 `cua_*`，只有回环桥接能调用。
- 桥接的 Host 白名单可配置（`worlds.cua.bridgeHosts`，默认 `127.0.0.1,localhost,[::1]`），
  反代 / 具名隧道进来时不必放宽监听地址。

### 新增

- 供远程部署使用：桥接仍只绑 `127.0.0.1`，由本机这一端的 SSH 反向隧道 / frp / 反代终结，
  配合 AstrBot 插件侧的 `base` + `token` 使用。

## 0.1.0 — 2026-10-27

首个版本。

### 新增

- 六个工具：`cua_screenshot`、`cua_windows`、`cua_click`、`cua_type`、`cua_key`、`cua_focus`。
- PowerShell 引擎（`scripts/cua.ps1`）：每调用一个进程，JSON 进 JSON 出；进程级
  `SetProcessDpiAwarenessContext(-4)` 保证截图像素等于物理像素。
- 系统「是/否」确认框（`scripts/ask.ps1`），默认按钮是「否」，60 秒不答按拒绝，拒绝在本轮内一直有效；
  四档 `worlds.cua.ask`。
- 回环桥接（`src/bridge.ts`）：`127.0.0.1` + Bearer 令牌 + Host 校验，`GET /v1/health`、`POST /v1/tool`；
  端口与令牌写进 `<部署目录>/data/cua/bridge.json`。
- `describe.json`（`npm run describe` 生成）。

### 已知限制

- 只有 Windows 实现；macOS / Linux 会在 `preflight` 被拒绝。
- 没有 `zoom` / `wait`，也没有"动作后自动截图"。
