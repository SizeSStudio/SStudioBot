// W2b: the read-only /api/v1 dispatcher, bootstrap, the event pump, live text and blobs. All data fictional.
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import type { Frame, Req } from "../../protocol/frames.ts";
import { BootstrapRes, StreamRes } from "../../protocol/api/stream.ts";
import { ApprovalsRes, BlobRes, DevicesRes, ThreadItemsRes, ThreadsRes } from "../../protocol/api/read.ts";
import { ENTITY_DATA, type EntityName } from "../../protocol/api/entities.ts";
import { MetaRes } from "../../protocol/api/meta.ts";
import { openDb, type Db } from "../src/db/db.ts";
import { putBlob } from "../src/blobs.ts";
import { ingest } from "../src/inbox.ts";
import { itemEnd, itemStart } from "../src/items.ts";
import { createApi, type Api, type Conn, type DispatchCaller } from "../src/api/index.ts";
import { isEntity, view } from "../src/api/views.ts";
import { tempHome } from "./helpers.ts";

const CLIENT: DispatchCaller = { device_id: "a".repeat(64), role: "client" };
const NODE: DispatchCaller = { device_id: "b".repeat(64), role: "node" };
let reqId = 0;
const req = (method: Req["method"], path: string, extra: Partial<Req> = {}): Req => ({ t: "req", id: ++reqId, method, path, ...extra });

class FakeConn implements Conn {
  frames: Frame[] = [];
  alive = true;
  slow = false;
  /** frames it still takes before the line "drops" (the rest are lost, like a socket dying mid-write) */
  budget = Infinity;
  send(f: Frame) {
    if (!this.alive) return;
    if (this.budget-- <= 0) { this.alive = false; return; }
    this.frames.push(f);
  }
  writable() { return this.alive && !this.slow; }
  take(): Frame[] { const f = this.frames; this.frames = []; return f; }
}

function setup(tag: string): { db: Db; api: Api; blobs: string } {
  const h = tempHome(tag);
  const db = openDb(h.db);
  const api = createApi({ db, blobs: h.blobs, hubSha: () => "testsha", pump: { batch: 7, beatMs: 0 } });
  return { db, api, blobs: h.blobs };
}

const say = (db: Db, lane: string, text: string, n = randomBytes(6).toString("hex")) =>
  ingest(db, { lane, kind: "user", source: "feishu", source_msg_id: `om_${n}`, payload: { text, owner: true } }).id;

function startRun(db: Db, lane: string): string {
  const id = `r_${Date.now().toString(36)}_${randomBytes(3).toString("hex")}`;
  db.run("INSERT INTO runs(id, lane, role, tier, status, started) VALUES (?, ?, 'main', 'chat', 'running', ?)", id, lane, Date.now());
  return id;
}

// ── authorization ─────────────────────────────────────────────────────────────────────────────────────────────
test("node is 403 on every /api/v1 route, client is 403 on /node/v1; one check at the entry", async () => {
  const { api } = setup("api-authz");
  const paths: [Req["method"], string][] = [
    ["GET", "/api/v1/meta"], ["POST", "/api/v1/bootstrap"], ["POST", "/api/v1/stream"], ["POST", "/api/v1/stream/expand"],
    ["GET", "/api/v1/threads"], ["GET", "/api/v1/threads/th_x/items"], ["GET", "/api/v1/approvals"], ["GET", "/api/v1/devices"],
    ["GET", `/api/v1/blobs/${"0".repeat(64)}`], ["GET", "/api/v1/self/practice.md"], ["GET", "/api/v1/readings"], ["GET", "/api/v1/timeline"],
    ["POST", "/api/v1/approvals/1/decide"], ["POST", "/api/v1/threads/th_x/messages"], ["GET", "/api/v1/nope"],
  ];
  for (const [m, p] of paths) {
    const out = await api.dispatch(req(m, p, { body: { after: 0 } }), { ...NODE, conn: new FakeConn() });
    assert.equal(out.status, 403, `${m} ${p}`);
  }
  assert.equal(api.pump.streams, 0, "a node never holds a stream");
  assert.equal((await api.dispatch(req("POST", "/node/v1/hello"), CLIENT)).status, 403);
  assert.equal((await api.dispatch(req("GET", "/api/v1/meta"), { device_id: "x", role: "other" as "client" })).status, 403);
  const meta = await api.dispatch(req("GET", "/api/v1/meta"), CLIENT);
  assert.equal(meta.status, 200);
  assert.equal(MetaRes.parse(meta.body).hub_sha, "testsha");
  assert.equal((await api.dispatch(req("GET", "/api/v1/nope"), CLIENT)).status, 404);
  assert.equal((await api.dispatch(req("POST", "/api/v1/threads"), CLIENT)).status, 405, "writes are W3");
});

