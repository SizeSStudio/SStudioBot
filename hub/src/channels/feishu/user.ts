// User identity (03 ※, 08 P9 「范围」): polling groups as me, read receipts, mail and sending as me stay on the lark-cli
// installed on the hub's machine (not in the lockfile), as in core/. Kept behind `Lark` so tests use a fake and a later
// switch to the SDK's withUserAccessToken changes one file. lark-cli keeps its own login under its HOME; its tokens
// never pass through us.
import { execFile } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { home } from "../../home.ts";

/** runs `lark-cli <args>` and returns stdout; rejects with a message that has no stdin and at most 400 chars of stderr */
export type Lark = (args: string[], stdin?: string, timeoutMs?: number) => Promise<string>;

export function larkCli(bin = process.env.SBOT_LARK_CLI ?? "lark-cli"): Lark {
  const larkHome = process.env.SBOT_LARK_HOME ?? join(home().root, "lark");
  // a minimal env: lark-cli must not inherit anything secret from the hub's process
  const env = () => ({ PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: larkHome, LANG: "en_US.UTF-8" });
  return (args, stdin, timeoutMs = 60_000) => new Promise((ok, bad) => {
    mkdirSync(larkHome, { recursive: true });
    const p = execFile(bin, args, { env: env(), timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) bad(new Error(`lark-cli ${args.slice(0, 2).join(" ")} failed: ${String(stderr || err.message).slice(0, 400)}`));
      else ok(stdout);
    });
    if (stdin !== undefined) p.stdin!.end(stdin);
  });
}

/** needs_refresh still counts: the next user call refreshes it (core/: treating it as not ready meant nothing ever refreshed) */
export async function userIdentityReady(lark: Lark): Promise<boolean> {
  try {
    const u = JSON.parse(await lark(["auth", "status"])).identities?.user;
    if (u?.status === "ready") return true;
    return u?.status === "needs_refresh" && (!u.refreshExpiresAt || Date.parse(u.refreshExpiresAt) > Date.now());
  } catch { return false; }
}

/** send markdown as me; only called for an outbox row that carries an approval (approval cards, 底线) */
export async function sendAsUser(lark: Lark, t: { chat_id?: string; msg_id?: string; in_thread?: boolean }, text: string, idem: string): Promise<string | null> {
  const args = t.msg_id
    ? ["im", "+messages-reply", "--message-id", t.msg_id, "--as", "user", "--markdown", "-", "--idempotency-key", idem, "--json", ...(t.in_thread ? ["--reply-in-thread"] : [])]
    : ["im", "+messages-send", "--chat-id", String(t.chat_id), "--as", "user", "--markdown", "-", "--idempotency-key", idem, "--json"];
  const out = await lark(args, text);
  try { const j = JSON.parse(out); return j.message_id ?? j.data?.message_id ?? j.data?.id ?? null; } catch { return null; }
}
