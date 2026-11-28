// The relay (docs/tech/06 「中继」). It forwards Noise ciphertext between one hub WS and many device WSs and
// understands nothing but the envelope: it can't read content and can't pose as the hub (the hub key is in the
// pairing code). What it does guard is itself: registration, per-IP limits, bans, timeouts and backpressure.
//   GET /v1/hub              the hub registers; one WS carries every session, multiplexed by sid
//   GET /v1/peer?hub=<pk>    a device or node; one WS per session, each binary message is one Noise message
//   GET /healthz
// Nothing is buffered beyond the sockets' own buffers; logs carry metadata only (masked IP, sid, sizes, close reason).
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { Duplex } from "node:stream";
import { createHash, timingSafeEqual } from "node:crypto";
import { WebSocket, WebSocketServer, type RawData } from "ws";
import {
  CLOSE, CLOSE_HUB_OFFLINE, DATA, ENVELOPE_MAX, NOISE_MAX, OPEN,
  decodeEnvelope, encodeEnvelope, jsonPayload, maskIp, readJsonPayload,
} from "../../protocol/envelope.ts";
import type { HubEntry, RelayConf } from "./config.ts";

type Peer = {
  ws: WebSocket; sid: number; ip: string; ipm: string; opened: number;
  replied: boolean;              // the hub has sent its first DATA for this sid
  tokens: number; refilled: number;  // device → hub byte bucket
  overSince: number;             // when its send buffer went over peer_buffer_max (0 = it isn't)
  inBytes: number; outBytes: number; alive: boolean;
};
type HubConn = { ws: WebSocket; pk: string; peers: Map<number, Peer>; nextSid: number; paused: boolean; alive: boolean };

export type LogFields = Record<string, string | number | boolean | undefined>;
export type Log = (ev: string, f?: LogFields) => void;
/** One JSON line per event on stdout (journald). Callers pass metadata only; nothing here ever sees content. */
export const jsonLog: Log = (ev, f = {}) => { process.stdout.write(JSON.stringify({ ts: new Date().toISOString(), ev, ...f }) + "\n"); };

export type Relay = {
  server: Server; port: number;
  reload(conf: RelayConf): void;
  stats(): { hubs: number; peers: number; paused: number };
  close(): Promise<void>;
};

// close codes towards a device (4404 is in envelope.ts because clients act on it)
const C_TIMEOUT = 4408, C_SLOW = 4429, C_PROTOCOL = 1002, C_REPLACED = 4409, C_GOING = 1001;
const PK = /^[A-Za-z0-9_-]{43}$/;
const isLoopback = (a: string) => a === "127.0.0.1" || a === "::1" || a === "::ffff:127.0.0.1";
const short = (pk: string) => pk.slice(0, 8);

/** Constant-time: sha256(token) against the registered hash; both sides are always 32 bytes. */
function tokenOk(entry: HubEntry, token: string): boolean {
  return timingSafeEqual(createHash("sha256").update(token, "utf8").digest(), Buffer.from(entry.token_hash, "hex"));
}

