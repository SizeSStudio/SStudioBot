// The hub side of the clients' end-to-end test (clients/app/test/e2e.test.ts), as a child process because clients/
// may not import hub/. Nothing here is a stand-in: W2a's relay (relay/src/relay.ts) on a loopback port, the hub's
// RelayLink and Session (hub/src/link/), W2b's /api/v1 dispatcher and pump, on a throwaway home. The test's client
// connects with a real WebSocket to ws://127.0.0.1:<port>/v1/peer (06: ws:// only on loopback). Fictional data only.
// W4: W4a's task engine and node registry are real too; only the node is a fake (FakeNode below, as in hub/test/
// tasks.test.ts): it registers with /node/v1/hello, answers the hub's requests down, and posts its events and
// permission requests through the same dispatcher a node's connection would.
//
// stdin / stdout: one JSON per line. The test sends { id, cmd, ... }; this answers { id, ... }. First line out:
// { ready: true, port }.
import { createHash, randomBytes } from "node:crypto";
import { createInterface } from "node:readline";
import { startRelay, type Relay } from "../relay/src/relay.ts";
import { DEFAULT_LIMITS, type RelayConf } from "../relay/src/config.ts";
import { createApi } from "../hub/src/api/index.ts";
import { authorize } from "../hub/src/link/roles.ts";
import { loadOrCreateHubKey } from "../hub/src/link/keys.ts";
import { RelayLink } from "../hub/src/link/relay-link.ts";
import { createInvite } from "../hub/src/link/pairing.ts";
import { removeDevice } from "../hub/src/link/devices.ts";
import { ingest } from "../hub/src/inbox.ts";
import { itemEnd, itemStart } from "../hub/src/items.ts";
import { ambientHome } from "../hub/test/helpers.ts";
import type { Req, Res } from "../protocol/frames.ts";
import { PROTOCOL } from "../protocol/version.ts";
import type { DispatchCaller } from "../hub/src/api/index.ts";
import type { NodePeer } from "../hub/src/link/session.ts";
import { NodeRegistry } from "../hub/src/tasks/nodes.ts";
import { TaskEngine } from "../hub/src/tasks/engine.ts";
import { nodeRoutes } from "../hub/src/tasks/node-api.ts";
import { nodeTools } from "../hub/src/tasks/tools.ts";
import { allTools } from "../hub/src/tools/registry.ts";
import { registerBuiltinTools } from "../hub/src/tools/builtin.ts";
import { loadAll, useConfigDir } from "../hub/src/config/load.ts";
import { refreshKnown } from "../hub/src/tools/redact.ts";
import { setAdminSink } from "../hub/src/notify.ts";

const { h, db } = await ambientHome("clients-e2e", { "people.yaml": "owner:\n  name: 小测\n  ids:\n    github: demo-owner\n" });
useConfigDir(h.config); loadAll(); refreshKnown();
if (!allTools().length) registerBuiltinTools();
setAdminSink(() => {}); // admin notices would go to a channel; there is none here
let pumpItem: ((run: string, lane: string, e: never) => void) | null = null;
const nodes = new NodeRegistry({ db, hubSha: () => "e2esha", tools: nodeTools });
const engine = new TaskEngine({ db, h, nodes, onItem: (run, lane, e) => pumpItem?.(run, lane, e as never) });
const api = createApi({
  db, blobs: h.blobs, hubSha: () => "e2esha", authorize, pump: { tickMs: 20, beatMs: 200 },
  tasks: engine, node: nodeRoutes({ blobs: h.blobs, nodes, engine }),
});
pumpItem = (run, lane, e) => api.pump.onItem(run, lane, e);
api.start();
engine.startLoop(50); // as main.ts does (every second there): answers, steers and timers go out from the loop

