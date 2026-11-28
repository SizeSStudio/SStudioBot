// W4b smoke (09 「W4」 node side) on a fresh home: hub/test/test-home.sh hub/test/smoke-w4b.ts <port>.
// The relay as its own process on 127.0.0.1:<port> behind a WS tap, the hub booted with relay on, and the real node
// (node/src/cli.ts) as subprocesses: `sbot-node pair <link>` through the relay, then `sbot-node run`, with the scripted
// Codex stand-in (node/test/fakes/fake-agent.ts; no login, no model). Walks:
//   pair (key 0600, hub.json, the link used up) · hello (agents, capabilities) · a task → session in a worktree → the
//   permission card → my approval → the agent hears allow → diff, PR, done · a bare reject → the agent hears no ·
//   steer in the turn · the node SIGKILLed mid-turn → waiting_node → restarted, its hello holds the session as
//   released → interrupted · quota → queued until the reset · the relay saw no plaintext.
// Loopback only; fictional data; nothing installed. The node is spawned, never imported (hub/ doesn't import node/).
import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DeviceKey, auth, pair, settle } from "./fake-device.ts";
import { startTap } from "./ws-tap.ts";
import { useCrypto } from "../../protocol/noise/crypto.ts";
import { nodeAead, nodeDh } from "../../protocol/noise/node-crypto.ts";
import { DATA, OPEN, decodeEnvelope } from "../../protocol/envelope.ts";
import { decodePairCode } from "../../protocol/pair.ts";
import { InviteRes } from "../../protocol/api/devices.ts";
import { home } from "../src/home.ts";
import { boot } from "../src/main.ts";
import { adminRequest } from "../src/admin-socket.ts";
import { setQuiet } from "../src/log.ts";
import { decide } from "../src/approvals.ts";
import { loadOrCreateHubKey } from "../src/link/keys.ts";

let step = 0;
const cleanup: (() => void)[] = [];
function ok(cond: unknown, what: string): asserts cond {
  step++;
  if (!cond) { console.log(`✗ ${step}. ${what}`); for (const c of cleanup) c(); process.exit(1); }
  console.log(`✓ ${step}. ${what}`);
}
const until = async (cond: () => boolean, ms: number, what: string) => {
  const end = Date.now() + ms;
  while (!cond()) { if (Date.now() > end) ok(false, `timed out: ${what}`); await new Promise((r) => setTimeout(r, 20)); }
};

setQuiet(true);
useCrypto({ aead: nodeAead, dh: nodeDh });
const PORT = Number(process.env.SBOT_PORT ?? 7830);
const GOAL = "把示例仓库 README 的第二段改通顺";
const APP = join(import.meta.dirname, "..", "..");
const CLI = join(APP, "node", "src", "cli.ts");
const FAKE = join(APP, "node", "test", "fakes", "fake-agent.ts");
chmodSync(FAKE, 0o755);

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
const relay: ChildProcess = spawn(process.execPath, [join(APP, "relay/src/main.ts")], { env: { PATH: process.env.PATH ?? "", RELAY_CONFIG: relayConf }, stdio: ["ignore", "pipe", "pipe"] });
cleanup.push(() => relay.kill("SIGKILL"));
relay.stdout!.on("data", (d: Buffer) => relayLog.push(...d.toString().split("\n").filter(Boolean)));
relay.stderr!.on("data", (d: Buffer) => relayLog.push(`stderr: ${d.toString()}`));
await until(() => relayLog.some((l) => l.includes('"ev":"listening"')), 10_000, "relay listening");
const tap = await startTap(() => PORT);
writeFileSync(join(h.config, "console.yaml"), `relay:\n  enabled: true\n  url: ws://127.0.0.1:${tap.port}/v1/hub\n`);
writeFileSync(join(h.config, "people.yaml"), "owner:\n  name: 小测\n  ids:\n    github: smkw4b-owner\n");
writeFileSync(h.secrets, `RELAY_TOKEN=${token}\n`, { mode: 0o600 });
const hub = await boot(h, { proxyPort: 0 });
const db = hub.db;
await until(() => hub.link.relay?.connected === true, 10_000, "hub registered");
ok(true, `relay on 127.0.0.1:${PORT}, hub registered through the tap`);
const peer = `ws://127.0.0.1:${tap.port}/v1/peer`;
const invite = async (role: "client" | "node") => InviteRes.parse((await adminRequest(h.run, "POST", "/api/v1/devices/invites", { role })).body).link;
const task = (id: string) => db.one<Record<string, any>>("SELECT * FROM tasks WHERE id = ?", id)!;

// a client on the stream (it starts tasks and steers, like the app)
const ck = new DeviceKey();
const cp = await pair(decodePairCode(await invite("client")), ck, "冒烟手机");
ok((await settle(cp)) === "open", "client paired");
cp.close(); await cp.closed;
const cl = await auth(peer, hubKey.publicB64u, ck);
ok((await settle(cl)) === "open", "client reconnected");
let opN = 0;
const op = () => ({ client_op_id: `smkw4b-op-${++opN}-${randomBytes(4).toString("hex")}` });

