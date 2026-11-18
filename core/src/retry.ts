// Scheduled work against upstream trouble (DESIGN §9.4): what kind of failure this is, when to try again, and the one
// message to the admin group when we stop trying. Nobody is waiting on a scheduled run, so it can afford to wait.

import { run, tx } from "./db.ts";
import { feishuConf, log, TZ } from "./config.ts";

export type UpstreamFailure = { kind: "transient" } | { kind: "limit"; resetAt?: number };

export const RETRY_WINDOW_MS = 2 * 3600_000;
const BACKOFF_MIN = [2, 5, 10, 20, 30];
const LIMIT_PROBE_MS = 30 * 60_000;    // a usage limit with no stated reset: look rarely, it will not clear in minutes
const AFTER_RESET_MS = 2 * 60_000;
const BEFORE_NEXT_MS = 10 * 60_000;

// our own refusals look like upstream errors but waiting does not fix them
const OURS = /budget exhausted|bad or expired run token|not configured|run token is for tier|proxy error/i;
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

function wallTime(y: number, mo: number, d: number, h: number, mi: number, tz: string) {
  const asUtc = Date.UTC(y, mo - 1, d, h, mi);
  const shown = Date.parse(new Date(asUtc).toLocaleString("sv-SE", { timeZone: tz }).replace(" ", "T") + "Z");
  return asUtc - (shown - asUtc);
}

/** "resets 11pm (Asia/Singapore)" · "resets Nov 19, 2am (Asia/Singapore)" · "resets 11:30pm" */
export function parseReset(text: string, now = Date.now()): number | undefined {
  const m = /resets?\s+(?:at\s+|on\s+)?(?:([A-Za-z]{3,9})\.?\s+(\d{1,2}),?\s+(?:at\s+)?)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b(?:\s*\(([^)]+)\))?/i.exec(text);
  if (!m) return undefined;
  const h = (Number(m[3]) % 12) + (m[5].toLowerCase() === "pm" ? 12 : 0), mi = Number(m[4] ?? 0), tz = m[6] ?? TZ;
  try {
    const [y, mo, d] = new Date(now).toLocaleString("sv-SE", { timeZone: tz }).slice(0, 10).split("-").map(Number);
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
    : now + BACKOFF_MIN[Math.min(attempt - 1, BACKOFF_MIN.length - 1)] * 60_000;
  return Math.min(at, deadline);
}

export const failureText = (f: UpstreamFailure, err: string | undefined, stamp: (ms: number) => string) =>
  f.kind === "limit" ? `上游用量到上限${f.resetAt ? `（报的恢复时间 ${stamp(f.resetAt)}）` : ""}` : `上游出错：${String(err ?? "").slice(0, 120)}`;

/** Tools a failed attempt may have used and still be run again from the top: they change nothing. */
export const READ_ONLY_TOOLS = new Set(["memory_search", "memory_read", "web_search", "feishu_chats", "feishu_read", "task_list", "followup_list",
  "matter_events", "matter_list", "person_lookup", "person_path", "timeline_query", "readings_query", "self_list"]);

/** A fixed-template line to the admin group, through the outbox like every other message (§9.2). */
export function adminNotice(text: string) {
  const chat = feishuConf().admin_chat;
  if (!chat) { log("retry", "no admin chat for notice", { text: text.slice(0, 120) }); return; }
  tx(() => {
    const r = run("INSERT INTO outbox(lane, channel, target_json, payload, idem_key, send_by, ts) VALUES(?,?,?,?,?,?,?)",
      "system:admin", "feishu", JSON.stringify({ channel: "feishu", chat_id: chat, surface: "feishu:admin" }), text, null, Date.now() + 6 * 3600_000, Date.now());
    run("UPDATE outbox SET idem_key=? WHERE id=?", `sbot-ob-${r.lastInsertRowid}`, r.lastInsertRowid);
  });
}
