// Feishu observer, user identity (DESIGN §触2.5, §读2.2). Reads the owner's groups; never writes as the owner.
//
//   - every 30 s one global `+messages-search --query ""` over [cursor − 2 min, now], deduped by message_id
//   - rows go to `messages` (triage_status pending | digest | done | skipped); Triage is decoupled (triage.ts)
//   - activation per chat: groups.yaml override > sensitive name → disabled > external / muted → digest > default
//   - loop filter: the owner's own messages void pending drafts for that chat; bot messages and our sends are skipped
//   - first start: no reading until the owner confirms the group-list review card; new groups → a notice card
//   - p2p chats (DMs others send him) only when sources.yaml feishu.dm is on (§读2.1); never the owner↔bot DM, which
//     is the main lane. They go in as surface feishu:p2p, are cached in `chats` (chat_mode p2p), and Triage reads them.
//   - his own message in any observed chat closes the asks it answers there (events.ts markReplied)

import { all, one, run, kvGet, kvSet } from "./db.ts";
import { feishuConf, gateConf, groupsConf, log, ownerFeishu, sourcesConf, type Activation, type GroupsConfig } from "./config.ts";
import { markReplied } from "./events.ts";
import { lark } from "./feishu.ts";
import { card, md, button, buttons, sendCard, patchCard, type Card } from "./cards.ts";
import { editConfig } from "./memory.ts";
import { invalidateForOwnerMessage } from "./approvals.ts";

const POLL_MS = Number(process.env.SBOT_OBSERVE_S ?? 30) * 1000;
const ACT_LABEL: Record<Activation, string> = { always: "全部", when_mentioned: "只看@我", digest: "只出摘要", disabled: "关闭" };

export async function userIdentityReady(): Promise<boolean> {
  // needs_refresh = the access token is near / past expiry but the refresh token is still good; the next user call
  // refreshes it. Treating it as "not ready" stopped every user call, so nothing ever refreshed (idle every 2 h).
  try {
    const u = JSON.parse(await lark(["auth", "status"])).identities?.user;
    if (u?.status === "ready") return true;
    return u?.status === "needs_refresh" && (!u.refreshExpiresAt || Date.parse(u.refreshExpiresAt) > Date.now());
  } catch { return false; }
}

/** Default rules (§触2.5); `why` says which rule applied. */
export function activationOf(chatId: string, name?: string, g: GroupsConfig = groupsConf()): { act: Activation; why: string } {
  const o = g.groups?.[chatId]?.activation;
  if (o) return { act: o, why: "手动设置" };
  const c = one("SELECT * FROM chats WHERE chat_id=?", chatId);
  const n = (name ?? c?.name ?? "").toLowerCase();
  const w = gateConf().sensitive_words.find((x) => n.includes(x.toLowerCase()));
  if (w) return { act: "disabled", why: `敏感词「${w}」` };
  if (c?.external) return { act: "digest", why: "外部群" };
  if (c?.muted) return { act: "digest", why: "免打扰" };
  return { act: g.default ?? "always", why: "默认" };
}

