// The two primitives that move to native code per platform (02, P1: noble on Hermes is too slow for the AEAD).
// The state machine never touches a library directly; it asks for the current backend here.
//   hub, node:            node-crypto.ts (node:crypto, OpenSSL)
//   Android (Hermes):     react-native-quick-crypto, same calls as node:crypto (clients/, W2)
//   web, Electron render: noble, the default below
import { chacha20poly1305 } from "@noble/ciphers/chacha.js";
import { x25519 } from "@noble/curves/ed25519.js";

/** ChaCha20-Poly1305, 32-byte key, 12-byte nonce, 16-byte tag appended. `open` throws on a bad tag. */
export type Aead = {
  seal(key: Uint8Array, nonce: Uint8Array, ad: Uint8Array, plaintext: Uint8Array): Uint8Array;
  open(key: Uint8Array, nonce: Uint8Array, ad: Uint8Array, ciphertext: Uint8Array): Uint8Array;
};

export type NoiseKeyPair = { publicKey: Uint8Array; secretKey: Uint8Array };

/** X25519. `dh` throws on a public key it rejects; the caller also rejects an all-zero result (low-order point). */
export type Dh = {
  generateKeyPair(): NoiseKeyPair;
  publicKey(secretKey: Uint8Array): Uint8Array;
  dh(secretKey: Uint8Array, publicKey: Uint8Array): Uint8Array;
};

// noble compares the Poly1305 tag in constant time.
export const nobleAead: Aead = {
  seal: (k, n, ad, pt) => chacha20poly1305(k, n, ad).encrypt(pt),
  open: (k, n, ad, ct) => chacha20poly1305(k, n, ad).decrypt(ct),
};

export const nobleDh: Dh = {
  generateKeyPair() {
    const secretKey = x25519.utils.randomSecretKey();
    return { secretKey, publicKey: x25519.getPublicKey(secretKey) };
  },
  publicKey: (sk) => x25519.getPublicKey(sk),
  dh: (sk, pk) => x25519.getSharedSecret(sk, pk),
};

let backend: { aead: Aead; dh: Dh } = { aead: nobleAead, dh: nobleDh };

/** Process-wide; call once at startup, before the first handshake. Channels already open keep working only if
 *  both backends are byte-compatible, which every conforming one is (the vectors check that). */
export function useCrypto(impl: { aead?: Aead; dh?: Dh }): void {
  backend = { aead: impl.aead ?? backend.aead, dh: impl.dh ?? backend.dh };
}

export const aead = (): Aead => backend.aead;
export const dh = (): Dh => backend.dh;
