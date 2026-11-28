// The task writes of /api/v1 (W4a; protocol/api/tasks.ts, WRITES in protocol/api/write.ts): 派活, 插话, 停, 取消,
// 换机器 / 换家, 清理 a worktree. Served like the other writes (writes.ts): over the relay and on hub-admin.sock, each
// with its client_op_id. 派活 only writes the db, so it runs inside withOp's transaction; the others wait on the
// node, so they go through withOpAsync (ops.ts) and are safe to run again: steer dedupes on the inbox key (source
// device:<id>, source_msg_id = client_op_id, like messages), stop / cancel / move / cleanup look at the state first.
// authorize() already ran: the caller is a client device or the CLI (a node gets 403 for all of /api/v1); the role
// is checked once more here.
import type { z } from "zod";
import type { Req } from "../../../protocol/frames.ts";
import { TaskMove, TaskStart, TaskSteer, WorktreeCleanupReq } from "../../../protocol/api/tasks.ts";
import type { Db, Row } from "../db/db.ts";
import type { Caller } from "./authz.ts";
import { withOp, withOpAsync, type Out } from "./ops.ts";
import { taskView, worktreeView } from "./views.ts";
import { TaskError, type TaskEngine } from "../tasks/engine.ts";

export type TaskWrites = Pick<TaskEngine, "start" | "steer" | "stopTurn" | "cancel" | "move" | "cleanupWorktree">;

const bad = (error: string, status = 400): Out => ({ status, body: { error } });
function parse<T extends z.ZodType>(s: T, v: unknown): z.infer<T> | undefined {
  const r = s.safeParse(v ?? {});
  return r.success ? r.data : undefined;
}
const caught = (e: unknown): Out => { if (e instanceof TaskError) return bad(e.message, e.status); throw e; };

type H = (req: Req, c: Caller, m: RegExpExecArray) => Out | Promise<Out>;

export function taskWriteRoutes(d: { db: Db; blobs: string; engine: TaskWrites }): { method: Req["method"]; path: string; fn: H }[] {
  const { db, engine } = d;
  const view = (r: Row) => taskView(d.blobs, r, db, { detail: true });
  const client = (fn: H): H => (req, c, m) => (c.role === "client" ? fn(req, c, m) : bad("only a client device", 403));
  // a node call that throws a TaskError is that error's status; anything else is the dispatcher's 500 (not stored)
  const op = (name: string, fn: (req: Req, c: Caller, m: RegExpExecArray) => Promise<Out>): H =>
    client((req, c, m) => withOpAsync(db, c, req, name, () => fn(req, c, m).catch(caught)));
  const T = "/api/v1/tasks/(t\\d{1,15})";

  return [
    { method: "POST", path: "/api/v1/tasks", fn: client((req, c) => withOp(db, c, req, "task.start", () => {
      const b = parse(TaskStart, req.body);
      if (!b) return bad("body: { goal, context?, node?, agent?, repo?, cwd?, mode?, origin_lane? }");
      try { return { status: 200, body: { task: view(engine.start({ ...b, device_id: c.device_id })) } }; } catch (e) { return caught(e); }
    })) },

    { method: "POST", path: `${T}/steer`, fn: op("task.steer", async (req, c, m) => {
      const b = parse(TaskSteer, req.body);
      if (!b) return bad("body: { text }");
      return { status: 200, body: await engine.steer(m[1]!, b.text, { device_id: c.device_id, source: `device:${c.device_id}`, msg_id: String(req.client_op_id) }) };
    }) },

    { method: "POST", path: `${T}/stop`, fn: op("task.stop", async (_req, _c, m) => ({ status: 200, body: { task: view(await engine.stopTurn(m[1]!)) } })) },

    { method: "POST", path: `${T}/cancel`, fn: op("task.cancel", async (_req, _c, m) => ({ status: 200, body: { task: view(await engine.cancel(m[1]!)) } })) },

    { method: "POST", path: `${T}/move`, fn: op("task.move", async (req, _c, m) => {
      const b = parse(TaskMove, req.body);
      if (!b || (!b.node && !b.agent)) return bad("body: { node?, agent? }（至少一个）");
      return { status: 200, body: { task: view(await engine.move(m[1]!, b)) } };
    }) },

    { method: "POST", path: "/api/v1/nodes/([A-Za-z0-9_-]{1,100})/worktrees/cleanup", fn: op("worktree.cleanup", async (req, c, m) => {
      const b = parse(WorktreeCleanupReq, req.body);
      if (!b) return bad("body: { path }");
      return { status: 200, body: { worktree: worktreeView(await engine.cleanupWorktree(m[1]!, b.path, `device:${c.device_id}`)) } };
    }) },
  ];
}
