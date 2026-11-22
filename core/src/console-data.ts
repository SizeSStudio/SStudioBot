// Console views for the four areas (DESIGN §触5.4): 待办, 会话 (lanes, runs, the chain detail), 生活, 它自己.
// Read-mostly; the writes here go through the same functions the cards, commands and tools use (approvals.ts,
// tasks.ts, life.ts), so the console is one more surface, not a second set of rules.

import { gunzipSync } from "node:zlib";
import { all, one, run, kvGet } from "./db.ts";
import { jobsConf, matterReviewConf, ownerFeishu, feishuConf, log } from "./config.ts";
import { readPage, localStamp } from "./memory.ts";
import { onApprovalClick, reviseApproval, editDraft, getApproval, submitApproval } from "./approvals.ts";
import { replyTask, cancelTask } from "./tasks.ts";
import { timeline, addNote, listSelfItems, markSelfItem, DOMAINS, DOMAIN_ZH } from "./life.ts";
import { readingText, LENSES } from "./lens.ts";
import { metricsWindow } from "./health.ts";
import { lineDiff, replayText, improveStatus } from "./improve.ts";
import { sendText } from "./cards.ts";
import { eventsQuery, linkEvents, matterEventStats, openAsks, setEventLevel, setEventState } from "./events.ts";
import { familyIds, inList } from "./matters.ts";
import { attachMatters, createMainline, detachMatter, listOps, mergeMatters, undoOp } from "./matter-ops.ts";
import { actOnReview, reviewQueue, undoReview } from "./matter-review.ts";

export const VIA = "经控制台";
const DAY = 86400_000;

class HttpError extends Error { status: number; constructor(status: number, msg: string) { super(msg); this.status = status; } }
export const bad = (msg: string, status = 400) => new HttpError(status, msg);
export { HttpError };
const pj = (s: unknown) => { try { return JSON.parse(String(s ?? "null")); } catch { return null; } };
const excerpt = (s: unknown, n = 160) => { const t = String(s ?? "").replace(/\s+/g, " ").trim(); return t.length > n ? t.slice(0, n) + "…" : t; };
const outText = (payload: string): string => { const p = pj(payload); return !p || typeof p !== "object" ? payload : p.text ?? p.markdown ?? p.content ?? JSON.stringify(p).slice(0, 400); };

// ───────────── 待办 ─────────────

function approvalView(a: Record<string, any>) {
  const ctx = pj(a.context_json) ?? {};
  return {
    id: a.id, kind: a.kind, title: a.title, requester: a.requester, status: a.status, v: a.draft_version, as: a.as_identity ?? "bot",
    channel: a.channel, target: pj(a.target_json), draft: a.draft, expert: pj(a.expert_json), checks: pj(a.checks_json),
    revise: pj(a.revise_notes) ?? [], context: ctx.context_text ? String(ctx.context_text).slice(-4000) : null, hold: !!ctx.hold,
    run_id: a.run_id, task_id: a.task_id, origin_lane: a.origin_lane, ts: a.ts, expires_at: a.expires_at, card: !!a.card_msg_id,
    decided_at: a.decided_at, decide_note: a.decide_note, result: a.result, final_text: a.final_text,
  };
}

export function inbox() {
  const jobs = Object.keys(jobsConf() ?? {}).map((name) => ({ name, last: pj(kvGet(`job.${name}.last`)) }))
    .filter((j) => j.last && /^(failed|missed)/.test(String(j.last.outcome)));
  return {
    approvals: all("SELECT * FROM approvals WHERE status='pending' ORDER BY id").map(approvalView),
    tasks: all("SELECT id, status, goal, question, tier, repo, error, ts, started, ended FROM tasks WHERE status IN ('needs_input','interrupted') ORDER BY ts"),
    alerts: (pj(kvGet("sentinel.findings")) ?? []).filter((f: any) => !/^appr\./.test(f.key)),   // waiting approvals are listed above already
    sentinelAt: Number(kvGet("sentinel.last") ?? 0) || null,
    jobs,
    outbox: all("SELECT id, approval_id, channel, status, error, payload, ts FROM outbox WHERE status IN ('failed','unknown') AND ts>? ORDER BY id DESC LIMIT 20", Date.now() - DAY)
      .map((o) => ({ ...o, payload: undefined, text: excerpt(outText(o.payload), 200) })),
    recent: all("SELECT id, kind, title, status, decided_at, decide_note, result FROM approvals WHERE status<>'pending' AND decided_at>? ORDER BY decided_at DESC LIMIT 12", Date.now() - 2 * DAY),
    asks: openAsks(14, 40).map(eventView),   // §读2.5 要你回 / 拍板, still open
  };
}

