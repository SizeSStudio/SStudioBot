// Reading a pairing code on the device (06 「配对」): protocol/pair.ts decodes it; the device is stricter about the relay,
// because on the desktop it becomes the CSP's connect-src and on every platform it's where the key gets used.
// wss only; ws:// only to loopback (same-host relay, tests, smoke, 06 ※); no userinfo, query or fragment.
import { decodePairCode, type PairCode } from '../../../../protocol/pair.ts'

export type PairCodeError = 'format' | 'relay' | 'expired'
export type ReadPairCode = { ok: true; code: PairCode } | { ok: false; error: PairCodeError }

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]'])
const HOST = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$|^\[[0-9a-f:]+\]$|^\d{1,3}(?:\.\d{1,3}){3}$/i

/** The relay's peer endpoint, normalized (no trailing slash), or null when a device shouldn't connect to it. */
export function cleanRelay(relay: string): string | null {
  let u: URL
  try { u = new URL(relay) } catch { return null }
  if (u.protocol !== 'wss:' && !(u.protocol === 'ws:' && LOOPBACK.has(u.hostname))) return null
  if (u.username || u.password || u.search || u.hash || relay.includes('#') || relay.includes('?')) return null
  if (!HOST.test(u.hostname)) return null
  return `${u.protocol}//${u.host}${u.pathname.replace(/\/+$/, '')}`
}

export function readPairCode(text: string, now = Date.now()): ReadPairCode {
  let code: PairCode
  try { code = decodePairCode(text) } catch { return { ok: false, error: 'format' } }
  const relay = cleanRelay(code.relay)
  if (!relay) return { ok: false, error: 'relay' }
  // the hub's clock decides (06); this only saves a round trip with a code that is plainly old
  if (code.exp <= now) return { ok: false, error: 'expired' }
  return { ok: true, code: { ...code, relay } }
}

/** `<relay peer endpoint>?hub=<hub_pk>` (06 「端点」). */
export const peerUrl = (relay: string, hubPk: string): string => `${relay}?hub=${hubPk}`

export const PAIR_ERROR_TEXT: Record<PairCodeError, string> = {
  format: '这不是配对码：要整段 sstudiobot://pair#v1… 或 v1. 开头的码',
  relay: '配对码里的中继地址不能用（只认 wss://；ws:// 只认本机）',
  expired: '配对码过期了（10 分钟有效），重新拿一个',
}
