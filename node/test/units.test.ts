// The node's pieces on their own: the Claude Code adapter with a fake query() (no login), isReject and the quota
// patterns, the device key store, the sbot MCP program against the ctl socket, and the self-upgrade with rollback.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createPublicKey, verify } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { PassThrough } from "node:stream";
import { claudeAdapter, type QueryFn } from "../src/adapters/claude.ts";
import { isReject, ONCE, type AgentEvent, type Answer } from "../src/adapters/types.ts";
import { looksLikeQuota, resetFromText } from "../src/adapters/quota.ts";
import { freshKey, keyStore, loadKey, newKey } from "../src/keys.ts";
import { runMcp, serveCtl } from "../src/mcp.ts";
import { childEnv } from "../src/sessions.ts";
import { prFrom, run as realRun, type Run } from "../src/git.ts";
import * as up from "../src/upgrade.ts";

const tmp = (p: string) => mkdtempSync(join(tmpdir(), p));

// ── Claude Code ──

function fakeClaude() {
  const seen: { options?: any; inputs: any[]; interrupted: number } = { inputs: [], interrupted: 0 };
  const query: QueryFn = ({ prompt, options }) => {
    seen.options = options;
    const canUse = options.canUseTool as (n: string, i: Record<string, unknown>) => Promise<any>;
    const gen = (async function* () {
      for await (const u of prompt) {
        seen.inputs.push(u);
        if (u.priority === "next") { yield { type: "assistant", message: { id: "m-steer", content: [{ type: "text", text: `steered:${u.message.content}` }] } }; continue; }
        const text = String(u.message.content);
        yield { type: "system", subtype: "init", pid: 4242 };
        yield { type: "stream_event", event: { type: "message_start", message: { id: "m1" } } };
        yield { type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "好" } } };
        if (text.includes("ASK")) {
          const r = await canUse("Bash", { command: "rm -rf build" });
          yield { type: "assistant", message: { id: "m2", content: [{ type: "text", text: r.behavior }] } };
        }
        if (text.includes("QUESTION")) {
          const r = await canUse("AskUserQuestion", { questions: [{ question: "用哪个方案？", options: [{ label: "甲" }, { label: "乙" }] }] });
          yield { type: "assistant", message: { id: "m3", content: [{ type: "text", text: `${r.behavior}:${JSON.stringify(r.updatedInput?.answers ?? null)}` }] } };
        }
        if (text.includes("LIMIT")) {
          yield { type: "rate_limit_event", rate_limit_info: { status: "rejected", resetsAt: Math.floor(Date.now() / 1000) + 7200, rateLimitType: "five_hour" } };
          yield { type: "result", is_error: true, result: "You've hit your limit · resets 5pm", usage: {} };
          continue;
        }
        yield { type: "result", is_error: false, usage: { input_tokens: 3, output_tokens: 4 }, duration_ms: 9 };
      }
    })();
    return Object.assign(gen, { interrupt: async () => { seen.interrupted++; } });
  };
  return { seen, a: claudeAdapter({ query }) };
}

const mcp = { command: "node", args: ["cli.ts", "mcp"], env: { SBOT_NODE_CTL: "/x" }, tools: ["submit_report", "ask"] };

function collect(a: ReturnType<typeof claudeAdapter>, ref: string, done: (e: AgentEvent[]) => boolean): Promise<AgentEvent[]> {
  const got: AgentEvent[] = [];
  return new Promise((ok) => { a.subscribe(ref, (e) => { got.push(e); if (done(got)) ok(got); }); });
}