/** Answers an upgrade with a plain HTTP status and drops the socket; no body, nothing echoed back. */
function refuse(socket: Duplex, status: number) {
  const text: Record<number, string> = { 400: "Bad Request", 401: "Unauthorized", 403: "Forbidden", 404: "Not Found", 429: "Too Many Requests" };
  socket.end(`HTTP/1.1 ${status} ${text[status] ?? ""}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  socket.destroy();
}

/** A hub's CLOSE carries a code for the device; only plain or application codes pass, anything else becomes 1000. */
function closeOf(payload: Uint8Array): { code: number; reason: string } {
  let v: { code?: unknown; reason?: unknown } = {};
  try { v = readJsonPayload(payload) as typeof v; } catch { /* a bad payload still closes the session */ }
  const code = typeof v?.code === "number" && (v.code === 1000 || (v.code >= 4000 && v.code <= 4999)) ? v.code : 1000;
  const reason = typeof v?.reason === "string" && /^[a-z_]{1,20}$/.test(v.reason) ? v.reason : "";
  return { code, reason };
}

export async function startRelay(initial: RelayConf, log: Log = jsonLog): Promise<Relay> {
  let conf = initial;
  let allowed = new Map(conf.hubs.map((h) => [h.hub_pk, h]));
  const hubs = new Map<string, HubConn>();
  // per-IP state, in memory only (full IPs never reach the log)
  const buckets = new Map<string, { tokens: number; at: number }>();
  const failures = new Map<string, number[]>();
  const bans = new Map<string, number>();

  const L = () => conf.limits;
  const ipOf = (req: IncomingMessage): string => {
    const remote = req.socket.remoteAddress ?? "";
    // behind nginx on loopback: nginx sets X-Real-IP to the real client and overwrites whatever the client sent
    const x = req.headers["x-real-ip"];
    if (conf.trust_proxy && isLoopback(remote) && typeof x === "string" && x.trim()) return x.trim();
    return remote;
  };

  /** 20 new connections per IP per minute by default; refills continuously. */
  const takeConn = (ip: string, now: number): boolean => {
    const cap = L().conn_per_min, rate = cap / 60_000;
    const b = buckets.get(ip) ?? { tokens: cap, at: now };
    b.tokens = Math.min(cap, b.tokens + (now - b.at) * rate);
    b.at = now;
    buckets.set(ip, b);
    if (b.tokens < 1) return false;
    b.tokens -= 1;
    return true;
  };
  const banned = (ip: string, now: number) => (bans.get(ip) ?? 0) > now;
  /** An auth failure (a 401 on /v1/hub, or the hub's CLOSE reason "auth"); too many in the window bans the IP. */
  const authFailed = (ip: string, now: number) => {
    const win = L().auth_fail_window_s * 1000;
    const list = (failures.get(ip) ?? []).filter((t) => now - t < win);
    list.push(now);
    failures.set(ip, list);
    if (list.length >= L().auth_fail_max && !banned(ip, now)) {
      bans.set(ip, now + L().ban_s * 1000);
      failures.delete(ip);
      log("ban", { ip: maskIp(ip), s: L().ban_s });
    }
  };

  const hubWss = new WebSocketServer({ noServer: true, maxPayload: ENVELOPE_MAX, perMessageDeflate: false, clientTracking: false });
  const peerWss = new WebSocketServer({ noServer: true, maxPayload: NOISE_MAX, perMessageDeflate: false, clientTracking: false });

  const sendHub = (hub: HubConn, type: typeof OPEN | typeof DATA | typeof CLOSE, sid: number, payload: Uint8Array) => {
    if (hub.ws.readyState === WebSocket.OPEN) hub.ws.send(encodeEnvelope(type, sid, payload));
  };

  /**
   * Ends one session. `tellHub`: the device side ended it, so the hub hears a CLOSE; when the hub ended it, it doesn't.
   * `hard`: drop the socket instead of a close handshake (a device that doesn't read would hold it for ws's 30 s).
   */
  const dropPeer = (hub: HubConn, p: Peer, code: number, reason: string, tellHub: boolean, hard = false) => {
    if (hub.peers.get(p.sid) !== p) return;
    hub.peers.delete(p.sid);
    if (tellHub) sendHub(hub, CLOSE, p.sid, jsonPayload({ code, reason }));
    if (hard) p.ws.terminate();
    else if (p.ws.readyState === WebSocket.OPEN || p.ws.readyState === WebSocket.CONNECTING) p.ws.close(code, reason);
    log("peer_close", { hub: short(hub.pk), sid: p.sid, ip: p.ipm, in: p.inBytes, out: p.outBytes, code, reason, ms: Date.now() - p.opened });
  };

  const dropHub = (hub: HubConn, code: number, reason: string, hard = false) => {
    if (hubs.get(hub.pk) === hub) hubs.delete(hub.pk);
    // the sessions were Noise channels with this hub process; nobody else can continue them
    for (const p of [...hub.peers.values()]) dropPeer(hub, p, CLOSE_HUB_OFFLINE, "hub_offline", false, hard);
    if (hard) hub.ws.terminate();
    else if (hub.ws.readyState === WebSocket.OPEN) hub.ws.close(code, reason);
  };

  const onHub = (ws: WebSocket, pk: string, ip: string) => {
    const hub: HubConn = { ws, pk, peers: new Map(), nextSid: 0, paused: false, alive: true };
    const old = hubs.get(pk);
    hubs.set(pk, hub);   // first, so the old one's close handler can't remove the new one
    // 06: the same key registering again (the hub restarted) replaces the old registration
    if (old) dropHub(old, C_REPLACED, "replaced");
    log("hub_up", { hub: short(pk), ip: maskIp(ip), replaced: !!old });
    ws.on("pong", () => { hub.alive = true; });
    ws.on("error", () => {});   // 'close' follows; the error text is not logged (it can quote frames)
    ws.on("close", (code) => {
      log("hub_down", { hub: short(pk), code, sessions: hub.peers.size });
      dropHub(hub, code, "");
    });
    ws.on("message", (data: RawData, isBinary: boolean) => {
      const env = isBinary ? decodeEnvelope(data as Buffer) : null;
      if (!env) { dropHub(hub, C_PROTOCOL, "bad_envelope"); return; }
      const p = hub.peers.get(env.sid);
      if (!p) return;                  // the device already left; its CLOSE is on the way
      if (env.type === DATA) {
        p.replied = true;
        p.outBytes += env.payload.length;
        if (p.ws.readyState === WebSocket.OPEN) p.ws.send(env.payload);
      } else if (env.type === CLOSE) {
        const { code, reason } = closeOf(env.payload);
        if (reason === "auth") authFailed(p.ip, Date.now());
        dropPeer(hub, p, code, reason, false);
      }
      // OPEN only goes relay → hub; one coming back is ignored
    });
  };

  const onPeer = (ws: WebSocket, pk: string, ip: string) => {
    ws.on("error", () => {});
    const hub = hubs.get(pk);
    if (!hub) {
      // the client shows 「等主上线」 and backs off 1, 2, 5, 10, 30 s (06)
      ws.close(CLOSE_HUB_OFFLINE, "hub_offline");
      log("peer_refused", { hub: short(pk), ip: maskIp(ip), code: CLOSE_HUB_OFFLINE });
      return;
    }
    let sid = hub.nextSid;
    do { sid = (sid + 1) >>> 0; } while (sid === 0 || hub.peers.has(sid));
    hub.nextSid = sid;
    const now = Date.now();
    const p: Peer = {
      ws, sid, ip, ipm: maskIp(ip), opened: now, replied: false, tokens: L().session_burst_bytes, refilled: now,
      overSince: 0, inBytes: 0, outBytes: 0, alive: true,
    };
    hub.peers.set(sid, p);
    if (hub.paused) ws.pause();
    sendHub(hub, OPEN, sid, jsonPayload({ ip_masked: p.ipm, ts: now }));
    log("peer_open", { hub: short(pk), sid, ip: p.ipm });
    ws.on("pong", () => { p.alive = true; });
    ws.on("close", (code) => dropPeer(hub, p, code, "peer", true));
    ws.on("message", (data: RawData, isBinary: boolean) => {
      if (!isBinary) { dropPeer(hub, p, C_PROTOCOL, "text", true); return; }
      const buf = data as Buffer;
      p.inBytes += buf.length;
      p.tokens -= buf.length;          // may go negative: the tick then pauses reading until it is paid back
      sendHub(hub, DATA, sid, buf);
    });
  };

  const server = createServer((req, res) => {
    const path = (req.url ?? "").split("?")[0];
    if (req.method === "GET" && path === "/healthz") { res.writeHead(200, { "content-type": "text/plain" }); res.end("ok\n"); return; }
    res.writeHead(404); res.end();
  });
  server.on("clientError", (_e, socket) => socket.destroy());
  server.on("upgrade", (req, socket, head) => {
    socket.on("error", () => socket.destroy());
    const ip = ipOf(req), now = Date.now();
    let url: URL;
    try { url = new URL(req.url ?? "/", "http://relay.invalid"); } catch { refuse(socket, 400); return; }
    const reject = (status: number) => { log("reject", { ip: maskIp(ip), path: url.pathname, status }); refuse(socket, status); };
    if (banned(ip, now)) return reject(403);
    if (!takeConn(ip, now)) return reject(429);
    if (url.pathname === "/v1/hub") {
      const pk = String(req.headers["x-sbot-hub"] ?? "");
      const auth = String(req.headers.authorization ?? "");
      const entry = PK.test(pk) ? allowed.get(pk) : undefined;
      const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
      if (!entry || !token || !tokenOk(entry, token)) { authFailed(ip, now); return reject(401); }
      hubWss.handleUpgrade(req, socket, head, (ws) => onHub(ws, pk, ip));
      return;
    }
    if (url.pathname === "/v1/peer") {
      const pk = url.searchParams.get("hub") ?? "";
      if (!PK.test(pk)) return reject(400);
      peerWss.handleUpgrade(req, socket, head, (ws) => onPeer(ws, pk, ip));
      return;
    }
    reject(404);
  });

  // Every 250 ms: backpressure, the byte bucket, first-reply timeouts. A loop over live sessions keeps the rules in
  // one readable place instead of spreading timers over every message.
  const tick = setInterval(() => {
    const now = Date.now(), l = L();
    for (const hub of hubs.values()) {
      // the hub's WS is backed up: stop reading from every device of this hub until it drains
      hub.paused = hub.ws.bufferedAmount > l.hub_buffer_max;
      for (const p of [...hub.peers.values()]) {
        p.tokens = Math.min(l.session_burst_bytes, p.tokens + ((now - p.refilled) / 1000) * l.session_bytes_per_s);
        p.refilled = now;
        const hold = hub.paused || p.tokens < 0;
        if (hold && !p.ws.isPaused) p.ws.pause();
        else if (!hold && p.ws.isPaused) p.ws.resume();
        if (!p.replied && now - p.opened > l.first_reply_ms) { dropPeer(hub, p, C_TIMEOUT, "timeout", true); continue; }
        if (p.ws.bufferedAmount > l.peer_buffer_max) {
          p.overSince ||= now;
          if (now - p.overSince > l.peer_buffer_s * 1000) dropPeer(hub, p, C_SLOW, "slow", true, true);
        } else p.overSince = 0;
      }
    }
  }, 250);
  // keepalive: idle WSs behind nginx get cut otherwise, and a dead side is found within two periods
  const ping = setInterval(() => {
    for (const hub of [...hubs.values()]) {
      if (!hub.alive) { hub.ws.terminate(); continue; }
      hub.alive = false; hub.ws.ping();
      for (const p of [...hub.peers.values()]) {
        if (!p.alive) { p.ws.terminate(); continue; }
        p.alive = false; p.ws.ping();
      }
    }
  }, conf.limits.ping_s * 1000);
  // per-IP maps only hold what still matters
  const prune = setInterval(() => {
    const now = Date.now(), win = L().auth_fail_window_s * 1000;
    for (const [ip, b] of buckets) if (now - b.at > 60_000) buckets.delete(ip);
    for (const [ip, list] of failures) if (!list.some((t) => now - t < win)) failures.delete(ip);
    for (const [ip, until] of bans) if (until <= now) bans.delete(ip);
  }, 60_000);
  for (const t of [tick, ping, prune]) t.unref();

  await new Promise<void>((res, rej) => { server.once("error", rej); server.listen(conf.listen.port, conf.listen.host, () => { server.off("error", rej); res(); }); });
  const port = (server.address() as { port: number }).port;
  log("listening", { host: conf.listen.host, port, hubs: conf.hubs.length });

  return {
    server, port,
    /** relay.yaml changed (SIGHUP): a hub taken off the list is dropped now. */
    reload(next: RelayConf) {
      conf = next;
      allowed = new Map(next.hubs.map((h) => [h.hub_pk, h]));
      for (const hub of [...hubs.values()]) if (!allowed.has(hub.pk)) dropHub(hub, C_GOING, "unlisted");
      log("reloaded", { hubs: next.hubs.length });
    },
    stats: () => {
      const all = [...hubs.values()].flatMap((h) => [...h.peers.values()]);
      return { hubs: hubs.size, peers: all.length, paused: all.filter((p) => p.ws.isPaused).length };
    },
    async close() {
      for (const t of [tick, ping, prune]) clearInterval(t);
      // shutting down: drop the sockets, don't wait on close handshakes (clients reconnect with backoff)
      for (const hub of [...hubs.values()]) dropHub(hub, C_GOING, "shutdown", true);
      await new Promise<void>((res) => { server.close(() => res()); server.closeAllConnections(); });
    },
  };
}
