// End to end: the connection state machine and the store against the hub's real /api/v1 dispatcher and pump (W2b),
// the real Noise responder and a stand-in link (scripts/clients-e2e-hub.ts), over a fake transport (stdio of a child
// process, since clients/ may not import hub/). Pair with a code → auth on reconnect → bootstrap → live ev/delta →
// drop and fill in by seq (nothing missing, nothing twice) → 4404 waits → a removed device stops at auth_failed.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { ed25519 } from "@noble/curves/ed25519.js";
import { b64uDecode, b64uEncode, parsePairCode, signedMessage } from "../../../protocol/link.ts";
import { Connection, deviceIdOf, type ConnState, type Pairing, type Signer, type SocketLike } from "../src/conn/machine.ts";
import { Store } from "../src/store/store.ts";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const hub = spawn(process.execPath, [path.join(repo, "scripts/clients-e2e-hub.ts")], { stdio: ["pipe", "pipe", "inherit"] });
after(() => { hub.stdin.end(); hub.kill(); });

// ── the fake transport: one "WebSocket" at a time over the child's stdio ───────────────────────────────────────
let current: FakeSocket | null = null;
const waiters = new Map<number, (v: Record<string, unknown>) => void>();
let ctlId = 0;
function write(kind: number, payload: Uint8Array) {
  const head = Buffer.alloc(5);
  head.writeUInt32BE(payload.length + 1, 0);
  head[4] = kind;
  hub.stdin.write(Buffer.concat([head, payload]));
}
const ctl = (cmd: string, args: Record<string, unknown> = {}): Promise<Record<string, unknown>> =>
  new Promise((resolve) => { const id = ++ctlId; waiters.set(id, resolve); write(0x10, Buffer.from(JSON.stringify({ id, cmd, ...args }))); });

let buf = Buffer.alloc(0);
hub.stdout.on("data", (chunk: Buffer) => {
  buf = Buffer.concat([buf, chunk]);
  while (buf.length >= 4) {
    const n = buf.readUInt32BE(0);
    if (buf.length < 4 + n) break;
    const kind = buf[4]!, payload = new Uint8Array(buf.subarray(5, 4 + n));
    buf = buf.subarray(4 + n);
    if (kind === 0x01) current?.deliver(payload);
    else if (kind === 0x02) { const c = JSON.parse(Buffer.from(payload).toString()); const s = current; current = null; s?.closed(c.code, c.reason); }
    else if (kind === 0x10) { const v = JSON.parse(Buffer.from(payload).toString()); waiters.get(v.id)?.(v); waiters.delete(v.id); }
  }
});

const urls: string[] = [];
class FakeSocket implements SocketLike {
  binaryType = "blob";
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: unknown }) => void) | null = null;
  onclose: ((e: { code: number; reason: string }) => void) | null = null;
  onerror: ((e: unknown) => void) | null = null;
  sent = 0;
  constructor(url: string) {
    urls.push(url);
    current = this;
    write(0x00, new Uint8Array(0));
    setTimeout(() => this.onopen?.(), 0);
  }
  send(d: Uint8Array) { if (current === this) { this.sent++; write(0x01, d); } }
  close() { if (current === this) { current = null; write(0x02, new Uint8Array(0)); } }
  deliver(d: Uint8Array) { this.onmessage?.({ data: d.buffer.slice(d.byteOffset, d.byteOffset + d.byteLength) }); }
  closed(code: number, reason: string) { this.onclose?.({ code, reason }); }
}

// ── the device: a software Ed25519 key standing in for Keystore / safeStorage ──────────────────────────────────
const sk = ed25519.utils.randomSecretKey();
const signer: Signer = {
  publicKey: async () => b64uEncode(ed25519.getPublicKey(sk)),
  sign: async (h, c, purpose) => b64uEncode(ed25519.sign(signedMessage(purpose, b64uDecode(h), b64uDecode(c)), sk)),
};

