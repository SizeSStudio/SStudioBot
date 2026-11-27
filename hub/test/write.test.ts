import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tempHome } from "./helpers.ts";
import { openDb } from "../src/db/db.ts";
import { useConfigDir } from "../src/config/load.ts";
import { configHistory, readConfigFile, saveConfigText, ConfigError } from "../src/config/write.ts";
import { ensureAgentHome, ensureConfigRepo } from "../src/config/seed.ts";
import { addDefaultJobs } from "../src/config/default-jobs.ts";
import { git, repoQueue } from "../src/memory/repo.ts";
import { setAdminSink } from "../src/notify.ts";

async function setup() {
  const h = tempHome("write");
  useConfigDir(h.config);
  await ensureConfigRepo(h.config);
  const db = openDb(h.db);
  const notes: string[] = [];
  setAdminSink((t) => { notes.push(t); });
  return { h, db, notes };
}

test("write path: commit, config_changes row, admin notice", async () => {
  const { h, db, notes } = await setup();
  const cur = readConfigFile("gate.yaml");
  const r = await saveConfigText(db, "gate.yaml", "proactive_daily_cap: 1\n", cur.hash, { source: "console", actor: "device:test", what: "cap" });
  assert.ok(r.changed && r.sha);
  assert.equal((await git(h.config, "log", "-1", "--format=%s")).trim(), "gate.yaml: cap (via console)");
  const row = db.one<{ file: string; source: string; actor: string; diff: string }>("SELECT file, source, actor, diff FROM config_changes")!;
  assert.deepEqual([row.file, row.source, row.actor], ["gate.yaml", "console", "device:test"]);
  assert.match(row.diff, /\+proactive_daily_cap: 1/);
  assert.ok(db.one("SELECT 1 FROM change_log WHERE entity = 'config'"), "cl_config_i fired");
  assert.equal(r.widened.length, 0);
  assert.ok(notes.some((n) => n.includes("gate.yaml")));
  assert.equal((await configHistory("gate.yaml")).length, 1);
  // same text again: no commit, no row
  const again = await saveConfigText(db, "gate.yaml", "proactive_daily_cap: 1\n", r.hash, { source: "console" });
  assert.equal(again.changed, false);
  assert.equal(db.one<{ n: number }>("SELECT count(*) AS n FROM config_changes")!.n, 1);
  db.close(); useConfigDir(undefined);
});

test("write path: stale hash is 409, invalid is 400 and nothing is written", async () => {
  const { h, db } = await setup();
  const cur = readConfigFile("gate.yaml");
  await saveConfigText(db, "gate.yaml", "proactive_daily_cap: 1\n", cur.hash, { source: "console" });
  await assert.rejects(saveConfigText(db, "gate.yaml", "proactive_daily_cap: 2\n", cur.hash, { source: "console" }), (e: ConfigError) => e.status === 409);
  const now = readConfigFile("gate.yaml");
  await assert.rejects(saveConfigText(db, "gate.yaml", "proactive_daily_cap: many\n", now.hash, { source: "console" }), (e: ConfigError) => e.status === 400);
  await assert.rejects(saveConfigText(db, "nope.yaml", "a: 1\n", "", { source: "console" }), (e: ConfigError) => e.status === 404);
  assert.equal(readFileSync(join(h.config, "gate.yaml"), "utf8"), "proactive_daily_cap: 1\n");
  assert.equal(db.one<{ n: number }>("SELECT count(*) AS n FROM config_changes")!.n, 1);
  // the queue keeps working after a refused write
  const ok = await saveConfigText(db, "gate.yaml", "proactive_daily_cap: 0\n", now.hash, { source: "console" });
  assert.ok(ok.changed);
  db.close(); useConfigDir(undefined);
});

