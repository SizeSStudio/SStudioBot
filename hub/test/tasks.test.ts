// W4a: the hub side of tasks and nodes with a fake node (protocol/ shapes only): hello registration, dispatch and
// the event flow, permission → card → decide → answer, node killed → 「需要你处理」 → resume, quota resume timer,
// CI red ×3, worktrees, idle release, the sbot MCP (mcp_open off by default), and the role walls (node → /api/v1 403).
// All data is fictional.
import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Req, Res } from "../../protocol/frames.ts";
import type { Hello } from "../../protocol/node/hello.ts";
import { PROTOCOL } from "../../protocol/version.ts";
import { ambientHome } from "./helpers.ts";
import { createApi, type DispatchCaller } from "../src/api/index.ts";
import { authorize } from "../src/link/roles.ts";
import { NodeRegistry } from "../src/tasks/nodes.ts";
import { TaskEngine } from "../src/tasks/engine.ts";
import { nodeRoutes } from "../src/tasks/node-api.ts";
import { nodeTools } from "../src/tasks/tools.ts";
import { taskView } from "../src/api/views.ts";
import { decide } from "../src/approvals.ts";
import { allTools } from "../src/tools/registry.ts";
import { registerBuiltinTools as registerTools } from "../src/tools/builtin.ts";
import { Scheduler } from "../src/timers/schedule.ts";
import { setAdminSink } from "../src/notify.ts";
import { loadAll, useConfigDir } from "../src/config/load.ts";
import { refreshKnown } from "../src/tools/redact.ts";
import type { NodePeer } from "../src/link/session.ts";

const SECRET = "zz-fictional-secret-value-4242";

type Handler = (body: any, path: string) => { status: number; body?: unknown };

/** A node as the hub sees it: answers the hub's requests from `on`, and posts its own through the api dispatcher. */
class FakeNode implements NodePeer {
  readonly id: string;
  readonly got: { method: string; path: string; body: any }[] = [];
  on: Record<string, Handler> = {};
  #api: ReturnType<typeof createApi>;
  #n = 1;
  constructor(id: string, api: ReturnType<typeof createApi>) {
    this.id = id; this.#api = api;
    this.on = {
      "POST /node/v1/sessions": (b) => ({ status: 200, body: {
        session_ref: b.resume_ref ?? `s-${b.task_id}-${b.attempt}`, workdir: b.worktree ? `${b.cwd}/.sbot-wt/${b.task_id}` : b.cwd,
        ...(b.worktree ? { worktree: { path: `${b.cwd}/.sbot-wt/${b.task_id}`, repo: b.worktree.repo, branch: b.worktree.branch } } : {}),
      } }),
      "POST turns": () => ({ status: 200, body: {} }),
      "POST steer": () => ({ status: 200, body: { applied: true } }),
      "POST interrupt": () => ({ status: 200, body: {} }),
      "POST permission": () => ({ status: 200, body: { ok: true } }),
      "DELETE session": () => ({ status: 200, body: { released: true } }),
      "POST /node/v1/worktrees/cleanup": () => ({ status: 200, body: { removed: true } }),
    };
  }
  async request(method: Req["method"], path: string, body: unknown): Promise<Res> {
    this.got.push({ method, path, body });
    const key = this.on[`${method} ${path}`] ? `${method} ${path}`
      : /\/turns$/.test(path) ? "POST turns" : /\/steer$/.test(path) ? "POST steer" : /\/interrupt$/.test(path) ? "POST interrupt"
      : /^\/node\/v1\/permissions\//.test(path) ? "POST permission" : method === "DELETE" ? "DELETE session" : `${method} ${path}`;
    const h = this.on[key];
    const r = h ? h(body, path) : { status: 404, body: { error: "fake: no route" } };
    return { t: "res", id: 0, status: r.status, ...(r.body === undefined ? {} : { body: r.body }) } as Res;
  }
  caller(): DispatchCaller { return { device_id: this.id, role: "node", peer: this }; }
  post(path: string, body: unknown, method: Req["method"] = "POST") {
    return this.#api.dispatch({ t: "req", id: this.#n++, method, path, body } as Req, this.caller());
  }
  hello(extra: Partial<Hello> = {}) {
    return this.post("/node/v1/hello", {
      version: PROTOCOL.current, sha: "nodesha0000", os: "linux", agents: [{ kind: "claude", version: "0.0.1" }],
      capabilities: { claude: { steer: true, resume: true, permissions: true, ask: true } }, quotas: {}, cwd: "/home/demo",
      app_version: "0.4.0", sessions: [], ...extra,
    });
  }
  /** events for a task, seq numbers continuing from what this fake sent before */
  #seq = new Map<string, number>();
  events(task: string, attempt: number, es: unknown[]) {
    const k = `${task}:${attempt}`, from = this.#seq.get(k) ?? 0;
    this.#seq.set(k, from + es.length);
    return this.post(`/node/v1/tasks/${task}/events`, { attempt, from_seq: from, events: es.map((e, i) => ({ seq: from + i, ts: Date.now(), e })) });
  }
  sent(re: RegExp) { return this.got.filter((g) => re.test(`${g.method} ${g.path}`)); }
}

