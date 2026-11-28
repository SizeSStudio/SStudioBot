// The one authorization call at the dispatcher's entry (03 「api」: 先按连接角色判，再进路由; §触6.7). There is no
// per-route permission table: a paired client device is me. The rule:
//   node   → /api/v1 403 (can't approve, answer a glance, start a conversation, or read self/ and readings)
//   client → /node/v1 403
// W2a writes the real function in the link (branch w2a-link). This stand-in has the same rule behind the same
// signature, so switching is one line in api/index.ts (`authorize` there). ※
import type { Req } from "../../../protocol/frames.ts";
import type { Role } from "./views.ts";

export type { Role };
/** Who is calling, as the link authenticated it. `cli` is the admin socket's client device. */
export interface Caller { device_id: string; role: Role }
export type Verdict = { ok: true } | { ok: false; status: 403; error: string };
export type Authorize = (caller: Caller, req: Pick<Req, "method" | "path">) => Verdict;

const API = /^\/api\/v1(\/|$)/, NODE = /^\/node\/v1(\/|$)/;

export const authorizeStandIn: Authorize = (caller, req) => {
  if (caller.role === "client" && API.test(req.path)) return { ok: true };
  if (caller.role === "node" && NODE.test(req.path)) return { ok: true };
  return { ok: false, status: 403, error: `role ${caller.role} may not call ${req.path.split("/").slice(0, 3).join("/")}` };
};
