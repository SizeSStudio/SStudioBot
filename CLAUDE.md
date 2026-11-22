# SStudioBot：给在这个仓库里干活的 agent

设计在 `docs/DESIGN.md`（索引和版本变更），正文按章节拆在 `docs/design/`；章节号（`DESIGN §触6.6` 这类）不随文件变，索引表里查所在文件。改行为之前先读对应章节；设计变了，在同一个 PR 里把对应文件和索引一起改。

## 代码

- Node ≥ 24 直接跑 `.ts`（type stripping），没有构建步骤。只能写可擦除的 TypeScript：不用 `enum`、带运行时代码的 `namespace`、构造函数参数属性、`import x =`。相对 import 带 `.ts` 后缀。
- 存储是 `node:sqlite`。
- `core/` 不引前端框架、不加构建。旧控制台 `core/console/` 仍是原生 ES modules，只维护，不再加新页面，等 `clients/` 替换（DESIGN §触6）。
- `clients/` 可以用框架和构建：依赖尽量少、锁版本、`npm ci --ignore-scripts`；构建只在 CI 和本机，不在服务器上跑；产物里不嵌实例地址。
- 依赖方向只有一条：`clients/` 可以 import `core/protocol/`，`core/` 不 import `clients/`。`/api/v1` 内协议只做加法。
- 客户端把 agent 输出、消息、邮件、diff 都当不可信内容：不渲染原始 HTML，不加载远程资源。
- 注释写“为什么”，简短。

## 流程

- 每个改动一个分支、一个 PR，不直接推 `main`（受保护），squash 合并。
- PR 描述写清楚动了什么、怎么验证的。动到闸门、审批、鉴权、设备配对和权限、控制台入口、LLM 代理、worker 沙箱或 `deploy/worker/` 的，在描述开头单独标出来。
- Claude 开的 PR：CI 过了、相关冒烟测试过了，可以自己合并并部署。SStudioBot 自己开的 PR 一律等主人合并。
- 检查：`bash scripts/leak-guard.sh`；`node --check <file>`。冒烟测试在服务器上跑，每次用一个新的一次性 home（`core/test/vps-test-home.sh` 顶部有用法）；端口 7829–7831 可以并行；不要删 testhomes。
- 上线：合并到 `main` 后几分钟内服务器自己部署（`sbot-deploy.timer`），想马上上线就 `bash scripts/deploy.sh`，回滚用 `--ref <sha>`。核心起不来会自动退回上一个版本，管理群会收到通知。只有 `core/` 会自动上线；`deploy/` 下的东西（unit、沙箱、`sbot-deploy` 本身）合并后要手动在服务器上跑对应的 `install.sh`，PR 描述里写明。`clients/` 单独发布，不随核心上线（DESIGN §触6.2）；在 `sbot-deploy` 改成「`core/` 没变就不重启」并装到服务器之前，不要往 `main` 合 `clients/` 的提交。
- 加工作相关的能力时，对照 DESIGN §触6.6：飞书必须够得着。生活、`self/`、命盘这类进控制台和主人的飞书私聊，不进群和工作台（DESIGN §读5.1）。

## 底线

- 仓库是公开的：不放任何实例数据，包括飞书 ID、主机名、tailnet 名、密钥、邮箱、个人资料。实例配置在服务器的 `/srv/sbot/config` 和 `secrets.env`，作者 Mac 上的在 `~/.config/sbot/`。
- 不自行放宽权限。权限、预算、auto 规则和改进机制本身（DESIGN §进2 的 D 级）不由 agent 提改动。主人亲自决定的放宽按他的话做，写进 DESIGN，PR 开头标出来，等他合并。
- 密钥只写不读：不打印、不进日志、不进 agent 的上下文或环境变量，也不进事件流和工具调用记录。
- 设备私钥不离开设备，服务器只存公钥。新入口、公网能力、设备权限默认关，由主人确认后才开。
- 出生信息、`self/`、命盘只给主人看：控制台和他的飞书私聊可以整份给，工作台和管理群只提一两句，他人会话一点都看不到。定时任务、审批、任务、系统事件触发的 run 不能用工具整份读或改这些（DESIGN §读5.1）。
- 实例的出生信息只在服务器的 `self.yaml`；代码、测试、提交、PR 一律用虚构数据。
- 以主人名义发给别人的消息一律走审批卡片。
