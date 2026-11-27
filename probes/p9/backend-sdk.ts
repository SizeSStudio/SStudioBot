// Backend A: the official SDK. Low-level WSClient + EventDispatcher on purpose (not LarkChannel: its card handling
// acks without a response body and has its own dedupe key).
//   - the handler's return value is the callback response, the ack follows it  → handler must be quick
//   - a logger of ours: the SDK logs raw AxiosErrors, whose `config.data` holds app_secret
//   - pingTimeout + handshakeTimeoutMs set, because the defaults never notice a half-open connection
import { Client, WSClient, EventDispatcher, LoggerLevel, defaultHttpInstance } from "@larksuiteoapi/node-sdk";
import { ApiError, describeError, routeOf, safeSdkLogger, makeRedactor } from "./core.ts";
import type { Backend, Creds, Handler, Incoming, Say } from "./core.ts";
import { TunnelAgent } from "./proxy.ts";

export type SdkOpts = { creds: Creds; say: Say; proxyUrl?: string; pingTimeoutSec?: number; handshakeTimeoutMs?: number; readyTimeoutMs?: number };

export class SdkBackend implements Backend {
  readonly name = "sdk" as const;
  readonly ackSemantics = "after-handler" as const;
  private o: SdkOpts;
  private client: any;
  private ws: any;
  private handler: Handler = () => {};
  private ack: number[] = [];
  private tl: { at: number; ev: string }[] = [];

  constructor(o: SdkOpts) {
    this.o = o;
    const { creds, say } = o;
    const logger = safeSdkLogger(say, makeRedactor([creds.app_secret, creds.app_id]));
    const secure = creds.domain!.startsWith("https:");
    // `defaultHttpInstance` is a process-wide axios instance: set (or reset) its agents every time.
    const d = (defaultHttpInstance as any).defaults;
    d.httpAgent = undefined; d.httpsAgent = undefined; d.proxy = undefined;
    if (o.proxyUrl) {
      // axios (token, REST) and ws both reach the network through the local proxy; axios's own proxy support does not CONNECT
      const u = new URL(o.proxyUrl);
      const agent = new TunnelAgent({ host: u.hostname, port: Number(u.port) }, secure);
      d.proxy = false; d[secure ? "httpsAgent" : "httpAgent"] = agent;
      this.agent = agent;
    }
    this.client = new Client({ appId: creds.app_id, appSecret: creds.app_secret, domain: creds.domain!, logger, loggerLevel: LoggerLevel.info });
    this.logger = logger;
  }
  private agent?: TunnelAgent;
  private logger: any;

  private mark(ev: string) { this.tl.push({ at: Date.now(), ev }); }

  async start(h: Handler): Promise<void> {
    this.handler = h;
    const { creds } = this.o;
    const dispatcher: any = new EventDispatcher({ logger: this.logger, loggerLevel: LoggerLevel.info });
    // Every subscribed type needs a handler: an unhandled one is still acked 200 and then gone.
    dispatcher.register({
      "card.action.trigger": (d: any) => this.dispatch("card", d),
      "im.message.receive_v1": (d: any) => this.dispatch("message", d),
    });
    const inner = dispatcher.invoke.bind(dispatcher);
    dispatcher.invoke = async (data: unknown, p: unknown) => {
      const t = Date.now();
      try { return await inner(data, p); } finally { this.ack.push(Date.now() - t); }   // the SDK sends the ack right after this
    };
    let ready!: () => void, failed!: (e: Error) => void;
    const up = new Promise<void>((res, rej) => { ready = res; failed = rej; });
    this.ws = new WSClient({
      appId: creds.app_id, appSecret: creds.app_secret, domain: creds.domain!, logger: this.logger, loggerLevel: LoggerLevel.info,
      agent: this.agent, handshakeTimeoutMs: this.o.handshakeTimeoutMs ?? 10_000,
      wsConfig: { pingTimeout: this.o.pingTimeoutSec ?? 10 },
      onReady: () => { this.mark("ready"); ready(); },
      onError: (e: Error) => { this.mark("error"); failed(new Error(describeError(e))); },
      onReconnecting: () => this.mark("reconnecting"),
      onReconnected: () => this.mark("reconnected"),
    });
    await this.ws.start({ eventDispatcher: dispatcher });
    const to = setTimeout(() => failed(new Error("WSClient not ready in time")), this.o.readyTimeoutMs ?? 30_000);
    try { await up; } finally { clearTimeout(to); }
  }

  private async dispatch(kind: "card" | "message", d: any) {
    const recvAt = Date.now();
    // The SDK flattens header and event: header.event_id/create_time and the event body sit side by side (the event's
    // own `token` — the card update token — wins over the header's verification token).
    const e: Incoming = kind === "card"
      ? { kind, eventId: String(d.event_id ?? ""), operatorId: d.operator?.open_id, messageId: d.context?.open_message_id,
          chatId: d.context?.open_chat_id, value: d.action?.value, token: d.token, eventTs: Number(d.create_time) || undefined, recvAt }
      : { kind, eventId: String(d.event_id ?? ""), operatorId: d.sender?.sender_id?.open_id, messageId: d.message?.message_id,
          chatId: d.message?.chat_id, eventTs: Number(d.create_time ?? d.message?.create_time) || undefined, recvAt };
    return await this.handler(e);
  }

  async api(method: string, path: string, data?: unknown, params?: Record<string, string>): Promise<any> {
    const route = `${method} ${routeOf(path)}`;
    try {
      const r: any = await this.client.request({ method, url: path, data, params });
      if (r && typeof r.code === "number" && r.code !== 0) throw new ApiError(`${route}: code ${r.code}`, undefined, r.code);
      return r?.data ?? {};
    } catch (e: any) {
      if (e instanceof ApiError) throw e;
      throw new ApiError(`${route}: ${describeError(e)}`, e?.response?.status, e?.response?.data?.code);
    }
  }

  ackMs() { return this.ack; }
  state() { return this.ws?.getConnectionStatus?.().state ?? "idle"; }
  timeline() { return this.tl; }
  notes() {
    return [
      `WSClient + EventDispatcher, app-secret logger replaced, pingTimeout=${this.o.pingTimeoutSec ?? 10}s, handshakeTimeout=${this.o.handshakeTimeoutMs ?? 10_000}ms`,
      "ack is sent after the handler resolves; the handler's return value is the card callback response",
    ];
  }
  async close() { try { this.ws?.close({ force: true }); } catch {} }
}
