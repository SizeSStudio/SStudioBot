## 附2 P0 探针清单（开工前 1～2 天，全部写成可以重复执行的脚本）

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
  - ✅ `settingSources: []` 加 `plugins` 能加载 skills（2026-11-17，`probes/lens-skills.ts`）；CLI 自带的 skill 要靠 `skills` 白名单藏掉（§办1.3）
  - ✅ `settings` 选项能传 `cleanupPeriodDays`（2026-11-17，`probes/cleanup-period.ts` 3/3）：传 365 时，40 天的转录保留、400 天的被删。更要紧的是：**`settingSources: []` 且不传 `cleanupPeriodDays` 时，CLI 直接跳过清理**（日志 "userSettings source is disabled … no enabled source provides cleanupPeriodDays"），默认的 30 天根本不生效。清理在启动约 5 s 后才开始，跑得更短的 run 不会清理 → worker 不传这个设置，转录的保留和删除由核心的任务目录 GC 统一管
  - ✅ WebSearch / WebFetch（2026-11-17，`probes/web-tools.ts`，worker 路径，sonnet 和 haiku 两档都过）：WebSearch 发的是 `web_search_20250305` 服务端工具，上游原样支持（返回 `web_search_tool_result`）；WebFetch 在关闭非必要流量后能用，但会直连目标和 api.anthropic.com → 用 `skipWebFetchPreflight` + `settings.env.HTTPS_PROXY` 收进核心出网代理（§底3.6）。codex 档的 WebSearch 没测（对话角色在 pi 上，本来就要自定义搜索工具）
- [x] **pi 对比（对话角色）** → **用 pi**（2026-11-16，VPS，`probes/harness-compare.ts`）：pi 11/11、SDK 8/9。pi 轮次延迟 p50 3.8 s 对 5.2 s，自身固定开销约 0.45k 对 0.9k token，进程树峰值 195 MB（1 个进程）对 333 MB（每个并发 run 多一个约 220 MB 的子进程）；压缩时我们自己写的摘要生效，压缩后不调工具也答得出发心和本月留意；诱饵扩展、`AGENTS.md` 都没有被加载；代理里 0 个 UNMAPPED。原先的比较项：用同一组工具、同一个 chat 档模型，跑三段脚本对话：私聊派活、起局（问发心）、周复盘加下周前瞻（要用到时间线）。分别在 SDK 和 pi 上跑，比较：
  - 冷启动耗时、每轮固定 token 开销
  - 我选的 chat 模型在两边的工具调用稳定性
  - 会话持久化和续接；自定义压缩能否保住发心、本月留意这些锚点
  - 能否关掉 `~/.pi`、`.pi/` 的扩展和 skills 自动发现；能否指向 LLM 代理（自定义 baseUrl + 临时令牌）
  - 锁定的版本号，以及两边的代码量和可读性

  **判定**：pi 这几项都过，对话角色就从 M0 起用 pi；有一项不过，全部用 SDK。不管选哪个，`Runner` 接口和工具层都一样。
- [x] **LLM 代理**（2026-11-16，VPS，`probes/llm-proxy.ts`）：✅ 流式透传；✅ `usage` 计量（SSE 和 JSON 两种）；✅ 上游 Bearer（该端点也接受 x-api-key），run 令牌两种头都能用；✅ 别名换模型，非 `sbot-*` 的模型名会记成 UNMAPPED；✅ 超预算时：429 → CLI 退避重试约 3 分钟，**403 → 立刻失败**，所以选 403（见 §办2.2）
- [x] **worker 隔离**（2026-11-16，VPS，`probes/egress-check.sh` + `probes/worker-isolation.ts`，安装文件 `deploy/worker/`，细节见 §办1.3、§底3.2B、§底3.6）：
  - ✅ 以 `sbot-w` spawn：`spawnClaudeCodeProcess` → `sudo -n worker-exec` → systemd scope（MemoryMax 1G）→ `setpriv`。in-process MCP 和 hook 照常工作
  - ✅ sandbox（bubblewrap）：要先把 Ubuntu 的 `bwrap-userns-restrict` 换成官方 `bwrap` profile，否则 `apply-seccomp` 失败、所有 bash 命令 exit 1
  - ✅ 文件：读不到核心文件和 dev 家目录，只能写 cwd
  - ✅ 网络：iptables 层 worker 只能到 LLM 代理和核心出网代理（2026-11-17 起公网和 DNS 也关了，§底3.6）；sandbox 里的命令没有直连，只能经核心出网代理访问白名单域名（CLI 自带代理被 `SBOT_W` 挡住，不用它）
  - ✅ 内存：1.5G 分配只杀命令，CLI 活着（`OOMPolicy=continue` + oom_score_adj）
  - ⚠️ defer → resume → allow 不稳（约 15～25% 被当成拒绝，与 sudo 无关）→ 改成核心代执行 + deny 带结果，10/10（§底3.2B）
