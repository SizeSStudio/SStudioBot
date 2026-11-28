// Sentinel (§底4.2, 03 「timers 和 Sentinel」), ported from core/src/sentinel.ts: pure code, no model. Every 5 minutes it
// looks for things that need me and sends one fixed-template alert. Each key re-fires at most every `again` (default
// 6 h); a condition that clears drops its key, so the next failure alerts again.
//
// Changes from core: alerts go through an injected sink (03: push `alert_ops` / `alert_security`; until push lands,
// notify.admin), not a hard-coded Feishu chat; the user-identity probe is injected (it lives in the Feishu plugin);
// the backup check reads backup-staging/ (W1c backup.ts). The off-site pull check waits for backup sync to nodes.
import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { BACKUP_RE } from "../backup.ts";
import { all, kvGet, kvSet, one } from "../db/ambient.ts";
import { home } from "../home.ts";
import { quietConf } from "../ledgers/conf.ts";
import { log } from "../log.ts";
import * as notify from "../notify.ts";
import { localMidnight, localStamp } from "../time.ts";

const EVERY_MS = 5 * 60_000;
const H = 3600_000;

export interface Finding { key: string; text: string; again?: number; cat?: "alert_ops" | "alert_security" }
export type AlertSink = (cat: "alert_ops" | "alert_security", text: string) => void | Promise<void>;

export interface SentinelOpts {
  /** false when the user identity (lark-cli) isn't authorized; omitted = not checked (no Feishu) */
  userReady?: () => Promise<boolean>;
  alert?: AlertSink;
  now?: () => number;
}

export async function checks(o: SentinelOpts = {}): Promise<Finding[]> {
  const now = o.now?.() ?? Date.now(), out: Finding[] = [];
  // approvals waiting a long time (expiry itself belongs to approvals)
  for (const a of all("SELECT id, title, ts, expires_at FROM approvals WHERE status='pending' AND ts < ?", now - 2 * H))
    out.push({ key: `appr.${a.id}`, again: 24 * H,
      text: `审批 #${a.id}「${a.title ?? ""}」等了 ${Math.round((now - a.ts) / H)} 小时${a.expires_at ? `，${localStamp(a.expires_at).slice(5, 16)} 过期` : ""}。` });
  // conversational runs that look stuck (node tasks are watched through tasks.last_output_at)
  for (const r of all("SELECT id, lane, role, started FROM runs WHERE status='running' AND COALESCE(role,'') <> 'task' AND started < ?", now - 20 * 60_000))
    out.push({ key: `run.${r.id}`, text: `一轮对话（${r.role ?? "?"}，${r.lane ?? "?"}）跑了 ${Math.round((now - r.started) / 60_000)} 分钟还没结束，可能卡住了。` });
  for (const t of all("SELECT id FROM tasks WHERE status='running' AND COALESCE(last_output_at, started, ts) < ?", now - 20 * 60_000))
    out.push({ key: `task.${t.id}`, text: `任务 ${t.id} 20 分钟没有回传，需要看一眼。` });
  const bad = Number(one("SELECT COUNT(*) n FROM outbox WHERE status IN ('failed','unknown') AND ts > ?", now - 24 * H)?.n ?? 0);
  if (bad) out.push({ key: "outbox.failed", again: 12 * H, text: `过去 24 小时有 ${bad} 条消息没发出去（failed / unknown）。` });
  // LLM proxy error rate over 30 minutes
  const u = one("SELECT COUNT(*) n, SUM(CASE WHEN status>=400 THEN 1 ELSE 0 END) bad FROM usage WHERE source='proxy' AND ts > ?", now - 30 * 60_000)!;
  if (u.n >= 5 && u.bad / u.n > 0.3) out.push({ key: "proxy.errors", again: 2 * H, text: `最近 30 分钟模型调用 ${u.n} 次，失败 ${u.bad} 次（上游或者额度有问题）。` });
  // budget: alert only, never refuse (限5)
  const cost = Number(one("SELECT COALESCE(SUM(cost),0) c FROM usage WHERE ts >= ?", localMidnight(now))?.c ?? 0);
  const { budget } = quietConf();
  if (budget > 0 && cost >= budget * 0.8)
    out.push({ key: `budget.${localStamp(now).slice(0, 10)}`, again: 24 * H, text: `今天模型花费 $${cost.toFixed(2)}，到了每日预算 $${budget} 的 ${Math.round(cost / budget * 100)}%。` });
  if (o.userReady && !(await o.userReady()))
    out.push({ key: "lark.user", again: 24 * H, cat: "alert_security", text: "飞书用户授权不在（或过期了）：读群和以我的身份发消息都停着。授权好了这条会自己消失。" });
  // the nightly backup (sbot backup, from a timer outside the hub)
  const st = home().staging;
  const files = existsSync(st) ? readdirSync(st).filter((n) => BACKUP_RE.test(n)).sort() : [];
  const newest = files.length ? statSync(join(st, files[files.length - 1]!)).mtimeMs : 0;
  if (newest && now - newest > 30 * H)
    out.push({ key: "backup.nightly", again: 24 * H, text: `夜间备份 ${Math.round((now - newest) / H)} 小时没出新的了（上一份 ${files[files.length - 1]}）。` });
  // code jobs whose last run failed (gave_up already sent its own notice)
  for (const r of all("SELECT k, v FROM kv WHERE k LIKE 'job.%.last'")) {
    let v: any;
    try { v = JSON.parse(r.v); } catch { continue; }
    if (v?.outcome === "failed") out.push({ key: `${r.k}.${v.at}`, again: 24 * H, text: `定时任务 ${String(r.k).slice(4, -5)} 上次（${localStamp(v.at).slice(5, 16)}）失败了：${v.err ?? ""}` });
  }
  return out;
}

