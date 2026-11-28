// Write layer + optimistic store overlays + typed actions + agent HTML pull (W3: protocol/api/write.ts,
// conn/writes.ts, conn/actions.ts, store/store.ts, html/pull.ts). Runs against a fake WriteConn (W3a/W3b hub
// routes aren't merged on main yet). Fictional data only.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import type { Req, Res } from "../../../protocol/frames.ts";
import type { Approval, Input, Thread } from "../../../protocol/api/entities.ts";
import type { BootstrapRes } from "../../../protocol/api/stream.ts";
import { CLIENT_OP_ID, WRITES } from "../../../protocol/api/write.ts";
import { Store } from "../src/store/store.ts";
import { newOpId, refusalText, routeOf, Writes, type WriteConn } from "../src/conn/writes.ts";
import { makeActions } from "../src/conn/actions.ts";
import { htmlRefOf, pullAndOpenHtml } from "../src/html/pull.ts";

const LANE = "console:t:th_w1";
const THREAD: Thread = {
  id: "th_w1", lane: LANE, kind: "general", domain: "work", title: "旧标题",
  matter_id: null, task_id: null, status: "open", pinned: false, created_at: 100, last_item_at: 200,
};
const APPROVAL = (v = 1, extra: Partial<Approval> = {}): Approval => ({
  id: "ap_1", kind: "send", status: "pending", title: "回一封邮件", origin_lane: LANE,
  run_id: null, task_id: null, requester: null,
  channel: "mail", target: "alex@example.test", as_identity: "user", draft: "第一版稿子",
  draft_version: v, request: null, request_blob: null, options: null, answer: null,
  context: null, context_blob: null, refs: null, checks: null,
  delivery: null, decided_at: null, decided_by: null, decide_note: null, final_text: null,
  matter_id: null, expires_at: 999_999,
  snooze: null, snooze_until: null, result: null, ts: 300, ...extra,
});
const INPUT = (id: string, text: string, ts = 400): Input => ({
  id, lane: LANE, kind: "user", source: "client", status: "received", run_id: null,
  device_id: "dev_self", text, sender_name: null, owner: true, ts,
});
const boot = (seq: number): BootstrapRes => ({
  seq, threads: [THREAD], runs: [], approvals: [APPROVAL(1)], tasks: [], devices: [],
  timelines: { th_w1: { entries: [{ entity: "approval", id: "ap_1", ts: 300, data: APPROVAL(1) }], next_before: null } },
  ease: { on: false, since: null, day: null },
  reads: [],
});

type SentReq = {
  method: Req["method"]; path: string; body?: unknown; client_op_id?: string;
  resolve: (r: Res) => void; reject: (e: Error) => void;
};

class FakeConn implements WriteConn {
  live = true;
  sent: SentReq[] = [];
  #subs = new Set<(s: { s: string }) => void>();
  #id = 1;

