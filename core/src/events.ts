// 事件账本 (DESIGN §17.2). Triage (Feishu groups, DMs, every source in sources.yaml) and imports write here; matters,
// the morning report, the console and the agent read it.
//
// An event is one meaningful moment, hung on a matter (事) or, until there is one, a loose topic (话头):
//   kind  = what happened:          ask · decision · commitment · progress · risk · deadline · info
//   level = what it asks of him:    fyi 知道就行 · watch 要盯 · reply 要你回 · decide 要你拍板
//   state = open (reply / decide, not handled yet) · seen (fyi / watch) · done · dropped
// The level is what separates "know it" from "answer it"; the kind is what makes a matter's timeline readable.
// Closing is done by code from his behaviour (he spoke in that place, the draft went out, he rejected it as 不用回)
// or by him (console, event_update), never guessed by a model.

import { all, one, run, tx } from "./db.ts";
import { localStamp } from "./memory.ts";

export const KINDS = ["ask", "decision", "commitment", "progress", "risk", "deadline", "info"] as const;
export const LEVELS = ["fyi", "watch", "reply", "decide"] as const;
export const STATES = ["open", "seen", "done", "dropped"] as const;
export const KIND_ZH: Record<string, string> = { ask: "找他", decision: "定了", commitment: "答应", progress: "进展", risk: "风险", deadline: "时间点", info: "信息" };
export const LEVEL_ZH: Record<string, string> = { fyi: "知道就行", watch: "要盯", reply: "要你回", decide: "要你拍板" };
const RANK: Record<string, number> = { fyi: 0, watch: 1, reply: 2, decide: 3 };
export const needsHim = (level: string) => level === "reply" || level === "decide";
export const maxLevel = (a: string, b: string) => ((RANK[a] ?? 0) >= (RANK[b] ?? 0) ? a : b);
const DAY = 86400_000;
const OPEN_MATTER = "status IN ('open','active','closing')";

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
  const matter = e.matter_id ? one("SELECT id, domain FROM matters WHERE id=?", e.matter_id) : undefined;
  const state = e.state && (STATES as readonly string[]).includes(e.state) ? e.state : needsHim(level) ? "open" : "seen";
  const r = run(`INSERT OR IGNORE INTO events(ts, source, ref, place, place_id, actor, kind, level, summary, link, domain, matter_id, topic, state,
      done_at, done_by, msg_ids, created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    e.ts, e.source, e.ref, e.place ?? null, e.place_id ?? null, e.actor ?? null, kind, level, String(e.summary).trim().slice(0, 500), e.link ?? null,
    matter?.domain ?? e.domain ?? null, matter?.id ?? null, normTopic(e.topic), state, e.done_at ?? null, e.done_by ?? null,
    e.msg_ids?.length ? JSON.stringify(e.msg_ids) : null, Date.now());
  return r.changes ? Number(r.lastInsertRowid) : one("SELECT id FROM events WHERE source=? AND ref=?", e.source, e.ref)!.id as number;
}

/**
 * He spoke in this place at `ts`: what was waiting on him there counts as answered. If his message replies to a
 * specific message that belongs to an event, only that event closes; otherwise every open ask raised before it.
 */
export function markReplied(placeId: string, ts: number, replyTo?: unknown): number {
  const target = typeof replyTo === "string" && replyTo ? one("SELECT event_id FROM messages WHERE id=? AND event_id IS NOT NULL", replyTo)?.event_id : undefined;
  if (target) return Number(run("UPDATE events SET state='done', done_at=?, done_by='replied' WHERE id=? AND state='open'", ts, target).changes);
  return Number(run("UPDATE events SET state='done', done_at=?, done_by='replied' WHERE place_id=? AND state='open' AND ts<=?", ts, placeId, ts).changes);
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
  const next = [...new Set([...cur, ...keys.map(normTopic).filter((k): k is string => !!k)])].slice(0, 20);
  if (next.length !== cur.length) run("UPDATE matters SET keys=? WHERE id=?", JSON.stringify(next), id);
  return next;
}

/** hang events on a matter: by id, or every event of a topic that has no matter yet (the topic becomes a key) */
export function linkEvents(o: { matterId: number; ids?: number[]; topic?: string }): number {
  const m = one("SELECT id, domain FROM matters WHERE id=?", o.matterId);
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
  if (o.matter) { where.push("matter_id=?"); args.push(o.matter); }
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

/** topics that keep coming up in more than one place without a matter: candidates for 起局 */
export const topicCandidates = (days = 7, minEvents = 3, minPlaces = 2) =>
  all(`SELECT topic, COUNT(*) n, COUNT(DISTINCT COALESCE(place_id, place)) places, GROUP_CONCAT(DISTINCT place) where_, MAX(ts) last,
      SUM(CASE WHEN level IN ('reply','decide') THEN 1 ELSE 0 END) asks FROM events
    WHERE matter_id IS NULL AND topic IS NOT NULL AND ts>=? AND state<>'dropped' GROUP BY topic HAVING n>=? AND places>=? ORDER BY n DESC, last DESC LIMIT 6`,
    Date.now() - days * DAY, minEvents, minPlaces);

/**
 * What Triage sees about his ongoing matters and recent topics, so the same thing said in different chats lands on
 * the same matter / topic. Titles, keys and place names only; never the matter pages.
 */
export function triageMatterContext(): string {
  const ms = all(`SELECT id, title, keys FROM matters WHERE ${OPEN_MATTER} ORDER BY id DESC LIMIT 30`);
  const lines = ms.map((m) => {
    const keys = JSON.parse(m.keys ?? "[]") as string[];
    const places = all("SELECT DISTINCT place FROM events WHERE matter_id=? AND place IS NOT NULL ORDER BY ts DESC LIMIT 4", m.id).map((r) => r.place);
    return `#${m.id} ${m.title}${keys.length ? `（又叫：${keys.slice(0, 6).join("、")}）` : ""}${places.length ? `；最近在：${places.join("、")}` : ""}`;
  });
  const topics = all(`SELECT topic, COUNT(*) n, GROUP_CONCAT(DISTINCT place) where_ FROM events WHERE matter_id IS NULL AND topic IS NOT NULL AND ts>=?
    GROUP BY topic ORDER BY MAX(ts) DESC LIMIT 15`, Date.now() - 7 * DAY);
  return `他手上的事（matter 填这里的编号）：\n${lines.join("\n") || "（没有）"}\n\n最近的话头（还没归到事里；同一件事沿用这个说法）：\n${
    topics.map((t) => `- ${t.topic}（${t.n} 次${t.where_ ? `，${String(t.where_).split(",").slice(0, 3).join("、")}` : ""}）`).join("\n") || "（没有）"}`;
}

