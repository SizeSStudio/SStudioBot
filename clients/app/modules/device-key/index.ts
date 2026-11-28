// The Android device-key module (06 「设备密钥」, P4). Kotlin in android/; JS sees only these calls. Strings are base64url.
import { requireNativeModule } from 'expo'

export type KeyInfo = { sdk: number; strongbox: boolean }

export interface DeviceKeyNative {
  /** Keystore Ed25519 (API ≥ 33 and the KeyMint takes it): the public key; `create` makes one if there's none.
   * null = no hardware key (none yet, or this device can't). */
  hardwarePublicKey(create: boolean): Promise<string | null>
  /** drop both the hardware key and the wrapped software one */
  deleteKeys(): Promise<void>
  /** sign with the Keystore Ed25519 key */
  hardwareSign(message: string): Promise<string>
  /** the software key's 32-byte seed, unwrapped with the Keystore AES-GCM key; null = none stored */
  loadWrapped(): Promise<string | null>
  /** wrap a fresh seed with a non-exportable Keystore AES-GCM key and keep the ciphertext in the app's private dir */
  storeWrapped(seed: string): Promise<void>
  /** pairing info (hub key, relay, device id; no secrets) in the app's private SharedPreferences */
  getPairing(): Promise<string | null>
  setPairing(json: string | null): Promise<void>
  /** interface preferences (the phone-notifications switch); keys [a-z_]{1,32}, values ≤ 200 chars, no content */
  getPref(key: string): Promise<string | null>
  setPref(key: string, value: string | null): Promise<void>
  info(): Promise<KeyInfo>
}

export default requireNativeModule<DeviceKeyNative>('DeviceKey')
