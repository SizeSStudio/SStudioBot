// P9 harness, shared parts: credentials, redaction, dedupe, stats, card JSON, the Backend contract.
// Nothing here prints a credential, an id or message text; reports carry counts and times only.
import { appendFileSync, existsSync, readFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";

// ---- credentials: a path only, the file is read here and never echoed -------------------------------------------

export type Creds = { app_id: string; app_secret: string; chat_id: string; test_app: boolean; domain?: string };

const DOMAIN_OK = /^(https:\/\/open\.feishu\.cn|https:\/\/open\.larksuite\.com|http:\/\/127\.0\.0\.1:\d+)$/;

/** Refuses anything that looks like the live instance's config (the live app's long connection must not be shared). */
export function loadCreds(path: string | undefined): Creds {
  if (!path) throw new Error("P9_CREDENTIALS is not set (path to a JSON file for the TEST app; see README)");
  const abs = resolve(path);
  for (const bad of ["/srv/sbot", resolve(homedir(), ".config/sbot")]) {
    if (abs === bad || abs.startsWith(bad + "/")) throw new Error("refusing a credentials file under the instance config directory");
  }
  if (!existsSync(abs)) throw new Error("credentials file does not exist");
  let j: any;
  try { j = JSON.parse(readFileSync(abs, "utf8")); } catch { throw new Error("credentials file is not valid JSON"); }
  for (const k of ["app_id", "app_secret", "chat_id"]) {
    if (typeof j[k] !== "string" || !j[k]) throw new Error(`credentials file: field ${k} missing`);
  }
  if (j.test_app !== true) throw new Error('credentials file must say "test_app": true (this harness never runs on the live app)');
  const domain = j.domain ?? "https://open.feishu.cn";
  if (!DOMAIN_OK.test(domain)) throw new Error("credentials file: domain must be open.feishu.cn, open.larksuite.com or a 127.0.0.1 mock");
  return { app_id: j.app_id, app_secret: j.app_secret, chat_id: j.chat_id, test_app: true, domain };
}

// ---- redaction ----------------------------------------------------------------------------------------------------

/** Masks the given secret values and the usual id/token shapes. Used on everything that can reach a log. */
export function makeRedactor(secrets: string[]): (s: string) => string {
  const known = secrets.filter((s) => s.length >= 4).sort((a, b) => b.length - a.length);
  return (s: string) => {
    let out = s;
    for (const k of known) out = out.split(k).join("***");
    return out
      .replace(/\b(cli|ou|oc|om|on|ot)_[0-9A-Za-z]{6,}/g, "$1_***")
      .replace(/\b[tuc]-[0-9A-Za-z_-]{16,}/g, "***")
      .replace(/Bearer\s+\S+/gi, "Bearer ***")
      .replace(/([?&](?:ticket|device_id|access_key|token)=)[^&\s"']+/gi, "$1***")
      .replace(/("(?:app_secret|tenant_access_token|token|authorization)"\s*:\s*")[^"]*"/gi, '$1***"');
  };
}

/** What may be said about a thrown value: name, message, HTTP status and API code. Never `config`/`request`/headers. */
export function describeError(e: unknown): string {
  if (e instanceof Error) {
    const a = e as any;
    const bits = [a.name, a.message];
    const st = a.response?.status ?? a.status; if (st) bits.push(`http=${st}`);
    const code = a.response?.data?.code ?? a.code; if (code !== undefined) bits.push(`code=${code}`);
    return bits.filter(Boolean).join(" ");
  }
  return typeof e === "string" ? e : "non-error value thrown";
}

export type Say = (line: string) => void;

/** A logger for the SDK's `logger` option (it calls `logger.level([...parts])`): every part goes through describeError/redact. */
export function safeSdkLogger(say: Say, redact: (s: string) => string) {
  const fmt = (parts: unknown[]) => redact(
    parts.flat().map((p) => (p instanceof Error ? describeError(p) : typeof p === "string" ? p : typeof p === "object" && p !== null ? "[object]" : String(p))).join(" "));
  const mk = (lvl: string) => (parts: unknown[]) => say(`[sdk ${lvl}] ${fmt(Array.isArray(parts) ? parts : [parts])}`);
  return { error: mk("error"), warn: mk("warn"), info: mk("info"), debug: () => {}, trace: () => {} };
}

/** An API path without the ids in it (message and card ids are instance data), for error text. */
export const routeOf = (p: string) => p.split("?")[0]!.replace(/\/(?:om|oc|ou)_[^/]+/g, "/:id").replace(/\/\d{8,}/g, "/:id");

export class ApiError extends Error {
  status?: number; apiCode?: number;
  constructor(msg: string, status?: number, apiCode?: number) { super(msg); this.name = "ApiError"; this.status = status; this.apiCode = apiCode; }
}

// ---- dedupe -------------------------------------------------------------------------------------------------------

/** First sighting wins. With a file the set survives a restart of the harness (the hub's inbox UNIQUE key plays this role). */
export class Deduper {
  private seenIds = new Set<string>();
  dupes = 0;
  private file?: string;
  constructor(file?: string) {
    this.file = file;
    if (file) {
      mkdirSync(dirname(file), { recursive: true });
      if (existsSync(file)) for (const l of readFileSync(file, "utf8").split("\n")) if (l) this.seenIds.add(l);
    }
  }
  /** true = already seen (a duplicate); false = new, now recorded */
  seen(id: string): boolean {
    if (this.seenIds.has(id)) { this.dupes++; return true; }
    this.seenIds.add(id);
    if (this.file) appendFileSync(this.file, id + "\n");
    return false;
  }
  get size() { return this.seenIds.size; }
}

// ---- numbers ------------------------------------------------------------------------------------------------------

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export function pct(xs: number[], p: number): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)]!;
}
export const summarize = (xs: number[]) => ({ n: xs.length, p50: pct(xs, 50), p95: pct(xs, 95), max: xs.length ? Math.max(...xs) : null });

// ---- cards (JSON 2.0, shapes follow core/src/cards.ts and core/src/card.ts) ---------------------------------------

export function clickCard(done: number, target: number) {
  return {
    schema: "2.0",
    config: { update_multi: true, summary: { content: "P9 click test" } },
    header: { title: { tag: "plain_text", content: "P9 click test" }, template: "blue" },
    body: { direction: "vertical", elements: [
      { tag: "markdown", content: `已收到 ${done}/${target}` },
      { tag: "button", text: { tag: "plain_text", content: "点我" }, type: "primary_filled", width: "fill",
        behaviors: [{ type: "callback", value: { k: "p9", t: target } }] },
    ] },
  };
}

export function streamCard(text: string, streaming: boolean) {
  return {
    schema: "2.0",
    config: { streaming_mode: streaming, summary: { content: streaming ? "[生成中]" : "done" },
      streaming_config: { print_frequency_ms: { default: 30 }, print_step: { default: 2 }, print_strategy: "fast" } },
    body: { elements: [{ tag: "markdown", element_id: "md", content: text || " " }] },
  };
}

// ---- the backend contract -----------------------------------------------------------------------------------------

export type Incoming = {
  kind: "card" | "message";
  eventId: string;
  messageId?: string;      // message events: the message itself; card events: the message carrying the card
  operatorId?: string;     // card: operator open_id; message: sender open_id (presence only is ever reported)
  chatId?: string;
  value?: any;             // card action value
  token?: string;
  eventTs?: number;        // when Feishu created the event (ms); only meaningful if clocks agree
  recvAt: number;
};
export type Toast = { toast: { type: "info" | "success" | "error" | "warning"; content: string } };
/** SDK: the return value is the callback response and the ack is sent after it resolves. lark-cli: ignored (ack came first). */
export type Handler = (e: Incoming) => Promise<Toast | void> | Toast | void;

export interface Backend {
  readonly name: "sdk" | "cli";
  /** "after-handler": the ack waits for the handler (3 s budget is ours). "before-delivery": acked before we see it. */
  readonly ackSemantics: "after-handler" | "before-delivery";
  start(h: Handler): Promise<void>;
  /** returns the response `data`; throws ApiError (message already free of secrets) */
  api(method: string, path: string, data?: unknown, params?: Record<string, string>): Promise<any>;
  /** time the backend itself spent between receiving a frame and answering it (SDK only), ms */
  ackMs(): number[];
  state(): string;
  /** connection life-cycle events seen so far (ready, reconnecting, reconnected, exit, restart …) with wall-clock ms */
  timeline(): { at: number; ev: string }[];
  notes(): string[];
  close(): Promise<void>;
}
