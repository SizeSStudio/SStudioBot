// The Runner interface (03 runner). The hub has one implementation (pi, pi.ts); node adapters implement the same
// capabilities in the node program (05).
import type { Tier } from "../config/load.ts";
import type { ToolCtx, ToolDef } from "../tools/registry.ts";

export type Role = "main" | "draft" | "dream" | "improve" | "lens" | "expert";
export type StopReason = "done" | "aborted" | "error";
export interface Usage { input: number; output: number; cacheRead: number; cacheWrite: number }

export type ItemEvent =
  | { k: "delta"; text: string }                          // redacted, batched (StreamRedactor)
  | { k: "message"; text: string }                        // one assistant message finished
  | { k: "tool_start"; name: string; call_id: string }
  | { k: "tool_end"; name: string; call_id: string; error: boolean };

export interface RunOpts {
  lane: string; role: Role; tier: Tier; session_ref?: string;
  system: string; input: string; tools: ToolDef[];
  ctx: ToolCtx;                                          // run_id, src, col, turn … for callTool
  token: string;                                         // this run's proxy token; held in memory only
  onItem: (e: ItemEvent) => void;
  signal: AbortSignal;
}

export interface RunResult {
  output: string;                                        // last assistant text
  fullText: string;                                      // every assistant text of the run, in order
  session_ref: string;
  stop: StopReason;
  error?: string;
  usage: Usage;
  tools: string[];                                       // names of the tools called, in order
  undelivered: number[];                                 // steered inbox ids the model never saw (back to the queue)
}

export interface Runner {
  run(o: RunOpts): Promise<RunResult>;
  /** false = can't steer now; the caller leaves the row queued for the next round */
  steer(lane: string, text: string, inbox_id: number): Promise<boolean>;
}
