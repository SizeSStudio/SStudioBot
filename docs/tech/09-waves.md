# 09 波次、重建数据、切换

一个长程任务按波次推进（round-1 第 3 题）：每波一个分支、一个 PR，CI 和冒烟过了自己合；**W7 切换线上那一步等我点头**。W1–W6 期间线上照旧跑 `core/`（冻结，只修线上故障），新主只在一次性测试 home 里跑。

## 总览

```
W0 预备 ─► W1 主 + 飞书 ─► W2 连接、设备、只读客户端 ─► W3 写、对话、推 ─┬─► W5 读参觉改、它自己 ─► W6 重建演练 ─► W7 切换
                                     └──────────────────► W4 节点和派活 ──┘
```

- W4 依赖 W2（中继、Noise、`devices`；§附2.21 R2「第 4 批依赖第 7 批」），不依赖 W3，可以和 W3 并行开分支，合并按编号。
- 每波的「替掉的旧件」是 `core/` 里被新主取代的文件（对照表在 10），**W7 之前一个都不删**，W7 后整个 `core/` 一起删。
- 每波的验收都在一次性测试 home 上跑（`hub/test/test-home.sh`，W1 出，用法照 `core/test/vps-test-home.sh`；端口 7829–7831，不删 testhomes）。

## 测试 home 里的飞书 ※

新旧两个进程不能同时吃同一个飞书应用的长连接（事件会被分走）。W1–W6：

- 有单独的测试应用（实例配置）就用它，全功能。11-28 起没有单独的测试应用：真测用线上应用在一次性测试 home 里短时 `live`，只发我的私聊和测试群「sbot 测试」，事件和点击这期间被新旧两边随机分走（你定的，08 P9「真测」，`hub/test/live-home.sh`）。
- 没有就 `channels.yaml` 里飞书插件设 `mode: shadow`：不开长连接、不收卡片回调，只按 user 身份轮询读；出口照常走闸门、审批、写 `outbox`，但插件的 `send()` 只记日志不发。验收里要真发的项（卡片按钮、真发一条）在 W7 前用测试应用补测。

## W0 预备

| | |
|---|---|
| 前置 | 这套文件合入 |
| 做 | ① `sbot-deploy` 按单元比较树 hash（01 部署，R3）；② 探针 P1–P11（08）；③ 旧库实测（04 §13 的 W0-1…6），替换估算；④ 旧库清点：每张表行数、每个群消息数、`raw/` 文件数和总 sha、`life_notes` 和没到点的 follow-up 条数——W6 对账的基线，只出数字 |
| 手动 | `deploy/core/install.sh`（装新的 `sbot-deploy`） |
| 验收 | 只改 `docs/` 的合并：线上核心不切、不重启，日志记下检查过的 sha；只改 `core/` 的合并照常上线；08 每节「结果」填了，不过的项按退路改了相应文件（回来找我的项先停） |
| 复用 | `deploy/core/sbot-deploy` |
| 替掉 | 无 |

这一波做完之前不往 `main` 合任何新目录的代码（01）。

## W1 主的骨架 + 飞书

| | |
|---|---|
| 前置 | W0；P9、P10 有结论 |
| 做 | `protocol/`（frames、envelope、version、noise 的实现先放这里、`api/` 和 `node/` 的第一批 schema）；改仓库 `CLAUDE.md` 的依赖方向一条（01）；`hub/` 的 config、db（04 全部表一次建好）、memory、inbox、runner（pi 嵌入）、tools（三列表 + `readOnly` + 守卫）、approvals、outbox + 出口组、channels（ChannelPlugin + 飞书）、sources、triage、ledgers（events、matters 含 `paused`、matter_ops、persons、graph、imports）、timers + Sentinel、proxy、egress、backup、cli；本机节点的最小件（exec、fs、check，经 `hub.sock`，05）；`scripts/import-check.ts`、`protocol-check.ts`；CI 的 server、protocol job |
| 手动 | 无（不上线） |
| 验收 | 飞书私聊能聊，流式卡片；群里有人 @我 → 起草 → 审批卡 → 批了发出（测试应用或 shadow 下看 `outbox`）；我先回了卡自动作废；kill 主在 run 中途 → 重启后不丢、不重复回，有副作用的标 interrupted 并告诉我发了几条；三列表守卫：定时、审批、任务、系统 run 整份读 `self/` 被拒（R1，有测试）；来源标签 `owner@`/`job@`/`system@` 按 `ownerTyped` 给（R1）；代理：坏令牌 401、越档 403、超预算只告警不拒（R7）；`check` 契约三种退出码各一测；配置改键三处同步的漂移测试过（Y11）；改 seed 不动线上配置（Y11）；夜里备份产出、能 `sbot restore` 回来 |
| 复用 | 10「值得照搬的现成件」里 cards、card、feishu、retry、`widening()`、config-form、config-write、`cached()`、egress、journal、seed 同步、release、lens-jobs、`recover()`、outbox 幂等、`PiRunner`、proxy、ledgers 一组、注意力窗口、sentinel 去重、备份 manifest |
| 替掉 | `main.ts`、`db.ts`、`dispatcher.ts`、`runner.ts`、`tools.ts`、`approvals.ts`、`outbox.ts`、`feishu.ts`、`feishu-api.ts`、`cards.ts`、`card.ts`、`observer.ts`、`timers.ts`、`sentinel.ts`、`health.ts`、`retry.ts`、`proxy.ts`、`egress.ts`、`memory.ts`、`wiki.ts`、`triage.ts`、`events.ts`、`matters.ts`、`matter-ops.ts`、`graph.ts`、`importer.ts`、`sources.ts`、`source-mail.ts`、`backup.ts`、`release.ts`、`config*.ts`、`schemas.ts`（R3 的 6 处写死飞书在新主里没有对应物；逐文件见 10） |