// ── 1 the node: its own dirs, the fake Codex, a demo repo ──
const nroot = join(h.root, "node-machine");
const conf = join(nroot, "conf"), state = join(nroot, "state"), fakeLog = join(nroot, "fake.log");
mkdirSync(conf, { recursive: true });
writeFileSync(join(conf, "node.yaml"), `only: [codex]\nagents:\n  codex: { bin: ${JSON.stringify(FAKE)}, args: [codex] }\n`);
const repo = join(nroot, "repo");
mkdirSync(repo);
const g = (...a: string[]) => execFileSync("git", ["-c", "user.name=测试", "-c", "user.email=sbot@localhost", "-c", "commit.gpgsign=false", ...a], { cwd: repo, stdio: "ignore" });
g("init", "-q", "-b", "main");
writeFileSync(join(repo, "README.md"), "示例仓库\n\n第二段太长了，读着累。\n");
g("add", "."); g("commit", "-q", "-m", "初始");
// none of the hub's SBOT_* (SBOT_HOME would make it the local node): a remote machine's environment
const nenv = { PATH: process.env.PATH ?? "", HOME: nroot, LANG: "C.UTF-8", SBOT_NODE_CONFIG: conf, SBOT_NODE_STATE: state, SBOT_NODE_KEYSTORE: "file", SBOT_NODE_CWD: nroot, SBOT_LOG: "off", FAKE_LOG: fakeLog };
const cli = (args: string[]) => new Promise<{ code: number; out: string; err: string }>((done) => {
  const p = spawn(process.execPath, [CLI, ...args], { env: nenv, stdio: ["ignore", "pipe", "pipe"] });
  let out = "", err = "";
  p.stdout!.on("data", (d) => (out += d)); p.stderr!.on("data", (d) => (err += d));
  p.on("exit", (code) => done({ code: code ?? -1, out, err }));
});

// ── 2 pairing through the relay ──
const link = await invite("node");
const pr = await cli(["pair", link, "--name", "冒烟节点"]);
ok(pr.code === 0 && /配好了/.test(pr.out), `sbot-node pair: ${pr.out.split("\n")[0] || pr.err.trim()}`);
const hubJson = JSON.parse(readFileSync(join(conf, "hub.json"), "utf8"));
const NODE = String(hubJson.device_id);
ok((statSync(join(conf, "hub.json")).mode & 0o777) === 0o600 && (statSync(join(conf, "device.key")).mode & 0o777) === 0o600, "hub.json and device.key are 0600");
const keyText = readFileSync(join(conf, "device.key"), "utf8");
const dev = db.one<Record<string, unknown>>("SELECT * FROM devices WHERE id = ?", NODE);
ok(dev?.role === "node" && !JSON.stringify(dev).includes(keyText.trim().slice(0, 40)), "the hub has the device as role node, its public key only");
ok(!pr.out.includes(keyText.trim().slice(0, 40)) && !pr.err.includes(keyText.trim().slice(0, 40)), "…nothing of the private key printed");
const again = await cli(["pair", link]);
ok(again.code === 1, "the same link again: refused (used up)");
ok(JSON.parse(readFileSync(join(conf, "hub.json"), "utf8")).device_id === NODE && readFileSync(join(conf, "device.key"), "utf8") === keyText, "…and the first pairing (hub.json, device.key) stays as it was");

// ── 3 the daemon: hello ──
let node: ChildProcess;
const startNode = () => {
  node = spawn(process.execPath, [CLI, "run"], { env: nenv, stdio: ["ignore", "ignore", "pipe"] });
  node.stderr!.on("data", () => {});
  cleanup.push(() => node.kill("SIGKILL"));
};
startNode();
await until(() => hub.nodes.online(NODE), 15_000, "node online");
const row = db.one<Record<string, string>>("SELECT * FROM nodes WHERE device_id = ?", NODE)!;
ok(/codex/.test(row.agents_json ?? "") && JSON.parse(row.caps_json ?? "{}").codex?.steer, "node online through the relay: agents codex, capabilities from the probe");

