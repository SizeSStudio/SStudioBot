# 05 节点（`node/`）

设计在 §办3、§底3.6。节点程序一个，两种连法：本机节点（和主同一台，unix socket / named pipe）、远端节点（经中继）。主所在那台也跑一个本机节点。

## 结构

```
node/src/
  main.ts          守护进程：连主、hello、收指令、心跳
  link.ts          本机：长度前缀帧；远端：中继 + Noise + auth（共用 protocol/）
  sessions.ts      session 表（内存 + 本地 state 文件）、空闲释放、排空
  adapters/        claude.ts · codex.ts · pi.ts · acp.ts —— 同一个接口
  events.ts        各家事件 → 统一事件
  mcp.ts           sbot MCP server（stdio 小程序 + Claude in-process）
  exec.ts          只本机节点：bash、读写文件、check
  git.ts           worktree、diff、CI 查询（用节点自己的 git / gh 登录）
  upgrade.ts       fetch、校验、排空、切换
  cli.ts           sbot-node pair | status | mcp
```

节点**不存定时状态**（§底4.1）：续跑、CI 查询、空闲释放、worktree 扫描都是主发来的单次指令。本地 state 文件只存「哪个 task 对应哪个 session_ref、进程 pid」，重启后用来续接。

## 配置（节点机器上，`~/.config/sbot-node/node.yaml`；实例数据，不进仓库）

```yaml
hub: { pairing: <配对后写入：主公钥、中继地址、本机设备私钥的位置> }
agents:                       # 本机有哪些 agent、怎么起；不写就按 PATH 探测
  claude: { bin: claude }
  codex:  { bin: codex }
  pi:     { bin: pi }
  acp:    [{ name: gemini, cmd: "gemini --experimental-acp" }]
max_parallel: null            # 可选，我给这台设的同时数；不设就不限（D2）
workdirs: [~/code]            # 派活时允许的 cwd 根；不在里面的照样能派，只是界面标出 ※
linux: { account: sbot-h, memory_max: 6G }   # 只 Linux：systemd-run 起 agent
```

旧 `worker.yaml` 的 `ssh_hosts`、`skills`、`path` 搬到这里或 agent 自己的设置里（03 配置键变化）。

## 适配器

一个接口（Paseo 的形状）：

```ts
interface AgentAdapter {
  caps(): { steer: boolean; resume: boolean; rewind: boolean; permissions: boolean; ask: boolean };
  createSession(o: { cwd: string; prompt: string; mcp: McpMount; env?: Record<string, string> }): Promise<string>;  // → session_ref
  resumeSession(ref: string, o: { cwd: string; mcp: McpMount }): Promise<void>;
  startTurn(ref: string, text: string): Promise<void>;
  steer(ref: string, text: string): Promise<boolean>;       // false = 不支持，节点排到下一轮
  interrupt(ref: string): Promise<void>;
  subscribe(ref: string, on: (e: AgentEvent) => void): () => void;
  getPendingPermissions(ref: string): PermissionRequest[];
  respondToPermission(ref: string, id: string, answer: { option_id: string; text?: string }): Promise<void>;
  release(ref: string): Promise<void>;                       // 放掉进程，留 session
}
```

| agent | 接法（锁版本，P5–P8 核实） | 插话 | 权限请求 | 续接 | 我们的 MCP |
|---|---|---|---|---|---|
| Claude Code | `@anthropic-ai/claude-agent-sdk` 0.3.332 `query()`，流式输入（AsyncIterable，推消息 `priority: "next"` 就是插话） | ✓ | `canUseTool`；`settingSources: ["user","project","local"]`，规则外的才到它（项目规则要工作区已信任，见下） | `resume` | `mcpServers` in-process（`createSdkMcpServer`） |
| Codex | `codex app-server` 0.172.0（JSON-RPC over stdio，不带 `jsonrpc` 字段） | `turn/steer`（要带 `expectedTurnId`） | 服务端发 `item/commandExecution/requestApproval`、`item/fileChange/requestApproval`；调 MCP 工具另发 `mcpServer/elicitation/request` | `thread/resume` | `thread/start`、`thread/resume` 的 `config` 里给 `mcp_servers.sbot.command/args/env`，指向 `sbot-node mcp`，不改 `~/.codex/config.toml` |
| pi | `pi --mode rpc` 1.6.1（JSONL，只按 LF 切） | `steer` | 没有（照实报 `permissions: false`） | `--session <文件>`（`get_state` 的 `sessionFile` 就是 `session_ref`） | **没有 `--mcp-config`**；节点带一个 pi 扩展（`-e`），里面 `pi.registerMcpServer("sbot", { command, args, env, exposure: "direct" })`，配置经环境变量传 |
| 其他 | ACP，客户端 acpx 0.23.0 的库入口 `acpx/runtime`（够用，不换 SDK） | ✗，排到下一轮 | `session/request_permission`（新 session 要先 `session/set_mode` 到 `default`，见下） | `session/resume`（`unstable_resumeSession` 的现名；agent 的 `sessionCapabilities.resume` 为真才有）→ `session/load`（`loadSession` 为真；会重放历史）→ 新 session 读 `progress.md`；acpx 自己按这个顺序选 | `session/new` 的 `mcpServers` |

