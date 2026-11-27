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

结果（2026-11-28；代码在分支 `probe/p1` 的 `probes/p1/`，README 有每项的重跑方法，原始数字在 `probes/p1/results/`）：

- **Paseo**：许可证 Apache-2.0（另有第三方组件按各自许可）。
  - Noise **照搬**：`packages/relay/src/noise/` 三个文件约 400 行，逐 token 执行 NK，自带向量测试，依赖就是 noble。改了四处：import 换 `.ts`；解密失败一次整个 CipherState 作废（02 的「失败即断」），清掉的状态再调一律抛错（原来 key 为空会原样返回明文）；AEAD 抽成接口（见下）；去掉 vitest。保留版权头，`noise/NOTICE.md` 写了改动。外面包一层 `channel.ts`（145 行）：prologue、JSON 握手载荷、1 字节分片标志、1 MiB 上限、任何错误都销毁通道。
  - `relay/` **不照搬，自己写了**（`relay.ts` 228 行）。Paseo 的中继是 Cloudflare Durable Object（`cloudflare-adapter.ts` 614 行），按 `role=server|client&serverId&connectionId` 配对 socket，v2 是主给每个客户端另开一条数据 socket，不是 06 的「一条 WS 多路复用 + 信封」；上面还叠着它自己的 `encrypted-channel`、`secure-channel`（1400 多行，含 tweetnacl 老协议）。改成 06 等于重写。社区另有 Go、Elixir 的自托管版，也不是 Node。
- **向量**：cacophony 里 `Noise_NK_25519_ChaChaPoly_SHA256` 只有 1 条（握手 2 条 + 传输 4 条 + 握手 hash），noise-c 的同名向量和它逐字节一样；过了。变异检查：把 HKDF 的 `0x02` 改成 `0x03`，向量测试挂。另有失败即断、重放、反射、乱序、低阶点、错主公钥、错 prologue、nonce 用尽、乱序调用、分片边界（0、1、65518、65519、64 KiB、1 MiB）、超 1 MiB 两端都拒、50 次随机翻位，`node --test` 13 条全过；把 AEAD 换成 node:crypto 再跑一遍，13 条也全过。
- **依赖**：`@noble/curves`、`@noble/ciphers`、`@noble/hashes` 2.4.0，`ws` 8.23.0，都锁死；lockfile 里没有 `hasInstallScript`，`npm ci --ignore-scripts` 装全。
- **门槛**：

| 项 | 门槛 | 结果 | 过 |
|---|---|---|---|
| 经中继多出的往返中位 | ≤ 30 ms | 服务器本机回环：中继 2.15、直连 0.97，逐次配对差的中位 **+1.1 ms**。Mac 经 `ssh -L` 隧道（两条路走同一条隧道）：中继 378.5、直连 381.3，配对差中位 −0.9 ms，被 ~430 ms、抖动很大的公网淹没 | 过 |
| 20 连接 × 10 条/秒，主事件循环 p99 | ≤ 50 ms | **2.5 ms**（p50 1.1，最大 17.1；按 1 ms 采样，含采样间隔本身）。跑 120 秒，收到 23963/24000 条（差的是各连接计时器的起止），事件延迟 p50 1 ms、p99 3 ms | 过 |
| 中继 RSS | ≤ 100 MB | 空载 89.0，满载最高 **94.3 MB**。空载那 89 MB 是这台服务器上 Node 本身的底数，20 个会话只加了 5 MB | 过（余量薄，大头是 Node 底数） |
| 主增量 RSS | ≤ 50 MB | **+6.9 MB**（总 101.8） | 过 |
| 改一个字节 → 断开 | 10/10 | 恶意中继角色的代理在握手 1/2、`auth`、`req`、`res` 里随机翻一位：上行 **10/10**、下行 **10/10** | 过 |
| 配对码换主公钥 → 握手失败 | 10/10 | **10/10**（主读不出第一条握手消息） | 过 |
| 别的通道的 `auth` 重放 → 失败 | 10/10 | 明文重放（A 的 `auth` 帧在 B 通道发）**10/10**；密文重放（A 的加密 `auth` 注进 B 通道，中继能做的事）**10/10** | 过 |
| Hermes 完整握手（设备一侧） | ≤ 50 ms | Hermes 0.13 CLI，Mac（Apple M5）：**22–23 ms**；手机 **真机待测** | Mac 上过 |
| Hermes 64 KiB 加密 + 解密 | ≤ 5 ms | 同上：**35 ms**；Node 24 同一份代码 0.42 ms | **不过** |
| Hermes 持续吞吐 | ≥ 5 MB/s | 同上：1 MiB 帧加密 + 解密 **1.8 MB/s**，只解密 3.6 MB/s；Node 160 / 323 MB/s | **不过** |

