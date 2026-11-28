// git and gh with the node's own logins (05 「worktree 和 CI」). Never hooks (core.hooksPath=/dev/null: a repo's hooks
// are its code, not ours to run), never --force, branches are never deleted (they may carry a PR ※).
import { spawn } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import type { GitChecksRes } from "../../protocol/node/v1.ts";

export type Run = (cmd: string, args: string[], o: { cwd: string; timeoutMs?: number }) => Promise<{ code: number | null; out: string; err: string }>;

export const run: Run = (cmd, args, o) => new Promise((res) => {
  const p = spawn(cmd, args, { cwd: o.cwd, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GH_PROMPT_DISABLED: "1", NO_COLOR: "1" } });
  const out: Buffer[] = [], err: Buffer[] = [];
  p.stdout.on("data", (b: Buffer) => out.push(b));
  p.stderr.on("data", (b: Buffer) => err.push(b));
  const timer = setTimeout(() => p.kill("SIGKILL"), o.timeoutMs ?? 60_000);
  p.on("error", (e) => { clearTimeout(timer); res({ code: null, out: "", err: e.message }); });
  p.on("close", (code) => { clearTimeout(timer); res({ code, out: Buffer.concat(out).toString("utf8"), err: Buffer.concat(err).toString("utf8") }); });
});

const git = (cwd: string, args: string[], timeoutMs?: number) => run("git", ["-c", "core.hooksPath=/dev/null", ...args], { cwd, ...(timeoutMs ? { timeoutMs } : {}) });

export async function headOf(dir: string): Promise<string | undefined> {
  if (!existsSync(dir)) return undefined;
  const r = await git(dir, ["rev-parse", "HEAD"], 10_000);
  return r.code === 0 ? r.out.trim() : undefined;
}

const TASK = /^t\d{1,15}$/;
const WT = "/.sbot-wt/";

/** `<repo>/.sbot-wt/<task>` on branch `sbot/<task>` (or the one the hub named); an existing one is reused. */
export async function makeWorktree(repo: string, task: string, branch?: string): Promise<{ path: string; repo: string; branch: string }> {
  if (!TASK.test(task)) throw new Error("bad task id");
  const root = realpathSync(resolve(repo));
  const br = branch ?? `sbot/${task}`;
  if (!/^[\w./-]{1,200}$/.test(br) || br.startsWith("-") || br.includes("..")) throw new Error("bad branch name");
  const path = join(root, ".sbot-wt", task);
  if (existsSync(join(path, ".git"))) return { path, repo: root, branch: br };
  // the worktrees stay out of `git status` of the repo itself
  const common = await git(root, ["rev-parse", "--git-common-dir"], 10_000);
  if (common.code !== 0) throw new Error(`不是 git 仓库：${root}`);
  const exclude = join(isAbsolute(common.out.trim()) ? common.out.trim() : join(root, common.out.trim()), "info", "exclude");
  mkdirSync(dirname(exclude), { recursive: true });
  if (!existsSync(exclude) || !readFileSync(exclude, "utf8").split("\n").includes(".sbot-wt/")) appendFileSync(exclude, "\n.sbot-wt/\n");
  const has = (await git(root, ["rev-parse", "--verify", "--quiet", `refs/heads/${br}`], 10_000)).code === 0;
  const r = await git(root, has ? ["worktree", "add", "--", path, br] : ["worktree", "add", "-b", br, "--", path], 120_000);
  if (r.code !== 0) throw new Error(`worktree 建不了：${r.err.trim().slice(0, 500)}`);
  return { path, repo: root, branch: br };
}

