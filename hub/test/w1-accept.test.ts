// W1 acceptance pieces that need the wiring main.ts does (09 「W1」 验收), on the real Feishu plugin with a fake backend
// and a fake lark-cli, the real dispatcher, triage, approvals and outbox, and a scripted runner:
//   (d) my Feishu DM streams into a CardKit card (create → updates → finish), and the card is the reply
//   (e) shadow: no card, the plain reply goes; someone else's conversation never streams
//   (f) a group @me → triage → draft run (others' read-only tools, a fresh session) → W1d's commitment check → a send
//       approval as me → approved → sent as me; nothing goes out before; my own reply in another group voids its card
// Every id, name and secret here is made up.
import { test } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync } from "node:fs";
import { w1dHome, until, OWNER_FEISHU } from "./w1d-helpers.ts";
import { openDb, type Db } from "../src/db/db.ts";
import { setDb } from "../src/db/ambient.ts";
import { loadSecrets } from "../src/secrets.ts";
import { refreshKnown } from "../src/tools/redact.ts";
import { ingest } from "../src/inbox.ts";
import { Dispatcher } from "../src/dispatch.ts";
import { Outbox } from "../src/outbox.ts";
import { decide, invalidateForOwnerMessage } from "../src/approvals.ts";
import { setAdminSink } from "../src/notify.ts";
import { registerBuiltinTools } from "../src/tools/builtin.ts";
import { allTools } from "../src/tools/registry.ts";
import { channel, registerChannel, unregisterChannel } from "../src/channels/registry.ts";
import { channelHost } from "../src/channels/host.ts";
import { cardRows } from "../src/channels/card-rows.ts";
import { FeishuChannel, OWNER_DM_LANE } from "../src/channels/feishu/plugin.ts";
import { Observer, observerHooks } from "../src/channels/feishu/observer.ts";
import { Triage, type Complete } from "../src/triage/triage.ts";
import { sendApproval } from "../src/main.ts";
import type { Backend, Handler, Incoming } from "../src/channels/feishu/backend.ts";
import type { Lark } from "../src/channels/feishu/user.ts";
import type { RunOpts, RunResult, Runner } from "../src/runner/types.ts";

if (!allTools().length) registerBuiltinTools();
const OTHER = "ou_fakeother0002", ADMIN = "oc_fakeadmin0001", GROUP_A = "oc_fakegroupa001", GROUP_B = "oc_fakegroupb001", DM = "oc_fakedm000001";

class FakeBackend implements Backend {
  calls: { method: string; path: string; data?: any }[] = [];
  handler?: Handler;
  #n = 0;
  async start(h: Handler) { this.handler = h; }
  async api(method: string, path: string, data?: unknown) {
    this.calls.push({ method, path, data });
    if (method === "POST" && path === "/open-apis/cardkit/v1/cards") return { card_id: "ck_fakecard0001" };
    return { message_id: `om_fakesent${String(++this.#n).padStart(4, "0")}`, items: [] };
  }
  state() { return "open"; }
  async close() {}
}

/** streams `out` in pieces the way pi does (deltas, then the finished message), or answers drafts */
class StreamRunner implements Runner {
  calls: RunOpts[] = [];
  out: string;
  constructor(out: string) { this.out = out; }
  async run(o: RunOpts): Promise<RunResult> {
    this.calls.push(o);
    for (const part of this.out.match(/.{1,4}/gsu) ?? []) { o.onItem({ k: "delta", text: part }); await new Promise((r) => setTimeout(r, 5)); }
    o.onItem({ k: "message", text: this.out });
    return { output: this.out, fullText: this.out, session_ref: "", stop: "done", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, tools: [], undelivered: [] };
  }
  async steer() { return false; }
}

