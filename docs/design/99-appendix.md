## 附1 已拍板的决策

| 问题 | 结论 |
|---|---|
| 老婆和朋友私聊的回复策略 | 承诺检测通过就自动回，其余审批（§底3.4）；原来的数字上限 2026-11-26 去掉 |
| 各档用什么模型 | 留好配置；2026-11-17 定四档：chat opus、work sonnet、light haiku、expert opus（§办2.1） |
| 私人内容出现在工作飞书里 | 可以接受 |
| harness | 干活交给节点上现成的 agent：Claude Code（Agent SDK）、Codex（app-server）、pi（RPC）走官方接口，别的走 ACP，客户端 acpx（2026-11-26，§办3.2）；lens 和迁完之前的 worker 用 Claude Agent SDK；对话角色用 pi（P0 对比后定）；我们的工具和闸门写成与 harness 无关的一层（§办1.1） |
| 群里要不要自动回 | 按群开关，默认全部审批 |
| 搜索 | 优先用模型自带的；兜底工具在 P0 准备好 |
| 飞书群 | 默认 `always`，以 user 身份轮询读取；敏感群和外部群默认关闭或只出摘要；首次启用时过一遍群列表（§触2.5） |
| 以 user 身份读消息会不会变已读 | 不会（已确认） |
| 可视化配置 | 控制台，M3 起做；之前用卡片和直接改文件 |
| 审批 | 非阻塞：提交式 + 挂起式 + 看一眼（§底3.2）。节点 agent 按自己的权限设置跑，来问转看一眼卡（2026-11-26，§办3.3） |
| 凭证 | SStudioBot 的密钥只在主（LLM 代理，主用单独账号），不进 agent 环境；节点 agent 用节点自己的登录（2026-11-26，§办3.2） |
| 第一性原理（v0.24） | 陪我修自己、离苦得乐的伙伴，只为我一个人。办 → 读 → 参 → 觉 → 改：办事是基本功和起点，读懂我从几种来源主动看，几种看法互参，最好是我自己先看见。看可以主动，说要克制；会淡、能放下（§0） |
| 互参、他人原话、苦事三态、身体档案（v0.25） | 互参从 `readings` 拆出独立建账 `crosschecks`（可选视角槽位、不设必填、冻结提示词版本，§参2）；现阶段不做反依赖监控（§0.5）；别人说的话算读懂我的来源（复盘对照 + 重要的人审批卡旁可附原话对照，不改闸门；亲友私聊暂只聚合普通功能不做深度分析，§读6）；苦事分三态（在推进 / 先搁着 `paused` / 了结放下，§寸5）；身体归 `self/` 同级隔离，做可选底图 + 体检跨年守护，不单设身体专卦、随例行可参中医与五行阴阳（§读5.2） |
| 陪伴的定位 | 红尘里修：修行在整个生活里，办事是信息来源也是道场。两条主轴是月、周、日的前瞻和顺着时间线的回溯，首尾相接成类 RSI 的循环（§觉1） |
| 退后 | 成长的刻度是我自己先看见的比例，只当镜子不当 KPI；习气我连续 3 次自己先看见就"送一程"，不再主动提；熟了以后复盘有时先让我回忆（§寸3） |
| agent 自己的 RSI | 信号来自我的行为和原话；改动分四级（自动 / 提案 + 回放 + 我批 / PR / 永不），只能让它办得更好，不能让它权限更大（§进2）。风格笔记和范例库定为 A 级自动生效：范例本来多是和 AI 对话调出来的，学的是调教后的倾向；体检节奏按信号量动态触发 |
| 前瞻的分寸 | 建议不是安排；月、周各不超过 3 条，日 1 条；先问我的意图再给；镜头的日、周、月例行看法默认开，能在 `jobs.yaml` 关（§觉2） |
| 玄学的位置 | 佛学是 agent 的立场；八字、紫微、六爻是镜头，当作一种看法，结合生活来感受，不做对错打分 |
| 复盘的方式 | 事的层面给事实初稿；心的层面先问再给，引导我补充信息和看法。我自己说出来的分量最重 |
| 镜头来源 | 紫微用现有 skill；六爻以 zhouyi-qigua.pages.dev 为准，单独开 thread 做 skill；八字后续再定 |
| 部署 | 同一时间一个主，Linux、Mac、Windows 都能当；别的机器作为节点主动连主，设备密钥配对；不设并发和时长上限；systemd、自动上线、沙箱是 Linux 上的可选件；重构建派给 Mac 节点或 CI（2026-11-26 改，§办3.1、§底1.3） |
| 知识库 | llm-wiki 三层：raw 放 rustfs，wiki 就是 agent-home，schema 在 AGENTS.md；检索用 FTS5，不上向量库（§读1.5） |
| 预算 | 只告警，不停（2026-11-26）。令牌无效、越档回 403，不用 429（429 会让 CLI 重试约 3 分钟，§办2.2） |

