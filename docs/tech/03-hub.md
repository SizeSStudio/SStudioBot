# 03 主（`hub/`）

单进程。设计在 §底1–§底4、§办1–§办3、§触1.1；表在 04；旧代码怎么搬在 10。这里定模块边界、接口和代码规则。

## 启动顺序

`config`（zod 校验，坏了拒绝启动并说哪一行）→ `db`（开库、`user_version`）→ `memory.ensureAgentHome` + seed 同步 → 密钥读进内存、打码接上（`setRedactor`）→ `proxy` → `inbox.recover` → `link`（本机 socket；`relay.enabled` 时连中继）→ `channels` 各插件 start → `outbox`、`push`、`inbox` 派发、`timers`、`sentinel`、`api.pump` 起 → 打印 `hub up` → 上线通知（经管理通知出口）。W1d 起 proxy、recover、`hub.sock`、outbox、派发和审批过期扫描（每分钟）；W1e 在 outbox 开始投递之前起渠道、timers、Sentinel、sources、分拣（`main.ts` `startChannelSide`），都叫醒同一个派发（`kickInbox`）；关的时候倒过来。W2b 在派发之后起 `api.pump`；W3b 在它之后起 `push`。

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

从旧核心搬来的账本类模块（ledgers、memory 读、timers、sources、triage）用 `db/ambient.ts` 的 `one/all/run/tx/kvGet/kvSet` ※：`boot` 里 `setDb(db)` 一次，关停时清掉；省得每个函数加一个 `db` 参数、和旧代码逐行对不上。新写的、要单独测的模块照 W1c 传 `Db`；测试用 `helpers.ts` 的 `ambientHome()`。

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
- pi 嵌入照 §办1.1：`DefaultResourceLoader` 全关自动发现、私有 `agentDir`（`$SBOT_HOME/pi/`）、`noTools: "builtin"` + `customTools`，再加 `tools` 允许列表只放这一轮的工具名（同名的自定义工具顶掉 pi 自带的，`bash` 是我们的）；选项按 pi 的类型写，拼错 tsc 报。`models.json` 不写 key：每个 run 自己一个 `ModelRuntime`，令牌放进内存里的 credential store（`setRuntimeApiKey("sbot", token)`）※——lane 并发跑，一个进程共用的 `$SBOT_RUN_TOKEN` 环境变量会串。工具 schema 给 pi 时用 zod 的输入形状（`io: "input"`）：pi 在执行前按它校验参数，输出形状里带默认值的字段算必填，靠默认值的调用会被 pi 挡掉、到不了 `callTool`。每条 lane 一个常驻 session，空闲 4 小时滚动（§触2.3），客户端 thread 不滚。
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
- **`bash` 和读写文件**：只在 typed 列，经本机节点 `/node/v1/exec`、`fs/*`（05）以节点账号跑。命令守卫（软边界，§底3.8）：拒绝命令或路径里出现 `$SBOT_HOME`（`db/`、`config/`、`keys/`、`secrets.env`、`agent-home/` 原文件）、`/proc/*/environ`、`/run/sbot`、渠道 CLI 的凭证目录；只看去哪，不看写进去的内容（同旧 `coreGuard`）。被拒的写进 `run_items`，告诉模型为什么。路径先在主这边变成绝对路径再给守卫看，发给节点的也是这份：相对路径按给的 `cwd`，没给就按节点 hello 里报的默认目录（`SBOT_NODE_CWD`，否则节点账号的 home）；节点没连上就拒，不猜。`bash` 不给 `cwd` 也在这个默认目录跑。
- **打码**：一个 `redact(text)`：已知密钥的值（从 `secrets.env` 和 `keys/` 读进内存的那份）+ 常见密钥格式（`sk-`、`ghp_`、`xox`、PEM 头、`AKIA`、JWT 三段）。流式按 50～100 ms 一批，切在最后一个空白或非 ASCII 字符（中文）之后（不切在代理对中间；已知值里有非 ASCII 字符时只按空白切），后面那截留到下一批，没有切点的超过 `hold` 才放。私钥块（PEM BEGIN…END）不切开：没收完就压着，超过 `hold` 就整块换成打码发出，到 END 之前的都丢（§触6.4）。日志、`run_items`、事件流、审批卡都过它。审批的草稿在写进 `approvals.draft` 之前就打码，`outbox` 的文字行写入时再过一遍：卡上看到的和批了发出去的是同一份。
- **他人会话的回复**（§底3.4）：others 列里 agent 写的东西，最终回答和 `reply` 工具都一样，发出前先做承诺检测（`commit-check.ts`）：经自己的代理用这个 run 的 light 档令牌发一次请求，按 JSON 答三项。没命中就发；命中、答得不成形、调不通、超过 60 秒 ※，都转 `send` 审批（`checks_json` 记原因，卡上显示，`context_json.hold = true`），对方先收到 `gate.yaml` 的 `hold_text`；卡过期再发 `hold_timeout_text` ※，一次。两句都是固定文字，不由模型写。typed、system 列不检测。others 列的出错提示不发给对方，改发管理出口 ※。§底3.4 的条件 ①（这个 surface 允许自动）随 W1e 的渠道配置接 ※；在那之前 others 的回复都走检测。
- `bash` 之外，新加只读工具标 `readOnly: true`；注册表测试检查「L0 且 `readOnly: false`」的都要有注释写为什么。

## approvals（§底3.2、§底3.3、§办3.3）

