// W4a smoke (09 「W4」 hub side) on a fresh home: hub/test/test-home.sh hub/test/smoke-w4a.ts <port>.
// The relay as its own process on 127.0.0.1:<port> behind a WS tap (ws-tap.ts), the hub booted with relay on, a node
// device paired through the relay that answers the hub's requests like node/ will (fake-device.ts onReq; protocol/
// only), and a client device on the stream. Walks:
//   node hello (registry, tools without bash) · node → /api/v1 403, client → /node/v1 403, sbot MCP off by default ·
//   a task to that node → SessionOpen → steps, deltas and a diff stream live to the client · permission → 看一眼 card
//   → my decision → PermissionAnswer on the node (a reject reaches it as a reject) · the node dies → waiting_node →
//   reconnects without the session → 「需要你处理」 → my message resumes it with resume_ref · quota → timer → resume ·
//   CI red ×3 → three wake-ups, a notice on the third · usage source node · the relay saw no plaintext.
// Loopback only; fictional data; nothing installed. Prints steps; exits non-zero on the first failure.
import { spawn, type ChildProcess } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DeviceKey, auth, pair, settle, type Channel } from "./fake-device.ts";
import { startTap } from "./ws-tap.ts";
import { useCrypto } from "../../protocol/noise/crypto.ts";
import { nodeAead, nodeDh } from "../../protocol/noise/node-crypto.ts";
import { DATA, OPEN, decodeEnvelope } from "../../protocol/envelope.ts";
import { decodePairCode } from "../../protocol/pair.ts";
import { PROTOCOL } from "../../protocol/version.ts";
import { InviteRes } from "../../protocol/api/devices.ts";
import { home } from "../src/home.ts";
import { boot } from "../src/main.ts";
import { adminRequest } from "../src/admin-socket.ts";
import { setAdminSink } from "../src/notify.ts";
import { setQuiet } from "../src/log.ts";
import { decide } from "../src/approvals.ts";
import { Scheduler } from "../src/timers/schedule.ts";
import { loadOrCreateHubKey } from "../src/link/keys.ts";

let step = 0;
function ok(cond: unknown, what: string): asserts cond {
  step++;
  if (!cond) { console.log(`✗ ${step}. ${what}`); process.exit(1); }
  console.log(`✓ ${step}. ${what}`);
}
const until = async (cond: () => boolean, ms: number, what: string) => {
  const end = Date.now() + ms;
  while (!cond()) { if (Date.now() > end) ok(false, `timed out: ${what}`); await new Promise((r) => setTimeout(r, 20)); }
};

setQuiet(true);
useCrypto({ aead: nodeAead, dh: nodeDh });
const PORT = Number(process.env.SBOT_PORT ?? 7830);
const SECRET = "smkw4a-fictional-token-7f3e9a21c4";
const GOAL = "把示例仓库 README 的第二段改通顺";
const SAY = "第二段改成了三句短句，意思没变。";