- [ ] **Windows 数据库解密**：哪个工具支持锁定的那个微信版本（**微信方案的前提**）；wxauto 4.0 系的版本支持情况和窗口标题校验
- [x] **飞书**：
  - ✅ 外部群标记：`+chat-list` 的 `external`（布尔值）
  - ✅（2026-11-16，只读部分）轮询方式改为全局搜索，见 §读2.2
  - ✅（2026-11-16，写入部分，全部 bot 身份）建了正式管理群「SStudioBot 管理」（私有普通群，主人是群主、bot 是管理员）。话题回复：搜索能看到，`chat-messages-list` 只嵌在根消息里；`--reply-in-thread` 可用；bot 自己的消息不回推事件；不 @bot 的群消息也会推；卡片回调 `operator_id` 就是点击人的 open_id，连点会来多次，要取第一次并立刻更新卡片（§底3.2B）；token 延迟更新卡片可用
- [x] **lark-cli 在 VPS 上单独授权**（2026-11-16）：✅ 和 Mac 并存；✅ refresh token 7 天滚动；✅ 30 秒一轮、12 分钟 288 次调用无限流；❌ `+chat-list` 不返回 `active_time`，只能排序 → 改用全局搜索（§读2.2）
- [x] **镜头 skill**（2026-11-17，VPS，`probes/lens-skills.ts`，打包 `deploy/lens/`）：6/6
  - ✅ ziwei-chart 没有 npm 运行时依赖（只用 node 内置模块），node 22 / 26 都能跑；VPS 和 Mac 同一输入的 `chart.txt` / `chart.json` 逐字节一致；HTML 没有外链，断网渲染没问题
  - ✅ worker 路径（sbot-w + sandbox + 出网白名单为空）：模型调 `Skill(sbot-lens:ziwei-chart)` → 沙箱里跑 CLI → 产物落在任务目录，和直接跑的结果一致；全程 0 次出网尝试
  - ✅ ziwei-natal 能读插件里的 kb（立场声明、断事方法），没有权限错误；kb 后来整份带上（星曜/宫位/四化/格局，约 800K），因为解读时会去找星曜页
  - ✅ `skills` 白名单生效（模型列表只剩白名单；白名单外的 skill 调用被拒）
  - 注意：worker 在沙箱里能 `find /` 读到全盘可读的文件（这次模型就为了找星曜页跑了一次），沙箱只限制写和网络。敏感内容只能靠文件权限挡，这一点 W4 已经验证过
- [x] **VPS 资源和环境**（2026-11-16 搭好，§底1.3）：
  - 可用内存 2.2～3 GB → 改成单机轻量方案（对话角色不起子进程、worker ≤ 2 且各限 1G）
  - 系统自带的 `nodejs` 没有 TS 支持 → 官方 Node v26.13.1 装在 `/opt/node`（sha256 校验过），`process.features.typescript = strip`
  - 用户 `sbot`、`sbot-w` 已建（系统用户、nologin，不在 docker 和 sudo 组）。目录在数据盘上，`/srv/sbot`、`/srv/sbot-w` 是软链
  - 数据盘延迟实测够 SQLite 用
  - rustfs 已建 `sbot-raw`、`sbot-backup` 两个桶，读写删都试过；sbot 专用的受限 key 留到 M0 建
  - 剩下的：worker 和核心同时跑时的真实内存，等 M0 跑起来用 `systemd-cgtop` 实测
- [x] **tailscale serve**（2026-11-16，临时挂一个端口测完已撤，配置和测前逐字一致）：✅ HTTPS + MagicDNS；✅ `Tailscale-User-Login` 注入且客户端伪造会被替换；✅ 能代理到 unix socket，700 目录挡住其他本地用户；控制台单独用一个端口，不动本机已有的 serve 配置（§触5.1）

