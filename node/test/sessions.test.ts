// The node daemon end to end against a fake hub (fakes/fake-hub.ts) and scripted agents (fakes/fake-agent.ts) — no
// real Claude Code, Codex or pi login. Covers: event flow (seq from 0, batched text, final diff, progress, PR), the
// sbot MCP, permission → answer (a bare `reject` too, ACP's set_mode to default and no "always" offered), steer vs
// queued, quota, idle release and lazy resume, the node killed and reconnecting with its sessions in hello.
import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeHub, until } from "./fakes/fake-hub.ts";
import { runNode, type Stop } from "../src/main.ts";
import { codexAdapter } from "../src/adapters/codex.ts";
import { piAdapter } from "../src/adapters/pi.ts";
import { acpAdapter } from "../src/adapters/acp.ts";
import type { Found } from "../src/adapters/index.ts";

const FAKE = join(import.meta.dirname, "fakes", "fake-agent.ts");
const MAIN = join(import.meta.dirname, "..", "src", "main.ts");
chmodSync(FAKE, 0o755);
process.env.SBOT_LOG = "off";
// a failed assertion skips s.end(): stop that node anyway, or the file never finishes
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const e of cleanups.splice(0)) await e(); });

function agentsFor(state: string): Found[] {
  return [
    { kind: "codex", caps: codexAdapter({ bin: FAKE }).caps(), make: () => codexAdapter({ bin: FAKE, args: ["codex"] }) },
    { kind: "pi", caps: piAdapter({ bin: FAKE, sessionDir: "" }).caps(), make: () => piAdapter({ bin: FAKE, args: ["pi"], sessionDir: join(state, "pi") }) },
    { kind: "acp:fake", caps: acpAdapter({ name: "fake", cmd: [FAKE, "acp"] }).caps(), make: () => acpAdapter({ name: "fake", cmd: [FAKE, "acp"] }) },
  ];
}

function gitRepo(root: string) {
  const repo = join(root, "repo");
  mkdirSync(repo);
  const g = (...a: string[]) => execFileSync("git", ["-c", "user.name=测试", "-c", "user.email=sbot@localhost", "-c", "commit.gpgsign=false", ...a], { cwd: repo, stdio: "ignore" });
  g("init", "-q", "-b", "main");
  writeFileSync(join(repo, "README.md"), "示例仓库\n");
  g("add", ".");
  g("commit", "-q", "-m", "初始");
  return repo;
}

async function setup() {
  const root = mkdtempSync(join(tmpdir(), "sbn-"));
  const hub = new FakeHub();
  const sock = join(root, "hub.sock");
  await hub.listen(sock);
  const state = join(root, "state");
  process.env.FAKE_LOG = join(root, "fake.log");
  const env = { ...process.env, SBOT_NODE_STATE: state, SBOT_NODE_CONFIG: join(root, "conf"), SBOT_LOG: "off", SBOT_NODE_CWD: root };
  const stop: Stop = { now: false };
  const done = runNode({ target: { kind: "local", path: sock }, stop, agents: agentsFor(state), env });
  await until(() => hub.hellos.length > 0, 10_000, "hello");
  const repo = gitRepo(root);
  const log = () => (existsSync(process.env.FAKE_LOG!) ? readFileSync(process.env.FAKE_LOG!, "utf8") : "");
  let n = 0;
  const openSession = async (agent: string, prompt: string, extra: object = {}) => {
    const task = `t${++n}`;
    const r = await hub.request("POST", "/node/v1/sessions", { task_id: task, attempt: 1, agent, cwd: repo, prompt, ...extra });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    return { task, ref: (r.body as any).session_ref as string, body: r.body as any };
  };
  let ended = false;
  const end = async () => { if (ended) return; ended = true; stop.now = true; await hub.close(); await done; };
  cleanups.push(end);
  return { root, hub, repo, log, open: openSession, end };
}

