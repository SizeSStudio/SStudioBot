// 红尘里修, the data layer (DESIGN §觉): 随手记, the timeline, 前瞻, 复盘, 习气 / 节律 and 谁先看见.
//
// Everything here is owner-only. The rules that matter are enforced in code, not in prompts:
//   - an outlook is frozen once written; later feelings are appended as revisits (§觉2, §参1)
//   - a review without the owner's own words is stored as 未聊; the agent's 对照 is dropped then (§觉4)
//   - a noticing credited to the owner must quote words he actually said in that review (§寸3)
//   - habit / rhythm candidates need evidence; only the owner endorses or drops them; 送一程 is decided by code
//   - 淡了 is decided by code (no new evidence for fade_days); 放下 only by the owner, and dream stops adding to it (§寸4)
// self/habits.md and self/rhythms.md are rendered from self_items, like index.md: nobody edits them by hand.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { db, all, one, run, tx, signal, kvGet, kvSet } from "./db.ts";
import { P, selfConf, log } from "./config.ts";
import { appendJournal, localStamp } from "./memory.ts";
import { parseLocal } from "./timers.ts";
import { familyIds, inList } from "./matters.ts";

export const DOMAINS = ["work", "family", "friends", "body", "mind"] as const;
export const DOMAIN_ZH: Record<string, string> = { work: "工作", family: "家庭", friends: "朋友", body: "身体", mind: "心" };

db.exec(`
DROP VIEW IF EXISTS timeline;
CREATE VIEW timeline AS
  SELECT ts, 'said' AS kind, id AS ref, text, NULL AS domain, NULL AS matter_id FROM messages WHERE lane='feishu:dm:owner' AND sender_kind='owner'
  UNION ALL SELECT ts, 'said_group', id, text, 'work', NULL FROM messages WHERE surface='feishu:group' AND sender_kind='owner'
  UNION ALL SELECT ts, 'note', 'note:'||id, text, domain, matter_id FROM life_notes
  UNION ALL SELECT o.ts, 'sent', 'approval:'||o.approval_id, o.payload, NULL, a.matter_id FROM outbox o JOIN approvals a ON a.id=o.approval_id WHERE o.status='sent'
  UNION ALL SELECT decided_at, 'approval', 'approval:'||id,
    COALESCE(title,'') || ' → ' || status || CASE WHEN draft_version>1 THEN '（改了 '||(draft_version-1)||' 次）' ELSE '' END || COALESCE('；他的话：'||decide_note,''),
    NULL, matter_id FROM approvals WHERE decided_at IS NOT NULL
  UNION ALL SELECT COALESCE(started, ts), 'task', 'task:'||id, '开工：'||goal, NULL, matter_id FROM tasks
  UNION ALL SELECT ended, 'task', 'task:'||id, CASE status WHEN 'done' THEN '完成：' WHEN 'failed' THEN '失败：' ELSE status||'：' END || goal, NULL, matter_id FROM tasks WHERE ended IS NOT NULL
  UNION ALL SELECT opened_at, 'matter', 'matter:'||id, '起：'||title, CASE domain WHEN 'work' THEN 'work' ELSE NULL END, id FROM matters
  UNION ALL SELECT closed_at, 'matter', 'matter:'||id, status||'：'||title, CASE domain WHEN 'work' THEN 'work' ELSE NULL END, id FROM matters WHERE closed_at IS NOT NULL
  -- §读2.5: events that belong to a matter or needed him; the rest (fyi noise) stays in the ledger only
  UNION ALL SELECT ts, 'event', 'event:'||id,
    CASE level WHEN 'decide' THEN '〔要你拍板〕' WHEN 'reply' THEN '〔要你回〕' WHEN 'watch' THEN '〔要盯〕' ELSE '' END
      || COALESCE('「'||place||'」','') || COALESCE(actor||'：','') || summary
      || CASE state WHEN 'open' THEN '（等他）' WHEN 'dropped' THEN '（不用了）' ELSE '' END,
    CASE domain WHEN 'work' THEN 'work' ELSE NULL END, matter_id FROM events WHERE matter_id IS NOT NULL OR level IN ('reply','decide')
  UNION ALL SELECT ts, 'outlook', 'outlook:'||id, horizon||' '||period||'：'||text, NULL, matter_id FROM outlooks
  UNION ALL SELECT ts, 'revisit', 'outlook:'||outlook_id, '回看：'||text, NULL, NULL FROM outlook_revisits
  UNION ALL SELECT ts, 'review', 'review:'||id, kind||' '||period||' 复盘'||CASE WHEN status!='unchatted' THEN '' WHEN delivery='not_sent' THEN '（没发出）' WHEN delivery='replied' THEN '（他回过，没落档）' ELSE '（未聊）' END, NULL, matter_id FROM reviews;
`);

