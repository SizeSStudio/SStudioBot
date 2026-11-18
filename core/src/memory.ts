// agent-home (DESIGN §8): the memory repo. Only the core touches these files; agents go through the memory tools,
// which validate paths here. Every journal line carries a source tag the model cannot set (§8.3).

import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, copyFileSync, writeFileSync } from "node:fs";
import { parseDocument } from "yaml";
import { run } from "./db.ts";
import { execFileSync } from "node:child_process";
import { dirname, join, normalize, relative, sep } from "node:path";
import { P, TZ, log } from "./config.ts";

const fmt = new Intl.DateTimeFormat("sv-SE", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false });
/** "2026-11-17 05:12" in the owner's timezone */
export const localStamp = (ms = Date.now()) => fmt.format(new Date(ms)).replace(",", "");
const WEEK = ["日", "一", "二", "三", "四", "五", "六"];
export function localNow(ms = Date.now()) {
  const s = localStamp(ms);
  const wd = new Date(new Date(ms).toLocaleString("en-US", { timeZone: TZ })).getDay();
  return `${s} 周${WEEK[wd]}`;
}

const GIT_ENV = { ...process.env, GIT_AUTHOR_NAME: "SStudioBot", GIT_AUTHOR_EMAIL: "sbot@localhost", GIT_COMMITTER_NAME: "SStudioBot", GIT_COMMITTER_EMAIL: "sbot@localhost" };
export const git = (dir: string, ...args: string[]) => execFileSync("git", ["-C", dir, ...args], { env: GIT_ENV, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

// git spawns are synchronous and block the whole core (a 60-commit log with file names takes most of a second on the
// server), so history reads are kept until the branch moves. Stat'ing the ref catches every kind of commit, including
// dream's reverts and anything done by hand on the server, which hooking our own commit calls would miss.
const fileStamp = (f: string) => { try { const s = statSync(f, { bigint: true }); return `${s.ino}:${s.mtimeNs}:${s.size}`; } catch { return "-"; } };
function headStamp(dir: string) {
  const head = readFileSync(join(dir, ".git", "HEAD"), "utf8").trim(), ref = /^ref: (.+)$/.exec(head)?.[1];
  return [head, ref ? fileStamp(join(dir, ".git", ref)) : "", fileStamp(join(dir, ".git", "packed-refs"))].join("|");
}
const gitReads = new Map<string, { stamp: string; out: Map<string, string> }>();
/** `git` for read-only commands whose output depends only on commits (log, not status). Failures are not cached. */
export function gitRead(dir: string, ...args: string[]): string {
  let stamp: string;
  try { stamp = headStamp(dir); } catch { return git(dir, ...args); }
  let c = gitReads.get(dir);
  if (c?.stamp !== stamp) gitReads.set(dir, c = { stamp, out: new Map() });
  const key = args.join("\0");
  let v = c.out.get(key);
  if (v === undefined) {
    v = git(dir, ...args);
    if (c.out.size >= 64) c.out.delete(c.out.keys().next().value!);
    c.out.set(key, v);
  }
  return v;
}

export function commitIfDirty(dir: string, message: string): boolean {
  if (!git(dir, "status", "--porcelain").trim()) return false;
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", message);
  return true;
}

/**
 * Edit a YAML file in the config repo (comments kept), commit, and log it in config_changes (§10.3). Only code paths
 * driven by the owner (commands, card clicks) or a one-time upgrade call this; no agent tool can.
 */
export function editConfig(file: string, edit: (doc: ReturnType<typeof parseDocument>) => string | undefined, source: "card" | "command" | "console" | "upgrade") {
  const path = join(P.config, file);
  const doc = parseDocument(existsSync(path) ? readFileSync(path, "utf8") : "");
  if (!doc.contents) doc.contents = doc.createNode({}) as any;
  const what = edit(doc);
  if (!what) return;
  writeFileSync(path, doc.toString());
  commitIfDirty(P.config, `${file}: ${what} (via ${source})`);
  run("INSERT INTO config_changes(ts, file, diff, source) VALUES(?,?,?,?)", Date.now(), file, what, source);
}

/** Create agent-home as a git repo and copy the seed files that are missing (never overwrites). */
export function ensureAgentHome(seedDir: string) {
  mkdirSync(P.agentHome, { recursive: true });
  if (!existsSync(join(P.agentHome, ".git"))) git(P.agentHome, "init", "-q", "-b", "main");
  const walk = (d: string): string[] => readdirSync(d, { withFileTypes: true }).flatMap((e) => e.isDirectory() ? walk(join(d, e.name)) : [join(d, e.name)]);
  if (existsSync(seedDir)) for (const f of walk(seedDir)) {
    const dest = join(P.agentHome, relative(seedDir, f));
    if (!existsSync(dest)) { mkdirSync(dirname(dest), { recursive: true }); copyFileSync(f, dest); log("memory", `seeded ${relative(seedDir, f)}`); }
  }
  for (const d of ["journal", "people", "groups", "projects", "topics", "shared", "matters", "self"]) mkdirSync(join(P.agentHome, d), { recursive: true });
  commitIfDirty(P.agentHome, "seed");
}

export type Principal = "owner" | "known" | "other";
const OWNER_ONLY = ["self/"];
const NEVER = [".git/"];

/** the path as the filesystem will see it, so a check on it can't be dodged with ./ or a/../ */
export const cleanRel = (rel: string) => normalize(rel.replace(/^\/+/, "")).split(sep).join("/");

/** Resolve a model-supplied relative path; throws on anything outside agent-home or not visible to the principal. */
export function safePath(rel: string, who: Principal): string {
  const n = cleanRel(rel);
  if (n.startsWith("..") || n.includes("/../") || n === ".") throw new Error(`bad path: ${rel}`);
  if (!n.endsWith(".md")) throw new Error("only .md files");
  if (NEVER.some((p) => n.startsWith(p))) throw new Error(`not allowed: ${rel}`);
  if (who !== "owner" && OWNER_ONLY.some((p) => n.startsWith(p))) throw new Error(`not allowed: ${rel}`);
  if (who !== "owner" && !n.startsWith("shared/")) throw new Error(`not allowed: ${rel}`);  // §4.1: others only see shared/ (+ people notes, M5)
  return join(P.agentHome, n);
}

export function readPage(rel: string, who: Principal, maxChars = 12_000): string {
  const f = safePath(rel, who);
  if (!existsSync(f)) return `(no such page: ${rel})`;
  const s = readFileSync(f, "utf8");
  return s.length > maxChars ? s.slice(0, maxChars) + `\n…(truncated, ${s.length} chars)` : s;
}

export function appendJournal(text: string, src: string, ms = Date.now()): string {
  const [day, hm] = localStamp(ms).split(" ");
  const rel = `journal/${day}.md`;
  const f = join(P.agentHome, rel);
  mkdirSync(dirname(f), { recursive: true });
  if (!existsSync(f)) appendFileSync(f, `# ${day}\n\n`);
  appendFileSync(f, `- [${hm}][src=${src}] ${text.replace(/\s*\n\s*/g, " / ").trim()}\n`);
  return rel;
}

/** Files loaded into every owner run (§8.2), with size caps so a runaway file can't eat the context. */
export function promptFiles(): { name: string; text: string }[] {
  const caps: Record<string, number> = { "AGENTS.md": 12_000, "SOUL.md": 6_000, "USER.md": 4_000, "MEMORY.md": 4_000 };
  return Object.entries(caps).map(([name, cap]) => {
    const f = join(P.agentHome, name);
    let text = existsSync(f) ? readFileSync(f, "utf8").trim() : "";
    if (text.length > cap) text = text.slice(0, cap) + `\n…(${name} truncated at ${cap} chars; tell the owner it is over its cap)`;
    return { name, text };
  });
}

export const pageMtime = (rel: string) => { try { return statSync(join(P.agentHome, rel)).mtimeMs; } catch { return 0; } };
