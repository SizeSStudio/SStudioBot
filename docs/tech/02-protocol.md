# 02 帧协议

一套帧格式，三处共用：客户端 ↔ 主、节点 ↔ 主、本机节点和 CLI ↔ 主。语义沿用 §触6.4（持久事件、增量、续传、写操作），这里定线上长什么样。

## 分层

```
跨网：WSS（TLS 在中继入口终结）
      └ 信封（中继看得懂，06）
         └ Noise 传输消息（端到端加密，中继看不懂）
            └ 应用帧（JSON）
本机：unix socket / named pipe
      └ 长度前缀（u32 大端）+ 应用帧（JSON）；不加 Noise、不套信封，靠文件权限（05）
```

## Noise（`protocol/noise/`）

- 模式 `Noise_NK_25519_ChaChaPoly_SHA256`：发起方是设备或节点，响应方是主；主的静态公钥从配对码来（06）。prologue 固定为 `sbot-noise/1`。
- 实现：状态机照搬 Paseo 的 Noise（`cipher-state.ts`、`symmetric-state.ts`、`handshake.ts`；Apache-2.0，保留版权头，改动见 `noise/NOTICE.md`；P1 改了失败即断、清掉的状态抛错），sha256/hkdf 用 noble。`channel.ts` 是我们的：prologue、JSON 握手载荷、分片（用 `protocol/fragment.ts`）、任何错都销毁通道。必须过规范的公开测试向量（cacophony），每个后端都跑一遍（W1b：noble、`node:crypto` 都过，两个后端互相加解密字节一致）。
- ChaCha20-Poly1305 和 X25519 在接口后面（`noise/crypto.ts` 的 `Aead`、`Dh`；X25519 的随机数跟着 `Dh` 走），启动时 `useCrypto()` 按平台选一次，默认 noble（P1：Hermes 上 noble 的 64 KiB 加解密 35 ms、吞吐 1.8 MB/s，不过）：
  - 安卓（Hermes）：`react-native-quick-crypto`（原生，接口同 `node:crypto`）；随机数也从它来。
  - 主、节点：`node:crypto` ※（`noise/node-crypto.ts`；理由：同一接口，OpenSSL，比 noble 快 5 倍）。
  - 网页、Electron 渲染进程、测试对照：noble。
- 握手：
  - `→ e, es`，载荷 `{ v, role: "client"|"node", purpose: "auth"|"pair" }`
  - `← e, ee`，载荷 `{ v, challenge: 32 字节随机, hub_time }`
  - 之后第一帧必须是 `auth` 或 `pair`（06），否则主断开。
- 传输：Noise 自带的 64 位计数器做 nonce；WS 保证顺序，解密失败一次就断开（重放、篡改、乱序都落在这里）。不做 rekey（一条通道到不了 2^64 条）。
- 一条 Noise 消息最多 65535 字节。应用帧序列化后切成片：每片第一个字节是标志（`0x00` 还有后续、`0x01` 最后一片），一片一条 WS 消息。组装后的应用帧上限 1 MiB；更大的走拉取（下面「大载荷」）。

## 应用帧（`protocol/frames.ts`）

UTF-8 JSON。两个方向都能发 `req`：客户端和节点向主发，主向节点发指令。每一边的 `id` 自己递增，`res` 回对方的 `id`。

```ts
type Req    = { t: "req"; id: number; method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE"; path: string;
                query?: Record<string, string>; body?: unknown; client_op_id?: string };
type Res    = { t: "res"; id: number; status: number; body?: unknown; seq?: number };  // seq：这次写入提交后的 seq（§触6.4）
type Cancel = { t: "cancel"; id: number };                                              // 不要了的 req（比如翻页、拉取）
type Ev     = { t: "ev"; seq: number; ts: number; entity: string; id: string; op: "upsert" | "delete"; data?: unknown };
type Delta  = { t: "delta"; run: string; item: string; chunk_seq: number; text: string };
type Snap   = { t: "snapshot"; run: string; item: string; text: string; tool?: string; chunk_seq?: number };  // chunk_seq：text 里已有几段，下一条 delta 取它 + 1
type Beat   = { t: "beat"; seq: number; status?: unknown };                              // 20 秒一次
type Reset  = { t: "reset" };
type Auth   = { t: "auth"; device_id: string; sig: string };                             // 06
type Pair   = { t: "pair"; secret: string; public_key: string; name: string; platform: string; sig: string };
```

