// Pairing code, device id and the bytes a device signs (docs/tech/06 「设备密钥」「认证」「配对」). Shared by the hub,
// node/ and clients/, so no Node-only APIs: base64url goes through btoa/atob (Hermes has them, it has no Buffer).
import { z } from "zod";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";

// Domain separation: a signature made for one purpose can never be replayed as the other, and both bind the
// handshake hash, so a signature lifted off one Noise channel is worthless on another (06).
export const AUTH_PREFIX = "sbot-auth/1";
export const PAIR_PREFIX = "sbot-pair/1";

const te = new TextEncoder();

/** prefix || handshake hash || challenge — what the device's Ed25519 key signs. */
export function signedBytes(prefix: typeof AUTH_PREFIX | typeof PAIR_PREFIX, handshakeHash: Uint8Array, challenge: Uint8Array): Uint8Array {
  const p = te.encode(prefix);
  const out = new Uint8Array(p.length + handshakeHash.length + challenge.length);
  out.set(p, 0);
  out.set(handshakeHash, p.length);
  out.set(challenge, p.length + handshakeHash.length);
  return out;
}

export function b64u(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Strict: only the base64url alphabet, no padding, and it must round-trip (no sloppy trailing bits). */
export function fromB64u(text: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]*$/.test(text) || text.length % 4 === 1) throw new Error("bad base64url");
  const bin = atob(text.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (text.length % 4)) % 4));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  if (b64u(out) !== text) throw new Error("bad base64url");
  return out;
}

/** 06: device_id = hex(sha256(32-byte Ed25519 public key)). Always 64 hex chars, so never the reserved `cli`. */
export const deviceIdOf = (publicKey: Uint8Array): string => bytesToHex(sha256(publicKey));

/** The hub key fingerprint `sbot status` shows: hex sha256 of the X25519 public key. */
export const fingerprintOf = (hubPublicKey: Uint8Array): string => bytesToHex(sha256(hubPublicKey));

const key32 = z.string().regex(/^[A-Za-z0-9_-]{43}$/);   // 32 bytes in base64url

export const PairCode = z.object({
  v: z.literal(1),
  hub_pk: key32,                                 // the trust anchor: the hub's X25519 static key
  relay: z.string().regex(/^wss?:\/\/\S+$/),     // the relay's peer endpoint; the client adds ?hub=<hub_pk>
  secret: key32,                                 // one-time, 32 random bytes; the hub keeps only sha256 of it
  role: z.enum(["client", "node"]),
  exp: z.number().int(),                         // ms epoch; the hub's own clock decides, this is for the UI
});
export type PairCode = z.infer<typeof PairCode>;

export const PAIR_LINK_PREFIX = "sstudiobot://pair#";

/** sstudiobot://pair#v1.<base64url(JSON)>. Everything after `#` is never sent to a server by a browser. */
export function encodePairLink(c: PairCode): string {
  return `${PAIR_LINK_PREFIX}${encodePairCode(c)}`;
}
export const encodePairCode = (c: PairCode): string => `v1.${b64u(te.encode(JSON.stringify(PairCode.parse(c))))}`;

/** Takes the whole link or just the `v1.` code (the App's paste box accepts both, 06). Throws on anything else. */
export function decodePairCode(text: string): PairCode {
  let t = text.trim();
  if (t.startsWith(PAIR_LINK_PREFIX)) t = t.slice(PAIR_LINK_PREFIX.length);
  if (!t.startsWith("v1.")) throw new Error("not a v1 pairing code");
  return PairCode.parse(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(fromB64u(t.slice(3)))));
}
