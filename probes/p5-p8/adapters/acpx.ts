// ACP，走 acpx 的库入口（acpx/runtime）。
import { createAcpRuntime, createAgentRegistry, createFileSessionStore, type AcpRuntimeHandle } from "acpx/runtime";
import { randomUUID } from "node:crypto";
import { ALLOW_DENY, Channel, type AgentAdapter, type McpMount } from "../adapter.ts";

type Session = { ch: Channel; handle: AcpRuntimeHandle; runtime: ReturnType<typeof createAcpRuntime> };

export function acpxAdapter(opts: { command: string[]; env: Record<string, string>; stateDir: string }) {
  const sessions = new Map<string, Session>();
  const seen: string[] = [];
  const pids: number[] = [];
  const get = (ref: string) => {
    const s = sessions.get(ref);
    if (!s) throw new Error(`no session ${ref}`);
    return s;
  };

  async function open(cwd: string, mcp: McpMount, resume?: string) {
    const ch = new Channel();
    const runtime = createAcpRuntime({
      cwd,
      sessionStore: createFileSessionStore({ stateDir: opts.stateDir }),
      agentRegistry: createAgentRegistry({ overrides: { probe: opts.command } }),
      agentProcessEnv: opts.env,
      // 环境整个由 agentProcessEnv 给；外层会话的变量挡掉。
      agentProcessEnvBlock: Object.keys(process.env).filter((k) => !(k in opts.env)),
      mcpServers: [{ name: "sbot", command: mcp.command, args: mcp.args, env: Object.entries(mcp.env).map(([name, value]) => ({ name, value })) }],
      permissionMode: "deny-all",
      fs: false,
      terminal: false,
      onAcpMessage: (dir, m: any) => {
        if (dir === "outbound" && /^session\/(new|load|resume)$/.test(m.method ?? "")) seen.push(m.method);
      },
      processLifecycle: { onSpawned: (p) => void pids.push(p.pid) },
      onPermissionRequest: async ({ raw }) => {
        const input = raw.toolCall.rawInput as any;
        const a = await ch.request("permission", { title: raw.toolCall.title ?? "tool", detail: input?.command ?? JSON.stringify(input ?? {}), options: ALLOW_DENY });
        return { outcome: a.option_id === "allow" ? "allow_once" : "reject_once" };
      },
    });
    // 节点重启后换一个 sessionKey 也能按 resumeSessionId 接回原 session。
    const handle = await runtime.ensureSession({ sessionKey: resume ?? randomUUID(), agent: "probe", mode: "persistent", cwd, resumeSessionId: resume });
    return { ch, handle, runtime };
  }

  async function startTurn(ref: string, text: string) {
    const s = get(ref);
    const turn = s.runtime.startTurn({ handle: s.handle, text, mode: "prompt", requestId: randomUUID() });
    void (async () => {
      let buf = "";
      let item = 0;
      const flush = () => {
        if (buf) s.ch.emit({ k: "message", item: String(item++), text: buf });
        buf = "";
      };
      for await (const e of turn.events as AsyncIterable<any>) {
        if (e.type === "text_delta" && e.stream !== "thought") {
          buf += e.text;
          s.ch.emit({ k: "text", item: String(item), delta: e.text });
        } else if (e.type === "tool_call") {
          flush();
          if (e.status === "completed" || e.status === "failed") s.ch.emit({ k: "tool_end", item: e.toolCallId, ok: e.status === "completed", result: e.rawOutput });
          else s.ch.emit({ k: "tool_start", item: e.toolCallId, name: e.title ?? "tool", args: e.rawInput });
        }
      }
      const r = await turn.result;
      flush();
      s.ch.emit({ k: "turn_end", stop: r.status === "completed" ? "done" : r.status === "cancelled" ? "interrupted" : "error", error: r.status === "failed" ? r.error.message : undefined });
    })().catch((e) => s.ch.emit({ k: "turn_end", stop: "error", error: String(e) }));
  }

  const adapter: AgentAdapter = {
    caps: () => ({ steer: false, resume: true, rewind: false, permissions: true, ask: false }),
    async createSession({ cwd, prompt, mcp }) {
      const s = await open(cwd, mcp);
      const ref = s.handle.backendSessionId;
      if (!ref) throw new Error("acpx gave no backendSessionId");
      // 同 acp.ts：新 session 默认起在 auto，先切回 default 才有权限请求。
      await s.runtime.setMode?.({ handle: s.handle, mode: "default" });
      sessions.set(ref, s);
      await startTurn(ref, prompt);
      return ref;
    },
    async resumeSession(ref, { cwd, mcp }) {
      sessions.set(ref, await open(cwd, mcp, ref));
    },
    startTurn,
    async steer() {
      return false;
    },
    async interrupt(ref) {
      const s = get(ref);
      await s.runtime.cancel({ handle: s.handle });
    },
    subscribe: (ref, on) => get(ref).ch.subscribe(on),
    getPendingPermissions: (ref) => get(ref).ch.pendingList(),
    async respondToPermission(ref, id, answer) {
      get(ref).ch.respond(id, answer);
    },
    async release(ref) {
      const s = sessions.get(ref);
      sessions.delete(ref);
      await s?.runtime.shutdown?.();
    },
  };
  return Object.assign(adapter, { seen, pids });
}
