// The bot-identity backend on the official SDK (P9 暂定, 08), @larksuiteoapi/node-sdk 1.77.0. From probes/p9/backend-sdk.ts:
//   - low-level WSClient + EventDispatcher, not LarkChannel (its card handling acks without a body and dedupes itself)
//   - every subscribed type has a handler: an unhandled one is still acked and then gone
//   - our own logger: the SDK's logs raw AxiosErrors whose config.data holds app_secret
//   - pingTimeout + handshakeTimeoutMs set: the defaults never notice a half-open connection
import { Client, WSClient, EventDispatcher, LoggerLevel, defaultHttpInstance } from "@larksuiteoapi/node-sdk";
import { ApiError, describeError, makeRedactor, routeOf, safeSdkLogger, type Say } from "./logger.ts";
import type { Backend, Handler, Incoming } from "./backend.ts";

export interface SdkOpts {
  appId: string; appSecret: string;
  domain?: string;               // default open.feishu.cn; tests point it at a local mock
  say: Say;
  pingTimeoutSec?: number; handshakeTimeoutMs?: number;
}

const flatten = (kind: "card" | "message", d: any): Incoming => kind === "card"
  // the SDK lays header and event side by side; context ids follow P9's capture
  ? { kind, eventId: String(d.event_id ?? ""), operatorId: d.operator?.open_id, messageId: d.context?.open_message_id,
      chatId: d.context?.open_chat_id, value: d.action?.value, createTime: Number(d.create_time) || undefined }
  : { kind, eventId: String(d.event_id ?? ""), operatorId: d.sender?.sender_id?.open_id, senderType: d.sender?.sender_type,
      messageId: d.message?.message_id, chatId: d.message?.chat_id, chatType: d.message?.chat_type, messageType: d.message?.message_type,
      content: d.message?.content, threadId: d.message?.thread_id, rootId: d.message?.root_id,
      createTime: Number(d.message?.create_time ?? d.create_time) || undefined };

export class SdkBackend implements Backend {
  #o: SdkOpts;
  #client: any;
  #ws: any;
  #logger: ReturnType<typeof safeSdkLogger>;

  constructor(o: SdkOpts) {
    this.#o = o;
    this.#logger = safeSdkLogger(o.say, makeRedactor([o.appSecret, o.appId]));
    // a process-wide axios instance: reset whatever an earlier client (or test) left on it
    const d = (defaultHttpInstance as any).defaults;
    d.httpAgent = undefined; d.httpsAgent = undefined; d.proxy = undefined;
    this.#client = new Client({ appId: o.appId, appSecret: o.appSecret, domain: o.domain ?? "https://open.feishu.cn", logger: this.#logger, loggerLevel: LoggerLevel.info });
  }

  async start(h: Handler, life: { ready(): void; reconnected(): void; error(msg: string): void }) {
    const dispatcher: any = new EventDispatcher({ logger: this.#logger, loggerLevel: LoggerLevel.info });
    dispatcher.register({
      "card.action.trigger": (d: any) => h(flatten("card", d)),
      "im.message.receive_v1": (d: any) => h(flatten("message", d)),
    });
    this.#ws = new WSClient({
      appId: this.#o.appId, appSecret: this.#o.appSecret, domain: this.#o.domain ?? "https://open.feishu.cn",
      logger: this.#logger, loggerLevel: LoggerLevel.info,
      handshakeTimeoutMs: this.#o.handshakeTimeoutMs ?? 10_000,
      wsConfig: { pingTimeout: this.#o.pingTimeoutSec ?? 10 },
      onReady: () => life.ready(),
      onError: (e: Error) => life.error(describeError(e)),
      onReconnected: () => life.reconnected(),
    } as any);
    await this.#ws.start({ eventDispatcher: dispatcher });
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
  async close() { try { this.#ws?.close({ force: true }); } catch { /* already closed */ } }
}
