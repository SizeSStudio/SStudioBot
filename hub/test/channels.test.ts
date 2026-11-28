// W1e channels: the inbox port, the Feishu plugin against a fake backend and a fake lark-cli, cards, and the logger.
// Every id and secret here is made up; ids only have Feishu's shape so the routing code sees what it expects.
import { test } from "node:test";
import assert from "node:assert/strict";
import { ambientHome } from "./helpers.ts";
import { inboxPort } from "../src/channels/inbox-port.ts";
import { FeishuChannel, OWNER_DM_LANE, CARD_LANE } from "../src/channels/feishu/plugin.ts";
import type { Backend, Handler, Incoming } from "../src/channels/feishu/backend.ts";
import type { Lark } from "../src/channels/feishu/user.ts";
import type { OutboxRow } from "../src/channels/types.ts";
import { contentText, postContent, renderCard } from "../src/channels/feishu/cards.ts";
import { makeRedactor, safeSdkLogger, describeError } from "../src/channels/feishu/logger.ts";
import { setQuiet } from "../src/log.ts";

const OWNER = "ou_ownerfake0001", OTHER = "ou_otherfake0002";
const ADMIN = "oc_adminfake0001", WB = "oc_wbfake00001", GROUP = "oc_groupfake001", DM = "oc_dmfake000001", EXCLUDED = "oc_excluded0001";
const CONF = {
  "people.yaml": `owner:\n  name: 测试者\n  ids:\n    feishu: ${OWNER}\n`,
  "sources.yaml": `exclude:\n  chats: [${EXCLUDED}]\n  persons: []\n  mails: []\n`,
};
const live = (extra = "") => ({ ...CONF, "channels.yaml": `feishu:\n  admin_chat: ${ADMIN}\n  workbench_chat: ${WB}\n${extra}` });
const SECRETS = "FEISHU_APP_ID=cli_fakeappid0001\nFEISHU_APP_SECRET=fake-app-secret-not-real-123456\n";

class FakeBackend implements Backend {
  calls: { method: string; path: string; data?: any; params?: any }[] = [];
  handler?: Handler;
  async start(h: Handler, life: { ready(): void }) { this.handler = h; void life; }
  async api(method: string, path: string, data?: unknown, params?: Record<string, string>) {
    this.calls.push({ method, path, data, params });
    return { message_id: "om_sentfake0001", items: [] };
  }
  state() { return "open"; }
  async close() {}
}

function fakeLark() {
  const calls: { args: string[]; stdin?: string }[] = [];
  const lark: Lark = async (args, stdin) => { calls.push({ args, stdin }); return JSON.stringify({ data: { message_id: "om_asuser0001" } }); };
  return { lark, calls };
}

async function plugin(config: Record<string, string>, secrets?: string) {
  const { db } = await ambientHome("feishu", config, secrets);
  const b = new FakeBackend();
  const kicks: number[] = [];
  const said: string[] = [];
  const { lark, calls } = fakeLark();
  const p = new FeishuChannel({ backend: () => b, lark, observe: false, say: (l) => said.push(l) });
  await p.start(inboxPort(db, () => kicks.push(1)));
  return { db, b, p, kicks, said, larkCalls: calls };
}

const msg = (o: Partial<Incoming>): Incoming => ({ kind: "message", eventId: "ev1", messageId: "om_m0001", chatId: DM, chatType: "p2p",
  operatorId: OWNER, senderType: "user", messageType: "text", content: JSON.stringify({ text: "你好" }), createTime: 1_700_000_000_000, ...o });
/** an approvals row as W1d files it for a send as me; returns its id */
function approval(db: { run: (sql: string, ...a: any[]) => { lastInsertRowid: number | bigint } }, o: Record<string, unknown> = {}) {
  const a = { kind: "send", status: "approved", as_identity: "user", channel: "feishu", target_json: JSON.stringify({ chat_id: GROUP }),
    draft: "好的，明天给", final_text: null, expires_at: Date.now() + 3600_000, ...o };
  return Number(db.run("INSERT INTO approvals(kind, status, as_identity, channel, target_json, draft, final_text, expires_at, ts) VALUES(?,?,?,?,?,?,?,?,?)",
    a.kind, a.status, a.as_identity, a.channel, a.target_json, a.draft, a.final_text, a.expires_at, Date.now()).lastInsertRowid);
}
const row = (o: Partial<OutboxRow>): OutboxRow => ({ id: 1, channel: "feishu", kind: "text", as_identity: "bot", target_json: JSON.stringify({ chat_id: GROUP }), payload: "hi", ...o });

