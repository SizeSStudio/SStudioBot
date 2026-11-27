// W0 ③④ (docs/tech/04 §13, 09 W0): measure the old db and take the W6 baseline. Run as sbot on the server:
//   node probes/w0-db/measure.ts <old sbot.db> <out dir>
// Works on snapshots made with VACUUM INTO (the live db is only opened read-only). Prints aggregates only (safe to put
// in the repo); per-chat counts, which carry chat ids, go to <out dir>/w0-baseline.json and stay on the server.
import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, statSync, existsSync, chmodSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";

const [src, out] = process.argv.slice(2);
if (!src || !out) { console.error("usage: measure.ts <sbot.db> <out dir>"); process.exit(2); }
mkdirSync(out, { recursive: true, mode: 0o700 });
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const snapA = join(out, `snap-${stamp}.db`), snapB = join(out, `snap-${stamp}-w.db`);
{ const live = new DatabaseSync(src, { readOnly: true }); live.exec(`VACUUM INTO '${snapA}'`); live.exec(`VACUUM INTO '${snapB}'`); live.close(); }
for (const f of [snapA, snapB]) chmodSync(f, 0o600);

const db = new DatabaseSync(snapA, { readOnly: true });
const q = (sql: string) => { try { return db.prepare(sql).all(); } catch (e) { return { error: String((e as Error).message) }; } };
const t0 = "WITH w AS (SELECT (CAST(strftime('%s','now') AS INTEGER) - 30*86400) * 1000 AS t0)";
const r: Record<string, unknown> = { at: Date.now(), snapshot_bytes: statSync(snapA).size };

r["W0-1 bytes per table/index"] = q("SELECT name, SUM(pgsize) AS bytes FROM dbstat GROUP BY name ORDER BY bytes DESC");
const perDay = (t: string, tsCol: string, sizeCol: string | null) =>
  `SELECT '${t}' AS t, COUNT(*)/30.0 AS per_day, ${sizeCol ? `AVG(LENGTH(CAST(${sizeCol} AS BLOB)))` : "NULL"} AS avg_bytes FROM ${t}, w WHERE ${tsCol} > t0`;
r["W0-2 per day (30 d)"] = [
  ["messages", "ts", "text"], ["events", "ts", "summary"], ["inbox", "ts", "payload_json"], ["runs", "started", null],
  ["usage", "ts", null], ["approvals", "ts", "context_json"], ["outbox", "ts", "payload"], ["signals", "ts", null],
].map(([t, c, s]) => q(`${t0} ${perDay(t!, c!, s ?? null)}`));
r["W0-3 requests (kept 7 d)"] = q("SELECT COUNT(*) AS n, COUNT(*)/7.0 AS per_day, AVG(bytes) AS avg_gz, SUM(bytes) AS total_7d FROM requests");
r["W0-4 runs per role"] = q(`${t0} SELECT r.role, COUNT(DISTINCT r.id)/30.0 AS runs_per_day, COUNT(u.id) * 1.0 / COUNT(DISTINCT r.id) AS calls_per_run
  FROM runs r LEFT JOIN usage u ON u.run_id = r.id, w WHERE r.started > t0 GROUP BY r.role`);
r["W0-5 usd per day by role"] = q(`${t0} SELECT COALESCE(r.role, 'tier:' || u.tier) AS who, SUM(u.cost)/30.0 AS usd_per_day
  FROM usage u LEFT JOIN runs r ON r.id = u.run_id, w WHERE u.ts > t0 GROUP BY who ORDER BY usd_per_day DESC`);
// what W6's `import plan` needs: cost of triage per message and of matter assignment per event
r["W0-5b triage cost"] = q(`${t0} SELECT u.tier, r.role, COUNT(*) AS calls, SUM(u.cost) AS usd FROM usage u LEFT JOIN runs r ON r.id=u.run_id, w
  WHERE u.ts > t0 AND (r.role LIKE '%triage%' OR u.tier LIKE '%triage%' OR r.role LIKE '%matter%') GROUP BY u.tier, r.role`);
r["messages total / 30 d"] = q(`${t0} SELECT COUNT(*) AS total, SUM(ts > t0) AS last_30d, MIN(ts) AS oldest FROM messages, w`);
r["events total / 30 d"] = q(`${t0} SELECT COUNT(*) AS total, SUM(ts > t0) AS last_30d FROM events, w`);

