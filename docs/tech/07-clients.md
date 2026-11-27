# 07 客户端（`clients/`）

设计在 §触6.1–§触6.5、§触6.8；这里定栈、目录、渲染规矩、壳和 CI。安卓用 Expo，桌面用 Electron 装同一份网页产物，一套界面。iOS、网页端不做。

## 目录

```
clients/                 npm workspace，自己的 lockfile；Node 24 构建（Expo 58 拒奇数版本）
  app/                   Expo + expo-router
    app/                 路由：(tabs)/ 对话 · 办 · 读 · 参 · 觉 · 改；self/（它自己：提案、节点、用量、配置、设备、连接、信息源）；pair.tsx
    src/conn/            连接状态机：WS → Noise → auth → bootstrap → stream（用 ../../protocol）
    src/store/           规范化 store
    src/render/          markdown、代码块、diff、不可信内容规矩
    src/ui/              从 react-native-reusables（Uniwind 版）抄进来的组件，改成 coss 的变量
    src/device/          设备密钥：device.native.ts（Expo 本地模块）、device.web.ts（调 Electron bridge）
    modules/device-key/  Expo 本地模块（Kotlin）：Keystore
    global.css           coss 变量 → Tailwind 4 `@theme`
  desktop/
    main.ts  preload.ts  protocol.ts  keys.ts
```

- `protocol/` 在仓库根，客户端经 Metro 的 `watchFolders` 引进来；`protocol/` 用到的 `zod`、`@noble/*` 从 `clients/node_modules` 解析。两份 lockfile 里这几个包的版本必须一样，CI 比对 ※（理由：同一份 schema 两边解析结果不同会出怪错）。
- `.ts` 后缀的 import、可擦除 TS 照仓库约定；`clients/` 有构建，但不因此用 `enum` 之类，和 `protocol/` 保持同一套写法。

## 依赖（全部锁死）

| 用途 | 包和版本 | 备注 |
|---|---|---|
| 框架 | Expo SDK 58、expo-router、react-native-web `~0.21.4` | 我们的代码不用 RN Web 私有属性 |
| 样式 | Uniwind 1.14 + Tailwind 4 | 组件抄 react-native-reusables 的 Uniwind 版，需要时加 `@rn-primitives/*` |
| 主题 | coss ui 的变量 | 原样：中性灰、黑色主按钮、圆角 10px、明暗两套；只借变量，不引 coss 的 React 组件（它是 DOM 的） |
| markdown | markdown-it 15.0.3、markdown-it-cjk-friendly 3.0.0、remend 1.5.1 | token → RN 组件的渲染器自己写，只做映射，越薄越好 |
| 代码高亮 | lowlight 3.3.0 + highlight.js 11.12 | 只注册常用语言（下面） |
| diff | `@pierre/diffs` 1.7.2（只桌面）；退路 `diff`（jsdiff） | 见「diff」 |
| 列表 | `@legendapp/list` 3.9.2；退路 `@tanstack/react-virtual`（只网页） | `ChatList.native.tsx` / `ChatList.web.tsx` 一开始就分开 |
| 图标 | lucide-react-native 1.82 | ISC，本地 SVG |
| 动画、手势、键盘 | reanimated 4.7.1、react-native-worklets 0.13、gesture-handler 3.3、react-native-keyboard-controller 1.22.7 | reanimated 一系跟 Expo 的绑定表走 |
| 浮层 | `@rn-primitives`（菜单、对话框）、`@expo/ui` BottomSheet | 桌面上底部面板换成对话框或侧栏 |
| 状态 | 不引库 | 手写 store + `useSyncExternalStore` |
| 推送 | expo-notifications | 只用 `getDevicePushTokenAsync()` 拿 FCM 令牌，不用 Expo 推送服务 |
| 扫码 | expo-camera | 配对码 |
| 桌面壳 | electron（锁版本，CI 显式装二进制并校验 checksum） | |

- 每加一个包：查 install 脚本、查有没有运行时去网上拉东西（字体、主题、wasm、CDN）；有就不收或关掉。
- 字体不打包：系统字体。桌面 `font-family` 栈 `-apple-system, "PingFang SC", "Microsoft YaHei", "Noto Sans CJK SC", sans-serif`；网页产物 `lang="zh-CN"`。

## 连接（`src/conn/`）

1. 读本地存的配对信息（主公钥、中继地址、`device_id`）。没有就进 `pair.tsx`。
2. `new WebSocket(<中继>/v1/peer?hub=…)`（RN 和 Electron 渲染进程自带）→ Noise NK 握手（`protocol/noise`，Hermes 上的速度 P1 实测）→ `auth`（签名在 `src/device/`）。
3. `POST /api/v1/bootstrap` → 灌进 store → `POST /api/v1/stream { after: seq }`。
4. 断了按 1、2、5、10、30 秒退避重连，`after` 用 store 里最新的 seq；收到 `reset` 清 store 重来；关闭码 4404 显示「等主上线」。
5. 协议版本比 `min` 旧：整屏提示升级，不连。