async function until(f: () => boolean, ms = 3000) {
  const end = Date.now() + ms;
  while (!f()) { if (Date.now() > end) throw new Error("timed out"); await new Promise((r) => setTimeout(r, 10)); }
}

async function setup(config: Record<string, string> = {}) {
  const { h, db } = await ambientHome("tasks", {
    "people.yaml": "owner:\n  name: 小测\n  ids:\n    github: demo-owner\n",
    ...config,
  }, `DEMO_TOKEN=${SECRET}\n`);
  useConfigDir(h.config); loadAll(); refreshKnown();
  if (!allTools().length) registerTools();
  const notes: string[] = [];
  setAdminSink((t) => { notes.push(t); });
  const nodes = new NodeRegistry({ db, hubSha: () => "hubsha1111", tools: nodeTools });
  const engine = new TaskEngine({ db, h, nodes });
  const api = createApi({ db, blobs: h.blobs, hubSha: () => "hubsha1111", authorize, tasks: engine, node: nodeRoutes({ blobs: h.blobs, nodes, engine }) });
  // a task write as a client sends it: through the one dispatcher, with a client_op_id of its own (W3a's write layer)
  let opN = 0;
  const writes = (req: Req, caller: DispatchCaller) => api.dispatch({ client_op_id: `op-tasks-${++opN}`, ...req } as Req, caller);
  const cli = { device_id: "cli", role: "client" } as const;
  const fake = new FakeNode("local", api);
  const fireTimers = async () => {
    db.run("UPDATE timers SET due_at = ? WHERE status = 'pending' AND kind = 'task'", Date.now() - 1);
    new Scheduler().tick();
    await engine.idle();
  };
  const task = (id: string) => db.one<Record<string, any>>("SELECT * FROM tasks WHERE id = ?", id)!;
  /** start a task on the fake node and wait for its session */
  const started = async (goal = "把示例仓库的 README 改通顺", extra: Record<string, unknown> = {}) => {
    const t = engine.start({ goal, ...extra });
    await until(() => !!task(String(t.id)).session_ref);
    return String(t.id);
  };
  return { h, db, nodes, engine, api, writes, cli, fake, notes, fireTimers, task, started };
}

test("hello registers the node: version, sha, target_sha, accepts_work, my git login, the tools (no bash)", async () => {
  const s = await setup();
  const r = await s.fake.hello();
  assert.equal(r.status, 200);
  const b = r.body as any;
  assert.equal(b.target_sha, "hubsha1111");
  assert.equal(b.accepts_work, true);
  assert.deepEqual(b.owner_git, ["github:demo-owner"]);
  const names = (b.tools as { name: string }[]).map((t) => t.name);
  assert.ok(names.includes("submit_report") && names.includes("ask") && names.includes("send"));
  assert.ok(!names.includes("bash") && !names.includes("write_file") && !names.includes("read_file"), "only the system column");
  const row = s.db.one<any>("SELECT * FROM nodes WHERE device_id = 'local'")!;
  assert.equal(row.version, "0.4.0");
  assert.equal(row.status, "online");
  assert.equal(JSON.parse(row.extra_json).sha, "nodesha0000");
  assert.ok(s.nodes.online("local"));
  // GET /api/v1/nodes shows it
  const n = await s.api.dispatch({ t: "req", id: 1, method: "GET", path: "/api/v1/nodes" } as Req, s.cli);
  assert.equal((n.body as any).nodes[0].target_sha, "hubsha1111");

  // a node below min only upgrades: no work, no tools; a failed self-upgrade is reported
  const old = new FakeNode("node-old", s.api);
  const o = await old.hello({ version: PROTOCOL.min - 1, upgrade: { from: "aaaa1111", to: "bbbb2222", ok: false, error: `boom ${SECRET}` } });
  assert.equal((o.body as any).accepts_work, false);
  assert.equal((o.body as any).tools, undefined);
  const orow = s.db.one<any>("SELECT * FROM nodes WHERE device_id = 'node-old'")!;
  assert.equal(orow.status, "outdated");
  assert.ok(!orow.extra_json.includes(SECRET), "the node's error text is redacted");
  await until(() => s.notes.length > 0);
  assert.ok(s.notes[0]!.includes("升级到") && !s.notes[0]!.includes(SECRET));

  // gone → offline
  s.nodes.gone("node-old");
  assert.equal(s.db.one<any>("SELECT status FROM nodes WHERE device_id = 'node-old'")!.status, "offline");
});

test("roles: a node gets 403 on all of /api/v1, a client 403 on /node/v1, non-canonical paths 403", async () => {
  const s = await setup();
  await s.fake.hello();
  for (const [m, p] of [["GET", "/api/v1/tasks"], ["GET", "/api/v1/approvals"], ["POST", "/api/v1/tasks"], ["POST", "/api/v1/approvals/1/decide"], ["POST", "/api/v1/bootstrap"]] as const) {
    assert.equal((await s.fake.post(p, {}, m)).status, 403, `${m} ${p}`);
  }
  assert.equal((await s.fake.post("/node/v1/../api/v1/tasks", {})).status, 403);
  assert.equal((await s.fake.post("/node/v1/tasks/t1/../../../api/v1/tasks", {})).status, 403);
  assert.equal((await s.api.dispatch({ t: "req", id: 1, method: "POST", path: "/node/v1/hello", body: {} } as Req, s.cli)).status, 403);
  // a node can't ask the hub to run the hub → node routes
  for (const p of ["/node/v1/sessions", "/node/v1/exec", "/node/v1/permissions/x", "/node/v1/git/checks"]) assert.equal((await s.fake.post(p, {})).status, 404, p);
  // the task writes refuse a node even if something routed it there
  assert.equal((await s.writes({ t: "req", id: 1, method: "POST", path: "/api/v1/tasks", body: { goal: "x" } } as Req, { device_id: "local", role: "node" }))!.status, 403);
});

