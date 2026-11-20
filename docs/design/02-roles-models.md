> 导航：[设计文档索引](../DESIGN.md) · [上一篇：运行模型、人与身份、渠道](01-runtime-identity-channels.md) · [下一篇：微信、权限闸门与审批](03-wechat-permissions.md)

## 4. 角色与 harness

### 4.0 harness：worker 用 Claude Agent SDK，对话角色用 pi（P0 已定）

**分工**

| 角色 | harness | 原因 |
|---|---|---|
| worker、lens | **Claude Agent SDK**（定了） | 要用内置的 Read / Edit / Bash、`sandbox`、`defer` 挂起审批、skills。pi 没有权限和沙箱，这些都得自己写 |
| 主 agent、reflect、起草、Triage、expert、dream | **pi 1.5.2**（`createAgentSession`，在核心进程里跑，每条 lane 一个常驻 session），2026-11-16 P0 对比后定（[§13](07-progress-milestones.md#13-p0-探针清单开工前-12-天全部写成可以重复执行的脚本)） | 见下 |

**对话角色为什么用 pi**（P0 实测：`probes/RESULTS.md`）
- **SDK 的长处它们用不上**：这些角色不用任何内置工具，不要 sandbox，审批走提交式，也不用 `defer`。现在为了用 SDK，反而要花力气把东西关掉（`tools: []`、`settingSources: []`、一长串环境变量），而且每个 run 都要起一个 CLI 子进程。
- **红尘里修的核心是"上下文怎么拼"**：本月和本周的前瞻、时间线片段、认可过的习气和节律、心得。pi 能直接控制每次请求带什么：`context` 事件每次调模型前都能改消息，`before_agent_start` 能换 system prompt，`session_before_compact` 能自己写压缩摘要，保证发心、本月留意这些锚点在压缩后还在。SDK 里压缩基本是黑盒，只能事后拿摘要。
- **不绑厂商**：pi 原生支持多家协议。chat 档如果用的不是 Claude，就不必经过 Claude Code 那套为 Claude 调过的提示词和工具约定。
- **能读懂**：pi 的核心很小，和"代码自己能完全读懂"的目标一致。
- **轻**：pi 在核心进程里只发 HTTP 请求。SDK 每个 run 要起一个 CLI 子进程，实测常驻 230～320 MB，冷启动 1～3 s。对单机部署（[§1.3](01-runtime-identity-channels.md#13-部署单机轻量2026-11-16-定)）来说，这一条分量很重。

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
- 模型请求一律打 LLM 代理（[§5.2](#52-llm-代理凭证代理)），用每个 run 的临时令牌。

#### 4.0.1 Claude Agent SDK 的用法（worker、lens；对话角色如果最后也用 SDK，同样适用。按官方文档核对过）

| 需求 | 用 harness 的什么 | 自己写的部分 |
|---|---|---|
| agent loop、工具调用 | `query()` | 无 |
| 会话续接 | `resume` | session key ↔ sdk_session_id 映射；resume 失败时的兜底（[§1.2](01-runtime-identity-channels.md#12-收件箱与-run-的语义)） |
| 上下文压缩 | 自动 compaction + **`PostCompact` hook**（拿到 `compact_summary`） | 摘要写进 journal |
| 出口闸门 | **`PreToolUse` hook**，设 `onFailure: "block"`（需要 TS SDK ≥ 0.3.317） | 分级、审批、计数 |
| 运行中途审批 | PreToolUse 返回 **`defer`** → `stop_reason: "tool_deferred"` → 不带 prompt 地 resume，hook 再次触发并给出 allow/deny | 审批状态机（[§7.2](03-wechat-permissions.md#72-两种审批路径)） |
| 自定义工具 | in-process MCP（`createSdkMcpServer` + `tool()`），工具代码在核心进程里执行 | 记忆、任务、消息、审批、定时器 |
| 干活的工具 | worker 用内置 Read / Edit / Write / Bash / Grep / Glob + `sandbox` | 无 |
| 后台长任务 | — | **Task Engine**。harness 自带的后台 subagent 会随进程一起消失，不用它 |
| 搜索 / 抓取 | 内置 WebSearch / WebFetch | 探测不通时的兜底工具（[§5.4](#54-按能力降级)） |

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
  - init 里的 `skills` 列的是"发现了哪些"，不是"模型能用哪些"，不能拿它判断白名单。需要的设置通过 `settings` 选项传入（如 WebFetch 的 `skipWebFetchPreflight` 和 `env.HTTPS_PROXY`，见 [§7.6](03-wechat-permissions.md#76-隔离与凭证)）。**不传 `cleanupPeriodDays`**：`settingSources: []` 下没有任何来源提供它，CLI 就跳过转录清理（P0 实测），挂起的会话不会被清掉。旧转录随任务目录由核心 GC 删除。
- **env 从零构造**：`env` 是整体替换，不是合并。每个 run 只给：
  ```
  PATH, HOME, LANG, TZ                   # 显式给，不继承宿主
  CLAUDE_CONFIG_DIR = <按角色/任务独立的目录>   # 不碰宿主的 ~/.claude
  ANTHROPIC_BASE_URL   = http://127.0.0.1:7811/llm     # LLM 代理（[§5.2](#52-llm-代理凭证代理)）
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
| `reply` | ✅ | ✅（是否直接发出，按 [§7.4](03-wechat-permissions.md#74-他人发起的请求简化后的工作量闸门) 判定） |
| `send`（发到别的目标，提交式审批） | ✅ | ❌ |
| `memory_search` | 全部 | **只能搜**：发言人的 people 笔记、当前群的笔记、`agent-home/shared/`（我明确标过可以分享的内容） |
| `memory_append`（写 journal） | ✅ | ✅（自动带来源标签，[§8.3](04-memory-timers.md#83-写入纪律)） |
| `session_list` / `session_read` | ✅ | ❌ |
| `calendar_query` | 详情 | **只返回忙闲**；配偶等关系可以在 `gate.yaml` 里放开到详情 |
| `task_start` / `task_*` | ✅ | ❌（改成调用 `request_approval(plan)`） |
| `followup_set` / `_list` / `_cancel` | ✅ | ❌ |
| `life_note`（随手记，[§15.6](08-companion.md#156-时间线与回溯)）、`timeline_query` | ✅ | ❌ |
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
    - **核心守卫**：一个 PreToolUse hook 拦截 Bash 命令，以及 Read/Write/Edit/Glob/Grep 的路径参数中指向核心位置的调用（`/srv/sbot`、`secrets.env`、`/run/sbot`、`/proc/*/environ`、lark-cli）。只看工具要去哪里，不看写进去的内容，所以改本仓库里提到这些路径的文档照样能改。worker 规则里也写了"有 sudo 也不碰"。这是软边界（[§7.6](03-wechat-permissions.md#76-隔离与凭证)）。
  - **sandbox**：就是下面原来那套，以 `sbot-w` 用户运行。任务要把不可信内容（陌生网站、别人的仓库、别人发来的文件）喂给 worker、而全权限又可能闯祸时，用这个模式；主 agent 拿不准时先问我。
- **skill 和 CLI（两种模式都有）**：核心在每次 run 之前把 `config/skills/<名字>/` 复制到 `/srv/data/sbot-shared/worker-plugin/skills/`（全员可读、只有核心能写；先建一份新的再换上去），用 SDK 的 `plugins` + `skills` 选项加载。`skills` 始终显式传：默认是 `config/skills` 下的全部，也可以在 `worker.yaml` 里列名字或写 `all`（`all` 会连 CLI 自带的也打开）。`worker.yaml` 的 `path` 通过 `settings.env.PATH` 加在 PATH 前面。
- **sandbox 模式的隔离**（[§7.6](03-wechat-permissions.md#76-隔离与凭证)）：
  - 以 `sbot-w` 用户运行（P0 已验证）：SDK 的 `spawnClaudeCodeProcess` 把 CLI 改成 `sudo -n /usr/local/lib/sbot/worker-exec <args>`。这个 root 所有的包装脚本校验 cwd 是 `sbot-w` 的任务目录，再用 `systemd-run --scope`（`sbot-workers.slice`，`MemoryMax=1G`）+ `setpriv` 切到 `sbot-w` 去跑锁定版本的 CLI（`/opt/sbot/claude-code/<ver>/claude`）。sudoers 只放行这个脚本和 `task-mkdir`，环境变量只保留 `ANTHROPIC_*`、`CLAUDE_*`、`LANG`。in-process MCP 和 hook 走 stdio，跨 sudo 照常工作。安装文件在 `deploy/worker/`。
  - bash 套 SDK `sandbox`（bubblewrap），`failIfUnavailable: true`、`allowUnsandboxedCommands: false`。
  - 工作目录 `/srv/sbot-w/tasks/<id>/`，`CLAUDE_CONFIG_DIR` 也放在里面。`HOME` 固定为 `/srv/sbot-w/home`，不放在任务目录里（sandbox 会屏蔽可写路径下的 shell rc 文件，放进去 bash 每次都报 `.bashrc: Permission denied`）。
  - PATH 里**没有 lark-cli**，也没有任何凭证（host 模式同样不给，对飞书的动作仍然走核心工具和审批）。
- **任务进度文件**：worker 要维护 `progress.md`，写明做完了什么、还剩什么。中断后续跑、或者 needs_input 之后重开时，下一个 run 先读它。
- **对外动作走核心工具**：比如 `feishu_doc_write`、`git_push`。这些都是 L2：PreToolUse 返回 `defer`，任务进入 `waiting_approval`，批准后 resume（[§7.2](03-wechat-permissions.md#72-两种审批路径)）。
- **改代码**：
  - worker 只在自己的 worktree 里提交，**没有 push 凭证**。
  - 批准后由核心推送：核心从 worker 的 worktree 把分支 fetch 到自己的镜像仓库，带 `core.hooksPath=/dev/null` 再推送。**核心从不在 worker 目录里执行 git 命令**。
  - 改 SStudioBot 自己的代码只能走 PR，由我来 merge。
- **交报告**：结束时调用 `submit_report`（结论、改动、验证、未完成），Task Engine 往发起它的 lane 投一条 `task_done` 事件。
- **不能直接问人**：遇到需要我决定的事，以 `needs_input` 结束，由主 agent 来问我；拿到答案后 resume 同一个 session 接着跑。
- **上限**：
  - 轮数、超时、无输出看门狗由 Task Engine 管。
  - token 预算由 LLM 代理硬性执行，超了直接拒绝请求。
  - 并发：每个会话最多 3 个未结束的任务，全局最多 5 个。其中同时在跑的 worker 进程最多 2 个，默认 1 个，其余排队；每个 `MemoryMax=1G`（[§1.3](01-runtime-identity-channels.md#13-部署单机轻量2026-11-16-定)）。

### 4.3 Triage（light 档，无工具）
处理不是发给 agent 的大量消息（飞书观察群、微信群）。**只做分类，不起草**：

```
pending 消息 ──► 规则预筛（不调模型：黑名单、@我、@bot、关键词）
             └─► Triage（一个群一批）──► ignore | archive | notify | draft | escalate
```
- `notify`：等窗口，到点没回应就攒一批推给我。
- `draft`：等窗口，到点没回应才交给 **chat 档**做一次"起草 run"（只带当前群的上下文和他人会话的工具范围），产出审批卡片。
- `escalate`：默认不等，开一个主 agent 会话来处理。信息源的消息不走这条，封顶到 `notify`（[§17.3](09-rsi-matters-graph.md#173-信息源)）。

v0.13：同一次调用还出**事件**（[§17.2](09-rsi-matters-graph.md#172-事件账本)）。一批里有意义的时刻记成 kind × level，挂到我手上的某件事（只能填正在进行的事的编号）或一个话头上。分拣的输入除了群，还有开了的私聊和 sources.yaml 里的信息源，都按"一个地方一批"；草稿只在群里起，私聊和信息源只记事件、发提醒。提醒按事 / 话头分组，要你回、要你拍板的排在前面。模型挂了就按规则兜底：@我 的记成「要你回」，摘要用原文。

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
- 到点复查（`responseTo`，规则见 [§17.2](09-rsi-matters-graph.md#172-事件账本)）：已回应、事件已关或已放弃，这条记 `answered`，什么都不发，也不起草。`triage_action` 保留分拣当时的判断，[§16](09-rsi-matters-graph.md#16-agent-自己的-rsi越用越会办事) 的评估照旧读它。
- 还在等我：`notify` 进下一批提醒，批次之间至少隔 10 分钟，一条提醒只发一次；`draft` 开始起草，一轮最多 3 个，其余下一轮；`escalate` 进我的私聊。
- 起草时带上窗口期间群里后来说的话，别人已经答了就输出【不回复】，转成提醒。
- 草稿发卡片后，我说了别的话会让卡片作废（[§7.3](03-wechat-permissions.md#73-审批状态机)）；如果那句话没回应这件事，事件还开着，它转回提醒，不会就此消失。
- `escalate` 的等待取 `escalate_wait_minutes` 和这个地方窗口的较小值：某处设了 0，那里的紧急消息也不等。
- 窗口只决定什么时候提醒、什么时候起草，审批闸门不变：草稿照样要我在卡片上点发送。
- 缩短窗口算放宽，管理群单独提醒（[§10.3](05-console.md#103-原则)）。

### 4.4 Expert（expert 档，无工具）
- **待审材料由代码直接塞进 prompt**（草稿、diff、计划、日志），不给任何读文件的工具；`maxTurns` 很小。
- 输出 `{ verdict: pass|revise|block, issues[], suggestion }`。
- 触发条件见 [§5.5](#55-expert什么时候出来把关触发条件写在代码里)。

### 4.5 Reflect 与 Lens（陪伴相关的两个角色，§15）
- **reflect**（chat 档；月前瞻、月复盘和大事起局可以走 expert）：负责前瞻、起局、复盘和回溯，没有文件工具，只在 owner lane 里跑。
  - 读事实的工具：`timeline_query`（[§15.6](08-companion.md#156-时间线与回溯)）、messages、outbox、approvals（包括我改过的草稿和拒绝理由）、日历、matter 文件，以及 `self/` 里允许读的部分。
  - 写的工具：`outlook_submit`、`matter_update`、`review_submit`、`followup_set`、`habit_propose` 和 `rhythm_propose`（都只能提候选）。
- **lens**（受限 worker）：排盘要执行脚本，所以按 worker 的方式跑在 `sbot-w` 下，套 sandbox。
  - **网络全关**：它手上可能有出生信息，不能有任何外传通道。
  - 输入：需要生辰的方法才拿到 `config/self.yaml`（含换算好的 `chart_input`）和 `self/charts/` 的只读副本；都有对应镜头的 skill 和 `self/lens-notes/<lens>.md`。
  - 输出：用 `submit_reading` 交回统一格式的结果（[§15.7](08-companion.md#157-镜头与解读账本)）。

---

## 5. 模型层

### 5.1 四档与角色路由

2026-11-17 由三档改成四档（我的判断：执行类的活至少要 sonnet，读的活 haiku 就够，日常对话做总控用 opus 更靠谱，专家先保持 opus 当第二视角）。

| 档位 | 定位 | 用在哪里 | 现在的模型 |
|---|---|---|---|
| **chat** | 总控，日常对话 | 主 agent（含起局、复盘、前瞻的对话）、升档后的 worker | opus |
| **work** | 执行 | worker（默认）、草稿起草和按批注改稿、镜头解读、dream、[§16](09-rsi-matters-graph.md#16-agent-自己的-rsi越用越会办事) 起草回放 | sonnet |
| **light** | 读 | Triage、起草后的检查（承诺检测）、群摘要、会话收尾摘要、`web_search`、[§16](09-rsi-matters-graph.md#16-agent-自己的-rsi越用越会办事) 分拣回放、Claude Code 内部的小模型调用 | haiku |
| **expert** | 第二意见，只在特定场景把关 | [§5.5](#55-expert什么时候出来把关触发条件写在代码里)；[§16](09-rsi-matters-graph.md#16-agent-自己的-rsi越用越会办事) 提案和评审；月复盘、大事起局（可选） | opus |

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
  - 限制：带 thinking 签名的历史换模型会被拒（[§5.4](#54-按能力降级)），这种请求等于没切成。
- **M0～M2 阶段**：直接改文件，加上飞书 `/model` 卡片（只能看配置、切换档位里的模型名、触发探针）。控制台里的「模型」页放到 M3。

### 5.4 按能力降级

| 能力缺失 | 降级方式 |
|---|---|
| `vision: false` | 用一个支持 vision 的档位先把图片转成文字；哪档都不支持就只存图，回复里说明看不到 |
| `forced_tool: false` | 结构化输出改用"提示词约束 + 代码校验 + 失败重试一次" |
| `server_web_search: false` | **默认用模型自带的搜索**（WebSearch 的服务端工具由转换层映射）。P0 实测 上游的 claude 档原样支持 `web_search_20250305`。对话角色在 pi 上，没有内置 WebSearch：核心的 `web_search` 工具就照 Claude Code 的做法，经 LLM 代理发一次带 `web_search_20250305` 的 Messages 调用，把结果整理后返回。哪档不支持，再换成自接搜索 API |
| `web_fetch_ok: false` | P0 实测：关闭非必要流量后 WebFetch 仍可用，但默认会直连目标网站和 api.anthropic.com（域名检查）。worker 里固定 `skipWebFetchPreflight: true` + `settings.env.HTTPS_PROXY` 走核心出网代理（[§7.6](03-wechat-permissions.md#76-隔离与凭证)）。对话角色（pi）用自研的 `web_fetch`（核心抓取 + 转 markdown），同样走出网代理的白名单和日志 |

**换模型后会话怎么办**：thinking 块的签名换了模型就会失效。所以某个档位换模型后，这一档的滚动会话在下一个 run 自动开新 session，旧会话的要点用摘要带过去。

### 5.5 Expert：什么时候出来把关（触发条件写在代码里）

| 场景 | 触发条件 | 审什么 |
|---|---|---|
| 重要的对外发言 | 收件人 `importance: high`；或者承诺检测命中（[§7.4](03-wechat-permissions.md#74-他人发起的请求简化后的工作量闸门)） | 审批卡片上的草稿，expert 意见一起显示在卡片上 |
| 代码交付 | worker 申请 `git_push` 之前 | diff 和任务目标 |
| 核心记忆变更 | dream 要改 USER.md | diff |
| 主动求助 | `consult_expert`，或者我说"让专家看看" | 当前问题 |

（"发到工作群就审"这一条去掉了，否则 daily_limit 很快会被耗光。"大任务审计划""连续失败诊断"后置。）超过 `daily_limit` 后只执行我手动触发的，被跳过的在卡片上标"未经专家把关"。

> 导航：[设计文档索引](../DESIGN.md) · [上一篇：运行模型、人与身份、渠道](01-runtime-identity-channels.md) · [下一篇：微信、权限闸门与审批](03-wechat-permissions.md)
