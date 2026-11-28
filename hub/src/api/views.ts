// View functions (03 「api」): the one place an entity's content is read, shared by bootstrap, GET and the event pump,
// so a client sees the same shape whichever way it arrived. Shapes are protocol/api/entities.ts. Bodies were redacted
// when they were written (items.ts); free-text columns that weren't (run errors, task errors) are redacted here.
// Text goes out as data: nothing here renders HTML or follows a link.
import { existsSync, openSync, readSync, closeSync, statSync } from "node:fs";
import { join } from "node:path";
import type { Approval, BlobRef, Device, EntityData, EntityName, Input, Item, Run, Task, Thread, TimelineEntry } from "../../../protocol/api/entities.ts";
import type { Db, Row } from "../db/db.ts";
import { redact, redactDeep } from "../tools/redact.ts";

const PREVIEW = 2048;
const str = (v: unknown): string | null => (v === null || v === undefined ? null : String(v));
const int = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));
const json = (v: unknown): unknown => {
  if (typeof v !== "string" || !v) return null;
  try { return JSON.parse(v); } catch { return null; }
};
const red = (v: unknown): string | null => (v === null || v === undefined ? null : redact(String(v)));

/** A `blob:<sha>` column as a BlobRef; null when there is none or the file is gone (GC'd). */
export function blobRef(blobs: string, ref: unknown, preview?: string): BlobRef | null {
  const m = typeof ref === "string" ? /^blob:([0-9a-f]{64})$/.exec(ref) : null;
  if (!m) return null;
  const f = join(blobs, m[1]!);
  if (!existsSync(f)) return null;
  const size = statSync(f).size;
  if (preview === undefined) {
    const buf = Buffer.alloc(Math.min(PREVIEW, size));
    const fd = openSync(f, "r");
    try { readSync(fd, buf, 0, buf.length, 0); } finally { closeSync(fd); }
    preview = redact(buf.toString("utf8").replace(/�$/, ""));
  }
  return { ref: `blob:${m[1]}`, size, preview };
}

export const threadView = (r: Row): Thread => ({
  id: String(r.id), lane: String(r.lane), kind: String(r.kind), domain: String(r.domain), title: str(r.title),
  matter_id: int(r.matter_id), task_id: str(r.task_id), status: String(r.status), pinned: Number(r.pinned) === 1,
  created_at: Number(r.created_at), last_item_at: int(r.last_item_at),
});

export function inputView(r: Row): Input {
  const p = (json(r.payload_json) ?? {}) as Record<string, unknown>;
  const owner = (r.kind === "user" || r.kind === "command") && ((typeof r.device_id === "string" && r.device_id !== "") || p.owner === true);
  return {
    id: String(r.id), lane: String(r.lane), kind: String(r.kind), source: String(r.source), status: String(r.status),
    run_id: str(r.run_id), device_id: str(r.device_id),
    text: typeof p.text === "string" ? p.text : null,
    sender_name: typeof p.sender_name === "string" ? p.sender_name : null,
    owner, ts: Number(r.ts),
  };
}

export const runView = (r: Row): Run => ({
  id: String(r.id), lane: str(r.lane), role: str(r.role), tier: str(r.tier), model: str(r.model), status: String(r.status),
  stop_reason: str(r.stop_reason), error: red(r.error), task_id: str(r.task_id), device_id: str(r.device_id),
  started: int(r.started), ended: int(r.ended),
});

/**
 * The `delta.item` a row finishes (protocol/api/stream.ts). An assistant message's deltas stream before its row
 * exists, under `<run>:a<n>`; every finished message writes exactly one row (dispatch.ts onItem), so n = how many
 * assistant rows of the run came before it. pump.ts's Live counts the same way.
 */
export const liveKeyOf = (db: Db, r: Row): string | null => {
  if (r.kind === "tool") return String(r.id);
  if (r.kind !== "assistant") return null;
  const n = Number(db.one<{ n: number }>("SELECT COUNT(*) AS n FROM run_items WHERE run_id = ? AND kind = 'assistant' AND id < ?", String(r.run_id), Number(r.id))?.n ?? 0);
  return assistantKey(String(r.run_id), n);
};
export const assistantKey = (run: string, n: number) => `${run}:a${n}`;

