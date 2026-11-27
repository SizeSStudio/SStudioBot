// Probe relay (06): forwards ciphertext between device sockets and one multiplexed hub socket.
// Sees IP, time, size, sid and the hub key; never content. No buffering beyond the sockets themselves.
//   node relay.ts --port 7829 --hubs relay-hubs.json [--relaxed]
// relay-hubs.json: [{ "hub_pk": "<base64url>", "token_hash": "<hex sha256 of the token>" }]
import { createServer, type IncomingMessage } from "node:http";
import { createHash, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { WebSocketServer, type WebSocket } from "ws";
import { CLOSE, DATA, decode, encode, json, maskIp, MAX_ENVELOPE, MAX_NOISE, OPEN, parseJson } from "./envelope.ts";

const { values: args } = parseArgs({
  options: {
    port: { type: "string", default: "7829" },
    host: { type: "string", default: "127.0.0.1" },
    hubs: { type: "string" },
    // Probe runs open hundreds of sessions and fail auth on purpose from one IP; lift the per-IP limits.
    relaxed: { type: "boolean", default: false },
  },
});
const allowed: { hub_pk: string; token_hash: string }[] = JSON.parse(readFileSync(args.hubs!, "utf8"));

// Self-protection defaults (06 ※); protect the relay, not limit the owner.
const LIMITS = {
  connPerMin: 20,
  firstReplyMs: 10_000,
  authFailWindowMs: 10 * 60_000,
  authFailMax: 10,
  banMs: 60 * 60_000,
  rateBps: 4 * 1024 * 1024,
  burstBytes: 16 * 1024 * 1024,
  hubPauseAt: 8 * 1024 * 1024,
  peerSlowAt: 2 * 1024 * 1024,
  peerSlowMs: 10_000,
};
if (args.relaxed) Object.assign(LIMITS, { connPerMin: 1e9, authFailMax: 1e9 });

type Hub = { ws: WebSocket; pk: string; sessions: Map<number, Peer>; nextSid: number; paused: boolean };
type Peer = { ws: WebSocket; sid: number; hub: Hub; ip: string; answered: boolean; slowSince: number; tokens: number; last: number };

const hubs = new Map<string, Hub>();
const ipBuckets = new Map<string, { tokens: number; last: number }>();
const authFails = new Map<string, number[]>();
const bans = new Map<string, number>();

const log = (event: string, fields: Record<string, unknown> = {}) =>
  console.log(JSON.stringify({ ts: new Date().toISOString(), event, ...fields })); // metadata only, never payload

function clientIp(req: IncomingMessage): string {
  // Behind nginx on loopback, trust its X-Real-IP; otherwise the socket address.
  const remote = req.socket.remoteAddress ?? "";
  const fwd = req.headers["x-real-ip"];
  return (remote === "127.0.0.1" || remote === "::1") && typeof fwd === "string" ? fwd : remote;
}

function allowConn(ip: string): boolean {
  const now = Date.now();
  const ban = bans.get(ip);
  if (ban && ban > now) return false;
  const b = ipBuckets.get(ip) ?? { tokens: LIMITS.connPerMin, last: now };
  b.tokens = Math.min(LIMITS.connPerMin, b.tokens + ((now - b.last) / 60_000) * LIMITS.connPerMin);
  b.last = now;
  ipBuckets.set(ip, b);
  if (b.tokens < 1) return false;
  b.tokens -= 1;
  return true;
}

function noteAuthFail(ip: string): void {
  const now = Date.now();
  const list = (authFails.get(ip) ?? []).filter((t) => now - t < LIMITS.authFailWindowMs);
  list.push(now);
  authFails.set(ip, list);
  if (list.length >= LIMITS.authFailMax) {
    bans.set(ip, now + LIMITS.banMs);
    authFails.delete(ip);
    log("ban", { ip: maskIp(ip) });
  }
}

function sha256Hex(s: string): Buffer {
  return createHash("sha256").update(s).digest();
}

function hubAllowed(pk: string, token: string): boolean {
  const entry = allowed.find((a) => a.hub_pk === pk);
  const want = Buffer.from(entry?.token_hash ?? "00".repeat(32), "hex");
  const got = sha256Hex(token);
  return want.length === 32 && timingSafeEqual(want, got) && entry !== undefined;
}

const wssHub = new WebSocketServer({ noServer: true, maxPayload: MAX_ENVELOPE });
const wssPeer = new WebSocketServer({ noServer: true, maxPayload: MAX_NOISE });

const server = createServer((req, res) => {
  if (req.url === "/healthz") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, hubs: hubs.size, rss: process.memoryUsage().rss }));
    return;
  }
  res.writeHead(404).end();
});

server.on("upgrade", (req, socket, head) => {
  const ip = clientIp(req);
  const url = new URL(req.url ?? "/", "http://x");
  if (!allowConn(ip)) {
    socket.end("HTTP/1.1 429 Too Many Requests\r\n\r\n");
    return;
  }
  if (url.pathname === "/v1/hub") {
    const pk = url.searchParams.get("pk") ?? "";
    const auth = String(req.headers.authorization ?? "").replace(/^Bearer /, "");
    if (!hubAllowed(pk, auth)) {
      noteAuthFail(ip);
      socket.end("HTTP/1.1 401 Unauthorized\r\n\r\n");
      return;
    }
    wssHub.handleUpgrade(req, socket, head, (ws) => onHub(ws, pk));
  } else if (url.pathname === "/v1/peer") {
    const pk = url.searchParams.get("hub") ?? "";
    wssPeer.handleUpgrade(req, socket, head, (ws) => onPeer(ws, pk, ip));
  } else {
    socket.end("HTTP/1.1 404 Not Found\r\n\r\n");
  }
});

