// Claude Code：agent SDK 的 query()，流式输入。
import { createSdkMcpServer, query, tool, type Query, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { ALLOW_DENY, Channel, type AgentAdapter, type Answer, type McpMount } from "../adapter.ts";
import { looksLikeQuota } from "../lib/quota.ts";

class Input {
  private queue: SDKUserMessage[] = [];
  private wake?: () => void;
  private done = false;
  push(text: string, priority?: "now" | "next" | "later") {
    this.queue.push({ type: "user", message: { role: "user", content: text }, parent_tool_use_id: null, priority });
    this.wake?.();
  }
  end() {
    this.done = true;
    this.wake?.();
  }
  async *[Symbol.asyncIterator]() {
    while (true) {
      while (this.queue.length) yield this.queue.shift()!;
      if (this.done) return;
      await new Promise<void>((ok) => (this.wake = ok));
    }
  }
}

type Session = { ch: Channel; input: Input; q: Query; abort: AbortController; interrupted: boolean };

export function claudeAdapter(opts: { model: string; effort?: "low" | "medium" | "high"; env: Record<string, string> }): AgentAdapter {
  const sessions = new Map<string, Session>();
  const get = (ref: string) => {
    const s = sessions.get(ref);
    if (!s) throw new Error(`no session ${ref}`);
    return s;
  };

  function open(o: { cwd: string; mcp: McpMount; resume?: string; sessionId?: string }): Session {
    const ch = new Channel();
    const input = new Input();
    const abort = new AbortController();
    const sbot = createSdkMcpServer({
      name: "sbot",
      tools: [
        tool("sbot_ping", "Returns a token from the sbot hub.", { note: z.string() }, async (args) => ({
          content: [{ type: "text", text: await o.mcp.call("sbot_ping", args) }],
        })),
      ],
    });
    const q = query({
      prompt: input,
      options: {
        cwd: o.cwd,
        model: opts.model,
        effort: opts.effort,
        env: opts.env,
        resume: o.resume,
        sessionId: o.sessionId,
        abortController: abort,
        includePartialMessages: true,
        systemPrompt: { type: "preset", preset: "claude_code" },
        settingSources: ["user", "project", "local"],
        mcpServers: { sbot },
        // 我们自己的工具在主上过闸门，节点这层直接放行。
        allowedTools: ["mcp__sbot__sbot_ping"],
        canUseTool: async (name, args) => {
          if (name === "AskUserQuestion") {
            const questions = (args as any).questions as { question: string; options: { label: string }[] }[];
            const a = await ch.request("ask", {
              title: questions[0]?.question ?? name,
              detail: JSON.stringify(args),
              options: (questions[0]?.options ?? []).map((x) => ({ id: x.label, label: x.label })),
              questions,
            });
            const answers = Object.fromEntries(questions.map((x) => [x.question, a.text ?? a.option_id]));
            return { behavior: "allow", updatedInput: { ...args, answers } };
          }
          const detail = typeof (args as any).command === "string" ? (args as any).command : JSON.stringify(args);
          const a = await ch.request("permission", { title: name, detail, options: ALLOW_DENY });
          return a.option_id === "allow"
            ? { behavior: "allow", updatedInput: args }
            : { behavior: "deny", message: a.text ?? "Denied by the user." };
        },
      },
    });
    const s: Session = { ch, input, q, abort, interrupted: false };
    void pump(s);
    return s;
  }

  async function pump(s: Session) {
    let item = "";
    try {
      for await (const m of s.q as AsyncIterable<any>) {
        if (m.type === "stream_event") {
          const e = m.event;
          if (e.type === "message_start") item = e.message.id;
          if (e.type === "content_block_delta" && e.delta.type === "text_delta") s.ch.emit({ k: "text", item, delta: e.delta.text });
        } else if (m.type === "assistant") {
          if (m.error === "rate_limit") s.ch.emit({ k: "quota" });
          for (const b of m.message.content) {
            if (b.type === "text") s.ch.emit({ k: "message", item: m.message.id, text: b.text });
            if (b.type === "tool_use") s.ch.emit({ k: "tool_start", item: b.id, name: b.name, args: b.input });
          }
        } else if (m.type === "user" && Array.isArray(m.message.content)) {
          for (const b of m.message.content)
            if (b.type === "tool_result") s.ch.emit({ k: "tool_end", item: b.tool_use_id, ok: !b.is_error, result: b.content });
        } else if (m.type === "rate_limit_event" && m.rate_limit_info.status === "rejected") {
          s.ch.emit({ k: "quota", resets_at: m.rate_limit_info.resetsAt, remaining: m.rate_limit_info });
        } else if (m.type === "result") {
          s.ch.emit({ k: "usage", input_tokens: m.usage?.input_tokens, output_tokens: m.usage?.output_tokens, ms: m.duration_ms });
          const error = m.is_error ? String(m.result ?? m.errors?.join("; ") ?? m.subtype) : undefined;
          if (error && looksLikeQuota("claude", error)) s.ch.emit({ k: "quota" });
          s.ch.emit({ k: "turn_end", stop: s.interrupted ? "interrupted" : error ? "error" : "done", error });
          s.interrupted = false;
        }
      }
    } catch (e) {
      if (!s.abort.signal.aborted) s.ch.emit({ k: "turn_end", stop: "error", error: String(e) });
    }
  }

  return {
    caps: () => ({ steer: true, resume: true, rewind: false, permissions: true, ask: true }),
    async createSession({ cwd, prompt, mcp }) {
      const ref = randomUUID();
      const s = open({ cwd, mcp, sessionId: ref });
      sessions.set(ref, s);
      s.input.push(prompt);
      return ref;
    },
    async resumeSession(ref, { cwd, mcp }) {
      sessions.set(ref, open({ cwd, mcp, resume: ref }));
    },
    async startTurn(ref, text) {
      get(ref).input.push(text);
    },
    async steer(ref, text) {
      get(ref).input.push(text, "next");
      return true;
    },
    async interrupt(ref) {
      const s = get(ref);
      s.interrupted = true;
      await s.q.interrupt();
    },
    subscribe: (ref, on) => get(ref).ch.subscribe(on),
    getPendingPermissions: (ref) => get(ref).ch.pendingList(),
    async respondToPermission(ref, id, answer: Answer) {
      get(ref).ch.respond(id, answer);
    },
    async release(ref) {
      const s = sessions.get(ref);
      if (!s) return;
      sessions.delete(ref);
      s.input.end();
      s.abort.abort();
    },
  };
}
