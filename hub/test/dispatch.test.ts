// Inbox → runs (03 「inbox 和 run」, §底1.2) with a scripted runner: dedupe, batches of at most 50, labels and columns,
// self/ refused for timer/approval/task/system runs, steer and /stop, /new, restart recovery, the breaker, upstream
// retry for scheduled rows. Fictional data only.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { until, w1dHome } from "./w1d-helpers.ts";
import { openDb, type Db } from "../src/db/db.ts";
import { ingest, withdraw, type Ingest } from "../src/inbox.ts";
import { Dispatcher } from "../src/dispatch.ts";
import { registerBuiltinTools } from "../src/tools/builtin.ts";
import { callTool, toolNamed } from "../src/tools/registry.ts";
import { setAdminSink } from "../src/notify.ts";
import type { RunOpts, RunResult, Runner } from "../src/runner/types.ts";

registerBuiltinTools();

type Script = (o: RunOpts, n: number) => Promise<Partial<RunResult>> | Partial<RunResult>;

class FakeRunner implements Runner {
  calls: RunOpts[] = [];
  steered: { lane: string; text: string; id: number }[] = [];
  live = new Set<string>();
  script: Script;
  constructor(script: Script = () => ({ output: "好。" })) { this.script = script; }
  async run(o: RunOpts): Promise<RunResult> {
    const n = this.calls.push(o) - 1;
    this.live.add(o.lane);
    try {
      const r = await this.script(o, n);
      return { output: "", fullText: r.output ?? "", session_ref: `sess-${o.lane}`, stop: "done", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, tools: [], undelivered: [], ...r };
    } finally { this.live.delete(o.lane); }
  }
  async steer(lane: string, text: string, id: number) {
    if (!this.live.has(lane)) return false;
    this.steered.push({ lane, text, id });
    return true;
  }
}

async function setup(runner: Runner, batchMax?: number) {
  const h = await w1dHome("dispatch", { port: 1 });
  const db = openDb(h.db);
  mkdirSync(join(h.agentHome, "self"), { recursive: true });
  writeFileSync(join(h.agentHome, "self", "rhythm.md"), "虚构：早起。\n");
  const notes: string[] = [];
  setAdminSink((t) => { notes.push(t); });
  const d = new Dispatcher({ db, h, runner, batchMax });
  return { h, db, d, notes, async done() { await d.stop(1000); db.close(); } };
}

let seq = 0;
const mine = (lane: string, text: string, extra: Partial<Ingest> = {}): Ingest =>
  ({ lane, kind: "user", source: "client", source_msg_id: `c${++seq}`, payload: { text }, turn: { channel: "client", surface: "client" }, device_id: "cli", ...extra });
const texts = (db: Db) => db.all<{ payload: string }>("SELECT payload FROM outbox WHERE kind = 'text' ORDER BY id").map((r) => r.payload);

test("dedupe, and a run takes at most 50 rows", async () => {
  const r = new FakeRunner();
  const s = await setup(r);
  const first = ingest(s.db, mine("client:main", "一", { source_msg_id: "dup-1" }));
  const again = ingest(s.db, mine("client:main", "一", { source_msg_id: "dup-1" }));
  assert.equal(again.dup, true);
  assert.equal(again.id, first.id);
  for (let i = 0; i < 59; i++) ingest(s.db, mine("client:main", `第${i}条`));
  s.d.start(50);
  await s.d.idle();
  assert.equal(r.calls.length, 2);
  assert.equal(r.calls[0]!.input.split("\n").length, 50);
  assert.equal(r.calls[1]!.input.split("\n").length, 10);
  assert.equal(s.db.one<{ n: number }>("SELECT COUNT(*) AS n FROM inbox WHERE status = 'done'")!.n, 60);
  assert.deepEqual(texts(s.db), ["好。", "好。"]);
  await s.done();
});