## W2 连接、设备、只读客户端

| | |
|---|---|
| 前置 | W1；P1–P4、P11 过了（或按退路改完） |
| 做 | `relay/`；主的 link（中继注册、`hub-admin.sock`）、主密钥、配对、`devices`/`device_invites`/`device_audit`、认证、角色一处判断；`change_log` 触发器 + pump + bootstrap + stream + 视图函数；只读的 `/api/v1`；`sbot pair`、`sbot devices`、飞书 `/pair` `/devices`；`clients/`：连接状态机、store、渲染（不可信规矩、markdown、代码、列表）、主对话和 thread 只读、设备页；Electron 壳（协议、CSP、bridge、`safeStorage`）；安卓密钥模块、扫码、粘贴配对码；CI 的 clients job |
| 手动 | `deploy/relay/install.sh` + nginx 一段（中继域名、证书是实例配置）；`/etc/sbot/deploy.env` 加 `relay` 单元（`relay protocol/envelope.ts`）。`relay.yaml` 先只列测试主的公钥；`relay.enabled` 默认关，我开 |
| 验收 | §触6.9 P1 ①–⑧ 和 P2 全部：手机开着 FlClash 扫码配上，经中继连上；飞书私聊说一句，客户端逐字出现，工具调用实时开始和结束；反复断线重连不重不缺；切 thread 不发请求；中继抓包无明文，换主公钥连不上；20 连接的实测数（P1 门槛）；只改 `clients/` 的合并不重启线上核心；三条配对路都通；删设备 1 秒内断开；重放被拒；`node` 角色批审批、答看一眼、发消息、读 self 四条都 403（有测试）；不可信内容外部请求 0（P11 ③ 的样本进 CI 单测） |
| 复用 | P1 里能照搬的 Paseo Noise / relay（保留版权头） |
| 替掉 | 旧控制台的只读页（`core/console/`、`console*.ts`、`routes.ts`）；tailscale serve 入口 W7 撤 |

## W3 写操作、对话、推

| | |
|---|---|
| 前置 | W2 |
| 做 | 写路由和 `client_ops`（乐观、确认后才算、乐观锁）；审批、看一眼、问我、改稿、暂缓；thread（一般、主线、任务）、`personal` 隔离（飞书 lane 搜不到）；push：`push_queue` 状态机、在场、夜间、已读（`reads`）、额度、FCM（`fcm.enabled` 默认关）、`personal` 只说一句；**省心**（§寸8：只收窄推，早报顶行、第 3 天问一次，切换只在我亲手发的那轮）；客户端写操作、乐观层、在场上报、FCM 令牌、通知渠道、HTML 交给浏览器；飞书确定性命令补齐（§触6.9 并行 F） |
| 手动 | 无 |
| 验收 | §触6.9 P3、P4：飞书和客户端同时点同一张审批只有一个生效、两边一致；断网重试不重复；流式、停止、排队；客户端正看着的那条飞书不响，走开后手机弹、飞书不响；令牌失效改推飞书；紧急类 FCM 和飞书同发；夜间只记不发、早报带上；任一端看过就算已读，推里的「N 条」跟着变；省心时整理卡不推、等你回照推；`proactive_daily_cap` 按 `push_queue` 算 |
| 替掉 | `commands.ts`、`mirror.ts`、旧控制台的待办和会话页 |