test("dispatch → session → events: steps, diff and usage (source node), idempotent, old attempt dropped, other node refused", async () => {
  const s = await setup();
  await s.fake.hello();
  const r = await s.writes({ t: "req", id: 1, method: "POST", path: "/api/v1/tasks", body: { goal: "改 README", repo: "/home/demo/repo" } } as Req, s.cli);
  assert.equal(r!.status, 200);
  const id = (r!.body as any).task.id as string;
  await until(() => !!s.task(id).session_ref);
  const open = s.fake.sent(/POST \/node\/v1\/sessions$/)[0]!.body;
  assert.equal(open.attempt, 1);
  assert.equal(open.agent, "claude");
  assert.equal(open.cwd, "/home/demo/repo");
  assert.equal(open.worktree, undefined, "first task in the repo: no worktree");
  assert.equal(s.task(id).status, "running");
  const cl0 = s.db.one<any>("SELECT MAX(seq) AS m FROM change_log")!.m;

  const batch = [
    { k: "text", item: "m1", delta: "改好了，" }, { k: "text", item: "m1", delta: `密钥是 ${SECRET}` },
    { k: "message", item: "m1", text: `改好了，密钥是 ${SECRET}` },
    { k: "tool_start", item: "c1", name: "Edit", args: { file_path: "README.md" } },
    { k: "tool_end", item: "c1", ok: true, result: "ok", diff: "-旧\n+新" },
    { k: "brand_new_kind", x: 1 },
    { k: "usage", input_tokens: 120, output_tokens: 30, ms: 900, model: "demo-model" },
    { k: "diff", text: "diff --git a/README.md b/README.md\n--- a/README.md\n+++ b/README.md\n-旧\n+新\n" },
    { k: "turn_end", stop: "done" },
  ];
  const e1 = await s.fake.events(id, 1, batch);
  assert.deepEqual(e1.body, { acked: batch.length - 1 });
  const items = s.db.all<any>("SELECT * FROM run_items WHERE lane = ? ORDER BY id", `task:${id}`);
  assert.deepEqual(items.map((i) => i.kind), ["assistant", "tool"]);
  assert.ok(!items[0].body_json.includes(SECRET), "agent text is redacted");
  assert.equal(JSON.parse(items[1].body_json).diff, "-旧\n+新");
  assert.equal(items[1].status, "done");
  const u = s.db.one<any>("SELECT * FROM usage WHERE task_id = ?", id)!;
  assert.deepEqual([u.source, u.device_id, u.input_tokens, u.output_tokens], ["node", "local", 120, 30]);
  const t = s.task(id);
  assert.equal(t.status, "done");
  assert.match(t.diff_ref, /^blob:/);
  const view = taskView(s.h.blobs, t, s.db, { detail: true });
  assert.deepEqual(view.diff_stat?.files, [{ path: "README.md", added: 1, removed: 1 }]);
  assert.equal(view.sessions?.length, 1);
  assert.ok(s.db.one<any>("SELECT MAX(seq) AS m FROM change_log")!.m > cl0, "clients see it through the change log");

  // the same batch again: nothing twice
  const again = await s.fake.post(`/node/v1/tasks/${id}/events`, { attempt: 1, from_seq: 0, events: batch.map((e, i) => ({ seq: i, ts: 1, e })) });
  assert.equal(again.status, 200);
  assert.equal(s.db.all("SELECT id FROM run_items WHERE lane = ?", `task:${id}`).length, 2);
  // an older attempt: dropped whole
  s.db.run("UPDATE tasks SET attempt = 2 WHERE id = ?", id);
  const stale = await s.fake.post(`/node/v1/tasks/${id}/events`, { attempt: 1, from_seq: 99, events: [{ seq: 99, ts: 1, e: { k: "message", item: "m9", text: "晚到" } }] });
  assert.equal((stale.body as any).dropped, true);
  assert.equal(s.db.all("SELECT id FROM run_items WHERE lane = ?", `task:${id}`).length, 2);
  s.db.run("UPDATE tasks SET attempt = 1 WHERE id = ?", id);
  // another node can't write into this task
  const other = new FakeNode("node-b", s.api);
  await other.hello();
  assert.equal((await other.events(id, 1, [{ k: "message", item: "x", text: "冒充" }])).status, 403);
  assert.equal((await other.post("/node/v1/permissions", { task_id: id, attempt: 1, request_id: "r", title: "t", detail: {}, options: [] })).status, 403);
  assert.equal((await other.post("/node/v1/tool-calls", { task_id: id, attempt: 1, tool_call_id: "c", name: "submit_report", args: { summary: "x" } })).status, 403);
});

