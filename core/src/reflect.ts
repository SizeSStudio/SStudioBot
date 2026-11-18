// 复盘 and 前瞻 as conversations (DESIGN §15.2, §15.5). No separate process: a job (or a matter reaching 收) puts an
// event into the owner's lane with the facts code gathered plus the method from skills/; the main agent opens the
// conversation, and his replies continue it in the same session. These events never count against 先安静 (§15.11).

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { all, one, run } from "./db.ts";
import { P, jobsConf, log, ownerName } from "./config.ts";
import { localNow, localStamp } from "./memory.ts";
import { MAIN_OPEN } from "./matters.ts";
import {
  isoWeek, monthOf, monthStart, noticingsSummary, outlooksText, ownerActivity, selfItemsText, startOfDay, timelineText, today, weekStart,
} from "./life.ts";
import { readingsForReview } from "./lens.ts";

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
function biggerReviewToday(): boolean {
  const wd = new Date(`${today()}T12:00:00Z`).getUTCDay(), md = Number(today().slice(8));
  return Object.values(jobsConf()).some((j) => (j.do === "review_week" && j.every === "week" && Number(j.weekday ?? 0) === wd) || (j.do === "review_month" && j.every === "month" && Number(j.day ?? 1) === md));
}

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

## 进行中的事
${openMatters()}

## 他认可过的习气 / 节律（只在跟今天相关时用；送一程的不提）
${endorsed()}

## 怎么做
日复盘要轻：三五行事实初稿 + 一两个开放问题，然后等他。他没回就算了，不追问；明早之前没聊上，下一轮别补问，直接用 review_submit 记成未聊（period=${today()}）。今天没什么值得聊的，也可以只发一句轻的问候，不硬复盘。

## 方法（skills/review/SKILL.md）
${skill("review")}`;
}

export function reviewWeekText(): string | undefined {
  const now = Date.now(), from = weekStart(now), week = isoWeek(now), next = isoWeek(now + 2 * 86400_000);
  if (one("SELECT 1 FROM reviews WHERE kind='week' AND period=?", week)) return undefined;
  const nextFrom = startOfDay(now) + 86400_000;
  const dayReviews = all("SELECT period, status, owner_words FROM reviews WHERE kind='day' AND ts>=? ORDER BY ts", from)
    .map((r) => `${r.period}：${r.status === "chatted" ? JSON.parse(r.owner_words ?? "[]").join(" / ").slice(0, 200) : "未聊"}`).join("\n") || "（无）";
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

## 镜头：这周到了回看日期的看法（当时写下的原文；拿出来问他结合生活的感受，用 reading_revisit 记他的话；没有就跳过）
${readingsForReview({ from, to: nextFrom })}

## 怎么做
一场对话，分两半：
1. 先回看本周（复盘方法见下），本周前瞻逐条问感受，用 outlook_revisit 记下。聊完 review_submit(kind=week, period=${week})。
2. 再看下周：先问「下周最在意什么」（可以不答），然后给不超过 3 条，outlook_submit(horizon=week, period=${next})。
他不回就不追问；周复盘可以等他到明天，之后记成未聊。

## 复盘方法（skills/review/SKILL.md）
${skill("review")}

## 前瞻方法（skills/outlook/SKILL.md）
${skill("outlook")}`;
}

export function reviewMonthText(): string | undefined {
  const now = Date.now(), thisMonth = monthOf(now);
  const lastStart = monthStart(monthStart(now) - 86400_000), lastMonth = monthOf(lastStart), lastEnd = monthStart(now);
  if (one("SELECT 1 FROM reviews WHERE kind='month' AND period=?", lastMonth)) return undefined;
  const weekReviews = all("SELECT period, status, owner_words, agent_notes FROM reviews WHERE kind IN ('week','matter') AND ts>=? AND ts<? ORDER BY ts", lastStart, lastEnd)
    .map((r) => `${r.period}：${r.status === "chatted" ? JSON.parse(r.owner_words ?? "[]").join(" / ").slice(0, 400) : "未聊"}`).join("\n") || "（无）";
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

## 镜头：本月的看法（今早写下的；只当一种看法，可以在本月前瞻里提一句，标明来自镜头；涉及私人的只写一句提示）
${readingsForReview({ period: thisMonth })}

## 镜头笔记（他以前回看镜头时的感受；决定镜头的话说多少）
${["ziwei", "liuyao"].map((l) => `### ${l}\n${page(`self/lens-notes/${l}.md`, 1500)}`).join("\n")}

## 怎么做
1. 回看上个月：月前瞻逐条问感受（outlook_revisit）；最后问一句「这个月的建议，哪些用上了，哪些没用？」。review_submit(kind=month, period=${lastMonth})。
2. 先问「这个月你想怎么过，最在意什么」，再给不超过 3 条，outlook_submit(horizon=month, period=${thisMonth})。
${quarterly ? `3. 这是季度第一个月：问他要不要把 self/habits.md、self/rhythms.md、self/guidance-notes.md 和风格笔记（style/）过一遍，删掉他不认的（习气用 self_mark 标 dropped；笔记的删改记下来，dream 会处理）。他说不用就不用。\n` : ""}
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
写法：今天确实有值得留意的（今天的事和提醒，加上本周前瞻在今天的落点）才写 1 条「今日留意」，并用 outlook_submit(horizon=day, period=${today(now)}) 记下；没什么就不写。涉及私人节律的只写一句提示。${ownerName()}认可的习气（送一程的不提）：
${endorsed()}`;
}
