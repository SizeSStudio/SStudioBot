# 技术设计 04：表结构

新主（`hub/`）SQLite 的全部表、索引、触发器。取代 `docs/design/09-base.md` 的 §底5（那一节留作需求参考，以这里为准）。旧 `core/src/db.ts` 里某列实际怎么用，以代码为准；设计里新加的，以设计为准；两边冲突的，按已定的推，写在 §14。※ = 推出来的、或改了我定过的行为，主的模块文件里要拍板。

约定：
- **引擎**：`node:sqlite`（`DatabaseSync`），一条连接，同步写，`tx()` 可嵌套（外层 `BEGIN IMMEDIATE`），seq 的顺序就是提交顺序。开库先执行：
  ```sql
  PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA busy_timeout=5000; PRAGMA foreign_keys=OFF;
  ```
  `PRAGMA user_version` 记 schema 版本，新主从 1 起。之后只做加法（加表、加列、加索引），每次加一。
- **时间**：毫秒整数（Unix epoch ms）。列名用 `ts`、`*_at`，沿用旧名的照旧（`started`、`ended`、`expires`）。本地日期和周期用 TEXT，按我的时区（`2026-12-03`、`2026-W49`、`2026-12`）。
- **id**：
  - 只在库里引用的：`INTEGER PRIMARY KEY AUTOINCREMENT`。删了不复用，事件流的 ref、`m<id>`、已读状态都靠这个。
  - 跨进程、会出现在文本里的：TEXT，由代码生成。
    - runs：`r_<ms36>_<6hex>`；节点任务的一轮：`tr_<task>_<attempt>_<turn>`
    - tasks：`t<n>`（kv `task.seq`）
    - threads：`th_<ms36><4hex>`
    - devices：公钥的 hash（见 devices）
  - 渠道来的：用渠道原生 id（飞书 `om_…`、`oc_…`）。自己生成的加前缀：`card:`、`outbox:`、`src:<源>:`、`console:<device>:<op>`。非飞书渠道的 id 一律加 `<渠道>:` 前缀，保证不撞。
  - ref 类列里跨表引用写成 `<entity>:<id>`（`approval:12`、`task:t3`、`thread:th_k3x9a1b2`）。
- **JSON**：JSON 列以 `_json` 结尾，存 JSON 文本，NULL = 没有。
- **布尔**：`INTEGER NOT NULL DEFAULT 0`，取 0/1。
- **枚举**：写在列注释里，不写 CHECK。SQLite 改 CHECK 要重建表，而协议只加不减，枚举会长。
- **STRICT**：所有普通表都是 STRICT，FTS5 虚表除外（它不支持）。理由：类型写错当场抛错，不必等到查数据时才发现。node:sqlite 实测（Node 25.8 / SQLite 3.53）：
  - 浮点数写 INTEGER 列抛错，所以毫秒值要 `Math.round`；
  - 数字字符串会转成整数，bigint 可以存；
  - 整数写 TEXT 列会存成文本，触发器把 `NEW.id` 写进 `change_log.ref` 就靠这一条。
- **外键**：不声明 FOREIGN KEY。重建、清零、按 id 删时不想级联，引用也常指向「不搬」的表；关系由代码维护。
- **大载荷不进表**：
  - 文件放 `$SBOT_HOME/blobs/<sha256>`（内容寻址），表里只留 `blob:<sha256>`。
  - 其他引用前缀：`raw:<sha256>` 对应 `raw/sha256/<前两位>/<sha256>`（带过去）；`body:<相对路径>` 对应 `private/body/`（带过去，仅我可见）。
  - 文件引用只放在以 `_ref` 结尾的列里，不埋进 JSON：GC 只扫这些列（§11）。反过来不成立，`session_ref`、`veto_ref` 这类也以 `_ref` 结尾，但不是文件。
  - 进 blob 的列只有这几个：`requests.body_ref`、`runs.input_ref`、`run_items.body_ref`、`approvals.request_ref`、`approvals.context_ref`、`tasks.diff_ref`、`task_sessions.handoff_ref`、`readings.chart_ref`、`eval_cases.input_ref`、`proposals.old_ref`、`proposals.new_ref`。
  - 其中 `run_items.body_json` 和 `approvals.request_json` 是超过 16 KB 才把全文放进 blob，表里留前 2 KB 预览。
  - 正文类的列（消息、笔记、草稿、回复）照存表里：要进 FTS，也是我的数据。
  - 写 blob 的顺序：先写临时文件、fsync、rename 成 `<sha>`，再提交引用它的事务。
- **每张表上方一行标签**，格式是 `来源 · 数据 · 触发器 · 可见 · 保留`：
  - **来源**：旧表名或「新」。
  - **数据**（重建时怎么来）：
    - 重读：从渠道重新拉，再跑分拣和归事；
    - 重算：从别的表或文件算出来；
    - 清零：新库空着开始；
    - 新：旧库没有；
    - 带过去：从旧库原样搬，改名和转格式写在表下；
    - 不搬：运行期数据，丢掉。
  - **触发器**：「有（entity）」= 写 `change_log` 的触发器；「显式（entity）」= 写入的模块在同一事务里 `emit()`；「无」。
  - **可见**（事件流按角色过滤、§读5.1）：
    - `owner`：最严那档，指 `self/`、出生信息、命盘、解读、身体。只在我亲手发消息的 run 里能整份读；定时、审批、任务、系统 run 和 `node` 角色读不到；推送只说「有一条私人的」。
    - `personal`：生活域。不进群和工作台，飞书只在私聊。
    - `work`：工作域。
    - `按 lane`：lane 映射到 `threads.domain`，飞书群和工作台恒为 work。`按行`：看本行的 `domain` 或 `visibility` 列。
    - `内部`：主自己用，不推流、不进渠道，客户端要看走 API。
  - **保留**：只对日志、派生、缓存类设。我的数据一律「不删」。
- `node` 角色连接不能订阅事件流（§触6.4），所以事件流过滤实际只分 client 和「不发」。

## 1 运行

**inbox**　旧 inbox · 不搬 · 有（input）· 按 lane · 不删
```sql
CREATE TABLE inbox(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  lane TEXT NOT NULL,                -- feishu:dm:owner | console:main | console:t:<thread> | task:<id> | feishu:wb:<thread> | …
  kind TEXT NOT NULL,                -- user|command|card|timer|system|approval|task
  source TEXT NOT NULL,              -- feishu|console|card|timer|job|lens|matter|triage|approval|task|…
  source_msg_id TEXT NOT NULL,       -- 去重键，形状见下
  turn_ctx_json TEXT,                -- 回复落点 TurnContext（channel 是任意渠道 id）
  payload_json TEXT,                 -- {text, ts, message_type?, quota?, job?, retry?, …}
  status TEXT NOT NULL DEFAULT 'received', -- received|processing|done|interrupted|failed|dropped
  run_id TEXT,
  device_id TEXT,                    -- 客户端发的：哪台设备。删设备时它 received 的行改 dropped
  tries INTEGER NOT NULL DEFAULT 0,  -- 取出处理一次 +1；重启时 processing 且 tries ≥ 2 → failed，告诉我（连崩两次熔断）
  not_before INTEGER,                -- 这之前不取（§底4.3 等上游恢复）
  ts INTEGER NOT NULL,
  UNIQUE(source, source_msg_id)
) STRICT;
CREATE INDEX inbox_status_lane ON inbox(status, lane, id);
CREATE INDEX inbox_device ON inbox(device_id, status) WHERE device_id IS NOT NULL;
```
- `source_msg_id` 的形状（照代码，加客户端）：

  | source | source_msg_id |
  |---|---|
  | feishu | message_id |
  | card | event_id |
  | timer | `<timer_id>:<due_at>` |
  | job | `<name>:<due_at>` 或 `<name>:manual:<ts>` |
  | lens | `<id>:<status>:<ts>` |
  | matter | `<id>:review` |
  | triage | message id |
  | approval | `<id>:<decision>` |
  | task | `<task_id>:<attempt>:<turn>:<kind>` |
  | console | `<device_id>:<client_op_id>`（§触6.4） |

**runs**　旧 runs · 不搬 · 有（run）· 按 lane · 不删（`input_ref` 指向的快照留 1 年，§11）
```sql
CREATE TABLE runs(
  id TEXT PRIMARY KEY,               -- r_<ms36>_<6hex>；节点任务的一轮 tr_<task>_<attempt>_<turn>
  lane TEXT,
  session_key TEXT,                  -- sessions.key
  session_ref TEXT,
  role TEXT,                         -- main|draft|dream|improve|lens|expert|task（旧 worker → task）
  tier TEXT,                         -- chat|work|light|expert；节点任务 NULL
  model TEXT,
  status TEXT NOT NULL,              -- running|done|failed|aborted|interrupted
  stop_reason TEXT,
  side_effects INTEGER NOT NULL DEFAULT 0, -- 1 = 有过对外动作，重启不重跑（§底1.2）
  error TEXT,
  err_fp TEXT,                       -- 错误指纹；同一指纹连着 N 次熔断（measure，§底1.2）
  input_ref TEXT,                    -- 起草类 run 的输入快照 blob:
  versions_json TEXT,                -- {model, tuning:{<file>:<ver>}}；节点 {agent, cli, model}
  task_id TEXT,
  device_id TEXT,                    -- 发起它的设备 = 触发这批输入里第一条的 inbox.device_id；飞书、定时、系统为 NULL。删设备时停它 running 的
  started INTEGER, ended INTEGER
) STRICT;
CREATE INDEX runs_status ON runs(status);
CREATE INDEX runs_lane ON runs(lane, started);
CREATE INDEX runs_task ON runs(task_id) WHERE task_id IS NOT NULL;
CREATE INDEX runs_device ON runs(device_id, status) WHERE device_id IS NOT NULL;
```

**run_tokens**　旧 run_tokens · 不搬 · 无 · 内部 · 不删
```sql
CREATE TABLE run_tokens(
  hash TEXT PRIMARY KEY,             -- sha256(令牌)；明文只在 run 的内存里
  run_id TEXT, tier TEXT, requester_id TEXT,
  budget_output INTEGER,             -- 告警线：到了只告警，不停（§办2.2）
  spent_output INTEGER NOT NULL DEFAULT 0,
  expires INTEGER,
  status TEXT NOT NULL DEFAULT 'active' -- active|revoked（去掉 budget_exhausted，R7）
) STRICT, WITHOUT ROWID;
```
- 远端节点不给令牌（§办3.2），这张表只管主上的 run。

**sessions**　旧 sessions · 不搬 · 无 · 按 lane · 不删
```sql
CREATE TABLE sessions(
  key TEXT PRIMARY KEY,              -- lane
  harness TEXT,                      -- pi（主上只有 pi；节点 agent 的 session 在 task_sessions）
  session_ref TEXT,
  generation INTEGER NOT NULL DEFAULT 0, -- 滚动或换模型 +1
  surface TEXT, tier TEXT, model TEXT,
  status TEXT NOT NULL DEFAULT 'active', -- active|roll
  started INTEGER, last_active INTEGER,
  summary TEXT                       -- 滚动或空闲收尾的要点
) STRICT, WITHOUT ROWID;
```

**run_items**　新 · 新 · 有（item）· 按 lane · 不删（这是对话记录）
```sql
CREATE TABLE run_items(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  lane TEXT NOT NULL,
  run_id TEXT NOT NULL,
  kind TEXT NOT NULL,                -- assistant|tool|notice
  status TEXT NOT NULL,              -- running|done|error
  ts INTEGER NOT NULL, ended INTEGER,
  name TEXT,                         -- tool：工具名；notice：类别（同 push_queue.cat）
  call_id TEXT,                      -- tool：agent 给的调用 id；节点回传按 (run_id, call_id) 对上
  body_json TEXT,                    -- assistant {text}；tool {args, result}；notice {text, ref}。入库前打码（§触6.4）
  body_ref TEXT,                     -- body_json 超 16 KB 时全文 blob:，body_json 留前 2 KB
  truncated INTEGER NOT NULL DEFAULT 0 -- 1 = 有字段截断了，主上也没有全文
) STRICT;
CREATE INDEX run_items_lane ON run_items(lane, id);
CREATE INDEX run_items_run ON run_items(run_id, id);
```
- assistant：一段写完才插一行，全文不截断。token 增量不落库。
- tool：开始时插 `running`，结束时更新。
- ※ tool 的 `args`、`result` 各截到 2 KB（UTF-8 字节），`truncated=1`。全文在哪：走主代理的 run 看 `requests`（7 天）；节点任务的，主上不存，点开时向节点拉，节点离线就只有截断的。理由：远端 agent 不走代理，`requests` 里没有；全存会让这张表大一个量级（§13）。
- notice（不拦人的通知）只进这里，不进 approvals（§底3.2 C）。