/** per matter: counts by level and the asks still open (console list, matter_list) */
export function matterEventStats(id: number) {
  return one(`SELECT COUNT(*) n, SUM(CASE WHEN state='open' AND level IN ('reply','decide') THEN 1 ELSE 0 END) open, MAX(ts) last FROM events WHERE matter_id=?`, id)!;
}

/** the morning report's event sections (facts only; the main agent writes the report) */
export function eventsMorningText(since: number): string {
  const list = (xs: string[]) => xs.length ? xs.map((x) => `- ${x}`).join("\n") : "（无）";
  const asks = openAsks(14, 15);
  const byMatter = all(`SELECT e.matter_id, m.title, COUNT(*) n, SUM(CASE WHEN e.level IN ('reply','decide') THEN 1 ELSE 0 END) asks,
      GROUP_CONCAT(DISTINCT e.place) where_ FROM events e JOIN matters m ON m.id=e.matter_id WHERE e.ts>=? GROUP BY e.matter_id ORDER BY n DESC LIMIT 10`, since);
  const latest = (id: number) => one("SELECT * FROM events WHERE matter_id=? AND ts>=? ORDER BY CASE WHEN level IN ('reply','decide','watch') THEN 0 ELSE 1 END, ts DESC LIMIT 1", id, since);
  const topics = all(`SELECT topic, COUNT(*) n, GROUP_CONCAT(DISTINCT place) where_ FROM events WHERE matter_id IS NULL AND topic IS NOT NULL AND ts>=?
    GROUP BY topic HAVING n>=2 ORDER BY n DESC LIMIT 8`, since);
  const cands = topicCandidates();
  const places = (s: unknown) => String(s ?? "").split(",").filter(Boolean).slice(0, 3).join("、");
  return `## 等你回 / 拍板（${asks.length}）
${list(asks.map((e) => `${eventLine(e, { tag: false })}（${localStamp(e.ts).slice(5, 10)}）`))}
## 按事：昨天以来
${list([...byMatter.map((m) => { const e = latest(m.matter_id); return `#${m.matter_id} ${m.title}：${m.n} 条${m.asks ? `（要你回/拍板 ${m.asks}）` : ""}，在 ${places(m.where_)}${e ? `；${e.summary}` : ""}`; }),
  ...topics.map((t) => `话头「${t.topic}」：${t.n} 条，在 ${places(t.where_)}`)])}
## 可能该起局的话头（一周里反复出现、跨好几处，还没有事）
${list(cands.map((t) => `「${t.topic}」：${t.n} 条，${t.places} 处（${places(t.where_)}）${t.asks ? `，其中要他回 ${t.asks}` : ""}`))}`;
}