// ───────────── time helpers ─────────────

export const today = (ms = Date.now()) => localStamp(ms).slice(0, 10);
export const startOfDay = (ms = Date.now()) => parseLocal(`${today(ms)} 00:00`)!;
/** ISO week of the local date, "2026-W47" */
export function isoWeek(ms = Date.now()): string {
  const dt = new Date(`${today(ms)}T00:00:00Z`);
  const wd = dt.getUTCDay() || 7;
  dt.setUTCDate(dt.getUTCDate() + 4 - wd);
  const y = dt.getUTCFullYear();
  return `${y}-W${String(Math.ceil(((dt.getTime() - Date.UTC(y, 0, 1)) / 86400_000 + 1) / 7)).padStart(2, "0")}`;
}
/** local Monday 00:00 of the week containing ms */
export function weekStart(ms = Date.now()): number {
  const wd = new Date(`${today(ms)}T12:00:00Z`).getUTCDay() || 7;
  return startOfDay(startOfDay(ms) - (wd - 1) * 86400_000 + 12 * 3600_000);
}
export const monthOf = (ms = Date.now()) => today(ms).slice(0, 7);
export const monthStart = (ms = Date.now()) => parseLocal(`${monthOf(ms)}-01 00:00`)!;

function parseWhen(s: string | undefined, end = false): number | undefined {
  if (!s) return undefined;
  const t = s.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(t)) return parseLocal(`${t} ${end ? "23:59" : "00:00"}`)! + (end ? 59_999 : 0);
  if (/^\d{4}-\d{2}$/.test(t)) return end ? monthStart(parseLocal(`${t}-28 12:00`)! + 5 * 86400_000) - 1 : parseLocal(`${t}-01 00:00`);
  return parseLocal(t);
}

// ───────────── 随手记 ─────────────

export function addNote(o: { text: string; domain?: string; matterId?: number; people?: string[]; src: string }) {
  const r = run("INSERT INTO life_notes(ts, text, domain, matter_id, people, src) VALUES(?,?,?,?,?,?)",
    Date.now(), o.text.trim(), o.domain ?? null, o.matterId ?? null, o.people?.length ? o.people.join(",") : null, o.src);
  const id = Number(r.lastInsertRowid);
  appendJournal(`随手记 #${id}${o.domain ? `（${DOMAIN_ZH[o.domain] ?? o.domain}）` : ""}：${o.text}`, o.src);
  return id;
}

// ───────────── timeline (§读5.3) ─────────────

const KIND_ZH: Record<string, string> = { said: "他说", said_group: "他在群里", note: "随手记", sent: "代发", approval: "审批", task: "任务", matter: "事", event: "事件", outlook: "前瞻", revisit: "回看", review: "复盘" };

export function timeline(o: { from?: string | number; to?: string | number; kinds?: string[]; matter?: number; domain?: string; q?: string; limit?: number }) {
  const from = typeof o.from === "number" ? o.from : parseWhen(o.from) ?? Date.now() - 7 * 86400_000;
  const to = typeof o.to === "number" ? o.to : parseWhen(o.to, true) ?? Date.now();
  const where = ["ts>=?", "ts<=?"], args: any[] = [from, to];
  if (o.kinds?.length) { where.push(`kind IN (${o.kinds.map(() => "?").join(",")})`); args.push(...o.kinds); }
  if (o.matter) { const fam = familyIds(o.matter); where.push(`matter_id IN (${inList(fam) || "NULL"})`); args.push(...fam); }   // a 主线 includes its 子事
  if (o.domain) { where.push("domain=?"); args.push(o.domain); }
  if (o.q) { where.push("text LIKE ?"); args.push(`%${o.q}%`); }
  const limit = Math.min(o.limit ?? 200, 500);
  const rows = all(`SELECT * FROM timeline WHERE ${where.join(" AND ")} ORDER BY ts DESC LIMIT ?`, ...args, limit).reverse();
  return { rows, from, to, truncated: rows.length === limit };
}

