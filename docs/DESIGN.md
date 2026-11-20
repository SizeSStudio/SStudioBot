# SStudioBot 设计文档（v0.25 草案）

> 状态：M0–M8 已在作者自己的实例上跑起来，处于打磨期。进度见 §13。
> 一句话：**一个常驻的伙伴，陪我修自己、离苦得乐。它替我办事，也借办事、日常和镜头读懂我；把这几种看法放在一起互相参照，帮我补齐视角、先看见问题，再陪我一点点改。看可以主动，说要克制，抓得住也放得下。飞书管工作，所有对外出口都要我批准。**

### v0.25 变更（seed 到线上，2026-11-20）
- **seed 改了能到线上（§8.6）**：核心每次启动都比一遍。线上没被动过的 seed 文件换成新版本，单独一个提交，能回滚；被动过的不覆盖，只报「有更新待合」。
- **它自己的规则等我点头**：`AGENTS.md`、`SOUL.md`、`skills/`、`tuning/` 有新 seed 时，管理群报一句，我回「更新 seed」才换。`USER.md`、`MEMORY.md` 装一次以后就是实例自己的笔记，不再同步。
- 权限、闸门、审批、预算都不变。

### v0.24 变更（第一性原理重定，2026-11-19 主人定）
- **它是什么（§0）**：不是另一个工作助手，也不是"另一个我"。是陪我修自己的伙伴，目的是离苦得乐。办事是基本功，也是最好的起点。
- **办 → 读 → 参 → 觉 → 改（§0.2）**：读懂我是前提，互参是方法，我自己看见是目的。"互参"是这一版新立的：AI 的推理、事实记录、镜头、我自己的话，放在一起对照，**分歧本身就是线索**。
- **读懂我从哪来（§0.3）**：办事、日常（含身体）、镜头、我说的话。**不等我输入**：开着的来源它主动去看、主动找规律；来源开不开仍然由我（新来源默认关、只读，权限一概不放宽）。
- **补上之前漏掉的四件事（§0.4、§15.15、§15.16）**：放下（理解会淡、能放下，不把过去的我钉成标签）；不绕着苦转（同一件苦事不反复翻）；修要落在实处（不推语录道理，帮助落在扛事、腾时间、搭结构上）；办事本身就是离苦，不只是观察的手段。
- **落地（合并后补）**：SOUL、AGENTS、`skills/review/` 按新 §0 改写；`淡了`、`放下` 两个状态和 `fade_days` 实现了。控制台里原来写着"放下"的按钮其实是"不认"（`dropped`），现在分成两个。§15.16 改成按事是否了结：事上的跟进照常到办完，不绕着的是难受的那一面（主人 11-19 定）。
- **改掉的旧说法**：v0.8 的"办事是了解我的唯一可靠来源"、v0.13 的"人来找它，最后都是为了一件事"（§17.1）、一句话里的"另一个我"。
- **客户端（§19）等这一版定了再按新 §0 重做**；现有功能和权限不变。

### v0.23 变更（主对话放开、生辰表单、没有生辰也能看，2026-11-19 主人定）
- **主人的决定**：主对话要全能，只为保护主人自己隐私或谨慎而加的限制都去掉。防别人和防外部输入的限制不动。分界见 §15.9。
- **在他的飞书私聊里**：`self/`、习气、节律、命盘可以整份读、整份说，镜头结果直接给他看。新工具 `self_profile`（出生信息和镜头设置）、`self_page`（`self/` 页面），只在他亲手发消息的那一轮可用，每次改动都有 git 提交和记录，能回滚。
- **生辰表单**：控制台「生活 › 出生信息」是表单，不用改 YAML；写入和配置编辑器走同一条路。
- **没有生辰也能看**：六爻加日、周、月的例行起卦，由 `lens_day`、`lens_week`、`lens_month` 写进账本，默认开，能在 `jobs.yaml` 关（§15.2、§15.7）。

### v0.22 变更（配置改成表单，2026-11-19）
- **改配置不用再写 YAML（§10.6）**：每个配置文件一张表单，字段、说明、范围、哪些算放宽都由服务器描述，旧控制台照着画，以后的新客户端用同一份。原文编辑器收进每张表单的「高级 › 查看原文」。
- **保存还是原来那条路**：表单先变成保留注释和顺序的新文件内容，再交给原来的保存函数，比 hash、zod 校验、git 提交、记账、通知管理群都不变。放宽的改动要我先确认。
- **定时任务可以暂停（§9.1）**：`enabled: false` 的任务不再触发，设置都留着。

### v0.21 变更（定时任务抗上游故障、未聊由代码记，2026-11-19）
- **定时任务遇到上游错误会重试（§9.4）**：429、5xx、网络错误按退避重试，默认到原定时间后 2 小时，不跨进下一轮同名任务；到点放弃，管理群说一声。用量上限按报错里的恢复时间排，不空打。
- **档位可配备用模型（§5.3）**：默认不配。配了，主模型报用量上限时这次请求改走它，照常计量。
- **未聊由代码记（§15.5）**：复盘到截止时间没落档，代码写一条，带当时发给我的内容；没发出去的也记，并标明。

### v0.20 变更（控制台客户端设计稿，2026-11-18，未实现）
- **新增 §19**：VPS 只做 server（API + 事件流），客户端拆到 `clients/`，Web 先行，然后 Mac、安卓，可以用框架和构建。
- **控制台是全集，飞书够完成全部工作操作**：§19.6 是逐项的验收表。
- **控制台能和主 agent 对话**：thread 和飞书私聊分开，状态共享；可以按主线、按任务分。
- **设备验证**：新设备经已信任设备或飞书确认，每台设备单独授权、能吊销。公网驱动主 agent、设备权限等都是**待我确认的决定**（§19.10），现有权限一概不放宽。

### v0.19 变更（主线与每日整理，2026-11-18）
- **事分两层（§15.3）**：我跟的是**主线**，主线下面可以挂**子事**，只有一层。控制台、早报、提醒默认只看主线，子事折叠，事件和数字沿子事汇总上来。真重复的事才**合并**。挂、拆、合并都记账，都能撤销。
- **Triage 按主线认事（§17.2）**：输入只列主线，带上它和子事的全部叫法；说到子事的叫法，事件落在那件子事上。
- **每日整理（§15.14）**：每天 08:15，代码先攒事实，便宜模型补它看不出的，一张卡最多 5 条建议给我。**只有我点了才改**，点「没问题」的不再问，不理的不堆积，算进每日主动消息上限里的 1 条。
- **导入按主线总结（§17.4）**：里程碑写成事件或子事；预览里说清会有几条主线、几件事，太碎就提醒。现有的事不做一次性迁移，由每日整理逐条交给我确认。

### v0.18 变更（飞书邮箱信息源，2026-11-18）
- **新的内置信息源 `kind: feishu-mail`（§17.3）**：我的飞书邮箱，只读。新邮件和群消息一样进分拣、记成事件、挂到事上。默认不开，我在 sources.yaml 加一行才开，加的时候管理群醒目提醒。
- **这是放宽**：邮件正文第一次进入分拣和模型。它用核心已有的飞书用户登录，不加 scope、不加密钥；登录留在核心里，不交给插件，也不给 agent 新工具（§17.1、§17.3）。
- **分拣的围栏加固**：外面来的文字不能再写出 `<untrusted>` 或 `</untrusted>` 来跳出围栏；群消息升级给主 agent 时也包在 `<untrusted>` 里。
- **信息源不再升级给主 agent（§4.3）**：所有信息源（不只邮箱）被判成 `escalate` 时一律改成提醒我。邮件和网页谁都能写，主 agent 又能派有 sudo 的 host worker。

### v0.17 变更（控制台公网入口，2026-11-18 主人定）
- **控制台加第二个入口（§10.1）**：tailscale serve 在主人的网络下经常卡，加一个公网 443 入口，防护照主人另一个管理面的做法：nginx + Let's Encrypt，Cloudflare 只做 DNS（灰云），一个密码（PBKDF2 哈希存在 `secrets.env`），登录后发 12 小时的 HMAC 签名会话 cookie（`__Host-`、Secure、HttpOnly、SameSite=Strict），登录要本站 Origin，按 IP 和总量限速，登录和限流都通知管理群。地址写在 `config/console.yaml` 的 `web.origin`，不写就是关的。tailscale 入口保留，行为不变。
- **两个入口互不相信对方的身份证明**：各听各的 unix socket。tailnet 的只认 `Tailscale-User-Login`，nginx 连不上它；公网的只认会话 cookie，`Tailscale-User-Login` 在这里一律不看。
- **公网入口上写操作多一道 Origin 校验**；密码和会话密钥不能从控制台改，只能在服务器上跑 `console-passwd`。
### v0.16 变更（注意力窗口，2026-11-18）
- **分拣判定要提醒的，先等一个窗口**（默认 30 分钟，`gate.yaml attention`，可按地方调，0 = 不等）。窗口内我自己回应了，这条安静结束；到点还没回应才提醒（§4.3）。
- **「我回应了」收成一条规则**（§17.2）：直接回复、同一话题里说话算；群里一句没指向的话只算紧跟在问题后面的那一件；拿不准就不关，宁可多提醒。
- 不用回的提醒：我在飞书读过就不再发，并受每日上限约束，超出的进早报（§9.3）。要我回的不受这两条影响。

### v0.15 变更（因缘：人、事、资料的图谱，2026-11-18）
- **新增 §18**：personal agent 不能只看事，还得知道主人身边有哪些人、是什么样的人、彼此怎么连上的。思路借自 graphify：边分「有记录」和「推测」，一条路径的可信度取它最弱的一跳；纯代码构建、不调模型；圈子按结构自动分，用大家最常在的群命名；名字有歧义就拒绝并列出候选。
- **人分三层（§2.2）**：`persons` 表是它见过的每一个人（不带任何权限）；`people/<slug>.md` 是 TA 是什么样的人；`config/people.yaml` 仍然只管身份和权限，图谱只读它、永远不写。
- **因缘**：每个人第一次出现在哪、同场有谁、我在不在；之后每月的往来。**借机观察**只摆事实：新结的缘、常在一起但还不知道什么关系的两个人、牵线的人（跨两个以上圈子）、渐远的、待认的（只有名字、重名）。
- **控制台**：生活 › 人（每个人的因缘、关系、常一起的人和事、页面、叫法，可以改名、分圈子、记关系、合并、拆开）；生活 › 因缘（圈子图和借机观察）。
- **工具**：`person_lookup`、`person_path`（L0）、`person_relate`（L1，记下的关系一律算推测，等我在控制台点「对」才算有记录），都只在 owner 会话。
- **新增表**：`persons`、`person_aliases`、`relations`（我的纠正，持久），`graph_nodes`、`graph_edges`（派生视图，随时可重建）（§11）。

### v0.14 变更（worker 默认上宿主机，2026-11-18 主人定）
- **worker 分两种模式（§4.2、§7.6）**：默认 **host**：用户 `sbot-h`，以 transient service 的形式跑在宿主机上，不套 bwrap，也不受 iptables 限制，公网、DNS、tailnet 全通，**有完整 sudo**，HOME 持久保留（ssh key、各 CLI 的登录状态都在里面）。**sandbox** 就是原来的 `sbot-w` 隔离，任务要处理不可信内容时才用。主 agent 觉得有风险，先问我要不要用 sandbox。
- **新配置 `config/worker.yaml`**：`default_mode`、额外的 PATH 目录、启用哪些 skill（skill 本身放在 `config/skills/<名字>/`）、`ssh_hosts`（worker 可以用 `ssh <名字>` 登录的机器，比如我的 Mac）。
- **取舍**：给了 sudo，`secrets.env` 和核心的其他文件就不再靠文件权限挡住 host worker，靠的是 worker 规则加核心的 PreToolUse 守卫。这是防误操作、防注入的软边界，挡不住有意为之。sandbox 模式的边界没变。

### v0.13 变更（以事为轴：事件账本、信息源、导入）
- **新增 §17**：事（matter）是组织一切的轴；核心只管"帮人把事办好、在事上长进"的骨架，每个人不同的部分（信息源、导入来源、镜头）走插件。
- **事件账本（§17.2）**：Triage 除了给每条消息定动作，还记**事件**：kind（找他 / 定了 / 答应 / 进展 / 风险 / 时间点 / 信息）× level（**知道就行 / 要盯 / 要你回 / 要你拍板**）× state。事件挂在一件事上；还没有事的，先挂在一个**话头**上，同一件事在不同群、私聊、信息源里用同一个话头，就能串起来。要你回的，你在原处说了话、草稿发出或被你拒掉，代码自动关掉。
- **信息源（§17.3）**：新配置 `config/sources.yaml`。飞书私聊改成可开（`feishu.dm`，只记事件、不起草）；git（新提交）、fetch（网页变化）、command（主人装的插件，比如 jira、邮件）三种。插件只拿到它声明的密钥，核心自己的密钥一律不给。
- **导入（§17.4）**：格式 `sbot-import/1` + 一份提示词（`core/import/PROMPT.md`），别的 harness 照着它总结就能导进来；也可以直接贴原始材料，由 work 档按同一份提示词整理。先预览、再导入、能撤销。
- **控制台**：待办加「要你回 / 拍板」；生活 › 事 显示事件和话头，可以改级别、关掉、把话头挂到事上；生活 › 导入；它自己 › 信息源。
- **新增**：表 `events`、`imports`；`messages.event_id`、`matters.keys`；matter 状态加 `done`（导入时就已经办完的事）（§11）。
- **取消后置**：`observe_p2p` 改为 sources.yaml 的 `feishu.dm`。

### v0.12 变更（轻量单机 + 知识库）
- **新增 §1.3 部署**：只用一台 VPS，不做远程 worker。数据全部放在 4T 数据盘 `/srv/data` 上；系统盘只装 `/opt/node`。对话角色在核心进程里跑，不起 CLI 子进程；同时最多 2 个 worker 进程，每个限内存。重构建交给 Mac 或 CI。常态内存目标：空闲约 300 MB，峰值约 2.3 GB 以内。
- **§8 记忆按 llm-wiki 三层重组（§8.5）**：
  - raw 层：rustfs 的 `sbot-raw` 桶，按内容 sha256 存，只增不改。
  - wiki 层：就是 `agent-home`，加上 `index.md` 和 `log.md`，页面带 `visibility`。
  - schema 层：`agent-home/AGENTS.md`。
  - 操作：ingest / query / lint，检索用 FTS5，不上向量库。
- **备份**：每晚把 SQLite 快照和两个 git 仓库的 bundle 传到 `sbot-backup` 桶。**异地副本（2026-11-17）**：同一份文件也放进主机的 `backup-out/<日期>/`（留 7 天），我的 Mac 用 launchd 每天 09:30 / 21:30 和开机时经 ssh 拉回 `~/Backups/sbot/`，拉之前核对 manifest 的 sha256、SQLite `integrity_check`、bundle 可读，全部保留（每天几百 KB）；拉完在主机上写 `backup-out/pulled`。Sentinel：30 小时没出新备份、或 Mac 3 天没拉，就在管理群提醒。安装：`deploy/backup-mac/install.sh`。`secrets.env` 不进备份，恢复时要重新填密钥。
- **新增**：表 `raw_sources`、`pages_fts`（§11）。
- **§4.0 定了：对话角色用 pi**（P0 对比 11/11 通过，2026-11-16）。worker 和 lens 仍用 SDK。

### v0.11 变更（退后）
- **新增 §15.13 退后**：成长的刻度是我自己的觉察变强，不是 agent 越来越会指出我的习气。复盘时记一笔"谁先看见"；一条习气我连续几次自己先看见，agent 就不再主动提（送一程）；复盘顺序熟了以后有时先让我自己回忆。
- **§16 加"怎么陪"的信号**：哪些问题打开了我的话头、哪些换来"今天不想聊"，作为复盘和前瞻方法（B 级）改进的依据。
- **新增**：表 `noticings`，habits.md 条目加状态 `送一程`（§11）。

### v0.10 变更（agent 自己的 RSI）
- **新增 §16**：agent 自己也有一圈 RSI：怎么办事 → 我怎么用它的结果 → 找出差距 → 改办法 → 下次办得更好。和 §15 是同一个骨架：版本先冻结，再看真实表现，以我的判断为准。
- **信号白来**：审批里我怎么改、拒、自己动手，Triage 漏了和多了什么，对话里我纠正了什么，worker 的失败和返工。从 M1 起就记录，不调模型（§16.2）。
- **能改什么分四级**：记忆、风格笔记、范例库自动生效、可回滚；skill、prompt、Triage 规则、模型档位要提案、回放评测、我批；代码走 PR；权限、预算、auto 规则和这套机制本身永远不由 agent 提（§16.3）。
- **回放评测**：评测集由代码从历史里自动攒，标准答案是我最终发出的版本和我的实际反应（§16.4）。
- **新增**：表 `signals`、`eval_cases`，`proposals` 加列，`runs.versions_json`（§11）；里程碑 M7（§14）。

### v0.9 变更（红尘里修 + harness 再评估）
- **定位从"事上修"扩到"红尘里修"**：修行在整个生活里，"事"只是其中值得起收的节点（§15.1）。
- **新增节律前瞻**：月、周、日三个尺度事先给留意和建议。月、周的前瞻和复盘合成一场对话；日留意并进早报。依据分事实、习气、节律、镜头四个面，层层嵌套，写入后冻结（§15.2）。
- **新增时间线与回溯**：用一个 SQL 视图把生活事实按时间串起来，加上随手记。可以按周期、按线索、同期对照来回看（§15.6）。
- **RSI 循环做成完整的一圈**：前瞻 → 生活 → 回看时我说感受 → 四份心得（解读笔记、建议心得、节律、习气）→ 下一次前瞻。陪伴方法本身只能提 proposal（§15.8）。
- **harness 再评估**：worker 和 lens 留在 Claude Agent SDK；对话角色倾向用 pi，P0 做一轮对比再定。工具和闸门写成与 harness 无关的一层（§4.0）。
- **新增**：表 `outlooks`、`life_notes`，视图 `timeline`（§11）；`self/rhythms.md`、`guidance-notes.md`、`outlooks/`（§15.9）。

### v0.8 变更（事上修）
- **定位**：办事和自修合成一件事，不做脱离事情的"修行模块"。日常协同办事既是道场，也是 agent 了解我的唯一可靠来源（§0、§15.1）。
- **新增"事"（matter）**：作为一等对象，把任务、审批、follow-up、解读串起来。每件够分量的事都有"起"和"收"（§15.3）。
- **起局 = 方向性引导**：包括事实盘点、问发心、可选的镜头视角、习气提醒、检查点（§15.4）。
- **复盘**：分事收、日、周、月四种，事和心两层都看。事的层面由 agent 先拟事实初稿；心的层面**先引导我自己说**，补充记录里没有的信息和看法。这个过程本身就是觉察（§15.5）。
- **镜头做成插件**：紫微先用现有 skill；六爻参考 zhouyi-qigua.pages.dev，之后单独做 skill；八字后续再说。
- **解读账本**：当时的看法先写下来，之后不改；过一段时间结合生活回看，由我说感受。回看的心得沉淀进每门的解读笔记，形成类 RSI 的循环。镜头当作一种看法，结合生活来感受，不做对错打分（§15.7）。
- **自我档案 `self/`** 和**习气观察**：习气观察必须带证据，我认可后才会被引用（§15.9、§15.10）。
- **新增**：角色 reflect、lens（§4.5）；表 matters、readings、reviews（§11）；里程碑 M6（§14）。事上修的立场在 M0 写 SOUL.md 时就写进去。

### v0.7 变更（Fable review + 《Building always-on agents》）
- **运行模型重写成五件套**：收件箱、定时器、记忆、权限、发件箱（§1）。agent 平时不跑，被事件叫醒跑一个 **run**，跑完存好状态退出。收件箱是唯一的真相源。
- **隔离**（Fable 必须改 #1）：
  - worker 改用独立 Unix 用户 `sbot-w`，bash 套 sandbox，网络出口用 iptables 限制。
  - 所有模型调用都走核心里的 **LLM 代理**：每个 run 只拿到一个临时令牌，真正的 key 永远不进 agent 环境。用量计量和预算硬上限也放在代理里。
  - `policy/`、`config/` 搬出 agent-home，变成单独的配置仓库，任何 agent 都不能写（§7.6）。
- **防泄露和注入**（必须改 #2）：
  - 他人会话的工具按范围收窄。
  - journal 每条标注来源，dream 不能把他人的话洗成"关于我的事实"。
  - people 里跟权限有关的字段搬进配置仓库，auto 规则只保留一个真相源（§4.1、§8）。
- **审批改成非阻塞**（必须改 #3）：分两种路径（§7.2）。
  - **提交式**：`send` 立即返回"已提交 #id"，批准后由发件箱按原稿发出。
  - **挂起式**：worker 运行到一半需要审批时，用 hook `defer` 结束本次 run，批准后 resume。
  - 审批加上完整的状态机：过期、作废、替代、版本号、只认我本人点击、发件箱幂等（§7.3）。
- **harness 用法按官方文档改正**（必须改 #4，逐条核对过文档，§4.0）：
  - 闸门放在 `PreToolUse` hook 里，加 `onFailure: "block"`；`permissionMode: "dontAsk"`；不用 `canUseTool`。
  - 用 `tools` 和 `disallowedTools` 真正去掉不该有的工具；`settingSources: []`；env 从零构造。
  - 不用 SessionEnd，改用 PostCompact 拿压缩摘要。
- **收件箱的重启语义**说清楚了：有副作用的才标 `interrupted`，其余自动重试（§1.2）。
- **observer 补洞**（§3.6）：
  - 过滤我自己和 bot 发的消息；我自己回过就作废对应草稿。
  - 拉消息和 Triage 解耦；有人 @bot 立即拉一次。
  - 草稿改由 chat 档起草。
- **公司群默认 always** 保留（这是我定的），但加了缓解措施：敏感群名单和外部群默认关闭，首次启用时过一遍群列表（§3.5）。
- **微信发送防发错人**：唯一备注加窗口标题校验。边缘指令签名砍掉，改用 Tailscale ACL 加连接令牌（§6）。
- **他人请求的工作量闸门简化**：只分"自动"和"审批"两档，再加硬上限和一个"承诺检测"。每人预算后置（§7.4）。
- **新增 follow-up**：agent 可以给自己设"到点再看一眼"。heartbeat 改成纯代码检查，不再调模型。定时任务的定义和运行状态分开存，消除双真相源（§9）。
- **新增"先安静"原则**：主动消息设每日上限，被我忽略的会统计出来（§0、§9.3）。
- **里程碑重排**：先做 1～2 天探针；控制台挪到 M3，M0～M2 用 `/model`、`/group` 和直接改文件顶上。"核心 < 3k 行"改成只算内核（§14）。

<details><summary>更早的变更（v0.2～v0.6）</summary>

- v0.6：可视化配置控制台（tailscale serve）；确认以 user 身份读消息不改变已读状态。
- v0.5：飞书群改为以我的身份轮询读取，默认 `always`。
- v0.4：参考 HappyClaw 补可靠性设计；群开关；搜索优先用模型自带的。
- v0.3：模型层不绑厂商、三档；复用 harness；工作量闸门。
- v0.2：微信专属号 + Windows 边缘节点；所有审批走飞书管理群。
</details>

---

## 0. 第一性原理（v0.24 重写）

做事的 agent 很多，真正能帮人的很少。这一章定它**为什么存在**，后面所有章节都从这里推出来；和这里冲突的，以这里为准，再回头改那一章。

### 0.1 它是什么
- **一个陪我修自己的伙伴，目的是离苦得乐。** 成长说的是心上的：能力强了、事办得多了，不见得就活得更自在。它在意的是我少一点苦、多一点清明。
- **伙伴，不是"另一个我"。** 它替我办事，但不替我活；会顺着我，也会在该说的时候说一句不同的看法，在该退的时候退开。
- **底子是佛学，对外不讲宗教。** 觉察、习气、因果、无常、放下是它的立场；说出来用平常话，不用经文和术语压人。
- **只为我一个人。** 家人朋友那边是以后自然而然的事：先修自己，有了帮人的心再说（修人修自己）。

### 0.2 怎么帮：办 → 读 → 参 → 觉 → 改
```
办事（基本功，也是最好的起点）
  └► 读懂我（从几种来源主动看，§0.3）
       └► 互参（几种看法放在一起对照，补齐视角）
            └► 觉察（帮我先看见；最好是我自己先看见）
                 └► 陪着改（一点一点，在生活里改，回头再看改得怎样）──► 回到办事
```
- **办事**：把事办好是基本功，做不好就没资格谈陪伴。办事本身也在减苦：替我扛掉一件烦心事，就是实实在在的离苦。同时它是看我最真实的窗口：我怎么改、拒什么、拖什么、急什么。
- **读懂我**：先读懂，才有资格建议。读懂是一组**带证据的理解**，每条都说得出依据，我看得见、改得了、删得掉。
- **互参**：同一件事，用几种眼光去看：事实记录、AI 的推理、镜头（八字、紫微、六爻）、我自己的话。几种看法对得上，心里更有底；**对不上的地方最值得看**：要么是我没看见的，要么是某种看法在这类事上不贴。互参不是投票，也不是让镜头当裁判。
- **觉察**：最好的结果是我自己先看见。它先问、后说；我看见了的，它就不抢（§15.13）。
- **陪着改**：改落在生活里的小处，有前瞻、有回看（§15.2、§15.5），回看时我说感受，喂给下一圈。

### 0.3 读懂我从哪来
| 来源 | 看什么 | 怎么来 |
|---|---|---|
| **办事** | 它替我做的事里，我怎么批、怎么改、拒什么、拖什么、什么时候回 | 自带（§15.10、§16.2） |
| **日常** | 日程、消息节奏、和谁来往（§18）、随手记、作息；**身体**（睡眠、精力、病痛） | 已开的信息源（§17.3），加上我自己说的 |
| **镜头** | 八字、紫微、六爻：另一种看法，用来对照，不单独下结论（§15.7） | lens 插件，例行看法默认开 |
| **我说的话** | 复盘、回看、随手说的感受和看法 | 分量最重，但不是唯一来源，它也不等我开口 |

- **不等我输入**：开着的来源它主动去看。dream、reflect 自己翻时间线、账本、事件找规律，提出带证据的候选，而不是等我来报告。我会忘记说，也会不想说。
- **看可以主动，说要克制**：主动的是"看"，不是"说"。先安静（§9.3）、退后（§15.13）、我状态不好时先陪着，这些都不变。
- **来源由我开**：新的来源默认关、只读，开不开、怎么开都是我在配置里做。它可以说出自己的盲区（"这件事我只看得到工作这一面"），但不提开来源、放权限的改动（§16.3 D 级）。
- **知足**：看什么从"怎样能帮我离苦"倒推，不是越多越好。每个来源说清看什么、不看什么、留多久。想全抓住，本身就是一种执着。

### 0.4 分寸
- **放下**：理解会淡。很久没有新证据的看法不再拿来用；我说"这条放下"，它就不再提。不拿过去的我去框现在的我（§15.15）。
- **不绕着苦转**：同一件让我难受的事，它不反复翻。再提必须带来新东西：新事实、新角度、或者一个往外走的小步（§15.16）。
- **修要落在实处**：不推语录，不讲道理，不搞打卡式的修行模块。帮助落在扛事、腾时间、搭结构，以及在关键时刻提一句我自己定过的功课上。
- **建议不是安排**：发心和功课只由我定；它不替我做决定。
- **凶象不说死**：健康、法律、大额钱财上，镜头只作参考，必须同时给出事实层面的建议（§15.1）。
- **退后**：它的目标是让我越来越不需要它来提醒（§15.13）。

### 0.5 怎么算帮到了
- 只看我自己的话和一条趋势：**谁先看见**（§15.13）。不打分，不算采纳率，不把陪伴做成 KPI。
- 反过来要警惕：我越来越离不开它、越来越等它来告诉我自己是什么样，说明它走偏了。

### 0.6 基础（为上面服务的工程目标）
- 对我永远只有一个主 agent。重活交给后台 worker，主 agent 的上下文保持干净。
- 常驻一台 VPS，7×24 在线，能主动找我（定时任务、follow-up、任务完成通知）。
- 飞书 = 工作 + 审批：私聊、工作台、推送群、管理群，以及我所在的群。工作上的操作在飞书都做得完（§19.6）；生活、`self/`、命盘只在控制台和我的私聊里。
- 微信 = 私人：我和老婆朋友加 SStudioBot 好友直接找它；它被拉进群后负责整理群聊。
- 工作和私人记忆**双向打通**，合起来才看得见完整的我。
- 模型可配置，分四档（§5.1），按角色路由。
- **红尘里修**：月、周、日有前瞻；够分量的事起有方向、收有复盘，事和心都看；能顺着时间线回看（§15）。
- **越用越会办事**：agent 从我怎么用它的结果里找差距，改进自己的办法；但只能让它办得更好，不能让它权限更大（§16）。
- **先安静，再争取注意力**：宁可少打扰，等我认可了再放开。
- 代码自己能完全读懂，也能让 agent 自己提 PR 来改：**内核 < 3k 行**。飞书和微信适配器、边缘节点、前端分开计算。