### 附2.1 M0 进度（2026-11-17）

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

### 附2.2 M1 / M2 进度（2026-11-17）

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

### 附2.3 M3a 进度（2026-11-17）

M3 拆三段：**M3a** 记忆底座 + 定时 + 巡检（本节）；**M3b** 控制台（tailscale serve 8444 → unix socket）；**M3c** 复盘、前瞻、timeline、随手记、self/、habits、noticings、周体检卡、style notes。

新模块：`wiki`（页面可见性、`pages_fts` FTS5 trigram + 短词 LIKE、`index.md` 代码重建、`log.md`）、`dream`（夜间整理）、`digest`（先安静 + 早报事实）、`sentinel`（巡检）；`timers` 重写成 follow-up + `config/jobs.yaml` 两种。

- [x] **可见性**：self/、journal/ 恒 owner；shared/ 为 shared；projects/ topics/ sources/ groups/ 为 work；其余 owner。frontmatter 只能收窄。`memory_search` 走全文索引并按读者过滤
- [x] **jobs.yaml**（热加载）：`dream` 03:00、`dream_diff` 08:25（改动发管理群）、`morning` 08:30（代码攒事实 → 主 agent 在私聊写早报）。晚 15 分钟以上记 missed 不补跑；上一次还没处理完就 skip；私聊 `/job` 列表、`/job <名字>` 立即跑
- [x] **Dream**（§读1.3 由代码执法）：只能 `memory_patch` USER.md / MEMORY.md / people/ groups/ projects/ topics/；每处必须引用 journal 行，按行上的 src 判：USER/MEMORY 只收 owner 和 owner 会话的收尾；别人说的要写成「X 说」；web 只进 projects/ 且带链接；USER.md 改动先过 expert；4000 字上限；一晚最多 12 处，一处一个 commit。管理群回「回滚 <sha>」撤销
- [x] **先安静**：没人说话触发、且带 quota 的事件（follow-up 到点、任务完成/失败通知）计数；当天超过 `gate.yaml proactive_daily_cap`（默认 6）就压下，并进第二天早报。任务来问话、早报本身不计
- [x] **巡检**（纯代码，5 分钟一次，同一项 6～24 小时内不重复）：审批等超 2 小时、对话轮卡 20 分钟、任务 20 分钟没输出、outbox 失败、代理 30 分钟错误率 > 30%、当日花费到预算 80%（`gate.yaml daily_budget_usd`，默认 $10）、飞书用户授权不在、定时任务失败
- [x] `core/test/m3-smoke.ts`（临时 home + 独立代理端口，核心不用停）全过；`--live` 跑一次真 dream：3 处修改（USER.md 过了 expert），群里「老王说 主人 同意了周五上线」只进了群页面且标注未确认，约 $0.06
- [x] 已部署；第一次巡检就报了「飞书用户授权不在」（预期，每 24 小时提醒一次）
- [ ] 资料 ingest 到 rustfs 推后
- [ ] 第一次真实早报和 dream：明天 08:25 / 08:30 看

### 附2.4 M3b 进度（2026-11-17）

控制台：`https://<host>.<tailnet>.ts.net:8444`（只在 tailnet 内可达）。`tailscale serve --bg --https=8444 unix:/run/sbot/console.sock`。2026-11-18 加公网入口（§触5.1）：`web.origin` 指向的 443，经 nginx 到 `/run/sbot-web/console.sock`，密码 + 会话 cookie。

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
- [x] **响应性能**（§触5.5）：`core/test/console-perf-smoke.ts`。同样的首屏 6 个请求，正文 64 KB → 18 KB，刷新 64 KB → 0（全 304）；5 条 SSE 连接 12 秒的核心 CPU 121 ms → 14 ms

### 附2.5 M3c 进度（2026-11-17）

原 §15 陪伴的大部分 + §进2 A 级。复盘和前瞻不另起进程：定时任务（或事收）把代码整理的事实和 skills/ 里的方法塞进主人 DM lane，主 agent 开口，他的回话在同一个会话里接着聊。