// ── bootstrap and lists ──────────────────────────────────────────────────────────────────────────────────────
test("bootstrap is one snapshot with its seq; lanes get threads; personal stays a client's", async () => {
  const { db, api } = setup("api-boot");
  say(db, "feishu:dm:owner", "明天下午三点和阿青对一下样稿");
  say(db, "console:main", "记一下：今天心里有点乱");
  ingest(db, { lane: "triage", kind: "system", source: "triage", source_msg_id: "t1", payload: { text: "x" } });
  const run = startRun(db, "feishu:dm:owner");
  const itemId = itemStart(db, api.blobs, { lane: "feishu:dm:owner", run_id: run, kind: "assistant", body: { text: "好的，已经记下。" }, status: "done" });
  // same ms as the item: the timeline breaks the tie by rank (input < approval < task < item)
  const itemTs = db.one<{ ts: number }>("SELECT ts FROM run_items WHERE id = ?", itemId)!.ts;
  db.run("INSERT INTO approvals(kind, origin_lane, title, draft, ts) VALUES ('send', 'feishu:dm:owner', '回阿青', '好的，三点见', ?)", itemTs);
  db.run("UPDATE inbox SET ts = ? WHERE lane = 'feishu:dm:owner'", itemTs - 1);
  db.run("INSERT INTO devices(id, public_key, name, platform, role, created_at) VALUES (?, ?, '测试手机', 'android', 'client', ?)", "c".repeat(64), new Uint8Array(32).fill(1), Date.now());

  const out = await api.dispatch(req("POST", "/api/v1/bootstrap", { body: {} }), CLIENT);
  assert.equal(out.status, 200);
  const b = BootstrapRes.parse(out.body);
  assert.equal(b.seq, Number(db.one<{ s: number }>("SELECT MAX(seq) AS s FROM change_log")!.s));
  assert.deepEqual(b.threads.map((t) => [t.lane, t.domain]).sort(), [["console:main", "personal"], ["feishu:dm:owner", "personal"]]);
  const dm = b.threads.find((t) => t.lane === "feishu:dm:owner")!;
  assert.deepEqual(b.timelines[dm.id]!.entries.map((e) => e.entity), ["input", "approval", "item"]);
  assert.equal(b.runs.length, 1);
  assert.equal(b.approvals[0]!.draft, "好的，三点见");
  assert.equal(b.devices[0]!.name, "测试手机");
  assert.equal("public_key" in b.devices[0]!, false);

  const th = ThreadsRes.parse((await api.dispatch(req("GET", "/api/v1/threads", { query: { status: "open" } }), CLIENT)).body);
  assert.equal(th.threads.length, 2);
  const ap = ApprovalsRes.parse((await api.dispatch(req("GET", "/api/v1/approvals"), CLIENT)).body);
  assert.equal(ap.approvals.length, 1);
  assert.equal(ApprovalsRes.parse((await api.dispatch(req("GET", "/api/v1/approvals", { query: { status: "approved" } }), CLIENT)).body).approvals.length, 0);
  assert.equal(DevicesRes.parse((await api.dispatch(req("GET", "/api/v1/devices"), CLIENT)).body).devices.length, 1);
  assert.equal((await api.dispatch(req("GET", "/api/v1/threads", { query: { status: "weird" } }), CLIENT)).status, 400);
  // the CLI puts the query in the path
  assert.equal((await api.dispatch(req("GET", "/api/v1/threads?status=weird"), CLIENT)).status, 400);
  assert.equal(ThreadsRes.parse((await api.dispatch(req("GET", "/api/v1/threads?status=archived"), CLIENT)).body).threads.length, 0);
});

