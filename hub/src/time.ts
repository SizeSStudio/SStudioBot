// Local time in my timezone (01 「跨平台」: dates are shown and computed in self.yaml's timezone; env TZ until it is read).
// Ported from core/src/memory.ts (localStamp, localNow) and core/src/timers.ts (parseLocal) so ledgers and timers
// share one copy.
import { TZ } from "./home.ts";

const fmt = new Intl.DateTimeFormat("sv-SE", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false });
/** "2026-11-17 05:12" in my timezone */
export const localStamp = (ms = Date.now()) => fmt.format(new Date(ms)).replace(",", "");

const WEEK = ["日", "一", "二", "三", "四", "五", "六"];
export function localNow(ms = Date.now()) {
  const wd = new Date(new Date(ms).toLocaleString("en-US", { timeZone: TZ })).getDay();
  return `${localStamp(ms)} 周${WEEK[wd]}`;
}

/** wall-clock time in `tz` → epoch ms (subtract the zone's offset at that moment) */
export function wallTime(y: number, mo: number, d: number, h: number, mi: number, tz = TZ) {
  const asUtc = Date.UTC(y, mo - 1, d, h, mi);
  const shown = Date.parse(new Date(asUtc).toLocaleString("sv-SE", { timeZone: tz }).replace(" ", "T") + "Z");
  return asUtc - (shown - asUtc);
}

/** "2026-11-19 15:00" / "2026-11-19T15:00" in my timezone → epoch ms */
export function parseLocal(s: string): number | undefined {
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{1,2}):(\d{2})/.exec(s.trim());
  if (!m) return undefined;
  const t = wallTime(Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4]), Number(m[5]));
  return Number.isNaN(t) ? undefined : t;
}

/** start of today (00:00 local) */
export function localMidnight(ms = Date.now()) {
  const s = localStamp(ms);
  return ms - (Number(s.slice(11, 13)) * 60 + Number(s.slice(14, 16))) * 60_000 - (ms % 60_000);
}
