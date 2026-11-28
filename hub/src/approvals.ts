// Approvals (§底3.2, §底3.3, §办3.3; 03 approvals). Only I decide: a client device, or a channel callback whose operator
// is my id in people.yaml. A decision is one transaction: check state and draft_version → set state → decided_by →
// what follows (send → one outbox row with the approved text; plan → an `approval` event back in the lane;
// glance/ask → answer_json, which tasks (W4) carries back to the session).
import type { Db, Row } from "./db/db.ts";
import { gateConf, peopleConf } from "./config/load.ts";
import { enqueue, toOutlet } from "./outbox.ts";
import { ingest } from "./inbox.ts";
import { redact, redactDeep } from "./tools/redact.ts";
import { log } from "./log.ts";

export type ApprovalKind = "send" | "plan" | "glance" | "ask" | "proposal" | "rollback";

/** Channel-neutral card (03): clients draw it, channel plugins render it their way. */
export interface Card {
  approval_id: number; kind: ApprovalKind; title: string; lines: string[]; question: string;
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
  const detailText = req ? String(req.command ?? req.path ?? JSON.stringify(req, null, 1)) : undefined;
  return redactDeep({
    approval_id: Number(a.id), kind, title: String(a.title ?? ""), lines,
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
  answer?: { option_id?: string; text?: string };
}
export type DecideResult = { ok: true; status: string; outbox_id?: number } | { ok: false; error: string };

export function decide(db: Db, id: number, d: Decision): DecideResult {
  if (!isMe(db, d.by)) {
    log("approvals", "decision refused: not the owner", { id, by: d.by.kind });
    return { ok: false, error: "只有本人能决定这张卡" };
  }
  const res = db.tx((): DecideResult => {
    const a = db.one("SELECT * FROM approvals WHERE id = ?", id);
    if (!a) return { ok: false, error: `没有审批 #${id}` };
    if (a.status !== "pending") return { ok: false, error: `这张卡已经是 ${a.status}` };   // first decision wins
    if (a.expires_at != null && Number(a.expires_at) < Date.now()) {
      expire(db, a, Date.now());
      return { ok: false, error: "已过期" };
    }
    if (d.draft_version != null && d.draft_version !== Number(a.draft_version)) return { ok: false, error: "草稿改过了，按最新的再决定" };
    const status = d.decision === "approve" ? "approved" : "rejected";
    const final = d.decision === "approve" ? redact(d.final_text ?? (a.draft as string | null) ?? "") : null;
    db.run("UPDATE approvals SET status = ?, decided_by = ?, decided_at = ?, decide_note = ?, final_text = ?, answer_json = ? WHERE id = ?",
      status, byText(d.by), Date.now(), d.note ?? null, final, d.answer ? JSON.stringify(d.answer) : null, id);
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
        payload: { text: `（审批结果）#${id}「${a.title}」${status === "approved" ? "批了" : "没批"}${d.note ? `：${d.note}` : ""}`, approval_id: id, decision: d.decision },
      });
    }
    refreshCards(db, a, status);
    return { ok: true, status, ...(outbox_id ? { outbox_id } : {}) };
  });
  if (res.ok) log("approvals", "decided", { id, status: res.status });
  return res;
}

/** Re-render every card that went out (cards_json, filled by the plugins) with the new state ※. */
function refreshCards(db: Db, a: Row, status: string) {
  const cards = a.cards_json ? (JSON.parse(String(a.cards_json)) as { channel: string; chat?: string; msg_id?: string }[]) : [];
  const card = cardOf({ ...a, status });
  for (const c of cards) {
    if (!c.msg_id) continue;
    enqueue(db, { channel: c.channel, kind: "card", target: { chat: c.chat, replace: c.msg_id }, payload: JSON.stringify(card), lane: (a.origin_lane as string | null) ?? null, idem_key: `approval:${a.id}:card:${status}:${c.msg_id}` });
  }
}

/**
 * pending → expired. A held reply in someone else's conversation (context.hold, reply.ts) also sends gate.yaml's
 * fixed hold_timeout_text to that conversation, once (§底3.4).
 */
function expire(db: Db, a: Row, now: number) {
  db.run("UPDATE approvals SET status = 'expired', decided_by = 'code:expired', decided_at = ? WHERE id = ? AND status = 'pending'", now, Number(a.id));
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
    db.run("UPDATE approvals SET status = 'superseded', superseded_by = ?, decided_by = 'code:superseded', decided_at = ? WHERE id = ?", newId, Date.now(), oldId);
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
    for (const a of rows) {
      db.run("UPDATE approvals SET status = 'invalidated', decided_by = 'owner_message', decided_at = ? WHERE id = ?", Date.now(), Number(a.id));
      refreshCards(db, a, "invalidated");
    }
    return rows.length;
  });
}
