// W3a: the /api/v1 write routes — client_ops idempotency, the three kinds (optimistic / confirmed / locked), approvals
// through the one `decide`, threads and personal isolation, device writes over a client connection. Every id, name
// and text here is made up.
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Req } from "../../protocol/frames.ts";
import { ApprovalRes, Conflict, MessageRes, SnoozeRes, ThreadRes, WRITES } from "../../protocol/api/write.ts";
import { openDb, type Db } from "../src/db/db.ts";
import { registerChannel, unregisterChannel } from "../src/channels/registry.ts";
import { createApi, type Api, type DispatchCaller } from "../src/api/index.ts";
import type { DeviceWrites, Runs } from "../src/api/writes.ts";
import { submitApproval, type ApprovalSpec } from "../src/approvals.ts";
import { cardRows } from "../src/channels/card-rows.ts";
import { cardReplies, channelCommands } from "../src/channels/commands.ts";
import { promptFiles } from "../src/runner/prompt.ts";
import { selfGuard } from "../src/tools/guard.ts";
import { privacyCol } from "../src/turn.ts";
import { router } from "../src/main.ts";
import { fakeChannel, OWNER_FEISHU, w1dHome } from "./w1d-helpers.ts";

const PHONE = "c".repeat(64);
const CLIENT: DispatchCaller = { device_id: PHONE, role: "client" };
const NODE: DispatchCaller = { device_id: "d".repeat(64), role: "node" };
let n = 0;
const opId = () => `op_${randomBytes(8).toString("hex")}`;
const req = (method: Req["method"], path: string, body?: unknown, client_op_id: string | undefined = opId()): Req =>
  ({ t: "req", id: ++n, method, path, ...(body !== undefined ? { body } : {}), ...(client_op_id ? { client_op_id } : {}) });

interface Setup { db: Db; api: Api; home: Awaited<ReturnType<typeof w1dHome>>; triaged: number[]; stops: string[]; done: () => void }
async function setup(tag: string, o: { runs?: Runs; devices?: DeviceWrites } = {}): Promise<Setup> {
  const home = await w1dHome(tag);
  const db = openDb(home.db);
  const feishu = fakeChannel("feishu");
  unregisterChannel("feishu");   // a failed test before this one may have left its own
  registerChannel(feishu);
  db.run("INSERT INTO devices(id, role, name, public_key, created_at) VALUES (?, 'client', 'phone', ?, ?), (?, 'node', 'mac', ?, ?)",
    PHONE, Buffer.alloc(32, 3), Date.now(), NODE.device_id, Buffer.alloc(32, 4), Date.now());
  const triaged: number[] = [], stops: string[] = [];
  const api = createApi({
    db, blobs: home.blobs, hubSha: () => "testsha", pump: { batch: 7, beatMs: 0 },
    runs: o.runs ?? { activeRun: () => undefined, stopLane: (l) => { stops.push(l); return false; } },
    devices: o.devices, redraftTriage: (id) => { triaged.push(id); },
  });
  return { db, api, home, triaged, stops, done: () => { unregisterChannel("feishu"); db.close(); } };
}

const SEND: ApprovalSpec = {
  kind: "send", title: "发给 oc_fakechat07", draft: "周四上午十点", channel: "feishu", target: { chat: "oc_fakechat07" }, as_identity: "user",
  origin_lane: "triage", trigger: { chat: "oc_fakechat07", msg_id: "om_fake_trigger7", ts: 1000 },
};
/** as if the Feishu plugin had sent the card (so a decision re-renders it there) */
const sentCard = (db: Db, id: number, msg = `om_card_${id}`) =>
  db.run("UPDATE approvals SET cards_json = ? WHERE id = ?", JSON.stringify([{ channel: "feishu", chat: "oc_fakeadmin", msg_id: msg }]), id);
const status = (db: Db, id: number) => db.one<{ s: string }>("SELECT status AS s FROM approvals WHERE id = ?", id)!.s;
const textRows = (db: Db, id: number) => db.one<{ n: number }>("SELECT COUNT(*) AS n FROM outbox WHERE approval_id = ? AND kind = 'text'", id)!.n;
const click = (db: Db, id: number, o: string, v?: number, operator = OWNER_FEISHU) =>
  cardRows(db)({ kind: "card", source: "feishu:card", payload_json: JSON.stringify({ operator, value: { k: "appr", id, o, ...(v !== undefined ? { v } : {}) } }) });

