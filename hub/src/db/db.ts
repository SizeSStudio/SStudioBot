// The hub's one SQLite connection (docs/tech/04 「约定」). Synchronous writes, nestable tx() whose outer level is
// BEGIN IMMEDIATE, so change_log seq order is commit order. Cross-module state changes go only through the DB + emit (03).
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { migrate } from "./migrate.ts";

export type Row = Record<string, unknown>;
export type Op = "upsert" | "delete";

export class Db {
  readonly raw: DatabaseSync;
  readonly file: string;
  #depth = 0;

  constructor(file: string) {
    this.file = file;
    if (file !== ":memory:") mkdirSync(dirname(file), { recursive: true });
    this.raw = new DatabaseSync(file);
    this.raw.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA busy_timeout=5000; PRAGMA foreign_keys=OFF;");
  }

  /** Nestable transaction; only the outermost level commits. A throw anywhere rolls the whole thing back. */
  tx<T>(fn: () => T): T {
    if (this.#depth > 0) {
      this.#depth++;
      try { return fn(); } finally { this.#depth--; }
    }
    this.raw.exec("BEGIN IMMEDIATE");
    this.#depth = 1;
    try {
      const out = fn();
      if (out instanceof Promise) throw new Error("tx() takes a synchronous function");
      this.raw.exec("COMMIT");
      return out;
    } catch (e) {
      try { this.raw.exec("ROLLBACK"); } catch { /* already rolled back */ }
      throw e;
    } finally {
      this.#depth = 0;
    }
  }

  one<T = Row>(sql: string, ...args: SQLInputValue[]): T | undefined { return this.raw.prepare(sql).get(...args) as T | undefined; }
  all<T = Row>(sql: string, ...args: SQLInputValue[]): T[] { return this.raw.prepare(sql).all(...args) as T[]; }
  run(sql: string, ...args: SQLInputValue[]) { return this.raw.prepare(sql).run(...args); }

  /** Explicit change_log entry (04 §10.1 「显式」): call it inside the same tx() as the write it reports. */
  emit(entity: string, ref: string | number, op: Op = "upsert") {
    this.run("INSERT INTO change_log(entity, ref, op) VALUES (?, ?, ?)", entity, String(ref), op);
  }

  kvGet(k: string): string | undefined { return this.one<{ v: string }>("SELECT v FROM kv WHERE k = ?", k)?.v; }
  kvSet(k: string, v: string) { this.run("INSERT INTO kv(k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v", k, v); }

  userVersion(): number { return Number(this.one<{ user_version: number }>("PRAGMA user_version")?.user_version ?? 0); }

  close() { this.raw.close(); }
}

/** Open (creating if needed) and bring the schema up to date. */
export function openDb(file: string): Db {
  const db = new Db(file);
  try { migrate(db); } catch (e) { db.close(); throw e; }
  return db;
}

/**
 * 04 §10.4: should a client that has seen everything up to `after` get a `reset` instead of a replay? True when it is
 * behind and the rows it would need were already cleaned up.
 */
export function needsReset(db: Db, after: number): boolean {
  const r = db.one<{ lo: number | null; hi: number | null }>(
    "SELECT (SELECT MIN(seq) FROM change_log) AS lo, (SELECT seq FROM sqlite_sequence WHERE name = 'change_log') AS hi");
  const lo = r?.lo ?? null, hi = r?.hi ?? 0;
  return after < hi && (lo === null || after + 1 < lo);
}
