// W1c smoke on a fresh home (run by hub/test/test-home.sh; SBOT_HOME is that home). Boots the hub base, asks for
// status over hub-admin.sock, writes one config file through the write path, backs up to a throwaway age key made in
// the home, stops the hub and restores into a second empty home with `sbot restore`, then compares the two.
// Exits non-zero on the first failure. Prints names and counts only.
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { generateX25519Identity, identityToRecipient } from "age-encryption";
import { home } from "../src/home.ts";
import { boot } from "../src/main.ts";
import { adminRequest } from "../src/admin-socket.ts";
import { readConfigFile, saveConfigText } from "../src/config/write.ts";
import { backupConf, channelsConf } from "../src/config/load.ts";
import { runBackup } from "../src/backup.ts";
import { run as cli } from "../src/cli.ts";
import { openDb } from "../src/db/db.ts";
import { LATEST } from "../src/db/migrate.ts";
import { git } from "../src/memory/repo.ts";
import { setQuiet } from "../src/log.ts";

setQuiet(true);
let step = 0;
function ok(cond: unknown, what: string): asserts cond {
  step++;
  if (!cond) { console.log(`✗ ${step}. ${what}`); process.exit(1); }
  console.log(`✓ ${step}. ${what}`);
}

const h = home();
ok(!existsSync(h.db), `fresh home ${h.root}`);

// fictional secrets and a fictional key file, so the backup has something in each slot
mkdirSync(h.keys, { recursive: true, mode: 0o700 });
writeFileSync(join(h.keys, "test-static.key"), Buffer.from("not a real key, smoke test only\n"), { mode: 0o600 });
if (!existsSync(h.secrets)) writeFileSync(h.secrets, "SMOKE_FAKE=not-a-secret\n", { mode: 0o600 });

const hub = await boot(h);
ok(hub.db.userVersion() === LATEST, `db migrated to v${LATEST}`);
ok(channelsConf().feishu.mode === "shadow", "feishu mode is shadow");
const tables = hub.db.all<{ n: number }>("SELECT count(*) AS n FROM sqlite_master WHERE type = 'table'")[0]!.n;
const triggers = hub.db.all<{ n: number }>("SELECT count(*) AS n FROM sqlite_master WHERE type = 'trigger'")[0]!.n;
ok(tables > 40 && triggers > 30, `${tables} tables, ${triggers} triggers`);

const st = await adminRequest(h.run, "GET", "/api/v1/status");
ok(st.status === 200 && (st.body as { db_version: number }).db_version === LATEST, "status over hub-admin.sock");
ok((statSync(join(h.run, "hub-admin.sock")).mode & 0o777) === 0o600 && (statSync(h.run).mode & 0o777) === 0o700, "socket 0600, run dir 0700");

// one config write: a throwaway recipient made inside this home (the identity file stays in the home)
const identity = await generateX25519Identity();
const idFile = join(h.root, "smoke-age-identity.txt");
writeFileSync(idFile, identity + "\n", { mode: 0o600 });
const recipient = await identityToRecipient(identity);
const cur = readConfigFile("backup.yaml");
const saved = await saveConfigText(hub.db, "backup.yaml", `recipient: ${recipient}\nto_nodes: []\n`, cur.hash, { source: "manual", actor: "smoke", what: "smoke recipient" });
ok(saved.changed && saved.sha, "backup.yaml written and committed");
ok(saved.widened.length > 0, `widening flagged (${saved.widened.length})`);
ok(hub.db.one<{ n: number }>("SELECT count(*) AS n FROM config_changes WHERE file = 'backup.yaml'")!.n === 1, "config_changes row");
const stale = await saveConfigText(hub.db, "backup.yaml", "recipient: x\n", cur.hash, { source: "manual" }).then(() => 0, (e) => e.status);
ok(stale === 409, "stale hash refused with 409");
ok(backupConf().recipient === recipient, "hot reload sees the new recipient");

// a row the restore must bring back
hub.db.kvSet("smoke.marker", "restored-ok");
const r = await runBackup(hub.db, h, backupConf());
ok(r.file && r.bytes && r.parts && r.parts >= 4, `backup ${r.file?.split("/").pop()} (${r.bytes} bytes, ${r.parts} parts)`);
ok(!readFileSync(r.file!).includes(Buffer.from("SMOKE_FAKE")), "backup is encrypted");
const configHead = (await git(h.config, "rev-parse", "HEAD")).trim();
await hub.close();

// restore into a second home that starts empty
const to = join(h.root, "restored");
process.env.SBOT_HOME = to;
process.env.SBOT_SECRETS = join(to, "secrets.env");
const lines: string[] = [];
const code = await cli(["restore", r.file!, "--identity", idFile], (s) => lines.push(s), (s) => lines.push(s));
ok(code === 0, `sbot restore (${lines.join(" ").slice(0, 80)})`);
const h2 = home(to);
const db2 = openDb(h2.db);
ok(db2.kvGet("smoke.marker") === "restored-ok", "restored DB has the marker row");
ok(db2.userVersion() === LATEST, "restored DB schema");
db2.close();
ok((await git(h2.config, "rev-parse", "HEAD")).trim() === configHead, "config repo restored at the same commit");
ok(readFileSync(join(h2.config, "backup.yaml"), "utf8").includes(recipient), "config file content restored");
ok(readFileSync(h2.secrets, "utf8") === readFileSync(h.secrets, "utf8") && (statSync(h2.secrets).mode & 0o777) === 0o600, "secrets.env restored 0600");
ok(existsSync(join(h2.keys, "test-static.key")), "keys/ restored");
ok(existsSync(join(h2.agentHome, ".git")), "agent-home restored");
const again = await cli(["restore", r.file!, "--identity", idFile], () => {}, () => {});
ok(again === 1, "second restore into a non-empty home refused without --force");
console.log("smoke ok");
