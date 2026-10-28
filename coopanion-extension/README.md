# cortico-world-cua

给 Coopanion 的 **Cortico World 扩展**（`kind: "world", api: 6`，id `cua-bridge`）：把"看屏幕 / 点 / 打字"变成工具，
让 Coo 能用，也让**本机其他程序**（AstrBot、脚本、别的 agent）能通过一个带令牌的回环 HTTP 服务用。

不是改内置 World，也不是打补丁：它走的就是扩展页那套安装流程。

**默认不给 Coo 用**：这些工具只出现在回环桥接上，Coo 的工具表里没有它们
（`worlds.cua-bridge.exposeToBot` 打开才会有）。

## 它做什么

| 工具 | 作用 | 回图 |
|---|---|---|
| `cua_screenshot` | 截一块显示器，画出鼠标指针，附物理尺寸 / 指针坐标 / 前台窗口标题 | ✅ JPEG |
| `cua_windows` | 列可见的顶层窗口（标题、pid、位置尺寸、最小化、前台） | ❌ |
| `cua_click` | 按最近一次截图的 (x, y) 点击（带 `display`，多屏按截图帧换算） | ❌ |
| `cua_type` | 在当前焦点输入文字（BMP 字符含中文，与输入法无关） | ❌ |
| `cua_key` | 组合键，如 `ctrl+s`、`alt+f4`、`ctrl+a delete` | ❌ |
| `cua_focus` | 把窗口切到前台 | ❌ |
| `send_msg_to_astrbot` | 给隧道另一头的 AstrBot 发一条消息（**默认就有**，不受 `exposeToBot` 影响） | ❌ |
| `cua_delegate` | 把一个多步电脑任务交给 Coo 的模型在本机做，返回 job id（**只给桥接**） | ❌ |
| `cua_job` | 查 `cua_delegate` 的结果（**只给桥接**） | ❌ |

引擎是 `scripts/cua.ps1`：每次调用起一个 PowerShell 进程，JSON 进 JSON 出。
进程级 `SetProcessDpiAwarenessContext(-4)` 保证截到的图是物理像素；截图会按 `screenshot.max*` 缩放，
所以回执里带一个坐标帧（显示器原点 + 缩放），`cua_click` 按这个帧把截图像素换算回屏幕坐标。
没有原生依赖，不需要 koffi，不需要编译。

## 安装（Coopanion 里）

1. 设置窗口 → **扩展** → 手动安装 → 选「本机目录」，指到本目录（`coopanion-extension`）。
   也可以命令行：`cd "<Coopanion>/data/extensions" && corepack pnpm add "D:\...\cortico-world-cua"`
2. 重启 Coopanion（扩展页的「重启进程」）。
3. **World 总览** → 启用 **CUA Bridge**。
4. 设置里会出现一节「CUA（看屏幕 / 点 / 打字）」，按需调「什么时候先问你」。

> 从 0.3.x 升级：World id 从 `cua` 改成 `cua-bridge`，配置前缀变成 `worlds.cua-bridge.*`。
> `worlds.cua` 会被 Coopanion 自己的迁移并进桌宠并删除，所以重启后要重新启用 **CUA Bridge**，
> `ask` / `names` 等设置也要重填。`bridge.json` 的位置不变。

> 本扩展 `os: ["win32"]`：截图/点击走 user32 + System.Drawing，目前只有 Windows 实现。

## 给外部程序用的桥

`worlds.cua-bridge.bridge` 打开时（默认开），World 启动即在 `127.0.0.1:<port>` 上起服务，
并把**实际端口和令牌**写进部署数据目录的 `cua/bridge.json`（`<部署目录>/data/cua/bridge.json`，权限 0600）：

```json
{ "port": 17901, "token": "…", "tools": ["cua_screenshot", "…"] }
```

`port` 被占用会顺延（最多试 10 个），所以**永远从文件里读端口**，别写死。

```
GET  /v1/health              -> {"ok":true,"protocol":1,"world":"cua-bridge","port":17901,"tools":[…]}
GET  /v1/tools               -> {"ok":true,"protocol":1,"tools":[{name, description, parameters, tags}]}
POST /v1/tool  {"name":"cua_screenshot","args":{"display":1}}
     -> {"ok":true,"failed":false,"text":"屏幕 1（…）","blobs":[{"mime":"image/jpeg","base64":"…"}]}
```

```bash
curl -s -H "Authorization: Bearer $(cat "<部署目录>/data/cua/bridge.json" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>console.log(JSON.parse(s).token))")" \
     http://127.0.0.1:17901/v1/health
```

## 安全边界

- 只监听 `127.0.0.1`，并校验 `Host` 头是回环名（浏览器里的网页也打不到）。
- 没有令牌一律 401；令牌首次生成后**重启不变**（写在同一份 `bridge.json` 里），远程 AstrBot 的 token 不用重抄。
- 文件权限写的是 0600；Windows 上这个位不生效，实际保护来自部署目录的 ACL，别把 Coopanion 装在所有人可读的目录。
- 桥接调用走的是**同一个** `call()`，所以「什么时候先问你」对它一样生效：
  ask-once 下第一次会弹系统确认框，你点「否」就什么也不做。