// ── the home, the relay, the hub ──
const h = home();
ok(!existsSync(h.db), `fresh home ${h.root}`);
mkdirSync(h.config, { recursive: true });
const hubKey = loadOrCreateHubKey(h.keys);
const token = randomBytes(24).toString("base64url");
const relayConf = join(h.root, "relay.yaml");
writeFileSync(relayConf, [
  `listen: { host: 127.0.0.1, port: ${PORT} }`,
  "hubs:",
  `  - { hub_pk: "${hubKey.publicB64u}", token_hash: "${createHash("sha256").update(token).digest("hex")}" }`,
  "limits: { conn_per_min: 100000, auth_fail_max: 100000 }",
  "",
].join("\n"));
const relayLog: string[] = [];
const relay: ChildProcess = spawn(process.execPath, [join(import.meta.dirname, "../../relay/src/main.ts")], { env: { PATH: process.env.PATH ?? "", RELAY_CONFIG: relayConf }, stdio: ["ignore", "pipe", "pipe"] });
relay.stdout!.on("data", (d: Buffer) => relayLog.push(...d.toString().split("\n").filter(Boolean)));
relay.stderr!.on("data", (d: Buffer) => relayLog.push(`stderr: ${d.toString()}`));
await until(() => relayLog.some((l) => l.includes('"ev":"listening"')), 10_000, "relay listening");
const tap = await startTap(() => PORT);
writeFileSync(join(h.config, "console.yaml"), `relay:\n  enabled: true\n  url: ws://127.0.0.1:${tap.port}/v1/hub\n`);
writeFileSync(join(h.config, "people.yaml"), "owner:\n  name: 小测\n  ids:\n    github: smkw4a-owner\n");
writeFileSync(h.secrets, `RELAY_TOKEN=${token}\nDEMO_TOKEN=${SECRET}\n`, { mode: 0o600 });
const hub = await boot(h, { proxyPort: 0 });
const db = hub.db;
const notices: string[] = [];
setAdminSink((t) => { notices.push(t); });
await until(() => hub.link.relay?.connected === true, 10_000, "hub registered");
ok(true, `relay on 127.0.0.1:${PORT}, hub registered through the tap`);
const peer = `ws://127.0.0.1:${tap.port}/v1/peer`;
const code = async (role: "client" | "node") => decodePairCode(InviteRes.parse((await adminRequest(h.run, "POST", "/api/v1/devices/invites", { role })).body).link);
const task = (id: string) => db.one<Record<string, any>>("SELECT * FROM tasks WHERE id = ?", id)!;

// ── 1 a client on the stream, a node paired through the relay ──
const ck = new DeviceKey();
const cp = await pair(await code("client"), ck, "冒烟手机");
ok((await settle(cp)) === "open", "client paired through the relay");
cp.close(); await cp.closed;
const cl = await auth(peer, hubKey.publicB64u, ck);
ok((await settle(cl)) === "open", "client reconnected");
const b0 = await cl.req("POST", "/api/v1/bootstrap", {});
ok((await cl.req("POST", "/api/v1/stream", { after: b0.body.seq })).status === 200, "client stream open");

