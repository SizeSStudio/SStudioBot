// /node/v1 beyond hello and exec/fs (docs/tech/02 「/node/v1」, 05). W4: sessions, unified events, permissions and
// ask-me, the sbot MCP's tool calls, status, blobs, CI checks, worktrees. Everything an agent produced (text, tool
// args and results, diffs, permission details) is untrusted: the hub redacts it before it is stored or shown and
// clients render it as text (§触6.8). Statuses and kinds are plain strings so a newer peer's value doesn't fail an
// older one's parse; unknown event kinds are skipped (02: only grows).
import { z } from "zod";

const ms = z.number().int();
const seq = z.number().int().nonnegative();
const attempt = z.number().int().positive();
const taskId = z.string().regex(/^t\d{1,15}$/);
const ref = z.string().min(1).max(500);   // session_ref: an agent's own id or a session file path (pi)

/** One choice on a permission or ask card, as the agent gave it. kind: allow_once | allow_always | reject_once | reject_always | answer | … */
export const PermissionOption = z.object({ id: z.string().min(1).max(200), label: z.string().max(500), kind: z.string().max(40).optional() });
export type PermissionOption = z.infer<typeof PermissionOption>;

/**
 * An agent's permission request or question (05 「权限和问我」). `detail` is the full command, path and arguments, never
 * cut (the card folds it). `questions` is AskUserQuestion's shape (Claude), passed through for the ask card.
 */
export const PermissionRequest = z.object({
  id: z.string().min(1).max(200),
  /** permission | ask */
  kind: z.string(),
  title: z.string().max(2000),
  /** {tool, command?, path?, args?, cwd?, diff?, questions?} as the agent gave it */
  detail: z.unknown(),
  options: z.array(PermissionOption),
});
export type PermissionRequest = z.infer<typeof PermissionRequest>;

/**
 * The unified event (05 「统一事件」): each adapter maps its agent's stream onto these. `item` is the adapter's own id
 * for one assistant message or one tool call, stable inside a session.
 */
export const AgentEvent = z.discriminatedUnion("k", [
  z.object({ k: z.literal("text"), item: z.string(), delta: z.string() }),
  z.object({ k: z.literal("message"), item: z.string(), text: z.string() }),
  z.object({ k: z.literal("tool_start"), item: z.string(), name: z.string(), args: z.unknown() }),
  z.object({ k: z.literal("tool_end"), item: z.string(), ok: z.boolean(), result: z.unknown().optional(), diff: z.string().optional() }),
  z.object({ k: z.literal("permission"), request: PermissionRequest }),
  z.object({ k: z.literal("ask"), request: PermissionRequest }),
  /** stop: done | interrupted | error */
  z.object({ k: z.literal("turn_end"), stop: z.string(), error: z.string().optional() }),
  z.object({ k: z.literal("usage"), input_tokens: z.number().int().nonnegative().optional(), output_tokens: z.number().int().nonnegative().optional(), ms: z.number().int().nonnegative().optional(), model: z.string().optional() }),
  /** a subscription limit: resets_at (ms) when the agent said, else absent and the hub retries every 30 min */
  z.object({ k: z.literal("quota"), resets_at: ms.optional(), remaining: z.unknown().optional(), text: z.string().optional() }),
  z.object({ k: z.literal("progress"), text: z.string() }),
  /** the agent's session id is known (some agents name it only after the first turn) */
  z.object({ k: z.literal("session"), ref }),
  /** an attached file or a finished diff the node uploaded with POST /node/v1/blobs */
  z.object({ k: z.literal("diff"), item: z.string().optional(), blob: z.string().regex(/^blob:[0-9a-f]{64}$/).optional(), text: z.string().optional(), stat: z.unknown().optional() }),
  /** a PR the agent opened (gh pr create's URL), so the hub can watch its CI (§办3.4) */
  z.object({ k: z.literal("pr"), url: z.string().max(500), repo: z.string().optional(), number: z.number().int().optional(), branch: z.string().optional() }),
]);
export type AgentEvent = z.infer<typeof AgentEvent>;

