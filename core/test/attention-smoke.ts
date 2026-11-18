// The attention window (DESIGN §4.3, §17.2). On the VPS, as sbot, on a fresh throwaway home:
//
//   ssh <server> 'bash -s' < test/vps-test-home.sh attention-smoke.ts 7830
//
// A fake model on the proxy port plays Triage; sends and read receipts are stubbed. Names and IDs are made up.

import http from "node:http";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { P, PROXY_PORT, ownerFeishu, waitMinutes } from "../src/config.ts";
import { one, all, run, kvSet } from "../src/db.ts";
import { ensureAgentHome, localStamp } from "../src/memory.ts";

const here = dirname(fileURLToPath(import.meta.url));
const ok = (cond: unknown, what: string) => { console.log(`${cond ? "PASS" : "FAIL"} ${what}`); if (!cond) process.exitCode = 1; };
for (const d of [P.sessions, P.logs, P.config]) mkdirSync(d, { recursive: true });
ensureAgentHome(join(here, "..", "seed", "agent-home"));
const gate = (yaml: string) => writeFileSync(join(P.config, "gate.yaml"), yaml);
gate("attention: { places: { oc_now: 0, oc_ten: 10, tickets: 5 } }\nproactive_daily_cap: 1\n");
writeFileSync(join(P.config, "feishu.yaml"), "admin_chat: oc_fake_admin\n");
const E = await import("../src/events.ts");
const { Triage } = await import("../src/triage.ts");
const S = await import("../src/sources.ts");
const { morningText } = await import("../src/digest.ts");
const { SCHEMAS, widening } = await import("../src/schemas.ts");

const owner = ownerFeishu()!;
const now = Date.now(), MIN = 60_000;
kvSet("feishu.owner_dm_chat", "oc_fake_dm");
let pos = 1000;
const insert = (id: string, chat: string, kind: string, ago: number, o: { text?: string; thread?: string; reply?: string; mentions?: string[]; sender?: string; surface?: string } = {}) => {
  const p = ++pos;
  run("INSERT INTO messages(id, surface, chat_id, thread_id, sender_id, sender_kind, ts, text, raw_json, triage_status) VALUES(?,?,?,?,?,?,?,?,?,?)",
    id, o.surface ?? "feishu:group", chat, o.thread ?? null, kind === "owner" ? owner : o.sender ?? "ou_fake_asker", kind, now - ago * MIN, o.text ?? "在吗，这个你看下",
    JSON.stringify({ chat_name: "项目群", sender_name: kind === "owner" ? "我" : "小林", reply_to: o.reply, pos: p, mentions: o.mentions ?? [] }), kind === "owner" ? "done" : "pending");
  return p;
};
/** his word arriving, the way the observer hands it over */
const say = (id: string, chat: string, ago: number, o: Parameters<typeof insert>[3] = {}) => {
  const p = insert(id, chat, "owner", ago, o);
  return E.markReplied(chat, now - ago * MIN, o.reply, { id, thread: o.thread, pos: p, mentions: o.mentions });
};
const m = (id: string) => one("SELECT * FROM messages WHERE id=?", id)!;
const ev = (id: string) => one("SELECT e.* FROM events e JOIN messages m ON m.event_id=e.id WHERE m.id=?", id);
const escalated = (id: string) => !!one("SELECT 1 FROM inbox WHERE source='triage' AND source_msg_id=?", id);
const due = (id: string) => run("UPDATE messages SET wait_until=? WHERE id=?", now - MIN, id);

const scripted: unknown[] = [];
const fake = http.createServer((req, res) => {
  req.resume();
  req.on("end", () => {
    res.writeHead(200, { "content-type": "application/json", connection: "close" });
    res.end(JSON.stringify({ content: [{ type: "text", text: JSON.stringify(scripted.shift() ?? {}) }], usage: { input_tokens: 1, output_tokens: 1 } }));
  });
});
await new Promise<void>((r) => fake.listen(PROXY_PORT, "127.0.0.1", () => r()));

