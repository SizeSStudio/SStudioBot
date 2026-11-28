// Card clicks in the inbox (kind `card`): code answers them, never the model. The plugin only let my own clicks in
// (and stamped the operator); approvals.decide checks the operator against people.yaml again itself.
//   {k:"appr", id, o}        → approvals.decide: o = approve | reject, any other option id approves with that answer
//   {k:"group" | "review"}   → the Feishu group switches (feishu/actions.ts)
import type { Db, Row } from "../db/db.ts";
import { decide } from "../approvals.ts";
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
      const res = decide(db, id, {
        decision: o === "reject" ? "reject" : "approve",
        by: { kind: "channel", channel, operator: String(p.operator ?? "") },
        ...(o && o !== "approve" && o !== "reject" ? { answer: { option_id: o } } : {}),
      });
      if (!res.ok) log("cards", "approval click not taken", { id, err: res.error });
      return;
    }
    const f = channel === "feishu" ? feishu?.() : undefined;
    if (f && (v.k === "group" || v.k === "review")) { await handleCardRow(f, { value: v, msg: p.msg as string | undefined }); return; }
    log("cards", "card click nobody handles", { k: String(v.k ?? ""), channel });
  };
}
