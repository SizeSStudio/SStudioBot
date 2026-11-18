// Birth form, the main agent's self_profile / self_page, routine lens views (DESIGN §15.2, §15.7, §15.9). All data is made up.
//
//   ssh <server> 'bash -s' < test/vps-test-home.sh self-profile-smoke.ts 7829 [--live]
//
// Offline: form validation and save over the console socket, hash conflict, rollback; the tools move profile_version and
// put it back; who is refused (workbench, runs he didn't type, other people); day / week / month 六爻 without birth data,
// 紫微 joining the month once it is filled; 渎则不告 untouched and not in the way; default jobs added once; report texts.
// --live: one real 六爻 day view through the sealed worker, with its cost.

import http from "node:http";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { z } from "zod";

const HOME = process.env.SBOT_HOME ?? "";
if (!HOME || HOME === "/srv/sbot" || !/testhomes|tmp|var\/folders/.test(HOME)) { console.error("run on a throwaway SBOT_HOME (see vps-test-home.sh)"); process.exit(2); }
mkdirSync(join(HOME, "socks"), { recursive: true });
process.env.SBOT_CONSOLE_SOCK = join(HOME, "socks", "console.sock");
// a directory that doesn't exist keeps the public entrance off; the default path is the live core's socket
process.env.SBOT_CONSOLE_WEB_SOCK = join(HOME, "no-web", "console.sock");
delete process.env.SBOT_CONSOLE_PORT;

const { P, jobsConf } = await import("../src/config.ts");
const { all, one, run, kvSet } = await import("../src/db.ts");
const { ensureAgentHome, git, commitIfDirty } = await import("../src/memory.ts");
const { nextDue } = await import("../src/timers.ts");
const { today, monthOf, isoWeek } = await import("../src/life.ts");
const L = await import("../src/lens.ts");
const { TOOLS, callTool, toolsFor } = await import("../src/tools.ts");
const { addDefaultLensJobs } = await import("../src/lens-jobs.ts");
const { lunarToSolar, chartInput, birthIssues } = await import("../src/birth.ts");
const { morningText } = await import("../src/digest.ts");
const { reviewDayText, reviewWeekText, reviewMonthText } = await import("../src/reflect.ts");
const { startConsole } = await import("../src/console.ts");

const here = dirname(fileURLToPath(import.meta.url));
const ok = (cond: unknown, what: string) => { console.log(`${cond ? "PASS" : "FAIL"} ${what}`); if (!cond) process.exitCode = 1; };
for (const d of [P.sessions, P.logs, P.config]) mkdirSync(d, { recursive: true });
ensureAgentHome(join(here, "..", "seed", "agent-home"));
const OWNER = "owner@localhost";
writeFileSync(join(P.config, "console.yaml"), `owners: [${OWNER}]\n`);
try { git(P.config, "init", "-q", "-b", "main"); } catch { /* already */ }
commitIfDirty(P.config, "initial config");
const srv = startConsole({ startedAt: Date.now() } as any);
await new Promise((r) => setTimeout(r, 300));

function api(method: string, path: string, body?: unknown): Promise<{ status: number; json: any }> {
  const data = body === undefined ? undefined : JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const r = http.request({ socketPath: process.env.SBOT_CONSOLE_SOCK, method, path: `/api${path}`, headers: { "tailscale-user-login": OWNER, "x-sbot-console": "1",
      ...(data ? { "content-type": "application/json", "content-length": String(Buffer.byteLength(data)) } : {}) } }, (res) => {
      let t = ""; res.setEncoding("utf8"); res.on("data", (c) => { t += c; }); res.on("end", () => resolve({ status: res.statusCode ?? 0, json: JSON.parse(t || "null") }));
    });
    r.on("error", reject); if (data) r.write(data); r.end();
  });
}
const BIRTH = { date: "1990-05-09", time: "09:40", gender: "female", place: "杭州" };

// ───────── rules ─────────
ok(lunarToSolar(2024, 1, 1) === "2024-02-10", "lunar new year 2024 → 2024-02-10");
ok(lunarToSolar(2023, 2, 1, true) === "2023-03-22", "leap month 2 of 2023 → 2023-03-22");
ok(lunarToSolar(2024, 2, 1, true) === undefined, "a leap month that year doesn't have is refused");
ok(chartInput({ date: "2024-01-01", time: "23:10", calendar: "lunar", gender: "male", longitude: 120 }).datetime === "2024-02-10 23:10", "chart input is solar");
ok(birthIssues({ date: "2024-02-30", time: "25:00", longitude: 999 }).length === 4, "bad date, time, longitude, missing gender all reported");

