# 技术设计 10：旧代码怎么用

整个重写：旧 `core/` 冻结，切换后整个删。本文件回答三件事：旧模块对应新的哪个模块；哪些逻辑照搬、哪些改写、哪些丢；旧代码里的坑在新代码里怎么避。

约定：
- 新目录 `protocol/ hub/ node/ relay/ clients/`；`hub/src` 模块名按本批的模块表（main、db、config、inbox、runner、tools、approvals、outbox、channels、sources、triage、ledgers、memory、lens、timers、push、proxy、egress、api、link、tasks、nodes、improve、backup、cli）。
- 「照搬」= 复制函数体，改 import 和命名，不改逻辑；写明哪几个函数。「改写」= 保留思路和数据形状，重写代码。「丢」= 新主里没有。
- 行号是 2026-11-27 对着 `core/` 现状核过的。核过和 §附2.21 不一致的写了对的。
- ※ = 我从设计推出来的、或改了我定过的行为的，主的模块文件里要拍板。
- 旧代码里的 owner、known、other 三个 Principal 名字沿用（§底2.1）。旧代码里的 `主人` 字样（提示词、注释、卡片文案）搬时一律改成「我」或「你」。

## 总表

### core/src

| 旧文件 | 做什么 | 新模块 | 处理 | 要点 |
|---|---|---|---|---|
| `main.ts` | 装配、启动顺序、优雅关停 | hub/main | 改写 | 照搬顺序：db → `ensureAgentHome` → recover → outbox / dispatcher / scheduler / sentinel 起 → `drain` 关停。丢 `startConsole`、tailscale、`ownerFeishu()` 必填校验（:51，见 R3）、`FeishuAdapter` 直接装配（改成 channels 插件列表）。`announceRelease(…, seedNotice)` 保留（:107）。首行注释引的 §附3 改成指向技术设计 |
| `db.ts` | node:sqlite、WAL、一条连接、全部建表 | hub/db | 改写 | 照搬 `tx()`、`run/all/one`、`kvGet/kvSet`、`signal()`、「CREATE IF NOT EXISTS + 幂等迁移」的写法。表按 §底5 重拆，加 `change_log`。已知不一致：`proposals.status` 默认 `'proposed'`（:136），§底5 写 `'pending'`，主的模块文件定一个。`kv` 里 `feishu.owner_dm_chat` 挪进 channels/feishu 自己的状态 |
| `config.ts` | 路径、各 yaml 访问器、`secret()`、`log` | hub/config | 改写 | 照搬 `cached()`（按 mtime 热加载）、`secret()`、`writeSecret()`（原子、0600、只记名字）、`waitMinutes()`、`attentionConf()`、`matterReviewConf()`、`log`。每个 `xxxConf()` 换成 zod 解析后的类型。丢 `workerConf`（见 tasks.ts 一行和下文 `worker.yaml`） |
| `schemas.ts` | 每个 yaml 的 zod schema + `widening()` | hub/config | 照搬 | `SCHEMAS`、`CONFIG_FILES`、`widening()` 原样搬，passthrough 规则保留（新文件不坏旧核）。丢 `console.yaml`；补 `worker.yaml`（旧代码没有 schema，`workerConf` 裸读）；新键见 R7、Y11 |
| `config-write.ts` | 整份配置唯一写路径：哈希 → YAML → schema → 写 → commit → `config_changes` → 通知 | hub/config | 照搬 | `configHash`、`saveConfigText` 的步骤顺序、`ConfigError`。`notifyAdmin` 改走「管理通知出口」（R3）。保留「self.yaml 的内容不进群，只说改了」（:57 起那段） |
| `config-form.ts` | 表单提交 → 新 YAML 文本 + 放宽提示 | hub/config | 照搬 | `evaluateForm`、`mergeDraft`、`renderYaml`、`changedLines`、`formWidening`、`specProblems`。纯函数，无 IO，直接搬 |
| `config-form-specs.ts` | 每个配置文件的表单描述（标签、帮助、范围） | hub/config | 改写 | 结构照搬；`console.yaml` 的整块丢（:233）；`min_days` 删（:69，Y11）；文案里「主人」改「你」。同步规则见 Y11 |
| `memory.ts` | agent-home：git 读写、journal、seed 同步、路径校验、提示词文件 | hub/memory | 照搬为主 | 照搬 `blobHash`、`ensureAgentHome`、`seedNotice`、`applyWaitingSeed`、`seedAsks`、`safePath`、`cleanRel`、`readPage`、`appendJournal`、`localStamp/localNow`、`editConfig`。改写：`git()` 是同步 `execFileSync`，要换成每仓一条异步写队列（§底1.3）；`promptFiles()`（:234）加载表扩充（R7）；`commitIfDirty` 进队列 |
| `wiki.ts` | 页面可见性、`pages_fts`、index.md、log.md、检索 | hub/memory | 照搬 + 改 | 照搬 `visibilityOf`、`visibleTo`、`syncPages`、`rebuildIndex`、`appendLog`、`commitMemory`。`searchWiki` 要报完整度（R7） |
| `dream.ts` | 每晚整理：只能交 memory_patch，代码决定能碰什么 | hub/memory | 照搬 + 改 | 照搬 `CAPS`、`OWNER_ONLY_PAGES`、引用校验、补丁校验、先过 expert 再改 USER.md。`OWNER_SRC` 正则（:32）按渠道串写死，改成按来源标签（R3、R1）。`expert_daily_limit` 检查（:142）看 R7 ※ |
| `dispatcher.ts` | 每 lane 一个 run、合批、会话滚动、恢复、重试、流式卡片、系统提示词 | hub/inbox（派发、恢复）+ hub/runner（会话、压缩）+ hub/main（提示词拼装放 runner） | 拆开改写 | 照搬：`recover()`（无副作用则回 received，有则标 interrupted 并补一句）、`kick()` 取 lane 的 SQL、`turnText()`、`BATCH=20`、`markRoll`、`drain`。改写：`session()`（滚动会话 + 收尾摘要）进 runner 的压缩钩子；`systemPrompt()` 进 runner，按 R7 加载 `VOICE.md`、`practice.md`；回复落点 `turnOf()` 改成出口组（R3）。丢：`MAX_CONCURRENT`（:27）、`budget_exhausted` 分支（194/196/236）、`CardStream` 直接耦合（流式卡片是 channels/feishu 订阅 runner 事件） |
| `runner.ts` | `Runner` 接口 + pi 嵌入 | hub/runner | 照搬 | 照搬 `RunInput/RunResult/Runner`、`writePiModels`、`piTools`（zod → JSON schema → `Type.Unsafe`）、`PiRunner.run` 的整套 pi 配置（关发现、关内置工具、每个 run 一个 `ModelRuntime` 带内存凭证、会话文件每 run 重开）。改：`tools` 参数是新 tools 注册表过滤后的结果；`session.subscribe` 事件同时喂给 api 的事件 pump；`compaction`、`retry` 设置保留；换模型接 IC-11 探针结论 ※ |
| `tools.ts` | 工具注册表、闸门 `callTool`、`queueReply`、`webSearch` | hub/tools | 照搬 + 拆 | 注册表形状见下文「工具注册表现状」。照搬 `def()`、`callTool`、`toolsFor`、`queueReply` 的事务写法、`webSearch`（走 proxy 的 light 档）、`isPrivateTurn/ownerDirect`。每个工具的 `exec` 体拆到对应模块（matter_* → ledgers，memory_* → memory，task_* → tasks，followup_* → timers，send/request_approval → approvals）。改：`for:` 单列 → 三列（R1）；`READ_ONLY_TOOLS` 从 retry.ts 搬到注册表字段（`readOnly: true`，Y11）；`TurnContext.channel: "feishu"` 放宽成任意渠道 id |
| `tasks.ts` | 任务引擎：SDK worker、sandbox/host、审批挂起、push | hub/tasks（任务 ↔ 节点、attempt、等待点）+ node/（跑 agent） | 大部分丢，少量改写 | 丢：SDK `query()` 全套（`runOnce` 258–386）、`coreGuard`（:552）、`syncShared`（:576，ssh_config 同步给 sbot-h）、`requestPush/review/decided/push`（defer 路径，454–544）、`worker-exec` 调用、`MAX_WORKERS/LANE_OPEN_MAX/GLOBAL_OPEN_MAX/MAX_AUTO_RUNS/MAX_TURNS/WATCHDOG_MS/DEFAULT_TIMEOUT_MS/DEFAULT_BUDGET`（:44–46）。照搬：`startTask/listTasks/cancelTask/replyTask` 的入口形状和 `tasks` 表字段、`onWorkbenchReply` 的话题 → 任务路由（改成渠道无关）、`notifyOrigin`、`recover()` 的重启恢复思路。改写：`mirror.ts` 的 bare mirror + bundle 思路由节点上的 worktree 取代（§办3.4） |
| `outbox.ts` | 发件箱：先落库后投递、幂等键、过期、重试 | hub/outbox | 改写 | 照搬 `drain()` 的状态机（pending → sending → sent / failed / expired / unknown）、`idem_key`、`send_by` 过期、`MAX_ATTEMPTS`、发送后写 `messages` 的事务。丢 :48 写死的 `channel !== "feishu"`（R3），改成按 `channel` 查 ChannelPlugin；`feishuSend` 变成 channels/feishu 的 `send()` |
| `approvals.ts` | 审批状态机、卡片、改稿、失效、过期扫描 | hub/approvals | 改写 | 照搬状态机（pending/approved/rejected/expired/superseded/invalidated）、「只认 operator_id」、「同一事务里检查并改状态」、`draft_version` 对不上不动作、`invalidateForOwnerMessage`、`sweepApprovals`。丢 `kind=deferred_tool`（`hooks`、`reviseApproval` 里挂起分支）。卡片构造不在这里：`postCards/refreshCard` 只产出渠道无关的卡片模型，飞书渲染放 channels/feishu。:68、:160 的 `feishuConf().admin_chat` 改成管理通知出口 |
| `cards.ts` | 飞书交互卡片 JSON 2.0 构造、发送、patch | channels/feishu | 照搬 | `Card`、`md`、`button`、`buttons`、`quote`、`sendCard`、`patchCard`、`sendText`。`approvalCard` 拆：内容部分进 approvals 的卡片模型，布局部分留这里 |
| `card.ts` | CardKit 流式回复卡片 | channels/feishu | 照搬 | `CardStream`（含 `overflow`、`START_AFTER_MS`、先写 outbox 再发卡的顺序）、`toolStatus`、`closeOrphanCards`。输入改成 runner 事件流，不再被 dispatcher 直接调 |
| `feishu.ts` | `lark-cli` 长连接收消息、catch-up、发消息 | channels/feishu | 照搬 | `lark()` 封装、`consume()`（NDJSON + 指数退避重连）、`catchUp()`、`ingest()`（只落库后返回）、`feishuSend()`。`OWNER_DM_LANE` 常量改成 channels 配出来的主对话 lane。命令解析（`onCommand`）移到 inbox 的命令层 |
| `feishu-api.ts` | 机器人身份直调 OpenAPI（CardKit 用） | channels/feishu | 照搬 | `directApi`、`botApi`（tenant token 缓存 + 长连接） |
| `routes.ts` | 管理群 / 工作台路由、卡片回调、`/group`、`回滚`、`更新 seed` | channels/feishu + approvals | 改写 | `onCardAction` 的分派表照搬；`takeSeed`、回滚 memory commit 的命令挪到 cli 和 api 的 client_ops，飞书只留入口 |
| `commands.ts` | 私聊命令 `/stop /new /model /job /steer…` | hub/inbox（命令层）+ cli | 改写 | `makeCommandHandler` 的命令表照搬；`/model` 的 `editConfig` 写法照搬；:57 的预算文案按 R7 改成告警线 |
| `observer.ts` | 以 user 身份轮询读群（30 秒、全局搜、去重、激活规则） | channels/feishu（user 身份轮询） | 照搬 | `activationOf`（群 override > 敏感名关 > 外部/静音 digest > 默认）、`refreshChats`、`poll`（`[游标 − 2 分钟, now]` + message_id 去重）、`userIdentityReady`、`groupCard`、`onGroupClick`。:95 `editConfig("groups.yaml")` 保留 |
| `source-mail.ts` | 飞书邮箱信息源（内置，用核心自己的飞书登录） | channels/feishu（邮件） | 照搬 | `cleanMailBody`、`mailItem`、`feishuMail`。仍是内置，不做插件（§读2.1） |
| `sources.ts` | 信息源：git、fetch、command 插件、轮询、`messages` 落点 | hub/sources | 改写 | 照搬 `SourceItem`、`Poll`、`everyMs`、`ingestItems`、`pollSource`、`runSourceNow`、`sourcesView`、git/fetch 两个 poll。改写：command 插件的 `spawn`（:115，以 sbot 用户、拿得到 secrets.env 环境）改成以 `sbot-w` 子进程、JSON over stdio、每个插件一个出网（§底1.4）；`PLUGINS` 路径常量保留 |
| `triage.ts` | 分拣：规则 → 一次轻调用 → 事件；起草 run；通知合批；注意力窗口 | hub/triage | 照搬 + 改 | 照搬 `Triage.tick/classify/release/events/draft/escalate/flushNotices`、`triageSystem/draftSystem` 提示词（`ownerName()` 改「我」）、`noticeText`。`send` 注入点（`io.send`）本来就可注：改成出口组。`feishu.owner_dm_chat` 直读（:356）改成问 channels |
| `events.ts` | 事件账本：kind × level × state、话头、自动关 | hub/ledgers | 照搬 | 全文件搬：`recordEvent`、`markReplied`、`closeAnswered`、`responseTo`、`takeHeldNotices`、`settleFromApprovals`、`eventsQuery`、`eventLine`、`topicCandidates`、`resolveEventMatter`、`eventsMorningText` |
| `matters.ts` | 事：开、记、状态、起局 PLAYBOOK、主线子事 | hub/ledgers | 照搬 | `openMatter`、`noteMatter`、`setMatterStatus`、`listMatters`、`PLAYBOOK`、`familyIds/rootId`。`matters` 没有 `last_activity_at`（Y5），新表加 |
| `matter-ops.ts` | 合并 / 拆 / 改名 / 撤销，一行一条 `matter_ops` | hub/ledgers | 照搬 | 全文件。`undoOp` 的「撤销要怎么还原」存法保留 |
| `matter-review.ts` | 每日整理：代码摊事实 + 轻模型补 + 一张卡建议 | hub/ledgers | 照搬 | `reviewQueue`、`actOnReview`、`undoReview`、`runMatterReview`、`reviewView`。卡片发送改走卡片模型 |
| `graph.ts` | 因缘：人、关系、图谱（EXTRACTED/INFERRED），纯代码 | hub/ledgers | 照搬 | 全文件，纯代码无 IO 依赖。`personCard`、`resolveForTool`、`pathBetween` 被工具直接用 |
| `life.ts` | 随手记、时间线视图、前瞻、self_items、noticings、送一程 | hub/ledgers | 照搬 + 改 | 照搬 `addNote`、`timeline`、`submitOutlook`、`revisitOutlook`、`upsertCandidate`、`markSelfItem`、`fadeSelfItems`、`seeOff`、`submitReview`、`noticingsSummary`。`timeline` 视图（:25）里 `lane='feishu:dm:owner'`、`surface='feishu:group'` 写死（R3），改成按「主对话 lane」和 `messages.surface` 的渠道无关标记。`self_items.side` 等新列（Y5）在新 schema 里加 |
| `reflect.ts` | 日 / 周 / 月复盘文本、晨间前瞻、到期关闭 | hub/ledgers | 照搬 | `reviewDayText/WeekText/MonthText`、`reviewPlan`、`closeDueReviews`、`morningOutlookText`、`noteReviewRun` |
| `lens.ts` | 解读账本、请求镜头、`LensEngine`（SDK 跑镜头） | hub/lens | 照搬账本 + 改引擎 | 照搬 `requestReading`、`readingsQuery`、`revisitReading`、`periodFor`、`queueHorizonReadings`、`profileVersion`、`LENSES`、`CAST_METHODS`。改：`LensEngine.run`（SDK + sbot-w + 空白名单出网）换成「排盘脚本子进程 + 镜头 run（经本机节点的 Claude Code，无网络）」；「读数先存、永不编辑」「失败回一句」保留 |
| `lens-jobs.ts` | 老实例补加默认镜头 job | hub/config | 照搬 | `addDefaultLensJobs` 是「seed 到不了老配置时追加缺的 job」的现成做法（Y11）：用 kv 标记只做一次、之后配置归我。新增默认 job 都复用这个模式 |
| `self-profile.ts` | 出生信息表单、`self_profile`、`self_page`、回滚 | hub/ledgers | 照搬 | `profileView`、`saveProfile`（经 `saveConfigText`）、`rollbackProfile`、`readSelf/writeSelf`、`selfHistory`、`restoreSelf` |
| `birth.ts` | 出生信息校验、农历转换、排盘输入 | hub/lens | 照搬 | `birthIssues`、`birthReady`、`chartInput`、`lunarToSolar`、`CITIES`。出生信息仍只在服务器 `self.yaml`（底线） |
| `importer.ts` | 导入：格式、提示词、预览 / 应用 / 撤销 | hub/ledgers | 照搬 | `normalizeDoc`、`mergeDocs`、`previewImport`、`applyImport`、`undoImport`、`FORMAT`、`promptText` |
| `digest.ts` | 晨报事实、主动消息计数、先安静 | hub/push（计数、暂缓）+ hub/ledgers（晨报文本） | 改写 | `isProactive`、`isQuotaRun`、`countProactive`、`holdIfOverCap` 的判法照搬；`proactive_daily_cap` 先安静按 §触1.1 的推规矩重定（push 模块定）；`morningText` 进 ledgers |
| `improve.ts` | 改进：信号 → 评测集 → 提案 → 回放 → 回看 | hub/improve | 照搬 + 改 | `collectEvalCases`、`validateProposals`、`replay`、`lineDiff`、`similarity`、`onTuningDecision`、`runImproveReview`。`improveDue`（:263 起）按 R7、Y11 改；提案去重按 target（R7）。A/B/C 级按 §进2 重分，C 级经节点 agent 开 PR（旧代码没有） |
| `tuning.ts` | 可被提案改的提示词文件（git 跟踪、带版本哈希） | hub/improve | 照搬 | `TUNABLE`、`tunedRaw`、`tunedSection`、`tuningVersions`。注意「D 级不由 agent 提」仍成立：`TUNABLE` 白名单不加配置文件 |
| `health.ts` | 每周办事体检卡（只有指标） | hub/improve | 照搬 | `metricsWindow`、`healthText`、`postHealthCard` |
| `timers.ts` | 调度器：follow-up + jobs.yaml 周期任务 | hub/timers | 改写 | 照搬 `parseLocal`、`nextDue`、`Scheduler.syncJobs/tick/fireJob/retryJobs/runNow`、`GRACE` 迟到不补跑只记 missed、「上一次还没完就跳过」。`ownerTurn()`（:42）按 R3 改。`jobs.yaml` 的 `check` 脚本：旧代码里没有（progress 说提前了，代码里查不到 `check`），新写，经本机节点跑 |
| `sentinel.ts` | 5 分钟一次纯代码巡检 + 固定模板告警 | hub/timers | 改写 | 照搬 `checks()` 的 key / `again` 去重与恢复清除、各检查项的 SQL（审批久等、run 卡住、outbox 失败、代理错误率、预算 80%、job 失败）。:71–73 直接 `sendText(admin_chat)` 改成管理通知出口（R3）。丢「任务 20 分钟没输出」那条（看门狗没了，任务看节点心跳，改成「节点失联」）；备份检查换成新 backup 的位置；`lark.user` 检查挪给 channels/feishu 自报 |
| `retry.ts` | 上游错误分类、退避表、重试窗口、管理群一句话 | hub/timers | 照搬 | `classifyUpstream`、`parseReset`、`retryDeadline`、`nextAttempt`、`failureText`、`BACKOFF_MIN`、`RETRY_WINDOW_MS`。`READ_ONLY_TOOLS`（:77）搬到注册表字段（Y11）。`adminNotice`（:81）改走管理通知出口（R3） |
| `proxy.ts` | LLM 代理：run 令牌、别名 → 真模型、记账、fallback | hub/proxy | 照搬 + 改 | 照搬 `issueToken/revokeToken/tokenStatus`、`complete()`（含 `json: true` 重试一次）、别名解析（每次读 models.yaml）、用量记账（:241）、fallback 端点（199–210）、流式透传。丢 403 预算分支（:136–146，R7）；401 保留（:135） |
| `egress.ts` | sbot-w 每任务出网代理（只放行白名单 :443、自己拒内网地址） | hub/egress | 照搬 | `Egress`、`openEgress`。服务对象换成 command 插件和镜头 run；端口段 7820–7829 沿用 |
| `backup.ts` | 夜间备份：SQLite 快照 + git bundle → 对象存储 | hub/backup | 改写 | 快照 + bundle + manifest（sha256）的做法照搬；加 age 加密、CAS 同步到节点、保留期；不再依赖旧对象存储 key |
| `release.ts` | 读 REVISION / HISTORY / ROLLBACK_FROM，启动时在管理群说一声 | hub/main | 照搬 | `revision`、`releaseNotice`、`announceRelease`。「同一版本重启不说」靠 kv 记，保留。通知走管理通知出口 |
| `mirror.ts` | 配置里仓库的 bare 镜像，任务 bundle / push 用 | — | 丢 ※ | 节点上用 worktree 取代；`gitIn()` 的 execFile 封装如果 node/ 需要就照搬。git 信息源的 poll 读镜像，改成读 hub 自己 `git ls-remote` / 浅 fetch ※ |
| `console.ts` | 控制台 HTTP（unix socket、tailscale 身份头）+ 全部 `/api/*` | hub/api（只留 `/api/v1` 视图和 client_ops） | 丢壳，取逻辑 | 壳丢：socket、`Tailscale-User-Login` 校验（:3）、`console.yaml` owners。:248 的「改 owners 不能把自己锁在外」没了。取逻辑：每个 `/api/*` 处理函数里的视图计算挪进 api 的视图函数 |
| `console-data.ts` | 控制台四个区的视图计算与写入口 | hub/api | 照搬 | `inbox`、`lanes`、`laneRuns`、`requestDetail`、`lifeTimeline`、`matters`、`readings`、`reviews`、`healthTrend`、`proposals` 这些纯查询照搬；`decide/revise/edit/taskReply/taskCancel/markSelf/matterRegroup/opUndo/rollbackProposal` 是对已有模块函数的薄封装，在 api 里重新接线。头注释的「不是第二套规则」原则保留 |
| `console-http.ts` | 静态文件内容哈希、304、br/gzip | — | 丢 | 没有 HTTP 控制台；帧里的大载荷拉取另行设计（Y2） |
| `console-web.ts` | 公网入口：密码、session cookie、限速 | — | 丢 | 无公网密码入口（§触6.7）。PBKDF2 / HMAC 的写法不搬，设备认证走 Noise |
| `console-passwd.ts` | 设一次公网入口密码的脚本 | — | 丢 | 同上 |