// W0-6 on the writable copy
{ const w = new DatabaseSync(snapB);
  try {
    w.exec("CREATE VIRTUAL TABLE w0_fts USING fts5(text, content='messages', tokenize='trigram'); INSERT INTO w0_fts(w0_fts) VALUES ('rebuild');");
    r["W0-6 trigram fts bytes"] = w.prepare("SELECT SUM(pgsize) AS fts_bytes FROM dbstat WHERE name LIKE 'w0_fts%'").get();
    r["W0-6 message text bytes"] = w.prepare("SELECT SUM(LENGTH(CAST(text AS BLOB))) AS text_bytes FROM messages").get();
  } catch (e) { r["W0-6 trigram fts bytes"] = { error: String((e as Error).message) }; }
  w.close(); rmSync(snapB);
}

// ④ baseline for W6: rows per table, messages per chat, carried-over counts, files
const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '%fts%' ORDER BY name").all() as { name: string }[]).map((x) => x.name);
const rows: Record<string, number> = {};
for (const t of tables) rows[t] = Number((db.prepare(`SELECT COUNT(*) AS n FROM "${t}"`).get() as { n: number }).n);
const perChat = db.prepare("SELECT surface, chat_id, COUNT(*) AS n, MIN(ts) AS first, MAX(ts) AS last FROM messages GROUP BY surface, chat_id ORDER BY n DESC").all();
const now = Date.now();
const carried = {
  life_notes: rows.life_notes ?? 0,
  followups_pending_future: Number((q(`SELECT COUNT(*) AS n FROM timers WHERE kind='followup' AND status='pending' AND due_at > ${now}`) as { n: number }[])[0]?.n ?? 0),
  followups_pending_all: Number((q("SELECT COUNT(*) AS n FROM timers WHERE kind='followup' AND status='pending'") as { n: number }[])[0]?.n ?? 0),
  imports_applied: (q("SELECT COUNT(*) AS n FROM imports WHERE status='applied'") as { n: number }[])[0]?.n ?? null,
  events_open_need_reply: q("SELECT kind, level, COUNT(*) AS n FROM events WHERE state='open' GROUP BY kind, level"),
};
// files carried over unchanged (09: raw/, private/body/); the old system keeps import originals under imports/
const home = process.env.SBOT_HOME ?? "/srv/sbot";
const filesOf = (dir: string) => {
  if (!existsSync(dir)) return { exists: false, files: 0, bytes: 0, sha: null };
  const list: string[] = [];
  const walk = (d: string) => { for (const e of readdirSync(d, { withFileTypes: true })) { const p = join(d, e.name); if (e.isDirectory()) walk(p); else if (e.isFile()) list.push(p); } };
  walk(dir); list.sort();
  const h = createHash("sha256"); let bytes = 0;
  for (const p of list) { const b = readFileSync(p); bytes += b.length; h.update(p.slice(dir.length) + "\0" + createHash("sha256").update(b).digest("hex") + "\n"); }
  return { exists: true, files: list.length, bytes, sha: h.digest("hex") };
};
const files = { raw: filesOf(join(home, "raw")), private_body: filesOf(join(home, "private", "body")), imports: filesOf(join(home, "imports")), agent_home_imports: filesOf(join(home, "agent-home", "imports")) };

const baseline = { at: now, snapshot: snapA, rows, messages_per_chat: perChat, carried, files };
writeFileSync(join(out, "w0-baseline.json"), JSON.stringify(baseline, null, 1), { mode: 0o600 });

// repo-safe summary: no ids, no names
const counts = (perChat as { n: number }[]).map((c) => c.n);
r["④ rows per table"] = rows;
r["④ chats"] = { chats: counts.length, messages: counts.reduce((a, b) => a + b, 0), largest: counts.slice(0, 5), surfaces: q("SELECT surface, COUNT(DISTINCT chat_id) AS chats, COUNT(*) AS n FROM messages GROUP BY surface") };
r["④ carried"] = carried;
r["④ files"] = Object.fromEntries(Object.entries(files).map(([k, v]) => [k, { exists: v.exists, files: v.files, bytes: v.bytes, sha: v.sha?.slice(0, 12) ?? null }]));
console.log(JSON.stringify(r, null, 1));