## W4 节点和派活

| | |
|---|---|
| 前置 | W2（不等 W3）；P5–P8 有结论 |
| 做 | `node/` 全部（05）：适配器四个、统一事件、权限和问我、sbot MCP、worktree、CI 盯守、额度认出、空闲释放、排空、升级；主的 tasks、nodes、`/node/v1`、看一眼卡接节点权限请求、续跑和额度到点续、`mcp_open`；客户端的任务 thread、步骤、diff（桌面 `@pierre/diffs`、安卓文件列表）、节点页、可清理的 worktree |
| 手动 | `deploy/node/install.sh` 在我的 Mac 上装，`sbot-node pair`；服务器上本机节点账号 `sbot-h` 的 unit（`MemoryMax=6G`，`worker-exec --host`） |
| 验收 | 手机上派活到 Mac 的 Claude Code，步骤和 diff 实时出现；agent 要权限 → 手机看一眼卡 → 答了生效；插话（支持的三家本轮生效，ACP 排下一轮且界面照实说）；杀节点进程 → 任务进「需要你处理」，我再答时续上；PR 的 CI 红了叫醒同一个 session，连红第 3 次进通知（04 §14）；额度上限 → 到点自动续；主发新 sha → 节点自己升级，坏版本 30 秒内退回；节点调 `/api/v1` 一律 403；`usage.source = node` 记上 |
| 复用 | `deploy/worker/` 的 `sbot-w`、`worker-exec`、netfilter（沿用） |
| 替掉 | `tasks.ts`、`worker*.ts`、SDK worker、`defer`、挂起式审批、bare 镜像 |

## W5 读参觉改、它自己

| | |
|---|---|
| 前置 | W3、W4 |
| 做 | 读：时间线、人、身体（`body_entries`，安卓三条输入：体检报告、一句话、Health Connect 默认关）、它对我的看法（`self_items` 带依据、能改能删）、`self/` 和命盘；参：lens、解读账本、`crosschecks` 和分歧；觉：前瞻、复盘（日、周、月、事收）、习气和节律候选；改：功课、学到的（`learned_items` 可否决）；它自己：improve（C 级经节点 agent 开 PR、对不上先挂起，§进2）、提案（按 `target` 去重）、`suggestions`、`dismissals`、用量、配置和密钥编辑、信息源页；dream 的三个数；早报 |
| 手动 | 无 |
| 验收 | §触6.9 P5 的功能对照清单（旧控制台每页一行，新客户端对应位置）全部打勾；§触6.9 P6 三条身体输入都能入账、Health Connect 关着时一条不读；定时任务触发的复盘读不到 `self/` 全文（R1）；一条学到的被我否掉后不再出现在提示里；提案卡上线两周后复查能出、一键回滚生效 |
| 替掉 | `lens.ts`、`lens-jobs.ts`、`life.ts`、`dream.ts`、`reflect.ts`、`digest.ts`、`matter-review.ts`、`self-profile.ts`、`birth.ts`、`tuning.ts`、`improve.ts`、旧控制台剩下的页（`console-passwd.ts` 随公网密码入口 W7 撤） |

## W6 重建演练

| | |
|---|---|
| 前置 | W5 |
| 做 | `sbot import`（下面）；在服务器上用旧库和 `raw/` 的副本演练两次 |
| 手动 | 无 |
| 验收 | 见「演练和对账」；成本估算发给我 |

## W7 切换（等我点头）

1. 我说可以，定一个时间。之前把旧系统里的待批卡、在跑的任务、`outbox` 里 `sending` 的收尾（04 §14：这三样不搬）。
2. 停旧核心（`systemctl stop`），**旧库、旧 `agent-home`、旧 config 原地不动**。
3. 带过去的原样拷：`secrets.env`、`raw/`、`private/body/`。主私钥：旧系统没有，新主第一次启动时生成（测试 home 的那把不沿用，设备表也是新的）。
4. `sbot import config --pick` → `sbot import plan` → 我看成本 → `sbot import run` → `sbot import verify`（同演练）。
5. `deploy.env` 的单元从 `core` 换成 `hub`、`relay`；跑 `deploy/hub/install.sh`；服务器本机节点 unit 指新路径。飞书插件切 `mode: live`。
6. `relay.yaml` 换成正式主的公钥；手机、Mac 客户端和 Mac 节点各配一次（`sbot pair [--node]`）。
7. 验收（30 分钟内）：私聊能聊；管理群收到上线通知；客户端经中继连上；Mac 节点连上；一条要我回的群消息进早报。
8. **退回**：任何一条不过 → 单元换回 `core`、启旧核心；旧核心靠 `catchUp()` 补读这段时间的消息。新库留着查原因。
9. 稳定 7 天 ※（没有退回、没有手动修库）后开一个 PR：删 `core/`、`deploy/core`、`deploy/console-web`、`deploy/lens`，撤 tailscale serve 和公网密码入口，仓库 `CLAUDE.md` 里 `core/` 相关的句子改掉。这个 PR 也等我点头。