test("thread items page back with next_before: every line once, in order", async () => {
  const { db, api } = setup("api-page");
  const ids: string[] = [];
  const t0 = 1_800_000_000_000;
  for (let i = 0; i < 37; i++) {
    // several lines share a ms on purpose: the cursor must still be a total order
    ids.push(String(ingest(db, { lane: "console:main", kind: "user", source: "client", source_msg_id: `c${i}`, payload: { text: `第 ${i} 句` }, ts: t0 + Math.floor(i / 3) }).id));
  }
  const th = db.one<{ id: string }>("SELECT id FROM threads WHERE lane = 'console:main'")!;
  const seen: string[] = [];
  let before: string | undefined;
  for (let guard = 0; guard < 20; guard++) {
    const out = await api.dispatch(req("GET", `/api/v1/threads/${th.id}/items`, { query: { limit: "5", ...(before ? { before } : {}) } }), CLIENT);
    const p = ThreadItemsRes.parse(out.body);
    seen.unshift(...p.entries.map((e) => e.id));
    if (!p.next_before) break;
    before = p.next_before;
  }
  assert.deepEqual(seen, ids);
  assert.equal((await api.dispatch(req("GET", `/api/v1/threads/${th.id}/items`, { query: { before: "nope" } }), CLIENT)).status, 400);
  assert.equal((await api.dispatch(req("GET", "/api/v1/threads/th_none/items"), CLIENT)).status, 404);
});

// ── blobs ─────────────────────────────────────────────────────────────────────────────────────────────────────
test("blobs come in chunks of at most 512 KiB", async () => {
  const { api, blobs } = setup("api-blob");
  const data = randomBytes(1_300_000);
  const sha = putBlob(blobs, data).slice(5);
  const parts: Buffer[] = [];
  let offset: number | null = 0, calls = 0;
  while (offset !== null) {
    const out = await api.dispatch(req("GET", `/api/v1/blobs/${sha}`, { query: { offset: String(offset), len: String(10 * 1024 * 1024) } }), CLIENT);
    const b = BlobRes.parse(out.body);
    const chunk = Buffer.from(b.data_b64, "base64");
    assert.ok(chunk.length <= 512 * 1024);
    assert.equal(b.total, data.length);
    parts.push(chunk);
    offset = b.next_offset;
    calls++;
  }
  assert.equal(calls, 3);
  assert.deepEqual(Buffer.concat(parts), data);
  // W2a's authorize refuses non-canonical paths at the entry, before any route (link/roles.ts)
  assert.equal((await api.dispatch(req("GET", "/api/v1/blobs/../../etc"), CLIENT)).status, 403);
  assert.equal((await api.dispatch(req("GET", `/api/v1/blobs/${"z".repeat(64)}`), CLIENT)).status, 400);
  assert.equal((await api.dispatch(req("GET", `/api/v1/blobs/${"0".repeat(64)}`), CLIENT)).status, 404);
  assert.equal((await api.dispatch(req("GET", `/api/v1/blobs/${sha}`, { query: { offset: String(data.length + 1) } }), CLIENT)).status, 400);
  // an item whose body went to a blob carries a BlobRef with the size and a preview
  const run = startRun(api.db, "console:main");
  const id = itemStart(api.db, blobs, { lane: "console:main", run_id: run, kind: "assistant", body: { text: "长".repeat(10_000) }, status: "done" });
  const it = ENTITY_DATA.item.parse(view(api.db, blobs, "item", String(id)));
  assert.ok(it.blob && it.blob.size > 16 * 1024 && it.blob.preview.length > 0);
});