test("write path: a widening goes through and is flagged loudly", async () => {
  const { db, notes } = await setup();
  const cur = readConfigFile("console.yaml");
  const r = await saveConfigText(db, "console.yaml", "mcp_open: true\n", cur.hash, { source: "chat" });
  assert.ok(r.changed && r.widened.length === 1);
  assert.ok(notes.some((n) => n.startsWith("⚠️") && n.includes("console.yaml")));
  db.close(); useConfigDir(undefined);
});

test("write path: self.yaml's content stays out of the admin notice", async () => {
  const { db, notes } = await setup();
  const cur = readConfigFile("self.yaml");
  await saveConfigText(db, "self.yaml", "month: solar_term\n", cur.hash, { source: "console" });
  const n = notes.find((x) => x.includes("self.yaml"))!;
  assert.ok(n && !n.includes("solar_term"));
  db.close(); useConfigDir(undefined);
});

test("concurrent writes queue on the repo", async () => {
  const { h, db } = await setup();
  const a = readConfigFile("gate.yaml"), b = readConfigFile("console.yaml");
  await Promise.all([
    saveConfigText(db, "gate.yaml", "proactive_daily_cap: 1\n", a.hash, { source: "console" }),
    saveConfigText(db, "console.yaml", "mcp_open: false\n", b.hash, { source: "console" }),
  ]);
  await repoQueue(h.config).idle();
  assert.equal(Number((await git(h.config, "rev-list", "--count", "HEAD")).trim()), 3);   // seed + 2
  db.close(); useConfigDir(undefined);
});

test("seed: config repo gets jobs and sources once; agent-home gets its files and dirs", async () => {
  const { h, db } = await setup();
  assert.ok(existsSync(join(h.config, "jobs.yaml")) && existsSync(join(h.config, "sources.yaml")));
  assert.ok(!existsSync(join(h.config, "people.yaml")), "people and models carry instance data: never seeded");
  writeFileSync(join(h.config, "jobs.yaml"), "{}\n");
  assert.deepEqual(await ensureConfigRepo(h.config), [], "an existing file is never replaced");
  const rep = await ensureAgentHome(db, h.agentHome);
  assert.deepEqual(rep.added, [], "a fresh home reports nothing as added");
  for (const f of ["AGENTS.md", "SOUL.md", "MEMORY.md", "USER.md"]) assert.ok(existsSync(join(h.agentHome, f)), f);
  assert.ok(existsSync(join(h.agentHome, "journal")));
  db.close(); useConfigDir(undefined);
});

test("default jobs: appended once, never against an existing name or do, never again after", async () => {
  const { h, db, notes } = await setup();
  const f = join(h.config, "jobs.yaml");
  writeFileSync(f, "nightly: { every: day, at: \"02:00\", do: backup }\n");
  await git(h.config, "commit", "-qam", "mine");
  const added = await addDefaultJobs(db, h.config);
  assert.deepEqual(added.sort(), ["lens_day", "lens_month", "lens_week"]);
  const text = readFileSync(f, "utf8");
  assert.ok(!/^backup:/m.test(text), "a job with do: backup already exists");
  assert.equal((await git(h.config, "log", "-1", "--format=%s")).trim(), "jobs.yaml: add lens_day, lens_week, lens_month (via upgrade)");
  assert.equal(db.one<{ source: string }>("SELECT source FROM config_changes")!.source, "upgrade");
  assert.ok(notes.some((n) => n.includes("lens_day")));
  // removed by me later: stays removed
  writeFileSync(f, "{}\n");
  assert.deepEqual(await addDefaultJobs(db, h.config), []);
  assert.equal(readFileSync(f, "utf8"), "{}\n");
  db.close(); useConfigDir(undefined);
});

test("default jobs: no jobs.yaml is left alone", async () => {
  const h = tempHome("write");
  const db = openDb(h.db);
  assert.deepEqual(await addDefaultJobs(db, h.config), []);
  assert.ok(!existsSync(join(h.config, "jobs.yaml")));
  db.close();
});
