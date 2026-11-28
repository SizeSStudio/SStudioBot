// Outbox and outlet groups (03 「outbox 和出口组」): only through a registered channel plugin, idem_key once, retry,
// unknown never resent, expired, unrouted, recover() with the same idem_key. A fake plugin stands in for the channels.
import { test } from "node:test";
import assert from "node:assert/strict";
import { fakeChannel, w1dHome } from "./w1d-helpers.ts";
import { openDb, type Db } from "../src/db/db.ts";
import { enqueue, Outbox, registerChannel, toOutlet, unregisterChannel, type SendResult } from "../src/outbox.ts";

async function setup(answer?: Parameters<typeof fakeChannel>[1], cards = true) {
  const h = await w1dHome("outbox");
  const db = openDb(h.db);
  const ch = fakeChannel("fakechan", answer, cards);
  registerChannel(ch);
  const ob = new Outbox(db);
  return { db, ch, ob, done: () => { unregisterChannel("fakechan"); db.close(); } };
}
const row = (db: Db, id: number) => db.one<{ status: string; attempts: number; next_try: number | null; error: string | null; sent_msg_id: string | null }>("SELECT * FROM outbox WHERE id = ?", id)!;

test("sent once; the same idem_key writes one row", async () => {
  const { db, ch, ob, done } = await setup(() => ({ ok: true, msg_id: "m_fake_1" }));
  const a = enqueue(db, { channel: "fakechan", target: { chat: "oc_fake" }, payload: "你好", idem_key: "k1" });
  const b = enqueue(db, { channel: "fakechan", target: { chat: "oc_fake" }, payload: "你好", idem_key: "k1" });
  assert.equal(a, b);
  const c = enqueue(db, { channel: "fakechan", target: {}, payload: "x" });
  assert.equal(db.one<{ k: string }>("SELECT idem_key AS k FROM outbox WHERE id = ?", c)!.k, `sbot-ob-${c}`);
  await ob.drain();
  assert.equal(row(db, a).status, "sent");
  assert.equal(row(db, a).sent_msg_id, "m_fake_1");
  assert.equal(ch.sent.length, 2);
  await ob.drain();
  assert.equal(ch.sent.length, 2, "nothing twice");
  done();
});

test("retry with backoff, then failed after 4 attempts; retry:false fails at once", async () => {
  const { db, ch, ob, done } = await setup((r) => (r.payload === "hard" ? { ok: false, error: "bad target", retry: false } : { ok: false, error: "503 busy", retry: true }));
  const id = enqueue(db, { channel: "fakechan", target: {}, payload: "soft" });
  const hard = enqueue(db, { channel: "fakechan", target: {}, payload: "hard" });
  await ob.drain();
  assert.equal(row(db, hard).status, "failed");
  let r = row(db, id);
  assert.equal(r.status, "queued");
  assert.equal(r.attempts, 1);
  assert.ok(r.next_try! > Date.now() + 5_000, "waits before the next try");
  await ob.drain();
  assert.equal(row(db, id).attempts, 1, "not before next_try");
  for (let i = 0; i < 5; i++) { db.run("UPDATE outbox SET next_try = 0 WHERE id = ?", id); await ob.drain(); }
  r = row(db, id);
  assert.equal(r.status, "failed");
  assert.equal(r.attempts, 4);
  assert.equal(ch.sent.filter((x) => x.id === id).length, 4);
  done();
});

test("unknown is never sent again; expired never goes; no plugin = unrouted", async () => {
  const settled: string[] = [];
  const { db, ch, ob, done } = await setup(() => ({ ok: false, error: "timeout after write", unknown: true }));
  ob.onSettled((_r, s) => settled.push(s));
  const u = enqueue(db, { channel: "fakechan", target: {}, payload: "maybe" });
  const e = enqueue(db, { channel: "fakechan", target: {}, payload: "late", send_by: Date.now() - 1 });
  const n = enqueue(db, { channel: "nochannel", target: {}, payload: "lost" });
  await ob.drain();
  await ob.drain();
  assert.equal(row(db, u).status, "unknown");
  assert.equal(ch.sent.filter((x) => x.id === u).length, 1);
  assert.equal(row(db, e).status, "expired");
  assert.ok(!ch.sent.some((x) => x.id === e));
  assert.equal(row(db, n).status, "unrouted");
  assert.deepEqual(settled.sort(), ["expired", "unknown", "unrouted"]);
  done();
});

test("recover(): a row left in sending goes again with the same idem_key", async () => {
  const { db, ch, ob, done } = await setup();
  const id = enqueue(db, { channel: "fakechan", target: {}, payload: "again", idem_key: "approval:7" });
  db.run("UPDATE outbox SET status = 'sending', attempts = 1 WHERE id = ?", id);   // the process died mid-send
  await ob.drain();
  assert.equal(ch.sent.length, 0, "sending rows are not picked up by a drain");
  assert.equal(ob.recover(), 1);
  await ob.drain();
  assert.equal(ch.sent.length, 1);
  assert.equal(ch.sent[0]!.idem_key, "approval:7", "the plugin can drop the repeat");
  assert.equal(row(db, id).status, "sent");
  done();
});

test("outlet groups: one row per outlet with a plugin; client always; cardsOnly; client rows land in messages", async () => {
  const { db, ob, done } = await setup();
  // default outlets: main = [client, feishu:dm]; no feishu plugin here → client only
  let ids = toOutlet(db, "main", "早");
  assert.equal(ids.length, 1);
  const feishu = fakeChannel("feishu", () => ({ ok: true, msg_id: "om_fake" }), false);
  registerChannel(feishu);
  ids = toOutlet(db, "main", "早二", { idem: "n1" });
  assert.equal(ids.length, 2);
  assert.deepEqual(toOutlet(db, "main", "早二", { idem: "n1" }), ids, "idem per outlet");
  const t = JSON.parse(db.one<{ t: string }>("SELECT target_json AS t FROM outbox WHERE channel = 'feishu'")!.t);
  assert.deepEqual(t, { outlet: "main", to: "dm", surface: "feishu:dm" });
  // cards only: feishu here can't show cards, and noClient drops the client row
  assert.deepEqual(toOutlet(db, "admin", "{}", { kind: "card", cardsOnly: true, noClient: true }), []);
  await ob.drain();
  assert.equal(db.one<{ n: number }>("SELECT COUNT(*) AS n FROM messages WHERE surface = 'client' AND sender_kind = 'bot'")!.n, 2);
  assert.equal(feishu.sent.length, 1);
  unregisterChannel("feishu");
  done();
});

test("an approved send settles the approval's result", async () => {
  const answers: SendResult[] = [{ ok: true, msg_id: "om_1" }];
  const { db, ob, done } = await setup(() => answers.shift() ?? { ok: true });
  db.run("INSERT INTO approvals(id, kind, title, status, ts) VALUES (5, 'send', 't', 'approved', ?)", Date.now());
  enqueue(db, { channel: "fakechan", target: {}, payload: "x", approval_id: 5, idem_key: "approval:5" });
  await ob.drain();
  assert.equal(db.one<{ r: string }>("SELECT result AS r FROM approvals WHERE id = 5")!.r, "sent");
  done();
});
