// The process-wide Db for modules ported near-verbatim from core/ (docs/tech/10 「照搬」: ledgers, triage, timers,
// channels). The old code called module-level all/one/run/tx everywhere; keeping that shape lets the function bodies
// move over unchanged, so a review can diff them against core/. Bound once at boot (main.ts) and in each test.
// W1c modules keep taking a Db argument; both reach the same connection.
import type { SQLInputValue } from "node:sqlite";
import type { Db } from "./db.ts";

let cur: Db | undefined;
export function setDb(db: Db | undefined) { cur = db; }
export function db(): Db {
  if (!cur) throw new Error("db not bound (setDb at boot)");
  return cur;
}

// rows are loose on purpose: the ported code reads columns by name and checks them itself
// unknown: the ported code passes row values straight through; node:sqlite rejects anything it cannot bind
type Arg = unknown;
const args = (a: Arg[]) => a.map((x) => (x === undefined ? null : x)) as SQLInputValue[];
export const all = (sql: string, ...a: Arg[]): any[] => db().all(sql, ...args(a));
export const one = (sql: string, ...a: Arg[]): any => db().one(sql, ...args(a));
export const run = (sql: string, ...a: Arg[]) => db().run(sql, ...args(a));
export const tx = <T>(fn: () => T): T => db().tx(fn);
export const kvGet = (k: string) => db().kvGet(k);
export const kvSet = (k: string, v: string) => db().kvSet(k, v);
export const emit = (entity: string, ref: string | number, op: "upsert" | "delete" = "upsert") => db().emit(entity, ref, op);
