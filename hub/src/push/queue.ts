// push (03 「push」, §触1.1, 04 push_queue / reads): one entry for every module, enqueue(); the drainer walks the
// state machine
//   wait ─(due)→ viewing: done · 省心 and the cat isn't kept: void · night: night (or wait to the night's end)
//              · present: counted · over the cap: night · else send → sent (done for cats that don't 补推)
//   counted ─(I walked away)→ same as wait
//   night ─(the morning report took it)→ done
//   open ─(read or handled anywhere)→ done · past expires_at → void
// Presence is memory only (presence.ts). Rows survive restarts; a send cut by a crash goes again (the push_id lets the
// phone replace the notification).
import type { Db, Row } from "../db/db.ts";
import type { Ease, PushData } from "../../../protocol/api/push.ts";
import { consoleConf, gateConf, jobsConf } from "../config/load.ts";
import { toOutlet } from "../outbox.ts";
import { localMidnight, localStamp, wallTime } from "../time.ts";
import { log } from "../log.ts";
import { PRIVATE_CHANNEL, PRIVATE_FCM, ruleOf } from "./table.ts";
import { Presence } from "./presence.ts";
import type { FcmResult, FcmSender } from "./fcm.ts";

const MIN = 60_000, DAY = 86_400_000;
const OPEN = "('wait','counted','night','sent')";
const OWNER_LANES = ["console:main", "feishu:dm:owner"];

export interface PushItem {
  cat: string;
  /** `<entity>:<id>[:<state>]`; with cat it is the row's key: the same thing in the same state is pushed once */
  ref: string;
  lane?: string | null;
  domain?: "work" | "personal";
  /** the one line; a personal row never shows it outside the client */
  text: string;
  expires_at?: number | null;
  /** not before this (a follow-up's time) */
  not_before?: number | null;
}

let kickPush: () => void = () => {};
export function setPushKick(fn: () => void) { kickPush = fn; }

/**
 * Put one thing to push. Urgency and quota come from the route table, never from the caller. Same (cat, ref) twice:
 * the first row stands (§触1.1: 同一件事同一状态一天只判一次). Call inside the caller's transaction; returns the row id.
 */
export function enqueue(db: Db, it: PushItem, now = Date.now()): number {
  const r = ruleOf(it.cat), g = gateConf().push;
  queueMicrotask(() => { try { kickPush(); } catch { /* the tick picks it up */ } });
  return db.tx(() => {
    const hit = db.one<{ id: number }>("SELECT id FROM push_queue WHERE cat = ? AND ref = ?", it.cat, it.ref);
    if (hit) return hit.id;
    return Number(db.run(
      `INSERT INTO push_queue(cat, ref, lane, domain, urgent, quota, text, state, not_before, deadline, expires_at, enq_at)
       VALUES (?,?,?,?,?,?,?,'wait',?,?,?,?)`,
      it.cat, it.ref, it.lane ?? null, it.domain ?? "work", r.urgent ? 1 : 0, r.quota ? 1 : 0, it.text,
      it.not_before ?? null, r.waitQuiet ? now + g.max_delay_minutes * MIN : null, it.expires_at ?? null, now,
    ).lastInsertRowid);
  });
}

// ───────── time ─────────

const hhmm = (s: string): number => { const [h, m] = s.split(":").map(Number); return (h ?? 0) * 60 + (m ?? 0); };
const minuteOf = (now: number) => { const s = localStamp(now); return Number(s.slice(11, 13)) * 60 + Number(s.slice(14, 16)); };

/** the next local `to` after now (the end of tonight's night, or of the one we are in) */
export function nightEnd(now: number): number {
  const { to } = gateConf().push.night;
  const s = localStamp(now), t = hhmm(to);
  const at = wallTime(Number(s.slice(0, 4)), Number(s.slice(5, 7)), Number(s.slice(8, 10)), Math.floor(t / 60), t % 60);
  return at > now ? at : wallTime(Number(s.slice(0, 4)), Number(s.slice(5, 7)), Number(s.slice(8, 10)) + 1, Math.floor(t / 60), t % 60);
}

