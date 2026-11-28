// `kind: command`: a plugin I installed, as a child process (03 「sources」). Contract:
//   stdin   one JSON line { v: 1, since, cursor, env }        (env = only the secrets its entry lists under `env:`)
//   stdout  one JSON per line { kind: "item", id, ts, where, author?, text, link?, raw_b64? }, last { kind: "done", cursor }
//   stderr  into the log, secrets masked; exit ≠ 0 = this poll failed, the cursor doesn't move. No time or size limit.
// Secrets travel on stdin, not in the environment, so they don't show in /proc/<pid>/environ or a child's env.
//
// Who runs it is injected (PluginRunner). On Linux 03 says the worker account through worker-exec's plugin mode, which
// deploy/ doesn't have yet ※: until it does, no runner is wired there and command sources report that, rather than
// running as the hub's own user. On a Mac or Windows hub, 03 has them run as the same user (localPluginRunner).
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { modelsConf } from "../config/load.ts";
import { secret } from "../config/secrets.ts";
import { home, TZ } from "../home.ts";
import { log } from "../log.ts";
import type { Poll, SourceItem } from "./types.ts";

export type PluginRunner = (o: { exe: string; cwd: string; stdin: string }) => Promise<{ code: number; stdout: string; stderr: string }>;

export const pluginsDir = () => process.env.SBOT_PLUGINS ?? join(home().root, "plugins");

/** same user, minimal env: nothing of the hub's own environment (which may hold tokens) is passed on */
export const localPluginRunner: PluginRunner = ({ exe, cwd, stdin }) => new Promise((ok, bad) => {
  const ch = spawn(exe, [], { cwd, env: { PATH: process.env.PATH ?? "/usr/bin:/bin", LANG: "C.UTF-8", TZ, HOME: cwd }, stdio: ["pipe", "pipe", "pipe"] });
  const o: Buffer[] = [], e: Buffer[] = [];
  ch.stdout.on("data", (d: Buffer) => o.push(d));
  ch.stderr.on("data", (d: Buffer) => e.push(d));
  ch.on("error", bad);
  ch.on("close", (code, sig) => ok({ code: code ?? (sig ? 128 : -1), stdout: Buffer.concat(o).toString("utf8"), stderr: Buffer.concat(e).toString("utf8") }));
  ch.stdin.on("error", () => { /* a plugin that doesn't read stdin */ });
  ch.stdin.end(stdin);
});

/** the hub's own credentials stay with the hub and the proxy, whatever sources.yaml says */
function ownSecrets(): Set<string> {
  const own = new Set(["FEISHU_APP_ID", "FEISHU_APP_SECRET"]);
  try { for (const e of Object.values(modelsConf().endpoints ?? {})) if (e?.key_ref) own.add(String(e.key_ref)); } catch { /* no models.yaml */ }
  return own;
}

export function commandPoll(runner: () => PluginRunner | undefined): Poll {
  return async (s, st, since, cursor) => {
    const name = String(s.run ?? "");
    if (!/^[a-z0-9][a-z0-9_-]*$/.test(name)) throw new Error(`插件名不对：${name}`);
    const exe = join(pluginsDir(), "sources", name, "run");
    if (!existsSync(exe)) throw new Error(`插件不在：sources/${name}/run`);
    const r = runner();
    if (!r) throw new Error("这台主上还没接插件运行器（Linux 要 worker-exec 的插件模式），插件没跑");
    const own = ownSecrets();
    const refused = (s.env ?? []).filter((n) => own.has(n));
    if (refused.length) throw new Error(`这些是主自己的密钥，不给插件：${refused.join("、")}`);
    const env: Record<string, string> = {}, missing: string[] = [], values: string[] = [];
    for (const n of s.env ?? []) { const v = secret(n); if (v) { env[n] = v; values.push(v); } else missing.push(n); }
    if (missing.length) throw new Error(`secrets.env 里没有：${missing.join("、")}`);
    const mask = (t: string) => values.reduce((acc, v) => v.length >= 4 ? acc.split(v).join("***") : acc, t);
    const res = await r({ exe, cwd: st.dir, stdin: JSON.stringify({ v: 1, since: new Date(since).toISOString(), cursor: cursor ?? null, env }) + "\n" });
    if (res.stderr.trim()) log("sources", "plugin stderr", { id: s.id, text: mask(res.stderr.trim()).slice(-2000) });
    if (res.code !== 0) throw new Error(`插件退出 ${res.code}：${mask(res.stderr.trim()).slice(-300)}`);
    const items: SourceItem[] = [];
    let next: string | undefined;
    for (const line of res.stdout.split("\n")) {
      if (!line.trim()) continue;
      let j: any;
      try { j = JSON.parse(line); } catch { continue; }   // not a contract line
      if (j?.kind === "item") { const { kind: _k, ...it } = j; items.push(it as SourceItem); }
      else if (j?.kind === "done") next = j.cursor == null ? undefined : String(j.cursor);
    }
    // no `done` line: the items still count, the cursor stays where it was (the plugin sees the same `cursor` again)
    return { items, cursor: next };
  };
}
