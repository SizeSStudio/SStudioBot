// What an `ev` frame's `data` is, per entity (docs/tech/02 「应用帧」, DESIGN §触6.4). The hub fills these with the same
// view function for bootstrap, GET and events, so one entity always has one shape. Everything text-like here is
// untrusted (agent output, messages, mail, diffs): clients render it as text, never as HTML (§触6.8).
//
// Forward compatibility: statuses and kinds are plain strings (the known values are in the comments), so a newer hub
// adding a value doesn't make an older client's parse fail. Unknown entities are ignored by clients (02).
import { z } from "zod";
import { Ease, Read } from "./push.ts";

const ms = z.number().int();
const text = z.string();

/** A large payload kept out of events (02 「大载荷」): pull it with GET /api/v1/blobs/:sha. */
export const BlobRef = z.object({
  ref: z.string().regex(/^blob:[0-9a-f]{64}$/),
  size: z.number().int().nonnegative(),
  /** the first ~2 KB, already redacted */
  preview: z.string(),
});
export type BlobRef = z.infer<typeof BlobRef>;

/** threads (04 §6). One per lane a client can look at. */
export const Thread = z.object({
  id: z.string(),
  /** console:main | console:t:<id> | task:<task_id> | feishu:dm:owner | feishu:wb:<thread> */
  lane: z.string(),
  /** general | matter | task | feishu */
  kind: z.string(),
  /** work | personal (§读5.1: personal reaches client devices only) */
  domain: z.string(),
  title: text.nullable(),
  matter_id: z.number().int().nullable(),
  task_id: z.string().nullable(),
  /** open | archived */
  status: z.string(),
  pinned: z.boolean(),
  created_at: ms,
  last_item_at: ms.nullable(),
  /** W3: the root of the mainline its matter sits under (along parent_id / merged_into, computed on read, §触6.5) */
  mainline_id: z.number().int().nullable().optional(),
});
export type Thread = z.infer<typeof Thread>;

/** inbox (04 §1): one input of a lane. */
export const Input = z.object({
  id: z.string(),
  lane: z.string(),
  /** user | command | card | timer | system | approval | task */
  kind: z.string(),
  /** feishu | client | card | timer | job | approval | task | … */
  source: z.string(),
  /** received | processing | done | interrupted | failed | dropped */
  status: z.string(),
  run_id: z.string().nullable(),
  /** the client device that sent it; null for channels, timers, the system */
  device_id: z.string().nullable(),
  text: text.nullable(),
  /** who said it, when it isn't me (a channel's display name) */
  sender_name: text.nullable(),
  /** true = I typed it (a client device, or the channel said the sender is me) */
  owner: z.boolean(),
  ts: ms,
});
export type Input = z.infer<typeof Input>;

/** runs (04 §1): one round of an agent on a lane. */
export const Run = z.object({
  id: z.string(),
  lane: z.string().nullable(),
  /** main | draft | dream | improve | lens | expert | task */
  role: z.string().nullable(),
  tier: z.string().nullable(),
  model: z.string().nullable(),
  /** running | done | failed | aborted | interrupted */
  status: z.string(),
  stop_reason: z.string().nullable(),
  /** redacted */
  error: text.nullable(),
  task_id: z.string().nullable(),
  device_id: z.string().nullable(),
  started: ms.nullable(),
  ended: ms.nullable(),
});
export type Run = z.infer<typeof Run>;

/** run_items (04 §1): a finished assistant message, a tool call, a notice. Bodies were redacted before storage. */
export const Item = z.object({
  id: z.string(),
  lane: z.string(),
  run_id: z.string(),
  /** assistant | tool | notice */
  kind: z.string(),
  /** running | done | error */
  status: z.string(),
  ts: ms,
  ended: ms.nullable(),
  /** tool: the tool's name; notice: its category */
  name: z.string().nullable(),
  call_id: z.string().nullable(),
  /** assistant {text}; tool {args, result}; notice {text, ref}; a big body is {preview} plus `blob` */
  body: z.unknown(),
  /** the whole body when it was over 16 KB */
  blob: BlobRef.nullable(),
  /** a field was cut and the hub has no full copy either */
  truncated: z.boolean(),
  /** the `delta.item` this row finishes: `<run_id>:a<n>` for an assistant message, the id for a tool call, else null */
  live_key: z.string().nullable(),
});
export type Item = z.infer<typeof Item>;

/** The outbox row behind a send approval: did it go out (04 §2 cl_outbox_u). */
export const Delivery = z.object({
  /** queued | streaming | sending | sent | failed | unknown | expired | unrouted */
  status: z.string(),
  error: text.nullable(),
  ts: ms.nullable(),
});
export type Delivery = z.infer<typeof Delivery>;

