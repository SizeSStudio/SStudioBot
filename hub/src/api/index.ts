// The /api/v1 dispatcher (03 「api」): one entry, `dispatch(req, caller)`. The link (W2a) calls it for every `req`
// frame from an authenticated connection, the admin socket for the CLI, tests in-process. Order:
//   1. authorize(caller, req) — the ONE authorization call; node → 403 for all of /api/v1 (authz.ts)
//   2. route → validate query/body with protocol/api's schemas (400) → view functions → body
// W2 serves reads only. Write routes come in W3 with client_ops (02 「写操作」); until then they are 404.
// Responses carry untrusted text as data (JSON strings); nothing is pre-rendered.
import { closeSync, existsSync, openSync, readSync, statSync } from "node:fs";
import { join } from "node:path";
import type { z } from "zod";
import type { Req } from "../../../protocol/frames.ts";
import { PROTOCOL } from "../../../protocol/version.ts";
import type { MetaRes } from "../../../protocol/api/meta.ts";
import type { StatusRes } from "../../../protocol/api/status.ts";
import { BootstrapReq, StreamItemReq, StreamReq, type BootstrapRes } from "../../../protocol/api/stream.ts";
import {
  ApprovalsQuery, BLOB_CHUNK, BlobQuery, DevicesQuery, ThreadItemsQuery, ThreadsQuery,
  type ApprovalsRes, type BlobRes, type DevicesRes, type ThreadItemsRes, type ThreadsRes,
} from "../../../protocol/api/read.ts";
import type { Db, Row } from "../db/db.ts";
import { log } from "../log.ts";
import { authorize, type Authorize, type Caller } from "./authz.ts";
import { Pump, type Conn, type PumpOpts } from "./pump.ts";
import { approvalView, deviceView, headSeq, runView, taskView, threadView, timeline } from "./views.ts";

export type { Caller, Conn };
/** What the link writes back as the `res` frame. */
export interface Out { status: number; body?: unknown; seq?: number }
/** A caller on a connection that can carry a stream (the link); the admin socket and tests may leave `conn` out. */
export interface DispatchCaller extends Caller { conn?: Conn }

export interface ApiDeps {
  db: Db;
  blobs: string;
  hubSha: () => string;
  status?: () => StatusRes;
  pump?: PumpOpts;
  /** default: link/roles.ts (main.ts passes it explicitly) */
  authorize?: Authorize;
}

const TIMELINE_BOOT = 20, PAGE = 50, PAGE_MAX = 200, LIST_MAX = 200;
const ENDED_TASK = "('done','failed','cancelled')";

const bad = (error: string, status = 400): Out => ({ status, body: { error } });
function parse<T extends z.ZodType>(s: T, v: unknown): z.infer<T> | undefined {
  const r = s.safeParse(v ?? {});
  return r.success ? r.data : undefined;
}

type Handler = (req: Req, caller: DispatchCaller, m: RegExpExecArray) => Out;

export class Api {
  readonly db: Db; readonly blobs: string; readonly pump: Pump;
  readonly #d: ApiDeps;
  readonly #authorize: Authorize;
  readonly #routes: { method: Req["method"]; re: RegExp; fn: Handler }[];