// ───────────── 事件 (§读2.5) ─────────────

const matterTitle = (id: unknown) => id ? one("SELECT title FROM matters WHERE id=?", id)?.title as string | undefined : undefined;
const eventView = (e: Record<string, any>) => ({ ...e, msg_ids: undefined, matter_title: matterTitle(e.matter_id) });
export function eventUpdate(id: number, b: { state?: unknown; level?: unknown }) {
  try {
    if (b.level) setEventLevel(id, String(b.level));
    if (b.state) setEventState(id, String(b.state), "owner@console");
  } catch (e: any) { throw bad(String(e?.message ?? e)); }
  const e = one("SELECT * FROM events WHERE id=?", id);
  if (!e) throw bad("no such event", 404);
  return eventView(e);
}
/** recent topics without a matter (the 事 tab's 话头 list), and one topic's events */
export function topics(days = 14) {
  return all(`SELECT topic, COUNT(*) n, COUNT(DISTINCT COALESCE(place_id, place)) places, GROUP_CONCAT(DISTINCT place) where_, MAX(ts) last,
      SUM(CASE WHEN state='open' AND level IN ('reply','decide') THEN 1 ELSE 0 END) open FROM events
    WHERE matter_id IS NULL AND topic IS NOT NULL AND ts>=? AND state<>'dropped' GROUP BY topic ORDER BY last DESC LIMIT 60`, Date.now() - days * DAY)
    .map((t) => ({ ...t, where_: undefined, where: String(t.where_ ?? "").split(",").filter(Boolean).slice(0, 4) }));
}
export const topicEvents = (topic: string) => eventsQuery({ topic, limit: 200 }).map(eventView);
export function topicLink(topic: string, matterId: number) {
  if (!one("SELECT 1 FROM matters WHERE id=?", matterId)) throw bad("no such matter", 404);
  return { moved: linkEvents({ matterId, topic }) };
}

export const approvalFull = (id: number) => { const a = getApproval(id); if (!a) throw bad("no such approval", 404); return approvalView(a); };

async function threadNote(id: number, text: string) {
  const a = getApproval(id), admin = feishuConf().admin_chat;
  if (!a?.card_msg_id || !admin) return;
  try { await sendText(admin, text, { replyTo: a.card_msg_id, inThread: true }); } catch (e: any) { log("console", "thread note failed", { id, err: String(e?.message ?? e).slice(0, 160) }); }
}

/** approve / reject from the console: the same click the card makes (owner, version lock, first wins), marked 经控制台 */
export async function decide(id: number, d: string, v: number, note?: string) {
  if (!["approve", "reject"].includes(d)) throw bad("bad decision");
  const owner = ownerFeishu();
  if (!owner) throw bad("people.yaml 里没有主人的飞书 ID", 500);
  const r = await onApprovalClick({ id, v, d }, owner, { source: VIA, note });
  if (!r) throw bad("这条审批已经变了（别处批过、过期了，或者有了新版本草稿）。刷新看看。", 409);
  return approvalView(r);
}

export async function revise(id: number, note: string) {
  if (!note.trim()) throw bad("说一下怎么改");
  const said = await reviseApproval(id, note.trim());
  void threadNote(id, `（${VIA}）改稿意见：${note.trim().slice(0, 300)}${said ? `\n${said}` : ""}`);
  return { said, approval: approvalFull(id) };
}

export async function edit(id: number, v: number, text: string) {
  try { return approvalView(await editDraft(id, v, text, "控制台")); }
  catch (e: any) { throw bad(String(e?.message ?? e), 409); }
}

