// Bare mirrors of the repos in config/repos.yaml, on the core side (§4.2). The Task Engine bundles from them and
// pushes approved work through them; the git source (§17.3) reads new commits from them. One mirror per repo.

import { execFile } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { P, reposConf } from "./config.ts";

export const MIRRORS = join(P.home, "repos", "mirror");

export function gitIn(cwd: string, args: string[], timeoutMs = 120_000): Promise<string> {
  return new Promise((ok, bad) => {
    execFile("git", args, {
      cwd, timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024,
      env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: P.home, LANG: "C.UTF-8", GIT_TERMINAL_PROMPT: "0", GIT_CONFIG_NOSYSTEM: "1" },
    }, (err, stdout, stderr) => err ? bad(new Error(`git ${args.find((a) => !a.startsWith("-") && !a.includes("=")) ?? ""}: ${String(stderr || err.message).trim().slice(0, 300)}`)) : ok(stdout));
  });
}

/** bare mirror of a configured repo, fetched now; refs/heads/* mirror the remote, refs/sbot/* are ours (never pruned) */
export async function syncMirror(name: string): Promise<string> {
  const r = reposConf()[name];
  if (!r) throw new Error(`repos.yaml 里没有 ${name}`);
  const dir = join(MIRRORS, `${name}.git`);
  if (!existsSync(dir)) {
    mkdirSync(MIRRORS, { recursive: true });
    await gitIn(MIRRORS, ["init", "--bare", "-q", dir]);
    await gitIn(dir, ["config", "remote.origin.fetch", "+refs/heads/*:refs/heads/*"]);
  }
  await gitIn(dir, ["config", "remote.origin.url", r.url]);
  await gitIn(dir, ["fetch", "--prune", "--no-tags", "origin"]);
  return dir;
}
