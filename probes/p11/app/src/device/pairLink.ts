// 配对链接 sstudiobot://pair#v1.<base64url(JSON)>（06「配对」）。渲染进程和 Electron 主进程各验一遍。
export type PairInfo = { v: 1; hub_pk: string; relay: string; secret: string; role: 'client' | 'node'; exp: number }
export type PairParse = { ok: true; info: PairInfo } | { ok: false; error: string }

const B64URL = /^[A-Za-z0-9_-]+$/

function b64urlBytes(s: string): number {
  if (!B64URL.test(s)) return -1
  return Math.floor((s.length * 3) / 4)
}

function b64urlDecode(s: string): string {
  const b = s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4)
  const bin = atob(b)
  const bytes = Uint8Array.from(bin, c => c.charCodeAt(0))
  return new TextDecoder().decode(bytes)
}

export function parsePairLink(input: string, nowSec = Math.floor(Date.now() / 1000)): PairParse {
  const s = input.trim()
  const m = /^(?:sstudiobot:\/\/pair#)?v1\.([A-Za-z0-9_-]+)$/.exec(s)
  if (!m) return { ok: false, error: 'format' }
  let j: unknown
  try { j = JSON.parse(b64urlDecode(m[1]!)) } catch { return { ok: false, error: 'json' } }
  const o = j as Record<string, unknown>
  if (o.v !== 1) return { ok: false, error: 'version' }
  if (typeof o.hub_pk !== 'string' || b64urlBytes(o.hub_pk) !== 32) return { ok: false, error: 'hub_pk' }
  if (typeof o.secret !== 'string' || b64urlBytes(o.secret) !== 32) return { ok: false, error: 'secret' }
  if (o.role !== 'client' && o.role !== 'node') return { ok: false, error: 'role' }
  if (typeof o.exp !== 'number' || o.exp < nowSec) return { ok: false, error: 'expired' }
  if (typeof o.relay !== 'string') return { ok: false, error: 'relay' }
  let u: URL
  try { u = new URL(o.relay) } catch { return { ok: false, error: 'relay' } }
  // 中继只认 wss；主机名进 CSP 的 connect-src，所以不许带奇怪字符
  if (u.protocol !== 'wss:' || !/^[a-z0-9.-]+$/i.test(u.hostname) || u.username || u.password) return { ok: false, error: 'relay' }
  return { ok: true, info: { v: 1, hub_pk: o.hub_pk, relay: u.origin + u.pathname, secret: o.secret, role: o.role, exp: o.exp } }
}

export function makePairLink(info: PairInfo): string {
  const b = btoa(String.fromCharCode(...new TextEncoder().encode(JSON.stringify(info))))
  return 'sstudiobot://pair#v1.' + b.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}
