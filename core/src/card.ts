// Streaming reply card (CardKit, card JSON 2.0). One card per run on Feishu:
//
//   - started on the first text or tool event (or after START_AFTER_MS of silence, showing "思考中…")
//   - the outbox row + runs.side_effects are written BEFORE the card is sent (written first, delivered after), so a
//     crash after sending can never lead to a re-run and a second card (§1.2)
//   - text updates push the full text; Feishu types out the new suffix. Updates are serialized per card (strictly
//     increasing sequence), latest-wins, at most one in flight
//   - a grey status line under the text shows what the agent is doing (🔍 搜索中…); finish() removes it and turns
//     streaming off with one full-card update
//   - cards left `streaming` by a crash are closed on the next start (closeOrphanCards)

import { all, run, tx } from "./db.ts";
import { log } from "./config.ts";
import { botApi, directApi } from "./feishu-api.ts";
import type { RunCtx } from "./tools.ts";

const START_AFTER_MS = 3000;
const MAX_CARD_CHARS = 20_000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const STATUS: Record<string, string> = {
  web_search: "🔍 搜索中…", memory_search: "📒 翻记忆…", memory_read: "📒 翻记忆…", memory_append: "📝 记一笔…",
};
export const toolStatus = (name?: string) => (name ? STATUS[name] ?? `⚙️ ${name}…` : "");

function cardJson(text: string, status: string, streaming: boolean) {
  const shown = text.length > MAX_CARD_CHARS ? text.slice(0, MAX_CARD_CHARS) + "\n\n（太长了，后面的见下一条）" : text;
  const summary = streaming ? "[生成中]" : (text.replace(/\s+/g, " ").slice(0, 60) || "（空）");
  return {
    schema: "2.0",
    config: {
      streaming_mode: streaming, summary: { content: summary },
      streaming_config: { print_frequency_ms: { default: 30 }, print_step: { default: 2 }, print_strategy: "fast" },
    },
    body: {
      elements: [
        { tag: "markdown", element_id: "md", content: shown || " " },
        ...(streaming ? [{ tag: "markdown", element_id: "st", text_size: "notation", content: status ? `<font color='grey'>${status}</font>` : " " }] : []),
      ],
    },
  };
}

export class CardStream {
  private ctx: RunCtx;
  private rowId?: number;
  private cardId?: string;
  private seq = 0;
  private want = { text: "", status: "" };
  private sent = { text: "", status: "" };
  private loop?: Promise<void>;
  private closing = false;
  private broken = false;
  private timer?: NodeJS.Timeout;
  failed = false;          // couldn't create/send the card: the caller falls back to a plain text reply

  /** thinking=false: no "思考中" card (a scheduled run: nobody is waiting, and a card would rule out a clean retry, §9.4) */
  constructor(ctx: RunCtx, o: { thinking?: boolean } = {}) {
    this.ctx = ctx;
    if (o.thinking !== false) this.timer = setTimeout(() => { if (!this.cardId) this.update("", "💭 思考中…"); }, START_AFTER_MS);
  }

  get started() { return !!this.cardId; }
  /** Stop the "思考中" timer without finishing (the run crashed before anything was shown). */
  dispose() { clearTimeout(this.timer); if (!this.cardId) this.closing = true; }

  update(text: string, status = "") {
    if (this.closing || this.failed) return;
    this.want = { text, status };
    this.kick();
  }

  private kick() {
    if (this.loop || this.closing || this.failed) return;
    this.loop = this.pump().catch((e) => {
      this.broken = true;
      log("card", "update failed, stop streaming", { run: this.ctx.runId, err: String(e?.message ?? e).slice(0, 200) });
    }).finally(() => {
      this.loop = undefined;
      if (!this.closing && !this.broken && this.dirty()) this.kick();
    });
  }

  private dirty() { return this.want.text !== this.sent.text || this.want.status !== this.sent.status; }

  private async pump() {
    if (!this.cardId) await this.start();
    const gap = directApi() ? 250 : 0;   // lark-cli calls take ~3 s by themselves
    while (!this.closing && this.dirty()) {
      const w = { ...this.want };
      if (w.text !== this.sent.text && w.text.length <= MAX_CARD_CHARS) {
        await botApi("PUT", `/open-apis/cardkit/v1/cards/${this.cardId}/elements/md/content`, { content: w.text || " ", sequence: ++this.seq });
        run("UPDATE outbox SET payload=? WHERE id=?", w.text, this.rowId);
      }
      if (w.status !== this.sent.status) {
        await botApi("PUT", `/open-apis/cardkit/v1/cards/${this.cardId}/elements/st/content`,
          { content: w.status ? `<font color='grey'>${w.status}</font>` : " ", sequence: ++this.seq });
      }
      this.sent = w;
      if (gap) await sleep(gap);
    }
  }

