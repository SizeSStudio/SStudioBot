# 03 主（`hub/`）

单进程。设计在 §底1–§底4、§办1–§办3、§触1.1；表在 04；旧代码怎么搬在 10。这里定模块边界、接口和代码规则。

## 启动顺序

`config`（zod 校验，坏了拒绝启动并说哪一行）→ `db`（开库、`user_version`）→ `memory.ensureAgentHome` + seed 同步 → 密钥读进内存、打码接上（`setRedactor`）→ `proxy` → `inbox.recover` → `link`（本机 socket；`relay.enabled` 时连中继）→ `channels` 各插件 start → `outbox`、`push`、`inbox` 派发、`timers`、`sentinel`、`api.pump` 起 → 打印 `hub up` → 上线通知（经管理通知出口）。W1d 起 proxy、recover、`hub.sock`、outbox、派发和审批过期扫描（每分钟）；渠道、push、timers 等 W1e、W2 各就各位。

关停：停收新输入 → 等跑着的 run 到下一个安全点（最多 30 秒）→ 没跑完的按 §底1.2 的重启规则处理 → 关通道 → 关库。

## 模块

| 模块 | 管什么 | 主要的表 |
|---|---|---|
| `main` | 装配、启动、关停、上线通知 | — |
| `db` | 开库、`tx()`、`emit()`、清理和 blob GC（04 §11） | 全部 |
| `config` | 加载、热加载（按 mtime）、zod、`widening()`、表单描述、唯一写路径、`config_changes` | `config_changes` |
| `inbox` | 落库、lane、合批、派发、插话、停、重启恢复、熔断 | `inbox`、`runs` |
| `runner` | Runner 接口；pi 嵌入；提示词拼装；压缩；换模型 | `sessions`、`run_items` |
| `tools` | 注册表、三列可见性、闸门、守卫、打码 | — |
| `approvals` | 状态机、渠道无关的卡片模型、看一眼、问我 | `approvals` |
| `outbox` | 出口组、幂等投递、`send_by` | `outbox` |
| `channels/` | ChannelPlugin 接口；`feishu/` | `messages`、`chats`、`chat_cursors` |
| `sources/` | SourcePlugin 接口；内置 git、fetch、飞书邮箱；command 插件 | `messages`、`raw_sources` |
| `triage` | 分拣、事件账本、注意力窗口、自动关 | `events`、`messages` |
| `ledgers` | 事、整理、人和图谱、解读、互参、前瞻、复盘、`self_items`、`noticings`、身体、随手记、建议、学到的、`dismissals` | 04 §7–§9 |
| `memory` | agent-home 写队列、journal、wiki 和检索、原始资料 CAS、dream、`forget`、`memory_patch`、seed | `pages_fts`、`raw_sources` |
| `lens` | 排盘脚本子进程、镜头 run | `readings` |
| `timers` | 调度、`jobs.yaml` 同步、`check`、上游错误重试、Sentinel | `timers`、`kv` |
| `push` | 路由表、在场、补推、已读、夜间、先等、暂缓、FCM | `push_queue`、`reads` |
| `proxy` | LLM 代理 | `run_tokens`、`usage`、`requests` |
| `egress` | `sbot-w` 的出网代理 | — |
| `api` | 帧里的 `/api/v1`、`/node/v1`，事件 pump，视图函数，角色过滤，`client_ops` | `change_log`、`client_ops`、`threads` |
| `link` | 连中继、Noise、本机 socket、认证、配对、删设备 | `devices`、`device_invites`、`device_audit` |
| `tasks` | 任务引擎：节点、attempt、等待点、交接、worktree、CI、额度、空闲释放 | `tasks`、`task_sessions`、`worktrees`、`task_prs` |
| `nodes` | 节点状态、版本和能力、升级编排 | `nodes` |
| `improve` | 信号、评测集、回放、提案、回滚、回看 | `signals`、`eval_cases`、`proposals` |
| `backup` | 加密快照、CAS 同步到节点、保留期 | — |
| `cli` | `sbot` 命令 | — |

模块之间直接 import 函数，不搞事件总线；跨模块的状态变化只经数据库加 `emit`。

## inbox 和 run（§底1.2）

