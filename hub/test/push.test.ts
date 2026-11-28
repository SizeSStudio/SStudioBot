// W3b: push — the push_queue state machine, presence, night, reads, the daily cap, FCM behind its flag (a fake
// sender), personal saying one line, 省心. Times are fixed wall-clock moments in the hub's timezone so night and
// "today" don't depend on when the test runs. Every id, token and text here is made up.
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import type { Req } from "../../protocol/frames.ts";
import { EaseRes, PushTokenRes, ReadRes } from "../../protocol/api/push.ts";
import { BootstrapRes } from "../../protocol/api/stream.ts";
import { openDb, type Db, type Row } from "../src/db/db.ts";
import { registerChannel, unregisterChannel } from "../src/channels/registry.ts";
import { createApi, type Api, type DispatchCaller } from "../src/api/index.ts";
import { submitApproval } from "../src/approvals.ts";
import { enqueue, morningFacts, openCount, Push, setEase, usedToday } from "../src/push/queue.ts";
import type { FcmMessage, FcmResult } from "../src/push/fcm.ts";
import { registerBuiltinTools } from "../src/tools/builtin.ts";
import { allTools, toolNamed } from "../src/tools/registry.ts";
import { wallTime } from "../src/time.ts";
import { fakeChannel, w1dHome } from "./w1d-helpers.ts";

const PHONE = "a".repeat(64), LAPTOP = "b".repeat(64);
const TOKEN = "fake-fcm-token-0001";
const DAY = wallTime(2026, 12, 2, 14, 0);        // a Wednesday afternoon
const NIGHT = wallTime(2026, 12, 2, 23, 30);
const MIN = 60_000;
let n = 0;
const req = (method: Req["method"], path: string, body?: unknown): Req =>
  ({ t: "req", id: ++n, method, path, ...(body !== undefined ? { body } : {}), client_op_id: `op_${randomBytes(8).toString("hex")}` });

interface Fcm { sent: { token: string; m: FcmMessage }[]; answer: FcmResult; send(token: string, m: FcmMessage): Promise<FcmResult> }
const fakeFcm = (): Fcm => {
  const f: Fcm = { sent: [], answer: "ok", async send(token, m) { f.sent.push({ token, m }); return f.answer; } };
  return f;
};

interface S { db: Db; api: Api; push: Push; fcm: Fcm; feishu: ReturnType<typeof fakeChannel>; done: () => void }
async function setup(tag: string, o: { fcm?: boolean; gate?: string } = {}): Promise<S> {
  const home = await w1dHome(tag, { files: {
    ...(o.fcm !== false ? { "console.yaml": "fcm:\n  enabled: true\n" } : {}),
    ...(o.gate ? { "gate.yaml": o.gate } : {}),
  } });
  const db = openDb(home.db);
  const feishu = fakeChannel("feishu");
  unregisterChannel("feishu");
  registerChannel(feishu);
  db.run("INSERT INTO devices(id, role, name, public_key, push_token, created_at) VALUES (?, 'client', 'phone', ?, ?, ?), (?, 'client', 'laptop', ?, NULL, ?)",
    PHONE, Buffer.alloc(32, 5), TOKEN, DAY, LAPTOP, Buffer.alloc(32, 6), DAY);
  const fcm = fakeFcm();
  const push = new Push({ db, fcm });
  const api = createApi({ db, blobs: home.blobs, hubSha: () => "testsha", pump: { batch: 7, beatMs: 0 }, push });
  return { db, api, push, fcm, feishu, done: () => { unregisterChannel("feishu"); db.close(); } };
}

const row = (db: Db, cat: string, ref: string) => db.one<Row>("SELECT * FROM push_queue WHERE cat = ? AND ref = ?", cat, ref)!;
/** what push wrote for the channel (Feishu): outbox rows it made */
const channelRows = (db: Db) => db.all<Row>("SELECT * FROM outbox WHERE idem_key LIKE 'push:%' ORDER BY id");
const here = (s: S, viewing: string | null, at: number, device = LAPTOP) => s.push.presence.report(device, { foreground: true, viewing }, at);
const away = (s: S, at: number, device = LAPTOP) => s.push.presence.report(device, { foreground: false }, at);

