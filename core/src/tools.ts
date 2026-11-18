// Harness-independent tool layer (DESIGN §4.0, §4.1, §7.1). A tool = zod schema + TS function + action level.
// The gate lives here, in the wrapper, before any side effect: both pi and the SDK go through `callTool`.
// L2 tools (send, request_approval) never act themselves: they write a pending approval and return at once (§7.2A);
// the owner's click is a new event. Worker L2 tools (git_push) are gated in tasks.ts with PreToolUse defer (§7.2B).

import { z } from "zod";
import { appendJournal, localStamp, readPage, type Principal } from "./memory.ts";
import { searchWiki } from "./wiki.ts";
import { all, one, run, tx, kvGet, kvSet } from "./db.ts";
import { PROXY_BASE, feishuConf, gateConf, log, ownerName } from "./config.ts";
import { submitApproval, postCards } from "./approvals.ts";
import { complete } from "./proxy.ts";
import { activationOf } from "./observer.ts";
import { addFollowup, cancelFollowup, listFollowups, parseLocal } from "./timers.ts";
import { PLAYBOOK, SECTIONS, listMatters, noteMatter, openMatter, setMatterStatus } from "./matters.ts";
import { cancelTask, listTasks, replyTask, startTask } from "./tasks.ts";
import { DOMAINS, addNote, markSelfItem, periodOk, revisitOutlook, selfItemsText, submitOutlook, submitReview, timelineText } from "./life.ts";
import { queueMatterReview } from "./reflect.ts";
import { personCard, resolveForTool, pathBetween, addRelation, REL_PRESETS } from "./graph.ts";
import { LENSES, readingsQuery, requestReading, revisitReading } from "./lens.ts";
import { LEVELS, STATES, addMatterKeys, eventLine, eventsQuery, linkEvents, matterKeys, setEventLevel, setEventState, topicCandidates } from "./events.ts";

export interface TurnContext { channel: "feishu"; chat_id: string; message_id?: string; thread_id?: string; in_thread?: boolean; surface: string }
export interface RunCtx {
  runId: string; lane: string; principal: Principal; turn: TurnContext;
  src: string;          // journal source tag, set by code (§8.3)
  token: string;        // this run's LLM proxy token (for tools that call a model, e.g. web_search)
  replies: number;      // reply() calls so far; the dispatcher only auto-sends the final text when this is 0
}
export type Level = "L0" | "L1" | "L2";
export interface ToolDef<S extends z.ZodObject = z.ZodObject> {
  name: string; description: string; schema: S; level: Level;
  /** who may see the tool at all (§4.1: tools are given per session type, not per trust in the model) */
  for: Principal[];
  exec(args: z.infer<S>, ctx: RunCtx): Promise<string>;
}
const def = <S extends z.ZodObject>(d: ToolDef<S>) => d as unknown as ToolDef;

/** Queue a message to the run's own input source. Counted as a side effect in the same transaction (§1.2). */
export function queueReply(ctx: Pick<RunCtx, "runId" | "lane" | "turn">, text: string) {
  return tx(() => {
    const r = run(`INSERT INTO outbox(run_id, lane, channel, target_json, payload, idem_key, send_by, ts) VALUES(?,?,?,?,?,?,?,?)`,
      ctx.runId, ctx.lane, ctx.turn.channel, JSON.stringify(ctx.turn), text, null, Date.now() + 2 * 3600_000, Date.now());
    const id = Number(r.lastInsertRowid);
    run("UPDATE outbox SET idem_key=? WHERE id=?", `sbot-ob-${id}`, id);
    run("UPDATE runs SET side_effects = side_effects + 1 WHERE id=?", ctx.runId);
    return id;
  });
}

