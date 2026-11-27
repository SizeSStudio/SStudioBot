// Periodic cleanup and blob GC (04 §11). Only logs, derived rows and caches; everything that is mine stays. These are
// plain functions: the timers module (W1e) calls cleanupHourly() every hour and cleanupDaily() once a day.
import { readdirSync, statSync, unlinkSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { Db } from "./db.ts";

const DAY = 86_400_000;

/** Columns that hold `blob:<sha>` (04 「约定」). Adding a column = add it here; hub/test/db.test.ts checks. */
export const BLOB_REFS: readonly [table: string, column: string][] = [
  ["runs", "input_ref"], ["requests", "body_ref"], ["run_items", "body_ref"], ["approvals", "request_ref"],
  ["approvals", "context_ref"], ["tasks", "diff_ref"], ["task_sessions", "handoff_ref"], ["readings", "chart_ref"],
  ["eval_cases", "input_ref"], ["proposals", "old_ref"], ["proposals", "new_ref"],
];
/** `_ref` columns that are not files: agent session ids, raw:/body: dirs, <entity>:<id> pointers (04 §11). */
export const NOT_BLOB_REFS: readonly string[] = ["session_ref", "media_ref", "raw_ref", "veto_ref", "reraise_ref"];

export function cleanupHourly(db: Db, now = Date.now()) {
  return db.tx(() => ({
    change_log: Number(db.run("DELETE FROM change_log WHERE ts < ?", now - 7 * DAY).changes),
    // the gzip'd request bodies stay on disk until blobGc sees nothing points at them
    requests: Number(db.run("DELETE FROM requests WHERE ts < ?", now - 7 * DAY).changes),
  }));
}

export function cleanupDaily(db: Db, now = Date.now()) {
  return db.tx(() => ({
    run_inputs: Number(db.run("UPDATE runs SET input_ref = NULL WHERE input_ref IS NOT NULL AND started < ?", now - 365 * DAY).changes),
    client_ops: Number(db.run("DELETE FROM client_ops WHERE ts < ?", now - 30 * DAY).changes),
    push_queue: Number(db.run("DELETE FROM push_queue WHERE state IN ('done','void') AND closed_at < ?", now - 30 * DAY).changes),
    device_invites: Number(db.run("DELETE FROM device_invites WHERE expires < ?", now - 30 * DAY).changes),
  }));
}

export function referencedBlobs(db: Db): Set<string> {
  const union = BLOB_REFS.map(([t, c]) => `SELECT ${c} AS r FROM ${t}`).join(" UNION ALL ");
  const rows = db.all<{ sha: string }>(`SELECT DISTINCT substr(r, 6) AS sha FROM (${union}) WHERE r LIKE 'blob:%'`);
  return new Set(rows.map((r) => r.sha));
}

/**
 * Delete files under blobs/ that no `_ref` column points at and whose mtime is over a day old. The day of grace covers
 * "blob written, transaction not committed yet" (04 §11); a crash orphan in that window goes on the next run.
 */
export function blobGc(db: Db, blobsDir: string, now = Date.now()): { kept: number; deleted: string[] } {
  if (!existsSync(blobsDir)) return { kept: 0, deleted: [] };
  const live = referencedBlobs(db), deleted: string[] = [];
  let kept = 0;
  for (const name of readdirSync(blobsDir)) {
    if (!/^[0-9a-f]{64}$/.test(name)) continue;   // temp files mid-write and anything else are not ours to judge
    const f = join(blobsDir, name);
    if (live.has(name) || statSync(f).mtimeMs > now - DAY) { kept++; continue; }
    unlinkSync(f);
    deleted.push(name);
  }
  return { kept, deleted };
}
