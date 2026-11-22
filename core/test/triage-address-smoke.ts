// Triage: who a message is said to (DESIGN §读2.4). On the VPS, as sbot, on a fresh throwaway home:
//
//   ssh <server> 'bash -s' < test/vps-test-home.sh triage-address-smoke.ts 7830
//
// A fake model on the proxy port plays the misjudgment seen live: a message that @s a bot ("check the gateway")
// escalated, one that @s two colleagues drafted as if he were asked. Code must hold: @ someone else is not @ him.
// Names and IDs here are made up.

import http from "node:http";
import { mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { P, ownerFeishu, PROXY_PORT } from "../src/config.ts";
import { one, all, run, kvSet } from "../src/db.ts";
import { ensureAgentHome } from "../src/memory.ts";

const here = dirname(fileURLToPath(import.meta.url));
const ok = (cond: unknown, what: string) => { console.log(`${cond ? "PASS" : "FAIL"} ${what}`); if (!cond) process.exitCode = 1; };
for (const d of [P.sessions, P.logs]) mkdirSync(d, { recursive: true });
ensureAgentHome(join(here, "..", "seed", "agent-home"));
const { Triage } = await import("../src/triage.ts");

const owner = ownerFeishu()!;
const BOT = "cli_fakebot", A = "ou_fake_a", B = "ou_fake_b";
const now = Date.now(), MIN = 60_000;
kvSet("feishu.owner_dm_chat", "oc_fake_dm");   // so an escalation would land in the owner lane
const msg = (id: string, chat: string, kind: string, ago: number, text: string, mentions: string[] = [], names: string[] = [], who = "小李") =>
  run("INSERT INTO messages(id, surface, chat_id, sender_id, sender_kind, ts, text, raw_json, triage_status) VALUES(?,?,?,?,?,?,?,?,?)",
    id, "feishu:group", chat, kind === "bot" ? BOT : "ou_fake_sender", kind, now - ago * MIN, text,
    JSON.stringify({ chat_name: "运维群", sender_name: who, mentions, names }), kind === "bot" ? "skipped" : "pending");
const pending = (chat: string) => all("SELECT * FROM messages WHERE chat_id=? AND triage_status='pending' ORDER BY ts, id", chat);
const act = (id: string) => one("SELECT triage_action a FROM messages WHERE id=?", id)?.a;
const evOf = (id: string) => one("SELECT e.* FROM events e JOIN messages m ON m.event_id=e.id WHERE m.id=?", id);
const escalated = (id: string) => !!one("SELECT 1 FROM inbox WHERE source='triage' AND source_msg_id=?", id);

const scripted: unknown[] = [];
const seen: { user: string }[] = [];
const fake = http.createServer((req, res) => {
  let b = "";
  req.on("data", (d) => { b += d; });
  req.on("end", () => {
    const j = JSON.parse(b || "{}");
    seen.push({ user: String(j.messages?.[0]?.content ?? "") });
    const next = scripted.shift();
    res.writeHead(200, { "content-type": "application/json", connection: "close" });
    res.end(JSON.stringify({ content: [{ type: "text", text: typeof next === "string" ? next : JSON.stringify(next ?? {}) }], usage: { input_tokens: 1, output_tokens: 1 } }));
  });
});
await new Promise<void>((r) => fake.listen(PROXY_PORT, "127.0.0.1", () => r()));
const drafts: string[] = [];
const stubRunner = { run: async (o: any) => { drafts.push(o.text); return { text: "收到", stop: "done", sessionRef: "stub", toolCalls: 0, usage: { output: 0 } }; } };
const tri = new Triage(stubRunner as any) as any;

// ---- the model overreacts; code decides who it was said to ----
msg("x0", "oc_x", "bot", 60, "【日报】网关请求 40，成功率 100%", [], [], "测试机器人");
msg("x1", "oc_x", "other", 30, "@测试机器人 网关好像打不开了，查一下", [BOT], ["测试机器人"]);
msg("x2", "oc_x", "other", 29, "@甲 @乙 产品经理定了吗？", [A, B], ["甲", "乙"]);
msg("x3", "oc_x", "other", 28, "@我 方案你看下", [owner], ["我"]);
msg("x4", "oc_x", "other", 27, "线上全挂了，谁在？");
msg("x5", "oc_x", "other", 26, "@甲 @测试机器人 一起看下这个报错", [A, BOT], ["甲", "测试机器人"]);
scripted.push({
  items: [{ i: 0, action: "escalate", why: "网关打不开，要他尽快排查" }, { i: 1, action: "draft", why: "问产品经理是谁" },
    { i: 2, action: "archive", why: "方案" }, { i: 3, action: "escalate", why: "线上事故" }, { i: 4, action: "notify", why: "报错" }],
  events: [{ from: [0], kind: "risk", level: "reply", sum: "网关打不开" }, { from: [1], kind: "ask", level: "reply", sum: "问产品经理" },
    { from: [2], kind: "ask", level: "reply", sum: "看方案" }, { from: [3, 4], kind: "risk", level: "decide", sum: "线上故障" }],
});
await tri.classify("oc_x", pending("oc_x"));
const user = seen.at(-1)!.user;
const lineOf = (t: string) => user.split("\n").find((l) => l.includes(t)) ?? "";
ok(lineOf("网关好像打不开").includes("[@别人：测试机器人（机器人）]") && !lineOf("网关好像打不开").includes("[@我]"), "an @bot line says who it is said to, not [@我]");
ok(lineOf("产品经理定了吗").includes("[@别人：甲、乙]"), "an @people line names them");
ok(lineOf("方案你看下").includes("[@我]") && !lineOf("线上全挂了").includes("[@"), "@him is [@我]; nobody @-ed has no mark");
ok(lineOf("【日报】").includes("测试机器人（机器人）"), "a bot sender in the context is labelled a bot");

ok(act("x1") === "archive" && !escalated("x1"), "@ only a bot: archived, never escalated to him");
ok(!evOf("x1") || evOf("x1").level === "fyi", "@ only a bot: its event is at most 知道就行");
ok(act("x2") === "notify" && drafts.length === 0, "@ other people: at most notify, never drafted as if he were asked");
ok(evOf("x2")?.level === "watch" && evOf("x2")?.state === "seen", "@ other people: event at most 要盯, not waiting on him");
ok(act("x3") === "notify" && evOf("x3")?.level === "reply", "@ him: still at least notify, 要你回");
ok(act("x4") === "escalate" && escalated("x4"), "nobody @-ed: the model's escalate stands");
ok(act("x5") === "notify" && evOf("x5")?.level === "decide", "@ a person and a bot inside a decide event: lifted to notify, not above");

// ---- rules only (the model fails): @ others is not @ him ----
msg("y1", "oc_y", "other", 20, "@测试机器人 再查一次", [BOT], ["测试机器人"]);
msg("y2", "oc_y", "other", 19, "@甲 你来回一下", [A], ["甲"]);
msg("y3", "oc_y", "other", 18, "@我 你来回一下", [owner], ["我"]);
scripted.push("看不懂", "还是看不懂");
await tri.classify("oc_y", pending("oc_y"));
ok(act("y1") === "archive" && act("y2") === "archive" && act("y3") === "notify", "rules only: @ others archived, @ him notify");

await new Promise<void>((r) => fake.close(() => r()));
console.log(`\n${process.exitCode ? "SOME FAILED" : "ALL PASS"}`);
process.exit(process.exitCode ?? 0);