export function timelineText(o: Parameters<typeof timeline>[0], width = 200): string {
  const { rows, from, to, truncated } = timeline(o);
  const head = `时间线 ${localStamp(from).slice(0, 16)} ~ ${localStamp(to).slice(0, 16)}，${rows.length} 条${truncated ? "（太多，只给最近的）" : ""}`;
  if (!rows.length) return `${head}\n（这段时间没有记录）`;
  return `${head}\n${rows.map((r) => {
    const t = String(r.text ?? "").replace(/\s*\n\s*/g, " / ");
    return `${localStamp(r.ts).slice(5, 16)} [${KIND_ZH[r.kind] ?? r.kind}] ${t.length > width ? t.slice(0, width) + "…" : t}${r.matter_id ? `（事 #${r.matter_id}）` : ""}${/^(note|approval|task|outlook|review|event):/.test(String(r.ref)) ? ` ‹${r.ref}›` : ""}`;
  }).join("\n")}`;
}

/** anything the owner did or said in this window (decides whether a day review is worth sending) */
export function ownerActivity(from: number, to: number) {
  return one(`SELECT COUNT(*) n FROM timeline WHERE ts>=? AND ts<? AND kind IN ('said','said_group','note','approval','matter')`, from, to)!.n as number;
}

// ───────────── 前瞻 (§觉2) ─────────────

const CAP: Record<string, number> = { day: 1, week: 3, month: 3, matter: 3 };
export interface OutlookItem { text: string; why_refs?: string[]; look_for?: string; revisit_at?: string }

export function periodOk(horizon: string, period: string): boolean {
  return horizon === "day" ? /^\d{4}-\d{2}-\d{2}$/.test(period) : horizon === "week" ? /^\d{4}-W\d{2}$/.test(period)
    : horizon === "month" ? /^\d{4}-\d{2}$/.test(period) : /^matter:\d+$/.test(period);
}