- kind：`send` | `plan` | `glance` | `ask` | `proposal` | `rollback`。状态机照 §底3.3。
- **只认我答**：决定来自 `client` 设备，或渠道回调里操作人是 owner 的 ID。`cli` 是 `hub-admin.sock`，配对生成的设备 id 永远不会是 `cli`（W2 配对要保证）。`node` 角色、主 agent、别的 agent 都不能决定。同一台设备发起的自己能批（D6）。
- 决定在一个事务里：查状态和 `draft_version` → 改状态 → 写 `decided_by`（`device:<id>` / `feishu`）→ 后续（`send` 进发件箱原样发批准时的版本；`plan` 往原 lane 投 `approval` 事件；`glance`/`ask` 经 `tasks` 把答案发回同一个 session）。
- **卡片模型和渠道无关**：`Card { title, lines[], question, options[{id, label, recommended?, cost?}], detail?: { kind: "cmd"|"path"|"args"|"diff", text, folded } }`。客户端直接画；飞书插件渲染成卡片 JSON，命令、路径、参数完整显示，长的折叠（§办3.3）。每路渲染结果记 `approvals.cards_json`，决定后每一路都改卡（飞书用回调 token 延迟更新，§底3.3）。
- 过期：`approval_ttl_hours`（旧键，沿用；§底3.3 有 `expired`）。看一眼卡不过期（§办3.3：等的时候不设超时），只在节点或 agent 进程重启时作废。
- 作废：observer 看到我在原处晚于 `trigger_msg_id` 回过话；触发消息被撤回；同一触发有了新草稿（`superseded`）。
- W3a 落地（`approvals.ts`）：所有端的决定都走 `decide`，点了什么先经 `choose()` 换成批或拒（客户端的 `action`、飞书按钮的选项 id 同一张表）：`send`/`plan`/`proposal`/`rollback` 只认 approve、reject；`glance` 要 `option_id`，选项的 `kind` 以 `reject`/`deny` 开头算拒，没 `kind` 时 id 是 `reject`/`deny` 算拒，其余批；`ask` 可 `option_id` 或自由文字。拒绝原因分 `not_me` 403、`missing` 404、`bad` 400、`decided`/`stale` 409、`gone` 410（API 照它回，409/410 带卡现在的样子）。
  - 卡上带 `draft_version`，飞书按钮的 value 是 `{k:"appr", id, o, v}`；草稿改过以后点旧卡（`v` 对不上）不生效，卡按新版本重画。W3 之前发出的卡没有 `v`，照旧收 ※。
  - **自己改稿**（`editDraft`，`send`/`plan`）：打码后写进 `draft`、`draft_version + 1`、各路卡重画。批的时候 `final_text` 取这时的 `draft`，飞书发前 `approvedAsSent` 照旧逐项比：卡上看到的、批的、发出去的是同一份。
  - **让它改稿**（`requestRedraft`，客户端 `redraft` 和飞书卡片话题里我的回复同一个函数）：意见记进 `revise_notes`，卡上多一行「在改稿」，卡保持 `pending`（新稿不来我还能批这张）。卡来自一个 lane → 往那个 lane 投一条 `approval` 输入（原稿 + 意见），下一轮重新提交；卡来自 triage → 提交后让 triage 用同一条触发消息再起草一次。新稿进来时 `submitApproval` 把同 lane、同 kind、同触发消息、带 `revise_notes` 的旧卡标 `superseded` ※。
  - **暂缓**（`snoozeApproval`）：`tonight` 到 `gate.yaml push.snooze_tonight`（过了这个点就不给，400），`push_queue` 一行 `state=wait`、占额度；`morning`/`monday` 到早报的时间（`jobs.yaml` 里 `do: morning` 的 `at`，没有就 `push.night.to`），`state=night`、不占额度。晚于卡的 `send_by` 拒（400）。卡离开 `pending`（决定、过期、取代、作废）时它在 `push_queue` 的行跟着关：决定 → `done`，其余 → `void`。发不发、什么时候发是 W3b push 的事，这里只入队。

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
- 插件按 id 登记在 `channels/registry.ts`（`registerChannel`，只这一处），outbox 按 `row.channel` 找它调 `send()`；登记只要 `id`、`caps`、`send`，`start`/`stop` 有就调。`client` 出口内建：投递就是写一行 `messages`。出口组里没在跑插件的出口跳过（记日志）；行写进去了但找不到插件的标 `unrouted` ※，不丢、不重试。同一个 `idem_key` 只写一行；失败按 10、20、40 秒退避，最多 4 次；重启时 `sending` 的回 `queued`，带原 `idem_key` 再发，由插件认重复。写一行就踢一下投递，不等 5 秒的轮询。

## channels（ChannelPlugin，veto 4）