### 0.7 非目标（v1 不做）
- 多用户 / 给别人用；插件市场；向量数据库。
- 聊天用的 WebUI：对话只走飞书和微信（配置控制台见 §10；控制台里的对话是 §19 的设计稿，按新 §0 重做并实现之后这一条作废）。
- 支付、转账、删除类操作（永远硬禁止）。
- 脱离生活、单独打卡式的"修行模块"（不搞野狐禅）；每日运势式的推送；语录、经文、鸡汤的推送。

---

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
| **收件箱** | 所有触发 run 的东西，持久化，是唯一的真相源 | `inbox` 表（§1.2） |
| **定时器** | 周期任务（schedule）+ agent 给自己设的 follow-up；到点**不直接跑**，而是往收件箱里投一条事件 | `timers` 表（§9） |
| **记忆** | 只存查不回来的东西 | `agent-home` git 仓库（§8） |
| **权限** | 每个工具调用：直接执行 / 拦截 / 提交审批；凭证在 agent 环境之外 | 代码里的闸门 + LLM 代理 + Unix 用户隔离（§7） |
| **发件箱** | 所有对外消息先落库再投递；出口幂等 | `outbox` 表（§7.3） |

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
- **run 进行中来了新事件**：默认排队，等下一个 run 处理。我发 `/stop` 时调用 `interrupt()`。（往进行中的 run 里插话的 `/steer` 后置，见 §14。）
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
- **控制台**：`tailscale serve`，加一个公网 443 入口（和机器上已有的 nginx 共用，密码 + 会话 cookie，§10.1）。
- **目标**：空闲约 300 MB（核心约 150～250 MB）；2 个对话 run 加 1 个 worker 构建时，峰值 ≤ 2.3 GB。

**放在哪**（全部在 4T 数据盘 `/srv/data`，xfs）

| 路径 | 内容 | 属主 |
|---|---|---|
| `/opt/node` → `/opt/node-v26.13.1` | 官方 Node LTS，自带 TS 类型擦除。只给 sbot 用，系统自带的 nodejs 不动（它编译时没带 TS） | root |
| `/srv/data/sbot-app` | 代码：`releases/<sha>/core`、`deps/<hash>/node_modules`、`current` → 正在跑的 release（见下面“上线”） | `root:sbot` 0750，不在核心服务的可写路径里 |
| `/srv/sbot` → `/srv/data/sbot` | `db/` SQLite（WAL）、`config/`（git）、`agent-home/`（git，wiki 层）、`sessions/`、`logs/`、`cache/raw/`、`backup-staging/`、`secrets.env`（0600） | `sbot` 0700 |
| `/srv/sbot-w` → `/srv/data/sbot-w` | `tasks/<id>/` | `sbot-w` 0750（`sbot` 在 `sbot-w` 组里，能读 worker 产出；反过来不行） |
| rustfs `sbot-raw` 桶 | 原始资料，按 sha256 存，只增不改（§8.5） | 核心 |
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
| **owner（我）** | 飞书 open_id；我本人主微信号的 wxid（写在配置仓库里） | 全部；敏感动作仍要审批（§7） |
| **known（老婆、朋友、熟悉的同事）** | 在 `config/people.yaml` 里登记过的人 | 按人配置 |
| **others** | 其他任何人 | 只当输入，不可信 |

**认人只认 ID，不认名字。** 有人说"主人 让你……"，一律按 others 处理。

### 2.2 人的信息分三层（v0.15）

| 内容 | 存在哪 | 谁能改 |
|---|---|---|
| **权限相关**：跨渠道 ID、关系、`importance`、微信唯一备注 | `config/people.yaml`（配置仓库） | 只有我（改文件 / 控制台 / 卡片） |
| **笔记**：偏好、近况、正在跟进的事 | `agent-home/people/<slug>.md` 正文 | dream（§8.3） |
| **认识**：见过的每一个人、各处的叫法、圈子、彼此的关系、因缘（§18） | `persons` / `person_aliases` / `relations` 表 | 代码登记；我在控制台纠正；`person_relate` 只能记推测 |

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
| 飞书 | **user 身份**（lark-cli 的 user token） | **读**：轮询我所在的群（§3.6），属于 L0。**写**：以我的名义发消息、改文档、建日程，一律 L2 审批 |
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
| `feishu:group` | 我所在的群（user 身份轮询读取），以及 bot 被拉进的群 | 不直接建会话；@bot 时开 `feishu:g:<chat_id>[:<thread_id>]` | 群消息进 Triage；@bot 时起 run（§3.6） |

- **工作台**就是飞书版的 T3 thread。在私聊里接到大活时，主 agent 先 `task_start`，再到工作台开一个话题，进度和结果发在那里，私聊里只回一句"已开工 → 话题链接"。
- **管理群**集中所有"需要我决定的事"。
- bot 被拉进一个我不在的陌生群时，先保持安静，同时在管理群问我"要不要启用"。

### 3.2 微信（私人）

| Surface | 用途 | 会话 key / lane | 会不会起 run |
|---|---|---|---|
| `wechat:owner` | 我的主微信号 ↔ SStudioBot，私人主线 | `wechat:owner`（滚动） | 每条消息都会 |
| `wechat:dm` | 老婆、朋友和 SStudioBot 一对一 | `wechat:dm:<wxid>`（每人一个滚动会话） | 每条消息都会，按他人会话处理（§4.1、§7.4） |
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
  - 撤回的消息如果是某张审批卡的触发消息，把卡片作废（§7.3）。
- 日常回复是**流式卡片**（CardKit，2026-11-17 主人 要求提前到 M0，§13.1）；命令回复和 `reply` 工具仍发普通消息。

### 3.5 群的开关（`config/groups.yaml`；管理群发 `/group` 用卡片切换）

| 维度 | 取值 | 默认 |
|---|---|---|
| `activation` | `always`：所有消息进 Triage，@ 时唤醒主 agent<br>`when_mentioned`：只处理 @<br>`digest`：只出定时摘要<br>`disabled`：完全不碰，连拉都不拉 | 飞书 `always`（免打扰群 `digest`）；微信 `always` |
| `reply` | `approve_all` / `s_auto`（他人请求按 §7.4 自动档处理） | `approve_all` |

（`audience` 维度后置。）

**默认 `always` 的缓解措施**：飞书群消息会送到第三方模型，所以加三道保护。
1. **敏感群默认 `disabled`**：群名匹配 `config/gate.yaml` 里的敏感词（默认：HR、人事、薪酬、绩效、财务、法务、董事会），以及我手动拉黑的群。黑名单优先级最高。
2. **外部群默认 `digest`**：带外部成员的群，看 `+chat-list` 每行的 `external`（布尔值，P0 已核实；我这边 614 个群里有 76 个外部群，单聊和话题群也有这个字段）。
3. **首次启用时过一遍群列表**：observer 第一次启动时，不直接开始读，而是先在管理群发一张群列表卡片，列出每个群建议的 activation，我确认后才开始。之后新加入的群按默认规则处理，同时在管理群发一条通知，可以一键改。

`groups.yaml` 是唯一的真相源，`chat_cursors` 表只存游标。

### 3.6 飞书群：以我的身份读，按需让 bot 入驻

| 群的类型 | 怎么读 | 怎么唤醒 | 怎么回复 |
|---|---|---|---|
| **观察群**：我在，bot 不在（默认） | user 身份轮询 | Triage。有人 **@我** 时一定 `notify` 或 `draft`；只 @ 了别人的最多 `notify`，只 @ 了机器人的 `archive`（§4.3） | 只能以**我的身份**回，永远审批 |
| **入驻群**：我在，bot 也在 | @bot 事件实时收 + 轮询其余消息（按 message_id 去重） | @bot 时**立即拉一次这个群**补齐上下文，再开群会话；其余走 Triage | 以 bot 身份回，按 `reply` 开关 |

**私聊**（v0.13）：别人发给我的单聊默认不读；`config/sources.yaml` 里 `feishu.dm: true` 才读，只记事件、发提醒，**不起草**（§17.3）。我和 bot 的私聊是 owner 会话，永远不走这条路。（仅 bot 群后置。）

**feishu observer**
1. **每 30 秒（可配置）用一次全局搜索拉增量**：`+messages-search --as user --query "" --start <游标-2min> --end <now>`，跨所有群和单聊，按 `message_id` 去重。
   - 为什么不按群轮询（P0 实测）：我有 1000+ 个会话；`+chat-list --sort active_time` 只给顺序，**行里没有 `active_time` 字段**，没法判断"翻到哪为止"。
   - 搜索够用：和逐群 `+chat-messages-list` 对照，2 小时窗口 62 条只差 2 条 `system`（入群提示一类，本来就不要）；12 分钟实时对照，新消息搜索 12/12 都看到，基本同一轮出现，最慢晚一轮（29 秒）；一次约 3 秒，30 秒一轮跑 288 次调用没报错、没限流。
   - 搜索会把**话题里的回复也作为独立的行**返回，在话题里的消息带 `thread_id` 和 `thread_message_position`（不在话题里就没有这个键）。搜索的行没有 `mentions` / `reply_to`。Triage 需要 `mentions` 时，按 `chat_id` 打包后用 `+chat-messages-list` 补一次。注意 `chat-messages-list` 里话题回复**不是独立的行**，只嵌在根消息的 `thread_replies` 里。
   - 搜索必须同时给 `--start` 和 `--end`，只给 `--start` 会静默返回 0 行。
   - 群成员变动、群改名这类不是消息的动静，每天用 `+chat-list` 全量对一次。
2. **写入 `messages`（`triage_status=pending`），然后推进游标**。拉取和 Triage 解耦，Triage 崩了不会漏消息，也不会重复拉。游标回退 2 分钟做重叠，靠 `message_id` 去重。
3. **过滤回环**：
   - 我本人发的消息：不进 Triage。同时把这个群里 `trigger_msg_id` 早于它的待审批草稿**作废**，因为我已经亲自回了；这里早于它的「要你回 / 拍板」事件也一起算处理了（回复的是某条具体消息时，只关那一条对应的事件，§17.2）。
   - bot 发的消息，以及 `outbox` 里记录过的消息 ID：直接标 `triage_status=skipped`。
4. Triage 定期取 `pending` 的消息，**按群打包**，一个群一批调一次 light 档，处理完标 `done`。
5. 第一次启用某个群时，只回填最近 N 天，不拉全部历史。
6. 话题回复（P0 实测）：全局搜索能看到，不用另外按话题拉。话题群里每条帖子都带 `thread_id`，不管有没有回复，所以不能拿 `thread_id` 判断"有回复"。

**事件长连接只能有一个消费者**：Mac 和 VPS 用的是同一个飞书应用。按飞书文档，长连接是集群模式、不广播，同一应用连了多个客户端时，每个事件只随机发给其中一个。所以 `event consume`（@bot 消息、卡片回调）只在 VPS 核心上跑，Mac 上不要跑。

**bot 事件（P0 实测，`im.message.receive_v1`）**
- bot 自己发的消息（文本、话题回复、卡片）**不会**回推事件，所以事件流本身不用做回环过滤；搜索那条路仍然要按 §3.6 第 3 步过滤。
- bot 在的群里，**不 @bot 的消息也会推过来**（话题里的回复也会），不只是 @。所以入驻群实际上可以全靠事件实时收，轮询只用来兜底，靠 `message_id` 去重。
- 事件字段：`chat_id`、`chat_type`、`message_id`、`message_type`、`sender_id`/`sender_type`、`create_time`；话题回复多了 `thread_id`（omt_）、`root_id`、`reply_to`（都指向根消息）；@ 消息带 `mentions`。

**user token 的托管**
- VPS 上**单独做一次 `lark-cli auth login`**，不要从 Mac 拷贝 token 文件，避免 refresh token 互相挤掉。
- lark-cli 和 token 只属于 `sbot` 用户，worker 用户读不到（§7.6）。
- P0 实测：VPS（10-30 授权）和 Mac（10-10 授权）的授权并存，互不挤掉。access token 2 小时，refresh token 7 天、每次刷新顺延，所以核心至少每周要用一次 user 身份（轮询本身就满足）。现在 VPS 上的授权在 `dev` 用户下（`~/.lark-cli`，lark-cli 1.0.98），M0 时以 `sbot` 身份重新登录一次。
- Sentinel 每轮检查 `auth status`：一旦失败或快过期，就在管理群发一张"需要重新授权"的卡片。

---

## 4. 角色与 harness

### 4.0 harness：worker 用 Claude Agent SDK，对话角色用 pi（P0 已定）

**分工**

| 角色 | harness | 原因 |
|---|---|---|
| worker、lens | **Claude Agent SDK**（定了） | 要用内置的 Read / Edit / Bash、`sandbox`、`defer` 挂起审批、skills。pi 没有权限和沙箱，这些都得自己写 |
| 主 agent、reflect、起草、Triage、expert、dream | **pi 1.5.2**（`createAgentSession`，在核心进程里跑，每条 lane 一个常驻 session），2026-11-16 P0 对比后定（§13） | 见下 |

**对话角色为什么用 pi**（P0 实测：`probes/RESULTS.md`）
- **SDK 的长处它们用不上**：这些角色不用任何内置工具，不要 sandbox，审批走提交式，也不用 `defer`。现在为了用 SDK，反而要花力气把东西关掉（`tools: []`、`settingSources: []`、一长串环境变量），而且每个 run 都要起一个 CLI 子进程。
- **红尘里修的核心是"上下文怎么拼"**：本月和本周的前瞻、时间线片段、认可过的习气和节律、心得。pi 能直接控制每次请求带什么：`context` 事件每次调模型前都能改消息，`before_agent_start` 能换 system prompt，`session_before_compact` 能自己写压缩摘要，保证发心、本月留意这些锚点在压缩后还在。SDK 里压缩基本是黑盒，只能事后拿摘要。
- **不绑厂商**：pi 原生支持多家协议。chat 档如果用的不是 Claude，就不必经过 Claude Code 那套为 Claude 调过的提示词和工具约定。
- **能读懂**：pi 的核心很小，和"代码自己能完全读懂"的目标一致。
- **轻**：pi 在核心进程里只发 HTTP 请求。SDK 每个 run 要起一个 CLI 子进程，实测常驻 230～320 MB，冷启动 1～3 s。对单机部署（§1.3）来说，这一条分量很重。

**代价和对策**
- pi 迭代快：包名从 `@mariozechner/*` 迁到了 `@earendil-works/*`，事件也改过名。对策：锁定版本，所有调用都包在一层 `Runner` 接口后面。
- pi 没有权限系统（1.5.2 起有可选的 MCP 扩展，我们不用）：我们的工具本来就是自己写的 TS 函数，直接注册就行；闸门放在工具包装层（见下）。
- pi 会从 `~/.pi`、`.pi/` 自动发现扩展、skills 和 `AGENTS.md`：✅ 已核实能关掉。做法如下：
  - `DefaultResourceLoader({ noExtensions, noSkills, noPromptTemplates, noThemes, noContextFiles, systemPrompt, extensionFactories: [我们的] })`，再配上私有的 `agentDir`。
  - 模型写在 `agentDir/models.json` 里：provider `sbot`，`api: anthropic-messages`，`baseUrl` 指向 LLM 代理，`apiKey: "$SBOT_RUN_TOKEN"`（从环境变量插值，令牌不落盘）。
  - `noTools: "builtin"` 加上 `customTools`。
- **工具 schema 只写一次**：用 zod 写，SDK 那边直接用；给 pi 时经 `z.toJSONSchema` 转成 JSON Schema，再包一层 `Type.Unsafe`。
- 两套会话格式：`sessions` 表记录 `harness` 和 `session_ref`，滚动换代时两边各自处理。

**与 harness 无关的一层**（两边共用，换 harness 不动它）
- `Runner.run({ lane, role, tier, session_ref, input, tools, budget })` → `{ output, side_effects, usage, session_ref, stop }`。
- **工具只定义一次**：一个 TS 函数加一个 schema。适配到 SDK 时包成 in-process MCP，适配到 pi 时用 `customTools` / `registerTool`。
- **闸门放在工具包装层**：我们自己的工具，在函数执行任何副作用之前先过闸门（分级、提交审批、计数），两种 harness 一样生效，也不依赖 hook 出错时的语义。只有 worker 的内置工具（Bash、Edit……）才另外靠 SDK 的 `PreToolUse`。
- 模型请求一律打 LLM 代理（§5.2），用每个 run 的临时令牌。

#### 4.0.1 Claude Agent SDK 的用法（worker、lens；对话角色如果最后也用 SDK，同样适用。按官方文档核对过）

| 需求 | 用 harness 的什么 | 自己写的部分 |
|---|---|---|
| agent loop、工具调用 | `query()` | 无 |
| 会话续接 | `resume` | session key ↔ sdk_session_id 映射；resume 失败时的兜底（§1.2） |
| 上下文压缩 | 自动 compaction + **`PostCompact` hook**（拿到 `compact_summary`） | 摘要写进 journal |
| 出口闸门 | **`PreToolUse` hook**，设 `onFailure: "block"`（需要 TS SDK ≥ 0.3.317） | 分级、审批、计数 |
| 运行中途审批 | PreToolUse 返回 **`defer`** → `stop_reason: "tool_deferred"` → 不带 prompt 地 resume，hook 再次触发并给出 allow/deny | 审批状态机（§7.2） |
| 自定义工具 | in-process MCP（`createSdkMcpServer` + `tool()`），工具代码在核心进程里执行 | 记忆、任务、消息、审批、定时器 |
| 干活的工具 | worker 用内置 Read / Edit / Write / Bash / Grep / Glob + `sandbox` | 无 |
| 后台长任务 | — | **Task Engine**。harness 自带的后台 subagent 会随进程一起消失，不用它 |
| 搜索 / 抓取 | 内置 WebSearch / WebFetch | 探测不通时的兜底工具（§5.4） |

**harness 使用纪律**
- **权限模式统一用 `dontAsk`**，不传 `canUseTool`。官方文档写明：被 `allowedTools`、allow 规则或权限模式自动批准的调用**根本不会到 `canUseTool`**，所以 `canUseTool` 不适合做闸门。在 `dontAsk` 下，任何需要询问的调用都直接拒绝，不会有调用挂着等回调。
- **闸门只放在 `PreToolUse`**，并且设 `onFailure: "block"`。hook 默认出错放行，`block` 之后出错就拦截。
- **工具可见性**：
  - 用 `tools: [...]` 明确列出要哪些内置工具，再用 `disallowedTools` 写裸工具名兜底（裸名会把工具定义从请求里删掉）。
  - `allowedTools` **只用来自动批准**我们自己的 MCP 工具（`mcp__sbot__*`）。它本身不限制模型能用哪些工具。
- **`defer` 的实际行为**（P0 实测，SDK 0.3.325 / CLI 2.1.325，见 `probes/RESULTS.md`）：
  - 恢复方式：`query({ prompt: "", options: { resume } })`。传空的 AsyncIterable 会失败（`tool_deferred_unavailable`）。恢复后同一个 `tool_use_id` 会再过一次 hook。
  - **并行调用时 defer 并没有被忽略**（和原来的假设相反）：模型一轮里发两个要审批的调用，hook 两个都返回 defer，结果只报告其中一个，另一个**静默丢失**（不执行，也不算拒绝）。
  - **对策（已验证）**：闸门按 session 加一把锁，同一时刻只允许一个调用 defer（同步写入，在任何 await 之前），其余直接 deny，理由写明"这个没做，等当前审批结束后重试"。模型会在批准后自己重试。需要审批的工具照旧不放进 `allowedTools`。
- **`settingSources: []`**：任何 run 都不读磁盘上的 settings 和 CLAUDE.md（默认值是"全部来源"，worker 在别的仓库的 worktree 里干活时会加载那个仓库的配置）。system prompt 由我们自己拼。skills 用 `plugins` 选项加载，**每个 run 必须同时传 `skills` 白名单**（P0 已验证，见下）。
  - 镜头打包成只读插件 `/opt/sbot/plugins/sbot-lens`（root 所有，worker 只能读；`deploy/lens/build.sh` 从 Mac 上的 skill 源和 kb 构建，把写死的 Mac 路径改成安装路径）。放在 agent-home 外面，worker 读得到但改不了。
  - `settingSources: []` 时 CLI **仍然会带上它自带的插件和 skill**（`deep-research`、`dataviz`、`claude-api`、`update-config` 等 16 个，init 里都会列出来）。`skills: [...]` 白名单生效后，模型看到的列表只剩白名单里的；调白名单外的 skill，Skill 工具直接报错 `not in this session's skills allowlist`。所以 `skills` 永远显式传，不用 `'all'`。
  - init 里的 `skills` 列的是"发现了哪些"，不是"模型能用哪些"，不能拿它判断白名单。需要的设置通过 `settings` 选项传入（如 WebFetch 的 `skipWebFetchPreflight` 和 `env.HTTPS_PROXY`，见 §7.6）。**不传 `cleanupPeriodDays`**：`settingSources: []` 下没有任何来源提供它，CLI 就跳过转录清理（P0 实测），挂起的会话不会被清掉。旧转录随任务目录由核心 GC 删除。
- **env 从零构造**：`env` 是整体替换，不是合并。每个 run 只给：
  ```
  PATH, HOME, LANG, TZ                   # 显式给，不继承宿主
  CLAUDE_CONFIG_DIR = <按角色/任务独立的目录>   # 不碰宿主的 ~/.claude
  ANTHROPIC_BASE_URL   = http://127.0.0.1:7811/llm     # LLM 代理（§5.2）
  ANTHROPIC_AUTH_TOKEN = run_<随机>                    # 这个 run 的临时令牌（Bearer）
  ANTHROPIC_MODEL      = sbot-<tier>                   # 档位别名，由代理换成真实模型
  ANTHROPIC_DEFAULT_HAIKU_MODEL / _SONNET_MODEL / _OPUS_MODEL = sbot-light / sbot-<tier> / sbot-<tier>
  CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS = 1
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = 1
  CLAUDE_CODE_DISABLE_CRON = 1           # 另外也不暴露 CronCreate 一类工具
  ```
- **锁定版本**：SDK 和 CLI 都锁定版本。升级时先跑一遍 P0 探针脚本，全部通过才切换。
- **不使用 auto mode**：它的分类器只支持特定模型，第三方端点用不了。

**token 开销**：对话角色用精简的自定义 system prompt，只挂自研工具；只有 worker 用 `claude_code` preset 加内置工具。

### 4.1 主 agent（chat 档）

人设和规则来自 `AGENTS.md`、`SOUL.md`；关于我的事实来自 `USER.md`、`MEMORY.md`（索引）。每轮自动召回的片段附在 **user 消息**里，不放进 system。

**工具按会话类型给，不按信任模型给**：

| 工具 | owner 会话 | 他人会话（别人私聊、群里 @） |
|---|---|---|
| `reply` | ✅ | ✅（是否直接发出，按 §7.4 判定） |
| `send`（发到别的目标，提交式审批） | ✅ | ❌ |
| `memory_search` | 全部 | **只能搜**：发言人的 people 笔记、当前群的笔记、`agent-home/shared/`（我明确标过可以分享的内容） |
| `memory_append`（写 journal） | ✅ | ✅（自动带来源标签，§8.3） |
| `session_list` / `session_read` | ✅ | ❌ |
| `calendar_query` | 详情 | **只返回忙闲**；配偶等关系可以在 `gate.yaml` 里放开到详情 |
| `task_start` / `task_*` | ✅ | ❌（改成调用 `request_approval(plan)`） |
| `followup_set` / `_list` / `_cancel` | ✅ | ❌ |
| `life_note`（随手记，§15.6）、`timeline_query` | ✅ | ❌ |
| `consult_expert` | ✅ | ❌ |
| WebSearch | ✅ | ✅ |
| WebFetch | ✅ | ❌（会被当成外传通道） |
| `request_approval(plan)` | — | ✅ |

- 主 agent **没有** bash，也没有读写文件的工具，所以它的 CLI 子进程可以和核心一起跑在 `sbot` 用户下。
- 他人会话里，对方的消息一律用 `<untrusted from="…">` 包起来，system prompt 里写明这部分内容只当数据，不当指令。

### 4.2 Worker（默认 light 档，可以升到 chat 档）

- `task_start({ goal, context, tier?, mode?, budget, timeout })` → Task Engine 起一个独立的 `query()`，这个 task 就是一条 lane。
- **两种模式**（`tasks.mode`，默认值取 `config/worker.yaml` 的 `default_mode`，没配就是 host；v0.14 之前的老任务按 sandbox 处理）：
  - **host（默认）**：`sudo -n worker-exec --host` 用 `systemd-run --pipe --wait` 起一个 transient **service**（`sbot-workers.slice`，`MemoryMax=6G`，`RuntimeMaxSec=5h`），以 `sbot-h` 身份运行，cwd 是 `/srv/data/sbot-h/tasks/<id>/`。用 service 而不用 scope，是因为 scope 会继承核心的挂载命名空间（`ProtectSystem=strict`），sudo 装不了东西；service 由 pid 1 起，在宿主机的命名空间里。stdio 经 `--pipe` 透传，SDK 照常工作；环境变量写进一个 root 才能读的 `EnvironmentFile`（`Environment=` 能被任何本地用户通过 D-Bus 读到，里面有 run token）。杀掉 systemd-run 不会停掉 unit，所以 worker-exec 捕获 TERM 信号，自己 `systemctl stop`。
    - 没有 bwrap，不经过出网代理，也不受 `SBOT_W` 链限制，公网、DNS、tailnet 全通，有完整 sudo（`/etc/sudoers.d/sbot-h`）。HOME `/srv/data/sbot-h/home` 持久保留：`~/.local/bin`、CLI 登录状态、ssh key（`install.sh` 生成，公钥由我加到要登录的机器上）。
    - ssh 主机：核心在每次 run 之前按 `worker.yaml` 的 `ssh_hosts` 生成共享目录里的 `ssh_config`（`BatchMode`、`StrictHostKeyChecking accept-new`），worker-exec 再把它复制成 sbot-h 自己名下的 `~/.ssh/sbot_hosts`，由 `~/.ssh/config` include 进来。不能直接 include 共享那份，因为 ssh 只认属主是本用户或 root 的配置文件，而核心改不了属主。worker 直接 `ssh mac` 就行。`host` 填 tailnet IP：这台服务器没开 MagicDNS（`--accept-dns=false`），`*.ts.net` 的名字解析不了。
    - **核心守卫**：一个 PreToolUse hook 拦截 Bash 命令，以及 Read/Write/Edit/Glob/Grep 的路径参数中指向核心位置的调用（`/srv/sbot`、`secrets.env`、`/run/sbot`、`/proc/*/environ`、lark-cli）。只看工具要去哪里，不看写进去的内容，所以改本仓库里提到这些路径的文档照样能改。worker 规则里也写了"有 sudo 也不碰"。这是软边界（§7.6）。
  - **sandbox**：就是下面原来那套，以 `sbot-w` 用户运行。任务要把不可信内容（陌生网站、别人的仓库、别人发来的文件）喂给 worker、而全权限又可能闯祸时，用这个模式；主 agent 拿不准时先问我。
- **skill 和 CLI（两种模式都有）**：核心在每次 run 之前把 `config/skills/<名字>/` 复制到 `/srv/data/sbot-shared/worker-plugin/skills/`（全员可读、只有核心能写；先建一份新的再换上去），用 SDK 的 `plugins` + `skills` 选项加载。`skills` 始终显式传：默认是 `config/skills` 下的全部，也可以在 `worker.yaml` 里列名字或写 `all`（`all` 会连 CLI 自带的也打开）。`worker.yaml` 的 `path` 通过 `settings.env.PATH` 加在 PATH 前面。
- **sandbox 模式的隔离**（§7.6）：
  - 以 `sbot-w` 用户运行（P0 已验证）：SDK 的 `spawnClaudeCodeProcess` 把 CLI 改成 `sudo -n /usr/local/lib/sbot/worker-exec <args>`。这个 root 所有的包装脚本校验 cwd 是 `sbot-w` 的任务目录，再用 `systemd-run --scope`（`sbot-workers.slice`，`MemoryMax=1G`）+ `setpriv` 切到 `sbot-w` 去跑锁定版本的 CLI（`/opt/sbot/claude-code/<ver>/claude`）。sudoers 只放行这个脚本和 `task-mkdir`，环境变量只保留 `ANTHROPIC_*`、`CLAUDE_*`、`LANG`。in-process MCP 和 hook 走 stdio，跨 sudo 照常工作。安装文件在 `deploy/worker/`。
  - bash 套 SDK `sandbox`（bubblewrap），`failIfUnavailable: true`、`allowUnsandboxedCommands: false`。
  - 工作目录 `/srv/sbot-w/tasks/<id>/`，`CLAUDE_CONFIG_DIR` 也放在里面。`HOME` 固定为 `/srv/sbot-w/home`，不放在任务目录里（sandbox 会屏蔽可写路径下的 shell rc 文件，放进去 bash 每次都报 `.bashrc: Permission denied`）。
  - PATH 里**没有 lark-cli**，也没有任何凭证（host 模式同样不给，对飞书的动作仍然走核心工具和审批）。
