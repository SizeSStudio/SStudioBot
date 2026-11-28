// W2a end to end (docs/tech/06): a real relay (relay/src/main.ts as a child process — hub/ may not import relay/),
// a WS tap in front of it that records every byte the relay is handed on both sides, the real hub, and fake devices
// that speak protocol/noise. Every key, name, token and IP here is made up (203.0.113.0/24, 198.51.100.0/24 are
// documentation ranges).
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { monitorEventLoopDelay } from "node:perf_hooks";
import { WebSocket, WebSocketServer } from "ws";
import { tempHome } from "./helpers.ts";
import { DeviceKey, auth, authBytes, openChannel, pair, settle, type Channel } from "./fake-device.ts";
import { useCrypto } from "../../protocol/noise/crypto.ts";
import { nodeAead, nodeDh } from "../../protocol/noise/node-crypto.ts";
import { finishInitiator, generateNoiseKeyPair, respond, startInitiator } from "../../protocol/noise/channel.ts";
import { CLOSE_HUB_OFFLINE, DATA, OPEN, decodeEnvelope, encodeEnvelope } from "../../protocol/envelope.ts";
import { b64u, decodePairCode, type PairCode } from "../../protocol/pair.ts";
import type { Frame } from "../../protocol/frames.ts";
import { InviteRes } from "../../protocol/api/devices.ts";
import { loadOrCreateHubKey, shortFingerprint, type HubKey } from "../src/link/keys.ts";
import { OWNER_DM_LANE } from "../src/channels/feishu/state.ts";
import { adminRequest } from "../src/admin-socket.ts";
import { setAdminSink } from "../src/notify.ts";
import { run } from "../src/cli.ts";
import { boot, type Hub } from "../src/main.ts";

useCrypto({ aead: nodeAead, dh: nodeDh });

const TOKEN = "fake-relay-token-w2a-test";
const OTHER_PK = b64u(new Uint8Array(32).fill(7));   // listed in relay.yaml, never registered by anyone but the impostor test

let h: ReturnType<typeof tempHome>, hub: Hub, hubKey: HubKey, relay: ChildProcess, relayPort = 0;
const relayLog: string[] = [];
const notices: string[] = [];
/** everything the relay received or sent, as recorded at the tap: [side, bytes] */
const wire: ["hub" | "peer", Buffer][] = [];
let tapPort = 0, tap: WebSocketServer;
const peerUrl = () => `ws://127.0.0.1:${tapPort}/v1/peer`;
const names: string[] = [];     // device names used, so the no-plaintext check can look for them
const secrets: string[] = [];   // invite secrets handed out, likewise

const until = async (cond: () => boolean, ms = 3000, what = "condition") => {
  const end = Date.now() + ms;
  while (!cond()) { if (Date.now() > end) throw new Error(`timed out: ${what}`); await new Promise((r) => setTimeout(r, 10)); }
};

/**
 * A WS man in the middle: accepts on its own port, opens the same path on the relay, copies every message both ways
 * and records it. X-Real-IP is passed through so the relay (which trusts it from loopback) sees the "device's" IP.
 */
async function startTap(): Promise<void> {
  tap = new WebSocketServer({ host: "127.0.0.1", port: 0, perMessageDeflate: false, maxPayload: 1 << 20 });
  await new Promise<void>((r) => tap.once("listening", () => r()));
  tapPort = (tap.address() as { port: number }).port;
  tap.on("connection", (down, req) => {
    const side = (req.url ?? "").startsWith("/v1/hub") ? "hub" : "peer";
    const headers: Record<string, string> = {};
    for (const k of ["authorization", "x-sbot-hub", "x-real-ip"]) if (typeof req.headers[k] === "string") headers[k] = req.headers[k] as string;
    const up = new WebSocket(`ws://127.0.0.1:${relayPort}${req.url}`, { headers, perMessageDeflate: false });
    const queue: Buffer[] = [];
    const ok = (c: number) => c === 1000 || (c >= 3000 && c <= 4999);
    down.on("message", (d: Buffer) => { wire.push([side, Buffer.from(d)]); if (up.readyState === WebSocket.OPEN) up.send(d); else queue.push(d); });
    up.on("open", () => { for (const d of queue.splice(0)) up.send(d); });
    up.on("message", (d: Buffer) => { wire.push([side, Buffer.from(d)]); if (down.readyState === WebSocket.OPEN) down.send(d); });
    up.on("close", (code, reason) => { if (ok(code)) down.close(code, reason); else down.terminate(); });
    down.on("close", (code, reason) => { if (up.readyState === WebSocket.OPEN) { if (ok(code)) up.close(code, reason); else up.terminate(); } else up.terminate(); });
    up.on("unexpected-response", () => { down.terminate(); up.terminate(); });
    up.on("error", () => down.terminate());
    down.on("error", () => up.terminate());
  });
}

