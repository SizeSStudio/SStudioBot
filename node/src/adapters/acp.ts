// Any other agent over ACP (05, 08 P8): JSON-RPC 2.0 over the agent's stdio, written against the wire the probe ran
// 3/3 with both acpx and @agentclientprotocol/sdk ※ (no library: the client side is a handful of methods). One agent
// process per session. Rules from the probe:
//   - a new session may start in `auto` (claude-agent-acp: no permission requests, all allowed) → session/set_mode to
//     `default` right after session/new (and after a resume); an agent that offers `default` but refuses it is not run
//   - resume: session/resume when the agent says sessionCapabilities.resume, else session/load (its history replay is
//     swallowed: the session is bound only after the load returns), else the caller opens a fresh one
//   - no in-turn steering: steer() is false, the hub sends it as the next turn and the UI says so
//   - a request for our own sbot tool (title `sbot:` / `mcp__sbot__`) is answered by the node; the gate is on the hub
//   - no fs/terminal client capabilities: the agent uses its own tools, which ask through session/request_permission
import { Channel, Table, errText, isReject, toMs, type AgentAdapter, type Answer, type OpenOpts, type PermissionOption } from "./types.ts";
import { JsonRpc, killTree, spawnAgent, type Spawned } from "./rpc.ts";
import { looksLikeQuota } from "./quota.ts";

type S = { ch: Channel; rpc: JsonRpc; sp: Spawned; caps: any; running: boolean; released: boolean; text: string; item: number; resetsAt?: number; bound: boolean };

export interface AcpOpts { name: string; cmd: string[] }

const servers = (x: OpenOpts) => [{ name: "sbot", command: x.mcp.command, args: x.mcp.args, env: Object.entries(x.mcp.env).map(([name, value]) => ({ name, value })) }];
const OWN = /^sbot:|mcp__sbot__/;

