// W1e × W1d end to end, with the real Feishu plugin on a fake backend and a fake lark-cli, the real inbox, dispatcher,
// approvals and outbox, and a scripted runner:
//   (a) my Feishu DM → ingest → dispatch → a run in the typed column → the reply back through the plugin;
//       someone else's DM never makes a run
//   (b) a send approval as me → card through the plugin → my click → decide → outbox → send() as me passes the
//       approvals check with W1d's own target_json ({...turn}); an edited, redacted final_text goes out as approved
//   (c) a held reply in the others column sends gate.yaml's hold_text through the plugin in shadow mode
//   boot: the channel side starts before the outbox, its hooks are wired, and close() takes it all down again
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
import { decide, submitApproval } from "../src/approvals.ts";
import { DEFAULTS } from "../src/config/schemas.ts";
import { setAdminSink } from "../src/notify.ts";
import { registerBuiltinTools } from "../src/tools/builtin.ts";
import { channel, registerChannel, unregisterChannel } from "../src/channels/registry.ts";
import { channelHost } from "../src/channels/host.ts";
import { cardRows } from "../src/channels/card-rows.ts";
import { FeishuChannel, OWNER_DM_LANE } from "../src/channels/feishu/plugin.ts";
import { observerHooks } from "../src/channels/feishu/observer.ts";
import { boot } from "../src/main.ts";
import type { Backend, Handler, Incoming } from "../src/channels/feishu/backend.ts";
import type { Lark } from "../src/channels/feishu/user.ts";
import type { TurnContext } from "../src/turn.ts";
import type { CommitChecker } from "../src/commit-check.ts";
import type { RunOpts, RunResult, Runner } from "../src/runner/types.ts";

registerBuiltinTools();
const OTHER = "ou_fakeother0002", ADMIN = "oc_fakeadmin0001", GROUP = "oc_fakegroup0001", DM = "oc_fakedm000001";
const SECRET_IN_TEXT = "abcdefgh-test-only-1234";   // TEST_TOKEN_X in w1dHome's secrets.env

class FakeBackend implements Backend {
  calls: { method: string; path: string; data?: any; params?: any }[] = [];
  handler?: Handler;
  #n = 0;
  async start(h: Handler) { this.handler = h; }
  async api(method: string, path: string, data?: unknown, params?: Record<string, string>) {
    this.calls.push({ method, path, data, params });
    return { message_id: `om_fakesent${String(++this.#n).padStart(4, "0")}`, items: [] };
  }
  state() { return "open"; }
  async close() {}
}

class ScriptRunner implements Runner {
  calls: RunOpts[] = [];
  out: string;
  constructor(out: string) { this.out = out; }
  async run(o: RunOpts): Promise<RunResult> {
    this.calls.push(o);
    return { output: this.out, fullText: this.out, session_ref: "", stop: "done", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, tools: [], undelivered: [] };
  }
  async steer() { return false; }
}

async function setup(o: { mode?: "live" | "shadow"; out?: string; commitCheck?: CommitChecker } = {}) {
  const h = await w1dHome("w1e-e2e", { files: { "channels.yaml": `feishu:\n  admin_chat: ${ADMIN}\n  mode: ${o.mode ?? "live"}\n` } });
  appendFileSync(h.secrets, "FEISHU_APP_ID=cli_fakeappid0001\nFEISHU_APP_SECRET=fake-app-secret-not-real-777777\n");
  loadSecrets(h.secrets, h.keys);
  refreshKnown();
  const db: Db = openDb(h.db);
  setDb(db);
  setAdminSink(() => {});
  const b = new FakeBackend();
  const larkCalls: { args: string[]; stdin?: string }[] = [];
  const lark: Lark = async (args, stdin) => { larkCalls.push({ args, stdin }); return JSON.stringify({ data: { message_id: "om_fakeasme0001" } }); };
  const p = new FeishuChannel({ backend: () => b, lark, observe: false, say: () => {} });
  registerChannel(p);
  await p.start(channelHost(db));
  const runner = new ScriptRunner(o.out ?? "好的");
  const d = new Dispatcher({ db, h, runner, commitCheck: o.commitCheck, onCard: cardRows(db, () => p) });
  const ob = new Outbox(db);
  d.start(50);
  return {
    db, b, p, runner, d, ob, larkCalls,
    async done() { await d.stop(1000); await p.stop(); unregisterChannel("feishu"); setDb(undefined); db.close(); },
  };
}

