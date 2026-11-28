// Triage's model call (§读2.4) the way the commitment check makes its own (commit-check.ts): one light-tier request
// through our proxy with a token issued for this call alone and revoked when it ends, so it is metered like any run
// and the upstream key never leaves the proxy. Triage isn't a run: the token's run_id is a label (`triage:…`).
import { randomBytes } from "node:crypto";
import type { Db } from "../db/db.ts";
import { issueToken, revokeToken } from "../proxy.ts";
import { answerText } from "../commit-check.ts";
import type { Complete } from "./triage.ts";

/** The first JSON value in a model answer (fences and prose around it allowed). Throws when there is none. */
export function jsonOf(text: string): unknown {
  const t = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "").trim();
  try { return JSON.parse(t); } catch { /* look inside */ }
  const i = t.search(/[[{]/);
  if (i < 0) throw new Error("没给出 JSON");
  const close = t[i] === "[" ? "]" : "}";
  return JSON.parse(t.slice(i, t.lastIndexOf(close) + 1));
}

export function proxyComplete(db: Db, proxyBase: string, timeoutMs = 120_000): Complete {
  return async (o) => {
    const run_id = `triage:${Date.now().toString(36)}_${randomBytes(3).toString("hex")}`;
    const token = issueToken(db, { run_id, tier: o.tier, requester: o.requester });
    try {
      const res = await fetch(`${proxyBase}/v1/messages`, {
        method: "POST", signal: AbortSignal.timeout(timeoutMs),
        headers: { "x-api-key": token, "content-type": "application/json", "anthropic-version": "2023-06-01" },
        body: JSON.stringify({ model: "sbot-light", max_tokens: o.maxTokens, stream: true, system: o.system, messages: [{ role: "user", content: o.user }] }),
      });
      const raw = await res.text();
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return jsonOf(answerText(raw));
    } finally {
      revokeToken(db, token);
    }
  };
}
