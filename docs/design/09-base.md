## 底1 运行模型：五件套

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
| **收件箱** | 所有触发 run 的东西，持久化，是唯一的真相源 | `inbox` 表（§底1.2） |
| **定时器** | 周期任务（schedule）+ agent 给自己设的 follow-up；到点**不直接跑**，而是往收件箱里投一条事件 | `timers` 表（§底4） |
| **记忆** | 只存查不回来的东西 | `agent-home` git 仓库（§读1） |
| **权限** | 我们的工具：直接执行 / 拦截 / 提交审批；节点 agent 按自己的权限设置跑，来问转看一眼卡；SStudioBot 的密钥不进 agent 环境 | 代码里的闸门 + 看一眼卡 + LLM 代理 + 主用单独账号（§底3、§办3.3） |
| **发件箱** | 所有对外消息先落库再投递；出口幂等 | `outbox` 表（§底3.3） |

### 底1.1 总体拓扑（2026-11-26 改成主 + 节点，§办3）

```
              ┌────────── 主（同一时间一台；Linux / Mac / Windows 都行）──────────────────┐
 飞书 ◄─长连接┤ 核心进程（单独账号）：inbox ─► Dispatcher ─► run（主 agent / Triage / expert，pi）│
 飞书 ◄─轮询──┤ Scheduler · Sentinel · Gate + Approvals + 看一眼卡 ─► 管理群卡片             │
              │ Outbox ─► 飞书 / 微信 · Task Engine · 控制台 API                              │
              │ LLM 代理（SStudioBot 的 key 只在这里）· SQLite · config · agent-home          │
              └──────────────▲──────────────────────────▲──────────────────────▲──────────┘
                             │ 节点主动连主（tailnet；设备密钥配对，新节点默认关）│
       ┌─────────────────────┴────────┐   ┌────────────┴─────────────┐   ┌────┴───────────────────┐
       │ 节点：主所在那台               │   │ 节点：Mac 和别的机器        │   │ 节点：Windows 微信机      │
       │ Claude Code/Codex/pi/ACP     │   │ Claude Code/Codex/pi/ACP    │   │ 微信 4.0.x（专属号）      │
       │ 对话里的命令（§办1.2）          │   │ 本机登录 · 备份副本          │   │ wechat-reader / sender   │
       └──────────────────────────────┘   └──────────────────────────┘   └────────────────────────┘
```

- **为什么主和节点分开**：主只管状态和规则，数据只有一份。干活要的本机资源（登录、订阅、微信客户端、重构建）在各台节点。节点**主动**连主，主不连节点。
- **现在线上**：主在一台 Linux VPS，它自己也是节点；Mac、Windows 微信机连上来。迁完之前，worker 仍是 SDK（§办1.3.1），Windows 仍走旧的 bridge（§触3）。
- **技术栈**：
  - 核心和节点程序用 TypeScript（Node）；核心单进程加 SQLite。
  - 微信那部分用 Python，和主之间走 JSON over WebSocket。

### 底1.2 收件箱与 run 的语义

- **先落库再确认**：渠道 handler 只做"写入 inbox，再 ack"，越快越好。是否可信、有没有注入，这些判断放到 run 里去做。
- **去重**：`UNIQUE(source, source_msg_id)`，用渠道给的消息 ID。定时器事件用 `timer_id:due_at` 作为 ID。
- **lane**：每个会话（session key）或每个任务（task id）是一条 lane。**一条 lane 同一时刻只有一个 run**，不同 lane 之间可以并发，不设全局上限（§办3.4）。
- **合批**：开始一个 run 时，把这条 lane 上所有 `received` 的事件一起取出（有上限），合成一轮输入。我连发三条只会得到一个回复。
- **run 进行中来了新事件**：我的消息能插就插（pi `steer`，2026-11-26 起不再后置）；插不进的和其他事件排队，等下一个 run。我发 `/stop` 时停这一轮（pi `abort`；节点任务见 §办3.4）。
- **进程模型**：对话角色在核心进程里用 pi 跑；任务是节点上一个 agent 的 session（§办3.2）。lens 和迁完之前的 worker 是一次 `query()`，起一个 CLI 子进程。
- **状态**：`received → processing → done | failed | dropped`。核心进程重启后：
  - `processing` 的 run，如果**没有记录到任何副作用**（没进发件箱、没提交审批、没开任务），就回到 `received` 自动重试。
  - 有副作用的标为 `interrupted`，并在这条 lane 里告诉我"上一轮做到 X 时被中断了，要继续吗"。**不自动重跑有副作用的 run。**
  - 副作用由工具层在 `runs.side_effects` 里计数。
  - **崩溃熔断**：同一条输入让核心连着崩两次，就不再重试，标 `failed` 并告诉我。为了让主能起来，不算限制。
- **resume 失败的兜底**：比如 transcript 已被清理。这时开一个新 session，带上 `sessions.summary` 和最近 K 条消息，接着处理。
- **回复跟着输入走**：每个 run 带一个 `TurnContext`（来源渠道、chat、话题、消息 ID）。`reply` 投递到这个 run 的输入来源，不去猜"最近一条消息"。

### 底1.3 部署：主 + 节点，轻量（2026-11-26 改；原来单机，2026-11-16 定）

**现在**：主在一台 VPS（4 核 / 6.7G 内存，已装好 tailscale），它也是一个节点。主可以换到 Mac 或 Windows（§办3.1）。

原来不做远程 worker，理由是闸门回调要跨机器、worker 要打隧道访问 LLM 代理、掉线要续跑、代码副本要同步。交给节点上现成的 agent 以后这些大都没了：权限由 agent 自己管，来问转看一眼卡；agent 用本机登录；掉线按 §办3.4；代码就在节点本地。PR #15 的 ssh 派活不再用。

