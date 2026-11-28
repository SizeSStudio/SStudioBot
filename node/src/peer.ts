// One connection to the hub, whatever carries it (local: length-prefixed frames on hub.sock; remote: Noise over the
// relay's WebSocket). Requests go both ways on it (02): the node's own (hello, events, permissions, tool calls …)
// and the hub's (sessions, turns, answers …), each `res` matched by id; a `cancel` from the hub aborts that request.
import { encodeFrame, parseFrame, type Frame, type Req, type Res } from "../../protocol/frames.ts";

export type Serve = (req: Req, signal: AbortSignal) => Promise<{ status: number; body?: unknown }>;

export class Peer {
  #send: (text: string) => void;
  #close: () => void;
  #next = 1;
  #wait = new Map<number, { ok: (r: Res) => void; fail: (e: Error) => void; timer?: NodeJS.Timeout }>();
  #running = new Map<number, AbortController>();
  #serve: Serve;
  closed = false;

  constructor(send: (text: string) => void, close: () => void, serve: Serve) {
    this.#send = send;
    this.#close = close;
    this.#serve = serve;
  }

  /** Every application frame from the hub. A frame that doesn't parse ends the connection (it is not the hub). */
  onText(text: string) {
    let f: Frame | null;
    try { f = parseFrame(text); } catch { f = null; }
    if (!f) { this.close(); return; }
    if (f.t === "res") {
      const w = this.#wait.get(f.id);
      if (!w) return;
      this.#wait.delete(f.id);
      if (w.timer) clearTimeout(w.timer);
      w.ok(f);
    } else if (f.t === "req") {
      const ac = new AbortController();
      this.#running.set(f.id, ac);
      const id = f.id;
      this.#serve(f, ac.signal).then(
        (r) => this.#reply(id, r.status, r.body),
        (e) => this.#reply(id, 500, { error: String((e as Error)?.message ?? e).slice(0, 300) }),
      ).finally(() => this.#running.delete(id));
    } else if (f.t === "cancel") {
      this.#running.get(f.id)?.abort();
      this.#running.delete(f.id);
    }
  }

  #reply(id: number, status: number, body?: unknown) {
    if (this.closed) return;
    this.#send(encodeFrame({ t: "res", id, status, ...(body === undefined ? {} : { body: body as never }) }));
  }

  request(method: Req["method"], path: string, body?: unknown, timeoutMs = 30_000): Promise<Res> {
    if (this.closed) return Promise.reject(new Error("和主的连接断了"));
    const id = this.#next++;
    return new Promise((ok, fail) => {
      const timer = timeoutMs > 0 ? setTimeout(() => { this.#wait.delete(id); fail(new Error("主没回应")); }, timeoutMs) : undefined;
      timer?.unref();
      this.#wait.set(id, { ok, fail, ...(timer ? { timer } : {}) });
      this.#send(encodeFrame({ t: "req", id, method, path, ...(body === undefined ? {} : { body: body as never }) }));
    });
  }

  /** The transport ended: every request in flight fails, every hub request in progress is aborted. */
  ended() {
    if (this.closed) return;
    this.closed = true;
    for (const w of this.#wait.values()) { if (w.timer) clearTimeout(w.timer); w.fail(new Error("和主的连接断了")); }
    this.#wait.clear();
    for (const ac of this.#running.values()) ac.abort();
    this.#running.clear();
  }

  close() { this.#close(); this.ended(); }
}
