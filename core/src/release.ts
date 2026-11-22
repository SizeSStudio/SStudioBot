// Which commit is running, from the files deploy/core/sbot-deploy writes into a release (REVISION, HISTORY,
// ROLLBACK_FROM), and a short notice in the admin group when that changes. A dev checkout has none of them: quiet.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { feishuConf, log } from "./config.ts";
import { kvGet, kvSet } from "./db.ts";
import { sendText } from "./cards.ts";

export interface Revision { sha: string; date: string; subject: string }

const read = (dir: string, f: string) => { const p = join(dir, f); return existsSync(p) ? readFileSync(p, "utf8").trim() : ""; };
const short = (sha: string) => `\`${sha.slice(0, 7)}\``;

export function revision(coreDir: string): Revision | null {
  const [sha, date = "", ...rest] = read(coreDir, "REVISION").split("\n");
  return sha ? { sha, date, subject: rest.join(" ") } : null;
}

/** What to tell the admin group about this start, or null. Remembers what it said, so restarts stay quiet. */
export function releaseNotice(coreDir: string): string | null {
  const rev = revision(coreDir);
  if (!rev) return null;
  const last = kvGet("release.sha");
  kvSet("release.sha", rev.sha);
  // sbot-deploy leaves ROLLBACK_FROM in the release it went back to
  const failed = read(coreDir, "ROLLBACK_FROM");
  if (failed && failed !== rev.sha && kvGet("release.failed_seen") !== failed) {
    kvSet("release.failed_seen", failed);
    return `**⚠️ 更新没成功**\n${short(failed)} 没起来，已退回 ${short(rev.sha)} ${rev.subject}\n服务器上 \`sbot-deploy --status\` 和 \`journalctl -u sbot-core\` 有详情。`;
  }
  if (last === rev.sha) return null;
  const hist = read(coreDir, "HISTORY").split("\n").filter(Boolean).map((l) => ({ sha: l.slice(0, 40), subject: l.slice(41) }));
  const i = last ? hist.findIndex((h) => h.sha === last) : -1;
  const fresh = i > 0 ? hist.slice(0, i) : hist.slice(0, 1);
  const lines = fresh.slice(0, 10).map((h) => `- ${short(h.sha)} ${h.subject}`);
  if (fresh.length > 10) lines.push(`- ……还有 ${fresh.length - 10} 条`);
  const head = !last ? `**⬆️ 已部署** ${short(rev.sha)}`
    : i > 0 ? `**⬆️ 已更新** ${short(last)} → ${short(rev.sha)}`
    : `**↩️ 已切到** ${short(rev.sha)}（之前是 ${short(last)}）`;
  return `${head}\n${lines.join("\n")}`;
}

/** `extra`: more for the same message, so one start makes one notice (the seed report, §底1.5) */
export async function announceRelease(coreDir: string, extra?: string | null) {
  const md = [releaseNotice(coreDir), extra].filter(Boolean).join("\n\n");
  const { admin_chat } = feishuConf();
  if (!md || !admin_chat) return;
  try { await sendText(admin_chat, md); }
  catch (e: any) { log("release", "notice failed", { err: String(e?.message ?? e) }); }
}
