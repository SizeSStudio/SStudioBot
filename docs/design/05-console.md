> 导航：[设计文档索引](../DESIGN.md) · [上一篇：记忆、定时器](04-memory-timers.md) · [下一篇：数据模型、已拍板的决策](06-data-decisions.md)

## 10. 配置控制台（M3 起）

M0～M2 不做控制台，用飞书的 `/model`、`/group` 卡片，加上直接改配置仓库来顶上。

### 10.1 形态与访问
```
手机 / 电脑（装了 Tailscale）                       任何浏览器
   │  https://<host>.<tailnet>.ts.net:8444            │  https://<console.web.origin>（Cloudflare 只做 DNS，灰云）
   ▼                                                   ▼
tailscale serve --https=8444                         nginx :443（Let's Encrypt、HTTP/2、登录限速）
（注入身份头 Tailscale-User-Login）                   （去掉 Tailscale-* / Authorization，补 X-Real-IP）
   ▼                                                   ▼
/run/sbot/console.sock（目录 700 sbot）              /run/sbot-web/console.sock（目录 2750 sbot:sbot-web）
   只认 Tailscale-User-Login ∈ owners                   只认会话 cookie（密码登录发的）
   └──────────────── 同一个核心进程、同一套 /api/* 和前端 ────────────────┘
```
- **tailnet 入口**：后端校验 `Tailscale-User-Login` 在 `console.yaml owners` 里，不是就返回 403。
- **公网入口**（2026-11-18 加，因为 tailscale serve 在主人那边常卡；防护照主人另一个管理面）：
  - 地址在 `config/console.yaml` 的 `web: { origin: https://… }`，主机名是实例数据，不进仓库。没写 origin、或者服务器上没设密码，这个入口对什么请求都回 404。
  - 一个密码，`secrets.env` 里只存 `CONSOLE_WEB_PASSWORD_HASH`（PBKDF2-SHA256，30 万轮）和会话密钥 `CONSOLE_WEB_SESSION_KEY`。只能在服务器上用 `console-passwd` 设；重设密码或 `--logout-all` 会换会话密钥，所有会话立刻失效。控制台的密钥页拒绝写这两个名字。
  - 登录（`POST /_auth`）要本站 `Origin`、表单提交；失败按 IP 每 10 分钟 10 次、总共 30 次限流（nginx 也按 IP 每分钟 10 次）。成功和触发限流都在管理群通知（IP 打码）。
  - 会话 cookie `__Host-sbot_console`：`时间戳.随机数.HMAC`，12 小时，Secure、HttpOnly、SameSite=Strict、不带 Domain。
  - 写操作除了原有的 `x-sbot-console: 1`，还要 `Origin` 等于 `web.origin`。为此这个入口的 `Referrer-Policy` 是 `same-origin`（`no-referrer` 下浏览器同源写请求会带 `Origin: null`）；tailnet 入口仍是 `no-referrer`。
- **为什么两个 socket**：tailscaled 会换掉客户端伪造的 `Tailscale-User-Login`，nginx 不会。两个入口如果共用一个 socket，从公网进来的人自己塞这个头就能过。所以 nginx（www-data）连不上 tailnet 的 socket（目录 700），公网 socket 上完全不看这个头；反过来公网的 cookie 在 tailnet 入口也不算数。www-data 下别的进程能连公网 socket，但那里除了 cookie 什么都不信，所以没用；X-Real-IP 它可以伪造，因此限流另有一个总量上限。
- **部署**：`deploy/console-web/`（tmpfiles 建 `/run/sbot-web`、sbot-core 的 drop-in 放开这个目录的写权限、nginx 站点模板、`install.sh <host>` 申请证书并启用）。核心启动时这个目录存在才开公网 socket。
- P0 实测（2026-11-16，tailscale 1.104.5）：
  - 控制台**单独用一个端口**（实例里是 8444），不和本机已有的 serve 配置抢路径，也不改它们。
  - 经 serve 进来的请求带 `Tailscale-User-Login` / `Tailscale-User-Name` / `X-Forwarded-For`；客户端自己塞的同名头会被换掉，伪造不了。
  - 可以代理到 unix socket。socket 放在 700 目录里，sbot-w 和其他用户连不上（tailscaled 是 root，能连）。这样本机别的进程没法绕过 serve 直连、自己编身份头；如果监听 127.0.0.1，本机任何用户都能这么做。
  - 改 serve 要 root（`sudo tailscale serve --bg --https=8444 unix:/run/sbot/console.sock`），M3 部署时做一次；也可以 `tailscale set --operator=sbot`，不过那样 sbot 就能改整台机器的 serve，不推荐。
  - 设备不带用户身份时（tagged 节点）没有这个头 → 一律 403。
