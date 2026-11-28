// W1e smoke on a fresh home (hub/test/test-home.sh hub/test/smoke-w1e.ts <port>): writes a channels.yaml with Feishu
// in shadow mode and dummy credentials, boots the hub, and checks the channel side came up without connecting — the
// log says so, shadow sends never leave, the channel host dedupes, seeded jobs became timers, Sentinel ticks, a command
// source fails clearly without a runner on Linux, a matter pauses and resurfaces — then stops cleanly.
// Fictional data only. Prints names and counts; exits non-zero on the first failure.
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { home } from "../src/home.ts";
import { boot } from "../src/main.ts";
import { channel } from "../src/channels/registry.ts";
import { channelHost } from "../src/channels/host.ts";
import type { FeishuChannel } from "../src/channels/feishu/plugin.ts";
import { Sentinel } from "../src/timers/sentinel.ts";
import { pollSource } from "../src/sources/index.ts";
import { openMatter, RESURFACED } from "../src/ledgers/matters.ts";
import { pauseMatter } from "../src/ledgers/matter-ops.ts";
import { recordEvent } from "../src/ledgers/events.ts";
import { setQuiet } from "../src/log.ts";

let step = 0;
function ok(cond: unknown, what: string): asserts cond {
  step++;
  if (!cond) { console.log(`✗ ${step}. ${what}`); process.exit(1); }
  console.log(`✓ ${step}. ${what}`);
}

const h = home();
ok(!existsSync(h.db), `fresh home ${h.root}`);
mkdirSync(h.config, { recursive: true });
writeFileSync(join(h.config, "channels.yaml"), "feishu:\n  mode: shadow\n");
// made-up credentials: shadow mode must not even try them
writeFileSync(h.secrets, "FEISHU_APP_ID=cli_smokefake0001\nFEISHU_APP_SECRET=smoke-fake-secret-000000\n", { mode: 0o600 });
// the hub logs JSON lines to stderr: keep them for the checks below instead of printing them
const lines: string[] = [];
setQuiet(false);   // test-home.sh sets SBOT_LOG=off; the lines are kept here, not printed
process.stderr.write = ((chunk: string | Uint8Array) => { lines.push(String(chunk)); return true; }) as typeof process.stderr.write;
const hub = await boot(h);
const db = hub.db;

const f = channel("feishu") as FeishuChannel | undefined;
ok(f && f.state() === "shadow", "feishu plugin registered, shadow");
ok(lines.some((l) => l.includes("shadow mode: no long connection")), "log says it isn't connecting");
ok(!lines.some((l) => l.includes("smoke-fake-secret")), "the dummy secret is not in the log");
const sent = await f.send({ id: 1, approval_id: null, run_id: null, lane: null, channel: "feishu", kind: "text", card_id: null, as_identity: "bot",
  target: { chat_id: "oc_smokefake0001" }, payload: "smoke", idem_key: "smoke-1", send_by: null, attempts: 0 });
ok(sent.ok && sent.shadow === true, "shadow send is only logged");

const port = channelHost(db);
const item = { lane: "smoke", kind: "user" as const, source: "smoke", source_msg_id: "s1", payload: { text: "x" } };
ok(port.ingest(item).fresh && !port.ingest(item).fresh, "inbox port dedupes on (source, source_msg_id)");

const timers = db.one<{ n: number }>("SELECT count(*) AS n FROM timers WHERE kind = 'schedule'")!.n;
ok(timers > 0, `seeded jobs synced to ${timers} timers`);

const alerts: string[] = [];
await new Sentinel({ userReady: async () => true, alert: (cat) => { alerts.push(cat); } }).tick();
ok(db.kvGet("sentinel.last"), `sentinel ticked (${alerts.length} alerts)`);

// a stub plugin in the home, so the poll gets past "plugin missing" to the runner check
process.env.SBOT_PLUGINS = join(h.root, "plugins");
mkdirSync(join(h.root, "plugins", "sources", "stub"), { recursive: true });
writeFileSync(join(h.root, "plugins", "sources", "stub", "run"), "#!/bin/sh\necho '{\"kind\":\"done\"}'\n", { mode: 0o755 });
const src = await pollSource({ id: "smoke-cmd", kind: "command", run: "stub" });
ok(process.platform === "linux" ? !src.ok && /插件运行器/.test(src.err ?? "") : src.ok,
  process.platform === "linux" ? "command source without a runner fails clearly, never runs as the hub" : "command source runs as the same user");

const m = openMatter({ title: "冒烟的事", domain: "work", lane: "smoke" }).id;
pauseMatter(m, { by: "owner" });
db.run("UPDATE matters SET paused_at = paused_at - 1000 WHERE id = ?", m);
recordEvent({ source: "smoke", ref: "e1", ts: Date.now(), kind: "progress", level: "fyi", summary: "有进展", matter_id: m });
ok(db.all(`SELECT id FROM matters WHERE ${RESURFACED}`).length === 1, "paused matter resurfaces on new activity");

await hub.close();
ok(!channel("feishu"), "hub closed, channel unregistered");
process.exit(0);
