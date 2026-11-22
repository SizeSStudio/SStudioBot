// Outbox dispatcher (DESIGN §底3.3). Everything the agent says goes through here: written first, delivered after.
// Feishu sends carry an idempotency key (outbox.idem_key), so a row left in `sending` by a crash is safe to retry.

import { all, run, tx } from "./db.ts";
import { log } from "./config.ts";
import { feishuSend } from "./feishu.ts";
import type { TurnContext } from "./tools.ts";

const MAX_ATTEMPTS = 4;

export class Outbox {
  private busy = false;
  private again = false;
  private timer?: NodeJS.Timeout;
  private onSent?: (row: Record<string, any>, msgId?: string) => void;
  private onFailed?: (row: Record<string, any>, err: string) => void;
  constructor(onSent?: (row: Record<string, any>, msgId?: string) => void, onFailed?: (row: Record<string, any>, err: string) => void) { this.onSent = onSent; this.onFailed = onFailed; }

  start() {
    // a crash mid-send leaves `sending`; with an idempotency key a retry can't duplicate
    run("UPDATE outbox SET status='queued' WHERE status='sending'");
    this.timer = setInterval(() => this.kick(), 15_000);
    this.kick();
  }
  stop() { clearInterval(this.timer); }

  kick() {
    if (this.busy) { this.again = true; return; }
    this.busy = true;
    this.drain().catch((e) => log("outbox", "drain error", { err: String(e?.message ?? e) })).finally(() => {
      this.busy = false;
      if (this.again) { this.again = false; this.kick(); }
    });
  }

  private async drain() {
    const rows = all("SELECT * FROM outbox WHERE status='queued' AND COALESCE(next_try,0) <= ? ORDER BY id LIMIT 20", Date.now());
    for (const row of rows) {
      if (row.send_by && row.send_by < Date.now()) {
        run("UPDATE outbox SET status='expired' WHERE id=?", row.id);
        this.onFailed?.(row, "过了发送时限还没发出去");
        log("outbox", "expired before sending", { id: row.id });
        continue;
      }
      run("UPDATE outbox SET status='sending', attempts=attempts+1 WHERE id=?", row.id);
      try {
        const target = JSON.parse(row.target_json) as TurnContext;
        if (row.channel !== "feishu") throw new Error(`channel ${row.channel} not supported yet`);
        const msgId = await feishuSend(target, row.payload, row.idem_key, row.as_identity === "user" ? "user" : "bot");
        tx(() => {
          run("UPDATE outbox SET status='sent', sent_msg_id=?, error=NULL WHERE id=?", msgId ?? null, row.id);
          run(`INSERT OR IGNORE INTO messages(id, surface, chat_id, thread_id, sender_id, sender_kind, ts, text, lane)
               VALUES(?,?,?,?,?,?,?,?,?)`, msgId ?? `outbox:${row.id}`, target.surface, target.chat_id, target.thread_id ?? null,
            row.as_identity === "user" ? "owner-via-sbot" : "sbot", "bot", Date.now(), row.payload, row.lane);
        });
        log("outbox", "sent", { id: row.id, run: row.run_id });
        this.onSent?.(row, msgId);
      } catch (e: any) {
        const attempts = row.attempts + 1;
        const final = attempts >= MAX_ATTEMPTS;
        run("UPDATE outbox SET status=?, error=?, next_try=? WHERE id=?", final ? "failed" : "queued",
          String(e?.message ?? e).slice(0, 500), Date.now() + 2 ** attempts * 5_000, row.id);
        log("outbox", final ? "send failed for good" : "send failed, will retry", { id: row.id, attempts, err: String(e?.message ?? e).slice(0, 200) });
        if (final) this.onFailed?.(row, String(e?.message ?? e));
      }
    }
  }
}
