// ChaCha20-Poly1305 through the node:crypto API. react-native-quick-crypto exposes the same calls in
// native code, so this is also the shape of the Hermes backend (P1). OpenSSL checks the tag in constant time.
import { createCipheriv, createDecipheriv } from "node:crypto";
import type { Aead } from "./cipher-state.ts";

const TAG = 16;

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
    d.final(); // throws on a bad tag
    return new Uint8Array(body);
  },
};
