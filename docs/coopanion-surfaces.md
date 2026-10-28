# Coopanion 侧：它到底对外暴露了什么

> 调研对象：@D:\Download\CodingSpace\Coopanion（浅克隆 main @ fcb735e，v0.2.12），
> 以及它的子模块 @D:\Download\CodingSpace\Coopanion\vendor\cortico（Cortico 内核 @ cd41f48）。
> 每条结论都标了 文件:行号。

## 1. 架构

| 单元 | 职责 |
|---|---|
| `app/main.cjs` | Electron 主进程：托盘、设置窗口、Core 子进程托管、桌宠窗口、更新器 |
| `app/core-host.cjs` | fork `core/boot.ts`（`--import tsx`），崩溃重启，经 IPC 收 `companion:ready { port }` |
| `core/` | Core 进程：装配 Persona（Cormini）+ Worlds + providers，起 WebUI |
| `console/` | 设置窗口前端，**只经 Core 的 WebUI HTTP API** 读写 |
| `packages/cortico-world-desktop-pet` | 桌宠 World，含 `src/cua/` 电脑操作 |
| `packages/cortico-provider-coo` | 模型 provider（DeepSeek 等） |
| `vendor/cortico` | Cortico 内核（子模块）：World 契约、WebUI、扩展加载 |

World = 一个可插拔扩展单元，提供 `defaults() / create() / describe()`，实例提供
`tools() / envPromptVars() / webUi()`（`vendor/cortico/src/world.ts:50-70`，
`docs/extensions.md` 全文）。桌宠 World 的入口是
`packages/cortico-world-desktop-pet/src/definition.ts:96-133`。

## 2. 今天存在的、可被外部进程调用的东西

全仓 **没有 MCP、没有 stdio JSON-RPC、没有命名管道/Unix socket**（`grep -rn "mcp|jsonrpc|\.\\pipe"` 零命中）。
只有两个 HTTP 服务：

### 2.1 Core 的 WebUI HTTP API（唯一通用接口）

- 端口：`CONSOLE_PORT = 17788`（`core/seed.ts:12`），写进 config `web.port`；被占用则向上递增
  （`core/companion.ts:596-597`）。
- 只监听 `127.0.0.1`（Cortico `web.host` 默认值，`docs/webui.md`「WebUI」一节）。
- 鉴权：默认 **没有令牌**；可选访问密码（401 + `x-cortico-auth`，`console/base/api.ts:40-42`）。
- 同源检查：**带外部 Origin 的写请求 403，不带 Origin 的放行**
  （`tests/console-api.test.ts:303-306`；`core/guide.ts:155-165` 自己就不发 Origin）。
- 公开路由表见 `vendor/cortico/docs/webui.md`「HTTP API 的公开范围」。
- 面板方法（World → 外部）：`POST /api/webui/providers/<pageId>/panels/<panelId>/<method>`，
  body `{"args":[...]}`（`console/base/protocol.ts:21-28`）。

### 2.2 桌宠页服务器 PetServer（页面协议，不是通用 API）

- `127.0.0.1` only，端口 `worlds.desktop-pet.port` 默认 **7797**，被占 +1 重试 10 次
  （`src/config.ts:266`，`src/server.ts:140-159`）；Host 头必须 loopback（`src/server.ts:53`）。
- 路由只有 `/pet /dress /overlay /figure-frame /web/* /packs/* /api/{state,avatar,speech,skin,prefs,figures*}`
  和 WS `/socket?role=pet|dress|overlay`。**没有任何 cua 路由。**

## 3. 电脑操作（CUA）的实现

- 声明：`src/cua/tools.ts:24-129`，共 11 个工具（screenshot / zoom / click / move / drag / scroll /
  type / key / windows / focus / wait），关闭时只有 `pet_cua_open_settings`（`tools.ts:15-22`）。
