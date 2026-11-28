// Channel commands answered by code, never the model (§触6.6, §触6.9 并行 F): /approvals, /todo, /tasks, /help, and
// W2a's /pair, /devices (link/service.ts). /stop, /new and /cancel are the dispatcher's own (they act on the lane's
// run). Where they work: my Feishu DM, the admin chat (every line of mine there is a command row) and workbench topics.
// The admin chat and the workbench are shared places: personal items show as one line there, never their titles
// (§读5.1).
import type { Db, Row } from "../db/db.ts";
import { approvalOfCard, cardOf, requestRedraft } from "../approvals.ts";
import { enqueue } from "../outbox.ts";
import { localStamp } from "../time.ts";
import { payloadOf, seesPersonal } from "../turn.ts";
import { OWNER_DM_LANE } from "./feishu/state.ts";

const LIST = 20;
const KIND: Record<string, string> = { send: "发送", plan: "计划", glance: "看一眼", ask: "问我", proposal: "提案", rollback: "回滚" };
const ENDED_TASK = "('done','failed','cancelled')";
const oneLine = (s: unknown, n = 60) => String(s ?? "").replace(/\s+/g, " ").trim().slice(0, n);

export const HELP = [
  "不经模型的命令：",
  "/approvals 列出等你批的；/approvals <编号> 把那张卡再发一次",
  "/todo 等你回的、要你拍板的",
  "/tasks 在跑和排着的任务",
  "/stop 停这一轮；/cancel 停下并撤掉排着的；/new 开新一段（私聊、工作台话题里都行）",
  "/pair、/devices（只在私聊）",
  "在审批卡的话题里回复 = 让它照你说的改稿",
].join("\n");

/** where a re-sent card goes: the same place I asked from (outlet targets, feishu/plugin.ts targetOf) */
function hereOf(lane: string): Record<string, unknown> | undefined {
  if (lane === OWNER_DM_LANE) return { to: "dm", surface: "feishu:dm" };
  if (lane === "feishu:console") return { to: "chat:admin", surface: "feishu:console" };
  if (lane.startsWith("feishu:wb:")) return { to: "chat:workbench", surface: "feishu:workbench" };
  return undefined;
}

/** A pending approval from a personal place (my DM, a personal client thread) — shown as one line in shared places. */
function personalCard(db: Db, originLane: unknown): boolean {
  if (typeof originLane !== "string" || !originLane) return false;
  if (originLane === OWNER_DM_LANE || originLane === "console:main") return true;
  return db.one<{ domain: string }>("SELECT domain FROM threads WHERE lane = ?", originLane)?.domain === "personal";
}

