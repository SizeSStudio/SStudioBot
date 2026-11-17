// Sentinel (DESIGN §9.2): pure code, no model. Every 5 minutes it checks for things that need the owner and posts a
// fixed-template alert to the admin group. Each alert key re-fires at most every `again` (default 6 h), and a
// recovered condition clears its key so the next failure alerts again.

import { all, one, kvGet, kvSet } from "./db.ts";
import { feishuConf, log, quietConf, P } from "./config.ts";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { localStamp } from "./memory.ts";
import { sendText } from "./cards.ts";
import { userIdentityReady } from "./observer.ts";

const EVERY_MS = 5 * 60_000;
const H = 3600_000;

interface Finding { key: string; text: string; again?: number }

export async function checks(): Promise<Finding[]> {
  const now = Date.now(), out: Finding[] = [];
  // approvals waiting a long time (expiry itself is handled by sweepApprovals)
  const old = all("SELECT id, title, ts, expires_at FROM approvals WHERE status='pending' AND ts < ?", now - 2 * H);
  for (const a of old) out.push({ key: `appr.${a.id}`, again: 24 * H,
    text: `审批 #${a.id}「${a.title ?? ""}」等了 ${Math.round((now - a.ts) / H)} 小时${a.expires_at ? `，${localStamp(a.expires_at).slice(5)} 过期` : ""}。` });
  // stuck conversational runs (workers have their own watchdog in tasks.ts)
  for (const r of all("SELECT id, lane, role, started FROM runs WHERE status='running' AND role!='worker' AND started < ?", now - 20 * 60_000))
    out.push({ key: `run.${r.id}`, text: `一轮对话（${r.role}，${r.lane}）跑了 ${Math.round((now - r.started) / 60_000)} 分钟还没结束，可能卡住了。` });
  for (const t of all("SELECT id, status, last_output_at FROM tasks WHERE status='running' AND COALESCE(last_output_at, started) < ?", now - 20 * 60_000))
    out.push({ key: `task.${t.id}`, text: `任务 #${t.id} 20 分钟没有输出，看门狗没停掉它，需要看一眼。` });
  // outbox: messages that failed or ended in an unknown state in the last day
  const bad = one("SELECT COUNT(*) n FROM outbox WHERE status IN ('failed','unknown') AND ts > ?", now - 24 * H)!.n;
  if (bad) out.push({ key: "outbox.failed", again: 12 * H, text: `过去 24 小时有 ${bad} 条消息没发出去（failed / unknown），控制台或数据库里能看到。` });
  // LLM proxy error rate over 30 minutes
  const u = one("SELECT COUNT(*) n, SUM(CASE WHEN status>=400 THEN 1 ELSE 0 END) bad FROM usage WHERE ts > ?", now - 30 * 60_000)!;
  if (u.n >= 5 && u.bad / u.n > 0.3) out.push({ key: "proxy.errors", again: 2 * H, text: `最近 30 分钟模型调用 ${u.n} 次，失败 ${u.bad} 次（上游或者额度有问题）。` });
  // budget
  const today = localStamp(now).slice(0, 10);
  const midnight = now - (Number(localStamp(now).slice(11, 13)) * 60 + Number(localStamp(now).slice(14, 16))) * 60_000;
  const cost = one("SELECT COALESCE(SUM(cost),0) c FROM usage WHERE ts >= ?", midnight)!.c as number;
  const { budget } = quietConf();
  if (budget > 0 && cost >= budget * 0.8) out.push({ key: `budget.${today}`, again: 24 * H, text: `今天模型花费 $${cost.toFixed(2)}，到了每日预算 $${budget} 的 ${Math.round(cost / budget * 100)}%。` });
  // lark user identity (the observer and sending as the owner need it)
  if (!(await userIdentityReady())) out.push({ key: "lark.user", again: 24 * H, text: "飞书用户授权不在（或过期了）：读群和以你的身份发消息都停着。授权好了这条会自己消失。" });
  // backups: the nightly one (systemd timer, outside the core) and the off-site pull to Size's Mac
  const bo = join(P.home, "backup-out");
  const days = existsSync(bo) ? readdirSync(bo).filter((n) => /^\d{4}-\d{2}-\d{2}$/.test(n)).sort() : [];
  const newest = days.length ? statSync(join(bo, days[days.length - 1])).mtimeMs : 0;
  if (newest && now - newest > 30 * H) out.push({ key: "backup.nightly", again: 24 * H, text: `夜间备份 ${Math.round((now - newest) / H)} 小时没出新的了（上一份 ${days[days.length - 1]}），看下 sbot-backup.service。` });
  const pulled = join(bo, "pulled");
  if (newest && existsSync(pulled) && now - statSync(pulled).mtimeMs > 3 * 24 * H)
    out.push({ key: "backup.offsite", again: 24 * H, text: `Mac 上的异地备份 ${Math.round((now - statSync(pulled).mtimeMs) / (24 * H))} 天没拉了（最后拿到 ${readFileSync(pulled, "utf8").trim()}）。Mac 开着、连着 Tailscale 时它会自己补上。` });
  // jobs that failed last time
  for (const r of all("SELECT k, v FROM kv WHERE k LIKE 'job.%.last'")) {
    const v = JSON.parse(r.v);
    if (v.outcome === "failed") out.push({ key: `${r.k}.${v.at}`, again: 24 * H, text: `定时任务 ${r.k.slice(4, -5)} 上次（${localStamp(v.at).slice(5)}）失败了：${v.err ?? ""}` });
  }
  return out;
}

export class Sentinel {
  private timer?: NodeJS.Timeout;
  start() { this.timer = setInterval(() => void this.tick(), EVERY_MS); setTimeout(() => void this.tick(), 60_000); }
  stop() { clearInterval(this.timer); }

  async tick() {
    try {
      const found = await checks();
      const keys = new Set(found.map((f) => f.key));
      const state: Record<string, number> = JSON.parse(kvGet("sentinel.state") ?? "{}");
      for (const k of Object.keys(state)) if (!keys.has(k)) delete state[k];        // recovered → may alert again later
      const fresh = found.filter((f) => !state[f.key] || Date.now() - state[f.key] > (f.again ?? 6 * H));
      const { admin_chat } = feishuConf();
      if (fresh.length && admin_chat) {
        await sendText(admin_chat, `**🔔 巡检**\n${fresh.map((f) => `- ${f.text}`).join("\n")}`);
        for (const f of fresh) state[f.key] = Date.now();
        log("sentinel", "alerted", { keys: fresh.map((f) => f.key) });
      }
      kvSet("sentinel.state", JSON.stringify(state));
      kvSet("sentinel.findings", JSON.stringify(found.map((f) => ({ key: f.key, text: f.text, since: state[f.key] ?? Date.now() }))));   // console 待办
      kvSet("sentinel.last", String(Date.now()));
    } catch (e: any) { log("sentinel", "tick failed", { err: String(e?.message ?? e).slice(0, 300) }); }
  }
}