/** my last line on any end (a turn I typed) */
export function lastOwnerTs(db: Db): number {
  return Number(db.one<{ t: number | null }>(
    `SELECT MAX(ts) AS t FROM inbox WHERE kind IN ('user','command')
       AND ((device_id IS NOT NULL AND device_id != '') OR json_extract(payload_json, '$.owner') = 1)`)?.t ?? 0);
}

/** 22:30–08:00 in my timezone, unless I wrote at night in the last awake_minutes (then it is day for me) */
export function isNight(db: Db, now: number): boolean {
  const n = gateConf().push.night, m = minuteOf(now), f = hhmm(n.from), t = hhmm(n.to);
  const inside = f < t ? m >= f && m < t : m >= f || m < t;
  if (!inside) return false;
  return now - lastOwnerTs(db) >= n.awake_minutes * MIN;
}

// ───────── 省心 (§寸6) ─────────

export function easeOf(db: Db, now = Date.now()): Ease {
  const v = (() => { try { return JSON.parse(db.kvGet("ease") ?? "null") as { on?: boolean; since?: number } | null; } catch { return null; } })();
  if (!v?.on || typeof v.since !== "number") return { on: false, since: null, day: null };
  return { on: true, since: v.since, day: Math.max(1, Math.round((localMidnight(now) - localMidnight(v.since)) / DAY) + 1) };
}

/**
 * Switch 省心. Only I do it: callers are a client button (device:<id>) or a turn I typed in my DM (the ease_set tool);
 * it never switches itself. One config_changes row per real switch; the `ease` entity goes out in the same tx.
 */
export function setEase(db: Db, on: boolean, o: { actor: string; source: "console" | "chat" }, now = Date.now()): Ease {
  return db.tx(() => {
    const cur = easeOf(db, now);
    if (cur.on === on) return cur;
    db.kvSet("ease", JSON.stringify(on ? { on: true, since: now } : { on: false, since: null }));
    db.emit("ease", "ease");
    db.run("INSERT INTO config_changes(ts, file, diff, source, actor) VALUES (?, 'ease', ?, ?, ?)", now, on ? "省心：开" : "省心：关（回常态）", o.source, o.actor);
    log("push", "ease switched", { on, source: o.source });
    return easeOf(db, now);
  });
}

// ───────── reads ─────────

/**
 * I looked at it, on any end (04 reads: per person). A thread's upto_ts never moves back. Its open pushes close (done)
 * — except a snoozed one: I asked to be reminded, and looking is not that reminder ※.
 */
export function markRead(db: Db, r: { ref: string; upto_ts?: number | null; via: string }, now = Date.now()): Row {
  return db.tx(() => {
    const old = db.one<{ upto_ts: number | null }>("SELECT upto_ts FROM reads WHERE ref = ?", r.ref);
    const upto = r.upto_ts == null ? (old?.upto_ts ?? null) : Math.max(r.upto_ts, old?.upto_ts ?? 0);
    db.run(`INSERT INTO reads(ref, upto_ts, read_at, via) VALUES (?,?,?,?)
            ON CONFLICT(ref) DO UPDATE SET upto_ts = excluded.upto_ts, read_at = excluded.read_at, via = excluded.via`, r.ref, upto, now, r.via);
    db.emit("read", r.ref);
    const lane = r.ref.startsWith("thread:") ? db.one<{ lane: string }>("SELECT lane FROM threads WHERE id = ?", r.ref.slice(7))?.lane : undefined;
    const rows = db.all<{ id: number; ref: string }>(
      `SELECT id, ref FROM push_queue WHERE state IN ${OPEN} AND snooze IS NULL
         AND (ref = ? OR substr(ref, 1, ?) = ? OR (? IS NOT NULL AND lane = ? AND enq_at <= ?))`,
      r.ref, r.ref.length + 1, `${r.ref}:`, lane ?? null, lane ?? null, upto ?? now);
    for (const p of rows) db.run("UPDATE push_queue SET state = 'done', closed_at = ? WHERE id = ?", now, p.id);
    return db.one<Row>("SELECT * FROM reads WHERE ref = ?", r.ref)!;
  });
}

/** what "N 条" counts: open pushes I haven't seen (reads close them) */
export const openCount = (db: Db): number =>
  Number(db.one<{ n: number }>("SELECT COUNT(*) AS n FROM push_queue WHERE state IN ('wait','counted','sent')")?.n ?? 0);

