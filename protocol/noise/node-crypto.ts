// node:crypto backend for the hub and nodes (02 ※: same interface, OpenSSL, ~5× noble). react-native-quick-crypto
// exposes the same calls in native code, so this file is also the shape of the Android backend.
// Node only: clients never import it (it would drag node:crypto into the bundle).
import { createCipheriv, createDecipheriv, createPrivateKey, createPublicKey, diffieHellman, generateKeyPairSync } from "node:crypto";
import type { Aead, Dh } from "./crypto.ts";

const TAG = 16;

// OpenSSL checks the tag in constant time; `final()` throws on a mismatch, and the plaintext from `update()` is
// never returned in that case.
export const nodeAead: Aead = {
  seal(key, nonce, ad, plaintext) {
    const c = createCipheriv("chacha20-poly1305", key, nonce, { authTagLength: TAG });
    c.setAAD(ad, { plaintextLength: plaintext.byteLength });
    const body = c.update(plaintext);
    c.final();
    return new Uint8Array(Buffer.concat([body, c.getAuthTag()]));
  },
  open(key, nonce, ad, ciphertext) {
    if (ciphertext.byteLength < TAG) throw new Error("short ciphertext");
    const d = createDecipheriv("chacha20-poly1305", key, nonce, { authTagLength: TAG });
    d.setAAD(ad, { plaintextLength: ciphertext.byteLength - TAG });
    d.setAuthTag(ciphertext.subarray(ciphertext.byteLength - TAG));
    const body = d.update(ciphertext.subarray(0, ciphertext.byteLength - TAG));
    d.final();
    return new Uint8Array(body);
  },
};

// Raw 32-byte X25519 keys wrapped in fixed DER headers (RFC 8410), so no JWK base64 round trip.
const PKCS8 = Buffer.from("302e020100300506032b656e04220420", "hex");
const SPKI = Buffer.from("302a300506032b656e032100", "hex");
const priv = (sk: Uint8Array) => {
  if (sk.byteLength !== 32) throw new Error("X25519 secret key must be 32 bytes");
  return createPrivateKey({ key: Buffer.concat([PKCS8, sk]), format: "der", type: "pkcs8" });
};
const pub = (pk: Uint8Array) => {
  if (pk.byteLength !== 32) throw new Error("X25519 public key must be 32 bytes");
  return createPublicKey({ key: Buffer.concat([SPKI, pk]), format: "der", type: "spki" });
};
const rawPublic = (k: ReturnType<typeof createPublicKey>) => new Uint8Array(k.export({ format: "der", type: "spki" }).subarray(SPKI.length));

export const nodeDh: Dh = {
  generateKeyPair() {
    const { privateKey, publicKey } = generateKeyPairSync("x25519");
    const der = privateKey.export({ format: "der", type: "pkcs8" });
    return { secretKey: new Uint8Array(der.subarray(PKCS8.length)), publicKey: rawPublic(publicKey) };
  },
  publicKey: (sk) => rawPublic(createPublicKey(priv(sk))),
  // OpenSSL refuses a low-order peer key (all-zero result); the handshake checks for zero again either way.
  dh: (sk, pk) => new Uint8Array(diffieHellman({ privateKey: priv(sk), publicKey: pub(pk) })),
};