**usage**　旧 usage · 不搬 · 无 · 内部 · 不删
```sql
CREATE TABLE usage(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  source TEXT NOT NULL DEFAULT 'proxy', -- proxy：主的 LLM 代理计的 | node：节点 agent 自报（用订阅，不经代理，§进2.2）
  device_id TEXT,                    -- 这笔记在哪台设备上：proxy 行 = runs.device_id（飞书、定时为 NULL）；node 行 = 报数的节点（§底3.8 按设备记）
  run_id TEXT, task_id TEXT,         -- node 行带 task_id（旧代码从没写过它）
  tier TEXT, endpoint TEXT, model TEXT, requester_id TEXT,
  input_tokens INTEGER, output_tokens INTEGER, cache_read INTEGER, cache_write INTEGER,
  cost REAL,                         -- 美元；node 行报不出就 NULL
  status INTEGER,                    -- HTTP 状态；node 行 NULL
  ms INTEGER
) STRICT;
CREATE INDEX usage_ts ON usage(ts);
CREATE INDEX usage_run ON usage(run_id);
CREATE INDEX usage_device ON usage(device_id, ts) WHERE device_id IS NOT NULL;
```
- 节点报的剩余额度不进这张表，在 `nodes.quota_json`。

**requests**　旧 requests · 不搬 · 无 · owner · 7 天（行和 blob 一起，§11）
```sql
CREATE TABLE requests(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  run_id TEXT, usage_id INTEGER, tier TEXT, model TEXT,
  bytes INTEGER,                     -- gzip 后
  body_ref TEXT NOT NULL             -- blob:，内容是 gzip 的完整模型请求（主对话和起草 run，§触5.4）
) STRICT;
CREATE INDEX requests_ts ON requests(ts);
CREATE INDEX requests_run ON requests(run_id);
```
- 旧代码每插一行就 `DELETE … < now-7d`（`proxy.ts:244`），改成每小时清一次。

## 2 出口

**approvals**　旧 approvals · 不搬（切换前处理完，id 接着旧库最大值往上编）· 有（approval）· 按 origin_lane · 不删
```sql
CREATE TABLE approvals(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL,                -- send|plan|glance|ask|proposal|rollback（proposal、rollback 见 §14 第 1 条）
  origin_lane TEXT,
  run_id TEXT,
  task_id TEXT,
  attempt INTEGER,                   -- glance|ask：发卡时任务的 attempt；答案回传时不等于 tasks.attempt 就不送
  session_ref TEXT,                  -- glance|ask：哪个 session；卡作废后再答时按它续上重问（§办3.3）
  tool_use_id TEXT,                  -- glance：agent 那边权限请求的 id；ask：ask 调用的 id
  requester TEXT,                    -- 谁提的：run 角色，或 node:<device_id>
  channel TEXT, target_json TEXT, as_identity TEXT, -- send：发到哪、用谁的身份（user|bot）
  title TEXT,
  draft TEXT,
  draft_version INTEGER NOT NULL DEFAULT 1, -- 乐观锁；「改一下」+1
  request_json TEXT,                 -- glance：agent 原样给的 {tool, command, path, args, cwd, …}，完整不截断；超 16 KB 时这里留预览
  request_ref TEXT,                  -- request_json 超 16 KB 时的全文 blob:
  options_json TEXT,                 -- glance|ask：agent 给的选项，原样 [{id, label, kind}]
  answer_json TEXT,                  -- glance|ask：我的回答 {option_id} 或 {text}
  context_json TEXT,                 -- 小字段：turn、hold、chat_name、sender_name、in_thread、link、proposal_ids、diff_file…
  context_ref TEXT,                  -- 触发处上下文全文 blob:（旧 context_json.context_text，最多 6000 字）
  refs_json TEXT,                    -- 卡上「引用了哪些记忆」（§底3.3）
  checks_json TEXT, expert_json TEXT,
  trigger_chat TEXT, trigger_msg_id TEXT, trigger_ts INTEGER,
  status TEXT NOT NULL DEFAULT 'pending', -- pending|approved|rejected|expired|superseded|invalidated
  superseded_by INTEGER,
  expires_at INTEGER,                -- = send_by。send 默认 2 小时；proposal 72 小时；glance|ask 为 NULL（不设超时）
  decided_by TEXT,                   -- device:<id> | <渠道>（渠道里已校验是我） | code:<原因> | owner_message（等看一眼时我直接发消息，先拒）
  decided_at INTEGER, decide_note TEXT,
  revise_notes TEXT, final_text TEXT, result TEXT,
  cards_json TEXT,                   -- 各处的卡 [{channel, chat, msg_id}]；决定后逐张改
  matter_id INTEGER,
  ts INTEGER NOT NULL
) STRICT;
CREATE INDEX approvals_status ON approvals(status, trigger_chat);
CREATE INDEX approvals_task ON approvals(task_id, status) WHERE task_id IS NOT NULL;
```
- 状态机照 §底3.3。glance、ask 怎么落到状态上：
  - 选了 agent 给的放行类选项、或答了 ask → `approved`；选了拒绝类选项 → `rejected`。具体选了哪个看 `answer_json`。
  - 节点或 agent 进程重启 → `invalidated`，`result='node_restart'`。之后我再答，走任务的续接动作（client_ops），不再改这张卡。
- 只认我答：`node` 角色的连接写不了 `status`、`answer_json`（§触6.7）。

**outbox**　旧 outbox · 不搬（切换前发完）· 有（approval，只在 approval_id 非空时）· 按 lane · 不删
```sql
CREATE TABLE outbox(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  approval_id INTEGER UNIQUE,        -- 一个审批最多发一次
  run_id TEXT, lane TEXT,
  channel TEXT NOT NULL,             -- feishu|console|…（按 channel 找渠道插件，R3）
  kind TEXT NOT NULL DEFAULT 'text', -- text|card
  card_id TEXT,
  as_identity TEXT NOT NULL DEFAULT 'bot', -- bot|user
  target_json TEXT NOT NULL,         -- {surface, chat_id, thread_id?, …}
  payload TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued', -- queued|streaming|sending|sent|failed|unknown|expired|unrouted（streaming 照 card.ts；unrouted = 没有在跑的渠道插件）
  attempts INTEGER NOT NULL DEFAULT 0,
  idem_key TEXT UNIQUE,
  send_by INTEGER, next_try INTEGER,
  sent_msg_id TEXT, error TEXT,
  ts INTEGER
) STRICT;
CREATE INDEX outbox_status ON outbox(status, id);
```

**push_queue**　新 · 新 · 显式（被推条目的 entity）· 按 domain · ※ 关掉的行 30 天
```sql
CREATE TABLE push_queue(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  cat TEXT NOT NULL,                 -- §触1.1 路由表类别：ask|approval|owner_followup|agent_followup|alert_security|alert_ops|notice|task_end|morning|tidy|fyi|suggestion|reflect
  ref TEXT NOT NULL,                 -- 推的是什么：<entity>:<id>[:<状态>]，如 approval:12、task:t42:done
  lane TEXT,
  domain TEXT NOT NULL DEFAULT 'work', -- work|personal。personal：FCM 只说「有一条私人的」，飞书只发「客户端有新消息」
  urgent INTEGER NOT NULL DEFAULT 0, -- 代码按 cat 定（D1：紧急类 FCM 和飞书同发）
  quota INTEGER NOT NULL DEFAULT 0,  -- 1 = 占 §寸2 当天的主动消息额度
  text TEXT,                         -- 推的那一句
  state TEXT NOT NULL DEFAULT 'wait', -- wait（等时机）|night（夜里攒进早报）|counted（在场只计数，走开时再推）|sent|done（我看过或处理了）|void（作废）
  not_before INTEGER,                -- 最早可发：安静 5 分钟、夜间结束、暂缓到点
  deadline INTEGER,                  -- 最晚：入队 + max_delay；进了夜间批置 NULL
  snooze TEXT,                       -- tonight|morning|monday（暂缓三档）
  expires_at INTEGER,                -- 跟原条目的 send_by；到了 void
  sent_json TEXT,                    -- 每一路的结果 [{via: fcm|feishu|…, at, ok, outbox_id?}]
  enq_at INTEGER NOT NULL, sent_at INTEGER, closed_at INTEGER,
  UNIQUE(cat, ref)
) STRICT;
CREATE INDEX push_queue_due ON push_queue(state, not_before);
CREATE INDEX push_queue_sent ON push_queue(sent_at) WHERE quota = 1;
```
- 补推、在场后推、夜里攒、暂缓，都是这张表里一行的状态。重启后照表接着走（§触1.1「补推队列落表」）。
- 类别「不补」的，`sent` 以后直接 `done`。
- 当天额度 = `quota=1 AND sent_at >= 今天 0 点` 的行数，取代旧的 kv `proactive.<day>`。
- 暂缓改了，要显式发被推条目的 entity，别的设备才会收起那张卡。
- **在场不落表**：只在内存里。

**reads**　新 · 新 · 显式（read）· 内部 · 不删
```sql
CREATE TABLE reads(
  ref TEXT PRIMARY KEY,              -- 同 push_queue.ref 的形状；thread 用 thread:<id>
  upto_ts INTEGER,                   -- thread：读到的最后一条时间线项的 ts；单条目为 NULL
  read_at INTEGER NOT NULL,
  via TEXT NOT NULL                  -- device:<id> | feishu（飞书的已读回执） | …
) STRICT, WITHOUT ROWID;
```
- 已读按人算，不按设备：键里没有设备。只有我一个人用客户端，所以键里也没有人。哪台设备看过、或在飞书里打开过，都写同一行。

**suggestions**　新 · 新 · 显式（suggestion）· 按行 · 不删
```sql
CREATE TABLE suggestions(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  origin TEXT NOT NULL DEFAULT 'agent', -- agent（它想到的）；整理类在 matter_reviews，前瞻类在 outlooks
  fp TEXT NOT NULL,                  -- 驳回指纹（同 dismissals.fp），出建议前先查
  text TEXT NOT NULL,
  why_now TEXT,                      -- 为什么是现在
  opener TEXT,                       -- 我会怎么开口让它做
  domain TEXT NOT NULL DEFAULT 'work', -- work|personal
  matter_id INTEGER, refs_json TEXT,
  status TEXT NOT NULL DEFAULT 'new', -- new|acted|dismissed|expired（7 天没动 → expired，不删）
  decided_at INTEGER,
  run_id TEXT
) STRICT;
CREATE INDEX suggestions_status ON suggestions(status, ts);
```
- 旧库没有地方存「它想到的建议」（§触1 每天 ≤ 3 条、7 天过期），所以加这张表。客户端的「建议」= 这张表 ∪ `matter_reviews` ∪ `outlooks`。

## 3 定时

**timers**　旧 timers · followup 里 pending 的带过去（§14 第 2 条 ※），schedule 重算（`syncJobs`），其余不搬 · 有（timer，只 kind=followup）· 按 lane · 不删
```sql
CREATE TABLE timers(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL,                -- followup|schedule|task
  lane TEXT,
  turn_json TEXT,                    -- followup：回到哪（TurnContext）
  due_at INTEGER NOT NULL,
  cron TEXT,                         -- schedule：jobs.yaml 里的时间表达式（旧代码塞在 turn_json）
  job TEXT,                          -- schedule：jobs.yaml 里的名字（旧代码塞在 note）
  note TEXT,                         -- followup：提醒什么
  payload_json TEXT,                 -- task：{op: resume|ci|release|sweep, pr_id?, node?}
  status TEXT NOT NULL DEFAULT 'pending', -- pending|done|cancelled|missed|skipped|skipped_by_check
  created_by TEXT,                   -- owner（我定了时间的，夜里照发）|agent（它自己定的，落在夜里挪到夜间结束）|jobs.yaml|code
  run_id TEXT,                       -- 建它的 run（旧代码把 run id 放在 created_by）
  matter_id INTEGER, task_id TEXT,
  fired_at INTEGER, ts INTEGER
) STRICT;
CREATE INDEX timers_due ON timers(status, due_at);
CREATE INDEX timers_task ON timers(task_id, status) WHERE task_id IS NOT NULL;
```
- 主是唯一的调度器（Y1）。任务相关的定时都是 `kind=task` 的单次行，到点给节点发一条指令，节点不存定时状态：
  - `resume`：额度恢复；
  - `ci`：查 PR 的检查，有结果后按需再排下一次；
  - `release`：空闲释放，每轮结束时排，到点时有活或有等待点就不放；
  - `sweep`：扫可清理的 worktree，每天一次。
- 带过去的 followup：`turn_json` 改写成新的 TurnContext；`created_by` 从旧的 run id 推不出是谁定的，一律记 `owner`（宁可夜里照发）。

