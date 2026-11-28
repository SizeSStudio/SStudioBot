// The event pump (03 「api」, DESIGN §触6.4). Every connection that opened a stream has its own cursor into
// change_log; every tick (100 ms, or sooner after a kick) each writable stream reads seq > cursor in batches, merges
// one entity's changes inside a batch into one `ev` carrying the last seq, fills `data` from the view function at
// send time, and advances the cursor past what the role may not see. So an `ev` is "this is how it looks now":
// replays are harmless, and a stream that resumes from any seq it was sent misses nothing.
//
// Order per stream: fill in seq > after → `snapshot` of what is being written → live. Slow connection
// (`writable()` false): durable events wait (the cursor stays, they're read later), deltas are dropped and the item is
// marked for a `snapshot` once the connection is caught up again. No unbounded buffer anywhere.
//
// Live text (`delta`) never touches the DB: the dispatcher's onItem feeds it here (main.ts). An assistant message's
// deltas go to every client stream; a tool item's only to streams that expanded it.
import type { Frame } from "../../../protocol/frames.ts";
import type { StreamRes } from "../../../protocol/api/stream.ts";
import { needsReset, type Db } from "../db/db.ts";
import type { ItemEvent } from "../runner/types.ts";
import { log } from "../log.ts";
import { assistantKey, headSeq, isEntity, view, visibleTo } from "./views.ts";
import type { Caller } from "./authz.ts";

/** One connection, as the link (W2a) gives it to the api. */
export interface Conn {
  /** queue one frame on this connection; must not throw (a dead connection just drops it) */
  send(f: Frame): void;
  /** false = its send buffer is full: hold durable events, drop deltas */
  writable(): boolean;
}

interface Stream {
  conn: Conn; caller: Caller; cursor: number;
  /** still filling in after `after`: deltas wait for the snapshot */
  catching: boolean;
  /** live items this stream missed deltas of; each gets a snapshot when the stream is caught up */
  needSnap: Set<string>;
  lastBeat: number;
}

interface LiveItem { run: string; key: string; kind: "assistant" | "tool"; text: string; chunks: number; tool?: string }

export interface PumpOpts { tickMs?: number; beatMs?: number; batch?: number; maxBatches?: number; now?: () => number }

export class Pump {
  readonly db: Db; readonly blobs: string;
  readonly #o: Required<PumpOpts>;
  #streams = new Map<Conn, Stream>();
  /** per connection, survives a stream being replaced on the same connection */
  #expanded = new Map<Conn, Set<string>>();
  #live = new Map<string, LiveItem>();
  /** run → how many assistant messages it finished (views.ts liveKeyOf counts rows the same way) */
  #msgs = new Map<string, number>();
  #timer: ReturnType<typeof setInterval> | undefined;
  #kicked = false;

  constructor(db: Db, blobs: string, o: PumpOpts = {}) {
    this.db = db; this.blobs = blobs;
    this.#o = { tickMs: 100, beatMs: 20_000, batch: 500, maxBatches: 20, now: Date.now, ...o };
  }

