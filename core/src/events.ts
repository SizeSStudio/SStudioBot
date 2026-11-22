// 事件账本 (DESIGN §读2.5). Triage (Feishu groups, DMs, every source in sources.yaml) and imports write here; matters,
// the morning report, the console and the agent read it.
//
// An event is one meaningful moment, hung on a matter (事) or, until there is one, a loose topic (话头):
//   kind  = what happened:          ask · decision · commitment · progress · risk · deadline · info
//   level = what it asks of him:    fyi 知道就行 · watch 要盯 · reply 要你回 · decide 要你拍板
//   state = open (reply / decide, not handled yet) · seen (fyi / watch) · done · dropped
// The level is what separates "know it" from "answer it"; the kind is what makes a matter's timeline readable.
// Closing is done by code from his behaviour (he answered it there, the draft went out, he rejected it as 不用回)
// or by him (console, event_update), never guessed by a model. When unsure it stays open: an extra reminder is cheap,
// a silently closed ask is not.

import { all, one, run, tx, type Row } from "./db.ts";
import { localStamp } from "./memory.ts";
import { matterReviewConf } from "./config.ts";
import { MAIN_OPEN, OPEN_MATTER, familyIds, inList, liveId, rootId } from "./matters.ts";

export const KINDS = ["ask", "decision", "commitment", "progress", "risk", "deadline", "info"] as const;
export const LEVELS = ["fyi", "watch", "reply", "decide"] as const;
export const STATES = ["open", "seen", "done", "dropped"] as const;
export const KIND_ZH: Record<string, string> = { ask: "找他", decision: "定了", commitment: "答应", progress: "进展", risk: "风险", deadline: "时间点", info: "信息" };
export const LEVEL_ZH: Record<string, string> = { fyi: "知道就行", watch: "要盯", reply: "要你回", decide: "要你拍板" };
const RANK: Record<string, number> = { fyi: 0, watch: 1, reply: 2, decide: 3 };
export const needsHim = (level: string) => level === "reply" || level === "decide";
export const maxLevel = (a: string, b: string) => ((RANK[a] ?? 0) >= (RANK[b] ?? 0) ? a : b);
const DAY = 86400_000;

