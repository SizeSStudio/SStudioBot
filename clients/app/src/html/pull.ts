// Pure TS side of agent-generated HTML (D14, 07 「agent 做的 HTML」): parses `{ ref: "blob:<sha>", name, size }`
// refs and pulls blob chunks over a RequestFn before handing bytes to the platform opener (bridge.html.open on desktop).
// Kept free of RN / client singletons so node --test runs it directly.
import { BLOB_CHUNK, BlobRes } from '../../../../protocol/api/read.ts'

/** at most this much HTML is pulled (the hub's blobs are bigger only for diffs and logs) */
export const HTML_MAX = 20 * 1024 * 1024

export type HtmlRef = { sha: string; name: string; size: number }

/** `{ ref: "blob:<sha>", name, size }` where an item carries agent HTML (its body, or body.html) ※ */
export function htmlRefOf(body: unknown): HtmlRef | null {
  const b = body as Record<string, unknown> | null
  for (const c of [b, b?.html as Record<string, unknown> | undefined]) {
    if (!c || typeof c !== 'object') continue
    const m = typeof c.ref === 'string' ? /^blob:([0-9a-f]{64})$/.exec(c.ref) : null
    const name = typeof c.name === 'string' ? c.name : ''
    if (m && /\.html?$/i.test(name)) return { sha: m[1]!, name: name.slice(0, 200), size: typeof c.size === 'number' ? c.size : 0 }
  }
  return null
}

function fromB64(s: string): Uint8Array {
  const bin = atob(s)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

export type PullHtmlDeps = {
  request: (method: 'GET', path: string, opts?: { query?: Record<string, string> }) => Promise<{ status: number; body?: unknown }>
  open: ((sha: string, bytes: Uint8Array) => Promise<boolean>) | undefined
  maxBytes?: number
  chunkBytes?: number
}

export type BlobDeps = Pick<PullHtmlDeps, 'request' | 'chunkBytes'>

/**
 * Pull a whole blob in order (02 「大载荷」), at most `max` bytes. The bytes are untrusted (what they are is up to the
 * caller); a short or out-of-order answer stops it.
 */
export async function pullBlob(sha: string, max: number, deps: BlobDeps): Promise<{ ok: true; bytes: Uint8Array } | { ok: false; error: string }> {
  if (!/^[0-9a-f]{64}$/.test(sha)) return { ok: false, error: '不是一个 blob' }
  const chunk = deps.chunkBytes ?? BLOB_CHUNK
  const parts: Uint8Array[] = []
  let offset: number | null = 0, total = 0
  while (offset !== null) {
    const r = await deps.request('GET', `/api/v1/blobs/${sha}`, { query: { offset: String(offset), len: String(chunk) } })
    if (r.status !== 200) return { ok: false, error: `主没给（${r.status}）` }
    const b = BlobRes.parse(r.body)
    if (b.total > max) return { ok: false, error: '太大了' }
    const bytes = fromB64(b.data_b64)
    parts.push(bytes); total += bytes.length
    if (total > max) return { ok: false, error: '太大了' }
    if (b.next_offset !== null && b.next_offset <= offset) return { ok: false, error: '分片偏移不对' }
    offset = b.next_offset
  }
  const all = new Uint8Array(total)
  let i = 0
  for (const p of parts) { all.set(p, i); i += p.length }
  return { ok: true, bytes: all }
}

export async function pullAndOpenHtml(h: HtmlRef, deps: PullHtmlDeps): Promise<{ ok: true } | { ok: false; error: string }> {
  if (!deps.open) return { ok: false, error: '这台还不能打开（安卓随安卓构建接上）；在桌面上打开' }
  const max = deps.maxBytes ?? HTML_MAX
  if (h.size < 0 || h.size > max) return { ok: false, error: '太大了' }
  const got = await pullBlob(h.sha, max, deps)
  if (!got.ok) return { ok: false, error: got.error === '分片偏移不对' ? '分片偏移不对，没打开' : got.error }
  if (got.bytes.length === 0) return { ok: false, error: '内容是空的，没打开' }
  const ok = await deps.open(h.sha, got.bytes)
  return ok ? { ok: true } : { ok: false, error: '校验没过或系统没打开' }
}
