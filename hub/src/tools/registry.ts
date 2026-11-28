// The tool registry (03 tools): declared once, three columns (§底3.1 is the only source), readOnly for §底4.3's
// "only read-only tools used → safe to run again". callTool's order is fixed:
//   column → zod → guards → gate (L2 writes an approval and returns at once) → side effect count → exec → redact → run_items.
// Every failure becomes an `error: …` string for the model; nothing is thrown at the runner.
import type { z } from "zod";
import type { Db } from "../db/db.ts";
import type { Home } from "../home.ts";
import type { Col, TurnContext } from "../turn.ts";
import type { ExecRes } from "../../../protocol/node/hello.ts";
import { submitApproval, type ApprovalSpec } from "../approvals.ts";
import { itemEnd, itemStart } from "../items.ts";
import { commandGuard, selfGuard } from "./guard.ts";
import { redact } from "./redact.ts";
import { log } from "../log.ts";

/** The local node as tools see it (node-link.ts implements it). */
export interface NodeClient {
  connected(): boolean;
  exec(o: { cmd: string; cwd: string; env?: Record<string, string>; stdin?: string }, signal?: AbortSignal): Promise<ExecRes>;
  readFile(path: string, o?: { offset?: number; len?: number }): Promise<{ data: Buffer; total: number }>;
  writeFile(path: string, data: Buffer, append?: boolean): Promise<void>;
}

export interface ToolCtx {
  db: Db; h: Home; run_id: string; lane: string; src: string; col: Col; turn: TurnContext;
  node?: NodeClient; signal?: AbortSignal; call_id?: string;
  /** replies queued by this run (the dispatcher sends the final text only when there were none) */
  replies: number;
}

export interface ToolDef<S extends z.ZodObject = z.ZodObject> {
  name: string;
  description: string;
  schema: S;
  level: "L0" | "L1" | "L2";
  /** §底3.1 three columns: typed (I typed it), system (timers, approvals, tasks, system events), others (others' conversations) */
  cols: { typed: boolean; system: boolean | "self-items"; others: boolean | "scoped" };
  /** true = changes nothing; the side-effect count and §底4.3 reruns rely on it */
  readOnly: boolean;
  /** Paths and commands this call would touch, for the guards. Read paths also go through selfGuard. */
  touches?: (args: z.infer<S>, ctx: ToolCtx) => { read?: string[]; write?: string[]; cmd?: string };
  /** L2: the approval to file instead of running */
  approval?: (args: z.infer<S>, ctx: ToolCtx) => ApprovalSpec;
  exec?: (args: z.infer<S>, ctx: ToolCtx) => Promise<string>;
}

const registry = new Map<string, ToolDef>();

export function registerTool<S extends z.ZodObject>(def: ToolDef<S>) {
  if (registry.has(def.name)) throw new Error(`tool ${def.name} registered twice`);
  if (def.level === "L2" ? !def.approval : !def.exec) throw new Error(`tool ${def.name}: ${def.level} needs ${def.level === "L2" ? "approval()" : "exec()"}`);
  registry.set(def.name, def as unknown as ToolDef);
}
export const allTools = (): ToolDef[] => [...registry.values()];
export const toolNamed = (name: string) => registry.get(name);

/** This round's tools = column ∩ domain rules (domain rules join with the ledgers in W1e). */
export function toolsFor(col: Col): ToolDef[] {
  return allTools().filter((t) => !!t.cols[col]);
}

const bump = (db: Db, run_id: string) => db.run("UPDATE runs SET side_effects = side_effects + 1 WHERE id = ?", run_id);

export async function callTool(def: ToolDef, rawArgs: unknown, ctx: ToolCtx): Promise<string> {
  const { db, h } = ctx;
  const item = (status: "running" | "done" | "error", result?: string) =>
    itemStart(db, h.blobs, { lane: ctx.lane, run_id: ctx.run_id, kind: "tool", name: def.name, call_id: ctx.call_id, body: { args: rawArgs, ...(result !== undefined ? { result } : {}) }, status });
  const refuse = (why: string) => { const out = `error: ${why}`; item("error", out); return out; };

  // 1 column
  if (!def.cols[ctx.col]) return refuse(`${def.name} 在这一轮不可用（来源 ${ctx.src}）`);
  // 2 schema
  const parsed = def.schema.safeParse(rawArgs);
  if (!parsed.success) return refuse(`参数不对：${parsed.error.issues.slice(0, 4).map((i) => `${i.path.join(".") || "(根)"} ${i.message}`).join("；")}`);
  const args = parsed.data;
  // 3 guards: where it goes, never what it writes
  const t = def.touches?.(args, ctx) ?? {};
  for (const p of t.read ?? []) {
    const why = selfGuard(p, ctx.col, h.agentHome) ?? commandGuard(p, { sbotHome: h.root });
    if (why) return refuse(why);
  }
  for (const p of t.write ?? []) {
    const why = selfGuard(p, ctx.col, h.agentHome) ?? commandGuard(p, { sbotHome: h.root });
    if (why) return refuse(why);
  }
  if (t.cmd) { const why = commandGuard(t.cmd, { sbotHome: h.root }); if (why) return refuse(why); }
  // 4 gate
  if (def.level === "L2") {
    try {
      const id = db.tx(() => { bump(db, ctx.run_id); return submitApproval(db, { origin_lane: ctx.lane, run_id: ctx.run_id, requester: ctx.src, ...def.approval!(args, ctx) }); });
      const out = `已提交审批 #${id}。批了才会执行；不用等，也别说已经做了。`;
      item("done", out);
      return out;
    } catch (e) {
      return refuse(`提交审批失败：${String((e as Error)?.message ?? e).slice(0, 300)}`);
    }
  }
  // 5 side effects are counted before they can happen, so a crash in exec still counts (§底1.2)
  if (!def.readOnly) bump(db, ctx.run_id);
  const id = item("running");
  try {
    const out = redact(await def.exec!(args, ctx));
    itemEnd(db, h.blobs, id, "done", { args: rawArgs, result: out });
    return out;
  } catch (e) {
    const out = `error: ${redact(String((e as Error)?.message ?? e)).slice(0, 1000)}`;
    itemEnd(db, h.blobs, id, "error", { args: rawArgs, result: out });
    log("tools", "tool failed", { tool: def.name, run: ctx.run_id });
    return out;
  }
}
