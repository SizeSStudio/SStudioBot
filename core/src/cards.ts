// Interactive cards in the admin group (§3.1 feishu:console, §7.3): approval cards, group switches, notices.
// Plain interactive messages (card JSON 2.0, update_multi), sent and patched with the bot identity. Every button
// carries a small value object; card.action.trigger delivers it back as `action_value` (see feishu.ts).

import { botApi } from "./feishu-api.ts";
import { localStamp } from "./memory.ts";

export type Card = Record<string, unknown>;
type Color = "blue" | "green" | "red" | "grey" | "orange" | "yellow" | "wathet" | "turquoise";

export async function sendCard(chatId: string, card: Card, o: { replyTo?: string; inThread?: boolean; uuid?: string } = {}): Promise<{ message_id: string; thread_id?: string }> {
  const content = JSON.stringify(card);
  const d = o.replyTo
    ? await botApi("POST", `/open-apis/im/v1/messages/${o.replyTo}/reply`, { msg_type: "interactive", content, reply_in_thread: !!o.inThread, uuid: o.uuid })
    : await botApi("POST", "/open-apis/im/v1/messages", { receive_id: chatId, msg_type: "interactive", content, uuid: o.uuid }, { receive_id_type: "chat_id" });
  if (!d.message_id) throw new Error("card send: no message_id");
  return { message_id: d.message_id, thread_id: d.thread_id };
}

export const patchCard = (messageId: string, card: Card) =>
  botApi("PATCH", `/open-apis/im/v1/messages/${messageId}`, { content: JSON.stringify(card) });

/** Bot text (markdown) into a chat, optionally as a thread reply. Used for notices and workbench progress. */
export async function sendText(chatId: string, md: string, o: { replyTo?: string; inThread?: boolean; uuid?: string } = {}) {
  const content = JSON.stringify({ zh_cn: { content: [[{ tag: "md", text: md }]] } });
  const d = o.replyTo
    ? await botApi("POST", `/open-apis/im/v1/messages/${o.replyTo}/reply`, { msg_type: "post", content, reply_in_thread: !!o.inThread, uuid: o.uuid })
    : await botApi("POST", "/open-apis/im/v1/messages", { receive_id: chatId, msg_type: "post", content, uuid: o.uuid }, { receive_id_type: "chat_id" });
  return { message_id: d.message_id as string, thread_id: d.thread_id as string | undefined };
}

export function card(o: { title: string; subtitle?: string; color: Color; tag?: [string, Color]; summary?: string; elements: unknown[] }): Card {
  return {
    schema: "2.0",
    config: { update_multi: true, summary: { content: o.summary ?? o.title } },
    header: {
      title: { tag: "plain_text", content: o.title },
      ...(o.subtitle ? { subtitle: { tag: "plain_text", content: o.subtitle } } : {}),
      template: o.color,
      ...(o.tag ? { text_tag_list: [{ tag: "text_tag", text: { tag: "plain_text", content: o.tag[0] }, color: o.tag[1] }] } : {}),
    },
    body: { direction: "vertical", vertical_spacing: "10px", elements: o.elements },
  };
}

export const md = (content: string, grey = false) => ({ tag: "markdown", content: grey ? `<font color='grey'>${content}</font>` : content });
export const button = (text: string, value: Record<string, unknown>, type: "primary_filled" | "danger" | "default" = "default") =>
  ({ tag: "button", text: { tag: "plain_text", content: text }, type, width: "fill", behaviors: [{ type: "callback", value }] });
export const buttons = (...bs: unknown[]) => ({
  tag: "column_set", flex_mode: "none", horizontal_spacing: "8px",
  columns: bs.map((b) => ({ tag: "column", width: "weighted", weight: 1, elements: [b] })),
});
export const quote = (s: string, max = 600) => (s.length > max ? s.slice(0, max) + "…" : s).split("\n").map((l) => `> ${l}`).join("\n");