/** a topic is a short label shared across places; keep it comparable (no quotes, no spaces, ≤ 24 chars) */
export function normTopic(t: unknown): string | null {
  const s = String(t ?? "").replace(/["'“”‘’「」『』《》【】\[\]()（）#]/g, "").replace(/\s+/g, "").trim().slice(0, 24);
  return s.length >= 2 ? s : null;
}

export interface EventIn {
  source: string; ref: string; ts: number; kind: string; level: string; summary: string;
  place?: string | null; place_id?: string | null; actor?: string | null; link?: string | null; domain?: string | null;
  matter_id?: number | null; topic?: string | null; state?: string; done_at?: number | null; done_by?: string | null; msg_ids?: string[];
}

/** Insert one event (idempotent on source + ref). Unknown kinds / levels fall back to info / fyi. Returns its id. */
export function recordEvent(e: EventIn): number {
  const kind = (KINDS as readonly string[]).includes(e.kind) ? e.kind : "info";
  const level = (LEVELS as readonly string[]).includes(e.level) ? e.level : "fyi";
  const live = e.matter_id ? liveId(e.matter_id) : null;   // a matter merged away: its events land on what it became
  const matter = live ? one("SELECT id, domain FROM matters WHERE id=?", live) : undefined;
  const state = e.state && (STATES as readonly string[]).includes(e.state) ? e.state : needsHim(level) ? "open" : "seen";
  const r = run(`INSERT OR IGNORE INTO events(ts, source, ref, place, place_id, actor, kind, level, summary, link, domain, matter_id, topic, state,
      done_at, done_by, msg_ids, created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    e.ts, e.source, e.ref, e.place ?? null, e.place_id ?? null, e.actor ?? null, kind, level, String(e.summary).trim().slice(0, 500), e.link ?? null,
    matter?.domain ?? e.domain ?? null, matter?.id ?? null, normTopic(e.topic), state, e.done_at ?? null, e.done_by ?? null,
    e.msg_ids?.length ? JSON.stringify(e.msg_ids) : null, Date.now());
  return r.changes ? Number(r.lastInsertRowid) : one("SELECT id FROM events WHERE source=? AND ref=?", e.source, e.ref)!.id as number;
}

/** one thing he said: a Feishu message or a source item marked from_me. `pos` orders a chat; Feishu times are per minute. */
export interface Word { id?: string; ts: number; pos?: number; replyTo?: string; thread?: string | null; mentions?: string[] }
interface Said { id?: string; ts: number; pos?: number; thread?: string | null; sender?: string | null; surface?: string; chat?: string }
type Timed = { ts: number; pos?: number };

const rawOf = (m: Row) => JSON.parse(m.raw_json ?? "{}");
const saidOf = (m: Row): Said => ({ id: m.id, ts: Number(m.ts), pos: rawOf(m).pos, thread: m.thread_id, sender: m.sender_id, surface: m.surface, chat: m.chat_id });
export const wordOf = (m: Row): Word => { const x = rawOf(m); return { id: m.id, ts: Number(m.ts), pos: x.pos, replyTo: x.reply_to, thread: m.thread_id, mentions: x.mentions }; };
const later = (a: Timed, b: Timed) => a.pos != null && b.pos != null ? a.pos > b.pos : a.ts >= b.ts;
/** a DM, or one named thing in a source (a ticket): anything he says there is about it. A source with no `where` is a feed. */
const oneConversation = (m: Said) => m.surface === "feishu:p2p" || (!!m.surface?.startsWith("source:") && m.chat !== `${m.surface.slice(7)}:${m.surface.slice(7)}`);
const eventSaid = (e: Row): Said[] => {
  const ids: string[] = JSON.parse(e.msg_ids ?? "[]");
  const rows = ids.length ? all(`SELECT * FROM messages WHERE id IN (${ids.map(() => "?").join(",")})`, ...ids) : [];
  return rows.length ? rows.map(saidOf) : [{ ts: Number(e.ts), chat: e.place_id }];   // imported events have no messages
};
/** in a group, a plain word only counts right after the ask: this many others talking in between means the talk moved on */
const MAX_BETWEEN = 3;

/**
 * Does this word respond to these messages? The one rule for "he responded" (§读2.5).
 * direct: he replied to one of them, or spoke in their thread. plain: an unaddressed word that follows them closely in
 * the same conversation, or one that @s whoever asked. Replying to something else, speaking in another thread, or
 * @-ing someone else is not a response.
 */
function answerKind(w: Word, said: Said[], chat: string): "direct" | "plain" | null {
  if (w.replyTo) return said.some((m) => m.id === w.replyTo) ? "direct" : null;
  const last = said.reduce((a, b) => (later(b, a) ? b : a));
  if (!later(w, last)) return null;
  if (w.thread) return said.some((m) => m.thread === w.thread || m.id === w.thread) ? "direct" : null;
  if (said.every((m) => m.thread)) return null;   // asked in a thread, he spoke in the main chat
  if (said.some(oneConversation)) return "plain";
  if (said.some((m) => m.surface?.startsWith("source:"))) return null;   // a feed: only reply_to / thread tie his word to an item
  if (w.mentions?.length) return said.some((m) => m.sender && w.mentions!.includes(m.sender)) ? "plain" : null;
  const mine = new Set(said.map((m) => m.id));
  const others = all("SELECT * FROM messages WHERE chat_id=? AND sender_kind='other' AND thread_id IS NULL AND ts>=? AND ts<=? LIMIT 50", chat, last.ts, w.ts)
    .map(saidOf).filter((m) => !mine.has(m.id) && later(m, last) && later(w, m));
  return others.length <= MAX_BETWEEN ? "plain" : null;
}

/**
 * He said something at `ts` in this place: close what it answers. A direct reply closes its own event; a plain word
 * closes only the newest open ask it fits (one "好的" is not an answer to everything). `only` limits it to some events.
 */
export function markReplied(placeId: string, ts: number, replyTo?: unknown, more: Omit<Word, "ts" | "replyTo"> = {}, only?: number[]): number {
  const close = (id: number) => Number(run("UPDATE events SET state='done', done_at=?, done_by='replied' WHERE id=? AND state='open'", ts, id).changes);
  const reply = typeof replyTo === "string" && replyTo ? replyTo : undefined;
  const target = reply ? one("SELECT event_id FROM messages WHERE id=? AND event_id IS NOT NULL", reply)?.event_id : undefined;
  if (target) return !only || only.includes(target) ? close(target) : 0;   // a source reply can sit under another `where`
  const w: Word = { ...more, ts, replyTo: reply };
  // re-weighing an earlier word for new events: if it already closed something here, it is spent
  let n = 0, plainUsed = !!only && !!one("SELECT 1 FROM events WHERE place_id=? AND done_by='replied' AND done_at=?", placeId, ts);
  for (const e of all("SELECT * FROM events WHERE place_id=? AND state='open' ORDER BY ts DESC, id DESC", placeId)) {
    if (only && !only.includes(e.id)) continue;
    const kind = answerKind(w, eventSaid(e), placeId);
    if (!kind || (kind === "plain" && plainUsed)) continue;
    plainUsed ||= kind === "plain";
    n += close(e.id);
  }
  return n;
}

/** New events: weigh what he already said there (his word can land before Triage gets to the ask). */
export function closeAnswered(placeId: string, ids: number[]): number {
  if (!ids.length) return 0;
  const from = Math.min(...ids.flatMap((id) => { const e = one("SELECT * FROM events WHERE id=?", id); return e ? eventSaid(e).map((m) => m.ts) : []; }));
  let n = 0;
  for (const m of all("SELECT * FROM messages WHERE chat_id=? AND sender_kind='owner' AND ts>=? ORDER BY ts, id", placeId, from)) {
    const { ts, replyTo, ...more } = wordOf(m);
    n += markReplied(placeId, ts, replyTo, more, ids);
  }
  return n;
}

/**
 * Is a raised message no longer worth bringing to him? Returns why, or null if it still is. An ask follows its event:
 * every word he says is weighed once as it arrives (markReplied), so a word spent on another ask isn't reused here.
 */
export function responseTo(m: Row): string | null {
  const e = m.event_id ? one("SELECT * FROM events WHERE id=?", m.event_id) : undefined;
  if (e?.state === "done" || e?.state === "dropped") return e.done_by ?? e.state;
  if (e?.state === "open") return null;
  const said = e ? eventSaid(e) : [saidOf(m)];
  const from = Math.min(...said.map((s) => s.ts));
  for (const o of all("SELECT * FROM messages WHERE chat_id=? AND sender_kind='owner' AND ts>=? ORDER BY ts, id LIMIT 50", m.chat_id, from))
    if (answerKind(wordOf(o), said, m.chat_id)) return "replied";
  return null;
}

/** A draft voided because he spoke there, by words that didn't answer it: the ask goes back to being a reminder. Recent ones only, so old drafts don't resurface. */
export const requeueVoidedDrafts = () => Number(run(`UPDATE messages SET triage_action='notify' WHERE triage_action='draft' AND attn IS NULL
    AND event_id IN (SELECT id FROM events WHERE state='open')
    AND id IN (SELECT trigger_msg_id FROM approvals WHERE kind='send' AND status='invalidated' AND decided_at>=?)`, Date.now() - DAY).changes);

/** true while this message's event is an ask still waiting on him */
export const isOpenAsk = (m: Row) => !!m.event_id && !!one("SELECT 1 FROM events WHERE id=? AND state='open' AND level IN ('reply','decide')", m.event_id);

/** Notices held over the daily cap (§寸2), for the morning report; what he has since responded to is dropped. */
export function takeHeldNotices(): { ts: number; text: string }[] {
  const out = new Map<string, { ts: number; text: string }>();
  for (const m of all("SELECT * FROM messages WHERE attn='held' ORDER BY ts, id LIMIT 200")) {
    if (responseTo(m)) { run("UPDATE messages SET attn='answered' WHERE id=?", m.id); continue; }
    run("UPDATE messages SET attn=NULL, triage_action='notified' WHERE id=?", m.id);
    const e = m.event_id ? one("SELECT * FROM events WHERE id=?", m.event_id) : undefined;
    out.set(e ? `e${e.id}` : m.id, { ts: Number(m.ts), text: e ? eventLine(e, { date: false, tag: false }) : `「${rawOf(m).chat_name ?? "?"}」${m.triage_note || String(m.text).slice(0, 80)}` });
  }
  return [...out.values()];
}

/** Close asks whose draft he decided: sent in his name → done; rejected → dropped (he said no reply was needed). */
export function settleFromApprovals(): number {
  const by = (status: string, state: string, doneBy: string) => Number(run(`UPDATE events SET state=?, done_at=?, done_by=? WHERE state='open' AND EXISTS (
      SELECT 1 FROM messages m JOIN approvals a ON a.trigger_msg_id=m.id WHERE m.event_id=events.id AND a.kind='send' AND a.status=?)`,
    state, Date.now(), doneBy, status).changes);
  return by("approved", "done", "approved") + by("rejected", "dropped", "rejected");
}

export function setEventState(id: number, state: string, by: string): Record<string, any> {
  if (!(STATES as readonly string[]).includes(state)) throw new Error(`state must be one of ${STATES.join(" / ")}`);
  const done = state === "done" || state === "dropped";
  if (!run("UPDATE events SET state=?, done_at=?, done_by=? WHERE id=?", state, done ? Date.now() : null, done ? by : null, id).changes) throw new Error(`no event #${id}`);
  return one("SELECT * FROM events WHERE id=?", id)!;
}

/** his correction of what an event asks of him; an open/seen state follows the new level */
export function setEventLevel(id: number, level: string) {
  if (!(LEVELS as readonly string[]).includes(level)) throw new Error(`level must be one of ${LEVELS.join(" / ")}`);
  const e = one("SELECT * FROM events WHERE id=?", id);
  if (!e) throw new Error(`no event #${id}`);
  const state = e.state === "done" || e.state === "dropped" ? e.state : needsHim(level) ? "open" : "seen";
  run("UPDATE events SET level=?, state=? WHERE id=?", level, state, id);
}

export const matterKeys = (id: number): string[] => JSON.parse(one("SELECT keys FROM matters WHERE id=?", id)?.keys ?? "[]");
export function addMatterKeys(id: number, keys: (string | null | undefined)[]) {
  const cur = matterKeys(id);
  const next = [...new Set([...cur, ...keys.map(normTopic).filter((k): k is string => !!k)])].slice(0, 40);
  if (next.length !== cur.length) run("UPDATE matters SET keys=? WHERE id=?", JSON.stringify(next), id);
  return next;
}

/** hang events on a matter: by id, or every event of a topic that has no matter yet (the topic becomes a key) */
export function linkEvents(o: { matterId: number; ids?: number[]; topic?: string }): number {
  const m = one("SELECT id, domain FROM matters WHERE id=?", liveId(o.matterId) ?? o.matterId);
  if (!m) throw new Error(`no matter #${o.matterId}`);
  return tx(() => {
    let n = 0;
    for (const id of o.ids ?? []) n += Number(run("UPDATE events SET matter_id=?, domain=COALESCE(domain, ?) WHERE id=?", m.id, m.domain, id).changes);
    const topic = normTopic(o.topic);
    if (topic) {
      n += Number(run("UPDATE events SET matter_id=?, domain=COALESCE(domain, ?) WHERE topic=? AND matter_id IS NULL", m.id, m.domain, topic).changes);
      addMatterKeys(m.id, [topic]);
    }
    return n;
  });
}

export function eventsQuery(o: { matter?: number; topic?: string; from?: number; to?: number; levels?: string[]; states?: string[]; q?: string; limit?: number }) {
  const where = ["ts>=?", "ts<=?"], args: any[] = [o.from ?? 0, o.to ?? Date.now() + DAY];
  if (o.matter) { const fam = familyIds(o.matter); where.push(`matter_id IN (${inList(fam) || "NULL"})`); args.push(...fam); }   // a 主线 shows its 子事 too
  const topic = normTopic(o.topic);
  if (topic) { where.push("topic=?"); args.push(topic); }
  if (o.levels?.length) { where.push(`level IN (${o.levels.map(() => "?").join(",")})`); args.push(...o.levels); }
  if (o.states?.length) { where.push(`state IN (${o.states.map(() => "?").join(",")})`); args.push(...o.states); }
  if (o.q) { where.push("(summary LIKE ? OR actor LIKE ? OR place LIKE ?)"); args.push(`%${o.q}%`, `%${o.q}%`, `%${o.q}%`); }
  return all(`SELECT * FROM events WHERE ${where.join(" AND ")} ORDER BY ts DESC, id DESC LIMIT ?`, ...args, Math.min(o.limit ?? 100, 500)).reverse();
}

const STATE_ZH: Record<string, string> = { open: "等他", seen: "", done: "已处理", dropped: "不用了" };
export function eventLine(e: Record<string, any>, o: { date?: boolean; tag?: boolean } = {}): string {
  const where = [e.place ? `「${e.place}」` : "", e.actor ? `${e.actor}：` : ""].join("");
  const hang = e.matter_id ? `（事 #${e.matter_id}）` : e.topic ? `（话头：${e.topic}）` : "";
  const st = STATE_ZH[e.state] ? ` [${STATE_ZH[e.state]}]` : "";
  return `${o.date === false ? "" : `${localStamp(e.ts).slice(5, 16)} `}[${LEVEL_ZH[e.level] ?? e.level}·${KIND_ZH[e.kind] ?? e.kind}] ${where}${e.summary}${hang}${st}${o.tag === false ? "" : ` ‹event:${e.id}›`}`;
}

/** asks still waiting on him (newest first), from the last `days` days */
export const openAsks = (days = 14, limit = 40) =>
  all("SELECT * FROM events WHERE state='open' AND level IN ('reply','decide') AND ts>=? ORDER BY CASE level WHEN 'decide' THEN 0 ELSE 1 END, ts DESC LIMIT ?", Date.now() - days * DAY, limit);

/** the one open matter a topic names (a key or its title). Under one 主线 the 子事 that carries it wins; across 主线 it is ambiguous: null. */
export function matterByKey(topicIn: unknown): number | null {
  const t = normTopic(topicIn);
  if (!t) return null;
  const hits = all(`SELECT id, title, keys, parent_id FROM matters WHERE ${OPEN_MATTER}`)
    .filter((m) => normTopic(m.title) === t || (JSON.parse(m.keys ?? "[]") as string[]).includes(t));
  if (hits.length < 2) return hits.length ? Number(hits[0].id) : null;
  if (new Set(hits.map((m) => rootId(Number(m.id)))).size > 1) return null;
  const kids = hits.filter((m) => m.parent_id);
  return kids.length === 1 ? Number(kids[0].id) : rootId(Number(hits[0].id));
}

/**
 * Which matter a new event goes on (§读2.5). Triage names a 主线 by number; a topic that is the key of one of its 子事
 * narrows it. With no usable number, a topic that is a known key still finds its matter, so a key really does link.
 */
export function resolveEventMatter(matter: unknown, topic: unknown): number | null {
  const n = Number(matter);
  const picked = Number.isInteger(n) && n > 0 ? liveId(n) : null;
  const keyed = matterByKey(topic);
  if (picked && one(`SELECT 1 FROM matters WHERE id=? AND ${OPEN_MATTER}`, picked)) return keyed && rootId(keyed) === rootId(picked) ? keyed : picked;
  return keyed;
}

/** topics that keep coming up in more than one place without a matter: candidates for 起局. A topic some matter already answers to isn't one. */
export const topicCandidates = (days = 7, minEvents = 3, minPlaces = 2, limit = 6) =>
  all(`SELECT topic, COUNT(*) n, COUNT(DISTINCT COALESCE(place_id, place)) places, GROUP_CONCAT(DISTINCT place) where_, MAX(ts) last,
      SUM(CASE WHEN level IN ('reply','decide') THEN 1 ELSE 0 END) asks FROM events
    WHERE matter_id IS NULL AND topic IS NOT NULL AND ts>=? AND state<>'dropped' GROUP BY topic HAVING n>=? AND places>=? ORDER BY n DESC, last DESC LIMIT 40`,
    Date.now() - days * DAY, minEvents, minPlaces).filter((t) => !matterByKey(t.topic)).slice(0, limit);

/**
 * What Triage sees about his ongoing matters and recent topics, so the same thing said in different chats lands on
 * the same matter / topic. 主线 only, carrying the names of everything under them; titles, keys and place names, never
 * the matter pages. The most recently active come first, so a long list loses the quiet ones.
 */
export function triageMatterContext(): string {
  const last = (id: number) => { const f = familyIds(id); return Number(one(`SELECT MAX(ts) t FROM events WHERE matter_id IN (${inList(f)})`, ...f)?.t ?? 0); };
  const ms = all(`SELECT id, title, keys FROM matters WHERE ${MAIN_OPEN} ORDER BY id DESC`).map((m) => ({ ...m, last: last(m.id) }))
    .sort((a, b) => b.last - a.last || b.id - a.id).slice(0, 40);
  const lines = ms.map((m) => {
    const kids = all(`SELECT title, keys FROM matters WHERE parent_id=? AND ${OPEN_MATTER} ORDER BY id`, m.id);
    const keys = [...new Set([m.keys, ...kids.map((k) => k.keys)].flatMap((k) => JSON.parse(k ?? "[]") as string[]))];
    const fam = familyIds(m.id);
    const places = all(`SELECT place, MAX(ts) t FROM events WHERE matter_id IN (${inList(fam)}) AND place IS NOT NULL GROUP BY place ORDER BY t DESC LIMIT 4`, ...fam).map((r) => r.place);
    return `#${m.id} ${m.title}${keys.length ? `（又叫：${keys.slice(0, 8).join("、")}）` : ""}${kids.length ? `；包括：${kids.slice(0, 6).map((k) => k.title).join("、")}` : ""}${places.length ? `；最近在：${places.join("、")}` : ""}`;
  });
  const topics = all(`SELECT topic, COUNT(*) n, GROUP_CONCAT(DISTINCT place) where_ FROM events WHERE matter_id IS NULL AND topic IS NOT NULL AND ts>=?
    GROUP BY topic ORDER BY MAX(ts) DESC LIMIT 15`, Date.now() - 7 * DAY);
  return `他手上的事（matter 填这里的编号）：\n${lines.join("\n") || "（没有）"}\n\n最近的话头（还没归到事里；同一件事沿用这个说法）：\n${
    topics.map((t) => `- ${t.topic}（${t.n} 次${t.where_ ? `，${String(t.where_).split(",").slice(0, 3).join("、")}` : ""}）`).join("\n") || "（没有）"}`;
}

/** per matter, adding up its 子事: counts by level and the asks still open (console list, matter_list) */
export function matterEventStats(id: number) {
  const f = familyIds(id);
  return one(`SELECT COUNT(*) n, SUM(CASE WHEN state='open' AND level IN ('reply','decide') THEN 1 ELSE 0 END) open, MAX(ts) last FROM events WHERE matter_id IN (${inList(f) || "NULL"})`, ...f)!;
}

/** an imported ask nobody has confirmed is still live: old, or on a matter that is no longer open (§读3.2) */
export function isStaleImportAsk(e: Record<string, any>, days = matterReviewConf().ask_days): boolean {
  if (e.source !== "import" || e.state !== "open" || !needsHim(e.level)) return false;
  if (one("SELECT 1 FROM matter_reviews WHERE fp=? AND status='ok'", `ask:${e.id}`)) return false;   // he said it is still waiting on him
  if (Number(e.ts) < Date.now() - days * DAY) return true;
  return !!e.matter_id && !one(`SELECT 1 FROM matters WHERE id=? AND ${OPEN_MATTER}`, liveId(e.matter_id) ?? e.matter_id);
}

/** the morning report's event sections (facts only; the main agent writes the report) */
export function eventsMorningText(since: number): string {
  const list = (xs: string[]) => xs.length ? xs.map((x) => `- ${x}`).join("\n") : "（无）";
  const review = matterReviewConf().on;
  const all_ = openAsks(14, 40), doubtful = review ? all_.filter((e) => isStaleImportAsk(e)) : [];
  const asks = all_.filter((e) => !doubtful.includes(e)).slice(0, 15);
  // everything said about a 主线 or its 子事 reads as one line
  const groups = new Map<number, Record<string, any>[]>();
  for (const e of all("SELECT * FROM events WHERE ts>=? AND matter_id IS NOT NULL ORDER BY ts DESC", since)) {
    const r = rootId(e.matter_id);
    if (r) groups.set(r, [...(groups.get(r) ?? []), e]);
  }
  const rank = (e: Record<string, any>) => (["reply", "decide", "watch"].includes(e.level) ? 0 : 1);
  const byMatter = [...groups].sort((a, b) => b[1].length - a[1].length).slice(0, 10).map(([id, es]) => ({
    id, title: one("SELECT title FROM matters WHERE id=?", id)?.title, n: es.length, asks: es.filter((e) => needsHim(e.level)).length,
    where_: [...new Set(es.map((e) => e.place).filter(Boolean))].join(","), latest: [...es].sort((a, b) => rank(a) - rank(b))[0],
  }));
  const topics = all(`SELECT topic, COUNT(*) n, GROUP_CONCAT(DISTINCT place) where_ FROM events WHERE matter_id IS NULL AND topic IS NOT NULL AND ts>=?
    GROUP BY topic HAVING n>=2 ORDER BY n DESC LIMIT 8`, since);
  const cands = review ? [] : topicCandidates();   // with the daily review on, these are asked there instead
  const places = (s: unknown) => String(s ?? "").split(",").filter(Boolean).slice(0, 3).join("、");
  const shown = review ? Number(one("SELECT COUNT(*) n FROM matter_reviews WHERE status='shown'")!.n) : 0;
  return `## 等你回 / 拍板（${asks.length}）
${list(asks.map((e) => `${eventLine(e, { tag: false })}（${localStamp(e.ts).slice(5, 10)}）`))}${doubtful.length ? `\n（另有 ${doubtful.length} 条是导入来的旧事项，可能已经过时，等他在整理里确认，不算在上面）` : ""}
## 按事：昨天以来
${list([...byMatter.map((m) => `#${m.id} ${m.title}：${m.n} 条${m.asks ? `（要你回/拍板 ${m.asks}）` : ""}，在 ${places(m.where_)}；${m.latest.summary}`),
  ...topics.map((t) => `话头「${t.topic}」：${t.n} 条，在 ${places(t.where_)}`)])}
${review ? `## 事的整理\n${shown ? `今天挑了 ${shown} 条要他确认（私聊里的卡片，或控制台 生活 › 事）` : "今天没有要确认的"}` : `## 可能该起局的话头（一周里反复出现、跨好几处，还没有事）
${list(cands.map((t) => `「${t.topic}」：${t.n} 条，${t.places} 处（${places(t.where_)}）${t.asks ? `，其中要他回 ${t.asks}` : ""}`))}`}`;
}