- Claude 的 `AskUserQuestion` 转成 `ask`（§附2.19）：`canUseTool` 里截下，答案放进 `updatedInput.answers` 回给模型。
- P5–P8 实测要照做的几条（08 有数）：
  - Claude：`allowedTools` 里写了的工具不再进 `canUseTool`（SDK 会警告 `CLAUDE_SDK_CAN_USE_TOOL_SHADOWED`），只放我们自己的 `mcp__sbot__*`（闸门在主上）。项目级规则、hooks 只在工作区已信任时加载，SDK 不弹信任框；要让项目规则生效，节点得在 agent 的配置目录里为这个 cwd 预记信任（`.claude.json` 的 `projects[<realpath>].hasTrustDialogAccepted`）※（预记信任同时让仓库里的 `.claude/` hooks 和 MCP 配置生效，要不要这么做我定；不预记则只有用户级规则）。
  - ACP（`claude-agent-acp`）：新 session 默认起在 `auto`，**不发权限请求**，直接自动放行；节点建 session 后必须 `session/set_mode` 到 `default`（acpx 库里是 `runtime.setMode`）。
  - Codex、ACP 调我们自己的 MCP 工具也会先问一次（`mcpServer/elicitation/request`、带 `sbot:` 标题的 `session/request_permission`）；闸门在主上，节点对 `sbot` 自己的工具请求直接答允许，不进卡片，其余照常转。
  - pi 没有权限请求；扩展里的 `tool_call` 钩子能返回 `block` 拦下，但那是拒绝不是询问，不当权限系统用。
  - 插话只在工具边界生效：一轮里并行发的几个工具调用之间没有边界，插话要等这一批结束。
- 做不到的照实报，不拿自动回答冒充（§办3.2）。
- 升级任一 agent 的 SDK、CLI、acpx：先跑 P5–P8 探针，过了才换（`unstable_` 开头的会变）。

### 统一事件

```ts
type AgentEvent =
  | { k: "text"; item: string; delta: string }                     // 增量
  | { k: "message"; item: string; text: string }                   // 一段写完
  | { k: "tool_start"; item: string; name: string; args: unknown }
  | { k: "tool_end"; item: string; ok: boolean; result?: unknown; diff?: string }
  | { k: "permission"; request: PermissionRequest }                // → 主的看一眼卡
  | { k: "ask"; request: PermissionRequest }
  | { k: "turn_end"; stop: "done" | "interrupted" | "error"; error?: string }
  | { k: "usage"; input_tokens?: number; output_tokens?: number; ms?: number }   // usage.source = node
  | { k: "quota"; resets_at?: number; remaining?: unknown }        // 认出订阅上限
  | { k: "progress"; text: string };                               // progress.md 的新内容
```

- 每个 session 一个单调 `event_seq`；批量回传 `/node/v1/tasks/:id/events { attempt, from_seq, events }`，主按 `task_id:attempt:event_seq` 幂等。离线时攒在本地（文件），重连后补发；`attempt` 旧了主整批丢。
- 打码在主上做（03 tools），节点不碰密钥规则；但 `text` 增量照样按 50～100 ms 一批发，减少帧数。
- 运行中的 diff：Claude `Edit`/`Write` 的输入、Codex `turn/diff/updated`、ACP `session/update` 里的 diff；定稿 diff 由 `git.ts` 在工作目录算（`core.hooksPath=/dev/null`），超过 16 KB 的走主的 blob（02 大载荷：节点用 `POST /node/v1/blobs` 上传，同样分片）※。

### 认出额度上限

各家错误 → `quota` 事件，带恢复时间。认不出恢复时间的报 `resets_at` 空，主每 30 分钟发一次重试指令（同 §底4.3）。特征串放 `adapters/*.ts` 里的表。先认结构化字段，文本只兜底：

- Claude：流里的 `rate_limit_event`（`status: "rejected"`，带 `resetsAt`、`rateLimitType`）；助手消息的 `error: "rate_limit"`；文本以 SDK 导出的 `USAGE_LIMIT_ERROR_PREFIXES` 开头。
- Codex：`turn/completed` 里 `turn.error.codexErrorInfo` 为 `usageLimitExceeded`、`rateLimitExceeded`（另有各种 `*SpendLimitExceeded`、`sessionBudgetExceeded`）；`account/rateLimits/updated` 带每个窗口的 `resetsAt`。
- pi：随 provider 变，只有文本，认 pi 自己的终止类清单（08 有）；没有结构化的恢复时间。
- ACP：错误的 `data.errorKind` 为 `rate_limit`，`data.rateLimit` 带 Claude 的限额信息。

原文都是从装好的 CLI 里读出来的，没有真烧到额度；真遇到时把原文补进 08。

## 权限和问我（§办3.3）

