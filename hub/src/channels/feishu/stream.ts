// Streaming reply card (CardKit, card JSON 2.0), one per run. Ported from core/src/card.ts:
//   - starts on the first update, or after START_AFTER_MS showing 「思考中…」
//   - the outbox row and runs.side_effects + 1 are written BEFORE the card is sent, so a crash after sending never
//     leads to a re-run and a second card (§底1.2)
//   - updates push the full text, serialized per card (increasing sequence), latest wins, one in flight
//   - finish() turns streaming off with one full-card update; closeOrphanCards() closes what a crash left open
import { all, run, tx } from "../../db/ambient.ts";
import { log } from "../../log.ts";
import type { StreamHandle, TurnContext } from "../types.ts";
import type { Backend } from "./backend.ts";
import { describeError } from "./logger.ts";

const START_AFTER_MS = 3000;
export const MAX_CARD_CHARS = 20_000;

const STATUS: Record<string, string> = {
  web_search: "🔍 搜索中…", memory_search: "📒 翻记忆…", memory_read: "📒 翻记忆…", memory_append: "📝 记一笔…",
};
export const toolStatus = (name?: string) => (name ? STATUS[name] ?? `⚙️ ${name}…` : "");

export function streamCardJson(text: string, status: string, streaming: boolean) {
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

export class CardStream implements StreamHandle {
  #api: Backend["api"];
  #ctx: { runId: string; lane: string; turn: TurnContext };
  #rowId?: number;
  #cardId?: string;
  #seq = 0;
  #want = { text: "", status: "" };
  #sent = { text: "", status: "" };
  #loop?: Promise<void>;
  #closing = false;
  #broken = false;
  #timer?: NodeJS.Timeout;
  #failed = false;

  /** thinking=false: no 「思考中」 card (scheduled runs: nobody waits, and a card rules out a clean retry, §底4.3) */
  constructor(api: Backend["api"], ctx: { runId: string; lane: string; turn: TurnContext }, o: { thinking?: boolean } = {}) {
    this.#api = api; this.#ctx = ctx;
    if (o.thinking !== false) this.#timer = setTimeout(() => { if (!this.#cardId) this.status("", "💭 思考中…"); }, START_AFTER_MS);
  }

  get started() { return !!this.#cardId; }
  /** couldn't create/send the card: the caller falls back to a plain reply */
  get failed() { return this.#failed; }

  update(text: string) { this.status(text, ""); }
  status(text: string, status: string) {
    if (this.#closing || this.#failed) return;
    this.#want = { text, status };
    this.#kick();
  }

  async dispose() { clearTimeout(this.#timer); if (!this.#cardId) this.#closing = true; }

  #kick() {
    if (this.#loop || this.#closing || this.#failed) return;
    this.#loop = this.#pump().catch((e) => {
      this.#broken = true;
      log("card", "update failed, stop streaming", { run: this.#ctx.runId, err: describeError(e).slice(0, 200) });
    }).finally(() => {
      this.#loop = undefined;
      if (!this.#closing && !this.#broken && this.#dirty()) this.#kick();
    });
  }

  #dirty() { return this.#want.text !== this.#sent.text || this.#want.status !== this.#sent.status; }

  async #pump() {
    if (!this.#cardId) await this.#start();
    while (!this.#closing && this.#dirty()) {
      const w = { ...this.#want };
      if (w.text !== this.#sent.text && w.text.length <= MAX_CARD_CHARS) {
        await this.#api("PUT", `/open-apis/cardkit/v1/cards/${this.#cardId}/elements/md/content`, { content: w.text || " ", sequence: ++this.#seq });
        run("UPDATE outbox SET payload=? WHERE id=?", w.text, this.#rowId);
      }
      if (w.status !== this.#sent.status) {
        await this.#api("PUT", `/open-apis/cardkit/v1/cards/${this.#cardId}/elements/st/content`,
          { content: w.status ? `<font color='grey'>${w.status}</font>` : " ", sequence: ++this.#seq });
      }
      this.#sent = w;
    }
  }

  async #start() {
    clearTimeout(this.#timer);
    const { runId, lane, turn } = this.#ctx;
    const idem = `sbot-card-${runId}`.slice(0, 50);
    this.#rowId = tx(() => {
      const r = run(`INSERT INTO outbox(run_id, lane, channel, target_json, payload, status, idem_key, ts, kind) VALUES(?,?,?,?,?,?,?,?,?)`,
        runId, lane, "feishu", JSON.stringify(turn), this.#want.text, "streaming", idem, Date.now(), "card");
      run("UPDATE runs SET side_effects = side_effects + 1 WHERE id=?", runId);
      return Number(r.lastInsertRowid);
    });
    try {
      const created = await this.#api("POST", "/open-apis/cardkit/v1/cards",
        { type: "card_json", data: JSON.stringify(streamCardJson(this.#want.text, this.#want.status, true)) });
      if (!created.card_id) throw new Error("no card_id");
      const content = JSON.stringify({ type: "card", data: { card_id: created.card_id } });
      const msg = turn.msg_id
        ? await this.#api("POST", `/open-apis/im/v1/messages/${turn.msg_id}/reply`, { msg_type: "interactive", content, uuid: idem, reply_in_thread: !!turn.thread })
        : await this.#api("POST", "/open-apis/im/v1/messages", { receive_id: turn.chat, msg_type: "interactive", content, uuid: idem }, { receive_id_type: "chat_id" });
      this.#cardId = created.card_id;
      this.#sent = { ...this.#want };
      run("UPDATE outbox SET card_id=?, sent_msg_id=? WHERE id=?", this.#cardId, msg.message_id ?? null, this.#rowId);
    } catch (e) {
      this.#failed = true;
      run("UPDATE outbox SET status='failed', error=? WHERE id=?", describeError(e).slice(0, 500), this.#rowId);
      throw e;
    }
  }

  /** final content, status line gone, streaming off. Without a card (never started or failed) the caller sends plainly. */
  async finish(text: string, footer?: string): Promise<void> {
    clearTimeout(this.#timer);
    this.#closing = true;
    await this.#loop;
    if (!this.#cardId) return;
    const final = [text.trim(), footer].filter(Boolean).join("\n\n") || "（这一轮没有要说的）";
    try { await finishCard(this.#api, this.#cardId, ++this.#seq, final); }
    catch (e) { log("card", "finish failed", { run: this.#ctx.runId, err: describeError(e).slice(0, 200) }); }
    const t = this.#ctx.turn;
    tx(() => {
      run("UPDATE outbox SET status='sent', payload=? WHERE id=?", final, this.#rowId);
      run(`INSERT OR IGNORE INTO messages(id, surface, chat_id, thread_id, sender_id, sender_kind, ts, text, lane) VALUES(?,?,?,?,?,?,?,?,?)`,
        `card:${this.#cardId}`, t.surface, t.chat ?? null, t.thread ?? null, "sbot", "bot", Date.now(), final, this.#ctx.lane);
    });
  }

  /** text past the card limit, to send as a follow-up */
  static overflow(text: string) { return text.length > MAX_CARD_CHARS ? text.slice(MAX_CARD_CHARS) : ""; }
  overflow(text: string) { return CardStream.overflow(text); }
}

async function finishCard(api: Backend["api"], cardId: string, sequence: number, text: string) {
  await api("PUT", `/open-apis/cardkit/v1/cards/${cardId}`, { card: { type: "card_json", data: JSON.stringify(streamCardJson(text, "", false)) }, sequence });
}

/** cards a crash left `streaming`: close them with what was shown plus a note (03: before the first new update) */
export async function closeOrphanCards(api: Backend["api"]) {
  const rows = all(`SELECT o.* FROM outbox o JOIN runs r ON r.id=o.run_id WHERE o.channel='feishu' AND o.status='streaming' AND o.card_id IS NOT NULL AND r.status!='running'`);
  for (const o of rows) {
    const text = `${String(o.payload ?? "").trim()}\n\n（被重启打断了）`.trim();
    try {
      // the old process's sequence counter is gone; a time-based one is larger than any it used
      await finishCard(api, o.card_id, Math.floor(Date.now() / 1000), text);
      run("UPDATE outbox SET status='sent', payload=? WHERE id=?", text, o.id);
    } catch (e) {
      run("UPDATE outbox SET status='unknown', error=? WHERE id=?", describeError(e).slice(0, 300), o.id);
    }
  }
  run("UPDATE outbox SET status='failed', error='crashed before the card was sent' WHERE channel='feishu' AND status='streaming' AND card_id IS NULL AND run_id NOT IN (SELECT id FROM runs WHERE status='running')");
}