// ───────── the form, over the console ─────────
let v = (await api("GET", "/life/birth")).json;
ok(v.ready === false && v.birth === null && v.lenses.liuyao.methods.some((m: any) => m.method === "day" && m.runnable), "no birth: not ready, 六爻 day still runnable");
ok(v.lenses.ziwei.methods.find((m: any) => m.method === "month")?.runnable === false, "no birth: 紫微流月 not runnable");
let r = await api("PUT", "/life/birth", { patch: { birth: { ...BIRTH, date: "1990-02-30", time: "9点" } }, hash: v.hash });
ok(r.status === 400 && /birth\.date/.test(r.json.error) && /birth\.time/.test(r.json.error), `bad form refused by field → ${String(r.json.error).split("\n").slice(1, 3).join(" ")}`);
ok(!one("SELECT 1 FROM config_changes WHERE file='self.yaml'"), "a refused form writes nothing");
r = await api("PUT", "/life/birth", { patch: { birth: { date: "1990-05-09", time: "09:40", gender: "female" } }, hash: v.hash });
ok(r.status === 400 && /经度/.test(r.json.error), "no place and no longitude refused");
r = await api("PUT", "/life/birth", { patch: { birth: BIRTH, lenses: { liuyao: { cast: "coins", notes: "多看工作" } } }, hash: v.hash });
ok(r.status === 200 && r.json.ready && r.json.birth.longitude === 120.155 && r.json.chart_input.datetime === "1990-05-09 09:40", "city fills longitude; saved and ready");
ok(r.json.moved.includes("ziwei:month") && r.json.moved.includes("liuyao:day"), "saving moved profile versions");
const subject = git(P.config, "log", "-1", "--format=%s", "--", "self.yaml").trim();
ok(subject === "self.yaml: profile (via console)", `commit subject carries no values → ${subject}`);
ok(one("SELECT source FROM config_changes WHERE file='self.yaml' ORDER BY id DESC")?.source === "console", "logged in config_changes");
const stale = v.hash; v = r.json;
ok((await api("PUT", "/life/birth", { patch: { birth: { time: "10:00" } }, hash: stale })).status === 409, "stale hash → 409, not overwritten");
r = await api("PUT", "/life/birth", { patch: { birth: { ...BIRTH, longitude: 120.155, timezone: null } }, hash: v.hash });
ok(r.status === 200 && r.json.changed === false, "saving the same values changes nothing");
r = await api("PUT", "/life/birth", { patch: { birth: { date: "1990-04-15", calendar: "lunar", leap_month: false } }, hash: v.hash });
ok(r.status === 200 && r.json.chart_input.datetime.startsWith("1990-05-09"), `lunar date converted → ${r.json.chart_input.datetime}`);
const first = r.json.history[1].sha;
r = await api("POST", "/life/birth/rollback", { sha: first, hash: r.json.hash });
ok(r.status === 200 && r.json.birth.calendar === undefined && r.json.moved.includes("ziwei:month"), "console rollback restores the earlier version");
v = r.json;

// ───────── main agent's tools ─────────
const tool = (n: string) => TOOLS.find((t) => t.name === n)!;
const dm = (o: Record<string, unknown> = {}) => ({ runId: "t", lane: "feishu:dm:owner", principal: "owner", turn: { channel: "feishu", chat_id: "oc_fake", surface: "feishu:dm" }, src: "owner@feishu:dm", token: "", replies: 0, ownerTyped: true, ...o }) as any;
const bench = () => dm({ lane: "feishu:wb:1", turn: { channel: "feishu", chat_id: "oc_fake", surface: "feishu:workbench" }, src: "owner@feishu:workbench" });
const call = (n: string, a: unknown, c = dm()) => callTool(tool(n), a, c);
for (const t of toolsFor("owner")) z.toJSONSchema(t.schema);
ok(true, "every owner tool schema converts for the model");