test("the client looking at it: neither Feishu nor the phone rings; present elsewhere: counted only", async () => {
  const s = await setup("w3b-looking");
  enqueue(s.db, { cat: "ask", ref: "approval:7", lane: "feishu:wb:th1", text: "等你拍板：周四开会吗" }, DAY);
  enqueue(s.db, { cat: "owner_followup", ref: "timer:3", lane: "feishu:wb:th1", text: "到点了：给虚构供应商回电话" }, DAY);
  here(s, "approval:7", DAY);
  await s.push.drain(DAY + 1000);
  assert.equal(row(s.db, "ask", "approval:7").state, "done", "the one on screen is seen");
  assert.equal(row(s.db, "owner_followup", "timer:3").state, "counted", "present, not looking: only counted");
  assert.equal(s.fcm.sent.length, 0);
  assert.equal(channelRows(s.db).length, 0);
  // walking away: what is still open goes out then (urgent: FCM and Feishu both)
  away(s, DAY + 2 * MIN);
  await s.push.drain(DAY + 2 * MIN);
  assert.equal(row(s.db, "owner_followup", "timer:3").state, "sent");
  assert.equal(s.fcm.sent.length, 1);
  assert.equal(channelRows(s.db).length, 1);
  s.done();
});

test("a thread on screen covers the pushes of its lane; three minutes without input counts as away", async () => {
  const s = await setup("w3b-thread");
  s.db.run("INSERT INTO threads(id, lane, kind, domain, created_at) VALUES ('th_fake1', 'console:t:th_fake1', 'general', 'work', ?)", DAY);
  enqueue(s.db, { cat: "task_end", ref: "task:t9:done", lane: "console:t:th_fake1", text: "任务 t9 完成" }, DAY);
  enqueue(s.db, { cat: "task_end", ref: "task:t10:done", lane: "console:t:other", text: "任务 t10 完成" }, DAY);
  here(s, "thread:th_fake1", DAY);
  await s.push.drain(DAY + 1000);
  assert.equal(row(s.db, "task_end", "task:t9:done").state, "done");
  assert.equal(row(s.db, "task_end", "task:t10:done").state, "counted");
  await s.push.drain(DAY + 4 * MIN);   // no input for > away_seconds (180)
  assert.equal(row(s.db, "task_end", "task:t10:done").state, "sent");
  s.done();
});

test("walked away: not urgent → the phone only, Feishu stays quiet (D15)", async () => {
  const s = await setup("w3b-away");
  enqueue(s.db, { cat: "task_end", ref: "task:t42:done", lane: "task:t42", text: "任务 t42 完成" }, DAY);
  await s.push.drain(DAY + 1000);
  const r = row(s.db, "task_end", "task:t42:done");
  assert.equal(r.state, "sent");
  assert.deepEqual(s.fcm.sent.map((x) => x.token), [TOKEN]);
  assert.equal(s.fcm.sent[0]!.m.data.ref, "task:t42");
  assert.equal(s.fcm.sent[0]!.m.channel, "task");
  assert.equal(channelRows(s.db).length, 0, "FCM took it: no Feishu");
  s.done();
});

test("token invalid → cleared, and this push goes to Feishu; FCM off (the default) → Feishu", async () => {
  const s = await setup("w3b-invalid");
  s.fcm.answer = "invalid";
  enqueue(s.db, { cat: "task_end", ref: "task:t43:done", lane: "task:t43", text: "任务 t43 完成" }, DAY);
  await s.push.drain(DAY + 1000);
  assert.equal(s.db.one<Row>("SELECT push_token FROM devices WHERE id = ?", PHONE)!.push_token, null);
  assert.equal(s.db.one<{ n: number }>("SELECT COUNT(*) AS n FROM device_audit WHERE device_id = ? AND action = 'token_cleared'", PHONE)!.n, 1);
  const out = channelRows(s.db);
  assert.equal(out.length, 1);
  assert.equal(out[0]!.channel, "feishu");
  assert.match(String(out[0]!.payload), /任务 t43 完成/);
  s.done();

  const off = await setup("w3b-fcm-off", { fcm: false });
  enqueue(off.db, { cat: "task_end", ref: "task:t44:done", lane: "task:t44", text: "任务 t44 完成" }, DAY);
  await off.push.drain(DAY + 1000);
  assert.equal(off.fcm.sent.length, 0, "fcm.enabled is off: the sender is never called");
  assert.equal(channelRows(off.db).length, 1);
  assert.equal(off.push.fcmEnabled(), false);
  off.done();
});