```ts
interface ChannelPlugin {
  id: string;                                   // "feishu"、以后 "wechat"
  caps: { cards: boolean; streaming: boolean; userIdentityRead: boolean; mail: boolean; commands: boolean };
  start(h: ChannelHost): Promise<void>;          // 收：每条消息、卡片回调、撤回 → h.ingest(...)（只写 inbox）
  send(o: OutboxRow): Promise<SendResult>;       // 发：bot 身份；以我名义的只在 approval 批准后
  render(card: Card): unknown;                   // 渠道卡片
  stream?(ctx: { runId; lane; turn: TurnContext }): StreamHandle;   // 流式卡片，插件自己先写 outbox 行（算副作用）
  stop(): Promise<void>;
}
interface ChannelHost {                         // channels/host.ts：messages 行 + inbox.ingest()，一个事务
  ingest(i: IngestItem): { fresh; inboxId? };   // 同步、一个事务：messages 行（有就写）+ inbox 行；UNIQUE(source, source_msg_id) 去重
  record(m: MessageRow): boolean;               // 只进分拣的（群、别人的私聊）：只写 messages，triage_status=pending
  kick(): void;                                 // 提交后叫醒派发
}
type SendResult =                              // outbox 照它处理：ok → sent；unknown → 不重发（§底3.3）；retry:false → 直接 failed；
  | { ok: true; msg_id?: string; shadow?: true }   //   其余按退避重试；send() 抛错算可重试。shadow = 没发，只记了日志
  | { ok: false; error: string; retry?: boolean; unknown?: boolean };
interface OutboxRow { id; approval_id; run_id; lane; channel; kind: "text" | "card"; card_id; as_identity: "bot" | "user";
  target: Record<string, unknown>; payload; idem_key; send_by; attempts }   // target 已解析；idem_key 总有
```

- 接口在 `hub/src/channels/types.ts`（`TurnContext` 就是 `turn.ts` 那个，带 `channel`）；注册表 `channels/registry.ts`（`registerChannel`、`unregisterChannel`、`channel(id)`、`startChannels(host)`）。
- 发往哪：`target` 三种形状都认——回复和审批存的 `{...turn}`（`chat`、`msg_id`、`thread`）、出口组的 `to`（`chat:admin`、`chat:workbench`、`chat:<oc_id>`、`dm`）、分拣的 `chat_id`/`message_id`/`in_thread`；`replace` = 改那张已发的卡（审批状态变了，`refreshCards`）。审批卡（`cardOf` 的 JSON）按钮带 `{k:"appr", id, o, v}`（`v` = `draft_version`，W3a）；发出后插件把 `{channel, chat, msg_id}` 记进 `approvals.cards_json`，状态一变按它逐张改，决定过的卡不再有按钮。
- 卡片点击（`kind=card`）不进 run：派发交给 `channels/card-rows.ts`——`appr` → `approvals.choose` + `decide`（operator 随点击带进 payload，`decide` 再对一遍 `people.yaml`；选项怎么算批或拒和客户端同一张表，见 approvals 的 W3a 落地；`glance`/`ask` 的选项记成 `answer`），`group`/`review` → `feishu/actions.ts`。observer 看到我自己在某个群发了话 → `invalidateForOwnerMessage`（那里待批的稿作废）。
- lane：我的私聊 `feishu:dm`（`/` 开头的是 `command`）；工作台 `feishu:wb:<root>`（W3a：话题里的 `/stop /new /cancel /tasks /approvals /todo /help` 是 `command`，其余是对话）；管理群里我发的 `feishu:console`，只当命令；卡片点击 `card`（`source=feishu:card`，按 `event_id` 去重，payload 只有 `value`，不存回调 token）。别人的消息只 `record`，不进 inbox。
- `channels.yaml` `feishu.mode: shadow`：不连长连接、不收卡片回调，`send()` 只记日志返回 `{ok:true, shadow:true}`，`stream()` 直接是 failed；user 身份的轮询照跑（测试 home 用，09）。没有 `FEISHU_APP_ID/SECRET` 时 bot 身份不起（`state()=no-bot`），默认关。
- 密钥读取 `secrets.ts`（启动时 `loadSecrets` 读一次进内存）：`secret(name)` 只给插件和代理拿去连接，`secretValues()` 只给打码用；不进 env、日志、事件。

- 插件跑在主上（飞书：用主自己的登录），或跑在节点上（以后微信在 Windows 节点）：节点上的插件经 `/node/v1/channel/*`（02）和主往返：收到的走 `ingest` 上来，主要发的走 `send` 下去；主侧是一个代理插件 ※。主只看 `caps`。
- 飞书插件：长连接收事件，3 秒内确认；卡片回调校验 `operator_id` 是 owner；消息按 `message_id`、卡片回调按 `event_id` 去重（04）；user 身份轮询群（§读2.2）；CardKit 流式卡片；飞书邮箱（只读，回邮件走审批 D8）；确定性命令 `/stop /new /cancel /tasks /approvals /todo /help /pair /devices /model /usage /job /improve /group`（不经模型，§触6.6）。
- W3a 补齐的命令（§触6.9 并行 F，`channels/commands.ts`）：`/approvals` 列等批的、`/approvals <编号>` 把卡再发到这里（发出后记进 `cards_json`，别处决定也会改这张）；`/todo` 列等我回的、要我拍板的、要跟进的；`/tasks` 列没结束的任务；`/help`；`/cancel` 停这一轮并撤掉我排在后面的输入（别人的照旧轮到）。私聊、管理群、工作台话题都能用；管理群和工作台是共享的地方，私人的卡和消息只说「私人的一条」，不出标题和正文（§读5.1）。在审批卡的话题里回复 = 让它改稿（`cardReplies`，只认 payload 里我的 operator，`requestRedraft` 再对一遍）。
- 飞书后端（P9 ※，11-28 用线上应用真测确认，08）：bot 身份用官方 Node SDK 的低层 `WSClient` + `EventDispatcher`（不用 `LarkChannel`），CardKit 在进程内调。必须做到：订阅的每种类型都注册处理函数（没注册的照样确认后丢）；传自己的 `logger`（SDK 默认日志会带出 `app_secret` 和令牌）；设 `pingTimeout`、`handshakeTimeoutMs`，接 `onError`，`onError` 后自己隔 1–10 分钟重开（SDK 对 endpoint 的大多数回码永久放弃）；非 `event` 帧要报出来（SDK 悄悄丢，`watchFrames`）；重连后补漏消息（点击补不回来）；更新点过的卡先关流式。W1e 用 SDK 1.77.0 实现了 `feishu/sdk.ts`；它自己的日志会把带 `app_secret` 的原始请求交出去（`hub/test/feishu-sdk.test.ts` 钉住了），所以一律传 `safeSdkLogger`（打码 + 只留状态码）。user 身份轮询、查已读、飞书邮箱和以我名义发（批准后）※ 仍走主机器上装的 lark-cli（`feishu/user.ts` 的 `Lark` 类型，测试里换假的）：SDK 的 user 令牌要自己做 OAuth 和刷新，W1 不值得；以后换只动这一个文件。以我名义只发纯文本；发之前对 `approvals` 行：`kind=send`、`status=approved`、`as_identity=user`、没过 `send_by`，正文正好等于 `final_text ?? draft`，chat 和回复的那条消息和 `target_json` 一致（三种 target 形状同一个解析），有一项不对就返回 `retry:false`、什么都不发。我在飞书里发的、点的进 inbox 时 payload 带 `owner: true`（W1d 的 `ownerTyped` 认它），别人的消息只 `record`，从不带。

