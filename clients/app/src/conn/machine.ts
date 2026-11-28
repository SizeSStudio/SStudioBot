// The connection state machine (07 「连接」): WS → Noise NK → auth or pair → meta → bootstrap → stream, and back
// round after a drop. Plain TS with every platform piece injected (socket, signer, timers), so the same code runs on
// Android, in Electron's renderer and under node --test against the hub's real dispatcher.
//
//   unpaired ─start(pair)─▶ connecting ─open─▶ handshake ─msg2─▶ auth ─res(meta)─▶ sync ─res(stream)─▶ live
//        ▲                        ▲                                                              │
//        └── auth_failed          └──── retry / waiting_hub (4404) ◀── close / error / timeout ◀─┘
//
// - A failed auth is a CLOSE with reason "auth" (06): the key or the device is gone, so it doesn't retry; pair again.
// - After a drop, `after` is the store's cursor: the newest `ev.seq` / `beat.seq` (02), so nothing is skipped and a
//   replayed `ev` is dropped by seq. A `reset` frame clears the store and bootstraps again on the same connection.
// - Reads only in W2: pending requests fail on a drop; W3 adds the write queue with `client_op_id`.
import { sha256 } from "@noble/hashes/sha2.js";
import { finishInitiator, startInitiator, type Transport } from "../../../../protocol/noise/channel.ts";
import { encodeFrame, parseFrame, type Frame, type Req, type Res } from "../../../../protocol/frames.ts";
import { PROTOCOL } from "../../../../protocol/version.ts";
import { CLOSE_HUB_OFFLINE } from "../../../../protocol/envelope.ts";
import { MetaRes } from "../../../../protocol/api/meta.ts";
import { BootstrapRes, StreamRes } from "../../../../protocol/api/stream.ts";
import { AUTH_CLOSE_REASON, b64uDecode, b64uEncode, CHALLENGE_BYTES, peerUrl, type PairCode, type SigPurpose } from "../../../../protocol/link.ts";
import type { Store } from "../store/store.ts";
import { Backoff } from "./backoff.ts";

/** What the browser / RN WebSocket gives; tests pass a fake. */
export interface SocketLike {
  binaryType: string;
  send(data: Uint8Array): void;
  close(code?: number, reason?: string): void;
  onopen: (() => void) | null;
  onmessage: ((e: { data: unknown }) => void) | null;
  onclose: ((e: { code: number; reason: string }) => void) | null;
  onerror: ((e: unknown) => void) | null;
}

/** The device key, wherever it lives (Keystore, Electron main). Strings are base64url. */
export interface Signer {
  publicKey(): Promise<string>;
  sign(handshakeHash: string, challenge: string, purpose: SigPurpose): Promise<string>;
}

/** What is kept after pairing (07: the only connection data written to disk, in the platform's own store). */
export type Pairing = { hub_pk: string; relay: string; device_id: string; role: "client" | "node" };
export type PairRequest = { code: PairCode; name: string; platform: string };

export type ConnState =
  | { s: "idle" }
  | { s: "connecting"; pairing: boolean }
  | { s: "handshake" }
  | { s: "auth" }
  | { s: "sync" }
  | { s: "live" }
  | { s: "retry"; at: number; why: string }
  | { s: "waiting_hub"; at: number }
  | { s: "auth_failed" }
  | { s: "pair_failed"; why: string }
  | { s: "upgrade"; min: number }
  | { s: "stopped" };

export interface ConnDeps {
  openSocket(url: string): SocketLike;
  signer: Signer;
  store: Store;
  /** persist the pairing once the hub accepted the pair frame (its first `res` proves it) */
  onPaired?(p: Pairing): void | Promise<void>;
  setTimeout?: (fn: () => void, ms: number) => unknown;
  clearTimeout?: (t: unknown) => void;
  now?: () => number;
  /** handshake + auth + meta must finish within this (the relay itself gives the hub 10 s for message 2) */
  setupTimeoutMs?: number;
}

type Pending = { resolve: (r: Res) => void; reject: (e: Error) => void };

