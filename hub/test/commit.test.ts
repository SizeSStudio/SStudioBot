// The commitment check in someone else's conversation (§底3.4): clean → the reply goes out; a hit → a send approval
// with the reasons on the card and gate.yaml's fixed holding line to the other side (and the timeout line when the
// card expires); a check that fails or isn't wired → the same as a hit. The `reply` tool goes the same way; the typed
// and system columns are never checked. Also the real checker through the proxy to a fake light tier.
// Fictional people, chats and texts only.
import { test } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import { until, w1dHome } from "./w1d-helpers.ts";
import { fakeLlm } from "./fake-llm.ts";
import { openDb, type Db } from "../src/db/db.ts";
import { ingest, type Ingest } from "../src/inbox.ts";
import { Dispatcher } from "../src/dispatch.ts";
import { registerBuiltinTools } from "../src/tools/builtin.ts";
import { callTool, toolNamed, type ToolCtx } from "../src/tools/registry.ts";
import { sweepApprovals } from "../src/approvals.ts";
import { parseCheck, proxyCommitChecker, CHECK_SYSTEM, type CommitChecker } from "../src/commit-check.ts";
import { startProxy } from "../src/proxy.ts";
import { DEFAULTS } from "../src/config/schemas.ts";
import { setAdminSink } from "../src/notify.ts";
import type { RunOpts, RunResult, Runner } from "../src/runner/types.ts";

registerBuiltinTools();
const HOLD = DEFAULTS.gate.hold_text, TIMEOUT = DEFAULTS.gate.hold_timeout_text;
const DRAFT = "好的，周五下午三点我一定到，费用我来出。";

class ScriptRunner implements Runner {
  calls: RunOpts[] = [];
  out: (o: RunOpts) => Promise<Partial<RunResult>> | Partial<RunResult>;
  constructor(out: ScriptRunner["out"]) { this.out = out; }
  async run(o: RunOpts): Promise<RunResult> {
    this.calls.push(o);
    const r = await this.out(o);
    return { output: "", fullText: r.output ?? "", session_ref: "", stop: "done", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, tools: [], undelivered: [], ...r };
  }
  async steer() { return false; }
}

async function setup(runner: Runner, commitCheck?: CommitChecker) {
  const h = await w1dHome("commit");
  const db = openDb(h.db);
  const notes: string[] = [];
  setAdminSink((t) => { notes.push(t); });
  const d = new Dispatcher({ db, h, runner, commitCheck });
  return { h, db, d, notes, async done() { await d.stop(1000); db.close(); } };
}

let seq = 0;
const theirs = (text: string): Ingest => ({
  lane: "fake:dm:oc_fakeother1", kind: "user", source: "fake", source_msg_id: `o${++seq}`,
  payload: { text, sender_name: "阿乙" }, turn: { channel: "fake", surface: "fake:dm", chat: "oc_fakeother1", msg_id: `om_fake${seq}` },
});
const mine = (text: string): Ingest => ({ lane: "client:main", kind: "user", source: "client", source_msg_id: `m${++seq}`, payload: { text }, turn: { channel: "client", surface: "client" }, device_id: "cli" });
const outTexts = (db: Db, chat = "oc_fakeother1") =>
  db.all<{ payload: string; t: string }>("SELECT payload, target_json AS t FROM outbox WHERE kind = 'text' ORDER BY id").filter((r) => JSON.parse(r.t).chat === chat).map((r) => r.payload);
const approvals = (db: Db) => db.all<{ id: number; kind: string; status: string; draft: string; checks_json: string | null; context_json: string | null; channel: string }>("SELECT * FROM approvals ORDER BY id");

test("parseCheck: clean, flagged, contradictory, malformed", () => {
  assert.deepEqual(parseCheck('{"promise":false,"stance":false,"private":false,"hits":[]}'), { hits: [] });
  assert.deepEqual(parseCheck('好的：{"promise":true,"stance":false,"private":false,"hits":["周五三点到"]}').hits, ["替我答应了时间、钱或事情", "周五三点到"]);
  assert.equal(parseCheck('{"promise":false,"stance":false,"private":false,"hits":["说不清"]}').hits.length, 1, "hits without a flag still count");
  assert.throws(() => parseCheck("没问题"));
  assert.throws(() => parseCheck('{"promise":false}'));
  assert.throws(() => parseCheck("{not json}"));
});

