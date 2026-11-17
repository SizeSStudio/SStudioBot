// SStudioBot core (DESIGN §14). M0: inbox + Dispatcher + pi Runner + tool layer + LLM proxy + Feishu DM + outbox.
// M1: approvals + admin-group cards + observer + Triage/drafts. M2: Task Engine (workers) + follow-up timers + matters.
// M3b: config console on a unix socket behind tailscale serve.
// M3a: wiki index + full-text search, jobs.yaml (morning report, nightly dream + morning diff), sentinel, 先安静.
// M6: lenses in a sealed worker (紫微, 六爻) + 解读账本 (readings, revisits, lens-notes), month view on day 1.
// M3c: 红尘里修: timeline, 随手记, 前瞻, 复盘 (day / week / month / 事收), 习气与节律, 谁先看见, style notes, 办事体检.
// M7: self-improvement: eval cases from his answers, B-level proposals with replay, one card, two-week rollback card.
//
//   SBOT_HOME=/srv/sbot node src/main.ts

import { mkdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { P, ownerFeishu, log } from "./config.ts";
import "./db.ts";
import { startProxy } from "./proxy.ts";
import { ensureAgentHome, git, commitIfDirty } from "./memory.ts";
import { PiRunner } from "./runner.ts";
import { Dispatcher } from "./dispatcher.ts";
import { Outbox } from "./outbox.ts";
import { FeishuAdapter, ingest } from "./feishu.ts";
import { makeCommandHandler } from "./commands.ts";
import { closeOrphanCards } from "./card.ts";
import { hooks, onApprovalSent, sweepApprovals } from "./approvals.ts";
import { Observer } from "./observer.ts";
import { Triage } from "./triage.ts";
import { Scheduler } from "./timers.ts";
import { TaskEngine } from "./tasks.ts";
import { onCardAction, routeGroup } from "./routes.ts";
import { syncPages, rebuildIndex, commitMemory } from "./wiki.ts";
import { runDream, postDreamDiff } from "./dream.ts";
import { morningText } from "./digest.ts";
import { Sentinel } from "./sentinel.ts";
import { startConsole } from "./console.ts";
import { renderSelf } from "./life.ts";
import { reviewDayText, reviewWeekText, reviewMonthText } from "./reflect.ts";
import { postHealthCard } from "./health.ts";
import { LensEngine, queueMonthReadings } from "./lens.ts";
import { installImproveHooks, runImprove, runImproveReview } from "./improve.ts";

const here = dirname(fileURLToPath(import.meta.url));
for (const d of [P.sessions, P.logs, P.larkHome]) mkdirSync(d, { recursive: true });
if (!ownerFeishu()) throw new Error("config/people.yaml: owner.ids.feishu is required");
if (!existsSync(join(P.config, ".git"))) { git(P.config, "init", "-q", "-b", "main"); commitIfDirty(P.config, "initial config"); }
ensureAgentHome(join(here, "..", "seed", "agent-home"));
renderSelf();
syncPages();
if (rebuildIndex()) commitMemory("index");

const proxy = await startProxy();
const runner = new PiRunner();
const outbox = new Outbox(
  (row) => { if (row.approval_id) onApprovalSent(row.approval_id, true); },
  (row, err) => { if (row.approval_id) onApprovalSent(row.approval_id, false, err); },
);
const dispatcher = new Dispatcher(runner, () => outbox.kick());
hooks.kickOutbox = () => outbox.kick();
hooks.kickDispatcher = () => dispatcher.kick();
const tasks = new TaskEngine();          // also takes hooks.onDeferred (approved pushes, resumes)
installImproveHooks();                   // hooks.onTuning / onTuningRevise: proposal and rollback cards (M7)
const lenses = new LensEngine();
const observer = new Observer();
const triage = new Triage(runner);
const scheduler = new Scheduler(() => dispatcher.kick(),
  { dream: async () => { await runDream(runner); }, dream_diff: async () => { await postDreamDiff(); }, health_card: async () => { await postHealthCard(); }, lens_month: async () => { queueMonthReadings(); },
    improve: async (_n, job) => { log("improve", "job", { out: await runImprove(job) }); }, improve_review: async () => { await runImproveReview(); } },
  { morning: () => morningText(), review_day: () => reviewDayText(), review_week: () => reviewWeekText(), review_month: () => reviewMonthText() });
const sentinel = new Sentinel();
const onCommand = makeCommandHandler(dispatcher, () => outbox.kick(), scheduler);
dispatcher.recover();
outbox.start();
closeOrphanCards().catch((e) => log("main", "closeOrphanCards failed", { err: String(e?.message ?? e) }));

const feishu = new FeishuAdapter(
  (m) => {
    const queued = m.chat_type === "p2p" ? ingest(m, (cmd, arg, turn, id) => { void onCommand(cmd, arg, turn, id); }) : routeGroup(m);
    if (queued) dispatcher.kick();
  },
  (ev) => { void onCardAction(ev); },
);
feishu.start();
const consoleSrv = startConsole({ feishu, dispatcher, scheduler, startedAt: Date.now() });
tasks.start();
lenses.start();
observer.start();
triage.start();
scheduler.start();
sentinel.start();
const sweep = setInterval(() => { sweepApprovals().catch((e) => log("main", "approval sweep failed", { err: String(e?.message ?? e) })); }, 60_000);
void sweepApprovals().catch(() => {});
dispatcher.kick();
log("main", "core up", { home: P.home, pid: process.pid });

let quitting = false;
async function shutdown(sig: string) {
  if (quitting) return;
  quitting = true;
  log("main", `${sig}: shutting down`, { busy: dispatcher.busyLanes });
  feishu.stop();
  consoleSrv.close();
  observer.stop(); triage.stop(); scheduler.stop(); sentinel.stop(); lenses.stop(); clearInterval(sweep);
  // unfinished runs are recovered on the next start (§1.2); workers are aborted and resumed after the restart
  await Promise.all([dispatcher.drain(20_000), tasks.stop(10_000)]);
  outbox.stop();
  proxy.close();
  process.exit(0);
}
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("unhandledRejection", (e: any) => log("main", "unhandledRejection", { err: String(e?.stack ?? e).slice(0, 500) }));
