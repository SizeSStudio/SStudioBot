// Replies to where a round's input came from (03 「inbox 和 run」). Two ways out:
//   queueReply  — straight into the outbox (typed and system columns; code's own fixed lines)
//   replyGated  — what the agent wrote in someone else's conversation (others column, §底3.4): the commitment check
//                 first; clean → out; a hit or a failed check → a send approval with the reasons on the card, and the
//                 other side gets gate.yaml's fixed holding line (and hold_timeout_text if the card expires, approvals.ts)
import type { Db } from "./db/db.ts";
import type { Col, TurnContext } from "./turn.ts";
import type { CommitChecker } from "./commit-check.ts";
import { enqueue, toOutlet } from "./outbox.ts";
import { gateConf } from "./config/load.ts";
import { submitApproval } from "./approvals.ts";
import { redact } from "./tools/redact.ts";
import { log } from "./log.ts";

const HOUR = 3600_000;

type ReplyCtx = { db: Db; run_id: string; lane: string; turn: TurnContext };

/** Reply to where this round's input came from (TurnContext); with no turn (a job), to the main outlet. */
export function queueReply(ctx: ReplyCtx, text: string, countIt = true): number {
  const { db } = ctx;
  return db.tx(() => {
    // callTool already counted the `reply` tool; the dispatcher's own sends count here
    if (countIt) db.run("UPDATE runs SET side_effects = side_effects + 1 WHERE id = ?", ctx.run_id);
    if (ctx.turn.channel === "outlet:main") {
      const ids = toOutlet(db, "main", text, { lane: ctx.lane, run_id: ctx.run_id });
      return ids[0] ?? 0;
    }
    return enqueue(db, {
      channel: ctx.turn.channel, target: { ...ctx.turn }, payload: text, lane: ctx.lane, run_id: ctx.run_id,
      send_by: Date.now() + gateConf().send_by_hours * HOUR,
    });
  });
}

export type GatedCtx = ReplyCtx & { col: Col; src: string; commitCheck?: CommitChecker };
export type Gated = { sent: number } | { approval: number; hits: string[] };

/** Agent-written text going back to the round's source. Only the others column is checked; the rest goes straight out. */
export async function replyGated(ctx: GatedCtx, text: string, countIt = true): Promise<Gated> {
  if (ctx.col !== "others") return { sent: queueReply(ctx, text, countIt) };
  let hits: string[];
  try {
    if (!ctx.commitCheck) throw new Error("没接上");
    hits = (await ctx.commitCheck(text, { run_id: ctx.run_id, lane: ctx.lane })).hits;
  } catch (e) {
    hits = [`承诺检测没跑成（${redact(String((e as Error)?.message ?? e)).slice(0, 120)}），按命中处理`];
    log("reply", "commitment check failed, holding the reply", { run: ctx.run_id });
  }
  if (!hits.length) return { sent: queueReply(ctx, text, countIt) };
  const { db, turn } = ctx;
  return db.tx(() => {
    if (countIt) db.run("UPDATE runs SET side_effects = side_effects + 1 WHERE id = ?", ctx.run_id);
    const approval = submitApproval(db, {
      kind: "send", title: `回 ${turn.chat ?? turn.surface}（承诺检测命中）`, draft: text,
      channel: turn.channel, target: { ...turn }, as_identity: "bot",
      origin_lane: ctx.lane, run_id: ctx.run_id, requester: ctx.src,
      checks: { hits }, context: { turn, hold: true },
      trigger: { chat: turn.chat, msg_id: turn.msg_id, ts: Date.now() },
    });
    // the holding line is fixed text from gate.yaml, never anything the model wrote (§底3.4)
    enqueue(db, {
      channel: turn.channel, target: { ...turn }, payload: gateConf().hold_text, lane: ctx.lane, run_id: ctx.run_id,
      send_by: Date.now() + gateConf().send_by_hours * HOUR, idem_key: `approval:${approval}:hold`,
    });
    return { approval, hits };
  });
}