- 测法：中继、主跑在服务器的临时目录（`/opt/node` 的 Node 26），只绑 `127.0.0.1` 的 7830、7831，防火墙没开这几个口，从 Mac 经 `ssh -L` 连；20 连接那项当时 Mac 到服务器很慢（建隧道里的连接超时），客户端改在服务器本机回环上跑（20 个 socket、每秒 200 条，客户端开销很小，服务器 4 核、负载 6 左右）。测完进程都杀了，临时目录删了。
- Hermes：手机不在，安卓模拟器要先出一个 RN release 包，超出一小时的预算，没做。用的是 facebook/hermes 官方发布的 0.13.0 CLI（对应 RN 0.75），esbuild 打包、Babel 降 class（Hermes 0.13 不认 class，RN 的 Babel 预设也是这么做）、`hermesc -O` 出字节码，跑三次数字一致。Mac 的 M5 比手机快，手机只会更慢；新版 Hermes 会快一些，但差 7 倍（64 KiB）补不上。CLI 里没有 `crypto.getRandomValues`、`TextDecoder`，探针里垫了只供计时的替身。
- **走「不过」一栏**：ChaCha20-Poly1305 和 X25519 在 Hermes 上换原生，Noise 状态机不变（02 已改）。
  - 选 `react-native-quick-crypto` 1.1.10（依赖 `react-native-nitro-modules` 0.37.2）：有 C++ 的 `chacha20-poly1305` 和 `crypto.diffieHellman`（X25519），接口照 `node:crypto`；registry 包没有 install 脚本（只有 `prepare`，从 registry 装不跑）；要 prebuild，07 本来就有本地模块。07 依赖表加了一行。
  - 探针里已经把 AEAD 抽成接口：`cipher-state.ts` 的 `Aead` + `useAead()`，默认 noble；`aead-node.ts` 用 `node:crypto` 实现（quick-crypto 是同一套调用）。换上它向量和全部测试照过，Node 上 64 KiB 0.09 ms、吞吐 750 / 1600 MB/s（noble 的 5 倍）。X25519 按同样的办法抽 `Dh` 接口，W1b 做。
  - 握手在 Mac 的 Hermes 上过了，X25519 也换是因为「不过」一栏写的是两个一起换，而且手机慢几倍后 50 ms 没把握。
  - 主和节点也用 `node:crypto` 的 AEAD ※（理由：同一个接口，OpenSSL 常数时间比 tag，快 5 倍；noble 留给网页、Electron 渲染进程和测试对照）。
  - 真机拿到后照 `bench/crypto-speed.ts` 在 release 包里重测三项，填进本节；原生版也不过再回来找我。
- W2 要顺带确认：RN 里 `TextDecoder` 支持 `fatal`（`decodeJson` 用），随机数走 quick-crypto 的 `getRandomValues`。

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

结果（2026-11-28；代码在分支 `probe/p11` 的 `probes/p11/`，README 有每项的重跑方法）：

- 环境：Mac（Apple M5，24 GB，macOS 27.0.1）；Electron 45.5.0（Chrome 156、Node 24）；Expo 58.1.0、expo-router 58.0.33、RN Web 0.21.4、Uniwind 1.14.0 + Tailwind 4.3.5。检查由 `desktop/probe.ts` 在真窗口里自动跑，结果写 JSON。