/** One event on the wire: the session's monotonic event_seq and when the node saw it. */
export const NodeEvent = z.object({ seq, ts: ms, e: z.unknown() });
export type NodeEvent = z.infer<typeof NodeEvent>;

/**
 * POST /node/v1/tasks/:id/events — a batch, oldest first, `events[i].seq` = from_seq + i. The hub is idempotent on
 * task_id:attempt:seq; an attempt below the task's current one is dropped whole (res { dropped: true }).
 * `e` is checked per event with AgentEvent, so one unknown kind skips that event, not the batch.
 */
export const TaskEvents = z.object({ attempt, session_ref: ref.optional(), from_seq: seq, events: z.array(NodeEvent).max(2000) });
/** acked: the highest seq the hub has (the node drops everything up to it from its spool) */
export const TaskEventsRes = z.object({ acked: seq, dropped: z.boolean().optional() });
export type TaskEvents = z.infer<typeof TaskEvents>;
export type TaskEventsRes = z.infer<typeof TaskEventsRes>;

/**
 * POST /node/v1/tool-calls — an agent on the node calls one of the hub's tools through the sbot MCP (02 Y2).
 * Idempotent on task_id:attempt:tool_call_id. No task_id = an agent I started myself (ad hoc, 05 反向开放): 403
 * unless console.yaml mcp_open.
 */
export const ToolCall = z.object({
  task_id: taskId.optional(), attempt: attempt.optional(), tool_call_id: z.string().min(1).max(200),
  name: z.string().min(1).max(100), args: z.unknown(),
});
export const ToolCallRes = z.object({ text: z.string(), is_error: z.boolean().optional() });
export type ToolCall = z.infer<typeof ToolCall>;
export type ToolCallRes = z.infer<typeof ToolCallRes>;

/** POST /node/v1/permissions — a permission request or an ask (§办3.3) → a glance / ask card. Waits without a timeout. */
export const PermissionPost = z.object({
  task_id: taskId, attempt, session_ref: ref.optional(), request_id: z.string().min(1).max(200),
  /** permission | ask; absent = permission */
  kind: z.string().optional(),
  title: z.string().max(2000), detail: z.unknown(), options: z.array(PermissionOption),
});
/** approval_id: the card; stale: the attempt is old, nobody will be asked */
export const PermissionPostRes = z.object({ approval_id: z.number().int().optional(), stale: z.boolean().optional() });
export type PermissionPost = z.infer<typeof PermissionPost>;

/** One session as the node sees it. state: running | idle | waiting (a permission or ask is open) | released */
export const SessionState = z.object({
  ref, task_id: taskId.optional(), attempt: attempt.optional(), agent: z.string(), state: z.string(),
  cwd: z.string().optional(), pid: z.number().int().optional(), pending: z.number().int().nonnegative().optional(),
});
export type SessionState = z.infer<typeof SessionState>;

/** POST /node/v1/status — between heartbeats, when something changed. state: online | draining */
export const NodeStatus = z.object({
  sessions: z.array(SessionState), quotas: z.record(z.string(), z.unknown()),
  state: z.string().optional(),
});
export type NodeStatus = z.infer<typeof NodeStatus>;

/** POST /node/v1/blobs — upload a large payload in pieces (same 512 KiB as reads); the hub checks the sha at the end. */
export const BlobPut = z.object({
  sha: z.string().regex(/^[0-9a-f]{64}$/), offset: z.number().int().nonnegative(), data_b64: z.string(),
  /** the whole size; the piece that reaches it completes the blob */
  total: z.number().int().nonnegative(),
});
/** done: the blob is complete and the sha matched; next_offset: where the hub wants the next piece */
export const BlobPutRes = z.object({ done: z.boolean(), next_offset: z.number().int().nonnegative() });
export type BlobPut = z.infer<typeof BlobPut>;

