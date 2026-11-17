// Feishu adapter, bot identity (DESIGN §3.1, §3.4): owner DM, admin group, workbench, card callbacks.
// Group routing (admin group / workbench) is in routes.ts; groups the owner is in are read by the observer.
//
// Receive: `lark-cli event consume im.message.receive_v1 --as bot` (NDJSON on stdout, one event per line). The handler
// only writes to messages + inbox and returns (§1.2). Events missed while the core was down are caught up from the
// DM history (+chat-messages-list) using chat_cursors, deduped by message_id via inbox UNIQUE(source, source_msg_id).
// Send: +messages-reply / +messages-send --as bot with --idempotency-key = outbox.idem_key, text on stdin.

import { spawn, execFile } from "node:child_process";
import { createInterface } from "node:readline";
import { mkdirSync } from "node:fs";
import { P, ownerFeishu, log } from "./config.ts";
import { one, run, tx, kvGet, kvSet } from "./db.ts";
import type { TurnContext } from "./tools.ts";

const LARK = process.env.SBOT_LARK_CLI ?? "lark-cli";
const larkEnv = () => ({ PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: P.larkHome, LANG: "en_US.UTF-8" });
export const OWNER_DM_LANE = "feishu:dm:owner";

export function lark(args: string[], stdin?: string, timeoutMs = 60_000): Promise<string> {
  return new Promise((ok, bad) => {
    const p = execFile(LARK, args, { env: larkEnv(), timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) bad(Object.assign(new Error(`lark-cli ${args.slice(0, 2).join(" ")} failed: ${String(stderr || err.message).slice(0, 400)}`), { code: (err as any).code }));
      else ok(stdout);
    });
    if (stdin !== undefined) { p.stdin!.end(stdin); }
  });
}

export interface Incoming { message_id: string; chat_id: string; chat_type: string; sender_id: string; sender_type?: string; content: string; message_type?: string; create_time: string | number; thread_id?: string; root_id?: string; mentions?: unknown[] }

export type Ingest = (m: Incoming, via: "event" | "catchup") => void;

/** Write one incoming message. Returns true if it was new. Commands are routed by the caller's onCommand. */
export function ingest(m: Incoming, onCommand: (cmd: string, arg: string, turn: TurnContext, inboxId: number) => void): boolean {
  const owner = ownerFeishu();
  const ts = Number(m.create_time) || Date.now();
  const isOwnerDm = m.chat_type === "p2p" && !!owner && m.sender_id === owner;
  const lane = isOwnerDm ? OWNER_DM_LANE : null;
  const turn: TurnContext = { channel: "feishu", chat_id: m.chat_id, message_id: m.message_id, thread_id: m.thread_id, surface: "feishu:dm" };
  const text = (m.content ?? "").trim();
  const cmd = isOwnerDm ? /^\/(new|stop|model|usage|help|group|tasks|job|improve)\b\s*([\s\S]*)$/i.exec(text) : null;
  let inboxId = 0;
  const fresh = tx(() => {
    run(`INSERT OR IGNORE INTO messages(id, surface, chat_id, thread_id, sender_id, sender_kind, ts, text, raw_json, lane)
         VALUES(?,?,?,?,?,?,?,?,?,?)`, m.message_id, m.chat_type === "p2p" ? "feishu:dm" : "feishu:group", m.chat_id, m.thread_id ?? null,
      m.sender_id, isOwnerDm ? "owner" : "other", ts, text, JSON.stringify({ message_type: m.message_type, root_id: m.root_id }), lane);
    if (!lane) return false;
    const r = run(`INSERT OR IGNORE INTO inbox(lane, kind, source, source_msg_id, turn_ctx_json, payload_json, status, ts) VALUES(?,?,?,?,?,?,?,?)`,
      lane, cmd ? "command" : "user", "feishu", m.message_id, JSON.stringify(turn),
      JSON.stringify({ text, message_type: m.message_type, ts }), cmd ? "done" : "received", Date.now());
    if (!r.changes) return false;
    inboxId = Number(r.lastInsertRowid);
    run(`INSERT INTO chat_cursors(chat_id, surface, last_msg_ts, last_msg_id, updated_at) VALUES(?,?,?,?,?)
         ON CONFLICT(chat_id, surface) DO UPDATE SET last_msg_ts=MAX(last_msg_ts, excluded.last_msg_ts),
         last_msg_id=CASE WHEN excluded.last_msg_ts >= last_msg_ts THEN excluded.last_msg_id ELSE last_msg_id END, updated_at=excluded.updated_at`,
      m.chat_id, "feishu:dm", ts, m.message_id, Date.now());
    return true;
  });
  if (isOwnerDm && !kvGet("feishu.owner_dm_chat")) kvSet("feishu.owner_dm_chat", m.chat_id);
  if (!lane) { if (m.chat_type === "p2p") log("feishu", "DM from non-owner ignored (M0)", { sender: m.sender_id.slice(0, 8) }); return false; }
  if (fresh && cmd) onCommand(cmd[1].toLowerCase(), cmd[2].trim(), turn, inboxId);
  return fresh;
}