export function itemView(db: Db, blobs: string, r: Row): Item {
  const body = json(r.body_json);
  const preview = body && typeof body === "object" && typeof (body as { preview?: unknown }).preview === "string" ? (body as { preview: string }).preview : undefined;
  return {
    id: String(r.id), lane: String(r.lane), run_id: String(r.run_id), kind: String(r.kind), status: String(r.status),
    ts: Number(r.ts), ended: int(r.ended), name: str(r.name), call_id: str(r.call_id), body,
    blob: blobRef(blobs, r.body_ref, preview), truncated: Number(r.truncated) === 1, live_key: liveKeyOf(db, r),
  };
}

export function approvalView(db: Db, blobs: string, r: Row): Approval {
  const out = db.one<Row>("SELECT status, error, ts FROM outbox WHERE approval_id = ?", Number(r.id));
  const request = json(r.request_json);
  const reqPreview = r.request_ref ? JSON.stringify(request ?? "").slice(0, PREVIEW) : undefined;
  return {
    id: String(r.id), kind: String(r.kind), status: String(r.status), origin_lane: str(r.origin_lane), run_id: str(r.run_id),
    task_id: str(r.task_id), requester: str(r.requester), channel: str(r.channel), target: json(r.target_json),
    as_identity: str(r.as_identity), title: str(r.title), draft: str(r.draft), draft_version: Number(r.draft_version),
    request, request_blob: blobRef(blobs, r.request_ref, reqPreview), options: json(r.options_json), answer: json(r.answer_json),
    context: json(r.context_json), context_blob: blobRef(blobs, r.context_ref), refs: json(r.refs_json), checks: json(r.checks_json),
    expires_at: int(r.expires_at), decided_by: str(r.decided_by), decided_at: int(r.decided_at), decide_note: str(r.decide_note),
    final_text: str(r.final_text), result: str(r.result), matter_id: int(r.matter_id),
    delivery: out ? { status: String(out.status), error: red(out.error), ts: int(out.ts) } : null,
    ts: Number(r.ts),
  };
}

export const taskView = (blobs: string, r: Row): Task => ({
  id: String(r.id), origin_lane: str(r.origin_lane), goal: String(r.goal), status: String(r.status), repo: str(r.repo),
  node: str(r.node), agent: str(r.agent), attempt: Number(r.attempt), turn: Number(r.turn), quota_until: int(r.quota_until),
  result: redactDeep(json(r.result_json)), diff_blob: blobRef(blobs, r.diff_ref), error: red(r.error), matter_id: int(r.matter_id),
  started: int(r.started), ended: int(r.ended), ts: Number(r.ts),
});

export const deviceView = (r: Row): Device => ({
  id: String(r.id), name: String(r.name), platform: str(r.platform), role: String(r.role), version: str(r.version),
  created_at: Number(r.created_at), last_seen: int(r.last_seen), last_ip_masked: str(r.last_ip_masked),
  removed_at: int(r.removed_at), removed_by: str(r.removed_by),
});

/** The table and key behind each entity the stream carries. */
const SOURCE: Record<EntityName, { sql: string; key: (ref: string) => string | number }> = {
  thread: { sql: "SELECT * FROM threads WHERE id = ?", key: (r) => r },
  input: { sql: "SELECT * FROM inbox WHERE id = ?", key: Number },
  run: { sql: "SELECT * FROM runs WHERE id = ?", key: (r) => r },
  item: { sql: "SELECT * FROM run_items WHERE id = ?", key: Number },
  approval: { sql: "SELECT * FROM approvals WHERE id = ?", key: Number },
  task: { sql: "SELECT * FROM tasks WHERE id = ?", key: (r) => r },
  device: { sql: "SELECT * FROM devices WHERE id = ?", key: (r) => r },
};

export const isEntity = (e: string): e is EntityName => Object.hasOwn(SOURCE, e);

