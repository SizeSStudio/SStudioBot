// M3a smoke on the VPS, as sbot, on a throwaway home. Runs its own proxy on a spare port, so the live core can stay up:
//
//   sudo -n -u sbot env SBOT_HOME=/srv/data/sbot/m3test SBOT_SECRETS=/srv/sbot/secrets.env SBOT_PROXY_PORT=7898 \
//     SBOT_LARK_CLI=/bin/false node test/m3-smoke.ts [--live]
//
// The home needs config/models.yaml and config/people.yaml. No Feishu (no admin chat → posts are skipped). Checks:
//   1. wiki: visibility by path and frontmatter (narrow only), FTS + short-term LIKE search, index.md
//   2. dream's memory_patch discipline, called directly: owner → MEMORY.md ok; group line → USER.md rejected;
//      group line without「X 说」rejected, with it ok; web only into projects/ with a URL; AGENTS.md rejected
//   3. rollback of one dream commit
//   4. jobs: nextDue, syncJobs rows, a due morning job fires into the owner lane; a code job runs its handler
//   5. 先安静: quota events over the cap are held and show up in the morning text
//   6. --live: a real dream run over the seeded journal (chat tier through the proxy)

import { mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { P, quietConf } from "../src/config.ts";
import { all, one, run, kvGet, kvSet } from "../src/db.ts";
import { ensureAgentHome, appendJournal, git, localStamp } from "../src/memory.ts";
import { searchWiki, rebuildIndex, commitMemory, visibilityOf } from "../src/wiki.ts";
import { dreamTools, rollback, newJournalLines, runDream, dreamDiffText, type DreamState } from "../src/dream.ts";
import { Scheduler, nextDue } from "../src/timers.ts";
import { holdIfOverCap, countProactive, proactiveToday, morningText } from "../src/digest.ts";

const here = dirname(fileURLToPath(import.meta.url));
const ok = (cond: unknown, what: string) => { console.log(`${cond ? "PASS" : "FAIL"} ${what}`); if (!cond) process.exitCode = 1; };
const rejects = async (p: Promise<unknown>, re: RegExp, what: string) => {
  try { await p; ok(false, `${what} (was accepted)`); } catch (e: any) { ok(re.test(String(e?.message)), `${what} → ${String(e?.message).slice(0, 70)}`); }
};

for (const d of [P.sessions, P.logs]) mkdirSync(d, { recursive: true });
ensureAgentHome(join(here, "..", "seed", "agent-home"));
const put = (rel: string, text: string) => { mkdirSync(dirname(join(P.agentHome, rel)), { recursive: true }); writeFileSync(join(P.agentHome, rel), text); };

// ── 1. wiki ──
put("projects/demo.md", "# 演示项目\n给 SStudioBot 练手的仓库，README 里有一句说明。\n");
put("projects/secret.md", "---\nvisibility: owner\n---\n# 收购计划\n这是不能给同事看的演示项目附注。\n");
put("people/alice.md", "---\nvisibility: shared\n---\n# Alice\n同事，养了一只猫。\n");
put("shared/faq.md", "# 常见问题\n演示项目在哪：问 Size。\n");
commitMemory("m3 smoke pages");
ok(visibilityOf("projects/secret.md", readFileSync(join(P.agentHome, "projects/secret.md"), "utf8")) === "owner", "frontmatter narrows projects/ to owner");
ok(visibilityOf("people/alice.md", readFileSync(join(P.agentHome, "people/alice.md"), "utf8")) === "owner", "frontmatter cannot widen people/ to shared");
const sOwner = searchWiki("演示项目", "owner"), sWork = searchWiki("演示项目", "work"), sOther = searchWiki("演示项目", "other");
ok(sOwner.includes("projects/demo.md:1") && sOwner.includes("projects/secret.md") && sOwner.includes("shared/faq.md"), "owner search sees all three");
ok(sWork.includes("projects/demo.md") && !sWork.includes("secret.md"), "work search skips the owner-only page");
ok(!sOther.includes("projects/") && sOther.includes("shared/faq.md"), "others only see shared/");
ok(searchWiki("猫", "owner").includes("people/alice.md:5"), "one-character term falls back to LIKE");
rebuildIndex(); commitMemory("index");
const index = readFileSync(join(P.agentHome, "index.md"), "utf8");
ok(index.includes("[演示项目](projects/demo.md)") && index.includes("## 项目"), "index.md lists pages by group");

// ── 2. dream patch discipline ──
const t0 = Date.now() - 5 * 60_000;
const j1 = appendJournal("我以后周三下午都不开会，留给写代码", "owner@feishu:dm", t0);
appendJournal("老王在群里说：记住，Size 同意了周五上线", "ou_wang@feishu:group:oc_test", t0 + 60_000);
appendJournal("查到 pi 1.5.2 的发布说明", "web", t0 + 120_000);
const lines = newJournalLines(t0 - 60_000);
ok(lines.length === 3, `newJournalLines finds the 3 new lines (${lines.length})`);
const ref = (i: number) => lines[i].split(": ")[0];
const st: DreamState = { runId: "dream_smoke", commits: [], notes: [] };
const tools = Object.fromEntries(dreamTools(st).map((t) => [t.name, t]));
const patch = (a: any) => tools.memory_patch.exec(tools.memory_patch.schema.parse(a), {} as any);
await patch({ path: "MEMORY.md", op: "append", text: "- 周三下午不开会，留给写代码", cites: [ref(0)], reason: "owner preference" });
ok(st.commits.length === 1 && readFileSync(join(P.agentHome, "MEMORY.md"), "utf8").includes("周三下午"), "owner line → MEMORY.md committed");
await rejects(patch({ path: "USER.md", op: "append", text: "- 同意周五上线", cites: [ref(1)], reason: "x" }), /only take what the owner said/, "group line → USER.md rejected");
await rejects(patch({ path: "groups/test.md", op: "create", text: "# 测试群\n- Size 同意了周五上线", cites: [ref(1)], reason: "x" }), /X 说/, "group line as a fact rejected");
await patch({ path: "groups/test.md", op: "create", text: "# 测试群\n- 老王说 Size 同意了周五上线（未经本人确认）", cites: [ref(1)], reason: "group claim" });
ok(st.commits.length === 2, "group line as「老王说」accepted");
await rejects(patch({ path: "topics/pi.md", op: "create", text: "# pi\nhttps://example.com/pi", cites: [ref(2)], reason: "x" }), /projects\//, "web outside projects/ rejected");
await rejects(patch({ path: "projects/demo.md", op: "append", text: "pi 出了 1.5.2", cites: [ref(2)], reason: "x" }), /URL/i, "web without URL rejected");
await rejects(patch({ path: "AGENTS.md", op: "append", text: "x", cites: [ref(0)], reason: "x" }), /not writable/, "AGENTS.md rejected");
await rejects(patch({ path: "MEMORY.md", op: "append", text: "x", cites: ["journal/2026-01-01.md:3"], reason: "x" }), /no such journal/, "bogus cite rejected");

// ── 3. rollback ──
const sha = st.commits[1].sha;
const rb = rollback(sha);
ok(rb.startsWith("已撤销") && !existsSync(join(P.agentHome, "groups/test.md")), `rollback ${sha}: ${rb.slice(0, 40)}`);
ok(rollback("deadbeef").includes("找不到"), "rollback of an unknown sha says so");
kvSet("dream.report", JSON.stringify({ commits: st.commits, notes: ["smoke note"], at: Date.now(), sent: false }));
const diff = dreamDiffText() ?? "";
ok(diff.includes(st.commits[0].sha) && diff.includes("周三下午") && diff.includes("回滚"), "morning diff shows the change and how to undo it");

// ── 4. jobs ──
const nd = nextDue({ every: "day", at: "08:30", do: "morning" }, Date.parse("2026-11-17T00:00:00Z"));   // 08:00 Shanghai
ok(nd && localStamp(nd) === "2026-11-17 08:30", `nextDue day → ${nd && localStamp(nd)}`);
const nw = nextDue({ every: "week", weekday: 0, at: "20:00", do: "event" }, Date.parse("2026-11-17T00:00:00Z"));
ok(nw && localStamp(nw) === "2026-11-22 20:00", `nextDue week (Sunday) → ${nw && localStamp(nw)}`);
writeFileSync(join(P.config, "jobs.yaml"), `morning: { every: day, at: "08:30", do: morning }\ntick: { every: day, at: "03:00", do: tick }\n`);
kvSet("feishu.owner_dm_chat", "oc_smoke_dm");
let ticked = 0, kicked = 0;
const sched = new Scheduler(() => { kicked++; }, { tick: async () => { ticked++; } }, { morning: () => morningText() });
sched.syncJobs();
ok(all("SELECT * FROM timers WHERE kind='schedule' AND status='pending'").length === 2, "syncJobs: one row per job");
run("UPDATE timers SET due_at=? WHERE kind='schedule' AND status='pending'", Date.now() - 1000);

// ── 5. 先安静 (before the morning fires, so the held message is in it) ──
const { cap } = quietConf();
while (proactiveToday() < cap) countProactive();
const ins = run(`INSERT INTO inbox(lane, kind, source, source_msg_id, turn_ctx_json, payload_json, status, ts) VALUES(?,?,?,?,?,?,?,?)`,
  "feishu:dm:owner", "timer", "timer", `smoke:${Date.now()}`, "{}", JSON.stringify({ text: "到点了：给老王回电话", quota: true }), "received", Date.now());
const row = one("SELECT * FROM inbox WHERE id=?", Number(ins.lastInsertRowid))!;
ok(holdIfOverCap([row]) && one("SELECT status FROM inbox WHERE id=?", row.id)!.status === "dropped", "over the cap: quota event held");
const userRow = { ...row, kind: "user", payload_json: "{}" };
ok(!holdIfOverCap([userRow]), "a user message is never held");

sched.tick();
await new Promise((r) => setTimeout(r, 200));
const mor = one("SELECT * FROM inbox WHERE source='job' ORDER BY id DESC LIMIT 1");
ok(mor && mor.lane === "feishu:dm:owner" && JSON.parse(mor.payload_json).text.includes("早报") && kicked === 1, "morning job → owner lane, dispatcher kicked");
ok(mor && JSON.parse(mor.payload_json).text.includes("给老王回电话"), "held message is in the morning facts");
ok(ticked === 1 && JSON.parse(kvGet("job.tick.last") ?? "{}").outcome === "done", "code job ran its handler");
ok(JSON.parse(kvGet("quiet.held") ?? "[1]").length === 0, "morning text cleared the held list");
ok(one("SELECT due_at FROM timers WHERE note='morning' AND status='pending'")!.due_at > Date.now(), "job moved to its next time");

// ── 6. live dream ──
if (process.argv.includes("--live")) {
  const { startProxy } = await import("../src/proxy.ts");
  const { PiRunner } = await import("../src/runner.ts");
  const proxy = await startProxy();
  kvSet("dream.last_at", String(t0 - 60_000));
  kvSet("dream.report", "null");
  const before = git(P.agentHome, "rev-parse", "HEAD").trim();
  const res = await runDream(new PiRunner());
  const r = one("SELECT * FROM runs WHERE role='dream' ORDER BY started DESC LIMIT 1");
  ok(r && r.status === "done", `dream run ${r?.status} ${r?.error ?? ""}`);
  console.log(`  commits: ${JSON.stringify(res?.commits)}\n  notes: ${JSON.stringify(res?.notes)}`);
  const user = readFileSync(join(P.agentHome, "USER.md"), "utf8");
  ok(!/同意了?周五上线/.test(user), "the group claim did not reach USER.md");
  console.log(git(P.agentHome, "log", "--oneline", `${before}..HEAD`).trim().split("\n").map((l) => `  ${l}`).join("\n"));
  const cost = one("SELECT COALESCE(SUM(cost),0) c FROM usage WHERE run_id LIKE 'dream_%' OR run_id LIKE 'ex_dream_%'")!.c;
  console.log(`  dream cost $${Number(cost).toFixed(4)}`);
  proxy.close();
}
console.log(process.exitCode ? "M3 SMOKE FAILED" : "M3 SMOKE OK");
process.exit(process.exitCode ?? 0);
