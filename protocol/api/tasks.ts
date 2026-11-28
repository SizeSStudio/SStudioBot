// Tasks and nodes on /api/v1 (docs/tech/02 路由表, DESIGN §办3). A task's steps are its lane's run_items (`task:<id>`,
// entity `item`): tool calls with their args and results, the agent's messages, notices; a running diff rides on a
// tool item's body (`diff`), the finished one is the task's `diff_blob`. All of it is untrusted text (§触6.8).
import { z } from "zod";
import { Node, Task, Worktree } from "./entities.ts";

const seq = z.number().int().nonnegative();

/** GET /api/v1/tasks?status= (one status | open (not finished) | all; default open). Newest first, at most 200. */
export const TasksQuery = z.object({ status: z.string().optional() });
export const TasksRes = z.object({ seq, tasks: z.array(Task) });
export type TasksRes = z.infer<typeof TasksRes>;

/** GET /api/v1/tasks/:id — with sessions, worktrees and PRs filled in. */
export const TaskRes = z.object({ seq, task: Task });
export type TaskRes = z.infer<typeof TaskRes>;

/** GET /api/v1/nodes — every node and the worktrees I could clean on each. */
export const NodesRes = z.object({ seq, nodes: z.array(Node), worktrees: z.array(Worktree) });
export type NodesRes = z.infer<typeof NodesRes>;

/**
 * POST /api/v1/tasks — 派活 (03 task_start). No node = default_node, else the hub's own machine; no agent = the node's
 * first. repo: a repository path on that node (a second task in the same repo gets a worktree).
 */
export const TaskStart = z.object({
  goal: z.string().trim().min(1).max(20000),
  context: z.string().max(100000).optional(),
  node: z.string().max(100).optional(),
  agent: z.string().max(100).optional(),
  repo: z.string().max(1000).optional(),
  cwd: z.string().max(1000).optional(),
  /** host | sandbox (Claude Code on a Linux node) */
  mode: z.string().optional(),
  /** the lane it was started from, so the result goes back there */
  origin_lane: z.string().max(200).optional(),
});
export type TaskStart = z.infer<typeof TaskStart>;
export const TaskStartRes = z.object({ task: Task });

/** POST /api/v1/tasks/:id/steer { text } — 插话; applied false = it goes in at the next turn (the UI says so). */
export const TaskSteer = z.object({ text: z.string().trim().min(1).max(20000) });
export const TaskSteerRes = z.object({ applied: z.boolean(), queued: z.boolean().optional() });

/** POST /api/v1/tasks/:id/stop (this turn), /cancel (the whole task) — no body. /move { node?, agent? } — 换机器 / 换家. */
export const TaskMove = z.object({ node: z.string().max(100).optional(), agent: z.string().max(100).optional() });
export const TaskActionRes = z.object({ task: Task });

/** POST /api/v1/nodes/:id/worktrees/cleanup { path } — I pressed 清理 (§0.7: deleting is never automatic). */
export const WorktreeCleanupReq = z.object({ path: z.string().min(1).max(4000) });
export const WorktreeCleanupRes = z.object({ worktree: Worktree });
