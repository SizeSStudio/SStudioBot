// Dispatcher + Session Manager (DESIGN §1.2, §3.3).
//
//   - one run per lane at a time; lanes run in parallel up to MAX_CONCURRENT
//   - a run takes every `received` event of its lane (batched: three messages → one reply)
//   - restart recovery: a `running` run with no side effects goes back to `received`; one with side effects becomes
//     `interrupted` and the owner is told, never re-run automatically
//   - rolling sessions: idle > ROLL_IDLE_MS, /new, or the tier's model changed (§5.4) → new session; the old one is
//     summarized (light tier) into sessions.summary + journal and carried into the first turn of the new one
//   - resume fallback: session file gone → new session with summary + recent messages

import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { all, one, run, tx, kvGet, kvSet } from "./db.ts";
import { jobsConf, log, tierConf, P, ownerName, type Tier } from "./config.ts";
import { complete, issueToken, revokeToken, tokenStatus } from "./proxy.ts";
import { appendJournal, localNow, localStamp, promptFiles } from "./memory.ts";
import { commitMemory } from "./wiki.ts";
import { countProactive, holdIfOverCap, isQuotaRun } from "./digest.ts";
import { queueReply, toolsFor, type RunCtx, type TurnContext } from "./tools.ts";
import type { Runner } from "./runner.ts";
import { CardStream, toolStatus } from "./card.ts";
import { tunedSection, tuningVersions } from "./tuning.ts";
import { adminNotice, classifyUpstream, failureText, nextAttempt, READ_ONLY_TOOLS, retryDeadline, type UpstreamFailure } from "./retry.ts";
import { nextDue } from "./timers.ts";
import { noteReviewRun } from "./reflect.ts";

const MAX_CONCURRENT = 2;
const BATCH = 20;
const ROLL_IDLE_MS = Number(process.env.SBOT_ROLL_IDLE_H ?? 4) * 3600_000;
const RECENT_K = 12;
const STREAM_CARDS = process.env.SBOT_STREAM_CARDS !== "0";
const SURFACE: Record<string, string> = { "feishu:dm": "飞书私聊", "feishu:workbench": "工作台话题" };
/** non-message events in a lane are labelled so the model knows nobody typed them */
const KIND: Record<string, string> = { timer: "（定时器）", approval: "（审批结果）", task: "（任务消息）", system: "（系统转来）" };

/** where the reply goes: the latest event that carries a turn; system events without one go to the owner DM */
function turnOf(rows: Record<string, any>[]): TurnContext {
  const r = [...rows].reverse().find((x) => x.turn_ctx_json);
  if (r) return JSON.parse(r.turn_ctx_json);
  const dm = kvGet("feishu.owner_dm_chat");
  if (!dm) throw new Error("no reply target: event without a turn and the owner DM chat is not known yet");
  return { channel: "feishu", chat_id: dm, surface: "feishu:dm" };
}

type Running = { runId: string; abort?: () => Promise<void> };

const payloadOf = (r: Record<string, any>) => JSON.parse(r.payload_json ?? "{}");
const SCHEDULED_LABEL: Record<string, string> = { timer: "到点提醒", matter: "事收复盘", lens: "镜头结果" };

/**
 * §9.4: a scheduled event whose run hit an upstream failure goes back to the inbox with a not_before, or, once its
 * window is over, is marked failed with one line to the admin group. Nobody is told in the DM: nobody asked.
 */
function requeueScheduled(rows: Record<string, any>[], f: UpstreamFailure, err: string | undefined) {
  const now = Date.now();
  for (const r of rows) {
    const p = payloadOf(r), job = p.job ? jobsConf()[p.job] : undefined;
    const deadline: number = p.retry?.deadline ?? retryDeadline(r.ts, job ? nextDue(job, r.ts) : undefined, job?.retry_hours);
    const n = (p.retry?.n ?? 0) + 1, at = nextAttempt(f, n, deadline, now);
    const last = (outcome: string) => { if (p.job) kvSet(`job.${p.job}.last`, JSON.stringify({ at: now, due: r.ts, outcome })); };
    if (at) {
      run("UPDATE inbox SET status='received', run_id=NULL, not_before=?, payload_json=? WHERE id=?", at, JSON.stringify({ ...p, retry: { n, deadline } }), r.id);
      last(`retrying (${n})`);
      log("dispatch", "scheduled run will retry", { inbox: r.id, job: p.job, attempt: n, kind: f.kind, at: localStamp(at) });
    } else {
      run("UPDATE inbox SET status='failed' WHERE id=?", r.id);
      last("gave_up");
      adminNotice(`**定时任务没跑成**：${p.job ?? SCHEDULED_LABEL[r.source] ?? r.source}（${localStamp(r.ts).slice(5, 16)}）试了 ${n} 次，到 ${localStamp(deadline).slice(5, 16)} 还不行，这一轮放弃，不再补。\n${failureText(f, err, (t) => localStamp(t).slice(5, 16))}`);
      log("dispatch", "scheduled run gave up", { inbox: r.id, job: p.job, attempts: n, kind: f.kind });
    }
  }
}