async function startRelayChild(): Promise<void> {
  const conf = join(h.root, "relay.yaml");
  const hash = createHash("sha256").update(TOKEN).digest("hex");
  writeFileSync(conf, [
    "listen: { host: 127.0.0.1, port: 0 }",
    "hubs:",
    `  - { hub_pk: "${hubKey.publicB64u}", token_hash: "${hash}" }`,
    `  - { hub_pk: "${OTHER_PK}", token_hash: "${hash}" }`,
    // the tests open hundreds of sessions from one loopback address and fail auth on purpose
    "limits: { conn_per_min: 100000, auth_fail_max: 100000, first_reply_ms: 5000 }",
    "",
  ].join("\n"));
  relay = spawn(process.execPath, [join(import.meta.dirname, "../../relay/src/main.ts")], { env: { ...process.env, RELAY_CONFIG: conf }, stdio: ["ignore", "pipe", "inherit"] });
  let buf = "";
  relay.stdout!.on("data", (d: Buffer) => {
    buf += d.toString();
    for (let i; (i = buf.indexOf("\n")) >= 0; buf = buf.slice(i + 1)) {
      const line = buf.slice(0, i);
      relayLog.push(line);
      try { const v = JSON.parse(line); if (v.ev === "listening") relayPort = v.port; } catch { /* not ours */ }
    }
  });
  await until(() => relayPort > 0, 10_000, "relay listening");
}

before(async () => {
  h = tempHome("link");
  process.env.SBOT_HOME = h.root;
  // the key first, so relay.yaml can list it; boot then finds the same file
  hubKey = loadOrCreateHubKey(h.keys);
  await startRelayChild();
  await startTap();
  writeFileSync(join(h.config, "console.yaml"), `relay:\n  enabled: true\n  url: ws://127.0.0.1:${tapPort}/v1/hub\n`);
  writeFileSync(h.secrets, `RELAY_TOKEN=${TOKEN}\n`, { mode: 0o600 });
  hub = await boot(h, { proxyPort: 0 });
  setAdminSink((t) => { notices.push(t); });
  await until(() => hub.link.relay?.connected === true, 5000, "hub registered");
});

after(async () => {
  await hub?.close();
  for (const c of tap?.clients ?? []) c.terminate();
  await new Promise<void>((r) => (tap ? tap.close(() => r()) : r()));
  relay?.kill("SIGTERM");
});

async function invite(role: "client" | "node" = "client"): Promise<PairCode> {
  const r = await adminRequest(h.run, "POST", "/api/v1/devices/invites", { role });
  assert.equal(r.status, 200);
  const code = decodePairCode(InviteRes.parse(r.body).link);
  secrets.push(code.secret);
  return code;
}

async function paired(role: "client" | "node" = "client", name = `测试设备-${names.length}`, ip = "203.0.113.50"): Promise<{ key: DeviceKey; ch: Channel }> {
  names.push(name);
  const key = new DeviceKey();
  const ch = await pair(await invite(role), key, name, { "x-real-ip": ip });
  assert.equal(await settle(ch), "open");
  return { key, ch };
}

const refused = async (c: Promise<Channel>) => {
  const r = await settle(await c);
  assert.deepEqual(r, { code: 4401, reason: "auth" });
};