export class Connection {
  state: ConnState = { s: "idle" };
  readonly #d: Required<Omit<ConnDeps, "onPaired">> & Pick<ConnDeps, "onPaired">;
  readonly #backoff = new Backoff();
  #subs = new Set<(s: ConnState) => void>();
  #target: { pairing: Pairing } | { pair: PairRequest } | null = null;
  #sock: SocketLike | null = null;
  #transport: Transport | null = null;
  #hs: ReturnType<typeof startInitiator>["hs"] | null = null;
  #nextId = 1;
  #pending = new Map<number, Pending>();
  #timer: unknown = null;
  #setupTimer: unknown = null;
  #expanded = new Set<string>();
  #gen = 0; // bumps per socket, so a late callback from an old socket does nothing

  constructor(d: ConnDeps) {
    this.#d = {
      setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
      clearTimeout: (t) => globalThis.clearTimeout(t as ReturnType<typeof setTimeout>),
      now: Date.now,
      setupTimeoutMs: 15_000,
      ...d,
    };
  }

  subscribe(fn: (s: ConnState) => void): () => void { this.#subs.add(fn); return () => this.#subs.delete(fn); }

  /** Connect with a stored pairing, or pair with a fresh code. Replaces whatever was running. */
  start(target: { pairing: Pairing } | { pair: PairRequest }): void {
    this.#teardown();
    this.#target = target;
    this.#backoff.reset();
    this.#connect();
  }

  stop(): void { this.#teardown(); this.#target = null; this.#set({ s: "stopped" }); }

  /** Skip the wait (a "retry now" button, the app coming back to the foreground). */
  retryNow(): void {
    if (this.state.s === "retry" || this.state.s === "waiting_hub") { this.#clearTimer(); this.#connect(); }
  }

  get live(): boolean { return this.state.s === "live"; }

  request(method: Req["method"], path: string, opts: { query?: Record<string, string>; body?: unknown } = {}): Promise<Res> {
    if (!this.#transport || (this.state.s !== "live" && this.state.s !== "sync")) return Promise.reject(new Error("not connected"));
    return this.#req(method, path, opts);
  }

  /** Tool items stream only to connections that expanded them (02); remembered so a reconnect re-expands. */
  async expand(item: string): Promise<void> {
    this.#expanded.add(item);
    if (this.live) await this.#req("POST", "/api/v1/stream/expand", { body: { item } }).catch(() => {});
  }
  async collapse(item: string): Promise<void> {
    this.#expanded.delete(item);
    if (this.live) await this.#req("POST", "/api/v1/stream/collapse", { body: { item } }).catch(() => {});
  }

  // ── the steps ─────────────────────────────────────────────────────────────────────────────────────────────
  #connect(): void {
    const t = this.#target;
    if (!t) return;
    const hubPk = "pairing" in t ? t.pairing.hub_pk : t.pair.code.hub_pk;
    const relay = "pairing" in t ? t.pairing.relay : t.pair.code.relay;
    const gen = ++this.#gen;
    this.#set({ s: "connecting", pairing: "pair" in t });
    let sock: SocketLike;
    try { sock = this.#d.openSocket(peerUrl(relay, hubPk)); } catch (e) { this.#afterLoss(`open: ${String(e)}`); return; }
    this.#sock = sock;
    sock.binaryType = "arraybuffer";
    this.#setupTimer = this.#d.setTimeout(() => this.#fail(gen, "setup timed out"), this.#d.setupTimeoutMs);
    sock.onopen = () => {
      if (gen !== this.#gen) return;
      try {
        const { hs, message } = startInitiator(b64uDecode(hubPk), { v: PROTOCOL.current, role: "client", purpose: "pair" in t ? "pair" : "auth" });
        this.#hs = hs;
        this.#set({ s: "handshake" });
        sock.send(message);
      } catch (e) { this.#fail(gen, `handshake: ${String(e)}`); }
    };
    sock.onmessage = (e) => { if (gen === this.#gen) void this.#onMessage(gen, toBytes(e.data)); };
    sock.onerror = () => {}; // onclose follows and carries the code
    sock.onclose = (e) => { if (gen === this.#gen) this.#onClose(e.code, e.reason); };
  }

  async #onMessage(gen: number, bytes: Uint8Array | null): Promise<void> {
    try {
      if (!bytes) throw new Error("text message on a binary channel");
      if (this.#hs) return await this.#onHubHello(gen, bytes);
      if (!this.#transport) throw new Error("data before handshake");
      const whole = this.#transport.open(bytes);
      if (!whole) return;
      const f = parseFrame(new TextDecoder("utf-8", { fatal: true }).decode(whole));
      if (f) this.#onFrame(gen, f);
    } catch (e) {
      this.#fail(gen, `protocol: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  async #onHubHello(gen: number, msg2: Uint8Array): Promise<void> {
    const t = this.#target!;
    const { transport, hello } = finishInitiator(this.#hs!, msg2);
    this.#hs = null;
    this.#transport = transport;
    // the hub may say its own minimum here (02 「版本」); meta below says it for sure
    const min = (hello as { min?: unknown }).min;
    if (typeof min === "number" && min > PROTOCOL.current) return this.#upgrade(gen, min);
    const challenge = b64uDecode(hello.challenge);
    if (challenge.length !== CHALLENGE_BYTES) throw new Error("bad challenge");
    const hash = b64uEncode(transport.handshakeHash);
    this.#set({ s: "auth" });
    if ("pairing" in t) {
      const sig = await this.#d.signer.sign(hash, hello.challenge, "auth");
      if (gen !== this.#gen) return;
      this.#send({ t: "auth", device_id: t.pairing.device_id, sig });
    } else {
      const public_key = await this.#d.signer.publicKey();
      const sig = await this.#d.signer.sign(hash, hello.challenge, "pair");
      if (gen !== this.#gen) return;
      const p = t.pair;
      this.#send({ t: "pair", secret: p.code.secret, public_key, name: p.name.slice(0, 100), platform: p.platform.slice(0, 40), sig });
    }
    // auth/pair has no reply of its own: the first `res` on this channel is the proof (a failure is a CLOSE "auth")
    const meta = await this.#req("GET", "/api/v1/meta");
    if (gen !== this.#gen) return;
    if (meta.status !== 200) throw new Error(`meta ${meta.status}`);
    const m = MetaRes.parse(meta.body);
    if (m.protocol.min > PROTOCOL.current) return this.#upgrade(gen, m.protocol.min);
    if ("pair" in t) {
      const public_key = await this.#d.signer.publicKey();
      const pairing: Pairing = { hub_pk: t.pair.code.hub_pk, relay: t.pair.code.relay, device_id: deviceIdOf(public_key), role: t.pair.code.role };
      await this.#d.onPaired?.(pairing);
      if (gen !== this.#gen) return;
      this.#target = { pairing }; // a later reconnect authenticates; the pairing secret is spent
    }
    this.#d.clearTimeout(this.#setupTimer);
    this.#set({ s: "sync" });
    await this.#sync(gen, !this.#d.store.loaded);
  }

  /** bootstrap (when the store is empty or was reset) → stream { after } → live */
  async #sync(gen: number, bootstrap: boolean): Promise<void> {
    const store = this.#d.store;
    if (bootstrap) {
      const b = await this.#req("POST", "/api/v1/bootstrap", { body: {} });
      if (gen !== this.#gen) return;
      if (b.status !== 200) throw new Error(`bootstrap ${b.status}`);
      store.bootstrap(BootstrapRes.parse(b.body));
    }
    const s = await this.#req("POST", "/api/v1/stream", { body: { after: store.seq } });
    if (gen !== this.#gen) return;
    if (s.status !== 200) throw new Error(`stream ${s.status}`);
    if (StreamRes.parse(s.body).reset) return; // a `reset` frame follows; #onFrame bootstraps again
    this.#backoff.reset();
    this.#set({ s: "live" });
    for (const item of this.#expanded) void this.#req("POST", "/api/v1/stream/expand", { body: { item } }).catch(() => {});
  }

  #onFrame(gen: number, f: Frame): void {
    const store = this.#d.store;
    switch (f.t) {
      case "res": {
        const p = this.#pending.get(f.id);
        if (p) { this.#pending.delete(f.id); p.resolve(f); }
        return;
      }
      case "ev": store.ev(f); return;
      case "delta": store.delta(f); return;
      case "snapshot": store.snapshot(f); return;
      case "beat": store.beat(f.seq); return;
      case "reset":
        store.reset();
        this.#set({ s: "sync" });
        void this.#sync(gen, true).catch((e) => this.#fail(gen, `resync: ${String(e)}`));
        return;
      default:
        return; // auth / pair / req / cancel from the hub mean nothing to a client in W2
    }
  }

  #onClose(code: number, reason: string): void {
    const was = this.state.s;
    this.#dropSocket();
    if (!this.#target) return;
    if (reason === AUTH_CLOSE_REASON) {
      if ("pair" in this.#target) return this.#set({ s: "pair_failed", why: "hub refused the code (used, expired, or not this hub)" });
      return this.#set({ s: "auth_failed" });
    }
    if (code === CLOSE_HUB_OFFLINE) return this.#schedule("waiting_hub", "hub offline");
    this.#afterLoss(`closed ${code}${reason ? ` ${reason}` : ""} in ${was}`);
  }

  #upgrade(gen: number, min: number): void {
    if (gen !== this.#gen) return;
    const target = this.#target;
    this.#teardown();
    this.#target = target;
    this.#set({ s: "upgrade", min });
  }

  /** a protocol error on this socket: close it and retry later */
  #fail(gen: number, why: string): void {
    if (gen !== this.#gen) return;
    this.#dropSocket();
    this.#afterLoss(why);
  }

  /** the socket is gone (already dropped): decide between retrying and giving up */
  #afterLoss(why: string): void {
    if (!this.#target) return;
    if ("pair" in this.#target && this.state.s !== "connecting") {
      // a pairing code is single-use: once it went out, retrying with it can only fail
      if (this.state.s === "auth" || this.state.s === "sync") return this.#set({ s: "pair_failed", why });
    }
    this.#schedule("retry", why);
  }

  #schedule(kind: "retry" | "waiting_hub", why: string): void {
    const ms = this.#backoff.next();
    const at = this.#d.now() + ms;
    this.#set(kind === "retry" ? { s: "retry", at, why } : { s: "waiting_hub", at });
    this.#clearTimer();
    this.#timer = this.#d.setTimeout(() => { this.#timer = null; this.#connect(); }, ms);
  }

  // ── plumbing ──────────────────────────────────────────────────────────────────────────────────────────────
  #req(method: Req["method"], path: string, opts: { query?: Record<string, string>; body?: unknown } = {}): Promise<Res> {
    const id = this.#nextId++;
    return new Promise<Res>((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
      try {
        this.#send({ t: "req", id, method, path, ...(opts.query ? { query: opts.query } : {}), ...(opts.body !== undefined ? { body: opts.body } : {}) });
      } catch (e) { this.#pending.delete(id); reject(e instanceof Error ? e : new Error(String(e))); }
    });
  }

  #send(f: Frame): void {
    const sock = this.#sock, tr = this.#transport;
    if (!sock || !tr) throw new Error("not connected");
    for (const piece of tr.seal(new TextEncoder().encode(encodeFrame(f)))) sock.send(piece);
  }

  #dropSocket(): void {
    this.#d.clearTimeout(this.#setupTimer);
    this.#setupTimer = null;
    const sock = this.#sock;
    this.#sock = null;
    this.#transport?.destroy();
    this.#transport = null;
    this.#hs = null;
    this.#gen++;
    for (const p of this.#pending.values()) p.reject(new Error("disconnected"));
    this.#pending.clear();
    this.#nextId = 1;
    if (sock) {
      sock.onopen = sock.onmessage = sock.onerror = null;
      sock.onclose = null;
      try { sock.close(1000, "bye"); } catch { /* already closed */ }
    }
  }

  #teardown(): void { this.#clearTimer(); this.#dropSocket(); }
  #clearTimer(): void { if (this.#timer !== null) { this.#d.clearTimeout(this.#timer); this.#timer = null; } }

  #set(s: ConnState): void {
    this.state = s;
    for (const fn of this.#subs) fn(s);
  }
}

export function deviceIdOf(publicKeyB64u: string): string {
  return [...sha256(b64uDecode(publicKeyB64u))].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function toBytes(data: unknown): Uint8Array | null {
  if (data instanceof Uint8Array) return data;
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  return null;
}
