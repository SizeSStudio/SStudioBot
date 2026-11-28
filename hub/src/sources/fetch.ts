// `kind: fetch`: a page's newly appeared lines, copied from core. First poll = baseline. Egress for the hub's own fetches
// is W1d's; this goes through the global fetch, which egress wraps when it lands.
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Poll } from "./types.ts";

const sha = (s: string) => createHash("sha256").update(s).digest("hex");

/** html → plain lines (good enough to see what changed) */
export function htmlText(h: string): string {
  return h.replace(/<(script|style|noscript)[\s\S]*?<\/\1>/gi, "").replace(/<\/?(p|div|li|tr|h\d|br|section|article|header|footer)[^>]*>/gi, "\n")
    .replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, "\"").replace(/&#39;/g, "'");
}

export const fetchPage: Poll = async (s, st) => {
  const url = String(s.url);
  const r = await fetch(url, { signal: AbortSignal.timeout(20_000), headers: { "user-agent": "sbot-source/1" }, redirect: "follow" });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const body = (await r.text()).slice(0, 2_000_000);
  const text = /html/i.test(r.headers.get("content-type") ?? "") ? htmlText(body) : body;
  const lines = text.split("\n").map((l) => l.replace(/\s+/g, " ").trim()).filter(Boolean);
  const hash = sha(lines.join("\n"));
  const prevHash = st.get("hash");
  if (hash === prevHash) return { items: [] };
  const file = join(st.dir, "last.txt");
  const before = new Set(existsSync(file) ? readFileSync(file, "utf8").split("\n") : []);
  writeFileSync(file, lines.slice(0, 5000).join("\n"));
  st.set("hash", hash);
  if (!prevHash) return { items: [] };
  const added = lines.filter((l) => !before.has(l));
  if (!added.length) return { items: [] };
  return { items: [{ id: hash.slice(0, 16), ts: Date.now(), author: new URL(url).host, where: s.id, link: url, text: `页面有变化，新出现的内容：\n${added.join("\n").slice(0, 3000)}` }] };
};
