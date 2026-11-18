// Scheduled runs against upstream failures, the tier fallback, and 未聊 written by code (DESIGN §5.3, §9.4, §15.5).
// On the VPS, as sbot, on a fresh throwaway home:
//
//   ssh <server> 'bash -s -- retry-smoke.ts 7829' < test/vps-test-home.sh
//
// The real proxy and the real pi runner talk to a fake upstream in this process; the home's models.yaml and secrets are
// replaced with made-up ones, so nothing reaches a real model or chat. Every person and message here is invented.

import http from "node:http";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const home = process.env.SBOT_HOME!;
if (!home || home === "/srv/sbot") throw new Error("run this on a throwaway SBOT_HOME");
process.env.SBOT_SECRETS = join(home, "fake-secrets.env");   // before config.ts loads: the real secrets stay out of this test
process.env.SBOT_STREAM_CARDS = "0";
writeFileSync(process.env.SBOT_SECRETS, "FAKE_KEY=fake-key\nOTHER_KEY=other-key\n");

const ok = (cond: unknown, what: string) => { console.log(`${cond ? "PASS" : "FAIL"} ${what}`); if (!cond) process.exitCode = 1; };

// ── the fake upstream ──
type Mode = "ok" | "busy" | "weekly" | "weekly_in_stream" | "bad_request" | "down";
const up = { mode: "ok" as Mode, byModel: {} as Record<string, Mode>, reset: "", seen: [] as { model: string; body: string; key: string }[] };
const sse = (model: string, text: string) => [
  ["message_start", { type: "message_start", message: { id: "msg_fake", type: "message", role: "assistant", model, content: [], stop_reason: null, usage: { input_tokens: 10, output_tokens: 1 } } }],
  ["content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }],
  ["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } }],
  ["content_block_stop", { type: "content_block_stop", index: 0 }],
  ["message_delta", { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 7 } }],
  ["message_stop", { type: "message_stop" }],
].map(([e, d]) => `event: ${e}\ndata: ${JSON.stringify(d)}\n\n`).join("");
const limitMsg = () => `Upstream: You've hit your weekly limit · resets ${up.reset} (Asia/Shanghai)`;
const fake = http.createServer((req, res) => {
  let b = "";
  req.on("data", (d) => { b += d; });
  req.on("end", () => {
    const j = JSON.parse(b || "{}"), model = String(j.model);
    up.seen.push({ model, body: b, key: String(req.headers["authorization"] ?? req.headers["x-api-key"] ?? "") });
    const mode = up.byModel[model] ?? up.mode;
    const err = (status: number, type: string, message: string) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify({ type: "error", error: { type, message } })); };
    if (mode === "down") return void req.socket.destroy();
    if (mode === "busy") return err(429, "rate_limit_error", "Too many requests, slow down");
    if (mode === "weekly") return err(429, "rate_limit_error", limitMsg());
    if (mode === "bad_request") return err(400, "invalid_request_error", "messages: something is malformed");
    if (mode === "weekly_in_stream") {
      res.writeHead(200, { "content-type": "text/event-stream" });
      return void res.end(`event: error\ndata: ${JSON.stringify({ type: "error", error: { type: "api_error", message: `${limitMsg()} (429: you can retry your request)` } })}\n\n`);
    }
    const text = `好的（${model}）。今天的事实：开了两个会。你心里怎么样？`;
    if (j.stream) { res.writeHead(200, { "content-type": "text/event-stream" }); return void res.end(sse(model, text)); }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ id: "msg_fake", type: "message", role: "assistant", model, content: [{ type: "text", text }], usage: { input_tokens: 10, output_tokens: 7 } }));
  });
});
await new Promise<void>((r) => fake.listen(0, "127.0.0.1", () => r()));
const upstream = `http://127.0.0.1:${(fake.address() as any).port}`;

