// Approvals (§底3.2, §底3.3; 03 approvals): only I decide, the first decision wins, a send goes out exactly as approved
// and once, cards go to admin outlets that can show them, expiry and invalidation. Fictional ids only.
import { test } from "node:test";
import assert from "node:assert/strict";
import { fakeChannel, OWNER_FEISHU, w1dHome } from "./w1d-helpers.ts";
import { openDb } from "../src/db/db.ts";
import { registerChannel, unregisterChannel } from "../src/channels/registry.ts";
import { decide, invalidateForOwnerMessage, submitApproval, supersede, sweepApprovals } from "../src/approvals.ts";

async function setup() {
  const h = await w1dHome("approvals");
  const db = openDb(h.db);
  const feishu = fakeChannel("feishu");
  registerChannel(feishu);
  db.run("INSERT INTO devices(id, role, name, public_key, created_at) VALUES ('dev_fake1', 'client', 'phone', ?, ?), ('node_fake1', 'node', 'mac', ?, ?)",
    Buffer.alloc(32, 1), Date.now(), Buffer.alloc(32, 2), Date.now());
  return { db, done: () => { unregisterChannel("feishu"); db.close(); } };
}
const sendSpec = { kind: "send" as const, title: "发给 oc_fakechat01", draft: "周五见", channel: "feishu", target: { chat: "oc_fakechat01" }, origin_lane: "client:main", trigger: { chat: "oc_fakechat01", msg_id: "om_trigger1", ts: 1000 } };

test("a card goes to the admin outlets that show cards, never as a client row", async () => {
  const { db, done } = await setup();
  const id = submitApproval(db, sendSpec);
  const rows = db.all<{ channel: string; kind: string; payload: string; idem_key: string }>("SELECT channel, kind, payload, idem_key FROM outbox");
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.channel, "feishu");
  assert.equal(rows[0]!.kind, "card");
  assert.equal(rows[0]!.idem_key, `approval:${id}:card:feishu:chat:admin`);
  const card = JSON.parse(rows[0]!.payload);
  assert.equal(card.approval_id, id);
  assert.ok(card.lines.includes("周五见"));
  assert.equal(card.question, "原样发出去吗？");
  done();
});

test("only I decide: a node, a stranger on the channel, a removed device are refused", async () => {
  const { db, done } = await setup();
  const id = submitApproval(db, sendSpec);
  assert.equal(decide(db, id, { decision: "approve", by: { kind: "device", device_id: "node_fake1", role: "node" } }).ok, false);
  assert.equal(decide(db, id, { decision: "approve", by: { kind: "device", device_id: "node_fake1" } }).ok, false, "a node id without role is still a node");
  assert.equal(decide(db, id, { decision: "approve", by: { kind: "channel", channel: "feishu", operator: "ou_someoneelse" } }).ok, false);
  assert.equal(decide(db, id, { decision: "approve", by: { kind: "code", reason: "auto" } }).ok, false, "code never approves");
  db.run("UPDATE devices SET removed_at = ? WHERE id = 'dev_fake1'", Date.now());
  assert.equal(decide(db, id, { decision: "approve", by: { kind: "device", device_id: "dev_fake1" } }).ok, false);
  assert.equal(db.one<{ s: string }>("SELECT status AS s FROM approvals WHERE id = ?", id)!.s, "pending");
  done();
});

test("approve a send: one outbox row with the approved text, once; the first decision wins", async () => {
  const { db, done } = await setup();
  const id = submitApproval(db, sendSpec);
  const r = decide(db, id, { decision: "approve", by: { kind: "channel", channel: "feishu", operator: OWNER_FEISHU }, final_text: "周五下午见", draft_version: 1 });
  assert.ok(r.ok && r.outbox_id, JSON.stringify(r));
  const ob = db.one<{ payload: string; idem_key: string; channel: string; approval_id: number; kind: string }>("SELECT * FROM outbox WHERE id = ?", r.outbox_id!)!;
  assert.deepEqual([ob.payload, ob.idem_key, ob.channel, ob.approval_id, ob.kind], ["周五下午见", `approval:${id}`, "feishu", id, "text"]);
  const again = decide(db, id, { decision: "reject", by: { kind: "device", device_id: "dev_fake1" } });
  assert.equal(again.ok, false);
  assert.equal(db.one<{ n: number }>("SELECT COUNT(*) AS n FROM outbox WHERE kind = 'text'")!.n, 1);
  assert.equal(db.one<{ d: string }>("SELECT decided_by AS d FROM approvals WHERE id = ?", id)!.d, "feishu");
  done();
});

