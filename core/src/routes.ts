// Bot-side routing for the bot's own groups and card callbacks (DESIGN §3.1, §7.3).
//
//   admin group (feishu:console): owner's reply in a card's thread → revise / reject with reasons; `/group 关键词`;
//     `回滚 <sha>` reverts one memory commit (the morning dream diff, §8.3)
//   workbench (feishu:workbench): owner's reply in a task's topic → that task; anything else → lane feishu:wb:<topic root>
//   other groups: ignored here; the observer reads the owner's groups as the owner (§3.6)
//   card.action.trigger: deduped by event_id (inbox, lane "card"), then routed by the button value's `k`

import { feishuConf, log, ownerFeishu } from "./config.ts";
import { run } from "./db.ts";
import { onApprovalClick, onCardThreadReply } from "./approvals.ts";
import { onGroupClick, onReviewClick, sendGroupCard } from "./observer.ts";
import { onWorkbenchReply } from "./tasks.ts";
import { rollback } from "./dream.ts";
import { sendText } from "./cards.ts";
import { onMatterReviewClick } from "./matter-review.ts";
import type { Incoming } from "./feishu.ts";
import type { TurnContext } from "./tools.ts";

const stripMentions = (s: string) => s.replace(/^(\s*@\S+\s*)+/, "").trim();
const err = (where: string) => (e: any) => log("routes", `${where} failed`, { err: String(e?.message ?? e).slice(0, 300) });

/** A group message from the bot's event stream. Returns true when an inbox event was queued (kick the dispatcher). */
export function routeGroup(m: Incoming): boolean {
  const { admin_chat, workbench_chat } = feishuConf();
  const surface = m.chat_id === admin_chat ? "feishu:console" : m.chat_id === workbench_chat ? "feishu:workbench" : null;
  if (!surface) return false;
  const isOwner = !!ownerFeishu() && m.sender_id === ownerFeishu();
  const ts = Number(m.create_time) || Date.now();
  const text = stripMentions(m.content ?? "");
  const root = m.root_id || undefined;
  const lane = surface === "feishu:workbench" && isOwner ? `feishu:wb:${root ?? m.message_id}` : null;
  const fresh = run(`INSERT OR IGNORE INTO messages(id, surface, chat_id, thread_id, sender_id, sender_kind, ts, text, raw_json, lane)
       VALUES(?,?,?,?,?,?,?,?,?,?)`, m.message_id, surface, m.chat_id, m.thread_id ?? null, m.sender_id, isOwner ? "owner" : "other", ts, text,
    JSON.stringify({ message_type: m.message_type, root_id: root }), lane).changes > 0;
  if (!fresh || !isOwner || !text) return false;

  if (surface === "feishu:console") {
    const g = /^\/group\s+([\s\S]+)$/i.exec(text);
    if (g) { void sendGroupCard(g[1].trim()).then((s) => sendText(admin_chat!, s, { replyTo: m.message_id })).catch(err("/group")); return false; }
    const rb = /^回滚\s+([0-9a-f]{6,40})\s*$/i.exec(text);
    if (rb) { void sendText(admin_chat!, rollback(rb[1].toLowerCase()), { replyTo: m.message_id }).catch(err("rollback")); return false; }
    if (root) void onCardThreadReply(root, text).catch(err("card thread reply"));
    return false;
  }

  if (root && onWorkbenchReply(root, m.thread_id, text)) return false;
  const turn: TurnContext = { channel: "feishu", chat_id: m.chat_id, message_id: m.message_id, thread_id: m.thread_id, in_thread: true, surface: "feishu:workbench" };
  return run(`INSERT OR IGNORE INTO inbox(lane, kind, source, source_msg_id, turn_ctx_json, payload_json, status, ts) VALUES(?,?,?,?,?,?,?,?)`,
    lane, "user", "feishu", m.message_id, JSON.stringify(turn), JSON.stringify({ text, message_type: m.message_type, ts }), "received", Date.now()).changes > 0;
}

/** card.action.trigger (lark-cli fields: operator_id, message_id, chat_id, action_value (JSON string), token, event_id) */
export async function onCardAction(ev: any) {
  let v = ev.action_value ?? ev.action?.value;
  if (typeof v === "string") { try { v = JSON.parse(v); } catch { /* leave as is */ } }
  const operator = ev.operator_id ?? ev.operator?.open_id;
  const msg = ev.message_id ?? ev.open_message_id ?? ev.context?.open_message_id;
  const eid = ev.event_id ?? ev.token ?? `${msg}:${JSON.stringify(v)}:${Date.now()}`;
  const fresh = run(`INSERT OR IGNORE INTO inbox(lane, kind, source, source_msg_id, payload_json, status, ts) VALUES(?,?,?,?,?,?,?)`,
    "card", "card", "card", String(eid), JSON.stringify({ v, operator, msg }), "done", Date.now()).changes > 0;
  if (!fresh || !v?.k || !operator) return;
  log("routes", "card action", { k: v.k, msg: String(msg ?? "").slice(-8) });
  try {
    if (v.k === "appr") await onApprovalClick(v, operator);
    else if (v.k === "group") await onGroupClick(v, operator, msg);
    else if (v.k === "review") await onReviewClick(v, operator, msg);
    else if (v.k === "mr") await onMatterReviewClick(v, operator, msg);
  } catch (e) { err(`card ${v.k}`)(e); }
}
