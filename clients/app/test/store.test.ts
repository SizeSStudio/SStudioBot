// The store's rules (07 「store」, protocol/api/stream.ts): newest seq wins, deletes, live text by chunk_seq with
// snapshots after a gap, lanes and versions. Fictional data.
import { test } from "node:test";
import assert from "node:assert/strict";
import { Store } from "../src/store/store.ts";
import type { BootstrapRes } from "../../../protocol/api/stream.ts";

const LANE = "console:t:th_s1";
const thread = { id: "th_s1", lane: LANE, kind: "general", domain: "work", title: "样稿", matter_id: null, task_id: null, status: "open", pinned: false, created_at: 1, last_item_at: 2 };
const input = (id: string, text: string, ts: number) => ({ id, lane: LANE, kind: "user", source: "client", status: "done", run_id: null, device_id: null, text, sender_name: null, owner: true, ts });
const run = (id: string, status: string) => ({ id, lane: LANE, role: "main", tier: "chat", model: null, status, stop_reason: null, error: null, task_id: null, device_id: null, started: 5, ended: null });
const boot = (seq: number): BootstrapRes => ({
  seq, threads: [thread], runs: [run("r_1", "running")], approvals: [], tasks: [], devices: [],
  timelines: { th_s1: { entries: [{ entity: "input", id: "1", ts: 3, data: input("1", "第一句", 3) }, { entity: "weird", id: "x", ts: 4, data: {} }], next_before: "c1" } },
});

test("bootstrap fills rows, lanes and paging; unknown timeline entities are skipped", () => {
  const s = new Store();
  s.bootstrap(boot(10));
  assert.equal(s.seq, 10);
  assert.ok(s.loaded);
  assert.equal(s.threadByLane(LANE)?.data.title, "样稿");
  assert.deepEqual(s.timeline(LANE).map((r) => r.id), ["1"]);
  assert.equal(s.nextBefore("th_s1"), "c1");
});

test("an ev not newer than what we hold is dropped; delete removes; unknown entity moves the cursor only", () => {
  const s = new Store();
  s.bootstrap(boot(10));
  s.ev({ t: "ev", seq: 12, ts: 0, entity: "input", id: "1", op: "upsert", data: input("1", "改过", 3) });
  s.ev({ t: "ev", seq: 11, ts: 0, entity: "input", id: "1", op: "upsert", data: input("1", "旧的", 3) });
  assert.equal(s.get("input", "1")?.data.text, "改过");
  s.ev({ t: "ev", seq: 13, ts: 0, entity: "input", id: "2", op: "upsert", data: input("2", "第二句", 4) });
  assert.deepEqual(s.timeline(LANE).map((r) => r.id), ["1", "2"]);
  s.ev({ t: "ev", seq: 14, ts: 0, entity: "input", id: "2", op: "delete" });
  assert.deepEqual(s.timeline(LANE).map((r) => r.id), ["1"]);
  s.ev({ t: "ev", seq: 20, ts: 0, entity: "future_thing", id: "z", op: "upsert", data: {} });
  assert.equal(s.seq, 20);
  s.beat(25);
  assert.equal(s.seq, 25);
  s.beat(3);
  assert.equal(s.seq, 25, "the cursor never goes back");
});

test("a row that doesn't fit its schema is skipped, not half-shown", () => {
  const s = new Store();
  s.bootstrap(boot(1));
  s.ev({ t: "ev", seq: 2, ts: 0, entity: "input", id: "9", op: "upsert", data: { id: "9", text: 5 } });
  assert.equal(s.get("input", "9"), undefined);
});

test("live text: chunks in order append; a repeat is ignored; a gap waits for the snapshot", () => {
  const s = new Store();
  s.bootstrap(boot(1));
  const d = (n: number, text: string) => s.delta({ t: "delta", run: "r_1", item: "r_1:a0", chunk_seq: n, text });
  d(1, "好"); d(2, "的"); d(2, "的");
  assert.equal(s.live("r_1", "r_1:a0")?.text, "好的");
  d(4, "见");
  d(5, "。");
  assert.equal(s.live("r_1", "r_1:a0")?.text, "好的", "after a gap nothing is taken");
  assert.equal(s.live("r_1", "r_1:a0")?.stale, true);
  s.snapshot({ t: "snapshot", run: "r_1", item: "r_1:a0", text: "好的，三点见。", chunk_seq: 5 });
  d(6, "还有");
  assert.equal(s.live("r_1", "r_1:a0")?.text, "好的，三点见。还有");
  assert.deepEqual(s.liveOn(LANE).map((l) => l.item), ["r_1:a0"]);
});

test("joining mid-way: a delta that isn't chunk 1 waits for a snapshot", () => {
  const s = new Store();
  s.bootstrap(boot(1));
  s.delta({ t: "delta", run: "r_1", item: "r_1:a0", chunk_seq: 3, text: "半截" });
  assert.equal(s.live("r_1", "r_1:a0")?.text, "");
  assert.equal(s.live("r_1", "r_1:a0")?.stale, true);
});

test("the finished row (live_key) and a stopped run both clear the streaming text", () => {
  const s = new Store();
  s.bootstrap(boot(1));
  s.delta({ t: "delta", run: "r_1", item: "r_1:a0", chunk_seq: 1, text: "写" });
  s.delta({ t: "delta", run: "r_1", item: "r_1:a1", chunk_seq: 1, text: "另一段" });
  s.ev({ t: "ev", seq: 2, ts: 0, entity: "item", id: "7", op: "upsert", data: {
    id: "7", lane: LANE, run_id: "r_1", kind: "assistant", status: "done", ts: 6, ended: 6, name: null, call_id: null,
    body: { text: "写完了" }, blob: null, truncated: false, live_key: "r_1:a0" } });
  assert.deepEqual(s.liveOn(LANE).map((l) => l.item), ["r_1:a1"]);
  s.ev({ t: "ev", seq: 3, ts: 0, entity: "run", id: "r_1", op: "upsert", data: run("r_1", "done") });
  assert.deepEqual(s.liveOn(LANE), []);
});

test("versions: a lane's key moves only for that lane; reset clears everything", () => {
  const s = new Store();
  s.bootstrap(boot(1));
  let calls = 0;
  const un = s.subscribe(() => calls++);
  const lane0 = s.version(`lane:${LANE}`), other0 = s.version("lane:console:t:other");
  s.ev({ t: "ev", seq: 2, ts: 0, entity: "input", id: "3", op: "upsert", data: input("3", "x", 9) });
  assert.equal(s.version(`lane:${LANE}`), lane0 + 1);
  assert.equal(s.version("lane:console:t:other"), other0);
  assert.equal(calls, 1);
  s.reset();
  assert.equal(s.seq, 0);
  assert.equal(s.loaded, false);
  assert.deepEqual(s.timeline(LANE), []);
  un();
});

test("an older page keeps rows we hold at a newer seq", () => {
  const s = new Store();
  s.bootstrap(boot(10));
  s.ev({ t: "ev", seq: 12, ts: 0, entity: "input", id: "1", op: "upsert", data: input("1", "新", 3) });
  s.page("th_s1", { seq: 11, thread, entries: [{ entity: "input", id: "1", ts: 3, data: input("1", "旧", 3) }, { entity: "input", id: "0", ts: 1, data: input("0", "更早", 1) }], next_before: null });
  assert.deepEqual(s.timeline(LANE).map((r) => (r.rec.data as { text: string }).text), ["更早", "新"]);
  assert.equal(s.nextBefore("th_s1"), null);
});
