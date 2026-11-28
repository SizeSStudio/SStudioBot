import { test } from "node:test";
import assert from "node:assert/strict";
import { AgentEvent, PermissionPost, SessionOpen, TaskEvents, ToolCall } from "../node/v1.ts";
import { Hello, HelloRes } from "../node/hello.ts";
import { Node, Task } from "../api/entities.ts";
import { TaskStart } from "../api/tasks.ts";
import { SCHEMAS } from "../schemas.ts";

test("every unified event kind parses; an unknown kind is rejected per event, not per batch", () => {
  const evs = [
    { k: "text", item: "m1", delta: "he" }, { k: "message", item: "m1", text: "hello" },
    { k: "tool_start", item: "c1", name: "Bash", args: { command: "ls" } }, { k: "tool_end", item: "c1", ok: true, diff: "+x" },
    { k: "permission", request: { id: "p1", kind: "permission", title: "Bash", detail: { command: "rm -rf build" }, options: [{ id: "allow", label: "允许" }] } },
    { k: "ask", request: { id: "q1", kind: "ask", title: "Which?", detail: {}, options: [] } },
    { k: "turn_end", stop: "done" }, { k: "usage", input_tokens: 10, output_tokens: 3 }, { k: "quota", resets_at: 1_800_000_000_000 },
    { k: "progress", text: "step 2" }, { k: "session", ref: "s-1" }, { k: "pr", url: "https://git.example.invalid/o/r/pull/1" },
  ];
  for (const e of evs) assert.ok(AgentEvent.safeParse(e).success, JSON.stringify(e));
  const batch = TaskEvents.parse({ attempt: 1, from_seq: 0, events: [{ seq: 0, ts: 1, e: { k: "future_kind" } }] });
  assert.equal(AgentEvent.safeParse(batch.events[0]!.e).success, false);
});

test("task ids, attempts and tool calls are checked", () => {
  assert.equal(PermissionPost.safeParse({ task_id: "x1", attempt: 1, request_id: "r", title: "", detail: null, options: [] }).success, false);
  assert.equal(PermissionPost.safeParse({ task_id: "t12", attempt: 0, request_id: "r", title: "", detail: null, options: [] }).success, false);
  assert.ok(ToolCall.safeParse({ tool_call_id: "c", name: "memory_search", args: {} }).success);   // ad hoc: no task
  assert.ok(SessionOpen.safeParse({ task_id: "t3", attempt: 2, agent: "acp:gemini", cwd: "/tmp/x", prompt: "hi", resume_ref: "abc" }).success);
});

test("W4 fields are optional: an older hub's or node's messages still parse", () => {
  assert.ok(Hello.safeParse({ version: 1, sha: "dev", os: "linux", agents: [], capabilities: {}, quotas: {} }).success);
  assert.ok(HelloRes.safeParse({ target_sha: "dev", min_version: 1 }).success);
  const old = { id: "t1", origin_lane: null, goal: "g", status: "running", repo: null, node: null, agent: null, attempt: 1, turn: 0,
    quota_until: null, result: null, diff_blob: null, error: null, matter_id: null, started: null, ended: null, ts: 1 };
  assert.ok(Task.safeParse(old).success);
  assert.ok(Task.safeParse({ ...old, needs_you: true, prs: [], worktrees: [], sessions: [], diff_stat: { files: [], added: 0, removed: 0 } }).success);
  assert.ok(Node.safeParse({ id: "local", name: "本机", platform: null, os: "linux", version: null, sha: null, target_sha: null, status: "online",
    status_at: null, agents: [], caps: {}, quotas: {}, max_parallel: null, upgrade_failed: null, running: 0, cleanable: 0 }).success);
  assert.equal(TaskStart.safeParse({ goal: "   " }).success, false);
});

test("the W4 schemas are registered for protocol-check", () => {
  for (const k of ["node.task_events", "node.permission", "node.session.open", "api.tasks.start", "api.nodes.res", "entity.node"]) assert.ok(SCHEMAS[k], k);
});
