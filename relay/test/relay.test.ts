// The relay on its own (docs/tech/06): registration, routing by sid, the self-protection rules, backpressure, and
// metadata-only logs. Fake hubs and peers speak raw envelopes; the payloads are opaque bytes to the relay anyway.
// Keys, tokens and IPs are fictional (203.0.113.0/24 is a documentation range).
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { WebSocket } from "ws";
import { CLOSE, CLOSE_HUB_OFFLINE, DATA, OPEN, decodeEnvelope, encodeEnvelope, jsonPayload, readJsonPayload } from "../../protocol/envelope.ts";
import { DEFAULT_LIMITS, parseConf, type Limits } from "../src/config.ts";
import { startRelay, type Relay } from "../src/relay.ts";

const PK = (n: number) => Buffer.alloc(32, n).toString("base64url");
const TOKEN = "fake-relay-token-for-tests";
const hash = (t: string) => createHash("sha256").update(t).digest("hex");

async function relay(limits: Partial<Limits> = {}) {
  const lines: string[] = [];
  const r = await startRelay(parseConf({ listen: { host: "127.0.0.1", port: 0 }, hubs: [{ hub_pk: PK(1), token_hash: hash(TOKEN) }, { hub_pk: PK(2), token_hash: hash(TOKEN) }], limits }),
    (ev, f) => { lines.push(JSON.stringify({ ev, ...f })); });
  return { r, lines, base: `ws://127.0.0.1:${r.port}` };
}

type Conn = { ws: WebSocket; msgs: Buffer[]; closed: Promise<{ code: number; reason: string }>; status?: number };
function connect(url: string, headers: Record<string, string> = {}): Promise<Conn> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, { headers });
    const msgs: Buffer[] = [];
    const c: Conn = { ws, msgs, closed: new Promise((res) => ws.on("close", (code, reason) => res({ code, reason: reason.toString() }))) };
    ws.on("message", (d) => msgs.push(d as Buffer));
    ws.on("open", () => resolve(c));
    ws.on("unexpected-response", (_q, res) => { c.status = res.statusCode; ws.terminate(); resolve(c); });
    ws.on("error", (e) => { if (c.status === undefined) reject(e); });
  });
}
const hubConn = (base: string, pk = PK(1), token = TOKEN, ip?: string) =>
  connect(`${base}/v1/hub`, { authorization: `Bearer ${token}`, "x-sbot-hub": pk, ...(ip ? { "x-real-ip": ip } : {}) });
const peerConn = (base: string, pk = PK(1), ip?: string) => connect(`${base}/v1/peer?hub=${pk}`, ip ? { "x-real-ip": ip } : {});
const until = async (cond: () => boolean, ms = 3000, what = "condition") => {
  const end = Date.now() + ms;
  while (!cond()) { if (Date.now() > end) throw new Error(`timed out: ${what}`); await new Promise((r) => setTimeout(r, 10)); }
};
const envs = (c: Conn) => c.msgs.map((m) => decodeEnvelope(m)!);

test("relay.yaml: defaults are 06's numbers; bad entries are named, values never echoed", () => {
  const c = parseConf({ hubs: [] });
  assert.deepEqual(c.listen, { host: "127.0.0.1", port: 7840 });
  assert.equal(c.limits.conn_per_min, 20);
  assert.equal(c.limits.first_reply_ms, 10_000);
  assert.equal(c.limits.hub_buffer_max, 8 * 1024 * 1024);
  assert.equal(c.limits.peer_buffer_max, 2 * 1024 * 1024);
  assert.deepEqual(DEFAULT_LIMITS, c.limits);
  assert.throws(() => parseConf({ hubs: [{ hub_pk: "short", token_hash: hash("x") }] }), /hubs\[0\]\.hub_pk/);
  assert.throws(() => parseConf({ hubs: [{ hub_pk: PK(1), token_hash: "secret-looking" }] }), (e: Error) => /token_hash/.test(e.message) && !e.message.includes("secret-looking"));
  assert.throws(() => parseConf({ limits: { nope: 1 } }), /limits\.nope/);
});

test("healthz, unknown paths, a bad hub key in the query", async () => {
  const { r, base } = await relay();
  try {
    const http = base.replace("ws:", "http:");
    assert.equal((await fetch(`${http}/healthz`)).status, 200);
    assert.equal((await fetch(`${http}/v1/other`)).status, 404);
    assert.equal((await connect(`${base}/v1/nope`)).status, 404);
    assert.equal((await peerConn(base, "not-a-key")).status, 400);
  } finally { await r.close(); }
});

