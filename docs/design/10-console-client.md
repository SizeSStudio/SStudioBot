> 导航：[设计文档索引](../DESIGN.md) · [上一篇：Agent RSI、以事为轴、因缘](09-rsi-matters-graph.md) · [下一篇：附：参考](99-references.md)

## 19. 控制台客户端：前后端拆开、对话、设备（v0.20，设计稿）

> **状态：只有设计，没有实现。** [§19.10](#1910-需要我拍板的决定) 的决定我点头之前不动手。[§10](05-console.md#10-配置控制台m3-起) 写的是现在跑着的控制台，这一章是它的下一代；P5 完成替换之前两者并存，[§10](05-console.md#10-配置控制台m3-起) 的规则继续有效。
>
> **v0.24：这一章要按新的 [§0](00-principles.md#0-第一性原理v024-重写) 重做。** 下面的分层、协议、设备验证、飞书验收表这些工程部分大体可以留着；页面和入口要从"陪伴"出发重新想：主入口是主 agent，先读懂、再互参、少展示。重做之前不动手。
>
> **v0.25 补充（对手机端的输入要求，重做本章时一并纳入）**：手机端（重点照顾 Android）不只是把控制台搬到小屏，还要承接身体档案的三条低门槛输入（[§15.19](08-companion.md#1519-身体档案v025)）：① 可选读取系统健康汇总（如 Android Health Connect 的日级睡眠、步数、心率摘要，默认关、由我开启）；② 拍照 / 上传体检报告（PDF、照片、健康 App 截图）并走确认入账；③ 随手一句话记身体感受。三条都直走 owner 隔离接口写入 `body_entries` 与私人附件区，不经信息源和 Triage；同时在「读」「参」的视图里预留 `crosschecks` 互参账本和苦事 `paused`（先搁着）的入口。

### 19.1 方向

我定的四条：

1. **控制台是全集**。飞书管飞书相关的：工作期间不打开控制台，只靠飞书也能做完所有工作上的操作。生活、`self/`、复盘、命盘不进飞书的群和工作台；在控制台和我的飞书私聊里都能看（[§15.9](08-companion.md#159-自我档案)）。
2. **客户端拆出去**。VPS 上只做 server（API + 事件流），客户端可以重一点、可以用框架，好用最重要。以后要有 Mac 和安卓。
3. **控制台能直接和主 agent 对话、驱动它**，但设备要验证：新设备经已信任的设备或飞书确认才能接入，能看到、能吊销。
4. **体验照 T3 Code**：左边 thread 列表，中间对话，回复流式出来，工具调用、审批、开出去的任务、diff 都实时出现在对话里，切换不重新加载。

由此定下四条设计原则：

- **状态只有一份**。审批、任务、事、事件、记忆都在核心的 SQLite 和 agent-home 里，飞书和控制台都只是入口。谁先点算谁，和 [§10.4](05-console.md#104-重做2026-11-17-定参考-t3-code-和-magpie) 一样。
- **控制台是多一个入口，不是第二套规则**。闸门分级、审批状态机、预算、主动消息上限都不因为换了入口而变。
- **新入口只会收得更紧**。飞书私聊现有的工具和权限不动；设备、公网对话都是新增能力，默认关，由我确认（[§19.10](#1910-需要我拍板的决定)）。
- **核心不依赖客户端**。客户端全挂了，飞书和核心照常工作。

### 19.2 分层和仓库布局

```
 Web（先行）   Mac（Tauri）   安卓（壳）
      └───────────┼───────────┘
          clients/app：同一套 React 应用
          规范化 store · 协议客户端 · 设备密钥
                  │  HTTPS：POST 写操作 + 流式 GET 事件
      ┌───────────┴───────────┐
 tailnet 入口              公网入口（nginx）
      └───────────┬───────────┘
          core：/api/v1 + 事件流 + （可选）静态托管
          SQLite · agent-home · 飞书 · dispatcher · worker
```

**同一个仓库，新目录**。一个人维护，协议和两端最好在同一个 PR 里改、一起过 CI；拆仓库只多出版本对齐的工作。

```
core/                  服务端。没有构建，部署方式不变
  protocol/            线上协议：zod schema 和类型（可擦除 TS）。两端唯一共享的代码
  src/ console/ …      console/ 是旧控制台，P5 之前继续服务
clients/               npm workspace，自己的 lockfile
  app/                 React 应用：页面、store、协议客户端
  web/                 Vite 入口
  desktop/             Tauri（Mac）
  android/             安卓壳
```

依赖方向只有一条：`clients/` 可以 import `core/protocol/`，`core/` 不 import `clients/`。协议放在 `core/` 底下，是因为服务器只导出 `core/`。

**发布**

- **要先改一处部署**：`sbot-deploy --if-new` 现在只比 commit，`main` 上任何新提交都会让核心切版本、重启，只改 `clients/` 或文档的合并也一样。客户端提交一多，核心就会被无谓地重启，打断正在跑的 run 和所有事件流。改成：**这个 commit 的 `core/` 树和线上相同就不切换、不重启**。这是 `deploy/` 的改动，要手动跑 `install.sh`，**必须在 `clients/` 第一个提交合入之前上线**。副作用：状态页显示的版本是核心最后一次变化的提交。
- **CI**：加一个单独的 job，只在 `clients/**` 或 `core/protocol/**` 变化时跑：`npm ci --ignore-scripts`、类型检查、测试、构建。`core/protocol/` 也加进现有的语法检查；leak-guard 本来就扫全部 tracked 文件。产物里不嵌任何实例地址，服务器地址在配对时才进客户端。
- **Web**：构建只在 CI 上做（[§1.3](01-runtime-identity-channels.md#13-部署单机轻量2026-11-16-定)，重构建不上 VPS），产物是带内容 hash 的静态文件包，附 sha256 和构建来源证明。服务器上一个独立的 `sbot-client-deploy` 拉包、校验、解到 `releases/<sha>`、原子切 `current`，不碰核心，能 `--ref` 回滚。前几个阶段手动触发，稳定后再上定时器（D11）。
- **托管**：核心把这个目录挂在 `/app/`，复用 [§10.5](05-console.md#105-响应性能2026-11-18) 的静态文件逻辑（ETag、预压缩）。这样两个入口都能用，也不用改 nginx。目录不存在就回 404，核心不依赖它。旧控制台留在 `/`。
- **Mac / 安卓**：壳里打包前端资源，**不从服务器加载代码**。Mac 走签名和公证，安卓先侧载（D10）。
- **协议版本**：路径 `/api/v1`，v1 内只做加法；客户端忽略不认识的事件和字段。`/api/v1/meta` 返回当前和最低支持的协议版本，已安装的客户端太旧时提示升级，不猜着跑。

**`CLAUDE.md` 的改法**：`core/` 仍然无构建；`core/console/` 仍然是原生 ES modules，只维护不加新页面；`clients/` 可以用框架和构建，但依赖要少、锁版本、不跑安装脚本。「动到什么要在 PR 开头标出来」加上鉴权、设备、入口。

### 19.3 技术选型

看三件事：**好用、流畅、一个人维护得动**。这个产品的难点是长列表里的流式 markdown、diff、代码块，这些 Web 生态最成熟。

| | A. React + Vite，Tauri 2 做壳（推荐） | B. React + Vite，Capacitor 做安卓，Tauri 或 Electron 做 Mac | C. React Native / Expo，RN Web，RN macOS |
|---|---|---|---|
| 共用代码 | 一套 UI，壳很薄 | 一套 UI，两种壳 | 大部分共用，三端都要调 |
| 流畅 | 桌面好；安卓取决于 WebView，**要实测** | 同 A，安卓 WebView 路线更成熟 | 手机列表和手势最好 |
| markdown / diff | 直接用 Web 生态 | 同 A | 要自己拼原生渲染，或塞 WebView，等于做两遍 |
| Mac | 体积小，用系统 WebKit，要测 WebKit | Electron 最稳但重 | RN macOS 跟进慢，是最弱的一端 |
| 一个人维护 | 最省，Web 先行的成果全部复用；要碰一点 Rust 配置 | 两套壳的配置和插件 | 最重：原生构建链、三端差异 |

**推荐 A，安卓留退路**。先做 Web，每个阶段都能用上；Mac 用 Tauri；安卓先用一个限时 spike 试 Tauri（P1.5），不达标就换 Capacitor。壳很薄、UI 是同一份，换壳的代价小。T3 Code 也是 React + Vite 的 Web 应用加一层桌面壳，加一个共享的协议包，路子相同。

- 不选 PWA 当终点：后台、通知、密钥存储都受限。但 Web 版本身可以加到主屏，当过渡。
- 不选 Flutter：要放弃 Web 生态，文字渲染和 Web 端都不合适。
- 依赖从少开始：React、Vite、虚拟列表、markdown 解析。状态用手写的 store 加 `useSyncExternalStore`。每加一个依赖都是供应链风险（[§19.8](#198-威胁模型)）。
- **Tauri 的 `useHttpsScheme` 要在第一次发版前定**，改它会换 origin，IndexedDB 里的设备密钥就没了。

**界面**：桌面左边 thread 列表、中间时间线、右边按需的详情（链路、diff、任务）；手机是列表和对话两级。工具调用默认折叠，运行中显示状态；审批卡、任务卡就地出现在时间线里；只渲染可见区域；切 thread 直接读 store，不发请求、不白屏。

### 19.4 事件流协议

**分两种事件**：

- **持久事件**：有单调序号 `seq`，断线能补。表达的是「某个实体变了」。
- **增量事件**：token 增量和状态心跳，没有 `seq`，丢了靠快照补，不进数据库。

**序号从哪来：SQLite 触发器写变更表。**

```sql
change_log(seq INTEGER PRIMARY KEY AUTOINCREMENT, ts, entity, ref, op)  -- op: upsert | delete
```

写业务表的地方散在各处（飞书、定时器、任务、审批、控制台），靠每处记得发事件迟早漏。触发器和业务写入在同一个事务里：回滚就没有事件，提交就一定有。核心是单连接同步写，`seq` 的顺序就是提交顺序。这张表只记「谁变了」，不存内容，保留 7 天。

**发送**：进程里一个 pump，大约每 100 ms 读 `seq > 上次`，同一批里同一实体只算一次，**发送时**用和 API 相同的视图函数取最新内容，再按每个连接的权限过滤。所以事件是「这个实体现在长这样」，重放是幂等的，中间状态可以被合并。被权限滤掉的事件不发，但心跳带最新 `seq`，游标照样前进。

```ts
type Durable = { seq: number; ts: number; entity: Entity; id: string; op: "upsert" | "delete"; data?: unknown };
type Delta   = { t: "delta"; run: string; item: string; off: number; text: string };   // off：UTF-16 下标
type Snap    = { t: "snapshot"; run: string; item: string; text: string; tool?: string };
type Beat    = { t: "beat"; seq: number; status?: unknown };
type Reset   = { t: "reset" };                                                         // 序号太旧，重新 bootstrap
```

| 要看到的 | 实体 / 事件 | 来源 |
|---|---|---|
| 输入进队列、被处理 | `input` | `inbox` 触发器 |
| run 开始、结束、出错 | `run` | `runs` 触发器 |
| 一段回复写完 | `item`（assistant） | 新表 `run_items` |
| token 增量 | `delta` | runner，不落库 |
| 工具调用开始、结果 | `item`（tool） | `run_items` |
| 审批创建、改稿、决定 | `approval` | `approvals` 触发器 |
| 任务状态、问题、结果 | `task`；步骤是 `item` | `tasks`、`run_items` |
| 事件账本 | `event` | `events` 触发器 |
| 事、主线变化 | `matter` | `matters`、`matter_ops` 触发器 |
| 配置改动 | `config`（文件、来源、时间；diff 要 `config` 权限） | `config_changes` 触发器，密钥只有名字 |
| thread、设备 | `thread`、`device` | 新表 |
| 服务状态 | `beat.status` | [§10.5](05-console.md#105-响应性能2026-11-18) 的共享计算 |

**时间线不重复存**：输入来自 `inbox`，审批、任务按 `run_id`、`origin_lane` 关联，`run_items` 只存现在没存的东西（一段回复、一次工具调用）。视图函数把它们合成统一的时间线项。

```sql
run_items(id INTEGER PRIMARY KEY, lane, run_id, kind, status, ts, ended, name, body_json, truncated)
          -- kind: assistant | tool | notice；参数和结果截断存，完整内容看 requests（§10.4，7 天）
```

- runner 现在把工具参数和结果都丢了，要加结构化回调，转发 pi 的 `message_update`、`tool_execution_start/end`。回调出错不能影响 run，和现在的 `onStream` 一样。worker 那边把 SDK 消息里的工具块也转发出来。
- **进 `run_items` 和推流之前都要打码**：已知密钥的值和常见密钥格式。工具的输入输出第一次变成持久可见的内容，「密钥只写不读」要守在这里。token 增量也要过这一道。

**连接和续传**

```
GET /api/v1/bootstrap               → 快照 + 当时的 seq（一次同步读，内容和 seq 一致）
GET /api/v1/stream?after=<seq>      → 先补 seq > after，再发运行中条目的 snapshot，再转实时
GET /api/v1/threads/:id/items?before=<cursor>   → 翻历史
```

- 客户端只有 `off == 当前长度` 才接受 delta；对不上就等 snapshot。重连后不重复、不缺字。
- `after` 比保留期还早：发 `reset`，客户端重新 bootstrap。
- **慢连接不堆内存**：每个连接只有自己的游标，写不动时停止读取，持久事件之后再补；delta 直接丢，缓过来后发一次 snapshot。
- 心跳 20 秒一次，低于 nginx `location /` 的 300 秒读超时；响应带 `X-Accel-Buffering: no`，这样不用改 nginx（P1 验证）。事件流不压缩（[§10.5](05-console.md#105-响应性能2026-11-18)）。

**传输选 SSE 格式 + `fetch` 流式读取，不用 WebSocket，也不用 `EventSource`。**

- 流量基本是单向的，写操作用普通 POST，天然有状态码、重试和幂等。
- WebSocket：Node 没有内置的 server，要加依赖或自己写帧；nginx 要加 Upgrade 配置（`deploy/` 手动上线）；浏览器的 WebSocket 不能带自定义头，凭据只能放 URL 或首帧。
- `EventSource` 也带不了自定义头，重连也不归我们控制。`fetch` 流都能做，实验在 Chromium 和 WebKit 上都通过了（[§19.11](#1911-实验记录2026-11-18)）。
- 手机后台本来就会断连，所以「断了就用序号补」是主路径，不是异常路径。

**客户端状态**：按 `(entity, id)` 规范化存放，每条记着 `seq`，旧的不覆盖新的；组件只订阅自己用到的实体，一条事件只重画受影响的那一块。内容默认只在内存里，不落盘（`personal` 的内容不落盘是硬规则，其余以后按需要再定）。

**写操作**

- 每个写请求带 `client_op_id`，`client_ops(device_id, client_op_id, result_json, ts)` 和业务写入同事务，重试不会做两次。发消息直接用 `inbox` 现有的唯一键 `(source, source_msg_id)`，`source_msg_id` 取设备 ID 加 `client_op_id`。
- 响应带这次写入对应的 `seq`。客户端先显示一层乐观状态，流追到这个 `seq` 再去掉，不闪；失败就撤掉并提示。

| 类型 | 例子 | 怎么显示 |
|---|---|---|
| 乐观 | 发消息、改 thread 名和置顶、改事件状态 | 立刻生效，失败回滚 |
| 确认后才算 | **批准 / 拒绝**、取消任务、停止 run、派任务 | 立刻显示「处理中」，服务端确认才变状态。有对外后果的动作不能先画成已完成 |
| 乐观锁 | 审批带 `draft_version`，配置带文件 hash | 冲突回 409 和最新内容，客户端显示最新状态，不覆盖 |

**任务和 diff**：任务视图不假设 worker 在哪，任务带 `executor { kind: local | t3 | herdr, host, external_ref }`，步骤、问题、结果、diff 都走同样的实体。worker 派到别的机器怎么做由另一份设计定，这里只留位置。运行中的 diff 来自 `Edit` / `Write` 的工具输入，定稿的 diff 从镜像算（[§4.2](02-roles-models.md#42-worker默认-light-档可以升到-chat-档)，核心不在 worker 目录里跑 git）。diff 和工具输出都按不可信文本渲染。

### 19.5 对话

**和飞书的关系：状态合一，对话分开。**

| 方案 | 结果 |
|---|---|
| 控制台和飞书私聊共用一个 lane | 一个 lane 同时只跑一轮，开多个 thread 就没意义；个人话题会进飞书能接触的上下文；回复该发到哪也说不清 |
| 完全独立 | 两边互相看不到，「状态一致」做不到 |
| **thread 各自独立，状态共享，飞书 lane 在控制台里能看（推荐）** | 记忆、事、审批、任务全通；上下文不互相污染；飞书照样独立够用 |

这和 [§3.3](01-runtime-identity-channels.md#33-滚动会话的生命周期)「飞书私聊和微信是两个会话，但共享全部记忆」是同一个做法。

**映射**

```sql
threads(id, lane UNIQUE, kind, domain, title, matter_id, task_id, status, pinned, ceiling,
        created_by_device, created_at, last_item_at)
        -- kind: general | matter | task | feishu；domain: work | personal；ceiling: tailnet | public
```

| thread | lane | 输入去哪 |
|---|---|---|
| 一般对话 | `console:t:<id>`，自己一个 session | 主 agent |
| 按主线 | 同上，绑定 `matter_id`，每轮带上主线的摘要、子事、最近事件 | 主 agent |
| 按任务 | `task:<id>` | 现有的 `replyTask`，给 worker，不给主 agent |
| 飞书镜像 | `feishu:dm:owner`、`feishu:wb:*` | 先只读；「在这接着说」放后面（D9） |

- **主线**：左栏按主线分组，一条主线可以有几个 thread。分组在读取时沿 `parent_id`、`merged_into` 算，thread 上不存。所以挂、拆、合并（[§15.3](08-companion.md#153-事是一等对象)）以及它们的撤销，列表都自动跟着变，不用迁移。两段对话不合并，只是归到一组。
- **运行**：`TurnContext` 加 `channel: "console"`；定时器和任务结果用存下的 turn 回到发起的 thread，这条路现在就是通的。回复仍然先写 outbox，console 渠道当场标记已送达，并写一行 `messages`（收尾摘要要用）。
- **不滚动**：thread 不按空闲 4 小时换 session，靠 pi 的压缩。但空闲到点还是写一次收尾要点（按域，见下），否则记忆里没有这段对话。想重开就新建 thread 或点「新会话」。
- **停止、排队**：每个 thread 单独停。排队中的输入能看到、能撤回。`MAX_CONCURRENT` 保持 2，不因多 thread 调大；有人在等的输入优先于定时器和后台事件。

**两个域，`personal` 不流向飞书**

thread 分 `work` 和 `personal`，沿用事的 `domain`。这一条要专门做，因为现在的 owner 身份在飞书 lane 里也能搜到全部日志和 `self/`：

- `personal` thread 的收尾要点、记录写到 `self/` 下单独的位置，带域标记。
- `memory_read`、`memory_search`、`timeline_query` 在飞书的群和工作台过滤掉这些内容。我在飞书私聊里亲手问的不过滤（[§15.9](08-companion.md#159-自我档案)）。
- `personal` thread 不在飞书镜像，主动消息到不了时，飞书只发一句不带内容的「控制台有新消息」，并计入 [§9.3](04-memory-timers.md#93-先安静) 的上限。
- `work` thread 的主动消息（定时器、任务结果）在没有客户端在线时，把内容转到飞书私聊。这样我不开控制台也不会漏。

**从控制台发起的工作，飞书仍然完整可见**：任务照样开工作台话题，审批照样发管理群卡片，问题照样能在话题里答。否则「只靠飞书也够」就破了。

**工具权限：按入口、设备、域取交集。**

```
本轮工具 = toolsFor("owner") ∩ 入口上限 ∩ 设备权限 ∩ 域规则
```

每个工具原有的闸门等级（[§7.1](03-wechat-permissions.md#71-动作分级)）不变，这里只决定它出不出现。

| 工具 | 飞书私聊（不变） | tailnet thread | 公网 thread（默认关，D2） |
|---|---|---|---|
| 回复、读写记忆、搜索、时间线、`web_search` | 有 | 需 `chat`，`personal` 内容另需 `life` | 同左 |
| 事、事件、跟进 | 有 | 需 `chat` | 需 `chat` |
| `send`、`request_approval`（进审批） | 有 | 需 `chat` | 需 `chat`，**发起的设备不能自己批** |
| `task_start`（host / sandbox） | 有 | 需 `dispatch` | **没有** |
| `task_reply`、`task_cancel` | 有 | 需 `dispatch` | 需 `dispatch` |
| 自我档案、复盘、前瞻、镜头 | 有（不贴原文） | 需 `life` | 需 `life` |

- 一轮合并了几条输入时，权限取**交集**。
- **thread 的上限只降不升**：只要有过公网输入，`ceiling` 就变成 `public`，之后 tailnet 设备在里面说话也不会得到 host worker。否则公网注入的内容可以等我回到 tailnet 时借权。定时器和任务事件按这个上限走。
- 设备被吊销：它排队的输入作废，它发起的 run 停掉。

### 19.6 飞书边界：工作操作验收表

**这张表是飞书侧的验收标准**。标准是：不打开控制台，只用飞书做完。标记：✅ 现在能做；🟡 能做但不够；❌ 做不了。「经 agent」要花 token、可能理解错，所以**审批、停止、取消、列清单**这类操作必须有不经模型的确定入口。

| 操作 | 现在 | 怎么做 / 缺什么 |
|---|---|---|
| **审批** | | |
| 批准、拒绝 | ✅ | 管理群卡片按钮，和控制台同一状态机 |
| 让 agent 改稿 | ✅ | 在卡片话题里回复 |
| 自己整段改稿 | ❌ | 只有控制台能改。缺：卡片表单或话题命令，走同一个 `draft_version` |
| 列出全部待批 | ❌ | 缺 `/approvals`：列表，能把卡片再发一次 |
| 推送代码的批准 | 🟡 | 卡片有提交列表和 stat。缺完整 diff 的查看方式 |
| 提案、回滚 | ✅ | 提案卡片；管理群 `回滚 <sha>` |
| **回复和群** | | |
| 和 agent 对话，流式看回复 | ✅ | 私聊、工作台话题 |
| 停止、开新会话 | 🟡 | `/stop`、`/new` 只对私聊有效。缺：工作台话题里也能用 |
| 代发消息 | ✅ | `send` → 审批卡片 |
| 群里有人找我时起草回复 | ✅ | Triage 起草卡片 |
| 看群消息 | ✅ | 经 agent（`feishu_chats`、`feishu_read`） |
| 群开关 | ✅ | `/group` |
| 分拣提醒上直接处理 | 🟡 | 现在是纯文本。缺按钮：起草回复、不用回、挂到事 |
| 看「等我回 / 要我拍板」的清单 | 🟡 | 只能问 agent。缺 `/todo` |
| **邮件** | | |
| 新邮件进分拣、成事件 | ✅ | 只读，默认关（[§17.3](09-rsi-matters-graph.md#173-信息源)） |
| 回邮件 | ❌ | 系统现在没有发信能力，这是新的对外出口（D8） |
| **事和事件** | | |
| 查进展、改事件状态和级别 | ✅ | 经 agent（`matter_events`、`event_update`） |
| 开事、挂靠、收事 | ✅ | 经 agent |
| 主线挂、拆、合并、撤销 | ✅ | 经 agent（`matter_regroup`） |
| 每日整理 | ✅ | 卡片按钮（[§15.14](08-companion.md#1514-每日整理v019)） |
| **任务** | | |
| 派任务 | ✅ | 经 agent（`task_start`） |
| 看任务列表 | ✅ | `/tasks` |
| 看进度、回答问题、追加指示 | ✅ | 工作台话题 |
| 取消 | 🟡 | 经 agent。缺：话题里的命令或按钮 |
| 看 diff | 🟡 | 同推送卡片 |
| **运维** | | |
| 早报、模型、用量、定时任务、触发改进 | ✅ | 早报；`/model`、`/usage`、`/job`、`/improve` |
| 立刻拉一次信息源 | ❌ | 只有控制台能做。缺命令 |
| 确认和吊销设备 | ❌ | 本章新增：配对卡片、`/devices`（[§19.7](#197-设备验证)） |

现在的代码里没有日历、云文档的写工具，两边都没有，不算飞书的缺口。以后加工作能力，规则是**飞书必须够得着**。

**不进飞书的群和工作台**：生活时间线、`self/` 全文、习气和节律全文、命盘、看法账本。这些在我的飞书私聊里可以问（[§15.9](08-companion.md#159-自我档案)）。

**只在控制台**：`personal` thread、配置文件和密钥的编辑。出生信息和镜头设置例外，私聊里也能改（`self_profile`）。

### 19.7 设备验证

**参考**：T3 Code 的远程访问（新设备显示一个码，已连接的设备核对后批准，请求 10 分钟过期，一次性配对链接，会话有范围、能吊销）。这里多一条飞书确认，并且权限分得更细。

**凭据**

- 每台设备自己生成 ECDSA P-256 密钥对，私钥**不可导出**（WebCrypto，存 IndexedDB），不离开设备。原生端以后可以换成 Keychain / Keystore。服务器只存公钥，数据库泄露也冒充不了设备。
- `device_id` 是公钥的 hash。设备名是自称的，界面上标明。
- 浏览器按 origin 隔离：同一个浏览器走 tailnet 和走公网算**两台设备**。原生端一把密钥可以用两个入口，但 token 分开。
- 浏览器可能清掉站点存储（Safari 对长期没访问的站点尤其如此）。密钥没了就重新配对，不做导出和备份。

```sql
devices(id, public_key, name, platform, scopes_json, status, confirmed_via, created_at,
        last_seen, last_ip_masked, idle_expires, absolute_expires, revoked_at, revoked_by)
device_pairings(id, public_key, name, platform, entrance, nonce, invite_id, requested_scopes,
                status, attempts, expires, ip_masked)
device_invites(id, secret_hash, created_by, scopes_json, expires, used_at)
device_audit(id, ts, device_id, action, actor, entrance, ip_masked, detail)
```

**配对**：请求 10 分钟过期，限速，同时待处理的数量有上限。确认码 `SAS = H(pairing_id, 服务端 nonce, 设备公钥)` 取 6 位，nonce 在服务端收到公钥**之后**才生成，攻击者没法反复换密钥去碰一个相同的码。

| 路径 | 什么时候用 | 流程 |
|---|---|---|
| **F1 已信任设备** | 常规 | 已信任设备出一次性二维码或链接（密钥放在 URL 的 `#` 后面，不进日志）。新设备打开、提交公钥、显示确认码；我在已信任设备上核对后确认 |
| **F2 飞书卡片** | 手边没有已信任设备 | 新设备先过入口这一关：公网要密码，tailnet 要身份头，否则连请求都发不起来（原生壳没有 cookie，公网上把密码直接交给配对接口，校验和限速同 `/_auth`）。管理群出卡片，写设备名（自称）、平台、打码的 IP，给几个候选数字；我点新设备屏幕上显示的那个。**点错请求作废** |
| **F3 服务器命令** | 第一台设备、全部丢失时恢复 | 在服务器上跑 `console-device`，和 `console-passwd` 同样的思路。能授予全部权限 |

**确认渠道只能给出它本来就有的权力**：飞书账号本来就能聊天、批审批、派任务，所以 F2 最多授予 `read`、`chat`、`approve`、`dispatch`。飞书是公司的系统，**不能授予 `life`、`config`、`devices`**；要这些得用 tailnet 上有 `devices` 权限的设备，或 F3。邀请的权限也不能超过发出它的设备。

**会话**

1. 设备用私钥签服务端给的一次性挑战，换一个 15 分钟的 access token。token 只在内存里，绑定设备和入口，在另一个入口无效（和 [§10.1](05-console.md#101-形态与访问) 的 cookie 同理）。
2. token 放自定义头 `X-Sbot-Device-Token`。nginx 现在会清掉 `Authorization`，而且这层防护应该留着，换个头就不用动它。客户端不用 cookie。
3. 读请求和事件流带 token。**写请求再加一个签名**，内容是方法、路径、body 的 hash、时间戳、nonce，时间窗外和重复的 nonce 都拒绝。token 被偷也做不了写操作。
4. 签 token 的 HMAC 密钥在 `secrets.env`，只能在服务器上用命令设，控制台的密钥页拒绝写它（同 `CONSOLE_WEB_*`）。
5. 原生壳和服务器不同源：壳的 origin 精确列进 CORS 白名单，不带 cookie。`Origin` 只防浏览器里的别的网站，挡不住任意程序，真正的边界是设备凭据。

每个请求都查一次 `devices` 这一行，所以**吊销立刻生效**，不用等 token 过期，已打开的事件流当场断开。

**建议的过期时间**（D5）：浏览器空闲 14 天，原生空闲 60 天，都有 180 天绝对上限，到期重新确认。

**权限**

| scope | 能做什么 | 飞书能授予 | tailnet | 公网 |
|---|---|---|---|---|
| `read` | 看 `work` 域的 thread、待办、任务、事 | 能 | ✓ | ✓ |
| `chat` | 和主 agent 对话 | 能 | ✓ | **默认关**（D2） |
| `approve` | 批审批 | 能 | ✓ | ✓，受下面的分离规则限制 |
| `dispatch` | 派任务、回复和取消任务 | 能 | ✓ | 不能派，能回复和取消 |
| `life` | 生活、`self/`、命盘、`personal` thread | 不能 | ✓ | ✓ |
| `config` | 配置、密钥、模型 | 不能 | ✓ | **不能** |
| `devices` | 管设备 | 不能 | ✓ | 只能看和吊销，不能批准和提权 |

**发起和批准分离**：公网设备发起的 run 产生的审批，这台设备自己不能批，要换一台设备，或者点飞书卡片。否则偷到一台解锁的手机，就能一路「让它发消息 → 自己批准」。审批记下来源设备和入口，决定记成「经控制台 · 设备名」。

**和现有入口的关系**

| 入口 | 现在 | 这章之后 |
|---|---|---|
| tailnet（身份头） | 全部权限 | **保留**。旧控制台不变；`/api/v1` 要身份头**加**设备凭据 |
| 公网密码 | 全部权限，包括审批、改配置、写密钥（密码自身的除外） | 旧控制台先不变。`/api/v1` 不认密码会话；密码只作为 F2 的门票。**建议** P2 之后收窄（D7） |
| 设备 | 无 | `/api/v1` 唯一的凭据 |

P5 旧控制台下线后，密码只剩下「开始配对」这一个用途。

**管理和急停**

- 控制台的设备页：名称、平台、权限、最近活动、打码的 IP，能改名、降权、吊销。
- 新设备接入、权限变化、吊销、从没见过的 IP 段，都在管理群通知。
- 飞书 `/devices` 列出设备，`/devices revoke <id>` 吊销一台，`/devices revoke-all` 全部吊销。设备丢了、手边又没有别的设备时，这是最快的办法。
- `console.yaml` 里有总开关：`/api/v1` 整体、公网对话、公网配对各一个。打开任何一个都走 `widening()`，在管理群醒目提醒。

### 19.8 威胁模型

公网能驱动主 agent，等于把一个有记忆、有工具的 agent 放到了互联网可达的地方。这是这章最大的新风险，所以默认关（D2）。

| 威胁 | 后果 | 防护 | 还剩什么 |
|---|---|---|---|
| 互联网扫描、撞接口 | 探测、耗资源 | 没有设备凭据一律 401；配对先过密码；nginx 和核心两层限速 | TLS 和 nginx 自身的漏洞 |
| 密码泄露 | 能发起配对 | 配对还要飞书或已信任设备确认，点错作废，每次都有通知 | 旧控制台的密码会话权力仍然大，见 D7 |
| 确认疲劳（反复弹卡片诱导点击） | 误批设备 | 必须匹配新设备屏幕上的码；限速；同时多个请求时卡片警告 | 我自己看错 |
| 飞书账号被盗 | 能批设备、批审批 | 飞书授予不了 `life`、`config`、`devices`；有通知；飞书账号被盗本来就能驱动 agent，这里不扩大 | 工作范围内的能力 |
| 解锁的设备被偷 | 以这台设备行事 | 权限分级；公网不能派任务、不能自批；能远程吊销；原生端以后加本地解锁 | 吊销之前能看到的内容 |
| token 被偷 | 冒充读取 | 15 分钟、只在内存、绑定入口；写操作要签名 | 有效期内能读 |
| **XSS**（agent 输出、群消息、邮件、diff 里的内容） | 借页面用设备密钥（偷不走，但能用） | markdown 净化，不渲染原始 HTML，不加载远程图片；严格 CSP；外链要确认；Tauri 权限最小化 | 页面打开期间；这是客户端的头号安全要求 |
| 提示注入（经 web、邮件、群消息） | 诱导 agent 动手 | 对外动作照旧要审批；公网 thread 没有 `task_start`；`ceiling` 只降不升 | 和飞书私聊相同的残余 |
| 供应链、CI 被污染 | 前端被植入，能使用设备密钥 | 依赖少、锁版本、`--ignore-scripts`、产物校验；Web 发布按安全边界对待 | 上游被投毒且未被发现 |
| 重放 | 重复写操作 | 时间窗 + nonce + `client_op_id` | 无 |
| 刷 LLM 预算 | 花钱 | 每轮预算不变；每设备限 run 频率和日预算；用量按设备记 | 限额内的消耗 |
| 本机其他用户 / www-data | 直连 socket | 直连也要设备凭据；公网 socket 不信 tailnet 头（[§10.1](05-console.md#101-形态与访问)） | 只能伪造 `X-Real-IP`，影响限速和显示 |
| host worker（有 sudo） | 能改数据库和密钥 | 设备系统挡不住它，这是 [§7.6](03-wechat-permissions.md#76-隔离与凭证) 已有的软边界 | 不变 |

### 19.9 分阶段

每个阶段都能单独上线，也能单独停掉。冒烟测试在服务器上跑。

| 阶段 | 做什么 | 里程碑（可验证） |
|---|---|---|
| **P0** | 这一章；我确认 [§19.10](#1910-需要我拍板的决定) | PR 合入 |
| **P1 只读事件流** | 先改 `sbot-deploy`。`core/protocol`、`change_log`、`run_items`、`/api/v1` 只读、Web 只读的 thread 列表 + 时间线 + 链路。**只在 tailnet**，靠身份头，默认关 | ① 飞书私聊说一句，Web 上逐字出现，工具调用实时开始和结束 ② 反复断线重连，文字不重不缺 ③ 切 thread 不发请求 ④ 经真实的 tailscale serve 和 nginx 流式不被缓冲 ⑤ VPS 上 20 个连接时事件循环和内存有实测数字 ⑥ 只改 `clients/` 的合并不重启核心 ⑦ 旧控制台不受影响 |
| **P1.5 安卓 spike** | 限时 1～2 天，Tauri 安卓壳加载 P1 的 Web | 长列表流式不掉帧；中文输入法和软键盘正常；切后台再回来能续上；杀进程后密钥还在；能扫码。不达标换 Capacitor 再试 |
| **P2 设备** | 配对、会话、吊销、设备页、`/devices`，公网开只读 | F1、F2、F3 都走通；吊销后 1 秒内断流；重放和跨入口 token 被拒；飞书确认拿不到 `life`、`config`、`devices` |
| **P3 写操作** | 审批、任务、事件的写操作，乐观更新和回滚；待办和会话追平旧控制台；任务步骤和 diff | 飞书和客户端同时点同一张审批，只有一个生效，两边状态一致；断网重试不重复；任务的工具调用和 diff 实时出现 |
| **P4 对话** | 控制台 thread（一般、主线、任务），先 tailnet；`personal` 隔离。公网等 D2 | 流式、停止、排队都通；权限表逐项有测试；飞书 lane 搜不到 `personal` 的内容；主动消息按域转飞书 |
| **P5 替换** | 生活、它自己追平；旧控制台下线；密码入口收窄 | 功能对照清单全部通过，`core/console` 删除 |
| **P6 Mac** | Tauri 打包、签名、更新 | 安装版日常可用；密钥重启后还在 |
| **P7 安卓** | 按 spike 的结论做 | 同上，加扫码配对 |
| **并行 F** | 飞书验收表的缺口。先做确定性的：`/approvals`、`/todo`、话题里的停止和取消；再做卡片按钮和改稿 | 表里每行按「只开飞书」走一遍 |

### 19.10 需要我拍板的决定

括号里是建议。没拍板的，按更紧的那边做，或者不做。

| # | 决定 | 建议 |
|---|---|---|
| D1 | 技术路线和仓库布局 | 方案 A，同仓库 `clients/` |
| **D2** | **公网能不能驱动主 agent** | 先不开。P4 在 tailnet 跑稳后单独决定；开也只开 `work` 域，不能派任务 |
| D3 | [§19.7](#197-设备验证) 的权限表和入口上限 | 按表 |
| D4 | 飞书确认能授予的范围 | `read`、`chat`、`approve`、`dispatch`，不含 `life`、`config`、`devices` |
| D5 | 设备过期时间 | 浏览器 14 天空闲，原生 60 天空闲，绝对 180 天 |
| D6 | 公网发起的审批不能由同一台设备批 | 要 |
| D7 | 公网密码会话收窄（去掉审批、配置、密钥写入）。这是**收紧**，但改变我现在的用法 | P2 稳定后收窄，P5 只留配对 |
| D8 | 飞书要不要能回邮件。这是**新的对外能力**，要走 L2 审批，还要新的邮件权限 | 单独评估，不随本章上线 |
| D9 | 控制台能不能接着飞书的 lane 说话 | 先只读；以后要做，回复留在飞书，并标明经控制台 |
| D10 | Mac 签名公证、安卓分发方式 | Mac 用开发者账号（费用由我定），安卓侧载 |
| D11 | Web 客户端自动部署 | 前期手动，P3 后再上定时器 |
| D12 | `personal` 的存放位置和离线提醒 | 按 [§19.5](#195-对话) |

权限、预算、auto 规则本身不因这一章改变（[§16](09-rsi-matters-graph.md#16-agent-自己的-rsi越用越会办事) 的 D 级）。每设备的预算和频率限额是新增的**限制**，数值由我定。

### 19.11 实验记录（2026-11-18）

都在作者的 Mac 上做（Node 25.8.1，本机回环），代码在临时目录，没有进仓库，也没有部署。

| 验证什么 | 结果 |
|---|---|
| 触发器变更表（2 万行） | 每次插入从 7.4 到 14.6 µs，更新从 5.7 到 13.3 µs，每次多 7～8 µs；空轮询 0.76 µs；取 200 行 53 µs；回滚不留事件；清理后序号不重用 |
| `fetch` 流跨域带请求头，每 400 ms 强制断线（Playwright 的 Chromium、WebKit） | 56 次重连，0 重复、0 缺失，7500 字 hash 一致。实验用的是 `Authorization`，设计换成自定义头，两者都走 CORS 预检 |
| 浏览器不可导出的 P-256 密钥（同上两种浏览器） | `exportKey` 被拒；重启浏览器后还在；挑战和写签名由 `node:crypto` 验证通过；吊销后 401。验签约 50 µs 一次 |
| 1 / 5 / 20 个连接，每秒 60 个增量 | 事件循环 p99 约 6 ms（定时器精度 5 ms，即看不出延迟），最大不超过约 19 ms |

**没有验证的，要在对应阶段实测**：nginx 和 tailscale serve 下的流式（P1）；VPS 上的真实性能（P1）；真机安卓 WebView、Tauri 的 WKWebView、Safari 上的流式和密钥持久化（P1.5、P6）；Tauri 安卓的整体成熟度（P1.5）。

> 导航：[设计文档索引](../DESIGN.md) · [上一篇：Agent RSI、以事为轴、因缘](09-rsi-matters-graph.md) · [下一篇：附：参考](99-references.md)
