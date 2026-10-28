# 部署形态：本机、还是 AstrBot 在服务器上

桥接只监听 `127.0.0.1`。Coopanion 和 AstrBot 不在同一台机器时，**不要让桥接监听 0.0.0.0**，
而是让"隧道在本地这一端终结"，把远端的请求转回本机回环。这样：

- 桌面上那台机器不开放任何入站端口；
- 令牌永远只走加密通道（SSH / TLS）；
- Coopanion 里不用为"对外"多写一行代码。

`@
┌────────────── 你的 PC ──────────────┐          ┌──────── 服务器 ────────┐
│ Coopanion                            │          │ AstrBot                │
│  └ World「CUA」扩展                   │          │  └ astrbot_plugin_      │
│      └ 127.0.0.1:17901 (Bearer)      │◀──隧道──▶│      coopanion         │
│         令牌: <部署>/data/cua/         │          │      配置: base + token │
│               bridge.json            │          │                        │
└──────────────────────────────────────┘          └────────────────────────┘
`@

## 情况 1：AstrBot 也在本机

插件配置里**只填 `bridge_json`**，其余留空：

`@json
{ "bridge_json": "C:/Users/you/.coopanion/default/data/cua/bridge.json" }
`@

端口和令牌都在文件里，Coopanion 重启后自动跟上。

## 情况 2：AstrBot 在服务器（你现在这种）

插件配置里填 `base` + `token`，**不填 `bridge_json`**：

| 配置项 | 值 |
|---|---|
| `base` | 隧道给 AstrBot 的地址，例如 `http://127.0.0.1:17901` 或 `https://example.com/coopanion` |
| `token` | 本机 `<部署>/data/cua/bridge.json` 里的 `token` |
| `verify_tls` | 有证书就保持 `true` |

先在插件配置的「部署方式」里选 **服务器 + SSH 隧道**，`base` / `token` 才会显示。

然后从下面三种隧道里挑一种。

### A. SSH 反向隧道（最省事，不需要域名）

在 **你的 PC** 上跑（不是服务器）：

`@bash
# 把服务器的 17901 转发到你本机的 17901；-N 只转发不开 shell
ssh -N -R 127.0.0.1:17901:127.0.0.1:17901 user@your-server
`@

服务器上的 AstrBot 就访问 `http://127.0.0.1:17901`。
`-R` 默认只绑服务器的回环地址，正好不给外人开门；要长期跑就用 `autossh` 或 systemd 用户服务。

如果 Coo 还要直连 AstrBot 的 OpenAPI，同一条 SSH 再加一个本地转发：

`@bash
ssh -N -L 127.0.0.1:6185:127.0.0.1:6185 -R 127.0.0.1:17901:127.0.0.1:17901 user@your-server
`@

- `-L 6185`：本机 6185 → 服务器 AstrBot 6185；Coo 的 `chat.astrbotUrl` 填 `http://127.0.0.1:6185`。
- `-R 17901`：服务器 17901 → 本机 Coo 桥接 17901；插件 `base` 填 `http://127.0.0.1:17901`。

### B. frp（已有 frps 的话）

`@toml
# frpc.toml（在你的 PC 上）
[[proxies]]
name = "coopanion-cua"
type = "tcp"
localIP = "127.0.0.1"
localPort = 17901
remotePort = 17901
`@

服务器上 AstrBot 还是访问 `http://127.0.0.1:17901`（frps 绑 127.0.0.1 即可，别 `0.0.0.0`）。

### C. 有域名 + HTTPS 反代（Caddy / nginx）

适合你想给 AstrBot 一个 `https://coopanion.example.com` 的情况。两条硬性要求：

1. **加 Host 白名单**：请求到 Coopanion 时 `Host` 是公网名字，而桥接默认只认回环名。
   在 Coopanion 设置里把 `worlds.cua-bridge.bridgeHosts` 改成例如
   `127.0.0.1,localhost,[::1],coopanion.example.com`。
2. 反代要原样转发 `Authorization` 头，别缓存、别记录 body。

`@caddy
coopanion.example.com {
    reverse_proxy 127.0.0.1:17901
}
`@

插件 `base` 填 `https://coopanion.example.com`。

## 令牌怎么拿

`@bash
# 在你 PC 上
node -e "const j=require('C:/Users/you/.coopanion/default/data/cua/bridge.json');console.log(j.token)"
`@

令牌首次生成后会复用，重启 Coopanion 不会换新，所以插件里的 `token` 配一次就行。
只有 `bridge.json` 被删掉或损坏时才会重新生成；那时重抄一次。

## 安全清单

| 事项 | 为什么 |
|---|---|
| 桥接保持 `127.0.0.1` | 远端通过 SSH/frp/反代进来，本机不开放入站 |
| 隧道那一端不要绑 `0.0.0.0` | 否则等于把"控制我桌面"的接口开到公网 |
| `worlds.cua-bridge.exposeToBot` 保持关闭 | **默认就是这样**：Coo 看不到、调不到这些工具，只有桥接能用 |
| `ask` 别设成 `never-ask` | 远程调用时你至少还能在桌面上看到确认框 |
| token 当密码对待 | 拿到它 = 能截屏、能点鼠标、能打字 |

## 排错

| 现象 | 原因 |
|---|---|
| `连不上 … 桥接`（远程） | 隧道没起；或 AstrBot 在容器里，`127.0.0.1` 指容器自己 |
| `421` | 走了反代但没把公网域名加进 `bridgeHosts` |
| `401` | `bridge.json` 被删过/换过，token 已重新生成；重抄 |
| 能连但很慢 | 每次截图都要传回 JPEG；把 `screenshot.maxWidth/Height/quality` 调小 |

## 两个 bot 聊天时隧道的方向

`@
AstrBot ──HTTP──▶ 127.0.0.1:17901（隧道）──▶ Coo 的桥接        ← 已有，走 base + token
Coo ──HTTP──▶ AstrBot 的 /api/v1/chat（OpenAPI）                 ← 填了地址和 Key 就走这条
`@

第二条（Coo 主动找 AstrBot）在 Coopanion 的 `worlds.cua-bridge.chat.*` 里填 AstrBot 的 OpenAPI
地址和 `chat` scope 的 API Key，就直接 POST `/api/v1/chat`（`username=coo`、独立 `session_id`），
回复通过 SSE 取回后作为新消息送进 Coo 的会话，下一轮再回；不需要轮询。
没填时走**信箱**：Coo 把消息放进 outbox，插件按 `poll_seconds` 用 `GET /v1/mailbox` 取走，
再送进 `umo`；插件保留信箱作为 OpenAPI 不可达时的兜底。

## 编码

桥接只收 UTF-8。用 curl 在 Windows 上手工测试时，命令行参数可能先被转成 GBK，
结果就是"对方收到一堆乱码"——那不是链路的锅。用 Python / 插件发就没这个问题；
真发了非 UTF-8，桥接会直接回 400 而不是把乱码存进会话。
