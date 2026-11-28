// 四家怎么起：模型用环境变量挑便宜的，不写进仓库。
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { AgentAdapter } from "./adapter.ts";
import { acpAdapter } from "./adapters/acp.ts";
import { acpxAdapter } from "./adapters/acpx.ts";
import { claudeAdapter } from "./adapters/claude.ts";
import { codexAdapter } from "./adapters/codex.ts";
import { piAdapter } from "./adapters/pi.ts";
import { childEnv } from "./lib/env.ts";
import { ROOT } from "./lib/harness.ts";

export type AgentName = "claude" | "codex" | "pi" | "acp" | "acp-load" | "acp-resume" | "acpx";
export type Made = { adapter: AgentAdapter; dispose: () => void };

const claudeModel = process.env.PROBE_CLAUDE_MODEL ?? "haiku";

// 有环境变量鉴权时用一次性的 CLAUDE_CONFIG_DIR，不碰我自己的设置和 hooks。
export const claudeIsolated = !!(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN || process.env.CLAUDE_CODE_OAUTH_TOKEN);
export const claudeEnv = (state: string) => childEnv(claudeIsolated ? { CLAUDE_CONFIG_DIR: join(state, "claude") } : {});

export function codexArgs(): string[] {
  const home = process.env.CODEX_HOME ?? join(homedir(), ".codex");
  let toml = "";
  try {
    toml = readFileSync(join(home, "config.toml"), "utf8");
  } catch {}
  // 关掉我自己配的 MCP、hooks、插件：探针只看协议本身。
  const servers = [...toml.matchAll(/^\[mcp_servers\.([A-Za-z0-9_-]+)\]/gm)].map((m) => m[1]);
  return [
    ...["hooks", "plugins", "apps", "memories"].flatMap((f) => ["--disable", f]),
    ...servers.flatMap((s) => ["-c", `mcp_servers.${s}.enabled=false`]),
  ];
}

export const makeCodex = (o: { approvalPolicy?: string; sandbox?: string; onRaw?: (m: any) => void } = {}) =>
  codexAdapter({
    model: process.env.PROBE_CODEX_MODEL,
    env: childEnv(),
    args: codexArgs(),
    approvalPolicy: o.approvalPolicy ?? "untrusted",
    sandbox: o.sandbox ?? "workspace-write",
    onRaw: o.onRaw,
  });

export const piArgs = (state: string) => [
  "--session-dir", join(state, "pi"),
  "--no-extensions", "-e", "builtin:mcp",
  "--no-skills", "--no-context-files", "--no-prompt-templates", "--no-approve",
  "--thinking", "off",
  "--tools", "bash,read,mcp__sbot__*",
  ...(process.env.PROBE_PI_PROVIDER ? ["--provider", process.env.PROBE_PI_PROVIDER] : []),
  ...(process.env.PROBE_PI_MODEL ? ["--model", process.env.PROBE_PI_MODEL] : []),
];

export const acpCommand = [process.execPath, join(ROOT, "node_modules/@agentclientprotocol/claude-agent-acp/dist/index.js")];
export const acpEnv = (state: string) => ({ ...claudeEnv(state), ANTHROPIC_MODEL: claudeModel });

export function make(name: AgentName, state: string): Made {
  if (name === "claude") return { adapter: claudeAdapter({ model: claudeModel, effort: "low", env: claudeEnv(state) }), dispose: () => {} };
  if (name === "codex") {
    const a = makeCodex();
    return { adapter: a, dispose: () => a.close() };
  }
  if (name === "pi") {
    const env = childEnv({ PROBE_BASH_ALLOW: "^(sleep \\d+|touch second\\.txt)$" });
    return { adapter: piAdapter({ env, args: piArgs(state), extension: join(ROOT, "adapters/pi-sbot-ext.ts") }), dispose: () => {} };
  }
  if (name.startsWith("acp") && name !== "acpx") {
    const resumeWith = name === "acp-load" ? "load" : name === "acp-resume" ? "resume" : undefined;
    return { adapter: acpAdapter({ command: acpCommand, env: acpEnv(state), resumeWith }), dispose: () => {} };
  }
  return { adapter: acpxAdapter({ command: acpCommand, env: acpEnv(state), stateDir: join(state, "acpx") }), dispose: () => {} };
}
