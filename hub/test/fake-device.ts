// A device for tests: what the App will do (docs/tech/06 「认证」「配对」), written against protocol/ only.
// Ed25519 key via node:crypto, Noise initiator from protocol/noise, one WS per session to the relay's /v1/peer.
import { generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import { WebSocket } from "ws";
import { finishInitiator, startInitiator, type HubHello, type Transport } from "../../protocol/noise/channel.ts";
import { encodeFrame, parseFrame, type Frame } from "../../protocol/frames.ts";
import { AUTH_PREFIX, PAIR_PREFIX, b64u, deviceIdOf, fromB64u, signedBytes, type PairCode } from "../../protocol/pair.ts";

export type Role = "client" | "node";

export class DeviceKey {
  readonly priv: KeyObject;
  readonly pub: Uint8Array;
  readonly id: string;
  constructor() {
    const kp = generateKeyPairSync("ed25519");
    this.priv = kp.privateKey;
    this.pub = new Uint8Array(kp.publicKey.export({ format: "der", type: "spki" }).subarray(-32));
    this.id = deviceIdOf(this.pub);
  }
  sign(msg: Uint8Array): string { return b64u(new Uint8Array(sign(null, msg, this.priv))); }
}

/** One open channel: a WS to the relay with a finished Noise handshake. */
export class Channel {
  ws: WebSocket;
  t!: Transport;
  hello!: HubHello;
  frames: Frame[] = [];
  /** when each of `frames` arrived (performance.now()) */
  at: number[] = [];
  /** every raw WS message both ways, as the relay sees them on the device side */
  wire: Buffer[] = [];
  closed: Promise<{ code: number; reason: string }>;
  closedAt = 0;
  #waiters: (() => void)[] = [];
  #nextId = 1;

  constructor(ws: WebSocket) {
    this.ws = ws;
    this.closed = new Promise((res) => ws.on("close", (code, reason) => { this.closedAt = Date.now(); res({ code, reason: reason.toString() }); this.#wake(); }));
  }
  #wake() { for (const w of this.#waiters.splice(0)) w(); }

  /** Called with every incoming Noise message after the handshake. */
  onMessage(m: Buffer) {
    let bytes: Uint8Array | null;
    try { bytes = this.t.open(m); } catch { return; }
    if (bytes === null) return;
    const f = parseFrame(new TextDecoder().decode(bytes));
    if (f) { this.frames.push(f); this.at.push(performance.now()); this.#wake(); }
  }

  sendFrame(f: Frame) { for (const p of this.t.seal(new TextEncoder().encode(encodeFrame(f)))) this.raw(p); }
  raw(p: Uint8Array) { const b = Buffer.from(p); this.wire.push(b); this.ws.send(b); }

  async req(method: "GET" | "POST" | "PATCH" | "DELETE", path: string, body?: unknown, ms = 5000): Promise<{ status: number; body?: any }> {
    const id = this.#nextId++;
    this.sendFrame({ t: "req", id, method, path, ...(body === undefined ? {} : { body }) } as Frame);
    const end = Date.now() + ms;
    for (;;) {
      const r = this.frames.find((f) => f.t === "res" && f.id === id);
      if (r && r.t === "res") return { status: r.status, body: r.body };
      if (this.closedAt) throw new Error(`channel closed before res ${id}`);
      if (Date.now() > end) throw new Error(`no res ${id}`);
      await new Promise<void>((res) => { this.#waiters.push(res); setTimeout(res, 50); });
    }
  }

  close() { this.ws.close(1000); }
}

/**
 * Opens a WS to `peerUrl?hub=<hub_pk>`, runs Noise message 1/2. `hubPk` is what the device trusts (from the pairing
 * code); a relay that isn't connected to that hub's key can't finish the handshake.
 */
export function openChannel(peerUrl: string, hubPk: string, hello: { role: Role; purpose: "auth" | "pair"; v?: number }, headers: Record<string, string> = {}): Promise<Channel> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${peerUrl}?hub=${hubPk}`, { headers });
    const c = new Channel(ws);
    const { hs, message } = startInitiator(fromB64u(hubPk), { v: hello.v ?? 1, role: hello.role, purpose: hello.purpose });
    let done = false;
    ws.on("open", () => c.raw(message));
    ws.on("message", (d: Buffer) => {
      c.wire.push(Buffer.from(d));
      if (done) return c.onMessage(d);
      try {
        const r = finishInitiator(hs, new Uint8Array(d));
        c.t = r.transport; c.hello = r.hello; done = true;
        resolve(c);
      } catch (e) { reject(e); ws.terminate(); }
    });
    ws.on("unexpected-response", (_q, res) => { reject(new Error(`http ${res.statusCode}`)); ws.terminate(); });
    ws.on("error", (e) => { if (!done) reject(e); });
    // closed before message 2 (4404, 4401 …): report the code
    c.closed.then((x) => { if (!done) reject(Object.assign(new Error(`closed ${x.code}`), { code: x.code })); });
  });
}

/** The bytes the hub expects signed for this channel. */
export const authBytes = (c: Channel, prefix: typeof AUTH_PREFIX | typeof PAIR_PREFIX = AUTH_PREFIX) =>
  signedBytes(prefix, c.t.handshakeHash, fromB64u(c.hello.challenge));

/** Pairs with a code: handshake with purpose "pair", then the signed `pair` frame. Resolves once the hub answers. */
export async function pair(code: PairCode, key: DeviceKey, name = "测试手机", headers: Record<string, string> = {}): Promise<Channel> {
  const c = await openChannel(code.relay, code.hub_pk, { role: code.role, purpose: "pair" }, headers);
  c.sendFrame({ t: "pair", secret: code.secret, public_key: b64u(key.pub), name, platform: "android", sig: key.sign(authBytes(c, PAIR_PREFIX)) } as Frame);
  return c;
}

/** Reconnects as a paired device: purpose "auth", then `auth {device_id, sig}`. */
export async function auth(peerUrl: string, hubPk: string, key: DeviceKey, role: Role = "client", headers: Record<string, string> = {}): Promise<Channel> {
  const c = await openChannel(peerUrl, hubPk, { role, purpose: "auth" }, headers);
  c.sendFrame({ t: "auth", device_id: key.id, sig: key.sign(authBytes(c)) } as Frame);
  return c;
}

/** Waits until the channel answers a request (open) or is closed (refused). */
export async function settle(c: Channel, ms = 3000): Promise<"open" | { code: number; reason: string }> {
  const r = await Promise.race([
    c.req("GET", "/api/v1/status", undefined, ms).then(() => "open" as const, () => undefined),
    c.closed,
  ]);
  return r ?? (await c.closed);
}