**怎么轻**
- **对话角色不起子进程**：用 pi 时在核心进程里跑。实测一个 Claude Code CLI 子进程常驻 230～320 MB，每条消息都起一个会很重。
- **节点上的 agent**：同时几个不设上限，我可以按机器设（§办3.4）。主和节点在同一台时，核心设 `OOMScoreAdjust=-500`，内存紧时先杀干活的、不杀主（让主活着，不算限制）。不设 `RuntimeMaxSec`；迁完之前的 SDK worker 还在 systemd unit 里（§办1.3.1）。
- **重构建派给 Mac 节点**：比如 gradle，单次就要 2～4 GB；或者提 PR 让 CI 跑。
- **控制台**：`tailscale serve`，加一个公网 443 入口（和机器上已有的 nginx 共用，密码 + 会话 cookie，§触5.1）。
- **目标**：空闲约 300 MB（核心约 150～250 MB）；2 个对话 run 加 1 个 worker 构建时，峰值 ≤ 2.3 GB。

**放在哪**（全部在 4T 数据盘 `/srv/data`，xfs）

| 路径 | 内容 | 属主 |
|---|---|---|
| `/opt/node` → `/opt/node-v26.13.1` | 官方 Node LTS，自带 TS 类型擦除。只给 sbot 用，系统自带的 nodejs 不动（它编译时没带 TS） | root |
| `/srv/data/sbot-app` | 代码：`releases/<sha>/core`、`deps/<hash>/node_modules`、`current` → 正在跑的 release（见下面“上线”） | `root:sbot` 0750，不在核心服务的可写路径里 |
| `/srv/sbot` → `/srv/data/sbot` | `db/` SQLite（WAL）、`config/`（git）、`agent-home/`（git，wiki 层）、`sessions/`、`logs/`、`cache/raw/`、`backup-staging/`、`secrets.env`（0600） | `sbot` 0700 |
| `/srv/sbot-w` → `/srv/data/sbot-w` | `tasks/<id>/` | `sbot-w` 0750（`sbot` 在 `sbot-w` 组里，能读 worker 产出；反过来不行） |
| rustfs `sbot-raw` 桶 | 原始资料，按 sha256 存，只增不改（§读1.5） | 核心 |
| rustfs `sbot-backup` 桶 | 每晚的 SQLite 快照（`.backup`）+ `config`、`agent-home` 的 git bundle | 核心 |

- **数据盘的 SQLite 延迟够用**（实测）：
  - WAL + `synchronous=NORMAL` 时，单次提交 0.01 ms。
  - `FULL` 时 p50 0.7 ms、p95 2.8 ms。
  - 4K fsync 的 p50 是 0.7 ms，顺序写 122 MB/s。
  - 所以 SQLite 不需要放在系统盘。
- **S3 里只放不可变的文件和备份**：SQLite 和 git 仓库不能直接放进 S3。
- **rustfs 凭证**：用 rustfs 的 IAM 给 sbot 单独建一个只能访问这两个桶的 key，放进 `secrets.env`，不用管理员 key（M0 做）。
- **异地副本**：`sbot-backup` 和数据在同一块盘上，只防误删，不防坏盘。现在 Mac 经 `deploy/backup-mac` 拉一份（2026-11-17 起，校验 sha256 和完整性）。以后任何节点都能存一份，经节点连接传，默认 Mac；不用第三方存储（§办3.1）。
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
- 这套自动上线是 Linux 主上的可选件。主在 Mac 或 Windows 上时手动更新（§办3.1）。

### 底1.4 什么是核心，什么是插件
**事（matter，§读3.1）是组织记录的轴，不是目的**（v0.24 改，原文是"人来找它，最后都是为了一件事"）。目的是 §0：陪我修自己、离苦得乐；办事是基本功，也是读懂我最真实的窗口。消息、审批、任务、看法、复盘都往一件事上挂，回头顺着一件事就能看到它从哪来、走到哪了、我在里面做了什么。生活里没起成事的部分，照样在时间线（§读5.3）和因缘（§读4）里。

| 核心（每个人都一样，写在代码里） | 插件 / 配置（每个人不同） |
|---|---|
| 事和事件账本、自动关、话头串联（§读2.5） | 读哪些地方：`config/sources.yaml` 和 `/opt/sbot/plugins/sources/*`（§读2.1） |
| 闸门、审批、发件箱（§底3），信息源永远只读 | 从哪迁过来：导入材料和任何 harness 的总结（§读2.6） |
| 两圈 RSI：我的（§进1）和它的（§进2） | 用什么镜头看：`/opt/sbot/plugins/sbot-lens`（§参1） |
| 时间线、复盘、前瞻的节律 | 风格笔记、范例库、tuning（§进2 A / B 级，越用越贴） |

加一个新的信息来源（jira、别家的邮箱、某个网页、以后的微信），不改核心：写一个插件、在 sources.yaml 里加一行。插件只往里送事实，进来的东西和群消息走同一条路：分拣 → 事件 → 挂到事上。例外是必须用核心自己飞书登录的来源：插件永远拿不到这份登录，所以飞书邮箱内置在核心里（§读2.1）。

### 底1.5 seed 怎么到线上（v0.25）

`core/seed/agent-home/` 是新实例的起点，也会跟着设计改（比如 v0.24 改了 SOUL、AGENTS、复盘方法）。原来只在文件缺失时复制，改过的 seed 到不了已经在跑的实例。现在核心每次启动都比一遍，规则只有一条：**线上的文件只要被谁动过，就不覆盖。**