### 其他

| 旧位置 | 做什么 | 新模块 | 处理 | 要点 |
|---|---|---|---|---|
| `core/console/`（app.css、index.html、lib、pages） | 旧原生 ES modules 控制台 | clients/ | 丢 | 不搬。页面信息架构只当需求参考；视图的数据面在 api |
| `core/protocol/config-form.ts`（101 行，纯类型） | 配置表单的线格式（`FormSpec`、`FormField`、`FieldWiden`、`FormPayload`…） | protocol/ | 照搬 | 原样搬进 `protocol/`，改成 zod schema 并导出类型，hub 和 clients 共用（旧文件头已经写明就是为 §触6 客户端准备的） |
| `core/seed/agent-home/`（AGENTS、SOUL、USER、MEMORY、skills/review、skills/outlook） | 新实例的记忆起点 | hub/memory（seed 目录） | 照搬 | 文件先搬，内容按 v0.26 重写由设计线程管。同步逻辑 `ensureAgentHome` 规则不变（线上被动过就不覆盖）。USER.md、MEMORY.md 不同步。要加 `VOICE.md`、`practice.md` 的话先进这里（R7） |
| `core/seed/config/`（models、sources、jobs、people .yaml） | 新实例的配置模板 + 表单里「还没建」的文件的模板 | hub/config（seed 目录） | 改写 | 键按 R7、Y11 改。只给新实例和表单模板；已经在跑的实例不受影响（见 Y11 第 4 条） |
| `core/import/`（PROMPT.md、example.json） | 导入格式的提示词和示例 | hub/ledgers | 照搬 | `importer.ts` 读它们；示例数据已是虚构 |
| `core/test/smoke.ts` | 假 inbox → Dispatcher → pi → proxy → outbox | hub 测试 | 改写 | 值得：端到端骨架，换成新 inbox / runner |
| `core/test/m2-smoke.ts`、`worker-host-smoke.ts` | 任务引擎、host worker | — | 丢 | 对象没了；任务测试按节点重写 |
| `core/test/m3-smoke.ts`、`seed-smoke.ts`、`backup-sentinel.ts`、`release-smoke.ts` | wiki + dream、seed 同步、备份检查、上线通知 | hub 测试 | 改写 | 值得：seed-smoke（blob hash 三类文件的行为）、release-smoke、m3 的 wiki 部分 |
| `core/test/m3c-smoke.ts`、`m6-smoke.ts`、`self-profile-smoke.ts` | 随手记 / 时间线 / 复盘、镜头、出生信息 | hub 测试 | 改写 | 值得：数据全是虚构，断言是行为，直接换 import 就能用 |
| `core/test/m7-smoke.ts` | 改进、提案、回放、体检 | hub 测试 | 改写 | 值得，提案去重的断言按 R7 改 |
| `core/test/m8-smoke.ts`、`matter-review-smoke.ts`、`graph-smoke.ts`、`attention-smoke.ts`、`triage-address-smoke.ts`、`mail-smoke.ts` | 事件账本 / 导入、每日整理、因缘、注意力窗口、分拣对象、邮件 | hub 测试 | 改写 | 值得，这是账本和分拣的回归网，最先搬 |
| `core/test/retry-smoke.ts`、`tiers-smoke.ts` | 上游重试 + tier fallback；四档走代理 | hub 测试 | 改写 | 值得（retry 460 行是最全的一份）；tiers 是 live 测试，留作可选 |
| `core/test/config-form-smoke.ts` | 表单与 zod 对齐、放宽提示 | hub 测试 | 改写 | 值得，就是 Y11 要的「漂了就失败」 |
| `core/test/console-*-smoke.ts`（decide / perf / web） | 控制台 | — | 丢 | decide 里的「审批点击只认一次」那几条断言移进 approvals 测试 |
| `core/test/card-live.ts` | 真飞书群流式卡片 | channels/feishu | 改写 | 留作手动 live 测试 |
| `core/test/vps-test-home.sh`、`vps-smoke.sh`、`vps-killtest.sh`、`state.js` | 一次性 home、冒烟入口、kill 测试、状态打印 | hub 测试 | 照搬 | 流程规矩（新一次性 home、端口 7829–7831、不删 testhomes）不变；killtest 验「kill 后不丢不重」，新 inbox 必须过 |
| `deploy/core/`（install.sh、sbot-core.service、sbot-deploy、sbot-deploy.service/.timer、sbot-backup.service/.timer） | 核心的 systemd、自动上线、备份定时 | hub 的部署 | 改写 | `sbot-deploy` 的做法照搬（镜像 → `releases/<sha>` → 共用 `node_modules` → 原子切 `current` → 15 秒健康检查 → 自动回退）；改成比较 `git rev-parse "$sha:hub"`（R2 里写的 `core` 改 `hub`）。unit 里 `MemoryMax=1500M`（:26）沿用为初值。动 `deploy/` 要手动跑 install.sh |
| `deploy/worker/`（apparmor-bwrap、bwrap、netfilter.sh、sbot-netfilter.service、sudoers、task-mkdir、worker-exec） | sbot-w 沙箱、sbot-h 主机 worker、出网规则 | node/（只留 egress 相关）+ hub/egress | 大部分丢 | worker-exec 整个丢（SDK worker 没了）。留：`netfilter.sh` + `sbot-netfilter.service`（command 插件和镜头还用 sbot-w 出网链）、`bwrap`、`apparmor-bwrap`、`task-mkdir`（镜头 / 插件的任务目录）。host 模式的 `MemoryMax=6G`（worker-exec:62）见 R7 |
| `deploy/lens/`（build.sh、install.sh） | 打包镜头插件、装到只读目录 | hub/lens | 照搬 | 排盘脚本仍按这个流程发布 |
| `deploy/console-web/`（install.sh、nginx-site.conf、tmpfiles、sbot-core-console-web.conf） | 公网入口的 nginx、socket 目录 | — | 丢 | 无公网入口。切换时记得在服务器上拆掉（手动） |
| `deploy/backup-mac/`（install.sh、pull.sh） | Mac 经 ssh 拉异地备份、校验 | hub/backup（过渡）→ 节点 | 照搬 → 换 | `pull.sh` 的校验（sha256 对 manifest、SQLite `integrity_check`、bundle 可读）照搬进节点收备份的校验；节点通道稳了换掉（§底1.3） |
| `scripts/deploy.sh` | 立刻上线 / `--ref` 回滚 / `--status` | 仓库 scripts/ | 照搬 | 不动，路径改 hub |
| `scripts/leak-guard.sh` | CI 里查实例数据（飞书 ID、tailnet 名、密钥） | 仓库 scripts/ | 照搬 | 不动；`protocol/ node/ relay/ clients/` 一并扫 |

