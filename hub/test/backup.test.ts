import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { generateX25519Identity, identityToRecipient } from "age-encryption";
import { tempHome } from "./helpers.ts";
import { openDb } from "../src/db/db.ts";
import { ensureRepo, git } from "../src/memory/repo.ts";
import { BackupError, backupName, keep, openBackup, prune, restore, runBackup } from "../src/backup.ts";
import { pack, safeName, unpack } from "../src/tar.ts";
import { setAdminSink } from "../src/notify.ts";
import type { Home } from "../src/home.ts";

test("tar: round trip, long names, unsafe names refused", () => {
  const long = "keys/" + "d".repeat(90) + "/" + "f".repeat(60);
  const entries = [{ name: "a.txt", data: Buffer.from("hello") }, { name: long, data: new Uint8Array(1500).fill(7) }, { name: "empty", data: new Uint8Array(0) }];
  const out = unpack(pack(entries));
  assert.deepEqual(out.map((e) => e.name), entries.map((e) => e.name));
  assert.deepEqual(Buffer.from(out[1]!.data), Buffer.from(entries[1]!.data));
  for (const bad of ["/etc/passwd", "../x", "a/../../x", "C:/x", "a//b", ""]) assert.equal(safeName(bad), false, bad);
  assert.throws(() => unpack(pack([{ name: "../evil", data: Buffer.from("x") }])), /unsafe/);
  const t = pack(entries); t[0] = t[0]! ^ 1;
  assert.throws(() => unpack(t), /checksum/);
});

test("retention: 14 daily, 8 weekly, 12 monthly", () => {
  const days: string[] = [];
  for (let i = 0; i < 500; i++) days.push(new Date(Date.UTC(2026, 10, 28) - i * 86_400_000).toISOString().slice(0, 10));
  const k = keep(days);
  const sorted = [...k].sort().reverse();
  for (let i = 0; i < 14; i++) assert.ok(k.has(days[i]!), `day ${i}`);
  assert.ok(k.size <= 14 + 8 + 12 && k.size >= 20, `kept ${k.size}`);
  assert.equal(new Set(sorted.map((d) => d.slice(0, 7))).size >= 12, true);
  assert.ok(!k.has(days[499]!));
  assert.deepEqual(keep([]), new Set());
});

test("prune removes what retention drops, with its sidecar", () => {
  const h = tempHome("bk");
  mkdirSync(h.staging, { recursive: true });
  const days: string[] = [];
  for (let i = 0; i < 40; i++) days.push(new Date(Date.UTC(2026, 10, 28) - i * 86_400_000).toISOString().slice(0, 10));
  for (const d of days) { writeFileSync(join(h.staging, backupName(d)), "x"); writeFileSync(join(h.staging, backupName(d) + ".sha256"), "x"); }
  writeFileSync(join(h.staging, "unrelated.txt"), "keep me");
  const gone = prune(h.staging);
  assert.ok(gone.length > 0);
  for (const g of gone) assert.ok(!existsSync(join(h.staging, g)) && !existsSync(join(h.staging, g + ".sha256")));
  assert.ok(existsSync(join(h.staging, "unrelated.txt")));
});

async function populated(): Promise<{ h: Home; recipient: string; idFile: string }> {
  const h = tempHome("bk");
  const db = openDb(h.db);
  db.kvSet("marker", "fictional-value");
  db.close();
  await ensureRepo(h.config);
  writeFileSync(join(h.config, "gate.yaml"), "proactive_daily_cap: 1\n");
  await git(h.config, "add", "-A"); await git(h.config, "commit", "-qm", "one");
  await ensureRepo(h.agentHome);   // empty repo: no bundle, restore makes a fresh one
  mkdirSync(join(h.keys, "sub"), { recursive: true });
  writeFileSync(join(h.keys, "sub", "fake.key"), "not a key");
  writeFileSync(h.secrets, "FAKE=1\n");
  const identity = await generateX25519Identity();
  const idFile = join(h.root, "..", `${h.root.split("/").pop()}-id.txt`);
  writeFileSync(idFile, `# created: test\n${identity}\n`);
  return { h, recipient: await identityToRecipient(identity), idFile };
}

