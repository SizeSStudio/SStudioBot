// Reading the config repo (§底1.3, 03 「config」). A file is re-read when its mtime or size changes, so an edit takes
// effect on the next read without a restart. Accessors return what the code should use: defaults filled in and the old
// keys 03 still accepts folded into the new ones. Nothing here writes; write.ts is the only way in.
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import { home } from "../home.ts";
import { log } from "../log.ts";
import { CONFIG_FILES, DEFAULTS, parseConfig } from "./schemas.ts";

type Obj = Record<string, any>;
const isObj = (v: unknown): v is Obj => !!v && typeof v === "object" && !Array.isArray(v);
const num = (v: unknown, d: number) => (typeof v === "number" && Number.isFinite(v) ? v : d);

let dir: string | undefined;
/** Point the accessors at a config dir (tests, restore); default is $SBOT_HOME/config. */
export function useConfigDir(d: string | undefined) { dir = d; cache.clear(); }
export const configDir = () => dir ?? home().config;

export class ConfigInvalid extends Error {
  file: string;
  constructor(file: string, msg: string) { super(`${file}: ${msg}`); this.file = file; }
}

/** Human-readable issues, one per line, with the line number in the file where yaml can tell us. */
function issues(file: string, text: string, err: { issues: { path: PropertyKey[]; message: string }[] }): string {
  return err.issues.slice(0, 8).map((i) => {
    const path = i.path.map(String);
    const key = path[path.length - 1];
    const line = key ? text.split("\n").findIndex((l) => new RegExp(`^\\s*-?\\s*${key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*:`).test(l)) : -1;
    return `- ${path.join(".") || "(根)"}${line >= 0 ? `（第 ${line + 1} 行）` : ""}：${i.message}`;
  }).join("\n");
}

/** Parse and validate one file's text. Throws ConfigInvalid with the reason (and the line, where it can). */
export function parseText(file: string, text: string): unknown {
  let v: unknown;
  try { v = parse(text); } catch (e) { throw new ConfigInvalid(file, `YAML 写错了：${String((e as Error)?.message ?? e).split("\n")[0]}`); }
  const r = parseConfig(file, v);
  if (!r.success) throw new ConfigInvalid(file, "不符合格式：\n" + issues(file, text, r.error));
  return r.data;
}

const cache = new Map<string, { stamp: string; value: unknown }>();
/**
 * The parsed file, re-read when it changes. A file that stops validating after startup (edited by hand on the machine)
 * keeps its last good value and logs once per change; at startup loadAll() refuses instead.
 */
export function cached(file: string): unknown {
  const f = join(configDir(), file);
  if (!existsSync(f)) { cache.delete(f); return undefined; }
  const st = statSync(f), stamp = `${st.mtimeMs}:${st.size}`;
  const hit = cache.get(f);
  if (hit?.stamp === stamp) return hit.value;
  try {
    const value = parseText(file, readFileSync(f, "utf8"));
    cache.set(f, { stamp, value });
    return value;
  } catch (e) {
    if (!hit) throw e;
    log("config", "file no longer valid, keeping the last good version", { file, err: String((e as Error).message).slice(0, 300) });
    cache.set(f, { stamp, value: hit.value });
    return hit.value;
  }
}

/** Startup (03 「启动顺序」): every file that exists must validate, or the hub refuses to start and says where. */
export function loadAll(): string[] {
  cache.clear();
  const bad: string[] = [];
  for (const file of CONFIG_FILES) {
    try { cached(file); } catch (e) { bad.push(String((e as Error).message)); }
  }
  if (bad.length) throw new Error(`config 有错，没启动：\n${bad.join("\n")}`);
  return CONFIG_FILES.filter((f) => existsSync(join(configDir(), f)));
}

const obj = (file: string): Obj => { const v = cached(file); return isObj(v) ? v : {}; };

// ───────── typed accessors ─────────

export type Tier = "chat" | "work" | "light" | "expert";
export const TIERS: Tier[] = ["chat", "work", "light", "expert"];

