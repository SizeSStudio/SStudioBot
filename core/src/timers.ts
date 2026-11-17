// Scheduler (DESIGN §9.1). Two kinds of timers in one table:
//   - follow-up (one-off, set by the main agent): when due, a `timer` event goes into its lane, then it is done
//   - schedule (from config/jobs.yaml, hot-reloaded): one row per job; when due it fires and moves to the next time.
//     A schedule missed while the core was down (> GRACE late) is not run, only recorded as missed; one whose previous
//     firing is still pending or running is skipped.
// A timer never runs a model itself. Jobs either put an event into a lane (do: event / morning) or call a code
// handler (do: dream / dream_diff …) that the core registers.

import { all, one, run, tx, kvGet, kvSet } from "./db.ts";
import { jobsConf, log, TZ, type JobSpec } from "./config.ts";
import { localStamp } from "./memory.ts";
import type { TurnContext } from "./tools.ts";

const TICK_MS = 30_000;
const GRACE_MS = 15 * 60_000;
export const OWNER_LANE = "feishu:dm:owner";

/** "2026-11-19 15:00" / "2026-11-19T15:00" in the owner's timezone → epoch ms */
export function parseLocal(s: string): number | undefined {
  const m = /^(\d{4}-\d{2}-\d{2})[ T](\d{1,2}):(\d{2})/.exec(s.trim());
  if (!m) return undefined;
  const asUtc = Date.parse(`${m[1]}T${m[2].padStart(2, "0")}:${m[3]}:00Z`);
  const shown = Date.parse(new Date(asUtc).toLocaleString("sv-SE", { timeZone: TZ }).replace(" ", "T") + "Z");
  return Number.isNaN(asUtc) ? undefined : asUtc - (shown - asUtc);   // subtract the zone's offset at that moment
}

/** next firing strictly after `after`, in the owner's timezone */
export function nextDue(j: JobSpec, after = Date.now()): number | undefined {
  if (!/^\d{1,2}:\d{2}$/.test(String(j.at ?? ""))) return undefined;
  for (let d = 0; d <= 62; d++) {
    const date = localStamp(after + d * 86400_000).slice(0, 10);
    const wd = new Date(`${date}T12:00:00Z`).getUTCDay(), md = Number(date.slice(8));
    if (j.every === "week" && wd !== Number(j.weekday ?? 0)) continue;
    if (j.every === "month" && md !== Number(j.day ?? 1)) continue;
    const t = parseLocal(`${date} ${j.at}`);
    if (t && t > after) return t;
  }
  return undefined;
}

export function ownerTurn(): TurnContext | undefined {
  const dm = kvGet("feishu.owner_dm_chat");
  return dm ? { channel: "feishu", chat_id: dm, surface: "feishu:dm" } : undefined;
}

export function addFollowup(o: { lane: string; turn: TurnContext; due: number; note: string; matterId?: number; by: string }) {
  const r = run("INSERT INTO timers(kind, lane, turn_json, due_at, note, matter_id, created_by, ts) VALUES(?,?,?,?,?,?,?,?)",
    "followup", o.lane, JSON.stringify({ ...o.turn, message_id: undefined, in_thread: o.turn.in_thread }), o.due, o.note, o.matterId ?? null, o.by, Date.now());
  return Number(r.lastInsertRowid);
}

export const listFollowups = (lane?: string) =>
  all(`SELECT * FROM timers WHERE kind='followup' AND status='pending' ${lane ? "AND lane=?" : ""} ORDER BY due_at`, ...(lane ? [lane] : []));

export const cancelFollowup = (id: number) => run("UPDATE timers SET status='cancelled' WHERE id=? AND kind='followup' AND status='pending'", id).changes > 0;

/** code handlers for jobs (do: <name>); `event` and `morning` are built in */
export type JobHandler = (name: string, job: JobSpec) => Promise<void>;
/** builds the factual digest for the morning report (§9.1, §9.3); registered by main to avoid an import cycle */
export type EventText = (name: string, job: JobSpec) => string | undefined;

export class Scheduler {
  private timer?: NodeJS.Timeout;
  private onFire: () => void;
  private handlers: Record<string, JobHandler>;
  private texts: Record<string, EventText>;
  private busy = new Set<string>();
  private synced = "";
  constructor(onFire: () => void, handlers: Record<string, JobHandler> = {}, texts: Record<string, EventText> = {}) {
    this.onFire = onFire; this.handlers = handlers; this.texts = texts;
  }
  start() { this.timer = setInterval(() => this.tick(), TICK_MS); this.tick(); }
  stop() { clearInterval(this.timer); }

  /** jobs.yaml → one pending `schedule` row per job; changed specs get a new due time; removed jobs are cancelled */
  syncJobs() {
    const jobs = jobsConf();
    const sig = JSON.stringify(jobs);
    if (sig === this.synced) return;
    this.synced = sig;
    tx(() => {
      const rows = all("SELECT * FROM timers WHERE kind='schedule' AND status='pending'");
      for (const r of rows) if (!jobs[r.note]) run("UPDATE timers SET status='cancelled' WHERE id=?", r.id);
      for (const [name, j] of Object.entries(jobs)) {
        const spec = JSON.stringify(j);
        const cur = rows.find((r) => r.note === name);
        if (cur && cur.turn_json === spec) continue;
        const due = nextDue(j);
        if (!due) { log("timer", "bad job spec, ignored", { job: name }); if (cur) run("UPDATE timers SET status='cancelled' WHERE id=?", cur.id); continue; }
        if (cur) run("UPDATE timers SET turn_json=?, due_at=? WHERE id=?", spec, due, cur.id);
        else run("INSERT INTO timers(kind, lane, turn_json, due_at, note, created_by, ts) VALUES(?,?,?,?,?,?,?)", "schedule", j.lane ?? OWNER_LANE, spec, due, name, "jobs.yaml", Date.now());
      }
    });
    log("timer", "jobs synced", { jobs: Object.keys(jobs) });
  }

