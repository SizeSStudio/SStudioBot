// What a device and the hub's link must agree on beyond the frames (docs/tech/06 「设备密钥」「认证」「配对」): the pairing
// code, the bytes a device signs, the encodings. Imports nothing (like fragment.ts), so the Electron main process,
// the app and the hub can all use it without pulling in a library.
//
//   pairing code  sstudiobot://pair#v1.<base64url(JSON { v: 1, hub_pk, relay, secret, role, exp })>
//                 hub_pk: X25519 static key, 32 bytes base64url; secret: 32 bytes base64url; exp: ms
//   hub hello     { v, challenge: 32 random bytes base64url, hub_time } (Noise message 2, 02)
//   signature     Ed25519 over  "sbot-auth/1" | "sbot-pair/1"  ‖  handshake hash (32)  ‖  challenge (32); base64url
//   device_id     hex(sha256(Ed25519 public key, 32 bytes)) (04 devices)
//   auth failure  the hub CLOSEs the session with reason "auth" and never says which step failed

export const PAIR_LINK_PREFIX = "sstudiobot://pair#";
export const PAIR_CODE_VERSION = 1;
export const KEY_BYTES = 32;
export const CHALLENGE_BYTES = 32;
export const SIG_PREFIX = { auth: "sbot-auth/1", pair: "sbot-pair/1" } as const;
export type SigPurpose = keyof typeof SIG_PREFIX;
/** CLOSE reason the hub sends when auth or pair fails (06 「认证」 4); the relay passes it to the device's WS close. */
export const AUTH_CLOSE_REASON = "auth";

export type Role = "client" | "node";
export type PairCode = { v: 1; hub_pk: string; relay: string; secret: string; role: Role; exp: number };
export type PairParse = { ok: true; code: PairCode } | { ok: false; error: PairError };
/** Which part of the code was wrong; clients turn it into a sentence. */
export type PairError = "format" | "json" | "version" | "hub_pk" | "secret" | "role" | "expired" | "relay";

const B64U = /^[A-Za-z0-9_-]*$/;
const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

export function b64uEncode(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const n = (bytes[i]! << 16) | ((bytes[i + 1] ?? 0) << 8) | (bytes[i + 2] ?? 0);
    out += B64[(n >> 18) & 63]! + B64[(n >> 12) & 63]!;
    if (i + 1 < bytes.length) out += B64[(n >> 6) & 63]!;
    if (i + 2 < bytes.length) out += B64[n & 63]!;
  }
  return out;
}

/** Throws on anything that isn't canonical unpadded base64url. */
export function b64uDecode(s: string): Uint8Array {
  if (!B64U.test(s) || s.length % 4 === 1) throw new Error("bad base64url");
  const out = new Uint8Array(Math.floor((s.length * 3) / 4));
  let o = 0;
  for (let i = 0; i < s.length; i += 4) {
    const c = [0, 1, 2, 3].map((k) => (i + k < s.length ? B64.indexOf(s[i + k]!) : 0));
    const n = (c[0]! << 18) | (c[1]! << 12) | (c[2]! << 6) | c[3]!;
    out[o++] = (n >> 16) & 255;
    if (i + 2 < s.length) out[o++] = (n >> 8) & 255;
    if (i + 3 < s.length) out[o++] = n & 255;
  }
  if (b64uEncode(out) !== s) throw new Error("bad base64url"); // non-zero padding bits: two strings, one key
  return out;
}

const bytesOf = (s: unknown, n: number): boolean => {
  if (typeof s !== "string") return false;
  try { return b64uDecode(s).length === n; } catch { return false; }
};

/** The relay URL goes into the desktop CSP's connect-src, so it is held to wss and a plain host name. */
function cleanRelay(s: unknown): string | null {
  if (typeof s !== "string" || s.length > 300) return null;
  let u: URL;
  try { u = new URL(s); } catch { return null; }
  if (u.protocol !== "wss:" || u.username || u.password || u.search || u.hash) return null;
  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/i.test(u.hostname)) return null;
  return `wss://${u.host}${u.pathname.replace(/\/+$/, "")}`;
}

/** Accepts the whole link or just the `v1.…` part (pasted from a chat that can't open custom schemes, 06). */
export function parsePairCode(input: string, now = Date.now()): PairParse {
  const m = /^(?:sstudiobot:\/\/pair#)?v1\.([A-Za-z0-9_-]+)$/.exec(input.trim());
  if (!m) return { ok: false, error: "format" };
  let o: Record<string, unknown>;
  try {
    const v: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(b64uDecode(m[1]!)));
    if (typeof v !== "object" || v === null || Array.isArray(v)) return { ok: false, error: "json" };
    o = v as Record<string, unknown>;
  } catch { return { ok: false, error: "json" }; }
  if (o.v !== PAIR_CODE_VERSION) return { ok: false, error: "version" };
  if (!bytesOf(o.hub_pk, KEY_BYTES)) return { ok: false, error: "hub_pk" };
  if (!bytesOf(o.secret, KEY_BYTES)) return { ok: false, error: "secret" };
  if (o.role !== "client" && o.role !== "node") return { ok: false, error: "role" };
  const relay = cleanRelay(o.relay);
  if (!relay) return { ok: false, error: "relay" };
  if (typeof o.exp !== "number" || !Number.isFinite(o.exp) || o.exp < now) return { ok: false, error: "expired" };
  return { ok: true, code: { v: 1, hub_pk: o.hub_pk as string, relay, secret: o.secret as string, role: o.role, exp: o.exp } };
}

export function makePairCode(c: PairCode): string {
  return `${PAIR_LINK_PREFIX}v1.${b64uEncode(new TextEncoder().encode(JSON.stringify(c)))}`;
}

/** `<relay>/v1/peer?hub=<hub_pk>`: where a device or node opens its WS (06 「端点」). */
export const peerUrl = (relay: string, hubPk: string): string => `${relay}/v1/peer?hub=${hubPk}`;

/** The exact bytes a device signs (06): domain prefix ‖ handshake hash ‖ challenge. Throws on wrong lengths. */
export function signedMessage(purpose: SigPurpose, handshakeHash: Uint8Array, challenge: Uint8Array): Uint8Array {
  if (handshakeHash.length !== 32) throw new Error("handshake hash must be 32 bytes");
  if (challenge.length !== CHALLENGE_BYTES) throw new Error(`challenge must be ${CHALLENGE_BYTES} bytes`);
  const prefix = new TextEncoder().encode(SIG_PREFIX[purpose]);
  const out = new Uint8Array(prefix.length + 32 + CHALLENGE_BYTES);
  out.set(prefix, 0);
  out.set(handshakeHash, prefix.length);
  out.set(challenge, prefix.length + 32);
  return out;
}