export class Dispatcher {
  private running = new Map<string, Running>();
  private stopping = false;
  private runner: Runner;
  private afterRun: () => void;
  constructor(runner: Runner, afterRun: () => void) { this.runner = runner; this.afterRun = afterRun; }

  get busyLanes() { return [...this.running.keys()]; }

  recover() {
    tx(() => {
      for (const r of all("SELECT * FROM runs WHERE status='running'")) {
        if (r.side_effects === 0) {
          run("UPDATE inbox SET status='received', run_id=NULL WHERE run_id=? AND status='processing'", r.id);
          run("UPDATE runs SET status='interrupted', stop_reason='restart_retried', ended=? WHERE id=?", Date.now(), r.id);
          log("dispatch", "recovered run without side effects → retry", { run: r.id, lane: r.lane });
        } else {
          const rows = all("SELECT * FROM inbox WHERE run_id=? AND status='processing' ORDER BY id", r.id);
          run("UPDATE inbox SET status='interrupted' WHERE run_id=? AND status='processing'", r.id);
          run("UPDATE runs SET status='interrupted', stop_reason='restart', ended=? WHERE id=?", Date.now(), r.id);
          const last = rows.at(-1);
          if (last?.turn_ctx_json) {
            const said = all("SELECT payload FROM outbox WHERE run_id=? ORDER BY id", r.id).map((o) => o.payload as string);
            queueReply({ runId: r.id, lane: r.lane, turn: JSON.parse(last.turn_ctx_json) },
              `（我刚才被重启了。上一轮做到一半${said.length ? `，已经发出 ${said.length} 条消息，不会重发` : ""}。要我接着做的话，再说一声。）`);
          }
          log("dispatch", "recovered run WITH side effects → interrupted, owner told", { run: r.id, lane: r.lane });
        }
      }
      // processing rows whose run row is missing (crash between the two writes is impossible inside tx, but be safe)
      run("UPDATE inbox SET status='received', run_id=NULL WHERE status='processing' AND run_id NOT IN (SELECT id FROM runs WHERE status='running')");
    });
  }

  kick() {
    if (this.stopping) return;
    const lanes = all("SELECT lane, MIN(id) first FROM inbox WHERE status='received' AND COALESCE(not_before,0)<=? GROUP BY lane ORDER BY first", Date.now());
    for (const { lane } of lanes) {
      if (this.running.size >= MAX_CONCURRENT) break;
      if (this.running.has(lane)) continue;
      this.start(lane);
    }
  }

  async stop(lane: string): Promise<boolean> {
    const r = this.running.get(lane);
    if (!r?.abort) return false;
    await r.abort();
    return true;
  }

  /** Stop picking up new work and wait (bounded) for running runs; unfinished ones are recovered on next start. */
  async drain(ms: number) {
    this.stopping = true;
    const t0 = Date.now();
    while (this.running.size && Date.now() - t0 < ms) await new Promise((r) => setTimeout(r, 200));
  }

  markRoll(lane: string) { run("UPDATE sessions SET status='roll' WHERE key=?", lane); }