- `never-ask` 只应在你完全信任调用方时开。

## 配置（`worlds.cua-bridge.*`）

| 键 | 默认 | 说明 |
|---|---|---|
| `enabled` | false | World 总览里的开关 |
| `exposeToBot` | false | 是否把 6 个 `cua_*` 工具也给 Coo（默认只给桥接） |
| `names.coo` / `names.astrbot` / `names.user` | Coo / AstrBot / 引导里填的名字 | 提示词与工具描述里怎么称呼这三个角色；`names.user` 留空时读 `worlds.desktop-pet.user`，再空才叫「使用者」 |
| `bridge` | true | 是否在 `127.0.0.1` 上开桥接 |
| `port` | 17901 | 桥接端口，0 = 随便挑；占用会顺延 |
| `bridgeHosts` | 127.0.0.1,localhost,[::1] | 桥接允许的 Host（反代时加公网域名，端口忽略） |
| `ask` | ask-once | 默认档位；`askRead` / `askAct` 留空时用它 |
| `askRead` | 空 | 看屏幕的档位；空 = 跟随 `ask` |
| `askAct` | 空 | 动键鼠的档位；空 = 跟随 `ask` |
| `grantMinutes` | 30 | ask-once 的同意有效期（读写各自计算） |
| `actIdleMs` / `actWaitMs` | 1500 / 5000 | 动键鼠前等使用者停手；等不到就放弃 |
| `chat.astrbotUrl` / `chat.apiKey` | 空 | AstrBot OpenAPI；填了就直接对话，留空走信箱 |
| `chat.username` / `chat.sessionId` / `chat.waitMs` | coo / coo-astrbot / 90000 | 直连对话的身份、会话与等待上限 |
| `chat.configId` | 空 | AstrBot 的 config_id（Dashboard → 配置文件里的 id）；留空走 default |
| `timeoutMs` | 30000 | 单次调用超时 |
| `screenshot.maxWidth/maxHeight/quality` | 1280/800/75 | 截图上限与 JPEG 质量 |

## 验证状态

| 项 | 状态 |
|---|---|
| cua.ps1 的 info / windows / screenshot | ✅ 在本机真跑过（2160×1440 → 1200×800 JPEG，中文窗口标题正常） |
| World + Bridge 离线冒烟（tsx 直接构造 World，绕过 Coopanion） | ✅ .tmp/smoke.ts：桥接起、401、带令牌调用、ask-once 只问一次 |
| 装进真实 Coopanion（pnpm link + 重启 + GUI 启用） | ✅ World 显 active，桥接灯 online；M2 后桥接 8 个工具 |
| 真实桥接：health / 401 / 截图 / 列窗口 | ✅ 本机实测（ask-once 弹框点「是」后拿到 1200×800 JPEG） |
| AstrBot 插件客户端打真实桥接 | ✅ `alive()`、`cua_windows`、`cua_screenshot` 全通 |
| Coo（Coopanion 自己的模型）调用这些工具 | ❌ 未验证（等价于在 Coopanion 里问 Coo"看看我的屏幕"） |
| `tsc --noEmit`（对 `cortico@0.2.8` 的真实类型） | ✅ 通过 |
| `npm run describe` 生成的 describe.json | ✅ 已提交，CI 校验不漂移 |

## 开发

```bash
npm ci
npm run typecheck     # 对着 cortico 的类型检查（Api 6 的契约会被真正校验）
npm run describe      # 重新生成 describe.json
npm run check         # typecheck + describe + git diff --exit-code
```

工具名、description 或 parameters 改了以后记得跑一次 `npm run describe`——扩展页与市场读的是这个文件，
CI 会在它过期时失败。

## 还没做

- macOS / Linux 引擎（`preflight` 会直接拒绝）。
- `cua_zoom`（原分辨率重截一块）与 `cua_wait`。
- 自动"动作后截图"：现在调用方要自己再截一次。

## 两个 bot 聊天

`@
AstrBot ──/v1/chat──▶ Coo 的会话（正文带【AstrBot】前缀）
Coo ──POST AstrBot /api/v1/chat──▶ AstrBot（配置了 OpenAPI 时回复作为新消息进 Coo 会话）
Coo ──send_msg_to_astrbot──▶ 信箱（没有 OpenAPI 时的兜底，AstrBot 轮询 /v1/mailbox）
`@

- `GET /v1/identity`：`{coo, astrbot, user, tools, exposeToBot}`，AstrBot 启动时读一次。
- `POST /v1/chat` `{"text": "...", "waitMs": 0}`：把话送进 Coo 的会话，正文自动加 `【AstrBot】`。
  `waitMs > 0` 时顺便等它这一轮说完。
- `GET /v1/mailbox`：取走 Coo 在 AstrBot 不在时留下的消息（取一次就清空）。

`cua_delegate` 是给桥接的委托入口：AstrBot 提交任务后拿到 job id，用 `cua_job` 轮询；
`allow_act=false` 时任务里只能截图/列窗口，点鼠标键盘会被拒绝；任务默认最多 120 秒。

身份只在本 World 生效：改 `worlds.cua-bridge.names.*` 不会改 AstrBot 的展示名，也不会改 Coopanion 本身。