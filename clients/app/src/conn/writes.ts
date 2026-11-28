// The write layer (07 「写操作」, protocol/api/write.ts WRITES, DESIGN §触6.4). Every write `req` carries a fresh
// client_op_id; how it shows depends on the route's kind:
//   optimistic — its patches go over the store at once (store.overlay); a non-2xx rolls them back and the op stays
//                here as `failed`, so the screen can say so where the change was
//   confirmed  — nothing changes until the hub answers; the op is `sent` (处理中) meanwhile
//   locked     — like confirmed, plus a version; 409 / 410 put the hub's current entity into the store (not ours over
//                it) and the op stays as `conflict`
// An answered op lives on until the stream has reached its `res.seq`: optimistic patches are swapped for the hub's rows
// in one flush, and a confirmed button doesn't bounce back before the new state is there. A write that went out and
// got no `res` before the connection dropped is sent again with the same id once it is live again (the hub's
// client_ops gives back the stored answer, nothing is applied twice). Writes made while offline wait the same way.
// Memory only: if the app is killed, they are gone, and the screen never pretends they went out.
//
// Presence (kind `none`) has no id, no queue, no resend.
import type { Req, Res } from "../../../../protocol/frames.ts";
import { Conflict, WRITES, type WriteKind } from "../../../../protocol/api/write.ts";
import type { EntityName } from "../../../../protocol/api/entities.ts";
import type { Patch, Store } from "../store/store.ts";

/** The bits of Connection the write layer uses (tests pass a fake). */
export interface WriteConn {
  readonly live: boolean;
  request(method: Req["method"], path: string, opts?: { query?: Record<string, string>; body?: unknown; client_op_id?: string }): Promise<Res>;
  subscribe(fn: (s: { s: string }) => void): () => void;
}

/** queued: not out yet (offline, or lost with a dropped connection) · sent: waiting for `res` · settling: answered,
 * waiting for the stream to reach its seq · failed / conflict: the hub said no (kept for the screen until dismissed) */
export type OpState = "queued" | "sent" | "settling" | "failed" | "conflict";

export type Op = {
  id: string;
  method: Req["method"];
  path: string;
  body: unknown;
  /** the WRITES key, e.g. "POST /api/v1/approvals/:id/decide" */
  route: string;
  kind: WriteKind;
  locked: boolean;
  /** what the screen shows it next to: `thread:<id>`, `approval:<id>`, `lane:<lane>`, `device:<id>`, `ease` … */
  target: string | null;
  state: OpState;
  /** times it went out (a resend after a reconnect counts) */
  tries: number;
  status?: number;
  seq?: number;
  body_res?: unknown;
  /** the hub's `error` (untrusted text: shown as text) */
  error?: string;
  conflict?: Conflict;
};

export type WriteResult =
  | { ok: true; status: number; body: unknown; seq?: number; op: string }
  | { ok: false; status: number; error: string; conflict?: Conflict; op: string };

export type WriteSpec = {
  method: Req["method"];
  path: string;
  body?: unknown;
  target?: string | null;
  /** optimistic routes: the patches to show now, given this write's client_op_id (for rows of its own: `op:<id>`) */
  patches?: (op: string) => Patch[];
};

const route = (method: string, path: string): string | null => {
  const segs = path.split("?")[0]!.split("/");
  for (const key of Object.keys(WRITES)) {
    const [m, pattern] = key.split(" ") as [string, string];
    if (m !== method) continue;
    const ps = pattern.split("/");
    if (ps.length === segs.length && ps.every((p, i) => p.startsWith(":") ? segs[i] !== "" : p === segs[i])) return key;
  }
  return null;
};
/** Which WRITES entry a call is (null = not a write route this client knows). */
export const routeOf = (method: string, path: string): { route: string; kind: WriteKind; locked: boolean } | null => {
  const k = route(method, path);
  return k ? { route: k, kind: WRITES[k]!.kind, locked: WRITES[k]!.locked === true } : null;
};

