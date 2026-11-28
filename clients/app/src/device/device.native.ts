// Android (06 「设备密钥」, P4): Keystore Ed25519 when the device has it (API ≥ 33); otherwise a noble key whose
// seed is wrapped by a non-exportable Keystore AES-GCM key (modules/device-key). The pairing (no secrets) is in the
// app's private SharedPreferences. 待测（手机）：which branch a real device takes, sign latency, survival across restarts.
import * as Linking from 'expo-linking'
import { ed25519 } from '@noble/curves/ed25519.js'
import DeviceKey from '../../modules/device-key/index.ts'
import { AUTH_PREFIX, b64u, fromB64u, PAIR_LINK_PREFIX, PAIR_PREFIX, signedBytes } from '../../../../protocol/pair.ts'
import type { Pairing } from '../conn/machine.ts'
import { PAIR_ERROR_TEXT, readPairCode } from '../conn/pairCode.ts'
import type { DeviceApi } from './types.ts'

type Key = { kind: 'hardware'; pk: string } | { kind: 'software'; seed: Uint8Array; pk: string }
let key: Key | null = null
let strongbox = false

async function load(create: boolean): Promise<Key> {
  if (key) return key
  const hw = await DeviceKey.hardwarePublicKey(create)
  if (hw) return (key = { kind: 'hardware', pk: hw })
  const wrapped = await DeviceKey.loadWrapped()
  if (wrapped) { const seed = fromB64u(wrapped); return (key = { kind: 'software', seed, pk: b64u(ed25519.getPublicKey(seed)) }) }
  if (!create) throw new Error('这台还没有设备密钥：先配对')
  const seed = ed25519.utils.randomSecretKey()
  await DeviceKey.storeWrapped(b64u(seed))
  return (key = { kind: 'software', seed, pk: b64u(ed25519.getPublicKey(seed)) })
}

const isPairing = (p: unknown): p is Pairing => {
  const o = p as Pairing
  return !!o && typeof o.hub_pk === 'string' && typeof o.relay === 'string' && typeof o.device_id === 'string' && (o.role === 'client' || o.role === 'node')
}

export const device: DeviceApi = {
  platform: 'android',
  canPair: true,
  publicKey: async () => (await load(false)).pk,
  async sign(h, c, purpose) {
    const k = await load(false)
    const msg = signedBytes(purpose === 'auth' ? AUTH_PREFIX : PAIR_PREFIX, fromB64u(h), fromB64u(c))
    return k.kind === 'hardware' ? DeviceKey.hardwareSign(b64u(msg)) : b64u(ed25519.sign(msg, k.seed))
  },
  async keyInfo() {
    const i = await DeviceKey.info().catch(() => null)
    strongbox = !!i?.strongbox
    const k = await load(false).catch(() => null)
    if (!k) return '还没有'
    return k.kind === 'hardware' ? `Keystore Ed25519${strongbox ? '（有 StrongBox）' : ''}` : 'noble，种子由 Keystore AES-GCM 包着'
  },
  async pairing() {
    const raw = await DeviceKey.getPairing()
    try { const p = raw ? JSON.parse(raw) : null; return isPairing(p) ? p : null } catch { return null }
  },
  async beginPair(text) {
    const p = readPairCode(text)
    if (!p.ok) return { ok: false, error: PAIR_ERROR_TEXT[p.error] }
    if (await device.pairing()) return { ok: false, error: '这台已经配对了：要换一个主，先在设备页「解除配对」' }
    key = null
    await DeviceKey.deleteKeys()
    await load(true) // a fresh key for every pairing (06)
    return { ok: true, code: p.code }
  },
  pendingPair: async () => null,
  savePairing: async (p) => { await DeviceKey.setPairing(JSON.stringify({ hub_pk: p.hub_pk, relay: p.relay, device_id: p.device_id, role: p.role })) },
  async forget() {
    await DeviceKey.setPairing(null)
    await DeviceKey.deleteKeys()
    if (key?.kind === 'software') key.seed.fill(0)
    key = null
  },
  onLink(cb) {
    const take = (url: string | null) => { if (url?.startsWith(PAIR_LINK_PREFIX)) cb(url) }
    void Linking.getInitialURL().then(take)
    const sub = Linking.addEventListener('url', (e) => take(e.url))
    return () => sub.remove()
  },
}
