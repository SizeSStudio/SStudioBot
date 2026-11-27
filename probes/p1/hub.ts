// Probe hub: Noise responder + auth/pair (06) + a few probe routes. Ingress via the relay (one
// multiplexed WS) and/or directly (one WS per session, same bytes) so RTT can be compared.
//   RELAY_TOKEN=... node hub.ts --key hub-key.json --devices devices.json [--relay ws://127.0.0.1:7829] [--direct 7830]
import { randomBytes, createHash, timingSafeEqual } from "node:crypto";
import { readFileSync, existsSync, writeFileSync } from "node:fs";
import { monitorEventLoopDelay } from "node:perf_hooks";
import { parseArgs } from "node:util";
import { WebSocket, WebSocketServer } from "ws";
import { decodeJson, encodeJson, generateNoiseKeyPair, respond, type NoiseKeyPair, type Transport } from "./noise/channel.ts";
import { CLOSE, DATA, decode, encode, json, MAX_NOISE, OPEN, parseJson } from "./envelope.ts";
import { b64u, deviceId, fromB64u, verify } from "./identity.ts";

const { values: args } = parseArgs({
  options: {
    key: { type: "string" },
    devices: { type: "string" },
    invites: { type: "string" },
    relay: { type: "string" },
    direct: { type: "string" },
    host: { type: "string", default: "127.0.0.1" },
    "event-bytes": { type: "string", default: "300" },
  },
});

function loadKey(path: string): NoiseKeyPair {
  if (!existsSync(path)) {
    const k = generateNoiseKeyPair();
    writeFileSync(path, JSON.stringify({ sk: b64u(k.secretKey), pk: b64u(k.publicKey) }), { mode: 0o600 });
  }
  const j = JSON.parse(readFileSync(path, "utf8"));
  return { secretKey: fromB64u(j.sk), publicKey: fromB64u(j.pk) };
}
const hubKey = loadKey(args.key!);
const devices = new Map<string, Uint8Array>(); // device_id → Ed25519 public key
for (const d of existsSync(args.devices!) ? JSON.parse(readFileSync(args.devices!, "utf8")) : []) devices.set(d.device_id, fromB64u(d.public_key));
const invites: { hash: Buffer; used: boolean }[] = args.invites
  ? JSON.parse(readFileSync(args.invites, "utf8")).map((h: string) => ({ hash: Buffer.from(h, "hex"), used: false }))
  : [];

// 1 ms sampling: the histogram includes the sampling interval itself, so 10 ms would floor p99 at ~10 ms.
const eld = monitorEventLoopDelay({ resolution: 1 });
eld.enable();
let rssBaseline = process.memoryUsage().rss;
const eventPad = "x".repeat(Number(args["event-bytes"]));
const log = (event: string, f: Record<string, unknown> = {}) => console.log(JSON.stringify({ ts: Date.now(), event, ...f }));
let sessionCount = 0;

type Io = { send(b: Uint8Array): void; close(reason: string): void };

class Session {
  private io: Io;
  private transport: Transport | null = null;
  private challenge: Uint8Array | null = null;
  private purpose: "auth" | "pair" = "auth";
  private device: string | null = null;
  private timers: NodeJS.Timeout[] = [];
  private dead = false;

  constructor(io: Io) {
    this.io = io;
    sessionCount++;
    this.timers.push(setTimeout(() => !this.device && this.fail(), 10_000));
  }

  onMessage(bytes: Uint8Array): void {
    if (this.dead) return;
    try {
      if (!this.transport) return this.handshake(bytes);
      const frame = this.transport.open(bytes);
      if (frame) this.onFrame(decodeJson(frame) as any);
    } catch {
      this.fail(); // any decrypt or protocol error is fatal; never say which step
    }
  }

  private handshake(msg1: Uint8Array): void {
    const r = respond(hubKey, msg1, () => {
      this.challenge = new Uint8Array(randomBytes(32));
      return { v: 1, challenge: b64u(this.challenge), hub_time: Date.now() };
    });
    this.transport = r.transport;
    this.purpose = r.client.purpose;
    this.io.send(r.reply);
  }

  private onFrame(f: any): void {
    if (!this.device) {
      if (f?.t === "auth" && this.purpose === "auth") return this.auth(f);
      if (f?.t === "pair" && this.purpose === "pair") return this.pair(f);
      return this.fail();
    }
    if (f?.t === "req") return this.req(f);
  }

