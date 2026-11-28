// W1e's Feishu plugin against real Feishu (08 P9 item 7, 09 「测试应用」), on a home made by live-home.sh: the live bot
// app (no separate test app; events split with the live core while this holds a long connection — accepted), my open_id
// and a test chat with only me and the bot. Sends go only to that chat and my DM. A fake LLM answers (we test the
// channel, not the model); user identity is a fake lark-cli that records what would go out as me.
//   auto     nobody needed: shadow (no connection) → live; my DM streams a real CardKit card; /tasks; a workbench topic
//            (the test chat as workbench); a group @me → triage → draft → real approval card → approved → the send as
//            me reaches lark-cli with exactly the approved text; catch-up runs; the connection closes.
//   session  I'm at Feishu (click list in docs/tech/08 P9): a real DM → a streamed card; approve a card (clicking twice
//            decides once) → a real send as the bot to the test chat; the connection drops for 40 s while I send two
//            DMs → catch-up brings them back.
// Prints ✓/✗ lines, connection windows (UTC) and counts; ids masked. Exits non-zero on the first failure.
import { appendFileSync, mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { fakeLlm, fakeModelsYaml, FAKE_KEY, type Step } from "./fake-llm.ts";

process.env.SBOT_OBSERVE_S = "2";   // before the hub's modules load: the observer reads it once
const { home } = await import("../src/home.ts");
const { boot } = await import("../src/main.ts");
const { channel } = await import("../src/channels/registry.ts");
const { channelHost } = await import("../src/channels/host.ts");
const { decide, submitApproval } = await import("../src/approvals.ts");
const { secret } = await import("../src/secrets.ts");
const { setQuiet } = await import("../src/log.ts");
const { SdkBackend } = await import("../src/channels/feishu/sdk.ts");
const { OWNER_DM_KEY, OWNER_DM_LANE } = await import("../src/channels/feishu/state.ts");
type FeishuChannel = import("../src/channels/feishu/plugin.ts").FeishuChannel;
type Incoming = import("../src/channels/feishu/backend.ts").Incoming;

const phase = process.argv[2] ?? "auto";
if (!["auto", "session"].includes(phase)) { console.error("usage: live-feishu.ts auto|session"); process.exit(64); }

class Stop extends Error {}
let step = 0;
function ok(cond: unknown, what: string): asserts cond {
  step++;
  console.log(`${cond ? "✓" : "✗"} ${step}. ${mask(what)}`);
  if (!cond) throw new Stop();
}
const say = (s: string) => console.log(mask(s));
const mask = (s: string) => s.replace(/\b(cli|ou|oc|om|on|ot|ck)_[0-9A-Za-z]{6,}/g, "$1_…");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until<T>(f: () => T | Promise<T>, what: string, ms = 60_000): Promise<NonNullable<T>> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await f();
    if (v) return v as NonNullable<T>;
    if (Date.now() > end) { ok(false, `timed out: ${what}`); }
    await sleep(500);
  }
}
const iso = (t = Date.now()) => new Date(t).toISOString().slice(0, 19) + "Z";

// ── the home live-home.sh made: people.yaml (me), secrets.env (app), test-chat ──
const h = home();
ok(!existsSync(h.db), "fresh home");
const TEST = readFileSync(join(h.root, "test-chat"), "utf8").trim();
const OWNER = /feishu:\s*(\S+)/.exec(readFileSync(join(h.config, "people.yaml"), "utf8"))![1]!;
const OTHER = "ou_livefakeother01";    // made up: someone else in a group, only ever injected, never sent to
const DRAFT = "【sbot 测试】审批过了：这句以我的名义回（测试，lark-cli 是假的，不会真发）。";

const sys = (b: any) => JSON.stringify(b.system ?? "");
const llm = await fakeLlm((b): Step => {
  if (typeof b.system === "string" && b.system.startsWith("检查一条草稿")) return { text: '{"promise":false,"stance":false,"private":false,"hits":[]}' };
  if (sys(b).includes("消息分拣员")) return { text: '{"items":[{"i":0,"action":"draft","why":"问到我了"}],"events":[]}' };
  if (sys(b).includes("起草一条飞书群回复")) return { text: DRAFT };
  // the typed DM: slow enough that the card streams several updates
  return { text: "【sbot 测试】这是测试 hub 的流式卡片：一个字一个字出来，假模型在打字，不是真回答。", pace: 80 };
});