test("permission → glance card → decide (only me) → PermissionAnswer; a reject always reaches the node as a reject", async () => {
  const s = await setup();
  await s.fake.hello();
  const id = await s.started();
  const opts = [{ id: "allow_once", label: "这次可以", kind: "allow_once" }, { id: "reject_once", label: "不行", kind: "reject_once" }];
  const p = await s.fake.post("/node/v1/permissions", { task_id: id, attempt: 1, request_id: "perm-1", title: "要跑 rm -rf build", detail: { tool: "Bash", command: "rm -rf build" }, options: opts });
  const aid = (p.body as any).approval_id as number;
  assert.ok(aid > 0);
  assert.equal(((await s.fake.post("/node/v1/permissions", { task_id: id, attempt: 1, request_id: "perm-1", title: "again", detail: {}, options: opts })).body as any).approval_id, aid, "same request id: same card");
  const a = s.db.one<any>("SELECT * FROM approvals WHERE id = ?", aid)!;
  assert.deepEqual([a.kind, a.status, a.task_id, a.attempt, a.tool_use_id, a.requester], ["glance", "pending", id, 1, "perm-1", "node:local"]);
  assert.equal(JSON.parse(a.request_json).command, "rm -rf build", "the full command, not cut");
  assert.equal(s.task(id).status, "waiting");
  assert.equal(taskView(s.h.blobs, s.task(id), s.db).waiting_approval, String(aid));

  // a node can't decide (03: only I answer)
  assert.equal(decide(s.db, aid, { decision: "approve", by: { kind: "device", device_id: "local", role: "node" }, answer: { option_id: "allow_once" } }).ok, false);
  assert.equal(decide(s.db, aid, { decision: "approve", by: { kind: "device", device_id: "cli" }, answer: { option_id: "allow_once" } }).ok, true);
  await s.engine.idle();
  const ans = s.fake.sent(/POST \/node\/v1\/permissions\/perm-1$/);
  assert.equal(ans.length, 1);
  assert.deepEqual(ans[0]!.body, { task_id: id, attempt: 1, option_id: "allow_once" });
  assert.equal(s.task(id).status, "running");

  // rejected with an allow option clicked: the node gets the reject option (fail closed)
  const p2 = await s.fake.post("/node/v1/permissions", { task_id: id, attempt: 1, request_id: "perm-2", title: "写 /etc/hosts", detail: { path: "/etc/hosts" }, options: opts });
  decide(s.db, (p2.body as any).approval_id, { decision: "reject", by: { kind: "device", device_id: "cli" }, answer: { option_id: "allow_once" } });
  await s.engine.idle();
  assert.equal(s.fake.sent(/permissions\/perm-2$/)[0]!.body.option_id, "reject_once");

  // ask (AskUserQuestion): my answers go through
  const p3 = await s.fake.post("/node/v1/permissions", { task_id: id, attempt: 1, kind: "ask", request_id: "ask-1", title: "用哪个名字？", detail: { questions: [{ question: "名字" }] }, options: [] });
  assert.equal(s.db.one<any>("SELECT kind FROM approvals WHERE id = ?", (p3.body as any).approval_id)!.kind, "ask");
  decide(s.db, (p3.body as any).approval_id, { decision: "approve", by: { kind: "device", device_id: "cli" }, answer: { answers: { 名字: "示例" } } });
  await s.engine.idle();
  assert.deepEqual(s.fake.sent(/permissions\/ask-1$/)[0]!.body.answers, { 名字: "示例" });

  // an old attempt's card is stale; my message while it waits refuses it first, then steers
  assert.equal(((await s.fake.post("/node/v1/permissions", { task_id: id, attempt: 7, request_id: "x", title: "t", detail: {}, options: [] })).body as any).approval_id, undefined, "no card for another attempt");
  assert.equal(s.db.all("SELECT id FROM approvals WHERE tool_use_id = 'x'").length, 0);
  const p4 = await s.fake.post("/node/v1/permissions", { task_id: id, attempt: 1, request_id: "perm-4", title: "装依赖", detail: { command: "npm i" }, options: opts });
  const steer = await s.engine.steer(id, "别装了，先看看 lockfile");
  assert.equal(steer.applied, true);
  assert.equal(s.db.one<any>("SELECT status FROM approvals WHERE id = ?", (p4.body as any).approval_id)!.status, "rejected");
  const order = s.fake.got.map((g) => g.path).filter((x) => /perm-4|steer/.test(x));
  assert.deepEqual(order, ["/node/v1/permissions/perm-4", `/node/v1/sessions/${encodeURIComponent(`s-${id}-1`)}/steer`]);
  assert.equal(s.fake.sent(/permissions\/perm-4$/)[0]!.body.option_id, "reject_once");
});

