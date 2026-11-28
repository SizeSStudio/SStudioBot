// Approvals (§底3.2, §底3.3, §办3.3; 03 approvals). Only I decide: a client device, or a channel callback whose operator
// is my id in people.yaml. A decision is one transaction: check state and draft_version → set state → decided_by →
// what follows (send → one outbox row with the approved text; plan → an `approval` event back in the lane;
// glance/ask → answer_json and a row in the task's lane `task:<id>`, which tasks/engine.ts carries back to the
// session: durable, so an answer given while the node is away still arrives when it is back).
import type { Db, Row } from "./db/db.ts";
import { gateConf, jobsConf, peopleConf } from "./config/load.ts";
import { enqueue, toOutlet } from "./outbox.ts";
import { ingest } from "./inbox.ts";
import { localStamp, wallTime } from "./time.ts";
import { redact, redactDeep } from "./tools/redact.ts";
import { log } from "./log.ts";

export type ApprovalKind = "send" | "plan" | "glance" | "ask" | "proposal" | "rollback";

/** Channel-neutral card (03): clients draw it, channel plugins render it their way. */
export interface Card {
  approval_id: number; kind: ApprovalKind; title: string; lines: string[]; question: string;
  /** what a click must match (decide's optimistic lock); channels carry it back with the click */
  draft_version: number;
  options: { id: string; label: string; recommended?: boolean; cost?: string }[];
  detail?: { kind: "cmd" | "path" | "args" | "diff"; text: string; folded: boolean };
  status?: string;
}

export interface ApprovalSpec {
  kind: ApprovalKind; title: string; draft?: string; origin_lane?: string; run_id?: string; requester?: string;
  channel?: string; target?: Record<string, unknown>; as_identity?: "bot" | "user";
  request?: Record<string, unknown>; options?: { id: string; label: string; kind?: string }[]; context?: Record<string, unknown>;
  task_id?: string; attempt?: number; session_ref?: string; tool_use_id?: string;
  trigger?: { chat?: string; msg_id?: string; ts?: number };
  /** §底3.4 commitment check result, shown on the card */
  checks?: { hits: string[] };
}

const HOUR = 3600_000;

/** §底3.3 expiry: send = send_by_hours; plan and the rest = approval_ttl_hours; glance/ask wait without a timeout. */
function expiresAt(kind: ApprovalKind, now: number): number | null {
  const g = gateConf();
  if (kind === "glance" || kind === "ask") return null;
  if (kind === "send") return now + g.send_by_hours * HOUR;
  if (kind === "proposal") return now + 72 * HOUR;
  return now + g.approval_ttl_hours * HOUR;
}

const OPTIONS: Record<string, Card["options"]> = {
  send: [{ id: "approve", label: "发", recommended: true }, { id: "reject", label: "不发" }],
  plan: [{ id: "approve", label: "可以", recommended: true }, { id: "reject", label: "不要" }],
  proposal: [{ id: "approve", label: "批" }, { id: "reject", label: "不批" }],
  rollback: [{ id: "approve", label: "回滚" }, { id: "reject", label: "不回滚" }],
};

export function cardOf(a: Row): Card {
  const kind = a.kind as ApprovalKind;
  const req = a.request_json ? JSON.parse(String(a.request_json)) : undefined;
  const opts = a.options_json ? (JSON.parse(String(a.options_json)) as { id: string; label: string }[]) : OPTIONS[kind] ?? OPTIONS.plan!;
  const target = a.target_json ? JSON.parse(String(a.target_json)) : undefined;
  const lines: string[] = [];
  if (kind === "send" && target) lines.push(`发到：${a.channel ?? ""} ${target.to ?? target.chat ?? ""}`.trim() + (a.as_identity === "user" ? "（用我的身份）" : ""));
  if (a.draft) lines.push(String(a.draft));
  const checks = a.checks_json ? (JSON.parse(String(a.checks_json)) as { hits?: string[] }) : undefined;
  if (checks?.hits?.length) lines.push(`⚠️ 承诺检测：${checks.hits.join("；")}`);
  if (a.revise_notes && a.status === "pending") lines.push(`✏️ 在改稿：${String(a.revise_notes)}`);
  const detailText = req ? String(req.command ?? req.path ?? JSON.stringify(req, null, 1)) : undefined;
  return redactDeep({
    approval_id: Number(a.id), kind, title: String(a.title ?? ""), lines, draft_version: Number(a.draft_version ?? 1),
    question: kind === "send" ? "原样发出去吗？" : kind === "ask" ? "怎么答？" : "可以吗？",
    options: opts.map((o) => ({ id: o.id, label: o.label, ...("recommended" in o ? { recommended: (o as { recommended?: boolean }).recommended } : {}) })),
    ...(detailText ? { detail: { kind: req?.command ? "cmd" : req?.path ? "path" : "args", text: detailText, folded: detailText.length > 400 } as Card["detail"] } : {}),
    status: String(a.status),
  } satisfies Card);
}

