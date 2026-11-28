# 重写施工记录

按 [09-waves.md](09-waves.md) 推进的长程任务的状态。额度用完或被打断时，下次从「断点」接着做。

## 断点

- 当前：W0 ② 探针除 P2、P4 安卓真机项外都已合。W1 完成（#35、#39、#43、#45、#46、#47）。W2 完成（#49–#52，验收 #56），只剩要公网中继、手机、飞书测试应用的三项。W3、W4 的 schema 已合（#55、#54），W3 客户端已合（#58）；W3 主的一侧（`w3a-writes` → `w3b-push`）、W4（`w4a-hub` → `w4b-node`）停着，等换模型。
- 11-27 21:20 前后所有子线程同时死于「Claude API server error」（额度）。11-28 按你说的换 Gemini 4 Neon（magpie-us）续：W3c 做完合了；W3a、W4a 半路被 403 停掉（Google 停了那个账号的 Antigravity），这条路不能再用。半成品都存成本地 ref（没推）：`refs/wip/w3a-writes`、`refs/wip/w4a-hub`（换 Neon 前），`refs/wip/w3a-writes-neon`、`refs/wip/w4a-hub-neon`（Neon 做到的，含前者，基于 08985c2）。
- 下一步：换好模型后，W3a 从 `refs/wip/w3a-writes-neon`、W4a 从 `refs/wip/w4a-hub-neon` 接着做（W4a 的 `api/index.ts` 和 #54 的 `nodeView`、`nodes` 冲突，两边都留）；`w4a-hub` 合了开 W4 客户端一侧（任务 thread、步骤、diff、节点页）；`w3a-writes` 合了让 W3 客户端补 e2e。审：W3 的审批、闸门、鉴权逐行；W4 的节点权限、沙箱、`deploy/node/` 逐行。W2 验收里经中继公网入口、手机、飞书测试应用的几项停下等我（等你准备）；`deploy/relay/`、`deploy/node/` 写好不装。
- 被打断时：`git ls-remote --heads origin 'probe/*' 'w0-probe-*' 'w1*' 'w2*' 'w3*' 'w4*'` 看哪些交了；子线程死了先看它的 worktree（`git worktree list`）里有没有半成品，有就在原线程里续，没有才按本表重开。

## 等你过目

- 飞书后端定官方 SDK `@larksuiteoapi/node-sdk` 1.77.0（P9 ※，08）：11-28 用线上应用真测（没有单独的测试应用，你定的），没推翻。lark-cli 两项真不过：CardKit 每次约 2.9 s；`event consume` 独占，应用上已有长连接就拒绝启动。点击 50 次还要人，在 08 P9 的点击清单里（约 10 分钟）。
- CardKit 限频按应用计（P9 真测，08）：12 张卡同时各 2 次/秒，每张都恰好被限 22 次。同时流式的卡最多约 8 张，W7 前和旧核心共用；主的 CardStream 一次一个在途，约 1.3 次/秒，不改。
- 飞书断一下，最多约 1.5 分钟收不到（P9 真测：服务端下发重连间隔 90 s，恢复后 82 s 才连回）：私聊靠重连后 `catchUp` 补，点击算丢。SDK 遇到 `system_busy` 这类回码会永久放弃，主的 `SdkBackend` 改成自己隔 1–10 分钟重开（这个 PR）。
- `/tasks` 真测时（分支基于 #60 之前的 main）落到模型；W3a（#60）已把它做成确定性命令（`channels/commands.ts`），W7 前在线上应用上复测一次。
- 断网期间的卡片点击算丢（P9 ※，08）：飞书不重投回调，两个后端都一样；卡片还在，恢复后再点，审批也能在客户端批。
- user 身份读群、查已读、飞书邮箱、批准后以我名义发，照旧用主机器上的 lark-cli（P9 ※，03）：W1e 看过，SDK 的 user 令牌要自己做授权和续期，先不换，都关在 `feishu/user.ts` 一个文件里。
- SDK 默认日志会带出 `app_secret` 和令牌（P9 读源码发现）：飞书插件必须传自己的打码 logger，升级 SDK 要重跑那两条测试。
- 主和节点的 Noise 加密用 `node:crypto`（OpenSSL）而不是 noble（P1 定的 ※，02）：同一接口，快 5 倍，两个后端字节一致、互通。想全用 noble 说一声，改一行 `useCrypto`。
- 旧库只有约 11 天的消息；按实测，W6 全量重读的模型花费约 18 美元（30 美元的默认上限以内，04 §13）。正式 `import plan` 超 30 美元时我会停下来问。

