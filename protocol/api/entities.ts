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
});
export type Task = z.infer<typeof Task>;

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