const nk = new DeviceKey();
const NODE = nk.id;
type Got = { method: string; path: string; body: any };
const got: Got[] = [];
let checks: unknown = { state: "open", ci: "pending", head_sha: "h0", checks: [] };
let sessions: unknown[] = [];
const answer = (f: Got): { status: number; body?: unknown } => {
  if (f.method === "POST" && f.path === "/node/v1/sessions") return { status: 200, body: { session_ref: f.body.resume_ref ?? `sess-${f.body.task_id}-${f.body.attempt}`, workdir: f.body.cwd } };
  if (/\/turns$/.test(f.path) || /\/interrupt$/.test(f.path)) return { status: 200, body: {} };
  if (/\/steer$/.test(f.path)) return { status: 200, body: { applied: true } };
  if (/^\/node\/v1\/permissions\//.test(f.path)) return { status: 200, body: { ok: true } };
  if (f.path === "/node/v1/git/checks") return { status: 200, body: checks };
  if (f.method === "DELETE") return { status: 200, body: { released: true } };
  return { status: 404, body: { error: "fake node: no route" } };
};
const asNode = (c: Channel) => { c.onReq = (f) => { const g = { method: f.method, path: f.path, body: f.body as any }; got.push(g); return answer(g); }; return c; };
const np = await pair(await code("node"), nk, "冒烟节点");
ok((await settle(np)) === "open", "node paired through the relay (role node)");
np.close(); await np.closed;
const helloBody = () => ({
  version: PROTOCOL.current, sha: "smkw4anodesha", os: "linux", agents: [{ kind: "claude", version: "0.0.1" }],
  capabilities: { claude: { steer: true, resume: true, permissions: true, ask: true } }, quotas: {}, cwd: "/home/demo",
  app_version: "0.4.0", sessions,
});
let nd = asNode(await auth(peer, hubKey.publicB64u, nk, "node"));
const hr = await nd.req("POST", "/node/v1/hello", helloBody());
const tools = (hr.body?.tools ?? []).map((t: { name: string }) => t.name) as string[];
ok(hr.status === 200 && hr.body.accepts_work === true && hr.body.owner_git?.[0] === "github:smkw4a-owner", "node hello: registered, accepts work, my git login back");
ok(tools.includes("submit_report") && tools.includes("send") && !tools.includes("bash"), `…tools: the system column + submit_report, ask (${tools.length}), no bash`);
ok(hub.nodes.online(NODE) && db.one<{ status: string }>("SELECT status FROM nodes WHERE device_id = ?", NODE)?.status === "online", "…nodes row online");

// ── 2 the walls ──
const walls = await Promise.all([nd.req("GET", "/api/v1/tasks"), nd.req("POST", "/api/v1/approvals/1/decide", { decision: "approve" }), nd.req("POST", "/api/v1/bootstrap", {}), nd.req("POST", "/node/v1/../api/v1/tasks", {})]);
ok(walls.every((r) => r.status === 403), `node → /api/v1: ${walls.map((r) => r.status).join(" ")}`);
ok((await cl.req("POST", "/node/v1/hello", helloBody())).status === 403, "client → /node/v1: 403");
ok((await nd.req("POST", "/node/v1/tool-calls", { tool_call_id: "adhoc1", name: "memory_read", args: {} })).status === 403, "sbot MCP ad hoc call: 403 (mcp_open off by default)");
ok((await nd.req("POST", "/node/v1/sessions", {})).status === 404, "a node can't ask the hub for the hub → node routes (404)");

// ── 3 a task: session, live steps, diff ──
let opN = 0;
const op = () => `smkw4a-op-${++opN}-${randomBytes(4).toString("hex")}`;
const startOp = op();
const st = await cl.req("POST", "/api/v1/tasks", { goal: GOAL, node: NODE, repo: "/home/demo/repo" }, { client_op_id: startOp });
const id = (st.body as any)?.task?.id as string;
ok(st.status === 200 && !!id, `task ${id} from the client over the relay (W3a write layer)`);
const again = await cl.req("POST", "/api/v1/tasks", { goal: GOAL, node: NODE, repo: "/home/demo/repo" }, { client_op_id: startOp });
ok(again.status === 200 && again.body?.task?.id === id && db.all("SELECT id FROM tasks").length === 1, "…the same client_op_id again: the stored answer, no second task");
ok((await cl.req("POST", "/api/v1/tasks", { goal: "别的事" }, { client_op_id: startOp })).status === 409, "…that id with another body: 409");
await until(() => got.some((g) => g.path === "/node/v1/sessions"), 5000, "SessionOpen");
const open = got.find((g) => g.path === "/node/v1/sessions")!.body;
ok(open.attempt === 1 && open.prompt?.includes(GOAL) && open.cwd === "/home/demo/repo", "node got SessionOpen (attempt 1, the goal, the repo; tools = what hello gave)");
await until(() => task(id).status === "running", 3000, "running");
ok(db.one<{ cat: string }>("SELECT cat FROM push_queue WHERE ref = ?", `task:${id}:dispatched`)?.cat === "notice", "dispatched to a machine other than the hub's: one notice to me, not waited on (限1)");
let seq = 0;
const events = (attempt: number, es: unknown[]) => nd.req("POST", `/node/v1/tasks/${id}/events`, { attempt, from_seq: seq, events: es.map((e) => ({ seq: seq++, ts: Date.now(), e })) });
const mark = cl.frames.length;
const chars = [...SAY];
// typed like an agent does (the stream redactor batches within 80 ms, so faster pieces would arrive as one)
for (const c of chars) { await events(1, [{ k: "text", item: "m1", delta: c }]); await new Promise((r) => setTimeout(r, 120)); }
const ev1 = await events(1, [
  { k: "message", item: "m1", text: SAY },
  { k: "tool_start", item: "c1", name: "Edit", args: { file_path: "README.md" } },
  { k: "tool_end", item: "c1", ok: true, result: `ok ${SECRET}`, diff: "-旧的第二段\n+新的第二段" },
  { k: "diff", text: "diff --git a/README.md b/README.md\n--- a/README.md\n+++ b/README.md\n-旧的第二段\n+新的第二段\n" },
  { k: "usage", input_tokens: 321, output_tokens: 54, ms: 1200, model: "demo-model" },
]);
ok(ev1.status === 200, "events acked");
const fresh = () => cl.frames.slice(mark);
await until(() => fresh().some((f) => f.t === "ev" && f.entity === "item" && (f.data as any)?.kind === "tool" && (f.data as any)?.status === "done"), 5000, "tool item on the client");
const deltas = fresh().filter((f) => f.t === "delta");
ok(deltas.length >= chars.length / 2 && deltas.map((d) => (d as any).text).join("") === SAY, `the client got ${deltas.length} deltas live, joined = the message`);
ok(fresh().some((f) => f.t === "ev" && f.entity === "item" && (f.data as any)?.kind === "assistant"), "…and the assistant row");
ok(!JSON.stringify(fresh()).includes(SECRET), "…the token in the tool result is redacted before it reaches the client");
ok(/^blob:/.test(task(id).diff_ref ?? ""), "diff stored as a blob (diff_ref)");
const u = db.one<any>("SELECT * FROM usage WHERE task_id = ?", id);
ok(u?.source === "node" && u.device_id === NODE && u.input_tokens === 321, "usage recorded with source node");

// ── 4 permission → card → my decision → answer on the node ──
const opts = [{ id: "allow_once", label: "这次可以", kind: "allow_once" }, { id: "reject_once", label: "不行", kind: "reject_once" }];
const p1 = await nd.req("POST", "/node/v1/permissions", { task_id: id, attempt: 1, request_id: "perm-a", title: "要跑 rm -rf build", detail: { tool: "Bash", command: "rm -rf build" }, options: opts });
const a1 = p1.body?.approval_id as number;
ok(p1.status === 200 && a1 > 0 && task(id).status === "waiting", `permission → card #${a1}, task waiting`);
await until(() => fresh().some((f) => f.t === "ev" && f.entity === "approval" && String(f.id) === String(a1)), 5000, "card on the client");
ok(true, "…the card reached the client on the stream");
ok(!decide(db, a1, { decision: "approve", by: { kind: "device", device_id: NODE, role: "node" } as any, answer: { option_id: "allow_once" } }).ok, "a node can't decide it");
ok(decide(db, a1, { decision: "approve", by: { kind: "device", device_id: "cli" }, answer: { option_id: "allow_once" } }).ok, "I approve (allow_once)");
await until(() => got.some((g) => g.path === "/node/v1/permissions/perm-a"), 5000, "PermissionAnswer");
ok(got.find((g) => g.path === "/node/v1/permissions/perm-a")!.body.option_id === "allow_once", "…the node got PermissionAnswer allow_once");
const p2 = await nd.req("POST", "/node/v1/permissions", { task_id: id, attempt: 1, request_id: "perm-b", title: "写 /etc/hosts", detail: { path: "/etc/hosts" }, options: opts });
decide(db, p2.body.approval_id, { decision: "reject", by: { kind: "device", device_id: "cli" }, answer: { option_id: "allow_once" } });
await until(() => got.some((g) => g.path === "/node/v1/permissions/perm-b"), 5000, "reject answer");
ok(got.find((g) => g.path === "/node/v1/permissions/perm-b")!.body.option_id === "reject_once", "a rejected card with allow clicked reaches the node as reject_once");
await events(1, [{ k: "turn_end", stop: "done" }]);
await until(() => task(id).status === "done", 3000, "done");

// ── 5 the node dies mid-turn → needs me → my message resumes the session ──
await cl.req("POST", `/api/v1/tasks/${id}/steer`, { text: "再把第三段也看一下" }, { client_op_id: op() });
await until(() => got.filter((g) => /\/turns$/.test(g.path)).length === 1 && task(id).status === "running", 5000, "turn 2");
ok(true, "my message → turn 2 on the node");
nd.ws.terminate(); await nd.closed;
await until(() => task(id).status === "waiting_node", 5000, "waiting_node");
ok(true, "node connection cut → waiting_node");
sessions = [];
nd = asNode(await auth(peer, hubKey.publicB64u, nk, "node"));
ok((await nd.req("POST", "/node/v1/hello", helloBody())).status === 200, "node back, its hello holds no session (process restarted)");
await until(() => task(id).status === "interrupted", 3000, "interrupted");
const tv = await cl.req("GET", `/api/v1/tasks/${id}`);
ok(tv.body?.task?.needs_you === true || tv.body?.needs_you === true, "task interrupted, 「需要你处理」 on the client");
const opens0 = got.filter((g) => g.path === "/node/v1/sessions").length;
await cl.req("POST", `/api/v1/tasks/${id}/steer`, { text: "继续" }, { client_op_id: op() });
await until(() => got.filter((g) => g.path === "/node/v1/sessions").length === opens0 + 1, 5000, "resume open");
const re = got.filter((g) => g.path === "/node/v1/sessions").at(-1)!.body;
ok(re.resume_ref === `sess-${id}-1` && re.attempt === 2 && re.prompt === "继续", `my message reopened it: resume_ref ${re.resume_ref}, attempt 2`);
await until(() => task(id).status === "running", 3000, "running again");
seq = 0;

// ── 6 quota → timer → resume ──
const resets = Date.now() + 3_600_000;
await events(2, [{ k: "quota", resets_at: resets, text: "5-hour limit" }, { k: "turn_end", stop: "error", error: "usage limit" }]);
ok(task(id).status === "queued" && task(id).quota_until === resets, "quota → queued until the reset");
const fire = () => { db.run("UPDATE timers SET due_at = ? WHERE status = 'pending' AND kind = 'task'", Date.now() - 1); new Scheduler().tick(); };
const turns = () => got.filter((g) => /\/turns$/.test(g.path)).length;
const t0 = turns();
fire();
await until(() => turns() === t0 + 1, 5000, "quota resume");
ok(/额度/.test(got.filter((g) => /\/turns$/.test(g.path)).at(-1)!.body.text) && task(id).status === "running", "at the reset time the same session gets a turn");
await events(2, [{ k: "turn_end", stop: "done" }]);

// ── 7 CI red ×3 ──
await events(2, [{ k: "pr", url: "https://git.example/demo/repo/pull/3", repo: "demo/repo", number: 3 }]);
const pr = db.one<{ id: number }>("SELECT id FROM task_prs WHERE task_id = ?", id)!;
for (const [i, sha] of ["r1", "r2", "r3"].entries()) {
  checks = { state: "open", ci: "red", head_sha: sha, checks: [{ name: "test", state: "failure" }], failed_log: `case ${i + 1} failed` };
  const before = turns();
  fire();
  await until(() => turns() === before + 1, 5000, `CI wake ${i + 1}`);
  await events(2, [{ k: "turn_end", stop: "done" }]);
}
ok(got.filter((g) => /\/turns$/.test(g.path)).slice(-3).every((g) => /CI 红了/.test(g.body.text)), "three reds on three heads → three wake-ups of the same session");
ok(db.one<{ cat: string }>("SELECT cat FROM push_queue WHERE ref = ?", `task_pr:${pr.id}:red:3`)?.cat === "notice", "…the third in a row → a notice (push_queue, W3b sends it)");

// ── 8 the relay saw nothing ──
const needles = ["/node/v1", "/api/v1", GOAL, SAY, "rm -rf build", "/etc/hosts", "CI 红了", SECRET, "smkw4a-owner"];
const leaks = tap.wire.filter(([side, b]) => {
  const env = side === "hub" ? decodeEnvelope(b) : null;
  if (env?.type === OPEN) return false;
  const body = env && env.type === DATA ? Buffer.from(env.payload) : b;
  return needles.some((x) => body.toString("utf8").includes(x) || body.toString("latin1").includes(x));
});
ok(leaks.length === 0, `the tap saw ${tap.wire.length} messages; none carries any of ${needles.length} plaintexts`);
ok(!needles.some((x) => relayLog.join("\n").includes(x)), "relay log: metadata only");

cl.close(); nd.close();
await hub.close();
await tap.close();
relay.kill("SIGTERM");
ok(true, "hub, tap and relay stopped");
process.exit(0);