**kv**　旧 kv · 不搬（只带 `task.seq`，接着旧值往上）· 无 · 内部 · 不删
```sql
CREATE TABLE kv(k TEXT PRIMARY KEY, v TEXT) STRICT, WITHOUT ROWID;
```
- 照旧用的键：`job.<name>.last`、`job.<name>.retry`、`dream.*`、`quiet.held`、`matter_review.*`、`self.changes`、`seed.state`、`observer.*`、`sentinel.*`、`improve.last_run`、`source.<id>.*`、`task.seq`、`triage.notified_at`、`release.*`、`graph.built`、`upgrade.lens_jobs`、`groupcard:<msgid>`。
- W3 加：`ease` = `{on, since}`（省心，§寸6；只有 push 写，同事务显式发 `ease` 实体 ※；切换另记 `config_changes`）。
- 挪走或不用的：
  - `feishu.owner_dm_chat` → `channel.feishu.owner_dm_chat`（channels/feishu 自己的状态）；
  - `proactive.<day>` → 按 push_queue 算；
  - `expert.used.<day>` → 按 `usage`（tier=expert）算。

## 4 任务和节点

列还是表：
- 只有一个值的放 tasks 的列：额度恢复时间、最近一次回传（「久没动静」由它算）。
- 一对多的拆表：
  - 失联后换机、换家会开新 session，原 session 不删、能切回去，所以 session 是一对多 → `task_sessions`，空闲释放的进程状态也挂在 session 上；
  - worktree 按节点上的路径存在，「可清理」按节点列 → `worktrees`；
  - CI 按 PR 盯，连红次数按 PR 算，一个任务可能开不止一个 PR → `task_prs`。
- tasks 上的 `node`、`agent`、`session_ref`、`attempt` 是「当前」的指针。

**tasks**　旧 tasks · 不搬（切换前收尾；id 接着旧 `task.seq` 往上）· 有（task，不含 `last_output_at`）· 按 origin_lane · 不删
```sql
CREATE TABLE tasks(
  id TEXT PRIMARY KEY,               -- t<n>，n 取 kv task.seq
  origin_lane TEXT,
  origin_turn_json TEXT,             -- 结果回到发起处用
  goal TEXT NOT NULL,
  context TEXT,
  status TEXT NOT NULL DEFAULT 'queued', -- queued|running|waiting|waiting_node|interrupted|done|failed|cancelled
  repo TEXT,
  node TEXT,                         -- 当前 session 所在节点 = devices.id
  agent TEXT,                        -- 当前 agent：claude|codex|pi|acp:<名字>
  session_ref TEXT,                  -- 当前 session
  attempt INTEGER NOT NULL DEFAULT 0, -- 每开一次 session（含切回旧 session）+1；节点回传带它，小于它的丢（§办3.4）
  turn INTEGER NOT NULL DEFAULT 0,   -- 当前 session 里第几轮（我插话、「再改」各算一轮）；进 inbox 的去重键用
  workdir TEXT,                      -- 当前 session 的工作目录（worktree 时是 worktree 路径）
  mode TEXT,                         -- host|sandbox：只对服务器节点上的 Claude Code（sbot-h / sbot-w）有意义
  tier TEXT,                         -- 走主的代理时才有；节点用自己的登录为 NULL
  quota_until INTEGER,               -- 订阅额度恢复时间；非 NULL 时 status=queued，到点 timers(kind=task, op=resume)
  last_output_at INTEGER,            -- 最近一次节点回传；多久没动静 = now − 它（改它不发事件）
  result_json TEXT,                  -- submit_report 的结果
  diff_ref TEXT,                     -- 定稿 diff blob:（节点在工作目录里算好回传）
  error TEXT,
  approval_id INTEGER,               -- plan 审批批了派出来的
  matter_id INTEGER,
  mirrors_json TEXT,                 -- 渠道上的镜像 [{channel, chat, root_msg, thread}]（旧 wb_root_msg、wb_thread）
  started INTEGER, ended INTEGER,
  ts INTEGER NOT NULL
) STRICT;
CREATE INDEX tasks_status ON tasks(status);
CREATE INDEX tasks_node ON tasks(node, status);
```
- `waiting`：等我。对应 `approvals` 里 kind=glance|ask、task_id 和 attempt 对得上的 pending 行。
- `waiting_node`：等这台机器（失联）。
- 「需要你处理」不存，算出来：`status='interrupted'`，或者 `status='running' AND quota_until IS NULL AND last_output_at < now − 20 分钟`（可改）。
- 排着的插话就是 lane `task:<id>` 里 `received` 的 inbox 行。「停」时这些行改 `dropped`。

**task_sessions**　新 · 新 · 显式（task）· 同 tasks · 不删
```sql
CREATE TABLE task_sessions(
  task_id TEXT NOT NULL,
  node TEXT NOT NULL,                -- devices.id
  agent TEXT NOT NULL,
  session_ref TEXT NOT NULL,         -- agent 开出 session 后才插这一行
  workdir TEXT,
  proc TEXT NOT NULL DEFAULT 'live', -- live（进程在）|released（空闲释放，下次续接）|lost（续接不上）
  last_attempt INTEGER NOT NULL,     -- 最近一次在这个 session 上开的 attempt
  handoff_ref TEXT,                  -- 开它时带的交接文本 blob:（代码按预算拼，§办3.4）；第一个 session 为 NULL
  opened_at INTEGER NOT NULL, released_at INTEGER, last_output_at INTEGER,
  PRIMARY KEY(task_id, node, session_ref)
) STRICT, WITHOUT ROWID;
```

**worktrees**　新 · 新 · 显式（task）· work · 不删（我点了才删 worktree，行留着）
```sql
CREATE TABLE worktrees(
  node TEXT NOT NULL,                -- devices.id
  path TEXT NOT NULL,                -- 节点上的绝对路径
  task_id TEXT NOT NULL,
  repo TEXT NOT NULL,                -- 原仓库路径
  branch TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'in_use', -- in_use|kept（交付后留着）|cleanable（PR 合了或任务取消）|deleting（指令已发）|deleted
  cleanable_at INTEGER,              -- sweep 写
  deleted_at INTEGER, deleted_by TEXT, -- 只在我点了以后：device:<id> | <渠道>（§0.7 删除类不自动做）
  created_at INTEGER NOT NULL,
  PRIMARY KEY(node, path)
) STRICT, WITHOUT ROWID;
CREATE INDEX worktrees_state ON worktrees(state, node);
```

**task_prs**　新 · 新 · 显式（task）· work · 不删
```sql
CREATE TABLE task_prs(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id TEXT NOT NULL,
  node TEXT NOT NULL,                -- 用哪台的 git 登录去查
  url TEXT NOT NULL UNIQUE,
  repo TEXT, number INTEGER, branch TEXT,
  state TEXT NOT NULL DEFAULT 'open', -- open|merged|closed
  ci TEXT,                           -- pending|green|red|none：最近一次查到的
  head_sha TEXT,                     -- 最近一次查的提交；同一个 sha 红了只叫醒一次
  red_streak INTEGER NOT NULL DEFAULT 0, -- 连着红几次，绿了清零；到数（默认 3，可改）发通知、不拦（§14 第 3 条）
  checked_at INTEGER,
  opened_at INTEGER NOT NULL, closed_at INTEGER
) STRICT;
CREATE INDEX task_prs_open ON task_prs(state, checked_at);
CREATE INDEX task_prs_task ON task_prs(task_id);
```

**nodes**　§底5 草案（代码没有）· 新 · 显式（node，状态变了才发）· 内部 · 不删
```sql
CREATE TABLE nodes(
  device_id TEXT PRIMARY KEY,        -- = devices.id（role=node）；身份在 devices，这里只放状态
  os TEXT,
  version TEXT,                      -- 节点程序版本；太旧提示升级
  caps_json TEXT,                    -- 各适配器的能力 {<agent>: {steer, resume, rewind, permission, ask}}（0/1）
  agents_json TEXT,                  -- 本机有哪些 agent、版本
  quota_json TEXT,                   -- agent 报得出的剩余额度 {<agent>: {left, resets_at}}
  max_parallel INTEGER,              -- 我给这台设的同时数；NULL = 不限（D2）
  status TEXT NOT NULL DEFAULT 'offline', -- online|offline|draining|outdated
  status_at INTEGER,
  extra_json TEXT                    -- 原 edge_nodes：微信机的 wechat_version、logged_in
) STRICT, WITHOUT ROWID;
```

## 5 设备和连接

**devices**　新 · 新 · 显式（device；`last_seen` 不发）· 内部 · 不删（删设备 = 写 `removed_at`）
```sql
CREATE TABLE devices(
  id TEXT PRIMARY KEY,               -- hex(sha256(公钥 32 字节))，64 位；界面显示前 8 位，命令接受 ≥ 6 位的唯一前缀
  public_key BLOB NOT NULL UNIQUE,   -- Ed25519 公钥 32 字节（取代设计稿的 ECDSA P-256，技术设计定）
  name TEXT NOT NULL,                -- 设备自称，界面标明
  platform TEXT,                     -- android|macos|windows|linux|ios
  role TEXT NOT NULL,                -- client|node
  version TEXT,                      -- 连上时报的 App / 节点程序版本
  push_token TEXT,                   -- FCM 令牌；删设备时清空
  invite_id INTEGER,                 -- 用哪张邀请配上的
  created_at INTEGER NOT NULL,
  last_seen INTEGER,
  last_ip_masked TEXT,               -- IPv4 /24、IPv6 /48，如 203.0.113.0/24
  removed_at INTEGER, removed_by TEXT -- device:<id> | cli | <渠道>
) STRICT, WITHOUT ROWID;
```
- 删设备：在同一个事务里做这几件事：
  - 写 `removed_at`、清 `push_token`；
  - 它在 inbox 里 `received` 的行改 `dropped`；
  - 它 `running` 的 runs 标停（进程里当场断通道、停 run）；
  - 写一行 `device_audit`。
- 删了不复用：客户端每次配对都新生成密钥，所以同一把公钥再来只能是重放，拒绝并记 `pair_failed`。

**device_invites**　新 · 新 · 无 · 内部 · ※ 过期 30 天后删（配对记录在 device_audit）
```sql
CREATE TABLE device_invites(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  secret_hash BLOB NOT NULL UNIQUE,  -- sha256(一次性密钥)；明文只在配对码里（链接 # 后）
  role TEXT NOT NULL,                -- client|node
  created_by TEXT NOT NULL,          -- cli | device:<id> | <渠道>
  created_at INTEGER NOT NULL,
  expires INTEGER NOT NULL,          -- created_at + 10 分钟
  used_at INTEGER, used_by TEXT      -- 配上的 devices.id；用一次就失效
) STRICT;
```

**device_audit**　新 · 新 · 无 · 内部 · 不删
```sql
CREATE TABLE device_audit(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  device_id TEXT,                    -- 对象设备；邀请阶段为 NULL
  action TEXT NOT NULL,              -- invite|pair|pair_failed|challenge_failed|rename|remove|new_ip|token_set|token_cleared
  actor TEXT,                        -- cli | device:<id> | <渠道> | code
  ip_masked TEXT,
  detail TEXT
) STRICT;
CREATE INDEX device_audit_dev ON device_audit(device_id, ts);
CREATE INDEX device_audit_ip ON device_audit(ip_masked);
```
- 每次连上不记（手机切后台会频繁重连），只更新 `devices.last_seen`。
- 「从没见过的 IP 段」= `device_audit` 里没有这个 `ip_masked`。这时记 `new_ip` 并通知（§触6.7）。

## 6 客户端

**threads**　新 · 新 · 有（thread）· 按行（domain）· 不删
```sql
CREATE TABLE threads(
  id TEXT PRIMARY KEY,               -- th_<ms36><4hex>
  lane TEXT NOT NULL UNIQUE,         -- console:main | console:t:<id> | task:<task_id> | feishu:dm:owner | feishu:wb:<thread>
  kind TEXT NOT NULL,                -- general|matter|task|feishu
  domain TEXT NOT NULL,              -- work|personal；console:main 恒为 personal
  title TEXT,
  matter_id INTEGER, task_id TEXT,
  status TEXT NOT NULL DEFAULT 'open', -- open|archived（我收起的，不删）
  pinned INTEGER NOT NULL DEFAULT 0,
  created_by_device TEXT,
  created_at INTEGER NOT NULL,
  last_item_at INTEGER               -- 进输入、run 结束时更新，不按每个 item 更新
) STRICT;
CREATE INDEX threads_list ON threads(status, pinned, last_item_at);
```
- 按主线分组在读取时沿 `matters.parent_id`、`merged_into` 算，不存（§触6.5）。

