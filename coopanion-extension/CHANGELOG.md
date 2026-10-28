# Changelog

## 0.4.0 — 2026-10-28

### 新增

- `cua_delegate` / `cua_job`：把一个多步电脑任务交给 Coo 的模型在本机做；`allow_act=false` 时
  任务里只能截图/列窗口，动作工具会被拒绝。任务用 `cua.task` 事件进入 Coo 的会话。
- `worlds.cua-bridge.chat.*`：Coo 直接 POST AstrBot 的 `/api/v1/chat`（`chat` scope API Key、
  `username=coo`、独立 session），回复通过 SSE 取回后作为新消息进 Coo 的会话，下一轮再回；
  `chat.configId` 可选指定 AstrBot 配置文件，留空走 default。没填 URL 时仍走信箱。
- 确认框改成置顶的独立窗口（之前 MessageBox 可能被其他窗口挡住，60 秒无操作按拒绝）；
  打不开时写日志并按“确认框没能显示”报错，不再伪装成使用者点了否。
- 读/写分档 `askRead` / `askAct`，动键鼠前等使用者停手（`actIdleMs` / `actWaitMs`）。

### 变更

- World id 从 `cua` 改为 `cua-bridge`（配置段 `worlds.cua-bridge.*`）；`worlds.cua` 会被 Coopanion
  自己的迁移并进桌宠并删除，升级后需要重新启用并重填设置。`bridge.json` 仍在 `<部署目录>/data/cua/`。
- `cua_click` 接受 `display`，按最近一次 `cua_screenshot` 的坐标帧把截图像素换算回屏幕坐标；
  没有截图或坐标越界直接失败，不再默认点左上角。
- `describe.json` 改为从 `CUA.describe` 生成，包含 `cua.message` 与 `cua.task` 事件。
- 桥接令牌首次生成后重启复用；`bridge.json` 不再在停止时删除。
- `names.user` 留空时自动读 `worlds.desktop-pet.user`（启动引导里填的名字），不再固定叫「使用者」；
  本 World 的 `names.user` 仍然优先。
- 新增 `GET /v1/tools`：返回 6 个 `cua_*` 工具的名字、描述、JSON Schema 与 tags；`/v1/health`
  带 `protocol: 1`，插件按它握手。

### 修复

- 截图被缩放到 1280×800 后点击坐标没有反算，点击会落偏；多屏还会整体偏到第一块屏。
- `cua_type` 把 UTF-16 码元拆成两个 `keybd_event` 事件，中文会被拆成两个字符；改用 `SendInput`。
- `describeShot` 的物理尺寸固定取第一块屏，第二块屏会报错主屏尺寸。

## 0.3.1 — 2026-10-27

### 变更

- `send_msg_to_astrbot` 只写信箱，不再尝试 HTTP POST；删掉 `worlds.cua.chat.*` 两个配置。
- 环境提示词模板里直接列出另一个 bot 的名字，并去掉与 `cua.chat` 重复的一行。

## 0.3.0 — 2026-10-27

### 新增

- `send_msg_to_astrbot` 工具：Coo 给隧道另一头的 AstrBot 发消息。**默认就给它**（与 CUA 屏幕工具是否开放无关）。
- 身份配置 `worlds.cua.names.{coo,astrbot,user}`：写进本 World 的提示词与工具描述，
  让 Coo 分得清"我、另一个人、坐在这台电脑前的人"。只影响 CUA，不改其它 World 或 AstrBot 自己。
- 环境提示词模板（`src/ENV_PROMPT.md`，可在 WebUI 里看）说明：谁是谁、谁是 `【AstrBot】` 开头的消息、
  怎么回信。
- 桥接新路由：`GET /v1/identity`（名字与能力）、`POST /v1/chat`（把 AstrBot 的话送进 Coo 的会话）、
  `GET /v1/mailbox`（AstrBot 取走 Coo 在它不在时留下的消息）。
- `cua.message` 事件：来自 AstrBot 的消息进入 Coo 的会话，正文带发送者名字。

### 变更

- `worlds.cua.chat.{astrbotUrl,token}`：有直连地址就 HTTP POST 过去，没有就进信箱，AstrBot 下次来取。
- 桥接现在**拒绝非 UTF-8 的请求体**，而不是把它解成乱码存进会话。

### 修复

- `ask-*` 档位被拒绝后不再永久粘住：一次拒绝只在当前这一轮内有效，桥接下次调用会重新问。

## 0.2.0 — 2026-10-27

### 变更

- **默认不再把 CUA 工具交给 Coo**：`tools()` 在 `worlds.cua.exposeToBot` 关闭时只返回聊天工具，
  `envPromptVars()` 也随之只保留身份段。Coo 的工具表里不再出现 `cua_*`，只有回环桥接能调用。
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
- 系统「是/否」确认框（`scripts/ask.ps1`），默认按钮是「否」，60 秒不答按拒绝。
- 回环桥接（`src/bridge.ts`）：`127.0.0.1` + Bearer 令牌 + Host 校验。
- `describe.json`（`npm run describe` 生成）。

### 已知限制

- 只有 Windows 实现；macOS / Linux 会在 `preflight` 被拒绝。
- 没有 `zoom` / `wait`，也没有"动作后自动截图"。