test("pair through the relay, then reconnect with auth; last_seen, masked IP, audit, notices", async () => {
  const name = "测试手机-甲";
  names.push(name);
  const key = new DeviceKey();
  const code = await invite();
  assert.equal(code.hub_pk, hubKey.publicB64u);
  assert.equal(code.relay, peerUrl());
  const ch = await pair(code, key, name, { "x-real-ip": "203.0.113.50" });
  const list = await ch.req("GET", "/api/v1/devices");
  assert.equal(list.status, 200);
  const me = list.body.devices.find((d: { id: string }) => d.id === key.id);
  assert.equal(me.name, name);
  assert.equal(hub.link.online(key.id), true);
  assert.equal(me.last_ip_masked, "203.0.113.0/24");
  ch.close();
  await ch.closed;
  await until(() => !hub.link.online(key.id), 2000, "offline after close");
  // a later connection: auth with the device key, from a new range → new_ip audit and a notice
  const again = await auth(peerUrl(), hubKey.publicB64u, key, "client", { "x-real-ip": "198.51.100.7" });
  assert.equal(await settle(again), "open");
  const d = hub.db.one<{ last_ip_masked: string; last_seen: number }>("SELECT last_ip_masked, last_seen FROM devices WHERE id = ?", key.id)!;
  assert.equal(d.last_ip_masked, "198.51.100.0/24");
  const actions = hub.db.all<{ action: string }>("SELECT action FROM device_audit WHERE device_id = ? ORDER BY id", key.id).map((r) => r.action);
  assert.deepEqual(actions, ["pair", "new_ip"]);
  assert.ok(notices.some((n) => n.includes("新设备配上了") && n.includes(name)));
  assert.ok(notices.some((n) => n.includes("没见过的 IP 段") && n.includes("198.51.100.0/24")));
  // the secret is stored only as its hash
  const inv = hub.db.one<{ secret_hash: Uint8Array; used_by: string }>("SELECT secret_hash, used_by FROM device_invites WHERE used_by = ?", key.id)!;
  assert.notDeepEqual(Buffer.from(inv.secret_hash).toString("base64url"), code.secret);
  again.close();
});

test("an invite works once, not after 10 minutes, and only for its role; every refusal looks the same", async () => {
  const code = await invite();
  const first = await pair(code, new DeviceKey(), "测试平板");
  names.push("测试平板");
  assert.equal(await settle(first), "open");
  await refused(pair(code, new DeviceKey(), "第二个拿同一个码"));
  // expired: the hub's clock decides, not the exp in the code
  const late = await invite();
  hub.db.run("UPDATE device_invites SET expires = ? WHERE id = (SELECT MAX(id) FROM device_invites)", Date.now() - 1);
  await refused(pair(late, new DeviceKey()));
  // a client code used to pair a node
  await refused(pair({ ...(await invite("client")), role: "node" }, new DeviceKey()));
  // a made-up secret
  await refused(pair({ ...(await invite()), secret: b64u(randomBytes(32)) }, new DeviceKey()));
  // the key of a device already paired can't be paired again (a removed one neither, see removal)
  const k = new DeviceKey();
  assert.equal(await settle(await pair(await invite(), k)), "open");
  await refused(pair(await invite(), k));
  const fails = hub.db.one<{ n: number }>("SELECT COUNT(*) AS n FROM device_audit WHERE action = 'pair_failed'")!.n;
  assert.ok(fails >= 4, `pair_failed audited (${fails})`);
  first.close();
});

