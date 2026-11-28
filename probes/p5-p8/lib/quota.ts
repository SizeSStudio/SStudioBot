// 认额度上限的特征串表（05「认出额度上限」）。结构化字段优先，这里只兜底。
// 出处：从各家已装的 CLI 产物里读出来的原文，没有真去烧额度；见 08 P5–P8 结果「额度上限原文」。
const Q = "['’]"; // Codex 二进制里是弯引号，Claude 里是直引号
export const QUOTA_PATTERNS: Record<string, RegExp[]> = {
  // Claude：`You've hit your <5-hour|weekly|Opus|Sonnet|Fable|usage credit|monthly spend> limit[ · resets …]`；SDK 导出的 USAGE_LIMIT_ERROR_PREFIXES 同源
  claude: [new RegExp(`^You${Q}ve (hit|reached) your `), /^You're out of (extra )?usage/, /^Your org is out of usage/, /usage limit reached/i],
  // Codex：`You've hit your usage limit. …`；结构化的是 codexErrorInfo = usageLimitExceeded / rateLimitExceeded
  codex: [new RegExp(`You${Q}ve hit your usage limit`), /workspace is out of credits/i, /You hit your spend cap/i, /Quota exceeded\./],
  // pi：随 provider 变。自己的终止类清单加 ChatGPT 订阅版的话术
  pi: [/GoUsageLimitError|FreeUsageLimitError|Monthly usage limit reached|insufficient_quota|out of budget|quota exceeded/i, /You have hit your ChatGPT usage limit/, /subscription_sharing_.*usage_limit_exceeded/],
  // ACP（claude-agent-acp）：错误的 data 里带 errorKind；限额错误文本沿用 Claude 的
  acp: [/"errorKind":"rate_limit"/, new RegExp(`You${Q}ve (hit|reached) your `), /usage limit reached/i],
};
export const looksLikeQuota = (agent: string, text: string) => (QUOTA_PATTERNS[agent] ?? []).some((re) => re.test(text));