  private start(lane: string) {
    const runId = `r_${Date.now().toString(36)}_${randomUUID().slice(0, 6)}`;
    const tier: Tier = "chat";
    const rows = tx(() => {
      const rows = all("SELECT * FROM inbox WHERE lane=? AND status='received' AND COALESCE(not_before,0)<=? ORDER BY id LIMIT ?", lane, Date.now(), BATCH);
      if (!rows.length) return rows;
      if (holdIfOverCap(rows)) return [];    // §9.3: over today's proactive cap → parked for the morning report
      const ids = rows.map((r) => r.id);
      run(`UPDATE inbox SET status='processing', run_id=? WHERE id IN (${ids.map(() => "?").join(",")})`, runId, ...ids);
      run("INSERT INTO runs(id, lane, session_key, role, tier, model, status, started, versions_json) VALUES(?,?,?,?,?,?,?,?,?)",
        runId, lane, lane, "main", tier, tierConf(tier).model, "running", Date.now(), JSON.stringify({ model: tierConf(tier).model, tuning: tuningVersions() }));
      return rows;
    });
    if (!rows.length) return;
    const entry: Running = { runId };
    this.running.set(lane, entry);
    this.execute(lane, runId, tier, rows, entry)
      .catch((e) => {
        log("dispatch", "run crashed", { run: runId, err: String(e?.stack ?? e).slice(0, 500) });
        tx(() => {
          run("UPDATE runs SET status='failed', error=?, ended=? WHERE id=?", String(e?.message ?? e).slice(0, 500), Date.now(), runId);
          run("UPDATE inbox SET status='failed' WHERE run_id=? AND status='processing'", runId);
        });
        try { queueReply({ runId, lane, turn: turnOf(rows) }, `（这一轮出错了：${String(e?.message ?? e).slice(0, 200)}）`); } catch { /* nowhere to say it */ }
      })
      .finally(() => {
        this.running.delete(lane);
        try { commitMemory(`run ${runId}`); } catch (e: any) { log("dispatch", "agent-home commit failed", { err: String(e.message ?? e) }); }
        this.afterRun();
        this.kick();
      });
  }

