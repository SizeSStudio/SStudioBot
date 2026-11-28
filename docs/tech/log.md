# 重写施工记录

按 [09-waves.md](09-waves.md) 推进的长程任务的状态。额度用完或被打断时，下次从「断点」接着做。

## 断点

- 当前：W0 ② 探针除 P2、P4 安卓真机项外都已合（P10 #37、P1 #38、P9 #40 纸面、P3/P4e/P11 #42、P5–P8 本 PR）。W1a #35、W1b #39、W1c #43 已合；W1d（分支 `w1d-hub-run`）、W1e（分支 `w1e-hub-channels`）两个子线程并行在做。
- 11-27 21:20 前后所有子线程同时死于「Claude API server error」（额度），11-28 在各自线程里续上，worktree 里的半成品都在。
- 下一步：W1d 交来逐行审（闸门、审批、代理、守卫），W1e 交来审；先合的那个，另一个 rebase。两个都合了做 W1 验收（09 清单，测试 home 上逐条跑），然后向我报 W1。P2、P4 安卓真机项等手机。
- 被打断时：`git ls-remote --heads origin 'probe/*' 'w0-probe-*' 'w1*'` 看哪些交了；子线程死了先看它的 worktree（`git worktree list`）里有没有半成品，有就在原线程里续，没有才按本表重开。

## 等你过目

- 飞书后端暂定官方 SDK `@larksuiteoapi/node-sdk` 1.77.0（P9 ※，纸面；lark-cli 的 CardKit 按每次约 3 s 推算过不了）。有测试应用后照 08 P9 的清单真测，不过再换。
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

## 等你准备

| 什么 | 卡住哪几项 | 没有时怎么走 |
|---|---|---|
| 安卓手机连上 adb | P1 Hermes 速度、P2、P4 安卓、P11 安卓项 | 先用安卓模拟器测能测的，真机项标「待测」 |
| Firebase 项目、`google-services.json`、FCM 服务账号 | P2 FCM、W3 推 | `fcm.enabled` 关着，推走飞书 |
| 单独的飞书测试应用 | P9 卡片回调 50 次、W1 起要真发的验收项 | 测试 home 里飞书 `shadow` 模式（09） |
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
| W1d 跑起来 | inbox、runner（pi 嵌入，换模型按 P10）、tools（三列表 + `readOnly` + 守卫 + 打码）、approvals、outbox + 出口组、proxy、egress、本机节点最小件（exec、fs、check，经 `hub.sock`） | 子线程（Opus），我逐行审（闸门、审批、代理、守卫） | PR 审中（分支 `w1d-hub-run`） |
| W1e 渠道和账本 | channels（ChannelPlugin + 飞书，`shadow`，后端按 P9）、sources、triage、ledgers、memory、timers + Sentinel | 子线程（Opus），我审 | #46 已 rebase 到 W1d 上并合在一起（一个渠道注册表、W1d 的 `SendResult`/`OutboxRow`、启动接在 outbox 前、分拣经代理），待审 |
| W1 验收 | 09 W1 验收清单在测试 home 上逐条跑 | 我 | |