- 渠道和 API 的 handler 只做「写 `inbox`、提交、确认」。飞书长连接的回调 3 秒内必须回，所以写库之外什么都不做。
- 派发：同一条 lane 同时一个 run，lane 之间不设上限（D2）。开 run 时把这条 lane 上 `received` 的全部取出合成一轮（单次最多 50 条，多的下一轮 ※；为了一轮输入不爆上下文，不是限流）。
- 插话：run 进行中来了我的消息（`ownerTyped`），pi 能插就 `steer` 进去，这条标 `processing` 并挂到当前 run；插不进的排队。别的事件一律排队。
- 停：`/stop`、客户端「停」→ pi `abort`；还没被读到的插话作废（标 `dropped`）。
- 撤回：没处理的标 `dropped`；在处理的按停处理；是审批卡触发消息的，卡作废（§触2.4）。
- 重启恢复：`processing` 且 `runs.side_effects = 0` 的回 `received`；有副作用的标 `interrupted`，在那条 lane 里说一句「我刚才被重启了。上一轮做到一半，已经发出 N 条消息，不会重发。要我接着做，再说一声。」（N = 这个 run 进了 outbox、没失败没过期的文字行；这句本身不挂 run，不算谁的副作用）。`running` 的 run 标 `interrupted`，活着的令牌全部作废。副作用由工具层在执行有写效果的工具前 +1（进发件箱、提交审批、开任务、写记忆）。
- **熔断**（Y8）：错误指纹 = `sha256(角色 | lane 类别 | 错误类名 | 规范化的错误信息（去掉数字和 id）)`。同一指纹连续 N 次（`self.yaml` `measure.breaker`，默认 3）就停下这个循环、发看一眼卡。同一条输入让进程连崩两次（W1d：`inbox.tries`，开 run 和插话时 +1，启动时还在 `processing` 且 `tries ≥ 2` 的 ※）就标 `failed`，告诉我。熔断后这条 lane 上不是我亲手发的输入直接标 `failed` ※，我发一条、跑通一次就解开。模型 5xx 归上游重试，不算；PR 的 CI 不归它管。
- 来源标签（R1）：一批输入全是我亲手发的（`ownerTyped`：来自 `client` 设备，或渠道里 owner 的 ID 在主对话 lane 发的）标 `owner@<surface>`；定时 `job@<名字>`；审批、任务、系统转来的 `system@<类型>`。这个值进 `TurnContext.src`、journal 每行、`run_items`。dream 认「我说的」只看这个前缀，加上我所有主对话 lane 的行（不再按渠道串写正则）。
- 回复跟着输入走：`TurnContext { lane, surface, chat, thread, msg_id, src, device_id? }`，`reply` 投回输入来源。

## runner

- 一个接口，hub 里只有 pi 一个实现（节点适配器在节点程序里实现同一组能力，05）：
  ```ts
  interface Runner {
    run(o: { lane: string; role: Role; tier: Tier; session_ref?: string; system: string; input: string; tools: ToolDef[];
             ctx: ToolCtx; token: string; onItem: (e: ItemEvent) => void; signal: AbortSignal }):
      Promise<{ output: string; fullText: string; session_ref: string; stop: StopReason; error?: string; usage: Usage;
                tools: string[]; undelivered: number[] }>;   // undelivered = 插进去但模型没读到的 inbox id
    steer(lane: string, text: string, inbox_id: number): Promise<boolean>;   // false = 插不进，调用方排队 ※（pi 的 steer 是异步的）
  }
  ```
- pi 嵌入照 §办1.1：`DefaultResourceLoader` 全关自动发现、私有 `agentDir`（`$SBOT_HOME/pi/`）、`noTools: "builtin"` + `customTools`。`models.json` 不写 key：每个 run 自己一个 `ModelRuntime`，令牌放进内存里的 credential store（`setRuntimeApiKey("sbot", token)`）※——lane 并发跑，一个进程共用的 `$SBOT_RUN_TOKEN` 环境变量会串。工具 schema 给 pi 时用 zod 的输入形状（`io: "input"`）：pi 在执行前按它校验参数，输出形状里带默认值的字段算必填，靠默认值的调用会被 pi 挡掉、到不了 `callTool`。每条 lane 一个常驻 session，空闲 4 小时滚动（§触2.3），客户端 thread 不滚。
- `onItem` 转发 pi 的 `message_update`、`tool_execution_start/end`，先打码再写 `run_items`、推 delta（§触6.4）；回调出错只记日志，不影响 run。
- **提示词**（R7）：`promptFiles()` 加载 `AGENTS.md`、`SOUL.md`、`USER.md`、`MEMORY.md`，以及只在我亲手发的那一轮加载的 `VOICE.md`、`self/practice.md`（截短）和本月、本周前瞻要点（§附2.15、§附2.16）。拼装顺序在 `systemPrompt()` 一处定。超了各自上限截断并在提示里说「超了」，不静默。召回片段和「记忆改了」放 user 消息，不进 system。
- **压缩**：`session_before_compact` 自己写摘要，保留发心、本月留意、未完的等你；摘要写 journal。W1d 先用 pi 自带的压缩 ※，自己的摘要随 memory（W1e）。
- **换模型**（§办2.4）：发之前剥掉历史里旧模型的 thinking 块。最后一条 assistant 有 `tool_use` 还没结果时：等这轮工具结果回来再换（P10 定了，IC-11；立刻换并补「已取消」会让调用重跑、真结果丢掉）。跨家换时把历史里的调用 id 改成目标家的形状，W1 验（08 P10）。

