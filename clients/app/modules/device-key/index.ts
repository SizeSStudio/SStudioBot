// The Android device-key module (06 「设备密钥」, P4). Kotlin in android/; JS sees only these calls. Strings are base64url.
import { requireNativeModule } from 'expo-modules-core'

export type KeyInfo = { sdk: number; strongbox: boolean }

export interface DeviceKeyNative {
  /** Keystore Ed25519 (API ≥ 33 and the KeyMint supports it): the public key, generating it once; null = not here */
  hardwarePublicKey(): Promise<string | null>
  /** sign with the Keystore Ed25519 key */
  hardwareSign(message: string): Promise<string>
  /** the software key's 32-byte seed, unwrapped with the Keystore AES-GCM key; null = none stored */
  loadWrapped(): Promise<string | null>
  /** wrap a fresh seed with a non-exportable Keystore AES-GCM key and keep the ciphertext in the app's private dir */
  storeWrapped(seed: string): Promise<void>
  /** pairing info (hub key, relay, device id; no secrets) in the app's private SharedPreferences */
  getPairing(): Promise<string | null>
  setPairing(json: string | null): Promise<void>
  info(): Promise<KeyInfo>
}

export default requireNativeModule<DeviceKeyNative>('DeviceKey')
