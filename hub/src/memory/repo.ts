// Per-repo async write queue (03 「memory」 写队列, 10 「设计和代码不一致」 第 8 条). The old core ran git with execFileSync
// from wherever it was (commitIfDirty, editConfig), which blocked the process and let two writers interleave. Here every
// write to a repo goes through one serial queue: the callback edits files, the queue does add + commit, and the next
// write starts only after that. Reads don't queue.
//
//   const { sha, result } = await repoQueue(dir).write((wt) => { …edit files under wt…; return x; }, "msg");
//
// The callback must check everything before it touches a file: if it throws, the queue commits nothing and moves on,
// but files it already wrote stay (the next write would pick them up).
import { execFile } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);
const GIT_ENV = {
  ...process.env, GIT_AUTHOR_NAME: "SStudioBot", GIT_AUTHOR_EMAIL: "sbot@localhost",
  GIT_COMMITTER_NAME: "SStudioBot", GIT_COMMITTER_EMAIL: "sbot@localhost", GIT_TERMINAL_PROMPT: "0",
};

export async function git(dir: string, ...args: string[]): Promise<string> {
  const { stdout } = await exec("git", ["-C", dir, ...args], { env: GIT_ENV, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  return stdout;
}

/** git init -b main if the directory is not a repo yet. */
export async function ensureRepo(dir: string) {
  mkdirSync(dir, { recursive: true });
  if (!existsSync(join(dir, ".git"))) await git(dir, "init", "-q", "-b", "main");
}

export type Message<T> = string | ((result: T) => string | null);
export interface WriteResult<T> { sha: string | null; result: T }

export class RepoQueue {
  readonly dir: string;
  #tail: Promise<unknown> = Promise.resolve();
  constructor(dir: string) { this.dir = dir; }

  /** Run `fn` alone on this repo, then commit whatever it changed. `msg` returning null = don't commit. */
  write<T>(fn: (dir: string) => T | Promise<T>, msg: Message<T>): Promise<WriteResult<T>> {
    const job = this.#tail.then(async () => {
      await ensureRepo(this.dir);
      const result = await fn(this.dir);
      const m = typeof msg === "function" ? msg(result) : msg;
      if (m === null) return { sha: null, result };
      const sha = await this.#commit(m);
      return { sha, result };
    });
    // the queue keeps going after a failed write; the caller still sees the error
    this.#tail = job.catch(() => undefined);
    return job;
  }

  async #commit(message: string): Promise<string | null> {
    if (!(await git(this.dir, "status", "--porcelain")).trim()) return null;
    await git(this.dir, "add", "-A");
    await git(this.dir, "commit", "-q", "-m", message);
    return (await git(this.dir, "rev-parse", "HEAD")).trim();
  }

  /** Resolves once every write queued so far is done (tests, shutdown). */
  idle(): Promise<void> { return this.#tail.then(() => undefined); }
}

const queues = new Map<string, RepoQueue>();
export function repoQueue(dir: string): RepoQueue {
  const k = resolve(dir);
  let q = queues.get(k);
  if (!q) queues.set(k, q = new RepoQueue(k));
  return q;
}