// ── the stream ────────────────────────────────────────────────────────────────────────────────────────────────
/** A client's store (07 「store」): newest seq per (entity, id). */
class Store {
  m = new Map<string, { seq: number; data: unknown }>();
  maxSeq = 0;
  delivered: number[] = [];
  apply(f: Frame) {
    if (f.t === "beat") { this.maxSeq = Math.max(this.maxSeq, f.seq); return; }
    if (f.t !== "ev") return;
    this.delivered.push(f.seq);
    this.maxSeq = Math.max(this.maxSeq, f.seq);
    const k = `${f.entity}\0${f.id}`, cur = this.m.get(k);
    if (cur && cur.seq >= f.seq) return;
    if (f.op === "delete") this.m.set(k, { seq: f.seq, data: undefined });
    else this.m.set(k, { seq: f.seq, data: f.data });
  }
  load(b: ReturnType<typeof BootstrapRes.parse>) {
    this.maxSeq = b.seq;
    const put = (e: string, id: string, data: unknown) => this.m.set(`${e}\0${id}`, { seq: b.seq, data });
    for (const t of b.threads) put("thread", t.id, t);
    for (const r of b.runs) put("run", r.id, r);
    for (const a of b.approvals) put("approval", a.id, a);
    for (const t of b.tasks) put("task", t.id, t);
    for (const d of b.devices) put("device", d.id, d);
    for (const tl of Object.values(b.timelines)) for (const e of tl.entries) put(e.entity, e.id, e.data);
  }
}

/** Random writes across the streamed entities, the way the hub's modules do them. */
function randomWrite(db: Db, blobs: string, rnd: () => number, state: { runs: string[]; items: number[]; inputs: number[]; appr: number[] }) {
  const lanes = ["console:main", "feishu:dm:owner", "feishu:wb:om_fake1"];
  const lane = lanes[Math.floor(rnd() * lanes.length)]!;
  const pick = <T>(a: T[]) => a[Math.floor(rnd() * a.length)];
  const r = rnd();
  db.tx(() => {
    if (r < 0.2) state.inputs.push(say(db, lane, `随手一句 ${Math.floor(rnd() * 1000)}`));
    else if (r < 0.3) state.runs.push(startRun(db, lane));
    else if (r < 0.45 && state.runs.length) {
      const run = pick(state.runs)!;
      state.items.push(itemStart(db, blobs, { lane, run_id: run, kind: "tool", name: "memory_read", call_id: `c${state.items.length}`, body: { args: { q: "样稿" } } }));
    } else if (r < 0.55 && state.items.length) itemEnd(db, blobs, pick(state.items)!, "done", { args: {}, result: "ok" });
    else if (r < 0.62 && state.runs.length) db.run("UPDATE runs SET status = 'done', ended = ? WHERE id = ?", Date.now(), pick(state.runs)!);
    else if (r < 0.72) state.appr.push(Number(db.run("INSERT INTO approvals(kind, origin_lane, title, draft, ts) VALUES ('send', ?, '回一句', '收到', ?)", lane, Date.now()).lastInsertRowid));
    else if (r < 0.8 && state.appr.length) db.run("UPDATE approvals SET draft_version = draft_version + 1, draft = ? WHERE id = ?", `改 ${r}`, pick(state.appr)!);
    else if (r < 0.86 && state.inputs.length) db.run("UPDATE inbox SET status = 'done' WHERE id = ?", pick(state.inputs)!);
    else if (r < 0.9 && state.inputs.length) { const id = state.inputs.splice(Math.floor(rnd() * state.inputs.length), 1)[0]!; db.run("DELETE FROM inbox WHERE id = ?", id); }
    else if (r < 0.95) db.run("UPDATE threads SET title = ? WHERE lane = ?", `标题 ${Math.floor(rnd() * 100)}`, lane);
    else {
      // two writes to one entity in one commit, plus an entity the stream doesn't carry
      const id = say(db, lane, "又一句");
      db.run("UPDATE inbox SET status = 'processing' WHERE id = ?", id);
      db.emit("learned", 1);
      state.inputs.push(id);
    }
  });
}

