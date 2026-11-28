// The write routes of /api/v1 (W3; docs/tech/02 「写操作和 client_ops」「/api/v1 路由」, DESIGN §触6.4 写操作, §触6.5).
//
// Every write `req` carries `client_op_id` (frames.ts Req; a UUID the client made, CLIENT_OP_ID). The hub writes
// client_ops(device_id, client_op_id, result_json, seq) in the same transaction as the business write, so a retry with
// the same id gets the stored `res` back (same status, body and seq) and nothing is applied twice. Sending a message
// uses the inbox key (source "device:<id>", source_msg_id = client_op_id) instead; same effect for the client.
// Presence is the one write without it (WRITES below).
//
// How a client shows each write (WRITES, §触6.4's three kinds):
//   optimistic — change the store at once; on a non-2xx roll back and say so in place
//   confirmed  — show "处理中" until `res`; only the hub's answer changes the state (anything with outside effects)
//   locked     — carries a version (`draft_version`); 409 brings the current entity back: show it, don't overwrite
// A `res` with `seq`: drop the optimistic layer once the stream has reached that seq (no flicker). A write that got no
// `res` before the connection dropped is resent with the same client_op_id after reconnecting.
//
// Errors: 400 bad body, 403 role (a node can't call /api/v1 at all), 404, 409 version conflict or already decided
// (body: Conflict, with the current entity), 410 expired / superseded / invalidated (same body).
import { z } from "zod";
import { Approval, Input, Run, Thread } from "./entities.ts";

const ms = z.number().int();
const version = z.number().int().positive();

/** What a client puts in Req.client_op_id: a UUID (any 8–64 chars of [A-Za-z0-9_-] is accepted). */
export const CLIENT_OP_ID = z.string().regex(/^[A-Za-z0-9_-]{8,64}$/);

/** The three kinds of §触6.4, plus `none` (presence: no client_ops, no seq). */
export const WriteKind = z.enum(["optimistic", "confirmed", "locked", "none"]);
export type WriteKind = z.infer<typeof WriteKind>;

/** 409 / 410 body: why, and the entity as it is now (the client replaces its copy with this). */
export const Conflict = z.object({
  error: z.string(),
  approval: Approval.optional(),
  thread: Thread.optional(),
  input: Input.optional(),
  run: Run.optional(),
});
export type Conflict = z.infer<typeof Conflict>;

// ── threads (§触6.5) ─────────────────────────────────────────────────────────────────────────────────────────────

/**
 * POST /api/v1/threads — a general thread (`console:t:<id>`), or a mainline one when `matter_id` is given (kind
 * `matter`; each turn brings that matter's summary, children and recent events). Task threads are made by the task
 * itself (`task:<id>`), not here. `domain` default: a mainline thread takes its matter's domain, a general one `work` ※;
 * `personal` keeps it out of Feishu (no mirror, Feishu lanes can't search it, §读5.1).
 */
export const ThreadCreateReq = z.object({
  title: z.string().trim().min(1).max(200).optional(),
  matter_id: z.number().int().positive().optional(),
  domain: z.enum(["work", "personal"]).optional(),
});
export type ThreadCreateReq = z.infer<typeof ThreadCreateReq>;
export const ThreadRes = z.object({ thread: Thread });
export type ThreadRes = z.infer<typeof ThreadRes>;

/** PATCH /api/v1/threads/:id — rename (null clears), pin, archive / reopen. The domain can't change here. */
export const ThreadPatchReq = z.object({
  title: z.string().trim().min(1).max(200).nullable().optional(),
  pinned: z.boolean().optional(),
  status: z.enum(["open", "archived"]).optional(),
});
export type ThreadPatchReq = z.infer<typeof ThreadPatchReq>;

/**
 * POST /api/v1/threads/:id/messages — I typed this (it is `owner`, a turn I typed myself). It goes into the inbox of
 * the thread's lane; a task thread's input goes to that task's session (W4). Feishu mirror threads are read-only (D9):
 * 409. If the lane is busy the input waits its turn (`queued`); it can be withdrawn until it starts.
 */
export const MessageReq = z.object({ text: z.string().min(1).max(20_000) });
export type MessageReq = z.infer<typeof MessageReq>;
export const MessageRes = z.object({
  input: Input,
  /** a run is going on this lane: this input starts after it (and after `ahead` other inputs) */
  queued: z.boolean(),
  ahead: z.number().int().nonnegative(),
});
export type MessageRes = z.infer<typeof MessageRes>;

/** DELETE /api/v1/inputs/:id — withdraw an input still waiting (`received`); 409 once it is being processed. */
export const InputRes = z.object({ input: Input });
export type InputRes = z.infer<typeof InputRes>;

