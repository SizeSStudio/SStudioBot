// The sources runner (03 「sources」), ported from core/src/sources.ts: a registry of SourcePlugins by kind, one poll
// per source per `every`, status and cursor in kv. Built in: git, fetch, command (plugins), feishu-mail.
// Adding a source, or handing a plugin a secret, is a config write through widening() (W1c), not something done here.
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { sourcesConf, type SourceSpec } from "../config/load.ts";
import { kvGet, kvSet } from "../db/ambient.ts";
import { home } from "../home.ts";
import { log } from "../log.ts";
import type { Lark } from "../channels/feishu/user.ts";
import { commandPoll, pluginsDir, type PluginRunner } from "./command.ts";
import { fetchPage } from "./fetch.ts";
import { gitPoll } from "./git.ts";
import { ingestItems } from "./ingest.ts";
import { feishuMail } from "./mail.ts";
import type { SourcePlugin } from "./types.ts";

const TICK_MS = 60_000;
const OVERLAP_MS = 5 * 60_000;

/** what main wires in: lark-cli for mail, and who runs command plugins (none on Linux until worker-exec has a plugin mode) */
const wiring: { lark?: Lark; runner?: PluginRunner } = {};
export function configureSources(o: { lark?: Lark; runner?: PluginRunner }) { Object.assign(wiring, o); }

const kinds = new Map<string, SourcePlugin>();
export function registerSource(p: SourcePlugin) { kinds.set(p.kind, p); }
export const sourceKind = (k: string) => kinds.get(k);
registerSource({ kind: "git", zh: "代码仓库的新提交", poll: gitPoll() });
registerSource({ kind: "fetch", zh: "网页的变化", poll: fetchPage });
registerSource({ kind: "command", zh: "插件", poll: commandPoll(() => wiring.runner) });
registerSource({ kind: "feishu-mail", zh: "飞书邮箱", poll: feishuMail(() => wiring.lark) });

/** "15m" / "2h" / "1d" → ms; at least a minute, 30 min by default */
export function everyMs(s?: unknown): number {
  const m = /^(\d+)([mhd])$/.exec(String(s ?? ""));
  const n = m ? Number(m[1]) * ({ m: 60_000, h: 3600_000, d: 86400_000 } as Record<string, number>)[m[2]!]! : 30 * 60_000;
  return Math.max(n, 60_000);
}

export interface SourceStatus { at: number; ok: boolean; n: number; err?: string; ms: number }
export const sourceStatus = (id: string): SourceStatus | null => JSON.parse(kvGet(`source.${id}.last`) ?? "null");

const inflight = new Set<string>();
/** poll one source now and record its status. `since` and the plugin cursor only move on success. */
export async function pollSource(s: SourceSpec): Promise<SourceStatus> {
  if (inflight.has(s.id)) throw new Error(`${s.id} 正在拉`);
  inflight.add(s.id);
  const t0 = Date.now();
  let st: SourceStatus;
  try {
    const kind = kinds.get(s.kind);
    if (!kind) throw new Error(`不认识的 kind：${s.kind}`);
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(s.id)) throw new Error(`源 id 不对：${s.id}`);   // it names a directory
    const dir = join(home().root, "sources", s.id);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const since = Number(kvGet(`source.${s.id}.since`) ?? t0 - 86400_000);
    const r = await kind.poll(s, { dir, get: (k) => kvGet(`source.${s.id}.${k}`), set: (k, v) => kvSet(`source.${s.id}.${k}`, v) },
      since - OVERLAP_MS, kvGet(`source.${s.id}.cursor`));
    const n = ingestItems(s, r.items);
    kvSet(`source.${s.id}.since`, String(t0));
    if (r.cursor !== undefined) kvSet(`source.${s.id}.cursor`, r.cursor);
    st = { at: t0, ok: true, n, ms: Date.now() - t0 };
    if (n) log("sources", "polled", { id: s.id, n });
  } catch (e) {
    st = { at: t0, ok: false, n: 0, err: String((e as Error)?.message ?? e).slice(0, 300), ms: Date.now() - t0 };
    log("sources", "poll failed", { id: s.id, err: st.err });
  } finally { inflight.delete(s.id); }
  kvSet(`source.${s.id}.last`, JSON.stringify(st));
  return st;
}

export async function runSourceNow(id: string): Promise<SourceStatus> {
  const s = sourcesConf().sources.find((x) => x.id === id);
  if (!s) throw new Error(`sources.yaml 里没有 ${id}`);
  return pollSource(s);
}

/** a page address without user info or query (either may carry a token) */
const bareUrl = (u?: unknown) => { try { const x = new URL(String(u)); return x.origin + x.pathname; } catch { return ""; } };

/** for clients: each configured source with its last poll */
export const sourcesView = () => ({
  dm: sourcesConf().feishu.dm, plugins: pluginsDir(),
  sources: sourcesConf().sources.map((s) => ({ id: s.id, kind: s.kind, zh: kinds.get(s.kind)?.zh ?? "?", every: s.every ?? "30m", domain: s.domain ?? "work",
    enabled: s.enabled !== false, what: s.kind === "git" ? s.repo : s.kind === "fetch" ? bareUrl(s.url) : s.kind === "feishu-mail" ? "收件箱和已发送，只读" : s.run,
    env: s.env ?? [], last: sourceStatus(s.id) })),
});

export class Sources {
  #timer?: NodeJS.Timeout;
  #busy = false;
  start() { this.#timer = setInterval(() => void this.tick(), TICK_MS); void this.tick(); }
  stop() { clearInterval(this.#timer); }
  async tick() {
    if (this.#busy) return;
    this.#busy = true;
    try {
      for (const s of sourcesConf().sources) {
        if (s.enabled === false || inflight.has(s.id)) continue;
        if (Date.now() - (sourceStatus(s.id)?.at ?? 0) < everyMs(s.every)) continue;
        await pollSource(s);
      }
    } catch (e) { log("sources", "tick failed", { err: String((e as Error)?.message ?? e).slice(0, 200) }); }
    finally { this.#busy = false; }
  }
}