/** A v4 UUID from the platform's CSPRNG (quick-crypto installs getRandomValues on Android). */
export function newOpId(): string {
  const b = new Uint8Array(16);
  globalThis.crypto.getRandomValues(b);
  b[6] = (b[6]! & 0x0f) | 0x40; b[8] = (b[8]! & 0x3f) | 0x80;
  const h = [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

const CONFLICT_ENTITIES = ["approval", "thread", "input", "run"] as const satisfies readonly EntityName[];
const KEEP_FAILED = 50;

/** What a refusal means, in a line (the hub's own `error` goes after it). */
export function refusalText(status: number): string {
  if (status === 400) return "主没收：内容不对";
  if (status === 403) return "主不许这台这么做";
  if (status === 404) return "主上没有这个（或者还不支持）";
  if (status === 409) return "别处先动了：显示的是现在的样子";
  if (status === 410) return "已经过期、被新稿换掉或作废了";
  return `主出错了（${status}）`;
}

export class Writes {
  readonly #conn: WriteConn;
  readonly #store: Store;
  readonly #newId: () => string;
  #ops = new Map<string, Op>(); // insertion order = write order = resend order
  #done = new Map<string, (r: WriteResult) => void>();
  #results = new Map<string, WriteResult>();
  #subs = new Set<() => void>();
  #version = 0;
  #liveGen = 0;

  constructor(d: { conn: WriteConn; store: Store; newId?: () => string }) {
    this.#conn = d.conn;
    this.#store = d.store;
    this.#newId = d.newId ?? newOpId;
    d.conn.subscribe((s) => { if (s.s === "live") { this.#liveGen++; this.#flushQueue(); } });
    d.store.subscribe(() => this.#settle());
  }

  // ── for screens ───────────────────────────────────────────────────────────────────────────────────────────
  subscribe = (fn: () => void): (() => void) => { this.#subs.add(fn); return () => this.#subs.delete(fn); };
  version = (): number => this.#version;
  op(id: string): Op | undefined { return this.#ops.get(id); }
  ops(): Op[] { return [...this.#ops.values()]; }
  /** this target's ops, oldest first */
  forTarget(target: string): Op[] { return this.ops().filter((o) => o.target === target); }
  /** an op the hub hasn't answered for good yet (処理中 / 等连上) */
  busy(target: string): Op | undefined { return this.forTarget(target).find((o) => o.state === "queued" || o.state === "sent" || o.state === "settling"); }
  /** the newest refusal for this target, if nothing newer went through */
  refusal(target: string): Op | undefined {
    const t = this.forTarget(target);
    const last = t[t.length - 1];
    return last && (last.state === "failed" || last.state === "conflict") ? last : undefined;
  }
  dismiss(id: string): void {
    const o = this.#ops.get(id);
    if (o && (o.state === "failed" || o.state === "conflict")) { this.#ops.delete(id); this.#bump(); }
  }

  /** Send one write. Resolves when it is over: refused, or answered and the stream has caught up with it. */
  write(w: WriteSpec): Promise<WriteResult> {
    const r = routeOf(w.method, w.path);
    if (!r) throw new Error(`not a write route: ${w.method} ${w.path}`);
    if (r.kind === "none") return this.#fireAndForget(w);
    const id = this.#newId();
    const op: Op = { id, method: w.method, path: w.path, body: w.body ?? {}, route: r.route, kind: r.kind, locked: r.locked, target: w.target ?? null, state: "queued", tries: 0 };
    this.#ops.set(id, op);
    const done = new Promise<WriteResult>((resolve) => this.#done.set(id, resolve));
    if (r.kind === "optimistic" && w.patches) this.#store.overlay(id, w.patches(id));
    this.#bump();
    if (this.#conn.live) this.#send(op);
    return done;
  }

  /** Unpairing: drop everything (and its patches). */
  clear(): void {
    for (const id of this.#ops.keys()) this.#finish(id, { ok: false, status: 0, error: "unpaired", op: id });
    this.#ops.clear();
    this.#store.clearOverlays();
    this.#bump();
  }

  // ── internals ─────────────────────────────────────────────────────────────────────────────────────────────
  #fireAndForget(w: WriteSpec): Promise<WriteResult> {
    const op = "-";
    if (!this.#conn.live) return Promise.resolve({ ok: false, status: 0, error: "offline", op });
    return this.#conn.request(w.method, w.path, { body: w.body ?? {} }).then(
      (res) => (res.status < 300 ? { ok: true, status: res.status, body: res.body, op } : { ok: false, status: res.status, error: errorOf(res.body), op }),
      () => ({ ok: false, status: 0, error: "disconnected", op }),
    );
  }

  #flushQueue(): void {
    for (const op of this.#ops.values()) if (op.state === "queued") this.#send(op);
  }

  #send(op: Op): void {
    const sentGen = this.#liveGen;
    op.state = "sent";
    op.tries++;
    this.#bump();
    this.#conn.request(op.method, op.path, { body: op.body, client_op_id: op.id }).then(
      (res) => this.#answer(op, res),
      // no `res`: the connection went (or wasn't there). Same id again once it's live (the hub dedupes by it).
      // if the connection already came back live before this microtask ran, resend now; never loop on the same session
      () => {
        if (this.#ops.get(op.id) !== op || op.state !== "sent") return;
        op.state = "queued";
        this.#bump();
        if (this.#conn.live && this.#liveGen !== sentGen) this.#send(op);
      },
    );
  }

  #answer(op: Op, res: Res): void {
    if (this.#ops.get(op.id) !== op || op.state !== "sent") return;
    op.status = res.status;
    op.seq = res.seq;
    if (res.status >= 200 && res.status < 300) {
      op.state = "settling";
      op.body_res = res.body;
      this.#results.set(op.id, { ok: true, status: res.status, body: res.body, seq: res.seq, op: op.id });
      this.#store.settleAt(op.id, res.seq);
      this.#bump();
      this.#settle();
      return;
    }
    // refused: roll back, and if the hub sent its current copy, show that (never ours over it)
    this.#store.dropOverlay(op.id);
    op.error = errorOf(res.body);
    const c = (res.status === 409 || res.status === 410) ? Conflict.safeParse(res.body) : null;
    if (c?.success) {
      op.state = "conflict";
      op.conflict = c.data;
      for (const e of CONFLICT_ENTITIES) if (c.data[e]) this.#store.current(e, c.data[e], res.seq);
    } else {
      op.state = "failed";
    }
    this.#trimFailed();
    this.#bump();
    this.#finish(op.id, { ok: false, status: res.status, error: op.error, conflict: op.conflict, op: op.id });
  }

  /** answered ops whose seq the stream has reached are over */
  #settle(): void {
    let changed = false;
    for (const op of [...this.#ops.values()]) {
      if (op.state !== "settling") continue;
      if (op.seq !== undefined && op.seq > this.#store.seq) continue;
      this.#store.dropOverlay(op.id); // normally already gone (same flush); this covers a write without patches
      this.#ops.delete(op.id);
      changed = true;
      this.#finish(op.id, this.#results.get(op.id)!);
      this.#results.delete(op.id);
    }
    if (changed) this.#bump();
  }

  #finish(id: string, r: WriteResult): void {
    const f = this.#done.get(id);
    this.#done.delete(id);
    f?.(r);
  }

  #trimFailed(): void {
    const failed = this.ops().filter((o) => o.state === "failed" || o.state === "conflict");
    for (const o of failed.slice(0, Math.max(0, failed.length - KEEP_FAILED))) this.#ops.delete(o.id);
  }

  #bump(): void { this.#version++; for (const f of this.#subs) f(); }
}

function errorOf(body: unknown): string {
  const e = (body as { error?: unknown } | null)?.error;
  return typeof e === "string" ? e.slice(0, 500) : "";
}
