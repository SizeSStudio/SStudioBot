// Config console (DESIGN §10). Two entrances, each its own unix socket, each trusting only its own proof of identity:
//   tailnet  /run/sbot/console.sock (dir 0700 sbot): only `tailscale serve --https=8444` (root) reaches it; every request
//            must carry a Tailscale-User-Login listed in config/console.yaml owners. tailscaled replaces a forged one.
//   web      /run/sbot-web/console.sock (dir 2750 sbot:sbot-web): nginx on public 443 reaches it; identity is only the
//            password session cookie (console-web.ts). Tailscale-User-Login is ignored here: nobody replaces it.
//
//   /api/*  status (+ SSE), flow, usage, groups, config files, secrets (write-only), jobs, memory
//   /*      the static front end in core/console/
//
// Writes follow §10.3: validate (schemas.ts) → write → git commit "via console" → config_changes → note in the admin
// group; changes that loosen limits get a separate loud notice. Secret values never leave this process: the API only
// says whether a name is set.

import http from "node:http";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync, renameSync, unlinkSync, statSync, mkdirSync, chmodSync } from "node:fs";
import { join, dirname, extname, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import { all, one, run, kvGet } from "./db.ts";
import { P, feishuConf, jobsConf, models, quietConf, ownerName, log, TZ, writeSecret } from "./config.ts";
import { webConf, validSession, handleAuthPaths, WEB_LOGIN, WEB_SECRETS } from "./console-web.ts";
import { git, commitIfDirty, readPage, localStamp, editConfig } from "./memory.ts";
import { searchWiki } from "./wiki.ts";
import { rollback } from "./dream.ts";
import { sendText } from "./cards.ts";
import { activationOf, userIdentityReady } from "./observer.ts";
import { proactiveToday } from "./digest.ts";
import { SCHEMAS, CONFIG_FILES, widening } from "./schemas.ts";
import { runSourceNow, sourcesView } from "./sources.ts";
import { applyImport, exampleText, importsList, previewImport, promptText, undoImport } from "./importer.ts";
import { sourcesConf } from "./config.ts";
import type { FeishuAdapter } from "./feishu.ts";
import type { Dispatcher } from "./dispatcher.ts";
import type { Scheduler } from "./timers.ts";

export const SOCK = process.env.SBOT_CONSOLE_SOCK ?? "/run/sbot/console.sock";
export const WEB_SOCK = process.env.SBOT_CONSOLE_WEB_SOCK ?? "/run/sbot-web/console.sock";
type Entry = "tailnet" | "web";
const STATIC = join(dirname(fileURLToPath(import.meta.url)), "..", "console");
const KNOWN_SECRETS = ["FEISHU_APP_SECRET"];

export interface ConsoleDeps { feishu?: FeishuAdapter; dispatcher?: Dispatcher; scheduler?: Scheduler; startedAt: number; rev?: string }

import { HttpError, bad } from "./console-data.ts";
import * as V from "./console-data.ts";
import * as G from "./graph.ts";
const sha = (s: string) => createHash("sha256").update(s).digest("hex").slice(0, 16);
const excerpt = (s: unknown, n = 160) => { const t = String(s ?? "").replace(/\s+/g, " ").trim(); return t.length > n ? t.slice(0, n) + "…" : t; };
const pj = (s: unknown) => { try { return JSON.parse(String(s ?? "null")); } catch { return null; } };

// owner timezone offset (Asia/Shanghai has no DST, but compute it anyway)
const tzOffset = () => Date.parse(localStamp().replace(" ", "T") + ":00Z") - Math.floor(Date.now() / 60_000) * 60_000;
const startOfDay = (ms = Date.now()) => { const s = localStamp(ms); return ms - (Number(s.slice(11, 13)) * 60 + Number(s.slice(14, 16))) * 60_000 - (ms % 60_000); };

function owners(): string[] {
  const f = join(P.config, "console.yaml");
  if (!existsSync(f)) return [];
  try { return (parseYaml(readFileSync(f, "utf8"))?.owners ?? []).map((s: string) => String(s).toLowerCase()); } catch { return []; }
}

async function notifyAdmin(text: string) {
  const admin = feishuConf().admin_chat;
  if (!admin) return;
  try { await sendText(admin, text); } catch (e: any) { log("console", "admin notice failed", { err: String(e?.message ?? e).slice(0, 200) }); }
}

// ───────────── status ─────────────

let larkUser = { ready: false, at: 0 };
async function larkUserReady() {
  if (Date.now() - larkUser.at > 60_000) larkUser = { ready: await userIdentityReady(), at: Date.now() };
  return larkUser.ready;
}

async function status(d: ConsoleDeps) {
  const now = Date.now(), sod = startOfDay(now);
  const today = one("SELECT COUNT(*) n, COALESCE(SUM(cost),0) c, COALESCE(SUM(output_tokens),0) o, SUM(CASE WHEN status>=400 THEN 1 ELSE 0 END) bad FROM usage WHERE ts>=?", sod)!;
  const sched = all("SELECT note, due_at FROM timers WHERE kind='schedule' AND status='pending'");
  const jobs = Object.entries(jobsConf() ?? {}).map(([name, j]) => ({
    name, spec: j, next: sched.find((r) => r.note === name)?.due_at ?? null, last: pj(kvGet(`job.${name}.last`)),
  }));
  const sentinel = pj(kvGet("sentinel.state")) ?? {};
  const lastCommit = (() => { try { return git(P.agentHome, "log", "-1", "--format=%h\x1f%at\x1f%s").trim().split("\x1f"); } catch { return null; } })();
  const { cap, budget } = quietConf();
  return {
    now, tz: TZ, owner: ownerName(),
    core: { pid: process.pid, startedAt: d.startedAt, rev: d.rev ?? null, node: process.version, rssMb: Math.round(process.memoryUsage().rss / 1048576), busyLanes: d.dispatcher?.busyLanes ?? [] },
    feishu: d.feishu?.streams ?? {},
    lark: { user: await larkUserReady() },
    observer: {
      lastPoll: Number(kvGet("observer.cursor") ?? 0) || null, chats: one("SELECT COUNT(*) n FROM chats WHERE COALESCE(chat_mode,'')<>'p2p'")!.n,
      // groups, DMs (when on) and sources all go through Triage (§17.3)
      last24h: Object.fromEntries(all("SELECT triage_status s, COUNT(*) n FROM messages WHERE (surface IN ('feishu:group','feishu:p2p') OR surface LIKE 'source:%') AND ts>? GROUP BY 1", now - 86400_000).map((r) => [r.s, r.n])),
    },
    runs: all("SELECT id, lane, role, tier, model, started FROM runs WHERE status='running' ORDER BY started"),
    tasks: all("SELECT id, status, goal, question, started, last_output_at FROM tasks WHERE status NOT IN ('done','failed','cancelled') ORDER BY ts"),
    approvals: all("SELECT id, kind, title, ts, expires_at FROM approvals WHERE status='pending' ORDER BY id"),
    asks: one("SELECT COUNT(*) n FROM events WHERE state='open' AND level IN ('reply','decide') AND ts>=?", now - 14 * 86400_000)!.n,   // = 待办's 要你回 / 拍板
    inbox: one("SELECT SUM(CASE WHEN status='received' THEN 1 ELSE 0 END) waiting, SUM(CASE WHEN status='processing' THEN 1 ELSE 0 END) processing FROM inbox")!,
    outbox: one("SELECT SUM(CASE WHEN status IN ('queued','sending') THEN 1 ELSE 0 END) pending, SUM(CASE WHEN status IN ('failed','unknown') AND ts>? THEN 1 ELSE 0 END) failed24h FROM outbox", now - 86400_000)!,
    usage: { calls: today.n, cost: today.c, output: today.o, errors: today.bad ?? 0, budget: models().budgets?.daily_cost ?? null, alertAt: budget },
    quiet: { today: proactiveToday(), cap, held: (pj(kvGet("quiet.held")) ?? []).length + Number(one("SELECT COUNT(*) n FROM messages WHERE attn='held'")?.n ?? 0) },
    jobs,
    sentinel: { last: Number(kvGet("sentinel.last") ?? 0) || null, active: Object.keys(sentinel) },
    dream: { lastAt: Number(kvGet("dream.last_at") ?? 0) || null, report: pj(kvGet("dream.report")) },
    memory: { pages: one("SELECT COUNT(*) n FROM pages")?.n ?? 0, lastCommit },
  };
}

/** a cheap fingerprint of everything the flow view shows, for the SSE "something changed" signal */
function flowHead() {
  return [
    one("SELECT MAX(id) m FROM inbox")?.m, one("SELECT COUNT(*) n, MAX(COALESCE(ended, started)) m FROM runs")?.m,
    one("SELECT MAX(id) m, MAX(COALESCE(decided_at, ts)) d FROM approvals")?.d, one("SELECT MAX(id) m FROM outbox")?.m,
    one("SELECT MAX(COALESCE(ended, last_output_at, ts)) m FROM tasks")?.m, one("SELECT COUNT(*) n FROM messages WHERE triage_action IS NOT NULL")?.n,
    one("SELECT COUNT(*) n FROM outbox WHERE status='sent'")?.n,
  ].join(":");
}

// ───────────── flow ─────────────

function flow(before: number, limit: number) {
  const runs = all(`SELECT id, lane, role, tier, model, status, stop_reason, error, started, ended, task_id FROM runs WHERE started < ? ORDER BY started DESC LIMIT ?`, before, limit);
  const since = runs.length ? runs[runs.length - 1].started : before - 86400_000;
  const ids = runs.map((r) => r.id);
  const inIds = (sql: string) => ids.length ? all(sql.replace("(?)", `(${ids.map(() => "?").join(",")})`), ...ids) : [];
  const inbox = inIds("SELECT id, run_id, lane, kind, source, status, payload_json, ts FROM inbox WHERE run_id IN (?)");
  const outbox = inIds("SELECT id, run_id, channel, kind, status, as_identity, payload, error, ts FROM outbox WHERE run_id IN (?)");
  const appr = inIds("SELECT id, run_id, kind, title, status, ts, decided_at FROM approvals WHERE run_id IN (?)");
  const cost = inIds("SELECT run_id, COUNT(*) calls, SUM(cost) cost, SUM(input_tokens) i, SUM(output_tokens) o, SUM(cache_read) cr FROM usage WHERE run_id IN (?) GROUP BY run_id");
  const items: any[] = runs.map((r) => ({
    type: "run", ts: r.started, ...r,
    usage: cost.find((c) => c.run_id === r.id) ?? null,
    inputs: inbox.filter((i) => i.run_id === r.id).map((i) => ({ id: i.id, kind: i.kind, source: i.source, status: i.status, ts: i.ts, text: excerpt(pj(i.payload_json)?.text, 240) })),
    outputs: outbox.filter((o) => o.run_id === r.id).map((o) => ({ id: o.id, channel: o.channel, kind: o.kind, status: o.status, as: o.as_identity, error: o.error, ts: o.ts, text: excerpt(outText(o.payload), 240) })),
    approvals: appr.filter((a) => a.run_id === r.id),
  }));
  // things that happen outside conversational runs
  for (const i of all("SELECT id, lane, kind, source, status, payload_json, ts FROM inbox WHERE run_id IS NULL AND ts>=? AND ts<? ORDER BY ts DESC LIMIT 50", since, before))
    items.push({ type: "event", ts: i.ts, id: i.id, lane: i.lane, kind: i.kind, source: i.source, status: i.status, text: excerpt(pj(i.payload_json)?.text, 240) });
  const triage = all(`SELECT id, chat_id, sender_kind, ts, text, raw_json, triage_status, triage_action, triage_note, attn FROM messages
    WHERE surface='feishu:group' AND ts>=? AND ts<? ORDER BY ts DESC LIMIT 120`, since, before);
  for (const m of triage) {
    const raw = pj(m.raw_json) ?? {};
    items.push({ type: "message", ts: m.ts, id: m.id, chat: raw.chat_name || m.chat_id, sender: raw.sender_name ?? m.sender_kind, senderKind: m.sender_kind,
      status: m.triage_status, action: m.triage_action, attn: m.attn, note: m.triage_note, text: excerpt(m.text, 200), link: raw.link });
  }
  for (const t of all("SELECT id, status, goal, tier, repo, started, ended, error, ts FROM tasks WHERE ts>=? AND ts<?", since, before))
    items.push({ type: "task", ...t, goal: excerpt(t.goal, 200) });
  for (const a of all("SELECT id, kind, title, status, ts, decided_at, task_id FROM approvals WHERE run_id IS NULL AND ts>=? AND ts<?", since, before))
    items.push({ type: "approval", ...a });
  items.sort((a, b) => b.ts - a.ts);
  return { items, next: runs.length === limit ? since : null };
}

function outText(payload: string): string {
  const p = pj(payload);
  if (!p || typeof p !== "object") return payload;
  return p.text ?? p.markdown ?? p.content ?? JSON.stringify(p).slice(0, 400);
}

/** one run in full: inputs, the model's steps from the pi session file (between start and end), outputs, usage */
function runDetail(id: string) {
  const r = one("SELECT * FROM runs WHERE id=?", id);
  if (!r) throw bad("no such run", 404);
  const steps: any[] = [];
  if (r.session_ref && r.role !== "worker" && existsSync(r.session_ref)) {
    const t0 = (r.started ?? 0) - 2000, t1 = (r.ended ?? Date.now()) + 2000;
    for (const line of readFileSync(r.session_ref, "utf8").split("\n")) {
      if (!line.trim()) continue;
      const e = pj(line);
      if (e?.type !== "message") continue;
      const ts = Date.parse(e.timestamp);
      if (ts < t0 || ts > t1) continue;
      const m = e.message;
      if (m.role === "system") continue;
      const content = typeof m.content === "string" ? [{ type: "text", text: m.content }] : m.content ?? [];
      for (const c of content) {
        if (c.type === "text" && c.text?.trim()) steps.push({ ts, role: m.role === "toolResult" ? "tool" : m.role, kind: m.role === "toolResult" ? "result" : "text", tool: m.toolName, error: m.isError, text: c.text.slice(0, 6000) });
        else if (c.type === "thinking" && c.thinking?.trim()) steps.push({ ts, role: m.role, kind: "thinking", text: c.thinking.slice(0, 4000) });
        else if (c.type === "toolCall") steps.push({ ts, role: m.role, kind: "call", tool: c.name, text: JSON.stringify(c.arguments ?? {}, null, 1).slice(0, 4000) });
      }
      if (m.role === "assistant" && m.usage) steps.push({ ts, role: "meta", kind: "usage", text: `${m.model ?? ""} · in ${m.usage.input} / out ${m.usage.output} / cache ${m.usage.cacheRead} · ${m.durationMs ?? "?"} ms` });
    }
  }
  return {
    run: { ...r, session_ref: r.session_ref ? r.session_ref.split("/").pop() : null },
    inputs: all("SELECT id, kind, source, status, ts, payload_json FROM inbox WHERE run_id=? ORDER BY id", id).map((i) => ({ ...i, payload_json: undefined, text: String(pj(i.payload_json)?.text ?? "") })),
    outputs: all("SELECT id, channel, kind, status, as_identity, attempts, error, sent_msg_id, ts, payload FROM outbox WHERE run_id=? ORDER BY id", id).map((o) => ({ ...o, payload: undefined, text: outText(o.payload) })),
    approvals: all("SELECT id, kind, title, status, draft, final_text, ts, decided_at FROM approvals WHERE run_id=?", id),
    usage: all("SELECT ts, tier, model, requester_id, input_tokens, output_tokens, cache_read, cache_write, cost, status, ms FROM usage WHERE run_id=? ORDER BY ts", id),
    steps,
  };
}

// ───────────── usage ─────────────

function usage(days: number) {
  const off = tzOffset(), from = startOfDay() - (days - 1) * 86400_000, sod = startOfDay();
  const day = `strftime('%Y-%m-%d', (ts + ${off}) / 1000, 'unixepoch')`;
  return {
    days: all(`SELECT ${day} d, tier, COUNT(*) calls, COALESCE(SUM(cost),0) cost, COALESCE(SUM(input_tokens),0) i, COALESCE(SUM(output_tokens),0) o, COALESCE(SUM(cache_read),0) cr
      FROM usage WHERE ts>=? GROUP BY 1, 2 ORDER BY 1`, from),
    byRequester: all(`SELECT COALESCE(requester_id,'?') who, COUNT(*) calls, COALESCE(SUM(cost),0) cost FROM usage WHERE ts>=? GROUP BY 1 ORDER BY cost DESC`, from)
      .reduce((acc: any[], r) => { const who = String(r.who).replace(/[:_].*$/, ""); const x = acc.find((a) => a.who === who); if (x) { x.calls += r.calls; x.cost += r.cost; } else acc.push({ ...r, who }); return acc; }, [])
      .sort((a: any, b: any) => b.cost - a.cost),
    byModel: all(`SELECT model, tier, COUNT(*) calls, COALESCE(SUM(cost),0) cost, COALESCE(SUM(output_tokens),0) o, AVG(ms) ms, SUM(CASE WHEN status>=400 THEN 1 ELSE 0 END) errors FROM usage WHERE ts>=? GROUP BY 1, 2 ORDER BY cost DESC`, from),
    hours: all(`SELECT CAST(strftime('%H', (ts + ${off}) / 1000, 'unixepoch') AS INTEGER) h, tier, COUNT(*) calls, COALESCE(SUM(cost),0) cost FROM usage WHERE ts>=? GROUP BY 1, 2`, sod),
    budget: models().budgets?.daily_cost ?? null,
    from, to: Date.now(),
  };
}

// ───────────── groups ─────────────

function groups() {
  const counts = new Map(all("SELECT chat_id, COUNT(*) n, MAX(ts) last FROM messages WHERE surface='feishu:group' AND ts>? GROUP BY chat_id", Date.now() - 7 * 86400_000).map((r) => [r.chat_id, r]));
  return all("SELECT chat_id, name, external, muted, chat_mode FROM chats WHERE COALESCE(chat_mode,'')<>'p2p'").map((c) => {   // DMs: sources.yaml
    const { act, why } = activationOf(c.chat_id, c.name);
    const k = counts.get(c.chat_id);
    return { id: c.chat_id, name: c.name, external: !!c.external, muted: !!c.muted, act, why, n7: k?.n ?? 0, last: k?.last ?? null };
  }).sort((a, b) => b.n7 - a.n7 || (b.last ?? 0) - (a.last ?? 0) || String(a.name).localeCompare(String(b.name), "zh"));
}

async function setGroup(chatId: string, act: string) {
  if (!/^oc_[A-Za-z0-9]+$/.test(chatId)) throw bad("bad chat id");
  if (!["always", "when_mentioned", "digest", "disabled"].includes(act)) throw bad("bad activation");
  const c = one("SELECT name FROM chats WHERE chat_id=?", chatId);
  const before = activationOf(chatId).act;
  editConfig("groups.yaml", (doc) => {
    if (doc.getIn(["groups", chatId, "activation"]) === act) return undefined;
    doc.setIn(["groups", chatId], doc.createNode({ name: c?.name ?? "", activation: act }));
    return `${c?.name || chatId} → ${act}`;
  }, "console");
  const rank: Record<string, number> = { disabled: 0, digest: 1, when_mentioned: 2, always: 3 };
  if (rank[act] > rank[before]) void notifyAdmin(`⚠️ **放宽了群观察**（控制台）\n- ${c?.name || chatId}：${before} → ${act}`);
  return activationOf(chatId);
}

// ───────────── config files ─────────────

function configFile(file: string) {
  if (!CONFIG_FILES.includes(file)) throw bad("unknown config file", 404);
  const f = join(P.config, file);
  // a file he hasn't made yet opens on its commented template (e.g. sources.yaml), so he starts from the examples
  const seed = join(STATIC, "..", "seed", "config", file);
  const text = existsSync(f) ? readFileSync(f, "utf8") : file !== "people.yaml" && file !== "models.yaml" && existsSync(seed) ? readFileSync(seed, "utf8") : "";
  let history: { sha: string; at: number; subject: string }[] = [];
  try {
    history = git(P.config, "log", "-n", "12", "--format=%h\x1f%at\x1f%s", "--", file).trim().split("\n").filter(Boolean)
      .map((l) => { const [s, at, subject] = l.split("\x1f"); return { sha: s, at: Number(at) * 1000, subject }; });
  } catch { /* new file */ }
  return { file, text, hash: sha(text), exists: existsSync(f), history };
}

async function saveConfig(file: string, text: string, hash: string) {
  const cur = configFile(file);
  if (cur.hash !== hash) throw bad("这个文件在你打开之后被改过了（卡片、命令或别处）。刷新后再改。", 409);
  if (text === cur.text) return { ...cur, changed: false };
  if (text.length > 200_000) throw bad("too large");
  let parsed: unknown;
  try { parsed = parseYaml(text); } catch (e: any) { throw bad(`YAML 写错了：${String(e?.message ?? e).split("\n")[0]}`); }
  const schema = SCHEMAS[file];
  const res = schema.safeParse(parsed ?? (file === "jobs.yaml" || file === "repos.yaml" ? null : {}));
  if (!res.success) throw bad("不符合格式：\n" + res.error.issues.slice(0, 8).map((i: any) => `- ${i.path.join(".") || "(根)"}：${i.message}`).join("\n"));
  if (file === "console.yaml" && !(parsed as any).owners.map((s: string) => s.toLowerCase()).some((o: string) => owners().includes(o)))
    throw bad("不能把自己移出 owners（那样就再也进不来了）");
  const wide = widening(file, cur.text ? parseYaml(cur.text) : {}, parsed);
  writeFileSync(join(P.config, file), text);
  commitIfDirty(P.config, `${file}: edit (via console)`);
  let diff = "";
  try { diff = git(P.config, "show", "--format=", "--unified=0", "--no-color", "HEAD", "--", file).split("\n").filter((l) => /^[+-]/.test(l) && !/^(\+\+\+|---)/.test(l)).join("\n"); } catch { /* */ }
  run("INSERT INTO config_changes(ts, file, diff, source) VALUES(?,?,?,?)", Date.now(), file, diff.slice(0, 4000), "console");
  log("console", "config saved", { file, lines: diff.split("\n").length });
  const lines = diff.split("\n").slice(0, 24).map((l) => l.slice(0, 140));
  // §15.9: self.yaml holds birth data; the admin group (Feishu) only hears that it changed
  void notifyAdmin(file === "self.yaml" ? `⚙️ **控制台改了 self.yaml**（${diff.split("\n").length} 行；私人内容，不在飞书里显示，去控制台看历史）`
    : `⚙️ **控制台改了 ${file}**\n\`\`\`\n${lines.join("\n")}${diff.split("\n").length > 24 ? "\n…" : ""}\n\`\`\``)
    .then(() => wide.length ? notifyAdmin(`⚠️ **放宽了限制**（控制台，${file}）\n${wide.map((w) => `- ${w}`).join("\n")}`) : undefined);
  return { ...configFile(file), changed: true, widened: wide };
}

function setTierModel(tier: string, model: string) {
  if (!/^[\w./:@-]{2,120}$/.test(model)) throw bad("模型名不对");
  let changed = false;
  editConfig("models.yaml", (doc) => {
    if (doc.getIn(["tiers", tier, "model"]) === model) return undefined;
    doc.setIn(["tiers", tier, "model"], model); changed = true;
    return `${tier} → ${model}`;
  }, "console");
  if (changed) void notifyAdmin(`⚙️ 控制台把 **${tier}** 档的模型换成 \`${model}\`（下一次调用起生效）`);
  return configFile("models.yaml");
}

function tiers() {
  const m = models(), sod = startOfDay();
  const used = all("SELECT tier, COUNT(*) calls, COALESCE(SUM(cost),0) cost, AVG(ms) ms, SUM(CASE WHEN status>=400 THEN 1 ELSE 0 END) errors FROM usage WHERE ts>=? GROUP BY tier", sod);
  return {
    tiers: Object.entries(m.tiers ?? {}).map(([name, t]: [string, any]) => ({ name, endpoint: t.endpoint, model: t.model, price: t.price ?? null, today: used.find((u) => u.tier === name) ?? null })),
    endpoints: Object.entries(m.endpoints ?? {}).map(([name, e]: [string, any]) => ({ name, auth: e.auth, key_ref: e.key_ref, base_url: /^secret:/.test(e.base_url) ? e.base_url : e.base_url.replace(/\/\/([^/]+).*/, "//$1/…") })),
    budgets: m.budgets ?? {},
  };
}

// ───────────── secrets (write-only) ─────────────

function secretNames(): { name: string; set: boolean; usedBy: string[] }[] {
  const text = existsSync(P.secrets) ? readFileSync(P.secrets, "utf8") : "";
  const set = new Set([...text.matchAll(/^\s*([A-Z][A-Z0-9_]*)\s*=\s*\S/gm)].map((m) => m[1]));
  const used = new Map<string, string[]>();
  const use = (n: string, by: string) => used.set(n, [...(used.get(n) ?? []), by]);
  try {
    for (const [name, e] of Object.entries(models().endpoints ?? {})) {
      use(e.key_ref, `端点 ${name} 的 key`);
      const m = /^secret:([A-Z0-9_]+)$/.exec(e.base_url ?? "");
      if (m) use(m[1], `端点 ${name} 的地址`);
    }
  } catch { /* models.yaml broken */ }
  use("FEISHU_APP_SECRET", "飞书直连 API（卡片流式更新快，不用 lark-cli）");
  try { for (const s of sourcesConf().sources) for (const n of s.env ?? []) use(n, `信息源 ${s.id} 的插件`); } catch { /* sources.yaml broken */ }
  const names = new Set([...set, ...used.keys(), ...KNOWN_SECRETS]);
  return [...names].sort().map((name) => ({ name, set: set.has(name), usedBy: used.get(name) ?? [] }));
}

async function setSecret(name: string, value: string) {
  if (!/^[A-Z][A-Z0-9_]{1,63}$/.test(name)) throw bad("名字只能是大写字母、数字、下划线");
  if (typeof value !== "string" || !value.trim() || value.length > 8192 || /[\r\n\0]/.test(value)) throw bad("值必须是一行、非空");
  if (WEB_SECRETS.includes(name)) throw bad("这个密钥由服务器上的 console-passwd 设置（存的是哈希），不在这里填");
  const had = writeSecret(name, value.trim());
  run("INSERT INTO config_changes(ts, file, diff, source) VALUES(?,?,?,?)", Date.now(), "secrets.env", `${had ? "updated" : "added"} ${name}`, "console");
  log("console", "secret written", { name, had });
  void notifyAdmin(`🔑 控制台${had ? "更新" : "新增"}了密钥 **${name}**（值不显示，也不进 git）`);
  return secretNames();
}

// ───────────── memory ─────────────

function memoryLog(limit: number) {
  const out = git(P.agentHome, "log", "-n", String(limit), "--format=\x1e%h\x1f%at\x1f%s", "--name-only");
  return out.split("\x1e").filter((s) => s.trim()).map((block) => {
    const [head, ...files] = block.trim().split("\n");
    const [s, at, subject] = head.split("\x1f");
    return { sha: s, at: Number(at) * 1000, subject, files: files.filter(Boolean), dream: subject.startsWith("dream:"), revert: subject.startsWith("Revert ") };
  });
}
function memoryCommit(s: string) {
  if (!/^[0-9a-f]{6,40}$/.test(s)) throw bad("bad sha");
  const text = git(P.agentHome, "show", "--no-color", "--format=%h%x1f%at%x1f%B%x1e", s);
  const [meta, diff] = text.split("\x1e");
  const [h, at, body] = meta.split("\x1f");
  return { sha: h, at: Number(at) * 1000, message: body.trim(), diff: diff.length > 80_000 ? diff.slice(0, 80_000) + "\n…(truncated)" : diff };
}

// ───────────── http plumbing ─────────────

function body(req: http.IncomingMessage): Promise<any> {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => { size += c.length; if (size > 512_000) { reject(bad("body too large", 413)); req.destroy(); } else chunks.push(c); });
    req.on("end", () => { try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {}); } catch { reject(bad("bad JSON")); } });
    req.on("error", reject);
  });
}

