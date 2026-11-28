// W1d smoke on a fresh home (run by hub/test/test-home.sh with this file; SBOT_HOME is that home, SBOT_PORT the
// smoke port, which the LLM proxy takes). A fake upstream runs in this process; nothing leaves the machine.
//   pi → proxy → fake upstream; a real local node (bash over hub.sock); the self/ guard on a timer run; the three
//   proxy cases; an approval; the commitment check on someone else's reply (held, fixed line out); check's three
//   outcomes; kill -9 mid-run in a second home and restart.
// Exits non-zero on the first failure. Prints names and counts only.
import { spawn, type ChildProcess } from "node:child_process";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { fakeLlm, fakeModelsYaml, FAKE_KEY, type Step } from "./fake-llm.ts";
import { home, type Home } from "../src/home.ts";
import { boot } from "../src/main.ts";
import { ingest } from "../src/inbox.ts";
import { issueToken } from "../src/proxy.ts";
import { decide } from "../src/approvals.ts";
import { runCheck } from "../src/check.ts";
import { setQuiet } from "../src/log.ts";

setQuiet(true);
let step = 0;
function ok(cond: unknown, what: string): asserts cond {
  step++;
  if (!cond) { console.log(`✗ ${step}. ${what}`); process.exit(1); }
  console.log(`✓ ${step}. ${what}`);
}
const until = async (cond: () => boolean, what: string, ms = 30_000) => {
  const end = Date.now() + ms;
  while (!cond()) { if (Date.now() > end) ok(false, `timed out: ${what}`); await new Promise((r) => setTimeout(r, 50)); }
};
const HERE = dirname(fileURLToPath(import.meta.url));

// the fake upstream answers by what the last user message asks for
const lastUser = (b: any): string => JSON.stringify((b.messages ?? []).filter((m: { role: string }) => m.role === "user").slice(-1));
let respond = (b: any): Step => {
  if (typeof b.system === "string" && b.system.startsWith("检查一条草稿")) return { text: '{"promise":true,"stance":false,"private":false,"hits":["虚构的承诺"]}' };
  const u = lastUser(b);
  if (u.includes("tool_result")) return { text: "做完了。" };
  if (u.includes("跑命令")) return { tool: { name: "bash", input: { cmd: "echo smoke-node-ok" } } };
  if (u.includes("早报")) return { tool: { name: "memory_read", input: { path: "self/smoke.md" } } };
  if (u.includes("发给")) return { tool: { name: "send", input: { channel: "feishu", to: "oc_smokefake", text: "虚构的通知" } } };
  return { text: "在。" };
};
const llm = await fakeLlm((b) => respond(b));

function prepare(h: Home, models: string) {
  mkdirSync(h.config, { recursive: true });
  writeFileSync(join(h.config, "models.yaml"), models);
  appendFileSync(h.secrets, `FAKE_KEY=${FAKE_KEY}\n`, { mode: 0o600 });
}

const h = home();
prepare(h, fakeModelsYaml(llm.port, "budgets: { run_output_tokens: 10 }"));
const hub = await boot(h);
const port = (hub.proxy.address() as { port: number }).port;
ok(port === Number(process.env.SBOT_PORT), `proxy on the smoke port ${port}`);
mkdirSync(join(h.agentHome, "self"), { recursive: true });
writeFileSync(join(h.agentHome, "self", "smoke.md"), "虚构：只在冒烟测试里存在。\n");

// test-home.sh runs with HOME = SBOT_HOME, and the node's default directory is its HOME — which the guard rightly
// refuses as a bash cwd. A real node account has its own home; here the node gets a work dir of its own.
const work = join(h.root, "work");
mkdirSync(work, { recursive: true });
const node: ChildProcess = spawn(process.execPath, [join(HERE, "..", "..", "node", "src", "main.ts")], { env: { ...process.env, SBOT_LOG: "off", SBOT_NODE_CWD: work }, stdio: "ignore" });
await hub.node.waitConnected(15_000);
ok(hub.node.connected(), "local node connected over hub.sock");

