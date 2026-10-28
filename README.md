# astrbot_plugin_coopanion

[![CI](https://github.com/heerxingen/astrbot_plugin_coopanion/actions/workflows/ci.yml/badge.svg)](https://github.com/heerxingen/astrbot_plugin_coopanion/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

> 让 AstrBot 的 bot **通过 Coopanion 看（并操作）你的电脑**：截图、列窗口、点击、输入、按键、聚焦。
> 权限询问留在 Coopanion 桌面上的系统确认框里，不在插件里。

```
用户 → AstrBot 的模型 → coopanion_screen（工具）
     → 本插件 → 127.0.0.1:<port>/v1/tool（Bearer 令牌）
     → Coopanion（World 扩展「CUA」）→ 系统确认框「是/否」
     → PowerShell 截图/点击 → JPEG
     ← ImageContent（模型真的看得见）
```

## 直接下载部署

不用 clone，下两个 zip 就行（[最新 release](https://github.com/heerxingen/astrbot_plugin_coopanion/releases/latest)）：

| 文件 | 装到哪 | 怎么做 |
|---|---|---|
| `astrbot_plugin_coopanion-<版本>.zip` | AstrBot（服务器） | 解压到 `<AstrBot>/data/plugins/`，重启；或 Dashboard 插件页上传 |
| `cortico-world-cua-<版本>.zip` | Coopanion（你的电脑） | 解压，设置 → 扩展 → 手动安装 → 本机目录 → 选 `cortico-world-cua` 文件夹 → 重启进程 → World 总览启用 |

本地构建：`python scripts/build_dist.py` → 产物在 `dist/`。

## 它由两部分组成

| 部分 | 位置 | 说明 |
|---|---|---|
| **AstrBot 插件** | 本仓库根目录 | `main.py` / `client.py`，1 个聊天工具 + 8 个按扩展 schema 动态注册的 CUA/委托工具 |
| **Coopanion 扩展** | `coopanion-extension/` | 真正的 Cortico World 扩展（`kind: world, api 6`），带引擎与回环桥接 |

只装插件没有用：工具的实现（截图、点击、权限询问）在 Coopanion 那一半。

**这些工具默认只给桥接用，Coo 自己看不到也调不到**（`worlds.cua-bridge.exposeToBot` 默认关闭）。

## 安装

### 1. Coopanion 扩展

Coopanion 设置 → **扩展** → 手动安装 → **本机目录** → 选这个仓库的 `coopanion-extension/`
（或命令行：`cd "<Coopanion>\data\extensions" && corepack pnpm add "<本仓库路径>/coopanion-extension"`）

→ 重启进程 → **World 总览** → 启用 **CUA Bridge**。

启用后会出现一行桥接灯（`监听 127.0.0.1:17901`），并在部署目录写下：

```json
// <部署目录>/data/cua/bridge.json
{"port": 17901, "token": "…", "tools": ["cua_screenshot", "…"]}
```

找它的办法：`find "<Coopanion>\data\home" -name bridge.json`，或者看 Coopanion 的运行日志。

### 2. AstrBot 插件

把本仓库（根目录）放进 `<AstrBot>/data/plugins/astrbot_plugin_coopanion/`，或在 Dashboard 的插件页用仓库地址安装。
先在「部署方式」里选一种，页面只显示对应的一组字段：

| 部署方式 | 要填的 | 说明 |
|---|---|---|
| 同机部署 | `bridge_json` | AstrBot 和 Coopanion 在同一台电脑；填 `<Coopanion 部署目录>/data/cua/bridge.json` |
| 服务器 + SSH 隧道 | `base` + `token`（+ `verify_tls`） | AstrBot 在服务器、Coopanion 在你电脑；`base` 填隧道在服务器那一端的 `http://127.0.0.1:17901`，`token` 填你电脑上 `bridge.json` 里的 token |

公共项：`timeout`（默认 90 秒；首次确认框最多 60 秒，留余量）、`umo`（可选）、`poll_seconds`（0 = 不轮询）。

服务器部署的隧道命令（在你电脑上执行，不是服务器）：

```bash
ssh -N \
  -L 127.0.0.1:6185:127.0.0.1:6185 \
  -R 127.0.0.1:17901:127.0.0.1:17901 \
  user@your-server
```

- `-L 6185`：Coo → AstrBot OpenAPI（Coo 的 `chat.astrbotUrl` 填 `http://127.0.0.1:6185`）
- `-R 17901`：AstrBot → Coo 桥接（这里 `base` 填 `http://127.0.0.1:17901`）
- Coo 的桥接端口必须是 **17901**，别用 6185。

重启 AstrBot。模型需要是**多模态**的，否则图片白给。

> AstrBot 在服务器上、Coopanion 在你自己电脑上？看 **[docs/remote.md](docs/remote.md)**：
> SSH 反向隧道 / frp / HTTPS 反代三种接法，以及为什么桥接仍然只监听 `127.0.0.1`。

## 工具

| 工具 | 作用 | 回图 |
|---|---|---|
| `coopanion_screen` | 截一块显示器（画鼠标指针、附物理尺寸/指针坐标/前台窗口标题） | ✅ |
| `coopanion_windows` | 列可见顶层窗口 | ❌ |
| `coopanion_click` | 按最近一次截图的像素点击（带 `display`，多屏不会点错） | ❌ |
| `coopanion_type` | 在当前焦点输入文字（中文可用，与输入法无关） | ❌ |
| `coopanion_key` | 组合键，如 `ctrl+s`、`alt+f4` | ❌ |
| `coopanion_focus` | 把窗口切到前台 | ❌ |
| `coopanion_delegate` | 把多步电脑任务交给 Coo 在本机做，返回 job id | ❌ |
| `coopanion_job` | 查委托任务的进度与结果 | ❌ |
| `send_msg_to_coo` | 给 Coo 发一条消息（Coo 是用户电脑上的桌宠） | ❌ |

坐标语义：**永远是最近一次 `coopanion_screen` 的像素**。

插件不保存这些工具的 schema：启动时从扩展的 `GET /v1/tools` 拉，按 `coopanion_*` 注册（扩展里叫
`cua_*`，`cua_screenshot` 对应 `coopanion_screen`）。扩展加一个 `cua_*` 工具后重载插件即可，不用改
代码；扩展晚于 AstrBot 启动时，插件会退避重试直到注册成功。

## 两个 bot 聊天

Coo 在用户的电脑上，AstrBot 在服务器上，中间是隧道。两边各有一个工具：

| 方向 | 工具 | 怎么走 |
|---|---|---|
| AstrBot → Coo | `send_msg_to_coo` | 直接送进 Coo 的会话（正文带 `【AstrBot】` 前缀），发完就返回 |
| Coo → AstrBot | `send_msg_to_astrbot` | 配了 AstrBot OpenAPI 就直接对话并拿回复；没配就进信箱，插件每 `poll_seconds` 秒取一次 |

Coo 这边的方向在 Coopanion 里填 AstrBot 的 OpenAPI 地址和 `chat` scope 的 API Key；填了就直接
POST `/api/v1/chat`，回复通过 SSE 取回后**作为新消息送进 Coo 的会话**，下一轮再回；
可选 `chat.configId` 指定 AstrBot 的配置文件（留空走 default）。
没填就走信箱，插件轮询取。两条路都不需要 AstrBot 开放入站端口。

AstrBot 收到之后：配了 `umo` 就发到那个会话；没配 `umo` 就发到最近一次 `send_msg_to_coo` 的
会话。发送失败才挂进下一次该会话的请求（`<from_coo>…</from_coo>`），**不会注入别的会话**。

`coopanion_delegate` 给 AstrBot 一个"把任务交给 Coo"的入口：提交后拿 job id，用 `coopanion_job`
轮询。`allow_act=false` 时 Coo 只能看屏幕/窗口；动鼠标键盘会被拒绝。长任务不会撞 AstrBot 的
120 秒工具超时。

**谁是谁**在 Coopanion 里统一配置（设置 → CUA Bridge）：

| 键 | 作用 |
|---|---|
| `worlds.cua-bridge.names.coo` | 桌宠叫什么 |
| `worlds.cua-bridge.names.astrbot` | 另一个 bot 叫什么 |
| `worlds.cua-bridge.names.user` | 坐在这台电脑前的人叫什么（留空时读启动引导里填的名字） |

这些只影响 CUA 的提示词与工具描述；AstrBot 的展示名、Coopanion 本体都不变。插件启动时从
`GET /v1/identity` 读同一套名字。

插件配置：

| 配置项 | 说明 |
|---|---|
| `umo` | Coo 的消息投递到哪个会话（`unified_msg_origin`）；留空则用最近一次 `send_msg_to_coo` 的会话 |
| `poll_seconds` | 多久取一次信箱（默认 30 秒，0 = 不轮询；配了 OpenAPI 后信箱只是兜底） |

### 想改 CUA 的环境提示词？

Coopanion 设置里的「系统提示词」页可以编辑它（就是带 `cua.coo` / `cua.astrbot` /
`cua.user` 变量的那份）。保存过一次之后，编辑器底部会出现**「重置为 World 自带版本」**，
点它就能恢复默认——这个按钮是 Coopanion 自带的行为，只有在你覆盖过之后才显示。

## 权限

| 档位 | 行为 |
|---|---|
| `ask-each-command` | 每次调用前弹系统确认框 |
| `ask-each-turn` | 每轮第一次调用前问一次 |
| `ask-once`（默认） | 问一次，30 分钟内不再问 |
| `never-ask` | 不问 |

读写分开：`askRead` 管截图/列窗口，`askAct` 管点击/输入/按键/切窗口，留空跟随 `ask`。
动键鼠前还会等使用者停手（`actIdleMs` / `actWaitMs`），一直在用电脑就放弃这次操作。

确认框是 **Windows 原生 MessageBox**，默认按钮是「否」，**关掉窗口或 60 秒不答都算拒绝**；
拒绝在本轮内一直有效，模型换个写法重试也没用。这些都在 Coopanion 侧执行，插件无法绕过。

## 安全边界

- 桥接只监听 `127.0.0.1`，并校验 `Host` 头（默认只认回环名，反代时把公网域名加进
  `worlds.cua-bridge.bridgeHosts`）——浏览器里的网页打不到。
- 令牌首次生成后重启不变，写在 `bridge.json`（0600；Windows 上这个位不生效，靠部署目录 ACL）。
  **任何能读这个文件的本机进程都能驱动鼠标键盘**，和"允许电脑操作"是同一级别的授权。
- 插件不含任何"跳过确认"的开关。

## 平台与限制

- **仅 Windows**：引擎是 PowerShell + `System.Drawing` / `user32`；`preflight` 在其它平台直接拒绝。
- 引擎每次调用起一个 PowerShell 进程（约 250–500 ms）。够用；要更快可以换 koffi + GDI。
- 没有 `zoom` / `wait`、没有"动作后自动截图"——需要就再截一次。

## 排错

| 现象 | 原因 |
|---|---|
| `连不上 Coopanion 的 CUA 桥接` | Coopanion 没开 / 扩展没启用 / 端口变了 |
| `401` | 令牌过期：重启 Coopanion 重写 `bridge.json`，再重启 AstrBot |
| `读不到 bridge.json` | 配置里的 `bridge_json` 路径不对（便携安装不在 `%USERPROFILE%\.coopanion` 下） |
| 一直没回执 | Coopanion 在等你点确认框；把 `timeout` 调大 |
| 工具不出现 | 插件没加载（看 AstrBot 日志）或模型没开工具调用 |

## 开发与测试

```bash
# 插件这一半（不需要 AstrBot 在跑）
python -m py_compile main.py client.py
python tests/smoke_client.py            # 对着假桥接验发现 / 令牌 / 回执 / 401

# 扩展这一半（需要 Node 22）
cd coopanion-extension
npm ci
npm run check        # tsc --noEmit + 重新生成 describe.json 并确认没有漂移
```

CI（`.github/workflows/ci.yml`）在 Windows runner 上跑同样的两件事，外加两个 `.ps1` 的语法解析。

## 目录

```
astrbot_plugin_coopanion/        ← AstrBot 插件（仓库根）
├── main.py                    1 个聊天工具 + 8 个动态 CUA/委托工具
├── client.py                  bridge.json 发现 + HTTP 调用
├── _conf_schema.json
├── metadata.yaml
├── requirements.txt
├── tests/smoke_client.py      客户端离线冒烟
├── coopanion-extension/       ← 另一半：Coopanion World 扩展
│   ├── package.json           kind: world, api 6（cortico 作 devDependency）
│   ├── describe.json          npm run describe 生成
│   ├── src/{index,definition,config,world,bridge,engine}.ts
│   └── scripts/{cua,ask}.ps1, gen-describe.ts
├── docs/                      调研与设计；remote.md 是服务器部署的接法
└── .github/workflows/ci.yml
```

## 许可

MIT。Coopanion / Cortico 是 AGPL-3.0，本仓库不包含它们的代码，只按它们公开的扩展契约调用。