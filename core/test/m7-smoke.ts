// M7 smoke on the VPS, as sbot, on a fresh throwaway home:
//
//   ssh <server> 'bash -s m7-smoke.ts 7829 [--live]' < test/vps-test-home.sh
//
// Offline: tunable files reach the prompts and the run versions; eval cases from his answers only (idempotent);
// proposal validation (whitelist, evidence, no-op, frontmatter, like a rejected one); the approve → file + commit →
// two-week rollback card → rollback path through the real approval click handler; reject / expire; the gate.
// --live: one forced improve run (expert call + replay) on the seeded signals.

import { mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { P, ownerFeishu } from "../src/config.ts";
import { one, all, run, kvSet } from "../src/db.ts";
import { ensureAgentHome, git } from "../src/memory.ts";
import { triageSystem, draftSystem } from "../src/triage.ts";
import { tuningVersions, versionOf } from "../src/tuning.ts";
import { submitApproval, onApprovalClick, getApproval, sweepApprovals } from "../src/approvals.ts";
import { approvalCard } from "../src/cards.ts";
import { metricsWindow } from "../src/health.ts";
import { collectEvalCases, validateProposals, lineDiff, improveDue, runImproveReview, installImproveHooks, runImprove, improveStatus, similarity } from "../src/improve.ts";

const here = dirname(fileURLToPath(import.meta.url));
const ok = (cond: unknown, what: string) => { console.log(`${cond ? "PASS" : "FAIL"} ${what}`); if (!cond) process.exitCode = 1; };
for (const d of [P.sessions, P.logs]) mkdirSync(d, { recursive: true });
ensureAgentHome(join(here, "..", "seed", "agent-home"));
installImproveHooks();
const owner = ownerFeishu()!;
const H = 3600_000, now = Date.now();

// ---- tunable files in the prompts ----
ok(!triageSystem().includes("分拣补充规则"), "no tuning file → nothing appended");
mkdirSync(join(P.agentHome, "tuning"), { recursive: true });
writeFileSync(join(P.agentHome, "tuning/triage.md"), "- 测试规则：周报群里的 @所有人 一律 archive\n");
ok(triageSystem().includes("测试规则") && !triageSystem("").includes("测试规则"), "tuning/triage.md appended; replay can override it");
ok(draftSystem("- 候选规则").includes("候选规则"), "draftSystem takes a candidate");
ok(tuningVersions()["tuning/triage.md"] !== "none" && tuningVersions()["tuning/draft.md"] === "none", "tuning versions recorded per file");

// ---- seed: drafts he approved / answered himself / rejected as 不用回, and a Triage miss ----
const msg = (id: string, chat: string, kind: string, ts: number, text: string, action?: string) =>
  run("INSERT INTO messages(id, surface, chat_id, sender_kind, ts, text, raw_json, triage_status, triage_action) VALUES(?,?,?,?,?,?,?,?,?)",
    id, "feishu:group", chat, kind, ts, text, JSON.stringify({ chat_name: chat === "oc_t" ? "项目群" : "饭搭子", sender_name: kind === "owner" ? "Size" : "小王", mentions: kind === "other" ? [owner] : [] }), "done", action ?? null);
const draftRun = (id: string) => {
  const f = join(P.sessions, "inputs", `${id}.txt`);
  mkdirSync(dirname(f), { recursive: true });
  writeFileSync(f, `群「项目群」里最近的消息：……需要他回复的这条：${id}`);
  run("INSERT INTO runs(id, lane, role, tier, model, status, started, input_ref, versions_json) VALUES(?,?,?,?,?,?,?,?,?)", id, "draft:oc_t", "draft", "chat", "m", "done", now, f, "{}");
};
const appr = (trigger: string, runId: string, ts: number) =>
  submitApproval({ kind: "send", title: "回复 · 项目群", requester: "Triage 起草", draft: "收到，我看下", run_id: runId, channel: "feishu", as_identity: "user",
    target: { channel: "feishu", chat_id: "oc_t", message_id: trigger, surface: "feishu:group" }, trigger_chat: "oc_t", trigger_msg_id: trigger, trigger_ts: ts });
msg("m1", "oc_t", "other", now - 5 * H, "@Size 明天下午能评审吗", "draft"); draftRun("d1");
const a1 = appr("m1", "d1", now - 5 * H);
await onApprovalClick({ id: a1, v: 1, d: "approve" }, owner);
msg("m2", "oc_t", "other", now - 4 * H, "@Size 预算表发我一下", "draft"); draftRun("d2");
const a2 = appr("m2", "d2", now - 4 * H);
run("UPDATE approvals SET status='invalidated', decided_at=? WHERE id=?", now - 4 * H + 600_000, a2);
msg("m3", "oc_t", "owner", now - 4 * H + 300_000, "发你了，看第二页");
msg("m6", "oc_t", "other", now - 3 * H, "@Size 周五团建报名", "draft"); draftRun("d6");
const a6 = appr("m6", "d6", now - 3 * H);
run("UPDATE approvals SET status='rejected', decide_note='这种不用回' WHERE id=?", a6);
msg("m4", "oc_u", "other", now - 2 * H, "今晚老地方？", "ignore");
msg("m5", "oc_u", "owner", now - 2 * H + 1800_000, "去！");

const added = collectEvalCases();
const cases = all("SELECT * FROM eval_cases ORDER BY id");
const ref = (r: string) => cases.find((c) => c.ref === r);
ok(added === 6, `6 eval cases collected (got ${added}: ${cases.map((c) => c.ref).join(",")})`);
ok(ref(`appr:${a1}`)?.expected === "收到，我看下" && ref(`self:${a2}`)?.expected === "发你了，看第二页", "draft cases: approved final text, and what he wrote himself");
ok(ref("tri:m1")?.expected === "raise" && ref("tri:m6")?.expected === "no_draft" && ref("tri:m4")?.expected === "raise", "triage cases: raise / no_draft / missed");
ok(JSON.parse(ref("tri:m4")!.meta_json).missed === true && ref("tri:m4")!.input.includes("今晚老地方"), "the miss carries the message as Triage saw it");
ok(collectEvalCases() === 0, "collecting again adds nothing");

// ---- validation ----
const ids = new Set(["a1", "c1", "c2"]);
run("INSERT INTO proposals(ts, target, problem, change, new_content, status) VALUES(?,?,?,?,?,?)", now - 7 * 86400_000, "tuning/draft.md",
  "回复太客气，总是以「收到」开头", "去掉「收到」开头，直接回答", "- 不用「收到」开头", "rejected");
const v = validateProposals({ proposals: [
  { target: "config/gate.yaml", problem: "x", change: "y", evidence: ["a1", "c1"], new_content: "z" },
  { target: "tuning/main.md", problem: "x", change: "y", evidence: ["a1"], new_content: "- 规则" },
  { target: "tuning/main.md", problem: "x", change: "y", evidence: ["a1", "c99"], new_content: "- 规则" },
  { target: "tuning/triage.md", problem: "x", change: "y", evidence: ["a1", "c1"], new_content: "- 测试规则：周报群里的 @所有人 一律 archive\n" },
  { target: "skills/review/SKILL.md", problem: "x", change: "y", evidence: ["a1", "c1"], new_content: "# 复盘\n- 新方法" },
  { target: "tuning/draft.md", problem: "回复太客气，总是用「收到」开头", change: "去掉「收到」开头，直接答", evidence: ["a1", "c2"], new_content: "- 别用收到开头" },
  { target: "tuning/main.md", problem: "他常说先给结论", change: "先给结论再解释", evidence: ["[a1]", "c2"], new_content: "- 先给结论，再解释" },
] }, ids);
ok(v.ok.length === 1 && v.ok[0].target === "tuning/main.md" && v.ok[0].evidence.join() === "a1,c2", `only the good one survives (dropped: ${v.dropped.join(" | ")})`);
ok(v.dropped.length === 6 && v.dropped.some((d) => /拒绝过/.test(d)) && v.dropped.some((d) => /frontmatter/.test(d)), "whitelist / evidence / no-op / frontmatter / like-rejected all caught");
ok(similarity("回复太客气总是收到开头", "回复太客气总是收到开头") === 1 && similarity("abc", "xyz") === 0, "similarity");
ok(lineDiff("- a\n- b", "- a\n- c\n- d") === "- - b\n+ - c\n+ - d", "line diff");

// ---- approve → applied and committed ----
const mkProp = (target: string, oldC: string, newC: string) => Number(run(`INSERT INTO proposals(ts, run_id, target, problem, change, evidence_json, old_content, new_content, old_version, new_version, replay_json, status)
  VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`, now, "imp_t", target, "p", `改 ${target}`, '["a1","c2"]', oldC, newC, versionOf(oldC), versionOf(newC), '{"skipped":"t"}', "proposed").lastInsertRowid);
const p1 = mkProp("tuning/main.md", "", "- 先给结论，再解释\n");
const p2 = mkProp("tuning/draft.md", "- 早就不是这个内容了\n", "- 新规则\n");          // stale old_version → conflict
const ap = submitApproval({ kind: "proposal", title: "改进提案 · 2 处", requester: "自我改进", draft: "…", context: { proposal_ids: [p1, p2], run_id: "imp_t" } });
for (const id of [p1, p2]) run("UPDATE proposals SET approval_id=? WHERE id=?", ap, id);
ok(JSON.stringify(approvalCard(getApproval(ap)!)).includes("回复话题」说怎么改"), "proposal card tells him a thread reply revises it");
await onApprovalClick({ id: ap, v: 1, d: "approve" }, owner);
const P1 = one("SELECT * FROM proposals WHERE id=?", p1)!;
ok(readFileSync(join(P.agentHome, "tuning/main.md"), "utf8").includes("先给结论") && P1.status === "approved" && P1.review_due > now + 13 * 86400_000, "approved → file written, review due in 14 days");
ok(git(P.agentHome, "log", "--oneline", "-3").includes(`improve: tuning/main.md (proposal #${p1}`), "agent-home commit for the change");
ok(one("SELECT status FROM proposals WHERE id=?", p2)!.status === "conflict" && /没改/.test(getApproval(ap)!.result), "a file changed in between is not overwritten");
ok(getApproval(ap)!.status === "approved" && one("SELECT 1 FROM signals WHERE kind='proposal_approved'"), "approval row + signal");

// ---- two weeks later: rollback card → rollback ----
run("UPDATE proposals SET applied_at=?, review_due=? WHERE id=?", now - 15 * 86400_000, now - 86400_000, p1);
ok(await runImproveReview() === 1 && await runImproveReview() === 0, "one rollback card per proposal");
const rb = one("SELECT * FROM approvals WHERE kind='rollback'")!;
ok(/前后各 14 天/.test(rb.draft) && JSON.stringify(approvalCard(rb)).includes("回滚") && JSON.stringify(approvalCard(rb)).includes("保留"), "rollback card: before / after, 回滚 / 保留");
await onApprovalClick({ id: rb.id, v: 1, d: "approve" }, owner);
ok(!existsSync(join(P.agentHome, "tuning/main.md")) && one("SELECT status FROM proposals WHERE id=?", p1)!.status === "rolled_back", "rollback restores the old (empty) file");
ok(git(P.agentHome, "log", "--oneline", "-2").includes("roll back tuning/main.md"), "rollback committed");

// ---- reject / expire ----
const p3 = mkProp("tuning/main.md", "", "- 另一条\n");
const ap3 = submitApproval({ kind: "proposal", title: "t", requester: "自我改进", draft: "…", context: { proposal_ids: [p3] } });
await onApprovalClick({ id: ap3, v: 1, d: "reject" }, owner);
ok(one("SELECT status FROM proposals WHERE id=?", p3)!.status === "rejected" && !existsSync(join(P.agentHome, "tuning/main.md")), "rejected → nothing written, remembered for 8 weeks");
const p4 = mkProp("tuning/main.md", "", "- 第三条\n");
const ap4 = submitApproval({ kind: "proposal", title: "t", requester: "自我改进", draft: "…", context: { proposal_ids: [p4] } });
run("UPDATE approvals SET expires_at=? WHERE id=?", Date.now() - 1, ap4);
await sweepApprovals();
ok(getApproval(ap4)!.status === "expired" && one("SELECT status FROM proposals WHERE id=?", p4)!.status === "expired", "ignored card expires, proposal void");

// ---- the gate ----
kvSet("improve.last_run", String(now - 2 * 86400_000));
ok(!improveDue({ min_days: 7 }).due && /离上次/.test(improveDue({ min_days: 7 }).why), "not due within min_days");
kvSet("improve.last_run", String(now - 10 * 86400_000));
ok(improveDue({ min_days: 7, min_signals: 3 }).due, "due with enough new signals");
const pend = submitApproval({ kind: "proposal", title: "t", requester: "自我改进", draft: "…", context: { proposal_ids: [] } });
ok(!improveDue({ min_signals: 1 }).due, "not due while a proposal card is pending");
run("UPDATE approvals SET status='rejected' WHERE id=?", pend);

// ---- 体检 counts notified as raised ----
run("UPDATE messages SET triage_action='notified' WHERE id='m4'");
ok(Number(metricsWindow(now - 86400_000, now + 1).triage.notify) >= 1, "体检: notified counts as 提醒你");
console.log(improveStatus());

if (process.argv.includes("--live")) {
  const { startProxy } = await import("../src/proxy.ts");
  const proxy = await startProxy();
  const t0 = Date.now();
  const out = await runImprove({}, { force: true });
  console.log(`  improve → ${out} (${Math.round((Date.now() - t0) / 1000)} s)`);
  const r = one("SELECT * FROM runs WHERE role='improve' ORDER BY started DESC")!;
  ok(r.status === "done", `improve run ${r.id} → ${r.status}`);
  for (const p of all("SELECT * FROM proposals WHERE run_id=?", r.id)) console.log(`  #${p.id} ${p.target}: ${p.problem} → ${p.change}\n    replay ${p.replay_json}`);
  const card = one("SELECT draft FROM approvals WHERE kind='proposal' AND run_id=?", r.id);
  if (card) console.log(`  card:\n${String(card.draft).split("\n").map((l) => "    " + l).join("\n").slice(0, 2500)}`);
  const cost = one("SELECT COALESCE(SUM(cost),0) c, COUNT(*) n FROM usage WHERE run_id LIKE ?", `${r.id}%`)!;
  console.log(`  cost $${Number(cost.c).toFixed(3)} over ${cost.n} calls`);
  proxy.close();
}
console.log(`\n${process.exitCode ? "SOME FAILED" : "ALL PASS"}`);
process.exit(process.exitCode ?? 0);
