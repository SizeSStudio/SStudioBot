// W1 acceptance smoke (09 「W1」 验收) on a fresh home: hub/test/test-home.sh hub/test/smoke-w1.ts <port>.
// Feishu in shadow mode with dummy credentials, a fake lark-cli (a shell script in the home that answers the
// observer from files this script writes), a fake LLM upstream in this process, a real local node. Walks:
//   my DM → a run in the typed column → the reply through the plugin (shadow: no card, logged) · the self/ guard on
//   a timer and a system run, source labels in the prompt · the proxy's 401 / 403 / alert-only · a group @me → triage
//   → draft run → commitment check → send approval as me → approved → outbox (shadow) · my own reply voids the other
//   card · check's three outcomes on real jobs · kill -9 mid-run and restart · the nightly backup job → sbot restore.
// Fictional data only. Prints names and counts; exits non-zero on the first failure.
import { spawn, type ChildProcess } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { generateX25519Identity, identityToRecipient } from "age-encryption";
import { fakeLlm, fakeModelsYaml, FAKE_KEY, type Step } from "./fake-llm.ts";

// before the hub's modules load: the observer reads its poll interval once
process.env.SBOT_OBSERVE_S = "1";
const { home } = await import("../src/home.ts");
const { boot } = await import("../src/main.ts");
const { ingest } = await import("../src/inbox.ts");
const { issueToken } = await import("../src/proxy.ts");
const { decide } = await import("../src/approvals.ts");
const { channel } = await import("../src/channels/registry.ts");
const { localStamp } = await import("../src/time.ts");
const { setQuiet } = await import("../src/log.ts");
type FeishuChannel = import("../src/channels/feishu/plugin.ts").FeishuChannel;
type Home = import("../src/home.ts").Home;

setQuiet(true);
let step = 0;
function ok(cond: unknown, what: string): asserts cond {
  step++;
  if (!cond) { console.log(`✗ ${step}. ${what}`); process.exit(1); }
  console.log(`✓ ${step}. ${what}`);
}
const until = async (cond: () => boolean, what: string, ms = 30_000) => {
  const end = Date.now() + ms;
  while (!cond()) { if (Date.now() > end) ok(false, `timed out: ${what}`); await new Promise((r) => setTimeout(r, 100)); }
};
const HERE = dirname(fileURLToPath(import.meta.url));
const OWNER = "ou_smkowner00001", OTHER = "ou_smkother00002", ADMIN = "oc_smkadmin00001", DM = "oc_smkdm000000001";
const GA = "oc_smkgroupa0001", GB = "oc_smkgroupb0001";
const DRAFT = "好的，明天下午给报价。";

// ── the fake upstream: answers by what kind of call it is ──
const sys = (b: any) => JSON.stringify(b.system ?? "");
const lastUser = (b: any): string => JSON.stringify((b.messages ?? []).filter((m: { role: string }) => m.role === "user").slice(-1));
let respond = (b: any): Step => {
  if (typeof b.system === "string" && b.system.startsWith("检查一条草稿")) return { text: '{"promise":false,"stance":false,"private":false,"hits":[]}' };
  if (sys(b).includes("消息分拣员")) return { text: '{"items":[{"i":0,"action":"draft","why":"问到我了"}],"events":[]}' };
  if (sys(b).includes("起草一条飞书群回复")) return { text: DRAFT };
  const u = lastUser(b);
  if (u.includes("tool_result")) return { text: "做完了。" };
  if (u.includes("早报")) return { tool: { name: "memory_read", input: { path: "self/smoke.md" } } };
  return { text: "在。" };
};
const llm = await fakeLlm((b) => respond(b));

// ── the home ──
const h = home();
ok(!existsSync(h.db), `fresh home ${h.root}`);
mkdirSync(h.config, { recursive: true });
const identity = await generateX25519Identity();
const idFile = join(h.root, "backup-identity.txt");
writeFileSync(idFile, `${identity}\n`, { mode: 0o600 });
const cfg: Record<string, string> = {
  "models.yaml": fakeModelsYaml(llm.port, "budgets: { run_output_tokens: 10 }"),
  "channels.yaml": `feishu:\n  mode: shadow\n  admin_chat: ${ADMIN}\n`,
  "people.yaml": `owner:\n  name: 小测\n  ids:\n    feishu: ${OWNER}\n`,
  "groups.yaml": "reviewed: true\n",
  "gate.yaml": "attention:\n  wait_minutes: 0\n  escalate_wait_minutes: 0\n",
  "backup.yaml": `recipient: ${await identityToRecipient(identity)}\n`,
};
for (const [f, t] of Object.entries(cfg)) writeFileSync(join(h.config, f), t);
appendFileSync(h.secrets, `FAKE_KEY=${FAKE_KEY}\nFEISHU_APP_ID=cli_smokefake0001\nFEISHU_APP_SECRET=smoke-fake-secret-000000\n`, { mode: 0o600 });