  request(method: Req["method"], path: string, opts?: { body?: unknown; client_op_id?: string }): Promise<Res> {
    if (!this.live) return Promise.reject(new Error("offline"));
    return new Promise<Res>((resolve, reject) => {
      this.sent.push({ method, path, body: opts?.body, client_op_id: opts?.client_op_id, resolve, reject });
    });
  }
  subscribe(fn: (s: { s: string }) => void): () => void { this.#subs.add(fn); return () => this.#subs.delete(fn); }
  answer(i: number, status: number, body?: unknown, seq?: number): void {
    this.sent[i]!.resolve({ t: "res", id: this.#id++, status, ...(body !== undefined ? { body } : {}), ...(seq !== undefined ? { seq } : {}) });
  }
  drop(): void {
    this.live = false;
    for (const s of this.#subs) s({ s: "retry" });
    for (const r of this.sent) r.reject(new Error("disconnected"));
  }
  reconnect(): void {
    this.live = true;
    for (const s of this.#subs) s({ s: "live" });
  }
}

const flush = () => new Promise<void>((r) => setTimeout(r, 0));

test("routeOf matches every W3 route in WRITES and newOpId fits CLIENT_OP_ID", () => {
  for (let i = 0; i < 10; i++) assert.ok(CLIENT_OP_ID.safeParse(newOpId()).success);
  assert.deepEqual(routeOf("POST", "/api/v1/threads"), { route: "POST /api/v1/threads", kind: "optimistic", locked: false });
  assert.deepEqual(routeOf("POST", "/api/v1/approvals/ap_1/decide"), { route: "POST /api/v1/approvals/:id/decide", kind: "confirmed", locked: true });
  assert.deepEqual(routeOf("PUT", "/api/v1/approvals/ap_1/draft"), { route: "PUT /api/v1/approvals/:id/draft", kind: "locked", locked: true });
  assert.deepEqual(routeOf("POST", "/api/v1/presence"), { route: "POST /api/v1/presence", kind: "none", locked: false });
  assert.equal(routeOf("GET", "/api/v1/threads"), null);
  assert.equal(routeOf("PATCH", "/api/v1/threads//"), null);
  const store = new Store();
  const w = new Writes({ conn: new FakeConn(), store });
  assert.throws(() => w.write({ method: "GET", path: "/api/v1/threads" }), /not a write route/);
  assert.ok(Object.keys(WRITES).length >= 16);
});

test("optimistic sendMessage: overlay drops in the SAME store flush as the hub's row at res.seq (no flicker)", async () => {
  const store = new Store();
  store.bootstrap(boot(10));
  const conn = new FakeConn();
  let seqId = 0;
  const writes = new Writes({ conn, store, newId: () => `op_test_0000000${++seqId}` });
  const actions = makeActions(writes, store, () => "dev_self", () => 400);

  const snapshots: string[][] = [];
  store.subscribe(() => snapshots.push(store.timeline(LANE).filter((r) => r.entity === "input").map((r) => r.id)));

  const done = actions.sendMessage(THREAD, "三点开会");
  assert.equal(conn.sent.length, 1);
  assert.equal(conn.sent[0]!.client_op_id, "op_test_00000001");
  assert.deepEqual(store.timeline(LANE).filter((r) => r.entity === "input").map((r) => r.id), ["op:op_test_00000001"]);
  assert.equal(store.get("input", "op:op_test_00000001")?.pending, "op_test_00000001");

  // Hub answers at seq 12, stream is still at 10: overlay MUST stay until stream reaches 12
  let settled = false;
  void done.then(() => { settled = true; });
  conn.answer(0, 201, { input: INPUT("in_42", "三点开会", 400), queued: false, ahead: 0 }, 12);
  await flush();
  assert.equal(settled, false);
  assert.equal(store.hasOverlay("op_test_00000001"), true);
  assert.equal(writes.op("op_test_00000001")?.state, "settling");

  // Earlier seq 11 does not drop the overlay yet
  store.beat(11);
  assert.equal(store.hasOverlay("op_test_00000001"), true);

  // Stream delivers the real row at seq 12: swap happens in ONE flush (never empty, never both!)
  snapshots.length = 0;
  store.ev({ t: "ev", seq: 12, ts: 400, entity: "input", id: "in_42", op: "upsert", data: INPUT("in_42", "三点开会", 400) });
  const res = await done;
  assert.equal(res.ok, true);
  assert.equal(store.hasOverlay("op_test_00000001"), false);
  assert.equal(writes.op("op_test_00000001"), undefined);
  assert.deepEqual(snapshots, [["in_42"]], "single flush directly from overlay to real row, zero flicker");
});

test("optimistic overlay also settles on beat(seq), late res when stream already passed seq, or bootstrap after reset", async () => {
  const store = new Store();
  store.bootstrap(boot(10));
  const conn = new FakeConn();
  let n = 0;
  const writes = new Writes({ conn, store, newId: () => `op_settle_00000${++n}` });
  const actions = makeActions(writes, store, () => "dev_self", () => 500);

  // 1) beat reaches seq (e.g. write's own event was filtered out)
  const p1 = actions.snooze("ap_1", "tonight");
  assert.equal(store.get("approval", "ap_1")?.data.snooze, "tonight");
  conn.answer(0, 200, { approval: APPROVAL(1, { snooze: "tonight" }), until_ts: 900 }, 15);
  await flush();
  assert.equal(store.hasOverlay("op_settle_000001"), true);
  store.beat(15);
  assert.equal((await p1).ok, true);
  assert.equal(store.hasOverlay("op_settle_000001"), false);

  // 2) ev arrives BEFORE res: res sees seq <= store.seq and drops immediately
  const p2 = actions.patchThread("th_w1", { pinned: true });
  store.ev({ t: "ev", seq: 16, ts: 501, entity: "thread", id: "th_w1", op: "upsert", data: { ...THREAD, pinned: true } });
  assert.equal(store.hasOverlay("op_settle_000002"), true);
  conn.answer(1, 200, { thread: { ...THREAD, pinned: true } }, 16);
  assert.equal((await p2).ok, true);
  assert.equal(store.hasOverlay("op_settle_000002"), false);
  assert.equal(store.get("thread", "th_w1")?.data.pinned, true);

  // 3) bootstrap after reset catches up a settling op
  const p3 = actions.patchThread("th_w1", { title: "新名字" });
  conn.answer(2, 200, { thread: { ...THREAD, title: "新名字" } }, 20);
  await flush();
  store.bootstrap({ ...boot(22), threads: [{ ...THREAD, title: "新名字" }] });
  assert.equal((await p3).ok, true);
  assert.equal(store.hasOverlay("op_settle_000003"), false);
  assert.equal(store.get("thread", "th_w1")?.data.title, "新名字");
});

test("optimistic rollback on non-2xx: reverts patch in place, records refusal until dismissed", async () => {
  const store = new Store();
  store.bootstrap(boot(10));
  const conn = new FakeConn();
  const writes = new Writes({ conn, store, newId: () => "op_rollback_0001" });
  const actions = makeActions(writes, store, () => "dev_self", () => 500);

  const p = actions.patchThread("th_w1", { title: "改坏了", pinned: true });
  assert.equal(store.get("thread", "th_w1")?.data.title, "改坏了");
  assert.equal(store.get("thread", "th_w1")?.data.pinned, true);

  conn.answer(0, 403, { error: "read-only" });
  const r = await p;
  assert.equal(r.ok, false);
  if (!r.ok) { assert.equal(r.status, 403); assert.equal(r.error, "read-only"); }
  assert.equal(store.get("thread", "th_w1")?.data.title, "旧标题");
  assert.equal(store.get("thread", "th_w1")?.data.pinned, false);
  assert.equal(store.hasOverlay("op_rollback_0001"), false);
  assert.equal(writes.refusal("thread:th_w1")?.state, "failed");
  assert.match(refusalText(403), /不许/);
  writes.dismiss("op_rollback_0001");
  assert.equal(writes.refusal("thread:th_w1"), undefined);
});

test("optimistic createThread rollback removes temporary op:<id> thread cleanly", async () => {
  const store = new Store();
  store.bootstrap(boot(10));
  const conn = new FakeConn();
  const writes = new Writes({ conn, store, newId: () => "op_newth_0000001" });
  const actions = makeActions(writes, store, () => "dev_self", () => 600);

  const p = actions.createThread({ title: "私密线程", domain: "personal" });
  assert.equal(store.get("thread", "op:op_newth_0000001")?.data.domain, "personal");
  conn.answer(0, 500, { error: "db busy" });
  assert.equal((await p).ok, false);
  assert.equal(store.get("thread", "op:op_newth_0000001"), undefined);
});

test("confirmed + locked decide: busy until stream reaches seq; 409 / 410 replace store with hub's current entity", async () => {
  const store = new Store();
  store.bootstrap(boot(10));
  const conn = new FakeConn();
  let n = 0;
  const writes = new Writes({ conn, store, newId: () => `op_lock_0000000${++n}` });
  const actions = makeActions(writes, store, () => "dev_self");

  // 1) confirmed + locked: busy during sent, and 409 brings back draft_version 2 without overwriting
  const p1 = actions.decide({ id: "ap_1" }, 1, { action: "approve" });
  assert.equal(writes.busy("approval:ap_1")?.state, "sent");
  assert.deepEqual(conn.sent[0]!.body, { action: "approve", draft_version: 1 });
  assert.equal(store.get("approval", "ap_1")?.data.status, "pending", "confirmed write does not touch store before res");

  const v2 = APPROVAL(2, { draft: "别处刚改的第二版" });
  conn.answer(0, 409, { error: "draft_version mismatch", approval: v2 }, 13);
  const r1 = await p1;
  assert.equal(r1.ok, false);
  if (!r1.ok) {
    assert.equal(r1.status, 409);
    assert.equal(r1.conflict?.approval?.draft_version, 2);
  }
  assert.equal(writes.refusal("approval:ap_1")?.state, "conflict");
  assert.equal(store.get("approval", "ap_1")?.data.draft_version, 2);
  assert.equal(store.get("approval", "ap_1")?.data.draft, "别处刚改的第二版");

  // 2) 410 expired with current entity updates store, unless store already holds a newer seq
  const p2 = actions.saveDraft("ap_1", "我写的", 2);
  const expired = APPROVAL(2, { status: "expired" });
  conn.answer(1, 410, { error: "expired", approval: expired }, 14);
  const r2 = await p2;
  assert.equal(r2.ok, false);
  assert.equal(store.get("approval", "ap_1")?.data.status, "expired");
  assert.match(refusalText(410), /过期/);

  // 3) confirmed write stays busy during settling until stream catches up
  const p3 = actions.setEase(true);
  assert.equal(writes.busy("ease")?.state, "sent");
  conn.answer(2, 200, { ease: { on: true, since: 1000, day: 1 } }, 18);
  await flush();
  assert.equal(writes.busy("ease")?.state, "settling");
  store.ev({ t: "ev", seq: 18, ts: 1000, entity: "ease", id: "ease", op: "upsert", data: { on: true, since: 1000, day: 1 } });
  assert.equal((await p3).ok, true);
  assert.equal(writes.busy("ease"), undefined);
  assert.equal(store.get("ease", "ease")?.data.on, true);
});

test("409 Conflict current entity never regresses a newer row already delivered on the stream", async () => {
  const store = new Store();
  store.bootstrap(boot(10));
  const conn = new FakeConn();
  const writes = new Writes({ conn, store, newId: () => "op_newer_0000001" });
  const actions = makeActions(writes, store, () => "dev_self");

  const p = actions.saveDraft("ap_1", "旧改稿", 1);
  // Stream already delivered v3 at seq 20
  store.ev({ t: "ev", seq: 20, ts: 600, entity: "approval", id: "ap_1", op: "upsert", data: APPROVAL(3, { draft: "流里最新的第三版" }) });
  // Stale 409 carrying v2 at seq 15 must NOT overwrite v3
  conn.answer(0, 409, { error: "stale", approval: APPROVAL(2, { draft: "旧的第二版" }) }, 15);
  await p;
  assert.equal(store.get("approval", "ap_1")?.data.draft_version, 3);
  assert.equal(store.get("approval", "ap_1")?.data.draft, "流里最新的第三版");
});

test("dropped connection resends unanswered writes with the SAME client_op_id; offline writes queue", async () => {
  const store = new Store();
  store.bootstrap(boot(10));
  const conn = new FakeConn();
  let n = 0;
  const writes = new Writes({ conn, store, newId: () => `op_retry_000000${++n}` });
  const actions = makeActions(writes, store, () => "dev_self", () => 700);

  // 1) sent while live, then connection drops before res
  const p1 = actions.sendMessage(THREAD, "断线前发的");
  assert.equal(conn.sent.length, 1);
  const firstId = conn.sent[0]!.client_op_id;
  conn.drop();
  await flush();
  assert.equal(writes.op(firstId!)?.state, "queued");
  assert.equal(store.hasOverlay(firstId!), true, "optimistic overlay stays while waiting to resend");

  // 2) write made while offline queues with tries === 0
  const p2 = actions.decide({ id: "ap_1" }, 1, { action: "reject", note: "先不发" });
  assert.equal(conn.sent.length, 1);
  assert.equal(writes.busy("approval:ap_1")?.state, "queued");
  assert.equal(writes.busy("approval:ap_1")?.tries, 0);

  // 3) reconnect: both go out in order, first with the EXACT same client_op_id
  conn.reconnect();
  assert.equal(conn.sent.length, 3);
  assert.equal(conn.sent[1]!.client_op_id, firstId);
  assert.equal(writes.op(firstId!)?.tries, 2);
  assert.equal(conn.sent[2]!.path, "/api/v1/approvals/ap_1/decide");

  conn.answer(1, 201, { input: INPUT("in_99", "断线前发的", 700), queued: false, ahead: 0 }, 11);
  conn.answer(2, 200, { approval: APPROVAL(1, { status: "rejected" }) }, 12);
  store.ev({ t: "ev", seq: 11, ts: 700, entity: "input", id: "in_99", op: "upsert", data: INPUT("in_99", "断线前发的", 700) });
  store.ev({ t: "ev", seq: 12, ts: 701, entity: "approval", id: "ap_1", op: "upsert", data: APPROVAL(1, { status: "rejected" }) });
  assert.equal((await p1).ok, true);
  assert.equal((await p2).ok, true);
});

test("synchronous drop + immediate reconnect still resends the dropped write", async () => {
  const store = new Store();
  store.bootstrap(boot(10));
  const conn = new FakeConn();
  const writes = new Writes({ conn, store, newId: () => "op_sync_00000001" });
  const actions = makeActions(writes, store, () => "dev_self");

  const p = actions.stopRun("r_1");
  // Drop and reconnect synchronously before the rejection microtask runs
  conn.drop();
  conn.reconnect();
  await flush();
  assert.equal(conn.sent.length, 2, "resent even when reconnect beat the rejection microtask");
  assert.equal(conn.sent[1]!.client_op_id, "op_sync_00000001");
  conn.answer(1, 200, { run: { id: "r_1" }, stopped: true });
  assert.equal((await p).ok, true);
});

test("presence (kind none): no client_op_id, never queued offline; markRead is monotonic; clear drops all", async () => {
  const store = new Store();
  store.bootstrap(boot(10));
  const conn = new FakeConn();
  let n = 0;
  const writes = new Writes({ conn, store, newId: () => `op_misc_0000000${++n}` });
  const actions = makeActions(writes, store, () => "dev_self", () => 800);

  // Presence: no client_op_id
  const p = actions.presence({ foreground: true, viewing: "thread:th_w1" });
  assert.equal(conn.sent[0]!.client_op_id, undefined);
  conn.answer(0, 200, { present: true });
  assert.equal((await p).ok, true);

  // Presence offline: immediate failure, not queued
  conn.drop();
  const off = await actions.presence({ foreground: false });
  assert.equal(off.ok, false);
  assert.equal(writes.ops().length, 0);
  conn.reconnect();

  // markRead monotonic
  const r1 = actions.markRead("thread", "th_w1", 500);
  assert.ok(r1);
  assert.equal(store.get("read", "thread:th_w1")?.data.upto_ts, 500);
  assert.equal(actions.markRead("thread", "th_w1", 400), null, "never moves backward");
  assert.equal(actions.markRead("thread", "th_w1", 500), null, "no-op at same ts");
  const r2 = actions.markRead("thread", "th_w1", 600);
  assert.ok(r2);

  // clear() (unpair) drops overlays and resolves pending writes as unpaired
  writes.clear();
  const res1 = await r1;
  assert.equal(res1.ok, false);
  if (!res1.ok) assert.equal(res1.error, "unpaired");
  assert.equal(store.get("read", "thread:th_w1"), undefined);
});

test("htmlRefOf and pullAndOpenHtml: parses refs, pulls chunks, guards size/empty/offset/opener", async () => {
  const bytes = Buffer.from("<!doctype html><h1>报告</h1>", "utf8");
  const sha = createHash("sha256").update(bytes).digest("hex");

  assert.deepEqual(htmlRefOf({ ref: `blob:${sha}`, name: "report.HTML", size: bytes.length }), { sha, name: "report.HTML", size: bytes.length });
  assert.deepEqual(htmlRefOf({ html: { ref: `blob:${sha}`, name: "view.htm", size: 12 } }), { sha, name: "view.htm", size: 12 });
  assert.equal(htmlRefOf({ ref: `blob:${sha}`, name: "diff.patch", size: 10 }), null);
  assert.equal(htmlRefOf({ ref: "blob:short", name: "a.html", size: 10 }), null);

  // Multi-chunk pull
  let opened: { sha: string; bytes: Uint8Array } | null = null;
  const ok = await pullAndOpenHtml({ sha, name: "report.html", size: bytes.length }, {
    chunkBytes: 10,
    request: async (_m, path, opts) => {
      assert.equal(path, `/api/v1/blobs/${sha}`);
      const off = Number(opts?.query?.offset ?? 0);
      const len = Number(opts?.query?.len ?? 10);
      const slice = bytes.subarray(off, off + len);
      const next = off + slice.length < bytes.length ? off + slice.length : null;
      return { status: 200, body: { sha, total: bytes.length, offset: off, data_b64: slice.toString("base64"), next_offset: next } };
    },
    open: async (s, b) => { opened = { sha: s, bytes: b }; return true; },
  });
  assert.deepEqual(ok, { ok: true });
  assert.equal(opened!.sha, sha);
  assert.equal(Buffer.from(opened!.bytes).toString("utf8"), bytes.toString("utf8"));

  // Missing opener (e.g. Android before FileProvider)
  const noOpener = await pullAndOpenHtml({ sha, name: "report.html", size: 10 }, { request: async () => ({ status: 200 }), open: undefined });
  assert.equal(noOpener.ok, false);

  // Non-advancing next_offset refused (no infinite loop)
  const badOff = await pullAndOpenHtml({ sha, name: "report.html", size: 10 }, {
    request: async () => ({ status: 200, body: { sha, total: 10, offset: 0, data_b64: Buffer.from("hi").toString("base64"), next_offset: 0 } }),
    open: async () => true,
  });
  assert.equal(badOff.ok, false);

  // Over maxBytes refused before calling request
  let called = false;
  const tooBig = await pullAndOpenHtml({ sha, name: "huge.html", size: 999 }, {
    maxBytes: 100,
    request: async () => { called = true; return { status: 200 }; },
    open: async () => true,
  });
  assert.equal(tooBig.ok, false);
  assert.equal(called, false);
});