test("registration: wrong token or unlisted key → 401; the right pair registers", async () => {
  const { r, base } = await relay();
  try {
    assert.equal((await hubConn(base, PK(1), "wrong-token")).status, 401);
    assert.equal((await hubConn(base, PK(9))).status, 401);
    assert.equal((await connect(`${base}/v1/hub`, { "x-sbot-hub": PK(1) })).status, 401);
    const h = await hubConn(base);
    assert.equal(h.status, undefined);
    await until(() => r.stats().hubs === 1);
    h.ws.close();
  } finally { await r.close(); }
});

test("a device for an offline hub gets 4404", async () => {
  const { r, base } = await relay();
  try {
    const p = await peerConn(base, PK(2));
    assert.equal((await p.closed).code, CLOSE_HUB_OFFLINE);
  } finally { await r.close(); }
});

test("sessions: OPEN with the masked IP, DATA both ways untouched, CLOSE both ways, sid per session", async () => {
  const { r, base, lines } = await relay();
  try {
    const h = await hubConn(base);
    await until(() => r.stats().hubs === 1);
    const a = await peerConn(base, PK(1), "203.0.113.77"), b = await peerConn(base, PK(1), "2001:db8:aa:bb::1");
    await until(() => h.msgs.length >= 2);
    const [oa, ob] = envs(h);
    assert.equal(oa!.type, OPEN); assert.equal(ob!.type, OPEN);
    assert.notEqual(oa!.sid, ob!.sid);
    assert.equal((readJsonPayload(oa!.payload) as { ip_masked: string }).ip_masked, "203.0.113.0/24");
    assert.equal((readJsonPayload(ob!.payload) as { ip_masked: string }).ip_masked, "2001:db8:aa::/48");
    // device → hub: the bytes arrive as DATA for that sid, unchanged
    const blob = randomBytes(1000);
    a.ws.send(blob);
    await until(() => h.msgs.length >= 3);
    const d = envs(h)[2]!;
    assert.equal(d.type, DATA); assert.equal(d.sid, oa!.sid);
    assert.deepEqual(Buffer.from(d.payload), blob);
    // hub → device: only the addressed device gets it
    h.ws.send(encodeEnvelope(DATA, ob!.sid, new Uint8Array([7, 7, 7])));
    await until(() => b.msgs.length === 1);
    assert.deepEqual([...b.msgs[0]!], [7, 7, 7]);
    assert.equal(a.msgs.length, 0);
    // hub closes b with a code; device a leaves on its own → the hub hears CLOSE for a's sid
    h.ws.send(encodeEnvelope(CLOSE, ob!.sid, jsonPayload({ code: 4410, reason: "removed" })));
    assert.deepEqual(await b.closed, { code: 4410, reason: "removed" });
    a.ws.close(1000);
    await until(() => envs(h).some((e) => e.type === CLOSE && e.sid === oa!.sid));
    await until(() => r.stats().peers === 0);
    // metadata only: masked IPs, never the full address, never payload bytes
    const log = lines.join("\n");
    assert.ok(!log.includes("203.0.113.77") && !log.includes("2001:db8:aa:bb::1"));
    assert.ok(log.includes("203.0.113.0/24"));
    assert.ok(!log.includes(blob.toString("hex").slice(0, 16)) && !log.includes(blob.toString("base64").slice(0, 16)));
    h.ws.close();
  } finally { await r.close(); }
});

test("the newest registration of a key replaces the old one; its sessions end with 4404", async () => {
  const { r, base } = await relay();
  try {
    const h1 = await hubConn(base);
    await until(() => r.stats().hubs === 1);
    const p = await peerConn(base);
    await until(() => h1.msgs.length === 1);
    const h2 = await hubConn(base);
    assert.equal((await h1.closed).code, 4409);
    assert.equal((await p.closed).code, CLOSE_HUB_OFFLINE);
    // the new one works
    const q = await peerConn(base);
    await until(() => h2.msgs.length === 1);
    assert.equal(envs(h2)[0]!.type, OPEN);
    q.ws.close(); h2.ws.close();
  } finally { await r.close(); }
});