**client_ops**　新 · 新 · 无 · 内部 · ※ 30 天（按 ts 清）
```sql
CREATE TABLE client_ops(
  device_id TEXT NOT NULL,
  client_op_id TEXT NOT NULL,        -- 客户端生成（≤ 64 字符）；节点来的写入是 <task_id>:<attempt>:<tool_call_id>
  op TEXT NOT NULL,                  -- 动作名，排错用
  result_json TEXT NOT NULL,         -- 原样回给重试
  seq INTEGER,                       -- 这次写入后的 change_log 序号（响应里带，§触6.4）；没写出事件为 NULL
  ts INTEGER NOT NULL,
  PRIMARY KEY(device_id, client_op_id)
) STRICT, WITHOUT ROWID;
CREATE INDEX client_ops_ts ON client_ops(ts);
```
- 和业务写入同一个事务。`seq` 在事务内取 `SELECT seq FROM sqlite_sequence WHERE name='change_log'`。
- ※ 留 30 天。理由：重试一般在几秒到几分钟内，手机关机几周后再补发也能认出来；节点那边晚到的写入本来就按 attempt 丢。
- 发消息不走这张表，用 `inbox` 的 `UNIQUE(source, source_msg_id)`（§触6.4）。

**change_log**　新 · 新 · —（它就是事件表）· 内部 · 7 天
```sql
CREATE TABLE change_log(
  seq INTEGER PRIMARY KEY AUTOINCREMENT, -- AUTOINCREMENT：清掉旧行后 seq 也不复用
  ts INTEGER NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER)),
  entity TEXT NOT NULL,              -- 见 §10 覆盖表
  ref TEXT NOT NULL,                 -- 实体 id，一律存文本
  op TEXT NOT NULL                   -- upsert|delete
) STRICT;
CREATE INDEX change_log_ts ON change_log(ts);
```
- 只记「谁变了」，不存内容。pump 怎么读、合并、过滤、心跳见 §触6.4。

## 7 读

**messages**　旧 messages · 重读 · 无 · 按行（domain）· 不删
```sql
CREATE TABLE messages(
  rid INTEGER PRIMARY KEY,           -- FTS 的 rowid；显式声明，VACUUM 不改它
  id TEXT NOT NULL UNIQUE,           -- 渠道消息 id；自己生成的带前缀 card:|outbox:|src:<源>:|console:<device>:<op>
  surface TEXT,                      -- feishu:dm|feishu:p2p|feishu:group|feishu:workbench|console|source:<id>|…
  chat_id TEXT, thread_id TEXT, sender_id TEXT,
  sender_kind TEXT,                  -- owner|other|bot（发出去的回写 sender_id = owner-via-sbot | sbot）
  ts INTEGER NOT NULL,
  text TEXT,
  media_ref TEXT,                    -- 附件 raw:<sha>
  raw_json TEXT,                     -- 渠道附加字段 {message_type, root_id, …}，不是原始包
  domain TEXT,                       -- work|personal：写入时按 lane 对应的 thread 定，群和工作台恒为 work；§读5.1 过滤用
  lane TEXT,
  triage_status TEXT,                -- pending|done|skipped
  triage_action TEXT,                -- ignore|archive|notify|draft|escalate
  triage_note TEXT,
  event_id INTEGER,
  attn TEXT,                         -- waiting|answered|read|held；NULL = 不在等（§读2.4）
  wait_until INTEGER
) STRICT;
CREATE INDEX messages_lane_ts ON messages(lane, ts);
CREATE INDEX messages_chat_ts ON messages(chat_id, ts);
CREATE INDEX messages_attn ON messages(attn, wait_until);
CREATE INDEX messages_triage ON messages(ts) WHERE triage_status = 'pending';

CREATE VIRTUAL TABLE messages_fts USING fts5(text, content='messages', content_rowid='rid', tokenize='trigram');
CREATE TRIGGER messages_fts_i AFTER INSERT ON messages BEGIN
  INSERT INTO messages_fts(rowid, text) VALUES (NEW.rid, NEW.text); END;
CREATE TRIGGER messages_fts_d AFTER DELETE ON messages BEGIN
  INSERT INTO messages_fts(messages_fts, rowid, text) VALUES ('delete', OLD.rid, OLD.text); END;
CREATE TRIGGER messages_fts_u AFTER UPDATE OF text ON messages BEGIN
  INSERT INTO messages_fts(messages_fts, rowid, text) VALUES ('delete', OLD.rid, OLD.text);
  INSERT INTO messages_fts(rowid, text) VALUES (NEW.rid, NEW.text); END;
```
- **messages_fts**　新（设计要，代码没建）· 重算（`INSERT INTO messages_fts(messages_fts) VALUES('rebuild')`）· 无 · 同 messages · 跟 messages。
- 检索不过滤沉降（§寸4），所有消息都进索引。
- trigram 查不了不到 3 个字的词：两个字的中文词查不到。不足 3 个字时回退成 `text LIKE '%…%'`，按时间窗扫表。`pages_fts` 也一样。

**chat_cursors**　旧 chat_cursors · 重算（重读时写）· 无 · 内部 · 不删
```sql
CREATE TABLE chat_cursors(
  chat_id TEXT NOT NULL, surface TEXT NOT NULL,
  last_msg_ts INTEGER, last_msg_id TEXT, updated_at INTEGER,
  PRIMARY KEY(chat_id, surface)
) STRICT, WITHOUT ROWID;
```

**chats**　旧 chats · 重读 · 无 · work · 不删
```sql
CREATE TABLE chats(
  chat_id TEXT PRIMARY KEY,          -- 渠道原生 id；非飞书加 <渠道>: 前缀
  channel TEXT NOT NULL DEFAULT 'feishu',
  name TEXT,
  external INTEGER NOT NULL DEFAULT 0,
  muted INTEGER NOT NULL DEFAULT 0,
  chat_mode TEXT,
  seen_at INTEGER
) STRICT, WITHOUT ROWID;
```
- `groups.yaml` 才是真相源（§触2.5），这张表只缓存渠道给的群信息。

**events**　旧 events · 重读 · 有（event）· 按行（domain）· 不删
```sql
CREATE TABLE events(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  source TEXT NOT NULL, ref TEXT NOT NULL, -- 来源和它那边的 id；import 的 ref = <import_id>:<n>
  place TEXT, place_id TEXT, actor TEXT,
  kind TEXT NOT NULL,                -- ask|decision|commitment|progress|risk|deadline|info
  level TEXT NOT NULL,               -- fyi|watch|reply|decide
  summary TEXT NOT NULL,
  link TEXT,
  domain TEXT,                       -- work|personal
  matter_id INTEGER, topic TEXT,
  state TEXT NOT NULL,               -- open|done|dropped|seen
  done_at INTEGER,
  done_by TEXT,                      -- replied|approved|rejected|owner|owner@console|import
  msg_ids_json TEXT,                 -- ["om_…", …]
  created_at INTEGER,
  UNIQUE(source, ref)
) STRICT;
CREATE INDEX events_matter ON events(matter_id, ts);
CREATE INDEX events_topic ON events(topic, ts);
CREATE INDEX events_open ON events(state, level, ts);
CREATE INDEX events_place ON events(place_id, state);
```
- 身体、`self/`、命盘不进这张表（§读5.2）。
- 话头的沉降：`MAX(ts) WHERE topic=?` 早于 now − `settle.topic_days`。

**matters**　旧 matters · 重读（重跑分拣和归事）· 有（matter）· 按行（domain）· 不删
```sql
CREATE TABLE matters(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT,
  domain TEXT,                       -- work|personal
  lane TEXT,
  status TEXT NOT NULL DEFAULT 'open', -- open|active|paused|closing|reviewed|done|dropped|merged
  close_condition TEXT, file_path TEXT,
  keys_json TEXT,                    -- 话头、关键词 ["…"]
  parent_id INTEGER,                 -- 主线（只一层）
  merged_into INTEGER,
  paused_at INTEGER,                 -- 进「先搁着」的时刻（§寸5）
  last_activity_at INTEGER,          -- 最近一次动静；触发器维护（§10.3）
  opened_at INTEGER, closed_at INTEGER, reviewed_at INTEGER
) STRICT;
CREATE INDEX matters_parent ON matters(parent_id);
CREATE INDEX matters_active ON matters(status, last_activity_at);
```
- ※ 沉降层（§寸4）和浮出（§寸5）按 `last_activity_at` 算，不另存：
  ```sql
  -- :quiet = now − measure.settle.matter_quiet_days
  SELECT id FROM matters
   WHERE status IN ('closing','reviewed','done','dropped','merged')
      OR COALESCE(last_activity_at, opened_at) < :quiet;
  -- 先搁着的事有新动静（浮出）：status='paused' AND last_activity_at > paused_at
  ```
  - 「动静」= 挂到这件事上的事件、任务（建立和状态变化）、follow-up 到点、审批、随手记、我改状态；子事有动静，主线也算。
  - 每日整理和 matter_ops 不算动静，免得整理把一件放下的事又翻回活跃。
  - `closing` 算沉降，它的事收复盘照走 `review_open`，不受影响。

**matter_ops**　旧 matter_ops · 重读 · 有（matter_op）· 按事的 domain · 不删
```sql
CREATE TABLE matter_ops(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  kind TEXT NOT NULL,                -- merge|attach|main|detach|status|event|move|topic|rename
  summary TEXT, why TEXT,
  by TEXT NOT NULL,
  review_id INTEGER,
  touches_json TEXT NOT NULL DEFAULT '[]', -- ["m12","e88"]
  undo_json TEXT,                    -- 撤销要怎么还原
  undone_at INTEGER, undone_by TEXT
) STRICT;
```

**matter_reviews**　旧 matter_reviews · 清零（每日整理重新出）· 显式（tidy）· 按事的 domain · 不删
```sql
CREATE TABLE matter_reviews(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  fp TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL,                -- group|stale|old_ask|suspect|topic
  prio INTEGER NOT NULL DEFAULT 0,
  why TEXT,
  data_json TEXT NOT NULL,
  origin TEXT NOT NULL DEFAULT 'code', -- code|model
  status TEXT NOT NULL DEFAULT 'pending', -- pending|shown|acted|ok|void
  shown_n INTEGER NOT NULL DEFAULT 0, last_shown INTEGER,
  snooze_until INTEGER,
  created_at INTEGER, decided_at INTEGER, decided_by TEXT,
  action TEXT, op_id INTEGER
) STRICT;
CREATE INDEX matter_reviews_status ON matter_reviews(status, snooze_until);
```
- `paused` 的事不出 `stale`（§寸5）。

**persons**　旧 persons · 重算 · 无 · 按行（circle：工作圈 work，家人朋友 personal）· 不删
```sql
CREATE TABLE persons(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL, slug TEXT, config_key TEXT, circle TEXT, note TEXT,
  first_seen INTEGER,
  first_via_json TEXT,               -- 第一次在哪见到 {kind, ref, …}
  last_seen INTEGER, cluster INTEGER,
  status TEXT NOT NULL DEFAULT 'active', -- active|hidden|merged
  merged_into INTEGER,
  created_at INTEGER
) STRICT;
```

**person_aliases**　旧 person_aliases · 重算 · 无 · 同 persons · 不删
```sql
CREATE TABLE person_aliases(
  kind TEXT NOT NULL, alias TEXT NOT NULL, person_id INTEGER NOT NULL,
  src TEXT, ts INTEGER,
  PRIMARY KEY(kind, alias, person_id)
) STRICT, WITHOUT ROWID;
CREATE INDEX person_aliases_p ON person_aliases(person_id);
```

**relations**　旧 relations · 重算 · 无 · 同 persons · 不删
```sql
CREATE TABLE relations(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  a INTEGER NOT NULL, b INTEGER NOT NULL,
  rel TEXT NOT NULL,
  conf TEXT NOT NULL,                -- EXTRACTED|INFERRED
  src TEXT,
  evidence TEXT,                     -- 一句话出处（≤ 300 字，照代码）
  ts INTEGER,
  status TEXT NOT NULL DEFAULT 'active' -- active|dropped
) STRICT;
```

**graph_nodes**　旧 graph_nodes · 重算（整表重建）· 无 · work · 派生，随重建
```sql
CREATE TABLE graph_nodes(
  id TEXT PRIMARY KEY,               -- me | p:<id> | m:<id> | c:<chat_id> | g:<path> | r:<sha>
  kind TEXT NOT NULL, label TEXT, ts INTEGER
) STRICT, WITHOUT ROWID;
```

**graph_edges**　旧 graph_edges · 重算（整表重建）· 无 · work · 派生，随重建
```sql
CREATE TABLE graph_edges(
  a TEXT NOT NULL, b TEXT NOT NULL,
  rel TEXT NOT NULL,                 -- talks|in|dm|matter|at|link|mentions|key|source|rel
  conf TEXT NOT NULL,
  weight REAL NOT NULL,
  first_ts INTEGER, last_ts INTEGER,
  evidence_json TEXT,
  PRIMARY KEY(a, b, rel)
) STRICT, WITHOUT ROWID;
CREATE INDEX graph_edges_b ON graph_edges(b);
```
- `self/`、身体、`crosschecks`、命盘和解读不进图（§读4.4）。