const TYPES: Record<string, string> = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png", ".json": "application/json" };
const SEC_HEADERS = {
  "X-Frame-Options": "DENY", "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer",
  "Content-Security-Policy": "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'",
};
// public entrance: with no-referrer a browser sends `Origin: null` on same-origin writes, and there the Origin check is
// part of the gate; same-origin still never sends a Referer to another site
const WEB_SEC_HEADERS = { ...SEC_HEADERS, "Referrer-Policy": "same-origin" };

function serveStatic(path: string, res: http.ServerResponse, H: Record<string, string> = SEC_HEADERS) {
  const rel = normalize(path === "/" ? "/index.html" : path).replace(/^(\.\.[/\\])+/, "");
  let f = join(STATIC, rel);
  if (!f.startsWith(STATIC) || !existsSync(f) || statSync(f).isDirectory()) {
    // a missing asset is a 404 (a stale module import must fail loudly, not get HTML); only route-like paths fall back to the shell
    if (extname(rel) && rel !== "/index.html") { res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8", ...H }); res.end("not found"); return; }
    f = join(STATIC, "index.html");
  }
  res.writeHead(200, { "Content-Type": TYPES[extname(f)] ?? "application/octet-stream", "Cache-Control": "no-cache", ...H });
  res.end(readFileSync(f));
}

export function startConsole(d: ConsoleDeps): { tailnet: http.Server; web: http.Server | null; close(): void } {
  const handler = (entry: Entry) => async (req: http.IncomingMessage, res: http.ServerResponse) => {
    const url = new URL(req.url ?? "/", "http://console");
    const H = entry === "web" ? WEB_SEC_HEADERS : SEC_HEADERS;
    const json = (status: number, data: unknown) => { res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...H }); res.end(JSON.stringify(data)); };
    try {
      let login: string;
      if (entry === "tailnet") {
        login = String(req.headers["tailscale-user-login"] ?? "").toLowerCase();
        if (!login || !owners().includes(login)) {
          log("console", "forbidden", { login: login ? login.replace(/(.).*@/, "$1…@") : "(none)", path: url.pathname });
          res.writeHead(403, { "Content-Type": "text/plain; charset=utf-8", ...SEC_HEADERS });
          return res.end(login ? "403：这个 Tailscale 账号不在 config/console.yaml 的 owners 里。" : "403：只能经 tailscale serve 访问。");
        }
      } else {
        // only the session cookie counts; Tailscale-User-Login and every other header from nginx is ignored
        const w = webConf();
        if (!w) { res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8", ...H }); return res.end("not found"); }
        if (url.pathname === "/_login" || url.pathname === "/_auth" || url.pathname === "/_logout") return await handleAuthPaths(req, res, url.pathname, w, notifyAdmin);
        if (!validSession(req.headers.cookie, w.key)) {
          if (url.pathname.startsWith("/api/")) return json(401, { error: "登录过期了，重新登录。" });
          res.writeHead(303, { Location: "/_login", "Cache-Control": "no-store", ...H });
          return res.end();
        }
        // on top of SameSite=Strict and the x-sbot-console header below: a write must come from our own page
        if ((req.method ?? "GET") !== "GET" && req.headers.origin !== w.origin) {
          log("console", "forbidden", { entry, why: "origin", path: url.pathname });
          return json(403, { error: "403：Origin 不对。" });
        }
        login = WEB_LOGIN;
      }
      if (!url.pathname.startsWith("/api/")) return serveStatic(url.pathname, res, H);
      const method = req.method ?? "GET";
      // access log for API calls (method, path, status, ms; never bodies). SSE and the 3 s status poll are skipped.
      if (url.pathname !== "/api/events") { const t0 = Date.now(); res.on("close", () => log("console", "api", { method, path: url.pathname, status: res.statusCode, ms: Date.now() - t0, done: res.writableFinished })); }
      if (method !== "GET" && req.headers["x-sbot-console"] !== "1") throw bad("missing x-sbot-console header", 403);   // CSRF: forces a CORS preflight we never answer
      const p = url.pathname.slice(4);
      let m: RegExpExecArray | null;

      if (p === "/me") return json(200, { login, entry, owner: ownerName() });
      if (p === "/status") return json(200, await status(d));
      if (p === "/events") {
        res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-store", Connection: "keep-alive", "X-Accel-Buffering": "no" });
        let lastStatus = "", lastFlow = "";
        const push = async () => {
          try {
            const s = JSON.stringify(await status(d));
            if (s !== lastStatus) { lastStatus = s; res.write(`event: status\ndata: ${s}\n\n`); }
            const f = flowHead();
            if (f !== lastFlow) { lastFlow = f; res.write(`event: flow\ndata: ${JSON.stringify(f)}\n\n`); }
            res.write(`: ping\n\n`);
          } catch (e: any) { log("console", "sse push failed", { err: String(e?.message ?? e).slice(0, 200) }); }
        };
        await push();
        const t = setInterval(push, 3000);
        req.on("close", () => clearInterval(t));
        return;
      }
      if (p === "/flow") return json(200, flow(Number(url.searchParams.get("before")) || Date.now() + 1, Math.min(Number(url.searchParams.get("limit")) || 40, 200)));
      if ((m = /^\/run\/([\w.-]+)$/.exec(p))) return json(200, runDetail(m[1]));
      if ((m = /^\/task\/([\w.-]+)$/.exec(p))) {
        const t = one("SELECT * FROM tasks WHERE id=?", m[1]);
        if (!t) throw bad("no such task", 404);
        return json(200, { task: t, runs: all("SELECT id, status, stop_reason, error, started, ended FROM runs WHERE task_id=? ORDER BY started", m[1]),
          approvals: all("SELECT id, kind, title, status, ts, decided_at FROM approvals WHERE task_id=?", m[1]),
          usage: one("SELECT COUNT(*) calls, COALESCE(SUM(cost),0) cost FROM usage WHERE task_id=? OR run_id IN (SELECT id FROM runs WHERE task_id=?)", m[1], m[1]) });
      }
      if ((m = /^\/approval\/(\d+)$/.exec(p))) {
        const a = one("SELECT * FROM approvals WHERE id=?", Number(m[1]));
        if (!a) throw bad("no such approval", 404);
        return json(200, a);
      }
      // ── 待办 ──
      if (p === "/inbox") return json(200, V.inbox());
      if ((m = /^\/approval\/(\d+)\/full$/.exec(p))) return json(200, V.approvalFull(Number(m[1])));
      if ((m = /^\/approval\/(\d+)\/decide$/.exec(p)) && method === "POST") { const b = await body(req); return json(200, await V.decide(Number(m[1]), String(b.d), Number(b.v), b.note ? String(b.note) : undefined)); }
      if ((m = /^\/approval\/(\d+)\/revise$/.exec(p)) && method === "POST") { const b = await body(req); return json(200, await V.revise(Number(m[1]), String(b.note ?? ""))); }
      if ((m = /^\/approval\/(\d+)\/edit$/.exec(p)) && method === "POST") { const b = await body(req); return json(200, await V.edit(Number(m[1]), Number(b.v), String(b.text ?? ""))); }
      if ((m = /^\/task\/([\w.-]+)\/reply$/.exec(p)) && method === "POST") { const b = await body(req); return json(200, V.taskReply(m[1], String(b.text ?? ""))); }
      if ((m = /^\/task\/([\w.-]+)\/cancel$/.exec(p)) && method === "POST") return json(200, V.taskCancel(m[1]));
      if ((m = /^\/event\/(\d+)$/.exec(p)) && method === "POST") { const b = await body(req); return json(200, V.eventUpdate(Number(m[1]), b)); }
      // ── 会话 ──
      if (p === "/lanes") return json(200, V.lanes(Math.min(Number(url.searchParams.get("days")) || 14, 90)));
      if (p === "/lane") return json(200, V.laneRuns(String(url.searchParams.get("key") ?? ""), Number(url.searchParams.get("before")) || Date.now() + 1, Math.min(Number(url.searchParams.get("limit")) || 20, 100)));
      if ((m = /^\/run\/([\w.-]+)\/requests$/.exec(p))) return json(200, V.runRequests(m[1]));
      if ((m = /^\/request\/(\d+)$/.exec(p))) return json(200, V.requestDetail(Number(m[1]), url.searchParams.get("raw") === "1"));
      // ── 生活 ──
      if (p === "/life/meta") return json(200, V.lifeMeta());
      if (p === "/life/timeline") return json(200, V.lifeTimeline(url.searchParams));
      if (p === "/life/note" && method === "POST") { const b = await body(req); return json(200, V.lifeNote(String(b.text ?? ""), b.domain ? String(b.domain) : undefined)); }
      if (p === "/life/matters") return json(200, V.matters());
      if ((m = /^\/life\/matter\/(\d+)$/.exec(p))) return json(200, V.matter(Number(m[1])));
      if ((m = /^\/life\/matter\/(\d+)\/regroup$/.exec(p)) && method === "POST") return json(200, V.matterRegroup(Number(m[1]), await body(req)));
      if (p === "/life/review") return json(200, V.matterReview());
      if ((m = /^\/life\/review\/(\d+)$/.exec(p)) && method === "POST") { const b = await body(req); return json(200, V.reviewAct(Number(m[1]), String(b.a ?? ""))); }
      if ((m = /^\/life\/op\/(\d+)\/undo$/.exec(p)) && method === "POST") return json(200, V.opUndo(Number(m[1])));
      if (p === "/life/topics") return json(200, V.topics());
      if (p === "/life/topic") return json(200, V.topicEvents(String(url.searchParams.get("t") ?? "")));
      if (p === "/life/topic/link" && method === "POST") { const b = await body(req); return json(200, V.topicLink(String(b.topic ?? ""), Number(b.matter_id))); }
      // §17.4 导入: preview never writes memory; apply / undo commit agent-home and tell the admin group
      if (p === "/import/prompt") return json(200, { prompt: promptText(), example: exampleText() });
      if (p === "/imports") return json(200, importsList());
      if (p === "/import/preview" && method === "POST") {
        const b = await body(req);
        try { return json(200, await previewImport(String(b.text ?? ""), b.from ? String(b.from) : undefined)); } catch (e: any) { throw bad(String(e?.message ?? e)); }
      }
      if (p === "/import/apply" && method === "POST") {
        const b = await body(req);
        let r;
        try { r = applyImport(String(b.sha ?? "")); } catch (e: any) { throw bad(String(e?.message ?? e)); }
        void notifyAdmin(`📥 控制台导入 #${r.id}：人 ${r.people_new.length + r.people_updated.length}、事 ${r.matters_new.length + r.matters_merged.length}、事件 ${r.events}（等你的 ${r.open}）`);
        return json(200, r);
      }
      if ((m = /^\/import\/(\d+)\/undo$/.exec(p)) && method === "POST") {
        let r;
        try { r = undoImport(Number(m[1])); } catch (e: any) { throw bad(String(e?.message ?? e)); }
        void notifyAdmin(`↩️ 控制台撤销了导入 #${m[1]}`);
        return json(200, r);
      }
      // §18 人 / 因缘: persons and relations are memory (no config, no permission), so no admin notice
      const gerr = <T,>(f: () => T): T => { try { return f(); } catch (e: any) { if (e instanceof HttpError) throw e; throw bad(String(e?.message ?? e)); } };
      if (p === "/life/people") return json(200, { people: G.peopleList(String(url.searchParams.get("q") ?? "").trim(), String(url.searchParams.get("circle") ?? "")), circles: G.CIRCLES, rels: G.REL_PRESETS });
      if ((m = /^\/life\/person\/(\d+)$/.exec(p))) {
        if (method === "POST") { const b = await body(req); return json(200, gerr(() => G.setPerson(Number(m![1]), b))); }
        return json(200, gerr(() => G.personDetail(Number(m![1]))));
      }
      if (p === "/life/person/merge" && method === "POST") { const b = await body(req); return json(200, gerr(() => G.mergePersons(Number(b.from), Number(b.into)))); }
      if (p === "/life/person/split" && method === "POST") { const b = await body(req); return json(200, gerr(() => G.splitAlias(Number(b.from), String(b.kind ?? ""), String(b.alias ?? "")))); }
      if (p === "/life/relation" && method === "POST") { const b = await body(req); return json(200, gerr(() => G.addRelation(Number(b.a), Number(b.b), String(b.rel ?? ""), { conf: "EXTRACTED", src: "owner@console" }))); }
      if ((m = /^\/life\/relation\/(\d+)$/.exec(p)) && method === "POST") { const b = await body(req); return json(200, gerr(() => G.setRelation(Number(m![1]), b.act === "confirm" ? "confirm" : "drop"))); }
      if (p === "/life/graph") {
        const focus = String(url.searchParams.get("focus") ?? "");
        return json(200, gerr(() => focus ? G.egoView(focus, Number(url.searchParams.get("depth")) === 2 ? 2 : 1)
          : G.circleView(Math.min(Number(url.searchParams.get("limit")) || 60, 200), url.searchParams.get("matters") === "1")));
      }
      if (p === "/life/graph/path") return json(200, gerr(() => G.pathBetween(String(url.searchParams.get("from") ?? ""), String(url.searchParams.get("to") ?? ""))));
      if (p === "/life/yinyuan") return json(200, G.observations());
      if (p === "/life/graph/rebuild" && method === "POST") return json(200, G.rebuildGraph());
      if (p === "/life/outlooks") return json(200, V.outlooks());
      if (p === "/life/self") return json(200, V.selfItems());
      if ((m = /^\/life\/self\/(\d+)$/.exec(p)) && method === "POST") { const b = await body(req); return json(200, V.markSelf(Number(m[1]), String(b.status), b.note ? String(b.note) : undefined)); }
      if (p === "/life/readings") return json(200, V.readings());
      if ((m = /^\/life\/reading\/(\d+)$/.exec(p))) return json(200, V.reading(Number(m[1])));
      if (p === "/life/reviews") return json(200, V.reviews());
      if ((m = /^\/life\/review\/(\d+)$/.exec(p))) return json(200, V.review(Number(m[1])));
      // ── 它自己 ──
      if (p === "/self/health") return json(200, V.healthTrend(Math.min(Number(url.searchParams.get("weeks")) || 8, 26)));
      if (p === "/self/proposals") return json(200, V.proposals());
      if ((m = /^\/self\/proposal\/(\d+)$/.exec(p))) return json(200, V.proposal(Number(m[1])));
      if ((m = /^\/self\/proposal\/(\d+)\/rollback$/.exec(p)) && method === "POST") return json(200, await V.rollbackProposal(Number(m[1])));
      if (p === "/approvals") return json(200, all(`SELECT id, kind, title, status, origin_lane, as_identity, ts, decided_at, expires_at, task_id, run_id FROM approvals ${url.searchParams.get("all") ? "" : "WHERE status='pending'"} ORDER BY id DESC LIMIT 200`));
      if (p === "/usage") return json(200, usage(Math.min(Math.max(Number(url.searchParams.get("days")) || 14, 1), 90)));
      if (p === "/groups") return json(200, groups());
      if (p === "/sources") return json(200, sourcesView());
      if ((m = /^\/sources\/([a-z][a-z0-9_-]*)\/run$/.exec(p)) && method === "POST") {
        try { return json(200, await runSourceNow(m[1])); } catch (e: any) { throw bad(String(e?.message ?? e)); }
      }
      if ((m = /^\/groups\/(oc_\w+)$/.exec(p)) && method === "POST") { const b = await body(req); return json(200, await setGroup(m[1], b.activation)); }
      if (p === "/config") return json(200, CONFIG_FILES.map((f) => { const c = configFile(f); return { file: f, exists: c.exists, last: c.history[0] ?? null }; }));
      if ((m = /^\/config\/([\w.]+\.yaml)$/.exec(p))) {
        if (method === "GET") return json(200, configFile(m[1]));
        if (method === "PUT") { const b = await body(req); return json(200, await saveConfig(m[1], String(b.text ?? ""), String(b.hash ?? ""))); }
      }
      if (p === "/config-changes") return json(200, all("SELECT id, ts, file, diff, source FROM config_changes ORDER BY id DESC LIMIT 60"));
      if (p === "/models") return json(200, tiers());
      if ((m = /^\/models\/(chat|work|light|expert)$/.exec(p)) && method === "POST") { const b = await body(req); setTierModel(m[1], String(b.model ?? "").trim()); return json(200, tiers()); }
      if (p === "/secrets") return json(200, secretNames());
      if ((m = /^\/secrets\/([A-Z][A-Z0-9_]*)$/.exec(p)) && method === "PUT") { const b = await body(req); return json(200, await setSecret(m[1], b.value)); }
      if (p === "/jobs") return json(200, (await status(d)).jobs);
      if ((m = /^\/jobs\/([a-z][a-z0-9_]*)\/run$/.exec(p)) && method === "POST") {
        if (!d.scheduler) throw bad("scheduler not running", 503);
        return json(200, { result: await d.scheduler.runNow(m[1]) });
      }
      if (p === "/memory/pages") return json(200, all("SELECT path, title, summary, visibility, bytes, mtime FROM pages ORDER BY path"));
      if (p === "/memory/page") return json(200, { path: url.searchParams.get("path"), text: readPage(String(url.searchParams.get("path") ?? ""), "owner", 200_000) });
      if (p === "/memory/search") return json(200, { result: searchWiki(String(url.searchParams.get("q") ?? ""), "owner", 60) });
      if (p === "/memory/log") return json(200, memoryLog(Math.min(Number(url.searchParams.get("limit")) || 60, 300)));
      if ((m = /^\/memory\/commit\/([0-9a-f]{6,40})$/.exec(p))) return json(200, memoryCommit(m[1]));
      if ((m = /^\/memory\/rollback\/([0-9a-f]{6,40})$/.exec(p)) && method === "POST") {
        const result = rollback(m[1]);
        if (result.startsWith("已撤销")) void notifyAdmin(`↩️ 控制台${result}`);
        return json(200, { result });
      }
      throw bad("not found", 404);
    } catch (e: any) {
      const status = e instanceof HttpError ? e.status : 500;
      if (status === 500) log("console", "error", { path: url.pathname, err: String(e?.stack ?? e).slice(0, 400) });
      if (!res.headersSent) json(status, { error: String(e?.message ?? e) });
      else res.end();
    }
  };

  const listenSock = (server: http.Server, sock: string, mode: number, extra: Record<string, unknown>) => {
    if (existsSync(sock)) unlinkSync(sock);
    // created 0600 (UMask=0077), then opened up to `mode`; the directory's permissions are what keep others out
    server.listen(sock, () => { try { chmodSync(sock, mode); } catch { /* */ } log("console", "listening", { sock, ...extra }); });
  };
  const tailnet = http.createServer(handler("tailnet"));
  tailnet.on("error", (e) => log("console", "server error", { entry: "tailnet", err: String(e?.message ?? e) }));
  const port = Number(process.env.SBOT_CONSOLE_PORT ?? 0);
  if (port) tailnet.listen(port, "127.0.0.1", () => log("console", "listening (dev, tcp)", { port }));
  else {
    try { mkdirSync(dirname(SOCK), { recursive: true }); } catch { /* RuntimeDirectory= made it */ }
    listenSock(tailnet, SOCK, 0o600, { owners: owners().length });
  }

  // the public entrance exists only where deploy/console-web/install.sh made its directory (setgid sbot-web, so the
  // socket's group lets nginx in); its requests 404 until console.yaml web.origin and the password are set
  let web: http.Server | null = null;
  if (existsSync(dirname(WEB_SOCK))) {
    web = http.createServer(handler("web"));
    web.on("error", (e) => log("console", "server error", { entry: "web", err: String(e?.message ?? e) }));
    listenSock(web, WEB_SOCK, 0o660, { entry: "web", on: !!webConf() });
  }
  return { tailnet, web, close: () => { tailnet.close(); web?.close(); } };
}
