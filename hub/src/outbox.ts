// Everything the hub says goes through here: written first, delivered after (§底3.3, 03 「outbox 和出口组」).
// Delivery only through a channel plugin found by id (R3); nothing in this file knows a channel's API. Each row has
// an idem_key the plugin must treat as idempotent, which is what makes recover() (sending → queued) safe.
import type { Db, Row } from "./db/db.ts";
import { channelsConf } from "./config/load.ts";
import { redact } from "./tools/redact.ts";
import { log } from "./log.ts";
import { channel as channelOf } from "./channels/registry.ts";
import type { OutboxRow, RegisteredChannel, SendResult } from "./channels/types.ts";

// One shape for rows and results, one registry (03 「channels」): both live with the channel contract.
export type { ChannelCaps, OutboxRow, SendResult } from "./channels/types.ts";
/** What the outbox needs from a plugin: id, caps, send(). */
export type OutChannel = RegisteredChannel;

/**
 * The built-in `client` outlet: clients read the row through their own views (`messages`, approvals), so delivering
 * is writing it down. Push decides separately whether a device is told (03 push).
 */
export function clientChannel(db: Db): OutChannel {
  return {
    id: "client", caps: { cards: true, streaming: true },
    async send(o) {
      if (o.kind === "text") {
        const lane = o.lane ?? null;
        const domain = lane
          ? (db.one<{ domain: string }>("SELECT domain FROM threads WHERE lane = ?", lane)?.domain
            ?? (lane === "console:main" || lane === "feishu:dm:owner" ? "personal" : "work"))
          : "work";
        db.run(`INSERT OR IGNORE INTO messages(id, surface, chat_id, thread_id, sender_id, sender_kind, ts, text, domain, lane)
                VALUES (?, 'client', ?, ?, 'sbot', 'bot', ?, ?, ?, ?)`,
          `outbox:${o.id}`, (o.target.chat as string | undefined) ?? null, (o.target.thread as string | undefined) ?? null, Date.now(), o.payload, domain, lane);
      }
      return { ok: true, msg_id: `outbox:${o.id}` };
    },
  };
}

// ───────── writing rows ─────────

export interface Enqueue {
  channel: string; target: Record<string, unknown>; payload: string; kind?: "text" | "card"; lane?: string | null; run_id?: string | null;
  approval_id?: number | null; as_identity?: "bot" | "user"; send_by?: number | null; idem_key?: string; card_id?: string | null;
}

let kickOutbox: () => void = () => {};
/** The running Outbox registers itself, so a new row goes out now instead of on the next 5 s tick. */
export function setOutboxKick(fn: () => void) { kickOutbox = fn; }

