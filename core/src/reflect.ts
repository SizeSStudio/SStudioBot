// 复盘 and 前瞻 as conversations (DESIGN §15.2, §15.5). No separate process: a job (or a matter reaching 收) puts an
// event into the owner's lane with the facts code gathered plus the method from skills/; the main agent opens the
// conversation, and his replies continue it in the same session. These events never count against 先安静 (§15.11).

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { all, one, run } from "./db.ts";
import { P, jobsConf, log, ownerName, type JobSpec } from "./config.ts";
import { localNow, localStamp } from "./memory.ts";
import { MAIN_OPEN } from "./matters.ts";
import {
  isoWeek, monthOf, monthStart, noticingsSummary, outlooksText, ownerActivity, selfItemsText, startOfDay, submitReview, timelineText, today, weekStart,
} from "./life.ts";
import { readingsForReview } from "./lens.ts";
import { nextDue, OWNER_LANE } from "./timers.ts";

const skill = (name: string) => {
  const f = join(P.agentHome, "skills", name, "SKILL.md");
  return existsSync(f) ? readFileSync(f, "utf8").replace(/^---\n[\s\S]*?\n---\n?/, "").trim() : `（skills/${name}/SKILL.md 不在）`;
};
const page = (rel: string, max = 3000) => {
  const f = join(P.agentHome, rel);
  if (!existsSync(f)) return "（还没有）";
  const s = readFileSync(f, "utf8").replace(/^---\n[\s\S]*?\n---\n?/, "").trim();
  return s.length > max ? s.slice(0, max) + "\n…" : s || "（空）";
};
const openMatters = () => all(`SELECT id, title, status, close_condition FROM matters WHERE ${MAIN_OPEN} ORDER BY id`)
  .map((m) => `#${m.id} ${m.title}（${m.status}${m.close_condition ? `；收：${m.close_condition}` : ""}）`).join("\n") || "（无）";