- **写操作**：按 02 路由表的类型。乐观的先改 store，失败回滚并就地提示；确认后才算的按钮转圈，等 `res`；乐观锁 409 时用回来的最新内容替换并提示。没回 `res` 就断线的写操作留在内存队列，重连后用同一个 `client_op_id` 重发。App 被杀就丢（内容不落盘），界面下次打开不假装发出去了。
- **在场**：前台且有触摸、键盘、滚动时，最多每 30 秒发一次 `POST /api/v1/presence { foreground: true, viewing }`；`viewing` 是当前打开的 thread 或卡片的 ref；切后台立刻发 `foreground: false` ※。
- **安卓后台**：不保活连接，系统掐了就掐；靠 FCM。回前台用 `after` 续。

## store（`src/store/`）

- 一个 `Map<entity, Map<id, { seq, data }>>`；`ev` 的 `seq` 不比存着的新就丢。`delete` 删条目。
- 组件用 `useEntity(entity, id)`、`useList(entity, filter)`，底下 `useSyncExternalStore` + 选择器，只在选中的那几条变了时重画。
- delta：按 `(run, item)` 存正在流的文本；`chunk_seq` 不是上一个加一就丢掉这段，等 `snapshot`。
- 展开、折起工具调用时发 `stream/expand` / `collapse`。
- 切 thread 只读 store；没加载过的历史用 `threads/:id/items?before=` 往前翻。
- **不落盘**：内容只在内存。落盘的只有配对信息、设备密钥（各自的系统机制里）、界面偏好（明暗、通知开关）。`personal` 的内容一律不落盘（硬规则，§触6.4）。

## 渲染（`src/render/`）

### 不可信内容（veto 2，§触6.8）

agent 输出、消息、邮件、diff、工具结果一律当不可信：

- markdown-it 开 `html: false`、`linkify: true`；渲染器只认白名单 token：段落、标题、强调、加粗、删除线、行内代码、代码块、引用、列表、表格、分隔线、链接、图片、换行、文本。别的 token 按纯文本显示。
- 图片、视频、HTML 不发任何网络请求：图片显示占位框和地址，点了按链接处理。`data:` 图片也不显示 ※（理由：省一条解码路径；要看就交给浏览器）。
- 点链接先弹确认，显示完整地址（标出和链接文字不一致的情况）；只放行 `http`、`https`、`mailto` ※；确认后交给系统浏览器（安卓 `Linking.openURL`，桌面经 bridge 的 `shell.openExternal`）。
- 流式时 remend 补出来的半截链接、图片是死的：不可点，等这段写完再变成链接。
- 验证：P11 抓包，渲染一组恶意样本（远程图片、`<img>`、`<script>`、iframe、CSS url、`javascript:` 链接、超长 URL）时外部请求数必须为 0，不过就挡住这一波（08）。

### markdown 和代码

- `markdown-it-cjk-friendly` 修中文旁边的 `**加粗**`（P11 测 4 种加粗情形）。
- 流式文本先过 remend 补全未闭合的标记，再解析；只重解析最后一个块，前面已闭合的块缓存 token ※。
- 代码块：lowlight 注册 `bash shell json yaml typescript javascript tsx python go rust sql diff markdown css xml ini dockerfile`；别的语言按纯文本。正在流的代码块（还没遇到收尾的 fence）不高亮。hast → 嵌套 `<Text>`。超过 400 行先显示前 80 行加「展开」※（Hermes 上的耗时 P11 实测，不达标改阈值）。
- 中文：行高不裁字（P11 测）；输入法组字时不发送、不抢焦点。

### diff

- 桌面：`DiffView.web.tsx` 用 `@pierre/diffs` 1.7.2（DOM 组件，RN Web 下直接用）。它用 shiki：语法和主题打进包里，不许运行时去 CDN 拉（P11 的抓包一起查）；拉了就换退路：jsdiff 算块 + lowlight 的 `diff` 高亮。
- 安卓：`DiffView.native.tsx` 只显示改了哪些文件、各加减几行；点一个文件显示 lowlight `diff` 高亮的原文块；顶上一个「去 git 上看」（PR 或 commit 链接，同样先确认）※。不做并排、不做逐词。
- diff 内容走 blob 拉取（02 大载荷），只在展开时拉。

### 列表

- `ChatList.native.tsx`：Legend List，倒序、贴底、往上翻时不被新消息拽回去（离底超过一屏就停止跟随，显示「有新消息」）。
- `ChatList.web.tsx`：先用 Legend List；P11 里跨消息选择文字、贴底、滚动不跳任何一项不过，就换 `@tanstack/react-virtual`。

## agent 做的 HTML（D14）

