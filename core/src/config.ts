// Paths, config files and secrets (DESIGN §1.3, §5.3).
//
// The config repo (/srv/sbot/config, git) is the source of truth; files are re-read when their mtime changes, so an
// edit takes effect on the next request without a restart. secrets.env is never handed to any agent.

import { readFileSync, statSync, existsSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";

export const HOME = process.env.SBOT_HOME ?? "/srv/sbot";
export const P = {
  home: HOME,
  db: join(HOME, "db", "sbot.db"),
  config: join(HOME, "config"),
  agentHome: join(HOME, "agent-home"),
  sessions: join(HOME, "sessions"),
  piAgentDir: join(HOME, "sessions", ".pi-agent"),
  logs: join(HOME, "logs"),
  secrets: process.env.SBOT_SECRETS ?? join(HOME, "secrets.env"),
  larkHome: process.env.SBOT_LARK_HOME ?? join(HOME, "lark"),
};

export const PROXY_PORT = Number(process.env.SBOT_PROXY_PORT ?? 7811);
export const PROXY_BASE = `http://127.0.0.1:${PROXY_PORT}/llm`;
export const TZ = process.env.SBOT_TZ ?? "Asia/Shanghai";

// chat = 总控（主对话）· work = 执行（worker、起草、镜头、dream）· light = 读（分拣、摘要、检查、搜索）· expert = 第二意见
export type Tier = "chat" | "work" | "light" | "expert";
export const TIERS: Tier[] = ["chat", "work", "light", "expert"];

export interface Price { in: number; out: number; cache_read?: number; cache_write?: number }  // USD per 1M tokens
export interface ModelsConfig {
  endpoints: Record<string, { base_url: string; auth: "bearer" | "x-api-key"; key_ref: string }>;
  tiers: Partial<Record<Tier, { endpoint: string; model: string; price?: Price; context?: number; max_tokens?: number }>>;
  budgets?: { run_output_tokens?: number; daily_cost?: number };
}
export interface PeopleConfig {
  owner: { name?: string; ids: { feishu?: string; wechat?: string } };
  [slug: string]: unknown;
}

const cache = new Map<string, { mtime: number; value: unknown }>();
function cached<T>(file: string, load: (text: string) => T, fallback?: T): T {
  if (!existsSync(file)) {
    if (fallback !== undefined) return fallback;
    throw new Error(`missing config file ${file}`);
  }
  const mtime = statSync(file).mtimeMs;
  const hit = cache.get(file);
  if (hit && hit.mtime === mtime) return hit.value as T;
  const value = load(readFileSync(file, "utf8"));
  cache.set(file, { mtime, value });
  return value;
}

export const models = (): ModelsConfig => cached(join(P.config, "models.yaml"), (t) => parse(t) as ModelsConfig);
export const people = (): PeopleConfig => cached(join(P.config, "people.yaml"), (t) => parse(t) as PeopleConfig);
export const ownerFeishu = (): string | undefined => people().owner?.ids?.feishu;
export const ownerName = (): string => people().owner?.name ?? "主人";

/** config/feishu.yaml: the bot's own chats (§3.1) */
export const feishuConf = (): { admin_chat?: string; workbench_chat?: string } =>
  cached(join(P.config, "feishu.yaml"), (t) => parse(t) ?? {}, {});

/** config/groups.yaml (§3.5): explicit per-chat settings; everything else follows the default rules */
export type Activation = "always" | "when_mentioned" | "digest" | "disabled";
export interface GroupsConfig { reviewed?: boolean; default?: Activation; groups?: Record<string, { name?: string; activation?: Activation; reply?: string }> }
export const groupsConf = (): GroupsConfig => cached(join(P.config, "groups.yaml"), (t) => parse(t) ?? {}, {});

/** config/gate.yaml (§3.5, §7.4, §9.3) with defaults */
export interface GateConfig { sensitive_words: string[]; approval_ttl_hours: number; send_by_hours: number; expert_daily_limit: number; improve_budget_usd: number }
const GATE_DEFAULTS: GateConfig = {
  sensitive_words: ["HR", "人事", "薪酬", "绩效", "财务", "法务", "董事会"], approval_ttl_hours: 12, send_by_hours: 2, expert_daily_limit: 20, improve_budget_usd: 3,
};
export const gateConf = (): GateConfig => ({ ...GATE_DEFAULTS, ...cached(join(P.config, "gate.yaml"), (t) => parse(t) ?? {}, {}) });

/** config/jobs.yaml (§9.1): periodic jobs; only the owner edits it, hot-reloaded */
export interface JobSpec { every: "day" | "week" | "month"; at: string; weekday?: number; day?: number; do: string; lane?: string; text?: string; quota?: boolean }
export const jobsConf = (): Record<string, JobSpec> => cached(join(P.config, "jobs.yaml"), (t) => parse(t) ?? {}, {});

/** knobs in gate.yaml: proactive_daily_cap (§9.3), daily_budget_usd (§9.2; falls back to models.yaml budgets.daily_cost) */
export const quietConf = () => {
  const g = cached(join(P.config, "gate.yaml"), (t) => parse(t) ?? {}, {} as any);
  let daily: number | undefined;
  try { daily = models().budgets?.daily_cost; } catch { /* models.yaml missing in tests */ }
  return { cap: Number(g.proactive_daily_cap ?? 6), budget: Number(g.daily_budget_usd ?? daily ?? 10) };
};

/** config/self.yaml (§15.9, §15.13): owner-only; month rhythm and the 送一程 thresholds */
export const selfConf = (): { month: "gregorian" | "solar_term"; see_off_after: number; restore_after: number } => {
  const s = cached(join(P.config, "self.yaml"), (t) => parse(t) ?? {}, {} as any);
  return { month: s.month === "solar_term" ? "solar_term" : "gregorian", see_off_after: Number(s.see_off_after ?? 3), restore_after: Number(s.restore_after ?? 2) };
};

/** the lens part of self.yaml (M6). Only lens.ts reads this; it goes nowhere but a network-less lens run's task dir. */
export const selfLensConf = (): { birth?: Record<string, any>; lenses: Record<string, { enabled?: boolean; profile?: Record<string, any> }> } => {
  const s = cached(join(P.config, "self.yaml"), (t) => parse(t) ?? {}, {} as any);
  return { birth: s.birth, lenses: s.lenses ?? {} };
};

/** config/repos.yaml (§4.2): repos a worker may get a copy of, and where an approved push goes */
export const reposConf = (): Record<string, { url: string; branch?: string }> => cached(join(P.config, "repos.yaml"), (t) => parse(t) ?? {}, {});

/**
 * config/worker.yaml (§4.2): how workers run. Owner-edited only, like every config file.
 *   default_mode: host | sandbox            (default host)
 *   path: [/opt/foo/bin]                    extra PATH dirs, prepended, both modes
 *   skills: [name, …] | all                 skills to enable; default = every dir under config/skills/
 *   ssh_hosts: [{ name, host, user?, port? }]   written to the host worker's ssh config (`ssh <name>`); host = tailnet IP
 *                                           (the server doesn't use MagicDNS)
 */
export interface SshHost { name: string; host: string; user?: string; port?: number }
export interface WorkerConf { default_mode?: "host" | "sandbox"; path?: string[]; skills?: string[] | "all"; ssh_hosts?: SshHost[] }
export const workerConf = (): WorkerConf => cached(join(P.config, "worker.yaml"), (t) => parse(t) ?? {}, {});

/**
 * config/sources.yaml (§17.3): Feishu DMs on / off (the observer reads them) and the other places events come from.
 * Each source: { id, kind (a SOURCE_KINDS key), every ("15m" | "2h" | "1d"), domain, enabled, …kind-specific }.
 */
export interface SourceSpec { id: string; kind: string; every?: string; domain?: "work" | "personal"; enabled?: boolean; env?: string[]; [k: string]: unknown }
export const sourcesConf = (): { feishu: { dm: boolean }; sources: SourceSpec[] } => {
  const s = cached(join(P.config, "sources.yaml"), (t) => parse(t) ?? {}, {} as any);
  return { feishu: { dm: s.feishu?.dm === true }, sources: Array.isArray(s.sources) ? s.sources.filter((x: any) => x?.id && x?.kind) : [] };
};

export function tierConf(tier: Tier) {
  const t = models().tiers[tier];
  if (!t) throw new Error(`tier ${tier} not configured in models.yaml`);
  return t;
}

/**
 * KEY=VALUE lines; # comments; optional surrounding quotes. Read by the proxy, backup, and the source poller, which
 * hands a command plugin only the names its sources.yaml entry lists under env: (§17.3). Never to a model or agent.
 */
export function secret(name: string): string | undefined {
  const all = cached(P.secrets, (text) => {
    const out: Record<string, string> = {};
    for (const line of text.split("\n")) {
      const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
      if (m) out[m[1]] = m[2].replace(/^(['"])(.*)\1$/, "$2");
    }
    return out;
  }, {} as Record<string, string>);
  return all[name];
}

export const log = (scope: string, msg: string, extra?: Record<string, unknown>) =>
  console.log(`${new Date().toISOString()} [${scope}] ${msg}${extra ? " " + JSON.stringify(extra) : ""}`);