// ── 4 a task: session, permission card, my approval, diff, PR, done ──
const start = async (goal: string) => {
  const r = await cl.req("POST", "/api/v1/tasks", { goal, node: NODE, repo }, op());
  const id = (r.body as any)?.task?.id as string;
  ok(r.status === 200 && !!id, `task ${id}: ${goal.slice(0, 24)}`);
  return id;
};
const pending = (id: string) => db.one<{ id: number; request_json: string; options_json: string }>("SELECT id, request_json, options_json FROM approvals WHERE task_id = ? AND status = 'pending' ORDER BY id DESC", id);
const t1 = await start(`EDIT ASK PR ${GOAL}`);
await until(() => !!pending(t1), 20_000, "permission card");
const card = pending(t1)!;
ok(task(t1).status === "waiting" && /rm -rf build/.test(card.request_json), "the agent asked → 看一眼 card with the full command, task waiting");
ok(!/always/.test(card.options_json), "…no 「always」 option offered");
ok(decide(db, card.id, { decision: "approve", by: { kind: "device", device_id: "cli" }, answer: { option_id: "allow_once" } }).ok, "I approve (allow_once)");
await until(() => task(t1).status === "done", 20_000, "t1 done");
const wt = db.one<{ path: string }>("SELECT path FROM worktrees WHERE task_id = ?", t1);
ok(!wt || /\.sbot-wt\//.test(wt.path), wt ? "worktree under <repo>/.sbot-wt/" : "no worktree asked for: the session ran in the repo itself");
ok(!!task(t1).diff_ref, "the final diff stored (diff_ref)");
ok(/README\.md/.test(execFileSync("git", ["status", "--porcelain"], { cwd: wt?.path ?? repo, encoding: "utf8" })), "…the agent's edit is there in its workdir");
const prRow = db.one<Record<string, unknown>>("SELECT * FROM task_prs WHERE task_id = ?", t1);
ok(prRow?.number === 42, "the PR from `gh pr create` recorded (task_prs)");

// ── 5 a bare reject ──
const t2 = await start(`ASK ${GOAL}`);
await until(() => !!pending(t2), 20_000, "permission card 2");
decide(db, pending(t2)!.id, { decision: "reject", by: { kind: "device", device_id: "cli" } });
await until(() => task(t2).status !== "waiting", 20_000, "t2 goes on");
await until(() => task(t2).status !== "running", 20_000, "t2 ends");
ok(db.one<{ status: string }>("SELECT status FROM approvals WHERE task_id = ?", t2)?.status === "rejected" && task(t2).status !== "waiting", `a bare reject → the agent heard no and ended its turn (task ${task(t2).status})`);

// ── 6 steer in the turn ──
const t3 = await start(`SLOW ${GOAL}`);
await until(() => task(t3).status === "running", 10_000, "t3 running");
await new Promise((r) => setTimeout(r, 400));
const sr = await cl.req("POST", `/api/v1/tasks/${t3}/steer`, { text: "顺便改标题" }, op());
ok(sr.status === 200, "steer from the client");
await until(() => /codex steer true/.test(readFileSync(fakeLog, "utf8")), 10_000, "steer on the agent");
ok(true, "…Codex got turn/steer with the running turn's id (applied in the turn)");
await until(() => task(t3).status === "done", 20_000, "t3 done");

// ── 7 the node killed mid-turn, started again ──
const t4 = await start(`SLOW ${GOAL}`);
await until(() => task(t4).status === "running", 10_000, "t4 running");
await new Promise((r) => setTimeout(r, 300));
node!.kill("SIGKILL");
await new Promise((r) => node!.once("exit", r));
await until(() => task(t4).status === "waiting_node", 10_000, "waiting_node");
ok(true, "node SIGKILLed mid-turn → waiting_node");
startNode();
await until(() => hub.nodes.online(NODE), 20_000, "node back");
await until(() => task(t4).status === "interrupted", 10_000, "interrupted");
ok(true, "restarted; its hello holds the session as released → interrupted (needs me)");

// ── 8 quota ──
const t5 = await start(`QUOTA ${GOAL}`);
await until(() => task(t5).status === "queued" && !!task(t5).quota_until, 20_000, "queued on quota");
const until5 = Number(task(t5).quota_until);
ok(until5 > Date.now() + 50 * 60_000 && until5 < Date.now() + 70 * 60_000, "quota → queued until the agent's reset time (seconds → ms)");
await until(() => /codex/.test(db.one<{ quota_json: string }>("SELECT quota_json FROM nodes WHERE device_id = ?", NODE)?.quota_json ?? ""), 10_000, "node quotas");
ok(true, "…the node's status carries the codex quota");

// ── 9 the relay saw nothing ──
const needles = ["/node/v1", "/api/v1", GOAL, "rm -rf build", "顺便改标题", "demo-org/demo-repo", "smkw4b-owner"];
const leaks = tap.wire.filter(([side, b]) => {
  const env = side === "hub" ? decodeEnvelope(b) : null;
  if (env?.type === OPEN) return false;
  const body = env && env.type === DATA ? Buffer.from(env.payload) : b;
  return needles.some((x) => body.toString("utf8").includes(x) || body.toString("latin1").includes(x));
});
ok(leaks.length === 0, `the tap saw ${tap.wire.length} messages; none carries any of ${needles.length} plaintexts`);
ok(!needles.some((x) => relayLog.join("\n").includes(x)), "relay log: metadata only");

node!.kill("SIGTERM");
await new Promise((r) => node!.once("exit", r));
cl.close();
await hub.close();
await tap.close();
relay.kill("SIGTERM");
ok(true, "node, hub, tap and relay stopped");
process.exit(0);