**raw_sources**　§底5 草案（代码没有）· 重算（扫 `raw/sha256/`）· 无 · 按行（visibility）· 不删
```sql
CREATE TABLE raw_sources(
  sha256 TEXT PRIMARY KEY,           -- 文件在 raw/sha256/<前两位>/<sha256>
  mime TEXT,
  bytes INTEGER NOT NULL,
  title TEXT, origin_url TEXT,
  src TEXT,                          -- 来源标签：owner@<渠道> | import | source:<id> | …
  visibility TEXT NOT NULL DEFAULT 'owner', -- owner|work|shared（同 pages）
  received_at INTEGER NOT NULL,
  inbox_id INTEGER,
  ingested_at INTEGER,
  pages_json TEXT                    -- 这份资料动过哪些页 ["sources/x.md", …]
) STRICT, WITHOUT ROWID;
```
- 重建时：`mime` 从文件头判断，`received_at` 取文件 mtime，`title` 留空，`visibility` 先给最窄的 `owner`。
- `sources/` 页会把它们链回来，那时再补 `title`、`pages_json`。

**pages**　旧 pages（`wiki.ts`）· 重算（扫 agent-home）· 无 · 按行（visibility）· 派生
```sql
CREATE TABLE pages(
  path TEXT PRIMARY KEY,
  mtime INTEGER, title TEXT, summary TEXT,
  visibility TEXT,                   -- owner|work|shared（visibilityOf；frontmatter 只能收窄）
  bytes INTEGER
) STRICT, WITHOUT ROWID;
CREATE VIRTUAL TABLE pages_fts USING fts5(path UNINDEXED, title, body, visibility UNINDEXED, tokenize='trigram');
```
- **pages_fts**　旧 pages_fts · 重算 · 无 · 按行 · 派生。

**imports**　旧 imports · 重读（旧库里 `applied` 的行，按 raw 里的原件重新应用；`undone` 的跳过）· 无 · 按事的 domain · 不删
```sql
CREATE TABLE imports(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER,
  origin TEXT, sha TEXT,
  raw_ref TEXT,                      -- raw:<sha>（旧 raw_path）
  summary_json TEXT,
  commit_sha TEXT,
  status TEXT NOT NULL DEFAULT 'applied' -- applying|applied|failed|undone（照代码）
) STRICT;
```
- 撤销 = 删 `events WHERE source='import' AND ref LIKE '<id>:%'`，照旧。

## 8 参觉改

这一节的表都是 `owner` 级，只在我的会话和客户端的生活区（§读5.1）。写入都在 ledgers / lens 一处，所以都用显式事件。

**readings**　旧 readings · 清零 · 显式（reading）· owner · 不删
```sql
CREATE TABLE readings(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  lens TEXT NOT NULL,                -- LENSES 里的 id | agent（只看事实的一面）
  method TEXT,                       -- 起局方法（CAST_METHODS）
  profile_version TEXT,              -- 生辰和门派的版本
  question TEXT,
  horizon TEXT,                      -- day|week|month|matter
  period TEXT,
  matter_id INTEGER, outlook_id INTEGER,
  reading TEXT,                      -- 看法正文
  notice_json TEXT,                  -- ["留意…"]（1–3 条）
  claims_json TEXT,                  -- [{claim, revisit_at: "2026-12-01", look_for}]
  chart_ref TEXT,                    -- 盘面 blob:
  frozen_hash TEXT,                  -- done 时 sha256(reading‖notice_json‖claims_json‖chart_ref)；之后只追加 reading_revisits
  status TEXT NOT NULL DEFAULT 'queued', -- queued|running|done|failed
  error TEXT,
  retries INTEGER NOT NULL DEFAULT 0,
  not_before INTEGER,
  run_id TEXT, origin_lane TEXT, origin_turn_json TEXT,
  requested_by TEXT,                 -- job|owner|agent
  done_at INTEGER
) STRICT;
CREATE INDEX readings_period ON readings(horizon, period);
```

**reading_revisits**　旧 reading_revisits · 清零 · 显式（reading，ref = reading_id）· owner · 不删
```sql
CREATE TABLE reading_revisits(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  reading_id INTEGER NOT NULL,
  claim_idx INTEGER,                 -- claims_json 里第几条；NULL = 整条解读
  ts INTEGER,
  text TEXT,                         -- 我的原话
  feeling TEXT,                      -- resonant|neutral|not_yet（以原话为准）
  src TEXT, run_id TEXT
) STRICT;
CREATE INDEX reading_revisits_r ON reading_revisits(reading_id, ts);
```

**crosschecks**　§底5 草案（代码没有）· 清零（新）· 显式（crosscheck）· owner · 不删
```sql
CREATE TABLE crosschecks(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  kind TEXT NOT NULL,                -- matter|outlook|review|habit|relation|body|ad_hoc
  matter_id INTEGER, outlook_id INTEGER, person_id INTEGER,
  question TEXT,
  prompt_version TEXT,               -- 互参方法的版本
  sources_json TEXT NOT NULL DEFAULT '[]', -- 实际用到的视角和出处 [{slot: facts|lens|body|others|mine, refs: […]}]
  reading_ids_json TEXT,             -- [12, 15]
  agreements TEXT, divergences TEXT, blind_spots TEXT, suggestion TEXT,
  disputes_json TEXT,                -- 取信（§参2）：说不清的 [{a: {ref, date}, b: {ref, date}}]
  frozen_hash TEXT NOT NULL,         -- 写入即冻结：sha256(上面这些)
  status TEXT NOT NULL DEFAULT 'done', -- done|revisited
  feeling TEXT,                      -- resonant|neutral|not_yet
  owner_words TEXT,
  revisited_at INTEGER,
  run_id TEXT
) STRICT;
CREATE INDEX crosschecks_matter ON crosschecks(matter_id, ts);
```
- 冻结之后只改 `feeling`、`owner_words`、`revisited_at`、`status`。
- 有争议的条目后来有了新证据、收了：另写一条 crosscheck，`sources_json` 里引用 `crosscheck:<id>`，不改旧的冻结内容。

**outlooks**　旧 outlooks · 清零 · 显式（outlook）· owner · 不删
```sql
CREATE TABLE outlooks(
  id INTEGER PRIMARY KEY AUTOINCREMENT, -- 一行一条前瞻条目（照代码）
  horizon TEXT NOT NULL,             -- day|week|month|matter
  period TEXT NOT NULL,
  lane TEXT,                         -- 发到哪条 lane
  parent_id INTEGER,                 -- 它细化的上一级条目（周 → 月）
  text TEXT NOT NULL,
  why_refs_json TEXT,                -- ["reading:12", "review:3"]
  look_for TEXT,
  revisit_at TEXT,                   -- 本地日期
  reading_ids_json TEXT,
  frozen_hash TEXT,                  -- 写入即冻结；回看进 outlook_revisits
  status TEXT NOT NULL DEFAULT 'sent', -- drafted|sent|discussed|revisited
  matter_id INTEGER, run_id TEXT,
  ts INTEGER NOT NULL
) STRICT;
CREATE INDEX outlooks_period ON outlooks(horizon, period);
```

**outlook_revisits**　旧 outlook_revisits · 清零 · 显式（outlook，ref = outlook_id）· owner · 不删
```sql
CREATE TABLE outlook_revisits(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  outlook_id INTEGER NOT NULL,
  ts INTEGER,
  text TEXT,                         -- 我的原话
  feeling TEXT,                      -- resonant|neutral|not_yet
  src TEXT, run_id TEXT
) STRICT;
CREATE INDEX outlook_revisits_o ON outlook_revisits(outlook_id, ts);
```

**reviews**　旧 reviews · 清零 · 显式（review）· owner · 不删
```sql
CREATE TABLE reviews(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL,                -- day|week|month|matter（照代码）
  period TEXT NOT NULL,
  matter_id INTEGER,
  facts TEXT,                        -- 事实初稿
  owner_words_json TEXT,             -- 我的原话 ["…"]
  agent_notes TEXT,
  status TEXT NOT NULL,              -- chatted|unchatted（unchatted 由代码写，§觉4）
  delivery TEXT,                     -- sent|replied|not_sent
  file_path TEXT, run_id TEXT,
  ts INTEGER
) STRICT;
CREATE INDEX reviews_period ON reviews(kind, period);
```

**review_open**　旧 review_open · 清零 · 无 · owner · 落档后删（照代码）
```sql
CREATE TABLE review_open(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL, period TEXT NOT NULL,
  facts TEXT,
  fired_at INTEGER,
  deadline INTEGER NOT NULL,         -- 到点还没落档，代码写 reviews(status=unchatted)
  inbox_key TEXT, run_id TEXT,
  UNIQUE(kind, period)
) STRICT;
```

**self_items**　旧 self_items · 清零 · 显式（self_item）· owner · 不删
```sql
CREATE TABLE self_items(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL,                -- habit|rhythm
  side TEXT,                         -- drain（耗）|nourish（养）
  text TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'candidate', -- candidate|endorsed|seeing_off|faded|let_go|dropped
  evidence_json TEXT,                -- ["msg:…", "review:3", …]；推断的至少来自 infer_min_convs 场对话
  owner_said INTEGER NOT NULL DEFAULT 0, -- 1 = 我自己说出来的
  mismatch_json TEXT,                -- 对不上（§改1）：和哪几条认可过的矛盾 [12]
  first_seen INTEGER, last_seen INTEGER, updated_at INTEGER,
  note TEXT
) STRICT;
CREATE INDEX self_items_status ON self_items(kind, status);
```
- ※ `side` 为 NULL = dream 还没分出是耗还是养（没有旧行，新写入时 dream 拿不准才留空）。它照常走候选、认可，渲染在「未分」一组；切省心时不翻它，只翻认可过的养。
- `mismatch_json` 非 NULL 时引用跳过，下一次周或月复盘问。我答成范围后两条各自收窄，清空这一列。
- 「不再提」的候选进 `dismissals`。

**noticings**　旧 noticings · 清零（引用的 self_items 清零了）· 无 · owner · 不删
```sql
CREATE TABLE noticings(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER,
  item_id INTEGER, item_text TEXT,
  who TEXT NOT NULL,                 -- owner|agent：谁先看见
  prompted INTEGER NOT NULL DEFAULT 0, -- 1 = 它问了开放问题后我说的（算我先看见）
  echo INTEGER NOT NULL DEFAULT 0,   -- 1 = 它先提、我只附和、没新事实（review_submit 的标记）：不重置淡了的计时
  matter_id INTEGER,                 -- 它主动提苦事时带上（§寸5）
  quote TEXT,
  review_id INTEGER, run_id TEXT
) STRICT;
CREATE INDEX noticings_item ON noticings(item_id, ts);
CREATE INDEX noticings_matter ON noticings(matter_id, ts) WHERE matter_id IS NOT NULL;
```

**body_entries**　§底5 草案（代码没有）· 清零（新；体检原件在 `private/body/` 带过去，要时重新解析、我再确认）· 显式（body）· owner · 不删
```sql
CREATE TABLE body_entries(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  date TEXT NOT NULL,                -- 本地日期
  kind TEXT NOT NULL,                -- daily_summary|checkup|symptom|note
  summary TEXT NOT NULL,
  metrics_json TEXT,                 -- {sleep_min, steps, hr_rest, …} 或体检指标
  source TEXT NOT NULL,              -- owner_chat|upload|device_sync
  raw_ref TEXT,                      -- body:<相对路径>
  confirmed INTEGER NOT NULL DEFAULT 0, -- 体检解析经我确认后为 1，才写进 self/body/
  note TEXT
) STRICT;
CREATE INDEX body_entries_date ON body_entries(date, kind);
CREATE UNIQUE INDEX body_entries_sync ON body_entries(date) WHERE kind = 'daily_summary' AND source = 'device_sync';
```
- 不进 events、图谱、Triage（§读5.2）。

**life_notes**　旧 life_notes · 带过去（§14 第 2 条 ※）· 显式（note）· personal · 不删
```sql
CREATE TABLE life_notes(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER,
  text TEXT NOT NULL,
  domain TEXT,                       -- work|family|friends|body|mind（照代码）
  matter_id INTEGER,
  people_json TEXT,                  -- ["…"]（旧 people 是逗号串，搬时转）
  src TEXT                           -- owner@<渠道>
) STRICT;
CREATE INDEX life_notes_ts ON life_notes(ts);
```

## 9 改进

**signals**　旧 signals · 不搬 · 无 · 内部 · 不删
```sql
CREATE TABLE signals(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER,
  kind TEXT,                         -- draft_approved|draft_revised|draft_rejected|replied_myself|triage_missed|triage_noise|owner_correction|task_failed|task_redo|proactive_ignored|expert_revise|proposal_revised|proposal_rolled_back|reading_done|reading_revisit|review_question|task_reply|…
  role TEXT,
  run_id TEXT, approval_id INTEGER, task_id TEXT,
  value_json TEXT,
  src TEXT                           -- owner（只认我的行为）| model（dream 判断的，只当线索）
) STRICT;
CREATE INDEX signals_ts ON signals(ts);
```