// ── authorization ─────────────────────────────────────────────────────────────────────────────────────────────
test("a node calling any write route is 403 and nothing is written; a write without client_op_id is 400", async () => {
  const s = await setup("w3a-node");
  const id = submitApproval(s.db, SEND);
  for (const route of Object.keys(WRITES)) {
    const [method, pattern] = route.split(" ") as [Req["method"], string];
    const path = pattern.replace(":id", method === "POST" && pattern.includes("approvals") ? String(id) : "x1234567");
    const out = await s.api.dispatch(req(method, path, { action: "approve", draft_version: 1, text: "hi", title: "t", until: "morning", role: "client" }), NODE);
    assert.equal(out.status, 403, route);
  }
  assert.equal(status(s.db, id), "pending");
  assert.equal(s.db.one<{ n: number }>("SELECT COUNT(*) AS n FROM client_ops")!.n, 0);
  assert.equal(s.db.one<{ n: number }>("SELECT COUNT(*) AS n FROM threads")!.n, 0);
  assert.equal((await s.api.dispatch(req("POST", "/api/v1/threads", { title: "x" }, ""), CLIENT)).status, 400);
  assert.equal((await s.api.dispatch(req("POST", "/api/v1/threads", { title: "x" }, "short"), CLIENT)).status, 400);
  s.done();
});

// ── client_ops ───────────────────────────────────────────────────────────────────────────────────────────────
test("idempotent resend: same op id → the stored answer and seq, applied once; another body under it → 409", async () => {
  const s = await setup("w3a-idem");
  const op = opId();
  const a = await s.api.dispatch(req("POST", "/api/v1/threads", { title: "周会准备" }, op), CLIENT);
  assert.equal(a.status, 200);
  const t = ThreadRes.parse(a.body).thread;
  assert.equal(t.kind, "general");
  assert.equal(t.domain, "work", "※ a general thread is work unless I say");
  assert.ok(a.seq && a.seq > 0);
  const b = await s.api.dispatch(req("POST", "/api/v1/threads", { title: "周会准备" }, op), CLIENT);
  assert.deepEqual([b.status, b.body, b.seq], [a.status, a.body, a.seq]);
  assert.equal(s.db.one<{ n: number }>("SELECT COUNT(*) AS n FROM threads")!.n, 1);
  const c = await s.api.dispatch(req("POST", "/api/v1/threads", { title: "别的" }, op), CLIENT);
  assert.equal(c.status, 409);
  assert.equal(s.db.one<{ n: number }>("SELECT COUNT(*) AS n FROM threads")!.n, 1);
  // key order doesn't matter; another device's op id is its own
  const p1 = await s.api.dispatch(req("PATCH", `/api/v1/threads/${t.id}`, { pinned: true, title: "周会" }, "op_patch_0001"), CLIENT);
  const p2 = await s.api.dispatch(req("PATCH", `/api/v1/threads/${t.id}`, { title: "周会", pinned: true }, "op_patch_0001"), CLIENT);
  assert.equal(p1.status, 200);
  assert.deepEqual(p2.body, p1.body);
  assert.equal(ThreadRes.parse(p1.body).thread.pinned, true);
  assert.equal((await s.api.dispatch(req("PATCH", `/api/v1/threads/${t.id}`, { title: "周会", pinned: true }, "op_patch_0001"), { device_id: "cli", role: "client" })).status, 200);
  assert.equal((await s.api.dispatch(req("PATCH", "/api/v1/threads/th_nope", { pinned: true }), CLIENT)).status, 404);
  s.done();
});