export function taskReply(id: string, text: string) {
  if (!text.trim()) throw bad("回答是空的");
  return { result: replyTask(id, text.trim(), "console") };
}
export const taskCancel = (id: string) => ({ result: cancelTask(id) });

// ───────────── 会话 ─────────────

const chatName = (id: string) => one("SELECT name FROM chats WHERE chat_id=?", id)?.name as string | undefined;
function laneInfo(lane: string) {
  if (lane === "feishu:dm:owner") return { group: "dm", name: "私聊" };
  if (lane.startsWith("draft:")) return { group: "draft", name: `起草 · ${chatName(lane.slice(6)) ?? lane.slice(6)}` };
  if (lane.startsWith("feishu:group:")) return { group: "group", name: `群 · ${chatName(lane.split(":")[2]) ?? lane.split(":")[2]}` };
  if (lane.startsWith("task:")) {
    const t = one("SELECT goal, status FROM tasks WHERE id=?", lane.slice(5));
    return { group: "task", name: `任务 #${lane.slice(5)}${t ? ` · ${excerpt(t.goal, 40)}` : ""}`, taskStatus: t?.status };
  }
  if (lane.startsWith("system:")) return { group: "system", name: { "system:dream": "夜间整理", "system:improve": "自我改进", "system:lens": "解读" }[lane] ?? lane.slice(7) };
  if (lane.startsWith("feishu:wb")) return { group: "task", name: "工作台" };
  return { group: "other", name: lane };
}

export function lanes(days = 14) {
  const since = Date.now() - days * DAY;
  const rows = all(`SELECT lane, COUNT(*) n, MAX(started) last, SUM(CASE WHEN status='running' THEN 1 ELSE 0 END) running,
      SUM(CASE WHEN status IN ('failed','aborted','interrupted') AND started>? THEN 1 ELSE 0 END) bad24
    FROM runs WHERE started>? AND lane IS NOT NULL GROUP BY lane ORDER BY last DESC`, Date.now() - DAY, since);
  const lastStatus = new Map(all(`SELECT lane, status FROM runs r WHERE started=(SELECT MAX(started) FROM runs WHERE lane=r.lane) AND started>?`, since).map((r) => [r.lane, r.status]));
  const pending = new Map(all("SELECT origin_lane l, COUNT(*) n FROM approvals WHERE status='pending' GROUP BY 1").map((r) => [r.l, r.n]));
  const cost = new Map(all("SELECT r.lane, SUM(u.cost) c FROM usage u JOIN runs r ON r.id=u.run_id WHERE u.ts>? GROUP BY r.lane", since).map((r) => [r.lane, r.c]));
  const sess = new Map(all("SELECT key, generation, summary, last_active FROM sessions").map((s) => [s.key, s]));
  return rows.map((r) => ({ lane: r.lane, ...laneInfo(r.lane), runs: r.n, last: r.last, running: r.running, bad24: r.bad24, lastStatus: lastStatus.get(r.lane),
    pending: pending.get(r.lane) ?? 0, cost: cost.get(r.lane) ?? 0, generation: sess.get(r.lane)?.generation ?? null }));
}

