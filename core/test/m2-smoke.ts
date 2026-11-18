// M2 smoke on the VPS, run as sbot with the live core stopped (workers may only reach the proxy on 7811):
//
//   sudo -u sbot env SBOT_HOME=/srv/data/sbot/m2test SBOT_SECRETS=/srv/sbot/secrets.env node test/m2-smoke.ts
//
// No Feishu: no admin/workbench chat configured, so cards and topic posts are skipped (logged). Checks:
//   1. task with a repo: the worker (sbot-w, sandbox) clones the bundle, commits, asks git_push → waiting_approval,
//      the push is pinned in the mirror and the expert reviewed it
//   2. approve (as the owner) → the core pushes that commit to the demo remote, the worker is resumed, reports, done
//   3. a task_done event lands in the origin lane
//   4. follow-up timer fires into its lane; matters write their page

import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { P, ownerFeishu } from "../src/config.ts";
import { all, one, kvSet } from "../src/db.ts";
import { startProxy } from "../src/proxy.ts";
import { ensureAgentHome } from "../src/memory.ts";
import { hooks, onApprovalClick, getApproval } from "../src/approvals.ts";
import { TaskEngine, startTask, getTask } from "../src/tasks.ts";
import { Scheduler, addFollowup } from "../src/timers.ts";
import { openMatter, noteMatter } from "../src/matters.ts";

const here = dirname(fileURLToPath(import.meta.url));
const ok = (cond: unknown, what: string) => { console.log(`${cond ? "PASS" : "FAIL"} ${what}`); if (!cond) process.exitCode = 1; };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(what: string, f: () => boolean, ms: number) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { if (f()) return true; await sleep(1000); }
  console.log(`  (timed out waiting for ${what})`);
  return false;
}

for (const d of [P.sessions, P.logs]) mkdirSync(d, { recursive: true });
ensureAgentHome(join(here, "..", "seed", "agent-home"));
mkdirSync(join(P.agentHome, "matters"), { recursive: true });

// demo remote: a bare repo with one commit on main
const remote = join(P.home, "demo-remote.git"), seed = join(P.home, "demo-seed");
rmSync(remote, { recursive: true, force: true }); rmSync(seed, { recursive: true, force: true });
const g = (cwd: string, ...a: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...a], { cwd, encoding: "utf8" });
execFileSync("git", ["init", "--bare", "-q", "-b", "main", remote]);
mkdirSync(seed); g(seed, "init", "-q", "-b", "main"); writeFileSync(join(seed, "README.md"), "# demo\n");
g(seed, "add", "."); g(seed, "commit", "-q", "-m", "init"); g(seed, "push", "-q", remote, "main");
writeFileSync(join(P.config, "repos.yaml"), `demo:\n  url: ${remote}\n  branch: main\n`);

// task dirs live outside the test home: start at a random high id so an old run's t1 (progress.md, repo) isn't reused
kvSet("task.seq", String(900_000 + Math.floor(Math.random() * 99_000)));
const proxy = await startProxy();
let kicked = 0;
hooks.kickDispatcher = () => { kicked++; };
const engine = new TaskEngine();
engine.start();

