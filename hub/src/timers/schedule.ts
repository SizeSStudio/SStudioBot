// Scheduler (§底4.1, 03 「timers 和 Sentinel」), ported from core/src/timers.ts. One table, three kinds:
//   - followup: one-off, set by the main agent; when due a `timer` event goes into its lane, then it is done
//   - schedule: one row per jobs.yaml entry (hot-reloaded); when due it fires and moves to the next time. Missed while
//     the hub was down (> GRACE late) → recorded `missed`, not run; previous firing still going → `skipped`
//   - task: written by the task engine (W2); fired the same way as followups, as `task` inbox rows
// A timer never runs a model itself: it writes inbox rows (deduped `timer_id:due_at`) or calls a code handler.
//
// New: the `check` contract. A job with `check: <cmd>` runs it first (on the local node, /node/v1/exec, injected):
//   exit 0 + empty stdout → nothing to do, `skipped_by_check`, no model; exit 0 + output → stdout goes into the run;
//   any other exit → the run happens anyway with the exit code and the first 2 KB of stderr, plus an ops alert ※.
import { jobsConf, type JobSpec } from "../config/load.ts";
import { all, db, kvGet, kvSet, one, run, tx } from "../db/ambient.ts";
import { ingest } from "../inbox.ts";
import { log } from "../log.ts";
import * as notify from "../notify.ts";
import { localStamp, parseLocal } from "../time.ts";
import type { TurnContext } from "../turn.ts";
import { OWNER_DM_KEY, OWNER_DM_LANE } from "../channels/feishu/state.ts";
import { classifyUpstream, failureText, nextAttempt, retryDeadline } from "../retry.ts";

const TICK_MS = 30_000;
const GRACE_MS = 15 * 60_000;
export const OWNER_LANE = OWNER_DM_LANE;
const CHECK_STDERR = 2048;

/** next firing strictly after `after`, in my timezone */
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

/** where my scheduled things land: the bot DM, once Feishu has told us its chat id */
export function ownerTurn(src: string): TurnContext | undefined {
  const dm = kvGet(OWNER_DM_KEY);
  return dm ? { channel: "feishu", lane: OWNER_LANE, surface: "feishu:dm", chat: dm, src } : undefined;
}

export function addFollowup(o: { lane: string; turn: TurnContext; due: number; note: string; matterId?: number; by: "owner" | "agent"; runId?: string }) {
  const turn = { ...o.turn, msg_id: undefined };   // a reminder starts a new message, it doesn't quote the old one
  const r = run("INSERT INTO timers(kind, lane, turn_json, due_at, note, matter_id, created_by, run_id, ts) VALUES(?,?,?,?,?,?,?,?,?)",
    "followup", o.lane, JSON.stringify(turn), o.due, o.note, o.matterId ?? null, o.by, o.runId ?? null, Date.now());
  return Number(r.lastInsertRowid);
}

export const listFollowups = (lane?: string) =>
  all(`SELECT * FROM timers WHERE kind='followup' AND status='pending' ${lane ? "AND lane=?" : ""} ORDER BY due_at`, ...(lane ? [lane] : []));

export const cancelFollowup = (id: number) => run("UPDATE timers SET status='cancelled' WHERE id=? AND kind='followup' AND status='pending'", id).changes > 0;

/** code handlers for jobs (do: <name>); `event` and `morning` are built in */
export type JobHandler = (name: string, job: JobSpec) => Promise<void>;
/** builds a job's event text (e.g. the morning report's facts); registered by main to avoid import cycles */
export type EventText = (name: string, job: JobSpec) => string | undefined;
/** runs a job's `check` on the local node (W1d/W2: /node/v1/exec) */
export type CheckRunner = (cmd: string) => Promise<{ code: number; stdout: string; stderr: string }>;

export interface SchedulerHooks {
  /** start of every tick, before anything fires (a review past its deadline is filed before the morning report) */
  beforeTick?: () => void;
  /** an event job is going into its lane; the result is merged into the event's payload */
  opened?: (name: string, job: JobSpec, key: string) => Record<string, unknown> | undefined;
  /** an event job did not go out at all */
  notRun?: (name: string, job: JobSpec, due: number, why: string) => void;
}