- **怎么知道没被动过**：装进去时记下这份文件的 git blob hash（kv `seed.state`）。线上文件的 hash 还是它，说明我、dream、改进提案、回滚都没碰过。
- **三类文件**：

  | 文件 | 有新 seed、线上没动过 | 线上动过 |
  |---|---|---|
  | `USER.md`、`MEMORY.md` | 不同步：装一次以后就是实例自己的笔记 | 不同步 |
  | 它自己的规则：`AGENTS.md`、`SOUL.md`、`VOICE.md`、`skills/`、`tuning/` | 等我点头：管理群报一句，我回「更新 seed」才换；「更新 seed agents review」只换点名的几份 | 报「有更新待合」，不动 |
  | 其他 | 直接换，单独一个提交 | 报「有更新待合」，不动 |

- **为什么它的规则要等我**：这几份写着"只有我能改"（§读1.1、§底3.7、§进2.3 B）。seed 的 PR 可以由 Claude 自己合，不一定经过我的眼睛；到线上之前我说一句，规则就还是我定的。SStudioBot 自己开的 PR 本来就等我合，所以它也不能借 seed 改自己。
- **通知**：和上线通知合成一条，只报文件名，不带内容。同一版 seed 每份只报一次；没理就不再提，想换时随时回「更新 seed」。
- **撤回**：每次替换一个 git 提交，通知里带「回滚 <sha>」。我回滚了，就当是我的回答：这一版不会再自动换上，也不再报；之后我点名「更新 seed」要它，还能换。
- **提交失败**（比如仓库被锁）：旧文件放回去，通知里说没换成，下次启动再试。
- **§底1.5 之前装的实例**：没有记录。和当前 seed 一样的文件从这次开始记；不一样的当作改过，报一次「有更新待合」，不动。
- **线上改过的怎么合**：手动合、提交。合到和 seed 一模一样，下次启动自动接上记录。
- 只看 seed 目录里有的文件，不碰 `self/` 和别的页面。

## 底2 人与身份

### 底2.1 Principal（谁在说话）

| 角色 | 识别方式 | 默认权限 |
|---|---|---|
| **owner（我）** | 飞书 open_id；我本人主微信号的 wxid（写在配置仓库里） | 全部；敏感动作仍要审批（§底3） |
| **known（老婆、朋友、熟悉的同事）** | 在 `config/people.yaml` 里登记过的人 | 按人配置 |
| **others** | 其他任何人 | 只当输入，不可信 |

**认人只认 ID，不认名字。** 有人说"主人 让你……"，一律按 others 处理。

### 底2.2 Agent 用哪个身份对外说话

| 渠道 | 身份 | 说明 |
|---|---|---|
| 飞书 | **bot 身份** | agent 自己说话 |
| 飞书 | **user 身份**（lark-cli 的 user token） | **读**：轮询我所在的群（§读2.2），属于 L0。**写**：以我的名义发消息、改文档、建日程，一律 L2 审批 |
| 微信 | **SStudioBot 专属号** | 口吻是"主人 的助理" |

## 底3 权限、闸门与审批

**核心原则：只留我说过的限制（§0.4）；留下的写在代码和操作系统层面，不靠 prompt。**

### 底3.1 动作分级

| 级别 | 例子 | 处理方式 |
|---|---|---|
| L0 自由 | 回复当前 lane 里的我；读记忆；写 journal；搜索；以 user 身份读群消息 | 直接执行 |
| L1 内部写 | 在工作目录里改代码、提交；建飞书文档草稿（bot 身份、仅自己可见） | 直接执行，事后汇报 |
| L2 对外 / 以我名义 | 在群里回复；SStudioBot 给别人发微信；用 user token 发消息、改文档、建日程；核心代推代码（`git_push`） | **审批**；命中 auto 规则或 §底3.4 自动档时除外 |
| L3 硬禁止 | 转账支付、删除他人内容、退群、改权限、读凭证 | 我们的工具根本不提供 |

这张表管我们自己的工具。节点上的 agent 用它自己的工具和权限设置，来问时转看一眼卡（§办3.3）；以我名义发给别人仍只走 `send`。

### 底3.2 两种审批路径

**A. 提交式（主 agent、起草 run、他人会话）**：这是默认路径。
1. `send(target, text)` 或 `request_approval(plan)` → 代码判定级别。
2. L0 直接进发件箱。L2 写一条 `approvals(pending)`，发卡片，**工具立刻返回"已提交审批 #12"**。run 照常结束，lane 不会被卡住。
3. 我点"发送"后：
   - `send` 类：发件箱**原样发出批准时的那个草稿版本**，不经过模型。
   - `plan` 类：往原 lane 投一条 `approval` 事件，起一个新 run，带上批准的计划和新预算去执行。

**B. 挂起式（迁完之前的 SDK worker 运行到一半需要做 L2 动作）**
1. worker 调用 `git_push` 一类工具 → PreToolUse 返回 `defer` → run 以 `tool_deferred` 结束，任务进入 `waiting_approval`，发卡片。
2. 等待期间不占用任何进程，其他 lane 照常运行。
3. 我做出决定后，**不带 prompt** 地 resume 这个 session。同一个工具调用会再次触发 PreToolUse：
   - **批准**：**核心自己执行这个动作**（比如从 worker 的 worktree fetch 再 push），hook 返回 deny，reason 里写"审批 #N 已批准，核心已代为执行，结果：…，不要再调用"。模型据此汇报完成。
   - **拒绝**：hook 返回 deny，附上我的意见。
   - 为什么批准时不返回 allow 让 CLI 去跑工具：P0 实测（`probes/worker-isolation.ts` W3）resume 时 CLI 总是报 `Deferred tool resume: tool 'mcp__sbot__…' is no longer available`（in-process MCP 还没连上），之后 allow 的调用约 15～25% 会变成"用户拒绝了这个操作"，**跟 sudo 无关**（不套包装脚本也一样），`MCP_CONNECTION_NONBLOCKING=false` 也没用。核心代执行 + deny 带结果：10/10 正常，动作也只执行一次（执行权本来就在核心，§办1.3）。