**eval_cases**　旧 eval_cases · 清零 · 无 · 内部 · 不删
```sql
CREATE TABLE eval_cases(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL,                -- draft|triage
  ref TEXT NOT NULL UNIQUE,          -- appr:<id> | …
  input_ref TEXT NOT NULL,           -- 当时的输入快照 blob:（起草类和 runs.input_ref 是同一个 blob）
  expected TEXT NOT NULL,            -- 我最终发出的版本 / 从我的反应推出的标签
  meta_json TEXT,                    -- 版本、来源 run 等
  src TEXT,                          -- 只收 owner
  ts INTEGER
) STRICT;
```
- 由代码自动攒，agent 不能增删改（§进2.4）。runs 的快照满 1 年会解除引用，但评测题还引用着同一个 blob，所以不会被 GC 掉。

**proposals**　旧 proposals · 清零（引用旧的 tuning 版本和审批 id）· 显式（proposal）· 按 route · 不删
```sql
CREATE TABLE proposals(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER,
  run_id TEXT,
  tier TEXT NOT NULL DEFAULT 'B',    -- B|C（A 级不走提案，见 learned_items）
  target TEXT NOT NULL,              -- B：TUNABLE 里的文件；C：代码区域（模块、工具名）。和待批卡去重按它
  route TEXT,                        -- owner（复盘、前瞻、互参方法 → 私聊和控制台）| admin（其余）
  problem TEXT, hypothesis TEXT, change TEXT,
  evidence_json TEXT NOT NULL,       -- 案例 id ["a12", "c3"]（≥ 2）
  held_json TEXT,                    -- status=held：两边出处 {said: […], used: […]}（§进3.1）
  old_ref TEXT, new_ref TEXT,        -- B：改前改后的整份文件 blob:；C 为 NULL（不给 patch）
  old_version TEXT, new_version TEXT,
  replay_json TEXT,                  -- 回放评测的新旧对比、预计成本变化
  status TEXT NOT NULL DEFAULT 'proposed', -- proposed|held|approved|live|kept|rolled_back|rejected|expired|superseded|conflict
  approval_id INTEGER, decide_note TEXT,
  task_id TEXT, pr_url TEXT,         -- C：批了派出去的任务、它开的 PR
  applied_at INTEGER,
  applied_sha TEXT,                  -- B：tuning 提交；C：合进去的提交
  review_due INTEGER, review_json TEXT, -- 上线两周后回看
  rollback_approval_id INTEGER,
  rollback_of INTEGER
) STRICT;
CREATE INDEX proposals_status ON proposals(status, review_due);
CREATE INDEX proposals_target ON proposals(target, status);
```
- 状态：`proposed` → `approved`（C 级 PR 还没合）→ `live`（上线、两周回看中）→ `kept` 或 `rolled_back`。旁路是 `held`（对不上，挂起等复盘问）、`rejected`、`expired`（72 小时）、`superseded`、`conflict`（两张卡改同一文件，后批的）。
- **默认状态用 `proposed`，不用 §底5 的 `pending`**。理由：
  - 卡片本身的状态在 `approvals`（kind=proposal），那里已经用 `pending`。两张表 join 时，同一个词指两样东西容易看错。
  - 代码和测试已经在用 `proposed`。
  - 数据清零，选哪个都不用迁。
- 被拒的进 `dismissals`（kind=proposal），不再有 8 周冷却（§进3.3）。

**learned_items**　新 · 新 · 显式（learned）· 按行（visibility）· 不删
```sql
CREATE TABLE learned_items(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL,                -- insight（心得）|style（风格笔记）|reminder_pref（提醒偏好）|example（范例库）|memory_edit（dream 改的记忆）
  scope TEXT,                        -- insight：lens:<lens> | crosscheck | guidance；style、example：person:<id> | scene:<名>
  text TEXT NOT NULL,                -- 条目正文；example 是批准过的最终版本；memory_edit 是改了哪一行
  src_json TEXT NOT NULL,            -- 出处 ["approval:12", "review:3", "reading:7"]
  ref TEXT,                          -- 外部对象：memory_edit → home:<path>@<commit>；example → approval:<id>
  visibility TEXT NOT NULL DEFAULT 'owner', -- owner|work|shared（同 pages；self/ 下的只在生活区）
  status TEXT NOT NULL DEFAULT 'live', -- live|vetoed|superseded
  effective_at INTEGER NOT NULL,     -- 生效时间
  vetoed_at INTEGER,
  veto_ref TEXT,                     -- dismissal:<id>
  created_at INTEGER NOT NULL, updated_at INTEGER
) STRICT;
CREATE INDEX learned_items_kind ON learned_items(kind, status);
```
- 看里「学到的」= 这张表 ∪ `proposals` 里 `status IN ('live','kept')` 的行。※ 上线中的 B、C 级改动不复制进来：proposals 已经逐条存、带出处和状态，复制一份两边状态会对不上。
- 否掉一条：
  - `insight`、`style`、`reminder_pref`、`memory_edit`：走 `forget`，进 `.archive/`；
  - `example`：撤下；
  - B 级改动回滚，C 级派节点 agent 开 revert PR。
  - 不管哪种，都写 `dismissals`（kind=learned），并回填 `veto_ref`。
- `.md`（lens-notes、guidance-notes、风格笔记）是从这张表渲染出来的视图（§进2.3）。

**dismissals**　新（三套「不再提」合并）· 清零 · 无 · 按 kind（习气候选 owner，其余跟原条目）· 不删（不设期限）
```sql
CREATE TABLE dismissals(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  kind TEXT NOT NULL,                -- suggestion|outlook_item|tidy|self_candidate|proposal|learned
  fp TEXT NOT NULL,                  -- 指纹：各模块按「同一件事、链接或标题」规范化后算；proposal 用 target + 问题
  text TEXT NOT NULL,                -- 被挡的原文；换了说法时给 light 档比对
  ref TEXT,                          -- 原条目 suggestion:5 | proposal:12 | self_item:9 | learned:3 | matter_review:<fp> | outlook:7
  reason TEXT,                       -- 我的原话或拒绝理由
  src TEXT,                          -- 在哪说的：msg:<id> | approval:<id> | device:<id>
  status TEXT NOT NULL DEFAULT 'active', -- active（挡；有新证据可重提一次）|reraised（已重提，等我）|final（再被驳，永久挡）|lifted（我说恢复）
  reraised_at INTEGER,
  reraise_ref TEXT,                  -- 重提的那条
  UNIQUE(kind, fp)
) STRICT;
CREATE INDEX dismissals_recent ON dismissals(kind, ts);
```
- 同一指纹代码挡（§寸1）。
- 换了说法的：出建议前取同一 kind 最近 `measure.dismiss_window` 条，给 light 档比一遍。
- 重提时，卡上先写 `reason` 和这次的新证据。

**config_changes**　旧 config_changes · 不搬（config 仓库从 seed 重建，历史从头记）· 有（config）· 内部 · 不删
```sql
CREATE TABLE config_changes(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER,
  file TEXT,
  diff TEXT,                         -- secrets.env 只记 "added NAME" / "updated NAME"；self.yaml 只说改了（不进群）
  source TEXT,                       -- console|chat|card|command|upgrade|proposal|manual
  actor TEXT                         -- device:<id> | <渠道> | run:<id>
) STRICT;
```

## 10 change_log 触发器

pump 怎么读、合并、按角色过滤、心跳、发 `reset`，都见 §触6.4，这里不重复。这里只定哪张表怎么写进 `change_log`。

### 10.1 覆盖

用哪种方式：
- 写入点分散、或写得频的表用触发器，漏发的风险在这些表上。
- 只有一个模块写的低频表，由那个模块在同一个事务里显式 `emit(entity, ref, op)`，也就是一句 `INSERT INTO change_log`。效果和触发器一样：同事务，回滚就没有。

| 表 | entity | 方式 | 理由 |
|---|---|---|---|
| inbox | input | 触发器 | 渠道、定时、任务、审批、客户端都写 |
| runs | run | 触发器 | 派发、任务、恢复都写 |
| run_items | item | 触发器 | 最频；runner 和节点回传两处写 |
| approvals | approval | 触发器 | 工具、卡片回调、客户端、过期扫描、作废都写 |
| outbox（status 变，approval_id 非空） | approval | 触发器 | 卡上要看到「已发出 / 失败」，跨实体，容易忘 |
| tasks（不含 `last_output_at`） | task | 触发器 | 工具、节点回传、客户端、timers 都写；回传时间太频，靠 item 事件 |
| events | event | 触发器 | 分拣、回复检测、审批收尾、导入都写 |
| matters | matter | 触发器 | 工具、整理、ops、动静触发器都写 |
| matter_ops | matter_op | 触发器 | 撤销列表要实时 |
| timers（kind=followup） | timer | 触发器 | 工具、调度器、客户端都写；schedule、task 两类是内部的 |
| threads | thread | 触发器 | 客户端、run、任务、事都会建或改 |
| config_changes | config | 触发器 | §触6.4 点了名；行里只有名字和 diff，没有密钥值 |
| devices | device | 显式 | 只有 link 写；`last_seen` 不发 |
| nodes | node | 显式 | 只有 nodes 模块写；状态变了才发，心跳不发 |
| task_sessions、worktrees、task_prs | task（ref = task_id） | 显式 | 只有 tasks 模块写 |
| reads | read | 显式 | 只有 push 写 |
| kv `ease` | ease | 显式 | 只有 push 写（W3） |
| push_queue | 被推条目的 entity | 显式 | 暂缓要让别的设备收起那张卡 |
| suggestions | suggestion | 显式 | 只有 ledgers 写 |
| matter_reviews | tidy | 显式 | 只有每日整理写 |
| learned_items | learned | 显式 | dream、improve、否掉都经同一个函数 |
| proposals | proposal | 显式 | 只有 improve 写 |
| readings / reading_revisits | reading | 显式 | 只有 lens 写 |
| crosschecks、outlooks（含 revisits）、reviews、self_items、body_entries、life_notes | crosscheck、outlook、review、self_item、body、note | 显式 | 只有 ledgers 写；全是 owner 或 personal 级 |
| 其余 | — | 不发 | 客户端按需拉（用量、人、图谱、信号、节点上的会话），或者纯内部 |

### 10.2 触发器（全部）