## 工具注册表现状（给 hub/tools 的出发点）

- 声明：`tools.ts:35` 的 `ToolDef { name, description, schema: z.ZodObject, level: "L0"|"L1"|"L2", for: Principal[], exec(args, ctx) }`，`def()` 包一层，全体进 `TOOLS` 数组（:72 起，约 40 个）。
- 可见性：只有 `for:` 一个列。`toolsFor(who)`（:512）按 `for` 过滤；`callTool`（:515）里再查一遍 `for`，然后 zod `safeParse`，然后 `exec`，异常转成 `error: …` 字符串，不抛给 harness。
- 闸门：包在 `callTool`（:515）。L0/L1 直接执行；L2 工具（`send`、`request_approval`）自己在 `exec` 里写 pending 审批就返回，不等点击（点击是新事件）。worker 的 L2（`git_push`）才是 `tasks.ts` 里的 `PreToolUse` defer，不在这里。
- 一个工具的权限判断散在 `exec` 里：`isPrivateTurn`、`ownerDirect`（:56–58）、`ctx.src.startsWith("owner@")`（:411、:448）。
- `READ_ONLY_TOOLS` 在 `retry.ts:77`，是一份手写的名字集合，14 个：`memory_search memory_read web_search feishu_chats feishu_read task_list followup_list matter_events matter_list person_lookup person_path timeline_query readings_query self_list`。用于 `dispatcher.ts:197`：定时 run 上游出错，只调过只读工具、没说话才允许重试。
- 新代码规则：注册表一处声明 `{ name, schema, level, visibility: { typed, system, others }, readOnly }`，三列布局按 §底3.1，`callTool` 先按列过滤再走闸门；`readOnly` 直接给重试用，不再有第二份名字表。

