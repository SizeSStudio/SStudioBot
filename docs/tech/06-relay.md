# 06 中继、密钥、配对、设备

设计在 §触6.7、§触6.8；这里定实现。中继只转密文，信任锚是配对码里的主公钥。

## 中继（`relay/`）

- Node + `ws` 8.23，独立进程。默认和主在同一台 VPS 上，经机器上已有的 nginx 共用 443：nginx 终结 TLS（现有证书），把 WS 升级转给 `127.0.0.1:<端口>`。域名是实例配置，不进仓库。DNS 只解析、不经 CDN 代理 ※（理由：少一家看元数据，WS 长连接不被 CDN 掐）。
- P1 看过 Paseo 的 `relay/`：不照搬，自己写（08 P1）。W2a 落地：`relay/src/`，`ws` 锁 8.23.1，`npm ci --ignore-scripts`，只 import `protocol/envelope.ts`。默认听 `127.0.0.1:7840` ※；`X-Real-IP` 只在 TCP 对端是回环时认（nginx 覆盖写），否则用对端地址。
- 部署件在 `deploy/relay/`：unit（`LogNamespace=sbot-relay`，journald 留 14 天）、`install.sh`（只装中继本身，不碰 nginx）、`nginx-relay.conf.example`（域名占位）。公网入口由我手动开。
- 端点：
  - `GET /v1/hub`：主注册，一条 WS 承载所有会话（多路复用）。
  - `GET /v1/peer?hub=<主公钥 base64url>`：客户端、节点，一个会话一条 WS。
  - `GET /healthz`。

### 信封（`protocol/envelope.ts`）

- 设备、节点那条 WS：每条二进制消息就是一段 Noise 数据，中继原样转，不加头。
- 主那条 WS：`type(1) | sid(4, 大端) | payload`。
  - `0x01 OPEN`：中继 → 主，新会话；payload 是 JSON `{ ip_masked, ts }`（IPv4 留 /24、IPv6 留 /48），给 `device_audit` 和「从没见过的 IP 段」用。
  - `0x02 DATA`：双向，payload 是 Noise 数据。
  - `0x03 CLOSE`：双向，payload `{ code, reason }`；主发 `reason: "auth"` 表示认证失败，中继按 IP 计数。
- 单条消息上限 65,535 + 5 字节，超了中继直接断。

### 注册、防抢注册、防洪泛

- 中继的 `relay.yaml`（实例配置，在服务器上）列允许注册的主：`[{ hub_pk, token_hash }]`。主用 `secrets.env` 里的 `RELAY_TOKEN` 注册，两者对上才收。同一把公钥再次注册（主重启）新的顶掉旧的。没对上回 401，按 IP 限速。
  - 注册请求头 ※：`Authorization: Bearer <RELAY_TOKEN>`、`X-Sbot-Hub: <hub_pk>`；中继比 `sha256(token)`，常数时间。`token_hash` 是 sha256 hex。`hub_pk` 从 `sbot status` 抄（公钥，不是秘密）。
  - `relay.yaml` 改了 `systemctl reload`（SIGHUP）：新表生效，被拿掉的主立刻断；坏文件留旧表、记一行。
- 升级前就拒（HTTP，不进 WS）：封禁中 403、令牌桶空 429、注册不对 401、`hub=` 不是 43 位 base64url 400、别的路径 404。
- 关闭码 ※：

  | 码 | 谁发 | 意思 |
  |---|---|---|
  | 4404 | 中继 | 主不在线；主掉线、被顶掉时它的会话也收这个 |
  | 4408 | 中继 | 10 秒内主没回第一段 |
  | 4409 | 中继 → 旧主 | 同一把公钥新注册顶掉了它 |
  | 4429 | 中继 | 设备那条积压超 2 MiB 持续 10 秒（直接断 socket，不等关闭握手） |
  | 1002 / 1009 | 中继 | 文本消息、坏信封 / 超长 |
  | 4401 `auth` | 主 | 认证、配对任何一步不过；中继按设备 IP 计失败 |
  | 4400 `protocol` | 主 | 通道打开后解不开（重放、篡改、乱序）或帧不成形 |
  | 4410 `removed` | 主 | 设备被删 |
  | 4426 `version` | 主 | 客户端协议版本低于 `PROTOCOL.min` |

  主发的 CLOSE 中继只放行 1000 和 4000–4999，`reason` 只放 `[a-z_]{1,20}`。
