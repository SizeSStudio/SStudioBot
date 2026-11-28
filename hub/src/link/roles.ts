// The one role check (docs/tech/03 「api」, 06 「角色」). The api dispatcher calls `authorize` at its entry
// (createApi({ authorize }) in main.ts) for every transport, so no route has to remember it. Devices have my permissions (§触6.7), so there is no per-route table: only which API a role may
// use at all. `node` is not a narrower client: it is the precondition for "only I answer approvals and glances" —
// a node runs agents, and a node that could approve would be an agent approving itself (§办3.3).
import type { Authorize } from "../api/authz.ts";

export type Role = "client" | "node";

/** null = allowed; otherwise the status to answer with. `path` without the query string. */
export function roleCheck(role: Role, path: string): 403 | null {
  // only canonical paths: no ".", "..", empty segments, %-escapes or backslashes, so a router that ever normalises
  // can't turn /node/v1/../../api/v1/… into an /api/v1 route after this check said "node"
  if (/(^|\/)\.{1,2}(\/|$)|\/\/|%|\\/.test(path)) return 403;
  const api = path === "/api/v1" || path.startsWith("/api/v1/");
  const node = path === "/node/v1" || path.startsWith("/node/v1/");
  if (role === "client") return api ? null : 403;
  if (role === "node") return node ? null : 403;
  return 403;   // an unknown role gets nothing
}

/** In the dispatcher's shape. The query string (the CLI puts it in the path) isn't part of the route. */
export const authorize: Authorize = (caller, req) => {
  const denied = roleCheck(caller.role, req.path.split("?", 1)[0]!);
  return denied ? { ok: false, status: denied, error: `role ${caller.role} may not call ${req.path.split("?", 1)[0]!.split("/").slice(0, 3).join("/")}` } : { ok: true };
};