/** What every streamed entity looks like now, from the view functions. */
function truth(db: Db, blobs: string): Map<string, unknown> {
  const out = new Map<string, unknown>();
  for (const r of db.all<{ entity: string; ref: string }>("SELECT DISTINCT entity, ref FROM change_log")) {
    if (!isEntity(r.entity)) continue;
    out.set(`${r.entity}\0${r.ref}`, view(db, blobs, r.entity as EntityName, r.ref));
  }
  return out;
}

function seeded(seed: number) {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 2 ** 32; };
}

test("disconnecting at random points: no duplicates, no gaps", async () => {
  for (const seed of [1, 7, 42, 2026, 31337]) {
    const { db, api, blobs } = setup(`api-rand-${seed}`);
    const rnd = seeded(seed);
    const state = { runs: [] as string[], items: [] as number[], inputs: [] as number[], appr: [] as number[] };
    for (let i = 0; i < 20; i++) randomWrite(db, blobs, rnd, state);
    const store = new Store();
    store.load(BootstrapRes.parse((await api.dispatch(req("POST", "/api/v1/bootstrap", { body: {} }), CLIENT)).body));
    let conn = new FakeConn();
    const connect = async () => {
      conn = new FakeConn();
      conn.budget = Math.floor(rnd() * 25);   // dies after a few frames, sometimes before the res is even used
      const out = await api.dispatch(req("POST", "/api/v1/stream", { body: { after: store.maxSeq } }), { ...CLIENT, conn });
      assert.equal(StreamRes.parse(out.body).reset, undefined);
    };
    await connect();
    for (let step = 0; step < 400; step++) {
      const r = rnd();
      if (r < 0.5) randomWrite(db, blobs, rnd, state);
      else if (r < 0.8) api.pump.tick();
      else if (r < 0.88) conn.slow = !conn.slow;
      for (const f of conn.take()) store.apply(f);
      if (!conn.alive || r > 0.97) { api.closeConn(conn); await connect(); }
    }
    // settle: a healthy connection, ticks until nothing is left
    api.closeConn(conn);
    conn = new FakeConn();
    await api.dispatch(req("POST", "/api/v1/stream", { body: { after: store.maxSeq } }), { ...CLIENT, conn });
    for (let i = 0; i < 50; i++) api.pump.tick();
    for (const f of conn.take()) store.apply(f);

    assert.equal(new Set(store.delivered).size, store.delivered.length, `seed ${seed}: a seq was delivered twice`);
    const want = truth(db, blobs);
    for (const [k, v] of want) {
      const got = store.m.get(k);
      if (v === undefined) assert.ok(!got || got.data === undefined, `seed ${seed}: ${k} should be gone`);
      else assert.deepEqual(got?.data, v, `seed ${seed}: ${k} differs`);
    }
    api.closeConn(conn);
    db.close();
  }
});

test("one entity changed many times between reads is one ev at its last seq; filtered and unknown advance the cursor", async () => {
  const { db, api } = setup("api-merge");
  const conn = new FakeConn();
  await api.dispatch(req("POST", "/api/v1/stream", { body: { after: 0 } }), { ...CLIENT, conn });
  const id = say(db, "console:main", "一");
  db.run("UPDATE inbox SET status = 'processing' WHERE id = ?", id);
  db.run("UPDATE inbox SET status = 'done' WHERE id = ?", id);
  db.emit("learned", 9);
  api.pump.tick();
  const evs = conn.take().filter((f) => f.t === "ev");
  const inputs = evs.filter((f) => f.t === "ev" && f.entity === "input");
  assert.equal(inputs.length, 1);
  const last = Number(db.one<{ s: number }>("SELECT MAX(seq) AS s FROM change_log WHERE entity = 'input'")!.s);
  assert.equal(inputs[0]!.t === "ev" && inputs[0]!.seq, last);
  assert.equal((inputs[0] as { data: { status: string } }).data.status, "done");
  assert.equal(evs.some((f) => f.t === "ev" && f.entity === "learned"), false);
  const beat = conn.take().find((f) => f.t === "beat");
  api.pump.tick();
  const b = [...conn.take(), ...(beat ? [beat] : [])].find((f) => f.t === "beat");
  assert.equal(b?.t === "beat" && b.seq, Number(db.one<{ s: number }>("SELECT MAX(seq) AS s FROM change_log")!.s), "beat carries the cursor past the filtered one");
});