- `path` 就是 `/api/v1/...`（客户端）或 `/node/v1/...`（节点），状态码沿用 HTTP 含义：400 参数错、403 角色不许、404、409 版本冲突（带最新内容）、410 已作废。
- 一条连接最多一个事件流：`POST /api/v1/stream { after }`，`res` 之后主开始推 `ev`、`delta`、`snapshot`、`beat`；同一连接再发一次就换掉前一个 ※（收到 `reset` 后在原连接上重新 bootstrap、再开流）。`after` 早于 `change_log` 保留期、或比主的最新 seq 还新（换过库）就回 `res { reset: true }` 加一个 `reset` 帧，之后什么都不发（§触6.4）※。
- `beat.seq` 是这条连接的游标（已经补到哪），不是库里最新的 seq：断线后拿它当 `after` 不会跳过没发到的 ※。
- `delta` / `snapshot` 的 `item`：正在写的一段回复还没有 `run_items` 行，用 `<run_id>:a<n>`（n 是这轮第几段，从 0 起）※；`item` 事件的 `live_key` 等于它（写完的那段）、或 `run` 不再是 running，就丢掉正在流的文本。工具调用用 `run_items` 的 id。`chunk_seq` 每项从 1 起。
- 展开、折起：`POST /api/v1/stream/expand { item }`、`.../collapse { item }`；只有展开了的连接收那一项工具调用的 `delta` 和 `snapshot`；回复正文的 `delta` 每条客户端连接都收（§触6.4「折起来的不推流」说的是工具调用）※。
- 未知字段、未知 `t`、未知 `entity` 一律忽略，不报错（只做加法的前提）。

## 写操作和 `client_ops`

- 写请求带 `client_op_id`（客户端生成的 UUID）。主在业务写入的同一事务里写 `client_ops(device_id, client_op_id, result_json, ts)`；同一个键再来，直接回存着的结果（同 status、body、seq）。拒绝（4xx）也存，重试听到同一句；5xx 不存，可以再试。
- 同一个键、换了请求（方法、路径或 body 不同；body 按键排序后比）不算重试，回 409、什么都不做（W3a）。`result_json` 里带这次请求的摘要 `req`（sha256 前 32 位）。发消息同理：同一个键、换了文字或 thread → 409。
- 结果本身是秘密的不存原样：`POST /api/v1/devices/invites` 的配对码只在第一次回答里，重试回 409「这次的配对码已经发出去了」※。
- 成功写入之后、要在库外做的事（比如让 triage 重新起草）在事务提交后做一次；重试拿存着的结果，不再做。
- 发消息用 `inbox` 的唯一键：`source = "device:<device_id>"`、`source_msg_id = client_op_id`（§触6.4）。
- 节点来的写入键是 `task_id:attempt:tool_call_id`（或 `task_id:attempt:event_seq`）。
- **清理**：每天一次删 `ts` 早于 30 天的行 ※（理由：客户端重试最多跨几次断线，30 天远够；表不无限长）。
- 乐观、确认后才算、乐观锁三类照 §触6.4 的表；路由表里每条写操作标是哪一类（下面）。

## 大载荷

- 长输出、diff、完整的工具结果不进事件。事件里只带 `{ ref: "blob:<sha256>", size, preview }`。
- 拉取：`GET /api/v1/blobs/<sha>?offset=&len=`，一次最多 512 KiB（base64 后放进 1 MiB 的帧），回 `{ data_b64, total, next_offset }`，`next_offset` 为 null 表示到头 ※；客户端顺序拉，中途 `cancel` 就停。
- blob 存在主的 `$SBOT_HOME/blobs/<sha256>`（内容寻址）。被引用的跟着引用留；没人引用、超过 1 天的由每日 GC 删 ※（04 §11）。

