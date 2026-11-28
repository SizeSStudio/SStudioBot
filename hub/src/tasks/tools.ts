// The sbot MCP as nodes see it (02 「远端节点怎么调主的 MCP 工具」, 05 sbot MCP). A node task's tools = the second
// of the three columns (`system`: a run that tasks trigger, §底3.1) plus submit_report and ask; every call goes
// through the same callTool as the hub's own runs (column → zod → guards → gate → redact → run_items), so `send`
// still becomes an approval card. Nothing here widens a column: a node gets no `bash`, no file tools.
// Idempotent on task_id:attempt:tool_call_id (kv), so a node that retries after a lost reply doesn't run it twice.
import { z } from "zod";
import type { Db, Row } from "../db/db.ts";
import type { Home } from "../home.ts";
import type { HelloRes } from "../../../protocol/node/hello.ts";
import type { ToolCall, ToolCallRes } from "../../../protocol/node/v1.ts";
import type { TurnContext } from "../turn.ts";
import { callTool, toolsFor } from "../tools/registry.ts";
import { submitApproval } from "../approvals.ts";
import { redact, redactDeep } from "../tools/redact.ts";
import { itemStart } from "../items.ts";

const SubmitReport = z.object({ summary: z.string().min(1).max(20000), result: z.unknown().optional() });
const Ask = z.object({ question: z.string().min(1).max(4000), options: z.array(z.string().min(1).max(200)).max(10).optional() });

const OWN: NonNullable<HelloRes["tools"]> = [
  { name: "submit_report", description: "交付：这次做了什么、结果在哪（PR、文件、结论）。做完调一次。", schema: z.toJSONSchema(SubmitReport) },
  { name: "ask", description: "问我一个问题（会变成「问我」卡片）。调完就返回，不用等；我的回答会作为下一条消息发给你。", schema: z.toJSONSchema(Ask) },
];

/** What hello's reply and SessionOpen.tools carry: names, descriptions, JSON schemas. */
export function nodeTools(): NonNullable<HelloRes["tools"]> {
  const ours = toolsFor("system").map((t) => ({ name: t.name, description: t.description, schema: z.toJSONSchema(t.schema, { unrepresentable: "any" }) }));
  return [...ours, ...OWN];
}

export interface NodeCall { device: string; call: ToolCall; task?: Row; run_id?: string }

export async function callNodeTool(db: Db, h: Home, c: NodeCall): Promise<ToolCallRes> {
  const { call, task } = c;
  const key = task ? `task.tc:${String(task.id)}:${Number(task.attempt)}:${call.tool_call_id}` : `task.tc:adhoc:${c.device}:${call.tool_call_id}`;
  const had = db.kvGet(key);
  if (had) { try { return JSON.parse(had) as ToolCallRes; } catch { /* run it again */ } }
  const res = await run(db, h, c);
  db.kvSet(key, JSON.stringify(res));
  return res;
}

async function run(db: Db, h: Home, c: NodeCall): Promise<ToolCallRes> {
  const { call, task } = c;
  const lane = task ? `task:${String(task.id)}` : `mcp:${c.device}`;
  let runId = c.run_id;
  if (!runId) {
    // an ad hoc call (mcp_open): its own run row, so side effects are counted like any run's
    runId = `mcp_${Date.now().toString(36)}_${Math.random().toString(16).slice(2, 8)}`;
    db.run("INSERT INTO runs(id, lane, role, status, device_id, started, ended) VALUES (?,?, 'task', 'done', ?, ?, ?)", runId, lane, c.device, Date.now(), Date.now());
  }
  const err = (text: string): ToolCallRes => ({ text: `error: ${text}`, is_error: true });

  if (call.name === "submit_report") {
    if (!task) return err("submit_report 只在任务里用");
    const a = SubmitReport.safeParse(call.args);
    if (!a.success) return err("参数不对：要 { summary, result? }");
    db.tx(() => db.run("UPDATE tasks SET result_json = ? WHERE id = ?", JSON.stringify(redactDeep(a.data)), String(task.id)));
    itemStart(db, h.blobs, { lane, run_id: runId, kind: "tool", name: "submit_report", call_id: call.tool_call_id, body: { args: a.data, result: "收到" }, status: "done" });
    return { text: "收到" };
  }
  if (call.name === "ask") {
    if (!task) return err("ask 只在任务里用");
    const a = Ask.safeParse(call.args);
    if (!a.success) return err("参数不对：要 { question, options? }");
    const id = db.tx(() => {
      const id = submitApproval(db, {
        kind: "ask", title: redact(a.data.question), origin_lane: lane, requester: `node:${c.device}`,
        options: (a.data.options ?? []).map((label, i) => ({ id: `o${i + 1}`, label: redact(label), kind: "answer" })),
        // `mcp:` marks an ask with no request waiting on the node: the engine answers it as a message
        task_id: String(task.id), attempt: Number(task.attempt), session_ref: (task.session_ref as string | null) ?? undefined, tool_use_id: `mcp:${call.tool_call_id}`,
      });
      db.run("UPDATE tasks SET status = 'waiting' WHERE id = ? AND status = 'running'", String(task.id));
      return id;
    });
    return { text: `已经问了（#${id}）。不用等，我答了会作为下一条消息发给你。` };
  }
  const def = toolsFor("system").find((t) => t.name === call.name);
  if (!def) return err(`没有这个工具：${call.name.slice(0, 100)}`);
  const turn: TurnContext = originTurn(task) ?? { channel: "outlet:main", surface: "task", lane };
  const out = await callTool(def, call.args, {
    db, h, run_id: runId, lane, src: task ? `system@task:${String(task.id)}` : `system@mcp:${c.device}`, col: "system", turn, replies: 0, call_id: call.tool_call_id,
  });
  return out.startsWith("error: ") ? { text: out, is_error: true } : { text: out };
}

/** A task's `reply` goes back to where it was started from; without one, to my main outlet. */
function originTurn(task: Row | undefined): TurnContext | undefined {
  if (!task?.origin_turn_json) return undefined;
  try { const t = JSON.parse(String(task.origin_turn_json)); return t && typeof t.channel === "string" ? t : undefined; } catch { return undefined; }
}
