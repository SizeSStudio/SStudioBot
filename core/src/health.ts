// Weekly 办事体检 card (DESIGN §14 M3, §16): metrics only, computed by code from the signals and tables; no model, no
// proposals (those come with M7). Several numbers side by side on purpose (§16.5): approval rate alone would reward
// timid, empty drafts.

import { all, one, kvGet } from "./db.ts";
import { feishuConf, log } from "./config.ts";
import { localStamp } from "./memory.ts";
import { sendText } from "./cards.ts";

const DAY = 86400_000;

/** the 体检 numbers for [from, to); improve_review (M7) compares two of these around a change */
export function metricsWindow(from: number, to: number) {
  const sig = (kind: string) => one("SELECT COUNT(*) n FROM signals WHERE kind=? AND ts>=? AND ts<?", kind, from, to)!.n as number;
  const days: string[] = [];
  for (let t = from; t < to; t += DAY) days.push(localStamp(t).slice(0, 10));
  const kvSum = (prefix: string) => days.reduce((s, d) => s + Number(kvGet(`${prefix}.${d}`) ?? 0), 0);
  const triage = Object.fromEntries(all("SELECT CASE WHEN attn IN ('answered','read') THEN attn ELSE COALESCE(triage_action,'none') END a, COUNT(*) n FROM messages WHERE surface='feishu:group' AND ts>=? AND ts<? GROUP BY 1", from, to).map((r) => [r.a, r.n]));
  // 漏: he wrote in a group within 2 h after a message Triage had filed as ignore / archive, with nothing raised in between
  const missed = one(`SELECT COUNT(*) n FROM messages o WHERE o.surface='feishu:group' AND o.sender_kind='owner' AND o.ts>=? AND o.ts<?
    AND EXISTS (SELECT 1 FROM messages p WHERE p.chat_id=o.chat_id AND p.sender_kind='other' AND p.ts<o.ts AND p.ts>=o.ts-7200000 AND p.triage_action IN ('ignore','archive'))
    AND NOT EXISTS (SELECT 1 FROM messages q WHERE q.chat_id=o.chat_id AND q.ts<o.ts AND q.ts>=o.ts-7200000 AND q.triage_action IN ('notify','notified','draft','escalate'))`, from, to)!.n as number;
  // flushNotices turns notify into notified once the batch went out; both are "raised to him"
  triage.notify = Number(triage.notify ?? 0) + Number(triage.notified ?? 0);
  const rounds = one("SELECT AVG(draft_version-1) r, COUNT(*) n FROM approvals WHERE kind='send' AND status='approved' AND decided_at>=? AND decided_at<?", from, to)!;
  const tasks = Object.fromEntries(all("SELECT status, COUNT(*) n FROM tasks WHERE ended>=? AND ended<? GROUP BY status", from, to).map((r) => [r.status, r.n]));
  const cost = all("SELECT COALESCE(requester_id,'?') who, SUM(cost) c, COUNT(*) n FROM usage WHERE ts>=? AND ts<? GROUP BY 1 ORDER BY c DESC", from, to);
  return {
    approved: sig("draft_approved"), revised: sig("draft_revised"), rejected: sig("draft_rejected"), mine: sig("replied_myself"),
    expired: one("SELECT COUNT(*) n FROM approvals WHERE kind='send' AND status='expired' AND COALESCE(decided_at, ts)>=? AND COALESCE(decided_at, ts)<?", from, to)!.n as number,
    rounds: Number(rounds.r ?? 0), triage, missed,
    tasksDone: tasks.done ?? 0, tasksFailed: tasks.failed ?? 0, taskReplies: sig("task_reply"),
    pushes: sig("push_done"), pushFailed: sig("push_failed"),
    proactive: kvSum("proactive"), expert: kvSum("expert.used"),
    failedRuns: one("SELECT COUNT(*) n FROM runs WHERE status='failed' AND started>=? AND started<?", from, to)!.n as number,
    reviews: Object.fromEntries(all("SELECT status, COUNT(*) n FROM reviews WHERE ts>=? AND ts<? GROUP BY status", from, to).map((r) => [r.status, r.n])),
    cost, total: cost.reduce((s, r) => s + Number(r.c ?? 0), 0),
  };
}

export function healthText(now = Date.now()): string {
  const cur = metricsWindow(now - 7 * DAY, now), prev = metricsWindow(now - 14 * DAY, now - 7 * DAY);
  const v = (a: number, b: number, money = false) => `${money ? `$${a.toFixed(2)}` : a}<font color='grey'>（上周 ${money ? `$${b.toFixed(2)}` : b}）</font>`;
  const drafts = cur.approved + cur.revised + cur.rejected + cur.mine + cur.expired;
  const t = (o: Record<string, number>, k: string) => Number(o[k] ?? 0);
  return [
    `**办事体检** · ${localStamp(now - 7 * DAY).slice(5, 10)} ~ ${localStamp(now).slice(5, 10)}`,
    `<font color='grey'>只有指标，不出提案；几个数一起看，最后以你批不批为准（§16.5）。</font>`,
    `**起草**（共 ${drafts}）\n- 原样批准 ${v(cur.approved, prev.approved)}\n- 改了再批 ${v(cur.revised, prev.revised)}，批准的平均改 ${cur.rounds.toFixed(1)} 轮\n- 拒绝 ${v(cur.rejected, prev.rejected)}\n- 你自己回了（草稿作废）${v(cur.mine, prev.mine)}\n- 过期没理 ${v(cur.expired, prev.expired)}`,
    `**分拣**\n- 提醒你 ${v(t(cur.triage, "notify"), t(prev.triage, "notify"))}，起草 ${v(t(cur.triage, "draft"), t(prev.triage, "draft"))}，急事 ${v(t(cur.triage, "escalate"), t(prev.triage, "escalate"))}\n- 归档 / 忽略 ${v(t(cur.triage, "archive") + t(cur.triage, "ignore"), t(prev.triage, "archive") + t(prev.triage, "ignore"))}\n- 可能漏了（判成归档 / 忽略后 2 小时内你自己在群里说话）${v(cur.missed, prev.missed)}`,
    `**任务**\n- 完成 ${v(cur.tasksDone, prev.tasksDone)}，失败 ${v(cur.tasksFailed, prev.tasksFailed)}\n- 你中途回话 ${v(cur.taskReplies, prev.taskReplies)}；推送成功 ${cur.pushes}、失败 ${cur.pushFailed}`,
    `**其他**\n- 主动消息 ${v(cur.proactive, prev.proactive)}；专家 ${v(cur.expert, prev.expert)}；出错的 run ${v(cur.failedRuns, prev.failedRuns)}\n- 复盘：聊了 ${t(cur.reviews, "chatted")}，未聊 ${t(cur.reviews, "unchatted")}`,
    `**花费** ${v(cur.total, prev.total, true)}\n${cur.cost.slice(0, 6).map((r) => `- ${r.who}：$${Number(r.c ?? 0).toFixed(2)}（${r.n} 次调用）`).join("\n") || "- （无）"}`,
  ].join("\n\n");
}

export async function postHealthCard() {
  const { admin_chat } = feishuConf();
  if (!admin_chat) { log("health", "no admin chat"); return; }
  await sendText(admin_chat, healthText());
  log("health", "card sent");
}