test("offline retry: a message resent with its op id is one input; another text under that id is 409", async () => {
  const s = await setup("w3a-msg");
  const t = ThreadRes.parse((await s.api.dispatch(req("POST", "/api/v1/threads", {}), CLIENT)).body).thread;
  const op = opId();
  const first = await s.api.dispatch(req("POST", `/api/v1/threads/${t.id}/messages`, { text: "帮我看看下周的安排" }, op), CLIENT);
  assert.equal(first.status, 200);
  const m = MessageRes.parse(first.body);
  assert.equal(m.input.owner, true);
  assert.equal(m.queued, false);
  const again = await s.api.dispatch(req("POST", `/api/v1/threads/${t.id}/messages`, { text: "帮我看看下周的安排" }, op), CLIENT);
  assert.equal(again.status, 200);
  assert.equal(MessageRes.parse(again.body).input.id, m.input.id);
  assert.equal(again.seq, undefined, "a resend wrote nothing");
  assert.equal(s.db.one<{ n: number }>("SELECT COUNT(*) AS n FROM inbox WHERE lane = ?", t.lane)!.n, 1);
  assert.equal(s.db.one<{ n: number }>("SELECT COUNT(*) AS n FROM messages WHERE lane = ?", t.lane)!.n, 1);
  assert.equal((await s.api.dispatch(req("POST", `/api/v1/threads/${t.id}/messages`, { text: "别的话" }, op), CLIENT)).status, 409);
  // the second input queues behind the first; withdrawing it is confirmed, and a second withdraw is 409
  const second = MessageRes.parse((await s.api.dispatch(req("POST", `/api/v1/threads/${t.id}/messages`, { text: "还有一件" }), CLIENT)).body);
  assert.deepEqual([second.queued, second.ahead], [true, 1]);
  const w = await s.api.dispatch(req("DELETE", `/api/v1/inputs/${second.input.id}`, {}), CLIENT);
  assert.equal(w.status, 200);
  const w2 = await s.api.dispatch(req("DELETE", `/api/v1/inputs/${second.input.id}`, {}), CLIENT);
  assert.equal(w2.status, 409);
  assert.equal(Conflict.parse(w2.body).input?.status, "dropped");
  // a Feishu mirror thread is read-only from a client (D9)
  s.db.run("INSERT INTO threads(id, lane, kind, domain, created_at) VALUES ('th_fakewb01', 'feishu:wb:om_fake01', 'feishu', 'work', 1)");
  const fs = await s.api.dispatch(req("POST", "/api/v1/threads/th_fakewb01/messages", { text: "hi" }), CLIENT);
  assert.equal(fs.status, 409);
  assert.equal(Conflict.parse(fs.body).thread?.id, "th_fakewb01");
  s.done();
});

test("run stop is confirmed: the dispatcher's answer; not running → stopped:false", async () => {
  const lanes: string[] = [];
  const s = await setup("w3a-stop", { runs: { activeRun: () => "r_fake_1", stopLane: (l) => { lanes.push(l); return true; } } });
  s.db.run("INSERT INTO runs(id, lane, role, tier, status, started) VALUES ('r_fake_1', 'console:main', 'main', 'chat', 'running', 1), ('r_fake_2', 'console:main', 'main', 'chat', 'done', 1)");
  const a = await s.api.dispatch(req("POST", "/api/v1/runs/r_fake_1/stop", {}), CLIENT);
  assert.deepEqual([a.status, (a.body as { stopped: boolean }).stopped, lanes], [200, true, ["console:main"]]);
  const b = await s.api.dispatch(req("POST", "/api/v1/runs/r_fake_2/stop", {}), CLIENT);
  assert.deepEqual([b.status, (b.body as { stopped: boolean }).stopped, lanes.length], [200, false, 1]);
  assert.equal((await s.api.dispatch(req("POST", "/api/v1/runs/r_none/stop", {}), CLIENT)).status, 404);
  s.done();
});

// ── approvals ───────────────────────────────────────────────────────────────────────────────────────────────
test("decide resent after a lost answer: one outbox row, the same answer", async () => {
  const s = await setup("w3a-decide");
  const id = submitApproval(s.db, SEND);
  const op = opId();
  const a = await s.api.dispatch(req("POST", `/api/v1/approvals/${id}/decide`, { action: "approve", draft_version: 1 }, op), CLIENT);
  assert.equal(a.status, 200);
  const ap = ApprovalRes.parse(a.body).approval;
  assert.equal(ap.status, "approved");
  assert.equal(ap.final_text, "周四上午十点", "exactly the draft on screen");
  const b = await s.api.dispatch(req("POST", `/api/v1/approvals/${id}/decide`, { action: "approve", draft_version: 1 }, op), CLIENT);
  assert.deepEqual([b.status, b.body, b.seq], [a.status, a.body, a.seq]);
  assert.equal(textRows(s.db, id), 1);
  assert.equal(s.db.one<{ d: string }>("SELECT decided_by AS d FROM approvals WHERE id = ?", id)!.d, `device:${PHONE}`);
  s.done();
});