| 项 | 门槛 | 结果 | 过 |
|---|---|---|---|
| 路由直达、刷新 | 不 404 | 18 条（六个 tab、`/self`、`/self/devices`、`/pair`、`/item/demo-ref`、`/item/v1.2`、`/probe/*`）直达、刷新都到原路由，0 个 404 | 过 |
| 路径逃逸 | （07） | `..`、`%2e%2e`、`%2e%2e%2f`、`..%5c`、`/_expo/../../main.ts`、`%00` 共 6 条都 404；单测另查符号链接出根、别的 host | 过 |
| CSP 报错 | 0 | 07 的 CSP 下 **0** | 过 |
| 去掉 `style-src 'unsafe-inline'` | 能去就去 | **去不掉**，见下 | 记下原因 |
| 冷启动到首屏 | ≤ 1.5 s | 起进程到首屏中位 **352 ms**（5 次 337–358）；主进程起来到首屏中位 242 ms。系统缓存是热的 | 过 |
| 关异步路由 | 包能出、能跑 | `asyncRoutes: { web: false, default: false }`，产物里没有路由分块，上面各项都在这个包上测 | 过 |

- `'unsafe-inline'` 去不掉的原因：RN Web 运行时建 `<style id="react-native-stylesheet">`，用 CSSOM `insertRule` 往里塞规则；没有 `'unsafe-inline'` 时 CSP 拦掉「Applying inline style」，规则数 −1，布局全坏（屏幕成 `display: block`、该竖排的横排）。Uniwind 也注入 `<style id="uniwind-dynamic-styles">`。`script-src` 保持 `'self'`，脚本不受影响。
- Expo 默认模板在 `index.html` 里带一段内联 `<style>`（根节点重置）。换成自定义 `public/index.html`（不带内联样式），重置挪进 `global.css`；这和 `'unsafe-inline'` 无关，但以后哪天 RN Web 不再运行时注入，CSP 就能直接收紧。
- 07 已改：CSP 那行写明原因；`public/index.html` 不带内联样式。

## P4 设备密钥

- 安卓（我的手机）：
  - Keystore 生成 Ed25519 能否用；不能就走包裹路线（AES-GCM 包软件密钥）。两条路都测。
  - 签名 ≤ 50 ms；杀进程、重启手机、装新版本 App 后密钥还在，签名还能过主的验签；卸载后没了（预期）。
- Electron：Mac 上 `safeStorage` 后端是钥匙串；Windows 上 DPAPI；重启、升级 App 后还在。故意让后端是 `basic_text`（Linux 无钥匙环环境）时拒绝配对。
- 不过：Keystore Ed25519 不行 → 包裹路线（06 已写）；包裹也不行 → 回来找我。

结果（2026-11-28；Electron 部分，代码同 P3）：

| 项 | 结果 | 过 |
|---|---|---|
| Mac 后端 | `keychain`；钥匙串里一条「SStudioBot P11 Safe Storage」；`device.key` 是 `v10` 开头的密文，权限 0600 | 过 |
| 重启后还在 | 同一个 `userData` 重启，公钥相同，签名过 `@noble/curves` 验签 | 过 |
| 升级后还在 | `version` 0.0.1 → 0.0.2 再启动，公钥相同 | 过 |
| `basic_text` 拒绝 | 强制后端为 `basic_text`：生成密钥、配对都拒，不写任何文件 | 过 |
| Ed25519 | `node:crypto` 生成，PKCS8 DER 加密后存；签名 = `sbot-auth/1` 或 `sbot-pair/1` ‖ 握手 hash ‖ challenge；`device_id = sha256(公钥)`；noble 验签过 | 过 |
| 配对后 CSP 带中继 | 虚构配对链接（`relay.example`）配对后重载，CSP 多出 `connect-src wss://relay.example`；坏链接拒（报 `version`） | 过 |
| 渲染进程拿不到密钥 | 渲染进程没有 `require`，`process` 只剩 `{env}`；bridge 只有 07 列的那几个函数 | 过 |
| Windows DPAPI | **待测**（没有 Windows 机器） | 待测 |

