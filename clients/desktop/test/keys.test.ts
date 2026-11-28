// The Electron key store without Electron (P4): backend mapping, basic_text refused with nothing written, the same key
// across instances (restart, update), signatures that noble verifies, purposes kept apart, the file isn't the raw key.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { ed25519 } from '@noble/curves/ed25519.js'
import { AUTH_PREFIX, PAIR_PREFIX, signedBytes } from '../../../protocol/pair.ts'
import { backendOf, BackendRefused, canHoldKeys, DeviceKeys, type SafeStorageLike } from '../keys.ts'

// a fake safeStorage: XOR is enough to tell "not stored in the clear"
const xor = (b: Uint8Array) => Buffer.from([...b].map((x) => x ^ 0x5a))
const fake = (backend: string, available = true): SafeStorageLike => ({
  isAsyncEncryptionAvailable: async () => available,
  encryptStringAsync: async (s) => xor(Buffer.from(s)),
  decryptStringAsync: async (b) => ({ result: xor(b).toString(), shouldReEncrypt: false }),
  getSelectedStorageBackend: () => backend,
})
const dir = () => mkdtempSync(path.join(os.tmpdir(), 'sbot-keys-'))
const H = Buffer.alloc(32, 0xab).toString('base64url'), C = Buffer.alloc(32, 0xcd).toString('base64url')

test('backend mapping', async () => {
  assert.equal(await backendOf(fake('x'), 'darwin'), 'keychain')
  assert.equal(await backendOf(fake('x'), 'win32'), 'dpapi')
  assert.equal(await backendOf(fake('basic_text'), 'linux'), 'basic_text')
  assert.equal(await backendOf(fake('gnome_libsecret'), 'linux'), 'gnome_libsecret')
  assert.equal(await backendOf(fake('x', false), 'linux'), 'unavailable')
  assert.equal(canHoldKeys('basic_text'), false)
  assert.equal(canHoldKeys('unknown'), false)
  assert.equal(canHoldKeys('keychain'), true)
})

test('basic_text: refuse and write nothing', async () => {
  const file = path.join(dir(), 'device.key')
  const k = new DeviceKeys(file, fake('basic_text'), 'basic_text')
  await assert.rejects(k.publicKey(), BackendRefused)
  await assert.rejects(k.sign(H, C, 'pair'), BackendRefused)
  assert.equal(existsSync(file), false)
})

test('same key across instances; noble verifies; purposes differ; the file is not the raw key', async () => {
  const file = path.join(dir(), 'device.key')
  const a = new DeviceKeys(file, fake('keychain'), 'keychain')
  const [pk, pk2] = await Promise.all([a.publicKey(), a.publicKey()]) // concurrent first use makes one key
  assert.equal(pk, pk2)
  const b = new DeviceKeys(file, fake('keychain'), 'keychain')
  assert.equal(await b.publicKey(), pk)
  assert.match(await b.deviceId(), /^[0-9a-f]{64}$/)
  const sig = Buffer.from(await b.sign(H, C, 'auth'), 'base64url')
  const h = Buffer.from(H, 'base64url'), c = Buffer.from(C, 'base64url'), pub = Buffer.from(pk, 'base64url')
  assert.equal(ed25519.verify(sig, signedBytes(AUTH_PREFIX, h, c), pub), true)
  assert.equal(ed25519.verify(sig, signedBytes(PAIR_PREFIX, h, c), pub), false)
  assert.doesNotMatch(readFileSync(file).toString('latin1'), /MC4CAQAwBQYDK2Vw/) // the PKCS#8 Ed25519 header
})

test('renew makes a new key; forget removes it', async () => {
  const file = path.join(dir(), 'device.key')
  const k = new DeviceKeys(file, fake('keychain'), 'keychain')
  const a = await k.publicKey()
  await k.renew()
  const b = await k.publicKey()
  assert.notEqual(a, b)
  assert.equal(await new DeviceKeys(file, fake('keychain'), 'keychain').publicKey(), b)
  await k.forget()
  assert.equal(existsSync(file), false)
  await assert.rejects(new DeviceKeys(file, fake('basic_text'), 'basic_text').renew(), BackendRefused)
})

test('sign checks its inputs', async () => {
  const k = new DeviceKeys(path.join(dir(), 'device.key'), fake('keychain'), 'keychain')
  await assert.rejects(k.sign('ab'.repeat(32), C, 'auth'), /bad input/) // hex, not base64url
  await assert.rejects(k.sign(H, C, 'other' as 'auth'), /bad purpose/)
})