## 重建数据（round-1 第 4 题、前端第 11 题）

旧库不动，新库按 04 一次建好，按下表从各处读回来。表级的「数据」标签在 04 每张表上方，这里是流程。

| 数据 | 怎么来 |
|---|---|
| `agent-home` | 从 seed 重建 |
| config | 从 seed 重建，再由我挑要带的文件（`--pick`：逐个文件显示和 seed 的差异，我选带、不带、改了再带）；`feishu.yaml` 转成 `channels.yaml`，`worker.yaml` 拆到 `node.yaml` |
| messages | 从飞书（user 身份逐个群、私聊、邮件）和本地信息源重读 |
| 事件账本、事（matters、matter_ops） | 重读后重跑分拣和归事 |
| 人、关系、图谱 | `people.yaml` + 重读时推出来；图谱重算 |
| 解读账本、互参、`self_items`、身体条目、复盘和前瞻、`dismissals`、`eval_cases`、proposals、matter_reviews、noticings | 清零 |
| `life_notes`、没到点的 follow-up | 带过去 ※（04 §14） |
| imports | 旧库 `applied` 的按 `raw/` 原件重新应用 |
| raw_sources、pages | 从 `raw/` 重算 |
| 运行记录（inbox、runs、sessions、usage、signals、requests）、config_changes、kv | 不搬（kv 只带 `task.seq`，新 task id 接着往上编） |
| `secrets.env`、主私钥、`raw/` 原件、体检原件 | 原样带过去 |

### `sbot import`

经 `hub-admin.sock`，每步幂等、可中断续跑（游标在 `chat_cursors` 和 `imports`）。

- `import config --pick`：上表 config 一行。
- `import plan`：只读飞书和本地的**条数**，不拉正文；按 W0-5 实测的「每条消息分拣花费」算：`估算 = 消息数 × 每条分拣花费 + 预计事件数 × 每件归事花费`，连同条数、预计时长打出来。不设回看窗口：飞书 API 给多少读多少；嫌贵我在这一步说「只读近 N 天」再出一次 plan。
- `import run`：
  1. 带过去的几样先写。
  2. 按群、私聊、邮件、信息源拉消息写 `messages`，`ts` 用原始时间。
  3. 按时间顺序重跑分拣、归事，事件带原来的 `ts`（04 §10.3 的动静触发器因此算得对）。历史里我已经回了的，按原规则自动关。
  4. 重新应用 imports、重算 pages 和图谱。
  - **整个 run 是 `system@import`**：出口全关（`outbox` 不写）、`push_queue` 不入队、不发管理通知以外的任何消息、不建审批卡。有测试。
- `import verify`：出对账表（下面），只出数字。

### 演练和对账

在服务器上拷两份旧库 + `raw/`（同一个时刻的快照），各开一个测试 home，各跑一遍 `import`。

| 项 | 要求 |
|---|---|
| 每个群、私聊的消息数 | 两次相等；和 W0 清点比，只多不少（多的是之后的新消息） |
| `raw/` 文件数、总 sha | 两次相等，等于旧的 |
| `life_notes`、follow-up 条数 | 两次相等，等于旧的 |
| imports 重新应用的条数 | 两次相等 |
| 事件、事的条数（模型推出来的） | 两次相差 ≤ 10% ※ |
| 旧库里还开着的「要我回」事件 | 每一条在两次结果里都能找到对应的开着的事件（按 chat + 原消息 id 对）；找不到的列出来 |
| 出口 | 两次 `outbox` 都是 0 行，`push_queue` 0 行 |
| 实际花费 | 和 plan 的估算相差 ≤ 30%，否则修估算公式 |

两次都过才算 W6 过；不过就修、再演练两次。

## 每波顺带的事

- PR 描述开头标敏感区：W1（闸门、审批、鉴权、LLM 代理、worker 沙箱）、W2（设备配对和权限、鉴权、控制台入口）、W4（worker 沙箱、`deploy/worker/` 如有改动）、W7（全部）。
- 设计和实现对不上：先在同一个 PR 里改这套文件和对应的 DESIGN 章节，再写代码。
- `leak-guard.sh` 每个 PR 跑；测试数据一律虚构。
