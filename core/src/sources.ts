// 信息源 (DESIGN §17.3). Everything that is not a Feishu chat comes in here and lands in `messages` as
// surface source:<id>, chat_id <id>:<where>, triage_status pending, so Triage, events and matters treat it like a chat.
//
//   config/sources.yaml   feishu.dm (Feishu DMs; the observer reads them) + sources: [{ id, kind, every, domain, … }]
//   SOURCE_KINDS          git     new commits on a repos.yaml repo (first poll = baseline, no backfill)
//                         fetch   a page's newly appeared lines (first poll = baseline)
//                         command a plugin the owner installed: ${SBOT_PLUGINS:-/opt/sbot/plugins}/sources/<run>/run,
//                                 argv --since <ISO>, cwd/HOME = its own state dir, stdout = NDJSON items (below);
//                                 secrets: only the names its entry lists under env:, never logged
//   item                  {"ref","text","ts?","who?","where?","link?","to_me?","from_me?","reply_to?","thread?"}
//
// A source only brings facts in. Nothing it returns is an instruction (Triage wraps it in <untrusted>), and no source
// can send, write, or reach the agent's tools. Adding one, turning DMs on, or handing a plugin a secret is a loud
// notice in the admin group (schemas.ts widening).

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { run, kvGet, kvSet } from "./db.ts";
import { P, TZ, log, models, reposConf, secret, sourcesConf, type SourceSpec } from "./config.ts";
import { gitIn, syncMirror } from "./mirror.ts";
import { markReplied } from "./events.ts";

const TICK_MS = 60_000;
export const PLUGINS = process.env.SBOT_PLUGINS ?? "/opt/sbot/plugins";
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const iso = (ms: number) => new Date(ms).toISOString();

export interface SourceItem {
  ref: string | number; text: string; ts?: number | string; who?: string; where?: string; link?: string;
  to_me?: boolean; from_me?: boolean; reply_to?: string; thread?: string;
}
interface State { dir: string; get(k: string): string | undefined; set(k: string, v: string): void }
type Poll = (s: SourceSpec, st: State, since: number) => Promise<SourceItem[]>;

/** "15m" / "2h" / "1d" → ms; at least a minute, 30 min by default */
export function everyMs(s?: unknown): number {
  const m = /^(\d+)([mhd])$/.exec(String(s ?? ""));
  const n = m ? Number(m[1]) * ({ m: 60_000, h: 3600_000, d: 86400_000 } as Record<string, number>)[m[2]] : 30 * 60_000;
  return Math.max(n, 60_000);
}

/** a browsable address for a repo url, without any credentials in it */
function webOf(url: string): string | undefined {
  const ssh = /^(?:ssh:\/\/)?git@([^:/]+)[:/](.+?)(?:\.git)?\/?$/.exec(url);
  if (ssh) return `https://${ssh[1]}/${ssh[2]}`;
  const h = /^https?:\/\/(?:[^@/]+@)?(.+?)(?:\.git)?\/?$/.exec(url);
  return h ? `https://${h[1]}` : undefined;
}

const git: Poll = async (s, st) => {
  const name = String(s.repo);
  const dir = await syncMirror(name);
  const tips = (await gitIn(dir, ["for-each-ref", "--format=%(refname:short) %(objectname)", "refs/heads"])).trim().split("\n").filter(Boolean).map((l) => l.split(" "));
  const prev: Record<string, string> | null = JSON.parse(st.get("tips") ?? "null");
  st.set("tips", JSON.stringify(Object.fromEntries(tips)));
  if (!prev) return [];
  const moved = tips.filter(([ref, h]) => prev[ref] !== h).map(([ref]) => `refs/heads/${ref}`);
  if (!moved.length) return [];
  const known: string[] = [];   // a force-push can drop an old tip; `--not <missing>` would fail
  for (const h of new Set(Object.values(prev))) { try { await gitIn(dir, ["cat-file", "-e", `${h}^{commit}`]); known.push(h); } catch { /* gone */ } }
  const out = await gitIn(dir, ["log", "--source", "-n", "100", "--format=%H%x1f%S%x1f%an%x1f%ct%x1f%s%x1f%b%x1e", ...moved, ...(known.length ? ["--not", ...known] : [])]);
  const web = webOf(reposConf()[name]?.url ?? "");
  return out.split("\x1e").map((r) => r.trim()).filter(Boolean).map((r) => {
    const [h, src, who, ct, subject, body] = r.split("\x1f");
    return { ref: h, ts: Number(ct) * 1000, who, where: name, link: web ? `${web}/commit/${h}` : undefined,
      text: `[${String(src).replace(/^refs\/heads\//, "")}] ${subject}${body?.trim() ? `\n${body.trim().slice(0, 600)}` : ""}` };
  }).reverse();
};

