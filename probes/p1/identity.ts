// Device identity (06): Ed25519, device_id = hex(sha256(public key)); signatures are domain-separated
// and bound to this Noise channel's handshake hash, so a captured auth frame is useless elsewhere.
import { ed25519 } from "@noble/curves/ed25519.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { concat } from "./noise/symmetric-state.ts";

const AUTH = new TextEncoder().encode("sbot-auth/1");
const PAIR = new TextEncoder().encode("sbot-pair/1");

export type Identity = { secretKey: Uint8Array; publicKey: Uint8Array };
export const newIdentity = (): Identity => ed25519.keygen();
export const deviceId = (pk: Uint8Array) => Buffer.from(sha256(pk)).toString("hex");
export const b64u = (b: Uint8Array) => Buffer.from(b).toString("base64url");
export const fromB64u = (s: string) => new Uint8Array(Buffer.from(s, "base64url"));

function message(purpose: "auth" | "pair", handshakeHash: Uint8Array, challenge: Uint8Array): Uint8Array {
  return concat(purpose === "auth" ? AUTH : PAIR, handshakeHash, challenge);
}

export function sign(id: Identity, purpose: "auth" | "pair", handshakeHash: Uint8Array, challenge: Uint8Array): string {
  return b64u(ed25519.sign(message(purpose, handshakeHash, challenge), id.secretKey));
}

export function verify(pk: Uint8Array, purpose: "auth" | "pair", handshakeHash: Uint8Array, challenge: Uint8Array, sig: string): boolean {
  try {
    return ed25519.verify(fromB64u(sig), message(purpose, handshakeHash, challenge), pk);
  } catch {
    return false;
  }
}