- 设备连 `/v1/peer` 时主不在线：关闭码 4404，客户端显示「等主上线」，按 1、2、5、10、30 秒退避重连。
- 中继自保的默认值（`relay.yaml` 可改；保护中继，不限制我）※：
  - 每个 IP 新连接每分钟 20 次（令牌桶）。
  - 会话打开后 10 秒内主没回第一段数据（Noise 第二条消息）就关。
  - 同一 IP 认证失败 10 分钟内 10 次，封 1 小时。
  - 单会话持续 4 MB/s、突发 16 MB。
- **不缓冲**：只靠 socket 自己的缓冲。主那条 WS 的 `bufferedAmount` 超过 8 MiB 就暂停读所有设备；某个设备那条超过 2 MiB 持续 10 秒就关掉这个会话，它重连后按 seq 补（§触6.4）。
- 日志只记元数据：时间、打码 IP、sid、字节数、关闭原因；不记内容；留 14 天。
- 中继看得到 IP、时间、大小、sid、主公钥；看不到内容，伪造不了主（§触6.7）。

### 以后

直连（同一局域网、tailnet）用同一套握手和应用帧，只是不经中继；走哪条路不改变谁能做什么。多个中继以后再说。

## 主的密钥

- 第一次启动生成 X25519 静态密钥：`$SBOT_HOME/keys/hub.key`（0600，属主是主的账号）。按 `secrets.env` 对待：不打印、不进日志、不进 agent 环境。
- 公钥用于配对码；`sbot status` 显示它的指纹（前 8 组），方便我核对。
- 跟着加密备份走（§底1.3 R4），换主不用重新配对。
- v1 不做轮换（换了所有设备都要重配）※。

## 设备密钥

- 每台设备一把 Ed25519 身份密钥，签认证挑战用。`device_id` = `hex(sha256(公钥 32 字节))`（04 devices）；界面显示前 8 位，命令接受 ≥ 6 位的唯一前缀。设备名是自称的，界面上标明。
- 签名前缀做域分隔：签的是 `"sbot-auth/1" || 握手 hash || challenge`（配对用 `"sbot-pair/1"`）。握手 hash 把签名绑在这条 Noise 通道上，中继拿去别的通道重放没用。
- **安卓**（P4 定）：API ≥ 33 且 Keystore 支持 Ed25519 时，在 Keystore 里生成（不可导出，有 StrongBox 就用）；否则用 noble 在软件里生成，再用 Keystore 里一把不可导出的 AES-GCM 密钥包起来，密文放 App 私有目录。
- **Electron**（P4 定）：主进程用 `node:crypto` 生成，私钥用 `safeStorage` 加密后存 `userData`（Mac 钥匙串、Windows DPAPI）。`safeStorage` 后端是 `basic_text` 时拒绝启动配对并提示，不降级。渲染进程拿不到私钥，`contextBridge` 只给两个函数：`device.publicKey()`、`device.sign(handshakeHash, challenge)`（内部加前缀）。这取代设计稿「WebCrypto 存 IndexedDB」的方案（DC-16）。
- 密钥没了（卸载、清数据）就重新配对，不导出、不备份。

## 认证（每次连接）

1. Noise 握手完成，主在第二条消息里给 `challenge`。
2. 设备发 `auth { device_id, sig }`。
3. 主查 `devices`：存在、没删、公钥验签过 → 这条通道认作这台设备、它的角色；更新 `last_seen`、`last_ip_masked`；IP 段对这台设备是新的就记 `device_audit`。
4. 任何一步不过：发 `CLOSE { reason: "auth" }`，不说哪步错。

- 从 OPEN 到认证完成限 10 秒 ※，超了按 `auth` 关。第一帧必须和握手里的 `purpose` 对上（`auth` 对 `auth`、`pair` 对 `pair`），角色要和 `devices.role` 一致。
- 已知设备签名不对记 `device_audit challenge_failed`；不认识的 id 不记（公网噪声）。

一条通道只对应一台设备。没有 token、cookie、过期。

## 配对

