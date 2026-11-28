// View functions (03 「api」): the one place an entity's content is read, shared by bootstrap, GET and the event pump,
// so a client sees the same shape whichever way it arrived. Shapes are protocol/api/entities.ts. Bodies were redacted
// when they were written (items.ts); free-text columns that weren't (run errors, task errors) are redacted here.
// Text goes out as data: nothing here renders HTML or follows a link.
import { existsSync, openSync, readSync, closeSync, statSync } from "node:fs";
import { join } from "node:path";
import type { Approval, BlobRef, Device, EntityData, EntityName, Input, Item, Node, Run, Task, Thread, TimelineEntry } from "../../../protocol/api/entities.ts";
import type { Ease, Read } from "../../../protocol/api/push.ts";
import type { Db, Row } from "../db/db.ts";
import { localMidnight } from "../time.ts";
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

/** The root mainline id of a matter, walking merged_into and parent_id on read (§触6.5). */
export function mainlineOf(db: Db, matterId: number | null): number | null {
  if (matterId == null) return null;
  let id = matterId;
  let last: number | null = null;
  const seen = new Set<number>([matterId]);
  for (let i = 0; i < 20; i++) {
    const m: { id: number; parent_id: number | null; merged_into: number | null } | undefined = db.one(
      "SELECT id, parent_id, merged_into FROM matters WHERE id = ?", id);
    if (!m) break;
    last = Number(m.id);
    const next: number | null = m.merged_into != null ? Number(m.merged_into) : m.parent_id != null ? Number(m.parent_id) : null;
    if (next == null || seen.has(next)) break;
    seen.add(next);
    id = next;
  }
  return last;
}

export const threadView = (db: Db, r: Row): Thread => {
  const matterId = int(r.matter_id);
  return {
    id: String(r.id), lane: String(r.lane), kind: String(r.kind), domain: String(r.domain), title: str(r.title),
    matter_id: matterId, task_id: str(r.task_id), status: String(r.status), pinned: Number(r.pinned) === 1,
    created_at: Number(r.created_at), last_item_at: int(r.last_item_at), mainline_id: mainlineOf(db, matterId),
  };
};

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
  const id = Number(r.id);
  const out = db.one<Row>("SELECT status, error, ts FROM outbox WHERE approval_id = ?", id);
  const sn = r.status === "pending"
    ? db.one<{ snooze: string | null; not_before: number | null }>(
        "SELECT snooze, not_before FROM push_queue WHERE ref = ? AND snooze IS NOT NULL AND state IN ('wait','night','counted') ORDER BY id DESC LIMIT 1",
        `approval:${id}`)
    : undefined;
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
    snooze: sn?.snooze ?? null,
    snooze_until: sn ? int(sn.not_before) : null,
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
  push: typeof r.push_token === "string" && r.push_token.length > 0,
});

export const readView = (r: Row): Read => ({ ref: String(r.ref), upto_ts: int(r.upto_ts), read_at: Number(r.read_at), via: String(r.via) });

/** kv `ease` = {on, since} (W3b writes it). 第 N 天 counts local days, 1 on the day it went on. */
export function easeView(r: Row | undefined, now = Date.now()): Ease {
  const v = json(r?.v) as { on?: boolean; since?: number } | null;
  if (!v?.on || typeof v.since !== "number") return { on: false, since: null, day: null };
  return { on: true, since: v.since, day: Math.max(1, Math.round((localMidnight(now) - localMidnight(v.since)) / 86400_000) + 1) };
}

/**
 * nodes joined with devices (the local node has no devices row: it never pairs). sha, target_sha, upgrade_failed and
 * the node's name live in extra_json, written by the nodes module (W4a); running and cleanable are counted here.
 */
export function nodeView(db: Db, r: Row): Node {
  const x = (json(r.extra_json) ?? {}) as Record<string, unknown>;
  const id = String(r.device_id);
  const d = db.one<Row>("SELECT name, platform FROM devices WHERE id = ?", id);
  const n = (sql: string) => Number(db.one<{ n: number }>(sql, id)?.n ?? 0);
  return {
    id, name: str(d?.name) ?? (id === "local" ? "本机" : str(x.name) ?? id.slice(0, 8)), platform: str(d?.platform), os: str(r.os),
    version: str(r.version), sha: str(x.sha), target_sha: str(x.target_sha), status: String(r.status), status_at: int(r.status_at),
    agents: json(r.agents_json), caps: json(r.caps_json), quotas: json(r.quota_json), max_parallel: int(r.max_parallel),
    upgrade_failed: x.upgrade_failed ?? null,
    running: n("SELECT COUNT(*) AS n FROM tasks WHERE node = ? AND status IN ('running','waiting','waiting_node')"),
    cleanable: n("SELECT COUNT(*) AS n FROM worktrees WHERE node = ? AND state = 'cleanable'"),
  };
}

/** The table and key behind each entity the stream carries. */
const SOURCE: Record<EntityName, { sql: string; key: (ref: string) => string | number }> = {
  thread: { sql: "SELECT * FROM threads WHERE id = ?", key: (r) => r },
  input: { sql: "SELECT * FROM inbox WHERE id = ?", key: Number },
  run: { sql: "SELECT * FROM runs WHERE id = ?", key: (r) => r },
  item: { sql: "SELECT * FROM run_items WHERE id = ?", key: Number },
  approval: { sql: "SELECT * FROM approvals WHERE id = ?", key: Number },
  task: { sql: "SELECT * FROM tasks WHERE id = ?", key: (r) => r },
  device: { sql: "SELECT * FROM devices WHERE id = ?", key: (r) => r },
  read: { sql: "SELECT * FROM reads WHERE ref = ?", key: (r) => r },
  // ease is always there (off when the kv row is missing): the LEFT JOIN gives one row either way
  ease: { sql: "SELECT kv.v FROM (SELECT ? AS id) one LEFT JOIN kv ON kv.k = 'ease' AND one.id = 'ease'", key: (r) => r },
  node: { sql: "SELECT * FROM nodes WHERE device_id = ?", key: (r) => r },
};

export const isEntity = (e: string): e is EntityName => Object.hasOwn(SOURCE, e);

export function fromRow<E extends EntityName>(db: Db, blobs: string, entity: E, r: Row): EntityData[E] {
  switch (entity) {
    case "thread": return threadView(db, r) as EntityData[E];
    case "input": return inputView(r) as EntityData[E];
    case "run": return runView(r) as EntityData[E];
    case "item": return itemView(db, blobs, r) as EntityData[E];
    case "approval": return approvalView(db, blobs, r) as EntityData[E];
    case "task": return taskView(blobs, r) as EntityData[E];
    case "device": return deviceView(r) as EntityData[E];
    case "read": return readView(r) as EntityData[E];
    case "ease": return easeView(r) as EntityData[E];
    case "node": return nodeView(db, r) as EntityData[E];
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