- **任务进度文件**：worker 要维护 `progress.md`，写明做完了什么、还剩什么。中断后续跑、或者 needs_input 之后重开时，下一个 run 先读它。
- **对外动作走核心工具**：比如 `feishu_doc_write`、`git_push`。这些都是 L2：PreToolUse 返回 `defer`，任务进入 `waiting_approval`，批准后 resume（§7.2）。
- **改代码**：
  - worker 只在自己的 worktree 里提交，**没有 push 凭证**。
  - 批准后由核心推送：核心从 worker 的 worktree 把分支 fetch 到自己的镜像仓库，带 `core.hooksPath=/dev/null` 再推送。**核心从不在 worker 目录里执行 git 命令**。
  - 改 SStudioBot 自己的代码只能走 PR，由我来 merge。
- **交报告**：结束时调用 `submit_report`（结论、改动、验证、未完成），Task Engine 往发起它的 lane 投一条 `task_done` 事件。
- **不能直接问人**：遇到需要我决定的事，以 `needs_input` 结束，由主 agent 来问我；拿到答案后 resume 同一个 session 接着跑。
- **上限**：
  - 轮数、超时、无输出看门狗由 Task Engine 管。
  - token 预算由 LLM 代理硬性执行，超了直接拒绝请求。
  - 并发：每个会话最多 3 个未结束的任务，全局最多 5 个。其中同时在跑的 worker 进程最多 2 个，默认 1 个，其余排队；每个 `MemoryMax=1G`（§1.3）。

### 4.3 Triage（light 档，无工具）
处理不是发给 agent 的大量消息（飞书观察群、微信群）。**只做分类，不起草**：

```
pending 消息 ──► 规则预筛（不调模型：黑名单、@我、@bot、关键词）
             └─► Triage（一个群一批）──► ignore | archive | notify | draft | escalate
```
- `notify`：等窗口，到点没回应就攒一批推给我。
- `draft`：等窗口，到点没回应才交给 **chat 档**做一次"起草 run"（只带当前群的上下文和他人会话的工具范围），产出审批卡片。
- `escalate`：默认不等，开一个主 agent 会话来处理。信息源的消息不走这条，封顶到 `notify`（§17.3）。

v0.13：同一次调用还出**事件**（§17.2）。一批里有意义的时刻记成 kind × level，挂到我手上的某件事（只能填正在进行的事的编号）或一个话头上。分拣的输入除了群，还有开了的私聊和 sources.yaml 里的信息源，都按"一个地方一批"；草稿只在群里起，私聊和信息源只记事件、发提醒。提醒按事 / 话头分组，要你回、要你拍板的排在前面。模型挂了就按规则兜底：@我 的记成「要你回」，摘要用原文。

**说给谁的，由代码定**（2026-11-18）：模型看到「@某人 查一下」容易当成在找我。所以「这条是不是对我说的」不交给模型，代码按 mentions 判断，模型的结论只能往下压，不能越过上限。
- 飞书 mention 的 id：人是 open_id（`ou_`），机器人是 app_id（`cli_`）；我的 id 是 open_id，两条路（搜索、事件）一致。
- @ 了我（或信息源标了 `to_me`）：至少 `notify`，不设上限。
- 没 @ 我、只 @ 了别人（人）：最多 `notify`，事件最多「要盯」，不起草、不上报。
- 没 @ 我、只 @ 了机器人：最多 `archive`，事件最多「知道就行」。那是在叫机器人干活。
- 没 @ 任何人（包括 `@所有人`，它不进 mentions）：不设上限，照常交给模型。
- 给模型的每一行标出对象：`[@我]`、`[@别人：甲、乙（机器人）]`；机器人发的消息，名字后标「机器人」。一个事件里有几条消息时，事件的上限取其中最宽的那条。

**注意力窗口**（v0.16）：有些消息我自己会读会回，要提醒的是我没回、漏掉的。所以分拣后不马上打扰，牺牲一点及时性。

```yaml
# config/gate.yaml
attention:
  wait_minutes: 30             # notify、draft 等多久，0 = 不等
  escalate_wait_minutes: 0     # escalate 等多久
  places:                      # 单独调：群 chat_id、信息源 id、某个信息源的「id:where」、feishu_dm（别人发给我的私聊）
    oc_example: 10
    jira: 60
    feishu_dm: 15
```

- 窗口从消息发出的时间算（一个事件取它最后一条），不从分拣的时间算。最具体的设置优先：chat_id / 信息源的某处 > 信息源 id > `feishu_dm` > `wait_minutes`。
- 到点复查（`responseTo`，规则见 §17.2）：已回应、事件已关或已放弃，这条记 `answered`，什么都不发，也不起草。`triage_action` 保留分拣当时的判断，§16 的评估照旧读它。
- 还在等我：`notify` 进下一批提醒，批次之间至少隔 10 分钟，一条提醒只发一次；`draft` 开始起草，一轮最多 3 个，其余下一轮；`escalate` 进我的私聊。
- 起草时带上窗口期间群里后来说的话，别人已经答了就输出【不回复】，转成提醒。
- 草稿发卡片后，我说了别的话会让卡片作废（§7.3）；如果那句话没回应这件事，事件还开着，它转回提醒，不会就此消失。
- `escalate` 的等待取 `escalate_wait_minutes` 和这个地方窗口的较小值：某处设了 0，那里的紧急消息也不等。
- 窗口只决定什么时候提醒、什么时候起草，审批闸门不变：草稿照样要我在卡片上点发送。
- 缩短窗口算放宽，管理群单独提醒（§10.3）。

### 4.4 Expert（expert 档，无工具）
- **待审材料由代码直接塞进 prompt**（草稿、diff、计划、日志），不给任何读文件的工具；`maxTurns` 很小。
- 输出 `{ verdict: pass|revise|block, issues[], suggestion }`。
- 触发条件见 §5.5。

### 4.5 Reflect 与 Lens（陪伴相关的两个角色，§15）
- **reflect**（chat 档；月前瞻、月复盘和大事起局可以走 expert）：负责前瞻、起局、复盘和回溯，没有文件工具，只在 owner lane 里跑。
  - 读事实的工具：`timeline_query`（§15.6）、messages、outbox、approvals（包括我改过的草稿和拒绝理由）、日历、matter 文件，以及 `self/` 里允许读的部分。
  - 写的工具：`outlook_submit`、`matter_update`、`review_submit`、`followup_set`、`habit_propose` 和 `rhythm_propose`（都只能提候选）。
- **lens**（受限 worker）：排盘要执行脚本，所以按 worker 的方式跑在 `sbot-w` 下，套 sandbox。
  - **网络全关**：它手上可能有出生信息，不能有任何外传通道。
  - 输入：需要生辰的方法才拿到 `config/self.yaml`（含换算好的 `chart_input`）和 `self/charts/` 的只读副本；都有对应镜头的 skill 和 `self/lens-notes/<lens>.md`。
  - 输出：用 `submit_reading` 交回统一格式的结果（§15.7）。

---

## 5. 模型层

### 5.1 四档与角色路由

2026-11-17 由三档改成四档（我的判断：执行类的活至少要 sonnet，读的活 haiku 就够，日常对话做总控用 opus 更靠谱，专家先保持 opus 当第二视角）。

| 档位 | 定位 | 用在哪里 | 现在的模型 |
|---|---|---|---|
| **chat** | 总控，日常对话 | 主 agent（含起局、复盘、前瞻的对话）、升档后的 worker | opus |
| **work** | 执行 | worker（默认）、草稿起草和按批注改稿、镜头解读、dream、§16 起草回放 | sonnet |
| **light** | 读 | Triage、起草后的检查（承诺检测）、群摘要、会话收尾摘要、`web_search`、§16 分拣回放、Claude Code 内部的小模型调用 | haiku |
| **expert** | 第二意见，只在特定场景把关 | §5.5；§16 提案和评审；月复盘、大事起局（可选） | opus |

- run 令牌只能用自己那档和 light（Claude Code 的小调用）。`task_start` 只能选 work / chat，默认 work；旧任务行里的 `light` 按 work 跑。
- `test/tiers-smoke.ts` 实测四档各自打到配置的模型、账本记对档位、越档 403。

**不绑定厂商**：四档都是"一个 Anthropic 协议端点 + 一个模型名"，协议转换由我自己处理。

### 5.2 LLM 代理（凭证代理）

所有 run 的模型请求都打到核心里的代理 `127.0.0.1:7811/llm`，再由代理转发到真实端点：

1. **校验令牌**：每个 run 一个随机令牌，绑定 `{run_id, tier, requester, 预算, 过期时间}`。run 结束时令牌作废。
2. **换模型**：把请求里的 `sbot-<tier>` 换成该档配置的真实模型名。改配置后下一个请求就生效，不用改 env。
3. **加凭证**：按端点配置加 `x-api-key` 或 `Authorization: Bearer`，原样转发（包括流式）。
4. **计量**：从响应的 `usage` 里记 token，乘上 `models.yaml` 里的价格表，写进 `usage` 表，按 run / 任务 / 请求人汇总。
5. **硬上限**：超出这个 run 的预算、他人请求的全局日预算或全局日预算时，直接返回错误，run 随之结束，Sentinel 发告警。
   - **状态码用 403 `permission_error`，不要用 429。** P0 实测（2026-11-16）：返回 429 时，Claude Code 会退避重试，每个 query 大约重试 10 次、拖 2.5～3 分钟才以 `api_error` 结束；返回 403 时立刻失败，3 个 query 总共 15 s。
   - 用 403 时 CLI 报的是"Failed to authenticate"，这个文字不可靠。所以 run 是怎么结束的，以代理账本为准：令牌被标成 `budget_exhausted`，Session Manager 查到之后提交"没做完"的卡片，而不是去解析 CLI 的报错。
   - 代理的计量要算上**上游自己加的系统提示**：实测一个 2 token 的请求也会带出 2～3k 的 cache 读写。

这样一来：
- 真正的 key 只存在核心进程里。
- worker 就算拿到自己的令牌，也只能在预算内、在 run 存活期间调模型。
- 预算控制不依赖 hook 计数，也不依赖模型自觉。

### 5.3 配置（`config/models.yaml` + `/srv/sbot/secrets.env`）

```yaml
endpoints:
  main-gw:   { base_url: https://..., auth: x-api-key, key_ref: MAIN_GW_KEY }
  expert-gw: { base_url: https://..., auth: bearer,    key_ref: EXPERT_GW_KEY }

tiers:
  chat:   { endpoint: main-gw,   model: <待定>, effort: medium, price: { in: ?, out: ? } }
  work:   { endpoint: main-gw,   model: <待定>, effort: medium, price: { in: ?, out: ? } }
  light:  { endpoint: main-gw,   model: <待定>, effort: low,    price: { in: ?, out: ? } }
  expert: { endpoint: expert-gw, model: <待定>, effort: high,   price: { in: ?, out: ? }, daily_limit: 20 }

capabilities:            # 由探针脚本填写，也可以手动覆盖
  chat:   { vision: ?, forced_tool: ?, server_web_search: ?, web_fetch_ok: ?, context: ? }
```

- `secrets.env` 权限 600，属主 `sbot`，不进 git。
- **备用模型（可选，默认不配）**：档位下加 `fallback: { endpoint?, model, price? }`。代理看到主模型报**用量上限**（HTTP 错误，或 200 流里的第一条 error 事件）时，把这次请求原样改发给它；普通 429、5xx 不切，那些等一等就好。切换只发生在这一次请求，会话和 `runs.model` 不变。
  - 可能换计费端点，所以由我决定填不填。预算机制不变：令牌预算、日上限照旧，账本记实际用的端点、模型和价格（`price` 不写就用本档的），主模型那次失败也记一行（0 token）。
  - 备用也失败时，调用方拿到的还是主模型的上限错误，走自己的重试规则。没配 `fallback` 时响应原样透传，一个字节都不多读。
  - 限制：带 thinking 签名的历史换模型会被拒（§5.4），这种请求等于没切成。
- **M0～M2 阶段**：直接改文件，加上飞书 `/model` 卡片（只能看配置、切换档位里的模型名、触发探针）。控制台里的「模型」页放到 M3。

### 5.4 按能力降级

| 能力缺失 | 降级方式 |
|---|---|
| `vision: false` | 用一个支持 vision 的档位先把图片转成文字；哪档都不支持就只存图，回复里说明看不到 |
| `forced_tool: false` | 结构化输出改用"提示词约束 + 代码校验 + 失败重试一次" |
| `server_web_search: false` | **默认用模型自带的搜索**（WebSearch 的服务端工具由转换层映射）。P0 实测 上游的 claude 档原样支持 `web_search_20250305`。对话角色在 pi 上，没有内置 WebSearch：核心的 `web_search` 工具就照 Claude Code 的做法，经 LLM 代理发一次带 `web_search_20250305` 的 Messages 调用，把结果整理后返回。哪档不支持，再换成自接搜索 API |
| `web_fetch_ok: false` | P0 实测：关闭非必要流量后 WebFetch 仍可用，但默认会直连目标网站和 api.anthropic.com（域名检查）。worker 里固定 `skipWebFetchPreflight: true` + `settings.env.HTTPS_PROXY` 走核心出网代理（§7.6）。对话角色（pi）用自研的 `web_fetch`（核心抓取 + 转 markdown），同样走出网代理的白名单和日志 |

**换模型后会话怎么办**：thinking 块的签名换了模型就会失效。所以某个档位换模型后，这一档的滚动会话在下一个 run 自动开新 session，旧会话的要点用摘要带过去。

### 5.5 Expert：什么时候出来把关（触发条件写在代码里）

| 场景 | 触发条件 | 审什么 |
|---|---|---|
| 重要的对外发言 | 收件人 `importance: high`；或者承诺检测命中（§7.4） | 审批卡片上的草稿，expert 意见一起显示在卡片上 |
| 代码交付 | worker 申请 `git_push` 之前 | diff 和任务目标 |
| 核心记忆变更 | dream 要改 USER.md | diff |
| 主动求助 | `consult_expert`，或者我说"让专家看看" | 当前问题 |

（"发到工作群就审"这一条去掉了，否则 daily_limit 很快会被耗光。"大任务审计划""连续失败诊断"后置。）超过 `daily_limit` 后只执行我手动触发的，被跳过的在卡片上标"未经专家把关"。

---

## 6. 微信（SStudioBot 专属号 + Windows 边缘节点）

### 6.1 账号与机器
- 专属微信号 + 一部备用手机。新号先养一阵，不批量加好友，不群发。
- Windows 电脑：
  - 常开不睡眠，保持一个**解锁的交互式桌面**（UIAutomation 在锁屏下、RDP 断开后都不能用）。
  - 微信锁定在 4.0.x 的兼容版本，关闭自动更新。
  - 装 Tailscale，边缘进程常驻。
- **连接安全**：用 Tailscale ACL 规定只有 Windows 节点能连核心的 bridge 端口，连接时再带一个共享令牌。不再做逐条指令签名。

### 6.2 读（wechat-reader）
- 解密本地数据库后轮询，覆盖所有私聊和群，不依赖窗口。**这一步的可行性在 P0 验证**，它是整个微信方案的前提。
- 新消息推给核心，写进 `messages` 和 `inbox`。
- 原始聊天记录只存在核心 SQLite 里，不进记忆文件。
- **用来确认发送结果**：sender 发完后，如果在 60 秒内读到自己发出的那条消息，就把发件箱记录标为 `sent`（§7.3）。

### 6.3 写（wechat-sender）
- 用 wxauto 4.0 系的 UIAutomation 实现，只执行核心下发的发件箱条目。
- **防发错人**：
  - 每个会发消息的联系人在微信里设一个**唯一备注**（`config/people.yaml` 的 `wechat_remark`，带短 ID，比如 `老婆#w01`）。
  - 用备注搜索并打开聊天，**在输入之前校验窗口标题和备注完全一致**，不一致就中止，标为 `failed` 并告警。
  - 群用群备注，同样处理。
- 限速：每分钟最多 3 条，另设每日上限；模拟真人节奏。
- 边缘离线时，条目留在发件箱，到期（§7.3 的 `send_by`）就作废并通知我。

### 6.4 帮老婆和朋友
- 她们直接加 SStudioBot 好友，每人一个滚动会话，按**他人会话**的工具范围（§4.1）和自动 / 审批规则（§7.4）处理。
- 陌生人加好友：发审批卡片，由我决定。

### 6.5 群聊整理
- 每个群一份 `groups/wx-<id>.md`（群是干嘛的、关键人物、持续在聊的话题）。
- 定时任务出摘要：私人群推到微信 owner 会话，工作相关的群推到飞书工作台。

---

## 7. 权限、闸门与审批

**核心原则：限制写在代码和操作系统层面，不靠 prompt。**

### 7.1 动作分级

| 级别 | 例子 | 处理方式 |
|---|---|---|
| L0 自由 | 回复当前 lane 里的我；读记忆；写 journal；搜索；以 user 身份读群消息 | 直接执行 |
| L1 内部写 | worker 在自己的 worktree 里改代码、提交；建飞书文档草稿（bot 身份、仅自己可见） | 直接执行，事后汇报 |
| L2 对外 / 以我名义 | 在群里回复；SStudioBot 给别人发微信；用 user token 发消息、改文档、建日程；push 代码 | **审批**；命中 auto 规则或 §7.4 自动档时除外 |
| L3 硬禁止 | 转账支付、删除他人内容、退群、改权限、读凭证 | 工具层根本不提供 |

### 7.2 两种审批路径

**A. 提交式（主 agent、起草 run、他人会话）**：这是默认路径。
1. `send(target, text)` 或 `request_approval(plan)` → 代码判定级别。
2. L0 直接进发件箱。L2 写一条 `approvals(pending)`，发卡片，**工具立刻返回"已提交审批 #12"**。run 照常结束，lane 不会被卡住。
3. 我点"发送"后：
   - `send` 类：发件箱**原样发出批准时的那个草稿版本**，不经过模型。
   - `plan` 类：往原 lane 投一条 `approval` 事件，起一个新 run，带上批准的计划和新预算去执行。

**B. 挂起式（worker 运行到一半需要做 L2 动作）**
1. worker 调用 `git_push` 一类工具 → PreToolUse 返回 `defer` → run 以 `tool_deferred` 结束，任务进入 `waiting_approval`，发卡片。
2. 等待期间不占用任何进程，其他 lane 照常运行。
3. 我做出决定后，**不带 prompt** 地 resume 这个 session。同一个工具调用会再次触发 PreToolUse：
   - **批准**：**核心自己执行这个动作**（比如从 worker 的 worktree fetch 再 push），hook 返回 deny，reason 里写"审批 #N 已批准，核心已代为执行，结果：…，不要再调用"。模型据此汇报完成。
   - **拒绝**：hook 返回 deny，附上我的意见。
   - 为什么批准时不返回 allow 让 CLI 去跑工具：P0 实测（`probes/worker-isolation.ts` W3）resume 时 CLI 总是报 `Deferred tool resume: tool 'mcp__sbot__…' is no longer available`（in-process MCP 还没连上），之后 allow 的调用约 15～25% 会变成"用户拒绝了这个操作"，**跟 sudo 无关**（不套包装脚本也一样），`MCP_CONNECTION_NONBLOCKING=false` 也没用。核心代执行 + deny 带结果：10/10 正常，动作也只执行一次（执行权本来就在核心，§4.2）。
4. 审批过期，按 deny 处理。

### 7.3 审批状态机

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
- **作废**：observer 看到我在同一个 chat 里、晚于 `trigger_msg_id` 发过言（§3.6），就把对应卡片作废并更新显示。
- **发件箱幂等**：`outbox` 对 `approval_id` 加唯一约束，一个审批最多发一次。
- **发送时限**：每条都有 `send_by`（聊天回复默认 2 小时）。批准了但到期还没发出去（比如 Windows 离线），就作废，并在卡片上标注。
- **结果不确定时不重试**：微信 UI 自动化发完不一定知道成没成功，这时标为 `unknown`，等 reader 确认（§6.2）。确认不了就告警由我处理，**绝不自动重发**。
- **卡片内容**：渠道、发给谁、用谁的身份、草稿原文、触发来源、引用了哪些记忆、expert 意见、承诺检测结果。按钮：发送 / 拒绝 /（M5 起）以后这类自动。

### 7.4 他人发起的请求（简化后的工作量闸门）

**适用范围**：会话的发起人不是 owner，包括 `wechat:dm`、群里 @、Triage 起草。

只分两档：

| 档 | 条件（必须全部满足） | 处理 |
|---|---|---|
| **自动** | ① 这个 surface 允许自动（`wechat:dm` 的 known 人默认允许；群按 `reply: s_auto`）<br>② 在硬上限内完成：`maxTurns ≤ 6`、工具调用 ≤ 4 次（hook 计数）、token 在这个 run 的预算内（代理执行）<br>③ **承诺检测通过** | 直接回复 |
| **审批** | 任何一条不满足 | 卡片 |

- **硬上限**：超过工具次数时，hook 拒绝这次调用，并提示模型"改为调用 `request_approval(plan)`"。代理预算超了，run 直接结束，由 Session Manager 提交一张"没做完"的卡片。
- **承诺检测**：自动发出前，代码用 light 档对草稿做一次结构化判断：有没有替我答应时间、金钱或事情，有没有代表我表态，有没有泄露 `shared/` 以外的私人信息。只要命中一项就转审批，卡片上显示命中原因。
- **稳住对方**：转审批时，对方会收到一句**固定模板**（可在 `gate.yaml` 配置，不由模型生成），比如"收到～这个我得先跟 主人 确认一下"。审批超时也发固定模板。
- **全局预算**：所有他人请求共用一个日预算，由代理执行；超了以后一律走审批。按人的预算后置。

### 7.5 Auto 规则（M5，粒度：人 × 动作）
- 只能由我在卡片上点"以后这类自动"生成，agent 没有任何写入途径。存在 `config/auto.yaml`（唯一真相源）。
  ```yaml
  - who: wife
    action: wechat.reply      # 对老婆的回复：承诺检测命中也自动发（仍然受硬上限约束）
  ```
- 每周在管理群发一份"这周自动执行了什么"。

### 7.6 隔离与凭证

| 东西 | 属主 / 权限 | 谁能碰 |
|---|---|---|
| 核心代码、SQLite、`secrets.env`、lark-cli 和 token、git push 凭证 | `sbot`，0700 / 0600 | 只有核心进程 |
| `/srv/sbot/config`（配置仓库：models / people / groups / gate / auto / jobs / self） | `sbot`，0700 | 我（直接改 / 控制台 / 卡片）；**任何 agent 都不能写**，agent 想改只能提 proposal |
| `/srv/sbot/agent-home`（记忆仓库） | `sbot` | 只能通过核心的记忆工具读写（代码校验路径），worker 读不到原文件 |
| `/srv/sbot-w/tasks/*` | `sbot-w` | sandbox worker |
| `/srv/data/sbot-h/{home,tasks}` | `sbot-h`（有完整 sudo） | host worker；核心在 `sbot-h` 组里，能读任务目录（推送时要 fetch） |
| `/srv/data/sbot-shared`（skill 插件、`ssh_config`） | `sbot`，0755 | 核心写；两种 worker 都只读。不放密钥 |

- **host worker 的边界**（v0.14）：网络和文件系统都没有隔离，sudo 也是完整的。还剩下的约束：
  - 没有任何凭证：不给 lark-cli 和推送凭证，环境变量里只有一个按 run 签发、有预算上限的 LLM token；
  - 推送和对飞书的动作仍然只走核心工具和审批；
  - 核心守卫 + worker 规则，让它不去碰核心的文件；
  - 每个 run 一个 unit，有内存和时长上限。
  - **残余风险**：有 sudo，核心守卫就只是软边界，挡不住有意为之。被注入的指令可以读 `secrets.env`、登录 `ssh_hosts` 里的机器、在 tailnet 里横向移动。所以碰到不可信内容就用 sandbox。
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
- **控制台**：两个 unix socket。`/run/sbot/console.sock`（目录 700，属主 `sbot`）由 `tailscale serve --https=8444` 代理进来（P0 已验证），校验 `Tailscale-User-Login`；`/run/sbot-web/console.sock`（目录 2750 `sbot:sbot-web`，只有 nginx 的 www-data 在组里）由公网 nginx 代理进来，只认密码登录后的会话 cookie（§10.1）。
- **主 agent / Triage / expert** 跑在 `sbot` 用户下，但它们没有 shell，也没有读写文件的工具，只能调用我们的 MCP 工具，而这些工具在核心代码里做了校验。

---

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
├── self/              # 自我档案：命盘、年表、习气、节律、功课、心得、前瞻、复盘（§15.9，只在 owner 会话可见）
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
  - `src=lens`（镜头解读）：永远不当事实进 USER.md 或 MEMORY.md。只能留在 `self/readings` 对应的记录里；我回看时说的感受可以进 `self/lens-notes/`（§15.7）。
  - `src=review`（复盘）：我确认过的结论可以提炼进 USER.md，比如"我做决定前习惯先问别人意见"。没确认的留在复盘文件里。
  - `src=outlook`（前瞻）：和镜头一样，是看法不是事实，永远不进 USER.md 或 MEMORY.md；我回看时说的话可以进 `guidance-notes.md`（§15.8）。
  - `self/` 下的写入权限：`habits.md`、`rhythms.md` 只能加"候选"条目；`lens-notes/`、`guidance-notes.md`、`reviews/`、`outlooks/` 可以写；`practice.md`、`charts/`、`timeline.md` 只能提 proposal。这是 dream 的权限；我在私聊里亲口要改的，主 agent 用 `self_page` 写（§15.9）。
  - 每次一个 git commit；改到 USER.md 先过 expert；第二天早上管理群收到 diff，可以一句话回滚。
- 他人会话只能写 journal（自动打来源标签）。

### 8.4 检索
- 不上向量库。
- 记忆页面：每次 commit 之后，由代码把改动的页面同步进 `pages_fts`（SQLite FTS5，中文用 trigram 分词）。`wiki_search` 先看 `index.md`，再查 FTS，最后读正文。量小时 ripgrep 也能顶。
- 消息归档：`messages` 表上的 FTS5。
- 他人会话的检索范围按 §4.1 在工具层过滤，并且只能看到 `visibility` 允许的页面（§8.5）。
- 页面过千、FTS 明显不够用时，再考虑 qmd 这类 BM25 + 向量 + 重排的本地检索。

### 8.5 知识库：llm-wiki 三层（Karpathy 的 llm-wiki 模式）

记忆不只装"关于我和身边人的事"，也慢慢长成个人知识库：我读过的文章、会议纪要、项目资料、学到的东西，都由 agent 消化成互相链接的页面。三层结构如下。

| 层 | 在哪 | 谁写 |
|---|---|---|
| **raw（原始资料）** | rustfs `sbot-raw` 桶，key 是 `sha256/<前两位>/<sha>`；元数据在 `raw_sources` 表 | 只增不改，模型永远不改原件。来源：转发给它的文章和链接、附件、语音转写、会议纪要、聊天导出、网页剪藏 |
| **wiki** | `agent-home`（git） | agent 维护，通过 `memory_patch` 提交，写入纪律照 §8.3 |
| **schema** | `agent-home/AGENTS.md` 里的"wiki 约定"一节 | 我改；agent 只能提 proposal |

**三个操作**
- **ingest**：inbox 里的一种事件，由"转发给它""会议结束""每天收尾"触发。
  - 用 light 档，在核心进程里跑（pi）。
  - 先存 raw，再写 `sources/<slug>.md` 摘要，然后更新相关的 topics、people、projects 页。一份资料可能动到很多页，所以每次 ingest 限 ≤ 8 页，超了拆成多次。
  - 最后更新 `index.md`、追加 `log.md`，打一个 commit。
- **query**：主 agent 的 `wiki_search` 加 `wiki_read` 工具，回答时附上页面链接。
  - **好答案收回 wiki**：比较、分析、复盘结论、我认可的发现，存成 topics 页，不让它们沉在聊天记录里。这件事由我说"记下来"，或者 dream 判断后提议。
- **lint**：并进每晚的 dream（轻的部分）和 §16 的体检（重的部分）。
  - 检查互相矛盾、过时的说法、孤立页面、缺失的链接，以及该有页面却没有的概念。
  - 结果写成提案，不直接大改。

**和已有设计的关系**
- 四份心得文件（`self/lens-notes/`、`guidance-notes.md`、`rhythms.md`、`habits.md`）本来就在 agent-home 里，也就是 wiki 的页面。git 历史就是 §16 A 级"自动改、能回滚"的底子。
- **可见范围**：每页 frontmatter 带 `visibility: owner | work | shared`，加 `src`。
  - `self/` 和生辰固定是 `owner`，代码强制，模型改不了。
  - 他人会话只能检索 `shared`，工作群里的起草只能检索 `work` 和 `shared`。