## tools

- 注册表一处声明，三列可见性（§底3.1 是唯一出处）：
  ```ts
  type ToolDef = { name: string; description: string; schema: z.ZodObject; level: "L0" | "L1" | "L2";
    cols: { typed: boolean; system: boolean | "self-items"; others: boolean | "scoped" };  // §底3.1 三列
    readOnly: boolean;                // 给 §底4.3 的「只用过只读工具才重跑」，不再有第二份名字表
    exec(args, ctx: ToolCtx): Promise<string> };
  ```
- 本轮工具 = 列 ∩ 域规则。列由 `ctx.src` 判：`owner@` → typed，`job@`/`system@` → system，他人会话 → others。`node` 设备的任务经 MCP 调时按 system 列。
- **调用顺序**（`callTool`）：列检查 → zod 校验 → 守卫 → 闸门（L0、L1 执行；L2 写 `approvals` 立即返回「已提交审批 #N」）→ 执行 → 结果打码 → `run_items`。异常转成 `error: …` 字符串给模型，不抛给 runner。
- **`self/` 守卫**（R1）：一个函数 `selfGuard(path, ctx)` 在所有读路径的工具（`memory_read`、`memory_search`、`timeline_query`、`readings_query`、`self_*`、`bash`/读写文件）里调，不分渠道。规则照 §读5.1 和三列表：typed 可整份；system 只给条目级（`self_list`），`habits.md`、`rhythms.md`、`charts/`、`practice.md`、`timeline.md`、出生信息整份不给；others 读不到 `self/`、身体、时间线。`self_mark`、`reading_revisit` 改看 `ctx.src` 前缀，不看来源字符串里有没有 `owner`。
- **`bash` 和读写文件**：只在 typed 列，经本机节点 `/node/v1/exec`、`fs/*`（05）以节点账号跑。命令守卫（软边界，§底3.8）：拒绝命令或路径里出现 `$SBOT_HOME`（`db/`、`config/`、`keys/`、`secrets.env`、`agent-home/` 原文件）、`/proc/*/environ`、`/run/sbot`、渠道 CLI 的凭证目录；只看去哪，不看写进去的内容（同旧 `coreGuard`）。被拒的写进 `run_items`，告诉模型为什么。
- **打码**：一个 `redact(text)`：已知密钥的值（从 `secrets.env` 和 `keys/` 读进内存的那份）+ 常见密钥格式（`sk-`、`ghp_`、`xox`、PEM 头、`AKIA`、JWT 三段）。流式按 50～100 ms 一批、在行或空白边界整段替换（§触6.4）。日志、`run_items`、事件流、审批卡都过它。
- `bash` 之外，新加只读工具标 `readOnly: true`；注册表测试检查「L0 且 `readOnly: false`」的都要有注释写为什么。

## approvals（§底3.2、§底3.3、§办3.3）

- kind：`send` | `plan` | `glance` | `ask` | `proposal` | `rollback`。状态机照 §底3.3。
- **只认我答**：决定来自 `client` 设备，或渠道回调里操作人是 owner 的 ID。`node` 角色、主 agent、别的 agent 都不能决定。同一台设备发起的自己能批（D6）。
- 决定在一个事务里：查状态和 `draft_version` → 改状态 → 写 `decided_by`（`device:<id>` / `feishu`）→ 后续（`send` 进发件箱原样发批准时的版本；`plan` 往原 lane 投 `approval` 事件；`glance`/`ask` 经 `tasks` 把答案发回同一个 session）。
- **卡片模型和渠道无关**：`Card { title, lines[], question, options[{id, label, recommended?, cost?}], detail?: { kind: "cmd"|"path"|"args"|"diff", text, folded } }`。客户端直接画；飞书插件渲染成卡片 JSON，命令、路径、参数完整显示，长的折叠（§办3.3）。每路渲染结果记 `approvals.cards_json`，决定后每一路都改卡（飞书用回调 token 延迟更新，§底3.3）。
- 过期：`approval_ttl_hours`（旧键，沿用；§底3.3 有 `expired`）。看一眼卡不过期（§办3.3：等的时候不设超时），只在节点或 agent 进程重启时作废。
- 作废：observer 看到我在原处晚于 `trigger_msg_id` 回过话；触发消息被撤回；同一触发有了新草稿（`superseded`）。

## outbox 和出口组（R3）

