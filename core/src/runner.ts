// Runner (DESIGN §4.0): the only place that knows which harness runs a role. Conversational roles run on pi 1.5.2
// inside the core process; workers (M2) will run on the Claude Agent SDK behind the same interface.
//
// pi notes (P0 + 1.5.2 source):
//   - discovery off: DefaultResourceLoader({ noExtensions, noSkills, noPromptTemplates, noThemes, noContextFiles })
//     plus a private agentDir; builtin tools off (noTools: "builtin"), only our customTools
//   - the run token must not live in process.env (lanes run concurrently): each run gets its own ModelRuntime with
//     an in-memory credential store holding just that token; no catalog network refresh, no cache warming
//   - one session file per session (sessions.session_ref); reopened for each run, so a crash loses nothing that
//     was already appended

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import * as pi from "@earendil-works/pi-coding-agent";
import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { P, PROXY_BASE, TIERS, models, log, type Tier } from "./config.ts";
import { callTool, type RunCtx, type ToolDef } from "./tools.ts";

export interface RunInput {
  tier: Tier;
  sessionRef?: string;            // existing session file, or undefined for a new session
  systemPrompt: string;
  text: string;                   // the user turn (already batched and annotated)
  tools: ToolDef[];
  ctx: RunCtx;
  onAbortable?: (abort: () => Promise<void>) => void;
  /** all assistant text of this run so far (finished messages joined by a blank line) + the tool running now */
  onStream?: (s: { text: string; tool?: string }) => void;
}
export interface RunResult {
  text: string;                   // last assistant text
  fullText: string;               // every assistant text block of this run, in order (what the stream showed)
  sessionRef: string;
  stop: "done" | "aborted" | "error";
  error?: string;
  usage: { input: number; output: number; cacheRead: number; cacheWrite: number };
  toolCalls: string[];
}
export interface Runner { run(input: RunInput): Promise<RunResult> }

const alias = (t: Tier) => `sbot-${t}`;

/** models.json for pi: one provider "sbot" pointing at the LLM proxy, one model per tier alias. No key in the file. */
export function writePiModels() {
  mkdirSync(P.piAgentDir, { recursive: true });
  const cfg = models();
  writeFileSync(join(P.piAgentDir, "models.json"), JSON.stringify({
    providers: {
      sbot: {
        baseUrl: PROXY_BASE, api: "anthropic-messages",
        models: TIERS.filter((t) => cfg.tiers[t]).map((t) => ({
          id: alias(t), name: alias(t), reasoning: false, input: ["text"],
          contextWindow: cfg.tiers[t]!.context ?? 200_000, maxTokens: cfg.tiers[t]!.max_tokens ?? 16_000,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },   // metering is the proxy's job
        })),
      },
    },
  }, null, 2));
}

function piTools(tools: ToolDef[], ctx: RunCtx, calls: string[]) {
  return tools.map((t) => {
    const { $schema, ...json } = z.toJSONSchema(t.schema) as any;
    return {
      name: t.name, label: t.name, description: t.description, parameters: Type.Unsafe(json),
      execute: async (_id: string, params: unknown) => {
        calls.push(t.name);
        return { content: [{ type: "text" as const, text: await callTool(t, params, ctx) }], details: {} };
      },
    };
  });
}

export class PiRunner implements Runner {
  private cwd = join(P.sessions, "pi-cwd");
  constructor() { mkdirSync(this.cwd, { recursive: true }); writePiModels(); }

  async run(inp: RunInput): Promise<RunResult> {
    const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
    const toolCalls: string[] = [];
    const runtime = await pi.ModelRuntime.create({
      credentials: new InMemoryCredentialStore(), modelsPath: join(P.piAgentDir, "models.json"),
      allowModelNetwork: false, refreshOnCreate: false,
    });
    await runtime.setRuntimeApiKey("sbot", inp.ctx.token);
    const model = runtime.getModel("sbot", alias(inp.tier));
    if (!model) throw new Error(`pi: model sbot/${alias(inp.tier)} not found: ${runtime.getError()}`);

    const settingsManager = pi.SettingsManager.inMemory({
      compaction: { enabled: true }, retry: { enabled: true, maxRetries: 2 }, cacheWarming: "off",
    } as any);
    const resourceLoader = new pi.DefaultResourceLoader({
      cwd: this.cwd, agentDir: P.piAgentDir, settingsManager, systemPrompt: inp.systemPrompt,
      noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
    } as any);
    await resourceLoader.reload();
    const sessionsDir = join(P.sessions, "pi");
    mkdirSync(sessionsDir, { recursive: true });
    const sm = inp.sessionRef && existsSync(inp.sessionRef)
      ? pi.SessionManager.open(inp.sessionRef, sessionsDir)
      : pi.SessionManager.create(this.cwd, sessionsDir);
    const { session } = await pi.createAgentSession({
      cwd: this.cwd, agentDir: P.piAgentDir, model, thinkingLevel: "off", modelRuntime: runtime, resourceLoader,
      settingsManager, sessionManager: sm, noTools: "builtin", customTools: piTools(inp.tools, inp.ctx, toolCalls) as any,
    } as any);

    let error: string | undefined, aborted = false;
    inp.onAbortable?.(async () => { aborted = true; await session.abort(); });
    const textOf = (m: any) => (Array.isArray(m?.content) ? m.content : []).filter((c: any) => c.type === "text").map((c: any) => c.text).join("");
    const joinText = (...xs: string[]) => xs.map((x) => x.trim()).filter(Boolean).join("\n\n");
    let done = "", tool: string | undefined;
    const emit = (cur = "") => { try { inp.onStream?.({ text: joinText(done, cur), tool }); } catch { /* never break the run */ } };
    const unsub = session.subscribe((ev: any) => {
      if (ev.type === "message_update" && ev.assistantMessageEvent?.type === "text_delta") emit(textOf(ev.message));
      else if (ev.type === "tool_execution_start") { tool = ev.toolName; emit(); }
      else if (ev.type === "tool_execution_end") { tool = undefined; emit(); }
      if (ev.type === "message_end" && ev.message?.role === "assistant") {
        done = joinText(done, textOf(ev.message));
        const u = ev.message.usage ?? {};
        usage.input += u.input ?? 0; usage.output += u.output ?? 0; usage.cacheRead += u.cacheRead ?? 0; usage.cacheWrite += u.cacheWrite ?? 0;
        if (ev.message.errorMessage) error = ev.message.errorMessage;
      }
    });
    try {
      await session.prompt(inp.text);
    } catch (e: any) {
      error = String(e?.message ?? e);
    } finally {
      unsub();
    }
    const text = session.getLastAssistantText() ?? "";
    const sessionRef = session.sessionFile!;
    session.dispose();
    if (error) log("runner", "pi error", { run: inp.ctx.runId, error: error.slice(0, 300) });
    return { text, fullText: done, sessionRef, stop: aborted ? "aborted" : error ? "error" : "done", error, usage, toolCalls };
  }
}
