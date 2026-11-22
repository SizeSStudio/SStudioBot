// agent-home (DESIGN §读1): the memory repo. Only the core touches these files; agents go through the memory tools,
// which validate paths here. Every journal line carries a source tag the model cannot set (§读1.3).

import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, copyFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { parseDocument } from "yaml";
import { run, kvGet, kvSet } from "./db.ts";
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
 * Edit a YAML file in the config repo (comments kept), commit, and log it in config_changes (§触5.3). Only code paths
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

// ---- seed (§底1.5) ----
// A seed file is copied when missing, and later replaced only while nobody has touched it: kv `seed.state` keeps the
// blob hash of what was installed, so a file that still has it was not edited by the owner, dream, an improve proposal
// or a 回滚. Anything else stays as it is and is reported once per new seed version.

/** the instance's own notes from day one (dream writes them): copied once, never synced */
const SEED_ONCE = new Set(["USER.md", "MEMORY.md"]);
/**
 * The agent's own instructions, which only the owner changes (AGENTS, SOUL, method skills, tuning; §读1.1, §底3.7,
 * §进2.3 B). Seed PRs can be merged without him reading them, so a new version waits for 「更新 seed」 from him.
 */
export const seedAsks = (rel: string) => rel === "AGENTS.md" || rel === "SOUL.md" || /^(skills|tuning)\//.test(rel);
/** at: hash installed; was: what it replaced (a 回滚 brings that back, and that is his answer); told: seed already reported */
type SeedState = Record<string, { at?: string; was?: string; told?: string }>;
export interface SeedReport { rev: string; added: string[]; updated: string[]; commit?: string; waiting: string[]; diverged: string[]; failed: string[] }

/** git's blob hash, so `git log --find-object=<hash>` in either repo names the version a file is at */
export const blobHash = (b: Buffer) => createHash("sha1").update(`blob ${b.length}\0`).update(b).digest("hex");
const seedState = (): SeedState => JSON.parse(kvGet("seed.state") ?? "{}");
const walk = (d: string): string[] => readdirSync(d, { withFileTypes: true }).flatMap((e) => e.isDirectory() ? walk(join(d, e.name)) : [join(d, e.name)]);
const seedFiles = (dir: string) => existsSync(dir) ? walk(dir).map((f) => relative(dir, f).split(sep).join("/")) : [];
let seedFrom = { dir: "", rev: "" };

/** Copy the seed versions over `rels` and commit just those paths; puts the old files back if that fails. */
function installSeed(rels: string[], why: string): string {
  const old = rels.map((r) => [r, readFileSync(join(P.agentHome, r))] as const);
  try {
    for (const r of rels) copyFileSync(join(seedFrom.dir, r), join(P.agentHome, r));
    git(P.agentHome, "add", "--", ...rels);
    git(P.agentHome, "commit", "-q", "-m", `seed: 更新 ${rels.join("、")}（${why}）`, "--", ...rels);
    return git(P.agentHome, "rev-parse", "--short", "HEAD").trim();
  } catch (e) {
    for (const [r, b] of old) writeFileSync(join(P.agentHome, r), b);
    try { git(P.agentHome, "reset", "-q", "--", ...rels); } catch { /* nothing staged */ }
    throw e;
  }
}

/**
 * Create agent-home as a git repo, copy missing seed files, and bring untouched ones up to the new seed (§底1.5).
 * Never overwrites a file that differs from what was installed. `rev` (short sha of the release) goes into the commit.
 */
