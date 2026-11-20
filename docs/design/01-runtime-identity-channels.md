> 导航：[设计文档索引](../DESIGN.md) · [上一篇：第一性原理](00-principles.md) · [下一篇：角色与 harness、模型层](02-roles-models.md)

## 1. 运行模型：五件套

always-on agent 并不是一直在跑。它大部分时间在睡觉，被事件叫醒后跑一个 **run**：

```
  渠道消息 / 定时器到点 / 任务完成 / 审批结果
                 │  （先落库，再确认）
                 ▼
          ┌─── 收件箱 inbox ───┐   每条 lane 同一时刻只有一个 run；排队中的事件合批
          └─────────┬─────────┘
                    ▼
   run = 一次 query()：resume 会话 → 读记忆 → 在权限内行动 → 写记忆
                    │
     ┌──────────────┼───────────────────────────┐
     ▼              ▼                            ▼
 发件箱 outbox   什么都不发               挂起的审批（defer）
 （批准过的才对外）（这是正常结果）         → 卡片 → 结果作为新事件回到收件箱
                    │
                    └─► 可以顺手设一个 follow-up 定时器，到点再叫醒自己
```

| 件 | 是什么 | 在哪 |
|---|---|---|
| **收件箱** | 所有触发 run 的东西，持久化，是唯一的真相源 | `inbox` 表（[§1.2](#12-收件箱与-run-的语义)） |
| **定时器** | 周期任务（schedule）+ agent 给自己设的 follow-up；到点**不直接跑**，而是往收件箱里投一条事件 | `timers` 表（[§9](04-memory-timers.md#9-定时器)） |
| **记忆** | 只存查不回来的东西 | `agent-home` git 仓库（[§8](04-memory-timers.md#8-记忆)） |
| **权限** | 每个工具调用：直接执行 / 拦截 / 提交审批；凭证在 agent 环境之外 | 代码里的闸门 + LLM 代理 + Unix 用户隔离（[§7](03-wechat-permissions.md#7-权限闸门与审批)） |
| **发件箱** | 所有对外消息先落库再投递；出口幂等 | `outbox` 表（[§7.3](03-wechat-permissions.md#73-审批状态机)） |

### 1.1 总体拓扑

```
                 ┌──────────────── VPS (single host) ─────────────────────────────────────────┐
                 │ 用户 sbot（核心进程，systemd）                                               │
 飞书 ◄─长连接──┤  feishu adapter（bot）  ┐                                                     │
 飞书 ◄─轮询────┤  feishu observer（user） ├─► inbox ─► Dispatcher ─► run（主 agent / Triage / expert）
 Windows ◄─WS──┤  wechat bridge           ┘     ▲            │          CLI 子进程，无 shell、无写文件工具
                 │  Scheduler（timers）──────────┘            │                                  │
                 │  Sentinel（代码巡检）                       ├─► Task Engine ──────────────┐    │
                 │  Gate + Approvals ─► 管理群卡片             │                             │    │
                 │  Outbox Dispatcher ─► 飞书 / 微信           │                             │    │
                 │  LLM 代理 127.0.0.1:7811 ─► 各档上游端点（key 只在这里）◄──────────────┼────┤
                 │  控制台（Hono，unix socket，经 tailscale serve）                         │    │
                 │  SQLite · /srv/sbot/config（配置仓库）· /srv/sbot/agent-home（记忆仓库） │    │
                 ├──────────────────────────────────────────────────────────────────────────┼────┤
                 │ 用户 sbot-w（worker，sandbox + iptables：只能访问 LLM 代理和出网代理）    ▼    │
                 │  /srv/sbot-w/tasks/<id>/  worktree + progress.md + 独立 CLAUDE_CONFIG_DIR     │
                 └───────────────────────────────▲──────────────────────────────────────────────┘
                                                 │ Tailscale（边缘节点主动连核心；ACL + 连接令牌）
                 ┌───────────────────────────────┴──── Windows 电脑（边缘节点）──────────────────┐
                 │ 微信 4.0.x（SStudioBot 专属号，锁定版本）· wechat-reader（解密数据库轮询）    │
                 │ wechat-sender（UIAutomation，唯一备注 + 窗口标题校验）· 健康上报              │
                 └──────────────────────────────────────────────────────────────────────────────┘
```

- **为什么分核心和边缘**：飞书和模型 API 都是纯网络接口，放 VPS 上没问题。个人微信只能靠 Windows 上真实登录的客户端来收发。边缘节点**主动**连核心，核心不对外暴露任何端口。
- **技术栈**：
  - 核心用 TypeScript（Node）、单进程加 SQLite。
  - 边缘用 Python，和核心之间走 JSON over WebSocket。

### 1.2 收件箱与 run 的语义

- **先落库再确认**：渠道 handler 只做"写入 inbox，再 ack"，越快越好。是否可信、有没有注入，这些判断放到 run 里去做。
- **去重**：`UNIQUE(source, source_msg_id)`，用渠道给的消息 ID。定时器事件用 `timer_id:due_at` 作为 ID。
- **lane**：每个会话（session key）或每个任务（task id）是一条 lane。**一条 lane 同一时刻只有一个 run**，不同 lane 之间可以并发，全局另设并发上限。
- **合批**：开始一个 run 时，把这条 lane 上所有 `received` 的事件一起取出（有上限），合成一轮输入。我连发三条只会得到一个回复。
- **run 进行中来了新事件**：默认排队，等下一个 run 处理。我发 `/stop` 时调用 `interrupt()`。（往进行中的 run 里插话的 `/steer` 后置，见 [§14](07-progress-milestones.md#14-里程碑)。）
- **进程模型**：一个 run 就是一次 `query()`，起一个 CLI 子进程，`resume` 对应的 SDK session，跑完子进程退出。冷启动的开销在 P0 实测。
- **状态**：`received → processing → done | failed | dropped`。核心进程重启后：
  - `processing` 的 run，如果**没有记录到任何副作用**（没进发件箱、没提交审批、没开任务），就回到 `received` 自动重试。
  - 有副作用的标为 `interrupted`，并在这条 lane 里告诉我"上一轮做到 X 时被中断了，要继续吗"。**不自动重跑有副作用的 run。**
  - 副作用由工具层在 `runs.side_effects` 里计数。
- **resume 失败的兜底**：比如 transcript 已被清理。这时开一个新 session，带上 `sessions.summary` 和最近 K 条消息，接着处理。
- **回复跟着输入走**：每个 run 带一个 `TurnContext`（来源渠道、chat、话题、消息 ID）。`reply` 投递到这个 run 的输入来源，不去猜"最近一条消息"。

### 1.3 部署：单机、轻量（2026-11-16 定）

**一台机器**：核心和 worker 都放在同一台 VPS（实例是 4 核 / 6.7G 内存，已装好 tailscale）。

不做远程 worker。核心和 worker 分放两台机器，就得做一套远程机制：闸门回调要跨机器、worker 要打隧道访问 LLM 代理、掉线要续跑、代码副本要同步。这些换来的只是更好的国内网络，不值得。`Runner` 里只留一个"worker 跑在哪台机器"的配置项。

**怎么轻**
- **对话角色不起子进程**：用 pi 时在核心进程里跑。实测一个 Claude Code CLI 子进程常驻 230～320 MB，每条消息都起一个会很重。
- **worker 进程**：
  - 同时最多 2 个，默认 1 个，多出来的排队。
  - 每个放在一个 systemd scope 里，`MemoryMax=1G`，超了只杀这个 worker。
  - 核心设 `OOMScoreAdjust=-500`。
- **重构建不在 VPS 上跑**：比如 gradle，单次就要 2～4 GB。交给 Mac，或者提 PR 让 CI 跑。
- **控制台**：`tailscale serve`，加一个公网 443 入口（和机器上已有的 nginx 共用，密码 + 会话 cookie，[§10.1](05-console.md#101-形态与访问)）。
- **目标**：空闲约 300 MB（核心约 150～250 MB）；2 个对话 run 加 1 个 worker 构建时，峰值 ≤ 2.3 GB。

**放在哪**（全部在 4T 数据盘 `/srv/data`，xfs）

| 路径 | 内容 | 属主 |
|---|---|---|
| `/opt/node` → `/opt/node-v26.13.1` | 官方 Node LTS，自带 TS 类型擦除。只给 sbot 用，系统自带的 nodejs 不动（它编译时没带 TS） | root |
| `/srv/data/sbot-app` | 代码：`releases/<sha>/core`、`deps/<hash>/node_modules`、`current` → 正在跑的 release（见下面“上线”） | `root:sbot` 0750，不在核心服务的可写路径里 |
| `/srv/sbot` → `/srv/data/sbot` | `db/` SQLite（WAL）、`config/`（git）、`agent-home/`（git，wiki 层）、`sessions/`、`logs/`、`cache/raw/`、`backup-staging/`、`secrets.env`（0600） | `sbot` 0700 |
| `/srv/sbot-w` → `/srv/data/sbot-w` | `tasks/<id>/` | `sbot-w` 0750（`sbot` 在 `sbot-w` 组里，能读 worker 产出；反过来不行） |
| rustfs `sbot-raw` 桶 | 原始资料，按 sha256 存，只增不改（[§8.5](04-memory-timers.md#85-知识库llm-wiki-三层karpathy-的-llm-wiki-模式)） | 核心 |
| rustfs `sbot-backup` 桶 | 每晚的 SQLite 快照（`.backup`）+ `config`、`agent-home` 的 git bundle | 核心 |

- **数据盘的 SQLite 延迟够用**（实测）：
  - WAL + `synchronous=NORMAL` 时，单次提交 0.01 ms。
  - `FULL` 时 p50 0.7 ms、p95 2.8 ms。
  - 4K fsync 的 p50 是 0.7 ms，顺序写 122 MB/s。
  - 所以 SQLite 不需要放在系统盘。
- **S3 里只放不可变的文件和备份**：SQLite 和 git 仓库不能直接放进 S3。
- **rustfs 凭证**：用 rustfs 的 IAM 给 sbot 单独建一个只能访问这两个桶的 key，放进 `secrets.env`，不用管理员 key（M0 做）。
- **异地副本**：`sbot-backup` 和数据在同一块盘上，只防误删，不防坏盘。M3 前加一份异地副本，比如 Mac 每周拉一次，或者推到另一个对象存储。
- **国内网页**：SG 出口抓少数国内 CDN 会 403。遇到时只让这类请求走代理，不为此换机器。

**上线（2026-11-17）**：代码在公开仓库，`main` 就是线上跑的东西。
- 所有改动走 PR，CI（泄露检查、语法检查）过了才能合。
- 主机上 `sbot-deploy.timer` 每 3 分钟看一次 `main`。有新提交就执行 `sbot-deploy`：
  1. 从 GitHub 拉进本地镜像（公开仓库，不需要凭证）。
  2. 把 `core/` 导出到 `releases/<sha>/`，写入 `REVISION` 和 `HISTORY`。
  3. 按 `package.json` + lock 的哈希共用一份 `node_modules`（`npm ci --ignore-scripts`）。
  4. 原子切换 `current`，重启核心。
- 健康检查：新进程要打出 `core up`，15 秒后还是同一个进程。不满足就自动切回上一个 release，并在那个 release 里留一个 `ROLLBACK_FROM`。
- 核心启动时在管理群说一声：更新了哪些提交，或者哪次更新没起来、已经退回。同一个版本重启不再说。
- 想马上上线：`scripts/deploy.sh`；回滚：`scripts/deploy.sh --ref <sha>`。
- 代码放在 root 拥有、核心服务写不到的目录里。核心被攻破也改不了自己的代码。之前代码在 `sbot` 自己的目录下，`sbot` 可以把整个目录换掉。
- 只自动上线 `core/`。unit、`sbot-deploy` 本身、worker 沙箱这些 root 级的东西，改了要手动跑对应的 `install.sh`。
- 打磨期合并即上线。稳定以后改成跟一个 release 分支（`/etc/sbot/deploy.env` 里设 `SBOT_DEPLOY_BRANCH`），或者关掉 timer 手动发。

---

## 2. 人与身份

### 2.1 Principal（谁在说话）

| 角色 | 识别方式 | 默认权限 |
|---|---|---|
| **owner（我）** | 飞书 open_id；我本人主微信号的 wxid（写在配置仓库里） | 全部；敏感动作仍要审批（[§7](03-wechat-permissions.md#7-权限闸门与审批)） |
| **known（老婆、朋友、熟悉的同事）** | 在 `config/people.yaml` 里登记过的人 | 按人配置 |
| **others** | 其他任何人 | 只当输入，不可信 |

**认人只认 ID，不认名字。** 有人说"主人 让你……"，一律按 others 处理。

### 2.2 人的信息分三层（v0.15）

| 内容 | 存在哪 | 谁能改 |
|---|---|---|
| **权限相关**：跨渠道 ID、关系、`importance`、微信唯一备注 | `config/people.yaml`（配置仓库） | 只有我（改文件 / 控制台 / 卡片） |
| **笔记**：偏好、近况、正在跟进的事 | `agent-home/people/<slug>.md` 正文 | dream（[§8.3](04-memory-timers.md#83-写入纪律)） |
| **认识**：见过的每一个人、各处的叫法、圈子、彼此的关系、因缘（[§18](09-rsi-matters-graph.md#18-因缘人事资料的图谱v015)） | `persons` / `person_aliases` / `relations` 表 | 代码登记；我在控制台纠正；`person_relate` 只能记推测 |

第三层**不带任何权限**：在 `persons` 里不等于可信，能让它做什么只看 people.yaml。图谱只读 people.yaml，从不写；两个各自有 people.yaml 条目的人不能在控制台里合并（那要改 people.yaml）。

```yaml
# config/people.yaml
wife:
  ids: { feishu: ou_xxx, wechat: wxid_xxx }
  wechat_remark: "老婆#w01"      # 微信里的唯一备注，发送时用来找人和校验（§6.3）
  relation: 老婆
  importance: high              # high：发给 TA 的内容要过 expert（§5.5）
```

auto 规则**只存在 `config/auto.yaml`** 里，people 里不再有 `auto` 字段。

### 2.3 Agent 用哪个身份对外说话

| 渠道 | 身份 | 说明 |
|---|---|---|
| 飞书 | **bot 身份** | agent 自己说话 |
| 飞书 | **user 身份**（lark-cli 的 user token） | **读**：轮询我所在的群（[§3.6](#36-飞书群以我的身份读按需让-bot-入驻)），属于 L0。**写**：以我的名义发消息、改文档、建日程，一律 L2 审批 |
| 微信 | **SStudioBot 专属号** | 口吻是"主人 的助理" |

---

## 3. 渠道接入面（Surface）与会话映射

一个会话 = 一个 SDK session = 一份独立的上下文。**会话之间不共享上下文**。owner 会话里可以用 `session_read` 查别的会话；这个工具从 `messages` 表读，不读 transcript。

### 3.1 飞书（工作 + 控制台）

| Surface | 用途 | 会话 key / lane | 会不会起 run |
|---|---|---|---|
| `feishu:dm` | 我和 agent 私聊，工作主线 | `feishu:dm:owner`（滚动） | 每条消息都会 |
| `feishu:workbench` | 我 + bot 的**话题群**，放长任务和项目 | `feishu:wb:<thread_id>` | 每条消息都会 |
| `feishu:console` | **管理群**「SStudioBot 管理」（私有普通群，2026-11-16 建）：审批卡片、告警、每日回顾、记忆 diff | 每张审批卡一个话题（普通群里对卡片"回复话题"，事件里 `root_id` = 卡片消息）；在话题里回复 = 修改意见 | 只处理审批相关的回复 |
| `feishu:feed` | T3 / lark-cli 推送专用群 | 不建会话 | **从不**起 run，只写入 `messages` 表，供查询和早报使用 |
| `feishu:group` | 我所在的群（user 身份轮询读取），以及 bot 被拉进的群 | 不直接建会话；@bot 时开 `feishu:g:<chat_id>[:<thread_id>]` | 群消息进 Triage；@bot 时起 run（[§3.6](#36-飞书群以我的身份读按需让-bot-入驻)） |

- **工作台**就是飞书版的 T3 thread。在私聊里接到大活时，主 agent 先 `task_start`，再到工作台开一个话题，进度和结果发在那里，私聊里只回一句"已开工 → 话题链接"。
- **管理群**集中所有"需要我决定的事"。
- bot 被拉进一个我不在的陌生群时，先保持安静，同时在管理群问我"要不要启用"。

### 3.2 微信（私人）

| Surface | 用途 | 会话 key / lane | 会不会起 run |
|---|---|---|---|
| `wechat:owner` | 我的主微信号 ↔ SStudioBot，私人主线 | `wechat:owner`（滚动） | 每条消息都会 |
| `wechat:dm` | 老婆、朋友和 SStudioBot 一对一 | `wechat:dm:<wxid>`（每人一个滚动会话） | 每条消息都会，按他人会话处理（[§4.1](02-roles-models.md#41-主-agentchat-档)、[§7.4](03-wechat-permissions.md#74-他人发起的请求简化后的工作量闸门)） |
| `wechat:group` | SStudioBot 被拉进的群 | 不直接建会话 | 由 Triage 决定；@SStudioBot 时开 `wechat:g:<id>` |

### 3.3 滚动会话的生命周期
- 空闲超过 N 小时（默认 4h），或者我发 `/new`，就开新 session。
- **滚动时的收尾由 Session Manager 负责**，不依赖 SessionEnd hook（那个 hook 只有 1.5 秒）：用 light 档基于旧会话的消息生成要点，写进 journal 和 `sessions.summary`。
- **压缩**：SDK 自动 compaction。`PostCompact` hook 能拿到 `compact_summary`，直接写进 journal（不额外调模型）。
- **重要的事随手记**：要长期保留的东西，在对话过程中就用 `memory_append` 写进 journal，不指望压缩或滚动时再补救。压缩和滚动都会丢细节。
- 飞书私聊和微信 owner 私聊是**两个会话**，但共享全部记忆。

### 3.4 飞书侧的其他可靠性
- **撤回**（`im.message.recalled_v1` / 微信能读到的撤回）：
  - 收件箱里还没处理的，标为 `dropped`。
  - 已经在处理的，按 `/stop` 中断。
  - 撤回的消息如果是某张审批卡的触发消息，把卡片作废（[§7.3](03-wechat-permissions.md#73-审批状态机)）。
- 日常回复是**流式卡片**（CardKit，2026-11-17 主人 要求提前到 M0，[§13.1](07-progress-milestones.md#131-m0-进度2026-11-17)）；命令回复和 `reply` 工具仍发普通消息。

### 3.5 群的开关（`config/groups.yaml`；管理群发 `/group` 用卡片切换）

| 维度 | 取值 | 默认 |
|---|---|---|
| `activation` | `always`：所有消息进 Triage，@ 时唤醒主 agent<br>`when_mentioned`：只处理 @<br>`digest`：只出定时摘要<br>`disabled`：完全不碰，连拉都不拉 | 飞书 `always`（免打扰群 `digest`）；微信 `always` |
| `reply` | `approve_all` / `s_auto`（他人请求按 [§7.4](03-wechat-permissions.md#74-他人发起的请求简化后的工作量闸门) 自动档处理） | `approve_all` |

（`audience` 维度后置。）

**默认 `always` 的缓解措施**：飞书群消息会送到第三方模型，所以加三道保护。
1. **敏感群默认 `disabled`**：群名匹配 `config/gate.yaml` 里的敏感词（默认：HR、人事、薪酬、绩效、财务、法务、董事会），以及我手动拉黑的群。黑名单优先级最高。
2. **外部群默认 `digest`**：带外部成员的群，看 `+chat-list` 每行的 `external`（布尔值，P0 已核实；我这边 614 个群里有 76 个外部群，单聊和话题群也有这个字段）。
3. **首次启用时过一遍群列表**：observer 第一次启动时，不直接开始读，而是先在管理群发一张群列表卡片，列出每个群建议的 activation，我确认后才开始。之后新加入的群按默认规则处理，同时在管理群发一条通知，可以一键改。

`groups.yaml` 是唯一的真相源，`chat_cursors` 表只存游标。

### 3.6 飞书群：以我的身份读，按需让 bot 入驻

| 群的类型 | 怎么读 | 怎么唤醒 | 怎么回复 |
|---|---|---|---|
| **观察群**：我在，bot 不在（默认） | user 身份轮询 | Triage。有人 **@我** 时一定 `notify` 或 `draft`；只 @ 了别人的最多 `notify`，只 @ 了机器人的 `archive`（[§4.3](02-roles-models.md#43-triagelight-档无工具)） | 只能以**我的身份**回，永远审批 |
| **入驻群**：我在，bot 也在 | @bot 事件实时收 + 轮询其余消息（按 message_id 去重） | @bot 时**立即拉一次这个群**补齐上下文，再开群会话；其余走 Triage | 以 bot 身份回，按 `reply` 开关 |

**私聊**（v0.13）：别人发给我的单聊默认不读；`config/sources.yaml` 里 `feishu.dm: true` 才读，只记事件、发提醒，**不起草**（[§17.3](09-rsi-matters-graph.md#173-信息源)）。我和 bot 的私聊是 owner 会话，永远不走这条路。（仅 bot 群后置。）

**feishu observer**
1. **每 30 秒（可配置）用一次全局搜索拉增量**：`+messages-search --as user --query "" --start <游标-2min> --end <now>`，跨所有群和单聊，按 `message_id` 去重。
   - 为什么不按群轮询（P0 实测）：我有 1000+ 个会话；`+chat-list --sort active_time` 只给顺序，**行里没有 `active_time` 字段**，没法判断"翻到哪为止"。
   - 搜索够用：和逐群 `+chat-messages-list` 对照，2 小时窗口 62 条只差 2 条 `system`（入群提示一类，本来就不要）；12 分钟实时对照，新消息搜索 12/12 都看到，基本同一轮出现，最慢晚一轮（29 秒）；一次约 3 秒，30 秒一轮跑 288 次调用没报错、没限流。
   - 搜索会把**话题里的回复也作为独立的行**返回，在话题里的消息带 `thread_id` 和 `thread_message_position`（不在话题里就没有这个键）。搜索的行没有 `mentions` / `reply_to`。Triage 需要 `mentions` 时，按 `chat_id` 打包后用 `+chat-messages-list` 补一次。注意 `chat-messages-list` 里话题回复**不是独立的行**，只嵌在根消息的 `thread_replies` 里。
   - 搜索必须同时给 `--start` 和 `--end`，只给 `--start` 会静默返回 0 行。
   - 群成员变动、群改名这类不是消息的动静，每天用 `+chat-list` 全量对一次。
2. **写入 `messages`（`triage_status=pending`），然后推进游标**。拉取和 Triage 解耦，Triage 崩了不会漏消息，也不会重复拉。游标回退 2 分钟做重叠，靠 `message_id` 去重。
3. **过滤回环**：
   - 我本人发的消息：不进 Triage。同时把这个群里 `trigger_msg_id` 早于它的待审批草稿**作废**，因为我已经亲自回了；这里早于它的「要你回 / 拍板」事件也一起算处理了（回复的是某条具体消息时，只关那一条对应的事件，[§17.2](09-rsi-matters-graph.md#172-事件账本)）。
   - bot 发的消息，以及 `outbox` 里记录过的消息 ID：直接标 `triage_status=skipped`。
4. Triage 定期取 `pending` 的消息，**按群打包**，一个群一批调一次 light 档，处理完标 `done`。
5. 第一次启用某个群时，只回填最近 N 天，不拉全部历史。
6. 话题回复（P0 实测）：全局搜索能看到，不用另外按话题拉。话题群里每条帖子都带 `thread_id`，不管有没有回复，所以不能拿 `thread_id` 判断"有回复"。

**事件长连接只能有一个消费者**：Mac 和 VPS 用的是同一个飞书应用。按飞书文档，长连接是集群模式、不广播，同一应用连了多个客户端时，每个事件只随机发给其中一个。所以 `event consume`（@bot 消息、卡片回调）只在 VPS 核心上跑，Mac 上不要跑。

**bot 事件（P0 实测，`im.message.receive_v1`）**
- bot 自己发的消息（文本、话题回复、卡片）**不会**回推事件，所以事件流本身不用做回环过滤；搜索那条路仍然要按 [§3.6](#36-飞书群以我的身份读按需让-bot-入驻) 第 3 步过滤。
- bot 在的群里，**不 @bot 的消息也会推过来**（话题里的回复也会），不只是 @。所以入驻群实际上可以全靠事件实时收，轮询只用来兜底，靠 `message_id` 去重。
- 事件字段：`chat_id`、`chat_type`、`message_id`、`message_type`、`sender_id`/`sender_type`、`create_time`；话题回复多了 `thread_id`（omt_）、`root_id`、`reply_to`（都指向根消息）；@ 消息带 `mentions`。

**user token 的托管**
- VPS 上**单独做一次 `lark-cli auth login`**，不要从 Mac 拷贝 token 文件，避免 refresh token 互相挤掉。
- lark-cli 和 token 只属于 `sbot` 用户，worker 用户读不到（[§7.6](03-wechat-permissions.md#76-隔离与凭证)）。
- P0 实测：VPS（10-30 授权）和 Mac（10-10 授权）的授权并存，互不挤掉。access token 2 小时，refresh token 7 天、每次刷新顺延，所以核心至少每周要用一次 user 身份（轮询本身就满足）。现在 VPS 上的授权在 `dev` 用户下（`~/.lark-cli`，lark-cli 1.0.98），M0 时以 `sbot` 身份重新登录一次。
- Sentinel 每轮检查 `auth status`：一旦失败或快过期，就在管理群发一张"需要重新授权"的卡片。

> 导航：[设计文档索引](../DESIGN.md) · [上一篇：第一性原理](00-principles.md) · [下一篇：角色与 harness、模型层](02-roles-models.md)