- **来源纪律照旧**：`src=web` 的资料摘要必须带链接和 raw sha；非 owner 来源的内容写成"X 说……"（§8.3）。
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

- **为什么它的规则要等我**：这几份写着"只有我能改"（§8.1、§15.12、§16.3 B）。seed 的 PR 可以由 Claude 自己合，不一定经过我的眼睛；到线上之前我说一句，规则就还是我定的。SStudioBot 自己开的 PR 本来就等我合，所以它也不能借 seed 改自己。
- **通知**：和上线通知合成一条，只报文件名，不带内容。同一版 seed 每份只报一次；没理就不再提，想换时随时回「更新 seed」。
- **撤回**：每次替换一个 git 提交，通知里带「回滚 <sha>」。我回滚了，就当是我的回答：这一版不会再自动换上，也不再报；之后我点名「更新 seed」要它，还能换。
- **提交失败**（比如仓库被锁）：旧文件放回去，通知里说没换成，下次启动再试。
- **§8.6 之前装的实例**：没有记录。和当前 seed 一样的文件从这次开始记；不一样的当作改过，报一次「有更新待合」，不动。
- **线上改过的怎么合**：手动合、提交。合到和 seed 一模一样，下次启动自动接上记录。
- 只看 seed 目录里有的文件，不碰 `self/` 和别的页面。

---

## 9. 定时器

### 9.1 两种定时器，一张表

| 类型 | 谁创建 | 例子 |
|---|---|---|
| **schedule**（周期） | 定义在 `config/jobs.yaml`（只有我能改），启动或热加载时同步进 `timers` 表 | 07:50 今日一卦（§15.7）；08:15 事的整理（§15.14）；08:30 早报（含今日一卦和今日留意）；22:00 微信群摘要；22:30 日复盘；周日晚周复盘 + 下周前瞻；月初月复盘 + 本月前瞻；03:00 dream |
| **follow-up**（一次性） | 主 agent 在 owner 会话里调用 `followup_set({ at \| in, note })` | "周三下午看看对方回没回""下周一提醒我跟进 X" |

- **Scheduler 每 30 秒轮询一次**。对每个到期的定时器：往它的 lane 投一条 `timer` 事件（去重 ID 是 `timer_id:due_at`），然后把 follow-up 标为 done，或者把 schedule 推进到下一次。**定时器自己从不直接起 run。**
- 停机期间错过的 schedule 不补跑，记为 `missed`。上一次还在跑时，这一次记为 `skipped`。
- run 结束时**可以什么都不发**，这本身就是正常结果，所以不再需要单独的 `quiet` 选项。
- `jobs.yaml` 只放定义，`timers` 表只放运行状态（下次到期时间、上次运行时间），二者不重复。
- 任务写 `enabled: false` 就暂停：不再触发，和删掉一样，但设置留在文件里，随时能打开（控制台的开关，§10.6）。

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
- 分拣提醒（§4.3）：还在等我回 / 拍板的总是发，和任务来问话一样。其余「知道就好」的，我在飞书读过就不发；没读的一天最多发上限这么多批（单独计数，不占任务通知和 follow-up 的额度），超出的进第二天早报，进早报前我已回应的会去掉。
- 复盘和前瞻类消息单独计数，不占上面的额度：日复盘最多 1 条/天，周、月的复盘加前瞻各 1 条；今日留意并进早报；我没回就不追问。"要不要给这件事起个局"的提议只出现在当前回复里，不单独发消息（§15.11）。
- 事的整理（§15.14）一天最多一张卡，**占上面额度里的 1 条**。到了上限就不发卡，建议留在控制台，早报里带一句。

### 9.4 定时任务遇到上游错误

定时触发的活没人在等，可以等上游恢复。适用于定时事件（早报、复盘、到点提醒、事收复盘、镜头结果进会话）和调模型的代码任务（dream、每日整理的模型部分、月度镜头）。我自己发的消息出错时行为不变。

| 错误 | 判定 | 下一次 |
|---|---|---|
| 暂时的 | 429、500/502/503/504/529、过载、网络错误 | 退避 2、5、10、20、30、30… 分钟 |
| 用量上限 | 报错说 weekly / usage limit、额度用完之类 | 报了恢复时间就排在恢复后 2 分钟；没报每 30 分钟看一次 |
| 不重试 | 预算用完（§5.2）、鉴权、请求本身有问题 | 按原来的失败处理 |

- **截止时间**：原定时间后 2 小时（`jobs.yaml` 里 `retry_hours` 可改；月度镜头 12 小时，要赶在当晚月复盘前），并且不晚于下一轮同名任务前 10 分钟。截止时刻再试最后一次，这样我临时配了备用模型或加了额度还来得及；恢复时间在截止之后的，中间不再空打。
- **放弃**：管理群一条消息，每次放弃只发一条，不补跑，也不去私聊打扰我。`job.<名字>.last` 记 `gave_up`。
- **只重跑干净的失败**：这一次没出过字、没发过消息、只用过只读工具才重跑；否则重跑可能重复发话或重复写入，按原来的失败处理。所以定时 run 不发「思考中」卡片，有字了才起卡。
- **失败的这一次不留痕**：会话文件退回到这次之前，否则每重试一次，事件全文就在上下文里多一份。滚动会话的摘要跟着事件带到下一次。
- 重试状态在 `inbox.not_before` 和 `payload.retry`（代码任务在 `kv` 的 `job.<名字>.retry`），重启不丢。排着队的事件不挡我的消息。

---

## 10. 配置控制台（M3 起）

M0～M2 不做控制台，用飞书的 `/model`、`/group` 卡片，加上直接改配置仓库来顶上。

### 10.1 形态与访问
```
手机 / 电脑（装了 Tailscale）                       任何浏览器
   │  https://<host>.<tailnet>.ts.net:8444            │  https://<console.web.origin>（Cloudflare 只做 DNS，灰云）
   ▼                                                   ▼
tailscale serve --https=8444                         nginx :443（Let's Encrypt、HTTP/2、登录限速）
（注入身份头 Tailscale-User-Login）                   （去掉 Tailscale-* / Authorization，补 X-Real-IP）
   ▼                                                   ▼
/run/sbot/console.sock（目录 700 sbot）              /run/sbot-web/console.sock（目录 2750 sbot:sbot-web）
   只认 Tailscale-User-Login ∈ owners                   只认会话 cookie（密码登录发的）
   └──────────────── 同一个核心进程、同一套 /api/* 和前端 ────────────────┘
```
- **tailnet 入口**：后端校验 `Tailscale-User-Login` 在 `console.yaml owners` 里，不是就返回 403。
- **公网入口**（2026-11-18 加，因为 tailscale serve 在主人那边常卡；防护照主人另一个管理面）：
  - 地址在 `config/console.yaml` 的 `web: { origin: https://… }`，主机名是实例数据，不进仓库。没写 origin、或者服务器上没设密码，这个入口对什么请求都回 404。
  - 一个密码，`secrets.env` 里只存 `CONSOLE_WEB_PASSWORD_HASH`（PBKDF2-SHA256，30 万轮）和会话密钥 `CONSOLE_WEB_SESSION_KEY`。只能在服务器上用 `console-passwd` 设；重设密码或 `--logout-all` 会换会话密钥，所有会话立刻失效。控制台的密钥页拒绝写这两个名字。
  - 登录（`POST /_auth`）要本站 `Origin`、表单提交；失败按 IP 每 10 分钟 10 次、总共 30 次限流（nginx 也按 IP 每分钟 10 次）。成功和触发限流都在管理群通知（IP 打码）。
  - 会话 cookie `__Host-sbot_console`：`时间戳.随机数.HMAC`，12 小时，Secure、HttpOnly、SameSite=Strict、不带 Domain。
  - 写操作除了原有的 `x-sbot-console: 1`，还要 `Origin` 等于 `web.origin`。为此这个入口的 `Referrer-Policy` 是 `same-origin`（`no-referrer` 下浏览器同源写请求会带 `Origin: null`）；tailnet 入口仍是 `no-referrer`。
- **为什么两个 socket**：tailscaled 会换掉客户端伪造的 `Tailscale-User-Login`，nginx 不会。两个入口如果共用一个 socket，从公网进来的人自己塞这个头就能过。所以 nginx（www-data）连不上 tailnet 的 socket（目录 700），公网 socket 上完全不看这个头；反过来公网的 cookie 在 tailnet 入口也不算数。www-data 下别的进程能连公网 socket，但那里除了 cookie 什么都不信，所以没用；X-Real-IP 它可以伪造，因此限流另有一个总量上限。
- **部署**：`deploy/console-web/`（tmpfiles 建 `/run/sbot-web`、sbot-core 的 drop-in 放开这个目录的写权限、nginx 站点模板、`install.sh <host>` 申请证书并启用）。核心启动时这个目录存在才开公网 socket。
- P0 实测（2026-11-16，tailscale 1.104.5）：
  - 控制台**单独用一个端口**（实例里是 8444），不和本机已有的 serve 配置抢路径，也不改它们。
  - 经 serve 进来的请求带 `Tailscale-User-Login` / `Tailscale-User-Name` / `X-Forwarded-For`；客户端自己塞的同名头会被换掉，伪造不了。
  - 可以代理到 unix socket。socket 放在 700 目录里，sbot-w 和其他用户连不上（tailscaled 是 root，能连）。这样本机别的进程没法绕过 serve 直连、自己编身份头；如果监听 127.0.0.1，本机任何用户都能这么做。
  - 改 serve 要 root（`sudo tailscale serve --bg --https=8444 unix:/run/sbot/console.sock`），M3 部署时做一次；也可以 `tailscale set --operator=sbot`，不过那样 sbot 就能改整台机器的 serve，不推荐。
  - 设备不带用户身份时（tagged 节点）没有这个头 → 一律 403。
- 手机优先，按竖屏设计。

### 10.2 页面（按优先级）

| 优先级 | 页面 | 真相源 |
|---|---|---|
| M3 | **状态**：渠道连接、observer、token 有效期、边缘节点、正在跑的 run 和任务、待审批、今日用量 | SQLite（SSE） |
| M3 | **模型**：端点、三档、价格、探针结果 | `config/models.yaml` + `secrets.env`（key 只能写） |
| M3 | **群**：所有群按活跃度排序，切换 activation / reply，黑名单，批量操作 | `config/groups.yaml` |
| M3 | **记忆**：浏览、按 dream commit 看 diff、一键回滚 | agent-home git |
| M3 | **用量** | `usage` |
| M5 | People、策略、Auto 规则、定时任务、提议 | 对应的配置文件 / `proposals` |
| M3（2026-11-17 补） | **流转**：消息 → Triage → run / worker → 审批 → 发件箱，实时一条条走过去，点开看每一步的输入输出和用量 | `inbox` / `runs` / `approvals` / `outbox`（SSE） |
| M3（2026-11-17 补） | **沉淀**：知识库（index / log / 页面）、事和复盘、镜头看法账本、心得、§16 的信号和提案 | agent-home git + 对应的表 |
| v0.15 | **生活 › 人**：每个人的因缘（初见、每月往来）、关系、常一起的人和事、资料和页面、叫法；改名、分圈子、记关系、合并、拆开；people.yaml 的信任只读显示。**生活 › 因缘**：圈子图、圈子、新结的缘、常在一起还不知道什么关系、牵线的人、渐远的、待认 | `persons` / `relations` / `graph_*`（§18） |
| v0.22 | **它自己 › 配置**：每个配置文件一张表单，原文在「高级 › 查看原文」（§10.6）。`self.yaml` 还在「生活 › 出生信息」 | `config/*.yaml` |
| M8 | **待办 › 要你回 / 拍板**；**生活 › 事**：每件事的事件、等你的、话头（挂到事上）；**生活 › 导入**：预览、导入、撤销、提示词和样例；**它自己 › 信息源**：每个源上次拉取的结果、现在拉一次 | `events` / `imports` + `config/sources.yaml` |

### 10.3 原则
- 真相源是配置仓库里的文件。控制台保存时：先用 schema 校验，再写文件、做 git commit（提交信息带 `via console`）、热加载，并在管理群通知一声。表单和原文编辑器都走这一条（§10.6）。
- schema 用 zod 写在 `shared/` 里，前后端共用。
- 密钥只能写，不能读。
- 扩大权限的改动（群开成 `s_auto`、调高预算、放宽主动消息上限、缩短提醒等待窗口）会在管理群单独发一条醒目通知。

### 10.4 重做（2026-11-17 定，参考 T3 Code 和 Magpie）

现在的 7 页偏配置。重做成四块，桌面三栏、手机底部四个 tab + 抽屉：

1. **待办**（首页）：所有待审批都能就地批，等我回答的任务，Sentinel 告警，没跑的定时任务。
2. **会话**（像 T3）：左边 lane 列表带状态点；中间 run 时间线，工具调用默认折叠，审批就地显示；右边链路详情（像 Magpie）：系统提示分段和各段 token 占比、prompt / tuning 版本、缓存命中、花费、模型实际收到的完整请求。
3. **生活**（只给 owner）：时间线、事、前瞻和复盘、习气和节律（认同 / 送走）、看法账本、出生信息。
4. **它自己**：体检指标趋势、§16 提案（diff、回放、回滚）、记忆和 dream 的 diff、模型和用量、配置和密钥、连接健康。

已定：
- **控制台可以直接批**，包括以我身份发出的消息。记成「经控制台」，飞书上的卡片同步改状态；和卡片走同一个审批状态机（同一个乐观锁版本号），谁先点算谁。
  - 控制台的响应不等飞书（2026-11-18）：状态、发件箱、事件在同一个事务里落库后就返回，卡片更新和随后的唤醒在后台按原顺序做。要核心当场执行的审批（`deferred_tool`、`proposal`、`rollback`）仍然等执行完，因为结果要显示在页面上。卡片上点的路径不变。
- **完整请求留存**：只存 main 和 draft 两种 run 发给模型的完整请求（system + messages + tools），保留 7 天，只有 owner 能看。其他 run 只存摘要和版本号。
- **前端**：不加构建步骤，每页一个原生 ES module（`console/pages/*.js`），共用的组件和工具放 `console/lib/`；CSP 仍然只允许 self。下一代客户端见 §19，替换完成之前这里不变。
- 分期：C1 骨架 + 待办 + 会话链路 + 请求留存；C2 生活；C3 它自己。

### 10.5 响应性能（2026-11-18）

都做在核心里（`console-http.ts`），两个入口同时受益，随 core 自动上线，不用改 nginx。客户端以后拆出去也照样有用。

- **静态文件**：启动时读好、算内容 hash、在线程池里预压缩（br、gzip）。`Cache-Control: no-cache` 不变，每种编码一个强 ETag，`If-None-Match` 命中回 304。按 mtime 和大小发现文件变化，不用重启。鉴权在前，没通过的请求拿不到 304 或 ETag。
- **`modulepreload`**：`index.html` 列出首屏的 import 链，并行取，不再一层层等。新增首屏依赖时要同步改这个列表，漏了只是慢一点。
- **压缩**：1 KB 以上的 JSON 按 `Accept-Encoding` 现压（br 质量 4 或 gzip），在线程池里做，不占事件循环。SSE 不压。
- **git 读缓存**（`gitRead`）：`git` 是同步子进程，会卡住整个核心。只依赖提交的读（记忆日志、配置历史、状态页的最新提交）缓存到分支移动为止，靠 stat ref 文件判断，所以回滚和手工提交也会失效，不用 TTL。配置的正文和 hash 每次都现读，乐观锁不受影响。
- **SSE**：全局每 3 秒算一次 `status()`，广播给所有连接；没有连接时不算。

### 10.6 配置表单（v0.22）

改配置不该要我写 YAML，也不该要我猜每一项什么意思。

**服务器描述，客户端只画。** `core/src/config-form-specs.ts` 给每个文件写一份描述：字段、中文说明（控制什么、默认多少、调大调小有什么效果）、控件、单位、哪些改动算放宽。类型、范围、必填、格式在下发时从 zod schema 取，不写第二遍；`specProblems()` 两个方向核对，字段对不上冒烟就失败。协议类型在 `core/protocol/config-form.ts`，§19 的新客户端直接用；旧控制台由一个通用渲染器 `console/lib/form.js` 来画，不按文件写页面。

| 接口 | 作用 |
|---|---|
| `GET /api/config/<file>/form` | 描述、当前值、hash、表单不认识的键、可选项（群、仓库、插件、密钥名等）、今日用量 |
| `POST …/form/preview` | 不写入。返回字段错误、放宽项和后果、将写入的 diff、任务的下次运行时间 |
| `PUT …/form` | 带 `values`、`hash`、`ack` 保存 |

**保存没有第二条路。** `values` 是草稿：没出现的键不动，`null` 是清空或删除，出现的列表就是完整内容。服务器把它并进当前值，只碰描述里有的键，算出保留注释、顺序和空行的新文本（改一个值，diff 就是一行），再交给原文编辑器用的同一个 `saveConfig`：比 hash、zod、防止把自己移出 owners、写文件、git 提交、`config_changes`、管理群 diff、`widening()` 的 ⚠️，都在那里，表单没有改动也没有绕过它们。

**放宽要先确认。** 预览时列出放宽项和后果，保存前再确认一次；`ack` 没盖住全部放宽项，服务器回 409，什么也不写。`widening()` 看不到的几类由表单层补一条 ⚠️，只加不减：没设过的群因此多读、去掉默认敏感词、换管理群或工作台、模型端点的地址和密钥、备用模型、人的 ID、提醒不占主动额度。换管理群时，旧群也会收到一句。

**不丢东西。** 表单不认识的键原样保留，并列在表单上，提示去「高级 › 查看原文」改。原文编辑器还在每张表单底部，兜底和看历史。文件解析不了时表单停用；`saveConfig` 要拿旧内容比较放宽，所以这种文件在控制台也存不了，要在服务器上修。

**只显示不让改的**：`groups.reviewed`（设了就跳过首次读群的确认卡片）、群的 `reply`、我自己的飞书和微信 ID、任务的 `lane`。密钥只选名字，值不下发。`self.yaml` 暂时不在表单里，出生信息和镜头设置单独做。

---

## 11. 数据模型（SQLite，草案）