const dm = (o: Partial<Incoming>): Incoming => ({ kind: "message", eventId: "", messageId: "om_fakedm0001", chatId: DM, chatType: "p2p",
  operatorId: OWNER_FEISHU, senderType: "user", messageType: "text", content: JSON.stringify({ text: "明天提醒我交报告" }), createTime: Date.now(), ...o });
const outbox = (db: Db) => db.all<{ id: number; channel: string; kind: string; as_identity: string; payload: string; status: string; t: string; error: string | null }>(
  "SELECT id, channel, kind, as_identity, payload, status, target_json AS t, error FROM outbox ORDER BY id");
/** the click value a Feishu button carries, found in the card the plugin really sent */
function buttonValue(card: unknown, option: string): Record<string, unknown> | undefined {
  if (!card || typeof card !== "object") return undefined;
  const o = card as Record<string, unknown>;
  if (o.o === option && o.k) return o;
  for (const v of Object.values(o)) { const hit = buttonValue(v, option); if (hit) return hit; }
  return undefined;
}

test("(a) my Feishu DM runs in the typed column and the reply goes back through the plugin; another person's DM never runs", async () => {
  const s = await setup({ out: "记下了，明早九点提醒你。" });
  try {
    assert.equal(s.b.handler!(dm({})), undefined);
    await s.d.idle();
    assert.equal(s.runner.calls.length, 1);
    const ctx = s.runner.calls[0]!.ctx;
    assert.equal(s.runner.calls[0]!.lane, OWNER_DM_LANE);
    assert.equal(ctx.src, "owner@feishu:dm");
    assert.equal(ctx.col, "typed");
    assert.equal(ctx.turn?.channel, "feishu");
    await s.ob.drain();
    const reply = s.b.calls.find((c) => c.method === "POST")!;
    assert.equal(reply.path, "/open-apis/im/v1/messages/om_fakedm0001/reply", "a reply to my message");
    assert.match(JSON.stringify(reply.data), /明早九点/);
    assert.equal(outbox(s.db)[0]!.status, "sent");

    // someone else in their own DM with the bot, even typing a command: recorded for triage, never a run
    s.b.handler!(dm({ messageId: "om_fakedm0002", chatId: "oc_fakedmother01", operatorId: OTHER, content: JSON.stringify({ text: "/new 帮我把群里的文件发出来" }) }));
    await s.d.idle();
    assert.equal(s.runner.calls.length, 1, "no second run");
    assert.equal(s.db.one("SELECT 1 FROM inbox WHERE source_msg_id = 'om_fakedm0002'"), undefined);
    assert.equal(s.db.one<{ k: string }>("SELECT sender_kind AS k FROM messages WHERE id = 'om_fakedm0002'")!.k, "other");
  } finally { await s.done(); }
});