## sources（SourcePlugin）

- 内置：git（读 `git ls-remote` + 浅 fetch，不再要 bare 镜像 ※）、fetch、飞书邮箱（必须用主自己的登录，所以内置）。
- `command` 插件和排盘脚本：子进程，Linux 上以 `sbot-w` 跑（经 `deploy/worker/worker-exec` 的插件模式），读不到 `secrets.env`；每个插件开自己的出网（`egress` 按插件放行域名）。Mac、Windows 当主时以同一个用户跑（我定，§底3.8）。
- 契约：stdin 一行 JSON `{ v: 1, since, cursor, env }`；stdout 每行一条 `{ kind: "item", id, ts, where, author?, text, link?, raw_b64? }` 或最后一行 `{ kind: "done", cursor }`；stderr 进日志；退出码非 0 = 这次失败，游标不前进。不设时长和输出上限。
- **排除名单**（Y5）：`sources.yaml` 加 `exclude: { chats: [], persons: [], mails: [] }`；在 `sources` 和飞书插件 `ingest` 处代码卡住，进不了 `messages`。改它是收窄，不走 `widening()`；删条目是放宽，走。
- 进来的东西和群消息走同一条路：`messages` → 分拣 → 事件 → 挂到事。
- 接口（`hub/src/sources/types.ts`）：`SourcePlugin { kind, zh, poll(s, state, since, cursor) → { items, cursor? } }`；`state` 是 `<root>/sources/<id>/` 目录加按源的 kv。kv `source.<id>.since` 记上次成功的开始时间（下次往前重叠 5 分钟），`source.<id>.cursor` 记插件给的游标；失败两个都不动。item 可带 `to_me`、`from_me`、`parties`（邮件的收发人，给排除名单用）、`raw_b64`（进 CAS，`raw_ref` 记在 `raw_json`）。只收 http(s) 链接。
- command 插件运行器 ※：Mac、Windows 当主时 `localPluginRunner`（同一用户、最小 env、`HOME=` 插件状态目录）。Linux 上 `worker-exec` 还没有插件模式（`deploy/`，另开 PR），这期间不接运行器，command 源明确报「这台主上还没接插件运行器」，不退回以主的身份跑。插件要 `FEISHU_APP_*` 或模型的 `key_ref` 一律拒（主自己的密钥）。
- 分拣（`hub/src/triage/`）：W1d 管的都经 `TriageDeps { complete?, runDraft?, submitSend?, notice?, readIds?, kick? }` 注入。主上接了 `complete`（`triage/complete.ts`：跟承诺检测一样，每次调用发一个 light 档令牌、`finally` 里吊销，上游密钥不出代理；令牌的 `run_id` 是 `triage:…` 标签）、`submitSend`（W1d 的 `submitApproval`）、`readIds`、`kick`；`runDraft` 还没接 ※，所以 draft 眼下都降成 notify。没有 `complete` 就不启动（只靠规则会把消息一次判死），消息留 `pending`；缺 `runDraft` 或 `submitSend` 时 draft 降成 notify（「起草没接上」）。草稿只经 `submitSend`（`as_identity: "user"` 的 send 审批）出去。notice 在 push 接上前走 `notify.admin`。

## memory

