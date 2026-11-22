// SQLite (DESIGN §底5, M0 subset). node:sqlite, WAL, one connection, synchronous API.
//
// inbox is the single source of truth for "what woke us up"; outbox for "what we said"; runs.side_effects decides
// whether an interrupted run may be retried (§底1.2).

import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { P } from "./config.ts";

mkdirSync(dirname(P.db), { recursive: true });
export const db = new DatabaseSync(P.db);
db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA busy_timeout=5000;");

db.exec(`
CREATE TABLE IF NOT EXISTS messages(
  id TEXT PRIMARY KEY, surface TEXT, chat_id TEXT, thread_id TEXT, sender_id TEXT, sender_kind TEXT,
  ts INTEGER, text TEXT, media_ref TEXT, raw_json TEXT, triage_status TEXT, lane TEXT);
CREATE INDEX IF NOT EXISTS messages_lane_ts ON messages(lane, ts);
CREATE INDEX IF NOT EXISTS messages_chat_ts ON messages(chat_id, ts);

CREATE TABLE IF NOT EXISTS sessions(
  key TEXT PRIMARY KEY, harness TEXT, session_ref TEXT, generation INTEGER NOT NULL DEFAULT 0,
  surface TEXT, tier TEXT, model TEXT, status TEXT NOT NULL DEFAULT 'active',  -- active | roll
  started INTEGER, last_active INTEGER, summary TEXT);

CREATE TABLE IF NOT EXISTS chat_cursors(
  chat_id TEXT, surface TEXT, last_msg_ts INTEGER, last_msg_id TEXT, updated_at INTEGER,
  PRIMARY KEY(chat_id, surface));

CREATE TABLE IF NOT EXISTS inbox(
  id INTEGER PRIMARY KEY AUTOINCREMENT, lane TEXT NOT NULL, kind TEXT NOT NULL,
  source TEXT NOT NULL, source_msg_id TEXT NOT NULL, turn_ctx_json TEXT, payload_json TEXT,
  status TEXT NOT NULL DEFAULT 'received',  -- received|processing|done|interrupted|failed|dropped
  run_id TEXT, ts INTEGER NOT NULL,
  UNIQUE(source, source_msg_id));
CREATE INDEX IF NOT EXISTS inbox_status_lane ON inbox(status, lane, id);

CREATE TABLE IF NOT EXISTS runs(
  id TEXT PRIMARY KEY, lane TEXT, session_key TEXT, session_ref TEXT, role TEXT, tier TEXT, model TEXT,
  status TEXT NOT NULL,                     -- running|done|failed|aborted|interrupted
  stop_reason TEXT, side_effects INTEGER NOT NULL DEFAULT 0, error TEXT, started INTEGER, ended INTEGER);
CREATE INDEX IF NOT EXISTS runs_status ON runs(status);

CREATE TABLE IF NOT EXISTS run_tokens(
  hash TEXT PRIMARY KEY, run_id TEXT, tier TEXT, requester_id TEXT,
  budget_output INTEGER, spent_output INTEGER NOT NULL DEFAULT 0, expires INTEGER,
  status TEXT NOT NULL DEFAULT 'active');  -- active|revoked|budget_exhausted

CREATE TABLE IF NOT EXISTS outbox(
  id INTEGER PRIMARY KEY AUTOINCREMENT, approval_id INTEGER UNIQUE, run_id TEXT, lane TEXT,
  channel TEXT NOT NULL, target_json TEXT NOT NULL, payload TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued',    -- queued|sending|sent|failed|unknown|expired
  attempts INTEGER NOT NULL DEFAULT 0, idem_key TEXT UNIQUE, send_by INTEGER, next_try INTEGER,
  sent_msg_id TEXT, error TEXT, ts INTEGER);
CREATE INDEX IF NOT EXISTS outbox_status ON outbox(status, id);

CREATE TABLE IF NOT EXISTS usage(
  id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER, run_id TEXT, task_id TEXT, tier TEXT, endpoint TEXT,
  model TEXT, requester_id TEXT, input_tokens INTEGER, output_tokens INTEGER, cache_read INTEGER,
  cache_write INTEGER, cost REAL, status INTEGER, ms INTEGER);
CREATE INDEX IF NOT EXISTS usage_ts ON usage(ts);

CREATE TABLE IF NOT EXISTS config_changes(id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER, file TEXT, diff TEXT, source TEXT);
CREATE TABLE IF NOT EXISTS kv(k TEXT PRIMARY KEY, v TEXT);

-- M1 (§底3.3). kind: send|plan|deferred_tool; status: pending|approved|rejected|expired|superseded|invalidated
CREATE TABLE IF NOT EXISTS approvals(
  id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL, origin_lane TEXT, run_id TEXT, task_id TEXT, tool_use_id TEXT,
  requester TEXT, channel TEXT, target_json TEXT, as_identity TEXT, title TEXT, draft TEXT,
  draft_version INTEGER NOT NULL DEFAULT 1, context_json TEXT, checks_json TEXT, expert_json TEXT,
  trigger_chat TEXT, trigger_msg_id TEXT, trigger_ts INTEGER, status TEXT NOT NULL DEFAULT 'pending', superseded_by INTEGER,
  expires_at INTEGER, decided_by TEXT, decided_at INTEGER, decide_note TEXT, revise_notes TEXT, final_text TEXT, result TEXT,
  card_msg_id TEXT, matter_id INTEGER, ts INTEGER);
CREATE INDEX IF NOT EXISTS approvals_status ON approvals(status, trigger_chat);

-- M2 (§办1.3). status: queued|running|waiting_approval|needs_input|interrupted|done|failed|cancelled
CREATE TABLE IF NOT EXISTS tasks(
  id TEXT PRIMARY KEY, origin_lane TEXT, origin_turn_json TEXT, goal TEXT, context TEXT, status TEXT NOT NULL, tier TEXT,
  repo TEXT, allow_json TEXT, budget INTEGER, timeout_ms INTEGER, workdir TEXT, session_ref TEXT, wb_root_msg TEXT,
  wb_thread TEXT, question TEXT, result_json TEXT, error TEXT, matter_id INTEGER, last_output_at INTEGER, runs INTEGER NOT NULL DEFAULT 0,
  started INTEGER, ended INTEGER, ts INTEGER);

-- §底4: follow-ups (schedules from jobs.yaml come in M3)
CREATE TABLE IF NOT EXISTS timers(
  id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL, lane TEXT, turn_json TEXT, due_at INTEGER NOT NULL, note TEXT,
  status TEXT NOT NULL DEFAULT 'pending', matter_id INTEGER, created_by TEXT, fired_at INTEGER, ts INTEGER);
CREATE INDEX IF NOT EXISTS timers_due ON timers(status, due_at);

-- §读3.1. status: open|active|closing|reviewed|dropped|done|merged (done: finished without a 复盘, e.g. §读2.6 import; merged: see merged_into)
-- keys (v0.13, JSON list): other names / topics for it; Triage links what it reads by these (§读2.5)
CREATE TABLE IF NOT EXISTS matters(
  id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT, domain TEXT, lane TEXT, status TEXT NOT NULL DEFAULT 'open',
  close_condition TEXT, file_path TEXT, opened_at INTEGER, closed_at INTEGER, reviewed_at INTEGER);

-- §进2, M1 only records. src is always the owner's behaviour
CREATE TABLE IF NOT EXISTS signals(
  id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER, kind TEXT, role TEXT, run_id TEXT, approval_id INTEGER, task_id TEXT,
  value_json TEXT, src TEXT);

-- chat list cache for the observer (user identity); groups.yaml stays the source of truth for activation
CREATE TABLE IF NOT EXISTS chats(chat_id TEXT PRIMARY KEY, name TEXT, external INTEGER, muted INTEGER, chat_mode TEXT, seen_at INTEGER);

-- M3c (§读3, §读5, §参1, §觉). Everything below is owner-only: no tool for others, Triage or workers reads it.
-- 随手记 (§读5.3). domain: work|family|friends|body|mind
CREATE TABLE IF NOT EXISTS life_notes(id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER, text TEXT NOT NULL, domain TEXT, matter_id INTEGER, people TEXT, src TEXT);
CREATE INDEX IF NOT EXISTS life_notes_ts ON life_notes(ts);
-- 前瞻 (§觉2). Frozen once written; feelings come later as outlook_revisits rows. horizon: day|week|month|matter
CREATE TABLE IF NOT EXISTS outlooks(id INTEGER PRIMARY KEY AUTOINCREMENT, horizon TEXT NOT NULL, period TEXT NOT NULL, text TEXT NOT NULL,
  why_refs TEXT, look_for TEXT, revisit_at TEXT, matter_id INTEGER, run_id TEXT, ts INTEGER);
CREATE INDEX IF NOT EXISTS outlooks_period ON outlooks(horizon, period);
CREATE TABLE IF NOT EXISTS outlook_revisits(id INTEGER PRIMARY KEY AUTOINCREMENT, outlook_id INTEGER NOT NULL, ts INTEGER, text TEXT, src TEXT, run_id TEXT);
-- 复盘 (§觉4). kind: day|week|month|matter; status: chatted|unchatted
CREATE TABLE IF NOT EXISTS reviews(id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL, period TEXT NOT NULL, matter_id INTEGER, facts TEXT,
  owner_words TEXT, agent_notes TEXT, status TEXT NOT NULL, file_path TEXT, run_id TEXT, ts INTEGER);
-- 习气 / 节律 (§改1, §寸4). status: candidate|endorsed|seeing_off|faded|let_go|dropped. self/habits.md and rhythms.md are rendered from here.
CREATE TABLE IF NOT EXISTS self_items(id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL, text TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'candidate',
  evidence_json TEXT, owner_said INTEGER NOT NULL DEFAULT 0, first_seen INTEGER, last_seen INTEGER, updated_at INTEGER, note TEXT);
-- 谁先看见 (§寸3). who: owner|agent; prompted: the owner said it after an open question (still counts as owner)
CREATE TABLE IF NOT EXISTS noticings(id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER, item_id INTEGER, item_text TEXT, who TEXT NOT NULL,
  prompted INTEGER NOT NULL DEFAULT 0, quote TEXT, review_id INTEGER, run_id TEXT);
CREATE INDEX IF NOT EXISTS noticings_item ON noticings(item_id, ts);

-- M6 §参1 解读账本: a lens's view, written before the fact and never edited; revisits are appended.
-- status: queued|running|done|failed. lens 'agent' = the facts-only view next to a lens (optional).
CREATE TABLE IF NOT EXISTS readings(id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER, lens TEXT NOT NULL, method TEXT, profile_version TEXT,
  question TEXT, horizon TEXT, period TEXT, matter_id INTEGER, reading TEXT, notice_json TEXT, claims_json TEXT, chart_ref TEXT,
  status TEXT NOT NULL DEFAULT 'queued', error TEXT, run_id TEXT, origin_lane TEXT, origin_turn_json TEXT, requested_by TEXT, done_at INTEGER);
CREATE INDEX IF NOT EXISTS readings_period ON readings(horizon, period);
-- M7 §进2. eval_cases: collected by code; expected is always his (the text he sent / raise / no_draft). kind: draft|triage
CREATE TABLE IF NOT EXISTS eval_cases(id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL, ref TEXT NOT NULL UNIQUE, input TEXT NOT NULL,
  expected TEXT NOT NULL, meta_json TEXT, src TEXT, ts INTEGER);
-- proposals. status: proposed|approved|rejected|expired|superseded|conflict|kept|rolled_back
CREATE TABLE IF NOT EXISTS proposals(id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER, run_id TEXT, target TEXT NOT NULL, problem TEXT, change TEXT,
  evidence_json TEXT, old_content TEXT, new_content TEXT NOT NULL, old_version TEXT, new_version TEXT, replay_json TEXT,
  status TEXT NOT NULL DEFAULT 'proposed', approval_id INTEGER, decide_note TEXT, applied_at INTEGER, applied_sha TEXT, review_due INTEGER,
  review_json TEXT, rollback_approval_id INTEGER);
CREATE INDEX IF NOT EXISTS proposals_status ON proposals(status, review_due);
CREATE TABLE IF NOT EXISTS reading_revisits(id INTEGER PRIMARY KEY AUTOINCREMENT, reading_id INTEGER NOT NULL, claim_idx INTEGER,
  ts INTEGER, text TEXT, src TEXT, run_id TEXT);
-- console §触5.4: the full model request of main and draft runs (gzip), owner-only, kept 7 days; no agent tool reads it
CREATE TABLE IF NOT EXISTS requests(id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, run_id TEXT, usage_id INTEGER, tier TEXT, model TEXT, bytes INTEGER, body BLOB);
CREATE INDEX IF NOT EXISTS requests_ts ON requests(ts);
CREATE INDEX IF NOT EXISTS requests_run ON requests(run_id);
-- v0.13 §读2.5 事件账本: meaningful moments from any source, hung on a matter (事) or a loose topic (话头).
-- kind: ask|decision|commitment|progress|risk|deadline|info · level: fyi|watch|reply|decide
-- state: open (reply / decide not handled yet) | done | dropped | seen (fyi / watch) · source: a sources.yaml id, 'import'
-- place_id = the chat (or source place) it happened in: the owner speaking there later closes its open asks.
CREATE TABLE IF NOT EXISTS events(id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, source TEXT NOT NULL, ref TEXT NOT NULL,
  place TEXT, place_id TEXT, actor TEXT, kind TEXT NOT NULL, level TEXT NOT NULL, summary TEXT NOT NULL, link TEXT, domain TEXT,
  matter_id INTEGER, topic TEXT, state TEXT NOT NULL, done_at INTEGER, done_by TEXT, msg_ids TEXT, created_at INTEGER,
  UNIQUE(source, ref));
CREATE INDEX IF NOT EXISTS events_matter ON events(matter_id, ts);
CREATE INDEX IF NOT EXISTS events_topic ON events(topic, ts);
CREATE INDEX IF NOT EXISTS events_open ON events(state, level, ts);
CREATE INDEX IF NOT EXISTS events_place ON events(place_id, state);
-- §读2.6 imports from another harness. status: applied|undone. summary_json: counts + the matter ids it created.
CREATE TABLE IF NOT EXISTS imports(id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER, origin TEXT, sha TEXT, raw_path TEXT, summary_json TEXT,
  commit_sha TEXT, status TEXT NOT NULL DEFAULT 'applied');
-- v0.14 §读4 因缘. persons = everyone met (no permission meaning: trust stays in people.yaml, §读4.2); his merges, splits,
-- circles and notes live here. aliases: kind feishu|wechat (ids) or name; a name may point at several persons (ambiguous).
-- cluster is derived (rebuilt with the graph). relations: person ↔ person, conf EXTRACTED (he confirmed) | INFERRED.
CREATE TABLE IF NOT EXISTS persons(id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, slug TEXT, config_key TEXT, circle TEXT, note TEXT,
  first_seen INTEGER, first_via TEXT, last_seen INTEGER, cluster INTEGER, status TEXT NOT NULL DEFAULT 'active', merged_into INTEGER, created_at INTEGER);
CREATE TABLE IF NOT EXISTS person_aliases(kind TEXT NOT NULL, alias TEXT NOT NULL, person_id INTEGER NOT NULL, src TEXT, ts INTEGER,
  PRIMARY KEY(kind, alias, person_id));
CREATE INDEX IF NOT EXISTS person_aliases_p ON person_aliases(person_id);
CREATE TABLE IF NOT EXISTS relations(id INTEGER PRIMARY KEY AUTOINCREMENT, a INTEGER NOT NULL, b INTEGER NOT NULL, rel TEXT NOT NULL,
  conf TEXT NOT NULL, src TEXT, evidence TEXT, ts INTEGER, status TEXT NOT NULL DEFAULT 'active');
-- derived view of everything above + messages / events / matters / pages; dropped and rebuilt, never edited
CREATE TABLE IF NOT EXISTS graph_edges(a TEXT NOT NULL, b TEXT NOT NULL, rel TEXT NOT NULL, conf TEXT NOT NULL, weight REAL NOT NULL,
  first_ts INTEGER, last_ts INTEGER, evidence TEXT, PRIMARY KEY(a, b, rel));
CREATE INDEX IF NOT EXISTS graph_edges_b ON graph_edges(b);
CREATE TABLE IF NOT EXISTS graph_nodes(id TEXT PRIMARY KEY, kind TEXT NOT NULL, label TEXT, ts INTEGER);
-- v0.19 §读3.1: every regrouping or correction of matters / events, with what it takes to put it back.
-- kind: merge|attach|main|detach|status|event|move|topic|rename · touches (JSON): m<id> / e<id> it changed
CREATE TABLE IF NOT EXISTS matter_ops(id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, kind TEXT NOT NULL, summary TEXT, why TEXT, by TEXT NOT NULL,
  review_id INTEGER, touches TEXT NOT NULL DEFAULT '[]', undo_json TEXT, undone_at INTEGER, undone_by TEXT);
-- v0.19 §读3.2 每日整理: suggestions only; nothing changes until he acts on one. fp identifies the question, so a settled one is not asked again.
-- kind: group|stale|old_ask|suspect|topic · status: pending|shown|acted|ok|void
CREATE TABLE IF NOT EXISTS matter_reviews(id INTEGER PRIMARY KEY AUTOINCREMENT, fp TEXT NOT NULL UNIQUE, kind TEXT NOT NULL, prio INTEGER NOT NULL DEFAULT 0,
  why TEXT, data_json TEXT NOT NULL, origin TEXT NOT NULL DEFAULT 'code', status TEXT NOT NULL DEFAULT 'pending', shown_n INTEGER NOT NULL DEFAULT 0, last_shown INTEGER,
  snooze_until INTEGER, created_at INTEGER, decided_at INTEGER, decided_by TEXT, action TEXT, op_id INTEGER);
CREATE INDEX IF NOT EXISTS matter_reviews_status ON matter_reviews(status, snooze_until);
`);

