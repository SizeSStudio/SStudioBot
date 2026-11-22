// Scheduler (DESIGN §底4.1). Two kinds of timers in one table:
//   - follow-up (one-off, set by the main agent): when due, a `timer` event goes into its lane, then it is done
//   - schedule (from config/jobs.yaml, hot-reloaded): one row per job; when due it fires and moves to the next time.
//     A schedule missed while the core was down (> GRACE late) is not run, only recorded as missed; one whose previous
//     firing is still pending or running is skipped.
// A timer never runs a model itself. Jobs either put an event into a lane (do: event / morning) or call a code
// handler (do: dream / dream_diff …) that the core registers.

import { all, one, run, tx, kvGet, kvSet } from "./db.ts";
import { jobsConf, log, TZ, type JobSpec } from "./config.ts";
import { localStamp } from "./memory.ts";
import { adminNotice, classifyUpstream, failureText, nextAttempt, retryDeadline } from "./retry.ts";
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
/** builds the factual digest for the morning report (§底4.1, §寸2); registered by main to avoid an import cycle */
export type EventText = (name: string, job: JobSpec) => string | undefined;

/** what the 复盘 ledger needs from the scheduler (§觉4); registered by main to avoid an import cycle */
export interface SchedulerHooks {
  /** start of every tick, before anything fires: a review past its deadline is filed before the morning report is written */
  beforeTick?: () => void;
  /** an event job is going into its lane; the result is merged into the event's payload */
  opened?: (name: string, job: JobSpec, key: string) => Record<string, unknown> | undefined;
  /** an event job did not go out at all */
  notRun?: (name: string, job: JobSpec, due: number, why: string) => void;
}

export class Scheduler {
  private timer?: NodeJS.Timeout;
  private onFire: () => void;
  private handlers: Record<string, JobHandler>;
  private texts: Record<string, EventText>;
  private busy = new Set<string>();
  private synced = "";
  private hooks: SchedulerHooks;
  constructor(onFire: () => void, handlers: Record<string, JobHandler> = {}, texts: Record<string, EventText> = {}, hooks: SchedulerHooks = {}) {
    this.onFire = onFire; this.handlers = handlers; this.texts = texts; this.hooks = hooks;
  }
  start() { this.timer = setInterval(() => this.tick(), TICK_MS); this.tick(); }

