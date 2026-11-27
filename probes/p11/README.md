# P11 客户端 spike（含 P3、P4 的 Electron 部分）

一次性代码，不合进 `main`；W2 照这里搭 `clients/`。门槛和结果在 `docs/tech/08-probes.md`。

## 目录

```
app/       Expo 58 + expo-router（RN Web 0.21.4、Uniwind 1.14 + Tailwind 4）
  app/       路由：(tabs)/ 六个 tab、self/、pair、item/[ref]、probe/（各项检查页）
  src/render md.ts（markdown-it → 白名单节点树）、links.ts（链接判定）、ime.ts、code.ts、diff.ts、Markdown/CodeBlock/DiffView
  src/probe  evil.ts（07 的恶意样本集）、report.ts（结果打到 bridge / logcat）
  src/device pairLink.ts、device.web.ts（转调 bridge）、device.native.ts（Keystore 模块待写）
  public/index.html  不带内联 <style> 的模板（RN Web 的根重置挪进 global.css）
  test/      node --test：恶意样本、链接、流式半截链接、加粗、软换行、输入法、配对链接
desktop/   Electron 45
  main.ts      窗口、权限全拒、webRequest 记外部请求、IPC
  protocol.ts  sbot-app://app/：防路径逃逸、无扩展名回 index.html、CSP 响应头
  keys.ts      Ed25519（node:crypto）+ safeStorage；basic_text 拒绝
  preload.cjs  窄 bridge
  probe.ts     自动跑各项检查，写 JSON
  test/        protocol、keys 单测
```

## 准备

Node 24（Expo 58 拒奇数版本）。依赖不跑 install 脚本，Electron 二进制显式装（`install.js` 按 `checksums.json` 校验）：

```sh
npm ci --ignore-scripts
node node_modules/electron/install.js
npm test                                   # 单测
cd app && npx expo export -p web --output-dir dist && rm -rf ../desktop/web && cp -R dist ../desktop/web
```

## 桌面检查（`desktop/` 下）

每次用一个临时 `userData`，结果写 `SBOT_PROBE_OUT`，截图写 `SBOT_SHOTS`：

```sh
run() { env SBOT_USER_DATA=/tmp/p11-ud SBOT_PROBE_OUT=/tmp/p11.json "$@" ../node_modules/.bin/electron .; }
run SBOT_PROBE=routes,csp            # P3：18 条路由直达和刷新、路径逃逸、CSP 报错
run SBOT_PROBE=ui,csp SBOT_CSP_INLINE_STYLE=0   # P3：去掉 style-src 'unsafe-inline' 看坏在哪
run SBOT_PROBE=cold SBOT_T0=<毫秒时间戳>       # P3：冷启动（外面用 perl Time::HiRes 给 T0）
run SBOT_PROBE=ui                    # ① 明暗、hover、弹出层位置
run SBOT_PROBE=chat                  # ② 500 条 + 50 段/秒 2000 字；贴底、上翻不拽回、跨消息选字
run SBOT_PROBE=evil                  # ③ 恶意样本，webRequest 记外部请求；加 SBOT_NO_CSP=1 只看渲染器
run SBOT_PROBE=cjk                   # ④ 加粗、行高、CDP 模拟组字中回车
run SBOT_PROBE=code                  # ⑤ 网页上的高亮和 diff 列表耗时
run SBOT_PROBE=html                  # agent 的 HTML：写临时文件 + localStorage
run SBOT_PROBE=keys,pair SBOT_PAIR_LINK=<链接>        # P4：钥匙串、验签、配对后 CSP 带中继
run SBOT_PROBE=keys,pair SBOT_FAKE_BACKEND=basic_text # P4：拒绝
```

P4「升级后还在」：同一个 `userData`，把 `desktop/package.json` 的 `version` 改一下再跑 `keys`，公钥不变。

## 安卓（模拟器或手机，release / Hermes）

```sh
cd app && npx expo prebuild -p android --no-install
cd android && ./gradlew assembleRelease -PreactNativeArchitectures=arm64-v8a
adb install -r app/build/outputs/apk/release/app-release.apk
adb logcat -s ReactNativeJS | grep PROBE &
adb shell am start -a android.intent.action.VIEW -d 'sstudiobot://probe/code'    # ⑤
adb shell am start -a android.intent.action.VIEW -d 'sstudiobot://?auto=1'       # ②
adb shell am start -a android.intent.action.VIEW -d 'sstudiobot://probe/evil'    # ③（模拟器开 -tcpdump 抓包）
# 代码块渲染法对照：URL 里有 &，要整条用引号交给设备上的 shell
adb shell "am start -a android.intent.action.VIEW -d 'sstudiobot://probe/code?mode=one&font=css'"   # mode=one|lines，code=0 不放代码块
```

- 代码块在安卓上必须每行一个 `Text`：整块一个 `Text`（几千个 span）把 UI 线程卡 22 秒以上。
- 安卓 15 强制 edge-to-edge：根布局用 `useSafeAreaInsets` 留顶部；`SafeAreaView` 是第三方组件，不认 `className`。
- 模拟器的 `-tcpdump` 在运行中不落盘，正对照（`ping` 一个域名）没抓到；安卓 15 默认私有 DNS 走 853。抓包要换真机或 mitm 代理。

## 手工检查（自动化做不了的）

- 输入法：Gboard、搜狗（安卓）、macOS 拼音（桌面）在 `/probe/cjk` 的输入框里组字时按回车，「已发送」不变；上屏后回车才加一。
- 扫码配对、FCM、切后台续连、Health Connect：真机。
