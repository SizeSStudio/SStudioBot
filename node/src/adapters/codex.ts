// Codex: `codex app-server` 0.172.0, JSON-RPC over stdio without the `jsonrpc` field (05, 08 P6). One app-server per
// session, so a release or a crash touches only that session. Mode: approvalPolicy `untrusted` (asks for anything not
// on its own trusted list) and the `workspace-write` sandbox — the narrowest that still lets it work; never `never`.
// The sbot MCP goes in thread/start's and thread/resume's `config`; ~/.codex/config.toml is left alone.
import { Channel, ONCE, Table, errText, isReject, toMs, type AgentAdapter, type Answer, type OpenOpts } from "./types.ts";
import { JsonRpc, killTree, spawnAgent, type Spawned } from "./rpc.ts";
import { looksLikeQuota, resetFromText } from "./quota.ts";

type S = { ch: Channel; rpc: JsonRpc; sp: Spawned; turnId?: string; running: boolean; changes: Map<string, unknown>; resetsAt?: number; released: boolean; interrupting: boolean; end(): void };

export interface CodexOpts { bin: string; args?: string[]; model?: string }

const QUOTA_INFO = /^(usageLimitExceeded|rateLimitExceeded|\w*SpendLimitExceeded|sessionBudgetExceeded)$/;

