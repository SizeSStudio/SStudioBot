// The hub's X25519 static key (docs/tech/06 「主的密钥」): made on first start in $SBOT_HOME/keys/hub.key (0600),
// treated like secrets.env — never printed, never logged, never in an agent's environment. It travels with the
// encrypted backup (keys/ is in it), so moving the hub needs no re-pairing. No rotation in v1 ※.
// File format: one line `x25519:<base64url secret>`; the public key is derived, so the two can't disagree.
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { dh, type NoiseKeyPair } from "../../../protocol/noise/crypto.ts";
import { b64u, fingerprintOf, fromB64u } from "../../../protocol/pair.ts";
import { log } from "../log.ts";

export type HubKey = NoiseKeyPair & { publicB64u: string; fingerprint: string };

export const hubKeyPath = (keysDir: string) => join(keysDir, "hub.key");

const keyOf = (secretKey: Uint8Array): HubKey => {
  const publicKey = dh().publicKey(secretKey);
  return { secretKey, publicKey, publicB64u: b64u(publicKey), fingerprint: fingerprintOf(publicKey) };
};

/** Reads hub.key, or makes it the first time. Errors name the file, never its content. */
export function loadOrCreateHubKey(keysDir: string): HubKey {
  const f = hubKeyPath(keysDir);
  mkdirSync(keysDir, { recursive: true, mode: 0o700 });
  if (!existsSync(f)) {
    const kp = dh().generateKeyPair();
    // wx: never overwrite a key another process just wrote (that would orphan every paired device)
    writeFileSync(f, `x25519:${b64u(kp.secretKey)}\n`, { mode: 0o600, flag: "wx" });
    log("link", "made the hub key", { file: "keys/hub.key" });
  }
  if (process.platform !== "win32" && (statSync(f).mode & 0o077)) {
    chmodSync(f, 0o600);
    log("link", "hub.key was readable by others; set it back to 0600", {});
  }
  const m = /^x25519:([A-Za-z0-9_-]{43})\s*$/.exec(readFileSync(f, "utf8"));
  if (!m) throw new Error("keys/hub.key is not in the expected format (x25519:<base64url>)");
  return keyOf(fromB64u(m[1]!));
}

/** 06: `sbot status` shows the first 8 groups of the fingerprint, enough to compare by eye. */
export const shortFingerprint = (hex: string) => (hex.match(/.{4}/g) ?? []).slice(0, 8).join(" ");