- **写队列**：`memory.write(repo: "agent-home" | "config", fn: (wt) => Promise<void>, msg) → Promise<sha>`；每个仓库一条串行队列，`fn` 里改文件，队列里 `git add/commit`。读不排队。所有旧的 `commitIfDirty`、`editConfig` 调用点改走它。每种实体只认一个写源，启动时对一次账（§底1.3）。
- journal 每行 `- [HH:MM][run=<id>][src=<标签>] …`，来源由工具层填。
- `memory_search` / `wiki_search`：每处截断都在第一行报完整度（「共 N 页命中，显示 X 页，每页前 4 行；还有 M 页」），给 `offset` 翻页；`memory_read` 截断时报「读到 12000 / 共 N 字」（R7）。
- `forget`、`memory_patch` 逐条改、比对出处数、dream 的删改比例和净增上限，照 §读1.3、§附2.16。
- 原始资料：`raw/sha256/<前两位>/<sha>` 本地内容寻址，只增不改。`memory/pages.ts` 的 `putRaw`/`readRaw`（`raw:<sha256>`，`raw_sources` 第一个写的人算出处）。
- W1e 搬了读的一半：`memory/wiki.ts`（`searchWiki`）、`memory/pages.ts`（`readPage`、`safePath`、`journalLine`）、`memory/tuning.ts`（经我批准的提示词调整，W1d 拼提示词也要用，别再抄一份）。写队列和 dream 不在 W1e。
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
- Sentinel 每 5 分钟，纯代码，告警经 `push`（`alert_security` / `alert_ops`）。W1e 里 `Sentinel({ alert })` 注入出口，push 接上前默认 `notify.admin`；每类一次一条，同一项在 `again` 窗口内不重复，恢复了清掉，再坏再报；状态在 kv `sentinel.state/findings/last`。查：审批挂 2 小时、非任务 run 跑 20 分钟、任务 20 分钟没动静、24 小时内 outbox 失败或不确定、代理错误率、预算到八成、飞书 user 授权（security）、夜间备份超 30 小时、job 上次失败。异地备份那项等备份同步到节点再加 ※。
- 搁着（§寸5）：`ledgers/matters.ts` 的 `OPEN`（含 paused）、`NAGGING`（不含）、`RESURFACED`（paused 且 `last_activity_at > paused_at`）三个 SQL 片段；`pauseMatter`/`resumeMatter` 连同子事一起改，撤销能还原 `paused_at`、`last_activity_at`。
- `check` 的执行者是注入的 `CheckRunner`（W1d 接本机节点）；没接上算脚本坏了（退出码 −1），照常跑 run 并告警，不换别的办法跑。

## push（§触1.1 路由表）

- 代码在 `hub/src/push/`：`table.ts`（路由表）、`presence.ts`（在场）、`queue.ts`（入队、状态机、已读、省心、早报事实）、`fcm.ts`；路由在 `api/push-routes.ts`。`main.ts` 起 `Push`（每 15 秒一轮，入队、在场上报都踢一下）。
- 入口一个函数：`push.enqueue(db, { cat, ref, lane, domain, text, expires_at?, not_before? })`，在调用方的事务里。急不急、占不占额度、省心时推不推、发到哪个出口组、安卓哪个通知渠道、补不补推都由 `table.ts` 按 `cat` 定，模型说了不算。同一个 `(cat, ref)` 第二次入队不动第一行（同一件事同一状态只判一次）。`submitApproval` 交卡时入队（`ask` 卡 → `ask`，其余 → `approval`，文本「等你拍板 / 过目：标题」）；暂缓沿用 W3a 的同一行。
- 占额度的 ※：它自己起的才占——`agent_followup`、`notice`、`fyi`、`suggestion`、`reflect`、`tidy`，和暂缓「今晚」那一推；等我回、审批、我定的 follow-up、我发起的任务、告警、早报不占。
- **在场**只在内存：每台 `client` 设备最近一次 `POST /api/v1/presence { foreground, viewing }` 的时间和内容；任何一台在前台且 `push.presence.away_seconds`（180）内报过就算在场；`push.presence.enabled: false` 时永远不算在场。重启后没人在场，宁可多推。
- 状态机在 `push_queue.state`（04），每轮按 id 顺序走到期（`not_before` 已过）的 `wait`、`counted`：
  1. 省心开着、这类省心不推 → `void`，`sent_json` 记 `{via:"ease"}`；
  2. 在场且正看着（`viewing` 是这一行的 ref、它去掉状态后缀的条目，或 lane 对得上的 `thread:<id>`）→ `done`（`via:"viewing"`）；
  3. 夜里：`night_allow` 的、或急的且 `expires_at` 早于这夜结束的照发；`agent_followup` 挪到夜间结束（`not_before`）；其余 → `night`；
  4. 在场没看 → `counted`；我走开（不在前台或 180 秒没报）之后下一轮照常走下去，这就是「走开时再推」；
  5. 对话中先等：不急的类，我最后一条（任一端我亲手发的 inbox 行）后不到 `quiet_minutes`、或主对话或它自己的 lane 有 run 在跑，就留着，到 `deadline`（入队 + `max_delay_minutes`）为止；
  6. 占额度的，今天已发的到了 `proactive_daily_cap` → `night`，进早报；
  7. 发 → `sent`；不补推的类（`tidy`、`fyi`、`suggestion`）直接 `done`。
  任何开着的行过了 `expires_at` → `void`。启用的 `do: morning` 任务一个都没有时，白天把 `night` 的放回 `wait` ※（不然没人收）。