  tick() {
    try { this.syncJobs(); } catch (e: any) { log("timer", "jobs.yaml sync failed", { err: String(e?.message ?? e) }); }
    const now = Date.now();
    const due = all("SELECT * FROM timers WHERE status='pending' AND due_at<=? ORDER BY due_at LIMIT 50", now);
    let fired = false;
    for (const t of due) {
      if (t.kind === "schedule") { fired = this.fireJob(t, now) || fired; continue; }
      tx(() => {
        const late = now - t.due_at > 10 * 60_000 ? `（本该 ${localStamp(t.due_at).slice(5)} 提醒，核心当时不在线，晚了）` : "";
        run(`INSERT OR IGNORE INTO inbox(lane, kind, source, source_msg_id, turn_ctx_json, payload_json, status, ts) VALUES(?,?,?,?,?,?,?,?)`,
          t.lane, "timer", "timer", `${t.id}:${t.due_at}`, t.turn_json,
          JSON.stringify({ text: `【到点了：follow-up #${t.id}，${localStamp(t.ts).slice(5)} 设的${late}】${t.note}${t.matter_id ? `（事 #${t.matter_id}）` : ""}`, ts: now, quota: true }),
          "received", now);
        run("UPDATE timers SET status='done', fired_at=? WHERE id=?", now, t.id);
      });
      log("timer", "fired", { id: t.id, lane: t.lane });
      fired = true;
    }
    if (fired) this.onFire();
  }

  private fireJob(t: Record<string, any>, now: number): boolean {
    const j: JobSpec = JSON.parse(t.turn_json);
    const name = t.note as string;
    const next = nextDue(j, Math.max(now, t.due_at));
    const advance = (outcome: string) => {
      run("UPDATE timers SET due_at=?, fired_at=? WHERE id=?", next ?? now + 86400_000, now, t.id);
      kvSet(`job.${name}.last`, JSON.stringify({ at: now, due: t.due_at, outcome }));
      log("timer", `job ${outcome}`, { job: name, next: next ? localStamp(next) : null });
    };
    if (now - t.due_at > GRACE_MS) { advance("missed"); return false; }
    if (j.do === "event" || j.do === "morning" || this.texts[j.do]) {
      if (one("SELECT 1 FROM inbox WHERE source='job' AND source_msg_id LIKE ? AND status IN ('received','processing')", `${name}:%`)) { advance("skipped"); return false; }
      const text = this.texts[j.do] ? this.texts[j.do](name, j) : j.text;
      const turn = ownerTurn();
      if (!text || !turn) { advance(text ? "skipped (owner DM unknown)" : "nothing to say"); return false; }
      run(`INSERT OR IGNORE INTO inbox(lane, kind, source, source_msg_id, turn_ctx_json, payload_json, status, ts) VALUES(?,?,?,?,?,?,?,?)`,
        j.lane ?? OWNER_LANE, "timer", "job", `${name}:${t.due_at}`, JSON.stringify(turn),
        JSON.stringify({ text, ts: now, job: name, quota: j.quota ?? (j.do === "event") }), "received", now);
      advance("fired");
      return true;
    }
    const h = this.handlers[j.do];
    if (!h) { advance(`no handler for do: ${j.do}`); return false; }
    if (this.busy.has(name)) { advance("skipped"); return false; }
    this.busy.add(name);
    advance("started");
    void h(name, j)
      .then(() => kvSet(`job.${name}.last`, JSON.stringify({ at: now, due: t.due_at, outcome: "done", ended: Date.now() })))
      .catch((e) => { log("timer", "job failed", { job: name, err: String(e?.stack ?? e).slice(0, 400) }); kvSet(`job.${name}.last`, JSON.stringify({ at: now, due: t.due_at, outcome: "failed", err: String(e?.message ?? e).slice(0, 200) })); })
      .finally(() => this.busy.delete(name));
    return false;
  }

  /** run a job now (owner command), regardless of its schedule */
  async runNow(name: string): Promise<string> {
    const j = jobsConf()[name];
    if (!j) return `没有这个定时任务：${name}`;
    const h = this.handlers[j.do];
    if (h) {
      if (this.busy.has(name)) return `${name} 正在跑`;
      this.busy.add(name);
      try { await h(name, j); return `${name} 跑完了`; } finally { this.busy.delete(name); }
    }
    const text = this.texts[j.do] ? this.texts[j.do](name, j) : j.text;
    const turn = ownerTurn();
    if (!text || !turn) return "没有可发的内容，或者还不知道私聊会话";
    run(`INSERT OR IGNORE INTO inbox(lane, kind, source, source_msg_id, turn_ctx_json, payload_json, status, ts) VALUES(?,?,?,?,?,?,?,?)`,
      j.lane ?? OWNER_LANE, "timer", "job", `${name}:manual:${Date.now()}`, JSON.stringify(turn), JSON.stringify({ text, ts: Date.now(), job: name, quota: false }), "received", Date.now());
    this.onFire();
    return `${name} 已投进会话`;
  }
}