test("hello: agents, capabilities as the probes found them, cwd, no sessions yet", async () => {
  const s = await setup();
  const h = s.hub.hellos[0];
  assert.deepEqual(h.agents.map((a: any) => a.kind), ["codex", "pi", "acp:fake"]);
  assert.equal(h.capabilities.codex.steer, true);
  assert.equal(h.capabilities["acp:fake"].steer, false);
  assert.equal(h.capabilities.pi.permissions, false);
  assert.deepEqual(h.sessions, []);
  assert.equal(h.cwd, s.root);
  await s.end();
});

test("event flow: seq from 0 with no gaps, text batched, message, usage, progress, final diff, PR, turn_end", async () => {
  const s = await setup();
  const o = await s.open("codex", "EDIT 然后 PR");
  assert.equal(o.body.workdir, s.repo);
  await until(() => s.hub.ended(o.task), 10_000, "turn_end");
  const ev = s.hub.ev(o.task);
  assert.deepEqual(s.hub.errors, []);
  assert.deepEqual(ev.map((e) => e.seq), ev.map((_, i) => i));
  const kinds = ev.map((e) => e.k);
  assert.ok(kinds.includes("text") && kinds.includes("message") && kinds.includes("usage"));
  assert.ok(kinds.filter((k) => k === "text").length < 2, "both deltas went in one 80 ms batch");
  const pr = ev.find((e) => e.k === "pr") as any;
  assert.deepEqual([pr.url, pr.repo, pr.number], ["https://github.com/demo-org/demo-repo/pull/42", "demo-org/demo-repo", 42]);
  const progress = ev.find((e) => e.k === "progress") as any;
  assert.match(progress.text, /README/);
  const diff = ev.find((e) => e.k === "diff" && !(e as any).item) as any;
  assert.match(diff.text, /\+第二段改成了三句短句/);
  assert.match(diff.text, /progress\.md/, "untracked files are listed");
  assert.equal(kinds.at(-1), "turn_end");
  assert.ok(kinds.indexOf("diff") < kinds.lastIndexOf("turn_end"), "the diff belongs to the turn");
  await s.end();
});

test("the sbot MCP: the agent's tools come from the hub, a call carries the session's task and attempt", async () => {
  const s = await setup();
  const o = await s.open("codex", "TOOL");
  await until(() => s.hub.ended(o.task), 15_000, "turn_end");
  assert.equal(s.hub.toolCalls.length, 1);
  const c = s.hub.toolCalls[0];
  assert.deepEqual([c.task_id, c.attempt, c.name, c.args], [o.task, 1, "echo", { say: "嗨" }]);
  assert.ok(c.tool_call_id);
  const said = s.hub.ev(o.task).filter((e) => e.k === "text").map((e: any) => e.delta).join("");
  assert.match(said, /tools=echo result=echo \{"say":"嗨"\}/);
  await s.end();
});

test("permission → card → answer: a bare `reject` is a no, allow_once a yes; the request is the full command", async () => {
  const s = await setup();
  const a = await s.open("codex", "ASK");
  await until(() => s.hub.permissions.length === 1, 10_000, "permission");
  const p = s.hub.permissions[0];
  assert.equal(p.task_id, a.task);
  assert.equal(p.detail.command, "rm -rf build");
  assert.deepEqual(p.options.map((x: any) => x.id), ["allow_once", "reject_once"]);
  // waiting: the hub's DELETE is refused
  assert.equal((await s.hub.request("DELETE", `/node/v1/sessions/${a.ref}`)).status, 409);
  const r = await s.hub.request("POST", `/node/v1/permissions/${p.request_id}`, { task_id: a.task, attempt: 1, option_id: "reject" });
  assert.deepEqual(r.body, { ok: true });
  await until(() => s.hub.ended(a.task), 10_000, "turn_end");
  assert.match(s.hub.ev(a.task).filter((e) => e.k === "text").map((e: any) => e.delta).join(""), /denied/);
  // the same request again: gone
  assert.deepEqual((await s.hub.request("POST", `/node/v1/permissions/${p.request_id}`, { option_id: "allow_once" })).body, { ok: false, gone: true });

  const b = await s.open("codex", "ASK");
  await until(() => s.hub.permissions.length === 2, 10_000, "permission 2");
  await s.hub.request("POST", `/node/v1/permissions/${s.hub.permissions[1].request_id}`, { task_id: b.task, attempt: 1, option_id: "allow_once" });
  await until(() => s.hub.ended(b.task), 10_000, "turn_end 2");
  assert.match(s.hub.ev(b.task).filter((e) => e.k === "text").map((e: any) => e.delta).join(""), /allowed/);
  await s.end();
});