// ── a made-up instance ──
const cfg = join(home, "config");
mkdirSync(cfg, { recursive: true });
const modelsYaml = (fallback = "") => `endpoints:
  main: { base_url: ${upstream}, auth: bearer, key_ref: FAKE_KEY }
  other: { base_url: ${upstream}, auth: x-api-key, key_ref: OTHER_KEY }
tiers:
  chat: { endpoint: main, model: fake-chat, price: { in: 5, out: 25 }${fallback} }
  work: { endpoint: main, model: fake-work, price: { in: 3, out: 15 } }
  light: { endpoint: main, model: fake-light, price: { in: 1, out: 5 } }
  expert: { endpoint: main, model: fake-expert, price: { in: 5, out: 25 } }
budgets: { run_output_tokens: 60000, daily_cost: 100 }
`;
let bump = 0;
const setModels = (fallback = "") => { writeFileSync(join(cfg, "models.yaml"), modelsYaml(fallback) + `# ${++bump}\n`.padEnd(bump + 6, " ")); };   // size changes too: mtime alone can tie
setModels();
writeFileSync(join(cfg, "feishu.yaml"), "admin_chat: oc_fake_admin\n");
const otherDay = (new Date(Date.now() + 8 * 3600_000).getUTCDay() + 3) % 7;
writeFileSync(join(cfg, "jobs.yaml"), `morning: { every: day, at: "08:30", do: morning }
review_day: { every: day, at: "21:30", do: review_day }
review_week: { every: week, weekday: ${otherDay}, at: "20:30", do: review_week }
review_month: { every: month, day: 28, at: "20:00", do: review_month }
ping: { every: day, at: "12:00", do: event, text: "【定时：看一眼今天的安排】" }
flaky: { every: day, at: "12:10", do: flaky }
`);

const { P, PROXY_PORT } = await import("../src/config.ts");
const { all, one, run, kvGet, kvSet } = await import("../src/db.ts");
const { ensureAgentHome, localStamp, appendJournal } = await import("../src/memory.ts");
const { startProxy, issueToken } = await import("../src/proxy.ts");
const { PiRunner } = await import("../src/runner.ts");
const { Dispatcher } = await import("../src/dispatcher.ts");
const { Scheduler, nextDue, OWNER_LANE } = await import("../src/timers.ts");
const R = await import("../src/retry.ts");
const F = await import("../src/reflect.ts");
const { submitReview, timelineText, today, isoWeek, startOfDay } = await import("../src/life.ts");
const { TOOLS } = await import("../src/tools.ts");
const { runDream } = await import("../src/dream.ts");
const { LensEngine } = await import("../src/lens.ts");
for (const d of [P.sessions, P.logs]) mkdirSync(d, { recursive: true });
ensureAgentHome(join(here, "..", "seed", "agent-home"));
kvSet("feishu.owner_dm_chat", "oc_fake_dm");

const MIN = 60_000, H = 3600_000, now0 = Date.now();
const until = async (f: () => unknown, what: string, ms = 90_000) => {
  const t0 = Date.now();
  while (!f()) { if (Date.now() - t0 > ms) { ok(false, `timed out: ${what}`); return false; } await new Promise((r) => setTimeout(r, 100)); }
  return true;
};