  start() {
    if (this.#timer) return;
    this.#timer = setInterval(() => this.tick(), this.#o.tickMs);
    this.#timer.unref?.();
  }
  stop() { if (this.#timer) clearInterval(this.#timer); this.#timer = undefined; }

  /** Soon, not now: lets the caller's `res` go out first. */
  kick() {
    if (this.#kicked) return;
    this.#kicked = true;
    setImmediate(() => { this.#kicked = false; this.tick(); });
  }

  get streams(): number { return this.#streams.size; }

  /** POST /api/v1/stream. A second stream on the same connection replaces the first. */
  open(conn: Conn, caller: Caller, after: number): StreamRes {
    this.#streams.delete(conn);
    const head = headSeq(this.db);
    if (after > head || needsReset(this.db, after)) {
      this.#safeSend(conn, { t: "reset" });
      return { seq: head, reset: true };
    }
    this.#streams.set(conn, { conn, caller, cursor: after, catching: true, needSnap: new Set(), lastBeat: this.#o.now() });
    this.kick();
    return { seq: head };
  }

  /** The connection is gone (the link calls this on close). */
  close(conn: Conn) { this.#streams.delete(conn); this.#expanded.delete(conn); }

  expand(conn: Conn, item: string): { live: boolean } {
    let set = this.#expanded.get(conn);
    if (!set) this.#expanded.set(conn, (set = new Set()));
    set.add(item);
    const it = this.#live.get(item);
    const s = this.#streams.get(conn);
    if (it && s) { s.needSnap.add(item); this.kick(); }
    return { live: !!it };
  }

  collapse(conn: Conn, item: string): { live: boolean } {
    this.#expanded.get(conn)?.delete(item);
    this.#streams.get(conn)?.needSnap.delete(item);
    return { live: false };
  }

  // ── live feed ────────────────────────────────────────────────────────────────────────────────────────────
  /** The dispatcher's onItem (dispatch.ts DispatchDeps.onItem). Deltas there are already redacted (StreamRedactor). */
  onItem(run: string, _lane: string, e: ItemEvent) {
    if (e.k === "delta") {
      const key = assistantKey(run, this.#msgs.get(run) ?? 0);
      if (!this.#msgs.has(run)) this.#msgs.set(run, 0);
      this.#push({ run, key, kind: "assistant" }, e.text);
    } else if (e.k === "message") {
      const n = this.#msgs.get(run) ?? 0;
      this.#live.delete(assistantKey(run, n));
      this.#msgs.set(run, n + 1);
    }
  }

  /** A tool item's output as it comes (W4: node adapters stream tool output). `item` = its run_items id. */
  toolText(run: string, item: string, text: string, tool?: string) {
    this.#push({ run, key: item, kind: "tool", tool }, text);
  }

  #push(o: Omit<LiveItem, "text" | "chunks">, text: string) {
    let it = this.#live.get(o.key);
    if (!it) this.#live.set(o.key, (it = { ...o, text: "", chunks: 0 }));
    it.text += text;
    it.chunks++;
    for (const s of this.#streams.values()) {
      if (!this.#wants(s, it)) continue;
      if (s.catching || s.needSnap.has(it.key) || !s.conn.writable()) { s.needSnap.add(it.key); continue; }
      this.#send(s, { t: "delta", run: it.run, item: it.key, chunk_seq: it.chunks, text });
    }
  }

  #wants(s: Stream, it: LiveItem): boolean {
    if (!visibleTo(s.caller.role, "item", it)) return false;
    return it.kind === "assistant" || !!this.#expanded.get(s.conn)?.has(it.key);
  }

  /** Live text of runs that ended or tool items that finished: the `run` / `item` ev carries the end. */
  #sweepLive() {
    if (!this.#msgs.size && !this.#live.size) return;
    const runs = new Set([...this.#msgs.keys(), ...[...this.#live.values()].map((i) => i.run)]);
    for (const run of runs) {
      const st = this.db.one<{ status: string }>("SELECT status FROM runs WHERE id = ?", run)?.status;
      if (st === "running") continue;
      this.#msgs.delete(run);
      for (const [k, it] of this.#live) if (it.run === run) this.#live.delete(k);
    }
    for (const [k, it] of this.#live) {
      if (it.kind !== "tool") continue;
      const st = this.db.one<{ status: string }>("SELECT status FROM run_items WHERE id = ?", Number(k))?.status;
      if (st !== "running") this.#live.delete(k);
    }
  }

  // ── durable events ───────────────────────────────────────────────────────────────────────────────────────
  tick() {
    const now = this.#o.now();
    try { this.#sweepLive(); } catch (e) { log("api", "live sweep failed", { err: String((e as Error)?.message ?? e).slice(0, 200) }); }
    const cache = new Map<string, unknown>();
    for (const s of [...this.#streams.values()]) {
      try { this.#serve(s, cache, now); } catch (e) {
        log("api", "stream failed", { err: String((e as Error)?.message ?? e).slice(0, 200) });
        this.#streams.delete(s.conn);
      }
    }
  }

  #serve(s: Stream, cache: Map<string, unknown>, now: number) {
    if (!s.conn.writable()) return;
    // the rows it still needs were cleaned up (04 §10.4) while it lagged: it can't be caught up any more
    if (needsReset(this.db, s.cursor)) { this.#safeSend(s.conn, { t: "reset" }); this.#streams.delete(s.conn); return; }
    let caughtUp = false;
    for (let b = 0; b < this.#o.maxBatches; b++) {
      const rows = this.db.all<{ seq: number; ts: number; entity: string; ref: string; op: string }>(
        "SELECT seq, ts, entity, ref, op FROM change_log WHERE seq > ? ORDER BY seq LIMIT ?", s.cursor, this.#o.batch);
      if (!rows.length) { caughtUp = true; break; }
      // one ev per entity per batch, at its last seq, in seq order
      const merged = new Map<string, (typeof rows)[number]>();
      for (const r of rows) { const k = `${r.entity}\0${r.ref}`; merged.delete(k); merged.set(k, r); }
      for (const r of merged.values()) {
        if (!isEntity(r.entity)) continue;
        const k = `${r.entity}\0${r.ref}`;
        let data: unknown;
        if (r.op !== "delete") {
          if (!cache.has(k)) cache.set(k, view(this.db, this.blobs, r.entity, r.ref));
          data = cache.get(k);
        }
        if (!visibleTo(s.caller.role, r.entity, data)) continue;
        const ev = data === undefined
          ? { t: "ev" as const, seq: Number(r.seq), ts: Number(r.ts), entity: r.entity, id: r.ref, op: "delete" as const }
          : { t: "ev" as const, seq: Number(r.seq), ts: Number(r.ts), entity: r.entity, id: r.ref, op: "upsert" as const, data };
        this.#send(s, ev);
      }
      s.cursor = Number(rows[rows.length - 1]!.seq);
      if (rows.length < this.#o.batch) { caughtUp = true; break; }
      if (!s.conn.writable()) break;
    }
    if (!caughtUp || !s.conn.writable()) return;
    if (s.catching) {
      // what is being written right now, once the durable part is in place
      for (const it of this.#live.values()) if (this.#wants(s, it)) s.needSnap.add(it.key);
      s.catching = false;
    }
    for (const key of [...s.needSnap]) {
      if (!s.conn.writable()) return;
      s.needSnap.delete(key);
      const it = this.#live.get(key);
      if (it && this.#wants(s, it)) this.#send(s, { t: "snapshot", run: it.run, item: it.key, text: it.text, chunk_seq: it.chunks, ...(it.tool ? { tool: it.tool } : {}) });
    }
    if (now - s.lastBeat >= this.#o.beatMs) { this.#send(s, { t: "beat", seq: s.cursor }); s.lastBeat = now; }
  }

  #send(s: Stream, f: Frame) { s.conn.send(f); }
  #safeSend(conn: Conn, f: Frame) { try { conn.send(f); } catch { /* the link closes it */ } }
}