test("after too old or newer than the hub → reset; nothing else is sent", async () => {
  const { db, api } = setup("api-reset");
  for (let i = 0; i < 5; i++) say(db, "console:main", `句 ${i}`);
  db.run("DELETE FROM change_log WHERE seq <= 3");   // the hourly cleanup took them
  const c1 = new FakeConn();
  const r1 = StreamRes.parse((await api.dispatch(req("POST", "/api/v1/stream", { body: { after: 1 } }), { ...CLIENT, conn: c1 })).body);
  assert.equal(r1.reset, true);
  assert.deepEqual(c1.take().map((f) => f.t), ["reset"]);
  const c2 = new FakeConn();
  assert.equal(StreamRes.parse((await api.dispatch(req("POST", "/api/v1/stream", { body: { after: 10_000 } }), { ...CLIENT, conn: c2 })).body).reset, true);
  const c3 = new FakeConn();
  assert.equal(StreamRes.parse((await api.dispatch(req("POST", "/api/v1/stream", { body: { after: 3 } }), { ...CLIENT, conn: c3 })).body).reset, undefined);
  // a stream that lags while the rows it needs are cleaned up is reset too
  c3.slow = true;
  for (let i = 0; i < 3; i++) say(db, "console:main", `又 ${i}`);
  db.run("DELETE FROM change_log WHERE seq <= 6");
  c3.slow = false;
  api.pump.tick();
  assert.deepEqual(c3.take().map((f) => f.t), ["reset"]);
  assert.equal(api.pump.streams, 0);
  assert.equal((await api.dispatch(req("POST", "/api/v1/stream", { body: { after: -1 } }), { ...CLIENT, conn: c3 })).status, 400);
  assert.equal((await api.dispatch(req("POST", "/api/v1/stream", { body: { after: 0 } }), CLIENT)).status, 400, "no connection, no stream");
});

