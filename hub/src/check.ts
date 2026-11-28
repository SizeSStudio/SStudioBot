// The `check` contract (03 timers, new): a job's `check: <command>` runs on the local node before the model is called.
//   exit 0, empty stdout  → nothing to do: skipped_by_check, no run
//   exit 0, some stdout   → something to do: the stdout goes into the run
//   any other exit        → the script is broken: run anyway with the exit code and stderr's first 2 KB, plus an ops
//                           alert ※ (better one run too many than a broken script silently swallowing the job)
// No time or output limit. timers (W1e) calls runCheck() when a job is due and acts on the outcome.
import type { Db } from "./db/db.ts";
import type { NodeClient } from "./tools/registry.ts";
import { commandGuard } from "./tools/guard.ts";
import * as notify from "./notify.ts";
import { log } from "./log.ts";

export type CheckOutcome =
  | { kind: "skip" }
  | { kind: "run"; stdout: string }
  | { kind: "broken"; code: number | null; signal: string | null; stderr: string };

const STDERR_KEEP = 2048;

export async function runCheck(node: NodeClient, o: { job: string; cmd: string; cwd: string; sbotHome: string }, signal?: AbortSignal): Promise<CheckOutcome> {
  // a check is written by me in jobs.yaml, but it runs where bash runs, so the same guard applies
  const why = commandGuard(o.cmd, { sbotHome: o.sbotHome });
  if (why) return broken(o.job, null, null, why);
  let r;
  try { r = await node.exec({ cmd: o.cmd, cwd: o.cwd }, signal); } catch (e) {
    return broken(o.job, null, null, String((e as Error)?.message ?? e));
  }
  if (r.code === 0) return r.stdout.trim() ? { kind: "run", stdout: r.stdout } : { kind: "skip" };
  return broken(o.job, r.code, r.signal, r.stderr);
}

async function broken(job: string, code: number | null, signal: string | null, stderr: string): Promise<CheckOutcome> {
  const head = Buffer.from(stderr, "utf8").subarray(0, STDERR_KEEP).toString("utf8");
  log("check", "check script failed, running the job anyway", { job, code, signal });
  await notify.admin(`定时任务 ${job} 的 check 脚本坏了（退出码 ${code ?? signal ?? "没跑起来"}），这次照常跑了。stderr 开头：\n${head.slice(0, 500)}`);
  return { kind: "broken", code, signal, stderr: head };
}

/** What the run is told about the check (empty for skip, which never starts a run). */
export function checkText(o: CheckOutcome): string {
  if (o.kind === "run") return `（check 的输出）\n${o.stdout}`;
  if (o.kind === "broken") return `（check 脚本出错了，退出码 ${o.code ?? o.signal ?? "—"}；照常执行这次任务）\nstderr 前 2 KB：\n${o.stderr}`;
  return "";
}

/** Record a skip on the timer row (status skipped_by_check). */
export function markSkipped(db: Db, timerId: number) {
  db.run("UPDATE timers SET status = 'skipped_by_check', fired_at = ? WHERE id = ?", Date.now(), timerId);
}