const files: Record<string, string> = {
  "models.yaml": fakeModelsYaml(llm.port),
  "groups.yaml": "reviewed: true\n",   // no first-run review card: its clicks would reach the live core half the time
  "gate.yaml": "attention:\n  wait_minutes: 0\n  escalate_wait_minutes: 0\n",
};
for (const [f, t] of Object.entries(files)) writeFileSync(join(h.config, f), t);
// adminDm: approval cards to my DM instead, so the test chat is an ordinary group (the observer skips admin and workbench chats)
const channels = (mode: "live" | "shadow", o: { admin?: boolean; workbench?: boolean; adminDm?: boolean } = { admin: true }) =>
  writeFileSync(join(h.config, "channels.yaml"), `${o.adminDm ? "outlets:\n  admin: [client, \"feishu:dm\"]\n" : ""}feishu:\n  mode: ${mode}\n${o.admin ? `  admin_chat: ${TEST}\n` : ""}${o.workbench ? `  workbench_chat: ${TEST}\n` : ""}`);
appendFileSync(h.secrets, `FAKE_KEY=${FAKE_KEY}\n`);

// user identity: a fake lark-cli. It lists the test chat, returns the scripted group messages, records sends as me.
const LD = join(h.root, "fake-lark");
mkdirSync(LD, { recursive: true });
writeFileSync(join(LD, "auth.json"), JSON.stringify({ identities: { user: { status: "ready" } } }));
writeFileSync(join(LD, "chats.json"), JSON.stringify({ data: { chats: [{ chat_id: TEST, name: "sbot 测试" }] } }));
let search: any[] = [];
const setSearch = () => writeFileSync(join(LD, "search.json"), JSON.stringify({ data: { messages: search } }));
setSearch();
writeFileSync(join(LD, "lark-cli"), `#!/bin/sh
D='${LD}'
case "$1 $2" in
  "auth status") cat "$D/auth.json" ;;
  "im +messages-search") cat "$D/search.json" ;;
  "im +chat-list") cat "$D/chats.json" ;;
  "im +messages-send"|"im +messages-reply") echo "$*" >> "$D/as-me.args"; cat >> "$D/as-me.stdin"; echo '{"data":{"message_id":"om_fakeasme0001"}}' ;;
  *) echo "$1 $2" >> "$D/other.log"; echo '{"data":{}}' ;;
esac
`, { mode: 0o755 });
process.env.SBOT_LARK_CLI = join(LD, "lark-cli");

// the hub logs JSON lines to stderr: keep them (checks below), print none (they may carry ids)
const lines: string[] = [];
setQuiet(false);
process.stderr.write = ((c: string | Uint8Array) => { lines.push(String(c)); return true; }) as typeof process.stderr.write;

type Hub = Awaited<ReturnType<typeof boot>>;
let hub: Hub | undefined;
const windows: string[] = [];
let openedAt = 0;
async function finish(code: number) {
  if (hub) { await hub.close().catch(() => {}); hub = undefined; }
  if (openedAt) { windows.push(`${iso(openedAt)} → ${iso()}`); openedAt = 0; }
  for (const w of windows) say(`long connection window: ${w}`);
  await llm.close();
  process.exit(code);
}

// REST as the bot, outside the plugin: connection count, sending the real messages the injected ones point at, reading back
const rest = new SdkBackend({ appId: secret("FEISHU_APP_ID") ?? readEnv("FEISHU_APP_ID"), appSecret: secret("FEISHU_APP_SECRET") ?? readEnv("FEISHU_APP_SECRET"), say: () => {} });
function readEnv(k: string) { return new RegExp(`^${k}=(.*)$`, "m").exec(readFileSync(h.secrets, "utf8"))?.[1] ?? ""; }
const conns = async () => Number((await rest.api("GET", "/open-apis/event/v1/connection")).online_instance_cnt);
const post = async (to: string, text: string, type: "chat_id" | "open_id" = "chat_id") =>
  rest.api("POST", "/open-apis/im/v1/messages", { receive_id: to, msg_type: "text", content: JSON.stringify({ text }) }, { receive_id_type: type });