/** I pressed 清理: only a path of ours, never --force (uncommitted work stops it), the branch stays. */
export async function removeWorktree(path: string): Promise<{ removed: boolean; error?: string }> {
  const p = resolve(path);
  const i = p.indexOf(WT);
  if (i < 0 || !TASK.test(p.slice(i + WT.length))) return { removed: false, error: "不是节点建的 worktree（不在 .sbot-wt/<任务> 下）" };
  if (!existsSync(p)) return { removed: true };
  const r = await git(p.slice(0, i), ["worktree", "remove", "--", p], 60_000);
  return r.code === 0 ? { removed: true } : { removed: false, error: r.err.trim().slice(0, 500) || "git worktree remove 失败" };
}

/** The finished diff of a turn against where the session started (tracked files; untracked ones are listed). */
export async function finalDiff(dir: string, base: string): Promise<{ text: string; stat: string } | undefined> {
  const d = await git(dir, ["diff", "--no-color", "--no-ext-diff", base], 60_000);
  if (d.code !== 0) return undefined;
  const st = await git(dir, ["diff", "--stat", "--no-color", base], 30_000);
  const un = await git(dir, ["ls-files", "--others", "--exclude-standard"], 30_000);
  const added = un.code === 0 ? un.out.split("\n").filter(Boolean) : [];
  const text = d.out + (added.length ? `\n# 新文件（未加入 git）：\n${added.map((f) => `#   ${f}`).join("\n")}\n` : "");
  if (!d.out && !added.length) return undefined;
  return { text, stat: st.out.trim() };
}

const PR_URL = /https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/pull\/(\d+)/;

/** A `gh pr create` the agent ran → its URL in the output. */
export function prFrom(command: string, output: string): { url: string; repo: string; number: number } | undefined {
  if (!/\bgh\s+pr\s+create\b/.test(command)) return undefined;
  const m = PR_URL.exec(output);
  return m ? { url: m[0], repo: m[1]!, number: Number(m[2]) } : undefined;
}

const FAILED_LOG_MAX = 20_000;

/** One CI look with gh (05). gh's exit code says pending (8) or failing (1) and still prints the JSON. */
export async function prChecks(pr: string, cwd: string, r: Run = run): Promise<GitChecksRes> {
  if (!/^(https:\/\/\S+|\d+)$/.test(pr)) throw new Error("bad pr");
  const view = await r("gh", ["pr", "view", pr, "--json", "state,headRefOid"], { cwd, timeoutMs: 60_000 });
  if (view.code !== 0) throw new Error(`gh pr view 失败：${view.err.trim().slice(0, 300)}`);
  const v = JSON.parse(view.out) as { state?: string; headRefOid?: string };
  const ch = await r("gh", ["pr", "checks", pr, "--json", "name,state,bucket,link"], { cwd, timeoutMs: 60_000 });
  let list: { name: string; state: string; bucket?: string; link?: string }[] = [];
  try { list = JSON.parse(ch.out || "[]"); } catch { list = []; }
  const checks = list.map((c) => ({ name: String(c.name), state: String(c.bucket ?? c.state).toLowerCase(), ...(c.link ? { link: String(c.link) } : {}) }));
  const ci = !checks.length ? "none" : checks.some((c) => c.state === "fail" || c.state === "failure") ? "red"
    : checks.some((c) => c.state === "pending" || c.state === "queued" || c.state === "in_progress") ? "pending" : "green";
  let failed_log: string | undefined;
  if (ci === "red") {
    const runs = new Set(checks.filter((c) => c.state === "fail" || c.state === "failure").flatMap((c) => /\/actions\/runs\/(\d+)/.exec(c.link ?? "")?.[1] ?? []));
    const logs: string[] = [];
    for (const id of [...runs].slice(0, 3)) {
      const l = await r("gh", ["run", "view", id, "--log-failed"], { cwd, timeoutMs: 120_000 });
      if (l.code === 0) logs.push(l.out);
    }
    if (logs.length) failed_log = logs.join("\n").slice(-FAILED_LOG_MAX);
  }
  return { state: String(v.state ?? "open").toLowerCase(), ci, ...(v.headRefOid ? { head_sha: v.headRefOid } : {}), checks, ...(failed_log ? { failed_log } : {}) };
}