const followupsBetween = (from: number, to: number) => all("SELECT due_at, note, matter_id FROM timers WHERE kind='followup' AND status='pending' AND due_at>=? AND due_at<? ORDER BY due_at", from, to)
  .map((t) => `${localStamp(t.due_at).slice(5, 16)} ${t.note}${t.matter_id ? `（事 #${t.matter_id}）` : ""}`).join("\n") || "（无）";
const endorsed = () => selfItemsText({ statuses: ["endorsed"] });
const seeingOff = () => selfItemsText({ statuses: ["seeing_off"] });

/** a week / month review job is due today, so the day review folds into it */
function biggerReviewToday(at = Date.now()): boolean {
  const wd = new Date(`${today(at)}T12:00:00Z`).getUTCDay(), md = Number(today(at).slice(8));
  return Object.values(jobsConf()).some((j) => (j.do === "review_week" && j.every === "week" && Number(j.weekday ?? 0) === wd) || (j.do === "review_month" && j.every === "month" && Number(j.day ?? 1) === md));
}

const unchattedLabel = (r: Record<string, any>) => (r.delivery === "not_sent" ? "没发出" : "未聊");

const header = (what: string) => `【${what}：定时任务，不是他打的字。下面是代码整理的事实和方法，请据此开一场对话】\n现在 ${localNow()}`;

export function reviewDayText(): string | undefined {
  if (biggerReviewToday()) { log("reflect", "day review folded into the week/month review"); return undefined; }
  const from = startOfDay(), now = Date.now();
  if (one("SELECT 1 FROM reviews WHERE kind='day' AND period=?", today())) return undefined;
  if (!ownerActivity(from, now)) { log("reflect", "quiet day, no day review"); return undefined; }
  return `${header("日复盘")}

## 今天的时间线
${timelineText({ from, to: now, limit: 150 }, 160)}

## 今天早上的「今日留意」
${outlooksText("day", today())}

## 镜头：今天的一卦（早上写下的原文；他有兴致就问一句今天有没有感应，用 reading_revisit 记他的话，不打分；没有就跳过）
${readingsForReview({ period: today() })}

## 进行中的事
${openMatters()}

## 他认可过的习气 / 节律（只在跟今天相关时用；送一程的不提）
${endorsed()}

## 怎么做
日复盘要轻：三五行事实初稿 + 一两个开放问题，然后等他。他没回就算了，不追问，下一轮也别补问；明早之前没聊上，代码会自己记成未聊，你不用记。聊了就用 review_submit（period=${today()}）。今天没什么值得聊的，也可以只发一句轻的问候，不硬复盘。

## 方法（skills/review/SKILL.md）
${skill("review")}`;
}

export function reviewWeekText(): string | undefined {
  const now = Date.now(), from = weekStart(now), week = isoWeek(now), next = isoWeek(now + 2 * 86400_000);
  if (one("SELECT 1 FROM reviews WHERE kind='week' AND period=?", week)) return undefined;
  const nextFrom = startOfDay(now) + 86400_000;
  const dayReviews = all("SELECT period, status, owner_words, delivery FROM reviews WHERE kind='day' AND ts>=? ORDER BY ts", from)
    .map((r) => `${r.period}：${r.status === "chatted" ? JSON.parse(r.owner_words ?? "[]").join(" / ").slice(0, 200) : unchattedLabel(r)}`).join("\n") || "（无）";
  return `${header(`周复盘 + 下周前瞻（本周 ${week}，下周 ${next}）`)}

## 本周的时间线
${timelineText({ from, to: now, limit: 250 }, 120)}

## 本周开头写下的前瞻（回看用，带编号）
${outlooksText("week", week)}

## 本月的前瞻（下周的建议要说清它在月前瞻里的落点）
${outlooksText("month", monthOf(now))}

## 这周的日复盘
${dayReviews}

## 进行中的事
${openMatters()}

## 下周到点的提醒
${followupsBetween(nextFrom, nextFrom + 7 * 86400_000)}

## 他认可过的习气 / 节律
${endorsed()}
送一程（不主动提）：
${seeingOff()}

## 建议心得（self/guidance-notes.md：哪种建议对他有用）
${page("self/guidance-notes.md", 2000)}

## 谁先看见（镜子，不是 KPI；不用每次都说）
${noticingsSummary(from, now)}

## 镜头：这周的看法，和这周到了回看日期的看法（当时写下的原文；拿出来问他结合生活的感受，用 reading_revisit 记他的话；没有就跳过）
${readingsForReview({ period: week, from, to: nextFrom })}

## 镜头：下周一卦（今晚写下的；直接给他看，可以在下周前瞻里提，标明来自镜头；没有就跳过）
${readingsForReview({ period: next })}

## 怎么做
一场对话，分两半：
1. 先回看本周（复盘方法见下），本周前瞻逐条问感受，用 outlook_revisit 记下。聊完 review_submit(kind=week, period=${week})。
2. 再看下周：先问「下周最在意什么」（可以不答），然后给不超过 3 条，outlook_submit(horizon=week, period=${next})。
他不回就不追问；周复盘可以等他到明天这个时候，之后代码会自己记成未聊，你不用记。

## 复盘方法（skills/review/SKILL.md）
${skill("review")}

## 前瞻方法（skills/outlook/SKILL.md）
${skill("outlook")}`;
}

export function reviewMonthText(): string | undefined {
  const now = Date.now(), thisMonth = monthOf(now);
  const lastStart = monthStart(monthStart(now) - 86400_000), lastMonth = monthOf(lastStart), lastEnd = monthStart(now);
  if (one("SELECT 1 FROM reviews WHERE kind='month' AND period=?", lastMonth)) return undefined;
  const weekReviews = all("SELECT period, status, owner_words, agent_notes, delivery FROM reviews WHERE kind IN ('week','matter') AND ts>=? AND ts<? ORDER BY ts", lastStart, lastEnd)
    .map((r) => `${r.period}：${r.status === "chatted" ? JSON.parse(r.owner_words ?? "[]").join(" / ").slice(0, 400) : unchattedLabel(r)}`).join("\n") || "（无）";
  const quarterly = ["01", "04", "07", "10"].includes(thisMonth.slice(5));
  return `${header(`月复盘 + 本月前瞻（回看 ${lastMonth}，前瞻 ${thisMonth}）`)}

## 上个月的大事（事、随手记、审批；完整时间线用 timeline_query 按需查）
${timelineText({ from: lastStart, to: lastEnd - 1, kinds: ["matter", "note", "review", "revisit"], limit: 200 }, 140)}

## 上个月的周复盘和事收复盘（他的原话）
${weekReviews}

## 上个月写下的月前瞻（回看用）
${outlooksText("month", lastMonth)}

## 进行中的事
${openMatters()}

## 本月到点的提醒
${followupsBetween(now, monthStart(now + 32 * 86400_000))}

## 他认可过的习气 / 节律
${endorsed()}
送一程（不主动提）：
${seeingOff()}

## 建议心得（self/guidance-notes.md）
${page("self/guidance-notes.md", 3000)}

## 谁先看见（月复盘里可以说一句）
${noticingsSummary(lastStart, lastEnd)}

## 镜头：上个月的看法（回看用；当时写下的原文，问他感受，reading_revisit 记他的话，不替他下结论，不打分）
${readingsForReview({ period: lastMonth, from: lastStart, to: lastEnd })}

## 镜头：本月的看法（今早写下的；有几门就有几条；直接给他看，只当一种看法，可以在本月前瞻里提，标明来自镜头）
${readingsForReview({ period: thisMonth })}

## 镜头笔记（他以前回看镜头时的感受；决定镜头的话说多少）
${["ziwei", "liuyao"].map((l) => `### ${l}\n${page(`self/lens-notes/${l}.md`, 1500)}`).join("\n")}

## 怎么做
1. 回看上个月：月前瞻逐条问感受（outlook_revisit）；最后问一句「这个月的建议，哪些用上了，哪些没用？」。review_submit(kind=month, period=${lastMonth})。
2. 先问「这个月你想怎么过，最在意什么」，再给不超过 3 条，outlook_submit(horizon=month, period=${thisMonth})。
${quarterly ? `3. 这是季度第一个月：问他要不要把 self/habits.md、self/rhythms.md、self/guidance-notes.md 和风格笔记（style/）过一遍，删掉他不认的（习气用 self_mark 标 dropped；笔记的删改记下来，dream 会处理）。他说不用就不用。
   现在「淡了」的习气 / 节律（很久没有新证据，已经不再引用）：
${selfItemsText({ statuses: ["faded"] }).replace(/^/gm, "   ")}
   有的话一并列给他：他说「还在」用 self_mark 改回 endorsed，说「放下」改成 let_go，不管就不动。（§15.15）\n` : ""}
## 复盘方法（skills/review/SKILL.md）
${skill("review")}

## 前瞻方法（skills/outlook/SKILL.md）
${skill("outlook")}`;
}

/** 事收 (§15.5): queued into the matter's own lane when it reaches 收 */
export function queueMatterReview(id: number) {
  const m = one("SELECT * FROM matters WHERE id=?", id);
  if (!m?.lane) return;
  const turn = one("SELECT turn_ctx_json FROM inbox WHERE lane=? AND turn_ctx_json IS NOT NULL ORDER BY id DESC LIMIT 1", m.lane)?.turn_ctx_json;
  const text = `${header(`事收复盘：事 #${id}「${m.title}」`)}

## 事的页面（${m.file_path}：发心、方向、过程都在这里）
${page(m.file_path ?? `matters/${id}.md`, 6000)}

## 这件事的时间线
${timelineText({ from: m.opened_at ?? 0, to: Date.now(), matter: id, limit: 200 }, 200)}

## 起局时写下的前瞻
${outlooksText("matter", `matter:${id}`)}

## 镜头：这件事的看法（起局时写下的原文；问他现在回头看有什么感觉，reading_revisit 记他的话）
${readingsForReview({ matterId: id })}

## 他认可过的习气 / 节律（挑跟这件事相关的，送一程的不提）
${endorsed()}

## 怎么做
事收可以深一点：先给经过的事实初稿，再对照起局时他说的发心问结果和发心之间的距离。聊完 review_submit(kind=matter, period=matter:${id}, matter_id=${id})。他说「这事不用复盘」就记成未聊。

## 方法（skills/review/SKILL.md）
${skill("review")}`;
  run(`INSERT OR IGNORE INTO inbox(lane, kind, source, source_msg_id, turn_ctx_json, payload_json, status, ts) VALUES(?,?,?,?,?,?,?,?)`,
    m.lane, "timer", "matter", `${id}:review`, turn ?? null, JSON.stringify({ text, ts: Date.now(), quota: false }), "received", Date.now());
  log("reflect", "matter review queued", { matter: id, lane: m.lane });
}

// ───────────── 未聊 is written by code (§15.5) ─────────────

const REVIEW_JOBS: Record<string, "day" | "week" | "month"> = { review_day: "day", review_week: "week", review_month: "month" };
const FACTS_MAX = 6000;

/** what this firing of a review job covers, and when it stops waiting for him; undefined = no review is due */
export function reviewPlan(kind: "day" | "week" | "month", at = Date.now()) {
  const tomorrow = at + 86400_000;
  let period: string, facts: string, deadline = tomorrow;
  if (kind === "day") {
    const from = startOfDay(at);
    if (biggerReviewToday(at) || !ownerActivity(from, at)) return undefined;
    period = today(at);
    facts = timelineText({ from, to: at, limit: 150 }, 160);
    const morning = Object.values(jobsConf()).find((j) => j?.do === "morning");
    deadline = (morning && nextDue(morning, at)) || tomorrow;
  } else if (kind === "week") {
    period = isoWeek(at);
    facts = timelineText({ from: weekStart(at), to: at, limit: 250 }, 120);
  } else {
    const lastStart = monthStart(monthStart(at) - 86400_000);
    period = monthOf(lastStart);
    facts = timelineText({ from: lastStart, to: monthStart(at) - 1, kinds: ["matter", "note", "review", "revisit"], limit: 200 }, 140);
  }
  return one("SELECT 1 FROM reviews WHERE kind=? AND period=?", kind, period) ? undefined : { kind, period, facts, deadline };
}

const fileUnchatted = (kind: "day" | "week" | "month", period: string, facts: string, delivery: "sent" | "replied" | "not_sent", deliveryNote: string, runId: string) =>
  submitReview({ kind, period, facts: facts.slice(0, FACTS_MAX), ownerWords: [], noticings: [], questions: [], runId, delivery, deliveryNote });

/** scheduler hook: a review job is going out; start waiting for him. The payload tag ties the run back to this row. */
export function reviewOpened(_name: string, job: JobSpec, key: string) {
  const kind = REVIEW_JOBS[job.do];
  const plan = kind && reviewPlan(kind);
  if (!plan) return undefined;
  run("INSERT OR IGNORE INTO review_open(kind, period, facts, fired_at, deadline, inbox_key) VALUES(?,?,?,?,?,?)", plan.kind, plan.period, plan.facts, Date.now(), plan.deadline, key);
  return { review: { kind: plan.kind, period: plan.period } };
}

/** scheduler hook: the job never went out (core down, previous round stuck, no DM yet); the history keeps no hole */
export function reviewNotRun(_name: string, job: JobSpec, due: number, why: string) {
  const kind = REVIEW_JOBS[job.do];
  const plan = kind && reviewPlan(kind, due);
  if (!plan) return;
  fileUnchatted(plan.kind, plan.period, plan.facts, "not_sent", `这次复盘没发出去：${why}`, "auto:review");
  log("reflect", "review not sent, recorded", { kind: plan.kind, period: plan.period, why });
}

/** dispatcher: this run carried a review event */
export function noteReviewRun(payloads: Record<string, any>[], runId: string) {
  for (const p of payloads) if (p.review) run("UPDATE review_open SET run_id=? WHERE kind=? AND period=?", runId, p.review.kind, p.review.period);
}

function closeReview(o: Record<string, any>): boolean {
  const ev = o.inbox_key ? one("SELECT lane, status FROM inbox WHERE source='job' AND source_msg_id=?", o.inbox_key) : undefined;
  if (ev && ["received", "processing"].includes(ev.status)) return false;   // still on its way
  let filed = false;
  if (!one("SELECT 1 FROM reviews WHERE kind=? AND period=?", o.kind, o.period)) {
    const r = o.run_id ? one("SELECT status, ended FROM runs WHERE id=?", o.run_id) : undefined;
    const said = r?.status === "done" ? all("SELECT payload FROM outbox WHERE run_id=? AND status='sent' ORDER BY id", o.run_id).map((x) => String(x.payload)) : [];
    const id = `auto:review:${o.kind}:${o.period}`;
    if (said.length) {
      const replied = one("SELECT 1 FROM messages WHERE lane=? AND sender_kind='owner' AND ts>? AND ts<=? LIMIT 1", ev?.lane ?? OWNER_LANE, r!.ended, o.deadline);
      if (replied) fileUnchatted(o.kind, o.period, said.join("\n\n"), "replied", "发出后他回过话，但这场没有落档；原话在时间线里", id);
      else fileUnchatted(o.kind, o.period, said.join("\n\n"), "sent", "", id);
    } else {
      const why = !ev ? "没有进到会话" : ev.status === "failed" ? "模型调用失败" : ev.status === "dropped" ? "被先安静压下了" : "这一轮没有发出内容";
      fileUnchatted(o.kind, o.period, o.facts ?? "", "not_sent", `这次复盘没发出去：${why}`, id);
    }
    filed = true;
    log("reflect", "review closed by code", { kind: o.kind, period: o.period, sent: said.length > 0 });
  }
  run("DELETE FROM review_open WHERE id=?", o.id);
  return filed;
}

/** Past the deadline with nothing filed: code writes the record. Facts are what he was actually shown, if anything was. */
export function closeDueReviews(now = Date.now()): number {
  let filed = 0;
  for (const o of all("SELECT * FROM review_open WHERE deadline<=?", now)) {
    // one bad row must not hold up the others; it stays and is tried again next tick
    try { if (closeReview(o)) filed++; } catch (e: any) { log("reflect", "could not close review", { kind: o.kind, period: o.period, err: String(e?.message ?? e).slice(0, 300) }); }
  }
  return filed;
}

/** 今日留意 for the morning report (§15.2): the week's and month's outlooks it should nest under */
export function morningOutlookText(): string {
  const now = Date.now();
  return `## 今日留意的依据（前瞻）
本周前瞻（${isoWeek(now)}）：
${outlooksText("week", isoWeek(now))}
本月前瞻（${monthOf(now)}）：
${outlooksText("month", monthOf(now))}
今天已写的今日留意：
${outlooksText("day", today(now))}
写法：今天确实有值得留意的（今天的事和提醒，加上本周前瞻在今天的落点）才写 1 条「今日留意」，并用 outlook_submit(horizon=day, period=${today(now)}) 记下；没什么就不写。${ownerName()}认可的习气（送一程的不提）：
${endorsed()}`;
}