test("size caps: a device message over 65,535 bytes and a text message both end the session", async () => {
  const { r, base } = await relay();
  try {
    const h = await hubConn(base);
    await until(() => r.stats().hubs === 1);
    const big = await peerConn(base);
    big.ws.send(Buffer.alloc(65536));
    assert.equal((await big.closed).code, 1009);
    const txt = await peerConn(base);
    txt.ws.send("{\"t\":\"req\"}");
    assert.equal((await txt.closed).code, 1002);
    h.ws.close();
  } finally { await r.close(); }
});

test("the hub must answer within first_reply_ms or the session is closed (both sides told)", async () => {
  const { r, base } = await relay({ first_reply_ms: 200 });
  try {
    const h = await hubConn(base);
    await until(() => r.stats().hubs === 1);
    const p = await peerConn(base);
    assert.equal((await p.closed).code, 4408);
    await until(() => envs(h).some((e) => e.type === CLOSE));
    h.ws.close();
  } finally { await r.close(); }
});

test("per-IP connection bucket → 429; auth failures (401s and the hub's reason auth) → ban → 403", async () => {
  const { r, base, lines } = await relay({ conn_per_min: 3, auth_fail_max: 3 });
  try {
    for (let i = 0; i < 3; i++) assert.equal((await connect(`${base}/v1/nope`, { "x-real-ip": "203.0.113.5" })).status, 404);
    assert.equal((await connect(`${base}/v1/nope`, { "x-real-ip": "203.0.113.5" })).status, 429);
    // another IP is unaffected; three bad registrations ban it
    for (let i = 0; i < 3; i++) assert.equal((await hubConn(base, PK(1), "wrong", "203.0.113.6")).status, 401);
    assert.equal((await connect(`${base}/v1/nope`, { "x-real-ip": "203.0.113.6" })).status, 403);
    // the hub's CLOSE reason "auth" counts against the device's IP the same way
    const h = await hubConn(base, PK(1), TOKEN, "203.0.113.9");
    await until(() => r.stats().hubs === 1);
    for (let i = 0; i < 3; i++) {
      const p = await peerConn(base, PK(1), "203.0.113.8");
      await until(() => envs(h).filter((e) => e.type === OPEN).length === i + 1);
      h.ws.send(encodeEnvelope(CLOSE, envs(h).filter((e) => e.type === OPEN)[i]!.sid, jsonPayload({ code: 4401, reason: "auth" })));
      assert.equal((await p.closed).code, 4401);
    }
    assert.equal((await peerConn(base, PK(1), "203.0.113.8")).status, 403);
    assert.ok(lines.some((l) => l.includes('"ev":"ban"') && l.includes("203.0.113.0/24")));
    h.ws.close();
  } finally { await r.close(); }
});

test("backpressure: a device that doesn't read is closed (4429); a backed-up hub pauses its devices", async () => {
  const { r, base } = await relay({ peer_buffer_max: 64 * 1024, peer_buffer_s: 0.3, hub_buffer_max: 64 * 1024 });
  try {
    const h = await hubConn(base);
    await until(() => r.stats().hubs === 1);
    const slow = await peerConn(base);
    await until(() => h.msgs.length === 1);
    const sid = envs(h)[0]!.sid;
    (slow.ws as unknown as { _socket: { pause(): void } })._socket.pause();   // stops reading: the relay's buffer fills
    const chunk = new Uint8Array(65000);
    for (let i = 0; i < 400; i++) h.ws.send(encodeEnvelope(DATA, sid, chunk));
    await until(() => envs(h).some((e) => e.type === CLOSE && e.sid === sid && (readJsonPayload(e.payload) as { code: number }).code === 4429), 8000, "slow device closed");
    // now the hub stops reading; a device that keeps sending gets paused instead of buffered
    const fast = await peerConn(base);
    await until(() => envs(h).filter((e) => e.type === OPEN).length === 2);
    (h.ws as unknown as { _socket: { pause(): void } })._socket.pause();
    for (let i = 0; i < 400; i++) fast.ws.send(chunk);
    await until(() => r.stats().paused === 1, 8000, "device paused");
    (h.ws as unknown as { _socket: { resume(): void } })._socket.resume();
    await until(() => r.stats().paused === 0, 8000, "device resumed");
    fast.ws.close(); h.ws.close();
  } finally { await r.close(); }
});