// 1. task → waiting_approval
const id = startTask({
  goal: "在仓库 demo 的 README.md 末尾加一行：hello from sbot。提交后用 git_push 申请推送。推送结果出来后交报告。",
  repo: "demo", originLane: "test:m2", tier: "light", timeoutMin: 15, mode: "sandbox",
});
console.log(`task #${id}`);
await until("waiting_approval", () => ["waiting_approval", "done", "failed", "cancelled"].includes(getTask(id)?.status), 10 * 60_000);
let t = getTask(id)!;
ok(t.status === "waiting_approval", `task waits for approval (${t.status} ${t.error ?? ""})`);
const runRow = one("SELECT * FROM runs WHERE task_id=? ORDER BY started LIMIT 1", id);
if (!t.approval_id) { console.log(`  report: ${t.result_json ?? t.error}`); await engine.stop(5000); proxy.close(); console.log("M2 SMOKE FAILED"); process.exit(1); }
console.log(`  run ${runRow?.id} ${runRow?.status} ${runRow?.stop_reason ?? ""}`);
const a = t.approval_id ? getApproval(t.approval_id) : undefined;
ok(a?.kind === "deferred_tool" && a.status === "pending", `approval #${a?.id} pending (${a?.kind})`);
const target = a ? JSON.parse(a.target_json) : {};
ok(/^sbot\//.test(target.branch ?? "") && /^[0-9a-f]{40}$/.test(target.sha ?? ""), `pinned ${target.branch} @ ${String(target.sha).slice(0, 8)}`);
await until("expert review", () => !!getApproval(a!.id)?.expert_json, 3 * 60_000);
const ex = JSON.parse(getApproval(a!.id)?.expert_json ?? "null");
ok(ex && (ex.verdict || ex.skipped), `expert: ${ex?.verdict ?? ex?.skipped}`);

// 2. approve → core pushes → resume → done
await onApprovalClick({ id: a!.id, v: a!.draft_version, d: "approve" }, ownerFeishu()!);
const ap = getApproval(a!.id)!;
ok(ap.status === "approved" && /^已推送/.test(ap.result ?? ""), `approved: ${ap.result}`);
const pushed = (() => { try { return execFileSync("git", ["--git-dir", remote, "show", `${target.branch}:README.md`], { encoding: "utf8" }); } catch { return ""; } })();
ok(/hello from sbot/.test(pushed), "remote branch has the change");
ok(!execFileSync("git", ["--git-dir", remote, "branch", "--list", "main", "-v"], { encoding: "utf8" }).includes(target.sha.slice(0, 7)), "main untouched");
await until("task done", () => ["done", "failed", "cancelled"].includes(getTask(id)?.status), 10 * 60_000);
t = getTask(id)!;
ok(t.status === "done", `task done (${t.status} ${t.error ?? ""})`);
const report = JSON.parse(t.result_json ?? "{}");
console.log(`  report: ${String(report.conclusion ?? "").slice(0, 200)}`);
ok(all("SELECT * FROM approvals WHERE task_id=?", id).length === 1, "pushed once, no second approval");

// 3. task_done event in the origin lane
const ev = one("SELECT * FROM inbox WHERE lane='test:m2' AND kind='task' ORDER BY id DESC");
ok(ev && /完成/.test(JSON.parse(ev.payload_json).text) && kicked > 0, "task_done event queued + dispatcher kicked");
const u = one("SELECT COUNT(*) n, SUM(output_tokens) o, SUM(cost) c FROM usage WHERE run_id LIKE ?", `tr_${id}_%`)!;
console.log(`  worker usage: ${u.n} calls, out ${u.o}, $${Number(u.c ?? 0).toFixed(4)}`);

// 4. follow-up + matter
const fu = addFollowup({ lane: "test:m2", turn: { channel: "feishu", chat_id: "oc_x", surface: "feishu:dm" }, due: Date.now() - 1000, note: "测试提醒", by: "test" });
new Scheduler(() => {}).tick();
ok(one("SELECT * FROM inbox WHERE source='timer' AND source_msg_id LIKE ?", `${fu}:%`), "follow-up fired into its lane");
const m = openMatter({ title: "测试的事", domain: "work", lane: "test:m2" });
noteMatter(m.id, "事实盘点", "已知：这是一个测试", "owner@test");
ok(/已知：这是一个测试/.test(readFileSync(join(P.agentHome, m.rel), "utf8")), `matter page written (${m.rel})`);

await engine.stop(5000);
proxy.close();
console.log(existsSync(t.workdir ?? "") ? `  workdir ${t.workdir}` : "");
console.log(process.exitCode ? "M2 SMOKE FAILED" : "M2 SMOKE OK");
process.exit();
