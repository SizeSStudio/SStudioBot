// Versioned migrations (04 「约定」): PRAGMA user_version starts at 1 and only grows, each step an addition (tables,
// columns, indexes). One file per version, applied in its own transaction.
import { readFileSync } from "node:fs";
import type { Db } from "./db.ts";

const sql = (name: string) => readFileSync(new URL(name, import.meta.url), "utf8");

export const MIGRATIONS: { version: number; file: string }[] = [
  { version: 1, file: "v1.sql" },
];
export const LATEST = MIGRATIONS[MIGRATIONS.length - 1]!.version;

export function migrate(db: Db): { from: number; to: number } {
  const from = db.userVersion();
  // a DB written by newer code: refuse rather than run against columns we don't know
  if (from > LATEST) throw new Error(`database is at schema ${from}, this hub knows up to ${LATEST}; upgrade the hub`);
  for (const m of MIGRATIONS) {
    if (m.version <= from) continue;
    db.tx(() => {
      db.raw.exec(sql(m.file));
      db.raw.exec(`PRAGMA user_version = ${m.version}`);
    });
  }
  return { from, to: db.userVersion() };
}

/** All migration SQL in order, for the test that compares it with docs/tech/04. */
export const allSql = () => MIGRATIONS.map((m) => sql(m.file)).join("\n");