4. 审批过期，按 deny 处理。

**C. 看一眼（节点 agent，§办3.3）**：agent 的权限请求、`ask`、派到别的机器的通知都发看一眼卡。前两种是任务的等待点，答案原样回到同一个 session，不占进程；通知不等我点。

### 底3.3 审批状态机

```
pending ──批准──► approved ──► 发件箱：sending ──► sent | failed | unknown
   ├──拒绝──► rejected
   ├──超时──► expired
   ├──同一触发有了新草稿──► superseded（superseded_by 指向新卡）
   └──我已亲自回复 / 触发消息被撤回──► invalidated
```

- **只认我本人点**：卡片回调里校验操作人的 open_id 等于 owner，别人点了没用（P0 实测：lark-cli 给的字段是 `operator_id`）。
- **防重复和防过期点击**：
  - 按钮里带 `approval_id` 和 `draft_version`，处理时在事务里检查状态和版本，过期的版本点了不生效。
  - **第一次点击为准，收到后立刻改卡**（去掉按钮、标"已批准/已拒绝 · 处理中"）。P0 实测：卡片没变化时我 36 秒里连点了 4 次（批准、批准、拒绝、批准），来了 4 个事件，`event_id` 和 token 各不相同。改卡用这次回调的 token 调延迟更新接口（token 30 分钟内有效、最多用 2 次：一次"处理中"，一次最终结果）。按 `event_id` 去重。
  - 卡片在话题里被"改一下"之后，`draft_version` 加一，并原地更新卡片。
- **作废**：observer 看到我在同一个 chat 里、晚于 `trigger_msg_id` 发过言（§读2.2），就把对应卡片作废并更新显示。
- **发件箱幂等**：`outbox` 对 `approval_id` 加唯一约束，一个审批最多发一次。
- **发送时限**：每条都有 `send_by`（聊天回复默认 2 小时）。批准了但到期还没发出去（比如 Windows 离线），就作废，并在卡片上标注。
- **结果不确定时不重试**：微信 UI 自动化发完不一定知道成没成功，这时标为 `unknown`，等 reader 确认（§触3.2）。确认不了就告警由我处理，**绝不自动重发**。
- **卡片内容**：渠道、发给谁、用谁的身份、草稿原文、触发来源、引用了哪些记忆、expert 意见、承诺检测结果。按钮：发送 / 拒绝 /（M5 起）以后这类自动。

### 底3.4 他人发起的请求

**适用范围**：会话的发起人不是 owner，包括 `wechat:dm`、群里 @、Triage 起草。

只分两档：

| 档 | 条件（必须全部满足） | 处理 |
|---|---|---|
| **自动** | ① 这个 surface 允许自动（`wechat:dm` 的 known 人默认允许；群按 `reply: s_auto`）<br>② **承诺检测通过** | 直接回复 |
| **审批** | 任何一条不满足 | 卡片 |

- 原来的数字上限（`maxTurns ≤ 6`、工具调用 ≤ 4 次、他人请求共用日预算）2026-11-26 去掉（我定，§办3.5 限4）。他人会话的工具范围（§办1.2）不变。
- **承诺检测**：自动发出前，代码用 light 档对草稿做一次结构化判断：有没有替我答应时间、金钱或事情，有没有代表我表态，有没有泄露 `shared/` 以外的私人信息。只要命中一项就转审批，卡片上显示命中原因。
- **稳住对方**：转审批时，对方会收到一句**固定模板**（可在 `gate.yaml` 配置，不由模型生成），比如"收到～这个我得先跟 主人 确认一下"。审批超时也发固定模板。

### 底3.5 Auto 规则（M5，粒度：人 × 动作）
- 只能由我在卡片上点"以后这类自动"生成，agent 没有任何写入途径。存在 `config/auto.yaml`（唯一真相源）。
  ```yaml
  - who: wife
    action: wechat.reply      # 对老婆的回复：承诺检测命中也自动发
  ```
- 每周在管理群发一份"这周自动执行了什么"。

### 底3.6 隔离与凭证

| 东西 | 属主 / 权限 | 谁能碰 |
|---|---|---|
| 核心代码、SQLite、`secrets.env`、lark-cli 和 token、git push 凭证 | `sbot`，0700 / 0600 | 只有核心进程 |
| `/srv/sbot/config`（配置仓库：models / people / groups / gate / auto / jobs / self） | `sbot`，0700 | 我（直接改 / 控制台 / 卡片）；**任何 agent 都不能写**，agent 想改只能提 proposal |
| `/srv/sbot/agent-home`（记忆仓库） | `sbot` | 只能通过核心的记忆工具读写（代码校验路径），worker 读不到原文件 |
| `/srv/sbot-w/tasks/*` | `sbot-w` | sandbox worker |
| `/srv/data/sbot-h/{home,tasks}` | `sbot-h`（有完整 sudo） | host worker；核心在 `sbot-h` 组里，能读任务目录（推送时要 fetch） |
| `/srv/data/sbot-shared`（skill 插件、`ssh_config`） | `sbot`，0755 | 核心写；两种 worker 都只读。不放密钥 |