  private async execute(lane: string, runId: string, tier: Tier, rows: Record<string, any>[], entry: Running) {
    const turn: TurnContext = turnOf(rows);
    const sess = await this.session(lane, tier);
    const token = issueToken({ runId, tier, requester: "owner" });
    const ctx: RunCtx = { runId, lane, principal: "owner", turn, src: `owner@${turn.surface}`, token, replies: 0 };
    const scheduled = rows.filter((r) => r.kind === "timer"), onlyScheduled = scheduled.length === rows.length;
    // the carry-over of a rolled session has to survive a failed attempt: the old session is already gone
    const carry: string | undefined = sess.carry ?? rows.map((r) => payloadOf(r).carry).find(Boolean);
    const text = (carry ? carry + "\n\n" : "") + this.turnText(rows, turn);
    const before = onlyScheduled && sess.ref && existsSync(sess.ref) ? readFileSync(sess.ref) : undefined;
    log("dispatch", "run start", { run: runId, lane, events: rows.length, new_session: !sess.ref });
    const t0 = Date.now();
    const card = STREAM_CARDS && turn.channel === "feishu" ? new CardStream(ctx, { thinking: !onlyScheduled }) : undefined;
    let res;
    try {
      res = await this.runner.run({
        tier, sessionRef: sess.ref, systemPrompt: systemPrompt(turn, !!card), text, tools: toolsFor("owner"), ctx,
        onAbortable: (abort) => { entry.abort = abort; },
        onStream: card ? (s) => { if (!onlyScheduled || s.text.trim()) card.update(s.text, toolStatus(s.tool)); } : undefined,
      });
    } catch (e) {
      card?.dispose();
      throw e;
    } finally {
      revokeToken(token);
    }
    const tok = tokenStatus(runId);
    const why = tok?.status === "budget_exhausted" ? "这一轮的 token 预算用完了，先停在这里" : `模型调用出错：${(res.error ?? "").slice(0, 200)}`;
    // §9.4: safe to run again only if this attempt said nothing and changed nothing
    const failure = res.stop === "error" && tok?.status !== "budget_exhausted" && scheduled.length ? classifyUpstream(res.error) : undefined;
    const retry = failure && !res.fullText.trim() && ctx.replies === 0 && res.toolCalls.every((t) => READ_ONLY_TOOLS.has(t)) ? failure : undefined;
    if (retry && onlyScheduled) {
      card?.dispose();
      // the attempt never happened as far as the conversation goes: otherwise each retry stacks the whole event text again
      try { if (before) writeFileSync(sess.ref!, before); else if (!sess.ref && res.sessionRef) rmSync(res.sessionRef, { force: true }); }
      catch (e: any) { log("dispatch", "could not undo the failed attempt's session", { err: String(e?.message ?? e) }); }
      tx(() => {
        if (sess.carry) run("UPDATE inbox SET payload_json=? WHERE id=?", JSON.stringify({ ...payloadOf(rows[0]), carry: sess.carry }), rows[0].id);
        requeueScheduled(all(`SELECT * FROM inbox WHERE id IN (${rows.map(() => "?").join(",")})`, ...rows.map((r) => r.id)), retry, res.error);
        run("UPDATE runs SET status='failed', stop_reason='upstream_retry', error=?, ended=? WHERE id=?", res.error ?? null, Date.now(), runId);
      });
      log("dispatch", "run end", { run: runId, stop: "upstream_retry", ms: Date.now() - t0 });
      return;
    }
    let carded = false;
    if (card) {
      const shown = res.fullText || res.text;
      const note = res.stop === "aborted" ? "（已停下）" : res.stop === "error" ? `（${why}）`
        : !shown.trim() && ctx.replies > 0 ? "（已分条发出）" : undefined;
      carded = await card.finish(shown, note);
      const rest = carded ? CardStream.overflow(shown) : "";
      if (rest) queueReply(ctx, rest);
    }
    tx(() => {
      run(`INSERT INTO sessions(key, harness, session_ref, generation, surface, tier, model, status, started, last_active)
           VALUES(?,?,?,?,?,?,?,?,?,?)
           ON CONFLICT(key) DO UPDATE SET session_ref=excluded.session_ref, tier=excluded.tier, model=excluded.model,
             status='active', last_active=excluded.last_active,
             generation=CASE WHEN sessions.session_ref IS excluded.session_ref THEN sessions.generation ELSE sessions.generation+1 END,
             started=CASE WHEN sessions.session_ref IS excluded.session_ref THEN sessions.started ELSE excluded.started END`,
        lane, "pi", res.sessionRef, 0, turn.surface, tier, tierConf(tier).model, "active", Date.now(), Date.now());
      run("UPDATE runs SET session_ref=? WHERE id=?", res.sessionRef, runId);
      if (res.stop === "done") {
        if (!carded && ctx.replies === 0 && res.text.trim()) queueReply(ctx, res.text.trim());
      } else if (res.stop === "error") {
        if (!carded) queueReply(ctx, `（${why}）`);
      }
      run("UPDATE runs SET status=?, stop_reason=?, error=?, ended=? WHERE id=?",
        res.stop === "done" ? "done" : res.stop === "aborted" ? "aborted" : "failed",
        tok?.status === "budget_exhausted" ? "budget_exhausted" : res.stop, res.error ?? null, Date.now(), runId);
      if (retry) requeueScheduled(scheduled, retry, res.error);   // his own message in the same batch fails as usual, the timer event waits
      run("UPDATE inbox SET status=? WHERE run_id=? AND status='processing'", res.stop === "error" ? "failed" : "done", runId);
      noteReviewRun(rows.map(payloadOf), runId);
      if (res.stop === "done") for (const p of rows.map(payloadOf)) if (p.job && p.retry) kvSet(`job.${p.job}.last`, JSON.stringify({ at: Date.now(), outcome: `done after ${p.retry.n} retries` }));
    });
    if (isQuotaRun(rows) && one("SELECT COUNT(*) n FROM outbox WHERE run_id=?", runId)!.n > 0) countProactive();
    log("dispatch", "run end", { run: runId, stop: res.stop, ms: Date.now() - t0, tools: res.toolCalls, out_tokens: res.usage.output });
  }

  private turnText(rows: Record<string, any>[], turn: TurnContext) {
    const where = SURFACE[turn.surface] ?? turn.surface;
    const lines = rows.map((r) => {
      const p = JSON.parse(r.payload_json ?? "{}");
      const kind = KIND[r.kind] ?? (p.message_type && p.message_type !== "text" && p.message_type !== "post" ? `（${p.message_type}）` : "");
      const late = p.retry ? "（上游出错，推迟到现在才送达）" : "";
      return `[${localStamp(p.ts ?? r.ts).slice(11)}] ${kind}${late}${p.text ?? ""}`;
    });
    return `（${where} · 现在 ${localNow()}）\n${lines.join("\n")}`;
  }

