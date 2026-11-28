// The normalized store (07 「store」). One Map<entity, Map<id, {seq, data}>>; an `ev` not newer than what we hold is
// dropped; live text is kept per (run, item) and follows the chunk_seq rule of protocol/api/stream.ts. Content lives
// only in memory: nothing here is ever written to disk (§触6.4; `personal` content in particular).
//
// Plain TS, no React: hooks.ts puts useSyncExternalStore on top. Every change bumps a version per key, so a
// component that reads one entity, one entity kind or one lane re-renders only when that changed.
//
// W3 optimistic layer (protocol/api/write.ts): a write may lay patches over rows (or add rows of its own, id
// `op:<client_op_id>`). Reads see base + patches; the base stays what the hub said. A patch goes when its write failed
// (rollback, conn/writes.ts says so in place) or once the stream has reached the seq of its `res`: by then the hub's own
// rows are in, so the switch from patch to real row happens in one flush (no flicker).
import type { Delta, Ev, Snap } from "../../../../protocol/frames.ts";
import type { BootstrapRes } from "../../../../protocol/api/stream.ts";
import type { ThreadItemsRes } from "../../../../protocol/api/read.ts";
import { ENTITY_DATA, type EntityData, type EntityName } from "../../../../protocol/api/entities.ts";

/** `pending`: the client_op_id of a write whose patch this view still shows */
export type Rec<E extends EntityName = EntityName> = { seq: number; data: EntityData[E]; pending?: string };
/** A write's patch on one row: base (undefined = no such row) → what to show (null = hide it). */
export type Patch = { entity: EntityName; id: string; fn: (base: unknown) => unknown };
export type Live = { run: string; item: string; text: string; chunks: number | null; stale: boolean; tool?: string };
export type TimelineRow = { entity: "input" | "item" | "approval" | "task"; id: string; ts: number; rec: Rec };

const TIMELINE = ["input", "item", "approval", "task"] as const;
type TimelineEntity = (typeof TIMELINE)[number];
const isTimeline = (e: string): e is TimelineEntity => (TIMELINE as readonly string[]).includes(e);
const isEntity = (e: string): e is EntityName => Object.hasOwn(ENTITY_DATA, e);

/** Which lane a row belongs to; null = it isn't on any thread's timeline. */
function laneOf(entity: EntityName, data: unknown): string | null {
  const d = data as Record<string, unknown>;
  const v = entity === "approval" || entity === "task" ? d.origin_lane : entity === "thread" ? null : d.lane;
  return typeof v === "string" ? v : null;
}
const tsOf = (entity: EntityName, data: unknown): number => {
  const d = data as Record<string, unknown>;
  const v = entity === "run" ? d.started : d.ts;
  return typeof v === "number" ? v : 0;
};
const liveKey = (run: string, item: string) => `${run}\u0000${item}`;

export class Store {
  #rows = new Map<EntityName, Map<string, Rec>>();
  #lanes = new Map<string, Set<string>>(); // lane → "entity\0id" of its timeline rows
  #live = new Map<string, Live>();
  #paging = new Map<string, string | null>(); // thread id → next_before (null = no more)
  #versions = new Map<string, number>();
  #subs = new Set<() => void>();
  #dirty = new Set<string>();
  #over = new Map<string, { patches: Patch[]; until: number | null }>(); // client_op_id → its patches, in write order
  /** where the stream resumes: the highest `ev.seq` / `beat.seq` seen (02: beat.seq is the resume cursor) */
  seq = 0;
  /** a bootstrap has been loaded since the last reset */
  loaded = false;

