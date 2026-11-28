// The hub side of the clients' end-to-end test (clients/app/test/e2e.test.ts), as a child process because clients/
// may not import hub/. Nothing here is a stand-in: W2a's relay (relay/src/relay.ts) on a loopback port, the hub's
// RelayLink and Session (hub/src/link/), W2b's /api/v1 dispatcher and pump, on a throwaway home. The test's client
// connects with a real WebSocket to ws://127.0.0.1:<port>/v1/peer (06: ws:// only on loopback). Fictional data only.
//
// stdin / stdout: one JSON per line. The test sends { id, cmd, ... }; this answers { id, ... }. First line out:
// { ready: true, port }.
import { createHash, randomBytes } from "node:crypto";
import { createInterface } from "node:readline";
import { startRelay, type Relay } from "../relay/src/relay.ts";
import { DEFAULT_LIMITS, type RelayConf } from "../relay/src/config.ts";
import { openDb } from "../hub/src/db/db.ts";
import { createApi } from "../hub/src/api/index.ts";
import { authorize } from "../hub/src/link/roles.ts";
import { loadOrCreateHubKey } from "../hub/src/link/keys.ts";
import { RelayLink } from "../hub/src/link/relay-link.ts";
import { createInvite } from "../hub/src/link/pairing.ts";
import { removeDevice } from "../hub/src/link/devices.ts";
import { ingest } from "../hub/src/inbox.ts";
import { itemEnd, itemStart } from "../hub/src/items.ts";
import { tempHome } from "../hub/test/helpers.ts";

const h = tempHome("clients-e2e");
const db = openDb(h.db);
const api = createApi({ db, blobs: h.blobs, hubSha: () => "e2esha", authorize, pump: { tickMs: 20, beatMs: 200 } });
api.start();
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
    case "quit": await quit(); return {};
    default: return { error: `unknown ${c.cmd}` };
  }
}

async function quit() {
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
