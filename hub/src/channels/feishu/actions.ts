// Feishu-only card clicks and admin-chat commands: the group switches (`k: group`), the first-run review
// (`k: review`) and `/group <词>`. The inbox (W1d) calls handleCardRow() for card rows whose value.k it doesn't own
// (approvals `appr` and matter reviews `mr` stay with approvals/ledgers). The plugin already checked that I clicked.
// Config changes go through the one write path (config/write.ts), with source "card".
import { parseDocument } from "yaml";
import type { Activation } from "../../config/load.ts";
import { channelsConf, groupsConf } from "../../config/load.ts";
import { readConfigFile, saveConfigText } from "../../config/write.ts";
import { db, all, kvGet, kvSet, one } from "../../db/ambient.ts";
import { log } from "../../log.ts";
import { card, md } from "./cards.ts";
import { ACT_LABEL, groupCard } from "./observer.ts";
import type { FeishuChannel } from "./plugin.ts";

async function editGroups(edit: (doc: ReturnType<typeof parseDocument>) => string | undefined) {
  const cur = readConfigFile("groups.yaml");
  const doc = parseDocument(cur.exists ? cur.text : "");
  const what = edit(doc);
  if (!what) return false;
  await saveConfigText(db(), "groups.yaml", doc.toString(), cur.hash, { source: "card", actor: "feishu", what });
  return true;
}

export async function onGroupClick(p: FeishuChannel, v: { chat?: string; a?: Activation }, cardMsgId?: string) {
  if (!v.chat || !v.a || !ACT_LABEL[v.a]) return;
  const chat = v.chat, a = v.a;
  const name = one("SELECT name FROM chats WHERE chat_id=?", chat)?.name ?? "";
  await editGroups((doc) => {
    if (doc.getIn(["groups", chat, "activation"]) === a) return undefined;
    doc.setIn(["groups", chat], doc.createNode({ name, activation: a }));
    return `群开关 → ${a}`;
  });
  if (!cardMsgId) return;
  const ids = JSON.parse(kvGet(`groupcard:${cardMsgId}`) ?? JSON.stringify([chat])) as string[];
  await p.patchCard(cardMsgId, groupCard(ids));
}

export async function onReviewClick(p: FeishuChannel, v: { d?: Activation }, cardMsgId?: string) {
  if (groupsConf().reviewed) return;
  const d = v.d === "when_mentioned" ? "when_mentioned" : "always";
  await editGroups((doc) => { doc.set("reviewed", true); doc.set("default", d); return `群观察开始，默认 ${d}`; });
  if (cardMsgId) await p.patchCard(cardMsgId, card({ title: "群观察已开始", color: "green", elements: [md(`默认：${ACT_LABEL[d]}。从现在起的消息才会读（不回填历史）。`)] }));
  kvSet("observer.cursor", String(Date.now()));
}

/** `/group <词>` in the admin chat or my DM: a switch card for matching groups; returns the reply text */
export async function groupCommand(p: FeishuChannel, query: string): Promise<string> {
  const admin = channelsConf().feishu.admin_chat;
  if (!admin) return "管理群还没配置（channels.yaml 的 feishu.admin_chat）。";
  const rows = all("SELECT chat_id FROM chats WHERE name LIKE ? OR chat_id=? ORDER BY name LIMIT 8", `%${query}%`, query);
  const id = await p.sendCardTo(admin, groupCard(rows.map((r) => r.chat_id), `群开关：${query}`));
  if (id) kvSet(`groupcard:${id}`, JSON.stringify(rows.map((r) => r.chat_id)));
  return rows.length ? `找到 ${rows.length} 个群，开关卡片发在管理群了。` : "没找到名字里有这个词的群。";
}

/** true when this card row was a Feishu-only one and has been handled */
export async function handleCardRow(p: FeishuChannel, payload: { value?: any; msg?: string }): Promise<boolean> {
  const v = payload.value;
  try {
    if (v?.k === "group") { await onGroupClick(p, v, payload.msg); return true; }
    if (v?.k === "review") { await onReviewClick(p, v, payload.msg); return true; }
  } catch (e) { log("feishu", "card action failed", { k: v?.k, err: String((e as Error)?.message ?? e).slice(0, 300) }); return true; }
  return false;
}