- 发几路：急的 FCM 和渠道同发，不要回执（D1）；不急的 FCM 收下了就不推渠道，FCM 关着、没令牌或令牌失效推渠道（D15）。渠道 = `toOutlet(表里的出口组, …, { noClient: true, idem: push:<id> })`：告警进 `admin`，其余进 `main`；`personal` 一律进 `main`。客户端自己从视图里看，不另写 `messages`。
- 「N 条」= 开着（`wait`、`counted`、`sent`）的行数，含这一条；大于 1 时渠道那句后面带「（等你的共 N 条）」，FCM 放在正文。已读把行关掉，数就跟着变。
- `personal`：FCM 标题只有「有一条私人的」、正文空，`data.personal = "1"`；渠道只发「客户端有新消息」。
- **FCM**（veto 8）：HTTP v1，自己签 JWT（RS256，`node:crypto`），换 access token 缓存 50 分钟；不用 firebase-admin。服务账号在 `secrets.env`：`FCM_PROJECT_ID`、`FCM_CLIENT_EMAIL`、`FCM_PRIVATE_KEY` ※（PEM，换行写成 `\n`）。`UNREGISTERED`/`INVALID_ARGUMENT`/404 视为令牌失效：清 `devices.push_token`、记 `device_audit token_cleared`（actor `code`）、发 `device`，这条改推渠道。开关是 `console.yaml` 的 `fcm.enabled`（06），默认关，打开走 `widening()`（Y11）；开关开着且三个密钥都在才算开（`PushTokenRes.fcm_enabled`）。令牌不进日志、不回给客户端、不进 `client_ops`（只进请求的 hash）。眼下没有 Firebase 项目（等你准备），测试用假的发送器。
- `PUT /api/v1/devices/self/push-token`：只认配对过的 `client` 设备（CLI 404）；变了才写、记 `token_set`/`token_cleared`、发 `device`。
- 已读按人算：`POST /api/v1/reads` 写 `reads`（thread 的 `upto_ts` 只往后），发 `read`；关掉这个 ref、带状态后缀的同一条目（`task:t42` 关 `task:t42:done`）、thread 读到 `upto_ts` 为止它 lane 上入队的行 → `done`。暂缓过的行看了不关 ※：我要的是到点提醒，看一眼不算。飞书点开的已读等飞书插件接（`via: feishu`）※。bootstrap 带 `ease` 和这次快照里 thread、待批卡的 `reads`。每台设备只各自记滚动位置（不上主）。
- 额度：§寸2 的每日主动消息上限（`gate.yaml` `proactive_daily_cap`，我定过的，沿用）按 `push_queue` 里 `quota = 1` 且 `sent_at` 在本地今天的行数算。
- **省心**（§寸6）：kv `ease = {on, since}`。`PUT /api/v1/ease`（客户端一键，`source: console`）和工具 `ease_set`（只在 `typed` 列，且只在 `feishu:dm:owner`、`console:main`，`source: chat`）两条路，都经 `setEase`：真切换了才写、同事务发 `ease`、记一行 `config_changes(file='ease')`。它从不自己切。省心时 `table.ts` 里 `ease: false` 的类（整理卡、知道就好、建议、通知、它自己的 follow-up）不推；等我回、审批、我的 follow-up、任务、告警、早报、周月复盘照推。切到省心时翻「养」的那一下等 §改1 的模块 ※。
- 早报：`jobs.yaml` 的 `do: morning` 现在由 `main.ts` 给文本（`texts.morning`）：一句开头、待批张数，加 `morningFacts`：「省心中 · 第 N 天」（顶行）、第 3 天起问一次要不要回常态（kv `ease.asked` 记住这次省心问过了）、省心中没推的整理卡数、「夜里来的」（`night` 且到了时间的行，原文；`personal` 只在我的私聊和 `console:main` 里给原文）、知道就好的条数。早报的 inbox 行写下时（`hooks.opened`）这些行 → `done`。其余事实（任务、事、镜头）等 ledgers 的 `morningText` 搬过来 ※。

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
- W3a 落地：写路由在 `api/writes.ts`，每个都包在 `api/ops.ts` 的 `withOp` 里（查 `client_ops` → 业务写入 → 记结果和 seq，一个事务；同键换了请求 409）；发消息用 inbox 的键（`device:<id>` + `client_op_id`），不进 `client_ops`。
  - thread：`POST /api/v1/threads` 建 `console:t:<id>`，带 `matter_id` 是主线（kind `matter`，标题默认用事的；事是 `personal` 的，thread 一律 `personal`，`work` 的事可以收窄成 `personal`）；没给 `domain` 的一般 thread 是 `work` ※。`PATCH` 改名、置顶、收起，域不改。`console:main` 启动时保证有（`personal`）。
  - 发消息：飞书镜像 thread 409（D9），任务 thread 409 到 W4；收起的 thread 我写了就回到列表；单独一行的 `/stop` `/new` `/cancel` 当命令；同时写一行 `messages`（`console:<device>:<op>`，`domain` 跟 thread），撤回时删掉。回 `queued`、`ahead`（这条前面排着几条）。
  - 撤回只收我打的、还在 `received` 的；停这一轮回 `stopped`（真停了才是 true，run 行变 aborted 走流）。
  - 审批四条路由调 `approvals.ts` 的 `decide`、`editDraft`、`requestRedraft`、`snoozeApproval`，和飞书按钮、卡片话题回复是同一组函数；谁先提交谁赢，后到的 409 拿到赢的那个结果。