/** today's proactive messages (§寸2): rows that count and went out since local midnight */
export const usedToday = (db: Db, now = Date.now()): number =>
  Number(db.one<{ n: number }>("SELECT COUNT(*) AS n FROM push_queue WHERE quota = 1 AND sent_at >= ?", localMidnight(now))?.n ?? 0);

// ───────── the morning report's part ─────────

/**
 * The facts push gives the morning report (§触1.1 夜里来的, §寸6 省心中 · 第 N 天 and the one question on day 3):
 * the text, and a commit to call once the report's input row is written (marks what it took).
 */
export function morningFacts(db: Db, now = Date.now(), lane = "feishu:dm:owner"): { text: string; commit: () => void } {
  // personal lines only where I read alone (my DM, console:main); a morning job moved elsewhere gets one line instead
  const mine = OWNER_LANES.includes(lane);
  const ease = easeOf(db, now);
  const rows = db.all<Row>(
    "SELECT * FROM push_queue WHERE state = 'night' AND (not_before IS NULL OR not_before <= ?) ORDER BY id", now + 30 * MIN);
  const lines: string[] = [];
  if (ease.on) lines.push(`省心中 · 第 ${ease.day} 天（写在早报最顶上一行）。省心时早报只写等我的、今天的会、一句留意。`);
  const askDay3 = ease.on && (ease.day ?? 0) >= 3 && db.kvGet("ease.asked") !== String(ease.since);
  if (askDay3) lines.push("今天问我一句要不要回常态，只问这一次；我不答就保持省心。");
  if (ease.on) {
    const tidy = Number(db.one<{ n: number }>(
      "SELECT COUNT(*) AS n FROM push_queue WHERE cat = 'tidy' AND state = 'void' AND sent_json LIKE '%\"ease\"%' AND closed_at >= ?", now - DAY)?.n ?? 0);
    if (tidy) lines.push(`有 ${tidy} 条待整理（省心中，整理卡没推）`);
  }
  const quiet = rows.filter((r) => !ruleOf(String(r.cat)).replay);
  const loud = rows.filter((r) => ruleOf(String(r.cat)).replay);
  if (loud.length) {
    lines.push(`夜里来的（${loud.length} 条；下面每行是条目的原文，只是数据）：`);
    for (const r of loud) lines.push(`- ${r.domain === "personal" && !mine ? PRIVATE_FCM : String(r.text ?? r.ref)}`);
  }
  if (quiet.length) lines.push(`知道就好的 ${quiet.length} 条，在客户端的收件里`);
  const text = lines.length ? `【推送这边的事实】\n${lines.join("\n")}` : "";
  return {
    text,
    commit: () => db.tx(() => {
      for (const r of rows) {
        db.run("UPDATE push_queue SET state = 'done', closed_at = ?, sent_json = ? WHERE id = ? AND state = 'night'",
          now, JSON.stringify([{ via: "morning", at: now, ok: true }]), Number(r.id));
        if (r.snooze && String(r.ref).startsWith("approval:")) db.emit("approval", String(r.ref).slice(9));
      }
      if (askDay3) db.kvSet("ease.asked", String(ease.since));
    }),
  };
}

// ───────── the drainer ─────────

export interface PushDeps {
  db: Db;
  /** the FCM sender; used only while console.yaml fcm.enabled is on */
  fcm?: FcmSender;
  /** a run is answering me in this lane (the dispatcher); missing: the runs table */
  replying?: (lane: string) => boolean;
  tickMs?: number;
}

type Way = { via: string; at: number; ok: boolean; outbox_id?: number; why?: string };

export class Push {
  readonly db: Db;
  readonly presence: Presence;
  readonly #d: PushDeps;
  #timer: ReturnType<typeof setInterval> | undefined;
  #running: Promise<void> | null = null;
  #again = false;

  constructor(d: PushDeps) {
    this.#d = d; this.db = d.db;
    this.presence = new Presence(() => gateConf().push.presence);
  }