// raw_card_content: without it a JSON 2.0 card reads back as a "please upgrade" placeholder
const getMsg = async (id: string) => ((await rest.api("GET", `/open-apis/im/v1/messages/${id}`, undefined, { card_msg_content_type: "raw_card_content" })).items ?? [])[0];

const q = <T = any>(sql: string, ...a: import("node:sqlite").SQLInputValue[]) => hub!.db.all<T>(sql, ...a);
const out = () => q<{ id: number; kind: string; lane: string | null; status: string; as_identity: string; approval_id: number | null; payload: string; t: string; msg_id: string | null }>(
  "SELECT id, kind, lane, status, as_identity, approval_id, payload, target_json AS t, sent_msg_id AS msg_id FROM outbox ORDER BY id");

async function bootLive(admin = true) {
  channels("live", { admin });
  const before = await conns();
  hub = await boot(h);
  const f = channel("feishu") as FeishuChannel;
  await until(() => lines.some((l) => l.includes("long connection ready")), "long connection ready", 30_000);
  openedAt = Date.now();
  await until(async () => (await conns()) === before + 1, "the app shows one more long connection", 20_000);
  ok(true, `live: long connection up at ${iso(openedAt)} (${before} other online: the live core's)`);
  return f;
}
const owner = (o: Partial<Incoming> & { messageId: string; chatId: string; text: string }): Incoming => ({
  kind: "message", eventId: "", operatorId: OWNER, senderType: "user", messageType: "text", chatType: "p2p",
  createTime: Date.now(), ...o, content: JSON.stringify({ text: o.text }) });

