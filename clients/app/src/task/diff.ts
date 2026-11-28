// A unified diff split into files (07 「diff」). The text is untrusted (the agent wrote it, §触6.8): it is only ever
// shown as text — on Android a lowlight `diff` code block per file, on the desktop @pierre/diffs (which escapes it
// into its own DOM) — never parsed as anything but lines. Paths get the bidi and control characters taken out before
// they are shown, so a file name can't pass itself off as another (Trojan Source style).
// Plain TS: node --test runs it.

export type DiffFile = {
  /** shown path (cleaned); `old` when it was renamed */
  path: string
  old: string | null
  added: number
  removed: number
  binary: boolean
  /** this file's part of the diff, headers included, as it came */
  text: string
}
export type SplitDiff = { files: DiffFile[]; added: number; removed: number; truncated: boolean }

/** the most diff text the app pulls and shows ※ (a bigger one: 「去 git 上看」) */
export const DIFF_MAX = 4 * 1024 * 1024
const MAX_FILES = 1000
const PATH_MAX = 300

// C0/C1 controls, bidi embeddings / overrides / isolates, zero-width and BOM
// eslint-disable-next-line no-control-regex
const UNSAFE = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u061c\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g
export function safePath(p: string): string {
  const s = p.replace(UNSAFE, '').trim()
  return (s.length > PATH_MAX ? `…${s.slice(-PATH_MAX)}` : s) || '（没有名字）'
}

const unquote = (s: string) => {
  const t = s.trim()
  return t.startsWith('"') && t.endsWith('"') && t.length >= 2 ? t.slice(1, -1) : t
}
const strip = (s: string) => unquote(s).replace(/^[ab]\//, '').replace(/\t.*$/, '')

/** Split `text` (git diff, or plain ---/+++ unified diff) into files. Never throws. */
export function splitDiff(text: string, max = DIFF_MAX): SplitDiff {
  const truncated = text.length > max
  const src = truncated ? text.slice(0, max) : text
  const lines = src.split('\n')
  const files: DiffFile[] = []
  let cur: (DiffFile & { start: number }) | null = null
  const close = (end: number) => {
    if (!cur) return
    cur.text = lines.slice(cur.start, end).join('\n')
    files.push({ path: cur.path, old: cur.old, added: cur.added, removed: cur.removed, binary: cur.binary, text: cur.text })
    cur = null
  }
  const open = (i: number, path: string, old: string | null) => {
    close(i)
    cur = { path: safePath(path), old: old && old !== path ? safePath(old) : null, added: 0, removed: 0, binary: false, text: '', start: i }
  }
  let inHunk = false
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]!
    const git = /^diff --git (\S+|"[^"]*") (\S+|"[^"]*")\s*$/.exec(l)
    if (git) { open(i, strip(git[2]!), strip(git[1]!)); inHunk = false; continue }
    // a plain unified diff: `--- a` then `+++ b` starts a file unless we're inside a git file that hasn't had them yet
    if (l.startsWith('--- ') && lines[i + 1]?.startsWith('+++ ')) {
      const c = cur as (DiffFile & { start: number }) | null
      const gitHeaderPending = c !== null && !inHunk && c.added === 0 && c.removed === 0
      if (!gitHeaderPending) {
        const a = strip(l.slice(4)), b = strip(lines[i + 1]!.slice(4))
        open(i, b === '/dev/null' ? a : b, a === '/dev/null' ? null : a)
      }
      i++
      inHunk = false
      continue
    }
    if (!cur) {
      if (l.startsWith('@@')) open(i, '（改动）', null)
      else continue
    }
    const f = cur as unknown as DiffFile
    if (l.startsWith('@@')) { inHunk = true; continue }
    if (l.startsWith('Binary files ') || l === 'GIT binary patch') { f.binary = true; continue }
    if (!inHunk) continue
    if (l.startsWith('+')) f.added++
    else if (l.startsWith('-')) f.removed++
  }
  close(lines.length)
  const kept = files.slice(0, MAX_FILES)
  return {
    files: kept,
    added: kept.reduce((n, f) => n + f.added, 0),
    removed: kept.reduce((n, f) => n + f.removed, 0),
    truncated: truncated || files.length > MAX_FILES,
  }
}

/** UTF-8 bytes → text, never throwing on a bad sequence (it becomes U+FFFD). */
export const decodeText = (b: Uint8Array): string => new TextDecoder('utf-8', { fatal: false }).decode(b)

// ── a diff in a blob (DiffBlob) ──────────────────────────────────────────────────────────────────────────────
export type Stat = { files?: unknown; added?: unknown; removed?: unknown } | null | undefined
const n = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null)

/** `blob:<sha>` or a bare sha → the sha, or null */
export const shaOf = (ref: unknown): string | null => {
  if (typeof ref !== 'string') return null
  const m = /^(?:blob:)?([0-9a-f]{64})$/.exec(ref)
  return m ? m[1]! : null
}

export function statLine(s: Stat): string {
  if (!s) return ''
  const files = Array.isArray(s.files) ? s.files.length : null
  const a = n(s.added), r = n(s.removed)
  return [files !== null ? `${files} 个文件` : '', a !== null ? `+${a}` : '', r !== null ? `−${r}` : ''].filter(Boolean).join(' ')
}