- 绑定：`src/cua/cua.ts:370-398` `tools()`；汇总进 World：`src/world.ts:1728-1741`。
- 执行：**Core 进程里 fork 一个 engine 子进程**（`src/cua/cua.ts:1-30` 模块头，
  `engine-child.ts`），Windows 上走 koffi + GDI `BitBlt` 截图（`engine/win32.ts:105-126`）、
  `EnumWindows` 列窗口（`win32.ts:220-241`）。
- 权限闸门（三处，都在 cua.ts）：
  - 每次引擎请求前 `permit('see'|'act')`（`cua.ts:236-238`）；
  - 四档 `permission`：`ask-each-turn / ask-before-acting / ask-once / never-ask`（`cua.ts:264-284`），
    问句走桌宠气泡，气泡不可用时退回系统对话框（`cua.ts:286-301`）；
  - `control=false` 时输入类工具全部失败（`cua.ts:459-462`）。
- 让位：输入前要求用户空闲 `userIdleMs`，最多等 `maxYieldWaitMs`（`cua.ts:1-30` 模块头）。
- 默认值：`enabled=false, control=true, permission='ask-once', grantMinutes=30,
  screenshot{1280×800, q75, afterAction, settleMs=500}`（`src/cua/config.ts:45-57`），
  键前缀 `worlds.desktop-pet.cua`。
- 回执：`ToolOutcome { text, failed?, blobs? }`；截图放在 `blobs` 里，**JPEG 字节不是 base64**
  （`cua.ts:434`）。

## 4. 扩展机制（如果不想改内置 World）

- 扩展 = npm 包 + package.json 的 `cortico` 字段：
  `{"kind":"world","api":6,"displayName":...,"describe":"describe.json"}`（见 `docs/extensions.md`）。
- 加载：`core/companion.ts:539-547` `loadExtensions(repoRoot(), {...})`；目录由
  `CORTICO_EXTENSIONS_DIR` 决定（`core/boot.ts:27`）。
- 扩展能塞新工具（`tools()`），但 **World 之间没有互调 API**，拿不到桌宠 World 里的 `Cua` 实例
  （`src/core/types.ts:679-740` 的 `WorldHost` 只有事件/存储/blob/用量，没有"调用另一个 World 的工具"）。
- 扩展代码在 Core 进程内运行，**没有沙箱**；产品规则禁止扩展借用 Coopanion 的 UI 与 Electron 运行时
  （`docs/DEVELOPMENT.md:62-71`）。

## 5. 结论：今天能做什么、不能做什么

**今天就能从外部做**（只用 WebUI API，零改动）：

| 能力 | 端点 |
|---|---|
| 读状态/配置/World 清单/工具 schema | `GET /api/status`、`/api/config`、`/api/worlds`、`/api/tool-schemas` |
| 改配置（含打开电脑操作） | `POST /api/config {group, values}` |
| 取桌宠页地址与窗口状态 | `POST /api/webui/providers/world%3Adesktop-pet/panels/pet/state` |
| 读事件/日志/会话、暂停继续关机 | `/api/events`、`/api/log`、`/api/runs`、`/api/run/{pause,resume,shutdown}` |

**今天做不到**：截图、列窗口、鼠标键盘 —— 没有任何端点，CUA 只活在「模型 → 工具」链路里。

所以「让 AstrBot 通过 Coopanion 看电脑」必须给 Coopanion 打一个小补丁：把 CUA 挂到已有的
面板方法上。见 `../../coopanion-astrbot-plugin/prototype/coopanion-bridge/PATCH.md`。

## 6. 三条备选路线，各自的真实代价

| 路线 | 能复用权限/让位吗 | 改动量 | 适合 |
|---|---|---|---|
| 面板方法补丁（推荐） | ✅ 全部 | ~30 行 + 1 个新文件 | 自用、快速验证 |
| 独立 World 扩展 | ❌ 要自带一套 OS 调用与询问 | 一个完整扩展包 | 想发到扩展市场、不碰主干 |
| 外部自己 pyautogui/mss | ❌ 全绕开 | 一个 AstrBot 插件 | 只要"能看能点"，不在乎一致性 |