test("ACP: set_mode default after session/new, no `always` offered, a bare reject picks the agent's reject option", async () => {
  const s = await setup();
  const a = await s.open("acp:fake", "ASK");
  await until(() => s.hub.permissions.length === 1, 10_000, "permission");
  assert.match(s.log(), /acp mode default/);
  const p = s.hub.permissions[0];
  assert.deepEqual(p.options.map((x: any) => x.kind), ["allow_once", "reject_once"]);
  await s.hub.request("POST", `/node/v1/permissions/${p.request_id}`, { task_id: a.task, attempt: 1, option_id: "reject" });
  await until(() => s.hub.ended(a.task), 10_000, "turn_end");
  assert.match(s.log(), /acp answer ro/);
  await s.end();
});

test("a stale attempt: the hub says nobody will be asked, the agent hears no", async () => {
  const s = await setup();
  s.hub.stale = true;
  const a = await s.open("codex", "ASK");
  await until(() => s.hub.ended(a.task), 10_000, "turn_end");
  assert.match(s.hub.ev(a.task).filter((e) => e.k === "text").map((e: any) => e.delta).join(""), /denied/);
  await s.end();
});

test("steer: Codex and pi take it in the turn; ACP says applied:false (the hub queues it for the next turn)", async () => {
  const s = await setup();
  const c = await s.open("codex", "SLOW");
  await new Promise((r) => setTimeout(r, 200));
  assert.deepEqual((await s.hub.request("POST", `/node/v1/sessions/${c.ref}/steer`, { text: "顺便改标题", attempt: 1 })).body, { applied: true });
  await until(() => s.hub.ended(c.task), 10_000, "codex turn_end");
  assert.match(s.hub.ev(c.task).filter((e) => e.k === "text").map((e: any) => e.delta).join(""), /steered:顺便改标题/);
  assert.match(s.log(), /codex steer true/, "expectedTurnId was the running turn");

  const p = await s.open("pi", "SLOW");
  await new Promise((r) => setTimeout(r, 200));
  assert.deepEqual((await s.hub.request("POST", `/node/v1/sessions/${encodeURIComponent(p.ref)}/steer`, { text: "pi 插话" })).body, { applied: true });
  await until(() => s.hub.ended(p.task), 10_000, "pi turn_end");
  assert.match(s.hub.ev(p.task).filter((e) => e.k === "text").map((e: any) => e.delta).join(""), /steered:pi 插话/);

  const a = await s.open("acp:fake", "SLOW");
  await new Promise((r) => setTimeout(r, 200));
  assert.deepEqual((await s.hub.request("POST", `/node/v1/sessions/${a.ref}/steer`, { text: "下一轮再说" })).body, { applied: false });
  await until(() => s.hub.ended(a.task), 10_000, "acp turn_end");
  // a steer on an idle session is not applied either
  assert.deepEqual((await s.hub.request("POST", `/node/v1/sessions/${c.ref}/steer`, { text: "晚了" })).body, { applied: false });
  await s.end();
});