export function fromRow<E extends EntityName>(db: Db, blobs: string, entity: E, r: Row): EntityData[E] {
  switch (entity) {
    case "thread": return threadView(r) as EntityData[E];
    case "input": return inputView(r) as EntityData[E];
    case "run": return runView(r) as EntityData[E];
    case "item": return itemView(db, blobs, r) as EntityData[E];
    case "approval": return approvalView(db, blobs, r) as EntityData[E];
    case "task": return taskView(blobs, r) as EntityData[E];
    case "device": return deviceView(r) as EntityData[E];
  }
  throw new Error(`no view for ${String(entity)}`);
}

/** The entity as it is now; undefined = gone (or not an entity we carry). */
export function view(db: Db, blobs: string, entity: string, ref: string): unknown {
  if (!isEntity(entity)) return undefined;
  const s = SOURCE[entity];
  const r = db.one<Row>(s.sql, s.key(ref));
  return r ? fromRow(db, blobs, entity, r) : undefined;
}

// ── visibility (§读5.1, 04 「可见」) ──────────────────────────────────────────────────────────────────────────
// /api/v1 has one reader role, `client` (a paired device or the CLI): it is me, so it sees work, personal and owner
// content alike. A `node` never gets here (the dispatcher's authorize() 403s it) and never holds a stream; this check
// is the second wall, so even a wiring mistake can't push personal content to a node.
export type Role = "client" | "node";
export const visibleTo = (role: Role, _entity: string, _data: unknown): boolean => role === "client";

// ── timelines (§触6.4 「时间线不重复存」) ───────────────────────────────────────────────────────────────────────
// A thread's lane, merged from inbox, approvals, tasks and run_items by (ts, rank, key). The cursor is that triple,
// opaque to clients. ※ no lane index on inbox/approvals/tasks yet (04 v1); at 04 §13's volumes a scan is milliseconds.
const RANK = { input: 0, approval: 1, task: 2, item: 3 } as const;
const TL_SQL = `
SELECT * FROM (
  SELECT ts, 0 AS rank, printf('%020d', id) AS k, 'input' AS entity, CAST(id AS TEXT) AS ref FROM inbox WHERE lane = ?1
  UNION ALL SELECT ts, 1, printf('%020d', id), 'approval', CAST(id AS TEXT) FROM approvals WHERE origin_lane = ?1
  UNION ALL SELECT ts, 2, id, 'task', id FROM tasks WHERE origin_lane = ?1
  UNION ALL SELECT ts, 3, printf('%020d', id), 'item', CAST(id AS TEXT) FROM run_items WHERE lane = ?1
) WHERE (ts, rank, k) < (?2, ?3, ?4) ORDER BY ts DESC, rank DESC, k DESC LIMIT ?5`;

const encodeCursor = (ts: number, rank: number, k: string) => `${ts}.${rank}.${k}`;
function decodeCursor(c: string | undefined): [number, number, string] | null {
  if (c === undefined) return [Number.MAX_SAFE_INTEGER, 9, "~"];
  const m = /^(\d{1,15})\.(\d)\.([A-Za-z0-9_:-]{1,80})$/.exec(c);
  return m ? [Number(m[1]), Number(m[2]), m[3]!] : null;
}

export function timeline(db: Db, blobs: string, lane: string, before: string | undefined, limit: number): { entries: TimelineEntry[]; next_before: string | null } | null {
  const cur = decodeCursor(before);
  if (!cur) return null;
  const rows = db.all<{ ts: number; rank: number; k: string; entity: keyof typeof RANK; ref: string }>(TL_SQL, lane, cur[0], cur[1], cur[2], limit + 1);
  const more = rows.length > limit;
  const page = rows.slice(0, limit);
  const entries: TimelineEntry[] = [];
  for (const r of page.toReversed()) {
    const data = view(db, blobs, r.entity, r.ref);
    if (data !== undefined) entries.push({ entity: r.entity, id: r.ref, ts: Number(r.ts), data });
  }
  const last = page[page.length - 1];
  return { entries, next_before: more && last ? encodeCursor(Number(last.ts), Number(last.rank), String(last.k)) : null };
}

/** change_log's newest seq (0 before the first event). Read inside the same synchronous stretch as the data. */
export const headSeq = (db: Db): number =>
  Number(db.one<{ seq: number }>("SELECT seq FROM sqlite_sequence WHERE name = 'change_log'")?.seq ?? 0);
