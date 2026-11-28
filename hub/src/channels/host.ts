// The ChannelHost plugins write through (03 「inbox 和 run」): a `messages` row (what was said, for search and triage)
// and the inbox row, in one transaction, and nothing else — a channel callback must answer within seconds. The inbox
// row is W1d's ingest() (inbox.ts): its UNIQUE(source, source_msg_id) is the dedupe and it kicks the dispatcher.
import type { Db } from "../db/db.ts";
import { ingest, kickInbox } from "../inbox.ts";
import type { ChannelHost, IngestItem, IngestResult, MessageRow } from "./types.ts";

function writeMessage(db: Db, m: MessageRow): boolean {
  const r = db.run(`INSERT OR IGNORE INTO messages(id, surface, chat_id, thread_id, sender_id, sender_kind, ts, text, media_ref, raw_json, domain, lane, triage_status)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    m.id, m.surface, m.chat_id ?? null, m.thread_id ?? null, m.sender_id ?? null, m.sender_kind, m.ts, m.text, m.media_ref ?? null,
    m.raw ? JSON.stringify(m.raw) : null, m.domain ?? null, m.lane ?? null,
    // my own messages and the bot's are not triaged; everyone else's waits for triage (§读2.2)
    m.sender_kind === "other" ? "pending" : null);
  return Number(r.changes) > 0;
}

export function channelHost(db: Db): ChannelHost {
  return {
    ingest(item: IngestItem): IngestResult {
      return db.tx(() => {
        if (item.message) writeMessage(db, item.message);
        const r = ingest(db, { lane: item.lane, kind: item.kind, source: item.source, source_msg_id: item.source_msg_id,
          payload: item.payload, turn: item.turn, device_id: item.device_id });
        return r.dup ? { fresh: false } : { fresh: true, inboxId: r.id };
      });
    },
    record: (m) => db.tx(() => writeMessage(db, m)),
    kick: kickInbox,
  };
}
