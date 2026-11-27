# P9 飞书卡片回调：官方 SDK 对 lark-cli

`docs/tech/08-probes.md` 的 P9。同一套测量跑两个后端（`--backend sdk|cli`）。没有测试应用时只能跑 `npm test`（本地假服务器，不碰飞书）；真测要一个**单独的测试应用**，不能用线上实例的应用（同一应用的第二条长连接会分走线上的事件）。

## 没有应用：验证测试架子

```
cd probes/p9
npm ci --ignore-scripts
npm test            # node --test，24 项，约 35 秒；Node 24 和 25 都过
```

测试里 `mock-feishu.ts` 讲真的长连接协议（手写 protobuf，不借 SDK 的编解码）和用到的 REST，`fake-lark-cli.ts` 顶替子进程。验证的：确认在处理函数之后、返回值进回调响应、处理函数抛错回 500、分片事件、重连、同一 `event_id` 重投只处理一次、半开链路被 ping 看门狗发现、令牌失败时日志里没有 `app_secret`（并留一条对照：SDK 1.77.0 自带的日志会把它打出来）、50 次点击、流式限流报告、断网报告里漏掉的消息被算出来、lark-cli 子进程用隔离的 HOME、凭证只进子进程环境。

## 有测试应用：真测

### 准备（我来做）

- 自建应用，开长连接，订阅事件 `im.message.receive_v1`，回调 `card.action.trigger`；权限 `im:message`、`im:message:send_as_bot`、`im:message:readonly`（读群历史，netcut 对账用）、`cardkit:card:write`。
- 一个只有我和这个机器人的测试群。
- 凭证文件，JSON，放在 `~/.config/sbot/` 和 `/srv/sbot` 以外的地方（`run.ts` 拒绝这两处）：

  ```json
  { "app_id": "…", "app_secret": "…", "chat_id": "…", "test_app": true }
  ```

  `test_app: true` 必须有，是自己声明「这不是线上应用」。可选 `domain`：`https://open.feishu.cn`（默认）或 `https://open.larksuite.com`。文件只由 `run.ts` 读，值不打印；报告、日志过一遍打码，报告里没有 ID 和消息正文。
- lark-cli：`P9_LARK_CLI=<二进制路径>`。`npm install --ignore-scripts` 装的 npm 包没有二进制（它的 postinstall 才下载），指向 Release 里解出来的原生二进制，或任何已装好的 `lark-cli`。`cli` 后端用一次性 HOME 和配置目录，凭证只在子进程环境，不写盘；结束时 `event stop --all`（只停这个一次性配置目录里的 bus）。

### 跑

```
export P9_CREDENTIALS=<凭证文件路径>
export P9_LARK_CLI=<lark-cli 路径>        # 只 cli 后端要
node run.ts clicks --backend sdk          # 卡片发到测试群，我点 50 次
node run.ts clicks --backend cli
node run.ts netcut --backend sdk          # 默认：基线 20 s、断 30 s、等 360 s
node run.ts netcut --backend cli
node run.ts stream --backend sdk          # 默认 2 次/秒、120 秒
node run.ts stream --backend cli
```

启动先查 `online_instance_cnt`：有别的长连接就拒绝（读不到数字时要 `P9_ALLOW_UNKNOWN_CONNECTIONS=1`，只在确定这个应用只给探针用时设）。报告打到 stdout 的 JSON，进度在 stderr；退出码 0 = `pass` 里全是 `true`，2 = 有项不过，1 = 出错。`P9_STATE` 指定去重文件的目录（默认系统临时目录）。

### 每项怎么测、看什么

**clicks**：发一张带按钮的卡片，我点 `--clicks`（默认 50）次；每次点击：算处理函数耗时、事件创建到收到的间隔、是否带 `operator_id`、随后 PATCH 更新卡片；最后读回卡片确认最后一次更新在。
- `handled_under_3s`、`sdk_ack_ms`：SDK 的确认在处理函数之后，所以处理函数耗时就是确认耗时。lark-cli 的确认在交给我们之前就发了（`sdk_ack_ms` 是 n/a），这一项对它是「3 秒内」不适用的，改看 `event_to_handler_ms`。
- 回调响应：SDK 后端处理函数返回 toast，Feishu 端应看到提示；lark-cli 不可能有（没有响应体）。
- 点得太快：一张卡片一秒点多下，卡片更新串行，`card_updates.ms` 看每次 PATCH 耗时；PATCH 限 5 次/秒/消息。
- `event_to_handler_ms` 用本机时钟减飞书事件时间，时钟差几百毫秒内可信。

**netcut**：基线阶段我发一条消息、点一下卡；然后本地代理断开所有连接并拒绝新连接（`--mode reset`，默认）或让连接挂着不通（`stall`，半开，只有 ping 看门狗能发现）。断开期间我在测试群发几条消息、点几下卡，**记下数字**。恢复后等 `--settle-s`（默认 360 秒，飞书事件重投在 15 秒、5 分钟、1 小时、6 小时；要看 5 分钟那一档至少等 6 分钟，想看 1 小时那一档要改大）。结束后按群历史对账。
- 断网是本地代理做的，不动机器的真网络；`pass.through_proxy` 为 false 说明这个后端没走代理，这次什么都没断，结果作废（lark-cli 是 Go 程序，靠 `HTTPS_PROXY`，实测前不能保证；不行就改手动拔网并把这项标「手工」）。
- `messages_by_phase`：群历史里每个阶段发了几条、事件收到几条、漏几条。`no_message_lost` 要求每个阶段漏 0。
- 卡片点击只能看 `clicks_created_during_cut` 对你记下的点击数：飞书文档写回调不重投，两个后端预期都有缺口，08 的「不丢」对回调不成立，要分开写进结果。
- `duplicate_event_ids_dropped`：去重丢掉了几次重复投递；`message_ids_delivered_under_two_event_ids`：同一条消息用了两个 `event_id` 的次数（要用消息 ID 兜底去重的证据）。

**stream**：新建 CardKit 卡片发到群，按 `--rate`（默认 2）次/秒更新 `md` 元素的内容，`--duration-s`（默认 120）秒，`sequence` 严格递增；最后关流式模式。看 `ok`/`failed`/`throttled`（HTTP 429 或 99991400）、`error_codes`、`achieved_per_s`（lark-cli 每次一个进程，预计跟不上 2 次/秒，见 `call_ms`）。

## 安全

- 不在日志、报告、错误里放密钥、令牌、ID、消息正文；错误只带路由、HTTP 状态、API 码（`describeError`）。
- SDK 自带的日志会打出 `AxiosError`（含请求体里的 `app_secret`），所以 `backend-sdk.ts` 传自己的 logger；升级 SDK 时先跑 `npm test` 里「失败令牌」那两条。
- 不碰 `/srv/sbot`，不用线上应用，`run.ts` 对 `test_app` 不为 true 的凭证文件直接退出。
