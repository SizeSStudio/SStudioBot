// Two guards, each in exactly one place (03 tools). selfGuard: who may read self/ whole (R1, §读5.1). commandGuard:
// where bash and file tools may not go (soft boundary, §底3.8) — it looks at where, never at what is written.
import { homedir } from "node:os";
import { posix } from "node:path";
import type { Col } from "../turn.ts";

/** Paths are judged relative to agent-home; absolute paths into agent-home are folded to that form first. */
export function relToAgentHome(path: string, agentHome?: string): string {
  let p = path.replace(/\\/g, "/").trim();
  if (agentHome) {
    const ah = agentHome.replace(/\\/g, "/").replace(/\/$/, "");
    if (p === ah) return ".";
    if (p.startsWith(ah + "/")) p = p.slice(ah.length + 1);
  }
  return posix.normalize(p).replace(/^\.\//, "");
}

// §读5.1: what only I may read whole. self/ (habits, rhythms, charts, practice, timeline, notes…), body records,
// the timeline, birth data (it lives in config/self.yaml, which commandGuard keeps out of reach anyway).
const PRIVATE: RegExp[] = [/^self(\/|$)/, /^body(\/|$)/, /(^|\/)timeline(\.md)?(\/|$)/, /(^|\/)self\.ya?ml$/, /(^|\/)birth[^/]*$/];

/**
 * undefined = allowed; otherwise the reason, which is returned to the model as-is.
 * typed: everything whole. system (timers, approvals, tasks, system events): no whole files under self/, body, timeline
 * or birth data — item level only, through self_list. others: none of it at all. `shared`: a turn I typed in a shared
 * place (turn.ts privacyCol passes "system" for it), so the reason says where, not who.
 */
export function selfGuard(path: string, col: Col, agentHome?: string, shared = false): string | undefined {
  if (col === "typed") return undefined;
  const rel = relToAgentHome(path, agentHome);
  if (!PRIVATE.some((re) => re.test(rel))) return undefined;
  if (shared) return `这里是工作台或管理群，不是私聊也不是客户端：${rel} 在这里读不了整份；用 self_list 看具体条目，最多提一两句。`;
  return col === "system"
    ? `这个文件（${rel}）只在我亲手发消息的那一轮整份读。定时任务、审批、任务和系统事件触发的这一轮读不了整份；用 self_list 看具体条目，只引用相关的一两条。`
    : `这里不是我的对话，self/、身体记录和时间线都读不到（${rel}）。`;
}

export interface GuardEnv { sbotHome: string; extraDenied?: string[] }

/**
 * Refuse a command or path that reaches the hub's own state: $SBOT_HOME's db/, config/, keys/, secrets.env and
 * agent-home/ files, any process's environ, /run/sbot, and channel CLIs' credential dirs (same idea as the old
 * coreGuard). Matching is on text, so `cat $SBOT_HOME/secrets.env` and the expanded path are both caught.
 */
export function commandGuard(text: string, env: GuardEnv): string | undefined {
  const t = text.replace(/\\/g, "/");
  const home = env.sbotHome.replace(/\\/g, "/").replace(/\/$/, "");
  const userHome = homedir().replace(/\\/g, "/");
  const deny: [RegExp | string, string][] = [
    [/\$\{?SBOT_HOME\}?/, "$SBOT_HOME"],
    [/\$\{?SBOT_SECRETS\}?/, "$SBOT_SECRETS"],
    [/secrets\.env\b/, "secrets.env"],
    [/\/proc\/[^/\s]+\/environ\b/, "/proc/*/environ"],
    [/\/run\/sbot(\/|\b)/, "/run/sbot"],
    [/\.lark-cli\b|\.config\/lark|\.feishu\b/, "渠道 CLI 的凭证目录"],
  ];
  for (const sub of ["db", "config", "keys", "agent-home", "run", "blobs", "backup-staging"]) deny.push([`${home}/${sub}`, `$SBOT_HOME/${sub}`]);
  if (home) deny.push([new RegExp(`${home.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/?(\\s|$|["'])`), "$SBOT_HOME"]);
  for (const d of env.extraDenied ?? []) deny.push([d.replace("~", userHome), d]);
  for (const [pat, name] of deny) {
    const hit = typeof pat === "string" ? t.includes(pat) : pat.test(t);
    if (hit) return `拒绝：这条命令或路径碰到了 ${name}（主自己的数据、密钥和凭证不给工具碰，§底3.8）。换个不碰它的做法。`;
  }
  return undefined;
}