function onHub(ws: WebSocket, pk: string): void {
  const old = hubs.get(pk);
  if (old) {
    log("hub_replaced");
    dropHub(old, 4409, "replaced");
  }
  const hub: Hub = { ws, pk, sessions: new Map(), nextSid: 1, paused: false };
  hubs.set(pk, hub);
  log("hub_up", { sessions: 0 });
  ws.on("message", (data, isBinary) => {
    const env = isBinary ? decode(new Uint8Array(data as Buffer)) : null;
    if (!env || env.type === OPEN) return ws.close(1002, "bad envelope");
    const peer = hub.sessions.get(env.sid);
    if (!peer) return; // already gone; the hub learns from our CLOSE
    if (env.type === DATA) {
      peer.answered = true;
      peer.ws.send(env.payload);
    } else {
      const c = parseJson(env.payload) ?? {};
      if (c.reason === "auth") noteAuthFail(peer.ip);
      closePeer(peer, 4401, c.reason === "auth" ? "auth" : "closed", false);
    }
  });
  ws.on("close", () => {
    if (hubs.get(pk) === hub) hubs.delete(pk);
    dropHub(hub, 4404, "hub offline");
    log("hub_down");
  });
}

function dropHub(hub: Hub, code: number, reason: string): void {
  for (const p of hub.sessions.values()) closePeer(p, code, reason, false);
  if (hub.ws.readyState === hub.ws.OPEN) hub.ws.close(code, reason);
}

function onPeer(ws: WebSocket, pk: string, ip: string): void {
  const hub = hubs.get(pk);
  if (!hub) return ws.close(4404, "hub offline");
  let sid = hub.nextSid;
  while (hub.sessions.has(sid) || sid === 0) sid = (sid + 1) >>> 0;
  hub.nextSid = (sid + 1) >>> 0;
  const peer: Peer = { ws, sid, hub, ip, answered: false, slowSince: 0, tokens: LIMITS.burstBytes, last: Date.now() };
  hub.sessions.set(sid, peer);
  hub.ws.send(encode(OPEN, sid, json({ ip_masked: maskIp(ip), ts: Date.now() })));
  log("open", { sid, ip: maskIp(ip) });
  const timer = setTimeout(() => {
    if (!peer.answered) closePeer(peer, 4408, "hub silent", true);
  }, LIMITS.firstReplyMs);
  if (hub.paused) (ws as any)._socket?.pause();
  ws.on("message", (data, isBinary) => {
    if (!isBinary) return closePeer(peer, 1003, "binary only", true);
    const buf = data as Buffer;
    // Per-session byte budget: refill at rateBps up to burst; over budget → stop reading until it refills.
    const now = Date.now();
    peer.tokens = Math.min(LIMITS.burstBytes, peer.tokens + ((now - peer.last) / 1000) * LIMITS.rateBps);
    peer.last = now;
    peer.tokens -= buf.byteLength;
    if (peer.tokens < 0) {
      const sock = (ws as any)._socket;
      sock?.pause();
      setTimeout(() => !hub.paused && sock?.resume(), Math.ceil((-peer.tokens / LIMITS.rateBps) * 1000));
    }
    hub.ws.send(encode(DATA, sid, buf));
  });
  ws.on("close", (code) => {
    clearTimeout(timer);
    if (hub.sessions.get(sid) === peer) {
      hub.sessions.delete(sid);
      if (hub.ws.readyState === hub.ws.OPEN) hub.ws.send(encode(CLOSE, sid, json({ code, reason: "peer closed" })));
    }
    log("close", { sid, code });
  });
}

function closePeer(peer: Peer, code: number, reason: string, tellHub: boolean): void {
  if (peer.hub.sessions.get(peer.sid) !== peer) return;
  peer.hub.sessions.delete(peer.sid);
  if (tellHub && peer.hub.ws.readyState === peer.hub.ws.OPEN) peer.hub.ws.send(encode(CLOSE, peer.sid, json({ code, reason })));
  if (peer.ws.readyState === peer.ws.OPEN) peer.ws.close(code, reason);
}

// Backpressure without our own queue: pause device reads while the hub socket is backed up;
// drop a device whose own socket stays backed up (it resumes by seq after reconnecting).
setInterval(() => {
  const now = Date.now();
  for (const hub of hubs.values()) {
    const backed = hub.ws.bufferedAmount > LIMITS.hubPauseAt;
    if (backed !== hub.paused) {
      hub.paused = backed;
      for (const p of hub.sessions.values()) (p.ws as any)._socket?.[backed ? "pause" : "resume"]();
    }
    for (const p of hub.sessions.values()) {
      if (p.ws.bufferedAmount > LIMITS.peerSlowAt) {
        p.slowSince ||= now;
        if (now - p.slowSince > LIMITS.peerSlowMs) closePeer(p, 4413, "slow consumer", true);
      } else p.slowSince = 0;
    }
  }
}, 250).unref();

server.listen(Number(args.port), args.host, () => log("listening", { port: Number(args.port) }));