  /** the review ledger is bookkeeping: it must not stop a job, and a throw inside the interval would take the core down */
  private hook<T>(what: string, f: () => T): T | undefined {
    try { return f(); } catch (e: any) { log("timer", `${what} hook failed`, { err: String(e?.message ?? e).slice(0, 300) }); return undefined; }
  }
  private notRun(name: string, j: JobSpec, due: number, why: string) { this.hook("notRun", () => this.hooks.notRun?.(name, j, due, why)); }
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
    this.hook("beforeTick", () => this.hooks.beforeTick?.());
    const now = Date.now();
    const due = all("SELECT * FROM timers WHERE status='pending' AND due_at<=? ORDER BY due_at LIMIT 50", now);
    // §底4.3: events waiting out an upstream failure, and code jobs doing the same
    let fired = !!one("SELECT 1 FROM inbox WHERE status='received' AND not_before IS NOT NULL AND not_before<=? LIMIT 1", now);
    this.retryJobs(now);
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
    if (now - t.due_at > GRACE_MS) { advance("missed"); this.notRun(name, j, t.due_at, "核心当时不在线，错过了"); return false; }
    if (j.do === "event" || j.do === "morning" || this.texts[j.do]) {
      if (one("SELECT 1 FROM inbox WHERE source='job' AND source_msg_id LIKE ? AND status IN ('received','processing')", `${name}:%`)) { advance("skipped"); this.notRun(name, j, t.due_at, "上一轮还没结束，这一轮跳过了"); return false; }
      const text = this.texts[j.do] ? this.texts[j.do](name, j) : j.text;
      const turn = ownerTurn();
      if (!text || !turn) {
        advance(text ? "skipped (owner DM unknown)" : "nothing to say");
        if (text) this.notRun(name, j, t.due_at, "还不知道私聊会话");
        return false;
      }
      const key = `${name}:${t.due_at}`, extra = this.hook("opened", () => this.hooks.opened?.(name, j, key));
      run(`INSERT OR IGNORE INTO inbox(lane, kind, source, source_msg_id, turn_ctx_json, payload_json, status, ts) VALUES(?,?,?,?,?,?,?,?)`,
        j.lane ?? OWNER_LANE, "timer", "job", key, JSON.stringify(turn),
        JSON.stringify({ text, ts: now, job: name, quota: j.quota ?? (j.do === "event"), ...extra }), "received", now);
      advance("fired");
      return true;
    }
    const h = this.handlers[j.do];
    if (!h) { advance(`no handler for do: ${j.do}`); return false; }
    if (this.busy.has(name)) { advance("skipped"); return false; }
    advance("started");
    this.startHandler(name, j, h, t.due_at, now, 0, retryDeadline(t.due_at, next, j.retry_hours));
    return false;
  }

  private startHandler(name: string, j: JobSpec, h: JobHandler, due: number, at: number, tries: number, deadline: number) {
    this.busy.add(name);
    const last = (o: Record<string, unknown>) => kvSet(`job.${name}.last`, JSON.stringify({ at, due, ...o }));
    void h(name, j)
      .then(() => { run("DELETE FROM kv WHERE k=?", `job.${name}.retry`); last({ outcome: "done", ended: Date.now() }); })
      .catch((e) => {
        const err = String(e?.message ?? e), f = classifyUpstream(err);
        log("timer", "job failed", { job: name, err: String(e?.stack ?? e).slice(0, 400) });
        run("DELETE FROM kv WHERE k=?", `job.${name}.retry`);
        if (!f) return last({ outcome: "failed", err: err.slice(0, 200) });
        const n = tries + 1, again = nextAttempt(f, n, deadline);
        if (again) { kvSet(`job.${name}.retry`, JSON.stringify({ at: again, due, n, deadline })); return last({ outcome: `retrying (${n})` }); }
        last({ outcome: "gave_up", err: err.slice(0, 200) });   // not "failed": the notice below is the one alert, sentinel needn't repeat it
        adminNotice(`**定时任务没跑成**：${name}（${localStamp(due).slice(5, 16)}）试了 ${n} 次，到 ${localStamp(deadline).slice(5, 16)} 还不行，这一轮放弃，不再补。\n${failureText(f, err, (ms) => localStamp(ms).slice(5, 16))}`);
      })
      .finally(() => this.busy.delete(name));
  }

  /** code jobs that failed on the upstream (§底4.3); the plan lives in kv so a restart doesn't lose it */
  private retryJobs(now: number) {
    for (const r of all("SELECT k, v FROM kv WHERE k LIKE 'job.%.retry'")) {
      const name = r.k.slice(4, -6), v = JSON.parse(r.v), j = jobsConf()[name], h = j && this.handlers[j.do];
      if (!h) { run("DELETE FROM kv WHERE k=?", r.k); continue; }
      if (v.at <= now && !this.busy.has(name)) this.startHandler(name, j, h, v.due, now, v.n, v.deadline);
    }
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
    const key = `${name}:manual:${Date.now()}`, extra = this.hook("opened", () => this.hooks.opened?.(name, j, key));
    run(`INSERT OR IGNORE INTO inbox(lane, kind, source, source_msg_id, turn_ctx_json, payload_json, status, ts) VALUES(?,?,?,?,?,?,?,?)`,
      j.lane ?? OWNER_LANE, "timer", "job", key, JSON.stringify(turn), JSON.stringify({ text, ts: Date.now(), job: name, quota: false, ...extra }), "received", Date.now());
    this.onFire();
    return `${name} 已投进会话`;
  }
}
