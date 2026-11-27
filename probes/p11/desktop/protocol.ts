// sbot-app://app/ ：只从包内 web/ 读（07 Electron「自定义协议」）。
import { readFile, realpath, stat } from 'node:fs/promises'
import path from 'node:path'

export const SCHEME = 'sbot-app'
export const HOST = 'app'
export const ORIGIN = `${SCHEME}://${HOST}`

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.map': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon', '.ttf': 'font/ttf', '.woff2': 'font/woff2', '.wasm': 'application/wasm', '.txt': 'text/plain; charset=utf-8',
}

export type CspOptions = { relayHost?: string | null; unsafeInlineStyle: boolean }

// CSP 由响应头给，不写在 HTML 里（T33）。relayHost 来自主进程存的配对信息，包里没有实例地址。
export function buildCsp(o: CspOptions): string {
  const connect = ["'self'"]
  if (o.relayHost) connect.push(`wss://${o.relayHost}`)
  return [
    "default-src 'self'",
    "script-src 'self'",
    `style-src 'self'${o.unsafeInlineStyle ? " 'unsafe-inline'" : ''}`,
    "img-src 'self' data:",
    "media-src 'none'",
    "object-src 'none'",
    "frame-src 'none'",
    `connect-src ${connect.join(' ')}`,
    "base-uri 'none'",
    "form-action 'none'",
  ].join('; ')
}

export type Served = { url: string; status: number; file?: string }

export function makeHandler(webRoot: string, csp: () => string, onServe?: (s: Served) => void) {
  const root = path.resolve(webRoot)
  let realRoot: string | null = null
  const notFound = (url: string, why: string) => {
    onServe?.({ url, status: 404, file: why })
    return new Response('not found', { status: 404, headers: { 'content-type': 'text/plain' } })
  }
  return async (req: Request): Promise<Response> => {
    realRoot ??= await realpath(root)
    let u: URL
    try { u = new URL(req.url) } catch { return notFound(req.url, 'url') }
    if (u.protocol !== `${SCHEME}:` || u.host !== HOST) return notFound(req.url, 'host')
    let p: string
    try { p = decodeURIComponent(u.pathname) } catch { return notFound(req.url, 'decode') }
    if (p.includes('\0')) return notFound(req.url, 'nul')
    // 解码后再 normalize：%2e%2e%2f、%5c 之类在这里变成真的 .. 和分隔符，再查是否还在 web/ 里
    const rel = path.normalize(p.replace(/\\/g, '/')).replace(/^[/\\]+/, '')
    let file = path.resolve(root, rel)
    if (file !== root && !file.startsWith(root + path.sep)) return notFound(req.url, 'escape')
    // 没有扩展名的是路由，回 index.html；带点的路由参数（/item/v1.2）找不到文件时，文档导航也回 index.html
    const isDoc = req.headers.get('sec-fetch-dest') === 'document' || (req.headers.get('accept') ?? '').includes('text/html')
    if (path.extname(file) === '' || file === root) file = path.join(root, 'index.html')
    let body: Buffer
    try {
      const st = await stat(file)
      if (!st.isFile()) throw new Error('dir')
      const real = await realpath(file)
      if (real !== realRoot && !real.startsWith(realRoot + path.sep)) return notFound(req.url, 'symlink-escape')
      body = await readFile(real)
    } catch {
      if (!isDoc) return notFound(req.url, 'missing')
      file = path.join(root, 'index.html')
      body = await readFile(file)
    }
    onServe?.({ url: req.url, status: 200, file: path.relative(root, file) })
    const ext = path.extname(file)
    const headers: Record<string, string> = {
      'content-type': MIME[ext] ?? 'application/octet-stream',
      'x-content-type-options': 'nosniff',
      'cache-control': 'no-cache',
    }
    if (ext === '.html') { const c = csp(); if (c) headers['content-security-policy'] = c }
    return new Response(new Uint8Array(body), { status: 200, headers })
  }
}
