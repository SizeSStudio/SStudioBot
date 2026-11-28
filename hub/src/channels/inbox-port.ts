// The minimal ChannelHost (03 「inbox 和 run」): write `messages` + `inbox` in one tx and nothing else. W1d's inbox
// module takes over (lanes, batching, dispatch) and passes its own kick(); the SQL here is what it has to keep:
// INSERT OR IGNORE on UNIQUE(source, source_msg_id) is the dedupe (message_id for messages, event_id for card clicks).
import type { Db } from "../db/db.ts";
import type { ChannelHost, IngestItem, IngestResult, MessageRow } from "./types.ts";

function writeMessage(db: Db, m: MessageRow): boolean {
  const r = db.run(`INSERT OR IGNORE INTO messages(id, surface, chat_id, thread_id, sender_id, sender_kind, ts, text, media_ref, raw_json, domain, lane, triage_status)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    m.id, m.surface, m.chat_id ?? null, m.thread_id ?? null, m.sender_id ?? null, m.sender_kind, m.ts, m.text, m.media_ref ?? null,
    m.raw ? JSON.stringify(m.raw) : null, m.domain ?? null, m.lane ?? null,
    // my own messages and the bot's are not triaged; everyone else's waits for triage (§读2.2)
    m.sender_kind === "other" ? "pending" : null);
  return r.changes > 0;
}

export function inboxPort(db: Db, kick: () => void = () => {}): ChannelHost {
  return {
    ingest(item: IngestItem): IngestResult {
      return db.tx(() => {
        if (item.message) writeMessage(db, item.message);
        const r = db.run(`INSERT OR IGNORE INTO inbox(lane, kind, source, source_msg_id, turn_ctx_json, payload_json, status, device_id, ts)
          VALUES(?,?,?,?,?,?,?,?,?)`,
          item.lane, item.kind, item.source, item.source_msg_id, item.turn ? JSON.stringify(item.turn) : null,
          JSON.stringify(item.payload), "received", item.device_id ?? null, Date.now());
        return r.changes ? { fresh: true, inboxId: Number(r.lastInsertRowid) } : { fresh: false };
      });
    },
    record: (m) => db.tx(() => writeMessage(db, m)),
    kick,
  };
}