- Electron 45 把同步的 `safeStorage.isEncryptionAvailable` / `encryptString` / `decryptString` 标了废弃，换 `isAsyncEncryptionAvailable` / `encryptStringAsync` / `decryptStringAsync`（返回 Promise，解密结果另带 `shouldReEncrypt`）。探针用的同步版能用；W2 直接写异步版（07 已改）。
- `getSelectedStorageBackend()` 只在 Linux 有意义（返回 `basic_text`、`gnome_libsecret`、`kwallet*`）；Mac、Windows 按平台判定（07 已改）。
- 安卓：**待测**（Keystore 模块没写；手机到了按本节门槛测）。

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

结果（2026-11-28；代码在分支 `probe/p10` 的 `probes/p10/`，README 有重跑方法）：

- **选 A**，和 03 原来的默认一致，03 不改做法，只把「探针前的默认」改成已定。
- 做法：pi 1.5.2 嵌入，pi → 记录器 → 旧 `proxy.ts`（单独进程持密钥，探针只拿 run 令牌）→ 上游。同家 = Claude 小档↔中档，跨家 = Claude 小档↔一个 GPT 系模型，两个方向各一半。工具 `lookup`：单数号试验一轮里并行发两个调用（一个立刻返回，一个挂住）。挂住时换模型：A 放行后本轮自己接着跑；B `abort()`、工具回一条「已取消」错误结果、换模型、再发一句「接着做」。挂住的工具不理 abort（同旧 `piTools`）。
- 上游 400：A、B 各 20 次（同家、跨家各 10），**共 0**；全部 80 次请求都是 200，流里没有 error 事件，没有错误原文可记。pi 在 `tool_use` 后没补 `No result provided`。换之后第一条请求每个 `tool_use` 都紧跟恰好一条结果，已返回的结果原样在。

| 做法 | 范围 | 次数 | 400 | 历史合法 | 挂住那个调用的真结果进了上游请求 | 换模型后模型又调了工具 |
|---|---|---|---|---|---|---|
| A | 同家 | 10 | 0 | 10/10 | 10/10 | 0/10 |
| A | 跨家 | 10 | 0 | 10/10 | 10/10 | 5/10（见下） |
| B | 同家 | 10 | 0 | 10/10 | 0/10 | 10/10 |
| B | 跨家 | 10 | 0 | 10/10 | 0/10 | 10/10 |

- **为什么不选 B**：B 没有 400，但不过「工具结果不丢」。被取消的调用其实跑完了，真结果没有进过任何一次上游请求（0/20），模型只看到「已取消」。20/20 里模型都把挂住的调用重发了一遍；其中跨家的 5 次连已经返回的那个也重发。也就是同一个调用跑两次，副作用重复。工具真能响应 abort 时副作用是否半截，探针没测，这点只会更糟不会更好。
- **没测到的 A 的代价**：探针里放行是即时的，A 要等的工具耗时记 0；B「换得更快」在这里量不出来，要看真实工具的耗时。A 的换模型耗时中位：同家 1.3 s、跨家 11 s（含新模型一整轮回复，不是等待）。
- **A 跨家的一条发现**：跨家换成 GPT 系再换回 Claude 的 5 次里，Claude 在历史里看到 GPT 系的调用 id（`call_…` 形，Claude 自己的是 `toolu_…`）后又把调用重发了一遍（5/5，并行的连已返回的那个也重发），回复里没有代码（A 跨家整体带上代码 7/15）；Claude→GPT 的 5 次、同家 10 次都正常。对照：把其中 3 次的请求原样重放，3/3 又调工具；只把 `call_` 改成 `toolu_` 重放，3/3 直接回文字。样本小，但指向 id 形状。pi 的 `normalizeToolCallId` 只替换非法字符，`call_` 本来合法，不会改。W1 的 runner 换模型时先把历史里的调用 id 统一成目标家的形状，用同样的重放再验一次；这条不挡 P10。
- 没覆盖：thinking 关着，没有带签名的 thinking 块跨模型的情形（03 的「先剥 thinking」照旧）；只测了一个未完调用的两种形态（单个、一立刻一挂住）。
- 花费：约 95 次上游请求（含 1 次列模型、一次 8 次的小跑、6 次重放），代理 `usage` 表合计约 $0.19（Claude 档，按 `models.yaml` 的价）；GPT 系那 22 次配置里没价，只记 token，约 21k 输入、0.6k 输出、58k 缓存读。

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