- [x] **时间线**：`timeline` 视图（他私聊说的、他在群里说的、随手记、代发、审批、任务、事、前瞻、回看、复盘），`timeline_query` 按时间 / 事 / 领域 / 关键词查。日历没进（要飞书日历 scope，等 主人 点头）
- [x] **随手记** `note_add`（life_notes，带领域 work/family/friends/body/mind，同时写 journal）
- [x] **前瞻** `outlook_submit` / `outlook_revisit`：日 1 条、周 / 月 / 事 3 条，写下不改，回看单独追加；周、月写 `self/outlooks/<期>.md`。早报加「今日留意」（最多 1 条，挂在周 / 月前瞻下）
- [x] **复盘** `review_submit`：日（21:30，安静的日子不发；周日 / 1 号并进周 / 月复盘）、周（周日 20:30，+ 下周前瞻）、月（1 号 20:00，+ 本月前瞻；1/4/7/10 月加季度清理提问）、事收（matter_close → closing 时排进这件事的 lane，复盘写回事的页面，状态 reviewed）。没有他的原话就记「未聊」，agent 的对照丢掉。问题反馈记 `review_question` 信号
- [x] **习气 / 节律**：`self_items` 表，代码生成 `self/habits.md`、`self/rhythms.md`（visibility: owner）。dream 用 `self_candidate` 提候选（只写行为；他的原话 1 条就够，推断的至少 2 条；一夜最多 6 处）；只有他能认（`self_mark` 要 `owner@` 来源 + 原话）
- [x] **谁先看见 / 送一程**：noticings 表；记成他先看见必须引他这次的原话；连续 3 次他先看见 → 送一程（不再主动提）；送一程后 agent 连续 2 次先看见 → 问他要不要再提醒。参数在 `config/self.yaml`
- [x] **风格笔记 + 例子库（§进2 A）**：审批改稿意见、草稿被他自己回复作废都记 journal（owner@approval）；dream 可写 `style/*.md`、`self/guidance-notes.md`（只认他的话）；Triage 起草前带上 style/general.md + 匹配群名的笔记 + 这个群最近 3 条批准稿 + 他最近 5 条发言
- [x] **办事体检卡**（周一 09:05，管理群）：起草五种结局、平均改几轮、分拣分布、「可能漏了」、任务、主动消息、专家、出错 run、复盘聊 / 未聊、按请求方花费，各带上周对比；只有指标
- [x] **隐私（§读5.1）**：飞书里 memory_read 读不了 self/habits.md、rhythms.md、charts/（用 self_list；v0.23 起他私聊里亲手问的可以读，§读5.1）；管理群 dream diff 对 self/ 只报候选数
- [x] `test/m3c-smoke.ts` 33 项全过；已部署，jobs.yaml / self.yaml 已提交
- [x] 顺手修：lark 用户 token 进入 `needs_refresh` 时 observer 当成「没授权」停了调用，于是永远不会刷新（每 2 小时停一次）。现在 refresh token 有效就照常调用，调用时自动刷新
- [ ] 没做：节气月（self.yaml `month: solar_term` 先按公历月）、日历进时间线、控制台的时间线 / 习气 / 前瞻页面、lens-notes（M6）
- [ ] 第一次真实日复盘今晚 21:30；周复盘周日（11-22）20:30；体检卡下周一 09:05

### 附2.6 M6 进度（2026-11-17）

- [x] **镜头插件** `/opt/sbot/plugins/sbot-lens` v0.2.0（root 只读）：紫微（chart / natal / zhanbu）+ 六爻（liuyao-guanxiang）。跑在密封 worker 里：sbot-w、空 egress（没网）、只给 Bash/Read/Write/Glob/Grep/Skill，显式 skills 白名单，15 分钟、60k 预算
- [x] **解读账本**：`readings`（写下不改，带 profile_version = 镜头 + 设置 + 出生信息 + 插件版本的 hash）、`reading_revisits`（只记他的原话）。盘冻结在 `self/charts/<lens>/<版本>/`
- [x] 工具 `lens_reading`（L1，主人）、`readings_query`、`reading_revisit`（只认 owner@）。同一件事同一门镜头只看一次（渎则不告），事情变了写明原因才再看；月视图写下就冻结
- [x] 出生信息只在 `config/self.yaml`（控制台填，保存时管理群只报行数）；飞书里不问出生时间，不贴盘
- [x] 复盘接上：周复盘带本周到期的 claim，月复盘带上月 / 本月看法和 `self/lens-notes/`，事收带这件事的看法；dream 只从他的回看原话写 lens-notes，不打分
- [x] `lens_month` 每月 1 号 06:00 排流月；`test/m6-smoke.ts` 离线全过，`--live` 一卦六爻真跑通（$0.14）
- [x] v0.23：生辰表单、`self_profile`、`self_page`、六爻日周月例行看法；`test/self-profile-smoke.ts`
- [ ] 没做：控制台的看法 / 盘页面；节气月