/** approvals (04 §2): send, plan, glance, ask, proposal, rollback cards. */
export const Approval = z.object({
  id: z.string(),
  /** send | plan | glance | ask | proposal | rollback */
  kind: z.string(),
  /** pending | approved | rejected | expired | superseded | invalidated */
  status: z.string(),
  origin_lane: z.string().nullable(),
  run_id: z.string().nullable(),
  task_id: z.string().nullable(),
  /** a run role, or node:<device_id> */
  requester: z.string().nullable(),
  channel: z.string().nullable(),
  target: z.unknown(),
  /** user | bot */
  as_identity: z.string().nullable(),
  title: text.nullable(),
  draft: text.nullable(),
  /** optimistic lock for edits and decisions (W3) */
  draft_version: z.number().int(),
  /** glance: what the agent asked to do, as it gave it; over 16 KB this is a preview and `request_blob` has it all */
  request: z.unknown(),
  request_blob: BlobRef.nullable(),
  /** glance | ask: [{id, label, kind}] as the agent gave them */
  options: z.unknown(),
  answer: z.unknown(),
  context: z.unknown(),
  context_blob: BlobRef.nullable(),
  refs: z.unknown(),
  checks: z.unknown(),
  expires_at: ms.nullable(),
  decided_by: z.string().nullable(),
  decided_at: ms.nullable(),
  decide_note: text.nullable(),
  final_text: text.nullable(),
  result: text.nullable(),
  matter_id: z.number().int().nullable(),
  /** send: the message it became; null before it was queued */
  delivery: Delivery.nullable(),
  ts: ms,
  /** W3 暂缓: tonight | morning | monday, and when it comes back; null = not snoozed */
  snooze: z.string().nullable().optional(),
  snooze_until: ms.nullable().optional(),
});
export type Approval = z.infer<typeof Approval>;

/** A diff's shape without its text: which files, how many lines each way. */
export const DiffStat = z.object({
  files: z.array(z.object({ path: z.string(), added: z.number().int().nonnegative(), removed: z.number().int().nonnegative(), binary: z.boolean().optional() })),
  added: z.number().int().nonnegative(),
  removed: z.number().int().nonnegative(),
});
export type DiffStat = z.infer<typeof DiffStat>;

/** task_sessions (04 §4): every session a task had; the task's current one is `session_ref`. */
export const TaskSession = z.object({
  node: z.string(),
  agent: z.string(),
  session_ref: z.string(),
  workdir: z.string().nullable(),
  /** live | released | lost */
  proc: z.string(),
  last_attempt: z.number().int(),
  /** the handoff text it was opened with (a later session after a move or a lost one) */
  handoff_blob: BlobRef.nullable(),
  opened_at: ms,
  released_at: ms.nullable(),
});
export type TaskSession = z.infer<typeof TaskSession>;

/** worktrees (04 §4). Cleaned only when I press 清理; the branch stays. */
export const Worktree = z.object({
  node: z.string(),
  path: z.string(),
  task_id: z.string(),
  repo: z.string(),
  branch: z.string(),
  /** in_use | kept | cleanable | deleting | deleted */
  state: z.string(),
  cleanable_at: ms.nullable(),
  deleted_at: ms.nullable(),
  deleted_by: z.string().nullable(),
  created_at: ms,
});
export type Worktree = z.infer<typeof Worktree>;

/** task_prs (04 §4): a PR a task opened and its CI as the last check saw it. */
export const TaskPr = z.object({
  id: z.string(),
  task_id: z.string(),
  node: z.string(),
  url: z.string(),
  repo: z.string().nullable(),
  number: z.number().int().nullable(),
  branch: z.string().nullable(),
  /** open | merged | closed */
  state: z.string(),
  /** pending | green | red | none */
  ci: z.string().nullable(),
  head_sha: z.string().nullable(),
  /** reds in a row; the third goes to a notification (04 §14) */
  red_streak: z.number().int(),
  checked_at: ms.nullable(),
  opened_at: ms,
  closed_at: ms.nullable(),
});
export type TaskPr = z.infer<typeof TaskPr>;