```sql
messages(id, surface, chat_id, thread_id, sender_id, sender_kind, ts, text, media_ref, raw_json,
         triage_status, triage_action, triage_note, event_id, attn, wait_until)
                                                           -- + FTS5；triage_status: pending|done|skipped
                                                           -- attn（§4.3）: waiting|answered|read|held，NULL = 不在等
sessions(key, harness, session_ref, generation, surface, tier, model, status, last_active, summary)
                                                           -- harness: sdk|pi；generation：滚动或换模型后 +1
chat_cursors(chat_id, surface, last_msg_ts, last_msg_id, updated_at)
inbox(id, lane, kind, source, source_msg_id, turn_ctx_json, payload_json, status, run_id, ts, not_before NULL,
      UNIQUE(source, source_msg_id))
      -- kind: user|timer|task_done|approval|system；status: received|processing|done|interrupted|failed|dropped
      -- not_before：定时事件等上游恢复时，这个时间之前不取（§9.4）
runs(id, lane, session_key, sdk_session_id, role, tier, run_token_hash, status, stop_reason,
     side_effects, started, ended)
tasks(id, parent_lane, goal, status, tier, workdir, budget, sdk_session_id, last_output_at,
      started, ended, result_json, card_msg_id)
      -- status: queued|running|waiting_approval|needs_input|interrupted|done|failed|cancelled
approvals(id, kind, origin_lane, run_id, requester_id, action, channel, target, as_identity,
          draft, draft_version, refs_json, checks_json, expert_json, trigger_msg_id,
          deferred_tool_json, status, superseded_by, expires_at, decided_by, decided_at,
          card_msg_id, card_thread_id)
      -- kind: send|plan|deferred_tool
      -- status: pending|approved|rejected|expired|superseded|invalidated
outbox(id, approval_id UNIQUE NULL, lane, channel, target, payload, status, attempts,
       send_by, sent_msg_id, ts)                           -- status: queued|sending|sent|failed|unknown|expired
timers(id, kind, lane, cron NULL, due_at, payload_json, status, created_by, last_fired)
expert_calls(id, ts, trigger, input_ref, verdict_json, cost)
edge_nodes(id, kind, last_seen, status, wechat_version, logged_in)
usage(ts, run_id, task_id, tier, endpoint, requester_id, input_tokens, output_tokens, cost)
config_changes(id, ts, file, diff, source)                 -- source: console|chat|card|command|upgrade|proposal|manual
proposals(id, ts, origin_lane, target_file, patch, reason, status,
          tier, hypothesis, evidence_ids, eval_json, version, review_at, rollback_of)
      -- v0.10：tier: A|B|C；status: pending|approved|rejected|expired|live|rolled_back（§16）

-- v0.8：事上修（§15）
matters(id, title, domain, lane, status, opened_at, close_condition, closed_at, reviewed_at, file_path, keys, parent_id, merged_into)
  -- status 多一个 merged；parent_id 指向主线（只一层），merged_into 指向合并后留下的事（§15.3）
matter_ops(id, ts, kind, summary, why, by, review_id, touches, undo_json, undone_at, undone_by)   -- 事的每次改动和撤销它需要的东西
matter_reviews(id, fp, kind, prio, why, data_json, origin, status, shown_n, last_shown, snooze_until, created_at, decided_at, decided_by, action, op_id)   -- 每日整理的建议（§15.14）
      -- status: open|active|closing|reviewed|dropped；domain: work|personal
readings(id, ts, matter_id NULL, source, lens, method, profile_version, question, reading_ref,
         claim, revisit_at, look_for, frozen_hash, status, feeling NULL, owner_words, evidence_refs,
         revisited_at)
      -- source: lens|agent；feeling: resonant|neutral|not_yet（可以为空，以我的原话 owner_words 为准）
      -- claim / look_for / reading_ref 写入即冻结（frozen_hash 校验），之后只能追加回看
reviews(id, kind, matter_id NULL, period, draft_ref, status, started_at, ended_at, delivery NULL)
      -- kind: matter|daily|weekly|monthly；status: drafted|in_dialogue|done|not_discussed
      -- delivery：代码记的未聊这一轮怎么结束的，sent|replied|not_sent（§15.5）
review_open(id, kind, period, facts, fired_at, deadline, inbox_key, run_id, UNIQUE(kind, period))
      -- 发出去、还在等落档的复盘；到 deadline 由代码收尾（§15.5）

-- v0.9：红尘里修（§15.2、§15.6）
outlooks(id, horizon, period, lane, parent_id NULL, intention_words, items_json, reading_ids,
         frozen_hash, status, review_id NULL, created_at, revisited_at)
      -- horizon: month|week|day；period: 2026-12 / 2026-W49 / 2026-12-03；parent_id 指向上一级前瞻
      -- items_json: [{ text, why_refs, look_for, revisit_at, owner_words NULL, feeling NULL }]，写入即冻结，回看只追加
      -- status: drafted|sent|discussed|revisited
life_notes(id, ts, surface, text, domain, matter_id NULL)  -- 随手记，src=owner
-- 视图 timeline(ts, kind, domain, matter_id, people, summary, ref)：
--   union owner 消息 / outbox / approvals / tasks / matters / outlooks / readings / reviews / life_notes；
--   日程不落库，timeline_query 时现查飞书日历再合并

-- v0.11：退后（§15.13）
noticings(id, ts, habit_ref, kind, first_by, prompted, review_id NULL, matter_id NULL, owner_words, ref)
      -- kind: habit|rhythm；first_by: owner|agent；prompted: 0|1
      -- habits.md 条目状态：候选 | 认可 | 送一程 | 淡了 | 放下（后两种 v0.24，§15.15；rhythms.md 用 候选 | 认可 | 淡了 | 放下）

-- v0.10：agent 自己的 RSI（§16）
signals(id, ts, kind, role, run_id, approval_id NULL, task_id NULL, value_json, src)
      -- kind: draft_approved|draft_revised|draft_rejected|replied_myself|triage_missed|triage_noise|
      --       owner_correction|task_failed|task_redo|proactive_ignored|expert_revise …；src 只认 owner 行为
eval_cases(id, role, kind, input_ref, gold_ref, from_signal_id, created_at, active)
      -- 由代码自动攒，agent 不能增删改

-- v0.12：知识库（§8.5）
raw_sources(sha256 PK, s3_key, mime, bytes, title, origin_url NULL, src, visibility, received_at,
            inbox_id NULL, ingested_at NULL, pages_json)        -- pages_json：这份资料动过哪些页
pages_fts(path, title, body, visibility, updated_at)            -- FTS5（trigram），由代码在 agent-home commit 后同步

-- v0.13：以事为轴（§17）
events(id, ts, source, ref, place, place_id, actor, kind, level, summary, link, domain, matter_id NULL, topic NULL,
       state, done_at, done_by, msg_ids, created_at, UNIQUE(source, ref))
      -- kind: ask|decision|commitment|progress|risk|deadline|info；level: fyi|watch|reply|decide
      -- state: open（reply / decide 还没处理）|seen（fyi / watch）|done|dropped
      -- done_by: replied|approved|rejected|owner|owner@console|import
      -- source: feishu|<sources.yaml 的 id>|import；place_id = messages.chat_id（群、私聊、<源 id>:<where>）
imports(id, ts, origin, sha, raw_path, summary_json, commit_sha, status)   -- status: applied|undone

-- v0.15：因缘（§18）。前三张是持久的（我的纠正在这里），后两张是派生视图，随时可以整张重建
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

---

## 12. 已拍板的决策

| 问题 | 结论 |
|---|---|
| 老婆和朋友私聊的回复策略 | 自动档（硬上限 + 承诺检测）自动回，其余审批（§7.4） |
| 各档用什么模型 | 留好配置；2026-11-17 定四档：chat opus、work sonnet、light haiku、expert opus（§5.1） |
| 私人内容出现在工作飞书里 | 可以接受 |
| harness | worker 和 lens 用 Claude Agent SDK（sandbox、`defer`、内置工具）；对话角色用 pi（P0 对比后定）；工具和闸门写成与 harness 无关的一层（§4.0） |
| 群里要不要自动回 | 按群开关，默认全部审批 |
| 搜索 | 优先用模型自带的；兜底工具在 P0 准备好 |
| 飞书群 | 默认 `always`，以 user 身份轮询读取；敏感群和外部群默认关闭或只出摘要；首次启用时过一遍群列表（§3.5） |
| 以 user 身份读消息会不会变已读 | 不会（已确认） |
| 可视化配置 | 控制台，M3 起做；之前用卡片和直接改文件 |
| 审批 | 非阻塞：提交式 + 挂起式（§7.2） |
| 凭证 | LLM 代理 + Unix 用户隔离；agent 环境里没有任何真实凭证 |
| 第一性原理（v0.24） | 陪我修自己、离苦得乐的伙伴，只为我一个人。办 → 读 → 参 → 觉 → 改：办事是基本功和起点，读懂我从几种来源主动看，几种看法互参，最好是我自己先看见。看可以主动，说要克制；会淡、能放下（§0） |
| 陪伴的定位 | 红尘里修：修行在整个生活里，办事是信息来源也是道场。两条主轴是月、周、日的前瞻和顺着时间线的回溯，首尾相接成类 RSI 的循环（§15） |
| 退后 | 成长的刻度是我自己先看见的比例，只当镜子不当 KPI；习气我连续 3 次自己先看见就"送一程"，不再主动提；熟了以后复盘有时先让我回忆（§15.13） |
| agent 自己的 RSI | 信号来自我的行为和原话；改动分四级（自动 / 提案 + 回放 + 我批 / PR / 永不），只能让它办得更好，不能让它权限更大（§16）。风格笔记和范例库定为 A 级自动生效：范例本来多是和 AI 对话调出来的，学的是调教后的倾向；体检节奏按信号量动态触发 |
| 前瞻的分寸 | 建议不是安排；月、周各不超过 3 条，日 1 条；先问我的意图再给；镜头的日、周、月例行看法默认开，能在 `jobs.yaml` 关（§15.2） |
| 玄学的位置 | 佛学是 agent 的立场；八字、紫微、六爻是镜头，当作一种看法，结合生活来感受，不做对错打分 |
| 复盘的方式 | 事的层面给事实初稿；心的层面先问再给，引导我补充信息和看法。我自己说出来的分量最重 |
| 镜头来源 | 紫微用现有 skill；六爻以 zhouyi-qigua.pages.dev 为准，单独开 thread 做 skill；八字后续再定 |
| 部署 | 单机，不做远程 worker；数据全在 4T 数据盘；worker 进程同时 ≤ 2，各限 1G；重构建外包给 Mac 或 CI（§1.3） |
| 知识库 | llm-wiki 三层：raw 放 rustfs，wiki 就是 agent-home，schema 在 AGENTS.md；检索用 FTS5，不上向量库（§8.5） |
| 预算超限的状态码 | 403，不用 429（429 会让 CLI 重试约 3 分钟，§5.2） |

### 仍然未决
- 月前瞻按公历月还是节气月：先做成 `config/self.yaml` 里的一个选项。
- §18 因缘的后续：dream / 分拣从对话里顺手记关系（推测，等我认）；周复盘里带一段因缘；AGENTS.md 里约定人物页互相用 `[[people/…]]` 链接（AGENTS.md 是我改的）；数据大了以后改成增量构建。

---

## 13. P0 探针清单（开工前 1～2 天，全部写成可以重复执行的脚本）

升级 SDK 或 CLI 之后重跑一遍。

- [x] **SDK + 我的协议转换端点**：
  - ✅ `resume`、thinking 下的工具续传、`interrupt()`（2026-11-17，Mac 直连上游，`probes/sdk-misc.ts`，claude sonnet / haiku 和 codex/gpt-6.1-sol **都 4/4**）：
    - 换新进程按 session id resume 能续上；interrupt 之后再 resume 也行
    - 开 thinking 时两次相互依赖的工具调用都对。CLI 把 `thinking` 统一改成 adaptive，模型名认识的给 effort medium，不认识的（`sbot-*`）给 high。adaptive 下模型可以不想，所以 thinking 块不一定出现。haiku 想了以后签名照样能续传；codex 经转换层不回 thinking 块，也不影响续传
    - `interrupt()` 要用流式输入；调用后约 30 ms 结束，工具不会再被调用。**迭代器是抛错（"[ede_diagnostic] … stop_reason=tool_use"），不是给一条 `result`** → 核心把 interrupt 之后的抛错记成"已中断"，不要当失败
  - ✅ **`defer` → `tool_deferred` → 用空字符串 prompt resume → hook 再次触发并 allow / deny**（2026-11-16，Mac，本地端点）
  - ✅ 并行调用：defer 不会被忽略、会静默丢一个 → 改用"每个 session 只允许一个 defer"的锁，已验证
  - ✅ `onFailure: "block"`；✅ `tools: []` + `disallowedTools` 后只剩 `mcp__sbot__*`
  - ✅ 经 VPS 代理接真实上游（2026-11-16）：chat 档用 claude-sonnet-5-5 和 codex/gpt-6.1-sol **都 7/7 通过**。codex 的工具 id 是 `call_…`，defer / resume 照样能用 → SDK 这一侧对厂商是中立的
  - ✅ Claude Code 内部是否还会请求 `sbot-*` 以外的模型名：在 `ANTHROPIC_DEFAULT_*` 全部设成别名、并关闭非必要流量的前提下，**一个都没有**（共 25 次调用，全是 `/v1/messages`）
  - ✅ 冷启动：VPS 上首条消息 0.8～1.6 s，一次 defer run 7～9 s；上游单次调用 p50 约 5 s
  - ✅ `PostCompact` 能拿到 `compact_summary`（2026-11-16，`/compact` 触发，约 16 s；摘要是模型自己写的，我们插不进锚点）
  - ✅ `settingSources: []` 加 `plugins` 能加载 skills（2026-11-17，`probes/lens-skills.ts`）；CLI 自带的 skill 要靠 `skills` 白名单藏掉（§4.2）
  - ✅ `settings` 选项能传 `cleanupPeriodDays`（2026-11-17，`probes/cleanup-period.ts` 3/3）：传 365 时，40 天的转录保留、400 天的被删。更要紧的是：**`settingSources: []` 且不传 `cleanupPeriodDays` 时，CLI 直接跳过清理**（日志 "userSettings source is disabled … no enabled source provides cleanupPeriodDays"），默认的 30 天根本不生效。清理在启动约 5 s 后才开始，跑得更短的 run 不会清理 → worker 不传这个设置，转录的保留和删除由核心的任务目录 GC 统一管
  - ✅ WebSearch / WebFetch（2026-11-17，`probes/web-tools.ts`，worker 路径，sonnet 和 haiku 两档都过）：WebSearch 发的是 `web_search_20250305` 服务端工具，上游原样支持（返回 `web_search_tool_result`）；WebFetch 在关闭非必要流量后能用，但会直连目标和 api.anthropic.com → 用 `skipWebFetchPreflight` + `settings.env.HTTPS_PROXY` 收进核心出网代理（§7.6）。codex 档的 WebSearch 没测（对话角色在 pi 上，本来就要自定义搜索工具）
- [x] **pi 对比（对话角色）** → **用 pi**（2026-11-16，VPS，`probes/harness-compare.ts`）：pi 11/11、SDK 8/9。pi 轮次延迟 p50 3.8 s 对 5.2 s，自身固定开销约 0.45k 对 0.9k token，进程树峰值 195 MB（1 个进程）对 333 MB（每个并发 run 多一个约 220 MB 的子进程）；压缩时我们自己写的摘要生效，压缩后不调工具也答得出发心和本月留意；诱饵扩展、`AGENTS.md` 都没有被加载；代理里 0 个 UNMAPPED。原先的比较项：用同一组工具、同一个 chat 档模型，跑三段脚本对话：私聊派活、起局（问发心）、周复盘加下周前瞻（要用到时间线）。分别在 SDK 和 pi 上跑，比较：
  - 冷启动耗时、每轮固定 token 开销
  - 我选的 chat 模型在两边的工具调用稳定性
  - 会话持久化和续接；自定义压缩能否保住发心、本月留意这些锚点
  - 能否关掉 `~/.pi`、`.pi/` 的扩展和 skills 自动发现；能否指向 LLM 代理（自定义 baseUrl + 临时令牌）
  - 锁定的版本号，以及两边的代码量和可读性

  **判定**：pi 这几项都过，对话角色就从 M0 起用 pi；有一项不过，全部用 SDK。不管选哪个，`Runner` 接口和工具层都一样。
- [x] **LLM 代理**（2026-11-16，VPS，`probes/llm-proxy.ts`）：✅ 流式透传；✅ `usage` 计量（SSE 和 JSON 两种）；✅ 上游 Bearer（该端点也接受 x-api-key），run 令牌两种头都能用；✅ 别名换模型，非 `sbot-*` 的模型名会记成 UNMAPPED；✅ 超预算时：429 → CLI 退避重试约 3 分钟，**403 → 立刻失败**，所以选 403（见 §5.2）
- [x] **worker 隔离**（2026-11-16，VPS，`probes/egress-check.sh` + `probes/worker-isolation.ts`，安装文件 `deploy/worker/`，细节见 §4.2、§7.2B、§7.6）：
  - ✅ 以 `sbot-w` spawn：`spawnClaudeCodeProcess` → `sudo -n worker-exec` → systemd scope（MemoryMax 1G）→ `setpriv`。in-process MCP 和 hook 照常工作
  - ✅ sandbox（bubblewrap）：要先把 Ubuntu 的 `bwrap-userns-restrict` 换成官方 `bwrap` profile，否则 `apply-seccomp` 失败、所有 bash 命令 exit 1
  - ✅ 文件：读不到核心文件和 dev 家目录，只能写 cwd
  - ✅ 网络：iptables 层 worker 只能到 LLM 代理和核心出网代理（2026-11-17 起公网和 DNS 也关了，§7.6）；sandbox 里的命令没有直连，只能经核心出网代理访问白名单域名（CLI 自带代理被 `SBOT_W` 挡住，不用它）
  - ✅ 内存：1.5G 分配只杀命令，CLI 活着（`OOMPolicy=continue` + oom_score_adj）
  - ⚠️ defer → resume → allow 不稳（约 15～25% 被当成拒绝，与 sudo 无关）→ 改成核心代执行 + deny 带结果，10/10（§7.2B）
- [ ] **Windows 数据库解密**：哪个工具支持锁定的那个微信版本（**微信方案的前提**）；wxauto 4.0 系的版本支持情况和窗口标题校验
- [x] **飞书**：
  - ✅ 外部群标记：`+chat-list` 的 `external`（布尔值）
  - ✅（2026-11-16，只读部分）轮询方式改为全局搜索，见 §3.6
  - ✅（2026-11-16，写入部分，全部 bot 身份）建了正式管理群「SStudioBot 管理」（私有普通群，主人是群主、bot 是管理员）。话题回复：搜索能看到，`chat-messages-list` 只嵌在根消息里；`--reply-in-thread` 可用；bot 自己的消息不回推事件；不 @bot 的群消息也会推；卡片回调 `operator_id` 就是点击人的 open_id，连点会来多次，要取第一次并立刻更新卡片（§7.2B）；token 延迟更新卡片可用
- [x] **lark-cli 在 VPS 上单独授权**（2026-11-16）：✅ 和 Mac 并存；✅ refresh token 7 天滚动；✅ 30 秒一轮、12 分钟 288 次调用无限流；❌ `+chat-list` 不返回 `active_time`，只能排序 → 改用全局搜索（§3.6）
- [x] **镜头 skill**（2026-11-17，VPS，`probes/lens-skills.ts`，打包 `deploy/lens/`）：6/6
  - ✅ ziwei-chart 没有 npm 运行时依赖（只用 node 内置模块），node 22 / 26 都能跑；VPS 和 Mac 同一输入的 `chart.txt` / `chart.json` 逐字节一致；HTML 没有外链，断网渲染没问题
  - ✅ worker 路径（sbot-w + sandbox + 出网白名单为空）：模型调 `Skill(sbot-lens:ziwei-chart)` → 沙箱里跑 CLI → 产物落在任务目录，和直接跑的结果一致；全程 0 次出网尝试
  - ✅ ziwei-natal 能读插件里的 kb（立场声明、断事方法），没有权限错误；kb 后来整份带上（星曜/宫位/四化/格局，约 800K），因为解读时会去找星曜页
  - ✅ `skills` 白名单生效（模型列表只剩白名单；白名单外的 skill 调用被拒）
  - 注意：worker 在沙箱里能 `find /` 读到全盘可读的文件（这次模型就为了找星曜页跑了一次），沙箱只限制写和网络。敏感内容只能靠文件权限挡，这一点 W4 已经验证过
- [x] **VPS 资源和环境**（2026-11-16 搭好，§1.3）：
  - 可用内存 2.2～3 GB → 改成单机轻量方案（对话角色不起子进程、worker ≤ 2 且各限 1G）
  - 系统自带的 `nodejs` 没有 TS 支持 → 官方 Node v26.13.1 装在 `/opt/node`（sha256 校验过），`process.features.typescript = strip`
  - 用户 `sbot`、`sbot-w` 已建（系统用户、nologin，不在 docker 和 sudo 组）。目录在数据盘上，`/srv/sbot`、`/srv/sbot-w` 是软链
  - 数据盘延迟实测够 SQLite 用
  - rustfs 已建 `sbot-raw`、`sbot-backup` 两个桶，读写删都试过；sbot 专用的受限 key 留到 M0 建
  - 剩下的：worker 和核心同时跑时的真实内存，等 M0 跑起来用 `systemd-cgtop` 实测
- [x] **tailscale serve**（2026-11-16，临时挂一个端口测完已撤，配置和测前逐字一致）：✅ HTTPS + MagicDNS；✅ `Tailscale-User-Login` 注入且客户端伪造会被替换；✅ 能代理到 unix socket，700 目录挡住其他本地用户；控制台单独用一个端口，不动本机已有的 serve 配置（§10.1）

### 13.1 M0 进度（2026-11-17）

代码在 `core/`（TS，Node 直接跑，不编译；`node --check` 过；strip-only 模式不支持构造函数参数属性，别写 `constructor(private x)`）。部署文件在 `deploy/core/`。

- [x] 核心 11 个模块：`config` `db` `proxy` `memory` `tools` `runner`（pi，每轮独立 ModelRuntime + run token，并发 lane 不共享 env）`dispatcher` `commands` `feishu` `outbox` `main`；另有 `backup`
- [x] seed：`core/seed/agent-home/{SOUL,AGENTS,USER,MEMORY}.md`（红尘里修的立场和分寸，**初稿，等 主人 过目**）；`core/seed/config/{models,people}.yaml` 模板
- [x] 冒烟（`core/test/smoke.ts`，VPS 上用临时 SBOT_HOME，`core/test/vps-smoke.sh`）全过：真模型回复、第二轮续上同一会话、用量入库、light token 要 expert → 403、吊销 token → 401、无副作用 run 重启后重跑且只回一次、有副作用 run 重启后标 interrupted 并通知一次
- [x] 飞书 bot 身份给 sbot：`/opt/sbot/bin/lark-cli`（root 所有）；`/srv/sbot/lark/` 下只有 bot 的 app 配置（`users: []`、appsecret、master.key），**没有用户 token**；`auth status` bot ready
  - 事件流字段和 `Incoming` 一致；`event consume` 会先查远端在线实例数（`online_instance_cnt`），>0 时核心打日志（同一应用多个消费者会分流事件）。Mac 和 dev 上都别跑这个应用的 `event consume`
  - `+chat-messages-list` 的 `create_time` 是 `"2026-11-16 23:12"`（UTC+8，分钟精度），不是毫秒；`content` 已经是渲染好的文本；系统消息没有 sender
  - 不关 stdin：不限时的 consume 在 stdin EOF 时退出
- [x] `/srv/sbot/secrets.env`（sbot 600）：上游地址和 key、rustfs 受限 key。`models.yaml` 里端点写 `base_url: secret:UPSTREAM_BASE_URL`
- [x] rustfs 受限 key：用户 `sbot-core` + 策略 `sbot-core-rw`，只能对 `sbot-raw`、`sbot-backup` 读、写、列，**不能删**（核心被攻破也删不掉备份），其他桶不可见。工具是 rustfs 自己的 `rc`（MinIO 的 `mc` 官方下载已下线，410）。注意管理员 secret 以 `-` 开头，命令行要加 `--`
- [x] systemd：`sbot-core.service`（sbot、`sbot.slice`、`OOMScoreAdjust=-500`、`MemoryMax=1500M`、`KillMode=control-group`、`TimeoutStopSec=30`、ProtectSystem=strict 只放开 `/srv/data/sbot`）；`sbot-backup.timer` 每天 03:30（UTC+8）
- [x] 备份：`VACUUM INTO` 快照 + `config`、`agent-home` 的 git bundle → `sbot-backup/<日期>/`，带 manifest；下载回来做过恢复验证（integrity ok、bundle 能 clone）
- [x] E2E（2026-11-17）：主人 01:44 实测私聊、`/usage`、长问题都正常回复。kill 测试在核心层面注入 inbox 行（Mac 的用户 token 没有 `im:message.send_as_user`，不为测试扩权限），`core/test/vps-killtest.sh <延迟> <文本>`：
  - A：run 开始 1 秒杀（卡片发出前）→ 重启后标 `restart_retried`，重跑一次，只发 1 张卡片
  - B：卡片发出后杀 → 不重跑，`interrupted`；卡片补上「（被重启打断了）」并关掉流式；通知 1 条。数据库核对无重复（`core/test/state.js`）
- [x] **流式卡片**（`card.ts`、`feishu-api.ts`）：每轮一张卡片，首个字或工具事件时建卡（3 秒没动静先显示「思考中…」）；正文推全文、飞书打字机式显示增量；正文下一行灰字状态（🔍 搜索中…）；结束时整卡更新去掉状态、关流式。**先写 outbox（kind=card）+ side_effects 再发**，崩溃不会出第二张卡片；重启时关掉遗留的流式卡片。>20k 字的部分另发一条。`SBOT_STREAM_CARDS=0` 关掉
  - 接口：`POST /cardkit/v1/cards` → `POST /im/v1/messages/:id/reply`（`uuid` 幂等）→ `PUT /cardkit/v1/cards/:id/elements/:eid/content`（`sequence` 严格递增）→ `PUT /cardkit/v1/cards/:id` 整卡更新（`streaming_mode:false`）。流式模式 10 分钟自动关；单卡片 10 QPS（流式更新豁免）
  - **慢**：lark-cli 每次 ~3 秒（海外到国内新建 TLS ~1 秒 + 每次重新取 token），卡片更新很粗。`secrets.env` 里加上 `FEISHU_APP_SECRET` 后核心自己取 tenant token、长连接直连（预计 ~0.3 秒/次，更新间隔 250ms），不用重启（secrets 按 mtime 重读）。**待 主人 提供**
  - lark-cli 没有 cardkit 命令，fallback 用 `lark-cli api`；拿不到 tenant token
- [x] owner DM chat_id 已知（`kv feishu.owner_dm_chat`，bot 按 open_id 发消息时拿到的）
- [x] worker 的 scope `MemoryMax`：`worker-exec` 用 `systemd-run --scope -p MemoryMax=1G`，M2 已接上

### 13.2 M1 / M2 进度（2026-11-17）

新模块：`approvals`（状态机、卡片、过期清扫）、`observer`（以 主人 身份轮询他的群、群列表过目卡、`/group`）、`triage`、`routes`（管理群 / 工作台 / 卡片回调）、`tasks`（Task Engine）、`egress`（worker 出网代理）、`timers`（follow-up）、`matters`（事、起局 playbook）。

- [x] **M2 端到端**（`core/test/m2-smoke.ts`，按 sbot-core 同款 systemd 沙箱跑，核心临时停）全过：worker 以 sbot-w 在 bwrap 里 clone bundle → 改 → 提交 → `git_push` 被 PreToolUse 挂起 → 审批 pending、提交钉在镜像的 `refs/sbot/pending/…` → expert 审「可以推」→ 批准 → 核心从镜像推那个 sha 到 `sbot/…` 分支（main 不动）→ resume worker → 报告 → done；只推一次；origin lane 收到完成事件；follow-up 到点进 lane；事的页面写入。light 档一个小任务约 $0.05
- [x] **systemd 收紧项和 worker 冲突**，已从 `sbot-core.service` 去掉：`NoNewPrivileges` / `RestrictSUIDSGID`（要 `sudo -n worker-exec`）、`ProtectKernelTunables`（/proc 下的覆盖挂载让 bwrap 在 userns 里挂不了新的 proc：`Can't mount proc on /newroot/proc: Operation not permitted`）；`ReadWritePaths` 加 `/srv/data/sbot-w`（worker 继承核心的挂载命名空间）
- [x] worker 交报告带 `outcome`（done / partial / blocked）；blocked 记 failed。实测沙箱坏掉时 worker 没有试图绕开，如实交了 blocked
- [x] 配置：`feishu.yaml`（管理群 + 工作台话题群「SStudioBot 工作台」，bot 建、主人 在群里、bot 是管理员）；`repos.yaml` 里一个演示仓库 `demo` → `/srv/sbot/repos/demo-remote.git`
- [x] **主人 的用户授权**（VPS 上的 lark-cli `auth login --domain im --scope im:message.send_as_user`，11-17 完成）：过目卡发出，主人 选了「按这个开始」（默认全部进 Triage）。修了一个坑：`+messages-search` 的 `--start/--end` 带毫秒（`.000Z`）会报 99992402 field validation failed，改成整秒 `+00:00`。首轮 12 条 → Triage 分出 archive / notify / draft，草稿成了审批 #2
- [x] 验收 M2（实机）：私聊派活到 demo → 工作台话题 → 推送卡 → 主人 批准 → `5b0fd4f` 推到 demo 远端 → 完成报告；「10 分钟后提醒我」按时到点
- [ ] 验收 M1（工作群有人 @主人 → 草稿卡 → 发送；先自己回了 → 作废）：等 主人 的用户授权（要租户审批）
- [ ] 真仓库的推送凭证（GitHub）还没配；目前只有本地演示仓库
- 已知：各任务目录都归 sbot-w，任务之间能互相读（先接受）

### 13.3 M3a 进度（2026-11-17）

M3 拆三段：**M3a** 记忆底座 + 定时 + 巡检（本节）；**M3b** 控制台（tailscale serve 8444 → unix socket）；**M3c** 复盘、前瞻、timeline、随手记、self/、habits、noticings、周体检卡、style notes。

新模块：`wiki`（页面可见性、`pages_fts` FTS5 trigram + 短词 LIKE、`index.md` 代码重建、`log.md`）、`dream`（夜间整理）、`digest`（先安静 + 早报事实）、`sentinel`（巡检）；`timers` 重写成 follow-up + `config/jobs.yaml` 两种。

- [x] **可见性**：self/、journal/ 恒 owner；shared/ 为 shared；projects/ topics/ sources/ groups/ 为 work；其余 owner。frontmatter 只能收窄。`memory_search` 走全文索引并按读者过滤
- [x] **jobs.yaml**（热加载）：`dream` 03:00、`dream_diff` 08:25（改动发管理群）、`morning` 08:30（代码攒事实 → 主 agent 在私聊写早报）。晚 15 分钟以上记 missed 不补跑；上一次还没处理完就 skip；私聊 `/job` 列表、`/job <名字>` 立即跑
- [x] **Dream**（§8.3 由代码执法）：只能 `memory_patch` USER.md / MEMORY.md / people/ groups/ projects/ topics/；每处必须引用 journal 行，按行上的 src 判：USER/MEMORY 只收 owner 和 owner 会话的收尾；别人说的要写成「X 说」；web 只进 projects/ 且带链接；USER.md 改动先过 expert；4000 字上限；一晚最多 12 处，一处一个 commit。管理群回「回滚 <sha>」撤销
- [x] **先安静**：没人说话触发、且带 quota 的事件（follow-up 到点、任务完成/失败通知）计数；当天超过 `gate.yaml proactive_daily_cap`（默认 6）就压下，并进第二天早报。任务来问话、早报本身不计
- [x] **巡检**（纯代码，5 分钟一次，同一项 6～24 小时内不重复）：审批等超 2 小时、对话轮卡 20 分钟、任务 20 分钟没输出、outbox 失败、代理 30 分钟错误率 > 30%、当日花费到预算 80%（`gate.yaml daily_budget_usd`，默认 $10）、飞书用户授权不在、定时任务失败
- [x] `core/test/m3-smoke.ts`（临时 home + 独立代理端口，核心不用停）全过；`--live` 跑一次真 dream：3 处修改（USER.md 过了 expert），群里「老王说 主人 同意了周五上线」只进了群页面且标注未确认，约 $0.06
- [x] 已部署；第一次巡检就报了「飞书用户授权不在」（预期，每 24 小时提醒一次）
- [ ] 资料 ingest 到 rustfs 推后
- [ ] 第一次真实早报和 dream：明天 08:25 / 08:30 看

### 13.4 M3b 进度（2026-11-17）

控制台：`https://<host>.<tailnet>.ts.net:8444`（只在 tailnet 内可达）。`tailscale serve --bg --https=8444 unix:/run/sbot/console.sock`。2026-11-18 加公网入口（§10.1）：`web.origin` 指向的 443，经 nginx 到 `/run/sbot-web/console.sock`，密码 + 会话 cookie。

- [x] **入口与鉴权**：`node:http` 听 `/run/sbot/console.sock`（目录 0700 sbot，由 systemd `RuntimeDirectory` 建，只有 root/tailscaled 能连）。每个请求必须带 `Tailscale-User-Login`，并且在 `config/console.yaml owners` 里，否则 403。非 GET 还要带 `x-sbot-console: 1`（防 CSRF）。CSP `default-src 'self'`，不用内联脚本。本地开发用 `SBOT_CONSOLE_PORT` 听 127.0.0.1
- [x] **页面**：状态（今日花费/预算、审批、在跑的、连接与健康、定时任务可「现在跑」、记忆）· 流转（按天分组：对话 run、群消息、任务、审批、事件，点开看每一步）· 用量（7/14/30/90 天，按档堆叠日花费 + 预算线、按小时、按请求方、按模型，可切表格）· 模型（三档换模型、预算、端点、密钥）· 群（搜索、筛选，always / @我 / 摘要 / 关闭 四档切换）· 记忆（改动 diff + 撤销、页面浏览、搜索）· 配置（8 个 yaml 在线编辑 + 历史）
- [x] **改配置**（和卡片、命令走同一条路）：先比 hash（中途被改过就 409），再解析 YAML，用 `schemas.ts` 的 zod 校验，写入并 git commit「(via console)」，记 `config_changes`（source=console），管理群发 diff。`widening()` 识别到放宽上限、删敏感词、加 owner、改 repo URL 时，另发一条 ⚠️。console.yaml 不允许把自己移出 owners
- [x] **密钥只写**：原子写 `secrets.env`（0600）。接口只返回名字、是否已设、谁在用；管理群收到 🔑 通知，不带值；值不进日志、不进 git
- [x] 实测：没带头 / 别的用户 / PUT 没带 CSRF 头都是 403；YAML 写错、schema 不符、hash 过期、把自己移出 owners、空密钥、非法模型名都被拒，配置仓库没被弄脏
- [x] 顺手修：observer 的 `+messages-search` 时间不能带毫秒（99992402），改成整秒 `+00:00`
- [x] 主人 在「模型 → 密钥」填 `FEISHU_APP_SECRET`
- [x] 端口：控制台用 8444；客户端如果开了 TUN 类代理，要绕过 `*.ts.net`、`100.64.0.0/10`
- [x] **公网入口**（v0.17）：两个入口各一个 socket、各信各的身份证明；`core/test/console-web-smoke.ts` 55 项全过（公网入口带伪造的 `Tailscale-User-Login`、没 cookie、mac 错、别的 key、过期、未来时间都被拒；登录要本站 Origin，按 IP 和总量限流；写操作要 cookie + Origin + CSRF 头；密码哈希和会话密钥不能从控制台写；没 `web.origin` 时 404；tailnet 入口行为不变）
- [x] 公网入口上线（2026-11-18）：Cloudflare 加灰云 A 记录、`install.sh <host>`（Let's Encrypt、nginx、`/run/sbot-web`）、`console-passwd`、经控制台写 `web.origin`。从公网实测：HTTP/2、证书有效，没登录跳登录页 / 接口 401，伪造 `Tailscale-User-Login` 读写都是 401，外站提交登录 403。同一台 Mac 上 8 次请求：tailnet 1.1～5.3 s（中位约 2.7 s），公网 1.1～2.9 s（中位约 1.5 s）
- [x] **响应性能**（§10.5）：`core/test/console-perf-smoke.ts`。同样的首屏 6 个请求，正文 64 KB → 18 KB，刷新 64 KB → 0（全 304）；5 条 SSE 连接 12 秒的核心 CPU 121 ms → 14 ms

### 13.5 M3c 进度（2026-11-17）

§15 陪伴的大部分 + §16 A 级。复盘和前瞻不另起进程：定时任务（或事收）把代码整理的事实和 skills/ 里的方法塞进主人 DM lane，主 agent 开口，他的回话在同一个会话里接着聊。

- [x] **时间线**：`timeline` 视图（他私聊说的、他在群里说的、随手记、代发、审批、任务、事、前瞻、回看、复盘），`timeline_query` 按时间 / 事 / 领域 / 关键词查。日历没进（要飞书日历 scope，等 主人 点头）
- [x] **随手记** `note_add`（life_notes，带领域 work/family/friends/body/mind，同时写 journal）
- [x] **前瞻** `outlook_submit` / `outlook_revisit`：日 1 条、周 / 月 / 事 3 条，写下不改，回看单独追加；周、月写 `self/outlooks/<期>.md`。早报加「今日留意」（最多 1 条，挂在周 / 月前瞻下）
- [x] **复盘** `review_submit`：日（21:30，安静的日子不发；周日 / 1 号并进周 / 月复盘）、周（周日 20:30，+ 下周前瞻）、月（1 号 20:00，+ 本月前瞻；1/4/7/10 月加季度清理提问）、事收（matter_close → closing 时排进这件事的 lane，复盘写回事的页面，状态 reviewed）。没有他的原话就记「未聊」，agent 的对照丢掉。问题反馈记 `review_question` 信号
- [x] **习气 / 节律**：`self_items` 表，代码生成 `self/habits.md`、`self/rhythms.md`（visibility: owner）。dream 用 `self_candidate` 提候选（只写行为；他的原话 1 条就够，推断的至少 2 条；一夜最多 6 处）；只有他能认（`self_mark` 要 `owner@` 来源 + 原话）
- [x] **谁先看见 / 送一程**：noticings 表；记成他先看见必须引他这次的原话；连续 3 次他先看见 → 送一程（不再主动提）；送一程后 agent 连续 2 次先看见 → 问他要不要再提醒。参数在 `config/self.yaml`
- [x] **风格笔记 + 例子库（§16 A）**：审批改稿意见、草稿被他自己回复作废都记 journal（owner@approval）；dream 可写 `style/*.md`、`self/guidance-notes.md`（只认他的话）；Triage 起草前带上 style/general.md + 匹配群名的笔记 + 这个群最近 3 条批准稿 + 他最近 5 条发言
- [x] **办事体检卡**（周一 09:05，管理群）：起草五种结局、平均改几轮、分拣分布、「可能漏了」、任务、主动消息、专家、出错 run、复盘聊 / 未聊、按请求方花费，各带上周对比；只有指标
- [x] **隐私（§15.9）**：飞书里 memory_read 读不了 self/habits.md、rhythms.md、charts/（用 self_list；v0.23 起他私聊里亲手问的可以读，§15.9）；管理群 dream diff 对 self/ 只报候选数
- [x] `test/m3c-smoke.ts` 33 项全过；已部署，jobs.yaml / self.yaml 已提交
- [x] 顺手修：lark 用户 token 进入 `needs_refresh` 时 observer 当成「没授权」停了调用，于是永远不会刷新（每 2 小时停一次）。现在 refresh token 有效就照常调用，调用时自动刷新
- [ ] 没做：节气月（self.yaml `month: solar_term` 先按公历月）、日历进时间线、控制台的时间线 / 习气 / 前瞻页面、lens-notes（M6）
- [ ] 第一次真实日复盘今晚 21:30；周复盘周日（11-22）20:30；体检卡下周一 09:05

