// End to end with nothing faked on the wire: the connection state machine and the store, over Node's WebSocket, through
// W2a's relay and the hub's RelayLink / Session to W2b's /api/v1 dispatcher and pump (scripts/clients-e2e-hub.ts, a
// child process since clients/ may not import hub/ or relay/). Pair with a code → bootstrap → live ev/delta → the
// network drops and it fills in by seq (nothing missing, nothing twice) → hub offline 4404 waits → removed 4410 stops.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { ed25519 } from "@noble/curves/ed25519.js";
import { AUTH_PREFIX, b64u, fromB64u, PAIR_PREFIX, signedBytes } from "../../../protocol/pair.ts";
import { Connection, deviceIdOfKey, type ConnState, type Pairing, type Signer, type SocketLike } from "../src/conn/machine.ts";
import { readPairCode } from "../src/conn/pairCode.ts";
import { Store } from "../src/store/store.ts";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const hub = spawn(process.execPath, [path.join(repo, "scripts/clients-e2e-hub.ts")], { stdio: ["pipe", "pipe", "pipe"] });
const hubLog: string[] = [];
hub.stderr.on("data", (d: Buffer) => { hubLog.push(d.toString()); if (hubLog.length > 40) hubLog.shift(); });
after(() => { hub.stdin.end(); setTimeout(() => hub.kill(), 2000).unref(); });

let ready: (port: number) => void;
const port = new Promise<number>((r) => { ready = r; });
const waiters = new Map<number, (v: Record<string, unknown>) => void>();
createInterface({ input: hub.stdout }).on("line", (line) => {
  let v: Record<string, unknown>;
  try { v = JSON.parse(line); } catch { return; }
  if (v.ready) ready(Number(v.port));
  else if (typeof v.id === "number") { waiters.get(v.id)?.(v); waiters.delete(v.id); }
});
let ctlId = 0;
const ctl = (cmd: string, args: Record<string, unknown> = {}): Promise<Record<string, unknown>> =>
  new Promise((resolve) => { const id = ++ctlId; waiters.set(id, resolve); hub.stdin.write(JSON.stringify({ id, cmd, ...args }) + "\n"); });

// every socket the machine opens is a real one; we only count them
const urls: string[] = [];
const openSocket = (u: string): SocketLike => { urls.push(u); return new WebSocket(u) as unknown as SocketLike; };

// a software Ed25519 key standing in for the Keystore / safeStorage ones; same bytes signed
const makeSigner = (): Signer => {
  const sk = ed25519.utils.randomSecretKey();
  return {
    publicKey: async () => b64u(ed25519.getPublicKey(sk)),
    sign: async (h, c, purpose) => b64u(ed25519.sign(signedBytes(purpose === "auth" ? AUTH_PREFIX : PAIR_PREFIX, fromB64u(h), fromB64u(c)), sk)),
  };
};
const signer = makeSigner();

// real timers, but the client's backoff is shrunk 100× so the test doesn't sit through 1–30 s (delays are recorded)
const delays: number[] = [];
const fastTimeout = (fn: () => void, ms: number) => { if (ms < 15_000) delays.push(ms); return setTimeout(fn, ms / 100); };

const until = async (what: string, f: () => boolean, ms = 8000) => {
  const t = Date.now();
  while (!f()) {
    if (Date.now() - t > ms) assert.fail(`timed out: ${what}; state ${JSON.stringify(conn.state)}\n${hubLog.join("")}`);
    await new Promise((r) => setTimeout(r, 10));
  }
};

const LANE = "console:t:th_e2e00001";
const store = new Store();
let saved: Pairing | null = null;
const states: ConnState["s"][] = [];
const conn = new Connection({ openSocket, signer, store, setTimeout: fastTimeout, onPaired: (p) => { saved = p; } });
conn.subscribe((s) => states.push(s.s));
const texts = () => store.timeline(LANE).map((r) => (r.rec.data as { text?: string | null }).text ?? (r.rec.data as { body?: { text?: string } }).body?.text);
const pairCode = async () => {
  const p = readPairCode(String((await ctl("invite")).link));
  assert.ok(p.ok, "the hub's code reads on the device");
  return p.code;
};

test("pair with a fresh code through the relay, then bootstrap and stream", async () => {
  const p = await port;
  await ctl("say", { lane: LANE, text: "早，今天先看样稿" });
  const code = await pairCode();
  assert.equal(code.relay, `ws://127.0.0.1:${p}/v1/peer`);
  conn.start({ pair: { code, name: "e2e 桌面", platform: "macos" } });
  await until("live after pairing", () => conn.state.s === "live");
  assert.deepEqual(states.slice(0, 5), ["connecting", "handshake", "auth", "sync", "live"]);
  assert.equal(urls[0], `ws://127.0.0.1:${p}/v1/peer?hub=${code.hub_pk}`);
  assert.ok(saved, "pairing stored");
  assert.equal(saved!.device_id, deviceIdOfKey(await signer.publicKey()));
  assert.deepEqual(Object.keys(saved!).sort(), ["device_id", "hub_pk", "relay", "role"], "no secret kept");
  const st = await ctl("state");
  assert.equal(st.invites_used, 1);
  assert.deepEqual((st.devices as { name: string }[]).map((d) => d.name), ["e2e 桌面"]);
  assert.ok(store.loaded && store.threadByLane(LANE), "the thread came with bootstrap");
  assert.deepEqual(texts(), ["早，今天先看样稿"]);
  assert.ok(store.list("device").some((d) => d.data.name === "e2e 桌面"));
});

