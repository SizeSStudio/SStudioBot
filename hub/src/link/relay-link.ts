// The hub's side of the relay (docs/tech/03 「link」, 06): one registered WS to wss://…/v1/hub carrying every
// session, multiplexed by sid. Reconnects with 1, 2, 5, 10, 30 s backoff. Off unless console.yaml relay.enabled;
// main.ts decides that. The relay is untrusted: a malformed envelope or an unknown sid is dropped, never trusted.
import { WebSocket, type RawData } from "ws";
import { CLOSE, DATA, ENVELOPE_MAX, OPEN, decodeEnvelope, encodeEnvelope, jsonPayload, readJsonPayload } from "../../../protocol/envelope.ts";
import type { Db } from "../db/db.ts";
import type { HubKey } from "./keys.ts";
import type { Paired } from "./pairing.ts";
import { C_REMOVED, Session, type Handler } from "./session.ts";
import type { Conn } from "../api/index.ts";
import { log } from "../log.ts";

const BACKOFF_S = [1, 2, 5, 10, 30];
/** Above this much unsent on the one relay WS, streams hold events and drop deltas (the relay pauses at 8 MiB) ※. */
const WRITABLE_MAX = 4 * 1024 * 1024;

export type RelayLinkOpts = {
  db: Db; hubKey: HubKey; handle: Handler;
  /** a channel ended (the api drops its streams) */
  closed?(conn: Conn): void;
  url: string;                      // console.yaml relay.url (…/v1/hub)
  token: string;                    // RELAY_TOKEN from secrets.env; sent as a header, never logged
  onPaired?(p: Paired): void;
  onNewIp?(deviceId: string, ipMasked: string): void;
};

export class RelayLink {
  #o: RelayLinkOpts;
  #ws: WebSocket | undefined;
  #sessions = new Map<number, Session>();
  #byDevice = new Map<string, Set<Session>>();
  #attempt = 0;
  #timer: NodeJS.Timeout | undefined;
  #stopped = false;
  connected = false;

  constructor(o: RelayLinkOpts) { this.#o = o; }

  start() { this.#stopped = false; this.#connect(); }

  /** Is any channel of this device open right now (the device list shows it). */
  online(deviceId: string) { return (this.#byDevice.get(deviceId)?.size ?? 0) > 0; }

  /** 06 删设备 step 2: close every channel of this device now. Returns how many. */
  dropDevice(deviceId: string): number {
    const set = [...(this.#byDevice.get(deviceId) ?? [])];
    for (const s of set) s.close(C_REMOVED, "removed");
    return set.length;
  }

  /** Tests and status. */
  sessions() { return this.#sessions.size; }

  async close() {
    this.#stopped = true;
    clearTimeout(this.#timer);
    const ws = this.#ws;
    if (!ws) return;
    await new Promise<void>((res) => {
      if (ws.readyState === WebSocket.CLOSED) return res();
      ws.once("close", () => res());
      ws.close(1001, "shutdown");
      setTimeout(() => { ws.terminate(); res(); }, 2000).unref();
    });
  }

  #connect() {
    if (this.#stopped) return;
    const ws = new WebSocket(this.#o.url, {
      headers: { authorization: `Bearer ${this.#o.token}`, "x-sbot-hub": this.#o.hubKey.publicB64u },
      maxPayload: ENVELOPE_MAX, perMessageDeflate: false, handshakeTimeout: 15_000,
    });
    this.#ws = ws;
    ws.on("open", () => {
      this.#attempt = 0;
      this.connected = true;
      log("link", "registered with the relay");
    });
    ws.on("unexpected-response", (_req, res) => {
      // 401: relay.yaml doesn't list this key with this token; 429/403: the relay is protecting itself
      log("link", "relay refused registration", { status: res.statusCode });
      ws.terminate();
    });
    ws.on("error", (e) => log("link", "relay connection error", { err: String((e as NodeJS.ErrnoException).code ?? "").slice(0, 40) }));
    ws.on("close", () => {
      if (this.#ws === ws) this.#ws = undefined;
      const was = this.connected;
      this.connected = false;
      // every session was a channel through this WS; they are gone with it
      for (const s of this.#sessions.values()) s.gone();
      this.#sessions.clear();
      this.#byDevice.clear();
      if (was) log("link", "relay connection lost");
      if (this.#stopped) return;
      const wait = BACKOFF_S[Math.min(this.#attempt++, BACKOFF_S.length - 1)]! * 1000;
      this.#timer = setTimeout(() => this.#connect(), wait);
      this.#timer.unref();
    });
    ws.on("message", (data: RawData, isBinary: boolean) => {
      const env = isBinary ? decodeEnvelope(data as Buffer) : null;
      if (!env) return;
      if (env.type === OPEN) this.#open(ws, env.sid, env.payload);
      else if (env.type === DATA) this.#sessions.get(env.sid)?.data(env.payload);
      else if (env.type === CLOSE) this.#forget(env.sid)?.gone();
    });
  }

  #open(ws: WebSocket, sid: number, payload: Uint8Array) {
    this.#forget(sid)?.gone();   // a reused sid: the old session is over
    let ipMasked = "unknown";
    try {
      const v = readJsonPayload(payload) as { ip_masked?: unknown };
      if (typeof v?.ip_masked === "string" && /^[0-9a-f.:]+\/\d{2}$/.test(v.ip_masked)) ipMasked = v.ip_masked;
    } catch { /* keep unknown */ }
    const s: Session = new Session({
      db: this.#o.db, hubKey: this.#o.hubKey, ipMasked, handle: this.#o.handle,
      send: (m) => { if (ws.readyState === WebSocket.OPEN) ws.send(encodeEnvelope(DATA, sid, m)); },
      writable: () => ws.readyState === WebSocket.OPEN && ws.bufferedAmount < WRITABLE_MAX,
      ended: (x) => this.#o.closed?.(x),
      close: (code, reason) => {
        this.#forget(sid);
        if (ws.readyState === WebSocket.OPEN) ws.send(encodeEnvelope(CLOSE, sid, jsonPayload({ code, reason })));
      },
      onOpen: (x) => {
        const id = x.who!.device_id;
        let set = this.#byDevice.get(id);
        if (!set) this.#byDevice.set(id, (set = new Set()));
        set.add(x);
      },
      onPaired: (p) => this.#o.onPaired?.(p),
      onNewIp: (id, ip) => this.#o.onNewIp?.(id, ip),
    });
    this.#sessions.set(sid, s);
  }

  /** Takes a session out of both indexes; returns it so the caller can end it. */
  #forget(sid: number): Session | undefined {
    const s = this.#sessions.get(sid);
    if (!s) return undefined;
    this.#sessions.delete(sid);
    const id = s.who?.device_id;
    if (id) {
      const set = this.#byDevice.get(id);
      set?.delete(s);
      if (set && !set.size) this.#byDevice.delete(id);
    }
    return s;
  }
}