test("others, check clean: the final answer goes out as it is, no approval", async () => {
  const seen: string[] = [];
  const s = await setup(new ScriptRunner(() => ({ output: "收到，我转告一下。" })), async (d) => { seen.push(d); return { hits: [] }; });
  ingest(s.db, theirs("在吗？"));
  s.d.start(50);
  await s.d.idle();
  assert.deepEqual(seen, ["收到，我转告一下。"]);
  assert.deepEqual(outTexts(s.db), ["收到，我转告一下。"]);
  assert.equal(approvals(s.db).length, 0);
  assert.equal(s.db.one<{ n: number }>("SELECT side_effects AS n FROM runs")!.n, 1);
  await s.done();
});

test("others, check hits: a send approval with the reasons, the fixed holding line out, the draft not; expiry sends the timeout line once", async () => {
  const s = await setup(new ScriptRunner(() => ({ output: DRAFT })), async () => ({ hits: ["替我答应了时间、钱或事情", "周五下午三点"] }));
  ingest(s.db, theirs("周五能来吗？"));
  s.d.start(50);
  await s.d.idle();
  const [a] = approvals(s.db);
  assert.ok(a);
  assert.equal(a.kind, "send");
  assert.equal(a.status, "pending");
  assert.equal(a.draft, DRAFT);
  assert.equal(a.channel, "fake");
  assert.deepEqual(JSON.parse(a.checks_json!).hits, ["替我答应了时间、钱或事情", "周五下午三点"]);
  assert.equal(JSON.parse(a.context_json!).hold, true);
  assert.deepEqual(outTexts(s.db), [HOLD], "only the fixed line went to them");
  // the card shows why
  const { cardOf } = await import("../src/approvals.ts");
  assert.ok(cardOf(s.db.one("SELECT * FROM approvals")!).lines.some((l) => l.includes("承诺检测") && l.includes("周五下午三点")));
  // the card times out: the fixed timeout line, once
  const later = Date.now() + 24 * 3600_000;
  assert.equal(sweepApprovals(s.db, later), 1);
  sweepApprovals(s.db, later + 1);
  assert.equal(approvals(s.db)[0]!.status, "expired");
  assert.deepEqual(outTexts(s.db), [HOLD, TIMEOUT]);
  assert.ok(!outTexts(s.db).includes(DRAFT));
  await s.done();
});

test("others, check fails or isn't wired: treated as a hit (fail closed)", async () => {
  const broken = await setup(new ScriptRunner(() => ({ output: DRAFT })), async () => { throw new Error("upstream 529"); });
  ingest(broken.db, theirs("周五能来吗？"));
  broken.d.start(50);
  await broken.d.idle();
  assert.equal(approvals(broken.db).length, 1);
  assert.match(JSON.parse(approvals(broken.db)[0]!.checks_json!).hits[0], /承诺检测没跑成.*upstream 529.*按命中处理/);
  assert.deepEqual(outTexts(broken.db), [HOLD]);
  await broken.done();

  const none = await setup(new ScriptRunner(() => ({ output: DRAFT })));
  ingest(none.db, theirs("周五能来吗？"));
  none.d.start(50);
  await none.d.idle();
  assert.equal(approvals(none.db).length, 1);
  assert.deepEqual(outTexts(none.db), [HOLD]);
  await none.done();
});