const ver = () => L.profileVersion("ziwei", "month");
const v0 = ver();
ok(/1990-05-09/.test(await call("self_profile", { action: "get" })), "self_profile get shows birth in his DM");
let out = await call("self_profile", { action: "set", birth: { time: "11:20" } });
ok(/改好了/.test(out) && ver() !== v0 && /ziwei:month/.test(out), "self_profile set → new profile_version");
ok(git(P.config, "log", "-1", "--format=%s", "--", "self.yaml").trim() === "self.yaml: profile (via chat)" && one("SELECT source FROM config_changes WHERE file='self.yaml' ORDER BY id DESC")?.source === "chat", "chat change committed and logged");
ok(/error/.test(await call("self_profile", { action: "set", birth: { time: "25:99" } })), "self_profile: invalid value refused");
const prev = git(P.config, "log", "-n", "2", "--format=%h", "--", "self.yaml").trim().split("\n")[1];
out = await call("self_profile", { action: "rollback", sha: prev });
ok(/改好了/.test(out) && ver() === v0, "self_profile rollback → version back");
out = await call("self_profile", { action: "set", lenses: { ziwei: { notes: "少说术语" } } });
ok(ver() !== v0 && L.profileVersion("liuyao", "day") === v.lenses.liuyao.methods.find((m: any) => m.method === "day").version, "lens setting moves only that lens");
await call("self_profile", { action: "set", lenses: { ziwei: { notes: "" } } });
ok(ver() === v0, "clearing the setting returns to the same version");

out = await call("self_page", { action: "write", path: "self/test-note.md", text: "第一版" });
ok(/写好了/.test(out), "self_page writes a page");
await call("self_page", { action: "write", path: "self/test-note.md", text: "追加一行", mode: "append" });
ok(/第一版[\s\S]*追加一行/.test(await call("self_page", { action: "read", path: "self/test-note.md" })), "append + read");
const sha = (await call("self_page", { action: "history", path: "self/test-note.md" })).trim().split("\n").at(-1)!.split(" ")[0];
ok(/回到了版本/.test(await call("self_page", { action: "rollback", path: "self/test-note.md", sha })) && !/追加一行/.test(await call("self_page", { action: "read", path: "self/test-note.md" })), "self_page rollback");
ok(all("SELECT diff FROM config_changes WHERE file='self/test-note.md'").length === 3 && !all("SELECT diff FROM config_changes WHERE file='self/test-note.md'").some((x) => /第一版/.test(x.diff)), "page writes logged without their content");
mkdirSync(join(P.agentHome, "self", "charts", "ziwei", "v1"), { recursive: true });
writeFileSync(join(P.agentHome, "self", "charts", "ziwei", "v1", "README.md"), "虚构盘面\n");
writeFileSync(join(P.agentHome, "self", "charts", "ziwei", "v1", "chart.json"), `{"palace":"${"命".repeat(30_000)}"}`);
out = await call("self_page", { action: "read", path: "self/charts/ziwei/v1/chart.json" });
ok(/offset=20000/.test(out), "a chart that isn't .md is readable, in chunks");
for (const [path, re] of [["self/habits.md", /self_mark/], ["self/charts/ziwei/v1/x.md", /冻结/], ["self/outlooks/x.md", /不改/], ["self/reviews/x.md", /review_submit/], ["self/../SOUL.md", /只能是 self|路径不对/], ["journal/x.md", /只能是 self/]] as const)
  ok(re.test(await call("self_page", { action: "write", path, text: "x" })), `write refused: ${path}`);
ok(!/不在|只在他/.test(await call("memory_read", { path: "self/habits.md" })), "memory_read: whole habits file in his DM");

// who is refused
for (const [name, c] of [["workbench", bench()], ["timer run in the DM", dm({ ownerTyped: false })], ["system run", dm({ turn: { channel: "feishu", chat_id: "x", surface: "system" }, src: "owner@system" })]] as const) {
  ok(/亲手发消息/.test(await call("self_profile", { action: "get" }, c)), `self_profile refused: ${name}`);
  ok(/亲手发消息/.test(await call("self_page", { action: "read", path: "self/practice.md" }, c)), `self_page refused: ${name}`);
  ok(/整份读/.test(await call("memory_read", { path: "/self/./charts/ziwei/v1/README.md" }, c)), `chart path refused however it is spelled: ${name}`);
}
for (const who of ["known", "other"] as const) {
  ok(!toolsFor(who).some((t) => /^self_|^lens_|^readings_/.test(t.name)), `${who}: no self / lens tools offered`);
  const c = dm({ principal: who, src: `${who}@feishu:dm` });
  ok(/not available/.test(await call("self_page", { action: "read", path: "self/practice.md" }, c)), `${who}: self_page refused at the gate`);
  ok(/not allowed/.test(await call("memory_read", { path: "self/practice.md" }, c)), `${who}: memory_read of self/ refused`);
  ok(!(await call("memory_read", { path: "self/charts/ziwei/v1/README.md" }, c)).includes("虚构盘面"), `${who}: chart refused`);
}