## 配置文件和顶层键现状

`config/` 下 yaml（`config.ts` 访问器；有 schema 的在 `schemas.ts`）。`secrets.env` 另算，只由 proxy、backup、源轮询读。

| 文件 | 顶层键 | schema |
|---|---|---|
| `models.yaml` | `endpoints`（`base_url` 可写 `secret:NAME`、`auth`、`key_ref`）、`tiers`（chat/work/light/expert：`endpoint model price context max_tokens fallback`）、`budgets`（`run_output_tokens daily_cost`） | 有 |
| `gate.yaml` | `sensitive_words approval_ttl_hours send_by_hours expert_daily_limit improve_budget_usd proactive_daily_cap daily_budget_usd attention{wait_minutes escalate_wait_minutes places}` | 有 |
| `jobs.yaml` | 每个 job 一个键：`every at weekday day do lane text quota retry_hours enabled`，另有 job 专属键（`matter_review` 的 `limit first_limit stale_days ask_days tier`；`improve` 的 `min_days max_days min_signals`） | 有（job 专属键 passthrough） |
| `console.yaml` | `owners`、`web.origin` | 有；新主丢 |
| `sources.yaml` | `feishu.dm`、`sources[]`（`id kind every domain enabled env` + git 的 `repo`、fetch 的 `url`、command 的 `run`） | 无独立 schema 键校验；`widening` 有 |
| `people.yaml` | `owner{name ids{feishu wechat}}`，其余键是各人的 slug | 有 |
| `groups.yaml` | `reviewed default groups{<oc_…>:{name activation reply}}` | 有 |
| `feishu.yaml` | `admin_chat workbench_chat` | 有 |
| `worker.yaml` | `default_mode path skills ssh_hosts[]` | 无（裸读）；新主丢 sandbox 项，ssh_hosts / skills 改由节点自己管 ※ |
| `repos.yaml` | `<name>:{url branch}` | 有 |
| `self.yaml` | `month see_off_after restore_after fade_days birth lenses` | 有（含 `birthIssues`） |
| `auto` | 旧代码没有这个文件，M5 没做（R7 「他人自动回复」） | — |

