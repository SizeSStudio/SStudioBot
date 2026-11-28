// Items → `messages` (pending for triage), ported from core's ingestItems. The exclude list (Y5) is applied here, in
// code: an excluded place, author or address never reaches `messages`. raw_b64 goes into raw/ (content-addressed).
import type { SourceSpec } from "../config/load.ts";
import { sourcesConf } from "../config/load.ts";
import { run } from "../db/ambient.ts";
import { markReplied } from "../ledgers/events.ts";
import { putRaw } from "../memory/pages.ts";
import type { SourceItem } from "./types.ts";

const safeLink = (u: unknown) => typeof u === "string" && /^https?:\/\/\S+$/.test(u) ? u.slice(0, 1000) : undefined;
const cut = (v: unknown, n: number) => String(v).slice(0, n);

/** true when the exclude list says this item must not come in */
export function excluded(s: SourceSpec, it: SourceItem, ex = sourcesConf().exclude): boolean {
  const where = String(it.where ?? "");
  if (ex.chats.includes(s.id) || (where && (ex.chats.includes(where) || ex.chats.includes(`${s.id}:${where}`)))) return true;
  if (it.author && ex.persons.includes(String(it.author))) return true;
  const mails = new Set(ex.mails.map((m) => m.trim().toLowerCase()));
  return !!it.parties?.some((p) => mails.has(String(p).trim().toLowerCase()) || ex.persons.includes(String(p)));
}

/** returns how many were new. `from_me`: my own words there close the asks waiting on me in that place. */
export function ingestItems(s: SourceSpec, items: SourceItem[]): number {
  let n = 0;
  const ex = sourcesConf().exclude;
  for (const it of items) {
    const ref = (it as { id?: unknown; ref?: unknown }).id ?? (it as { ref?: unknown }).ref;
    if (!it || (typeof ref !== "string" && typeof ref !== "number") || !String(it.text ?? "").trim()) continue;
    if (excluded(s, it, ex)) continue;
    const where = String(it.where ?? "").replace(/\s+/g, " ").trim().slice(0, 60) || s.id;
    const tsRaw = typeof it.ts === "number" ? it.ts : Date.parse(String(it.ts ?? ""));
    const ts = Number.isFinite(tsRaw) && tsRaw > 0 ? (tsRaw < 1e12 ? tsRaw * 1000 : tsRaw) : Date.now();
    const fromMe = it.from_me === true;
    const place = `${s.id}:${where}`;
    const id = `src:${s.id}:${cut(ref, 200)}`;
    const replyTo = it.reply_to ? `src:${s.id}:${cut(it.reply_to, 200)}` : undefined;
    let raw_ref: string | undefined;
    if (typeof it.raw_b64 === "string" && it.raw_b64) {
      raw_ref = putRaw(Buffer.from(it.raw_b64, "base64"), { src: `source:${s.id}`, origin_url: safeLink(it.link), visibility: s.domain === "personal" ? "owner" : "work" });
    }
    const author = (it as { author?: unknown; who?: unknown }).author ?? (it as { who?: unknown }).who;
    const r = run(`INSERT OR IGNORE INTO messages(id, surface, chat_id, thread_id, sender_id, sender_kind, ts, text, raw_json, domain, triage_status)
        VALUES(?,?,?,?,?,?,?,?,?,?,?)`, id, `source:${s.id}`, place, it.thread ? cut(it.thread, 200) : null,
      null, fromMe ? "owner" : "other", ts, cut(it.text, 8000),
      JSON.stringify({ chat_name: it.where_name ? cut(it.where_name, 60) : where === s.id ? s.id : `${s.id} · ${where}`, sender_name: author ? cut(author, 60) : undefined,
        link: safeLink(it.link), source: s.id, to_me: it.to_me === true, reply_to: replyTo, raw_ref }),
      s.domain === "personal" ? "personal" : "work", fromMe ? "done" : "pending");
    if (!r.changes) continue;
    n++;
    if (fromMe) markReplied(place, ts, replyTo, { id, thread: it.thread ? cut(it.thread, 200) : null });
  }
  return n;
}
