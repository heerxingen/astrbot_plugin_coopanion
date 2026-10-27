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

然后从下面三种隧道里挑一种。

### A. SSH 反向隧道（最省事，不需要域名）

在 **你的 PC** 上跑（不是服务器）：

`@bash
# 把服务器的 17901 转发到你本机的 17901；-N 只转发不开 shell
ssh -N -R 127.0.0.1:17901:127.0.0.1:17901 user@your-server
`@

服务器上的 AstrBot 就访问 `http://127.0.0.1:17901`。
`-R` 默认只绑服务器的回环地址，正好不给外人开门；要长期跑就用 `autossh` 或 systemd 用户服务。

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
   在 Coopanion 设置里把 `worlds.cua.bridgeHosts` 改成例如
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

每次 Coopanion 启动令牌都会换新，所以插件里的 `token` 过期后要重抄一次（或者重启 Coopanion 后
把它同步到服务器环境中，别写进会外泄的地方）。

## 安全清单

| 事项 | 为什么 |
|---|---|
| 桥接保持 `127.0.0.1` | 远端通过 SSH/frp/反代进来，本机不开放入站 |
| 隧道那一端不要绑 `0.0.0.0` | 否则等于把"控制我桌面"的接口开到公网 |
| `worlds.cua.exposeToBot` 保持关闭 | **默认就是这样**：Coo 看不到、调不到这些工具，只有桥接能用 |
| `ask` 别设成 `never-ask` | 远程调用时你至少还能在桌面上看到确认框 |
| token 当密码对待 | 拿到它 = 能截屏、能点鼠标、能打字 |

## 排错

| 现象 | 原因 |
|---|---|
| `连不上 … 桥接`（远程） | 隧道没起；或 AstrBot 在容器里，`127.0.0.1` 指容器自己 |
| `421` | 走了反代但没把公网域名加进 `bridgeHosts` |
| `401` | token 过期（Coopanion 重启过），重抄 |
| 能连但很慢 | 每次截图都要传回 JPEG；把 `screenshot.maxWidth/Height/quality` 调小 |
