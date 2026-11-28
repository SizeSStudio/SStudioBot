// Where a turn came from and where its reply goes (03 「inbox 和 run」), and the source label (R1) that decides which
// tool column a run sees. One place computes both so the dispatcher, tools and journal never disagree.
import type { Row } from "./db/db.ts";

/** Reply target, stored as inbox.turn_ctx_json by whoever ingests. `channel` is any channel id ("client", "feishu", …). */
export interface TurnContext {
  channel: string;
  surface: string;          // e.g. client, feishu:dm, feishu:workbench
  lane?: string;
  chat?: string;
  thread?: string;
  msg_id?: string;
  device_id?: string;
  src?: string;             // filled by the dispatcher
}

export type Col = "typed" | "system" | "others";

/**
 * §读5.1: where self/, body records, the timeline and personal threads may be shown whole — the client (console:*)
 * and my own Feishu DM. Every other place, even one where I type (the workbench, the admin chat), is shared: there
 * a turn I typed gets what a system turn gets (item level, no whole files) and nothing personal is listed ※.
 * (feishu:dm:owner is channels/feishu/state.ts OWNER_DM_LANE; spelled out so this file needs no imports.)
 */
export const seesPersonal = (lane: string): boolean => lane.startsWith("console:") || lane === "feishu:dm:owner";

/** The column the self/ guard and the prompt judge by: typed in a shared place counts as system there. */
export const privacyCol = (col: Col, lane: string): Col => (col === "typed" && !seesPersonal(lane) ? "system" : col);

/** §底3.1: owner@ → typed; job@ / system@ → system; everything else (others' conversations) → others. */
export function colOf(src: string): Col {
  if (src.startsWith("owner@")) return "typed";
  if (src.startsWith("job@") || src.startsWith("system@")) return "system";
  return "others";
}

const parse = (s: unknown): Record<string, any> => {
  if (typeof s !== "string" || !s) return {};
  try { const v = JSON.parse(s); return v && typeof v === "object" ? v : {}; } catch { return {}; }
};
export const payloadOf = (r: Row) => parse(r.payload_json);
export const turnOf = (r: Row): TurnContext | undefined => {
  const t = parse(r.turn_ctx_json);
  return typeof t.channel === "string" ? (t as TurnContext) : undefined;
};

/**
 * ownerTyped (R1): typed by me — sent from a client device, or a channel message the channel plugin already matched
 * against my id in people.yaml (it stamps payload.owner = true at ingest). Only user/command rows can be typed.
 */
export function ownerTyped(r: Row): boolean {
  if (r.kind !== "user" && r.kind !== "command") return false;
  return (typeof r.device_id === "string" && r.device_id !== "") || payloadOf(r).owner === true;
}

const SYSTEM_KINDS: Record<string, string> = { approval: "approval", task: "task", system: "system", card: "approval" };

/**
 * The batch's label: all typed by me → owner@<surface>; otherwise the first row that isn't mine decides —
 * timer/job → job@<name>, approval/task/system → system@<kind>, another person's message → other@<surface>.
 */
export function sourceLabel(rows: Row[]): string {
  const surf = (r: Row) => turnOf(r)?.surface ?? String(r.source ?? "unknown");
  if (rows.length && rows.every(ownerTyped)) return `owner@${surf(rows[rows.length - 1]!)}`;
  const r = rows.find((x) => !ownerTyped(x)) ?? rows[0];
  if (!r) return "system@empty";
  const p = payloadOf(r), kind = String(r.kind);
  if (kind === "timer" || r.source === "job" || r.source === "timer") return `job@${String(p.job ?? p.name ?? r.source)}`;
  if (SYSTEM_KINDS[kind]) return `system@${SYSTEM_KINDS[kind]}`;
  if (kind === "user" || kind === "command") return `other@${surf(r)}`;
  return `system@${kind}`;
}
