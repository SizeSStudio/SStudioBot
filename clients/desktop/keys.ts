// 设备密钥只在主进程：node:crypto 生成 Ed25519，safeStorage 加密后存 userData/device.key（06、07）。
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign as edSign } from 'node:crypto'
import { chmodSync, existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'

export type SafeStorageLike = {
  isEncryptionAvailable(): boolean
  encryptString(s: string): Buffer
  decryptString(b: Buffer): string
  getSelectedStorageBackend?: () => string
}

// Mac 是钥匙串、Windows 是 DPAPI；Linux 看 Electron 选中的后端，basic_text 等于明文
export function backendOf(store: SafeStorageLike, platform: string): string {
  if (!store.isEncryptionAvailable()) return 'unavailable'
  if (platform === 'darwin') return 'keychain'
  if (platform === 'win32') return 'dpapi'
  try { return store.getSelectedStorageBackend?.() ?? 'unknown' } catch { return 'unknown' }
}

export const canHoldKeys = (backend: string) => !['basic_text', 'unavailable', 'unknown'].includes(backend)

const b64u = (b: Uint8Array) => Buffer.from(b).toString('base64url')
const AUTH = Buffer.from('sbot-auth/1')
const PAIR = Buffer.from('sbot-pair/1')

export class BackendRefused extends Error {
  backend: string
  constructor(backend: string) { super(`safeStorage 后端是 ${backend}，不存设备私钥、不配对`); this.backend = backend }
}

export class DeviceKeys {
  private priv: ReturnType<typeof createPrivateKey> | null = null
  private pub: Buffer | null = null
  private readonly file: string
  private readonly store: SafeStorageLike
  private readonly backend: string
  constructor(file: string, store: SafeStorageLike, backend: string) {
    this.file = file
    this.store = store
    this.backend = backend
  }

  // 有就读，没有就生成；后端不可靠时一律拒绝，不降级
  ensure(): void {
    if (this.priv) return
    if (!canHoldKeys(this.backend)) throw new BackendRefused(this.backend)
    if (existsSync(this.file)) {
      const der = Buffer.from(this.store.decryptString(readFileSync(this.file)), 'base64')
      this.priv = createPrivateKey({ key: der, format: 'der', type: 'pkcs8' })
    } else {
      const { privateKey } = generateKeyPairSync('ed25519')
      const der = privateKey.export({ format: 'der', type: 'pkcs8' })
      const tmp = this.file + '.tmp'
      writeFileSync(tmp, this.store.encryptString(der.toString('base64')), { mode: 0o600 })
      chmodSync(tmp, 0o600)
      renameSync(tmp, this.file)
      this.priv = privateKey
    }
    const spki = createPublicKey(this.priv).export({ format: 'der', type: 'spki' })
    this.pub = spki.subarray(spki.length - 32) // Ed25519 SPKI 末尾 32 字节就是原始公钥
  }

  publicKey(): string { this.ensure(); return b64u(this.pub!) }
  deviceId(): string { this.ensure(); return createHash('sha256').update(this.pub!).digest('hex') }

  // 域分隔前缀 || 握手 hash || challenge（06「设备密钥」）
  sign(handshakeHashHex: string, challengeHex: string, purpose: 'auth' | 'pair' = 'auth'): string {
    this.ensure()
    const msg = Buffer.concat([purpose === 'auth' ? AUTH : PAIR, Buffer.from(handshakeHashHex, 'hex'), Buffer.from(challengeHex, 'hex')])
    return b64u(edSign(null, msg, this.priv!))
  }
}