export class FeishuAdapter {
  private children = new Map<string, ReturnType<typeof spawn>>();
  private stopped = false;
  /** per event stream, for the console's status page */
  readonly streams: Record<string, { ready: boolean; since: number; restarts: number; lastEvent?: number }> = {};
  private onMessage: (m: Incoming, via: "event" | "catchup") => void;
  private onCard: (ev: any) => void;
  constructor(onMessage: (m: Incoming, via: "event" | "catchup") => void, onCard: (ev: any) => void) {
    this.onMessage = onMessage; this.onCard = onCard; mkdirSync(P.larkHome, { recursive: true });
  }

  start() {
    this.consume("im.message.receive_v1", (ev) => this.onMessage({ ...ev, message_id: ev.message_id ?? ev.id }, "event"), true);
    this.consume("card.action.trigger", (ev) => this.onCard(ev));   // one EventKey per lark-cli process
    this.catchUp().catch((e) => log("feishu", "catch-up failed", { err: String(e.message ?? e) }));
  }
  stop() { this.stopped = true; for (const c of this.children.values()) c.kill("SIGTERM"); }

  private consume(key: string, handle: (ev: any) => void, catchUpOnRestart = false, backoff = 1000) {
    if (this.stopped) return;
    const child = spawn(LARK, ["event", "consume", key, "--as", "bot"], { env: larkEnv(), stdio: ["pipe", "pipe", "pipe"] });
    this.children.set(key, child);
    let ready = false, healthy = false;
    const st = this.streams[key] = { ready: false, since: Date.now(), restarts: (this.streams[key]?.restarts ?? -1) + 1, lastEvent: this.streams[key]?.lastEvent };
    createInterface({ input: child.stdout! }).on("line", (line) => {
      if (!line.trim()) return;
      try { healthy = true; st.lastEvent = Date.now(); handle(JSON.parse(line)); }
      catch (e: any) { log("feishu", "bad event line", { key, err: String(e.message ?? e), head: line.slice(0, 80) }); }
    });
    createInterface({ input: child.stderr! }).on("line", (line) => {
      if (!ready && /ready|listening|subscribed|connected/i.test(line)) { ready = true; st.ready = true; log("feishu", "event stream ready", { key }); }
      else if (/error|fail|drop|online_instance_cnt=[1-9]/i.test(line)) log("feishu", `lark-cli (${key}): ` + line.slice(0, 300));   // another consumer of this app would split events
    });
    child.on("exit", (code, sig) => {
      st.ready = false;
      if (this.stopped) return;
      const wait = healthy ? 1000 : backoff;
      log("feishu", "event stream exited, restarting", { key, code, sig, in_ms: wait });
      setTimeout(() => {
        this.consume(key, handle, catchUpOnRestart, Math.min(wait * 2, 60_000));
        if (catchUpOnRestart) this.catchUp().catch(() => {});
      }, wait);
    });
  }