test("claude: permissionMode default, only our own tools pre-allowed, user/project/local settings, a fresh session id", async () => {
  const { seen, a } = fakeClaude();
  const ref = await a.createSession({ cwd: "/tmp", mcp, env: { PATH: "/usr/bin" }, prompt: "你好" });
  const ev = await collect(a, ref, (g) => g.some((e) => e.k === "turn_end"));
  const o = seen.options;
  assert.equal(o.permissionMode, "default");
  assert.deepEqual(o.allowedTools, ["mcp__sbot__submit_report", "mcp__sbot__ask"]);
  assert.deepEqual(o.settingSources, ["user", "project", "local"]);
  assert.equal(o.sessionId, ref);
  assert.deepEqual(o.mcpServers.sbot, { type: "stdio", command: "node", args: ["cli.ts", "mcp"], env: { SBOT_NODE_CTL: "/x" } });
  assert.equal("dangerouslySkipPermissions" in o || "allowDangerouslySkipPermissions" in o, false);
  assert.deepEqual(ev.map((e) => e.k), ["text", "usage", "turn_end"]);
  assert.equal(a.pid?.(ref), 4242);
  await a.release(ref);
});

test("claude: a tool request → permission; a bare reject denies, allow_once allows", async () => {
  const { a } = fakeClaude();
  const ref = await a.createSession({ cwd: "/tmp", mcp, env: {}, prompt: "ASK" });
  const answer = (ans: Answer) => new Promise<AgentEvent[]>((ok) => {
    const got: AgentEvent[] = [];
    const off = a.subscribe(ref, (e) => {
      got.push(e);
      if (e.k === "permission") { assert.equal((e.request.detail as any).command, "rm -rf build"); void a.respondToPermission(ref, e.request.id, ans); }
      if (e.k === "turn_end") { off(); ok(got); }
    });
  });
  const first = await answer({ option_id: "reject" });
  assert.equal((first.find((e) => e.k === "message") as any).text, "deny");
  await a.startTurn(ref, "ASK");
  const second = await answer({ option_id: "allow_once" });
  assert.equal((second.find((e) => e.k === "message") as any).text, "allow");
  await a.release(ref);
});

test("claude: AskUserQuestion becomes an ask; my answers go back in updatedInput.answers", async () => {
  const { a } = fakeClaude();
  const ref = await a.createSession({ cwd: "/tmp", mcp, env: {}, prompt: "QUESTION" });
  const got: AgentEvent[] = [];
  await new Promise<void>((ok) => a.subscribe(ref, (e) => {
    got.push(e);
    if (e.k === "ask") { assert.deepEqual(e.request.options.map((x) => x.id), ["甲", "乙"]); void a.respondToPermission(ref, e.request.id, { option_id: "乙" }); }
    if (e.k === "turn_end") ok();
  }));
  assert.equal((got.find((e) => e.k === "message") as any).text, 'allow:{"用哪个方案？":"乙"}');
  await a.release(ref);
});

test("claude: steer is a priority-next message in the running turn; interrupt goes to the query", async () => {
  const { seen, a } = fakeClaude();
  const ref = await a.createSession({ cwd: "/tmp", mcp, env: {}, prompt: "ASK" });
  const got: AgentEvent[] = [];
  let perm = "";
  a.subscribe(ref, (e) => { got.push(e); if (e.k === "permission") perm = e.request.id; });
  while (!perm) await new Promise((r) => setTimeout(r, 5));
  assert.equal(await a.steer(ref, "顺便"), true);
  await a.interrupt(ref);
  assert.equal(seen.interrupted, 1);
  await a.respondToPermission(ref, perm, { option_id: "allow_once" });
  while (!got.some((e) => e.k === "turn_end")) await new Promise((r) => setTimeout(r, 5));
  assert.equal(seen.inputs[1].priority, "next");
  assert.equal((got.find((e) => e.k === "turn_end") as any).stop, "interrupted");
  await new Promise((r) => setTimeout(r, 20));
  assert.ok(got.some((e) => e.k === "message" && e.text === "steered:顺便"));
  assert.equal(await a.steer(ref, "晚了"), false, "no turn running");
  await a.release(ref);
});

test("claude: rate_limit_event rejected → quota with resets_at in ms; the limit text too", async () => {
  const { a } = fakeClaude();
  const ref = await a.createSession({ cwd: "/tmp", mcp, env: {}, prompt: "LIMIT" });
  const ev = await collect(a, ref, (g) => g.some((e) => e.k === "turn_end"));
  const qs = ev.filter((e) => e.k === "quota") as any[];
  assert.ok(qs[0].resets_at > Date.now() + 100 * 60_000 && qs[0].resets_at < Date.now() + 130 * 60_000);
  assert.match(qs[1].text, /hit your limit/);
  assert.equal((ev.at(-1) as any).stop, "error");
  await a.release(ref);
});

