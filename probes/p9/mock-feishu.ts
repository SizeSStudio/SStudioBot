// A local stand-in for the parts of Feishu the harness touches, so dedupe, ack and reconnect logic can be tested
// without an app: the long-connection endpoint and a pbbp2 WebSocket (hand-coded protobuf, so the test does not
// reuse the SDK's own codec), tenant tokens, messages, CardKit, and an NDJSON event feed for a fake lark-cli.
// Everything here is invented data.
import http from "node:http";
import type net from "node:net";
import { WebSocketServer, WebSocket } from "ws";

// ---- pbbp2 frames ---------------------------------------------------------------------------------------------------

export type Frame = { SeqID: number; LogID: number; service: number; method: number; headers: { key: string; value: string }[]; payload: Buffer };

const varint = (n: number) => { const o: number[] = []; while (n >= 0x80) { o.push((n % 0x80) | 0x80); n = Math.floor(n / 0x80); } o.push(n); return Buffer.from(o); };
const tag = (f: number, w: number) => varint(f * 8 + w);
const lenField = (f: number, b: Buffer) => Buffer.concat([tag(f, 2), varint(b.length), b]);

export function encodeFrame(f: Frame): Buffer {
  const parts = [tag(1, 0), varint(f.SeqID), tag(2, 0), varint(f.LogID), tag(3, 0), varint(f.service), tag(4, 0), varint(f.method)];
  for (const h of f.headers) parts.push(lenField(5, Buffer.concat([lenField(1, Buffer.from(h.key)), lenField(2, Buffer.from(h.value))])));
  parts.push(lenField(8, f.payload));
  return Buffer.concat(parts);
}

function readVarint(b: Buffer, p: { i: number }): number {
  let r = 0, m = 1;
  for (;;) { const c = b[p.i++]!; r += (c & 0x7f) * m; if (c < 0x80) return r; m *= 0x80; }
}

export function decodeFrame(b: Buffer): Frame {
  const f: Frame = { SeqID: 0, LogID: 0, service: 0, method: 0, headers: [], payload: Buffer.alloc(0) };
  const p = { i: 0 };
  while (p.i < b.length) {
    const t = readVarint(b, p), field = Math.floor(t / 8), wire = t % 8;
    if (wire === 0) { const v = readVarint(b, p); if (field === 1) f.SeqID = v; else if (field === 2) f.LogID = v; else if (field === 3) f.service = v; else if (field === 4) f.method = v; }
    else if (wire === 2) {
      const len = readVarint(b, p), body = b.subarray(p.i, p.i + len); p.i += len;
      if (field === 8) f.payload = Buffer.from(body);
      else if (field === 5) {
        const h = { key: "", value: "" }, q = { i: 0 };
        while (q.i < body.length) { const tt = readVarint(body, q), l = readVarint(body, q), s = body.subarray(q.i, q.i + l).toString(); q.i += l; if (Math.floor(tt / 8) === 1) h.key = s; else h.value = s; }
        f.headers.push(h);
      }
    } else throw new Error(`unexpected wire type ${wire}`);
  }
  return f;
}

// ---- the mock ---------------------------------------------------------------------------------------------------------

export type Ack = { messageId: string; at: number; code: number; data?: any };

export class MockFeishu {
  port = 0;
  appId = "cli_" + "ab".repeat(8);
  tokenFails = false;           // tenant_access_token answers HTTP 400 (the SDK then logs the failed axios request)
  endpointFails = false;        // the long-connection endpoint answers HTTP 500
  refuseUpgrade = false;        // the WebSocket handshake is refused (network cut seen from the app)
  online = 0;                   // answer for /event/v1/connection
  pingIntervalS = 1;
  rateLimitPerSec = 0;          // 0 = off; otherwise CardKit content updates beyond this per second get HTTP 429 / 99991400
  requests: { method: string; route: string; body?: any }[] = [];
  chat: { message_id: string; create_time: string; sender: { sender_type: string } }[] = [];
  connects = 0;
  lastMsgId = "";               // id handed out by the last POST /im/v1/messages
  private server = http.createServer((q, s) => void this.onHttp(q, s));
  private wss = new WebSocketServer({ noServer: true });
  private sockets = new Set<net.Socket>();
  private conns = new Set<WebSocket>();
  private acks = new Map<string, Ack>();
  private waiters = new Map<string, (a: Ack) => void>();
  private cards = new Map<string, { seq: number; content: string }>();
  private msgs = new Map<string, string>();
  private feeds = new Map<string, Set<http.ServerResponse>>();
  private n = 0;
  private win: number[] = [];

