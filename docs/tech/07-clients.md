# 07 客户端（`clients/`）

设计在 §触6.1–§触6.5、§触6.8；这里定栈、目录、渲染规矩、壳和 CI。安卓用 Expo，桌面用 Electron 装同一份网页产物，一套界面。iOS、网页端不做。

## 目录

```
clients/                 npm workspace，自己的 lockfile；Node 24 构建（Expo 58 拒奇数版本）
  app/                   Expo + expo-router
    app/                 路由：(tabs)/ 对话 · 办 · 读 · 参 · 觉 · 改；self/（它自己：提案、节点、用量、配置、设备、连接、信息源）；pair.tsx
                         W3 有 对话 · 线程 · 等你、thread/[id]、item/[ref]、self/（省心、手机通知、设备）、pair、selftest（P11 ③ 恶意样本，桌面自检用）；
                         W4 加 任务（(tabs)/tasks）、task/[id]、task/new（派活）、self/nodes；其余随波次加
    src/task/            diff 切分（diff.ts）、DiffView（.web 用 @pierre/diffs，.native 文件列表）、DiffBlob、任务状态和插话措辞（status.ts）
    src/conn/            连接状态机（WS → Noise → auth → bootstrap → stream）、写层（writes.ts、actions.ts）、在场（presence.ts）
    src/store/           规范化 store（基线 + 乐观叠层）
    src/render/          markdown、代码块、diff、不可信内容规矩
    src/push/            FCM 令牌注册与四渠道规则（notify.native.ts / notify.web.ts）
    src/html/            agent 做的 HTML 拉取与校验（pull.ts / open.ts）
    src/ui/              从 react-native-reusables（Uniwind 版）抄进来的组件，改成 coss 的变量；纯 View 二维码（QR.tsx）
    src/device/          设备密钥：device.native.ts（Expo 本地模块）、device.web.ts（调 Electron bridge）
    modules/device-key/  Expo 本地模块（Kotlin）：Keystore + 界面偏好
    global.css           coss 变量 → Tailwind 4 `@theme`
  desktop/
    main.ts  preload.cjs  protocol.ts  keys.ts  html.ts    preload 是 CJS：sandbox 下的 preload 不能是 ESM
  scripts/               lock-check.ts（两份 lockfile 比对）、bundle-report.ts（产物大小、产物里的 ws 地址）
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
| 代码高亮 | lowlight 3.3.0 + highlight.js 11.12 | 只注册常用语言（下面）。lowlight 的入口顺带 import 全部语言，Metro 里把 `lowlight` 指到 `lib/index.js`（P11：1.5 MB → 87 KB） |
| diff | `@pierre/diffs` 1.7.2（只桌面）；退路 `diff`（jsdiff） | 见「diff」 |
| 列表 | `@legendapp/list` 3.9.2（P11 两端都过，不用退路） | `ChatList.native.tsx` / `ChatList.web.tsx` 一开始就分开 |
| 图标 | lucide-react-native 1.82 | ISC，本地 SVG |
| 动画、手势、键盘 | reanimated 4.7.1、react-native-worklets 0.13、gesture-handler 3.3、react-native-keyboard-controller 1.22.7 | reanimated 一系跟 Expo 的绑定表走 |
| 浮层 | `@rn-primitives`（菜单、对话框）、`@expo/ui` BottomSheet | 桌面上底部面板换成对话框或侧栏 |
| 状态 | 不引库 | 手写 store + `useSyncExternalStore` |
| 推送 | expo-notifications 58.1.10 | 只用 `getDevicePushTokenAsync()` 拿 FCM 令牌，不用 Expo 推送服务 |
| 二维码 | uqr 0.1.3 | 邀请码二维码：纯 JS 算矩阵、View 合并画块，无图无 SVG、无 install 脚本、无网络请求 ※ |
| 扫码 | expo-camera | 配对码 |
| 加密 | react-native-quick-crypto 1.1.10 + react-native-nitro-modules 0.37.2（只安卓） | Noise 的 ChaCha20-Poly1305、X25519 和随机数走原生（P1：Hermes 上 noble 太慢）；没有 install 脚本（只有 `prepare`，从 registry 装不跑）；要 prebuild |
| 桌面壳 | electron（锁版本，CI 显式装二进制并校验 checksum） | |

- 每加一个包：查 install 脚本、查有没有运行时去网上拉东西（字体、主题、wasm、CDN）；有就不收或关掉。
- 字体不打包：系统字体。桌面 `font-family` 栈 `-apple-system, "PingFang SC", "Microsoft YaHei", "Noto Sans CJK SC", sans-serif`；网页产物 `lang="zh-CN"`。

## 连接（`src/conn/`）

1. 读本地存的配对信息（主公钥、中继地址、`device_id`）。没有就进 `pair.tsx`。
2. `new WebSocket(<中继>/v1/peer?hub=…)`（RN 和 Electron 渲染进程自带）→ Noise NK 握手（`protocol/noise`；安卓上 AEAD 和 X25519 走 quick-crypto，02）→ `auth`（签名在 `src/device/`）。
3. `POST /api/v1/bootstrap` → 灌进 store → `POST /api/v1/stream { after: seq }`。
4. 断了按 1、2、5、10、30 秒退避重连，`after` 用 store 里最新的 seq；收到 `reset` 清 store 重来；关闭码 4404 显示「等主上线」。
5. 协议版本比 `min` 旧：整屏提示升级，不连。

- 关闭码（06，常量在 `protocol/pair.ts`，主的 `link/session.ts` 也从这里取）：4401 认不出、4410 被删 → 停在「要重新配对」，不再重连；4426 → 升级页；4404 → 等主，照退避；别的码和网络断开 → 退避重连。配对中收到 4401/4410 是「配对失败」（码过期、用过、伪造，或这把钥匙主见过）。
- 配对码：`protocol/pair.ts` 的 `decodePairCode` 解；设备再把 `relay` 收紧到 `wss://`（`ws://` 只许回环），不带用户名、查询、片段 ※（它要进桌面 CSP 的 `connect-src`）。连 `<relay>?hub=<hub_pk>`。码的 `secret` 只在内存里等主收下，不落盘。
- **每次配对一把新钥匙**（06：主见过的公钥，删了也不能再配）：桌面 `pair.accept` 时 `keys.renew()`，安卓先 `deleteKeys()` 再生成；「解除配对」删配对信息和私钥 ※。已经配对的设备要换主，先解除。
- W3 起设备写操作（改名、删除、邀请）走 `/api/v1`（确认后才算）；设备名和平台仍标明是各设备自称的，邀请码默认遮住、点开才显二维码和链接，到期自动清 ※。
- 安卓的 Noise 原语：启动时 quick-crypto 的 ChaCha20-Poly1305 和 X25519 先和 noble 对一遍（含篡改必须解不开），对上才换，否则留 noble 并在设备页标出 ※。