// a fake lark-cli: the observer's user identity, reading what this script writes into lark/
const LD = join(h.root, "fake-lark");
mkdirSync(LD, { recursive: true });
writeFileSync(join(LD, "auth.json"), JSON.stringify({ identities: { user: { status: "ready" } } }));
writeFileSync(join(LD, "chats.json"), JSON.stringify({ data: { chats: [{ chat_id: GA, name: "甲组" }, { chat_id: GB, name: "乙组" }] } }));
let search: any[] = [];
const setSearch = () => writeFileSync(join(LD, "search.json"), JSON.stringify({ data: { messages: search } }));
setSearch();
writeFileSync(join(LD, "lark-cli"), `#!/bin/sh
D='${LD}'
case "$1 $2" in
  "auth status") cat "$D/auth.json" ;;
  "im +messages-search") cat "$D/search.json" ;;
  "im +chat-list") cat "$D/chats.json" ;;
  "im messages") echo '{"data":{"items":[]}}' ;;
  *) echo "$1 $2" >> "$D/other.log"; echo '{"data":{}}' ;;
esac
`, { mode: 0o755 });
process.env.SBOT_LARK_CLI = join(LD, "lark-cli");

const hub = await boot(h);
const db = hub.db;
const port = (hub.proxy.address() as { port: number }).port;
ok(port === Number(process.env.SBOT_PORT), `proxy on the smoke port ${port}`);
const f = channel("feishu") as FeishuChannel | undefined;
ok(f?.state() === "shadow", "feishu plugin up in shadow mode with dummy credentials");
mkdirSync(join(h.agentHome, "self"), { recursive: true });
writeFileSync(join(h.agentHome, "self", "smoke.md"), "虚构：只在冒烟测试里存在。\n");

const work = join(h.root, "work");
mkdirSync(work, { recursive: true });
const node: ChildProcess = spawn(process.execPath, [join(HERE, "..", "..", "node", "src", "main.ts")], { env: { ...process.env, SBOT_LOG: "off", SBOT_NODE_CWD: work }, stdio: "ignore" });
await hub.node.waitConnected(15_000);
ok(hub.node.connected(), "local node connected over hub.sock");

// ── 1 my DM ──
const outRows = () => db.all<{ id: number; kind: string; channel: string; as_identity: string; approval_id: number | null; payload: string; status: string; t: string; lane: string | null }>(
  "SELECT id, kind, channel, as_identity, approval_id, payload, status, target_json AS t, lane FROM outbox ORDER BY id");
f!.onMessage({ kind: "message", eventId: "", messageId: "om_smkdm0001", chatId: DM, chatType: "p2p", operatorId: OWNER, senderType: "user",
  messageType: "text", content: JSON.stringify({ text: "你在吗" }), createTime: Date.now() }, "event");
await until(() => outRows().some((r) => r.payload === "在。" && r.status === "sent"), "DM reply");
const dmReply = outRows().find((r) => r.payload === "在。")!;
ok(dmReply.channel === "feishu" && JSON.parse(dmReply.t).chat === DM && JSON.parse(dmReply.t).msg_id === "om_smkdm0001", "my DM: a run, the reply to my message through the Feishu plugin (shadow: logged, not sent)");
ok(!outRows().some((r) => r.kind === "card" && r.lane === "feishu:dm"), "shadow: no streaming card, the plain reply instead (the card path: w1-accept.test.ts (d))");
ok(llm.seen.some((s) => sys(s.body).includes("来源：owner@feishu:dm")), "source label owner@feishu:dm in the run's prompt");