async function auto() {
  // ── shadow first: no connection, sends only logged ──
  channels("shadow");
  const base = await conns();
  hub = await boot(h);
  let f = channel("feishu") as FeishuChannel;
  ok(f.state() === "shadow" && lines.some((l) => l.includes("shadow mode: no long connection")), "shadow: plugin up, says it isn't connecting");
  await sleep(3000);
  ok((await conns()) === base, `shadow: the app's long connections stay at ${base}`);
  const s = await f.send({ id: 0, approval_id: null, run_id: null, lane: null, channel: "feishu", kind: "text", card_id: null, as_identity: "bot",
    target: { chat_id: TEST }, payload: "不该发出", idem_key: "live-shadow-1", send_by: null, attempts: 0 });
  ok(s.ok && s.shadow === true, "shadow: send() only logged");
  await hub.close(); hub = undefined;

  // ── live ──
  f = await bootLive();
  const dm = await post(OWNER, "【sbot 测试】测试 hub 上线（live，自动测试，几分钟）。下面的卡片和回复都是测试，不用回。", "open_id");
  hub!.db.kvSet(OWNER_DM_KEY, dm.chat_id);
  ok(dm.chat_id?.startsWith("oc_") && dm.message_id, "a real DM to me (its chat is my DM with the bot)");

  // my DM → a typed run → a real streaming card (the inbound message is injected; it points at the real DM above)
  f.onMessage(owner({ messageId: dm.message_id, chatId: dm.chat_id, text: "（测试）说一句话" }), "event");
  const card = await until(() => out().find((r) => r.lane === OWNER_DM_LANE && r.kind === "card" && r.status === "sent" && r.msg_id), "the DM card sent", 60_000);
  await until(() => q("SELECT 1 FROM runs WHERE lane = ? AND status = 'done'", OWNER_DM_LANE).length === 1, "the DM run done", 60_000);
  const cm = await getMsg(card.msg_id!);
  ok(cm?.msg_type === "interactive" && cm?.chat_id === dm.chat_id, "my DM: the reply is a real CardKit card in my DM");
  ok(!lines.some((l) => /"card".*update failed/.test(l)), "the card streamed without a failed update");
  ok(!out().some((r) => r.lane === OWNER_DM_LANE && r.kind === "text"), "the card is the reply, no extra text");

  // /tasks in my DM. Only /stop /new /pair /devices are answered by code today; /tasks (W4's) falls through to a run
  const dm2 = await post(dm.chat_id, "【sbot 测试】（下一条模拟你发 /tasks）");
  const before = out().length;
  f.onMessage(owner({ messageId: dm2.message_id, chatId: dm.chat_id, text: "/tasks" }), "event");
  const t = await until(() => out().slice(before).find((r) => r.lane === OWNER_DM_LANE && r.status === "sent" && r.msg_id), "/tasks answered", 60_000);
  const byCode = q<{ k: string }>("SELECT kind AS k FROM inbox WHERE source_msg_id = ?", dm2.message_id)[0]?.k === "command";
  ok((await getMsg(t.msg_id!))?.chat_id === dm.chat_id, `/tasks: answered in my DM as a ${t.kind} (${byCode ? "by code" : "not a code command: it went to the model"})`);

  // workbench topic: the test chat as workbench (and not admin, so my lines there are a topic, not commands)
  channels("live", { workbench: true });
  const root = await post(TEST, "【sbot 测试】工作台话题（模拟你在工作台发起一个话题）");
  f.onMessage(owner({ messageId: root.message_id, chatId: TEST, chatType: "group", text: "（测试）工作台：看一下这周" }), "event");
  const wb = await until(() => out().find((r) => r.lane === `feishu:wb:${root.message_id}` && r.status === "sent" && r.msg_id), "workbench reply", 60_000);
  const wm = await getMsg(wb.msg_id!);
  ok(wm?.chat_id === TEST && !!wm?.thread_id, "workbench: the reply sits in the topic's thread in the test chat");

  // a group @me in the test chat (an ordinary group now) → triage → draft → approval card (admin outlet = my DM) →
  // approved → as me through lark-cli
  channels("live", { adminDm: true });
  const g = await post(TEST, "【sbot 测试】（模拟：有人在群里 @你 问报价，发消息的人是假的）");
  search = [{ message_id: g.message_id, chat_id: TEST, chat_type: "group", chat_name: "sbot 测试", msg_type: "text", content: "@测试 报价什么时候能给？",
    create_time: Date.now(), sender: { id: OTHER, name: "阿乙", sender_type: "user" }, mentions: [{ id: OWNER, name: "测试" }] }];
  setSearch();
  const ap = await until(() => q<{ id: number; status: string; draft: string }>("SELECT id, status, draft FROM approvals WHERE kind = 'send'")[0], "triage filed a draft (ticks every 45 s)", 180_000);
  ok(ap.status === "pending" && ap.draft === DRAFT, "triage → draft → a pending send approval as me");
  const apCard = await until(() => out().find((r) => r.kind === "card" && r.status === "sent" && r.msg_id && r.payload.includes(`"approval_id":${ap.id}`)), "approval card sent", 30_000);
  ok((await getMsg(apCard.msg_id!))?.chat_id === dm.chat_id, "the approval card is a real card in my DM (admin outlet)");
  ok(!existsSync(join(LD, "as-me.args")), "nothing went out as me before I decided");
  const d = decide(hub!.db, ap.id, { decision: "approve", by: { kind: "device", device_id: "cli" } });
  ok(d.ok && !!d.outbox_id, "approved (as a device: the click itself is in the session phase)");
  await until(() => existsSync(join(LD, "as-me.stdin")) && out().find((r) => r.id === (d.ok ? d.outbox_id : 0))?.status === "sent", "the send as me", 30_000);
  const args = readFileSync(join(LD, "as-me.args"), "utf8");
  ok(readFileSync(join(LD, "as-me.stdin"), "utf8") === DRAFT && args.includes(`--message-id ${g.message_id}`) && args.includes("--as user"),
    "as me: lark-cli got exactly the approved text, replying to that message");
  await until(async () => JSON.stringify(await getMsg(apCard.msg_id!)).includes("已批"), "the approval card re-rendered", 30_000);
  ok(true, "the approval card now says 已批 (PATCH on the real card)");

  // catch-up: lists my DM since the cursor; the bot's own lines are skipped
  const n0 = lines.length;
  await f.catchUp();
  ok(lines.slice(n0).some((l) => l.includes("catch-up done")), "catch-up ran against the real DM history");
  ok(!lines.some((l) => l.includes(secret("FEISHU_APP_SECRET") ?? "\u0000")), "the app secret is in none of the hub's log lines");

  await hub!.close(); hub = undefined;
  windows.push(`${iso(openedAt)} → ${iso()}`); openedAt = 0;
  await until(async () => (await conns()) === base, "back to the live core's connection only", 30_000);
  ok(true, `closed: the app is back to ${base} long connection(s)`);
}