const sent = () => hub.db.all<{ payload: string }>("SELECT payload FROM outbox WHERE kind = 'text' AND status = 'sent' AND lane = 'client:main' ORDER BY id").map((r) => r.payload);
let n = 0;
const mine = (text: string) => ingest(hub.db, { lane: "client:main", kind: "user", source: "client", source_msg_id: `smoke-${++n}`, payload: { text }, turn: { channel: "client", surface: "client" }, device_id: "cli" });

mine("你在吗");
await until(() => sent().includes("在。"), "first reply");
ok(llm.seen[0]?.headers["x-api-key"] === FAKE_KEY && llm.seen[0]?.body.model === "claude-fake-chat", "pi → proxy → upstream with the real key and model");

mine("跑命令看看");
await until(() => sent().includes("做完了。"), "bash round");
const bash = hub.db.one<{ status: string; body_json: string }>("SELECT status, body_json FROM run_items WHERE name = 'bash'")!;
ok(bash.status === "done" && bash.body_json.includes("smoke-node-ok"), "bash ran on the local node");

ingest(hub.db, { lane: "job:smoke", kind: "timer", source: "timer", source_msg_id: "smoke-timer-1", payload: { text: "早报", job: "smoke" } });
await until(() => !!hub.db.one("SELECT 1 FROM runs WHERE lane = 'job:smoke' AND status != 'running'"), "timer run");
const selfItem = hub.db.one<{ status: string; body_json: string }>("SELECT status, body_json FROM run_items WHERE name = 'memory_read' AND lane = 'job:smoke'")!;
ok(selfItem.status === "error" && selfItem.body_json.includes("self_list"), "a timer run can't read self/ whole");
ok(hub.db.one<{ s: string }>("SELECT status AS s FROM runs WHERE lane = 'job:smoke'")!.s === "done", "the timer run still finished");

const base = `http://127.0.0.1:${port}/llm/v1/messages`;
const ask = (key: string, model: string) => fetch(base, { method: "POST", headers: { "x-api-key": key, "content-type": "application/json" }, body: JSON.stringify({ model, max_tokens: 8, stream: true, messages: [{ role: "user", content: "x" }] }) });
ok((await ask("run_madeup", "sbot-chat")).status === 401, "proxy: bad token → 401");
hub.db.run("INSERT INTO runs(id, lane, role, tier, status, started) VALUES ('r_smoke_px', 'smoke:px', 'main', 'chat', 'running', ?)", Date.now());
const tok = issueToken(hub.db, { run_id: "r_smoke_px", tier: "chat" });
ok((await ask(tok, "sbot-expert")).status === 403, "proxy: another tier → 403");
const r1 = await ask(tok, "sbot-chat"); await r1.text();
const r2 = await ask(tok, "sbot-chat"); await r2.text();
ok(r1.status === 200 && r2.status === 200, "proxy: over the run's output line, still answered");
await until(() => !!hub.db.one("SELECT 1 FROM outbox WHERE lane = 'outlet:admin' AND payload LIKE '%r_smoke_px%单 run 告警线%'"), "budget alert");
ok(hub.db.one<{ n: number }>("SELECT COUNT(*) AS n FROM outbox WHERE lane = 'outlet:admin' AND payload LIKE '%r_smoke_px%单 run 告警线%'")!.n === 1, "proxy: alerted once on the admin outlet");

