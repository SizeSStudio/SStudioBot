// The device key lives only in the main process (06 「设备密钥」, 07 Electron): node:crypto makes an Ed25519 key,
// safeStorage encrypts it (Mac keychain, Windows DPAPI, a Linux keyring) into userData/device.key. A backend that
// would store it in the clear (`basic_text`) is refused: no key, no pairing, no downgrade.
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign as edSign, type KeyObject } from 'node:crypto'
import { existsSync } from 'node:fs'
import { readFile, rename, writeFile } from 'node:fs/promises'
import { signedMessage, type SigPurpose } from '../../protocol/link.ts'

/** The bits of Electron's safeStorage we use (the async API; the sync one is deprecated since Electron 45). */
export type SafeStorageLike = {
  isAsyncEncryptionAvailable(): Promise<boolean>
  encryptStringAsync(s: string): Promise<Buffer>
  decryptStringAsync(b: Buffer): Promise<{ result: string; shouldReEncrypt: boolean }>
  getSelectedStorageBackend?: () => string
}

/** Mac is the keychain, Windows DPAPI; on Linux whatever Electron picked, and `basic_text` means plaintext. */
export async function backendOf(store: SafeStorageLike, platform: string): Promise<string> {
  if (!(await store.isAsyncEncryptionAvailable())) return 'unavailable'
  if (platform === 'darwin') return 'keychain'
  if (platform === 'win32') return 'dpapi'
  try { return store.getSelectedStorageBackend?.() ?? 'unknown' } catch { return 'unknown' }
}

export const canHoldKeys = (backend: string) => !['basic_text', 'unavailable', 'unknown'].includes(backend)

export class BackendRefused extends Error {
  backend: string
  constructor(backend: string) {
    super(`safeStorage 后端是 ${backend}：设备私钥会以明文落盘，不生成、不配对。装好钥匙环（gnome-keyring / kwallet）后再试。`)
    this.backend = backend
  }
}

const b64u = (b: Uint8Array) => Buffer.from(b).toString('base64url')
const B64U = /^[A-Za-z0-9_-]{43}$/ // 32 bytes

export class DeviceKeys {
  #priv: KeyObject | null = null
  #pub: Buffer | null = null
  #loading: Promise<void> | null = null
  readonly #file: string
  readonly #store: SafeStorageLike
  readonly #backend: string
  constructor(file: string, store: SafeStorageLike, backend: string) {
    this.#file = file
    this.#store = store
    this.#backend = backend
  }

  get exists(): boolean { return existsSync(this.#file) }

  /** Load the key, or make one; one at a time, so two callers can't both generate. */
  ensure(): Promise<void> {
    if (this.#priv) return Promise.resolve()
    this.#loading ??= this.#load().finally(() => { this.#loading = null })
    return this.#loading
  }

  async #load(): Promise<void> {
    if (!canHoldKeys(this.#backend)) throw new BackendRefused(this.#backend)
    let priv: KeyObject
    if (existsSync(this.#file)) {
      const { result, shouldReEncrypt } = await this.#store.decryptStringAsync(await readFile(this.#file))
      priv = createPrivateKey({ key: Buffer.from(result, 'base64'), format: 'der', type: 'pkcs8' })
      if (shouldReEncrypt) await this.#save(priv) // the OS rotated its key: store under the new one
    } else {
      priv = generateKeyPairSync('ed25519').privateKey
      await this.#save(priv)
    }
    const spki = createPublicKey(priv).export({ format: 'der', type: 'spki' })
    this.#pub = spki.subarray(spki.length - 32) // an Ed25519 SPKI ends with the raw 32-byte key
    this.#priv = priv
  }

  async #save(priv: KeyObject): Promise<void> {
    const der = priv.export({ format: 'der', type: 'pkcs8' })
    const tmp = this.#file + '.tmp'
    await writeFile(tmp, await this.#store.encryptStringAsync(der.toString('base64')), { mode: 0o600 })
    await rename(tmp, this.#file)
  }

  async publicKey(): Promise<string> { await this.ensure(); return b64u(this.#pub!) }
  async deviceId(): Promise<string> { await this.ensure(); return createHash('sha256').update(this.#pub!).digest('hex') }

  /** prefix ‖ handshake hash ‖ challenge (06); both inputs are 32 bytes, base64url. */
  async sign(handshakeHash: string, challenge: string, purpose: SigPurpose): Promise<string> {
    if (!B64U.test(handshakeHash) || !B64U.test(challenge)) throw new Error('bad input')
    if (purpose !== 'auth' && purpose !== 'pair') throw new Error('bad purpose')
    await this.ensure()
    const msg = signedMessage(purpose, Buffer.from(handshakeHash, 'base64url'), Buffer.from(challenge, 'base64url'))
    return b64u(edSign(null, msg, this.#priv!))
  }
}
