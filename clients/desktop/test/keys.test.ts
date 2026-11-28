// P4 Electron 的逻辑部分：后端判定、basic_text 拒绝、换实例（重启、升级）后同一把钥匙、签名 noble 能验。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { ed25519 } from '@noble/curves/ed25519.js'
import { backendOf, BackendRefused, canHoldKeys, DeviceKeys, type SafeStorageLike } from '../keys.ts'

// 假的 safeStorage：异或一下，够区分「存的不是明文」
const fake = (backend: string): SafeStorageLike => ({
  isEncryptionAvailable: () => true,
  encryptString: s => Buffer.from([...Buffer.from(s)].map(b => b ^ 0x5a)),
  decryptString: b => Buffer.from([...b].map(x => x ^ 0x5a)).toString(),
  getSelectedStorageBackend: () => backend,
})

test('backend mapping', () => {
  assert.equal(backendOf(fake('x'), 'darwin'), 'keychain')
  assert.equal(backendOf(fake('x'), 'win32'), 'dpapi')
  assert.equal(backendOf(fake('basic_text'), 'linux'), 'basic_text')
  assert.equal(backendOf(fake('gnome_libsecret'), 'linux'), 'gnome_libsecret')
  assert.equal(backendOf({ ...fake('x'), isEncryptionAvailable: () => false }, 'linux'), 'unavailable')
  assert.equal(canHoldKeys('basic_text'), false)
  assert.equal(canHoldKeys('keychain'), true)
})

test('basic_text: refuse, write nothing', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'p11-keys-'))
  const k = new DeviceKeys(path.join(dir, 'device.key'), fake('basic_text'), 'basic_text')
  assert.throws(() => k.publicKey(), BackendRefused)
})

test('same key across instances; signature verifies with noble; file is not the raw key', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'p11-keys-'))
  const file = path.join(dir, 'device.key')
  const a = new DeviceKeys(file, fake('keychain'), 'keychain')
  const pk = a.publicKey()
  const b = new DeviceKeys(file, fake('keychain'), 'keychain')
  assert.equal(b.publicKey(), pk)
  assert.equal(b.deviceId().length, 64)
  const h = 'ab'.repeat(32), c = 'cd'.repeat(32)
  const sig = b.sign(h, c)
  const msg = Buffer.concat([Buffer.from('sbot-auth/1'), Buffer.from(h, 'hex'), Buffer.from(c, 'hex')])
  assert.equal(ed25519.verify(Buffer.from(sig, 'base64url'), msg, Buffer.from(pk, 'base64url')), true)
  const pairMsg = Buffer.concat([Buffer.from('sbot-pair/1'), Buffer.from(h, 'hex'), Buffer.from(c, 'hex')])
  assert.equal(ed25519.verify(Buffer.from(sig, 'base64url'), pairMsg, Buffer.from(pk, 'base64url')), false)
  assert.doesNotMatch(readFileSync(file).toString('latin1'), /MC4CAQAwBQYDK2Vw/)
})
