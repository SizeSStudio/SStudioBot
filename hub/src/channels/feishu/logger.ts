// What the Feishu plugin may write to a log (P9, 08). The SDK's default logger prints raw AxiosErrors whose
// `config.data` holds app_secret and whose headers hold tokens, so the SDK always gets safeSdkLogger(), and every
// error we log goes through describeError() + the redactor. Copied from probes/p9/core.ts (P9 tested them).
import { log } from "../../log.ts";

/** Masks the given secret values and the usual Feishu id/token shapes (ids are instance data too, DESIGN §底2). */
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
      .replace(/("(?:app_secret|tenant_access_token|user_access_token|token|authorization)"\s*:\s*")[^"]*"/gi, '$1***"');
  };
}

/** What may be said about a thrown value: name, message, HTTP status and API code. Never `config`/`request`/headers. */
export function describeError(e: unknown): string {
  if (e instanceof Error) {
    const a = e as Error & { status?: number; code?: unknown; response?: { status?: number; data?: { code?: unknown } } };
    const bits: unknown[] = [a.name, a.message];
    const st = a.response?.status ?? a.status; if (st) bits.push(`http=${st}`);
    const code = a.response?.data?.code ?? a.code; if (code !== undefined) bits.push(`code=${String(code)}`);
    return bits.filter(Boolean).join(" ");
  }
  return typeof e === "string" ? e : "non-error value thrown";
}

export type Say = (line: string) => void;
/** default sink: the hub log, module "feishu" */
export const sayToLog: Say = (line) => log("feishu", line);

/** For the SDK's `logger` option (it calls logger.level([...parts])): objects are dropped, errors described, text redacted. */
export function safeSdkLogger(say: Say, redact: (s: string) => string) {
  const fmt = (parts: unknown[]) => redact(parts.flat().map((p) =>
    p instanceof Error ? describeError(p) : typeof p === "string" ? p : typeof p === "object" && p !== null ? "[object]" : String(p)).join(" "));
  const mk = (lvl: string) => (parts: unknown) => say(`[sdk ${lvl}] ${fmt(Array.isArray(parts) ? parts : [parts])}`);
  return { error: mk("error"), warn: mk("warn"), info: mk("info"), debug: () => {}, trace: () => {} };
}

/** an API path without the ids in it, for error text */
export const routeOf = (p: string) => p.split("?")[0]!.replace(/\/(?:om|oc|ou|on)_[^/]+/g, "/:id").replace(/\/\d{8,}/g, "/:id");

export class ApiError extends Error {
  status?: number; apiCode?: number;
  constructor(msg: string, status?: number, apiCode?: number) { super(msg); this.name = "ApiError"; this.status = status; this.apiCode = apiCode; }
}