async function setup(o: { mode?: "live" | "shadow"; out?: string; lark?: Lark } = {}) {
  const h = await w1dHome("w1-accept", { files: {
    "channels.yaml": `feishu:\n  admin_chat: ${ADMIN}\n  mode: ${o.mode ?? "live"}\n`,
    "groups.yaml": "reviewed: true\n",
    "gate.yaml": "attention:\n  wait_minutes: 0\n  escalate_wait_minutes: 0\n",
  } });
  const prevHome = process.env.SBOT_HOME;
  process.env.SBOT_HOME = h.root;
  appendFileSync(h.secrets, "FEISHU_APP_ID=cli_fakeappid0001\nFEISHU_APP_SECRET=fake-app-secret-not-real-777777\n");
  loadSecrets(h.secrets, h.keys);
  refreshKnown();
  const db: Db = openDb(h.db);
  setDb(db);
  setAdminSink(() => {});
  const b = new FakeBackend();
  const larkCalls: { args: string[]; stdin?: string }[] = [];
  const lark: Lark = o.lark ?? (async (args, stdin) => { larkCalls.push({ args, stdin }); return JSON.stringify({ data: { message_id: "om_fakeasme0001" } }); });
  const p = new FeishuChannel({ backend: () => b, lark, observe: false, say: () => {} });
  registerChannel(p);
  await p.start(channelHost(db));
  const runner = new StreamRunner(o.out ?? "好的");
  // as main.ts wires it
  const d = new Dispatcher({ db, h, runner, onCard: cardRows(db, () => p), stream: (c) => channel(c.turn.channel)?.stream?.(c) });
  const ob = new Outbox(db);
  d.start(50);
  return {
    h, db, b, p, runner, d, ob, larkCalls,
    async done() {
      await d.stop(1000); await p.stop(); unregisterChannel("feishu"); setDb(undefined); db.close();
      if (prevHome === undefined) delete process.env.SBOT_HOME; else process.env.SBOT_HOME = prevHome;
    },
  };
}

const dm = (o: Partial<Incoming> = {}): Incoming => ({ kind: "message", eventId: "", messageId: "om_fakedm0001", chatId: DM, chatType: "p2p",
  operatorId: OWNER_FEISHU, senderType: "user", messageType: "text", content: JSON.stringify({ text: "今天下午有什么安排" }), createTime: Date.now(), ...o });
const outbox = (db: Db) => db.all<{ id: number; kind: string; as_identity: string; approval_id: number | null; payload: string; status: string; t: string; run_id: string | null }>(
  "SELECT id, kind, as_identity, approval_id, payload, status, target_json AS t, run_id FROM outbox ORDER BY id");

test("(d) my Feishu DM streams into a CardKit card: created, updated, finished; the card is the reply", async () => {
  const s = await setup({ out: "下午三点有个评审，五点前没别的了。" });
  try {
    s.b.handler!(dm());
    await s.d.idle();
    assert.equal(s.runner.calls[0]!.ctx.col, "typed");
    const create = s.b.calls.find((c) => c.path === "/open-apis/cardkit/v1/cards" && c.method === "POST");
    assert.ok(create, "a CardKit card was created");
    assert.equal(JSON.parse(create!.data.data).config.streaming_mode, true);
    const sent = s.b.calls.find((c) => c.path === "/open-apis/im/v1/messages/om_fakedm0001/reply")!;
    assert.deepEqual(JSON.parse(sent.data.content), { type: "card", data: { card_id: "ck_fakecard0001" } }, "the card answers my message");
    assert.ok(s.b.calls.some((c) => c.method === "PUT" && c.path.endsWith("/elements/md/content")), "streamed updates");
    const fin = s.b.calls.filter((c) => c.method === "PUT" && c.path === "/open-apis/cardkit/v1/cards/ck_fakecard0001").pop()!;
    const card = JSON.parse(fin.data.card.data);
    assert.equal(card.config.streaming_mode, false, "streaming off at the end");
    assert.match(card.body.elements[0].content, /五点前没别的了/);
    await s.ob.drain();
    const rows = outbox(s.db);
    assert.deepEqual(rows.map((r) => [r.kind, r.status]), [["card", "sent"]], "one card row, no second text reply");
    assert.ok(Number(s.db.one<{ n: number }>("SELECT side_effects AS n FROM runs WHERE lane = ?", OWNER_DM_LANE)!.n) >= 1, "the card counts as a side effect (no rerun after a crash)");
  } finally { await s.done(); }
});