/** POST /api/v1/runs/:id/stop — stop this turn of that lane. `run` is how it is after the stop took effect. */
export const RunStopReq = z.object({});
export const RunStopRes = z.object({ run: Run, stopped: z.boolean() });
export type RunStopRes = z.infer<typeof RunStopRes>;

// ── approvals: approve / reject, glance and ask answers, edits, redraft, snooze (§底3.3, §办3.3, §触1.1) ─────────────

/**
 * POST /api/v1/approvals/:id/decide — the same `decide` the Feishu card buttons go through: the first decision wins,
 * a second one (from any end) gets 409 with the approval as it is. `draft_version` must be the one on screen.
 *   send | plan | proposal | rollback: action approve | reject (send: approve sends exactly the current draft)
 *   glance: action answer + option_id (one of the agent's options; its kind says approved or rejected)
 *   ask:    action answer + option_id, or + text (a free answer)
 * `note`: why, on a reject (goes back to the lane that asked).
 */
export const DecideReq = z.object({
  action: z.enum(["approve", "reject", "answer"]),
  draft_version: version,
  option_id: z.string().min(1).max(100).optional(),
  text: z.string().min(1).max(4000).optional(),
  note: z.string().max(1000).optional(),
});
export type DecideReq = z.infer<typeof DecideReq>;
export const ApprovalRes = z.object({ approval: Approval });
export type ApprovalRes = z.infer<typeof ApprovalRes>;

/** PUT /api/v1/approvals/:id/draft — I rewrite the draft myself. draft_version + 1; 409 if it moved meanwhile. */
export const DraftReq = z.object({ text: z.string().min(1).max(20_000), draft_version: version });
export type DraftReq = z.infer<typeof DraftReq>;

/**
 * POST /api/v1/approvals/:id/redraft — ask the agent to rewrite it ("改一下"), like replying in the card's Feishu
 * topic. The note goes to the lane that made the draft; the new draft replaces this card (superseded). Send / plan only.
 */
export const RedraftReq = z.object({ note: z.string().min(1).max(4000), draft_version: version });
export type RedraftReq = z.infer<typeof RedraftReq>;

/**
 * POST /api/v1/approvals/:id/snooze — 暂缓 (§触1.1): tonight (pushed once at gate.yaml push.snooze_tonight, counts
 * against the daily cap; not offered after that time), morning / monday (into that day's morning digest, no quota).
 * A snooze later than the card's send_by is refused (400); the card still expires at send_by.
 */
export const SnoozeReq = z.object({ until: z.enum(["tonight", "morning", "monday"]) });
export type SnoozeReq = z.infer<typeof SnoozeReq>;
export const SnoozeRes = z.object({ approval: Approval, until_ts: ms });
export type SnoozeRes = z.infer<typeof SnoozeRes>;

/**
 * Every write route and how a client shows it. `locked`: it also carries a version and may answer 409 with the
 * current entity (decide is confirmed and locked at once, 02's table). Only grows.
 */
export const WRITES: Readonly<Record<string, { kind: WriteKind; locked?: true }>> = {
  "POST /api/v1/threads": { kind: "optimistic" },
  "PATCH /api/v1/threads/:id": { kind: "optimistic" },
  "POST /api/v1/threads/:id/messages": { kind: "optimistic" },
  "DELETE /api/v1/inputs/:id": { kind: "confirmed" },
  "POST /api/v1/runs/:id/stop": { kind: "confirmed" },
  "POST /api/v1/approvals/:id/decide": { kind: "confirmed", locked: true },
  "PUT /api/v1/approvals/:id/draft": { kind: "locked", locked: true },
  "POST /api/v1/approvals/:id/redraft": { kind: "confirmed", locked: true },
  "POST /api/v1/approvals/:id/snooze": { kind: "optimistic" },
  "PATCH /api/v1/devices/:id": { kind: "confirmed" },
  "DELETE /api/v1/devices/:id": { kind: "confirmed" },
  "POST /api/v1/devices/invites": { kind: "confirmed" },
  "POST /api/v1/presence": { kind: "none" },
  "POST /api/v1/reads": { kind: "optimistic" },
  "PUT /api/v1/devices/self/push-token": { kind: "confirmed" },
  "PUT /api/v1/ease": { kind: "confirmed" },
  // W4 (bodies in api/tasks.ts)
  "POST /api/v1/tasks": { kind: "confirmed" },
  "POST /api/v1/tasks/:id/steer": { kind: "optimistic" },
  "POST /api/v1/tasks/:id/stop": { kind: "confirmed" },
  "POST /api/v1/tasks/:id/cancel": { kind: "confirmed" },
  "POST /api/v1/tasks/:id/move": { kind: "confirmed" },
  "POST /api/v1/nodes/:id/worktrees/cleanup": { kind: "confirmed" },
};
