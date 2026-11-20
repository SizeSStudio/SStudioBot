> 导航：[设计文档索引](../DESIGN.md) · [上一篇：配置控制台（core/console）](05-console.md) · [下一篇：探针与各里程碑进度、里程碑](07-progress-milestones.md)

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
  -- status 多一个 merged 和 paused（先搁着，§15.16）；parent_id 指向主线（只一层），merged_into 指向合并后留下的事（§15.3）
matter_ops(id, ts, kind, summary, why, by, review_id, touches, undo_json, undone_at, undone_by)   -- 事的每次改动和撤销它需要的东西
matter_reviews(id, fp, kind, prio, why, data_json, origin, status, shown_n, last_shown, snooze_until, created_at, decided_at, decided_by, action, op_id)   -- 每日整理的建议（§15.14）
      -- status: open|active|paused|closing|reviewed|dropped|merged；domain: work|personal
readings(id, ts, matter_id NULL, source, lens, method, profile_version, question, reading_ref,
         claim, revisit_at, look_for, frozen_hash, status, feeling NULL, owner_words, evidence_refs,
         revisited_at)
      -- 专存单门镜头解读（v0.25 与 crosschecks 拆开，§15.7）；source: lens|agent；feeling: resonant|neutral|not_yet（以我的原话 owner_words 为准）
      -- claim / look_for / reading_ref 写入即冻结（frozen_hash 校验），之后只能追加回看
crosschecks(id, ts, kind, matter_id NULL, outlook_id NULL, person_id NULL, question, prompt_version,
            sources_json, reading_ids, agreements, divergences, blind_spots, suggestion,
            frozen_hash, status, feeling NULL, owner_words, revisited_at)
      -- v0.25：独立互参账本（§15.17）。kind: matter|outlook|review|habit|relation|body|ad_hoc
      -- sources_json：本次实际参与的可选视角槽位与引用（事实/时间线、镜头 reading_ids、身体底图、他人原话、主人原话等，不设必填项）
      -- prompt_version：互参方法/提示词版本，用于跨版本复盘调优；核心内容写入即冻结（frozen_hash），之后只追加回看
