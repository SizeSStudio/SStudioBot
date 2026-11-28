import { existsSync } from "node:fs";
import { join } from "node:path";
import { makeCodex } from "../agents.ts";
import { scratch, watch, type Case, type Hub, type Policy } from "../lib/harness.ts";
import { mcpCase, resumeCase, steerCase } from "./common.ts";

async function once(hub: Hub, o: { sandbox: string; prompt: string; policy: Policy }) {
  const { cwd } = scratch();
  const methods: string[] = [];
  const adapter = makeCodex({ sandbox: o.sandbox, onRaw: (m) => m.method && m.id !== undefined && methods.push(m.method) });
  const ref = await adapter.createSession({ cwd, mcp: hub.mount, prompt: o.prompt });
  try {
    const w = watch("codex", hub, adapter, ref, o.policy);
    const t = await w.turn(180_000);
    return { cwd, t, methods, has: (f: string) => existsSync(join(cwd, f)) };
  } finally {
    adapter.close();
  }
}

const byName: Policy = (r) => ({ option_id: r.detail.includes("approved.txt") && !r.detail.includes("declined.txt") ? "allow" : "deny" });

export const p6 = (hub: Hub): Case[] => [
  steerCase("codex", hub),
  {
    id: "command-approval",
    title: "命令审批请求到得了，允许和拒绝都生效",
    async run() {
      const r = await once(hub, {
        sandbox: "workspace-write",
        prompt: "Run exactly these two shell commands, as two separate tool calls: `touch approved.txt` then `touch declined.txt`. If one is rejected, do not retry or work around it. Then reply DONE.",
        policy: byName,
      });
      const n = r.methods.filter((m) => m === "item/commandExecution/requestApproval").length;
      const ok = n >= 2 && r.has("approved.txt") && !r.has("declined.txt");
      return { ok, note: `requests=${n} approved_exists=${r.has("approved.txt")} declined_exists=${r.has("declined.txt")} ${r.t.end.error ?? ""}` };
    },
  },
  {
    id: "filechange-approval",
    title: "改文件审批请求到得了，允许和拒绝都生效",
    async run() {
      const r = await once(hub, {
        sandbox: "read-only",
        prompt: "Use the apply_patch tool (not shell commands) to create two files, one patch call per file: first approved.txt containing the line yes, then declined.txt containing the line no. If a patch is rejected, do not retry or work around it. Then reply DONE.",
        policy: byName,
      });
      const n = r.methods.filter((m) => m === "item/fileChange/requestApproval").length;
      const ok = n >= 2 && r.has("approved.txt") && !r.has("declined.txt");
      return { ok, note: `requests=${n} approved_exists=${r.has("approved.txt")} declined_exists=${r.has("declined.txt")} methods=${JSON.stringify([...new Set(r.methods)])} ${r.t.end.error ?? ""}` };
    },
  },
  resumeCase("codex", hub),
  mcpCase("codex", hub),
  {
    id: "turn-diff",
    title: "turn/diff/updated 有内容",
    async run() {
      const r = await once(hub, {
        sandbox: "workspace-write",
        prompt: "Use the apply_patch tool to create hello.txt containing the line hello-diff. Then reply DONE.",
        policy: () => ({ option_id: "allow" }),
      });
      const diffs = r.t.events.flatMap((e) => (e.k === "tool_end" && e.item.startsWith("diff:") ? [e.diff ?? ""] : []));
      const ok = diffs.some((d) => d.includes("+hello-diff"));
      return { ok, note: `diff_updates=${diffs.length} last_bytes=${diffs.at(-1)?.length ?? 0} file=${r.has("hello.txt")}` };
    },
  },
];