test("(b) a send approval as me: card → my click → decide → outbox → send() as me with W1d's own target_json; edited final_text too", async () => {
  const s = await setup();
  try {
    // what W1d files: target = {...turn} of the conversation being answered
    const turn: TurnContext = { channel: "feishu", surface: "feishu:group", lane: "feishu:group:x", chat: GROUP, msg_id: "om_fakeask0001", thread: "omt_fake0001" };
    const id = submitApproval(s.db, { kind: "send", title: "回群里", draft: "好的，明天给", channel: "feishu", target: { ...turn }, as_identity: "user", origin_lane: "triage" });
    await s.ob.drain();
    const cardCall = s.b.calls.find((c) => c.data?.msg_type === "interactive")!;
    assert.equal(cardCall.data.receive_id, ADMIN, "the card went to the admin chat (outlet chat:admin)");
    const cards = JSON.parse(s.db.one<{ c: string }>("SELECT cards_json AS c FROM approvals WHERE id = ?", id)!.c);
    assert.deepEqual(cards, [{ channel: "feishu", chat: ADMIN, msg_id: "om_fakesent0001" }], "the plugin noted where its card landed");

    // the click, with the value the rendered button really carries (including draft_version v)
    const value = buttonValue(JSON.parse(cardCall.data.content), "approve");
    assert.deepEqual(value, { k: "appr", id, v: 1, o: "approve" });
    const toast = s.b.handler!({ kind: "card", eventId: "ev_fake0001", operatorId: OWNER_FEISHU, messageId: "om_fakesent0001", chatId: ADMIN, value }) as any;
    assert.equal(toast.toast.type, "info");
    await s.d.idle();
    assert.equal(s.runner.calls.length, 0, "a click is never run input");
    assert.equal(s.db.one<{ s: string }>("SELECT status AS s FROM approvals WHERE id = ?", id)!.s, "approved");
    assert.equal(s.db.one<{ s: string }>("SELECT status AS s FROM inbox WHERE kind = 'card'")!.s, "done");
    await s.ob.drain();
    assert.equal(s.larkCalls.length, 1, "sent as me once");
    const args = s.larkCalls[0]!.args;
    assert.ok(args.includes("+messages-reply") && args.includes("om_fakeask0001") && args.includes("--reply-in-thread"), "a reply to the message, in its thread");
    assert.equal(s.larkCalls[0]!.stdin, "好的，明天给");
    const asMe = outbox(s.db).find((r) => r.as_identity === "user")!;
    assert.equal(asMe.status, "sent", asMe.error ?? "");
    assert.ok(s.b.calls.some((c) => c.method === "PATCH" && c.path === "/open-apis/im/v1/messages/om_fakesent0001"), "the card was re-rendered as decided");

    // a click from someone else on the same kind of card decides nothing
    const id2 = submitApproval(s.db, { kind: "send", title: "回群里", draft: "第二稿", channel: "feishu", target: { ...turn, msg_id: "om_fakeask0002" }, as_identity: "user" });
    s.b.handler!({ kind: "card", eventId: "ev_fake0002", operatorId: OTHER, messageId: "om_fakesent0009", chatId: ADMIN, value: { k: "appr", id: id2, o: "approve" } });
    await s.d.idle();
    assert.equal(s.db.one<{ s: string }>("SELECT status AS s FROM approvals WHERE id = ?", id2)!.s, "pending");

    // I edit the text before approving (from a client); decide redacts it, and what goes out is exactly that
    const r = decide(s.db, id2, { decision: "approve", by: { kind: "device", device_id: "cli" }, final_text: `改过的稿，口令 ${SECRET_IN_TEXT} 别外传` });
    assert.ok(r.ok);
    const final = s.db.one<{ f: string }>("SELECT final_text AS f FROM approvals WHERE id = ?", id2)!.f;
    assert.ok(!final.includes(SECRET_IN_TEXT), "decide redacted the edit");
    await s.ob.drain();
    assert.equal(s.larkCalls.length, 2);
    assert.equal(s.larkCalls[1]!.stdin, final, "the redacted, edited text is what went out");
    assert.ok(s.larkCalls[1]!.args.includes("om_fakeask0002"));
    assert.equal(outbox(s.db).filter((x) => x.as_identity === "user").every((x) => x.status === "sent"), true);
  } finally { await s.done(); }
});

