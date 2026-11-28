// W2b smoke on a fresh home (hub/test/test-home.sh hub/test/smoke-w2b.ts <port>): boots the hub, puts a few fictional
// lines in through the channel host, then reads them back over hub-admin.sock the way the CLI does (meta, bootstrap,
// threads, a thread's items, approvals, devices, a blob in 512 KiB chunks), opens a stream in-process on the booted hub
// and checks it gets the new ev, a live delta and a beat, that a reconnect from the last seq misses nothing, and that
// a node is 403 everywhere on /api/v1. Fictional data only. Prints names and counts; exits non-zero on the first failure.
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import type { Frame } from "../../protocol/frames.ts";
import { BootstrapRes, StreamRes } from "../../protocol/api/stream.ts";
import { ApprovalsRes, BlobRes, DevicesRes, ThreadItemsRes, ThreadsRes } from "../../protocol/api/read.ts";
import { MetaRes } from "../../protocol/api/meta.ts";
import { home } from "../src/home.ts";
import { boot } from "../src/main.ts";
import { adminRequest } from "../src/admin-socket.ts";
import { channelHost } from "../src/channels/host.ts";
import { ingest } from "../src/inbox.ts";
import { putBlob } from "../src/blobs.ts";
import { setQuiet } from "../src/log.ts";

let step = 0;
function ok(cond: unknown, what: string): asserts cond {
  step++;
  if (!cond) { console.log(`✗ ${step}. ${what}`); process.exit(1); }
  console.log(`✓ ${step}. ${what}`);
}
const until = async (f: () => boolean, ms = 3000) => { const t = Date.now(); while (!f() && Date.now() - t < ms) await new Promise((r) => setTimeout(r, 20)); return f(); };

const h = home();
ok(!existsSync(h.db), `fresh home ${h.root}`);
mkdirSync(h.config, { recursive: true });
writeFileSync(join(h.config, "channels.yaml"), "feishu:\n  mode: shadow\n");
setQuiet(true);
const hub = await boot(h);
const db = hub.db;
const get = async (method: "GET" | "POST", path: string, body?: unknown) => {
  const r = await adminRequest(h.run, method, path, body);
  return { status: r.status, body: r.body };
};

const meta = MetaRes.parse((await get("GET", "/api/v1/meta")).body);
ok(meta.hub_sha.length > 0, `meta over hub-admin.sock (protocol ${meta.protocol.current})`);

// fictional lines in through the channel host, like a channel plugin would
const port = channelHost(db);
const say = (lane: string, text: string) => port.ingest({ lane, kind: "user", source: "smoke", source_msg_id: `s_${randomBytes(4).toString("hex")}`, payload: { text, owner: true } });
// a test home has no models.yaml: the dispatcher picks these up and fails their run, which the stream shows too
say("console:t:th_smoke0001", "把样稿的第二版发给小林");
say("console:t:th_smoke0001", "顺便问一下排期");
db.run("INSERT INTO approvals(kind, origin_lane, title, draft, ts) VALUES ('send', 'console:t:th_smoke0001', '回小林', '第二版在这里', ?)", Date.now());

const b = BootstrapRes.parse((await get("POST", "/api/v1/bootstrap", {})).body);
const th = b.threads.find((t) => t.id === "th_smoke0001");
ok(th && th.domain === "work", `bootstrap: ${b.threads.length} threads at seq ${b.seq}, the console thread is work`);
ok((b.timelines[th.id]?.entries.length ?? 0) >= 3, `its timeline has ${b.timelines[th.id]?.entries.length} lines`);
ok(b.approvals.some((a) => a.draft === "第二版在这里"), "pending approval in bootstrap");

const ts = ThreadsRes.parse((await get("GET", "/api/v1/threads?status=open")).body);
ok(ts.threads.some((t) => t.id === th.id), `GET threads?status=open (${ts.threads.length})`);
const items = ThreadItemsRes.parse((await get("GET", `/api/v1/threads/${th.id}/items?limit=2`)).body);
ok(items.entries.length === 2 && items.next_before, "a page of 2 with next_before");
const more = ThreadItemsRes.parse((await get("GET", `/api/v1/threads/${th.id}/items?limit=50&before=${encodeURIComponent(items.next_before!)}`)).body);
ok(more.entries.length >= 1 && more.next_before === null, `the rest (${more.entries.length}), then the end`);
ok(ApprovalsRes.parse((await get("GET", "/api/v1/approvals")).body).approvals.length === 1, "GET approvals (pending)");
ok(Array.isArray(DevicesRes.parse((await get("GET", "/api/v1/devices")).body).devices), "GET devices");

