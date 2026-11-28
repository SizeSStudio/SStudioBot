// Invites and pairing (docs/tech/06 「配对」, 04 §5 device_invites). Holding a code is the authorisation, so the
// secret is treated as a password: only sha256(secret) is stored, it lasts 10 minutes and works once.
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { Db } from "../db/db.ts";
import { b64u, deviceIdOf, encodePairCode, PAIR_LINK_PREFIX } from "../../../protocol/pair.ts";
import type { InviteRes } from "../../../protocol/api/devices.ts";
import { audit, type Actor } from "./devices.ts";

export const INVITE_MS = 10 * 60_000;
export type Role = "client" | "node";

const sha = (b: Uint8Array) => createHash("sha256").update(b).digest();

/**
 * One invite → the pairing code. `relayUrl` is the relay's peer endpoint (wss://…/v1/peer); `hubPk` the hub's
 * public key in base64url. The secret exists only in the return value: it is never logged or stored.
 */
export function createInvite(db: Db, o: { role: Role; created_by: Actor; hubPk: string; relayUrl: string; relayEnabled: boolean; now?: number }): InviteRes {
  const now = o.now ?? Date.now();
  const secret = new Uint8Array(randomBytes(32));
  const expires = now + INVITE_MS;
  db.tx(() => {
    const id = Number(db.run("INSERT INTO device_invites(secret_hash, role, created_by, created_at, expires) VALUES (?,?,?,?,?)",
      sha(secret), o.role, o.created_by, now, expires).lastInsertRowid);
    audit(db, { action: "invite", actor: o.created_by, detail: JSON.stringify({ invite: id, role: o.role }) });
  });
  const code = encodePairCode({ v: 1, hub_pk: o.hubPk, relay: o.relayUrl, secret: b64u(secret), role: o.role, exp: expires });
  return { link: PAIR_LINK_PREFIX + code, code, expires, relay_enabled: o.relayEnabled };
}

export type Paired = { id: string; role: Role; name: string; platform: string };

/**
 * 06: in one transaction — the secret's hash compared in constant time against every live invite, not used, not
 * expired, the role matches what the device said in its handshake, the key isn't already known — then the invite is
 * marked used, the device written, the pairing audited. Any failure is one undifferentiated `undefined` (the caller
 * sends CLOSE "auth"), and is audited as pair_failed without the secret. The caller has already checked the
 * signature, so the device holds the private key of `publicKey`.
 */
export function redeemInvite(db: Db, o: { secret: Uint8Array; publicKey: Uint8Array; role: Role; name: string; platform: string; ipMasked: string; now?: number }): Paired | undefined {
  const now = o.now ?? Date.now();
  const want = sha(o.secret);
  const id = deviceIdOf(o.publicKey);
  return db.tx(() => {
    // walk every candidate without stopping early, so timing doesn't say which (or whether one) matched
    let hit: { id: number; role: string } | undefined;
    for (const inv of db.all<{ id: number; secret_hash: Uint8Array; role: string }>(
      "SELECT id, secret_hash, role FROM device_invites WHERE used_at IS NULL AND expires > ?", now)) {
      if (inv.secret_hash.length === want.length && timingSafeEqual(inv.secret_hash, want) && !hit) hit = inv;
    }
    // a key seen before (even a removed one) can only be a replay: every pairing makes a fresh key (04 §5)
    const known = db.one("SELECT 1 FROM devices WHERE id = ? OR public_key = ?", id, o.publicKey);
    if (!hit || hit.role !== o.role || known || o.publicKey.length !== 32) {
      audit(db, { device_id: known ? id : null, action: "pair_failed", actor: "code", ip_masked: o.ipMasked });
      return undefined;
    }
    // used_at IS NULL again in the UPDATE: belt and braces against a second redeem in the same instant
    if (!Number(db.run("UPDATE device_invites SET used_at = ?, used_by = ? WHERE id = ? AND used_at IS NULL", now, id, hit.id).changes)) return undefined;
    db.run(`INSERT INTO devices(id, public_key, name, platform, role, invite_id, created_at, last_seen, last_ip_masked)
            VALUES (?,?,?,?,?,?,?,?,?)`, id, o.publicKey, o.name, o.platform, o.role, hit.id, now, now, o.ipMasked);
    audit(db, { device_id: id, action: "pair", actor: "code", ip_masked: o.ipMasked, detail: JSON.stringify({ invite: hit.id, role: o.role }) });
    db.emit("device", id);
    return { id, role: o.role, name: o.name, platform: o.platform };
  });
}
