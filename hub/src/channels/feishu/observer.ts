// Reading groups as me (§读2.2, §触2.5), ported from core/src/observer.ts. Every 30 s: search the messages I can see
// since the cursor (2 min overlap, never more than 6 h back) and record them for triage. Runs in shadow mode too.
// Group switches and the first-run review are cards in the admin chat; their clicks come back through actions.ts.
import { channelsConf, gateConf, groupsConf, sourcesConf, type Activation } from "../../config/load.ts";
import { all, kvGet, kvSet, one, run } from "../../db/ambient.ts";
import { markReplied } from "../../ledgers/events.ts";
import { log } from "../../log.ts";
import { button, buttons, card, md, type FeishuCard } from "./cards.ts";
import type { FeishuChannel } from "./plugin.ts";
import { ownerFeishu } from "./plugin.ts";
import { ownerDmChat } from "./state.ts";
import { userIdentityReady, type Lark } from "./user.ts";

const POLL_MS = Number(process.env.SBOT_OBSERVE_S ?? 30) * 1000;
export const ACT_LABEL: Record<Activation, string> = { always: "全部", when_mentioned: "只看@我", digest: "只出摘要", disabled: "关闭" };

/** set by approvals (W1d): a message I sent myself in a chat voids pending drafts there (§触2.4) */
export const observerHooks: { ownerMessage: (chat: string, ts: number, msgId: string) => void } = { ownerMessage: () => {} };

type GroupsConfig = ReturnType<typeof groupsConf>;

/** default rules (§触2.5); `why` says which applied */
export function activationOf(chatId: string, name?: string, g: GroupsConfig = groupsConf()): { act: Activation; why: string } {
  const o = g.groups?.[chatId]?.activation;
  if (o) return { act: o, why: "手动设置" };
  const c = one("SELECT * FROM chats WHERE chat_id=?", chatId);
  const n = String(name ?? c?.name ?? "").toLowerCase();
  const w = gateConf().sensitive_words.find((x) => n.includes(x.toLowerCase()));
  if (w) return { act: "disabled", why: `敏感词「${w}」` };
  if (c?.external) return { act: "digest", why: "外部群" };
  if (c?.muted) return { act: "digest", why: "免打扰" };
  return { act: g.default ?? "always", why: "默认" };
}

/** full chat list → chats; returns ids not known before (empty on the very first fill) */
export async function refreshChats(lark: Lark): Promise<string[]> {
  const list = async (muted: boolean) => {
    const out = await lark(["im", "+chat-list", "--as", "user", "--page-all", "--page-size", "100", "--page-limit", "30", "--page-delay", "100",
      ...(muted ? ["--exclude-muted"] : []), "--json"], undefined, 180_000);
    return (JSON.parse(out).data?.chats ?? []) as any[];
  };
  const chats = await list(false);
  const unmuted = new Set((await list(true)).map((c) => c.chat_id));
  const known = new Set(all("SELECT chat_id FROM chats").map((r) => r.chat_id));
  const fresh: string[] = [];
  for (const c of chats) {
    if (!known.has(c.chat_id)) fresh.push(c.chat_id);
    run(`INSERT INTO chats(chat_id, name, external, muted, chat_mode, seen_at) VALUES(?,?,?,?,?,?) ON CONFLICT(chat_id) DO UPDATE SET
         name=excluded.name, external=excluded.external, muted=excluded.muted, chat_mode=excluded.chat_mode, seen_at=excluded.seen_at`,
      c.chat_id, c.name ?? "", c.external ? 1 : 0, unmuted.has(c.chat_id) ? 0 : 1, c.chat_mode ?? "", Date.now());
  }
  kvSet("observer.chats_at", String(Date.now()));
  log("observer", "chat list refreshed", { chats: chats.length, new: known.size ? fresh.length : 0 });
  return known.size ? fresh : [];
}

