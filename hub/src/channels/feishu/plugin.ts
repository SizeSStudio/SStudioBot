// The Feishu channel plugin (03 「channels」). Bot identity over the SDK backend (P9): long connection for messages and
// card clicks, REST for sends and CardKit. User identity (group polling, sending as me) over lark-cli (user.ts).
//
// channels.yaml `feishu.mode: shadow` (09 「测试 home 里的飞书」): no long connection, so no card callbacks either, and
// send() only logs; polling as the user still runs. That lets a test home sit next to the live instance without
// splitting its events (one app, one long connection) or speaking in its chats.
//
// Handlers only write the inbox (ChannelHost.ingest) and return: the SDK acks after the handler, inside Feishu's 3 s.
import { channelsConf, peopleConf, sourcesConf, cached } from "../../config/load.ts";
import { secret } from "../../config/secrets.ts";
import { kvSet, one, run } from "../../db/ambient.ts";
import { log } from "../../log.ts";
import type { Card, ChannelHost, ChannelPlugin, OutboxRow, SendResult, StreamHandle, TurnContext } from "../types.ts";
import type { Backend, Incoming, Toast } from "./backend.ts";
import { contentText, postContent, renderCard, type FeishuCard } from "./cards.ts";
import { describeError, sayToLog, type Say } from "./logger.ts";
import { SdkBackend } from "./sdk.ts";
import { CardStream, closeOrphanCards } from "./stream.ts";
import { larkCli, sendAsUser, type Lark } from "./user.ts";
import { Observer } from "./observer.ts";
import { OWNER_DM_KEY, OWNER_DM_LANE, ownerDmChat } from "./state.ts";

export { OWNER_DM_KEY, OWNER_DM_LANE, ownerDmChat };

export const CARD_LANE = "card";
/** commands answered by code, never by the model (§触6.6) */
const COMMAND = /^\/(stop|new|tasks|approvals|todo|pair|devices|model|usage|job|improve|group|help)\b\s*([\s\S]*)$/i;

export const ownerFeishu = (): string | undefined => peopleConf().owner?.ids?.feishu;
/** registered only when channels.yaml has a feishu block */
export const feishuConfigured = () => {
  const c = cached("channels.yaml") as Record<string, unknown> | null | undefined;
  return !!c && typeof c === "object" && !!c.feishu;
};

const stripMentions = (s: string) => s.replace(/@_user_\d+\s*/g, "").trim();

export interface FeishuOpts {
  backend?: (creds: { appId: string; appSecret: string }, say: Say) => Backend;
  lark?: Lark;
  /** run the user-identity observer (default true; tests turn it off) */
  observe?: boolean;
  say?: Say;
}

class NoStream implements StreamHandle {
  readonly started = false;
  readonly failed = true;
  update() {}
  async finish() {}
  async dispose() {}
}

export class FeishuChannel implements ChannelPlugin {
  readonly id = "feishu";
  readonly caps = { cards: true, streaming: true, userIdentityRead: true, mail: true, commands: true };
  #o: FeishuOpts;
  #host?: ChannelHost;
  #backend?: Backend;
  #observer?: Observer;
  #mode: "live" | "shadow" = "live";
  readonly lark: Lark;

  constructor(o: FeishuOpts = {}) {
    this.#o = o;
    this.lark = o.lark ?? larkCli();
  }