### 13.6 M6 进度（2026-11-17）

- [x] **镜头插件** `/opt/sbot/plugins/sbot-lens` v0.2.0（root 只读）：紫微（chart / natal / zhanbu）+ 六爻（liuyao-guanxiang）。跑在密封 worker 里：sbot-w、空 egress（没网）、只给 Bash/Read/Write/Glob/Grep/Skill，显式 skills 白名单，15 分钟、60k 预算
- [x] **解读账本**：`readings`（写下不改，带 profile_version = 镜头 + 设置 + 出生信息 + 插件版本的 hash）、`reading_revisits`（只记他的原话）。盘冻结在 `self/charts/<lens>/<版本>/`
- [x] 工具 `lens_reading`（L1，主人）、`readings_query`、`reading_revisit`（只认 owner@）。同一件事同一门镜头只看一次（渎则不告），事情变了写明原因才再看；月视图写下就冻结
- [x] 出生信息只在 `config/self.yaml`（控制台填，保存时管理群只报行数）；飞书里不问出生时间，不贴盘
- [x] 复盘接上：周复盘带本周到期的 claim，月复盘带上月 / 本月看法和 `self/lens-notes/`，事收带这件事的看法；dream 只从他的回看原话写 lens-notes，不打分
- [x] `lens_month` 每月 1 号 06:00 排流月；`test/m6-smoke.ts` 离线全过，`--live` 一卦六爻真跑通（$0.14）
- [x] v0.23：生辰表单、`self_profile`、`self_page`、六爻日周月例行看法；`test/self-profile-smoke.ts`
- [ ] 没做：控制台的看法 / 盘页面；节气月

### 13.7 M7 进度（2026-11-17）

§16 B 级的闭环骨架：信号 → 回放样本 → 提案 → 回放 → 一张卡 → 生效 → 两周回看 → 一键回滚。

- [x] **可调文件**（`src/tuning.ts`）：`tuning/triage.md`、`tuning/draft.md`、`tuning/main.md`（追加到分拣 / 起草 / 主 agent prompt 末尾）、`skills/review/SKILL.md`、`skills/outlook/SKILL.md`。都在 agent-home（git），visibility 默认 owner。主 run 和起草 run 的 `versions_json` 记每个文件的版本
- [x] **回放样本** `eval_cases`（代码收，期望答案都是他的）：批准稿的最终文本、他自己回复作废的那条、触发草稿的消息（批准 / 自己回 → raise，拒绝且说「不用回」→ no_draft）、分拣漏（判归档 / 忽略后 2 小时内他自己在群里说话）
- [x] **improve 任务**（每天 02:30 检查）：≥ min_signals（10）个新信号且离上次 ≥ 7 天，或满 28 天；有待批提案卡就不跑。`/improve` 强制跑一次，`/improve status` 看样本和提案
- [x] 一次 expert 调用（无工具）出 ≤ 3 条提案；代码校验：文件白名单、每条 ≥ 2 个真实证据 id、确有改动、SKILL.md 不能丢 frontmatter、和 8 周内被拒的太像就丢
- [x] **回放**：分拣 → 新旧 prompt 各判一遍，比漏 / 多起草；起草 → 新旧各写一稿，expert 盲评（A/B 顺序按 hash 打乱）对照他实际发的。花费按 run id 前缀累计，到 `gate.yaml improve_budget_usd`（默认 $3）就停，改大会在管理群单独提醒
- [x] **一张卡**（approvals kind=proposal，72 小时）：问题、改动、证据、回放结果、逐行 diff、花费。批准 → 写文件 + 提交 agent-home + 14 天后回看；期间文件被改过的不覆盖（conflict）。拒绝 / 过期都记下；话题里回复 = 改一下（expert 按意见重写、重新回放，卡片 v+1），以「拒 / 不要 / 算了」开头算拒绝并记理由
- [x] **两周回看**（每天 09:10）：按文件选体检指标，前后各 14 天对比 → kind=rollback 卡（回滚 / 保留，不理就保留）；回滚只在文件还是批准时那版时才自动做
- [x] 顺手修：体检把 Triage 发出提醒后的 `notified` 也算进「提醒你」，「可能漏了」也不再把已提醒的当成没提醒
- [x] `test/m7-smoke.ts` 离线 30 项全过；`--live` 一次真跑：从种子数据提了 1 条 tuning/triage.md（社交类 @我 只提醒不起草），回放多起草 1 → 0，$0.09。已部署，jobs.yaml 已提交
- [ ] 没做：C 级（代码 PR 提案）、按角色换档位的提案、worker 返工信号、控制台的提案 / 回看页面

### 13.8 M8 进度（2026-11-17）

§17 以事为轴：事件账本、信息源、导入。

- [x] **事件账本**（`src/events.ts`）：Triage 一次调用同时出动作和事件（kind × level），代码校验：序号必须在这批里、事的编号必须是正在进行的、不认识的 kind / level 落回 info / fyi；同一批里我已经回过的直接记成 done。提醒按事 / 话头分组，要你回 / 拍板在前
- [x] **自动关**：我在原处说话（回复某条就只关那条）、草稿以我的名义发出 → done；草稿被我拒 → dropped。都是代码从我的行为判断，不让模型猜
- [x] **串起来**：Triage 的输入带上正在进行的事（标题、`keys`、最近在哪些地方）和最近 7 天的话头；话头一周里跨 ≥ 2 处出现 ≥ 3 次，就进早报的「可能该起局」。挂上（`matter_link` 或控制台）后话头变成这件事的 key
- [x] **信息源**（`src/sources.ts`、`config/sources.yaml`）：飞书私聊（`feishu.dm`，默认关）、git、fetch、command 插件。新增或放宽在管理群醒目提醒；插件要核心自己的密钥直接拒；stderr 打码
- [x] **导入**（`src/importer.ts`、`import/PROMPT.md`、`import/example.json`）：`sbot-import/1` 直接导；其他材料由 work 档分块整理（≤ 6 块，3 块并发）。预览显示哪些是新的、哪些并进已有的事 / 人；导入后管理群一句话；撤销按 `[src=import:<id>]` 找回去
- [x] 工具：`matter_open` 可带 topic / keys，`matter_link`（L1）、`matter_events`（L0）、`event_update`（L1），都只给 owner；早报加「等你回 / 拍板」「按事」「可能该起局」三段；时间线多了「事件」
- [x] 控制台：待办、生活 › 事 / 导入、它自己 › 信息源（§10.2）
- [x] `test/m8-smoke.ts` 离线全过（分拣、自动关、话头、信息源三种 kind + 插件密钥规则、导入预览 / 应用 / 合并 / 撤销）；`--live` 真跑分拣 3 个地方和一次原始材料导入，$0.05；m7 回归全过
- [ ] 没做：微信侧的事件（等微信接入）；控制台里编辑 sources.yaml 之外的插件管理（插件只能主人在服务器上装）；我纠正事件级别 / 归属算不算 §16 的信号（D 级，等我定）

### 13.9 因缘进度（2026-11-18）

§18 人、事、资料的图谱。

- [x] **登记**（`src/graph.ts`）：people.yaml（只读）→ 人物页 → 飞书 / 微信里说过话的人 → 事件里的 actor，按 ID 和名字认人；名字有两个人对得上就不猜
- [x] **构建**：消息（挨着说话、@、在哪个群、私聊）、事件（谁在哪件事里、事在哪）、页面（链接、提到、事的「关键人」）、资料（喂过哪些页）、我记的关系。纯代码，最多 15 分钟重算一次，打开控制台或工具查人时触发
- [x] **圈子**：带权标签传播；名字取大家最常在的群。**因缘**：初见（在哪、同场有谁、我在不在）、最近一次、每月往来
- [x] **纠正**：改名、分圈子、隐藏、合并、拆开叫法、记关系 / 认 / 去掉；people.yaml 字节不变
- [x] 工具 `person_lookup` / `person_path`（L0）、`person_relate`（L1，只能记推测），只给 owner；控制台 生活 › 人 / 因缘（§10.2）
- [x] `test/graph-smoke.ts` 离线全过（登记、各类边和可信度、self/ 不进图、圈子、初见、路径不经过我、借机观察、纠正、工具权限）
- [ ] 没做：从对话里自动记关系；周复盘里的因缘段；增量构建（见「仍然未决」）

### 13.10 注意力窗口进度（2026-11-18）

- [x] `gate.yaml attention`（校验、热加载、按地方覆盖、缩短时醒目通知）；notify / draft 等窗口，escalate 默认不等（§4.3）
- [x] 「我回应了」一条规则，分拣前后说的话都算（§17.2）；不用回的提醒按已读过滤、受每日上限约束，超出的进早报（§9.3）
- [x] `test/attention-smoke.ts` 离线全过；m7、m8、triage-address 回归全过
- [ ] 没做：飞书里在某条消息下新开话题回复时，那条消息记录上没有 thread_id，对不上，这种情况会多提醒一次

### 13.11 飞书邮箱进度（2026-11-18）

§17.3 的 `kind: feishu-mail`。

- [x] **读取**（`src/source-mail.ts`）：收件箱和已发送，只用三个读接口；基线、分页、去重、敏感主题跳过
- [x] **判定和清洗**：`to_me` / `from_me`、一个邮件会话一个地方、去引用、去签名、截断
- [x] **分拣围栏**：外面的文字写不出 `<untrusted>` 标记；群消息升级给主 agent 时也包着；信息源不升级，封顶到提醒
- [x] `test/mail-smoke.ts` 离线全过（假 `lark-cli` 和虚构邮件）；m7、m8、graph、attention、triage-address 回归全过
- [ ] 没做：自定义文件夹；附件；邮件的「打开」链接

### 13.12 主线与每日整理进度（2026-11-18）

- [x] 主线 / 子事 / 合并、改动账本和撤销（§15.3）；事件、keys、话头、页面、图谱跟着走
- [x] Triage、早报、提醒、控制台按主线；导入按主线总结，预览给数量和提醒（§17.4）
- [x] 每日整理（§15.14）：卡片、控制台、主 agent 工具三个入口，走同一套操作
- [x] `test/matter-review-smoke.ts` 全过；m7、m8、mail、graph、attention、triage-address、console-web、m3c 回归全过；迁移在线上库的副本上演练过，副本已删
- [ ] 没做：卡片在真实飞书里的显示和点击，上线后第一张卡才验证得到

### 13.13 seed 同步进度（2026-11-20）

- [x] `memory.ts`：启动时按 `seed.state` 比对；没动过的换上（一个提交），它的规则等「更新 seed」，改过的只报一次；通知和上线通知合成一条（§8.6）
- [x] 线上实例先手动同步到 v0.24 的 SOUL、AGENTS 和两份方法（比对过都等于旧 seed，没有手改；主人授权），之后由这套机制接管
- [x] `test/seed-smoke.ts` 全过
- [ ] 没做：控制台里看哪些在等我点头；通知没理之后不再提醒

---

## 14. 里程碑

| | 内容 | 验收标准 |
|---|---|---|
| **P0** | §13 的探针脚本 | 全部有结论；不通过的项都写好了替代方案 |
| **M0 内核** | inbox + Dispatcher + `Runner` 接口（按 P0 结论接 pi 或 SDK；resume + 兜底）+ 与 harness 无关的工具层 + LLM 代理（先只接一个档）+ 飞书私聊 + 发件箱（只有 L0）+ `/model` + systemd（核心 `OOMScoreAdjust`，worker 用 scope 限 `MemoryMax`）+ 每晚备份到 `sbot-backup` + rustfs 受限 key + SOUL.md / AGENTS.md 写入红尘里修的立场和分寸 | 飞书私聊能聊；kill 进程后消息不丢、不重复回；用量能看到 |
| **M1 审批与观察** | 闸门 + 提交式审批 + 状态机 + 管理群卡片 + observer（过一遍群列表、敏感和外部群默认值、回环过滤）+ Triage + 起草 run + `/group` + **记录信号**（审批的修改意见和最终版本、起草的输入快照、runs 的版本号；只记录，不分析） | 有人在工作群 @我 → 几分钟内管理群出现草稿卡 → 我点发送 → 以我的身份发出；我先自己回了的话，卡片自动作废 |
| **M2 任务与事** | Task Engine + `sbot-w` 隔离 + 挂起式审批 + 工作台话题 + follow-up 定时器 + 三档路由 + matter（事）+ 起局（事实盘点、问发心、检查点，暂不带镜头） | 私聊派活 → 工作台开话题 → worker 申请 push → 卡片批准 → 推送成功；"周三提醒我"到点就提醒 |
| **M3 记忆与控制台** | journal 来源标签 + **知识库**（raw 入 `sbot-raw`、ingest、`index.md` / `log.md`、`pages_fts` + `wiki_search`、好答案回收、visibility）+ 备份异地副本 + dream + 晨间 diff + schedule（早报）+ Sentinel + 先安静 + 控制台（状态、模型、群、记忆、用量）+ 复盘（事收、日、周）+ 前瞻（早报里的今日留意、周前瞻；只用事实、习气、节律，不带镜头）+ 时间线视图 + 随手记 + `self/` 档案 + 习气和节律候选 + guidance-notes + 风格笔记和范例库（§16 A 级）+ 每周一张"办事体检"卡（只有指标，不出提案）+ `noticings` 记录和"送一程"（复盘顺序的调整后置到 M7） | 一周后 MEMORY.md 里有内容，而且都是我认可的；手机上能切群开关和模型；一件事收尾后，agent 先给事实初稿，再用几个问题引我说出当时的想法和感受；周日晚收到"回看本周 + 看下周"，下个周日它会把上周的建议拿出来问我 |
| **M4 微信读** | Windows 边缘 + reader + owner 会话 + 微信群 Triage + 摘要 | 能在微信里跟它聊；每晚收到群摘要 |
| **M5 微信写与他人** | sender（唯一备注 + 标题校验 + 发送确认）+ 他人会话（工具范围、硬上限、承诺检测）+ auto 规则 + 剩下的控制台页面 | 老婆问日程自动回；让它查资料整理表格时先弹审批卡；点"以后自动"后同类事情不再问我 |
| **M6 镜头与月前瞻** | lens 角色 + 统一输出格式（含 horizon / period）+ 解读账本（看法先记下、到时回看、我说感受）+ lens-notes + 紫微接入（现有 skill，流月）+ 月复盘加月前瞻 + 季度心得过目；六爻 skill 单独做好后接入；八字后续。不依赖微信，可以提到 M4 之前做 | 起局时能起一卦，月初能看流月，看法自动记下；到了时间，在复盘里被拿出来回看；一个月后 lens-notes 和 guidance-notes 里有基于我回看感受的笔记，下个月的前瞻明显引用了它们 |
| **M7 自我改进** | improve run（按信号量触发的体检，含 wiki lint 的重活）+ 陪伴信号 + 复盘顺序随熟练度调整+ 评测集自动攒 + 回放评测 + B 级提案卡 + 上线带版本 + 两周复查和一键回滚 | 一个月里至少有一条提案带着新旧对比被我批了；上线两周后卡片告诉我指标是变好还是变差；回滚一键生效 |
| **M8 以事为轴** | 事件账本（kind × level × state，自动关）+ 话头和 matter keys + 信息源（飞书私聊、git、fetch、command 插件）+ 导入（格式、提示词、预览 / 应用 / 撤销）+ 控制台的事件、导入、信息源页（§17） | 两个群加一个私聊在说同一件事 → 早报里它们在同一件事下面；要我回的那条，我在原处回了以后自己消失；从别的工具导出的总结一次导进来，事和人都在，撤销干净 |

**后置（等前面的跑稳了，再看需不需要）**
- 撤回时中断正在跑的 run 之外的细节、`/steer`、`forkSession`
- `audience` 维度、仅 bot 群（`observe_p2p` 已由 v0.13 的 `feishu.dm` 取代）
- 每人预算、大部分 expert 触发场景（大任务审计划、连续失败诊断）、按事项类型细分的 auto 规则
- 定时任务的前置检查脚本、模型预设方案、fallback 端点、多档 vision 降级链、控制台里的 8 项探针 UI

**砍掉**
- 边缘指令签名（改用 Tailscale ACL + 连接令牌）
- 由模型驱动的 heartbeat 和 HEARTBEAT.md（改成 Sentinel + follow-up）
- `declare_work`（改成硬上限 + `request_approval(plan)`）
- 工作量 S / M / L 三档（合并成自动 / 审批两档）

---

## 15. 陪伴：红尘里修

### 15.1 定位
- **红尘里修**：修行不只发生在一件件"事"上，而是在整个生活里，包括工作、家人、朋友、身体、情绪，以及时间怎么过。"事"（matter）只是其中值得起、也值得收的那些节点。不做脱离生活的修行模块。
- **两条主轴，首尾相接**：
  - **向前看（前瞻）**：在月、周、日三个尺度上，事先给出方向性的留意和建议，帮我提前看到顺着习气会错过的东西（§15.2）。每件事起局时也做一次（§15.4）。
  - **向后看（回溯）**：顺着时间线回看这段时间发生了什么、当时是怎么看的、我现在怎么感受（§15.5、§15.6）。
  - 回看得到的心得会喂给下一次前瞻，这就是类 RSI 的循环，**是这一章的核心**（§15.8）。
- **读懂我的来源不止一种（§0.3）**：办事（我怎么改草稿、拒绝了什么、什么时候回消息、事情最后怎样了）、日常（含身体）、镜头、我说的话。开着的来源它主动去看，不等我报告；但我当时怎么想、怎么感受，记录看不到，只能由我说出来，所以复盘和前瞻仍然要**引导我说**，我不说它也不追。
- **互参（v0.24，§0.2）**：起局、月前瞻、事收复盘里，事实、镜头、我自己的看法尽量并列着看；对不上的地方单独拿出来问我，而不是悄悄选一种（§15.7）。
- **修落在实处**：帮我扛掉一件事、腾出一段时间、搭一个结构，都算陪伴。不推语录、经文和道理。
- **立场和镜头分开**：
  - 佛学是 agent 的**立场**，写进 SOUL.md 和 AGENTS.md：觉察、习气、因果，不执着于结果。它决定 agent 怎么说话、什么时候提醒。
  - 八字、紫微、六爻是**镜头**，做成插件，负责在信息不足时提供视角。镜头不是判决，要结合生活来感受。
- **分寸**（写进 AGENTS.md，代码层面有对应约束）：
  - 发心和功课只能由我定。agent 负责提醒和陪伴，不说教，不替我做决定。
  - **前瞻是建议，不是安排**：不替我排日程、定目标，也不改日历。条数要少：月和周各不超过 3 条，日 1 条。我想落成行动时，再由我说"帮我设个提醒"或"起个局"。
  - 我自己的感受和看法，分量高于 agent 从记录里做的推断。
  - 凶象不说死。健康、法律、大额钱财上，镜头只作参考，必须同时给出事实层面的建议。
  - 我状态不好时先陪着，不急着解盘、复盘，也不急着给建议。
  - **会退后**：我自己能看见的，它就不抢先说（§15.13）。它的目标是让我越来越不需要它来提醒，而不是越来越离不开它。
  - 陪伴内容只出现在 owner 会话里。他人会话里 agent 不评论我，也不对别人用镜头。

### 15.2 节律：月、周、日的前瞻

**前瞻和复盘是同一场对话的两面**：先回看刚过去的这段，再看接下来的这段。所以不额外占消息额度。

| 尺度 | 时机 | 内容 | 发到 |
|---|---|---|---|
| **月** | 月初（公历月或节气月，在 `config/self.yaml` 里选），和月复盘合成一场对话 | 先回看上月（拿出上月的前瞻）→ 先问"这个月你想怎么过，最在意什么" → 再给不超过 3 条留意和建议 | 微信 owner（M4 之前发飞书私聊） |
| **周** | 周日晚，和周复盘合成 | 先回看本周 → 问下周最在意什么（可以不答）→ 结合下周的日程、在办的事、月前瞻在下周的落点，给不超过 3 条 | 同上 |
| **日** | 早报里一段"今日留意"，不单独发 | 今天的会和事，加上周前瞻在今天的落点，给 1 条；没什么就不写 | 早报所在的会话 |

- **每条建议的依据分四个面**，用到哪个面就引用哪个面，都没有就不硬凑：
  - **事实**：日历、在办的 matter、截止日、我做过的承诺、上一期遗留的事。
  - **习气**：跟这段时间的场景相关、我认可过的习气（§15.10）。
  - **节律**：`self/rhythms.md` 里我认可过的规律，比如"月中精力偏低""季末容易焦虑"。
  - **镜头**：日、周、月的例行看法，由 lens 跑，记进解读账本（§15.7）。**默认都开**，主人要的；不想要就在 `jobs.yaml` 那一行写 `enabled: false` 或删掉。今日一卦并进早报，下周一卦并进周日的复盘 + 前瞻，月度看法并进月复盘。
- **层层嵌套**：日看周，周看月。下一级引用上一级的留意点，告诉我它在这一天、这一周落在哪里，而不是每次重新编一套。
- **格式**：每条建议是 `{ text, why_refs, look_for, revisit_at }`，写进 `outlooks` 表。写入后冻结，之后只能追加回看，规则和解读账本一样。
- **跟起局的关系**：起局时会先把这件事放进当下的节律，引用本月和本周相关的留意点（§15.4）。

### 15.3 "事"是一等对象

matter = 一件值得起、也值得收的事：一个项目、一个决定、一次重要沟通、一段冲突、一个目标。问个日程这种小事不建。生活里没有建成 matter 的部分，照样会出现在时间线上（§15.6）。

```
起 open ──► 行 active ──────────────────────► 收 closing ──► 复盘完 reviewed
 起局         task / 审批 / follow-up / 解读挂在下面     结果 + 复盘 + 镜头回看
```

- **怎么建**：
  - 我说"这事帮我起个局"或"帮我看看这事"。
  - 主 agent 判断事情够分量时**提议**建一个，只在当前回复里提一句，可以忽略。够分量的信号包括：开了大任务、要以我的名义做承诺、出现冲突、我明显在纠结。
- **存在哪**：
  - `matters` 表放状态、收的条件和关联。
  - `agent-home/matters/<id>.md` 放内容：发心、方向、过程要点、复盘。这些查不回来，属于记忆。
- **关联**：tasks、approvals、timers、readings 都带 `matter_id`。复盘时顺着它就能把这件事的全部事实捞出来。
- **事件**（v0.13，§17.2）：各个群、私聊、信息源里关于这件事的有意义时刻，按 kind × level 记在 `events` 里，`matter_id` 指过来。这件事在各处的叫法记在 `matters.keys`，Triage 靠它把不同地方说的同一件事串到一起。还没有事的先挂在话头上，反复出现就提议起局。
- **lane**：matter 跟着它所在的会话走，起局和事收复盘都发在那里。工作的事在飞书私聊或工作台话题，私事在微信 owner 会话。
- **主线和子事**（v0.19）：事一多就追不住，我真正跟的是几条长线。
  - 没有 `parent_id` 的事是**主线**；挂在主线下的是**子事**（一个阶段、一块单独要跟的事）。**只有一层**：把带子事的事挂到别处，它的子事直接归到新主线下。工作和私事不混。
  - 控制台、早报、提醒、`matter_list`、Triage 的输入默认只看主线，子事折叠。事件、任务、跟进沿子事汇总到主线；图谱里一条主线一个节点（§18.3）。主线收了而子事还开着，子事单独露出来，不会看不见。
  - 为什么不只做合并：合并会把各件事的边界抹掉，判断错了代价大。挂上去什么都不搬，所以默认用挂；**合并只用于真重复**。
- **合并**：重复的事 `status='merged'`、`merged_into` 指向留下的那件，行和页面都保留。事件、任务、审批、提醒、解读、前瞻、随手记、复盘搬过去，它的 keys 和标题变成留下那件的 keys，同名话头下没挂事的事件一起归过去，子事跟过去。之后用旧编号或旧叫法找到的都是留下的那件。
- **改动都记账**（`matter_ops`）：挂、拆、合并、开主线、收、改事件状态或级别、挪事件、话头归事、改名，每次一行：谁、什么时候、为什么、撤销需要的东西。撤销只还原记录下来的部分，之后新发生的不动；后面的操作动过同样的事，要先撤销后面的。入口只有我的手：整理卡片、控制台、或我在对话里明确说了之后主 agent 调 `matter_regroup`（L1，owner 会话）。

### 15.4 起：方向性引导（一次 reflect run）

产出写进 matter 文件：
1. **放进当下的节律**：本月和本周前瞻里跟这件事相关的留意点（§15.2）。
2. **事实盘点**：已知什么，未知什么，关键人（引用 people 笔记），关键时间点。盘点完先问一句：还有什么是记录里看不到的？
3. **问发心**：这件事我真正想要的是什么。agent 只问，不代填。
4. **镜头视角**（可选，我要了才起，也可以在某类事上设成默认）：起一卦、看流月等，由 lens 跑。每条都标明门派和版本。留意点和看法记进解读账本（§15.7）。
5. **习气提醒**：从 `self/habits.md` 里我认可过的条目中，挑出跟这类事相关的 1～2 条。比如"这类事你以往容易……，这次可以留意"。
6. **检查点**：设 follow-up（比如"周三看下对方的反应"），定好收的条件（某个日期或某个事件）。

### 15.5 收：复盘

| 触发 | 时机 | 默认发到 |
|---|---|---|
| **事收** | matter 达到收的条件：任务完成、审批发出、截止日到、我说"这事完了" | 这件事所在的 lane |
| **日** | 每晚 schedule；当天没事就不发 | 微信 owner（M4 之前发飞书私聊） |
| **周 / 月** | 和下一期的前瞻合成一场对话（§15.2）；月复盘可以走 expert | 同上 |

**复盘是一场对话，不是一份报告。** 记录只能看到我做了什么，看不到我当时怎么想、怎么感受。这部分只能由我自己说出来，而说的过程本身就是觉察。

1. **事的层面，先给事实初稿**：从时间线（§15.6）里拟出经过，包括 messages、outbox（我实际发出去的）、审批里我改了什么和拒了什么、日历、journal。这样我不用从零回忆，只需要纠正和补充。目标和结果怎么对比、做对了什么、下次怎么做，可以沉淀进 projects 笔记或 skill。
2. **心的层面，先问再给**：agent 先不亮出自己的看法，用开放的问题引我自己说，比如：
   - "那个节点，你心里是什么感觉？"
   - "有没有哪一刻，其实想换个做法？"
   - "这件事里有什么是记录里看不出来的？"
   - "回头看，你的发心变过吗？"

   等我说完，agent 再补充它从记录里注意到的东西，以及跟习气、功课有关的观察。这些是**对照，不是结论**。先给结论，我容易顺着说下去，就失去了觉察的意义。
3. **引导的节奏**：
   - 每次挑 1～3 个问题，跟着我的回答往下追问，不发问卷。
   - 我只回一句也可以；我说"今天不想聊"就停。
   - 日复盘轻一点，事收和周、月复盘可以深一点。
4. **前瞻和镜头回看**：把这一期开头写下的前瞻和镜头看法拿出来，配上这段时间线，问我结合生活有什么感受，比如"上周日说要留意……，这周怎么样？"（§15.7、§15.8）。
5. **落档**：
   - 我说的话原样存进 matter 文件或 `self/reviews/`，标 `src=owner`，分量最重。
   - 习气候选：我自己说出来的直接算候选，原话就是证据；agent 从记录里推断的，仍然需要至少 2 条证据。
   - 我没回的，保留事实初稿，心的部分留空并标为"未聊"。**这部分不由 agent 代写，也不靠 agent 记得去写：由代码写**（见下）。
   - **谁先看见**：这次复盘里每提到一条习气或节律，记一笔是我先说出来的，还是 agent 提的（§15.13）。

**未聊由代码记**（日、周、月复盘；事收不设截止）。复盘发出时记一条等待（`review_open`），到截止时间还没有落档，代码自己写进 `reviews`，`status=unchatted`，`delivery` 说明这一轮怎么结束的：

| `delivery` | 情况 | 事实部分 |
|---|---|---|
| `sent` | 发出了，我没回 | 当时实际发给我的内容 |
| `replied` | 发出了，我回过话，但这场没有落档 | 同上；不从我的消息里猜哪句算复盘，原话留在时间线 |
| `not_sent` | 没发出去：模型失败、重试放弃、核心不在线错过、这一轮没出内容等，原因写在记录里 | 代码整理的时间线 |