  /** Decide resume vs new session; on a new one, summarize the old and build the carry-over text. */
  private async session(lane: string, tier: Tier): Promise<{ ref?: string; carry?: string }> {
    const s = one("SELECT * FROM sessions WHERE key=?", lane);
    if (!s?.session_ref) return {};
    const modelChanged = s.model && s.model !== tierConf(tier).model;
    const idle = Date.now() - (s.last_active ?? 0) > ROLL_IDLE_MS;
    const missing = !existsSync(s.session_ref);
    if (!(s.status === "roll" || idle || modelChanged || missing)) return { ref: s.session_ref };
    const why = s.status === "roll" ? "/new" : modelChanged ? "model changed" : idle ? "idle" : "session file missing";
    let summary: string | undefined;
    try {
      summary = await summarize(lane, s.started ?? 0);
      if (summary) {
        run("UPDATE sessions SET summary=? WHERE key=?", summary, lane);
        appendJournal(`会话收尾（${why}）：${summary}`, `summary@${lane}`);
      }
    } catch (e: any) { log("dispatch", "summary failed", { err: String(e.message ?? e) }); }
    run("UPDATE sessions SET session_ref=NULL, status='active' WHERE key=?", lane);
    log("dispatch", "new session", { lane, why });
    const recent = all("SELECT sender_kind, ts, text FROM messages WHERE lane=? ORDER BY ts DESC LIMIT ?", lane, RECENT_K).reverse();
    const parts: string[] = [];
    if (summary) parts.push(`【上一段对话的要点】\n${summary}`);
    if (missing && recent.length) parts.push(`【最近的消息】\n${recent.map((m) => `[${localStamp(m.ts).slice(5)}] ${m.sender_kind === "bot" ? "我" : "主人"}：${String(m.text).slice(0, 300)}`).join("\n")}`);
    return { carry: parts.length ? `（新会话开始。下面是上一段的背景，供参考，不用复述。）\n${parts.join("\n\n")}` : undefined };
  }
}

/** One light-tier call through the proxy; the transcript comes from the messages table, not the harness. */
async function summarize(lane: string, since: number): Promise<string | undefined> {
  const msgs = all("SELECT sender_kind, ts, text FROM messages WHERE lane=? AND ts>=? ORDER BY ts DESC LIMIT 80", lane, since).reverse();
  if (!msgs.length) return undefined;
  const text = await complete({
    tier: "light", maxTokens: 1200, requester: "system",
    system: "你在给一段对话写收尾要点。只写对之后有用的：做了什么决定、答应了什么、待办和跟进、主人表达的偏好和感受（用原话）。不超过 8 条，每条一行，中文。没有值得记的就回答「无」。",
    user: msgs.map((m) => `[${localStamp(m.ts)}] ${m.sender_kind === "bot" ? "agent" : "主人"}：${String(m.text).slice(0, 1500)}`).join("\n"),
  });
  return text && text !== "无" ? text : undefined;
}