// ── 1. telling failures apart ──
{
  const at = Date.parse("2026-11-17T13:30:00Z");   // 21:30 in Asia/Shanghai
  const c = (s: string) => R.classifyUpstream(s, at);
  const w = c(`{"error":{"message":"Upstream: You've hit your weekly limit · resets 11pm (Asia/Singapore) (429: you can retry your request)","type":"api_error"}}`) as any;
  ok(w?.kind === "limit" && w.resetAt === Date.parse("2026-11-17T15:00:00Z"), "weekly limit recognised, reset later today parsed");
  const w2 = c(`light call 429: {"error":{"message":"Upstream: You've hit your weekly limit · resets Nov 19, 2am (Asia/Singapore)","type":"rate_limit_error"}}`) as any;
  ok(w2?.kind === "limit" && w2.resetAt === Date.parse("2026-11-18T18:00:00Z"), "reset with a date parsed");
  ok((c("hit your usage limit · resets 8pm (Asia/Singapore)") as any).resetAt === Date.parse("2026-11-18T12:00:00Z"), "a reset time already past today means tomorrow");
  ok((c("usage limit reached") as any).kind === "limit" && (c("usage limit reached") as any).resetAt === undefined, "limit with no reset");
  for (const s of ["429 Too many requests", "503 Service Unavailable", "overloaded_error: Overloaded", "fetch failed", "read ECONNRESET", "upstream unreachable", "terminated"])
    ok(c(s)?.kind === "transient", `transient: ${s}`);
  for (const s of ["run budget exhausted", "daily budget exhausted", `400 {"type":"invalid_request_error"}`, `401 {"type":"authentication_error"}`, "endpoint for tier chat not configured", "没有交回结果", undefined])
    ok(c(s as any) === undefined, `not retried: ${s}`);

  const dl = at + 2 * H;
  ok(R.nextAttempt({ kind: "transient" }, 1, dl, at) === at + 2 * MIN && R.nextAttempt({ kind: "transient" }, 3, dl, at) === at + 10 * MIN && R.nextAttempt({ kind: "transient" }, 9, dl, at) === at + 30 * MIN, "backoff 2, 5, 10 … 30 min");
  ok(R.nextAttempt({ kind: "limit", resetAt: at + 90 * MIN }, 1, dl, at) === at + 92 * MIN, "limit that clears in time: just after the reset");
  ok(R.nextAttempt({ kind: "limit", resetAt: at + 30 * H }, 1, dl, at) === dl, "limit that won't clear: one last try at the deadline, nothing before");
  ok(R.nextAttempt({ kind: "limit" }, 1, dl, at) === at + 30 * MIN, "limit with no reset: every 30 min");
  ok(R.nextAttempt({ kind: "transient" }, 1, dl, dl) === undefined, "deadline reached: give up");
  ok(R.retryDeadline(at) === dl && R.retryDeadline(at, at + H) === at + 50 * MIN && R.retryDeadline(at, undefined, 12) === at + 12 * H, "deadline: 2 h, before the next firing, retry_hours");
}