test("the reply tool in someone else's conversation goes through the same check", async () => {
  const s = await setup(new ScriptRunner(() => ({})));
  let verdict: string[] = [];
  const ctx: ToolCtx = {
    db: s.db, h: s.h, run_id: "r_commit_tool", lane: "fake:dm:oc_fakeother1", src: "other@fake:dm", col: "others",
    turn: { channel: "fake", surface: "fake:dm", chat: "oc_fakeother1" }, replies: 0, commitCheck: async () => ({ hits: verdict }),
  };
  s.db.run("INSERT INTO runs(id, lane, session_key, role, tier, status, started) VALUES ('r_commit_tool', ?, ?, 'main', 'chat', 'running', ?)", ctx.lane, ctx.lane, Date.now());
  const reply = toolNamed("reply")!;
  assert.equal(await callTool(reply, { text: "稍等，我看一下。" }, ctx), "已排进发件箱");
  verdict = ["代表我表态"];
  const out = await callTool(reply, { text: "这件事我同意老王的方案。" }, ctx);
  assert.match(out, /已转审批 #\d+/);
  assert.match(out, /代表我表态/);
  assert.deepEqual(outTexts(s.db), ["稍等，我看一下。", HOLD]);
  assert.equal(approvals(s.db)[0]!.draft, "这件事我同意老王的方案。");
  assert.equal(ctx.replies, 2, "either way the final answer isn't sent on top");
  assert.equal(s.db.one<{ n: number }>("SELECT side_effects AS n FROM runs")!.n, 2, "each call counted once");
  await s.done();
});

test("typed and system columns are never checked", async () => {
  let calls = 0;
  const s = await setup(new ScriptRunner(() => ({ output: DRAFT })), async () => { calls++; throw new Error("should not run"); });
  ingest(s.db, mine("帮我回个话"));
  ingest(s.db, { lane: "job:fake", kind: "timer", source: "timer", source_msg_id: "t1", payload: { text: "早报", job: "fake" } });
  s.d.start(50);
  await s.d.idle();
  assert.equal(calls, 0);
  assert.equal(approvals(s.db).length, 0);
  assert.equal(s.db.one<{ n: number }>("SELECT COUNT(*) AS n FROM outbox WHERE kind = 'text' AND payload = ?", DRAFT)!.n, 2);
  await s.done();
});

test("an error in someone else's conversation goes to the admin outlet, not to them", async () => {
  const s = await setup(new ScriptRunner(() => ({ stop: "error", error: "TypeError: x is undefined at /home/fake/sbot/hub/src/a.ts" })), async () => ({ hits: [] }));
  ingest(s.db, theirs("在吗？"));
  s.d.start(50);
  await s.d.idle();
  assert.deepEqual(outTexts(s.db), []);
  assert.ok(s.notes.some((n) => n.includes("这一轮出错了")));
  await s.done();
});

test("the real checker: one light request through the proxy; a garbled answer throws; the token is revoked", async () => {
  let answer = '{"promise":true,"stance":false,"private":false,"hits":["周五三点到"]}';
  const llm = await fakeLlm(() => ({ text: answer }));
  const h = await w1dHome("commit-proxy", { port: llm.port });
  const db = openDb(h.db);
  const proxy: Server = await startProxy(db, h.blobs, 0);
  try {
    db.run("INSERT INTO runs(id, lane, session_key, role, tier, status, started) VALUES ('r_commit_px', 'fake:dm:oc_fakeother1', 'fake:dm:oc_fakeother1', 'main', 'chat', 'running', ?)", Date.now());
    const check = proxyCommitChecker(db, `http://127.0.0.1:${(proxy.address() as { port: number }).port}/llm`);
    const r = await check(DRAFT, { run_id: "r_commit_px", lane: "fake:dm:oc_fakeother1" });
    assert.deepEqual(r.hits, ["替我答应了时间、钱或事情", "周五三点到"]);
    const req = llm.seen[0]!.body;
    assert.equal(req.model, "claude-fake-light");
    assert.equal(req.system, CHECK_SYSTEM);
    assert.equal(req.messages[0].content, DRAFT);
    answer = "看起来没问题";
    await assert.rejects(check(DRAFT, { run_id: "r_commit_px", lane: "fake:dm:oc_fakeother1" }), /JSON/);
    await until(() => db.one<{ n: number }>("SELECT COUNT(*) AS n FROM usage WHERE tier = 'light'")!.n === 2, 5_000, "metered");
    assert.equal(db.one<{ n: number }>("SELECT COUNT(*) AS n FROM run_tokens WHERE status = 'active'")!.n, 0);
  } finally {
    await new Promise<void>((r) => proxy.close(() => r()));
    proxy.closeAllConnections?.();
    db.close();
    await llm.close();
  }
});