- **共享的地方**（§读5.1，`turn.ts` `seesPersonal`/`privacyCol`）：客户端（`console:*`）和我的飞书私聊能整份看私人的东西；工作台、管理群是群，就算是我亲手发的那一轮，读 `self/`、身体、时间线也按 system 列的规矩（不整份，只能 `self_list` 看条目），提示词里不放 `self/practice.md`，并提醒只提一两句 ※。`messages.domain` 写入时就定：私聊和 `personal` thread 是 `personal`，群和工作台是 `work`；以后的搜索按它滤，飞书的 lane 查不到 `personal`。主线 thread 的每一轮带上它的事的摘要、子事、最近事件（`dispatch.ts` `matterContext`）；事是 `personal` 的，在共享的地方不带。
- **pump**：每 100 ms 读 `change_log` 里 `seq > 上次`，同批同实体合并，发送时用和 GET 同一个视图函数取最新内容，按连接过滤（`node` 不收客户端流；`personal` 只发 `client`）。心跳带最新 `seq`。慢连接：持久事件停读、之后补；delta 直接丢、缓过来发 snapshot（§触6.4）。
- 视图函数是 bootstrap、GET、事件三处共用的唯一取数处。
- W2b 落地（`hub/src/api/`）：入口 `Api.dispatch(req, { device_id, role, conn? })`，进来先调一次 `authorize(caller, req)`（`authz.ts`），W2a 起是 `link/roles.ts` 的（只认规范路径，`..`、`//`、`%2e` 之类在入口就 403），`main.ts` 经 `createApi({ authorize })` 传进来；不过就 403，`node` 在 `/api/v1` 下全 403。路径里的 `?a=b` 并进 `query`（CLI 用）。错方法 405，没有的路由 404。`conn` 是 link 给的 `{ send(frame), writable() }`，没有 `conn` 的调用方（CLI、测试）开不了流。列表和 bootstrap 都在一个事务里读，带当时的 `seq`。
- pump 落地：每条连接一个游标；心跳的 `seq` 是这条连接补到的位置。回复正文的 delta 由派发的 `onItem` 喂进来（`main.ts`），键 `<run>:a<n>`；工具输出 `toolText(run, item, text)`（W4 节点流式时接）。游标落后到被清理（04 §10.4）或 `after` 比最新还新 → `reset` 并关掉这条流。
- `threads` 行 ※：进输入时（`inbox.ingest` 同一事务）和 run 结束时由 `touchThread` 建或更新 `last_item_at`。`console:main`、`feishu:dm:owner` 是 `personal`，`feishu:wb:*`、`console:t:th_*`、`task:t*` 是 `work`，别的 lane（triage、draft、outlet……）没有。时间线按 `(ts, 来源次序, id)` 排，游标对客户端不透明；inbox、approvals、tasks 按 lane 还没索引 ※（04 §13 的量级扫一遍是毫秒）。

## link

- 本机 socket：
  - `hub.sock`：本机节点，在单独的 `$SBOT_HOME/node/`（0750，属组是节点账号的组，组名或 gid 取 `SBOT_NODE_GROUP`，没设就跟主同组），socket 0660 ※。不放 `run/`：`run/` 是 0700，节点账号进不去，里面的 socket 权限再开也连不上。要节点账号够得着，`$SBOT_HOME` 本身要给那个组 `x`（属组设成它、0710），主的账号要在那个组里（改目录属组要求）；部署时设，主启动时查到进不去会记日志。连上就是 `role: node`，设备 id 固定 `local`，不配对 ※（同机、靠文件权限，veto 3）。
  - `hub-admin.sock`：在 `$SBOT_HOME/run/`（0700），`sbot` CLI，0600、只有主的账号能连；连上等同一台 `client` 设备 `cli`，审计里记 `cli`。
