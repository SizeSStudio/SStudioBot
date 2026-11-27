# 技术设计（`docs/tech/`）

设计（`docs/DESIGN.md`、`docs/design/`）定做什么、为什么；这里定怎么搭：目录、协议、表、模块、施工顺序。两边对不上时，行为以设计为准，实现细节以这里为准；改了哪边都在同一个 PR 里把另一边对上。

整体重写（T1）：新目录 `protocol/`、`hub/`、`node/`、`relay/`、`clients/`，`core/` 冻结，W7 切换后删。

## 文件

| 文件 | 内容 |
|---|---|
| [01-layout.md](01-layout.md) | 目录、依赖方向、包、代码约定、跨平台、CI、部署 |
| [02-protocol.md](02-protocol.md) | Noise 通道、应用帧、`client_ops`、大载荷、`/api/v1` 和 `/node/v1` 路由、节点调主的 MCP、版本 |
| [03-hub.md](03-hub.md) | 主的模块：runner、tools、approvals、outbox、channels、push、proxy、api、link、tasks、improve、backup、cli、配置键变化 |
| [04-schema.md](04-schema.md) | 新库全部表（取代 §底5）、`change_log` 触发器、清理和 blob GC、和旧库的差异、量级 |
| [05-node.md](05-node.md) | 节点程序：适配器、统一事件、权限、MCP、worktree 和 CI、升级、安装配对 |
| [06-relay.md](06-relay.md) | 中继、信封、主和设备的密钥、认证、配对、设备管理、角色、开关 |
| [07-clients.md](07-clients.md) | 客户端：依赖、连接、store、不可信内容渲染、diff、Electron 壳、安卓、CI |
| [08-probes.md](08-probes.md) | W0 探针 P1–P11：门槛和退路，结果写回这里 |
| [09-waves.md](09-waves.md) | 波次 W0–W7、重建数据、演练对账、切换和退回 |
| [10-port.md](10-port.md) | 旧代码逐文件去向、能照搬的件、§附2.21 的代码事实 |
| [log.md](log.md) | 施工记录：每波状态、PR、验收、断点、等你过目 |

## 决定（2026-11-27）

### 骨架（round-1，我定）

| # | 决定 | 在 |
|---|---|---|
| T1 | 全部重写 | 01、09 |
| T2 | 顶层 `hub/`、`protocol/`、`node/`、`relay/`、`clients/`；`core/` 冻结，切换后删 | 01 |
| T3 | 一个长程任务按波次推进，每波一个 PR，CI 和冒烟过了自己合；切换等我点头 | 09 |
| T4 | 新库按新设计一次定好；不搬旧数据，从飞书和本地重读重建（逐类见 T29） | 04、09 |
| T5 | 主 agent（pi）以 SDK 嵌在主进程里 | 03 |
| T6 | 节点程序自己写一层薄适配，接口仿 Paseo | 05 |
| T7 | 中继自建：Node + `ws`，独立进程，默认和主同一台 VPS，共用 443 | 06 |
| T8 | 节点升级：主在握手时给目标 sha，节点自己 fetch、校验、排空、重启 | 05 |
| T9 | Linux、Mac、Windows 都能当主；Mac、Windows 当主时 command 插件和排盘脚本同一个用户跑（记进 §底3.8） | 01 |

### 直接定的（round-1 否决单，我都同意）

| # | 决定 | 在 |
|---|---|---|
| T10 | Node 24 + type stripping；只有 `clients/` 有构建；`node:sqlite` | 01 |
| T11 | 一套帧协议：RPC、事件、带 `chunk_seq` 的流 + 快照兜底；大载荷拉取；zod schema 在 `protocol/`；CI 管只加不减 | 02 |
| T12 | `Noise_NK_25519_ChaChaPoly_SHA256`（状态机照搬 Paseo；AEAD、X25519 按平台：Hermes 原生、主和节点 `node:crypto`、网页 noble，P1）；本机节点走 unix socket / named pipe，不加密，靠文件权限 | 02 |
| T13 | 一个渠道插件接口，插件可跑在主上或节点上 | 03 |
| T14 | command 插件和排盘脚本是子进程、stdio 上的 JSON；Linux 上以 `sbot-w` 跑 | 03 |
| T15 | Expo + expo-router 出安卓；Electron 经自定义协议加载 `expo export -p web` 产物；钥匙串只在 Electron 主进程，经窄 `contextBridge` | 07 |
| T16 | 安卓 Keystore AES 包软件 X25519/Ed25519，API 33+ 先试原生；Electron `safeStorage` 后端是 `basic_text` 就拒绝 | 06、07 |
| T17 | FCM HTTP v1，自签 JWT，不用 firebase-admin | 03 |
| T18 | `ws` 8.23 | 01、06 |
| T19 | 探针先行，每项有数字门槛和退路 | 08 |