- **写操作**：按 02 路由表的类型。乐观的按 `client_op_id` 叠在 store 基线之上，失败回滚并就地提示，收到 `res.seq` 后等流追上同一帧一起撤（不闪）；确认后才算的按钮显示处理中，等 `res` 和流追上；乐观锁带 `draft_version`，409/410 用回来的最新内容替换并提示（改稿框里保留我刚写的文字，下次存基于主当前版 ※）。没回 `res` 就断线的写操作留在内存队列，重连后用同一个 `client_op_id` 重发。App 被杀就丢（内容不落盘），界面下次打开不假装发出去了。
- **在场**：前台且有触摸、点击、键盘、滚动时，最多每 30 秒发一次 `POST /api/v1/presence { foreground: true, viewing }`；`viewing` 是当前打开的 thread 或卡片的 ref，切屏立刻报并合并为 2 秒最多一次 ※；切后台立刻发 `foreground: false` ※。
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
- 代码块：lowlight 注册 `bash shell json yaml typescript javascript tsx python go rust sql diff markdown css xml ini dockerfile`；别的语言按纯文本。正在流的代码块（还没遇到收尾的 fence）不高亮。hast 按行切开，**每行一个 `<Text>`**，行内 token 嵌套 `<Text>`（P11：整块一个 `<Text>` 时安卓 UI 线程卡 20 s 以上）。超过阈值先显示前 80 行加「展开」：网页 400 行，安卓 200 行 ※（P11 的数字，真机再核）。
- 中文：行高不裁字（P11 测过）；两侧都是中文的软换行丢掉，不渲染成空格；输入法组字时不发送、不抢焦点：判断用 `isComposing || keyCode === 229`，不要展开 DOM 事件对象（字段是原型上的 getter，展开后全是 `undefined`）。