  async listen() {
    this.server.on("connection", (s) => { this.sockets.add(s); s.on("close", () => this.sockets.delete(s)); });
    this.server.on("upgrade", (req, sock, head) => {
      if (this.refuseUpgrade) { sock.end("HTTP/1.1 503 Service Unavailable\r\n\r\n"); return; }
      this.wss.handleUpgrade(req, sock, head, (ws) => this.onWs(ws));
    });
    await new Promise<void>((r) => this.server.listen(0, "127.0.0.1", r));
    this.port = (this.server.address() as net.AddressInfo).port;
    return this;
  }
  get domain() { return `http://127.0.0.1:${this.port}`; }
  async close() {
    for (const c of this.conns) c.terminate();
    for (const s of this.sockets) s.destroy();
    await new Promise<void>((r) => this.server.close(() => r()));
  }

  // -- WebSocket side --
  private onWs(ws: WebSocket) {
    this.connects++; this.conns.add(ws);
    ws.on("close", () => this.conns.delete(ws));
    ws.on("error", () => {});
    ws.on("message", (raw) => {
      const f = decodeFrame(Buffer.from(raw as Buffer));
      const h = Object.fromEntries(f.headers.map((x) => [x.key, x.value]));
      if (f.method === 0 && h.type === "ping") {
        const cfg = { PingInterval: this.pingIntervalS, ReconnectCount: -1, ReconnectInterval: 1, ReconnectNonce: 0 };
        ws.send(encodeFrame({ ...f, headers: [{ key: "type", value: "pong" }], payload: Buffer.from(JSON.stringify(cfg)) }));
      } else if (f.method === 1) {
        const body = JSON.parse(f.payload.toString());
        const ack: Ack = { messageId: h.message_id!, at: Date.now(), code: body.code, data: body.data ? JSON.parse(Buffer.from(body.data, "base64").toString()) : undefined };
        this.acks.set(ack.messageId, ack);
        this.waiters.get(ack.messageId)?.(ack);
      }
    });
  }
  get clients() { return this.conns.size; }
  dropConnections() { for (const c of this.conns) c.terminate(); }

  /** Push one schema-2.0 event the way Feishu does; `fragments` > 1 splits the payload over several frames. */
  push(eventType: string, event: unknown, o: { eventId?: string; createTimeMs?: number; fragments?: number } = {}): { messageId: string; eventId: string } {
    const eventId = o.eventId ?? `ev-${++this.n}`;
    const body = Buffer.from(JSON.stringify({ schema: "2.0", header: { event_id: eventId, token: "verif", create_time: String(o.createTimeMs ?? Date.now()), event_type: eventType, tenant_key: "t1", app_id: this.appId }, event }));
    const messageId = `mf-${++this.n}`, sum = o.fragments ?? 1, size = Math.ceil(body.length / sum);
    const ws = [...this.conns][0];
    if (!ws) throw new Error("no client connected");
    for (let i = 0; i < sum; i++) {
      const hs = [["type", "event"], ["message_id", messageId], ["sum", String(sum)], ["seq", String(i)], ["trace_id", "tr"]].map(([key, value]) => ({ key: key!, value: value! }));
      ws.send(encodeFrame({ SeqID: i, LogID: 1, service: 7, method: 1, headers: hs, payload: body.subarray(i * size, (i + 1) * size) }));
    }
    return { messageId, eventId };
  }
  pushClick(o: { eventId?: string; operator?: string | null; messageId: string; createTimeMs?: number }) {
    const operator = o.operator === null ? {} : { open_id: o.operator ?? "ou_mock", user_id: "u1" };
    return this.push("card.action.trigger", { operator, token: "c-upd", action: { value: { k: "p9", t: 50 }, tag: "button" }, host: "im_message",
      context: { open_message_id: o.messageId, open_chat_id: "oc_mock" } }, o);
  }
  pushMessage(o: { eventId?: string; messageId?: string; createTimeMs?: number } = {}) {
    const mid = o.messageId ?? `om_m${++this.n}`;
    return { ...this.push("im.message.receive_v1", { sender: { sender_id: { open_id: "ou_mock" }, sender_type: "user" }, message: { message_id: mid, chat_id: "oc_mock", create_time: String(o.createTimeMs ?? Date.now()), message_type: "text", content: "{}" } }, o), mid };
  }
  waitAck(messageId: string, ms = 5000): Promise<Ack> {
    const have = this.acks.get(messageId);
    if (have) return Promise.resolve(have);
    return new Promise((res, rej) => {
      const t = setTimeout(() => rej(new Error("no ack")), ms);
      this.waiters.set(messageId, (a) => { clearTimeout(t); res(a); });
    });
  }
  /** a line for the fake lark-cli's `event consume` (NDJSON, the CLI's flattened shape) */
  feed(key: string, obj: unknown) { for (const r of this.feeds.get(key) ?? []) r.write(JSON.stringify(obj) + "\n"); }
  get feedClients() { return [...this.feeds.values()].reduce((a, s) => a + s.size, 0); }
  cardContent(id: string) { return this.msgs.get(id); }
  cardSeq(id: string) { return this.cards.get(id)?.seq; }

