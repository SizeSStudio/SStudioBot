// Approvals (DESIGN §7.2, §7.3). Submit-style by default: the tool writes a pending row and returns at once; the card
// goes to the admin group; the owner's click is a new event. Deferred-style (worker git_push) uses the same rows with
// kind=deferred_tool; the Task Engine resumes the worker after the decision.
//
//   pending ─approve─► approved ─► outbox (send) | inbox event (plan) | core executes + resume (deferred_tool)
//      ├─reject─► rejected   ├─timeout─► expired   ├─new draft for the same trigger─► superseded
//      └─owner already replied in that chat / trigger recalled─► invalidated
//
// Only the owner's clicks count (operator_id). First click wins: the state is checked and changed in one transaction,
// then the card is patched (buttons gone). A click on an old draft_version does nothing.

import { all, one, run, tx, signal } from "./db.ts";
import { feishuConf, gateConf, log, ownerFeishu, ownerName } from "./config.ts";
import { approvalCard, sendCard, patchCard, sendText } from "./cards.ts";
import { complete } from "./proxy.ts";
import { appendJournal, localStamp } from "./memory.ts";

export const hooks = {
  kickOutbox: () => {},
  kickDispatcher: () => {},
  /** deferred_tool decided: run the action (approve) and resume the worker; returns the result text shown on the card */
  onDeferred: async (_a: Record<string, any>): Promise<string | undefined> => undefined,
  /** M7 proposal / rollback decided (approve, reject, expire): apply or record; returns the result line */
  onTuning: async (_a: Record<string, any>): Promise<string | undefined> => undefined,
  /** M7: his thread reply on a proposal card asks for a change → revised card; returns the line said in the thread */
  onTuningRevise: async (_a: Record<string, any>, _note: string): Promise<string> => "（没接上改进模块）",
};

/** kinds whose decision is carried out by core code right away (not the outbox, not a lane) */
const CODE_KINDS = ["deferred_tool", "proposal", "rollback"];
const REJECT_WORDS = /^\s*(拒|不要|算了|不用|不改)/;

export interface NewApproval {
  kind: "send" | "plan" | "deferred_tool" | "proposal" | "rollback"; title: string; requester: string; draft: string;
  origin_lane?: string; run_id?: string; task_id?: string; tool_use_id?: string;
  channel?: string; target?: Record<string, unknown>; as_identity?: "user" | "bot";
  context?: Record<string, unknown>; checks?: unknown; expert?: unknown;
  trigger_chat?: string; trigger_msg_id?: string; trigger_ts?: number; matter_id?: number; ttlHours?: number;
}