- 配对码：`{ v: 1, hub_pk, relay, secret: 32 字节, role, exp }` → `sstudiobot://pair#v1.<base64url(JSON)>`。二维码就是这个链接。`#` 后面的部分不发给任何服务器。
- `device_invites`：存 `sha256(secret)`、`role`、`created_by`（`cli` / 设备 id / `channel:feishu`）、`expires`（10 分钟）、`used_at`。
- 流程：新设备生成密钥 → 连 `/v1/peer?hub=` → Noise 握手（`purpose: "pair"`）→ `pair { secret, public_key, name, platform, sig }` → 主在一个事务里：常数时间比对 hash、没用过、没过期 → 标记用掉、写 `devices`、写 `device_audit` → 这条通道直接认作这台新设备。
- 主先验 `pair.sig`（证明设备握着私钥、绑在这条通道），再碰邀请。每次都把所有未用未过期的邀请比一遍，不提前退出。失败记 `pair_failed`，不记 secret。见过的公钥（删了的也算）不能再配 ※：每次配对都是新密钥，旧密钥只可能是重放。
- 拿码的三条路（§触6.7）：
  - `sbot pair [--node]`：经 `hub-admin.sock`（05），终端打二维码和链接。
  - 已配对客户端：`POST /api/v1/devices/invites { role }`。
  - 渠道私聊 `/pair [node]`：只认我在私聊里发的，回链接和码文本（码经过飞书服务器，风险见 §底3.8）。
- **唤起 App 的 scheme**（Y2）：`sstudiobot://`。安卓在 `app.json` 的 `scheme` 里声明；Electron 用 `app.setAsDefaultProtocolClient("sstudiobot")`。飞书内置浏览器打不开自定义 scheme 时，App 里有「粘贴配对码」，粘整个链接或 `v1.` 开头的码都认。
- 节点配对：`sbot-node pair <链接>`（05），`role` 取码里的。

## 设备管理

- 列、改名、删：设备页、`sbot devices [rm <id>]`、渠道 `/devices`、`/devices rm <id>`。
- **删立刻生效**（§触6.7），一个事务加事务后的动作，1 秒内完成：
  1. `devices.removed_at/removed_by`，写 `device_audit`。
  2. 断开这台设备的所有通道。
  3. 它排队还没处理的输入标 `dropped`。
  4. 它发起、还在跑的 run 停掉（runs 上记着发起设备）。
  5. `push_token` 清空。
- 通知（走 §触1.1 路由表）：新设备配上、删设备按**安全告警**发；从没见过的 IP 段按**通知**发 ※（手机换基站 IP 段常变，按安全告警会夜里吵）。W3 推送之前三种都走 `notify.admin` ※。
- 通道里的 `req` 交给 W2b 的 `api.dispatch(req, { device_id, role, conn })`，入口的 `authorize` 是 `link/roles.ts` 的；通道关了调 `api.closeConn(conn)` 收掉它的流。设备的写（`PATCH|DELETE /api/v1/devices/:id`、`POST /api/v1/devices/invites`，核心在 `hub/src/link/service.ts`）W3 `client_ops` 之前只在 `hub-admin.sock` 上接，通道里发来是 W2b 的 404 或 405 ※；列表走 W2b 的 `GET /api/v1/devices`。`/pair`、`/devices` 只认飞书我自己私聊那条 lane（`feishu:dm:owner`），别处当普通文字。
- 删了的设备再连：认证失败。要用就重新配对，是一台新设备。

## 角色

- `client`：我能做的都能做；同一台设备发起的审批自己能批（§触6.10 D6）。
- `node`：只能调 `/node/v1`；`/api/v1` 一律 403。这条在 API 分发处一处判断，不靠各路由自己记得；有测试覆盖「批审批、答看一眼、发消息、读 self」四条。
- `authorize(role, path)`（`hub/src/link/roles.ts`）只认规范路径 ※：带 `.`、`..`、空段、`%`、`\` 的一律 403，免得以后哪个路由归一化后绕过。`hub-admin.sock` 是保留设备 `cli`（`client`），`device_id` 是 64 位 hex，永远不会是 `cli`。

## 开关

`console.yaml`：

```yaml
relay:
  enabled: false        # 打开走 widening()，管理通知一句（我定了开，§触6.10）
  url: wss://<中继域名>/v1/hub
mcp_open: false         # 反向开放 MCP（02）
fcm: { enabled: false } # 07
```

- `url` 必须以 `/v1/hub` 结尾 ※；配对码里的 `relay` 是把它换成 `/v1/peer` 得来的，客户端再加 `?hub=`。`ws://` 只许回环（同机中继、测试、冒烟）※。
- 开关在启动时读 ※：改了下次启动生效。`enabled` 但缺 `url` 或 `RELAY_TOKEN` 就不连，记一行。没填 `url` 时出码会被拒（码里没有中继地址）；填了但没开，码照出，提示现在连不上。
