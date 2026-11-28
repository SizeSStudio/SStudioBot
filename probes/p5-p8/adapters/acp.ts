// ACP，直接用 @agentclientprotocol/sdk。
import { client, ndJsonStream, PROTOCOL_VERSION, type ClientConnection } from "@agentclientprotocol/sdk";
import { spawn, type ChildProcess } from "node:child_process";
import { Readable, Writable } from "node:stream";
import { Channel, type AgentAdapter, type McpMount } from "../adapter.ts";
import { looksLikeQuota } from "../lib/quota.ts";

type Session = { ch: Channel; text: string; item: number; cancelled: boolean };

export function acpAdapter(opts: { command: string[]; env: Record<string, string>; resumeWith?: "resume" | "load" }) {
  const sessions = new Map<string, Session>();
  const seen: string[] = []; // 发过的会话类请求，探针拿来核实走了哪条路
  let proc: ChildProcess | undefined;
  let conn: ClientConnection | undefined;
  let caps: any;
  let ready: Promise<void> | undefined;
  const get = (ref: string) => {
    const s = sessions.get(ref);
    if (!s) throw new Error(`no session ${ref}`);
    return s;
  };

  function start() {
    return (ready ??= (async () => {
      const [bin, ...args] = opts.command;
      proc = spawn(bin, args, { env: opts.env, stdio: ["pipe", "pipe", "pipe"] });
      proc.stderr!.resume();
      const app = client({ name: "sbot-probe" })
        .onRequest("session/request_permission", async ({ params }) => {
          const s = get(params.sessionId);
          const raw = params.toolCall.rawInput as any;
          const a = await s.ch.request("permission", {
            title: params.toolCall.title ?? "tool",
            detail: raw?.command ?? JSON.stringify(raw ?? {}),
            options: params.options.map((o) => ({ id: o.optionId, label: o.kind })),
          });
          // 统一层只有 allow / deny 时按 kind 换成 agent 给的 optionId。
          const want = a.option_id === "allow" ? "allow_once" : a.option_id === "deny" ? "reject_once" : undefined;
          const picked = want ? params.options.find((o) => o.kind === want)?.optionId : a.option_id;
          return picked ? { outcome: { outcome: "selected", optionId: picked } } : { outcome: { outcome: "cancelled" } };
        })
        .onNotification("session/update", ({ params }) => {
          const s = sessions.get(params.sessionId);
          if (!s) return;
          const u = params.update as any;
          if (u.sessionUpdate === "agent_message_chunk" && u.content.type === "text") {
            s.text += u.content.text;
            s.ch.emit({ k: "text", item: String(s.item), delta: u.content.text });
          } else if (u.sessionUpdate === "tool_call") {
            flush(s);
            s.ch.emit({ k: "tool_start", item: u.toolCallId, name: u.title, args: u.rawInput });
          } else if (u.sessionUpdate === "tool_call_update") {
            const diff = u.content?.find((c: any) => c.type === "diff");
            // claude-agent-acp 的命令原文在后续 update 里才到。
            if (u.rawInput) s.ch.emit({ k: "tool_start", item: u.toolCallId, name: u.title ?? "tool", args: u.rawInput });
            if (u.status === "completed" || u.status === "failed")
              s.ch.emit({ k: "tool_end", item: u.toolCallId, ok: u.status === "completed", result: u.rawOutput, diff: diff && JSON.stringify(diff) });
          } else if (u.sessionUpdate === "usage_update") s.ch.emit({ k: "usage" });
        });
      conn = app.connect(ndJsonStream(Writable.toWeb(proc.stdin!), Readable.toWeb(proc.stdout!) as ReadableStream<Uint8Array>));
      const init = await conn.agent.request("initialize", { protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} });
      caps = init.agentCapabilities;
    })());
  }

  function flush(s: Session) {
    if (s.text) s.ch.emit({ k: "message", item: String(s.item), text: s.text });
    s.text = "";
    s.item++;
  }

  const servers = (mcp: McpMount) => [
    { name: "sbot", command: mcp.command, args: mcp.args, env: Object.entries(mcp.env).map(([name, value]) => ({ name, value })) },
  ];

  async function startTurn(ref: string, text: string) {
    const s = get(ref);
    void conn!.agent.request("session/prompt", { sessionId: ref, prompt: [{ type: "text", text }] }).then(
      (r) => {
        flush(s);
        s.ch.emit({ k: "turn_end", stop: r.stopReason === "cancelled" ? "interrupted" : r.stopReason === "end_turn" ? "done" : "error", error: r.stopReason === "end_turn" ? undefined : r.stopReason });
      },
      (e) => {
        flush(s);
        const error = JSON.stringify({ message: e.message, data: e.data });
        if (looksLikeQuota("acp", error)) s.ch.emit({ k: "quota" });
        s.ch.emit({ k: "turn_end", stop: "error", error });
      },
    );
  }

  const adapter: AgentAdapter = {
    caps: () => ({ steer: false, resume: true, rewind: false, permissions: true, ask: false }),
    async createSession({ cwd, prompt, mcp }) {
      await start();
      seen.push("session/new");
      const r = await conn!.agent.request("session/new", { cwd, mcpServers: servers(mcp) });
      // claude-agent-acp 没设 defaultMode 时新 session 起在 auto（分类器自动放行），权限请求不会发出；要显式切回 default。
      await conn!.agent.request("session/set_mode", { sessionId: r.sessionId, modeId: "default" });
      sessions.set(r.sessionId, { ch: new Channel(), text: "", item: 0, cancelled: false });
      await startTurn(r.sessionId, prompt);
      return r.sessionId;
    },
    async resumeSession(ref, { cwd, mcp }) {
      await start();
      const how = opts.resumeWith ?? (caps.sessionCapabilities?.resume ? "resume" : "load");
      const s = { ch: new Channel(), text: "", item: 0, cancelled: false };
      seen.push(`session/${how}`);
      // session/load 会把历史重放成 session/update；先不登记 session，重放的就不进事件流。
      await conn!.agent.request(`session/${how}`, { sessionId: ref, cwd, mcpServers: servers(mcp) });
      sessions.set(ref, s);
    },
    startTurn,
    async steer() {
      return false; // ACP 没有轮内插话，节点排到下一轮
    },
    async interrupt(ref) {
      await conn!.agent.notify("session/cancel", { sessionId: ref });
    },
    subscribe: (ref, on) => get(ref).ch.subscribe(on),
    getPendingPermissions: (ref) => get(ref).ch.pendingList(),
    async respondToPermission(ref, id, answer) {
      get(ref).ch.respond(id, answer);
    },
    async release(ref) {
      sessions.delete(ref);
      if (!sessions.size) {
        conn?.close();
        proc?.kill();
      }
    },
  };
  return Object.assign(adapter, { agentCapabilities: () => caps, seen });
}