test("node process killed → waiting_node → hello without the session → 「需要你处理」; my message resumes the same session", async () => {
  const s = await setup();
  await s.fake.hello();
  const id = await s.started();
  const p = await s.fake.post("/node/v1/permissions", { task_id: id, attempt: 1, request_id: "perm-1", title: "t", detail: {}, options: [{ id: "ok", label: "好" }] });
  s.nodes.gone("local");
  assert.equal(s.task(id).status, "waiting_node");
  await s.fake.hello({ sessions: [] });   // restarted: it holds no session any more
  await new Promise((r) => setImmediate(r));
  assert.equal(s.task(id).status, "interrupted");
  assert.equal(taskView(s.h.blobs, s.task(id), s.db).needs_you, true);
  assert.equal(s.db.one<any>("SELECT status FROM approvals WHERE id = ?", (p.body as any).approval_id)!.status, "invalidated");

  await s.engine.steer(id, "继续，刚才那步重来");
  await s.engine.idle();
  await until(() => s.fake.sent(/POST \/node\/v1\/sessions$/).length === 2);
  const reopen = s.fake.sent(/POST \/node\/v1\/sessions$/)[1]!.body;
  assert.equal(reopen.resume_ref, `s-${id}-1`);
  assert.equal(reopen.attempt, 2);
  assert.equal(reopen.prompt, "继续，刚才那步重来");
  assert.ok(reopen.handoff?.includes("第一条要求"), "a handoff in case the old session can't be resumed ※");
  await until(() => s.task(id).status === "running");

  // a reconnect that still holds the session: back to running, nothing lost
  s.nodes.gone("local");
  await s.fake.hello({ sessions: [{ ref: `s-${id}-1`, task_id: id, attempt: 2, agent: "claude", state: "running" }] });
  await new Promise((r) => setImmediate(r));
  assert.equal(s.task(id).status, "running");

  // turn_end interrupted that I didn't ask for = a restart too; one I asked for (停) is just the end of the turn
  await s.fake.events(id, 2, [{ k: "turn_end", stop: "interrupted" }]);
  assert.equal(s.task(id).status, "interrupted");
  s.db.run("UPDATE tasks SET status = 'running' WHERE id = ?", id);
  await s.engine.stopTurn(id);
  assert.equal(s.fake.sent(/interrupt$/).length, 1);
  await s.fake.events(id, 2, [{ k: "turn_end", stop: "interrupted" }]);
  assert.equal(s.task(id).status, "done");
});

test("quota limit → queued with quota_until → the timer resumes the same session at the reset time", async () => {
  const s = await setup();
  await s.fake.hello();
  const id = await s.started();
  const resets = Date.now() + 60 * 60_000;
  await s.fake.events(id, 1, [{ k: "quota", resets_at: resets, text: "5-hour limit" }, { k: "turn_end", stop: "error", error: "usage limit" }]);
  const t = s.task(id);
  assert.deepEqual([t.status, t.quota_until], ["queued", resets]);
  assert.equal(taskView(s.h.blobs, t, s.db).needs_you, false, "a quota isn't stuck");
  const timer = s.db.one<any>("SELECT * FROM timers WHERE task_id = ? AND status = 'pending'", id)!;
  assert.equal(timer.due_at, resets);
  assert.equal(JSON.parse(timer.payload_json).op, "resume");
  assert.ok(s.db.one("SELECT 1 FROM push_queue WHERE ref LIKE ?", `task:${id}:quota:%`), "通知我一句");
  await s.fireTimers();
  await until(() => s.fake.sent(/\/turns$/).length === 1);
  assert.match(s.fake.sent(/\/turns$/)[0]!.body.text, /额度恢复/);
  assert.equal(s.task(id).quota_until, null);
  assert.equal(s.task(id).status, "running");
});

test("CI: red wakes the same session with the log; same sha once; the 3rd red in a row → a notice; green resets", async () => {
  const s = await setup();
  await s.fake.hello();
  const id = await s.started();
  await s.fake.events(id, 1, [{ k: "pr", url: "https://git.example/demo/repo/pull/7", repo: "demo/repo", number: 7 }, { k: "turn_end", stop: "done" }]);
  const pr = s.db.one<any>("SELECT * FROM task_prs WHERE task_id = ?", id)!;
  let next = { state: "open", ci: "red", head_sha: "a1", checks: [{ name: "test", state: "failure" }], failed_log: `assert failed ${SECRET}` };
  s.fake.on["POST /node/v1/git/checks"] = () => ({ status: 200, body: next });
  const look = async () => {
    await s.fireTimers();
    await s.engine.idle();
  };
  const turnsBefore = () => s.fake.sent(/\/turns$/).length;
  const endTurn = async () => { await s.fake.events(id, 1, [{ k: "turn_end", stop: "done" }]); };

  await look();
  assert.equal(s.fake.sent(/git\/checks$/)[0]!.body.pr, pr.url);
  await until(() => turnsBefore() === 1);
  const wake = s.fake.sent(/\/turns$/)[0]!.body.text as string;
  assert.ok(wake.includes("CI 红了") && wake.includes("assert failed") && !wake.includes(SECRET));
  assert.equal(s.db.one<any>("SELECT red_streak FROM task_prs WHERE id = ?", pr.id)!.red_streak, 1);
  await endTurn();
  await look();   // same sha, still red: no second wake-up
  assert.equal(turnsBefore(), 1);
  next = { ...next, head_sha: "b2" };
  await look(); await until(() => turnsBefore() === 2); await endTurn();
  assert.equal(s.db.one("SELECT 1 FROM push_queue WHERE ref LIKE 'task_pr:%'"), undefined);
  next = { ...next, head_sha: "c3" };
  await look(); await until(() => turnsBefore() === 3); await endTurn();
  assert.equal(s.db.one<any>("SELECT red_streak FROM task_prs WHERE id = ?", pr.id)!.red_streak, 3);
  const notice = s.db.one<any>("SELECT * FROM push_queue WHERE ref = ?", `task_pr:${pr.id}:red:3`)!;
  assert.equal(notice.cat, "notice");
  next = { state: "open", ci: "green", head_sha: "d4", checks: [], failed_log: undefined as unknown as string };
  await look();
  assert.equal(s.db.one<any>("SELECT red_streak FROM task_prs WHERE id = ?", pr.id)!.red_streak, 0);
  // merged: no more looks, the worktree (if any) becomes cleanable
  next = { state: "merged", ci: "green", head_sha: "d4", checks: [], failed_log: undefined as unknown as string };
  await look();
  assert.equal(s.db.one<any>("SELECT state FROM task_prs WHERE id = ?", pr.id)!.state, "merged");
  assert.equal(s.db.one("SELECT 1 FROM timers WHERE task_id = ? AND status = 'pending' AND json_extract(payload_json, '$.op') = 'ci'", id), undefined);
});