### 附2.7 M7 进度（2026-11-17）

§进2 B 级的闭环骨架：信号 → 回放样本 → 提案 → 回放 → 一张卡 → 生效 → 两周回看 → 一键回滚。

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

### 附2.8 M8 进度（2026-11-17）

§读2 以事为轴：事件账本、信息源、导入。

- [x] **事件账本**（`src/events.ts`）：Triage 一次调用同时出动作和事件（kind × level），代码校验：序号必须在这批里、事的编号必须是正在进行的、不认识的 kind / level 落回 info / fyi；同一批里我已经回过的直接记成 done。提醒按事 / 话头分组，要你回 / 拍板在前
- [x] **自动关**：我在原处说话（回复某条就只关那条）、草稿以我的名义发出 → done；草稿被我拒 → dropped。都是代码从我的行为判断，不让模型猜
- [x] **串起来**：Triage 的输入带上正在进行的事（标题、`keys`、最近在哪些地方）和最近 7 天的话头；话头一周里跨 ≥ 2 处出现 ≥ 3 次，就进早报的「可能该起局」。挂上（`matter_link` 或控制台）后话头变成这件事的 key
- [x] **信息源**（`src/sources.ts`、`config/sources.yaml`）：飞书私聊（`feishu.dm`，默认关）、git、fetch、command 插件。新增或放宽在管理群醒目提醒；插件要核心自己的密钥直接拒；stderr 打码
- [x] **导入**（`src/importer.ts`、`import/PROMPT.md`、`import/example.json`）：`sbot-import/1` 直接导；其他材料由 work 档分块整理（≤ 6 块，3 块并发）。预览显示哪些是新的、哪些并进已有的事 / 人；导入后管理群一句话；撤销按 `[src=import:<id>]` 找回去
- [x] 工具：`matter_open` 可带 topic / keys，`matter_link`（L1）、`matter_events`（L0）、`event_update`（L1），都只给 owner；早报加「等你回 / 拍板」「按事」「可能该起局」三段；时间线多了「事件」
- [x] 控制台：待办、生活 › 事 / 导入、它自己 › 信息源（§触5.2）
- [x] `test/m8-smoke.ts` 离线全过（分拣、自动关、话头、信息源三种 kind + 插件密钥规则、导入预览 / 应用 / 合并 / 撤销）；`--live` 真跑分拣 3 个地方和一次原始材料导入，$0.05；m7 回归全过
- [ ] 没做：微信侧的事件（等微信接入）；控制台里编辑 sources.yaml 之外的插件管理（插件只能主人在服务器上装）；我纠正事件级别 / 归属算不算 §进2 的信号（D 级，等我定）

### 附2.9 因缘进度（2026-11-18）

§读4 人、事、资料的图谱。

- [x] **登记**（`src/graph.ts`）：people.yaml（只读）→ 人物页 → 飞书 / 微信里说过话的人 → 事件里的 actor，按 ID 和名字认人；名字有两个人对得上就不猜
- [x] **构建**：消息（挨着说话、@、在哪个群、私聊）、事件（谁在哪件事里、事在哪）、页面（链接、提到、事的「关键人」）、资料（喂过哪些页）、我记的关系。纯代码，最多 15 分钟重算一次，打开控制台或工具查人时触发
- [x] **圈子**：带权标签传播；名字取大家最常在的群。**因缘**：初见（在哪、同场有谁、我在不在）、最近一次、每月往来
- [x] **纠正**：改名、分圈子、隐藏、合并、拆开叫法、记关系 / 认 / 去掉；people.yaml 字节不变
- [x] 工具 `person_lookup` / `person_path`（L0）、`person_relate`（L1，只能记推测），只给 owner；控制台 生活 › 人 / 因缘（§触5.2）
- [x] `test/graph-smoke.ts` 离线全过（登记、各类边和可信度、self/ 不进图、圈子、初见、路径不经过我、借机观察、纠正、工具权限）
- [ ] 没做：从对话里自动记关系；周复盘里的因缘段；增量构建（见「仍然未决」）