export function ensureAgentHome(seedDir: string, rev = ""): SeedReport {
  mkdirSync(P.agentHome, { recursive: true });
  const fresh = !existsSync(join(P.agentHome, ".git"));
  if (fresh) git(P.agentHome, "init", "-q", "-b", "main");
  seedFrom = { dir: seedDir, rev };
  const st = seedState(), rep: SeedReport = { rev, added: [], updated: [], waiting: [], diverged: [], failed: [] };
  const due: [string, string, string][] = [];   // rel, seed hash, live hash
  for (const rel of seedFiles(seedDir)) {
    const src = join(seedDir, rel), dest = join(P.agentHome, rel), s = blobHash(readFileSync(src));
    if (!existsSync(dest)) {
      mkdirSync(dirname(dest), { recursive: true }); copyFileSync(src, dest); log("memory", `seeded ${rel}`);
      if (!SEED_ONCE.has(rel)) st[rel] = { at: s };
      if (!fresh) rep.added.push(rel);
      continue;
    }
    if (SEED_ONCE.has(rel)) continue;
    const e = st[rel] ??= {}, live = blobHash(readFileSync(dest));
    // already there; a file from before §底1.5 (no record yet) that equals the seed starts being tracked here
    if (live === s) { st[rel] = e.at === s ? { at: s, was: e.was } : { at: s }; continue; }
    if (e.at === live && !seedAsks(rel)) { due.push([rel, s, live]); continue; }
    const rolledBack = e.at === s && e.was === live;   // he reverted our update to this very seed: an answer, not news
    if (e.told !== s && !rolledBack) (e.at === live ? rep.waiting : rep.diverged).push(rel);
    e.told = s;
  }
  for (const d of ["journal", "people", "groups", "projects", "topics", "shared", "matters", "self"]) mkdirSync(join(P.agentHome, d), { recursive: true });
  commitIfDirty(P.agentHome, "seed");
  if (due.length) {
    const rels = due.map(([r]) => r);
    try {
      rep.commit = installSeed(rels, rev || "seed");
      for (const [r, s, live] of due) st[r] = { at: s, was: live };
      rep.updated = rels;
      log("memory", "seed updated", { files: rels, commit: rep.commit });
    } catch (e: any) {
      rep.failed = rels;   // tried again on the next start
      log("memory", "seed update failed", { files: rels, err: String(e?.stderr ?? e?.message ?? e).slice(0, 300) });
    }
  }
  kvSet("seed.state", JSON.stringify(st));
  return rep;
}

/** The admin-group lines for a start (file names only, never content), or null when there is nothing new. */
export function seedNotice(r: SeedReport): string | null {
  const l: string[] = [];
  if (r.updated.length) l.push(`- 换上了：${r.updated.join("、")}（回「回滚 ${r.commit}」可撤）`);
  if (r.added.length) l.push(`- 新加：${r.added.join("、")}`);
  if (r.waiting.length) l.push(`- 等你点头：${r.waiting.join("、")}（线上没改过；回「更新 seed」就换上，不要就不用理）`);
  if (r.diverged.length) l.push(`- 有更新待合：${r.diverged.join("、")}（线上改过，没覆盖）`);
  if (r.failed.length) l.push(`- 没换成：${r.failed.join("、")}（提交出错，下次启动再试，详情在日志）`);
  return l.length ? `**seed**${r.rev ? ` \`${r.rev}\`` : ""}\n${l.join("\n")}` : null;
}

/**
 * 「更新 seed [名字…]」 from the owner in the admin group: take the new seed for files that wait for him (seedAsks).
 * A name matches the path, the file name without .md, or the skill's folder ("review"). Only untouched files are
 * replaced; one he rolled back counts as untouched here, since he is now asking for it.
 */
export function applyWaitingSeed(names: string[] = []): string {
  if (!seedFrom.dir) return "seed 还没加载。";
  const keys = (rel: string) => [rel, rel.replace(/\.md$/, ""), rel.split("/")[1] ?? ""].map((k) => k.toLowerCase());
  const asks = seedFiles(seedFrom.dir).filter(seedAsks);
  const want = names.length ? asks.filter((r) => names.some((n) => keys(r).includes(n.toLowerCase()))) : asks;
  if (!want.length) return `没有叫 ${names.join("、")} 的。要你点头的是：${asks.join("、")}。`;
  const st = seedState(), take: [string, string, string][] = [], skip: string[] = [];
  for (const rel of want) {
    const dest = join(P.agentHome, rel);
    if (!existsSync(dest)) continue;
    const s = blobHash(readFileSync(join(seedFrom.dir, rel))), live = blobHash(readFileSync(dest)), e = st[rel];
    if (live === s) continue;
    if (e && (e.at === live || e.was === live)) take.push([rel, s, live]); else skip.push(rel);
  }
  const note = skip.length ? `${skip.join("、")} 线上改过，没动，要手动合。` : "";
  if (!take.length) return `没有要换的。${note}`;
  const rels = take.map(([r]) => r);
  let sha: string;
  try { sha = installSeed(rels, `主人确认${seedFrom.rev ? `，${seedFrom.rev}` : ""}`); }
  catch (e: any) { log("memory", "seed apply failed", { err: String(e?.stderr ?? e?.message ?? e).slice(0, 300) }); return "没换成，提交出错了，详情在日志。"; }
  for (const [r, s, live] of take) st[r] = { at: s, was: live };
  kvSet("seed.state", JSON.stringify(st));
  log("memory", "seed applied", { files: rels, commit: sha });
  return `已换上 ${rels.join("、")}（回「回滚 ${sha}」可撤）。${note}`;
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
  if (who !== "owner" && !n.startsWith("shared/")) throw new Error(`not allowed: ${rel}`);  // §办1.2: others only see shared/ (+ people notes, M5)
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

/** Files loaded into every owner run (§读1.2), with size caps so a runaway file can't eat the context. */
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
