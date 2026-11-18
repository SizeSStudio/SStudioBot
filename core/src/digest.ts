// Proactive messages (DESIGN §9.3 先安静) and the morning report's facts (§9.1).
//
// A run is proactive when nothing in it was typed by a person: timers, task notices, system events. Each proactive
// run that says something counts against gate.yaml proactive_daily_cap (default 6). Once the cap is reached, further
// quota-counted events are not run: they are held and merged into the next morning report. Events that come from
// jobs with quota:false (the morning report itself, reviews and outlooks later) never count.

import { all, one, run, kvGet, kvSet } from "./db.ts";
import { matterReviewConf, quietConf, log } from "./config.ts";
import { localNow, localStamp } from "./memory.ts";
import { dreamDiffText } from "./dream.ts";
import { morningOutlookText } from "./reflect.ts";
import { eventsMorningText, takeHeldNotices } from "./events.ts";
import { MAIN_OPEN, OPEN_MATTER } from "./matters.ts";

const day = () => localStamp().slice(0, 10);
export const proactiveToday = () => Number(kvGet(`proactive.${day()}`) ?? 0);
export const countProactive = () => kvSet(`proactive.${day()}`, String(proactiveToday() + 1));

/** proactive and counted against the cap: every row is a non-user event and at least one is marked quota */
export function isQuotaRun(rows: Record<string, any>[]) {
  if (!rows.length || rows.some((r) => r.kind === "user" || (r.kind === "task" && String(r.source_msg_id).endsWith(":ask")))) return false;
  // a task asking the owner something is never held back; finished/failed notices are
  return rows.some((r) => (r.kind === "task" && !String(r.source_msg_id).endsWith(":ask")) || JSON.parse(r.payload_json ?? "{}").quota === true);
}
export const isProactive = (rows: Record<string, any>[]) => rows.length > 0 && rows.every((r) => r.kind !== "user");

/** Over the cap: park the rows' texts for the morning report and mark them dropped. Returns true if held. */
export function holdIfOverCap(rows: Record<string, any>[]): boolean {
  if (!isQuotaRun(rows)) return false;
  const { cap } = quietConf();
  if (proactiveToday() < cap) return false;
  const held: { ts: number; text: string }[] = JSON.parse(kvGet("quiet.held") ?? "[]");
  for (const r of rows) held.push({ ts: r.ts, text: String(JSON.parse(r.payload_json ?? "{}").text ?? "").slice(0, 600) });
  kvSet("quiet.held", JSON.stringify(held.slice(-30)));
  run(`UPDATE inbox SET status='dropped' WHERE id IN (${rows.map(() => "?").join(",")})`, ...rows.map((r) => r.id));
  log("quiet", "held for the morning report", { n: rows.length, cap });
  return true;
}

/** The facts the main agent turns into the morning report; it clears the held list. */
export function morningText(): string {
  const now = Date.now();
  const startOfDay = now - (Number(localStamp(now).slice(11, 13)) * 60 + Number(localStamp(now).slice(14, 16))) * 60_000;
  const appr = all("SELECT id, title, ts FROM approvals WHERE status='pending' ORDER BY id");
  const tasks = all("SELECT id, status, goal, question FROM tasks WHERE status NOT IN ('done','failed','cancelled') ORDER BY ts");
  const done = all("SELECT id, status, goal FROM tasks WHERE ended>=? AND status IN ('done','failed') ORDER BY ended", now - 86400_000);
  const fus = all("SELECT id, due_at, note FROM timers WHERE kind='followup' AND status='pending' AND due_at < ? ORDER BY due_at", startOfDay + 86400_000);
  const matters = all(`SELECT id, title, status, (SELECT COUNT(*) FROM matters k WHERE k.parent_id=matters.id AND k.${OPEN_MATTER}) kids FROM matters WHERE ${MAIN_OPEN} ORDER BY id`);
  const held: { ts: number; text: string }[] = [...JSON.parse(kvGet("quiet.held") ?? "[]"), ...takeHeldNotices()].slice(-30);
  kvSet("quiet.held", "[]");
  const y = localStamp(now - 86400_000).slice(0, 10);
  const cost = one("SELECT COALESCE(SUM(cost),0) c FROM usage WHERE ts>=? AND ts<?", startOfDay - 86400_000, startOfDay)!.c as number;
  const dream = dreamDiffText();
  const list = (xs: string[]) => xs.length ? xs.map((x) => `- ${x}`).join("\n") : "（无）";
  return `【早报：定时任务。下面是代码整理的事实，请据此给主人发今天的早报】
现在 ${localNow()}

## 等主人批的审批（${appr.length}）
${list(appr.map((a) => `#${a.id} ${a.title ?? ""}（${localStamp(a.ts).slice(5)}）`))}
## 没结束的任务（${tasks.length}）
${list(tasks.map((t) => `#${t.id} ${t.status}：${String(t.goal).slice(0, 60)}${t.question ? `；在问：${String(t.question).slice(0, 80)}` : ""}`))}
## 过去 24 小时结束的任务
${list(done.map((t) => `#${t.id} ${t.status === "done" ? "完成" : "失败"}：${String(t.goal).slice(0, 60)}`))}
## 今天到点的提醒
${list(fus.map((f) => `${localStamp(f.due_at).slice(11)} ${f.note}`))}
## 进行中的事
${list(matters.map((m) => `#${m.id} ${m.title}（${m.status}${m.kids ? `，下面 ${m.kids} 件子事` : ""}）`))}
${eventsMorningText(now - 86400_000)}
## 昨晚记忆整理
${dream ? "有改动，明细已发管理群（可以在那里回滚）" : "没有改动"}
## 被「先安静」压下来的消息（${held.length}）
${list(held.map((h) => `[${localStamp(h.ts).slice(5)}] ${h.text}`))}
## 昨天（${y}）模型花费
$${cost.toFixed(2)}

${morningOutlookText()}

写法：简短，先说要紧的（要主人拍板的、等他回的、今天到点的）；按事说，不按群说；没有就一两句问候带过，不要硬凑。${matterReviewConf().on ? "「事的整理」最多提一句，不要复述内容，也不要替他决定。" : "反复出现的话头只提一句「要不要起个局」，他说要再 matter_open(topic=…)。"}只用上面的事实，不编造。压下来的消息挑仍然要紧的说。今日留意放最后，最多 1 条，没有就不写。`;
}