- 写死飞书的 6 处加 3 处只发 `admin_chat` 的（10 的 R3 节有行号），在新主里都变成两组出口：
  - `main`：主对话出口，「发给我」的东西去这里（早报、复盘开场、提醒、任务完成一句）。
  - `admin`：管理通知出口（审批卡、告警、上线通知、记忆 diff、改进卡）。
- 配置：新文件 `channels.yaml` ※（取代 `feishu.yaml`）：
  ```yaml
  outlets:
    main:  [client, feishu:dm]
    admin: [client, feishu:chat:admin]
  feishu: { admin_chat: <chat_id>, workbench_chat: <chat_id> }   # 实例数据，只在服务器
  ```
  `client` 指客户端的「等你 N」和时间线；推到哪还要过 `push` 的路由表。
- 投递：`outbox` 行带 `channel`、`target_json`、`idem_key`；出口按渠道插件的 `send()`；`approval_id` 唯一，一个审批最多发一次；`send_by` 到了作废；结果不确定标 `unknown`，不重发（§底3.3）。
- W1d：插件按 id 登记在 `outbox.ts`（`registerChannel`），W1e 的 ChannelPlugin 照这个接口接 ※。`client` 出口内建：投递就是写一行 `messages`。出口组里没在跑插件的出口跳过（记日志）；行写进去了但找不到插件的标 `unrouted` ※，不丢、不重试。同一个 `idem_key` 只写一行；失败按 10、20、40 秒退避，最多 4 次；重启时 `sending` 的回 `queued`，带原 `idem_key` 再发，由插件认重复。写一行就踢一下投递，不等 5 秒的轮询。

## channels（ChannelPlugin，veto 4）

```ts
interface ChannelPlugin {
  id: string;                                   // "feishu"、以后 "wechat"
  caps: { cards: boolean; streaming: boolean; userIdentityRead: boolean; mail: boolean; commands: boolean };
  start(h: ChannelHost): Promise<void>;          // 收：每条消息、卡片回调、撤回 → h.ingest(...)（只写 inbox）
  send(o: OutboxRow): Promise<SendResult>;       // 发：bot 身份；以我名义的只在 approval 批准后
  render(card: Card): unknown;                   // 渠道卡片
  stream?(lane: string): StreamHandle;           // 流式卡片
  stop(): Promise<void>;
}
```

- 插件跑在主上（飞书：用主自己的登录），或跑在节点上（以后微信在 Windows 节点）：节点上的插件经 `/node/v1/channel/*`（02）和主往返：收到的走 `ingest` 上来，主要发的走 `send` 下去；主侧是一个代理插件 ※。主只看 `caps`。
- 飞书插件：长连接收事件，3 秒内确认；卡片回调校验 `operator_id` 是 owner；消息按 `message_id`、卡片回调按 `event_id` 去重（04）；user 身份轮询群（§读2.2）；CardKit 流式卡片；飞书邮箱（只读，回邮件走审批 D8）；确定性命令 `/stop /new /tasks /approvals /todo /pair /devices /model /usage /job /improve /group`（不经模型，§触6.6）。
- 飞书后端（P9 暂定 ※，待测试应用实测确认，08）：bot 身份用官方 Node SDK 的低层 `WSClient` + `EventDispatcher`（不用 `LarkChannel`），CardKit 在进程内调。必须做到：订阅的每种类型都注册处理函数（没注册的照样确认后丢）；传自己的 `logger`（SDK 默认日志会带出 `app_secret` 和令牌）；设 `pingTimeout`、`handshakeTimeoutMs`，接 `onError`；重连后补漏消息（点击补不回来）；更新点过的卡先关流式。user 身份轮询、查已读和邮箱 ※ 先照旧走主机器上装的 lark-cli，W1e 开工前定。

## sources（SourcePlugin）

- 内置：git（读 `git ls-remote` + 浅 fetch，不再要 bare 镜像 ※）、fetch、飞书邮箱（必须用主自己的登录，所以内置）。
- `command` 插件和排盘脚本：子进程，Linux 上以 `sbot-w` 跑（经 `deploy/worker/worker-exec` 的插件模式），读不到 `secrets.env`；每个插件开自己的出网（`egress` 按插件放行域名）。Mac、Windows 当主时以同一个用户跑（我定，§底3.8）。
- 契约：stdin 一行 JSON `{ v: 1, since, cursor, env }`；stdout 每行一条 `{ kind: "item", id, ts, where, author?, text, link?, raw_b64? }` 或最后一行 `{ kind: "done", cursor }`；stderr 进日志；退出码非 0 = 这次失败，游标不前进。不设时长和输出上限。
- **排除名单**（Y5）：`sources.yaml` 加 `exclude: { chats: [], persons: [], mails: [] }`；在 `sources` 和飞书插件 `ingest` 处代码卡住，进不了 `messages`。改它是收窄，不走 `widening()`；删条目是放宽，走。
- 进来的东西和群消息走同一条路：`messages` → 分拣 → 事件 → 挂到事。

