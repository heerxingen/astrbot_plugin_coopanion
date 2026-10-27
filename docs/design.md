# 设计：AstrBot × Coopanion 的工具桥

> 第一版方案是改 Coopanion 内置桌宠 World 的 `invoke()`（见 `../prototype/coopanion-bridge/`）。
> 那份仍留在仓库里做对照，但**推荐方案已经换成 World 扩展** `cortico-world-cua`：
> 同样的工具、同样的权限语义，不自带补丁，走产品现成的扩展安装流程。

## 1. 一句话

**Coopanion 的扩展提供"眼睛和手"，AstrBot 提供"嘴和脑子"。** 桥负责两件事：
把扩展的 `cua_*` 工具暴露给 AstrBot；把回执里的 JPEG 变成模型能看的 `ImageContent`。

## 2. 数据流

```
用户（QQ / Telegram / WebChat）
  │  "帮我看看屏幕上那个报错是什么"
  ▼
AstrBot 主 Agent ── tool_call: coopanion_screen ──▶ astrbot_plugin_coopanion
                                                      │ 读 cua/bridge.json 拿 port+token
                                                      │ POST http://127.0.0.1:<port>/v1/tool
                                                      ▼
                                        Coopanion Core（Node 子进程，扩展在进程内跑）
                                                      │ CuaWorld.call('cua_screenshot')
                                                      │ → permit() 决定要不要问
                                                      ▼
                                        ask.ps1（系统「是/否」框，默认按钮否）
                                                      ▼
                                        cua.ps1（PowerShell 子进程）
                                                      │ SetProcessDpiAwarenessContext(-4)
                                                      │ Graphics.CopyFromScreen → 缩放 → 画指针 → JPEG
                                                      ▼
                                        {text, blobs:[{mime, base64}]}
  ▲                                                   │
  │                                                   ▼
  └──────── CallToolResult[ TextContent, ImageContent ] ──▶ 模型（多模态）
```

## 3. 为什么是扩展，而不是补丁

| | 改内置 World（旧方案） | World 扩展（现在） |
|---|---|---|
| 复用桌宠的 `Cua` | ✅ 直接复用 | ❌ 拿不到（World 之间无互调 API） |
| 用户可见的确认框 | 桌宠气泡 | 系统原生「是/否」框 |
| 升级 Coopanion 后 | 补丁丢失 | 扩展照常 |
| 安装方式 | 改代码 + 重启 | 扩展页 → 重启进程 |
| 体积 | ~30 行 | 一个包（本仓库 6 个 ts + 2 个 ps1） |
| 能否发扩展市场 | ❌ | ✅（需要 describe.json、测试、CHANGELOG） |

扩展拿不到桌宠的 `Cua`，所以它自带引擎。**这也决定了权限语义必须自己实现**：
扩展层够不到应用的 `askPermission` 钩子（Shell 扩展的注释写得很直白：
"Approvals must happen outside the model… this extension layer cannot reach the app's own askPermission"）。
所以这里用系统 MessageBox，默认按钮是「否」，超时 = 拒绝，拒绝在本轮内一直有效。

## 4. 引擎为什么是 PowerShell

| 方案 | 优点 | 代价 |
|---|---|---|
| PowerShell + System.Drawing / user32 | 零依赖、零编译、本机就有 | 每次调用 ~250-500 ms；只能 Windows |
| koffi + GDI（桌宠 World 的做法） | 快（~10-50 ms）、能 `CAPTUREBLT` | 原生依赖 + 构建，扩展要 `allowBuilds` |
| 第三方 npm（screenshot-desktop 等） | 写起来短 | 各自的平台坑；坐标/DPI 仍需自己处理 |

对话场景里 300 ms 完全不是瓶颈，先用 PowerShell 把功能跑通；要更快就换 koffi，接口不变。

## 5. 令牌与发现

- 扩展启动时生成 `randomBytes(32).base64url`，写进 `<部署目录>/cua/bridge.json`（0600），
  同时把**实际绑定的端口**写进去（配置端口被占用会顺延）。
- 调用方（插件 / MCP / 脚本）只认这个文件：改端口、换令牌都不用改配置。
- 401 一律当"令牌不对"，提示重启 Coopanion 重写文件。

## 6. 失败模式（模型看到的话）

| 情况 | 回执 |
|---|---|
| Coopanion 没开 / 扩展没启用 | 连不上 127.0.0.1:port |
| 令牌不对 | 401 |
| 用户点了「否」 | 「使用者点了「否」，这次什么也没做。不要换个说法重试。」 |
| 确认框没人理 | 「60 秒后按拒绝处理」 |
| 引擎超时 | 「超过 N ms 没有返回，进程已终止」 |
| 找不到窗口 | 「没能把「x」切到前台」 |
| 工具越界 | 只暴露 `cua_*`，其它名字直接拒绝 |

## 7. 时延

| 步骤 | 典型 |
|---|---|
| 插件 → 桥接（本机 HTTP） | < 5 ms |
| 权限询问（ask-once 已授权） | 0 |
| 权限询问（首次，等人点） | 0 ~ 60 s |
| PowerShell 进程启动 + 截图 + JPEG | 250 ~ 500 ms |
| 模型读图 | 看模型 |

## 8. v2

1. `cua_zoom` / `cua_wait` / 动作后自动截图（桌宠 World 有，这里没做）。
2. koffi 引擎（快 10 倍），PowerShell 作 fallback。
3. mac / linux 引擎（`screencapture` / `grim`+`xdotool` / Wayland 单独处理）。
4. 免询问名单（像 Shell 的 `allowlist.json`）：按"动作类型+窗口"预批准。
5. 发到扩展市场：`describe.json`、`CHANGELOG.md`、截图、`check:extension` 通过。

## 9. 本次没验证的

- 装进真实 Coopanion 后 World 能否被加载（`WorldDefinition` 的形状照 Shell 扩展抄的，
  但 `describeTools` 等 `cortico/world.ts` 导出没有在真实运行时里跑过）。
- AstrBot 侧插件加载（本机无 AstrBot）。
- 多显示器 / 高 DPI 混合缩放的坐标一致性（只在本机 2160×1440、100% 缩放上验过）。
- 输入工具（click/type/key）只做了代码审阅，没实际点击——避免动到你的桌面。