### diff

- 先切（`src/task/diff.ts`，两端同一份，纯 TS 有单测）：`splitDiff` 把 git diff 或普通 diff 切成文件，数加减行、认改名和二进制，不抛；文件名过 `safePath`，去掉 bidi 覆盖、零宽、控制字符，限 300 字；最多 1000 个文件，超了标「截断」。文本原样留着，只当文本显示。blob 解码用不抛的 `TextDecoder`（坏字节变 U+FFFD）。
- 两端都先列文件（`DiffFiles.tsx`：路径、旧名、加减行），点开一个看一个；只有一个文件时直接展开。
- 桌面：`DiffView.web.tsx` 用 `@pierre/diffs` 1.7.2（DOM 组件，RN Web 下直接用），每个文件单独 `parsePatchFiles` 后交 `<FileDiff>`。它把 diff 转成 hast，再用 hast-util-to-html 序列化，文本节点都转义。设置（1.7.2 逐项查过）：`preferredHighlighter: 'shiki-js'`（JS 正则引擎，不用 wasm）、`disableWorkerPool`（不起 worker）、`disableFileHeader`（文件头用我们自己的，显示清理过的路径）、不用 `loadDiffFiles`（它会去拉整份文件）、不传 `unsafeCSS`。语法和主题是 Metro 打进包里的动态分块，从 `sbot-app://` 加载，不去 CDN。解析不了或渲染抛错就退回 lowlight 的 `diff` 原文块。
- 桌面 CSP 没有 `wasm-unsafe-eval`，所以 Metro 把三处 wasm 换掉 ※：`@pierre/diffs` 的 `highlights` 后端和 shiki 的 oniguruma（`shiki/wasm`、`shiki/engine/oniguruma`）指到 `src/task/no-wasm.js`，一调就抛；`@pierre/patches`（wasm 逐词 diff）指到 `src/task/patches-jsdiff.js`，直接用 jsdiff（`diff` 9.0.0），这本来就是它在 wasm 用不了时的退路。不换的话，第一次逐词 diff 会先报一条 CSP 错再退回去，产物里还多一段内联 wasm（其中一段被 leak-guard 认成 `AKIA…` 密钥）。`canUseWASM` 只导出、库里没人调。
- 安卓：`DiffView.native.tsx` 同一份文件列表，点开一个文件显示 lowlight `diff` 高亮的原文块。不做并排、不做逐词。
- diff 内容走 blob 拉取（02 大载荷），只在展开时拉（`DiffBlob.tsx`，`pullBlob` 和 HTML 共用）；超过 `DIFF_MAX` = 4 MiB 的不拉，显示「太大了，去 git 上看」※，任务页顶上有 PR 链接（同样先确认）。
- 运行中的 diff：工具调用带的 `body.diff` 在工具行里直接显示；`name: "diff"` 的步骤显示一行可展开的 `diff_ref`；任务结束的 `diff_blob` 在任务页顶上。

### 列表

- `ChatList.native.tsx`：Legend List，倒序、贴底、往上翻时不被新消息拽回去（离底超过一屏就停止跟随，显示「有新消息」）。
- `ChatList.web.tsx`：Legend List（P11 里跨消息选字、贴底、不拽回都过）。

## agent 做的 HTML（D14）

