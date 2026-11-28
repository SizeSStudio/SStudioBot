// Codex：`codex app-server`，stdio 上的 JSON-RPC（不带 jsonrpc 字段）。
import { spawn } from "node:child_process";
import { ALLOW_DENY, Channel, type AgentAdapter, type McpMount } from "../adapter.ts";
import { readJsonl } from "../lib/jsonl.ts";
import { looksLikeQuota } from "../lib/quota.ts";

type Session = { ch: Channel; turnId?: string; changes: Map<string, any>; lastError?: string };

export function codexAdapter(opts: {
  model?: string;
  env: Record<string, string>;
  args?: string[];
  approvalPolicy: string;
  sandbox: string;
  onRaw?: (m: any) => void;
}): AgentAdapter & { close(): void; pid(): number | undefined } {
  const sessions = new Map<string, Session>();
  const waiting = new Map<number, { ok: (v: any) => void; fail: (e: Error) => void }>();
  let next = 0;
  let proc: ReturnType<typeof spawn> | undefined;
  let ready: Promise<void> | undefined;

  const send = (m: object) => proc!.stdin!.write(JSON.stringify(m) + "\n");
  const call = <T = any>(method: string, params: object) =>
    new Promise<T>((ok, fail) => {
      const id = ++next;
      waiting.set(id, { ok, fail });
      send({ id, method, params });
    });

  function start() {
    return (ready ??= (async () => {
      proc = spawn("codex", ["app-server", ...(opts.args ?? [])], { env: opts.env, stdio: ["pipe", "pipe", "pipe"] });
      proc.stderr!.resume();
      proc.on("exit", () => {
        for (const w of waiting.values()) w.fail(new Error("app-server exited"));
        waiting.clear();
      });
      readJsonl(proc.stdout!, (m) => {
        opts.onRaw?.(m);
        if (m.method && m.id !== undefined) void onRequest(m);
        else if (m.method) onNotification(m.method, m.params);
        else {
          const w = waiting.get(m.id);
          waiting.delete(m.id);
          if (m.error) w?.fail(new Error(JSON.stringify(m.error)));
          else w?.ok(m.result);
        }
      });
      await call("initialize", { clientInfo: { name: "sbot_probe", title: "sbot probe", version: "0.0.0" } });
      send({ method: "initialized" });
    })());
  }

  async function onRequest(m: { id: number; method: string; params: any }) {
    const s = sessions.get(m.params.threadId);
    const reply = (result: object) => send({ id: m.id, result });
    if (!s) return send({ id: m.id, error: { code: -32601, message: "unknown thread" } });
    if (m.method === "item/commandExecution/requestApproval") {
      const a = await s.ch.request("permission", { title: "command", detail: m.params.command ?? "", options: ALLOW_DENY });
      reply({ decision: a.option_id === "allow" ? "accept" : "decline" });
    } else if (m.method === "item/fileChange/requestApproval") {
      const changes = s.changes.get(m.params.itemId) ?? [];
      const a = await s.ch.request("permission", { title: "fileChange", detail: JSON.stringify(changes), options: ALLOW_DENY });
      reply({ decision: a.option_id === "allow" ? "accept" : "decline" });
    } else if (m.method === "item/tool/requestUserInput") {
      const a = await s.ch.request("ask", { title: "ask", detail: JSON.stringify(m.params.questions), options: [], questions: m.params.questions });
      reply({ answers: Object.fromEntries(m.params.questions.map((q: any) => [q.id, { answers: [a.text ?? a.option_id] }])) });
    } else if (m.method === "mcpServer/elicitation/request") {
      const a = await s.ch.request("permission", { title: `mcp:${m.params.serverName}`, detail: m.params.message, options: ALLOW_DENY });
      reply({ action: a.option_id === "allow" ? "accept" : "decline", content: a.option_id === "allow" ? {} : null, _meta: null });
    } else send({ id: m.id, error: { code: -32601, message: `unsupported ${m.method}` } });
  }

  function onNotification(method: string, p: any) {
    const s = sessions.get(p?.threadId);
    if (!s) return;
    if (method === "turn/started") s.turnId = p.turn.id;
    else if (method === "item/agentMessage/delta") s.ch.emit({ k: "text", item: p.itemId, delta: p.delta });
    else if (method === "item/started") {
      const it = p.item;
      if (it.type === "commandExecution") s.ch.emit({ k: "tool_start", item: it.id, name: "command", args: { command: it.command } });
      if (it.type === "fileChange") {
        s.changes.set(it.id, it.changes);
        s.ch.emit({ k: "tool_start", item: it.id, name: "fileChange", args: { changes: it.changes } });
      }
      if (it.type === "mcpToolCall") s.ch.emit({ k: "tool_start", item: it.id, name: `${it.server}.${it.tool}`, args: it.arguments });
    } else if (method === "item/completed") {
      const it = p.item;
      if (it.type === "agentMessage") s.ch.emit({ k: "message", item: it.id, text: it.text });
      if (it.type === "commandExecution") s.ch.emit({ k: "tool_end", item: it.id, ok: it.status === "completed", result: it.aggregatedOutput });
      if (it.type === "fileChange") s.ch.emit({ k: "tool_end", item: it.id, ok: it.status === "completed" });
      if (it.type === "mcpToolCall") s.ch.emit({ k: "tool_end", item: it.id, ok: it.status === "completed", result: it.result ?? it.error });
    } else if (method === "turn/diff/updated") {
      s.ch.emit({ k: "tool_end", item: `diff:${p.turnId}`, ok: true, diff: p.diff });
    } else if (method === "thread/tokenUsage/updated") {
      const u = p.tokenUsage?.last;
      s.ch.emit({ k: "usage", input_tokens: u?.inputTokens, output_tokens: u?.outputTokens });
    } else if (method === "error") {
      s.lastError = p.error?.message;
    } else if (method === "turn/completed") {
      const t = p.turn;
      const error = t.error?.message;
      const info = t.error?.codexErrorInfo;
      if (info === "usageLimitExceeded" || info === "rateLimitExceeded" || (error && looksLikeQuota("codex", error)))
        s.ch.emit({ k: "quota", remaining: info });
      s.turnId = undefined;
      s.ch.emit({ k: "turn_end", stop: t.status === "completed" ? "done" : t.status === "interrupted" ? "interrupted" : "error", error });
    }
  }

  const threadParams = (cwd: string, mcp: McpMount) => ({
    cwd,
    model: opts.model,
    approvalPolicy: opts.approvalPolicy,
    sandbox: opts.sandbox,
    // 每个线程单独挂 sbot，不改 ~/.codex/config.toml。
    config: {
      model_reasoning_effort: "low",
      "mcp_servers.sbot.command": mcp.command,
      "mcp_servers.sbot.args": mcp.args,
      "mcp_servers.sbot.env": mcp.env,
    },
  });
  const get = (ref: string) => {
    const s = sessions.get(ref);
    if (!s) throw new Error(`no session ${ref}`);
    return s;
  };
  const startTurn = async (ref: string, text: string) => {
    const r = await call("turn/start", { threadId: ref, input: [{ type: "text", text, text_elements: [] }] });
    get(ref).turnId = r.turn.id;
  };

  return {
    caps: () => ({ steer: true, resume: true, rewind: false, permissions: true, ask: false }),
    async createSession({ cwd, prompt, mcp }) {
      await start();
      const r = await call("thread/start", threadParams(cwd, mcp));
      const ref = r.thread.id as string;
      sessions.set(ref, { ch: new Channel(), changes: new Map() });
      await startTurn(ref, prompt);
      return ref;
    },
    async resumeSession(ref, { cwd, mcp }) {
      await start();
      sessions.set(ref, { ch: new Channel(), changes: new Map() });
      await call("thread/resume", { threadId: ref, ...threadParams(cwd, mcp) });
    },
    startTurn,
    async steer(ref, text) {
      const { turnId } = get(ref);
      if (!turnId) return false;
      await call("turn/steer", { threadId: ref, expectedTurnId: turnId, input: [{ type: "text", text, text_elements: [] }] });
      return true;
    },
    async interrupt(ref) {
      await call("turn/interrupt", { threadId: ref, turnId: get(ref).turnId });
    },
    subscribe: (ref, on) => get(ref).ch.subscribe(on),
    getPendingPermissions: (ref) => get(ref).ch.pendingList(),
    async respondToPermission(ref, id, answer) {
      get(ref).ch.respond(id, answer);
    },
    async release(ref) {
      sessions.delete(ref);
      if (!sessions.size) proc?.stdin?.end();
    },
    close: () => void proc?.kill(),
    pid: () => proc?.pid,
  };
}