// timers: real, but the backoff is shrunk by a factor so the test doesn't sit through 1–30 s waits
const delays: number[] = [];
const fastTimeout = (fn: () => void, ms: number) => { if (ms < 15_000) delays.push(ms); return setTimeout(fn, ms / 100); };

const until = async (what: string, f: () => boolean, ms = 5000) => {
  const t = Date.now();
  while (!f()) { if (Date.now() - t > ms) assert.fail(`timed out: ${what}`); await new Promise((r) => setTimeout(r, 10)); }
};

const LANE = "console:t:th_e2e00001";
const store = new Store();
let saved: Pairing | null = null;
const states: ConnState["s"][] = [];
const conn = new Connection({ openSocket: (u) => new FakeSocket(u), signer, store, setTimeout: fastTimeout, onPaired: (p) => { saved = p; } });
conn.subscribe((s) => states.push(s.s));
const texts = () => store.timeline(LANE).map((r) => (r.rec.data as { text?: string | null }).text ?? (r.rec.data as { body?: { text?: string } }).body?.text);

test("pair with a fresh code, then bootstrap and stream", async () => {
  await ctl("say", { lane: LANE, text: "早，今天先看样稿" });
  const { link } = await ctl("invite");
  const p = parsePairCode(String(link));
  assert.ok(p.ok);
  conn.start({ pair: { code: p.code, name: "e2e 桌面", platform: "macos" } });
  await until("live after pairing", () => conn.state.s === "live");
  assert.deepEqual(states.slice(0, 5), ["connecting", "handshake", "auth", "sync", "live"]);
  assert.ok(urls[0]!.startsWith("wss://relay.example/v1/peer?hub="), urls[0]);
  assert.ok(saved, "pairing stored");
  assert.equal(saved!.device_id, deviceIdOf(await signer.publicKey()));
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

test("a drop: reconnect authenticates (no pairing again) and fills in by seq — nothing missing, nothing twice", async () => {
  const before = store.seq;
  const sessions = urls.length;
  await ctl("drop");
  await until("retry", () => conn.state.s === "retry");
  // while it's down, things happen
  await ctl("say", { lane: LANE, text: "断线时说的一句" });
  await ctl("say", { lane: LANE, text: "又一句" });
  await until("live again", () => conn.state.s === "live" && urls.length > sessions);
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
  await until("live after the hub is back", () => conn.state.s === "live", 8000);
});

test("paging and requests work on the live connection", async () => {
  const th = store.threadByLane(LANE)!;
  const r = await conn.request("GET", `/api/v1/threads/${th.data.id}/items`, { query: { limit: "2" } });
  assert.equal(r.status, 200);
  const r2 = await conn.request("GET", "/api/v1/nope");
  assert.equal(r2.status, 404);
});

test("a removed device: CLOSE 'auth' → auth_failed, and it stops retrying", async () => {
  await ctl("remove", { device_id: saved!.device_id });
  await until("auth_failed", () => conn.state.s === "auth_failed");
  const n = urls.length;
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(urls.length, n, "no reconnects after an auth failure");
  // and a fresh connection with the same key is refused the same way
  const c2 = new Connection({ openSocket: (u) => new FakeSocket(u), signer, store: new Store(), setTimeout: fastTimeout });
  c2.start({ pairing: saved! });
  await until("auth_failed on a new connection", () => c2.state.s === "auth_failed");
  c2.stop();
});

test("a spent or forged code: pair_failed, no device written", async () => {
  const { link } = await ctl("invite");
  const p = parsePairCode(String(link));
  assert.ok(p.ok);
  const forged = { ...p.code, secret: b64uEncode(new Uint8Array(32).fill(9)) };
  const c3 = new Connection({ openSocket: (u) => new FakeSocket(u), signer, store: new Store(), setTimeout: fastTimeout });
  c3.start({ pair: { code: forged, name: "冒名", platform: "linux" } });
  await until("pair_failed", () => c3.state.s === "pair_failed");
  c3.stop();
  const st = await ctl("state");
  assert.ok(!(st.devices as { name: string }[]).some((d) => d.name === "冒名"));
  conn.stop();
  void ctl("quit"); // exits without a reply
});
