// Dispatching inbox rows into runs (03 「inbox 和 run」, §底1.2).
//   - one run per lane at a time, no limit across lanes (D2); a run takes every `received` row of its lane, at most
//     50 per round (keeps one round's input from flooding the context; not a rate limit)
//   - a message I type while a run is going is steered in when pi can take it; anything else waits
//   - /stop aborts and drops steers the model never saw; /new starts a fresh session for the lane
//   - restart: processing rows of a run with no side effects go back to received; with side effects they are marked
//     interrupted and I'm told, in that lane, how many messages already went out (nothing is sent twice);
//     a row that was being processed in two crashes in a row is failed
//   - breaker (Y8): the same error fingerprint N times in a row on a lane stops the loop and files a glance card
import { createHash, randomBytes } from "node:crypto";
import type { Db, Row } from "./db/db.ts";
import type { Home } from "./home.ts";
import { measureConf, tierConf, TIERS, type Tier } from "./config/load.ts";
import { colOf, ownerTyped, payloadOf, sourceLabel, turnOf, type TurnContext } from "./turn.ts";
import { setKick } from "./inbox.ts";
import { issueToken, revokeRun } from "./proxy.ts";
import { classifyUpstream, nextAttempt, retryDeadline, type UpstreamFailure } from "./retry.ts";
import { toolsFor, toolNamed, type NodeClient, type ToolCtx } from "./tools/registry.ts";
import { queueReply } from "./tools/builtin.ts";
import { itemStart } from "./items.ts";
import { promptFiles, systemPrompt } from "./runner/prompt.ts";
import { submitApproval, invalidateForOwnerMessage } from "./approvals.ts";
import type { ItemEvent, Role, RunResult, Runner } from "./runner/types.ts";
import { TZ } from "./home.ts";
import * as notify from "./notify.ts";
import { log } from "./log.ts";

export const BATCH_MAX = 50;
const SCHEDULED = new Set(["timer"]);
const KIND_LABEL: Record<string, string> = { timer: "（定时器）", approval: "（审批结果）", task: "（任务消息）", system: "（系统转来）", card: "（卡片操作）" };

const newRunId = () => `r_${Date.now().toString(36)}_${randomBytes(3).toString("hex")}`;
const hhmm = (ms: number) => new Date(ms).toLocaleString("sv-SE", { timeZone: TZ }).slice(11, 16);
const isScheduled = (r: Row) => SCHEDULED.has(String(r.kind)) || r.source === "job";

/** The error fingerprint (Y8): role | lane class | error class | message without numbers and ids. */
export function errFingerprint(role: string, lane: string, error: string): string {
  const cls = /\b([A-Z][A-Za-z]*Error)\b/.exec(error)?.[1] ?? (classifyUpstream(error) ? "upstream" : "Error");
  const norm = error.toLowerCase().replace(/\b[0-9a-f]{8,}\b/g, "#").replace(/\d+/g, "#").replace(/\s+/g, " ").trim().slice(0, 300);
  return createHash("sha256").update(`${role}|${lane.split(":")[0]}|${cls}|${norm}`).digest("hex");
}

export function turnText(rows: Row[]): string {
  return rows.map((r) => {
    const p = payloadOf(r);
    const label = KIND_LABEL[String(r.kind)] ?? (ownerTyped(r) ? "" : r.kind === "user" ? `（${String(p.sender_name ?? "别人")}）` : "");
    return `[${hhmm(Number(p.ts ?? r.ts))}]${label} ${String(p.text ?? "")}`;
  }).join("\n");
}

/** Where a batch's reply goes: the last row's turn; a job or system event with none → the main outlet. */
export function replyTurn(rows: Row[]): TurnContext {
  for (let i = rows.length - 1; i >= 0; i--) { const t = turnOf(rows[i]!); if (t) return t; }
  return { channel: "outlet:main", surface: "outlet" };
}

type Active = { run_id: string; ac: AbortController; stopped: boolean; done: Promise<void> };

export interface DispatchDeps { db: Db; h: Home; runner: Runner; node?: NodeClient; batchMax?: number; onItem?: (run_id: string, lane: string, e: ItemEvent) => void }

export class Dispatcher {
  readonly d: DispatchDeps;
  #active = new Map<string, Active>();
  #timer: ReturnType<typeof setInterval> | undefined;
  #ticking = false;
  #again = false;
  #closed = false;

  constructor(d: DispatchDeps) { this.d = d; }

