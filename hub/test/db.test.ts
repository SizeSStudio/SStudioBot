import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, utimesSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { SQLInputValue } from "node:sqlite";
import { tempHome } from "./helpers.ts";
import { Db, needsReset, openDb } from "../src/db/db.ts";
import { LATEST, allSql, migrate } from "../src/db/migrate.ts";
import { BLOB_REFS, NOT_BLOB_REFS, blobGc, cleanupDaily, cleanupHourly, referencedBlobs } from "../src/db/cleanup.ts";

const DAY = 86_400_000;
const fresh = () => openDb(":memory:");
// w0_*: the W0 probe queries at the end of 04, run on a copy, not part of the schema
const names = (sql: string, kind: string) =>
  new Set([...sql.matchAll(new RegExp(`CREATE ${kind}(?: IF NOT EXISTS)? (\\w+)`, "g"))].map((m) => m[1]!).filter((n) => !n.startsWith("w0_")));

test("migrations on an empty DB: WAL file DB, user_version, idempotent, refuse newer", () => {
  const h = tempHome("db");
  const db = openDb(h.db);
  assert.equal(db.userVersion(), LATEST);
  assert.equal(db.one<{ journal_mode: string }>("PRAGMA journal_mode")!.journal_mode, "wal");
  assert.deepEqual(migrate(db), { from: LATEST, to: LATEST });
  db.raw.exec(`PRAGMA user_version = ${LATEST + 1}`);
  db.close();
  assert.throws(() => openDb(h.db), /upgrade the hub/);
});

test("every table is STRICT", () => {
  const db = fresh();
  const tables = db.all<{ name: string; sql: string }>("SELECT name, sql FROM sqlite_master WHERE type = 'table' AND sql NOT LIKE 'CREATE VIRTUAL%' AND name <> 'sqlite_sequence'");
  assert.ok(tables.length > 40);
  // fts5 makes its own shadow tables (<name>_data, _idx, …); those are SQLite's, not ours
  for (const t of tables) if (!/_fts_\w+$/.test(t.name)) assert.match(t.sql, /\)\s*STRICT/, `${t.name} is not STRICT`);
  db.close();
});

test("v1.sql matches docs/tech/04 (tables, triggers, indexes)", () => {
  const doc = readFileSync(new URL("../../docs/tech/04-schema.md", import.meta.url), "utf8");
  const code = allSql();
  for (const kind of ["TABLE", "VIRTUAL TABLE", "TRIGGER", "INDEX", "UNIQUE INDEX"]) {
    assert.deepEqual([...names(code, kind)].sort(), [...names(doc, kind)].sort(), `${kind} names differ`);
  }
});

let n = 0;   // distinct per call, so UNIQUE indexes don't collide
const filler = (type: string): SQLInputValue => (++n, /INT/i.test(type) ? n : /REAL/i.test(type) ? n + 0.5 : /BLOB/i.test(type) ? new Uint8Array([n & 255]) : `x${n}`);

interface Col { name: string; type: string; notnull: number; dflt_value: string | null; pk: number }
/** Insert a row with every required column filled; returns its rowid. */
function insertRow(db: Db, table: string, extra: Record<string, SQLInputValue> = {}): number {
  const cols = db.all<Col>(`PRAGMA table_info(${table})`);
  const vals: Record<string, SQLInputValue> = {};
  for (const c of cols) {
    if (c.pk && /^INTEGER$/i.test(c.type) && cols.filter((x) => x.pk).length === 1) continue;   // rowid alias
    if ((c.notnull && c.dflt_value === null) || c.pk) vals[c.name] = filler(c.type);
  }
  Object.assign(vals, extra);
  const keys = Object.keys(vals);
  const sql = keys.length ? `INSERT INTO ${table}(${keys.join(",")}) VALUES (${keys.map(() => "?").join(",")})` : `INSERT INTO ${table} DEFAULT VALUES`;
  const r = db.run(sql, ...keys.map((k) => vals[k]!));
  return Number(r.lastInsertRowid);
}

