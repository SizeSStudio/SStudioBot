// Config helpers the ported ledgers and triage read (10: core's matterReviewConf, waitMinutes, quietConf), on top of
// W1c's typed accessors. Kept next to the ledgers so config/load.ts stays the plain accessor list.
import { gateConf, jobsConf, modelsConf, peopleConf, TIERS, type Tier } from "../config/load.ts";

export const matterReviewConf = () => {
  const j = Object.values(jobsConf()).find((x) => x?.do === "matter_review");
  const n = (v: unknown, d: number) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.floor(v) : d);
  return { on: !!j, limit: n(j?.limit, 5), first_limit: n(j?.first_limit, 12), stale_days: n(j?.stale_days, 30), ask_days: n(j?.ask_days, 7),
    tier: (TIERS as string[]).includes(String(j?.tier)) ? (j!.tier as Tier) : undefined };
};

/** proactive_daily_cap (§寸2) and the daily budget (models.yaml budgets.daily_cost) */
export const quietConf = () => {
  let daily: number | undefined;
  try { daily = modelsConf().budgets?.daily_cost; } catch { /* no models.yaml yet */ }
  return { cap: gateConf().proactive_daily_cap, budget: Number(daily ?? 10) };
};

/**
 * How long a raised message waits for me to respond by myself before it reaches me (§读2.4). places is checked by chat,
 * then source id, then `feishu_dm` for DMs; escalate uses min(escalate, base).
 */
export function waitMinutes(chat: string, surface: string, action: string): number {
  const a = gateConf().attention;
  const ok = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v >= 0;
  const source = surface.startsWith("source:") ? surface.slice(7) : undefined;
  const place = [a.places[chat], source ? a.places[source] : undefined, surface === "feishu:p2p" ? a.places.feishu_dm : undefined].find(ok);
  const base = place ?? a.wait_minutes;
  return action === "escalate" ? Math.min(a.escalate_wait_minutes, base) : base;
}

/** how ledgers name me in text meant for me; never 「主人」 (DESIGN §0 平等的用词) */
export const ownerName = () => peopleConf().owner?.name || "我";
export const ownerFeishu = (): string | undefined => peopleConf().owner?.ids?.feishu;
