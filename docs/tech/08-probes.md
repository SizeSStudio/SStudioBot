# 08 探针（W0）

动手写正式代码前先验证没把握的几处。每个探针：要验证什么、数字门槛、不过怎么办。编号是技术设计自己的，和 §触6.9 的阶段号（P0–P7）无关；§触6.9 的「P1.5 spike」拆进了 P1–P4 和 P11。

- 探针代码放 `probes/<编号>/`，在 W0 的分支上；能直接用的部分（Noise 实现、适配器骨架）搬进正式目录，其余不合进 `main`。
- 结果写回本文件每节末尾的「结果」，跟 W0 的 PR 一起合。结果里不写实例数据（域名、主机名、设备型号以外的标识）。
- 一项不过：按「不过」一栏走；栏里写「回来找我」的，是会改动我定过的东西，带数字回来再定。
- 门槛里的「我的手机」「我的 Mac」指日常用的那台，型号写进结果。

## 一览

| # | 验证 | 挡住哪一波 |
|---|---|---|
| P1 | Noise + 中继：能否照搬 Paseo、正确性、Hermes 速度、20 连接 | W1 |
| P2 | FlClash 开着时 WSS 和 FCM | W2 |
| P3 | RN Web 产物在 Electron 自定义协议 + CSP 下 | W2 |
| P4 | 安卓 Keystore、Electron `safeStorage` | W2 |
| P5–P8 | 四个适配器：插话、权限、续接、MCP | W4 |
| P9 | 飞书卡片回调：官方 SDK 还是 lark-cli | W1 |
| P10 | 换模型时上一轮工具调用没结果（IC-11） | W1 |
| P11 | 客户端 spike：六项检查 + §触6.9 P1.5 的余项 | W2 |

## P1 Noise + 中继

- 看 Paseo 的 Noise 和 `relay/`：许可证（Apache-2.0）、能否改成 02、06 的信封和帧，改动量。
- 我们的 Noise 实现过 cacophony 里 `Noise_NK_25519_ChaChaPoly_SHA256` 的全部向量。
- 门槛：
  - 我的手机 Hermes（release 构建）：完整握手 ≤ 50 ms；64 KiB 应用帧加密 + 解密 ≤ 5 ms；持续吞吐 ≥ 5 MB/s。
  - 经 VPS 上的中继比直连多的往返中位数 ≤ 30 ms（同一网络下测）。
  - 主挂 20 个设备连接、每个 10 条/秒事件：主事件循环延迟 p99 ≤ 50 ms，中继 RSS ≤ 100 MB，主增量 RSS ≤ 50 MB（§触6.9 P1 ⑥ 要的数）。
  - 改一个字节 → 断开；配对码里换主公钥 → 握手失败；拿别的通道的 `auth` 帧重放 → 失败。三条都 10/10。
- 不过：Paseo 不能照搬 → 自己写（02 已按规范写好）；Hermes 太慢 → ChaCha20-Poly1305 和 X25519 换原生实现（`react-native-quick-crypto` 一类，先查 install 脚本），Noise 状态机不变。

结果：

## P2 FlClash 下的 WSS 和 FCM（安卓）

- 我的手机开着日常的 FlClash 配置。
- 门槛：
  - WSS 连中继：连上 ≤ 3 秒；前台挂 1 小时不断（断了按 seq 续上算过，但记次数）；切后台 10 分钟再回前台，续上 ≤ 3 秒，文字不重不缺。
  - FCM：2 小时里发 20 条（一半高优先级、一半普通，含锁屏和 Doze），收到 ≥ 19 条，高优先级中位延迟 ≤ 10 秒。
- 不过：WSS 不通 → 在 FlClash 规则里把中继域名设直连（实例配置，写进安装说明），重测；FCM 不达标 → 照设计退回推渠道（D15 已有这条路），客户端里令牌不交给主。

结果：

## P3 RN Web 在 Electron 里

- `expo export -p web`（`web.output=single`）经 `sbot-app://app/` 加载，CSP 照 07。
- 门槛：
  - expo-router 所有路由能直达、刷新不 404；控制台零 CSP 报错。
  - 能不能去掉 `style-src 'unsafe-inline'`：能就去掉，不能记下原因。
  - 我的 Mac 上冷启动到首屏 ≤ 1.5 秒。
  - 网页上关异步路由后包能出、能跑。
- 不过：协议或 CSP 的问题在 `protocol.handle` 里修；RN Web 整体跑不起来 → 回来找我（会改「一套界面」）。

结果：

## P4 设备密钥

- 安卓（我的手机）：
  - Keystore 生成 Ed25519 能否用；不能就走包裹路线（AES-GCM 包软件密钥）。两条路都测。
  - 签名 ≤ 50 ms；杀进程、重启手机、装新版本 App 后密钥还在，签名还能过主的验签；卸载后没了（预期）。