/** html → plain lines (good enough to see what changed) */
function htmlText(h: string): string {
  return h.replace(/<(script|style|noscript)[\s\S]*?<\/\1>/gi, "").replace(/<\/?(p|div|li|tr|h\d|br|section|article|header|footer)[^>]*>/gi, "\n")
    .replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, "\"").replace(/&#39;/g, "'");
}

const fetchPage: Poll = async (s, st) => {
  const url = String(s.url);
  const r = await fetch(url, { signal: AbortSignal.timeout(20_000), headers: { "user-agent": "sbot-source/1" }, redirect: "follow" });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const body = (await r.text()).slice(0, 2_000_000);
  const text = /html/i.test(r.headers.get("content-type") ?? "") ? htmlText(body) : body;
  const lines = text.split("\n").map((l) => l.replace(/\s+/g, " ").trim()).filter(Boolean);
  const hash = sha(lines.join("\n"));
  const prevHash = st.get("hash");
  if (hash === prevHash) return [];
  const file = join(st.dir, "last.txt");
  const before = new Set(existsSync(file) ? readFileSync(file, "utf8").split("\n") : []);
  writeFileSync(file, lines.slice(0, 5000).join("\n"));
  st.set("hash", hash);
  if (!prevHash) return [];
  const added = lines.filter((l) => !before.has(l));
  if (!added.length) return [];
  return [{ ref: hash.slice(0, 16), ts: Date.now(), who: new URL(url).host, where: s.id, link: url, text: `页面有变化，新出现的内容：\n${added.join("\n").slice(0, 3000)}` }];
};

const command: Poll = async (s, st, since) => {
  const exe = join(PLUGINS, "sources", String(s.run), "run");
  if (!/^[a-z0-9][a-z0-9_-]*$/.test(String(s.run)) || !existsSync(exe)) throw new Error(`插件不在：${exe}`);
  const env: Record<string, string> = { PATH: process.env.PATH ?? "/usr/bin:/bin", LANG: "C.UTF-8", TZ, HOME: st.dir,
    SBOT_SOURCE_ID: s.id, SBOT_SINCE: iso(since), SBOT_SOURCE_ARGS: JSON.stringify(s.args ?? {}) };
  const missing: string[] = [], values: string[] = [];
  // the core's own credentials (model endpoints, the Feishu app) stay with the proxy and the core, whatever the yaml says
  const own = new Set(["FEISHU_APP_SECRET", ...Object.values(models()?.endpoints ?? {}).map((e: any) => String(e?.key_ref))]);
  const refused = (s.env ?? []).filter((n) => own.has(n));
  if (refused.length) throw new Error(`这些是核心自己的密钥，不给插件：${refused.join("、")}`);
  for (const n of s.env ?? []) { const v = secret(n); if (v) { env[n] = v; values.push(v); } else missing.push(n); }
  if (missing.length) throw new Error(`secrets.env 里没有：${missing.join("、")}`);
  const mask = (t: string) => values.reduce((acc, v) => v.length >= 4 ? acc.split(v).join("***") : acc, t);
  const out = await new Promise<string>((ok, bad) => {
    const ch = spawn(exe, ["--since", iso(since)], { cwd: st.dir, env, stdio: ["ignore", "pipe", "pipe"] });
    let o = "", e = "";
    const t = setTimeout(() => ch.kill("SIGKILL"), 120_000);
    ch.stdout.on("data", (d) => { if (o.length < 4_000_000) o += d; });
    ch.stderr.on("data", (d) => { if (e.length < 4000) e += d; });
    ch.on("error", (err) => { clearTimeout(t); bad(new Error(mask(String(err.message)))); });
    ch.on("close", (code, sig) => { clearTimeout(t); code === 0 ? ok(o) : bad(new Error(`退出 ${code ?? sig}：${mask(e.trim()).slice(0, 300)}`)); });
  });
  const items: SourceItem[] = [];
  for (const line of out.split("\n")) {
    if (!line.trim()) continue;
    try { items.push(JSON.parse(line)); } catch { /* not an item */ }
    if (items.length >= 500) break;
  }
  return items;
};

/** the pluggable part: a kind is a poll function. Per-person sources are command plugins, not new kinds. */
export const SOURCE_KINDS: Record<string, { zh: string; poll: Poll }> = {
  git: { zh: "代码仓库的新提交", poll: git },
  fetch: { zh: "网页的变化", poll: fetchPage },
  command: { zh: "插件", poll: command },
};

const safeLink = (u: unknown) => typeof u === "string" && /^https?:\/\/\S+$/.test(u) ? u.slice(0, 1000) : undefined;