### 附2.10 注意力窗口进度（2026-11-18）

- [x] `gate.yaml attention`（校验、热加载、按地方覆盖、缩短时醒目通知）；notify / draft 等窗口，escalate 默认不等（§读2.4）
- [x] 「我回应了」一条规则，分拣前后说的话都算（§读2.5）；不用回的提醒按已读过滤、受每日上限约束，超出的进早报（§寸2）
- [x] `test/attention-smoke.ts` 离线全过；m7、m8、triage-address 回归全过
- [ ] 没做：飞书里在某条消息下新开话题回复时，那条消息记录上没有 thread_id，对不上，这种情况会多提醒一次

### 附2.11 飞书邮箱进度（2026-11-18）

§读2.1 的 `kind: feishu-mail`。

- [x] **读取**（`src/source-mail.ts`）：收件箱和已发送，只用三个读接口；基线、分页、去重、敏感主题跳过
- [x] **判定和清洗**：`to_me` / `from_me`、一个邮件会话一个地方、去引用、去签名、截断
- [x] **分拣围栏**：外面的文字写不出 `<untrusted>` 标记；群消息升级给主 agent 时也包着；信息源不升级，封顶到提醒
- [x] `test/mail-smoke.ts` 离线全过（假 `lark-cli` 和虚构邮件）；m7、m8、graph、attention、triage-address 回归全过
- [ ] 没做：自定义文件夹；附件；邮件的「打开」链接

### 附2.12 主线与每日整理进度（2026-11-18）

- [x] 主线 / 子事 / 合并、改动账本和撤销（§读3.1）；事件、keys、话头、页面、图谱跟着走
- [x] Triage、早报、提醒、控制台按主线；导入按主线总结，预览给数量和提醒（§读2.6）
- [x] 每日整理（§读3.2）：卡片、控制台、主 agent 工具三个入口，走同一套操作
- [x] `test/matter-review-smoke.ts` 全过；m7、m8、mail、graph、attention、triage-address、console-web、m3c 回归全过；迁移在线上库的副本上演练过，副本已删
- [ ] 没做：卡片在真实飞书里的显示和点击，上线后第一张卡才验证得到

### 附2.13 seed 同步进度（2026-11-20）

- [x] `memory.ts`：启动时按 `seed.state` 比对；没动过的换上（一个提交），它的规则等「更新 seed」，改过的只报一次；通知和上线通知合成一条（§底1.5）
- [x] 线上实例先手动同步到 v0.24 的 SOUL、AGENTS 和两份方法（比对过都等于旧 seed，没有手改；主人授权），之后由这套机制接管
- [x] `test/seed-smoke.ts` 全过
- [ ] 没做：控制台里看哪些在等我点头；通知没理之后不再提醒

### 附2.14 触点第 1 批待实现（2026-11-22，§触1.1）
- [ ] `gate.yaml` 加 `push`（默认值见 §触1.1）、schema、表单描述（§触5.6），放宽项进 `widening()`
- [ ] 推的出口统一过一道：对话中先等（安静 5 分钟，最多推迟 30）、夜间只记不发、`night_allow` 按类别放行、夜里发过消息 30 分钟按白天；攒下的进早报“夜里来的”
- [ ] 它自己设的 follow-up 落在夜里挪到夜间结束；我定时间的照发
- [ ] 早上一次：整理卡等早报发出后再发；`dream_diff` 默认改 08:30，早报带一句“昨晚记忆改了 N 处”
- [ ] “等你”卡加暂缓三档（今晚 20:00 占 1 条额度；明早、下周一并进早报），截止早于暂缓的档不显示
- [ ] 任务完成、失败私聊只推一句 + 话题链接（`tasks.ts` 现在贴最多 3000 字）
- [ ] 它想到的建议每天 ≤ 3 条、7 天收进“过期”
- [ ] 已读按人算（客户端做时一起，§触6）

## 附3 里程碑