test("claude: the query ending under a running turn → turn_end interrupted, onExit", async () => {
  let fail!: () => void;
  const query: QueryFn = () => Object.assign((async function* () { await new Promise<void>((r) => (fail = r)); throw new Error("CLI 崩了"); })(), { interrupt: async () => {} });
  const a = claudeAdapter({ query });
  let exited = "";
  a.onExit = (_r, why) => { exited = why; };
  const ref = await a.createSession({ cwd: "/tmp", mcp, env: {}, prompt: "x" });
  const p = collect(a, ref, (g) => g.some((e) => e.k === "turn_end"));
  while (!fail) await new Promise((r) => setTimeout(r, 5));
  fail();
  const ev = await p;
  assert.equal((ev.at(-1) as any).stop, "interrupted");
  await new Promise((r) => setTimeout(r, 10));
  assert.match(exited, /CLI 崩了/);
});

// ── shared pieces ──

test("isReject: the bare `reject`, a reject kind, an unknown id and an empty answer are all no (fail closed)", () => {
  assert.equal(isReject({ option_id: "reject" }, ONCE), true);
  assert.equal(isReject({ option_id: "reject_once" }, ONCE), true);
  assert.equal(isReject({ option_id: "who-knows" }, ONCE), true);
  assert.equal(isReject({}, ONCE), true);
  assert.equal(isReject({ text: "别这样，换个办法" }, ONCE), true);   // words without a choice: no, never a yes
  assert.equal(isReject({ option_id: "allow_once" }, ONCE), false);
  assert.equal(isReject({ option_id: "x" }, [{ id: "x", label: "否", kind: "deny" }]), true);
});

test("quota text: each agent's own words; reset times when the text has one", () => {
  assert.ok(looksLikeQuota("claude", "You've hit your weekly limit · resets Mon"));
  assert.ok(looksLikeQuota("codex", "You’ve hit your usage limit. Try again in ~12 min."));
  assert.ok(looksLikeQuota("pi", "429 insufficient_quota"));
  assert.ok(looksLikeQuota("acp:gemini", '{"errorKind": "rate_limit"}'));
  assert.ok(!looksLikeQuota("claude", "Tool failed: file not found"));
  const now = Date.parse("2026-11-28T10:00:00Z");
  assert.equal(resetFromText("Try again in ~12 min.", now), now + 12 * 60_000);
  assert.equal(resetFromText("no time here", now), undefined);
});

test("the agent's environment: none of the node's SBOT_* variables, no outer Claude Code session markers", () => {
  const e = childEnv({ PATH: "/bin", SBOT_NODE_MCP_KEY: "k", SBOT_HOME: "/h", CLAUDECODE: "1", CLAUDE_CODE_ENTRYPOINT: "cli", CLAUDE_CODE_OAUTH_TOKEN: "own-login", LANG: "C" });
  assert.deepEqual(e, { PATH: "/bin", CLAUDE_CODE_OAUTH_TOKEN: "own-login", LANG: "C" });
});

test("PR detection only from `gh pr create`", () => {
  assert.deepEqual(prFrom("gh pr create --fill", "https://github.com/demo-org/demo/pull/7\n"), { url: "https://github.com/demo-org/demo/pull/7", repo: "demo-org/demo", number: 7 });
  assert.equal(prFrom("cat notes.md", "https://github.com/demo-org/demo/pull/7"), undefined);
});