结果（2026-11-28；代码同 P3）：

- 桌面：同 P3 的 Mac 和 Electron。安卓：**模拟器**（pixel_7 配置、Android 15 / API 35 arm64，跑在同一台 Mac 上），release 包、Hermes、新架构，只装 arm64；下面安卓的数字都是模拟器的，手机 **真机待测**。
- 自动化：桌面由 `desktop/probe.ts` 驱动（`webContents.debugger` 发 CDP 事件，读 DOM）；安卓用 deep link 打开检查页，结果从 logcat 的 `PROBE {json}` 读，点击用 `adb shell input`。

| 检查 | 桌面 | 安卓（模拟器） | 过 |
|---|---|---|---|
| ① 明暗 | 色块 light ↔ dark 都对（背景 255 → 10，primary 23 ↔ 250） | 对（截图） | 过 |
| ① hover | `hover:bg-accent` 255 → 245 | 触屏，不适用 | 过 |
| ① 弹出层 | 按钮底 224.5、内容 y 230.5，左边都是 24（`sideOffset` 6）；暗色背景对 | 按钮底 229.0、内容 y 235.0，左边都是 24；暗色对 | 过 |
| ② 帧率 | 中位 60，最大单帧 19 ms，p95 18 ms，> 100 ms 的 0 帧 | 中位 60，最大 27 ms，p95 21 ms，0 帧 | 过 |
| ② 贴底 / 不拽回 | 离底始终 0；上翻后位置不变 | 同 | 过 |
| ② 跨消息选字 | 一次选中 127 字，跨多条消息 | （门槛只要网页） | 过 |
| ③ 外部请求 | 0（开 CSP）；关 CSP 只看渲染器也是 0，正对照被记录器看到 | 渲染过；抓包 **没能证明**，见下 | 桌面过，安卓待测 |
| ④ 加粗 4 种 | 都加粗；跨行一度渲染成「跨 行」，修了，见下 | 同一套渲染器 | 过 |
| ④ 行高 | 三种字体 clientH 24 = scrollH 24，行盒 26，不裁 | 三种字体都是 24（asc 19、desc 5） | 过 |
| ④ 组字时回车 | CDP 模拟组字：组字中回车发出 0 条，上屏后回车发出 1 条 | 没自动化 | 桌面自动化过；Gboard、搜狗、macOS 拼音 **待测** |
| ⑤ 400 行高亮 | 7 ms（首次 11） | 热 **85–109 ms**；冷启动后第一次 92–237 ms | 热的过；冷的首次超 |
| ⑤ 2000 行 diff 文件列表 | 69 ms（`@pierre/diffs`） | **49–55 ms** | 过 |
| ⑥ 包大小 | 首屏 5 个文件 6506 KiB / gzip **1204 KiB**；全部 346 个文件 14.3 MiB / gzip 2.9 MiB | APK（只 arm64）**36.7 MiB**（38 520 112 字节） | 只记 |

