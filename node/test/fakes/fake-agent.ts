#!/usr/bin/env node
// A scripted stand-in for the three process agents (no login, no model): `fake-agent.ts codex app-server`,
// `fake-agent.ts pi --mode rpc …`, `fake-agent.ts acp`. It speaks each one's wire as the adapters expect it (08) and
// does what the prompt says:
//   EDIT   change README.md and write progress.md          ASK    ask permission for `rm -rf build`, say the answer
//   SLOW   take 1.5 s (time to steer, interrupt, kill)      QUOTA  end on a usage limit
//   PR     run `gh pr create` that prints a PR URL          TOOL   (codex) call the sbot MCP's `echo` tool
// FAKE_LOG: a file it appends every method it gets to, so a test can see set_mode, resume, steer …
import { spawn } from "node:child_process";
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

const kind = process.argv[2];
if (process.argv.includes("--version")) { process.stdout.write(`${kind}-fake 9.9.9\n`); process.exit(0); }
const LOG = process.env.FAKE_LOG;
const note = (m: string) => { if (LOG) appendFileSync(LOG, `${kind} ${m}\n`); };
const v2 = kind === "acp";
const send = (m: object) => process.stdout.write(JSON.stringify(v2 ? { jsonrpc: "2.0", ...m } : m) + "\n");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let nextId = 1000;
const wait = new Map<number, (r: any) => void>();
const ask = (method: string, params: unknown): Promise<any> => new Promise((ok) => { const id = nextId++; wait.set(id, ok); send({ id, method, params }); });

let buf = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (c: string) => {
  buf += c;
  let i: number;
  while ((i = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, i);
    buf = buf.slice(i + 1);
    if (line.trim()) void on(JSON.parse(line));
  }
});
process.stdin.on("end", () => process.exit(0));   // the node closed our stdin: release or the node died

async function on(m: any) {
  if (m.id !== undefined && m.method === undefined && kind !== "pi") { wait.get(m.id)?.(m.result ?? m.error); wait.delete(m.id); return; }
  if (kind === "codex") return codex(m);
  if (kind === "acp") return acp(m);
  return pi(m);
}

function edit(cwd: string) {
  const f = join(cwd, "README.md");
  writeFileSync(f, (existsSync(f) ? readFileSync(f, "utf8") : "") + "第二段改成了三句短句。\n");
  writeFileSync(join(cwd, "progress.md"), "- 改了 README 第二段\n");
}