  /** Pull DM messages newer than the cursor (minus a margin); duplicates are dropped by the inbox UNIQUE key. */
  async catchUp() {
    const chat = kvGet("feishu.owner_dm_chat");
    if (!chat) { log("feishu", "catch-up skipped: owner DM chat not known yet (learned from the first message)"); return; }
    const cur = one("SELECT last_msg_ts FROM chat_cursors WHERE chat_id=? AND surface='feishu:dm'", chat);
    const since = Math.max((cur?.last_msg_ts ?? Date.now() - 3600_000) - 120_000, Date.now() - 24 * 3600_000);
    const out = await lark(["im", "+chat-messages-list", "--chat-id", chat, "--as", "bot", "--order", "asc", "--no-reactions",
      "--start", new Date(since).toISOString(), "--end", new Date(Date.now() + 60_000).toISOString(), "--page-all", "--json"]);
    const items = extractMessages(JSON.parse(out));
    let n = 0;
    for (const it of items) {
      const m = normalizeListed(it, chat);
      if (m) { this.onMessage(m, "catchup"); n++; }
    }
    log("feishu", "catch-up done", { listed: items.length, considered: n });
  }
}

function extractMessages(j: any): any[] {
  for (const k of ["messages", "items", "data"]) {
    const v = k === "data" ? j?.data : j?.[k] ?? j?.data?.[k];
    if (Array.isArray(v)) return v;
    if (v && typeof v === "object") { const inner = extractMessages(v); if (inner.length) return inner; }
  }
  return Array.isArray(j) ? j : [];
}

/** +chat-messages-list rows → Incoming. Only messages from users count; the bot's own messages are skipped. */
function normalizeListed(it: any, chat: string): Incoming | null {
  const sender = it.sender ?? {};
  const senderId = sender.id ?? sender.open_id ?? sender.sender_id ?? it.sender_id;
  const kind = sender.sender_type ?? sender.type ?? it.sender_type;
  if (!senderId || kind === "app" || kind === "bot") return null;
  const id = it.message_id ?? it.id;
  if (!id) return null;
  let content = it.content ?? it.text ?? "";
  if (typeof content !== "string") content = JSON.stringify(content);
  return { message_id: id, chat_id: it.chat_id ?? chat, chat_type: "p2p", sender_id: senderId, sender_type: kind, content,
    message_type: it.msg_type ?? it.message_type, create_time: listedTime(it.create_time), thread_id: it.thread_id, root_id: it.root_id };
}

/** +chat-messages-list prints create_time as "2026-11-16 23:12" (UTC+8, minute precision); events use ms strings. */
function listedTime(v: unknown): number {
  if (typeof v === "number" || /^\d{12,}$/.test(String(v))) return Number(v);
  const m = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2})(:\d{2})?$/.exec(String(v ?? ""));
  return m ? Date.parse(`${m[1]}T${m[2]}${m[3] ?? ":00"}+08:00`) : Date.now();
}

/** Send one outbox row. Replies to the triggering message when known; markdown on stdin; idempotent by key. */
export async function feishuSend(target: TurnContext, text: string, idemKey: string, as: "bot" | "user" = "bot"): Promise<string | undefined> {
  const args = target.message_id
    ? ["im", "+messages-reply", "--message-id", target.message_id, "--as", as, "--markdown", "-", "--idempotency-key", idemKey, "--json", ...(target.in_thread ? ["--reply-in-thread"] : [])]
    : ["im", "+messages-send", "--chat-id", target.chat_id, "--as", as, "--markdown", "-", "--idempotency-key", idemKey, "--json"];
  const out = await lark(args, text);
  try { const j = JSON.parse(out); return j.message_id ?? j.data?.message_id ?? j.data?.id; } catch { return undefined; }
}