- **节点 agent**（§办3）：用节点自己的账号和登录（限6），SStudioBot 的密钥不给。主用单独账号跑，节点 agent 读不到主的 `secrets.env`；主和节点在同一台时，节点程序也不用主的账号。
- **host worker 的边界**（v0.14）：网络和文件系统都没有隔离，sudo 也是完整的。还剩下的约束：
  - 没有 SStudioBot 的凭证：不给核心的 lark-cli 和推送凭证；它自己登录的 CLI 算它自己的（限6）；
  - 以我名义发给别人只走核心工具和审批；
  - 核心守卫 + worker 规则，让它不去碰核心的文件；
  - 每个 run 一个 unit（时长上限按 §办3.4 去掉）。
  - **残余风险**：有 sudo，核心守卫就只是软边界，挡不住有意为之。被注入的指令可以读 `secrets.env`、登录 `ssh_hosts` 里的机器、在 tailnet 里横向移动。所以碰到不可信内容先问我，我说进沙箱就用 sandbox（§办3.3）；主换到单独账号也挡不住有 sudo 的它。
- **sandbox worker 的网络**分两层（P0 已验证，`deploy/worker/netfilter.sh` + `probes/worker-isolation.ts`）：
  - **iptables，按 owner 匹配 `sbot-w`**（链 `SBOT_W`，只插 OUTPUT 第一条，不碰 ufw 和 docker 的链；`sbot-netfilter.service` 开机加载）：
    - 只放行 `127.0.0.1:7811`（LLM 代理）和 `127.0.0.1:7820-7829`（核心的出网代理）。
    - 其余一律拒绝：本机所有地址（`addrtype LOCAL`，包括公网 IP 和 `::1`）、tailnet、私网和 docker 网段、云元数据，**以及公网和 DNS**（2026-11-17 收紧，`SBOT_W_PUBLIC=allow` 可退回）。这一层管住的是 CLI 进程本身。
    - 为什么能关掉公网：CLI 进程本身不需要直连。模型调用走 LLM 代理；WebSearch 是服务端工具，也在代理后面；WebFetch 用 `settings.env.HTTPS_PROXY` 指到核心出网代理（sudo 会删掉 `HTTPS_PROXY` 环境变量，所以走 settings），同时 `skipWebFetchPreflight: true`。P0 实测：不关的话 WebFetch 由 CLI 直连目标网站，还会**另外直连 api.anthropic.com 做域名检查**（关了非必要流量也照样发），两条都绕过白名单。DNS 也关，因为向本机 DNS 发的查询本身就能外传数据。
    - 每个 worker run 固定传 `settings: { skipWebFetchPreflight: true, env: { HTTPS_PROXY: "http://127.0.0.1:<该 worker 的出网代理端口>", NO_PROXY: "127.0.0.1,localhost" } }`。
  - **sandbox 里的命令**（bash 等）没有直连网络，只能走 `sandbox.network.httpProxyPort` 指向的**核心出网代理**。这个代理跑在 `sbot` 下，按任务的域名白名单放行 CONNECT（只接 443），并且自己拒绝解析到非公网地址的域名（它不在 `SBOT_W` 链的约束里）。
    - 为什么不用 CLI 自带的代理：它监听随机的回环端口，`SBOT_W` 把它挡住了，结果所有请求都是 `Proxy CONNECT aborted`。自带代理也只看客户端给的域名，换成我们自己的反而能记日志、按任务配白名单。
  - 残余风险：允许的域名可以被用来外传（domain fronting），所以白名单按任务给、默认空；给 worker 的上下文只放任务需要的东西。
- **worker 的内存**：每个 worker 一个 systemd scope，`MemoryMax=1G`、`MemorySwapMax=256M`、`TasksMax=256`、`OOMPolicy=continue`。CLI 的 `oom_score_adj` 是 -900，sandbox 里的命令经 `/usr/local/lib/sbot/bin/bwrap` 垫片设成 +800。实测 1.5G 的分配只杀掉那个命令，CLI 正常收尾。
- **Ubuntu 的 AppArmor**：系统自带的 `bwrap-userns-restrict` 不允许 bwrap 里再建 user namespace，而 Claude Code 的 `apply-seccomp` 需要它，报错 `write /proc/self/setgroups … Permission denied`。处理办法：停用这个 profile，换成官方文档给的 `bwrap` profile（`flags=(unconfined) { userns, }`）。这会让本机所有用户的 bwrap 都能建 userns，在这台机器上可以接受。
- **控制台**：两个 unix socket。`/run/sbot/console.sock`（目录 700，属主 `sbot`）由 `tailscale serve --https=8444` 代理进来（P0 已验证），校验 `Tailscale-User-Login`；`/run/sbot-web/console.sock`（目录 2750 `sbot:sbot-web`，只有 nginx 的 www-data 在组里）由公网 nginx 代理进来，只认密码登录后的会话 cookie（§触5.1）。
- **主 agent / Triage / expert** 跑在核心进程里（`sbot` 用户）。Triage 和 expert 没有 shell，也没有读写文件的工具，只能调用我们的工具，这些工具在核心代码里做了校验。主 agent 在我发的消息触发的 run 里能跑命令、改文件，经本机节点以节点账号（服务器上是 `sbot-h`）执行，不在 `sbot` 下（§办1.2）。