// ── session: I'm at Feishu ──
async function session() {
const f = await bootLive();
const clicks: { kind: string; ms: number; op: boolean }[] = [];
const orig = f.onEvent.bind(f);
f.onEvent = (e: Incoming) => { const t = Date.now(); try { return orig(e); } finally { clicks.push({ kind: e.kind, ms: Date.now() - t, op: !!e.operatorId }); } };
const dm = await post(OWNER, "【sbot 测试】测试 hub 上线了（live）。按终端里的提示做；这期间旧核心也在，你发的东西大约一半会被它收走、它也会回你。", "open_id");
hub!.db.kvSet(OWNER_DM_KEY, dm.chat_id);

say("\n▶ 1/3 在和机器人的私聊里发一句话（随便写）。15 秒内这里没有 ✓ 就再发一句——飞书把事件随机分给旧核心和测试 hub。");
const mine = await until(() => q("SELECT id FROM messages WHERE surface = 'feishu:dm' AND sender_kind = 'owner' AND json_extract(raw_json, '$.via') = 'event'")[0], "a real DM from me", 300_000);
ok(!!mine, "a real DM from me reached the test hub over the long connection");
const card = await until(() => out().find((r) => r.lane === OWNER_DM_LANE && r.kind === "card" && r.status === "sent"), "the streamed card", 60_000);
ok(!!card, "it answered with a streamed card (假模型逐字出)");

say("\n▶ 2/3 「sbot 测试」群里有一张审批卡：点「批准」，连点两下。卡片没变就再点（点击也会被分给旧核心，旧核心认不出这张卡、什么都不做）。");
const id = submitApproval(hub!.db, { kind: "send", title: "发到 sbot 测试", draft: "【sbot 测试】你在飞书里批了这条，测试 hub 以机器人身份发到这里。", requester: "live-test",
  channel: "feishu", target: { chat: TEST }, as_identity: "bot" });
await until(() => q<{ s: string }>("SELECT status AS s FROM approvals WHERE id = ?", id)[0]?.s === "approved", "approved from Feishu", 300_000);
const decidedBy = q<{ b: string }>("SELECT decided_by AS b FROM approvals WHERE id = ?", id)[0]?.b ?? "";
ok(decidedBy === "feishu", "approved by my click in Feishu");
await sleep(5000);
const rows = out().filter((r) => r.approval_id === id && r.kind === "text");
ok(rows.length === 1 && rows[0]!.status === "sent" && (await getMsg(rows[0]!.msg_id!))?.chat_id === TEST, "one send, real, in the test chat — however many clicks landed");
say(`  clicks that reached the test hub: ${clicks.filter((c) => c.kind === "card").length}, handler ms max ${Math.max(0, ...clicks.filter((c) => c.kind === "card").map((c) => c.ms))}, all with operator: ${clicks.every((c) => c.op)}`);
say(`  card click rows in the inbox: ${q("SELECT 1 FROM inbox WHERE source = 'feishu:card'").length}`);

say("\n▶ 3/3 测试 hub 现在断开长连接 40 秒：这期间在私聊里给机器人发 2 条消息（写「补1」「补2」）。");
await f.stop();
windows.push(`${iso(openedAt)} → ${iso()}`); openedAt = 0;
const cutAt = Date.now();
await sleep(40_000);
const n0 = lines.length;
await f.start(channelHost(hub!.db));
await until(() => lines.slice(n0).some((l) => l.includes("catch-up done")), "catch-up after reconnect", 60_000);
openedAt = Date.now();
const back = q<{ n: number }>("SELECT count(*) AS n FROM messages WHERE surface = 'feishu:dm' AND sender_kind = 'owner' AND json_extract(raw_json, '$.via') = 'catchup' AND ts >= ?", cutAt)[0]!.n;
ok(back >= 2, `catch-up brought back ${back} DM(s) sent while disconnected`);
say("\n完了。还剩「别人点被拒」要第二个人（见点击清单）。");
}

try { await (phase === "auto" ? auto() : session()); await finish(0); }
catch (e) { if (!(e instanceof Stop)) say(`error: ${String((e as Error)?.message ?? e).slice(0, 300)}`); await finish(1); }