test("inbox port: one row per (source, source_msg_id); others' messages wait for triage", async () => {
  const { db } = await ambientHome("port");
  const port = inboxPort(db);
  const item = { lane: "l", kind: "user" as const, source: "feishu", source_msg_id: "om_x", payload: { text: "a" },
    message: { id: "om_x", surface: "feishu:group", chat_id: GROUP, sender_kind: "other" as const, ts: 1, text: "a" } };
  assert.equal(port.ingest(item).fresh, true);
  assert.equal(port.ingest(item).fresh, false);
  assert.equal(db.one<{ n: number }>("SELECT count(*) n FROM inbox")!.n, 1);
  assert.equal(db.one<{ s: string }>("SELECT triage_status s FROM messages WHERE id='om_x'")!.s, "pending");
  assert.equal(port.record({ id: "om_y", surface: "feishu:group", chat_id: GROUP, sender_kind: "owner", ts: 2, text: "b" }), true);
  assert.equal(db.one<{ s: string | null }>("SELECT triage_status s FROM messages WHERE id='om_y'")!.s, null);
});

test("shadow mode: no long connection, sends only logged, no stream", async () => {
  const { b, p } = await plugin({ ...CONF, "channels.yaml": "feishu:\n  mode: shadow\n" }, SECRETS);
  assert.equal(p.state(), "shadow");
  assert.equal(b.handler, undefined, "backend never started");
  assert.deepEqual(await p.send(row({})), { msg_id: null, shadow: true });
  assert.deepEqual(await p.send(row({ as_identity: "user", approval_id: 3 })), { msg_id: null, shadow: true });
  assert.equal(await p.sendCardTo(ADMIN, {}), null);
  assert.equal(b.calls.length, 0);
  assert.equal(p.stream({ runId: "r", lane: "l", turn: { lane: "l", surface: "feishu:dm", src: "x" } }).failed, true);
  await assert.rejects(p.api("GET", "/x"), /shadow/);
});

test("no credentials: bot identity stays off", async () => {
  const { b, p } = await plugin(live());
  assert.equal(b.handler, undefined);
  assert.equal(p.state(), "no-bot");
});

test("card clicks: only mine count, one inbox row per event_id, no token stored", async () => {
  const { db, b, kicks } = await plugin(live(), SECRETS);
  const click = (op: string, ev: string) => b.handler!({ kind: "card", eventId: ev, operatorId: op, messageId: "om_card1", chatId: DM, value: { k: "appr", id: 7, o: "ok" } } as Incoming);
  const t1 = await click(OTHER, "evA") as any;
  assert.equal(t1.toast.type, "warning");
  assert.equal(db.one<{ n: number }>("SELECT count(*) n FROM inbox")!.n, 0);
  await click(OWNER, "evB");
  await click(OWNER, "evB");   // Feishu redelivers
  const rows = db.all<{ lane: string; source: string; payload_json: string }>("SELECT lane, source, payload_json FROM inbox");
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.lane, CARD_LANE);
  assert.equal(rows[0]!.source, "feishu:card");
  assert.deepEqual(JSON.parse(rows[0]!.payload_json).value, { k: "appr", id: 7, o: "ok" });
  assert.equal(JSON.parse(rows[0]!.payload_json).owner, true);
  assert.ok(!rows[0]!.payload_json.includes("token"));
  assert.equal(kicks.length, 1);
});

