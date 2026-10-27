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
| **AstrBot 插件** | 本仓库根目录 | `main.py` / `client.py`，6 个 `filter.llm_tool` 工具 |
| **Coopanion 扩展** | `coopanion-extension/` | 真正的 Cortico World 扩展（`kind: world, api 6`），带引擎与回环桥接 |

只装插件没有用：工具的实现（截图、点击、权限询问）在 Coopanion 那一半。

**这些工具默认只给桥接用，Coo 自己看不到也调不到**（`worlds.cua.exposeToBot` 默认关闭）。

## 安装

### 1. Coopanion 扩展

Coopanion 设置 → **扩展** → 手动安装 → **本机目录** → 选这个仓库的 `coopanion-extension/`
（或命令行：`cd "<Coopanion>\data\extensions" && corepack pnpm add "<本仓库路径>/coopanion-extension"`）

→ 重启进程 → **World 总览** → 启用 **CUA**。

启用后会出现一行桥接灯（`监听 127.0.0.1:17901`），并在部署目录写下：

```json
// <部署目录>/data/cua/bridge.json
{"port": 17901, "token": "…", "tools": ["cua_screenshot", "…"]}
```

找它的办法：`find "<Coopanion>\data\home" -name bridge.json`，或者看 Coopanion 的运行日志。

### 2. AstrBot 插件

把本仓库（根目录）放进 `<AstrBot>/data/plugins/astrbot_plugin_coopanion/`，或在 Dashboard 的插件页用仓库地址安装。
然后在插件配置里填：

| 配置项 | 值 |
|---|---|
| `bridge_json` | **同机部署**：上面那个 `bridge.json` 的完整路径 |
| `base` | **远程部署**：隧道/反代给 AstrBot 的地址，如 `http://127.0.0.1:17901` 或 `https://coopanion.example.com` |
| `token` | **远程部署**：bridge.json 里的 token（隧道尽头没有文件可读） |
| `verify_tls` | 默认开；只有自签证书才关 |
| `timeout` | 60（Coopanion 首次会弹框等人点） |

重启 AstrBot。模型需要是**多模态**的，否则图片白给。

> AstrBot 在服务器上、Coopanion 在你自己电脑上？看 **[docs/remote.md](docs/remote.md)**：
> SSH 反向隧道 / frp / HTTPS 反代三种接法，以及为什么桥接仍然只监听 `127.0.0.1`。

## 工具

| 工具 | 作用 | 回图 |
|---|---|---|
| `coopanion_screen` | 截一块显示器（画鼠标指针、附物理尺寸/指针坐标/前台窗口标题） | ✅ |
| `coopanion_windows` | 列可见顶层窗口 | ❌ |
| `coopanion_click` | 移到截图坐标并点击 | ❌ |
| `coopanion_type` | 在当前焦点输入文字（中文可用，与输入法无关） | ❌ |
| `coopanion_key` | 组合键，如 `ctrl+s`、`alt+f4` | ❌ |
| `coopanion_focus` | 把窗口切到前台 | ❌ |
| `send_msg_to_coo` | 给 Coo 发一条消息（Coo 是用户电脑上的桌宠） | ❌ |

坐标语义：**永远是最近一次 `coopanion_screen` 的像素**。

## 两个 bot 聊天

Coo 在用户的电脑上，AstrBot 在服务器上，中间是隧道。两边各有一个工具：

| 方向 | 工具 | 怎么走 |
|---|---|---|
| AstrBot → Coo | `send_msg_to_coo` | 直接送进 Coo 的会话（正文带 `【AstrBot】` 前缀），发完就返回 |
| Coo → AstrBot | `send_msg_to_astrbot` | 消息进 Coo 侧的信箱，插件每 `poll_seconds` 秒取一次 |

Coo 这边的方向不需要 AstrBot 暴露任何接口：没有 webhook、没有入站端口，所以在只有一条隧道的
部署里也能用（服务器不开放入口）。

AstrBot 收到之后：配了 `umo` 就在那个会话里以「`Coo：…`」发出，同时挂进下一次请求的
user 内容（`<from_coo>…</from_coo>`），模型一定看得到。

**谁是谁**在 Coopanion 里统一配置（设置 → CUA）：

| 键 | 作用 |
|---|---|
| `worlds.cua.names.coo` | 桌宠叫什么 |
| `worlds.cua.names.astrbot` | 另一个 bot 叫什么 |
| `worlds.cua.names.user` | 坐在这台电脑前的人叫什么 |

这些只影响 CUA 的提示词与工具描述；AstrBot 的展示名、Coopanion 本体都不变。插件启动时从
`GET /v1/identity` 读同一套名字。

插件配置：

| 配置项 | 说明 |
|---|---|
| `umo` | Coo 的消息投递到哪个会话（`unified_msg_origin`） |
| `poll_seconds` | 多久取一次信箱（默认 30 秒，0 = 不轮询） |

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

确认框是 **Windows 原生 MessageBox**，默认按钮是「否」，**关掉窗口或 60 秒不答都算拒绝**；
拒绝在本轮内一直有效，模型换个写法重试也没用。这些都在 Coopanion 侧执行，插件无法绕过。

## 安全边界

- 桥接只监听 `127.0.0.1`，并校验 `Host` 头（默认只认回环名，反代时把公网域名加进
  `worlds.cua.bridgeHosts`）——浏览器里的网页打不到。
- 每次启动重新生成 32 字节令牌，写在 `bridge.json`（0600）。**任何能读这个文件的本机进程
  都能驱动鼠标键盘**，和"允许电脑操作"是同一级别的授权。
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
├── main.py                    6 个 LLM 工具
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