test("live: a new input arrives as an ev; the reply streams as deltas and is replaced by its row", async () => {
  await ctl("say", { lane: LANE, text: "第二版发了吗" });
  await until("ev for the new input", () => texts().length === 2);
  const { run } = await ctl("run", { lane: LANE });
  await until("run ev", () => !!store.get("run", String(run)));
  for (const t of ["发了，", "在", "群里"]) await ctl("delta", { run, lane: LANE, text: t });
  await until("deltas", () => store.liveOn(LANE)[0]?.text === "发了，在群里");
  await ctl("message", { run, lane: LANE, text: "发了，在群里" });
  await until("row replaces live text", () => store.liveOn(LANE).length === 0 && texts().includes("发了，在群里"));
  await ctl("end_run", { run });
  await until("run done", () => store.get("run", String(run))?.data.status === "done");
});

test("the network drops: reconnect authenticates (no pairing again) and fills in by seq — nothing missing, nothing twice", async () => {
  const before = store.seq;
  const sessions = urls.length;
  delays.length = 0;
  await ctl("drop");
  await until("noticed the drop", () => conn.state.s !== "live");
  // while it's down, things happen
  await ctl("say", { lane: LANE, text: "断线时说的一句" });
  await ctl("say", { lane: LANE, text: "又一句" });
  await until("live again", () => conn.state.s === "live" && urls.length > sessions, 15_000);
  assert.equal(delays[0], 1000, "first wait is 1 s");
  await until("filled in", () => texts().includes("又一句"));
  const t = texts();
  assert.equal(new Set(t).size, t.length, `no duplicates: ${t.join(" / ")}`);
  assert.deepEqual(t.slice(-2), ["断线时说的一句", "又一句"]);
  assert.ok(store.seq > before);
  assert.equal((await ctl("state")).invites_used, 1, "the code was not used twice");
});

test("hub offline: 4404 → waiting_hub, backing off 1, 2, 5 …; it comes back on its own", async () => {
  delays.length = 0;
  await ctl("offline", { on: true });
  await until("waiting_hub", () => conn.state.s === "waiting_hub");
  await until("three waits", () => delays.length >= 3);
  assert.deepEqual(delays.slice(0, 3), [1000, 2000, 5000]);
  await ctl("offline", { on: false });
  await until("live after the hub is back", () => conn.state.s === "live", 15_000);
});

test("requests on the live connection: paging, a 404, and device writes are not on the relay path in W2", async () => {
  const th = store.threadByLane(LANE)!;
  const r = await conn.request("GET", `/api/v1/threads/${th.data.id}/items`, { query: { limit: "2" } });
  assert.equal(r.status, 200);
  assert.equal((await conn.request("GET", "/api/v1/nope")).status, 404);
  // invites / rename / remove live on hub-admin.sock until W3: the client must not depend on them
  assert.equal((await conn.request("POST", "/api/v1/devices/invites", { body: { role: "client" } })).status, 404);
});

test("a removed device: CLOSE 4410 → auth_failed (removed), and it stops retrying; a new connection gets 4401", async () => {
  await ctl("remove", { device_id: saved!.device_id });
  await until("auth_failed", () => conn.state.s === "auth_failed");
  assert.deepEqual(conn.state, { s: "auth_failed", why: "removed" });
  const n = urls.length;
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(urls.length, n, "no reconnects after an auth failure");
  const c2 = new Connection({ openSocket, signer, store: new Store(), setTimeout: fastTimeout });
  c2.start({ pairing: saved! });
  await until("auth_failed on a new connection", () => c2.state.s === "auth_failed");
  assert.deepEqual(c2.state, { s: "auth_failed", why: "refused" });
  c2.stop();
});

test("pairing again needs a fresh key: the old key is refused, a new one pairs", async () => {
  const old = new Connection({ openSocket, signer, store: new Store(), setTimeout: fastTimeout });
  old.start({ pair: { code: await pairCode(), name: "旧钥匙", platform: "macos" } });
  await until("old key refused", () => old.state.s === "pair_failed");
  old.stop();
  const fresh = new Connection({ openSocket, signer: makeSigner(), store: new Store(), setTimeout: fastTimeout });
  fresh.start({ pair: { code: await pairCode(), name: "新钥匙", platform: "macos" } });
  await until("new key paired", () => fresh.state.s === "live");
  fresh.stop();
});

test("a forged code: pair_failed, no device written", async () => {
  const code = await pairCode();
  const forged = { ...code, secret: b64u(new Uint8Array(32).fill(9)) };
  const c3 = new Connection({ openSocket, signer: makeSigner(), store: new Store(), setTimeout: fastTimeout });
  c3.start({ pair: { code: forged, name: "冒名", platform: "linux" } });
  await until("pair_failed", () => c3.state.s === "pair_failed");
  c3.stop();
  const st = await ctl("state");
  assert.ok(!(st.devices as { name: string }[]).some((d) => d.name === "冒名"));
  conn.stop();
  void ctl("quit"); // it exits without answering
});