### 前端（我定）

| # | 决定 | 在 |
|---|---|---|
| T20 | 主题用 coss ui（Cal.com 那套）的变量，原样：中性灰、黑色主按钮、圆角 10px、明暗两套 | 07 |
| T21 | 一套界面：Expo（RN + RN Web），Electron 装网页产物；coss 只借变量 | 07 |
| T22 | Uniwind 1.14 + Tailwind 4；组件抄 react-native-reusables（Uniwind 版），需要时加 `@rn-primitives` | 07 |
| T23 | markdown-it 15.0.3 + markdown-it-cjk-friendly 3.0.0 + remend 1.5.1；渲染器只做 token → 组件的映射，能引用的不自己写 | 07 |
| T24 | lowlight 3.3.0 + highlight.js 11.12，只注册常用语言；正在流的代码块不高亮 | 07 |
| T25 | diff 只在桌面好好做；安卓看文件列表和原文块，再不行去 git 上看 | 07 |
| T26 | Legend List 3.9.2 两端共用；`ChatList.native` / `.web` 一开始就分开，网页不行换 `@tanstack/react-virtual` | 07 |
| T27 | lucide-react-native 1.82；reanimated 4.7.1 + worklets 0.13 + gesture-handler 3.3（跟 Expo 绑定）、keyboard-controller 1.22.7；菜单和对话框 `@rn-primitives`，底部面板 `@expo/ui` BottomSheet，桌面换对话框或侧栏 | 07 |
| T28 | 状态继续手写 store + `useSyncExternalStore` | 07 |
| T29 | 数据逐类：agent-home、config 从 seed 重建，只挑要的配置；解读账本、互参、`self_items`、身体条目、复盘和前瞻、`dismissals`、`eval_cases` 清零；事、事件账本、人和关系和图谱重读重建；messages 从飞书和本地重读；运行记录不搬 | 09 |

### 前端直接定的（我都同意）

| # | 决定 | 在 |
|---|---|---|
| T30 | 不打包中文字体，用系统字体；`lang="zh-CN"` | 07 |
| T31 | 不可信内容：白名单节点；图片、视频、HTML 不发网络请求；点链接先确认；remend 补出的半截链接是死的；P11 抓包外部请求必须为 0，不过挡住这一波 | 07、08 |
| T32 | Electron 自定义协议 `standard`/`secure`/`supportFetchAPI`；`protocol.handle` 防路径逃逸、无扩展名回 `index.html`；`web.output=single`；网页关异步路由 | 07 |
| T33 | CSP 由 `protocol.handle` 响应头给；`connect-src` 配对后填中继；`img-src 'self' data:`；`media-src 'none'`；包里没有实例地址 | 07 |
| T34 | 依赖全锁、`npm ci --ignore-scripts`、新依赖查 install 脚本、CI 显式装 Electron 二进制并校验；RN Web `~0.21.4`；reanimated 一系跟 Expo；不用 RN Web 私有属性 | 07 |
| T35 | `clients/` 用 Node 24 构建 | 07 |
| T36 | P11 加六项检查（Uniwind、对话流、零外部请求、中文、Hermes 长代码和 diff、包大小） | 08 |
| T37 | `secrets.env`、`raw/` 原件、体检原件原样带过去；旧库不动；切换前在副本上演练两次、对得上 | 09 |

### 设计里留给技术设计、这里定的

