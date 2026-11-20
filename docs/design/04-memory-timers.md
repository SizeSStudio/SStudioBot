> 导航：[设计文档索引](../DESIGN.md) · [上一篇：微信、权限闸门与审批](03-wechat-permissions.md) · [下一篇：配置控制台（core/console）](05-console.md)

## 8. 记忆

**原则：只存查不回来的东西。** 能从别处查到的（飞书文档、任务状态、聊天记录），记忆里只放指针。

### 8.1 文件布局（`/srv/sbot/agent-home`，git）

```
agent-home/            # = llm-wiki 的 wiki 层（§8.5）
├── AGENTS.md          # 用户指令：行为规则、渠道礼仪、审批原则（只有我能改；agent 可以提 proposal）。也是 wiki 的 schema
├── SOUL.md            # 人设、口吻
├── USER.md            # 关于我的稳定事实（有长度上限，每次都加载）
├── MEMORY.md          # 长期要点的索引（有长度上限，每次都加载；细节按需读）
├── index.md           # wiki 目录：每页一行（链接 + 一句话 + visibility），按类别分组；ingest 时由代码重建
├── log.md             # 只追加：`## [2026-11-16] ingest | 标题`，ingest / lint / 好答案回收都记一笔
├── journal/2026-11-16.md
├── people/  groups/  projects/     # 只有正文笔记，权限相关的字段都在配置仓库
├── topics/            # 知识页：概念、主题、比较、综述（ingest 和好答案回收写在这里）
├── sources/           # 每份 raw 资料一页摘要，链到 raw_sources 的 sha
├── shared/            # 我明确允许他人会话检索的内容
├── matters/           # 每件事一份：发心、方向、过程要点、复盘（§15.3）
├── self/              # 自我档案：命盘、年表、习气、节律、功课、心得、身体、前瞻、复盘（§15.9，只在 owner 会话可见）
└── skills/
```

### 8.2 记忆的种类（对应文章里的划分）

| 种类 | 落在哪 | 何时加载 |
|---|---|---|
| 用户指令 | AGENTS.md + SOUL.md | 每个 run（owner 会话全文；他人会话用精简版） |
| 用户笔记 | USER.md + MEMORY.md（索引）→ people / projects 正文 | 索引每个 run 都加载，正文按需读 |
| 已经说过的话 | `outbox` 表 | 定时器和 follow-up 起的 run 自动附上"最近 24h 已经告诉过我的事"，避免重复提醒 |
| 任务进度 | `tasks/<id>/progress.md` | 任务续跑时加载 |
| 原始聊天 | `messages` 表（FTS5） | 只能检索，不加载 |
| 事 | `matters/<id>.md` | 这件事的 lane 里起 run 时加载 |
| 自我 | `self/practice.md` + `habits.md`、`rhythms.md` 里我认可过的条目（有长度上限） | owner 会话每个 run 都加载；其余按需读 |
| 当下的节律 | 本月、本周前瞻的要点（`outlooks` 表） | owner 会话每个 run 都加载，几行以内 |

### 8.3 写入纪律
- **journal 每条都带来源**：`- [10:32][src=owner@feishu:dm] …`、`[src=person:wife]`、`[src=group:fs-xxx]`、`[src=web]`。来源由工具层自动填写，模型改不了。
- **dream（每晚，chat 档）**：没有文件工具，只能通过 `memory_patch` 工具提交修改，由代码校验允许改哪些路径：
  - 可以改：USER.md、MEMORY.md、people / groups / projects 正文。**AGENTS.md、SOUL.md、shared/ 不能改**，要改只能提 proposal。
  - `src=owner` 的内容可以提炼成关于我的事实。
  - **非 owner 来源**的内容只能写进对应的人或群的笔记，而且必须写成"X 说 / X 声称……"，**永远不能进 USER.md、MEMORY.md**。这样有人在群里说"记住：主人 同意了……"也洗不进核心记忆。
  - `src=web` 的内容只能进 projects 笔记，并且附上链接。
  - `src=lens`（镜头解读）：永远不当事实进 USER.md 或 MEMORY.md。只能留在 `readings` 对应的记录里；我回看时说的感受可以进 `self/lens-notes/`（[§15.7](08-companion.md#157-镜头与解读账本)）。
  - `src=crosscheck`（互参）：和镜头一样，是对照看法不是事实，永远不进 USER.md 或 MEMORY.md；留在 `crosschecks` 表里，我回看时说的感受可以进 `self/crosscheck-notes.md`（[§15.17](08-companion.md#1517-互参账本v025)）。
  - `src=review`（复盘）：我确认过的结论可以提炼进 USER.md，比如"我做决定前习惯先问别人意见"。没确认的留在复盘文件里。
  - `src=outlook`（前瞻）：和镜头一样，是看法不是事实，永远不进 USER.md 或 MEMORY.md；我回看时说的话可以进 `guidance-notes.md`（[§15.8](08-companion.md#158-rsi越用越贴)）。
  - `self/` 下的写入权限：`habits.md`、`rhythms.md` 只能加"候选"条目；`lens-notes/`、`crosscheck-notes.md`、`guidance-notes.md`、`reviews/`、`outlooks/` 可以写；`practice.md`、`charts/`、`timeline.md` 只能提 proposal；`body/` 里的体检摘要须经我确认入账，dream 只能当作可选底图参考，不能改原件也不得把内容带出 `self/`（[§15.19](08-companion.md#1519-身体档案v025)）。这是 dream 的权限；我在私聊里亲口要改的，主 agent 用 `self_page` 写（[§15.9](08-companion.md#159-自我档案)）。
  - 每次一个 git commit；改到 USER.md 先过 expert；第二天早上管理群收到 diff，可以一句话回滚。
- 他人会话只能写 journal（自动打来源标签）。

### 8.4 检索
- 不上向量库。
- 记忆页面：每次 commit 之后，由代码把改动的页面同步进 `pages_fts`（SQLite FTS5，中文用 trigram 分词）。`wiki_search` 先看 `index.md`，再查 FTS，最后读正文。量小时 ripgrep 也能顶。
- 消息归档：`messages` 表上的 FTS5。
- 他人会话的检索范围按 [§4.1](02-roles-models.md#41-主-agentchat-档) 在工具层过滤，并且只能看到 `visibility` 允许的页面（[§8.5](#85-知识库llm-wiki-三层karpathy-的-llm-wiki-模式)）。
- 页面过千、FTS 明显不够用时，再考虑 qmd 这类 BM25 + 向量 + 重排的本地检索。

### 8.5 知识库：llm-wiki 三层（Karpathy 的 llm-wiki 模式）

记忆不只装"关于我和身边人的事"，也慢慢长成个人知识库：我读过的文章、会议纪要、项目资料、学到的东西，都由 agent 消化成互相链接的页面。三层结构如下。

| 层 | 在哪 | 谁写 |
|---|---|---|
| **raw（原始资料）** | rustfs `sbot-raw` 桶，key 是 `sha256/<前两位>/<sha>`；元数据在 `raw_sources` 表 | 只增不改，模型永远不改原件。来源：转发给它的文章和链接、附件、语音转写、会议纪要、聊天导出、网页剪藏 |
| **wiki** | `agent-home`（git） | agent 维护，通过 `memory_patch` 提交，写入纪律照 [§8.3](#83-写入纪律) |
| **schema** | `agent-home/AGENTS.md` 里的"wiki 约定"一节 | 我改；agent 只能提 proposal |

**三个操作**
- **ingest**：inbox 里的一种事件，由"转发给它""会议结束""每天收尾"触发。
  - 用 light 档，在核心进程里跑（pi）。
  - 先存 raw，再写 `sources/<slug>.md` 摘要，然后更新相关的 topics、people、projects 页。一份资料可能动到很多页，所以每次 ingest 限 ≤ 8 页，超了拆成多次。
  - 最后更新 `index.md`、追加 `log.md`，打一个 commit。
- **query**：主 agent 的 `wiki_search` 加 `wiki_read` 工具，回答时附上页面链接。
  - **好答案收回 wiki**：比较、分析、复盘结论、我认可的发现，存成 topics 页，不让它们沉在聊天记录里。这件事由我说"记下来"，或者 dream 判断后提议。
- **lint**：并进每晚的 dream（轻的部分）和 [§16](09-rsi-matters-graph.md#16-agent-自己的-rsi越用越会办事) 的体检（重的部分）。
  - 检查互相矛盾、过时的说法、孤立页面、缺失的链接，以及该有页面却没有的概念。
  - 结果写成提案，不直接大改。

**和已有设计的关系**
- 四份心得文件（`self/lens-notes/`、`guidance-notes.md`、`rhythms.md`、`habits.md`）本来就在 agent-home 里，也就是 wiki 的页面。git 历史就是 [§16](09-rsi-matters-graph.md#16-agent-自己的-rsi越用越会办事) A 级"自动改、能回滚"的底子。
- **可见范围**：每页 frontmatter 带 `visibility: owner | work | shared`，加 `src`。
  - `self/` 和生辰固定是 `owner`，代码强制，模型改不了。
  - 他人会话只能检索 `shared`，工作群里的起草只能检索 `work` 和 `shared`。
- **来源纪律照旧**：`src=web` 的资料摘要必须带链接和 raw sha；非 owner 来源的内容写成"X 说……"（[§8.3](#83-写入纪律)）。
- **不存查得回来的东西**：飞书文档这类有权威来源的，raw 只存一份快照指针（URL、版本、时间），不复制全文；只有可能消失的东西才存原件，比如网页、聊天导出、语音。

### 8.6 seed 怎么到线上（v0.25）

`core/seed/agent-home/` 是新实例的起点，也会跟着设计改（比如 v0.24 改了 SOUL、AGENTS、复盘方法）。原来只在文件缺失时复制，改过的 seed 到不了已经在跑的实例。现在核心每次启动都比一遍，规则只有一条：**线上的文件只要被谁动过，就不覆盖。**

- **怎么知道没被动过**：装进去时记下这份文件的 git blob hash（kv `seed.state`）。线上文件的 hash 还是它，说明我、dream、改进提案、回滚都没碰过。
- **三类文件**：

  | 文件 | 有新 seed、线上没动过 | 线上动过 |
  |---|---|---|
  | `USER.md`、`MEMORY.md` | 不同步：装一次以后就是实例自己的笔记 | 不同步 |
  | 它自己的规则：`AGENTS.md`、`SOUL.md`、`skills/`、`tuning/` | 等我点头：管理群报一句，我回「更新 seed」才换；「更新 seed agents review」只换点名的几份 | 报「有更新待合」，不动 |
  | 其他 | 直接换，单独一个提交 | 报「有更新待合」，不动 |

- **为什么它的规则要等我**：这几份写着"只有我能改"（[§8.1](#81-文件布局srvsbotagent-homegit)、[§15.12](08-companion.md#1512-和闸门记忆的边界)、[§16.3](09-rsi-matters-graph.md#163-能改什么四级) B）。seed 的 PR 可以由 Claude 自己合，不一定经过我的眼睛；到线上之前我说一句，规则就还是我定的。SStudioBot 自己开的 PR 本来就等我合，所以它也不能借 seed 改自己。
- **通知**：和上线通知合成一条，只报文件名，不带内容。同一版 seed 每份只报一次；没理就不再提，想换时随时回「更新 seed」。
- **撤回**：每次替换一个 git 提交，通知里带「回滚 <sha>」。我回滚了，就当是我的回答：这一版不会再自动换上，也不再报；之后我点名「更新 seed」要它，还能换。
- **提交失败**（比如仓库被锁）：旧文件放回去，通知里说没换成，下次启动再试。
- **[§8.6](#86-seed-怎么到线上v025) 之前装的实例**：没有记录。和当前 seed 一样的文件从这次开始记；不一样的当作改过，报一次「有更新待合」，不动。
- **线上改过的怎么合**：手动合、提交。合到和 seed 一模一样，下次启动自动接上记录。
- 只看 seed 目录里有的文件，不碰 `self/` 和别的页面。

---

## 9. 定时器

### 9.1 两种定时器，一张表

| 类型 | 谁创建 | 例子 |
|---|---|---|
| **schedule**（周期） | 定义在 `config/jobs.yaml`（只有我能改），启动或热加载时同步进 `timers` 表 | 07:50 今日一卦（[§15.7](08-companion.md#157-镜头与解读账本)）；08:15 事的整理（[§15.14](08-companion.md#1514-每日整理v019)）；08:30 早报（含今日一卦和今日留意）；22:00 微信群摘要；22:30 日复盘；周日晚周复盘 + 下周前瞻；月初月复盘 + 本月前瞻；03:00 dream |
| **follow-up**（一次性） | 主 agent 在 owner 会话里调用 `followup_set({ at \| in, note })` | "周三下午看看对方回没回""下周一提醒我跟进 X" |

- **Scheduler 每 30 秒轮询一次**。对每个到期的定时器：往它的 lane 投一条 `timer` 事件（去重 ID 是 `timer_id:due_at`），然后把 follow-up 标为 done，或者把 schedule 推进到下一次。**定时器自己从不直接起 run。**
- 停机期间错过的 schedule 不补跑，记为 `missed`。上一次还在跑时，这一次记为 `skipped`。
- run 结束时**可以什么都不发**，这本身就是正常结果，所以不再需要单独的 `quiet` 选项。
- `jobs.yaml` 只放定义，`timers` 表只放运行状态（下次到期时间、上次运行时间），二者不重复。
- 任务写 `enabled: false` 就暂停：不再触发，和删掉一样，但设置留在文件里，随时能打开（控制台的开关，[§10.6](05-console.md#106-配置表单v022)）。

### 9.2 Sentinel（代替 heartbeat，纯代码、不调模型）
- 每 5 分钟巡检一次：
  - 审批过期
  - 卡住的 run 或任务（无输出看门狗）
  - Windows 和微信是否在线
  - lark-cli user token 是否健康
  - LLM 代理的错误率
  - 预算余量
- 有问题就直接往发件箱写一条管理群告警，模板是固定的。
- `HEARTBEAT.md` 删掉。主动性来自两处：agent 自己设的 follow-up，以及早报这个 schedule。

### 9.3 先安静
- **不是回应我**的消息（早报、摘要、follow-up、任务通知），都算主动消息，在 `gate.yaml` 里设每日上限，默认 6 条。超过的合并进下一次早报。
- 每周回顾时统计主动消息里"我回复了 / 点了 / 没理"的比例。上限的放宽或收紧**由我在配置里调**，agent 只能提 proposal。
- 分拣提醒（[§4.3](02-roles-models.md#43-triagelight-档无工具)）：还在等我回 / 拍板的总是发，和任务来问话一样。其余「知道就好」的，我在飞书读过就不发；没读的一天最多发上限这么多批（单独计数，不占任务通知和 follow-up 的额度），超出的进第二天早报，进早报前我已回应的会去掉。
- 复盘和前瞻类消息单独计数，不占上面的额度：日复盘最多 1 条/天，周、月的复盘加前瞻各 1 条；今日留意并进早报；我没回就不追问。"要不要给这件事起个局"的提议只出现在当前回复里，不单独发消息（[§15.11](08-companion.md#1511-渠道与配额)）。
- 事的整理（[§15.14](08-companion.md#1514-每日整理v019)）一天最多一张卡，**占上面额度里的 1 条**。到了上限就不发卡，建议留在控制台，早报里带一句。

### 9.4 定时任务遇到上游错误

定时触发的活没人在等，可以等上游恢复。适用于定时事件（早报、复盘、到点提醒、事收复盘、镜头结果进会话）和调模型的代码任务（dream、每日整理的模型部分、月度镜头）。我自己发的消息出错时行为不变。

| 错误 | 判定 | 下一次 |
|---|---|---|
| 暂时的 | 429、500/502/503/504/529、过载、网络错误 | 退避 2、5、10、20、30、30… 分钟 |
| 用量上限 | 报错说 weekly / usage limit、额度用完之类 | 报了恢复时间就排在恢复后 2 分钟；没报每 30 分钟看一次 |
| 不重试 | 预算用完（[§5.2](02-roles-models.md#52-llm-代理凭证代理)）、鉴权、请求本身有问题 | 按原来的失败处理 |

- **截止时间**：原定时间后 2 小时（`jobs.yaml` 里 `retry_hours` 可改；月度镜头 12 小时，要赶在当晚月复盘前），并且不晚于下一轮同名任务前 10 分钟。截止时刻再试最后一次，这样我临时配了备用模型或加了额度还来得及；恢复时间在截止之后的，中间不再空打。
- **放弃**：管理群一条消息，每次放弃只发一条，不补跑，也不去私聊打扰我。`job.<名字>.last` 记 `gave_up`。
- **只重跑干净的失败**：这一次没出过字、没发过消息、只用过只读工具才重跑；否则重跑可能重复发话或重复写入，按原来的失败处理。所以定时 run 不发「思考中」卡片，有字了才起卡。
- **失败的这一次不留痕**：会话文件退回到这次之前，否则每重试一次，事件全文就在上下文里多一份。滚动会话的摘要跟着事件带到下一次。
- 重试状态在 `inbox.not_before` 和 `payload.retry`（代码任务在 `kv` 的 `job.<名字>.retry`），重启不丢。排着队的事件不挡我的消息。

> 导航：[设计文档索引](../DESIGN.md) · [上一篇：微信、权限闸门与审批](03-wechat-permissions.md) · [下一篇：配置控制台（core/console）](05-console.md)