```sql
CREATE TRIGGER cl_inbox_i AFTER INSERT ON inbox BEGIN INSERT INTO change_log(entity, ref, op) VALUES ('input', NEW.id, 'upsert'); END;
CREATE TRIGGER cl_inbox_u AFTER UPDATE OF status, run_id ON inbox BEGIN INSERT INTO change_log(entity, ref, op) VALUES ('input', NEW.id, 'upsert'); END;
CREATE TRIGGER cl_inbox_d AFTER DELETE ON inbox BEGIN INSERT INTO change_log(entity, ref, op) VALUES ('input', OLD.id, 'delete'); END;

CREATE TRIGGER cl_runs_i AFTER INSERT ON runs BEGIN INSERT INTO change_log(entity, ref, op) VALUES ('run', NEW.id, 'upsert'); END;
CREATE TRIGGER cl_runs_u AFTER UPDATE ON runs BEGIN INSERT INTO change_log(entity, ref, op) VALUES ('run', NEW.id, 'upsert'); END;

CREATE TRIGGER cl_items_i AFTER INSERT ON run_items BEGIN INSERT INTO change_log(entity, ref, op) VALUES ('item', NEW.id, 'upsert'); END;
CREATE TRIGGER cl_items_u AFTER UPDATE OF status, ended, body_json, body_ref, truncated ON run_items BEGIN INSERT INTO change_log(entity, ref, op) VALUES ('item', NEW.id, 'upsert'); END;

CREATE TRIGGER cl_appr_i AFTER INSERT ON approvals BEGIN INSERT INTO change_log(entity, ref, op) VALUES ('approval', NEW.id, 'upsert'); END;
CREATE TRIGGER cl_appr_u AFTER UPDATE ON approvals BEGIN INSERT INTO change_log(entity, ref, op) VALUES ('approval', NEW.id, 'upsert'); END;
CREATE TRIGGER cl_outbox_u AFTER UPDATE OF status ON outbox WHEN NEW.approval_id IS NOT NULL BEGIN
  INSERT INTO change_log(entity, ref, op) VALUES ('approval', NEW.approval_id, 'upsert'); END;

CREATE TRIGGER cl_tasks_i AFTER INSERT ON tasks BEGIN INSERT INTO change_log(entity, ref, op) VALUES ('task', NEW.id, 'upsert'); END;
CREATE TRIGGER cl_tasks_u AFTER UPDATE OF status, node, agent, session_ref, attempt, turn, workdir, quota_until,
  result_json, diff_ref, error, matter_id, mirrors_json, started, ended ON tasks BEGIN
  INSERT INTO change_log(entity, ref, op) VALUES ('task', NEW.id, 'upsert'); END;

CREATE TRIGGER cl_events_i AFTER INSERT ON events BEGIN INSERT INTO change_log(entity, ref, op) VALUES ('event', NEW.id, 'upsert'); END;
CREATE TRIGGER cl_events_u AFTER UPDATE OF kind, level, summary, link, domain, matter_id, topic, state, done_at, done_by ON events BEGIN
  INSERT INTO change_log(entity, ref, op) VALUES ('event', NEW.id, 'upsert'); END;
CREATE TRIGGER cl_events_d AFTER DELETE ON events BEGIN INSERT INTO change_log(entity, ref, op) VALUES ('event', OLD.id, 'delete'); END;

CREATE TRIGGER cl_matters_i AFTER INSERT ON matters BEGIN INSERT INTO change_log(entity, ref, op) VALUES ('matter', NEW.id, 'upsert'); END;
CREATE TRIGGER cl_matters_u AFTER UPDATE ON matters BEGIN INSERT INTO change_log(entity, ref, op) VALUES ('matter', NEW.id, 'upsert'); END;
CREATE TRIGGER cl_matters_d AFTER DELETE ON matters BEGIN INSERT INTO change_log(entity, ref, op) VALUES ('matter', OLD.id, 'delete'); END;

CREATE TRIGGER cl_mops_i AFTER INSERT ON matter_ops BEGIN INSERT INTO change_log(entity, ref, op) VALUES ('matter_op', NEW.id, 'upsert'); END;
CREATE TRIGGER cl_mops_u AFTER UPDATE OF undone_at ON matter_ops BEGIN INSERT INTO change_log(entity, ref, op) VALUES ('matter_op', NEW.id, 'upsert'); END;

CREATE TRIGGER cl_timers_i AFTER INSERT ON timers WHEN NEW.kind = 'followup' BEGIN
  INSERT INTO change_log(entity, ref, op) VALUES ('timer', NEW.id, 'upsert'); END;
CREATE TRIGGER cl_timers_u AFTER UPDATE OF due_at, note, status ON timers WHEN NEW.kind = 'followup' BEGIN
  INSERT INTO change_log(entity, ref, op) VALUES ('timer', NEW.id, 'upsert'); END;

CREATE TRIGGER cl_threads_i AFTER INSERT ON threads BEGIN INSERT INTO change_log(entity, ref, op) VALUES ('thread', NEW.id, 'upsert'); END;
CREATE TRIGGER cl_threads_u AFTER UPDATE ON threads BEGIN INSERT INTO change_log(entity, ref, op) VALUES ('thread', NEW.id, 'upsert'); END;
CREATE TRIGGER cl_threads_d AFTER DELETE ON threads BEGIN INSERT INTO change_log(entity, ref, op) VALUES ('thread', OLD.id, 'delete'); END;

CREATE TRIGGER cl_config_i AFTER INSERT ON config_changes BEGIN INSERT INTO change_log(entity, ref, op) VALUES ('config', NEW.id, 'upsert'); END;
```
- 一张表的 insert、update、delete 都写同一个 entity，pump 发的时候按视图函数取当时的内容。
- 实测每次写多 7–8 µs（§触6.4）。
- 显式 emit 的写法是 `INSERT INTO change_log(entity, ref, op) VALUES (?, ?, ?)`，必须在业务写入的那个 `tx()` 里。

### 10.3 动静触发器（`matters.last_activity_at`，不写 change_log，matters 自己的触发器会写）

```sql
CREATE TRIGGER act_events_i AFTER INSERT ON events WHEN NEW.matter_id IS NOT NULL BEGIN
  UPDATE matters SET last_activity_at = MAX(COALESCE(last_activity_at, 0), NEW.ts)
   WHERE id = NEW.matter_id OR id = (SELECT parent_id FROM matters WHERE id = NEW.matter_id); END;
CREATE TRIGGER act_events_u AFTER UPDATE OF matter_id ON events WHEN NEW.matter_id IS NOT NULL BEGIN
  UPDATE matters SET last_activity_at = MAX(COALESCE(last_activity_at, 0), NEW.ts)
   WHERE id = NEW.matter_id OR id = (SELECT parent_id FROM matters WHERE id = NEW.matter_id); END;
CREATE TRIGGER act_tasks_i AFTER INSERT ON tasks WHEN NEW.matter_id IS NOT NULL BEGIN
  UPDATE matters SET last_activity_at = MAX(COALESCE(last_activity_at, 0), NEW.ts)
   WHERE id = NEW.matter_id OR id = (SELECT parent_id FROM matters WHERE id = NEW.matter_id); END;
CREATE TRIGGER act_tasks_u AFTER UPDATE OF status ON tasks WHEN NEW.matter_id IS NOT NULL BEGIN
  UPDATE matters SET last_activity_at = CAST(unixepoch('subsec') * 1000 AS INTEGER)
   WHERE id = NEW.matter_id OR id = (SELECT parent_id FROM matters WHERE id = NEW.matter_id); END;
CREATE TRIGGER act_timers_u AFTER UPDATE OF status ON timers WHEN NEW.matter_id IS NOT NULL AND NEW.status = 'done' BEGIN
  UPDATE matters SET last_activity_at = MAX(COALESCE(last_activity_at, 0), COALESCE(NEW.fired_at, NEW.due_at))
   WHERE id = NEW.matter_id OR id = (SELECT parent_id FROM matters WHERE id = NEW.matter_id); END;
CREATE TRIGGER act_approvals_i AFTER INSERT ON approvals WHEN NEW.matter_id IS NOT NULL BEGIN
  UPDATE matters SET last_activity_at = MAX(COALESCE(last_activity_at, 0), NEW.ts)
   WHERE id = NEW.matter_id OR id = (SELECT parent_id FROM matters WHERE id = NEW.matter_id); END;
CREATE TRIGGER act_notes_i AFTER INSERT ON life_notes WHEN NEW.matter_id IS NOT NULL BEGIN
  UPDATE matters SET last_activity_at = MAX(COALESCE(last_activity_at, 0), COALESCE(NEW.ts, 0))
   WHERE id = NEW.matter_id OR id = (SELECT parent_id FROM matters WHERE id = NEW.matter_id); END;
```
- 「我改状态」由 `setMatterStatus` 在同一事务里直接写 `last_activity_at`。整理和 matter_ops 不写。
- 重读时事件带原来的 ts，所以重建后的值是对的。

### 10.4 太旧就 reset

```sql
SELECT (SELECT MIN(seq) FROM change_log) AS lo,
       (SELECT seq FROM sqlite_sequence WHERE name = 'change_log') AS hi;
-- 规则：after < hi 且 (lo IS NULL 或 after + 1 < lo) → 发 reset（§触6.4）
```

## 11 定期清理和 blob GC

只清日志、派生、缓存类，其余不删。

| 什么 | 规则 | 多久一次 |
|---|---|---|
| change_log | `ts < now − 7 天` | 每小时 |
| requests | `ts < now − 7 天` 删行，blob 交给 GC | 每小时 |
| runs.input_ref | `started < now − 365 天` 的置 NULL（§底5 原文：快照留 1 年） | 每天 |
| client_ops | ※ `ts < now − 30 天` | 每天 |
| push_queue | ※ `state IN ('done','void') AND closed_at < now − 30 天` | 每天 |
| device_invites | ※ `expires < now − 30 天` | 每天 |
| blobs/ | ※ 不被任何 `_ref` 列引用、且 mtime 早于 1 天的文件删掉 | 每天 |
| graph_nodes、graph_edges | 整表重建（`rebuildGraph`），照旧 | 照旧 |
| pages、pages_fts | 跟 agent-home 同步，照旧 | 照旧 |

GC 收集引用：
```sql
SELECT DISTINCT substr(r, 6) AS sha FROM (
  SELECT input_ref AS r FROM runs        UNION ALL SELECT body_ref FROM requests
  UNION ALL SELECT body_ref FROM run_items UNION ALL SELECT request_ref FROM approvals
  UNION ALL SELECT context_ref FROM approvals UNION ALL SELECT diff_ref FROM tasks
  UNION ALL SELECT handoff_ref FROM task_sessions UNION ALL SELECT chart_ref FROM readings
  UNION ALL SELECT input_ref FROM eval_cases UNION ALL SELECT old_ref FROM proposals
  UNION ALL SELECT new_ref FROM proposals
) WHERE r LIKE 'blob:%';
```
- 留 1 天的宽限：覆盖「blob 写好了、事务还没提交就崩了」那一段，这种孤儿下次 GC 收掉。
- 加列时要同步上面的列表。hub/db 的测试用 `pragma_table_info` 扫出所有以 `_ref` 结尾的列，减去不指 blob 的那几个，再和这份列表比，漏了就失败。不指 blob 的：`session_ref`（agent 的 session id）、`media_ref`、`raw_ref`（`raw:`、`body:`，带过去的目录，不归 GC 管）、`veto_ref`、`reraise_ref`（`<entity>:<id>`）。

## 12 和 §底5、旧 db.ts 的差异

### 加的表
- `run_items`、`threads`、`client_ops`、`change_log`：§触6.4、§触6.5 要的。
- `devices`、`device_invites`、`device_audit`：§触6.7。
- `nodes`：§办3.1。§底5 草案里有，代码没有。
- `task_sessions`、`worktrees`、`task_prs`：§办3.4 的换机、可清理、CI 是一对多（§4）。
- `push_queue`、`reads`：§触1.1，补推和已读要落表。
- `suggestions`：它想到的建议原来没地方存（§触1，每天 ≤ 3 条、7 天过期）。
- `learned_items`、`dismissals`：Y5，逐条存、三套「不再提」合并。
- `crosschecks`、`body_entries`、`raw_sources`：§底5 草案里有、代码没有，这次建。`raw_sources` 去掉 `s3_key`（不用桶，§读1.5）。
- `messages_fts`：设计要、代码没建。

### 不建的
- `expert_calls`（草案）：用量看 `usage`（tier=expert），结论在 `approvals.expert_json` 和 `signals`，另存一份会对不上。
- `edge_nodes`（草案）：并进 `nodes.extra_json`。
- 视图 `timeline`（草案）：不建 SQL 视图，留在 hub/ledgers 的查询函数里。主对话 lane 是配置出来的（R3），视图里写不死。

### 改名、改形状
- `messages`：加 `rid INTEGER PRIMARY KEY`，`id` 改成 UNIQUE。FTS 要稳定的整数 rowid，而 TEXT 主键表的隐式 rowid 会被 VACUUM 改掉。
- JSON 列补 `_json` 后缀：
  - `matters.keys` → `keys_json`
  - `matter_ops.touches` → `touches_json`
  - `events.msg_ids` → `msg_ids_json`
  - `persons.first_via` → `first_via_json`
  - `graph_edges.evidence` → `evidence_json`
  - `outlooks.why_refs` → `why_refs_json`
  - `reviews.owner_words` → `owner_words_json`
  - `life_notes.people`（逗号串）→ `people_json`（带过去时转）
- `approvals.card_msg_id` → `cards_json`：一张审批现在在私聊、管理群、以后别的渠道各有一张卡，决定后要逐张改。草案的 `card_thread_id` 不建，话题根就是卡片消息。
- `tasks.wb_root_msg`、`wb_thread` → `mirrors_json`：R3，解开写死的飞书。
- `requests.body`（BLOB）→ `body_ref`；`proposals.old_content` / `new_content` → `old_ref` / `new_ref`；`eval_cases.input` → `input_ref`：大载荷不进表。中文 prompt 整份常超过 16 KB。
- `imports.raw_path` → `raw_ref`。
- `timers`：旧 schedule 行把时间表达式塞在 `turn_json`、job 名塞在 `note`、run id 塞在 `created_by`。拆成 `cron`、`job`、`run_id`，`created_by` 只放 owner|agent|jobs.yaml|code：夜里照发要分清「我定的」和「它定的」（§触1.1）。

### 删的列和枚举值
- `tasks`：
  - `allow_json`、`budget`、`timeout_ms`：去掉上限（§办3.5）。
  - `question`、`next_prompt`：问我进 `approvals`（kind=ask）；排着的插话就是 inbox 行。
  - `runs` 计数 → `turn`。
  - 状态去掉 `waiting_approval`、`needs_input`，换成 `waiting`、`waiting_node`。