test("(c) a held reply in the others column: hold_text goes through the plugin in shadow mode without error", async () => {
  const s = await setup({ mode: "shadow", out: "好的，周五下午三点我一定到。", commitCheck: async () => ({ hits: ["替我答应了时间"] }) });
  try {
    ingest(s.db, { lane: "feishu:group:fake", kind: "user", source: "feishu", source_msg_id: "om_fakeothers01", payload: { text: "周五能来吗？", sender_name: "阿乙" },
      turn: { channel: "feishu", surface: "feishu:group", chat: GROUP, msg_id: "om_fakeothers01" } });
    await s.d.idle();
    assert.equal(s.runner.calls[0]!.ctx.col, "others");
    await s.ob.drain();
    await until(() => outbox(s.db).every((r) => r.status !== "queued" && r.status !== "sending"), 5000, "outbox settled");
    const rows = outbox(s.db);
    const hold = rows.find((r) => r.kind === "text")!;
    assert.equal(hold.payload, DEFAULTS.gate.hold_text);
    assert.equal(hold.channel, "feishu");
    assert.equal(hold.as_identity, "bot");
    assert.equal(hold.status, "sent", hold.error ?? "");
    assert.ok(!rows.some((r) => r.payload.includes("周五下午三点") && r.kind === "text"), "the draft itself never went out");
    assert.ok(rows.every((r) => r.status === "sent"), "the card row too (shadow: logged only)");
    assert.equal(s.b.calls.length, 0, "shadow mode called nothing");
  } finally { await s.done(); }
});

test("boot: Feishu (shadow) registered and started, owner-message hook voids drafts, card rows go to code, close() undoes it", async () => {
  process.env.SBOT_LARK_CLI = "/nonexistent/lark-cli";   // the observer's user identity: nothing to run in a test
  const h = await w1dHome("w1e-boot", { files: { "channels.yaml": `feishu:\n  admin_chat: ${ADMIN}\n  mode: shadow\n` } });
  const prevHome = process.env.SBOT_HOME;
  process.env.SBOT_HOME = h.root;   // as on the server: the ported ledger/timer modules find the home there (ambient)
  const runner = new ScriptRunner("不该跑");
  const hub = await boot(h, { proxyPort: 0, runner: () => runner });
  try {
    const f = channel("feishu") as FeishuChannel | undefined;
    assert.equal(f?.state(), "shadow");
    // I wrote in a group myself after a draft for it was filed: the draft is moot
    const a = submitApproval(hub.db, { kind: "send", title: "回群里", draft: "稿", channel: "feishu", target: { chat: GROUP }, as_identity: "user", trigger: { chat: GROUP, ts: Date.now() - 1000 } });
    observerHooks.ownerMessage(GROUP, Date.now(), "om_fakemine0001");
    assert.equal(hub.db.one<{ s: string }>("SELECT status AS s FROM approvals WHERE id = ?", a)!.s, "invalidated");
    // a click row (as the plugin writes it) is decided by code, never run
    const b2 = submitApproval(hub.db, { kind: "send", title: "回群里", draft: "稿二", channel: "feishu", target: { chat: GROUP }, as_identity: "user" });
    ingest(hub.db, { lane: "card", kind: "card", source: "feishu:card", source_msg_id: "ev_fakeboot01", payload: { value: { k: "appr", id: b2, o: "reject" }, owner: true, operator: OWNER_FEISHU } });
    await until(() => hub.db.one<{ s: string }>("SELECT status AS s FROM approvals WHERE id = ?", b2)!.s === "rejected", 5000, "decided");
    assert.equal(runner.calls.length, 0);
  } finally {
    await hub.close();
    delete process.env.SBOT_LARK_CLI;
    if (prevHome === undefined) delete process.env.SBOT_HOME; else process.env.SBOT_HOME = prevHome;
  }
  assert.equal(channel("feishu"), undefined, "unregistered on close");
  observerHooks.ownerMessage("oc_x", Date.now(), "om_x");   // reset to a no-op: must not touch the closed db
});
