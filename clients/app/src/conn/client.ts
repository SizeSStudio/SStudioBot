// The app's one connection and one store (07 「连接」「store」), wired to this platform's socket, key and pairing.
// Screens read the store through hooks and the connection state through useConn().
import { useSyncExternalStore } from 'react'
import { device } from '../device/device'
import { Store } from '../store/store.ts'
import { setupCrypto } from './crypto'
import { Connection, type ConnState, type Pairing } from './machine.ts'

export const cryptoBackend = setupCrypto()
export const store = new Store()

let paired: Pairing | null = null
const pairedSubs = new Set<() => void>()
const setPaired = (p: Pairing | null) => { paired = p; for (const f of pairedSubs) f() }

export const conn = new Connection({
  openSocket: (url) => new WebSocket(url) as never,
  signer: device,
  store,
  onPaired: async (p) => { await device.savePairing(p); setPaired(p) },
})

let booted: Promise<void> | null = null
/** On launch: a stored pairing connects; on the desktop a code main is holding (after the CSP reload) pairs. */
export function boot(): Promise<void> {
  booted ??= (async () => {
    const p = await device.pairing().catch(() => null)
    if (p) { setPaired(p); conn.start({ pairing: p }); return }
    const code = await device.pendingPair().catch(() => null)
    if (code) conn.start({ pair: { code, name: pendingName() ?? defaultName(), platform: device.platform } })
  })()
  return booted
}

/** Pair with a pasted / scanned / opened code. On the desktop the page reloads and boot() carries on. */
export async function pair(text: string, name: string): Promise<{ ok: true } | { ok: false; error: string }> {
  keepName(name)
  const r = await device.beginPair(text)
  if (!r.ok) return r
  if ('code' in r) conn.start({ pair: { code: r.code, name: name.trim() || defaultName(), platform: device.platform } })
  return { ok: true }
}

/** Unpair here (the hub still lists this device until it is removed there; 07 设备页). */
export async function unpair(): Promise<void> {
  conn.stop()
  store.reset()
  await device.forget()
  setPaired(null)
}

// the desktop reloads between taking the code and pairing; the name I typed waits in sessionStorage (not a secret)
const NAME_KEY = 'sbot.pair-name'
const ss = () => (typeof sessionStorage !== 'undefined' ? sessionStorage : null)
function keepName(n: string) { try { ss()?.setItem(NAME_KEY, n.trim()) } catch { /* only a convenience */ } }
function pendingName(): string | null { try { const n = ss()?.getItem(NAME_KEY); ss()?.removeItem(NAME_KEY); return n || null } catch { return null } }

export const defaultName = () => ({ android: '安卓手机', macos: 'Mac 桌面', windows: 'Windows 桌面', linux: 'Linux 桌面' } as Record<string, string>)[device.platform] ?? '这台设备'

export function useConn(): ConnState {
  return useSyncExternalStore((f) => conn.subscribe(f), () => conn.state, () => conn.state)
}

export function usePairing(): Pairing | null {
  return useSyncExternalStore((f) => { pairedSubs.add(f); return () => { pairedSubs.delete(f) } }, () => paired, () => paired)
}