export function acpAdapter(o: AcpOpts): AgentAdapter {
  const t = new Table<S>();
  const kind = `acp:${o.name}`;
  const a: AgentAdapter = {
    kind,
    caps: () => ({ steer: false, resume: true, rewind: false, permissions: true, ask: false }),
    async createSession(x) {
      const s = await start(x);
      try {
        const r = await s.rpc.call("session/new", { cwd: x.cwd, mcpServers: servers(x) });
        const ref = String(r?.sessionId ?? "");
        if (!ref) throw new Error("ACP agent 没给 sessionId");
        await toDefault(s, ref, r?.modes);
        bind(ref, s);
        await prompt(ref, x.prompt);
        return ref;
      } catch (e) { s.released = true; killTree(s.sp.proc); throw e; }
    },
    async resumeSession(ref, x) {
      const s = await start(x);
      const sc = s.caps?.sessionCapabilities ?? {};
      const how = sc.resume ? "session/resume" : s.caps?.loadSession ? "session/load" : "";
      try {
        if (!how) throw new Error("这个 ACP agent 不能续接 session");
        const r = await s.rpc.call(how, { sessionId: ref, cwd: x.cwd, mcpServers: servers(x) });
        await toDefault(s, ref, r?.modes);
      } catch (e) { s.released = true; killTree(s.sp.proc); throw e; }
      bind(ref, s);
    },
    startTurn: (ref, text) => prompt(ref, text),
    async steer() { return false; },
    async interrupt(ref) { t.get(ref).rpc.notify("session/cancel", { sessionId: ref }); },
    subscribe: (ref, on) => t.get(ref).ch.subscribe(on),
    getPendingPermissions: (ref) => t.get(ref).ch.pending(),
    async respondToPermission(ref, id, ans) { if (!t.get(ref).ch.respond(id, ans)) throw new Error("没有这条请求"); },
    async release(ref) {
      const s = t.find(ref);
      if (!s) return;
      s.released = true;
      t.delete(ref);
      s.sp.proc.stdin?.end();
      setTimeout(() => killTree(s.sp.proc), 3000).unref();
    },
    pid: (ref) => t.find(ref)?.sp.proc.pid,
  };

  async function start(x: OpenOpts): Promise<S> {
    const [bin, ...args] = o.cmd;
    if (!bin) throw new Error(`ACP agent ${o.name} 没配命令`);
    const sp = spawnAgent(bin, args, { cwd: x.cwd, env: x.env });
    const rpc = new JsonRpc(sp.proc, true);
    const s: S = { ch: new Channel(), rpc, sp, caps: {}, running: false, released: false, text: "", item: 0, bound: false };
    rpc.onRequest = (m, p) => request(s, m, p);
    rpc.onNotify = (m, p) => { if (m === "session/update" && s.bound) update(s, p?.update ?? {}); };
    try {
      const init = await rpc.call("initialize", { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false } });
      s.caps = init?.agentCapabilities ?? {};
    } catch (e) { killTree(sp.proc); throw new Error(`ACP agent ${o.name} 起不来：${errText(e)} ${sp.stderrTail().slice(-500)}`); }
    return s;
  }

  /** 08 P8: claude-agent-acp starts new sessions in `auto`. Only `default` keeps every request coming to me. */
  async function toDefault(s: S, ref: string, modes: any) {
    const avail: any[] = Array.isArray(modes?.availableModes) ? modes.availableModes : [];
    if (!avail.some((m) => m?.id === "default")) return;   // no modes, or none named default: nothing to switch
    if (modes?.currentModeId === "default") return;
    await s.rpc.call("session/set_mode", { sessionId: ref, modeId: "default" });
  }

  function bind(ref: string, s: S) {
    s.bound = true;
    t.set(ref, s);
    void s.sp.exited.then((x) => {
      s.ch.dropPending();
      if (s.released) return;
      if (s.running) s.ch.emit({ k: "turn_end", stop: "interrupted", error: `ACP agent 退出了（${x.signal ?? x.code}）` });
      s.running = false;
      t.delete(ref);
      a.onExit?.(ref, String(x.signal ?? x.code));
    });
  }

  function flush(s: S) {
    if (s.text) s.ch.emit({ k: "message", item: `m${s.item}`, text: s.text });
    s.text = "";
    s.item++;
  }

  async function prompt(ref: string, text: string) {
    const s = t.get(ref);
    s.running = true;
    // the reply comes when the turn is over; the events stream meanwhile
    s.rpc.call("session/prompt", { sessionId: ref, prompt: [{ type: "text", text }] }).then(
      (r) => {
        flush(s);
        s.running = false;
        const why = String(r?.stopReason ?? "end_turn");
        s.ch.emit({ k: "turn_end", stop: why === "cancelled" ? "interrupted" : why === "end_turn" ? "done" : "error", ...(why !== "end_turn" && why !== "cancelled" ? { error: why } : {}) });
      },
      (e) => {
        flush(s);
        s.running = false;
        if (s.released || !t.find(ref)) return;          // the process ended: bind()'s exit handler reports it
        const data = (e as { data?: any }).data;
        const raw = JSON.stringify({ message: errText(e), data: data ?? null });
        if (data?.errorKind === "rate_limit" || looksLikeQuota("acp", raw)) {
          const at = toMs(data?.rateLimit?.resetsAt) ?? s.resetsAt;
          s.ch.emit({ k: "quota", ...(at ? { resets_at: at } : {}), ...(data?.rateLimit ? { remaining: data.rateLimit } : {}), text: errText(e).slice(0, 500) });
        }
        s.ch.emit({ k: "turn_end", stop: "error", error: errText(e) });
      },
    );
  }

  async function request(s: S, m: string, p: any): Promise<unknown> {
    if (m !== "session/request_permission") throw Object.assign(new Error(`unsupported ${m}`), { code: -32601 });
    const tc = p?.toolCall ?? {};
    const all: any[] = Array.isArray(p?.options) ? p.options : [];
    const pick = (k: RegExp) => all.find((x) => k.test(String(x?.kind ?? "")))?.optionId as string | undefined;
    const title = String(tc.title ?? "tool");
    if (OWN.test(title) || OWN.test(String(tc._meta?.toolName ?? ""))) {
      const id = pick(/^allow_once$/) ?? pick(/^allow/);
      return id ? { outcome: { outcome: "selected", optionId: id } } : { outcome: { outcome: "cancelled" } };
    }
    // "always" options would make the agent remember a wider rule; they are not offered ※
    const options: PermissionOption[] = all.filter((x) => x && x.kind !== "allow_always").map((x) => ({ id: String(x.optionId), label: String(x.name ?? x.kind ?? x.optionId), kind: String(x.kind ?? "") }));
    const ans: Answer = await s.ch.request("permission", { title, detail: { tool: tc.kind ?? title, args: tc.rawInput ?? null, locations: tc.locations ?? null, tool_call_id: tc.toolCallId ?? null }, options });
    if (isReject(ans, options)) {
      const id = (ans.option_id && options.find((x) => x.id === ans.option_id && /^reject/.test(x.kind ?? ""))?.id) ?? pick(/^reject_once$/) ?? pick(/^reject/);
      return id ? { outcome: { outcome: "selected", optionId: id } } : { outcome: { outcome: "cancelled" } };
    }
    return { outcome: { outcome: "selected", optionId: ans.option_id } };
  }

  function update(s: S, u: any) {
    const rl = u?._meta?.["_claude/rateLimit"];
    if (rl?.status === "rejected") s.resetsAt = toMs(rl.resetsAt) ?? s.resetsAt;
    switch (u.sessionUpdate) {
      case "agent_message_chunk":
        if (u.content?.type === "text") { s.text += u.content.text; s.ch.emit({ k: "text", item: `m${s.item}`, delta: String(u.content.text) }); }
        return;
      case "tool_call":
        flush(s);
        s.ch.emit({ k: "tool_start", item: String(u.toolCallId), name: String(u.title ?? u.kind ?? "tool"), args: u.rawInput ?? null });
        return;
      case "tool_call_update": {
        const diffs = (Array.isArray(u.content) ? u.content : []).filter((c: any) => c?.type === "diff");
        // claude-agent-acp sends the command itself only in a later update
        if (u.rawInput && u.status !== "completed" && u.status !== "failed") s.ch.emit({ k: "tool_start", item: String(u.toolCallId), name: String(u.title ?? "tool"), args: u.rawInput });
        if (u.status === "completed" || u.status === "failed") {
          s.ch.emit({ k: "tool_end", item: String(u.toolCallId), ok: u.status === "completed", result: u.rawOutput ?? null, ...(diffs.length ? { diff: diffs.map(diffText).join("\n") } : {}) });
        }
        return;
      }
    }
  }

  return a;
}

/** ACP's diff content {path, oldText, newText} as a small unified-looking text (the card shows it as text). */
function diffText(d: { path?: string; oldText?: string | null; newText?: string }): string {
  const old = (d.oldText ?? "").split("\n").map((l) => `-${l}`).join("\n");
  const nu = (d.newText ?? "").split("\n").map((l) => `+${l}`).join("\n");
  return `--- ${d.path ?? ""}\n+++ ${d.path ?? ""}\n${d.oldText ? `${old}\n` : ""}${nu}`;
}