- 事件体（`body` 或 `body.html`）里带 `{ ref: "blob:<sha>", name, size }` 且文件名是 `*.html?` ※，时间线显示一行「用浏览器打开」，绝不在应用内渲染。
- 桌面：渲染进程经 Noise 连接分片拉 `/api/v1/blobs/<sha>`（上限 20 MiB），交 bridge 的 `html.open(sha, bytes)`；主进程校验 sha256 与大小边界、校验目录非符号链接且归当前用户、原子写入 `<temp>/sbot-html/<sha>.html`（0600，干净十六进制文件名），`shell.openPath` 交给系统浏览器，启动时清掉 24 小时前的 ※（主进程不碰 Noise 连接）。
- 安卓：写到 App 私有缓存目录，经 `FileProvider` 只读分享，`ACTION_VIEW` 交给浏览器；24 小时后清（§触6.4 的例外）；该原生路由随安卓构建接上，未接上之前提示在桌面打开 ※。系统选择框里会有只能看的「HTML Viewer」，优先交给默认浏览器（P11）。

## 任务和节点（W4）

- **任务页**（`task/[id]`）：顶上目标、状态（`status.ts` 的 `taskLine`）、按钮，下面是 lane `task:<id>` 的时间线和插话框。任务从 `item/[ref]` 和对话里的任务卡点进来。
  - 状态：「需要你处理」（`needs_you`，断在半路的提示说一句就接着来）、「等你答」（`waiting_approval`）、「等额度」带恢复时间（`quota_until`，「HH:MM 自动接着跑」）、「等节点」带节点名，其余照 `status`。
  - 按钮按 `caps` 和状态（`can`）：停只在这一轮在跑时有；换机器在跑的时候不给，显示「先停这一轮才能换机器」（主同样回 409），选节点和 agent；取消在结束前都有。被拒的写操作就地显示主回的话。
  - 插话：发之前框下面说清会怎样（`steerHint`）：`caps.steer === true` 才说「插进这一轮」，没报或报 false 都说「排到下一轮开头」；在等卡片时说会先拒掉那张卡；取消了说发不进去。发完只按主回的 `applied` 说结果（`steerOutcome`）：只有 `applied === true` 才算插进去了 ※。排着的插话显示在顶上一行。
  - 详情（工作目录、仓库、worktree、session、PR、错误）不在流里：任务的 seq 变了 400 毫秒后重拉一次 `GET /api/v1/tasks/:id` ※。PR 链接走链接确认。
- **任务列表**（「办」旁的「任务」页）：`GET /api/v1/tasks?status=all`，按 `taskRank` 排：需要我 > 我没看时做完的 > 在跑 > 等着的 > 其余（§触6.2）。顶上「派活」。
- **派活**（`task/new`）：目标、节点（在线的在前）、agent（节点报的 `agents`）、可选仓库；`POST /api/v1/tasks` 确认后才算，成功就换到任务页。
- **节点页**（`self/nodes`）：状态、版本和 sha、agent 和版本、剩余额度和恢复时间；worktree 列表来自 `GET /api/v1/nodes`（worktree 不是流里的实体，节点或任务的 seq 变了就重拉 ※），能清的那条有「清理」（`POST /api/v1/nodes/:id/worktrees/cleanup`，确认后才算）。
- **节点来的卡**（`ApprovalCard`）：看一眼卡和问我卡显示「来自节点」、工具，命令、路径、cwd、参数各一个可折的代码块，**全文不截**（`permission.ts` 的 `detailOf`；以前只显示截断的预览）；请求里带的 diff 走 DiffView；请求太大、主只给了 `request_blob` 时点开拉全文。问我卡带 `questions`（AskUserQuestion）时每题一组选项（多选题可多选）加一个自己写的框，自己写的优先；**每题都答了**发送键才亮，发 `decide { action: "answer", answers }`，和别的决定一样带卡上显示的那个 `draft_version`，版本不对主回 409，卡换成新版。最多 20 题、每题 30 个选项，重复的题丢掉；只认卡上给的选项。

## Electron（`desktop/`）

