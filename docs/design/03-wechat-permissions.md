> 导航：[设计文档索引](../DESIGN.md) · [上一篇：角色与 harness、模型层](02-roles-models.md) · [下一篇：记忆、定时器](04-memory-timers.md)

## 6. 微信（SStudioBot 专属号 + Windows 边缘节点）

### 6.1 账号与机器
- 专属微信号 + 一部备用手机。新号先养一阵，不批量加好友，不群发。
- Windows 电脑：
  - 常开不睡眠，保持一个**解锁的交互式桌面**（UIAutomation 在锁屏下、RDP 断开后都不能用）。
  - 微信锁定在 4.0.x 的兼容版本，关闭自动更新。
  - 装 Tailscale，边缘进程常驻。
- **连接安全**：用 Tailscale ACL 规定只有 Windows 节点能连核心的 bridge 端口，连接时再带一个共享令牌。不再做逐条指令签名。

### 6.2 读（wechat-reader）
- 解密本地数据库后轮询，覆盖所有私聊和群，不依赖窗口。**这一步的可行性在 P0 验证**，它是整个微信方案的前提。
- 新消息推给核心，写进 `messages` 和 `inbox`。
- 原始聊天记录只存在核心 SQLite 里，不进记忆文件。
- **用来确认发送结果**：sender 发完后，如果在 60 秒内读到自己发出的那条消息，就把发件箱记录标为 `sent`（[§7.3](#73-审批状态机)）。

### 6.3 写（wechat-sender）
- 用 wxauto 4.0 系的 UIAutomation 实现，只执行核心下发的发件箱条目。
- **防发错人**：
  - 每个会发消息的联系人在微信里设一个**唯一备注**（`config/people.yaml` 的 `wechat_remark`，带短 ID，比如 `老婆#w01`）。
  - 用备注搜索并打开聊天，**在输入之前校验窗口标题和备注完全一致**，不一致就中止，标为 `failed` 并告警。
  - 群用群备注，同样处理。
- 限速：每分钟最多 3 条，另设每日上限；模拟真人节奏。
- 边缘离线时，条目留在发件箱，到期（[§7.3](#73-审批状态机) 的 `send_by`）就作废并通知我。

### 6.4 帮老婆和朋友
- 她们直接加 SStudioBot 好友，每人一个滚动会话，按**他人会话**的工具范围（[§4.1](02-roles-models.md#41-主-agentchat-档)）和自动 / 审批规则（[§7.4](#74-他人发起的请求简化后的工作量闸门)）处理。
- 现阶段定位（v0.25）：只是把普通 bot 也能做的日常功能聚合在一个入口，方便家人朋友顺手使用；**暂不对她们私聊里的内容做深度分析或关系推断**，并严格遵守对别人的边界（[§15.18](08-companion.md#1518-别人说的话与边界v025)：不对别人用镜头、不在他人会话评论我、不在 A 面前转述 B 的话）。
- 陌生人加好友：发审批卡片，由我决定。

### 6.5 群聊整理
- 每个群一份 `groups/wx-<id>.md`（群是干嘛的、关键人物、持续在聊的话题）。
- 定时任务出摘要：私人群推到微信 owner 会话，工作相关的群推到飞书工作台。

---

## 7. 权限、闸门与审批

**核心原则：限制写在代码和操作系统层面，不靠 prompt。**

### 7.1 动作分级

| 级别 | 例子 | 处理方式 |
|---|---|---|
| L0 自由 | 回复当前 lane 里的我；读记忆；写 journal；搜索；以 user 身份读群消息 | 直接执行 |
| L1 内部写 | worker 在自己的 worktree 里改代码、提交；建飞书文档草稿（bot 身份、仅自己可见） | 直接执行，事后汇报 |
| L2 对外 / 以我名义 | 在群里回复；SStudioBot 给别人发微信；用 user token 发消息、改文档、建日程；push 代码 | **审批**；命中 auto 规则或 [§7.4](#74-他人发起的请求简化后的工作量闸门) 自动档时除外 |
| L3 硬禁止 | 转账支付、删除他人内容、退群、改权限、读凭证 | 工具层根本不提供 |

### 7.2 两种审批路径

**A. 提交式（主 agent、起草 run、他人会话）**：这是默认路径。
1. `send(target, text)` 或 `request_approval(plan)` → 代码判定级别。
2. L0 直接进发件箱。L2 写一条 `approvals(pending)`，发卡片，**工具立刻返回"已提交审批 #12"**。run 照常结束，lane 不会被卡住。
3. 我点"发送"后：
   - `send` 类：发件箱**原样发出批准时的那个草稿版本**，不经过模型。
   - `plan` 类：往原 lane 投一条 `approval` 事件，起一个新 run，带上批准的计划和新预算去执行。

**B. 挂起式（worker 运行到一半需要做 L2 动作）**
1. worker 调用 `git_push` 一类工具 → PreToolUse 返回 `defer` → run 以 `tool_deferred` 结束，任务进入 `waiting_approval`，发卡片。
2. 等待期间不占用任何进程，其他 lane 照常运行。
3. 我做出决定后，**不带 prompt** 地 resume 这个 session。同一个工具调用会再次触发 PreToolUse：
   - **批准**：**核心自己执行这个动作**（比如从 worker 的 worktree fetch 再 push），hook 返回 deny，reason 里写"审批 #N 已批准，核心已代为执行，结果：…，不要再调用"。模型据此汇报完成。
   - **拒绝**：hook 返回 deny，附上我的意见。
   - 为什么批准时不返回 allow 让 CLI 去跑工具：P0 实测（`probes/worker-isolation.ts` W3）resume 时 CLI 总是报 `Deferred tool resume: tool 'mcp__sbot__…' is no longer available`（in-process MCP 还没连上），之后 allow 的调用约 15～25% 会变成"用户拒绝了这个操作"，**跟 sudo 无关**（不套包装脚本也一样），`MCP_CONNECTION_NONBLOCKING=false` 也没用。核心代执行 + deny 带结果：10/10 正常，动作也只执行一次（执行权本来就在核心，[§4.2](02-roles-models.md#42-worker默认-light-档可以升到-chat-档)）。
4. 审批过期，按 deny 处理。

### 7.3 审批状态机

```
pending ──批准──► approved ──► 发件箱：sending ──► sent | failed | unknown
   ├──拒绝──► rejected
   ├──超时──► expired
   ├──同一触发有了新草稿──► superseded（superseded_by 指向新卡）
   └──我已亲自回复 / 触发消息被撤回──► invalidated
```

- **只认我本人点**：卡片回调里校验操作人的 open_id 等于 owner，别人点了没用（P0 实测：lark-cli 给的字段是 `operator_id`）。
- **防重复和防过期点击**：
  - 按钮里带 `approval_id` 和 `draft_version`，处理时在事务里检查状态和版本，过期的版本点了不生效。
  - **第一次点击为准，收到后立刻改卡**（去掉按钮、标"已批准/已拒绝 · 处理中"）。P0 实测：卡片没变化时我 36 秒里连点了 4 次（批准、批准、拒绝、批准），来了 4 个事件，`event_id` 和 token 各不相同。改卡用这次回调的 token 调延迟更新接口（token 30 分钟内有效、最多用 2 次：一次"处理中"，一次最终结果）。按 `event_id` 去重。
  - 卡片在话题里被"改一下"之后，`draft_version` 加一，并原地更新卡片。
- **作废**：observer 看到我在同一个 chat 里、晚于 `trigger_msg_id` 发过言（[§3.6](01-runtime-identity-channels.md#36-飞书群以我的身份读按需让-bot-入驻)），就把对应卡片作废并更新显示。
- **发件箱幂等**：`outbox` 对 `approval_id` 加唯一约束，一个审批最多发一次。
- **发送时限**：每条都有 `send_by`（聊天回复默认 2 小时）。批准了但到期还没发出去（比如 Windows 离线），就作废，并在卡片上标注。
- **结果不确定时不重试**：微信 UI 自动化发完不一定知道成没成功，这时标为 `unknown`，等 reader 确认（[§6.2](#62-读wechat-reader)）。确认不了就告警由我处理，**绝不自动重发**。
- **卡片内容**：渠道、发给谁、用谁的身份、草稿原文、触发来源、引用了哪些记忆、expert 意见、承诺检测结果。按钮：发送 / 拒绝 /（M5 起）以后这类自动。

### 7.4 他人发起的请求（简化后的工作量闸门）

**适用范围**：会话的发起人不是 owner，包括 `wechat:dm`、群里 @、Triage 起草。

只分两档：

| 档 | 条件（必须全部满足） | 处理 |
|---|---|---|
| **自动** | ① 这个 surface 允许自动（`wechat:dm` 的 known 人默认允许；群按 `reply: s_auto`）<br>② 在硬上限内完成：`maxTurns ≤ 6`、工具调用 ≤ 4 次（hook 计数）、token 在这个 run 的预算内（代理执行）<br>③ **承诺检测通过** | 直接回复 |
| **审批** | 任何一条不满足 | 卡片 |

- **硬上限**：超过工具次数时，hook 拒绝这次调用，并提示模型"改为调用 `request_approval(plan)`"。代理预算超了，run 直接结束，由 Session Manager 提交一张"没做完"的卡片。
- **承诺检测**：自动发出前，代码用 light 档对草稿做一次结构化判断：有没有替我答应时间、金钱或事情，有没有代表我表态，有没有泄露 `shared/` 以外的私人信息。只要命中一项就转审批，卡片上显示命中原因。
- **稳住对方**：转审批时，对方会收到一句**固定模板**（可在 `gate.yaml` 配置，不由模型生成），比如"收到～这个我得先跟 主人 确认一下"。审批超时也发固定模板。
- **全局预算**：所有他人请求共用一个日预算，由代理执行；超了以后一律走审批。按人的预算后置。

### 7.5 Auto 规则（M5，粒度：人 × 动作）
- 只能由我在卡片上点"以后这类自动"生成，agent 没有任何写入途径。存在 `config/auto.yaml`（唯一真相源）。
  ```yaml
  - who: wife
    action: wechat.reply      # 对老婆的回复：承诺检测命中也自动发（仍然受硬上限约束）
  ```
- 每周在管理群发一份"这周自动执行了什么"。

### 7.6 隔离与凭证

| 东西 | 属主 / 权限 | 谁能碰 |
|---|---|---|
| 核心代码、SQLite、`secrets.env`、lark-cli 和 token、git push 凭证 | `sbot`，0700 / 0600 | 只有核心进程 |
| `/srv/sbot/config`（配置仓库：models / people / groups / gate / auto / jobs / self） | `sbot`，0700 | 我（直接改 / 控制台 / 卡片）；**任何 agent 都不能写**，agent 想改只能提 proposal |
| `/srv/sbot/agent-home`（记忆仓库） | `sbot` | 只能通过核心的记忆工具读写（代码校验路径），worker 读不到原文件 |
| `/srv/sbot-w/tasks/*` | `sbot-w` | sandbox worker |
| `/srv/data/sbot-h/{home,tasks}` | `sbot-h`（有完整 sudo） | host worker；核心在 `sbot-h` 组里，能读任务目录（推送时要 fetch） |
| `/srv/data/sbot-shared`（skill 插件、`ssh_config`） | `sbot`，0755 | 核心写；两种 worker 都只读。不放密钥 |

- **host worker 的边界**（v0.14）：网络和文件系统都没有隔离，sudo 也是完整的。还剩下的约束：
  - 没有任何凭证：不给 lark-cli 和推送凭证，环境变量里只有一个按 run 签发、有预算上限的 LLM token；
  - 推送和对飞书的动作仍然只走核心工具和审批；
  - 核心守卫 + worker 规则，让它不去碰核心的文件；
  - 每个 run 一个 unit，有内存和时长上限。
  - **残余风险**：有 sudo，核心守卫就只是软边界，挡不住有意为之。被注入的指令可以读 `secrets.env`、登录 `ssh_hosts` 里的机器、在 tailnet 里横向移动。所以碰到不可信内容就用 sandbox。
- **sandbox worker 的网络**分两层（P0 已验证，`deploy/worker/netfilter.sh` + `probes/worker-isolation.ts`）：
  - **iptables，按 owner 匹配 `sbot-w`**（链 `SBOT_W`，只插 OUTPUT 第一条，不碰 ufw 和 docker 的链；`sbot-netfilter.service` 开机加载）：
    - 只放行 `127.0.0.1:7811`（LLM 代理）和 `127.0.0.1:7820-7829`（核心的出网代理）。
    - 其余一律拒绝：本机所有地址（`addrtype LOCAL`，包括公网 IP 和 `::1`）、tailnet、私网和 docker 网段、云元数据，**以及公网和 DNS**（2026-11-17 收紧，`SBOT_W_PUBLIC=allow` 可退回）。这一层管住的是 CLI 进程本身。
    - 为什么能关掉公网：CLI 进程本身不需要直连。模型调用走 LLM 代理；WebSearch 是服务端工具，也在代理后面；WebFetch 用 `settings.env.HTTPS_PROXY` 指到核心出网代理（sudo 会删掉 `HTTPS_PROXY` 环境变量，所以走 settings），同时 `skipWebFetchPreflight: true`。P0 实测：不关的话 WebFetch 由 CLI 直连目标网站，还会**另外直连 api.anthropic.com 做域名检查**（关了非必要流量也照样发），两条都绕过白名单。DNS 也关，因为向本机 DNS 发的查询本身就能外传数据。
    - 每个 worker run 固定传 `settings: { skipWebFetchPreflight: true, env: { HTTPS_PROXY: "http://127.0.0.1:<该 worker 的出网代理端口>", NO_PROXY: "127.0.0.1,localhost" } }`。
  - **sandbox 里的命令**（bash 等）没有直连网络，只能走 `sandbox.network.httpProxyPort` 指向的**核心出网代理**。这个代理跑在 `sbot` 下，按任务的域名白名单放行 CONNECT（只接 443），并且自己拒绝解析到非公网地址的域名（它不在 `SBOT_W` 链的约束里）。
    - 为什么不用 CLI 自带的代理：它监听随机的回环端口，`SBOT_W` 把它挡住了，结果所有请求都是 `Proxy CONNECT aborted`。自带代理也只看客户端给的域名，换成我们自己的反而能记日志、按任务配白名单。
  - 残余风险：允许的域名可以被用来外传（domain fronting），所以白名单按任务给、默认空；给 worker 的上下文只放任务需要的东西。
- **worker 的内存**：每个 worker 一个 systemd scope，`MemoryMax=1G`、`MemorySwapMax=256M`、`TasksMax=256`、`OOMPolicy=continue`。CLI 的 `oom_score_adj` 是 -900，sandbox 里的命令经 `/usr/local/lib/sbot/bin/bwrap` 垫片设成 +800。实测 1.5G 的分配只杀掉那个命令，CLI 正常收尾。
- **Ubuntu 的 AppArmor**：系统自带的 `bwrap-userns-restrict` 不允许 bwrap 里再建 user namespace，而 Claude Code 的 `apply-seccomp` 需要它，报错 `write /proc/self/setgroups … Permission denied`。处理办法：停用这个 profile，换成官方文档给的 `bwrap` profile（`flags=(unconfined) { userns, }`）。这会让本机所有用户的 bwrap 都能建 userns，在这台机器上可以接受。
- **控制台**：两个 unix socket。`/run/sbot/console.sock`（目录 700，属主 `sbot`）由 `tailscale serve --https=8444` 代理进来（P0 已验证），校验 `Tailscale-User-Login`；`/run/sbot-web/console.sock`（目录 2750 `sbot:sbot-web`，只有 nginx 的 www-data 在组里）由公网 nginx 代理进来，只认密码登录后的会话 cookie（[§10.1](05-console.md#101-形态与访问)）。
- **主 agent / Triage / expert** 跑在 `sbot` 用户下，但它们没有 shell，也没有读写文件的工具，只能调用我们的 MCP 工具，而这些工具在核心代码里做了校验。

> 导航：[设计文档索引](../DESIGN.md) · [上一篇：角色与 harness、模型层](02-roles-models.md) · [下一篇：记忆、定时器](04-memory-timers.md)
