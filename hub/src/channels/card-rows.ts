// Card clicks in the inbox (kind `card`): code answers them, never the model. The plugin only let my own clicks in
// (and stamped the operator); approvals.decide checks the operator against people.yaml again itself.
//   {k:"appr", id, o, v?}    → approvals.decide through the same option mapping as the client (approvals.choose); `v`
//                              is the draft_version the card showed, so a click on a card whose draft has since been
//                              edited is refused (cards sent before W3 carry none)
//   {k:"group" | "review"}   → the Feishu group switches (feishu/actions.ts)
import type { Db, Row } from "../db/db.ts";
import { choose, decide } from "../approvals.ts";
import { payloadOf } from "../turn.ts";
import { log } from "../log.ts";
import { handleCardRow } from "./feishu/actions.ts";
import type { FeishuChannel } from "./feishu/plugin.ts";

export function cardRows(db: Db, feishu?: () => FeishuChannel | undefined): (r: Row) => Promise<void> {
  return async (r) => {
    const p = payloadOf(r), v = (p.value ?? {}) as Record<string, unknown>;
    const channel = String(r.source ?? "").split(":")[0] || "unknown";
    if (v.k === "appr") {
      const id = Number(v.id), o = String(v.o ?? "");
      const a = db.one("SELECT * FROM approvals WHERE id = ?", id);
      const c = a ? choose(a, { option_id: o }) : undefined;
      if (!c || "ok" in c) { log("cards", "approval click not taken", { id, err: c?.error ?? "no such approval" }); return; }
      const res = decide(db, id, {
        decision: c.decision, by: { kind: "channel", channel, operator: String(p.operator ?? "") },
        ...(typeof v.v === "number" ? { draft_version: v.v } : {}), ...(c.answer ? { answer: c.answer } : {}),
      });
      // the first decision on any end wins; the cards were already re-rendered with it, so nothing to say here
      if (!res.ok) log("cards", "approval click not taken", { id, err: res.error });
      return;
    }
    const f = channel === "feishu" ? feishu?.() : undefined;
    if (f && (v.k === "group" || v.k === "review")) { await handleCardRow(f, { value: v, msg: p.msg as string | undefined }); return; }
    log("cards", "card click nobody handles", { k: String(v.k ?? ""), channel });
  };
}