- `BrowserWindow`：`contextIsolation: true`、`sandbox: true`、`nodeIntegration: false`、`webSecurity: true`。`will-navigate` 一律拦；`setWindowOpenHandler` 一律拒，链接走 bridge；`session.setPermissionRequestHandler` 全拒 ※（桌面不扫码、不用摄像头和麦克风）。
- **自定义协议**：`sbot-app://app/`，第一次发版前定死 ※。`protocol.registerSchemesAsPrivileged` 设 `standard`、`secure`、`supportFetchAPI`；`protocol.handle` 只从包内 `web/` 目录读：解码后 `path.normalize`，不在 `web/` 里就 404；没有扩展名的请求回 `index.html`。网页产物用 `expo export -p web`，`web.output = "single"`，网页上关异步路由。
- **CSP** 由 `protocol.handle` 的响应头给（不写在 HTML 里）：`default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; media-src 'none'; object-src 'none'; frame-src 'none'; connect-src 'self' wss://<配对时存的中继主机>`。中继主机来自主进程存的配对信息，包里没有任何实例地址。`style-src 'unsafe-inline'` 去不掉（P3）：RN Web 运行时往 `<style id="react-native-stylesheet">` 里 `insertRule`，Uniwind 也注入 `<style>`，没有它布局全坏。`public/index.html` 用自定义模板，不带内联 `<style>`（Expo 默认那段根重置挪进 `global.css`）。
- **密钥**：`keys.ts` 在主进程用 `node:crypto` 生成 Ed25519，`safeStorage.encryptStringAsync` 后存 `userData/device.key`（同步版 Electron 45 起废弃）；后端 Mac 是钥匙串、Windows 是 DPAPI，Linux 看 `safeStorage.getSelectedStorageBackend()`，是 `basic_text` 就拒绝配对并说明（06）。
- **bridge**（`preload.cjs` 的 `contextBridge`，就这几个；主进程只认自己窗口里 `sbot-app://app/` 发来的调用）：
  - `device.publicKey()`、`device.sign(handshakeHash, challenge, purpose)`：`purpose` 是 `auth` 或 `pair`，主进程按它加 `AUTH_PREFIX` / `PAIR_PREFIX`（`protocol/pair.ts`），页面拿不到别的签名用途
  - `pair.accept(link)`：`basic_text` 后端、已经配对过的都拒；校验配对码、换一把新钥匙，码只放在主进程内存里，重载窗口让 CSP 带上这个中继 ※；`pair.pending()` 重载后的页面取回这张码接着配；`pair.cancel()`
  - `pair.save(pairing)`：只收和内存里那张码对得上、`device_id` 是本机的配对信息，写 `userData/pairing.json`（主公钥、中继、`device_id`、角色，0600）；`pair.current()`；`pair.forget()` 删配对信息和私钥
  - `pair.onLink(cb)`：系统用 `sstudiobot://` 唤起时把链接交给页面（主进程先存着，页面 `takeLink` 取）
  - `link.open(url)`：主进程再查一遍协议白名单，`shell.openExternal`
  - `html.open(sha, bytes)`：主进程核对 64 位小写 hex、非空且 ≤ 20 MiB、sha256 吻合后原子写 `<temp>/sbot-html/<sha>.html` 并 `shell.openPath`（同 `fromApp` 校验，不改 CSP 与 `webRequest`）
  - `notify(title, body, ref)`：桌面通知那一波再加
- 出站：`webRequest` 再拦一层，不是 `sbot-app://` 的请求只放行连配对中继的 WebSocket ※。权限请求、权限检查一律否。
- `--selftest`：一次性的 userData 里加载 `/selftest`（27 个 P11 ③ 恶意样本，加 4 个恶意 diff：行里的 HTML 和脚本、文件名里的 HTML、bidi 和零宽文件名、代码里的 CSS `url()`），记所有非 `sbot-app://` 请求和 CSP 报错。恶意 diff 必须真的经 `@pierre/diffs` 渲染出来（`diffs-container` 的 shadow root 里有行，不是退路），shadow root 里不许出现 `img`、`script`、`iframe`、`a` 这类元素。最后页面自己 `fetch` 一个 `.invalid` 地址当金丝雀，必须被 CSP 拦下并被看到，否则前面的「零外部请求」不作数；都对才退出 0。
- 只在本机构建、自用，不签名不公证（D10）；Mac 先，Windows 同一个包。

