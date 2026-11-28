// A pairing link the OS handed us, kept in memory only until the pair screen takes it (it holds a one-time secret).
let link: string | null = null
const subs = new Set<(l: string) => void>()
export function setIncomingLink(l: string) { link = l; for (const f of subs) f(l) }
export function takeIncomingLink(): string | null { const l = link; link = null; return l }
export function onIncomingLink(f: (l: string) => void): () => void { subs.add(f); return () => { subs.delete(f) } }