- 中继：`relay.enabled` 时主连 `wss://…/v1/hub`，按 06 注册，断了按 1、2、5、10、30 秒退避重连。一条 WS 上按 sid 一个会话一个 Noise 响应方（`hub/src/link/session.ts`，不绑传输，以后直连复用）；中继不可信，坏信封、不认识的 sid 直接丢。
- 主密钥在 `link/keys.ts`，在读 `secrets.env` 之前生成或读入（`keys/` 下的文件打码器都认）。通道里的请求进 `api.dispatch`（`authorize` 在它入口，函数是 `link/roles.ts` 的，`api/authz.ts` 转出），通道关了调 `api.closeConn`。`hub-admin.sock` 走 `main.ts` 的 `router`：整个交给 `api.dispatch`（调用方 `cli`、角色 `client`，同一个 `authorize`）。W3a 起设备的写（`POST /api/v1/devices/invites`、`PATCH/DELETE /api/v1/devices/:id`）是 `api/writes.ts` 的写路由，CLI 和配对过的客户端走同一条；`adminRequest` 给每个写请求一个新的 `client_op_id`（CLI 不重试）。
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
- 施工（W4a，`hub/src/tasks/`；※ 的等我过目）：
  - 分工：`nodes.ts` 管登记（hello、在场、`NodePeer` 往下发请求）；`engine.ts` 管任务 lane（`task:<id>`，主的 dispatcher 不碰这些 lane）；`node-api.ts` 是 `/node/v1` 节点往上的路由；`tools.ts` 是 sbot MCP；任务的写在 `api/task-writes.ts`。
  - 身份：节点只能动 `tasks.node` 等于它自己设备 id 的任务（事件、权限请求、工具调用都查，不是就 403）；主往下发的路由（sessions、turns、permissions/:id、git/checks、worktrees/cleanup）节点向主请求一律 404。本机节点走 `hub.sock`，设备 id `local`，同一个 `api.dispatch`、同一个角色检查。
  - 任务的写（派活、插话、停、取消、换机器、清理 worktree）是 W3a 写层的写路由（`api/task-writes.ts`），客户端经中继和 `hub-admin.sock` 走同一条，都要 `client_op_id`，同 id 换内容 409。派活只写库，在 `withOp` 的事务里；其余要等节点，走 `withOpAsync`（`ops.ts`）※：答案回来后才存进 `client_ops`，同进程里同 id 的并发重试接上同一个调用；本身也可重跑（插话按收件箱键 `device:<id>` + `client_op_id` 去重，停、取消、换机器、清理先看状态）。进程在调完节点、存答案之前崩了，重试会再调一次（换机器会再开一次）。
  - 卡：任务的卡作废时也关掉它的 `push_queue` 行（`closePush`）；客户端 `decide` 问我卡时带的 `answers`（题 → 答）打码后经 `choose()` 交给节点，被拒照旧 fail closed。
  - 没填节点 = `local`，它不在线就等它，不会自己挑别的机器；派到 `local` 以外的节点写一条通知（`push_queue`，不等我点）。额度、CI 连红、派活的通知经 `pushNotice` → push 的 `enqueue`（类 `notice`，占不占额度、急不急按路由表），由 push 判在场、夜间、上限后发。
  - hello：先同步对账（hello 里的 `sessions` 没有的、`released` 的 → `interrupted`，卡作废，「需要你处理」），再在回完 hello 之后发出等着的东西（重开、排队的任务、答案）。对账必须同步：放到回包之后，回包和对账之间新开的 session 会被当成丢了。
  - 节点下线：`running`/`waiting` → `waiting_node`，卡留着（进程可能还在）；回来时按 hello 的 `sessions` 还原或进 `interrupted`。我在 `interrupted` 的任务里说话 = 带 `resume_ref` 重开（`attempt + 1`），同时附交接文本 ※，节点续接不上（`fresh`）时直接用，不用再来回一趟。
  - 事件：按 `task:attempt:seq` 幂等（kv），旧 `attempt` 整批丢，比当前新的 409；认不出的 `k` 跳过不报错。文本经 `StreamRedactor` 推 delta；工具结果、消息、diff（上传的 blob 也重新打码另存）都先打码再进 `run_items`、blob。用量写 `usage`，`source = node`。
  - 权限请求：按 `request_id` 幂等；卡 `glance`/`ask`，`requester = node:<设备>`，命令、路径原样（打码，不截断）。答案：卡被拒 → 一定发拒绝类选项（我点的是拒绝类就发它，否则第一个 `kind`（没有 `kind` 看 id）以 `reject`/`deny` 开头的；一个都没有就发 `reject`，不在选项里，节点按拒绝处理 ※）；批了发我点的那个（点的是拒绝类也照发），没点才取第一个放行类 ※。等的时候我发消息：先把卡拒掉、把拒绝发给节点，再插话。
  - 卡住：`needs_you` 现算，`interrupted`，或 `running` 且超过 `measure.stuck_minutes` 没输出、不在额度等待里。
  - 时间（常量，可改 ※）：开 session 等 120 秒；额度没给恢复时间时 30 分钟后试；空闲释放 60 分钟；CI 首查 2 分钟、`pending` 3 分钟、结果出来后 10 分钟再看；节点不在时 30 秒后重试。CI 连红第 3 次（`CI_RED_NOTIFY`）照样叫醒，同时写一条通知，不拦；绿了清零；同一个 `head_sha` 只叫一次；失败日志取最后 20 KB，打码。PR 合了，这个任务的 worktree 列成「可清理」。
  - sbot MCP：任务里的调用 = `system` 那一列（`reply`、`memory_read`、`send` 等；`send` 照旧变审批卡）+ `submit_report`、`ask`；没有 bash 和文件工具。不带 `task_id` 的调用要 `console.yaml mcp_open: true`（默认关，开是放宽）；按 `tool_call_id` 幂等。`ask` 走 MCP 时没有节点在等的请求，我的回答作为下一条消息进 session。
  - 上传：`POST /node/v1/blobs` 单个上限 64 MiB ※；分片按设备分临时文件，最后一片对 sha 才改名。传到一半断掉的临时文件现在不清 ※（等 GC）。

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
- `status` 走 `GET /api/v1/status`（`protocol/api/status.ts`）：版本、提交号、协议版本、主公钥指纹（W2 前是 `null`）、启动时间、库版本；中继、节点、可选件跟着各自的波次加字段。W2a 加 `relay { enabled, connected }` 和 `hub_pk`（公钥原文，抄进 `relay.yaml` 用）※。
- `sbot pair` 打二维码（`uqr`，终端 Unicode 半格）和链接，提醒这是 10 分钟的一次性密码；中继没开时照出码并说现在连不上。
- 退出码：0 成功、1 失败、2 参数不对、3 还没做（报是哪一波：`chat` W3，`upgrade` W4，`import` W6）。

## 配置键变化（Y11）

改配置键 = 同一个 PR 里改 zod schema、表单描述、`widening()` 三处，`config-form` 的漂移测试照搬。

| 文件 | 变化 |
|---|---|
| `gate.yaml` | 加 `push`（§触1.1 那段）；`improve_budget_usd` → `improve_alert_usd`；`expert_daily_limit` 照认、读成 `models.yaml` `tiers.expert.daily_alert`；`proactive_daily_cap`、`approval_ttl_hours`、`send_by_hours`、`sensitive_words`、`attention` 沿用；加 `hold_text`、`hold_timeout_text`（§底3.4 稳住对方的两句固定话，有默认值）※ |
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