const data = randomBytes(1_100_000);
const sha = putBlob(h.blobs, data).slice(5);
const parts: Buffer[] = [];
let off: number | null = 0;
while (off !== null) {
  const c = BlobRes.parse((await get("GET", `/api/v1/blobs/${sha}?offset=${off}`)).body);
  parts.push(Buffer.from(c.data_b64, "base64"));
  off = c.next_offset;
}
ok(parts.length === 3 && parts.every((p) => p.length <= 512 * 1024) && Buffer.concat(parts).equals(data), `blob in ${parts.length} chunks of ≤ 512 KiB`);

// a stream on the booted hub, its pump on its own timer
class Conn { frames: Frame[] = []; send(f: Frame) { this.frames.push(f); } writable() { return true; } }
const CLIENT = { device_id: "d".repeat(64), role: "client" as const };
const c1 = new Conn();
const s1 = StreamRes.parse((await hub.api.dispatch({ t: "req", id: 1, method: "POST", path: "/api/v1/stream", body: { after: b.seq } }, { ...CLIENT, conn: c1 })).body);
ok(!s1.reset, `stream from seq ${b.seq}`);
// straight into the inbox here: this one's row id is what the stream must carry
const id = ingest(db, { lane: "console:t:th_smoke0001", kind: "user", source: "smoke", source_msg_id: "s_third", payload: { text: "第三句", owner: true } }).id;
ok(await until(() => c1.frames.some((f) => f.t === "ev" && f.entity === "input" && f.id === String(id))), "the new line arrives as an ev");
const run = `r_smoke_${randomBytes(3).toString("hex")}`;
db.run("INSERT INTO runs(id, lane, role, tier, status, started) VALUES (?, 'console:t:th_smoke0001', 'main', 'chat', 'running', ?)", run, Date.now());
hub.api.pump.onItem(run, "console:t:th_smoke0001", { k: "delta", text: "好的，" });
ok(await until(() => c1.frames.some((f) => f.t === "delta" && f.item === `${run}:a0`)), "a live delta reaches the stream");
hub.api.closeConn(c1);
const last = Math.max(...c1.frames.flatMap((f) => (f.t === "ev" ? [f.seq] : [])));
// changed while away; an approval, since the dispatcher keeps moving the inbox rows on its own
db.run("UPDATE approvals SET draft = '第二版，改过了', draft_version = draft_version + 1 WHERE origin_lane = 'console:t:th_smoke0001'");
const c2 = new Conn();
await hub.api.dispatch({ t: "req", id: 2, method: "POST", path: "/api/v1/stream", body: { after: last } }, { ...CLIENT, conn: c2 });
ok(await until(() => c2.frames.some((f) => f.t === "ev" && f.entity === "approval" && (f as { data?: { draft?: string } }).data?.draft === "第二版，改过了")),
  "reconnect from the last seq gets what changed while away");
ok(await until(() => c2.frames.some((f) => f.t === "snapshot" && f.item === `${run}:a0` && f.text === "好的，")), "…and a snapshot of the reply being written");
hub.api.closeConn(c2);

const NODE = { device_id: "e".repeat(64), role: "node" as const };
let denied = 0;
for (const p of ["/api/v1/meta", "/api/v1/bootstrap", "/api/v1/threads", `/api/v1/threads/${th.id}/items`, "/api/v1/approvals", "/api/v1/devices", `/api/v1/blobs/${sha}`, "/api/v1/stream"]) {
  const out = await hub.api.dispatch({ t: "req", id: 3, method: p.endsWith("bootstrap") || p.endsWith("stream") ? "POST" : "GET", path: p, body: { after: 0 } }, { ...NODE, conn: new Conn() });
  if (out.status === 403) denied++;
}
ok(denied === 8 && hub.api.pump.streams === 0, "a node is 403 on all of /api/v1 and holds no stream");

await hub.close();
ok(true, "hub closed");
process.exit(0);