export function codexAdapter(o: CodexOpts): AgentAdapter {
  const t = new Table<S>();
  const a: AgentAdapter = {
    kind: "codex",
    caps: () => ({ steer: true, resume: true, rewind: false, permissions: true, ask: false }),
    async createSession(x) {
      const s = await start(x);
      let r: any;
      try { r = await s.rpc.call("thread/start", params(x)); }
      catch (e) { killTree(s.sp.proc); throw e; }
      const ref = String(r?.thread?.id ?? "");
      if (!ref) { killTree(s.sp.proc); throw new Error("codex 没给 thread id"); }
      bind(ref, s);
      await turn(ref, x.prompt);
      return ref;
    },
    async resumeSession(ref, x) {
      const s = await start(x);
      bind(ref, s);
      try { await s.rpc.call("thread/resume", { threadId: ref, ...params(x) }); }
      catch (e) { t.delete(ref); s.released = true; killTree(s.sp.proc); throw e; }
    },
    startTurn: (ref, text) => turn(ref, text),
    async steer(ref, text) {
      const s = t.get(ref);
      if (!s.turnId || !s.running) return false;
      await s.rpc.call("turn/steer", { threadId: ref, expectedTurnId: s.turnId, input: [{ type: "text", text, text_elements: [] }] });
      return true;
    },
    async interrupt(ref) {
      const s = t.get(ref);
      if (!s.turnId) return;
      s.interrupting = true;
      await s.rpc.call("turn/interrupt", { threadId: ref, turnId: s.turnId });
    },
    subscribe: (ref, on) => t.get(ref).ch.subscribe(on),
    getPendingPermissions: (ref) => t.get(ref).ch.pending(),
    async respondToPermission(ref, id, ans) { if (!t.get(ref).ch.respond(id, ans)) throw new Error("没有这条请求"); },
    async release(ref) {
      const s = t.find(ref);
      if (!s) return;
      s.released = true;
      t.delete(ref);
      s.end();
    },
    pid: (ref) => t.find(ref)?.sp.proc.pid,
  };

  async function start(x: OpenOpts): Promise<S> {
    const sp = spawnAgent(o.bin, [...(o.args ?? []), "app-server"], { cwd: x.cwd, env: x.env });
    const rpc = new JsonRpc(sp.proc, false);
    // closing stdin ends app-server; the group kill is for whatever it left running
    const s: S = { ch: new Channel(), rpc, sp, running: false, changes: new Map(), released: false, interrupting: false, end: () => { sp.proc.stdin?.end(); setTimeout(() => killTree(sp.proc), 3000).unref(); } };
    try { await rpc.call("initialize", { clientInfo: { name: "sbot_node", title: "sbot node", version: "1" } }); }
    catch (e) { killTree(sp.proc); throw new Error(`codex app-server 起不来：${errText(e)} ${sp.stderrTail().slice(-500)}`); }
    rpc.notify("initialized", {});
    return s;
  }

  function bind(ref: string, s: S) {
    t.set(ref, s);
    s.rpc.onRequest = (m, p) => request(s, m, p);
    s.rpc.onNotify = (m, p) => notify(s, m, p);
    void s.sp.exited.then((x) => {
      s.ch.dropPending();
      if (s.released) return;
      if (s.running) s.ch.emit({ k: "turn_end", stop: "interrupted", error: `codex 退出了（${x.signal ?? x.code}）` });
      s.running = false;
      t.delete(ref);
      a.onExit?.(ref, String(x.signal ?? x.code));
    });
  }

  const params = (x: OpenOpts) => ({
    cwd: x.cwd,
    ...(o.model ? { model: o.model } : {}),
    approvalPolicy: "untrusted",
    sandbox: "workspace-write",
    config: { "mcp_servers.sbot.command": x.mcp.command, "mcp_servers.sbot.args": x.mcp.args, "mcp_servers.sbot.env": x.mcp.env },
  });

  async function turn(ref: string, text: string) {
    const s = t.get(ref);
    s.running = true;
    try {
      const r = await s.rpc.call("turn/start", { threadId: ref, input: [{ type: "text", text, text_elements: [] }] });
      if (r?.turn?.id) s.turnId = r.turn.id;
    } catch (e) { s.running = false; throw e; }
  }

  async function ask(s: S, title: string, detail: unknown, onAllow: object, onReject: object) {
    const ans = await s.ch.request("permission", { title, detail, options: ONCE });
    return isReject(ans, ONCE) ? onReject : onAllow;
  }

  async function request(s: S, m: string, p: any): Promise<unknown> {
    if (m === "item/commandExecution/requestApproval") {
      return ask(s, `要跑命令：${String(p?.command ?? "").slice(0, 300)}`, { tool: "command", command: p?.command, cwd: p?.cwd, reason: p?.reason }, { decision: "accept" }, { decision: "decline" });
    }
    if (m === "item/fileChange/requestApproval") {
      return ask(s, "要改文件", { tool: "fileChange", changes: s.changes.get(p?.itemId) ?? null, reason: p?.reason }, { decision: "accept" }, { decision: "decline" });
    }
    if (m === "mcpServer/elicitation/request") {
      // our own MCP: the hub's gate decides, the node says yes (08 P6); anyone else's goes to me like any request
      if (p?.serverName === "sbot") return { action: "accept", content: {}, _meta: null };
      return ask(s, `MCP「${String(p?.serverName ?? "")}」要确认`, { tool: "mcp", server: p?.serverName, message: p?.message }, { action: "accept", content: {}, _meta: null }, { action: "decline", content: null, _meta: null });
    }
    if (m === "item/tool/requestUserInput") {
      const qs: any[] = Array.isArray(p?.questions) ? p.questions : [];
      const ans: Answer = await s.ch.request("ask", { title: String(qs[0]?.question ?? "它在问你"), detail: { tool: "requestUserInput", questions: qs }, options: [] });
      return { answers: Object.fromEntries(qs.map((q) => [q.id, { answers: [ans.answers?.[q.question] ?? ans.text ?? ans.option_id ?? ""] }])) };
    }
    throw Object.assign(new Error(`unsupported ${m}`), { code: -32601 });
  }

  function notify(s: S, m: string, p: any) {
    if (m === "turn/started") { s.turnId = p?.turn?.id ?? s.turnId; s.running = true; return; }
    if (m === "item/agentMessage/delta") return s.ch.emit({ k: "text", item: String(p.itemId), delta: String(p.delta ?? "") });
    if (m === "item/started") {
      const it = p?.item ?? {};
      if (it.type === "commandExecution") s.ch.emit({ k: "tool_start", item: String(it.id), name: "command", args: { command: it.command, cwd: it.cwd } });
      else if (it.type === "fileChange") { s.changes.set(it.id, it.changes); s.ch.emit({ k: "tool_start", item: String(it.id), name: "fileChange", args: { changes: it.changes } }); }
      else if (it.type === "mcpToolCall") s.ch.emit({ k: "tool_start", item: String(it.id), name: `${it.server}.${it.tool}`, args: it.arguments });
      return;
    }
    if (m === "item/completed") {
      const it = p?.item ?? {};
      if (it.type === "agentMessage") s.ch.emit({ k: "message", item: String(it.id), text: String(it.text ?? "") });
      else if (it.type === "commandExecution") s.ch.emit({ k: "tool_end", item: String(it.id), ok: it.status === "completed", result: it.aggregatedOutput });
      else if (it.type === "fileChange") s.ch.emit({ k: "tool_end", item: String(it.id), ok: it.status === "completed" });
      else if (it.type === "mcpToolCall") s.ch.emit({ k: "tool_end", item: String(it.id), ok: it.status === "completed", result: it.result ?? it.error });
      return;
    }
    if (m === "turn/diff/updated") return s.ch.emit({ k: "diff", item: `turn:${String(p?.turnId ?? "")}`, text: String(p?.diff ?? "") });
    if (m === "thread/tokenUsage/updated") {
      const u = p?.tokenUsage?.last;
      if (u) s.ch.emit({ k: "usage", ...(Number.isInteger(u.inputTokens) ? { input_tokens: u.inputTokens } : {}), ...(Number.isInteger(u.outputTokens) ? { output_tokens: u.outputTokens } : {}) });
      return;
    }
    if (m === "account/rateLimits/updated") {
      // the soonest window that is full; the unit of resetsAt is not verified (08), toMs takes seconds or ms
      const rl = p?.rateLimits ?? p;
      const ws = [rl?.primary, rl?.secondary].filter((w) => w && Number(w.usedPercent) >= 100);
      const at = ws.map((w) => toMs(w.resetsAt)).filter((x): x is number => !!x).sort((x, y) => x - y)[0];
      if (at) s.resetsAt = at;
      return;
    }
    if (m === "turn/completed") {
      const tu = p?.turn ?? {};
      const error: string | undefined = tu.error?.message;
      const info = String(tu.error?.codexErrorInfo ?? "");
      if (QUOTA_INFO.test(info) || (error && looksLikeQuota("codex", error))) {
        const at = s.resetsAt ?? (error ? resetFromText(error) : undefined);
        s.ch.emit({ k: "quota", ...(at ? { resets_at: at } : {}), remaining: info || undefined, ...(error ? { text: error.slice(0, 500) } : {}) });
      }
      s.running = false;
      s.turnId = undefined;
      const stop = tu.status === "completed" ? "done" : tu.status === "interrupted" ? "interrupted" : "error";
      s.interrupting = false;
      s.ch.emit({ k: "turn_end", stop, ...(stop === "error" ? { error: error ?? "codex 这一轮失败了" } : {}) });
    }
  }

  return a;
}