  private async start() {
    clearTimeout(this.timer);
    const { runId, lane, turn } = this.ctx;
    const idem = `sbot-card-${runId}`.slice(0, 50);
    // written first: from here on this run has a side effect and is never re-run automatically
    this.rowId = tx(() => {
      const r = run(`INSERT INTO outbox(run_id, lane, channel, target_json, payload, status, idem_key, ts, kind) VALUES(?,?,?,?,?,?,?,?,?)`,
        runId, lane, turn.channel, JSON.stringify(turn), this.want.text, "streaming", idem, Date.now(), "card");
      run("UPDATE runs SET side_effects = side_effects + 1 WHERE id=?", runId);
      return Number(r.lastInsertRowid);
    });
    try {
      const created = await botApi("POST", "/open-apis/cardkit/v1/cards",
        { type: "card_json", data: JSON.stringify(cardJson(this.want.text, this.want.status, true)) });
      if (!created.card_id) throw new Error("no card_id");
      const content = JSON.stringify({ type: "card", data: { card_id: created.card_id } });
      const msg = turn.message_id
        ? await botApi("POST", `/open-apis/im/v1/messages/${turn.message_id}/reply`, { msg_type: "interactive", content, uuid: idem, reply_in_thread: !!turn.in_thread })
        : await botApi("POST", "/open-apis/im/v1/messages", { receive_id: turn.chat_id, msg_type: "interactive", content, uuid: idem }, { receive_id_type: "chat_id" });
      this.cardId = created.card_id;
      this.sent = { ...this.want };
      run("UPDATE outbox SET card_id=?, sent_msg_id=? WHERE id=?", this.cardId, msg.message_id ?? null, this.rowId);
      log("card", "started", { run: runId, direct: directApi() });
    } catch (e: any) {
      this.failed = true;
      run("UPDATE outbox SET status='failed', error=? WHERE id=?", String(e?.message ?? e).slice(0, 500), this.rowId);
      throw e;
    }
  }

  /**
   * Final content, status line removed, streaming off. Returns false when there is no card to finish (never
   * started or failed to start): the caller sends the text the plain way.
   */
  async finish(text: string, note?: string): Promise<boolean> {
    clearTimeout(this.timer);
    this.closing = true;
    await this.loop;
    if (!this.cardId) return false;
    const final = [text.trim(), note].filter(Boolean).join("\n\n") || "（这一轮没有要说的）";
    try {
      await finishCard(this.cardId, ++this.seq, final);
    } catch (e: any) {
      log("card", "finish failed", { run: this.ctx.runId, err: String(e?.message ?? e).slice(0, 200) });
    }
    tx(() => {
      run("UPDATE outbox SET status='sent', payload=? WHERE id=?", final, this.rowId);
      run(`INSERT OR IGNORE INTO messages(id, surface, chat_id, thread_id, sender_id, sender_kind, ts, text, lane) VALUES(?,?,?,?,?,?,?,?,?)`,
        `card:${this.cardId}`, this.ctx.turn.surface, this.ctx.turn.chat_id, this.ctx.turn.thread_id ?? null, "sbot", "bot", Date.now(), final, this.ctx.lane);
    });
    return true;
  }

  /** Text past the card limit, to be sent as a follow-up message. */
  static overflow(text: string) { return text.length > MAX_CARD_CHARS ? text.slice(MAX_CARD_CHARS) : ""; }
}

async function finishCard(cardId: string, sequence: number, text: string) {
  await botApi("PUT", `/open-apis/cardkit/v1/cards/${cardId}`,
    { card: { type: "card_json", data: JSON.stringify(cardJson(text, "", false)) }, sequence });
}

/** Cards a crash left in `streaming`: close them with what was already shown plus a note. */
export async function closeOrphanCards() {
  const rows = all(`SELECT o.* FROM outbox o JOIN runs r ON r.id=o.run_id WHERE o.status='streaming' AND o.card_id IS NOT NULL AND r.status!='running'`);
  for (const o of rows) {
    const text = `${(o.payload ?? "").trim()}\n\n（被重启打断了）`.trim();
    try {
      // sequence must exceed any used before; the old process's counter is lost, so use a time-based one
      await finishCard(o.card_id, Math.floor(Date.now() / 1000), text);
      run("UPDATE outbox SET status='sent', payload=? WHERE id=?", text, o.id);
      log("card", "closed orphan card", { run: o.run_id });
    } catch (e: any) {
      run("UPDATE outbox SET status='unknown', error=? WHERE id=?", String(e?.message ?? e).slice(0, 300), o.id);
    }
  }
  // rows whose card was never created (crash between the outbox write and the send)
  run("UPDATE outbox SET status='failed', error='crashed before the card was sent' WHERE status='streaming' AND card_id IS NULL AND run_id NOT IN (SELECT id FROM runs WHERE status='running')");
}