  // ───────── restart ─────────

  recover(): { requeued: number; interrupted: number; failed: number } {
    const { db } = this.d;
    const out = { requeued: 0, interrupted: 0, failed: 0 };
    const notices: { turn: TurnContext; lane: string; text: string; run_id: string }[] = [];
    const failedTexts: string[] = [];
    db.tx(() => {
      const rows = db.all("SELECT * FROM inbox WHERE status = 'processing' ORDER BY id");
      const byRun = new Map<string, Row[]>();
      for (const r of rows) {
        const k = String(r.run_id ?? "");
        byRun.set(k, [...(byRun.get(k) ?? []), r]);
      }
      for (const [run_id, rs] of byRun) {
        const run = run_id ? db.one<{ side_effects: number; lane: string }>("SELECT side_effects, lane FROM runs WHERE id = ?", run_id) : undefined;
        const twice = rs.filter((r) => Number(r.tries) >= 2), rest = rs.filter((r) => Number(r.tries) < 2);
        for (const r of twice) {
          db.run("UPDATE inbox SET status = 'failed' WHERE id = ?", Number(r.id));
          failedTexts.push(String(payloadOf(r).text ?? "").slice(0, 60));
          out.failed++;
        }
        if (!rest.length) continue;
        if (!run || Number(run.side_effects) === 0) {
          for (const r of rest) db.run("UPDATE inbox SET status = 'received', run_id = NULL WHERE id = ?", Number(r.id));
          out.requeued += rest.length;
        } else {
          for (const r of rest) db.run("UPDATE inbox SET status = 'interrupted' WHERE id = ?", Number(r.id));
          out.interrupted += rest.length;
          const sent = db.one<{ n: number }>("SELECT COUNT(*) AS n FROM outbox WHERE run_id = ? AND kind = 'text' AND status NOT IN ('failed', 'expired', 'unrouted')", run_id)!.n;
          notices.push({
            turn: replyTurn(rest), lane: run.lane, run_id,
            text: `我刚才被重启了。上一轮做到一半${sent ? `，已经发出 ${sent} 条消息` : "，有过对外的动作"}，不会重发。要我接着做，再说一声。`,
          });
        }
      }
      db.run("UPDATE runs SET status = 'interrupted', stop_reason = 'restart', ended = ? WHERE status = 'running'", Date.now());
      db.run("UPDATE run_tokens SET status = 'revoked' WHERE status = 'active'");
      // the notice is not a new side effect of any run: it goes out with no run_id
      for (const n of notices) {
        itemStart(db, this.d.h.blobs, { lane: n.lane, run_id: n.run_id, kind: "notice", name: "notice", body: { text: n.text }, status: "done" });
        queueReply({ db, run_id: "", lane: n.lane, turn: n.turn }, n.text, false);
      }
    });
    for (const t of failedTexts) void notify.admin(`有一条输入让我连着崩了两次，先不处理了：「${t}」`);
    if (out.requeued || out.interrupted || out.failed) log("dispatch", "recovered", out);
    return out;
  }

  // ───────── loop ─────────

  start(everyMs = 1_000) {
    setKick(() => this.kick());
    this.#timer = setInterval(() => this.kick(), everyMs);
    this.#timer.unref?.();
    this.kick();
  }