- 事件里是 `{ ref: "blob:<sha>", name, size }`，时间线显示一行「打开」。
- 桌面：bridge 的 `html.open(sha)`，主进程拉 blob 写到 `<temp>/sbot-html/<sha>.html`，`shell.openPath` 交给系统浏览器；启动时清掉 24 小时前的。
- 安卓：写到 App 私有缓存目录，经 `FileProvider` 只读分享，`ACTION_VIEW` 交给浏览器；24 小时后清（§触6.4 的例外）。

## Electron（`desktop/`）

- `BrowserWindow`：`contextIsolation: true`、`sandbox: true`、`nodeIntegration: false`、`webSecurity: true`。`will-navigate` 一律拦；`setWindowOpenHandler` 一律拒，链接走 bridge；`session.setPermissionRequestHandler` 全拒 ※（桌面不扫码、不用摄像头和麦克风）。
- **自定义协议**：`sbot-app://app/`，第一次发版前定死 ※。`protocol.registerSchemesAsPrivileged` 设 `standard`、`secure`、`supportFetchAPI`；`protocol.handle` 只从包内 `web/` 目录读：解码后 `path.normalize`，不在 `web/` 里就 404；没有扩展名的请求回 `index.html`。网页产物用 `expo export -p web`，`web.output = "single"`，网页上关异步路由。
- **CSP** 由 `protocol.handle` 的响应头给（不写在 HTML 里）：`default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; media-src 'none'; object-src 'none'; frame-src 'none'; connect-src 'self' wss://<配对时存的中继主机>`。中继主机来自主进程存的配对信息，包里没有任何实例地址。`style-src 'unsafe-inline'` 是 RN Web 运行时注入样式要的（P3 核实能不能去掉）。
- **密钥**：`keys.ts` 在主进程用 `node:crypto` 生成 Ed25519，`safeStorage.encryptString` 后存 `userData/device.key`；`safeStorage.getSelectedStorageBackend()` 是 `basic_text` 就拒绝配对并说明（06）。
- **bridge**（`preload.ts` 的 `contextBridge`，就这几个）：
  - `device.publicKey()`、`device.sign(handshakeHash, challenge)`
  - `pair.accept(link)`：主进程校验配对链接、存主公钥和中继地址，重载窗口让 CSP 带上中继 ※；`pair.onLink(cb)`：系统用 `sstudiobot://` 唤起时把链接交给页面
  - `link.open(url)`：主进程再查一遍协议白名单，`shell.openExternal`
  - `html.open(sha)`
  - `notify(title, body, ref)`：窗口在后台时弹本机通知，点了切到那一条
- 只在本机构建、自用，不签名不公证（D10）；Mac 先，Windows 同一个包。

## 安卓

- **设备密钥**（P4 定细节）：`modules/device-key` 本地模块。API ≥ 33 且 Keystore 支持 Ed25519：在 Keystore（有 StrongBox 就用）里生成，不可导出；否则 noble 在 JS 里生成，Keystore 里一把不可导出的 AES-GCM 包起来，密文存 App 私有目录。JS 只拿到 `publicKey()`、`sign()`。
- **FCM**：`getDevicePushTokenAsync()` → `PUT /api/v1/devices/self/push-token`；令牌变了再交。`google-services.json` 是实例数据，`app.config.ts` 从 `~/.config/sbot/` 读路径，不进仓库。通知渠道四个：等我回、审批、任务、知道就好。点通知 → `sstudiobot://item/<ref>` 打开那一条。App 设置里能关手机通知（关了发 `push-token` 空值，主改推渠道）。
- **配对**：扫码（expo-camera）、系统唤起 `sstudiobot://pair#…`、「粘贴配对码」三条路。
- 构建：本机 `expo prebuild` + Gradle，不用 EAS 云构建、不用 EAS Update；侧载（D10），手动发版（D11）。
- 身体输入（拍体检报告、一句话记感受、Health Connect）在 09 的对应波次做；Health Connect 默认关。

## CI（`clients` job，01 的表）

改了 `clients/` 或 `protocol/` 时跑：

1. Node 24；`npm ci --ignore-scripts`（`clients/`）；比对 `zod`、`@noble/*` 和根 lockfile 一致。
2. `tsc --noEmit`；`node --test`（store、连接状态机、markdown 白名单映射、链接判定，纯 TS 部分）。
3. `expo export -p web`；记下产物大小（P11 定基线，涨超过 20% 标红不拦 ※）；产物里 grep 不到实例配置的样式（域名、公钥格式的串）——和 `leak-guard.sh` 同一套规则。
4. 装 Electron 二进制（显式、校验 checksum），无头起一次 `desktop/`，加载 `sbot-app://app/` 不报 CSP 错。
5. 安卓 APK 不在 CI 出（要 `google-services.json`），在本机出。

`clients/` 合进 `main` 不重启主（01 部署，`sbot-deploy` 先改好才合）。
