import { existsSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { claudeIsolated, make } from "../agents.ts";
import { nonce, scratch, watch, type Case, type Hub } from "../lib/harness.ts";
import { mcpCase, resumeCase, steerCase } from "./common.ts";

const rules = (dir: string, allow: string) => {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "settings.json"), JSON.stringify({ permissions: { allow: [allow] } }));
};

export const p5 = (hub: Hub): Case[] => [
  steerCase("claude", hub),
  {
    id: "permissions",
    title: "settingSources 加载用户和项目规则后，规则外的工具才进 canUseTool",
    async run() {
      const { cwd, state } = scratch();
      if (claudeIsolated) {
        rules(join(state, "claude"), "Bash(mkdir ruled-user)");
        // 项目级规则只在工作区被信任时才加载（SDK 不弹信任框）；一次性配置目录里预先记上。
        writeFileSync(join(state, "claude", ".claude.json"), JSON.stringify({ projects: { [realpathSync(cwd)]: { hasTrustDialogAccepted: true } } }));
      }
      rules(join(cwd, ".claude"), "Bash(mkdir ruled-project)");
      const { adapter } = make("claude", state);
      const cmds = [...(claudeIsolated ? ["mkdir ruled-user"] : []), "mkdir ruled-project", "mkdir outside-allow", "mkdir outside-deny", "ls"];
      const ref = await adapter.createSession({
        cwd,
        mcp: hub.mount,
        prompt: `Run these Bash commands one at a time, each as its own tool call, exactly as written: ${cmds.map((c) => `\`${c}\``).join(", ")}. If one is denied, do not retry; continue with the next. Then reply DONE.`,
      });
      try {
        const asked: string[] = [];
        const w = watch("claude", hub, adapter, ref, (r) => {
          asked.push(r.detail);
          return { option_id: r.detail === "mkdir outside-allow" ? "allow" : "deny" };
        });
        const t = await w.turn();
        const ran = t.events.flatMap((e) => (e.k === "tool_start" ? [(e.args as any).command] : []));
        const has = (d: string) => existsSync(join(cwd, d));
        const ok =
          cmds.every((c) => ran.includes(c)) &&
          JSON.stringify([...asked].sort()) === JSON.stringify(["mkdir outside-allow", "mkdir outside-deny"]) &&
          (!claudeIsolated || has("ruled-user")) && has("ruled-project") && has("outside-allow") && !has("outside-deny");
        return { ok, note: `user_rule_tested=${claudeIsolated} asked=${JSON.stringify(asked)} ran=${ran.length} deny_respected=${!has("outside-deny")} allow_respected=${has("outside-allow")}` };
      } finally {
        await adapter.release(ref);
      }
    },
  },
  {
    id: "ask",
    title: "AskUserQuestion 截下转 ask，答案回到模型",
    async run() {
      const { cwd, state } = scratch();
      const { adapter } = make("claude", state);
      const word = nonce("A");
      const ref = await adapter.createSession({
        cwd,
        mcp: hub.mount,
        prompt: "Use the AskUserQuestion tool to ask me which color I want, with options Red and Blue. After I answer, reply with exactly: COLOR=<my answer>.",
      });
      try {
        const w = watch("claude", hub, adapter, ref, (_r, k) => (k === "ask" ? { option_id: "other", text: `Teal-${word}` } : { option_id: "deny" }));
        const t = await w.turn();
        const asks = t.events.filter((e) => e.k === "ask").length;
        const got = t.text.includes(word);
        return { ok: asks === 1 && got, note: `ask_events=${asks} answer_reached_model=${got}` };
      } finally {
        await adapter.release(ref);
      }
    },
  },
  resumeCase("claude", hub),
  { ...mcpCase("claude", hub), title: "in-process MCP 的 sbot 工具能调" },
];
