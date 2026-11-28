// `kind: git`: new commits on a repos.yaml repo. 03 ※: `git ls-remote` for the branch tips, then a shallow fetch of only
// the branches that moved into a small scratch repo in the source's own dir — no bare mirror to keep in sync any more.
// First poll = baseline (tips remembered, nothing comes in).
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { reposConf } from "../config/load.ts";
import type { Poll, SourceItem } from "./types.ts";

const DEPTH = 100;
const MAX_ITEMS = 100;

/** a url with any user:password@ taken out, for messages and links */
export const stripCreds = (s: string) => s.replace(/(\w+:\/\/)[^@/\s]+@/g, "$1");

export type Git = (cwd: string | undefined, args: string[]) => Promise<string>;
export const runGit: Git = (cwd, args) => new Promise((ok, bad) => {
  // no prompts: a repo that wants a password fails instead of hanging the poll
  execFile("git", args, { cwd, env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_ASKPASS: "echo" }, maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) =>
    err ? bad(new Error(stripCreds(`git ${args[0]}: ${String(stderr || err.message).trim()}`).slice(0, 400))) : ok(stdout));
});

/** a browsable address for a repo url, without any credentials in it */
export function webOf(url: string): string | undefined {
  const ssh = /^(?:ssh:\/\/)?git@([^:/]+)[:/](.+?)(?:\.git)?\/?$/.exec(url);
  if (ssh) return `https://${ssh[1]}/${ssh[2]}`;
  const h = /^https?:\/\/(?:[^@/]+@)?(.+?)(?:\.git)?\/?$/.exec(url);
  return h ? `https://${h[1]}` : undefined;
}

export function gitPoll(g: Git = runGit): Poll {
  return async (s, st) => {
    const name = String(s.repo ?? "");
    const url = reposConf()[name]?.url;
    if (!url) throw new Error(`repos.yaml 里没有 ${name}`);
    const tips = Object.fromEntries((await g(undefined, ["ls-remote", "--heads", url])).trim().split("\n").filter(Boolean)
      .map((l) => l.split(/\s+/)).filter((x) => x.length === 2).map(([h, ref]) => [ref!.replace(/^refs\/heads\//, ""), h!]));
    const prev: Record<string, string> | null = JSON.parse(st.get("tips") ?? "null");
    if (!prev) { st.set("tips", JSON.stringify(tips)); return { items: [] }; }
    const moved = Object.keys(tips).filter((b) => prev[b] !== tips[b]);
    if (!moved.length) { st.set("tips", JSON.stringify(tips)); return { items: [] }; }
    const dir = join(st.dir, "scratch");
    if (!existsSync(join(dir, ".git"))) await g(undefined, ["init", "-q", dir]);
    await g(dir, ["fetch", "-q", "--no-tags", `--depth=${DEPTH}`, url, ...moved.map((b) => `+refs/heads/${b}:refs/sbot/${b}`)]);
    const known: string[] = [];   // a force-push or a deep jump can leave an old tip outside the shallow history
    for (const h of new Set(Object.values(prev))) { try { await g(dir, ["cat-file", "-e", `${h}^{commit}`]); known.push(h); } catch { /* not here */ } }
    const out = await g(dir, ["log", "--source", "-n", String(MAX_ITEMS), "--format=%H%x1f%S%x1f%an%x1f%ct%x1f%s%x1f%b%x1e",
      ...moved.map((b) => `refs/sbot/${b}`), ...(known.length ? ["--not", ...known] : [])]);
    const web = webOf(url);
    const items: SourceItem[] = out.split("\x1e").map((r) => r.trim()).filter(Boolean).map((r) => {
      const [h, src, who, ct, subject, body] = r.split("\x1f");
      return { id: h!, ts: Number(ct) * 1000, author: who, where: name, link: web ? `${web}/commit/${h}` : undefined,
        text: `[${String(src).replace(/^refs\/sbot\//, "")}] ${subject}${body?.trim() ? `\n${body.trim().slice(0, 600)}` : ""}` };
    }).reverse();
    st.set("tips", JSON.stringify(tips));   // only after the fetch worked: a failed poll looks again next time
    return { items };
  };
}
