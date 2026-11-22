// Birth data rules (DESIGN §读5.1). Pure: no config, no I/O, so schemas.ts, the form and the lens run share one answer.
// ziwei-chart only takes a solar datetime plus gender and longitude, so those decide what "complete" means here.

export interface Birth {
  date: string; time: string; calendar?: "solar" | "lunar"; leap_month?: boolean;
  gender: "male" | "female"; place?: string; longitude: number; timezone?: number;
}

/** for true solar time; picked in the form, or matched by name when only a place is given. tz only when not UTC+8 */
export const CITIES: { name: string; lon: number; tz?: number }[] = [
  { name: "北京", lon: 116.407 }, { name: "上海", lon: 121.474 }, { name: "天津", lon: 117.2 }, { name: "重庆", lon: 106.551 },
  { name: "广州", lon: 113.264 }, { name: "深圳", lon: 114.058 }, { name: "杭州", lon: 120.155 }, { name: "南京", lon: 118.797 },
  { name: "苏州", lon: 120.585 }, { name: "无锡", lon: 120.312 }, { name: "宁波", lon: 121.55 }, { name: "温州", lon: 120.699 },
  { name: "合肥", lon: 117.227 }, { name: "福州", lon: 119.296 }, { name: "厦门", lon: 118.089 }, { name: "南昌", lon: 115.858 },
  { name: "济南", lon: 117.12 }, { name: "青岛", lon: 120.383 }, { name: "郑州", lon: 113.625 }, { name: "武汉", lon: 114.305 },
  { name: "长沙", lon: 112.939 }, { name: "南宁", lon: 108.366 }, { name: "海口", lon: 110.199 }, { name: "成都", lon: 104.066 },
  { name: "贵阳", lon: 106.63 }, { name: "昆明", lon: 102.833 }, { name: "拉萨", lon: 91.141 }, { name: "西安", lon: 108.94 },
  { name: "兰州", lon: 103.834 }, { name: "西宁", lon: 101.778 }, { name: "银川", lon: 106.23 }, { name: "乌鲁木齐", lon: 87.617 },
  { name: "呼和浩特", lon: 111.749 }, { name: "哈尔滨", lon: 126.535 }, { name: "长春", lon: 125.323 }, { name: "沈阳", lon: 123.431 },
  { name: "大连", lon: 121.615 }, { name: "石家庄", lon: 114.515 }, { name: "太原", lon: 112.549 }, { name: "香港", lon: 114.169 },
  { name: "澳门", lon: 113.544 }, { name: "台北", lon: 121.565 }, { name: "新加坡", lon: 103.82 }, { name: "东京", lon: 139.692, tz: 9 },
  { name: "首尔", lon: 126.978, tz: 9 }, { name: "伦敦", lon: -0.128, tz: 0 }, { name: "纽约", lon: -74.006, tz: -5 }, { name: "洛杉矶", lon: -118.244, tz: -8 },
];

const chinese = new Intl.DateTimeFormat("en-u-ca-chinese", { timeZone: "UTC", year: "numeric", month: "numeric", day: "numeric" });

/** lunar → solar "YYYY-MM-DD", undefined when that lunar day does not exist. A lunar year starts Jan 21–Feb 20. */
export function lunarToSolar(year: number, month: number, day: number, leap = false): string | undefined {
  const want = `${month}${leap ? "bis" : ""}`, start = Date.UTC(year, 0, 15);
  for (let i = 0; i < 420; i++) {
    const at = new Date(start + i * 86400_000), p: Record<string, string> = {};
    for (const x of chinese.formatToParts(at)) p[x.type] = x.value;
    if (Number(p.relatedYear) === year && p.month === want && Number(p.day) === day) return at.toISOString().slice(0, 10);
    if (Number(p.relatedYear) > year) return undefined;
  }
  return undefined;
}

function realSolarDate(s: string) {
  const t = Date.parse(`${s}T00:00:00Z`);
  return !Number.isNaN(t) && new Date(t).toISOString().slice(0, 10) === s;
}

/** every problem with a birth block, for the form and the schema; [] means a chart can be built from it */
export function birthIssues(b: any): { path: string; message: string }[] {
  const out: { path: string; message: string }[] = [], bad = (path: string, message: string) => out.push({ path, message });
  const lunar = b?.calendar === "lunar", m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(b?.date ?? ""));
  if (b?.calendar !== undefined && b.calendar !== "solar" && !lunar) bad("calendar", "只能是公历或农历");
  if (!m) bad("date", "日期要写成 1990-05-09");
  else {
    const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
    const solar = lunar ? (y >= 1900 && y <= 2100 ? lunarToSolar(y, mo, d, b.leap_month === true) : undefined) : realSolarDate(b.date) ? b.date as string : undefined;
    if (!solar) bad("date", lunar ? `农历没有这一天：${y} 年${b.leap_month ? "闰" : ""}${mo} 月${d} 日` : "公历没有这一天");
    else if (y < 1900) bad("date", "年份太早，排盘只支持 1900 年以后");
    // one day of slack: the server's UTC date can trail the owner's
    else if (solar > new Date(Date.now() + 86400_000).toISOString().slice(0, 10)) bad("date", "出生日期不能在未来");
  }
  if (b?.leap_month !== undefined && typeof b.leap_month !== "boolean") bad("leap_month", "闰月只能是或否");
  if (b?.leap_month === true && !lunar) bad("leap_month", "只有农历才有闰月");
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(String(b?.time ?? ""))) bad("time", "时间要写成 24 小时制，比如 09:40");
  if (b?.gender !== "male" && b?.gender !== "female") bad("gender", "排盘需要性别");
  if (typeof b?.longitude !== "number" || !Number.isFinite(b.longitude) || Math.abs(b.longitude) > 180) bad("longitude", "真太阳时需要出生地经度（-180 到 180），选城市或直接填");
  if (b?.timezone !== undefined && (!Number.isInteger(b.timezone) || b.timezone < -12 || b.timezone > 14)) bad("timezone", "时区是 -12 到 14 的整数");
  return out;
}

export const birthReady = (b: unknown): b is Birth => !!b && birthIssues(b).length === 0;

/** exactly what ziwei-chart build takes; the lens copies these flags instead of converting anything itself */
export function chartInput(b: Birth) {
  const [y, m, d] = b.date.split("-").map(Number);
  const solar = b.calendar === "lunar" ? lunarToSolar(y, m, d, b.leap_month === true)! : b.date;
  return { datetime: `${solar} ${b.time}`, longitude: b.longitude, gender: b.gender, timezone: b.timezone ?? 8, ...(b.place ? { place: b.place } : {}) };
}