test("device key (file store): 0600, the same id back, signatures check with the public key only", () => {
  const dir = join(tmp("sbk-"), "conf");
  const store = keyStore(dir, { SBOT_NODE_KEYSTORE: "file" });
  assert.equal(loadKey(store), undefined);
  const k = newKey(store);
  assert.equal(statSync(join(dir, "device.key")).mode & 0o777, 0o600);
  const again = loadKey(store)!;
  assert.equal(again.deviceId, k.deviceId);
  assert.match(k.deviceId, /^[0-9a-f]{64}$/);
  const msg = new TextEncoder().encode("sbot-auth/1 fictional");
  const pub = createPublicKey({ key: Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), Buffer.from(k.publicKey)]), format: "der", type: "spki" });
  assert.ok(verify(null, msg, pub, again.sign(msg)));
  // a re-pair holds its key in memory until the hub accepts: refused, the old pairing stays
  const pending = freshKey(store);
  assert.equal(loadKey(store)!.deviceId, k.deviceId, "not saved yet");
  pending.save();
  assert.equal(loadKey(store)!.deviceId, pending.deviceId);
  assert.notEqual(newKey(store).deviceId, pending.deviceId, "pairing again is a new device");
});

test("sbot MCP program: tools from the session (from the hub), a call carries its task; an unknown key gets nothing", async () => {
  const dir = tmp("sbm-");
  const calls: any[] = [];
  const srv = await serveCtl(join(dir, "ctl.sock"), {
    session: (key) => (key === "good" ? { task_id: "t9", attempt: 2, tools: [{ name: "submit_report", description: "交报告", schema: { type: "object" } }] } : undefined),
    helloTools: () => [{ name: "status", description: "看状态", schema: null }],
    call: async (b) => { calls.push(b); return { text: `做了 ${b.name}` }; },
  });
  assert.equal(statSync(join(dir, "ctl.sock")).mode & 0o777, 0o600);
  const talk = async (key: string | undefined, lines: object[]) => {
    const i = new PassThrough(), o = new PassThrough();
    let out = "";
    o.on("data", (c) => (out += c));
    const done = runMcp({ SBOT_NODE_CTL: join(dir, "ctl.sock"), ...(key ? { SBOT_NODE_MCP_KEY: key } : {}) }, i, o);
    for (const l of lines) i.write(JSON.stringify({ jsonrpc: "2.0", ...l }) + "\n");
    await new Promise((r) => setTimeout(r, 300));
    i.end();
    await done;
    return out.trim().split("\n").map((l) => JSON.parse(l));
  };
  const r = await talk("good", [
    { id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } },
    { method: "notifications/initialized" },
    { id: 2, method: "tools/list" },
    { id: 3, method: "tools/call", params: { name: "submit_report", arguments: { text: "好了" } } },
  ]);
  assert.equal(r[0].result.serverInfo.name, "sbot");
  assert.deepEqual(r[1].result.tools.map((t: any) => t.name), ["submit_report"]);
  assert.deepEqual(r[2].result.content, [{ type: "text", text: "做了 submit_report" }]);
  assert.deepEqual([calls[0].task_id, calls[0].attempt, calls[0].args], ["t9", 2, { text: "好了" }]);
  const adhoc = await talk(undefined, [{ id: 1, method: "tools/list" }, { id: 2, method: "tools/call", params: { name: "status", arguments: {} } }]);
  assert.deepEqual(adhoc[0].result.tools.map((t: any) => t.name), ["status"]);
  assert.equal(calls[1].task_id, undefined, "ad hoc: no task (the hub 403s it unless mcp_open)");
  const bad = await talk("stale", [{ id: 1, method: "tools/call", params: { name: "submit_report", arguments: {} } }]);
  assert.equal(bad[0].result.isError, true);
  assert.equal(calls.length, 2);
  srv.close();
});

// ── self-upgrade ──

const A = "a".repeat(40), B = "b".repeat(40);

function installed() {
  const root = tmp("sbu-");
  const l = up.layout(root);
  for (const s of [A, B]) { mkdirSync(join(l.releases, s), { recursive: true }); writeFileSync(join(l.releases, s, ".ok"), "1"); }
  symlinkSync(join(l.releases, A), l.current);
  return l;
}