  constructor(d: ApiDeps) {
    this.#d = d; this.db = d.db; this.blobs = d.blobs;
    this.#authorize = d.authorize ?? authorize;
    this.pump = new Pump(d.db, d.blobs, d.pump);
    const r = (method: Req["method"], path: string, fn: Handler) => ({ method, re: new RegExp(`^${path}$`), fn });
    this.#routes = [
      r("GET", "/api/v1/meta", () => ({ status: 200, body: this.meta() })),
      r("GET", "/api/v1/status", () => (d.status ? { status: 200, body: d.status() } : bad("no status here", 404))),
      r("POST", "/api/v1/bootstrap", (q) => (parse(BootstrapReq, q.body) ? { status: 200, body: this.bootstrap() } : bad("bad body"))),
      r("POST", "/api/v1/stream", (q, c) => this.#stream(q, c)),
      r("POST", "/api/v1/stream/expand", (q, c) => this.#streamItem(q, c, "expand")),
      r("POST", "/api/v1/stream/collapse", (q, c) => this.#streamItem(q, c, "collapse")),
      r("GET", "/api/v1/threads", (q) => this.#threads(q)),
      r("GET", "/api/v1/threads/([^/]{1,80})/items", (q, _c, m) => this.#threadItems(q, m[1]!)),
      r("GET", "/api/v1/approvals", (q) => this.#approvals(q)),
      r("GET", "/api/v1/devices", (q) => this.#devices(q)),
      r("GET", "/api/v1/blobs/([^/]{1,80})", (q, _c, m) => this.#blob(q, m[1]!)),
    ];
  }

  /** Every request, from any transport. Never throws: an internal error is a 500 (logged without the body). */
  async dispatch(req: Req, caller: DispatchCaller): Promise<Out> {
    const verdict = this.#authorize(caller, req);
    if (!verdict.ok) return bad(verdict.error, verdict.status);
    const [path, qs] = req.path.split("?", 2) as [string, string | undefined];
    // a query may come in the path (the CLI's adminRequest) or as `query`; `query` wins on a clash
    if (qs) req = { ...req, query: { ...Object.fromEntries(new URLSearchParams(qs)), ...(req.query ?? {}) } };
    let methodOk = false;
    for (const rt of this.#routes) {
      const m = rt.re.exec(path);
      if (!m) continue;
      if (rt.method !== req.method) { methodOk = true; continue; }
      try { return rt.fn(req, caller, m); } catch (e) {
        log("api", "handler failed", { path, err: String((e as Error)?.message ?? e).slice(0, 200) });
        return bad("internal error", 500);
      }
    }
    return methodOk ? bad(`${req.method} not allowed on ${path}`, 405) : bad(`no route ${req.method} ${path}`, 404);
  }

  /** The link calls this when a connection closes. */
  closeConn(conn: Conn) { this.pump.close(conn); }

  start() { this.pump.start(); }
  stop() { this.pump.stop(); }

  meta(): MetaRes { return { protocol: { current: PROTOCOL.current, min: PROTOCOL.min }, hub_sha: this.#d.hubSha() }; }

  /** One consistent read: the snapshot and the seq it is at (§触6.4). Synchronous inside one tx, so no write lands between. */
  bootstrap(): BootstrapRes {
    const { db, blobs } = this;
    return db.tx(() => {
      const threads = db.all<Row>("SELECT * FROM threads WHERE status = 'open' ORDER BY pinned DESC, last_item_at DESC").map(threadView);
      const timelines: BootstrapRes["timelines"] = {};
      for (const t of threads) timelines[t.id] = timeline(db, blobs, t.lane, undefined, TIMELINE_BOOT)!;
      return {
        seq: headSeq(db),
        threads,
        timelines,
        runs: db.all<Row>("SELECT * FROM runs WHERE status = 'running' ORDER BY started").map(runView),
        approvals: db.all<Row>("SELECT * FROM approvals WHERE status = 'pending' ORDER BY id DESC LIMIT ?", LIST_MAX).map((r) => approvalView(db, blobs, r)),
        tasks: db.all<Row>(`SELECT * FROM tasks WHERE status NOT IN ${ENDED_TASK} ORDER BY ts`).map((r) => taskView(blobs, r)),
        devices: db.all<Row>("SELECT * FROM devices WHERE removed_at IS NULL ORDER BY created_at").map(deviceView),
      };
    });
  }

  #stream(req: Req, c: DispatchCaller): Out {
    const b = parse(StreamReq, req.body);
    if (!b) return bad("body must be { after: seq }");
    if (!c.conn) return bad("this transport can't carry a stream");
    return { status: 200, body: this.pump.open(c.conn, c, b.after) };
  }

  #streamItem(req: Req, c: DispatchCaller, what: "expand" | "collapse"): Out {
    const b = parse(StreamItemReq, req.body);
    if (!b) return bad("body must be { item }");
    if (!c.conn) return bad("this transport can't carry a stream");
    return { status: 200, body: what === "expand" ? this.pump.expand(c.conn, b.item) : this.pump.collapse(c.conn, b.item) };
  }

  #threads(req: Req): Out {
    const q = parse(ThreadsQuery, req.query);
    const st = q?.status ?? "all";
    if (!q || !["open", "archived", "all"].includes(st)) return bad("status is open, archived or all");
    const { db } = this;
    return db.tx(() => {
      const rows = st === "all" ? db.all<Row>("SELECT * FROM threads ORDER BY pinned DESC, last_item_at DESC")
        : db.all<Row>("SELECT * FROM threads WHERE status = ? ORDER BY pinned DESC, last_item_at DESC", st);
      const body: ThreadsRes = { seq: headSeq(db), threads: rows.map(threadView) };
      return { status: 200, body };
    });
  }

  #threadItems(req: Req, id: string): Out {
    const q = parse(ThreadItemsQuery, req.query);
    if (!q) return bad("before is a cursor from next_before; limit a number");
    const limit = Math.min(Math.max(Number(q.limit ?? PAGE), 1), PAGE_MAX);
    const { db, blobs } = this;
    return db.tx(() => {
      const t = db.one<Row>("SELECT * FROM threads WHERE id = ?", id);
      if (!t) return bad("no such thread", 404);
      const page = timeline(db, blobs, String(t.lane), q.before, limit);
      if (!page) return bad("before is not a cursor from next_before");
      const body: ThreadItemsRes = { seq: headSeq(db), thread: threadView(t), ...page };
      return { status: 200, body };
    });
  }

  #approvals(req: Req): Out {
    const q = parse(ApprovalsQuery, req.query);
    if (!q) return bad("status is one status or all");
    const st = q.status ?? "pending";
    const { db, blobs } = this;
    return db.tx(() => {
      const rows = st === "all" ? db.all<Row>("SELECT * FROM approvals ORDER BY id DESC LIMIT ?", LIST_MAX)
        : db.all<Row>("SELECT * FROM approvals WHERE status = ? ORDER BY id DESC LIMIT ?", st, LIST_MAX);
      const body: ApprovalsRes = { seq: headSeq(db), approvals: rows.map((r) => approvalView(db, blobs, r)) };
      return { status: 200, body };
    });
  }

  #devices(req: Req): Out {
    const q = parse(DevicesQuery, req.query);
    if (!q) return bad("all=1 lists removed devices too");
    const all = q.all === "1" || q.all === "true";
    const { db } = this;
    return db.tx(() => {
      const rows = db.all<Row>(`SELECT * FROM devices ${all ? "" : "WHERE removed_at IS NULL"} ORDER BY created_at`);
      const body: DevicesRes = { seq: headSeq(db), devices: rows.map(deviceView) };
      return { status: 200, body };
    });
  }

  /** 02 「大载荷」: at most BLOB_CHUNK bytes a call; the client pulls in order and `cancel`s to stop. */
  #blob(req: Req, sha: string): Out {
    if (!/^[0-9a-f]{64}$/.test(sha)) return bad("not a sha256");
    const q = parse(BlobQuery, req.query);
    if (!q) return bad("offset and len are byte counts");
    const f = join(this.blobs, sha);
    if (!existsSync(f)) return bad("no such blob", 404);
    const total = statSync(f).size;
    const offset = Number(q.offset ?? 0);
    if (offset > total) return bad("offset is past the end");
    const len = Math.min(Number(q.len ?? BLOB_CHUNK), BLOB_CHUNK, total - offset);
    const buf = Buffer.alloc(Math.max(len, 0));
    if (len > 0) {
      const fd = openSync(f, "r");
      try { readSync(fd, buf, 0, len, offset); } finally { closeSync(fd); }
    }
    const end = offset + len;
    const body: BlobRes = { data_b64: buf.toString("base64"), total, next_offset: end < total ? end : null };
    return { status: 200, body };
  }
}

export const createApi = (d: ApiDeps) => new Api(d);