export function groupCard(chatIds: string[], title = "群开关"): FeishuCard {
  const els: unknown[] = [];
  for (const id of chatIds.slice(0, 8)) {
    const c = one("SELECT * FROM chats WHERE chat_id=?", id);
    const { act, why } = activationOf(id);
    els.push(md(`**${c?.name || "（无名群）"}**${c?.external ? " · 外部" : ""}\n<font color='grey'>现在：${ACT_LABEL[act]}（${why}）</font>`));
    els.push(buttons(...(Object.keys(ACT_LABEL) as Activation[]).map((a) =>
      button(ACT_LABEL[a], { k: "group", chat: id, a }, a === act ? "primary_filled" : "default"))));
  }
  if (!chatIds.length) els.push(md("没有匹配的群。"));
  return card({ title, color: "wathet", elements: els });
}

export function reviewCard(): FeishuCard {
  const rows = all("SELECT * FROM chats");
  const by: Record<Activation, string[]> = { always: [], when_mentioned: [], digest: [], disabled: [] };
  const why: Record<string, number> = {};
  for (const r of rows) { const a = activationOf(r.chat_id, r.name); by[a.act].push(r.name); why[a.why] = (why[a.why] ?? 0) + 1; }
  return card({
    title: "开始观察飞书群之前，先过一遍", color: "orange", elements: [
      md(`你在 **${rows.length}** 个群里。按默认规则：\n- 全部进分拣：${by.always.length}\n- 只出摘要：${by.digest.length}（外部群 ${why["外部群"] ?? 0}、免打扰 ${why["免打扰"] ?? 0}）\n- 关闭（群名有敏感词，连拉都不拉）：${by.disabled.length}`),
      ...(by.disabled.length ? [md(`关闭的：${by.disabled.slice(0, 40).join("、")}${by.disabled.length > 40 ? " …" : ""}`, true)] : []),
      md("群消息会送到第三方模型做分类。确认后才开始读；之后随时在管理群发 `/group 关键词` 改单个群。", true),
      buttons(button("按这个开始", { k: "review", d: "always" }, "primary_filled"), button("先只看 @我 的", { k: "review", d: "when_mentioned" })),
    ],
  });
}

/** search rows: "2026-11-17 08:08" in UTC+8, minute precision */
export function searchTime(v: unknown): number {
  const m = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2})(:\d{2})?$/.exec(String(v ?? ""));
  return m ? Date.parse(`${m[1]}T${m[2]}${m[3] ?? ":00"}+08:00`) : Number(v) || Date.now();
}

export class Observer {
  #timer?: NodeJS.Timeout;
  #busy = false;
  #warned = false;
  #lark: Lark;
  #plugin: FeishuChannel;

