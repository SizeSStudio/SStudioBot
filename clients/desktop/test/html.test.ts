// Desktop agent HTML opener (clients/desktop/html.ts) & bridge contract checks: sha256 verification, size bounds,
// clean hex filename, symlink safety, atomic 0600 write, 24 h cache cleanup, narrow preload surface. Fictional data.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { lstatSync, mkdtempSync, readFileSync, readdirSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { cleanupHtmlCache, HTML_MAX_AGE_MS, isValidSha, openHtmlFile } from '../html.ts'

const shaOf = (b: Uint8Array) => createHash('sha256').update(b).digest('hex')
const mkroot = () => mkdtempSync(path.join(os.tmpdir(), 'sbot-html-test-'))

test('openHtmlFile: verifies sha256, writes 0600 file in 0700 dir, opens in system browser', async () => {
  const dir = path.join(mkroot(), 'sbot-html')
  const bytes = new TextEncoder().encode('<!doctype html><title>样稿</title><p>ok</p>')
  const sha = shaOf(bytes)
  const opened: string[] = []

  const ok = await openHtmlFile(sha, bytes, { dir, openPath: async (f) => { opened.push(f); return '' } })
  assert.equal(ok, true)
  assert.equal(opened.length, 1)
  assert.equal(path.basename(opened[0]!), `${sha}.html`)
  assert.equal(readFileSync(opened[0]!, 'utf8'), '<!doctype html><title>样稿</title><p>ok</p>')
  assert.equal(lstatSync(dir).mode & 0o777, 0o700)
  assert.equal(lstatSync(opened[0]!).mode & 0o777, 0o600)
  assert.deepEqual(readdirSync(dir), [`${sha}.html`], 'no leftover .tmp files')

  // Subarray view (byteOffset > 0): hashes and writes ONLY the view, not the whole underlying buffer
  const backing = new Uint8Array([0x00, 0x01, ...bytes, 0xff])
  const view = backing.subarray(2, 2 + bytes.length)
  assert.equal(await openHtmlFile(sha, view, { dir, openPath: async () => '' }), true)
  assert.equal(readFileSync(opened[0]!).byteLength, bytes.length)
})

test('openHtmlFile: refuses invalid sha, non-Uint8Array, empty, oversized, sha mismatch, openPath error', async () => {
  const dir = path.join(mkroot(), 'sbot-html')
  const bytes = new TextEncoder().encode('<p>hi</p>')
  const sha = shaOf(bytes)
  let called = false
  const openPath = async () => { called = true; return '' }

  // Bad shas (traversal, uppercase, short, NUL, non-string)
  for (const bad of ['../evil', sha.toUpperCase(), sha.slice(0, 63), `${sha}\0.html`, 'a'.repeat(64) + ' ', 123, null]) {
    assert.equal(isValidSha(bad), false)
    assert.equal(await openHtmlFile(bad, bytes, { dir, openPath }), false)
  }
  // Bad byte types
  for (const bad of ['<p>hi</p>', bytes.buffer, new Int32Array(4), null, {}]) {
    assert.equal(await openHtmlFile(sha, bad, { dir, openPath }), false)
  }
  // Empty bytes
  assert.equal(await openHtmlFile(shaOf(new Uint8Array(0)), new Uint8Array(0), { dir, openPath }), false)
  // Oversized
  assert.equal(await openHtmlFile(sha, bytes, { dir, openPath, maxBytes: 4 }), false)
  // Tampered bytes (sha mismatch)
  const tampered = new Uint8Array(bytes)
  tampered[0] ^= 1
  assert.equal(await openHtmlFile(sha, tampered, { dir, openPath }), false)
  assert.equal(called, false, 'openPath never called when validation fails')

  // openPath returning an OS error string or throwing returns false
  assert.equal(await openHtmlFile(sha, bytes, { dir, openPath: async () => 'no browser' }), false)
  assert.equal(await openHtmlFile(sha, bytes, { dir, openPath: async () => { throw new Error('boom') } }), false)
})