// ---- approval card (§7.3: channel, recipient, identity, draft, trigger, checks, expert opinion) ----

const STATUS: Record<string, [string, Color]> = {
  pending: ["待审批", "yellow"], approved: ["已批准", "green"], sending: ["已批准 · 发送中", "green"], sent: ["已发送", "green"],
  done: ["已批准 · 已执行", "green"], failed: ["已批准 · 执行失败", "red"], rejected: ["已拒绝", "red"], expired: ["已过期", "grey"],
  superseded: ["已被新版本取代", "grey"], invalidated: ["已作废", "grey"],
};

export function approvalCard(a: Record<string, any>, phase?: string): Card {
  const ctx = a.context_json ? JSON.parse(a.context_json) : {};
  const st = phase ?? a.status;
  const [label, color] = a.kind === "rollback" && (st === "rejected" || st === "expired") ? ["已保留", "grey"]
    : a.kind === "rollback" && st === "done" ? ["已回滚", "orange"]
    : STATUS[st] ?? [st, "grey"];
  const open = a.status === "pending";
  const els: unknown[] = [];
  const who = a.as_identity === "user" ? "以**你本人**的身份" : "以 bot 身份";
  if (a.kind === "send") {
    els.push(md(`**发到** ${ctx.chat_name ?? a.trigger_chat ?? "?"}${ctx.in_thread ? "（话题里）" : ""} · ${who}`));
    if (ctx.trigger_text) els.push(md(`**触发** ${ctx.sender_name ?? "?"}：\n${quote(ctx.trigger_text, 400)}`));
    els.push(md(`**草稿 v${a.draft_version}**\n${a.draft}`));
  } else {
    els.push(md(a.draft ?? ""));
  }
  const checks = a.checks_json ? JSON.parse(a.checks_json) : null;
  if (checks?.hits?.length) els.push(md(`⚠️ 承诺检测：${checks.hits.join("；")}`));
  const ex = a.expert_json ? JSON.parse(a.expert_json) : null;
  if (ex) els.push(md(ex.skipped ? "<font color='grey'>未经专家把关（" + ex.skipped + "）</font>"
    : `**专家意见**（${ex.verdict}）${ex.issues?.length ? "\n" + ex.issues.map((i: string) => `- ${i}`).join("\n") : ""}${ex.suggestion ? `\n建议：${ex.suggestion}` : ""}`));
  if (open) {
    const [yes, no] = a.kind === "send" ? ["发送", "拒绝"] : a.kind === "rollback" ? ["回滚", "保留"] : ["批准", "拒绝"];
    els.push(buttons(
      button(yes, { k: "appr", id: a.id, v: a.draft_version, d: "approve" }, a.kind === "rollback" ? "danger" : "primary_filled"),
      button(no, { k: "appr", id: a.id, v: a.draft_version, d: "reject" }, a.kind === "rollback" ? "default" : "danger"),
    ));
    const hint = a.kind === "send" ? "要改：在这条卡片下「回复话题」说怎么改"
      : a.kind === "proposal" ? "要改：「回复话题」说怎么改；以「拒」「不要」「算了」开头算拒绝，理由会记下，8 周内不再提类似的"
      : a.kind === "rollback" ? "不理就保留"
      : "要附意见：在这条卡片下「回复话题」，会作为拒绝理由交回";
    els.push(md(`${hint} · ${a.expires_at ? localStamp(a.expires_at).slice(5) + " 过期" : ""}`, true));
  } else {
    const note = a.decide_note ? ` · ${a.decide_note}` : "";
    const res = a.result ? `\n${a.result}` : "";
    els.push(md(`${label}${a.decided_at ? " · " + localStamp(a.decided_at).slice(5) : ""}${note}${res}`, true));
  }
  return card({ title: a.title ?? "审批", subtitle: `#${a.id} · ${a.requester ?? ""}`, color: open ? "blue" : color, tag: [label, color], summary: `${label}：${a.title ?? ""}`, elements: els });
}
