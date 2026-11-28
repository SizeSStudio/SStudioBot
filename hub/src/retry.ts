// Upstream trouble for scheduled work (§底4.3), ported from core/src/retry.ts (10): what kind of failure it is and
// when to try again. The inbox requeues scheduled rows with it; timers use the same table.
import { TZ } from "./home.ts";
import { wallTime } from "./time.ts";

export type UpstreamFailure = { kind: "transient" } | { kind: "limit"; resetAt?: number };

export const RETRY_WINDOW_MS = 2 * 3600_000;
const BACKOFF_MIN = [2, 5, 10, 20, 30];
const LIMIT_PROBE_MS = 30 * 60_000;    // a usage limit with no stated reset: look rarely, it will not clear in minutes
const AFTER_RESET_MS = 2 * 60_000;
const BEFORE_NEXT_MS = 10 * 60_000;

// our own refusals look like upstream errors but waiting does not fix them
const OURS = /bad or revoked run token|bad or expired run token|not configured|run token is for tier|proxy error/i;
const LIMIT = /\b(?:weekly|monthly|daily|usage|spend(?:ing)?|session)\s+limit|hit your .{0,40}limit|insufficient[_ ]quota|quota (?:exceeded|exhausted)|credit balance|额度/i;
const FATAL = /invalid_request_error|authentication_error|permission_error|not_found_error|prompt is too long/i;
const TRANSIENT = /(?:^|[^\d.])(?:429|50[0234]|529)(?:\D|$)|rate.?limit|too many requests|overloaded|upstream unreachable|fetch failed|network|socket|ECONN\w+|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|EPIPE|timed? ?out|terminated|connection (?:error|closed|reset)|stream (?:ended|closed)|premature close/i;

/** undefined = not something waiting can fix (or not an upstream error at all) */
export function classifyUpstream(err: string | undefined, now = Date.now()): UpstreamFailure | undefined {
  if (!err || OURS.test(err)) return undefined;
  if (LIMIT.test(err)) return { kind: "limit", resetAt: parseReset(err, now) };
  if (FATAL.test(err)) return undefined;
  return TRANSIENT.test(err) ? { kind: "transient" } : undefined;
}

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

/** "resets 11pm (Asia/Singapore)" · "resets Nov 19, 2am (Asia/Singapore)" · "resets 11:30pm" */
export function parseReset(text: string, now = Date.now()): number | undefined {
  const m = /resets?\s+(?:at\s+|on\s+)?(?:([A-Za-z]{3,9})\.?\s+(\d{1,2}),?\s+(?:at\s+)?)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b(?:\s*\(([^)]+)\))?/i.exec(text);
  if (!m) return undefined;
  const h = (Number(m[3]) % 12) + (m[5]!.toLowerCase() === "pm" ? 12 : 0), mi = Number(m[4] ?? 0), tz = m[6] ?? TZ;
  try {
    const [y, mo, d] = new Date(now).toLocaleString("sv-SE", { timeZone: tz }).slice(0, 10).split("-").map(Number) as [number, number, number];
    if (m[1]) {
      const month = MONTHS.indexOf(m[1].slice(0, 3).toLowerCase()) + 1;
      if (!month) return undefined;
      const t = wallTime(y, month, Number(m[2]), h, mi, tz);
      return t < now - 12 * 3600_000 ? wallTime(y + 1, month, Number(m[2]), h, mi, tz) : t;
    }
    const t = wallTime(y, mo, d, h, mi, tz);
    return t > now ? t : t + 86400_000;
  } catch { return undefined; }   // a time zone we can't read: treated as "reset unknown"
}

/** the window closes at firstAt + hours, and always before the same job comes round again */
export function retryDeadline(firstAt: number, nextFiring?: number, hours?: number) {
  const end = firstAt + (hours && hours > 0 ? hours * 3600_000 : RETRY_WINDOW_MS);
  return nextFiring ? Math.min(end, nextFiring - BEFORE_NEXT_MS) : end;
}

/**
 * When to try again after failed attempt number `attempt` (1-based); undefined = the window is over, give up.
 * A limit that won't clear in time still gets one last try at the deadline: the owner may have added a fallback or quota.
 */
export function nextAttempt(f: UpstreamFailure, attempt: number, deadline: number, now = Date.now()): number | undefined {
  if (now >= deadline) return undefined;
  const at = f.kind === "limit"
    ? (f.resetAt && f.resetAt > now ? f.resetAt + AFTER_RESET_MS : now + LIMIT_PROBE_MS)
    : now + BACKOFF_MIN[Math.min(attempt - 1, BACKOFF_MIN.length - 1)]! * 60_000;
  return Math.min(at, deadline);
}

export const failureText = (f: UpstreamFailure, err: string | undefined, stamp: (ms: number) => string) =>
  f.kind === "limit" ? `上游用量到上限${f.resetAt ? `（报的恢复时间 ${stamp(f.resetAt)}）` : ""}` : `上游出错：${String(err ?? "").slice(0, 120)}`;