export interface SchedulerOpts {
  onFire?: () => void;
  handlers?: Record<string, JobHandler>;
  texts?: Record<string, EventText>;
  hooks?: SchedulerHooks;
  check?: CheckRunner;
}

const enabledJobs = () => Object.fromEntries(Object.entries(jobsConf()).filter(([, j]) => j.enabled !== false));

export class Scheduler {
  #timer?: NodeJS.Timeout;
  #o: SchedulerOpts;
  #busy = new Set<string>();
  #synced = "";

  constructor(o: SchedulerOpts = {}) { this.#o = o; }
  start() { this.#timer = setInterval(() => this.tick(), TICK_MS); this.tick(); }
  stop() { clearInterval(this.#timer); }

  /** the hooks are bookkeeping: they must not stop a job, and a throw inside the interval would take the hub down */
  #hook<T>(what: string, f: () => T): T | undefined {
    try { return f(); } catch (e) { log("timer", `${what} hook failed`, { err: String((e as Error)?.message ?? e).slice(0, 300) }); return undefined; }
  }
  #notRun(name: string, j: JobSpec, due: number, why: string) { this.#hook("notRun", () => this.#o.hooks?.notRun?.(name, j, due, why)); }

  /** jobs.yaml → one pending `schedule` row per job; a changed spec gets a new due time; removed jobs are cancelled */
  syncJobs() {
    const jobs = enabledJobs();
    const sig = JSON.stringify(jobs);
    if (sig === this.#synced) return;
    this.#synced = sig;
    tx(() => {
      const rows = all("SELECT * FROM timers WHERE kind='schedule' AND status='pending'");
      for (const r of rows) if (!jobs[r.job]) run("UPDATE timers SET status='cancelled' WHERE id=?", r.id);
      for (const [name, j] of Object.entries(jobs)) {
        const spec = JSON.stringify(j);
        const cur = rows.find((r) => r.job === name);
        if (cur && cur.cron === spec) continue;
        const due = nextDue(j);
        if (!due) { log("timer", "bad job spec, ignored", { job: name }); if (cur) run("UPDATE timers SET status='cancelled' WHERE id=?", cur.id); continue; }
        if (cur) run("UPDATE timers SET cron=?, due_at=? WHERE id=?", spec, due, cur.id);
        else run("INSERT INTO timers(kind, lane, cron, job, due_at, created_by, ts) VALUES(?,?,?,?,?,?,?)", "schedule", j.lane ?? OWNER_LANE, spec, name, due, "jobs.yaml", Date.now());
      }
    });
    log("timer", "jobs synced", { jobs: Object.keys(jobs).length });
  }

  tick() {
    try { this.syncJobs(); } catch (e) { log("timer", "jobs.yaml sync failed", { err: String((e as Error)?.message ?? e) }); }
    this.#hook("beforeTick", () => this.#o.hooks?.beforeTick?.());
    const now = Date.now();
    const due = all("SELECT * FROM timers WHERE status='pending' AND due_at<=? ORDER BY due_at LIMIT 50", now);
    // §底4.3: events waiting out an upstream failure, and code jobs doing the same
    let fired = !!one("SELECT 1 FROM inbox WHERE status='received' AND not_before IS NOT NULL AND not_before<=? LIMIT 1", now);
    this.#retryJobs(now);
    for (const t of due) {
      if (t.kind === "schedule") { fired = this.#fireJob(t, now) || fired; continue; }
      this.#fireOneOff(t, now);
      fired = true;
    }
    if (fired) this.#o.onFire?.();
  }

  #fireOneOff(t: Record<string, any>, now: number) {
    tx(() => {
      if (t.kind === "task") {
        ingest(db(), { lane: t.lane ?? `task:${t.task_id}`, kind: "task", source: "timer", source_msg_id: `${t.id}:${t.due_at}`,
          payload: { ...JSON.parse(t.payload_json ?? "{}"), task_id: t.task_id, ts: now }, ts: now });
      } else {
        const late = now - t.due_at > 10 * 60_000 ? `（本该 ${localStamp(t.due_at).slice(5)} 提醒，主当时不在线，晚了）` : "";
        ingest(db(), { lane: t.lane, kind: "timer", source: "timer", source_msg_id: `${t.id}:${t.due_at}`,
          turn: t.turn_json ? JSON.parse(t.turn_json) : undefined,
          payload: { text: `【到点了：follow-up #${t.id}，${localStamp(t.ts).slice(5)} 设的${late}】${t.note}${t.matter_id ? `（事 #${t.matter_id}）` : ""}`, ts: now, quota: true }, ts: now });
      }
      run("UPDATE timers SET status='done', fired_at=? WHERE id=?", now, t.id);
    });
    log("timer", "fired", { id: t.id, kind: t.kind });
  }

  #last(name: string, o: Record<string, unknown>) { kvSet(`job.${name}.last`, JSON.stringify(o)); }

  #fireJob(t: Record<string, any>, now: number): boolean {
    const j: JobSpec = JSON.parse(t.cron);
    const name = t.job as string;
    const next = nextDue(j, Math.max(now, t.due_at));
    const advance = (outcome: string) => {
      run("UPDATE timers SET due_at=?, fired_at=? WHERE id=?", next ?? now + 86400_000, now, t.id);
      this.#last(name, { at: now, due: t.due_at, outcome });
      log("timer", `job ${outcome}`, { job: name, next: next ? localStamp(next) : null });
    };
    if (now - t.due_at > GRACE_MS) { advance("missed"); this.#notRun(name, j, t.due_at, "主当时不在线，错过了"); return false; }
    const texts = this.#o.texts ?? {}, h = this.#o.handlers?.[j.do];
    const isEvent = j.do === "event" || j.do === "morning" || !!texts[j.do];
    if (!isEvent && !h) { advance(`no handler for do: ${j.do}`); return false; }
    if (this.#busy.has(name) || (isEvent && one("SELECT 1 FROM inbox WHERE source='job' AND source_msg_id LIKE ? AND status IN ('received','processing')", `${name}:%`))) {
      advance("skipped"); this.#notRun(name, j, t.due_at, "上一轮还没结束，这一轮跳过了"); return false;
    }
    if (j.check) { advance("checking"); void this.#checkThenFire(name, j, t.due_at, next); return false; }
    if (!isEvent) { advance("started"); this.#startHandler(name, j, h!, t.due_at, now, 0, retryDeadline(t.due_at, next, j.retry_hours)); return false; }
    const out = this.#putEvent(name, j, `${name}:${t.due_at}`, now, j.quota ?? (j.do === "event"));
    advance(out);
    if (out !== "fired") this.#notRun(name, j, t.due_at, out === "nothing to say" ? "没有要说的" : "还不知道私聊会话");
    return out === "fired";
  }

  /** an event job's inbox row; returns the outcome */
  #putEvent(name: string, j: JobSpec, key: string, now: number, quota: boolean, extra: Record<string, unknown> = {}): string {
    const texts = this.#o.texts ?? {};
    const text = texts[j.do] ? texts[j.do]!(name, j) : j.text;
    const turn = ownerTurn(`job@${name}`);
    if (!text) return "nothing to say";
    if (!turn) return "skipped (owner DM unknown)";
    const opened = this.#hook("opened", () => this.#o.hooks?.opened?.(name, j, key));
    ingest(db(), { lane: j.lane ?? OWNER_LANE, kind: "timer", source: "job", source_msg_id: key, turn: { ...turn, lane: j.lane ?? OWNER_LANE },
      payload: { text, ts: now, job: name, quota, ...extra, ...opened }, ts: now });
    return "fired";
  }

  async #checkThenFire(name: string, j: JobSpec, due: number, next: number | undefined) {
    this.#busy.add(name);
    let extra: Record<string, unknown>;
    try {
      const r = this.#o.check ? await this.#o.check(j.check!) : { code: -1, stdout: "", stderr: "本机节点没接上，check 没法跑" };
      if (r.code === 0 && !r.stdout.trim()) { this.#last(name, { at: Date.now(), due, outcome: "skipped_by_check" }); return; }
      if (r.code === 0) extra = { check: { out: r.stdout } };
      else {
        extra = { check: { broken: true, code: r.code, stderr: r.stderr.slice(0, CHECK_STDERR) } };
        void notify.admin(`**定时任务的 check 坏了**：${name}（退出码 ${r.code}）。这一轮照常跑了，把错误带进去了。`);
      }
    } catch (e) {
      extra = { check: { broken: true, code: -1, stderr: String((e as Error)?.message ?? e).slice(0, CHECK_STDERR) } };
      void notify.admin(`**定时任务的 check 坏了**：${name}（没跑起来）。这一轮照常跑了。`);
    } finally { this.#busy.delete(name); }
    const h = this.#o.handlers?.[j.do];
    if (h && !(j.do === "event" || j.do === "morning" || this.#o.texts?.[j.do])) {
      this.#startHandler(name, j, h, due, Date.now(), 0, retryDeadline(due, next, j.retry_hours));
      return;
    }
    const out = this.#putEvent(name, j, `${name}:${due}`, Date.now(), j.quota ?? (j.do === "event"), extra);
    this.#last(name, { at: Date.now(), due, outcome: out });
    if (out === "fired") this.#o.onFire?.();
    else this.#notRun(name, j, due, out === "nothing to say" ? "没有要说的" : "还不知道私聊会话");
  }

  #startHandler(name: string, j: JobSpec, h: JobHandler, due: number, at: number, tries: number, deadline: number) {
    this.#busy.add(name);
    const last = (o: Record<string, unknown>) => this.#last(name, { at, due, ...o });
    void h(name, j)
      .then(() => { run("DELETE FROM kv WHERE k=?", `job.${name}.retry`); last({ outcome: "done", ended: Date.now() }); })
      .catch((e) => {
        const err = String(e?.message ?? e), f = classifyUpstream(err);
        log("timer", "job failed", { job: name, err: err.slice(0, 400) });
        run("DELETE FROM kv WHERE k=?", `job.${name}.retry`);
        if (!f) return last({ outcome: "failed", err: err.slice(0, 200) });
        const n = tries + 1, again = nextAttempt(f, n, deadline);
        if (again) { kvSet(`job.${name}.retry`, JSON.stringify({ at: again, due, n, deadline })); return last({ outcome: `retrying (${n})` }); }
        last({ outcome: "gave_up", err: err.slice(0, 200) });   // not "failed": this notice is the one alert, Sentinel needn't repeat it
        void notify.admin(`**定时任务没跑成**：${name}（${localStamp(due).slice(5, 16)}）试了 ${n} 次，到 ${localStamp(deadline).slice(5, 16)} 还不行，这一轮放弃，不再补。\n${failureText(f, err, (ms) => localStamp(ms).slice(5, 16))}`);
      })
      .finally(() => this.#busy.delete(name));
  }

  /** code jobs that failed on the upstream (§底4.3); the plan lives in kv so a restart doesn't lose it */
  #retryJobs(now: number) {
    for (const r of all("SELECT k, v FROM kv WHERE k LIKE 'job.%.retry'")) {
      const name = String(r.k).slice(4, -6), v = JSON.parse(r.v), j = jobsConf()[name], h = j && this.#o.handlers?.[j.do];
      if (!h) { run("DELETE FROM kv WHERE k=?", r.k); continue; }
      if (v.at <= now && !this.#busy.has(name)) this.#startHandler(name, j, h, v.due, now, v.n, v.deadline);
    }
  }

  /** run a job now (my command), regardless of its schedule */
  async runNow(name: string): Promise<string> {
    const j = jobsConf()[name];
    if (!j) return `没有这个定时任务：${name}`;
    const h = this.#o.handlers?.[j.do];
    if (h) {
      if (this.#busy.has(name)) return `${name} 正在跑`;
      this.#busy.add(name);
      try { await h(name, j); return `${name} 跑完了`; } finally { this.#busy.delete(name); }
    }
    const out = this.#putEvent(name, j, `${name}:manual:${Date.now()}`, Date.now(), false);
    if (out !== "fired") return "没有可发的内容，或者还不知道私聊会话";
    this.#o.onFire?.();
    return `${name} 已投进会话`;
  }
}
