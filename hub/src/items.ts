// run_items (04 §1): every body is redacted before it is written (§触6.4). 04's sizes: a tool's args and result are
// cut to 2 KB (UTF-8 bytes) each with truncated = 1 (the full request is in `requests` for 7 days); any other body over
// 16 KB goes to a blob with its first 2 KB left in body_json. The change_log triggers carry the rows to clients.
import type { Db } from "./db/db.ts";
import { putBlob } from "./blobs.ts";
import { redactDeep } from "./tools/redact.ts";

const BIG = 16 * 1024, CUT = 2048;

function cut(v: unknown): { v: unknown; cut: boolean } {
  const s = typeof v === "string" ? v : JSON.stringify(v ?? null);
  const b = Buffer.from(s, "utf8");
  if (b.length <= CUT) return { v, cut: false };
  return { v: b.subarray(0, CUT).toString("utf8").replace(/�$/, "") + "…", cut: true };
}

function body(blobs: string, kind: string, v: unknown): { json: string; ref: string | null; truncated: number } {
  const red = redactDeep(v) as Record<string, unknown>;
  if (kind === "tool" && red && typeof red === "object") {
    const a = cut(red.args), r = cut(red.result);
    return { json: JSON.stringify({ ...red, args: a.v, ...("result" in red ? { result: r.v } : {}) }), ref: null, truncated: a.cut || r.cut ? 1 : 0 };
  }
  const json = JSON.stringify(red);
  if (Buffer.byteLength(json) <= BIG) return { json, ref: null, truncated: 0 };
  return { json: JSON.stringify({ preview: json.slice(0, CUT) }), ref: putBlob(blobs, json), truncated: 0 };
}

export interface ItemStart { lane: string; run_id: string; kind: "assistant" | "tool" | "notice"; name?: string; call_id?: string; body: unknown; status?: "running" | "done" | "error" }

export function itemStart(db: Db, blobs: string, o: ItemStart): number {
  const b = body(blobs, o.kind, o.body), now = Date.now(), status = o.status ?? "running";
  return Number(db.run(
    "INSERT INTO run_items(lane, run_id, kind, status, ts, ended, name, call_id, body_json, body_ref, truncated) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
    o.lane, o.run_id, o.kind, status, now, status === "running" ? null : now, o.name ?? null, o.call_id ?? null, b.json, b.ref, b.truncated,
  ).lastInsertRowid);
}

export function itemEnd(db: Db, blobs: string, id: number, status: "done" | "error", v: unknown) {
  const kind = db.one<{ kind: string }>("SELECT kind FROM run_items WHERE id = ?", id)?.kind ?? "tool";
  const b = body(blobs, kind, v);
  db.run("UPDATE run_items SET status = ?, ended = ?, body_json = ?, body_ref = ?, truncated = ? WHERE id = ?", status, Date.now(), b.json, b.ref, b.truncated, id);
}