const drafted: string[] = [], sent: string[] = [];
let readSet = new Set<string>(), readFails = false;
const tri = new Triage({ run: async (o: any) => { drafted.push(o.ctx.turn.message_id); return { text: "【不回复】测试不发卡片", stop: "done", sessionRef: "stub", toolCalls: 0, usage: { output: 0 } }; } } as any, {
  send: (async (_c: string, t: string) => { sent.push(t); return { message_id: "om_sent" }; }) as any,
  readIds: async (ids: string[]) => { if (readFails) throw new Error("no"); return new Set(ids.filter((i) => readSet.has(i))); },
}) as any;
/** classify everything pending in a chat as one event */
const sort = async (chat: string, action: string, level: string, sum = "找他的事") => {
  const rows = all("SELECT * FROM messages WHERE chat_id=? AND triage_status='pending' ORDER BY ts, id", chat);
  scripted.push({ items: rows.map((_, i) => ({ i, action, why: sum })), events: [{ from: rows.map((_, i) => i), kind: level === "reply" || level === "decide" ? "ask" : "info", level, sum }] });
  await tri.classify(chat, rows);
};
const flush = async () => { kvSet("triage.notified_at", "0"); const n = sent.length; await tri.flushNotices(); return sent.slice(n); };

// ---- notify: he answers inside the window ----
insert("a1", "oc_a", "other", 5);
await sort("oc_a", "notify", "reply", "小林要方案A");
ok(m("a1").attn === "waiting" && m("a1").wait_until === now - 5 * MIN + 30 * MIN, "default window: 30 minutes from when it was said");
ok((await flush()).length === 0, "nothing is sent while it waits");
ok(say("a2", "oc_a", 3, { text: "看了，可以" }) === 1 && ev("a1")?.state === "done" && ev("a1")?.done_by === "replied", "his word after triage closes the event");
due("a1"); await tri.release();
ok(m("a1").attn === "answered" && m("a1").triage_action === "notify", "window over: answered, Triage's decision is kept");
ok((await flush()).length === 0, "answered in the window → no reminder");

// ---- notify: nobody answers ----
insert("b1", "oc_b", "other", 40, { text: "第一件" }); await sort("oc_b", "notify", "reply", "小林要方案B");
insert("b2", "oc_b2", "other", 40, { text: "第二件" }); await sort("oc_b2", "notify", "decide", "小林等拍板C");
await tri.release();
const n1 = await flush();
ok(n1.length === 1 && n1[0].includes("方案B") && n1[0].includes("拍板C"), "two due reminders go out as one message");
ok(m("b1").triage_action === "notified" && ev("b1")?.state === "open", "reminded once, the ask stays open");
ok((await flush()).length === 0, "it is not repeated");
insert("b3", "oc_b3", "other", 40); await sort("oc_b3", "notify", "reply", "小林要方案D");
kvSet("triage.notified_at", String(Date.now()));   // a batch just went out
await tri.flushNotices();
ok(!sent.at(-1)!.includes("方案D") && m("b3").triage_action === "notify", "batches keep their 10 minute spacing");
await flush();

// ---- draft waits too ----
insert("c1", "oc_c", "other", 5); await sort("oc_c", "draft", "reply");
ok(drafted.length === 0 && m("c1").attn === "waiting", "draft: no run inside the window");
say("c2", "oc_c", 2); due("c1"); await tri.release();
ok(drafted.length === 0 && m("c1").attn === "answered", "he answered himself: never drafted");
insert("c3", "oc_c3", "other", 40); await sort("oc_c3", "draft", "reply");
ok(drafted.join() === "c3" && m("c3").triage_action === "notify", "window over, no answer: the draft runs");
await flush();
// a draft voided by words that didn't answer it
insert("c4", "oc_c4", "other", 40); await sort("oc_c4", "draft", "reply", "小林要方案E");
run("UPDATE messages SET triage_action='draft', attn=NULL WHERE id='c4'");
run("INSERT INTO approvals(kind, status, trigger_msg_id, ts, decided_at) VALUES('send','invalidated','c4',?,?)", now, now);
insert("c5", "oc_c5", "other", 40); await sort("oc_c5", "draft", "reply", "小林要方案旧");
run("UPDATE messages SET triage_action='draft', attn=NULL WHERE id='c5'");
run("INSERT INTO approvals(kind, status, trigger_msg_id, ts, decided_at) VALUES('send','invalidated','c5',?,?)", now, now - 48 * 60 * MIN);
ok(E.requeueVoidedDrafts() === 1 && (await flush()).join().includes("方案E"), "a voided draft whose ask is still open becomes a reminder");
ok(m("c5").triage_action === "draft", "one voided long ago does not resurface");