test("replay: a captured auth message or signature is useless on another channel; a repeated message ends one", async () => {
  const { key, ch: p } = await paired();
  p.close();
  // record what a good auth looks like on the wire
  const a = await openChannel(peerUrl(), hubKey.publicB64u, { role: "client", purpose: "auth" });
  const sig = key.sign(authBytes(a));
  const before = a.wire.length;
  a.sendFrame({ t: "auth", device_id: key.id, sig } as Frame);
  const authMsg = a.wire[before]!;
  assert.equal(await settle(a), "open");
  // 1) the same ciphertext into a fresh channel: it doesn't decrypt under the new keys
  const b = await openChannel(peerUrl(), hubKey.publicB64u, { role: "client", purpose: "auth" });
  b.raw(authMsg);
  assert.deepEqual(await b.closed, { code: 4401, reason: "auth" });
  // 2) the same signature, freshly encrypted: it was over the other channel's handshake hash and challenge
  const c = await openChannel(peerUrl(), hubKey.publicB64u, { role: "client", purpose: "auth" });
  c.sendFrame({ t: "auth", device_id: key.id, sig } as Frame);
  assert.deepEqual(await c.closed, { code: 4401, reason: "auth" });
  assert.ok(hub.db.one("SELECT 1 FROM device_audit WHERE device_id = ? AND action = 'challenge_failed'", key.id));
  // 3) inside an open channel, a message sent again (a replayed request) breaks the nonce order: closed
  const n = a.wire.length;
  await a.req("GET", "/api/v1/status");
  a.raw(a.wire[n]!);
  assert.deepEqual(await a.closed, { code: 4400, reason: "protocol" });
});

test("a wrong hub key can't connect: not to our hub, not as an impostor, not to a hub that isn't there", async () => {
  // a device that trusts some other key, routed to our hub: our hub can't read message 1
  const wrong = b64u(generateNoiseKeyPair().publicKey);
  const ws = new WebSocket(`${peerUrl()}?hub=${hubKey.publicB64u}`);
  const { message } = startInitiator(Buffer.from(wrong, "base64url"), { v: 1, role: "client", purpose: "auth" });
  const closed = new Promise<number>((r) => ws.on("close", (c) => r(c)));
  ws.on("open", () => ws.send(message));
  assert.equal(await closed, 4401);
  // an impostor hub (it has a relay token, under another key) that a device is steered to: it can't answer
  const imp = generateNoiseKeyPair();
  const fake = new WebSocket(`ws://127.0.0.1:${relayPort}/v1/hub`, { headers: { authorization: `Bearer ${TOKEN}`, "x-sbot-hub": OTHER_PK } });
  const seen: Error[] = [];
  fake.on("message", (d: Buffer) => {
    const env = decodeEnvelope(d);
    if (env?.type !== DATA) return;
    try { respond(imp, env.payload, () => ({ v: 1, challenge: b64u(randomBytes(32)), hub_time: 0 })); } catch (e) { seen.push(e as Error); }
    // it answers with something anyway
    fake.send(encodeEnvelope(DATA, env.sid, randomBytes(96)));
  });
  await new Promise<void>((r) => fake.on("open", () => r()));
  // the pk in the URL decides the route (a lying relay could pick it), the key the device trusts decides the handshake
  const steered = new WebSocket(`ws://127.0.0.1:${relayPort}/v1/peer?hub=${OTHER_PK}`);
  const { hs, message: m1 } = startInitiator(Buffer.from(hubKey.publicB64u, "base64url"), { v: 1, role: "client", purpose: "auth" });
  const answer = await new Promise<Buffer>((r) => { steered.on("open", () => steered.send(m1)); steered.on("message", (d: Buffer) => r(d)); });
  assert.throws(() => finishInitiator(hs, new Uint8Array(answer)));
  assert.equal(seen.length >= 1, true, "the impostor couldn't read message 1");
  steered.terminate(); fake.close();
  // a key nobody has registered: the relay says the hub is offline
  await assert.rejects(openChannel(peerUrl(), b64u(new Uint8Array(32).fill(9)), { role: "client", purpose: "auth" }), (e: { code?: number }) => e.code === CLOSE_HUB_OFFLINE);
});