/** runs of one lane, newest first, with what came in, what went out and the approvals they raised */
export function laneRuns(lane: string, before: number, limit: number) {
  const runs = all(`SELECT id, lane, role, tier, model, status, stop_reason, error, started, ended, task_id, versions_json FROM runs WHERE lane=? AND started<? ORDER BY started DESC LIMIT ?`, lane, before, limit);
  const ids = runs.map((r) => r.id);
  const inIds = (sql: string) => ids.length ? all(sql.replace("(?)", `(${ids.map(() => "?").join(",")})`), ...ids) : [];
  const inbox = inIds("SELECT id, run_id, kind, source, status, payload_json, ts FROM inbox WHERE run_id IN (?) ORDER BY id");
  const outbox = inIds("SELECT id, run_id, channel, kind, status, as_identity, payload, error, ts FROM outbox WHERE run_id IN (?) ORDER BY id");
  const appr = inIds("SELECT * FROM approvals WHERE run_id IN (?) ORDER BY id");
  const cost = inIds("SELECT run_id, COUNT(*) calls, SUM(cost) cost, SUM(input_tokens) i, SUM(output_tokens) o, SUM(cache_read) cr, SUM(cache_write) cw FROM usage WHERE run_id IN (?) GROUP BY run_id");
  const reqs = inIds("SELECT run_id, COUNT(*) n FROM requests WHERE run_id IN (?) GROUP BY run_id");
  return {
    lane, ...laneInfo(lane),
    runs: runs.map((r) => ({
      ...r, versions: pj(r.versions_json), versions_json: undefined,
      usage: cost.find((c) => c.run_id === r.id) ?? null, requests: reqs.find((q) => q.run_id === r.id)?.n ?? 0,
      inputs: inbox.filter((i) => i.run_id === r.id).map((i) => ({ id: i.id, kind: i.kind, source: i.source, status: i.status, ts: i.ts, text: String(pj(i.payload_json)?.text ?? "").slice(0, 4000) })),
      outputs: outbox.filter((o) => o.run_id === r.id).map((o) => ({ id: o.id, channel: o.channel, kind: o.kind, status: o.status, as: o.as_identity, error: o.error, ts: o.ts, text: outText(o.payload).slice(0, 4000) })),
      approvals: appr.filter((a) => a.run_id === r.id).map(approvalView),
    })),
    next: runs.length === limit ? runs[runs.length - 1].started : null,
  };
}

// chain detail: the request the model actually got, split into what costs what

/** rough token weight: CJK ≈ 1 token per char, the rest ≈ 1 per 3.6 chars. Only used to share out the real total. */
const weight = (s: string) => { let cjk = 0; for (const ch of s) if (ch.charCodeAt(0) > 0x2e80) cjk++; return cjk + (s.length - cjk) / 3.6; };
const blockText = (c: any): string => typeof c === "string" ? c : c?.type === "text" ? c.text ?? "" : c?.type === "tool_use" ? `${c.name} ${JSON.stringify(c.input ?? {})}`
  : c?.type === "tool_result" ? (typeof c.content === "string" ? c.content : (c.content ?? []).map(blockText).join("\n")) : c?.type === "thinking" ? c.thinking ?? "" : c?.type === "image" ? "[image]" : JSON.stringify(c ?? "");

export function runRequests(runId: string) {
  return all(`SELECT q.id, q.ts, q.tier, q.model, q.bytes, u.input_tokens, u.output_tokens, u.cache_read, u.cache_write, u.cost, u.ms, u.status
    FROM requests q LEFT JOIN usage u ON u.id=q.usage_id WHERE q.run_id=? ORDER BY q.id`, runId);
}

