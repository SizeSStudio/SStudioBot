// Android (Hermes): the Noise primitives in native code through react-native-quick-crypto (02, P1: noble's AEAD is
// too slow on Hermes), the same calls as protocol/noise/node-crypto.ts. Checked against noble at startup on fixed
// inputs; if anything differs or throws, it stays on noble (slower, still correct) and the device page says so.
// 待测（手机）：quick-crypto's chacha20-poly1305 with AAD and raw X25519 via DER on a real device.
import QuickCrypto, { install } from 'react-native-quick-crypto'
import { nobleAead, nobleDh, useCrypto, type Aead, type Dh } from '../../../../protocol/noise/crypto.ts'

const TAG = 16
const hex = (s: string) => Uint8Array.from(s.match(/../g)!.map((b) => parseInt(b, 16)))
const cat = (...a: Uint8Array[]) => { const o = new Uint8Array(a.reduce((n, x) => n + x.length, 0)); let i = 0; for (const x of a) { o.set(x, i); i += x.length } return o }
const u8 = (b: ArrayBufferView | ArrayBuffer) => (b instanceof ArrayBuffer ? new Uint8Array(b) : new Uint8Array(b.buffer, b.byteOffset, b.byteLength)).slice()
const PKCS8 = hex('302e020100300506032b656e04220420'), SPKI = hex('302a300506032b656e032100')
// quick-crypto's surface is node:crypto's; its own types are looser than ours
const C = QuickCrypto as unknown as typeof import('node:crypto')

const quickAead: Aead = {
  seal(key, nonce, ad, pt) {
    const c = C.createCipheriv('chacha20-poly1305', key, nonce, { authTagLength: TAG })
    c.setAAD(ad, { plaintextLength: pt.byteLength })
    const body = u8(c.update(pt)); c.final()
    return cat(body, u8(c.getAuthTag()))
  },
  open(key, nonce, ad, ct) {
    if (ct.byteLength < TAG) throw new Error('short ciphertext')
    const d = C.createDecipheriv('chacha20-poly1305', key, nonce, { authTagLength: TAG })
    d.setAAD(ad, { plaintextLength: ct.byteLength - TAG })
    d.setAuthTag(ct.subarray(ct.byteLength - TAG))
    const body = u8(d.update(ct.subarray(0, ct.byteLength - TAG))); d.final() // throws on a bad tag
    return body
  },
}
const priv = (sk: Uint8Array) => C.createPrivateKey({ key: cat(PKCS8, sk) as Buffer, format: 'der', type: 'pkcs8' })
const pub = (pk: Uint8Array) => C.createPublicKey({ key: cat(SPKI, pk) as Buffer, format: 'der', type: 'spki' })
const rawPublic = (k: ReturnType<typeof C.createPublicKey>) => u8(k.export({ format: 'der', type: 'spki' })).subarray(SPKI.length)
const quickDh: Dh = {
  generateKeyPair: () => nobleDh.generateKeyPair(), // random 32 bytes either way; quick-crypto's getRandomValues backs noble after install()
  publicKey: (sk) => rawPublic(C.createPublicKey(priv(sk))),
  dh: (sk, pk) => u8(C.diffieHellman({ privateKey: priv(sk), publicKey: pub(pk) })),
}

const same = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((x, i) => x === b[i])

/** Once at startup, before the first handshake. Returns what the device page shows. */
export function setupCrypto(): string {
  install() // global crypto.getRandomValues (noble's randomness on Hermes) and Buffer
  try {
    const k = new Uint8Array(32).fill(7), n = new Uint8Array(12).fill(1), ad = hex('0102'), m = new TextEncoder().encode('试一下 quick-crypto')
    const sealed = quickAead.seal(k, n, ad, m)
    const a = nobleDh.generateKeyPair(), b = nobleDh.generateKeyPair()
    const ok = same(sealed, nobleAead.seal(k, n, ad, m)) && same(quickAead.open(k, n, ad, sealed), m) &&
      same(quickDh.publicKey(a.secretKey), a.publicKey) && same(quickDh.dh(a.secretKey, b.publicKey), nobleDh.dh(a.secretKey, b.publicKey))
    let tamper = false
    try { sealed[0]! ^= 1; quickAead.open(k, n, ad, sealed) } catch { tamper = true }
    if (!ok || !tamper) return 'noble（quick-crypto 自检不一致）'
    useCrypto({ aead: quickAead, dh: quickDh })
    return 'quick-crypto'
  } catch {
    return 'noble（quick-crypto 不可用）'
  }
}