- 适配器的权限请求 → `POST /node/v1/permissions { task_id, attempt, request_id, title, detail, options }`。`detail` 是完整的命令、路径、参数，不截断（卡片那边折叠）。
- 等的时候 agent 进程不释放，不设超时。主发回 `/node/v1/permissions/:request_id` → `respondToPermission`。
- 节点或 agent 进程重启：未答的请求全部作废，向主报 `turn_end: interrupted`；主把卡作废、任务进「需要你处理」，我再答时开 `resumeSession` 重新问。
- 我在等的时候发消息：主先发「拒掉这条」再发插话（§办3.4）；节点只照做。

## sbot MCP（02「远端节点怎么调主的 MCP 工具」）

- `sbot-node mcp --session <ref>`：stdio MCP server，经本机 socket 连节点守护进程，守护进程转 `POST /node/v1/tool-calls`。
- 工具列表由主下发（hello 的回复里带 schema），节点不写死；主按三列表第二列加 `submit_report`、`ask` 给。
- 反向开放：我自己开的 agent 也能挂 `sbot-node mcp`（不带 `--session`，算这台节点的 ad hoc 调用）；主那边 `mcp_open` 关着就全部 403。

## 本机节点专有：exec、fs、check

- `POST /node/v1/exec { cmd, cwd, env?, stdin? }`：`bash -lc`（Windows `pwsh -NoProfile -Command`），以节点账号跑；输出流式回 `run_items`（经主）；不设时长和输出上限，主 agent 的「停」会发 `interrupt` 杀进程组。
- `fs/read`、`fs/write`：路径照 03 的命令守卫在主上先过一遍，节点不再判（守卫只放一处）。
- 只有本机节点（`device_id = local`）收这几条；远端节点收到回 403 ※（主 agent 的 `bash` 设计上就是经本机节点，§办1.2）。
- Linux 主机模式：每个 agent 和 exec 经 `deploy/worker/worker-exec --host` 起 transient service（沿用，不另起 `systemd-run --user`），`MemoryMax=6G`、`KillMode=control-group`、`OOMScoreAdjust=+500`，去掉 `RuntimeMaxSec`（§办3.4）。沙箱模式（`sbot-w`，1G）照旧可选。

## worktree 和 CI（§办3.4）

- 派活带 `repo`：这台机器上同一仓库已有任务在跑 → `git worktree add <repo>/.sbot-wt/<task> -b sbot/<task>`；否则直接在原目录。路径报给主（`worktrees` 表）。
- 清理只在主发 `worktrees/cleanup`（我点了）时做：`git worktree remove`，分支不删 ※（分支可能挂着 PR）。
- CI：主发 `git/checks { repo, pr }` → 节点用 `gh pr checks --json`（或对应平台 CLI）查 → 回结果；红了主再发 `turns { text: 失败日志 }` 叫醒同一个 session。PR 评论只认我（`people.yaml` 里我的 git 平台身份，主下发）。

## 空闲释放和排空

- 释放：主发 `DELETE /node/v1/sessions/:ref` → `adapter.release`；有活或有等待点时节点拒绝并说明（主不该发，防一手）。
- 排空：不接新的 `sessions`/`turns`；等正在跑的轮次结束；超时（主给，默认 30 分钟）后按重启处理（等待点作废）。

## 升级（veto 8，round-1 第 8 题）

1. hello 回复里 `target_sha` 和自己的不同 → 进升级。
2. `git fetch origin` → `git cat-file -e <sha>` → 校验 `git merge-base --is-ancestor <sha> origin/main`（只认合进 `main` 的提交，主被冒充也推不来别的代码）→ `npm ci --ignore-scripts -w node -w protocol` 到一个新目录（`releases/<sha>/`，同 01 的布局）→ 跑 `node --check` 自检。
3. 排空 → 切 `current` → 进程退出码 75，由服务管理器（systemd / launchd / 计划任务）拉起新版本。
4. 新版本连不上主、或 30 秒内崩：服务管理器第二次拉起时 `main.ts` 看到 `ROLLBACK_FROM` 标记就切回旧目录，并在 hello 里报「升级失败」。

## 安装和配对

- `deploy/node/install.sh`（Linux、Mac）、`deploy/node/install.ps1`（Windows）：克隆到 `~/.local/share/sbot-node`（Windows `%LOCALAPPDATA%`）、`npm ci --ignore-scripts`、装服务。
- 配对：`sbot-node pair '<链接>'`（链接来自 `sbot pair --node`、客户端「加一台」选节点、飞书 `/pair node`）。设备私钥：Linux 存 `~/.config/sbot-node/device.key`（0600）；Mac 存钥匙串；Windows 用 DPAPI 加密存文件 ※（节点没有 Electron 的 `safeStorage`；同一系统用户的进程读得到，同 §底3.8 第二行）。
- 本机节点不配对，连 `hub.sock`（03 link）。Windows 主：named pipe `\\.\pipe\sbot-hub`，ACL 只给主的账号和本机节点账号；Mac、Windows 当主时两者同一个用户（§底3.8）。