// ───────── routine views ─────────
const NOW = Date.parse("2026-11-19T07:50:00+08:00"), SUN = Date.parse("2026-11-22T19:30:00+08:00");
ok(L.periodFor("day", NOW) === "2026-11-19" && L.periodFor("week", NOW) === "2026-W47" && L.periodFor("month", NOW) === "2026-11", "periods for a Thursday");
ok(L.periodFor("week", SUN) === "2026-W48", "on Sunday the week job looks at the coming week");
await call("self_profile", { action: "set", clear_birth: true });
ok(!(await api("GET", "/life/birth")).json.birth, "birth cleared");
const row = (id: number) => one("SELECT lens, method, horizon, period, status FROM readings WHERE id=?", id)!;
for (const h of ["day", "week", "month"] as const) {
  const ids = L.queueHorizonReadings(h, NOW);
  ok(ids.length === 1 && row(ids[0]).lens === "liuyao" && row(ids[0]).method === h && row(ids[0]).horizon === h && row(ids[0]).period === L.periodFor(h, NOW), `no birth: ${h} → one 六爻 in the ledger (${row(ids[0])?.period})`);
  ok(L.queueHorizonReadings(h, NOW).length === 0, `${h}: not cast twice for one period`);
}
await call("self_profile", { action: "set", birth: BIRTH });
const both = L.queueHorizonReadings("month", NOW).map(row).map((x) => `${x.lens}:${x.method}`);
ok(both.length === 1 && both[0] === "ziwei:month", `birth added: 紫微流月 joins the month, 六爻 not repeated → ${both}`);
const nextMonth = Date.parse("2026-12-01T06:00:00+08:00"), dec = L.queueHorizonReadings("month", nextMonth).map(row).map((x) => `${x.lens}:${x.method}`).sort();
ok(dec.join() === "liuyao:month,ziwei:month", `with birth a new month runs both → ${dec}`);
await call("self_profile", { action: "set", birth: { time: "11:20" } });
ok(L.queueHorizonReadings("month", nextMonth).map(row).map((x) => x.lens).join() === "ziwei", "corrected birth: new chart's month view isn't blocked by the old one");
await call("self_profile", { action: "set", lenses: { liuyao: { enabled: false } } });
ok(L.queueHorizonReadings("day", NOW + 86400_000).length === 0, "a lens switched off is skipped");
await call("self_profile", { action: "set", lenses: { liuyao: { enabled: true } } });

// 渎则不告 stays for one matter, and is not in the way of routine casts
run("INSERT INTO matters(id, title, lane, status, file_path, opened_at) VALUES(?,?,?,?,?,?)", 7, "虚构的事", "feishu:dm:owner", "open", "matters/7.md", Date.now());
L.requestReading({ lens: "liuyao", method: "cast", question: "这件事能不能成", matterId: 7, requestedBy: "t" });
let refused = ""; try { L.requestReading({ lens: "liuyao", method: "cast", question: "再问一次", matterId: 7, requestedBy: "t" }); } catch (e: any) { refused = e.message; }
ok(/渎则不告/.test(refused), "same matter asked again: still refused");
ok(L.queueHorizonReadings("day", NOW + 2 * 86400_000).length === 1, "routine cast still runs next to it");
ok(/period 不对/.test(await call("lens_reading", { lens: "liuyao", method: "day", question: "今天怎么样", period: "明天" })), "a bad period is refused");