test("urgent → FCM and Feishu both, even when FCM took it (D1)", async () => {
  const s = await setup("w3b-urgent");
  const id = submitApproval(s.db, { kind: "plan", title: "虚构计划：重排周会", origin_lane: "feishu:wb:th2" });
  s.db.run("UPDATE push_queue SET expires_at = NULL");   // the fixed afternoon below may be past the card's real expiry
  await s.push.drain(DAY);
  assert.equal(row(s.db, "approval", `approval:${id}`).state, "sent");
  assert.equal(s.fcm.sent.length, 1);
  assert.equal(s.fcm.sent[0]!.m.channel, "approval");
  const out = channelRows(s.db);
  assert.equal(out.length, 1, "the DM line, beside the admin card");
  assert.match(String(out[0]!.payload), /虚构计划/);
  s.done();
});

test("night: recorded only, into the morning report; night_allow and what expires tonight still go", async () => {
  const s = await setup("w3b-night");
  enqueue(s.db, { cat: "notice", ref: "notice:ci3", lane: "feishu:wb:th3", text: "CI 第 3 次红" }, NIGHT);
  enqueue(s.db, { cat: "fyi", ref: "digest:g7", lane: "feishu:wb:th3", text: "群里聊了 30 条" }, NIGHT);
  enqueue(s.db, { cat: "approval", ref: "approval:91", lane: "feishu:wb:th3", text: "等你过目：明早的回复", expires_at: NIGHT + 12 * 60 * MIN }, NIGHT);
  enqueue(s.db, { cat: "approval", ref: "approval:92", lane: "feishu:wb:th3", text: "等你过目：今晚到期", expires_at: NIGHT + 60 * MIN }, NIGHT);
  enqueue(s.db, { cat: "owner_followup", ref: "timer:8", lane: "feishu:dm:owner", text: "到点了：吃药" }, NIGHT);
  enqueue(s.db, { cat: "agent_followup", ref: "timer:9", lane: "feishu:dm:owner", text: "问问进展" }, NIGHT);
  await s.push.drain(NIGHT + 1000);
  assert.equal(row(s.db, "notice", "notice:ci3").state, "night");
  assert.equal(row(s.db, "approval", "approval:91").state, "night");
  assert.equal(row(s.db, "approval", "approval:92").state, "sent", "expires before the night ends: goes now");
  assert.equal(row(s.db, "owner_followup", "timer:8").state, "sent", "night_allow");
  const af = row(s.db, "agent_followup", "timer:9");
  assert.equal(af.state, "wait", "its own follow-up moves to the night's end");
  assert.equal(Number(af.not_before), wallTime(2026, 12, 3, 8, 0));
  const morning = wallTime(2026, 12, 3, 8, 30);
  const f = morningFacts(s.db, morning);
  assert.match(f.text, /夜里来的（2 条/);
  assert.match(f.text, /CI 第 3 次红/);
  assert.match(f.text, /等你过目：明早的回复/);
  assert.match(f.text, /知道就好的 1 条/, "fyi doesn't 补推: only a count");
  assert.equal(f.text.includes("群里聊了"), false);
  f.commit();
  assert.equal(row(s.db, "notice", "notice:ci3").state, "done");
  assert.equal(row(s.db, "approval", "approval:91").state, "done");
  assert.equal(morningFacts(s.db, morning).text.includes("夜里来的"), false, "taken once");
  s.done();
});

test("I wrote at night: the next awake_minutes count as day", async () => {
  const s = await setup("w3b-awake");
  s.db.run(`INSERT INTO inbox(lane, kind, source, source_msg_id, payload_json, device_id, ts) VALUES ('console:main', 'user', 'device:x', 'm1', '{}', ?, ?)`, PHONE, NIGHT - 10 * MIN);
  enqueue(s.db, { cat: "task_end", ref: "task:t5:done", lane: "task:t5", text: "任务 t5 完成" }, NIGHT);
  await s.push.drain(NIGHT);
  assert.equal(row(s.db, "task_end", "task:t5:done").state, "sent", "awake: not night; quiet for 10 min > 5");
  s.done();
});

