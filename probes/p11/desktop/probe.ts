// 探针脚本：在 Electron 里依次跑 P3 / P4 / P11 的桌面检查，结果写 SBOT_PROBE_OUT（JSON）。
import { app, ipcMain, type BrowserWindow } from 'electron'
import { writeFileSync } from 'node:fs'
import { ed25519 } from '@noble/curves/ed25519.js'
import { ORIGIN, type Served } from './protocol.ts'
import type { DeviceKeys } from './keys.ts'

type State = { served: Served[]; external: { url: string; type: string }[]; unsafeInlineStyle: boolean; tMain: number }
type Ctx = { getKeys: () => DeviceKeys; backend: () => string; csp: () => string }

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

export async function runProbe(win: BrowserWindow, st: State, ctx: Ctx) {
  const steps = (process.env.SBOT_PROBE ?? '').split(',')
  const out: Record<string, unknown> = { steps, backend: ctx.backend(), electron: process.versions.electron, chrome: process.versions.chrome }
  const consoleMsgs: { level: number; msg: string; url: string }[] = []
  const reports: Record<string, unknown> = {}
  win.webContents.on('console-message', (e: unknown, level?: number, message?: string, _line?: number, sourceId?: string) => {
    // Electron 新版给的是事件对象
    const ev = e as { level?: string | number; message?: string; sourceId?: string }
    const msg = message ?? ev.message ?? ''
    if (msg.startsWith('PROBE ')) return
    consoleMsgs.push({ level: Number(level ?? (ev.level === 'error' ? 3 : ev.level === 'warning' ? 2 : 1)), msg: msg.slice(0, 400), url: (sourceId ?? ev.sourceId ?? '').slice(0, 120) })
  })
  ipcMain.on('probe.report', (_e, name: string, data: string) => { reports[name] = JSON.parse(data) })

  const js = <T>(code: string) => win.webContents.executeJavaScript(code, true) as Promise<T>
  const waitFor = async (code: string, ms = 15000) => {
    const t = Date.now()
    while (Date.now() - t < ms) { if (await js<boolean>(code).catch(() => false)) return Date.now() - t; await sleep(25) }
    return -1
  }
  const waitReport = async (name: string, ms = 60000) => { const t = Date.now(); while (!reports[name] && Date.now() - t < ms) await sleep(100); return reports[name] }
  const screenshot = async (file: string) => { if (!process.env.SBOT_SHOTS) return; const img = await win.webContents.capturePage(); writeFileSync(`${process.env.SBOT_SHOTS}/${file}.png`, img.toPNG()) }
  const center = (sel: string) => js<{ x: number; y: number } | null>(`(() => { const el = document.querySelector(${JSON.stringify(sel)}); el?.scrollIntoView({ block: 'center' }); const r = el?.getBoundingClientRect(); return r ? { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) } : null })()`)
  const click = async (sel: string) => {
    const c = await center(sel)
    if (!c) return false
    win.webContents.sendInputEvent({ type: 'mouseMove', x: c.x, y: c.y })
    win.webContents.sendInputEvent({ type: 'mouseDown', x: c.x, y: c.y, button: 'left', clickCount: 1 })
    win.webContents.sendInputEvent({ type: 'mouseUp', x: c.x, y: c.y, button: 'left', clickCount: 1 })
    return true
  }
  const screenReady = `!!document.querySelector('[data-testid="screen"],[data-testid="first-screen"]')`
  const cspErrors = () => consoleMsgs.filter(m => /Content Security Policy|Refused to/i.test(m.msg))

  // ── 冷启动：进程起来（T0 由外面给）到首屏元素出现
  if (steps.includes('cold')) {
    const t0 = Number(process.env.SBOT_T0 ?? st.tMain)
    await win.loadURL(ORIGIN + '/')
    await waitFor(`!!document.querySelector('[data-testid="first-screen"]')`, 20000)
    out.cold = { spawnToFirstScreenMs: Date.now() - t0, mainToFirstScreenMs: Date.now() - st.tMain }
  }

  // ── P3 路由直达和刷新
  if (steps.includes('routes')) {
    const routes = ['/', '/ban', '/du', '/can', '/jue', '/gai', '/self', '/self/devices', '/pair', '/item/demo-ref', '/item/v1.2', '/probe', '/probe/ui', '/probe/evil', '/probe/cjk', '/probe/code', '/probe/html', '/probe/keys']
    const res: Record<string, unknown>[] = []
    for (const r of routes) {
      const before = st.served.length
      await win.loadURL(ORIGIN + r)
      const direct = await waitFor(screenReady)
      const nf1 = await js<boolean>(`!!document.querySelector('[data-testid="not-found"]')`)
      win.webContents.reload()
      await sleep(300)
      const reload = await waitFor(screenReady)
      const nf2 = await js<boolean>(`!!document.querySelector('[data-testid="not-found"]')`)
      const path = await js<string>('location.pathname')
      const http404 = st.served.slice(before).filter(s => s.status === 404).map(s => s.url)
      res.push({ route: r, direct: direct >= 0 && !nf1, reload: reload >= 0 && !nf2, path, http404 })
    }
    // 路径逃逸：经 fetch 打几条恶意路径，必须都 404
    const escapes = await js<Record<string, number>>(`(async () => { const o = {}; for (const p of ['/../package.json', '/%2e%2e/package.json', '/%2e%2e%2fpackage.json', '/..%5cpackage.json', '/_expo/../../main.ts', '/%00index.html']) { try { o[p] = (await fetch(p)).status } catch (e) { o[p] = 'err' } } return o })()`)
    out.routes = { all: res.every(x => x.direct && x.reload), res, escapes }
  }

  // ── P3 CSP：跑完 routes 后看控制台
  if (steps.includes('csp')) {
    await win.loadURL(ORIGIN + '/probe/ui'); await waitFor(screenReady); await click('[data-testid="theme-dark"]'); await sleep(300); await click('[data-testid="popover-trigger"]'); await sleep(500)
    await win.loadURL(ORIGIN + '/probe/evil'); await waitFor(screenReady); await click('[data-testid="diff-file-0"]'); await sleep(2500)
    // 样式是否真的生效（去掉 unsafe-inline 后最先坏的就是这些）
    out.cspStyles = await js(`(() => {
      const el = document.querySelector('[data-testid="screen"]'); const cs = el && getComputedStyle(el);
      const diff = document.querySelector('[data-testid="pierre-diff"]');
      return { screenDisplay: cs?.display, screenFlex: cs?.flexDirection, bodyOverflow: getComputedStyle(document.body).overflow, rootHeight: document.getElementById('root')?.getBoundingClientRect().height,
        styleTags: [...document.querySelectorAll('style')].map(s => ({ id: s.id || null, rules: s.sheet ? s.sheet.cssRules.length : -1, len: (s.textContent || '').length })),
        diffHeight: diff?.getBoundingClientRect().height ?? null, diffShadow: !!diff?.querySelector('*')?.shadowRoot }
    })()`)
    await screenshot(`csp-inline-${st.unsafeInlineStyle ? 'on' : 'off'}`)
    out.csp = { header: ctx.csp(), unsafeInlineStyle: st.unsafeInlineStyle, errors: cspErrors().length, sample: cspErrors().slice(0, 12) }
  }

  // ── P11 ① 明暗、hover、弹出层
  if (steps.includes('ui')) {
    await win.loadURL(ORIGIN + '/probe/ui'); await waitFor(screenReady)
    const bg = () => js<Record<string, string>>(`Object.fromEntries([...document.querySelectorAll('[data-testid^="swatch-"]')].map(e => [e.dataset.testid, getComputedStyle(e).backgroundColor]).concat([['screen', getComputedStyle(document.querySelector('[data-testid="screen"]')).backgroundColor]]))`)
    await click('[data-testid="theme-light"]'); await sleep(300); const light = await bg(); await screenshot('ui-light')
    await click('[data-testid="theme-dark"]'); await sleep(300); const dark = await bg(); await screenshot('ui-dark')
    await click('[data-testid="theme-light"]'); await sleep(300)
    const hoverBg = () => js<string>(`getComputedStyle(document.querySelector('[data-testid="hover-target"]')).backgroundColor`)
    const hb0 = await hoverBg()
    const c = await center('[data-testid="hover-target"]')
    win.webContents.sendInputEvent({ type: 'mouseMove', x: c!.x, y: c!.y }); await sleep(300)
    const hb1 = await hoverBg(); await screenshot('ui-hover')
    win.webContents.sendInputEvent({ type: 'mouseMove', x: 5, y: 5 }); await sleep(200)
    await click('[data-testid="popover-trigger"]'); await sleep(600)
    const pos = await js<unknown>(`(() => { const t = document.querySelector('[data-testid="popover-trigger"]')?.getBoundingClientRect(); const c = document.querySelector('[data-testid="popover-content"]')?.getBoundingClientRect(); return t && c ? { trigger: { x: t.x, bottom: t.bottom }, content: { x: c.x, y: c.y, w: c.width, h: c.height } } : { trigger: !!t, content: !!c } })()`)
    await screenshot('ui-popover')
    await click('[data-testid="theme-dark"]'); await sleep(200)
    const posDark = await js<unknown>(`(() => { const c = document.querySelector('[data-testid="popover-content"]'); return c ? getComputedStyle(c).backgroundColor : null })()`)
    out.ui = { light, dark, themeChanged: light.screen !== dark.screen, hover: { before: hb0, after: hb1, changed: hb0 !== hb1 }, popover: pos, popoverBgDark: posDark }
  }

  // ── P11 ② 对话流
  if (steps.includes('chat')) {
    await win.loadURL(ORIGIN + '/?auto=1')
    out.chat = await waitReport('chat', 60000)
    // 跨消息选字：从一条消息的文字选到后面第二条
    out.chatSelect = await js(`(() => {
      const texts = [...document.querySelectorAll('[data-testid="first-screen"] div[dir="auto"]')].filter(e => (e.textContent || '').startsWith('#'));
      if (texts.length < 3) return { ok: false, n: texts.length };
      const a = texts[0], b = texts[2]; const r = document.createRange(); r.setStart(a.firstChild || a, 0); r.setEnd(b.firstChild || b, 1);
      const s = getSelection(); s.removeAllRanges(); s.addRange(r); const t = s.toString();
      return { ok: t.includes(a.textContent.slice(0, 6)) && t.length > a.textContent.length, len: t.length, userSelect: getComputedStyle(a).userSelect }
    })()`)
    await screenshot('chat')
  }

  // ── P11 ③ 恶意样本零外部请求
  if (steps.includes('evil')) {
    st.external.length = 0
    await win.loadURL(ORIGIN + '/probe/evil'); await waitFor(screenReady)
    await waitReport('evil-rendered', 10000)
    await click('[data-testid="diff-file-0"]'); await sleep(2500)
    // 把所有链接和图片占位都点一遍：只弹确认框，不放行的不出现「打开」
    const n = await js<number>(`document.querySelectorAll('[data-testid="screen"] [role="link"]').length`)
    let opened = 0
    for (let i = 0; i < n; i++) {
      await js(`document.querySelectorAll('[data-testid="screen"] [role="link"]')[${i}]?.click()`)
      await sleep(80)
      const canOpen = await js<boolean>(`!!document.querySelector('[data-testid="link-open"]')`)
      if (canOpen) opened++
      await js(`document.querySelector('[data-testid="link-cancel"]')?.click()`); await sleep(50)
    }
    await screenshot('evil')
    const diffOpen = await js<boolean>(`!!document.querySelector('[data-testid="pierre-diff"] *')`)
    const external = [...st.external]
    // 正对照：页面自己发一个外部请求，记录器必须看得到（.invalid 不会解析）
    await js(`fetch('https://control.invalid/x').catch(() => {}); true`); await sleep(300)
    const control = st.external.length > external.length
    out.evil = { csp: !!ctx.csp(), external, links: n, linksOfferedOpen: opened, diffOpen, recorderSeesControl: control, cspErrors: cspErrors().length }
  }

  // ── P11 ④ 中文：加粗、行高、组字中回车
  if (steps.includes('cjk')) {
    await win.loadURL(ORIGIN + '/probe/cjk'); await waitFor(screenReady)
    const bold = await js(`Object.fromEntries([...document.querySelectorAll('[data-testid^="bold-"]')].map(e => [e.dataset.testid, [...e.querySelectorAll('span,div')].filter(x => getComputedStyle(x).fontWeight === '700' && x.children.length === 0).map(x => x.textContent)]))`)
    const lh = await js(`[...document.querySelectorAll('[data-testid="lh-row"]')].map(r => { const t = r.firstElementChild; return { font: t.style.fontFamily, clientH: t.clientHeight, scrollH: t.scrollHeight, rowH: r.getBoundingClientRect().height } })`)
    await screenshot('cjk')
    // 输入法：CDP 模拟组字中按回车，再提交
    const dbg = win.webContents.debugger
    dbg.attach('1.3')
    await js(`window.__ev = []; for (const t of ['keydown', 'compositionstart', 'compositionend', 'input']) document.addEventListener(t, e => window.__ev.push({ t, key: e.key, keyCode: e.keyCode, isComposing: e.isComposing, data: e.data }), true); document.querySelector('[data-testid="ime-input"]').focus()`)
    await dbg.sendCommand('Input.imeSetComposition', { text: 'nihao', selectionStart: 5, selectionEnd: 5 })
    await dbg.sendCommand('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 229, nativeVirtualKeyCode: 229 })
    await dbg.sendCommand('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 229 })
    await sleep(100)
    const duringComposition = await js<string>(`document.querySelector('[data-testid="sent-count"]').textContent`)
    await dbg.sendCommand('Input.insertText', { text: '你好' })
    await sleep(100)
    await dbg.sendCommand('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 })
    await dbg.sendCommand('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 })
    await sleep(150)
    const afterCommit = await js<string>(`document.querySelector('[data-testid="sent-count"]').textContent`)
    dbg.detach()
    const events = await js(`window.__ev`)
    out.cjk = { bold, lh, ime: { duringComposition, afterCommit, events } }
  }

  // ── P11 ⑤ 网页上的耗时（Hermes 的在安卓上测）
  if (steps.includes('code')) {
    await win.loadURL(ORIGIN + '/probe/code')
    out.code = await waitReport('code', 20000)
  }

  // ── agent 的 HTML：写临时文件交给系统浏览器；localStorage 用同内核的隐藏窗口验
  if (steps.includes('html')) {
    await win.loadURL(ORIGIN + '/probe/html'); await waitFor(screenReady)
    await click('[data-testid="html-open"]')
    const r = (await waitReport('html-open', 10000)) as { result: string } | undefined
    const { BrowserWindow: BW } = await import('electron')
    const counts: string[] = []
    if (r?.result && !r.result.startsWith('error')) {
      for (let i = 0; i < 2; i++) {
        const w = new BW({ show: false, webPreferences: { partition: 'persist:htmlprobe' } })
        await w.loadFile(r.result)
        counts.push(await w.webContents.executeJavaScript(`document.getElementById('n').textContent`))
        w.destroy()
      }
    }
    out.html = { ...r, localStorageCounts: counts }
  }

  // ── P4 Electron：密钥、验签、后端
  if (steps.includes('keys')) {
    let r: Record<string, unknown>
    try {
      const k = ctx.getKeys()
      const pk = k.publicKey()
      const h = 'ab'.repeat(32), c = 'cd'.repeat(32)
      const sig = k.sign(h, c)
      const msg = Buffer.concat([Buffer.from('sbot-auth/1'), Buffer.from(h, 'hex'), Buffer.from(c, 'hex')])
      const ok = ed25519.verify(Buffer.from(sig, 'base64url'), msg, Buffer.from(pk, 'base64url'))
      r = { publicKey: pk, deviceId: k.deviceId().slice(0, 8), nobleVerifies: ok, appVersion: app.getVersion() }
    } catch (e) { r = { error: String((e as Error).message) } }
    await win.loadURL(ORIGIN + '/probe/keys')
    r.renderer = await waitReport('keys', 10000)
    // 渲染进程能看到的全局：只有 window.sbot 这几个函数
    r.bridgeKeys = await js(`JSON.stringify(Object.fromEntries(Object.entries(window.sbot).map(([k, v]) => [k, typeof v === 'function' ? 'fn' : Object.keys(v)])))`)
    // Metro 的网页包自己定义了全局 process（只有 env）和模块表；要查的是有没有 Node 能力漏进来
    r.nodeLeak = await js(`({ require: typeof require, processVersionsNode: typeof process !== 'undefined' ? (process.versions && process.versions.node) || null : null, processKeys: typeof process !== 'undefined' ? Object.keys(process).slice(0, 10) : null, electronInWindow: Object.keys(window).filter(k => /electron|ipc|node|require/i.test(k)) })`)
    r.requireFs = await js(`(() => { try { return typeof require === 'function' ? typeof require('fs') : 'no-require' } catch (e) { return 'throws: ' + String(e.message).slice(0, 80) } })()`)
    out.keys = r
  }

  // ── 配对：链接校验、存中继、重载后 CSP 带上中继；basic_text 时拒绝
  if (steps.includes('pair')) {
    await win.loadURL(ORIGIN + '/pair'); await waitFor(screenReady)
    const link = process.env.SBOT_PAIR_LINK ?? ''
    const res = await js(`window.sbot.pair.accept(${JSON.stringify(link)})`)
    await sleep(800)
    await waitFor(screenReady)
    const bad = await js(`window.sbot.pair.accept('sstudiobot://pair#v1.e30')`)
    out.pair = { res, bad, cspAfter: ctx.csp() }
  }

  out.console = { errors: consoleMsgs.filter(m => m.level >= 3).slice(0, 20), cspErrors: cspErrors().length }
  out.served404 = st.served.filter(s => s.status === 404).map(s => s.url).slice(0, 40)
  if (process.env.SBOT_PROBE_OUT) writeFileSync(process.env.SBOT_PROBE_OUT, JSON.stringify(out, null, 1))
  else console.log(JSON.stringify(out, null, 1))
  app.quit()
}