// additive migrations (ALTER TABLE ADD COLUMN fails if it already exists)
for (const [table, col] of [["outbox", "kind TEXT NOT NULL DEFAULT 'text'"], ["outbox", "card_id TEXT"],
  ["outbox", "as_identity TEXT NOT NULL DEFAULT 'bot'"], ["messages", "triage_action TEXT"], ["messages", "triage_note TEXT"],
  ["runs", "input_ref TEXT"], ["runs", "versions_json TEXT"], ["runs", "task_id TEXT"], ["tasks", "next_prompt TEXT"], ["tasks", "approval_id INTEGER"],
  ["messages", "event_id INTEGER"], ["matters", "keys TEXT"], ["tasks", "mode TEXT"],
  ["messages", "attn TEXT"], ["messages", "wait_until INTEGER"],
  ["matters", "parent_id INTEGER"], ["matters", "merged_into INTEGER"],
  ["inbox", "not_before INTEGER"], ["readings", "not_before INTEGER"], ["readings", "retries INTEGER"], ["reviews", "delivery TEXT"]]) {
  try { db.exec(`ALTER TABLE ${table} ADD COLUMN ${col}`); } catch { /* already there */ }
}
// §读2.4 attention window. attn: waiting (in its window) | answered (he responded, nothing sent) | read (not an ask, he has read it) | held (over the cap, for the morning report)
db.exec("CREATE INDEX IF NOT EXISTS messages_attn ON messages(attn, wait_until)");
// §底4.3 inbox.not_before: a scheduled event waiting out an upstream failure. §觉4 reviews.delivery, on rows code wrote:
// sent (he didn't answer) | replied (he answered, nothing was filed) | not_sent. review_open: went out or is going out, not filed yet.
db.exec(`CREATE TABLE IF NOT EXISTS review_open(id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL, period TEXT NOT NULL, facts TEXT,
  fired_at INTEGER, deadline INTEGER NOT NULL, inbox_key TEXT, run_id TEXT, UNIQUE(kind, period))`);
