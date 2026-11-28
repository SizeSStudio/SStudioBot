// Knowledge-base layer over agent-home (§读1.4, §读1.5), ported from core/src/wiki.ts: page visibility, pages /
// pages_fts (synced from the files by mtime), index.md (rebuilt by code), log.md (append-only).
// Changes from core/: the tables come from the schema (04), not CREATE IF NOT EXISTS here; commits go through the
// agent-home write queue (memory/repo.ts); search reports how complete its answer is (R7) and pages with `offset`.
//
// Visibility is decided by code: self/ and journal/ are always owner; shared/ is shared; projects/topics/sources/groups
// default to work; everything else to owner. Frontmatter `visibility:` can only narrow that.
import { appendFileSync, existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { all, one, run, tx } from "../db/ambient.ts";
import { home } from "../home.ts";
import { log } from "../log.ts";
import { localStamp } from "../time.ts";
import { repoQueue } from "./repo.ts";

export type Vis = "owner" | "work" | "shared";
const RANK: Record<Vis, number> = { owner: 0, work: 1, shared: 2 };
const SKIP = new Set(["index.md", "log.md"]);
const dir = () => home().agentHome;

export function frontmatter(text: string): Record<string, string> {
  const m = /^---\n([\s\S]*?)\n---\n?/.exec(text);
  if (!m) return {};
  const out: Record<string, string> = {};
  for (const l of m[1]!.split("\n")) { const kv = /^([A-Za-z_]+):\s*(.*)$/.exec(l); if (kv) out[kv[1]!] = kv[2]!.replace(/^["']|["']$/g, "").trim(); }
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
  return (l ?? "").replace(/^[-*]\s+/, "").replace(/\[(?:src|run)=[^\]]*\]\s*/g, "").slice(0, 80);
}

function walk(d: string, out: string[] = []) {
  for (const e of readdirSync(d, { withFileTypes: true })) {
    if (e.name.startsWith(".")) continue;
    const full = join(d, e.name);
    if (e.isDirectory()) walk(full, out);
    else if (e.name.endsWith(".md")) out.push(relative(dir(), full).split(sep).join("/"));
  }
  return out;
}

/** bring pages / pages_fts in line with the files (by mtime); cheap enough after every commit */
export function syncPages(): number {
  if (!existsSync(dir())) return 0;
  const files = walk(dir()).filter((r) => !SKIP.has(r));
  const known = new Map(all("SELECT path, mtime FROM pages").map((r) => [r.path as string, r.mtime as number]));
  let n = 0;
  tx(() => {
    for (const rel of files) {
      const mtime = Math.floor(statSync(join(dir(), rel)).mtimeMs);
      if (known.get(rel) === mtime) { known.delete(rel); continue; }
      known.delete(rel);
      const text = readFileSync(join(dir(), rel), "utf8");
      const vis = visibilityOf(rel, text), title = titleOf(rel, text);
      run("DELETE FROM pages_fts WHERE path=?", rel);
      run("INSERT INTO pages_fts(path, title, body, visibility) VALUES(?,?,?,?)", rel, title, body(text), vis);
      run(`INSERT INTO pages(path, mtime, title, summary, visibility, bytes) VALUES(?,?,?,?,?,?)
           ON CONFLICT(path) DO UPDATE SET mtime=excluded.mtime, title=excluded.title, summary=excluded.summary, visibility=excluded.visibility, bytes=excluded.bytes`,
        rel, mtime, title, summaryOf(text), vis, text.length);
      n++;
    }
    for (const gone of known.keys()) { run("DELETE FROM pages_fts WHERE path=?", gone); run("DELETE FROM pages WHERE path=?", gone); n++; }
  });
  return n;
}

export const SEARCH_PAGES = 12;
const LINES_PER_PAGE = 4;

/**
 * Full-text search: FTS5 trigram for terms of 3+ characters, LIKE for shorter ones (trigram can't match those); then
 * up to 4 matching lines per page. The first line always says how complete the answer is (R7), so the model knows
 * when to ask for the next `offset`.
 */
export function searchWiki(query: string, who: "owner" | "work" | "known" | "other", o: { offset?: number; pages?: number } = {}): string {
  const terms = query.split(/\s+/).map((t) => t.trim()).filter(Boolean);
  if (!terms.length) return "（空查询）";
  try { syncPages(); } catch (e) { log("wiki", "sync failed", { err: String((e as Error)?.message ?? e) }); }
  const vis = visibleTo(who);
  const long = terms.filter((t) => [...t].length >= 3), short = terms.filter((t) => [...t].length < 3);
  const where: string[] = [`visibility IN (${vis.map(() => "?").join(",")})`];
  const args: string[] = [...vis];
  if (long.length) { where.push("pages_fts MATCH ?"); args.push(long.map((t) => `"${t.replace(/"/g, '""')}"`).join(" AND ")); }
  for (const t of short) { where.push("(body LIKE ? OR title LIKE ?)"); args.push(`%${t}%`, `%${t}%`); }
  const total = Number(one(`SELECT COUNT(*) n FROM pages_fts WHERE ${where.join(" AND ")}`, ...args)?.n ?? 0);
  if (!total) return "共 0 页命中。";
  const offset = Math.max(0, Math.floor(o.offset ?? 0)), size = Math.max(1, Math.min(o.pages ?? SEARCH_PAGES, 50));
  const order = long.length ? "ORDER BY rank" : "ORDER BY path DESC";
  const pages = all(`SELECT path, title FROM pages_fts WHERE ${where.join(" AND ")} ${order} LIMIT ? OFFSET ?`, ...args, size, offset);
  const low = terms.map((t) => t.toLowerCase());
  const hits: string[] = [];
  for (const p of pages) {
    const f = join(dir(), p.path);
    if (!existsSync(f)) continue;
    const lines = readFileSync(f, "utf8").split("\n");
    let k = 0;
    lines.forEach((l, i) => { if (k < LINES_PER_PAGE && low.some((t) => l.toLowerCase().includes(t))) { hits.push(`${p.path}:${i + 1}: ${l.trim().slice(0, 200)}`); k++; } });
    if (!k) hits.push(`${p.path}: (${p.title})`);
  }
  const rest = Math.max(0, total - offset - pages.length);
  const head = `共 ${total} 页命中，显示 ${pages.length} 页（第 ${offset + 1}–${offset + pages.length} 页），每页前 ${LINES_PER_PAGE} 行；` +
    (rest ? `还有 ${rest} 页，用 offset=${offset + pages.length} 看下一批` : "没有更多了");
  return [head, ...hits].join("\n");
}

const GROUPS: [string, string][] = [["", "根目录"], ["people/", "人"], ["groups/", "群"], ["projects/", "项目"], ["topics/", "主题"],
  ["sources/", "资料"], ["matters/", "事"], ["shared/", "可分享"], ["self/", "自我（只给我看）"]];

/** index.md: one line per page, grouped; rebuilt by code (§读1.5). The journal is summarized, not listed. */
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
  const days = rows.filter((r) => r.path.startsWith("journal/")).map((r) => String(r.path).slice(8, 18)).sort();
  if (days.length) parts.push("## 日志", `- journal/：${days.length} 天，${days[0]} ～ ${days.at(-1)}`, "");
  const next = parts.join("\n");
  const f = join(dir(), "index.md");
  if (existsSync(f) && readFileSync(f, "utf8") === next) return false;
  writeFileSync(f, next);
  return true;
}

/** log.md: `## [2026-11-17] dream | 标题` + optional lines (§读1.5) */
export function appendLog(kind: string, title: string, lines: string[] = []) {
  const f = join(dir(), "log.md");
  if (!existsSync(f)) writeFileSync(f, "# 记录\n\n只追加：ingest、dream、lint、好答案回收都记一笔。\n\n");
  appendFileSync(f, `## [${localStamp().slice(0, 10)}] ${kind} | ${title}\n${lines.map((l) => `- ${l}\n`).join("")}\n`);
}

/**
 * Commit agent-home through its write queue, then reindex. For the ported ledgers, which write their files
 * synchronously inside the same call as their db tx (※ 10: their file edits move into queue callbacks when they are
 * rewritten); the queued commit picks up whatever is dirty. Returns the queued write so callers can await it.
 */
export function commitMemory(message: string): Promise<string | null> {
  return repoQueue(dir()).write(() => undefined, message).then((r) => {
    try { syncPages(); } catch (e) { log("wiki", "sync failed", { err: String((e as Error)?.message ?? e) }); }
    return r.sha;
  }, (e) => { log("wiki", "commit failed", { err: String((e as Error)?.message ?? e).slice(0, 200) }); return null; });
}

export const pageCount = () => Number(one("SELECT COUNT(*) n FROM pages")?.n ?? 0);