- W1c 的 ※（#43、03、changelog）：放宽项新加了换管理群或工作台群、飞书 `shadow` → `live`、出口组加出口、换备份公钥、加备份推送节点、owner ID 新填或换掉；备份由 03:30 的 `backup` 任务跑，没公钥只通知不拦启动；`sbot restore` 本地跑，`--force` 是挪开不删；`daily_budget_usd` 和 `budgets.daily_cost` 都写时取小的；§寸8 补了 `breaker: 3`、`stuck_minutes: 20`、`tidy_wait_minutes: 30` 三个默认值。
- 恢复时 home 外已有的 `secrets.env`（线上布局）也算「不是空的」，要 `--force`，旧的复制进 `.pre-restore-…/`（审 #43 时我改的）。
- W1e 的 ※（#46、03），和 W1d 合在一起之后：
  - Linux 主上 command 源拒跑：`worker-exec` 还没有插件模式（`deploy/`，另开 PR），这期间明确报「这台主上还没接插件运行器」，不退回以主的身份跑。Mac、Windows 当主时同一用户跑。
  - Sentinel 告警、分拣提醒在 push 接上前都走 `notify.admin`（管理通知出口组）。
  - user 身份（读群、查已读、飞书邮箱、批准后以我名义发）用主机器上的 lark-cli，`HOME` 是 home 里的 `lark/`，测试 home 里没登录就什么都读不到。
  - 搬来的账本、timers、分拣模块用 `db/ambient.ts` 的全局 db（启动时 `setDb`，关时清掉），也从 `SBOT_HOME` 找 home；线上一直设着，测试里要设。
  - Sentinel 还不查异地备份，等备份同步到节点再加。
  - 长连接断开再连上后，待批的卡不重发、不刷新：断网期间点的算丢（P9），卡还在，再点一次或在客户端批。
  - 合并时定的：分拣开了，模型经代理（每次调用一个 light 令牌，用完吊销）；`runDraft` 还没接，draft 眼下都降成提醒；以我名义发时对不上审批行就 `retry:false`，不重试也不发；卡片点击由代码处理（审批 → `decide`，群开关 → `actions.ts`），不进 run。
- 安卓客户端代码块折叠阈值 400 → 200 行，仍先显示前 80 行（P11 ※，08）：400 行整块一个 `<Text>` 时安卓 UI 线程卡 20 多秒。
- 节点上 Claude Code 的工作区信任默认不预记，只用用户级规则；按仓库开、默认关、走 `widening()`（P5–P8 ※，05）。预记会让仓库里 `.claude/` 的 hooks 和 MCP 配置生效，等于跑仓库里的代码。
- ACP 新 session 默认 `auto`、不发权限请求，节点建 session 后切到 `default`（P5–P8，05）。
- W1d 的 ※（PR 描述「等过目」有全表）：run 令牌放内存 credential store 不走环境变量；出网代理 7820–7828；连崩两次按 `inbox.tries`；熔断后非我输入直接 `failed`；找不到插件的发件标 `unrouted`；check 命令也过命令守卫；令牌不设 TTL；exec 每路输出留前 300 KB。
- W1d 审后的 ※（#45「审后修」）：稳住对方的两句键名 `hold_text`、`hold_timeout_text`；承诺检测最多等 60 秒，调不通、不成形、超时都按命中；他人会话的出错提示改发管理出口；`hub.sock` 挪到 `$SBOT_HOME/node/`（0750，属组 `SBOT_NODE_GROUP`），部署时 `$SBOT_HOME` 要给节点组 `x`（0710），W7 写进 `deploy/`。
- W1 验收的 ※（`w1-accept`）：
  - 只有我打字的 run（typed 列）流式出卡片；定时、系统、他人会话的 run 照旧整条回。卡片开出来就算回复，不再另发一条；没开成（`shadow`、出错）才退回普通回复；超长的余下部分分条补发。
  - 群草稿是 W1d 的 run：`role draft`、work 档、src `group:<chat>`（他人列）、只给他人列的只读工具、新 session、只带那一个群的上下文；turn 的渠道是 `draft`，没有插件接，写出的回复只会标 `unrouted`。草稿不进 inbox，跑到一半主挂了，这条草稿算丢（run 标 interrupted），下一轮分拣不重起。
  - 分拣的承诺检测换成 W1d 那一份（`proxyCommitChecker`，同一提示词，调不通按命中）；没接时退回原来的 `checkSystem()`。
  - 重启提示只数 `text` 行：流式卡片发出过的，提示里是「有过对外的动作」，不报条数。
  - `check` 在本机节点的默认工作目录跑，先过命令守卫；节点没连上就算 check 坏了（照常跑并告警一次）。
  - 每晚 `backup` 任务接上了 `runBackup`（之前 `do: backup` 没有处理函数）。