// ── codex app-server ──
let cx = { cwd: process.cwd(), thread: "", turn: "", steered: [] as string[], interrupted: false, mcp: undefined as any };
async function codex(m: any) {
  note(m.method);
  const ok = (result: unknown) => send({ id: m.id, result });
  switch (m.method) {
    case "initialize": return ok({ userAgent: "fake" });
    case "initialized": return;
    case "thread/start": cx.thread = `th-${randomUUID().slice(0, 8)}`; cx.cwd = m.params.cwd; cx.mcp = m.params.config; return ok({ thread: { id: cx.thread } });
    case "thread/resume": cx.thread = m.params.threadId; cx.cwd = m.params.cwd; cx.mcp = m.params.config; note(`resume ${m.params.threadId}`); return ok({ thread: { id: cx.thread } });
    case "turn/steer": cx.steered.push(m.params.input[0].text); note(`steer ${m.params.expectedTurnId === cx.turn}`); return ok({});
    case "turn/interrupt": cx.interrupted = true; return ok({});
    case "turn/start": {
      cx.turn = `tu-${randomUUID().slice(0, 8)}`;
      ok({ turn: { id: cx.turn } });
      const text = String(m.params.input[0].text);
      const turn = cx.turn;
      send({ method: "turn/started", params: { turn: { id: turn } } });
      const say = (id: string, t: string) => { send({ method: "item/agentMessage/delta", params: { itemId: id, delta: t } }); };
      const done = (status: string, error?: object) => send({ method: "turn/completed", params: { turn: { id: turn, status, ...(error ? { error } : {}) } } });
      if (text.includes("EDIT")) edit(cx.cwd);
      if (text.includes("ASK")) {
        send({ method: "item/started", params: { item: { id: "c1", type: "commandExecution", command: "rm -rf build", cwd: cx.cwd } } });
        const r = await ask("item/commandExecution/requestApproval", { itemId: "c1", command: "rm -rf build", cwd: cx.cwd });
        say("a1", r?.decision === "accept" ? "allowed" : "denied");
        send({ method: "item/completed", params: { item: { id: "c1", type: "commandExecution", status: r?.decision === "accept" ? "completed" : "declined", aggregatedOutput: "" } } });
      }
      if (text.includes("PR")) {
        send({ method: "item/started", params: { item: { id: "c2", type: "commandExecution", command: "gh pr create --fill", cwd: cx.cwd } } });
        send({ method: "item/completed", params: { item: { id: "c2", type: "commandExecution", status: "completed", aggregatedOutput: "https://github.com/demo-org/demo-repo/pull/42\n" } } });
      }
      if (text.includes("TOOL")) say("a3", await mcpCall(cx.mcp));
      if (text.includes("SLOW")) {
        for (let i = 0; i < 15 && !cx.interrupted; i++) { await sleep(100); if (cx.steered.length) say("a1", `steered:${cx.steered.shift()}`); }
        if (cx.interrupted) { cx.interrupted = false; return done("interrupted"); }
      }
      if (text.includes("QUOTA")) {
        send({ method: "account/rateLimits/updated", params: { rateLimits: { primary: { usedPercent: 100, resetsAt: Math.floor(Date.now() / 1000) + 3600 } } } });
        return done("failed", { message: "You've hit your usage limit. Upgrade to Pro", codexErrorInfo: "usageLimitExceeded" });
      }
      say("a1", "你好，");
      say("a1", "完成了");
      send({ method: "item/completed", params: { item: { id: "a1", type: "agentMessage", text: "你好，完成了" } } });
      send({ method: "thread/tokenUsage/updated", params: { tokenUsage: { last: { inputTokens: 12, outputTokens: 5 } } } });
      return done("completed");
    }
  }
  if (m.id !== undefined) send({ id: m.id, error: { code: -32601, message: "no such method" } });
}

/** Start the sbot MCP the way Codex would (from thread/start's config) and call its `echo` tool. */
async function mcpCall(conf: any): Promise<string> {
  const p = spawn(conf["mcp_servers.sbot.command"], conf["mcp_servers.sbot.args"], { env: { ...process.env, ...conf["mcp_servers.sbot.env"] }, stdio: ["pipe", "pipe", "inherit"] });
  let out = "";
  const got = new Map<number, (r: any) => void>();
  p.stdout.setEncoding("utf8");
  p.stdout.on("data", (c: string) => {
    out += c;
    let i: number;
    while ((i = out.indexOf("\n")) >= 0) { const l = JSON.parse(out.slice(0, i)); out = out.slice(i + 1); got.get(l.id)?.(l); }
  });
  const rpc = (id: number, method: string, params: unknown) => new Promise<any>((ok) => { got.set(id, ok); p.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n"); });
  await rpc(1, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "fake", version: "1" } });
  const list = await rpc(2, "tools/list", {});
  const r = await rpc(3, "tools/call", { name: "echo", arguments: { say: "嗨" } });
  p.stdin.end();
  return `tools=${list.result.tools.map((t: any) => t.name).join(",")} result=${r.result.content[0].text}`;
}