## memory

- **写队列**：`memory.write(repo: "agent-home" | "config", fn: (wt) => Promise<void>, msg) → Promise<sha>`；每个仓库一条串行队列，`fn` 里改文件，队列里 `git add/commit`。读不排队。所有旧的 `commitIfDirty`、`editConfig` 调用点改走它。每种实体只认一个写源，启动时对一次账（§底1.3）。
- journal 每行 `- [HH:MM][run=<id>][src=<标签>] …`，来源由工具层填。
- `memory_search` / `wiki_search`：每处截断都在第一行报完整度（「共 N 页命中，显示 X 页，每页前 4 行；还有 M 页」），给 `offset` 翻页；`memory_read` 截断时报「读到 12000 / 共 N 字」（R7）。
- `forget`、`memory_patch` 逐条改、比对出处数、dream 的删改比例和净增上限，照 §读1.3、§附2.16。
- 原始资料：`raw/sha256/<前两位>/<sha>` 本地内容寻址，只增不改。
- seed 同步照 §底1.5；seed 在 `hub/seed/`。改 seed 里的 `jobs.yaml` 到不了已有实例：新增默认 job 走启动时追加（照旧 `addDefaultLensJobs()`），kv 记只做一次，管理通知一句（Y11）。

## timers 和 Sentinel（§底4）

- 30 秒一次：到期的投 `timer` 事件（去重 `timer_id:due_at`），定时器自己不起 run。停机错过的记 `missed`，上一次还在跑记 `skipped`。
- 主是唯一的调度器：任务的续跑、CI 查询、空闲释放、worktree 扫描都是 `timers` 的 `kind=task` 行，到点给节点发单次指令（04 tasks 节）。
- **`check` 契约**（新，旧代码没有）：job 写 `check: <命令>`，到点在本机节点 `/node/v1/exec` 跑。
  - 退出 0 且 stdout 为空 → 没事，记 `skipped_by_check`，不叫模型。
  - 退出 0 且有输出 → 有事，stdout 带进这次 run。
  - 其他退出码 → 脚本坏了：照常跑 run，把 stderr 前 2 KB 和退出码带进去，并记一条运维告警 ※（宁可多跑一次，不让坏脚本把任务静默吞掉）。
  - 不设时长和输出上限。
  - check 命令和 `bash` 过同一个命令守卫 ※（命令是我写在 `jobs.yaml` 里的，但它在 bash 那儿跑）；被拒算「脚本坏了」。W1d 给出 `runCheck()`，到点调用是 timers（W1e）的事。
- 上游错误重试照 §底4.3，照搬旧 `retry.ts` 的分类和退避表。
- Sentinel 每 5 分钟，纯代码，告警经 `push`（`alert_security` / `alert_ops`）。

## push（§触1.1 路由表）

- 入口一个函数：`push.enqueue({ cat, ref, lane, domain, text, expires_at? })`。急不急、占不占额度由代码按 `cat` 查表定，模型说了不算。
- **在场**只在内存：每台 `client` 设备最近一次 `POST /api/v1/presence { foreground, viewing }` 的时间和内容；任何一台在前台且 3 分钟内（`push.presence.away_seconds`）有操作就算在场；`viewing` 指着这一条就不推。
- 状态机在 `push_queue.state`（04）：`wait` → 到时机 → 在场：`counted`（只计数）；不在场：发 → `sent`；夜里 → `night`（并进早报）。`counted` 的在我走开时（在场变不在场的那一刻）再推。我在任何一端看过、处理过 → `done`，并写 `reads`。
- 时机：对话中先等（我最后一条后安静 `quiet_minutes`、且没有 run 在回我），最多推迟 `max_delay_minutes`，从入队算；夜间 22:30–08:00 只记不发，`night_allow` 的照发；夜里我发过消息之后 `awake_minutes` 按白天。
- 发几路：紧急类（`ask`、`approval`、`owner_followup`、`alert_security`、夜里就到期的）FCM 和渠道同发，不要回执（D1）；其余 FCM 收下了就不推渠道，没令牌或令牌失效推渠道（D15）。`personal` 的 FCM 只说「有一条私人的」，渠道只发「客户端有新消息」。
- **FCM**（veto 8）：HTTP v1，自己签 JWT（服务账号私钥在 `secrets.env`，RS256，`node:crypto`），换 access token 缓存 50 分钟；不用 firebase-admin。`UNREGISTERED`/`INVALID_ARGUMENT` 视为令牌失效：清 `devices.push_token`，这条改推渠道。开关是 `console.yaml` 的 `fcm.enabled`（06），默认关，打开走 `widening()`（Y11）。
- 已读按人算：`reads` 一行一个 ref，任何设备看过或飞书点开过都算；每台设备只各自记滚动位置（不上主）。
- 额度：§寸2 的每日主动消息上限（`gate.yaml` `proactive_daily_cap`，我定过的，沿用）按 `push_queue` 里 `quota = 1` 且今天发出的行数算。

