# SStudioBot

> A self-hosted, always-on personal agent: one main agent that is "another me", reached through Feishu (and later WeChat),
> with background workers for heavy jobs, a permission gate in front of every outward action, and an owner-only web console.
> Built for one person and run on one Linux VPS. The docs are in Chinese.

一个常驻的个人 agent，“另一个我”。飞书既是工作入口，也是所有审批和管理的控制台；重活交给后台 worker；记忆打通；所有对外出口都要主人批准。生活这一面它也陪着：月、周、日有前瞻，事有起收，能顺着时间线回看，看法越用越贴。

**状态**：作者自己的实例已经在跑（M0–M7），处于打磨期，改动频繁。这是一个**单用户**项目，没有做成可以直接拿来给别人用的产品；代码和设计公开，欢迎参考。

## 它怎么运转

always-on 不等于一直在跑。agent 平时睡着，被事件叫醒后跑一个 **run**，跑完存好状态退出（[DESIGN §1](docs/DESIGN.md#1-运行模型五件套)）：

| 件 | 是什么 |
|---|---|
| 收件箱 | 渠道消息、定时器、任务完成、审批结果都先落库，是唯一的真相源；每条 lane 同一时刻只有一个 run |
| 定时器 | 周期任务和 agent 给自己设的 follow-up，到点往收件箱投事件，不直接跑 |
| 记忆 | `agent-home` git 仓库（llm-wiki 三层，FTS5 检索，不上向量库） |
| 权限 | 每个工具调用：直接执行 / 拦截 / 提交审批；凭证永远在 agent 环境之外 |
| 发件箱 | 所有对外消息先落库再投递，出口幂等 |

几条底线：

- **key 不进 agent**：所有模型调用都走核心里的 LLM 代理，每个 run 只拿一个临时令牌；用量计量和预算上限也在代理里。
- **worker 隔离**：后台任务在独立 Unix 用户 `sbot-w` 下跑，bubblewrap 沙箱 + iptables 限制出口；改代码只在沙箱 worktree 里提交，推送要主人在管理群批准后由核心来推。
- **审批非阻塞**：对外发言、推代码、在群里说话都会生成审批卡片，只认主人本人点击；批准后由发件箱按原稿发出。
- **越用越会办事，但不会越来越大**：agent 能改自己的记忆和风格笔记；skill、prompt、模型档位要提案 + 回放评测 + 主人批；代码走 PR；权限、预算、auto 规则和这套机制本身永远不由 agent 提（[§16](docs/DESIGN.md#16-agent-自己的-rsi越用越会办事)）。

模型分四档（chat / work / light / expert），按角色路由，不绑厂商：对话角色在核心进程里用 pi（`@earendil-works/pi-coding-agent`），worker 和镜头用 Claude Agent SDK（`@anthropic-ai/claude-agent-sdk`）。

## 目录

```
core/
  src/          核心进程：收件箱、调度、LLM 代理、飞书、发件箱、闸门与审批、任务引擎、记忆、定时器、控制台 API
  console/      控制台前端（原生 ES modules，无构建）
  seed/         首次启动时写入的 agent-home 和配置模板
  test/         冒烟测试（在服务器上用一次性的 home 跑）
deploy/
  core/         systemd：核心服务、每晚备份
  worker/       worker 沙箱：bwrap、AppArmor、iptables、sudoers
  lens/         只读的“镜头”插件（紫微、六爻）打包与安装
  backup-mac/   把每晚备份拉回本地 Mac 的 launchd 任务
docs/DESIGN.md  完整设计文档
```

## 运行要求

- Linux + systemd，Node ≥ 24（直接跑 TypeScript，靠 Node 的 type stripping，没有构建步骤）
- 一个 Anthropic 协议的模型上游
- 飞书自建应用 + lark-cli（bot 收发消息、审批卡片）
- Tailscale（控制台只在 tailnet 内可达，用 `tailscale serve` 转到核心的 unix socket）
- bubblewrap（worker 沙箱）

## 安装

还没有一键安装。大致顺序（细节见 [DESIGN §1.3、§7、§10](docs/DESIGN.md)）：

1. 建用户 `sbot`、`sbot-w`，数据目录 `/srv/sbot`（→ `/srv/data/sbot`），装好 `/opt/node`。
2. 在 `/srv/sbot/config/` 建配置仓库，模板在 `core/seed/config/`：`people.yaml` 填主人的飞书 open_id，`models.yaml` 填各档上游。密钥写进 `secrets.env`（只写不读，不进备份）。
3. `sudo bash deploy/core/install.sh`：装 systemd unit 和 `sbot-deploy`，从 GitHub 拉 `main` 部署、启动核心，并打开自动部署（每 3 分钟跟一次 `main`，起不来自动回滚）。再按需装 `deploy/worker/`（后台任务）、`deploy/lens/`（镜头）。
4. `tailscale serve --bg --https=8444 unix:/run/sbot/console.sock`，在 `config/console.yaml` 里列出能进控制台的 tailnet 账号。

自己 fork 的话，在 `/etc/sbot/deploy.env` 里设 `SBOT_DEPLOY_REPO` 指向你的仓库。

## 参与

所有改动都走 PR，`main` 受保护。PR 里写清楚动了什么、怎么验证的。动到权限、闸门、沙箱、LLM 代理的改动会被单独仔细看。仓库里不放任何实例数据：ID、主机名、密钥、个人资料都留在部署机的 `/srv/sbot/config` 和 `secrets.env` 里。

## License

[MIT](LICENSE)
