// The bot-identity backend on the official SDK (P9, 08; confirmed live 11-28), @larksuiteoapi/node-sdk 1.77.0. From probes/p9/backend-sdk.ts:
//   - low-level WSClient + EventDispatcher, not LarkChannel (its card handling acks without a body and dedupes itself)
//   - every subscribed type has a handler: an unhandled one is still acked and then gone
//   - our own logger: the SDK's logs raw AxiosErrors whose config.data holds app_secret
//   - pingTimeout + handshakeTimeoutMs set: the defaults never notice a half-open connection
//   - after onError we start again ourselves: the SDK gives up for good on any /callback/ws/endpoint code but
//     internal_error (system_busy, exceed_conn_limit, …), so one bad answer from Feishu would leave the hub deaf
import { Client, WSClient, EventDispatcher, LoggerLevel, defaultHttpInstance } from "@larksuiteoapi/node-sdk";
import { ApiError, describeError, makeRedactor, routeOf, safeSdkLogger, type Say } from "./logger.ts";
import type { Backend, Handler, Incoming } from "./backend.ts";

export interface SdkOpts {
  appId: string; appSecret: string;
  domain?: string;               // default open.feishu.cn; tests point it at a local mock
  say: Say;
  pingTimeoutSec?: number; handshakeTimeoutMs?: number;
  restartMs?: number; restartMaxMs?: number;   // after a terminal error: 1 min, doubling, at most 10 min
}

const flatten = (kind: "card" | "message", d: any): Incoming => kind === "card"
  // the SDK lays header and event side by side; context ids follow P9's capture
  ? { kind, eventId: String(d.event_id ?? ""), operatorId: d.operator?.open_id, messageId: d.context?.open_message_id,
      chatId: d.context?.open_chat_id, value: d.action?.value, createTime: Number(d.create_time) || undefined }
  : { kind, eventId: String(d.event_id ?? ""), operatorId: d.sender?.sender_id?.open_id, senderType: d.sender?.sender_type,
      messageId: d.message?.message_id, chatId: d.message?.chat_id, chatType: d.message?.chat_type, messageType: d.message?.message_type,
      content: d.message?.content, threadId: d.message?.thread_id, rootId: d.message?.root_id,
      createTime: Number(d.message?.create_time ?? d.create_time) || undefined };

/**
 * The SDK hands only `event` data frames to the dispatcher; any other type it drops without a word and without an ack.
 * P9 (08) saw card callbacks arrive as `event`; if Feishu ever sends them as `card`, clicks would vanish silently, so
 * say it once per type.
 */
export function watchFrames(ws: any, say: Say) {
  const inner = ws?.handleEventData?.bind(ws);
  if (!inner) return;
  const told = new Set<string>();
  ws.handleEventData = (data: any) => {
    const type = String(data?.headers?.find?.((h: any) => h?.key === "type")?.value);
    if (type !== "event" && !told.has(type)) { told.add(type); say(`data frame of type ${type.slice(0, 20)} dropped by the SDK (not handled)`); }
    return inner(data);
  };
}

export class SdkBackend implements Backend {
  #o: SdkOpts;
  #client: any;
  #ws: any;
  #logger: ReturnType<typeof safeSdkLogger>;
  #dispatcher: any;
  #retry?: ReturnType<typeof setTimeout>;
  #fails = 0;
  #closed = false;
  #life?: { error(msg: string): void };

  constructor(o: SdkOpts) {
    this.#o = o;
    this.#logger = safeSdkLogger(o.say, makeRedactor([o.appSecret, o.appId]));
    // a process-wide axios instance: reset whatever an earlier client (or test) left on it
    const d = (defaultHttpInstance as any).defaults;
    d.httpAgent = undefined; d.httpsAgent = undefined; d.proxy = undefined;
    this.#client = new Client({ appId: o.appId, appSecret: o.appSecret, domain: o.domain ?? "https://open.feishu.cn", logger: this.#logger, loggerLevel: LoggerLevel.info });
  }

  async start(h: Handler, life: { ready(): void; reconnected(): void; error(msg: string): void }) {
    this.#closed = false;
    this.#life = life;
    const dispatcher: any = this.#dispatcher = new EventDispatcher({ logger: this.#logger, loggerLevel: LoggerLevel.info });
    dispatcher.register({
      "card.action.trigger": (d: any) => h(flatten("card", d)),
      "im.message.receive_v1": (d: any) => h(flatten("message", d)),
    });
    this.#ws = new WSClient({
      appId: this.#o.appId, appSecret: this.#o.appSecret, domain: this.#o.domain ?? "https://open.feishu.cn",
      logger: this.#logger, loggerLevel: LoggerLevel.info,
      handshakeTimeoutMs: this.#o.handshakeTimeoutMs ?? 10_000,
      wsConfig: { pingTimeout: this.#o.pingTimeoutSec ?? 10 },
      onReady: () => { this.#fails = 0; life.ready(); },
      onError: (e: Error) => { life.error(describeError(e)); this.#again(); },
      onReconnected: () => { this.#fails = 0; life.reconnected(); },
    } as any);
    watchFrames(this.#ws, this.#o.say);
    await this.#ws.start({ eventDispatcher: dispatcher });
  }

  #again() {
    if (this.#closed || this.#retry) return;
    const ms = Math.min(this.#o.restartMaxMs ?? 600_000, (this.#o.restartMs ?? 60_000) * 2 ** this.#fails++);
    this.#o.say(`long connection gave up; starting it again in ${Math.round(ms / 1000)} s`);
    this.#retry = setTimeout(() => {
      this.#retry = undefined;
      // a rejected restart must not become an unhandled rejection (that would take the hub down); count it and wait again
      if (!this.#closed) Promise.resolve().then(() => this.#ws.start({ eventDispatcher: this.#dispatcher }))
        .catch((e: Error) => { this.#life?.error(describeError(e)); this.#again(); });
    }, ms);
    this.#retry.unref?.();
  }

  async api(method: string, path: string, data?: unknown, params?: Record<string, string>): Promise<any> {
    const route = `${method} ${routeOf(path)}`;
    try {
      const r: any = await this.#client.request({ method, url: path, data, params });
      if (r && typeof r.code === "number" && r.code !== 0) throw new ApiError(`${route}: code ${r.code}`, undefined, r.code);
      return r?.data ?? {};
    } catch (e: any) {
      if (e instanceof ApiError) throw e;
      throw new ApiError(`${route}: ${describeError(e)}`, e?.response?.status, e?.response?.data?.code);
    }
  }

  state() { return this.#ws?.getConnectionStatus?.().state ?? "idle"; }
  async close() {
    this.#closed = true;
    if (this.#retry) { clearTimeout(this.#retry); this.#retry = undefined; }
    try { this.#ws?.close({ force: true }); } catch { /* already closed */ } }
}