test('openHtmlFile: refuses symlink dir and replaces symlink dest without following it', async () => {
  const root = mkroot()
  const victimDir = path.join(root, 'victim-dir')
  const linkDir = path.join(root, 'sbot-html')
  const bytes = new TextEncoder().encode('<p>safe</p>')
  const sha = shaOf(bytes)

  // 1) Cache dir itself is a symlink → refused
  const realTarget = mkdtempSync(path.join(root, 'real-'))
  symlinkSync(realTarget, linkDir)
  let opened = false
  assert.equal(await openHtmlFile(sha, bytes, { dir: linkDir, openPath: async () => { opened = true; return '' } }), false)
  assert.equal(opened, false)
  assert.deepEqual(readdirSync(realTarget), [])

  // 2) Pre-existing symlink at <dir>/<sha>.html → atomic rename replaces symlink, victim file untouched
  const victimFile = path.join(root, 'victim.txt')
  writeFileSync(victimFile, 'DO NOT TOUCH')
  const cleanDir = path.join(root, 'clean-cache')
  // Create cleanDir via first valid write of another sha, then plant symlink
  const seed = new TextEncoder().encode('<p>seed</p>')
  assert.equal(await openHtmlFile(shaOf(seed), seed, { dir: cleanDir, openPath: async () => '' }), true)
  symlinkSync(victimFile, path.join(cleanDir, `${sha}.html`))
  assert.equal(await openHtmlFile(sha, bytes, { dir: cleanDir, openPath: async () => '' }), true)
  assert.equal(readFileSync(victimFile, 'utf8'), 'DO NOT TOUCH')
  assert.equal(lstatSync(path.join(cleanDir, `${sha}.html`)).isSymbolicLink(), false)
  assert.equal(readFileSync(path.join(cleanDir, `${sha}.html`), 'utf8'), '<p>safe</p>')
  void victimDir
})

test('cleanupHtmlCache: deletes only cached .html/.tmp files older than 24 h; leaves fresh, foreign and symlinks', async () => {
  const root = mkroot()
  const dir = path.join(root, 'sbot-html')
  const now = 1_700_000_000_000
  const old = new Date(now - HTML_MAX_AGE_MS - 1000)
  const fresh = new Date(now - 60_000)

  const b1 = new TextEncoder().encode('<p>old</p>'), s1 = shaOf(b1)
  const b2 = new TextEncoder().encode('<p>fresh</p>'), s2 = shaOf(b2)
  await openHtmlFile(s1, b1, { dir, openPath: async () => '' })
  await openHtmlFile(s2, b2, { dir, openPath: async () => '' })
  const staleTmp = path.join(dir, `${s1}.0123456789abcdef.tmp`)
  writeFileSync(staleTmp, 'half')
  const foreign = path.join(dir, 'keep-me.txt')
  writeFileSync(foreign, 'x')
  const link = path.join(dir, `${'b'.repeat(64)}.html`)
  symlinkSync(foreign, link)

  utimesSync(path.join(dir, `${s1}.html`), old, old)
  utimesSync(staleTmp, old, old)
  utimesSync(foreign, old, old)
  utimesSync(path.join(dir, `${s2}.html`), fresh, fresh)

  const removed = await cleanupHtmlCache(dir, HTML_MAX_AGE_MS, () => now)
  assert.equal(removed, 2)
  assert.deepEqual(readdirSync(dir).sort(), [`${s2}.html`, `${'b'.repeat(64)}.html`, 'keep-me.txt'].sort())

  // Missing dir and symlink dir are safe no-ops
  assert.equal(await cleanupHtmlCache(path.join(root, 'nope')), 0)
  const sym = path.join(root, 'sym-dir')
  symlinkSync(dir, sym)
  assert.equal(await cleanupHtmlCache(sym), 0)
})

test('preload.cjs keeps the bridge narrow (device, pair, link, html only)', () => {
  const here = path.dirname(fileURLToPath(import.meta.url))
  const src = readFileSync(path.join(here, '../preload.cjs'), 'utf8')
  const channels = [...src.matchAll(/ipcRenderer\.invoke\(\s*'([^']+)'/g)].map((m) => m[1])
  assert.deepEqual(channels.sort(), [
    'device.publicKey', 'device.sign',
    'html.open',
    'link.open',
    'pair.accept', 'pair.cancel', 'pair.current', 'pair.forget', 'pair.pending', 'pair.save', 'pair.takeLink',
  ])
})
