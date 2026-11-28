// The tools W1d brings: reply, memory_read, bash / read_file / write_file (through the local node), send (L2).
// W1e registers its own (memory_search, self_list, ledgers, …) through the same registerTool().
import { existsSync, readFileSync, statSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { z } from "zod";
import { enqueue, toOutlet } from "../outbox.ts";
import { gateConf } from "../config/load.ts";
import { registerTool, type ToolCtx } from "./registry.ts";
import { relToAgentHome } from "./guard.ts";

const HOUR = 3600_000;

/** Reply to where this round's input came from (TurnContext); with no turn (a job), to the main outlet. */
export function queueReply(ctx: Pick<ToolCtx, "db" | "run_id" | "lane" | "turn">, text: string, countIt = true): number {
  const { db } = ctx;
  return db.tx(() => {
    // callTool already counted the `reply` tool; the dispatcher's own sends count here
    if (countIt) db.run("UPDATE runs SET side_effects = side_effects + 1 WHERE id = ?", ctx.run_id);
    if (ctx.turn.channel === "outlet:main") {
      const ids = toOutlet(db, "main", text, { lane: ctx.lane, run_id: ctx.run_id });
      return ids[0] ?? 0;
    }
    return enqueue(db, {
      channel: ctx.turn.channel, target: { ...ctx.turn }, payload: text, lane: ctx.lane, run_id: ctx.run_id,
      send_by: Date.now() + gateConf().send_by_hours * HOUR,
    });
  });
}

const MEMORY_MAX = 12_000;

export function registerBuiltinTools() {
  registerTool({
    name: "reply", level: "L1", readOnly: false,
    cols: { typed: true, system: true, others: "scoped" },
    description: "先发一句或分几条发给这一轮的来源。你的最终回答会自动发出；只有要先说一句再干活、或者要分条发时才用它。",
    schema: z.object({ text: z.string().min(1).max(8000) }),
    async exec({ text }, ctx) { queueReply(ctx, text, false); ctx.replies++; return "已排进发件箱"; },
  });

  registerTool({
    name: "memory_read", level: "L0", readOnly: true,
    cols: { typed: true, system: true, others: "scoped" },
    description: "按相对 agent-home 的路径读一页记忆，比如 journal/2026-11-17.md。长的会截断，第一行说读到多少。",
    schema: z.object({ path: z.string().min(1), offset: z.number().int().nonnegative().optional() }),
    touches: ({ path }) => ({ read: [path] }),
    async exec({ path, offset }, ctx) {
      const rel = relToAgentHome(path, ctx.h.agentHome);
      const f = resolve(ctx.h.agentHome, rel);
      const inside = relative(ctx.h.agentHome, f);
      if (inside.startsWith("..") || isAbsolute(inside)) return "error: 只能读 agent-home 里的页";
      if (!existsSync(f) || !statSync(f).isFile()) return `error: 没有这一页：${rel}`;
      const text = readFileSync(f, "utf8"), from = offset ?? 0, part = text.slice(from, from + MEMORY_MAX);
      // R7: a cut is said on the first line, never silent
      const head = from + part.length < text.length || from > 0 ? `（读到 ${from + part.length} / 共 ${text.length} 字${from + part.length < text.length ? `，接着读用 offset=${from + part.length}` : ""}）\n` : "";
      return head + part;
    },
  });

  const cwdOf = (ctx: ToolCtx, cwd?: string) => cwd ?? process.env.SBOT_NODE_CWD ?? join(ctx.h.root, "..");
  const needNode = (ctx: ToolCtx) => { if (!ctx.node?.connected()) throw new Error("本机节点没连上，bash 和读写文件暂时用不了"); return ctx.node; };

  registerTool({
    name: "bash", level: "L1", readOnly: false,
    cols: { typed: true, system: false, others: false },
    description: "在本机节点上以节点账号跑一条 bash 命令（bash -lc），返回退出码、stdout、stderr。不设时长；我说停会杀掉整个进程组。",
    schema: z.object({ cmd: z.string().min(1), cwd: z.string().optional() }),
    touches: ({ cmd, cwd }) => ({ cmd: cwd ? `${cmd}\n${cwd}` : cmd }),
    async exec({ cmd, cwd }, ctx) {
      const r = await needNode(ctx).exec({ cmd, cwd: cwdOf(ctx, cwd) }, ctx.signal);
      return [`exit ${r.code ?? `signal ${r.signal}`}`, r.stdout && `stdout:\n${r.stdout}`, r.stderr && `stderr:\n${r.stderr}`].filter(Boolean).join("\n");
    },
  });

  registerTool({
    name: "read_file", level: "L0", readOnly: true,
    cols: { typed: true, system: false, others: false },
    description: "经本机节点读一个文件（UTF-8）。长的分段读：offset、len 按字节。",
    schema: z.object({ path: z.string().min(1), offset: z.number().int().nonnegative().optional(), len: z.number().int().positive().max(1_000_000).optional() }),
    touches: ({ path }) => ({ read: [path] }),
    async exec({ path, offset, len }, ctx) {
      const r = await needNode(ctx).readFile(path, { offset, len: len ?? 200_000 });
      const end = (offset ?? 0) + r.data.length;
      return (end < r.total || (offset ?? 0) > 0 ? `（读到第 ${end} 字节 / 共 ${r.total}）\n` : "") + r.data.toString("utf8");
    },
  });

  registerTool({
    name: "write_file", level: "L1", readOnly: false,
    cols: { typed: true, system: false, others: false },
    description: "经本机节点写一个文件（整份覆盖，append=true 时追加）。",
    schema: z.object({ path: z.string().min(1), text: z.string(), append: z.boolean().optional() }),
    touches: ({ path }) => ({ write: [path] }),
    async exec({ path, text, append }, ctx) {
      await needNode(ctx).writeFile(path, Buffer.from(text, "utf8"), append);
      return `已写入 ${path}（${Buffer.byteLength(text)} 字节）`;
    },
  });

  registerTool({
    name: "send", level: "L2", readOnly: false,
    cols: { typed: true, system: true, others: false },
    description: "以 bot 或我的身份给别人发一条消息。永远先进审批卡片，我点了才原样发出；工具立刻返回，不要等，也别说已经发了。",
    schema: z.object({
      channel: z.string().min(1), to: z.string().min(1).describe("渠道里的会话 id"), text: z.string().min(1).max(8000),
      as: z.enum(["bot", "user"]).default("bot"), thread: z.string().optional(),
    }),
    approval: ({ channel, to, text, as, thread }) => ({
      kind: "send", title: `发给 ${to}`, draft: text, channel, as_identity: as,
      target: { chat: to, to, ...(thread ? { thread } : {}), surface: `${channel}:send` },
    }),
  });
}