type Handler = (body: any, path: string) => { status: number; body?: unknown };
/** The node on the hub's own machine (`local`), faked: answers what the hub asks, posts what a node would. */
class FakeNode implements NodePeer {
  readonly id = "local";
  readonly got: { method: string; path: string; body: any }[] = [];
  steerApplied = true;
  #n = 1;
  #seq = new Map<string, number>();
  on: Record<string, Handler> = {
    "POST /node/v1/sessions": (b) => ({ status: 200, body: {
      session_ref: b.resume_ref ?? `s-${b.task_id}-${b.attempt}`, workdir: b.worktree ? `${b.cwd}/.sbot-wt/${b.task_id}` : b.cwd,
      ...(b.worktree ? { worktree: { path: `${b.cwd}/.sbot-wt/${b.task_id}`, repo: b.worktree.repo, branch: b.worktree.branch } } : {}),
    } }),
    "POST turns": () => ({ status: 200, body: {} }),
    "POST steer": () => ({ status: 200, body: { applied: this.steerApplied } }),
    "POST interrupt": () => ({ status: 200, body: {} }),
    "POST permission": () => ({ status: 200, body: { ok: true } }),
    "DELETE session": () => ({ status: 200, body: { released: true } }),
    "POST /node/v1/worktrees/cleanup": () => ({ status: 200, body: { removed: true } }),
  };
  async request(method: Req["method"], path: string, body: unknown): Promise<Res> {
    this.got.push({ method, path, body });
    const key = this.on[`${method} ${path}`] ? `${method} ${path}`
      : /\/turns$/.test(path) ? "POST turns" : /\/steer$/.test(path) ? "POST steer" : /\/interrupt$/.test(path) ? "POST interrupt"
      : /^\/node\/v1\/permissions\//.test(path) ? "POST permission" : method === "DELETE" ? "DELETE session" : `${method} ${path}`;
    const r = this.on[key]?.(body, path) ?? { status: 404, body: { error: "fake: no route" } };
    return { t: "res", id: 0, status: r.status, ...(r.body === undefined ? {} : { body: r.body }) } as Res;
  }
  caller(): DispatchCaller { return { device_id: this.id, role: "node", peer: this }; }
  post(path: string, body: unknown) { return api.dispatch({ t: "req", id: this.#n++, method: "POST", path, body } as Req, this.caller()); }
  hello(steer: boolean) {
    return this.post("/node/v1/hello", {
      version: PROTOCOL.current, sha: "nodesha0000", os: "linux", agents: [{ kind: "claude", version: "0.0.1" }, { kind: "codex", version: "0.0.2" }],
      capabilities: { claude: { steer, resume: true, permissions: true, ask: true }, codex: { steer: false, resume: true } },
      quotas: { claude: { left: "80%" } }, cwd: "/home/demo", app_version: "0.4.0", sessions: [],
    });
  }
  events(task: string, attempt: number, es: unknown[]) {
    const k = `${task}:${attempt}`, from = this.#seq.get(k) ?? 0;
    this.#seq.set(k, from + es.length);
    return this.post(`/node/v1/tasks/${task}/events`, { attempt, from_seq: from, events: es.map((e, i) => ({ seq: from + i, ts: Date.now(), e })) });
  }
}
const fake = new FakeNode();
const taskRow = (id: string) => db.one<Record<string, unknown>>("SELECT * FROM tasks WHERE id = ?", id);
const hubKey = loadOrCreateHubKey(h.keys);
const token = randomBytes(24).toString("base64url");

const quiet = () => {}; // the relay's log lines would mix into our stdout
const relayConf = (port: number): RelayConf => ({
  listen: { host: "127.0.0.1", port },
  hubs: [{ hub_pk: hubKey.publicB64u, token_hash: createHash("sha256").update(token).digest("hex") }],
  // a test reconnects a lot from one IP and sends a forged code on purpose: don't let the relay's guards ban it
  limits: { ...DEFAULT_LIMITS, conn_per_min: 100_000, auth_fail_max: 1000 },
  trust_proxy: false,
});
let relay: Relay = await startRelay(relayConf(0), quiet);
const port = relay.port;
const peer = `ws://127.0.0.1:${port}/v1/peer`;

let link: RelayLink | null = null;
function linkUp() {
  link = new RelayLink({
    db, hubKey, url: `ws://127.0.0.1:${port}/v1/hub`, token,
    handle: (req, caller, conn) => api.dispatch(req, { ...caller, conn }),
    closed: (conn) => api.closeConn(conn),
  });
  link.start();
}
async function linkDown() { await link?.close(); link = null; }
linkUp();
const until = async (f: () => boolean) => { while (!f()) await new Promise((r) => setTimeout(r, 10)); };
await until(() => link!.connected);

type Ctl = { id: number; cmd: string; [k: string]: unknown };
const say = (v: unknown) => process.stdout.write(JSON.stringify(v) + "\n");

async function control(c: Ctl): Promise<object> {
  switch (c.cmd) {
    case "invite": return createInvite(db, { role: "client", created_by: "cli", hubPk: hubKey.publicB64u, relayUrl: peer, relayEnabled: true });
    case "say":
      ingest(db, { lane: String(c.lane), kind: "user", source: "feishu", source_msg_id: `om_${randomBytes(6).toString("hex")}`, payload: { text: String(c.text), owner: true } });
      api.pump.kick();
      return {};
    case "run": {
      const run = `r_${Date.now().toString(36)}_${randomBytes(3).toString("hex")}`;
      db.run("INSERT INTO runs(id, lane, role, tier, status, started) VALUES (?, ?, 'main', 'chat', 'running', ?)", run, String(c.lane), Date.now());
      api.pump.kick();
      return { run };
    }
    case "delta": api.pump.onItem(String(c.run), String(c.lane), { k: "delta", text: String(c.text) }); return {};
    case "message":
      itemStart(db, h.blobs, { lane: String(c.lane), run_id: String(c.run), kind: "assistant", status: "done", body: { text: String(c.text) } });
      api.pump.onItem(String(c.run), String(c.lane), { k: "message", text: String(c.text) });
      api.pump.kick();
      return {};
    case "tool_start":
      return { item: itemStart(db, h.blobs, { lane: String(c.lane), run_id: String(c.run), kind: "tool", name: String(c.name), call_id: `call_${randomBytes(3).toString("hex")}`, body: { args: { cmd: "ls" } }, status: "running" }), kick: api.pump.kick() };
    case "tool_end": itemEnd(db, h.blobs, Number(c.item), "done", { args: { cmd: "ls" }, result: "exit 0" }); api.pump.kick(); return {};
    case "end_run": db.run("UPDATE runs SET status = 'done', ended = ? WHERE id = ?", Date.now(), String(c.run)); api.pump.kick(); return {};
    // the network drops: the relay goes away and comes back on the same port; the hub's link re-registers by itself
    case "drop": await relay.close(); relay = await startRelay(relayConf(port), quiet); return {};
    // the hub goes offline (devices get 4404 from the relay) and comes back
    case "offline": if (c.on) await linkDown(); else { linkUp(); await until(() => link!.connected); } return {};
    case "remove": return { removed: !!removeDevice(db, String(c.device_id), "cli", { dropChannels: (d) => link?.dropDevice(d) ?? 0, stopRun: () => {} }) };
    case "state": return {
      online: link?.connected ?? false,
      devices: db.all<{ id: string; name: string; platform: string }>("SELECT id, name, platform FROM devices"),
      invites_used: db.one<{ n: number }>("SELECT count(*) AS n FROM device_invites WHERE used_at IS NOT NULL")!.n,
    };
    // ── W4: the fake node ────────────────────────────────────────────────────────────────────────────────
    case "node_hello": { const r = await fake.hello(c.steer !== false); api.pump.kick(); return { status: r.status }; }
    case "node_steer": fake.steerApplied = c.applied !== false; return {};
    case "node_events": {
      const t = taskRow(String(c.task));
      const r = await fake.events(String(c.task), Number(t?.attempt ?? 1), c.events as unknown[]);
      api.pump.kick();
      return { status: r.status };
    }
    case "node_permission": {
      const t = taskRow(String(c.task));
      const r = await fake.post("/node/v1/permissions", { task_id: String(c.task), attempt: Number(t?.attempt ?? 1), request_id: String(c.request_id),
        ...(c.kind ? { kind: c.kind } : {}), title: String(c.title), detail: c.detail ?? {}, options: c.options ?? [] });
      api.pump.kick();
      return { status: r.status, ...(r.body as object) };
    }
    /** what the hub sent down to the node, whose `METHOD path` matches */
    case "node_sent": { const re = new RegExp(String(c.re)); return { got: fake.got.filter((g) => re.test(`${g.method} ${g.path}`)) }; }
    case "task": { await engine.idle(); return { task: taskRow(String(c.id)) ?? null }; }
    /** a worktree I can clean, of a task that is over (cancel makes one cleanable in the engine; this is the row) */
    case "worktree_cleanable":
      db.run("INSERT INTO worktrees(node, path, task_id, repo, branch, state, cleanable_at, created_at) VALUES ('local', ?, ?, '/home/demo/repo', ?, 'cleanable', ?, ?)",
        String(c.path), String(c.task), `sbot/${String(c.task)}`, Date.now(), Date.now());
      db.emit("task", String(c.task));
      api.pump.kick();
      return {};
    case "quit": await quit(); return {};
    default: return { error: `unknown ${c.cmd}` };
  }
}

async function quit() {
  engine.stopLoop();
  await linkDown();
  await relay.close();
  api.stop();
  db.close();
  process.exit(0);
}

// one at a time, in order
let chain = Promise.resolve();
createInterface({ input: process.stdin }).on("line", (line) => {
  const c = JSON.parse(line) as Ctl;
  chain = chain.then(async () => { try { say({ id: c.id, ...(await control(c)) }); } catch (e) { say({ id: c.id, error: String((e as Error).message) }); } });
}).on("close", () => void quit());
say({ ready: true, port });