  private auth(f: any): void {
    const pk = typeof f.device_id === "string" ? devices.get(f.device_id) : undefined;
    if (!pk || !verify(pk, "auth", this.transport!.handshakeHash, this.challenge!, String(f.sig))) return this.fail();
    this.device = f.device_id;
    this.send({ t: "res", id: 0, status: 200, body: { device_id: this.device } });
  }

  private pair(f: any): void {
    const got = createHash("sha256").update(String(f.secret)).digest();
    const inv = invites.find((i) => !i.used && timingSafeEqual(i.hash, got));
    const pk = typeof f.public_key === "string" ? fromB64u(f.public_key) : new Uint8Array();
    if (!inv || pk.byteLength !== 32 || !verify(pk, "pair", this.transport!.handshakeHash, this.challenge!, String(f.sig))) return this.fail();
    inv.used = true;
    this.device = deviceId(pk);
    devices.set(this.device, pk);
    this.send({ t: "res", id: 0, status: 200, body: { device_id: this.device } });
  }

  private req(f: any): void {
    const reply = (status: number, body?: unknown) => this.send({ t: "res", id: f.id, status, body });
    switch (`${f.method} ${f.path}`) {
      case "POST /probe/echo":
        return reply(200, f.body);
      case "POST /api/v1/stream": {
        reply(200, {});
        const rate = Number(f.body?.rate ?? 10);
        let seq = 0;
        this.timers.push(
          setInterval(() => this.send({ t: "ev", seq: ++seq, ts: Date.now(), entity: "probe", id: "x", op: "upsert", data: eventPad }), 1000 / rate),
        );
        return;
      }
      case "POST /probe/reset":
        eld.reset();
        rssBaseline = process.memoryUsage().rss;
        return reply(200, { rss: rssBaseline });
      case "GET /probe/stats":
        return reply(200, {
          sessions: sessionCount,
          rss: process.memoryUsage().rss,
          rss_increase: process.memoryUsage().rss - rssBaseline,
          eld_ms: { p50: eld.percentile(50) / 1e6, p99: eld.percentile(99) / 1e6, max: eld.max / 1e6 },
        });
      default:
        return reply(404);
    }
  }

  private send(frame: unknown): void {
    if (this.dead || !this.transport) return;
    for (const m of this.transport.seal(encodeJson(frame))) this.io.send(m);
  }

  fail(): void {
    if (this.dead) return;
    this.io.close("auth");
    this.end();
  }

  end(): void {
    if (this.dead) return;
    this.dead = true;
    sessionCount--;
    this.timers.forEach((t) => clearTimeout(t));
    this.transport?.destroy();
  }
}

function connectRelay(url: string): void {
  const ws = new WebSocket(`${url}/v1/hub?pk=${b64u(hubKey.publicKey)}`, {
    headers: { authorization: `Bearer ${process.env.RELAY_TOKEN ?? ""}` },
    maxPayload: MAX_NOISE + 5,
  });
  const sessions = new Map<number, Session>();
  ws.on("open", () => log("relay_up"));
  ws.on("message", (data) => {
    const env = decode(new Uint8Array(data as Buffer));
    if (!env) return;
    if (env.type === OPEN) {
      const sid = env.sid;
      sessions.set(
        sid,
        new Session({
          send: (b) => ws.send(encode(DATA, sid, b)),
          close: (reason) => {
            sessions.delete(sid);
            ws.send(encode(CLOSE, sid, json({ code: 4401, reason })));
          },
        }),
      );
      void parseJson(env.payload); // { ip_masked, ts } would go to device_audit
    } else if (env.type === DATA) sessions.get(env.sid)?.onMessage(env.payload);
    else {
      sessions.get(env.sid)?.end();
      sessions.delete(env.sid);
    }
  });
  ws.on("close", (code) => {
    log("relay_down", { code });
    for (const s of sessions.values()) s.end();
    setTimeout(() => connectRelay(url), 1000);
  });
  ws.on("error", () => {});
}

if (args.relay) connectRelay(args.relay);
if (args.direct) {
  const wss = new WebSocketServer({ port: Number(args.direct), host: args.host, maxPayload: MAX_NOISE });
  wss.on("connection", (ws) => {
    const s = new Session({ send: (b) => ws.send(b), close: () => ws.close(4401, "auth") });
    ws.on("message", (d) => s.onMessage(new Uint8Array(d as Buffer)));
    ws.on("close", () => s.end());
  });
  log("direct_listening", { port: Number(args.direct) });
}
log("hub_up", { pk: b64u(hubKey.publicKey) });
