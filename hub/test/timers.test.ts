// W1e timers: the `check` contract, upstream retry, follow-ups and Sentinel's dedupe. Fictional data only.
import { test } from "node:test";
import assert from "node:assert/strict";
import { ambientHome } from "./helpers.ts";
import { all, kvGet, kvSet, one, run } from "../src/db/ambient.ts";
import { Scheduler, addFollowup, cancelFollowup, listFollowups, nextDue, OWNER_LANE, type CheckRunner } from "../src/timers/schedule.ts";
import { classifyUpstream, nextAttempt, parseReset, retryDeadline } from "../src/timers/retry.ts";
import { Sentinel } from "../src/timers/sentinel.ts";
import { setAdminSink } from "../src/notify.ts";

const JOBS = "watch:\n  every: day\n  at: \"09:00\"\n  do: event\n  text: 看一眼\n  check: ./has-news\n";
const settle = async () => { for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r)); };

async function due(check?: CheckRunner) {
  await ambientHome("timers", { "jobs.yaml": JOBS });
  kvSet("channels.feishu.owner_dm_chat", "oc_dmfake000001");
  const notes: string[] = [];
  setAdminSink((t) => { notes.push(t); });
  const s = new Scheduler({ check });
  s.syncJobs();
  run("UPDATE timers SET due_at=? WHERE kind='schedule'", Date.now() - 1000);
  s.tick();
  await settle();
  const inbox = all("SELECT * FROM inbox WHERE source='job'");
  return { notes, inbox, last: JSON.parse(kvGet("job.watch.last") ?? "null") };
}

test("check: exit 0 and no output → skipped_by_check, no run", async () => {
  const r = await due(async () => ({ code: 0, stdout: "  \n", stderr: "" }));
  assert.equal(r.inbox.length, 0);
  assert.equal(r.last.outcome, "skipped_by_check");
  assert.equal(r.notes.length, 0);
});

test("check: exit 0 with output → the output goes into the run", async () => {
  const r = await due(async (cmd) => ({ code: 0, stdout: `2 new from ${cmd}`, stderr: "" }));
  assert.equal(r.inbox.length, 1);
  const p = JSON.parse(r.inbox[0].payload_json);
  assert.equal(p.check.out, "2 new from ./has-news");
  assert.equal(p.text, "看一眼");
  assert.equal(JSON.parse(r.inbox[0].turn_ctx_json).lane, OWNER_LANE);
});

test("check: any other exit → run anyway with the code and 2 KB of stderr, plus an ops notice", async () => {
  const r = await due(async () => ({ code: 3, stdout: "", stderr: "e".repeat(5000) }));
  assert.equal(r.inbox.length, 1);
  const p = JSON.parse(r.inbox[0].payload_json);
  assert.equal(p.check.broken, true);
  assert.equal(p.check.code, 3);
  assert.equal(p.check.stderr.length, 2048);
  assert.equal(r.notes.length, 1);
  assert.match(r.notes[0]!, /check 坏了.*watch/);
});

test("check: no local node to run it → treated as broken, never run some other way", async () => {
  const r = await due(undefined);
  assert.equal(r.inbox.length, 1);
  assert.equal(JSON.parse(r.inbox[0].payload_json).check.code, -1);
  assert.equal(r.notes.length, 1);
});

test("follow-ups and next due", async () => {
  await ambientHome("followups");
  const id = addFollowup({ lane: "l", turn: { lane: "l", surface: "feishu:dm", src: "x", msg_id: "om_q" }, due: Date.now() - 1, note: "问报价", by: "owner" });
  assert.equal(listFollowups("l").length, 1);
  const s = new Scheduler();
  s.tick();
  const row = one("SELECT * FROM inbox WHERE source='timer'")!;
  assert.match(JSON.parse(row.payload_json).text, /问报价/);
  assert.equal(JSON.parse(row.turn_ctx_json).msg_id, undefined, "a reminder doesn't quote the old message");
  assert.equal(cancelFollowup(id), false, "already done");
  const t = nextDue({ every: "week", weekday: 1, at: "08:30", do: "event" }, Date.UTC(2026, 10, 25, 0, 0));   // a Wednesday
  assert.equal(new Date(t!).toISOString(), "2026-11-30T00:30:00.000Z");
});

test("retry: classify, back off, give up at the deadline", () => {
  const now = Date.UTC(2026, 10, 28, 3, 0);
  assert.deepEqual(classifyUpstream("HTTP 529 overloaded"), { kind: "transient" });
  assert.equal(classifyUpstream("budget exhausted for run"), undefined, "our own refusal");
  assert.equal(classifyUpstream("invalid_request_error: bad"), undefined);
  assert.equal(classifyUpstream("You've hit your weekly limit")?.kind, "limit");
  assert.ok(parseReset("resets 11pm (Asia/Singapore)", now)! > now);
  const deadline = retryDeadline(now, now + 3 * 3600_000);
  assert.equal(deadline, now + 2 * 3600_000);
  assert.equal(nextAttempt({ kind: "transient" }, 1, deadline, now), now + 2 * 60_000);
  assert.equal(nextAttempt({ kind: "transient" }, 9, deadline, now), now + 30 * 60_000);
  assert.equal(nextAttempt({ kind: "transient" }, 1, now, now), undefined);
});

test("Sentinel: one alert per finding, security apart from ops, again after recovery", async () => {
  await ambientHome("sentinel");
  const now = Date.now();
  run("INSERT INTO approvals(kind, title, status, ts) VALUES('send','回复客户','pending',?)", now - 3 * 3600_000);
  run("INSERT INTO runs(id, lane, role, status, started) VALUES('r_stuck','l','main','running',?)", now - 30 * 60_000);
  run("INSERT INTO outbox(channel, target_json, payload, status, ts) VALUES('feishu','{}','x','failed',?)", now - 1000);
  kvSet("job.dream.last", JSON.stringify({ at: now - 1000, outcome: "failed", err: "boom" }));
  const sent: [string, string][] = [];
  const s = new Sentinel({ userReady: async () => false, alert: (cat, text) => { sent.push([cat, text]); } });
  await s.tick();
  assert.deepEqual(sent.map(([c]) => c), ["alert_security", "alert_ops"]);
  assert.match(sent[0]![1], /飞书用户授权/);
  for (const w of ["审批 #1", "一轮对话", "没发出去", "dream"]) assert.ok(sent[1]![1].includes(w), w);
  await s.tick();
  assert.equal(sent.length, 2, "no repeat inside the window");
  run("UPDATE approvals SET status='approved'");
  await s.tick();
  assert.ok(!(JSON.parse(kvGet("sentinel.state")!) as Record<string, number>)["appr.1"], "recovered key cleared");
  run("UPDATE approvals SET status='pending'");
  await s.tick();
  assert.equal(sent.length, 3, "fails again → alerts again");
  assert.ok(JSON.parse(kvGet("sentinel.findings")!).length >= 4);
});