  // -- HTTP side --
  private async onHttp(q: http.IncomingMessage, s: http.ServerResponse) {
    const chunks: Buffer[] = [];
    for await (const c of q) chunks.push(c as Buffer);
    let body: any; try { body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : undefined; } catch {}
    const u = new URL(q.url!, "http://x"), path = u.pathname, m = q.method!;
    const route = path.replace(/\/(?:om|oc)_[^/]+/g, "/:id").replace(/\/\d{6,}/g, "/:id");
    this.requests.push({ method: m, route, body });
    const json = (o: unknown, status = 200) => { s.writeHead(status, { "content-type": "application/json" }); s.end(JSON.stringify(o)); };
    const ok = (data?: unknown) => json({ code: 0, msg: "success", data });

    if (path === "/__fake/events") {
      const key = u.searchParams.get("key")!;
      s.writeHead(200, { "content-type": "application/x-ndjson" }); s.write("\n");
      const set = this.feeds.get(key) ?? new Set(); set.add(s); this.feeds.set(key, set);
      q.on("close", () => set.delete(s));
      return;
    }
    if (path === "/callback/ws/endpoint" && m === "POST") {
      if (this.endpointFails) return json({ code: 1000040, msg: "busy" }, 500);
      return json({ code: 0, msg: "ok", data: { URL: `ws://127.0.0.1:${this.port}/ws?device_id=d1&service_id=7`,
        ClientConfig: { PingInterval: this.pingIntervalS, ReconnectCount: -1, ReconnectInterval: 1, ReconnectNonce: 0 } } });
    }
    if (path === "/open-apis/auth/v3/tenant_access_token/internal") {
      if (this.tokenFails) return json({ code: 10003, msg: "invalid param" }, 400);
      return json({ code: 0, msg: "ok", tenant_access_token: "t-mocktoken0123456789", expire: 7200 });
    }
    if (path === "/open-apis/event/v1/connection") return ok({ online_instance_cnt: this.online });
    if (path === "/open-apis/im/v1/messages" && m === "POST") { const id = `om_c${++this.n}`; this.msgs.set(id, body?.content ?? ""); this.lastMsgId = id; return ok({ message_id: id }); }
    if (path === "/open-apis/im/v1/messages" && m === "GET") return ok({ items: this.chat.map((c) => ({ ...c, chat_id: "oc_mock" })), has_more: false });
    const one = /^\/open-apis\/im\/v1\/messages\/([^/]+)$/.exec(path);
    if (one && m === "PATCH") { this.msgs.set(one[1]!, body?.content ?? ""); return ok(); }
    if (one && m === "GET") return ok({ items: [{ body: { content: this.msgs.get(one[1]!) ?? "" } }] });
    if (path === "/open-apis/cardkit/v1/cards" && m === "POST") { const id = String(7_000_000_000 + ++this.n); this.cards.set(id, { seq: 0, content: "" }); return ok({ card_id: id }); }
    const el = /^\/open-apis\/cardkit\/v1\/cards\/(\d+)\/(elements\/[^/]+\/content|settings)$/.exec(path);
    if (el) {
      const card = this.cards.get(el[1]!);
      if (!card) return json({ code: 300301, msg: "card not found" }, 400);
      if (this.rateLimitPerSec) {
        const now = Date.now(); this.win = this.win.filter((t) => now - t < 1000);
        if (this.win.length >= this.rateLimitPerSec) return json({ code: 99991400, msg: "request trigger frequency limit" }, 429);
        this.win.push(now);
      }
      if (!(body?.sequence > card.seq)) return json({ code: 300317, msg: "sequence number compare failed" }, 400);
      card.seq = body.sequence;
      return ok();
    }
    json({ code: 404, msg: "no such mock route" }, 404);
  }
}

export { WebSocket };