body_entries(id, ts, date, kind, summary, metrics_json NULL, source, raw_ref NULL, confirmed, note NULL)
      -- v0.25：身体档案记录（§15.19），与 self/ 同级隔离（仅主人可见），不进 events 和图谱
      -- kind: daily_summary|checkup|symptom|note；source: owner_chat|upload|device_sync；confirmed: 0|1（体检解析经我确认后为 1）
      -- raw_ref 指向仅主人可见的体检原件或截图存储
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
--   union owner 消息 / outbox / approvals / tasks / matters / outlooks / readings / crosschecks / body_entries / reviews / life_notes；
--   日程不落库，timeline_query 时现查飞书日历再合并（整张视图仅 owner 会话可用，§15.9）

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
| 老婆和朋友私聊的回复策略 | 自动档（硬上限 + 承诺检测）自动回，其余审批（[§7.4](03-wechat-permissions.md#74-他人发起的请求简化后的工作量闸门)） |
| 各档用什么模型 | 留好配置；2026-11-17 定四档：chat opus、work sonnet、light haiku、expert opus（[§5.1](02-roles-models.md#51-四档与角色路由)） |
| 私人内容出现在工作飞书里 | 可以接受 |
| harness | worker 和 lens 用 Claude Agent SDK（sandbox、`defer`、内置工具）；对话角色用 pi（P0 对比后定）；工具和闸门写成与 harness 无关的一层（[§4.0](02-roles-models.md#40-harnessworker-用-claude-agent-sdk对话角色用-pip0-已定)） |
| 群里要不要自动回 | 按群开关，默认全部审批 |
| 搜索 | 优先用模型自带的；兜底工具在 P0 准备好 |
| 飞书群 | 默认 `always`，以 user 身份轮询读取；敏感群和外部群默认关闭或只出摘要；首次启用时过一遍群列表（[§3.5](01-runtime-identity-channels.md#35-群的开关configgroupsyaml管理群发-group-用卡片切换)） |
| 以 user 身份读消息会不会变已读 | 不会（已确认） |
| 可视化配置 | 控制台，M3 起做；之前用卡片和直接改文件 |
| 审批 | 非阻塞：提交式 + 挂起式（[§7.2](03-wechat-permissions.md#72-两种审批路径)） |
| 凭证 | LLM 代理 + Unix 用户隔离；agent 环境里没有任何真实凭证 |
| 第一性原理（v0.24） | 陪我修自己、离苦得乐的伙伴，只为我一个人。办 → 读 → 参 → 觉 → 改：办事是基本功和起点，读懂我从几种来源主动看，几种看法互参，最好是我自己先看见。看可以主动，说要克制；会淡、能放下（[§0](00-principles.md#0-第一性原理v024-重写)） |
| 互参、他人原话、苦事三态、身体档案（v0.25） | 互参从 `readings` 拆出独立建账 `crosschecks`（可选视角槽位、不设必填、冻结提示词版本，[§15.17](08-companion.md#1517-互参账本v025)）；现阶段不做反依赖监控（[§0.5](00-principles.md#05-怎么算帮到了)）；别人说的话算读懂我的来源（复盘对照 + 重要的人审批卡旁可附原话对照，不改闸门；亲友私聊暂只聚合普通功能不做深度分析，[§15.18](08-companion.md#1518-别人说的话与边界v025)）；苦事分三态（在推进 / 先搁着 `paused` / 了结放下，[§15.16](08-companion.md#1516-不绕着苦转v024v025-补齐三态)）；身体归 `self/` 同级隔离，做可选底图 + 体检跨年守护，不单设身体专卦、随例行可参中医与五行阴阳（[§15.19](08-companion.md#1519-身体档案v025)） |
| 陪伴的定位 | 红尘里修：修行在整个生活里，办事是信息来源也是道场。两条主轴是月、周、日的前瞻和顺着时间线的回溯，首尾相接成类 RSI 的循环（[§15](08-companion.md#15-陪伴红尘里修)） |
| 退后 | 成长的刻度是我自己先看见的比例，只当镜子不当 KPI；习气我连续 3 次自己先看见就"送一程"，不再主动提；熟了以后复盘有时先让我回忆（[§15.13](08-companion.md#1513-退后谁先看见送一程)） |
| agent 自己的 RSI | 信号来自我的行为和原话；改动分四级（自动 / 提案 + 回放 + 我批 / PR / 永不），只能让它办得更好，不能让它权限更大（[§16](09-rsi-matters-graph.md#16-agent-自己的-rsi越用越会办事)）。风格笔记和范例库定为 A 级自动生效：范例本来多是和 AI 对话调出来的，学的是调教后的倾向；体检节奏按信号量动态触发 |
| 前瞻的分寸 | 建议不是安排；月、周各不超过 3 条，日 1 条；先问我的意图再给；镜头的日、周、月例行看法默认开，能在 `jobs.yaml` 关（[§15.2](08-companion.md#152-节律月周日的前瞻)） |
| 玄学的位置 | 佛学是 agent 的立场；八字、紫微、六爻是镜头，当作一种看法，结合生活来感受，不做对错打分 |
| 复盘的方式 | 事的层面给事实初稿；心的层面先问再给，引导我补充信息和看法。我自己说出来的分量最重 |
| 镜头来源 | 紫微用现有 skill；六爻以 zhouyi-qigua.pages.dev 为准，单独开 thread 做 skill；八字后续再定 |
| 部署 | 单机，不做远程 worker；数据全在 4T 数据盘；worker 进程同时 ≤ 2，各限 1G；重构建外包给 Mac 或 CI（[§1.3](01-runtime-identity-channels.md#13-部署单机轻量2026-11-16-定)） |
| 知识库 | llm-wiki 三层：raw 放 rustfs，wiki 就是 agent-home，schema 在 AGENTS.md；检索用 FTS5，不上向量库（[§8.5](04-memory-timers.md#85-知识库llm-wiki-三层karpathy-的-llm-wiki-模式)） |
| 预算超限的状态码 | 403，不用 429（429 会让 CLI 重试约 3 分钟，[§5.2](02-roles-models.md#52-llm-代理凭证代理)） |

### 仍然未决
- 月前瞻按公历月还是节气月：先做成 `config/self.yaml` 里的一个选项。
- [§18](09-rsi-matters-graph.md#18-因缘人事资料的图谱v015) 因缘的后续：dream / 分拣从对话里顺手记关系（推测，等我认）；周复盘里带一段因缘；AGENTS.md 里约定人物页互相用 `[[people/…]]` 链接（AGENTS.md 是我改的）；数据大了以后改成增量构建。

> 导航：[设计文档索引](../DESIGN.md) · [上一篇：配置控制台（core/console）](05-console.md) · [下一篇：探针与各里程碑进度、里程碑](07-progress-milestones.md)