## 安卓

- **设备密钥**（P4 定细节）：`modules/device-key` 本地模块。API ≥ 33 且 Keystore 支持 Ed25519：在 Keystore（有 StrongBox 就用）里生成，不可导出；否则 noble 在 JS 里生成，Keystore 里一把不可导出的 AES-GCM 包起来，密文存 App 私有目录。JS 只拿到 `publicKey()`、`sign()`。模块同时提供 `getPref` / `setPref` 存少量界面偏好（如手机通知开关，键名限 `[a-z_]{1,32}`、值限 200 字，不存内容与密钥）※。
- **FCM**：没交过令牌时先发 `PUT /api/v1/devices/self/push-token { token: null }` 探测，主答 `fcm_enabled: true` 才向系统要通知权限与 `getDevicePushTokenAsync()` 令牌 ※；令牌变了再交。`google-services.json` 是实例数据，`prebuild` 从 `~/.config/sbot/` 拷进来（gitignored），没有时 `app.config.ts` 设 `extra.fcm = false`，推送模块完全不触发 ※。通知渠道四个：等我回（`wait`）、审批（`approval`）、任务（`task`）、知道就好（`fyi`）。点通知 → `sstudiobot://item/<ref>` 显示主上的状态，不用通知载荷；`personal` 通知只显示「有一条私人的」。App 设置里能关手机通知（关了发 `push-token` 空值，主改推渠道）。
- **配对**：扫码（expo-camera）、系统唤起 `sstudiobot://pair#…`、「粘贴配对码」三条路。
- 构建：本机 `expo prebuild` + Gradle，不用 EAS 云构建、不用 EAS Update；侧载（D10），手动发版（D11）。
- 安全区：Android 15 起强制 edge-to-edge，根布局用 `useSafeAreaInsets` 留顶部（第三方组件不认 Uniwind 的 `className`，`SafeAreaView` 写 `flex-1` 会塌成 0 高）；状态栏图标颜色跟应用主题走（P11）。
- 身体输入（拍体检报告、一句话记感受、Health Connect）在 09 的对应波次做；Health Connect 默认关。

## CI（`clients` job，01 的表）

改了 `clients/` 或 `protocol/` 时跑：

1. Node 24；`npm ci --ignore-scripts`（`clients/`，还有根目录的，e2e 要起真的中继和主）；`scripts/lock-check.ts` 比对 `zod`、`@noble/*` 和根 lockfile 一致。
2. `tsc --noEmit`（app、desktop 各一份 tsconfig）；`node --test`（store、连接状态机、markdown 白名单映射、链接判定、配对码、桌面密钥；e2e 经真的中继和主的 `RelayLink` 跑配对、bootstrap、流、断线补齐、4404、4410，W4 起还有派活到一个假节点、步骤和 diff、看一眼和多题问我卡、插话、换机器 409、清理、取消，主那边在 `scripts/clients-e2e-hub.ts` 子进程里，因为 `clients/` 不能 import `hub/`、`relay/`）。
3. `expo export -p web`；`scripts/bundle-report.ts` 记下产物大小（P11 基线：首屏 gzip 1204 KiB，全部 gzip 2.9 MiB；涨超过 20% 标红不拦 ※），产物里出现回环和 `.example` / `.invalid` / `.test` 以外的 `ws(s)://` 地址就不过；`leak-guard.sh --dir app/dist` 用同一套规则扫产物，只去掉邮箱那条（压缩后的代码里满是长得像邮箱的串）。
4. 装 Electron 二进制（`install.js`，按 electron 包自带的 `checksums.json` 校验），`xvfb-run` 跑 `--selftest`（上面）。Ubuntu 24.04 默认不许非特权 user namespace，CI 里用 sysctl 放开，不给 Electron 加 `--no-sandbox`。
5. 安卓 APK 不在 CI 出（要 `google-services.json`），在本机出。

`clients/` 合进 `main` 不重启主（01 部署，`sbot-deploy` 先改好才合）。