test("对话中先等: not urgent waits for 5 quiet minutes, at most 30 from enqueue", async () => {
  const s = await setup("w3b-quiet");
  s.db.run(`INSERT INTO inbox(lane, kind, source, source_msg_id, payload_json, device_id, ts) VALUES ('console:main', 'user', 'device:x', 'm1', '{}', ?, ?)`, PHONE, DAY - MIN);
  enqueue(s.db, { cat: "task_end", ref: "task:t6:done", lane: "task:t6", text: "任务 t6 完成" }, DAY);
  enqueue(s.db, { cat: "ask", ref: "approval:61", lane: "task:t6", text: "等你回：选哪个" }, DAY);
  await s.push.drain(DAY);
  assert.equal(row(s.db, "task_end", "task:t6:done").state, "wait");
  assert.equal(row(s.db, "ask", "approval:61").state, "sent", "等我回 doesn't wait");
  s.db.run(`INSERT INTO inbox(lane, kind, source, source_msg_id, payload_json, device_id, ts) VALUES ('console:main', 'user', 'device:x', 'm2', '{}', ?, ?)`, PHONE, DAY + 29 * MIN);
  await s.push.drain(DAY + 29 * MIN + 1000);
  assert.equal(row(s.db, "task_end", "task:t6:done").state, "wait");
  await s.push.drain(DAY + 30 * MIN + 1000);
  assert.equal(row(s.db, "task_end", "task:t6:done").state, "sent", "the deadline");
  s.done();
});

test("read on one end: its pushes close and the N in the next push follows", async () => {
  const s = await setup("w3b-reads", { fcm: false });
  s.db.run("INSERT INTO threads(id, lane, kind, domain, created_at) VALUES ('th_fake2', 'console:t:th_fake2', 'general', 'work', ?)", DAY);
  enqueue(s.db, { cat: "ask", ref: "approval:11", lane: "console:t:th_fake2", text: "等你回：一" }, DAY);
  enqueue(s.db, { cat: "ask", ref: "approval:12", lane: "feishu:wb:x", text: "等你回：二" }, DAY);
  await s.push.drain(DAY);
  assert.equal(openCount(s.db), 2);
  assert.match(String(channelRows(s.db).at(-1)!.payload), /共 2 条/);
  // the laptop reads the thread: the push about it is done, on every end
  const out = await s.api.dispatch(req("POST", "/api/v1/reads", { entity: "thread", id: "th_fake2", upto_ts: DAY + 5000 }), { device_id: LAPTOP, role: "client" });
  assert.equal(out.status, 200);
  assert.equal(ReadRes.parse(out.body).read.via, `device:${LAPTOP}`);
  assert.equal(row(s.db, "ask", "approval:11").state, "done");
  assert.equal(openCount(s.db), 1);
  enqueue(s.db, { cat: "ask", ref: "approval:13", lane: "feishu:wb:x", text: "等你回：三" }, DAY + 6000);
  await s.push.drain(DAY + 6000);
  assert.match(String(channelRows(s.db).at(-1)!.payload), /共 2 条/, "1 left + this one");
  // upto_ts never moves back; reading an item closes its state-suffixed rows too
  await s.api.dispatch(req("POST", "/api/v1/reads", { entity: "thread", id: "th_fake2", upto_ts: DAY }), { device_id: PHONE, role: "client" });
  assert.equal(s.db.one<Row>("SELECT upto_ts FROM reads WHERE ref = 'thread:th_fake2'")!.upto_ts, DAY + 5000);
  enqueue(s.db, { cat: "task_end", ref: "task:t7:done", text: "t7" }, DAY);
  await s.api.dispatch(req("POST", "/api/v1/reads", { entity: "task", id: "t7" }), { device_id: PHONE, role: "client" });
  assert.equal(row(s.db, "task_end", "task:t7:done").state, "done");
  // bootstrap carries the read marks it shows
  const b = BootstrapRes.parse((await s.api.dispatch(req("POST", "/api/v1/bootstrap", {}), { device_id: PHONE, role: "client" })).body);
  assert.deepEqual(b.reads?.map((r) => r.ref), ["thread:th_fake2"]);
  s.done();
});

