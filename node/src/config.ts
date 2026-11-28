// The node's own files (05 「配置」). Instance data, never in the repo:
//   config  ~/.config/sbot-node/   (SBOT_NODE_CONFIG)  node.yaml, hub.json (pairing: hub key, relay, device id), device.key
//   state   ~/.local/state/sbot-node/ (SBOT_NODE_STATE) sessions.json, spool/, ctl.sock, upgrade.json, pi sessions
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { parse } from "yaml";
import { z } from "zod";

const Bin = z.object({ bin: z.string().optional(), args: z.array(z.string()).optional(), model: z.string().optional() });
export const NodeConf = z.object({
  agents: z.object({
    claude: Bin.optional(), codex: Bin.optional(), pi: Bin.optional(),
    acp: z.array(z.object({ name: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,40}$/), cmd: z.union([z.string(), z.array(z.string())]) })).optional(),
  }).optional(),
  /** only these agents, even if others are on PATH */
  only: z.array(z.string()).optional(),
  max_parallel: z.number().int().positive().nullable().optional(),
  workdirs: z.array(z.string()).optional(),
  linux: z.object({ account: z.string().optional(), memory_max: z.string().optional(), worker_exec: z.string().optional() }).optional(),
}).passthrough();
export type NodeConf = z.infer<typeof NodeConf>;

export const configDir = (env = process.env) => resolve(env.SBOT_NODE_CONFIG || join(homedir(), ".config", "sbot-node"));
export const stateDir = (env = process.env) => resolve(env.SBOT_NODE_STATE || join(homedir(), ".local", "state", "sbot-node"));

export function ensureDir(d: string, mode = 0o700) { mkdirSync(d, { recursive: true, mode }); return d; }

export function loadConf(dir = configDir()): NodeConf {
  const f = join(dir, "node.yaml");
  if (!existsSync(f)) return {};
  const r = NodeConf.safeParse(parse(readFileSync(f, "utf8")) ?? {});
  if (!r.success) throw new Error(`node.yaml 不对：${r.error.issues.map((i) => `${i.path.join(".")} ${i.message}`).join("；").slice(0, 500)}`);
  return r.data;
}

/** `cmd` as written in node.yaml: an argv list, or one string split on spaces (no shell). */
export const argv = (cmd: string | string[]) => (Array.isArray(cmd) ? cmd : cmd.trim().split(/\s+/)).filter(Boolean);
