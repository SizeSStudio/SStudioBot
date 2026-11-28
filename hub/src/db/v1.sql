-- Schema v1 (user_version 1): docs/tech/04 §1–§10.3, copied verbatim. 04 is the source; hub/test/db.test.ts fails when
-- the two drift. Later versions only add (tables, columns, indexes), each in its own file.

-- 1 运行
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
CREATE TABLE run_tokens(
  hash TEXT PRIMARY KEY,             -- sha256(令牌)；明文只在 run 的内存里
  run_id TEXT, tier TEXT, requester_id TEXT,
  budget_output INTEGER,             -- 告警线：到了只告警，不停（§办2.2）
  spent_output INTEGER NOT NULL DEFAULT 0,
  expires INTEGER,
  status TEXT NOT NULL DEFAULT 'active' -- active|revoked（去掉 budget_exhausted，R7）
) STRICT, WITHOUT ROWID;
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
CREATE TABLE requests(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  run_id TEXT, usage_id INTEGER, tier TEXT, model TEXT,
  bytes INTEGER,                     -- gzip 后
  body_ref TEXT NOT NULL             -- blob:，内容是 gzip 的完整模型请求（主对话和起草 run，§触5.4）
) STRICT;
CREATE INDEX requests_ts ON requests(ts);
CREATE INDEX requests_run ON requests(run_id);

-- 2 出口
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
CREATE TABLE reads(
  ref TEXT PRIMARY KEY,              -- 同 push_queue.ref 的形状；thread 用 thread:<id>
  upto_ts INTEGER,                   -- thread：读到的最后一条时间线项的 ts；单条目为 NULL
  read_at INTEGER NOT NULL,
  via TEXT NOT NULL                  -- device:<id> | feishu（飞书的已读回执） | …
) STRICT, WITHOUT ROWID;
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

-- 3 定时
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
CREATE TABLE kv(k TEXT PRIMARY KEY, v TEXT) STRICT, WITHOUT ROWID;

-- 4 任务和节点
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

-- 5 设备和连接
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
CREATE TABLE device_invites(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  secret_hash BLOB NOT NULL UNIQUE,  -- sha256(一次性密钥)；明文只在配对码里（链接 # 后）
  role TEXT NOT NULL,                -- client|node
  created_by TEXT NOT NULL,          -- cli | device:<id> | <渠道>
  created_at INTEGER NOT NULL,
  expires INTEGER NOT NULL,          -- created_at + 10 分钟
  used_at INTEGER, used_by TEXT      -- 配上的 devices.id；用一次就失效
) STRICT;
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

-- 6 客户端
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
CREATE TABLE change_log(
  seq INTEGER PRIMARY KEY AUTOINCREMENT, -- AUTOINCREMENT：清掉旧行后 seq 也不复用
  ts INTEGER NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER)),
  entity TEXT NOT NULL,              -- 见 §10 覆盖表
  ref TEXT NOT NULL,                 -- 实体 id，一律存文本
  op TEXT NOT NULL                   -- upsert|delete
) STRICT;
CREATE INDEX change_log_ts ON change_log(ts);

-- 7 读
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
CREATE TABLE chat_cursors(
  chat_id TEXT NOT NULL, surface TEXT NOT NULL,
  last_msg_ts INTEGER, last_msg_id TEXT, updated_at INTEGER,
  PRIMARY KEY(chat_id, surface)
) STRICT, WITHOUT ROWID;
CREATE TABLE chats(
  chat_id TEXT PRIMARY KEY,          -- 渠道原生 id；非飞书加 <渠道>: 前缀
  channel TEXT NOT NULL DEFAULT 'feishu',
  name TEXT,
  external INTEGER NOT NULL DEFAULT 0,
  muted INTEGER NOT NULL DEFAULT 0,
  chat_mode TEXT,
  seen_at INTEGER
) STRICT, WITHOUT ROWID;
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
CREATE TABLE person_aliases(
  kind TEXT NOT NULL, alias TEXT NOT NULL, person_id INTEGER NOT NULL,
  src TEXT, ts INTEGER,
  PRIMARY KEY(kind, alias, person_id)
) STRICT, WITHOUT ROWID;
CREATE INDEX person_aliases_p ON person_aliases(person_id);
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
CREATE TABLE graph_nodes(
  id TEXT PRIMARY KEY,               -- me | p:<id> | m:<id> | c:<chat_id> | g:<path> | r:<sha>
  kind TEXT NOT NULL, label TEXT, ts INTEGER
) STRICT, WITHOUT ROWID;
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
CREATE TABLE pages(
  path TEXT PRIMARY KEY,
  mtime INTEGER, title TEXT, summary TEXT,
  visibility TEXT,                   -- owner|work|shared（visibilityOf；frontmatter 只能收窄）
  bytes INTEGER
) STRICT, WITHOUT ROWID;
CREATE VIRTUAL TABLE pages_fts USING fts5(path UNINDEXED, title, body, visibility UNINDEXED, tokenize='trigram');
CREATE TABLE imports(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER,
  origin TEXT, sha TEXT,
  raw_ref TEXT,                      -- raw:<sha>（旧 raw_path）
  summary_json TEXT,
  commit_sha TEXT,
  status TEXT NOT NULL DEFAULT 'applied' -- applying|applied|failed|undone（照代码）
) STRICT;

-- 8 参觉改
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
CREATE TABLE outlook_revisits(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  outlook_id INTEGER NOT NULL,
  ts INTEGER,
  text TEXT,                         -- 我的原话
  feeling TEXT,                      -- resonant|neutral|not_yet
  src TEXT, run_id TEXT
) STRICT;
CREATE INDEX outlook_revisits_o ON outlook_revisits(outlook_id, ts);
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
CREATE TABLE review_open(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL, period TEXT NOT NULL,
  facts TEXT,
  fired_at INTEGER,
  deadline INTEGER NOT NULL,         -- 到点还没落档，代码写 reviews(status=unchatted)
  inbox_key TEXT, run_id TEXT,
  UNIQUE(kind, period)
) STRICT;
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

-- 9 改进
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
CREATE TABLE config_changes(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER,
  file TEXT,
  diff TEXT,                         -- secrets.env 只记 "added NAME" / "updated NAME"；self.yaml 只说改了（不进群）
  source TEXT,                       -- console|chat|card|command|upgrade|proposal|manual
  actor TEXT                         -- device:<id> | <渠道> | run:<id>
) STRICT;

-- 10 change_log 触发器
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