test("省心 on: the tidy card isn't pushed, waiting-for-reply still is; morning top line; day 3 asks once", async () => {
  const s = await setup("w3b-ease");
  const out = await s.api.dispatch(req("PUT", "/api/v1/ease", { on: true }), { device_id: PHONE, role: "client" });
  assert.equal(out.status, 200);
  assert.equal(EaseRes.parse(out.body).ease.on, true);
  assert.equal(s.db.one<{ n: number }>("SELECT COUNT(*) AS n FROM config_changes WHERE file = 'ease'")!.n, 1);
  assert.ok(s.db.one("SELECT 1 FROM change_log WHERE entity = 'ease'"), "the ease entity goes out");
  const since = Number(JSON.parse(s.db.kvGet("ease")!).since);
  enqueue(s.db, { cat: "tidy", ref: "matter_review:d1", lane: "feishu:dm:owner", text: "今天的整理：5 条" }, DAY);
  enqueue(s.db, { cat: "ask", ref: "approval:21", lane: "feishu:wb:y", text: "等你回：要不要订" }, DAY);
  enqueue(s.db, { cat: "fyi", ref: "digest:g1", lane: "feishu:wb:y", text: "群里聊了 12 条" }, DAY);
  await s.push.drain(DAY);
  assert.equal(row(s.db, "tidy", "matter_review:d1").state, "void");
  assert.equal(row(s.db, "fyi", "digest:g1").state, "void");
  assert.equal(row(s.db, "ask", "approval:21").state, "sent");
  // the morning report: the top line, the tidy count; on day 3 the one question, then never again
  const d1 = morningFacts(s.db, DAY + 60 * MIN);
  assert.match(d1.text, /省心中 · 第 \d+ 天/);
  assert.match(d1.text, /有 1 条待整理/);
  const day3 = since + 2 * 86_400_000;
  const f3 = morningFacts(s.db, day3);
  assert.match(f3.text, /第 3 天/);
  assert.match(f3.text, /要不要回常态/);
  f3.commit();
  assert.equal(morningFacts(s.db, day3 + 86_400_000).text.includes("要不要回常态"), false, "asked once");
  // switching back is also mine only, and recorded
  setEase(s.db, false, { actor: `device:${PHONE}`, source: "console" });
  assert.equal(s.db.one<{ n: number }>("SELECT COUNT(*) AS n FROM config_changes WHERE file = 'ease'")!.n, 2);
  s.done();
});

test("ease_set exists only for a turn I typed, and only in my DM or console:main", async () => {
  if (!allTools().length) registerBuiltinTools();
  const t = toolNamed("ease_set")!;
  assert.deepEqual(t.cols, { typed: true, system: false, others: false });
  const s = await setup("w3b-ease-tool");
  const ctx = { db: s.db, run_id: "r_fake", lane: "feishu:wb:th9" } as unknown as Parameters<NonNullable<typeof t.exec>>[1];
  assert.match(await t.exec!({ on: true }, ctx), /^error/);
  assert.equal(s.db.kvGet("ease"), undefined);
  const ok = await t.exec!({ on: true }, { ...ctx, lane: "feishu:dm:owner" } as typeof ctx);
  assert.match(ok, /省心开了/);
  assert.equal(s.db.one<Row>("SELECT source, actor FROM config_changes WHERE file = 'ease'")!.source, "chat");
  s.done();
});

test("proactive_daily_cap counts sent quota rows in push_queue; over it waits for the morning report", async () => {
  const s = await setup("w3b-cap", { gate: "proactive_daily_cap: 2\n" });
  for (const i of [1, 2]) {
    s.db.run("INSERT INTO push_queue(cat, ref, quota, text, state, enq_at, sent_at) VALUES ('notice', ?, 1, 'x', 'sent', ?, ?)", `notice:old${i}`, DAY - 3600_000, DAY - 3600_000);
  }
  s.db.run("INSERT INTO push_queue(cat, ref, quota, text, state, enq_at, sent_at) VALUES ('notice', 'notice:yday', 1, 'x', 'sent', ?, ?)", DAY - 86_400_000, DAY - 86_400_000);
  assert.equal(usedToday(s.db, DAY), 2, "yesterday's doesn't count");
  enqueue(s.db, { cat: "notice", ref: "notice:new", text: "派到别的机器了" }, DAY);
  enqueue(s.db, { cat: "ask", ref: "approval:31", text: "等你回" }, DAY);
  await s.push.drain(DAY);
  assert.equal(row(s.db, "notice", "notice:new").state, "night", "over the cap: held for the morning");
  assert.equal(row(s.db, "ask", "approval:31").state, "sent", "an ask is never held by the cap");
  assert.equal(row(s.db, "ask", "approval:31").quota, 0);
  s.done();
});