mine("发给 oc_smokefake 一句");
await until(() => !!hub.db.one("SELECT 1 FROM approvals WHERE kind = 'send'"), "send approval");
const ap = hub.db.one<{ id: number; status: string }>("SELECT id, status FROM approvals WHERE kind = 'send'")!;
ok(ap.status === "pending" && !hub.db.one("SELECT 1 FROM outbox WHERE channel = 'feishu' AND kind = 'text'"), "send went to an approval, nothing sent");
const d = decide(hub.db, ap.id, { decision: "approve", by: { kind: "device", device_id: "cli" } });
ok(d.ok && !!d.outbox_id, "approved by me: one outbox row");
await until(() => hub.db.one<{ s: string }>("SELECT status AS s FROM outbox WHERE id = ?", d.ok ? d.outbox_id! : 0)!.s !== "queued", "settled");
ok(hub.db.one<{ s: string }>("SELECT status AS s FROM outbox WHERE id = ?", d.ok ? d.outbox_id! : 0)!.s === "unrouted", "no feishu plugin yet (W1e): unrouted, not lost");

ingest(hub.db, { lane: "client:other", kind: "user", source: "smoke", source_msg_id: "smoke-other-1", payload: { text: "周五能来吗", sender_name: "虚构的人" }, turn: { channel: "client", surface: "smoke:dm", chat: "oc_smokeother" } });
await until(() => !!hub.db.one("SELECT 1 FROM approvals WHERE kind = 'send' AND context_json LIKE '%\"hold\":true%'"), "held reply");
const holdSent = () => hub.db.all<{ p: string; t: string }>("SELECT payload AS p, target_json AS t FROM outbox WHERE kind = 'text'").filter((r) => JSON.parse(r.t).chat === "oc_smokeother").map((r) => r.p);
await until(() => holdSent().length > 0, "holding line");
ok(holdSent().length === 1 && holdSent()[0] !== "在。" && !!hub.db.one("SELECT 1 FROM usage WHERE tier = 'light'"), "someone else's reply: light check hit → approval, only the fixed line went out");

const cwd = h.root;
const c1 = await runCheck(hub.node, { job: "smoke", cmd: "true", cwd, sbotHome: h.root });
const c2 = await runCheck(hub.node, { job: "smoke", cmd: "echo work", cwd, sbotHome: h.root });
const c3 = await runCheck(hub.node, { job: "smoke", cmd: "echo bad >&2; exit 5", cwd, sbotHome: h.root });
ok(c1.kind === "skip" && c2.kind === "run" && c3.kind === "broken" && (c3 as { code: number }).code === 5, "check: skip / run / broken");

// kill -9 mid-run in a second home inside this one, then restart it
const k = home(join(h.root, "killhome"));
prepare(k, fakeModelsYaml(llm.port));
writeFileSync(join(k.config, "channels.yaml"), "feishu:\n  mode: shadow\n");
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
const kq = <T>(sql: string): T[] => { const db = new DatabaseSync(k.db, { readOnly: true }); try { return db.prepare(sql).all() as T[]; } finally { db.close(); } };
const seenBefore = llm.seen.length;
let kc = await startK("kill-1");
await until(() => llm.seen.length === seenBefore + 2 && kq<{ s: string }>("SELECT status AS s FROM outbox WHERE kind = 'text'").some((r) => r.s === "sent"), "kill home: reply out, request hanging");
await new Promise<void>((r) => { kc.once("exit", () => r()); kc.kill("SIGKILL"); });
killStage = 1;
kc = await startK();
await until(() => kq<{ p: string }>("SELECT payload AS p FROM outbox WHERE kind = 'text' AND status = 'sent'").some((r) => r.p.startsWith("我刚才被重启了")), "restart notice");
await new Promise((r) => setTimeout(r, 1500));
const kout = kq<{ p: string }>("SELECT payload AS p FROM outbox WHERE kind = 'text'").map((r) => r.p);
ok(kout.filter((p) => p === "先说一句").length === 1 && !kout.includes("不该出现"), "after kill -9: nothing sent twice, not rerun");
ok(kout.some((p) => p.includes("已经发出 1 条消息")), "I'm told how many went out");
await new Promise<void>((r) => { kc.once("exit", () => r()); kc.kill("SIGTERM"); });

node.kill("SIGTERM");
await hub.close();
await llm.close();
console.log("smoke ok");
process.exit(0);