// ── ACP ──
const ac = { mode: "auto", session: "", cancelled: false, cwd: process.cwd() };
async function acp(m: any) {
  note(m.method);
  const ok = (result: unknown) => send({ id: m.id, result });
  const upd = (update: object) => send({ method: "session/update", params: { sessionId: ac.session, update } });
  switch (m.method) {
    case "initialize": return ok({ protocolVersion: 1, agentCapabilities: { loadSession: true, sessionCapabilities: { resume: {} } } });
    case "session/new": ac.session = `acp-${randomUUID().slice(0, 8)}`; ac.cwd = m.params.cwd; return ok({ sessionId: ac.session, modes: { currentModeId: "auto", availableModes: [{ id: "auto", name: "Auto" }, { id: "default", name: "Default" }] } });
    case "session/resume": ac.session = m.params.sessionId; note(`resume ${ac.session}`); return ok({ modes: { currentModeId: "auto", availableModes: [{ id: "auto" }, { id: "default" }] } });
    case "session/set_mode": ac.mode = m.params.modeId; note(`mode ${ac.mode}`); return ok({});
    case "session/cancel": ac.cancelled = true; return;
    case "session/prompt": {
      const text = String(m.params.prompt[0].text);
      if (text.includes("ASK")) {
        upd({ sessionUpdate: "tool_call", toolCallId: "k1", title: "rm -rf build", kind: "execute", rawInput: { command: "rm -rf build" } });
        // like claude-agent-acp: in `auto` nothing is asked, everything goes through
        const r = ac.mode === "default" ? await ask("session/request_permission", {
          sessionId: ac.session, toolCall: { toolCallId: "k1", title: "rm -rf build", kind: "execute", rawInput: { command: "rm -rf build" } },
          options: [{ optionId: "ao", name: "Allow", kind: "allow_once" }, { optionId: "aa", name: "Always", kind: "allow_always" }, { optionId: "ro", name: "Reject", kind: "reject_once" }],
        }) : { outcome: { outcome: "selected", optionId: "ao" } };
        note(`answer ${r?.outcome?.optionId ?? r?.outcome?.outcome}`);
        upd({ sessionUpdate: "tool_call_update", toolCallId: "k1", status: r?.outcome?.optionId === "ao" ? "completed" : "failed" });
        upd({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: r?.outcome?.optionId === "ao" ? "allowed" : "denied" } });
      }
      if (text.includes("SLOW")) {
        for (let i = 0; i < 15 && !ac.cancelled; i++) await sleep(100);
        if (ac.cancelled) { ac.cancelled = false; return ok({ stopReason: "cancelled" }); }
      }
      if (text.includes("QUOTA")) return send({ id: m.id, error: { code: -32000, message: "You've hit your limit", data: { errorKind: "rate_limit", rateLimit: { resetsAt: Math.floor(Date.now() / 1000) + 600 } } } });
      upd({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: `好的：${text.slice(0, 20)}` } });
      return ok({ stopReason: "end_turn" });
    }
  }
  if (m.id !== undefined) send({ id: m.id, error: { code: -32601, message: "no such method" } });
}

// ── pi --mode rpc ──
const args = process.argv.slice(3);
const dir = args[args.indexOf("--session-dir") + 1] ?? process.cwd();
let file = args.includes("--session") ? args[args.indexOf("--session") + 1]! : "";
let running = false, aborted = false;
const steers: string[] = [];
async function pi(m: any) {
  note(m.type);
  const res = (data?: unknown) => send({ type: "response", id: m.id, success: true, ...(data !== undefined ? { data } : {}) });
  switch (m.type) {
    case "get_state": {
      if (!file) { file = join(dir, `${randomUUID()}.jsonl`); writeFileSync(file, ""); }
      const n = readFileSync(file, "utf8").split("\n").filter(Boolean).length;
      return res({ sessionFile: file, messageCount: n });
    }
    case "steer": steers.push(m.message); return res();
    case "abort": aborted = true; return res();
    case "prompt": {
      res();
      running = true;
      appendFileSync(file, JSON.stringify({ role: "user", text: m.message }) + "\n");
      const text = String(m.message);
      send({ type: "message_start" });
      if (text.includes("SLOW")) for (let i = 0; i < 15 && !aborted; i++) { await sleep(100); while (steers.length) send({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: `steered:${steers.shift()}` } }); }
      if (text.includes("QUOTA")) {
        send({ type: "message_end", message: { role: "assistant", content: [], stopReason: "error", errorMessage: "429 insufficient_quota: You exceeded your current quota" } });
      } else {
        send({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "pi 好了" } });
        send({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "pi 好了" }], usage: { input: 3, output: 2 }, model: "fake-1" } });
      }
      running = false;
      send({ type: "agent_settled", aborted });
      aborted = false;
      return;
    }
  }
  send({ type: "response", id: m.id, success: false, error: "no such command" });
}
void running;