### 底3.7 和闸门、记忆的边界
- 前瞻、镜头结论、互参记录（`crosschecks`）、习气和节律、身体档案（`body_entries`）、复盘内容都**不参与任何闸门判断**，不影响审批、承诺检测和自动回复，也不出现在他人会话里。以我的名义发消息仍走审批卡片，不因为 §读5.1 的放开而改变。
- 给重要的人发消息走审批卡时，若草稿明显和对方最近原话不在一个频道，可以在卡片旁顺手附一句「对方最近原话对照」（§读6），但这只是给我的只读参考，不改审批分级、不阻断也不放宽。
- journal 来源加四种：`src=lens`、`src=crosscheck`、`src=review`、`src=outlook`，dream 怎么处理见 §读1.3。
- 改进只发生在心得文件里（§进1），以及我认可过的习气和节律。agent 的人设、规则和陪伴方法的 skill，照旧只有我能改。

## 底4 定时器

### 底4.1 两种定时器，一张表

| 类型 | 谁创建 | 例子 |
|---|---|---|
| **schedule**（周期） | 定义在 `config/jobs.yaml`（只有我能改），启动或热加载时同步进 `timers` 表 | 07:50 今日一卦（§参1）；08:15 事的整理（§读3.2，卡片跟 08:30 早报发）；08:30 早报（含今日一卦和今日留意）和记忆 diff；21:30 日复盘；22:00 微信群摘要；周日 20:30 周复盘 + 下周前瞻；1 号 20:00 月复盘 + 本月前瞻；03:00 dream。都在 22:30 夜间开始前（§触1.1） |
| **follow-up**（一次性） | 主 agent 在 owner 会话里调用 `followup_set({ at \| in, note })` | "周三下午看看对方回没回""下周一提醒我跟进 X" |

- **Scheduler 每 30 秒轮询一次**。对每个到期的定时器：往它的 lane 投一条 `timer` 事件（去重 ID 是 `timer_id:due_at`），然后把 follow-up 标为 done，或者把 schedule 推进到下一次。**定时器自己从不直接起 run。**
- 停机期间错过的 schedule 不补跑，记为 `missed`。上一次还在跑时，这一次记为 `skipped`。
- run 结束时**可以什么都不发**，这本身就是正常结果，所以不再需要单独的 `quiet` 选项。
- `jobs.yaml` 只放定义，`timers` 表只放运行状态（下次到期时间、上次运行时间），二者不重复。
- 任务写 `enabled: false` 就暂停：不再触发，和删掉一样，但设置留在文件里，随时能打开（控制台的开关，§触5.6）。
- **检查脚本**（2026-11-26）：schedule 可以挂一个 `check`。到点先在主所在的节点上跑它，它说没事就不叫模型，记 `skipped_by_check`；有事就把它的输出带进这次 run。不设时长和输出上限。

### 底4.2 Sentinel（代替 heartbeat，纯代码、不调模型）
- 每 5 分钟巡检一次：
  - 审批过期
  - 久没动静的 run 或任务：只显示、进"需要你处理"，不强停（§办3.4）
  - 节点和微信是否在线
  - lark-cli user token 是否健康
  - LLM 代理的错误率
  - 预算告警线（只告警，§办2.2）
- 有问题就直接往发件箱写一条管理群告警，模板是固定的。
- `HEARTBEAT.md` 删掉。主动性来自两处：agent 自己设的 follow-up，以及早报这个 schedule。

### 底4.3 定时任务遇到上游错误

定时触发的活没人在等，可以等上游恢复。适用于定时事件（早报、复盘、到点提醒、事收复盘、镜头结果进会话）和调模型的代码任务（dream、每日整理的模型部分、月度镜头）。我自己发的消息出错时行为不变。

| 错误 | 判定 | 下一次 |
|---|---|---|
| 暂时的 | 429、500/502/503/504/529、过载、网络错误 | 退避 2、5、10、20、30、30… 分钟 |
| 用量上限 | 报错说 weekly / usage limit、额度用完之类 | 报了恢复时间就排在恢复后 2 分钟；没报每 30 分钟看一次 |
| 不重试 | 鉴权（含 run 令牌无效）、请求本身有问题 | 按原来的失败处理 |

- **截止时间**：原定时间后 2 小时（`jobs.yaml` 里 `retry_hours` 可改；月度镜头 12 小时，要赶在当晚月复盘前），并且不晚于下一轮同名任务前 10 分钟。截止时刻再试最后一次，这样我临时配了备用模型或加了额度还来得及；恢复时间在截止之后的，中间不再空打。
- **放弃**：管理群一条消息，每次放弃只发一条，不补跑，也不去私聊打扰我。`job.<名字>.last` 记 `gave_up`。
- **只重跑干净的失败**：这一次没出过字、没发过消息、只用过只读工具才重跑；否则重跑可能重复发话或重复写入，按原来的失败处理。所以定时 run 不发「思考中」卡片，有字了才起卡。
- **失败的这一次不留痕**：会话文件退回到这次之前，否则每重试一次，事件全文就在上下文里多一份。滚动会话的摘要跟着事件带到下一次。
- 重试状态在 `inbox.not_before` 和 `payload.retry`（代码任务在 `kv` 的 `job.<名字>.retry`），重启不丢。排着队的事件不挡我的消息。

## 底5 数据模型（SQLite，草案）

