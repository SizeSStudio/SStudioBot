// Electron main (07 Electron): the sbot-app:// protocol with CSP as a response header, a hardened window, a narrow
// bridge, the device key (keys.ts) and the pairing file. The renderer runs the connection itself (Noise, frames);
// main only holds the key, signs, and decides which relay the CSP lets it reach.
//
//   --selftest  load /selftest (the P11 ③ evil samples) on a throwaway profile, count every request that isn't
//               sbot-app:// and every CSP violation, exit 0 only if both are zero (the CI `clients` job runs this).
import { app, BrowserWindow, ipcMain, protocol, safeStorage, session, shell, type WebContents } from 'electron'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { PAIR_LINK_PREFIX, type PairCode } from '../../protocol/pair.ts'
import { PAIR_ERROR_TEXT, readPairCode } from '../app/src/conn/pairCode.ts'
import { classifyLink } from '../app/src/render/links.ts'
import { cleanupHtmlCache, HTML_DIR_NAME, openHtmlFile } from './html.ts'
import { backendOf, BackendRefused, canHoldKeys, DeviceKeys } from './keys.ts'
import { buildCsp, makeHandler, ORIGIN, SCHEME } from './protocol.ts'

const here = path.dirname(fileURLToPath(import.meta.url))
const WEB = path.join(here, 'web')
const SELFTEST = process.argv.includes('--selftest')

protocol.registerSchemesAsPrivileged([{ scheme: SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true } }])
if (SELFTEST) app.setPath('userData', mkdtempSync(path.join(os.tmpdir(), 'sbot-selftest-')))

// ── pairing ───────────────────────────────────────────────────────────────────────────────────────────────────
// What stays on disk: hub key, relay, device id, role (07: no secrets). The code's secret is single-use and only kept
// in memory until the hub took it.
type Pairing = { hub_pk: string; relay: string; device_id: string; role: 'client' | 'node' }
const pairingFile = () => path.join(app.getPath('userData'), 'pairing.json')
function readPairing(): Pairing | null {
  try {
    const p = JSON.parse(readFileSync(pairingFile(), 'utf8')) as Pairing
    return typeof p.hub_pk === 'string' && typeof p.relay === 'string' && typeof p.device_id === 'string' ? p : null
  } catch { return null }
}
let pending: PairCode | null = null
let incomingLink: string | null = null

// connect-src gets exactly the relay of the pairing (or of the code being paired); the bundle holds no address
const relayHost = (): string | null => {
  const r = pending?.relay ?? readPairing()?.relay
  return r ? new URL(r).host : null
}
const csp = () => buildCsp({ relayHost: relayHost(), unsafeInlineStyle: true })

let keys: DeviceKeys | null = null
let backend = 'unknown'
const getKeys = () => (keys ??= new DeviceKeys(path.join(app.getPath('userData'), 'device.key'), safeStorage, backend))

// ── window ────────────────────────────────────────────────────────────────────────────────────────────────────
let win: BrowserWindow | null = null
function createWindow(): BrowserWindow {
  const w = new BrowserWindow({
    width: 1100, height: 800, show: !SELFTEST,
    webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false, webSecurity: true, preload: path.join(here, 'preload.cjs') },
  })
  w.webContents.on('will-navigate', (e) => e.preventDefault()) // in-app routes are history API, never a navigation
  w.webContents.setWindowOpenHandler(() => ({ action: 'deny' })) // links go through bridge.link.open
  w.webContents.on('will-attach-webview', (e) => e.preventDefault())
  win = w
  return w
}

/** Only calls from our own page count (a frame or a navigation elsewhere can't use the bridge). */
const fromApp = (sender: WebContents, frameUrl: string | undefined) => sender === win?.webContents && (frameUrl ?? '').startsWith(ORIGIN + '/')

function onDeepLink(url: string | undefined) {
  if (!url?.startsWith(PAIR_LINK_PREFIX)) return
  incomingLink = url
  win?.webContents.send('pair.link')
  if (win) { if (win.isMinimized()) win.restore(); win.focus() }
}

if (!SELFTEST && !app.requestSingleInstanceLock()) app.quit()
app.on('open-url', (e, url) => { e.preventDefault(); onDeepLink(url) }) // macOS
app.on('second-instance', (_e, argv) => onDeepLink(argv.find((a) => a.startsWith(PAIR_LINK_PREFIX)))) // Windows, Linux
onDeepLink(process.argv.find((a) => a.startsWith(PAIR_LINK_PREFIX)))

app.on('web-contents-created', (_e, wc) => {
  wc.on('will-navigate', (e) => e.preventDefault())
  wc.setWindowOpenHandler(() => ({ action: 'deny' }))
})

// ── the bridge's other end ────────────────────────────────────────────────────────────────────────────────────
function handle<A extends unknown[], R>(channel: string, fn: (...args: A) => R | Promise<R>) {
  ipcMain.handle(channel, (e, ...args) => {
    if (!fromApp(e.sender, e.senderFrame?.url)) throw new Error('not from the app')
    return fn(...(args as A))
  })
}