test("removing a device: its channels close within 1 s, queued input dropped, its run stopped, it can't come back", async () => {
  const { key, ch: one } = await paired("client", "要删的手机");
  const two = await auth(peerUrl(), hubKey.publicB64u, key);
  assert.equal(await settle(two), "open");
  // a queued input (not_before keeps the dispatcher off it) and a running run, both from this device
  const now = Date.now();
  hub.db.run("INSERT INTO inbox(lane, kind, source, source_msg_id, status, device_id, not_before, ts) VALUES ('client:main','user','client','w2a-q1','received',?,?,?)", key.id, now + 3_600_000, now);
  hub.db.run("INSERT INTO runs(id, lane, status, device_id) VALUES ('r_w2a_fake01', 'client:main', 'running', ?)", key.id);
  const stopped: string[] = [];
  const orig = hub.link.stopRun;
  hub.link.stopRun = (run, lane) => { stopped.push(run); orig(run, lane); };
  try {
    const t0 = Date.now();
    const r = await adminRequest(h.run, "DELETE", `/api/v1/devices/${key.id.slice(0, 8)}`);
    assert.equal(r.status, 200);
    const [c1, c2] = await Promise.all([one.closed, two.closed]);
    assert.deepEqual(c1, { code: 4410, reason: "removed" });
    assert.deepEqual(c2, { code: 4410, reason: "removed" });
    const ms = Math.max(one.closedAt, two.closedAt) - t0;
    assert.ok(ms < 1000, `closed in ${ms} ms`);
    assert.equal((r.body as { channels: number }).channels, 2);
    assert.equal(hub.db.one<{ s: string }>("SELECT status AS s FROM inbox WHERE source_msg_id = 'w2a-q1'")!.s, "dropped");
    assert.deepEqual(stopped, ["r_w2a_fake01"]);
    const d = hub.db.one<{ removed_at: number; removed_by: string }>("SELECT removed_at, removed_by FROM devices WHERE id = ?", key.id)!;
    assert.ok(d.removed_at && d.removed_by === "cli");
    assert.ok(notices.some((n) => n.includes("删了一台设备") && n.includes("要删的手机")));
  } finally { hub.link.stopRun = orig; }
  await refused(auth(peerUrl(), hubKey.publicB64u, key));
  await refused(pair(await invite(), key));   // the old key can't be re-paired either: pair a fresh one
  assert.equal(hub.db.one<{ n: number }>("SELECT COUNT(*) AS n FROM devices WHERE id = ? ", key.id)!.n, 1);
});

test("roles: a node gets 403 on every /api/v1 route — approve, answer a glance, send a message, read self", async () => {
  const { ch: node } = await paired("node", "测试节点");
  const { ch: client } = await paired("client", "测试电脑");
  const cases: [string, string, unknown?][] = [
    ["POST", "/api/v1/approvals/ap_fake1/decide", { decision: "approve" }],
    ["POST", "/api/v1/glances/gl_fake1/answer", { answer: "好" }],
    ["POST", "/api/v1/threads/th_fake1/messages", { text: "以我名义发一句" }],
    ["GET", "/api/v1/self/rhythm.md"],
    ["GET", "/api/v1/status"],
    ["GET", "/api/v1/devices"],
  ];
  for (const [m, p, b] of cases) {
    assert.equal((await node.req(m as "GET", p, b)).status, 403, `node ${m} ${p}`);
    // a client is let through to the router (these routes come in W2b, so 404 for now) — the check isn't "deny all"
    assert.notEqual((await client.req(m as "GET", p, b)).status, 403, `client ${m} ${p}`);
  }
  assert.equal((await node.req("GET", "/node/v1/../api/v1/status")).status, 403);
  assert.equal((await node.req("GET", "/node/v1/%2e%2e/api/v1/status")).status, 403);
  assert.equal((await client.req("GET", "/node/v1/tasks")).status, 403);
  // a node code can't be used to pair a client
  await refused(pair({ ...(await invite("node")), role: "client" }, new DeviceKey()));
  node.close(); client.close();
});

