// Claude Code: @anthropic-ai/claude-agent-sdk 0.3.332 query() with streaming input (05, 08 P5). Pushing a message with
// priority "next" is the in-turn steer. Rules from the probe, kept here:
//   - permissionMode "default" explicitly: left out, the SDK starts in `auto` where that is available (a classifier
//     approves), which would answer for me
//   - settingSources user/project/local, but the workspace trust is never pre-recorded (P5–P8 ※): project rules and
//     hooks only load for a workspace already trusted on this machine, so in practice only my user-level rules apply
//   - allowedTools holds only our own mcp__sbot__* tools (a tool listed there skips canUseTool); the gate is on the hub
//   - AskUserQuestion is caught in canUseTool and becomes an `ask`; the answers go back in updatedInput.answers
// The sbot MCP is the same stdio program the other agents use ※ (05 had in-process; one implementation for all four).
// On a Linux node with worker-exec configured, the CLI starts through it (sbot-h --host, or sbot-w sandbox).
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { Channel, ONCE, Table, errText, isReject, toMs, type AgentAdapter, type Answer, type OpenOpts } from "./types.ts";
import { looksLikeQuota, resetFromText } from "./quota.ts";

type Msg = Record<string, any>;
/** The slice of the SDK's Query the adapter uses (a fake in tests). */
export interface QueryLike extends AsyncIterable<Msg> { interrupt(): Promise<void>; close?(): void }
export type QueryFn = (a: { prompt: AsyncIterable<Msg>; options: Record<string, unknown> }) => QueryLike;

