# 重写施工记录

按 [09-waves.md](09-waves.md) 推进的长程任务的状态。额度用完或被打断时，下次从「断点」接着做。

## 断点

- 当前：W0。① 已合并装上、验收过；③④ 已出；② 探针分给 5 个子线程在跑（下表），各自开 PR 填 08 的「结果」，我看过再合。
- 下一步：探针 PR 逐个审、合。W1a（骨架，不依赖探针）先做；W1b 等 P1，W1d 等 P10，W1e 等 P9（W1 的拆法见下）。P2、P4 安卓真机项等手机。
- 被打断时：`git ls-remote --heads origin 'probe/*' 'w0-probe-*'` 看哪些探针交了；没交的重开子线程，brief 照本表「探针」一行。

## 等你过目

- 旧库只有约 11 天的消息；按实测，W6 全量重读的模型花费约 18 美元（30 美元的默认上限以内，04 §13）。正式 `import plan` 超 30 美元时我会停下来问。

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
| ② 探针 | 进行中 | 子线程：P1（Opus，分支 `probe/p1`）、P5–P8（Sonnet，`probe/p5-p8`）、P3 + P4 桌面 + P11（Opus，`probe/p11`）、P10（Sonnet，`probe/p10`）、P9（Sonnet，`probe/p9`，没有测试应用，只做静态部分和测试架子）；P2、P4 安卓等手机 |
| ③ 旧库实测 W0-1…6 | 完成 | 04 §13「W0 实测结果」 |
| ④ 旧库清点（W6 基线） | 完成 | 服务器 `/srv/data/sbot/rebuild/w0/w0-baseline.json`；仓库只记聚合数（04 §13）。脚本在 `probe/w0-db` |

### W1 主的骨架 + 飞书

拆成几块，各一个 PR，按顺序合（后一块依赖前一块的目录和约定）：

| 块 | 内容 | 谁写 | 状态 |
|---|---|---|---|
| W1a 骨架 | 根 workspace、tsconfig、`protocol/` 的 frames（含分片）、envelope、version、第一批 schema 和登记表；`import-check`、`protocol-check`；CI 的 server、protocol 步骤；`CLAUDE.md` 依赖方向 | 我 | 本 PR |
| W1b Noise | 从 `probe/p1` 搬 `protocol/noise/`，过 cacophony 向量 | 我逐行审 | 等 P1 |
| W1c 主的基座 | config（zod、`widening()`、表单描述、唯一写路径、`config_changes`、seed 同步）、db（04 全部表、`change_log` 触发器、清理）、cli 骨架、backup + restore、`hub/test/test-home.sh` | 子线程，我审 | |
| W1d 跑起来 | inbox、runner（pi 嵌入，换模型按 P10）、tools（三列表 + `readOnly` + 守卫 + 打码）、approvals、outbox + 出口组、proxy、egress、本机节点最小件（exec、fs、check，经 `hub.sock`） | 我写或逐行审（闸门、审批、代理、守卫） | 等 P10 |
| W1e 渠道和账本 | channels（ChannelPlugin + 飞书，`shadow`，后端按 P9）、sources、triage、ledgers、memory、timers + Sentinel | 子线程，我审 | 等 P9 |
| W1 验收 | 09 W1 验收清单在测试 home 上逐条跑 | 我 | |
