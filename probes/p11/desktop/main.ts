// Electron 主进程：自定义协议 + CSP 响应头 + 窄 bridge + 设备密钥（07 Electron）。
// 探针模式：SBOT_PROBE=<步骤>，见 probe.ts。
import { app, BrowserWindow, ipcMain, Notification, protocol, safeStorage, session, shell } from 'electron'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildCsp, makeHandler, ORIGIN, SCHEME, type Served } from './protocol.ts'
import { backendOf, canHoldKeys, DeviceKeys } from './keys.ts'
import { parsePairLink } from '../app/src/device/pairLink.ts'
import { classifyLink } from '../app/src/render/links.ts'

const here = path.dirname(fileURLToPath(import.meta.url))
const WEB = process.env.SBOT_WEB_DIR ?? path.join(here, 'web')
const T_MAIN = Date.now()

protocol.registerSchemesAsPrivileged([{ scheme: SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true } }])
if (process.env.SBOT_USER_DATA) app.setPath('userData', process.env.SBOT_USER_DATA)

// 探针：强制后端（模拟 Linux 无钥匙环时的 basic_text）
const backend = () => process.env.SBOT_FAKE_BACKEND ?? backendOf(safeStorage, process.platform)
let keys: DeviceKeys | null = null
const getKeys = () => (keys ??= new DeviceKeys(path.join(app.getPath('userData'), 'device.key'), safeStorage, backend()))

type Pairing = { hub_pk: string; relay: string; role: string }
const pairingFile = () => path.join(app.getPath('userData'), 'pairing.json')
const readPairing = (): Pairing | null => { try { return JSON.parse(readFileSync(pairingFile(), 'utf8')) as Pairing } catch { return null } }

export const state = {
  served: [] as Served[],
  external: [] as { url: string; type: string }[],
  unsafeInlineStyle: process.env.SBOT_CSP_INLINE_STYLE !== '0',
  win: null as BrowserWindow | null,
  tMain: T_MAIN,
}

// 探针：SBOT_NO_CSP=1 去掉 CSP，单测渲染器本身会不会发请求（P11 ③）
const csp = () => process.env.SBOT_NO_CSP === '1' ? '' : buildCsp({ relayHost: readPairing() ? new URL(readPairing()!.relay).hostname : null, unsafeInlineStyle: state.unsafeInlineStyle })

function cleanHtmlTemp() {
  const dir = path.join(os.tmpdir(), 'sbot-html')
  if (!existsSync(dir)) return
  for (const f of readdirSync(dir)) {
    const p = path.join(dir, f)
    if (Date.now() - statSync(p).mtimeMs > 24 * 3600 * 1000) rmSync(p, { force: true })
  }
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1100, height: 800, show: true, backgroundColor: '#ffffff',
    webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false, webSecurity: true, preload: path.join(here, 'preload.cjs') },
  })
  win.webContents.on('will-navigate', (e, url) => { if (!url.startsWith(ORIGIN + '/')) e.preventDefault() })
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  state.win = win
  return win
}

function handleDeepLink(url: string) {
  if (!url.startsWith('sstudiobot://')) return
  state.win?.webContents.send('pair.link', url)
}

app.on('open-url', (e, url) => { e.preventDefault(); handleDeepLink(url) })
if (!process.env.SBOT_PROBE && !app.requestSingleInstanceLock()) app.quit()
app.on('second-instance', (_e, argv) => { const u = argv.find(a => a.startsWith('sstudiobot://')); if (u) handleDeepLink(u) })

app.whenReady().then(async () => {
  cleanHtmlTemp()
  const ses = session.defaultSession
  ses.setPermissionRequestHandler((_wc, _perm, cb) => cb(false))
  ses.setPermissionCheckHandler(() => false)
  // 记下所有不是包内的请求（P11 ③）
  ses.webRequest.onBeforeRequest((d, cb) => {
    if (!d.url.startsWith(ORIGIN + '/') && !d.url.startsWith('devtools:')) state.external.push({ url: d.url.slice(0, 200), type: d.resourceType })
    cb({})
  })
  protocol.handle(SCHEME, makeHandler(WEB, csp, s => state.served.push(s)))
  if (process.env.SBOT_REGISTER_SCHEME === '1') app.setAsDefaultProtocolClient('sstudiobot')

  ipcMain.handle('device.backend', () => backend())
  ipcMain.handle('device.publicKey', () => getKeys().publicKey())
  ipcMain.handle('device.sign', (_e, h: string, c: string) => {
    if (!/^[0-9a-f]{64}$/i.test(h) || !/^[0-9a-f]{64}$/i.test(c)) throw new Error('bad input')
    return getKeys().sign(h, c)
  })
  ipcMain.handle('pair.accept', (_e, link: string) => {
    const b = backend()
    if (!canHoldKeys(b)) return { ok: false, error: `safeStorage 后端是 ${b}：设备私钥会以明文落盘，拒绝配对。装好钥匙环（gnome-keyring / kwallet）后再试。` }
    const p = parsePairLink(link)
    if (!p.ok) return { ok: false, error: p.error }
    getKeys().ensure()
    writeFileSync(pairingFile(), JSON.stringify({ hub_pk: p.info.hub_pk, relay: p.info.relay, role: p.info.role }), { mode: 0o600 })
    // 重载让 CSP 的 connect-src 带上中继
    setTimeout(() => state.win?.webContents.reload(), 50)
    return { ok: true, deviceId: getKeys().deviceId().slice(0, 8) }
  })
  ipcMain.handle('link.open', async (_e, url: string) => {
    const v = classifyLink(url)
    if (!v.ok) return false
    if (process.env.SBOT_PROBE) { state.external.push({ url: 'shell.openExternal:' + v.url.slice(0, 80), type: 'shell' }); return true }
    await shell.openExternal(v.url)
    return true
  })
  ipcMain.handle('html.open', async (_e, sha: string, html: string) => {
    if (!/^[A-Za-z0-9_-]{1,80}$/.test(sha)) throw new Error('bad sha')
    const dir = path.join(os.tmpdir(), 'sbot-html')
    mkdirSync(dir, { recursive: true })
    const file = path.join(dir, `${sha}.html`)
    writeFileSync(file, html) // 正式版从 blob 拉，这里由页面给样本
    if (process.env.SBOT_OPEN_BROWSER !== '0') { const err = await shell.openPath(file); if (err) return 'error: ' + err }
    return file
  })
  ipcMain.on('notify', (_e, title: string, body: string) => {
    if (state.win?.isFocused()) return
    new Notification({ title, body }).show()
  })

  const win = createWindow()
  if (process.env.SBOT_PROBE) {
    const { runProbe } = await import('./probe.ts')
    await runProbe(win, state, { getKeys, backend, csp })
  } else {
    await win.loadURL(ORIGIN + '/')
  }
})

app.on('window-all-closed', () => app.quit())
