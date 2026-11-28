// Recognising subscription limits (05 「认出额度上限」). Structured fields first (in each adapter); these strings are
// only the fallback. Source: read out of the installed CLIs and SDKs, none actually hit (08 P5–P8 「额度上限原文」).
const Q = "['’]";   // Codex's binary has a curly apostrophe, Claude's a straight one
export const QUOTA_PATTERNS: Record<string, RegExp[]> = {
  // Claude: `You've hit your <5-hour|weekly|Opus|…> limit[ · resets …]`, and the SDK's USAGE_LIMIT_ERROR_PREFIXES
  claude: [
    new RegExp(`^You${Q}ve (hit|reached) your `), /^You're out of (extra )?usage/, /^Your org is out of usage/,
    /^Your seat type doesn't include (extra )?usage/, /^Your usage allocation has been disabled/, /^Your group's usage limit is set to \$0/,
    /requires usage credits/, /usage limit reached/i,
  ],
  // Codex: `You've hit your usage limit. …`; structured: codexErrorInfo usageLimitExceeded / rateLimitExceeded
  codex: [new RegExp(`You${Q}ve hit your usage limit`), /workspace is out of credits/i, /You hit your spend cap/i, /Quota exceeded\./],
  // pi: provider-dependent; pi's own no-retry list plus the ChatGPT subscription wording
  pi: [
    /GoUsageLimitError|FreeUsageLimitError|Monthly usage limit reached|insufficient_quota|out of budget|quota exceeded/i,
    /You have hit your ChatGPT usage limit/, /subscription_sharing_.*usage_limit_exceeded/,
  ],
  // ACP (claude-agent-acp): errorKind in the error's data; the text is Claude's
  acp: [/"errorKind":\s*"rate_limit"/, new RegExp(`You${Q}ve (hit|reached) your `), /usage limit reached/i],
};

export const looksLikeQuota = (agent: string, text: string) => (QUOTA_PATTERNS[agent.split(":")[0]!] ?? []).some((re) => re.test(text));

/** Codex/Claude text: ` · resets 3:40pm`, `Try again at Nov 28, 2026 3:40 PM`, `Try again in ~12 min.` → ms, when it can tell. */
export function resetFromText(text: string, now = Date.now()): number | undefined {
  const mins = /try again in ~?(\d+)\s*min/i.exec(text);
  if (mins) return now + Number(mins[1]) * 60_000;
  const at = /try again at ([A-Z][a-z]{2} \d{1,2}, \d{4} \d{1,2}:\d{2} ?[AP]M)/i.exec(text);
  if (at) { const t = Date.parse(at[1]!); if (Number.isFinite(t) && t > now) return t; }
  return undefined;
}