test("worktrees: a second task in the same repo gets one; cancel makes it cleanable; only my 清理 deletes it", async () => {
  const s = await setup();
  await s.fake.hello();
  const a = await s.started("第一件", { repo: "/home/demo/repo" });
  const b = await s.started("第二件", { repo: "/home/demo/repo" });
  const open = s.fake.sent(/POST \/node\/v1\/sessions$/)[1]!.body;
  assert.deepEqual(open.worktree, { repo: "/home/demo/repo", branch: `sbot/${b}` });
  assert.equal(s.task(b).workdir, `/home/demo/repo/.sbot-wt/${b}`);
  await s.engine.cancel(b);
  assert.equal(s.task(b).status, "cancelled");
  const n = await s.api.dispatch({ t: "req", id: 1, method: "GET", path: "/api/v1/nodes" } as Req, s.cli);
  const wt = (n.body as any).worktrees;
  assert.equal(wt.length, 1);
  assert.equal(wt[0].state, "cleanable");
  assert.equal(s.fake.sent(/worktrees\/cleanup$/).length, 0, "never deleted on its own");
  const r = await s.writes({ t: "req", id: 2, method: "POST", path: "/api/v1/nodes/local/worktrees/cleanup", body: { path: wt[0].path } } as Req, s.cli);
  assert.equal(r!.status, 200);
  assert.equal((r!.body as any).worktree.state, "deleted");
  assert.equal((r!.body as any).worktree.deleted_by, "device:cli");
  // the in-use one can't be cleaned
  s.db.run("INSERT INTO worktrees(node, path, task_id, repo, branch, created_at) VALUES ('local', '/x/wt', ?, '/x', 'sbot/x', 1)", a);
  assert.equal((await s.writes({ t: "req", id: 3, method: "POST", path: "/api/v1/nodes/local/worktrees/cleanup", body: { path: "/x/wt" } } as Req, s.cli))!.status, 409);
});

test("idle release: an hour after the turn ends the hub sends DELETE; the session stays resumable", async () => {
  const s = await setup();
  await s.fake.hello();
  const id = await s.started();
  await s.fake.events(id, 1, [{ k: "turn_end", stop: "done" }]);
  const t = s.db.one<any>("SELECT * FROM timers WHERE task_id = ? AND status = 'pending'", id)!;
  assert.equal(JSON.parse(t.payload_json).op, "release");
  assert.ok(t.due_at - Date.now() > 50 * 60_000);
  await s.fireTimers();
  await until(() => s.fake.sent(/^DELETE /).length === 1);
  await until(() => s.db.one<any>("SELECT proc FROM task_sessions WHERE task_id = ?", id)!.proc === "released");
});

