# 01 仓库布局、约定、CI、部署

## 目录

```
protocol/            三端共用（主、节点、客户端），没有运行时状态
  envelope.ts        中继唯一看得懂的部分（06）
  frames.ts          通道里的应用帧（02）
  noise/             Noise_NK_25519_ChaChaPoly_SHA256（02）
  api/               /api/v1 的实体和路由，zod schema
  node/              主 ↔ 节点的指令和回报，zod schema
  version.ts         PROTOCOL = { current, min }
hub/                 主，单进程（03）
  src/  channels/feishu/  seed/  test/
node/                节点程序：本机节点 + 远端节点（05）
relay/               中继（06）
clients/             npm workspace，自己的 lockfile（07）
  app/  desktop/
deploy/
  hub/  relay/  node/            新的 unit / plist / 安装脚本
  worker/                        沿用：sbot-w 沙箱、netfilter、worker-exec
  backup-mac/                    沿用，节点通道稳了换成经节点传（03 备份）
  core/  console-web/  lens/     W7 切换后随 core 删
scripts/             leak-guard.sh、deploy.sh、import-check.ts、protocol-check.ts
core/                冻结：只修线上故障；W7 切换后整个删
docs/tech/           这套文件
```

- **依赖方向**：hub、node、relay、clients 只 import `protocol/`，彼此不 import，谁都不 import `clients/`。`relay/` 只 import `protocol/envelope.ts`。`core/` 和新目录互不 import。`scripts/import-check.ts` 在 CI 里查。
- W1 开 `protocol/` 时同一个 PR 改仓库 `CLAUDE.md` 的「依赖方向」一条（`core/protocol/` → `protocol/`）。`core/protocol/config-form.ts` 的定义搬进 `protocol/api/config-form.ts`，旧控制台用到切换为止。

## 包和依赖

- 服务端一个 npm workspace：根 `package.json` 列 `protocol`、`hub`、`node`、`relay`，一份根 lockfile。`clients/` 单独一份（07）。
- 部署时导出要的目录和根清单到 `releases/<sha>/`，在 release 根上 `npm ci --ignore-scripts -w <单元> -w protocol`；`node_modules` 在 release 根，`protocol/*.ts` 往上找得到依赖；按 lock 哈希共用（同 §底1.3）。
- 版本全锁（`save-exact`）。新依赖先查 install 脚本，`--ignore-scripts` 下装不全的不收。
- 首批服务端依赖：
  | 包 | 谁用 | 为什么 |
  |---|---|---|
  | `zod` 4.x（落地 4.6.7） | 全部 | schema 只写一次（工具、协议、配置） |
| `typescript` 7.x（落地 7.0.2）、`@types/node` 24 | 开发 | 只做类型检查（`tsc -p tsconfig.json`），平台二进制是可选依赖，没有 install 脚本 |
  | `@noble/curves`、`@noble/ciphers`、`@noble/hashes` | protocol | Noise、Ed25519；纯 JS，Hermes 能跑 |
  | `ws` 8.23.x | relay（hub、node 视 P1 结果） | 中继服务端；Node 自带的 WebSocket 只有客户端 |
  | `yaml` | hub | 配置（沿用） |
  | `@earendil-works/pi-coding-agent`、`pi-ai` | hub | 主 agent 嵌入（锁版本，升级先跑探针） |
  | `@larksuiteoapi/node-sdk` 或 lark-cli | hub/channels/feishu | P9 定 |
  | `age-encryption` | hub | 备份公钥加密（纯 TS） |
  | `@anthropic-ai/claude-agent-sdk`、`@agentclientprotocol/sdk` 或 `acpx` | node | 适配器（P5–P8 定版本） |
- codex、pi、claude 的 CLI 是节点机器上已装的程序，不进 lockfile；节点 hello 时报版本（05）。

## 代码约定

- Node ≥ 24 直接跑 `.ts`（服务器现在是 26.x LTS）。只写可擦除 TS：tsconfig 开 `erasableSyntaxOnly`、`verbatimModuleSyntax`、`allowImportingTsExtensions`、`noEmit`。相对 import 带 `.ts`。
- 存储 `node:sqlite`；测试 `node --test`，不引测试框架；`tsc` 只在 CI 和本机做类型检查。
- 注释写为什么，简短。
- 时间一律 ms 整数；按 `self.yaml` 的时区显示和算「夜间」「明早」。
- id 规则唯一出处是 04 的「约定」：业务表自增整数；run `r_…`、task `t<n>`、thread `th_…`；`device_id` 由公钥算。
- 日志：一行一个 JSON；写之前过打码函数（和 `run_items` 同一个，03）；密钥的值永不进日志、事件流、工具调用记录。
- 配置：`$SBOT_HOME/config`（git），zod 校验；每次改动写 `config_changes`；放宽项进 `widening()`，表单描述同步改（Y11，03）。