## §附2.21 代码事实

每条：现状（行号已核）→ 新代码规则。

### R3 解开写死飞书

现状（6 处 + 3 个只往 admin_chat 发的）：
1. `main.ts:51` 没有 `people.yaml owner.ids.feishu` 就抛错启动。
2. `outbox.ts:48` `if (row.channel !== "feishu") throw …`，下一行直接 `feishuSend`。
3. `timers.ts:42–45` `ownerTurn()` 读 `kv feishu.owner_dm_chat`，拼 `{channel:"feishu", surface:"feishu:dm"}`；`timers.ts:17` 还有常量 `OWNER_LANE = "feishu:dm:owner"`。
4. `dispatcher.ts:37–43` `turnOf()` 同样的 kv + 拼法（progress 记 40–42，核实是 37–43，读 kv 在 :40）。
5. `life.ts:25` 起的 `timeline` 视图：`lane='feishu:dm:owner'`、`surface='feishu:group'`。
6. `dream.ts:32` `OWNER_SRC = /^(owner@|summary@feishu:(dm:owner|wb:)|review)/`。
7. 只往 admin_chat 发：`retry.ts:82`（`adminNotice`）、`sentinel.ts:71–73`、`approvals.ts:68` 和 `:160`；顺带 `config-write.ts` 的 `notifyAdmin`（`feishuConf().admin_chat`）、`cards.ts` 的 `sendText` 是飞书专用。