  constructor(o: { lark: Lark; plugin: FeishuChannel }) { this.#lark = o.lark; this.#plugin = o.plugin; }

  start() { this.#timer = setInterval(() => void this.tick(), POLL_MS); void this.tick(); }
  stop() { clearInterval(this.#timer); }

  async tick() {
    if (this.#busy) return;
    this.#busy = true;
    try {
      if (!(await userIdentityReady(this.#lark))) {
        if (!this.#warned) log("observer", "user identity not authorized on this host: observer idle");
        this.#warned = true;
        return;
      }
      if (this.#warned) { log("observer", "user identity back: polling again"); this.#warned = false; }
      if (!groupsConf().reviewed) { await this.#postReview(); return; }
      if (Date.now() - Number(kvGet("observer.chats_at") ?? 0) > 24 * 3600_000) await this.#newGroups(await refreshChats(this.#lark));
      await this.poll();
    } catch (e) {
      log("observer", "tick failed", { err: String((e as Error)?.message ?? e).slice(0, 300) });
    } finally { this.#busy = false; }
  }

  async #postReview() {
    const admin = channelsConf().feishu.admin_chat;
    if (!admin || kvGet("observer.review_card")) return;
    await refreshChats(this.#lark);
    const id = await this.#plugin.sendCardTo(admin, reviewCard());
    if (id) kvSet("observer.review_card", id);
  }

  async #newGroups(ids: string[]) {
    const admin = channelsConf().feishu.admin_chat;
    if (!admin || !ids.length) return;
    const id = await this.#plugin.sendCardTo(admin, groupCard(ids, `新加入了 ${ids.length} 个群，按默认规则处理`));
    if (id) kvSet(`groupcard:${id}`, JSON.stringify(ids.slice(0, 8)));
  }

  async poll() {
    const end = Date.now();
    const cursor = Number(kvGet("observer.cursor") ?? end);
    const start = Math.max(cursor - 120_000, end - 6 * 3600_000);
    // the search API rejects fractional seconds
    const iso = (ms: number) => new Date(Math.floor(ms / 1000) * 1000).toISOString().replace(/\.\d{3}Z$/, "+00:00");
    const out = await this.#lark(["im", "+messages-search", "--as", "user", "--query", "", "--start", iso(start),
      "--end", iso(end), "--page-all", "--page-size", "50", "--page-limit", "40", "--no-reactions", "--json"], undefined, 120_000);
    const rows: any[] = JSON.parse(out).data?.messages ?? [];
    const { admin_chat, workbench_chat } = channelsConf().feishu;
    const owner = ownerFeishu();
    const src = sourcesConf(), dm = src.feishu.dm, botDm = ownerDmChat();
    let added = 0, unknownChat = false;
    for (const m of rows) {
      const p2p = m.chat_type === "p2p";
      if ((p2p && (!dm || m.chat_id === botDm)) || m.chat_id === admin_chat || m.chat_id === workbench_chat || m.deleted) continue;
      const s = m.sender ?? {};
      if (src.exclude.chats.includes(m.chat_id) || (s.id && src.exclude.persons.includes(s.id))) continue;   // Y5
      if (one("SELECT 1 FROM messages WHERE id=?", m.message_id)) continue;
      const isOwner = !!owner && s.id === owner, isBot = s.sender_type && s.sender_type !== "user";
      // the chat list has no DMs: keep the peer's name from their own messages so the chat is never 「unknown」
      if (p2p) run(`INSERT INTO chats(chat_id, name, external, muted, chat_mode, seen_at) VALUES(?,?,0,0,'p2p',?) ON CONFLICT(chat_id) DO UPDATE SET
          name=CASE WHEN excluded.name<>'' THEN excluded.name ELSE chats.name END, seen_at=excluded.seen_at`, m.chat_id, isOwner || isBot ? "" : s.name ?? "", Date.now());
      else if (!one("SELECT 1 FROM chats WHERE chat_id=?", m.chat_id)) unknownChat = true;
      const chatName = p2p ? one("SELECT name FROM chats WHERE chat_id=?", m.chat_id)?.name || m.chat_name || "私聊" : m.chat_name;
      const { act } = activationOf(m.chat_id, chatName);
      if (act === "disabled") continue;
      const ours = !!one("SELECT 1 FROM outbox WHERE sent_msg_id=?", m.message_id);
      const status = isOwner ? "done" : isBot || ours ? "skipped" : act === "digest" ? "digest" : "pending";
      const ts = searchTime(m.create_time);
      const mentions = (m.mentions ?? []).map((x: any) => x.id);
      run(`INSERT OR IGNORE INTO messages(id, surface, chat_id, thread_id, sender_id, sender_kind, ts, text, raw_json, domain, triage_status)
           VALUES(?,?,?,?,?,?,?,?,?,?,?)`, m.message_id, p2p ? "feishu:p2p" : "feishu:group", m.chat_id, m.thread_id ?? null, s.id ?? null,
        isOwner ? "owner" : isBot ? "bot" : "other", ts, String(m.content ?? ""),
        JSON.stringify({ chat_name: chatName, sender_name: s.name, msg_type: m.msg_type, link: m.message_app_link, reply_to: m.reply_to,
          pos: Number(m.message_position) || undefined, mentions, names: (m.mentions ?? []).map((x: any) => x.name) }),
        p2p ? null : "work", status);
      added++;
      if (isOwner) {
        observerHooks.ownerMessage(m.chat_id, ts, m.message_id);
        markReplied(m.chat_id, ts, m.reply_to, { id: m.message_id, thread: m.thread_id, pos: Number(m.message_position) || undefined, mentions });
      }
    }
    kvSet("observer.cursor", String(end));
    if (added) log("observer", "polled", { rows: rows.length, added });
    if (unknownChat && Date.now() - Number(kvGet("observer.chats_at") ?? 0) > 10 * 60_000) await this.#newGroups(await refreshChats(this.#lark));
  }
}