### 仍然未决
- 月前瞻按公历月还是节气月：先做成 `config/self.yaml` 里的一个选项。
- §读4 因缘的后续：dream / 分拣从对话里顺手记关系（推测，等我认）；周复盘里带一段因缘；AGENTS.md 里约定人物页互相用 `[[people/…]]` 链接（AGENTS.md 是我改的）；数据大了以后改成增量构建。

## 附：参考
- T3 Code 远程访问（§触6.7 的设备配对参考）：github.com/pingdotgg/t3code，`docs/user/remote-access.md`
- 六爻：zhouyi-qigua.pages.dev（之后单独做 skill 时以它为准）
- **《Building always-on agents》**（claude.com，William Hu）：五件套（收件箱、定时器、记忆、权限、发件箱）；run 周期；定时器只往收件箱里投事件；"只存查不回来的东西"；凭证代理；defer 加卡片审批；先安静、再争取注意力。§底1、§办2.2、§底3.2、§读1、§底4、§寸2 都按这篇文章调整过。
- Claude Agent SDK 文档：permissions（评估顺序、`dontAsk`、allowedTools 和 canUseTool 的关系）、hooks（`onFailure`、超时、`defer`、PostCompact）、TypeScript Options（`env`、`tools`、`settingSources`、`sandbox`）。
- **pi**（badlogic/pi-mono → earendil-works/pi）：极简 agent harness，内置只有 read / write / edit / bash，没有 MCP 和权限系统；`createAgentSession` 可以嵌进 Node 进程；扩展事件 `tool_call`（可拦截）、`context`、`before_agent_start`、`session_before_compact`；会话是带分支的 JSONL；支持 Agent Skills；多厂商。§办1.1 的对话角色候选。
- **LayerFS**（Ephemeral-AI-Lab/layerfs）：候选思路是 worker 每次写操作一个 checkpoint（影子分支），以及 dream 在分支上整理再合并；还没写进正文，也不引入依赖。
- OpenClaw / NanoClaw / nanobot / Hermes Agent：见 v0.6 附录。OpenClaw 用 acpx 接外部 harness，`openclaw mcp serve` 把自己的工具给 Claude Code、Codex 用，是 §办3.2 反向开放的参考。
- **ACP**（Agent Client Protocol）：JSON-RPC，agent 一般作为子进程走 stdio。`session/new`、`session/prompt`、`session/cancel`、`session/load`（可选）、`session/request_permission`；没有轮中插话。适配：`claude-agent-acp`、`codex-acp`、`pi-acp`。§办3。
- **acpx**（openclaw/acpx，npm `acpx`，MIT，alpha）：无界面的 ACP 客户端；session 持久、忙时排队、权限模式、NDJSON 输出；库入口 `acpx/runtime`。§办3.2 用它接 ACP agent，锁版本。
- **Paseo**（getpaseo/paseo，Apache-2.0，2026-11 是 0.17）：每台机器一个 daemon 管 agent，手机、桌面、网页连进来。Claude 走 Agent SDK、Codex 走 app-server、pi 走 RPC，其余走 ACP（`packages/server/src/server/agent/providers/`）。借了：等权限时发消息先拒掉请求（`docs/glossary.md` Steer）、空闲释放进程留 session（`docs/agent-lifecycle.md`）、ACP 续接的三档。没借：每台机器一个独立 daemon（和"一个主"不合）、端到端加密中继（我们走 tailnet）。设备身份和凭证分开、客户端的排队条和推送原因留给 §触6 重做时看。
- T3 Code：thread / delegate / task notification / queue 的交互模型。
- **graphify**：把代码和资料建成知识图谱。借了这几条：边分 EXTRACTED / INFERRED，路径取最弱一跳；只用代码构建；邻居、最短路径、解释三种查询；社区自动分、不靠模型命名；名字有歧义就拒绝并列候选。§读4 按它设计，没有引入依赖。
- **HappyClaw**（riba2534/happyclaw）：技术栈和场景跟我们最接近，不 fork，只借设计：
  - `src/group-queue.ts`：会话串行和合批
  - `src/channel-reliability-store.ts`：收件箱和发件箱
  - `src/feishu.ts`：话题映射、撤回
  - `src/automation-*.ts`：定时任务语义
  - `subagent_checkpoints`：断点恢复