## proxy（§办2.2，R7）

- 只给主进程里的 run（pi）用；远端节点不走代理、不拿令牌（D3）。
- 端口：`SBOT_PROXY_PORT`，没有就 `SBOT_PORT`，再没有 7811 ※（测试 home 用 `SBOT_PORT` 的 7829–7831）。
- 令牌：每个 run 一个，绑 `{ run_id, tier, requester, device_id? }`，库里只存 sha256，run 结束作废；不再有 30 分钟 TTL ※（run 不设时长，令牌跟着 run 走；只有主进程里的 run 拿得到，节点链路没有令牌，旧的「长跑 agent 中途 401」不会发生）。
- 状态码：令牌无效、过期 → 401；越档 → 403 `permission_error`；预算从不拒绝。
- **预算只告警**（限5）。键：
  | 键 | 新含义 | 旧键 |
  |---|---|---|
  | `models.yaml` `budgets.daily_cost` | 全天告警线 | 原来是硬上限，键名不变，只告警 |
  | `models.yaml` `budgets.run_output_tokens` | 单 run 告警线 | 同上 |
  | `models.yaml` `tiers.expert.daily_alert` | expert 当天告警线，超了照常把关 | `gate.yaml` `expert_daily_limit` 照认，读成它 |
  | `gate.yaml` `improve_alert_usd` | 回放告警线，回放照跑完 | `improve_budget_usd` 照认 |
  | `gate.yaml` `daily_budget_usd` | 并进 `budgets.daily_cost`（两个都写取小的告警） | 照认 |
  `run_tokens.status` 去掉 `budget_exhausted`；旧代码里依赖它的分支（10 的 R7 节列了行号）在新主里没有对应物。
- 记账：`usage` 每行带 `source`（`proxy` | `node`）和 `device_id`；节点 agent 自报的 token 和耗时记 `source = node`（§进2.2）。
- 备用模型、按能力降级、上游系统提示计入，照 §办2.3、§办2.4。
- 换模型：每次请求按 `sbot-<档>` 现读 `models.yaml`，lane 上一次用的模型记在 `sessions.model`；不一样就剥掉 assistant 的 thinking 块。工具调用 id 一律改成目标家的形状（Claude `toolu_`，GPT `call_`），`tool_use` 和 `tool_result` 同一张映射，成对不散。

## egress（§底3.6）

- 照旧 `egress.ts` 搬：`127.0.0.1` 上一个插件一个端口，只放 `CONNECT` 到白名单域名的 443，解析到非公网地址的拒绝。端口 7820–7828 ※（旧的到 7829，7829 现在是冒烟测试主的端口；`SBOT_W` 链照旧放到 7829，不用改）。W1d 只有模块和测试，插件起来时（W1e）才开。

## api

- 一处分发：先按连接角色判（`node` 只能 `/node/v1`，`client` 只能 `/api/v1`），再进路由。没有按路由的权限表（设备和我同权，§触6.7）。
- 写请求：`client_op_id` 去重和业务写入同一事务（02）。
- **pump**：每 100 ms 读 `change_log` 里 `seq > 上次`，同批同实体合并，发送时用和 GET 同一个视图函数取最新内容，按连接过滤（`node` 不收客户端流；`personal` 只发 `client`）。心跳带最新 `seq`。慢连接：持久事件停读、之后补；delta 直接丢、缓过来发 snapshot（§触6.4）。
- 视图函数是 bootstrap、GET、事件三处共用的唯一取数处。

## link

- 本机 socket（`$SBOT_HOME/run/`，目录 0700）：
  - `hub.sock`：本机节点（文件属组给节点账号，0660）。连上就是 `role: node`，设备 id 固定 `local`，不配对 ※（同机、靠文件权限，veto 3）。
  - `hub-admin.sock`：`sbot` CLI，0600、只有主的账号能连；连上等同一台 `client` 设备 `cli`，审计里记 `cli`。
- 中继：`relay.enabled` 时主连 `wss://…/v1/hub`，按 06 注册，断了按 1、2、5、10、30 秒退避重连。
- 删设备：06。

## tasks 和 nodes（§办3）