test("sbot MCP: ad hoc calls are 403 while mcp_open is off (default); task calls go through the system column", async () => {
  const s = await setup();
  await s.fake.hello();
  const adhoc = { tool_call_id: "c1", name: "memory_read", args: {} };
  assert.equal((await s.fake.post("/node/v1/tool-calls", adhoc)).status, 403);
  const id = await s.started();
  const rep = await s.fake.post("/node/v1/tool-calls", { task_id: id, attempt: 1, tool_call_id: "r1", name: "submit_report", args: { summary: `做完了 ${SECRET}` } });
  assert.deepEqual(rep.body, { text: "收到" });
  assert.ok(!String(s.task(id).result_json).includes(SECRET));
  assert.equal(JSON.parse(s.task(id).result_json).summary.startsWith("做完了"), true);
  const bash = await s.fake.post("/node/v1/tool-calls", { task_id: id, attempt: 1, tool_call_id: "b1", name: "bash", args: { cmd: "id" } });
  assert.equal((bash.body as any).is_error, true);
  // send is L2: an approval card, not a send
  const send = await s.fake.post("/node/v1/tool-calls", { task_id: id, attempt: 1, tool_call_id: "s1", name: "send", args: { channel: "feishu", to: "oc_demo", text: "你好" } });
  assert.match((send.body as any).text, /已提交审批/);
  assert.equal(s.db.one<any>("SELECT kind FROM approvals ORDER BY id DESC LIMIT 1")!.kind, "send");
  // the same tool_call_id again: not run twice
  await s.fake.post("/node/v1/tool-calls", { task_id: id, attempt: 1, tool_call_id: "s1", name: "send", args: { channel: "feishu", to: "oc_demo", text: "你好" } });
  assert.equal(s.db.all("SELECT id FROM approvals WHERE kind = 'send'").length, 1);
  // ask via MCP → an ask card; my answer comes back as a message into the session
  const ask = await s.fake.post("/node/v1/tool-calls", { task_id: id, attempt: 1, tool_call_id: "a1", name: "ask", args: { question: "改哪个分支？", options: ["main", "dev"] } });
  assert.match((ask.body as any).text, /已经问了/);
  const card = s.db.one<any>("SELECT * FROM approvals WHERE kind = 'ask'")!;
  await s.fake.events(id, 1, [{ k: "turn_end", stop: "done" }]);
  decide(s.db, card.id, { decision: "approve", by: { kind: "device", device_id: "cli" }, answer: { option_id: "o2" } });
  await s.engine.idle();
  await until(() => s.fake.sent(/\/turns$/).length === 1);
  assert.match(s.fake.sent(/\/turns$/)[0]!.body.text, /o2|dev/);

  // mcp_open on (a widening I'd make myself): ad hoc calls go through
  writeFileSync(join(s.h.config, "console.yaml"), "mcp_open: true\n");
  loadAll();
  assert.equal((await s.fake.post("/node/v1/tool-calls", { tool_call_id: "c2", name: "memory_read", args: {} })).status, 200);
});

test("blobs: pieces in order, sha checked at the end", async () => {
  const s = await setup();
  await s.fake.hello();
  const data = Buffer.from("diff --git a/x b/x\n+一行\n".repeat(50));
  const { createHash } = await import("node:crypto");
  const sha = createHash("sha256").update(data).digest("hex");
  const half = Math.floor(data.length / 2);
  const p1 = await s.fake.post("/node/v1/blobs", { sha, offset: 0, total: data.length, data_b64: data.subarray(0, half).toString("base64") });
  assert.deepEqual(p1.body, { done: false, next_offset: half });
  const wrong = await s.fake.post("/node/v1/blobs", { sha, offset: 3, total: data.length, data_b64: "AA==" });
  assert.deepEqual(wrong.body, { done: false, next_offset: half });
  const p2 = await s.fake.post("/node/v1/blobs", { sha, offset: half, total: data.length, data_b64: data.subarray(half).toString("base64") });
  assert.deepEqual(p2.body, { done: true, next_offset: data.length });
  const bad = await s.fake.post("/node/v1/blobs", { sha: "0".repeat(64), offset: 0, total: 2, data_b64: "AAA=" });
  assert.equal(bad.status, 422);
});

test("where a task goes: no node → the hub's own machine (waits for it when it is off); another node → one notice to me (限1)", async () => {
  const s = await setup();
  const b = new FakeNode("node-b", s.api);
  await b.hello();
  const t1 = s.engine.start({ goal: "本机的活" });
  assert.equal(t1.node, "local", "never another machine on its own");
  await s.engine.idle();
  assert.equal(s.task(String(t1.id)).status, "waiting_node");
  assert.equal(b.sent(/POST \/node\/v1\/sessions$/).length, 0);
  assert.equal(s.db.one("SELECT 1 FROM push_queue WHERE ref = ?", `task:${t1.id}:dispatched`), undefined);
  const t2 = s.engine.start({ goal: "去另一台", node: "node-b" });
  await until(() => !!s.task(String(t2.id)).session_ref);
  const n = s.db.one<any>("SELECT * FROM push_queue WHERE ref = ?", `task:${t2.id}:dispatched`)!;
  assert.equal(n.cat, "notice");
  assert.equal(n.state, "wait", "not blocking: the session is already open");
  assert.throws(() => s.engine.start({ goal: "x", node: "nobody" }), /没有这台节点/);
});

test("answerFor: my pick goes as it is; a rejected card never carries an allow option", async () => {
  const { answerFor } = await import("../src/tasks/engine.ts");
  const opts = JSON.stringify([{ id: "allow_once", kind: "allow_once" }, { id: "allow_always", kind: "allow_always" }, { id: "reject_once", kind: "reject_once" }]);
  const card = (status: string, answer: unknown, options = opts) => ({ kind: "glance", status, options_json: options, answer_json: JSON.stringify(answer) });
  assert.equal(answerFor(card("approved", { option_id: "reject_once" })).option_id, "reject_once", "approve + 不行 = 不行");
  assert.equal(answerFor(card("approved", { option_id: "allow_always" })).option_id, "allow_always");
  assert.equal(answerFor(card("approved", {})).option_id, "allow_once");
  assert.equal(answerFor(card("rejected", { option_id: "allow_always" })).option_id, "reject_once");
  assert.equal(answerFor(card("rejected", {}, JSON.stringify([{ id: "ok", kind: "allow_once" }]))).option_id, "reject", "no reject option: an id that isn't one of them");
});