test("(e) shadow: no card, the plain reply goes through the plugin; someone else's conversation never streams", async () => {
  const s = await setup({ mode: "shadow", out: "在。" });
  try {
    s.p.onMessage(dm(), "event");
    await s.d.idle();
    await s.ob.drain();
    const rows = outbox(s.db);
    assert.deepEqual(rows.map((r) => [r.kind, r.payload, r.status]), [["text", "在。", "sent"]]);
    assert.equal(s.b.calls.length, 0, "shadow called nothing");
  } finally { await s.done(); }
  const l = await setup({ out: "好的" });
  try {
    ingest(l.db, { lane: "feishu:group:fake", kind: "user", source: "feishu", source_msg_id: "om_fakeothers01", payload: { text: "在吗", sender_name: "阿乙" },
      turn: { channel: "feishu", surface: "feishu:group", chat: GROUP_A, msg_id: "om_fakeothers01" } });
    await l.d.idle();
    assert.equal(l.runner.calls[0]!.ctx.col, "others");
    assert.ok(!l.b.calls.some((c) => c.path.startsWith("/open-apis/cardkit")), "no card in someone else's conversation");
  } finally { await l.done(); }
});

test("(f) group @me → draft run → commitment check → send approval as me → approved → sent; my own reply voids the other card", async () => {
  let search: any[] = [];
  const asMe: { args: string[]; stdin?: string }[] = [];
  const lark: Lark = async (args, stdin) => {
    if (args[0] === "auth") return JSON.stringify({ identities: { user: { status: "ready" } } });
    if (args[1] === "+messages-search") return JSON.stringify({ data: { messages: search } });
    if (args[1] === "+chat-list") return JSON.stringify({ data: { chats: [{ chat_id: GROUP_A, name: "甲群" }, { chat_id: GROUP_B, name: "乙群" }] } });
    if (args[1] === "messages" && args[2] === "read_status") return JSON.stringify({ data: { items: [] } });
    asMe.push({ args, stdin });
    return JSON.stringify({ data: { message_id: "om_fakeasme0001" } });
  };
  const s = await setup({ out: "好的，明天下午给报价。", lark });
  // as main.ts wires it: owner messages void drafts in that chat
  observerHooks.ownerMessage = (chat, ts) => { invalidateForOwnerMessage(s.db, { chat, after_ts: ts }); };
  try {
    s.db.kvSet("observer.chats_at", String(Date.now()));
    const t0 = Date.now() - 60_000;
    const msg = (id: string, chat: string, name: string, sender: string, text: string, ts: number, mentions: string[] = []) => ({
      message_id: id, chat_id: chat, chat_type: "group", chat_name: name, sender: { id: sender, name: sender === OWNER_FEISHU ? "小测" : "阿乙", sender_type: "user" },
      content: text, create_time: ts, msg_type: "text", mentions: mentions.map((m) => ({ id: m, name: "小测" })) });
    search = [msg("om_fakegrpa0001", GROUP_A, "甲群", OTHER, "@小测 报价什么时候能给？", t0, [OWNER_FEISHU]),
      msg("om_fakegrpb0001", GROUP_B, "乙群", OTHER, "@小测 周会改到几点？", t0 + 1000, [OWNER_FEISHU])];
    const obs = new Observer({ lark, plugin: s.p });
    await obs.poll();
    assert.equal(s.db.one<{ n: number }>("SELECT COUNT(*) AS n FROM messages WHERE triage_status = 'pending'")!.n, 2);

    const checked: string[] = [];
    const complete: Complete = async (o) => ({ items: [{ i: 0, action: "draft", why: "问到我了" }], events: [], _r: o.requester });
    const triage = new Triage({ complete, runDraft: (j) => s.d.runDraft(j), submitSend: sendApproval(s.db), notice: () => {},
      commitCheck: async (draft, o) => { checked.push(`${o.lane}|${draft}`); return { hits: [] }; } });
    await triage.tick();
    await s.d.idle();

    // the draft runs: role draft, others' read-only tools, a fresh session, only the chat's context, no channel to reply on
    const drafts = s.runner.calls.filter((c) => c.role === "draft");
    assert.equal(drafts.length, 2);
    for (const c of drafts) {
      assert.equal(c.ctx.col, "others");
      assert.match(c.ctx.src, /^group:oc_/);
      assert.equal(c.session_ref, undefined, "a fresh session");
      assert.ok(c.tools.every((t) => t.readOnly && t.cols.others), `read-only others tools only: ${c.tools.map((t) => t.name)}`);
      assert.ok(!c.tools.some((t) => t.name === "reply" || t.name === "send"));
      assert.equal(c.ctx.turn.channel, "draft", "a turn no plugin routes");
    }
    assert.match(drafts[0]!.input, /报价什么时候能给/);
    assert.doesNotMatch(drafts[0]!.input, /周会/, "only that chat's context");
    assert.equal(checked.length, 2, "W1d's commitment check read each draft");
    const runs = s.db.all<{ role: string; status: string; input_ref: string | null }>("SELECT role, status, input_ref FROM runs WHERE role = 'draft'");
    assert.ok(runs.length === 2 && runs.every((r) => r.status === "done" && r.input_ref), "draft runs recorded with their input snapshot");

    const aps = s.db.all<{ id: number; status: string; as_identity: string; trigger_chat: string; draft: string }>("SELECT id, status, as_identity, trigger_chat, draft FROM approvals WHERE kind = 'send' ORDER BY id");
    assert.equal(aps.length, 2);
    assert.ok(aps.every((a) => a.status === "pending" && a.as_identity === "user" && a.draft === "好的，明天下午给报价。"));
    await s.ob.drain();
    assert.ok(!outbox(s.db).some((r) => r.as_identity === "user"), "nothing as me before I approve");
    assert.equal(asMe.length, 0);

    // I write in group B myself before deciding: its card is moot
    search = [...search, msg("om_fakegrpb0002", GROUP_B, "乙群", OWNER_FEISHU, "三点", Date.now())];
    await obs.poll();
    const b = aps.find((a) => a.trigger_chat === GROUP_B)!, a = aps.find((x) => x.trigger_chat === GROUP_A)!;
    assert.equal(s.db.one<{ s: string }>("SELECT status AS s FROM approvals WHERE id = ?", b.id)!.s, "invalidated");
    assert.equal(decide(s.db, b.id, { decision: "approve", by: { kind: "device", device_id: "cli" } }).ok, false, "a voided card can't be approved");

    const r = decide(s.db, a.id, { decision: "approve", by: { kind: "device", device_id: "cli" } });
    assert.ok(r.ok);
    await s.ob.drain();
    assert.equal(asMe.length, 1, "sent as me once, through lark-cli (the plugin's approvedAsSent check passed)");
    assert.ok(asMe[0]!.args.includes("+messages-reply") && asMe[0]!.args.includes("om_fakegrpa0001"));
    assert.equal(asMe[0]!.stdin, "好的，明天下午给报价。");
    const mine = outbox(s.db).filter((x) => x.as_identity === "user");
    assert.deepEqual(mine.map((x) => [x.approval_id, x.status]), [[a.id, "sent"]]);
  } finally {
    observerHooks.ownerMessage = () => {};
    await s.done();
  }
});