新代码规则：
- 对话不认渠道名。`TurnContext = { channel, chat_id, surface, … }` 里 `channel` 是 channels 注册的 id；「主对话出口」「管理通知出口」是出口组（§底1.1），出口组由配置列出（可以多个渠道），`outbox` 按出口组展开，没人认领的写 `unrouted` 状态不丢。
- 没有 turn 的系统事件，回复落点 = 主对话出口组，不是读 kv。`ownerTurn()` 和 `turnOf()` 合成 `inbox.replyTarget()` 一个函数。
- 校验启动条件改成「至少有一个主对话出口可用」，不是飞书 ID 必填。
- 渠道串（`feishu:dm:owner`、`feishu:wb:`）只出现在 channels/feishu 里；账本里的 `lane`、`src`、`surface` 加渠道无关的标记列（`is_main_dm`、`is_group`）供 `timeline` 视图和 dream 的来源正则用 ※。
- retry、approvals、sentinel、config-write、release 一律调 `notify.admin(text)`，由 outbox 发；不得 import 任何渠道。

### R1 来源标签、self/ 守卫、三列表

现状：
- `dispatcher.ts:171` `src: \`owner@${turn.surface}\``，一律是 owner@；同一行 `ownerTyped: rows.every(r => r.kind === "user")` 已有。
- `tools.ts:411`（`reading_revisit`）、`:448`（`self_mark`）靠 `ctx.src.startsWith("owner@")` 判断，所以定时 run 也被当成我亲手说的。
- `tools.ts:97` `memory_read` 的 `self/` 守卫：只在 `ctx.turn.channel === "feishu"` 时生效，只盖 `habits.md | rhythms.md | charts/` 三处；console 和别的渠道不拦。
- 工具可见性只有一个 `for:` 列（见上文）。

新代码规则：
- `src` 按 `ownerTyped` 给：`ownerTyped ? "owner@<surface>" : "sys@<kind>"`（kind 取 timer / approval / task / system）※。dream 的来源规则只认 `owner@`。
- `self_mark`、`reading_revisit` 查 `ownerDirect(ctx)`（私聊面 + `ownerTyped`），不看前缀。
- `memory_read` / `memory_search` 的 `self/` 守卫放在 tools 的守卫层，按渠道无关的「私聊面」判断，覆盖 §读5.1 的全部受限路径，不再只盖三个路径；`self_list` 取条目。
- 每个工具的可见性按 §底3.1 三列表（我亲手发 / 定时或系统触发 / 他人会话）声明在注册表里，本轮工具 = 列 ∩ 域规则。第二列「按 §读5.1」的项由守卫层落地，不在 `exec` 里各写各的。
- `bash` 和读写文件不进 pi 的内置工具：经本机节点接口，只在「我亲手发」列。

### R7 预算、上限、加载点

- **401 / 403**：`proxy.ts:135` 令牌无效 / 过期 / 已撤销回 401（`authentication_error`）；`:136` run 输出预算用尽回 403，`:142–146` 日花费到顶回 403（`permission_error`，注释写明不用 429 是因为 CLI 会重试，:7）。新代码：保留 401；两个 403 分支删（D1：只告警不停，§办2.2）。令牌 TTL 默认 30 分钟（`:28`），节点 agent 跑得更久，令牌在节点链路上续期，别让长任务中途吃 401 ※。
- **预算键名**：没有 `daily_limit`。真实键：`models.yaml budgets.daily_cost`（`proxy.ts:142`、`config.ts:96`、`commands.ts:57`、`console.ts:100/208`）、`budgets.run_output_tokens`（`proxy.ts:26`，默认 60000）；`gate.yaml daily_budget_usd`（`config.ts:97`，缺省回落到 `daily_cost`，再缺省 10）、`expert_daily_limit`（`config.ts:75` 默认 20；`dream.ts:142`、`tasks.ts:491`、`tools.ts:507` 用）。旧键兼容：新 loader 都接受（passthrough，不报错）；`daily_cost` 作为 `daily_budget_usd` 缺省时的告警线（同 `quietConf` 现在的回落）；`run_output_tokens` 读到就忽略并在 config 校验里给一条 warning。`widening()` 里这两个键的放宽提示删（不再是限制，只是告警线）。`expert_daily_limit` 是不是我说过的上限拿不准 ※，主的模块文件定；定之前保留键、保留默认 20。
- **`budget_exhausted` 联动**：`dispatcher.ts:194`（文案「这一轮的 token 预算用完了」）、`:196`（重试判断里排除它）、`:236`（`stop_reason`）；`tasks.ts:391/417`（任务出错文案）；`commands.ts:57`（`/model` 显示预算文案）。新代码：`run_tokens.status` 只剩 `active / revoked`；这几处分支一起删，`/model` 文案改成「日花费告警线 $N」；日花费 ≥ 80% 的提醒仍由 sentinel 的预算检查发（`sentinel.ts` 里 `budget * 0.8`）。
- **并发上限**：`MAX_CONCURRENT = 2`（`dispatcher.ts:27`，用在 `kick()` :112）去掉，lane 之间不限并发；`MAX_WORKERS = 1`（`tasks.ts:44`）按 D2 去掉；`DEFAULT_BUDGET = 150_000`（`tasks.ts:46`，用在 :79、:264）、`LANE_OPEN_MAX/GLOBAL_OPEN_MAX/MAX_AUTO_RUNS/MAX_TURNS`（:45）、`WATCHDOG_MS/DEFAULT_TIMEOUT_MS`（:46）一并删，见下文「新主里不再有的」。
- **「他人自动回复」**：§附2.17 的说法改成「M5 还没做，做的时候直接按新规则」。代码里没有 auto 规则文件、没有 `maxTurns ≤ 6` 之类的数字（旧设计里的限4 本来就没落地，§办3.5 已去掉数字）。新代码：他人会话只有承诺检测（§底3.4），不加数字上限。
- **`VOICE.md`、`practice.md` 的加载点**：现在代码里这两个名字都没有。加载点是两个函数：`memory.ts:234` `promptFiles()`（上限表 `AGENTS.md 12000 / SOUL.md 6000 / USER.md 4000 / MEMORY.md 4000`，超了截断并附「告诉我超了」）和 `dispatcher.ts:296` `systemPrompt()`（按顺序拼）。不是 `runner`。新代码：`promptFiles()` 的表加这两项和各自上限；拼装顺序在 runner 的 `systemPrompt()` 里定。
- **memory_search 的截断**：`wiki.ts` 的 `searchWiki` 有三处：`:107` SQL `LIMIT 12` 页；`:116` 每页最多 4 行命中（`k < 4`）且每行 `slice(0, 200)`；`:96/118/120` 总共最多 `limit = 20` 行。另外 `memory.ts:216` `readPage` 默认 `maxChars = 12_000`。新代码：每处截断都在返回里报完整度（共 N 页命中，显示 X 页，每页前 4 行，还有 M 页没显示；读页被截时说「读到 12000 / 共 N 字」），并给 `offset` 参数翻页。数字可以留作默认值，不能静默。
- **提案去重按 target**：现在没有「和待批提案卡按 target 比」。`improve.ts:269`（`improveDue` 里）是「只要有一张 `approvals.kind='proposal'` 待批卡，整个 run 都不跑」。按 target 比的逻辑在 `validateProposals`：`:158` 同批同文件提两次丢弃、`:148/159` 只和 8 周内**被拒**的提案按 target + `similarity > 0.5` 比，不比待批的。另外 `:405` 新提案上线时把旧的 `proposed` 标 `superseded`。新代码：提案入库时，同 `target` 已有待批（`proposals.status` = 待批）的：新的 supersede 旧的，不整体挡住 run；「有待批卡就不跑」那句删 ※（§进2 对频率的限制我没说过）。注意 `proposals.status` 与 `approvals.status` 是两张表两套值（见 db.ts 行）。
- **主机模式 `MemoryMax=6G`**：在 `deploy/worker/worker-exec:62`（host：`-p MemoryMax=6G -p TasksMax=2048 -p OOMScoreAdjust=-500 -p RuntimeMaxSec=5h -p KillMode=control-group`）；sandbox 是 `:26` 的 1G。核心 unit 是 `sbot-core.service:26` 的 `MemoryMax=1500M`。新代码：Linux 节点用 systemd-run 拉 agent 时保留 `MemoryMax=6G`、`KillMode=control-group`、`OOMScoreAdjust`；`RuntimeMaxSec=5h` 去掉（没说过的上限）；Mac / Windows 节点没有这套，不装。