/** Synchronous (safe to call before any await, e.g. inside a PreToolUse hook). The card is posted by postCards(). */
export function submitApproval(a: NewApproval): number {
  return tx(() => {
    const r = run(`INSERT INTO approvals(kind, origin_lane, run_id, task_id, tool_use_id, requester, channel, target_json, as_identity, title, draft,
        context_json, checks_json, expert_json, trigger_chat, trigger_msg_id, trigger_ts, expires_at, matter_id, ts) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      a.kind, a.origin_lane ?? null, a.run_id ?? null, a.task_id ?? null, a.tool_use_id ?? null, a.requester, a.channel ?? null,
      a.target ? JSON.stringify(a.target) : null, a.as_identity ?? null, a.title, a.draft, a.context ? JSON.stringify(a.context) : null,
      a.checks ? JSON.stringify(a.checks) : null, a.expert ? JSON.stringify(a.expert) : null, a.trigger_chat ?? null, a.trigger_msg_id ?? null,
      a.trigger_ts ?? null, Date.now() + (a.ttlHours ?? gateConf().approval_ttl_hours) * 3600_000, a.matter_id ?? null, Date.now());
    const id = Number(r.lastInsertRowid);
    if (a.run_id) run("UPDATE runs SET side_effects = side_effects + 1 WHERE id=?", a.run_id);
    // a newer draft for the same trigger replaces the older pending one
    if (a.kind === "send" && a.trigger_msg_id) {
      for (const old of all("SELECT id FROM approvals WHERE trigger_msg_id=? AND status='pending' AND id<>?", a.trigger_msg_id, id)) {
        run("UPDATE approvals SET status='superseded', superseded_by=? WHERE id=?", id, old.id);
        void refreshCard(old.id);
      }
    }
    return id;
  });
}

export const getApproval = (id: number) => one("SELECT * FROM approvals WHERE id=?", id);

/** Post cards for approvals that don't have one yet (retried every sweep, so a failed send isn't lost). */
let posting = false;
export async function postCards() {
  const chat = feishuConf().admin_chat;
  if (!chat || posting) return;
  posting = true;
  try {
    // `hold`: still being prepared (expert review of a push); posted anyway after 10 minutes so a crash can't hide it
  for (const a of all(`SELECT * FROM approvals WHERE card_msg_id IS NULL AND status='pending'
      AND (json_extract(context_json, '$.hold') IS NULL OR ts < ?) ORDER BY id LIMIT 10`, Date.now() - 10 * 60_000)) {
      try {
        const m = await sendCard(chat, approvalCard(a), { uuid: `sbot-appr-${a.id}` });
        run("UPDATE approvals SET card_msg_id=? WHERE id=?", m.message_id, a.id);
        log("approval", "card posted", { id: a.id, kind: a.kind });
      } catch (e: any) { log("approval", "card post failed", { id: a.id, err: String(e?.message ?? e).slice(0, 200) }); }
    }
  } finally { posting = false; }
}

export async function refreshCard(id: number, phase?: string) {
  const a = getApproval(id);
  if (!a?.card_msg_id) return;
  try { await patchCard(a.card_msg_id, approvalCard(a, phase)); }
  catch (e: any) { log("approval", "card patch failed", { id, err: String(e?.message ?? e).slice(0, 200) }); }
}

/** card.action.trigger with value { k: "appr", id, v, d } */
/** `via`: where the click came from when it isn't the card ("经控制台"), plus an optional note (the reason for a rejection).
 *  Returns the decided row, or undefined when the click was stale (not pending any more, or an older draft_version). */
export async function onApprovalClick(v: { id: number; v: number; d: string }, operator: string, via?: { source: string; note?: string }) {
  if (operator !== ownerFeishu()) { log("approval", "click by non-owner ignored", { id: v.id }); return; }
  const decision = v.d === "approve" ? "approved" : "rejected";
  const a = tx(() => {
    const cur = getApproval(Number(v.id));
    if (!cur || cur.status !== "pending" || cur.draft_version !== Number(v.v)) return undefined;   // stale or repeated click
    const note = via ? [via.source, via.note?.trim()].filter(Boolean).join("：").slice(0, 1000) : null;
    run("UPDATE approvals SET status=?, decided_by=?, decided_at=?, decide_note=COALESCE(?, decide_note) WHERE id=?", decision, operator, Date.now(), note, cur.id);
    const a = getApproval(cur.id)!;
    if (decision === "approved" && a.kind === "send") {
      run(`INSERT INTO outbox(approval_id, run_id, lane, channel, target_json, payload, idem_key, send_by, ts, as_identity) VALUES(?,?,?,?,?,?,?,?,?,?)`,
        a.id, a.run_id, a.origin_lane, a.channel, a.target_json, a.draft, `sbot-ap-${a.id}`,
        Date.now() + gateConf().send_by_hours * 3600_000, Date.now(), a.as_identity ?? "bot");
      run("UPDATE approvals SET final_text=draft WHERE id=?", a.id);
    }
    if (a.kind === "plan") queueApprovalEvent(a, decision);
    signal(a.kind === "send" ? (decision === "approved" ? (a.draft_version > 1 ? "draft_revised" : "draft_approved") : "draft_rejected") : `${a.kind}_${decision}`,
      { role: a.requester, run_id: a.run_id, approval_id: a.id, task_id: a.task_id ?? undefined });
    return getApproval(a.id);
  });
  if (!a) { log("approval", "click ignored (not pending or old version)", { id: v.id }); return; }
  log("approval", decision, { id: a.id, kind: a.kind });
  // §16.3 A: what he asked to change is the main evidence for style notes; dream reads it from the journal
  if (a.kind === "send" && decision === "approved" && a.revise_notes) {
    const notes = (JSON.parse(a.revise_notes) as { note: string }[]).map((n) => n.note).join(" / ");
    appendJournal(`审批 #${a.id}（${a.title}）改稿意见：${notes.slice(0, 600)}；最终发出：${String(a.final_text ?? a.draft).slice(0, 600)}`, "owner@approval");
  }
  await refreshCard(a.id, decision === "approved" && a.kind === "send" ? "sending" : undefined);
  if (a.kind === "send") hooks.kickOutbox();
  if (a.kind === "plan") hooks.kickDispatcher();
  if (CODE_KINDS.includes(a.kind)) await runDeferred(a);
  return getApproval(a.id);
}

async function runDeferred(a: Record<string, any>) {
  let result: string | undefined;
  try { result = await (a.kind === "deferred_tool" ? hooks.onDeferred(a) : hooks.onTuning(a)); }
  catch (e: any) { result = `执行出错：${String(e?.message ?? e).slice(0, 300)}`; }
  if (result) run("UPDATE approvals SET result=? WHERE id=?", result, a.id);
  await refreshCard(a.id, a.status === "approved" ? (result && /出错|失败|没法/.test(result) ? "failed" : "done") : undefined);
}

function queueApprovalEvent(a: Record<string, any>, decision: string) {
  if (!a.origin_lane) return;
  const turn = a.context_json ? JSON.parse(a.context_json).turn : undefined;
  run(`INSERT OR IGNORE INTO inbox(lane, kind, source, source_msg_id, turn_ctx_json, payload_json, status, ts) VALUES(?,?,?,?,?,?,?,?)`,
    a.origin_lane, "approval", "approval", `${a.id}:${decision}`, turn ? JSON.stringify(turn) : null,
    JSON.stringify({ text: `审批 #${a.id}（${a.title}）${decision === "approved" ? "已批准，按批准的计划去做" : decision === "expired" ? "过期了，没有得到批准" : "被拒绝"}${a.decide_note ? `。主人的意见：${a.decide_note}` : ""}\n计划：${a.draft}` }),
    "received", Date.now());
}

/** Owner replied in the card's thread: for a send draft that's a revision request; otherwise a rejection with reasons. */
export async function onCardThreadReply(cardMsgId: string, text: string): Promise<boolean> {
  const a = one("SELECT * FROM approvals WHERE card_msg_id=?", cardMsgId);
  if (!a) return false;
  const admin = feishuConf().admin_chat!;
  if (a.status === "pending" && a.kind === "proposal" && !REJECT_WORDS.test(text))
    await sendText(admin, "收到，按你的意见改提案，回放完会更新这张卡片。", { replyTo: cardMsgId, inThread: true });
  const said = await reviseApproval(a.id, text);
  if (said) await sendText(admin, said, { replyTo: cardMsgId, inThread: true });
  return true;
}

/** The owner's words on a pending approval (card thread or console). send: the draft is rewritten to his note (v+1);
 *  proposal: the expert revises the set, unless the note starts with a rejection word; other kinds: rejected with the
 *  note as the reason. Returns the line to tell him ("" when nothing needs saying). */
export async function reviseApproval(id: number, text: string): Promise<string> {
  const a = getApproval(id);
  if (!a) return `没有审批 #${id}`;
  if (a.status !== "pending") return `#${a.id} 已经是「${a.status}」，改不了了。`;
  if (a.kind === "proposal" && !REJECT_WORDS.test(text)) {
    let said: string;
    try { said = await hooks.onTuningRevise(a, text); } catch (e: any) { said = `改提案出错：${String(e?.message ?? e).slice(0, 200)}`; }
    await refreshCard(a.id);
    return said;
  }
  if (a.kind !== "send") {
    const done = tx(() => {
      const r = run("UPDATE approvals SET status='rejected', decided_by=?, decided_at=?, decide_note=? WHERE id=? AND status='pending'", ownerFeishu() ?? null, Date.now(), text.slice(0, 1000), a.id);
      if (r.changes && a.kind === "plan") queueApprovalEvent({ ...a, decide_note: text }, "rejected");
      return r.changes > 0;
    });
    if (done) { signal(`${a.kind}_rejected`, { approval_id: a.id, task_id: a.task_id ?? undefined, value: { note: text } }); await refreshCard(a.id); if (CODE_KINDS.includes(a.kind)) await runDeferred(getApproval(a.id)!); if (a.kind === "plan") hooks.kickDispatcher(); }
    return "";
  }
  const ctx = a.context_json ? JSON.parse(a.context_json) : {};
  let next: string;
  try {
    next = await complete({
      tier: "work", maxTokens: 1500, requester: "draft",
      system: `你在替${ownerName()}改一条要以${a.as_identity === "user" ? "他本人" : "bot"}身份发出的消息草稿。按他的修改意见改，保持他的口吻和原稿里对的部分。只输出改好的正文，不要解释。`,
      user: `${ctx.context_text ? `【当时的上下文】\n${ctx.context_text}\n\n` : ""}【当前草稿 v${a.draft_version}】\n${a.draft}\n\n【修改意见】\n${text}`,
    });
  } catch (e: any) { return `改稿失败：${String(e?.message ?? e).slice(0, 200)}`; }
  const notes = [...(a.revise_notes ? JSON.parse(a.revise_notes) : []), { v: a.draft_version, note: text, ts: Date.now() }];
  const ok = run("UPDATE approvals SET draft=?, draft_version=draft_version+1, revise_notes=? WHERE id=? AND status='pending' AND draft_version=?",
    next, JSON.stringify(notes), a.id, a.draft_version).changes > 0;
  if (!ok) return `#${a.id} 在改稿期间变了（被批、被拒或别处改过），这次没改。`;
  await refreshCard(a.id);
  return `改好了，卡片上是 v${a.draft_version + 1}。`;
}

/** Console: he rewrote the draft text himself. Same version lock as a click: only on the version he was looking at. */
export async function editDraft(id: number, v: number, text: string, source: string): Promise<Record<string, any>> {
  const t = text.trim();
  if (!t) throw new Error("草稿不能是空的");
  const ok = tx(() => {
    const a = getApproval(id);
    if (!a || a.status !== "pending" || a.draft_version !== v || !["send", "plan"].includes(a.kind)) return false;
    if (t === a.draft.trim()) return true;
    const notes = [...(a.revise_notes ? JSON.parse(a.revise_notes) : []), { v, note: `（${source}直接改稿）`, ts: Date.now() }];
    return run("UPDATE approvals SET draft=?, draft_version=draft_version+1, revise_notes=? WHERE id=? AND status='pending' AND draft_version=?",
      t, JSON.stringify(notes), id, v).changes > 0;
  });
  if (!ok) throw new Error("这条审批已经变了（被批、被拒或改过新版本），刷新后再改。");
  await refreshCard(id);
  return getApproval(id)!;
}

/** §3.6 step 3: the owner spoke in this chat after the trigger → the pending drafts for that chat are void. */
export function invalidateForOwnerMessage(chatId: string, ts: number, msgId: string) {
  if (one("SELECT 1 FROM outbox WHERE sent_msg_id=?", msgId)) return;   // that was our own send in his name
  const rows = all("SELECT id FROM approvals WHERE status='pending' AND kind='send' AND trigger_chat=? AND trigger_ts<=?", chatId, ts);   // minute precision: same minute counts
  for (const r of rows) {
    run("UPDATE approvals SET status='invalidated', decide_note='你已经亲自回复了', decided_at=? WHERE id=?", Date.now(), r.id);
    signal("replied_myself", { approval_id: r.id });
    // what he actually sent is the reference answer for the draft (§16.2)
    const mine = one("SELECT text FROM messages WHERE id=?", msgId)?.text, draft = one("SELECT draft, title FROM approvals WHERE id=?", r.id);
    if (mine) appendJournal(`审批 #${r.id}（${draft?.title ?? ""}）作废：他自己回了「${String(mine).slice(0, 500)}」；草稿是「${String(draft?.draft ?? "").slice(0, 400)}」`, "owner@approval");
    void refreshCard(r.id);
  }
}

/** Outbox callback: an approved send went out (or failed for good). */
export function onApprovalSent(approvalId: number, ok: boolean, err?: string) {
  run("UPDATE approvals SET result=? WHERE id=?", ok ? `${localStamp().slice(5)} 已发出` : `发送失败：${(err ?? "").slice(0, 200)}`, approvalId);
  void refreshCard(approvalId, ok ? "sent" : "failed");
}

/** Sentinel bit for approvals (§9.2): expire, then post any missing cards. */
export async function sweepApprovals() {
  for (const a of all("SELECT * FROM approvals WHERE status='pending' AND expires_at < ?", Date.now())) {
    if (!run("UPDATE approvals SET status='expired', decided_at=? WHERE id=? AND status='pending'", Date.now(), a.id).changes) continue;
    log("approval", "expired", { id: a.id });
    await refreshCard(a.id);
    if (CODE_KINDS.includes(a.kind)) await runDeferred(getApproval(a.id)!);
    if (a.kind === "plan") { queueApprovalEvent(a, "expired"); hooks.kickDispatcher(); }
  }
  await postCards();
}
