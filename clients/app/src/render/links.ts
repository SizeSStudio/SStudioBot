// 链接判定：渲染器和桌面主进程各查一遍（07「不可信内容」）。
export const ALLOWED_SCHEMES = ['http:', 'https:', 'mailto:'] as const

export type LinkVerdict = {
  ok: boolean
  url: string
  scheme: string
  reason?: 'scheme' | 'parse' | 'streaming'
  // 链接文字像地址、但和真实地址的主机不同
  mismatch: boolean
}

function hostOf(s: string): string | null {
  const t = s.trim()
  const withScheme = /^[a-z][a-z0-9+.-]*:/i.test(t) ? t : `https://${t}`
  try {
    const u = new URL(withScheme)
    return u.hostname ? u.hostname.toLowerCase() : null
  } catch {
    return null
  }
}

const looksLikeAddress = (s: string) => /^\s*([a-z][a-z0-9+.-]*:\/\/)?[a-z0-9-]+(\.[a-z0-9-]+)+(\/\S*)?\s*$/i.test(s)

export function classifyLink(href: string, text?: string): LinkVerdict {
  let u: URL
  try {
    u = new URL(href)
  } catch {
    return { ok: false, url: href, scheme: '', reason: 'parse', mismatch: false }
  }
  const scheme = u.protocol.toLowerCase()
  const ok = (ALLOWED_SCHEMES as readonly string[]).includes(scheme)
  let mismatch = false
  if (text && looksLikeAddress(text) && scheme !== 'mailto:') {
    const a = hostOf(text)
    mismatch = a !== null && a !== u.hostname.toLowerCase()
  }
  return ok ? { ok, url: u.href, scheme, mismatch } : { ok, url: href, scheme, reason: 'scheme', mismatch }
}