test("labels and columns per source; timer/approval/task/system runs can't read self/ whole", async () => {
  const seen: Record<string, { src: string; col: string; tools: string[]; self: string }> = {};
  const r = new FakeRunner(async (o) => {
    const self = await callTool(toolNamed("memory_read")!, { path: "self/rhythm.md" }, o.ctx);
    seen[o.lane] = { src: o.ctx.src, col: o.ctx.col, tools: o.tools.map((t) => t.name).sort(), self };
    return { output: "" };
  });
  const s = await setup(r);
  ingest(s.db, mine("client:main", "我"));
  ingest(s.db, { lane: "feishu:dm", kind: "user", source: "feishu", source_msg_id: "om_a", payload: { text: "我也是", owner: true }, turn: { channel: "feishu", surface: "feishu:dm" } });
  ingest(s.db, { lane: "feishu:chat:oc_fake", kind: "user", source: "feishu", source_msg_id: "om_b", payload: { text: "别人", sender_name: "阿乙" }, turn: { channel: "feishu", surface: "feishu:chat" } });
  ingest(s.db, { lane: "job:morning", kind: "timer", source: "timer", source_msg_id: "t1", payload: { text: "早报", job: "morning" } });
  ingest(s.db, { lane: "sys:approval", kind: "approval", source: "approval", source_msg_id: "1:approve", payload: { text: "批了" } });
  ingest(s.db, { lane: "sys:task", kind: "task", source: "task", source_msg_id: "task1", payload: { text: "任务完成" } });
  ingest(s.db, { lane: "sys:system", kind: "system", source: "system", source_msg_id: "sys1", payload: { text: "节点上线" } });
  s.d.start(50);
  await s.d.idle();
  assert.equal(seen["client:main"]!.src, "owner@client");
  assert.equal(seen["feishu:dm"]!.src, "owner@feishu:dm");
  assert.equal(seen["feishu:chat:oc_fake"]!.src, "other@feishu:chat");
  assert.equal(seen["job:morning"]!.src, "job@morning");
  assert.equal(seen["sys:approval"]!.src, "system@approval");
  assert.equal(seen["sys:task"]!.src, "system@task");
  assert.equal(seen["sys:system"]!.src, "system@system");
  for (const l of ["client:main", "feishu:dm"]) { assert.equal(seen[l]!.col, "typed"); assert.match(seen[l]!.self, /早起/); assert.ok(seen[l]!.tools.includes("bash")); }
  for (const l of ["job:morning", "sys:approval", "sys:task", "sys:system"]) {
    assert.equal(seen[l]!.col, "system", l);
    assert.match(seen[l]!.self, /^error: .*self_list/, l);
    assert.deepEqual(seen[l]!.tools, ["memory_read", "reply", "send"], l);
  }
  assert.equal(seen["feishu:chat:oc_fake"]!.col, "others");
  assert.match(seen["feishu:chat:oc_fake"]!.self, /^error: /);
  // another person's message is labelled in the turn text
  assert.match(r.calls.find((c) => c.lane === "feishu:chat:oc_fake")!.input, /（阿乙） 别人/);
  assert.match(r.calls.find((c) => c.lane === "job:morning")!.input, /（定时器） 早报/);
  await s.done();
});

test("steer while running, then /stop: unseen steers dropped, 「已停下」", async () => {
  // the first run waits until it is stopped; the next one (the queued message) answers at once
  const r = new FakeRunner((o, n) => n > 0 ? { output: "轮到别人" } : new Promise((ok) => {
    o.signal.addEventListener("abort", () => ok({ output: "不该发", stop: "aborted", undelivered: r.steered.slice(1).map((x) => x.id) }));
  }));
  const s = await setup(r);
  s.d.start(30);
  ingest(s.db, mine("client:main", "开始"));
  await until(() => r.live.has("client:main"), 5000, "run start");
  // another person's message waits; mine are steered in
  ingest(s.db, { lane: "client:main", kind: "user", source: "feishu", source_msg_id: "om_x", payload: { text: "别人插话" } });
  const a = ingest(s.db, mine("client:main", "补充一"));
  const b = ingest(s.db, mine("client:main", "补充二"));
  await until(() => r.steered.length === 2, 5000, "steers");
  assert.match(r.steered[0]!.text, /补充一/);
  ingest(s.db, mine("client:main", "/stop", { kind: "command" }));
  await until(() => r.calls.length === 2, 5000, "the waiting row runs next");
  await s.d.idle();
  const st = (id: number) => s.db.one<{ s: string }>("SELECT status AS s FROM inbox WHERE id = ?", id)!.s;
  assert.equal(st(a.id), "done", "seen by the model");
  assert.equal(st(b.id), "dropped", "never seen: dropped with the stop");
  assert.equal(s.db.one<{ s: string }>("SELECT status AS s FROM runs ORDER BY started LIMIT 1")!.s, "aborted");
  assert.ok(texts(s.db).includes("（已停下）"));
  assert.ok(!texts(s.db).includes("不该发"));
  assert.match(r.calls[1]!.input, /别人插话/);
  await s.done();
});