- W2b 的 ※（#50）：lane 只分 `personal`、`work`；正在流的文字推给每个连着的客户端；W3 之前 `/api/v1` 的写一律 404；不建 lane 索引。
- W2a 的 ※（#51 描述有全表）：
  - 中继只听 `127.0.0.1:7840`，`X-Real-IP` 只在对端是回环时认；域名 DNS 只解析，不过 CDN；自保默认值在 `relay.yaml` 里可改；v1 主密钥不轮换。
  - 认证限 10 秒；见过的公钥（删了的也算）不能再配；`authorize` 只认规范路径（`..`、空段、`%`、`\` 一律 403）。
  - 没见过的 IP 段按「通知」发，不按安全告警；W3 之前设备通知都走 `notify.admin`，设备的写只在 `hub-admin.sock`。
  - `relay.url` 要以 `/v1/hub` 结尾，`ws://` 只许回环；`relay.enabled` 启动时读。
  - 飞书 `/pair` 回的配对链接留在发件表里：10 分钟或用一次就作废，06 已写明这条路经过飞书的服务器（审 #51 时我认的）。
  - 审 #51 时记下没改的两处小毛病：中继拒绝日志里的路径没截长度；SIGHUP 重读不改心跳间隔。
- W2c 的 ※（#52 描述有全表）：设备上中继只认 `wss://`（`ws://` 只许回环）；每次配对一把新钥匙，「解除配对」连私钥一起删；桌面配对码只在主进程内存；`webRequest` 再拦一层，只放行连配对中继的 WebSocket；安卓 quick-crypto 自检不过就留 noble；`style-src` 带 `'unsafe-inline'`（RN web 要）；产物超基线 20% 只警告；clients job 暂不设必过。
- W3c 的 ※（#58）：
  - 配对二维码用 `uqr` 画成 View，默认收起，点了才显示。
  - 审批锁在屏幕上那一版 `draft_version`；草稿变了先点「看过了」才能批。改草稿撞上 409 时留着我打的字，不被主的版本盖掉。
  - 在场：30 秒节流；切视图 2 秒内合成一条；转到后台立刻发 `foreground:false`。
  - 推送：先用 `{token:null}` 探主的 `fcm_enabled`，开着才要通知权限和令牌；`personal` 的推只写「有一条私人的」；点开到 `/item/<ref>`。没有 `google-services.json` 时推送模块不动。
  - 桌面 HTML 预览按 `body` / `body.html` 认；`html.open` 校验 sha256、大小 ≤ 20 MiB，缓存目录不许是链接、属当前用户 0700，文件 0600，24 小时清。
  - 安卓的小偏好放 SharedPreferences（键 `[a-z_]{1,32}`、值 ≤ 200 字），不放钥匙。

## 等你准备

| 什么 | 卡住哪几项 | 没有时怎么走 |
|---|---|---|
| 安卓手机连上 adb | P1 Hermes 速度、P2、P4 安卓、P11 安卓项 | 先用安卓模拟器测能测的，真机项标「待测」 |
| Firebase 项目、`google-services.json`、FCM 服务账号 | P2 FCM、W3 推 | `fcm.enabled` 关着，推走飞书 |
| 你在飞书里点约 10 分钟（08 P9 点击清单；不用单独的测试应用了，用线上应用 + 测试群「sbot 测试」） | P9 卡片点击、卡片回调帧类型、W1 真入站私聊和亲手批卡、断线补回；别人点被拒待第二个人；以我名义真发要一次 user 登录 | 不要人的几项 11-28 已真测（08 P9「真测」） |
| 中继域名（DNS 只解析）、nginx 一段、`relay.enabled` 开 | W2 验收里经中继真连的各项（手机扫码连上、中继抓包、20 连接实测在线上） | 中继在服务器本机 127.0.0.1 上测；`deploy/relay/` 写好不装，开不开你定 |
| 备份用的 age 公钥 | W1 备份加密的真机验收 | 测试 home 里用临时生成的一对 |