- `task_start({ goal, context, node?, agent?, tier?, repo? })`：选节点（不填用 `default_node`，没配用主所在那台）→ 派到主以外的节点 `push` 一条通知（限1，不等）→ `tasks` 写 `attempt = 1` → `/node/v1/sessions`。
- 回传：`/node/v1/tasks/:id/events`，`attempt` 小于当前的整批丢；`run_items` 记步骤；`last_output_at` 更新（不发事件）。
- 等待点：`/node/v1/permissions` → `approvals`（`glance`/`ask`）→ 推 → 我答 → 回同一个 session。等的时候我发消息给这个任务：先拒掉那条请求，再插话（§办3.4）；主 agent 和别的 agent 发给它的排到我答完。
- 交接：换机器、换 agent、续接不上时，代码按预算拼「第一条要求 + 最近几轮 + 命令结果 + `progress.md`」，省掉的写明（`task_sessions.handoff_ref` 存全文），不让模型总结（§办3.4）。
- 「需要你处理」现算：`interrupted`，或 `running` 且 `last_output_at` 早于 20 分钟（`measure.stuck_minutes`，可改）。
- 额度用完：节点报恢复时间 → `quota_until` → `timers` 到点发续跑。
- worktree、CI、空闲释放：都是 `timers kind=task` 的单次指令；worktree 只在我点「清理」时删。
- 节点升级：`nodes` 记节点报的 `sha`；hello 时回 `target_sha`（= 主当前 sha）。节点排空（超时默认 30 分钟 ※，超时按重启处理，等待点上的卡作废）后自己切换（05）。版本低于 `PROTOCOL.min` 的节点只收升级指令，不派活。

## improve（§进2、§附2.18）

- 提案 `status` 默认 `'proposed'`（沿用代码；§底5 的 `'pending'` 是草稿笔误）。
- 节奏：去掉 `min_days`，留 `max_days` 和 `min_signals`；有待批的提案卡也照跑。新提案和待批的同 `target` 且内容一样就丢，不一样另开一张卡（§附2.18）。旧代码「有待批卡就整体不跑」删。
- 被拒：同一条一直挡（不再 8 周冷却）；有新案例当证据可再提一次，卡上写上次的理由；再被拒不再提（§附2.18）。
- 卡发到哪：目标是 `skills/review/`、`skills/outlook/`、互参提示词的发主对话出口，其余发管理通知出口。
- C 级：批了 → `task_start` 派到默认节点 → PR 链接回卡片话题 → 按主的提交号两周回看。
- 对不上：体检标出的进 `proposals.status = 'held'`，周、月复盘带上（§进3.1）。

## backup（§底1.3 R4）

- 每晚：`VACUUM INTO` 快照 + `config`、`agent-home` 的 git bundle + `keys/`、`secrets.env` → tar → `age` 用我的公钥加密（`backup.yaml` 的 `recipient`，实例配置）→ 存本机 `backup-staging/` → 经 `/node/v1/backup/put` 推给配置的节点（默认 Mac）。
- 原始资料、体检原件、导入原件：加密后进 `backup-staging/cas/<sha>`，节点按 sha 增量拉，只增不删。
- **保留期**（设计留给技术设计）※：每日 14 份、每周 8 份、每月 12 份。「彻底删」后私聊里告诉我的「哪天全部过期」= 最老那份月度备份滚掉的日子（约一年）。
- 主私钥不能解备份（公钥加密），恢复在我手上做：`sbot restore <文件>` 读我给的私钥文件。
- W1c 落地的细节 ※：
  - 由主的定时任务 `backup`（`jobs.yaml`，每天 03:30，默认任务和镜头任务一样只补一次，之后归我管）跑，不再要 systemd 单元，三个系统一样。
  - `backup.yaml` 没填 `recipient` = 不备份，当晚发一条管理通知；不拦启动。`recipient` 认 `age1…` 公钥（含后量子混合的长公钥）。
  - 一份一个文件 `backup-staging/sbot-<日期>.tar.age`（0600）+ 旁边的 `.sha256`（只是密文的 hash，防传坏）。tar 里：`manifest.json`（每部分的字节数、sha256、`db_version`）、`sbot.db`（快照过 `integrity_check` 才打包）、`config.bundle`、`agent-home.bundle`（空仓库不打）、`keys/…`、`secrets.env`。manifest 在加密的 tar 里面，不在外面。
  - tar 是自写的 ustar（只放普通文件），手工 `age -d … | tar x` 照样能解。
  - 保留期在每次备份后修剪，只动 `sbot-<日期>.tar.age` 和它的 `.sha256`。
  - 推节点（`/node/v1/backup/put`）W2 才有：`backup.ts` 的 `pushToNodes` 是标出来的接缝，现在只记日志、报「等着」。`cas/` 同步也跟着 W2。
  - `restore` 先在临时目录里解密、逐个对 sha256、库过 `integrity_check`、bundle 过 `git bundle list-heads`，都过了才动 home。home 里有东西就拒绝，加 `--force` 才换，原来的 `db/`、`config/`、`agent-home/`、`keys/`、`secrets.env` 挪进 `.pre-restore-<时间>/`，不删。私钥文件的内容不进报错和日志。