export function gateConf() {
  const g = obj("gate.yaml"), d = DEFAULTS.gate, p: Obj = isObj(g.push) ? g.push : {}, a: Obj = isObj(g.attention) ? g.attention : {};
  return {
    sensitive_words: Array.isArray(g.sensitive_words) ? (g.sensitive_words as string[]) : d.sensitive_words,
    approval_ttl_hours: num(g.approval_ttl_hours, d.approval_ttl_hours),
    send_by_hours: num(g.send_by_hours, d.send_by_hours),
    proactive_daily_cap: num(g.proactive_daily_cap, d.proactive_daily_cap),
    // Y11: improve_budget_usd is the old name
    improve_alert_usd: num(g.improve_alert_usd, num(g.improve_budget_usd, d.improve_alert_usd)),
    attention: {
      wait_minutes: num(a.wait_minutes, d.attention.wait_minutes),
      escalate_wait_minutes: num(a.escalate_wait_minutes, d.attention.escalate_wait_minutes),
      places: (isObj(a.places) ? a.places : {}) as Record<string, number>,
    },
    push: {
      quiet_minutes: num(p.quiet_minutes, d.push.quiet_minutes),
      max_delay_minutes: num(p.max_delay_minutes, d.push.max_delay_minutes),
      night: { ...d.push.night, ...(isObj(p.night) ? p.night : {}) } as typeof d.push.night,
      night_allow: Array.isArray(p.night_allow) ? (p.night_allow as string[]) : d.push.night_allow,
      presence: { ...d.push.presence, ...(isObj(p.presence) ? p.presence : {}) } as typeof d.push.presence,
      snooze_tonight: typeof p.snooze_tonight === "string" ? p.snooze_tonight : d.push.snooze_tonight,
      suggestions: { ...d.push.suggestions, ...(isObj(p.suggestions) ? p.suggestions : {}) } as typeof d.push.suggestions,
    },
  };
}

export interface TierConf { endpoint: string; model: string; price?: { in: number; out: number; cache_read?: number; cache_write?: number }; context?: number; max_tokens?: number; daily_alert?: number; fallback?: Obj }
export interface ModelsConf { endpoints: Record<string, { base_url: string; auth: "bearer" | "x-api-key"; key_ref: string }>; tiers: Partial<Record<Tier, TierConf>>; budgets?: { run_output_tokens?: number; daily_cost?: number } }
export function modelsConf(): ModelsConf {
  const m = cached("models.yaml");
  if (!isObj(m)) throw new Error("models.yaml is missing");
  return m as ModelsConf;
}
export function tierConf(t: Tier): TierConf {
  const c = modelsConf().tiers[t];
  if (!c) throw new Error(`tier ${t} not configured in models.yaml`);
  return c;
}

/** R7 alert lines (nothing is refused when one is reached). */
export function alertLines() {
  const m = isObj(cached("models.yaml")) ? (cached("models.yaml") as ModelsConf) : undefined;
  const g = obj("gate.yaml");
  // Y11: daily_budget_usd folds into budgets.daily_cost; when both are set the smaller line wins
  const costs = [m?.budgets?.daily_cost, g.daily_budget_usd].filter((x): x is number => typeof x === "number" && x > 0);
  const perTier: Partial<Record<Tier, number>> = {};
  for (const t of TIERS) {
    const v = m?.tiers?.[t]?.daily_alert;
    if (typeof v === "number") perTier[t] = v;
  }
  // Y11: expert_daily_limit is still read, as tiers.expert.daily_alert; then the old default 20
  perTier.expert ??= num(g.expert_daily_limit, DEFAULTS.models.expert_daily_alert);
  return {
    daily_cost: costs.length ? Math.min(...costs) : undefined,
    run_output_tokens: num(m?.budgets?.run_output_tokens, DEFAULTS.models.run_output_tokens),
    tier_daily: perTier,
  };
}

