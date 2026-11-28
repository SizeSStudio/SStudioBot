// Writing to the inbox (03 「inbox 和 run」): channel and API handlers only do "write a row, commit, acknowledge" —
// a channel callback must answer within seconds, so nothing else happens here. The dispatcher (dispatch.ts) picks
// rows up; a kick just saves it waiting for its next tick.
import type { Db } from "./db/db.ts";
import type { TurnContext } from "./turn.ts";

export type InboxKind = "user" | "command" | "card" | "timer" | "system" | "approval" | "task";

export interface Ingest {
  lane: string;
  kind: InboxKind;
  source: string;                 // feishu | client | card | timer | job | approval | task | …
  source_msg_id: string;          // dedupe key, shapes in 04 §1
  payload: { text?: string; ts?: number; owner?: boolean; job?: string; tier?: string; [k: string]: unknown };
  turn?: TurnContext;
  device_id?: string;             // a client device: what I typed there is ownerTyped
  not_before?: number;
  ts?: number;
}

let kick: () => void = () => {};
/** The dispatcher registers itself here (dispatch.ts). */
export function setKick(fn: () => void) { kick = fn; }

/**
 * One input. The same (source, source_msg_id) is written once: channels redeliver, the second call is a no-op and says
 * so. `payload.owner = true` is the channel's statement that the sender is my id (people.yaml) — set it only then.
 */
export function ingest(db: Db, o: Ingest): { id: number; dup: boolean } {
  const r = db.run(
    `INSERT OR IGNORE INTO inbox(lane, kind, source, source_msg_id, turn_ctx_json, payload_json, device_id, not_before, ts)
     VALUES (?,?,?,?,?,?,?,?,?)`,
    o.lane, o.kind, o.source, o.source_msg_id, o.turn ? JSON.stringify(o.turn) : null, JSON.stringify(o.payload),
    o.device_id ?? null, o.not_before ?? null, o.ts ?? Date.now(),
  );
  if (Number(r.changes) === 0) {
    const hit = db.one<{ id: number }>("SELECT id FROM inbox WHERE source = ? AND source_msg_id = ?", o.source, o.source_msg_id)!;
    return { id: hit.id, dup: true };
  }
  queueMicrotask(() => { try { kick(); } catch { /* the dispatcher's tick picks it up anyway */ } });
  return { id: Number(r.lastInsertRowid), dup: false };
}

/**
 * The sender took a message back (03 撤回): not yet handled → dropped; being handled → the dispatcher treats it as
 * a stop for that run. Returns what it found so the caller can say so.
 */
export function withdraw(db: Db, source: string, source_msg_id: string): { id?: number; was?: string } {
  return db.tx(() => {
    const r = db.one<{ id: number; status: string }>("SELECT id, status FROM inbox WHERE source = ? AND source_msg_id = ?", source, source_msg_id);
    if (!r) return {};
    if (r.status === "received") db.run("UPDATE inbox SET status = 'dropped' WHERE id = ?", r.id);
    if (r.status === "processing") db.run("UPDATE inbox SET payload_json = json_set(COALESCE(payload_json, '{}'), '$.withdrawn', 1) WHERE id = ?", r.id);
    queueMicrotask(() => { try { kick(); } catch { /* next tick */ } });
    return { id: r.id, was: r.status };
  });
}