- **截止时间**：日复盘是第二天早报之前（在早报取数之前写好），周、月是发出后 24 小时。安静日本来就不发，不记。
- 已经 `review_submit` 过的不重复写。代码写完之后我才聊上的，`review_submit` 用真实记录替换这一条；空的提交不会多出一条。

### 15.6 时间线与回溯

**一条时间线把生活里的事实按时间串起来。** 它是一个 SQL 视图（§11），不另存一份；日程不落库，回溯时现查飞书日历再合并进来。时间线包括：
- 我在 owner 会话里说的话
- 我发出去的消息（outbox）
- 审批，以及我在审批里改了什么
- 任务、matter 的起和收
- 前瞻、解读、复盘
- **随手记**：我随口说的"记一下：今天心里有点乱"，存进 `life_notes`，标 `src=owner`

每条都带 `domain`（工作、家庭、朋友、身体、心）、`matter_id` 和相关的人。人生大事年表 `self/timeline.md` 是从时间线里提炼的大事，由 agent 提议、我确认。

**回溯的几种方式**（工具 `timeline_query({ from, to, domain, person, matter, kind })`，只在 owner 会话可用）：
- **按周期**：周复盘、月复盘自动拉这一期的时间线，配上期初的前瞻。
- **按线索**：顺着一个人、一类事、一条习气往回看，比如"这半年我和 X 的沟通""最近三次谈判"。
- **同期对照**：去年此时，或者上一个同类节点（比如每年年底）。
- **按镜头周期**：流月、流年交接时，回看上一段。

**回溯的输出仍然是对话**：先摆出时间线摘要，问我看到了什么，然后 agent 才给它注意到的规律，只当对照。

### 15.7 镜头与解读账本

**立场：镜头是一种看法，要结合生活来感受。** 不追求绝对的对错，也不打分。在意的是两件事：它有没有让我留意到原本会忽略的东西；时间长了，哪种看法对我来说更贴。

- **镜头是插件**，每门一个 skill：
  - 紫微：现有的 ziwei-chart、ziwei-natal、ziwei-zhanbu。
  - 六爻：以 zhouyi-qigua.pages.dev 为准，单独做 skill。
  - 八字：后续再定。

  所有镜头统一输出下面这个格式，内核只认格式，不关心是哪一门。用在前瞻里时，额外带上 `horizon` 和 `period`：
  ```json
  { "lens": "liuyao", "method": "…", "profile_version": "…", "question": "…",
    "horizon": "month|week|day|null", "period": "2026-12",
    "reading": "…", "notice": ["留意点…"],
    "claims": [{ "claim": "…", "revisit_at": "2026-12-01", "look_for": "到时候留意什么" }] }
  ```
- **当时的看法先写下来**：留意点和看法在事情发生之前写进 `readings` 表，之后不改原文，只能追加回看。这不是为了考核，而是回看时能知道"当时是怎么看的"，免得记忆被结果改写。
- **回看**：到了约定的时间，或者事情收尾时，就在复盘里把当时的看法拿出来，配上这段时间线，问我结合生活有什么感受。我说"有感应""没什么感觉""还看不出来"都行，直接说一段话也算数。模型不替我下结论。
- **事实视角并列**（可选）：同一个问题，agent 也可以只基于事实写一段看法（`source=agent`），放在镜头的看法旁边。回看时两种视角一起看，更容易看清镜头补上了什么。
- **互参（v0.24）**：并列之后多做一步：说出几种看法**哪里对得上、哪里对不上**。对不上的地方写进这条 reading 的 `notice`，回看时先问它。不投票、不取平均，也不让镜头当裁判；时间长了，哪种看法在哪类事上更贴，进 `lens-notes/`（§15.8）。
- **版本冻结**：出生信息或这门镜头的设置（起卦方式、要求）改了就算新的 `profile_version`，账本按版本分开。
- **按时间段的例行看法（v0.23）**：不需要生辰，六爻有 `day`、`week`、`month` 三个方法，所问之事就是这段时间本身。

  | 任务 | 默认时间 | 看哪段 | 谁跑 | 回到哪里 |
  |---|---|---|---|---|
  | `lens_day` | 每天 07:50 | 当天 | 六爻 | 早报；日复盘回看 |
  | `lens_week` | 周日 19:30 | 周日看下一周，其他日子看本周 | 六爻 | 周日的复盘 + 前瞻；下一次周复盘回看 |
  | `lens_month` | 每月 1 号 06:00 | 当月 | 六爻；有生辰再加紫微流月 | 月复盘 + 月前瞻 |

  任务本身不说话，只写账本，所以不占主动消息额度。同一段时间、同一个版本只看一次；改了生辰，新盘的流月不被旧的挡住。回看日期的扫描跳过日、周看法，免得淹没周复盘和月复盘。花费照常计量，预算机制不变。已有实例升级时加一次默认任务，之后删掉或关掉都不会再加回来。
- **渎则不告**：同一件事反复问，门派上就不该再占，所以 `cast`、`zhanbu` 仍是一件事一次，事情本身变了才再看。例行起卦每次问的是新的一段时间，不受这条限制。

### 15.8 RSI：越用越贴

```
前瞻（月 / 周 / 日、起局）── 看法和建议写下来，冻结
   │
   ▼
生活（时间线：发生了什么，我做了什么）
   │
   ▼
回看（复盘对话：我说感受和看法）
   │
   ▼
心得（dream 整理，依据只有我说过的话，加上带证据的记录）
   ├─ lens-notes/<lens>.md   哪门镜头的哪种看法，在哪类事上对我更贴
   ├─ guidance-notes.md      哪种建议对我有用：太泛、太多、来得太晚、我真的用上了……
   ├─ rhythms.md             我的节律（候选 → 我认可）
   └─ habits.md              习气（候选 → 我认可）
   │
   └──► 下一次前瞻和起局加载这些心得
```

- **每一圈都有"我说"这一步**。月复盘最后可以问一句："这个月的建议，哪些用上了，哪些没用？"这本身也是觉察。
- **不打分**：不算镜头的命中率，也不把采纳率当 KPI。事实可以记（我回了还是没理），但心得以我的原话为准。
- **改进只改"看法和建议怎么给"**：
  - 心得文件由 dream 写，每条都引用来源（reading、outlook、review 的 id）。
  - 前瞻和复盘的方法本身（问什么、给几条、什么时候给）写在 `skills/outlook/`、`skills/review/` 里。agent 只能根据心得提 proposal，我批了才变。
  - 规则、权限、人设照旧只有我能改。
- **防漂移**：
  - dream 的每次改动都有 diff，早上可以回滚（§8.3）。
  - 每季度随月复盘把四份心得的全文给我过一遍，删掉我不认的。

### 15.9 自我档案

```
agent-home/self/
├── charts/            # 各门的事实盘（冻结版本）
├── timeline.md        # 人生大事年表：时间线的提炼，也是回看镜头时的生活依据（agent 提议，我确认）
├── habits.md          # 习气观察：每条都要有证据，分"候选"和"我认可"
├── rhythms.md         # 节律：时间上的规律，分"候选"和"我认可"
├── practice.md        # 我定的发心和功课，当前在练什么（只由我定；我在私聊说了，主 agent 才代写）
├── guidance-notes.md  # 建议心得（§15.8）
├── lens-notes/        # 每门的解读笔记（§15.7）
├── outlooks/          # 月、周前瞻的全文（日留意只在 outlooks 表里）
└── reviews/           # 日、周、月复盘
```

- 出生信息等原始资料放在 `config/self.yaml`（配置仓库）。不填也能用：六爻、紫占不需要生辰。需要生辰的 lens run 才复制一份只读副本到任务目录里，而且那个 run 断网。
- **怎么填和改**：控制台「生活 › 出生信息」的表单（日期、时间、公历或农历、性别、城市或经度、时区，以及每门镜头的开关、起卦方式、要求），或者在私聊里告诉主 agent，由 `self_profile` 记下。两边和配置编辑器走同一条路：比 hash、zod 校验、git 提交、记 `config_changes`，都能回滚。提交说明和管理群通知不带内容。
- **分界（v0.23 主人定）**：只为保护我自己隐私或谨慎加的限制去掉；防别人、防外部输入的留下。

  | 场合 | 能怎样 |
  |---|---|
  | 我的飞书私聊、控制台 | `self/`、习气、节律、命盘、看法全文都可以整份读、整份说 |
  | 工作台、管理群（都是群） | 只提一两句，不贴全文和盘面；管理群的通知不带内容 |
  | 定时任务、审批、任务、系统转来的事件触发的 run | 不能用 `self_profile`、`self_page`，也不能整份读习气、节律、命盘。这些 run 可能带着外部内容 |
  | 他人会话、Triage、普通 worker | 读不到 `self/` 和时间线，这一点在工具层校验 |

- `self_page` 能写 `self/` 下的 `.md`，每次单独一个 git 提交，`config_changes` 只记版本和字数。不能写的文件不是为了隐私，是为了不弄坏东西：`habits.md`、`rhythms.md` 由条目生成，`charts/`、`outlooks/` 冻结，`reviews/` 由 `review_submit` 落档。

### 15.10 习气与节律从哪来

这就是"办事收集信息"的价值。dream 每晚从这些事实里找候选：
- 审批卡上我怎么改草稿（比如总把语气改软或改硬），以及拒绝的理由。
- 我在什么时间、什么状态下回消息（深夜回复、连发）。
- follow-up 被我推迟了几次。
- 随手记和时间线上的时间分布（节律的主要来源）。
- **复盘、回看和日常对话里我自己说出来的观察**：这是最重要的来源。

每条候选都要写清楚：描述、证据、首次和最近出现的时间。我自己说出来的，原话就是证据；agent 从记录里推断的，至少要有 2 条证据链接。**只描述行为，不下人格结论**，比如写"这三次……"，而不是"你是个……的人"。只有我标了"认可"，才会在前瞻、起局和复盘里被引用。

### 15.11 渠道与配额
- 起局和事收复盘跟着事走（§15.3）。
- 月、周的前瞻和复盘合成一条，默认发到微信 owner 会话；日复盘也发那里。"今日留意"和今日一卦并进早报，下周一卦并进周日的复盘 + 前瞻。
- 复盘和前瞻类消息单独计数，不占 §9.3 的主动消息额度：日复盘最多 1 条/天，周、月各 1 条。我没回就不追问。
- 起局提议只出现在当前回复里，不单独发消息。

### 15.12 和闸门、记忆的边界
- 前瞻、镜头结论、习气和节律、复盘内容都**不参与任何闸门判断**，不影响审批、承诺检测和自动回复，也不出现在他人会话里。以我的名义发消息仍走审批卡片，不因为 §15.9 的放开而改变。
- journal 来源加三种：`src=lens`、`src=review`、`src=outlook`，dream 怎么处理见 §8.3。
- 改进只发生在心得文件里（§15.8），以及我认可过的习气和节律。agent 的人设、规则和陪伴方法的 skill，照旧只有我能改。

### 15.13 退后：谁先看见、送一程

按佛学的立场，成长是**我自己的觉察变强**，不是 agent 越来越会指出我的习气。设计不当，它会变成拐杖：事实永远它先拟，习气永远它先点破，我越来越依赖它来看见自己。所以要把"退后"设计进去。

- **谁先看见**（`noticings` 表）：复盘、回看和日常对话里，每当一条习气或节律被提到，记下是**我先说出来的**（`owner`），还是 **agent 先提的**（`agent`），以及当时有没有经它引导（`prompted`：它问了开放问题之后我说出来的，也算我先看见）。
  - 由 reflect 在 `review_submit` 时一并提交，dream 按我的原话核对。
  - **这是给我看的镜子，不是 KPI**：月复盘里给一句"这个月有几条是你先看见的"，季度过目时给出每条习气的变化。不排名，不打分，也不进 §16 的指标。
- **送一程**：一条认可过的习气，最近 3 次出现我都是自己先看见的（阈值在 `config/self.yaml`，只有我改），状态就变成 `送一程`：
  - 起局和前瞻里不再主动提它，只在我问"我还有什么要留意的"时才说。
  - 复盘里我没提到它，它也不提。
  - 连续 2 次我没看见、事后从记录里明显能看出它又出现了，才恢复成"认可"，并告诉我一声："这条我又开始提醒了，你觉得需要吗？"我说不需要就不恢复。
  - 状态变化写进 habits.md，晨间 diff 里能看到。
- **复盘的顺序会变**：起初 agent 先给事实初稿，我纠正补充。我用熟了以后（同样按 `noticings` 的趋势），周复盘和事收复盘有时会先问"你先回忆一下这周/这件事的经过"，我说完它再补漏。回忆本身也是练习。日复盘保持轻，不这样做。我说"还是你先列吧"就退回原来的顺序。
- **它自己那圈也学怎么陪**（§16）：哪些问题打开了我的话头，哪些换来的是"今天不想聊"，作为复盘和前瞻方法改进的依据。

### 15.14 每日整理（v0.19）

账本会变旧，导入的东西还可能一开始就不对，错的事和事件会误导早报和提醒。每天看一眼，把该归并的、该收的、不对的拿出来让我定。

- **时间**：`jobs.yaml` 的 `matter_review`，默认每天 08:15，排在 08:25 的记忆 diff 和 08:30 的早报之前，这样早报能带上今天的结果。单独一张卡而不并进早报，因为早报是模型写的文字，放不了按钮，而这里要的是一点就处理。
- **只提建议**：代码先找，模型补充，都只写进 `matter_reviews`。**事和事件只在我点了之后才变**，走 §15.3 的同一套操作，记账、可撤销。

| 类 | 怎么找 | 我能点 |
|---|---|---|
| 归并 `group` | 标题相近或 keys 相同（代码）；模型看出是同一条线 | 挂到主线 / 合并（够像才给）/ 起新主线（模型给了名字）/ 不相干 |
| 久没动静 `stale` | 主线连同子事 `stale_days`（默认 30）天没有任何动静，也没有待办的跟进或在跑的任务 | 收 / 放下 / 继续盯 |
| 过时的等回 `old_ask` | 导入的事件仍在等我，已超过 `ask_days`（默认 7）天，或所在的事已经不办了 | 处理了 / 不用了 / 只是知道 / 还在等我 |
| 可能不对 `suspect` | 模型：事件挂错、没挂但明显属于某件事、导入内容和后来的事矛盾、标题和内容对不上 | 挪 / 摘下 / 作废 / 只是知道 / 改名 / 没问题 |
| 话头 `topic` | 两周里跨 ≥ 2 处出现 ≥ 3 次、还没有事（原来早报里的「可能该起局」并到这里） | 起一件事 / 挂到某件事 / 先不管 |

- **模型**：默认 light 档，第一次用 work 档（`tier` 可配）。输入是主线、子事、事件的摘录，放在 `<untrusted>` 里，最多约 3 万字；账本没变就不调用。返回的编号由代码核对，编造的丢掉。模型失败时只用代码找到的。写进卡片的文字去掉链接、@ 和标记。
- **每天几条**：最多 `limit`（默认 5）条，第一张卡最多 `first_limit`（默认 12）条，优先给成组的归并，让导入的一堆先有形状。各类轮流取，导入来源和影响早报、提醒的排前面，同一张卡上不出现关于同一件事的两条。
- **发到哪**：一天一张卡，发在和我的 bot 私聊，占每日主动消息上限的 1 条（§9.3，上限本身不动）。超了上限就不发，建议留在控制台「生活 › 事」，早报带一句。同一天重跑只更新那张卡，不重复计数。
- **不再问**：每个问题有指纹（`fp`）。点过「没问题」「继续盯」「还在等我」的不再问。「继续盯」的指纹带最后动静的日期，之后有了新动静又沉寂下去，才算新问题。说不相干的一组，它的任何子集也不再问。撤销一个决定后，这条歇 30 天。
- **不理也不堆**：第二天旧卡收起，没处理的回到队列。一条被略过两次后歇 14 天，再略过时间翻倍，最长 60 天。连续 3 张卡没点就改成 3 天一张，连续 6 张改成 7 天一张，点一下恢复每天。问题的理由消失了（比如我自己处理了），它就自动作废。
- **和早报的关系**：早报不再列「可能该起局」，只有一句今天挑了几条。过时的导入事件不算进「等你回 / 拍板」，只报一个数；我确认「还在等我」后才回到那一段，处理掉就不再出现。
- **入口**：飞书卡片、控制台、主 agent 的 `matter_review` 工具（我说了才动）。现有的事不做一次性迁移，都从这里过，由我确认。
- 这里不产生 §16 的信号：要不要记，属于 D 级，等我定（§17.5）。

### 15.15 放下（v0.24）

读懂我的东西会越攒越多。只攒不放，它就会拿过去的我去框现在的我，我也会被自己的标签困住。人是会变的，理解也要会淡、能放下。

- **会淡**：认可过的习气、节律，`fade_days`（默认 180 天，`config/self.yaml`，只有我改）里一直没有新证据，状态变成 `淡了`：
  - 前瞻、起局、复盘不再引用；条目和证据都留着。
  - 季度过目时列出这一季淡了的条目，我可以说"还在""放下"，或者不管。
  - 之后又出现了新证据，它回到 `候选`，要我再认一次才重新引用。不会悄悄恢复。
- **能放下**：我说"这条放下"（私聊、复盘、控制台都行），状态变成 `放下`：
  - 不再主动提，dream 也不再为它攒证据。
  - 只有我说"恢复"才回来。条目留在 `habits.md` 或 `rhythms.md` 的历史里，想删在控制台删。
- **和送一程的区别**：送一程是我自己已经看得见了，它不用再提醒（§15.13）；淡了是很久没出现；放下是我决定不再背着它。三种都会写进晨间 diff。
- **不贴标签**：理解只描述行为和时间（§15.10），不写"你是……的人"。人物页里对别人的判断也一样，带最近证据的日期，很久没有新证据的不拿来当依据。
- 解读账本、复盘原文照旧冻结（§15.7）：那是"当时怎么看的"记录，不是对我的定论，回看时也按当时的语境读。

### 15.16 不绕着苦转（v0.24）

陪伴最容易犯的错，是把让我难受的事一遍遍翻出来，越聊越深、越陷越重。复盘要往外走，不在原地打转。

- **苦事**：我说过让我难受的事，包括复盘、随手记、对话里的原话，以及挂着这些原话的事和习气。
- **事和苦分开**（2026-11-19 主人定）：事上的跟进（到点提醒、下一步、等谁回）照常做，直到这件事办完，或者我判断它不需要解决了。这是待办，不算翻苦。不绕着苦转管的是难受的那一面。
- **它主动提**：难受的那一面，它不主动翻。要提必须带来新东西：新事实、新角度，或者一个往外走的小步；拿不出就不提，也不因为到了复盘就再问一遍。
- **到头就停**：事办完了，或者我说不用解决了、放下了，它就不再主动提这件事（事收的那一次复盘照常，§15.5）。
- **我主动提**：不设限。它跟着我说，先陪着；不替我往深里再挖一遍，也不急着解盘、复盘（§15.1）。
- **复盘的方向**：心的层面第一轮可以问"当时"，之后的问题朝着"接下来"："如果再遇到，你想怎么做？""有什么小事现在就能做？"
- **怎么落地**：写进 AGENTS.md 和 `skills/review/`（v0.24 已写）。之后在代码里补：它主动提起的记在 `noticings`（`first_by=agent`，带 `matter_id`）；reflect 起草前先查这件事最近一次是谁提的、那次带了什么新东西。
- **镜子**：季度过目时给一句"这一季它主动提了几次让你难受的事"。只给我看，不进 §16 的指标。

---

## 16. Agent 自己的 RSI：越用越会办事

### 16.1 和 §15 的关系
§15 是**我的**循环：看法 → 生活 → 我说感受 → 心得 → 下一次看法。这一章是 **agent 自己的**循环：它怎么办事 → 我怎么用它的结果 → 它找出差距 → 改进办法 → 下一次办得更好。

两圈的骨架一样：先冻结版本，再看真实表现，以我的判断为准。区别在评判从哪来：§15 只认我说的话；这里主要看**我的行为**（改了什么、拒了什么、无视了什么、自己动手做了什么），不用每次问我。

**底线：自我改进只能让它办事更好，不能让它权限更大。**

办事办好本身就是 §0 的一部分：替我扛掉一件烦心事就是在减苦，所以这一圈和 §15 同样要紧，不是陪伴的附属品。

### 16.2 信号（从 M1 起记录，纯代码，不调模型）

| 来源 | 信号 |
|---|---|
| 审批卡 | 原样批准；"改一下"后批准（我的修改意见原文 + 最终版本）；拒绝及理由；我自己回了导致作废（我实际发出的那条就是标准答案）；过期 |
| Triage | **漏**：判成 ignore / archive 的群里我自己回了，或者我事后去搜了那条；**多**：notify 我没理，draft 被拒 |
| 对话 | 我说"不对""我是说……"；同一件事问第二遍；我自己动手做了它刚做过的事 |
| worker | 失败、needs_input、push 被拒、我让重做、超预算 |
| 主动消息 | 回了 / 点了 / 没理（§9.3） |
| 陪伴 | 复盘和前瞻里，哪个问题之后我说了很多、哪个之后我说"今天不想聊"或不回；我在前瞻里说"这条有用""太泛了"。只用来改复盘和前瞻的方法（B 级），不碰 §15.13 的"谁先看见" |
| expert | revise / block 及理由 |
| 成本 | 每个角色、每个档位的 token 和耗时 |

- 只有**我的行为和原话**算评判。别人的反馈（比如群里有人说"你家 bot 说错了"）只当线索，要我确认后才算。
- 每个 run 记录用了哪些版本（prompt、skill、范例库、模型），信号能对应到具体是哪个版本的表现。

### 16.3 能改什么：四级

| 级 | 改什么 | 怎么生效 |
|---|---|---|
| **A** | 记忆和笔记（dream，§8.3）；**风格笔记**：从我的修改意见里提炼，按人、按场景，比如"给 X 回要短，不用敬语"；**范例库**：我批准过的最终版本，起草时按人和场景检索几条当范例。很多范例本来就是我和 AI 对话调出来的，所以真正要学的是**调教时我给的意见**体现出的倾向，最终版本是这个倾向的结果；风格笔记以修改意见为主要依据 | 自动生效。第二天早上管理群看 diff，一句话回滚 |
| **B** | skills（做事的步骤）、各角色的 prompt、Triage 规则和关键词、前瞻和复盘的方法（§15.8）、按角色的模型档位 | 提案 → 回放评测 → 我批 |
| **C** | 工具和内核代码 | worker 提 PR，我来 merge（§4.2） |
| **D** | 闸门分级、auto 规则（只来自我点"以后自动"）、他人会话的工具范围、预算和主动消息上限、凭证，以及这套 RSI 本身（信号定义、指标、评测集怎么选、这张分级表） | **永远不由 agent 提**，只有我直接改配置 |

### 16.4 循环

```
信号（每天自动记录）
   ▼
定期体检：improve run（按信号量触发，夜里跑，expert 档，没有文件工具）
   读：代码算好的指标 + 抽样的具体案例
   出：≤3 条提案，每条写明问题、证据（案例 id）、假设、改动（patch）
   ▼
回放评测（代码执行，经 LLM 代理，有单独预算）
   用评测集里的历史真题，新旧两版各跑一遍
   ▼
管理群一张卡：问题 · 证据 · diff · 新旧对比 · 预计成本变化
   我：批 / 拒 / 改一下
   ▼
上线：带版本号，runs 记录每次用的版本
   ▼
两周后对比上线前后的指标；变差就提议回滚（一键）
   └──► 新版本的表现又成为信号
```

- **评测集 `eval_cases` 由代码自动攒**，agent 不能挑选、增删或修改：
  - 起草类：（当时的输入快照，我最终发出的版本）。
  - Triage 类：（那批消息，从我的实际反应推出的标签）。
  - 只收 `src=owner` 的标准答案。
- **怎么评**：Triage 直接算漏和多；起草让 expert 档做盲评，判断两个版本哪个更接近我最终发出的，不告诉它哪个是新版。
- **节奏（动态）**：由代码按信号量触发：自上次体检以来新增的信号和评测题够多（阈值在 `config/jobs.yaml`）就跑，两次之间最短 1 周、最长 4 周。刚上线数据少时自然会稀，用熟了会密。阈值和上下限属于 D 级，只有我调。每次最多 3 条提案，合进一张卡；我没理就过期，不追问。这张卡不占 §9.3 的主动消息额度。被拒的提案连同理由记下来，8 周内不再提同样的。
- **A 级不走这个循环**：风格笔记和范例库每次我改完草稿就可以更新，由 dream 每晚整理。

### 16.5 防跑偏
- **指标不是目标**：只盯"原样批准率"，它会越写越保守、越空泛。所以几个指标一起看：编辑幅度、拒绝率、我自己回的比例、主动消息回应率、成本。最后以我批不批为准。
- **别人的话进不了提案**：群里有人说"以后都这样回"，不会变成规则。
- **改动可追溯**：每个 run 都记录版本，出了问题能定位到哪次改动，一键回滚。
- **月度过目**：A 级的风格笔记每月随月复盘给我过一遍，删掉我不认的。
- **评测和体检有单独的预算上限**，超了就停，不挤占日常办事。

---

## 17. 以事为轴：核心与插件（v0.13）

### 17.1 什么是核心，什么是插件
**事（matter，§15.3）是组织记录的轴，不是目的**（v0.24 改，原文是"人来找它，最后都是为了一件事"）。目的是 §0：陪我修自己、离苦得乐；办事是基本功，也是读懂我最真实的窗口。消息、审批、任务、看法、复盘都往一件事上挂，回头顺着一件事就能看到它从哪来、走到哪了、我在里面做了什么。生活里没起成事的部分，照样在时间线（§15.6）和因缘（§18）里。

| 核心（每个人都一样，写在代码里） | 插件 / 配置（每个人不同） |
|---|---|
| 事和事件账本、自动关、话头串联（§17.2） | 读哪些地方：`config/sources.yaml` 和 `/opt/sbot/plugins/sources/*`（§17.3） |
| 闸门、审批、发件箱（§7），信息源永远只读 | 从哪迁过来：导入材料和任何 harness 的总结（§17.4） |
| 两圈 RSI：我的（§15）和它的（§16） | 用什么镜头看：`/opt/sbot/plugins/sbot-lens`（§15.7） |
| 时间线、复盘、前瞻的节律 | 风格笔记、范例库、tuning（§16 A / B 级，越用越贴） |

加一个新的信息来源（jira、别家的邮箱、某个网页、以后的微信），不改核心：写一个插件、在 sources.yaml 里加一行。插件只往里送事实，进来的东西和群消息走同一条路：分拣 → 事件 → 挂到事上。例外是必须用核心自己飞书登录的来源：插件永远拿不到这份登录，所以飞书邮箱内置在核心里（§17.3）。

### 17.2 事件账本
**一个事件 = 一件事上一个有意义的时刻。** 由 Triage 在分拣时顺手记（§4.3），导入时也会写。

- **kind（发生了什么）**：`ask` 找他 · `decision` 定了 · `commitment` 答应 · `progress` 进展 · `risk` 风险 · `deadline` 时间点 · `info` 信息。kind 让一件事的时间线读得懂。
- **level（要我做什么）**：`fyi` 知道就行 · `watch` 要盯 · `reply` 要你回 · `decide` 要你拍板。level 把"知道就行"和"要我回"分开。发给所有人的通知、投票、公告，没点我的名就是 fyi 或 watch。
- **state**：`open`（reply / decide 还没处理）· `seen`（fyi / watch）· `done` · `dropped`。

**怎么关**：只认我的行为，不让模型猜。
- 我回应了（`markReplied`，分拣前后说的都算；v0.16 收紧，拿不准就不关，宁可多提醒）：
  - 回复了事件里的某条消息 → 关这一件。回复的是别的消息 → 不算。
  - 在事件所在的话题里说话 → 算。在别的话题里说、问题在话题里而我在主聊天说 → 不算。
  - 私聊，或信息源里有名字的一处（`where`，比如一张工单）→ 我在那里说的话算回应最新的一件。
  - 群里一句没指向的话 → 只关紧跟在问题后面的最新一件，中间别人说了超过 3 句就算话题已经过去；一句话不能同时回应几件事。@ 了提问的人算，@ 了别人不算。
  - 没有 `where` 的信息源是一条流，只认 `reply_to` / `thread`。
  - 飞书的「已读」不算回应：读了没回正是要提醒的。
- 草稿以我的名义发出 → done；我拒了草稿 → dropped（我觉得不用回）。
- 分拣之前我已经回过 → 按同样的规则，记下来就是 done；已经用来关掉别的事件的那句话不再算。
- 我在控制台或用 `event_update` 手动改。我改 level 时，state 跟着变（改成 fyi 就不再等我）。