export interface JobSpec { every: "day" | "week" | "month"; at: string; weekday?: number; day?: number; do: string; lane?: string; text?: string; quota?: boolean; retry_hours?: number; enabled?: boolean; check?: string; [k: string]: unknown }
/** jobs.yaml; `enabled: false` = as if the line weren't there. improve's old `min_days` is ignored (Y11). */
export function jobsConf(): Record<string, JobSpec> {
  const j = obj("jobs.yaml");
  return Object.fromEntries(Object.entries(j).filter(([, v]) => isObj(v) && v.enabled !== false)) as Record<string, JobSpec>;
}
/** dream's knobs live on its job line (§读1.3) */
export function dreamConf() {
  const j: Obj = Object.values(jobsConf()).find((x) => x.do === "dream") ?? {};
  const d = DEFAULTS.dream;
  return { max_delete: num(j.max_delete, d.max_delete), max_add: num(j.max_add, d.max_add), archive_days: num(j.archive_days, d.archive_days) };
}

/** self.yaml measure (§寸8). Old top-level fade_days / see_off_after / restore_after still count; measure.* wins. */
export function measureConf() {
  const s = obj("self.yaml"), m: Obj = isObj(s.measure) ? s.measure : {}, d = DEFAULTS.measure;
  const pick = (k: keyof typeof d) => num(m[k], num(s[k], d[k] as number));
  return {
    fade_days: pick("fade_days"), see_off_after: pick("see_off_after"), restore_after: pick("restore_after"),
    settle: { ...d.settle, ...(isObj(m.settle) ? m.settle : {}) } as typeof d.settle,
    ease_flip: num(m.ease_flip, d.ease_flip), infer_min_convs: num(m.infer_min_convs, d.infer_min_convs),
    dismiss_window: num(m.dismiss_window, d.dismiss_window), breaker: num(m.breaker, d.breaker),
    stuck_minutes: num(m.stuck_minutes, d.stuck_minutes), tidy_wait_minutes: num(m.tidy_wait_minutes, d.tidy_wait_minutes),
  };
}
export const selfMonth = (): "gregorian" | "solar_term" => (obj("self.yaml").month === "solar_term" ? "solar_term" : "gregorian");

export function consoleConf() {
  const c = obj("console.yaml");
  return {
    relay: { enabled: c.relay?.enabled === true, url: typeof c.relay?.url === "string" ? (c.relay.url as string) : undefined },
    mcp_open: c.mcp_open === true,
    fcm: { enabled: c.fcm?.enabled === true },
  };
}

export function channelsConf() {
  const c = obj("channels.yaml"), f: Obj = isObj(c.feishu) ? c.feishu : {};
  return {
    outlets: { ...DEFAULTS.channels.outlets, ...(isObj(c.outlets) ? c.outlets : {}) } as Record<string, string[]>,
    feishu: { admin_chat: f.admin_chat as string | undefined, workbench_chat: f.workbench_chat as string | undefined, mode: (f.mode === "shadow" ? "shadow" : "live") as "live" | "shadow" },
  };
}

export function backupConf() {
  const b = obj("backup.yaml");
  return { recipient: typeof b.recipient === "string" ? (b.recipient as string) : undefined, to_nodes: Array.isArray(b.to_nodes) ? (b.to_nodes as string[]) : [] };
}

export interface SourceSpec { id: string; kind: string; every?: string; domain?: "work" | "personal"; enabled?: boolean; env?: string[]; [k: string]: unknown }
export function sourcesConf() {
  const s = obj("sources.yaml"), x: Obj = isObj(s.exclude) ? s.exclude : {};
  const list = (v: unknown) => (Array.isArray(v) ? (v as string[]) : []);
  return {
    feishu: { dm: s.feishu?.dm === true },
    sources: (Array.isArray(s.sources) ? s.sources : []).filter((v: Obj) => v?.id && v?.kind) as SourceSpec[],
    exclude: { chats: list(x.chats), persons: list(x.persons), mails: list(x.mails) },
  };
}

export type Activation = "always" | "when_mentioned" | "digest" | "disabled";
export const groupsConf = () => obj("groups.yaml") as { reviewed?: boolean; default?: Activation; groups?: Record<string, { name?: string; activation?: Activation; reply?: string }> };
export const reposConf = () => obj("repos.yaml") as Record<string, { url: string; branch?: string }>;
export const peopleConf = () => obj("people.yaml") as { owner?: { name?: string; ids?: { feishu?: string; wechat?: string } }; [slug: string]: unknown };