// ── hub → node ──────────────────────────────────────────────────────────────────────────────────────────────────

/** Where a task's worktree goes when the hub asked for one (another task already runs in this repo on this node, 05). */
export const WorktreeSpec = z.object({ repo: z.string(), branch: z.string().optional() });

/**
 * POST /node/v1/sessions — open a session (or resume one: resume_ref). `handoff` is the text the hub assembled when
 * the task changed machine or agent (§办3.4); it goes in front of the prompt. agent: claude | codex | pi | acp:<name>
 */
export const SessionOpen = z.object({
  task_id: taskId, attempt, agent: z.string().min(1).max(100), cwd: z.string(),
  worktree: WorktreeSpec.optional(), prompt: z.string(), resume_ref: ref.optional(), handoff: z.string().optional(),
  /** host | sandbox: only for Claude Code on a Linux node (sbot-h / sbot-w) */
  mode: z.string().optional(),
  /** the hub's tools for this session's sbot MCP (same shape as HelloRes.tools); absent = what hello gave */
  tools: z.array(z.object({ name: z.string(), description: z.string(), schema: z.unknown() })).optional(),
});
export const SessionOpenRes = z.object({
  session_ref: ref,
  /** where the agent runs: a worktree path when one was made */
  workdir: z.string(),
  worktree: z.object({ path: z.string(), repo: z.string(), branch: z.string() }).optional(),
  /** resume_ref couldn't be resumed: this is a new session (the hub then writes a handoff) */
  fresh: z.boolean().optional(),
});
export type SessionOpen = z.infer<typeof SessionOpen>;
export type SessionOpenRes = z.infer<typeof SessionOpenRes>;

/** POST /node/v1/sessions/:ref/turns { text } and /steer { text }; /interrupt has no body. */
export const TurnReq = z.object({ text: z.string(), attempt: attempt.optional() });
/** steer: applied = the agent takes it this turn; false = it waits for the next turn (ACP), and the UI says so */
export const SteerRes = z.object({ applied: z.boolean() });
export type SteerRes = z.infer<typeof SteerRes>;

/** DELETE /node/v1/sessions/:ref — idle release. 409 with { error } when it has work or an open permission. */
export const ReleaseRes = z.object({ released: z.boolean() });

/** POST /node/v1/permissions/:request_id — I answered the glance / ask card. */
export const PermissionAnswer = z.object({
  task_id: taskId.optional(), attempt: attempt.optional(),
  option_id: z.string().max(200).optional(), text: z.string().max(20000).optional(),
  /** ask (AskUserQuestion): question → answer */
  answers: z.record(z.string(), z.string()).optional(),
});
export type PermissionAnswer = z.infer<typeof PermissionAnswer>;
/** gone: no such request any more (the agent restarted); the hub then resumes and asks again */
export const PermissionAnswerRes = z.object({ ok: z.boolean(), gone: z.boolean().optional() });

/** POST /node/v1/git/checks — one CI look at a PR with the node's own gh login (§办3.4). */
export const GitChecks = z.object({ repo: z.string().optional(), pr: z.string().max(500) });
export const CheckRun = z.object({ name: z.string(), state: z.string(), link: z.string().optional() });
export const GitChecksRes = z.object({
  /** open | merged | closed */
  state: z.string(),
  /** pending | green | red | none */
  ci: z.string(),
  head_sha: z.string().optional(),
  checks: z.array(CheckRun),
  /** red: the failing jobs' log tail, for the wake-up turn */
  failed_log: z.string().optional(),
});
export type GitChecksRes = z.infer<typeof GitChecksRes>;

/** POST /node/v1/worktrees/cleanup — I pressed 清理. The branch stays (it may carry a PR) ※. */
export const WorktreeCleanup = z.object({ path: z.string() });
export const WorktreeCleanupRes = z.object({ removed: z.boolean(), error: z.string().optional() });