function registerBridge() {
  handle('device.publicKey', () => getKeys().publicKey())
  handle('device.sign', (h: unknown, c: unknown, purpose: unknown) => getKeys().sign(String(h), String(c), purpose as 'auth'))

  handle('pair.accept', async (link: unknown) => {
    if (!canHoldKeys(backend)) return { ok: false, error: new BackendRefused(backend).message }
    if (readPairing()) return { ok: false, error: '这台已经配对了：要换一个主，先在设备页「解除配对」' }
    const p = readPairCode(String(link))
    if (!p.ok) return { ok: false, error: PAIR_ERROR_TEXT[p.error] }
    await getKeys().renew() // every pairing gets a fresh key (06)
    pending = p.code
    incomingLink = null
    setTimeout(() => win?.webContents.reload(), 50) // so the CSP's connect-src has this relay
    return { ok: true }
  })
  handle('pair.pending', () => {
    if (pending && pending.exp <= Date.now()) pending = null
    return pending
  })
  handle('pair.cancel', () => { pending = null })
  handle('pair.save', async (raw: unknown) => {
    const p = raw as Pairing
    // only the pairing of the code being paired, with this device's own id
    if (!pending || p?.hub_pk !== pending.hub_pk || p.relay !== pending.relay || p.role !== pending.role) throw new Error('no such pairing')
    if (p.device_id !== (await getKeys().deviceId())) throw new Error('not this device')
    const out: Pairing = { hub_pk: p.hub_pk, relay: p.relay, device_id: p.device_id, role: p.role }
    await writeFile(pairingFile(), JSON.stringify(out), { mode: 0o600 })
    pending = null
  })
  handle('pair.current', () => readPairing())
  handle('pair.forget', async () => {
    rmSync(pairingFile(), { force: true })
    pending = null
    await getKeys().forget()
    setTimeout(() => win?.webContents.reload(), 50)
  })
  handle('pair.takeLink', () => { const l = incomingLink; incomingLink = null; return l })

  handle('link.open', async (url: unknown) => {
    const v = classifyLink(String(url)) // the renderer checked already; check again here, where it counts
    if (!v.ok) return false
    if (SELFTEST) return true
    await shell.openExternal(v.url)
    return true
  })

  // agent HTML (D14): never rendered inside the app; verified against sha and handed to the system browser
  const htmlDir = () => path.join(SELFTEST ? app.getPath('userData') : app.getPath('temp'), HTML_DIR_NAME)
  handle('html.open', (sha: unknown, bytes: unknown) =>
    openHtmlFile(sha, bytes, { dir: htmlDir(), openPath: SELFTEST ? async () => '' : (file) => shell.openPath(file) }),
  )
}

// ── start ─────────────────────────────────────────────────────────────────────────────────────────────────────
app.whenReady().then(async () => {
  backend = await backendOf(safeStorage, process.platform)
  if (!SELFTEST) void cleanupHtmlCache(path.join(app.getPath('temp'), HTML_DIR_NAME))
  const ses = session.defaultSession
  ses.setPermissionRequestHandler((_wc, _perm, cb) => cb(false)) // no camera, mic, notifications prompts, geolocation …
  ses.setPermissionCheckHandler(() => false)
  const external: string[] = []
  ses.webRequest.onBeforeRequest((d, cb) => {
    const own = d.url.startsWith(ORIGIN + '/') || d.url.startsWith('devtools:')
    if (!own) external.push(`${d.resourceType} ${d.url.slice(0, 120)}`)
    // a connection only to the paired relay; everything else is dropped here as well as by the CSP
    const relay = relayHost()
    cb({ cancel: !own && !(relay && d.resourceType === 'webSocket' && new URL(d.url).host === relay) })
  })
  protocol.handle(SCHEME, makeHandler(WEB, csp))
  registerBridge()
  if (!SELFTEST && !app.isDefaultProtocolClient('sstudiobot')) app.setAsDefaultProtocolClient('sstudiobot')

  const w = createWindow()
  if (!SELFTEST) { await w.loadURL(ORIGIN + '/'); return }

  const cspErrors: string[] = []
  w.webContents.on('console-message', (e) => { if (/Content Security Policy|Refused to/i.test(e.message)) cspErrors.push(e.message.slice(0, 200)) })
  let code = 1
  try {
    await w.loadURL(ORIGIN + '/selftest')
    const t0 = Date.now()
    let done = false
    while (!done && Date.now() - t0 < 20_000) {
      done = await w.webContents.executeJavaScript(`!!document.querySelector('[data-testid="selftest-done"]')`)
      if (!done) await new Promise((r) => setTimeout(r, 200))
    }
    await new Promise((r) => setTimeout(r, 1000)) // late requests (fonts, lazy images) would show up now
    const rendered = done ? await w.webContents.executeJavaScript(`document.querySelectorAll('[data-testid="selftest-sample"]').length`) : 0
    const clean = external.length === 0 && cspErrors.length === 0
    const report = { selftest: done ? 'rendered' : 'timeout', samples: rendered, backend, external: [...external], cspErrors: [...cspErrors] }
    // canary: a remote fetch from the page must be refused by the CSP and seen here, or the counts above prove nothing
    await w.webContents.executeJavaScript(`fetch('https://canary.invalid/x').catch(() => 0)`)
    await new Promise((r) => setTimeout(r, 500))
    const canary = cspErrors.length > report.cspErrors.length && external.length === report.external.length
    console.log(JSON.stringify({ ...report, canary: canary ? 'refused and seen' : 'NOT SEEN' }))
    code = done && rendered > 0 && clean && canary ? 0 : 1
  } catch (e) {
    console.error('selftest:', e instanceof Error ? e.message : String(e))
  }
  rmSync(app.getPath('userData'), { recursive: true, force: true })
  app.exit(code)
})

app.on('window-all-closed', () => app.quit())
