// 飞书邮箱, a built-in source (DESIGN §17.3): sources.yaml `kind: feishu-mail`. New mail goes the way group messages
// go: Triage sorts it, events land on matters. Read as the owner through the core's lark-cli login, which is why this
// lives in the core and not in a plugin: a plugin must never get that login.
//
//   read only     exactly three API calls below (list, batch_get, send_as); reading a body does not mark it read
//   baseline      the first poll reads metadata only and remembers what is already there: no history comes in
//   walk          INBOX and SENT, newest first, until a page has nothing new or a mail is older than the floor
//   one place per thread   `where` = thread id, so his reply closes the asks of that thread and no other
//   untrusted     anyone on the internet can write these fields. The subject stays in the text (Triage fences it);
//                 place names and sender names reach prompts unfenced, so the place is fixed and the name is scrubbed

import { one } from "./db.ts";
import { gateConf, log } from "./config.ts";
import { lark } from "./feishu.ts";
import type { Poll, SourceItem } from "./sources.ts";

const FOLDERS = ["INBOX", "SENT"];
const PAGE = 20;              // the API's maximum for both list and batch_get
const MAX_PER_POLL = 200;     // per folder; after a long outage the newest win
const MAX_TO = 10;            // more people than this on To: is a broadcast, even with his name among them
const BODY_MAX = 3000;
const SKIP_KEEP = 500;
const ME_TTL = 6 * 3600_000;

async function api(resource: string, method: string, params: Record<string, unknown>, data?: unknown): Promise<any> {
  const args = ["mail", resource, method, "--params", JSON.stringify({ user_mailbox_id: "me", ...params }), "--as", "user"];
  if (data !== undefined) args.push("--data", JSON.stringify(data));
  const j = JSON.parse(await lark(args, undefined, 90_000));
  if (j.ok === false) throw new Error(`邮箱接口 ${method} 失败：${String(j.error?.message ?? j.error?.code ?? "").slice(0, 200)}`);
  return j.data ?? {};
}

const list = (folder: string, token?: string) =>
  api("user_mailbox.messages", "list", { folder_id: folder, page_size: PAGE, ...(token ? { page_token: token } : {}) });

async function fetchMails(ids: string[], format: "metadata" | "plain_text_full"): Promise<any[]> {
  if (!ids.length) return [];
  return (await api("user_mailbox.messages", "batch_get", {}, { format, message_ids: ids })).messages ?? [];
}

const addr = (x: any) => String(x?.mail_address ?? "").trim().toLowerCase();

let me: { at: number; addrs: Set<string> } | undefined;
/** his primary address and aliases. A failure fails the poll: guessing would make to_me / from_me wrong. */
async function myAddresses(): Promise<Set<string>> {
  if (me && Date.now() - me.at < ME_TTL) return me.addrs;
  const rows: any[] = (await api("user_mailbox.settings", "send_as", {})).sendable_addresses ?? [];
  const addrs = new Set(rows.filter((r) => r.email_type === "USER_PRIMARY" || r.email_type === "USER_ALIAS")
    .map((r) => String(r.email_address ?? "").trim().toLowerCase()).filter(Boolean));
  if (!addrs.size) throw new Error("没拿到自己的邮箱地址");
  me = { at: Date.now(), addrs };
  return addrs;
}

// Feishu's plain text is usually one flattened line, so quotes are found by their headers, not by line starts
const QUOTE = [
  /(?:发件人|寄件人|(?<![A-Za-z])From)\s*[:：][^]{0,200}?(?:发送时间|发件时间|日期|时间|收件人|主题|(?<![A-Za-z])(?:Sent|Date|To|Subject))\s*[:：]/i,
  /-{2,}\s*(?:原始邮件|转发邮件|回复的原邮件|Original Message|Forwarded message|Replied Message)/i,
  /\bOn\s[^\n]{5,200}?\swrote\s*:/,
  /在[^\n]{5,100}?写道\s*[:：]/,
];
// only near the end of what is left: these words can also appear in a real sentence
const SIGNATURE = [
  /^--\s*$/m,
  /发自我的|来自我的|Sent from my|Sent from Outlook|Get Outlook for/i,
  /Best regards|Kind regards|Warm regards|此致\s*敬礼|顺颂(?:商祺|时祺)/i,
  /本邮件及其附件|此邮件(?:及其附件)?(?:含有|包含)|保密声明|免责声明|confidentiality notice|this (?:e-?mail|message)[^.\n]{0,40}(?:confidential|privileged)/i,
];
const SIGNATURE_TAIL = 800;