export const TOOLS: ToolDef[] = [
  def({
    name: "reply", level: "L0", for: ["owner", "known", "other"],
    description: "Send a message to the person you are talking with, right now, in the current chat. Use it for an early heads-up before slow work (\"查一下，稍等\") or when you need several messages. Your final answer is sent automatically if you never call this tool, so don't use it just to deliver the final answer.",
    schema: z.object({ text: z.string().min(1).describe("Markdown text") }),
    async exec({ text }, ctx) { queueReply(ctx, text); ctx.replies++; return "queued"; },
  }),
  def({
    name: "memory_append", level: "L0", for: ["owner", "known", "other"],
    description: "Write one line into today's journal. Use it during the conversation for anything worth keeping long-term (decisions, facts about people, promises, preferences). Compaction and session rollover lose details; the journal does not.",
    schema: z.object({ text: z.string().min(1).max(2000) }),
    async exec({ text }, ctx) { return `appended to ${appendJournal(text, ctx.src)}`; },
  }),
  def({
    name: "memory_search", level: "L0", for: ["owner", "known", "other"],
    description: "Full-text search over memory pages (journal, people, projects, topics, matters…; index.md lists every page). Pages that contain all the words come first; returns path:line: text. Then memory_read the page.",
    schema: z.object({ query: z.string().min(1).describe("space-separated words; Chinese works as substrings (3+ characters match best)") }),
    async exec({ query }, ctx) { return searchWiki(query, ctx.principal); },
  }),
  def({
    name: "memory_read", level: "L0", for: ["owner", "known", "other"],
    description: "Read one memory page by its path relative to the memory root, e.g. journal/2026-11-17.md or people/wife.md.",
    schema: z.object({ path: z.string().min(1) }),
    async exec({ path }, ctx) {
      // §15.9: the full habit / rhythm files and charts never go into Feishu (a company system); single items via self_list
      if (ctx.turn.channel === "feishu" && /^\/*self\/(habits\.md|rhythms\.md|charts\/)/.test(path)) return "这个文件不在飞书里整份读；用 self_list 看具体条目，只引用相关的一两条。";
      return readPage(path, ctx.principal);
    },
  }),
  def({
    name: "web_search", level: "L0", for: ["owner", "known", "other"],
    description: "Search the web. Returns a short digest with source URLs. Use for anything current or that you are unsure of.",
    schema: z.object({ query: z.string().min(1) }),
    async exec({ query }, ctx) { return webSearch(query, ctx.token); },
  }),

  // ---- outward (L2, submit-style approval) ----
  def({
    name: "send", level: "L2", for: ["owner"],
    description: "Send a Feishu message somewhere other than this conversation (a group or a person's chat), as the owner himself (as=user) or as the bot (as=bot). Never sends directly: it puts an approval card in the admin group and returns at once; the exact text is sent only after the owner taps 发送. Find chat_id with feishu_chats.",
    schema: z.object({
      chat_id: z.string().regex(/^oc_/), text: z.string().min(1).max(8000),
      as: z.enum(["user", "bot"]).default("user").describe("user = in the owner's name (needs him to be in the chat); bot = as SStudioBot (needs the bot in the chat)"),
      reply_to: z.string().regex(/^om_/).optional().describe("message_id to reply to"), in_thread: z.boolean().default(false),
    }),
    async exec({ chat_id, text, as, reply_to, in_thread }, ctx) {
      const c = one("SELECT * FROM chats WHERE chat_id=?", chat_id);
      const id = submitApproval({
        kind: "send", title: `发送 · ${c?.name || chat_id}`, requester: "主 agent", draft: text, run_id: ctx.runId, origin_lane: ctx.lane,
        channel: "feishu", as_identity: as,
        target: { channel: "feishu", chat_id, message_id: reply_to, in_thread, surface: "feishu:group" },
        context: { chat_name: c?.name, in_thread, turn: ctx.turn },
      });
      await postCards();
      return `已提交审批 #${id}，卡片在管理群。他点「发送」后原样发出；要改他会在卡片下说。不要再重复提交同一条。`;
    },
  }),
  def({
    name: "request_approval", level: "L2", for: ["owner", "known"],
    description: "Ask the owner to approve a plan before you act on it (for anything with consequences that no other tool covers). Returns at once; when he decides, you get an approval event in this conversation and continue then.",
    schema: z.object({ title: z.string().min(1).max(80), plan: z.string().min(1).max(4000) }),
    async exec({ title, plan }, ctx) {
      const id = submitApproval({ kind: "plan", title, draft: plan, requester: ctx.principal === "owner" ? "主 agent" : `对话 ${ctx.lane}`, run_id: ctx.runId, origin_lane: ctx.lane, context: { turn: ctx.turn } });
      await postCards();
      return `已提交审批 #${id}。结果出来会作为一条新消息回到这里。`;
    },
  }),

  // ---- Feishu groups (read what the observer stored) ----
  def({
    name: "feishu_chats", level: "L0", for: ["owner"],
    description: "Find the owner's Feishu group chats by name. Returns chat_id, name and whether the observer reads it.",
    schema: z.object({ query: z.string().default("") }),
    async exec({ query }) {
      const rows = all("SELECT * FROM chats WHERE name LIKE ? ORDER BY seen_at DESC LIMIT 20", `%${query}%`);
      return rows.map((c) => `${c.chat_id} ${c.name}${c.external ? "（外部）" : ""} · 观察：${activationOf(c.chat_id).act}`).join("\n") || "（没找到）";
    },
  }),
  def({
    name: "feishu_read", level: "L0", for: ["owner"],
    description: "Read recent messages of one group chat as stored by the observer (only chats it reads), oldest first.",
    schema: z.object({ chat_id: z.string().regex(/^oc_/), hours: z.number().min(1).max(24 * 14).default(24), limit: z.number().min(1).max(200).default(60) }),
    async exec({ chat_id, hours, limit }) {
      const rows = all("SELECT * FROM messages WHERE chat_id=? AND ts>=? ORDER BY ts DESC, id DESC LIMIT ?", chat_id, Date.now() - hours * 3600_000, limit).reverse();
      if (!rows.length) return "（这段时间没有记录。可能这个群没被观察，或者确实没人说话）";
      return rows.map((m) => {
        const raw = JSON.parse(m.raw_json ?? "{}");
        const who = m.sender_kind === "owner" ? `${ownerName()}（主人）` : m.sender_kind === "bot" ? "bot" : raw.sender_name ?? "?";
        return `[${localStamp(m.ts).slice(5)}] ${who}${m.thread_id ? "（话题）" : ""}：${String(m.text).slice(0, 600)}`;
      }).join("\n");
    },
  }),

  // ---- tasks (§4.2) ----
  def({
    name: "task_start", level: "L1", for: ["owner"],
    description: "Start a background worker for a substantial job (coding, research, writing a document, anything taking more than a couple of minutes). By default it runs on the server itself (full network and tailnet, sudo, ssh to the owner's machines, skills), posts progress in a workbench topic, may ask questions (they come back to you), and reports back here when done. Give it everything it needs in goal/context: it cannot see this conversation or memory.",
    schema: z.object({
      goal: z.string().min(1).max(2000), context: z.string().max(20_000).optional(),
      tier: z.enum(["work", "chat"]).default("work").describe("work (the execution tier) for almost everything; chat only when it needs the strongest reasoning"),
      repo: z.string().optional().describe("name of a repo in config/repos.yaml, if it needs to change code"),
      mode: z.enum(["host", "sandbox"]).optional().describe("host (the default, from config/worker.yaml): runs on the server with full access, for almost everything. sandbox: isolated, no network except allow_domains, no sudo or ssh. If the job will feed the worker untrusted content (unknown websites, a stranger's repo, files someone else sent) and could do harm with full access, ask the owner whether to use sandbox before starting it"),
      allow_domains: z.array(z.string()).max(20).default([]).describe("sandbox mode only: domains its commands may reach (e.g. registry.npmjs.org); empty = none"),
      budget: z.number().min(10_000).max(1_000_000).optional().describe("output-token budget, default 150000"),
      timeout_min: z.number().min(5).max(240).optional(), matter_id: z.number().optional(),
    }),
    async exec(a, ctx) {
      const id = startTask({ goal: a.goal, context: a.context, tier: a.tier, repo: a.repo, allow: a.allow_domains, mode: a.mode, budget: a.budget, timeoutMin: a.timeout_min,
        matterId: a.matter_id, originLane: ctx.lane, originTurn: ctx.turn });
      return `已开工：任务 #${id}。${feishuConf().workbench_chat ? "工作台开了一个话题，进度和结果在那里；" : ""}做完、出错或者它有问题要问，都会回到这里。`;
    },
  }),
  def({ name: "task_list", level: "L0", for: ["owner"], description: "List tasks (unfinished by default).",
    schema: z.object({ all: z.boolean().default(false) }), async exec({ all }) { return listTasks(!all); } }),
  def({ name: "task_cancel", level: "L1", for: ["owner"], description: "Cancel a task.",
    schema: z.object({ task_id: z.string() }), async exec({ task_id }) { return cancelTask(task_id.replace(/^#/, "")); } }),
  def({ name: "task_reply", level: "L1", for: ["owner"], description: "Pass the owner's answer or new instructions to a task (resumes it if it was waiting or finished).",
    schema: z.object({ task_id: z.string(), text: z.string().min(1) }), async exec({ task_id, text }) { return replyTask(task_id.replace(/^#/, ""), text, "dm"); } }),

  // ---- follow-ups (§9.1) ----
  def({
    name: "followup_set", level: "L1", for: ["owner"],
    description: "Set a reminder: at the given local time you get a timer event in this conversation with the note, and act on it then (remind him, check something, ask how it went). Resolve relative dates (\"周三\", \"明早\") against the current time first.",
    schema: z.object({ at: z.string().describe("local time, \"YYYY-MM-DD HH:MM\""), note: z.string().min(1).max(1000).describe("what to do when it fires, written for your future self"), matter_id: z.number().optional() }),
    async exec({ at, note, matter_id }, ctx) {
      const due = parseLocal(at);
      if (!due) return "error: at must look like 2026-11-19 09:00";
      if (due < Date.now() - 60_000) return `error: ${at} 已经过去了`;
      const id = addFollowup({ lane: ctx.lane, turn: ctx.turn, due, note, matterId: matter_id, by: ctx.runId });
      return `好：follow-up #${id}，${localStamp(due).slice(0, 16)} 提醒。`;
    },
  }),
  def({ name: "followup_list", level: "L0", for: ["owner"], description: "List pending reminders.", schema: z.object({}),
    async exec() { return listFollowups().map((t) => `#${t.id} ${localStamp(t.due_at).slice(0, 16)} ${t.note}${t.matter_id ? `（事 #${t.matter_id}）` : ""}`).join("\n") || "（没有）"; } }),
  def({ name: "followup_cancel", level: "L1", for: ["owner"], description: "Cancel a pending reminder.", schema: z.object({ id: z.number() }),
    async exec({ id }) { return cancelFollowup(id) ? `#${id} 取消了` : `#${id} 不存在或者已经不在等待中`; } }),

  // ---- matters, 事 (§15.3, §15.4) ----
  def({
    name: "matter_open", level: "L1", for: ["owner"],
    description: "Open a matter (事): something the owner is going through over days or weeks that deserves its own page (a negotiation, a hire, a move, a hard conversation). Returns the matter id and the 起局 playbook to follow with him.",
    schema: z.object({ title: z.string().min(1).max(60), domain: z.enum(["work", "personal"]), close_condition: z.string().max(200).optional(),
      topic: z.string().max(24).optional().describe("a 话头 from events_query / the morning report: its events (from every chat and source) move onto this matter"),
      keys: z.array(z.string().max(24)).max(10).optional().describe("other names people use for it; Triage links new messages by these") }),
    async exec(a, ctx) {
      const { id, rel } = openMatter({ title: a.title, domain: a.domain, close_condition: a.close_condition, lane: ctx.lane });
      if (a.keys?.length) addMatterKeys(id, a.keys);
      const moved = a.topic ? linkEvents({ matterId: id, topic: a.topic }) : 0;
      return `事 #${id} 已开，页面 ${rel}（用 memory_read 看，matter_note 往里记）。${moved ? `话头「${a.topic}」的 ${moved} 个事件已挂到这件事上（matter_events 看时间线）。` : ""}\n\n${PLAYBOOK}`;
    },
  }),
  def({
    name: "matter_link", level: "L1", for: ["owner"],
    description: "Hang events on a matter: by event id, or every event of a 话头 (topic) that has no matter yet (the topic then becomes one of the matter's keys, so Triage links later messages too). Use when he says two threads are the same thing.",
    schema: z.object({ matter_id: z.number(), event_ids: z.array(z.number()).max(100).optional(), topic: z.string().max(24).optional(), keys: z.array(z.string().max(24)).max(10).optional() }),
    async exec(a) {
      const n = linkEvents({ matterId: a.matter_id, ids: a.event_ids, topic: a.topic });
      const keys = a.keys?.length ? addMatterKeys(a.matter_id, a.keys) : matterKeys(a.matter_id);
      return `挂上了 ${n} 个事件到事 #${a.matter_id}；它的关键词：${keys.join("、") || "（无）"}`;
    },
  }),
  def({
    name: "matter_events", level: "L0", for: ["owner"],
    description: "The event ledger (§17.2): what happened around him in groups, DMs and sources, each with a kind (ask / decision / commitment / progress / risk / deadline / info) and a level (fyi 知道就行 / watch 要盯 / reply 要你回 / decide 要你拍板). Filter by matter, topic, level, state (open = still waiting on him). Use for a matter's timeline, \"what's waiting on me\", and summaries.",
    schema: z.object({
      matter_id: z.number().optional(), topic: z.string().max(24).optional(), levels: z.array(z.enum(LEVELS)).optional(), states: z.array(z.enum(STATES)).optional(),
      q: z.string().optional().describe("substring of summary, person or place"),
      days: z.number().min(1).max(3650).default(30), limit: z.number().min(1).max(300).default(100),
    }),
    async exec(a) {
      const rows = eventsQuery({ matter: a.matter_id, topic: a.topic, levels: a.levels, states: a.states, q: a.q, from: Date.now() - a.days * 86400_000, limit: a.limit });
      const cands = !a.matter_id && !a.topic ? topicCandidates() : [];
      return `${rows.length} 个事件${rows.length >= a.limit ? "（只给最近的）" : ""}\n${rows.map((e) => eventLine(e)).join("\n") || "（没有）"}${cands.length ? `\n\n反复出现、还没有事的话头：${cands.map((t) => `「${t.topic}」${t.n} 条/${t.places} 处`).join("；")}` : ""}`;
    },
  }),
  def({
    name: "event_update", level: "L1", for: ["owner"],
    description: "Correct an event when he says so: it's handled (done), not needed (dropped), still waiting (open), or its level was wrong (e.g. it was only fyi, or it needs his decision).",
    schema: z.object({ id: z.number(), state: z.enum(STATES).optional(), level: z.enum(LEVELS).optional() }),
    async exec(a) {
      if (a.level) setEventLevel(a.id, a.level);
      const e = a.state ? setEventState(a.id, a.state, "owner") : one("SELECT * FROM events WHERE id=?", a.id);
      if (!e) return `error: no event #${a.id}`;
      return eventLine(e);
    },
  }),
  def({
    name: "matter_note", level: "L1", for: ["owner"],
    description: `Add a line under one section of a matter's page. Sections: ${SECTIONS.join(" / ")}. 发心 only in the owner's own words.`,
    schema: z.object({ id: z.number(), section: z.enum(SECTIONS), text: z.string().min(1).max(2000) }),
    async exec({ id, section, text }, ctx) { return `记在 ${noteMatter(id, section, text, ctx.src)} 的「${section}」下`; },
  }),
  def({ name: "matter_list", level: "L0", for: ["owner"], description: "List matters (open ones by default).", schema: z.object({ all: z.boolean().default(false) }),
    async exec({ all }) { return listMatters(!all); } }),
  def({
    name: "matter_close", level: "L1", for: ["owner"], description: "Mark a matter as closing (its close condition was met; 复盘 comes later) or dropped.",
    schema: z.object({ id: z.number(), status: z.enum(["closing", "dropped"]), note: z.string().max(1000).optional() }),
    async exec({ id, status, note }) {
      setMatterStatus(id, status, note);
      if (status === "closing") { queueMatterReview(id); return `事 #${id} → closing。事收复盘的材料已经排进这个会话，下一轮会开始；先简短回应他就好。`; }
      return `事 #${id} → ${status}`;
    },
  }),

  // ---- 因缘 (§18): the people around him; owner only ----
  def({
    name: "person_lookup", level: "L0", for: ["owner"],
    description: "Who someone is in his life: circle, relation in people.yaml, how and when they first showed up, relations, the people around them, matters together, where they usually talk, their page. Use before drafting to or about someone, or when he asks about a person. A name shared by two people returns candidates: ask again with #id.",
    schema: z.object({ who: z.string().min(1).max(40).describe("a name, or #id") }),
    async exec({ who }) { const id = personId(who); return typeof id === "number" ? personCard(id) : id; },
  }),
  def({
    name: "person_path", level: "L0", for: ["owner"],
    description: "How two people are connected (never through him): the shortest chain of ties, each with why it exists. A hop marked 推测 came from a name match or someone's claim.",
    schema: z.object({ a: z.string().min(1).max(40), b: z.string().min(1).max(40) }),
    async exec({ a, b }) {
      const x = personId(a), y = personId(b);
      if (typeof x !== "number") return x;
      if (typeof y !== "number") return y;
      const r = pathBetween(`p:${x}`, `p:${y}`);
      if (!r) return "四步以内没连上。";
      const name = (n: string) => one("SELECT label FROM graph_nodes WHERE id=?", n)?.label ?? n;
      return `${r.hops.map((h) => `${name(h.from)} —${h.edge.label}${h.edge.evidence.length ? `（${h.edge.evidence.slice(0, 2).join("、")}）` : ""}${h.edge.conf === "INFERRED" ? "[推测]" : ""}→ ${name(h.to)}`).join("\n")}\n整体：${r.conf === "INFERRED" ? "有推测的环节" : "都有记录"}`;
    },
  }),
  def({
    name: "person_relate", level: "L1", for: ["owner"],
    description: `Record how two people relate (e.g. ${REL_PRESETS.join(" / ")}), only when he said it or someone stated it plainly; put where it came from in evidence ("他说的" / "小王在项目群说"). It stays marked 推测 until he confirms it in the console. Never infer a relation from people merely talking a lot.`,
    schema: z.object({ a: z.string().min(1).max(40), b: z.string().min(1).max(40), rel: z.string().min(1).max(12).describe("b is a's …, e.g. a=小李 b=老王 rel=上级"), evidence: z.string().min(2).max(300) }),
    async exec({ a, b, rel, evidence }, ctx) {
      const x = personId(a), y = personId(b);
      if (typeof x !== "number") return x;
      if (typeof y !== "number") return y;
      addRelation(x, y, rel, { conf: "INFERRED", src: ctx.src, evidence });
      return `记下了（推测）：${b} 是 ${a} 的${rel}。他可以在控制台「生活 › 人」里确认或去掉。`;
    },
  }),

  // ---- 红尘里修 (§15): owner only ----
  def({
    name: "note_add", level: "L0", for: ["owner"],
    description: "随手记: save something the owner says in passing about his life or state (\"记一下：今天心里有点乱\", \"今天跑了 5 公里\"), in his own words. Goes on the timeline; feeds rhythms and reviews.",
    schema: z.object({
      text: z.string().min(1).max(2000).describe("his words, as close to verbatim as possible"),
      domain: z.enum(DOMAINS).optional().describe("work 工作 / family 家庭 / friends 朋友 / body 身体 / mind 心"),
      matter_id: z.number().optional(), people: z.array(z.string()).max(10).optional(),
    }),
    async exec(a, ctx) { return `记下了（随手记 #${addNote({ text: a.text, domain: a.domain, matterId: a.matter_id, people: a.people, src: ctx.src })}）`; },
  }),
  def({
    name: "timeline_query", level: "L0", for: ["owner"],
    description: "Look back along the owner's timeline: what he said, notes, what was sent in his name, approvals, tasks, matters, outlooks, reviews. Use for reviews and for questions like \"这半年我和 X 的沟通\" or \"去年此时\". Calendar is not included yet.",
    schema: z.object({
      from: z.string().optional().describe("YYYY-MM-DD, YYYY-MM or \"YYYY-MM-DD HH:MM\"; default 7 days ago"),
      to: z.string().optional().describe("same formats; default now"),
      kinds: z.array(z.enum(["said", "said_group", "note", "sent", "approval", "task", "matter", "event", "outlook", "revisit", "review"])).optional(),
      matter_id: z.number().optional(), domain: z.enum(DOMAINS).optional(), q: z.string().optional().describe("substring, e.g. a person's name"),
      limit: z.number().min(1).max(500).default(200),
    }),
    async exec(a) { return timelineText({ from: a.from, to: a.to, kinds: a.kinds, matter: a.matter_id, domain: a.domain, q: a.q, limit: a.limit }); },
  }),
  def({
    name: "outlook_submit", level: "L1", for: ["owner"],
    description: "Write down 前瞻 items (day: at most 1, week / month / matter: at most 3 per period). Frozen once written: they come back for revisiting in the next review. Follow skills/outlook/SKILL.md.",
    schema: z.object({
      horizon: z.enum(["day", "week", "month", "matter"]), period: z.string().describe("day 2026-11-18 · week 2026-W47 · month 2026-11 · matter matter:3"),
      items: z.array(z.object({
        text: z.string().min(1).max(400), why_refs: z.array(z.string().max(200)).max(8).default([]).describe("matter:3, outlook:12, habit:5, note:8, approval:20, or a one-line fact"),
        look_for: z.string().max(300).optional(), revisit_at: z.string().max(20).optional().describe("YYYY-MM-DD"),
      })).min(1).max(3),
    }),
    async exec(a, ctx) { const ids = submitOutlook({ horizon: a.horizon, period: a.period, items: a.items, runId: ctx.runId }); return `记下了：前瞻 ${ids.map((i) => `#${i}`).join("、")}（写下后不改）`; },
  }),
  def({
    name: "outlook_revisit", level: "L1", for: ["owner"],
    description: "Record what the owner felt about an earlier outlook when looking back (his words; \"没什么感觉\" / \"还看不出来\" count too). Appends, never edits the outlook.",
    schema: z.object({ outlook_id: z.number(), text: z.string().min(1).max(2000) }),
    async exec(a, ctx) { revisitOutlook(a.outlook_id, a.text, ctx.src, ctx.runId); return `记下了（前瞻 #${a.outlook_id} 的回看）`; },
  }),
  def({
    name: "lens_reading", level: "L1", for: ["owner"],
    description: `Ask a lens (镜头) for a view: runs in the background in a sealed sandbox (a few minutes); the result comes back into this conversation and is written into the 解读账本 before the fact. Lenses: ${Object.entries(LENSES).map(([k, d]) => `${k}=${d.zh}（${Object.entries(d.methods).map(([m, v]) => `${m}: ${v.zh}`).join("；")}）`).join(" · ")}. Use when he asks, or at 起局 when he wants a 卦 for the matter. One concrete question; one view per matter (渎则不告) unless the matter itself changed (changed_because). Never ask for birth data in Feishu: it lives in config/self.yaml, which only he edits in the console.`,
    schema: z.object({
      lens: z.string(), method: z.string(), question: z.string().min(4).max(1000).describe("the concrete matter, in his words where possible"),
      matter_id: z.number().optional(), horizon: z.enum(["month", "week", "day"]).optional(), period: z.string().optional(),
      changed_because: z.string().max(300).optional(),
    }),
    async exec(a, ctx) {
      const id = requestReading({ lens: a.lens, method: a.method, question: a.question, matterId: a.matter_id, horizon: a.horizon, period: a.period,
        changedBecause: a.changed_because, originLane: ctx.lane, originTurn: JSON.stringify(ctx.turn), requestedBy: ctx.src });
      return `已排上：解读 #${id}，几分钟后结果会回到这个对话。先跟他说一声在看，不要编结果。`;
    },
  }),
  def({
    name: "readings_query", level: "L0", for: ["owner"],
    description: "Look up the 解读账本: earlier lens views (as written at the time) with what he said when looking back. Filter by lens, period (2026-12 / 2026-W49 / 2026-12-03) or matter.",
    schema: z.object({ lens: z.string().optional(), period: z.string().optional(), matter_id: z.number().optional(), limit: z.number().int().min(1).max(30).default(10) }),
    async exec(a) { return readingsQuery({ lens: a.lens, period: a.period, matterId: a.matter_id, limit: a.limit }); },
  }),
  def({
    name: "reading_revisit", level: "L1", for: ["owner"],
    description: "Record what HE felt when looking back at a lens view (\"有感应\" / \"没什么感觉\" / \"还看不出来\" / a paragraph — all count). His words only; never conclude for him, never score. claim_idx = which 到时回看 item, if one.",
    schema: z.object({ reading_id: z.number(), claim_idx: z.number().int().optional(), text: z.string().min(1).max(2000).describe("his words") }),
    async exec(a, ctx) {
      if (!ctx.src.startsWith("owner@")) return "error: only from his own words in a conversation with him";
      revisitReading(a.reading_id, a.claim_idx, a.text, ctx.src, ctx.runId);
      return `记下了（解读 #${a.reading_id} 的回看）`;
    },
  }),
  def({
    name: "review_submit", level: "L1", for: ["owner"],
    description: "File a 复盘 once the conversation is over (or he declined). owner_words = his own sentences verbatim (empty if he didn't talk: it is stored as 未聊, never written for him). agent_notes only after he talked. noticings: each habit / rhythm mentioned and who saw it first (owner needs a quote of his words). Follow skills/review/SKILL.md.",
    schema: z.object({
      kind: z.enum(["day", "week", "month", "matter"]), period: z.string().describe("day 2026-11-18 · week 2026-W47 · month 2026-11 · matter matter:3"),
      matter_id: z.number().optional(), facts: z.string().min(1).max(6000).describe("事实初稿, as corrected by him"),
      owner_words: z.array(z.string().max(2000)).max(40).default([]), agent_notes: z.string().max(3000).optional(),
      noticings: z.array(z.object({
        item_id: z.number().optional().describe("self_list id, if it is a known habit / rhythm"), item_text: z.string().min(1).max(300),
        who: z.enum(["owner", "agent"]), prompted: z.boolean().default(false).describe("he said it after your open question (still his)"),
        quote: z.string().max(500).optional().describe("for who=owner: his sentence from owner_words"),
      })).max(12).default([]),
      questions: z.array(z.object({ q: z.string().max(300), response: z.enum(["talked", "short", "declined", "none"]) })).max(10).default([]),
    }),
    async exec(a, ctx) {
      if (!periodOk(a.kind, a.period)) return `error: period for ${a.kind} must look like ${{ day: "2026-11-18", week: "2026-W47", month: "2026-11", matter: "matter:3" }[a.kind]}`;
      const r = submitReview({ kind: a.kind, period: a.period, matterId: a.matter_id ?? (a.kind === "matter" ? Number(a.period.slice(7)) : undefined), facts: a.facts,
        ownerWords: a.owner_words, agentNotes: a.agent_notes, noticings: a.noticings, questions: a.questions, runId: ctx.runId });
      return `复盘 #${r.id} 落档：${r.rel}${a.owner_words.length ? "" : "（未聊）"}${r.hints.length ? `\n\n${r.hints.join("\n")}` : ""}`;
    },
  }),
  def({
    name: "self_list", level: "L0", for: ["owner"],
    description: "List habit (习气) and rhythm (节律) observations with ids and status (candidate 候选 / endorsed 认可 / seeing_off 送一程 / dropped). Only endorsed ones may be cited in outlooks, 起局 and reviews; seeing_off ones only when he asks.",
    schema: z.object({ kind: z.enum(["habit", "rhythm"]).optional(), status: z.array(z.enum(["candidate", "endorsed", "seeing_off", "dropped"])).optional() }),
    async exec(a) { return selfItemsText({ kind: a.kind, statuses: a.status }); },
  }),
  def({
    name: "self_mark", level: "L1", for: ["owner"],
    description: "Change a habit / rhythm's status, ONLY when the owner himself says so in this conversation (\"这条我认\" → endorsed, \"这条不对\" → dropped, \"先放着\" → candidate; after 送一程, \"还是提醒我吧\" → endorsed).",
    schema: z.object({ id: z.number(), status: z.enum(["endorsed", "dropped", "candidate"]), owner_quote: z.string().min(1).max(500).describe("his words that ask for this"), note: z.string().max(300).optional() }),
    async exec(a, ctx) {
      if (!ctx.src.startsWith("owner@")) return "error: only in a conversation with the owner";
      return markSelfItem(a.id, a.status, a.note ? `${a.note}；他说：${a.owner_quote}` : `他说：${a.owner_quote}`);
    },
  }),

  // ---- expert (§5.5, manual trigger) ----
  def({
    name: "consult_expert", level: "L1", for: ["owner"],
    description: "Ask the expert-tier model for a second opinion on a hard question (when the owner asks for it, or the stakes are high and you are unsure). Give it the full context; it has no tools and no memory.",
    schema: z.object({ question: z.string().min(1).max(4000), context: z.string().max(40_000).default("") }),
    async exec({ question, context }, ctx) {
      const day = localStamp().slice(0, 10), used = Number(kvGet(`expert.used.${day}`) ?? 0);
      kvSet(`expert.used.${day}`, String(used + 1));   // counted; a manual ask still runs past daily_limit (§5.5)
      const out = await complete({ tier: "expert", maxTokens: 3000, requester: "expert", runId: `ex_${ctx.runId}_${used}`,
        system: `你是给${ownerName()}的助手当顾问的专家。直接、具体；指出风险和你不确定的地方。`, user: `${context ? `背景：\n${context}\n\n` : ""}问题：${question}` });
      return `专家意见（今天第 ${used + 1} 次，额度 ${gateConf().expert_daily_limit}）：\n${out}`;
    },
  }),
];

export const toolsFor = (who: Principal) => TOOLS.filter((t) => t.for.includes(who));

/** The gate. Who may see the tool, args validation, logging; never throws into the harness. L2 tools gate themselves. */
export async function callTool(t: ToolDef, rawArgs: unknown, ctx: RunCtx): Promise<string> {
  if (!t.for.includes(ctx.principal)) return `error: tool ${t.name} is not available in this conversation`;
  const p = t.schema.safeParse(rawArgs);
  if (!p.success) return `error: bad arguments: ${p.error.message}`;
  try {
    const out = await t.exec(p.data, ctx);
    log("tool", t.name, { run: ctx.runId, ok: true });
    return out;
  } catch (e: any) {
    log("tool", t.name, { run: ctx.runId, err: String(e?.message ?? e) });
    return `error: ${e?.message ?? e}`;
  }
}

/**
 * web_search for pi lanes (§5.4): one Messages call through the proxy (light tier) with the server tool
 * web_search_20250305, which the upstream supports (P0). Returns the model's digest plus the cited URLs.
 */
async function webSearch(query: string, token: string): Promise<string> {
  const r = await fetch(`${PROXY_BASE}/v1/messages`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}`, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({
      model: "sbot-light", max_tokens: 2048,
      tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 3 }],
      messages: [{ role: "user", content: `Search the web for: ${query}\n\nReply with a compact factual digest (in the language of the query) and list the source URLs you used.` }],
    }),
  });
  if (!r.ok) return `error: search failed (${r.status}) ${(await r.text()).slice(0, 200)}`;
  const j: any = await r.json();
  const text = (j.content ?? []).filter((b: any) => b.type === "text").map((b: any) => b.text).join("").trim();
  const urls = new Set<string>();
  for (const b of j.content ?? []) {
    if (b.type === "web_search_tool_result" && Array.isArray(b.content)) for (const c of b.content) if (c.url) urls.add(c.url);
    for (const c of b.citations ?? []) if (c.url) urls.add(c.url);
  }
  return `${text || "(no digest)"}\n\nSources:\n${[...urls].slice(0, 8).join("\n") || "(none)"}`;
}

/** "#12" or a name → person id, or the sentence to return (unknown / ambiguous with candidates) */
function personId(who: string): number | string {
  const m = /^#?(\d+)$/.exec(who.trim());
  if (m) return one("SELECT id FROM persons WHERE id=? AND status<>'merged'", Number(m[1])) ? Number(m[1]) : `没有 #${m[1]} 这个人。`;
  return resolveForTool(who);
}