## cli（`hub/src/cli.ts`，命令名 `sbot`）

`sbot pair [--node]`、`sbot devices [rm <id>]`、`sbot status`（版本、主公钥指纹、中继、节点、缺哪些 Linux 可选件）、`sbot chat`（终端里接主对话 lane，等同一台 client）、`sbot upgrade --ref <sha>`、`sbot restore <文件> --identity <私钥文件> [--force]`、`sbot import ...`（09 的重建）。都经 `hub-admin.sock`，除了 `restore` ※：它要换掉主正在用的库，所以在主停着时本地跑，socket 上有主应答就拒绝。

- `hub-admin.sock` 帧：u32 大端长度 + 一个应用帧（JSON），上限和 Noise 重组后一样 1 MiB；不加密，靠 run 目录 0700、socket 0600、属主是主的账号。Windows 用命名管道 `\\.\pipe\sbot-hub-admin`。
- `status` 走 `GET /api/v1/status`（`protocol/api/status.ts`）：版本、提交号、协议版本、主公钥指纹（W2 前是 `null`）、启动时间、库版本；中继、节点、可选件跟着各自的波次加字段。
- 退出码：0 成功、1 失败、2 参数不对、3 还没做（报是哪一波：`pair`、`devices` W2，`chat` W3，`upgrade` W4，`import` W6）。

## 配置键变化（Y11）

改配置键 = 同一个 PR 里改 zod schema、表单描述、`widening()` 三处，`config-form` 的漂移测试照搬。

| 文件 | 变化 |
|---|---|
| `gate.yaml` | 加 `push`（§触1.1 那段）；`improve_budget_usd` → `improve_alert_usd`；`expert_daily_limit` 照认、读成 `models.yaml` `tiers.expert.daily_alert`；`proactive_daily_cap`、`approval_ttl_hours`、`send_by_hours`、`sensitive_words`、`attention` 沿用 |
| `models.yaml` | `budgets.*` 改只告警；tier 加 `daily_alert` |
| `jobs.yaml` | 加 `check`；`improve` 去掉 `min_days`（旧键忽略，表单删）；dream 行加 `max_delete`、`max_add`、`archive_days` |
| `self.yaml` | 加 `measure`（§寸8：`breaker`、`stuck_minutes`、`infer_min_convs`、`dismiss_window`、早报等整理卡的 30 分钟……）；旧顶层键照认 |
| `sources.yaml` | 加 `exclude` |
| `console.yaml` | 只剩 `relay`、`mcp_open`、`fcm`（06）；`owners`、`web` 删 |
| `channels.yaml` | 新，取代 `feishu.yaml` ※ |
| `worker.yaml` | 主上删 ※：`ssh_hosts`、`skills`、`PATH` 是节点自己的事，放节点机器上的 `node.yaml`（05） |
| `backup.yaml` | 新：`recipient`、`to_nodes` |
| `auto.yaml` | M5 做的时候加（§底3.5） |

放宽项进 `widening()`：`relay.enabled`、`mcp_open`、`fcm.enabled` 由关到开；`push` 里缩短等待、缩短夜间、`night_allow` 多一类、建议条数调高；`exclude` 删条目；dream 的三个数调松；tier 的 `daily_alert` 调高。
※ 另外几条也算放宽（W1c 加）：`channels.yaml` 换管理群或工作台群、飞书 `shadow` → `live`、出口组多一个出口；`backup.yaml` 换 `recipient`（拿着它私钥的人能读 `secrets.env` 和 `keys/`）、`to_nodes` 多一个节点；`people.yaml` 里 owner 的 ID 新填或换掉（认谁是我）。

## 照旧不在新主里的

上限：`MAX_CONCURRENT`、`MAX_WORKERS`、`DEFAULT_BUDGET`、`LANE_OPEN_MAX`、`GLOBAL_OPEN_MAX`、`MAX_AUTO_RUNS`、`MAX_TURNS`、超时和看门狗、`RuntimeMaxSec`、预算 403、他人自动回复的数字上限（§办3.4、§办3.5）。机制：SDK worker、`defer`、挂起式审批、bare 镜像、旧控制台、`/api/*`、tailscale serve、公网密码入口。详表在 10。