// ---- escalate ----
insert("d1", "oc_d", "other", 1); await sort("oc_d", "escalate", "reply");
ok(escalated("d1") && m("d1").attn === null, "escalate does not wait by default");
gate("attention: { escalate_wait_minutes: 10, places: { oc_now: 0, oc_ten: 10, tickets: 5 } }\nproactive_daily_cap: 1\n");
await new Promise((r) => setTimeout(r, 20));
insert("d2", "oc_d2", "other", 1); await sort("oc_d2", "escalate", "reply");
ok(!escalated("d2") && m("d2").attn === "waiting", "escalate_wait_minutes delays it");
say("d3", "oc_d2", 0); due("d2"); await tri.release();
ok(!escalated("d2") && m("d2").attn === "answered", "answered meanwhile: not escalated");
ok(waitMinutes("oc_now", "feishu:group", "escalate") === 0 && waitMinutes("oc_x", "feishu:group", "escalate") === 10, "a place can shorten an escalation's wait");

// ---- per place ----
insert("e1", "oc_now", "other", 1); await sort("oc_now", "notify", "reply", "小林要方案F");
ok(m("e1").attn === null && (await flush()).join().includes("方案F"), "a place set to 0 does not wait");
insert("e2", "oc_ten", "other", 1); await sort("oc_ten", "notify", "reply");
ok(m("e2").wait_until === now - MIN + 10 * MIN, "a place's own window");
ok(waitMinutes("tickets:T-1", "source:tickets", "notify") === 5 && waitMinutes("other:T-1", "source:other", "notify") === 30, "a source id covers all its places");

// ---- sources: from_me ----
const src = { id: "tickets", kind: "command", run: "x" } as any;
S.ingestItems(src, [{ ref: "t1", text: "T-1 要你审批", where: "T-1", ts: now - 4 * MIN, who: "小林", to_me: true }]);
await sort("tickets:T-1", "notify", "decide");
S.ingestItems(src, [{ ref: "t2", text: "批了", where: "T-1", ts: now - 2 * MIN, from_me: true, reply_to: "t1" }]);
ok(ev("src:tickets:t1")?.done_by === "replied", "from_me reply_to closes the event");
S.ingestItems(src, [{ ref: "t3", text: "T-2 要你看", where: "T-2", ts: now - 4 * MIN, who: "小林" }]);
await sort("tickets:T-2", "notify", "reply");
S.ingestItems(src, [{ ref: "t4", text: "看了", where: "T-2", ts: now - 2 * MIN, from_me: true }]);
ok(ev("src:tickets:t3")?.state === "done", "a from_me word on the same ticket answers it");
S.ingestItems(src, [{ ref: "t5", text: "新版本发布", ts: now - 4 * MIN, who: "小林" }]);
await sort("tickets:tickets", "notify", "reply");
S.ingestItems(src, [{ ref: "t6", text: "别的事", ts: now - 2 * MIN, from_me: true }]);
ok(ev("src:tickets:t5")?.state === "open", "a feed with no named place: his word there answers nothing");