/** Full chat list (user identity) → chats table. Returns the chat ids that were not known before. */
export async function refreshChats(): Promise<string[]> {
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

// ---- group switch cards (/group, new-group notices) ----

export function groupCard(chatIds: string[], title = "群开关"): Card {
  const els: unknown[] = [];
  for (const id of chatIds.slice(0, 8)) {
    const c = one("SELECT * FROM chats WHERE chat_id=?", id);
    const { act, why } = activationOf(id);
    els.push(md(`**${c?.name || id}**${c?.external ? " · 外部" : ""}\n<font color='grey'>现在：${ACT_LABEL[act]}（${why}）</font>`));
    els.push(buttons(...(Object.keys(ACT_LABEL) as Activation[]).map((a) =>
      button(ACT_LABEL[a], { k: "group", chat: id, a }, a === act ? "primary_filled" : "default"))));
  }
  if (!chatIds.length) els.push(md("没有匹配的群。"));
  return card({ title, color: "wathet", elements: els });
}

export async function sendGroupCard(query: string): Promise<string> {
  const admin = feishuConf().admin_chat;
  if (!admin) return "管理群还没配置（config/feishu.yaml 的 admin_chat）。";
  const rows = all("SELECT chat_id FROM chats WHERE name LIKE ? OR chat_id=? ORDER BY name LIMIT 8", `%${query}%`, query);
  const m = await sendCard(admin, groupCard(rows.map((r) => r.chat_id), `群开关：${query}`));
  kvSet(`groupcard:${m.message_id}`, JSON.stringify(rows.map((r) => r.chat_id)));
  return rows.length ? `找到 ${rows.length} 个群，开关卡片发在管理群了。` : "没找到名字里有这个词的群。";
}

export async function onGroupClick(v: { chat: string; a: Activation }, operator: string, cardMsgId: string) {
  if (operator !== ownerFeishu() || !ACT_LABEL[v.a]) return;
  const name = one("SELECT name FROM chats WHERE chat_id=?", v.chat)?.name ?? "";
  editConfig("groups.yaml", (doc) => {
    if (doc.getIn(["groups", v.chat, "activation"]) === v.a) return undefined;
    doc.setIn(["groups", v.chat], doc.createNode({ name, activation: v.a }));
    return `${name || v.chat} → ${v.a}`;
  }, "card");
  const ids = JSON.parse(kvGet(`groupcard:${cardMsgId}`) ?? JSON.stringify([v.chat]));
  await patchCard(cardMsgId, groupCard(ids));
}

// ---- first-run review (§触2.5 ③) ----

async function postReview() {
  const admin = feishuConf().admin_chat;
  if (!admin || kvGet("observer.review_card")) return;
  await refreshChats();
  const rows = all("SELECT * FROM chats");
  const by: Record<Activation, string[]> = { always: [], when_mentioned: [], digest: [], disabled: [] };
  const why: Record<string, number> = {};
  for (const r of rows) { const a = activationOf(r.chat_id, r.name); by[a.act].push(r.name); why[a.why] = (why[a.why] ?? 0) + 1; }
  const m = await sendCard(admin, card({
    title: "开始观察飞书群之前，先过一遍", color: "orange", elements: [
      md(`你在 **${rows.length}** 个群里。按默认规则：\n- 全部进 Triage：${by.always.length}\n- 只出摘要：${by.digest.length}（外部群 ${why["外部群"] ?? 0}、免打扰 ${why["免打扰"] ?? 0}；摘要 M3 才有，在那之前等于不看）\n- 关闭（群名有敏感词，连拉都不拉）：${by.disabled.length}`),
      ...(by.disabled.length ? [md(`关闭的：${by.disabled.slice(0, 40).join("、")}${by.disabled.length > 40 ? " …" : ""}`, true)] : []),
      md("群消息会送到第三方模型做分类。确认后才开始读；之后随时在这里发 `/group 关键词` 改单个群。", true),
      buttons(button("按这个开始", { k: "review", d: "always" }, "primary_filled"), button("先只看 @我 的", { k: "review", d: "when_mentioned" })),
    ],
  }));
  kvSet("observer.review_card", m.message_id);
}

export async function onReviewClick(v: { d: Activation }, operator: string, cardMsgId: string) {
  if (operator !== ownerFeishu() || groupsConf().reviewed) return;
  editConfig("groups.yaml", (doc) => { doc.set("reviewed", true); doc.set("default", v.d === "when_mentioned" ? "when_mentioned" : "always"); return `reviewed, default ${v.d}`; }, "card");
  await patchCard(cardMsgId, card({ title: "群观察已开始", color: "green", elements: [md(`默认：${ACT_LABEL[v.d] ?? v.d}。从现在起的消息才会读（不回填历史）。`)] }));
  kvSet("observer.cursor", String(Date.now()));
}

// ---- polling ----

export class Observer {
  private timer?: NodeJS.Timeout;
  private busy = false;
  private warned = false;

  start() { this.timer = setInterval(() => this.tick(), POLL_MS); this.tick(); }
  stop() { clearInterval(this.timer); }

  private async tick() {
    if (this.busy) return;
    this.busy = true;
    try {
      if (!(await userIdentityReady())) {
        if (!this.warned) log("observer", "user identity not authorized on this host: observer idle");
        this.warned = true;
        return;
      }
      if (this.warned) { log("observer", "user identity back: observer polling again"); this.warned = false; }
      if (!groupsConf().reviewed) { await postReview(); return; }
      if (Date.now() - Number(kvGet("observer.chats_at") ?? 0) > 24 * 3600_000) await this.newGroups(await refreshChats());
      await this.poll();
    } catch (e: any) {
      log("observer", "tick failed", { err: String(e?.message ?? e).slice(0, 300) });
    } finally { this.busy = false; }
  }

  private async newGroups(ids: string[]) {
    const admin = feishuConf().admin_chat;
    if (!admin || !ids.length) return;
    const m = await sendCard(admin, groupCard(ids, `新加入了 ${ids.length} 个群，按默认规则处理`));
    kvSet(`groupcard:${m.message_id}`, JSON.stringify(ids.slice(0, 8)));
  }

  private async poll() {
    const end = Date.now();
    const cursor = Number(kvGet("observer.cursor") ?? end);
    const start = Math.max(cursor - 120_000, end - 6 * 3600_000);   // overlap 2 min; never backfill more than 6 h
    // the search API rejects fractional seconds ("…00.000Z" → 99992402 field validation failed)
    const iso = (ms: number) => new Date(Math.floor(ms / 1000) * 1000).toISOString().replace(/\.\d{3}Z$/, "+00:00");
    const out = await lark(["im", "+messages-search", "--as", "user", "--query", "", "--start", iso(start),
      "--end", iso(end),"--page-all", "--page-size", "50", "--page-limit", "40", "--no-reactions", "--json"], undefined, 120_000);
    const rows: any[] = JSON.parse(out).data?.messages ?? [];
    const { admin_chat, workbench_chat } = feishuConf();
    const owner = ownerFeishu();
    const dm = sourcesConf().feishu.dm, botDm = kvGet("feishu.owner_dm_chat");
    let added = 0, unknownChat = false;
    for (const m of rows) {
      const p2p = m.chat_type === "p2p";
      if ((p2p && (!dm || m.chat_id === botDm)) || m.chat_id === admin_chat || m.chat_id === workbench_chat || m.deleted) continue;
      if (one("SELECT 1 FROM messages WHERE id=?", m.message_id)) continue;
      const s = m.sender ?? {};
      const isOwner = s.id === owner, isBot = s.sender_type && s.sender_type !== "user";
      // the chat list has no DMs: cache the peer's name here (from their own messages) so the chat is never "unknown"
      if (p2p) run(`INSERT INTO chats(chat_id, name, external, muted, chat_mode, seen_at) VALUES(?,?,0,0,'p2p',?) ON CONFLICT(chat_id) DO UPDATE SET
          name=CASE WHEN excluded.name<>'' THEN excluded.name ELSE chats.name END, seen_at=excluded.seen_at`, m.chat_id, isOwner || isBot ? "" : s.name ?? "", Date.now());
      else if (!one("SELECT 1 FROM chats WHERE chat_id=?", m.chat_id)) unknownChat = true;
      const chatName = p2p ? one("SELECT name FROM chats WHERE chat_id=?", m.chat_id)?.name || m.chat_name || "私聊" : m.chat_name;
      const { act } = activationOf(m.chat_id, chatName);
      if (act === "disabled") continue;
      const ours = !!one("SELECT 1 FROM outbox WHERE sent_msg_id=?", m.message_id);
      const status = isOwner ? "done" : isBot || ours ? "skipped" : act === "digest" ? "digest" : "pending";
      const ts = searchTime(m.create_time);
      run(`INSERT OR IGNORE INTO messages(id, surface, chat_id, thread_id, sender_id, sender_kind, ts, text, raw_json, triage_status)
           VALUES(?,?,?,?,?,?,?,?,?,?)`, m.message_id, p2p ? "feishu:p2p" : "feishu:group", m.chat_id, m.thread_id ?? null, s.id ?? null,
        isOwner ? "owner" : isBot ? "bot" : "other", ts, String(m.content ?? ""),
        JSON.stringify({ chat_name: chatName, sender_name: s.name, msg_type: m.msg_type, link: m.message_app_link, reply_to: m.reply_to,
          pos: Number(m.message_position) || undefined,   // create_time is per minute; this orders messages inside a chat
          mentions: (m.mentions ?? []).map((x: any) => x.id), names: (m.mentions ?? []).map((x: any) => x.name) }), status);
      added++;
      if (isOwner) { invalidateForOwnerMessage(m.chat_id, ts, m.message_id); markReplied(m.chat_id, ts, m.reply_to, { id: m.message_id, thread: m.thread_id, pos: Number(m.message_position) || undefined, mentions: (m.mentions ?? []).map((x: any) => x.id) }); }
    }
    kvSet("observer.cursor", String(end));
    if (added) log("observer", "polled", { rows: rows.length, added });
    if (unknownChat && Date.now() - Number(kvGet("observer.chats_at") ?? 0) > 10 * 60_000) await this.newGroups(await refreshChats());
  }
}

/** search rows: "2026-11-17 08:08" in UTC+8, minute precision */
function searchTime(v: unknown): number {
  const m = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2})(:\d{2})?$/.exec(String(v ?? ""));
  return m ? Date.parse(`${m[1]}T${m[2]}${m[3] ?? ":00"}+08:00`) : Number(v) || Date.now();
}
