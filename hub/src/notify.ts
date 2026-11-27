// The admin notification outlet (03 「outbox 和出口组」, 10 R3): config writes, seed sync, release notices and backup
// call notify.admin(text) and never name a channel. Until outbox lands (W1d) the sink only logs; W1d swaps in the
// outlet group with setAdminSink().
import { log } from "./log.ts";

export type Sink = (text: string) => void | Promise<void>;
let adminSink: Sink = (text) => log("notify", "admin (no outlet yet)", { chars: text.length });

export function setAdminSink(fn: Sink) { adminSink = fn; }

/** Never throws: a failed notice must not undo the write it reports. */
export async function admin(text: string) {
  try { await adminSink(text); } catch (e) { log("notify", "admin notice failed", { err: String((e as Error)?.message ?? e).slice(0, 200) }); }
}
