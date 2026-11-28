// The commitment check (§底3.4): before something the agent wrote goes out by itself in someone else's conversation,
// the light tier reads the draft once and answers in JSON whether it promises time, money or things for me, speaks for
// me, or lets out private things beyond shared/. It goes through our own proxy with a light-tier token of the same run,
// so it is metered like everything else and the upstream key never leaves the proxy.
// Anything that isn't a clean, well-formed "no" counts as a hit (reply.ts sends the draft to approval): fail closed.
import type { Db } from "./db/db.ts";
import { issueToken, revokeToken } from "./proxy.ts";

export interface CommitResult { hits: string[] }
export type CommitChecker = (draft: string, o: { run_id: string; lane: string }) => Promise<CommitResult>;

export const CHECK_SYSTEM = `检查一条草稿：助手会在别人的对话里替本人自动发出它。只输出一个 JSON 对象，不要别的字：
{"promise":bool,"stance":bool,"private":bool,"hits":["命中的原话或要点"]}
promise：替本人答应了时间、金钱、资源或要做的事；stance：代表本人对争议、人事、决策表了态；private：带出了 shared/ 以外的私人信息（本人的日程细节、健康、家事、财务，别人的事等）。
三项都没有就都写 false，hits 写空数组。`;

const LABEL = { promise: "替我答应了时间、钱或事情", stance: "代表我表态", private: "带出了私人信息" } as const;

/** The model's answer → hit reasons ([] = clean). Malformed answers throw (the caller treats that as a hit). */
export function parseCheck(text: string): CommitResult {
  const m = /\{[\s\S]*\}/.exec(text);
  if (!m) throw new Error("没给出 JSON");
  let j: Record<string, unknown>;
  try { j = JSON.parse(m[0]); } catch { throw new Error("JSON 解析不了"); }
  for (const k of Object.keys(LABEL)) if (typeof j[k] !== "boolean") throw new Error(`缺 ${k}`);
  const hits = (Array.isArray(j.hits) ? j.hits : []).filter((x): x is string => typeof x === "string" && !!x.trim()).map((s) => s.trim().slice(0, 200));
  const flagged = (Object.keys(LABEL) as (keyof typeof LABEL)[]).filter((k) => j[k] === true).map((k) => LABEL[k]);
  // hits without any flag is a self-contradicting answer: count it, don't guess which half is right
  return { hits: flagged.length || hits.length ? [...flagged, ...hits] : [] };
}

/** Text of an Anthropic Messages answer, streamed (SSE) or not. */
export function answerText(raw: string): string {
  if (!raw.trimStart().startsWith("{")) {
    let out = "";
    for (const line of raw.split("\n")) {
      if (!line.startsWith("data:")) continue;
      try { const ev = JSON.parse(line.slice(5)); if (ev.type === "content_block_delta" && ev.delta?.type === "text_delta") out += ev.delta.text ?? ""; } catch { /* not JSON */ }
    }
    return out;
  }
  const j = JSON.parse(raw) as { content?: { type?: string; text?: string }[] };
  return (j.content ?? []).filter((c) => c.type === "text").map((c) => c.text ?? "").join("");
}

/**
 * The hub's checker: one light request through the proxy. 60 s at most ※ — a check that never answers would otherwise
 * hold the reply forever; running out of time is a hit like any other failure.
 */
export function proxyCommitChecker(db: Db, proxyBase: string, timeoutMs = 60_000): CommitChecker {
  return async (draft, o) => {
    const token = issueToken(db, { run_id: o.run_id, tier: "light", requester: "check" });
    try {
      const res = await fetch(`${proxyBase}/v1/messages`, {
        method: "POST", signal: AbortSignal.timeout(timeoutMs),
        headers: { "x-api-key": token, "content-type": "application/json", "anthropic-version": "2023-06-01" },
        body: JSON.stringify({ model: "sbot-light", max_tokens: 400, stream: true, system: CHECK_SYSTEM, messages: [{ role: "user", content: draft }] }),
      });
      const raw = await res.text();
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return parseCheck(answerText(raw));
    } finally {
      revokeToken(db, token);
    }
  };
}