  /** Stop taking new rows; wait up to `ms` for running runs (03 关停); whatever is left is handled by the next recover(). */
  async stop(ms = 30_000) {
    this.#closed = true;
    if (this.#timer) clearInterval(this.#timer);
    setKick(() => {});
    const all = [...this.#active.values()].map((a) => a.done);
    await Promise.race([Promise.all(all), new Promise((r) => setTimeout(r, ms).unref?.())]);
  }

  kick() {
    if (this.#closed) return;
    if (this.#ticking) { this.#again = true; return; }
    this.#ticking = true;
    this.#tick().catch((e) => log("dispatch", "tick error", { err: String((e as Error)?.message ?? e).slice(0, 300) })).finally(() => {
      this.#ticking = false;
      if (this.#again) { this.#again = false; this.kick(); }
    });
  }

  /** Tests: wait until nothing is running and nothing is waiting to start. */
  async idle(timeoutMs = 20_000) {
    const end = Date.now() + timeoutMs;
    for (;;) {
      await Promise.all([...this.#active.values()].map((a) => a.done));
      await new Promise((r) => setTimeout(r, 20));
      const waiting = this.d.db.one<{ n: number }>("SELECT COUNT(*) AS n FROM inbox WHERE status = 'received' AND COALESCE(not_before, 0) <= ?", Date.now())!.n;
      if (!this.#active.size && !this.#ticking && !waiting) return;
      if (Date.now() > end) throw new Error("dispatcher not idle");
      if (waiting && !this.#ticking) this.kick();
    }
  }

  activeRun(lane: string) { return this.#active.get(lane)?.run_id; }

  /** 03 停: abort the lane's run; its unseen steers are dropped when it ends. */
  stopLane(lane: string): boolean {
    const a = this.#active.get(lane);
    if (!a) return false;
    a.stopped = true;
    a.ac.abort();
    return true;
  }

  async #tick() {
    const { db } = this.d;
    // commands first: /stop must reach a running run
    for (const r of db.all("SELECT * FROM inbox WHERE status = 'received' AND kind = 'command' ORDER BY id")) this.#command(r);
    // a message taken back while its run is going: same as stop (03 撤回); its cards are moot
    for (const r of db.all("SELECT * FROM inbox WHERE status = 'processing' AND json_extract(payload_json, '$.withdrawn') = 1")) {
      if (this.stopLane(String(r.lane))) log("dispatch", "withdrawn input stops its run", { lane: r.lane });
      invalidateForOwnerMessage(db, { trigger_msg_id: String(r.source_msg_id) });
      db.run("UPDATE inbox SET payload_json = json_remove(payload_json, '$.withdrawn') WHERE id = ?", Number(r.id));
    }
    const lanes = db.all<{ lane: string }>(
      "SELECT DISTINCT lane FROM inbox WHERE status = 'received' AND kind != 'command' AND COALESCE(not_before, 0) <= ?", Date.now());
    for (const { lane } of lanes) {
      const a = this.#active.get(lane);
      if (a) { await this.#steer(lane, a); continue; }
      this.#start(lane);
    }
  }

  #command(r: Row) {
    const { db } = this.d;
    const text = String(payloadOf(r).text ?? "").trim().toLowerCase(), lane = String(r.lane), turn = replyTurn([r]);
    const say = (t: string) => queueReply({ db, run_id: "", lane, turn }, t, false);
    if (text === "/stop") {
      const stopped = this.stopLane(lane);
      db.run("UPDATE inbox SET status = 'done' WHERE id = ?", Number(r.id));
      if (!stopped) say("现在没有在跑的。");
      return;
    }
    if (text === "/new") {
      if (this.#active.has(lane)) return;   // after the current run, so the next message lands in the new session
      db.tx(() => {
        db.run("UPDATE sessions SET session_ref = NULL, generation = generation + 1, status = 'roll' WHERE key = ?", lane);
        db.run("UPDATE inbox SET status = 'done' WHERE id = ?", Number(r.id));
      });
      say("好，新开一段。");
      return;
    }
    // not one of ours: the channel's own deterministic commands never get here; treat it as text
    db.run("UPDATE inbox SET kind = 'user' WHERE id = ?", Number(r.id));
  }

  async #steer(lane: string, a: Active) {
    const { db, runner } = this.d;
    for (const r of db.all("SELECT * FROM inbox WHERE lane = ? AND status = 'received' AND kind = 'user' ORDER BY id", lane)) {
      if (!ownerTyped(r)) continue;   // only what I type is steered in; everything else waits its turn
      if (!(await runner.steer(lane, turnText([r]), Number(r.id)))) return;
      db.run("UPDATE inbox SET status = 'processing', run_id = ?, tries = tries + 1 WHERE id = ? AND status = 'received'", a.run_id, Number(r.id));
    }
  }

  #start(lane: string) {
    const { db, h } = this.d;
    const max = this.d.batchMax ?? BATCH_MAX;
    const breaker = db.kvGet(`breaker.${lane}`);
    const picked = db.tx(() => {
      // rows after a pending /new wait for it
      const cmd = db.one<{ id: number }>("SELECT MIN(id) AS id FROM inbox WHERE lane = ? AND status = 'received' AND kind = 'command'", lane)?.id ?? null;
      let rows = db.all(
        `SELECT * FROM inbox WHERE lane = ? AND status = 'received' AND kind != 'command' AND COALESCE(not_before, 0) <= ? ${cmd ? "AND id < ?" : ""} ORDER BY id LIMIT ?`,
        ...(cmd ? [lane, Date.now(), cmd, max] : [lane, Date.now(), max]));
      if (breaker) {   // the loop is stopped: only what I type gets through until a run succeeds
        for (const r of rows) if (!ownerTyped(r)) db.run("UPDATE inbox SET status = 'failed' WHERE id = ?", Number(r.id));
        rows = rows.filter(ownerTyped);
      }
      if (!rows.length) return undefined;
      const run_id = newRunId(), src = sourceLabel(rows), first = rows[0]!;
      const p = payloadOf(rows[rows.length - 1]!);
      const tier: Tier = TIERS.includes(p.tier) ? p.tier : "chat";
      const role: Role = "main";
      const sess = db.one<{ session_ref: string | null }>("SELECT session_ref FROM sessions WHERE key = ?", lane);
      let model: string | null = null;
      try { model = tierConf(tier).model; } catch { /* reported by the run */ }
      db.run(`INSERT INTO runs(id, lane, session_key, session_ref, role, tier, model, status, device_id, started) VALUES (?,?,?,?,?,?,?, 'running', ?, ?)`,
        run_id, lane, lane, sess?.session_ref ?? null, role, tier, model, (first.device_id as string | null) ?? null, Date.now());
      for (const r of rows) db.run("UPDATE inbox SET status = 'processing', run_id = ?, tries = tries + 1 WHERE id = ?", run_id, Number(r.id));
      return { rows, run_id, src, tier, role, session_ref: sess?.session_ref ?? undefined };
    });
    if (!picked) return;
    const ac = new AbortController();
    const a: Active = { run_id: picked.run_id, ac, stopped: false, done: Promise.resolve() };
    this.#active.set(lane, a);
    a.done = this.#execute(lane, picked, a).catch((e) => log("dispatch", "run crashed", { run: picked.run_id, err: String((e as Error)?.message ?? e).slice(0, 300) }))
      .finally(() => { this.#active.delete(lane); this.kick(); });
  }

  async #execute(lane: string, p: { rows: Row[]; run_id: string; src: string; tier: Tier; role: Role; session_ref?: string }, a: Active) {
    const { db, h, runner } = this.d;
    const t0 = Date.now(), col = colOf(p.src), turn = { ...replyTurn(p.rows), src: p.src };
    const ctx: ToolCtx = { db, h, run_id: p.run_id, lane, src: p.src, col, turn, node: this.d.node, replies: 0 };
    const token = issueToken(db, { run_id: p.run_id, tier: p.tier, requester: p.role });
    log("dispatch", "run start", { run: p.run_id, lane, src: p.src, n: p.rows.length });
    let res: RunResult;
    try {
      res = await runner.run({
        lane, role: p.role, tier: p.tier, session_ref: p.session_ref,
        system: systemPrompt({ files: promptFiles(h.agentHome, col), turn, src: p.src, col }),
        input: turnText(p.rows), tools: toolsFor(col), ctx, token, signal: a.ac.signal,
        onItem: (e) => {
          if (e.k === "message") itemStart(db, h.blobs, { lane, run_id: p.run_id, kind: "assistant", body: { text: e.text }, status: "done" });
          this.d.onItem?.(p.run_id, lane, e);
        },
      });
    } catch (e) {
      res = { output: "", fullText: "", session_ref: p.session_ref ?? "", stop: "error", error: String((e as Error)?.message ?? e), usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, tools: [], undelivered: [] };
    } finally {
      revokeRun(db, p.run_id);
    }
    if (a.stopped && res.stop !== "done") res.stop = "aborted";
    this.#finish(lane, p, res, ctx, t0);
  }

  #finish(lane: string, p: { rows: Row[]; run_id: string; role: Role; tier: Tier }, res: RunResult, ctx: ToolCtx, t0: number) {
    const { db } = this.d;
    const failure: UpstreamFailure | undefined = res.stop === "error" ? classifyUpstream(res.error) : undefined;
    // §底4.3: a scheduled row whose run failed upstream, said nothing and changed nothing waits and tries again
    const rerunnable = !!failure && !res.fullText.trim() && ctx.replies === 0 && res.tools.every((n) => toolNamed(n)?.readOnly);
    const fp = res.stop === "error" && !failure ? errFingerprint(p.role, lane, res.error ?? "") : null;
    const scheduled = rerunnable ? p.rows.filter(isScheduled) : [];
    let trip = false;
    db.tx(() => {
      const steered = new Set(res.undelivered);
      for (const id of steered) db.run("UPDATE inbox SET status = ?, run_id = NULL WHERE id = ?", res.stop === "aborted" ? "dropped" : "received", id);
      db.run(`INSERT INTO sessions(key, harness, session_ref, generation, surface, tier, model, status, started, last_active)
              VALUES (?, 'pi', ?, 0, ?, ?, NULL, 'active', ?, ?)
              ON CONFLICT(key) DO UPDATE SET session_ref = excluded.session_ref, tier = excluded.tier, status = 'active', last_active = excluded.last_active,
                generation = CASE WHEN sessions.session_ref IS excluded.session_ref THEN sessions.generation ELSE sessions.generation + 1 END,
                started = CASE WHEN sessions.session_ref IS excluded.session_ref THEN sessions.started ELSE excluded.started END`,
        lane, res.session_ref || null, ctx.turn.surface, p.tier, Date.now(), Date.now());
      db.run("UPDATE runs SET session_ref = ? WHERE id = ?", res.session_ref || null, p.run_id);

      if (res.stop === "done") {
        if (ctx.replies === 0 && res.output.trim()) queueReply(ctx, res.output.trim());
      } else if (res.stop === "aborted") {
        queueReply(ctx, "（已停下）");
      } else if (!scheduled.length || p.rows.some((r) => !isScheduled(r))) {
        // a scheduled row waiting for upstream says nothing yet; anything else in the batch hears about the error
        const why = `这一轮出错了：${String(res.error ?? "").slice(0, 200)}`;
        if (ctx.col === "system") void notify.admin(`${lane}：${why}`);
        else queueReply(ctx, `（${why}）`);
      }
      if (scheduled.length) this.#requeue(scheduled, failure!);
      const status = res.stop === "done" ? "done" : res.stop === "aborted" ? "aborted" : "failed";
      db.run("UPDATE runs SET status = ?, stop_reason = ?, error = ?, err_fp = ?, ended = ? WHERE id = ?",
        status, rerunnable && scheduled.length ? "upstream_retry" : res.stop, res.error ?? null, fp, Date.now(), p.run_id);
      db.run("UPDATE inbox SET status = ? WHERE run_id = ? AND status = 'processing'", res.stop === "error" ? "failed" : "done", p.run_id);

      if (res.stop === "done") db.run("DELETE FROM kv WHERE k = ?", `breaker.${lane}`);
      if (fp) {
        const n = measureConf().breaker;
        const last = db.all<{ err_fp: string | null }>("SELECT err_fp FROM runs WHERE lane = ? AND status IN ('done', 'failed') ORDER BY started DESC, rowid DESC LIMIT ?", lane, n);
        if (last.length >= n && last.every((r) => r.err_fp === fp) && db.kvGet(`breaker.${lane}`) !== fp) {
          db.kvSet(`breaker.${lane}`, fp);
          trip = true;
        }
      }
    });
    if (trip) {
      const n = measureConf().breaker;
      submitApproval(db, {
        kind: "glance", title: `${lane} 连着 ${n} 次同样的错，先停下了`, origin_lane: lane, run_id: p.run_id, requester: "code:breaker",
        draft: `最近一次：${String(res.error ?? "").slice(0, 300)}\n这条 lane 上不是我亲手发的输入先不处理；我发一条消息、跑通一次就恢复。`,
        options: [{ id: "ok", label: "知道了" }],
      });
      log("dispatch", "breaker tripped", { lane, n });
    }
    log("dispatch", "run end", { run: p.run_id, stop: res.stop, ms: Date.now() - t0, tools: res.tools.length, out_tokens: res.usage.output });
  }

  #requeue(rows: Row[], f: UpstreamFailure) {
    const { db } = this.d;
    for (const r of rows) {
      const pl = payloadOf(r), retry = (pl.retry ?? { n: 0, first: Date.now() }) as { n: number; first: number };
      const n = retry.n + 1, at = nextAttempt(f, n, retryDeadline(retry.first, undefined, Number(pl.retry_hours) || undefined));
      if (at === undefined) {
        db.run("UPDATE inbox SET status = 'failed' WHERE id = ?", Number(r.id));
        void notify.admin(`${String(pl.job ?? r.lane)}：上游一直不通，这次不跑了。`);
        continue;
      }
      db.run("UPDATE inbox SET status = 'received', run_id = NULL, not_before = ?, payload_json = ? WHERE id = ?", at, JSON.stringify({ ...pl, retry: { n, first: retry.first } }), Number(r.id));
    }
  }
}
