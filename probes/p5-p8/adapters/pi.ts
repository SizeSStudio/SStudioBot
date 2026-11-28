// pi：`pi --mode rpc`，JSONL。一个 session 一个进程；session_ref 是 session 文件路径。
import { spawn, type ChildProcess } from "node:child_process";
import { Channel, type AgentAdapter, type McpMount } from "../adapter.ts";
import { readJsonl } from "../lib/jsonl.ts";
import { looksLikeQuota } from "../lib/quota.ts";

type Session = { ch: Channel; proc: ChildProcess; call: (m: object) => Promise<any>; error?: string };

export function piAdapter(opts: { env: Record<string, string>; args: string[]; extension: string }): AgentAdapter {
  const sessions = new Map<string, Session>();
  const get = (ref: string) => {
    const s = sessions.get(ref);
    if (!s) throw new Error(`no session ${ref}`);
    return s;
  };

  async function open(cwd: string, mcp: McpMount, extra: string[]) {
    // pi 没有 --mcp-config；扩展里 registerMcpServer 按环境变量挂。
    const env = { ...opts.env, SBOT_MCP: JSON.stringify({ command: mcp.command, args: mcp.args, env: mcp.env }) };
    const proc = spawn("pi", ["--mode", "rpc", ...opts.args, "-e", opts.extension, ...extra], { cwd, env, stdio: ["pipe", "pipe", "pipe"] });
    proc.stderr!.resume();
    const waiting = new Map<string, { ok: (v: any) => void; fail: (e: Error) => void }>();
    let next = 0;
    const ch = new Channel();
    const s: Session = {
      ch,
      proc,
      call: (m) =>
        new Promise((ok, fail) => {
          const id = `r${++next}`;
          waiting.set(id, { ok, fail });
          proc.stdin!.write(JSON.stringify({ id, ...m }) + "\n");
        }),
    };
    proc.on("exit", () => {
      for (const w of waiting.values()) w.fail(new Error("pi exited"));
    });
    let item = 0;
    readJsonl(proc.stdout!, (m) => {
      if (m.type === "response") {
        const w = waiting.get(m.id);
        waiting.delete(m.id);
        if (m.success) w?.ok(m.data);
        else w?.fail(new Error(m.error));
      } else if (m.type === "message_start") item++;
      else if (m.type === "message_update" && m.assistantMessageEvent?.type === "text_delta")
        ch.emit({ k: "text", item: String(item), delta: m.assistantMessageEvent.delta });
      else if (m.type === "message_end" && m.message.role === "assistant") {
        const text = m.message.content.filter((c: any) => c.type === "text").map((c: any) => c.text).join("");
        if (text) ch.emit({ k: "message", item: String(item), text });
        s.error = m.message.stopReason === "error" ? m.message.errorMessage : undefined;
        const u = m.message.usage;
        if (u) ch.emit({ k: "usage", input_tokens: u.input, output_tokens: u.output });
      } else if (m.type === "tool_execution_start") ch.emit({ k: "tool_start", item: m.toolCallId, name: m.toolName, args: m.args });
      else if (m.type === "tool_execution_end") ch.emit({ k: "tool_end", item: m.toolCallId, ok: !m.isError, result: m.result });
      else if (m.type === "agent_settled") {
        if (s.error && looksLikeQuota("pi", s.error)) ch.emit({ k: "quota" });
        ch.emit({ k: "turn_end", stop: m.aborted ? "interrupted" : s.error ? "error" : "done", error: s.error });
      }
    });
    return s;
  }

  return {
    caps: () => ({ steer: true, resume: true, rewind: false, permissions: false, ask: false }),
    async createSession({ cwd, prompt, mcp }) {
      const s = await open(cwd, mcp, []);
      const state = await s.call({ type: "get_state" });
      const ref = state.sessionFile as string;
      sessions.set(ref, s);
      await s.call({ type: "prompt", message: prompt });
      return ref;
    },
    async resumeSession(ref, { cwd, mcp }) {
      const s = await open(cwd, mcp, ["--session", ref]);
      const state = await s.call({ type: "get_state" });
      if (state.sessionFile !== ref || !state.messageCount) throw new Error("pi did not reopen the session file");
      sessions.set(ref, s);
    },
    async startTurn(ref, text) {
      await get(ref).call({ type: "prompt", message: text });
    },
    async steer(ref, text) {
      await get(ref).call({ type: "steer", message: text });
      return true;
    },
    async interrupt(ref) {
      await get(ref).call({ type: "abort" });
    },
    subscribe: (ref, on) => get(ref).ch.subscribe(on),
    getPendingPermissions: () => [],
    async respondToPermission() {
      throw new Error("pi has no permission requests");
    },
    async release(ref) {
      const s = sessions.get(ref);
      sessions.delete(ref);
      s?.proc.stdin?.end();
    },
  };
}
