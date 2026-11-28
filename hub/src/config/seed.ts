// Seeds (§底1.5, 03 「memory」 seed 同步). Ported from core/src/memory.ts (ensureAgentHome, seedNotice, applyWaitingSeed)
// with git going through the per-repo write queue instead of execFileSync.
//
// agent-home: a seed file is copied when missing, and later replaced only while nobody has touched it. kv `seed.state`
// keeps the blob hash of what was installed, so a file that still has it was not edited by me, dream, an improve
// proposal or a rollback. Anything else stays as it is and is reported once per new seed version.
//
// config: the repo is created if missing; the two seed files with no instance data in them (jobs.yaml, sources.yaml)
// are copied when absent. people.yaml and models.yaml need my data, so they are never seeded.
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type { Db } from "../db/db.ts";
import { ensureRepo, git, repoQueue } from "../memory/repo.ts";
import { log } from "../log.ts";

export const SEED_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "seed");
const CONFIG_SEEDED = ["jobs.yaml", "sources.yaml"];

/** Create the config repo; copy the seed files that carry no instance data when they are missing. Returns what it added. */
export async function ensureConfigRepo(dir: string, seedDir = join(SEED_DIR, "config")): Promise<string[]> {
  await ensureRepo(dir);
  const { result } = await repoQueue(dir).write((wt) => {
    const added: string[] = [];
    for (const f of CONFIG_SEEDED) {
      const src = join(seedDir, f), dest = join(wt, f);
      if (existsSync(src) && !existsSync(dest)) { copyFileSync(src, dest); added.push(f); }
    }
    return added;
  }, (added) => (added.length ? `seed: ${added.join(", ")}` : null));
  return result;
}

/** the instance's own notes from day one (dream writes them): copied once, never synced */
const SEED_ONCE = new Set(["USER.md", "MEMORY.md"]);
/**
 * The agent's own instructions, which only I change (AGENTS, SOUL, method skills, tuning; §读1.1, §底3.7, §进2.3 B).
 * Seed PRs can be merged without me reading them, so a new version waits for 「更新 seed」 from me.
 */
export const seedAsks = (rel: string) => rel === "AGENTS.md" || rel === "SOUL.md" || /^(skills|tuning)\//.test(rel);
/** at: hash installed; was: what it replaced (a rollback brings that back, and that is my answer); told: seed already reported */
type SeedState = Record<string, { at?: string; was?: string; told?: string }>;
export interface SeedReport { rev: string; added: string[]; updated: string[]; commit?: string; waiting: string[]; diverged: string[]; failed: string[] }

/** git's blob hash, so `git log --find-object=<hash>` in either repo names the version a file is at */
export const blobHash = (b: Buffer) => createHash("sha1").update(`blob ${b.length}\0`).update(b).digest("hex");
const seedState = (db: Db): SeedState => JSON.parse(db.kvGet("seed.state") ?? "{}");
const walk = (d: string): string[] => readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(d, e.name)) : [join(d, e.name)]));
const seedFiles = (dir: string) => (existsSync(dir) ? walk(dir).map((f) => relative(dir, f).split(sep).join("/")) : []);
const DIRS = ["journal", "people", "groups", "projects", "topics", "shared", "matters", "self"];

/** Copy the seed versions over `rels` and commit just those paths, inside the queue; puts the old files back if that fails. */
async function installSeed(agentHome: string, seedDir: string, rels: string[], why: string): Promise<string> {
  const { result } = await repoQueue(agentHome).write(async (wt) => {
    const old = rels.map((r) => [r, readFileSync(join(wt, r))] as const);
    try {
      for (const r of rels) copyFileSync(join(seedDir, r), join(wt, r));
      await git(wt, "add", "--", ...rels);
      await git(wt, "commit", "-q", "-m", `seed: 更新 ${rels.join("、")}（${why}）`, "--", ...rels);
      return (await git(wt, "rev-parse", "--short", "HEAD")).trim();
    } catch (e) {
      for (const [r, b] of old) writeFileSync(join(wt, r), b);
      try { await git(wt, "reset", "-q", "--", ...rels); } catch { /* nothing staged */ }
      throw e;
    }
  }, () => null /* committed above, paths only */);
  return result;
}

/**
 * Create agent-home as a git repo, copy missing seed files, and bring untouched ones up to the new seed (§底1.5).
 * Never overwrites a file that differs from what was installed. `rev` (short sha of the release) goes into the commit.
 */