test("interrupt ends the turn as interrupted", async () => {
  const s = await setup();
  const c = await s.open("codex", "SLOW");
  await new Promise((r) => setTimeout(r, 200));
  await s.hub.request("POST", `/node/v1/sessions/${c.ref}/interrupt`, {});
  await until(() => s.hub.ended(c.task), 10_000, "turn_end");
  assert.equal((s.hub.ev(c.task).at(-1) as any).stop, "interrupted");
  await s.end();
});

test("quota: Codex (structured, resets_at in ms), ACP (errorKind), pi (text); status carries the quotas", async () => {
  const s = await setup();
  const c = await s.open("codex", "QUOTA");
  const a = await s.open("acp:fake", "QUOTA");
  const p = await s.open("pi", "QUOTA");
  await until(() => s.hub.ended(c.task) && s.hub.ended(a.task) && s.hub.ended(p.task), 10_000, "turn_ends");
  const q = (t: string) => s.hub.ev(t).find((e) => e.k === "quota") as any;
  const now = Date.now();
  assert.ok(q(c.task).resets_at > now + 50 * 60_000 && q(c.task).resets_at < now + 70 * 60_000, "seconds → ms");
  assert.ok(q(a.task).resets_at > now && q(a.task).resets_at < now + 11 * 60_000);
  assert.ok(q(p.task) && q(p.task).resets_at === undefined, "pi has no reset time: the hub retries every 30 min");
  await until(() => s.hub.statuses.some((x) => x.quotas.codex), 5_000, "status");
  await s.end();
});

test("idle release, then the next turn resumes the same session lazily; a running session is not released", async () => {
  const s = await setup();
  const c = await s.open("codex", "SLOW");
  assert.equal((await s.hub.request("DELETE", `/node/v1/sessions/${c.ref}`)).status, 409);
  await until(() => s.hub.ended(c.task), 10_000, "turn_end");
  assert.deepEqual((await s.hub.request("DELETE", `/node/v1/sessions/${c.ref}`)).body, { released: true });
  await until(() => s.hub.statuses.length >= 0, 100);
  const r = await s.hub.request("POST", `/node/v1/sessions/${c.ref}/turns`, { text: "再来一轮", attempt: 1 });
  assert.equal(r.status, 200);
  await until(() => s.hub.ended(c.task, 1, 2), 10_000, "second turn_end");
  assert.match(s.log(), new RegExp(`codex resume ${c.ref}`));
  assert.deepEqual(s.hub.errors, [], "seq went on across the release");
  await s.end();
});

test("resume_ref that can't be resumed → a fresh session with the handoff, fresh:true", async () => {
  const s = await setup();
  const r = await s.open("pi", "接着做", { resume_ref: "/nowhere/gone.jsonl", handoff: "这是接着做的任务" });
  assert.equal(r.body.fresh, true);
  assert.notEqual(r.ref, "/nowhere/gone.jsonl");
  await until(() => s.hub.ended(r.task), 10_000, "turn_end");
  await s.end();
});

test("a worktree when the hub asks for one: <repo>/.sbot-wt/<task> on sbot/<task>, kept out of git status", async () => {
  const s = await setup();
  const o = await s.open("codex", "EDIT", { worktree: { repo: join(s.root, "repo"), branch: "sbot/t1" } });
  assert.match(o.body.workdir, /\.sbot-wt\/t1$/);
  assert.equal(o.body.worktree.branch, "sbot/t1");
  await until(() => s.hub.ended(o.task), 10_000, "turn_end");
  assert.equal(execFileSync("git", ["status", "--porcelain"], { cwd: s.repo, encoding: "utf8" }), "");
  // 清理 refuses while it has changes (no --force), and a path that isn't ours
  assert.equal(((await s.hub.request("POST", "/node/v1/worktrees/cleanup", { path: o.body.workdir })).body as any).removed, false);
  assert.equal(((await s.hub.request("POST", "/node/v1/worktrees/cleanup", { path: s.repo })).body as any).removed, false);
  execFileSync("git", ["checkout", "--", "."], { cwd: o.body.workdir });
  execFileSync("rm", ["-f", "progress.md"], { cwd: o.body.workdir });
  assert.deepEqual((await s.hub.request("POST", "/node/v1/worktrees/cleanup", { path: o.body.workdir })).body, { removed: true });
  execFileSync("git", ["rev-parse", "--verify", "sbot/t1"], { cwd: s.repo });   // the branch stays
  await s.end();
});