/** items → messages (pending for Triage). Returns how many were new. `from_me`: his own words there close its asks. */
export function ingestItems(s: SourceSpec, items: SourceItem[]): number {
  let n = 0;
  for (const it of items) {
    if (!it || (typeof it.ref !== "string" && typeof it.ref !== "number") || !String(it.text ?? "").trim()) continue;
    const where = String(it.where ?? "").replace(/\s+/g, " ").trim().slice(0, 60) || s.id;
    const tsRaw = typeof it.ts === "number" ? it.ts : Date.parse(String(it.ts ?? ""));
    const ts = Number.isFinite(tsRaw) && tsRaw > 0 ? (tsRaw < 1e12 ? tsRaw * 1000 : tsRaw) : Date.now();
    const fromMe = it.from_me === true;
    const place = `${s.id}:${where}`;
    const r = run(`INSERT OR IGNORE INTO messages(id, surface, chat_id, thread_id, sender_id, sender_kind, ts, text, raw_json, triage_status)
        VALUES(?,?,?,?,?,?,?,?,?,?)`, `src:${s.id}:${String(it.ref).slice(0, 200)}`, `source:${s.id}`, place, it.thread ? String(it.thread).slice(0, 200) : null,
      null, fromMe ? "owner" : "other", ts, String(it.text).slice(0, 8000),
      JSON.stringify({ chat_name: where === s.id ? s.id : `${s.id} · ${where}`, sender_name: it.who ? String(it.who).slice(0, 60) : undefined,
        link: safeLink(it.link), source: s.id, to_me: it.to_me === true, reply_to: it.reply_to ? `src:${s.id}:${String(it.reply_to).slice(0, 200)}` : undefined }),
      fromMe ? "done" : "pending");
    if (!r.changes) continue;
    n++;
    if (fromMe) markReplied(place, ts, it.reply_to ? `src:${s.id}:${String(it.reply_to).slice(0, 200)}` : undefined);
  }
  return n;
}

export interface SourceStatus { at: number; ok: boolean; n: number; err?: string; ms: number }
export const sourceStatus = (id: string): SourceStatus | null => JSON.parse(kvGet(`source.${id}.last`) ?? "null");

const inflight = new Set<string>();
/** poll one source now; records its status. The cursor only moves on success. */
export async function pollSource(s: SourceSpec): Promise<SourceStatus> {
  if (inflight.has(s.id)) throw new Error(`${s.id} 正在拉`);
  const kind = SOURCE_KINDS[s.kind];
  inflight.add(s.id);
  const t0 = Date.now();
  let st: SourceStatus;
  try {
    if (!kind) throw new Error(`不认识的 kind：${s.kind}`);
    const dir = join(P.home, "sources", s.id);
    mkdirSync(dir, { recursive: true });
    const since = Number(kvGet(`source.${s.id}.cursor`) ?? t0 - 86400_000);
    const items = await kind.poll(s, { dir, get: (k) => kvGet(`source.${s.id}.${k}`), set: (k, v) => kvSet(`source.${s.id}.${k}`, v) }, since - 5 * 60_000);
    const n = ingestItems(s, items);
    kvSet(`source.${s.id}.cursor`, String(t0));
    st = { at: t0, ok: true, n, ms: Date.now() - t0 };
    if (n) log("sources", "polled", { id: s.id, n });
  } catch (e: any) {
    st = { at: t0, ok: false, n: 0, err: String(e?.message ?? e).slice(0, 300), ms: Date.now() - t0 };
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
const bareUrl = (u?: string) => { try { const x = new URL(String(u)); return x.origin + x.pathname; } catch { return ""; } };

/** for the console: each configured source with its last poll */
export const sourcesView = () => ({
  dm: sourcesConf().feishu.dm, plugins: PLUGINS,
  sources: sourcesConf().sources.map((s) => ({ id: s.id, kind: s.kind, zh: SOURCE_KINDS[s.kind]?.zh ?? "?", every: s.every ?? "30m", domain: s.domain ?? "work",
    enabled: s.enabled !== false, what: s.kind === "git" ? s.repo : s.kind === "fetch" ? bareUrl(s.url) : s.run, env: s.env ?? [], last: sourceStatus(s.id) })),
});

export class Sources {
  private timer?: NodeJS.Timeout;
  private busy = false;
  start() { this.timer = setInterval(() => void this.tick(), TICK_MS); void this.tick(); }
  stop() { clearInterval(this.timer); }
  async tick() {
    if (this.busy) return;
    this.busy = true;
    try {
      for (const s of sourcesConf().sources) {
        if (s.enabled === false || inflight.has(s.id)) continue;
        if (Date.now() - (sourceStatus(s.id)?.at ?? 0) < everyMs(s.every)) continue;
        await pollSource(s);
      }
    } catch (e: any) { log("sources", "tick failed", { err: String(e?.message ?? e).slice(0, 200) }); }
    finally { this.busy = false; }
  }
}