## 各波

### W0 预备

| 项 | 状态 | PR / 结果 |
|---|---|---|
| ① `sbot-deploy` 按树 hash | 已合、已装 | #32。服务器上 `install.sh` 跑完：合并 #32 那次记了 `unchanged`，核心 PID 没变 |
| 验收：只改 `docs/` 的合并不重启 | 过 | #33 合并后 timer 记 `4f6cef6 unchanged`，核心 PID、启动时间没变 |
| 验收：只改 `core/` 的合并照常上线 | 过（测试） | `deploy/core/test/sbot-deploy.test.sh` 的「core change goes live」「broken core rolls back」；`core/` 冻结，不为验收造真改动 |
| ② 探针 | 除安卓真机项外完成（P10 #37、P1 #38、P9 #40、P3/P4e/P11 #42、P5–P8 #44） | 子线程：P1（Opus，分支 `probe/p1`）、P5–P8（Sonnet，`probe/p5-p8`）、P3 + P4 桌面 + P11（Opus，`probe/p11`）、P10（Sonnet，`probe/p10`）、P9（Sonnet，`probe/p9`，没有测试应用，只做静态部分和测试架子）；P2、P4 安卓等手机 |
| ③ 旧库实测 W0-1…6 | 完成 | 04 §13「W0 实测结果」 |
| ④ 旧库清点（W6 基线） | 完成 | 服务器 `/srv/data/sbot/rebuild/w0/w0-baseline.json`；仓库只记聚合数（04 §13）。脚本在 `probe/w0-db` |

### W1 主的骨架 + 飞书

拆成几块，各一个 PR，按顺序合（后一块依赖前一块的目录和约定）：

| 块 | 内容 | 谁写 | 状态 |
|---|---|---|---|
| W1a 骨架 | 根 workspace、tsconfig、`protocol/` 的 frames（含分片）、envelope、version、第一批 schema 和登记表；`import-check`、`protocol-check`；CI 的 server、protocol 步骤；`CLAUDE.md` 依赖方向 | 我 | 已合 #35 |
| W1b Noise | 从 `probe/p1` 搬 `protocol/noise/`，过 cacophony 向量 | 我（照搬 + 逐行审） | 已合 #39 |
| W1c 主的基座 | config（zod、`widening()`、表单描述、唯一写路径、`config_changes`、seed 同步）、db（04 全部表、`change_log` 触发器、清理）、cli 骨架、backup + restore、`hub/test/test-home.sh` | 子线程（Opus），我审 | 已合 #43（审后我改了 restore 对 home 外 `secrets.env` 的处理、`self.yaml` 不进 `config_changes`；部署机冒烟 22/22） |
| W1d 跑起来 | inbox、runner（pi 嵌入，换模型按 P10）、tools（三列表 + `readOnly` + 守卫 + 打码）、approvals、outbox + 出口组、proxy、egress、本机节点最小件（exec、fs、check，经 `hub.sock`） | 子线程（Opus），我逐行审（闸门、审批、代理、守卫） | 已合 #45 |
| W1e 渠道和账本 | channels（ChannelPlugin + 飞书，`shadow`，后端按 P9）、sources、triage、ledgers、memory、timers + Sentinel | 子线程（Opus），我审 | 已合 #46（rebase 到 W1d 上合在一起：一个渠道注册表、W1d 的 `SendResult`/`OutboxRow`、启动接在 outbox 前、分拣经代理） |
| W1 验收 | 09 W1 验收清单在测试 home 上逐条跑 | 子线程（Opus） | 已合 #47。补了 `runDraft`、私聊流式卡片、check 接节点、`backup` 任务接线；部署机冒烟 `smoke-w1` 33/33、`smoke-w1d` 17/17、`smoke-w1e` 11/11。逐项：私聊流式卡片 测试过（假后端），11-28 真卡过（线上应用，`live-feishu.ts auto`，08 P9）；群 @我 → 草稿 → 审批 → 发 测试和冒烟过（`shadow`），11-28 真审批卡、真 PATCH「已批」过，以我名义的发送到假 lark-cli 正好是批过的那句；亲手点批、真入站私聊在点击清单，以我名义真发要一次 user 登录（没做）；我自己回了卡作废 过；中途 kill 过；self/ 守卫 过；来源标签 过；代理 401/403/只告警 过；check 三种结果 过；Y11 对齐 过（测试）；seed 不碰线上配置 过（测试）；备份 + 恢复 过 |