test("each change_log trigger writes change_log (04 §10)", () => {
  const db = fresh();
  const trig = db.all<{ name: string; tbl_name: string; sql: string }>("SELECT name, tbl_name, sql FROM sqlite_master WHERE type = 'trigger' AND name LIKE 'cl\\_%' ESCAPE '\\'");
  assert.ok(trig.length >= 25);
  for (const t of trig) {
    const entity = /VALUES \('(\w+)'/.exec(t.sql)![1]!;
    const event = /AFTER (INSERT|UPDATE|DELETE)/.exec(t.sql)![1]!;
    const extra: Record<string, SQLInputValue> = {};
    if (t.tbl_name === "timers") extra.kind = "followup";
    if (t.tbl_name === "outbox") extra.approval_id = 1;
    db.raw.exec("DELETE FROM change_log");
    const rowid = insertRow(db, t.tbl_name, extra);
    const count = () => db.one<{ n: number }>("SELECT count(*) AS n FROM change_log WHERE entity = ?", entity)!.n;
    if (event === "INSERT") { assert.ok(count() >= 1, t.name); continue; }
    db.raw.exec("DELETE FROM change_log");
    if (event === "UPDATE") {
      const of = /UPDATE OF ([\w, \n]+?) ON/.exec(t.sql)?.[1]?.split(",")[0]?.trim();
      const cols = db.all<Col>(`PRAGMA table_info(${t.tbl_name})`);
      const col = of ? cols.find((c) => c.name === of)! : cols.find((c) => !c.pk)!;
      db.run(`UPDATE ${t.tbl_name} SET ${col.name} = ? WHERE rowid = ?`, filler(col.type), rowid);
    } else db.run(`DELETE FROM ${t.tbl_name} WHERE rowid = ?`, rowid);
    assert.ok(count() >= 1, `${t.name} (${event} ${t.tbl_name} → ${entity})`);
  }
  db.close();
});

test("timers and outbox triggers fire only when 04 says", () => {
  const db = fresh();
  insertRow(db, "timers", { kind: "job" });
  insertRow(db, "outbox", {});
  db.run("UPDATE outbox SET status = 'sent'");
  db.run("UPDATE timers SET status = 'done'");
  assert.equal(db.one<{ n: number }>("SELECT count(*) AS n FROM change_log WHERE entity IN ('timer','approval')")!.n, 0);
  db.close();
});

test("§10.3: activity on a matter bumps it and its parent", () => {
  const db = fresh();
  const P = insertRow(db, "matters", {}), C = insertRow(db, "matters", { parent_id: P });
  const at = (id: number) => db.one<{ v: number | null }>("SELECT last_activity_at AS v FROM matters WHERE id = ?", id)!.v;
  insertRow(db, "events", { matter_id: C, ts: 5000 });
  assert.equal(at(C), 5000);
  assert.equal(at(P), 5000);
  insertRow(db, "approvals", { matter_id: C, ts: 7000 });
  assert.equal(at(P), 7000);
  insertRow(db, "life_notes", { matter_id: C, ts: 6000 });
  assert.equal(at(C), 7000, "never goes backwards");
  insertRow(db, "timers", { matter_id: C, due_at: 9000, status: "waiting" });
  db.run("UPDATE timers SET status = 'done', fired_at = 9500 WHERE matter_id = ?", C);
  assert.equal(at(P), 9500);
  const tid = insertRow(db, "tasks", { matter_id: C, ts: 1 });
  const before = Date.now();
  db.run("UPDATE tasks SET status = 'done' WHERE rowid = ?", tid);
  assert.ok(at(C)! >= before - 1000, "a task status change uses the current time");
  db.close();
});

test("§10.4 reset rule", () => {
  const db = fresh();
  assert.equal(needsReset(db, 0), false, "empty log, nothing to miss");
  for (let i = 0; i < 5; i++) db.emit("x", i);
  assert.equal(needsReset(db, 0), false);
  assert.equal(needsReset(db, 5), false);
  db.run("DELETE FROM change_log WHERE seq <= 3");
  assert.equal(needsReset(db, 3), false, "next needed row (4) still there");
  assert.equal(needsReset(db, 2), true, "row 3 is gone");
  db.run("DELETE FROM change_log");
  assert.equal(needsReset(db, 5), false, "up to date");
  assert.equal(needsReset(db, 4), true, "behind and everything cleaned");
  db.close();
});

test("tx(): nested, rolled back as a whole, refuses async", () => {
  const db = fresh();
  assert.throws(() => db.tx(() => { db.kvSet("a", "1"); db.tx(() => db.kvSet("b", "2")); throw new Error("boom"); }), /boom/);
  assert.equal(db.kvGet("a"), undefined);
  assert.equal(db.kvGet("b"), undefined);
  assert.throws(() => db.tx(() => Promise.resolve(1) as unknown as number), /synchronous/);
  db.close();
});

test("§11 cleanup: old logs and derived rows go, recent ones stay", () => {
  const db = fresh();
  const now = Date.now();
  db.emit("x", 1);
  db.run("UPDATE change_log SET ts = ?", now - 8 * DAY);
  db.emit("x", 2);
  insertRow(db, "requests", { ts: now - 8 * DAY });
  insertRow(db, "requests", { ts: now });
  assert.deepEqual(cleanupHourly(db, now), { change_log: 1, requests: 1 });
  insertRow(db, "runs", { started: now - 400 * DAY, input_ref: "blob:" + "a".repeat(64) });
  insertRow(db, "runs", { started: now, input_ref: "blob:" + "b".repeat(64) });
  insertRow(db, "client_ops", { ts: now - 31 * DAY });
  insertRow(db, "client_ops", { ts: now });
  insertRow(db, "push_queue", { state: "done", closed_at: now - 31 * DAY });
  insertRow(db, "push_queue", { state: "waiting", closed_at: now - 31 * DAY });
  insertRow(db, "device_invites", { expires: now - 31 * DAY });
  insertRow(db, "device_invites", { expires: now + DAY });
  assert.deepEqual(cleanupDaily(db, now), { run_inputs: 1, client_ops: 1, push_queue: 1, device_invites: 1 });
  db.close();
});

test("blob GC: unreferenced and older than a day goes; referenced, young and foreign files stay", () => {
  const h = tempHome("db");
  const db = openDb(h.db);
  mkdirSync(h.blobs, { recursive: true });
  const sha = (c: string) => c.repeat(64);
  const old = (Date.now() - 2 * DAY) / 1000;
  for (const c of ["a", "b", "c"]) { writeFileSync(join(h.blobs, sha(c)), c); utimesSync(join(h.blobs, sha(c)), old, old); }
  writeFileSync(join(h.blobs, sha("d")), "d");   // young orphan
  writeFileSync(join(h.blobs, "upload.tmp"), "?"); utimesSync(join(h.blobs, "upload.tmp"), old, old);
  insertRow(db, "approvals", { request_ref: `blob:${sha("a")}` });
  insertRow(db, "proposals", { new_ref: `blob:${sha("b")}` });
  assert.deepEqual([...referencedBlobs(db)].sort(), [sha("a"), sha("b")]);
  const r = blobGc(db, h.blobs);
  assert.deepEqual(r.deleted, [sha("c")]);
  assert.ok(existsSync(join(h.blobs, sha("d"))) && existsSync(join(h.blobs, "upload.tmp")));
  db.close();
});

test("every _ref column is listed as a blob ref or as not a blob (04 §11)", () => {
  const db = fresh();
  const blob = new Set(BLOB_REFS.map(([t, c]) => `${t}.${c}`));
  const tables = db.all<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE '%\\_fts%' ESCAPE '\\' AND name <> 'sqlite_sequence'");
  const missing: string[] = [];
  for (const { name } of tables) for (const c of db.all<Col>(`PRAGMA table_info(${name})`)) {
    if (!c.name.endsWith("_ref")) continue;
    if (!blob.has(`${name}.${c.name}`) && !NOT_BLOB_REFS.includes(c.name)) missing.push(`${name}.${c.name}`);
  }
  assert.deepEqual(missing, []);
  for (const [t, c] of BLOB_REFS) assert.ok(db.all<Col>(`PRAGMA table_info(${t})`).some((x) => x.name === c), `${t}.${c} exists`);
  db.close();
});