### Y11 代码同步

1. **config-form-specs 和 widening 同步**：旧代码有两份放宽判断：`schemas.ts:91` 的 `widening()`（按文件手写）和表单字段上的 `widen` 标注（`FieldWiden`，由 `config-form.ts` 的 `formWidening` 用），再加 `specProblems()` + `config-form-smoke.ts` 在两者和 zod 漂开时让测试失败。新代码：改配置键 = 同一个 PR 里改 zod schema、form spec、`widening()` 三处；保留「漂了就失败」的测试；能做到的话让 `widening()` 从 spec 的 `widen` 标注生成，只留 `sources`、`groups` 这类跨键规则手写 ※。
2. **FCM 开关走 widening**：旧代码里没有 FCM。新主 `push` 的 FCM 开关（`console.yaml` `fcm.enabled`，06）要进 schema 和 `widening()`：由关到开 = 新增公网能力，输出一行放宽提示发管理通知，默认关（底线）。
3. **表单里删 `min_days`**：`config-form-specs.ts:69` 的字段和 `improve.ts:267` 的读取一起处理；`improveDue` 里 `days < minDays` 那支（:270）删，只留按信号量（`min_signals`）和 `max_days` ※。
4. **改 seed 的 jobs.yaml 不动线上配置**：seed 只在文件缺失时当模板（`config-write.ts configFile()`），`lens-jobs.ts` 头注释写明「seed 到不了已有配置」。新增默认 job 的做法：照 `addDefaultLensJobs()`——启动时用 `editConfig` 追加缺的 job、kv 标记只做一次、管理通知一句，之后 jobs.yaml 归我。PR 描述里要写「seed 改动对老实例无效，已走追加逻辑」。
5. **新加只读工具同步 `READ_ONLY_TOOLS`**：旧名字集合在 `retry.ts:77`，容易漏。新代码：`readOnly` 是注册表字段（见上），没有第二份名字集合；注册表测试里加一条「`level` 为 L0 且 exec 无写库调用的工具必须标 `readOnly`」做不到自动检查就在 PR 模板里写 ※。

## 新主里不再有的

| 旧的 | 在哪 | 为什么没有 | 设计出处 |
|---|---|---|---|
| `LANE_OPEN_MAX = 3`、`GLOBAL_OPEN_MAX = 5` 任务开着的上限 | `tasks.ts:45` | 派活不设上限 | §办3.5（我放开）、D2 |
| `MAX_AUTO_RUNS = 20`、`MAX_TURNS = 80` | `tasks.ts:45`（用在 :181、:358、:402） | 没说过的上限 | §办3.5、§进2 D 级放宽 |
| `MAX_WORKERS = 1` | `tasks.ts:44` | D2 | §附2.21 R7 |
| `MAX_CONCURRENT = 2` | `dispatcher.ts:27` | lane 间不限并发 | §附2.21 R7 |
| `WATCHDOG_MS`、`DEFAULT_TIMEOUT_MS`、`DEFAULT_BUDGET`，sentinel 的「任务 20 分钟没输出」 | `tasks.ts:46`、`sentinel.ts` | 超时、看门狗、预算都是没说过的限制；失联改成节点心跳（`nodes` 模块） | §办3.5 限5、§底4.2 |
| 预算 403（run 输出预算、日花费） | `proxy.ts:136–146` | 只告警，不停 | §办3.5 限5、§办2.2 |
| 他人自动回复的数字上限（`maxTurns ≤ 6`、工具 ≤ 4、共用日预算） | 旧设计；代码没落地 | 只留承诺检测 | §办3.5 限4、§底3.4 |
| `defer` / `PreToolUse` 挂起、`kind=deferred_tool`、`requestPush/decided/push`、`coreGuard` | `tasks.ts:454–576`、`approvals.ts` | 节点 agent 按自己权限跑，来问转看一眼卡 | §办3.5 限1、§办3.3 |
| SDK worker 全套：`query()`、`worker-exec`、sbot-h 主机 worker、sbot-w 里的 SDK、`syncShared`、`mirror.ts` | `tasks.ts`、`deploy/worker/worker-exec`、`mirror.ts` | worker 迁成节点上的 Claude Code | §办1.3、§办1.3.1（迁完之前） |
| 「不可信内容进沙箱」的强制、host/sandbox 两种 worker 模式 | `tasks.ts:41`、`workerConf().default_mode` | 碰到时问我，不强制沙箱 | §办3.5 限3 |
| 「agent 环境里没有任何真实凭证」 | `tasks.ts` 的 env 拼装 | 每个节点用自己的登录；SStudioBot 的密钥照旧不给 | §办3.5 限6 |
| 旧控制台 `core/console/`、`console.ts`、`console-data.ts` 的 HTTP 壳、`console-http.ts` | `core/console/`、`core/src/console*.ts` | clients/ 取代；只有 `/api/v1` 在加密通道里 | §触6.2、§触6.4 |
| tailscale serve 入口、`Tailscale-User-Login` 身份头、`console.yaml owners` | `console.ts:3`、`console.yaml` | 设备认证走 Noise + 配对 | §触6.7 |
| 公网密码入口（PBKDF2 密码、session cookie、nginx 443、`console-passwd.ts`） | `console-web.ts`、`deploy/console-web/` | 没有公网入口 | §触6.7、底线「新入口默认关」 |
| `/api/*`（非 v1） | `console.ts` | 只有 `/api/v1` | §触6.4 |
| `tasks` 里「主 agent 没有 bash」的规矩 | `tools.ts` 无 bash | 对话里能直接跑命令（只在我亲手发的 run） | §办3.5 限2 |
| `TurnContext.channel: "feishu"` 的单渠道类型、`feishuConf()` 直读 | `tools.ts:26`、各处 | 渠道是插件 | §触6.6、§底1.1 |
| 旧对象存储 `sbot-backup` key 作为唯一异地副本 | `backup.ts` | age 加密 + 节点 CAS | §底1.3 |