test("personal: the phone says only 「有一条私人的」, Feishu only 「客户端有新消息」", async () => {
  const s = await setup("w3b-personal");
  enqueue(s.db, { cat: "ask", ref: "approval:41", lane: "console:main", domain: "personal", text: "关于体检报告的虚构细节" }, DAY);
  await s.push.drain(DAY);
  assert.equal(s.fcm.sent.length, 1);
  assert.deepEqual({ t: s.fcm.sent[0]!.m.title, b: s.fcm.sent[0]!.m.body }, { t: "有一条私人的", b: "" });
  assert.equal(s.fcm.sent[0]!.m.data.personal, "1");
  const out = channelRows(s.db);
  assert.equal(out.length, 1);
  assert.equal(out[0]!.payload, "客户端有新消息");
  assert.equal(JSON.parse(String(out[0]!.target_json)).outlet, "main", "never a shared outlet");
  assert.equal(JSON.stringify(s.fcm.sent).includes("体检"), false);
  s.done();
});

test("PUT push-token: stored, never sent back, audited; fcm_enabled follows the flag; presence answers 200", async () => {
  const s = await setup("w3b-token", { fcm: false });
  const me: DispatchCaller = { device_id: LAPTOP, role: "client" };
  const secretTok = "fake-token-never-echoed-77";
  const out = await s.api.dispatch(req("PUT", "/api/v1/devices/self/push-token", { token: secretTok }), me);
  assert.equal(out.status, 200);
  assert.deepEqual(PushTokenRes.parse(out.body), { has_token: true, fcm_enabled: false });
  assert.equal(s.db.one<Row>("SELECT push_token FROM devices WHERE id = ?", LAPTOP)!.push_token, secretTok);
  assert.equal(JSON.stringify(s.db.all("SELECT * FROM client_ops")).includes(secretTok), false, "not kept in client_ops");
  assert.equal(JSON.stringify(out.body).includes(secretTok), false);
  assert.equal(s.db.one<{ n: number }>("SELECT COUNT(*) AS n FROM device_audit WHERE device_id = ? AND action = 'token_set'", LAPTOP)!.n, 1);
  const cleared = await s.api.dispatch(req("PUT", "/api/v1/devices/self/push-token", { token: null }), me);
  assert.deepEqual(PushTokenRes.parse(cleared.body), { has_token: false, fcm_enabled: false });
  assert.equal((await s.api.dispatch(req("PUT", "/api/v1/devices/self/push-token", { token: "x" }), { device_id: "cli", role: "client" })).status, 404);
  const p = await s.api.dispatch({ t: "req", id: ++n, method: "POST", path: "/api/v1/presence", body: { foreground: true, viewing: "thread:th_x" } }, me);
  assert.deepEqual(p, { status: 200, body: { present: true } });
  const p2 = await s.api.dispatch({ t: "req", id: ++n, method: "POST", path: "/api/v1/presence", body: { foreground: false } }, me);
  assert.deepEqual(p2, { status: 200, body: { present: false } });
  assert.equal((await s.api.dispatch({ t: "req", id: ++n, method: "POST", path: "/api/v1/presence", body: { foreground: true, viewing: "bad ref" } }, me)).status, 400);
  assert.equal((await s.api.dispatch({ t: "req", id: ++n, method: "POST", path: "/api/v1/presence", body: { foreground: true } }, { device_id: "d".repeat(64), role: "node" })).status, 403);
  s.done();

  const on = await setup("w3b-token-on");
  const r = await on.api.dispatch(req("PUT", "/api/v1/devices/self/push-token", { token: null }), me);
  assert.equal(PushTokenRes.parse(r.body).fcm_enabled, true, "flag on and a sender: the client may ask Android");
  on.done();
});

test("a snoozed card sent at 20:00 counts one against the cap; reading it doesn't drop the reminder", async () => {
  const s = await setup("w3b-snooze");
  s.db.run("INSERT INTO push_queue(cat, ref, quota, text, state, not_before, snooze, enq_at) VALUES ('approval', 'approval:51', 1, '等你过目：虚构', 'wait', ?, 'tonight', ?)", wallTime(2026, 12, 2, 20, 0), DAY);
  await s.api.dispatch(req("POST", "/api/v1/reads", { entity: "approval", id: "51" }), { device_id: PHONE, role: "client" });
  assert.equal(row(s.db, "approval", "approval:51").state, "wait");
  await s.push.drain(wallTime(2026, 12, 2, 19, 59));
  assert.equal(row(s.db, "approval", "approval:51").state, "wait");
  await s.push.drain(wallTime(2026, 12, 2, 20, 0));
  assert.equal(row(s.db, "approval", "approval:51").state, "sent");
  assert.equal(usedToday(s.db, wallTime(2026, 12, 2, 20, 1)), 1);
  s.done();
});