// ── 2 the self/ guard on scheduled and system runs, their labels ──
ingest(db, { lane: "job:smoke", kind: "timer", source: "timer", source_msg_id: "smoke-timer-1", payload: { text: "早报", job: "smoke" } });
ingest(db, { lane: "sys:smoke", kind: "system", source: "smoke", source_msg_id: "smoke-system-1", payload: { text: "早报" } });
await until(() => db.all("SELECT 1 FROM runs WHERE lane IN ('job:smoke', 'sys:smoke') AND status != 'running'").length === 2, "timer and system runs");
const selfItems = db.all<{ status: string; body_json: string; lane: string }>("SELECT status, body_json, lane FROM run_items WHERE name = 'memory_read' AND lane IN ('job:smoke', 'sys:smoke')");
ok(selfItems.length === 2 && selfItems.every((i) => i.status === "error" && i.body_json.includes("self_list")), "a timer run and a system run can't read self/ whole (R1)");
ok(llm.seen.some((s) => sys(s.body).includes("来源：job@smoke")) && llm.seen.some((s) => sys(s.body).includes("来源：system@system")), "labels job@smoke and system@system by ownerTyped");

// ── 3 the proxy ──
const base = `http://127.0.0.1:${port}/llm/v1/messages`;
const ask = (key: string, model: string) => fetch(base, { method: "POST", headers: { "x-api-key": key, "content-type": "application/json" }, body: JSON.stringify({ model, max_tokens: 8, stream: true, messages: [{ role: "user", content: "x" }] }) });
ok((await ask("run_madeup", "sbot-chat")).status === 401, "proxy: bad token → 401");
db.run("INSERT INTO runs(id, lane, role, tier, status, started) VALUES ('r_smoke_px', 'smoke:px', 'main', 'chat', 'running', ?)", Date.now());
const tok = issueToken(db, { run_id: "r_smoke_px", tier: "chat" });
ok((await ask(tok, "sbot-expert")).status === 403, "proxy: another tier → 403");
const r1 = await ask(tok, "sbot-chat"); await r1.text();
const r2 = await ask(tok, "sbot-chat"); await r2.text();
ok(r1.status === 200 && r2.status === 200, "proxy: over the run's output line, still answered");
await until(() => !!db.one("SELECT 1 FROM outbox WHERE lane = 'outlet:admin' AND payload LIKE '%r_smoke_px%单 run 告警线%'"), "budget alert");
ok(true, "proxy: the alert went to the admin outlet");

// ── 4 a group @me → draft → approval → approved; my own reply voids the other ──
const gmsg = (id: string, chat: string, name: string, sender: string, text: string, ts: number, at: boolean) => ({
  message_id: id, chat_id: chat, chat_type: "group", chat_name: name, msg_type: "text", content: text, create_time: ts,
  sender: { id: sender, name: sender === OWNER ? "小测" : "阿乙", sender_type: "user" }, mentions: at ? [{ id: OWNER, name: "小测" }] : [] });
const t0 = Date.now() - 30_000;
search = [gmsg("om_smkga0001", GA, "甲组", OTHER, "@小测 报价什么时候能给？", t0, true), gmsg("om_smkgb0001", GB, "乙组", OTHER, "@小测 周会改到几点？", t0 + 1000, true)];
setSearch();
await until(() => db.all("SELECT 1 FROM messages WHERE id IN ('om_smkga0001', 'om_smkgb0001')").length === 2, "observer recorded the two group messages", 15_000);
ok(true, "observer (fake lark-cli) recorded two group messages that @ me");
type Ap = { id: number; status: string; as_identity: string; trigger_chat: string; draft: string; run_id: string };
const sends = () => db.all<Ap>("SELECT id, status, as_identity, trigger_chat, draft, run_id FROM approvals WHERE kind = 'send' ORDER BY id");
await until(() => sends().length === 2, "two drafts filed (triage ticks every 45 s)", 150_000);
ok(sends().every((a) => a.status === "pending" && a.as_identity === "user" && a.draft === DRAFT), "triage → draft → a pending send approval as me, one per group");
const draftRuns = db.all<{ id: string; lane: string; status: string; input_ref: string | null }>("SELECT id, lane, status, input_ref FROM runs WHERE role = 'draft'");
ok(draftRuns.length === 2 && draftRuns.every((r) => r.status === "done" && /^draft:oc_/.test(r.lane) && r.input_ref) && sends().every((a) => draftRuns.some((r) => r.id === a.run_id)),
  "each draft is a W1d run (role draft, lane draft:<chat>, input snapshot kept)");