- ③ 样本：07 的恶意样本集落成 `src/probe/evil.ts` 27 条（远程图片、`<img>`、`<script>`、iframe、CSS `url()`、`javascript:` / `vbscript:` / `data:` / `file:` 链接、超长 URL、链接文字和地址不一致等），域名都是 `evil.example`；同一套样本是 `app/test/render.test.ts` 的单测（每条：只出白名单节点、危险协议的链接 `ok: false`、树里没有能发请求的节点）。桌面 27 个链接都要先确认才开；`@pierre/diffs` 打开 diff 时 shiki 的分块从 `sbot-app://` 本地加载，没有 CDN。
- ③ 安卓抓包：模拟器 `-tcpdump` 抓到的 DNS 里没有 `evil.example`，但正对照（模拟器里 `ping` 一个域名）也没出现，抓包文件运行中不落盘、连 Chrome 首次启动的流量都没有；Android 15 默认私有 DNS 走 853，明文 DNS 也看不到。所以这个 0 不算数。渲染器两端是同一份代码，原生上没有 `Image`、WebView，样本只能变成文字。真机用 mitm 代理或路由器抓包补，**待测**。
- ⑤ 走「不过」一栏 ※：Hermes 上热的过、冷的首次超。另测到一处更要紧的：同一页放一个 400 行代码块，**整块一个 `<Text>`（几千个 span）时安卓 UI 线程卡 22–24 s**，改成每行一个 `<Text>` 后整页 0.72–0.78 s，不放代码块 0.05 s；字体串对结果没影响。选：
  - 每行一个 `<Text>`（必须，07 已改）；
  - 安卓折叠阈值 400 → 200 行，仍先显示前 80 行 ※（理由：按 400 行的数字折算，80 行高亮约 20 ms、渲染约 0.15 s，没单测；展开是用户自己点的；网页 7 ms，不改）；
  - 没做分段高亮：热的已过，冷的首次是 Hermes 刚起来的开销，真机再测。
- ④ 修的两处（07 已改）：
  - 中文之间的软换行（源文本里的换行）RN 渲染成空格，「跨行加粗」成了「跨 行」。渲染器里两侧都是中文的软换行丢掉。
  - 组字判断用 `isComposing || keyCode === 229`。不能 `{...e.nativeEvent}` 展开 DOM 事件：这些字段是原型上的 getter，展开后是 `undefined`，判断永远是「不在组字」。RN Web 自己的 `onSubmitEditing` 组字时也不触发。
- ② 网页上 Legend List 都过，不换 `@tanstack/react-virtual`（07 已改）。
- ⑥ 体积里最大的是 `@shikijs/langs` 3.6 MB（`@pierre/diffs` 带进来的全部语法）。lowlight 的入口顺带 import 了 highlight.js 全部语言（1.5 MB 源码），Metro 里把 `lowlight` 指到 `lib/index.js`，自己注册 16 种后 87 KB（07 已改）。W2 试把 `DiffView.web` 拆成按需加载。
- 安卓另外踩到的（07 已改）：
  - Android 15 强制 edge-to-edge，不留顶部安全区时标题压在状态栏下，顶部的按钮点不到。根布局用 `useSafeAreaInsets` 留出来；`react-native-safe-area-context` 的 `SafeAreaView` 是第三方组件，Uniwind 不映射它的 `className`，写了 `className="flex-1"` 会塌成 0 高、整屏空白。
  - 状态栏图标颜色跟应用的主题（`expo-status-bar` 按 Uniwind 主题设），不跟系统。

§触6.9 P1.5 余项：

| 项 | 结果 |
|---|---|
| 扫码配对 | 配对链接的解析和校验有单测（只收 `wss`、主机名字符、32 字节公钥和密钥、角色、过期）；桌面经链接配对过（P4）。扫码 **真机待测** |
| 切后台再回来能续（P2） | **真机待测** |
| 杀进程后密钥还在（P4） | 桌面过；安卓 **待测** |
| agent 的 HTML 交给系统浏览器 | 桌面：写 `<temp>/sbot-html/<sha>.html`，`shell.openPath` 打开系统浏览器；localStorage 两次打开计数 1 → 2。安卓（模拟器）：App 缓存目录 + `FileProvider` 的 `content://` 地址 + `ACTION_VIEW`，Chrome 打开，计数 1 → 2。系统选择框里还有一个「HTML Viewer」（系统自带，只能看），W2 优先交给默认浏览器 |
| Health Connect 能读 | **真机待测**（模拟器没装数据，没测） |
| `@pierre/diffs` 不上网拉语法和主题 | 过（见 ③） |

- 回来找我：没有触发。※ 的只有 ⑤ 的安卓折叠阈值。
- 单测 46 条全过：`node --test`，跑 `probes/p11` 下的 `npm test`。