test("task writes are W3a writes: client_op_id required, a retry gets the stored answer, reuse with another body 409", async () => {
  const s = await setup();
  await s.fake.hello();
  const req = (path: string, body: unknown, client_op_id?: string) => ({ t: "req", id: 1, method: "POST", path, body, ...(client_op_id ? { client_op_id } : {}) } as Req);
  assert.equal((await s.api.dispatch(req("/api/v1/tasks", { goal: "没带 op id" }), s.cli)).status, 400);
  const a = await s.api.dispatch(req("/api/v1/tasks", { goal: "只派一次" }, "op-start-0001"), s.cli);
  const b = await s.api.dispatch(req("/api/v1/tasks", { goal: "只派一次" }, "op-start-0001"), s.cli);
  assert.equal(a.status, 200);
  assert.deepEqual(b, a, "same status, body and seq");
  assert.equal(s.db.all("SELECT id FROM tasks").length, 1, "applied once");
  assert.equal((await s.api.dispatch(req("/api/v1/tasks", { goal: "另一件" }, "op-start-0001"), s.cli)).status, 409);
  const id = (a.body as any).task.id as string;
  await until(() => !!s.task(id).session_ref);
  // steer: the retry (even while the first still waits on the node) doesn't steer twice
  const st = req(`/api/v1/tasks/${id}/steer`, { text: "顺便把标题也改了" }, "op-steer-0001");
  const [x, y] = await Promise.all([s.api.dispatch(st, s.cli), s.api.dispatch(st, s.cli)]);
  assert.equal(x.status, 200); assert.deepEqual(y.body, x.body);
  assert.equal(s.fake.sent(/\/steer$/).length, 1);
  assert.equal(s.db.all("SELECT id FROM inbox WHERE lane = ? AND kind = 'user'", `task:${id}`).length, 1);
  assert.equal((await s.api.dispatch(st, s.cli)).status, 200);
  assert.equal(s.fake.sent(/\/steer$/).length, 1, "a later retry: the stored answer");
  // a paired client device (over the relay) gets the same routes; a node still 403
  s.db.run("INSERT INTO devices(id, name, role, public_key, created_at) VALUES ('dev-phone-01', '测试手机', 'client', ?, 1)", new Uint8Array(32));
  const phone = { device_id: "dev-phone-01", role: "client" } as const;
  assert.equal((await s.api.dispatch(req(`/api/v1/tasks/${id}/stop`, {}, "op-stop-00001"), phone)).status, 200);
  assert.equal((await s.api.dispatch(req(`/api/v1/tasks/${id}/cancel`, {}, "op-cancel-0001"), s.fake.caller())).status, 403);
});

test("client decide on an ask card: answers ride through choose() to the node; a rejecting pick still goes out as a reject", async () => {
  const s = await setup();
  await s.fake.hello();
  const id = await s.started();
  const ask = await s.fake.post("/node/v1/permissions", { task_id: id, attempt: 1, kind: "ask", request_id: "ask-9", title: "两个问题", detail: { questions: [{ question: "名字" }, { question: "颜色" }] }, options: [] });
  const aid = (ask.body as any).approval_id as number;
  const dv = s.db.one<any>("SELECT draft_version FROM approvals WHERE id = ?", aid)!.draft_version ?? 1;
  const r = await s.api.dispatch({ t: "req", id: 1, method: "POST", path: `/api/v1/approvals/${aid}/decide`, client_op_id: "op-decide-0001",
    body: { action: "answer", draft_version: dv, answers: { 名字: "示例", 颜色: `灰 ${SECRET}` } } } as Req, s.cli);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  await s.engine.idle();
  const sent = s.fake.sent(/permissions\/ask-9$/)[0]!.body;
  assert.equal(sent.answers.名字, "示例");
  assert.ok(!JSON.stringify(sent).includes(SECRET), "answers are redacted");
  // a glance answered with a reject option through the client: the node gets that reject option
  const opts = [{ id: "allow_once", label: "好", kind: "allow_once" }, { id: "reject_once", label: "不行", kind: "reject_once" }];
  const g = await s.fake.post("/node/v1/permissions", { task_id: id, attempt: 1, request_id: "perm-9", title: "删目录", detail: { command: "rm -rf out" }, options: opts });
  const gid = (g.body as any).approval_id as number;
  const gv = s.db.one<any>("SELECT draft_version FROM approvals WHERE id = ?", gid)!.draft_version ?? 1;
  await s.api.dispatch({ t: "req", id: 2, method: "POST", path: `/api/v1/approvals/${gid}/decide`, client_op_id: "op-decide-0002",
    body: { action: "answer", draft_version: gv, option_id: "reject_once" } } as Req, s.cli);
  await s.engine.idle();
  assert.equal(s.db.one<any>("SELECT status FROM approvals WHERE id = ?", gid)!.status, "rejected");
  assert.equal(s.fake.sent(/permissions\/perm-9$/)[0]!.body.option_id, "reject_once");
});