// ── 2. the proxy's fallback ──
const proxy = await startProxy();
const call = async (o: { stream?: boolean } = {}) => {
  const runId = `fb_${Math.random().toString(36).slice(2, 9)}`, token = issueToken({ runId, tier: "chat", requester: "system", budgetOutput: 500, ttlMs: 60_000 });
  const r = await fetch(`http://127.0.0.1:${PROXY_PORT}/llm/v1/messages`, {
    method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}`, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({ model: "sbot-chat", max_tokens: 16, stream: !!o.stream, messages: [{ role: "user", content: "hi" }] }),
  });
  return { status: r.status, text: await r.text(), rows: all("SELECT endpoint, model, status, cost, output_tokens FROM usage WHERE run_id=? ORDER BY id", runId) };
};
up.reset = "11pm";
{
  up.mode = "weekly";
  let r = await call();
  ok(r.status === 429 && /weekly limit/.test(r.text) && up.seen.at(-1)!.model === "fake-chat", "no fallback configured: the limit error passes through");
  setModels(", fallback: { endpoint: other, model: fake-spare, price: { in: 1, out: 2 } }");
  up.byModel = { "fake-spare": "ok" };
  up.seen.length = 0;
  r = await call();
  ok(r.status === 200 && r.text.includes("fake-spare"), "limit on the tier's model → answered by the fallback");
  ok(up.seen.map((s) => s.model).join() === "fake-chat,fake-spare" && up.seen[1].key === "other-key", "the fallback uses its own endpoint's credential");
  ok(r.rows.length === 2 && r.rows[0].status === 429 && r.rows[0].output_tokens === 0 && r.rows[1].model === "fake-spare" && r.rows[1].endpoint === "other" && Math.abs(r.rows[1].cost - (10 + 14) / 1e6) < 1e-9, "both attempts in the ledger, spend priced at the fallback's rate");
  up.mode = "weekly_in_stream";
  r = await call({ stream: true });
  ok(r.status === 200 && r.text.includes("message_stop") && !r.text.includes("weekly limit") && r.rows.at(-1)!.model === "fake-spare", "limit inside a 200 stream → fallback too");
  up.mode = "busy";
  up.seen.length = 0;
  r = await call();
  ok(r.status === 429 && up.seen.length === 1, "an ordinary 429 does not switch models");
  up.mode = "ok";
  r = await call({ stream: true });
  ok(r.status === 200 && r.text.includes("fake-chat") && r.rows.length === 1 && r.rows[0].output_tokens === 7, "healthy stream unchanged and metered with a fallback configured");
  up.mode = "weekly"; up.byModel = { "fake-spare": "busy" };
  r = await call();
  ok(r.status === 429 && /weekly limit/.test(r.text), "fallback refuses too → the caller sees the original limit error");
  up.byModel = {}; up.mode = "ok";
  setModels();
}

// ── 3. scheduled runs through the real runner ──
const runner = new PiRunner();
const dispatcher = new Dispatcher(runner, () => {});
const handlerLog: string[] = [];
let flakyFails = 0, morningSawFiled: number | undefined;
const sched = new Scheduler(() => dispatcher.kick(),
  { flaky: async () => { handlerLog.push("run"); if (flakyFails-- > 0) throw new Error(`light call 429: {"error":{"type":"rate_limit_error","message":"Too many requests"}}`); } },
  { morning: () => { morningSawFiled = one("SELECT COUNT(*) n FROM reviews")!.n as number; return "【早报：测试】"; },
    review_day: () => F.reviewDayText(), review_week: () => F.reviewWeekText(), review_month: () => F.reviewMonthText() },
  { opened: F.reviewOpened, notRun: F.reviewNotRun, beforeTick: () => { F.closeDueReviews(); } });
sched.syncJobs();
const fire = (name: string, due = Date.now() - 1000) => { run("UPDATE timers SET due_at=? WHERE kind='schedule' AND note=? AND status='pending'", due, name); sched.tick(); };
const owner = (id: string, text: string, ts = Date.now()) => run("INSERT INTO messages(id, surface, chat_id, sender_id, sender_kind, ts, text, lane) VALUES(?,?,?,?,?,?,?,?)", id, "feishu:dm", "oc_fake_dm", "ou_fake_owner", "owner", ts, text, OWNER_LANE);
const eventOf = (job: string) => all("SELECT * FROM inbox WHERE source='job' AND source_msg_id LIKE ? ORDER BY id DESC", `${job}:%`)[0];
const idle = () => !dispatcher.busyLanes.length;
const settled = (job: string) => until(() => { const e = eventOf(job); return idle() && e && e.status !== "processing"; }, `${job} settled`);
const retryNow = (id: number) => { run("UPDATE inbox SET not_before=? WHERE id=?", Date.now() - 1, id); sched.tick(); };
const deliverAll = () => run("UPDATE outbox SET status='sent' WHERE status='queued' AND lane=?", OWNER_LANE);   // stands in for Feishu
const admin = () => all("SELECT payload FROM outbox WHERE lane='system:admin' ORDER BY id");
const sessionFiles = () => { const d = join(P.sessions, "pi"); return existsSync(d) ? readdirSync(d).length : 0; };
const count = (hay: string, needle: string) => hay.split(needle).length - 1;

owner("m_today", "今天下午那个会开得有点累");

// 429, then fine: nothing visible, retried on the backoff, then delivered
{
  up.mode = "busy"; up.seen.length = 0;
  const filesBefore = sessionFiles();
  fire("review_day");
  await settled("review_day");
  let e = eventOf("review_day"), p = JSON.parse(e.payload_json);
  ok(e.status === "received" && p.retry?.n === 1 && e.not_before > Date.now() && e.not_before <= Date.now() + 2 * MIN + 1000, "429 → event back in the inbox, next try in about 2 min");
  ok(p.retry.deadline === e.ts + 2 * H, "retry window is 2 hours from the firing");
  ok(one("SELECT COUNT(*) n FROM outbox WHERE lane=?", OWNER_LANE)!.n === 0, "the failed attempt said nothing to him");
  ok(sessionFiles() === filesBefore && !one("SELECT session_ref FROM sessions WHERE key=?", OWNER_LANE)?.session_ref, "the failed attempt left no session behind");
  const open = one("SELECT * FROM review_open WHERE kind='day'")!;
  ok(open.deadline === nextDue({ every: "day", at: "08:30", do: "morning" }, open.fired_at), "day review waits until the next morning report");
  const calls = up.seen.length;
  sched.tick(); sched.tick();
  await new Promise((r) => setTimeout(r, 300));
  ok(up.seen.length === calls && eventOf("review_day").status === "received", "not retried before its time");

  // his own message goes through while the event waits
  up.mode = "ok";
  up.mode = "busy"; retryNow(e.id);
  await until(() => idle() && JSON.parse(eventOf("review_day").payload_json).retry?.n === 2, "second failure");
  e = eventOf("review_day");
  ok(e.not_before > Date.now() + 4 * MIN, "second failure backs off further (5 min)");

  up.mode = "ok"; up.seen.length = 0;
  retryNow(e.id);
  await until(() => idle() && eventOf("review_day").status === "done", "retry succeeds");
  const said = all("SELECT payload FROM outbox WHERE lane=? ORDER BY id", OWNER_LANE);
  ok(said.length === 1 && said[0].payload.includes("开了两个会"), "after the retry the review reaches him, once");
  ok(count(up.seen.at(-1)!.body, "【日复盘") === 1, "the event text is in the model's context once, not once per attempt");
  ok(up.seen.at(-1)!.body.includes("推迟到现在"), "the model is told the event is late");
  ok(/done after 2/.test(JSON.parse(kvGet("job.review_day.last")!).outcome), "job status says it took retries");
  deliverAll();
}

// retry on a session that already exists: the file goes back to what it was
{
  const ref = one("SELECT session_ref FROM sessions WHERE key=?", OWNER_LANE)!.session_ref as string;
  const before = readFileSync(ref, "utf8");
  up.mode = "down"; up.seen.length = 0;
  fire("review_week");
  await settled("review_week");
  let e = eventOf("review_week");
  ok(e.status === "received" && JSON.parse(e.payload_json).retry?.n === 1, "connection failure is retried too");
  ok(readFileSync(ref, "utf8") === before, "existing session restored after the failed attempt");
  up.mode = "ok"; up.seen.length = 0;
  retryNow(e.id);
  await until(() => idle() && eventOf("review_week").status === "done", "week review retried");
  const body = up.seen.at(-1)!.body;
  ok(count(body, "【周复盘") === 1 && count(body, "【日复盘") === 1, "resumed conversation holds each event once");
  deliverAll();
}

// a long limit: no hammering, one try at the deadline, one notice
{
  const far = new Date(Date.now() + 3 * 86400_000 + 8 * H);
  up.reset = `${far.toUTCString().slice(8, 11)} ${far.getUTCDate()}, 2am`;
  up.mode = "weekly"; up.seen.length = 0;
  fire("review_month");
  await settled("review_month");
  let e = eventOf("review_month"), p = JSON.parse(e.payload_json);
  ok(e.status === "received" && e.not_before === p.retry.deadline, "limit past the window: next try is the deadline, none before");
  const calls = up.seen.length;
  for (let i = 0; i < 5; i++) sched.tick();
  await new Promise((r) => setTimeout(r, 300));
  ok(up.seen.length === calls, "no calls while waiting");
  ok(admin().length === 0, "no notice yet");
  // the window ends
  run("UPDATE inbox SET not_before=?, payload_json=? WHERE id=?", Date.now() - 1, JSON.stringify({ ...p, retry: { ...p.retry, deadline: Date.now() - 1 } }), e.id);
  sched.tick();
  await until(() => idle() && eventOf("review_month").status === "failed", "gave up");
  ok(JSON.parse(kvGet("job.review_month.last")!).outcome === "gave_up", "job status: gave_up");
  ok(admin().length === 1 && admin()[0].payload.includes("review_month") && admin()[0].payload.includes("上限"), "one notice to the admin group, says why");
  ok(!one("SELECT 1 FROM outbox WHERE lane=? AND payload LIKE '%出错%'", OWNER_LANE), "nothing about it in his DM");
  const after = up.seen.length;
  for (let i = 0; i < 5; i++) sched.tick();
  await new Promise((r) => setTimeout(r, 300));
  ok(up.seen.length === after && admin().length === 1, "after giving up: no more calls, no more notices");
  up.mode = "ok";
}

// what must NOT be retried
{
  up.mode = "bad_request";
  fire("ping");
  await settled("ping");
  let e = eventOf("ping");
  ok(e.status === "failed" && !e.not_before, "a request the upstream rejects is not retried");
  run("DELETE FROM outbox WHERE lane=? AND status='queued'", OWNER_LANE);

  // his own message fails as before; a timer event in the same batch waits
  up.mode = "busy";
  const t = Date.now();
  const add = (kind: string, source: string, id: string, text: string) => run(`INSERT INTO inbox(lane, kind, source, source_msg_id, turn_ctx_json, payload_json, status, ts) VALUES(?,?,?,?,?,?,?,?)`,
    OWNER_LANE, kind, source, id, JSON.stringify({ channel: "feishu", chat_id: "oc_fake_dm", surface: "feishu:dm" }), JSON.stringify({ text, ts: t }), "received", t);
  add("user", "feishu", "om_fake_mixed", "在吗");
  add("timer", "timer", "99:1", "【到点了】看一眼");
  dispatcher.kick();
  await until(() => idle() && one("SELECT status FROM inbox WHERE source_msg_id='om_fake_mixed'")!.status === "failed", "mixed batch");
  const tm = one("SELECT * FROM inbox WHERE source_msg_id='99:1'")!;
  ok(tm.status === "received" && tm.not_before > Date.now(), "mixed batch: the timer event waits for a retry");
  ok(one("SELECT 1 FROM outbox WHERE lane=? AND status='queued' AND payload LIKE '%模型调用出错%'", OWNER_LANE), "mixed batch: he is told his message failed, as before");
  run("UPDATE inbox SET status='dropped' WHERE id=?", tm.id);
  run("DELETE FROM outbox WHERE lane=? AND status='queued'", OWNER_LANE);
  up.mode = "ok";

  // an attempt that already did something is never run again
  const stub = (r: Record<string, unknown>) => new Dispatcher({ run: async () => ({ text: "", fullText: "", sessionRef: join(P.sessions, "pi", "stub.jsonl"), stop: "error", error: "429 Too many requests", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, toolCalls: [], ...r }) } as any, () => {});
  for (const [label, r] of [["wrote something", { toolCalls: ["memory_read", "outlook_submit"] }], ["already said something", { fullText: "今天的事实：" }]] as const) {
    const id = `stub:${label}`;
    add("timer", "timer", id, "【到点了】测试");
    const d = stub(r);
    d.kick();
    await until(() => !d.busyLanes.length && one("SELECT status FROM inbox WHERE source_msg_id=?", id)!.status !== "processing", label);
    ok(one("SELECT status FROM inbox WHERE source_msg_id=?", id)!.status === "failed", `attempt that ${label}: not retried`);
    run("DELETE FROM outbox WHERE lane=? AND status='queued'", OWNER_LANE);
  }
  run("DELETE FROM sessions WHERE session_ref LIKE '%stub.jsonl'");
  const id = "stub:read-only";
  add("timer", "timer", id, "【到点了】测试");
  const d = stub({ toolCalls: ["memory_read", "timeline_query"] });
  d.kick();
  await until(() => !d.busyLanes.length && one("SELECT status FROM inbox WHERE source_msg_id=?", id)!.status !== "processing", "read-only");
  ok(one("SELECT status FROM inbox WHERE source_msg_id=?", id)!.status === "received", "attempt that only read: retried");
  run("UPDATE inbox SET status='dropped' WHERE source_msg_id=?", id);
}

// code jobs
{
  const before = admin().length;
  flakyFails = 1; handlerLog.length = 0;
  fire("flaky");
  await until(() => kvGet("job.flaky.retry"), "handler retry planned");
  const plan = JSON.parse(kvGet("job.flaky.retry")!);
  ok(plan.n === 1 && plan.at > Date.now() && JSON.parse(kvGet("job.flaky.last")!).outcome === "retrying (1)", "code job that hit a 429 is planned for a retry");
  sched.tick();
  await new Promise((r) => setTimeout(r, 100));
  ok(handlerLog.length === 1, "and waits for its time");
  kvSet("job.flaky.retry", JSON.stringify({ ...plan, at: Date.now() - 1 }));
  sched.tick();
  await until(() => JSON.parse(kvGet("job.flaky.last")!).outcome === "done", "handler retried");
  ok(handlerLog.length === 2 && !kvGet("job.flaky.retry"), "retried once, plan cleared");
  flakyFails = 9;
  kvSet("job.flaky.retry", JSON.stringify({ at: Date.now() - 1, due: Date.now() - H, n: 3, deadline: Date.now() - 1 }));
  sched.tick();
  await until(() => JSON.parse(kvGet("job.flaky.last")!).outcome === "gave_up", "handler gave up");
  ok(admin().length === before + 1 && admin().at(-1)!.payload.includes("flaky") && !kvGet("job.flaky.retry"), "code job past its window: one notice, no plan left");

  // dream keeps its place when the upstream failed it
  appendJournal("今天记了一件测试的事", "system");
  const mark = "12345";
  kvSet("dream.last_at", mark);
  const failing = { run: async () => ({ text: "", fullText: "", sessionRef: "", stop: "error", error: "429 Too many requests", usage: {}, toolCalls: [] }) } as any;
  let threw = false;
  try { await runDream(failing); } catch { threw = true; }
  ok(threw && kvGet("dream.last_at") === mark, "dream failed by the upstream: rethrown, its journal lines are not skipped");

  // a month reading queued by the job waits; one he asked for fails as before
  const reading = (by: string) => Number(run("INSERT INTO readings(ts, lens, method, status, requested_by) VALUES(?,?,?,?,?)", Date.now(), "ziwei", "month", "running", by).lastInsertRowid);
  const lens = new LensEngine() as any;
  const a = reading("job");
  lens.fail(one("SELECT * FROM readings WHERE id=?", a), "API Error: 429 Too many requests");
  const ra = one("SELECT * FROM readings WHERE id=?", a)!;
  ok(ra.status === "queued" && ra.not_before > Date.now() && ra.retries === 1, "month reading hit by a 429 is queued again for later");
  const b = reading("owner");
  lens.fail(one("SELECT * FROM readings WHERE id=?", b), "API Error: 429 Too many requests");
  ok(one("SELECT status FROM readings WHERE id=?", b)!.status === "failed", "a reading he asked for is not retried behind his back");
  run("UPDATE readings SET status='done' WHERE id IN (?,?)", a, b);
  run("DELETE FROM inbox WHERE source='lens'");
}

// ── 4. 未聊 written by code ──
const reviews = (kind: string, period: string) => all("SELECT * FROM reviews WHERE kind=? AND period=? ORDER BY id", kind, period);
const expire = (kind: string) => run("UPDATE review_open SET deadline=? WHERE kind=?", Date.now() - 1, kind);
const day = today(), week = isoWeek();
{
  ok(F.closeDueReviews() === 0 && reviews("day", day).length === 0, "before the deadline nothing is written");

  // the month review was given up on: recorded as not sent, with code's facts
  const m = one("SELECT period FROM review_open WHERE kind='month'")!.period as string;
  expire("month");
  F.closeDueReviews();
  const [nm] = reviews("month", m);
  ok(nm?.status === "unchatted" && nm.delivery === "not_sent" && nm.facts.includes("时间线") && nm.owner_words === "[]" && !nm.agent_notes, "given-up review: recorded as not sent, with the facts code gathered");
  const mdoc = readFileSync(join(P.agentHome, nm.file_path), "utf8");
  ok(mdoc.includes("没发出去") && mdoc.includes("模型调用失败"), "the page says it never went out and why");

  // day review: sent, no answer. The morning report is written after the record exists.
  expire("day");
  morningSawFiled = undefined;
  const filedBefore = one("SELECT COUNT(*) n FROM reviews")!.n as number;
  fire("morning");
  ok(morningSawFiled === filedBefore + 1, "the record exists before the morning report gathers its facts");
  await settled("morning");
  run("DELETE FROM outbox WHERE lane=? AND status='queued'", OWNER_LANE);
  const [d] = reviews("day", day);
  ok(d?.status === "unchatted" && d.delivery === "sent" && d.facts.includes("开了两个会"), "no reply by the deadline: 未聊, with the draft he was shown");
  ok(d.owner_words === "[]" && !d.agent_notes, "the heart part stays empty");
  ok(!one("SELECT 1 FROM review_open WHERE kind='day'"), "no longer waiting");
  ok(timelineText({ from: startOfDay(), to: Date.now() + 1000, kinds: ["review"] }).includes("（未聊）"), "the timeline shows 未聊");
  F.closeDueReviews();
  ok(reviews("day", day).length === 1, "not written twice");

  // he comes back to it later: the real conversation replaces the placeholder
  const empty = submitReview({ kind: "day", period: day, facts: "x", ownerWords: [], noticings: [], questions: [], runId: "t" });
  ok(empty.id === d.id && reviews("day", day).length === 1, "an empty filing after code's record adds nothing");
  submitReview({ kind: "day", period: day, facts: "开了两个会", ownerWords: ["其实是我没睡好"], noticings: [], questions: [], runId: "t" });
  const after = reviews("day", day);
  ok(after.length === 1 && after[0].status === "chatted" && after[0].delivery === null, "a later real conversation replaces code's record");

  // he answered and the agent filed it: nothing more is written
  const tool = TOOLS.find((t) => t.name === "review_submit")!;
  const out = await tool.exec({ kind: "week", period: week, facts: "这周开了两个会", owner_words: ["这周还行"], noticings: [], questions: [] } as any, { runId: "r_t" } as any);
  ok(String(out).includes("落档"), "review_submit files the week review");
  expire("week");
  F.closeDueReviews();
  const w = reviews("week", week);
  ok(w.length === 1 && w[0].status === "chatted" && !one("SELECT 1 FROM review_open WHERE kind='week'"), "replied + review_submit: no second record");
}
{
  // answered, but nothing was filed: no invented words
  const period = "2026-W01";
  const runId = one("SELECT run_id FROM inbox WHERE source='job' AND source_msg_id LIKE 'review_day:%' ORDER BY id DESC")!.run_id as string;
  const ended = one("SELECT ended FROM runs WHERE id=?", runId)!.ended as number;
  run("INSERT INTO review_open(kind, period, facts, fired_at, deadline, run_id) VALUES(?,?,?,?,?,?)", "week", period, "（备用事实）", ended - 1000, Date.now() - 1, runId);
  owner("m_answer", "这周我不太想说", ended + 1);
  F.closeDueReviews();
  const [r] = reviews("week", period);
  ok(r?.status === "unchatted" && r.delivery === "replied" && r.owner_words === "[]", "he answered but nothing was filed: marked as such, his words not guessed at");
  ok(timelineText({ from: r.ts - 1, to: r.ts + 1, kinds: ["review"] }).includes("没落档"), "the timeline says so");

  // the job never ran (core was down)
  const y = Date.now() - 86400_000;
  owner("m_yesterday", "昨天的一句话", startOfDay(y) + 10 * H);
  const due = startOfDay(y) + 21 * H;
  fire("review_day", due);
  const [miss] = reviews("day", today(y));
  ok(miss?.status === "unchatted" && miss.delivery === "not_sent" && miss.facts.includes("昨天的一句话"), "a firing the core missed still leaves a record for that day");
  ok(JSON.parse(kvGet("job.review_day.last")!).outcome === "missed", "and the job is still reported as missed");
  // a quiet day stays empty
  const quiet = Date.now() - 3 * 86400_000;
  ok(F.reviewPlan("day", startOfDay(quiet) + 21 * H) === undefined, "a quiet day needs no record");
}

// the ledger is bookkeeping: when it breaks, jobs still go out and the scheduler survives
{
  const boom = () => { throw new Error("ledger is broken"); };
  const s = new Scheduler(() => {}, {}, {}, { opened: boom, notRun: boom, beforeTick: boom });
  const before = eventOf("ping").id;
  run("UPDATE timers SET due_at=? WHERE kind='schedule' AND note='ping' AND status='pending'", Date.now() - 1000);
  let threw = false;
  try { s.tick(); } catch { threw = true; }
  const e = eventOf("ping");
  ok(!threw && e.id !== before && e.status === "received", "a failing hook: the tick survives and the job still fires");
  run("UPDATE inbox SET status='dropped' WHERE id=?", e.id);
  run("UPDATE timers SET due_at=? WHERE kind='schedule' AND note='ping' AND status='pending'", Date.now() - 20 * MIN);
  try { s.tick(); } catch { threw = true; }
  ok(!threw && JSON.parse(kvGet("job.ping.last")!).outcome === "missed", "a failing hook on a missed job: same");
}

proxy.close(); fake.close();
console.log(`\n${process.exitCode ? "SOME FAILED" : "ALL PASS"} (${localStamp(now0).slice(11, 16)} start)`);
process.exit(process.exitCode ?? 0);