export async function ensureAgentHome(db: Db, agentHome: string, seedDir = join(SEED_DIR, "agent-home"), rev = ""): Promise<SeedReport> {
  const fresh = !existsSync(join(agentHome, ".git"));
  await ensureRepo(agentHome);
  const st = seedState(db), rep: SeedReport = { rev, added: [], updated: [], waiting: [], diverged: [], failed: [] };
  const due: [string, string, string][] = [];   // rel, seed hash, live hash
  await repoQueue(agentHome).write((wt) => {
    for (const rel of seedFiles(seedDir)) {
      const src = join(seedDir, rel), dest = join(wt, rel), s = blobHash(readFileSync(src));
      if (!existsSync(dest)) {
        mkdirSync(dirname(dest), { recursive: true }); copyFileSync(src, dest);
        if (!SEED_ONCE.has(rel)) st[rel] = { at: s };
        if (!fresh) rep.added.push(rel);
        continue;
      }
      if (SEED_ONCE.has(rel)) continue;
      const e = st[rel] ??= {}, live = blobHash(readFileSync(dest));
      // already there; a file with no record yet that equals the seed starts being tracked here
      if (live === s) { st[rel] = e.at === s ? { at: s, ...(e.was ? { was: e.was } : {}) } : { at: s }; continue; }
      if (e.at === live && !seedAsks(rel)) { due.push([rel, s, live]); continue; }
      const rolledBack = e.at === s && e.was === live;   // I reverted our update to this very seed: an answer, not news
      if (e.told !== s && !rolledBack) (e.at === live ? rep.waiting : rep.diverged).push(rel);
      e.told = s;
    }
    for (const d of DIRS) mkdirSync(join(wt, d), { recursive: true });
  }, "seed");
  if (due.length) {
    const rels = due.map(([r]) => r);
    try {
      rep.commit = await installSeed(agentHome, seedDir, rels, rev || "seed");
      for (const [r, s, live] of due) st[r] = { at: s, was: live };
      rep.updated = rels;
      log("seed", "updated", { files: rels, commit: rep.commit });
    } catch (e) {
      rep.failed = rels;   // tried again on the next start
      log("seed", "update failed", { files: rels, err: String((e as { stderr?: string })?.stderr ?? (e as Error)?.message ?? e).slice(0, 300) });
    }
  }
  db.kvSet("seed.state", JSON.stringify(st));
  return rep;
}

/** The admin-notice lines for a start (file names only, never content), or null when there is nothing new. */
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
 * 「更新 seed [名字…]」 from me: take the new seed for files that wait for me (seedAsks). A name matches the path, the
 * file name without .md, or the skill's folder ("review"). Only untouched files are replaced; one I rolled back counts
 * as untouched here, since I am now asking for it.
 */
export async function applyWaitingSeed(db: Db, agentHome: string, names: string[] = [], seedDir = join(SEED_DIR, "agent-home"), rev = ""): Promise<string> {
  const keys = (rel: string) => [rel, rel.replace(/\.md$/, ""), rel.split("/")[1] ?? ""].map((k) => k.toLowerCase());
  const asks = seedFiles(seedDir).filter(seedAsks);
  const want = names.length ? asks.filter((r) => names.some((n) => keys(r).includes(n.toLowerCase()))) : asks;
  if (!want.length) return `没有叫 ${names.join("、")} 的。要你点头的是：${asks.join("、")}。`;
  const st = seedState(db), take: [string, string, string][] = [], skip: string[] = [];
  for (const rel of want) {
    const dest = join(agentHome, rel);
    if (!existsSync(dest)) continue;
    const s = blobHash(readFileSync(join(seedDir, rel))), live = blobHash(readFileSync(dest)), e = st[rel];
    if (live === s) continue;
    if (e && (e.at === live || e.was === live)) take.push([rel, s, live]); else skip.push(rel);
  }
  const note = skip.length ? `${skip.join("、")} 线上改过，没动，要手动合。` : "";
  if (!take.length) return `没有要换的。${note}`;
  const rels = take.map(([r]) => r);
  let sha: string;
  try { sha = await installSeed(agentHome, seedDir, rels, `我确认${rev ? `，${rev}` : ""}`); }
  catch (e) { log("seed", "apply failed", { err: String((e as { stderr?: string })?.stderr ?? (e as Error)?.message ?? e).slice(0, 300) }); return "没换成，提交出错了，详情在日志。"; }
  for (const [r, s, live] of take) st[r] = { at: s, was: live };
  db.kvSet("seed.state", JSON.stringify(st));
  log("seed", "applied", { files: rels, commit: sha });
  return `已换上 ${rels.join("、")}（回「回滚 ${sha}」可撤）。${note}`;
}
