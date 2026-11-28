// threads rows for lanes a client can look at (04 §6, §触6.5). W2 is read-only, so nothing creates threads from a
// client yet; a lane gets its row the first time an input lands in it, and `last_item_at` moves on each input and
// at run end (04: 进输入、run 结束时更新). Lanes that aren't conversations (triage, draft:*, outlet:*, import, …) get none.
import { randomBytes } from "node:crypto";
import type { Db } from "../db/db.ts";

interface Spec { id?: string; kind: string; domain: string; task_id?: string }

/** ※ domains: console:main and my Feishu DM are personal (§读5.1: both may hold self/ content); the rest work. */
export function threadSpec(lane: string): Spec | null {
  if (lane === "console:main") return { kind: "general", domain: "personal" };
  if (lane === "feishu:dm:owner") return { kind: "feishu", domain: "personal" };
  if (lane.startsWith("feishu:wb:")) return { kind: "feishu", domain: "work" };
  let m = /^console:t:(th_[0-9a-z]{1,40})$/.exec(lane);
  if (m) return { id: m[1], kind: "general", domain: "work" };
  m = /^task:(t\d+)$/.exec(lane);
  if (m) return { kind: "task", domain: "work", task_id: m[1] };
  return null;
}

export const newThreadId = (now = Date.now()) => `th_${now.toString(36)}${randomBytes(2).toString("hex")}`;

/** The lane's thread exists and its last_item_at is at least `ts`. Call it inside the write's tx(). */
export function touchThread(db: Db, lane: string | null | undefined, ts: number): void {
  if (!lane) return;
  const spec = threadSpec(lane);
  if (!spec) return;
  const t = Math.round(ts);
  const cur = db.one<{ id: string; last_item_at: number | null }>("SELECT id, last_item_at FROM threads WHERE lane = ?", lane);
  if (cur) {
    if (cur.last_item_at === null || cur.last_item_at < t) db.run("UPDATE threads SET last_item_at = ? WHERE id = ?", t, cur.id);
    return;
  }
  db.run("INSERT INTO threads(id, lane, kind, domain, task_id, created_at, last_item_at) VALUES (?,?,?,?,?,?,?)",
    spec.id ?? newThreadId(t), lane, spec.kind, spec.domain, spec.task_id ?? null, t, t);
}