test("stale draft_version is refused; reject sends nothing", async () => {
  const { db, done } = await setup();
  const id = submitApproval(db, sendSpec);
  db.run("UPDATE approvals SET draft_version = 2 WHERE id = ?", id);
  const stale = decide(db, id, { decision: "approve", by: { kind: "device", device_id: "cli" }, draft_version: 1 });
  assert.equal(stale.ok, false);
  const no = decide(db, id, { decision: "reject", by: { kind: "device", device_id: "dev_fake1" }, draft_version: 2 });
  assert.ok(no.ok && no.status === "rejected");
  assert.equal(db.one<{ n: number }>("SELECT COUNT(*) AS n FROM outbox WHERE kind = 'text'")!.n, 0);
  done();
});

test("a plan decision comes back to its lane as an approval event", async () => {
  const { db, done } = await setup();
  const id = submitApproval(db, { kind: "plan", title: "整理 journal", origin_lane: "client:main" });
  decide(db, id, { decision: "approve", by: { kind: "device", device_id: "cli" }, note: "可以" });
  const ev = db.one<{ kind: string; source_msg_id: string; payload_json: string }>("SELECT kind, source_msg_id, payload_json FROM inbox WHERE lane = 'client:main'")!;
  assert.equal(ev.kind, "approval");
  assert.equal(ev.source_msg_id, `${id}:approve`);
  assert.match(JSON.parse(ev.payload_json).text, /批了：可以/);
  done();
});

test("expiry, supersede, and my reply in the trigger chat invalidate pending cards", async () => {
  const { db, done } = await setup();
  const a = submitApproval(db, sendSpec);
  db.run("UPDATE approvals SET expires_at = ? WHERE id = ?", Date.now() - 1, a);
  // glance/ask never expire
  const g = submitApproval(db, { kind: "glance", title: "看一眼" });
  assert.equal(db.one<{ e: number | null }>("SELECT expires_at AS e FROM approvals WHERE id = ?", g)!.e, null);
  assert.equal(sweepApprovals(db), 1);
  assert.equal(decide(db, a, { decision: "approve", by: { kind: "device", device_id: "cli" } }).ok, false);
  const b = submitApproval(db, sendSpec), c = submitApproval(db, sendSpec);
  supersede(db, b, c);
  assert.equal(db.one<{ s: string; by: number }>("SELECT status AS s, superseded_by AS by FROM approvals WHERE id = ?", b)!.s, "superseded");
  assert.equal(invalidateForOwnerMessage(db, { chat: "oc_fakechat01", after_ts: 2000 }), 1);
  assert.equal(db.one<{ s: string }>("SELECT status AS s FROM approvals WHERE id = ?", c)!.s, "invalidated");
  // a card that went out is re-rendered with its new state (replace target)
  const d = submitApproval(db, sendSpec);
  db.run("UPDATE approvals SET cards_json = ? WHERE id = ?", JSON.stringify([{ channel: "feishu", chat: "oc_admin", msg_id: "om_card1" }]), d);
  invalidateForOwnerMessage(db, { trigger_msg_id: "om_trigger1" });
  const re = db.one<{ target_json: string; payload: string }>("SELECT target_json, payload FROM outbox WHERE idem_key = ?", `approval:${d}:card:invalidated:om_card1`)!;
  assert.equal(JSON.parse(re.target_json).replace, "om_card1");
  assert.equal(JSON.parse(re.payload).status, "invalidated");
  done();
});

test("a secret in a draft: the card, approvals.draft and the sent text are the same redacted text", async () => {
  const { db, done } = await setup();
  const { FAKE_KEY } = await import("./fake-llm.ts");
  const { cardOf } = await import("../src/approvals.ts");
  const id = submitApproval(db, { ...sendSpec, draft: `钥匙是 ${FAKE_KEY}，别外传` });
  const row = db.one<{ draft: string }>("SELECT * FROM approvals WHERE id = ?", id)!;
  assert.ok(!row.draft.includes(FAKE_KEY));
  assert.match(row.draft, /\[已打码\]/);
  assert.ok(cardOf(db.one("SELECT * FROM approvals WHERE id = ?", id)!).lines.includes(row.draft), "the card shows exactly the stored draft");
  const d = decide(db, id, { decision: "approve", by: { kind: "device", device_id: "dev_fake1" } });
  assert.ok(d.ok && d.outbox_id);
  assert.equal(db.one<{ p: string }>("SELECT payload AS p FROM outbox WHERE id = ?", d.ok ? d.outbox_id! : 0)!.p, row.draft, "what goes out is what I saw");
  // an edited final text and any text row written straight to the outbox are redacted too
  const id2 = submitApproval(db, { ...sendSpec, trigger: { ...sendSpec.trigger, msg_id: "om_trigger2" } });
  const d2 = decide(db, id2, { decision: "approve", by: { kind: "device", device_id: "dev_fake1" }, final_text: `改成：${FAKE_KEY}` });
  assert.equal(db.one<{ p: string }>("SELECT payload AS p FROM outbox WHERE id = ?", d2.ok ? d2.outbox_id! : 0)!.p, "改成：[已打码]");
  done();
});