## `/api/v1` 路由（第一版）

角色：`client` 是配对过的客户端设备和本机 CLI；`node` 一律 403，除非下表写了。权限同我（§触6.7）。

| 路由 | 用途 | 写操作类型 |
|---|---|---|
| `GET /api/v1/meta` | 协议版本 `{current, min}`、主的 sha | — |
| `POST /api/v1/bootstrap` | 快照 + 当时的 seq（一次同步读） | — |
| `POST /api/v1/stream`、`/stream/expand`、`/stream/collapse` | 事件流 | — |
| `GET /api/v1/threads`、`GET /api/v1/threads/:id/items?before=` | thread 列表、翻历史 | — |
| `POST /api/v1/threads`、`PATCH /api/v1/threads/:id` | 开 thread（一般；带 `matter_id` 是主线）、改名置顶收起 | 乐观 |
| `POST /api/v1/threads/:id/messages` | 发消息（进 `inbox`；lane 忙就排队，回 `queued`、`ahead`） | 乐观 |
| `DELETE /api/v1/inputs/:id` | 撤回还在排队的输入（W3 加） | 确认后才算 |
| `POST /api/v1/runs/:id/stop` | 停这一轮 | 确认后才算 |
| `GET /api/v1/approvals?status=` | 等你 | — |
| `POST /api/v1/approvals/:id/decide { action, draft_version, option_id? }` | 批、拒、答看一眼、答问我 | 确认后才算 + 乐观锁 |
| `PUT /api/v1/approvals/:id/draft { text, draft_version }` | 自己改稿 | 乐观锁 |
| `POST /api/v1/approvals/:id/redraft { note, draft_version }` | 让它改稿（同飞书卡片话题里回复，W3 加 ※） | 确认后才算 + 乐观锁 |
| `POST /api/v1/approvals/:id/snooze { until: tonight|morning|monday }` | 暂缓 | 乐观 |
| `GET/POST /api/v1/tasks`、`POST /api/v1/tasks/:id/{steer,stop,cancel,move}` | 派活、插话、停、取消、换机器 | 确认后才算（插话乐观） |
| `GET /api/v1/matters`、`GET /api/v1/events`、`PATCH /api/v1/events/:id` | 事和事件 | 乐观 |
| `GET /api/v1/timeline?from=&to=` | 时间线（personal，§读5.1） | — |
| `GET /api/v1/persons`、`GET /api/v1/self/*`、`GET /api/v1/readings`、`/crosschecks`、`/outlooks`、`/reviews`、`/body` | 读、参、觉 | — |
| `GET /api/v1/learned`、`POST /api/v1/learned/:id/veto` | 学到的、否掉（§进3.2） | 确认后才算 |
| `GET /api/v1/proposals`、`POST /api/v1/proposals/:id/decide` | 提案 | 确认后才算 |
| `GET /api/v1/nodes`、`POST /api/v1/nodes/:id/worktrees/cleanup` | 节点、可清理的 worktree | 确认后才算 |
| `GET /api/v1/usage` | 用量（含节点报的剩余额度） | — |
| `GET /api/v1/config/:file`、`PUT /api/v1/config/:file { yaml, hash }` | 配置；密钥只列名字 | 乐观锁 |
| `PUT /api/v1/secrets/:name { value }` | 写密钥，只写不读 | 确认后才算 |
| `GET /api/v1/devices`、`PATCH/DELETE /api/v1/devices/:id`、`POST /api/v1/devices/invites { role }` | 设备、加一台（W3a 起配对过的客户端经中继也能调，`hub-admin.sock` 照旧） | 确认后才算 |
| `POST /api/v1/presence { foreground, viewing? }` | 在场（§触1.1） | 不回 seq，不进 `client_ops` |
| `POST /api/v1/reads { entity, id }` | 已读 | 乐观 |
| `PUT /api/v1/devices/self/push-token { token }` | FCM 令牌（07）；`null` 清掉 | 确认后才算 |
| `PUT /api/v1/ease { on }` | 省心一键（§寸6，W3 加） | 确认后才算 |
| `GET /api/v1/blobs/:sha` | 拉大载荷 | — |