test("messages: my DM is a turn or a command, others only feed triage, excluded chats never land", async () => {
  const { db, p } = await plugin(live(), SECRETS);
  assert.equal(p.onMessage(msg({}), "event"), true);
  assert.equal(p.onMessage(msg({}), "event"), false, "same message_id dedupes");
  assert.equal(p.onMessage(msg({ messageId: "om_m0002", content: JSON.stringify({ text: "/tasks open" }) }), "event"), true);
  const inbox = db.all<{ lane: string; kind: string; payload_json: string }>("SELECT lane, kind, payload_json FROM inbox ORDER BY id");
  assert.deepEqual(inbox.map((r) => [r.lane, r.kind]), [[OWNER_DM_LANE, "user"], [OWNER_DM_LANE, "command"]]);
  assert.equal(JSON.parse(inbox[1]!.payload_json).cmd, "tasks");
  assert.ok(inbox.every((r) => JSON.parse(r.payload_json).owner === true), "my DM turns carry the owner flag (W1d ownerTyped)");
  assert.equal(JSON.parse(inbox[1]!.payload_json).arg, "open");
  assert.equal(db.one<{ v: string }>("SELECT v FROM kv WHERE k='channels.feishu.owner_dm_chat'")!.v, DM);

  assert.equal(p.onMessage(msg({ messageId: "om_m0003", chatId: GROUP, chatType: "group", operatorId: OTHER }), "event"), false);
  assert.equal(db.one<{ n: number }>("SELECT count(*) n FROM inbox")!.n, 2, "others never reach the inbox");
  assert.equal(p.onMessage(msg({ messageId: "om_m0007", chatId: "oc_p2pother001", operatorId: OTHER, content: JSON.stringify({ text: "/tasks" }) }), "event"), false,
    "someone else's DM is only recorded, never a turn or a command");
  assert.equal(db.one("SELECT 1 FROM inbox WHERE source_msg_id='om_m0007'"), undefined);
  assert.equal(db.one<{ k: string }>("SELECT sender_kind k FROM messages WHERE id='om_m0007'")!.k, "other");
  assert.equal(db.one<{ s: string }>("SELECT triage_status s FROM messages WHERE id='om_m0003'")!.s, "pending");

  p.onMessage(msg({ messageId: "om_m0004", chatId: EXCLUDED, chatType: "group", operatorId: OTHER }), "event");
  assert.equal(db.one("SELECT 1 FROM messages WHERE id='om_m0004'"), undefined, "excluded chat");

  p.onMessage(msg({ messageId: "om_m0005", chatId: WB, chatType: "group", rootId: "om_root01", content: JSON.stringify({ text: "@_user_1 看下" }) }), "event");
  const wb = db.one<{ lane: string; payload_json: string }>("SELECT lane, payload_json FROM inbox WHERE source_msg_id='om_m0005'")!;
  assert.equal(wb.lane, "feishu:wb:om_root01");
  assert.equal(JSON.parse(wb.payload_json).owner, true, "workbench turns too");
  assert.equal(JSON.parse(wb.payload_json).text, "看下", "mentions stripped");

  p.onMessage(msg({ messageId: "om_m0006", senderType: "app" }), "event");
  assert.equal(db.one("SELECT 1 FROM messages WHERE id='om_m0006'"), undefined, "bot's own messages ignored");
});

test("send: as me only with an approval and only text; bot sends carry the idempotency key", async () => {
  const { db, b, p, larkCalls } = await plugin(live(), SECRETS);
  const id = approval(db);
  await assert.rejects(p.send(row({ as_identity: "user" })), /approval/);
  await assert.rejects(p.send(row({ as_identity: "user", approval_id: id, kind: "card" })), /only text/);
  assert.equal(larkCalls.length, 0);
  const r = await p.send(row({ as_identity: "user", approval_id: id, payload: "好的，明天给", idem_key: "k1" }));
  assert.equal(r.msg_id, "om_asuser0001");
  assert.equal(larkCalls[0]!.stdin, "好的，明天给");
  assert.ok(larkCalls[0]!.args.includes("--as") && larkCalls[0]!.args.includes("user") && larkCalls[0]!.args.includes("k1"));

  await p.send(row({ idem_key: "idem-1" }));
  assert.equal(b.calls[0]!.path, "/open-apis/im/v1/messages");
  assert.equal(b.calls[0]!.data.uuid, "idem-1");
  assert.equal(b.calls[0]!.data.msg_type, "post");
  await p.send(row({ target_json: JSON.stringify({ chat_id: GROUP, msg_id: "om_reply01", thread_id: "omt_1" }), kind: "card",
    payload: JSON.stringify({ title: "T", lines: ["a"], options: [] }) }));
  assert.equal(b.calls[1]!.path, "/open-apis/im/v1/messages/om_reply01/reply");
  assert.equal(b.calls[1]!.data.msg_type, "interactive");
  assert.equal(b.calls[1]!.data.reply_in_thread, true);
});