**怎么串**：
- Triage 的输入里带着正在进行的**主线**（编号、标题、它和子事的 `keys` 即各处的叫法、子事的名字、最近出现在哪些地方，最近活跃的在前，最多 40 条）和最近 7 天的话头。模型只能把事件挂到正在进行的事上（编号由代码核对），拿不准就只给话头。
- **按叫法认**（v0.19）：话头正好是某件事的 key 或标题，没给编号也挂过去；给了主线编号、话头又是它某件子事的 key，就落在那件子事上。一个叫法对应几条主线算有歧义，不挂。旧编号、旧叫法跟着合并走到留下的那件。
- **话头**是一个 4～12 字的短说法；同一件事在不同群、私聊、信息源里沿用同一个话头。反复出现、还没有事的话头交给每日整理问我（§15.14）；没开每日整理时，早报里列为「可能该起局」。
- 把话头挂到一件事上（`matter_link` 或控制台），话头下的事件全部归过去，话头变成这件事的 key，以后 Triage 直接认。

**谁读**：
- 提醒：窗口过后还没回应的（§4.3），一批 notify 按主线 / 话头分组，要你回、要你拍板的排前面。
- 早报：「等你回 / 拍板」「按事：昨天以来」（按主线汇总）「事的整理」三段，只给事实，主 agent 写成早报。
- 控制台：待办里的「要你回 / 拍板」；生活 › 事 里今天的整理、主线（子事折叠）、改动记录，每件事的事件和等你的。
- 主 agent：`matter_events`（L0）查一件事或一个话头的事件，主线连子事一起；`matter_link`、`event_update`、`matter_open` 带 topic / keys、`matter_regroup`、`matter_review`（L1）。都只在 owner 会话。
- 时间线（§15.6）多一类「事件」。复盘时顺着 `matter_id` 就能理出这件事的时间线。

### 17.3 信息源
`config/sources.yaml`，热加载，控制台「配置」里能改（和其他配置一样：校验、git 提交、管理群通知）。

```yaml
feishu:
  dm: false          # true：别人发给我的飞书单聊也送去分拣（只记事件、发提醒，不起草）；我和 bot 的私聊永远不走这里
sources:
  - { id: core-repo, kind: git, repo: sbot, every: 30m }                                   # repos.yaml 里的仓库，任何分支的新提交
  - { id: release-notes, kind: fetch, url: "https://…", every: 6h }                        # 网页上新出现的内容
  - { id: jira, kind: command, run: jira, every: 15m, env: [JIRA_TOKEN], args: { … } }     # 主人装的插件
  - { id: mail, kind: feishu-mail, every: 10m }                                            # 我的飞书邮箱，只读
```

- 每条读进来的东西进 `messages`（surface `source:<id>`，chat_id `<id>:<where>`），跟群消息一样等分拣。git、fetch 和飞书邮箱第一次拉只定基线，不回填。
- **command 插件协议**：`${SBOT_PLUGINS:-/opt/sbot/plugins}/sources/<run>/run --since <ISO 时间>`。
  - stdout 每行一个 JSON：`{"ref","text","ts","who","where","link","to_me","from_me","reply_to","thread"}`，只有 ref 和 text 必填。
  - `from_me` 的条目是我说的话，按 §17.2 判断它回应了哪件事；`reply_to` 填对方条目的 ref，`thread` 填同一串讨论的标识。
  - 以 sbot 用户跑，HOME 和 cwd 是它自己的状态目录，最多 2 分钟；参数在 `SBOT_SOURCE_ARGS`（JSON）。
  - 只拿到 `env:` 里列的 `secrets.env` 名字，别的都没有；要核心自己的密钥（飞书应用、模型端点）直接拒。stderr 里出现密钥一律打码，状态里只留 300 字。
  - 插件由我在服务器上手动装，root 所有；agent 不装、不改插件。
- **飞书邮箱（`kind: feishu-mail`，`src/source-mail.ts`）**：
  - **为什么内置**：读信要用我的飞书身份。做成插件，要么把核心的登录给插件（这正是不允许的），要么再办一份授权并一直续期；IMAP 要管理员开第三方登录，再多一个长期有效的邮箱专用密码。内置不多任何凭据。
  - **为什么不违反「插件拿不到核心密钥」**：这条规则防的是核心凭据流到核心之外。邮箱的调用全在核心进程里，走已有的 `lark-cli` 用户登录，登录不交给插件，agent 也没有读邮箱的工具（`feishu_read` 只收群的 chat_id）。所需的读权限（邮箱、邮件、主题、地址、正文的只读 scope）已经在这份登录上，不开新 scope。host worker 有 sudo，挡它碰这份登录的仍是核心守卫这道软边界（§7.6），这一点加邮箱前后没有变化。
  - **只读靠代码，不靠授权**：这份登录本身还带着发信、改邮件的 scope。这里只调三个读接口：`user_mailbox.messages list`、`user_mailbox.messages batch_get`、`user_mailbox.settings send_as`（认我自己的地址）。读正文不会把邮件变成已读。
  - **读什么**：收件箱和已发送，从新到旧翻到没有新邮件为止，每个文件夹每次最多 200 封。第一次只读元数据定基线。自定义文件夹和垃圾邮件不读，被收信规则直接归档的邮件不会进来。主题里有闸门敏感词（区分大小写）的整封跳过。拉取失败或来晚了都不丢：下限是基线，靠邮件 ID 去重；只有一次超过上限时，更早的那部分不再补。
  - **怎么记**：每封一行，`ref` 是邮件 ID，`thread` 和 `where` 是会话 ID，所以一个邮件会话是一个「地方」、一次分拣。`to_me`：我的主地址或别名在收件人里，且收件人不超过 10 个（只在抄送、或群发名单里都不算）。`from_me`：已发送文件夹里的，或发件人是我自己的地址；它只关同一会话里的 open 事件。
  - **正文**：去掉引用的历史和结尾的签名，存 3000 字以内；分拣和其他来源一样只看前 500 字。主题和正文都在 `<untrusted>` 里。发件人名字显示在标题行上，只留文字、数字和少量标点。
- 拉取失败只记状态（控制台「它自己 › 信息源」能看到上次结果，也能「现在拉一次」），游标不动，下次重试。
- **放宽一律醒目通知**：打开 `feishu.dm`、加一个信息源、改一个源的来源、给插件一个新密钥，都会在管理群单独提醒（§10.3）。
- 读进来的东西只是事实：分拣时包在 `<untrusted>` 里，外面的文字写不出这个标记，里面写的任何指令都不执行。信息源没有任何发送或写入的能力。
- **信息源不升级给主 agent**：分拣判成 `escalate` 也只提醒我，原文不进主 agent 的会话。邮件和网页谁都能写，主 agent 又能派有 sudo 的 host worker。还剩一条间接的路：分拣模型写的事件摘要和话头会进早报和 `matter_events`，主 agent 看得到，这些是模型改写过的短句，不是原文。

### 17.4 导入
大家都不是从 0 开始。导入把别处已有的【事】和【人】一次搬进来。

- **格式 `sbot-import/1`**：`{format, from, exported_at, people[], matters[], events[]}`。字段说明和写法在 `core/import/PROMPT.md`，样例在 `core/import/example.json`。
- **提示词就是接口**：把 PROMPT.md 交给任何一个 harness（旧助手、笔记软件里的 AI、另一个 agent），让它读自己的材料按格式总结，输出贴进来就行。控制台「生活 › 导入」里能直接复制提示词和样例。
- **按主线总结**（v0.19）：一条 matter 是一条主线，里程碑、一次评审、一轮沟通写成事件；确实要单独跟的一块才写成子事（`parent` 填主线的 key，只一层，不跨工作和私事）。
- **也可以直接贴原始材料**：不是这个格式的，由 work 档按同一份提示词整理（按 4 万字分块，最多 6 块），材料包在 `<untrusted>` 里，各块的结果按名字和标题合并。
- **先预览，再导入，能撤销**：
  - 预览：哪些人是新的、哪些已有页面；哪些事是新的、哪些并进已有的事（标题相同，或一边的标题是另一边的 key）；多少事件、其中多少还在等我；**会有几条在办的主线、几件子事**。主线超过 12 条、在办的事超过 20 件、或者平均每件事不到 3 个事件，就提醒可能太碎。同一份材料导过一次，再导会被拒。
  - 导入：人写进 agent-home 的 `people/<名字>.md`（visibility owner，加一节「导入 #id」），**不碰 `config/people.yaml`**（那里是身份和权限）；事进 `matters` 表和事的页面，新叫法进 `keys`；事件进 `events`（source `import`）。每一行都带 `[src=import:<id>]`。原始材料留在服务器 `$SBOT_HOME/imports/`，不进仓库。管理群收到一句话。
  - 撤销：先撤销之后对这些事做过的归并（§15.3），再按 `[src=import:<id>]` 删回去。导入新建的事如果之后已经挂上了别的东西（任务、审批、新事件……），不删，标为 dropped 并写明原因。
  - 导入的事和事件可能有错，后续由每日整理拿出来让我确认（§15.14）。
- 导入只写记忆和账本，不改任何权限、规则或配置。

### 17.5 和 §16 的关系
- 事件的写法（Triage 提示词里 kind / level 的说明）属于 Triage 规则，是 **B 级**：可以由 improve 提案、回放、我批。
- 信息源和插件属于"读什么"：只有我改配置、我装插件；agent 不提。导入的提示词和格式是代码的一部分（C 级）。
- 我在控制台改事件的级别、关掉、挂到别的事上，本身就是对 Triage 的纠正。**要不要把这些记成 §16 的信号**（比如 `event_relevel`、`event_relink`），改的是信号定义，属于 **D 级**，等我定；在那之前只记在 `events` 里，不进 `signals`。
- 每日整理（§15.14）里我点的决定也一样：只记在 `matter_reviews` 和 `matter_ops`，不进 `signals`。

## 18. 因缘：人、事、资料的图谱（v0.15）

### 18.1 为什么
只看事是 work agent。陪一个人过日子，得知道他身边有哪些人、是什么样的人、彼此怎么连上的，事又是在哪些人之间发生的。缘起缘灭本身也值得看：谁是什么时候、经由谁出现的，谁渐渐远了，谁一直在几个圈子之间牵线。这些都能从已有的记录里看出来，不用模型猜。

### 18.2 三层，权限不变
- `persons`：它见过的每一个人，一个人一行，各处的叫法（飞书 ID、微信 ID、名字、people.yaml 的键）都在 `person_aliases` 里指向它。**在这里不等于可信。**
- `people/<slug>.md`：TA 是什么样的人，dream 写（§8.3）。
- `config/people.yaml`：身份和权限，只有我改。图谱只读它，用来把同一个人的各处 ID 认到一起。

### 18.3 图里有什么
节点：我、人、事、群 / 私聊（地方）、页面、资料。边都带出处（最多 5 条），分两种可信度（借自 graphify）：

| 边 | 从哪来 | 可信度 |
|---|---|---|
| 人—人 `talks` | 同一个群里挨着说话（相隔 ≤ 10 分钟）、@ 了对方，按次数累计 | 有记录 |
| 人—地方 `in`，我—人 `dm` | 在哪个群说过话；私聊 | 有记录 |
| 人—事 `matter` | 事件的消息是 TA 发的 | 有记录 |
| 人—事 `matter` | 只是事件的 actor 名字对上了 | 推测 |
| 事—地方 `at` | 事件发生在哪 | 有记录 |
| 页面—页面 / 人 / 事 `link` | 页面里的 `[[…]]` 和 `.md` 链接 | 有记录 |
| 页面—人 `mentions` | 页面正文里出现了某个已知人的名字 | 推测 |
| 事—人 `key` | 事的页面「关键人」一节 | 推测 |
| 资料—页面 `source` | `raw_sources.pages_json`（§8.5） | 有记录 |
| 人—人 `rel` | 我记的关系（有记录），或 `person_relate` 记的（推测，等我认） | 看来源 |

一条路径的可信度取最弱的一跳。路径不经过「我」（不然谁都和谁两跳就连上了）。

事的节点是**主线**（v0.19）：子事和合并掉的事都算到它的主线上，归并或撤销后，下次重建图就跟着变。

**不进图**：`self/`、`journal/`、出生信息、命盘和解读（只给我看，§15.9）；skills、AGENTS.md、SOUL.md、index / log 这类结构文件。

### 18.4 怎么建
- **登记**（顺序即优先级）：people.yaml 的条目 → 人物页（名字唯一对上就挂到同一个人）→ 飞书 / 微信里说过话的人（按 sender_id，名字取最近的）→ 事件 actor 里出现的名字（只有名字的人，等认）。名字有两个以上的人对得上，就**不猜**，工具会拒绝并列出候选。
- **构建**：上面每一类边各一遍 SQL / 文件扫描，最近 400 天。纯代码，几十毫秒级。`graph_*` 两张表整张重建；**最多 15 分钟一次**，打开控制台的人 / 因缘或工具查人时触发，也能在控制台「现在重算」。
- **圈子**：带权标签传播（关系 8、提到 1、其他按 log 次数；同在一件 ≤ 15 人的事里加 1）。圈子的名字：一半以上成员都在同一个群，就叫「「群名」那拨人」，否则取两个成员的名字。我手动分的 `circle`（家人 / 朋友 / 同事……）和自动圈子并存，不互相覆盖。
- **因缘**：每个人的初见取最早的一条记录：在哪个群、前后 30 分钟里同场说话的人、我在不在场；只从人物页认识的人取页面的创建时间。初见只会往前挪。

### 18.5 借机观察
控制台「生活 › 因缘」只摆事实，不下判断，也不发到任何地方：
- **新结的缘**：近 30 天第一次出现的人，在哪、同场有谁、我在不在。
- **常在一起，还不知道什么关系**：挨着说话最多、还没记关系的两个人。点开可以一键记关系；不记也没关系。
- **牵线的人**：和两个以上圈子都有往来的人。
- **渐远的**：往来不少（权重 ≥ 15）、但 60 天到一年没出现的人。
- **待认**：只有名字的人数、重名。

### 18.6 纠正和工具
- 控制台：改名、分圈子、一句话备注、隐藏、合并两个人（叫法、关系、初见都并过去）、把认错的叫法拆成一个新的人、记关系 / 认（推测 → 有记录）/ 去掉。这些写在 `persons` / `person_aliases` / `relations`，重建不会冲掉。
- 主 agent（只在 owner 会话）：`person_lookup`（L0，一个人的卡片：叫法、圈子、关系、常一起的人和事、页面）、`person_path`（L0，两个人怎么连上的）、`person_relate`（L1，记一条关系，必须带依据，**一律算推测**，我认了才算有记录）。
- 发到飞书的东西里不带图谱内容；它查到的只用来帮我想事。

### 18.7 和 §16 的关系
- 图谱是派生视图，算法和权重属于代码（C 级）。
- 它只能记推测的关系，认不认由我。我在控制台合并、拆开、认关系要不要记成 §16 的信号，属于信号定义（D 级），等我定；在那之前只在这几张表里。
- 图谱不碰 people.yaml、不碰任何权限和规则。

---

## 19. 控制台客户端：前后端拆开、对话、设备（v0.20，设计稿）

> **状态：只有设计，没有实现。** §19.10 的决定我点头之前不动手。§10 写的是现在跑着的控制台，这一章是它的下一代；P5 完成替换之前两者并存，§10 的规则继续有效。
>
> **v0.24：这一章要按新的 §0 重做。** 下面的分层、协议、设备验证、飞书验收表这些工程部分大体可以留着；页面和入口要从"陪伴"出发重新想：主入口是主 agent，先读懂、再互参、少展示。重做之前不动手。

### 19.1 方向

我定的四条：

1. **控制台是全集**。飞书管飞书相关的：工作期间不打开控制台，只靠飞书也能做完所有工作上的操作。生活、`self/`、复盘、命盘不进飞书的群和工作台；在控制台和我的飞书私聊里都能看（§15.9）。
2. **客户端拆出去**。VPS 上只做 server（API + 事件流），客户端可以重一点、可以用框架，好用最重要。以后要有 Mac 和安卓。
3. **控制台能直接和主 agent 对话、驱动它**，但设备要验证：新设备经已信任的设备或飞书确认才能接入，能看到、能吊销。
4. **体验照 T3 Code**：左边 thread 列表，中间对话，回复流式出来，工具调用、审批、开出去的任务、diff 都实时出现在对话里，切换不重新加载。

由此定下四条设计原则：

- **状态只有一份**。审批、任务、事、事件、记忆都在核心的 SQLite 和 agent-home 里，飞书和控制台都只是入口。谁先点算谁，和 §10.4 一样。
- **控制台是多一个入口，不是第二套规则**。闸门分级、审批状态机、预算、主动消息上限都不因为换了入口而变。
- **新入口只会收得更紧**。飞书私聊现有的工具和权限不动；设备、公网对话都是新增能力，默认关，由我确认（§19.10）。
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
- **Web**：构建只在 CI 上做（§1.3，重构建不上 VPS），产物是带内容 hash 的静态文件包，附 sha256 和构建来源证明。服务器上一个独立的 `sbot-client-deploy` 拉包、校验、解到 `releases/<sha>`、原子切 `current`，不碰核心，能 `--ref` 回滚。前几个阶段手动触发，稳定后再上定时器（D11）。
- **托管**：核心把这个目录挂在 `/app/`，复用 §10.5 的静态文件逻辑（ETag、预压缩）。这样两个入口都能用，也不用改 nginx。目录不存在就回 404，核心不依赖它。旧控制台留在 `/`。
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
- 依赖从少开始：React、Vite、虚拟列表、markdown 解析。状态用手写的 store 加 `useSyncExternalStore`。每加一个依赖都是供应链风险（§19.8）。
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
| 服务状态 | `beat.status` | §10.5 的共享计算 |

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
- 心跳 20 秒一次，低于 nginx `location /` 的 300 秒读超时；响应带 `X-Accel-Buffering: no`，这样不用改 nginx（P1 验证）。事件流不压缩（§10.5）。

**传输选 SSE 格式 + `fetch` 流式读取，不用 WebSocket，也不用 `EventSource`。**

- 流量基本是单向的，写操作用普通 POST，天然有状态码、重试和幂等。
- WebSocket：Node 没有内置的 server，要加依赖或自己写帧；nginx 要加 Upgrade 配置（`deploy/` 手动上线）；浏览器的 WebSocket 不能带自定义头，凭据只能放 URL 或首帧。
- `EventSource` 也带不了自定义头，重连也不归我们控制。`fetch` 流都能做，实验在 Chromium 和 WebKit 上都通过了（§19.11）。
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

**任务和 diff**：任务视图不假设 worker 在哪，任务带 `executor { kind: local | t3 | herdr, host, external_ref }`，步骤、问题、结果、diff 都走同样的实体。worker 派到别的机器怎么做由另一份设计定，这里只留位置。运行中的 diff 来自 `Edit` / `Write` 的工具输入，定稿的 diff 从镜像算（§4.2，核心不在 worker 目录里跑 git）。diff 和工具输出都按不可信文本渲染。

### 19.5 对话

**和飞书的关系：状态合一，对话分开。**

| 方案 | 结果 |
|---|---|
| 控制台和飞书私聊共用一个 lane | 一个 lane 同时只跑一轮，开多个 thread 就没意义；个人话题会进飞书能接触的上下文；回复该发到哪也说不清 |
| 完全独立 | 两边互相看不到，「状态一致」做不到 |
| **thread 各自独立，状态共享，飞书 lane 在控制台里能看（推荐）** | 记忆、事、审批、任务全通；上下文不互相污染；飞书照样独立够用 |

这和 §3.3「飞书私聊和微信是两个会话，但共享全部记忆」是同一个做法。

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

- **主线**：左栏按主线分组，一条主线可以有几个 thread。分组在读取时沿 `parent_id`、`merged_into` 算，thread 上不存。所以挂、拆、合并（§15.3）以及它们的撤销，列表都自动跟着变，不用迁移。两段对话不合并，只是归到一组。
- **运行**：`TurnContext` 加 `channel: "console"`；定时器和任务结果用存下的 turn 回到发起的 thread，这条路现在就是通的。回复仍然先写 outbox，console 渠道当场标记已送达，并写一行 `messages`（收尾摘要要用）。
- **不滚动**：thread 不按空闲 4 小时换 session，靠 pi 的压缩。但空闲到点还是写一次收尾要点（按域，见下），否则记忆里没有这段对话。想重开就新建 thread 或点「新会话」。
- **停止、排队**：每个 thread 单独停。排队中的输入能看到、能撤回。`MAX_CONCURRENT` 保持 2，不因多 thread 调大；有人在等的输入优先于定时器和后台事件。

**两个域，`personal` 不流向飞书**

thread 分 `work` 和 `personal`，沿用事的 `domain`。这一条要专门做，因为现在的 owner 身份在飞书 lane 里也能搜到全部日志和 `self/`：

- `personal` thread 的收尾要点、记录写到 `self/` 下单独的位置，带域标记。
- `memory_read`、`memory_search`、`timeline_query` 在飞书的群和工作台过滤掉这些内容。我在飞书私聊里亲手问的不过滤（§15.9）。
- `personal` thread 不在飞书镜像，主动消息到不了时，飞书只发一句不带内容的「控制台有新消息」，并计入 §9.3 的上限。
- `work` thread 的主动消息（定时器、任务结果）在没有客户端在线时，把内容转到飞书私聊。这样我不开控制台也不会漏。

**从控制台发起的工作，飞书仍然完整可见**：任务照样开工作台话题，审批照样发管理群卡片，问题照样能在话题里答。否则「只靠飞书也够」就破了。

**工具权限：按入口、设备、域取交集。**

```
本轮工具 = toolsFor("owner") ∩ 入口上限 ∩ 设备权限 ∩ 域规则
```

每个工具原有的闸门等级（§7.1）不变，这里只决定它出不出现。

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
| 新邮件进分拣、成事件 | ✅ | 只读，默认关（§17.3） |
| 回邮件 | ❌ | 系统现在没有发信能力，这是新的对外出口（D8） |
| **事和事件** | | |
| 查进展、改事件状态和级别 | ✅ | 经 agent（`matter_events`、`event_update`） |
| 开事、挂靠、收事 | ✅ | 经 agent |
| 主线挂、拆、合并、撤销 | ✅ | 经 agent（`matter_regroup`） |
| 每日整理 | ✅ | 卡片按钮（§15.14） |
| **任务** | | |
| 派任务 | ✅ | 经 agent（`task_start`） |
| 看任务列表 | ✅ | `/tasks` |
| 看进度、回答问题、追加指示 | ✅ | 工作台话题 |
| 取消 | 🟡 | 经 agent。缺：话题里的命令或按钮 |
| 看 diff | 🟡 | 同推送卡片 |
| **运维** | | |
| 早报、模型、用量、定时任务、触发改进 | ✅ | 早报；`/model`、`/usage`、`/job`、`/improve` |
| 立刻拉一次信息源 | ❌ | 只有控制台能做。缺命令 |
| 确认和吊销设备 | ❌ | 本章新增：配对卡片、`/devices`（§19.7） |

现在的代码里没有日历、云文档的写工具，两边都没有，不算飞书的缺口。以后加工作能力，规则是**飞书必须够得着**。

**不进飞书的群和工作台**：生活时间线、`self/` 全文、习气和节律全文、命盘、看法账本。这些在我的飞书私聊里可以问（§15.9）。

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

1. 设备用私钥签服务端给的一次性挑战，换一个 15 分钟的 access token。token 只在内存里，绑定设备和入口，在另一个入口无效（和 §10.1 的 cookie 同理）。
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
| 本机其他用户 / www-data | 直连 socket | 直连也要设备凭据；公网 socket 不信 tailnet 头（§10.1） | 只能伪造 `X-Real-IP`，影响限速和显示 |
| host worker（有 sudo） | 能改数据库和密钥 | 设备系统挡不住它，这是 §7.6 已有的软边界 | 不变 |

### 19.9 分阶段

每个阶段都能单独上线，也能单独停掉。冒烟测试在服务器上跑。

| 阶段 | 做什么 | 里程碑（可验证） |
|---|---|---|
| **P0** | 这一章；我确认 §19.10 | PR 合入 |
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
| D3 | §19.7 的权限表和入口上限 | 按表 |
| D4 | 飞书确认能授予的范围 | `read`、`chat`、`approve`、`dispatch`，不含 `life`、`config`、`devices` |
| D5 | 设备过期时间 | 浏览器 14 天空闲，原生 60 天空闲，绝对 180 天 |
| D6 | 公网发起的审批不能由同一台设备批 | 要 |
| D7 | 公网密码会话收窄（去掉审批、配置、密钥写入）。这是**收紧**，但改变我现在的用法 | P2 稳定后收窄，P5 只留配对 |
| D8 | 飞书要不要能回邮件。这是**新的对外能力**，要走 L2 审批，还要新的邮件权限 | 单独评估，不随本章上线 |
| D9 | 控制台能不能接着飞书的 lane 说话 | 先只读；以后要做，回复留在飞书，并标明经控制台 |
| D10 | Mac 签名公证、安卓分发方式 | Mac 用开发者账号（费用由我定），安卓侧载 |
| D11 | Web 客户端自动部署 | 前期手动，P3 后再上定时器 |
| D12 | `personal` 的存放位置和离线提醒 | 按 §19.5 |

权限、预算、auto 规则本身不因这一章改变（§16 的 D 级）。每设备的预算和频率限额是新增的**限制**，数值由我定。

### 19.11 实验记录（2026-11-18）

都在作者的 Mac 上做（Node 25.8.1，本机回环），代码在临时目录，没有进仓库，也没有部署。

| 验证什么 | 结果 |
|---|---|
| 触发器变更表（2 万行） | 每次插入从 7.4 到 14.6 µs，更新从 5.7 到 13.3 µs，每次多 7～8 µs；空轮询 0.76 µs；取 200 行 53 µs；回滚不留事件；清理后序号不重用 |
| `fetch` 流跨域带请求头，每 400 ms 强制断线（Playwright 的 Chromium、WebKit） | 56 次重连，0 重复、0 缺失，7500 字 hash 一致。实验用的是 `Authorization`，设计换成自定义头，两者都走 CORS 预检 |
| 浏览器不可导出的 P-256 密钥（同上两种浏览器） | `exportKey` 被拒；重启浏览器后还在；挑战和写签名由 `node:crypto` 验证通过；吊销后 401。验签约 50 µs 一次 |
| 1 / 5 / 20 个连接，每秒 60 个增量 | 事件循环 p99 约 6 ms（定时器精度 5 ms，即看不出延迟），最大不超过约 19 ms |

**没有验证的，要在对应阶段实测**：nginx 和 tailscale serve 下的流式（P1）；VPS 上的真实性能（P1）；真机安卓 WebView、Tauri 的 WKWebView、Safari 上的流式和密钥持久化（P1.5、P6）；Tauri 安卓的整体成熟度（P1.5）。

---

## 附：参考
- T3 Code 远程访问（§19.7 的设备配对参考）：github.com/pingdotgg/t3code，`docs/user/remote-access.md`
- 六爻：zhouyi-qigua.pages.dev（之后单独做 skill 时以它为准）
- **《Building always-on agents》**（claude.com，William Hu）：五件套（收件箱、定时器、记忆、权限、发件箱）；run 周期；定时器只往收件箱里投事件；"只存查不回来的东西"；凭证代理；defer 加卡片审批；先安静、再争取注意力。§1、§5.2、§7.2、§8、§9 都按这篇文章调整过。
- Claude Agent SDK 文档：permissions（评估顺序、`dontAsk`、allowedTools 和 canUseTool 的关系）、hooks（`onFailure`、超时、`defer`、PostCompact）、TypeScript Options（`env`、`tools`、`settingSources`、`sandbox`）。
- **pi**（badlogic/pi-mono → earendil-works/pi）：极简 agent harness，内置只有 read / write / edit / bash，没有 MCP 和权限系统；`createAgentSession` 可以嵌进 Node 进程；扩展事件 `tool_call`（可拦截）、`context`、`before_agent_start`、`session_before_compact`；会话是带分支的 JSONL；支持 Agent Skills；多厂商。§4.0 的对话角色候选。
- **LayerFS**（Ephemeral-AI-Lab/layerfs）：候选思路是 worker 每次写操作一个 checkpoint（影子分支），以及 dream 在分支上整理再合并；还没写进正文，也不引入依赖。
- OpenClaw / NanoClaw / nanobot / Hermes Agent：见 v0.6 附录。
- T3 Code：thread / delegate / task notification / queue 的交互模型。
- **graphify**：把代码和资料建成知识图谱。借了这几条：边分 EXTRACTED / INFERRED，路径取最弱一跳；只用代码构建；邻居、最短路径、解释三种查询；社区自动分、不靠模型命名；名字有歧义就拒绝并列候选。§18 按它设计，没有引入依赖。
- **HappyClaw**（riba2534/happyclaw）：技术栈和场景跟我们最接近，不 fork，只借设计：
  - `src/group-queue.ts`：会话串行和合批
  - `src/channel-reliability-store.ts`：收件箱和发件箱
  - `src/feishu.ts`：话题映射、撤回
  - `src/automation-*.ts`：定时任务语义
  - `subagent_checkpoints`：断点恢复