具体字段写在 `protocol/api/` 的 zod schema 里，那里是唯一出处；这张表只是第一版清单，后面只加不删。写路由的类型在 `protocol/api/write.ts` 的 `WRITES`（客户端照它显示）。

W3 定的（`protocol/api/write.ts`、`push.ts`）：
- `client_op_id`：8–64 个 `[A-Za-z0-9_-]`（UUID）※；帧本身许到 128，写路由按 64 收（04 `client_ops`）。
- 冲突的 body 一律 `{ error, <实体>: 现在的样子 }`：409 = 版本对不上，或这张卡已经被别处决定了（谁先点算谁，后到的拿到结果）；410 = 已过期、被新稿取代、已作废 ※。
- 看一眼、问我都走 `decide`：`action: "answer"` + `option_id`（问我也可 `text`；AskUserQuestion 一次问几题时用 `answers`：题 → 答，W4a 加的可选字段）；放行还是拒绝看 agent 给的选项的 `kind`。卡被拒（或作废）时，节点收到的一定是一个拒绝类选项，不管点的是哪个（主那边 fail closed，03 tasks）。
- 一般 thread 默认 `work` ※（可选 `personal`）；主线 thread 跟它的事的域。飞书镜像 thread 发消息回 409（D9 先只读）。
- 新实体 `read`（id 是 ref）、`ease`（只有一个 id `ease`）；`approval` 加可选的 `snooze`、`snooze_until`，`device` 加可选的 `push`（有没有令牌），`thread` 加可选的 `mainline_id`；bootstrap 加可选的 `ease`、`reads`。全是可选字段，W2 的主和客户端互相解析不坏。
- FCM 消息的 `data` 是 `PushData`（`ref`、`cat`、`channel`、`personal`、`push_id`）；`personal` 的标题和正文只说「有一条私人的」。

## `/node/v1`（主 ↔ 节点）

节点 → 主：

| 路由 | 用途 |
|---|---|
| `POST /node/v1/hello { version, sha, os, agents, capabilities, quotas, max_parallel?, cwd? }` | 连上先报；回 `{ target_sha, min_version }`（05 升级） |
| `POST /node/v1/tasks/:id/events { attempt, from_seq, events[] }` | 统一事件批量回传（05）；`attempt` 小于当前的整批丢 |
| `POST /node/v1/tool-calls { task_id, attempt, tool_call_id, name, args }` | 节点 agent 调主的 MCP 工具（下面） |
| `POST /node/v1/permissions { task_id, attempt, request_id, title, detail, options }` | 权限请求、`ask` → 看一眼卡（§办3.3） |
| `POST /node/v1/status { sessions, quotas }` | 心跳之外的状态变化 |
| `POST /node/v1/blobs { sha, offset, data_b64 }` | 上传大载荷（定稿 diff、长输出），分片同上 |
| `POST /node/v1/channel/{ingest,ack}` | 跑在节点上的渠道插件把收到的消息、发送结果转给主（03 channels） |

主 → 节点：

