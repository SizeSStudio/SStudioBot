# SStudioBot：给在这个仓库里干活的 agent

设计在 `docs/DESIGN.md`。改行为之前先读对应章节；设计变了，在同一个 PR 里把 DESIGN 一起改。

## 代码

- Node ≥ 24 直接跑 `.ts`（type stripping），没有构建步骤。只能写可擦除的 TypeScript：不用 `enum`、带运行时代码的 `namespace`、构造函数参数属性、`import x =`。相对 import 带 `.ts` 后缀。
- 存储是 `node:sqlite`；控制台前端是原生 ES modules，不引框架、不加构建。
- 注释写“为什么”，简短。

## 流程

- 每个改动一个分支、一个 PR，不直接推 `main`（受保护），squash 合并。
- PR 描述写清楚动了什么、怎么验证的。动到闸门、审批、LLM 代理、worker 沙箱或 `deploy/worker/` 的，在描述开头单独标出来。
- Claude 开的 PR：CI 过了、相关冒烟测试过了，可以自己合并并部署。SStudioBot 自己开的 PR 一律等主人合并。
- 检查：`bash scripts/leak-guard.sh`；`node --check <file>`。冒烟测试在服务器上跑，每次用一个新的一次性 home（`core/test/vps-test-home.sh` 顶部有用法）；端口 7829–7831 可以并行；不要删 testhomes。

## 底线

- 仓库是公开的：不放任何实例数据，包括飞书 ID、主机名、tailnet 名、密钥、邮箱、个人资料。实例配置在服务器的 `/srv/sbot/config` 和 `secrets.env`，作者 Mac 上的在 `~/.config/sbot/`。
- 不放宽权限。权限、预算、auto 规则和改进机制本身（DESIGN §16 的 D 级）不由 agent 提改动。
- 密钥只写不读：不打印、不进日志、不进 agent 的上下文或环境变量。
- 出生信息、`self/`、命盘只给主人看；盘面文字不进飞书。