// §读3.1 主线 and 子事: parent_id is one level deep; merged_into points at the matter a duplicate became (status 'merged')
db.exec("CREATE INDEX IF NOT EXISTS matters_parent ON matters(parent_id)");

export type Row = Record<string, any>;
export const one = (sql: string, ...a: any[]): Row | undefined => db.prepare(sql).get(...a) as Row | undefined;
export const all = (sql: string, ...a: any[]): Row[] => db.prepare(sql).all(...a) as Row[];
export const run = (sql: string, ...a: any[]) => db.prepare(sql).run(...a);

let depth = 0;
/** Nested calls join the outer transaction. */
export function tx<T>(fn: () => T): T {
  if (depth > 0) return fn();
  db.exec("BEGIN IMMEDIATE");
  depth++;
  try {
    const r = fn();
    db.exec("COMMIT");
    return r;
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  } finally {
    depth--;
  }
}

export const kvGet = (k: string) => one("SELECT v FROM kv WHERE k=?", k)?.v as string | undefined;
export const kvSet = (k: string, v: string) => run("INSERT INTO kv(k,v) VALUES(?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v", k, v);
/** §进2: record an owner-behaviour signal. Only recorded in M1, never analyzed. */
export const signal = (kind: string, o: { role?: string; run_id?: string; approval_id?: number; task_id?: string; value?: unknown } = {}) =>
  run("INSERT INTO signals(ts, kind, role, run_id, approval_id, task_id, value_json, src) VALUES(?,?,?,?,?,?,?,?)",
    Date.now(), kind, o.role ?? null, o.run_id ?? null, o.approval_id ?? null, o.task_id ?? null, o.value === undefined ? null : JSON.stringify(o.value), "owner");
