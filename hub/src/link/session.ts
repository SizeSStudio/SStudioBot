// One session = one Noise channel with one device (docs/tech/02 「Noise」, 06 「认证」「配对」). Transport-agnostic:
// the relay link feeds it Noise messages and gives it `send` / `close`; a direct connection later can do the same.
//   hello  → message 1 in, message 2 out carrying a fresh 32-byte challenge
//   auth   → the first frame must be `auth` (purpose "auth") or `pair` (purpose "pair"), signed over
//            prefix || handshake hash || challenge
//   open   → application frames; every `req` goes to the api dispatcher, which authorizes it first (roles.ts)
// Any failure before `open` closes with reason "auth" and says nothing about which step failed.
import { createPublicKey, randomBytes, verify } from "node:crypto";
import { PROTOCOL } from "../../../protocol/version.ts";
import { respond, NoiseProtocolError, type ClientHello, type Transport } from "../../../protocol/noise/channel.ts";
import { encodeFrame, parseFrame, type Auth, type Frame, type Pair, type Req } from "../../../protocol/frames.ts";
import { AUTH_PREFIX, CLOSE_AUTH, CLOSE_PROTOCOL, CLOSE_REMOVED, CLOSE_VERSION, PAIR_PREFIX, b64u, fromB64u, signedBytes } from "../../../protocol/pair.ts";
import type { Db } from "../db/db.ts";
import type { HubKey } from "./keys.ts";
import type { Role } from "./roles.ts";
import type { Caller } from "../api/authz.ts";
import type { Conn, Out } from "../api/index.ts";
import { audit, liveDevice, touchDevice } from "./devices.ts";
import { redeemInvite, type Paired } from "./pairing.ts";
import { log } from "../log.ts";

/** One `req` from an authenticated channel; `conn` is the session itself, for streams (api/pump.ts). */
export type Handler = (req: Req, caller: Caller, conn: Conn) => Promise<Out>;

// close codes the hub sends a device through the relay
export const C_AUTH = CLOSE_AUTH, C_REMOVED = CLOSE_REMOVED, C_PROTOCOL = CLOSE_PROTOCOL, C_VERSION = CLOSE_VERSION;
/** From OPEN to an authenticated channel; the relay separately gives the hub 10 s to send message 2. */
export const AUTH_MS = 10_000;

export type SessionDeps = {
  db: Db; hubKey: HubKey; ipMasked: string; handle: Handler;
  send(noiseMessage: Uint8Array): void;
  /** false = the transport under it is backed up (the pump then holds events, drops deltas) */
  writable(): boolean;
  close(code: number, reason: string): void;
  /** the session ended, either side; the link tells the api (closeConn) */
  ended(s: Session): void;
  onOpen(s: Session): void;          // authenticated: the link indexes it by device
  onPaired(p: Paired): void;
  onNewIp(deviceId: string, ipMasked: string): void;
};

const ED25519_SPKI = Buffer.from("302a300506032b6570032100", "hex");

/** Ed25519 over the domain-separated bytes. Anything malformed is just `false`. */
export function verifyEd25519(publicKey: Uint8Array, message: Uint8Array, sigB64u: string): boolean {
  try {
    const sig = fromB64u(sigB64u);
    if (publicKey.length !== 32 || sig.length !== 64) return false;
    const key = createPublicKey({ key: Buffer.concat([ED25519_SPKI, publicKey]), format: "der", type: "spki" });
    return verify(null, message, key, sig);
  } catch { return false; }
}

// a device names itself; keep it printable for lists and notices
const clean = (s: string, max: number) => s.replace(/[\u0000-\u001f\u007f\u2028\u2029]/g, "").trim().slice(0, max);

export class Session implements Conn {
  state: "hello" | "auth" | "open" | "closed" = "hello";
  who: Caller | undefined;
  #d: SessionDeps;
  #t: Transport | undefined;
  #client: ClientHello | undefined;
  #challenge = new Uint8Array(randomBytes(32));
  #timer: NodeJS.Timeout;

  constructor(d: SessionDeps) {
    this.#d = d;
    this.#timer = setTimeout(() => { if (this.state !== "open") this.#fail(); }, AUTH_MS);
    this.#timer.unref();
  }

