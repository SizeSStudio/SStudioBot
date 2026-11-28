// The one authorization call at the dispatcher's entry (03 「api」: 先按连接角色判，再进路由; §触6.7). There is no
// per-route permission table: a paired client device is me. The rule:
//   node   → /api/v1 403 (can't approve, answer a glance, start a conversation, or read self/ and readings)
//   client → /node/v1 403
// The function itself is W2a's, in link/roles.ts (it also refuses non-canonical paths: `..`, `//`, `%`, `\`).
import type { Req } from "../../../protocol/frames.ts";
import type { Role } from "./views.ts";

export type { Role };
/** Who is calling, as the link authenticated it. `cli` is the admin socket's client device. */
export interface Caller { device_id: string; role: Role }
export type Verdict = { ok: true } | { ok: false; status: 403; error: string };
export type Authorize = (caller: Caller, req: Pick<Req, "method" | "path">) => Verdict;

export { authorize } from "../link/roles.ts";