### W2 连接、设备、只读客户端

| 块 | 内容 | 谁写 | 状态 |
|---|---|---|---|
| W2b 只读 API | `protocol/api` schema；`change_log` pump、bootstrap、stream、视图函数、只读 `/api/v1` | 子线程（Opus），我审授权入口 | 已合 #49、#50（我 rebase 到 #49 上；冒烟 `smoke-w2b` 18/18） |
| W2a 中继和配对 | `relay/`、主密钥、经中继的 Noise 会话、配对、设备、角色、`deploy/relay/` | 子线程（Opus），我逐行审 | 已合 #51（服务器冒烟 20/20：20 台同时配对 138 ms，往返 p95 43 ms，删设备到断开 6 ms）。`deploy/relay/` 没装；unit 的系统调用过滤在服务器上用 `systemd-run --user` 试过，node 能起、反向对照被拦 |
| W2c 客户端只读 | 连接状态机、store、渲染、页面、Electron 壳、安卓密钥模块、CI clients job | 子线程（Opus），我逐行审（设备密钥、配对、不可信渲染） | 已合 #52（clients 68/68，桌面 selftest 在 GitHub 的 Linux 上也过了）。合并前查过：服务器上的 `sbot-deploy` 和 `main` 一致，按树判断 |
| W2 验收 | 09 W2 验收清单，中继在服务器回环上 | 子线程（Opus） | 已合 #56（`smoke-w2` 56/56，服务器 7829）。过：三条配对路、私聊流式（14 段，首段比整条早 1.5 s）、工具开始结束实时、连断 5 次不重不缺、切 thread 不发请求、中继抓包 2108 条无明文、错主公钥 4404/4401、重放 4401/4400、node 四条 403、20 连接（配对 p95 157 ms、请求 p95 22 ms、一行推 20 条流最多 97 ms）、删设备 5–6 ms 断开、外部请求 0、只改 `clients/` 不重启核心（PID 没变）。待：手机扫码（手机）、公网中继抓包（公网入口）。飞书真发 11-28 过了机器人一侧（真卡片流式、测试群话题回复、审批卡和改卡，08 P9「真测」）；我真在飞书私聊说一句、经长连接进来那一步在点击清单 1。顺手修了流式打码：中文整条才出来 → 在非 ASCII 字符后也可切；私钥块分几段来时中间会漏出 → 不在块里切（我逐行审过） |


### W3 写、审批、推送

| 块 | 内容 | 谁写 | 状态 |
|---|---|---|---|
| W3 schema | 写路由、`client_ops`、审批决定、看一眼和问我、thread、在场、已读、FCM 令牌、省心 | 我 | 已合 #55 |
| W3a 主的写 | `/api/v1` 写路由、`client_ops` 幂等、审批经 `decide`、草稿和重写、thread 操作 | 子线程，我逐行审（审批、闸门、鉴权） | 停着：Neon 被停，半成品在 `refs/wip/w3a-writes-neon` |
| W3b 推送 | 推送通道、FCM（`fcm.enabled` 关）、在场和已读、省心 | 子线程，我审 | 等 W3a |
| W3c 客户端 | 写层（离线排队、同一 `client_op_id` 重发、乐观覆盖、409/410 取主的）、审批卡、在场、安卓推送、桌面 `html.open` | 子线程（Opus → Neon），我逐行审 | 已合 #58（clients 95/95，根 230/230）。e2e 等 W3a |

### W4 任务和节点

| 块 | 内容 | 谁写 | 状态 |
|---|---|---|---|
| W4 schema | `/node/v1` 的会话、统一事件、权限、工具调用、CI、worktree；客户端的任务、节点实体 | 我 | 已合 #54 |
| W4a 主的任务和节点 | 任务、节点登记、会话、权限转审批 | 子线程，我逐行审（节点权限） | 停着：Neon 被停，半成品在 `refs/wip/w4a-hub-neon` |
| W4b 节点 | `node/`、ACP、沙箱、`deploy/node/`（写好不装） | 子线程，我逐行审 | 等 W4a |
| W4 客户端 | 任务 thread、步骤、diff、节点页 | 子线程，我审 | 等 W4a |