| 路由 | 用途 |
|---|---|
| `POST /node/v1/sessions { task_id, attempt, agent, cwd, worktree?, prompt, resume_ref?, handoff? }` | 开或续一个 session，回 `{ session_ref }` |
| `POST /node/v1/sessions/:ref/turns { text }`、`/steer { text }`、`/interrupt` | 发消息、插话、停这一轮 |
| `DELETE /node/v1/sessions/:ref` | 空闲释放：放掉进程，留 session |
| `POST /node/v1/permissions/:request_id { option_id, text? }` | 我答了看一眼 |
| `POST /node/v1/exec { cmd, cwd, env?, stdin? }`、`POST /node/v1/fs/{read,write}` | 只给本机节点：主 agent 的 `bash`、读写文件、`check` 脚本（05） |
| `POST /node/v1/git/checks { repo, pr }` | CI 盯守的单次查询（§办3.4） |
| `POST /node/v1/worktrees/cleanup { path }` | 我点了「清理」 |
| `POST /node/v1/backup/put { name, offset, data_b64 }` | 备份副本（03） |
| `POST /node/v1/channel/send { channel, to, body }` | 主经节点上的渠道插件发出（已过闸门、审批） |

- W4 落地的字段在 `protocol/node/v1.ts`、`protocol/node/hello.ts`，加的几处 ※：hello 带 `app_version`、`upgrade { from, to, ok, error? }`（上次升级失败就报）、`sessions`（重启后 state 文件里还有的）；回复带 `accepts_work`（协议低于 `min` 为 false，只升级不派活）、`owner_git`（PR 评论只认的我的 git 平台身份）；`steer` 回 `{ applied }`，false 就是排到下一轮；`DELETE sessions/:ref` 有活或有等待点回 409；`permissions/:request_id` 回 `{ ok, gone? }`，`gone` 是节点那边已经没有这条请求（重启过），主按 §办3.3 续上重问；`blobs` 带 `total`，到头那片校验 sha。
- 客户端看的任务和节点在 `protocol/api/tasks.ts`、`entities.ts`：`Task` 加了 `sessions`、`worktrees`、`prs`、`diff_stat`、`needs_you`、`waiting_approval`、`queued_steers`、`caps`（都可选）；新实体 `node`（`nodes` 拼 `devices`，`sha`、`target_sha`、`upgrade_failed` 存在 `nodes.extra_json` ※）；步骤就是 `task:<id>` lane 的 `item`。
- 节点不能调 `/api/v1`（403）：批不了审批、答不了看一眼、发起不了对话、读不到 `self/` 和命盘（§触6.7）。有测试。
- 主发给节点的指令都是单次的；节点不存定时状态（§底4.1）。

## 远端节点怎么调主的 MCP 工具（Y2）

- 节点程序给每个 session 挂一个 MCP server，名字 `sbot`：
  - 四家都是 stdio 小程序 `sbot-node mcp` ※（W4b；原来 Claude 写的是 SDK 的 in-process MCP，一个实现少一套），它经守护进程的 ctl socket 连节点守护进程，是哪个 session 靠环境变量里的句柄（05）。Claude 在 `mcpServers.sbot` 里给 stdio 项。挂法 P5–P8 核实过：Codex 在 `thread/start` 的 `config` 里给 `mcp_servers.sbot.*`；pi 没有 `--mcp-config`，靠节点带的扩展 `registerMcpServer`；ACP 在 `session/new` 的 `mcpServers`（05、08）。
- 每次工具调用 → 节点守护进程 → `POST /node/v1/tool-calls` → 主的工具层（同一套闸门）→ 结果原路回。幂等键 `task_id:attempt:tool_call_id`。
- 节点任务能用的工具 = 三列表第二列（任务触发的 run，§底3.1）加 `submit_report`、`ask`。`send` 照旧走审批卡。
- 反向开放（我自己在 Mac 上开的 agent 也挂这个 MCP）：同一个 stdio 小程序，以那台节点的身份调，工具同上；`console.yaml` 的 `mcp_open` 默认关，打开走 `widening()`（§办3.2）。

## 版本

- `protocol/version.ts`：`PROTOCOL = { current, min }`。握手第二条消息和 `/api/v1/meta` 都带；客户端、节点比 `min` 旧就提示升级，不猜着跑（§触6.2、§办3.1）。
- v1 里只做加法：新的可选字段、新路由、新实体、新事件类型。CI 的 `protocol-check` 管（01）。