test("/stop with nothing running, /new rolls the session, a withdrawn row stops its run", async () => {
  const r = new FakeRunner((o) => (o.input.includes("慢") ? new Promise((ok) => o.signal.addEventListener("abort", () => ok({ stop: "aborted" }))) : { output: "嗯" }));
  const s = await setup(r);
  s.d.start(30);
  ingest(s.db, mine("client:main", "/stop", { kind: "command" }));
  await until(() => texts(s.db).includes("现在没有在跑的。"), 5000, "stop reply");
  ingest(s.db, mine("client:main", "一句"));
  await s.d.idle();
  assert.equal(s.db.one<{ r: string }>("SELECT session_ref AS r FROM sessions WHERE key = 'client:main'")!.r, "sess-client:main");
  ingest(s.db, mine("client:main", "/new", { kind: "command" }));
  await until(() => texts(s.db).includes("好，新开一段。"), 5000, "new");
  const sess = s.db.one<{ r: string | null; g: number }>("SELECT session_ref AS r, generation AS g FROM sessions WHERE key = 'client:main'")!;
  assert.equal(sess.r, null);
  ingest(s.db, mine("client:main", "慢慢来", { source_msg_id: "slow-1" }));
  await until(() => r.live.has("client:main"), 5000, "slow run");
  withdraw(s.db, "client", "slow-1");
  await until(() => !r.live.has("client:main"), 5000, "withdrawn stops");
  await s.d.idle();
  await s.done();
});

test("restart: no side effects → rerun; side effects → interrupted + how many went out; twice → failed", async () => {
  const r = new FakeRunner();
  const s = await setup(r);
  const { db } = s;
  const now = Date.now();
  db.run("INSERT INTO runs(id, lane, role, tier, status, side_effects, started) VALUES ('r_clean', 'client:a', 'main', 'chat', 'running', 0, ?), ('r_dirty', 'client:b', 'main', 'chat', 'running', 2, ?)", now, now);
  const a = ingest(db, mine("client:a", "没动过"));
  const b = ingest(db, mine("client:b", "动过了"));
  const c = ingest(db, mine("client:c", "又崩"));
  db.run("UPDATE inbox SET status = 'processing', run_id = 'r_clean', tries = 1 WHERE id = ?", a.id);
  db.run("UPDATE inbox SET status = 'processing', run_id = 'r_dirty', tries = 1 WHERE id = ?", b.id);
  db.run("UPDATE inbox SET status = 'processing', run_id = 'r_clean', tries = 2 WHERE id = ?", c.id);
  db.run("INSERT INTO run_tokens(hash, run_id, tier, status) VALUES ('h1', 'r_dirty', 'chat', 'active')");
  // r_dirty had sent one message and failed another
  db.run("INSERT INTO outbox(run_id, lane, channel, kind, target_json, payload, idem_key, status, ts) VALUES ('r_dirty', 'client:b', 'client', 'text', '{}', '先说一句', 'k-a', 'sent', ?), ('r_dirty', 'client:b', 'feishu', 'text', '{}', 'x', 'k-b', 'failed', ?)", now, now);
  const out = s.d.recover();
  assert.deepEqual(out, { requeued: 1, interrupted: 1, failed: 1 });
  const st = (id: number) => db.one<{ s: string }>("SELECT status AS s FROM inbox WHERE id = ?", id)!.s;
  assert.deepEqual([st(a.id), st(b.id), st(c.id)], ["received", "interrupted", "failed"]);
  assert.equal(db.one<{ n: number }>("SELECT COUNT(*) AS n FROM runs WHERE status = 'interrupted'")!.n, 2);
  assert.equal(db.one<{ s: string }>("SELECT status AS s FROM run_tokens WHERE hash = 'h1'")!.s, "revoked");
  const notice = db.one<{ payload: string; run_id: string | null; lane: string }>("SELECT payload, run_id, lane FROM outbox WHERE payload LIKE '我刚才被重启了%'")!;
  assert.match(notice.payload, /已经发出 1 条消息，不会重发/);
  assert.equal(notice.run_id, null, "the notice is nobody's side effect");
  assert.equal(notice.lane, "client:b");
  await new Promise((r) => setTimeout(r, 10));
  assert.ok(s.notes.some((n) => n.includes("连着崩了两次") && n.includes("又崩")));
  s.d.start(30);
  await s.d.idle();
  assert.equal(r.calls.length, 1, "only the clean one runs again");
  assert.match(r.calls[0]!.input, /没动过/);
  await s.done();
});

