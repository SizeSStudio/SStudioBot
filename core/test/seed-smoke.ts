// Seed sync (§8.6) on a fresh throwaway home, offline (no model calls, no Feishu):
//
//   ssh <server> 'bash -s seed-smoke.ts 7829' < test/vps-test-home.sh
//
// Uses its own fake seed versions (fictional text). Checks: fresh install is quiet and recorded; untouched ordinary
// files take a new seed with one commit; the agent's instructions (AGENTS, SOUL, skills/) wait for 「更新 seed」;
// hand-edited files are never overwritten and reported once; USER.md is never synced; a 回滚 is respected; a failed
// commit puts the old file back and is retried; an instance from before §8.6 is adopted without overwriting.

import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { P } from "../src/config.ts";
import { kvGet, run } from "../src/db.ts";
import { ensureAgentHome, applyWaitingSeed, seedNotice, seedAsks, blobHash, git, type SeedReport } from "../src/memory.ts";
import { rollback } from "../src/dream.ts";
import { takeSeed } from "../src/routes.ts";

const ok = (cond: unknown, what: string) => { console.log(`${cond ? "PASS" : "FAIL"} ${what}`); if (!cond) process.exitCode = 1; };
for (const d of [P.sessions, P.logs]) mkdirSync(d, { recursive: true });

const src = join(P.home, "seed-src");
const put = (v: string, files: Record<string, string>) => {
  const d = join(src, v);
  for (const [r, t] of Object.entries(files)) { mkdirSync(dirname(join(d, r)), { recursive: true }); writeFileSync(join(d, r), t); }
  return d;
};
const live = (r: string) => readFileSync(join(P.agentHome, r), "utf8");
const edit = (r: string, t: string) => { writeFileSync(join(P.agentHome, r), t); git(P.agentHome, "commit", "-qam", `hand edit ${r}`); };
const commits = () => Number(git(P.agentHome, "rev-list", "--count", "HEAD").trim());
const last = () => git(P.agentHome, "log", "-1", "--format=%s").trim();
const clean = () => git(P.agentHome, "status", "--porcelain").trim() === "";
const quiet = (r: SeedReport) => !r.added.length && !r.updated.length && !r.waiting.length && !r.diverged.length && !r.failed.length;
const sorted = (xs: string[]) => [...xs].sort().join(",");

const v1files = {
  "AGENTS.md": "# 规则 v1\n", "SOUL.md": "# 口吻 v1\n", "USER.md": "# 关于我（空）\n",
  "skills/review/SKILL.md": "---\nvisibility: owner\n---\n# 复盘 v1\n", "notes/a.md": "模板 A v1\n", "notes/b.md": "模板 B v1\n",
};
const v1 = put("v1", v1files);

// ── 1. fresh home ──
let r = ensureAgentHome(v1, "aaaaaaa");
ok(quiet(r) && seedNotice(r) === null, "fresh home: copied, nothing to report");
ok(live("AGENTS.md") === v1files["AGENTS.md"] && existsSync(join(P.agentHome, "journal")) && clean(), "files and dirs in place, committed");
let st = JSON.parse(kvGet("seed.state") ?? "{}");
ok(st["AGENTS.md"]?.at === blobHash(Buffer.from(v1files["AGENTS.md"])) && !st["USER.md"], "installed hashes recorded; USER.md is copied once, not tracked");
ok(blobHash(Buffer.from(v1files["SOUL.md"])) === git(P.agentHome, "hash-object", "SOUL.md").trim(), "blobHash is git's blob hash");
let n = commits();
r = ensureAgentHome(v1, "aaaaaaa");
ok(quiet(r) && commits() === n, "restart on the same seed: quiet, no commit");

// ── 2. hand edits, then a new seed that changes everything ──
edit("notes/b.md", "模板 B v1\n主人加的一行\n");
edit("USER.md", "# 关于我\n- 虚构的事实\n");
const v2files = { ...v1files, "AGENTS.md": "# 规则 v2\n", "SOUL.md": "# 口吻 v2\n", "USER.md": "# 关于我（新模板）\n",
  "skills/review/SKILL.md": "---\nvisibility: owner\n---\n# 复盘 v2\n", "notes/a.md": "模板 A v2\n", "notes/b.md": "模板 B v2\n", "notes/c.md": "模板 C v2\n" };
const v2 = put("v2", v2files);
n = commits();
r = ensureAgentHome(v2, "bbbbbbb");
ok(r.updated.join() === "notes/a.md" && live("notes/a.md") === "模板 A v2\n", "untouched ordinary file → replaced");
ok(!!r.commit && last() === "seed: 更新 notes/a.md（bbbbbbb）" && commits() === n + 2 && clean(), `one commit for the update, one for the new file (${last()})`);
const autoSha = r.commit!;
ok(r.added.join() === "notes/c.md" && live("notes/c.md") === "模板 C v2\n", "new seed file → copied, reported as 新加");
ok(sorted(r.waiting) === "AGENTS.md,SOUL.md,skills/review/SKILL.md" && live("AGENTS.md") === "# 规则 v1\n" && live("skills/review/SKILL.md").includes("复盘 v1"),
  "AGENTS / SOUL / skills: untouched but wait for him");