| # | 决定 | 在 |
|---|---|---|
| T38 | 设备签名用 Ed25519（设计写的 P-256），`device_id = hex(sha256(公钥))` | 06 |
| T39 | Electron 设备私钥在主进程 + `safeStorage`，取代「WebCrypto 存 IndexedDB」（DC-16） | 06、07 |
| T40 | `change_log` 覆盖哪些表、`client_ops` 清理 30 天、blob 存法和 GC | 02、04 |
| T41 | 中继端点、信封、注册白名单、防洪泛、不缓冲 | 06 |
| T42 | 唤起 App 的 scheme `sstudiobot://`，App 里有「粘贴配对码」 | 06 |
| T43 | 节点调主的工具经 MCP `sbot`（Claude in-process，其余 stdio 小程序） | 02、05 |
| T44 | `check` 契约：退出 0 无输出 = 跳过，0 有输出 = 跑，其他 = 照跑 + 告警 | 03 |
| T45 | `proposals.status` 默认 `'proposed'`；提案按 `target` 去重 | 03、04 |
| T46 | 代理令牌跟着 run 走，不再 30 分钟过期；坏令牌 401、越档 403；预算只告警 | 03 |
| T47 | 不重设「内核行数」线 ※（§0 原来留给技术设计） | — |

## ※ 推出来的

按「权限尽可能大，除非我否决」「不加我没说过的限制」从已定的推出来，不是我逐条说的；不对就否。正文里都标了 ※。

| 在 | 条目 |
|---|---|
| 01 | Windows 用计划任务开机启动；`relay` 单元只看 `relay protocol/envelope.ts` |
| 02 | `client_ops` 留 30 天；blob 没人引用 1 天后删；主和节点的 AEAD 用 `node:crypto` |
| 03 | 一次最多处理 50 条批量输入；`channels.yaml` 取代 `feishu.yaml`；`worker.yaml` 挪到节点；节点上的渠道插件经代理插件接主；本机节点不配对；`check` 非零照跑 + 告警；节点排空默认 30 分钟；代理令牌不过期；备份保留 14 日 / 8 周 / 12 月 |
| 04 | `life_notes`、没到点的 follow-up 带过去；同一 PR 第 3 次红 CI 进通知不发卡 |
| 05 | 定稿 diff 超 16 KB 走 blob；不在 `workdirs` 里的照样能派只是标出；远端节点收到 exec 回 403；worktree 清理不删分支；Windows 节点私钥用 DPAPI |
| 06 | 中继 DNS 不经 CDN；中继自保的几个数；主密钥 v1 不轮换；新 IP 段按通知不按安全告警 |
| 07 | 两份 lockfile 的 `zod`、`@noble/*` 版本 CI 比对；切后台立刻报不在场；`data:` 图片也不显示；链接只放 `http`/`https`/`mailto`；只重解析最后一块；代码块 400 行折叠；安卓 diff 的形状；Electron 全拒设备权限；协议名 `sbot-app://`；配对后重载窗口；包大小涨 20% 标红不拦 |
| — | T47 不重设行数线 |
| 09 | 测试 home 里飞书 `shadow` 模式；对账里事件、事两次差 ≤ 10%；切换后稳 7 天再删 `core/` |

## §附2.21 各条落在哪

| 条目 | 在 |
|---|---|
| R2 施工波次（前置、验收、`install.sh`、复用、删旧轨；漏排的省心、`crosschecks`、`body_entries`、`matters.paused`、已读；第 4 批依赖第 7 批；P1.5 收成探针前移） | 09；探针 08 |
| R3 解开写死飞书、`sbot-deploy` 比树 hash | 03（outbox、channels）、01 部署、10 |
| R1 代码部分（`src` 标签、`ownerDirect`、`self/` 守卫、三列表） | 03 tools、10 |
| R7 代码事实（401/403、真实的预算键、`budget_exhausted` 联动、去掉上限、加载点、`memory_search` 截断、按 `target` 去重、`MemoryMax=6G`） | 03 proxy / runner / improve、05、10 |
| Y2 协议细节 | 01、02、06 |
| Y5 表和列 | 04 |
| Y6 §底5 按代码重写 | 04 |
| Y8 量级 | 04 §13 |
| Y11 代码同步 | 03 配置键变化、10 |
| IZ-10 协议比对 CI | 01 CI |
| `core/src/main.ts:1` 的注释 | 已改 |
| IC-11 换模型时工具调用未完 | 08 P10 |
| IC-14 安卓 HTML 的 `localStorage`、DC-16 | 08 P11、06 |