| | 内容 | 验收标准 |
|---|---|---|
| **P0** | §附2 的探针脚本 | 全部有结论；不通过的项都写好了替代方案 |
| **M0 内核** | inbox + Dispatcher + `Runner` 接口（按 P0 结论接 pi 或 SDK；resume + 兜底）+ 与 harness 无关的工具层 + LLM 代理（先只接一个档）+ 飞书私聊 + 发件箱（只有 L0）+ `/model` + systemd（核心 `OOMScoreAdjust`，worker 用 scope 限 `MemoryMax`）+ 每晚备份到 `sbot-backup` + rustfs 受限 key + SOUL.md / AGENTS.md 写入红尘里修的立场和分寸 | 飞书私聊能聊；kill 进程后消息不丢、不重复回；用量能看到 |
| **M1 审批与观察** | 闸门 + 提交式审批 + 状态机 + 管理群卡片 + observer（过一遍群列表、敏感和外部群默认值、回环过滤）+ Triage + 起草 run + `/group` + **记录信号**（审批的修改意见和最终版本、起草的输入快照、runs 的版本号；只记录，不分析） | 有人在工作群 @我 → 几分钟内管理群出现草稿卡 → 我点发送 → 以我的身份发出；我先自己回了的话，卡片自动作废 |
| **M2 任务与事** | Task Engine + `sbot-w` 隔离 + 挂起式审批 + 工作台话题 + follow-up 定时器 + 三档路由 + matter（事）+ 起局（事实盘点、问发心、检查点，暂不带镜头） | 私聊派活 → 工作台开话题 → worker 申请 push → 卡片批准 → 推送成功；"周三提醒我"到点就提醒 |
| **M3 记忆与控制台** | journal 来源标签 + **知识库**（raw 入 `sbot-raw`、ingest、`index.md` / `log.md`、`pages_fts` + `wiki_search`、好答案回收、visibility）+ 备份异地副本 + dream + 晨间 diff + schedule（早报）+ Sentinel + 先安静 + 控制台（状态、模型、群、记忆、用量）+ 复盘（事收、日、周）+ 前瞻（早报里的今日留意、周前瞻；只用事实、习气、节律，不带镜头）+ 时间线视图 + 随手记 + `self/` 档案 + 习气和节律候选 + guidance-notes + 风格笔记和范例库（§进2 A 级）+ 每周一张"办事体检"卡（只有指标，不出提案）+ `noticings` 记录和"送一程"（复盘顺序的调整后置到 M7） | 一周后 MEMORY.md 里有内容，而且都是我认可的；手机上能切群开关和模型；一件事收尾后，agent 先给事实初稿，再用几个问题引我说出当时的想法和感受；周日晚收到"回看本周 + 看下周"，下个周日它会把上周的建议拿出来问我 |
| **M4 微信读** | Windows 边缘 + reader + owner 会话 + 微信群 Triage + 摘要 | 能在微信里跟它聊；每晚收到群摘要 |
| **M5 微信写与他人** | sender（唯一备注 + 标题校验 + 发送确认）+ 他人会话（工具范围、硬上限、承诺检测）+ auto 规则 + 剩下的控制台页面 | 老婆问日程自动回；让它查资料整理表格时先弹审批卡；点"以后自动"后同类事情不再问我 |
| **M6 镜头与月前瞻** | lens 角色 + 统一输出格式（含 horizon / period）+ 解读账本（看法先记下、到时回看、我说感受）+ lens-notes + 紫微接入（现有 skill，流月）+ 月复盘加月前瞻 + 季度心得过目；六爻 skill 单独做好后接入；八字后续。不依赖微信，可以提到 M4 之前做 | 起局时能起一卦，月初能看流月，看法自动记下；到了时间，在复盘里被拿出来回看；一个月后 lens-notes 和 guidance-notes 里有基于我回看感受的笔记，下个月的前瞻明显引用了它们 |
| **M7 自我改进** | improve run（按信号量触发的体检，含 wiki lint 的重活）+ 陪伴信号 + 复盘顺序随熟练度调整+ 评测集自动攒 + 回放评测 + B 级提案卡 + 上线带版本 + 两周复查和一键回滚 | 一个月里至少有一条提案带着新旧对比被我批了；上线两周后卡片告诉我指标是变好还是变差；回滚一键生效 |
| **M8 以事为轴** | 事件账本（kind × level × state，自动关）+ 话头和 matter keys + 信息源（飞书私聊、git、fetch、command 插件）+ 导入（格式、提示词、预览 / 应用 / 撤销）+ 控制台的事件、导入、信息源页（§读2） | 两个群加一个私聊在说同一件事 → 早报里它们在同一件事下面；要我回的那条，我在原处回了以后自己消失；从别的工具导出的总结一次导进来，事和人都在，撤销干净 |

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