```sql
messages(id, surface, chat_id, thread_id, sender_id, sender_kind, ts, text, media_ref, raw_json,
         triage_status, triage_action, triage_note, event_id, attn, wait_until)
                                                           -- + FTS5；triage_status: pending|done|skipped
                                                           -- attn（§读2.4）: waiting|answered|read|held，NULL = 不在等
sessions(key, harness, session_ref, generation, surface, tier, model, status, last_active, summary)
                                                           -- harness: sdk|pi；generation：滚动或换模型后 +1
chat_cursors(chat_id, surface, last_msg_ts, last_msg_id, updated_at)
inbox(id, lane, kind, source, source_msg_id, turn_ctx_json, payload_json, status, run_id, ts, not_before NULL,
      UNIQUE(source, source_msg_id))
      -- kind: user|timer|task_done|approval|system；status: received|processing|done|interrupted|failed|dropped
      -- not_before：定时事件等上游恢复时，这个时间之前不取（§底4.3）
runs(id, lane, session_key, sdk_session_id, role, tier, run_token_hash, status, stop_reason,
     side_effects, started, ended)
tasks(id, parent_lane, goal, status, tier, node, agent, workdir, budget, session_ref, attempt,
      last_output_at, started, ended, result_json, card_msg_id)
      -- status: queued|running|waiting|waiting_node|interrupted|done|failed|cancelled
      -- waiting：等我（问你 / 看一眼，§办3.3）；waiting_node：等这台机器（§办3.4）
      -- 迁完之前的 SDK worker 还用 waiting_approval|needs_input，照认
      -- 节点回传带 attempt，小于当前值的直接丢
approvals(id, kind, origin_lane, run_id, requester_id, action, channel, target, as_identity,
          draft, draft_version, refs_json, checks_json, expert_json, trigger_msg_id,
          deferred_tool_json, status, superseded_by, expires_at, decided_by, decided_at,
          card_msg_id, card_thread_id)
      -- kind: send|plan|deferred_tool|glance|ask（glance = agent 的权限请求和通知，ask = agent 问我）
      -- status: pending|approved|rejected|expired|superseded|invalidated
outbox(id, approval_id UNIQUE NULL, lane, channel, target, payload, status, attempts,
       send_by, sent_msg_id, ts)                           -- status: queued|sending|sent|failed|unknown|expired
timers(id, kind, lane, cron NULL, due_at, payload_json, status, created_by, last_fired)
expert_calls(id, ts, trigger, input_ref, verdict_json, cost)
nodes(id, name, os, pubkey, enabled, agents_json, max_parallel NULL, last_seen, status, extra_json)
      -- §办3.1；enabled 默认 0，我确认才开；max_parallel NULL = 不限
      -- 原 edge_nodes 并入：微信机的 wechat_version、logged_in 放 extra_json
usage(ts, run_id, task_id, tier, endpoint, requester_id, input_tokens, output_tokens, cost)
config_changes(id, ts, file, diff, source)                 -- source: console|chat|card|command|upgrade|proposal|manual
proposals(id, ts, origin_lane, target_file, patch, reason, status,
          tier, hypothesis, evidence_ids, eval_json, version, review_at, rollback_of)
      -- v0.10：tier: A|B|C；status: pending|approved|rejected|expired|live|rolled_back（§进2）

-- v0.8：事上修（原 §15）
matters(id, title, domain, lane, status, opened_at, close_condition, closed_at, reviewed_at, file_path, keys, parent_id, merged_into)
  -- status 多一个 merged 和 paused（先搁着，§寸5）；parent_id 指向主线（只一层），merged_into 指向合并后留下的事（§读3.1）
matter_ops(id, ts, kind, summary, why, by, review_id, touches, undo_json, undone_at, undone_by)   -- 事的每次改动和撤销它需要的东西
matter_reviews(id, fp, kind, prio, why, data_json, origin, status, shown_n, last_shown, snooze_until, created_at, decided_at, decided_by, action, op_id)   -- 每日整理的建议（§读3.2）
      -- status: open|active|paused|closing|reviewed|dropped|merged；domain: work|personal
readings(id, ts, matter_id NULL, source, lens, method, profile_version, question, reading_ref,
         claim, revisit_at, look_for, frozen_hash, status, feeling NULL, owner_words, evidence_refs,
         revisited_at)
      -- 专存单门镜头解读（v0.25 与 crosschecks 拆开，§参1）；source: lens|agent；feeling: resonant|neutral|not_yet（以我的原话 owner_words 为准）
      -- claim / look_for / reading_ref 写入即冻结（frozen_hash 校验），之后只能追加回看
crosschecks(id, ts, kind, matter_id NULL, outlook_id NULL, person_id NULL, question, prompt_version,
            sources_json, reading_ids, agreements, divergences, blind_spots, suggestion,
            frozen_hash, status, feeling NULL, owner_words, revisited_at)
      -- v0.25：独立互参账本（§参2）。kind: matter|outlook|review|habit|relation|body|ad_hoc
      -- sources_json：本次实际参与的可选视角槽位与引用（事实/时间线、镜头 reading_ids、身体底图、他人原话、主人原话等，不设必填项）
      -- prompt_version：互参方法/提示词版本，用于跨版本复盘调优；核心内容写入即冻结（frozen_hash），之后只追加回看
body_entries(id, ts, date, kind, summary, metrics_json NULL, source, raw_ref NULL, confirmed, note NULL)
      -- v0.25：身体档案记录（§读5.2），与 self/ 同级隔离（仅主人可见），不进 events 和图谱
      -- kind: daily_summary|checkup|symptom|note；source: owner_chat|upload|device_sync；confirmed: 0|1（体检解析经我确认后为 1）
      -- raw_ref 指向仅主人可见的体检原件或截图存储
reviews(id, kind, matter_id NULL, period, draft_ref, status, started_at, ended_at, delivery NULL)
      -- kind: matter|daily|weekly|monthly；status: drafted|in_dialogue|done|not_discussed
      -- delivery：代码记的未聊这一轮怎么结束的，sent|replied|not_sent（§觉4）
review_open(id, kind, period, facts, fired_at, deadline, inbox_key, run_id, UNIQUE(kind, period))
      -- 发出去、还在等落档的复盘；到 deadline 由代码收尾（§觉4）

-- v0.9：红尘里修（§觉2、§读5.3）
outlooks(id, horizon, period, lane, parent_id NULL, intention_words, items_json, reading_ids,
         frozen_hash, status, review_id NULL, created_at, revisited_at)
      -- horizon: month|week|day；period: 2026-12 / 2026-W49 / 2026-12-03；parent_id 指向上一级前瞻
      -- items_json: [{ text, why_refs, look_for, revisit_at, owner_words NULL, feeling NULL }]，写入即冻结，回看只追加
      -- status: drafted|sent|discussed|revisited
life_notes(id, ts, surface, text, domain, matter_id NULL)  -- 随手记，src=owner
-- 视图 timeline(ts, kind, domain, matter_id, people, summary, ref)：
--   union owner 消息 / outbox / approvals / tasks / matters / outlooks / readings / crosschecks / body_entries / reviews / life_notes；
--   日程不落库，timeline_query 时现查飞书日历再合并（整张视图仅 owner 会话可用，§读5.1）

-- v0.11：退后（§寸3）
noticings(id, ts, habit_ref, kind, first_by, prompted, review_id NULL, matter_id NULL, owner_words, ref)
      -- kind: habit|rhythm；first_by: owner|agent；prompted: 0|1
      -- habits.md 条目状态：候选 | 认可 | 送一程 | 淡了 | 放下（后两种 v0.24，§寸4；rhythms.md 用 候选 | 认可 | 淡了 | 放下）

-- v0.10：agent 自己的 RSI（§进2）
signals(id, ts, kind, role, run_id, approval_id NULL, task_id NULL, value_json, src)
      -- kind: draft_approved|draft_revised|draft_rejected|replied_myself|triage_missed|triage_noise|
      --       owner_correction|task_failed|task_redo|proactive_ignored|expert_revise …；src 只认 owner 行为
eval_cases(id, role, kind, input_ref, gold_ref, from_signal_id, created_at, active)
      -- 由代码自动攒，agent 不能增删改

-- v0.12：知识库（§读1.5）
raw_sources(sha256 PK, s3_key, mime, bytes, title, origin_url NULL, src, visibility, received_at,
            inbox_id NULL, ingested_at NULL, pages_json)        -- pages_json：这份资料动过哪些页
pages_fts(path, title, body, visibility, updated_at)            -- FTS5（trigram），由代码在 agent-home commit 后同步

-- v0.13：以事为轴（§读2）
events(id, ts, source, ref, place, place_id, actor, kind, level, summary, link, domain, matter_id NULL, topic NULL,
       state, done_at, done_by, msg_ids, created_at, UNIQUE(source, ref))
      -- kind: ask|decision|commitment|progress|risk|deadline|info；level: fyi|watch|reply|decide
      -- state: open（reply / decide 还没处理）|seen（fyi / watch）|done|dropped
      -- done_by: replied|approved|rejected|owner|owner@console|import
      -- source: feishu|<sources.yaml 的 id>|import；place_id = messages.chat_id（群、私聊、<源 id>:<where>）
imports(id, ts, origin, sha, raw_path, summary_json, commit_sha, status)   -- status: applied|undone

-- v0.15：因缘（§读4）。前三张是持久的（我的纠正在这里），后两张是派生视图，随时可以整张重建
persons(id, name, slug NULL, config_key NULL, circle NULL, note NULL, first_seen, first_via, last_seen, cluster,
        status, merged_into NULL, created_at)
      -- slug = people/<slug>.md；config_key = people.yaml 的键（只读引用）；circle: 家人|朋友|同事|合作方|同学|邻里|其他（我分的）
      -- cluster = 自动分的圈子；first_via (JSON)：{kind: chat|matter|page, id, label, with[], me}；status: active|hidden|merged
person_aliases(kind, alias, person_id, src, ts, PRIMARY KEY(kind, alias, person_id))
      -- kind: name|feishu|wechat；同一个 name 指向两个人就是重名，查的时候拒绝并列候选
relations(id, a, b, rel, conf, src, evidence, ts, status)
      -- rel: 夫妻|家人|同事|上级|下属|朋友|合作方|同学|介绍人|…；conf: EXTRACTED（我认过）|INFERRED（推测）
      -- src: owner@console | 会话的 src；status: active|dropped
graph_nodes(id, kind, label, ts)            -- id: me | p:<person> | m:<matter> | c:<chat> | g:<页面路径> | r:<资料 sha>
graph_edges(a, b, rel, conf, weight, first_ts, last_ts, evidence, PRIMARY KEY(a, b, rel))
      -- rel: talks|in|dm|matter|at|link|mentions|key|source|rel；evidence (JSON)：最多 5 条出处
```
v0.13：`messages` 加 `event_id`（这条消息记进了哪个事件，用来按"回复的是哪条"关事件）；`matters` 加 `keys`（这件事在各处的叫法，JSON 数组，Triage 靠它把不同地方说的同一件事串起来），status 加 `done`（导入时已经办完的事）。信息源的消息也进 `messages`：surface `source:<id>`，chat_id `<id>:<where>`。
runs 加 `versions_json`（这次用的 prompt、skill、范例库、模型版本）和 `input_ref`（起草类 run 的输入快照，保留 1 年）；approvals 加 `revise_notes`（我"改一下"时说的话）和 `final_text`。

tasks、approvals、timers 各加一列 `matter_id NULL`；readings、reviews 各加一列 `outlook_id NULL`。runs、tasks 里的 `sdk_session_id` 改名为 `session_ref`。

v0.6 的 `events` 表合并进了 `inbox`（推送群消息进 `messages`），`jobs` 表合并进了 `timers`。