  /** One Noise message from the device. */
  data(msg: Uint8Array) {
    if (this.state === "closed") return;
    if (this.state === "hello") return this.#hello(msg);
    let bytes: Uint8Array | null;
    try { bytes = this.#t!.open(msg); }
    catch { return this.state === "open" ? this.close(C_PROTOCOL, "protocol") : this.#fail(); }   // replay, tamper, reorder
    if (bytes === null) return;   // more pieces due
    let f: Frame | null;
    try { f = parseFrame(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
    catch { return this.state === "open" ? this.close(C_PROTOCOL, "protocol") : this.#fail(); }
    if (this.state === "auth") return this.#first(f);
    if (f?.t === "req") void this.#serve(f);
    // anything else from a device (unknown t, cancel before W2b streams) is ignored (02)
  }

  #hello(msg: Uint8Array) {
    try {
      const r = respond(this.#d.hubKey, msg, () => ({ v: PROTOCOL.current, challenge: b64u(this.#challenge), hub_time: Date.now() }));
      this.#t = r.transport;
      this.#client = r.client;
      if (r.client.v < PROTOCOL.min) return this.close(C_VERSION, "version");
      this.state = "auth";
      this.#d.send(r.reply);
    } catch (e) {
      if (!(e instanceof NoiseProtocolError)) log("link", "handshake error", { err: String((e as Error)?.message ?? e).slice(0, 120) });
      this.#fail();
    }
  }

  #first(f: Frame | null) {
    const c = this.#client!;
    if (f?.t === "auth" && c.purpose === "auth") return this.#auth(f, c.role);
    if (f?.t === "pair" && c.purpose === "pair") return this.#pair(f, c.role);
    this.#fail();
  }

  #auth(f: Auth, role: Role) {
    const dev = liveDevice(this.#d.db, f.device_id);
    const msg = signedBytes(AUTH_PREFIX, this.#t!.handshakeHash, this.#challenge);
    if (!dev || dev.role !== role || !verifyEd25519(dev.public_key, msg, f.sig)) {
      // a known device with a bad signature is worth a line; unknown ids are just noise from the internet
      if (dev) audit(this.#d.db, { device_id: f.device_id, action: "challenge_failed", actor: "code", ip_masked: this.#d.ipMasked });
      return this.#fail();
    }
    const newIp = touchDevice(this.#d.db, f.device_id, this.#d.ipMasked);
    this.#open({ device_id: f.device_id, role });
    if (newIp) this.#d.onNewIp(f.device_id, this.#d.ipMasked);
  }

  #pair(f: Pair, role: Role) {
    let pk: Uint8Array, secret: Uint8Array;
    try { pk = fromB64u(f.public_key); secret = fromB64u(f.secret); } catch { return this.#fail(); }
    // proof that the device holds the private key, bound to this channel, before the invite is touched
    if (!verifyEd25519(pk, signedBytes(PAIR_PREFIX, this.#t!.handshakeHash, this.#challenge), f.sig)) return this.#fail();
    const p = redeemInvite(this.#d.db, {
      secret, publicKey: pk, role, name: clean(f.name, 100) || "（没起名）", platform: clean(f.platform, 40), ipMasked: this.#d.ipMasked,
    });
    if (!p) return this.#fail();
    this.#open({ device_id: p.id, role });
    this.#d.onPaired(p);
  }

  #open(who: Caller) {
    clearTimeout(this.#timer);
    this.who = who;
    this.state = "open";
    this.#d.onOpen(this);
  }

  async #serve(req: Req) {
    const who = this.who!;
    let out: Out;
    try { out = await this.#d.handle(req, who, this); }
    catch (e) {
      log("link", "handler failed", { path: req.path, err: String((e as Error)?.message ?? e).slice(0, 200) });
      out = { status: 500, body: { error: "internal error" } };
    }
    this.send({ t: "res", id: req.id, status: out.status, ...(out.body === undefined ? {} : { body: out.body }), ...(out.seq === undefined ? {} : { seq: out.seq }) });
  }

  /** One application frame to the device (split into Noise messages as needed). Never throws (Conn). */
  send(f: Frame) {
    if (this.state !== "open" || !this.#t) return;
    for (const piece of this.#t.seal(new TextEncoder().encode(encodeFrame(f)))) this.#d.send(piece);
  }

  #fail() { this.close(C_AUTH, "auth"); }

  /** Ends it from our side: the relay gets CLOSE {code, reason} and closes the device's socket. */
  close(code: number, reason: string) {
    if (this.state === "closed") return;
    this.#end();
    this.#d.close(code, reason);
  }

  /** The device went away (CLOSE from the relay, or the relay WS dropped): nothing to send. */
  gone() { if (this.state !== "closed") this.#end(); }

  writable() { return this.state === "open" && this.#d.writable(); }

  #end() {
    const was = this.state;
    this.state = "closed";
    clearTimeout(this.#timer);
    this.#t?.destroy();
    this.#t = undefined;
    if (was === "open") this.#d.ended(this);
  }
}
