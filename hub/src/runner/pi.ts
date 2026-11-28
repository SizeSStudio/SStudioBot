// pi embedded (§办1.1, 03 runner), ported from core/src/runner.ts (10):
//   - discovery off: DefaultResourceLoader with every no* switch, a private agentDir; builtin tools off
//     (noTools: "builtin"), only our customTools, each going through callTool
//   - the run token never goes into process.env (lanes run concurrently): each run gets its own ModelRuntime with an
//     in-memory credential store holding that token only ※ (03 said `apiKey: "$SBOT_RUN_TOKEN"`; an env var would be
//     shared by every lane in the process)
//   - one session file per lane (sessions.session_ref), reopened each run, so a crash loses nothing already appended
//   - the model is the alias sbot-<tier>; the proxy resolves it per request, so a switch lands after the tool results
//     (P10) and the proxy reshapes history for the new model
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import * as pi from "@earendil-works/pi-coding-agent";
import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { modelsConf, TIERS, type Tier } from "../config/load.ts";
import { callTool, type ToolCtx, type ToolDef } from "../tools/registry.ts";
import { StreamRedactor } from "../tools/redact.ts";
import { log } from "../log.ts";
import type { RunOpts, RunResult, Runner } from "./types.ts";

const alias = (t: Tier) => `sbot-${t}`;

export interface PiDirs { agentDir: string; sessions: string; cwd: string }
export const piDirs = (piRoot: string): PiDirs => ({ agentDir: join(piRoot, "agent"), sessions: join(piRoot, "sessions"), cwd: join(piRoot, "cwd") });

/** models.json for pi: provider "sbot" → the proxy, one model per configured tier alias. No key in the file. */
export function writePiModels(d: PiDirs, proxyBase: string) {
  mkdirSync(d.agentDir, { recursive: true });
  let tiers: Partial<Record<Tier, { context?: number; max_tokens?: number }>> = {};
  try { tiers = modelsConf().tiers; } catch { /* models.yaml not filled in yet: no models, every run fails and says so */ }
  writeFileSync(join(d.agentDir, "models.json"), JSON.stringify({
    providers: {
      sbot: {
        baseUrl: proxyBase, api: "anthropic-messages",
        models: TIERS.filter((t) => tiers[t]).map((t) => ({
          id: alias(t), name: alias(t), reasoning: false, input: ["text"],
          contextWindow: tiers[t]!.context ?? 200_000, maxTokens: tiers[t]!.max_tokens ?? 16_000,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },   // metering is the proxy's job
        })),
      },
    },
  }, null, 2));
}

function piTools(tools: ToolDef[], ctx: ToolCtx, calls: string[], signal: AbortSignal) {
  return tools.map((t) => {
    // input shape: pi validates the model's arguments against this before execute(), and in zod's default (output)
    // shape a field with a default is "required", so a call leaning on the default would never reach callTool
    const { $schema: _s, ...json } = z.toJSONSchema(t.schema, { io: "input" }) as Record<string, unknown>;
    return {
      name: t.name, label: t.name, description: t.description, parameters: Type.Unsafe(json),
      execute: async (id: string, params: unknown) => {
        calls.push(t.name);
        const text = await callTool(t, params, { ...ctx, call_id: id, signal, get replies() { return ctx.replies; }, set replies(n) { ctx.replies = n; } });
        return { content: [{ type: "text" as const, text }], details: {} };
      },
    };
  });
}

type Live = { session: { steer(text: string): Promise<unknown>; isStreaming: boolean }; steered: number[] };

export class PiRunner implements Runner {
  readonly dirs: PiDirs;
  #live = new Map<string, Live>();

  constructor(piRoot: string, proxyBase: string) {
    this.dirs = piDirs(piRoot);
    for (const d of Object.values(this.dirs)) mkdirSync(d, { recursive: true });
    writePiModels(this.dirs, proxyBase);
  }

  async steer(lane: string, text: string, inbox_id: number): Promise<boolean> {
    const l = this.#live.get(lane);
    if (!l || !l.session.isStreaming) return false;
    try { await l.session.steer(text); } catch { return false; }
    l.steered.push(inbox_id);
    return true;
  }