test("backup → restore round trip with a temp keypair", async () => {
  const { h, recipient, idFile } = await populated();
  const db = openDb(h.db);
  const r = await runBackup(db, h, { recipient, to_nodes: ["mac"] }, Date.UTC(2026, 10, 28, 12));
  db.close();
  assert.equal(r.file, join(h.staging, "sbot-2026-11-28.tar.age"));
  assert.deepEqual(r.waiting, ["mac"], "W2 seam: nodes still waiting");
  assert.equal(statSync(r.file!).mode & 0o777, 0o600);
  assert.ok(!readFileSync(r.file!).includes(Buffer.from("FAKE=1")));
  const { manifest } = await openBackup(r.file!, [readFileSync(idFile, "utf8").split("\n")[1]!]);
  assert.deepEqual(Object.keys(manifest.files).sort(), ["config.bundle", "keys/sub/fake.key", "sbot.db", "secrets.env"]);

  const to = tempHome("bk-to");
  const empty: Home = { ...to, secrets: join(to.root, "secrets.env") };
  await assert.rejects(restore(r.file!, idFile, empty), BackupError, "config/ exists → non-empty");
  const res = await restore(r.file!, idFile, empty, { force: true });
  assert.equal(res.day, "2026-11-28");
  assert.ok(res.movedAside && existsSync(join(res.movedAside, "config")), "old config moved aside, not deleted");
  const db2 = openDb(empty.db);
  assert.equal(db2.kvGet("marker"), "fictional-value");
  db2.close();
  assert.equal(readFileSync(join(empty.config, "gate.yaml"), "utf8"), "proactive_daily_cap: 1\n");
  assert.equal((await git(empty.config, "remote")).trim(), "", "no origin pointing at the bundle");
  assert.equal(readFileSync(join(empty.keys, "sub", "fake.key"), "utf8"), "not a key");
  assert.equal(statSync(empty.secrets).mode & 0o777, 0o600);
  assert.ok(existsSync(join(empty.agentHome, ".git")));
});

test("restore refuses a wrong key, a tampered file and a non-empty home", async () => {
  const { h, recipient, idFile } = await populated();
  const db = openDb(h.db);
  const r = await runBackup(db, h, { recipient, to_nodes: [] });
  db.close();
  const other = join(h.root, "other-id.txt");
  writeFileSync(other, (await generateX25519Identity()) + "\n");
  const target = (tag: string): Home => { const t = tempHome(tag); return { ...t, root: join(t.root, "fresh"), db: join(t.root, "fresh", "db", "sbot.db") }; };
  await assert.rejects(restore(r.file!, other, target("a")), /解不开/);
  const noKey = join(h.root, "nokey.txt"); writeFileSync(noKey, "nothing here\n");
  await assert.rejects(restore(r.file!, noKey, target("b")), (e: Error) => /AGE-SECRET-KEY-/.test(e.message) && !e.message.includes("nothing here"));
  const bytes = readFileSync(r.file!); bytes[bytes.length - 5] = bytes[bytes.length - 5]! ^ 1; writeFileSync(r.file!, bytes);
  await assert.rejects(restore(r.file!, idFile, target("c")), /sha256/);
  await assert.rejects(restore(r.file!, idFile, h), /不是空的/);
});

test("restore: an existing secrets.env outside the home needs --force and is kept aside", async () => {
  const { h, recipient, idFile } = await populated();
  const db = openDb(h.db);
  const r = await runBackup(db, h, { recipient, to_nodes: [] });
  db.close();
  const t = tempHome("bk-out");
  const outside = join(t.root, "..", `${t.root.split("/").pop()}-secrets.env`);
  writeFileSync(outside, "LIVE=1\n", { mode: 0o600 });
  const fresh: Home = { ...t, root: join(t.root, "fresh"), db: join(t.root, "fresh", "db", "sbot.db"), secrets: outside };
  await assert.rejects(restore(r.file!, idFile, fresh), /不是空的/);
  assert.equal(readFileSync(outside, "utf8"), "LIVE=1\n", "refused restore leaves it alone");
  const res = await restore(r.file!, idFile, fresh, { force: true });
  assert.equal(readFileSync(outside, "utf8"), "FAKE=1\n");
  assert.equal(readFileSync(join(res.movedAside!, "secrets.env"), "utf8"), "LIVE=1\n");
  assert.equal(statSync(join(res.movedAside!, "secrets.env")).mode & 0o777, 0o600);
});

test("no recipient: no backup, one notice", async () => {
  const h = tempHome("bk");
  const db = openDb(h.db);
  const notes: string[] = [];
  setAdminSink((t) => { notes.push(t); });
  assert.deepEqual(await runBackup(db, h, { to_nodes: [] }), { skipped: "no_recipient" });
  assert.ok(!existsSync(h.staging));
  assert.equal(notes.length, 1);
  db.close();
});