test("exec and fs are the local node's; the same daemon refuses unknown routes", async () => {
  const s = await setup();
  const r = await s.hub.request("POST", "/node/v1/exec", { cmd: "echo 本机", cwd: s.root });
  assert.equal((r.body as any).stdout, "本机\n");
  assert.equal((await s.hub.request("POST", "/node/v1/nothing", {})).status, 404);
  await s.end();
});

test("the node killed mid-turn and started again: hello reports the lost session as released, the idle one as idle", async () => {
  const root = mkdtempSync(join(tmpdir(), "sbk-"));
  const hub = new FakeHub();
  const sock = join(root, "hub.sock");
  await hub.listen(sock);
  const repo = gitRepo(root);
  const conf = join(root, "conf");
  mkdirSync(conf);
  writeFileSync(join(conf, "node.yaml"), `only: [codex]\nagents:\n  codex: { bin: ${JSON.stringify(FAKE)}, args: [codex] }\n`);
  const env = { ...process.env, SBOT_NODE_SOCK: sock, SBOT_NODE_STATE: join(root, "state"), SBOT_NODE_CONFIG: conf, SBOT_LOG: "off" };
  const start = () => spawn(process.execPath, [MAIN], { env, stdio: "ignore" });
  let child = start();
  await until(() => hub.hellos.length === 1, 10_000, "hello");
  assert.deepEqual(hub.hellos[0].agents.map((a: any) => a.kind), ["codex"]);
  const idle = (await hub.request("POST", "/node/v1/sessions", { task_id: "t1", attempt: 1, agent: "codex", cwd: repo, prompt: "你好" })).body as any;
  await until(() => hub.ended("t1"), 10_000, "t1 done");
  const busy = (await hub.request("POST", "/node/v1/sessions", { task_id: "t2", attempt: 1, agent: "codex", cwd: repo, prompt: "SLOW" })).body as any;
  await new Promise((r) => setTimeout(r, 300));
  child.kill("SIGKILL");
  await new Promise((r) => child.once("exit", r));
  child = start();
  await until(() => hub.hellos.length === 2, 10_000, "hello after restart");
  const held = Object.fromEntries(hub.hellos[1].sessions.map((x: any) => [x.ref, x.state]));
  assert.equal(held[idle.session_ref], "idle");
  assert.equal(held[busy.session_ref], "released");
  // the answer for a request that died with it: gone; a turn on the idle one resumes it, seq goes on
  assert.deepEqual((await hub.request("POST", "/node/v1/permissions/nope", { option_id: "allow_once" })).body, { ok: false, gone: true });
  assert.equal((await hub.request("POST", `/node/v1/sessions/${idle.session_ref}/turns`, { text: "还在吗", attempt: 1 })).status, 200);
  await until(() => hub.ended("t1", 1, 2), 10_000, "t1 second turn");
  assert.deepEqual(hub.errors, []);
  child.kill("SIGTERM");
  await new Promise((r) => child.once("exit", r));
  await hub.close();
});

test("the hub away: events wait in the spool and go out after the reconnect, in order", async () => {
  const s = await setup();
  const c = await s.open("codex", "SLOW");
  await new Promise((r) => setTimeout(r, 150));
  s.hub.dropNode();
  await until(() => s.hub.hellos.length === 2, 15_000, "reconnect");
  await until(() => s.hub.ended(c.task), 10_000, "turn_end after reconnect");
  assert.deepEqual(s.hub.errors, []);
  assert.equal(s.hub.hellos[1].sessions.find((x: any) => x.ref === c.ref)?.task_id, c.task);
  await s.end();
});