test("send as me: only exactly what was approved — status, kind, text, chat and the message replied to all checked", async () => {
  const { db, p, larkCalls } = await plugin(live(), SECRETS);
  const as = (approval_id: number, o: Partial<OutboxRow> = {}) => p.send(row({ as_identity: "user", approval_id, payload: "好的，明天给", ...o }));
  await assert.rejects(as(999), /not found/);
  for (const status of ["pending", "rejected", "expired", "superseded", "invalidated"]) await assert.rejects(as(approval(db, { status })), new RegExp(`is ${status}`));
  await assert.rejects(as(approval(db, { kind: "plan" })), /not a send as the user/);
  await assert.rejects(as(approval(db, { as_identity: "bot" })), /not a send as the user/);
  await assert.rejects(as(approval(db, { expires_at: Date.now() - 1 })), /send-by/);
  await assert.rejects(as(approval(db), { payload: "好的，明天给！" }), /text differs/, "edited after approval");
  await assert.rejects(as(approval(db, { final_text: "改过的稿" })), /text differs/, "the approved version is final_text when there is one");
  await assert.rejects(as(approval(db), { target_json: JSON.stringify({ chat_id: "oc_groupfake002" }) }), /another chat/);
  await assert.rejects(as(approval(db, { target_json: JSON.stringify({ chat_id: GROUP, message_id: "om_q0001" }) }), { target_json: JSON.stringify({ chat_id: GROUP, msg_id: "om_q0002" }) }), /another message/);
  await assert.rejects(as(approval(db, { target_json: JSON.stringify({ chat_id: GROUP, message_id: "om_q0001" }) })), /another message/, "approved as a reply, not a fresh message");
  assert.equal(larkCalls.length, 0, "nothing reached lark-cli");

  const ok = await as(approval(db, { final_text: "改过的稿", target_json: JSON.stringify({ chat_id: GROUP, message_id: "om_q0001", in_thread: true }) }),
    { payload: "改过的稿", target_json: JSON.stringify({ chat_id: GROUP, msg_id: "om_q0001", thread_id: "omt_1" }) });
  assert.equal(ok.msg_id, "om_asuser0001");
  assert.equal(larkCalls.length, 1);
  assert.equal(larkCalls[0]!.stdin, "改过的稿");
});

test("cards and message content", () => {
  const c = renderCard({ title: "审批", lines: ["要发吗"], question: "发？", options: [{ id: "ok", label: "发", recommended: true }, { id: "no", label: "不发" }],
    value: { k: "appr", id: 9 }, detail: { kind: "diff", text: "```x", folded: true } }) as any;
  const json = JSON.stringify(c);
  assert.ok(json.includes('"o":"ok"') && json.includes('"k":"appr"') && json.includes("collapsible_panel"));
  assert.ok(!json.includes("```x"), "fences in detail are defused");
  assert.equal(contentText("text", JSON.stringify({ text: " hi " })), "hi");
  assert.equal(contentText("post", JSON.stringify({ zh_cn: { title: "标题", content: [[{ tag: "text", text: "a" }, { tag: "at", user_name: "b" }]] } })), "标题\na@b");
  assert.equal(contentText("image", "{}"), "[image]");
  assert.deepEqual(JSON.parse(postContent("x")), { zh_cn: { content: [[{ tag: "md", text: "x" }]] } });
});

test("redactor and the SDK logger never let a secret or an id through", () => {
  const secret = "fake-app-secret-not-real-123456";
  const r = makeRedactor([secret]);
  const said: string[] = [];
  const lg = safeSdkLogger((l) => said.push(l), r);
  const axiosLike = Object.assign(new Error("Request failed"), { config: { data: `{"app_secret":"${secret}"}` }, response: { status: 500, data: { code: 99 } } });
  lg.error([axiosLike, { config: { data: secret } }, `token ${secret} for ou_abcdefgh123 Bearer t-abcdefghijklmnopqrst`]);
  const out = said.join("\n");
  assert.ok(!out.includes(secret));
  assert.ok(!out.includes("ou_abcdefgh123"));
  assert.ok(out.includes("http=500") && out.includes("[object]"));
  assert.equal(describeError("x"), "x");
  assert.ok(!describeError(axiosLike).includes(secret));
});

setQuiet(true);
