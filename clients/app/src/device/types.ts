// What the app needs from the device, per platform (07 src/device/): the key (sign, public key), where the pairing is
// kept, and how pairing starts. device.web.ts goes through Electron's bridge; device.native.ts is the Keystore module.
import type { PairCode } from '../../../../protocol/pair.ts'
import type { Pairing, Signer } from '../conn/machine.ts'

export type BeginPair =
  | { ok: true; code: PairCode } // start the connection with this code now
  | { ok: true; reloading: true } // Electron: main took the code and reloads the page (CSP), pendingPair() has it
  | { ok: false; error: string }

export interface DeviceApi extends Signer {
  /** android | macos | windows | linux | web; sent with `pair` */
  platform: string
  /** can this build pair at all (a plain browser can't: no key store) */
  canPair: boolean
  /** where the key is, for the device page ("Keystore（StrongBox）", "钥匙串" …) */
  keyInfo(): Promise<string>
  pairing(): Promise<Pairing | null>
  /** check a pasted / scanned / opened code and make a fresh key for it (06: a seen key can't pair twice) */
  beginPair(text: string): Promise<BeginPair>
  /** Electron: the code main is holding after the reload; elsewhere null */
  pendingPair(): Promise<PairCode | null>
  savePairing(p: Pairing): Promise<void>
  /** unpair this device: the pairing and the key both go */
  forget(): Promise<void>
  /** sstudiobot://pair links the OS hands the app */
  onLink(cb: (link: string) => void): () => void
}
