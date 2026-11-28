// devices and device_audit (docs/tech/06 「设备管理」, 04 §5). List, rename, remove; the lookups auth needs.
// The API dispatcher (W2b), `sbot devices` and Feishu /devices all call these, so the rules live in one place.
import type { Db } from "../db/db.ts";

/** Who did it, as device_audit.actor and devices.removed_by record it. */
export type Actor = string;   // cli | device:<id> | channel:feishu | code
export const actorOf = (device: string) => (device === "cli" ? "cli" : `device:${device}`);

export function audit(db: Db, a: { device_id?: string | null; action: string; actor: Actor; ip_masked?: string | null; detail?: string }) {
  db.run("INSERT INTO device_audit(ts, device_id, action, actor, ip_masked, detail) VALUES (?,?,?,?,?,?)",
    Date.now(), a.device_id ?? null, a.action, a.actor, a.ip_masked ?? null, a.detail ?? null);
}

type DeviceRow = { id: string; name: string; platform: string | null; role: "client" | "node"; version: string | null;
  created_at: number; last_seen: number | null; last_ip_masked: string | null };

/** For the Feishu /devices text (the API's list is W2b's view, api/views.ts deviceView). */
export type DeviceLine = DeviceRow & { online: boolean };

export function listDevices(db: Db, online: (id: string) => boolean = () => false): DeviceLine[] {
  return db.all<DeviceRow>(`SELECT id, name, platform, role, version, created_at, last_seen, last_ip_masked FROM devices
                            WHERE removed_at IS NULL ORDER BY created_at`).map((d) => ({ ...d, online: online(d.id) }));
}

/** 06: commands take a unique prefix of ≥ 6 hex chars. Hex only, so nothing in it can act as a LIKE wildcard. */
export function resolveDevice(db: Db, prefix: string): { id: string } | { error: string } {
  const p = prefix.trim().toLowerCase();
  if (!/^[0-9a-f]{6,64}$/.test(p)) return { error: "设备 id 至少给 6 位（十六进制）" };
  const hits = db.all<{ id: string }>("SELECT id FROM devices WHERE removed_at IS NULL AND id LIKE ? LIMIT 2", `${p}%`);
  if (!hits.length) return { error: `没有 ${p} 开头的设备` };
  if (hits.length > 1) return { error: `${p} 开头的不止一台，多给几位` };
  return { id: hits[0]!.id };
}

export function renameDevice(db: Db, id: string, name: string, actor: Actor): boolean {
  return db.tx(() => {
    const old = db.one<{ name: string }>("SELECT name FROM devices WHERE id = ? AND removed_at IS NULL", id);
    if (!old) return false;
    db.run("UPDATE devices SET name = ? WHERE id = ?", name, id);
    audit(db, { device_id: id, action: "rename", actor, detail: JSON.stringify({ from: old.name, to: name }) });
    db.emit("device", id);
    return true;
  });
}

/** What removal does outside the DB, right after the transaction commits. */
export type RemoveFollow = {
  dropChannels(deviceId: string): number;   // close its channels now; returns how many
  stopRun(runId: string, lane: string): void;
};

/**
 * 06 「删立刻生效」: one transaction, then the follow-ups, all synchronous, so it is done well inside 1 s:
 * removed_at/removed_by + push_token cleared + audit; its queued inputs → dropped; its running runs stopped;
 * its channels closed. A removed device that comes back fails auth; to use it again it pairs as a new device.
 */
export function removeDevice(db: Db, id: string, actor: Actor, follow: RemoveFollow) {
  const done = db.tx(() => {
    const d = db.one<{ name: string; role: string; push_token: string | null }>("SELECT name, role, push_token FROM devices WHERE id = ? AND removed_at IS NULL", id);
    if (!d) return undefined;
    db.run("UPDATE devices SET removed_at = ?, removed_by = ?, push_token = NULL WHERE id = ?", Date.now(), actor, id);
    audit(db, { device_id: id, action: "remove", actor });
    if (d.push_token) audit(db, { device_id: id, action: "token_cleared", actor });
    db.emit("device", id);
    const dropped = Number(db.run("UPDATE inbox SET status = 'dropped' WHERE device_id = ? AND status = 'received'", id).changes);
    const runs = db.all<{ id: string; lane: string }>("SELECT id, lane FROM runs WHERE device_id = ? AND status = 'running'", id);
    return { name: d.name, role: d.role, dropped, runs };
  });
  if (!done) return undefined;
  const channels = follow.dropChannels(id);
  for (const r of done.runs) follow.stopRun(r.id, r.lane);
  return { name: done.name, role: done.role, dropped: done.dropped, runs: done.runs.length, channels };
}

/** For auth: a device that exists and isn't removed. */
export function liveDevice(db: Db, id: string) {
  return db.one<{ public_key: Uint8Array; role: "client" | "node"; name: string }>(
    "SELECT public_key, role, name FROM devices WHERE id = ? AND removed_at IS NULL", id);
}

/**
 * After a good auth: last_seen and last_ip_masked (not an audit row — phones reconnect all the time, 04 §5). An IP
 * range this device has never shown is recorded as new_ip; returns true then so the caller can say so.
 */
export function touchDevice(db: Db, id: string, ipMasked: string): boolean {
  return db.tx(() => {
    db.run("UPDATE devices SET last_seen = ?, last_ip_masked = ? WHERE id = ?", Date.now(), ipMasked, id);
    const seen = db.one("SELECT 1 FROM device_audit WHERE device_id = ? AND ip_masked = ? LIMIT 1", id, ipMasked);
    if (seen) return false;
    audit(db, { device_id: id, action: "new_ip", actor: "code", ip_masked: ipMasked });
    return true;
  });
}

export const short = (id: string) => id.slice(0, 8);