export class Sentinel {
  #timer?: NodeJS.Timeout;
  #first?: NodeJS.Timeout;
  #o: SentinelOpts;
  constructor(o: SentinelOpts = {}) { this.#o = o; }

  start() { this.#timer = setInterval(() => void this.tick(), EVERY_MS); this.#first = setTimeout(() => void this.tick(), 60_000); }
  stop() { clearInterval(this.#timer); clearTimeout(this.#first); }

  async tick() {
    try {
      const now = this.#o.now?.() ?? Date.now();
      const found = await checks(this.#o);
      const keys = new Set(found.map((f) => f.key));
      const state: Record<string, number> = JSON.parse(kvGet("sentinel.state") ?? "{}");
      for (const k of Object.keys(state)) if (!keys.has(k)) delete state[k];        // recovered → may alert again later
      const fresh = found.filter((f) => !state[f.key] || now - state[f.key]! > (f.again ?? 6 * H));
      for (const cat of ["alert_security", "alert_ops"] as const) {
        const these = fresh.filter((f) => (f.cat ?? "alert_ops") === cat);
        if (!these.length) continue;
        const text = `**🔔 巡检**\n${these.map((f) => `- ${f.text}`).join("\n")}`;
        try { await (this.#o.alert ? this.#o.alert(cat, text) : notify.admin(text)); }
        catch (e) { log("sentinel", "alert failed", { err: String((e as Error)?.message ?? e).slice(0, 200) }); continue; }
        for (const f of these) state[f.key] = now;
      }
      if (fresh.length) log("sentinel", "alerted", { keys: fresh.map((f) => f.key) });
      kvSet("sentinel.state", JSON.stringify(state));
      // what the console shows as open items
      kvSet("sentinel.findings", JSON.stringify(found.map((f) => ({ key: f.key, text: f.text, since: state[f.key] ?? now }))));
      kvSet("sentinel.last", String(now));
    } catch (e) { log("sentinel", "tick failed", { err: String((e as Error)?.message ?? e).slice(0, 300) }); }
  }
}