// ---- in a group, when in doubt it stays open ----
const openAfter = async (id: string, chat: string, o: Parameters<typeof insert>[3], word: Parameters<typeof insert>[3]) => {
  insert(id, chat, "other", 10, o); await sort(chat, "notify", "reply");
  say(`${id}w`, chat, 5, word);
  return ev(id)?.state === "open";
};
ok(await openAfter("f1", "oc_f1", {}, { reply: "om_something_else" }), "replying to something else does not close it");
ok(await openAfter("f2", "oc_f2", { thread: "omt_a" }, { thread: "omt_b" }), "speaking in another thread does not close it");
ok(await openAfter("f3", "oc_f3", { thread: "omt_a" }, {}), "asked in a thread, he spoke in the main chat: still open");
ok(await openAfter("f4", "oc_f4", {}, { mentions: ["ou_fake_someone"] }), "@-ing someone else does not close it");
ok(!(await openAfter("f5", "oc_f5", { thread: "omt_a" }, { thread: "omt_a" })), "speaking in its thread closes it");
ok(!(await openAfter("f6", "oc_f6", {}, { mentions: ["ou_fake_asker"] })), "@-ing whoever asked closes it");
insert("g1", "oc_g", "other", 20); await sort("oc_g", "notify", "reply");
for (const i of [1, 2, 3, 4]) insert(`g1o${i}`, "oc_g", "other", 15, { text: "别的话题" });
run("UPDATE messages SET triage_status='done', triage_action='ignore' WHERE id LIKE 'g1o%'");
say("g2", "oc_g", 10);
ok(ev("g1")?.state === "open", "the talk moved on before he spoke: still open");
insert("h1", "oc_h", "other", 20, { text: "第一问" }); await sort("oc_h", "notify", "reply");
insert("h2", "oc_h", "other", 19, { text: "第二问" }); await sort("oc_h", "notify", "reply");
ok(say("h3", "oc_h", 18) === 1 && ev("h2")?.state === "done" && ev("h1")?.state === "open", "one plain word closes one ask, the newest");
ok(say("h4", "oc_h", 17, { reply: "h1" }) === 1 && ev("h1")?.state === "done", "a direct reply closes its own");
// he answered before Triage got to it; and a word already spent is not spent again
insert("i1", "oc_i", "other", 20); say("i2", "oc_i", 19); await sort("oc_i", "notify", "reply");
ok(ev("i1")?.state === "done" && m("i1").attn !== null, "answered before triage ran: born done");
insert("j1", "oc_j", "other", 20); await sort("oc_j", "notify", "reply");
insert("j2", "oc_j", "other", 19);
ok(say("j3", "oc_j", 18) === 1, "his word closes the ask it can see");
await sort("oc_j", "notify", "reply");
ok(ev("j2")?.state === "open", "the same word does not also close one Triage reads later");
all("SELECT id FROM messages WHERE attn='waiting'").forEach((r) => due(r.id));
await tri.release(); await flush();

// ---- read receipts and the daily cap: only for what isn't an ask ----
insert("om_k1", "oc_k", "other", 40, { text: "公告一" }); await sort("oc_k", "notify", "watch", "公告一");
readSet = new Set(["om_k1"]);
ok((await flush()).length === 0 && m("om_k1").attn === "read", "worth knowing and already read: no reminder");
insert("om_k2", "oc_k2", "other", 40); await sort("oc_k2", "notify", "reply", "小林要方案G");
readSet = new Set(["om_k2"]);
ok((await flush()).join().includes("方案G"), "an ask he read but did not answer still reaches him");
insert("om_k3", "oc_k3", "other", 40); await sort("oc_k3", "notify", "watch", "公告三");
readFails = true;
ok((await flush()).join().includes("公告三"), "read status unavailable: the reminder goes");
readFails = false; readSet = new Set();
insert("om_k4", "oc_k4", "other", 40); await sort("oc_k4", "notify", "watch", "公告四");
insert("om_k5", "oc_k5", "other", 40); await sort("oc_k5", "notify", "reply", "小林要方案H");
const k = await flush();
ok(k.length === 1 && k[0].includes("方案H") && !k[0].includes("公告四") && m("om_k4").attn === "held", "over the cap: the ask goes, the rest are held");
ok(Number(one("SELECT v FROM kv WHERE k=?", `notice.${localStamp().slice(0, 10)}`)?.v) === 1, "only batches with non-asks use the quota");
const morning = morningText();
ok(morning.includes("公告四") && m("om_k4").attn === null && m("om_k4").triage_action === "notified", "what was held goes into the morning report");
ok(!morningText().includes("公告四"), "and only once");

// ---- config ----
const G = SCHEMAS["gate.yaml"];
ok(G.safeParse({ attention: { wait_minutes: 0, escalate_wait_minutes: 5, places: { oc_x: 15, feishu_dm: 0 } } }).success && !G.safeParse({ attention: { wait_minutes: -1 } }).success && !G.safeParse({ attention: { places: { oc_x: "soon" } } }).success, "gate.yaml attention is validated");
ok(widening("gate.yaml", {}, { attention: { wait_minutes: 0 } }).length === 1 && widening("gate.yaml", { attention: { places: { oc_x: 20 } } }, { attention: { places: { oc_x: 5 } } }).length === 1, "a shorter window is flagged");
ok(widening("gate.yaml", {}, { attention: { wait_minutes: 60, places: { oc_x: 45 } } }).length === 0, "a longer one is not");

await new Promise<void>((r) => fake.close(() => r()));
console.log(`\n${process.exitCode ? "SOME FAILED" : "ALL PASS"}`);
process.exit(process.exitCode ?? 0);