test("Feishu click and client click on the same card: exactly one wins, both ends show it", async () => {
  // Feishu first, then the client
  {
    const s = await setup("w3a-race1");
    const id = submitApproval(s.db, SEND);
    sentCard(s.db, id);
    await click(s.db, id, "approve", 1);
    assert.equal(status(s.db, id), "approved");
    const c = await s.api.dispatch(req("POST", `/api/v1/approvals/${id}/decide`, { action: "reject", draft_version: 1 }), CLIENT);
    assert.equal(c.status, 409);
    assert.equal(Conflict.parse(c.body).approval?.status, "approved", "the client gets the card as it is");
    assert.equal(textRows(s.db, id), 1);
    const re = s.db.all<{ payload: string }>("SELECT payload FROM outbox WHERE kind = 'card' AND json_extract(target_json, '$.replace') = ?", `om_card_${id}`);
    assert.equal(re.length, 1, "the Feishu card is re-rendered once");
    assert.equal(JSON.parse(re[0]!.payload).status, "approved");
    s.done();
  }
  // the client first, then a click on the Feishu card that still shows the buttons
  {
    const s = await setup("w3a-race2");
    const id = submitApproval(s.db, SEND);
    sentCard(s.db, id);
    const c = await s.api.dispatch(req("POST", `/api/v1/approvals/${id}/decide`, { action: "reject", draft_version: 1, note: "先不发" }), CLIENT);
    assert.equal(c.status, 200);
    await click(s.db, id, "approve", 1);
    assert.equal(status(s.db, id), "rejected");
    assert.equal(textRows(s.db, id), 0, "nothing sent");
    const re = s.db.all<{ payload: string }>("SELECT payload FROM outbox WHERE kind = 'card' AND json_extract(target_json, '$.replace') = ?", `om_card_${id}`);
    assert.deepEqual(re.map((r) => JSON.parse(r.payload).status), ["rejected"]);
    s.done();
  }
});

test("edit draft is locked: stale draft_version → 409 with the current card; approve sends the edited text exactly", async () => {
  const s = await setup("w3a-draft");
  const id = submitApproval(s.db, SEND);
  sentCard(s.db, id);
  const e = await s.api.dispatch(req("PUT", `/api/v1/approvals/${id}/draft`, { text: "周四上午十点半", draft_version: 1 }), CLIENT);
  assert.equal(e.status, 200);
  assert.deepEqual([ApprovalRes.parse(e.body).approval.draft, ApprovalRes.parse(e.body).approval.draft_version], ["周四上午十点半", 2]);
  // the Feishu card got the new text and the new version on its buttons
  const re = s.db.one<{ payload: string }>("SELECT payload FROM outbox WHERE kind = 'card' AND json_extract(target_json, '$.replace') = ? ORDER BY id DESC", `om_card_${id}`)!;
  assert.equal(JSON.parse(re.payload).draft_version, 2);
  // the other device still shows version 1
  const stale = await s.api.dispatch(req("PUT", `/api/v1/approvals/${id}/draft`, { text: "改成下午", draft_version: 1 }), CLIENT);
  assert.equal(stale.status, 409);
  assert.equal(Conflict.parse(stale.body).approval?.draft, "周四上午十点半");
  const staleDecide = await s.api.dispatch(req("POST", `/api/v1/approvals/${id}/decide`, { action: "approve", draft_version: 1 }), CLIENT);
  assert.equal(staleDecide.status, 409);
  await click(s.db, id, "approve", 1);   // an old Feishu card copy
  assert.equal(status(s.db, id), "pending", "a click on text that has since changed is refused");
  const ok = await s.api.dispatch(req("POST", `/api/v1/approvals/${id}/decide`, { action: "approve", draft_version: 2 }), CLIENT);
  assert.equal(ok.status, 200);
  assert.equal(s.db.one<{ p: string }>("SELECT payload AS p FROM outbox WHERE approval_id = ? AND kind = 'text'", id)!.p, "周四上午十点半");
  s.done();
});