test("a channel carries W2b's stream: events come over the relay; closing the channel drops the stream", async () => {
  const { key, ch } = await paired("client", "看流的手机");
  const before = hub.api.pump.streams;
  const r = await ch.req("POST", "/api/v1/stream", { after: 0 });
  assert.equal(r.status, 200);
  assert.equal(hub.api.pump.streams, before + 1);
  // a change to an entity this connection may see: the rename through the CLI socket
  assert.equal((await adminRequest(h.run, "PATCH", `/api/v1/devices/${key.id.slice(0, 8)}`, { name: "改了名的手机" })).status, 200);
  names.push("改了名的手机");
  await until(() => ch.frames.some((f) => f.t === "ev" && (f as { entity?: string }).entity === "device"), 3000, "device ev over the relay");
  ch.close();
  await until(() => hub.api.pump.streams === before, 2000, "stream dropped with the channel");
});

test("device writes aren't served over a channel until W3: a paired client can't invite, rename or remove", async () => {
  const { key, ch } = await paired("client", "想越权的手机");
  const id8 = key.id.slice(0, 8);
  for (const [m, p, body] of [["POST", "/api/v1/devices/invites", { role: "client" }], ["PATCH", `/api/v1/devices/${id8}`, { name: "x" }], ["DELETE", `/api/v1/devices/${id8}`, undefined]] as const) {
    const r = await ch.req(m, p, body);
    assert.ok(r.status === 404 || r.status === 405, `${m} ${p}: ${r.status}`);
  }
  assert.equal(hub.db.one<{ n: number }>("SELECT COUNT(*) AS n FROM devices WHERE id = ?", key.id)!.n, 1);
  assert.equal(hub.link.online(key.id), true);
  ch.close();
});

