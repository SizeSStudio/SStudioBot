// pi: `pi --mode rpc` 1.6.1, JSONL (05, 08 P7). One process per session; session_ref is the session file
// (get_state's sessionFile), resumed with `--session <file>`. pi has no permission requests: reported as
// `permissions: false`, nothing pretends to ask (§办3.2). No `--mcp-config`: the node's extension (pi-ext.ts, `-e`)
// registers the sbot MCP from SBOT_NODE_PI_MCP. `--no-approve`: project-local files of the repo are not loaded, the
// same reason Claude Code's workspace trust is not pre-recorded (P5–P8 ※).
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { Channel, Table, errText, type AgentAdapter, type OpenOpts } from "./types.ts";
import { killTree, readJsonl, spawnAgent, type Spawned } from "./rpc.ts";
import { looksLikeQuota, resetFromText } from "./quota.ts";

type S = { ch: Channel; sp: Spawned; call: (m: object) => Promise<any>; error?: string; running: boolean; released: boolean; item: number };

export interface PiOpts { bin: string; args?: string[]; sessionDir: string }

export const PI_EXTENSION = join(import.meta.dirname, "pi-ext.ts");

export function piAdapter(o: PiOpts): AgentAdapter {
  const t = new Table<S>();
  const a: AgentAdapter = {
    kind: "pi",
    caps: () => ({ steer: true, resume: true, rewind: false, permissions: false, ask: false }),
    async createSession(x) {
      const s = open(x, []);
      let ref: string;
      try { ref = String((await s.call({ type: "get_state" }))?.sessionFile ?? ""); }
      catch (e) { killTree(s.sp.proc); throw new Error(`pi 起不来：${errText(e)} ${s.sp.stderrTail().slice(-500)}`); }
      if (!ref) { killTree(s.sp.proc); throw new Error("pi 没给 session 文件"); }
      bind(ref, s);
      await prompt(s, x.prompt);
      return ref;
    },
    async resumeSession(ref, x) {
      const s = open(x, ["--session", ref]);
      let st: any;
      try { st = await s.call({ type: "get_state" }); }
      catch (e) { killTree(s.sp.proc); throw e; }
      if (st?.sessionFile !== ref || !st?.messageCount) { s.released = true; killTree(s.sp.proc); throw new Error("pi 没能重开这个 session 文件"); }
      bind(ref, s);
    },
    startTurn: (ref, text) => prompt(t.get(ref), text),
    async steer(ref, text) {
      const s = t.get(ref);
      if (!s.running) return false;
      await s.call({ type: "steer", message: text });
      return true;
    },
    async interrupt(ref) { await t.get(ref).call({ type: "abort" }); },
    subscribe: (ref, on) => t.get(ref).ch.subscribe(on),
    getPendingPermissions: () => [],
    async respondToPermission() { throw new Error("pi 没有权限请求"); },
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

  function open(x: OpenOpts, extra: string[]): S {
    // the node's own session dir: may not exist yet on a fresh state dir
    if (o.sessionDir) mkdirSync(o.sessionDir, { recursive: true, mode: 0o700 });
    const env = { ...x.env, SBOT_NODE_PI_MCP: JSON.stringify({ command: x.mcp.command, args: x.mcp.args, env: x.mcp.env }) };
    const sp = spawnAgent(o.bin, [...(o.args ?? []), "--mode", "rpc", "--session-dir", o.sessionDir, "--no-approve", "-e", PI_EXTENSION, ...extra], { cwd: x.cwd, env });
    const wait = new Map<string, { ok: (v: any) => void; fail: (e: Error) => void }>();
    let next = 0;
    const s: S = {
      ch: new Channel(), sp, running: false, released: false, item: 0,
      call: (m) => new Promise((ok, fail) => {
        if (sp.proc.exitCode !== null || !sp.proc.stdin?.writable) return fail(new Error("pi 已经退出了"));
        const id = `r${++next}`;
        wait.set(id, { ok, fail });
        sp.proc.stdin.write(JSON.stringify({ id, ...m }) + "\n");
      }),
    };
    void sp.exited.then(() => { for (const w of wait.values()) w.fail(new Error("pi 已经退出了")); wait.clear(); });
    readJsonl(sp.proc.stdout!, (m) => {
      if (m.type === "response") {
        const w = wait.get(m.id);
        wait.delete(m.id);
        if (m.success) w?.ok(m.data); else w?.fail(new Error(String(m.error ?? "pi 回了错误")));
        return;
      }
      event(s, m);
    });
    return s;
  }

  function bind(ref: string, s: S) {
    t.set(ref, s);
    void s.sp.exited.then((x) => {
      if (s.released) return;
      if (s.running) s.ch.emit({ k: "turn_end", stop: "interrupted", error: `pi 退出了（${x.signal ?? x.code}）` });
      s.running = false;
      t.delete(ref);
      a.onExit?.(ref, String(x.signal ?? x.code));
    });
  }

  async function prompt(s: S, text: string) {
    s.running = true;
    s.error = undefined;
    try { await s.call({ type: "prompt", message: text }); } catch (e) { s.running = false; throw e; }
  }

  function event(s: S, m: any) {
    if (m.type === "message_start") { s.item++; return; }
    if (m.type === "message_update" && m.assistantMessageEvent?.type === "text_delta") return s.ch.emit({ k: "text", item: `m${s.item}`, delta: String(m.assistantMessageEvent.delta ?? "") });
    if (m.type === "message_end" && m.message?.role === "assistant") {
      const text = (Array.isArray(m.message.content) ? m.message.content : []).filter((c: any) => c?.type === "text").map((c: any) => c.text).join("");
      if (text) s.ch.emit({ k: "message", item: `m${s.item}`, text });
      if (m.message.stopReason === "error") s.error = String(m.message.errorMessage ?? "pi 出错了");
      const u = m.message.usage;
      if (u) s.ch.emit({ k: "usage", ...(Number.isInteger(u.input) ? { input_tokens: u.input } : {}), ...(Number.isInteger(u.output) ? { output_tokens: u.output } : {}), ...(typeof m.message.model === "string" ? { model: m.message.model } : {}) });
      return;
    }
    if (m.type === "tool_execution_start") return s.ch.emit({ k: "tool_start", item: String(m.toolCallId), name: String(m.toolName ?? "tool"), args: m.args });
    if (m.type === "tool_execution_end") return s.ch.emit({ k: "tool_end", item: String(m.toolCallId), ok: !m.isError, result: m.result });
    if (m.type === "agent_settled") {
      if (s.error && looksLikeQuota("pi", s.error)) {
        const at = resetFromText(s.error);
        s.ch.emit({ k: "quota", ...(at ? { resets_at: at } : {}), text: s.error.slice(0, 500) });
      }
      s.running = false;
      s.ch.emit({ k: "turn_end", stop: m.aborted ? "interrupted" : s.error ? "error" : "done", ...(s.error && !m.aborted ? { error: s.error } : {}) });
      s.error = undefined;
    }
  }

  return a;
}
