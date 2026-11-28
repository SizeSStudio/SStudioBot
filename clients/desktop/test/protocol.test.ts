import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { buildCsp, makeHandler } from '../protocol.ts'

const root = mkdtempSync(path.join(os.tmpdir(), 'p11-web-'))
const web = path.join(root, 'web')
mkdirSync(path.join(web, '_expo'), { recursive: true })
writeFileSync(path.join(web, 'index.html'), '<!doctype html>')
writeFileSync(path.join(web, '_expo', 'a.js'), 'x')
writeFileSync(path.join(root, 'secret.txt'), 'nope')
symlinkSync(path.join(root, 'secret.txt'), path.join(web, 'link.txt'))
const h = makeHandler(web, () => buildCsp({ unsafeInlineStyle: true }))
const get = (p: string, dest = 'script') => h(new Request('sbot-app://app' + p, { headers: { 'sec-fetch-dest': dest } }))

test('extensionless routes get index.html with CSP header', async () => {
  for (const p of ['/', '/ban', '/self/devices', '/item/abc']) {
    const r = await get(p, 'document')
    assert.equal(r.status, 200, p)
    assert.match(r.headers.get('content-security-policy') ?? '', /script-src 'self'/)
  }
  assert.equal((await get('/item/v1.2', 'document')).status, 200)
})

test('assets served, missing assets 404', async () => {
  assert.equal((await get('/_expo/a.js')).status, 200)
  assert.equal((await get('/_expo/a.js')).headers.get('content-security-policy'), null)
  assert.equal((await get('/_expo/none.js')).status, 404)
})

test('path escapes are 404', async () => {
  for (const p of ['/../secret.txt', '/%2e%2e/secret.txt', '/%2e%2e%2fsecret.txt', '/..%5csecret.txt', '/_expo/../../secret.txt', '/%00index.html', '/link.txt', '/%E0%A4%A']) {
    assert.equal((await get(p)).status, 404, p)
  }
  assert.equal((await h(new Request('sbot-app://other/index.html'))).status, 404)
})

test('CSP: connect-src gets the relay only after pairing', () => {
  assert.match(buildCsp({ unsafeInlineStyle: true }), /connect-src 'self';/)
  assert.match(buildCsp({ relayHost: 'relay.example', unsafeInlineStyle: true }), /connect-src 'self' wss:\/\/relay\.example/)
  assert.doesNotMatch(buildCsp({ unsafeInlineStyle: false }), /unsafe-inline/)
})