test("Feishu /pair and /devices: only in my own DM", async () => {
  const c = hub.link.command;
  const pairText = c("pair", "", OWNER_DM_LANE)!;
  assert.match(pairText, /sstudiobot:\/\/pair#v1\./);
  assert.match(pairText, /飞书的服务器/);
  const link = /sstudiobot:\/\/pair#\S+/.exec(pairText)![0];
  assert.equal(decodePairCode(link).role, "client");
  assert.equal(decodePairCode(/sstudiobot:\/\/pair#\S+/.exec(c("pair", "node", OWNER_DM_LANE)!)![0]).role, "node");
  assert.match(c("pair", "x", OWNER_DM_LANE)!, /用法/);
  // anywhere else it isn't a command of ours: undefined, the dispatcher treats the row as text
  for (const lane of ["feishu:dm:someone", "feishu:wb:th1", "client:main", "console:main"]) {
    assert.equal(c("pair", "", lane), undefined, lane);
    assert.equal(c("devices", "", lane), undefined, lane);
  }
  assert.equal(c("other", "", OWNER_DM_LANE), undefined);
  const { key, ch } = await paired("client", "飞书删的");
  assert.match(c("devices", "", OWNER_DM_LANE)!, /飞书删的/);
  assert.match(c("devices", "rm abc", OWNER_DM_LANE)!, /至少给 6 位/);
  assert.match(c("devices", "rm " + key.id.slice(0, 8), OWNER_DM_LANE)!, /删了「飞书删的」/);
  assert.equal((await ch.closed).code, 4410);
  assert.equal(hub.db.one<{ by: string }>("SELECT removed_by AS by FROM devices WHERE id = ?", key.id)!.by, "channel:feishu");
});

test("sbot status and sbot pair show the fingerprint and the link, never the key", async () => {
  const out: string[] = [];
  assert.equal(await run(["status"], (x) => out.push(x), () => {}), 0);
  assert.equal(await run(["pair"], (x) => out.push(x), () => {}), 0);
  assert.equal(await run(["devices"], (x) => out.push(x), () => {}), 0);
  const text = out.join("\n");
  assert.ok(text.includes(shortFingerprint(hubKey.fingerprint)));
  assert.ok(text.includes(`hub_pk: ${hubKey.publicB64u}`), "the public key, for relay.yaml");
  assert.match(text, /sstudiobot:\/\/pair#v1\./);
  const secret = /^x25519:(\S+)/.exec(readFileSync(join(h.keys, "hub.key"), "utf8"))![1]!;
  assert.ok(!text.includes(secret));
  assert.ok(!relayLog.join("\n").includes(secret));
});

test("20 devices at once (measured)", async (t) => {
  const N = 20, ROUNDS = 10;
  const keys = Array.from({ length: N }, () => new DeviceKey());
  const codes = await Promise.all(keys.map(() => invite()));
  const loop = monitorEventLoopDelay({ resolution: 5 });
  loop.enable();
  const rss0 = process.memoryUsage().rss;
  const t0 = performance.now();
  const chans = await Promise.all(keys.map((k, i) => { names.push(`并发设备-${i}`); return pair(codes[i]!, k, `并发设备-${i}`); }));
  assert.deepEqual(await Promise.all(chans.map((c) => settle(c, 10_000))), Array(N).fill("open"));
  const tPair = performance.now() - t0;
  const rtt: number[] = [];
  const t1 = performance.now();
  await Promise.all(chans.map(async (c) => {
    for (let i = 0; i < ROUNDS; i++) {
      const s = performance.now();
      assert.equal((await c.req("GET", "/api/v1/devices", undefined, 10_000)).status, 200);
      rtt.push(performance.now() - s);
    }
  }));
  const tReq = performance.now() - t1;
  loop.disable();
  rtt.sort((a, b) => a - b);
  assert.ok(hub.link.relay!.sessions() >= N);
  const q = (p: number) => rtt[Math.min(rtt.length - 1, Math.floor(p * rtt.length))]!.toFixed(1);
  const report = `W2a 20 concurrent: pair+auth ${N} in ${tPair.toFixed(0)} ms; ${N * ROUNDS} reqs in ${tReq.toFixed(0)} ms ` +
    `(rtt p50 ${q(0.5)} ms, p95 ${q(0.95)} ms, max ${q(1)} ms); hub event-loop delay p99 ${(loop.percentile(99) / 1e6).toFixed(1)} ms, ` +
    `max ${(loop.max / 1e6).toFixed(1)} ms; hub-process rss +${((process.memoryUsage().rss - rss0) / 1048576).toFixed(1)} MiB (test and hub share it)`;
  t.diagnostic(report);
  console.log(report);
  for (const c of chans) c.close();
});

test("the relay saw ciphertext only: no frame JSON, paths, names, secrets or full IPs on its wire or in its log", () => {
  const needles = ['"t":', "/api/v1", "device_id", "public_key", "sbot-auth", "203.0.113.50", "198.51.100.7", ...names, ...secrets];
  /** the needle found in one recorded message, if any */
  const leak = (side: "hub" | "peer", b: Buffer): string | undefined => {
    // the hub side carries envelopes: an OPEN payload is the relay's own metadata (masked IP), DATA must be opaque
    const env = side === "hub" ? decodeEnvelope(b) : null;
    if (env?.type === OPEN) return undefined;
    const body = env ? Buffer.from(env.payload) : b;
    const text = body.toString("utf8"), latin = body.toString("latin1");
    return needles.find((n) => text.includes(n) || latin.includes(n));
  };
  // the check itself catches plaintext (on either side)
  assert.equal(leak("hub", Buffer.from(encodeEnvelope(DATA, 1, new TextEncoder().encode('{"t":"req","id":1,"method":"GET","path":"/api/v1/status"}')))), '"t":');
  assert.equal(leak("peer", Buffer.from(names[0]!)), names[0]);
  assert.ok(wire.length > 200, `tap recorded ${wire.length} messages`);
  assert.ok(wire.some(([side, b]) => side === "hub" && decodeEnvelope(b)?.type === DATA), "hub-side DATA was recorded");
  for (const [side, b] of wire) assert.equal(leak(side, b), undefined, `a ${side} message contains plaintext`);
  const log = relayLog.join("\n");
  for (const n of ["203.0.113.50", "198.51.100.7", ...names, ...secrets, TOKEN]) assert.ok(!log.includes(n), `relay log contains ${n}`);
  assert.ok(log.includes("203.0.113.0/24"), "the masked IP is what it logs");
});