test("breaker: the same error 3 times stops the loop for what I didn't type; a good run clears it", async () => {
  let fail = true;
  const r = new FakeRunner(() => (fail ? { stop: "error", error: "TypeError: cannot read x of undefined (id 4821)" } : { output: "好了" }));
  const s = await setup(r);
  s.d.start(30);
  for (let i = 0; i < 3; i++) { ingest(s.db, mine("client:main", `试${i}`)); await s.d.idle(); }
  assert.ok(s.db.kvGet("breaker.client:main"));
  const card = s.db.one<{ kind: string; title: string }>("SELECT kind, title FROM approvals")!;
  assert.equal(card.kind, "glance");
  assert.match(card.title, /连着 3 次同样的错/);
  // a scheduled row on that lane is not run while the breaker is set
  const t = ingest(s.db, { lane: "client:main", kind: "timer", source: "timer", source_msg_id: "tb1", payload: { text: "定时", job: "x" } });
  await s.d.idle();
  assert.equal(s.db.one<{ s: string }>("SELECT status AS s FROM inbox WHERE id = ?", t.id)!.s, "failed");
  assert.equal(r.calls.length, 3);
  fail = false;
  ingest(s.db, mine("client:main", "再来"));
  await s.d.idle();
  assert.equal(s.db.kvGet("breaker.client:main"), undefined);
  assert.equal(s.db.one<{ n: number }>("SELECT COUNT(*) AS n FROM approvals")!.n, 1, "one card, not one per failure");
  await s.done();
});

test("errors: a system-column run tells the admin outlet; a scheduled row that hit upstream waits and retries", async () => {
  const r = new FakeRunner((o) => (o.lane === "job:a" ? { stop: "error", error: "RangeError: bad thing" } : { stop: "error", error: "529 overloaded" }));
  const s = await setup(r);
  s.d.start(30);
  ingest(s.db, { lane: "job:a", kind: "timer", source: "timer", source_msg_id: "ta", payload: { text: "跑", job: "a" } });
  const up = ingest(s.db, { lane: "job:b", kind: "timer", source: "timer", source_msg_id: "tb", payload: { text: "跑", job: "b" } });
  await until(() => r.calls.length === 2, 5000, "both ran");
  await new Promise((ok) => setTimeout(ok, 100));
  assert.ok(s.notes.some((n) => n.startsWith("job:a：这一轮出错了")));
  assert.equal(texts(s.db).length, 0, "nothing is replied to a job");
  const row = s.db.one<{ status: string; not_before: number; payload_json: string }>("SELECT * FROM inbox WHERE id = ?", up.id)!;
  assert.equal(row.status, "received");
  assert.ok(row.not_before > Date.now());
  assert.equal(JSON.parse(row.payload_json).retry.n, 1);
  assert.equal(s.db.one<{ r: string }>("SELECT stop_reason AS r FROM runs WHERE lane = 'job:b'")!.r, "upstream_retry");
  await s.done();
});
