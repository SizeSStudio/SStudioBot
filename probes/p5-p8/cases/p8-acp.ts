import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { make, type AgentName } from "../agents.ts";
import { nonce, scratch, watch, type Case, type Hub } from "../lib/harness.ts";
import { mcpCase, resumeCase } from "./common.ts";

const permissionCase = (agent: AgentName, hub: Hub): Case => ({
  id: `${agent}:permission`,
  title: "session/request_permission 到得了，允许和拒绝都生效",
  async run() {
    const { cwd, state } = scratch();
    const { adapter } = make(agent, state);
    const ref = await adapter.createSession({
      cwd,
      mcp: hub.mount,
      prompt: "Run exactly these two shell commands, as two separate tool calls: `touch approved.txt` then `touch declined.txt`. If one is rejected, do not retry or work around it; still run the other. Then reply DONE.",
    });
    try {
      let n = 0;
      const w = watch(agent, hub, adapter, ref, (r) => {
        n++;
        return { option_id: r.detail.includes("approved.txt") && !r.detail.includes("declined.txt") ? "allow" : "deny" };
      });
      const t = await w.turn();
      const a = existsSync(join(cwd, "approved.txt"));
      const d = existsSync(join(cwd, "declined.txt"));
      return { ok: n >= 2 && a && !d, note: `requests=${n} approved_exists=${a} declined_exists=${d} stop=${t.end.stop} ${t.end.error ?? ""}` };
    } finally {
      await adapter.release(ref);
    }
  },
});

const tag = (c: Case, id: string, title: string): Case => ({ ...c, id, title });
const seen = (a: unknown) => `sent=${JSON.stringify((a as { seen: string[] }).seen)}`;

export const p8 = (hub: Hub): Case[] => [
  // acpx 库入口
  tag(mcpCase("acpx", hub), "acpx:mcp", "acpx：session/new 带 mcpServers，工具能调"),
  permissionCase("acpx", hub),
  tag(resumeCase("acpx", hub, seen), "acpx:resume", "acpx：按 resumeSessionId 续接（库自己选 resume / load）"),
  // 直接用 @agentclientprotocol/sdk
  tag(mcpCase("acp", hub), "acp:mcp", "SDK：session/new 带 mcpServers，工具能调"),
  permissionCase("acp", hub),
  tag(resumeCase("acp-load", hub, seen), "acp:load", "SDK：session/load 续接"),
  tag(resumeCase("acp-resume", hub, seen), "acp:resume", "SDK：session/resume 续接（旧名 unstable_resumeSession）"),
  {
    id: "acp:progress-md",
    title: "不靠续接：新开 session 读 progress.md 接上",
    async run() {
      const { cwd, state } = scratch();
      const word = nonce("C");
      const step = nonce("STEP");
      writeFileSync(join(cwd, "progress.md"), `# progress\n- codeword: ${word}\n- next step: ${step}\n`);
      const { adapter } = make("acp", state);
      const ref = await adapter.createSession({ cwd, mcp: hub.mount, prompt: "You are continuing an interrupted task. Read progress.md, then reply with the codeword and the next step, verbatim." });
      try {
        // 默认策略只放行 sleep / touch：agent 改用 shell 读文件时会被它拒掉，这一项要放行只读命令。
        const READ = /^(pwd|ls( -[a-zA-Z]+)?|cat (\.\/|\/[\w./-]*\/)?progress\.md)$/;
        const w = watch("acp", hub, adapter, ref, (r) => ({ option_id: r.detail.split(/&&|;|\n/).every((c) => READ.test(c.trim())) ? "allow" : "deny" }));
        const t = await w.turn();
        const ok = t.text.includes(word) && t.text.includes(step);
        return { ok, note: `codeword=${t.text.includes(word)} next_step=${t.text.includes(step)}${ok ? "" : ` reply=${JSON.stringify(t.text.slice(0, 200))} events=${t.events.map((e) => e.k).join(",")}`}` };
      } finally {
        await adapter.release(ref);
      }
    },
  },
];