const draftReqs = llm.seen.filter((s) => sys(s.body).includes("起草一条飞书群回复"));
const offered = new Set(draftReqs.flatMap((s) => (s.body.tools ?? []).map((t: { name: string }) => t.name)));
ok(draftReqs.length >= 2 && !["reply", "send", "bash", "write_file"].some((n) => offered.has(n)), `draft runs offered read-only tools only (${[...offered].join(",") || "none"})`);
const sees = (a: string, b: string) => draftReqs.some((s) => lastUser(s.body).includes(a) && !lastUser(s.body).includes(b));
ok(sees("报价", "周会") && sees("周会", "报价"), "a draft sees only its own chat");
ok(llm.seen.filter((s) => typeof s.body.system === "string" && s.body.system.startsWith("检查一条草稿")).length >= 2, "W1d's commitment check read each draft");
const toGroups = () => outRows().filter((r) => [GA, GB].includes(JSON.parse(r.t).chat ?? JSON.parse(r.t).chat_id));
ok(toGroups().length === 0, "nothing addressed to either group before I decide");

search = [...search, gmsg("om_smkgb0002", GB, "乙组", OWNER, "三点", Date.now(), false)];
setSearch();
const apA = sends().find((a) => a.trigger_chat === GA)!, apB = sends().find((a) => a.trigger_chat === GB)!;
await until(() => db.one<{ s: string }>("SELECT status AS s FROM approvals WHERE id = ?", apB.id)!.s === "invalidated", "my own reply voids B's card", 15_000);
ok(true, "I wrote in group B myself: its card is void");

const d = decide(db, apA.id, { decision: "approve", by: { kind: "device", device_id: "cli" } });
ok(d.ok && !!d.outbox_id, "approved A: one outbox row");
await until(() => db.one<{ s: string }>("SELECT status AS s FROM outbox WHERE id = ?", d.ok ? d.outbox_id! : 0)!.s !== "queued", "settled");
const asMe = outRows().filter((r) => r.as_identity === "user");
ok(asMe.length === 1 && asMe[0]!.approval_id === apA.id && asMe[0]!.payload === DRAFT && asMe[0]!.status === "sent" && JSON.parse(asMe[0]!.t).message_id === "om_smkga0001",
  "outbox: exactly the approved text, as me, replying to A's message (shadow: logged, not sent)");
ok(!existsSync(join(LD, "other.log")), "nothing went to lark-cli as me in shadow mode");

// ── 5 check's three outcomes and the nightly backup, as real jobs a couple of minutes from now ──
// the scheduler reads jobs.yaml on its 30 s tick: the minute has to start after that sync, or it means tomorrow
const at = localStamp(Date.now() + 120_000).slice(11, 16);
writeFileSync(join(h.config, "jobs.yaml"), [
  `c_skip: { every: day, at: "${at}", do: event, text: 定时检查, check: "true" }`,
  `c_run: { every: day, at: "${at}", do: event, text: 定时检查, check: "echo work" }`,
  `c_broken: { every: day, at: "${at}", do: event, text: 定时检查, check: "echo bad >&2; exit 5" }`,
  `backup: { every: day, at: "${at}", do: backup }`,
].join("\n") + "\n");
const last = (j: string) => { const v = db.kvGet(`job.${j}.last`); return v ? JSON.parse(v) as { outcome: string } : undefined; };
const jobRow = (j: string) => db.all<{ p: string }>("SELECT payload_json AS p FROM inbox WHERE source = 'job' AND source_msg_id LIKE ?", `${j}:%`).map((r) => JSON.parse(r.p));
await until(() => last("c_skip")?.outcome === "skipped_by_check" && jobRow("c_run").length === 1 && jobRow("c_broken").length === 1, "check jobs fired", 240_000);
ok(jobRow("c_skip").length === 0, "check: exit 0, no output → skipped, no run");
ok(jobRow("c_run")[0].check?.out?.trim() === "work", "check: exit 0 with output → the output goes into the run");
ok(jobRow("c_broken")[0].check?.broken === true && jobRow("c_broken")[0].check?.code === 5 && !!db.one("SELECT 1 FROM outbox WHERE lane = 'outlet:admin' AND payload LIKE '%c_broken%退出码 5%'"),
  "check: exit 5 → runs anyway with the code, one ops alert");
const backups = () => existsSync(h.staging) ? readdirSync(h.staging).filter((n) => /^sbot-\d{4}-\d{2}-\d{2}\.tar\.age$/.test(n)) : [];
await until(() => backups().length === 1 && last("backup")?.outcome === "done", "nightly backup job", 60_000);
ok(true, `the backup job wrote ${backups()[0]}`);