class Input implements AsyncIterable<Msg> {
  #q: Msg[] = [];
  #wake: (() => void) | undefined;
  #done = false;
  push(text: string, priority?: "now" | "next" | "later") {
    this.#q.push({ type: "user", message: { role: "user", content: text }, parent_tool_use_id: null, ...(priority ? { priority } : {}) });
    this.#wake?.();
  }
  end() { this.#done = true; this.#wake?.(); }
  async *[Symbol.asyncIterator]() {
    for (;;) {
      while (this.#q.length) yield this.#q.shift()!;
      if (this.#done) return;
      await new Promise<void>((ok) => (this.#wake = ok));
    }
  }
}

type S = { ch: Channel; input: Input; q: QueryLike; abort: AbortController; running: boolean; interrupting: boolean; released: boolean; pid?: number; item: string };

export interface ClaudeOpts {
  /** a Claude Code binary; absent = the SDK's bundled one */
  bin?: string;
  model?: string;
  /** Linux: /usr/local/lib/sbot/worker-exec (started with sudo -n); absent = a plain child */
  workerExec?: string;
  /** tests: a fake query() */
  query?: QueryFn;
}

let prefixes: readonly string[] | undefined;

async function sdkQuery(): Promise<QueryFn> {
  const sdk = await import("@anthropic-ai/claude-agent-sdk");
  prefixes = (sdk as { USAGE_LIMIT_ERROR_PREFIXES?: readonly string[] }).USAGE_LIMIT_ERROR_PREFIXES;
  return sdk.query as unknown as QueryFn;
}

const isQuotaText = (t: string) => (prefixes ?? []).some((p) => t.startsWith(p)) || looksLikeQuota("claude", t);

export function claudeAdapter(o: ClaudeOpts = {}): AgentAdapter {
  const t = new Table<S>();
  let q: QueryFn | undefined = o.query;
  const a: AgentAdapter = {
    kind: "claude",
    caps: () => ({ steer: true, resume: true, rewind: false, permissions: true, ask: true }),
    async createSession(x) {
      const ref = randomUUID();
      const s = await open(x, { sessionId: ref });
      t.set(ref, s);
      watch(ref, s);
      s.running = true;
      s.input.push(x.prompt);
      return ref;
    },
    async resumeSession(ref, x) {
      const s = await open(x, { resume: ref });
      t.set(ref, s);
      watch(ref, s);
    },
    async startTurn(ref, text) { const s = t.get(ref); s.running = true; s.input.push(text); },
    async steer(ref, text) {
      const s = t.get(ref);
      if (!s.running) return false;
      s.input.push(text, "next");
      return true;
    },
    async interrupt(ref) { const s = t.get(ref); s.interrupting = true; await s.q.interrupt(); },
    subscribe: (ref, on) => t.get(ref).ch.subscribe(on),
    getPendingPermissions: (ref) => t.get(ref).ch.pending(),
    async respondToPermission(ref, id, ans) { if (!t.get(ref).ch.respond(id, ans)) throw new Error("没有这条请求"); },
    async release(ref) {
      const s = t.find(ref);
      if (!s) return;
      s.released = true;
      t.delete(ref);
      s.input.end();
      s.abort.abort();
    },
    pid: (ref) => t.find(ref)?.pid,
  };

  async function open(x: OpenOpts, id: { sessionId?: string; resume?: string }): Promise<S> {
    q ??= await sdkQuery();
    const ch = new Channel();
    const input = new Input();
    const abort = new AbortController();
    const s = { ch, input, abort, running: false, interrupting: false, released: false, item: "" } as S;
    const options: Record<string, unknown> = {
      cwd: x.cwd,
      env: x.env,
      ...(o.model ? { model: o.model } : {}),
      ...(o.bin ? { pathToClaudeCodeExecutable: o.bin } : {}),
      ...id,
      abortController: abort,
      includePartialMessages: true,
      systemPrompt: { type: "preset", preset: "claude_code" },
      permissionMode: "default",
      settingSources: ["user", "project", "local"],
      mcpServers: { sbot: { type: "stdio", command: x.mcp.command, args: x.mcp.args, env: x.mcp.env } },
      allowedTools: x.mcp.tools.map((n) => `mcp__sbot__${n}`),
      canUseTool: (name: string, input: Record<string, unknown>) => canUse(s, name, input),
      stderr: () => {},   // the CLI's own log is not ours to keep (it may quote the repo)
      ...(o.workerExec && process.platform === "linux" ? { spawnClaudeCodeProcess: viaWorkerExec(o.workerExec, x.mode, (pid) => { s.pid = pid; }) } : {}),
    };
    s.q = q({ prompt: input, options });
    return s;
  }

  async function canUse(s: S, name: string, input: Record<string, unknown>) {
    if (name === "AskUserQuestion") {
      const qs = (Array.isArray(input.questions) ? input.questions : []) as { question: string; options?: { label: string }[] }[];
      const opts = (qs[0]?.options ?? []).map((x) => ({ id: x.label, label: x.label, kind: "answer" }));
      const ans: Answer = await s.ch.request("ask", { title: qs[0]?.question ?? "它在问你", detail: { tool: name, questions: qs }, options: opts });
      if (ans.option_id === "reject" || (!ans.option_id && !ans.text && !ans.answers)) return { behavior: "deny" as const, message: "我没回答这个问题。" };
      const answers = Object.fromEntries(qs.map((x) => [x.question, ans.answers?.[x.question] ?? ans.text ?? ans.option_id ?? ""]));
      return { behavior: "allow" as const, updatedInput: { ...input, answers } };
    }
    const cmd = typeof input.command === "string" ? input.command : undefined;
    const path = typeof input.file_path === "string" ? input.file_path : typeof input.path === "string" ? input.path : undefined;
    const title = cmd ? `要跑命令：${cmd.slice(0, 300)}` : path ? `${name}：${path}` : `要用 ${name}`;
    const ans = await s.ch.request("permission", { title, detail: { tool: name, ...(cmd ? { command: cmd } : {}), ...(path ? { path } : {}), args: input }, options: ONCE });
    return isReject(ans, ONCE) ? { behavior: "deny" as const, message: ans.text || "我拒绝了这一步。" } : { behavior: "allow" as const, updatedInput: input };
  }

  function watch(ref: string, s: S) {
    void (async () => {
      let why = "";
      try { for await (const m of s.q) on(s, m); }
      catch (e) { why = errText(e); }
      s.ch.dropPending();
      if (s.released) return;
      // the process ended under a turn: a restart for the hub (cards void, 「需要你处理」, §办3.3)
      if (s.running) s.ch.emit({ k: "turn_end", stop: "interrupted", error: why || "Claude Code 退出了" });
      s.running = false;
      t.delete(ref);
      a.onExit?.(ref, why || "ended");
    })();
  }

  function on(s: S, m: Msg) {
    if (m.type === "stream_event") {
      const e = m.event ?? {};
      if (e.type === "message_start") s.item = String(e.message?.id ?? s.item);
      else if (e.type === "content_block_delta" && e.delta?.type === "text_delta") s.ch.emit({ k: "text", item: s.item, delta: String(e.delta.text ?? "") });
      return;
    }
    if (m.type === "assistant") {
      if (m.error === "rate_limit") s.ch.emit({ k: "quota", text: "rate_limit" });
      for (const b of m.message?.content ?? []) {
        if (b.type === "text") s.ch.emit({ k: "message", item: String(m.message.id), text: String(b.text ?? "") });
        else if (b.type === "tool_use") s.ch.emit({ k: "tool_start", item: String(b.id), name: String(b.name), args: b.input });
      }
      return;
    }
    if (m.type === "user" && Array.isArray(m.message?.content)) {
      for (const b of m.message.content) if (b.type === "tool_result") s.ch.emit({ k: "tool_end", item: String(b.tool_use_id), ok: !b.is_error, result: b.content });
      return;
    }
    if (m.type === "system" && m.subtype === "init" && typeof m.pid === "number") { s.pid ??= m.pid; return; }
    if (m.type === "rate_limit_event" && m.rate_limit_info?.status === "rejected") {
      const at = toMs(m.rate_limit_info.resetsAt);
      s.ch.emit({ k: "quota", ...(at ? { resets_at: at } : {}), remaining: m.rate_limit_info });
      return;
    }
    if (m.type === "result") {
      s.ch.emit({ k: "usage", ...(Number.isInteger(m.usage?.input_tokens) ? { input_tokens: m.usage.input_tokens } : {}), ...(Number.isInteger(m.usage?.output_tokens) ? { output_tokens: m.usage.output_tokens } : {}), ...(Number.isInteger(m.duration_ms) ? { ms: m.duration_ms } : {}) });
      const error = m.is_error ? String(m.result ?? (Array.isArray(m.errors) ? m.errors.join("; ") : m.subtype)) : undefined;
      if (error && isQuotaText(error)) {
        const at = resetFromText(error);
        s.ch.emit({ k: "quota", ...(at ? { resets_at: at } : {}), text: error.slice(0, 500) });
      }
      const stop = s.interrupting ? "interrupted" : error ? "error" : "done";
      s.interrupting = false;
      s.running = false;
      s.ch.emit({ k: "turn_end", stop, ...(stop === "error" ? { error } : {}) });
    }
  }

  return a;
}

/**
 * Start the CLI through worker-exec (deploy/worker, unchanged): `sudo -n worker-exec [--host] <args>`. worker-exec
 * runs its own pinned CLI, so only the arguments go through; the cwd must be a task dir of that mode (its own check).
 * The env worker-exec keeps is ANTHROPIC_*, CLAUDE_*, LANG (sudoers env_keep); nothing of ours is in it.
 */
function viaWorkerExec(workerExec: string, mode: string | undefined, onPid: (pid: number) => void) {
  return (sp: { command: string; args: string[]; cwd?: string; env: Record<string, string | undefined>; signal: AbortSignal }) => {
    const host = mode !== "sandbox";
    // the SDK passes [<cli>, ...args] or [...args] for a native binary; worker-exec brings the CLI itself
    const args = sp.args[0] && /claude(\.js)?$/.test(sp.args[0]) ? sp.args.slice(1) : sp.args;
    const child = spawn("sudo", ["-n", workerExec, ...(host ? ["--host"] : []), ...args], { cwd: sp.cwd, env: sp.env as NodeJS.ProcessEnv, stdio: ["pipe", "pipe", "pipe"], signal: sp.signal });
    if (child.pid) onPid(child.pid);
    return child;
  };
}