test("a gone card is 410 with the card as it is: expired, superseded", async () => {
  const s = await setup("w3a-gone");
  const id = submitApproval(s.db, SEND);
  s.db.run("UPDATE approvals SET expires_at = ? WHERE id = ?", Date.now() - 1000, id);
  const a = await s.api.dispatch(req("POST", `/api/v1/approvals/${id}/decide`, { action: "approve", draft_version: 1 }), CLIENT);
  assert.equal(a.status, 410);
  assert.equal(Conflict.parse(a.body).approval?.status, "expired");
  assert.equal(textRows(s.db, id), 0);
  const id2 = submitApproval(s.db, { ...SEND, trigger: { chat: "oc_fakechat07", msg_id: "om_fake_trigger8", ts: 2000 } });
  s.db.run("UPDATE approvals SET status = 'superseded' WHERE id = ?", id2);
  for (const [m, p, b] of [
    ["POST", "decide", { action: "approve", draft_version: 1 }], ["PUT", "draft", { text: "x", draft_version: 1 }],
    ["POST", "redraft", { note: "短一点", draft_version: 1 }], ["POST", "snooze", { until: "morning" }],
  ] as const) {
    const out = await s.api.dispatch(req(m, `/api/v1/approvals/${id2}/${p}`, b), CLIENT);
    assert.equal(out.status, 410, p);
    assert.equal(Conflict.parse(out.body).approval?.status, "superseded");
  }
  assert.equal((await s.api.dispatch(req("POST", "/api/v1/approvals/999999/decide", { action: "approve", draft_version: 1 }), CLIENT)).status, 404);
  assert.equal((await s.api.dispatch(req("POST", `/api/v1/approvals/${id2}/decide`, { action: "maybe", draft_version: 1 }), CLIENT)).status, 400);
  s.done();
});

test("glance and ask answers go through decide; the option's kind says approve or reject", async () => {
  const s = await setup("w3a-glance");
  const g = submitApproval(s.db, {
    kind: "glance", title: "跑 npm test", origin_lane: "task:t1", request: { command: "npm test" },
    options: [{ id: "a1", label: "这次可以", kind: "allow_once" }, { id: "r1", label: "不行", kind: "reject_once" }],
  } as ApprovalSpec);
  assert.equal((await s.api.dispatch(req("POST", `/api/v1/approvals/${g}/decide`, { action: "approve", draft_version: 1 }), CLIENT)).status, 400, "a glance needs answer + option_id");
  assert.equal((await s.api.dispatch(req("POST", `/api/v1/approvals/${g}/decide`, { action: "answer", option_id: "zz", draft_version: 1 }), CLIENT)).status, 400);
  const r = await s.api.dispatch(req("POST", `/api/v1/approvals/${g}/decide`, { action: "answer", option_id: "r1", draft_version: 1 }), CLIENT);
  assert.equal(ApprovalRes.parse(r.body).approval.status, "rejected");
  const q = submitApproval(s.db, { kind: "ask", title: "用哪个分支？", origin_lane: "task:t1", options: [{ id: "main", label: "main" }] } as ApprovalSpec);
  const ans = await s.api.dispatch(req("POST", `/api/v1/approvals/${q}/decide`, { action: "answer", text: "用 dev", draft_version: 1 }), CLIENT);
  assert.equal(ans.status, 200);
  assert.deepEqual(JSON.parse(s.db.one<{ a: string }>("SELECT answer_json AS a FROM approvals WHERE id = ?", q)!.a), { text: "用 dev" });
  s.done();
});

