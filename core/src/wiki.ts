// Knowledge-base layer over agent-home (DESIGN §8.4, §8.5): page visibility, the pages_fts index (FTS5 trigram,
// synced from the files by mtime after every commit), index.md (rebuilt by code) and log.md (append-only).
//
// Visibility is decided by code: self/ and journal/ are always owner; shared/ is shared; projects/topics/sources/groups
// default to work; everything else (people, matters, root files) to owner. A page's frontmatter `visibility:` can only
// narrow that, never widen it.

import { existsSync, readdirSync, readFileSync, statSync, writeFileSync, appendFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { db, all, run, one } from "./db.ts";
import { P, log } from "./config.ts";
import { commitIfDirty, localStamp } from "./memory.ts";

export type Vis = "owner" | "work" | "shared";
const RANK: Record<Vis, number> = { owner: 0, work: 1, shared: 2 };
const SKIP = new Set(["index.md", "log.md"]);

db.exec(`
CREATE VIRTUAL TABLE IF NOT EXISTS pages_fts USING fts5(path UNINDEXED, title, body, visibility UNINDEXED, tokenize='trigram');
CREATE TABLE IF NOT EXISTS pages(path TEXT PRIMARY KEY, mtime INTEGER, title TEXT, summary TEXT, visibility TEXT, bytes INTEGER);
`);

export function frontmatter(text: string): Record<string, string> {
  const m = /^---\n([\s\S]*?)\n---\n?/.exec(text);
  if (!m) return {};
  const out: Record<string, string> = {};
  for (const l of m[1].split("\n")) { const kv = /^([A-Za-z_]+):\s*(.*)$/.exec(l); if (kv) out[kv[1]] = kv[2].replace(/^["']|["']$/g, "").trim(); }
  return out;
}
const body = (text: string) => text.replace(/^---\n[\s\S]*?\n---\n?/, "");

export function visibilityOf(rel: string, text = ""): Vis {
  const base: Vis = rel.startsWith("self/") || rel.startsWith("journal/") ? "owner"
    : rel.startsWith("shared/") ? "shared"
    : /^(projects|topics|sources|groups)\//.test(rel) ? "work" : "owner";
  const fm = frontmatter(text).visibility as Vis | undefined;
  return fm && fm in RANK && RANK[fm] < RANK[base] ? fm : base;
}

/** which visibilities a reader may see: owner → all; work drafting → work+shared; others → shared */
export const visibleTo = (who: "owner" | "work" | "known" | "other"): Vis[] =>
  who === "owner" ? ["owner", "work", "shared"] : who === "work" ? ["work", "shared"] : ["shared"];

function titleOf(rel: string, text: string) {
  const fm = frontmatter(text);
  return fm.title || /^#\s+(.+)$/m.exec(body(text))?.[1]?.trim() || rel.replace(/\.md$/, "").split("/").pop()!;
}
function summaryOf(text: string) {
  const fm = frontmatter(text);
  if (fm.summary) return fm.summary.slice(0, 80);
  const l = body(text).split("\n").map((x) => x.trim()).find((x) => x && !x.startsWith("#") && !/^[-*]\s*$/.test(x));
  return (l ?? "").replace(/^[-*]\s+/, "").replace(/\[src=[^\]]*\]\s*/g, "").slice(0, 80);
}

function walk(d: string, out: string[] = []) {
  for (const e of readdirSync(d, { withFileTypes: true })) {
    if (e.name.startsWith(".")) continue;
    const full = join(d, e.name);
    if (e.isDirectory()) walk(full, out);
    else if (e.name.endsWith(".md")) out.push(relative(P.agentHome, full).split(sep).join("/"));
  }
  return out;
}

/** Bring pages / pages_fts in line with the files (by mtime). Cheap enough to call after every commit. */
export function syncPages(): number {
  if (!existsSync(P.agentHome)) return 0;
  const files = walk(P.agentHome).filter((r) => !SKIP.has(r));
  const known = new Map(all("SELECT path, mtime FROM pages").map((r) => [r.path as string, r.mtime as number]));
  let n = 0;
  db.exec("BEGIN");
  try {
    for (const rel of files) {
      const mtime = Math.floor(statSync(join(P.agentHome, rel)).mtimeMs);
      if (known.get(rel) === mtime) { known.delete(rel); continue; }
      known.delete(rel);
      const text = readFileSync(join(P.agentHome, rel), "utf8");
      const vis = visibilityOf(rel, text), title = titleOf(rel, text);
      run("DELETE FROM pages_fts WHERE path=?", rel);
      run("INSERT INTO pages_fts(path, title, body, visibility) VALUES(?,?,?,?)", rel, title, body(text), vis);
      run(`INSERT INTO pages(path, mtime, title, summary, visibility, bytes) VALUES(?,?,?,?,?,?)
           ON CONFLICT(path) DO UPDATE SET mtime=excluded.mtime, title=excluded.title, summary=excluded.summary, visibility=excluded.visibility, bytes=excluded.bytes`,
        rel, mtime, title, summaryOf(text), vis, text.length);
      n++;
    }
    for (const gone of known.keys()) { run("DELETE FROM pages_fts WHERE path=?", gone); run("DELETE FROM pages WHERE path=?", gone); n++; }
    db.exec("COMMIT");
  } catch (e) { db.exec("ROLLBACK"); throw e; }
  return n;
}

/**
 * Full-text search: FTS5 (trigram) for terms of 3+ characters, LIKE for shorter ones (trigram can't match those),
 * then the matching lines of the best pages, as path:line: text.
 */
export function searchWiki(query: string, who: "owner" | "work" | "known" | "other", limit = 20): string {
  const terms = query.split(/\s+/).map((t) => t.trim()).filter(Boolean);
  if (!terms.length) return "(empty query)";
  try { syncPages(); } catch (e: any) { log("wiki", "sync failed", { err: String(e?.message ?? e) }); }
  const vis = visibleTo(who);
  const long = terms.filter((t) => [...t].length >= 3), short = terms.filter((t) => [...t].length < 3);
  const where: string[] = [`visibility IN (${vis.map(() => "?").join(",")})`];
  const args: any[] = [...vis];
  if (long.length) { where.push("pages_fts MATCH ?"); args.push(long.map((t) => `"${t.replace(/"/g, '""')}"`).join(" AND ")); }
  for (const t of short) { where.push("(body LIKE ? OR title LIKE ?)"); args.push(`%${t}%`, `%${t}%`); }
  const order = long.length ? "ORDER BY rank" : "ORDER BY path DESC";
  const pages = all(`SELECT path, title FROM pages_fts WHERE ${where.join(" AND ")} ${order} LIMIT 12`, ...args);
  if (!pages.length) return "(no matches)";
  const low = terms.map((t) => t.toLowerCase());
  const hits: string[] = [];
  for (const p of pages) {
    const f = join(P.agentHome, p.path);
    if (!existsSync(f)) continue;
    const lines = readFileSync(f, "utf8").split("\n");
    let k = 0;
    lines.forEach((l, i) => { if (k < 4 && low.some((t) => l.toLowerCase().includes(t))) { hits.push(`${p.path}:${i + 1}: ${l.trim().slice(0, 200)}`); k++; } });
    if (!k) hits.push(`${p.path}: (${p.title})`);
    if (hits.length >= limit) break;
  }
  return hits.slice(0, limit).join("\n");
}

const GROUPS: [string, string][] = [["", "根目录"], ["people/", "人"], ["groups/", "群"], ["projects/", "项目"], ["topics/", "主题"],
  ["sources/", "资料"], ["matters/", "事"], ["shared/", "可分享"], ["self/", "自我（仅主人）"]];

/** index.md: one line per page, grouped; rebuilt by code (§8.5). Journal is summarized, not listed. */
export function rebuildIndex(): boolean {
  syncPages();
  const rows = all("SELECT path, title, summary, visibility FROM pages ORDER BY path");
  const parts = ["# 目录", "", "<!-- 由代码根据页面自动生成，不要手改 -->", ""];
  for (const [prefix, name] of GROUPS) {
    const xs = rows.filter((r) => prefix ? r.path.startsWith(prefix) : !r.path.includes("/"));
    if (!xs.length) continue;
    parts.push(`## ${name}`);
    for (const r of xs) parts.push(`- [${r.title}](${r.path})${r.summary ? ` — ${r.summary}` : ""} · ${r.visibility}`);
    parts.push("");
  }
  const days = rows.filter((r) => r.path.startsWith("journal/")).map((r) => r.path.slice(8, 18)).sort();
  if (days.length) parts.push("## 日志", `- journal/：${days.length} 天，${days[0]} ～ ${days.at(-1)}`, "");
  const next = parts.join("\n");
  const f = join(P.agentHome, "index.md");
  if (existsSync(f) && readFileSync(f, "utf8") === next) return false;
  writeFileSync(f, next);
  return true;
}

/** log.md: `## [2026-11-17] dream | 标题` + optional lines (§8.5) */
export function appendLog(kind: string, title: string, lines: string[] = []) {
  const f = join(P.agentHome, "log.md");
  if (!existsSync(f)) writeFileSync(f, "# 记录\n\n只追加：ingest、dream、lint、好答案回收都记一笔。\n\n");
  appendFileSync(f, `## [${localStamp().slice(0, 10)}] ${kind} | ${title}\n${lines.map((l) => `- ${l}\n`).join("")}\n`);
}

/** Commit agent-home if dirty, then reindex. */
export function commitMemory(message: string): boolean {
  const did = commitIfDirty(P.agentHome, message);
  try { syncPages(); } catch (e: any) { log("wiki", "sync failed", { err: String(e?.message ?? e) }); }
  return did;
}

export const pageCount = () => one("SELECT COUNT(*) n FROM pages")!.n as number;
