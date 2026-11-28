// client_ops (02 「写操作和 client_ops」, 04 §6): every write route but presence and messages runs inside withOp. The
// business write and the client_ops row are one transaction, so a retry with the same (device, client_op_id) gets the
// stored answer back — same status, body and seq — and nothing is applied twice. The same id with another request
// (route or body) is a client bug, not a retry: 409, nothing applied. Messages use the inbox key instead (source
// device:<id>, source_msg_id = client_op_id; writes.ts).
import { createHash } from "node:crypto";
import { CLIENT_OP_ID } from "../../../protocol/api/write.ts";
import type { Req } from "../../../protocol/frames.ts";
import type { Db } from "../db/db.ts";
import type { Caller } from "./authz.ts";
import { headSeq } from "./views.ts";

export interface Out { status: number; body?: unknown; seq?: number }
/** A handler's answer, plus what to do once the transaction has committed (never on a stored replay). */
export interface Done extends Out { after?: () => void }

/** 400 when a write comes without a usable client_op_id; the id when it has one. */
export function opIdOf(req: Req): string | { status: 400; body: { error: string } } {
  const r = CLIENT_OP_ID.safeParse(req.client_op_id);
  return r.success ? r.data : { status: 400, body: { error: "写操作要带 client_op_id（8–64 个 [A-Za-z0-9_-]）" } };
}

/** Keys sorted at every level, so the same body hashes the same whatever order a client wrote it in. */
function canonical(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(canonical);
  if (v && typeof v === "object") return Object.fromEntries(Object.keys(v).sort().map((k) => [k, canonical((v as Record<string, unknown>)[k])]));
  return v;
}
/** What a retry must match: method, path, body (absent = {}, as the client sends it). */
export const reqHash = (req: Pick<Req, "method" | "path" | "body">): string =>
  createHash("sha256").update(JSON.stringify([req.method, req.path.split("?")[0], canonical(req.body ?? {})])).digest("hex").slice(0, 32);

/**
 * Run `fn` (synchronous; it may call other tx() functions, they nest) as the write for this op. A 5xx isn't stored
 * (the client may retry it); any other answer is, refusals included, so a retry hears the same thing. `seq`: the
 * change_log position after this write, when it wrote any (§触6.4: the client drops its optimistic layer there).
 * `store`: what a retry gets when the answer itself mustn't be kept (an invite's pairing code is a secret).
 */
export function withOp(db: Db, caller: Caller, req: Req, op: string, fn: () => Done, store?: (out: Out) => Out): Out {
  const id = opIdOf(req);
  if (typeof id !== "string") return id;
  const hash = reqHash(req);
  let after: (() => void) | undefined;
  const out = db.tx((): Out => {
    const hit = db.one<{ result_json: string; seq: number | null }>("SELECT result_json, seq FROM client_ops WHERE device_id = ? AND client_op_id = ?", caller.device_id, id);
    if (hit) {
      const r = JSON.parse(hit.result_json) as { status: number; body?: unknown; req?: string };
      if (r.req !== undefined && r.req !== hash) return { status: 409, body: { error: "这个 client_op_id 已经用在另一个请求上了" } };
      return { status: r.status, ...(r.body !== undefined ? { body: r.body } : {}), ...(hit.seq != null ? { seq: hit.seq } : {}) };
    }
    const before = headSeq(db);
    const { after: then, ...res } = fn();
    if (res.status >= 500) return res;
    const now = headSeq(db);
    const seq = now > before ? now : null;
    const kept = store ? store(res) : res;
    db.run("INSERT INTO client_ops(device_id, client_op_id, op, result_json, seq, ts) VALUES (?,?,?,?,?,?)",
      caller.device_id, id, op, JSON.stringify({ status: kept.status, ...(kept.body !== undefined ? { body: kept.body } : {}), req: hash }), seq, Date.now());
    after = then;
    return { ...res, ...(seq != null ? { seq } : {}) };
  });
  after?.();   // committed: side effects outside the db (triage drafting again) happen once, here
  return out;
}
