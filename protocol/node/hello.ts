// Node → hub hello and the local-node-only exec/fs (docs/tech/02 「/node/v1」, 05). First batch; grows per wave.
import { z } from "zod";

export const AgentInfo = z.object({ kind: z.string(), version: z.string().optional() });
export const Hello = z.object({
  version: z.number().int(),          // the node's PROTOCOL.current
  sha: z.string(),                    // commit the node runs
  os: z.string(),
  agents: z.array(AgentInfo),
  capabilities: z.record(z.string(), z.record(z.string(), z.boolean())),  // per agent, P5–P8: only 3/3 is true
  quotas: z.record(z.string(), z.unknown()),
  max_parallel: z.number().int().positive().optional(),
  cwd: z.string().optional(),         // the node's default directory (SBOT_NODE_CWD, else its account's home); the hub resolves relative paths against it
  // W4
  app_version: z.string().optional(), // the node program's package version (nodes.version)
  /** 05 升级 step 4: the last self-upgrade; ok false = it rolled back to `from` */
  upgrade: z.object({ from: z.string(), to: z.string(), ok: z.boolean(), error: z.string().optional() }).optional(),
  /** sessions the node still holds after a restart (its state file), so the hub can tell lost ones from live ones */
  sessions: z.array(z.object({ ref: z.string(), task_id: z.string().optional(), attempt: z.number().int().optional(), agent: z.string(), state: z.string() })).optional(),
});
export const HelloRes = z.object({
  target_sha: z.string(),             // 05: differs from `sha` → the node upgrades itself
  min_version: z.number().int(),
  tools: z.array(z.object({ name: z.string(), description: z.string(), schema: z.unknown() })).optional(),
  // W4
  /** false: the node's protocol is below min — it only upgrades, the hub sends it no work (03) */
  accepts_work: z.boolean().optional(),
  /** my login on git platforms (people.yaml): the only PR comments a CI watch treats as instructions (05) */
  owner_git: z.array(z.string()).optional(),
});

// exec/fs are only for the local node; a remote node answers 403 ※ (05). No time or output limit (§办3.4); stop = interrupt.
export const Exec = z.object({ cmd: z.string(), cwd: z.string(), env: z.record(z.string(), z.string()).optional(), stdin: z.string().optional() });
export const ExecRes = z.object({ code: z.number().int().nullable(), signal: z.string().nullable(), stdout: z.string(), stderr: z.string() });
export const FsRead = z.object({ path: z.string(), offset: z.number().int().nonnegative().optional(), len: z.number().int().positive().optional() });
export const FsReadRes = z.object({ data_b64: z.string(), total: z.number().int().nonnegative() });
export const FsWrite = z.object({ path: z.string(), data_b64: z.string(), append: z.boolean().optional() });

export type Hello = z.infer<typeof Hello>;
export type HelloRes = z.infer<typeof HelloRes>;
export type Exec = z.infer<typeof Exec>;
export type ExecRes = z.infer<typeof ExecRes>;