/**
 * Write a pending approval and put its card on the admin outlets whose channel can show cards. Clients see it from
 * the approvals table itself, so no client row. Returns the id (「已提交审批 #N」).
 * The draft is redacted before it is stored: what the card shows is exactly what approving sends (03 tools: anything
 * leaving the process is redacted).
 */
export function submitApproval(db: Db, s: ApprovalSpec): number {
  const now = Date.now();
  const id = db.tx(() => {
    const id = Number(db.run(
      `INSERT INTO approvals(kind, origin_lane, run_id, task_id, attempt, session_ref, tool_use_id, requester, channel, target_json, as_identity,
         title, draft, request_json, options_json, context_json, checks_json, trigger_chat, trigger_msg_id, trigger_ts, expires_at, ts)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      s.kind, s.origin_lane ?? null, s.run_id ?? null, s.task_id ?? null, s.attempt ?? null, s.session_ref ?? null, s.tool_use_id ?? null,
      s.requester ?? null, s.channel ?? null, s.target ? JSON.stringify(s.target) : null, s.as_identity ?? null,
      redact(s.title), s.draft != null ? redact(s.draft) : null, s.request ? JSON.stringify(s.request) : null, s.options ? JSON.stringify(s.options) : null,
      s.context ? JSON.stringify(s.context) : null, s.checks ? JSON.stringify(s.checks) : null, s.trigger?.chat ?? null, s.trigger?.msg_id ?? null, s.trigger?.ts ?? null, expiresAt(s.kind, now), now,
    ).lastInsertRowid);
    const a = db.one("SELECT * FROM approvals WHERE id = ?", id)!;
    toOutlet(db, "admin", JSON.stringify(cardOf(a)), { kind: "card", lane: s.origin_lane, run_id: s.run_id, idem: `approval:${id}:card`, cardsOnly: true, noClient: true });
    // 改稿 (requestRedraft): the new draft from the same place replaces the card that asked for it ※ — same lane,
    // kind and trigger message, so a triage card for another chat never replaces it
    if (s.origin_lane) {
      const old = db.all<{ id: number }>(
        `SELECT id FROM approvals WHERE status = 'pending' AND revise_notes IS NOT NULL AND id != ? AND kind = ? AND origin_lane = ?
           AND COALESCE(trigger_msg_id, '') = ?`, id, s.kind, s.origin_lane, s.trigger?.msg_id ?? "");
      for (const o of old) supersede(db, o.id, id);
    }
    return id;
  });
  log("approvals", "submitted", { id, kind: s.kind });
  return id;
}

export type Decider =
  | { kind: "device"; device_id: string; role?: "client" | "node" }
  | { kind: "channel"; channel: string; operator: string }
  | { kind: "code"; reason: string };

/** 03 「只认我答」: a client device (the CLI counts as one), or my own id on that channel. Never a node, never an agent. */
export function isMe(db: Db, by: Decider): boolean {
  if (by.kind === "device") {
    if (by.role === "node") return false;
    // `cli` is hub-admin.sock (only the hub's own account can connect). No paired device may ever get this id:
    // W2's pairing must never hand it out (03 link)
    if (by.device_id === "cli") return true;
    const d = db.one<{ role: string; removed_at: number | null }>("SELECT role, removed_at FROM devices WHERE id = ?", by.device_id);
    return !!d && d.role === "client" && d.removed_at == null;
  }
  if (by.kind === "channel") {
    const ids = (peopleConf().owner?.ids ?? {}) as Record<string, string | undefined>;
    const mine = ids[by.channel];
    return typeof mine === "string" && mine !== "" && mine === by.operator;
  }
  return false;
}

const byText = (by: Decider) => (by.kind === "device" ? `device:${by.device_id}` : by.kind === "channel" ? by.channel : `code:${by.reason}`);

export interface Decision {
  decision: "approve" | "reject"; by: Decider; draft_version?: number; final_text?: string; note?: string;
  /** glance / ask; `answers` is AskUserQuestion's question → answer (W4) */
  answer?: { option_id?: string; text?: string; answers?: Record<string, string> };
}
/**
 * Why a write on a card didn't happen, for the API's status codes (02): not_me 403, missing 404, bad 400,
 * decided / stale 409 (another end got there first, or the draft moved), gone 410 (expired, superseded, invalidated).
 */
export type Refusal = "not_me" | "missing" | "bad" | "decided" | "stale" | "gone";
export type Refused = { ok: false; code: Refusal; error: string };
export type DecideResult = { ok: true; status: string; outbox_id?: number } | Refused;
const GONE = new Set(["expired", "superseded", "invalidated"]);
const no = (code: Refusal, error: string): Refused => ({ ok: false, code, error });

/** A card that can still be acted on, or why not (inside the caller's tx). Expires it if its time is up. */
function pendingCard(db: Db, id: number, now = Date.now()): Row | Refused {
  const a = db.one("SELECT * FROM approvals WHERE id = ?", id);
  if (!a) return no("missing", `没有审批 #${id}`);
  if (a.status !== "pending") return no(GONE.has(String(a.status)) ? "gone" : "decided", `这张卡已经是 ${a.status}`);   // first decision wins
  if (a.expires_at != null && Number(a.expires_at) < now) {
    expire(db, a, now);
    return no("gone", "已过期");
  }
  return a;
}
const refused = (x: Row | Refused): x is Refused => x.ok === false && typeof x.code === "string";

/** Close any open push_queue row for this approval when it leaves `pending` (04 §2 push_queue). */
function closePush(db: Db, id: number, state: "done" | "void", now: number) {
  db.run("UPDATE push_queue SET state = ?, closed_at = ? WHERE ref = ? AND state IN ('wait','night','counted','sent')",
    state, now, `approval:${id}`);
}

/** The options a card offers: the agent's (glance, ask) or the kind's defaults. */
export function optionsOf(a: Row): { id: string; label: string; kind?: string }[] {
  if (a.options_json) { try { return JSON.parse(String(a.options_json)); } catch { return []; } }
  return OPTIONS[String(a.kind)] ?? OPTIONS.plan!;
}

/**
 * One mapping from what was clicked or sent to a decision, for every end (client decide, Feishu buttons, …) ※:
 *   send | plan | proposal | rollback — approve | reject (an option id `approve` / `reject` means the same)
 *   glance — an option id; the option's `kind` says which way (ACP: allow_* / reject_*); no kind: `reject` / `deny`
 *            reject, anything else approves
 *   ask    — an option id, or a free text answer
 */
export function choose(a: Row, x: { action?: "approve" | "reject" | "answer"; option_id?: string; text?: string; answers?: Record<string, string> }): { decision: "approve" | "reject"; answer?: Decision["answer"] } | Refused {
  const kind = String(a.kind);
  if (kind === "glance" || kind === "ask") {
    if (x.action && x.action !== "answer") return no("bad", "看一眼、问我的卡要 action answer 加 option_id");
    // ask: AskUserQuestion's question → answer map rides along (only on ask cards; a glance has no questions)
    const answers = kind === "ask" && x.answers && Object.keys(x.answers).length ? { answers: redactDeep(x.answers) as Record<string, string> } : {};
    if (kind === "ask" && (x.text || answers.answers) && !x.option_id) return { decision: "approve", answer: { ...(x.text ? { text: x.text } : {}), ...answers } };
    const opt = optionsOf(a).find((o) => o.id === x.option_id);
    if (!opt) return no("bad", `这张卡没有选项 ${x.option_id ?? "（没给）"}`);
    const k = String(opt.kind ?? "");
    const rejects = k ? /^(reject|deny)/.test(k) : opt.id === "reject" || opt.id === "deny";
    return { decision: rejects ? "reject" : "approve", answer: { option_id: opt.id, ...(rejects ? {} : answers) } };
  }
  const d = x.action === "answer" ? x.option_id : x.action ?? x.option_id;
  if (d !== "approve" && d !== "reject") return no("bad", "这种卡只有 approve 或 reject");
  return { decision: d };
}

export function decide(db: Db, id: number, d: Decision): DecideResult {
  if (!isMe(db, d.by)) {
    log("approvals", "decision refused: not the owner", { id, by: d.by.kind });
    return no("not_me", "只有本人能决定这张卡");
  }
  const res = db.tx((): DecideResult => {
    const a = pendingCard(db, id);
    if (refused(a)) return a;
    if (d.draft_version != null && d.draft_version !== Number(a.draft_version)) return no("stale", "草稿改过了，按最新的再决定");
    const now = Date.now();
    const status = d.decision === "approve" ? "approved" : "rejected";
    const final = d.decision === "approve" ? redact(d.final_text ?? (a.draft as string | null) ?? "") : null;
    const note = d.note ? redact(d.note) : null;
    const answer = d.answer ? (d.answer.text ? { ...d.answer, text: redact(d.answer.text) } : d.answer) : null;
    db.run("UPDATE approvals SET status = ?, decided_by = ?, decided_at = ?, decide_note = ?, final_text = ?, answer_json = ? WHERE id = ?",
      status, byText(d.by), now, note, final, answer ? JSON.stringify(answer) : null, id);
    closePush(db, id, "done", now);
    let outbox_id: number | undefined;
    if (a.kind === "send" && status === "approved") {
      // exactly what was approved, once (approval_id is UNIQUE), by the approval's own send_by
      outbox_id = enqueue(db, {
        channel: String(a.channel), target: JSON.parse(String(a.target_json ?? "{}")), payload: String(final ?? ""),
        lane: (a.origin_lane as string | null) ?? null, run_id: (a.run_id as string | null) ?? null, approval_id: id,
        as_identity: a.as_identity === "user" ? "user" : "bot", send_by: (a.expires_at as number | null) ?? null, idem_key: `approval:${id}`,
      });
    }
    if ((a.kind === "plan" || a.kind === "proposal" || a.kind === "rollback") && a.origin_lane) {
      ingest(db, {
        lane: String(a.origin_lane), kind: "approval", source: "approval", source_msg_id: `${id}:${d.decision}`,
        payload: { text: `（审批结果）#${id}「${a.title}」${status === "approved" ? "批了" : "没批"}${note ? `：${note}` : ""}`, approval_id: id, decision: d.decision },
      });
    }
    // glance / ask of a task: the engine (tasks/engine.ts) carries the answer to the node; which option the node
    // gets follows `status`, never the clicked id alone (answerFor, fail closed)
    if ((a.kind === "glance" || a.kind === "ask") && a.task_id) {
      ingest(db, {
        lane: `task:${a.task_id}`, kind: "approval", source: "approval", source_msg_id: `${id}:answer`,
        payload: { approval_id: id, decision: status, ts: Date.now() },
      });
    }
    refreshCards(db, db.one("SELECT * FROM approvals WHERE id = ?", id)!, status);
    return { ok: true, status, ...(outbox_id ? { outbox_id } : {}) };
  });
  if (res.ok) log("approvals", "decided", { id, status: res.status });
  return res;
}

/**
 * Re-render every card that went out (cards_json, filled by the plugins) with the new state ※. A still-pending card
 * is re-rendered when its draft changes (new text, new draft_version on the buttons) or a redraft is asked for.
 */
function refreshCards(db: Db, a: Row, status: string) {
  const cards = a.cards_json ? (JSON.parse(String(a.cards_json)) as { channel: string; chat?: string; msg_id?: string }[]) : [];
  const card = cardOf({ ...a, status });
  const step = status === "pending" ? `:v${a.draft_version}:${a.revise_notes ? String(a.revise_notes).length : 0}` : "";
  for (const c of cards) {
    if (!c.msg_id) continue;
    enqueue(db, { channel: c.channel, kind: "card", target: { chat: c.chat, replace: c.msg_id }, payload: JSON.stringify(card), lane: (a.origin_lane as string | null) ?? null, idem_key: `approval:${a.id}:card:${status}${step}:${c.msg_id}` });
  }
}

const EDITABLE = new Set(["send", "plan"]);

/**
 * I rewrite the draft myself (PUT /api/v1/approvals/:id/draft). draft_version + 1, so a click on a card that still
 * shows the old text is refused (stale) and the cards are re-rendered with the new text. Approving afterwards sends
 * exactly this text (decide copies the draft into final_text; the Feishu send checks it again, approvedAsSent).
 */
export function editDraft(db: Db, id: number, e: { text: string; draft_version: number; by: Decider }): { ok: true } | Refused {
  if (!isMe(db, e.by)) return no("not_me", "只有本人能改这张卡");
  return db.tx(() => {
    const a = pendingCard(db, id);
    if (refused(a)) return a;
    if (!EDITABLE.has(String(a.kind))) return no("bad", "这种卡没有可改的稿");
    if (e.draft_version !== Number(a.draft_version)) return no("stale", "草稿改过了，按最新的再改");
    db.run("UPDATE approvals SET draft = ?, draft_version = draft_version + 1 WHERE id = ?", redact(e.text), id);
    refreshCards(db, db.one("SELECT * FROM approvals WHERE id = ?", id)!, "pending");
    log("approvals", "draft edited", { id });
    return { ok: true };
  });
}

/**
 * 「改一下」(POST …/redraft, or a reply in the card's Feishu topic): the note goes to whoever drafted it; the card
 * stays pending until the new draft arrives and replaces it (submitApproval supersedes it), so if the redraft never
 * comes I can still decide on this one. `via`: lane = an input in origin_lane (the next round there redrafts);
 * triage = the caller asks triage to draft again (it has no lane to talk to). `draft_version` is checked when given.
 */
export function requestRedraft(db: Db, id: number, r: { note: string; draft_version?: number; by: Decider; triage?: boolean }): { ok: true; via: "lane" | "triage" } | Refused {
  if (!isMe(db, r.by)) return no("not_me", "只有本人能让它改稿");
  return db.tx(() => {
    const a = pendingCard(db, id);
    if (refused(a)) return a;
    if (!EDITABLE.has(String(a.kind))) return no("bad", "这种卡没有可改的稿");
    if (r.draft_version != null && r.draft_version !== Number(a.draft_version)) return no("stale", "草稿改过了，按最新的再说");
    const lane = (a.origin_lane as string | null) ?? "";
    const via = lane === "triage" ? "triage" : "lane";
    if (via === "triage" ? !r.triage : !lane || lane.startsWith("draft:")) return no("bad", "这张卡没有能改稿的地方，直接改字吧");
    const note = redact(r.note).slice(0, 4000);
    const notes = [a.revise_notes, note].filter(Boolean).join("；");
    db.run("UPDATE approvals SET revise_notes = ? WHERE id = ?", notes, id);
    if (via === "lane") {
      ingest(db, {
        lane, kind: "approval", source: "approval", source_msg_id: `${id}:redraft:${a.draft_version}:${notes.length}`,
        payload: {
          text: `（改稿）审批 #${id}「${a.title}」我要你改：${note}\n原稿：\n${a.draft ?? ""}\n按这个改完，用原来的工具重新提交（新卡会替掉这张）。`,
          approval_id: id, redraft: true,
        },
      });
    }
    refreshCards(db, db.one("SELECT * FROM approvals WHERE id = ?", id)!, "pending");
    log("approvals", "redraft asked", { id, via });
    return { ok: true, via };
  });
}

/** The approval whose card is this sent message (a reply in its Feishu topic), if any. */
export function approvalOfCard(db: Db, channel: string, msgId: string): number | undefined {
  const r = db.one<{ id: number }>(
    `SELECT a.id FROM approvals a, json_each(COALESCE(a.cards_json, '[]')) c
      WHERE json_extract(c.value, '$.channel') = ? AND json_extract(c.value, '$.msg_id') = ? ORDER BY a.id DESC LIMIT 1`, channel, msgId);
  return r?.id;
}

function parseHHMM(s: string | undefined, fallback: [number, number]): [number, number] {
  const m = typeof s === "string" ? /^(\d{1,2}):(\d{2})$/.exec(s.trim()) : null;
  return m ? [Number(m[1]), Number(m[2])] : fallback;
}

function approvalDomain(db: Db, a: Row): "work" | "personal" {
  if (a.matter_id != null) {
    const m = db.one<{ domain: string | null }>("SELECT domain FROM matters WHERE id = ?", Number(a.matter_id));
    if (m?.domain === "personal") return "personal";
  }
  const lane = typeof a.origin_lane === "string" ? a.origin_lane : "";
  if (lane === "console:main" || lane === "feishu:dm:owner") return "personal";
  if (lane) {
    const t = db.one<{ domain: string }>("SELECT domain FROM threads WHERE lane = ?", lane);
    if (t?.domain === "personal") return "personal";
  }
  return "work";
}

export type SnoozeUntil = "tonight" | "morning" | "monday";

/**
 * 暂缓 (POST /api/v1/approvals/:id/snooze, §触1.1, 04 §2 push_queue):
 *   tonight — today at gate.yaml push.snooze_tonight (refused once past that time; state `wait`, quota 1)
 *   morning — tomorrow at the morning job's time (fallback push.night.to; state `night`, quota 0)
 *   monday  — next Monday at the morning time (state `night`, quota 0)
 * Refused (400) if later than the card's send_by (`expires_at`). Emits `approval` explicitly in the same tx so other
 * devices fold the card away (04 §2).
 */
export function snoozeApproval(
  db: Db, id: number, s: { until: SnoozeUntil; by: Decider; now?: number },
): { ok: true; until_ts: number } | Refused {
  if (!isMe(db, s.by)) return no("not_me", "只有本人能暂缓这张卡");
  const now = s.now ?? Date.now();
  return db.tx(() => {
    const a = pendingCard(db, id, now);
    if (refused(a)) return a;
    const stamp = localStamp(now);
    const y = Number(stamp.slice(0, 4)), mo = Number(stamp.slice(5, 7)), d = Number(stamp.slice(8, 10));
    const push = gateConf().push;
    const morningJob = Object.values(jobsConf()).find((j) => j.do === "morning");
    const [mh, mmi] = parseHHMM(morningJob?.at ?? push.night.to, [8, 0]);
    let until_ts: number;
    if (s.until === "tonight") {
      const [th, tmi] = parseHHMM(push.snooze_tonight, [20, 0]);
      until_ts = wallTime(y, mo, d, th, tmi);
      if (until_ts <= now) return no("bad", "已经过了今晚提醒的时间，选明早或下周一吧");
    } else if (s.until === "morning") {
      until_ts = wallTime(y, mo, d + 1, mh, mmi);
    } else {
      const wd = new Date(Date.UTC(y, mo - 1, d)).getUTCDay();
      const delta = ((8 - wd) % 7) || 7;
      until_ts = wallTime(y, mo, d + delta, mh, mmi);
    }
    if (a.expires_at != null && until_ts > Number(a.expires_at)) {
      return no("bad", "暂缓的时间晚于这张卡的过期时间");
    }
    const cat = String(a.kind) === "ask" ? "ask" : "approval";
    const state = s.until === "tonight" ? "wait" : "night";
    const quota = s.until === "tonight" ? 1 : 0;
    db.run(
      `INSERT INTO push_queue(cat, ref, lane, domain, urgent, quota, text, state, not_before, deadline, snooze, expires_at, enq_at)
       VALUES (?,?,?,?,0,?,?,?,?,NULL,?,?,?)
       ON CONFLICT(cat, ref) DO UPDATE SET
         state = excluded.state, quota = excluded.quota, not_before = excluded.not_before,
         deadline = NULL, snooze = excluded.snooze, expires_at = excluded.expires_at, closed_at = NULL`,
      cat, `approval:${id}`, (a.origin_lane as string | null) ?? null, approvalDomain(db, a), quota,
      String(a.title ?? ""), state, until_ts, s.until, a.expires_at != null ? Number(a.expires_at) : null, now,
    );
    db.emit("approval", id);
    log("approvals", "snoozed", { id, until: s.until, until_ts });
    return { ok: true, until_ts };
  });
}

/**
 * pending → expired. A held reply in someone else's conversation (context.hold, reply.ts) also sends gate.yaml's
 * fixed hold_timeout_text to that conversation, once (§底3.4).
 */
function expire(db: Db, a: Row, now: number) {
  db.run("UPDATE approvals SET status = 'expired', decided_by = 'code:expired', decided_at = ? WHERE id = ? AND status = 'pending'", now, Number(a.id));
  closePush(db, Number(a.id), "void", now);
  refreshCards(db, a, "expired");
  const ctx = a.context_json ? (JSON.parse(String(a.context_json)) as { hold?: boolean }) : {};
  if (a.kind === "send" && ctx.hold && a.channel) {
    enqueue(db, {
      channel: String(a.channel), target: JSON.parse(String(a.target_json ?? "{}")), payload: gateConf().hold_timeout_text,
      lane: (a.origin_lane as string | null) ?? null, run_id: (a.run_id as string | null) ?? null,
      send_by: now + gateConf().send_by_hours * HOUR, idem_key: `approval:${a.id}:hold-timeout`,
    });
  }
}

/** Expiry sweep: pending past expires_at → expired (glance/ask have none). */
export function sweepApprovals(db: Db, now = Date.now()): number {
  return db.tx(() => {
    const rows = db.all("SELECT * FROM approvals WHERE status = 'pending' AND expires_at IS NOT NULL AND expires_at < ?", now);
    for (const a of rows) expire(db, a, now);
    return rows.length;
  });
}

/** A new draft for the same trigger replaces the old card. */
export function supersede(db: Db, oldId: number, newId: number) {
  db.tx(() => {
    const a = db.one("SELECT * FROM approvals WHERE id = ? AND status = 'pending'", oldId);
    if (!a) return;
    const now = Date.now();
    db.run("UPDATE approvals SET status = 'superseded', superseded_by = ?, decided_by = 'code:superseded', decided_at = ? WHERE id = ?", newId, now, oldId);
    closePush(db, oldId, "void", now);
    refreshCards(db, a, "superseded");
  });
}

/**
 * I answered in the place that triggered a pending card, after the trigger: the draft is moot (03 作废). Same for a
 * withdrawn trigger message (pass its id). Returns how many cards were invalidated.
 */
export function invalidateForOwnerMessage(db: Db, o: { chat?: string; after_ts?: number; trigger_msg_id?: string }): number {
  return db.tx(() => {
    const rows = o.trigger_msg_id
      ? db.all("SELECT * FROM approvals WHERE status = 'pending' AND trigger_msg_id = ?", o.trigger_msg_id)
      : db.all("SELECT * FROM approvals WHERE status = 'pending' AND trigger_chat = ? AND COALESCE(trigger_ts, 0) < ?", o.chat ?? "", o.after_ts ?? Date.now());
    const now = Date.now();
    for (const a of rows) {
      db.run("UPDATE approvals SET status = 'invalidated', decided_by = 'owner_message', decided_at = ? WHERE id = ?", now, Number(a.id));
      closePush(db, Number(a.id), "void", now);
      refreshCards(db, a, "invalidated");
    }
    return rows.length;
  });
}

/**
 * A task's open glance / ask cards are moot (§办3.3): the node or agent restarted (`invalidated`), the task moved or
 * was cancelled, or I typed into the task while it waited (`rejected` by owner_message, §办3.4: refuse it first).
 * `attempt` limits it to cards of that attempt. Returns the rows as they were, for the caller to tell the node.
 */
export function voidTaskCards(db: Db, task_id: string, o: { attempt?: number; status: "invalidated" | "rejected"; by: string }): Row[] {
  return db.tx(() => {
    const rows = o.attempt === undefined
      ? db.all("SELECT * FROM approvals WHERE task_id = ? AND status = 'pending' AND kind IN ('glance','ask')", task_id)
      : db.all("SELECT * FROM approvals WHERE task_id = ? AND attempt = ? AND status = 'pending' AND kind IN ('glance','ask')", task_id, o.attempt);
    for (const a of rows) {
      const now = Date.now();
      db.run("UPDATE approvals SET status = ?, decided_by = ?, decided_at = ? WHERE id = ? AND status = 'pending'", o.status, o.by, now, Number(a.id));
      closePush(db, Number(a.id), "void", now);
      refreshCards(db, db.one("SELECT * FROM approvals WHERE id = ?", Number(a.id))!, o.status);
    }
    return rows;
  });
}