## 跨平台（主三个系统都能当，§办3.1）

- 路径都从 `SBOT_HOME` 派生，不写死 `/srv`。Linux 上 `SBOT_HOME=/srv/sbot`，数据盘布局照 §底1.3。
- 服务：Linux systemd；Mac launchd（`~/Library/LaunchAgents`）；Windows 用计划任务开机启动，不引第三方服务包装 ※。
- 账号：Linux 主用 `sbot`，本机节点用 `sbot-h`（主机模式）或 `sbot-w`（无特权）。Mac、Windows 当主时，主、节点、command 插件、排盘脚本都以同一个用户跑（我定，记进 §底3.8）。
- 本机连接：Linux、Mac 用 unix socket（`$SBOT_HOME/run/`）；Windows 用 named pipe 加 ACL（05）。
- Linux 专属件（`sbot-deploy`、bwrap、iptables `SBOT_W`、systemd scope 内存上限）是可选件；别的系统上没有就照跑，状态页写明缺哪件。

## CI（GitHub Actions）

落地（W1a）：leak、server、protocol、core、shell 都是同一个必过的 `check` job 里的步骤，每个 PR 都跑（几十秒，省得按路径拆 job 后必过检查对不上）；clients 以后单独一个 job。`protocol-check` 的快照在 `protocol/snapshot.json`，出 App 时 `node scripts/protocol-check.ts --write`；`import-check` 也扫 `core/`（只查方向，不查 `.ts` 后缀）。

| job | 什么时候跑 | 做什么 |
|---|---|---|
| leak | 每个 PR | `scripts/leak-guard.sh` |
| server | 改了 `protocol/`、`hub/`、`node/`、`relay/`、`scripts/` | `npm ci --ignore-scripts`；`node --check` 全部 `.ts`；`tsc --noEmit`；`import-check`；`node --test` |
| protocol | 改了 `protocol/` | `protocol-check`：和上一次 App 发布时存下的 schema 快照比，删字段、收窄类型、删路由、删事件类型就不过。第一次发布前没有基线，只生成快照不拦（IZ-10） |
| clients | 改了 `clients/` 或 `protocol/` | 见 07 |
| core | 改了 `core/` | 沿用现在的检查，W7 随 core 删 |
| shell | 每个 PR | `bash -n` 全部 `.sh`（沿用） |

冒烟测试在服务器上跑，每次一个新的一次性 home（`core/test/vps-test-home.sh` 的用法，W1 出 `hub/test/` 的版本）；端口 7829–7831 可以并行；不删 testhomes。

## 部署

- **W0 先改 `sbot-deploy`**（§附2.21 R3）：按单元比较 `git rev-parse "$sha:<路径>"`，和上次部署记下的树 hash 一样就不切、不重启；每次检查过的 sha 记下来。必须在任何重建 PR 合入 `main` 之前上线，否则每个 `hub/`、`docs/` 的合并都会重启线上核心。改完手动跑 `deploy/core/install.sh`。
  - W0 落地（PR 见 `log.md`）：一个单元，路径 `SBOT_DEPLOY_PATHS`（默认 `core`）、服务 `SBOT_DEPLOY_UNIT`；树记在 `$APP/current.tree`；没有这个文件时（刚装上）从 git 算线上 release 的；和失败过的树相同的新提交不再试；`--force` 照切。测试 `deploy/core/test/sbot-deploy.test.sh`（CI 里 root 跑，systemd 打桩）。W2 加 `relay` 时扩成多个单元，各有自己的 `current`。
- 单元在 `/etc/sbot/deploy.env` 里配：
  - 切换前：`core` = 路径 `core`。
  - W2 起加：`relay` = `relay protocol/envelope.ts`（中继只认信封，协议别处改了不重启它）※，跑 `deploy/relay/install.sh`。
  - 切换（W7）后：`core` 换成 `hub` = `hub protocol`，跑 `deploy/hub/install.sh`（09）。
- 节点不归 `sbot-deploy` 管：主在节点 hello 时给目标 sha，节点自己 fetch、校验、排空、重启（05）。主所在那台的本机节点也一样。
- `clients/` 不随主上线（07）。
- 健康检查、自动退回、管理通知照 §底1.3，判据改成新进程打出 `hub up`、15 秒后还是同一个进程。
- Mac、Windows 当主时手动更新：`node hub/src/cli.ts upgrade --ref <sha>`（同一套导出和切换，少了 timer）。