  // ── reads ─────────────────────────────────────────────────────────────────────────────────────────────────
  get<E extends EntityName>(entity: E, id: string): Rec<E> | undefined {
    const base = this.#rows.get(entity)?.get(id) as Rec<E> | undefined;
    if (this.#over.size === 0) return base;
    let data: unknown = base?.data, pending: string | undefined;
    for (const [op, o] of this.#over) for (const p of o.patches) {
      if (p.entity === entity && p.id === id) { data = p.fn(data); pending = op; }
    }
    if (pending === undefined) return base;
    return data === null || data === undefined ? undefined : { seq: base?.seq ?? 0, data: data as EntityData[E], pending };
  }
  /** what the hub said, without the optimistic layer */
  base<E extends EntityName>(entity: E, id: string): Rec<E> | undefined {
    return this.#rows.get(entity)?.get(id) as Rec<E> | undefined;
  }
  list<E extends EntityName>(entity: E): Rec<E>[] {
    const ids = new Set(this.#rows.get(entity)?.keys() ?? []);
    for (const o of this.#over.values()) for (const p of o.patches) if (p.entity === entity) ids.add(p.id);
    const out: Rec<E>[] = [];
    for (const id of ids) { const r = this.get(entity, id); if (r) out.push(r); }
    return out;
  }
  threadByLane(lane: string): Rec<"thread"> | undefined {
    return this.list("thread").find((r) => r.data.lane === lane);
  }
  /** One lane's inputs, items, approvals and tasks, oldest first (§触6.4: merged by time). */
  timeline(lane: string): TimelineRow[] {
    const out: TimelineRow[] = [];
    const keys = new Set(this.#lanes.get(lane) ?? []);
    for (const o of this.#over.values()) for (const p of o.patches) if (isTimeline(p.entity)) keys.add(`${p.entity}\u0000${p.id}`);
    for (const k of keys) {
      const [entity, id] = k.split("\u0000") as [TimelineEntity, string];
      const rec = this.get(entity, id);
      if (rec && laneOf(entity, rec.data) === lane) out.push({ entity, id, ts: tsOf(entity, rec.data), rec });
    }
    return out.sort((a, b) => a.ts - b.ts || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  }
  /** Text being written right now on a lane (assistant replies, and tool items this connection expanded). */
  liveOn(lane: string): Live[] {
    return [...this.#live.values()].filter((l) => this.get("run", l.run)?.data.lane === lane);
  }
  live(run: string, item: string): Live | undefined { return this.#live.get(liveKey(run, item)); }
  /** undefined = this thread was never paged (start from its bootstrap timeline's next_before) */
  nextBefore(threadId: string): string | null | undefined { return this.#paging.get(threadId); }

  // ── subscriptions ─────────────────────────────────────────────────────────────────────────────────────────
  subscribe = (fn: () => void): (() => void) => { this.#subs.add(fn); return () => this.#subs.delete(fn); };
  /** Keys: `entity:<name>`, `row:<name>:<id>`, `lane:<lane>`, `live`, `all`. */
  version = (key: string): number => this.#versions.get(key) ?? 0;

  // ── writes (from the connection) ──────────────────────────────────────────────────────────────────────────
  /** Empty the rows (a `reset` frame, or before a bootstrap). Pending writes' patches stay: they are still pending. */
  reset(): void {
    for (const [entity, rows] of this.#rows) for (const id of rows.keys()) this.#touchRow(entity, id, rows.get(id)!.data);
    this.#rows.clear(); this.#lanes.clear(); this.#live.clear(); this.#paging.clear();
    this.seq = 0; this.loaded = false;
    this.#mark("live");
    this.#flush();
  }

  bootstrap(b: BootstrapRes): void {
    this.reset();
    const put = (entity: EntityName, id: string, data: unknown) => this.#put(entity, id, b.seq, data);
    for (const t of b.threads) put("thread", t.id, t);
    for (const r of b.runs) put("run", r.id, r);
    for (const a of b.approvals) put("approval", a.id, a);
    for (const t of b.tasks) put("task", t.id, t);
    for (const d of b.devices) put("device", d.id, d);
    for (const n of b.nodes ?? []) put("node", n.id, n);
    if (b.ease) put("ease", "ease", b.ease);
    for (const r of b.reads ?? []) put("read", r.ref, r);
    for (const [threadId, tl] of Object.entries(b.timelines)) {
      for (const e of tl.entries) if (isEntity(e.entity)) put(e.entity, e.id, e.data);
      this.#paging.set(threadId, tl.next_before);
    }
    this.seq = b.seq;
    this.loaded = true;
    this.#settle();
    this.#flush();
  }

  /** An older page of one thread (GET threads/:id/items). Rows we already hold at a newer seq stay. */
  page(threadId: string, p: ThreadItemsRes): void {
    this.#put("thread", p.thread.id, p.seq, p.thread);
    for (const e of p.entries) if (isEntity(e.entity)) this.#put(e.entity, e.id, p.seq, e.data);
    this.#paging.set(threadId, p.next_before);
    this.#flush();
  }

  ev(e: Ev): void {
    if (e.seq > this.seq) this.seq = e.seq;
    if (!isEntity(e.entity)) { this.#settle(); this.#flush(); return; } // unknown entity: ignore, but the cursor moved (02)
    const held = this.base(e.entity, e.id);
    if (held && held.seq >= e.seq) { this.#settle(); this.#flush(); return; }
    if (e.op === "delete") this.#drop(e.entity, e.id);
    else this.#put(e.entity, e.id, e.seq, e.data);
    if (e.op === "upsert") {
      const d = e.data as Record<string, unknown> | undefined;
      // the finished message replaces its streaming text; a run that stopped has nothing streaming any more
      if (e.entity === "item" && typeof d?.live_key === "string") this.#dropLive((l) => l.item === d.live_key);
      if (e.entity === "run" && d?.status !== "running") this.#dropLive((l) => l.run === e.id);
    }
    this.#settle();
    this.#flush();
  }

  beat(seq: number): void {
    if (seq > this.seq) this.seq = seq;
    // a write's own rows may be filtered out of this stream; the beat still says the stream is past them
    this.#settle();
    this.#flush();
  }

  /**
   * The hub's current copy of one entity, from a write's answer (a 409 / 410 Conflict body). It replaces ours unless we
   * already hold a newer one from the stream; `seq` when the answer had one, else it ranks with what we hold.
   */
  current(entity: EntityName, data: unknown, seq?: number): void {
    const d = data as { id?: unknown; ref?: unknown } | null;
    const id = entity === "read" ? d?.ref : entity === "ease" ? "ease" : d?.id;
    if (typeof id !== "string") return;
    const held = this.base(entity, id);
    const at = seq ?? Math.max(held?.seq ?? 0, 0);
    if (held && held.seq > at) return;
    this.#put(entity, id, at, data);
    this.#flush();
  }

  // ── the optimistic layer (conn/writes.ts) ──────────────────────────────────────────────────────────────────
  /** Lay a write's patches over the store now. */
  overlay(op: string, patches: Patch[]): void {
    this.#over.set(op, { patches, until: null });
    this.#touchPatches(patches);
    this.#flush();
  }
  /** The write was answered at `seq`: keep the patches until the stream has reached it (no seq: drop now). */
  settleAt(op: string, seq: number | undefined): void {
    const o = this.#over.get(op);
    if (!o) return;
    if (seq === undefined || seq <= this.seq) return this.dropOverlay(op);
    o.until = seq;
  }
  /** Roll back (the write failed) or forget it. */
  dropOverlay(op: string): void {
    const o = this.#over.get(op);
    if (!o) return;
    this.#touchPatches(o.patches); // mark before and after, so the lanes the patch moved rows in/out of both redraw
    this.#over.delete(op);
    this.#touchPatches(o.patches);
    this.#flush();
  }
  hasOverlay(op: string): boolean { return this.#over.has(op); }
  /** Unpairing: nothing of the old pairing may stay on screen. */
  clearOverlays(): void { for (const op of [...this.#over.keys()]) this.dropOverlay(op); }

  delta(d: Delta): void {
    const k = liveKey(d.run, d.item);
    const l = this.#live.get(k);
    if (!l) {
      // first chunk opens it; anything else means we joined mid-way: hold it as stale until a snapshot comes
      this.#live.set(k, { run: d.run, item: d.item, text: d.chunk_seq === 1 ? d.text : "", chunks: d.chunk_seq === 1 ? 1 : null, stale: d.chunk_seq !== 1 });
    } else if (l.stale) {
      return;
    } else if (l.chunks === null || d.chunk_seq === l.chunks + 1) {
      l.text += d.text; l.chunks = d.chunk_seq;
    } else if (d.chunk_seq <= l.chunks) {
      return; // a repeat
    } else {
      l.stale = true; // a gap: drop this chunk and everything after it until the next snapshot (07)
      return;
    }
    this.#markLive(d.run);
    this.#flush();
  }

  snapshot(s: Snap): void {
    const k = liveKey(s.run, s.item);
    this.#live.set(k, { run: s.run, item: s.item, text: s.text, chunks: s.chunk_seq ?? null, stale: false, tool: s.tool });
    this.#markLive(s.run);
    this.#flush();
  }

  // ── internals ─────────────────────────────────────────────────────────────────────────────────────────────
  /** drop the patches of answered writes the stream has caught up with (same flush as the rows that replace them) */
  #settle(): void {
    for (const [op, o] of this.#over) {
      if (o.until !== null && o.until <= this.seq) { this.#touchPatches(o.patches); this.#over.delete(op); this.#touchPatches(o.patches); }
    }
  }

  #touchPatches(patches: Patch[]): void {
    for (const p of patches) {
      const r = this.get(p.entity, p.id);
      this.#touchRow(p.entity, p.id, r?.data ?? this.base(p.entity, p.id)?.data ?? {});
    }
  }

  #put(entity: EntityName, id: string, seq: number, raw: unknown): void {
    const held = this.base(entity, id);
    if (held && held.seq > seq) return;
    // the schema is the contract; a row that doesn't fit it is skipped rather than shown half-understood
    const parsed = ENTITY_DATA[entity].safeParse(raw);
    if (!parsed.success) return;
    let rows = this.#rows.get(entity);
    if (!rows) this.#rows.set(entity, (rows = new Map()));
    if (held) this.#unindex(entity, id, held.data);
    rows.set(id, { seq, data: parsed.data } as Rec);
    const lane = isTimeline(entity) ? laneOf(entity, parsed.data) : null;
    if (lane !== null) {
      let s = this.#lanes.get(lane);
      if (!s) this.#lanes.set(lane, (s = new Set()));
      s.add(`${entity}\u0000${id}`);
    }
    this.#touchRow(entity, id, parsed.data);
  }

  #drop(entity: EntityName, id: string): void {
    const held = this.base(entity, id);
    if (!held) return;
    this.#unindex(entity, id, held.data);
    this.#rows.get(entity)!.delete(id);
    this.#touchRow(entity, id, held.data);
  }

  #unindex(entity: EntityName, id: string, data: unknown): void {
    const lane = isTimeline(entity) ? laneOf(entity, data) : null;
    if (lane !== null) this.#lanes.get(lane)?.delete(`${entity}\u0000${id}`);
  }

  #dropLive(pred: (l: Live) => boolean): void {
    for (const [k, l] of this.#live) if (pred(l)) { this.#live.delete(k); this.#markLive(l.run); }
  }

  #touchRow(entity: EntityName, id: string, data: unknown): void {
    this.#mark(`entity:${entity}`); this.#mark(`row:${entity}:${id}`);
    const lane = isTimeline(entity) ? laneOf(entity, data) : null;
    if (lane !== null) this.#mark(`lane:${lane}`);
    if (entity === "run" && typeof (data as { lane?: unknown }).lane === "string") this.#mark(`lane:${(data as { lane: string }).lane}`);
  }

  #markLive(run: string): void {
    this.#mark("live");
    const lane = this.get("run", run)?.data.lane;
    if (lane) this.#mark(`lane:${lane}`);
  }

  #mark(key: string): void { this.#dirty.add(key); }

  #flush(): void {
    if (this.#dirty.size === 0) return;
    this.#dirty.add("all");
    for (const k of this.#dirty) this.#versions.set(k, (this.#versions.get(k) ?? 0) + 1);
    this.#dirty.clear();
    for (const fn of this.#subs) fn();
  }
}