test("redraft: a lane's card asks in its lane; a triage card asks triage once, after commit, not on a resend", async () => {
  const s = await setup("w3a-redraft");
  const plan = submitApproval(s.db, { kind: "plan", title: "周报", draft: "第一稿", origin_lane: "console:main" } as ApprovalSpec);
  const a = await s.api.dispatch(req("POST", `/api/v1/approvals/${plan}/redraft`, { note: "短一点", draft_version: 1 }), CLIENT);
  assert.equal(a.status, 200);
  const asked = s.db.one<{ p: string }>("SELECT payload_json AS p FROM inbox WHERE lane = 'console:main' AND kind = 'approval'")!;
  assert.match(JSON.parse(asked.p).text, /短一点/);
  assert.equal(status(s.db, plan), "pending", "stays until the new draft replaces it");
  // the new draft from the same lane replaces it
  const next = submitApproval(s.db, { kind: "plan", title: "周报", draft: "短的第二稿", origin_lane: "console:main" } as ApprovalSpec);
  assert.equal(status(s.db, plan), "superseded");
  assert.equal(status(s.db, next), "pending");

  const id = submitApproval(s.db, SEND);
  const op = opId();
  const t1 = await s.api.dispatch(req("POST", `/api/v1/approvals/${id}/redraft`, { note: "语气软一点", draft_version: 1 }, op), CLIENT);
  assert.equal(t1.status, 200);
  await s.api.dispatch(req("POST", `/api/v1/approvals/${id}/redraft`, { note: "语气软一点", draft_version: 1 }, op), CLIENT);
  assert.deepEqual(s.triaged, [id]);
  assert.equal((await s.api.dispatch(req("POST", `/api/v1/approvals/${id}/redraft`, { note: "x", draft_version: 9 }), CLIENT)).status, 409);
  // a reply in the card's Feishu topic is the same redraft; a stranger's isn't
  sentCard(s.db, id, "om_card_topic1");
  const reply = cardReplies(s.db, (x) => s.triaged.push(x));
  const row = (operator: string) => ({ source: "feishu", payload_json: JSON.stringify({ text: "再短点", root_id: "om_card_topic1", operator }) });
  assert.match(reply(row("ou_fakestranger"))!, /改不了/);
  assert.match(reply(row(OWNER_FEISHU))!, /改稿|改/);
  assert.equal(s.triaged.length, 2);
  s.done();
});

test("snooze: morning goes into the morning batch, quota 0; past send_by → 400; the card says it", async () => {
  const s = await setup("w3a-snooze");
  const id = submitApproval(s.db, SEND);
  s.db.run("UPDATE approvals SET expires_at = ? WHERE id = ?", Date.now() + 30 * 86_400_000, id);
  const a = await s.api.dispatch(req("POST", `/api/v1/approvals/${id}/snooze`, { until: "morning" }), CLIENT);
  assert.equal(a.status, 200);
  const r = SnoozeRes.parse(a.body);
  assert.equal(r.approval.snooze, "morning");
  assert.ok(r.until_ts > Date.now());
  const q = s.db.one<{ state: string; quota: number; not_before: number }>("SELECT state, quota, not_before FROM push_queue WHERE ref = ?", `approval:${id}`)!;
  assert.deepEqual([q.state, q.quota, q.not_before], ["night", 0, r.until_ts]);
  assert.equal(status(s.db, id), "pending");
  const soon = submitApproval(s.db, { ...SEND, trigger: { chat: "oc_fakechat07", msg_id: "om_fake_trigger9", ts: 3000 } });
  s.db.run("UPDATE approvals SET expires_at = ? WHERE id = ?", Date.now() + 60_000, soon);
  assert.equal((await s.api.dispatch(req("POST", `/api/v1/approvals/${soon}/snooze`, { until: "monday" }), CLIENT)).status, 400);
  // deciding closes the queued push
  await s.api.dispatch(req("POST", `/api/v1/approvals/${id}/decide`, { action: "reject", draft_version: 1 }), CLIENT);
  assert.equal(s.db.one<{ state: string }>("SELECT state FROM push_queue WHERE ref = ?", `approval:${id}`)!.state, "done");
  s.done();
});