// ───────── jobs ─────────
writeFileSync(join(P.config, "jobs.yaml"), `# 他的注释\nmorning: { every: day, at: "08:30", do: morning }\n`); commitIfDirty(P.config, "jobs");
ok(addDefaultLensJobs().join() === "lens_day,lens_week,lens_month", "existing instance gets the routine jobs");
const jobsText = () => readFileSync(join(P.config, "jobs.yaml"), "utf8");
const parsed = parse(jobsText());
ok(jobsText().includes("# 他的注释") && ["lens_day", "lens_week", "lens_month"].every((n) => typeof parsed[n].at === "string" && nextDue(parsed[n])), `his comments kept, specs valid → ${jobsText().split("\n").at(-2)}`);
writeFileSync(join(P.config, "jobs.yaml"), jobsText().replace(/^lens_day:.*\n/m, "").replace(/^(lens_week: \{)/m, "$1 enabled: false,"));
ok(addDefaultLensJobs().length === 0 && !parse(jobsText()).lens_day, "deleted job does not come back");
await new Promise((r) => setTimeout(r, 30));
ok(!jobsConf().lens_week && !!jobsConf().lens_month, "enabled: false turns a job off");
const seed = parse(readFileSync(join(here, "..", "seed", "config", "jobs.yaml"), "utf8"));
ok(seed.lens_day?.do === "lens_day" && seed.lens_week?.weekday === 0 && seed.lens_month?.day === 1, "seed has them on");

// ───────── where the views come back ─────────
const done = (id: number, text: string) => run("UPDATE readings SET status='done', reading=?, notice_json='[\"留意\"]', claims_json='[]' WHERE id=?", text, id);
run("UPDATE readings SET status='failed' WHERE method='day' AND period=?", today());   // the test clock's own day may be today
const dayId = L.requestReading({ lens: "liuyao", method: "day", question: "今天", period: today(), requestedBy: "job" });
run("DELETE FROM readings WHERE method='day' AND period=? AND id<>?", today(), dayId);
ok(morningText().includes("今日一卦") && /（queued/.test(morningText()), "morning report says the view isn't out yet");
done(dayId, "今日虚构卦象文字");
ok(morningText().includes("今日虚构卦象文字"), "morning report carries today's view");
kvSet("feishu.owner_dm_chat", "oc_fake"); run("INSERT INTO messages(id, surface, chat_id, sender_id, sender_kind, ts, text, lane) VALUES('m1','feishu:dm','oc_fake','u','owner',?, 'hi','feishu:dm:owner')", Date.now());
const dayText = reviewDayText();
ok(!dayText || dayText.includes("今日虚构卦象文字"), "day review brings it back");
const n = Date.now(), wk = isoWeek(n), nx = isoWeek(n + 2 * 86400_000);
const thisW = one("SELECT id FROM readings WHERE method='week' AND period=?", wk)?.id ?? L.requestReading({ lens: "liuyao", method: "week", question: "这周", period: wk, requestedBy: "job" });
done(thisW as number, "本周虚构卦象");
if (nx !== wk) done(L.requestReading({ lens: "liuyao", method: "week", question: "下周", period: nx, requestedBy: "job" }), "下周虚构卦象");
const weekText = reviewWeekText()!;
ok(weekText.includes("本周虚构卦象") && (nx === wk || weekText.includes("下周虚构卦象")) && !weekText.includes("今日虚构卦象文字"), "week review has this week's and next week's views, not every day's");
const monthText = reviewMonthText();
ok(!monthText || !monthText.includes("只写一句提示"), "month review no longer asks for a hint only");
void monthOf;

if (process.argv.includes("--live")) {
  const { startProxy } = await import("../src/proxy.ts");
  const proxy = await startProxy();
  await call("self_profile", { action: "set", clear_birth: true });
  run("UPDATE readings SET status='failed' WHERE status IN ('queued','running')");
  const period = "2026-12-25";
  const id = L.requestReading({ lens: "liuyao", method: "day", question: `${period} 这一天最该留意什么（工作、家庭、身体、心）`, period, requestedBy: "job" });
  const eng = new L.LensEngine(); eng.start();
  const t0 = Date.now();
  while (Date.now() - t0 < 14 * 60_000 && !["done", "failed"].includes(L.getReading(id)!.status)) await new Promise((res) => setTimeout(res, 5000));
  const got = L.getReading(id)!;
  ok(got.status === "done", `live 六爻 day → ${got.status}${got.error ? ` (${got.error})` : ""} in ${Math.round((Date.now() - t0) / 1000)} s`);
  if (got.status === "done") {
    ok(got.horizon === "day" && got.period === period && JSON.parse(got.notice_json).length >= 1, "ledger row has horizon, period and a notice");
    console.log(`  length ${[...String(got.reading)].length} chars\n  notice: ${got.notice_json}\n  claims: ${got.claims_json}\n  reading: ${String(got.reading).slice(0, 300)}…`);
  }
  const cost = one("SELECT COALESCE(SUM(cost),0) c, COUNT(*) n, COALESCE(SUM(input_tokens),0) i, COALESCE(SUM(output_tokens),0) o FROM usage WHERE run_id=?", `lens_${id}`)!;
  console.log(`  cost $${Number(cost.c).toFixed(3)} over ${cost.n} calls`);
  eng.stop(); proxy.close();
}
srv?.close?.();
console.log(`\n${process.exitCode ? "SOME FAILED" : "ALL PASS"}`);
process.exit(process.exitCode ?? 0);