## 值得照搬的现成件

| 件 | 文件和函数 | 搬去哪 | 备注 |
|---|---|---|---|
| 飞书卡片 JSON 2.0 构造 | `cards.ts`：`Card`、`md`、`button`、`buttons`、`quote`、`sendCard`、`patchCard`、`sendText` | channels/feishu | 按钮 value 对象 + `card.action.trigger` 回传的约定一起搬 |
| CardKit 流式 | `card.ts`：`CardStream`、`overflow`、`toolStatus`、`closeOrphanCards`；`feishu-api.ts`：`botApi`、`directApi` | channels/feishu | 先写 outbox 再发卡的顺序、重启后关孤儿卡 |
| lark-cli 调用封装 | `feishu.ts`：`lark()`（execFile、32MB buffer、错误只截 400 字）、`consume()`（NDJSON、退避重连）、`catchUp()` | channels/feishu | 事件只落库就返回 |
| 重试退避表 | `retry.ts`：`BACKOFF_MIN = [2,5,10,20,30]`、`classifyUpstream`、`parseReset`、`nextAttempt`、`RETRY_WINDOW_MS` | hub/timers | 纯函数，连测试（`retry-smoke.ts`）一起搬 |
| `widening()` | `schemas.ts:91` | hub/config | 配置写路径的必经一步 |
| 配置表单 spec + 线格式 | `config-form-specs.ts`、`config-form.ts`、`core/protocol/config-form.ts` | hub/config、protocol/ | clients 只画 `FormSpec` |
| 配置唯一写路径 | `config-write.ts`：`saveConfigText` | hub/config | 哈希冲突 409、schema、commit、`config_changes`、通知 |
| 热加载缓存 | `config.ts`：`cached()` | hub/config | mtime 变才重读 |
| 出网代理 | `egress.ts`：`Egress`、`openEgress` | hub/egress | 只放行白名单 :443，自己拒内网地址 |
| journal 格式 | `memory.ts`：`appendJournal`（每行带模型改不了的来源标签）、`readPage`、`safePath` | hub/memory | 来源标签规则见 R1 |
| seed 同步 | `memory.ts`：`blobHash`、`ensureAgentHome`、`seedNotice`、`applyWaitingSeed`、`seedAsks`；kv `seed.state` | hub/memory | 线上被动过就不覆盖；`seed-smoke.ts` 一起搬 |
| 上线通知 | `release.ts`：`revision`、`releaseNotice`、`announceRelease` | hub/main | 同版本重启不重复说 |
| 追加默认 job | `lens-jobs.ts`：`addDefaultLensJobs` | hub/config | Y11 第 4 条 |
| 恢复语义 | `dispatcher.ts`：`recover()` | hub/inbox | 无副作用回 received、有副作用标 interrupted 并告诉我已发了几条 |
| 发件箱幂等 | `outbox.ts`：`idem_key`、`sending` 状态可重试 | hub/outbox | 以及 `queueReply` 在同一事务里 `side_effects + 1` |
| pi 嵌入 | `runner.ts`：`PiRunner`、`writePiModels`、`piTools` | hub/runner | 每个 run 一个内存凭证的 `ModelRuntime` |
| LLM 代理 | `proxy.ts`：令牌哈希存储、别名、`complete()`、fallback、记账 | hub/proxy | 去掉预算 403 |
| 事件账本 / 事 / 因缘 / 解读账本 / 导入 | `events.ts`、`matters.ts`、`matter-ops.ts`、`matter-review.ts`、`graph.ts`、`lens.ts`（账本部分）、`importer.ts` | hub/ledgers | 基本整文件搬 |
| 注意力窗口 | `config.ts`：`attentionConf`、`waitMinutes`；`triage.ts`：`release` | hub/triage | 「更具体的设置赢；某处只能缩短升级的等待」规则搬 |
| sentinel 去重 | `sentinel.ts`：`Finding{key, again}` + 恢复清 key | hub/timers | 检查项换，机制搬 |
| 备份校验 | `deploy/backup-mac/pull.sh`、`backup.ts` manifest | hub/backup、节点 | sha256 + `integrity_check` + bundle 可读 |
| 自动上线 | `deploy/core/sbot-deploy` | 部署 | 改比较 `hub` 的 tree sha |
| 一次性测试 home | `core/test/vps-test-home.sh` | 测试 | 流程规矩不变 |

## 设计和代码不一致、要在主的模块文件里定的点

1. `proposals.status` 默认 `'proposed'`（`db.ts:136`）vs §底5 `'pending'`；改进模块里「待批」取哪个值。
2. 「提案按 target 和待批卡去重」代码里不存在；只有「有待批卡整体不跑」和「按 target 比被拒的」。改进模块定新规则（R7「提案去重按 target」一条给了建议 ※）。
3. `jobs.yaml` 的 `check` 脚本：progress 记「提前做了」，代码里没有。timers 要从零实现，契约（退出码、输出）在 timers 文件定。
4. `expert_daily_limit`、`proactive_daily_cap`、`improve_budget_usd`、`approval_ttl_hours` 这些旧上限键：我没有明确说过要不要。保留键但是否继续「拦」，由各模块文件按「没说过的上限不加」定 ※。
5. `worker.yaml` 没有 schema；节点的 ssh、skills、PATH 配置归 nodes 还是 config，要定。
6. `src` 标签格式（R1 里的 `sys@<kind>`）和 dream 的来源正则要同时定，别只改一头。
7. 令牌 TTL（30 分钟）和节点上长跑 agent 的关系（R7「401 / 403」一条）。
8. `memory.ts` 的 `git()` 同步执行 vs 「每仓一条异步写队列」：`commitIfDirty` 和 `editConfig` 的调用点很多（config-write、lens-jobs、observer、commands、routes），队列接口要先定。
9. `READ_ONLY_TOOLS` 现在不含 `consult_expert`（L1）和 `note_add`（L0 写），重试语义（只读才可重试）在新注册表里要沿用这个口径。