  get mode() { return this.#mode; }
  get say(): Say { return this.#o.say ?? sayToLog; }
  state() { return this.#mode === "shadow" ? "shadow" : this.#backend?.state() ?? "no-bot"; }

  async start(h: ChannelHost) {
    this.#host = h;
    this.#mode = channelsConf().feishu.mode;
    if (this.#o.observe !== false) {
      this.#observer = new Observer({ lark: this.lark, plugin: this });
      this.#observer.start();
    }
    if (this.#mode === "shadow") { log("feishu", "shadow mode: no long connection, no card callbacks, sends are only logged"); return; }
    const appId = secret("FEISHU_APP_ID"), appSecret = secret("FEISHU_APP_SECRET");
    if (!appId || !appSecret) { log("feishu", "FEISHU_APP_ID / FEISHU_APP_SECRET not in secrets.env: bot identity off"); return; }
    const make = this.#o.backend ?? ((c, say) => new SdkBackend({ ...c, say }));
    const b = make({ appId, appSecret }, this.say);
    this.#backend = b;
    await b.start((e) => this.onEvent(e), {
      ready: () => { log("feishu", "long connection ready"); void this.#afterConnect(); },
      reconnected: () => { log("feishu", "long connection back"); void this.catchUp(); },
      error: (msg) => log("feishu", "long connection error", { err: msg.slice(0, 300) }),
    });
  }

  async #afterConnect() {
    try { await closeOrphanCards(this.api); } catch (e) { log("feishu", "closing orphan cards failed", { err: describeError(e) }); }
    await this.catchUp();
  }

  async stop() {
    this.#observer?.stop();
    await this.#backend?.close();
    this.#backend = undefined;
  }

  /** bot-identity REST; throws when the bot is off (shadow, or no credentials) */
  readonly api = (method: string, path: string, data?: unknown, params?: Record<string, string>): Promise<any> => {
    if (!this.#backend) return Promise.reject(new Error(this.#mode === "shadow" ? "feishu is in shadow mode" : "feishu bot identity is not configured"));
    return this.#backend.api(method, path, data, params);
  };

  // ---- receive ----

  onEvent(e: Incoming): Toast | void {
    try {
      if (e.kind === "card") return this.onCard(e);
      this.onMessage(e, "event");
    } catch (err) {
      // must not throw into the SDK: it would answer 500 and Feishu retries messages (not clicks); the inbox key dedupes
      log("feishu", "event handling failed", { kind: e.kind, err: describeError(err).slice(0, 300) });
    }
  }

  /** a click: only mine count. One inbox row keyed by event_id; approvals (W1d) and actions.ts act on it. */
  onCard(e: Incoming): Toast {
    const owner = ownerFeishu();
    if (!owner || e.operatorId !== owner) {
      log("feishu", "card click from someone else ignored", { has_operator: !!e.operatorId });
      return { toast: { type: "warning", content: "这张卡片只有本人能操作" } };
    }
    if (!e.eventId) return { toast: { type: "error", content: "没收到事件 id，请再点一次" } };
    let v = e.value;
    if (typeof v === "string") { try { v = JSON.parse(v); } catch { /* keep the string */ } }
    // the card update token is not stored: cards are updated with the bot's own identity (PATCH), so it is never needed
    const r = this.#host!.ingest({
      lane: CARD_LANE, kind: "card", source: "feishu:card", source_msg_id: e.eventId,
      payload: { v: 1, value: v, msg: e.messageId, chat: e.chatId, ts: e.createTime ?? Date.now() },
    });
    if (r.fresh) this.#host!.kick();
    return { toast: { type: "info", content: "收到" } };
  }

  /** returns true when it went into the inbox (a turn for the model or a command) */
  onMessage(e: Incoming, via: "event" | "catchup"): boolean {
    if (!e.messageId || !e.chatId || !e.operatorId) return false;
    if (e.senderType && e.senderType !== "user") return false;              // the bot's own (and other apps')
    const ex = sourcesConf().exclude;
    if (ex.chats.includes(e.chatId) || ex.persons.includes(e.operatorId)) return false;   // Y5: never reaches `messages`
    const owner = ownerFeishu(), isOwner = !!owner && e.operatorId === owner;
    const { admin_chat, workbench_chat } = channelsConf().feishu;
    const ts = e.createTime ?? Date.now();
    const text = stripMentions(contentText(e.messageType, e.content));
    const raw = { message_type: e.messageType, root_id: e.rootId, via };
    const p2p = e.chatType === "p2p";
    const surface = p2p ? "feishu:dm" : e.chatId === admin_chat ? "feishu:console" : e.chatId === workbench_chat ? "feishu:workbench" : "feishu:group";
    const message = { id: e.messageId, surface, chat_id: e.chatId, thread_id: e.threadId, sender_id: e.operatorId,
      sender_kind: (isOwner ? "owner" : "other") as "owner" | "other", ts, text, raw };

    let lane: string | undefined, kind: "user" | "command" = "user", turnThread: string | undefined;
    const cmd = COMMAND.exec(text);
    if (isOwner && p2p) { lane = OWNER_DM_LANE; if (cmd) kind = "command"; }
    else if (isOwner && surface === "feishu:workbench") { lane = `feishu:wb:${e.rootId || e.messageId}`; turnThread = e.threadId ?? e.rootId ?? e.messageId; }
    // the admin chat: my lines there are commands (/group, 回滚 <sha>, 更新 seed) or thread replies to cards (改稿)
    else if (isOwner && surface === "feishu:console") { lane = "feishu:console"; kind = "command"; }

    if (!lane) {
      // everyone else, and my own lines in other chats: triage material only (the observer sees groups the bot isn't in)
      this.#host!.record({ ...message, lane: null });
      return false;
    }
    if (lane === OWNER_DM_LANE && ownerDmChat() !== e.chatId) kvSet(OWNER_DM_KEY, e.chatId);
    const turn: TurnContext = { lane, surface, chat: e.chatId, msg_id: e.messageId, thread: turnThread ?? e.threadId, src: `owner@${surface}` };
    const r = this.#host!.ingest({
      lane, kind, source: "feishu", source_msg_id: e.messageId, turn,
      payload: { text, ts, message_type: e.messageType, root_id: e.rootId, ...(cmd ? { cmd: cmd[1]!.toLowerCase(), arg: cmd[2]!.trim() } : {}) },
      message: { ...message, lane, domain: surface === "feishu:dm" ? undefined : "work" },
    });
    if (r.fresh && lane === OWNER_DM_LANE) {
      run(`INSERT INTO chat_cursors(chat_id, surface, last_msg_ts, last_msg_id, updated_at) VALUES(?,?,?,?,?)
           ON CONFLICT(chat_id, surface) DO UPDATE SET last_msg_ts=MAX(last_msg_ts, excluded.last_msg_ts),
           last_msg_id=CASE WHEN excluded.last_msg_ts >= last_msg_ts THEN excluded.last_msg_id ELSE last_msg_id END, updated_at=excluded.updated_at`,
        e.chatId, "feishu:dm", ts, e.messageId, Date.now());
    }
    if (r.fresh) this.#host!.kick();
    return r.fresh;
  }

  /**
   * After (re)connecting: list my DM with the bot since the cursor (2 min overlap, at most 24 h) and ingest what the
   * long connection missed; the inbox key drops what it already had. Clicks can't be recovered this way (08 P9).
   */
  async catchUp() {
    const chat = ownerDmChat();
    if (!chat || !this.#backend) return;
    const cur = one("SELECT last_msg_ts FROM chat_cursors WHERE chat_id=? AND surface='feishu:dm'", chat);
    const since = Math.max(Number(cur?.last_msg_ts ?? Date.now() - 3600_000) - 120_000, Date.now() - 24 * 3600_000);
    let n = 0, page: string | undefined;
    try {
      for (let i = 0; i < 20; i++) {
        const d = await this.api("GET", "/open-apis/im/v1/messages", undefined, {
          container_id_type: "chat", container_id: chat, start_time: String(Math.floor(since / 1000)),
          end_time: String(Math.floor(Date.now() / 1000) + 60), sort_type: "ByCreateTimeAsc", page_size: "50", ...(page ? { page_token: page } : {}),
        });
        for (const it of (d.items ?? []) as any[]) {
          if (this.onMessage({ kind: "message", eventId: "", messageId: it.message_id, chatId: it.chat_id ?? chat, chatType: "p2p",
            operatorId: it.sender?.id, senderType: it.sender?.sender_type, messageType: it.msg_type, content: it.body?.content,
            threadId: it.thread_id, rootId: it.root_id, createTime: Number(it.create_time) || undefined }, "catchup")) n++;
        }
        if (!d.has_more || !d.page_token) break;
        page = d.page_token;
      }
      log("feishu", "catch-up done", { recovered: n });
    } catch (e) { log("feishu", "catch-up failed", { err: describeError(e).slice(0, 300) }); }
  }

  // ---- send ----

  render(c: Card): FeishuCard { return renderCard(c); }

  async send(o: OutboxRow): Promise<SendResult> {
    const t = JSON.parse(o.target_json) as { chat_id?: string; chat?: string; msg_id?: string; message_id?: string; thread_id?: string; thread?: string; in_thread?: boolean };
    const chat = t.chat_id ?? t.chat, replyTo = t.msg_id ?? t.message_id, inThread = !!(t.in_thread ?? (t.thread_id ?? t.thread));
    if (this.#mode === "shadow") {
      log("feishu", "shadow: not sent", { outbox: o.id, kind: o.kind, as: o.as_identity, chars: o.payload.length });
      return { msg_id: null, shadow: true };
    }
    if (o.as_identity === "user") {
      // 底线: anything in my name goes out only after its approval card was approved
      if (o.approval_id == null) throw new Error("refusing to send as the user without an approval");
      if (o.kind !== "text") throw new Error("only text can be sent as the user");
      return { msg_id: await sendAsUser(this.lark, { chat_id: chat, msg_id: replyTo, in_thread: inThread }, o.payload, o.idem_key ?? `sbot-ob-${o.id}`) };
    }
    let msg_type = "post", content: string;
    if (o.kind === "card") {
      const c = JSON.parse(o.payload);
      msg_type = "interactive";
      content = JSON.stringify(c && typeof c === "object" && "schema" in c ? c : renderCard(c as Card));
    } else content = postContent(o.payload);
    const uuid = (o.idem_key ?? `sbot-ob-${o.id}`).slice(0, 50);
    const d = replyTo
      ? await this.api("POST", `/open-apis/im/v1/messages/${replyTo}/reply`, { msg_type, content, reply_in_thread: inThread, uuid })
      : await this.api("POST", "/open-apis/im/v1/messages", { receive_id: chat, msg_type, content, uuid }, { receive_id_type: "chat_id" });
    return { msg_id: d.message_id ?? null };
  }

  /** a bot card straight into a chat (the observer's switches in the admin chat); null in shadow mode */
  async sendCardTo(chat: string, c: FeishuCard): Promise<string | null> {
    if (this.#mode === "shadow") { log("feishu", "shadow: card not sent"); return null; }
    const d = await this.api("POST", "/open-apis/im/v1/messages", { receive_id: chat, msg_type: "interactive", content: JSON.stringify(c) }, { receive_id_type: "chat_id" });
    return d.message_id ?? null;
  }

  /** replace a sent card (group switches, approvals after a click); a no-op in shadow mode */
  async patchCard(messageId: string, c: FeishuCard | Card) {
    if (this.#mode === "shadow") { log("feishu", "shadow: card not patched"); return; }
    const json = "schema" in c ? c : renderCard(c as Card);
    await this.api("PATCH", `/open-apis/im/v1/messages/${messageId}`, { content: JSON.stringify(json) });
  }

  stream(ctx: { runId: string; lane: string; turn: TurnContext }): StreamHandle {
    if (this.#mode === "shadow" || !this.#backend) return new NoStream();   // caller falls back to send(), which logs
    return new CardStream(this.api, ctx);
  }
}