test("upgrade: swap and trial; up 30 s and connected → ok, reported once in hello", () => {
  const l = installed();
  up.begin(l, A, B);
  assert.equal(basename(readlinkSync(l.current)), B);
  assert.deepEqual(up.startup(l, B), { trial: true });
  up.passed(l);
  assert.deepEqual(up.startup(l, B), { report: { from: A, to: B, ok: true } });
  up.reported(l);
  assert.deepEqual(up.startup(l, B), {});
});

test("upgrade: the new version starts twice inside the trial (it crashed) → back to the old, which reports it and skips that sha", () => {
  const l = installed();
  up.begin(l, A, B);
  assert.deepEqual(up.startup(l, B), { trial: true });
  assert.deepEqual(up.startup(l, B), { rollback: true });
  assert.equal(basename(readlinkSync(l.current)), A);
  const r = up.startup(l, A);
  assert.equal(r.report?.ok, false);
  assert.deepEqual([r.report?.from, r.report?.to], [A, B]);
  assert.match(r.report?.error ?? "", /30 秒/);
  assert.deepEqual(up.failedShas(l), [B]);
});

test("upgrade: no hub within 30 s → rolled back the same way", () => {
  const l = installed();
  up.begin(l, A, B);
  up.startup(l, B);
  up.failed(l, "新版本 30 秒内没连上主");
  assert.equal(basename(readlinkSync(l.current)), A);
  assert.equal(up.startup(l, A).report?.error, "新版本 30 秒内没连上主");
});

test("upgrade: only a commit on origin/main; then export, npm ci --ignore-scripts, self-check, ready", async () => {
  const root = tmp("sbp-");
  const origin = join(root, "origin");
  mkdirSync(origin);
  const g = (cwd: string, ...a: string[]) => execFileSync("git", ["-c", "user.name=测试", "-c", "user.email=sbot@localhost", "-c", "commit.gpgsign=false", ...a], { cwd, encoding: "utf8" }).trim();
  const commit = (f: string, msg: string) => { writeFileSync(join(origin, f), `${msg}\n`); g(origin, "add", "."); g(origin, "commit", "-q", "-m", msg); return g(origin, "rev-parse", "HEAD"); };
  g(origin, "init", "-q", "-b", "main");
  const onMain = commit("package.json", "主线");
  g(origin, "checkout", "-q", "-b", "side");
  const side = commit("x.txt", "旁支");
  g(origin, "checkout", "-q", "main");
  const inst = join(root, "inst");
  mkdirSync(inst);
  g(inst, "clone", "-q", origin, "repo");
  const l = up.layout(inst);
  await assert.rejects(up.prepare(l, side), /不在 main 上/);
  await assert.rejects(up.prepare(l, "c".repeat(40)), /没有这个提交/);
  await assert.rejects(up.prepare(l, "main"), /完整的提交号/);
  // npm and the self-check stubbed (no network in tests); git and tar are real
  const ran: string[] = [];
  const fake: Run = async (cmd, args, o) => {
    ran.push(`${basename(cmd)} ${args.join(" ")}`);
    if (cmd === "npm") return { code: 0, out: "", err: "" };
    if (cmd === process.execPath) return { code: 0, out: "selftest ok\n", err: "" };
    return realRun(cmd, args, o);
  };
  const dir = await up.prepare(l, onMain, fake);
  assert.equal(dir, join(l.releases, onMain));
  assert.equal(readFileSync(join(dir, "REVISION"), "utf8").trim(), onMain);
  assert.ok(existsSync(join(dir, "package.json")) && existsSync(join(dir, ".ok")));
  assert.ok(ran.some((r) => r.startsWith("npm ci --ignore-scripts")));
  // a release that fails its self-check is not kept
  const next = commit("y.txt", "再一个");
  const bad: Run = async (cmd, args, o) => (cmd === process.execPath ? { code: 1, out: "", err: "SyntaxError" } : cmd === "npm" ? { code: 0, out: "", err: "" } : realRun(cmd, args, o));
  await assert.rejects(up.prepare(l, next, bad), /自检没过/);
  assert.equal(existsSync(join(l.releases, next)), false);
});
