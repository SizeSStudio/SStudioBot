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
});
export const HelloRes = z.object({
  target_sha: z.string(),             // 05: differs from `sha` → the node upgrades itself
  min_version: z.number().int(),
  tools: z.array(z.object({ name: z.string(), description: z.string(), schema: z.unknown() })).optional(),
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
