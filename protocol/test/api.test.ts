import { test } from "node:test";
import assert from "node:assert/strict";
import { ENTITY_DATA, ENTITY_NAMES, Thread } from "../api/entities.ts";
import { BootstrapRes, StreamRes } from "../api/stream.ts";
import { BlobRes, ThreadItemsRes } from "../api/read.ts";
import { ENTITIES, SCHEMAS } from "../schemas.ts";
import { parseFrame } from "../frames.ts";

const thread = { id: "th_k3x9a1b2", lane: "console:main", kind: "general", domain: "personal", title: null, matter_id: null, task_id: null,
  status: "open", pinned: false, created_at: 1_700_000_000_000, last_item_at: null };

test("every entity is registered for protocol-check", () => {
  assert.deepEqual([...ENTITIES].sort(), [...ENTITY_NAMES].sort());
  for (const e of ENTITY_NAMES) assert.equal(SCHEMAS[`entity.${e}`], ENTITY_DATA[e]);
});

test("unknown fields and unknown status values don't break an older client", () => {
  const t = Thread.parse({ ...thread, status: "some_future_status", future: 1 });
  assert.equal(t.status, "some_future_status");
  assert.equal("future" in t, false);
});

test("a bootstrap, a page and a blob chunk parse", () => {
  const boot = BootstrapRes.parse({ seq: 7, threads: [thread], timelines: { [thread.id]: { entries: [{ entity: "input", id: "3", ts: 1, data: {} }], next_before: null } },
    runs: [], approvals: [], tasks: [], devices: [] });
  assert.equal(boot.timelines[thread.id]!.entries.length, 1);
  assert.equal(ThreadItemsRes.parse({ seq: 7, thread, entries: [], next_before: "1.0.3" }).next_before, "1.0.3");
  assert.equal(BlobRes.parse({ data_b64: "", total: 0, next_offset: null }).next_offset, null);
  assert.equal(StreamRes.parse({ seq: 0, reset: true }).reset, true);
});

test("snapshot frames may say how many chunks they hold", () => {
  const f = parseFrame(JSON.stringify({ t: "snapshot", run: "r_1", item: "r_1:a0", text: "hi", chunk_seq: 3 }));
  assert.equal(f?.t === "snapshot" && f.chunk_seq, 3);
  assert.ok(parseFrame(JSON.stringify({ t: "snapshot", run: "r_1", item: "r_1:a0", text: "hi" })));
});

test("W3 writes: every write has a kind, bodies parse, old clients ignore the new fields", async () => {
  const { WRITES, DecideReq, CLIENT_OP_ID, Conflict, MessageReq, ThreadCreateReq } = await import("../api/write.ts");
  const { PresenceReq, ReadReq, PushTokenReq, PushData } = await import("../api/push.ts");
  for (const [route, w] of Object.entries(WRITES)) assert.match(route, /^(POST|PUT|PATCH|DELETE) \/api\/v1\//, route), assert.ok(w.kind);
  assert.equal(WRITES["POST /api/v1/approvals/:id/decide"]!.kind, "confirmed");
  assert.equal(WRITES["POST /api/v1/approvals/:id/decide"]!.locked, true);
  assert.ok(CLIENT_OP_ID.safeParse("6f1c0b6e-2f0a-4a51-9b39-0d4c7f2e8a11").success);
  assert.equal(CLIENT_OP_ID.safeParse("x").success, false);
  assert.equal(DecideReq.safeParse({ action: "answer", draft_version: 1, option_id: "allow_once" }).success, true);
  assert.equal(DecideReq.safeParse({ action: "approve" }).success, false, "draft_version is required");
  assert.equal(MessageReq.safeParse({ text: "" }).success, false);
  assert.equal(ThreadCreateReq.safeParse({ domain: "owner" }).success, false);
  assert.equal(Conflict.parse({ error: "草稿改过了" }).error, "草稿改过了");
  assert.equal(PresenceReq.safeParse({ foreground: true, viewing: "thread:th_k3x9a1b2" }).success, true);
  assert.equal(PresenceReq.safeParse({ foreground: true, viewing: "not a ref" }).success, false);
  assert.equal(ReadReq.safeParse({ entity: "approval", id: "12" }).success, true);
  assert.equal(PushTokenReq.safeParse({ token: null }).success, true);
  assert.equal(PushData.safeParse({ ref: "approval:12", cat: "approval", channel: "approval", personal: "0", push_id: "7" }).success, true);
  // a W2 hub's thread / bootstrap still parses with the W3 schemas (all new fields optional)
  assert.equal(Thread.parse(thread).mainline_id, undefined);
  assert.ok(BootstrapRes.parse({ seq: 0, threads: [], timelines: {}, runs: [], approvals: [], tasks: [], devices: [] }));
});