// ── threads and personal isolation (§读5.1) ───────────────────────────────────────────────────────────────────
test("personal: a personal thread's lines are personal; shared Feishu places list them as one line only", async () => {
  const s = await setup("w3a-personal");
  s.db.run("INSERT INTO matters(id, title, domain, status) VALUES (41, '搬家的事', 'personal', 'open'), (42, '季度规划', 'work', 'open')");
  const pt = ThreadRes.parse((await s.api.dispatch(req("POST", "/api/v1/threads", { matter_id: 41, domain: "work" }), CLIENT)).body).thread;
  assert.deepEqual([pt.kind, pt.domain, pt.title], ["matter", "personal", "搬家的事"], "a personal matter's thread is personal whatever I ask");
  const wt = ThreadRes.parse((await s.api.dispatch(req("POST", "/api/v1/threads", { matter_id: 42 }), CLIENT)).body).thread;
  assert.equal(wt.domain, "work");
  assert.equal((await s.api.dispatch(req("POST", "/api/v1/threads", { matter_id: 999 }), CLIENT)).status, 404);
  await s.api.dispatch(req("POST", `/api/v1/threads/${pt.id}/messages`, { text: "看房的预算是虚构的一个数" }), CLIENT);
  assert.equal(s.db.one<{ d: string }>("SELECT domain AS d FROM messages WHERE lane = ?", pt.lane)!.d, "personal");
  s.db.run("UPDATE messages SET attn = 'waiting' WHERE lane = ?", pt.lane);
  // a card from the personal thread
  submitApproval(s.db, { kind: "plan", title: "看房时间表", draft: "周六", origin_lane: pt.lane } as ApprovalSpec);
  const cmd = channelCommands(s.db);
  const wb = "feishu:wb:om_fake_topic", dm = "feishu:dm:owner";
  assert.doesNotMatch(cmd("approvals", "", wb)!, /看房/);
  assert.match(cmd("approvals", "", wb)!, /私人的一条/);
  assert.match(cmd("approvals", "", dm)!, /看房时间表/);
  assert.doesNotMatch(cmd("todo", "", wb)!, /看房|预算/);
  assert.match(cmd("todo", "", dm)!, /预算/);
  assert.match(cmd("help", "", wb)!, /\/approvals/);
  // self/ in a shared place: a turn I typed there reads like a system turn; my DM and the client read it whole
  mkdirSync(join(s.home.agentHome, "self"), { recursive: true });
  writeFileSync(join(s.home.agentHome, "self", "practice.md"), "虚构的功课");
  assert.ok(!promptFiles(s.home.agentHome, "typed", wb).some((f) => f.name === "self/practice.md"));
  assert.ok(promptFiles(s.home.agentHome, "typed", "console:main").some((f) => f.name === "self/practice.md"));
  assert.equal(privacyCol("typed", wb), "system");
  assert.equal(privacyCol("typed", dm), "typed");
  assert.ok(selfGuard("self/practice.md", privacyCol("typed", wb), s.home.agentHome, true));
  assert.equal(selfGuard("self/practice.md", privacyCol("typed", pt.lane), s.home.agentHome), undefined);
  s.done();
});

// ── devices over a client connection, and the admin socket ──────────────────────────────────────────────────
test("device writes: over /api/v1 inside client_ops; an invite's code is never kept for a replay; the CLI still works", async () => {
  const invited: string[] = [], removed: string[] = [];
  const devices: DeviceWrites = {
    invite: (role, by) => { invited.push(`${role}:${by}`); return { code: `sbot1-FAKECODE${invited.length}`, expires_at: Date.now() + 600_000, role } as never; },
    remove: (id) => { removed.push(id); return { name: "mac", role: "node", dropped: 0, runs: 0, channels: 1 }; },
  };
  const s = await setup("w3a-devices", { devices });
  const op = opId();
  const a = await s.api.dispatch(req("POST", "/api/v1/devices/invites", { role: "client" }, op), CLIENT);
  assert.equal(a.status, 200);
  assert.match(JSON.stringify(a.body), /FAKECODE1/);
  const b = await s.api.dispatch(req("POST", "/api/v1/devices/invites", { role: "client" }, op), CLIENT);
  assert.equal(b.status, 409);
  assert.doesNotMatch(JSON.stringify(b.body), /FAKECODE/);
  assert.doesNotMatch(s.db.one<{ r: string }>("SELECT result_json AS r FROM client_ops WHERE client_op_id = ?", op)!.r, /FAKECODE/, "the pairing code is not stored");
  assert.equal(invited.length, 1);
  const ren = await s.api.dispatch(req("PATCH", `/api/v1/devices/${PHONE}`, { name: "旧手机" }), CLIENT);
  assert.equal(ren.status, 200);
  assert.equal(s.db.one<{ n: string }>("SELECT name AS n FROM devices WHERE id = ?", PHONE)!.n, "旧手机");
  const del = await s.api.dispatch(req("DELETE", `/api/v1/devices/${NODE.device_id}`, {}), CLIENT);
  assert.equal(del.status, 200);
  assert.deepEqual(removed, [NODE.device_id]);
  // hub-admin.sock's router: the same dispatcher, as the client device `cli`
  const cli = router({ api: s.api });
  const viaCli = await cli({ t: "req", id: 1, method: "POST", path: "/api/v1/devices/invites", body: { role: "node" }, client_op_id: "cli-00000000-fake" }, { device: "cli" });
  assert.equal(viaCli.status, 200);
  assert.equal(invited[1], "node:cli");
  assert.equal((await cli({ t: "req", id: 2, method: "GET", path: "/api/v1/devices" }, { device: "cli" })).status, 200);
  s.done();
});
