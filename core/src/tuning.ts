// §16.3 B: what an improve proposal may change, as plain files in agent-home (git-tracked, so every change has a commit
// to roll back to). Code appends them to the matching prompts; each run records the version (content hash) it used.
// Everything else — gates, auto rules, others' tool scope, budgets, the RSI itself (D) — is config the agent never
// writes; tools and code (C) only change through a worker PR.

import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { P } from "./config.ts";

export const TUNABLE: Record<string, string> = {
  "tuning/triage.md": "Triage 分拣的补充规则（追加在分拣 prompt 后面）",
  "tuning/draft.md": "替他起草群回复的补充规则（追加在起草 prompt 后面）",
  "tuning/main.md": "主 agent 的补充规则（追加在主对话 system prompt 最后）",
  "skills/review/SKILL.md": "复盘的方法（§15.5）",
  "skills/outlook/SKILL.md": "前瞻的方法（§15.2）",
};

const body = (t: string) => t.replace(/^---\n[\s\S]*?\n---\n?/, "").trim();
export function tunedRaw(rel: string): string {
  const f = join(P.agentHome, rel);
  return existsSync(f) ? readFileSync(f, "utf8") : "";
}
/** the tunable text without frontmatter ("" when the file doesn't exist yet) */
export const tuned = (rel: string) => body(tunedRaw(rel));
export const versionOf = (text: string) => text.trim() ? createHash("sha256").update(text).digest("hex").slice(0, 8) : "none";
export const tuningVersion = (rel: string) => versionOf(tunedRaw(rel));

/** "\n\n# heading\n…" when the file has content, else "" — for appending to a prompt. `raw` overrides the file (replay). */
export function tunedSection(rel: string, heading: string, raw = tunedRaw(rel)): string {
  const t = body(raw);
  return t ? `\n\n# ${heading}（${rel}，经他批准的调整）\n${t}` : "";
}

/** versions of every tunable file, recorded on each run (§16.4: every run says what it used) */
export const tuningVersions = (): Record<string, string> =>
  Object.fromEntries(Object.keys(TUNABLE).map((rel) => [rel, tuningVersion(rel)]));