/** One row. A given idem_key is written at most once: the second call returns the first row's id. */
export function enqueue(db: Db, o: Enqueue): number {
  // after the caller's transaction commits (a microtask runs once the synchronous tx is over)
  queueMicrotask(() => { try { kickOutbox(); } catch { /* the interval picks it up */ } });
  return db.tx(() => {
    if (o.idem_key) {
      const hit = db.one<{ id: number }>("SELECT id FROM outbox WHERE idem_key = ?", o.idem_key);
      if (hit) return hit.id;
    }
    const id = Number(db.run(
      `INSERT INTO outbox(approval_id, run_id, lane, channel, kind, card_id, as_identity, target_json, payload, idem_key, send_by, ts)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      o.approval_id ?? null, o.run_id || null, o.lane ?? null, o.channel, o.kind ?? "text", o.card_id ?? null, o.as_identity ?? "bot",
      // text leaves the process: redacted here too, whoever wrote it (03 tools); cards are redacted by cardOf
      JSON.stringify(o.target), (o.kind ?? "text") === "text" ? redact(o.payload) : o.payload, o.idem_key ?? null, o.send_by ?? null, Date.now(),
    ).lastInsertRowid);
    if (!o.idem_key) db.run("UPDATE outbox SET idem_key = ? WHERE id = ?", `sbot-ob-${id}`, id);
    return id;
  });
}

export type OutletGroup = "main" | "admin";

/** `client` | `<channel>` | `<channel>:<target…>` (config schema) → channel id and the target the plugin resolves. */
export function parseOutlet(entry: string): { channel: string; to?: string } {
  const i = entry.indexOf(":");
  return i < 0 ? { channel: entry } : { channel: entry.slice(0, i), to: entry.slice(i + 1) };
}

/**
 * Send to an outlet group (R3): one row per configured outlet. Outlets whose channel has no plugin running are skipped
 * (logged), `client` always gets its row. `cardsOnly` keeps outlets whose channel can show cards (approval cards).
 */
export function toOutlet(db: Db, group: OutletGroup, payload: string, o: { kind?: "text" | "card"; lane?: string; run_id?: string; idem?: string; send_by?: number; cardsOnly?: boolean; noClient?: boolean } = {}): number[] {
  const entries = channelsConf().outlets[group] ?? [];
  const ids: number[] = [];
  for (const e of entries) {
    const { channel, to } = parseOutlet(e);
    if (channel === "client" && o.noClient) continue;
    const p = channel === "client" ? undefined : channelOf(channel);
    if (channel !== "client" && !p) { log("outbox", "outlet has no channel running, skipped", { group, outlet: e }); continue; }
    if (o.cardsOnly && p && !p.caps.cards) continue;
    ids.push(enqueue(db, {
      channel, target: { outlet: group, ...(to ? { to } : {}), surface: channel === "client" ? "client" : `${channel}:${to ?? ""}` },
      payload, kind: o.kind, lane: o.lane ?? `outlet:${group}`, run_id: o.run_id, send_by: o.send_by,
      idem_key: o.idem ? `${o.idem}:${e}` : undefined,
    }));
  }
  return ids;
}

// ───────── delivery ─────────

const MAX_ATTEMPTS = 4;
const backoff = (attempts: number) => 2 ** attempts * 5_000;   // 10 s, 20 s, 40 s

const rowOf = (r: Row): OutboxRow => ({
  id: Number(r.id), approval_id: (r.approval_id as number | null) ?? null, run_id: (r.run_id as string | null) ?? null,
  lane: (r.lane as string | null) ?? null, channel: String(r.channel), kind: r.kind === "card" ? "card" : "text",
  card_id: (r.card_id as string | null) ?? null, as_identity: r.as_identity === "user" ? "user" : "bot",
  target: JSON.parse(String(r.target_json || "{}")), payload: String(r.payload), idem_key: String(r.idem_key),
  send_by: (r.send_by as number | null) ?? null, attempts: Number(r.attempts),
});

export type Settled = (row: OutboxRow, status: "sent" | "failed" | "unknown" | "expired" | "unrouted", detail?: string) => void;

export class Outbox {
  readonly db: Db;
  readonly #client: OutChannel;
  #busy = false;
  #again = false;
  #stopped = false;
  #timer: ReturnType<typeof setInterval> | undefined;
  #settled: Settled[] = [];

  constructor(db: Db) { this.db = db; this.#client = clientChannel(db); }

  onSettled(fn: Settled) { this.#settled.push(fn); }

  /** After a crash a row may sit in `sending`; it goes again with the same idem_key, so the plugin drops a repeat. */
  recover(): number {
    return Number(this.db.run("UPDATE outbox SET status = 'queued' WHERE status = 'sending'").changes);
  }

  start(everyMs = 5_000) {
    this.#stopped = false;
    const n = this.recover();
    if (n) log("outbox", "requeued rows left in sending", { n });
    this.#timer = setInterval(() => this.kick(), everyMs);
    this.#timer.unref?.();
    setOutboxKick(() => this.kick());
    this.kick();
  }
  stop() { if (this.#timer) clearInterval(this.#timer); this.#timer = undefined; this.#stopped = true; setOutboxKick(() => {}); }

  kick() {
    if (this.#stopped) return;
    if (this.#busy) { this.#again = true; return; }
    this.#busy = true;
    this.drain().catch((e) => log("outbox", "drain error", { err: String((e as Error)?.message ?? e).slice(0, 200) })).finally(() => {
      this.#busy = false;
      if (this.#again) { this.#again = false; this.kick(); }
    });
  }

  /** Waits until a drain that is running (and one asked for meanwhile) is over. Tests and shutdown. */
  async idle() { while (this.#busy) await new Promise((r) => setTimeout(r, 5)); }

  async drain() {
    const rows = this.db.all("SELECT * FROM outbox WHERE status = 'queued' AND COALESCE(next_try, 0) <= ? ORDER BY id LIMIT 50", Date.now());
    for (const r of rows) await this.#one(rowOf(r));
  }

  #settle(row: OutboxRow, status: Parameters<Settled>[1], detail?: string) {
    if (row.approval_id != null) this.db.run("UPDATE approvals SET result = ? WHERE id = ?", status, row.approval_id);
    for (const fn of this.#settled) { try { fn(row, status, detail); } catch { /* listeners never stop delivery */ } }
  }

  async #one(row: OutboxRow) {
    const db = this.db;
    if (row.send_by && row.send_by < Date.now()) {
      db.run("UPDATE outbox SET status = 'expired' WHERE id = ?", row.id);
      log("outbox", "expired before sending", { id: row.id });
      return this.#settle(row, "expired");
    }
    const ch = row.channel === "client" ? this.#client : channelOf(row.channel);
    if (!ch) {
      db.run("UPDATE outbox SET status = 'unrouted', error = ? WHERE id = ?", `no channel plugin "${row.channel}"`, row.id);
      log("outbox", "no plugin for channel", { id: row.id, channel: row.channel });
      return this.#settle(row, "unrouted");
    }
    db.run("UPDATE outbox SET status = 'sending', attempts = attempts + 1 WHERE id = ?", row.id);
    let res: SendResult;
    try { res = await ch.send(row); } catch (e) { res = { ok: false, error: String((e as Error)?.message ?? e), retry: true }; }
    const attempts = row.attempts + 1;
    if (res.ok) {
      db.run("UPDATE outbox SET status = 'sent', sent_msg_id = ?, error = NULL WHERE id = ?", res.msg_id ?? null, row.id);
      return this.#settle(row, "sent");
    }
    const err = res.error.slice(0, 500);
    if (res.unknown) {   // §底3.3: it may have gone out; sending again could say it twice
      db.run("UPDATE outbox SET status = 'unknown', error = ? WHERE id = ?", err, row.id);
      log("outbox", "send result unknown, not retried", { id: row.id });
      return this.#settle(row, "unknown", err);
    }
    const final = res.retry === false || attempts >= MAX_ATTEMPTS;
    db.run("UPDATE outbox SET status = ?, error = ?, next_try = ? WHERE id = ?", final ? "failed" : "queued", err, final ? null : Date.now() + backoff(attempts), row.id);
    log("outbox", final ? "send failed for good" : "send failed, will retry", { id: row.id, attempts });
    if (final) this.#settle(row, "failed", err);
  }
}