- 手机优先，按竖屏设计。

### 10.2 页面（按优先级）

| 优先级 | 页面 | 真相源 |
|---|---|---|
| M3 | **状态**：渠道连接、observer、token 有效期、边缘节点、正在跑的 run 和任务、待审批、今日用量 | SQLite（SSE） |
| M3 | **模型**：端点、三档、价格、探针结果 | `config/models.yaml` + `secrets.env`（key 只能写） |
| M3 | **群**：所有群按活跃度排序，切换 activation / reply，黑名单，批量操作 | `config/groups.yaml` |
| M3 | **记忆**：浏览、按 dream commit 看 diff、一键回滚 | agent-home git |
| M3 | **用量** | `usage` |
| M5 | People、策略、Auto 规则、定时任务、提议 | 对应的配置文件 / `proposals` |
| M3（2026-11-17 补） | **流转**：消息 → Triage → run / worker → 审批 → 发件箱，实时一条条走过去，点开看每一步的输入输出和用量 | `inbox` / `runs` / `approvals` / `outbox`（SSE） |
| M3（2026-11-17 补） | **沉淀**：知识库（index / log / 页面）、事和复盘、镜头看法账本、心得、[§16](09-rsi-matters-graph.md#16-agent-自己的-rsi越用越会办事) 的信号和提案 | agent-home git + 对应的表 |
| v0.15 | **生活 › 人**：每个人的因缘（初见、每月往来）、关系、常一起的人和事、资料和页面、叫法；改名、分圈子、记关系、合并、拆开；people.yaml 的信任只读显示。**生活 › 因缘**：圈子图、圈子、新结的缘、常在一起还不知道什么关系、牵线的人、渐远的、待认 | `persons` / `relations` / `graph_*`（[§18](09-rsi-matters-graph.md#18-因缘人事资料的图谱v015)） |
| v0.22 | **它自己 › 配置**：每个配置文件一张表单，原文在「高级 › 查看原文」（[§10.6](#106-配置表单v022)）。`self.yaml` 还在「生活 › 出生信息」 | `config/*.yaml` |
| M8 | **待办 › 要你回 / 拍板**；**生活 › 事**：每件事的事件、等你的、话头（挂到事上）；**生活 › 导入**：预览、导入、撤销、提示词和样例；**它自己 › 信息源**：每个源上次拉取的结果、现在拉一次 | `events` / `imports` + `config/sources.yaml` |

### 10.3 原则
- 真相源是配置仓库里的文件。控制台保存时：先用 schema 校验，再写文件、做 git commit（提交信息带 `via console`）、热加载，并在管理群通知一声。表单和原文编辑器都走这一条（[§10.6](#106-配置表单v022)）。
- schema 用 zod 写在 `shared/` 里，前后端共用。
- 密钥只能写，不能读。
- 扩大权限的改动（群开成 `s_auto`、调高预算、放宽主动消息上限、缩短提醒等待窗口）会在管理群单独发一条醒目通知。

### 10.4 重做（2026-11-17 定，参考 T3 Code 和 Magpie）

现在的 7 页偏配置。重做成四块，桌面三栏、手机底部四个 tab + 抽屉：

1. **待办**（首页）：所有待审批都能就地批，等我回答的任务，Sentinel 告警，没跑的定时任务。
2. **会话**（像 T3）：左边 lane 列表带状态点；中间 run 时间线，工具调用默认折叠，审批就地显示；右边链路详情（像 Magpie）：系统提示分段和各段 token 占比、prompt / tuning 版本、缓存命中、花费、模型实际收到的完整请求。
3. **生活**（只给 owner）：时间线、事、前瞻和复盘、习气和节律（认同 / 送走）、看法账本、出生信息。
4. **它自己**：体检指标趋势、[§16](09-rsi-matters-graph.md#16-agent-自己的-rsi越用越会办事) 提案（diff、回放、回滚）、记忆和 dream 的 diff、模型和用量、配置和密钥、连接健康。

已定：
- **控制台可以直接批**，包括以我身份发出的消息。记成「经控制台」，飞书上的卡片同步改状态；和卡片走同一个审批状态机（同一个乐观锁版本号），谁先点算谁。
  - 控制台的响应不等飞书（2026-11-18）：状态、发件箱、事件在同一个事务里落库后就返回，卡片更新和随后的唤醒在后台按原顺序做。要核心当场执行的审批（`deferred_tool`、`proposal`、`rollback`）仍然等执行完，因为结果要显示在页面上。卡片上点的路径不变。
- **完整请求留存**：只存 main 和 draft 两种 run 发给模型的完整请求（system + messages + tools），保留 7 天，只有 owner 能看。其他 run 只存摘要和版本号。
- **前端**：不加构建步骤，每页一个原生 ES module（`console/pages/*.js`），共用的组件和工具放 `console/lib/`；CSP 仍然只允许 self。下一代客户端见 [§19](10-console-client.md#19-控制台客户端前后端拆开对话设备v020设计稿)，替换完成之前这里不变。
- 分期：C1 骨架 + 待办 + 会话链路 + 请求留存；C2 生活；C3 它自己。

### 10.5 响应性能（2026-11-18）

都做在核心里（`console-http.ts`），两个入口同时受益，随 core 自动上线，不用改 nginx。客户端以后拆出去也照样有用。

- **静态文件**：启动时读好、算内容 hash、在线程池里预压缩（br、gzip）。`Cache-Control: no-cache` 不变，每种编码一个强 ETag，`If-None-Match` 命中回 304。按 mtime 和大小发现文件变化，不用重启。鉴权在前，没通过的请求拿不到 304 或 ETag。
- **`modulepreload`**：`index.html` 列出首屏的 import 链，并行取，不再一层层等。新增首屏依赖时要同步改这个列表，漏了只是慢一点。
- **压缩**：1 KB 以上的 JSON 按 `Accept-Encoding` 现压（br 质量 4 或 gzip），在线程池里做，不占事件循环。SSE 不压。
- **git 读缓存**（`gitRead`）：`git` 是同步子进程，会卡住整个核心。只依赖提交的读（记忆日志、配置历史、状态页的最新提交）缓存到分支移动为止，靠 stat ref 文件判断，所以回滚和手工提交也会失效，不用 TTL。配置的正文和 hash 每次都现读，乐观锁不受影响。
- **SSE**：全局每 3 秒算一次 `status()`，广播给所有连接；没有连接时不算。

### 10.6 配置表单（v0.22）

改配置不该要我写 YAML，也不该要我猜每一项什么意思。

**服务器描述，客户端只画。** `core/src/config-form-specs.ts` 给每个文件写一份描述：字段、中文说明（控制什么、默认多少、调大调小有什么效果）、控件、单位、哪些改动算放宽。类型、范围、必填、格式在下发时从 zod schema 取，不写第二遍；`specProblems()` 两个方向核对，字段对不上冒烟就失败。协议类型在 `core/protocol/config-form.ts`，[§19](10-console-client.md#19-控制台客户端前后端拆开对话设备v020设计稿) 的新客户端直接用；旧控制台由一个通用渲染器 `console/lib/form.js` 来画，不按文件写页面。

| 接口 | 作用 |
|---|---|
| `GET /api/config/<file>/form` | 描述、当前值、hash、表单不认识的键、可选项（群、仓库、插件、密钥名等）、今日用量 |
| `POST …/form/preview` | 不写入。返回字段错误、放宽项和后果、将写入的 diff、任务的下次运行时间 |
| `PUT …/form` | 带 `values`、`hash`、`ack` 保存 |

**保存没有第二条路。** `values` 是草稿：没出现的键不动，`null` 是清空或删除，出现的列表就是完整内容。服务器把它并进当前值，只碰描述里有的键，算出保留注释、顺序和空行的新文本（改一个值，diff 就是一行），再交给原文编辑器用的同一个 `saveConfig`：比 hash、zod、防止把自己移出 owners、写文件、git 提交、`config_changes`、管理群 diff、`widening()` 的 ⚠️，都在那里，表单没有改动也没有绕过它们。

**放宽要先确认。** 预览时列出放宽项和后果，保存前再确认一次；`ack` 没盖住全部放宽项，服务器回 409，什么也不写。`widening()` 看不到的几类由表单层补一条 ⚠️，只加不减：没设过的群因此多读、去掉默认敏感词、换管理群或工作台、模型端点的地址和密钥、备用模型、人的 ID、提醒不占主动额度。换管理群时，旧群也会收到一句。

**不丢东西。** 表单不认识的键原样保留，并列在表单上，提示去「高级 › 查看原文」改。原文编辑器还在每张表单底部，兜底和看历史。文件解析不了时表单停用；`saveConfig` 要拿旧内容比较放宽，所以这种文件在控制台也存不了，要在服务器上修。

**只显示不让改的**：`groups.reviewed`（设了就跳过首次读群的确认卡片）、群的 `reply`、我自己的飞书和微信 ID、任务的 `lane`。密钥只选名字，值不下发。`self.yaml` 暂时不在表单里，出生信息和镜头设置单独做。

> 导航：[设计文档索引](../DESIGN.md) · [上一篇：记忆、定时器](04-memory-timers.md) · [下一篇：数据模型、已拍板的决策](06-data-decisions.md)