function systemPrompt(turn: TurnContext, streaming = false): string {
  const files = promptFiles();
  const get = (n: string) => files.find((f) => f.name === n)?.text || "（空）";
  return [
    get("AGENTS.md"),
    get("SOUL.md"),
    `# 关于主人（USER.md）\n${get("USER.md")}`,
    `# 长期要点索引（MEMORY.md，细节用 memory_read 按需读）\n${get("MEMORY.md")}`,
    `# 这次对话\n- 渠道：${turn.surface === "feishu:dm" ? "飞书私聊，对方是主人本人" : turn.surface === "feishu:workbench" ? "工作台（只有主人和你的话题群）里的一个话题，对方是主人本人" : turn.surface}\n${streaming ? "- 你的回答会实时流式显示在一张卡片里，调用工具时卡片上会显示你在做什么，所以不用先发「稍等」；只有确实要分成几条独立消息时才用 reply。" : "- 你的最终回答会自动发给对方；只有需要先发一句再干活、或者要分几条发时才用 reply。"}\n- 每条消息前的 [时:分] 是发送时间。几条连发的消息合在一起回一次。带（定时器）（审批结果）（任务消息）（系统转来）的不是人打的字，是系统事件，按内容处理，必要时告诉主人。\n- 要长期记住的事随手用 memory_append 记下，压缩和换会话会丢细节。`,
    `# 你能做的事（M1/M2）\n- 对外发消息：send。永远先进管理群的审批卡片，${ownerName()}点了才原样发出；工具立刻返回，不要等，也不要假装已经发了。以他本人身份（as=user）说话要格外克制：不替他答应时间、钱、资源，不替他表态。\n- 群里的消息：feishu_chats 找群，feishu_read 看观察到的消息。群里有人找他，Triage 会自己起草审批卡片，你不用管。\n- 大活交给 worker：task_start（写代码、调研、写文档，超过两三分钟的都算）。它看不到这段对话和记忆，goal/context 要写全。开工后简短告诉他「已开工，在工作台话题里跟进」就行；它的问题、结果会作为（任务消息）回到这里，转述给他，他的回答用 task_reply 转回去。\n- 提醒：followup_set（先把「周三」「明早」换算成具体时间），到点你会收到（定时器）事件，那时再提醒他或去查。\n- 事：他在经历一件要持续几天、几周的事时，可以问他要不要开一件「事」（matter_open），按返回的起局步骤一步一步来，不要一口气全倒出来。\n- 事件：群、私聊、信息源（仓库、工单、邮件……）里的要紧点由 Triage 记成事件，分「知道就行 / 要盯 / 要你回 / 要你拍板」，挂在事或话头上。他问「有什么等我回的」「这件事走到哪了」用 matter_events；他说两条线是一件事用 matter_link；他说某条不用回了、其实要他拍板，用 event_update 改。反复出现、还没有事的话头，可以问他要不要起局（matter_open 带 topic，之前的事件会一起挂上）。\n- 拿不准、风险高、或者他说「让专家看看」：consult_expert。\n- 其他有后果的动作，先 request_approval。`,
    `# 陪伴：红尘里修（M3c，只在和主人的对话里）\n- 随手记：他随口说「记一下：……」或者顺口提到身体、情绪、家里的事，用 note_add 原话记下，回一句短的就好，不评论。\n- 回看：timeline_query 按时间、事、人（q）、领域查时间线（他说的话、代发的消息、审批、任务、事、前瞻、复盘、随手记）。回溯的输出仍是对话：先摆出摘要问他看到了什么，再给你注意到的规律，只当对照。\n- 复盘和前瞻由定时任务或事收发起（会带着事实和方法进来，按里面的方法做）；他主动说「复盘一下」也可以，方法在 skills/review/SKILL.md、skills/outlook/SKILL.md（用 memory_read 读）。前瞻用 outlook_submit 写下（写下后不改），回看用 outlook_revisit，复盘结束用 review_submit。\n- 习气、节律：self_list 看；只有 endorsed 的才能在前瞻、起局、复盘里引用，seeing_off（送一程）的只在他问时说。他明确说认不认时才用 self_mark。只描述行为，不下人格结论。\n- 分寸：前瞻是建议不是安排；他状态不好先陪着，不急着复盘和给建议；他自己能看见的不抢先说；不说教。飞书是公司的系统，不贴 self/ 下文件的全文，只引用相关的一两条。\n- 起局（matter_open）第 4 步「习气提醒」现在可以用了：self_list(status=["endorsed"]) 里挑相关的 1～2 条。`,
    `# 镜头和解读账本（M6，只在和主人的对话里）\n- 镜头（紫微、六爻）是一种看法，给他结合生活去感受；不打分、不算准不准，也不在对话里质疑或证伪它。\n- 他要看（「起一卦」「看看这个月的流月」），或起局时他想为这件事起一卦，用 lens_reading：一个具体的问题；结果几分钟后回到对话。不要自己编卦、编盘。\n- 同一件事只看一次（渎则不告）；事情本身变了才再看，写清楚变在哪。\n- 出生信息只在 config/self.yaml（他自己在控制台填），不要在飞书里问他的出生时间。\n- 当时的看法写下后不改；回看时把原文拿出来，问他感受，用 reading_revisit 记他的原话。readings_query 查以前的看法。\n- 飞书里不贴命盘原文，只说一两句留意点。`,
  ].join("\n\n") + tunedSection("tuning/main.md", "补充规则");
}