/** tasks (04 §4). */
export const Task = z.object({
  id: z.string(),
  origin_lane: z.string().nullable(),
  goal: text,
  /** queued | running | waiting | waiting_node | interrupted | done | failed | cancelled */
  status: z.string(),
  repo: z.string().nullable(),
  /** devices.id of the node */
  node: z.string().nullable(),
  /** claude | codex | pi | acp:<name> */
  agent: z.string().nullable(),
  attempt: z.number().int(),
  turn: z.number().int(),
  quota_until: ms.nullable(),
  result: z.unknown(),
  diff_blob: BlobRef.nullable(),
  error: text.nullable(),
  matter_id: z.number().int().nullable(),
  started: ms.nullable(),
  ended: ms.nullable(),
  ts: ms,
  // W4 (optional: an older hub leaves them out)
  /** the current session's directory on the node (a worktree path when one was made) */
  workdir: z.string().nullable().optional(),
  /** host | sandbox (Claude Code on a Linux node) */
  mode: z.string().nullable().optional(),
  session_ref: z.string().nullable().optional(),
  /** the node's last report; it doesn't produce events of its own (04 §10.1), the steps do */
  last_output_at: ms.nullable().optional(),
  /** 「需要你处理」(04 §4): interrupted, or running with no output for measure.stuck_minutes; computed when read */
  needs_you: z.boolean().optional(),
  /** a glance / ask card of this attempt is pending: its approval id */
  waiting_approval: z.string().nullable().optional(),
  /** steers queued for the next turn (the agent can't take them mid-turn, or a card is open) */
  queued_steers: z.number().int().nonnegative().optional(),
  /** what the agent can do on its node, from the node's hello: {steer, resume, permissions, ask, …} */
  caps: z.record(z.string(), z.boolean()).optional(),
  /** the finished diff's files, for the Android file list (07 diff); the text itself is `diff_blob` */
  diff_stat: DiffStat.nullable().optional(),
  sessions: z.array(TaskSession).optional(),
  worktrees: z.array(Worktree).optional(),
  prs: z.array(TaskPr).optional(),
});
export type Task = z.infer<typeof Task>;

/** nodes (04 §4) joined with its devices row. Only changes of state make events, not heartbeats. */
export const Node = z.object({
  /** devices.id; `local` is the node on the hub's own machine */
  id: z.string(),
  name: z.string(),
  platform: z.string().nullable(),
  os: z.string().nullable(),
  /** the node program's version */
  version: z.string().nullable(),
  /** the commit it runs, and the hub's (they differ while it upgrades) */
  sha: z.string().nullable(),
  target_sha: z.string().nullable(),
  /** online | offline | draining | outdated */
  status: z.string(),
  status_at: ms.nullable(),
  /** [{kind, version}] */
  agents: z.unknown(),
  /** {<agent>: {steer, resume, rewind, permissions, ask}} */
  caps: z.unknown(),
  /** what the agents report left of their subscription: {<agent>: {left, resets_at}} */
  quotas: z.unknown(),
  max_parallel: z.number().int().nullable(),
  /** the last self-upgrade, when it failed: {from, to, error} */
  upgrade_failed: z.unknown(),
  /** tasks running or waiting on it now */
  running: z.number().int().nonnegative(),
  /** worktrees I can clean up there */
  cleanable: z.number().int().nonnegative(),
});
export type Node = z.infer<typeof Node>;

/** devices (04 §5). No public key, no push token. */
export const Device = z.object({
  id: z.string(),
  name: text,
  /** android | macos | windows | linux | ios */
  platform: z.string().nullable(),
  /** client | node */
  role: z.string(),
  version: z.string().nullable(),
  created_at: ms,
  last_seen: ms.nullable(),
  /** IPv4 /24, IPv6 /48 */
  last_ip_masked: z.string().nullable(),
  removed_at: ms.nullable(),
  removed_by: z.string().nullable(),
  /** W3: has an FCM token (the token itself never leaves the hub) */
  push: z.boolean().optional(),
});
export type Device = z.infer<typeof Device>;

/** `ev.entity` → the shape of `ev.data` on upsert. A delete carries no data. Only grows. */
export const ENTITY_DATA = {
  thread: Thread, input: Input, run: Run, item: Item, approval: Approval, task: Task, device: Device,
  // W3: `read` id = its ref; `ease` has the one id "ease"
  read: Read, ease: Ease,
  node: Node,
} as const;
export type EntityName = keyof typeof ENTITY_DATA;
export const ENTITY_NAMES = Object.keys(ENTITY_DATA) as EntityName[];
export type EntityData = { [K in EntityName]: z.infer<(typeof ENTITY_DATA)[K]> };

/** One line of a thread's timeline: inputs, run items, approvals and tasks of that lane, merged by time (§触6.4). */
export const TimelineEntry = z.object({
  /** input | item | approval | task (clients skip entities they don't know) */
  entity: z.string(),
  id: z.string(),
  ts: ms,
  data: z.unknown(),
});
export type TimelineEntry = z.infer<typeof TimelineEntry>;