// ── 6 kill -9 mid-run in a second home, then restart ──
const kdir = join(h.root, "killhome");
const k: Home = { ...home(kdir), secrets: join(kdir, "secrets.env") };
mkdirSync(k.config, { recursive: true });
writeFileSync(join(k.config, "models.yaml"), fakeModelsYaml(llm.port));
writeFileSync(join(k.config, "channels.yaml"), "feishu:\n  mode: shadow\n");
writeFileSync(k.secrets, `FAKE_KEY=${FAKE_KEY}\n`, { mode: 0o600 });
let killStage = 0;
respond = (b) => {
  const u = lastUser(b);
  if (killStage === 0 && !u.includes("tool_result")) return { tool: { name: "reply", input: { text: "先说一句" } } };
  if (killStage === 0) return { hang: true };
  return { text: "不该出现" };
};
const startK = (msg?: string) => new Promise<ChildProcess>((res, rej) => {
  const c = spawn(process.execPath, [join(HERE, "kill-child.ts")], { env: { ...process.env, SBOT_HOME: k.root, SBOT_SECRETS: k.secrets, KILL_INGEST: msg ?? "" }, stdio: ["ignore", "pipe", "ignore"] });
  c.stdout!.on("data", (b: Buffer) => { if (b.toString().includes("up")) res(c); });
  c.on("exit", (code) => rej(new Error(`kill child exited ${code}`)));
});
const kq = <T>(sql: string): T[] => { const x = new DatabaseSync(k.db, { readOnly: true }); try { return x.prepare(sql).all() as T[]; } finally { x.close(); } };
const seenBefore = llm.seen.length;
let kc = await startK("kill-1");
await until(() => llm.seen.length >= seenBefore + 2 && kq<{ s: string }>("SELECT status AS s FROM outbox WHERE kind = 'text'").some((r) => r.s === "sent"), "kill home: reply out, request hanging");
await new Promise<void>((r) => { kc.once("exit", () => r()); kc.kill("SIGKILL"); });
killStage = 1;
kc = await startK();
await until(() => kq<{ p: string }>("SELECT payload AS p FROM outbox WHERE kind = 'text' AND status = 'sent'").some((r) => r.p.startsWith("我刚才被重启了")), "restart notice");
await new Promise((r) => setTimeout(r, 1500));
const kout = kq<{ p: string }>("SELECT payload AS p FROM outbox WHERE kind = 'text'").map((r) => r.p);
ok(kq<{ s: string }>("SELECT status AS s FROM inbox WHERE source_msg_id = 'kill-1'")[0]?.s === "interrupted", "after kill -9: the input with a side effect is interrupted, not lost");
ok(kout.filter((p) => p === "先说一句").length === 1 && !kout.includes("不该出现"), "nothing sent twice, not rerun");
ok(kout.some((p) => p.includes("已经发出 1 条消息")), "I'm told how many went out");
await new Promise<void>((r) => { kc.once("exit", () => r()); kc.kill("SIGTERM"); });

// ── 7 sbot restore brings the backup back into an empty home ──
const sendsAtBackup = sends().length;
node.kill("SIGTERM");
await hub.close();
const rdir = join(h.root, "restored");
const code = await new Promise<number | null>((res) => {
  const c = spawn(process.execPath, [join(HERE, "..", "src", "cli.ts"), "restore", join(h.staging, backups()[0]!), "--identity", idFile],
    { env: { ...process.env, SBOT_HOME: rdir, SBOT_SECRETS: join(rdir, "secrets.env") }, stdio: "ignore" });
  c.on("exit", (n) => res(n));
});
ok(code === 0, "sbot restore exited 0");
const rq = <T>(sql: string): T[] => { const x = new DatabaseSync(join(rdir, "db", "sbot.db"), { readOnly: true }); try { return x.prepare(sql).all() as T[]; } finally { x.close(); } };
ok(rq<{ n: number }>("SELECT COUNT(*) AS n FROM approvals WHERE kind = 'send'")[0]!.n === sendsAtBackup && existsSync(join(rdir, "config", "people.yaml")) && existsSync(join(rdir, "secrets.env")),
  "the restored home has the db (both drafts' approvals), the config repo and secrets.env");

await llm.close();
console.log("smoke ok");
process.exit(0);