ok(r.diverged.join() === "notes/b.md" && live("notes/b.md").includes("主人加的一行"), "hand-edited file → 有更新待合, not overwritten");
ok(live("USER.md").includes("虚构的事实"), "USER.md never synced");
const note = seedNotice(r) ?? "";
ok(note.includes("`bbbbbbb`") && note.includes(`回滚 ${autoSha}`) && note.includes("等你点头") && note.includes("有更新待合") && note.includes("notes/b.md"),
  `notice lists names and how to undo (${note.replace(/\n/g, " | ")})`);
ok(!/v2|主人加的|虚构/.test(note), "notice carries no file content");

// ── 3. told once ──
r = ensureAgentHome(v2, "bbbbbbb");
ok(quiet(r), "restart on the same seed: each piece of news told once");

// ── 4. he takes one ──
ok(applyWaitingSeed(["nope"]).startsWith("没有叫"), "unknown name → says which files wait");
let out = takeSeed("agents");
ok(out.startsWith("已换上 AGENTS.md") && live("AGENTS.md") === "# 规则 v2\n" && live("SOUL.md") === "# 口吻 v1\n", `更新 seed agents → only AGENTS.md (${out})`);
const agentsSha = /回滚 ([0-9a-f]+)/.exec(out)?.[1] ?? "";
const subj = agentsSha ? git(P.agentHome, "log", "-1", "--format=%s", agentsSha).trim() : "";
ok(subj === "seed: 更新 AGENTS.md（主人确认，bbbbbbb）" && clean(), `commit says he confirmed (${subj})`);

// ── 5. 回滚 is his answer ──
ok(rollback(agentsSha).startsWith("已撤销") && live("AGENTS.md") === "# 规则 v1\n", `回滚 ${agentsSha} brings the old AGENTS.md back`);
ok(rollback(autoSha).startsWith("已撤销") && live("notes/a.md") === "模板 A v1\n", `回滚 ${autoSha} brings the old notes/a.md back`);
r = ensureAgentHome(v2, "bbbbbbb");
ok(quiet(r) && live("AGENTS.md") === "# 规则 v1\n" && live("notes/a.md") === "模板 A v1\n", "after his 回滚: not re-applied, not re-reported");

// ── 6. 更新 seed for all that wait ──
edit("SOUL.md", "# 口吻 v1\n主人改的\n");
out = takeSeed("");
ok(out.startsWith("已换上 AGENTS.md、skills/review/SKILL.md") && out.includes("SOUL.md 线上改过"), `更新 seed: asked-for AGENTS back on, skill on, hand-edited SOUL left (${out})`);
ok(live("AGENTS.md") === "# 规则 v2\n" && live("skills/review/SKILL.md").includes("复盘 v2") && live("SOUL.md").includes("主人改的"), "files as reported");
ok(takeSeed("").startsWith("没有要换的"), "nothing left to take");

// ── 7. a failed commit puts the old file back and is retried ──
const v3 = put("v3", { ...v2files, "notes/c.md": "模板 C v3\n" });
const lock = join(P.agentHome, ".git", "index.lock");
writeFileSync(lock, "");
r = ensureAgentHome(v3, "ccccccc");
ok(r.failed.join() === "notes/c.md" && live("notes/c.md") === "模板 C v2\n" && (seedNotice(r) ?? "").includes("没换成"), "commit fails → old file back, reported");
rmSync(lock);
ok(clean(), "nothing left half-done");
r = ensureAgentHome(v3, "ccccccc");
ok(r.updated.join() === "notes/c.md" && live("notes/c.md") === "模板 C v3\n" && clean(), "next start: taken");

// ── 8. an instance from before §8.6 (no record) ──
run("DELETE FROM kv WHERE k='seed.state'");
n = commits();
r = ensureAgentHome(v3, "ddddddd");
ok(sorted(r.diverged) === "SOUL.md,notes/a.md,notes/b.md" && !r.updated.length && commits() === n, `no record: different files reported, nothing overwritten (${r.diverged})`);
st = JSON.parse(kvGet("seed.state") ?? "{}");
ok(st["AGENTS.md"]?.at === blobHash(Buffer.from(v2files["AGENTS.md"])), "files equal to the seed start being tracked");
r = ensureAgentHome(v3, "ddddddd");
ok(quiet(r), "and then quiet");

// ── 9. which real seed files wait for him ──
ok(["AGENTS.md", "SOUL.md", "skills/review/SKILL.md", "skills/outlook/SKILL.md", "tuning/main.md"].every(seedAsks) && !["notes/a.md", "people/x.md"].some(seedAsks),
  "AGENTS, SOUL, skills/, tuning/ wait; others don't");

console.log(`\n${process.exitCode ? "SOME FAILED" : "ALL PASS"}`);
process.exit(process.exitCode ?? 0);
