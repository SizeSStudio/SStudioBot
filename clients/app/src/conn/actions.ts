// Every write the screens make, typed, with the optimistic patches of the routes WRITES marks optimistic (protocol/
// api/write.ts, push.ts, devices.ts). Plain TS on top of Writes, so tests run it against a fake connection.
import type { Approval, Input, Thread } from "../../../../protocol/api/entities.ts";
import type { DecideReq, ThreadCreateReq, ThreadPatchReq } from "../../../../protocol/api/write.ts";
import type { PresenceReq, Read } from "../../../../protocol/api/push.ts";
import type { TaskStart } from "../../../../protocol/api/tasks.ts";
import type { Store } from "../store/store.ts";
import type { WriteResult, Writes } from "./writes.ts";

const enc = encodeURIComponent;
/** the ref a read mark, a push and the item page use (push.ts Ref) */
export const refOf = (entity: string, id: string) => `${entity}:${id}`;
/** a task's lane (and its thread's): task:<id> */
export const taskLane = (id: string) => `task:${id}`;
/** what a worktree's 清理 button watches */
export const worktreeRef = (node: string, path: string) => `worktree:${node}:${path}`;

export type Actions = ReturnType<typeof makeActions>;

export function makeActions(w: Writes, store: Store, me: () => string | null, now: () => number = Date.now) {
  return {
    // ── threads ─────────────────────────────────────────────────────────────────────────────────────────────
    /** A general thread; shown at once as `op:<id>` until the hub's row is in. */
    createThread(req: ThreadCreateReq): Promise<WriteResult> {
      return w.write({
        method: "POST", path: "/api/v1/threads", body: req, target: "threads",
        patches: (op) => [{
          entity: "thread", id: `op:${op}`,
          fn: (): Thread => ({
            id: `op:${op}`, lane: `console:t:op:${op}`, kind: req.matter_id ? "matter" : "general", domain: req.domain ?? "work",
            title: req.title ?? null, matter_id: req.matter_id ?? null, task_id: null, status: "open", pinned: false,
            created_at: now(), last_item_at: null,
          }),
        }],
      });
    },
    patchThread(id: string, patch: ThreadPatchReq): Promise<WriteResult> {
      return w.write({
        method: "PATCH", path: `/api/v1/threads/${enc(id)}`, body: patch, target: refOf("thread", id),
        patches: () => [{ entity: "thread", id, fn: (b) => (b ? { ...(b as Thread), ...patch } : b) }],
      });
    },
    /** I typed this into a thread; it shows as sending (and 排队中 behind a running turn) until its row arrives. */
    sendMessage(thread: Thread, text: string): Promise<WriteResult> {
      return w.write({
        method: "POST", path: `/api/v1/threads/${enc(thread.id)}/messages`, body: { text }, target: refOf("lane", thread.lane),
        patches: (op) => [{
          entity: "input", id: `op:${op}`,
          fn: (): Input => ({
            id: `op:${op}`, lane: thread.lane, kind: "user", source: "client", status: "received", run_id: null,
            device_id: me(), text, sender_name: null, owner: true, ts: now(),
          }),
        }],
      });
    },
    withdrawInput(id: string): Promise<WriteResult> {
      return w.write({ method: "DELETE", path: `/api/v1/inputs/${enc(id)}`, target: refOf("input", id) });
    },
    stopRun(id: string): Promise<WriteResult> {
      return w.write({ method: "POST", path: `/api/v1/runs/${enc(id)}/stop`, body: {}, target: refOf("run", id) });
    },

    // ── approvals ───────────────────────────────────────────────────────────────────────────────────────────
    /** `version` is the draft_version on screen: approving sends exactly that draft, or the hub says 409. */
    decide(a: Pick<Approval, "id">, version: number, d: Omit<DecideReq, "draft_version">): Promise<WriteResult> {
      return w.write({ method: "POST", path: `/api/v1/approvals/${enc(a.id)}/decide`, body: { ...d, draft_version: version }, target: refOf("approval", a.id) });
    },
    saveDraft(id: string, text: string, version: number): Promise<WriteResult> {
      return w.write({ method: "PUT", path: `/api/v1/approvals/${enc(id)}/draft`, body: { text, draft_version: version }, target: refOf("approval", id) });
    },
    /** 「改一下」: the note goes to the lane that wrote the draft; a new card replaces this one. */
    redraft(id: string, note: string, version: number): Promise<WriteResult> {
      return w.write({ method: "POST", path: `/api/v1/approvals/${enc(id)}/redraft`, body: { note, draft_version: version }, target: refOf("approval", id) });
    },
    snooze(id: string, until: "tonight" | "morning" | "monday"): Promise<WriteResult> {
      return w.write({
        method: "POST", path: `/api/v1/approvals/${enc(id)}/snooze`, body: { until }, target: refOf("approval", id),
        patches: () => [{ entity: "approval", id, fn: (b) => (b ? { ...(b as Approval), snooze: until } : b) }],
      });
    },

    // ── devices ─────────────────────────────────────────────────────────────────────────────────────────────
    renameDevice(id: string, name: string): Promise<WriteResult> {
      return w.write({ method: "PATCH", path: `/api/v1/devices/${enc(id)}`, body: { name }, target: refOf("device", id) });
    },
    removeDevice(id: string): Promise<WriteResult> {
      return w.write({ method: "DELETE", path: `/api/v1/devices/${enc(id)}`, target: refOf("device", id) });
    },
    invite(): Promise<WriteResult> {
      return w.write({ method: "POST", path: "/api/v1/devices/invites", body: { role: "client" }, target: "invite" });
    },
    setPushToken(token: string | null): Promise<WriteResult> {
      return w.write({ method: "PUT", path: "/api/v1/devices/self/push-token", body: { token }, target: "push" });
    },

    // ── tasks and nodes (W4, protocol/api/tasks.ts) ───────────────────────────────────────────────────────
    /** 派活: confirmed (the task exists once the hub says so); the answer's `task` is the new one. */
    startTask(req: TaskStart): Promise<WriteResult> {
      return w.write({ method: "POST", path: "/api/v1/tasks", body: req, target: "task-new" });
    },
    /**
     * 插话: my line shows in the task thread at once (like a message); the answer says whether it went into this turn
     * (`applied`) or waits for the next one, and the screen says which (status.ts steerOutcome).
     */
    steerTask(id: string, text: string): Promise<WriteResult> {
      const lane = taskLane(id);
      return w.write({
        method: "POST", path: `/api/v1/tasks/${enc(id)}/steer`, body: { text }, target: refOf("lane", lane),
        patches: (op) => [{
          entity: "input", id: `op:${op}`,
          fn: (): Input => ({
            id: `op:${op}`, lane, kind: "user", source: "client", status: "received", run_id: null,
            device_id: me(), text, sender_name: null, owner: true, ts: now(),
          }),
        }],
      });
    },
    stopTask(id: string): Promise<WriteResult> {
      return w.write({ method: "POST", path: `/api/v1/tasks/${enc(id)}/stop`, body: {}, target: refOf("task", id) });
    },
    cancelTask(id: string): Promise<WriteResult> {
      return w.write({ method: "POST", path: `/api/v1/tasks/${enc(id)}/cancel`, body: {}, target: refOf("task", id) });
    },
    moveTask(id: string, to: { node?: string; agent?: string }): Promise<WriteResult> {
      return w.write({ method: "POST", path: `/api/v1/tasks/${enc(id)}/move`, body: to, target: refOf("task", id) });
    },
    /** 清理 (§办3.4: only when I press it; the branch stays). */
    cleanupWorktree(node: string, path: string): Promise<WriteResult> {
      return w.write({ method: "POST", path: `/api/v1/nodes/${enc(node)}/worktrees/cleanup`, body: { path }, target: worktreeRef(node, path) });
    },

    // ── presence, reads, 省心 ────────────────────────────────────────────────────────────────────────────────
    presence(p: PresenceReq): Promise<WriteResult> {
      return w.write({ method: "POST", path: "/api/v1/presence", body: p });
    },
    /** I looked at it. A thread: up to the newest line I saw (never back; nothing sent if it wouldn't move). */
    markRead(entity: string, id: string, upto_ts?: number): Promise<WriteResult> | null {
      const ref = refOf(entity, id);
      const held = store.get("read", ref)?.data;
      if (held && (upto_ts === undefined || (held.upto_ts ?? 0) >= upto_ts)) return null;
      const via = `device:${me() ?? "?"}`;
      return w.write({
        method: "POST", path: "/api/v1/reads", body: upto_ts === undefined ? { entity, id } : { entity, id, upto_ts }, target: refOf("read", ref),
        patches: () => [{ entity: "read", id: ref, fn: (): Read => ({ ref, upto_ts: upto_ts ?? null, read_at: now(), via }) }],
      });
    },
    setEase(on: boolean): Promise<WriteResult> {
      return w.write({ method: "PUT", path: "/api/v1/ease", body: { on }, target: "ease" });
    },
  };
}