// ── live text ─────────────────────────────────────────────────────────────────────────────────────────────────
test("deltas: every client gets the reply as it's written; a late or slow one gets a snapshot; live_key ties it to the row", async () => {
  const { db, api, blobs } = setup("api-live");
  const run = startRun(db, "feishu:dm:owner");
  const a = new FakeConn();
  await api.dispatch(req("POST", "/api/v1/stream", { body: { after: 0 } }), { ...CLIENT, conn: a });
  api.pump.tick();
  a.take();
  api.pump.onItem(run, "feishu:dm:owner", { k: "delta", text: "好的，" });
  api.pump.onItem(run, "feishu:dm:owner", { k: "delta", text: "三点" });
  const ds = a.take();
  assert.deepEqual(ds.map((f) => f.t === "delta" && [f.item, f.chunk_seq, f.text]), [[`${run}:a0`, 1, "好的，"], [`${run}:a0`, 2, "三点"]]);

  // a second client joins mid-message: fill-in, then a snapshot with the count, then live
  const b = new FakeConn();
  await api.dispatch(req("POST", "/api/v1/stream", { body: { after: 0 } }), { ...CLIENT, conn: b });
  api.pump.onItem(run, "feishu:dm:owner", { k: "delta", text: "见。" });   // b is still catching up: dropped for b
  api.pump.tick();
  const bf = b.take();
  const snap = bf.find((f) => f.t === "snapshot");
  assert.ok(snap && snap.t === "snapshot");
  assert.equal(snap.text, "好的，三点见。");
  assert.equal(snap.chunk_seq, 3);
  assert.ok(bf.findIndex((f) => f.t === "ev") < bf.indexOf(snap), "durable fill-in comes first");
  assert.equal(a.take().filter((f) => f.t === "delta").length, 1);

  // slow: deltas dropped, then one snapshot when it can write again
  a.slow = true;
  api.pump.onItem(run, "feishu:dm:owner", { k: "delta", text: "还有" });
  a.slow = false;
  api.pump.onItem(run, "feishu:dm:owner", { k: "delta", text: "事吗" });
  assert.equal(a.take().length, 0, "no delta after a gap until the snapshot");
  api.pump.tick();
  const s2 = a.take().find((f) => f.t === "snapshot");
  assert.ok(s2 && s2.t === "snapshot" && s2.chunk_seq === 5 && s2.text.endsWith("还有事吗"));

  // the message finishes: its row's live_key is the key the deltas used; the next message is a1
  const rowId = itemStart(db, blobs, { lane: "feishu:dm:owner", run_id: run, kind: "assistant", body: { text: "好的，三点见。还有事吗" }, status: "done" });
  api.pump.onItem(run, "feishu:dm:owner", { k: "message", text: "好的，三点见。还有事吗" });
  api.pump.onItem(run, "feishu:dm:owner", { k: "delta", text: "另外" });
  api.pump.tick();
  const af = a.take();
  const ev = af.find((f) => f.t === "ev" && f.entity === "item" && f.id === String(rowId));
  assert.equal((ev as { data: { live_key: string } }).data.live_key, `${run}:a0`);
  assert.ok(af.some((f) => f.t === "delta" && f.item === `${run}:a1` && f.chunk_seq === 1));

  // a node can't see any of it, even if something wired it to the pump by mistake
  const n = new FakeConn();
  api.pump.open(n, NODE, 0);
  api.pump.onItem(run, "feishu:dm:owner", { k: "delta", text: "x" });
  api.pump.tick();
  assert.equal(n.take().filter((f) => f.t === "ev" || f.t === "delta" || f.t === "snapshot").length, 0);

  // the run ends: live text is dropped, a new stream gets no snapshot for it
  db.run("UPDATE runs SET status = 'done', ended = ? WHERE id = ?", Date.now(), run);
  api.pump.tick();
  const c = new FakeConn();
  await api.dispatch(req("POST", "/api/v1/stream", { body: { after: 0 } }), { ...CLIENT, conn: c });
  api.pump.tick();
  assert.equal(c.take().filter((f) => f.t === "snapshot").length, 0);
});

test("tool output streams only to connections that expanded it", async () => {
  const { db, api, blobs } = setup("api-expand");
  const run = startRun(db, "console:main");
  const item = String(itemStart(db, blobs, { lane: "console:main", run_id: run, kind: "tool", name: "bash", call_id: "c1", body: { args: { cmd: "ls" } } }));
  const a = new FakeConn(), b = new FakeConn();
  for (const c of [a, b]) await api.dispatch(req("POST", "/api/v1/stream", { body: { after: 0 } }), { ...CLIENT, conn: c });
  api.pump.tick();
  a.take(); b.take();
  api.pump.toolText(run, item, "file1\n", "bash");
  assert.equal(a.take().length + b.take().length, 0, "folded: nothing");
  const ex = await api.dispatch(req("POST", "/api/v1/stream/expand", { body: { item } }), { ...CLIENT, conn: a });
  assert.deepEqual(ex.body, { live: true });
  api.pump.tick();
  const s = a.take().find((f) => f.t === "snapshot");
  assert.ok(s && s.t === "snapshot" && s.text === "file1\n" && s.tool === "bash" && s.chunk_seq === 1);
  api.pump.toolText(run, item, "file2\n");
  assert.ok(a.take().some((f) => f.t === "delta" && f.chunk_seq === 2));
  assert.equal(b.take().filter((f) => f.t === "delta" || f.t === "snapshot").length, 0, "b never expanded it");
  await api.dispatch(req("POST", "/api/v1/stream/collapse", { body: { item } }), { ...CLIENT, conn: a });
  api.pump.toolText(run, item, "file3\n");
  assert.equal(a.take().length, 0);
  itemEnd(db, blobs, Number(item), "done", { args: { cmd: "ls" }, result: "file1\nfile2\nfile3\n" });
  api.pump.tick();
  assert.deepEqual((await api.dispatch(req("POST", "/api/v1/stream/expand", { body: { item } }), { ...CLIENT, conn: b })).body, { live: false });
});