- Electron：Mac 上 `safeStorage` 后端是钥匙串；Windows 上 DPAPI；重启、升级 App 后还在。故意让后端是 `basic_text`（Linux 无钥匙环环境）时拒绝配对。
- 不过：Keystore Ed25519 不行 → 包裹路线（06 已写）；包裹也不行 → 回来找我。

结果：

## P5–P8 适配器

每条能力跑 3 次，3/3 才报 `true`；报 `true` 的才在界面上给对应按钮。agent 事件经中继到主的延迟中位 ≤ 500 ms。顺带收集各家额度上限的错误原文（05「认出额度上限」）。

| # | agent | 测什么 |
|---|---|---|
| P5 | Claude Code（agent SDK，锁版本） | 流式输入插话在本轮生效（下一个工具边界前看到）；`settingSources` 加载用户和项目规则后，规则外的工具才进 `canUseTool`；`AskUserQuestion` 能截下转 `ask`；杀进程后 `resume` 能接上（问它上一句我说了什么）；in-process MCP 的 `sbot` 工具能调 |
| P6 | Codex `app-server` | `turn/steer`；命令和改文件的审批请求都到得了、答了生效；`thread/resume`；MCP 配置指向 `sbot-node mcp` 能调；`turn/diff/updated` 有内容 |
| P7 | pi `--mode rpc` | `steer`；`--session` 续接；我们的 MCP 能不能挂（`--mcp-config` 或 pi 扩展），不能就报 `mcp: false` 并在 05 里写 |
| P8 | ACP（acpx，接一个现成 ACP agent） | `session/new` 带 `mcpServers`；`session/request_permission`；`session/load`、`unstable_resumeSession` 哪个可用；都不可用时新开 session 读 `progress.md` 接上 |

- 不过：那一项报 `false`，照实显示（§办3.2），不模拟。acpx 库入口不够用 → 换 `@agentclientprotocol/sdk`。

结果：

## P9 飞书卡片回调

- 对比 `@larksuiteoapi/node-sdk`（长连接）和 lark-cli（子进程）。
- 门槛（两边都测）：
  - 卡片按钮回调 50 次：3 秒内确认 50/50；回调里有 `operator_id`；点完卡片更新成功 50/50。
  - 断网 30 秒再恢复：自动重连，期间的事件按 `event_id` 去重后不丢、不重。
  - CardKit 流式卡片每秒更新 2 次，持续 2 分钟不被限流。
  - 依赖：官方 SDK 的依赖树里有没有 install 脚本、有多大。
- 选：两边都过选依赖少、不起子进程的那个；只有一边过就选它；都不过 → 回来找我。

结果：

## P10 换模型时有未完的工具调用（IC-11）

- pi 嵌入，经代理；最后一条 assistant 带 `tool_use`、结果还没回来时换模型（同家换型号、跨家各测）。
- 比两种做法：A 等这轮工具结果回来再换（03 的默认）；B 立刻换，未完的调用补一条「已取消」结果。
- 门槛：每种跨家、同家各 10 次，上游 400 为 0、工具结果不丢。
- 选：B 过了用 B（换得更快）；否则 A。

结果：

## P11 客户端 spike

设计里限时 1～2 天（§触6.9 P1.5）。安卓用我的手机 release 构建，桌面用我的 Mac。

| 检查 | 门槛 | 不过 |
|---|---|---|
| ① Uniwind 在自定义协议 + CSP 下 | 明暗切换、hover、弹出层定位两端都对 | 在 `global.css` / 组件里修；Uniwind 整体不行 → 回来找我 |
| ② 对话流 | 500 条历史，回复按 50 段/秒流 2000 字：JS 帧率中位 ≥ 55，无单帧 > 100 ms；贴底；往上翻时不被拽回；网页上能跨消息选文字 | 网页换 `@tanstack/react-virtual`；安卓调 Legend List 参数，仍不过回来找我 |
| ③ 不可信内容零外部请求 | 07 的恶意样本集，安卓抓包、Electron 用 `session.webRequest` 记：外部请求 0 | 挡住 W2，修到 0 为止 |
| ④ 中文 | 输入法组字时回车不发送（Gboard、搜狗、macOS 拼音）；三种字体行高不裁字；4 种加粗情形（中文包英文、英文包中文、紧贴标点、跨行）都加粗 | 调样式和 cjk-friendly 配置 |
| ⑤ Hermes 上的长代码和 diff | 400 行代码块高亮 ≤ 150 ms；2000 行 diff 打开文件列表 ≤ 300 ms | 调 07 的折叠阈值、改成分段高亮 |
| ⑥ 包大小 | `expo export -p web` 产物 gzip 后记下作基线；APK 大小记下 | 只记，不拦（07 CI 第 3 步用这个基线） |

§触6.9 P1.5 的余项一起过：扫码配对；切后台再回来能续（P2）；杀进程后密钥还在（P4）；agent 的 HTML 交给系统浏览器能开、页面里 localStorage 存得住；Health Connect 的包能读到（只测能读，功能默认关）；`@pierre/diffs` 运行时不去网上拉语法和主题。

结果：
