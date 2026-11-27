// Adapted from Paseo (https://github.com/getpaseo/paseo, packages/relay/src/noise/cipher-state.ts).
// Copyright (c) 2025-present Mohamed Boudra. Licensed under the Apache License, Version 2.0.
// Modified for SStudioBot: a failed decrypt kills the state (02: one failure closes the channel);
// a cleared state throws instead of passing plaintext through; the AEAD is swappable (P1: Hermes needs a
// native one). See NOTICE.md.
import { chacha20poly1305 } from "@noble/ciphers/chacha.js";

/** ChaCha20-Poly1305 with a 12-byte nonce; `open` throws on a bad tag. */
export type Aead = {
  seal(key: Uint8Array, nonce: Uint8Array, ad: Uint8Array, plaintext: Uint8Array): Uint8Array;
  open(key: Uint8Array, nonce: Uint8Array, ad: Uint8Array, ciphertext: Uint8Array): Uint8Array;
};

// noble compares the Poly1305 tag in constant time.
export const nobleAead: Aead = {
  seal: (k, n, ad, pt) => chacha20poly1305(k, n, ad).encrypt(pt),
  open: (k, n, ad, ct) => chacha20poly1305(k, n, ad).decrypt(ct),
};

let aead: Aead = nobleAead;
/** Process-wide; set once at startup, before any handshake. */
export function useAead(impl: Aead): void {
  aead = impl;
}

/** Noise spec §5.1 CipherState for ChaChaPoly. Nonce is 4 zero bytes then 64-bit little-endian n. */

export const NOISE_TAG_BYTES = 16;
export const NOISE_MAX_MESSAGE_BYTES = 65535;
const MAX_NONCE = (1n << 64n) - 1n;

export class NoiseProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NoiseProtocolError";
  }
}

export class CipherState {
  private k: Uint8Array | null = null;
  private n = 0n;
  // Once dead, every call throws: a null key must never mean "pass through" after split or failure.
  private dead = false;

  initializeKey(key: Uint8Array | null, nonce = 0n): void {
    if (this.dead) throw new NoiseProtocolError("cipher state cleared");
    this.k = key;
    this.n = nonce;
  }

  hasKey(): boolean {
    return this.k !== null;
  }

  nonce(): bigint {
    return this.n;
  }

  encryptWithAd(ad: Uint8Array, plaintext: Uint8Array): Uint8Array {
    if (this.dead) throw new NoiseProtocolError("cipher state cleared");
    if (this.k === null) return plaintext; // handshake before the first DH, per spec
    if (this.n === MAX_NONCE) throw new NoiseProtocolError("nonce exhausted");
    const nonce = encodeNonce(this.n);
    this.n += 1n; // reserve before encrypting so two senders can never share a nonce
    return aead.seal(this.k, nonce, ad, plaintext);
  }

  decryptWithAd(ad: Uint8Array, ciphertext: Uint8Array): Uint8Array {
    if (this.dead) throw new NoiseProtocolError("cipher state cleared");
    if (this.k === null) return ciphertext;
    if (this.n === MAX_NONCE) throw new NoiseProtocolError("nonce exhausted");
    let plaintext: Uint8Array;
    try {
      plaintext = aead.open(this.k, encodeNonce(this.n), ad, ciphertext);
    } catch {
      this.clear();
      throw new NoiseProtocolError("authentication failed");
    }
    this.n += 1n;
    return plaintext;
  }

  clear(): void {
    this.k?.fill(0);
    this.k = null;
    this.n = MAX_NONCE;
    this.dead = true;
  }
}

function encodeNonce(n: bigint): Uint8Array {
  const nonce = new Uint8Array(12);
  let value = n;
  for (let i = 4; i < 12; i += 1) {
    nonce[i] = Number(value & 0xffn);
    value >>= 8n;
  }
  return nonce;
}