  async run(o: RunOpts): Promise<RunResult> {
    const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
    const tools: string[] = [];
    const runtime = await pi.ModelRuntime.create({
      credentials: new InMemoryCredentialStore(), modelsPath: join(this.dirs.agentDir, "models.json"),
      allowModelNetwork: false, refreshOnCreate: false,
    } as never);
    await runtime.setRuntimeApiKey("sbot", o.token);
    const model = runtime.getModel("sbot", alias(o.tier));
    const fail = (error: string): RunResult => ({ output: "", fullText: "", session_ref: o.session_ref ?? "", stop: "error", error, usage, tools, undelivered: [] });
    if (!model) return fail(`tier ${o.tier} not configured in models.yaml`);

    const settingsManager = pi.SettingsManager.inMemory({ compaction: { enabled: true }, retry: { enabled: true, maxRetries: 2 }, cacheWarming: "off" } as never);
    const resourceLoader = new pi.DefaultResourceLoader({
      cwd: this.dirs.cwd, agentDir: this.dirs.agentDir, settingsManager, systemPrompt: o.system,
      noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
    } as never);
    await resourceLoader.reload();
    const sm = o.session_ref && existsSync(o.session_ref)
      ? pi.SessionManager.open(o.session_ref, this.dirs.sessions)
      : pi.SessionManager.create(this.dirs.cwd, this.dirs.sessions);
    // two locks on pi's own tools (read, bash, edit, write): builtins off, and an allowlist of exactly this round's
    // names (a custom tool replaces a builtin of the same name, so our `bash` is ours). Typed, so a misspelt option fails tsc.
    const opts = {
      cwd: this.dirs.cwd, agentDir: this.dirs.agentDir, model, thinkingLevel: "off", modelRuntime: runtime, resourceLoader,
      settingsManager, sessionManager: sm, noTools: "builtin", tools: o.tools.map((t) => t.name),
      customTools: piTools(o.tools, o.ctx, tools, o.signal) as unknown as pi.ToolDefinition[],
    } satisfies pi.CreateAgentSessionOptions;
    const { session } = await pi.createAgentSession(opts);

    const live: Live = { session, steered: [] };
    this.#live.set(o.lane, live);
    let error: string | undefined, aborted = false;
    const onAbort = () => { aborted = true; void session.abort().catch(() => {}); };
    if (o.signal.aborted) onAbort(); else o.signal.addEventListener("abort", onAbort, { once: true });

    const emit = (e: Parameters<RunOpts["onItem"]>[0]) => { try { o.onItem(e); } catch (err) { log("runner", "onItem failed", { err: String((err as Error)?.message ?? err).slice(0, 200) }); } };
    const stream = new StreamRedactor((text) => emit({ k: "delta", text }));
    const textOf = (m: { content?: unknown }) => (Array.isArray(m?.content) ? m.content : []).filter((c: { type?: string }) => c.type === "text").map((c: { text?: string }) => c.text ?? "").join("");
    let full = "", seen = 0;
    const unsub = session.subscribe((ev: any) => {
      if (ev.type === "message_update" && ev.assistantMessageEvent?.type === "text_delta") {
        const t = textOf(ev.message);
        if (t.length > seen) { stream.push(t.slice(seen)); seen = t.length; }
      } else if (ev.type === "tool_execution_start") emit({ k: "tool_start", name: ev.toolName, call_id: ev.toolCallId });
      else if (ev.type === "tool_execution_end") emit({ k: "tool_end", name: ev.toolName, call_id: ev.toolCallId, error: !!ev.isError });
      if (ev.type === "message_end" && ev.message?.role === "assistant") {
        stream.flush();
        seen = 0;
        const t = textOf(ev.message).trim();
        if (t) { full = full ? `${full}\n\n${t}` : t; emit({ k: "message", text: t }); }
        const u = ev.message.usage ?? {};
        usage.input += u.input ?? 0; usage.output += u.output ?? 0; usage.cacheRead += u.cacheRead ?? 0; usage.cacheWrite += u.cacheWrite ?? 0;
        if (ev.message.errorMessage) error = ev.message.errorMessage;
      }
    });
    try {
      await session.prompt(o.input);
    } catch (e) {
      error = String((e as Error)?.message ?? e);
    } finally {
      unsub();
      stream.flush();
      o.signal.removeEventListener("abort", onAbort);
      this.#live.delete(o.lane);
    }
    // steers still queued when the prompt ended were never seen by the model: FIFO, so they are the last ones
    const left = session.clearQueue().steering.length;
    const undelivered = left > 0 ? live.steered.slice(-left) : [];
    const output = session.getLastAssistantText() ?? "";
    const session_ref = session.sessionFile ?? o.session_ref ?? "";
    session.dispose();
    if (error && !aborted) log("runner", "pi error", { run: o.ctx.run_id, err: error.slice(0, 300) });
    return { output, fullText: full, session_ref, stop: aborted ? "aborted" : error ? "error" : "done", error, usage, tools, undelivered };
  }
}
