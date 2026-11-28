import { spawnSync } from "node:child_process";
import { childEnv } from "../lib/env.ts";
import type { Case, Hub } from "../lib/harness.ts";
import { mcpCase, resumeCase, steerCase } from "./common.ts";

export const p7 = (hub: Hub): Case[] => [
  steerCase("pi", hub),
  resumeCase("pi", hub),
  { ...mcpCase("pi", hub), id: "mcp", title: "sbot MCP 经 pi 扩展 registerMcpServer 挂上能调" },
  {
    id: "mcp-config-flag",
    title: "--mcp-config 参数可用",
    async run() {
      const r = spawnSync("pi", ["--mode", "rpc", "--no-session", "--offline", "--mcp-config", "/dev/null"], { env: childEnv(), input: "", encoding: "utf8", timeout: 20_000 });
      const msg = (r.stderr + r.stdout).split("\n").find((l) => /mcp-config/.test(l)) ?? "";
      return { ok: !msg, note: msg.trim() };
    },
  },
];
