# P5–P8 适配器探针

验证四个适配器（Claude Code、Codex、pi、ACP）的插话、权限、续接、MCP，对应 `docs/tech/08-probes.md` 的 P5–P8。结果写在那里。

适配器骨架（`adapter.ts` 的接口和统一事件，`adapters/*.ts`）按 `docs/tech/05-node.md` 写，W4 搬进 `node/src/adapters/`；`cases/`、`lib/`、`run.ts` 只是探针，不搬。

## 跑法

```bash
cd probes/p5-p8
npm ci --ignore-scripts          # 版本都锁在 package.json；esbuild 的 postinstall 只是 acpx 带的 tsx 用，跳过无影响
node run.ts claude               # 或 codex | pi | acp
node run.ts acp acp:progress-md  # 只跑某几项（项的 id 见 cases/）
TIMES=1 node run.ts pi           # 先试跑一次；默认每项 3 次，3/3 才算 true
PROBE_DUMP=/tmp/events.log node run.ts claude steer   # 把增量以外的事件记下来排查
```

结果写到 `results/*.json`（不进 git），终端同时打印每次的结论和事件到本机主替身的延迟。

前提：本机已装并登录 `claude`（SDK 自带二进制）、`codex`、`pi`；ACP 一项用 `@agentclientprotocol/claude-agent-acp`，认的是 Claude 的登录。每项用一个 `/tmp` 下新建的 git 仓库当 cwd，不会碰别的目录。

## 选模型（环境变量，不写进仓库）

| 变量 | 作用 |
|---|---|
| `PROBE_CLAUDE_MODEL` | Claude 和 ACP 用的模型，默认 `haiku`；effort 固定 `low` |
| `PROBE_CODEX_MODEL` | Codex 模型，不设用 Codex 默认；reasoning effort 固定 `low` |
| `PROBE_PI_PROVIDER`、`PROBE_PI_MODEL` | pi 的 provider 和模型，不设用 pi 的默认 |

用环境变量鉴权（`ANTHROPIC_API_KEY`、`ANTHROPIC_AUTH_TOKEN`、`CLAUDE_CODE_OAUTH_TOKEN`）时，Claude 用一个一次性的 `CLAUDE_CONFIG_DIR`，不碰本机自己的设置和 hooks；此时「用户规则」那一半也一起测。用本机登录态时只测项目规则。

## 结构

| 文件 | 作用 |
|---|---|
| `lib/hub.ts` | 主替身：unix socket 上收事件、按 `hrtime` 记延迟、答 `sbot_ping` 工具调用 |
| `lib/mcp-stdio.ts` | `sbot-node mcp` 的替身：stdio MCP server，经 socket 转给主替身 |
| `lib/harness.ts` | 起主替身、造一次性 git 仓库、订阅事件、答权限请求、每项跑 N 次 |
| `lib/quota.ts` | 额度上限特征串（出处见 08） |
| `cases/common.ts` | 三家以上共用：插话、续接、MCP；`cases/kill-child.ts` 是被杀的那个「节点进程」（整棵进程树 SIGKILL） |
| `cases/p5-claude.ts` … `p8-acp.ts` | 各家独有的项 |
| `adapters/pi-sbot-ext.ts` | pi 扩展：`registerMcpServer` 挂 sbot，并拦截探针范围外的 bash（pi 没有权限请求，这只是探针的护栏，正式节点不带） |

## 写法上的几条（踩过的）

- 插话那一项的提示词要把两条命令放在两次回复里：并行发出就没有工具边界，插话无处生效（第一版踩过，Codex 和 pi 因此误报过 1/3、2/3）。
- 权限那一项要先让 agent 处在「会问」的模式：Claude 的项目规则要工作区已信任才加载（SDK 不弹信任框，探针预写 `.claude.json`）；claude-agent-acp 新 session 起在 `auto`，要 `session/set_mode` 切回 `default` 才有权限请求。
- 回答权限请求的策略默认只放行 `sleep`、`touch second.txt` 和 sbot 工具；要让 agent 读文件的项（`acp:progress-md`）单独放行只读命令，否则 agent 改用 shell 读会被探针自己拒掉。
