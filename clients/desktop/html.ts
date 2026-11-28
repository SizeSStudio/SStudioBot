// Agent-generated HTML (D14, 07 「agent 做的 HTML」): never rendered inside the app. The renderer pulls the blob over
// Noise and hands (sha, bytes) here; main verifies sha256(bytes) === sha and size bounds, writes <dir>/<sha>.html
// atomically (0600, clean hex filename, symlink-safe dir), and hands the file to the system browser via shell.openPath.
// Startup cleans files older than 24 h.
import { createHash, randomBytes } from 'node:crypto'
import { lstat, mkdir, readdir, realpath, rename, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'

export const HTML_DIR_NAME = 'sbot-html'
export const HTML_MAX_BYTES = 20 * 1024 * 1024
export const HTML_MAX_AGE_MS = 24 * 60 * 60 * 1000

const SHA256_RE = /^[0-9a-f]{64}$/
const CACHE_FILE_RE = /^[0-9a-f]{64}(?:\.html|\.[0-9a-f]{16}\.tmp)$/

export function isValidSha(sha: unknown): sha is string {
  return typeof sha === 'string' && SHA256_RE.test(sha)
}

/** Verify `dir` is a real directory owned by us (never a symlink in a shared /tmp); create it 0700 if missing. */
async function safeDir(dir: string, create: boolean): Promise<string | null> {
  if (create) {
    try { await mkdir(dir, { recursive: true, mode: 0o700 }) } catch { return null }
  }
  let st
  try { st = await lstat(dir) } catch { return null }
  if (!st.isDirectory() || st.isSymbolicLink()) return null
  if (typeof process.getuid === 'function' && st.uid !== process.getuid()) return null
  try { return await realpath(dir) } catch { return null }
}

export type OpenHtmlOpts = {
  dir: string
  openPath: (file: string) => Promise<string>
  maxBytes?: number
}

/** Validate (sha, bytes), write <dir>/<sha>.html atomically, open in the system browser. False = refused or failed. */
export async function openHtmlFile(sha: unknown, bytes: unknown, opts: OpenHtmlOpts): Promise<boolean> {
  if (!isValidSha(sha)) return false
  if (!(bytes instanceof Uint8Array)) return false
  const limit = opts.maxBytes ?? HTML_MAX_BYTES
  if (bytes.byteLength === 0 || bytes.byteLength > limit) return false
  const buf = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  if (createHash('sha256').update(buf).digest('hex') !== sha) return false

  const realDir = await safeDir(opts.dir, true)
  if (!realDir) return false
  const dest = path.join(realDir, `${sha}.html`)
  const tmp = path.join(realDir, `${sha}.${randomBytes(8).toString('hex')}.tmp`)
  if (!dest.startsWith(realDir + path.sep) || !tmp.startsWith(realDir + path.sep)) return false

  try {
    // exclusive create never follows a pre-existing symlink; rename atomically replaces dest without following it
    await writeFile(tmp, buf, { flag: 'wx', mode: 0o600 })
    await rename(tmp, dest)
  } catch {
    await rm(tmp, { force: true }).catch(() => {})
    return false
  }
  try {
    const err = await opts.openPath(dest)
    return err === ''
  } catch {
    return false
  }
}

/** Delete cached .html / stale .tmp files at least maxAgeMs old; ignores everything else. Returns count removed. */
export async function cleanupHtmlCache(dir: string, maxAgeMs = HTML_MAX_AGE_MS, now: () => number = Date.now): Promise<number> {
  const realDir = await safeDir(dir, false)
  if (!realDir) return 0
  let entries: string[]
  try { entries = await readdir(realDir) } catch { return 0 }
  let removed = 0
  const cutoff = now() - maxAgeMs
  for (const name of entries) {
    if (!CACHE_FILE_RE.test(name)) continue
    const file = path.join(realDir, name)
    try {
      const st = await lstat(file)
      if (!st.isFile() || st.isSymbolicLink()) continue
      if (st.mtimeMs <= cutoff) { await rm(file, { force: true }); removed++ }
    } catch { /* vanished concurrently */ }
  }
  return removed
}