- `approvals`：kind 去掉 `deferred_tool`（挂起式审批随 SDK worker 去掉）；草案的 `deferred_tool_json` 不建。
- `run_tokens.status` 去掉 `budget_exhausted`（R7，只告警）。
- `runs`：草案的 `run_token_hash` 不建，令牌和 run 的关系在 `run_tokens.run_id`；`worker` 角色 → `task`。

### 加的列
- `inbox`：`device_id`、`tries`。
- `runs`：`device_id`、`err_fp`。`input_ref` 从文件路径改成 `blob:`。
- `usage`：`source`、`device_id`。node 行开始写 `task_id`。
- `approvals`：`attempt`、`session_ref`、`request_json`、`request_ref`、`options_json`、`answer_json`、`context_ref`、`refs_json`、`cards_json`。kind 加 `glance`、`ask`。
- `tasks`：`node`、`agent`、`attempt`、`turn`、`quota_until`、`diff_ref`、`mirrors_json`。
- `timers`：`cron`、`job`、`payload_json`、`run_id`、`task_id`。kind 加 `task`；status 加 `missed`、`skipped`、`skipped_by_check`。
- `messages`：`rid`、`domain`。
- `chats`：`channel`。
- `matters`：`paused_at`、`last_activity_at`。status 加 `paused`。
- `readings`：`frozen_hash`、`outlook_id`。`reading_revisits` 和 `outlook_revisits`：`feeling`。
- `outlooks`：`lane`、`parent_id`、`reading_ids_json`、`frozen_hash`、`status`。
- `self_items`：`side`、`mismatch_json`。
- `noticings`：`echo`、`matter_id`。
- `proposals`：`tier`、`route`、`hypothesis`、`held_json`、`task_id`、`pr_url`、`rollback_of`。status 加 `held`、`live`。
- `config_changes`：`actor`。

### 两边不一致时跟了谁
- 照代码：
  - `outbox.status` 含 `streaming`；
  - `imports.status` 是 `applying|applied|failed|undone`；
  - `reviews` 的 kind 是 `day|week|month|matter`，status 是 `chatted|unchatted`。草案的 `drafted|in_dialogue|done|not_discussed` 不用：未聊由代码写，两态就够。
  - `readings` 用 `lens='agent'` 表示只看事实，不另设草案的 `source` 列。草案的 `claim`、`revisit_at`、`look_for` 三列由 `claims_json` 承担（一条解读里有多条看法）；`feeling`、`owner_words` 进 `reading_revisits`（只追加）。
  - `outlooks` 一行一条。草案的 `items_json` 拆成行；`intention_words` 不建，发心原话在 journal 和复盘里，用 `why_refs_json` 指过去。
  - `eval_cases` 用代码的形状（`ref` UNIQUE、`expected`）。草案的 `role` 就是 `kind`；`gold_ref` 就是 `expected`；`from_signal_id`、`active` 不建，来源写在 `meta_json`。
- 照设计：
  - `proposals` 的 `tier`、`held`、`live`；
  - `approvals` 的 `glance`、`ask`；
  - `matters` 的 `paused`；
  - `crosschecks`、`body_entries` 的列。
- `proposals` 的默认状态：用 `proposed`，理由见 proposals 表下面。

## 13 量级（Y8）

先按下面的假设估。W0 在旧库上实测后，用实测数替换这一节。

假设（都是估计，不是实测）：
- A1：每天读进 2 000 条消息（群、私聊、邮件、信息源），正文平均 200 字节。
- A2：每天 150 条事件。
- A3：主上 runner 的 run 每天 70 个（主对话 40、起草 15、后台 15），每个平均 4 次模型请求、8 个 run_items。
- A4：节点任务每天 5 个，每个 10 轮、100 次工具调用。
- A5：`requests` 只录主对话和起草：每天 55 个 run × 4 次 = 220 个请求，gzip 后平均 25 KB。
- A6：客户端每天写 100 次。

| 表 | 行/天 | 字节/行（含索引） | 每天 |
|---|---|---|---|
| messages | 2 000 | ~500 | 1.0 MB |
| messages_fts | 2 000 | ~3 × 正文 ≈ 600 | 1.2 MB |
| run_items | 70×8 + 5×100 ≈ 1 060 | ~1.2 KB（工具截到 2 KB） | 1.3 MB |
| inbox | ~400 | ~400 | 0.16 MB |
| usage | ~430（代理 280 + 分拣 ~100 + 节点自报 50） | ~200 | 0.09 MB |
| events | 150 | ~500 | 0.08 MB |
| outbox | ~80 | ~800 | 0.06 MB |
| runs | ~120 | ~400 | 0.05 MB |
| approvals | ~20 | ~2 KB | 0.04 MB |
| requests（行） | 220 | ~120 | 0.03 MB |
| signals | ~80 | ~250 | 0.02 MB |
| 其余（事、人、账本、前瞻、复盘、设备…） | — | — | < 0.05 MB |
| change_log | ~4 500 | ~60 | 0.27 MB，7 天封顶 ≈ 2 MB |
| client_ops | 100 | ~300 | 30 天封顶 ≈ 1 MB |
| push_queue | ~40 | ~400 | 30 天封顶 ≈ 0.5 MB |

- **requests 留 7 天**：220 × 25 KB × 7 ≈ **38 MB**，全在 `blobs/`；表本身约 1 500 行、0.2 MB。公式是「每天请求数 × 平均 gzip 大小 × 7」。
- **SQLite 一年**：会一直涨的部分约 4 MB/天 → **约 1.5 GB/年**。其中消息加 FTS 约 55%，run_items 约 30%。滚动的表加起来封顶 3–4 MB。
- **blobs 一年**：
  - requests 稳定在 ~40 MB；
  - 起草快照 15 × 30 KB/天，留 1 年，稳定在 ~165 MB；
  - diff 和交接文本 ~0.25 MB/天，不删，约 90 MB/年。
- 两个大头的旋钮都不是上限：
  - FTS 能不能只索引一部分：检索不过滤（§寸4），不建议；
  - run_items 截断的字节数（※ 2 KB）。
- 备份大小按这一节的数算（backup 模块）。

**W0 实测结果（2026-11-27，旧库 `VACUUM INTO` 的快照，只看聚合数）**：旧库只有约 11 天的消息（开始读飞书到现在），下面「每天」按最近 7 天算；30 天口径会低估 3 倍。

| 项 | 假设 | 实测（近 7 天） |
|---|---|---|
| A1 消息 | 2 000 条/天 × 200 B | **900 条/天 × 270 B**（10 119 条；群 121 个占 83%，私聊 74 个，邮件 131 个会话） |
| A2 事件 | 150/天 | **117/天**（共 1 362） |
| A3 run | 70/天 × 4 次请求 | **11/天**：主对话 5、起草 1.9、worker 1.4、lens 1.3、dream 1；每个 1.3–5.6 次请求 |
| A5 requests | 220/天 × 25 KB | **12/天 × 52 KB**，7 天共 4.6 MB |
| usage | ~430/天 | **185/天** |
| 花费 | — | **3.2 美元/天**；30 天口径里约一半是不挂 run 的 light 档（分拣一类），折合每条消息约 0.0018 美元 |
| trigram FTS | 3 × 正文 | **2.9 ×**（2.6 MB 正文 → 7.7 MB） |
| 库大小 | — | 16 MB（messages 8 MB、requests 2 MB、pages FTS 1.1 MB） |

- 按实测改估：会一直涨的部分约 900 × (270 + 780 FTS + 索引 ~250) ≈ **1.2 MB/天 → 约 0.45 GB/年**；requests 稳定在 ~5 MB。上面按假设算的 1.5 GB/年是上限。
- `import plan` 的系数先用：每条消息分拣 0.0018 美元、每件事件归事并在里面（W6 演练时按实际修，09 对账要求 ≤ 30%）。照现在的量，全部重读约 10 k 条 × 0.0018 ≈ **18 美元**。
- W6 对账的基线（每张表行数、每个会话消息数、带过去的条数、文件数和 sha）在服务器 `/srv/data/sbot/rebuild/w0/w0-baseline.json`（带会话 id，不进仓库）。仓库里只记：消息 10 119、会话 329；`life_notes` 0、没到点的 follow-up 0、imports `applied` 1；旧系统没有 `raw/` 和 `private/body/`，导入原件在 `imports/`（1 个文件）和 `agent-home/imports/`（1 个文件）；开着的事件 74（`ask/reply` 55、`ask/decide` 8、其余 11）。
- 脚本 `probes/w0-db/measure.ts`（W0 分支，不进 `main`，08 的约定）。

**W0 实测的做法**：在服务器上拷一份旧库，只出聚合数字，不打印任何内容。用 `new DatabaseSync('<副本>', { readOnly: true })` 跑 1–5；第 6 条要写，在另一份副本上跑。

```sql
-- W0-1 每张表、每个索引占多少字节（node:sqlite 自带 dbstat）
SELECT name, SUM(pgsize) AS bytes FROM dbstat GROUP BY name ORDER BY bytes DESC;

-- W0-2 近 30 天每天行数、平均字节（旧表名、旧列名）
WITH w AS (SELECT (CAST(strftime('%s','now') AS INTEGER) - 30*86400) * 1000 AS t0)
SELECT 'messages' AS t, COUNT(*)/30.0 AS per_day, AVG(LENGTH(CAST(text AS BLOB))) AS avg_bytes FROM messages, w WHERE ts > t0
UNION ALL SELECT 'events',    COUNT(*)/30.0, AVG(LENGTH(CAST(summary AS BLOB)))      FROM events, w    WHERE ts > t0
UNION ALL SELECT 'inbox',     COUNT(*)/30.0, AVG(LENGTH(CAST(payload_json AS BLOB))) FROM inbox, w     WHERE ts > t0
UNION ALL SELECT 'runs',      COUNT(*)/30.0, NULL                                     FROM runs, w      WHERE started > t0
UNION ALL SELECT 'usage',     COUNT(*)/30.0, NULL                                     FROM usage, w     WHERE ts > t0
UNION ALL SELECT 'approvals', COUNT(*)/30.0, AVG(LENGTH(CAST(context_json AS BLOB))) FROM approvals, w WHERE ts > t0
UNION ALL SELECT 'outbox',    COUNT(*)/30.0, AVG(LENGTH(CAST(payload AS BLOB)))      FROM outbox, w    WHERE ts > t0
UNION ALL SELECT 'signals',   COUNT(*)/30.0, NULL                                     FROM signals, w   WHERE ts > t0;

-- W0-3 requests 实际 7 天的大小
SELECT COUNT(*) AS n, COUNT(*)/7.0 AS per_day, AVG(bytes) AS avg_gz, SUM(bytes) AS total_7d FROM requests;

-- W0-4 每种角色每天几个 run、每个 run 几次模型请求（估 run_items 和 requests）
WITH w AS (SELECT (CAST(strftime('%s','now') AS INTEGER) - 30*86400) * 1000 AS t0)
SELECT r.role, COUNT(DISTINCT r.id)/30.0 AS runs_per_day, COUNT(u.id) * 1.0 / COUNT(DISTINCT r.id) AS calls_per_run
FROM runs r LEFT JOIN usage u ON u.run_id = r.id, w WHERE r.started > t0 GROUP BY r.role;

-- W0-5 后台每天花多少（按角色，代理计的）
WITH w AS (SELECT (CAST(strftime('%s','now') AS INTEGER) - 30*86400) * 1000 AS t0)
SELECT COALESCE(r.role, 'tier:' || u.tier) AS who, SUM(u.cost)/30.0 AS usd_per_day
FROM usage u LEFT JOIN runs r ON r.id = u.run_id, w WHERE u.ts > t0 GROUP BY who ORDER BY usd_per_day DESC;

-- W0-6 trigram FTS 实际膨胀多少（在可写副本上）
CREATE VIRTUAL TABLE w0_fts USING fts5(text, content='messages', tokenize='trigram');
INSERT INTO w0_fts(w0_fts) VALUES ('rebuild');
SELECT SUM(pgsize) AS fts_bytes FROM dbstat WHERE name LIKE 'w0_fts%';
```

## 14 原来拿不准的，按已定的推

1. **`approvals.kind` 留 `proposal`、`rollback`**：旧代码里提案卡、回滚卡就是 approvals 行（`improve.ts`），状态机和过期是同一套，`proposals.approval_id`、`rollback_approval_id` 都指过来。
2. **数据计划没列的表** ※：`life_notes` 和没到点的 follow-up 带过去（我的原话、我让它记的，不带就丢）。其余：
   - 切换前收尾：approvals、outbox、tasks 不搬，id 接着旧库往上编；
   - proposals、matter_reviews、noticings 清零；
   - config_changes、kv 不搬（kv 只带 `task.seq`）；
   - chats、imports 重读；raw_sources、pages 重算。
3. **同一个 PR 连红到第 3 次**：照 §办3.4（我定）和 Y8，进 `push_queue`（cat=notice），不发看一眼卡；§附2.19 那句是旧写法。
