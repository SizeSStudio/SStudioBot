> 导航：[设计文档索引](../DESIGN.md) · [上一篇：控制台客户端](10-console-client.md)

## 附：参考
- T3 Code 远程访问（[§19.7](10-console-client.md#197-设备验证) 的设备配对参考）：github.com/pingdotgg/t3code，`docs/user/remote-access.md`
- 六爻：zhouyi-qigua.pages.dev（之后单独做 skill 时以它为准）
- **《Building always-on agents》**（claude.com，William Hu）：五件套（收件箱、定时器、记忆、权限、发件箱）；run 周期；定时器只往收件箱里投事件；"只存查不回来的东西"；凭证代理；defer 加卡片审批；先安静、再争取注意力。[§1](01-runtime-identity-channels.md#1-运行模型五件套)、[§5.2](02-roles-models.md#52-llm-代理凭证代理)、[§7.2](03-wechat-permissions.md#72-两种审批路径)、[§8](04-memory-timers.md#8-记忆)、[§9](04-memory-timers.md#9-定时器) 都按这篇文章调整过。
- Claude Agent SDK 文档：permissions（评估顺序、`dontAsk`、allowedTools 和 canUseTool 的关系）、hooks（`onFailure`、超时、`defer`、PostCompact）、TypeScript Options（`env`、`tools`、`settingSources`、`sandbox`）。
- **pi**（badlogic/pi-mono → earendil-works/pi）：极简 agent harness，内置只有 read / write / edit / bash，没有 MCP 和权限系统；`createAgentSession` 可以嵌进 Node 进程；扩展事件 `tool_call`（可拦截）、`context`、`before_agent_start`、`session_before_compact`；会话是带分支的 JSONL；支持 Agent Skills；多厂商。[§4.0](02-roles-models.md#40-harnessworker-用-claude-agent-sdk对话角色用-pip0-已定) 的对话角色候选。
- **LayerFS**（Ephemeral-AI-Lab/layerfs）：候选思路是 worker 每次写操作一个 checkpoint（影子分支），以及 dream 在分支上整理再合并；还没写进正文，也不引入依赖。
- OpenClaw / NanoClaw / nanobot / Hermes Agent：见 v0.6 附录。
- T3 Code：thread / delegate / task notification / queue 的交互模型。
- **graphify**：把代码和资料建成知识图谱。借了这几条：边分 EXTRACTED / INFERRED，路径取最弱一跳；只用代码构建；邻居、最短路径、解释三种查询；社区自动分、不靠模型命名；名字有歧义就拒绝并列候选。[§18](09-rsi-matters-graph.md#18-因缘人事资料的图谱v015) 按它设计，没有引入依赖。
- **HappyClaw**（riba2534/happyclaw）：技术栈和场景跟我们最接近，不 fork，只借设计：
  - `src/group-queue.ts`：会话串行和合批
  - `src/channel-reliability-store.ts`：收件箱和发件箱
  - `src/feishu.ts`：话题映射、撤回
  - `src/automation-*.ts`：定时任务语义
  - `subagent_checkpoints`：断点恢复

> 导航：[设计文档索引](../DESIGN.md) · [上一篇：控制台客户端](10-console-client.md)