/** what this mail itself says: no quoted history, no signature, bounded */
export function cleanMailBody(raw: string, max = BODY_MAX): string {
  const t = String(raw ?? "").replace(/\r\n?/g, "\n").replace(/[​-‍﻿]/g, "").replace(/ /g, " ")
    .split("\n").filter((l) => !/^\s*>/.test(l)).join("\n");
  let cut = t.length;
  for (const re of QUOTE) { const m = re.exec(t); if (m && m.index < cut) cut = m.index; }
  let head = t.slice(0, cut).trim() || t.trim();   // a bare forward: the quoted mail is the content
  for (const re of SIGNATURE) {
    const m = re.exec(head);
    if (m && m.index > 0 && head.length - m.index <= SIGNATURE_TAIL) head = head.slice(0, m.index).trim();
  }
  head = head.replace(/[ \t]{2,}/g, " ").replace(/\n{3,}/g, "\n\n");
  return head.length > max ? `${head.slice(0, max)}…（后面截断了）` : head;
}

/** a display name, safe to show outside <untrusted>: letters, digits and a little punctuation, short */
const scrubName = (s: unknown) => String(s ?? "").replace(/[^\p{L}\p{N} .·_-]/gu, " ").replace(/\s+/g, " ").trim().slice(0, 24);

const bodyOf = (m: any) => m.body_plain_text ? Buffer.from(String(m.body_plain_text), "base64url").toString("utf8") : "";

export function mailItem(m: any, folder: string, mine: Set<string>, sourceId: string): SourceItem {
  const to: any[] = Array.isArray(m.to) ? m.to : [];
  const fromMe = folder === "SENT" || mine.has(addr(m.head_from));
  const subject = String(m.subject ?? "").replace(/\s+/g, " ").trim().slice(0, 200) || "（无主题）";
  const body = cleanMailBody(bodyOf(m));
  return {
    ref: m.message_id, ts: Number(m.internal_date), text: `主题：${subject}${body ? `\n${body}` : ""}`,
    who: fromMe ? undefined : scrubName(m.head_from?.name) || addr(m.head_from).slice(0, 60) || undefined,
    // one place per thread: his reply answers this conversation, not every mail waiting on him
    where: String(m.thread_id || m.message_id), where_name: sourceId, thread: m.thread_id || undefined,
    from_me: fromMe, to_me: !fromMe && to.length <= MAX_TO && to.some((x) => mine.has(addr(x))),
  };
}

// The floor is the baseline, not the poll cursor: whatever arrived after it and is not in `messages` yet still comes in,
// so a failed or slow poll loses nothing. Dedup is by message id (`messages`, plus the skip list for mail we passed on).
export const feishuMail: Poll = async (s, st) => {
  const t0 = Date.now();
  const mine = await myAddresses();
  const base = Number(st.get("base") ?? 0);
  if (!base) {
    const old: string[] = [];
    for (const folder of FOLDERS) {
      const ms = await fetchMails((await list(folder)).items ?? [], "metadata");
      old.push(...ms.filter((m) => Number(m.internal_date) < t0).map((m) => String(m.message_id)));
    }
    st.set("skip", JSON.stringify(old));
    st.set("base", String(t0));
    return [];
  }
  const floor = base;
  // only mail we decided not to take is remembered here; what we took is in `messages`, so a crash loses nothing
  const skip = new Set<string>(JSON.parse(st.get("skip") ?? "[]"));
  // case-sensitive: lowercased, "HR" would match "three" and "chrome" in English subjects
  const sensitive = gateConf().sensitive_words.filter(Boolean);
  const out = new Map<string, SourceItem>();
  const known = (id: string) => skip.has(id) || out.has(id) || !!one("SELECT 1 FROM messages WHERE id=?", `src:${s.id}:${id.slice(0, 200)}`);
  for (const folder of FOLDERS) {
    let token: string | undefined, taken = 0;
    for (;;) {
      const page = await list(folder, token);
      const fresh = ((page.items ?? []) as string[]).filter((id) => !known(id));
      if (!fresh.length) break;   // newest first: nothing new here means nothing new below
      let reachedOld = false;
      for (const m of await fetchMails(fresh, "plain_text_full")) {
        const id = String(m.message_id), subject = String(m.subject ?? "");
        if (!(Number(m.internal_date) >= floor)) { skip.add(id); reachedOld = true; continue; }
        if (sensitive.some((w) => subject.includes(w))) { skip.add(id); continue; }   // like a sensitive group name: never read on
        out.set(id, mailItem(m, folder, mine, s.id));
        taken++;
      }
      if (reachedOld || !page.has_more || !page.page_token) break;
      if (taken >= MAX_PER_POLL) { log("sources", "mail poll capped, older new mail not taken", { id: s.id, folder, taken }); break; }
      token = page.page_token;
    }
  }
  st.set("skip", JSON.stringify([...skip].slice(-SKIP_KEEP)));
  return [...out.values()].sort((a, b) => Number(a.ts) - Number(b.ts));
};