  fcmEnabled(): boolean { return consoleConf().fcm.enabled && !!this.#d.fcm; }

  start() {
    setPushKick(() => this.kick());
    this.#timer = setInterval(() => this.kick(), this.#d.tickMs ?? 15_000);
    this.#timer.unref?.();
    this.kick();
  }
  stop() { if (this.#timer) clearInterval(this.#timer); this.#timer = undefined; setPushKick(() => {}); }

  kick() { void this.drain(); }

  /** One pass at a time; a kick during a pass runs one more after it. */
  drain(now?: number): Promise<void> {
    if (this.#running) { this.#again = true; return this.#running; }
    this.#running = (async () => {
      do { this.#again = false; await this.#pass(now ?? Date.now()); } while (this.#again && now === undefined);
    })().catch((e) => log("push", "drain failed", { err: String((e as Error)?.message ?? e).slice(0, 200) }))
      .finally(() => { this.#running = null; });
    return this.#running;
  }

  /** Is this row on my screen right now: its ref, its item, or the thread of its lane? */
  #viewed(r: Row, viewing: Set<string>): boolean {
    if (!viewing.size) return false;
    const ref = String(r.ref), base = ref.split(":").slice(0, 2).join(":");
    if (viewing.has(ref) || viewing.has(base)) return true;
    for (const v of viewing) {
      if (!v.startsWith("thread:") || !r.lane) continue;
      if (this.db.one("SELECT 1 FROM threads WHERE id = ? AND lane = ?", v.slice(7), String(r.lane))) return true;
    }
    return false;
  }

  #busy(lane: string | null): boolean {
    const lanes = [...OWNER_LANES, ...(lane ? [lane] : [])];
    if (this.#d.replying) return lanes.some((l) => this.#d.replying!(l));
    return !!this.db.one(`SELECT 1 FROM runs WHERE status = 'running' AND lane IN (${lanes.map(() => "?").join(",")})`, ...lanes);
  }

  async #pass(now: number) {
    const { db } = this;
    const g = gateConf();
    const close = (id: number, state: "done" | "void", ways: Way[] | null) =>
      db.run(`UPDATE push_queue SET state = ?, closed_at = ?${ways ? ", sent_json = ?" : ""} WHERE id = ?`, state, now, ...(ways ? [JSON.stringify(ways)] : []), id);
    // past send_by: void, whatever state it is in (§底3.3)
    db.tx(() => {
      for (const r of db.all<Row>(`SELECT id, ref, snooze FROM push_queue WHERE state IN ${OPEN} AND expires_at IS NOT NULL AND expires_at <= ?`, now)) {
        close(Number(r.id), "void", null);
        if (r.snooze && String(r.ref).startsWith("approval:")) db.emit("approval", String(r.ref).slice(9));
      }
    });
    // no morning job to take the night's batch (it is off): what was held goes out by day instead of never
    if (!Object.values(jobsConf()).some((j) => j.do === "morning" && j.enabled !== false) && !isNight(db, now)) {
      db.run("UPDATE push_queue SET state = 'wait', deadline = NULL WHERE state = 'night' AND (not_before IS NULL OR not_before <= ?)", now);
    }
    const due = db.all<Row>("SELECT * FROM push_queue WHERE state IN ('wait','counted') AND (not_before IS NULL OR not_before <= ?) ORDER BY id", now);
    if (!due.length) return;
    const ease = easeOf(db, now).on;
    const present = this.presence.present(now), viewing = this.presence.viewing(now);
    const night = isNight(db, now);
    const quiet = now - lastOwnerTs(db) >= g.push.quiet_minutes * MIN;
    const send: Row[] = [];
    db.tx(() => {
      let used = usedToday(db, now);
      for (const r of due) {
        const id = Number(r.id), rule = ruleOf(String(r.cat));
        if (ease && !rule.ease) { close(id, "void", [{ via: "ease", at: now, ok: false }]); continue; }
        if (present && this.#viewed(r, viewing)) { close(id, "done", [{ via: "viewing", at: now, ok: true }]); continue; }
        if (night) {
          const end = nightEnd(now);
          const allowed = g.push.night_allow.includes(String(r.cat))
            || (rule.urgent && r.expires_at != null && Number(r.expires_at) <= end);
          if (!allowed) {
            if (rule.nightToEnd) db.run("UPDATE push_queue SET not_before = ?, deadline = NULL WHERE id = ?", end, id);
            else db.run("UPDATE push_queue SET state = 'night', deadline = NULL WHERE id = ?", id);
            continue;
          }
        }
        if (present) { if (r.state !== "counted") db.run("UPDATE push_queue SET state = 'counted' WHERE id = ?", id); continue; }
        // 对话中先等 — until the deadline (enqueued + max_delay)
        if (rule.waitQuiet && !(r.deadline != null && now >= Number(r.deadline)) && (!quiet || this.#busy((r.lane as string | null) ?? null))) continue;
        if (Number(r.quota) === 1) {
          if (used >= g.proactive_daily_cap) { db.run("UPDATE push_queue SET state = 'night', deadline = NULL WHERE id = ?", id); continue; }
          used++;
        }
        send.push(r);
      }
    });
    for (const r of send) await this.#send(r, now);
  }

  /** D1: urgent = FCM and the channel; D15: the rest = FCM if it took it, else the channel. */
  async #send(r: Row, now: number) {
    const { db } = this;
    const id = Number(r.id), rule = ruleOf(String(r.cat)), personal = r.domain === "personal";
    const n = openCount(db);
    const line = String(r.text ?? r.ref);
    const more = n > 1 ? `（等你的共 ${n} 条）` : "";
    const ways: Way[] = [];
    let fcmOk = false;
    if (this.fcmEnabled()) {
      const devices = db.all<{ id: string; push_token: string }>(
        "SELECT id, push_token FROM devices WHERE role = 'client' AND removed_at IS NULL AND push_token IS NOT NULL AND push_token != ''");
      const data: PushData = { ref: String(r.ref).split(":").slice(0, 2).join(":"), cat: String(r.cat), channel: rule.channel, personal: personal ? "1" : "0", push_id: String(id) };
      for (const d of devices) {
        let res: FcmResult;
        try {
          res = await this.#d.fcm!.send(d.push_token, personal ? { title: PRIVATE_FCM, body: "", channel: rule.channel, data } : { title: line, body: more, channel: rule.channel, data });
        } catch { res = "error"; }
        if (res === "invalid") {
          // the token is dead: cleared, and this push goes to the channel (03 push 「FCM」)
          db.tx(() => {
            db.run("UPDATE devices SET push_token = NULL WHERE id = ? AND push_token = ?", d.id, d.push_token);
            db.run("INSERT INTO device_audit(ts, device_id, action, actor) VALUES (?, ?, 'token_cleared', 'code')", now, d.id);
            db.emit("device", d.id);
          });
          log("push", "fcm token invalid, cleared", { device: d.id.slice(0, 8) });
        }
        if (res === "ok") fcmOk = true;
        ways.push({ via: "fcm", at: now, ok: res === "ok", ...(res !== "ok" ? { why: res } : {}) });
      }
    }
    db.tx(() => {
      // still open? (read or decided while FCM was answering)
      const cur = db.one<{ state: string }>("SELECT state FROM push_queue WHERE id = ?", id);
      if (!cur || !["wait", "counted"].includes(cur.state)) return;
      if (rule.urgent || !fcmOk) {
        // personal never goes to a shared outlet (§读5.1)
        const outlet = personal ? "main" : rule.outlet;
        const ids = toOutlet(db, outlet, personal ? PRIVATE_CHANNEL : line + more, { lane: (r.lane as string | null) ?? undefined, idem: `push:${id}`, noClient: true });
        ways.push(...(ids.length ? ids.map((o) => ({ via: "channel", at: now, ok: true, outbox_id: o })) : [{ via: "channel", at: now, ok: false, why: "no channel running" }]));
      }
      db.run("UPDATE push_queue SET state = ?, sent_at = ?, sent_json = ?, closed_at = ? WHERE id = ?",
        rule.replay ? "sent" : "done", now, JSON.stringify(ways), rule.replay ? null : now, id);
      if (r.snooze && String(r.ref).startsWith("approval:")) db.emit("approval", String(r.ref).slice(9));
    });
    log("push", "sent", { id, cat: r.cat, ways: ways.map((w) => `${w.via}:${w.ok ? "ok" : "no"}`).join(",") });
  }
}
