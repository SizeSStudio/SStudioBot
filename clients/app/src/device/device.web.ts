// Electron's renderer: the key and the pairing file live in main; this only calls the bridge (07). In a plain browser
// (expo start --web, for layout work) there is no bridge and no pairing.
import { bridge } from '../bridge.ts'
import type { DeviceApi } from './types.ts'

const nav = typeof navigator !== 'undefined' ? navigator.userAgent : ''
const platform = /Mac/.test(nav) ? 'macos' : /Win/.test(nav) ? 'windows' : /Linux/.test(nav) ? 'linux' : 'web'
const none = () => Promise.reject(new Error('没有桌面 bridge：只有桌面 App 和安卓能配对'))

export const device: DeviceApi = {
  platform,
  canPair: !!bridge,
  publicKey: () => (bridge ? bridge.device.publicKey() : none()),
  sign: (h, c, purpose) => (bridge ? bridge.device.sign(h, c, purpose) : none()),
  keyInfo: async () => (bridge ? '主进程，safeStorage（系统钥匙串）' : '无（浏览器里不存密钥）'),
  pairing: async () => (bridge ? bridge.pair.current() : null),
  async beginPair(text) {
    if (!bridge) return { ok: false, error: '浏览器里不能配对：用桌面 App 或安卓' }
    const r = await bridge.pair.accept(text)
    return r.ok ? { ok: true, reloading: true } : r
  },
  pendingPair: async () => (bridge ? bridge.pair.pending() : null),
  savePairing: async (p) => { await bridge?.pair.save(p) },
  forget: async () => { await bridge?.pair.forget() },
  onLink(cb) {
    let on = true
    bridge?.pair.onLink((l) => { if (on) cb(l) })
    return () => { on = false }
  },
}