export function channelCommands(db: Db, more?: (name: string, arg: string, lane: string) => string | undefined) {
  return (name: string, arg: string, lane: string): string | undefined => {
    const here = hereOf(lane);
    if (!here) return more?.(name, arg, lane);
    const mine = seesPersonal(lane);
    const title = (a: Row) => (!mine && personalCard(db, a.origin_lane) ? "（私人的一条，到客户端或私聊看）" : oneLine(a.title));
    if (name === "help") return HELP;
    if (name === "approvals") {
      if (arg) {
        const id = Number(/^#?(\d{1,12})$/.exec(arg)?.[1]);
        if (!id) return "用法：/approvals 或 /approvals <编号>";
        const a = db.one("SELECT * FROM approvals WHERE id = ?", id);
        if (!a) return `没有审批 #${id}`;
        if (a.status !== "pending") return `#${id} 已经是 ${a.status} 了`;
        if (!mine && personalCard(db, a.origin_lane)) return `#${id} 是私人的一条，到客户端或私聊里看。`;
        // the plugin notes where it landed (cards_json), so a decision anywhere re-renders this copy too
        enqueue(db, { channel: "feishu", kind: "card", target: here, payload: JSON.stringify(cardOf(a)), lane, idem_key: `approval:${id}:card:again:${Date.now()}` });
        return `#${id} 的卡再发一次。`;
      }
      const rows = db.all("SELECT id, kind, title, origin_lane, expires_at FROM approvals WHERE status = 'pending' ORDER BY id DESC LIMIT ?", LIST + 1);
      if (!rows.length) return "没有等你批的。";
      return [`等你批的 ${rows.length > LIST ? `${LIST}+` : rows.length} 张：`,
        ...rows.slice(0, LIST).map((a) => `· #${a.id} ${KIND[String(a.kind)] ?? a.kind}「${title(a)}」${a.expires_at ? `，${localStamp(Number(a.expires_at)).slice(5)} 前` : ""}`),
        "/approvals <编号> 把卡再发一次"].join("\n");
    }
    if (name === "todo") {
      const decide = db.all("SELECT id, kind, title, origin_lane FROM approvals WHERE status = 'pending' ORDER BY id DESC LIMIT ?", LIST);
      // §读2.4 attn: someone is waiting for my answer; personal places' messages only in my DM
      const waiting = db.all(`SELECT chat_id, text, ts, raw_json FROM messages WHERE attn = 'waiting' ${mine ? "" : "AND COALESCE(domain, 'work') != 'personal'"} ORDER BY ts DESC LIMIT ?`, LIST);
      const follow = db.all("SELECT id, note, due_at FROM timers WHERE kind = 'followup' AND status = 'pending' ORDER BY due_at LIMIT ?", LIST);
      if (!decide.length && !waiting.length && !follow.length) return "现在没有等你回的，也没有要你拍板的。";
      const chatName = (r: Row) => {
        try { return oneLine((JSON.parse(String(r.raw_json ?? "{}")) as { chat_name?: string }).chat_name ?? r.chat_id, 30); } catch { return oneLine(r.chat_id, 30); }
      };
      return [
        ...(waiting.length ? [`等你回 ${waiting.length}：`, ...waiting.map((m) => `· ${localStamp(Number(m.ts)).slice(5)} ${chatName(m)}：${oneLine(m.text, 50)}`)] : []),
        ...(decide.length ? [`要你拍板 ${decide.length}：`, ...decide.map((a) => `· #${a.id} ${KIND[String(a.kind)] ?? a.kind}「${title(a)}」`)] : []),
        ...(follow.length ? [`要跟进 ${follow.length}：`, ...follow.map((t) => `· ${localStamp(Number(t.due_at)).slice(5)} ${mine ? oneLine(t.note) : "（跟进）"}`)] : []),
      ].join("\n");
    }
    if (name === "tasks") {
      const rows = db.all(`SELECT id, goal, status, node, agent FROM tasks WHERE status NOT IN ${ENDED_TASK} ORDER BY ts DESC LIMIT ?`, LIST);
      if (!rows.length) return "没有在跑或排着的任务。";
      return [`任务 ${rows.length}：`, ...rows.map((t) => `· ${t.id} ${t.status}${t.agent ? ` · ${t.agent}` : ""}「${oneLine(t.goal)}」`)].join("\n");
    }
    return more?.(name, arg, lane);
  };
}

/**
 * A line I wrote in the topic of a card the hub sent (dispatch.ts cardReply): an approval card's topic = 改稿 with
 * that line as the note (approvals.requestRedraft; the same as the client's redraft). undefined = that message isn't
 * an approval card, so the line is handled as usual. Only my own lines get here (the plugin stamps the operator and
 * approvals check it against people.yaml again).
 */
export function cardReplies(db: Db, redraftTriage?: (approvalId: number) => void) {
  return (r: Row): string | undefined => {
    const p = payloadOf(r);
    const channel = String(r.source ?? "").split(":")[0] || "unknown";
    const id = approvalOfCard(db, channel, String(p.root_id ?? ""));
    if (!id) return undefined;
    const note = String(p.text ?? "").trim();
    if (!note) return "要它怎么改？在这个话题里直接说。";
    const res = requestRedraft(db, id, { note, by: { kind: "channel", channel, operator: String(p.operator ?? "") }, triage: !!redraftTriage });
    if (!res.ok) return `#${id} 改不了稿：${res.error}`;
    if (res.via === "triage") redraftTriage?.(id);   // requestRedraft has committed; triage drafts on its own time
    return `好，#${id} 让它照这个改，新稿出来会替掉这张。`;
  };
}
