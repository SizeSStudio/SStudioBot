// M3c smoke on the VPS, as sbot, on a throwaway home (no model calls, no Feishu):
//
//   sudo -n -u sbot env SBOT_HOME=/srv/data/sbot/m3ctest SBOT_SECRETS=/srv/sbot/secrets.env SBOT_PROXY_PORT=7899 \
//     SBOT_LARK_CLI=/bin/false node test/m3c-smoke.ts
//
// Checks: timeline view + note, outlook caps / frozen / period format, review 未聊 vs chatted, owner-noticing quote,
// 送一程 after N owner noticings and the restore hint, 淡了 / 放下 (§寸4), dream's self_candidate evidence rules, self files rendered,
// memory_read blocked on Feishu for self/habits.md, self_mark only from the owner, reflect texts, health card text.

import { mkdirSync, readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { P } from "../src/config.ts";
import { all, one, run } from "../src/db.ts";
import { ensureAgentHome, appendJournal } from "../src/memory.ts";
import {
  addNote, timelineText, ownerActivity, submitOutlook, revisitOutlook, outlooksText, submitReview, markSelfItem, listSelfItems, today, isoWeek, monthOf,
  fadeSelfItems, takeSelfChanges,
} from "../src/life.ts";
import { dreamTools, dreamDiffText, newJournalLines, type DreamState } from "../src/dream.ts";
import { TOOLS } from "../src/tools.ts";
import { reviewDayText, reviewWeekText, reviewMonthText, morningOutlookText } from "../src/reflect.ts";
import { healthText } from "../src/health.ts";

const here = dirname(fileURLToPath(import.meta.url));
const ok = (cond: unknown, what: string) => { console.log(`${cond ? "PASS" : "FAIL"} ${what}`); if (!cond) process.exitCode = 1; };
const throws = (f: () => unknown, re: RegExp, what: string) => {
  try { f(); ok(false, `${what} (was accepted)`); } catch (e: any) { ok(re.test(String(e?.message)), `${what} → ${String(e?.message).slice(0, 70)}`); }
};
const rejects = async (p: Promise<unknown>, re: RegExp, what: string) => {
  try { const r = await p; ok(typeof r === "string" && re.test(r), `${what} → ${String(r).slice(0, 70)}`); } catch (e: any) { ok(re.test(String(e?.message)), `${what} → ${String(e?.message).slice(0, 70)}`); }
};

for (const d of [P.sessions, P.logs]) mkdirSync(d, { recursive: true });
ensureAgentHome(join(here, "..", "seed", "agent-home"));
ok(existsSync(join(P.agentHome, "skills/review/SKILL.md")) && existsSync(join(P.agentHome, "skills/outlook/SKILL.md")), "review / outlook skills seeded");

// ── 1. timeline ──
const now = Date.now();
run("INSERT OR REPLACE INTO messages(id, surface, chat_id, sender_id, sender_kind, ts, text, lane) VALUES(?,?,?,?,?,?,?,?)", "om_t1", "feishu:dm", "oc_dm", "ou_owner", "owner", now - 3600_000, "今天腰有点酸，开会坐太久了", "feishu:dm:owner");
const nid = addNote({ text: "腰酸，久坐", domain: "body", src: "owner@feishu:dm" });
const tl = timelineText({ from: now - 86400_000, to: now + 1000 });
ok(tl.includes("腰有点酸") && tl.includes(`note:${nid}`), "timeline has the owner's DM line and the note");
ok(timelineText({ from: now - 86400_000, to: now + 1000, domain: "body" }).includes("腰酸，久坐") && !timelineText({ from: now - 86400_000, to: now + 1000, domain: "family" }).includes("腰酸"), "timeline filters by domain");
ok(ownerActivity(now - 86400_000, now + 1000) >= 2, "owner activity counted");

// ── 2. outlooks ──
const wk = isoWeek(now), mo = monthOf(now);
throws(() => submitOutlook({ horizon: "week", period: "2026-11", items: [{ text: "x" }], runId: "t" }), /period for week/, "week period format checked");
const ids = submitOutlook({ horizon: "week", period: wk, items: [{ text: "周三前把方案初稿给老王", look_for: "周三下午有没有被会议吃掉" }, { text: "每天站起来走两次" }], runId: "t" });
ok(ids.length === 2 && existsSync(join(P.agentHome, `self/outlooks/${wk}.md`)), "week outlook stored + self/outlooks file");
throws(() => submitOutlook({ horizon: "week", period: wk, items: [{ text: "a" }, { text: "b" }], runId: "t" }), /最多 3 条/, "week cap 3");
submitOutlook({ horizon: "day", period: today(now), items: [{ text: "下午站起来一次" }], runId: "t" });
throws(() => submitOutlook({ horizon: "day", period: today(now), items: [{ text: "再来一条" }], runId: "t" }), /最多 1 条/, "day cap 1");
revisitOutlook(ids[0], "初稿周四才给，周三被会吃掉了", "owner@feishu:dm", "t");
ok(outlooksText("week", wk).includes("已回看：初稿周四才给"), "revisit shows under the outlook");
ok(one("SELECT text FROM outlooks WHERE id=?", ids[0])!.text === "周三前把方案初稿给老王", "outlook text unchanged after revisit");

// ── 3. self items via dream ──
const st: DreamState = { runId: "dream_t", commits: [], notes: [] };
const cand = dreamTools(st).find((t) => t.name === "self_candidate")!;
const tj = Date.now() - 1000;
appendJournal("我发现我一累就把方案拖到最后一天", "owner@feishu:dm", tj);
appendJournal("任务 #3 推迟", "system", tj + 1);
appendJournal("任务 #4 推迟", "system", tj + 2);
const jl = newJournalLines(tj - 1).slice(-3).map((l) => l.split(": ")[0]);
const [jOwner, jSys, jSys2] = jl;
await rejects(cand.exec({ kind: "habit", text: "你是个拖延的人", evidence: [jOwner], reason: "t" } as any, {} as any), /behaviour/, "character judgment rejected");
await rejects(cand.exec({ kind: "habit", text: "累的时候任务往后推", evidence: [jSys], reason: "t" } as any, {} as any), /at least 2/, "one inferred evidence rejected");
const r1 = await cand.exec({ kind: "habit", text: "累的时候会把方案拖到最后一天", evidence: [jOwner], reason: "t" } as any, {} as any);
const r2 = await cand.exec({ kind: "rhythm", text: "周三下午常被会议占满", evidence: [jSys, jSys2], reason: "t" } as any, {} as any);
const hid = Number(/#(\d+)/.exec(r1)![1]), rid = Number(/#(\d+)/.exec(r2)![1]);
ok(one("SELECT owner_said FROM self_items WHERE id=?", hid)!.owner_said === 1 && one("SELECT owner_said FROM self_items WHERE id=?", rid)!.owner_said === 0, "owner_said set from the evidence source");
ok(st.candidates?.length === 2, "dream report carries the candidates");
const habits = readFileSync(join(P.agentHome, "self/habits.md"), "utf8");
ok(habits.startsWith("---\nvisibility: owner") && habits.includes("## 候选") && habits.includes("拖到最后一天"), "self/habits.md rendered, owner-only");

// ── 4. tool gates ──
const tool = (n: string) => TOOLS.find((t) => t.name === n)!;
const ctx = (channel: string, src: string) => ({ runId: "t", lane: "feishu:dm:owner", principal: "owner", turn: { channel } as any, src, token: "", replies: 0 }) as any;
await rejects(tool("memory_read").exec({ path: "self/habits.md" } as any, ctx("feishu", "owner@feishu:dm")), /亲手问的那一轮整份读/, "memory_read of self/habits.md blocked outside a run he started in his DM");
await rejects(tool("self_mark").exec({ id: hid, status: "endorsed", owner_quote: "认" } as any, ctx("feishu", "summary@feishu:group:oc_x")), /only in a conversation with the owner/, "self_mark refused outside the owner's words");
await tool("self_mark").exec({ id: hid, status: "endorsed", owner_quote: "这条我认" } as any, ctx("feishu", "owner@feishu:dm"));
ok(one("SELECT status FROM self_items WHERE id=?", hid)!.status === "endorsed", "self_mark by the owner endorses");
ok(tool("self_list") && tool("note_add") && tool("timeline_query") && tool("review_submit") && tool("outlook_submit") && tool("outlook_revisit"), "M3c tools registered");

// ── 5. reviews, noticings, 送一程 ──
throws(() => submitReview({ kind: "day", period: "2026-11-01", facts: "f", ownerWords: ["今天还行"], noticings: [{ item_id: hid, item_text: "拖", who: "owner", quote: "我没说过这句" }], questions: [], runId: "t" }),
  /原话/, "owner noticing without a matching quote rejected");
const un = submitReview({ kind: "day", period: "2026-11-02", facts: "开了三个会", ownerWords: [], agentNotes: "他好像累了", noticings: [], questions: [{ q: "今天怎样", response: "none" }], runId: "t" });
const unRow = one("SELECT * FROM reviews WHERE id=?", un.id)!;
ok(unRow.status === "unchatted" && !unRow.agent_notes && readFileSync(join(P.agentHome, un.rel), "utf8").includes("未聊"), "no owner words → 未聊, agent notes dropped");
let hint = "";
for (const [i, d] of ["03", "04", "05"].entries()) {
  const r = submitReview({ kind: "day", period: `2026-11-${d}`, facts: "f", ownerWords: [`我又拖到最后一天了 ${i}`], agentNotes: "n", noticings: [{ item_id: hid, item_text: "拖", who: "owner", quote: `我又拖到最后一天了 ${i}` }], questions: [], runId: "t" });
  hint = r.hints.join(" ");
}
ok(one("SELECT status FROM self_items WHERE id=?", hid)!.status === "seeing_off" && hint.includes("送一程"), "3 owner noticings in a row → 送一程");
for (const d of ["06", "07"]) submitReview({ kind: "day", period: `2026-11-${d}`, facts: "f", ownerWords: ["嗯"], noticings: [{ item_id: hid, item_text: "拖", who: "agent" }], questions: [], runId: "t" });
const last = submitReview({ kind: "day", period: "2026-11-08", facts: "f", ownerWords: ["嗯"], noticings: [{ item_id: hid, item_text: "拖", who: "agent" }], questions: [], runId: "t" });
ok(last.hints.join("").includes("你觉得需要吗") && one("SELECT status FROM self_items WHERE id=?", hid)!.status === "seeing_off", "agent noticings after 送一程 → ask him, status unchanged");
ok(all("SELECT * FROM signals WHERE kind='review_question'").length >= 1, "review question feedback signalled");

// ── 5b. 淡了 / 放下 (§寸4) ──
takeSelfChanges();
markSelfItem(rid, "endorsed", "t");
const old = Date.now() - 200 * 86400_000;
run("UPDATE self_items SET last_seen=?, updated_at=? WHERE id=?", old, old, rid);
const faded = fadeSelfItems();
ok(faded.includes(rid) && !faded.includes(hid) && one("SELECT status FROM self_items WHERE id=?", rid)!.status === "faded", "endorsed item with no evidence for fade_days → 淡了; one with recent noticings stays");
ok(readFileSync(join(P.agentHome, "self/rhythms.md"), "utf8").includes("## 淡了") && readFileSync(join(P.agentHome, "self/rhythms.md"), "utf8").includes("周三下午常被会议占满"), "rhythms.md shows the 淡了 section");
const fdiff = dreamDiffText() ?? "";
ok(fdiff.includes("淡了 1 条") && !fdiff.includes("周三下午常被会议占满"), "morning diff counts 淡了 without the content");
ok(!reviewWeekText()!.includes("周三下午常被会议占满"), "faded item not cited in the week review");
const st2: DreamState = { runId: "dream_t2", commits: [], notes: [] };
const cand2 = dreamTools(st2).find((t) => t.name === "self_candidate")!;
await cand2.exec({ id: rid, kind: "rhythm", text: "周三下午常被会议占满", evidence: [jSys], reason: "t" } as any, {} as any);
ok(one("SELECT status FROM self_items WHERE id=?", rid)!.status === "candidate", "new evidence on a faded item → back to 候选, not 认可");
await tool("self_mark").exec({ id: rid, status: "let_go", owner_quote: "这条放下吧" } as any, ctx("feishu", "owner@feishu:dm"));
ok(one("SELECT status FROM self_items WHERE id=?", rid)!.status === "let_go", "self_mark by the owner → 放下");
await rejects(cand2.exec({ id: rid, kind: "rhythm", text: "周三下午常被会议占满", evidence: [jSys2], reason: "t" } as any, {} as any), /放下/, "dream can't add evidence to a let-go item");
ok(takeSelfChanges().let_go === 1 && Object.keys(takeSelfChanges()).length === 0, "self changes counted, then reset");
await tool("self_mark").exec({ id: rid, status: "endorsed", owner_quote: "恢复这条" } as any, ctx("feishu", "owner@feishu:dm"));
ok(one("SELECT status FROM self_items WHERE id=?", rid)!.status === "endorsed", "恢复 by the owner brings it back");

// matter review
run("INSERT INTO matters(id, title, lane, status, file_path, opened_at) VALUES(?,?,?,?,?,?)", 901, "测试的事", "feishu:dm:owner", "closing", "matters/901.md", now - 86400_000);
const mr = submitReview({ kind: "matter", period: "matter:901", matterId: 901, facts: "做完了", ownerWords: ["比预想的慢"], noticings: [], questions: [], runId: "t" });
ok(one("SELECT status FROM matters WHERE id=901")!.status === "reviewed" && readFileSync(join(P.agentHome, mr.rel), "utf8").includes("# 复盘"), "matter review appends to the matter page and closes it");

// ── 6. reflect texts + health ──
const day = reviewDayText();
ok(day === undefined || (day.includes("日复盘") && day.includes("腰有点酸")), `day review text (${day ? "built" : "folded/skipped"})`);
const week = reviewWeekText()!;
ok(week.includes("周复盘") && week.includes(`#${ids[0]}`) && week.includes("复盘方法"), "week review text has the outlooks and the method");
const month = reviewMonthText()!;
ok(month.includes("月复盘") && month.includes("前瞻方法"), "month review text");
ok(morningOutlookText().includes("下午站起来一次"), "morning outlook section shows today's line");
ok(!week.includes("拖到最后一天") || week.includes("送一程"), "seeing-off item only under 送一程");
const h = healthText();
ok(h.includes("办事体检") && h.includes("未聊 1"), "health card text builds");
console.log(`\n${process.exitCode ? "SOME FAILED" : "ALL PASS"}`);