export function submitOutlook(o: { horizon: string; period: string; items: OutlookItem[]; runId: string; matterId?: number }): number[] {
  if (!periodOk(o.horizon, o.period)) throw new Error(`period for ${o.horizon} must look like ${{ day: "2026-11-18", week: "2026-W47", month: "2026-11", matter: "matter:3" }[o.horizon]}`);
  const have = one("SELECT COUNT(*) n FROM outlooks WHERE horizon=? AND period=?", o.horizon, o.period)!.n as number;
  if (have + o.items.length > CAP[o.horizon]) throw new Error(`${o.horizon} 前瞻最多 ${CAP[o.horizon]} 条，${o.period} 已经有 ${have} 条（写下后不能改；少而准）`);
  const matterId = o.matterId ?? (o.horizon === "matter" ? Number(o.period.slice(7)) : null);
  const ids = tx(() => o.items.map((it) => Number(run(
    "INSERT INTO outlooks(horizon, period, text, why_refs, look_for, revisit_at, matter_id, run_id, ts) VALUES(?,?,?,?,?,?,?,?,?)",
    o.horizon, o.period, it.text.trim(), JSON.stringify(it.why_refs ?? []), it.look_for ?? null, it.revisit_at ?? null, matterId, o.runId, Date.now()).lastInsertRowid)));
  for (const [i, it] of o.items.entries()) appendJournal(`前瞻 #${ids[i]}（${o.horizon} ${o.period}）：${it.text}${it.look_for ? `；到时留意：${it.look_for}` : ""}`, "outlook");
  if (o.horizon === "week" || o.horizon === "month") {
    const rel = `self/outlooks/${o.period}.md`, f = join(P.agentHome, rel);
    mkdirSync(dirname(f), { recursive: true });
    const cur = existsSync(f) ? readFileSync(f, "utf8") : `# ${o.horizon === "week" ? "周" : "月"}前瞻 ${o.period}\n\n写下后不改；回看追加在 outlook_revisits 里。\n`;
    writeFileSync(f, `${cur.trimEnd()}\n\n${o.items.map((it, i) => `## #${ids[i]} ${it.text}\n- 依据：${(it.why_refs ?? []).join("、") || "（无）"}\n- 到时留意：${it.look_for ?? "—"}\n- 回看：${it.revisit_at ?? "下一期复盘"}`).join("\n\n")}\n`);
  }
  return ids;
}

export function revisitOutlook(id: number, text: string, src: string, runId: string) {
  const o = one("SELECT * FROM outlooks WHERE id=?", id);
  if (!o) throw new Error(`no outlook #${id}`);
  run("INSERT INTO outlook_revisits(outlook_id, ts, text, src, run_id) VALUES(?,?,?,?,?)", id, Date.now(), text.trim(), src, runId);
  appendJournal(`回看前瞻 #${id}（${o.text.slice(0, 40)}）：${text}`, src);
}

export function outlooksText(horizon: string, period: string): string {
  const rows = all("SELECT * FROM outlooks WHERE horizon=? AND period=? ORDER BY id", horizon, period);
  if (!rows.length) return "（没有）";
  return rows.map((o) => {
    const rv = all("SELECT text FROM outlook_revisits WHERE outlook_id=? ORDER BY id", o.id).map((r) => r.text);
    return `#${o.id} ${o.text}${o.look_for ? `（到时留意：${o.look_for}）` : ""}${rv.length ? `\n  已回看：${rv.join(" / ")}` : ""}`;
  }).join("\n");
}

// ───────────── 习气 / 节律 (§改1, §寸3) ─────────────

const STATUS_ZH: Record<string, string> = { candidate: "候选", endorsed: "我认可", seeing_off: "送一程", dropped: "不认", faded: "淡了", let_go: "放下" };
export type SelfStatus = "candidate" | "endorsed" | "seeing_off" | "dropped" | "faded" | "let_go";

/** §寸4: status changes the morning diff counts (counts only: the content of self/ stays out of the admin group) */
function noteSelfChange(kind: "seeing_off" | "faded" | "let_go" | "back") {
  const c = JSON.parse(kvGet("self.changes") ?? "{}");
  c[kind] = (c[kind] ?? 0) + 1;
  kvSet("self.changes", JSON.stringify(c));
}
export function takeSelfChanges(peek = false): Record<string, number> {
  const c = JSON.parse(kvGet("self.changes") ?? "{}");
  if (!peek) kvSet("self.changes", "{}");
  return c;
}

export function listSelfItems(o: { kind?: string; statuses?: string[] } = {}) {
  const where: string[] = [], args: any[] = [];
  if (o.kind) { where.push("kind=?"); args.push(o.kind); }
  if (o.statuses?.length) { where.push(`status IN (${o.statuses.map(() => "?").join(",")})`); args.push(...o.statuses); }
  return all(`SELECT * FROM self_items ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY kind, status, id`, ...args);
}

export function selfItemsText(o: { kind?: string; statuses?: string[] } = {}) {
  const rows = listSelfItems(o);
  if (!rows.length) return "（还没有）";
  return rows.map((r) => `#${r.id} [${r.kind === "habit" ? "习气" : "节律"} · ${STATUS_ZH[r.status] ?? r.status}] ${r.text}（证据 ${JSON.parse(r.evidence_json ?? "[]").length} 条，最近 ${r.last_seen ? today(r.last_seen) : "—"}）`).join("\n");
}

/** dream: a new candidate, or more evidence for an existing one. Evidence checks happen in dream.ts. */
export function upsertCandidate(o: { id?: number; kind: "habit" | "rhythm"; text: string; evidence: string[]; ownerSaid: boolean }) {
  const now = Date.now();
  if (o.id) {
    const cur = one("SELECT * FROM self_items WHERE id=?", o.id);
    if (!cur) throw new Error(`no self item #${o.id}`);
    if (cur.status === "let_go") throw new Error(`#${o.id} 他放下了：不再为它攒证据，也不要换个说法重提`);
    const ev = [...new Set([...JSON.parse(cur.evidence_json ?? "[]"), ...o.evidence])];
    // §寸4: new evidence brings a faded item back only as a candidate; he has to endorse it again
    const status = cur.status === "faded" ? "candidate" : cur.status;
    run("UPDATE self_items SET evidence_json=?, owner_said=MAX(owner_said, ?), last_seen=?, updated_at=?, status=? WHERE id=?", JSON.stringify(ev), o.ownerSaid ? 1 : 0, now, now, status, o.id);
    if (status !== cur.status) {
      appendJournal(`${cur.kind === "habit" ? "习气" : "节律"} #${o.id}「${cur.text.slice(0, 40)}」淡了之后又有新证据 → 回到候选，要他再认一次`, "system");
      noteSelfChange("back");
    }
    renderSelf();
    return o.id;
  }
  const id = Number(run("INSERT INTO self_items(kind, text, status, evidence_json, owner_said, first_seen, last_seen, updated_at) VALUES(?,?,?,?,?,?,?,?)",
    o.kind, o.text.trim(), "candidate", JSON.stringify(o.evidence), o.ownerSaid ? 1 : 0, now, now, now).lastInsertRowid);
  renderSelf();
  return id;
}

/** the owner's word only: endorse, drop (不认: it's wrong), let go (放下: he stops carrying it), back to candidate,
 *  or bring back something from 送一程 / 淡了 / 放下 */
export function markSelfItem(id: number, status: Exclude<SelfStatus, "faded">, note?: string) {
  const cur = one("SELECT * FROM self_items WHERE id=?", id);
  if (!cur) throw new Error(`no self item #${id}`);
  run("UPDATE self_items SET status=?, note=?, updated_at=? WHERE id=?", status, note ?? cur.note, Date.now(), id);
  appendJournal(`${cur.kind === "habit" ? "习气" : "节律"} #${id}「${cur.text.slice(0, 40)}」：${STATUS_ZH[cur.status]} → ${STATUS_ZH[status]}${note ? `（${note}）` : ""}`, "owner@self");
  if (status === "let_go" && cur.status !== "let_go") noteSelfChange("let_go");
  renderSelf();
  return `#${id} ${STATUS_ZH[cur.status]} → ${STATUS_ZH[status]}`;
}

/** §寸4 淡了: an endorsed (or 送一程) item with no new evidence, mention or word from him for fade_days stops being cited.
 *  Nothing is deleted; new evidence brings it back as a candidate (upsertCandidate). Runs nightly before dream. */
export function fadeSelfItems(now = Date.now()): number[] {
  const { fade_days } = selfConf();
  const cutoff = now - fade_days * 86400_000;
  const stale = all(`SELECT s.id, s.kind, s.text FROM self_items s
    WHERE s.status IN ('endorsed','seeing_off')
      AND MAX(COALESCE(s.last_seen,0), COALESCE(s.updated_at,0), COALESCE((SELECT MAX(ts) FROM noticings n WHERE n.item_id=s.id),0)) < ?`, cutoff);
  for (const s of stale) {
    run("UPDATE self_items SET status='faded', updated_at=? WHERE id=?", now, s.id);
    appendJournal(`${s.kind === "habit" ? "习气" : "节律"} #${s.id}「${String(s.text).slice(0, 40)}」→ 淡了（${fade_days} 天没有新证据；不再引用，条目留着）`, "system");
    noteSelfChange("faded");
  }
  if (stale.length) renderSelf();
  return stale.map((s) => s.id);
}

export function renderSelf() {
  for (const [kind, file, title] of [["habit", "habits.md", "习气观察"], ["rhythm", "rhythms.md", "节律"]] as const) {
    const rows = listSelfItems({ kind });
    const sec = (st: string) => rows.filter((r) => r.status === st).map((r) => {
      const ev = JSON.parse(r.evidence_json ?? "[]") as string[];
      return `- **#${r.id}** ${r.text}\n  - 证据：${ev.join("、") || "—"}${r.owner_said ? "（含主人原话）" : ""}\n  - 首次 ${r.first_seen ? today(r.first_seen) : "—"}，最近 ${r.last_seen ? today(r.last_seen) : "—"}${r.note ? `\n  - 备注：${r.note}` : ""}`;
    }).join("\n") || "（无）";
    const text = `---\nvisibility: owner\n---\n# ${title}\n\n由代码按 self_items 生成，不要手改：要认可、不认、放下或改写，直接跟 agent 说。只描述行为，不下人格结论。\n\n## 我认可\n${sec("endorsed")}\n\n## 送一程（最近几次都是你自己先看见的；不再主动提）\n${sec("seeing_off")}\n\n## 候选\n${sec("candidate")}\n\n## 淡了（很久没有新证据；不再引用，再出现会回到候选）\n${sec("faded")}\n\n## 放下（你决定不再背着它；不再提，说「恢复」才回来）\n${sec("let_go")}\n\n## 不认\n${sec("dropped")}\n`;
    const f = join(P.agentHome, "self", file);
    mkdirSync(dirname(f), { recursive: true });
    if (!existsSync(f) || readFileSync(f, "utf8") !== text) writeFileSync(f, text);
  }
}

// ───────────── 复盘 (§觉4) + 谁先看见 ─────────────

export interface Noticing { item_id?: number; item_text: string; who: "owner" | "agent"; prompted?: boolean; quote?: string }
export interface QuestionFeedback { q: string; response: "talked" | "short" | "declined" | "none" }

export function submitReview(o: {
  kind: "day" | "week" | "month" | "matter"; period: string; matterId?: number; facts: string; ownerWords: string[]; agentNotes?: string;
  noticings: Noticing[]; questions: QuestionFeedback[]; runId: string;
  /** only when code files it (§觉4): how the round ended, and a line saying so in place of his words */
  delivery?: "sent" | "replied" | "not_sent"; deliveryNote?: string;
}): { id: number; rel: string; hints: string[] } {
  const words = o.ownerWords.map((w) => w.trim()).filter(Boolean);
  const chatted = words.length > 0;
  // §寸3: credit to the owner only with a quote of what he said here
  for (const n of o.noticings) {
    if (n.who === "owner" && (!n.quote || !words.some((w) => w.includes(n.quote!.trim()) || n.quote!.includes(w))))
      throw new Error(`noticing「${n.item_text}」记成主人先看见，需要 quote 是他在这次复盘里的原话（owner_words 里的一句）`);
    if (n.item_id && !one("SELECT 1 FROM self_items WHERE id=?", n.item_id)) throw new Error(`no self item #${n.item_id}`);
  }
  // code's 未聊 is a placeholder: a real conversation filed later replaces the row, and an empty filing adds nothing
  const placeholder = o.kind === "matter" ? undefined : one("SELECT id, file_path FROM reviews WHERE kind=? AND period=? AND delivery IS NOT NULL", o.kind, o.period);
  if (placeholder && !chatted) return { id: placeholder.id, rel: placeholder.file_path, hints: [] };
  if (placeholder) run("DELETE FROM reviews WHERE id=?", placeholder.id);
  const notes = chatted ? (o.agentNotes?.trim() || "") : "";
  const md = `## 事实\n${o.facts.trim()}\n\n## 我说的（原话）\n${chatted ? words.map((w) => `- ${w}`).join("\n") : `未聊${o.deliveryNote ? `（${o.deliveryNote}）` : ""}`}\n\n## 对照（agent 从记录里注意到的，不是结论）\n${notes || (chatted ? "（无）" : "未聊时不写")}\n`;
  let rel: string;
  if (o.kind === "matter") {
    if (!o.matterId) throw new Error("matter review needs matter_id");
    const m = one("SELECT * FROM matters WHERE id=?", o.matterId);
    if (!m) throw new Error(`no matter #${o.matterId}`);
    rel = m.file_path ?? `matters/${o.matterId}.md`;
    const f = join(P.agentHome, rel);
    const cur = existsSync(f) ? readFileSync(f, "utf8") : `# ${m.title}\n`;
    writeFileSync(f, `${cur.trimEnd()}\n\n# 复盘（${today()}）\n\n${md.replace(/^## /gm, "### ")}`);
    run("UPDATE matters SET status='reviewed', reviewed_at=? WHERE id=?", Date.now(), o.matterId);
  } else {
    rel = `self/reviews/${o.period}-${o.kind}.md`;
    const f = join(P.agentHome, rel);
    mkdirSync(dirname(f), { recursive: true });
    const cur = existsSync(f) ? readFileSync(f, "utf8").trimEnd() + "\n\n---\n\n" : `---\nvisibility: owner\n---\n# ${{ day: "日", week: "周", month: "月" }[o.kind]}复盘 ${o.period}\n\n`;
    writeFileSync(f, `${cur}${md}`);
  }
  const id = Number(run("INSERT INTO reviews(kind, period, matter_id, facts, owner_words, agent_notes, status, file_path, run_id, ts, delivery) VALUES(?,?,?,?,?,?,?,?,?,?,?)",
    o.kind, o.period, o.matterId ?? null, o.facts, JSON.stringify(words), notes || null, chatted ? "chatted" : "unchatted", rel, o.runId, Date.now(), o.delivery ?? null).lastInsertRowid);
  for (const w of words) appendJournal(`复盘 #${id}（${o.kind} ${o.period}）他说：${w}`, `review@${o.kind}`);
  for (const q of o.questions) signal("review_question", { role: "reflect", run_id: o.runId, value: { review: id, kind: o.kind, ...q } });   // §进2.2 陪伴
  const hints: string[] = [];
  for (const n of o.noticings) {
    run("INSERT INTO noticings(ts, item_id, item_text, who, prompted, quote, review_id, run_id) VALUES(?,?,?,?,?,?,?,?)",
      Date.now(), n.item_id ?? null, n.item_text, n.who, n.prompted ? 1 : 0, n.quote ?? null, id, o.runId);
    if (n.item_id) { const h = seeOff(n.item_id); if (h) hints.push(h); }
  }
  log("life", "review", { id, kind: o.kind, period: o.period, chatted, noticings: o.noticings.length });
  return { id, rel, hints };
}

/** §寸3 送一程: the last N noticings of an endorsed item were all the owner's → seeing_off. The way back needs his word. */
export function seeOff(itemId: number): string | undefined {
  const item = one("SELECT * FROM self_items WHERE id=?", itemId);
  if (!item) return;
  const { see_off_after, restore_after } = selfConf();
  if (item.status === "endorsed") {
    const last = all("SELECT who FROM noticings WHERE item_id=? ORDER BY id DESC LIMIT ?", itemId, see_off_after);
    if (last.length === see_off_after && last.every((r) => r.who === "owner")) {
      run("UPDATE self_items SET status='seeing_off', updated_at=? WHERE id=?", Date.now(), itemId);
      appendJournal(`习气 #${itemId}「${item.text.slice(0, 40)}」→ 送一程（最近 ${see_off_after} 次都是他自己先看见的）`, "system");
      noteSelfChange("seeing_off");
      renderSelf();
      return `#${itemId}「${item.text}」最近 ${see_off_after} 次都是他自己先看见的，转为「送一程」：以后起局、前瞻里不再主动提，他问才说。可以轻轻告诉他一声，不用夸。`;
    }
  }
  if (item.status === "seeing_off") {
    const last = all("SELECT who FROM noticings WHERE item_id=? ORDER BY id DESC LIMIT ?", itemId, restore_after);
    if (last.length === restore_after && last.every((r) => r.who === "agent"))
      return `#${itemId}「${item.text}」送一程之后，最近 ${restore_after} 次都是你从记录里看出来的。问他一句：「这条我又开始提醒了，你觉得需要吗？」他说需要才用 self_mark 改回 endorsed；说不需要就不动。`;
  }
}

/** a mirror, not a KPI (§寸3): how many mentions this period were seen first by him */
export function noticingsSummary(from: number, to: number): string {
  const rows = all("SELECT who, COUNT(*) n FROM noticings WHERE ts>=? AND ts<? GROUP BY who", from, to);
  const n = (w: string) => Number(rows.find((r) => r.who === w)?.n ?? 0);
  return n("owner") + n("agent") ? `这段时间提到习气 / 节律 ${n("owner") + n("agent")} 次，其中 ${n("owner")} 次是他自己先看见的` : "这段时间没有提到习气 / 节律";
}