export function requestDetail(id: number, raw = false) {
  const q = one("SELECT q.*, u.input_tokens, u.output_tokens, u.cache_read, u.cache_write, u.cost, u.ms, u.status, u.requester_id FROM requests q LEFT JOIN usage u ON u.id=q.usage_id WHERE q.id=?", id);
  if (!q) throw bad("这条请求没存（只存对话和起草的，保留 7 天）", 404);
  const text = gunzipSync(q.body as Uint8Array).toString("utf8");
  if (raw) return { id, text: (() => { try { return JSON.stringify(JSON.parse(text), null, 2); } catch { return text; } })() };
  const j = pj(text) ?? {};
  const sysBlocks: any[] = typeof j.system === "string" ? [{ type: "text", text: j.system }] : Array.isArray(j.system) ? j.system : [];
  const parts: { group: string; title: string; text: string; cache?: boolean; role?: string }[] = [];
  sysBlocks.forEach((b, bi) => {
    const t = String(b.text ?? "");
    const pieces = t.split(/\n(?=# )/);   // the system prompt is joined from "# " sections (dispatcher.systemPrompt)
    pieces.forEach((p, i) => {
      const head = /^# (.+)/.exec(p)?.[1] ?? (i === 0 && bi === 0 ? (/^(.{1,40})/.exec(p.trim())?.[1] ?? "开头") : "（续）");
      parts.push({ group: "system", title: head.trim().slice(0, 60), text: p, cache: !!b.cache_control && i === pieces.length - 1 });
    });
  });
  const tools: any[] = Array.isArray(j.tools) ? j.tools : [];
  const toolsText = tools.map((t) => `${t.name}: ${t.description ?? ""}\n${JSON.stringify(t.input_schema ?? {})}`);
  if (tools.length) parts.push({ group: "tools", title: `工具定义（${tools.length} 个）`, text: toolsText.join("\n\n"), cache: tools.some((t) => t.cache_control) });
  const msgs: any[] = Array.isArray(j.messages) ? j.messages : [];
  msgs.forEach((m, i) => {
    const content = typeof m.content === "string" ? [{ type: "text", text: m.content }] : m.content ?? [];
    const kinds = [...new Set(content.map((c: any) => c.type))].join("/");
    const last = i === msgs.length - 1;
    const label = m.role === "user" ? (content.some((c: any) => c.type === "tool_result") ? "工具结果" : last ? "这次的输入" : "用户") : (content.some((c: any) => c.type === "tool_use") ? "模型调用工具" : "模型回复");
    parts.push({ group: last ? "input" : "history", role: m.role, title: `#${i + 1} ${label}${kinds && kinds !== "text" ? ` · ${kinds}` : ""}`,
      text: content.map(blockText).join("\n"), cache: content.some((c: any) => c.cache_control) });
  });
  const total = Number(q.input_tokens ?? 0) + Number(q.cache_read ?? 0) + Number(q.cache_write ?? 0);
  const ws = parts.map((p) => weight(p.text) + (p.group === "history" || p.group === "input" ? 4 : 0));
  const wsum = ws.reduce((a, b) => a + b, 0) || 1;
  const segs = parts.map((p, i) => ({ ...p, chars: p.text.length, tokens: Math.round((ws[i] / wsum) * (total || wsum)), estimated: !total,
    text: p.text.length > 30_000 ? p.text.slice(0, 30_000) + `\n…（还有 ${p.text.length - 30_000} 字，看完整请求）` : p.text }));
  const r = q.run_id ? one("SELECT id, lane, role, tier, model, versions_json, started FROM runs WHERE id=?", q.run_id) : undefined;
  return {
    id, ts: q.ts, run_id: q.run_id, tier: q.tier, model: q.model, bytes: q.bytes, requester: q.requester_id,
    params: { max_tokens: j.max_tokens, temperature: j.temperature, thinking: j.thinking ?? null, stream: !!j.stream, tool_choice: j.tool_choice ?? null },
    usage: { input: q.input_tokens, output: q.output_tokens, cache_read: q.cache_read, cache_write: q.cache_write, cost: q.cost, ms: q.ms, status: q.status },
    versions: pj(r?.versions_json), run: r ? { id: r.id, lane: r.lane, role: r.role } : null,
    segments: segs, tools: tools.map((t, i) => ({ name: t.name, chars: toolsText[i].length })),
  };
}

// ───────────── 生活 (owner-only) ─────────────

export function lifeTimeline(p: URLSearchParams) {
  const days = Math.min(Math.max(Number(p.get("days")) || 7, 1), 365);
  const kinds = (p.get("kinds") ?? "").split(",").filter(Boolean);
  return timeline({ from: Date.now() - days * DAY, to: Date.now(), kinds, domain: p.get("domain") || undefined, q: p.get("q") || undefined, limit: 500 });
}
export function lifeNote(text: string, domain?: string) {
  if (!text.trim()) throw bad("随手记是空的");
  if (domain && !(DOMAINS as readonly string[]).includes(domain)) throw bad("bad domain");
  return { id: addNote({ text, domain: domain || undefined, src: "owner@console" }) };
}
export function matters() {
  return all("SELECT * FROM matters ORDER BY CASE WHEN status IN ('open','active','closing') THEN 0 ELSE 1 END, id DESC LIMIT 500").map((m) => {
    const ev = matterEventStats(m.id), f = familyIds(m.id), q = inList(f);   // a 主线's numbers add up its 子事
    return { ...m, keys: pj(m.keys) ?? [], tasks: one(`SELECT COUNT(*) n FROM tasks WHERE matter_id IN (${q})`, ...f)!.n, followups: one(`SELECT COUNT(*) n FROM timers WHERE matter_id IN (${q}) AND status='pending'`, ...f)!.n,
      readings: one(`SELECT COUNT(*) n FROM readings WHERE matter_id IN (${q})`, ...f)!.n, events: ev.n, asks: ev.open ?? 0, last_event: ev.last };
  });
}
const opErr = <T>(f: () => T): T => { try { return f(); } catch (e: any) { throw bad(String(e?.message ?? e)); } };
export const matterReview = () => ({ on: matterReviewConf().on, ...reviewQueue(), ops: listOps({ limit: 30 }) });
export const reviewAct = (id: number, a: string) => opErr(() => (a === "undo" ? undoReview(id, "owner@console") : actOnReview(id, a, "owner@console")));
export const opUndo = (id: number) => opErr(() => undoOp(id, "owner@console"));
/** his hand on the 事 page: attach / merge / detach / a new 主线 over this and others */
export function matterRegroup(id: number, b: Record<string, any>) {
  const x = { by: "owner@console", why: b.why ? String(b.why).slice(0, 300) : undefined }, target = Number(b.target);
  return opErr(() => {
    if (b.action === "attach") return { op: attachMatters([id], target, x) };
    if (b.action === "merge") return { op: mergeMatters([id], target, x) };
    if (b.action === "detach") return { op: detachMatter(id, x) };
    if (b.action === "main") return createMainline(String(b.title ?? ""), [id, ...(Array.isArray(b.ids) ? b.ids.map(Number) : [])], x);
    throw new Error("不认识的操作");
  });
}
export function matter(id: number) {
  const m = one("SELECT * FROM matters WHERE id=?", id);
  if (!m) throw bad("no such matter", 404);
  const f = familyIds(id), q = inList(f);
  return { ...m, keys: pj(m.keys) ?? [], text: m.file_path ? readPage(m.file_path, "owner", 120_000) : "",
    parent: m.parent_id ? one("SELECT id, title, status FROM matters WHERE id=?", m.parent_id) : null,
    children: all("SELECT id, title, status FROM matters WHERE parent_id=? AND status<>'merged' ORDER BY id", id),
    merged: all("SELECT id, title FROM matters WHERE merged_into=? ORDER BY id", id), ops: listOps({ matter: id, limit: 20 }),
    tasks: all(`SELECT id, status, goal, ts FROM tasks WHERE matter_id IN (${q}) ORDER BY ts DESC`, ...f),
    followups: all(`SELECT id, due_at, note, status FROM timers WHERE matter_id IN (${q}) ORDER BY due_at DESC LIMIT 20`, ...f),
    events: eventsQuery({ matter: id, limit: 300 }).map(eventView),
    timeline: timeline({ from: m.opened_at ?? 0, to: Date.now(), matter: id, limit: 200 }).rows.filter((r) => r.kind !== "event") };
}
export function outlooks(limit = 80) {
  const rows = all("SELECT * FROM outlooks ORDER BY ts DESC LIMIT ?", limit);
  const rv = rows.length ? all(`SELECT * FROM outlook_revisits WHERE outlook_id IN (${rows.map(() => "?").join(",")}) ORDER BY id`, ...rows.map((r) => r.id)) : [];
  return rows.map((o) => ({ ...o, why_refs: pj(o.why_refs), revisits: rv.filter((r) => r.outlook_id === o.id) }));
}
export function selfItems() {
  const items = listSelfItems().map((r) => ({ ...r, evidence: pj(r.evidence_json) ?? [], evidence_json: undefined,
    noticed: Object.fromEntries(all("SELECT who, COUNT(*) n FROM noticings WHERE item_id=? GROUP BY who", r.id).map((x) => [x.who, x.n])) }));
  const since = Date.now() - 30 * DAY;
  const noticings = Object.fromEntries(all("SELECT who, COUNT(*) n FROM noticings WHERE ts>=? GROUP BY who", since).map((r) => [r.who, r.n]));
  return { items, noticings30: noticings };
}
export function markSelf(id: number, status: string, note?: string) {
  if (!["endorsed", "dropped", "candidate", "seeing_off", "let_go"].includes(status)) throw bad("bad status");
  return { result: markSelfItem(id, status as any, note ? `${note}（控制台）` : "控制台") };
}
export function readings(limit = 100) {
  return all("SELECT id, ts, lens, method, question, horizon, period, matter_id, status, error, claims_json, done_at FROM readings ORDER BY id DESC LIMIT ?", limit).map((r) => ({
    ...r, claims: (pj(r.claims_json) ?? []).length, claims_json: undefined, lensZh: LENSES[r.lens]?.zh ?? r.lens,
    revisits: one("SELECT COUNT(*) n FROM reading_revisits WHERE reading_id=?", r.id)!.n,
  }));
}
export function reading(id: number) {
  const r = one("SELECT * FROM readings WHERE id=?", id);
  if (!r) throw bad("no such reading", 404);
  return { id, lens: r.lens, status: r.status, text: readingText(r, true), chart_ref: r.chart_ref, profile_version: r.profile_version };
}
export function reviews(limit = 60) {
  return all("SELECT id, kind, period, matter_id, status, delivery, ts, LENGTH(facts) facts_len FROM reviews ORDER BY id DESC LIMIT ?", limit);
}
export function review(id: number) {
  const r = one("SELECT * FROM reviews WHERE id=?", id);
  if (!r) throw bad("no such review", 404);
  return { ...r, text: r.file_path ? readPage(r.file_path, "owner", 120_000) : null };
}
export const lifeMeta = () => ({ domains: DOMAIN_ZH, lenses: Object.fromEntries(Object.entries(LENSES).map(([k, v]) => [k, v.zh])) });

// ───────────── 它自己 ─────────────

export function healthTrend(weeks: number) {
  const now = Date.now(), out: any[] = [];
  for (let i = weeks - 1; i >= 0; i--) {
    const to = now - i * 7 * DAY, from = to - 7 * DAY, m = metricsWindow(from, to);
    out.push({ from, to, label: localStamp(from).slice(5, 10), ...m, cost: undefined });
  }
  return { weeks: out, improve: improveStatus(), cases: all("SELECT kind, COUNT(*) n FROM eval_cases GROUP BY kind") };
}
export function proposals() {
  return all(`SELECT p.id, p.ts, p.target, p.problem, p.change, p.status, p.approval_id, p.applied_at, p.review_due, p.rollback_approval_id, p.replay_json, a.status ap_status, a.draft_version v
    FROM proposals p LEFT JOIN approvals a ON a.id=p.approval_id ORDER BY p.id DESC LIMIT 100`).map((p) => ({ ...p, replay: replayText(pj(p.replay_json) ?? {}), replay_json: undefined }));
}
export function proposal(id: number) {
  const p = one("SELECT * FROM proposals WHERE id=?", id);
  if (!p) throw bad("no such proposal", 404);
  return { ...p, evidence: pj(p.evidence_json), review: pj(p.review_json), replay: replayText(pj(p.replay_json) ?? {}), replay_raw: pj(p.replay_json),
    diff: lineDiff(p.old_content ?? "", p.new_content, 2000), approval: p.approval_id ? approvalFull(p.approval_id) : null,
    rollback: p.rollback_approval_id ? approvalFull(p.rollback_approval_id) : null };
}
/** roll a live proposal back now (not waiting for the two-week card): a rollback approval, decided at once by him */
export async function rollbackProposal(id: number) {
  const p = one("SELECT * FROM proposals WHERE id=?", id);
  if (!p) throw bad("no such proposal", 404);
  if (p.status !== "approved") throw bad(`提案是「${p.status}」，不是生效中，没法回滚`);
  let aid = p.rollback_approval_id as number | null;
  const cur = aid ? getApproval(aid) : undefined;
  if (!cur || cur.status !== "pending") {
    aid = submitApproval({ kind: "rollback", title: `回滚 · ${p.target}`, requester: "控制台", run_id: p.run_id, context: { proposal_id: p.id }, draft: `从控制台回滚：${p.change}` });
    run("UPDATE proposals SET rollback_approval_id=? WHERE id=?", aid, p.id);
  }
  const a = await decide(aid!, "approve", getApproval(aid!)!.draft_version);
  return { result: a.result ?? "已回滚", proposal: proposal(id) };
}
